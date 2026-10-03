import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlugFnToolCatalog, notionDenial, NotionProviderDenial } from "@oh-my-router/tools";
import { omrNotionProvider, verifiedNotionScopes } from "@oh-my-router/plugfn-runtime";
import { ConnectionAuthority, PlugFnConnectionOrchestrator } from "@oh-my-router/connections";
import { MemoryConnectionBindingStore } from "@oh-my-router/connections/testing";
import { WorkspaceAuthority } from "@oh-my-router/identity";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";
import { ExecutionOutcomeUnknownError, ExecutionService, NotionExecutionError } from "@oh-my-router/execution";
import { MemoryExecutionApprovalStore, MemoryExecutionReceiptStore } from "@oh-my-router/execution/testing";
import { createProviderIntegrationConfig } from "../../apps/web/src/lib/server/cloudflare-runtime.js";
import { selectedReadyNotionConnection } from "../../apps/web/src/lib/workspace-catalog.js";
import { resolveScopedCatalog } from "../../apps/web/src/lib/server/scoped-catalog.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOMRMcpServer } from "../../packages/mcp/src/server.js";

const parentId = "11111111-1111-4111-8111-111111111111";
const childId = "22222222-2222-4222-8222-222222222222";
const databaseId = "33333333-3333-4333-8333-333333333333";
const foreignId = "44444444-4444-4444-8444-444444444444";
const titleProperty = (text: string) => ({ type: "title", title: [{ plain_text: text }] });
const page = (id: string, parent = parentId, text = "Shared") => ({ object: "page", id,
  url: `https://www.notion.so/${id.replaceAll("-", "")}`,
  parent: { type: "page_id", page_id: parent },
  properties: { Name: titleProperty(text) } });

afterEach(() => vi.unstubAllGlobals());

function notionFixture() {
  let shared = true;
  let denial: { status: number; data: { code: string }; headers?: Headers } | null = null;
  let malformedWrite = false;
  const get = vi.fn(async (url: string) => {
    if (url.endsWith("/users/me")) return { data: { object: "user", id: parentId, type: "bot" } };
    if (url.endsWith(`/pages/${parentId}`)) return shared
      ? { data: page(parentId, databaseId, "Destination") }
      : Promise.reject({ status: 404, data: { code: "object_not_found" } });
    if (url.endsWith(`/pages/${childId}`)) return { data: page(childId) };
    if (url.endsWith(`/pages/${foreignId}`)) return Promise.reject({ status: 404,
      data: { code: "object_not_found" } });
    throw new Error(`Unexpected GET ${url}`);
  });
  const post = vi.fn(async (url: string, body: Record<string, unknown>) => {
    if (url.endsWith("/search")) return { data: { results: [page(parentId), {
      object: "database", id: databaseId, url: `https://www.notion.so/${databaseId}`,
      title: [{ plain_text: "Projects" }],
    }, { ...page(foreignId), archived: true }, { object: "page", id: "broken" }],
    has_more: false, next_cursor: null } };
    if (url.endsWith("/pages")) {
      if (denial) return Promise.reject(denial);
      return { data: malformedWrite ? { id: childId } : page(childId, parentId,
        String((body.properties as { title: { title: { text: { content: string } }[] } }).title.title[0]?.text.content)) };
    }
    throw new Error(`Unexpected POST ${url}`);
  });
  const patch = vi.fn(async (url: string, body: Record<string, unknown>) => {
    if (!url.endsWith(`/pages/${childId}`)) throw new Error(`Unexpected PATCH ${url}`);
    if (denial) return Promise.reject(denial);
    const name = (body.properties as { Name: { title: { text: { content: string } }[] } }).Name.title[0]?.text.content;
    return { data: page(childId, parentId, name) };
  });
  return { context: { provider: { baseUrl: "https://api.notion.com/v1" },
      http: { get, post, patch } } as never, get, post, patch,
    setShared: (value: boolean) => { shared = value; },
    setDenial: (value: typeof denial) => { denial = value; },
    setMalformedWrite: (value: boolean) => { malformedWrite = value; },
    writes: () => post.mock.calls.filter(([url]) => url.endsWith("/pages")).length + patch.mock.calls.length };
}

