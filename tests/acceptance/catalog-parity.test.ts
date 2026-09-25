import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OMRClient } from "@oh-my-router/client";
import { createOMRMcpServer } from "@oh-my-router/mcp";
import { ToolCatalog } from "@oh-my-router/tools";
import { describe, expect, it } from "vitest";

import { createOMRRouter } from "../../apps/web/src/lib/server/router.js";

const execute = promisify(execFile);

/** Exercise HTTP, the compiled CLI and MCP against exactly the same catalog response. */
describe("v1 catalog surface parity", () => {
  it("preserves the tool id, JSON schema and hash across web, CLI and MCP", async () => {
    const catalog = await ToolCatalog.create({ providers: { list: () => [{
      name: "linear", displayName: "Linear", version: "1.0.0", description: "Issues",
      actions: { get_issue: {
        name: "get_issue", displayName: "Get issue", description: "Read a Linear issue",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        returns: { type: "object", properties: { title: { type: "string" } } },
        contract: { version: "1.0.0", effect: "read", requiredScopes: [], resources: [],
          sensitiveKeys: [], pagination: { kind: "none" }, retry: "safe" },
      } },
    }] } }, (schema) => schema as never);
    const router = createOMRRouter(undefined, undefined, {
      async discover(_request, input) {
        return {
          ...catalog.discover({ allowedProviders: new Set(["linear"]), limit: input.limit }),
          providers: [{ provider: "linear", displayName: "Linear", state: "ready", available: true }],
        };
      },
      async manifest(_request, toolId) { return catalog.get(toolId); },
    });
    const server = createServer(async (request, response) => {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${request.url}`;
      const result = await router.handle(new Request(url));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(await result.text());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    let mcp: Awaited<ReturnType<typeof createOMRMcpServer>> | undefined;
    let agent: Client | undefined;
    try {
      const api = new OMRClient({ baseUrl, credential: "test" });
      const webPage = await api.discoverTools({ workspaceId: "workspace_1" });
      const webManifest = await api.getTool("linear.get_issue", "workspace_1");
      const { stdout } = await execute(process.execPath, ["packages/cli/dist/bin.js", "tools", "list", "--json"], {
        env: { ...process.env, OMR_BACKEND: baseUrl, OMR_API_KEY: "test", OMR_WORKSPACE_ID: "workspace_1" },
      });
      const cliPage = JSON.parse(stdout) as typeof webPage;
      mcp = await createOMRMcpServer({ baseUrl, credential: "test", workspaceId: "workspace_1" });
      agent = new Client({ name: "catalog-parity", version: "1.0.0" }, { capabilities: {} });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await mcp.connect(serverTransport);
      await agent.connect(clientTransport);
      const mcpTool = (await agent.listTools()).tools.find(({ name }) => name === "linear.get_issue");
      expect(webPage.tools).toEqual([webManifest]);
      expect(cliPage).toEqual(webPage);
      expect(mcpTool?.name).toBe(webManifest.id);
      expect(mcpTool?.inputSchema).toEqual(webManifest.inputSchema);
      expect(mcpTool?.description).toBe(webManifest.description);
      expect(JSON.stringify(mcpTool)).toContain(webManifest.hash);
      expect(webPage.providers).toMatchObject([{ provider: "linear", state: "ready" }]);
    } finally {
      await agent?.close().catch(() => undefined);
      await mcp?.close().catch(() => undefined);
      server.close();
    }
  });
});
