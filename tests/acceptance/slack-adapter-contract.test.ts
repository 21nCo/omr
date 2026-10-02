import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryAdapter, plugFn } from "plugfn";
import { createPlugFnToolCatalog, hasRequiredScopes } from "@oh-my-router/tools";
import { omrSlackProvider, verifiedSlackScopes } from "@oh-my-router/plugfn-runtime";
import { ConnectionAuthority, PlugFnConnectionOrchestrator } from "@oh-my-router/connections";
import { MemoryConnectionBindingStore } from "@oh-my-router/connections/testing";
import { WorkspaceAuthority } from "@oh-my-router/identity";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";
import { ExecutionService, SlackExecutionError } from "@oh-my-router/execution";
import { MemoryExecutionApprovalStore, MemoryExecutionReceiptStore } from "@oh-my-router/execution/testing";
import { createProviderIntegrationConfig } from "../../apps/web/src/lib/server/cloudflare-runtime.js";
import { selectedReadySlackConnection } from "../../apps/web/src/lib/workspace-catalog.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOMRMcpServer } from "../../packages/mcp/src/server.js";

const teamA = "T12345678";
const teamB = "T87654321";
const channelA = "C12345678";
const channelB = "C87654321";
const botA = "U12345678";
const localChannel = { id: channelA, name: "release", is_member: true,
  is_private: false, is_archived: false, is_shared: false, is_ext_shared: false };

afterEach(() => vi.unstubAllGlobals());

/** Slack's HTTP 200 errors and live identity come from the selected token. */
function slackFixture(team = teamA) {
  let failure: string | null = null;
  let postFailure: string | null = null;
  let shared = false;
  const get = vi.fn(async (url: string, options: { params?: { channel?: string } } = {}) => {
    if (failure && url.endsWith("/conversations.info")) return { data: { ok: false, error: failure } };
    if (url.endsWith("/conversations.info")) return { data: { ok: true, channel: {
      ...localChannel, id: options.params?.channel === channelA ? channelA : channelB,
      is_shared: shared,
    } } };
    if (url.endsWith("/conversations.list")) return { data: { ok: true,
      channels: [localChannel, { ...localChannel, id: channelB, is_shared: true }],
      response_metadata: { next_cursor: "" } } };
    if (url.endsWith("/conversations.history")) return { data: { ok: true,
      messages: [{ ts: "123.456", text: "Old", user: botA }],
      response_metadata: { next_cursor: "" } } };
    throw new Error("Unexpected Slack GET");
  });
  const post = vi.fn(async (url: string, body: { channel?: string; text?: string }) => {
    if (url.endsWith("/auth.test")) return { data: { ok: true, team_id: team,
      team: "Selected", user_id: botA, bot_id: "B12345678" },
      headers: { "X-OAuth-Scopes": "channels:read,channels:history,chat:write" } };
    if (url.endsWith("/chat.postMessage")) {
      if (postFailure) return { data: { ok: false, error: postFailure } };
      return { data: { ok: true, channel: body.channel, ts: "456.789",
        message: { user: botA, text: body.text } } };
    }
    throw new Error("Unexpected Slack POST");
  });
  const context = { provider: { baseUrl: "https://slack.com/api" }, http: { get, post } } as never;
  const messages = () => post.mock.calls.filter(([url]) => url.endsWith("/chat.postMessage"));
  return { context, get, post, messages, setFailure: (value: string | null) => { failure = value; },
    setPostFailure: (value: string | null) => { postFailure = value; },
    setShared: (value: boolean) => { shared = value; } };
}

