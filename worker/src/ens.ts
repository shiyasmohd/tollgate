// ENSv2 names for paid endpoints, on Sepolia. Each endpoint that activates gets
// <label>.<ENS_PARENT> (e.g. weather.tollgate.eth) in the gateway's own subname
// registry. The seller owns the name; the gateway's Permissioned Resolver holds
// its records: the seller's payout address (mainnet and Base Sepolia coin types)
// and the paid URL, price and network as text. Agents resolve the name and
// refuse a 402 quote whose payTo differs from it.
//
// One-time setup (parent name, registry, resolver): scripts/ens-setup.ts.

import { bytesToHex, createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, labelhash, parseAbi, type Hex } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { normalize, packetToBytes, toCoinType } from "viem/ens";
import { atomicToUsd, updateEndpoint, type EndpointRow } from "./db";

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

const BASE_SEPOLIA_COIN_TYPE = toCoinType(84532);
const ONE_YEAR = 365 * 24 * 60 * 60;

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
function slug(name: string): string {
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
  const registry = env.ENS_REGISTRY as Hex;

  // The endpoint's name, or name + id suffix when another endpoint has it.
  let label = normalize(slug(ep.name) || ep.id.slice(3, 11));
  const state = await reader.readContract({ address: registry, abi: userRegistryAbi, functionName: "getState", args: [BigInt(labelhash(label))] });
  if (state.status !== 0) label = normalize(`${label}-${ep.id.slice(3, 9)}`);
  const name = `${label}.${env.ENS_PARENT}`;

  const { request } = await reader.simulateContract({
    account: wallet.account,
    address: registry,
    abi: userRegistryAbi,
    functionName: "register",
    args: [label, getAddress(ep.owner), "0x0000000000000000000000000000000000000000", env.ENS_RESOLVER as Hex, SELLER_ROLES, BigInt(Math.floor(Date.now() / 1000) + ONE_YEAR)],
  });
  await wallet.writeContract(request);
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
