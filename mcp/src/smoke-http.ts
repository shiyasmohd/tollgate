// Drives the hosted MCP server over Streamable HTTP: list, check wallet, pay once.
//   MCP_URL=https://…/mcp MCP_TOKEN=… bun mcp/src/smoke-http.ts [body-json]

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(new URL(process.env.MCP_URL ?? "http://localhost:8787/mcp"), {
  requestInit: { headers: { authorization: `Bearer ${process.env.MCP_TOKEN}` } },
});
const client = new Client({ name: "smoke-http", version: "0.0.0" });
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
