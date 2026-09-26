// Payment screening with Intercepta (Web3 Antivirus API, docs.web3antivirus.io).
//
// Checks the parties and the authorization of an x402 payment before money
// moves: the seller's payTo address, the token, the payer, and the EIP-712
// TransferWithAuthorization the buyer is about to sign. Payments run on Base
// Sepolia, which Intercepta doesn't cover, so addresses are screened as they are
// (they're the same keys on mainnet) and the testnet USDC contract is screened as
// its Base mainnet twin.
//
// Without INTERCEPTA_API_KEY every check is "skipped" and nothing is blocked, so
// the gateway keeps working until the key is added. With a key, an API failure
// blocks (INTERCEPTA_FAIL_MODE=closed, the default) or only warns (=open).

import { getAddress, isAddress } from "viem";

const API = "https://api.web3antivirus.io";
const TIMEOUT_MS = 4000;
const CACHE_TTL_S = 10 * 60;

/** Base Sepolia USDC → Base mainnet USDC, the contract Intercepta can score. */
const TESTNET_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const MAINNET_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SCREEN_CHAIN_ID = "8453";

// Quick-scan traits that stop a payment outright; any other trait only warns.
const BLOCK_TRAITS = new Set([
  "known_scammer",
  "sanction_address",
  "blacklist",
  "initiator_scam_transactions",
  "fake_phishing_transfer",
  "attack_money_target",
  "rug_pull",
]);
// Signature detectors that stop a payment when they flag the authorization or an address in it.
const BLOCK_DETECTORS = new Set(["KNOWN_MALICIOUS", "WALLET_DRAINER", "SCAM_ADDRESS", "POISONING_ATTACK", "INITIATOR_SCAM_TRANSACTIONS"]);

export type CheckStatus = "pass" | "warn" | "block" | "skipped";
export type CheckKind = "pay_to" | "payer" | "token" | "authorization";
export type Verdict = "allow" | "warn" | "block";

export interface Check {
  kind: CheckKind;
  label: string;
  status: CheckStatus;
  /** One line a person or an agent can read, e.g. "flagged: known_scammer". */
  reason: string;
  subject: string;
  /** Intercepta's raw signal: toxicScore, riskLevel/action, riskGroup. */
  score?: number | string | null;
  flags?: string[];
}

export interface Screening {
  verdict: Verdict;
  /** false when no API key is set: every check was skipped. */
  enabled: boolean;
  provider: "intercepta";
  checks: Check[];
  /** The first blocking reason, or a summary of the warnings. */
  summary: string;
}

/** EIP-712 typed data as viem's signTypedData receives it. */
export interface TypedData {
  domain?: Record<string, unknown>;
  types?: Record<string, unknown>;
  primaryType?: string;
  message?: Record<string, unknown>;
}

export interface ScreenRequest {
  /** Who gets paid: the 402 quote's payTo. */
  pay_to?: string;
  /** The token contract being paid: the quote's asset. */
  asset?: string;
  /** Who pays; screened when the seller is the one asking. */
  payer?: string;
  /** Exact amount in atomic units, checked against the authorization. */
  amount?: string;
  /** The TransferWithAuthorization about to be signed. */
  authorization?: TypedData;
}

export interface ScreenEnv {
  INTERCEPTA_API_KEY?: string;
  INTERCEPTA_FAIL_MODE?: string;
  INTERCEPTA_BLOCK_SCORE?: string;
}

type Fetcher = typeof fetch;

export const screeningEnabled = (env: ScreenEnv) => Boolean(env.INTERCEPTA_API_KEY?.trim());

// ---- Intercepta calls --------------------------------------------------------

interface QuickScan {
  toxicScore?: number;
  traits?: { name?: string; risk?: number; description?: string; txsCount?: number }[];
}
interface TokenRisk {
  riskScore?: number;
  riskLevel?: string;
  category?: string;
  action?: "block" | "warn" | "info";
  trust?: string;
  detectors?: ({ code?: string; description?: string } | string)[];
  token?: { symbol?: string };
}
interface MessageScan {
  riskGroup?: "Low" | "Medium" | "High";
  messageType?: string;
  detectors?: { code?: string; description?: string }[];
  addresses?: { address?: string; type?: string; detectors?: string[] }[];
}

class InterceptaError extends Error {}

