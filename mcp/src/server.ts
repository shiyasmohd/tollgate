// The x402-gateway MCP tools, shared by the local stdio server (index.ts) and
// the hosted Cloudflare Worker (worker.ts). Each entry supplies its own config:
// where the gateway is, which wallet pays, and where spending is tallied.

import { McpServer } from "@modelcontextprotocol/server";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createPublicClient, erc20Abi, formatUnits, http, type LocalAccount } from "viem";
import { baseSepolia } from "viem/chains";
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
  account: PayingAccount | null;
  maxPerCall: bigint;
  budget: bigint;
  /** How the budget window reads to Claude, e.g. "session" or "24h". */
  budgetWindow: string;
  ledger: SpendLedger;
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

  async function catalog(): Promise<CatalogEntry[]> {
    const res = await cfg.fetch(`${cfg.gatewayUrl}/catalog`);
    if (!res.ok) throw new Error(`catalog returned ${res.status}`);
    return ((await res.json()) as { endpoints: CatalogEntry[] }).endpoints;
  }

  // A fresh client per call, so the quote check below is bound to this call
  // even when several run concurrently. The gateway's 402 quote must match
  // what the catalog advertised, so a changed price or payout address is
  // refused, not paid.
  function payingFetch(account: PayingAccount, expected: { payTo: string; amount: bigint }, spent: bigint) {
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: account, networks: [NETWORK] });
    client.setSpendControls({ maxAmountPerPayment: `$${atomicToUsd(cfg.maxPerCall)}` });
    client.onBeforePaymentCreation(async ({ selectedRequirements: req }) => {
      const amount = BigInt(req.amount);
      if (req.payTo.toLowerCase() !== expected.payTo) return { abort: true, reason: "payTo differs from the catalog" };
      if (amount > expected.amount) return { abort: true, reason: `quoted $${atomicToUsd(amount)}, catalog says $${atomicToUsd(expected.amount)}` };
      if (amount > cfg.maxPerCall) return { abort: true, reason: `price exceeds the per-call limit ($${atomicToUsd(cfg.maxPerCall)})` };
      if (spent + amount > cfg.budget)
        return { abort: true, reason: `${cfg.budgetWindow} budget exhausted ($${atomicToUsd(spent)} of $${atomicToUsd(cfg.budget)} spent)` };
    });
    return wrapFetchWithPayment(cfg.fetch, client);
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
      }));
      return text(JSON.stringify(menu, null, 2));
    },
  );

  server.registerTool(
    "paid_fetch",
    {
      description:
        "Call a paid API from list_paid_apis, paying its per-call price in USDC on Base Sepolia. Returns the API's response and the payment transaction. Non-text responses (audio, images, PDFs) are saved and returned as a link (valid 24h) or file path to pass on to the user. You are only charged if the API succeeds.",
      inputSchema: z.object({
        endpoint_id: z.string().describe("endpoint_id from list_paid_apis"),
        query: z.string().optional().describe("Query string without '?', e.g. 'q=lisbon&limit=3'"),
        body: z.string().optional().describe("Request body for POST/PUT/PATCH endpoints, usually JSON"),
      }),
    },
    async ({ endpoint_id, query, body }) => {
      if (!cfg.account) return text("Cannot pay: no buyer wallet is configured for this MCP server.", true);
      const entry = (await catalog()).find((e) => e.id === endpoint_id);
      if (!entry) return text(`Unknown endpoint_id "${endpoint_id}". Call list_paid_apis first.`, true);

      const url = new URL(entry.url);
      if (query) url.search = query.replace(/^\?/, "");
      const init: RequestInit = { method: entry.method, headers: { accept: "application/json" } };
      if (entry.accepts_body && body !== undefined) {
        init.body = body;
        init.headers = { ...init.headers, "content-type": "application/json" };
      }

      const paidFetch = payingFetch(
        cfg.account,
        { payTo: entry.pay_to.toLowerCase(), amount: BigInt(entry.price_atomic) },
        await cfg.ledger.spent(),
      );
      let res: Response;
      try {
        res = await paidFetch(url, init);
      } catch (e) {
        return text(`Payment or request failed: ${e instanceof Error ? e.message : String(e)}`, true);
      }

      let receipt = "Not charged.";
      const header = res.headers.get("payment-response");
      if (header) {
        try {
          const settle = decodePaymentResponseHeader(header);
          if (settle.success) {
            const amount = BigInt(settle.amount ?? entry.price_atomic);
            await cfg.ledger.record(amount);
            receipt = `Paid $${atomicToUsd(amount)} USDC on Base Sepolia: ${basescanTx(settle.transaction)}`;
          }
        } catch {
          receipt = "Payment response was unreadable.";
        }
      }
      // A 402 after paying means the facilitator rejected the payment; say why.
      const required = res.status === 402 ? res.headers.get("payment-required") : null;
      if (required) {
        try {
          const reason = decodePaymentRequiredHeader(required).error;
          if (reason) receipt = `Not charged. Payment rejected: ${reason}. Check wallet_status for the USDC balance.`;
        } catch {}
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const mimeType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const raw = asText(bytes, mimeType);
      if (raw !== null) {
        const shown = raw.length > 8000 ? `${raw.slice(0, 8000)}\n…(truncated, ${raw.length} chars)` : raw;
        return text(`${receipt}\nHTTP ${res.status}\n\n${shown}`, !res.ok);
      }

      // Binary: decoding it as text would corrupt it, so keep the bytes and hand back where they are.
      const type = mimeType || "application/octet-stream";
      const location = await cfg.storeFile(bytes, type, EXTENSIONS[type] ?? "bin");
      const summary = `${receipt}\nHTTP ${res.status}\n\nThe API returned ${type} (${bytes.length.toLocaleString("en-US")} bytes). Saved at: ${location}`;
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text: summary }];
      if (INLINE_IMAGES.has(type) && bytes.length <= MAX_INLINE_IMAGE_BYTES) {
        content.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: type });
      }
      return { content, ...(res.ok ? {} : { isError: true }) };
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
