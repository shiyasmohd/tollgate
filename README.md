# x402-gateway

Sell access to any API you already pay for — pay-per-request over [x402](https://x402.org), settled in USDC on Base Sepolia.

A seller registers an endpoint (URL + their API key + a price). The gateway gives it a paid URL, `/x/:id`. A buyer — typically Claude, through the bundled MCP server — pays per call in USDC and gets the upstream response. The seller's key never leaves the gateway, and the buyer is only charged when the upstream succeeds.

```
Claude ─stdio─▶ mcp/ (buyer wallet) ──x402──▶ worker/ /x/:id ──▶ seller's upstream API
                                                   │  verify + settle
                                                   ▼
                                     x402.org facilitator ──▶ Base Sepolia (USDC → seller)
```

## Layout

```
worker/    Hono on Cloudflare Workers + D1: seller API, paid proxy, catalog
mcp/       MCP server Claude uses to discover and pay for endpoints (local stdio, or hosted on Workers with Privy wallets)
scripts/   seller CLI (stand-in for the dashboard), example endpoints, MultiBaas setup
frontend.md  plan for the seller dashboard
```

## Run locally

```bash
bun install
cp worker/.dev.vars.example worker/.dev.vars   # fill: openssl rand -base64 32 / openssl rand -hex 32
bun run --filter worker migrate:local
bun run dev                                     # http://localhost:8787
```

Add an endpoint as a seller (any throwaway key works — it only signs the sign-in message; payouts go to its address):

```bash
export SELLER_PRIVATE_KEY=0x...
bun seller create scripts/examples/httpbin-echo.json   # prints the endpoint id
bun seller test ep_...                                 # calls the upstream once; 2xx activates it
curl -i -X POST localhost:8787/x/ep_... -d '{}'         # 402 with the price in PAYMENT-REQUIRED
```

Other seller commands: `list`, `update <id> <patch.json>` (e.g. `{"status":"paused"}`), `delete <id>`, `stats [24h|30d]`, `feed`.

## Pay from Claude

The buyer wallet needs Base Sepolia USDC only (the facilitator pays gas): <https://faucet.circle.com>.

```bash
claude mcp add x402-gateway \
  -e GATEWAY_URL=http://localhost:8787 \
  -e BUYER_PRIVATE_KEY=0x... \
  -e MAX_PER_CALL_USD=0.10 \
  -e SESSION_BUDGET_USD=1.00 \
  -- bun "$PWD/mcp/src/index.ts"
```

Tools: `list_paid_apis`, `paid_fetch(endpoint_id, query?, body?)`, `pay_x402_url(url, method?, body?)`, `screen_counterparty(address)`, `wallet_status`. The server refuses a payment if the quote differs from the catalog (price or payout address), exceeds `MAX_PER_CALL_USD`, would go over `SESSION_BUDGET_USD`, or fails [Intercepta screening](#payment-screening-intercepta).

To exercise the same tools without Claude: `BUYER_PRIVATE_KEY=0x... bun mcp/src/smoke.ts`.

### Hosted MCP (Cloudflare Worker)

`mcp/src/worker.ts` serves the same tools over Streamable HTTP at `/mcp`, behind OAuth. Each user pays from their own [Privy](https://privy.io) embedded wallet:

1. The MCP client (claude.ai connector, Claude Code) starts OAuth; `/authorize` sends the user to the `/connect/` page.
2. They sign in with Privy (email or Google), which creates their wallet, and click **Allow payments**. That adds our key quorum as a signer on their wallet, limited by a Privy policy to USDC `transferWithAuthorization` on Base Sepolia up to $0.10.
3. The Worker checks the signer is on their wallet and issues the OAuth grant, carrying their wallet id.
4. `paid_fetch` signs the x402 payment through Privy with our authorization key. Privy holds the wallet key; the server never does. The user can revoke the signer at any time.

Non-text responses (audio, images, PDFs…) are stored in the R2 bucket `x402-gateway-files` under `responses/` and returned to Claude as a `/files/<id>` download link, valid for 24h; a bucket lifecycle rule deletes them after a day. Files always download; only media types that can't run script keep their content type. (The local stdio server writes them to a private temp directory instead.)

Spending is also capped by `MAX_PER_CALL_USD` and a rolling 24h `DAILY_BUDGET_USD` per wallet (summed from the gateway's `calls` table). The Worker reaches the gateway through a service binding.

Setup: create a Privy app (login: email + Google; embedded wallets: EVM; allowed origins: your `*.workers.dev` URL and `http://localhost:8787`).

```bash
cd mcp
cp .dev.vars.example .dev.vars          # fill PRIVY_APP_ID, PRIVY_APP_SECRET
bun run privy:setup                     # creates the signer key, key quorum and policy
bunx wrangler kv namespace create OAUTH_KV   # put the id into wrangler.jsonc, set PUBLIC_URL / GATEWAY_URL
bun run deploy                          # builds the connect page, deploys the Worker
bunx wrangler secret bulk .dev.vars

claude mcp add --transport http x402-gateway https://x402-gateway-mcp.<you>.workers.dev/mcp
```

In claude.ai, add a custom connector with the same URL and no OAuth client id. Locally: `bun run dev` serves it at `http://localhost:8787`.

## Payment screening (Intercepta)

Every payment is screened with the [Intercepta](https://intercepta.io) (Web3 Antivirus) API before money moves, on both sides:

| Who | When | What is checked | Code |
|---|---|---|---|
| Paying agent (MCP) | quote chosen, before signing | recipient `payTo` (address quick-scan), token (token risks; anything but canonical USDC is blocked as a lookalike) | `mcp/src/server.ts` `payingFetch` → `onBeforePaymentCreation` |
| Paying agent (MCP) | right before the wallet signs | the exact EIP-712 `TransferWithAuthorization`: local match against the quote (recipient, amount, USDC contract, expiry) + Intercepta signature analysis | `mcp/src/server.ts` `payingFetch` → wrapped `signTypedData` |
| Buyer in the browser | before and while paying on `/pay/:id` | same checks, shown as chips | dashboard `src/lib/pay.ts`, `src/views/Pay.tsx` |
| Seller (gateway) | before the facilitator verifies | the payer (address quick-scan); blocked payers get a 402 with the reason, nothing settles | `worker/src/paywall.ts` `screenPayer` (per endpoint: `screen_payers`) |
| Seller | on the dashboard | own payout address (quick-scan + address-poisoning history) | `GET /api/screen/payout` |
| Agent choosing a seller | `list_paid_apis` | each seller's `pay_to_risk` | `worker/src/routes/catalog.ts` |

All Intercepta calls live in [`worker/src/screen.ts`](worker/src/screen.ts):

- `GET /api/public/v2/extension/account/{address}/quick-scan`: blocks on `known_scammer`, `sanction_address`, `blacklist`, scam/phishing/rug-pull traits, or `toxicScore ≥ INTERCEPTA_BLOCK_SCORE` (70)
- `GET /api/public/v2/extension/token-intelligence/token/{address}/risks?chainId=8453`: blocks on `action: block`
- `POST /api/public/v2/extension/analysis/signature`: blocks on `riskGroup: High` or drainer/scam detectors
- `GET /api/public/v1/extension/poisoning-attack/user/{address}`: payout address check

The key stays in the gateway (`INTERCEPTA_API_KEY` secret); the MCP server and the pay page call the gateway's `POST /screen {pay_to?, asset?, payer?, amount?, authorization?}` and only see verdicts. Payments settle on Base Sepolia, which Intercepta doesn't cover, so addresses are screened as they are (same keys on mainnet) and testnet USDC is screened as Base mainnet USDC. Verdicts are cached for 10 minutes. Without a key every check is `skipped` and nothing is blocked; with a key, an Intercepta outage blocks (`INTERCEPTA_FAIL_MODE=closed`, default) or only warns (`open`).

**Demo: one approved, one blocked.** In Claude (with the MCP connected):

1. "List the paid APIs and call one": `paid_fetch` screens the seller, USDC and the authorization, pays, and shows the checks and the BaseScan link.
2. "Pay `https://<gateway>/demo/rogue`": `pay_x402_url` gets a 402 from a payee at an OFAC-listed address (the Ronin exploiter; override with `DEMO_ROGUE_PAY_TO`). Intercepta flags it and the payment is blocked before signing. `?token=lookalike` quotes a token one hex digit off USDC instead. The demo payee never settles, so an unscreened client loses nothing either.
3. The seller's **Payments → Blocked** tab lists payers the gateway refused.

**Integration feedback** (draft, edit before submitting):

- Time to first screened payment: _fill in_. The `llms.txt` index made finding the right endpoints quick.
- Base Sepolia (84532) isn't a supported chain, so testnet x402 payments need mapping to mainnet addresses; a testnet mode would help.
- The docs don't give the `toxicScore` scale or example responses, so the block threshold is a guess.
- The signature scanner's `messageType` enum lists only permit types; explicit support for EIP-3009 `TransferWithAuthorization` (what x402 signs) would make it a natural fit.
- An x402-specific endpoint (screen a whole `PAYMENT-REQUIRED` quote in one call) would replace three calls.

## ENS names (ENSv2, Sepolia)

Every endpoint gets an [ENSv2](https://docs.ens.domains/ensv2/overview/) name when it first activates, e.g. `weather.tollgate-x402.eth`:

- The gateway runs its own subname registry for the parent name. It registers the endpoint's label there, with the **seller as owner**. The seller holds the name's roles to change its resolver or registry and to transfer it.
- The gateway's Permissioned Resolver holds the records:
  - `addr` for mainnet and Base Sepolia (coin type `toCoinType(84532)`) is the seller's payout address.
  - Text records: `url` (the paid URL), `description`, `x402.endpoint`, `x402.price` (kept in sync on price changes) and `x402.network`.
- **Seller names.** A seller can claim a handle, `hashir.tollgate-x402.eth`. The gateway deploys a UserRegistry for that seller (the seller and the gateway both get every role), registers the handle in its own registry with that as the subregistry, sets the seller's payout address on it and links the new registry to its parent. After that, the seller's endpoints are named inside their registry: `elevenlabs.hashir.tollgate-x402.eth`. Sellers without a handle keep flat names.
  - `GET /api/me` returns `{ address, name, ens }`: `name` is the seller's `{ handle, ens_name, registry, status }` or null, and `ens` is `{ parent }` or null when ENS is off.
  - `GET /api/me/name/check?handle=hashir` returns `{ handle, name, available, reason? }`.
  - `POST /api/me/name { "handle": "hashir" }` claims it. It returns 201 `{ name }`, 409 `handle_taken` / `already_named` / `in_progress`, 400 for a bad handle (3–32 of a-z, 0-9, inner hyphens; some words are reserved), 502 `ens_failed` or 503 `ens_disabled`.
  - Endpoints take an optional `ens_label` (e.g. `"elevenlabs"`), used the first time the endpoint activates. Without one, the label comes from the endpoint name. A taken label gets `-<6 chars of the id>`.
- `/catalog` lists `ens_name` and `seller_ens_name`. In the MCP, `paid_fetch` accepts it in place of the endpoint id. Before paying, it resolves the name on Sepolia and refuses when the name's address differs from the catalog's `pay_to`. It then requires the 402 quote's `payTo` to match the ENS record.

Setup (once): the key needs a little Sepolia ETH. The registration fee is paid in MockUSDC, which the script mints.

```bash
ENS_PRIVATE_KEY=0x... ENS_LABEL=tollgate-x402 bun scripts/ens-setup.ts   # deploys registry + resolver, registers the .eth name
# put the printed ENS_PARENT / ENS_REGISTRY / ENS_RESOLVER into worker/wrangler.jsonc, then:
cd worker && bunx wrangler secret put ENS_PRIVATE_KEY && bun run migrate:remote && bun run deploy
```

With those unset, names are off. Name transactions are sent in the background, so a name resolves a block or two after activation.

## Onchain verification (Curvegrid MultiBaas)

**Tollgate proves every x402 payment onchain: MultiBaas indexes USDC on Base Sepolia, and the seller dashboard reconciles what the gateway recorded against what actually reached the seller's wallet, then tells them what to do about the difference.**

The gateway records a call as settled when the x402 facilitator says so, and until now that report was the only source for the seller's income. An x402 settlement is a USDC `transferWithAuthorization`, so it emits `Transfer(payer → seller, amount)`. MultiBaas gives us an independent record of those transfers:

```
buyer ─x402─▶ /x/:id ──▶ facilitator settles ──▶ USDC Transfer (Base Sepolia)
                │ calls.tx_hash                              │ indexed by MultiBaas
                ▼                                            ▼
               D1 ◀── POST /hooks/multibaas (HMAC) ◀── event.emitted webhook
                │                                            ▲
  dashboard ◀── /api/reconcile, /api/actions ── ad hoc event query (backfill)
```

How MultiBaas is used ([`worker/src/multibaas.ts`](worker/src/multibaas.ts), [`scripts/multibaas-setup.ts`](scripts/multibaas-setup.ts)):

- **Contract library + address linking**: the setup script adds the USDC `Transfer` ABI, aliases the Base Sepolia USDC address as `usdc`, and links it with event sync from the latest block (`POST /contracts/usdc`, `POST /chains/ethereum/addresses`, `POST /chains/ethereum/addresses/usdc/contracts`).
- **Webhooks**: an `event.emitted` webhook pushes each USDC Transfer to `POST /hooks/multibaas`. The gateway checks `X-MultiBaas-Signature` (HMAC-SHA256 over body + timestamp, 5-minute window) and keeps only transfers into a seller's payout address, so a payment flips to "verified" within seconds.
- **Event queries**: `GET /api/reconcile` runs an ad hoc query (`POST /queries`: `Transfer` events on alias `usdc` where input 1, the recipient, is the seller) to backfill anything a webhook missed.

What the seller gets (details in [API_DOCS.md](API_DOCS.md#onchain-verification-multibaas)):

- every settled payment marked `verified`, `confirming`, `unverified` (the facilitator reported it, the chain doesn't show it) or `mismatch` (different amount)
- recorded vs onchain income and a verified %, plus USDC that arrived **outside** Tollgate (not API income)
- an action list: payments not found onchain, endpoints losing sales to upstream failures, endpoints not live yet, repeat blocked payers (Intercepta), external inflows, income concentrated in one buyer

**Set up**

1. Create a MultiBaas deployment on **Base Sepolia** at [console.curvegrid.com](https://console.curvegrid.com) and an admin API key (Admin → API Keys).
2. `MULTIBAAS_URL=https://<id>.multibaas.com MULTIBAAS_ADMIN_KEY=… GATEWAY_URL=https://<gateway> bun multibaas:setup`
3. Put the printed `MULTIBAAS_URL` and `MULTIBAAS_SYNC_FROM` into `worker/wrangler.jsonc`, set the `MULTIBAAS_API_KEY` and `MULTIBAAS_WEBHOOK_SECRET` secrets, then `bun run migrate:remote && bun run deploy`.

Without `MULTIBAAS_URL` verification is off and the gateway behaves as before. Tests: `test/onchain.test.ts` covers the webhook signature and parsing, the event query, reconciliation, the action rules, and the routes against a stubbed MultiBaas.

**Demo**: pay for a call on the dashboard's `/pay/:id` page, and the payment shows "Confirming" then "Onchain · block N". Send 0.01 USDC straight to the seller's wallet, and an "External inflow" action appears. The Overview's reconciliation card shows recorded vs onchain income.

**Team**: _fill in: names and social handles_.

**MultiBaas feedback** (draft, edit before submitting):

- Linking an existing contract with `startingBlock: "latest"` meant we didn't have to index all of USDC's history, which made a busy token practical to use.
- Ad hoc event queries (no saved query needed) were the right fit for per-seller filters.
- The docs don't say that result rows come back with lowercased alias keys; we learned it from Curvegrid's sample app.
- A webhook filter (e.g. only events where input 1 is in a set of addresses) would save receivers from discarding almost every USDC Transfer.
- The supported-networks page loads its table with JavaScript, so it's hard to confirm Base Sepolia support from docs search; the sample app's chain list answered it.

## Deploy

```bash
cd worker
bunx wrangler d1 create x402-gateway           # put the id into wrangler.jsonc
bunx wrangler secret put MASTER_KEY             # openssl rand -base64 32 — encrypts seller API keys
bunx wrangler secret put SESSION_SECRET         # openssl rand -hex 32
bunx wrangler secret put INTERCEPTA_API_KEY     # optional: payment screening, free at intercepta.io/ethglobal
bunx wrangler secret put MULTIBAAS_API_KEY      # optional: onchain verification (see above)
bunx wrangler secret put MULTIBAAS_WEBHOOK_SECRET
bun run migrate:remote
bun run deploy
```

Set `DASHBOARD_URL` in `worker/wrangler.jsonc` to the dashboard's origin so that browsers opening a paid URL are redirected to its `/pay/:id` page; left empty, they get a plain 402 page with the price.

Then point `GATEWAY_URL` (MCP) and the seller CLI at the `*.workers.dev` URL. Rotating `MASTER_KEY` makes stored seller keys unreadable.

## Seller API

All `/api/*` routes except auth take `Authorization: Bearer <token>`.

| Route | |
|---|---|
| `GET /api/auth/nonce`, `POST /api/auth/verify {message, signature}` | Sign-In with Ethereum → `{ token }` (24h) |
| `GET /api/me` | signed-in address |
| `GET/POST /api/endpoints`, `GET/PATCH/DELETE /api/endpoints/:id` | manage endpoints; the secret is write-only |
| `POST /api/endpoints/:id/test` | one unpaid upstream call with the example request; 2xx activates |
| `GET /api/stats?range=24h\|30d&endpoint_id=` | income, paid/failed calls, unique payers, time series |
| `GET /api/feed?since=&before=&endpoint_id=&status=settled\|failed&limit=` | recent calls with BaseScan links |
| `GET /api/screenings?verdict=allow\|warn\|block&before=&limit=` | payer screenings at the paywall, plus 30-day blocked totals |
| `GET /api/screen/payout` | screens the signed-in seller's payout address |
| `GET /catalog` | public list of active endpoints, with each seller's `pay_to_risk` |
| `POST /screen` | public: screen a payment with Intercepta (see above) |
| `ANY /x/:id` | the paid proxy |
| `ANY /demo/rogue` | a payee screening should block (demo) |

Endpoint fields: `name`, `description` (Claude reads this), `method`, `url` (https, public host), `auth` (`{type:"none"}` or `{type:"header"|"query", name, value}`), `static_headers`, `price_usd` (≤ 6 decimals), `example_query`, `example_body`, `body_overrides` (JSON merged over every buyer body — e.g. cap `max_tokens`), `max_body_bytes`, `screen_payers` (default `true`: screen each payer with Intercepta). Changing `url`, `method`, `auth`, `static_headers` or `body_overrides` sends the endpoint back to `pending` until it's re-tested.

## How a paid request works

1. Load the endpoint (404 unless active), check method and body size, apply `body_overrides` — all before quoting, so bad requests are never charged.
2. Rate limit per endpoint + client IP.
3. x402 middleware: no payment → 402 quote (seller's address, endpoint price); payment → the payer is screened with Intercepta (if `screen_payers`), then verified with the facilitator.
4. Proxy to the upstream with the seller's secret injected; the secret is scrubbed from text responses.
5. Upstream ≥ 400 → settlement is skipped (buyer not charged). Otherwise settle and return the response with `PAYMENT-RESPONSE`.
6. The call (payer, amount, tx hash, upstream status, latency) is written to D1 for stats and the feed.

## Tests

```bash
bun run test       # vitest in the Workers runtime with a local D1
bun run typecheck
```

## Limits

Responses are buffered (no streaming/SSE). Prices are flat per request; for token-based pricing, the facilitator also supports x402's `upto` scheme on Base Sepolia. Testnet only.
