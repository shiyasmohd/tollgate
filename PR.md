# Name paid endpoints on ENSv2 (Sepolia) and check payees against ENS in the MCP

Branch: `shiyasmohd/ens-endpoint-names` → `main`

## Summary

Every paid endpoint gets an ENSv2 name on Sepolia the first time it activates, for example `weather.tollgate-x402.eth`. The seller owns the name. Its records say where the money goes and what the endpoint is. The MCP resolves the name before it pays, and it refuses to pay when the gateway's catalog or 402 quote disagrees with the ENS record.

Until now the MCP checked the gateway's 402 quote against the gateway's own `/catalog`, so both sides of the check came from the gateway. The ENS record adds a check that lives on a public chain.

## How it works

```
seller: POST /api/endpoints/:id/test  (2xx → endpoint activates)
          │
          ▼  waitUntil (background, Sepolia)
gateway ── UserRegistry(<parent>.eth).register(label, owner = seller, resolver = gateway resolver, seller roles, +1y)
        └─ PermissionedResolver.multicall([setAddress ×2, setText ×5])
          │
          ▼  D1: endpoints.ens_name = "<label>.<parent>.eth"

agent:  paid_fetch("weather.tollgate-x402.eth")
          ├─ /catalog → entry with ens_name
          ├─ getEnsAddress(name, coinType = Base Sepolia) via Sepolia Universal Resolver
          │     ├─ differs from catalog pay_to → refuse, nothing paid
          │     └─ matches → the expected payee is now the ENS record
          └─ 402 quote → payTo must equal the ENS record → Intercepta screening → sign → pay
```

### ENS layout

```
<parent>.eth                     ETHRegistry → subregistry: gateway's UserRegistry, resolver: gateway's PermissionedResolver
└── <label>.<parent>.eth         UserRegistry token owned by the seller
      addr (60)                  seller payout address
      addr (Base Sepolia)        seller payout address   (coin type toCoinType(84532))
      text url                   https://<gateway>/x/<endpoint id>
      text description           endpoint description (first 280 chars)
      text x402.endpoint         ep_…
      text x402.price            USD per call, e.g. 0.01 (kept in sync on price PATCH)
      text x402.network          eip155:84532
```

- **Labels.** The label is the endpoint name in lowercase with runs of other characters turned into `-`, up to 32 characters, then run through ENS normalization. If that label is taken in the registry, the gateway appends `-<6 chars of the endpoint id>`.
- **Seller roles** on their own name (Enhanced Access Control): `ROLE_SET_RESOLVER` and `ROLE_SET_SUBREGISTRY` with their admin roles, plus `ROLE_CAN_TRANSFER_ADMIN`. The seller can move the name to their own resolver or registry, or transfer it.
- **Gateway roles.** The gateway key holds every role on its registry and its resolver.

## Changes

| File | Change |
|---|---|
| `worker/src/ens.ts` (new) | ENSv2 Sepolia addresses and ABIs. `assignEnsName` registers the subname, writes its records with one resolver `multicall` and stores `ens_name`. `updateEnsPrice`. `ensEnabled` |
| `worker/migrations/0003_ens.sql` (new) | `endpoints.ens_name TEXT` |
| `worker/src/routes/endpoints.ts` | On first activation, names the endpoint in `waitUntil`. On a price PATCH, updates the `x402.price` record |
| `worker/src/routes/catalog.ts` | Adds `ens_name` to each catalog entry |
| `worker/src/db.ts` | Adds `ens_name` to `EndpointRow` |
| `mcp/src/server.ts` | `paid_fetch` accepts an ENS name, resolves it on Sepolia and refuses a mismatch. Abort reasons name their source (catalog or ENS record). `list_paid_apis` shows `ens_name` |
| `mcp/src/index.ts` | Optional `SEPOLIA_RPC_URL` |
| `scripts/ens-setup.ts` (new) | One-time setup, see below |
| `worker/wrangler.jsonc`, `worker/worker-configuration.d.ts`, `worker/.dev.vars.example` | New vars `ENS_PARENT`, `ENS_REGISTRY`, `ENS_RESOLVER`, `SEPOLIA_RPC_URL` and the secret `ENS_PRIVATE_KEY` |
| `README.md` | "ENS names" section |

## Setup

The key needs a little Sepolia ETH for gas. The script mints the MockUSDC for the registration fee (about 8 MockUSDC per year).

```bash
ENS_PRIVATE_KEY=0x... ENS_LABEL=tollgate-x402 bun scripts/ens-setup.ts
```

The script does four things:

