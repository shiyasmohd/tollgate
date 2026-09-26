// Onchain verification with MultiBaas. The pure pieces (webhook signature and
// parsing, the event query, reconciliation, actions) are driven directly; the
// routes run through the Worker with MultiBaas stubbed at https://multibaas.test.

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getAddress } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildActions, type ActionInput } from "../src/actions";
import type { SettledCallRow, TransferRow } from "../src/db";
import { queryTransfersTo, transfersFromWebhook, verifyWebhook } from "../src/multibaas";
import { CONFIRM_GRACE_MS, reconcile, verifyCall } from "../src/reconcile";

const BASE = "http://gateway.test";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SECRET = "test-webhook-secret";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const enc = new TextEncoder();

async function sign(body: string, timestamp: number, secret = SECRET) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body + timestamp)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** One event.emitted delivery item, shaped like the MultiBaas webhook docs. */
function transferEvent(o: { tx: string; from: string; to: string; value: string; contract?: string; name?: string; block?: number }) {
  return {
    id: crypto.randomUUID(),
    event: "event.emitted",
    data: {
      triggeredAt: "2026-09-27T10:00:00+09:00",
      event: {
        name: o.name ?? "Transfer",
        signature: "Transfer(address,address,uint256)",
        inputs: [
          { name: "from", value: o.from, hashed: false, type: "address" },
          { name: "to", value: o.to, hashed: false, type: "address" },
          { name: "value", value: o.value, hashed: false, type: "uint256" },
        ],
        contract: { address: o.contract ?? USDC, addressLabel: "usdc", name: "FiatTokenV2_2", label: "usdc" },
        indexInLog: 0,
      },
      transaction: { from: o.from, txHash: o.tx, blockNumber: o.block ?? 100, txIndexInBlock: 0 },
    },
  };
}

describe("webhook signature", () => {
  const now = 1_790_000_000_000;
  const ts = String(now / 1000);

  it("accepts the HMAC of body + timestamp and rejects anything else", async () => {
    const body = '[{"id":"1"}]';
    const sig = await sign(body, now / 1000);
    expect(await verifyWebhook(SECRET, enc.encode(body), sig, ts, now)).toBe(true);
    expect(await verifyWebhook(SECRET, enc.encode(body), sig.toUpperCase(), ts, now)).toBe(true);
    expect(await verifyWebhook(SECRET, enc.encode('[{"id":"2"}]'), sig, ts, now)).toBe(false); // tampered body
    expect(await verifyWebhook("other-secret", enc.encode(body), sig, ts, now)).toBe(false);
    expect(await verifyWebhook(SECRET, enc.encode(body), sig, String(now / 1000 + 1), now)).toBe(false); // timestamp not signed
    expect(await verifyWebhook(SECRET, enc.encode(body), undefined, ts, now)).toBe(false);
    expect(await verifyWebhook("", enc.encode(body), sig, ts, now)).toBe(false);
  });

  it("rejects stale timestamps so captured deliveries can't be replayed", async () => {
    const body = "[]";
    const old = now / 1000 - 6 * 60;
    expect(await verifyWebhook(SECRET, enc.encode(body), await sign(body, old), String(old), now)).toBe(false);
  });
});

describe("webhook parsing", () => {
  const payer = "0x1111111111111111111111111111111111111111";
  const seller = "0xAbCdEf0000000000000000000000000000000001";

  it("keeps well-formed USDC Transfers, lowercased, and skips everything else", () => {
    const parsed = transfersFromWebhook(
      [
        transferEvent({ tx: hash(1).toUpperCase().replace("0X", "0x"), from: payer, to: seller, value: "20000", block: 42 }),
        transferEvent({ tx: hash(2), from: payer, to: seller, value: "1", contract: "0x2222222222222222222222222222222222222222" }),
        transferEvent({ tx: hash(3), from: payer, to: seller, value: "1", name: "Approval" }),
        transferEvent({ tx: hash(4), from: payer, to: seller, value: "0.02" }), // a type conversion: not atomic
        transferEvent({ tx: "0xnothash", from: payer, to: seller, value: "1" }),
        { id: "x", event: "transaction.included", data: {} },
        null,
      ],
      USDC.toLowerCase(),
    );
    expect(parsed).toEqual([
      {
        tx_hash: hash(1),
        owner: seller.toLowerCase(),
        sender: payer,
        amount_atomic: 20_000,
        block_number: 42,
        block_time: Date.parse("2026-09-27T10:00:00+09:00"),
      },
    ]);
    expect(transfersFromWebhook({ not: "an array" }, USDC.toLowerCase())).toEqual([]);
  });
});

