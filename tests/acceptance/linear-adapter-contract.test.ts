import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryAdapter, plugFn } from "plugfn";
import { createPlugFnToolCatalog, hasRequiredScopes, LinearProviderDenial } from "@oh-my-router/tools";
import { omrLinearProvider, verifiedLinearScopes } from "@oh-my-router/plugfn-runtime";
import { ConnectionAuthority, PlugFnConnectionOrchestrator } from "@oh-my-router/connections";
import { MemoryConnectionBindingStore } from "@oh-my-router/connections/testing";
import { WorkspaceAuthority } from "@oh-my-router/identity";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";
import { ExecutionService, LinearExecutionError } from "@oh-my-router/execution";
import { MemoryExecutionApprovalStore, MemoryExecutionReceiptStore } from "@oh-my-router/execution/testing";
import { createProviderIntegrationConfig } from "../../apps/web/src/lib/server/cloudflare-runtime.js";
import { createOMRRouter, type ExecutionRouteServices } from "../../apps/web/src/lib/server/router.js";

const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";
const teamA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const teamB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const issueA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const issueB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const issue = (id: string, team: string) => ({ id, identifier: id === issueA ? "A-1" : "B-1",
  title: "Existing", description: null, url: "https://linear.app/example/issue", team: { id: team, name: "Team" },
  state: { id: workspaceA, name: "Backlog" } });

afterEach(() => vi.unstubAllGlobals());

/** A provider spy answers GraphQL using only the token-selected workspace. */
function linearFixture(remote: string = workspaceA) {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  let failure: "limit" | "rejected" | "ambiguous" | null = null;
  const post = vi.fn(async (_url: string, body: { query: string; variables: Record<string, unknown> }) => {
    calls.push(body);
    if (failure === "limit") throw { status: 400, headers: { "X-RateLimit-Requests-Reset": "1800000000000" },
      data: { errors: [{ extensions: { code: "RATELIMITED" }, message: "private quota" }] } };
    if (body.query.includes("organization")) return { data: { data: { organization: { id: remote, name: "Workspace" } } } };
    if (body.query.includes("OmrTeam(")) return { data: { data: { team: body.variables.id === teamA && remote === workspaceA
      ? { id: teamA, name: "Team A" } : null } } };
    if (body.query.includes("OmrIssueTarget")) return { data: { data: { issue: body.variables.id === issueA && remote === workspaceA
      ? { id: issueA, team: { id: teamA } } : null } } };
    if (body.query.includes("OmrTeams")) return { data: { data: { teams: { nodes: remote === workspaceA
      ? [{ id: teamA, name: "Team A", key: "A" }] : [{ id: teamB, name: "Team B", key: "B" }],
      pageInfo: { hasNextPage: false, endCursor: null } } } } };
    if (body.query.includes("OmrIssues")) return { data: { data: { team: body.variables.id === teamA && remote === workspaceA
      ? { id: teamA, name: "Team A", issues: { nodes: [issue(issueA, teamA)],
        pageInfo: { hasNextPage: false, endCursor: null } } } : null } } };
    if (body.query.includes("OmrIssue(")) return { data: { data: { issue: body.variables.id === issueA && remote === workspaceA
      ? issue(issueA, teamA) : null } } };
    if (body.query.includes("mutation")) {
      if (failure === "ambiguous") throw new TypeError("connection lost after send");
      const result = failure === "rejected" ? { success: false, issue: null } :
        body.query.includes("OmrCreate")
          ? { success: true, issue: { id: issueB, identifier: "A-2", title: "New",
            url: "https://linear.app/example/new", team: { id: teamA } } }
          : { success: true, issue: { id: issueA, identifier: "A-1", title: "Updated", team: { id: teamA } } };
      return { data: { data: { [body.query.includes("OmrCreate") ? "issueCreate" : "issueUpdate"]: result } } };
    }
    throw new Error("Unexpected GraphQL query");
  });
  const context = { provider: { baseUrl: "https://api.linear.app/graphql" }, http: { post } } as never;
  const mutations = () => calls.filter((call) => call.query.includes("mutation"));
  return { calls, post, context, mutations, setFailure: (value: typeof failure) => { failure = value; } };
}

