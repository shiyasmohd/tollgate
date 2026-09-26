// Hosted x402-gateway MCP server on Cloudflare Workers (Streamable HTTP at /mcp).
//
// Each user pays from their own Privy embedded wallet. Connecting the MCP
// client runs OAuth: /authorize sends the user to the /connect page, where they
// sign in with Privy and add our key quorum as a signer on their wallet (limited
// by a Privy policy to USDC payments on Base Sepolia). /authorize/complete
// checks that and issues the OAuth grant carrying their wallet. Tool calls then
// sign x402 payments through Privy with our authorization key; Privy holds the
// wallet key, we never do.

import { OAuthProvider, type AuthRequest, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { PrivyClient } from "@privy-io/node";
import type { LinkedAccountEthereumEmbeddedWallet } from "@privy-io/node/resources";
import { createViemAccount } from "@privy-io/node/viem";
import { createMcpHandler } from "agents/mcp/server";
import { env as moduleEnv } from "cloudflare:workers";
import { createServer, usdToAtomic, type SpendLedger } from "./server";

/** What an OAuth grant carries into every MCP request. */
interface Props extends Record<string, unknown> {
  userId: string;
  walletId: string;
  address: `0x${string}`;
}

type WorkerEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

const DAY_MS = 24 * 60 * 60 * 1000;
const PENDING_TTL_S = 15 * 60;

const privyClient = (env: Env) => new PrivyClient({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET });

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

// ---- MCP (behind OAuth) ----------------------------------------------------

const mcpHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const props = (ctx as ExecutionContext & { props: Props }).props;
    const account = createViemAccount(privyClient(env), {
      walletId: props.walletId,
      address: props.address,
      authorizationContext: { authorization_private_keys: [env.PRIVY_SIGNER_KEY] },
    });
    const server = () =>
      createServer({
        gatewayUrl: env.GATEWAY_URL.replace(/\/$/, ""),
        // Service binding: Workers can't reliably fetch another Worker's workers.dev URL.
        fetch: (input, init) => env.GATEWAY.fetch(new Request(input, init)),
        account,
        maxPerCall: usdToAtomic(env.MAX_PER_CALL_USD),
        budget: usdToAtomic(env.DAILY_BUDGET_USD),
        budgetWindow: "rolling 24h",
        ledger: d1Ledger(env.DB, props.address),
      });
    return createMcpHandler(server)(request, env, ctx);
  },
};

// ---- OAuth authorize flow --------------------------------------------------

async function authorize(request: Request, env: WorkerEnv): Promise<Response> {
  let oauthReq: AuthRequest;
  try {
    oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (e) {
    return new Response(e instanceof Error ? e.message : "Invalid authorization request", { status: 400 });
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  if (!client) return new Response("Unknown OAuth client", { status: 400 });

  // Park the request server-side; the connect page only ever holds its id.
  const id = crypto.randomUUID();
  await env.OAUTH_KV.put(`pending:${id}`, JSON.stringify({ oauthReq, clientName: client.clientName ?? "An MCP client" }), {
    expirationTtl: PENDING_TTL_S,
  });
  return Response.redirect(new URL(`/connect/?req=${id}`, request.url).href, 302);
}

type Pending = { oauthReq: AuthRequest; clientName: string };
const loadPending = async (env: Env, id: string | null) =>
  id ? await env.OAUTH_KV.get<Pending>(`pending:${id}`, "json") : null;

/** Config for the connect page. */
async function connectSession(request: Request, env: Env): Promise<Response> {
  const pending = await loadPending(env, new URL(request.url).searchParams.get("req"));
  if (!pending) return Response.json({ error: "expired" }, { status: 404 });
  return Response.json({
    clientName: pending.clientName,
    privyAppId: env.PRIVY_APP_ID,
    signerId: env.PRIVY_SIGNER_ID,
    policyId: env.PRIVY_POLICY_ID,
    maxPerCallUsd: env.MAX_PER_CALL_USD,
    dailyBudgetUsd: env.DAILY_BUDGET_USD,
  });
}

/** The connect page calls this once the user has signed in and added our signer. */
async function completeAuthorization(request: Request, env: WorkerEnv): Promise<Response> {
  const { req } = (await request.json()) as { req?: string };
  const pending = await loadPending(env, req ?? null);
  if (!pending) return Response.json({ error: "This sign-in link expired. Start again from your MCP client." }, { status: 404 });

  const privy = privyClient(env);
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  let userId: string;
  try {
    userId = (await privy.utils().auth().verifyAccessToken(token)).user_id;
  } catch {
    return Response.json({ error: "Privy session is invalid. Sign in again." }, { status: 401 });
  }

  const user = await privy.users()._get(userId);
  const embedded = user.linked_accounts.find(
    (a) => a.type === "wallet" && a.chain_type === "ethereum" && "connector_type" in a && a.connector_type === "embedded",
  ) as LinkedAccountEthereumEmbeddedWallet | undefined;
  if (!embedded?.id) return Response.json({ error: "No Privy Ethereum wallet on this account yet." }, { status: 409 });

  const wallet = await privy.wallets().get(embedded.id);
  if (!wallet.additional_signers.some((s) => s.signer_id === env.PRIVY_SIGNER_ID)) {
    return Response.json({ error: "Allow payments first: our signer isn't on your wallet." }, { status: 409 });
  }

  await env.OAUTH_KV.delete(`pending:${req}`);
  const props: Props = { userId, walletId: wallet.id, address: wallet.address as `0x${string}` };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: pending.oauthReq,
    // The provider joins userId into "userId:grantId:secret" codes and tokens,
    // so the colons in a Privy DID ("did:privy:…") must not reach it.
    userId: userId.replace(/^did:privy:/, "").replaceAll(":", "_"),
    metadata: { clientName: pending.clientName, address: wallet.address },
    scope: pending.oauthReq.scope,
    props,
  });
  return Response.json({ redirectTo, address: wallet.address });
}

const defaultHandler: ExportedHandler<WorkerEnv> = {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/authorize" && request.method === "GET") return authorize(request, env);
    if (pathname === "/authorize/session" && request.method === "GET") return connectSession(request, env);
    if (pathname === "/authorize/complete" && request.method === "POST") return completeAuthorization(request, env);
    if (pathname === "/") return Response.json({ service: "x402-gateway-mcp", mcp: "/mcp", gateway: env.GATEWAY_URL });
    return Response.json({ error: "not_found" }, { status: 404 });
  },
};

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: mcpHandler,
  defaultHandler: defaultHandler as ExportedHandler<Env>,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  clientIdMetadataDocumentEnabled: true,
  scopesSupported: ["mcp"],
  resourceMetadata: {
    resource: `${moduleEnv.PUBLIC_URL}/mcp`,
    authorization_servers: [moduleEnv.PUBLIC_URL],
    scopes_supported: ["mcp"],
    resource_name: "x402 gateway: pay-per-call APIs",
  },
});
