import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OMRClient } from "@oh-my-router/client";
import { ConnectionAuthority } from "@oh-my-router/connections";
import { PlugFnConnectionOrchestrator, type PlugFnConnectionPort } from "@oh-my-router/connections";
import { MemoryConnectionBindingStore } from "@oh-my-router/connections/testing";
import { WorkspaceAuthority } from "@oh-my-router/identity";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";
import { createOMRMcpServer } from "@oh-my-router/mcp";
import { ToolCatalog, type ProviderStatus } from "@oh-my-router/tools";
import { describe, expect, it } from "vitest";

import { createOMRRouter, type ConnectionRouteServices, type ExecutionRouteServices } from
  "../../apps/web/src/lib/server/router.js";
import { resolveScopedCatalog } from "../../apps/web/src/lib/server/scoped-catalog.js";

const exec = promisify(execFile);
const actorUserId = "user_owner";
const provider = "github";
const providerStatus: ProviderStatus = {
  provider, displayName: "GitHub", providerVersion: "1.0.0", description: "",
  authMode: "oauth", actionCount: 2, state: "ready", available: true,
};

/** The router, CLI and long-lived MCP server share a real binding authority. */
describe("effective connection selection across public surfaces", () => {
  it("requires a deliberate choice, applies its scopes, and rejects inaccessible selections", async () => {
    const workspaceStore = new MemoryWorkspaceStore();
    // Use the same workspace store for both membership and connection authorization.
    const authority = new WorkspaceAuthority(workspaceStore, () => 1000);
    const { workspace } = await authority.createTeam({ ownerUserId: actorUserId, name: "Catalog" });
    const bindings = new ConnectionAuthority(new MemoryConnectionBindingStore(workspaceStore), () => 1000);
    const profile = await bindings.attach({ actorUserId, workspaceId: workspace.id, provider,
      providerConnectionId: "remote_profile", ownership: "personal", label: "Profile" });
    const repo = await bindings.attach({ actorUserId, workspaceId: workspace.id, provider,
      providerConnectionId: "remote_repo", ownership: "personal", label: "Repository" });
    const stripe = await bindings.attach({ actorUserId, workspaceId: workspace.id, provider: "stripe",
      providerConnectionId: "remote_stripe", ownership: "personal", label: "Legacy Stripe" });
    const integrationConfig = { integrations: { github: { type: "oauth2" } } };
    const orchestrator = new PlugFnConnectionOrchestrator(bindings, {
      config: integrationConfig,
      providers: { get: (name: string) => name === "github" || name === "stripe" ? {
        name, displayName: name, auth: { type: "oauth2" }, actions: {},
      } : undefined },
    } as unknown as PlugFnConnectionPort);
    const grants = new Map([["remote_profile", ["read:user"]], ["remote_repo", ["repo"]]]);
    const catalog = await ToolCatalog.create({ providers: { list: () => [{
      name: provider, displayName: "GitHub", version: "1.0.0", description: "",
      actions: Object.fromEntries(["profile", "repo"].map((name) => [name, {
        name, displayName: name, description: name,
        parameters: { type: "object", properties: {}, additionalProperties: false }, returns: {},
        contract: { version: "1.0.0", effect: "read", requiredScopes: [name === "profile" ? "read:user" : "repo"],
          resources: [], sensitiveKeys: [], pagination: { kind: "none" }, retry: "safe" },
      }])),
    }] } }, (schema) => schema as never);
    const allowed = () => resolveScopedCatalog(catalog, [providerStatus],
      async (name) => bindings.resolve({ actorUserId, workspaceId: workspace.id, provider: name }),
      async (id) => grants.get(id), async () => {});
    const connectionServices = {
      list: async () => orchestrator.listAvailable({ actorUserId, workspaceId: workspace.id }),
      select: async (_request: Request, input: { workspaceId: string; provider: string; connectionId: string }) =>
        orchestrator.select({ actorUserId, ...input }),
    } as unknown as ConnectionRouteServices;
    const executionServices = {
      execute: async (_request: Request, input: { workspaceId: string; toolId: string }) => {
        const binding = await bindings.resolve({ actorUserId, workspaceId: input.workspaceId, provider });
        const manifest = catalog.get(input.toolId);
        if (!manifest || !manifest.contract.requiredScopes.every((scope) =>
          grants.get(binding.providerConnectionId)?.includes(scope))) throw new Error("Missing scope");
        return { bindingId: binding.id, toolId: input.toolId };
      },
    } as unknown as ExecutionRouteServices;
    const router = createOMRRouter(undefined, connectionServices, {
      discover: async (_request, input) => ({ ...catalog.discover({ allowedToolIds: await allowed(), limit: input.limit }),
        providers: [providerStatus] }),
      manifest: async (_request, id) => (await allowed()).has(id) ? catalog.get(id) : null,
    }, executionServices);
    const server = createServer(async (request, response) => {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${request.url}`;
      const result = await router.handle(new Request(url, {
        method: request.method,
        ...(request.method === "POST" ? {
          headers: { "content-type": "application/json" },
          body: await new Promise<string>((resolve) => {
            let body = "";
            request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
            request.on("end", () => resolve(body));
          }),
        } : {}),
      }));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(await result.text());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    let mcp: Awaited<ReturnType<typeof createOMRMcpServer>> | undefined;
    let agent: Client | undefined;
    try {
      const api = new OMRClient({ baseUrl, credential: "test" });
      const cli = async (...args: string[]) => JSON.parse((await exec(process.execPath,
        ["packages/cli/dist/bin.js", ...args, "--json"], {
          env: { ...process.env, OMR_BACKEND: baseUrl, OMR_API_KEY: "test", OMR_WORKSPACE_ID: workspace.id },
        })).stdout) as unknown;
      expect(await api.listConnections(workspace.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: stripe.id, providerState: "unsupported", selectable: false }),
      ]));
      await expect(api.selectConnection({ workspaceId: workspace.id, provider: "stripe", connectionId: stripe.id }))
        .rejects.toMatchObject({ status: 409, body: { state: "unsupported" } });
      integrationConfig.integrations = {} as typeof integrationConfig.integrations;
      expect(await cli("connections", "list")).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: profile.id, providerState: "unconfigured", selectable: false }),
      ]));
      await expect(api.selectConnection({ workspaceId: workspace.id, provider, connectionId: profile.id }))
        .rejects.toMatchObject({ status: 409, body: { state: "unconfigured" } });
      integrationConfig.integrations = { github: { type: "oauth2" } };
      expect((await api.discoverTools({ workspaceId: workspace.id })).tools).toEqual([]);
      await expect(api.getTool("github.repo", workspace.id)).rejects.toMatchObject({ status: 404 });
      await expect(api.execute({ workspaceId: workspace.id, toolId: "github.repo", params: {} }))
        .rejects.toMatchObject({ status: 409 });
      mcp = await createOMRMcpServer({ baseUrl, credential: "test", workspaceId: workspace.id });
      agent = new Client({ name: "selection", version: "1.0.0" }, { capabilities: {} });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await mcp.connect(serverTransport);
      await agent.connect(clientTransport);
      expect((await agent.callTool({ name: "omr.connections.list", arguments: {} })).structuredContent)
        .toMatchObject({ connections: expect.arrayContaining([
          expect.objectContaining({ id: stripe.id, providerState: "unsupported", selectable: false }),
        ]) });
      await expect(agent.callTool({ name: "omr.connections.select",
        arguments: { provider: "stripe", connectionId: stripe.id } }))
        .resolves.toMatchObject({ isError: true, structuredContent: { error: { details: { state: "unsupported" } } } });
      expect((await agent.listTools()).tools.filter(({ name }) => name.startsWith("github."))).toEqual([]);
      await expect(bindings.select({ actorUserId: "outsider", workspaceId: workspace.id,
        provider, connectionId: repo.id })).rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
      await expect(bindings.select({ actorUserId, workspaceId: workspace.id,
        provider: "linear", connectionId: repo.id })).rejects.toMatchObject({ code: "CONNECTION_UNAVAILABLE" });
      await agent.callTool({ name: "omr.connections.select", arguments: { provider, connectionId: profile.id } });
      await agent.callTool({ name: "omr.catalog.refresh", arguments: {} });
      const profilePage = await api.discoverTools({ workspaceId: workspace.id });
      expect(profilePage.tools.map(({ id }) => id)).toEqual(["github.profile"]);
      const mcpProfile = (await agent.listTools()).tools.filter(({ name }) => name.startsWith("github."));
      expect(mcpProfile.map(({ name }) => name)).toEqual(["github.profile"]);
      expect(mcpProfile[0]?.inputSchema).toEqual(profilePage.tools[0]?.inputSchema);
      expect(mcpProfile[0]?._meta).toMatchObject({ manifestHash: profilePage.tools[0]?.hash });
      expect(await cli("tools", "list")).toEqual(profilePage);
      await expect(api.execute({ workspaceId: workspace.id, toolId: "github.profile", params: {} }))
        .resolves.toMatchObject({ bindingId: profile.id });
      await expect(agent.callTool({ name: "github.profile", arguments: {} }))
        .resolves.toMatchObject({ structuredContent: { bindingId: profile.id } });
      await expect(api.getTool("github.repo", workspace.id)).rejects.toMatchObject({ status: 404 });
      await expect(api.selectConnection({ workspaceId: workspace.id, provider: "linear", connectionId: repo.id }))
        .rejects.toMatchObject({ status: 409 });
      expect((await api.discoverTools({ workspaceId: workspace.id })).tools.map(({ id }) => id))
        .toEqual(["github.profile"]);
      expect(await cli("connections", "select", repo.id, "--provider", provider))
        .toMatchObject({ connectionId: repo.id });
      await agent.callTool({ name: "omr.catalog.refresh", arguments: {} });
      const repoPage = await api.discoverTools({ workspaceId: workspace.id });
      expect(repoPage.tools.map(({ id }) => id)).toEqual(["github.repo"]);
      expect(await cli("tools", "list")).toEqual(repoPage);
      const mcpRepo = (await agent.listTools()).tools.filter(({ name }) => name.startsWith("github."));
      expect(mcpRepo.map(({ name }) => name)).toEqual(["github.repo"]);
      expect(mcpRepo[0]?.inputSchema).toEqual(repoPage.tools[0]?.inputSchema);
      expect(mcpRepo[0]?._meta).toMatchObject({ manifestHash: repoPage.tools[0]?.hash });
      await expect(api.execute({ workspaceId: workspace.id, toolId: "github.repo", params: {} }))
        .resolves.toMatchObject({ bindingId: repo.id });
      await expect(agent.callTool({ name: "github.repo", arguments: {} }))
        .resolves.toMatchObject({ structuredContent: { bindingId: repo.id } });
      await expect(api.execute({ workspaceId: workspace.id, toolId: "github.profile", params: {} }))
        .rejects.toMatchObject({ status: 500 });
    } finally {
      await agent?.close().catch(() => undefined);
      await mcp?.close().catch(() => undefined);
      server.close();
    }
  });
});