1. Deploys a `PermissionedResolver` and a `UserRegistry` proxy through the `VerifiableFactory`, with every role granted to the key. Re-running with `ENS_RESOLVER` / `ENS_REGISTRY` set reuses them.
2. Mints MockUSDC and approves the `ETHRegistrar`.
3. Runs commit → wait (`MIN_COMMITMENT_AGE` + 15s) → `register(<label>, key, secret, registry, resolver, 1y, MockUSDC, 0)`.
4. Calls `setParent(ETHRegistry, label)` on the registry, then prints the config to set.

Then:

```bash
# worker/wrangler.jsonc vars: ENS_PARENT, ENS_REGISTRY, ENS_RESOLVER (from the script output)
cd worker
bunx wrangler secret put ENS_PRIVATE_KEY
bun run migrate:remote
bun run deploy
```

When any of `ENS_PRIVATE_KEY`, `ENS_PARENT`, `ENS_REGISTRY` or `ENS_RESOLVER` is empty, ENS is off and the gateway behaves as before. The MCP only checks names that the catalog lists.

## Contracts used (ENSv2 beta, Sepolia)

| Contract | Address |
|---|---|
| ETHRegistry | `0x657ea849311d3d5823348dded7c2aaafb3ede09e` |
| ETHRegistrar | `0xabe76f6c8dfced81aa5a2bb8034202a7136b94ca` |
| VerifiableFactory | `0x9e726eb570beb6bceb495ab8cda7df517d4e841c` |
| UserRegistryImpl | `0xa80338aaa8d23831cea25e858d1774534abb0263` |
| PermissionedResolverImpl | `0x14f09fd05d4585759e54844dc9b00147131cf243` |
| MockUSDC | `0x16f95d91dba7da3aca778ec053df0ff6c6a8aa8e` |
| Universal Resolver (viem default) | `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe` → RootRegistry `0x9703…a9ce` → ETHRegistry above |

These are the addresses on [docs.ens.domains/learn/deployments](https://docs.ens.domains/learn/deployments). The `ensdomains/contracts-v2` repo's `main` source and its `deployments/sepolia*` folders are different, newer deployments with incompatible ABIs. The live resolver takes DNS-encoded names (`setText(bytes name, …)`, `setAddress(bytes name, uint256 coinType, bytes)`), and its `initialize` takes `(grants[], calls[])`. I took the ABIs from the verified contracts on Sourcify.

## Testing

- `bun run typecheck` passes for `worker` and `mcp`, and `scripts/ens-setup.ts` typechecks on its own.
- Read-only `eth_call` checks against live Sepolia:
  - Both `deployProxy` initializations simulate successfully.
  - `ETHRegistrar.isAvailable` and `getRegisterPrice` work.
  - The Universal Resolver path goes to the ETHRegistry above.
- **Not done:** no transactions were sent (the setup script hasn't been run), and the worker test suite wasn't run. ENS is off in tests because the vars are empty.

## Demo

1. Seller: `bun seller create …`, then `bun seller test ep_…`. The endpoint activates, and a block or so later `<label>.<parent>.eth` resolves. Check it on the ENS Explorer or with `getEnsAddress`.
2. Claude: "list the paid APIs" shows `ens_name`. Then "call weather.tollgate-x402.eth": the result shows `ENS: … → 0x… (Base Sepolia), matches the payee.` next to the payment receipt.
3. Tamper test: change an endpoint's `owner` in D1 (the catalog `pay_to`). `paid_fetch` then refuses with `Refused: <name> resolves to 0x…, but the catalog says pay 0x…. Nothing was paid.`

## Known limitations / follow-ups

- **The gateway resolver holds every record.** The gateway key could rewrite a name's address records, so for now the check catches a gateway whose catalog disagrees with ENS, not one that changes both. Next step: sellers get their own Permissioned Resolver and set `addr` themselves, and the gateway only gets setter roles for the `x402.*` text keys (`grantSetterRoles`).
- **The check depends on the catalog.** A catalog that drops `ens_name` skips it. Agents could look names up directly, for example by resolving `x402.endpoint`, instead of trusting the catalog.
- **Pending names.** Name transactions are sent without waiting to be mined. Until the name resolves, `paid_fetch` falls back to the catalog check and says so. A failed transaction is only logged and isn't retried.
- **No cleanup.** Deleting an endpoint doesn't unregister its name. Names expire after one year and aren't renewed.
- **Nonces.** The gateway uses viem's `nonceManager` for back-to-back sends within one isolate. Activations running at the same time in different isolates could still collide on nonces.
- **Not built yet:** agent names (`<user>.agents.<parent>.eth`) and record aliasing.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
