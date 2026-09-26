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
scripts/   seller CLI (stand-in for the dashboard) + example endpoints
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

Tools: `list_paid_apis`, `paid_fetch(endpoint_id, query?, body?)`, `wallet_status`. The server refuses a payment if the quote differs from the catalog (price or payout address), exceeds `MAX_PER_CALL_USD`, or would go over `SESSION_BUDGET_USD`.

To exercise the same tools without Claude: `BUYER_PRIVATE_KEY=0x... bun mcp/src/smoke.ts`.

### Hosted MCP (Cloudflare Worker)

`mcp/src/worker.ts` serves the same tools over Streamable HTTP at `/mcp`, behind OAuth. Each user pays from their own [Privy](https://privy.io) embedded wallet:

1. The MCP client (claude.ai connector, Claude Code) starts OAuth; `/authorize` sends the user to the `/connect/` page.
2. They sign in with Privy (email or Google), which creates their wallet, and click **Allow payments**. That adds our key quorum as a signer on their wallet, limited by a Privy policy to USDC `transferWithAuthorization` on Base Sepolia up to $0.10.
3. The Worker checks the signer is on their wallet and issues the OAuth grant, carrying their wallet id.
4. `paid_fetch` signs the x402 payment through Privy with our authorization key. Privy holds the wallet key; the server never does. The user can revoke the signer at any time.

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

## Deploy

```bash
cd worker
bunx wrangler d1 create x402-gateway           # put the id into wrangler.jsonc
bunx wrangler secret put MASTER_KEY             # openssl rand -base64 32 — encrypts seller API keys
bunx wrangler secret put SESSION_SECRET         # openssl rand -hex 32
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
| `GET /catalog` | public list of active endpoints |
| `ANY /x/:id` | the paid proxy |

Endpoint fields: `name`, `description` (Claude reads this), `method`, `url` (https, public host), `auth` (`{type:"none"}` or `{type:"header"|"query", name, value}`), `static_headers`, `price_usd` (≤ 6 decimals), `example_query`, `example_body`, `body_overrides` (JSON merged over every buyer body — e.g. cap `max_tokens`), `max_body_bytes`. Changing `url`, `method`, `auth`, `static_headers` or `body_overrides` sends the endpoint back to `pending` until it's re-tested.

## How a paid request works

1. Load the endpoint (404 unless active), check method and body size, apply `body_overrides` — all before quoting, so bad requests are never charged.
2. Rate limit per endpoint + client IP.
3. x402 middleware: no payment → 402 quote (seller's address, endpoint price); payment → verified with the facilitator.
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
