// Public list of everything for sale: what the MCP server shows Claude.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { atomicToUsd, listCatalog } from "../db";
import type { AppEnv } from "../types";

export const catalog = new Hono<AppEnv>();

catalog.use("*", cors({ origin: "*" }));

catalog.get("/", async (c) => {
  const origin = new URL(c.req.url).origin;
  const rows = await listCatalog(c.env.DB);
  return c.json({
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
    })),
  });
});
