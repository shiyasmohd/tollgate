// Typed D1 queries. Money is always integer USDC atomic units (6 decimals).

export type AuthType = "none" | "header" | "query";
export type EndpointStatus = "pending" | "active" | "paused" | "deleted";

export interface EndpointRow {
  id: string;
  owner: string;
  name: string;
  description: string;
  method: string;
  url: string;
  auth_type: AuthType;
  auth_name: string | null;
  auth_value_enc: string | null;
  static_headers: string;
  price_atomic: number;
  example_query: string | null;
  example_body: string | null;
  body_overrides: string | null;
  max_body_bytes: number;
  /** 1: screen each payer with Intercepta before accepting their payment. */
  screen_payers: number;
  /** ENSv2 name on Sepolia once the endpoint has been active, e.g. weather.tollgate.eth. */
  ens_name: string | null;
  /** Label the seller chose for that name ("elevenlabs"); null: derived from the endpoint name. */
  ens_label: string | null;
  status: EndpointStatus;
  created_at: number;
  updated_at: number;
}

export interface CallRow {
  id: string;
  endpoint_id: string;
  owner: string;
  payer: string | null;
  amount_atomic: number;
  tx_hash: string | null;
  settled: number;
  upstream_status: number;
  latency_ms: number;
  created_at: number;
}

export function newId(prefix: string): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return `${prefix}_${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}`;
}