async function call<T>(env: ScreenEnv, doFetch: Fetcher, path: string, init: RequestInit = {}): Promise<T> {
  const key = env.INTERCEPTA_API_KEY!.trim();
  const cacheKey = init.method === "POST" ? null : new Request(`https://intercepta.cache${path}`);
  const cache = cacheKey ? await openCache() : null;
  if (cache && cacheKey) {
    const hit = await cache.match(cacheKey).catch(() => undefined);
    if (hit) return hit.json<T>();
  }

  let res: Response;
  try {
    res = await doFetch(`${API}${path}`, {
      ...init,
      headers: { accept: "application/json", "x-api-key": key, ...(init.body ? { "content-type": "application/json" } : {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new InterceptaError(e instanceof Error && e.name === "TimeoutError" ? "Intercepta timed out" : "Intercepta unreachable");
  }
  if (!res.ok) throw new InterceptaError(`Intercepta returned ${res.status}`);
  const text = await res.text();
  if (cache && cacheKey) {
    const stored = new Response(text, { headers: { "content-type": "application/json", "cache-control": `max-age=${CACHE_TTL_S}` } });
    await cache.put(cacheKey, stored).catch(() => {});
  }
  return JSON.parse(text) as T;
}

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches === "undefined" ? null : await caches.open("intercepta");
  } catch {
    return null;
  }
}

// ---- individual checks -------------------------------------------------------

function failed(env: ScreenEnv, kind: CheckKind, label: string, subject: string, e: unknown): Check {
  const why = e instanceof InterceptaError ? e.message : "screening failed";
  const open = env.INTERCEPTA_FAIL_MODE?.trim().toLowerCase() === "open";
  return { kind, label, subject, status: open ? "warn" : "block", reason: open ? `${why}; allowed (fail-open)` : `${why}; blocked (fail-closed)` };
}

async function screenAddress(env: ScreenEnv, doFetch: Fetcher, kind: "pay_to" | "payer", address: string): Promise<Check> {
  const label = kind === "pay_to" ? "Recipient" : "Payer";
  if (!isAddress(address)) return { kind, label, subject: address, status: "block", reason: "not a valid address" };
  const subject = getAddress(address);
  try {
    const scan = await call<QuickScan>(env, doFetch, `/api/public/v2/extension/account/${subject.toLowerCase()}/quick-scan`);
    const threshold = Number(env.INTERCEPTA_BLOCK_SCORE ?? "") || 70;
    const traits = (scan.traits ?? []).map((t) => t.name).filter((n): n is string => !!n);
    const blocking = traits.filter((t) => BLOCK_TRAITS.has(t));
    const score = typeof scan.toxicScore === "number" ? scan.toxicScore : null;
    if (blocking.length || (score !== null && score >= threshold)) {
      const why = blocking.length ? `flagged ${blocking.join(", ")}` : `toxic score ${score} ≥ ${threshold}`;
      return { kind, label, subject, status: "block", reason: why, score, flags: traits };
    }
    if (traits.length) return { kind, label, subject, status: "warn", reason: `minor flags: ${traits.join(", ")}`, score, flags: traits };
    return { kind, label, subject, status: "pass", reason: score !== null ? `clean (toxic score ${score})` : "no risk found", score, flags: [] };
  } catch (e) {
    return failed(env, kind, label, subject, e);
  }
}

async function screenToken(env: ScreenEnv, doFetch: Fetcher, asset: string): Promise<Check> {
  const label = "Token";
  if (!isAddress(asset)) return { kind: "token", label, subject: asset, status: "block", reason: "not a valid token address" };
  const lower = asset.toLowerCase();
  // x402 here only ever settles in USDC; anything else is a lookalike, whatever its score.
  if (lower !== TESTNET_USDC && lower !== MAINNET_USDC) {
    return { kind: "token", label, subject: getAddress(asset), status: "block", reason: "not canonical USDC (possible lookalike token)" };
  }
  const scanned = lower === TESTNET_USDC ? MAINNET_USDC : lower;
  try {
    const risk = await call<TokenRisk>(env, doFetch, `/api/public/v2/extension/token-intelligence/token/${scanned}/risks?chainId=${SCREEN_CHAIN_ID}`);
    const flags = (risk.detectors ?? []).map((d) => (typeof d === "string" ? d : d.code)).filter((c): c is string => !!c);
    const symbol = risk.token?.symbol ?? "USDC";
    if (risk.action === "block" || risk.trust === "blocklist") {
      return { kind: "token", label, subject: getAddress(asset), status: "block", reason: `${symbol} ${risk.category ?? "flagged"}`, score: risk.riskLevel ?? null, flags };
    }
    if (risk.action === "warn") {
      return { kind: "token", label, subject: getAddress(asset), status: "warn", reason: `${symbol} ${risk.category ?? "warning"}`, score: risk.riskLevel ?? null, flags };
    }
    return { kind: "token", label, subject: getAddress(asset), status: "pass", reason: `${symbol} verified`, score: risk.riskLevel ?? null, flags };
  } catch (e) {
    return failed(env, "token", label, getAddress(asset), e);
  }
}

/**
 * Checks the TransferWithAuthorization locally (it must pay exactly the quoted
 * amount to the quoted payTo, in USDC, and expire soon), then asks Intercepta
 * about the whole typed message as it would look on Base mainnet.
 */
async function screenAuthorization(env: ScreenEnv, doFetch: Fetcher, req: ScreenRequest): Promise<Check> {
  const label = "Authorization";
  const typed = req.authorization!;
  const m = (typed.message ?? {}) as Record<string, unknown>;
  const from = String(m.from ?? "");
  const subject = `${typed.primaryType ?? "?"} → ${String(m.to ?? "?")}`;
  const block = (reason: string): Check => ({ kind: "authorization", label, subject, status: "block", reason });

  if (typed.primaryType !== "TransferWithAuthorization") return block(`unexpected ${typed.primaryType ?? "message"}, not a USDC transfer`);
  const contract = String(typed.domain?.verifyingContract ?? "").toLowerCase();
  if (contract !== TESTNET_USDC && contract !== MAINNET_USDC) return block("signs for a contract that isn't USDC");
  if (req.pay_to && String(m.to ?? "").toLowerCase() !== req.pay_to.toLowerCase()) return block("pays a different address than the quote");
  if (req.amount && String(m.value ?? "") !== req.amount) return block(`amount ${String(m.value)} differs from the quoted ${req.amount}`);
  const validBefore = Number(m.validBefore ?? 0);
  if (validBefore && validBefore - Date.now() / 1000 > 24 * 60 * 60) return block("stays valid for more than a day");
  if (!isAddress(from)) return block("no valid signer in the authorization");

  const mainnet = {
    ...typed,
    domain: { ...typed.domain, chainId: SCREEN_CHAIN_ID, verifyingContract: contract === TESTNET_USDC ? MAINNET_USDC : contract },
  };
  try {
    const scan = await call<MessageScan>(env, doFetch, "/api/public/v2/extension/analysis/signature", {
      method: "POST",
      body: JSON.stringify({ from, message: JSON.stringify(mainnet, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), chainId: SCREEN_CHAIN_ID }),
    });
    const codes = [
      ...(scan.detectors ?? []).map((d) => d.code),
      ...(scan.addresses ?? []).flatMap((a) => a.detectors ?? []),
    ].filter((c): c is string => !!c);
    const flags = [...new Set(codes)];
    const blocking = flags.filter((c) => BLOCK_DETECTORS.has(c));
    if (scan.riskGroup === "High" || blocking.length) {
      return { kind: "authorization", label, subject, status: "block", reason: `high risk${flags.length ? `: ${flags.join(", ")}` : ""}`, score: scan.riskGroup ?? null, flags };
    }
    if (scan.riskGroup === "Medium" || flags.length) {
      return { kind: "authorization", label, subject, status: "warn", reason: `medium risk${flags.length ? `: ${flags.join(", ")}` : ""}`, score: scan.riskGroup ?? null, flags };
    }
    return { kind: "authorization", label, subject, status: "pass", reason: "exact USDC transfer, low risk", score: scan.riskGroup ?? "Low", flags };
  } catch (e) {
    return failed(env, "authorization", label, subject, e);
  }
}

// ---- entry point -------------------------------------------------------------

const LABELS: Record<CheckKind, string> = { pay_to: "Recipient", payer: "Payer", token: "Token", authorization: "Authorization" };

/** Screens whatever parts of a payment the request names, in parallel. */
export async function screenPayment(env: ScreenEnv, req: ScreenRequest, doFetch: Fetcher = fetch): Promise<Screening> {
  const wanted: [CheckKind, string][] = [];
  if (req.pay_to) wanted.push(["pay_to", req.pay_to]);
  if (req.asset) wanted.push(["token", req.asset]);
  if (req.payer) wanted.push(["payer", req.payer]);
  if (req.authorization) wanted.push(["authorization", req.authorization.primaryType ?? "typed data"]);

  if (!screeningEnabled(env)) {
    const checks = wanted.map(([kind, subject]): Check => ({ kind, label: LABELS[kind], subject, status: "skipped", reason: "screening not configured" }));
    return { verdict: "allow", enabled: false, provider: "intercepta", checks, summary: "Screening is off (no Intercepta API key)." };
  }

  const checks = await Promise.all(
    wanted.map(([kind, subject]) =>
      kind === "pay_to" || kind === "payer"
        ? screenAddress(env, doFetch, kind, subject)
        : kind === "token"
          ? screenToken(env, doFetch, subject)
          : screenAuthorization(env, doFetch, req),
    ),
  );
  const blocked = checks.find((c) => c.status === "block");
  const warned = checks.filter((c) => c.status === "warn");
  const verdict: Verdict = blocked ? "block" : warned.length ? "warn" : "allow";
  const summary = blocked
    ? `${blocked.label} ${blocked.reason}`
    : warned.length
      ? warned.map((c) => `${c.label}: ${c.reason}`).join("; ")
      : "All checks passed.";
  return { verdict, enabled: true, provider: "intercepta", checks, summary };
}

/** Seller payout check: a quick-scan plus Intercepta's address-poisoning history. */
export async function screenPayout(env: ScreenEnv, address: string, doFetch: Fetcher = fetch): Promise<Screening & { poisoned: boolean | null }> {
  const base = await screenPayment(env, { pay_to: address }, doFetch);
  if (!base.enabled) return { ...base, poisoned: null };
  let poisoned: boolean | null = null;
  try {
    const p = await call<{ isPoisoned?: boolean }>(env, doFetch, `/api/public/v1/extension/poisoning-attack/user/${address.toLowerCase()}?limit=5`);
    poisoned = p.isPoisoned === true;
  } catch {
    /* the quick-scan already reported */
  }
  return { ...base, poisoned };
}
