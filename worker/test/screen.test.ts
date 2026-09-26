// Intercepta screening. screenPayment is driven with a stubbed Intercepta (a
// fake fetch per test); the routes run through the Worker, where no API key is
// configured, so they exercise the "screening off" path and the demo payee.

import { SELF } from "cloudflare:test";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import { screenPayment, type ScreenEnv } from "../src/screen";

const BASE = "http://gateway.test";
const KEY: ScreenEnv = { INTERCEPTA_API_KEY: "test-key" };
const TESTNET_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

// Each test uses its own addresses: verdicts are cached by address.
let n = 0;
const fresh = () => `0x${(++n).toString(16).padStart(4, "0")}${"ab".repeat(18)}`;

type Route = (url: URL, init?: RequestInit) => unknown | Response;
function intercepta(routes: Record<string, Route>) {
  const seen: { url: URL; init?: RequestInit }[] = [];
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url, init });
    expect(url.host).toBe("api.web3antivirus.io");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("test-key");
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.pathname.includes(pattern)) {
        const out = handler(url, init);
        return out instanceof Response ? out : Response.json(out);
      }
    }
    return Response.json({ error: "no route" }, { status: 404 });
  }) as typeof fetch;
  return { doFetch, seen };
}

const cleanToken = { "token-intelligence": () => ({ action: "info", riskLevel: "neutral", trust: "whitelist", token: { symbol: "USDC" } }) };

function authorization(to: string, value = "10000", overrides: Record<string, unknown> = {}) {
  return {
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: TESTNET_USDC },
    types: { TransferWithAuthorization: [] },
    primaryType: "TransferWithAuthorization",
    message: {
      from: fresh(),
      to,
      value,
      validAfter: "0",
      validBefore: String(Math.floor(Date.now() / 1000) + 300),
      nonce: `0x${"00".repeat(32)}`,
      ...overrides,
    },
  };
}

