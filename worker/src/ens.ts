// ENSv2 names for paid endpoints, on Sepolia. Each endpoint that activates gets
// a name owned by the seller; the gateway's Permissioned Resolver holds its
// records: the seller's payout address (mainnet and Base Sepolia coin types) and
// the paid URL, price and network as text. Agents resolve the name and refuse a
// 402 quote whose payTo differs from it.
//
// Sellers can claim a handle: <handle>.<ENS_PARENT> (hashir.tollgate.eth), backed
// by a UserRegistry of their own. Their endpoints are then named inside it
// (elevenlabs.hashir.tollgate.eth). Without a handle an endpoint is named
// <label>.<ENS_PARENT> in the gateway's registry.
//
//   <ENS_PARENT>                    gateway UserRegistry (ENS_REGISTRY)
//   ├── weather.<ENS_PARENT>        endpoint of a seller without a handle
//   └── hashir.<ENS_PARENT>         seller name → subregistry: the seller's UserRegistry
//       └── elevenlabs.hashir.…     endpoint name, registered in the seller's registry
//
// One-time setup (parent name, registry, resolver): scripts/ens-setup.ts.

import {
  bytesToHex, createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, getAddress, http, keccak256, labelhash,
  namehash, parseAbi, stringToHex, type Hex,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { normalize, packetToBytes, toCoinType } from "viem/ens";
import { atomicToUsd, getSeller, updateEndpoint, type EndpointRow } from "./db";

/** ENSv2 beta on Sepolia: https://docs.ens.domains/learn/deployments#sepolia-ensv2-beta */
export const ENS_V2 = {
  ethRegistry: "0x657ea849311d3d5823348dded7c2aaafb3ede09e",
  ethRegistrar: "0xabe76f6c8dfced81aa5a2bb8034202a7136b94ca",
  verifiableFactory: "0x9e726eb570beb6bceb495ab8cda7df517d4e841c",
  userRegistryImpl: "0xa80338aaa8d23831cea25e858d1774534abb0263",
  permissionedResolverImpl: "0x14f09fd05d4585759e54844dc9b00147131cf243",
  mockUsdc: "0x16f95d91dba7da3aca778ec053df0ff6c6a8aa8e",
} as const;

export const DEFAULT_SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

/** Every role and every admin role (one bit per 4-bit slot). */
export const ALL_ROLES = BigInt(`0x${"1".repeat(64)}`);

// Registry roles the seller gets on their endpoint name: they can move it to
// their own resolver or registry, and transfer it.
const ROLE_SET_SUBREGISTRY = 1n << 20n;
const ROLE_SET_RESOLVER = 1n << 24n;
const ROLE_CAN_TRANSFER_ADMIN = (1n << 28n) << 128n;
const SELLER_ROLES =
  ROLE_SET_SUBREGISTRY | (ROLE_SET_SUBREGISTRY << 128n) | ROLE_SET_RESOLVER | (ROLE_SET_RESOLVER << 128n) | ROLE_CAN_TRANSFER_ADMIN;

export const userRegistryAbi = parseAbi([
  "function initialize((address account, uint256 roleBitmap)[] grants)",
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)",
  "function getState(uint256 anyId) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))",
  "function setParent(address parent, string label)",
]);

export const resolverAbi = parseAbi([
  "function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)",
  "function setText(bytes name, string key, string value)",
  "function setAddress(bytes name, uint256 coinType, bytes addressBytes)",
  "function multicall(bytes[] calls) returns (bytes[])",
]);

const factoryAbi = parseAbi([
  "function deployProxy(address implementation, uint256 salt, bytes data) returns (address)",
]);

const BASE_SEPOLIA_COIN_TYPE = toCoinType(84532);
const ONE_YEAR = 365 * 24 * 60 * 60;
const ZERO = "0x0000000000000000000000000000000000000000";
const expiry = () => BigInt(Math.floor(Date.now() / 1000) + ONE_YEAR);

// ---- labels -----------------------------------------------------------------

/** A single DNS-style label: 3–32 of a-z, 0-9 and inner hyphens, no "--". */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

const RESERVED = new Set([
  "admin", "agent", "agents", "api", "app", "catalog", "dashboard", "demo", "docs", "ens", "eth", "gateway", "help", "mail",
  "null", "pay", "root", "status", "support", "system", "test", "tollgate", "undefined", "www", "x402",
]);

