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
mcp/       MCP server Claude uses to discover and pay for endpoints (local stdio, or hosted on Workers)
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

`mcp/src/worker.ts` serves the same tools over Streamable HTTP at `/mcp`. It is custodial: the buyer key is a Worker secret, everyone with `MCP_TOKEN` spends from that one wallet, and spending is capped by `MAX_PER_CALL_USD` and a rolling 24h `DAILY_BUDGET_USD` (summed from the gateway's `calls` table). It reaches the gateway through a service binding.

```bash
cd mcp
cp .dev.vars.example .dev.vars          # BUYER_PRIVATE_KEY, MCP_TOKEN (openssl rand -hex 32)
bunx wrangler deploy                    # set GATEWAY_URL in wrangler.jsonc first
bunx wrangler secret bulk .dev.vars

claude mcp add --transport http x402-gateway https://x402-gateway-mcp.<you>.workers.dev/mcp \
  --header "Authorization: Bearer $MCP_TOKEN"
```

For a claude.ai custom connector, which can't send headers, use `https://…/mcp?key=<MCP_TOKEN>` as the URL. Test without Claude: `MCP_URL=… MCP_TOKEN=… bun mcp/src/smoke-http.ts`.

## Deploy

```bash
cd worker
bunx wrangler d1 create x402-gateway           # put the id into wrangler.jsonc
bunx wrangler secret put MASTER_KEY             # openssl rand -base64 32 — encrypts seller API keys
bunx wrangler secret put SESSION_SECRET         # openssl rand -hex 32
bun run migrate:remote
bun run deploy
```

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
