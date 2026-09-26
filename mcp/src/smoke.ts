// Drives the MCP server over stdio like Claude would: list, check wallet, pay once.
//   BUYER_PRIVATE_KEY=0x… GATEWAY_URL=… bun mcp/src/smoke.ts [body-json]

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "bun",
  args: [new URL("./index.ts", import.meta.url).pathname],
  env: { ...process.env } as Record<string, string>,
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const show = (label: string, r: any) => console.log(`\n== ${label}${r.isError ? " (error)" : ""}\n${r.content?.[0]?.text}`);

const list: any = await client.callTool({ name: "list_paid_apis", arguments: {} });
show("list_paid_apis", list);
show("wallet_status", await client.callTool({ name: "wallet_status", arguments: {} }));

const first = JSON.parse(list.content[0].text)[0];
if (first) {
  show(
    `paid_fetch ${first.endpoint_id}`,
    await client.callTool({
      name: "paid_fetch",
      arguments: { endpoint_id: first.endpoint_id, body: process.argv[2] ?? first.example_body ?? undefined },
    }),
  );
}
await client.close();
