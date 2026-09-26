// Seller auth: Sign-In with Ethereum, then a short-lived HS256 bearer token.
// verifySiweMessage goes through a Base Sepolia client so smart-contract wallets
// (ERC-1271 / ERC-6492, e.g. Coinbase Smart Wallet) can sign in, not just EOAs.

import { Hono, type MiddlewareHandler } from "hono";
import { sign, verify } from "hono/jwt";
import { createPublicClient, http, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { generateSiweNonce, parseSiweMessage } from "viem/siwe";
import { z } from "zod";
import { consumeNonce, insertNonce } from "./db";
import type { AppEnv, Address } from "./types";

const NONCE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_S = 24 * 60 * 60;

const baseSepoliaClient = createPublicClient({ chain: baseSepolia, transport: http() });

export const auth = new Hono<AppEnv>();

auth.get("/nonce", async (c) => {
  const nonce = generateSiweNonce();
  await insertNonce(c.env.DB, nonce, Date.now() + NONCE_TTL_MS);
  return c.json({ nonce });
});

const VerifyBody = z.object({
  message: z.string().min(1).max(4000),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

auth.post("/verify", async (c) => {
  const parsedBody = VerifyBody.safeParse(await c.req.json().catch(() => null));
  if (!parsedBody.success) return c.json({ error: "message and signature are required" }, 400);
  const { message, signature } = parsedBody.data;

  const siwe = parseSiweMessage(message);
  if (!siwe.address || !siwe.nonce) return c.json({ error: "malformed SIWE message" }, 400);
  // Consume first: a nonce is single use even if the signature turns out bad.
  if (!(await consumeNonce(c.env.DB, siwe.nonce, Date.now()))) {
    return c.json({ error: "unknown or expired nonce" }, 401);
  }

  const valid = await baseSepoliaClient
    .verifySiweMessage({ message, signature: signature as Hex, domain: new URL(c.req.url).host })
    .catch(() => false);
  if (!valid) return c.json({ error: "invalid signature" }, 401);

  const address = siwe.address.toLowerCase() as Address;
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const token = await sign({ sub: address, exp }, c.env.SESSION_SECRET, "HS256");
  return c.json({ token, address, expires_at: exp * 1000 });
});

export const requireSeller: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return c.json({ error: "unauthorized" }, 401);
  try {
    const payload = await verify(token, c.env.SESSION_SECRET, "HS256");
    if (typeof payload.sub !== "string") throw new Error("no subject");
    c.set("seller", payload.sub as Address);
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
};
