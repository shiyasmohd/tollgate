// The x402-gateway MCP tools, shared by the local stdio server (index.ts) and
// the hosted Cloudflare Worker (worker.ts). Each entry supplies its own config:
// where the gateway is, which wallet pays, and where spending is tallied.

import { McpServer } from "@modelcontextprotocol/server";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createPublicClient, erc20Abi, formatUnits, http, type LocalAccount } from "viem";
import { baseSepolia, sepolia } from "viem/chains";
import { normalize, toCoinType } from "viem/ens";
import { z } from "zod";

const NETWORK = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/** Running total of what this wallet has spent in the current budget window. */
export interface SpendLedger {
  spent(): Promise<bigint>;
  record(amount: bigint): Promise<void>;
}

/** Any wallet that can sign EIP-712: a local key, or a Privy wallet via createViemAccount. */
export type PayingAccount = Pick<LocalAccount, "address" | "signTypedData">;

export interface ServerConfig {
  gatewayUrl: string;
  /** fetch used for every gateway request (a service binding on Workers). */
  fetch: typeof fetch;
  /** fetch for x402 services outside the gateway (pay_x402_url). Defaults to the global fetch. */
  externalFetch?: typeof fetch;
  account: PayingAccount | null;
  maxPerCall: bigint;
  budget: bigint;
  /** How the budget window reads to Claude, e.g. "session" or "24h". */
  budgetWindow: string;
  ledger: SpendLedger;
  /** Sepolia RPC for ENS lookups (endpoint names live on ENSv2 there). */
  sepoliaRpcUrl?: string;
  /** Keeps a binary response (audio, images, PDFs…) and returns where to get it: a URL or a file path. */
  storeFile: (bytes: Uint8Array, mimeType: string, extension: string) => Promise<string>;
}

export function usdToAtomic(usd: string): bigint {
  const [whole = "0", frac = ""] = usd.trim().split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.slice(0, 6).padEnd(6, "0"));
}
const atomicToUsd = (a: bigint) => formatUnits(a, 6);
const basescanTx = (hash: string) => `https://sepolia.basescan.org/tx/${hash}`;

/** An in-memory ledger: resets when the process restarts. */
export function memoryLedger(): SpendLedger {
  let total = 0n;
  return {
    spent: async () => total,
    record: async (amount) => {
      total += amount;
    },
  };
}

interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  method: string;
  price_usd: string;
  price_atomic: number;
  url: string;
  example: { query: string | null; body: string | null };
  accepts_body: boolean;
  pay_to: string;
  pay_to_risk?: { verdict: string; summary: string } | null;
  ens_name?: string | null;
}

/** Who a payment must go to and how much at most, and where that came from. */
interface Expected {
  payTo: string;
  amount: bigint;
  source: string;
}

/** The gateway's POST /screen answer (Intercepta, via the gateway, which holds the key). */
interface Screening {
  verdict: "allow" | "warn" | "block";
  enabled: boolean;
  summary: string;
  checks: { kind: string; label: string; status: string; reason: string; subject: string }[];
}

/** Thrown from inside the x402 client when screening stops a payment before it is signed. */
class ScreeningBlocked extends Error {
  constructor(readonly screening: Screening) {
    super(`Blocked by Intercepta: ${screening.summary}`);
  }
}

const EXTENSIONS: Record<string, string> = {
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/webm": "webm",
  "audio/aac": "aac", "audio/flac": "flac", "audio/mp4": "m4a", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
  "image/webp": "webp", "application/pdf": "pdf", "application/zip": "zip", "video/mp4": "mp4",
};
// Claude can look at these directly, so they also go back inline.
const INLINE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_INLINE_IMAGE_BYTES = 1_000_000;

/** The response body as text, or null when it's binary (declared non-text, or not valid UTF-8). */
function asText(bytes: Uint8Array, mimeType: string): string | null {
  if (/^(audio|image|video)\/|^application\/(pdf|zip|octet-stream)/.test(mimeType)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError } : {}) });

