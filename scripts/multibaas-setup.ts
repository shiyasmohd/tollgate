// Points a Curvegrid MultiBaas deployment at Base Sepolia USDC for the gateway.
//
//   MULTIBAAS_URL=https://<id>.multibaas.com MULTIBAAS_ADMIN_KEY=… GATEWAY_URL=https://<gateway> bun multibaas:setup
//
// 1. checks the deployment is on Base Sepolia (84532)
// 2. adds the USDC Transfer ABI to the contract library as "usdc"
// 3. aliases the USDC address as "usdc" and links it, syncing events from the latest block
// 4. creates an event.emitted webhook to <gateway>/hooks/multibaas
//
// Safe to re-run: steps that already exist are skipped. It prints the vars and
// secrets to give the gateway. Create the deployment and an admin API key at
// console.curvegrid.com first (Admin → API Keys).

export {}; // a module, for top-level await

const MB = process.env.MULTIBAAS_URL?.replace(/\/+$/, "");
const KEY = process.env.MULTIBAAS_ADMIN_KEY;
const GATEWAY = process.env.GATEWAY_URL?.replace(/\/+$/, "");
const USDC = process.env.USDC_ADDRESS ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const LABEL = "usdc";
const BASE_SEPOLIA = 84532;

if (!MB || !KEY || !GATEWAY) {
  console.error("MULTIBAAS_URL, MULTIBAAS_ADMIN_KEY and GATEWAY_URL are required");
  process.exit(1);
}

// Only what the gateway reads: the ERC-20 Transfer event (USDC is a proxy; its full
// ABI isn't needed to index Transfers).
const ABI = [
  {
    type: "event",
    name: "Transfer",
    anonymous: false,
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

async function mb<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; result?: T; message?: string }> {
  const res = await fetch(`${MB}/api/v0${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { result?: T; message?: string };
  return { status: res.status, ...json };
}

/** Runs one step; a 409 or "already exists" counts as done. */
async function step(name: string, run: () => Promise<{ status: number; message?: string }>) {
  const r = await run();
  if (r.status < 300) return console.log(`✓ ${name}`);
  if (r.status === 409 || /exist/i.test(r.message ?? "")) return console.log(`• ${name} (already done)`);
  console.error(`✗ ${name}: HTTP ${r.status} ${r.message ?? ""}`);
  process.exit(1);
}

const chain = await mb<{ chainID: number; blockNumber: number }>("GET", "/chains/ethereum/status");
if (chain.status !== 200 || !chain.result) {
  console.error(`✗ can't reach MultiBaas: HTTP ${chain.status} ${chain.message ?? ""}`);
  process.exit(1);
}
if (chain.result.chainID !== BASE_SEPOLIA) {
  console.error(`✗ this deployment is on chain ${chain.result.chainID}; the gateway settles on Base Sepolia (${BASE_SEPOLIA})`);
  process.exit(1);
}
console.log(`✓ Base Sepolia deployment at block ${chain.result.blockNumber}`);
const syncFrom = new Date().toISOString();

// The library stores bytecode with every contract, but USDC is only read here, so
// its bytecode is left empty ("0x", or "" if MultiBaas rejects that).
await step("USDC ABI in the contract library", async () => {
  const add = (bin: string) =>
    mb("POST", `/contracts/${LABEL}`, { label: LABEL, contractName: "FiatToken", version: "1.0", bin, rawAbi: JSON.stringify(ABI) });
  const first = await add("0x");
  return first.status === 400 && !/exist/i.test(first.message ?? "") ? add("") : first;
});
await step(`alias "${LABEL}" → ${USDC}`, () => mb("POST", "/chains/ethereum/addresses", { alias: LABEL, address: USDC }));
await step("link USDC and sync its events from the latest block", () =>
  mb("POST", `/chains/ethereum/addresses/${LABEL}/contracts`, { label: LABEL, version: "1.0", startingBlock: "latest" }),
);

const hookUrl = `${GATEWAY}/hooks/multibaas`;
const existing = await mb<{ id: number; url: string }[]>("GET", "/webhooks");
let secret: string | undefined;
if (existing.result?.some((w) => w.url === hookUrl)) {
  console.log(`• webhook → ${hookUrl} (already done; its secret is on the Webhooks page)`);
} else {
  const created = await mb<{ secret: string }>("POST", "/webhooks", { label: "tollgate-gateway", url: hookUrl, subscriptions: ["event.emitted"] });
  if (created.status >= 300 || !created.result) {
    console.error(`✗ webhook: HTTP ${created.status} ${created.message ?? ""}`);
    process.exit(1);
  }
  secret = created.result.secret;
  console.log(`✓ webhook → ${hookUrl}`);
}

console.log(`
Give the gateway (worker/wrangler.jsonc vars):
  "MULTIBAAS_URL": "${MB}",
  "MULTIBAAS_SYNC_FROM": "${syncFrom}",

and its secrets (cd worker):
  bunx wrangler secret put MULTIBAAS_API_KEY          # an API key allowed to run event queries
  bunx wrangler secret put MULTIBAAS_WEBHOOK_SECRET   # ${secret ?? "from the Webhooks page"}

then deploy: bun run deploy`);
