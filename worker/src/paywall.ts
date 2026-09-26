// x402 on /x/:id. One middleware per isolate; the price and payTo differ per
// endpoint, so they're resolved per request from the row loadEndpoint just read.
//
// The x402 callbacks only receive the request context (path, headers), not the
// Hono context, so loadEndpoint hands the row over through `routeEndpoints`. The
// callbacks run on both the 402 quote and the paid retry, and each request
// refreshes the row from D1 first, so both see the same current price.

import type { MiddlewareHandler } from "hono";
import { paymentMiddleware } from "@x402/hono";
import { HTTPFacilitatorClient, x402ResourceServer, type HTTPRequestContext, type PaywallProvider } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { getAddress } from "viem";
import { atomicToUsd, type EndpointRow } from "./db";
import type { AppEnv } from "./types";

const routeEndpoints = new Map<string, EndpointRow>();

export function rememberEndpoint(row: EndpointRow) {
  routeEndpoints.set(row.id, row);
}

function endpointFor(ctx: HTTPRequestContext): EndpointRow {
  const id = ctx.path.split("/")[2];
  const row = id ? routeEndpoints.get(id) : undefined;
  if (!row) throw new Error(`endpoint ${id} was not loaded before the paywall`);
  return row;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * What a browser sees when it opens a paid URL. With DASHBOARD_URL set it is sent
 * to the dashboard's pay page (wallet connect, pay, response); without it, a plain
 * page with the price. Programmatic clients never get this: x402 only serves HTML
 * to requests that accept text/html from a Mozilla user agent.
 */
function paywallPage(env: Env): PaywallProvider {
  return {
    generateHtml(paymentRequired) {
      const resource = new URL(paymentRequired.resource?.url ?? "/", "https://gateway.invalid");
      const id = resource.pathname.split("/")[2] ?? "";
      const quote = paymentRequired.accepts[0];
      const price = quote ? `$${atomicToUsd(Number(quote.amount))} USDC` : "a USDC payment";
      const dashboard = env.DASHBOARD_URL?.replace(/\/$/, "");
      const payUrl = dashboard && id ? `${dashboard}/pay/${encodeURIComponent(id)}${resource.search}` : null;
      const head = payUrl ? `<meta http-equiv="refresh" content="0;url=${escapeHtml(payUrl)}">` : "";
      const body = payUrl
        ? `<p>Taking you to the payment page…</p><p><a href="${escapeHtml(payUrl)}">Continue</a></p>`
        : `<p>This API costs ${escapeHtml(price)} per request, paid on Base Sepolia with the x402 protocol.</p>
           <p>Call it from an x402 client, or from Claude with the Tollgate MCP server. The payment requirements are in the <code>PAYMENT-REQUIRED</code> response header.</p>`;
      return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}
<title>Payment required · Tollgate</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f5f7;color:#0e1116;font:15px/1.55 system-ui,sans-serif}
main{max-width:440px;margin:16px;padding:28px;background:#fff;border:1px solid #e3e5e9;border-radius:20px}h1{margin:0 0 8px;font-size:20px}
p{margin:8px 0;color:#4a5160}a{color:#4d7c0f;font-weight:600}code{font-size:13px}</style></head>
<body><main><h1>Payment required</h1>${body}</main></body></html>`;
    },
  };
}

function build(env: Env): MiddlewareHandler {
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: env.FACILITATOR_URL }))
    .register(env.NETWORK, new ExactEvmScheme());

  return paymentMiddleware(
    {
      "/x/*": {
        accepts: {
          scheme: "exact",
          network: env.NETWORK,
          payTo: (ctx) => getAddress(endpointFor(ctx).owner),
          // Money form, so the scheme fills in Base Sepolia USDC and its EIP-712 domain.
          price: (ctx) => `$${atomicToUsd(endpointFor(ctx).price_atomic)}`,
          maxTimeoutSeconds: 300,
        },
        description: "Pay-per-request API on x402-gateway",
        mimeType: "application/json",
        unpaidResponseBody: (ctx) => {
          const ep = endpointFor(ctx);
          return {
            contentType: "application/json",
            body: { endpoint: { id: ep.id, name: ep.name, description: ep.description, price_usd: atomicToUsd(ep.price_atomic) } },
          };
        },
      },
    },
    server,
    undefined,
    paywallPage(env),
  );
}

// Built on first use rather than at module scope: construction starts a fetch to
// the facilitator, and Workers don't allow I/O outside a request.
let middleware: MiddlewareHandler | null = null;

export const paywall: MiddlewareHandler<AppEnv> = (c, next) => {
  middleware ??= build(c.env);
  return middleware(c, next);
};