async function serviceFixture() {
  const store = new MemoryWorkspaceStore();
  const workspaces = new WorkspaceAuthority(store);
  const { workspace } = await workspaces.provisionPersonalWorkspace({ userId: "alice" });
  const other = await workspaces.createTeam({ ownerUserId: "alice", name: "Other" });
  const connections = new ConnectionAuthority(new MemoryConnectionBindingStore(store));
  const binding = await connections.attach({ actorUserId: "alice", workspaceId: workspace.id,
    provider: "notion", providerConnectionId: "notion_A", ownership: "personal", label: "A" });
  const receipts = new MemoryExecutionReceiptStore(() => true);
  const approvals = new MemoryExecutionApprovalStore(() => true, receipts);
  const catalog = await createPlugFnToolCatalog({ providers: { list: () => [omrNotionProvider] } });
  const notion = notionFixture();
  const dispatch = vi.fn(async (_provider: string, action: string, options: { params: unknown }) =>
    omrNotionProvider.actions[action]!.execute(options.params, notion.context));
  const service = new ExecutionService(catalog, connections, { action: dispatch }, receipts,
    async () => [], Date.now, approvals, undefined, new Uint8Array(32).fill(7));
  const principal = { kind: "web" as const, userId: "alice", workspaceId: workspace.id };
  return { workspace, other, connections, binding, receipts, approvals, catalog, notion,
    dispatch, service, principal };
}

