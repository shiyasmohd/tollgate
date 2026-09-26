// End-to-end through the Worker with a local D1. Outbound fetches are stubbed:
// the facilitator answers /supported, api.example.com echoes, everything else
// (e.g. the Base Sepolia RPC) fails, so SIWE falls back to plain ECDSA recovery.

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BASE = "http://gateway.test";
const upstreamRequests: { headers: Headers; body: string }[] = [];

beforeEach(() => {
  upstreamRequests.length = 0;
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.href === `${env.FACILITATOR_URL}/supported`) {
      return Response.json({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: [], signers: {} });
    }
    if (url.hostname === "api.example.com") {
      const body = await req.text();
      upstreamRequests.push({ headers: req.headers, body });
      if (url.pathname === "/fail") return Response.json({ error: "boom" }, { status: 500 });
      return Response.json({ echoed: body, auth: req.headers.get("authorization") });
    }
    if (url.hostname === "gateway.test") return realFetch(input, init);
    throw new Error(`unexpected fetch ${url.href}`);
  });
});
afterEach(() => vi.restoreAllMocks());

async function login(pk = generatePrivateKey()) {
  const account = privateKeyToAccount(pk);
  const { nonce } = await (await SELF.fetch(`${BASE}/api/auth/nonce`)).json<{ nonce: string }>();
  const message = createSiweMessage({
    domain: "gateway.test", address: account.address, uri: BASE, version: "1", chainId: 84532, nonce, issuedAt: new Date(),
  });
  const res = await SELF.fetch(`${BASE}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature: await account.signMessage({ message }) }),
  });
  expect(res.status).toBe(200);
  const { token } = await res.json<{ token: string }>();
  const api = (path: string, init: RequestInit = {}) =>
    SELF.fetch(`${BASE}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init.headers },
    });
  return { account, api };
}

const echoEndpoint = {
  name: "Echo",
  description: "Echoes the body",
  method: "POST",
  url: "https://api.example.com/echo",
  auth: { type: "header", name: "Authorization", value: "Bearer sk-live-supersecret" },
  price_usd: "0.02",
  example_body: { prompt: "hi" },
  body_overrides: { max_tokens: 10 },
};

async function createActive(api: Awaited<ReturnType<typeof login>>["api"], over: object = {}) {
  const created = await api("/api/endpoints", { method: "POST", body: JSON.stringify({ ...echoEndpoint, ...over }) });
  expect(created.status).toBe(201);
  const { endpoint } = await created.json<{ endpoint: { id: string } }>();
  return endpoint.id;
}

describe("auth", () => {
  it("rejects missing and bad tokens", async () => {
    expect((await SELF.fetch(`${BASE}/api/endpoints`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/endpoints`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("rejects a reused nonce", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { nonce } = await (await SELF.fetch(`${BASE}/api/auth/nonce`)).json<{ nonce: string }>();
    const message = createSiweMessage({ domain: "gateway.test", address: account.address, uri: BASE, version: "1", chainId: 84532, nonce });
    const body = JSON.stringify({ message, signature: await account.signMessage({ message }) });
    const verify = () => SELF.fetch(`${BASE}/api/auth/verify`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect((await verify()).status).toBe(200);
    expect((await verify()).status).toBe(401);
  });

  it("rejects a message for another domain", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { nonce } = await (await SELF.fetch(`${BASE}/api/auth/nonce`)).json<{ nonce: string }>();
    const message = createSiweMessage({ domain: "evil.test", address: account.address, uri: "http://evil.test", version: "1", chainId: 84532, nonce });
    const res = await SELF.fetch(`${BASE}/api/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature: await account.signMessage({ message }) }),
    });
    expect(res.status).toBe(401);
  });
});

describe("endpoints", () => {
  it("validates input", async () => {
    const { api } = await login();
    const bad = (body: object) => api("/api/endpoints", { method: "POST", body: JSON.stringify({ ...echoEndpoint, ...body }) });
    expect((await bad({ url: "http://api.example.com/x" })).status).toBe(400);
    expect((await bad({ url: "https://10.0.0.1/x" })).status).toBe(400);
    expect((await bad({ price_usd: "0" })).status).toBe(400);
    expect((await bad({ price_usd: "0.0000001" })).status).toBe(400);
    expect((await bad({ auth: { type: "header", name: "Authorization" } })).status).toBe(400);
  });

  it("never returns the secret and scopes endpoints to their owner", async () => {
    const alice = await login();
    const bob = await login();
    const id = await createActive(alice.api);

    const text = await (await alice.api(`/api/endpoints/${id}`)).text();
    expect(text).not.toContain("supersecret");
    expect(text).not.toContain("auth_value_enc");
    expect(JSON.parse(text).endpoint).toMatchObject({ status: "pending", auth_set: true, price_usd: "0.02", price_atomic: 20_000 });

    expect((await bob.api(`/api/endpoints/${id}`)).status).toBe(404);
    expect((await bob.api(`/api/endpoints/${id}`, { method: "DELETE" })).status).toBe(404);
    const bobs = await (await bob.api("/api/endpoints")).json<{ endpoints: unknown[] }>();
    expect(bobs.endpoints).toHaveLength(0);
  });

  it("test call injects the secret, applies overrides, redacts, and activates", async () => {
    const { api } = await login();
    const id = await createActive(api);

    // pending endpoints are not for sale and can't be activated by PATCH
    expect((await SELF.fetch(`${BASE}/x/${id}`, { method: "POST" })).status).toBe(404);
    expect((await api(`/api/endpoints/${id}`, { method: "PATCH", body: '{"status":"active"}' })).status).toBe(409);

    const res = await api(`/api/endpoints/${id}/test`, { method: "POST" });
    const body = await res.json<{ ok: boolean; activated: boolean; body: string }>();
    expect(body.ok).toBe(true);
    expect(body.activated).toBe(true);
    expect(body.body).not.toContain("supersecret");
    expect(body.body).toContain("[redacted]");

    const sent = upstreamRequests[0]!;
    expect(sent.headers.get("authorization")).toBe("Bearer sk-live-supersecret");
    expect(JSON.parse(sent.body)).toEqual({ prompt: "hi", max_tokens: 10 });

    // changing the URL sends it back to pending
    const patched = await api(`/api/endpoints/${id}`, { method: "PATCH", body: '{"url":"https://api.example.com/other"}' });
    expect(await patched.json()).toMatchObject({ retest_required: true, endpoint: { status: "pending" } });
  });

  it("does not activate when the upstream fails", async () => {
    const { api } = await login();
    const id = await createActive(api, { url: "https://api.example.com/fail" });
    const body = await (await api(`/api/endpoints/${id}/test`, { method: "POST" })).json<{ ok: boolean; activated: boolean }>();
    expect(body).toMatchObject({ ok: false, activated: false });
  });
});

