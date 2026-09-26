// Reconciles what the gateway recorded against what landed onchain.
//
// A settled call is recorded from the facilitator's PAYMENT-RESPONSE. The USDC
// Transfer MultiBaas indexed for the same transaction is the proof. Every call
// gets one of:
//
//   verified    the transfer landed, for the recorded amount
//   mismatch    the transfer landed, for a different amount
//   confirming  no transfer yet, but the call is under CONFIRM_GRACE_MS old
//   unverified  no transfer after the grace period: the seller may not have been paid
//   untracked   the call predates MULTIBAAS_SYNC_FROM, so it can't be checked
//
// Transfers into the payout address that no call accounts for are "external":
// USDC that reached the seller outside Tollgate, which isn't API income.

import { atomicToUsd, basescanTx, type SettledCallRow, type TransferRow } from "./db";

export const CONFIRM_GRACE_MS = 2 * 60 * 1000;

export type Verification = "verified" | "mismatch" | "confirming" | "unverified" | "untracked";

export interface VerifyContext {
  enabled: boolean;
  syncFrom: number;
  now: number;
}

/** A call's onchain state; null when verification is off or the call wasn't settled. */
export function verifyCall(
  call: { settled: number; amount_atomic: number; created_at: number; onchain_amount: number | null },
  ctx: VerifyContext,
): Verification | null {
  if (!ctx.enabled || call.settled !== 1) return null;
  if (call.onchain_amount !== null) return call.onchain_amount === call.amount_atomic ? "verified" : "mismatch";
  if (call.created_at < ctx.syncFrom) return "untracked";
  return ctx.now - call.created_at < CONFIRM_GRACE_MS ? "confirming" : "unverified";
}

const usd = (atomic: number) => atomicToUsd(atomic);

export function reconcile(calls: SettledCallRow[], transfers: (TransferRow & { known: number })[], ctx: VerifyContext) {
  const counts: Record<Verification, number> = { verified: 0, mismatch: 0, confirming: 0, unverified: 0, untracked: 0 };
  let recorded = 0;
  let verifiedAtomic = 0;
  const unverified = [];
  const mismatched = [];

  for (const c of calls) {
    recorded += c.amount_atomic;
    const v = verifyCall(c, ctx);
    if (!v) continue;
    counts[v]++;
    if (v === "verified") verifiedAtomic += c.amount_atomic;
    const base = { call_id: c.id, endpoint_id: c.endpoint_id, endpoint_name: c.endpoint_name, tx_hash: c.tx_hash, created_at: c.created_at };
    if (v === "unverified") {
      unverified.push({ ...base, amount_usd: usd(c.amount_atomic), tx_url: c.tx_hash ? basescanTx(c.tx_hash) : null });
    } else if (v === "mismatch") {
      mismatched.push({
        ...base,
        recorded_usd: usd(c.amount_atomic),
        onchain_usd: usd(c.onchain_amount ?? 0),
        tx_url: c.tx_hash ? basescanTx(c.tx_hash) : null,
      });
    }
  }

  const external = transfers.filter((t) => !t.known);
  const onchain = transfers.reduce((sum, t) => sum + t.amount_atomic, 0);
  const externalAtomic = external.reduce((sum, t) => sum + t.amount_atomic, 0);

  const bySender = new Map<string, { payer: string; atomic: number; count: number }>();
  for (const t of transfers) {
    const p = bySender.get(t.sender) ?? { payer: t.sender, atomic: 0, count: 0 };
    p.atomic += t.amount_atomic;
    p.count++;
    bySender.set(t.sender, p);
  }
  const topPayers = [...bySender.values()]
    .sort((a, b) => b.atomic - a.atomic)
    .slice(0, 5)
    .map((p) => ({ payer: p.payer, amount_usd: usd(p.atomic), transfers: p.count }));

  // Only calls that could have been checked by now count toward the verified share.
  const checkable = counts.verified + counts.mismatch + counts.unverified;
  const latest = transfers.reduce<TransferRow | null>((a, t) => (!a || t.block_number > a.block_number ? t : a), null);

  return {
    recorded_atomic: recorded,
    recorded_usd: usd(recorded),
    onchain_atomic: onchain,
    onchain_usd: usd(onchain),
    verified_atomic: verifiedAtomic,
    verified_usd: usd(verifiedAtomic),
    verified_pct: checkable ? Math.round((counts.verified / checkable) * 1000) / 10 : null,
    counts,
    unverified,
    mismatched,
    external: external.map((t) => ({
      tx_hash: t.tx_hash,
      from: t.sender,
      amount_usd: usd(t.amount_atomic),
      block_number: t.block_number,
      block_time: t.block_time,
      tx_url: basescanTx(t.tx_hash),
    })),
    external_atomic: externalAtomic,
    external_usd: usd(externalAtomic),
    top_payers: topPayers,
    last_block: latest ? { number: latest.block_number, time: latest.block_time } : null,
  };
}

export type Reconciliation = ReturnType<typeof reconcile>;
