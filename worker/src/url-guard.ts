// Sellers submit arbitrary URLs that this Worker will fetch. Workers can't reach
// private networks, but reject obviously internal targets anyway, and never let an
// endpoint point back at this gateway (a paid loop).

export type UrlCheck = { ok: true; url: URL } | { ok: false; error: string };

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

export function checkUpstreamUrl(raw: string, ownHost?: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "url is not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, error: "url must use https" };
  if (url.username || url.password) return { ok: false, error: "url must not contain credentials" };

  const host = url.hostname.toLowerCase();
  if (IPV4.test(host) || host.startsWith("[")) return { ok: false, error: "url must use a hostname, not an IP address" };
  if (host === "localhost" || !host.includes(".") || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, error: "url must be a public hostname" };
  }
  if (ownHost && host === ownHost.toLowerCase().split(":")[0]) {
    return { ok: false, error: "url must not point at this gateway" };
  }
  return { ok: true, url };
}