describe("event query", () => {
  const seller = "0xabcdef0000000000000000000000000000000001";

  it("asks MultiBaas for USDC transfers to the seller and parses the rows", async () => {
    let sent: { url: string; init: RequestInit } | null = null;
    const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent = { url: String(input), init: init! };
      return Response.json({
        status: 200,
        message: "success",
        result: {
          rows: [
            { txhash: hash(9), sender: "0x1111111111111111111111111111111111111111", recipient: "0xABCDEF0000000000000000000000000000000001", amount: "5000", block: 7, timestamp: "2026-09-27T01:00:00Z" },
            { txhash: hash(10), sender: "0x1111111111111111111111111111111111111111", recipient: "0x9999999999999999999999999999999999999999", amount: "1", block: 8, timestamp: "2026-09-27T01:00:00Z" },
            { txhash: "bad", sender: "x", recipient: "y", amount: "z" },
          ],
        },
      });
    }) as typeof fetch;

    const rows = await queryTransfersTo({ MULTIBAAS_URL: "https://mb.example/", MULTIBAAS_API_KEY: "k" }, seller, 50, doFetch);
    expect(rows).toEqual([
      { tx_hash: hash(9), owner: seller, sender: "0x1111111111111111111111111111111111111111", amount_atomic: 5000, block_number: 7, block_time: Date.parse("2026-09-27T01:00:00Z") },
    ]);
    expect(sent!.url).toBe("https://mb.example/api/v0/queries?offset=0&limit=50");
    expect(new Headers(sent!.init.headers).get("authorization")).toBe("Bearer k");
    const query = JSON.parse(String(sent!.init.body));
    expect(query.events[0]).toMatchObject({
      eventName: "Transfer",
      filter: {
        rule: "and",
        children: [
          { fieldType: "contract_address_alias", operator: "equal", value: "usdc" },
          { fieldType: "input", inputIndex: 1, operator: "equal", value: seller.toLowerCase() },
        ],
      },
    });
  });

  it("pages through results 50 at a time, stopping at the limit or the last page", async () => {
    const env = { MULTIBAAS_URL: "https://mb.example", MULTIBAAS_API_KEY: "k" };
    const row = (i: number) => ({ txhash: hash(i), sender: "0x1111111111111111111111111111111111111111", recipient: seller, amount: "1", block: i, timestamp: "2026-09-27T01:00:00Z" });
    const pages = (total: number) => {
      const urls: string[] = [];
      const doFetch = (async (input: RequestInfo | URL) => {
        const u = new URL(String(input));
        urls.push(`${u.searchParams.get("offset")}/${u.searchParams.get("limit")}`);
        const offset = Number(u.searchParams.get("offset"));
        const n = Math.max(0, Math.min(Number(u.searchParams.get("limit")), total - offset));
        return Response.json({ status: 200, message: "success", result: { rows: Array.from({ length: n }, (_, k) => row(offset + k + 1)) } });
      }) as typeof fetch;
      return { urls, doFetch };
    };

    const many = pages(1000);
    expect(await queryTransfersTo(env, seller, 120, many.doFetch)).toHaveLength(120);
    expect(many.urls).toEqual(["0/50", "50/50", "100/20"]);

    const few = pages(60);
    expect(await queryTransfersTo(env, seller, 500, few.doFetch)).toHaveLength(60);
    expect(few.urls).toEqual(["0/50", "50/50"]);
  });

  it("throws when MultiBaas is off or fails, with its reason", async () => {
    await expect(queryTransfersTo({}, seller)).rejects.toThrow("not configured");
    const env = { MULTIBAAS_URL: "https://mb.example", MULTIBAAS_API_KEY: "k" };
    const down = (async () => new Response("nope", { status: 502 })) as typeof fetch;
    await expect(queryTransfersTo(env, seller, 50, down)).rejects.toThrow("HTTP 502");
    const rejected = (async () => Response.json({ status: 400, message: "invalid request" }, { status: 400 })) as typeof fetch;
    await expect(queryTransfersTo(env, seller, 50, rejected)).rejects.toThrow("MultiBaas event query failed: HTTP 400 (invalid request)");
  });
});

