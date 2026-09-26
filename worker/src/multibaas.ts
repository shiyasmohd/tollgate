// Onchain verification with Curvegrid MultiBaas (docs.curvegrid.com/multibaas).
//
// The gateway records a call as settled when the facilitator says so. MultiBaas
// indexes the USDC contract on Base Sepolia, so each of those settlements can be
// checked against the chain: an x402 settlement is a USDC Transfer from the payer
// to the seller's payTo, in the transaction the facilitator reported.
//
// Transfers reach the gateway two ways. MultiBaas pushes each one to
// POST /hooks/multibaas (its event.emitted webhook, HMAC-signed), and
// /api/reconcile backfills a seller's recent transfers with an ad hoc event query,
// in case a webhook was missed.
//
// Without MULTIBAAS_URL and MULTIBAAS_API_KEY nothing is verified and the
// dashboard shows no onchain state; the gateway works exactly as before.

import { isAddress } from "viem";

export interface MultiBaasEnv {
  MULTIBAAS_URL?: string;
  MULTIBAAS_API_KEY?: string;
  MULTIBAAS_WEBHOOK_SECRET?: string;
  /** When MultiBaas started syncing USDC events (ms or ISO date). Older calls can't be checked. */
  MULTIBAAS_SYNC_FROM?: string;
  USDC_ADDRESS?: string;
}

type Fetcher = typeof fetch;

const TIMEOUT_MS = 5000;
/** MultiBaas returns at most this many rows per query page; a larger limit is a 400 "invalid request". */
const PAGE_SIZE = 50;
const WEBHOOK_TOLERANCE_S = 5 * 60;
const DEFAULT_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
/** The address alias scripts/multibaas-setup.ts gives the USDC contract. */
export const USDC_ALIAS = "usdc";

export const multibaasEnabled = (env: MultiBaasEnv) => Boolean(env.MULTIBAAS_URL?.trim() && env.MULTIBAAS_API_KEY?.trim());

export const usdcAddress = (env: MultiBaasEnv) => (env.USDC_ADDRESS?.trim() || DEFAULT_USDC).toLowerCase();

/** MULTIBAAS_SYNC_FROM as ms, 0 when unset. */
export function syncFrom(env: MultiBaasEnv): number {
  const v = env.MULTIBAAS_SYNC_FROM?.trim();
  if (!v) return 0;
  const ms = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  return Number.isFinite(ms) ? ms : 0;
}

