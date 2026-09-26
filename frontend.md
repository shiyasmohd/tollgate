# Frontend dashboard plan

Seller-facing dashboard for the x402 credits gateway (Hono + D1 Worker, Base Sepolia). The backend plan is at `~/.claude/plans/backend-is-on-hono-purrfect-pebble.md`. This dashboard only uses that API plus reads from Base Sepolia.

## Goal

A seller connects a wallet, signs in, adds an endpoint (URL + key + price), tests it, activates it, and then watches paid calls arrive live, each with a BaseScan link, while their USDC balance goes up. Buyers (Claude via MCP) never use this UI. The only buyer-facing thing is the "Use with Claude" page.

## Stack

| Concern | Choice | Why |
|---|---|---|
| Build | Vite + React + TypeScript | Fast, static output the Worker can serve |
| Wallet | wagmi v2 + viem, `injected` + `coinbaseWallet` connectors | No WalletConnect project id needed; Base-native wallet included |
| Chain | `baseSepolia` only | Matches settlement chain; prompt to switch if on another chain |
| Data | TanStack Query (already required by wagmi) | Caching + `refetchInterval` polling for the live feed |
| Routing | react-router | Handful of pages, nothing fancier needed |
| Styling | Tailwind CSS v4 | Quick, consistent, easy dark mode |
| Charts | Recharts | One income/calls chart |

## Hosting

- It lives in the workspace at `web/` and builds to `web/dist`.
- The same Worker serves it via Workers Static Assets, so it's same-origin: no CORS and one deploy.
- `worker/wrangler.jsonc`:
  ```jsonc
  "assets": {
    "directory": "../web/dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/x/*", "/catalog"]
  }
  ```
- Dev: `vite` on :5173 with a `server.proxy` that sends `/api`, `/x` and `/catalog` to `wrangler dev` on :8787.

## Auth flow (SIWE)

1. The seller connects a wallet with wagmi and switches to Base Sepolia if needed.
2. The dashboard gets a nonce from `GET /api/auth/nonce`.
3. It builds the message with viem's `createSiweMessage` (domain = `location.host`, chainId 84532, statement "Sign in to <app>").
4. The seller signs it with `signMessage`.
5. The dashboard sends it to `POST /api/auth/verify`, which returns `{ token }`.
6. The token goes in `localStorage` keyed by address. Every `/api/*` call sends `Authorization: Bearer`.
7. If any call returns 401, or the wallet's account or chain changes, the token is cleared and the user is sent back to sign in.
8. Disconnect clears the token.

## Pages

1. **Connect** (`/`, when signed out)
   - One sentence on what this is, a "Connect wallet" button, then "Sign in".
   - Shows the wrong-network state with a switch button.
2. **Overview** (`/dashboard`)
   - KPI tiles:
     - income (USDC)
     - paid calls
     - failed upstream calls (buyers not charged)
     - unique payers
     - **wallet USDC balance** (wagmi `useReadContract` `balanceOf` on `0x036CbD53842c5426634e7929541eC2318f3dCF7e`; refetches every 10s)
   - An income and calls chart (last 24h hourly / 30d daily toggle).
   - The **live feed**: the last 20 calls, each showing time, endpoint, payer (short), amount, status and BaseScan link. It polls `GET /api/feed?since=<latest ts>` every 2s and adds new rows at the top with a brief highlight.
3. **Endpoints** (`/endpoints`)
   - A table with name, method, price, status badge (pending / active / paused), calls, income, and a copyable paid URL.
   - Row actions: pause/activate, edit, delete (with a confirm).
   - Empty state: "Add your first endpoint".
4. **Add / Edit endpoint** (`/endpoints/new`, `/endpoints/:id/edit`), a form in sections:
   - *Basics*: name, description (the hint says Claude reads this), method, URL. The URL is validated client-side as https; the server's url-guard is the real check.
   - *Auth*: type (none / header / query), name (e.g. `Authorization`), and a value field (e.g. `Bearer sk-…`). The value is **write-only**: on edit it shows "••• set — Replace".
   - *Static headers*: key/value rows (e.g. `anthropic-version`).
   - *Pricing*: price in USD per request, converted to atomic units (×1e6, integer) only when submitting.
   - *Example request*: query string and a JSON body editor, validated as JSON. The hint says Claude copies this.
   - *Guards*: body overrides as JSON (e.g. `{"max_tokens":500}`) and max body bytes.
   - After saving, a **Test** step calls `POST /api/endpoints/:id/test` and shows the upstream status and a truncated response. A 2xx makes the endpoint active (a success state with the paid URL); otherwise the error shows with an "Edit and retry" option.
