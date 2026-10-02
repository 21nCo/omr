import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryAdapter, plugFn } from "plugfn";
import { createPlugFnToolCatalog, hasRequiredScopes, LinearProviderDenial, linearDenial } from "@oh-my-router/tools";
import { omrLinearProvider, verifiedLinearScopes } from "@oh-my-router/plugfn-runtime";
import { ConnectionAuthority, PlugFnConnectionOrchestrator } from "@oh-my-router/connections";
import { MemoryConnectionBindingStore } from "@oh-my-router/connections/testing";
import { WorkspaceAuthority } from "@oh-my-router/identity";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";
import { ExecutionService, LinearExecutionError, publicApproval } from "@oh-my-router/execution";
import { LinearIntentTransactionRequiredError } from "@oh-my-router/execution";
import { OMRClient } from "@oh-my-router/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MemoryExecutionApprovalStore, MemoryExecutionReceiptStore } from "@oh-my-router/execution/testing";
import { createOMRMcpServer } from "../../packages/mcp/src/server.js";
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
  let failure: "limit" | "rejected" | "ambiguous" | "partial" | "partial-http" |
    "null-data" | "errors-only" | null = null;
  let readFailure: 400 | 422 | null = null;
  const post = vi.fn(async (_url: string, body: { query: string; variables: Record<string, unknown> }) => {
    calls.push(body);
    if (failure === "limit") throw { status: 400, headers: { "X-RateLimit-Requests-Reset": "1800000000000" },
      data: { errors: [{ extensions: { code: "RATELIMITED" }, message: "private quota" }] } };
    if (body.query.includes("organization")) return { data: { data: { organization: { id: remote, name: "Workspace" } } } };
    if (readFailure && (body.query.includes("OmrIssue(") || body.query.includes("OmrTeam("))) {
      throw { status: readFailure, data: { errors: [{ message: "private query failure" }] } };
    }
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
      if (failure === "errors-only") return { data: { errors: [{
        extensions: { code: "RATELIMITED" }, message: "private quota",
      }] } };
      if (failure === "null-data") return { data: { data: null, errors: [{
        extensions: { code: "FORBIDDEN" }, message: "private nested field",
      }] } };
      const result = failure === "rejected" ? { success: false, issue: null } :
        body.query.includes("OmrCreate")
          ? { success: true, issue: { id: issueB, identifier: "A-2", title: "New",
            url: "https://linear.app/example/new", team: { id: teamA } } }
          : { success: true, issue: { id: issueA, identifier: "A-1", title: "Updated", team: { id: teamA } } };
      const key = body.query.includes("OmrCreate") ? "issueCreate" : "issueUpdate";
      if (failure === "partial" || failure === "partial-http") {
        const partial = { data: { [key]: { success: true, issue: {
          id: key === "issueCreate" ? issueB : issueA, identifier: "A-2",
          team: { id: teamA },
        } } }, errors: [{ extensions: {
          code: failure === "partial-http" ? "AUTHENTICATION_ERROR" : "RATELIMITED",
        }, message: "private nested field" }] };
        if (failure === "partial-http") throw { status: 400, data: partial };
        return { data: partial };
      }
      return { data: { data: { [key]: result } } };
    }
    throw new Error("Unexpected GraphQL query");
  });
  const context = { provider: { baseUrl: "https://api.linear.app/graphql" }, http: { post } } as never;
  const mutations = () => calls.filter((call) => call.query.includes("mutation"));
  return { calls, post, context, mutations, setFailure: (value: typeof failure) => { failure = value; },
    setReadFailure: (value: typeof readFailure) => { readFailure = value; } };
}