async function executionFixture() {
  const workspaceStore = new MemoryWorkspaceStore();
  const workspaces = new WorkspaceAuthority(workspaceStore);
  const { workspace } = await workspaces.provisionPersonalWorkspace({ userId: "alice" });
  const other = await workspaces.createTeam({ ownerUserId: "alice", name: "Other" });
  const connections = new ConnectionAuthority(new MemoryConnectionBindingStore(workspaceStore));
  const binding = await connections.attach({ actorUserId: "alice", workspaceId: workspace.id,
    provider: "slack", providerConnectionId: "remote_slack_A", ownership: "personal", label: "A" });
  const receipts = new MemoryExecutionReceiptStore(() => true);
  const approvals = new MemoryExecutionApprovalStore(() => true, receipts);
  const catalog = await createPlugFnToolCatalog({ providers: { list: () => [omrSlackProvider] } });
  const slack = slackFixture();
  const dispatch = vi.fn(async (_provider: string, action: string, options: { params: unknown }) =>
    omrSlackProvider.actions[action]!.execute(options.params, slack.context));
  let scopes = ["channels:read", "chat:write"];
  const service = new ExecutionService(catalog, connections, { action: dispatch }, receipts,
    async () => scopes, Date.now, approvals, undefined, new Uint8Array(32).fill(7));
  const principal = { kind: "web" as const, userId: "alice", workspaceId: workspace.id };
  return { workspace, other, connections, binding, receipts, approvals, catalog, slack,
    dispatch, service, principal, setScopes: (next: string[]) => { scopes = next; } };
}

