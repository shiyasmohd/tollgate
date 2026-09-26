// One-time ENSv2 setup on Sepolia for endpoint names (worker/src/ens.ts):
//
//   ENS_PRIVATE_KEY=0x… ENS_LABEL=tollgate-x402 bun scripts/ens-setup.ts
//
// 1. deploys the gateway's Permissioned Resolver and a UserRegistry for the
//    parent name through the VerifiableFactory, with the key holding every role
// 2. registers <ENS_LABEL>.eth through the ETHRegistrar (commit, wait, register),
//    paying in MockUSDC it mints, with the registry and resolver set
// 3. prints the wrangler vars and secret to set
//
// The key needs a little Sepolia ETH for gas. Re-running after a failure:
// pass ENS_RESOLVER / ENS_REGISTRY to reuse what was already deployed.

import {
  createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, erc20Abi, formatEther, getAddress,
  http, keccak256, parseAbi, parseEventLogs, stringToHex, toHex, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { namehash } from "viem/ens";
import { ALL_ROLES, DEFAULT_SEPOLIA_RPC, ENS_V2, resolverAbi, userRegistryAbi } from "../worker/src/ens";

const pk = process.env.ENS_PRIVATE_KEY as Hex | undefined;
const label = process.env.ENS_LABEL;
if (!pk || !label) {
  console.error("ENS_PRIVATE_KEY and ENS_LABEL are required");
  process.exit(1);
}
const parent = `${label}.eth`;
const account = privateKeyToAccount(pk);
const transport = http(process.env.SEPOLIA_RPC_URL || DEFAULT_SEPOLIA_RPC);
const reader = createPublicClient({ chain: sepolia, transport });
const wallet = createWalletClient({ account, chain: sepolia, transport });

const factoryAbi = parseAbi([
  "function deployProxy(address implementation, uint256 salt, bytes data) returns (address)",
  "event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)",
]);
const registrarAbi = parseAbi([
  "function isAvailable(string label) view returns (bool)",
  "function MIN_COMMITMENT_AGE() view returns (uint64)",
  "function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)",
  "function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) pure returns (bytes32)",
  "function commit(bytes32 commitment)",
  "function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256)",
]);
const mockUsdcAbi = parseAbi(["function mint(address to, uint256 amount)"]);

async function send(what: string, tx: Promise<Hex>) {
  const hash = await tx;
  const receipt = await reader.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${what} reverted: ${hash}`);
  console.log(`  ✓ ${what}  https://sepolia.etherscan.io/tx/${hash}`);
  return receipt;
}

/** Deploys a proxy through the VerifiableFactory and returns its address from the event. */
async function deployProxy(what: string, implementation: Hex, salt: bigint, data: Hex): Promise<Hex> {
  const receipt = await send(
    `deploy ${what}`,
    wallet.writeContract({ address: ENS_V2.verifiableFactory, abi: factoryAbi, functionName: "deployProxy", args: [implementation, salt, data] }),
  );
  const [log] = parseEventLogs({ abi: factoryAbi, eventName: "ProxyDeployed", logs: receipt.logs });
  if (!log) throw new Error(`no ProxyDeployed event for ${what}`);
  return log.args.proxyAddress;
}

const saltFor = (kind: string) =>
  BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }], [keccak256(stringToHex(kind)), namehash(parent), 0n])));

console.log(`Setting up ${parent} on Sepolia ENSv2 from ${account.address} (${formatEther(await reader.getBalance({ address: account.address }))} ETH)`);

const available = await reader.readContract({ address: ENS_V2.ethRegistrar, abi: registrarAbi, functionName: "isAvailable", args: [label] });
if (!available) {
  console.error(`${parent} is taken; pick another ENS_LABEL`);
  process.exit(1);
}

const grants = [{ account: account.address, roleBitmap: ALL_ROLES }];
const resolver =
  (process.env.ENS_RESOLVER as Hex | undefined) ??
  (await deployProxy(
    "PermissionedResolver",
    ENS_V2.permissionedResolverImpl,
    saltFor("PermissionedResolver"),
    encodeFunctionData({ abi: resolverAbi, functionName: "initialize", args: [grants, []] }),
  ));
const registry =
  (process.env.ENS_REGISTRY as Hex | undefined) ??
  (await deployProxy(
    "UserRegistry",
    ENS_V2.userRegistryImpl,
    saltFor("UserRegistry"),
    encodeFunctionData({ abi: userRegistryAbi, functionName: "initialize", args: [grants] }),
  ));
console.log(`  resolver ${resolver}\n  registry ${registry}`);

// Register the parent: pay in MockUSDC (anyone can mint it), commit, wait, register.
const duration = BigInt(365 * 24 * 60 * 60);
const [base, premium] = await reader.readContract({
  address: ENS_V2.ethRegistrar, abi: registrarAbi, functionName: "getRegisterPrice", args: [label, duration, ENS_V2.mockUsdc],
});
const price = base + premium;
await send("mint MockUSDC", wallet.writeContract({ address: ENS_V2.mockUsdc, abi: mockUsdcAbi, functionName: "mint", args: [account.address, price] }));
await send("approve registrar", wallet.writeContract({ address: ENS_V2.mockUsdc, abi: erc20Abi, functionName: "approve", args: [ENS_V2.ethRegistrar, price] }));

const secret = toHex(crypto.getRandomValues(new Uint8Array(32)));
const referrer = toHex(0, { size: 32 });
const commitment = await reader.readContract({
  address: ENS_V2.ethRegistrar, abi: registrarAbi, functionName: "makeCommitment",
  args: [label, account.address, secret, registry, resolver, duration, referrer],
});
await send("commit", wallet.writeContract({ address: ENS_V2.ethRegistrar, abi: registrarAbi, functionName: "commit", args: [commitment] }));
const wait = Number(await reader.readContract({ address: ENS_V2.ethRegistrar, abi: registrarAbi, functionName: "MIN_COMMITMENT_AGE" })) + 15;
console.log(`  waiting ${wait}s for the commitment to mature…`);
await new Promise((r) => setTimeout(r, wait * 1000));
await send(
  `register ${parent}`,
  wallet.writeContract({
    address: ENS_V2.ethRegistrar, abi: registrarAbi, functionName: "register",
    args: [label, account.address, secret, registry, resolver, duration, ENS_V2.mockUsdc, referrer],
  }),
);
// Canonical parent, so the registry knows it is <label>.eth.
await send("set registry parent", wallet.writeContract({ address: registry, abi: userRegistryAbi, functionName: "setParent", args: [ENS_V2.ethRegistry, label] }));

console.log(`
Done. ${parent} → registry ${registry}, resolver ${resolver}.
Set in worker/wrangler.jsonc vars:
  "ENS_PARENT": "${parent}",
  "ENS_REGISTRY": "${getAddress(registry)}",
  "ENS_RESOLVER": "${getAddress(resolver)}",
and the secret:
  cd worker && bunx wrangler secret put ENS_PRIVATE_KEY`);