describe("linear-adapter-contract", () => {
  it("publishes only the bounded typed issue journey and stays off until OMR-15 enables it", async () => {
    const catalog = await createPlugFnToolCatalog({ providers: { list: () => [omrLinearProvider] } });
    expect(catalog.list().map(({ id }) => id)).toEqual([
      "linear.issues.create", "linear.issues.get", "linear.issues.list", "linear.issues.update",
      "linear.teams.list", "linear.workspace.get",
    ]);
    expect(catalog.get("linear.comments.create")).toBeNull();
    expect(catalog.get("linear.projects.create")).toBeNull();
    const create = catalog.get("linear.issues.create")!;
    expect(create.contract).toMatchObject({ effect: "write", requiredScopes: ["write"], retry: "never",
      resources: [{ kind: "linear_workspace", parameter: "linearWorkspaceId" },
        { kind: "team", parameter: "teamId" }] });
    expect(hasRequiredScopes(create, ["read"])).toBe(false);
    expect(catalog.get("linear.issues.list")?.contract.pagination).toEqual({
      kind: "cursor", cursorParameter: "after", maxPageSize: 50 });
    expect(() => omrLinearProvider.actions["issues.create"]!.parameters.parse({
      linearWorkspaceId: workspaceA, teamId: teamA, title: "New", stateId: issueA,
    })).toThrow();
    expect(() => omrLinearProvider.actions["issues.update"]!.parameters.parse({
      linearWorkspaceId: workspaceA, issueId: "../../another", title: "Bad",
    })).toThrow();
    expect(create.inputSchema).toMatchObject({ type: "object", required: expect.arrayContaining([
      "linearWorkspaceId", "teamId", "title" ]) });
    expect(() => omrLinearProvider.actions["issues.update"]!.parameters.parse({
      linearWorkspaceId: workspaceA, issueId: issueA,
    })).toThrow();
    expect(() => omrLinearProvider.actions["issues.create"]!.parameters.parse({
      linearWorkspaceId: workspaceA, teamId: teamA, title: "   ",
    })).toThrow();
    const credentials = { PLUGFN_LINEAR_CLIENT_ID: "id", PLUGFN_LINEAR_CLIENT_SECRET: "secret" };
    expect(createProviderIntegrationConfig(credentials, "https://omr.example").linear).toBeUndefined();
    expect(createProviderIntegrationConfig({ ...credentials, OMR_LINEAR_V1_ENABLED: "true" },
      "https://omr.example").linear).toBeDefined();
  });

  it("requests read or read/write explicitly and rejects a Linear tier on another provider", async () => {
    const store = new MemoryWorkspaceStore();
    const { workspace } = await new WorkspaceAuthority(store).provisionPersonalWorkspace({ userId: "alice" });
    const getAuthUrl = vi.fn(async () => "https://linear.app/oauth/authorize");
    const orchestrator = new PlugFnConnectionOrchestrator(new ConnectionAuthority(new MemoryConnectionBindingStore(store)), {
      config: { integrations: { linear: {}, github: {} } },
      providers: { get: (name: string) => ({ name, displayName: name, auth: { type: "oauth2" }, actions: {} }) },
      connections: { getAuthUrl },
    } as never);
    const base = { actorUserId: "alice", workspaceId: workspace.id, provider: "linear", ownership: "personal" as const,
      redirectUri: "https://omr.example/app/oauth/callback", label: "Linear" };
    await orchestrator.startOAuth(base);
    await orchestrator.startOAuth({ ...base, linearAccess: "issue_write" });
    expect(getAuthUrl.mock.calls[0]?.[0]).toMatchObject({ scopes: ["read"] });
    expect(getAuthUrl.mock.calls[1]?.[0]).toMatchObject({ scopes: ["read", "write"] });
    await expect(orchestrator.startOAuth({ ...base, provider: "github", linearAccess: "issue_write" }))
      .rejects.toThrow("Linear access applies only to Linear");
  });

  it("probes the selected token before trusting its recorded grant", async () => {
    const action = vi.fn(async () => ({ id: workspaceA, name: "Workspace" }));
    const get = vi.fn(async () => ({ scopes: ["read", "write"] }));
    const input = { userId: "alice", workspaceId: "omr_A", connectionId: "remote_A" };
    expect(await verifiedLinearScopes({ action, connections: { get } }, input)).toEqual(["read", "write"]);
    expect(action).toHaveBeenCalledWith("linear", "workspace.get", expect.objectContaining({
      connectionId: "remote_A", actor: { userId: "alice", tenantId: "omr_A", organizationId: "omr_A" },
      retry: { maxAttempts: 1, backoff: "exponential" }, cache: false,
    }));
    action.mockResolvedValueOnce({ id: workspaceB, name: 3 });
    expect(await verifiedLinearScopes({ action, connections: { get } }, input)).toBeUndefined();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("maps workspace, teams and issues from the selected token and blocks foreign targets before mutation", async () => {
    const linear = linearFixture();
    const actions = omrLinearProvider.actions;
    expect(await actions["workspace.get"]!.execute({}, linear.context)).toEqual({ id: workspaceA, name: "Workspace" });
    expect((await actions["teams.list"]!.execute({ linearWorkspaceId: workspaceA }, linear.context)).nodes)
      .toMatchObject([{ id: teamA }]);
    expect((await actions["issues.list"]!.execute({ linearWorkspaceId: workspaceA, teamId: teamA }, linear.context)).nodes)
      .toMatchObject([{ id: issueA, team: { id: teamA } }]);
    expect(await actions["issues.get"]!.execute({ linearWorkspaceId: workspaceA, issueId: issueA }, linear.context))
      .toMatchObject({ id: issueA });
    await expect(actions["issues.create"]!.execute({ linearWorkspaceId: workspaceB, teamId: teamA, title: "New" },
      linear.context)).rejects.toMatchObject({ code: "LINEAR_WORKSPACE_MISMATCH" });
    await expect(actions["issues.create"]!.execute({ linearWorkspaceId: workspaceA, teamId: teamB, title: "New" },
      linear.context)).rejects.toMatchObject({ code: "LINEAR_TARGET_UNAVAILABLE" });
    await expect(actions["issues.update"]!.execute({ linearWorkspaceId: workspaceA, issueId: issueB, title: "No" },
      linear.context)).rejects.toMatchObject({ code: "LINEAR_TARGET_UNAVAILABLE" });
    expect(linear.mutations()).toHaveLength(0);
  });

  it("fences create and update behind approval, selected account, and revocation", async () => {
    const store = new MemoryWorkspaceStore();
    const workspaces = new WorkspaceAuthority(store);
    const { workspace } = await workspaces.provisionPersonalWorkspace({ userId: "alice" });
    const other = await workspaces.createTeam({ ownerUserId: "alice", name: "Other" });
    const connections = new ConnectionAuthority(new MemoryConnectionBindingStore(store));
    const binding = await connections.attach({ actorUserId: "alice", workspaceId: workspace.id,
      provider: "linear", providerConnectionId: "remote_linear_A", ownership: "personal", label: "A" });
    const receipts = new MemoryExecutionReceiptStore(() => true);
    const approvals = new MemoryExecutionApprovalStore(() => true, receipts);
    const catalog = await createPlugFnToolCatalog({ providers: { list: () => [omrLinearProvider] } });
    const linear = linearFixture();
    const dispatch = vi.fn(async (_provider: string, action: string, options: { params: unknown }) =>
      omrLinearProvider.actions[action]!.execute(options.params, linear.context));
    let scopes = ["read"];
    const service = new ExecutionService(catalog, connections, { action: dispatch }, receipts,
      async () => scopes, Date.now, approvals, undefined, new Uint8Array(32).fill(7));
    const principal = { kind: "web" as const, userId: "alice", workspaceId: workspace.id };
    await expect(service.requestApproval({ principal, toolId: "linear.issues.create",
      params: { linearWorkspaceId: workspaceA, teamId: teamA, title: "  " },
      idempotencyKey: "blank-title" })).rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    await expect(service.requestApproval({ principal, toolId: "linear.issues.update",
      params: { linearWorkspaceId: workspaceA, issueId: issueA }, idempotencyKey: "empty-update" }))
      .rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    const params = { linearWorkspaceId: workspaceA, teamId: teamA, title: "New" };
    await expect(service.requestApproval({ principal, toolId: "linear.issues.create", params,
      idempotencyKey: "linear-create" })).rejects.toThrow("write");
    scopes = ["read", "write"];
    const approval = await service.requestApproval({ principal, toolId: "linear.issues.create", params,
      connectionId: binding.id, idempotencyKey: "linear-create" });
    await expect(service.execute({ principal, toolId: "linear.issues.create", params }))
      .rejects.toMatchObject({ code: "EXECUTION_APPROVAL_REQUIRED" });
    expect(linear.mutations()).toHaveLength(0);
    await expect(service.requestApproval({ principal: { ...principal, workspaceId: other.workspace.id },
      toolId: "linear.issues.create", connectionId: binding.id, params,
      idempotencyKey: "cross-workspace" })).rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    await service.approve(approval.id, "alice");
    await service.executeApproved(principal, approval.id);
    expect(linear.mutations()).toHaveLength(1);
    expect(dispatch.mock.calls[0]?.[2]).toMatchObject({ connectionId: "remote_linear_A",
      actor: { tenantId: workspace.id } });
    await service.executeApproved(principal, approval.id);
    expect(linear.mutations()).toHaveLength(1);
    const update = await service.requestApproval({ principal, toolId: "linear.issues.update",
      params: { linearWorkspaceId: workspaceA, issueId: issueA, title: "Updated" },
      idempotencyKey: "linear-update" });
    await service.approve(update.id, "alice");
    await connections.revoke("alice", binding.id);
    await expect(service.executeApproved(principal, update.id)).rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    expect(linear.mutations()).toHaveLength(1);
  });

  it("runs the OAuth, PlugFn, OMR approval and GraphQL journey with zero early mutations", async () => {
    const calls: string[] = [];
    let rateIssue = false;
    let ambiguousCreate = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.linear.app/oauth/token") {
        return Response.json({ access_token: "fixture-token", token_type: "Bearer", scope: "read,write" });
      }
      if (url !== "https://api.linear.app/graphql") throw new Error(`Unexpected URL: ${url}`);
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      calls.push(body.query);
      if (body.query.includes("organization")) {
        return Response.json({ data: { organization: { id: workspaceA, name: "Fixture workspace" } } });
      }
      if (body.query.includes("OmrTeam(")) {
        return Response.json({ data: { team: { id: teamA, name: "Team A" } } });
      }
      if (body.query.includes("OmrIssue(")) {
        return rateIssue
          ? Response.json({ errors: [{ message: "private quota", extensions: { code: "RATELIMITED" } }] },
            { status: 400, headers: { "X-RateLimit-Requests-Reset": "1800000000000" } })
          : Response.json({ data: { issue: issue(issueA, teamA) } });
      }
      if (body.query.includes("OmrCreate")) {
        if (ambiguousCreate) throw new TypeError("connection lost after mutation dispatch");
        return Response.json({ data: { issueCreate: { success: true, issue: {
          id: issueB, identifier: "A-2", title: "New", url: "https://linear.app/example/new",
          team: { id: teamA },
        } } } });
      }
      throw new Error("Unexpected query");
    }));
    const runtime = plugFn({ database: new MemoryAdapter(), auth: { getUserId: async () => null },
      baseUrl: "https://omr.local", encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      integrations: { linear: { type: "oauth2", clientId: "fixture-client", clientSecret: "fixture-secret",
        redirectUris: ["https://omr.local/app/oauth/callback"] } },
      retry: { enabled: true }, cache: { enabled: false }, rateLimit: { enabled: false },
    }).use(omrLinearProvider);
    await runtime.ready;
    const store = new MemoryWorkspaceStore();
    const { workspace } = await new WorkspaceAuthority(store).provisionPersonalWorkspace({ userId: "alice" });
    const connections = new ConnectionAuthority(new MemoryConnectionBindingStore(store));
    const orchestrator = new PlugFnConnectionOrchestrator(connections, runtime);
    const redirectUri = "https://omr.local/app/oauth/callback";
    const { authUrl } = await orchestrator.startOAuth({ actorUserId: "alice", workspaceId: workspace.id,
      provider: "linear", ownership: "personal", redirectUri, label: "Linear", linearAccess: "issue_write" });
    const binding = await orchestrator.completeOAuth({ actorUserId: "alice", workspaceId: workspace.id,
      provider: "linear", ownership: "personal", code: "fixture-code",
      state: new URL(authUrl).searchParams.get("state")!, redirectUri, label: "Linear" });
    const receipts = new MemoryExecutionReceiptStore(() => true);
    const approvals = new MemoryExecutionApprovalStore(() => true, receipts);
    const service = new ExecutionService(await createPlugFnToolCatalog(runtime), connections, runtime, receipts,
      (connectionId, _binding, principal) => verifiedLinearScopes(runtime, {
        userId: principal.userId, workspaceId: principal.workspaceId, connectionId,
      }), Date.now, approvals, undefined, new Uint8Array(32).fill(7));
    const principal = { kind: "web" as const, userId: "alice", workspaceId: workspace.id };
    expect((await service.execute({ principal, toolId: "linear.workspace.get", params: {} })).result)
      .toMatchObject({ id: workspaceA });
    const params = { linearWorkspaceId: workspaceA, teamId: teamA, title: "New" };
    const approval = await service.requestApproval({ principal, toolId: "linear.issues.create", params,
      connectionId: binding.connection.id, idempotencyKey: "create-fixture" });
    expect(calls.filter((query) => query.includes("mutation"))).toHaveLength(0);
    await service.approve(approval.id, "alice");
    expect(calls.filter((query) => query.includes("mutation"))).toHaveLength(0);
    expect((await service.executeApproved(principal, approval.id)).result)
      .toMatchObject({ success: true, issue: { id: issueB } });
    expect(calls.filter((query) => query.includes("mutation"))).toHaveLength(1);
    rateIssue = true;
    await expect(service.execute({ principal, toolId: "linear.issues.get",
      params: { linearWorkspaceId: workspaceA, issueId: issueA } })).rejects.toMatchObject({
        code: "LINEAR_RATE_LIMITED", rateLimitResetAt: 1800000000000,
      });
    expect([...receipts.receipts.values()].some((receipt) => receipt.errorCode === "linear_read_denied" &&
      receipt.status === "failed")).toBe(true);
    rateIssue = false;
    ambiguousCreate = true;
    const next = await service.requestApproval({ principal, toolId: "linear.issues.create", params,
      idempotencyKey: "ambiguous-create" });
    await service.approve(next.id, "alice");
    await expect(service.executeApproved(principal, next.id)).rejects.toMatchObject({
      code: "EXECUTION_OUTCOME_UNKNOWN",
    });
    const mutationCount = calls.filter((query) => query.includes("mutation")).length;
    expect(mutationCount).toBe(2);
    await expect(service.executeApproved(principal, next.id)).rejects.toMatchObject({
      code: "EXECUTION_OUTCOME_UNKNOWN",
    });
    expect(calls.filter((query) => query.includes("mutation"))).toHaveLength(mutationCount);
  });

  it("settles definite rate limits and rejections while keeping ambiguous mutations uncertain", async () => {
    const actions = omrLinearProvider.actions;
    const linear = linearFixture();
    linear.setFailure("limit");
    await expect(actions["issues.get"]!.execute({ linearWorkspaceId: workspaceA, issueId: issueA }, linear.context))
      .rejects.toMatchObject({ code: "LINEAR_RATE_LIMITED", rateLimitResetAt: 1800000000000 });
    expect(linear.post).toHaveBeenCalledTimes(1);
    linear.setFailure("rejected");
    await expect(actions["issues.create"]!.execute({ linearWorkspaceId: workspaceA, teamId: teamA, title: "New" },
      linear.context)).rejects.toMatchObject({ code: "LINEAR_INVALID_CHANGE", phase: "write" });
    linear.setFailure("ambiguous");
    await expect(actions["issues.update"]!.execute({ linearWorkspaceId: workspaceA, issueId: issueA, title: "Updated" },
      linear.context)).rejects.toThrow("connection lost after send");
  });

  it("returns safe Linear rate timing and receipt identity through the HTTP protocol", async () => {
    const denial = new LinearProviderDenial("read", "LINEAR_RATE_LIMITED",
      { rateLimitResetAt: 1800000000000, retryAfterSeconds: 40 });
    const router = createOMRRouter(undefined, undefined, undefined, {
      execute: async () => { throw new LinearExecutionError("receipt_linear", denial); },
    } as unknown as ExecutionRouteServices);
    const response = await router.handle(new Request("https://omr.example/api/tools/execute", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "omr_A", toolId: "linear.issues.get", params: {} }),
    }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("40");
    expect(response.headers.get("x-ratelimit-requests-reset")).toBe("1800000000000");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "LINEAR_RATE_LIMITED", receiptId: "receipt_linear",
      message: "Linear rate limit reached. Retry after its reset window." });
  });
});