describe("reconciliation", () => {
  const now = 1_790_000_000_000;
  const ctx = { enabled: true, syncFrom: now - 60 * 60 * 1000, now };
  const call = (id: string, o: Partial<SettledCallRow>): SettledCallRow => ({
    id,
    endpoint_id: "ep_1",
    endpoint_name: "Echo",
    payer: "0xaa",
    amount_atomic: 10_000,
    tx_hash: hash(Number(id.slice(1))),
    settled: 1,
    created_at: now - 10 * 60 * 1000,
    onchain_amount: null,
    onchain_block: null,
    ...o,
  });

  it("classifies each settled call against the chain", () => {
    expect(verifyCall(call("c1", { onchain_amount: 10_000 }), ctx)).toBe("verified");
    expect(verifyCall(call("c1", { onchain_amount: 9_000 }), ctx)).toBe("mismatch");
    expect(verifyCall(call("c1", { created_at: now - CONFIRM_GRACE_MS + 1 }), ctx)).toBe("confirming");
    expect(verifyCall(call("c1", { created_at: now - CONFIRM_GRACE_MS }), ctx)).toBe("unverified");
    expect(verifyCall(call("c1", { created_at: ctx.syncFrom - 1 }), ctx)).toBe("untracked");
    expect(verifyCall(call("c1", { created_at: ctx.syncFrom - 1, onchain_amount: 10_000 }), ctx)).toBe("verified");
    expect(verifyCall(call("c1", { settled: 0 }), ctx)).toBeNull();
    expect(verifyCall(call("c1", {}), { ...ctx, enabled: false })).toBeNull();
  });

  it("totals recorded vs onchain income and separates external transfers", () => {
    const t = (n: number, amount: number, known: number, sender = "0xaa"): TransferRow & { known: number } => ({
      tx_hash: hash(n), owner: "0xseller", sender, amount_atomic: amount, block_number: 100 + n, block_time: now, known,
    });
    const r = reconcile(
      [
        call("c1", { onchain_amount: 10_000 }),
        call("c2", { onchain_amount: 10_000 }),
        call("c3", {}), // unverified
        call("c4", { onchain_amount: 5_000 }), // mismatch
        call("c5", { created_at: now - 1000 }), // confirming
      ],
      [t(1, 10_000, 1), t(2, 10_000, 1), t(4, 5_000, 1), t(8, 250_000, 0, "0xbb")],
      ctx,
    );
    expect(r).toMatchObject({
      recorded_atomic: 50_000,
      onchain_atomic: 275_000,
      verified_atomic: 20_000,
      verified_pct: 50,
      counts: { verified: 2, mismatch: 1, unverified: 1, confirming: 1, untracked: 0 },
      external_usd: "0.25",
      last_block: { number: 108 },
    });
    expect(r.unverified.map((u) => u.call_id)).toEqual(["c3"]);
    expect(r.mismatched[0]).toMatchObject({ call_id: "c4", recorded_usd: "0.01", onchain_usd: "0.005" });
    expect(r.external).toMatchObject([{ tx_hash: hash(8), from: "0xbb", amount_usd: "0.25" }]);
    expect(r.top_payers[0]).toMatchObject({ payer: "0xbb", amount_usd: "0.25", transfers: 1 });
  });
});

