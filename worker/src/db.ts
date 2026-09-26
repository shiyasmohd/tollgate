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
  const { auth_value_enc, static_headers, body_overrides, ...rest } = row;
  return {
    ...rest,
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
        static_headers, price_atomic, example_query, example_body, body_overrides, max_body_bytes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id, row.owner, row.name, row.description, row.method, row.url, row.auth_type, row.auth_name, row.auth_value_enc,
      row.static_headers, row.price_atomic, row.example_query, row.example_body, row.body_overrides, row.max_body_bytes,
      row.status, row.created_at, row.updated_at,
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
    .prepare("SELECT * FROM endpoints WHERE status = 'active' ORDER BY created_at DESC")
    .all<EndpointRow>();
  return results;
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
  limit: number;
}

export async function getFeed(db: D1Database, q: FeedQuery) {
  const where = ["c.owner = ?"];
  const params: (string | number)[] = [q.owner];
  if (q.since !== undefined) { where.push("c.created_at > ?"); params.push(q.since); }
  if (q.before !== undefined) { where.push("c.created_at < ?"); params.push(q.before); }
  if (q.endpointId) { where.push("c.endpoint_id = ?"); params.push(q.endpointId); }
  if (q.status) where.push(`c.settled = ${q.status === "settled" ? 1 : 0}`);
  const { results } = await db
    .prepare(
      `SELECT c.*, e.name AS endpoint_name FROM calls c JOIN endpoints e ON e.id = c.endpoint_id
       WHERE ${where.join(" AND ")} ORDER BY c.created_at DESC LIMIT ?`,
    )
    .bind(...params, q.limit)
    .all<CallRow & { endpoint_name: string }>();
  return results;
}
