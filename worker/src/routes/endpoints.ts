// Seller endpoint management. Every route is scoped to the signed-in seller, and
// the upstream secret is write-only: it goes in encrypted and never comes back out.

import { Hono } from "hono";
import { z } from "zod";
import { encryptSecret } from "../crypto";
import {
  getEndpointWithTotals, getOwnedEndpoint, insertEndpoint, listEndpoints, newId, toSellerEndpoint, updateEndpoint,
  type EndpointRow, type EndpointWithTotals,
} from "../db";
import { callUpstream, prepareBody } from "../proxy";
import type { AppEnv } from "../types";
import { checkUpstreamUrl } from "../url-guard";

const MAX_PRICE_ATOMIC = 100_000_000; // $100 per request

const PriceUsd = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === "number" ? v.toFixed(6) : v.trim()))
  .pipe(z.string().regex(/^\d+(\.\d{1,6})?$/, "price_usd must be a decimal with at most 6 places"))
  .transform((v) => {
    const [whole, frac = ""] = v.split(".");
    return Number(whole) * 1_000_000 + Number(frac.padEnd(6, "0"));
  })
  .pipe(z.number().int().positive("price_usd must be > 0").max(MAX_PRICE_ATOMIC, "price_usd must be <= 100"));

const JsonText = z
  .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
  .transform((v) => (typeof v === "string" ? v : JSON.stringify(v)))
  .pipe(z.string().max(65_536));

const Auth = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.enum(["header", "query"]),
    name: z.string().trim().min(1).max(100),
    // Optional on update: omitted means "keep the stored secret".
    value: z.string().min(1).max(4096).optional(),
  }),
]);

const fields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(2000),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: z.string().max(2048),
  auth: Auth,
  static_headers: z.record(z.string().min(1).max(100), z.string().max(4096))
    .refine((h) => Object.keys(h).length <= 20, "at most 20 static headers"),
  price_usd: PriceUsd,
  example_query: z.string().max(2000).transform((q) => q.replace(/^\?/, "")).nullish(),
  example_body: JsonText.nullish(),
  body_overrides: z.record(z.string(), z.unknown()).nullish(),
  max_body_bytes: z.number().int().min(0).max(1_048_576),
};

const EndpointInput = z.object({
  ...fields,
  method: fields.method.default("GET"),
  auth: fields.auth.default({ type: "none" }),
  static_headers: fields.static_headers.default({}),
  max_body_bytes: fields.max_body_bytes.default(65_536),
});

// Built from the default-free fields: Zod 4 applies defaults even inside
// .partial(), which would silently reset omitted fields on every PATCH.
const EndpointPatch = z.object(fields).partial().extend({
  status: z.enum(["active", "paused"]).optional(),
});

// Changing any of these means the last test no longer proves the endpoint works.
const RETEST_FIELDS = ["url", "method", "auth", "static_headers", "body_overrides"] as const;

