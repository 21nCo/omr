import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlugFnToolCatalog, notionDenial, NotionProviderDenial } from "@oh-my-router/tools";
import { omrNotionProvider, verifiedNotionScopes } from "@oh-my-router/plugfn-runtime";
import { ConnectionAuthority, PlugFnConnectionOrchestrator } from "@oh-my-router/connections";
import { MemoryConnectionBindingStore } from "@oh-my-router/connections/testing";
import { WorkspaceAuthority } from "@oh-my-router/identity";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";
import { ExecutionInputError, ExecutionOutcomeUnknownError, ExecutionService, NotionExecutionError } from "@oh-my-router/execution";
import { MemoryExecutionApprovalStore, MemoryExecutionReceiptStore } from "@oh-my-router/execution/testing";
import { createProviderIntegrationConfig } from "../../apps/web/src/lib/server/cloudflare-runtime.js";
import { selectedReadyNotionConnection } from "../../apps/web/src/lib/workspace-catalog.js";
import { resolveScopedCatalog } from "../../apps/web/src/lib/server/scoped-catalog.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOMRMcpServer } from "../../packages/mcp/src/server.js";
import { MemoryAdapter, plugFn } from "plugfn";

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
  let childParent: { type: string; page_id?: string; database_id?: string;
    data_source_id?: string } = { type: "page_id", page_id: parentId };
  let denial: { status: number; data: { code: string;
    additional_data?: { rate_limit_reason: string } }; headers?: Headers } | null = null;
  let malformedWrite = false;
  let returnedTitle: string | null = null;
  const get = vi.fn(async (url: string) => {
    if (url.endsWith("/users/me")) return { data: { object: "user", id: parentId, type: "bot" } };
    if (url.endsWith(`/pages/${parentId}`) || url.endsWith(`/pages/${parentId.replaceAll("-", "")}`)) return shared
      ? { data: page(parentId, databaseId, "Destination") }
      : Promise.reject({ status: 404, data: { code: "object_not_found" } });
    if (url.endsWith(`/pages/${childId}`) || url.endsWith(`/pages/${childId.replaceAll("-", "")}`)) {
      return { data: { ...page(childId), parent: childParent } };
    }
    if (url.endsWith(`/pages/${foreignId}`)) return Promise.reject({ status: 404,
      data: { code: "object_not_found" } });
    throw new Error(`Unexpected GET ${url}`);
  });
  const post = vi.fn(async (url: string, body: Record<string, unknown>) => {
    if (url.endsWith("/search")) return { data: { results: [page(parentId), {
      object: "database", id: databaseId, url: `https://www.notion.so/${databaseId}`,
      title: [{ plain_text: "Projects" }],
    }, { ...page(childId), parent: childParent, properties: { Name: { type: "title", title: [] } } },
    { ...page(foreignId), archived: true }, { object: "page", id: "broken" }],
    has_more: false, next_cursor: null } };
    if (url.endsWith("/pages")) {
      if (denial) return Promise.reject(denial);
      return { data: malformedWrite ? { id: childId } : page(childId, parentId,
        returnedTitle ?? String((body.properties as { title: { title: { text: { content: string } }[] } }).title.title[0]?.text.content)) };
    }
    throw new Error(`Unexpected POST ${url}`);
  });
  const patch = vi.fn(async (url: string, body: Record<string, unknown>) => {
    if (!url.endsWith(`/pages/${childId}`) && !url.endsWith(`/pages/${childId.replaceAll("-", "")}`)) {
      throw new Error(`Unexpected PATCH ${url}`);
    }
    if (denial) return Promise.reject(denial);
    if (malformedWrite) return { data: { id: childId } };
    const name = (body.properties as { Name: { title: { text: { content: string } }[] } }).Name.title[0]?.text.content;
    return { data: page(childId, parentId, returnedTitle ?? name) };
  });
  return { context: { provider: { baseUrl: "https://api.notion.com/v1" },
      http: { get, post, patch } } as never, get, post, patch,
    setShared: (value: boolean) => { shared = value; },
    setChildParent: (value: typeof childParent) => { childParent = value; },
    setDenial: (value: typeof denial) => { denial = value; },
    setMalformedWrite: (value: boolean) => { malformedWrite = value; },
    setReturnedTitle: (value: string | null) => { returnedTitle = value; },
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
    expect(omrNotionProvider.headers?.["Notion-Version"]).toBe("2025-09-03");
    expect(catalog.list().map((entry) => entry.id).sort()).toEqual([
      "notion.connection.verify", "notion.content.search", "notion.pages.create",
      "notion.pages.get", "notion.pages.update",
    ]);
    expect(catalog.get("notion.pages.create")?.contract).toMatchObject({ effect: "write", retry: "never" });
    expect(catalog.get("notion.content.search")?.contract).toMatchObject({ effect: "read", retry: "safe" });
    expect(catalog.get("notion.content.search")?.description).toContain("browse-only data sources");
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
    await expect(orchestrator.startOAuth({ actorUserId: "alice", workspaceId: workspace.id,
      provider: "notion", ownership: "personal", redirectUri: "https://omr.local/app/oauth/callback",
      label: "Mine", scopes: [] })).rejects.toBeDefined();
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
      { type: "database", id: databaseId }, { type: "page", id: childId, title: "Untitled" }],
    nextCursor: null });
    expect((found as { items: { id: string; title: string }[] }).items.find((item) => item.id === childId)?.title)
      .toBe("Untitled");
    expect(await omrNotionProvider.actions["pages.get"]!.execute({ pageId: parentId }, fixture.context))
      .toMatchObject({ id: parentId, title: "Destination" });
    fixture.setShared(false);
    await expect(omrNotionProvider.actions["pages.create"]!.execute({ parentPageId: parentId,
      title: "No access" }, fixture.context)).rejects.toMatchObject({ code: "NOTION_TARGET_UNAVAILABLE" });
    expect(fixture.writes()).toBe(0);
  });

  it("projects modern shared data sources as browse-only context", async () => {
    const fixture = notionFixture();
    fixture.post.mockResolvedValueOnce({ data: { results: [
      { object: "data_source", id: databaseId,
        title: [{ plain_text: "Projects" }] },
      { object: "data_source", id: foreignId,
        title: [{ plain_text: "Hidden" }], in_trash: true },
      page(parentId),
    ], has_more: true, next_cursor: "next-shared-page" } });
    const found = await omrNotionProvider.actions["content.search"]!.execute({}, fixture.context);
    expect(found).toEqual({ items: [
      { type: "data_source", id: databaseId, title: "Projects" },
      { type: "page", id: parentId, title: "Shared",
        url: `https://www.notion.so/${parentId.replaceAll("-", "")}` },
    ], nextCursor: "next-shared-page" });
    expect(omrNotionProvider.actions["content.search"]!.returns.safeParse(found).success).toBe(true);
    expect((found as { items: { type: string }[] }).items.filter((entry) => entry.type === "page"))
      .toHaveLength(1);
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

  it.each(["data_source_id", "database_id"] as const)(
    "refuses a selected %s database row before any rename write", async (parentType) => {
      const fixture = notionFixture();
      fixture.setChildParent({ type: parentType, [parentType]: databaseId });
      const search = await omrNotionProvider.actions["content.search"]!.execute({}, fixture.context);
      expect((search as { items: { id: string; type: string }[] }).items)
        .toContainEqual(expect.objectContaining({ id: childId, type: "page" }));
      expect(await omrNotionProvider.actions["pages.get"]!.execute({ pageId: childId }, fixture.context))
        .toMatchObject({ id: childId, parent: { type: parentType, [parentType]: databaseId } });
      await expect(omrNotionProvider.actions["pages.update"]!.execute({
        pageId: childId.replaceAll("-", ""), title: "Unsupported rename",
      }, fixture.context)).rejects.toMatchObject({
        code: "NOTION_INVALID_CHANGE", phase: "preflight",
      });
      expect(fixture.patch).not.toHaveBeenCalled();
      expect(fixture.writes()).toBe(0);
    });

  it("rejects an approved direct-ID rename of a database row without provider write", async () => {
    const f = await serviceFixture();
    f.notion.setChildParent({ type: "data_source_id", data_source_id: databaseId });
    const approval = await f.service.requestApproval({ principal: f.principal,
      toolId: "notion.pages.update", params: { pageId: childId, title: "Unsupported rename" },
      connectionId: f.binding.id, idempotencyKey: "row-rename" });
    expect(f.notion.writes()).toBe(0);
    await f.service.approve(approval.id, "alice");
    await expect(f.service.executeApproved(f.principal, approval.id)).rejects.toMatchObject({
      code: "NOTION_INVALID_CHANGE", receiptId: expect.any(String),
    });
    expect(f.notion.get).toHaveBeenCalledWith(expect.stringContaining(`/pages/${childId.replaceAll("-", "")}`));
    expect(f.notion.patch).not.toHaveBeenCalled();
    expect(f.notion.writes()).toBe(0);
    expect((await f.service.approvalStatus(f.principal, approval.id)).status).toBe("failed");
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
    expect(notionDenial({ status: 529, data: { code: "service_overload" },
      headers: new Headers({ "Retry-After": "27" }) }, "write"))
      .toMatchObject({ code: "NOTION_RATE_LIMITED", retryAfterSeconds: 27 });
  });

  it.each(["read", "preflight", "write"] as const)(
    "treats a blocked Notion connection during %s as permanent access recovery", (phase) => {
      const blocked = { status: 429, data: { code: "rate_limited",
        additional_data: { rate_limit_reason: "public_api_request_blocked" } },
      headers: new Headers({ "Retry-After": "19" }) };
      expect(notionDenial(blocked, phase)).toMatchObject({
        code: "NOTION_ACCESS_RESTRICTED", phase,
        message: expect.stringContaining("Contact Notion support"),
      });
      expect(notionDenial(blocked, phase)?.retryAfterSeconds).toBeUndefined();
      expect(notionDenial({ ...blocked, data: { code: "rate_limited",
        additional_data: { rate_limit_reason: "public_api_request_rate_limit" } } }, phase))
        .toMatchObject({ code: "NOTION_RATE_LIMITED", retryAfterSeconds: 19 });
    });

  it("passes blocked access through search, page read, and destination preflight without a write", async () => {
    const blocked = { status: 429, data: { code: "rate_limited",
      additional_data: { rate_limit_reason: "public_api_request_blocked" } },
    headers: new Headers({ "Retry-After": "19" }) };
    const get = vi.fn(async () => { throw blocked; });
    const post = vi.fn(async () => { throw blocked; });
    const patch = vi.fn(async () => { throw blocked; });
    const context = { provider: { baseUrl: "https://api.notion.com/v1" },
      http: { get, post, patch } } as never;
    await expect(omrNotionProvider.actions["content.search"]!.execute({}, context))
      .rejects.toMatchObject({ code: "NOTION_ACCESS_RESTRICTED", phase: "read" });
    await expect(omrNotionProvider.actions["pages.get"]!.execute({ pageId: parentId }, context))
      .rejects.toMatchObject({ code: "NOTION_ACCESS_RESTRICTED", phase: "read" });
    await expect(omrNotionProvider.actions["pages.create"]!.execute({ parentPageId: parentId,
      title: "New child" }, context)).rejects.toMatchObject({
      code: "NOTION_ACCESS_RESTRICTED", phase: "preflight",
    });
    await expect(omrNotionProvider.actions["pages.update"]!.execute({ pageId: childId,
      title: "New name" }, context)).rejects.toMatchObject({
      code: "NOTION_ACCESS_RESTRICTED", phase: "preflight",
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(patch).not.toHaveBeenCalled();
  });

  it.each(["pages.create", "pages.update"] as const)(
    "settles a blocked %s response after one write without retry guidance", async (toolId) => {
      const f = await serviceFixture();
      const params = toolId === "pages.create"
        ? { parentPageId: parentId, title: "New child" }
        : { pageId: childId, title: "New name" };
      const approval = await f.service.requestApproval({ principal: f.principal,
        toolId: `notion.${toolId}`, params, connectionId: f.binding.id,
        idempotencyKey: `blocked-${toolId}` });
      expect(f.notion.writes()).toBe(0);
      await f.service.approve(approval.id, "alice");
      f.notion.setDenial({ status: 429, data: { code: "rate_limited",
        additional_data: { rate_limit_reason: "public_api_request_blocked" } },
      headers: new Headers({ "Retry-After": "19" }) });
      await expect(f.service.executeApproved(f.principal, approval.id)).rejects.toMatchObject({
        code: "NOTION_ACCESS_RESTRICTED", retryAfterSeconds: undefined,
        message: expect.stringContaining("Contact Notion support"),
      });
      expect(f.notion.writes()).toBe(1);
      expect((await f.service.approvalStatus(f.principal, approval.id)).status).toBe("failed");
      await expect(f.service.executeApproved(f.principal, approval.id)).rejects.toBeDefined();
      expect(f.notion.writes()).toBe(1);
    });

  it.each(["pages.create", "pages.update"] as const)(
    "settles missing remote during %s preflight, but not after write dispatch", async (action) => {
      const f = await serviceFixture();
      const toolId = `notion.${action}`;
      const params = action === "pages.create"
        ? { parentPageId: parentId, title: "Child" }
        : { pageId: childId, title: "Renamed" };
      const request = (idempotencyKey: string) => f.service.requestApproval({
        principal: f.principal, toolId, params, connectionId: f.binding.id, idempotencyKey,
      });
      const missing = Object.assign(new Error("remote connection absent"), { code: "CONNECTION_NOT_FOUND" });
      const preflight = await request("preflight-missing");
      await f.service.approve(preflight.id, "alice");
      f.notion.get.mockRejectedValueOnce(missing);
      await expect(f.service.executeApproved(f.principal, preflight.id)).rejects.toMatchObject({
        code: "NOTION_RECONNECT_REQUIRED", receiptId: expect.any(String),
      });
      expect(f.notion.writes()).toBe(0);
      expect((await f.service.approvalStatus(f.principal, preflight.id)).status).toBe("failed");
      expect([...f.receipts.receipts.values()].find((receipt) => receipt.approvalId === preflight.id))
        .toMatchObject({ status: "failed", errorCode: "notion_preflight_denied" });
      await expect(request("before-reconnect")).rejects.toMatchObject({
        code: "CONNECTION_ACCESS_DENIED",
      });
      await f.connections.recordHealth({ connectionId: f.binding.id,
        status: "active", readiness: "ready" });
      expect((await request("preflight-missing-retry")).id).not.toBe(preflight.id);

      const dispatched = await request("write-missing");
      await f.service.approve(dispatched.id, "alice");
      if (action === "pages.create") f.notion.post.mockRejectedValueOnce(missing);
      else f.notion.patch.mockRejectedValueOnce(missing);
      await expect(f.service.executeApproved(f.principal, dispatched.id))
        .rejects.toBeInstanceOf(ExecutionOutcomeUnknownError);
      expect(f.notion.writes()).toBe(1);
      expect((await f.service.approvalStatus(f.principal, dispatched.id)).status).toBe("uncertain");
      expect([...f.receipts.receipts.values()].find((receipt) => receipt.approvalId === dispatched.id))
        .toMatchObject({ status: "uncertain" });
      await expect(request("write-missing-retry")).rejects.toMatchObject({
        code: "CONNECTION_ACCESS_DENIED",
      });
      expect(f.notion.writes()).toBe(1);
    });

  it.each(["pages.create", "pages.update"] as const)(
    "settles a pinned PlugFn %s connection lookup before adapter entry", async (action) => {
      const f = await serviceFixture();
      const runtime = plugFn({ database: new MemoryAdapter(), auth: { getUserId: async () => null },
        baseUrl: "https://omr.local",
        encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        integrations: { notion: { type: "oauth2", clientId: "fixture-client", clientSecret: "fixture-secret",
          redirectUris: ["https://omr.local/app/oauth/callback"] } },
        retry: { enabled: true }, cache: { enabled: false }, rateLimit: { enabled: false },
      }).use(omrNotionProvider);
      await runtime.ready;
      const providerFetch = vi.fn(async () => { throw new Error("Provider must not be called"); });
      vi.stubGlobal("fetch", providerFetch);
      const service = new ExecutionService(f.catalog, f.connections, runtime, f.receipts,
        async () => [], Date.now, f.approvals, undefined, new Uint8Array(32).fill(7));
      const approval = await service.requestApproval({ principal: f.principal,
        toolId: `notion.${action}`, params: action === "pages.create"
          ? { parentPageId: parentId, title: "Child" } : { pageId: childId, title: "Renamed" },
        connectionId: f.binding.id, idempotencyKey: `real-lookup-${action}` });
      await service.approve(approval.id, "alice");
      await expect(service.executeApproved(f.principal, approval.id))
        .rejects.toMatchObject({ code: "CONNECTION_UNAVAILABLE" });
      expect(providerFetch).not.toHaveBeenCalled();
      expect(f.notion.writes()).toBe(0);
      expect((await service.approvalStatus(f.principal, approval.id)).status).toBe("failed");
      expect([...f.receipts.receipts.values()].find((receipt) => receipt.approvalId === approval.id))
        .toMatchObject({ status: "failed", errorCode: "connection_unavailable" });
      await expect(service.requestApproval({ principal: f.principal, toolId: `notion.${action}`,
        params: action === "pages.create" ? { parentPageId: parentId, title: "Child" }
          : { pageId: childId, title: "Renamed" }, connectionId: f.binding.id,
        idempotencyKey: `real-lookup-retry-${action}` }))
        .rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    });

  it.each(["pages.create", "pages.update"] as const)(
    "keeps a divergent %s response uncertain after one provider write", async (action) => {
      const fixture = notionFixture();
      fixture.setReturnedTitle("A different title");
      const params = action === "pages.create"
        ? { parentPageId: parentId, title: "Approved title" }
        : { pageId: childId, title: "Approved title" };
      await expect(omrNotionProvider.actions[action]!.execute(params, fixture.context))
        .rejects.toMatchObject({ name: "NotionProviderResponseAmbiguous" });
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

  it("keeps failed or malformed bot verification retryable without claiming token revocation", async () => {
    const fixture = notionFixture();
    const verify = omrNotionProvider.actions["connection.verify"]!;
    for (const get of [vi.fn().mockRejectedValue({ status: 500, data: { code: "internal_server_error" } }),
      vi.fn().mockResolvedValue({ data: { object: "user", id: parentId, type: "person" } })]) {
      await expect(verify.execute({}, { ...fixture.context, http: { ...fixture.context.http, get } }))
        .rejects.toMatchObject({ code: "NOTION_QUERY_REJECTED" });
    }
    expect(fixture.writes()).toBe(0);
    await expect(verifiedNotionScopes({ action: vi.fn(async () => ({ object: "user",
      id: parentId, type: "person" })) },
    { userId: "alice", workspaceId: "workspace-a", connectionId: "remote-a" }))
      .rejects.toMatchObject({ code: "NOTION_QUERY_REJECTED" });
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
      async () => {}, { onReconnectRequired: reconnect });
    expect([...allowed]).toEqual([]);
    expect(reconnect).toHaveBeenCalledWith("binding-a", "notion");
    const retryable = await resolveScopedCatalog(catalog, [provider],
      async () => ({ id: "binding-a", providerConnectionId: "remote-a" }),
      async () => { throw new NotionProviderDenial("read", "NOTION_RATE_LIMITED", 12); },
      async () => {}, { onReconnectRequired: reconnect });
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

  it("settles a 529 overload as a definite failed write with retry guidance", async () => {
    const f = await serviceFixture();
    const approval = await f.service.requestApproval({ principal: f.principal,
      toolId: "notion.pages.create", params: { parentPageId: parentId, title: "Overloaded" },
      connectionId: f.binding.id, idempotencyKey: "overload" });
    await f.service.approve(approval.id, "alice");
    f.notion.setDenial({ status: 529, data: { code: "service_overload" },
      headers: new Headers({ "Retry-After": "27" }) });
    await expect(f.service.executeApproved(f.principal, approval.id)).rejects.toMatchObject({
      code: "NOTION_RATE_LIMITED", retryAfterSeconds: 27,
    });
    expect(f.notion.writes()).toBe(1);
    expect((await f.service.approvalStatus(f.principal, approval.id)).status).toBe("failed");
  });

  it.each(["notion.pages.create", "notion.pages.update"] as const)(
    "canonicalizes %s approval identity and dispatch across equivalent inputs", async (toolId) => {
      const f = await serviceFixture();
      const key = toolId === "notion.pages.create" ? "parentPageId" : "pageId";
      const pageId = key === "parentPageId" ? parentId : childId;
      const first = await f.service.requestApproval({ principal: f.principal, toolId,
        params: { [key]: pageId.toUpperCase(), title: "  Same title  " },
        connectionId: f.binding.id, idempotencyKey: "variant-a" });
      const second = await f.service.requestApproval({ principal: f.principal, toolId,
        params: { [key]: pageId.replaceAll("-", ""), title: "Same title" },
        connectionId: f.binding.id, idempotencyKey: "variant-b" });
      expect(second.id).toBe(first.id);
      expect(first.params).toEqual({ [key]: pageId.replaceAll("-", ""), title: "Same title" });
      await f.service.approve(first.id, "alice");
      expect((await f.service.requestApproval({ principal: f.principal, toolId,
        params: { [key]: pageId, title: " Same title" }, connectionId: f.binding.id,
        idempotencyKey: "variant-c" })).id).toBe(first.id);
      await f.service.executeApproved(f.principal, first.id);
      expect(f.notion.writes()).toBe(1);
      const dispatched = toolId === "notion.pages.create" ? f.notion.post.mock.calls.find(([url]) => url.endsWith("/pages"))?.[1]
        : f.notion.patch.mock.calls[0]?.[1];
      expect(JSON.stringify(dispatched)).toContain("Same title");
      expect(JSON.stringify(dispatched)).not.toContain("  Same title  ");
    });

  it.each(["notion.pages.create", "notion.pages.update"] as const)(
    "rejects whitespace-only %s before approval or provider dispatch", async (toolId) => {
      const f = await serviceFixture();
      await expect(f.service.requestApproval({ principal: f.principal, toolId,
        params: toolId === "notion.pages.create"
          ? { parentPageId: parentId, title: "   " } : { pageId: childId, title: "   " },
        connectionId: f.binding.id, idempotencyKey: "blank-title" }))
        .rejects.toBeInstanceOf(ExecutionInputError);
      expect(f.dispatch).not.toHaveBeenCalled();
      expect(f.notion.writes()).toBe(0);
      expect(f.approvals.approvals.size).toBe(0);
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

  it.each(["notion.pages.create", "notion.pages.update"] as const)(
    "coalesces independent %s keys through pending, approved, executing and uncertain states", async (toolId) => {
      const f = await serviceFixture();
      const params = toolId === "notion.pages.create"
        ? { parentPageId: parentId, title: "Maybe made" }
        : { pageId: childId, title: "Maybe renamed" };
      const target = toolId === "notion.pages.create" ? parentId : childId;
      const targetKey = toolId === "notion.pages.create" ? "parentPageId" : "pageId";
      const request = (idempotencyKey: string) => f.service.requestApproval({
        principal: f.principal, toolId,
        params: idempotencyKey === "first-key"
          ? { [targetKey]: target.toUpperCase(), title: `  ${params.title}  ` }
          : { [targetKey]: target.replaceAll("-", ""), title: params.title },
        connectionId: f.binding.id, idempotencyKey,
      });
      const first = await request("first-key");
      expect((await request("second-key")).id).toBe(first.id);
      expect(f.notion.writes()).toBe(0);
      await f.service.approve(first.id, "alice");
      expect((await request("third-key")).id).toBe(first.id);
      expect(f.notion.writes()).toBe(0);

      let entered!: () => void;
      let release!: () => void;
      const dispatched = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      f.notion.setMalformedWrite(true);
      f.dispatch.mockImplementationOnce(async (_provider, action, options) => {
        entered();
        await held;
        return omrNotionProvider.actions[action]!.execute(options.params, f.notion.context);
      });
      const execution = f.service.executeApproved(f.principal, first.id);
      await dispatched;
      expect((await request("fourth-key")).id).toBe(first.id);
      expect(f.notion.writes()).toBe(0);
      release();
      await expect(execution).rejects.toBeInstanceOf(ExecutionOutcomeUnknownError);
      expect(f.notion.writes()).toBe(1);
      expect((await request("fifth-key")).id).toBe(first.id);
      expect(f.notion.writes()).toBe(1);
      await f.service.reconcileUncertain(f.principal, first.id, "effect_absent");
      const deliberate = await request("sixth-key");
      expect(deliberate.id).not.toBe(first.id);
      expect(deliberate.status).toBe("pending");
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
