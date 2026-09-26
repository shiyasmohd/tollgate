# x402-gateway API reference

The gateway is one Hono Worker (`worker/`) with four groups of routes:

| Group | Routes | Auth | Who calls it |
|---|---|---|---|
| [Service info](#get-) | `GET /` | none | anyone |
| [Catalog](#get-catalog) | `GET /catalog` | none | the MCP server, anyone browsing |
| [Paid proxy](#any-xid) | `ANY /x/:id` | x402 payment | buyers (Claude via `mcp/`) |
| [Seller auth](#seller-auth) | `/api/auth/*` | none | the dashboard / seller CLI |
| [Seller API](#seller-api) | `/api/*` | `Authorization: Bearer <token>` | the dashboard / seller CLI |
| [Screening](#payment-screening) | `POST /screen`, `ANY /demo/rogue`, `GET /api/screenings`, `GET /api/screen/payout` | none / seller | the MCP server, the pay page, the dashboard |

Source: `worker/src/index.ts` wires the routes; handlers live in `worker/src/auth.ts` and `worker/src/routes/*.ts`.

---

## Conventions

### Base URL

- Local: `http://localhost:8787` (`bun run dev`)
- Deployed: the Worker's `*.workers.dev` URL

### Network and money

- Settlement is on **Base Sepolia** (`eip155:84532`), paid in **USDC** (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`).
- Money is stored as integer **atomic units** (USDC has 6 decimals, so `1_000_000` = $1). Responses usually give both forms:
  - `*_atomic`: integer, e.g. `20000`
  - `*_usd`: a decimal string with trailing zeros stripped, e.g. `"0.02"`
- The price range for an endpoint is `$0.000001` to `$100` per request.

### Timestamps

Every timestamp (`created_at`, `updated_at`, `expires_at`, `bucket`, `since`, `before`) is **Unix epoch milliseconds**.

### IDs

IDs look like `<prefix>_<14 lowercase alphanumerics>`: endpoints are `ep_…` and calls are `call_…`.

### Errors

Errors are JSON with an `error` string:

```json
{ "error": "not_found" }
```

Body validation failures on the endpoint routes also list each problem:

```json
{
  "error": "invalid_request",
  "issues": [
    { "path": "price_usd", "message": "price_usd must be a decimal with at most 6 places" },
    { "path": "name", "message": "Too small: expected string to have >=1 characters" }
  ]
}
```

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_request`, `invalid_query`, or a message | Bad body or query |
| 401 | `unauthorized` | Missing, malformed, or expired bearer token |
| 404 | `not_found` | Unknown route, or an endpoint you don't own |
| 500 | `internal_error` | Unhandled exception (details go to the Worker log only) |

### CORS

- `/catalog` and `/x/:id` allow any origin. `/x/:id` also allows the request headers `content-type`, `payment-signature` and `x-payment`, and exposes `payment-required` and `payment-response`.
- `/api/*` sends no CORS headers. The dashboard is served from the same origin (or through the Vite dev proxy).

---

## `GET /`

Service info. No auth.

**Response 200**

```json
{
  "service": "x402-gateway",
  "network": "eip155:84532",
  "catalog": "/catalog",
  "paid": "/x/:id"
}
```

---

## `GET /catalog`

The public list of everything for sale: every endpoint whose status is `active`, from all sellers, newest first. The MCP server's `list_paid_apis` tool reads this. Secrets, upstream URLs and headers are never included.

**Response 200**

```json
{
  "network": "eip155:84532",
  "asset": "USDC",
  "screening": "intercepta",
  "endpoints": [
    {
      "id": "ep_k3j9x0c2m1q8zt",
      "name": "Echo (httpbin)",
      "description": "Echoes the request back as JSON. Free upstream, useful for testing payments end to end.",
      "method": "POST",
      "price_usd": "0.001",
      "price_atomic": 1000,
      "url": "http://localhost:8787/x/ep_k3j9x0c2m1q8zt",
      "example": { "query": null, "body": "{\"prompt\":\"hello\"}" },
      "accepts_body": true,
      "pay_to": "0x1234…abcd",
      "pay_to_risk": { "verdict": "allow", "summary": "All checks passed." }
    }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string | Endpoint id |
| `name`, `description` | string | Written by the seller. Claude reads the description to decide how to call the endpoint. |
| `method` | `GET` \| `POST` \| `PUT` \| `PATCH` \| `DELETE` | The only method `/x/:id` accepts for this endpoint |
| `price_usd` / `price_atomic` | string / integer | Flat price per successful request |
| `url` | string | The paid URL, built from the request's origin |
| `example.query` | string \| null | Example query string, without the leading `?` |
| `example.body` | string \| null | Example body as a JSON **string** |
| `accepts_body` | boolean | `false` for `GET`/`HEAD` |
| `pay_to` | string | The seller's address (lowercase). It must match `payTo` in the 402 quote. |
| `pay_to_risk` | object \| null | Intercepta [screening](#payment-screening) of `pay_to` (`verdict`, `summary`); null when screening is off. Top-level `screening` is `"intercepta"` or null. |

---

## `ANY /x/:id`

The paid proxy. It forwards the buyer's request to the seller's upstream API with the seller's secret added. Payment uses the [x402](https://x402.org) `exact` scheme. The buyer is charged only when the upstream responds with a status below 400.

### Request pipeline

```
cors → loadEndpoint → rateLimit → recordCall → paywall (x402) → proxy to upstream
```

Every check before the paywall can reject a request before it gets a price quote, so a malformed request never costs the buyer anything.

| Step | Can return |
|---|---|
| `loadEndpoint`: the endpoint must exist and be `active`, the method must match, the body must fit `max_body_bytes`, and `body_overrides` are applied | 404, 405, 413, 400 |
| `rateLimit`: 60 requests per 60 s per endpoint and client IP (`cf-connecting-ip`) | 429 |
| `paywall`: no payment header returns a quote; a payment header is verified with the facilitator | 402 |
| proxy: calls the upstream with a timeout (`UPSTREAM_TIMEOUT_MS`, default 30 s) | upstream status, 502, 504 |
| settle: runs only when the proxy returns a status below 400 | adds `PAYMENT-RESPONSE` |

### What gets forwarded upstream

- **Method:** the endpoint's configured method.
- **URL:** the endpoint's `url`, plus the buyer's query parameters. A parameter already on the seller's URL is fixed: the buyer can't override it.
- **Headers:** the seller's `static_headers`, then `accept` (the buyer's value, or `*/*`), then `content-type` when there is a body (the buyer's value, or `application/json`). No other buyer headers are forwarded.
- **Auth:** for `auth.type = "header"`, the header `auth.name: <secret>` is set. For `"query"`, the query parameter `auth.name=<secret>` is set and overrides any buyer value.
- **Body:** only for methods other than `GET`/`HEAD`. If the endpoint has `body_overrides`, the buyer's body must be a JSON object (an empty body counts as `{}`), and the overrides are shallow-merged over it, so seller keys win.
- **Redirects** are not followed. A 3xx from the upstream is returned to the buyer as is.

### What comes back

- The upstream's status and body.
- The upstream's headers, except `set-cookie`, `content-encoding`, `content-length`, `transfer-encoding`, `connection`, `keep-alive`, `server`, `alt-svc`, `report-to`, `nel` and any `cf-*` header.
- For text responses (json, text, xml, javascript, graphql), every occurrence of the secret is replaced with `[redacted]`. If the secret has the form `Bearer sk-…`, the token part alone is redacted as well.
- Responses are buffered. Streaming and SSE are not supported.

### Step 1: unpaid request → 402 quote

```bash
curl -i -X POST http://localhost:8787/x/ep_k3j9x0c2m1q8zt \
  -H 'content-type: application/json' -d '{"prompt":"hi"}'
```

```
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6Mi…   (base64 JSON)
Content-Type: application/json

{ "endpoint": { "id": "ep_k3j9x0c2m1q8zt", "name": "Echo (httpbin)", "description": "…", "price_usd": "0.001" } }
```

The `PAYMENT-REQUIRED` header decodes to the x402 v2 payment requirements:

```json
{
  "x402Version": 2,
  "resource": { "url": "http://localhost:8787/x/ep_k3j9x0c2m1q8zt", "description": "Pay-per-request API on x402-gateway", "mimeType": "application/json" },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
      "amount": "1000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0x1234…ABCD",
      "maxTimeoutSeconds": 300,
      "extra": { "name": "USDC", "version": "2" }
    }
  ]
}
```

`payTo` is the endpoint owner's address, and `amount` is its current price in atomic units. Both come from the database on every request, so a price change applies from the next quote.

### Step 2: paid retry

Resend the same request with a signed payment in `PAYMENT-SIGNATURE` (x402 v2) or `X-PAYMENT` (v1). An x402 client handles both steps for you:

```ts
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
// register an EVM signer for eip155:84532 on the client (see mcp/src/index.ts)
const paidFetch = wrapFetchWithPayment(fetch, client);
const res = await paidFetch(`${GATEWAY}/x/${id}`, { method: "POST", body: JSON.stringify({ prompt: "hi" }) });
```

On success the response carries the upstream result plus a `PAYMENT-RESPONSE` header. It is base64 JSON with the settlement result: `success`, `transaction` (the Base Sepolia tx hash), `network`, `payer` and `amount`.

The buyer only needs Base Sepolia USDC. The facilitator (`FACILITATOR_URL`, default `https://x402.org/facilitator`) pays gas.

### Status codes

| Status | Body | Charged? | Meaning |
|---|---|---|---|
| 2xx / 3xx | upstream body | **yes** | Upstream succeeded and payment settled |
| 400 | `{"error":"body must be JSON"}` or `"body must be a JSON object"` | no | The endpoint has `body_overrides` and the body isn't a JSON object |
| 402 | quote (see above) | no | No payment attached, or the payment was invalid |
| 404 | `{"error":"endpoint_not_found"}` | no | Unknown id, or the endpoint is `pending`, `paused` or `deleted` |
| 405 | `{"error":"method_not_allowed","allowed":"POST"}` + `Allow` header | no | Wrong HTTP method |
| 413 | `{"error":"body exceeds 65536 bytes"}` | no | Body larger than `max_body_bytes` |
| 429 | `{"error":"rate_limited"}` | no | Over 60 req/min for this endpoint from this IP |
| 4xx / 5xx | upstream body | no | Upstream failed, so settlement is skipped |
| 502 | `{"error":"upstream_unreachable"}` | no | Network error reaching the upstream |
| 504 | `{"error":"upstream_timeout"}` | no | Upstream took longer than `UPSTREAM_TIMEOUT_MS` |

Every request that reaches the upstream, settled or not, is recorded as a call. Those calls feed [`/api/stats`](#get-apistats) and [`/api/feed`](#get-apifeed).

---

## Seller auth

Sellers sign in with [Sign-In with Ethereum](https://eips.ethereum.org/EIPS/eip-4361) (SIWE) and get a 24-hour HS256 bearer token. Signatures are checked through a Base Sepolia client, so smart-contract wallets (ERC-1271 / ERC-6492, e.g. Coinbase Smart Wallet) work as well as EOAs. The signing address becomes the payout address (`payTo`) for every endpoint the seller creates.

### `GET /api/auth/nonce`

Returns a single-use nonce that is valid for 10 minutes.

**Response 200**

```json
{ "nonce": "b7Xq2kPz9mLwR4tY" }
```

### `POST /api/auth/verify`

Checks a signed SIWE message and returns a session token.

**Request body**

| Field | Type | Notes |
|---|---|---|
| `message` | string, 1–4000 chars | An EIP-4361 message. Its `domain` must equal the gateway host (e.g. `localhost:8787`), and its `nonce` must come from `/api/auth/nonce`. Use `chainId` 84532. |
| `signature` | `0x…` hex string | The wallet's `personal_sign` signature over `message` |

Building the message with viem:

```ts
import { createSiweMessage } from "viem/siwe";

const { nonce } = await (await fetch(`${GATEWAY}/api/auth/nonce`)).json();
const url = new URL(GATEWAY);
const message = createSiweMessage({
  domain: url.host,
  address: account.address,
  statement: "Sign in to x402-gateway",
  uri: url.origin,
  version: "1",
  chainId: 84532,
  nonce,
  issuedAt: new Date(),
});
const signature = await account.signMessage({ message });
const res = await fetch(`${GATEWAY}/api/auth/verify`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message, signature }),
});
```

**Response 200**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "address": "0x1234…abcd",
  "expires_at": 1790000000000
}
```

`address` is lowercase. `expires_at` is 24 hours after sign-in, in epoch ms. After it passes, `/api/*` returns 401 and the client must sign in again.

**Errors**

| Status | `error` | Cause |
|---|---|---|
| 400 | `message and signature are required` | Missing fields, or `signature` isn't hex |
| 400 | `malformed SIWE message` | The message has no parsable `address` or `nonce` |
| 401 | `unknown or expired nonce` | The nonce was never issued, is over 10 minutes old, or was already used |
| 401 | `invalid signature` | Bad signature, domain mismatch, or the message is expired or not yet valid |

A nonce is consumed before the signature is checked, so a failed attempt still uses it up. Fetch a new nonce to retry.

---

## Seller API

Every `/api/*` route below needs:

```
Authorization: Bearer <token>
```

A missing or invalid token returns `401 {"error":"unauthorized"}`. All data is scoped to the signed-in address. Another seller's endpoint returns `404`, the same as one that doesn't exist.

### `GET /api/me`

**Response 200**

```json
{ "address": "0x1234…abcd" }
```

---

### The endpoint object

Every `/api/endpoints` route returns endpoints in this shape. The upstream secret is **write-only**: it is stored AES-GCM encrypted under `MASTER_KEY` and never returned. `auth_set` tells you whether one is stored.

```json
{
  "id": "ep_k3j9x0c2m1q8zt",
  "owner": "0x1234…abcd",
  "name": "Echo (httpbin)",
  "description": "Echoes the request back as JSON.",
  "method": "POST",
  "url": "https://httpbin.org/anything",
  "auth_type": "header",
  "auth_name": "Authorization",
  "auth_set": true,
  "static_headers": { "x-demo": "1" },
  "price_atomic": 1000,
  "price_usd": "0.001",
  "example_query": null,
  "example_body": "{\"prompt\":\"hello\"}",
  "body_overrides": { "max_tokens": 100 },
  "max_body_bytes": 65536,
  "status": "active",
  "created_at": 1789900000000,
  "updated_at": 1789900050000,
  "calls": 12,
  "income_atomic": 12000,
  "paid_url": "http://localhost:8787/x/ep_k3j9x0c2m1q8zt"
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string | `ep_…` |
| `owner` | string | Seller address, lowercase, also the `payTo` |
| `name` | string | |
| `description` | string | Shown to buyers in the catalog |
| `method` | string | `GET` `POST` `PUT` `PATCH` `DELETE` |
| `url` | string | Upstream URL (visible only to the owner) |
| `auth_type` | `none` \| `header` \| `query` | Where the secret goes |
| `auth_name` | string \| null | Header name or query parameter name |
| `auth_set` | boolean | Whether an encrypted secret is stored |
| `static_headers` | object | Extra headers sent upstream on every call |
| `price_atomic` / `price_usd` | integer / string | Price per successful call |
| `example_query` | string \| null | Used by `/test` and shown in the catalog |
| `example_body` | string \| null | A JSON **string**, used by `/test` and shown in the catalog |
| `body_overrides` | object \| null | Shallow-merged over every buyer body |
| `max_body_bytes` | integer | Largest buyer body accepted |
| `screen_payers` | boolean | Screen each payer with Intercepta before accepting their payment |
| `status` | `pending` \| `active` \| `paused` | See [lifecycle](#endpoint-lifecycle) |
| `created_at` / `updated_at` | integer | Epoch ms |
| `calls` | integer | All-time **settled** calls |
| `income_atomic` | integer | All-time settled income |
| `paid_url` | string | The URL buyers call |

### Endpoint lifecycle

```
            POST /api/endpoints
                    │
                    ▼
   ┌────────── pending ◀──────────────────────────────┐
   │                │ POST /:id/test returns 2xx       │ PATCH changes url, method,
   │                ▼                                  │ auth, static_headers or
   │             active ◀──── PATCH {status:"active"} │ body_overrides
   │                │                    │             │
   │                └─ PATCH {status:"paused"} ─▶ paused
   │
   └─ DELETE (from any state) ─▶ deleted  (soft: hidden everywhere, secret wiped)
```

- Only `active` endpoints appear in `/catalog` and accept paid calls.
- A `pending` endpoint becomes `active` only by passing `/test`. A PATCH of `{"status":"active"}` on a pending endpoint returns 409.
- A `paused` endpoint can go back to `active` with a PATCH and needs no retest, as long as the same PATCH doesn't change any retest field.

---

### `GET /api/endpoints`

Lists your endpoints (excluding deleted ones), newest first, with all-time totals.

**Response 200**

```json
{ "endpoints": [ /* endpoint objects */ ] }
```

---

### `GET /api/endpoints/:id`

**Response 200**

```json
{ "endpoint": { /* endpoint object */ } }
```

**Errors:** `404 not_found` if the endpoint doesn't exist, is deleted, or belongs to someone else.

---

### `POST /api/endpoints`

Creates an endpoint in status `pending`. Run [`/test`](#post-apiendpointsidtest) next to activate it.

**Request body**

| Field | Type | Required | Default | Rules |
|---|---|---|---|---|
| `name` | string | yes | | 1–80 chars, trimmed |
| `description` | string | yes | | 1–2000 chars, trimmed. Tell the buyer (Claude) what the endpoint does and how to call it. |
| `method` | string | no | `GET` | `GET` `POST` `PUT` `PATCH` `DELETE` |
| `url` | string | yes | | ≤ 2048 chars, see [URL rules](#upstream-url-rules) |
| `auth` | object | no | `{"type":"none"}` | `{"type":"none"}` or `{"type":"header"\|"query","name":string,"value":string}`. `name` is 1–100 chars, `value` 1–4096 chars and required on create. |
| `static_headers` | object | no | `{}` | At most 20 entries. Names 1–100 chars, values ≤ 4096 chars. |
| `price_usd` | string \| number | yes | | Decimal with ≤ 6 places, > 0 and ≤ 100. A string like `"0.001"` is safest. |
| `example_query` | string \| null | no | `null` | ≤ 2000 chars. A leading `?` is stripped. |
| `example_body` | string \| object \| array \| null | no | `null` | Objects and arrays are stored as JSON text, ≤ 65536 chars |
| `body_overrides` | object \| null | no | `null` | Merged over every buyer body, and over `example_body` in `/test` |
| `max_body_bytes` | integer | no | `65536` | 0 – 1048576 |
| `screen_payers` | boolean | no | `true` | Changing it needs no retest |

**Example**

```bash
curl -X POST http://localhost:8787/api/endpoints \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{
    "name": "OpenAI chat completions (gpt-4o-mini)",
    "description": "OpenAI Chat Completions. POST {\"model\":\"gpt-4o-mini\",\"messages\":[…]}. Capped at 500 tokens, no streaming.",
    "method": "POST",
    "url": "https://api.openai.com/v1/chat/completions",
    "auth": { "type": "header", "name": "Authorization", "value": "Bearer sk-…" },
    "price_usd": "0.01",
    "example_body": { "model": "gpt-4o-mini", "messages": [{ "role": "user", "content": "Say hi in five words." }] },
    "body_overrides": { "model": "gpt-4o-mini", "max_tokens": 500, "stream": false, "n": 1 },
    "max_body_bytes": 32768
  }'
```

More examples are in `scripts/examples/`.

**Response 201**

```json
{ "endpoint": { /* endpoint object, status "pending", calls 0 */ } }
```

**Errors**

| Status | `error` | Cause |
|---|---|---|
| 400 | `invalid_request` + `issues` | Schema validation failed, or the body isn't JSON |
| 400 | `url is not a valid URL` and the other [URL rule](#upstream-url-rules) messages | Rejected upstream URL |
| 400 | `auth.value is required` | `auth.type` is `header`/`query` but no `value` was given |

#### Upstream URL rules

The gateway fetches URLs that sellers supply, so it rejects:

| Rule | Error |
|---|---|
| Not parsable | `url is not a valid URL` |
| Not `https:` | `url must use https` |
| Contains `user:pass@` | `url must not contain credentials` |
| IPv4 or IPv6 literal host | `url must use a hostname, not an IP address` |
| `localhost`, a single-label host, or a host ending in `.localhost` `.local` `.internal` `.lan` `.home.arpa` | `url must be a public hostname` |
| The gateway's own host | `url must not point at this gateway` |

Query parameters in `url` are fixed: buyers can add parameters but can't override these.

---

### `PATCH /api/endpoints/:id`

Partial update. Omitted fields are left as they are. The fields and rules match `POST`, with no defaults, plus a `status` field.

| Extra field | Type | Notes |
|---|---|---|
| `status` | `active` \| `paused` | Pause or resume selling |

Special cases:

- **Keeping the secret:** send `auth` without `value` (e.g. `{"type":"header","name":"X-Api-Key"}`) to rename the header or parameter and keep the stored secret. This fails with `400 auth.value is required` if no secret is stored yet.
- **Removing auth:** `{"auth":{"type":"none"}}` deletes the stored secret.
- **Clearing optional fields:** send `null` for `example_query`, `example_body` or `body_overrides`.
- **Retest:** changing any of `url`, `method`, `auth`, `static_headers` or `body_overrides` sets the status back to `pending` and ignores any `status` in the same request. Run `/test` again to reactivate. `name`, `description`, `price_usd`, `example_*` and `max_body_bytes` can change without a retest.

**Examples**

```bash
# change the price (applies to the next quote, no retest)
curl -X PATCH http://localhost:8787/api/endpoints/$ID \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"price_usd":"0.02"}'

# pause selling
curl -X PATCH … -d '{"status":"paused"}'

# rotate the upstream key (goes back to pending)
curl -X PATCH … -d '{"auth":{"type":"header","name":"Authorization","value":"Bearer sk-new…"}}'
```

**Response 200**

```json
{
  "endpoint": { /* updated endpoint object */ },
  "retest_required": false
}
```

**Errors**

| Status | `error` | Cause |
|---|---|---|
| 400 | `invalid_request` + `issues` | Validation failed |
| 400 | URL rule message / `auth.value is required` | As for `POST` |
| 404 | `not_found` | Unknown, deleted, or not yours |
| 409 | `run POST /api/endpoints/:id/test to activate a pending endpoint` | Tried to set `active` on a `pending` endpoint |

---

### `DELETE /api/endpoints/:id`

Soft-deletes the endpoint. It disappears from your list, the catalog and `/x/:id`, and its encrypted secret is wiped at once. Its call history stays, so past income remains in `/api/stats` and `/api/feed`. There is no undelete.

**Response 200**

```json
{ "ok": true }
```

**Errors:** `404 not_found`.

---

### `POST /api/endpoints/:id/test`

Calls the upstream once with the example request. The call is unpaid, isn't recorded as a call, and doesn't touch the rate limit. The request is built the same way as a paid one: `example_query` becomes the query string, `example_body` (with `body_overrides` merged in) becomes the body with `content-type: application/json`, and the secret and static headers are added.

If the upstream returns 2xx and the endpoint is `pending`, it becomes **`active`**. Testing an `active` or `paused` endpoint doesn't change its status.

No request body.

**Response 200** (returned even when the upstream fails; check `ok`)

```json
{
  "ok": true,
  "status": 200,
  "latency_ms": 412,
  "content_type": "application/json",
  "body": "{\"json\":{\"prompt\":\"hello\",\"max_tokens\":100}, …}",
  "activated": true,
  "endpoint_status": "active"
}
```

| Field | Notes |
|---|---|
| `ok` | `true` when the upstream status is 2xx |
| `status` | The upstream status, or 502/504 if it was unreachable or timed out |
| `latency_ms` | Round trip, in ms |
| `content_type` | The upstream `content-type`, or null |
| `body` | The upstream body as text, with the secret redacted, cut to 4000 chars (a trailing `…` marks the cut) |
| `activated` | Whether this test moved the endpoint from `pending` to `active` |
| `endpoint_status` | The status after the test |

**Errors**

| Status | Body | Cause |
|---|---|---|
| 400 | `{"ok":false,"error":"example_body: body must be JSON"}` (or `…must be a JSON object`) | `body_overrides` is set and `example_body` isn't a JSON object |
| 400 | `{"ok":false,"error":"example_body: body exceeds N bytes"}` | `example_body` is larger than `max_body_bytes` |
| 404 | `{"error":"not_found"}` | Unknown, deleted, or not yours |

---

### `GET /api/stats`

Income and call totals over a window, plus a zero-filled time series for charts.

**Query parameters**

| Param | Type | Default | Notes |
|---|---|---|---|
| `range` | `24h` \| `30d` | `24h` | `24h` gives 24 hourly buckets; `30d` gives 30 daily buckets |
| `endpoint_id` | string | all endpoints | Limit to one endpoint (≤ 64 chars) |

**Response 200**

```json
{
  "range": "24h",
  "endpoint_id": null,
  "income_atomic": 40000,
  "income_usd": "0.04",
  "paid_calls": 2,
  "failed_calls": 1,
  "unique_payers": 2,
  "series": [
    { "bucket": 1789833600000, "income_atomic": 0,     "income_usd": "0",    "calls": 0 },
    { "bucket": 1789837200000, "income_atomic": 40000, "income_usd": "0.04", "calls": 2 }
  ]
}
```

| Field | Notes |
|---|---|
| `income_atomic` / `income_usd` | Sum of settled amounts in the window |
| `paid_calls` | Settled calls |
| `failed_calls` | Calls that reached the upstream but weren't charged (upstream ≥ 400, or settlement failed) |
| `unique_payers` | Distinct payer addresses among settled calls |
| `series[].bucket` | Bucket start, epoch ms, aligned to the hour or UTC day. The oldest partial bucket is dropped; the current bucket is included. |
| `series[].calls` | Settled calls in the bucket |

The window starts at the first complete bucket boundary after `now − range`.

**Errors:** `400 {"error":"invalid_query"}`.

---

### `GET /api/feed`

Recent calls to your endpoints, newest first. The dashboard polls it with `since` set to the newest `created_at` it has seen, to show a live list.

**Query parameters**

| Param | Type | Default | Notes |
|---|---|---|---|
| `since` | integer (epoch ms) | | Only calls **after** this time (exclusive). Use it to poll for new calls. |
| `before` | integer (epoch ms) | | Only calls **before** this time (exclusive). Use it to page back through older calls. |
| `endpoint_id` | string | | Limit to one endpoint |
| `status` | `settled` \| `failed` | both | Filter by outcome |
| `limit` | integer 1–100 | `20` | Page size |

**Response 200**

```json
{
  "calls": [
    {
      "id": "call_9f2k1m0x7q3zpa",
      "endpoint_id": "ep_k3j9x0c2m1q8zt",
      "endpoint_name": "Echo (httpbin)",
      "owner": "0x1234…abcd",
      "payer": "0x9876…4321",
      "amount_atomic": 1000,
      "amount_usd": "0.001",
      "settled": true,
      "tx_hash": "0x5e1c…",
      "tx_url": "https://sepolia.basescan.org/tx/0x5e1c…",
      "upstream_status": 200,
      "latency_ms": 388,
      "payer_verdict": "allow",
      "created_at": 1789900123456
    }
  ]
}
```

| Field | Notes |
|---|---|
| `endpoint_name` | The endpoint's current name (deleted endpoints are included) |
| `payer` | The buyer address (lowercase), or null when not settled |
| `amount_atomic` / `amount_usd` | `0` for failed calls |
| `settled` | Whether USDC moved to you |
| `tx_hash` / `tx_url` | The settlement transaction and its BaseScan link, or null |
| `upstream_status` | The status your upstream returned (or 502/504 from the gateway) |
| `latency_ms` | Upstream round trip only, not including payment verification or settlement |
| `payer_verdict` | Latest Intercepta screening of this payer for you (`allow` \| `warn` \| `block`), or null if never screened |

**Polling pattern**

```ts
let cursor = 0;
setInterval(async () => {
  const { calls } = await api(`/api/feed?since=${cursor}&limit=100`);
  if (calls.length) cursor = calls[0].created_at;   // newest first
  prepend(calls);
}, 3000);
```

To page back, pass `before=<created_at of the oldest row shown>`.

**Errors:** `400 {"error":"invalid_query"}`.

---

## Payment screening

Payments are screened with the Intercepta (Web3 Antivirus) API. The key lives only in the gateway (`INTERCEPTA_API_KEY`). Without it every check comes back `skipped` and nothing is blocked. Implementation: `worker/src/screen.ts`.

### `POST /screen`

Public, CORS open, rate limited per IP. Screens whichever parts of a payment are given, in parallel.

| Field | Type | Check |
|---|---|---|
| `pay_to` | address | recipient: address quick-scan |
| `asset` | address | token: must be canonical USDC, then token risks on Base mainnet |
| `payer` | address | payer: address quick-scan |
| `amount` | atomic string | compared with the authorization's `value` |
| `authorization` | EIP-712 typed data | must be a `TransferWithAuthorization` on USDC to `pay_to` for `amount`, valid < 24h; then Intercepta signature analysis |

**Response 200**

```json
{
  "verdict": "block",
  "enabled": true,
  "provider": "intercepta",
  "summary": "Recipient flagged sanction_address",
  "checks": [
    { "kind": "pay_to", "label": "Recipient", "subject": "0x098B…2F96", "status": "block", "reason": "flagged sanction_address", "score": 95, "flags": ["sanction_address"] },
    { "kind": "token", "label": "Token", "subject": "0x036C…CF7e", "status": "pass", "reason": "USDC verified", "score": "neutral", "flags": [] }
  ]
}
```

`verdict` is `block` if any check blocks, `warn` if any warns, else `allow`. `status` per check: `pass` | `warn` | `block` | `skipped`. When Intercepta can't be reached a check blocks (`INTERCEPTA_FAIL_MODE=closed`) or warns (`open`).

**Errors:** `400` invalid body or nothing to screen, `429 {"error":"rate_limited"}`.

### Payer screening at the paywall

On a paid retry to `/x/:id` whose endpoint has `screen_payers`, the payer from the signed authorization is screened before the facilitator verifies it. A blocked payer gets a `402` whose `PAYMENT-REQUIRED` `error` is `payer_blocked_by_intercepta: <summary>`. Nothing settles and the upstream isn't called. Every screening is stored for `/api/screenings`.

### `ANY /demo/rogue`

An x402 payee that screening should block, for demos. Its 402 asks $0.01 USDC on Base Sepolia to an OFAC-listed address (`DEMO_ROGUE_PAY_TO` overrides), or with `?token=lookalike` in a token one hex digit off USDC. It never settles: a signed retry gets the same 402 with `error: "this demo payee never settles"`.

### `GET /api/screenings`

Seller. Payer screenings at your paywall, newest first. Query: `verdict` (`allow` | `warn` | `block`), `before` (epoch ms), `limit` (1–100, default 20).

```json
{
  "enabled": true,
  "blocked_30d": 1,
  "blocked_30d_usd": "0.02",
  "screenings": [
    { "id": "scr_…", "endpoint_id": "ep_…", "endpoint_name": "Echo", "payer": "0xbad…", "verdict": "block",
      "summary": "Payer flagged known_scammer", "checks": [ … ], "amount_atomic": 20000, "amount_usd": "0.02", "created_at": 1789900123456 }
  ]
}
```

### `GET /api/screen/payout`

Seller. Screens your own payout address: the `/screen` response for `pay_to` plus `address` and `poisoned` (Intercepta's address-poisoning history: `true`, `false`, or `null` when unknown or off).

---

## End-to-end walkthrough

```bash
# 1. Sign in as a seller (the CLI does SIWE for you) and create an endpoint
export SELLER_PRIVATE_KEY=0x...
bun seller create scripts/examples/httpbin-echo.json      # → ep_…

# 2. Test it: one unpaid upstream call; a 2xx activates it
bun seller test ep_…

# 3. It's now in the catalog
curl http://localhost:8787/catalog

# 4. An unpaid call gets a 402 quote
curl -i -X POST http://localhost:8787/x/ep_… -d '{}'

# 5. Pay from Claude via the MCP server (paid_fetch), or from mcp/src/smoke.ts
BUYER_PRIVATE_KEY=0x... bun mcp/src/smoke.ts

# 6. Watch the income arrive
bun seller stats 24h
bun seller feed
```

## Configuration reference

Values that change API behaviour (`worker/wrangler.jsonc` and secrets):

| Name | Kind | Default | Effect |
|---|---|---|---|
| `NETWORK` | var | `eip155:84532` | x402 network for quotes and settlement |
| `FACILITATOR_URL` | var | `https://x402.org/facilitator` | Verifies and settles payments |
| `UPSTREAM_TIMEOUT_MS` | var | `30000` | Upstream fetch timeout; exceeding it returns 504, uncharged |
| `RL` | rate limit binding | 60 / 60 s | Paid-route limit per endpoint and IP |
| `MASTER_KEY` | secret | | Base64, 32 bytes. AES-GCM key for seller secrets. Rotating it makes stored secrets unreadable. |
| `SESSION_SECRET` | secret | | HS256 key for seller bearer tokens. Rotating it signs every seller out. |
| `INTERCEPTA_API_KEY` | secret | | Intercepta API key. Empty turns payment screening off. |
| `INTERCEPTA_FAIL_MODE` | var | `closed` | `closed`: block when Intercepta is unreachable; `open`: allow with a warning |
| `INTERCEPTA_BLOCK_SCORE` | var | `70` | Block addresses whose toxic score is at least this |
| `DEMO_ROGUE_PAY_TO` | var | OFAC-listed address | Payee of `/demo/rogue` |
