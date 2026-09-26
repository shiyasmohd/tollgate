// Forwarding a buyer's request to the seller's upstream, with the seller's secret
// injected. Everything here runs after payment is verified, so any non-2xx this
// returns means the buyer is not charged (the x402 middleware skips settlement).

import { decryptSecret } from "./crypto";
import type { EndpointRow } from "./db";

export type BodyResult = { ok: true; body: string | null } | { ok: false; status: 400 | 413; error: string };

/**
 * Size-checks the buyer's body and applies the seller's body_overrides (a shallow
 * JSON merge, e.g. {"max_tokens": 500}). Runs before the paywall so an invalid
 * request is rejected without asking the buyer to pay.
 */
export function prepareBody(ep: EndpointRow, raw: string | null): BodyResult {
  const hasBody = ep.method !== "GET" && ep.method !== "HEAD";
  if (!hasBody) return { ok: true, body: null };
  const body = raw ?? "";
  if (new TextEncoder().encode(body).byteLength > ep.max_body_bytes) {
    return { ok: false, status: 413, error: `body exceeds ${ep.max_body_bytes} bytes` };
  }
  if (!ep.body_overrides) return { ok: true, body: body || null };

  let parsed: unknown = {};
  if (body.trim()) {
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ok: false, status: 400, error: "body must be JSON" };
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: "body must be a JSON object" };
  }
  return { ok: true, body: JSON.stringify({ ...parsed, ...JSON.parse(ep.body_overrides) }) };
}

export interface UpstreamRequest {
  query: URLSearchParams;
  body: string | null;
  contentType?: string;
  accept?: string;
}

// Upstream headers that must not be relayed to the buyer.
const DROP_HEADERS = new Set([
  "set-cookie", "content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive",
  "server", "alt-svc", "report-to", "nel",
]);

export async function callUpstream(env: Env, ep: EndpointRow, req: UpstreamRequest): Promise<Response> {
  const url = new URL(ep.url);
  // Buyer params first; params already on the seller's URL are fixed and win.
  for (const [k, v] of req.query) if (!url.searchParams.has(k)) url.searchParams.append(k, v);

  const headers = new Headers(JSON.parse(ep.static_headers) as Record<string, string>);
  headers.set("accept", req.accept ?? "*/*");
  if (req.body != null) headers.set("content-type", req.contentType ?? "application/json");

  let secret: string | null = null;
  if (ep.auth_type !== "none" && ep.auth_name && ep.auth_value_enc) {
    secret = await decryptSecret(env.MASTER_KEY, ep.auth_value_enc);
    if (ep.auth_type === "header") headers.set(ep.auth_name, secret);
    else url.searchParams.set(ep.auth_name, secret);
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: ep.method,
      headers,
      body: req.body,
      redirect: "manual",
      signal: AbortSignal.timeout(Number(env.UPSTREAM_TIMEOUT_MS)),
    });
  } catch (e) {
    const timedOut = e instanceof DOMException && e.name === "TimeoutError";
    return Response.json({ error: timedOut ? "upstream_timeout" : "upstream_unreachable" }, { status: timedOut ? 504 : 502 });
  }

  // A fresh Response: fetch() responses have immutable headers, and the x402
  // middleware writes headers onto the handler's response.
  const out = new Headers();
  upstream.headers.forEach((v, k) => {
    if (!DROP_HEADERS.has(k) && !k.startsWith("cf-")) out.set(k, v);
  });
  // Some upstreams echo the request (or quote the key in an auth error). The
  // middleware buffers the body anyway, so scrub the secret from text responses.
  if (secret && TEXTUAL.test(out.get("content-type") ?? "")) {
    // "Bearer sk-…" is stored whole, but an error may quote only the token part.
    const token = secret.split(" ").pop()!;
    let text = (await upstream.text()).replaceAll(secret, "[redacted]");
    if (token.length >= 8) text = text.replaceAll(token, "[redacted]");
    return new Response(text, { status: upstream.status, headers: out });
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

const TEXTUAL = /json|text|xml|javascript|graphql/i;