export function atomicToUsd(atomic: number): string {
  const whole = Math.floor(atomic / 1_000_000);
  const frac = String(atomic % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

export const basescanTx = (hash: string) => `https://sepolia.basescan.org/tx/${hash}`;

/** The seller-facing shape of an endpoint: never includes the secret. */
export function toSellerEndpoint(row: EndpointRow) {
  const { auth_value_enc, static_headers, body_overrides, screen_payers, ...rest } = row;
  return {
    ...rest,
    screen_payers: screen_payers !== 0,
    auth_set: auth_value_enc != null,
    static_headers: JSON.parse(static_headers) as Record<string, string>,
    body_overrides: body_overrides ? (JSON.parse(body_overrides) as Record<string, unknown>) : null,
    price_usd: atomicToUsd(row.price_atomic),
  };
}

// ---- nonces ---------------------------------------------------------------

export async function insertNonce(db: D1Database, nonce: string, expiresAt: number) {
  await db.prepare("INSERT INTO nonces (nonce, expires_at) VALUES (?, ?)").bind(nonce, expiresAt).run();
}

/** Deletes the nonce and reports whether it existed and was unexpired. Single use. */
export async function consumeNonce(db: D1Database, nonce: string, now: number): Promise<boolean> {
  const row = await db
    .prepare("DELETE FROM nonces WHERE nonce = ? RETURNING expires_at")
    .bind(nonce)
    .first<{ expires_at: number }>();
  await db.prepare("DELETE FROM nonces WHERE expires_at < ?").bind(now).run();
  return !!row && row.expires_at >= now;
}

// ---- endpoints ------------------------------------------------------------

export function getEndpoint(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM endpoints WHERE id = ?").bind(id).first<EndpointRow>();
}

export async function getOwnedEndpoint(db: D1Database, id: string, owner: string) {
  const row = await getEndpoint(db, id);
  return row && row.owner === owner && row.status !== "deleted" ? row : null;
}

const ENDPOINT_TOTALS = `
  SELECT e.*, COALESCE(s.calls, 0) AS calls, COALESCE(s.income, 0) AS income_atomic
  FROM endpoints e
  LEFT JOIN (
    SELECT endpoint_id, SUM(settled) AS calls, SUM(CASE WHEN settled = 1 THEN amount_atomic ELSE 0 END) AS income
    FROM calls WHERE owner = ?1 GROUP BY endpoint_id
  ) s ON s.endpoint_id = e.id
  WHERE e.owner = ?1 AND e.status != 'deleted'`;

export type EndpointWithTotals = EndpointRow & { calls: number; income_atomic: number };

export async function listEndpoints(db: D1Database, owner: string) {
  const { results } = await db.prepare(`${ENDPOINT_TOTALS} ORDER BY e.created_at DESC`).bind(owner).all<EndpointWithTotals>();
  return results;
}

export function getEndpointWithTotals(db: D1Database, id: string, owner: string) {
  return db.prepare(`${ENDPOINT_TOTALS} AND e.id = ?2`).bind(owner, id).first<EndpointWithTotals>();
}

export async function insertEndpoint(db: D1Database, row: EndpointRow) {
  await db
    .prepare(
      `INSERT INTO endpoints (id, owner, name, description, method, url, auth_type, auth_name, auth_value_enc,
        static_headers, price_atomic, example_query, example_body, body_overrides, max_body_bytes, screen_payers, ens_label,
        status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id, row.owner, row.name, row.description, row.method, row.url, row.auth_type, row.auth_name, row.auth_value_enc,
      row.static_headers, row.price_atomic, row.example_query, row.example_body, row.body_overrides, row.max_body_bytes,
      row.screen_payers, row.ens_label, row.status, row.created_at, row.updated_at,
    )
    .run();
}

type EndpointPatch = Partial<Omit<EndpointRow, "id" | "owner" | "created_at">>;

export async function updateEndpoint(db: D1Database, id: string, patch: EndpointPatch) {
  const entries = Object.entries({ ...patch, updated_at: Date.now() }).filter(([, v]) => v !== undefined);
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  await db.prepare(`UPDATE endpoints SET ${sets} WHERE id = ?`).bind(...entries.map(([, v]) => v), id).run();
}

export async function listCatalog(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT e.*, s.ens_name AS seller_ens_name FROM endpoints e
       LEFT JOIN sellers s ON s.address = e.owner AND s.status = 'registered'
       WHERE e.status = 'active' ORDER BY e.created_at DESC`,
    )
    .all<EndpointRow & { seller_ens_name: string | null }>();
  return results;
}

// ---- sellers (ENS names) ----------------------------------------------------

export interface SellerRow {
  address: string;
  handle: string;
  ens_name: string;
  registry: string | null;
  /** pending: claimed, transactions not sent yet. registered: sent (resolves a block or so later). */
  status: "pending" | "registered";
  created_at: number;
  updated_at: number;
}

export function getSeller(db: D1Database, address: string) {
  return db.prepare("SELECT * FROM sellers WHERE address = ?").bind(address).first<SellerRow>();
}

export function getSellerByHandle(db: D1Database, handle: string) {
  return db.prepare("SELECT * FROM sellers WHERE handle = ?").bind(handle).first<SellerRow>();
}

/** Claims a handle for a seller. False if another seller holds it (UNIQUE). */
export async function claimSeller(db: D1Database, row: SellerRow): Promise<boolean> {
  try {
    await db
      .prepare(
        `INSERT INTO sellers (address, handle, ens_name, registry, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (address) DO UPDATE SET handle = excluded.handle, ens_name = excluded.ens_name, registry = NULL,
           status = excluded.status, created_at = excluded.created_at, updated_at = excluded.updated_at`,
      )
      .bind(row.address, row.handle, row.ens_name, row.registry, row.status, row.created_at, row.updated_at)
      .run();
    return true;
  } catch (e) {
    if (String(e).includes("UNIQUE")) return false;
    throw e;
  }
}

export async function markSellerRegistered(db: D1Database, address: string, registry: string) {
  await db
    .prepare("UPDATE sellers SET registry = ?, status = 'registered', updated_at = ? WHERE address = ?")
    .bind(registry, Date.now(), address)
    .run();
}

export async function deleteSeller(db: D1Database, address: string) {
  await db.prepare("DELETE FROM sellers WHERE address = ?").bind(address).run();
}

// ---- calls ----------------------------------------------------------------

export async function insertCall(db: D1Database, call: CallRow) {
  await db
    .prepare(
      `INSERT INTO calls (id, endpoint_id, owner, payer, amount_atomic, tx_hash, settled, upstream_status, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      call.id, call.endpoint_id, call.owner, call.payer, call.amount_atomic, call.tx_hash, call.settled,
      call.upstream_status, call.latency_ms, call.created_at,
    )
    .run();
}

export interface StatsQuery {
  owner: string;
  since: number;
  bucketMs: number;
  endpointId?: string;
}

export async function getStats(db: D1Database, q: StatsQuery) {
  const filter = `owner = ? AND created_at >= ?${q.endpointId ? " AND endpoint_id = ?" : ""}`;
  const params: (string | number)[] = q.endpointId ? [q.owner, q.since, q.endpointId] : [q.owner, q.since];
  const [totals, series] = await db.batch([
    db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN settled = 1 THEN amount_atomic ELSE 0 END), 0) AS income_atomic,
           COALESCE(SUM(settled), 0) AS paid_calls,
           COALESCE(SUM(CASE WHEN settled = 0 THEN 1 ELSE 0 END), 0) AS failed_calls,
           COUNT(DISTINCT CASE WHEN settled = 1 THEN payer END) AS unique_payers
         FROM calls WHERE ${filter}`,
      )
      .bind(...params),
    db
      .prepare(
        // CAST keeps this integer division even if the bound bucket size arrives as REAL,
        // which would otherwise make every row its own "bucket" and zero out the chart.
        `SELECT CAST(created_at / ? AS INTEGER) * ? AS bucket,
           SUM(CASE WHEN settled = 1 THEN amount_atomic ELSE 0 END) AS income_atomic,
           SUM(settled) AS calls
         FROM calls WHERE ${filter} GROUP BY bucket ORDER BY bucket`,
      )
      .bind(q.bucketMs, q.bucketMs, ...params),
  ]);
  return {
    totals: totals!.results[0] as { income_atomic: number; paid_calls: number; failed_calls: number; unique_payers: number },
    series: series!.results as { bucket: number; income_atomic: number; calls: number }[],
  };
}

