// Seller analytics. The dashboard polls /feed?since=<latest created_at> for its live list.

import { Hono } from "hono";
import { z } from "zod";
import { atomicToUsd, basescanTx, getFeed, getStats } from "../db";
import { multibaasEnabled, syncFrom } from "../multibaas";
import { CONFIRM_GRACE_MS, verifyCall } from "../reconcile";
import type { AppEnv } from "../types";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const RANGES = { "24h": { span: DAY, bucket: HOUR }, "30d": { span: 30 * DAY, bucket: DAY } } as const;

const StatsQuery = z.object({
  range: z.enum(["24h", "30d"]).default("24h"),
  endpoint_id: z.string().max(64).optional(),
});

const FeedQuery = z.object({
  since: z.coerce.number().int().nonnegative().optional(),
  before: z.coerce.number().int().positive().optional(),
  endpoint_id: z.string().max(64).optional(),
  status: z.enum(["settled", "failed"]).optional(),
  // settled calls no onchain transfer backs (missing or a different amount)
  verification: z.enum(["unverified"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const stats = new Hono<AppEnv>();

stats.get("/stats", async (c) => {
  const q = StatsQuery.safeParse(c.req.query());
  if (!q.success) return c.json({ error: "invalid_query" }, 400);
  const { span, bucket } = RANGES[q.data.range];
  const now = Date.now();
  const since = Math.floor((now - span) / bucket) * bucket + bucket;
  const { totals, series } = await getStats(c.env.DB, { owner: c.var.seller, since, bucketMs: bucket, endpointId: q.data.endpoint_id });

  // Zero-fill so the chart has one point per bucket.
  const byBucket = new Map(series.map((s) => [s.bucket, s]));
  const filled = [];
  for (let b = since; b <= now; b += bucket) {
    const s = byBucket.get(b);
    const income = s?.income_atomic ?? 0;
    filled.push({ bucket: b, income_atomic: income, income_usd: atomicToUsd(income), calls: s?.calls ?? 0 });
  }
  return c.json({
    range: q.data.range,
    endpoint_id: q.data.endpoint_id ?? null,
    ...totals,
    income_usd: atomicToUsd(totals.income_atomic),
    series: filled,
  });
});

stats.get("/feed", async (c) => {
  const q = FeedQuery.safeParse(c.req.query());
  if (!q.success) return c.json({ error: "invalid_query" }, 400);
  const now = Date.now();
  const ctx = { enabled: multibaasEnabled(c.env), syncFrom: syncFrom(c.env), now };
  if (q.data.verification && !ctx.enabled) return c.json({ calls: [] });
  const rows = await getFeed(c.env.DB, {
    owner: c.var.seller,
    since: q.data.since,
    before: q.data.before,
    endpointId: q.data.endpoint_id,
    status: q.data.status,
    unverified: q.data.verification ? { from: ctx.syncFrom, to: now - CONFIRM_GRACE_MS } : undefined,
    limit: q.data.limit,
  });
  return c.json({
    calls: rows.map(({ onchain_amount, onchain_block, ...r }) => ({
      ...r,
      settled: r.settled === 1,
      amount_usd: atomicToUsd(r.amount_atomic),
      tx_url: r.tx_hash ? basescanTx(r.tx_hash) : null,
      // null when onchain verification (MultiBaas) is off or the call wasn't settled
      verification: verifyCall({ ...r, onchain_amount }, ctx),
      onchain_block,
      onchain_usd: onchain_amount === null ? null : atomicToUsd(onchain_amount),
    })),
  });
});

stats.get("/me", (c) => c.json({ address: c.var.seller }));
