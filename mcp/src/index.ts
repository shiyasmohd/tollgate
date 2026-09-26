#!/usr/bin/env bun
// x402-gateway MCP server: lets Claude discover paid APIs and pay for them in
// USDC on Base Sepolia. Runs locally over stdio, so the buyer's key never leaves
// this machine. For the hosted version see worker.ts.
//
// Env:
//   GATEWAY_URL         the gateway, e.g. https://x402-gateway.<you>.workers.dev
//   BUYER_PRIVATE_KEY   0x… key of a wallet holding Base Sepolia USDC (no ETH needed)
//   MAX_PER_CALL_USD    refuse any single payment above this (default 0.10)
//   SESSION_BUDGET_USD  refuse payments once this much has been spent (default 1.00)

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { privateKeyToAccount } from "viem/accounts";
import { createServer, memoryLedger, usdToAtomic, type ServerConfig } from "./server";

const config: ServerConfig = {
  gatewayUrl: (process.env.GATEWAY_URL ?? "http://localhost:8787").replace(/\/$/, ""),
  fetch,
  account: process.env.BUYER_PRIVATE_KEY ? privateKeyToAccount(process.env.BUYER_PRIVATE_KEY as `0x${string}`) : null,
  maxPerCall: usdToAtomic(process.env.MAX_PER_CALL_USD ?? "0.10"),
  budget: usdToAtomic(process.env.SESSION_BUDGET_USD ?? "1.00"),
  budgetWindow: "session",
  ledger: memoryLedger(),
};

serveStdio(() => createServer(config));
