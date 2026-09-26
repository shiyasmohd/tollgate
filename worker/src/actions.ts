// What a seller should do next, worked out from the last 24 hours: payments the
// chain doesn't back, endpoints losing sales, blocked payers, money that arrived
// outside Tollgate, and income leaning on one buyer. The dashboard shows these as
// its action list; an agent can read the same list.

import { atomicToUsd } from "./db";
import type { Reconciliation } from "./reconcile";

export type Severity = "critical" | "warning" | "info";

export interface Action {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  /** A dashboard path, or an absolute URL for BaseScan. */
  cta: { label: string; href: string } | null;
}

export interface ActionInput {
  owner: string;
  /** null when onchain verification is off. */
  reconciliation: Reconciliation | null;
  /** Why verification couldn't run just now, e.g. MultiBaas unreachable. */
  verificationError: string | null;
  endpoints: { id: string; name: string; status: string; paid: number; failed: number }[];
  blocked: { blocked_payments: number; blocked_atomic: number };
  repeatBlocked: { payer: string; n: number }[];
  payers: { payer: string; income_atomic: number; calls: number }[];
}

export const FAILURE_RATE = 0.2;
export const FAILURE_MIN_CALLS = 5;
export const CONCENTRATION = 0.6;
export const CONCENTRATION_MIN_CALLS = 5;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export function buildActions(input: ActionInput): Action[] {
  const out: Action[] = [];
  const r = input.reconciliation;

  // With MultiBaas unreachable, a missing transfer may just not be backfilled yet.
  if (r && r.unverified.length > 0 && !input.verificationError) {
    const n = r.unverified.length;
    const total = r.unverified.reduce((sum, u) => sum + Number(u.amount_usd), 0);
    out.push({
      id: "unverified",
      severity: "critical",
      title: `${plural(n, "payment")} not found onchain`,
      detail: `The facilitator reported $${total.toFixed(4)} as settled, but MultiBaas found no USDC transfer to your payout address in ${n === 1 ? "that transaction" : "those transactions"}. You may not have been paid.`,
      cta: { label: "Review payments", href: "/payments?verification=unverified" },
    });
  }

  if (r && r.mismatched.length > 0) {
    const m = r.mismatched[0]!;
    out.push({
      id: "mismatch",
      severity: "critical",
      title: `${plural(r.mismatched.length, "payment")} settled for a different amount`,
      detail: `Recorded $${m.recorded_usd} but $${m.onchain_usd} arrived onchain${r.mismatched.length > 1 ? `, and ${r.mismatched.length - 1} more` : ""}.`,
      cta: { label: "Review payments", href: "/payments?verification=unverified" },
    });
  }

  for (const e of input.endpoints) {
    const total = e.paid + e.failed;
    if (e.status !== "active" || total < FAILURE_MIN_CALLS || e.failed / total < FAILURE_RATE) continue;
    out.push({
      id: `failing:${e.id}`,
      severity: "warning",
      title: `${e.name} is failing ${Math.round((e.failed / total) * 100)}% of calls`,
      detail: `${e.failed} of ${total} calls in the last 24h failed upstream. Buyers weren't charged, but those sales are lost. Check the upstream API, or pause the endpoint.`,
      cta: { label: "Open endpoint", href: `/endpoints/${e.id}` },
    });
  }

  for (const e of input.endpoints.filter((e) => e.status === "pending").slice(0, 3)) {
    out.push({
      id: `pending:${e.id}`,
      severity: "warning",
      title: `${e.name} isn't live yet`,
      detail: "Buyers can't reach it until a test call succeeds.",
      cta: { label: "Run test", href: `/endpoints/${e.id}` },
    });
  }

  if (input.blocked.blocked_payments > 0) {
    const repeat = input.repeatBlocked[0];
    out.push({
      id: "blocked",
      severity: "warning",
      title: `Intercepta blocked ${plural(input.blocked.blocked_payments, "payment")} in 24h`,
      detail: repeat
        ? `${short(repeat.payer)} was blocked ${repeat.n} times: a flagged payer keeps trying your endpoints.`
        : `$${atomicToUsd(input.blocked.blocked_atomic)} from flagged payers never reached your upstream.`,
      cta: { label: "See screenings", href: "/payments" },
    });
  }

  if (r && r.external.length > 0) {
    out.push({
      id: "external",
      severity: "info",
      title: `$${r.external_usd} received outside Tollgate`,
      detail: `${plural(r.external.length, "USDC transfer")} reached your payout address without a Tollgate call. ${r.external.length === 1 ? "It isn't" : "They aren't"} counted as API income.`,
      cta: { label: "View on BaseScan", href: `https://sepolia.basescan.org/address/${input.owner}#tokentxns` },
    });
  }

  const income = input.payers.reduce((sum, p) => sum + p.income_atomic, 0);
  const calls = input.payers.reduce((sum, p) => sum + p.calls, 0);
  const top = input.payers[0];
  if (top && input.payers.length > 1 && calls >= CONCENTRATION_MIN_CALLS && top.income_atomic / income >= CONCENTRATION) {
    out.push({
      id: "concentration",
      severity: "info",
      title: `One buyer brings ${Math.round((top.income_atomic / income) * 100)}% of income`,
      detail: `${short(top.payer)} paid $${atomicToUsd(top.income_atomic)} of $${atomicToUsd(income)} in the last 24h. Losing them would cut income sharply.`,
      cta: null,
    });
  }

  if (input.verificationError) {
    out.push({
      id: "verification_paused",
      severity: "info",
      title: "Onchain verification paused",
      detail: `MultiBaas couldn't be reached (${input.verificationError}). Payments are still recorded and will be checked once it's back.`,
      cta: null,
    });
  }

  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}
