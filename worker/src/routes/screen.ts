// Intercepta screening over HTTP.
//
//   POST /screen          public: screen a payment before signing it (MCP, pay page)
//   GET  /demo/rogue      public: an x402 payee that should never be paid (demo)
//   GET  /api/screenings  seller: payer screenings at the paywall, e.g. ?verdict=block
//   GET  /api/screen/payout  seller: screen the signed-in seller's own payout address
//
// The API key stays in this Worker; buyers and the MCP server only see verdicts.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { z } from "zod";
import { atomicToUsd, countBlocked, listScreenings } from "../db";
import { screenPayment, screenPayout, type Check } from "../screen";
import type { AppEnv } from "../types";

const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address");

const ScreenBody = z.object({
  pay_to: Address.optional(),
  asset: Address.optional(),
  payer: Address.optional(),
  amount: z.string().regex(/^\d+$/).optional(),
  authorization: z
    .object({
      domain: z.record(z.string(), z.unknown()).optional(),
      types: z.record(z.string(), z.unknown()).optional(),
      primaryType: z.string().max(100).optional(),
      message: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

// ---- public ------------------------------------------------------------------

export const screen = new Hono<AppEnv>();

screen.use("*", cors({ origin: "*", allowHeaders: ["content-type"] }));

screen.post("/", async (c) => {
  const parsed = ScreenBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid_request", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
  }
  const body = parsed.data;
  if (!body.pay_to && !body.asset && !body.payer && !body.authorization) return c.json({ error: "nothing to screen" }, 400);
  // Each screen spends Intercepta quota, so the public route shares the paid routes' limiter.
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  const { success } = await c.env.RL.limit({ key: `screen:${ip}` });
  if (!success) return c.json({ error: "rate_limited" }, 429);
  return c.json(await screenPayment(c.env, body));
});

// A payee that should never get paid, for showing a blocked payment. Its 402 asks
// for $0.01 on Base Sepolia from a flagged address (DEMO_ROGUE_PAY_TO), or with
// ?token=lookalike, in a token that only looks like USDC. It never settles: a
// signed retry gets the same 402 back, so even an unscreened client loses nothing.
const RONIN_EXPLOITER = "0x098B716B8Aaf21512996dC57EB0615e2383E2f96"; // OFAC-listed (Lazarus Group)
const CLEAN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const TESTNET_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const LOOKALIKE_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7f"; // one hex digit off

export const demo = new Hono<AppEnv>();

demo.use("*", cors({ origin: "*", allowHeaders: ["content-type", "payment-signature", "x-payment"], exposeHeaders: ["payment-required"] }));

demo.all("/rogue", (c) => {
  const lookalike = c.req.query("token") === "lookalike";
  const payTo = lookalike ? CLEAN_ADDRESS : c.env.DEMO_ROGUE_PAY_TO?.trim() || RONIN_EXPLOITER;
  const paid = Boolean(c.req.header("payment-signature") || c.req.header("x-payment"));
  const required = {
    x402Version: 2,
    error: paid ? "this demo payee never settles" : "Payment required",
    resource: { url: c.req.url, description: "Demo: a payee that screening should block", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: c.env.NETWORK,
        amount: "10000",
        asset: lookalike ? LOOKALIKE_USDC : TESTNET_USDC,
        payTo,
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };
  c.header("payment-required", encodePaymentRequiredHeader(required));
  return c.json({ demo: "rogue payee", pay_to: payTo, token: lookalike ? "lookalike" : "usdc", price_usd: "0.01" }, 402);
});

// ---- seller ------------------------------------------------------------------

const ScreeningsQuery = z.object({
  verdict: z.enum(["allow", "warn", "block"]).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const screenings = new Hono<AppEnv>();

screenings.get("/screenings", async (c) => {
  const q = ScreeningsQuery.safeParse(c.req.query());
  if (!q.success) return c.json({ error: "invalid_query" }, 400);
  const [rows, blocked] = await Promise.all([
    listScreenings(c.env.DB, { owner: c.var.seller, ...q.data }),
    countBlocked(c.env.DB, c.var.seller, Date.now() - 30 * 24 * 60 * 60 * 1000),
  ]);
  return c.json({
    enabled: Boolean(c.env.INTERCEPTA_API_KEY?.trim()),
    blocked_30d: blocked.blocked_payments,
    blocked_30d_usd: atomicToUsd(blocked.blocked_atomic),
    screenings: rows.map((r) => ({
      ...r,
      checks: JSON.parse(r.checks) as Check[],
      amount_usd: atomicToUsd(r.amount_atomic),
    })),
  });
});

screenings.get("/screen/payout", async (c) => c.json({ address: c.var.seller, ...(await screenPayout(c.env, c.var.seller)) }));