export interface FeedQuery {
  owner: string;
  since?: number;
  before?: number;
  endpointId?: string;
  status?: "settled" | "failed";
  /** Only settled calls created in [from, to) that no matching onchain transfer backs. */
  unverified?: { from: number; to: number };
  limit: number;
}

export async function getFeed(db: D1Database, q: FeedQuery) {
  const where = ["c.owner = ?"];
  const params: (string | number)[] = [q.owner];
  if (q.since !== undefined) { where.push("c.created_at > ?"); params.push(q.since); }
  if (q.before !== undefined) { where.push("c.created_at < ?"); params.push(q.before); }
  if (q.endpointId) { where.push("c.endpoint_id = ?"); params.push(q.endpointId); }
  if (q.status) where.push(`c.settled = ${q.status === "settled" ? 1 : 0}`);
  if (q.unverified) {
    where.push("c.settled = 1 AND c.created_at >= ? AND c.created_at < ? AND (t.tx_hash IS NULL OR t.amount_atomic != c.amount_atomic)");
    params.push(q.unverified.from, q.unverified.to);
  }
  const { results } = await db
    .prepare(
      // payer_verdict: the latest Intercepta screening of this payer for this seller.
      // onchain_*: the MultiBaas-indexed USDC transfer this call's tx_hash matched, if any.
      `SELECT c.*, e.name AS endpoint_name,
         (SELECT s.verdict FROM screenings s WHERE s.owner = c.owner AND s.payer = c.payer ORDER BY s.created_at DESC LIMIT 1) AS payer_verdict,
         t.amount_atomic AS onchain_amount, t.block_number AS onchain_block
       FROM calls c JOIN endpoints e ON e.id = c.endpoint_id
       LEFT JOIN onchain_transfers t ON t.owner = c.owner AND t.tx_hash = lower(c.tx_hash)
       WHERE ${where.join(" AND ")} ORDER BY c.created_at DESC LIMIT ?`,
    )
    .bind(...params, q.limit)
    .all<CallRow & { endpoint_name: string; payer_verdict: string | null; onchain_amount: number | null; onchain_block: number | null }>();
  return results;
}

// ---- screenings -----------------------------------------------------------

export interface ScreeningRow {
  id: string;
  endpoint_id: string;
  owner: string;
  payer: string;
  verdict: "allow" | "warn" | "block";
  summary: string;
  checks: string;
  amount_atomic: number;
  created_at: number;
}