export type LabelCheck = { ok: true; label: string } | { ok: false; error: string };

/** Validates a handle or endpoint label a seller typed. */
export function checkLabel(raw: string, what = "handle"): LabelCheck {
  const label = raw.trim().toLowerCase();
  if (label.length < 3 || label.length > 32) return { ok: false, error: `${what} must be 3 to 32 characters` };
  if (!LABEL.test(label) || label.includes("--")) {
    return { ok: false, error: `${what} can use a-z, 0-9 and single hyphens, and can't start or end with a hyphen` };
  }
  if (RESERVED.has(label)) return { ok: false, error: `${what} "${label}" is reserved` };
  return { ok: true, label };
}

/** Whether a label is free in a registry. A registry that isn't deployed yet counts as empty. */
async function labelFree(reader: ReturnType<typeof clients>["reader"], registry: Hex, label: string): Promise<boolean> {
  try {
    const state = await reader.readContract({ address: registry, abi: userRegistryAbi, functionName: "getState", args: [BigInt(labelhash(label))] });
    return state.status === 0;
  } catch {
    return true;
  }
}

/** DNS wire format, which ENSv2 resolver setters take instead of a namehash. */
export const dnsEncode = (name: string): Hex => bytesToHex(packetToBytes(name));

export function ensEnabled(env: Env): boolean {
  return Boolean(env.ENS_PRIVATE_KEY && env.ENS_PARENT && env.ENS_REGISTRY && env.ENS_RESOLVER);
}

function clients(env: Env) {
  const transport = http(env.SEPOLIA_RPC_URL || DEFAULT_SEPOLIA_RPC);
  const account = privateKeyToAccount(env.ENS_PRIVATE_KEY as Hex, { nonceManager });
  return {
    reader: createPublicClient({ chain: sepolia, transport }),
    wallet: createWalletClient({ account, chain: sepolia, transport }),
  };
}

/** The endpoint's name as a label: "Weather API" → "weather-api". */
export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}

/** Records for an endpoint name, as resolver calls. */
function recordCalls(name: string, ep: EndpointRow, paidUrl: string, network: string): Hex[] {
  const dns = dnsEncode(name);
  const owner = getAddress(ep.owner);
  const addr = (coinType: bigint) => encodeFunctionData({ abi: resolverAbi, functionName: "setAddress", args: [dns, coinType, owner] });
  const text = (key: string, value: string) => encodeFunctionData({ abi: resolverAbi, functionName: "setText", args: [dns, key, value] });
  return [
    addr(60n),
    addr(BASE_SEPOLIA_COIN_TYPE),
    text("url", paidUrl),
    text("description", ep.description.slice(0, 280)),
    text("x402.endpoint", ep.id),
    text("x402.price", atomicToUsd(ep.price_atomic)),
    text("x402.network", network),
  ];
}

/**
 * Registers <label>.<ENS_PARENT> for a newly active endpoint, owned by the
 * seller, and writes its records. Sends the transactions without waiting for
 * them to be mined; the name resolves a block or so later.
 */
export async function assignEnsName(env: Env, ep: EndpointRow, origin: string): Promise<string> {
  const { reader, wallet } = clients(env);

  // Inside the seller's own registry when they have a handle, else the gateway's.
  // A seller registry that was only just deployed may not be mined yet: fall back.
  const seller = await getSeller(env.DB, ep.owner);
  const places: { registry: Hex; parent: string }[] = [{ registry: env.ENS_REGISTRY as Hex, parent: env.ENS_PARENT }];
  if (seller?.status === "registered" && seller.registry) places.unshift({ registry: seller.registry as Hex, parent: seller.ens_name });

  let name = "";
  for (const [i, place] of places.entries()) {
    // The label the seller picked, else the endpoint's name; + id suffix when taken.
    let label = normalize(ep.ens_label || slug(ep.name) || ep.id.slice(3, 11));
    if (!(await labelFree(reader, place.registry, label))) label = normalize(`${label.slice(0, 25)}-${ep.id.slice(3, 9)}`);
    try {
      const { request } = await reader.simulateContract({
        account: wallet.account,
        address: place.registry,
        abi: userRegistryAbi,
        functionName: "register",
        args: [label, getAddress(ep.owner), ZERO, env.ENS_RESOLVER as Hex, SELLER_ROLES, expiry()],
      });
      await wallet.writeContract(request);
      name = `${label}.${place.parent}`;
      break;
    } catch (e) {
      if (i === places.length - 1) throw e;
      console.warn(`ENS: can't name ${ep.id} under ${place.parent} yet, using ${env.ENS_PARENT}`, e);
    }
  }
  await wallet.writeContract({
    address: env.ENS_RESOLVER as Hex,
    abi: resolverAbi,
    functionName: "multicall",
    args: [recordCalls(name, ep, `${origin}/x/${ep.id}`, env.NETWORK)],
  });
  await updateEndpoint(env.DB, ep.id, { ens_name: name });
  return name;
}