describe("screenPayment", () => {
  it("allows a clean recipient, real USDC and an exact authorization", async () => {
    const payTo = fresh();
    const { doFetch, seen } = intercepta({
      "quick-scan": () => ({ toxicScore: 3, traits: [] }),
      ...cleanToken,
      "analysis/signature": () => ({ riskGroup: "Low", detectors: [], addresses: [] }),
    });
    const r = await screenPayment(KEY, { pay_to: payTo, asset: TESTNET_USDC, amount: "10000", authorization: authorization(payTo) }, doFetch);
    expect(r.verdict).toBe("allow");
    expect(r.checks.map((c) => [c.kind, c.status])).toEqual([["pay_to", "pass"], ["token", "pass"], ["authorization", "pass"]]);

    // Testnet USDC is screened as Base mainnet USDC, and the signature as it would read on Base.
    const token = seen.find((s) => s.url.pathname.includes("token-intelligence"))!;
    expect(token.url.pathname).toContain("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(token.url.searchParams.get("chainId")).toBe("8453");
    const sig = seen.find((s) => s.url.pathname.includes("signature"))!;
    const sent = JSON.parse(String(sig.init?.body)) as { message: string; chainId: string };
    expect(sent.chainId).toBe("8453");
    expect(JSON.parse(sent.message).domain).toMatchObject({ chainId: "8453", verifyingContract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" });
  });

  it("blocks a recipient Intercepta flags, with the trait as the reason", async () => {
    const { doFetch } = intercepta({
      "quick-scan": () => ({ toxicScore: 95, traits: [{ name: "sanction_address", risk: 100 }, { name: "mixer_transfers", risk: 40 }] }),
    });
    const r = await screenPayment(KEY, { pay_to: fresh() }, doFetch);
    expect(r.verdict).toBe("block");
    expect(r.summary).toBe("Recipient flagged sanction_address");
    expect(r.checks[0]!.flags).toEqual(["sanction_address", "mixer_transfers"]);
  });

  it("blocks on a high toxic score and only warns on minor traits", async () => {
    const high = intercepta({ "quick-scan": () => ({ toxicScore: 80, traits: [] }) });
    expect((await screenPayment(KEY, { pay_to: fresh() }, high.doFetch)).summary).toBe("Recipient toxic score 80 ≥ 70");
    const minor = intercepta({ "quick-scan": () => ({ toxicScore: 20, traits: [{ name: "non_kyc_transfers" }] }) });
    expect((await screenPayment(KEY, { pay_to: fresh() }, minor.doFetch)).verdict).toBe("warn");
    const strict = intercepta({ "quick-scan": () => ({ toxicScore: 20, traits: [] }) });
    expect((await screenPayment({ ...KEY, INTERCEPTA_BLOCK_SCORE: "10" }, { pay_to: fresh() }, strict.doFetch)).verdict).toBe("block");
  });

  it("blocks a lookalike token without asking Intercepta", async () => {
    const { doFetch, seen } = intercepta({});
    const r = await screenPayment(KEY, { asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7f" }, doFetch);
    expect(r.verdict).toBe("block");
    expect(r.summary).toContain("not canonical USDC");
    expect(seen).toHaveLength(0);
  });

  it("blocks authorizations that don't match the quote", async () => {
    const payTo = fresh();
    const { doFetch } = intercepta({ "analysis/signature": () => ({ riskGroup: "Low" }) });
    const other = await screenPayment(KEY, { pay_to: payTo, authorization: authorization(fresh()) }, doFetch);
    expect(other.checks.find((c) => c.kind === "authorization")!.reason).toBe("pays a different address than the quote");
    const more = await screenPayment(KEY, { pay_to: payTo, amount: "10000", authorization: authorization(payTo, "999999") }, doFetch);
    expect(more.checks.find((c) => c.kind === "authorization")!.reason).toContain("differs from the quoted 10000");
    const permit = await screenPayment(KEY, { authorization: { ...authorization(payTo), primaryType: "Permit" } }, doFetch);
    expect(permit.summary).toContain("not a USDC transfer");
  });

  it("blocks an authorization Intercepta rates high risk", async () => {
    const payTo = fresh();
    const { doFetch } = intercepta({
      "quick-scan": () => ({ toxicScore: 0, traits: [] }),
      "analysis/signature": () => ({ riskGroup: "High", detectors: [{ code: "SCAM_ADDRESS" }], addresses: [{ address: payTo, detectors: ["WALLET_DRAINER"] }] }),
    });
    const r = await screenPayment(KEY, { pay_to: payTo, authorization: authorization(payTo) }, doFetch);
    expect(r.verdict).toBe("block");
    expect(r.summary).toBe("Authorization high risk: SCAM_ADDRESS, WALLET_DRAINER");
  });

  it("fails closed by default and open when configured", async () => {
    const down = intercepta({ "quick-scan": () => new Response("upstream down", { status: 503 }) });
    const closed = await screenPayment(KEY, { pay_to: fresh() }, down.doFetch);
    expect(closed.verdict).toBe("block");
    expect(closed.summary).toBe("Recipient Intercepta returned 503; blocked (fail-closed)");
    const open = await screenPayment({ ...KEY, INTERCEPTA_FAIL_MODE: "open" }, { pay_to: fresh() }, down.doFetch);
    expect(open.verdict).toBe("warn");
  });

  it("skips every check without an API key", async () => {
    const { doFetch, seen } = intercepta({});
    const r = await screenPayment({}, { pay_to: fresh(), asset: TESTNET_USDC }, doFetch);
    expect(r).toMatchObject({ verdict: "allow", enabled: false });
    expect(r.checks.every((c) => c.status === "skipped")).toBe(true);
    expect(seen).toHaveLength(0);
  });
});

describe("screen routes", () => {
  it("POST /screen validates and reports screening off without a key", async () => {
    const post = (body: unknown) =>
      SELF.fetch(`${BASE}/screen`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ pay_to: "nope" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    const res = await post({ pay_to: fresh() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ verdict: "allow", enabled: false, checks: [{ kind: "pay_to", status: "skipped" }] });
  });

  it("GET /demo/rogue quotes a flagged payee and never settles", async () => {
    const res = await SELF.fetch(`${BASE}/demo/rogue`);
    expect(res.status).toBe(402);
    const quote = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    expect(quote.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:84532", amount: "10000", payTo: "0x098B716B8Aaf21512996dC57EB0615e2383E2f96" });

    const lookalike = decodePaymentRequiredHeader((await SELF.fetch(`${BASE}/demo/rogue?token=lookalike`)).headers.get("payment-required")!);
    expect(lookalike.accepts[0]!.asset).toBe("0x036cbd53842c5426634e7929541ec2318f3dcf7f");

    const retried = await SELF.fetch(`${BASE}/demo/rogue`, { headers: { "payment-signature": "anything" } });
    expect(retried.status).toBe(402);
    expect(decodePaymentRequiredHeader(retried.headers.get("payment-required")!).error).toBe("this demo payee never settles");
  });

  it("seller screening routes need a session", async () => {
    expect((await SELF.fetch(`${BASE}/api/screenings`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/screen/payout`)).status).toBe(401);
  });
});
