// One-time Privy setup for the hosted MCP: creates the server's signing key,
// registers it as a key quorum (the "signer" users add to their wallet), and
// creates the policy that limits that signer to USDC x402 payments on Base
// Sepolia. Writes PRIVY_SIGNER_ID, PRIVY_POLICY_ID and PRIVY_SIGNER_KEY into
// .dev.vars; PRIVY_APP_ID and PRIVY_APP_SECRET must already be there.
//
//   bun run privy:setup

import { readFileSync, writeFileSync } from "node:fs";
import { PrivyClient } from "@privy-io/node";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
// Mirrors MAX_PER_CALL_USD: Privy refuses to sign any single payment above it.
const MAX_PER_CALL_ATOMIC = "100000";

const path = new URL("../.dev.vars", import.meta.url).pathname;
let vars = readFileSync(path, "utf8");
const get = (k: string) => vars.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() ?? "";
// Saved after every step, so a later failure never loses the signer key.
const set = (k: string, v: string) => {
  vars = new RegExp(`^${k}=`, "m").test(vars) ? vars.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`) : `${vars.trimEnd()}\n${k}=${v}\n`;
  writeFileSync(path, vars);
};

const appId = get("PRIVY_APP_ID");
const appSecret = get("PRIVY_APP_SECRET");
if (!appId || !appSecret) throw new Error("Set PRIVY_APP_ID and PRIVY_APP_SECRET in mcp/.dev.vars first.");
const privy = new PrivyClient({ appId, appSecret });

if (!get("PRIVY_SIGNER_KEY") || !get("PRIVY_SIGNER_ID")) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const b64 = (buf: ArrayBuffer) => Buffer.from(buf).toString("base64");
  const privateKey = b64(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const publicKey = b64(await crypto.subtle.exportKey("spki", pair.publicKey));
  const quorum = await privy.keyQuorums().create({ public_keys: [publicKey], authorization_threshold: 1, display_name: "x402 gateway MCP" });
  set("PRIVY_SIGNER_KEY", `wallet-auth:${privateKey}`);
  set("PRIVY_SIGNER_ID", quorum.id);
  console.log("signer (key quorum):", quorum.id);
}

if (!get("PRIVY_POLICY_ID")) {
  const policy = await privy.policies().create({
    version: "1.0",
    name: "x402 USDC payments on Base Sepolia",
    chain_type: "ethereum",
    rules: [
      {
        name: "USDC x402 payment up to per-call cap",
        method: "eth_signTypedData_v4",
        action: "ALLOW",
        conditions: [
          { field_source: "ethereum_typed_data_domain", field: "chainId", operator: "eq", value: "84532" },
          { field_source: "ethereum_typed_data_domain", field: "verifyingContract", operator: "in", value: [USDC, USDC.toLowerCase()] },
          {
            field_source: "ethereum_typed_data_message",
            typed_data: {
              primary_type: "TransferWithAuthorization",
              types: {
                TransferWithAuthorization: [
                  { name: "from", type: "address" },
                  { name: "to", type: "address" },
                  { name: "value", type: "uint256" },
                  { name: "validAfter", type: "uint256" },
                  { name: "validBefore", type: "uint256" },
                  { name: "nonce", type: "bytes32" },
                ],
              },
            },
            field: "value",
            operator: "lte",
            value: MAX_PER_CALL_ATOMIC,
          },
        ],
      },
    ],
  });
  set("PRIVY_POLICY_ID", policy.id);
  console.log("policy:", policy.id);
}

console.log("mcp/.dev.vars updated. Keep PRIVY_SIGNER_KEY safe: Privy can't recover it.");