/** A USDC Transfer into a seller's payout address. Addresses and hash lowercased. */
export interface Transfer {
  tx_hash: string;
  owner: string;
  sender: string;
  amount_atomic: number;
  block_number: number;
  block_time: number;
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/** USDC value as MultiBaas returns it without a type conversion: an integer string. */
function toAtomic(value: unknown): number | null {
  const s = String(value ?? "").trim();
  return /^\d{1,15}$/.test(s) ? Number(s) : null;
}

function toTransfer(raw: { tx: unknown; from: unknown; to: unknown; value: unknown; block: unknown; time: unknown }): Transfer | null {
  const amount = toAtomic(raw.value);
  const tx = String(raw.tx ?? "");
  const from = String(raw.from ?? "");
  const to = String(raw.to ?? "");
  if (amount === null || !TX_HASH.test(tx) || !isAddress(from, { strict: false }) || !isAddress(to, { strict: false })) return null;
  const time = typeof raw.time === "number" ? raw.time : Date.parse(String(raw.time ?? ""));
  return {
    tx_hash: tx.toLowerCase(),
    owner: to.toLowerCase(),
    sender: from.toLowerCase(),
    amount_atomic: amount,
    block_number: Number(raw.block) || 0,
    block_time: Number.isFinite(time) ? time : Date.now(),
  };
}

// ---- webhook -----------------------------------------------------------------

/**
 * Checks a webhook against X-MultiBaas-Signature and X-MultiBaas-Timestamp: the
 * signature is the hex HMAC-SHA256 of the raw body followed by the timestamp.
 * Stale timestamps are rejected so a captured request can't be replayed later.
 */
export async function verifyWebhook(
  secret: string | undefined,
  body: Uint8Array,
  signature: string | undefined,
  timestamp: string | undefined,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!secret?.trim() || !signature || !timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_S) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret.trim()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const ts = enc.encode(timestamp);
  const message = new Uint8Array(body.length + ts.length);
  message.set(body);
  message.set(ts, body.length);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  const given = signature.trim().toLowerCase();
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/**
 * The USDC Transfers in a webhook delivery: a JSON array of
 * {id, event: "event.emitted" | "transaction.included", data}. Everything that
 * isn't a well-formed Transfer from the USDC contract is skipped.
 */
export function transfersFromWebhook(body: unknown, usdc: string): Transfer[] {
  if (!Array.isArray(body)) return [];
  const out: Transfer[] = [];
  for (const item of body) {
    if (item?.event !== "event.emitted") continue;
    const ev = item.data?.event;
    const tx = item.data?.transaction;
    if (ev?.name !== "Transfer" || String(ev.contract?.address ?? "").toLowerCase() !== usdc) continue;
    const inputs: { value?: unknown }[] = Array.isArray(ev.inputs) ? ev.inputs : [];
    if (inputs.length < 3) continue;
    const t = toTransfer({
      tx: tx?.txHash,
      from: inputs[0]?.value,
      to: inputs[1]?.value,
      value: inputs[2]?.value,
      block: tx?.blockNumber,
      time: item.data?.triggeredAt,
    });
    if (t) out.push(t);
  }
  return out;
}

// ---- event queries -------------------------------------------------------------

/**
 * A seller's most recent USDC receipts (up to `limit`), newest first, from
 * MultiBaas's index of the USDC contract. Runs an ad hoc event query, so nothing
 * has to be saved in MultiBaas first, a page of PAGE_SIZE rows at a time.
 * Throws when MultiBaas is off, unreachable or rejects the query.
 */
export async function queryTransfersTo(env: MultiBaasEnv, owner: string, limit = 500, doFetch: Fetcher = fetch): Promise<Transfer[]> {
  if (!multibaasEnabled(env)) throw new Error("MultiBaas is not configured");
  const recipient = owner.toLowerCase();
  const query = {
    events: [
      {
        eventName: "Transfer",
        // MultiBaas lowercases aliases in result rows, so these are lowercase already.
        select: [
          { type: "tx_hash", alias: "txhash" },
          { type: "input", inputIndex: 0, alias: "sender" },
          { type: "input", inputIndex: 1, alias: "recipient" },
          { type: "input", inputIndex: 2, alias: "amount" },
          { type: "block_number", alias: "block" },
          { type: "triggered_at", alias: "timestamp" },
        ],
        filter: {
          rule: "and",
          children: [
            { fieldType: "contract_address_alias", operator: "equal", value: USDC_ALIAS },
            // MultiBaas compares address inputs as stored, lowercase: a checksummed value matches nothing.
            { fieldType: "input", inputIndex: 1, operator: "equal", value: recipient },
          ],
        },
      },
    ],
    orderBy: "timestamp",
    order: "DESC",
  };
  const base = `${env.MULTIBAAS_URL!.trim().replace(/\/+$/, "")}/api/v0/queries`;
  const out: Transfer[] = [];
  for (let offset = 0; offset < limit; offset += PAGE_SIZE) {
    const size = Math.min(PAGE_SIZE, limit - offset);
    const res = await doFetch(`${base}?offset=${offset}&limit=${size}`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.MULTIBAAS_API_KEY!.trim()}`, "content-type": "application/json" },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      // MultiBaas explains itself in {status, message}; keep that in the error the dashboard shows.
      const detail = await res
        .json<{ message?: unknown }>()
        .then((j) => (typeof j.message === "string" ? j.message : ""))
        .catch(() => "");
      throw new Error(`MultiBaas event query failed: HTTP ${res.status}${detail ? ` (${detail})` : ""}`);
    }
    const json = await res.json<{ result?: { rows?: Record<string, unknown>[] } }>();
    const rows = json.result?.rows ?? [];
    for (const r of rows) {
      const t = toTransfer({ tx: r.txhash, from: r.sender, to: r.recipient, value: r.amount, block: r.block, time: r.timestamp });
      if (t && t.owner === recipient) out.push(t);
    }
    if (rows.length < size) break;
  }
  return out;
}