function errorFrom(err: z.ZodError) {
  return { error: "invalid_request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
}

function withTotals(row: EndpointWithTotals, origin: string) {
  return { ...toSellerEndpoint(row), calls: row.calls, income_atomic: row.income_atomic, paid_url: `${origin}/x/${row.id}` };
}

export const endpoints = new Hono<AppEnv>();

endpoints.get("/", async (c) => {
  const origin = new URL(c.req.url).origin;
  const rows = await listEndpoints(c.env.DB, c.var.seller);
  return c.json({ endpoints: rows.map((r) => withTotals(r, origin)) });
});

endpoints.get("/:id", async (c) => {
  const row = await getEndpointWithTotals(c.env.DB, c.req.param("id"), c.var.seller);
  if (!row || row.status === "deleted") return c.json({ error: "not_found" }, 404);
  return c.json({ endpoint: withTotals(row, new URL(c.req.url).origin) });
});

endpoints.post("/", async (c) => {
  const parsed = EndpointInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(errorFrom(parsed.error), 400);
  const input = parsed.data;

  const url = checkUpstreamUrl(input.url, new URL(c.req.url).host);
  if (!url.ok) return c.json({ error: url.error }, 400);
  if (input.auth.type !== "none" && !input.auth.value) return c.json({ error: "auth.value is required" }, 400);

  const now = Date.now();
  const row: EndpointRow = {
    id: newId("ep"),
    owner: c.var.seller,
    name: input.name,
    description: input.description,
    method: input.method,
    url: url.url.toString(),
    auth_type: input.auth.type,
    auth_name: input.auth.type === "none" ? null : input.auth.name,
    auth_value_enc: input.auth.type !== "none" && input.auth.value ? await encryptSecret(c.env.MASTER_KEY, input.auth.value) : null,
    static_headers: JSON.stringify(input.static_headers),
    price_atomic: input.price_usd,
    example_query: input.example_query ?? null,
    example_body: input.example_body ?? null,
    body_overrides: input.body_overrides ? JSON.stringify(input.body_overrides) : null,
    max_body_bytes: input.max_body_bytes,
    status: "pending",
    created_at: now,
    updated_at: now,
  };
  await insertEndpoint(c.env.DB, row);
  const created = await getEndpointWithTotals(c.env.DB, row.id, c.var.seller);
  return c.json({ endpoint: withTotals(created!, new URL(c.req.url).origin) }, 201);
});

endpoints.patch("/:id", async (c) => {
  const existing = await getOwnedEndpoint(c.env.DB, c.req.param("id"), c.var.seller);
  if (!existing) return c.json({ error: "not_found" }, 404);
  const parsed = EndpointPatch.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(errorFrom(parsed.error), 400);
  const input = parsed.data;

  const patch: Partial<EndpointRow> = {
    name: input.name,
    description: input.description,
    method: input.method,
    price_atomic: input.price_usd,
    max_body_bytes: input.max_body_bytes,
  };
  if (input.url !== undefined) {
    const url = checkUpstreamUrl(input.url, new URL(c.req.url).host);
    if (!url.ok) return c.json({ error: url.error }, 400);
    patch.url = url.url.toString();
  }
  if (input.auth) {
    patch.auth_type = input.auth.type;
    if (input.auth.type === "none") {
      patch.auth_name = null;
      patch.auth_value_enc = null;
    } else {
      patch.auth_name = input.auth.name;
      if (input.auth.value) patch.auth_value_enc = await encryptSecret(c.env.MASTER_KEY, input.auth.value);
      else if (!existing.auth_value_enc) return c.json({ error: "auth.value is required" }, 400);
    }
  }
  if (input.static_headers) patch.static_headers = JSON.stringify(input.static_headers);
  if (input.example_query !== undefined) patch.example_query = input.example_query ?? null;
  if (input.example_body !== undefined) patch.example_body = input.example_body ?? null;
  if (input.body_overrides !== undefined) patch.body_overrides = input.body_overrides ? JSON.stringify(input.body_overrides) : null;

  const needsRetest = RETEST_FIELDS.some((f) => input[f] !== undefined);
  if (needsRetest) patch.status = "pending";
  else if (input.status) {
    if (existing.status === "pending" && input.status === "active") {
      return c.json({ error: "run POST /api/endpoints/:id/test to activate a pending endpoint" }, 409);
    }
    patch.status = input.status;
  }

  await updateEndpoint(c.env.DB, existing.id, patch);
  const updated = await getEndpointWithTotals(c.env.DB, existing.id, c.var.seller);
  return c.json({ endpoint: withTotals(updated!, new URL(c.req.url).origin), retest_required: needsRetest });
});

endpoints.delete("/:id", async (c) => {
  const existing = await getOwnedEndpoint(c.env.DB, c.req.param("id"), c.var.seller);
  if (!existing) return c.json({ error: "not_found" }, 404);
  // Soft delete keeps call history joinable; the secret is dropped immediately.
  await updateEndpoint(c.env.DB, existing.id, { status: "deleted", auth_value_enc: null });
  return c.json({ ok: true });
});

/** Calls the upstream once with the example request, unpaid. A 2xx activates a pending endpoint. */
endpoints.post("/:id/test", async (c) => {
  const ep = await getOwnedEndpoint(c.env.DB, c.req.param("id"), c.var.seller);
  if (!ep) return c.json({ error: "not_found" }, 404);

  const body = prepareBody(ep, ep.example_body);
  if (!body.ok) return c.json({ ok: false, error: `example_body: ${body.error}` }, 400);

  const started = Date.now();
  const res = await callUpstream(c.env, ep, {
    query: new URLSearchParams(ep.example_query ?? ""),
    body: body.body,
    contentType: "application/json",
  });
  const text = await res.text();
  const ok = res.status >= 200 && res.status < 300;
  const activated = ok && ep.status === "pending";
  if (activated) await updateEndpoint(c.env.DB, ep.id, { status: "active" });

  return c.json({
    ok,
    status: res.status,
    latency_ms: Date.now() - started,
    content_type: res.headers.get("content-type"),
    body: text.length > 4000 ? `${text.slice(0, 4000)}…` : text,
    activated,
    endpoint_status: activated ? "active" : ep.status,
  });
});
