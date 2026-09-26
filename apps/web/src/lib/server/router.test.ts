import { describe, expect, it } from "vitest";

import { ClientAccessDeniedError, DeviceAuthorizationError } from "@oh-my-router/client-access";
import { ConnectionProviderOperationError } from "@oh-my-router/connections";
import { ExecutionApprovalRequiredError } from "@oh-my-router/execution";

import {
  createOMRRouter,
  router,
  type ConnectionRouteServices,
  type ControlPlaneRouteServices,
  type DeviceRouteServices,
  type ExecutionRouteServices,
  type ToolRouteServices,
} from "./router.js";

describe("OMR Worker HTTP boundary", () => {
  it("serves a structured health response through the shared router", async () => {
    const response = await router.handle(new Request("https://omr.invalid/api/health"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "omr-web",
      runtime: "cloudflare-workers",
    });
  });

  it("fails closed for unknown routes", async () => {
    const response = await router.handle(new Request("https://omr.invalid/api/missing"));

    expect(response.status).toBe(404);
  });

  it("loads the control and DataFn PostgreSQL runtimes inside the Worker graph", async () => {
    const response = await router.handle(
      new Request("https://omr.invalid/api/runtime-capabilities"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      datafnSchemaVersion: 1,
      postgresClientAccessRuntime: true,
      postgresConnectionRuntime: true,
      postgresDataRuntime: true,
      postgresDeviceLoginRuntime: true,
      postgresIdentityRuntime: true,
    });
  });

  it("exposes structured device authorization, polling, and approval routes", async () => {
    const calls: string[] = [];
    const services: DeviceRouteServices = {
      async begin(input) {
        calls.push(`begin:${input.clientKind}:${input.clientName}`);
        return { deviceCode: "device", userCode: "ABCD-EFGH" };
      },
      async poll(deviceCode) {
        calls.push(`poll:${deviceCode}`);
        return { credential: "omr_credential" };
      },
      async approve(request, input) {
        calls.push(`approve:${request.headers.get("cookie")}:${input.workspaceId}`);
        return { client: { id: "client_1" }, grant: { id: "grant_1" } };
      },
    };
    const deviceRouter = createOMRRouter(services);

    const begin = await deviceRouter.handle(
      new Request("https://omr.invalid/api/device/authorization", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientKind: "cli",
          clientName: "Terminal",
          requestedCapabilities: ["tools:discover"],
        }),
      }),
    );
    const poll = await deviceRouter.handle(
      new Request("https://omr.invalid/api/device/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: "device" }),
      }),
    );
    const remote = await deviceRouter.handle(
      new Request("https://omr.invalid/api/device/authorization", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientKind: "mcp_remote",
          clientName: "Remote MCP",
          requestedCapabilities: ["tools:discover"],
        }),
      }),
    );
    const approve = await deviceRouter.handle(
      new Request("https://omr.invalid/api/device/approve", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "session=test" },
        body: JSON.stringify({ userCode: "ABCD-EFGH", workspaceId: "workspace_1" }),
      }),
    );

    expect(begin.status).toBe(201);
    expect(poll.status).toBe(200);
    expect(remote.status).toBe(201);
    expect(approve.status).toBe(200);
    expect(calls).toEqual([
      "begin:cli:Terminal",
      "poll:device",
      "begin:mcp_remote:Remote MCP",
      "approve:session=test:workspace_1",
    ]);
  });

  it("exposes an authenticated control-plane projection and team creation route", async () => {
    const calls: unknown[] = [];
    const controlPlane: ControlPlaneRouteServices = {
      async overview(_request, workspaceId) {
        calls.push({ operation: "overview", workspaceId });
        return { selectedWorkspaceId: workspaceId, workspaces: [] };
      },
      async createTeam(_request, name) {
        calls.push({ operation: "create-team", name });
        return { workspace: { id: "workspace_team", name } };
      },
      async listManualGrants(_request, cursor) {
        calls.push({ operation: "list-manual-grants", cursor });
        return { grants: [{ id: "grant_1", clientId: "client_1" }], nextCursor: null };
      },
      async revokeManualClient(_request, clientId) {
        calls.push({ operation: "revoke-manual-client", clientId });
        return { revoked: true };
      },
    };
    const controlRouter = createOMRRouter(
      undefined,
      undefined,
      undefined,
      undefined,
      controlPlane,
    );

    const overview = await controlRouter.handle(new Request(
      "https://omr.invalid/api/control-plane?workspaceId=workspace_1",
    ));
    const created = await controlRouter.handle(new Request(
      "https://omr.invalid/api/workspaces/team",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Runtime Team" }),
      },
    ));
    const grants = await controlRouter.handle(new Request(
      "https://omr.invalid/api/client-grants?cursor=123%3Agrant_1",
    ));
    const revoked = await controlRouter.handle(new Request(
      "https://omr.invalid/api/client-grants/revoke",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "client_1" }),
      },
    ));

    expect(overview.status).toBe(200);
    expect(overview.headers.get("cache-control")).toBe("no-store");
    expect(created.status).toBe(201);
    expect(grants.status).toBe(200);
    expect(grants.headers.get("cache-control")).toBe("no-store");
    expect(revoked.status).toBe(200);
    expect(calls).toEqual([
      { operation: "overview", workspaceId: "workspace_1" },
      { operation: "create-team", name: "Runtime Team" },
      { operation: "list-manual-grants", cursor: "123:grant_1" },
      { operation: "revoke-manual-client", clientId: "client_1" },
    ]);
  });

  it("does not turn unauthorized client revocation into an internal error", async () => {
    const services: ControlPlaneRouteServices = {
      async overview() { return {}; },
      async createTeam() { return {}; },
      async listManualGrants() { return { grants: [], nextCursor: null }; },
      async revokeManualClient() { throw new ClientAccessDeniedError(); },
    };
    const response = await createOMRRouter(
      undefined, undefined, undefined, undefined, services,
    ).handle(new Request("https://omr.invalid/api/client-grants/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "client_other" }),
    }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "CLIENT_ACCESS_DENIED" });
  });

  it("maps pending device polling and invalid request bodies to stable errors", async () => {
    const services: DeviceRouteServices = {
      async begin() {
        return {};
      },
      async poll() {
        throw new DeviceAuthorizationError("DEVICE_AUTHORIZATION_PENDING", {
          retryAfterMs: 5_000,
        });
      },
      async approve() {
        return {};
      },
    };
    const deviceRouter = createOMRRouter(services);
    const pending = await deviceRouter.handle(
      new Request("https://omr.invalid/api/device/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: "pending" }),
      }),
    );
    const invalid = await deviceRouter.handle(
      new Request("https://omr.invalid/api/device/authorization", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientKind: "headless" }),
      }),
    );

    expect(pending.status).toBe(400);
    await expect(pending.json()).resolves.toEqual({
      error: "DEVICE_AUTHORIZATION_PENDING",
      retryAfterMs: 5_000,
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: "REQUEST_INPUT_INVALID" });
  });

  it("exposes connection setup and lifecycle routes without logging API keys", async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const services: ConnectionRouteServices = {
      async providerReadiness(_request, provider, workspaceId) {
        calls.push({ operation: "readiness", input: { provider, workspaceId } });
        return { provider, available: true };
      },
      async list(_request, input) {
        calls.push({ operation: "list", input });
        return [];
      },
      async select(_request, input) {
        calls.push({ operation: "select", input });
        return { connectionId: input.connectionId };
      },
      async startOAuth(_request, input) {
        calls.push({ operation: "oauth-start", input });
        return { authUrl: "https://provider.example/oauth" };
      },
      async completeOAuth(_request, input) {
        calls.push({ operation: "oauth-callback", input });
        return { connection: { id: "connection_oauth" } };
      },
      async connectApiKey(_request, input) {
        calls.push({ operation: "api-key", input: { ...input, apiKey: "[redacted]" } });
        return { id: "connection_key" };
      },
      async checkHealth(_request, connectionId) {
        calls.push({ operation: "health", input: connectionId });
        return { status: "active" };
      },
      async refresh(_request, connectionId) {
        calls.push({ operation: "refresh", input: connectionId });
        return { status: "active" };
      },
      async disconnect(_request, connectionId) {
        calls.push({ operation: "disconnect", input: connectionId });
        return { status: "revoked" };
      },
    };
    const connectionRouter = createOMRRouter(undefined, services);
    const request = (path: string, body: Record<string, unknown>) => connectionRouter.handle(
      new Request(`https://omr.invalid${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

    const readiness = await connectionRouter.handle(
      new Request("https://omr.invalid/api/connections/providers/readiness?provider=linear&workspaceId=workspace_1"),
    );
    const apiKey = await request("/api/connections/api-key", {
      workspaceId: "workspace_1",
      provider: "linear",
      ownership: "workspace",
      apiKey: "lin_secret",
      label: "Team Linear",
    });
    const health = await request("/api/connections/health", { connectionId: "connection_key" });
    const selection = await request("/api/connections/select", {
      workspaceId: "workspace_1", provider: "linear", connectionId: "connection_key",
    });
    const invalidSelection = await request("/api/connections/select", {
      workspaceId: "workspace_1", provider: "linear",
    });
    const disconnect = await request("/api/connections/disconnect", {
      connectionId: "connection_key",
    });

    expect(readiness.status).toBe(200);
    expect(calls).toContainEqual({
      operation: "readiness", input: { provider: "linear", workspaceId: "workspace_1" },
    });
    expect(apiKey.status).toBe(201);
    expect(apiKey.headers.get("cache-control")).toBe("no-store");
    expect(health.status).toBe(200);
    expect(selection.status).toBe(200);
    expect(invalidSelection.status).toBe(400);
    expect(calls).toContainEqual({ operation: "select", input: {
      workspaceId: "workspace_1", provider: "linear", connectionId: "connection_key",
    } });
    expect(disconnect.status).toBe(200);
    expect(calls).toContainEqual({
      operation: "api-key",
      input: expect.objectContaining({ apiKey: "[redacted]" }),
    });
    expect(JSON.stringify(calls)).not.toContain("lin_secret");
  });

  it("returns a safe action for callback failure and keeps provider text out of the response", async () => {
    const services = {
      async completeOAuth() {
        throw new ConnectionProviderOperationError("oauth_callback");
      },
    } as unknown as ConnectionRouteServices;
    const response = await createOMRRouter(undefined, services).handle(new Request(
      "https://omr.invalid/api/connections/oauth/callback", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "workspace_1", provider: "github", ownership: "personal",
          code: "secret-code", state: "state", label: "GitHub" }),
      },
    ));
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "CONNECTION_PROVIDER_FAILED",
      operation: "oauth_callback", message: "Provider authorization failed. Start a new connection." });
  });

  it("projects versioned tool discovery and manifest routes", async () => {
    const calls: unknown[] = [];
    const tools: ToolRouteServices = {
      async discover(_request, input) {
        calls.push(input);
        return {
          catalogSchemaVersion: "1.0.0",
          revision: "sha256-revision",
          tools: [{ id: "linear.get_issue" }],
        };
      },
      async manifest(_request, toolId, workspaceId) {
        calls.push({ toolId, workspaceId });
        return toolId === "linear.get_issue" ? { id: toolId, hash: "sha256-tool" } : null;
      },
    };
    const toolRouter = createOMRRouter(undefined, undefined, tools);

    const discovery = await toolRouter.handle(new Request(
      "https://omr.invalid/api/tools?workspaceId=workspace_1&q=issue&provider=linear&effect=read&limit=20",
    ));
    const manifest = await toolRouter.handle(new Request(
      "https://omr.invalid/api/tools/manifest?id=linear.get_issue&workspaceId=workspace_1",
    ));
    const missing = await toolRouter.handle(new Request(
      "https://omr.invalid/api/tools/manifest?id=linear.missing&workspaceId=workspace_1",
    ));
    const noWorkspace = await toolRouter.handle(new Request("https://omr.invalid/api/tools"));

    expect(discovery.status).toBe(200);
    expect(manifest.status).toBe(200);
    expect(missing.status).toBe(404);
    expect(noWorkspace.status).toBe(400);
    expect(calls[0]).toEqual({
      workspaceId: "workspace_1",
      query: "issue",
      providers: ["linear"],
      effects: ["read"],
      limit: 20,
    });
    expect(calls[1]).toEqual({ toolId: "linear.get_issue", workspaceId: "workspace_1" });
  });

  it("uses one execution route for every client surface and exposes approval requirements", async () => {
    const execution: ExecutionRouteServices = {
      async execute(request, input) {
        if (input.toolId === "linear.create_issue") {
          throw new ExecutionApprovalRequiredError({
            id: input.toolId,
            hash: "sha256-write",
            contract: {
              version: "1.0.0",
              effect: "write",
              requiredScopes: [],
              resources: [],
              sensitiveKeys: [],
              pagination: { kind: "none" },
              retry: "never",
            },
          });
        }
        return { status: "succeeded", source: request.headers.get("x-client-surface"), input };
      },
      async requestApproval(_request, input) {
        return { id: "approval_1", status: "pending", input };
      },
      async approve(_request, approvalId) {
        return { id: approvalId, status: "approved" };
      },
      async reject(_request, approvalId) {
        return { id: approvalId, status: "rejected" };
      },
      async executeApproved(_request, approvalId) {
        return { id: "execution_approved", approvalId, status: "succeeded" };
      },
    };
    const executionRouter = createOMRRouter(undefined, undefined, undefined, execution);
    const execute = (toolId: string) => executionRouter.handle(new Request(
      "https://omr.invalid/api/tools/execute",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-client-surface": "mcp" },
        body: JSON.stringify({
          workspaceId: "workspace_alpha",
          toolId,
          params: { id: "issue_1" },
          idempotencyKey: "request-1",
        }),
      },
    ));

    const read = await execute("linear.get_issue");
    const write = await execute("linear.create_issue");
    const approval = await executionRouter.handle(new Request(
      "https://omr.invalid/api/approvals",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: "workspace_alpha",
          toolId: "linear.create_issue",
          params: { title: "Approved" },
        }),
      },
    ));
    const approved = await executionRouter.handle(new Request(
      "https://omr.invalid/api/approvals/approve",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalId: "approval_1" }),
      },
    ));
    const executed = await executionRouter.handle(new Request(
      "https://omr.invalid/api/approvals/execute",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalId: "approval_1" }),
      },
    ));
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({ source: "mcp", status: "succeeded" });
    expect(write.status).toBe(409);
    await expect(write.json()).resolves.toMatchObject({
      error: "EXECUTION_APPROVAL_REQUIRED",
      tool: { id: "linear.create_issue", contract: { effect: "write" } },
    });
    expect(approval.status).toBe(201);
    await expect(approved.json()).resolves.toMatchObject({ status: "approved" });
    await expect(executed.json()).resolves.toMatchObject({
      approvalId: "approval_1",
      status: "succeeded",
    });
  });
});