describe("paid route", () => {
  it("quotes the seller's price and payout address, and lists it in the catalog", async () => {
    const { account, api } = await login();
    const id = await createActive(api);
    await api(`/api/endpoints/${id}/test`, { method: "POST" });

    const res = await SELF.fetch(`${BASE}/x/${id}`, { method: "POST", body: '{"prompt":"x"}', headers: { "content-type": "application/json" } });
    expect(res.status).toBe(402);
    const required = JSON.parse(atob(res.headers.get("payment-required")!));
    expect(required.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "eip155:84532",
      amount: "20000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: account.address,
    });
    // an unpaid request never reaches the upstream
    expect(upstreamRequests).toHaveLength(1); // just the test call

    const catalog = await (await SELF.fetch(`${BASE}/catalog`)).json<{ endpoints: { id: string; url: string }[] }>();
    expect(catalog.endpoints.find((e) => e.id === id)).toMatchObject({ url: `${BASE}/x/${id}` });
    expect(JSON.stringify(catalog)).not.toContain("supersecret");
  });

  it("rejects wrong methods and oversized bodies before quoting", async () => {
    const { api } = await login();
    const id = await createActive(api, { max_body_bytes: 40 });
    await api(`/api/endpoints/${id}/test`, { method: "POST" });
    expect((await SELF.fetch(`${BASE}/x/${id}`)).status).toBe(405);
    const big = await SELF.fetch(`${BASE}/x/${id}`, { method: "POST", body: JSON.stringify({ prompt: "x".repeat(50) }) });
    expect(big.status).toBe(413);
  });

  it("stops selling paused endpoints", async () => {
    const { api } = await login();
    const id = await createActive(api);
    await api(`/api/endpoints/${id}/test`, { method: "POST" });
    await api(`/api/endpoints/${id}`, { method: "PATCH", body: '{"status":"paused"}' });
    expect((await SELF.fetch(`${BASE}/x/${id}`, { method: "POST" })).status).toBe(404);

    // a status-only PATCH must leave every other field alone
    const { endpoint } = await (await api(`/api/endpoints/${id}`)).json<{ endpoint: Record<string, unknown> }>();
    expect(endpoint).toMatchObject({ status: "paused", method: "POST", auth_type: "header", auth_set: true, max_body_bytes: 65_536 });
  });
});

describe("stats", () => {
  it("aggregates settled calls and lists them in the feed", async () => {
    const { account, api } = await login();
    const id = await createActive(api);
    const owner = account.address.toLowerCase();
    const now = Date.now();
    const insert = env.DB.prepare(
      `INSERT INTO calls (id, endpoint_id, owner, payer, amount_atomic, tx_hash, settled, upstream_status, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    await env.DB.batch([
      insert.bind("c1", id, owner, "0xaa", 20_000, "0xt1", 1, 200, 10, now - 1000),
      insert.bind("c2", id, owner, "0xbb", 20_000, "0xt2", 1, 200, 10, now - 500),
      insert.bind("c3", id, owner, null, 0, null, 0, 500, 10, now - 100),
    ]);

    const stats = await (await api("/api/stats")).json<Record<string, unknown>>();
    expect(stats).toMatchObject({ income_atomic: 40_000, income_usd: "0.04", paid_calls: 2, failed_calls: 1, unique_payers: 2 });
    expect((stats.series as unknown[]).length).toBe(24);

    const feed = await (await api(`/api/feed?since=${now - 600}`)).json<{ calls: { id: string; tx_url: string | null }[] }>();
    expect(feed.calls.map((c) => c.id)).toEqual(["c3", "c2"]);
    expect(feed.calls[1]!.tx_url).toBe("https://sepolia.basescan.org/tx/0xt2");

    const listed = await (await api("/api/endpoints")).json<{ endpoints: { calls: number; income_atomic: number }[] }>();
    expect(listed.endpoints[0]).toMatchObject({ calls: 2, income_atomic: 40_000 });
  });
});
