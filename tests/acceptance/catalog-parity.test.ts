import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OMRClient } from "@oh-my-router/client";
import { createOMRMcpServer } from "@oh-my-router/mcp";
import { ToolCatalog, v1ProviderCatalog } from "@oh-my-router/tools";
import { describe, expect, it } from "vitest";

import { createOMRRouter } from "../../apps/web/src/lib/server/router.js";
import { resolveScopedCatalog } from "../../apps/web/src/lib/server/scoped-catalog.js";

const execute = promisify(execFile);

/** Serve the real router over loopback for CLI and MCP protocol checks. */
async function serveCatalog(router: ReturnType<typeof createOMRRouter>) {
  const server = createServer(async (request, response) => {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${request.url}`;
    const result = await router.handle(new Request(url));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(await result.text());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

/** Exercise HTTP, the compiled CLI and MCP against exactly the same catalog response. */
describe("v1 catalog surface parity", () => {
  it("keeps Linear discoverable through HTTP, CLI and MCP when GitHub proof returns a plain 503", async () => {
    const catalog = await ToolCatalog.create({ providers: { list: () => ["github", "linear"].map((name) => ({
      name, displayName: name, version: "1.0.0", description: name,
      actions: { read: { name: "read", displayName: "Read", description: "Read resource",
        parameters: { type: "object", properties: {}, additionalProperties: false }, returns: {},
        contract: { version: "1.0.0", effect: "read" as const, requiredScopes: ["read"],
          resources: [], sensitiveKeys: [], pagination: { kind: "none" as const }, retry: "safe" as const },
      } },
    })) } }, (schema) => schema as never);
    const providers = ["github", "linear"].map((provider) => ({
      provider, displayName: provider, providerVersion: "1.0.0", description: provider,
      authMode: "oauth" as const, actionCount: 1, state: "ready" as const, available: true,
    }));
    const allowed = () => resolveScopedCatalog(catalog, providers,
      async (provider) => ({ id: `binding_${provider}`, providerConnectionId: provider }),
      async (connectionId) => {
        if (connectionId === "github") throw { status: 503 };
        return ["read"];
      }, async () => {});
    const router = createOMRRouter(undefined, undefined, {
      async discover(_request, input) {
        return { ...catalog.discover({ allowedToolIds: await allowed(), limit: input.limit }), providers };
      },
      async manifest(_request, id) { return (await allowed()).has(id) ? catalog.get(id) : null; },
    });
    const { baseUrl, close } = await serveCatalog(router);
    let mcp: Awaited<ReturnType<typeof createOMRMcpServer>> | undefined;
    let agent: Client | undefined;
    try {
      const api = new OMRClient({ baseUrl, credential: "test" });
      const httpPage = await api.discoverTools({ workspaceId: "workspace_1" });
      expect(httpPage.tools.map(({ id }) => id)).toEqual(["linear.read"]);
      await expect(api.getTool("github.read", "workspace_1")).rejects.toMatchObject({ status: 404 });
      await expect(api.getTool("linear.read", "workspace_1")).resolves.toMatchObject({ id: "linear.read" });
      const { stdout } = await execute(process.execPath,
        ["packages/cli/dist/bin.js", "tools", "list", "--json"], {
          env: { ...process.env, OMR_BACKEND: baseUrl, OMR_API_KEY: "test", OMR_WORKSPACE_ID: "workspace_1" },
        });
      expect(JSON.parse(stdout)).toEqual(httpPage);
      mcp = await createOMRMcpServer({ baseUrl, credential: "test", workspaceId: "workspace_1" });
      agent = new Client({ name: "github-proof-outage", version: "1.0.0" }, { capabilities: {} });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await mcp.connect(serverTransport);
      await agent.connect(clientTransport);
      expect((await agent.listTools()).tools.filter(({ name }) => name.endsWith(".read"))
        .map(({ name }) => name)).toEqual(["linear.read"]);
    } finally {
      await agent?.close().catch(() => undefined);
      await mcp?.close().catch(() => undefined);
      await close();
    }
  });

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
    let ready = true;
    let configured = true;
    let selectedMissing = false;
    const linear = {
      name: "linear", displayName: "Linear", version: "1.0.0", description: "Issues",
      auth: { type: "oauth2" }, actions: { get_issue: {} },
    };
    const providers = () => v1ProviderCatalog({
      get: (name) => name === "linear" ? linear : undefined,
      configured: (name) => name === "linear" && configured,
      connections: new Map([["linear", ready ? [{ status: "active", readiness: "ready" }] : []]]),
    });
    const router = createOMRRouter(undefined, undefined, {
      async discover(_request, input) {
        return {
          ...catalog.discover({ allowedProviders: new Set(ready && configured && !selectedMissing ? ["linear"] : []), limit: input.limit }),
          providers: providers(),
        };
      },
      async manifest(_request, toolId) { return ready ? catalog.get(toolId) : null; },
    });
    const { baseUrl, close } = await serveCatalog(router);
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
      expect(webPage.providers?.map(({ provider, state }) => [provider, state])).toEqual([
        ["github", "unsupported"], ["linear", "ready"],
        ["slack", "unsupported"], ["notion", "unsupported"],
      ]);
      const mcpProviders = async () => (await agent!.callTool({
        name: "omr.catalog.providers", arguments: {},
      })).structuredContent;
      expect(await mcpProviders()).toEqual({ catalogSchemaVersion: webPage.catalogSchemaVersion,
        revision: webPage.revision, providers: webPage.providers });
      ready = false;
      const disconnected = await api.discoverTools({ workspaceId: "workspace_1" });
      const { stdout: cliDisconnected } = await execute(process.execPath,
        ["packages/cli/dist/bin.js", "tools", "list", "--json"], {
          env: { ...process.env, OMR_BACKEND: baseUrl, OMR_API_KEY: "test", OMR_WORKSPACE_ID: "workspace_1" },
        });
      expect(disconnected.tools).toEqual([]);
      expect(JSON.parse(cliDisconnected)).toEqual(disconnected);
      expect(await mcpProviders()).toMatchObject({ providers: disconnected.providers });
      expect((await agent.listTools()).tools.some(({ name }) => name === webManifest.id)).toBe(false);
      configured = false;
      expect((await api.discoverTools({ workspaceId: "workspace_1" })).providers?.[1]?.state).toBe("unconfigured");
      expect(await mcpProviders()).toMatchObject({ providers: providers() });
      configured = true;
      ready = true;
      expect((await agent.listTools()).tools.find(({ name }) => name === webManifest.id)?._meta)
        .toMatchObject({ manifestHash: webManifest.hash });
      // The effective binding can be missing while another binding keeps provider readiness ready.
      selectedMissing = true;
      const missingPage = await api.discoverTools({ workspaceId: "workspace_1" });
      const { stdout: cliMissing } = await execute(process.execPath,
        ["packages/cli/dist/bin.js", "tools", "list", "--json"], {
          env: { ...process.env, OMR_BACKEND: baseUrl, OMR_API_KEY: "test", OMR_WORKSPACE_ID: "workspace_1" },
        });
      expect(missingPage.tools).toEqual([]);
      expect(missingPage.providers?.[1]?.state).toBe("ready");
      expect(JSON.parse(cliMissing)).toEqual(missingPage);
      expect(await mcpProviders()).toMatchObject({ providers: missingPage.providers });
      expect((await agent.listTools()).tools.some(({ name }) => name === webManifest.id)).toBe(false);
      selectedMissing = false;
      expect((await api.discoverTools({ workspaceId: "workspace_1" })).tools.map(({ id }) => id))
        .toEqual([webManifest.id]);
      expect((await agent.listTools()).tools.some(({ name }) => name === webManifest.id)).toBe(true);
    } finally {
      await agent?.close().catch(() => undefined);
      await mcp?.close().catch(() => undefined);
      await close();
    }
  });
});
