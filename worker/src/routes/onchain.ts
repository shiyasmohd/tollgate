// Onchain verification with Curvegrid MultiBaas.
//
//   POST /hooks/multibaas  public, HMAC-signed: USDC Transfers MultiBaas indexed
//   GET  /api/reconcile    seller: recorded vs onchain income, ?range=24h|30d
//   GET  /api/actions      seller: what to do next, from the last 24 hours

import { Hono } from "hono";
import { z } from "zod";
import { buildActions } from "../actions";
import {
  countBlocked,
  endpointHealth,
  insertTransfers,
  knownSellers,
  listSettledCalls,
  listTransfers,
  payerIncome,
  repeatBlockedPayers,
} from "../db";
import { multibaasEnabled, queryTransfersTo, syncFrom, transfersFromWebhook, usdcAddress, verifyWebhook } from "../multibaas";
import { reconcile } from "../reconcile";
import type { AppEnv } from "../types";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const RANGES = { "24h": DAY, "30d": 30 * DAY } as const;
const MAX_WEBHOOK_BYTES = 1_000_000;
/** How often one seller's page loads may re-query MultiBaas. */
const BACKFILL_EVERY_MS = 30_000;

// ---- webhook -------------------------------------------------------------------

export const hooks = new Hono<AppEnv>();

hooks.post("/multibaas", async (c) => {
  const secret = c.env.MULTIBAAS_WEBHOOK_SECRET;
  if (!secret?.trim()) return c.json({ error: "webhook not configured" }, 503);
  if (Number(c.req.header("content-length") ?? 0) > MAX_WEBHOOK_BYTES) return c.json({ error: "payload too large" }, 413);
  const body = new Uint8Array(await c.req.arrayBuffer());
  const valid = await verifyWebhook(secret, body, c.req.header("x-multibaas-signature"), c.req.header("x-multibaas-timestamp"));
  if (!valid) return c.json({ error: "invalid signature" }, 401);

  let events: unknown;
  try {
    events = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  // USDC is a busy contract: keep only transfers into a seller's payout address.
  const transfers = transfersFromWebhook(events, usdcAddress(c.env));
  const sellers = await knownSellers(c.env.DB, [...new Set(transfers.map((t) => t.owner))]);
  const mine = transfers.filter((t) => sellers.has(t.owner));
  await insertTransfers(c.env.DB, mine, "webhook");
  return c.json({ received: Array.isArray(events) ? events.length : 0, stored: mine.length });
});

// ---- seller --------------------------------------------------------------------

const lastBackfill = new Map<string, { at: number; error: string | null }>();

/**
 * Pulls the seller's recent USDC receipts from MultiBaas into D1, so a missed
 * webhook doesn't leave a payment unverified. Throttled per seller; returns the
 * error message when MultiBaas couldn't be queried.
 */
async function backfill(env: Env, owner: string): Promise<string | null> {
  const last = lastBackfill.get(owner);
  if (last && Date.now() - last.at < BACKFILL_EVERY_MS) return last.error;
  let error: string | null = null;
  try {
    await insertTransfers(env.DB, await queryTransfersTo(env, owner), "query");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    console.error("MultiBaas backfill failed", e);
  }
  lastBackfill.set(owner, { at: Date.now(), error });
  return error;
}

async function reconcileFor(env: Env, owner: string, span: number) {
  const now = Date.now();
  const since = now - span;
  if (!multibaasEnabled(env)) return { enabled: false, error: null, since, result: null };
  const error = await backfill(env, owner);
  const [calls, transfers] = await Promise.all([listSettledCalls(env.DB, owner, since), listTransfers(env.DB, owner, since)]);
  return { enabled: true, error, since, result: reconcile(calls, transfers, { enabled: true, syncFrom: syncFrom(env), now }) };
}

const ReconcileQuery = z.object({ range: z.enum(["24h", "30d"]).default("24h") });

export const onchain = new Hono<AppEnv>();

onchain.get("/reconcile", async (c) => {
  const q = ReconcileQuery.safeParse(c.req.query());
  if (!q.success) return c.json({ error: "invalid_query" }, 400);
  const r = await reconcileFor(c.env, c.var.seller, RANGES[q.data.range]);
  return c.json({
    provider: "multibaas",
    enabled: r.enabled,
    status: !r.enabled ? "off" : r.error ? "degraded" : "ok",
    error: r.error,
    range: q.data.range,
    since: r.since,
    sync_from: syncFrom(c.env) || null,
    ...r.result,
  });
});

onchain.get("/actions", async (c) => {
  const owner = c.var.seller;
  const since = Date.now() - DAY;
  const [r, endpoints, blocked, repeatBlocked, payers] = await Promise.all([
    reconcileFor(c.env, owner, DAY),
    endpointHealth(c.env.DB, owner, since),
    countBlocked(c.env.DB, owner, since),
    repeatBlockedPayers(c.env.DB, owner, since, 3),
    payerIncome(c.env.DB, owner, since),
  ]);
  const actions = buildActions({
    owner,
    reconciliation: r.result,
    verificationError: r.error,
    endpoints,
    blocked,
    repeatBlocked,
    payers,
  });
  return c.json({ actions, verification: !r.enabled ? "off" : r.error ? "degraded" : "ok", generated_at: Date.now() });
});