/** Share the scoped approval stores and provider spy across write boundary cases. */
async function executionFixture(verified = false) {
  const store = new MemoryWorkspaceStore();
  const workspaces = new WorkspaceAuthority(store);
  const { workspace } = await workspaces.provisionPersonalWorkspace({ userId: "alice" });
  const connections = new ConnectionAuthority(new MemoryConnectionBindingStore(store));
  const binding = await connections.attach({ actorUserId: "alice", workspaceId: workspace.id,
    provider: "linear", providerConnectionId: "remote_linear_A", ownership: "personal", label: "A" });
  const receipts = new MemoryExecutionReceiptStore(() => true);
  const approvals = new MemoryExecutionApprovalStore(() => true, receipts);
  const catalog = await createPlugFnToolCatalog({ providers: { list: () => [omrLinearProvider] } });
  const linear = linearFixture();
  const dispatch = vi.fn(async (_provider: string, action: string, options: { params: unknown }) =>
    omrLinearProvider.actions[action]!.execute(options.params, linear.context));
  let scopes = ["read", "write"];
  const proofAction = vi.fn(async () => ({ id: workspaceA, name: "Workspace" }));
  const service = new ExecutionService(catalog, connections, { action: dispatch }, receipts,
    (connectionId, _binding, principal) => verified
      ? verifiedLinearScopes({ action: proofAction, connections: { get: async () => ({ scopes }) } }, {
        connectionId, userId: principal.userId, workspaceId: principal.workspaceId,
      }) : Promise.resolve(scopes), Date.now, approvals, undefined, new Uint8Array(32).fill(7));
  const principal = { kind: "web" as const, userId: "alice", workspaceId: workspace.id };
  return { workspaces, workspace, connections, binding, receipts, approvals, linear, dispatch,
    service, principal, proofAction, setScopes: (next: string[]) => { scopes = next; } };
}

