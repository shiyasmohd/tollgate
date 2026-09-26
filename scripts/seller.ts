// Seller CLI — a stand-in for the dashboard until it exists.
//
//   SELLER_PRIVATE_KEY=0x… GATEWAY_URL=http://localhost:8787 bun seller <command>
//
//   whoami                     sign in and print the address
//   create <endpoint.json>     create an endpoint (see scripts/examples/)
//   test <id>                  call the upstream once with the example request; 2xx activates
//   list                       your endpoints with totals
//   update <id> <patch.json>   PATCH an endpoint (e.g. {"status":"paused"} or {"price_usd":"0.02"})
//   delete <id>
//   stats [24h|30d]
//   feed
//
// The key only signs the SIWE message; it is never sent anywhere.

import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

const GATEWAY = (process.env.GATEWAY_URL ?? "http://localhost:8787").replace(/\/$/, "");
const pk = process.env.SELLER_PRIVATE_KEY;
if (!pk) {
  console.error("SELLER_PRIVATE_KEY is required");
  process.exit(1);
}
const account = privateKeyToAccount(pk as `0x${string}`);

async function api(path: string, init: RequestInit = {}, token?: string) {
  const res = await fetch(`${GATEWAY}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function login(): Promise<string> {
  const { nonce } = await api("/api/auth/nonce");
  const url = new URL(GATEWAY);
  const message = createSiweMessage({
    domain: url.host,
    address: account.address,
    statement: "Sign in to x402-gateway",
    uri: url.origin,
    version: "1",
    chainId: 84532,
    nonce,
    issuedAt: new Date(),
  });
  const signature = await account.signMessage({ message });
  const { token } = await api("/api/auth/verify", { method: "POST", body: JSON.stringify({ message, signature }) });
  return token;
}

const readJson = (file: string | undefined) => {
  if (!file) throw new Error("missing JSON file argument");
  return readFileSync(file, "utf8");
};

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  const token = await login();
  const print = (x: unknown) => console.log(JSON.stringify(x, null, 2));

  switch (cmd) {
    case "whoami":
      return print(await api("/api/me", {}, token));
    case "create":
      return print(await api("/api/endpoints", { method: "POST", body: readJson(a) }, token));
    case "test":
      return print(await api(`/api/endpoints/${a}/test`, { method: "POST" }, token));
    case "list":
      return print(await api("/api/endpoints", {}, token));
    case "update":
      return print(await api(`/api/endpoints/${a}`, { method: "PATCH", body: readJson(b) }, token));
    case "delete":
      return print(await api(`/api/endpoints/${a}`, { method: "DELETE" }, token));
    case "stats":
      return print(await api(`/api/stats?range=${a ?? "24h"}`, {}, token));
    case "feed":
      return print(await api("/api/feed?limit=20", {}, token));
    default:
      console.error("commands: whoami | create <file> | test <id> | list | update <id> <file> | delete <id> | stats [range] | feed");
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
