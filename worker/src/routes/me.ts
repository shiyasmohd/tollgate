// The signed-in seller, and their ENS name: <handle>.<ENS_PARENT>, whose own
// subregistry their endpoints are named in (see ens.ts).

import { Hono } from "hono";
import type { BaseError } from "viem";
import { z } from "zod";
import { claimSeller, deleteSeller, getSeller, getSellerByHandle, markSellerRegistered, type SellerRow } from "../db";
import { checkLabel, claimSellerName, ensEnabled, handleAvailable } from "../ens";
import type { AppEnv } from "../types";

// A claim still "pending" after this long died mid-way; the seller may retry.
const STALE_PENDING_MS = 5 * 60 * 1000;

const view = (s: SellerRow | null) =>
  s && { handle: s.handle, ens_name: s.ens_name, registry: s.registry, status: s.status, created_at: s.created_at };

export const me = new Hono<AppEnv>();

me.get("/", async (c) => {
  const seller = await getSeller(c.env.DB, c.var.seller);
  return c.json({
    address: c.var.seller,
    name: view(seller),
    // null: the gateway doesn't name anything on ENS
    ens: ensEnabled(c.env) ? { parent: c.env.ENS_PARENT } : null,
  });
});

/** Live availability for the claim form: GET /api/me/name/check?handle=hashir */
me.get("/name/check", async (c) => {
  if (!ensEnabled(c.env)) return c.json({ error: "ens_disabled" }, 503);
  const check = checkLabel(c.req.query("handle") ?? "");
  if (!check.ok) return c.json({ available: false, reason: check.error });
  const handle = check.label;
  const name = `${handle}.${c.env.ENS_PARENT}`;
  const holder = await getSellerByHandle(c.env.DB, handle);
  if (holder && holder.address !== c.var.seller) return c.json({ handle, name, available: false, reason: "taken" });
  if (!holder && !(await handleAvailable(c.env, handle))) return c.json({ handle, name, available: false, reason: "taken" });
  return c.json({ handle, name, available: true });
});

const ClaimBody = z.object({ handle: z.string() });

/** Claims <handle>.<ENS_PARENT> for the seller. The transactions are sent, not waited for. */
me.post("/name", async (c) => {
  if (!ensEnabled(c.env)) return c.json({ error: "ens_disabled" }, 503);
  const body = ClaimBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", issues: [{ path: "handle", message: "handle is required" }] }, 400);
  const check = checkLabel(body.data.handle);
  if (!check.ok) return c.json({ error: "invalid_request", issues: [{ path: "handle", message: check.error }] }, 400);
  const handle = check.label;
  const address = c.var.seller;

  const existing = await getSeller(c.env.DB, address);
  if (existing?.status === "registered") return c.json({ error: "already_named", name: view(existing) }, 409);
  if (existing?.status === "pending" && Date.now() - existing.updated_at < STALE_PENDING_MS) {
    return c.json({ error: "in_progress", name: view(existing) }, 409);
  }
  if (!(await handleAvailable(c.env, handle))) return c.json({ error: "handle_taken" }, 409);

  const now = Date.now();
  const claimed = await claimSeller(c.env.DB, {
    address, handle, ens_name: `${handle}.${c.env.ENS_PARENT}`, registry: null, status: "pending", created_at: now, updated_at: now,
  });
  if (!claimed) return c.json({ error: "handle_taken" }, 409);

  try {
    const { registry } = await claimSellerName(c.env, address, handle);
    await markSellerRegistered(c.env.DB, address, registry);
  } catch (e) {
    console.error("ENS seller name failed", e);
    await deleteSeller(c.env.DB, address);
    return c.json({ error: "ens_failed", message: (e as BaseError).shortMessage ?? String(e) }, 502);
  }
  return c.json({ name: view(await getSeller(c.env.DB, address)) }, 201);
});
