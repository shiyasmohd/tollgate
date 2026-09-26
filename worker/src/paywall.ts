// x402 on /x/:id. One middleware per isolate; the price and payTo differ per
// endpoint, so they're resolved per request from the row loadEndpoint just read.
//
// The x402 callbacks only receive the request context (path, headers), not the
// Hono context, so loadEndpoint hands the row over through `routeEndpoints`. The
// callbacks run on both the 402 quote and the paid retry, and each request
// refreshes the row from D1 first, so both see the same current price.

import type { MiddlewareHandler } from "hono";
import { paymentMiddleware } from "@x402/hono";
import { HTTPFacilitatorClient, x402ResourceServer, type HTTPRequestContext } from "@x402/core/server";
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
  );
}

// Built on first use rather than at module scope: construction starts a fetch to
// the facilitator, and Workers don't allow I/O outside a request.
let middleware: MiddlewareHandler | null = null;

export const paywall: MiddlewareHandler<AppEnv> = (c, next) => {
  middleware ??= build(c.env);
  return middleware(c, next);
};