/** Keeps the name's price record in step with the endpoint. */
export async function updateEnsPrice(env: Env, name: string, priceAtomic: number): Promise<void> {
  const { wallet } = clients(env);
  await wallet.writeContract({
    address: env.ENS_RESOLVER as Hex,
    abi: resolverAbi,
    functionName: "setText",
    args: [dnsEncode(name), "x402.price", atomicToUsd(priceAtomic)],
  });
}

// ---- seller names -----------------------------------------------------------

/** Whether <handle>.<ENS_PARENT> is still free on-chain (it shares the registry with flat endpoint names). */
export async function handleAvailable(env: Env, handle: string): Promise<boolean> {
  const { reader } = clients(env);
  return labelFree(reader, env.ENS_REGISTRY as Hex, handle);
}

/**
 * Names a seller: deploys a UserRegistry for them (the gateway and the seller
 * both get every role), registers <handle>.<ENS_PARENT> in the gateway's
 * registry with that as its subregistry, writes the seller's payout address as
 * its records and points the new registry at its parent.
 *
 * Every transaction is sent back to back without waiting to be mined: the
 * registry's address comes from simulating its deployment, and the one call to
 * the not-yet-deployed registry (setParent) carries an explicit gas limit. The
 * wallet's nonce order makes the deployment land first.
 */
export async function claimSellerName(env: Env, seller: string, handle: string): Promise<{ name: string; registry: Hex }> {
  const { reader, wallet } = clients(env);
  const owner = getAddress(seller);
  const name = `${handle}.${env.ENS_PARENT}`;

  // Salted with the time, so a retry after a failed attempt never collides with it.
  const salt = BigInt(
    keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }], [keccak256(stringToHex("SellerRegistry")), namehash(name), BigInt(Date.now())])),
  );
  const grants = [
    { account: wallet.account.address, roleBitmap: ALL_ROLES },
    { account: owner, roleBitmap: ALL_ROLES },
  ];
  const deploy = await reader.simulateContract({
    account: wallet.account,
    address: ENS_V2.verifiableFactory,
    abi: factoryAbi,
    functionName: "deployProxy",
    args: [ENS_V2.userRegistryImpl, salt, encodeFunctionData({ abi: userRegistryAbi, functionName: "initialize", args: [grants] })],
  });
  const registry = deploy.result;

  // Simulate the name registration before sending anything, so a taken handle fails cleanly.
  const register = await reader.simulateContract({
    account: wallet.account,
    address: env.ENS_REGISTRY as Hex,
    abi: userRegistryAbi,
    functionName: "register",
    args: [handle, owner, registry, env.ENS_RESOLVER as Hex, SELLER_ROLES, expiry()],
  });

  await wallet.writeContract(deploy.request);
  await wallet.writeContract(register.request);
  const dns = dnsEncode(name);
  await wallet.writeContract({
    address: env.ENS_RESOLVER as Hex,
    abi: resolverAbi,
    functionName: "multicall",
    args: [[
      encodeFunctionData({ abi: resolverAbi, functionName: "setAddress", args: [dns, 60n, owner] }),
      encodeFunctionData({ abi: resolverAbi, functionName: "setAddress", args: [dns, BASE_SEPOLIA_COIN_TYPE, owner] }),
      encodeFunctionData({ abi: resolverAbi, functionName: "setText", args: [dns, "description", `Seller on ${env.ENS_PARENT}`] }),
      encodeFunctionData({ abi: resolverAbi, functionName: "setText", args: [dns, "x402.network", env.NETWORK] }),
    ]],
  });
  // Can't be estimated before the registry exists, hence the fixed gas.
  await wallet.writeContract({ address: registry, abi: userRegistryAbi, functionName: "setParent", args: [env.ENS_REGISTRY as Hex, handle], gas: 250_000n });
  return { name, registry };
}
