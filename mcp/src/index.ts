#!/usr/bin/env bun
// x402-gateway MCP server: lets Claude discover paid APIs and pay for them in
// USDC on Base Sepolia. Runs locally over stdio, so the buyer's key never leaves
// this machine.
//
// Env:
//   GATEWAY_URL         the gateway, e.g. https://x402-gateway.<you>.workers.dev
//   BUYER_PRIVATE_KEY   0x… key of a wallet holding Base Sepolia USDC (no ETH needed)
//   MAX_PER_CALL_USD    refuse any single payment above this (default 0.10)
//   SESSION_BUDGET_USD  refuse payments once this much has been spent (default 1.00)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createPublicClient, erc20Abi, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { z } from "zod";

const NETWORK = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const GATEWAY = (process.env.GATEWAY_URL ?? "http://localhost:8787").replace(/\/$/, "");
const MAX_PER_CALL = usdToAtomic(process.env.MAX_PER_CALL_USD ?? "0.10");
const BUDGET = usdToAtomic(process.env.SESSION_BUDGET_USD ?? "1.00");

function usdToAtomic(usd: string): bigint {
  const [whole = "0", frac = ""] = usd.trim().split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.slice(0, 6).padEnd(6, "0"));
}
const atomicToUsd = (a: bigint) => formatUnits(a, 6);
const basescanTx = (hash: string) => `https://sepolia.basescan.org/tx/${hash}`;

const account = process.env.BUYER_PRIVATE_KEY ? privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`) : null;
const chain = createPublicClient({ chain: baseSepolia, transport: http() });

// ---- spend control ---------------------------------------------------------

let spent = 0n;
// What the catalog advertised for the call in flight. The gateway's 402 quote
// must match it, so a changed price or payout address is refused, not paid.
let expected: { payTo: string; amount: bigint } | null = null;

let paidFetch: ReturnType<typeof wrapFetchWithPayment> | null = null;
if (account) {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account, networks: [NETWORK] });
  client.setSpendControls({ maxAmountPerPayment: `$${atomicToUsd(MAX_PER_CALL)}` });
  client.onBeforePaymentCreation(async ({ selectedRequirements: req }) => {
    const amount = BigInt(req.amount);
    if (!expected) return { abort: true, reason: "no call in flight" };
    if (req.payTo.toLowerCase() !== expected.payTo) return { abort: true, reason: "payTo differs from the catalog" };
    if (amount > expected.amount) return { abort: true, reason: `quoted $${atomicToUsd(amount)}, catalog says $${atomicToUsd(expected.amount)}` };
    if (amount > MAX_PER_CALL) return { abort: true, reason: `price exceeds MAX_PER_CALL_USD ($${atomicToUsd(MAX_PER_CALL)})` };
    if (spent + amount > BUDGET) return { abort: true, reason: `session budget exhausted ($${atomicToUsd(spent)} of $${atomicToUsd(BUDGET)} spent)` };
  });
  paidFetch = wrapFetchWithPayment(fetch, client);
}

// ---- catalog ---------------------------------------------------------------

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

async function catalog(): Promise<CatalogEntry[]> {
  const res = await fetch(`${GATEWAY}/catalog`);
  if (!res.ok) throw new Error(`catalog returned ${res.status}`);
  return ((await res.json()) as { endpoints: CatalogEntry[] }).endpoints;
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError } : {}) });

// ---- tools -----------------------------------------------------------------

const server = new McpServer({ name: "x402-gateway", version: "0.1.0" });

server.registerTool(
  "list_paid_apis",
  {
    description:
      "List the pay-per-request APIs for sale on the x402 gateway: id, what each does, price per call in USDC, HTTP method and an example request. Call this before paid_fetch.",
    inputSchema: {},
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
      "Call a paid API from list_paid_apis, paying its per-call price in USDC on Base Sepolia. Returns the API's response and the payment transaction. You are only charged if the API succeeds.",
    inputSchema: {
      endpoint_id: z.string().describe("endpoint_id from list_paid_apis"),
      query: z.string().optional().describe("Query string without '?', e.g. 'q=lisbon&limit=3'"),
      body: z.string().optional().describe("Request body for POST/PUT/PATCH endpoints, usually JSON"),
    },
  },
  async ({ endpoint_id, query, body }) => {
    if (!paidFetch) return text("Cannot pay: BUYER_PRIVATE_KEY is not set for this MCP server.", true);
    const entry = (await catalog()).find((e) => e.id === endpoint_id);
    if (!entry) return text(`Unknown endpoint_id "${endpoint_id}". Call list_paid_apis first.`, true);

    const url = new URL(entry.url);
    if (query) url.search = query.replace(/^\?/, "");
    const init: RequestInit = { method: entry.method, headers: { accept: "application/json" } };
    if (entry.accepts_body && body !== undefined) {
      init.body = body;
      init.headers = { ...init.headers, "content-type": "application/json" };
    }

    expected = { payTo: entry.pay_to.toLowerCase(), amount: BigInt(entry.price_atomic) };
    let res: Response;
    try {
      res = await paidFetch(url, init);
    } catch (e) {
      return text(`Payment or request failed: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      expected = null;
    }

    let receipt = "Not charged.";
    const header = res.headers.get("payment-response");
    if (header) {
      try {
        const settle = decodePaymentResponseHeader(header);
        if (settle.success) {
          const amount = BigInt(settle.amount ?? entry.price_atomic);
          spent += amount;
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
    const raw = await res.text();
    const shown = raw.length > 8000 ? `${raw.slice(0, 8000)}\n…(truncated, ${raw.length} chars)` : raw;
    return text(`${receipt}\nHTTP ${res.status}\n\n${shown}`, !res.ok);
  },
);

server.registerTool(
  "wallet_status",
  {
    description: "Show the buyer wallet's USDC balance on Base Sepolia and how much of this session's budget is spent.",
    inputSchema: {},
  },
  async () => {
    if (!account) return text("BUYER_PRIVATE_KEY is not set for this MCP server.", true);
    const balance = await chain.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    return text(
      JSON.stringify(
        {
          address: account.address,
          usdc_balance: atomicToUsd(balance),
          session_spent_usd: atomicToUsd(spent),
          session_budget_usd: atomicToUsd(BUDGET),
          max_per_call_usd: atomicToUsd(MAX_PER_CALL),
        },
        null,
        2,
      ),
    );
  },
);

await server.connect(new StdioServerTransport());
