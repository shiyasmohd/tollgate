// The paid route: ALL /x/:id
//
//   cors → loadEndpoint → rateLimit → recordCall → paywall → proxy
//
// Everything before the paywall can reject without the buyer ever being quoted.
// The paywall only settles if proxy returns < 400, so a failed upstream is free.

import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { getEndpoint, insertCall, newId } from "../db";
import { paywall, rememberEndpoint } from "../paywall";
import { callUpstream, prepareBody } from "../proxy";
import type { AppEnv, UpstreamOutcome } from "../types";

const loadEndpoint: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ep = await getEndpoint(c.env.DB, c.req.param("id") ?? "");
  if (!ep || ep.status !== "active") return c.json({ error: "endpoint_not_found" }, 404);
  if (c.req.method !== ep.method) {
    c.header("Allow", ep.method);
    return c.json({ error: "method_not_allowed", allowed: ep.method }, 405);
  }

  let raw: string | null = null;
  if (ep.method !== "GET" && ep.method !== "HEAD") {
    if (Number(c.req.header("content-length") ?? 0) > ep.max_body_bytes) {
      return c.json({ error: `body exceeds ${ep.max_body_bytes} bytes` }, 413);
    }
    raw = await c.req.text();
  }
  const prepared = prepareBody(ep, raw);
  if (!prepared.ok) return c.json({ error: prepared.error }, prepared.status);

  c.set("endpoint", ep);
  c.set("upstreamBody", prepared.body);
  rememberEndpoint(ep);
  await next();
};

const rateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  const { success } = await c.env.RL.limit({ key: `${c.var.endpoint.id}:${ip}` });
  if (!success) return c.json({ error: "rate_limited" }, 429);
  await next();
};

/** Records every request that reached the upstream: settled, or failed and not charged. */
const recordCall: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const upstream = c.var.upstream as UpstreamOutcome | undefined;
  if (!upstream) return; // a 402 quote, or rejected before the handler

  const ep = c.var.endpoint;
  const header = c.res.headers.get("payment-response");
  let settle: ReturnType<typeof decodePaymentResponseHeader> | null = null;
  if (header) {
    try {
      settle = decodePaymentResponseHeader(header);
    } catch (e) {
      console.error("undecodable PAYMENT-RESPONSE", e);
    }
  }
  const settled = settle?.success === true;
  c.executionCtx.waitUntil(
    insertCall(c.env.DB, {
      id: newId("call"),
      endpoint_id: ep.id,
      owner: ep.owner,
      payer: settle?.payer?.toLowerCase() ?? null,
      amount_atomic: settled ? Number(settle?.amount ?? ep.price_atomic) : 0,
      tx_hash: settle?.transaction || null,
      settled: settled ? 1 : 0,
      upstream_status: upstream.status,
      latency_ms: upstream.latencyMs,
      created_at: Date.now(),
    }).catch((e) => console.error("insertCall failed", e)),
  );
};

export const paid = new Hono<AppEnv>();

paid.use(
  "/:id",
  cors({
    origin: "*",
    allowHeaders: ["content-type", "payment-signature", "x-payment"],
    exposeHeaders: ["payment-required", "payment-response"],
  }),
);

paid.all("/:id", loadEndpoint, rateLimit, recordCall, paywall, async (c) => {
  const started = Date.now();
  const res = await callUpstream(c.env, c.var.endpoint, {
    query: new URL(c.req.url).searchParams,
    body: c.var.upstreamBody,
    contentType: c.req.header("content-type"),
    accept: c.req.header("accept"),
  });
  c.set("upstream", { status: res.status, latencyMs: Date.now() - started });
  return res;
});