describe("slack-adapter-contract", () => {
  it("runs OAuth, live scope proof and approval through PlugFn without an early Slack post", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://slack.com/api/oauth.v2.access") return Response.json({ ok: true,
        access_token: "xoxb-fixture", token_type: "Bearer", scope: "channels:read,chat:write",
        bot_user_id: botA, team: { id: teamA, name: "Selected" } });
      if (url === "https://slack.com/api/auth.test") return Response.json({ ok: true,
        team_id: teamA, team: "Selected", user_id: botA, bot_id: "B12345678" },
        { headers: { "X-OAuth-Scopes": "channels:read,chat:write" } });
      if (url.startsWith("https://slack.com/api/conversations.list")) return Response.json({ ok: true,
        channels: [localChannel], response_metadata: { next_cursor: "" } });
      if (url.startsWith("https://slack.com/api/conversations.info")) return Response.json({ ok: true,
        channel: localChannel });
      if (url === "https://slack.com/api/chat.postMessage") {
        const body = JSON.parse(String(init?.body)) as { channel: string; text: string };
        return Response.json({ ok: true, channel: body.channel, ts: "456.789",
          message: { user: botA, text: body.text } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }));
    const runtime = plugFn({ database: new MemoryAdapter(), auth: { getUserId: async () => null },
      baseUrl: "https://omr.local", encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      integrations: { slack: { type: "oauth2", clientId: "fixture-client", clientSecret: "fixture-secret",
        redirectUris: ["https://omr.local/app/oauth/callback"] } },
      retry: { enabled: true }, cache: { enabled: false }, rateLimit: { enabled: false },
    }).use(omrSlackProvider);
    await runtime.ready;
    const store = new MemoryWorkspaceStore();
    const { workspace } = await new WorkspaceAuthority(store).provisionPersonalWorkspace({ userId: "alice" });
    const connections = new ConnectionAuthority(new MemoryConnectionBindingStore(store));
    const orchestrator = new PlugFnConnectionOrchestrator(connections, runtime);
    const redirectUri = "https://omr.local/app/oauth/callback";
    const { authUrl } = await orchestrator.startOAuth({ actorUserId: "alice", workspaceId: workspace.id,
      provider: "slack", ownership: "personal", redirectUri, label: "Slack", slackAccess: "post" });
    expect(new URL(authUrl).searchParams.get("scope")?.split(",")).toEqual(["channels:read", "chat:write"]);
    const binding = await orchestrator.completeOAuth({ actorUserId: "alice", workspaceId: workspace.id,
      provider: "slack", ownership: "personal", code: "fixture-code",
      state: new URL(authUrl).searchParams.get("state")!, redirectUri, label: "Slack" });
    const receipts = new MemoryExecutionReceiptStore(() => true);
    const approvals = new MemoryExecutionApprovalStore(() => true, receipts);
    const service = new ExecutionService(await createPlugFnToolCatalog(runtime), connections, runtime, receipts,
      (connectionId, _binding, principal) => verifiedSlackScopes(runtime, {
        userId: principal.userId, workspaceId: principal.workspaceId, connectionId,
      }), Date.now, approvals, undefined, new Uint8Array(32).fill(7));
    const principal = { kind: "web" as const, userId: "alice", workspaceId: workspace.id };
    expect((await service.execute({ principal, toolId: "slack.workspace.get", params: {} })).result)
      .toMatchObject({ id: teamA, sender: { id: botA } });
    expect((await service.execute({ principal, toolId: "slack.channels.list",
      params: { workspaceId: teamA } })).result).toMatchObject({ channels: [{ id: channelA }] });
    const params = { workspaceId: teamA, channelId: channelA, senderId: botA, text: "Ready" };
    const approval = await service.requestApproval({ principal, toolId: "slack.messages.post", params,
      connectionId: binding.connection.id, idempotencyKey: "fixture-post" });
    expect(calls.filter((url) => url.endsWith("/chat.postMessage"))).toHaveLength(0);
    await service.approve(approval.id, "alice");
    expect(calls.filter((url) => url.endsWith("/chat.postMessage"))).toHaveLength(0);
    expect((await service.executeApproved(principal, approval.id)).result)
      .toMatchObject({ channel: { id: channelA }, senderId: botA });
    expect(calls.filter((url) => url.endsWith("/chat.postMessage"))).toHaveLength(1);
  });

  it("projects the Slack post schema over MCP and requests approval without posting", async () => {
    const catalog = await createPlugFnToolCatalog({ providers: { list: () => [omrSlackProvider] } });
    const manifest = catalog.get("slack.messages.post")!;
    const approvalRequests: unknown[] = [];
    const server = await createOMRMcpServer({ baseUrl: "https://omr.test", credential: "credential",
      workspaceId: "omr-workspace", fetchImpl: async (request, init) => {
        const path = new URL(typeof request === "string" ? request : request instanceof URL
          ? request.href : request.url).pathname;
        if (path === "/api/tools") return Response.json({ catalogSchemaVersion: "1.0.0",
          revision: "slack-real-manifest", tools: [manifest] });
        if (path === "/api/approvals") {
          approvalRequests.push(JSON.parse(String(init?.body)));
          return Response.json({ id: "approval-1", status: "pending", expiresAt: Date.now() + 60_000 },
            { status: 201 });
        }
        return Response.json({ error: "NOT_FOUND" }, { status: 404 });
      } });
    const client = new Client({ name: "slack-contract-test", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const schema = (await client.listTools()).tools.find(({ name }) => name === manifest.id)?.inputSchema;
      expect(schema).toMatchObject({ type: "object", required: expect.arrayContaining([
        "workspaceId", "channelId", "senderId", "text", "_omrIdempotencyKey",
      ]) });
      const base = { workspaceId: teamA, channelId: channelA, senderId: botA,
        text: "Ready", _omrIdempotencyKey: "slack-post-one" };
      for (const invalid of [{ ...base, channelId: "../foreign" },
        { ...base, username: "someone else" }, { ...base, text: " " }]) {
        expect((await client.callTool({ name: manifest.id, arguments: invalid })).isError).toBe(true);
      }
      expect(approvalRequests).toHaveLength(0);
      expect(await client.callTool({ name: manifest.id, arguments: base })).toMatchObject({
        structuredContent: { status: "approval_required", executed: false, approvalId: "approval-1" },
      });
      expect(approvalRequests).toEqual([{ workspaceId: "omr-workspace", toolId: manifest.id,
        params: { workspaceId: teamA, channelId: channelA, senderId: botA, text: "Ready" },
        idempotencyKey: "slack-post-one" }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("publishes bounded typed bot actions, distinct scopes, and a disabled rollout", async () => {
    const catalog = await createPlugFnToolCatalog({ providers: { list: () => [omrSlackProvider] } });
    expect(catalog.list().map(({ id }) => id)).toEqual([
      "slack.channels.list", "slack.messages.list", "slack.messages.post", "slack.workspace.get",
    ]);
    expect(catalog.get("slack.conversations.create")).toBeNull();
    expect(catalog.get("slack.search.messages")).toBeNull();
    expect(omrSlackProvider.triggers).toEqual({});
    const post = catalog.get("slack.messages.post")!;
    expect(post.contract).toMatchObject({ effect: "write", retry: "never",
      requiredScopes: ["channels:read", "chat:write"], resources: [
        { kind: "slack_workspace", parameter: "workspaceId" },
        { kind: "channel", parameter: "channelId" }, { kind: "sender", parameter: "senderId" },
      ] });
    expect(hasRequiredScopes(post, ["channels:read", "channels:history"])).toBe(false);
    expect(post.inputSchema).toMatchObject({ type: "object", required: expect.arrayContaining([
      "workspaceId", "channelId", "senderId", "text",
    ]) });
    const params = { workspaceId: teamA, channelId: channelA, senderId: botA, text: "Ready" };
    for (const invalid of [{ ...params, channelId: "../../elsewhere" }, { ...params, text: "  " },
      { ...params, username: "spoof" }, { ...params, text: "x".repeat(4_001) }]) {
      expect(() => omrSlackProvider.actions["messages.post"]!.parameters.parse(invalid)).toThrow();
    }
    const credentials = { PLUGFN_SLACK_CLIENT_ID: "id", PLUGFN_SLACK_CLIENT_SECRET: "secret" };
    expect(createProviderIntegrationConfig(credentials, "https://omr.example").slack).toBeUndefined();
    expect(createProviderIntegrationConfig({ ...credentials, OMR_SLACK_V1_ENABLED: "true" },
      "https://omr.example").slack).toBeDefined();
  });

  it("requests exact bot tiers and proves current token grants before discovery", async () => {
    const store = new MemoryWorkspaceStore();
    const { workspace } = await new WorkspaceAuthority(store).provisionPersonalWorkspace({ userId: "alice" });
    const getAuthUrl = vi.fn(async () => "https://slack.com/oauth/v2/authorize");
    const orchestrator = new PlugFnConnectionOrchestrator(new ConnectionAuthority(new MemoryConnectionBindingStore(store)), {
      config: { integrations: { slack: {}, linear: {} } },
      providers: { get: (name: string) => ({ name, displayName: name, auth: { type: "oauth2" }, actions: {} }) },
      connections: { getAuthUrl },
    } as never);
    const base = { actorUserId: "alice", workspaceId: workspace.id, provider: "slack",
      ownership: "personal" as const, redirectUri: "https://omr.example/app/oauth/callback", label: "Slack" };
    await orchestrator.startOAuth(base);
    await orchestrator.startOAuth({ ...base, slackAccess: "read_post" });
    expect(getAuthUrl.mock.calls[0]?.[0]).toMatchObject({ scopes: ["channels:read"] });
    expect(getAuthUrl.mock.calls[1]?.[0]).toMatchObject({
      scopes: ["channels:read", "channels:history", "chat:write"],
    });
    await expect(orchestrator.startOAuth({ ...base, scopes: ["channels:read", "files:write"] }))
      .rejects.toThrow("Slack scopes must match");
    await expect(orchestrator.startOAuth({ ...base, provider: "linear", slackAccess: "post" }))
      .rejects.toThrow("Slack access applies only to Slack");
    expect(getAuthUrl).toHaveBeenCalledTimes(2);
    const slack = slackFixture();
    const proof = vi.fn(async () => omrSlackProvider.actions["workspace.get"]!.execute({}, slack.context));
    const runtime = { action: proof, connections: { get: async () => ({ scopes: ["channels:read"] }) } };
    expect(await verifiedSlackScopes(runtime, { userId: "alice", workspaceId: workspace.id,
      connectionId: "remote_slack_A" })).toEqual(["channels:read"]);
    expect(proof).toHaveBeenCalledWith("slack", "workspace.get", expect.objectContaining({
      connectionId: "remote_slack_A", actor: { userId: "alice", tenantId: workspace.id,
        organizationId: workspace.id }, retry: { maxAttempts: 1, backoff: "exponential" },
    }));
    proof.mockResolvedValueOnce({ id: teamA, name: "Selected",
      sender: { type: "bot", id: botA, botId: "B12345678" }, verifiedScopes: null });
    expect(await verifiedSlackScopes(runtime, { userId: "alice", workspaceId: workspace.id,
      connectionId: "remote_slack_A" })).toBeUndefined();
    slack.post.mockResolvedValueOnce({ data: { ok: true, team_id: teamA,
      team: "Selected", user_id: botA } });
    await expect(omrSlackProvider.actions["workspace.get"]!.execute({}, slack.context))
      .rejects.toMatchObject({ code: "SLACK_RECONNECT_REQUIRED" });
  });

  it("limits reads and post preflight to the selected workspace, bot and local joined channel", async () => {
    const slack = slackFixture();
    const actions = omrSlackProvider.actions;
    expect(await actions["workspace.get"]!.execute({}, slack.context)).toMatchObject({
      id: teamA, sender: { type: "bot", id: botA },
    });
    expect((await actions["channels.list"]!.execute({ workspaceId: teamA }, slack.context)).channels)
      .toEqual([localChannel]);
    expect((await actions["messages.list"]!.execute({ workspaceId: teamA, channelId: channelA }, slack.context)).messages)
      .toMatchObject([{ text: "Old" }]);
    const params = { workspaceId: teamA, channelId: channelA, senderId: botA, text: "Ready" };
    await expect(actions["messages.post"]!.execute({ ...params, workspaceId: teamB }, slack.context))
      .rejects.toMatchObject({ code: "SLACK_WORKSPACE_MISMATCH" });
    await expect(actions["messages.list"]!.execute({ workspaceId: teamB, channelId: channelA }, slack.context))
      .rejects.toMatchObject({ code: "SLACK_WORKSPACE_MISMATCH" });
    await expect(actions["messages.post"]!.execute({ ...params, senderId: "U87654321" }, slack.context))
      .rejects.toMatchObject({ code: "SLACK_WORKSPACE_MISMATCH" });
    slack.setShared(true);
    await expect(actions["messages.post"]!.execute(params, slack.context))
      .rejects.toMatchObject({ code: "SLACK_CHANNEL_UNAVAILABLE" });
    expect(slack.messages()).toHaveLength(0);
  });

  it("posts only after approval; selection, scope loss and revocation fence later posts", async () => {
    const { workspace, other, connections, binding, slack, service, principal, setScopes } = await executionFixture();
    const params = { workspaceId: teamA, channelId: channelA, senderId: botA, text: "Ready" };
    await expect(service.requestApproval({ principal, toolId: "slack.messages.post",
      params: { ...params, text: " " }, idempotencyKey: "invalid" })).rejects.toMatchObject({
      code: "EXECUTION_INPUT_INVALID",
    });
    const approval = await service.requestApproval({ principal, toolId: "slack.messages.post",
      params, idempotencyKey: "post-one" });
    expect(slack.messages()).toHaveLength(0);
    await expect(service.execute({ principal, toolId: "slack.messages.post", params }))
      .rejects.toMatchObject({ code: "EXECUTION_APPROVAL_REQUIRED" });
    expect(slack.messages()).toHaveLength(0);
    await service.approve(approval.id, "alice");
    await service.executeApproved(principal, approval.id);
    expect(slack.messages()).toHaveLength(1);
    await service.executeApproved(principal, approval.id);
    expect(slack.messages()).toHaveLength(1);
    await expect(service.requestApproval({ principal: { ...principal, workspaceId: other.workspace.id },
      connectionId: binding.id, toolId: "slack.messages.post", params,
      idempotencyKey: "foreign" })).rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    const scopeLoss = await service.requestApproval({ principal, toolId: "slack.messages.post",
      params: { ...params, text: "After scope loss" }, idempotencyKey: "post-two" });
    await service.approve(scopeLoss.id, "alice");
    setScopes(["channels:read"]);
    await expect(service.executeApproved(principal, scopeLoss.id)).rejects.toThrow("chat:write");
    expect(slack.messages()).toHaveLength(1);
    setScopes(["channels:read", "chat:write"]);
    const revoked = await service.requestApproval({ principal, toolId: "slack.messages.post",
      params: { ...params, text: "After revoke" }, idempotencyKey: "post-three" });
    await service.approve(revoked.id, "alice");
    await connections.revoke("alice", binding.id);
    await expect(service.executeApproved(principal, revoked.id)).rejects.toMatchObject({
      code: "CONNECTION_ACCESS_DENIED",
    });
    expect(slack.messages()).toHaveLength(1);
    expect(workspace.id).not.toBe(other.workspace.id);
  });

  it("settles definite Slack denials and preserves uncertainty after an ambiguous send", async () => {
    const { service, principal, slack, receipts } = await executionFixture();
    const params = { workspaceId: teamA, channelId: channelA, senderId: botA, text: "Ready" };
    slack.setFailure("missing_scope");
    const preflight = await service.requestApproval({ principal, toolId: "slack.messages.post",
      params, idempotencyKey: "denied-preflight" });
    await service.approve(preflight.id, "alice");
    await expect(service.executeApproved(principal, preflight.id)).rejects.toBeInstanceOf(SlackExecutionError);
    expect(slack.messages()).toHaveLength(0);
    slack.setFailure(null);
    slack.setPostFailure("msg_too_long");
    const rejected = await service.requestApproval({ principal, toolId: "slack.messages.post",
      params: { ...params, text: "Rejected" }, idempotencyKey: "rejected-post" });
    await service.approve(rejected.id, "alice");
    await expect(service.executeApproved(principal, rejected.id)).rejects.toMatchObject({
      code: "SLACK_POST_REJECTED", message: expect.not.stringContaining("msg_too_long"),
    });
    expect([...receipts.receipts.values()].some((receipt) => receipt.status === "failed" &&
      receipt.errorCode === "slack_write_denied")).toBe(true);
    slack.setPostFailure(null);
    const ambiguous = await service.requestApproval({ principal, toolId: "slack.messages.post",
      params: { ...params, text: "Maybe sent" }, idempotencyKey: "ambiguous-post" });
    await service.approve(ambiguous.id, "alice");
    slack.post.mockImplementationOnce(async () => ({ data: { ok: true, team_id: teamA,
      team: "Selected", user_id: botA, bot_id: "B12345678" } }));
    slack.post.mockImplementationOnce(async () => ({ data: { ok: true } }));
    await expect(service.executeApproved(principal, ambiguous.id)).rejects.toMatchObject({
      code: "EXECUTION_OUTCOME_UNKNOWN",
    });
    expect(slack.messages()).toHaveLength(2);
    expect([...receipts.receipts.values()].some((receipt) => receipt.status === "uncertain" &&
      receipt.errorCode === "provider_response_ambiguous")).toBe(true);
    const coalesced = await service.requestApproval({ principal, toolId: "slack.messages.post",
      params: { ...params, text: "Maybe sent" }, idempotencyKey: "another-key" });
    expect(coalesced.id).toBe(ambiguous.id);
    await expect(service.executeApproved(principal, ambiguous.id)).rejects.toMatchObject({
      code: "EXECUTION_OUTCOME_UNKNOWN",
    });
    expect(slack.messages()).toHaveLength(2);
    const settled = await service.reconcileUncertain(principal, ambiguous.id, "effect_absent");
    expect(settled.status).toBe("failed");
    expect(slack.messages()).toHaveLength(2);
    const next = await service.requestApproval({ principal, toolId: "slack.messages.post",
      params: { ...params, text: "Maybe sent" }, idempotencyKey: "after-settlement" });
    expect(next.id).not.toBe(ambiguous.id);
    expect(slack.messages()).toHaveLength(2);
    const rateFixture = slackFixture();
    rateFixture.post.mockRejectedValueOnce({ status: 429,
      headers: new Headers({ "Retry-After": "42" }), data: { error: "private detail" } });
    await expect(omrSlackProvider.actions["channels.list"]!.execute({ workspaceId: teamA }, rateFixture.context))
      .rejects.toMatchObject({ code: "SLACK_RATE_LIMITED", retryAfterSeconds: 42,
        message: expect.not.stringContaining("private detail") });
    expect(rateFixture.get).not.toHaveBeenCalled();
  });

  it("hides Slack browser controls during a workspace or account transition", () => {
    const account = { provider: "slack", selected: true, status: "active", readiness: "ready",
      workspaceId: "omr-a" };
    const state = { overview: { selectedWorkspaceId: "omr-a", connections: [account] },
      selectedWorkspaceId: "omr-a", loading: false, busy: "" };
    expect(selectedReadySlackConnection(state)).toEqual(account);
    expect(selectedReadySlackConnection({ ...state, selectedWorkspaceId: "omr-b" })).toBeUndefined();
    expect(selectedReadySlackConnection({ ...state, busy: "select:slack" })).toBeUndefined();
    expect(selectedReadySlackConnection({ ...state, overview: { ...state.overview,
      connections: [{ ...account, status: "revoked" }] } })).toBeUndefined();
  });
});
