// Hosted x402-gateway MCP server on Cloudflare Workers (Streamable HTTP at /mcp).
// Unlike the stdio server, this one is custodial: the buyer key is a Worker
// secret and everyone holding MCP_TOKEN spends from the same wallet, capped by
// MAX_PER_CALL_USD and a rolling 24h DAILY_BUDGET_USD.
//
// Auth: `Authorization: Bearer <MCP_TOKEN>`, or `/mcp?key=<MCP_TOKEN>` for
// clients that can't set headers (claude.ai custom connectors).

import { createMcpHandler } from "agents/mcp/server";
import { privateKeyToAccount } from "viem/accounts";
import { createServer, usdToAtomic, type SpendLedger } from "./server";

const DAY_MS = 24 * 60 * 60 * 1000;

// Spending is read back from the gateway's own call log, which records every
// settled payment by payer, so the budget survives across stateless requests.
function d1Ledger(db: D1Database, payer: string): SpendLedger {
  return {
    async spent() {
      const row = await db
        .prepare("SELECT COALESCE(SUM(amount_atomic), 0) AS total FROM calls WHERE payer = ? AND settled = 1 AND created_at > ?")
        .bind(payer.toLowerCase(), Date.now() - DAY_MS)
        .first<{ total: number }>();
      return BigInt(row?.total ?? 0);
    },
    // The gateway writes the row when it settles.
    record: async () => {},
  };
}

async function authorized(request: Request, token: string): Promise<boolean> {
  const url = new URL(request.url);
  const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("key") ?? "";
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(given)), crypto.subtle.digest("SHA-256", enc.encode(token))]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/") return Response.json({ service: "x402-gateway-mcp", mcp: "/mcp", gateway: env.GATEWAY_URL });
    if (pathname !== "/mcp") return Response.json({ error: "not_found" }, { status: 404 });
    if (!env.MCP_TOKEN || !(await authorized(request, env.MCP_TOKEN))) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
    }

    const account = env.BUYER_PRIVATE_KEY ? privateKeyToAccount(env.BUYER_PRIVATE_KEY as `0x${string}`) : null;
    const server = () =>
      createServer({
        gatewayUrl: env.GATEWAY_URL.replace(/\/$/, ""),
        // Service binding: Workers can't reliably fetch another Worker's workers.dev URL.
        fetch: (input, init) => env.GATEWAY.fetch(new Request(input, init)),
        account,
        maxPerCall: usdToAtomic(env.MAX_PER_CALL_USD),
        budget: usdToAtomic(env.DAILY_BUDGET_USD),
        budgetWindow: "rolling 24h",
        ledger: account ? d1Ledger(env.DB, account.address) : { spent: async () => 0n, record: async () => {} },
      });
    return createMcpHandler(server)(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
