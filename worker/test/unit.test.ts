import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/crypto";
import { atomicToUsd, type EndpointRow } from "../src/db";
import { checkLabel, slug } from "../src/ens";
import { prepareBody } from "../src/proxy";
import { checkUpstreamUrl } from "../src/url-guard";

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

describe("crypto", () => {
  it("round-trips and uses a fresh IV each time", async () => {
    const a = await encryptSecret(KEY, "Bearer sk-abc");
    const b = await encryptSecret(KEY, "Bearer sk-abc");
    expect(a).not.toBe(b);
    expect(a).not.toContain("sk-abc");
    expect(await decryptSecret(KEY, a)).toBe("Bearer sk-abc");
  });

  it("rejects tampered ciphertext", async () => {
    const enc = await encryptSecret(KEY, "secret");
    const bytes = Uint8Array.from(atob(enc.slice(3)), (c) => c.charCodeAt(0));
    bytes[bytes.length - 1]! ^= 1;
    await expect(decryptSecret(KEY, `v1:${btoa(String.fromCharCode(...bytes))}`)).rejects.toThrow();
  });
});

describe("checkUpstreamUrl", () => {
  it.each([
    ["https://api.openai.com/v1/chat/completions", true],
    ["http://api.openai.com/v1", false],
    ["https://127.0.0.1/x", false],
    ["https://[::1]/x", false],
    ["https://localhost/x", false],
    ["https://metadata.internal/x", false],
    ["https://intranet/x", false],
    ["https://user:pw@api.example.com/", false],
    ["https://gateway.example.com/x/ep_1", false],
    ["not a url", false],
  ])("%s → %s", (url, ok) => {
    expect(checkUpstreamUrl(url, "gateway.example.com").ok).toBe(ok);
  });
});

describe("ENS labels", () => {
  it("accepts handles and endpoint labels", () => {
    expect(checkLabel("hashir")).toEqual({ ok: true, label: "hashir" });
    expect(checkLabel("  ElevenLabs ")).toEqual({ ok: true, label: "elevenlabs" });
    expect(checkLabel("kling-2-5")).toEqual({ ok: true, label: "kling-2-5" });
  });

  it("rejects bad, short, long and reserved ones", () => {
    for (const bad of ["ab", "a".repeat(33), "-lead", "trail-", "dou--ble", "has space", "émoji", "under_score"]) {
      expect(checkLabel(bad).ok, bad).toBe(false);
    }
    expect(checkLabel("admin")).toEqual({ ok: false, error: 'handle "admin" is reserved' });
    expect(checkLabel("x", "ens_label")).toMatchObject({ ok: false, error: "ens_label must be 3 to 32 characters" });
  });

  it("slugs endpoint names the same way as before", () => {
    expect(slug("ElevenLabs voice (George)")).toBe("elevenlabs-voice-george");
    expect(slug("  Weather API!! ")).toBe("weather-api");
  });
});

describe("atomicToUsd", () => {
  it.each([
    [1, "0.000001"],
    [10_000, "0.01"],
    [1_000_000, "1"],
    [1_250_000, "1.25"],
  ])("%i → %s", (atomic, usd) => expect(atomicToUsd(atomic)).toBe(usd));
});

describe("prepareBody", () => {
  const ep = (over: Partial<EndpointRow>) => ({ method: "POST", max_body_bytes: 100, body_overrides: null, ...over }) as EndpointRow;

  it("drops the body for GET", () => {
    expect(prepareBody(ep({ method: "GET" }), "ignored")).toEqual({ ok: true, body: null });
  });

  it("passes the body through without overrides", () => {
    expect(prepareBody(ep({}), "raw text")).toEqual({ ok: true, body: "raw text" });
  });

  it("enforces max_body_bytes", () => {
    expect(prepareBody(ep({ max_body_bytes: 3 }), "four")).toMatchObject({ ok: false, status: 413 });
  });

  it("shallow-merges overrides, seller wins", () => {
    const r = prepareBody(ep({ body_overrides: '{"max_tokens":50,"stream":false}' }), '{"max_tokens":99999,"prompt":"x"}');
    expect(r.ok && JSON.parse(r.body!)).toEqual({ max_tokens: 50, prompt: "x", stream: false });
  });

  it("applies overrides to an empty body", () => {
    const r = prepareBody(ep({ body_overrides: '{"n":1}' }), "");
    expect(r.ok && JSON.parse(r.body!)).toEqual({ n: 1 });
  });

  it("rejects non-object JSON when overrides are set", () => {
    expect(prepareBody(ep({ body_overrides: '{"n":1}' }), "[1,2]")).toMatchObject({ ok: false, status: 400 });
    expect(prepareBody(ep({ body_overrides: '{"n":1}' }), "nope")).toMatchObject({ ok: false, status: 400 });
  });
});