5. **Endpoint detail** (`/endpoints/:id`)
   - The endpoint's KPIs and chart, and its recent calls.
   - The paid URL.
   - A `curl -i` snippet that shows the 402 quote.
   - An MCP snippet for this endpoint.
6. **Payments** (`/payments`)
   - A full call history table, paged with `before=<ts>`.
   - Filters by endpoint and by status (settled / failed upstream).
   - Payer and tx hash link to BaseScan.
7. **Use with Claude** (`/claude`)
   - A copy-paste `claude mcp add …` command and the `.mcp.json` block with `GATEWAY_URL` set to `location.origin`.
   - The env var list (`BUYER_PRIVATE_KEY`, `MAX_PER_CALL_USD`, `SESSION_BUDGET_USD`).
   - A link to Circle's Base Sepolia USDC faucet.
   - A preview of what `/catalog` currently lists.

**Layout:** a sidebar with Overview, Endpoints, Payments and Use with Claude. The top bar has the wallet pill (short address, USDC balance, network, disconnect).

## Code layout (`web/src`)

```
main.tsx            providers: WagmiProvider, QueryClientProvider, Router
wagmi.ts            config: baseSepolia, injected + coinbaseWallet
lib/api.ts          fetch wrapper: bearer token, JSON, 401 → signOut
lib/auth.ts         useSession(): nonce → SIWE sign → verify; token storage per address
lib/format.ts       atomic↔USD, short address, relative time, basescan URLs
hooks/              useStats, useFeed (since-cursor polling), useEndpoints, useEndpoint, useUsdcBalance
pages/              Connect, Overview, Endpoints, EndpointForm, EndpointDetail, Payments, Claude
components/         Layout, WalletPill, KpiTile, IncomeChart, FeedList, CallsTable, StatusBadge,
                    JsonField, KeyValueRows, SecretField, CopyButton, EmptyState
```

## Backend additions this needs

These are small and belong in the backend plan:

- `GET /api/stats?range=24h|30d&endpoint_id=` should also return `series: [{ bucket, income_atomic, calls }]` and `unique_payers`.
- `GET /api/endpoints` should include per-endpoint `calls` and `income_atomic`. Add `GET /api/endpoints/:id`.
- `GET /api/feed` should accept `endpoint_id`, `status` and `before` (paging) in addition to `since`, and return `endpoint_name` for each row.
- `GET /api/me` → `{ address }` to check the token on load.
- The Worker's `assets` config (above).

## Build order

1. Scaffold `web/` (Vite React TS, Tailwind, wagmi, TanStack Query, router), Vite proxy, Workers assets config.
2. Wallet connect, network switch, SIWE sign-in, API client, protected routes.
3. The Endpoints list and the Add/Edit form with the Test step. This is the core seller flow.
4. Overview: KPIs, USDC balance, live feed polling, chart. Add the backend `series` and feed filters here.
5. Endpoint detail and the Payments page.
6. The Use with Claude page, empty/error/loading states, dark mode, polish.
7. Hook `vite build` into the Worker deploy (e.g. a root `bun run deploy` that builds `web` then runs `wrangler deploy`).

## Verification

- `bun run --filter web build` passes type-checking. `wrangler dev` serves the SPA at `/` and deep links such as `/endpoints/abc` (SPA fallback). `/api/*`, `/x/*` and `/catalog` still reach the Worker.
- Manual run in the browser:
  1. Connect MetaMask on another chain: the switch prompt appears. Switch, then sign in.
  2. Reload: the session persists. Change account: signed out.
  3. Add an endpoint pointing at `https://httpbin.org/anything` with a header secret and body overrides.
  4. Test: the upstream echo shows the injected header and the merged body. The endpoint becomes active.
  5. On edit, the secret is not shown and `GET /api/endpoints` has no secret in the network tab.
  6. Pay for a call through the MCP server (`paid_fetch`). Within about 2s the feed shows the row with a working BaseScan link, the KPIs update, and the USDC pill goes up about 10s later.
  7. Point an endpoint at a failing upstream and call it. It appears as "failed upstream, not charged", with no tx link.
  8. Pause an endpoint: it disappears from `/catalog` and `/x/:id` returns 404.
- The layout works at phone width (sidebar collapses into a menu).

## Out of scope for now

In-browser buyer playground (paying from MetaMask with x402), WebSocket/Durable Object push feed, multi-chain, team accounts, CSV export.