describe("actions", () => {
  const base: ActionInput = {
    owner: "0xseller",
    reconciliation: null,
    verificationError: null,
    endpoints: [],
    blocked: { blocked_payments: 0, blocked_atomic: 0 },
    repeatBlocked: [],
    payers: [],
  };
  const withUnverified = () =>
    reconcile(
      [{ id: "c1", endpoint_id: "e", endpoint_name: "Echo", payer: "0xaa", amount_atomic: 10_000, tx_hash: hash(1), settled: 1, created_at: 0, onchain_amount: null, onchain_block: null }],
      [{ tx_hash: hash(5), owner: "0xseller", sender: "0xcc", amount_atomic: 1_000_000, block_number: 1, block_time: 0, known: 0 }],
      { enabled: true, syncFrom: 0, now: 10 * 60 * 1000 },
    );

  it("puts payments the chain doesn't back first, then losses, then information", () => {
    const actions = buildActions({
      ...base,
      reconciliation: withUnverified(),
      endpoints: [
        { id: "ep_bad", name: "Weather", status: "active", paid: 6, failed: 4 },
        { id: "ep_ok", name: "Quotes", status: "active", paid: 20, failed: 1 },
        { id: "ep_new", name: "OCR", status: "pending", paid: 0, failed: 0 },
      ],
      blocked: { blocked_payments: 3, blocked_atomic: 30_000 },
      repeatBlocked: [{ payer: "0x098b716b8aaf21512996dc57eb0615e2383e2f96", n: 3 }],
      payers: [
        { payer: "0xaaaa000000000000000000000000000000000001", income_atomic: 90_000, calls: 9 },
        { payer: "0xbbbb000000000000000000000000000000000002", income_atomic: 10_000, calls: 1 },
      ],
    });
    expect(actions.map((a) => a.id)).toEqual(["unverified", "failing:ep_bad", "pending:ep_new", "blocked", "external", "concentration"]);
    expect(actions[0]).toMatchObject({ severity: "critical", title: "1 payment not found onchain", cta: { href: "/payments?verification=unverified" } });
    expect(actions[1]!.title).toBe("Weather is failing 40% of calls");
    expect(actions[3]!.detail).toContain("0x098b…2f96 was blocked 3 times");
    expect(actions[4]).toMatchObject({ title: "$1 received outside Tollgate", severity: "info" });
    expect(actions[5]!.title).toBe("One buyer brings 90% of income");
  });

  it("doesn't cry wolf: no unverified alarm while MultiBaas is unreachable, no concentration with one buyer", () => {
    const actions = buildActions({
      ...base,
      reconciliation: withUnverified(),
      verificationError: "HTTP 502",
      payers: [{ payer: "0xaaaa000000000000000000000000000000000001", income_atomic: 90_000, calls: 9 }],
    });
    expect(actions.map((a) => a.id)).toEqual(["external", "verification_paused"]);
    expect(buildActions(base)).toEqual([]);
  });
});

// ---- through the Worker ----------------------------------------------------------

let multibaasRows: Record<string, unknown>[] = [];
let multibaasDown = false;

beforeEach(() => {
  multibaasRows = [];
  multibaasDown = false;
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname === "multibaas.test") {
      expect(req.headers.get("authorization")).toBe("Bearer test-mb-key");
      if (multibaasDown) return new Response("bad gateway", { status: 502 });
      return Response.json({ status: 200, message: "success", result: { rows: multibaasRows } });
    }
    if (url.hostname === "gateway.test") return realFetch(input, init);
    throw new Error(`unexpected fetch ${url.href}`);
  });
});
afterEach(() => vi.restoreAllMocks());