describe("linear-adapter-contract", () => {
  it("discovers the real Linear update schema over MCP and rejects invalid or empty changes before approval", async () => {
    const catalog = await createPlugFnToolCatalog({ providers: { list: () => [omrLinearProvider] } });
    const update = catalog.get("linear.issues.update")!;
    const approvals: unknown[] = [];
    const server = await createOMRMcpServer({ baseUrl: "https://omr.test", credential: "credential",
      workspaceId: "omr-workspace", fetchImpl: async (request, init) => {
        const path = new URL(typeof request === "string" ? request : request instanceof URL
          ? request.href : request.url).pathname;
        if (path === "/api/tools") return Response.json({ catalogSchemaVersion: "1.0.0",
          revision: "linear-real-manifest", tools: [update] });
        if (path === "/api/approvals") {
          approvals.push(JSON.parse(String(init?.body)));
          return Response.json({ id: "approval-1", status: "pending", expiresAt: Date.now() + 60_000 },
            { status: 201 });
        }
        return Response.json({ error: "NOT_FOUND" }, { status: 404 });
      } });
    const client = new Client({ name: "linear-contract-test", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const schema = (await client.listTools()).tools.find(({ name }) => name === update.id)?.inputSchema;
      expect(schema).toMatchObject({ type: "object", required: expect.arrayContaining([
        "linearWorkspaceId", "issueId", "_omrIdempotencyKey",
      ]), properties: { linearWorkspaceId: expect.any(Object), issueId: expect.any(Object),
        title: expect.any(Object), description: expect.any(Object), priority: expect.any(Object) } });
      expect(schema?.anyOf).toHaveLength(3);
      const target = { linearWorkspaceId: workspaceA, issueId: issueA,
        _omrIdempotencyKey: "linear-update-1" };
      for (const arguments_ of [target, { ...target, issueId: "../../foreign", title: "Changed" },
        { ...target, title: "Changed", stateId: workspaceA },
        { issueId: issueA, title: "Changed", _omrIdempotencyKey: "missing-workspace" }]) {
        expect((await client.callTool({ name: update.id, arguments: arguments_ })).isError).toBe(true);
      }
      expect(approvals).toHaveLength(0);
      for (const [index, change] of [{ title: "Changed" }, { description: "Updated details" },
        { priority: 2 }].entries()) {
        await expect(client.callTool({ name: update.id,
          arguments: { ...target, ...change, _omrIdempotencyKey: `linear-update-${index}` } }))
          .resolves.toMatchObject({
            structuredContent: { status: "approval_required", executed: false, approvalId: "approval-1" },
          });
      }
      expect(approvals).toEqual([{ title: "Changed" }, { description: "Updated details" },
        { priority: 2 }].map((change, index) => ({
        workspaceId: "omr-workspace", toolId: update.id,
        params: { linearWorkspaceId: workspaceA, issueId: issueA, ...change },
        idempotencyKey: `linear-update-${index}`,
      })));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("publishes only the bounded typed issue journey and stays off until OMR-15 enables it", async () => {
    const catalog = await createPlugFnToolCatalog({ providers: { list: () => [omrLinearProvider] } });
    expect(catalog.list().map(({ id }) => id)).toEqual([
      "linear.issues.create", "linear.issues.get", "linear.issues.list", "linear.issues.update",
      "linear.teams.list", "linear.workspace.get",
    ]);
    expect(catalog.get("linear.comments.create")).toBeNull();
    expect(catalog.get("linear.projects.create")).toBeNull();
    const create = catalog.get("linear.issues.create")!;
    expect(create.contract).toMatchObject({ effect: "write", requiredScopes: ["read", "write"], retry: "never",
      resources: [{ kind: "linear_workspace", parameter: "linearWorkspaceId" },
        { kind: "team", parameter: "teamId" }] });
    expect(hasRequiredScopes(create, ["read"])).toBe(false);
    expect(hasRequiredScopes(create, ["write"])).toBe(false);
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
    await expect(orchestrator.startOAuth({ ...base, linearAccess: "admin" as never }))
      .rejects.toThrow("Unknown Linear access tier");
    await expect(orchestrator.startOAuth({ ...base, scopes: ["read", "admin"] }))
      .rejects.toThrow("Linear scopes must match the selected access tier");
    expect(getAuthUrl).toHaveBeenCalledTimes(2);
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
    expect(get).toHaveBeenCalledTimes(2);
    get.mockResolvedValueOnce({ scopes: ["write"] });
    await expect(verifiedLinearScopes({ action, connections: { get } }, input))
      .rejects.toMatchObject({ code: "LINEAR_PERMISSION_DENIED" });
    expect(action).toHaveBeenCalledTimes(2);
    get.mockResolvedValueOnce({ scopes: undefined });
    expect(await verifiedLinearScopes({ action, connections: { get } }, input)).toBeUndefined();
    expect(action).toHaveBeenCalledTimes(2);
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
    const { workspaces, workspace, connections, binding, linear, dispatch, service, principal,
      setScopes } = await executionFixture();
    const other = await workspaces.createTeam({ ownerUserId: "alice", name: "Other" });
    setScopes(["read"]);
    await expect(service.requestApproval({ principal, toolId: "linear.issues.create",
      params: { linearWorkspaceId: workspaceA, teamId: teamA, title: "  " },
      idempotencyKey: "blank-title" })).rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    await expect(service.requestApproval({ principal, toolId: "linear.issues.update",
      params: { linearWorkspaceId: workspaceA, issueId: issueA }, idempotencyKey: "empty-update" }))
      .rejects.toMatchObject({ code: "EXECUTION_INPUT_INVALID" });
    const params = { linearWorkspaceId: workspaceA, teamId: teamA, title: "New" };
    await expect(service.requestApproval({ principal, toolId: "linear.issues.create", params,
      idempotencyKey: "linear-create" })).rejects.toThrow("write");
    setScopes(["read", "write"]);
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

  it("denies reads and both approved issue writes when the recorded Linear grant loses read", async () => {
    const { binding, service, principal, setScopes, linear, proofAction } = await executionFixture(true);
    const create = { linearWorkspaceId: workspaceA, teamId: teamA, title: "New" };
    const update = { linearWorkspaceId: workspaceA, issueId: issueA, title: "Updated" };
    const createApproval = await service.requestApproval({ principal, toolId: "linear.issues.create",
      connectionId: binding.id, params: create, idempotencyKey: "missing-read-create" });
    const updateApproval = await service.requestApproval({ principal, toolId: "linear.issues.update",
      connectionId: binding.id, params: update, idempotencyKey: "missing-read-update" });
    await service.approve(createApproval.id, "alice");
    await service.approve(updateApproval.id, "alice");
    const probesBefore = proofAction.mock.calls.length;
    setScopes(["write"]);
    await expect(service.execute({ principal, toolId: "linear.issues.get",
      params: { linearWorkspaceId: workspaceA, issueId: issueA } }))
      .rejects.toMatchObject({ code: "LINEAR_PERMISSION_DENIED" });
    await expect(service.requestApproval({ principal, toolId: "linear.issues.create",
      connectionId: binding.id, params: { ...create, title: "Another" }, idempotencyKey: "missing-read-new" }))
      .rejects.toMatchObject({ code: "LINEAR_PERMISSION_DENIED" });
    for (const approval of [createApproval, updateApproval]) {
      await expect(service.executeApproved(principal, approval.id))
        .rejects.toMatchObject({ code: "LINEAR_PERMISSION_DENIED" });
    }
    expect(proofAction).toHaveBeenCalledTimes(probesBefore);
    expect(linear.mutations()).toHaveLength(0);
  });

  it("coalesces concurrent approval requests for one Linear intent and releases a rejected one", async () => {
    const { binding, connections, linear, service, principal } = await executionFixture();
    const params = { linearWorkspaceId: workspaceA, teamId: teamA, title: "One intent" };
    const [first, duplicate] = await Promise.all([
      service.requestApproval({ principal, toolId: "linear.issues.create", params,
        connectionId: binding.id, idempotencyKey: "pending-one" }),
      service.requestApproval({ principal, toolId: "linear.issues.create", params: { ...params },
        connectionId: binding.id, idempotencyKey: "pending-two" }),
    ]);
    expect(duplicate.id).toBe(first.id);
    expect(publicApproval(duplicate)).not.toHaveProperty("intentHash");
    expect(linear.mutations()).toHaveLength(0);
    const otherTarget = await service.requestApproval({ principal, toolId: "linear.issues.create",
      params: { ...params, teamId: teamB }, connectionId: binding.id, idempotencyKey: "other-target" });
    expect(otherTarget.id).not.toBe(first.id);
    const otherAccount = await connections.attach({ actorUserId: "alice", workspaceId: principal.workspaceId,
      provider: "linear", providerConnectionId: "remote_linear_B", ownership: "personal", label: "B" });
    const otherAccountApproval = await service.requestApproval({ principal, toolId: "linear.issues.create",
      params, connectionId: otherAccount.id, idempotencyKey: "other-account" });
    expect(otherAccountApproval.id).not.toBe(first.id);
    await service.reject(first.id, "alice");
    const afterRejection = await service.requestApproval({ principal, toolId: "linear.issues.create",
      params, connectionId: binding.id, idempotencyKey: "after-rejection" });
    expect(afterRejection.id).not.toBe(first.id);
  });

  it("requires an explicit recorded decision before retrying an uncertain Linear create", async () => {
    const { binding, linear, service, principal, receipts } = await executionFixture();
    const params = { linearWorkspaceId: workspaceA, teamId: teamA, title: "Reconcile me" };
    // The provider returned a completed, partial mutation response. Its effect
    // is unclear, but no request remains in flight when the user checks Linear.
    linear.setFailure("partial");
    const approval = await service.requestApproval({ principal, toolId: "linear.issues.create",
      params, connectionId: binding.id, idempotencyKey: "reconcile-first" });
    await service.approve(approval.id, "alice");
    await expect(service.executeApproved(principal, approval.id)).rejects.toMatchObject({
      code: "EXECUTION_OUTCOME_UNKNOWN",
    });
    const repeated = await service.requestApproval({ principal, toolId: "linear.issues.create",
      params, connectionId: binding.id, idempotencyKey: "reconcile-fresh" });
    expect(repeated.id).toBe(approval.id);
    expect(linear.mutations()).toHaveLength(1);
    await expect(service.reconcileUncertain({ ...principal, workspaceId: "foreign_workspace" },
      approval.id, "effect_absent")).rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    expect(linear.mutations()).toHaveLength(1);
    const reconciled = await service.reconcileUncertain(principal, approval.id, "effect_absent");
    expect(reconciled).toMatchObject({ status: "failed", reconciledAs: "effect_absent" });
    expect(receipts.receipts.get(reconciled.executionReceiptId!)).toMatchObject({
      status: "uncertain", errorCode: "provider_response_ambiguous",
    });
    expect(linear.mutations()).toHaveLength(1);
    await expect(service.executeApproved(principal, approval.id))
      .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    const next = await service.requestApproval({ principal, toolId: "linear.issues.create",
      params, connectionId: binding.id, idempotencyKey: "reconcile-next" });
    expect(next.id).not.toBe(approval.id);
    linear.setFailure(null);
    await service.approve(next.id, "alice");
    await service.executeApproved(principal, next.id);
    expect(linear.mutations()).toHaveLength(2);
  });

  it("keeps a transport-uncertain Linear create fenced after a no-effect observation", async () => {
    const { binding, linear, service, principal, receipts } = await executionFixture();
    const params = { linearWorkspaceId: workspaceA, teamId: teamA, title: "Still in flight" };
    linear.setFailure("ambiguous");
    const approval = await service.requestApproval({ principal, toolId: "linear.issues.create",
      params, connectionId: binding.id, idempotencyKey: "transport-first" });
    await service.approve(approval.id, "alice");
    await expect(service.executeApproved(principal, approval.id)).rejects.toMatchObject({
      code: "EXECUTION_OUTCOME_UNKNOWN",
    });
    const uncertain = await service.approvalStatus(principal, approval.id);
    expect(receipts.receipts.get(uncertain.executionReceiptId!)?.errorCode).toBe("provider_outcome_unknown");
    await expect(service.reconcileUncertain(principal, approval.id, "effect_absent"))
      .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    const retry = await service.requestApproval({ principal, toolId: "linear.issues.create",
      params, connectionId: binding.id, idempotencyKey: "transport-second" });
    expect(retry.id).toBe(approval.id);
    expect(linear.mutations()).toHaveLength(1);
    await service.reconcileUncertain(principal, approval.id, "effect_present");
    await expect(service.executeApproved(principal, approval.id))
      .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    expect(linear.mutations()).toHaveLength(1);
  });

  it.each(["linear.issues.create", "linear.issues.update"] as const)(
    "closes a verified %s effect when receipt persistence left it running", async (toolId) => {
      const { binding, linear, service, principal, receipts, approvals } = await executionFixture();
      const params = toolId === "linear.issues.create"
        ? { linearWorkspaceId: workspaceA, teamId: teamA, title: "Verified effect" }
        : { linearWorkspaceId: workspaceA, issueId: issueA, title: "Verified effect" };
      linear.setFailure("ambiguous");
      const approval = await service.requestApproval({ principal, toolId, params,
        connectionId: binding.id, idempotencyKey: `${toolId}-running` });
      await service.approve(approval.id, principal.userId);
      await expect(service.executeApproved(principal, approval.id))
        .rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN" });
      const linked = approvals.approvals.get(approval.id)!;
      const receipt = receipts.receipts.get(linked.executionReceiptId!)!;
      // Simulate a crash after the approval became uncertain but before the
      // receipt's uncertain-state write persisted.
      receipt.status = "running";
      receipt.errorCode = null;
      receipt.completedAt = null;
      const retry = await service.requestApproval({ principal, toolId, params,
        connectionId: binding.id, idempotencyKey: `${toolId}-retry` });
      expect(retry.id).toBe(approval.id);
      await expect(service.reconcileUncertain(principal, approval.id, "effect_absent"))
        .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
      await expect(service.reconcileUncertain({ ...principal, workspaceId: "foreign_workspace" },
        approval.id, "effect_present")).rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
      expect(await service.reconcileUncertain(principal, approval.id, "effect_present"))
        .toMatchObject({ status: "consumed", reconciledAs: "effect_present" });
      await expect(service.executeApproved(principal, approval.id))
        .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
      expect(linear.mutations()).toHaveLength(1);
    },
  );

  it("does not release a timed-out write while its provider promise can still complete", async () => {
    const { binding, dispatch, service, principal, receipts } = await executionFixture();
    const params = { linearWorkspaceId: workspaceA, teamId: teamA, title: "Late create" };
    const approval = await service.requestApproval({ principal, toolId: "linear.issues.create",
      params, connectionId: binding.id, idempotencyKey: "late-first" });
    await service.approve(approval.id, "alice");
    let finishProvider: (() => void) | undefined;
    dispatch.mockImplementationOnce(async () => new Promise((resolve) => {
      finishProvider = () => resolve({ id: issueB });
    }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const executing = service.executeApproved(principal, approval.id)
        .then(() => null, (error: unknown) => error);
      await vi.waitFor(() => expect(finishProvider).toBeTypeOf("function"),
        { timeout: 1_000, interval: 1 });
      await vi.advanceTimersByTimeAsync(61_000);
      await expect(executing).resolves.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN" });
      const uncertain = await service.approvalStatus(principal, approval.id);
      expect(receipts.receipts.get(uncertain.executionReceiptId!)).toMatchObject({
        status: "uncertain", errorCode: "invocation_outcome_unknown",
      });
      await expect(service.reconcileUncertain(principal, approval.id, "effect_absent"))
        .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
      const retry = await service.requestApproval({ principal, toolId: "linear.issues.create",
        params, connectionId: binding.id, idempotencyKey: "late-second" });
      expect(retry.id).toBe(approval.id);
      finishProvider!();
      await Promise.resolve();
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      finishProvider?.();
      vi.useRealTimers();
    }
  });

  it("closes an effect-present Linear update without replaying its dispatched mutation", async () => {
    const { binding, linear, service, principal } = await executionFixture();
    const params = { linearWorkspaceId: workspaceA, issueId: issueA, title: "Observed update" };
    linear.setFailure("ambiguous");
    const approval = await service.requestApproval({ principal, toolId: "linear.issues.update",
      params, connectionId: binding.id, idempotencyKey: "observed-update" });
    const coalesced = await service.requestApproval({ principal, toolId: "linear.issues.update",
      params, connectionId: binding.id, idempotencyKey: "observed-update-retry" });
    expect(coalesced.id).toBe(approval.id);
    await service.approve(approval.id, "alice");
    await expect(service.executeApproved(principal, approval.id))
      .rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN" });
    expect(linear.mutations()).toHaveLength(1);
    expect(await service.reconcileUncertain(principal, approval.id, "effect_present"))
      .toMatchObject({ status: "consumed", reconciledAs: "effect_present" });
    await expect(service.executeApproved(principal, approval.id))
      .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    expect(linear.mutations()).toHaveLength(1);
    const sameAction = await service.requestApproval({ principal, toolId: "linear.issues.update",
      params, connectionId: binding.id, idempotencyKey: "observed-update-retry" });
    expect(sameAction).toMatchObject({ id: approval.id, status: "consumed" });
  });

  it.each(["linear.issues.create", "linear.issues.update"] as const)(
    "retains a coalesced %s retry key after successful settlement", async (toolId) => {
      const { binding, linear, service, principal } = await executionFixture();
      const params = toolId === "linear.issues.create"
        ? { linearWorkspaceId: workspaceA, teamId: teamA, title: "One issue" }
        : { linearWorkspaceId: workspaceA, issueId: issueA, title: "One update" };
      const first = await service.requestApproval({ principal, toolId, params,
        connectionId: binding.id, idempotencyKey: `${toolId}-first` });
      const coalesced = await service.requestApproval({ principal, toolId, params,
        connectionId: binding.id, idempotencyKey: `${toolId}-repeat` });
      expect(coalesced.id).toBe(first.id);
      await service.approve(first.id, "alice");
      await service.executeApproved(principal, first.id);
      const retry = await service.requestApproval({ principal, toolId, params,
        connectionId: binding.id, idempotencyKey: `${toolId}-repeat` });
      expect(retry).toMatchObject({ id: first.id, status: "consumed" });
      expect(linear.mutations()).toHaveLength(1);
      const deliberate = await service.requestApproval({ principal, toolId, params,
        connectionId: binding.id, idempotencyKey: `${toolId}-new-action` });
      expect(deliberate.id).not.toBe(first.id);
    });

  it("preserves expired and manifest-stale predispatch intents while allowing a new request", async () => {
    const { binding, service, principal, approvals } = await executionFixture();
    const params = { linearWorkspaceId: workspaceA, teamId: teamA, title: "Expiring" };
    const first = await service.requestApproval({ principal, toolId: "linear.issues.create", params,
      connectionId: binding.id, idempotencyKey: "expiring-first" });
    approvals.approvals.get(first.id)!.expiresAt = Date.now() - 1;
    expect((await service.requestApproval({ principal, toolId: "linear.issues.create", params,
      connectionId: binding.id, idempotencyKey: "expiring-first" })).status).toBe("expired");
    const next = await service.requestApproval({ principal, toolId: "linear.issues.create", params,
      connectionId: binding.id, idempotencyKey: "expiring-next" });
    expect(next.id).not.toBe(first.id);
    expect((await service.approvalStatus(principal, first.id)).status).toBe("expired");
    approvals.approvals.get(next.id)!.manifestHash = "stale-manifest";
    const current = await service.requestApproval({ principal, toolId: "linear.issues.create", params,
      connectionId: binding.id, idempotencyKey: "manifest-next" });
    expect(current.id).not.toBe(next.id);
    expect((await service.approvalStatus(principal, next.id)).status).toBe("failed");
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

  it.each(["issues.create", "issues.update"] as const)(
    "keeps %s receipts uncertain for partial mutation data and transport failures", async (action) => {
      const { binding, receipts, linear, service, principal } = await executionFixture();
      const params = action === "issues.create"
        ? { linearWorkspaceId: workspaceA, teamId: teamA, title: "New" }
        : { linearWorkspaceId: workspaceA, issueId: issueA, title: "Updated" };

      for (const failure of ["partial", "partial-http", "null-data", "errors-only", "ambiguous"] as const) {
        linear.setFailure(failure);
        const distinctParams = { ...params, title: `${params.title}-${failure}` };
        const approval = await service.requestApproval({ principal, toolId: `linear.${action}`, params: distinctParams,
          connectionId: binding.id, idempotencyKey: `${action}-${failure}` });
        const before = linear.mutations().length;
        await service.approve(approval.id, "alice");
        expect(linear.mutations()).toHaveLength(before);
        await expect(service.executeApproved(principal, approval.id)).rejects.toMatchObject({
          code: failure === "errors-only" ? "LINEAR_RATE_LIMITED" : "EXECUTION_OUTCOME_UNKNOWN",
        });
        expect(linear.mutations()).toHaveLength(before + 1);
        expect([...receipts.receipts.values()].find((receipt) => receipt.approvalId === approval.id))
          .toMatchObject({ status: failure === "errors-only" ? "failed" : "uncertain" });
        await expect(service.executeApproved(principal, approval.id)).rejects.toBeDefined();
        expect(linear.mutations()).toHaveLength(before + 1);
        const repeated = await service.requestApproval({ principal, toolId: `linear.${action}`,
          params: distinctParams, connectionId: binding.id, idempotencyKey: `fresh-${action}-${failure}` });
        if (failure !== "errors-only") {
          expect(repeated.id).toBe(approval.id);
          await expect(service.executeApproved(principal, repeated.id)).rejects.toBeDefined();
        } else {
          expect(repeated.id).not.toBe(approval.id);
        }
        expect(linear.mutations()).toHaveLength(before + 1);
      }
    });

  it("returns a read-appropriate error for unknown GraphQL query failures", async () => {
    const linear = linearFixture();
    linear.setReadFailure(400);
    const readError = await omrLinearProvider.actions["issues.get"]!.execute({
      linearWorkspaceId: workspaceA, issueId: issueA,
    }, linear.context).catch((error: unknown) => error);
    expect(readError).toMatchObject({ code: "LINEAR_QUERY_REJECTED", phase: "read" });
    const router = createOMRRouter(undefined, undefined, undefined, {
      execute: async () => { throw new LinearExecutionError("receipt_read", readError as LinearProviderDenial); },
    } as unknown as ExecutionRouteServices);
    const response = await router.handle(new Request("https://omr.example/api/tools/execute", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "omr_A", toolId: "linear.issues.get", params: {} }),
    }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "LINEAR_QUERY_REJECTED", receiptId: "receipt_read" });
    expect(response.headers.get("cache-control")).toBe("no-store");

    linear.setReadFailure(422);
    await expect(omrLinearProvider.actions["issues.create"]!.execute({
      linearWorkspaceId: workspaceA, teamId: teamA, title: "New",
    }, linear.context)).rejects.toMatchObject({ code: "LINEAR_QUERY_REJECTED", phase: "preflight" });
    expect(linear.mutations()).toHaveLength(0);
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

  it.each(["RATELIMITED", "AUTHENTICATION_ERROR", "FORBIDDEN"])(
    "finds a later %s GraphQL denial without treating partial write data as a denial", (code) => {
      const failure = { status: 400, headers: { "Retry-After": "29" }, data: {
        errors: [{ message: "generic" }, { extensions: { code } }],
      } };
      const expected = { RATELIMITED: "LINEAR_RATE_LIMITED",
        AUTHENTICATION_ERROR: "LINEAR_RECONNECT_REQUIRED", FORBIDDEN: "LINEAR_PERMISSION_DENIED" }[code];
      expect(linearDenial(failure, "read")).toMatchObject({ code: expected });
      expect(linearDenial(failure, "write")).toMatchObject({ code: expected });
      expect(linearDenial({ ...failure, data: { ...failure.data, data: null } }, "write")).toBeNull();
      if (code === "RATELIMITED") expect(linearDenial(failure, "read")?.retryAfterSeconds).toBe(29);
    });

  it("classifies read and preflight transport outages without attempting a mutation", async () => {
    const linear = linearFixture();
    linear.post.mockRejectedValueOnce(Object.assign(new Error("private upstream"), { status: 503 }));
    await expect(omrLinearProvider.actions["workspace.get"]!.execute({}, linear.context))
      .rejects.toMatchObject({ code: "LINEAR_QUERY_REJECTED", phase: "read" });
    linear.post.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(omrLinearProvider.actions["issues.create"]!.execute({
      linearWorkspaceId: workspaceA, teamId: teamA, title: "New",
    }, linear.context)).rejects.toMatchObject({ code: "LINEAR_QUERY_REJECTED", phase: "preflight" });
    expect(linear.mutations()).toHaveLength(0);
  });

  it("preserves GraphQL response timing in a public read rate limit", async () => {
    const linear = linearFixture();
    linear.post.mockResolvedValueOnce({
      headers: { "Retry-After": "17", "X-RateLimit-Requests-Reset": "1800000000000" },
      data: { errors: [{ extensions: { code: "RATELIMITED" } }] },
    });
    const denial = await omrLinearProvider.actions["workspace.get"]!.execute({}, linear.context)
      .catch((error: unknown) => error) as LinearProviderDenial;
    expect(denial).toMatchObject({ code: "LINEAR_RATE_LIMITED", retryAfterSeconds: 17,
      rateLimitResetAt: 1800000000000 });
    const router = createOMRRouter(undefined, undefined, undefined, {
      execute: async () => { throw new LinearExecutionError("receipt_rate", denial); },
    } as unknown as ExecutionRouteServices);
    const response = await router.handle(new Request("https://omr.example/api/tools/execute", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "omr_A", toolId: "linear.workspace.get", params: {} }),
    }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(response.headers.get("x-ratelimit-requests-reset")).toBe("1800000000000");
  });

  it("preserves a missing connection through read and write preflight", async () => {
    const linear = linearFixture();
    const missing = Object.assign(new Error("missing connection"), { code: "CONNECTION_NOT_FOUND" });
    linear.post.mockRejectedValueOnce(missing);
    await expect(omrLinearProvider.actions["workspace.get"]!.execute({}, linear.context))
      .rejects.toMatchObject({ code: "CONNECTION_NOT_FOUND" });
    linear.post.mockRejectedValueOnce(missing);
    await expect(omrLinearProvider.actions["issues.create"]!.execute({
      linearWorkspaceId: workspaceA, teamId: teamA, title: "No mutation",
    }, linear.context)).rejects.toMatchObject({ code: "CONNECTION_NOT_FOUND" });
    expect(linear.mutations()).toHaveLength(0);
  });

  it("validates a reconciliation decision at the HTTP protocol boundary", async () => {
    const reconcileUncertain = vi.fn(async () => ({ id: "approval_one", status: "failed",
      reconciledAs: "effect_absent" }));
    const router = createOMRRouter(undefined, undefined, undefined, {
      reconcileUncertain,
    } as unknown as ExecutionRouteServices);
    const request = (decision: string) => new Request("https://omr.example/api/approvals/reconcile", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalId: "approval_one", decision }),
    });
    const rejected = await router.handle(request("retry"));
    expect(rejected.status).toBe(400);
    expect(reconcileUncertain).not.toHaveBeenCalled();
    const accepted = await router.handle(request("effect_absent"));
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
    expect(reconcileUncertain).toHaveBeenCalledWith(expect.any(Request), "approval_one", "effect_absent", undefined);
  });

  it("projects unavailable intent reservation to HTTP and the shared client", async () => {
    const requestApproval = vi.fn(async () => { throw new LinearIntentTransactionRequiredError(); });
    const router = createOMRRouter(undefined, undefined, undefined, {
      requestApproval,
    } as unknown as ExecutionRouteServices);
    const client = new OMRClient({ baseUrl: "https://omr.example", credential: "test",
      fetchImpl: (input, init) => router.handle(new Request(input, init)) });
    await expect(client.requestApproval({ workspaceId: workspaceA, toolId: "linear.issues.create",
      params: { title: "No dispatch" }, idempotencyKey: "reservation-1" })).rejects.toMatchObject({
      status: 503, body: { error: "LINEAR_INTENT_TRANSACTION_REQUIRED" },
    });
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });
});