export function createServer(cfg: ServerConfig): McpServer {
  const chain = createPublicClient({ chain: baseSepolia, transport: http() });
  const ens = createPublicClient({ chain: sepolia, transport: http(cfg.sepoliaRpcUrl ?? "https://ethereum-sepolia-rpc.publicnode.com") });

  /** The Base Sepolia payout address an ENS name resolves to, or null if it doesn't (yet). */
  async function ensPayTo(name: string): Promise<string | null> {
    try {
      const addr = await ens.getEnsAddress({ name: normalize(name), coinType: toCoinType(baseSepolia.id) });
      return addr?.toLowerCase() ?? null;
    } catch {
      return null;
    }
  }

  async function catalog(): Promise<CatalogEntry[]> {
    const res = await cfg.fetch(`${cfg.gatewayUrl}/catalog`);
    if (!res.ok) throw new Error(`catalog returned ${res.status}`);
    return ((await res.json()) as { endpoints: CatalogEntry[] }).endpoints;
  }

  /** Asks the gateway to screen a payment with Intercepta. An unreachable screen blocks. */
  async function screen(body: Record<string, unknown>): Promise<Screening> {
    try {
      const res = await cfg.fetch(`${cfg.gatewayUrl}/screen`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      });
      if (res.ok) return (await res.json()) as Screening;
      throw new Error(`screen returned ${res.status}`);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return { verdict: "block", enabled: true, summary: `screening unavailable (${why})`, checks: [] };
    }
  }

  // A fresh client per call, so the checks below are bound to this call even
  // when several run concurrently. For catalog APIs the gateway's 402 quote must
  // match what the catalog advertised (a changed price or payout address is
  // refused, not paid). Any other x402 service has no catalog, so Intercepta
  // screening is the only thing between the agent and the payment.
  //
  // Screening runs twice before anything is signed: on the quote's payTo and
  // token when the payment is chosen, then on the exact TransferWithAuthorization
  // the wallet is about to sign.
  function payingFetch(
    account: PayingAccount,
    expected: Expected | null,
    spent: bigint,
    screenings: Screening[],
    doFetch: typeof fetch,
  ) {
    let quote: { payTo: string; amount: string } | null = null;
    const signer: PayingAccount = {
      address: account.address,
      signTypedData: (async (typed: Parameters<PayingAccount["signTypedData"]>[0]) => {
        const s = await screen({ pay_to: quote?.payTo, amount: quote?.amount, authorization: typed });
        screenings.push(s);
        if (s.verdict === "block") throw new ScreeningBlocked(s);
        return account.signTypedData(typed);
      }) as PayingAccount["signTypedData"],
    };
    const client = new x402Client();
    registerExactEvmScheme(client, { signer, networks: [NETWORK] });
    client.setSpendControls({ maxAmountPerPayment: `$${atomicToUsd(cfg.maxPerCall)}` });
    client.onBeforePaymentCreation(async ({ selectedRequirements: req }) => {
      const amount = BigInt(req.amount);
      if (expected && req.payTo.toLowerCase() !== expected.payTo) return { abort: true, reason: `payTo differs from the ${expected.source}` };
      if (expected && amount > expected.amount) return { abort: true, reason: `quoted $${atomicToUsd(amount)}, catalog says $${atomicToUsd(expected.amount)}` };
      if (amount > cfg.maxPerCall) return { abort: true, reason: `price exceeds the per-call limit ($${atomicToUsd(cfg.maxPerCall)})` };
      if (spent + amount > cfg.budget)
        return { abort: true, reason: `${cfg.budgetWindow} budget exhausted ($${atomicToUsd(spent)} of $${atomicToUsd(cfg.budget)} spent)` };
      const s = await screen({ pay_to: req.payTo, asset: req.asset });
      screenings.push(s);
      if (s.verdict === "block") return { abort: true, reason: `Blocked by Intercepta: ${s.summary}` };
      quote = { payTo: req.payTo, amount: req.amount };
    });
    return wrapFetchWithPayment(doFetch, client);
  }

  /** One line per screening check, for the tool result. */
  function screeningReport(screenings: Screening[]): string {
    if (!screenings.length) return "";
    if (screenings.every((s) => !s.enabled)) return "Screening: off (the gateway has no Intercepta API key).";
    const icon = (status: string) => (status === "pass" ? "✓" : status === "warn" ? "!" : status === "block" ? "✗" : "-");
    // The recipient is screened with the quote and again with the authorization; show it once.
    const checks = new Map<string, Screening["checks"][number]>();
    for (const c of screenings.flatMap((s) => s.checks)) checks.set(`${c.kind}:${c.subject}`, c);
    const lines = [...checks.values()].map((c) => `  ${icon(c.status)} ${c.label} ${c.subject}: ${c.reason}`);
    for (const s of screenings) if (!s.checks.length) lines.push(`  ✗ ${s.summary}`);
    const verdict = screenings.some((s) => s.verdict === "block")
      ? "BLOCKED"
      : screenings.some((s) => s.verdict === "warn")
        ? "allowed with warnings"
        : "passed";
    return [`Intercepta screening ${verdict}:`, ...lines].join("\n");
  }

  /** Pays for one request and turns the response into a tool result, with the receipt and the screening. */
  async function payAndRespond(opts: {
    account: PayingAccount;
    url: URL;
    init: RequestInit;
    expected: Expected | null;
    doFetch: typeof fetch;
    /** Extra lines for the result, e.g. the ENS check. */
    notes?: string[];
  }) {
    const screenings: Screening[] = [];
    const paidFetch = payingFetch(opts.account, opts.expected, await cfg.ledger.spent(), screenings, opts.doFetch);
    let res: Response;
    try {
      res = await paidFetch(opts.url, opts.init);
    } catch (e) {
      const report = screeningReport(screenings);
      if (screenings.some((s) => s.verdict === "block")) return text(`Payment blocked before signing. Nothing was signed or paid.\n${report}`, true);
      const message = e instanceof Error ? e.message : String(e);
      // x402's own spend controls only pay in known tokens, so a lookalike never reaches screening.
      if (/allowedAssets/.test(message)) {
        return text("Payment blocked before signing: the quote asks for a token that isn't USDC (possible lookalike). Nothing was signed or paid.", true);
      }
      return text(`Payment or request failed: ${message}${report ? `\n${report}` : ""}`, true);
    }

    let receipt = "Not charged.";
    const header = res.headers.get("payment-response");
    if (header) {
      try {
        const settle = decodePaymentResponseHeader(header);
        if (settle.success) {
          const amount = BigInt(settle.amount ?? opts.expected?.amount ?? 0);
          await cfg.ledger.record(amount);
          receipt = `Paid $${atomicToUsd(amount)} USDC on Base Sepolia: ${basescanTx(settle.transaction)}`;
        }
      } catch {
        receipt = "Payment response was unreadable.";
      }
    }
    // A 402 after paying means the payment was rejected (by the facilitator, or the
    // seller's own payer screening); say why.
    const required = res.status === 402 ? res.headers.get("payment-required") : null;
    if (required) {
      try {
        const reason = decodePaymentRequiredHeader(required).error;
        if (reason) receipt = `Not charged. Payment rejected: ${reason}. Check wallet_status for the USDC balance.`;
      } catch {}
    }
    const head = [receipt, ...(opts.notes ?? []), screeningReport(screenings)].filter(Boolean).join("\n");

    const bytes = new Uint8Array(await res.arrayBuffer());
    const mimeType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const raw = asText(bytes, mimeType);
    if (raw !== null) {
      const shown = raw.length > 8000 ? `${raw.slice(0, 8000)}\n…(truncated, ${raw.length} chars)` : raw;
      return text(`${head}\nHTTP ${res.status}\n\n${shown}`, !res.ok);
    }

    // Binary: decoding it as text would corrupt it, so keep the bytes and hand back where they are.
    const type = mimeType || "application/octet-stream";
    const location = await cfg.storeFile(bytes, type, EXTENSIONS[type] ?? "bin");
    const summary = `${head}\nHTTP ${res.status}\n\nThe API returned ${type} (${bytes.length.toLocaleString("en-US")} bytes). Saved at: ${location}`;
    const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text: summary }];
    if (INLINE_IMAGES.has(type) && bytes.length <= MAX_INLINE_IMAGE_BYTES) {
      content.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: type });
    }
    return { content, ...(res.ok ? {} : { isError: true }) };
  }

  const server = new McpServer({ name: "x402-gateway", version: "0.2.0" });

  server.registerTool(
    "list_paid_apis",
    {
      description:
        "List the pay-per-request APIs for sale on the x402 gateway: id, what each does, price per call in USDC, HTTP method and an example request. Call this before paid_fetch.",
      inputSchema: z.object({}),
    },
    async () => {
      const entries = await catalog();
      if (!entries.length) return text("No APIs are for sale right now.");
      const menu = entries.map((e) => ({
        endpoint_id: e.id,
        name: e.name,
        description: e.description,
        price_usd_per_call: e.price_usd,
        method: e.method,
        example_query: e.example.query,
        example_body: e.example.body,
        seller_risk: e.pay_to_risk ?? undefined,
        ens_name: e.ens_name ?? undefined,
      }));
      return text(JSON.stringify(menu, null, 2));
    },
  );

  server.registerTool(
    "paid_fetch",
    {
      description:
        "Call a paid API from list_paid_apis (by endpoint_id or its ENS name), paying its per-call price in USDC on Base Sepolia. Returns the API's response and the payment transaction. Non-text responses (audio, images, PDFs) are saved and returned as a link (valid 24h) or file path to pass on to the user. You are only charged if the API succeeds.",
      inputSchema: z.object({
        endpoint_id: z.string().describe("endpoint_id or ens_name from list_paid_apis, e.g. weather.tollgate.eth"),
        query: z.string().optional().describe("Query string without '?', e.g. 'q=lisbon&limit=3'"),
        body: z.string().optional().describe("Request body for POST/PUT/PATCH endpoints, usually JSON"),
      }),
    },
    async ({ endpoint_id, query, body }) => {
      if (!cfg.account) return text("Cannot pay: no buyer wallet is configured for this MCP server.", true);
      const entry = (await catalog()).find((e) => e.id === endpoint_id || e.ens_name === endpoint_id);
      if (!entry) return text(`Unknown endpoint_id "${endpoint_id}". Call list_paid_apis first.`, true);

      // The seller's payout address comes from ENS when the endpoint has a name:
      // a gateway that changed pay_to can't make the quote match the ENS record.
      let expected: Expected = { payTo: entry.pay_to.toLowerCase(), amount: BigInt(entry.price_atomic), source: "catalog" };
      const notes: string[] = [];
      if (entry.ens_name) {
        const onchain = await ensPayTo(entry.ens_name);
        if (onchain && onchain !== expected.payTo) {
          return text(`Refused: ${entry.ens_name} resolves to ${onchain}, but the catalog says pay ${expected.payTo}. Nothing was paid.`, true);
        }
        if (onchain) expected = { ...expected, source: `ENS record of ${entry.ens_name}` };
        notes.push(
          onchain
            ? `ENS: ${entry.ens_name} → ${onchain} (Base Sepolia), matches the payee.`
            : `ENS: ${entry.ens_name} doesn't resolve yet; checked against the catalog only.`,
        );
      }

      const url = new URL(entry.url);
      if (query) url.search = query.replace(/^\?/, "");
      const init: RequestInit = { method: entry.method, headers: { accept: "application/json" } };
      if (entry.accepts_body && body !== undefined) {
        init.body = body;
        init.headers = { ...init.headers, "content-type": "application/json" };
      }

      return payAndRespond({
        account: cfg.account,
        url,
        init,
        expected,
        doFetch: cfg.fetch,
        notes,
      });
    },
  );

  server.registerTool(
    "pay_x402_url",
    {
      description:
        "Pay any x402 service by URL (another agent, or a paid API not in list_paid_apis) in USDC on Base Sepolia. Before anything is signed, Intercepta screens the recipient address, the token and the exact payment authorization; a flagged payment is blocked and nothing is paid. Same per-call limit and budget as paid_fetch.",
      inputSchema: z.object({
        url: z.string().url().describe("The x402-protected https URL"),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().describe("HTTP method, default GET"),
        body: z.string().optional().describe("Request body for POST/PUT/PATCH, usually JSON"),
      }),
    },
    async ({ url: raw, method = "GET", body }) => {
      if (!cfg.account) return text("Cannot pay: no buyer wallet is configured for this MCP server.", true);
      const url = new URL(raw);
      // The gateway's own URLs go over cfg.fetch (a service binding on Workers).
      const internal = url.origin === new URL(cfg.gatewayUrl).origin;
      if (!internal && url.protocol !== "https:") return text("Only https URLs can be paid.", true);
      const init: RequestInit = { method, headers: { accept: "application/json" } };
      if (body !== undefined && method !== "GET" && method !== "DELETE") {
        init.body = body;
        init.headers = { ...init.headers, "content-type": "application/json" };
      }
      return payAndRespond({ account: cfg.account, url, init, expected: null, doFetch: internal ? cfg.fetch : (cfg.externalFetch ?? fetch) });
    },
  );

  server.registerTool(
    "screen_counterparty",
    {
      description:
        "Check a wallet address with Intercepta before dealing with it: sanctions, scams, phishing, rug pulls. Returns allow, warn or block with the reasons. Free; nothing is paid.",
      inputSchema: z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("0x address of the agent or seller") }),
    },
    async ({ address }) => {
      const s = await screen({ pay_to: address });
      return text(JSON.stringify({ address, verdict: s.verdict, summary: s.summary, checks: s.checks }, null, 2), s.verdict === "block");
    },
  );

  server.registerTool(
    "wallet_status",
    {
      description: "Show the buyer wallet's USDC balance on Base Sepolia and how much of its spending budget is used.",
      inputSchema: z.object({}),
    },
    async () => {
      if (!cfg.account) return text("No buyer wallet is configured for this MCP server.", true);
      const [balance, spent] = await Promise.all([
        chain.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [cfg.account.address] }),
        cfg.ledger.spent(),
      ]);
      return text(
        JSON.stringify(
          {
            address: cfg.account.address,
            usdc_balance: atomicToUsd(balance),
            budget_window: cfg.budgetWindow,
            spent_usd: atomicToUsd(spent),
            budget_usd: atomicToUsd(cfg.budget),
            max_per_call_usd: atomicToUsd(cfg.maxPerCall),
          },
          null,
          2,
        ),
      );
    },
  );

  return server;
}