export async function insertScreening(db: D1Database, row: ScreeningRow) {
  await db
    .prepare(
      `INSERT INTO screenings (id, endpoint_id, owner, payer, verdict, summary, checks, amount_atomic, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.id, row.endpoint_id, row.owner, row.payer, row.verdict, row.summary, row.checks, row.amount_atomic, row.created_at)
    .run();
}

export interface ScreeningQuery {
  owner: string;
  verdict?: "allow" | "warn" | "block";
  before?: number;
  limit: number;
}

export async function listScreenings(db: D1Database, q: ScreeningQuery) {
  const where = ["s.owner = ?"];
  const params: (string | number)[] = [q.owner];
  if (q.verdict) { where.push("s.verdict = ?"); params.push(q.verdict); }
  if (q.before !== undefined) { where.push("s.created_at < ?"); params.push(q.before); }
  const { results } = await db
    .prepare(
      `SELECT s.*, e.name AS endpoint_name FROM screenings s JOIN endpoints e ON e.id = s.endpoint_id
       WHERE ${where.join(" AND ")} ORDER BY s.created_at DESC LIMIT ?`,
    )
    .bind(...params, q.limit)
    .all<ScreeningRow & { endpoint_name: string }>();
  return results;
}

export async function countBlocked(db: D1Database, owner: string, since: number) {
  const row = await db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_atomic), 0) AS amount FROM screenings WHERE owner = ? AND verdict = 'block' AND created_at >= ?")
    .bind(owner, since)
    .first<{ n: number; amount: number }>();
  return { blocked_payments: row?.n ?? 0, blocked_atomic: row?.amount ?? 0 };
}

// ---- onchain (MultiBaas) --------------------------------------------------

export interface TransferRow {
  tx_hash: string;
  owner: string;
  sender: string;
  amount_atomic: number;
  block_number: number;
  block_time: number;
}

/** Stores transfers once each; a transfer seen by both the webhook and a query keeps its first row. */
export async function insertTransfers(db: D1Database, rows: TransferRow[], source: "webhook" | "query") {
  if (rows.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO onchain_transfers (tx_hash, owner, sender, amount_atomic, block_number, block_time, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await db.batch(rows.map((r) => stmt.bind(r.tx_hash, r.owner, r.sender, r.amount_atomic, r.block_number, r.block_time, source, now)));
}

/** Which of these lowercased addresses are sellers, i.e. own at least one endpoint. */
export async function knownSellers(db: D1Database, addresses: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < addresses.length; i += 50) {
    const chunk = addresses.slice(i, i + 50);
    const { results } = await db
      .prepare(`SELECT DISTINCT owner FROM endpoints WHERE owner IN (${chunk.map(() => "?").join(", ")})`)
      .bind(...chunk)
      .all<{ owner: string }>();
    for (const r of results) found.add(r.owner);
  }
  return found;
}

export type SettledCallRow = Pick<CallRow, "id" | "endpoint_id" | "payer" | "amount_atomic" | "tx_hash" | "settled" | "created_at"> & {
  endpoint_name: string;
  onchain_amount: number | null;
  onchain_block: number | null;
};

/** Settled calls since a time, each with the onchain transfer its tx_hash matched, if any. */
export async function listSettledCalls(db: D1Database, owner: string, since: number) {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.endpoint_id, e.name AS endpoint_name, c.payer, c.amount_atomic, c.tx_hash, c.settled, c.created_at,
         t.amount_atomic AS onchain_amount, t.block_number AS onchain_block
       FROM calls c
       JOIN endpoints e ON e.id = c.endpoint_id
       LEFT JOIN onchain_transfers t ON t.owner = c.owner AND t.tx_hash = lower(c.tx_hash)
       WHERE c.owner = ? AND c.settled = 1 AND c.created_at >= ?
       ORDER BY c.created_at DESC`,
    )
    .bind(owner, since)
    .all<SettledCallRow>();
  return results;
}

/** Transfers into a seller's payout address since a time; known = a Tollgate call settled it. */
export async function listTransfers(db: D1Database, owner: string, since: number) {
  const { results } = await db
    .prepare(
      `SELECT t.tx_hash, t.owner, t.sender, t.amount_atomic, t.block_number, t.block_time,
         EXISTS (SELECT 1 FROM calls c WHERE c.owner = t.owner AND lower(c.tx_hash) = t.tx_hash) AS known
       FROM onchain_transfers t
       WHERE t.owner = ? AND t.block_time >= ?
       ORDER BY t.block_time DESC`,
    )
    .bind(owner, since)
    .all<TransferRow & { known: number }>();
  return results;
}

// ---- seller health, for the action list ---------------------------------------

export async function endpointHealth(db: D1Database, owner: string, since: number) {
  const { results } = await db
    .prepare(
      `SELECT e.id, e.name, e.status,
         COALESCE(SUM(c.settled), 0) AS paid,
         COALESCE(SUM(CASE WHEN c.id IS NOT NULL AND c.settled = 0 THEN 1 ELSE 0 END), 0) AS failed
       FROM endpoints e
       LEFT JOIN calls c ON c.endpoint_id = e.id AND c.created_at >= ?2
       WHERE e.owner = ?1 AND e.status != 'deleted'
       GROUP BY e.id ORDER BY e.created_at DESC`,
    )
    .bind(owner, since)
    .all<{ id: string; name: string; status: EndpointStatus; paid: number; failed: number }>();
  return results;
}

/** Income per payer since a time, biggest first. */
export async function payerIncome(db: D1Database, owner: string, since: number) {
  const { results } = await db
    .prepare(
      `SELECT payer, SUM(amount_atomic) AS income_atomic, COUNT(*) AS calls
       FROM calls WHERE owner = ? AND settled = 1 AND created_at >= ? AND payer IS NOT NULL
       GROUP BY payer ORDER BY income_atomic DESC`,
    )
    .bind(owner, since)
    .all<{ payer: string; income_atomic: number; calls: number }>();
  return results;
}

/** Payers blocked at least `min` times since a time. */
export async function repeatBlockedPayers(db: D1Database, owner: string, since: number, min: number) {
  const { results } = await db
    .prepare(
      `SELECT payer, COUNT(*) AS n FROM screenings
       WHERE owner = ? AND verdict = 'block' AND created_at >= ?
       GROUP BY payer HAVING n >= ? ORDER BY n DESC`,
    )
    .bind(owner, since, min)
    .all<{ payer: string; n: number }>();
  return results;
}