describe("notion-adapter-contract", () => {
  it("keeps rollout disabled and publishes only typed bounded actions", async () => {
    const config = { PLUGFN_NOTION_CLIENT_ID: "id", PLUGFN_NOTION_CLIENT_SECRET: "secret" };
    expect(createProviderIntegrationConfig(config, "https://omr.local").notion).toBeUndefined();
    expect(createProviderIntegrationConfig({ ...config, OMR_NOTION_V1_ENABLED: "true" },
      "https://omr.local").notion).toBeDefined();
    const catalog = await createPlugFnToolCatalog({ providers: { list: () => [omrNotionProvider] } });
    expect(catalog.list().map((entry) => entry.id).sort()).toEqual([
      "notion.connection.verify", "notion.content.search", "notion.pages.create",
      "notion.pages.get", "notion.pages.update",
    ]);
    expect(catalog.get("notion.pages.create")?.contract).toMatchObject({ effect: "write", retry: "never" });
    expect(catalog.get("notion.content.search")?.contract).toMatchObject({ effect: "read", retry: "safe" });
    await expect(omrNotionProvider.actions["pages.create"]!.execute({ parentPageId: "../foreign", title: "X" },
      notionFixture().context)).rejects.toBeDefined();
  });

  it("starts Notion OAuth for the authorized owner without invented scopes", async () => {
    const store = new MemoryWorkspaceStore();
    const workspaces = new WorkspaceAuthority(store);
    const { workspace } = await workspaces.provisionPersonalWorkspace({ userId: "alice" });
    const authority = new ConnectionAuthority(new MemoryConnectionBindingStore(store));
    const getAuthUrl = vi.fn(async () => "https://api.notion.com/v1/oauth/authorize?state=fixture");
    const runtime = { providers: { get: () => omrNotionProvider },
      config: { integrations: { notion: {} } }, connections: { getAuthUrl } };
    const orchestrator = new PlugFnConnectionOrchestrator(authority, runtime as never);
    await expect(orchestrator.startOAuth({ actorUserId: "bob", workspaceId: workspace.id,
      provider: "notion", ownership: "personal", redirectUri: "https://omr.local/app/oauth/callback",
      label: "Mine" })).rejects.toBeDefined();
    expect(getAuthUrl).not.toHaveBeenCalled();
    await expect(orchestrator.startOAuth({ actorUserId: "alice", workspaceId: workspace.id,
      provider: "notion", ownership: "personal", redirectUri: "https://omr.local/app/oauth/callback",
      label: "Mine", scopes: ["write"] })).rejects.toBeDefined();
    expect(getAuthUrl).not.toHaveBeenCalled();
    await orchestrator.startOAuth({ actorUserId: "alice", workspaceId: workspace.id,
      provider: "notion", ownership: "personal", redirectUri: "https://omr.local/app/oauth/callback",
      label: "Mine" });
    expect(getAuthUrl).toHaveBeenCalledWith(expect.objectContaining({ provider: "notion",
      owner: { kind: "user", userId: "alice", tenantId: workspace.id } }));
    expect(getAuthUrl.mock.calls[0]?.[0]).not.toHaveProperty("scopes");
  });

  it("shows only valid visible provider results and checks an explicit shared destination", async () => {
    const fixture = notionFixture();
    const found = await omrNotionProvider.actions["content.search"]!.execute({}, fixture.context);
    expect(found).toMatchObject({ items: [{ type: "page", id: parentId },
      { type: "database", id: databaseId }], nextCursor: null });
    expect(await omrNotionProvider.actions["pages.get"]!.execute({ pageId: parentId }, fixture.context))
      .toMatchObject({ id: parentId, title: "Destination" });
    fixture.setShared(false);
    await expect(omrNotionProvider.actions["pages.create"]!.execute({ parentPageId: parentId,
      title: "No access" }, fixture.context)).rejects.toMatchObject({ code: "NOTION_TARGET_UNAVAILABLE" });
    expect(fixture.writes()).toBe(0);
  });

  it("uses the existing title property for rename and treats incomplete writes as uncertain", async () => {
    const fixture = notionFixture();
    expect(await omrNotionProvider.actions["pages.update"]!.execute({ pageId: childId,
      title: "Renamed" }, fixture.context)).toMatchObject({ id: childId, title: "Renamed" });
    expect(fixture.patch.mock.calls[0]?.[1]).toMatchObject({ properties: { Name: {
      title: [{ text: { content: "Renamed" } }],
    } } });
    fixture.setMalformedWrite(true);
    await expect(omrNotionProvider.actions["pages.create"]!.execute({ parentPageId: parentId,
      title: "Maybe" }, fixture.context)).rejects.toMatchObject({ name: "NotionProviderResponseAmbiguous" });
  });

  it("classifies definite rate limits and retains transport uncertainty", async () => {
    expect(notionDenial({ status: 429, headers: new Headers({ "Retry-After": "19" }) }, "write"))
      .toMatchObject({ code: "NOTION_RATE_LIMITED", retryAfterSeconds: 19 });
    expect(notionDenial(new TypeError("lost response"), "write")).toBeNull();
    const fixture = notionFixture();
    fixture.setDenial({ status: 429, data: { code: "rate_limited" },
      headers: new Headers({ "Retry-After": "19" }) });
    await expect(omrNotionProvider.actions["pages.create"]!.execute({ parentPageId: parentId,
      title: "Retry later" }, fixture.context)).rejects.toMatchObject({
        code: "NOTION_RATE_LIMITED", phase: "write", retryAfterSeconds: 19,
      });
    expect(fixture.writes()).toBe(1);
  });

  it("verifies a live bot and rejects a revoked token", async () => {
    const action = vi.fn(async () => ({ object: "user", id: parentId, type: "bot" }));
    const input = { userId: "alice", workspaceId: "workspace-a", connectionId: "remote-a" };
    expect(await verifiedNotionScopes({ action }, input)).toEqual([]);
    expect(action).toHaveBeenCalledWith("notion", "connection.verify", expect.objectContaining({
      connectionId: "remote-a", actor: { userId: "alice", tenantId: "workspace-a", organizationId: "workspace-a" },
    }));
    action.mockRejectedValueOnce(new NotionProviderDenial("read", "NOTION_RECONNECT_REQUIRED"));
    await expect(verifiedNotionScopes({ action }, input)).rejects.toMatchObject({
      code: "NOTION_RECONNECT_REQUIRED",
    });
  });

  it("contains a failed Notion proof to its provider and marks revoked grants for reconnect", async () => {
    const catalog = await createPlugFnToolCatalog({ providers: { list: () => [omrNotionProvider] } });
    const provider = { provider: "notion", displayName: "Notion", providerVersion: "1.0.0",
      description: "", authMode: "oauth" as const, actionCount: 5,
      state: "ready" as const, available: true };
    const reconnect = vi.fn(async () => {});
    const allowed = await resolveScopedCatalog(catalog, [provider],
      async () => ({ id: "binding-a", providerConnectionId: "remote-a" }),
      async () => { throw new NotionProviderDenial("read", "NOTION_RECONNECT_REQUIRED"); },
      async () => {}, reconnect);
    expect([...allowed]).toEqual([]);
    expect(reconnect).toHaveBeenCalledWith("binding-a", "notion");
    const retryable = await resolveScopedCatalog(catalog, [provider],
      async () => ({ id: "binding-a", providerConnectionId: "remote-a" }),
      async () => { throw new NotionProviderDenial("read", "NOTION_RATE_LIMITED", 12); },
      async () => {}, reconnect);
    expect([...retryable]).toEqual([]);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("projects a bounded create schema to MCP and requests approval without dispatch", async () => {
    const catalog = await createPlugFnToolCatalog({ providers: { list: () => [omrNotionProvider] } });
    const manifest = catalog.get("notion.pages.create")!;
    const requests: unknown[] = [];
    const server = await createOMRMcpServer({ baseUrl: "https://omr.test", credential: "credential",
      workspaceId: "omr-workspace", fetchImpl: async (request, init) => {
        const path = new URL(typeof request === "string" ? request : request instanceof URL
          ? request.href : request.url).pathname;
        if (path === "/api/tools") return Response.json({ catalogSchemaVersion: "1.0.0",
          revision: "notion-fixture", tools: [manifest] });
        if (path === "/api/approvals") {
          requests.push(JSON.parse(String(init?.body)));
          return Response.json({ id: "approval-a", status: "pending", expiresAt: Date.now() + 60_000 },
            { status: 201 });
        }
        throw new Error(`Unexpected MCP backend request ${path}`);
      } });
    const client = new Client({ name: "notion-contract-test", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const schema = (await client.listTools()).tools.find(({ name }) => name === manifest.id)?.inputSchema;
      expect(schema).toMatchObject({ type: "object", required: expect.arrayContaining([
        "parentPageId", "title", "_omrIdempotencyKey",
      ]) });
      expect((await client.callTool({ name: manifest.id, arguments: {
        parentPageId: "../foreign", title: "No", _omrIdempotencyKey: "notion-one",
      } })).isError).toBe(true);
      expect(requests).toHaveLength(0);
      expect(await client.callTool({ name: manifest.id, arguments: {
        parentPageId: parentId, title: "New child", _omrIdempotencyKey: "notion-one",
      } })).toMatchObject({ structuredContent: { status: "approval_required", executed: false,
        approvalId: "approval-a" } });
      expect(requests).toEqual([{ workspaceId: "omr-workspace", toolId: manifest.id,
        params: { parentPageId: parentId, title: "New child" }, idempotencyKey: "notion-one" }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps writes behind approval and workspace binding, then refuses revocation", async () => {
    const f = await serviceFixture();
    await expect(f.service.execute({ principal: { ...f.principal, workspaceId: f.other.id },
      toolId: "notion.content.search", params: {}, connectionId: f.binding.id }))
      .rejects.toBeDefined();
    expect(f.notion.post).not.toHaveBeenCalled();
    const params = { parentPageId: parentId, title: "New child" };
    const approval = await f.service.requestApproval({ principal: f.principal,
      toolId: "notion.pages.create", params, connectionId: f.binding.id,
      idempotencyKey: "one-child" });
    expect(f.notion.writes()).toBe(0);
    await f.service.approve(approval.id, "alice");
    expect(f.notion.writes()).toBe(0);
    await expect(f.service.executeApproved({ ...f.principal, workspaceId: f.other.id }, approval.id))
      .rejects.toBeDefined();
    expect(f.notion.writes()).toBe(0);
    expect((await f.service.executeApproved(f.principal, approval.id)).result)
      .toMatchObject({ id: childId });
    expect(f.notion.writes()).toBe(1);
    const second = await f.service.requestApproval({ principal: f.principal,
      toolId: "notion.pages.update", params: { pageId: childId, title: "Different" },
      connectionId: f.binding.id, idempotencyKey: "rename" });
    await f.service.approve(second.id, "alice");
    await f.connections.revoke("alice", f.binding.id);
    await expect(f.service.executeApproved(f.principal, second.id)).rejects.toBeDefined();
    expect(f.notion.writes()).toBe(1);
  });

  it("settles a provider rate denial without claiming a lost response was absent", async () => {
    const f = await serviceFixture();
    const params = { parentPageId: parentId, title: "New child" };
    const approval = await f.service.requestApproval({ principal: f.principal,
      toolId: "notion.pages.create", params, connectionId: f.binding.id, idempotencyKey: "limited" });
    await f.service.approve(approval.id, "alice");
    f.notion.setDenial({ status: 429, data: { code: "rate_limited" } });
    await expect(f.service.executeApproved(f.principal, approval.id))
      .rejects.toBeInstanceOf(NotionExecutionError);
    expect(f.notion.writes()).toBe(1);
    const replay = await f.service.requestApproval({ principal: f.principal,
      toolId: "notion.pages.create", params, connectionId: f.binding.id, idempotencyKey: "limited" });
    expect(replay.id).toBe(approval.id);
    expect(f.notion.writes()).toBe(1);
  });

  it("fences an ambiguous creation instead of writing again", async () => {
    const f = await serviceFixture();
    const params = { parentPageId: parentId, title: "Maybe made" };
    const approval = await f.service.requestApproval({ principal: f.principal,
      toolId: "notion.pages.create", params, connectionId: f.binding.id,
      idempotencyKey: "ambiguous-child" });
    await f.service.approve(approval.id, "alice");
    f.notion.setMalformedWrite(true);
    await expect(f.service.executeApproved(f.principal, approval.id))
      .rejects.toBeInstanceOf(ExecutionOutcomeUnknownError);
    expect(f.notion.writes()).toBe(1);
    const replay = await f.service.requestApproval({ principal: f.principal,
      toolId: "notion.pages.create", params, connectionId: f.binding.id,
      idempotencyKey: "ambiguous-child" });
    expect(replay.id).toBe(approval.id);
    expect(f.notion.writes()).toBe(1);
  });

  it("hides a stale Notion account on workspace switch or pending refresh", () => {
    const connection = { id: "a", provider: "notion", selected: true, workspaceId: "A",
      status: "active", readiness: "ready" };
    const overview = { selectedWorkspaceId: "A", connections: [connection] };
    expect(selectedReadyNotionConnection({ overview, selectedWorkspaceId: "A",
      loading: false, busy: "" })).toEqual(connection);
    expect(selectedReadyNotionConnection({ overview, selectedWorkspaceId: "B",
      loading: false, busy: "" })).toBeUndefined();
    expect(selectedReadyNotionConnection({ overview, selectedWorkspaceId: "A",
      loading: true, busy: "" })).toBeUndefined();
  });
});