async function seller() {
  const account = privateKeyToAccount(generatePrivateKey());
  const { nonce } = await (await SELF.fetch(`${BASE}/api/auth/nonce`)).json<{ nonce: string }>();
  const message = createSiweMessage({
    domain: "gateway.test", address: account.address, uri: BASE, version: "1", chainId: 84532, nonce, issuedAt: new Date(),
  });
  const res = await SELF.fetch(`${BASE}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature: await account.signMessage({ message }) }),
  });
  const { token } = await res.json<{ token: string }>();
  const owner = account.address.toLowerCase();
  const endpointId = `ep_${owner.slice(2, 10)}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO endpoints (id, owner, name, description, method, url, auth_type, price_atomic, status, created_at, updated_at)
     VALUES (?, ?, 'Echo', 'Echoes', 'POST', 'https://api.example.com/echo', 'none', 10000, 'active', ?, ?)`,
  )
    .bind(endpointId, owner, now, now)
    .run();
  const api = (path: string) => SELF.fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { account, owner, endpointId, api };
}

async function postWebhook(body: string, secret = SECRET) {
  const ts = Math.floor(Date.now() / 1000);
  return SELF.fetch(`${BASE}/hooks/multibaas`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-multibaas-signature": await sign(body, ts, secret), "x-multibaas-timestamp": String(ts) },
    body,
  });
}

async function insertCalls(endpointId: string, owner: string, rows: [id: string, tx: string, amount: number, ageMs: number][]) {
  const insert = env.DB.prepare(
    `INSERT INTO calls (id, endpoint_id, owner, payer, amount_atomic, tx_hash, settled, upstream_status, latency_ms, created_at)
     VALUES (?, ?, ?, '0x1111111111111111111111111111111111111111', ?, ?, 1, 200, 10, ?)`,
  );
  const now = Date.now();
  await env.DB.batch(rows.map(([id, tx, amount, age]) => insert.bind(id, endpointId, owner, amount, tx, now - age)));
}

describe("onchain routes", () => {
  it("stores signed webhook transfers into sellers' payout addresses, once each", async () => {
    const { account, owner } = await seller();
    const payer = "0x1111111111111111111111111111111111111111";
    const body = JSON.stringify([
      transferEvent({ tx: hash(101), from: payer, to: account.address, value: "10000" }),
      transferEvent({ tx: hash(102), from: payer, to: "0x9999999999999999999999999999999999999999", value: "10000" }), // not a seller
      transferEvent({ tx: hash(103), from: payer, to: account.address, value: "10000", contract: "0x2222222222222222222222222222222222222222" }),
    ]);

    expect((await postWebhook(body, "wrong-secret")).status).toBe(401);
    const res = await postWebhook(body);
    expect(await res.json()).toEqual({ received: 3, stored: 1 });
    await postWebhook(body); // MultiBaas retries: still one row

    const rows = await env.DB.prepare("SELECT tx_hash, owner, amount_atomic, source FROM onchain_transfers WHERE owner = ?").bind(owner).all();
    expect(rows.results).toEqual([{ tx_hash: hash(101), owner, amount_atomic: 10_000, source: "webhook" }]);
  });

  it("reconciles recorded calls against webhook and backfilled transfers", async () => {
    const { account, owner, endpointId, api } = await seller();
    const payer = "0x1111111111111111111111111111111111111111";
    await insertCalls(endpointId, owner, [
      ["cA", hash(201), 10_000, 10 * 60_000], // webhook confirms it
      ["cB", hash(202), 10_000, 10 * 60_000], // never lands: unverified
      ["cC", hash(203), 10_000, 30_000], // too new to judge
      ["cD", hash(204), 10_000, 10 * 60_000], // backfill finds a different amount
    ]);
    await postWebhook(JSON.stringify([transferEvent({ tx: hash(201), from: payer, to: account.address, value: "10000" })]));
    multibaasRows = [
      { txhash: hash(204), sender: payer, recipient: account.address, amount: "5000", block: 300, timestamp: new Date().toISOString() },
      { txhash: hash(299), sender: "0x3333333333333333333333333333333333333333", recipient: account.address, amount: "1000000", block: 301, timestamp: new Date().toISOString() },
    ];

    const r = await (await api("/api/reconcile")).json<Record<string, unknown>>();
    expect(r).toMatchObject({
      provider: "multibaas",
      enabled: true,
      status: "ok",
      recorded_usd: "0.04",
      verified_usd: "0.01",
      counts: { verified: 1, mismatch: 1, unverified: 1, confirming: 1 },
      external_usd: "1",
      last_block: { number: 301 },
    });

    const feed = await (await api("/api/feed?verification=unverified")).json<{ calls: { id: string; verification: string }[] }>();
    expect(Object.fromEntries(feed.calls.map((c) => [c.id, c.verification]))).toEqual({ cB: "unverified", cD: "mismatch" });
    const all = await (await api("/api/feed")).json<{ calls: { id: string; verification: string; onchain_block: number | null }[] }>();
    expect(Object.fromEntries(all.calls.map((c) => [c.id, c.verification]))).toEqual({ cA: "verified", cB: "unverified", cC: "confirming", cD: "mismatch" });

    const { actions, verification } = await (await api("/api/actions")).json<{ actions: { id: string }[]; verification: string }>();
    expect(verification).toBe("ok");
    expect(actions.map((a) => a.id)).toEqual(["unverified", "mismatch", "external"]);
  });

  it("degrades instead of raising false alarms when MultiBaas is down", async () => {
    const { owner, endpointId, api } = await seller();
    await insertCalls(endpointId, owner, [["cX", hash(401), 10_000, 10 * 60_000]]);
    multibaasDown = true;

    const r = await (await api("/api/reconcile")).json<Record<string, unknown>>();
    expect(r).toMatchObject({ status: "degraded", error: "MultiBaas event query failed: HTTP 502" });
    const { actions, verification } = await (await api("/api/actions")).json<{ actions: { id: string }[]; verification: string }>();
    expect(verification).toBe("degraded");
    expect(actions.map((a) => a.id)).toEqual(["verification_paused"]);
  });
});
