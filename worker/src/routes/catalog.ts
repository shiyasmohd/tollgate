// Public list of everything for sale: what the MCP server shows Claude.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { atomicToUsd, listCatalog } from "../db";
import { screenPayment, screeningEnabled } from "../screen";
import type { AppEnv } from "../types";

export const catalog = new Hono<AppEnv>();

catalog.use("*", cors({ origin: "*" }));

catalog.get("/", async (c) => {
  const origin = new URL(c.req.url).origin;
  const rows = await listCatalog(c.env.DB);
  // Counterparty risk per seller, so an agent can see it before choosing (verdicts are cached).
  const risk = new Map<string, { verdict: string; summary: string }>();
  if (screeningEnabled(c.env)) {
    const owners = [...new Set(rows.map((r) => r.owner))];
    const results = await Promise.all(owners.map((o) => screenPayment(c.env, { pay_to: o })));
    owners.forEach((o, i) => risk.set(o, { verdict: results[i]!.verdict, summary: results[i]!.summary }));
  }
  return c.json({
    screening: screeningEnabled(c.env) ? "intercepta" : null,
    network: c.env.NETWORK,
    asset: "USDC",
    endpoints: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      method: r.method,
      price_usd: atomicToUsd(r.price_atomic),
      price_atomic: r.price_atomic,
      url: `${origin}/x/${r.id}`,
      example: { query: r.example_query, body: r.example_body },
      accepts_body: r.method !== "GET" && r.method !== "HEAD",
      pay_to: r.owner,
      // Resolves on Sepolia ENSv2 to pay_to (Base Sepolia coin type); agents check the quote against it.
      ens_name: r.ens_name,
      pay_to_risk: risk.get(r.owner) ?? null,
    })),
  });
});
