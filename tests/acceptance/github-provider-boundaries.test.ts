import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryAdapter, plugFn } from "plugfn";
import { omrGithubProvider, verifiedGithubScopes } from "@oh-my-router/plugfn-runtime";
import { createPlugFnToolCatalog } from "@oh-my-router/tools";
import { WorkspaceAuthority } from "@oh-my-router/identity";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";
import { ConnectionAuthority, PlugFnConnectionOrchestrator } from "@oh-my-router/connections";
import { MemoryConnectionBindingStore } from "@oh-my-router/connections/testing";
import { ExecutionService } from "@oh-my-router/execution";
import { MemoryExecutionApprovalStore, MemoryExecutionReceiptStore } from "@oh-my-router/execution/testing";
import { createOMRRouter, type ExecutionRouteServices } from "../../apps/web/src/lib/server/router.js";

afterEach(() => vi.unstubAllGlobals());

const failures = [
  ["expired token", 401, {}, "Bad credentials", 401, "GITHUB_RECONNECT_REQUIRED"],
  ["primary limit", 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" },
    "API rate limit exceeded", 429, "GITHUB_RATE_LIMITED"],
  ["secondary limit", 403, { "retry-after": "45" },
    "secondary rate limit exceeded", 429, "GITHUB_RATE_LIMITED"],
  ["long retry limit", 429, { "retry-after": "120", "x-ratelimit-reset": "1800000000" },
    "API rate limit exceeded", 429, "GITHUB_RATE_LIMITED"],
] as const;

async function fixture(failurePoint: "scope" | "preflight" | "comment" | "transport" | "server" | "read", status: number,
  headers: Record<string, string>, message: string) {
  let activeFailurePoint: typeof failurePoint = failurePoint;
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "sandbox-token", token_type: "bearer",
        scope: "read:user,public_repo" });
    }
    calls.push(url);
    if (url === "https://api.github.com/user") {
      return activeFailurePoint === "scope"
        ? Response.json({ message, secret: "provider-private-data" }, { status, headers: new Headers(headers) })
        : Response.json({ id: 7, login: "alice", html_url: "https://github.com/alice" },
          { headers: { "X-OAuth-Scopes": "read:user, public_repo" } });
    }
    if (url === "https://api.github.com/repos/org/public") {
      if (activeFailurePoint === "read") {
        return Response.json({ message, secret: "provider-private-data" }, { status, headers: new Headers(headers) });
      }
      return activeFailurePoint === "preflight"
        ? Response.json({ message, secret: "provider-private-data" }, { status, headers: new Headers(headers) })
        : Response.json({ id: 1, private: false });
    }
    if (url === "https://api.github.com/repos/org/public/issues/1/comments") {
      expect(init?.method).toBe("POST");
      if (activeFailurePoint === "transport") throw new TypeError("private transport error");
      return Response.json({ message, secret: "provider-private-data" }, { status, headers: new Headers(headers) });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  }));
  const database = new MemoryAdapter();
  const runtime = plugFn({
    database, auth: { getUserId: async () => null },
    baseUrl: "https://omr.local",
    encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    integrations: { github: { type: "oauth2", clientId: "sandbox-client", clientSecret: "sandbox-secret",
      redirectUris: ["https://omr.local/app/oauth/callback"] } },
    retry: { enabled: true }, cache: { enabled: false }, rateLimit: { enabled: false },
  }).use(omrGithubProvider);
  await runtime.ready;
  const workspaceStore = new MemoryWorkspaceStore();
  const { workspace } = await new WorkspaceAuthority(workspaceStore)
    .provisionPersonalWorkspace({ userId: "alice" });
  const bindingStore = new MemoryConnectionBindingStore(workspaceStore);
  const connections = new ConnectionAuthority(bindingStore);
  const orchestrator = new PlugFnConnectionOrchestrator(connections, runtime);
  const redirectUri = "https://omr.local/app/oauth/callback";
  const { authUrl } = await orchestrator.startOAuth({ actorUserId: "alice", workspaceId: workspace.id,
    provider: "github", ownership: "personal", redirectUri, label: "Alice", githubAccess: "public_write" });
  const binding = await orchestrator.completeOAuth({ actorUserId: "alice", workspaceId: workspace.id, provider: "github",
    ownership: "personal", code: "fixture-code", state: new URL(authUrl).searchParams.get("state")!,
    redirectUri, label: "Alice" });
  const receipts = new MemoryExecutionReceiptStore(() => true);
  const approvals = new MemoryExecutionApprovalStore(() => true, receipts);
  let deleteBeforeDispatch = false;
  const dispatch = { action: async (...args: Parameters<typeof runtime.action>) => {
    if (deleteBeforeDispatch && args[1] !== "account.get") {
      await database.deleteConnection(binding.connection.providerConnectionId);
      deleteBeforeDispatch = false;
    }
    return runtime.action(...args);
  } };
  const service = new ExecutionService(await createPlugFnToolCatalog(runtime), connections, dispatch, receipts,
    (connectionId, _binding, principal) => verifiedGithubScopes(runtime, {
      connectionId, userId: principal.userId, workspaceId: principal.workspaceId,
    }), Date.now, approvals, undefined, new Uint8Array(32).fill(7));
  const principal = { kind: "web" as const, userId: "alice", workspaceId: workspace.id };
  const execution = {
    execute: (_request: Request, input: { toolId: string; params: unknown }) => service.execute({
      principal, toolId: input.toolId, params: input.params,
    }),
    executeApproved: (_request: Request, approvalId: string) => service.executeApproved(principal, approvalId),
  } as ExecutionRouteServices;
  const router = createOMRRouter(undefined, undefined, undefined, execution);
  const post = (path: string, body: object) => router.handle(new Request(`https://omr.invalid${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  return { calls, receipts, approvals, service, principal, workspace, binding, bindingStore, workspaceStore, post,
    removeRemote: () => database.deleteConnection(binding.connection.providerConnectionId),
    removeBeforeDispatch() { deleteBeforeDispatch = true; },
    setFailurePoint(value: typeof failurePoint) { activeFailurePoint = value; } };
}

describe("GitHub provider error boundaries through OAuth, PlugFn, execution and HTTP", () => {
  it.each([
    ["long 429", 429, { "retry-after": "120", "x-ratelimit-reset": "1800000000" }, "API rate limit exceeded"],
    ["primary 403", 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" }, "API rate limit exceeded"],
    ["secondary 403", 403, { "retry-after": "45" }, "secondary rate limit exceeded"],
  ] as const)("settles %s repository read without long retries or leaking provider text", async (
    _case, status, headers, message,
  ) => {
    const { calls, receipts, workspace, post } = await fixture("read", status, headers, message);
    const started = Date.now();
    const response = await post("/api/tools/execute", { workspaceId: workspace.id,
      toolId: "github.repos.get", params: { owner: "org", repo: "public" } });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(calls.filter((url) => url === "https://api.github.com/repos/org/public")).toHaveLength(1);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("retry-after" in headers ? headers["retry-after"] : null);
    expect(response.headers.get("x-ratelimit-reset")).toBe(
      "x-ratelimit-reset" in headers ? headers["x-ratelimit-reset"] : null);
    const body = await response.json() as { error: string; receiptId: string; message: string };
    expect(body).toMatchObject({ error: "GITHUB_RATE_LIMITED", receiptId: expect.any(String),
      message: expect.stringContaining("Retry after") });
    expect(JSON.stringify(body)).not.toContain("provider-private-data");
    expect(receipts.receipts.get(body.receiptId)).toMatchObject({ status: "failed",
      workspaceId: workspace.id, errorCode: "github_read_denied" });
  });

  it.each(["read", "approval"] as const)("marks a deleted selected PlugFn connection unavailable during %s scope proof", async (operation) => {
    const { calls, receipts, approvals, service, principal, workspace, binding, bindingStore,
      removeRemote, post } = await fixture("read", 404, {}, "Not Found");
    await removeRemote();
    if (operation === "read") {
      const response = await post("/api/tools/execute", { workspaceId: workspace.id,
        toolId: "github.repos.get", params: { owner: "org", repo: "public" } });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "CONNECTION_UNAVAILABLE" });
    } else {
      await expect(service.requestApproval({ principal, toolId: "github.issues.commentPublic",
        params: { owner: "org", repo: "public", issueNumber: 1, body: "Hello" },
        idempotencyKey: "deleted-at-approval" })).rejects.toMatchObject({ code: "CONNECTION_UNAVAILABLE" });
    }
    expect(bindingStore.connections.get(binding.connection.id)).toMatchObject({
      status: "needs_reauth", readiness: "unavailable", healthReason: "plugfn_connection_missing" });
    expect(receipts.receipts.size).toBe(0);
    expect(approvals.approvals.size).toBe(0);
    expect(calls.filter((url) => url.includes("/repos/") || url.endsWith("/comments"))).toHaveLength(0);
  });

  it.each(["read", "approved comment"] as const)("settles a missing remote connection after %s scope proof without a provider write", async (operation) => {
    const { calls, receipts, approvals, service, principal, workspace, binding, bindingStore,
      removeBeforeDispatch, post } = await fixture("read", 404, {}, "Not Found");
    let approvalId: string | undefined;
    if (operation === "approved comment") {
      const approval = await service.requestApproval({ principal, toolId: "github.issues.commentPublic",
        params: { owner: "org", repo: "public", issueNumber: 1, body: "Hello" },
        idempotencyKey: "deleted-before-dispatch" });
      approvalId = approval.id;
      await service.approve(approval.id, principal.userId);
    }
    removeBeforeDispatch();
    const response = operation === "read"
      ? await post("/api/tools/execute", { workspaceId: workspace.id, toolId: "github.repos.get",
        params: { owner: "org", repo: "public" } })
      : await post("/api/approvals/execute", { approvalId });
    expect(response.status).toBe(operation === "read" ? 409 : 502);
    expect(await response.json()).toMatchObject({ error: operation === "read"
      ? "CONNECTION_UNAVAILABLE" : "EXECUTION_OUTCOME_UNKNOWN" });
    expect(bindingStore.connections.get(binding.connection.id)).toMatchObject({
      status: "needs_reauth", readiness: "unavailable", healthReason: "plugfn_connection_missing" });
    expect([...receipts.receipts.values()]).toEqual([expect.objectContaining({
      status: operation === "read" ? "failed" : "uncertain",
      errorCode: operation === "read" ? "connection_unavailable" : "provider_outcome_unknown",
      workspaceId: workspace.id,
      connectionId: binding.connection.id })]);
    if (approvalId) {
      expect(approvals.approvals.get(approvalId)).toMatchObject({ status: "uncertain" });
      await expect(service.executeApproved(principal, approvalId)).rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN" });
    }
    expect(calls.filter((url) => url.includes("/repos/") || url.endsWith("/comments"))).toHaveLength(0);
  });

  it.each(failures)("returns safe %s scope proof errors before a receipt or approval", async (
    _name, status, headers, message, httpStatus, code,
  ) => {
    const { calls, receipts, approvals, service, principal, workspace, post, setFailurePoint } =
      await fixture("read", status, headers, message);
    setFailurePoint("scope");
    const started = Date.now();
    const response = await post("/api/tools/execute", { workspaceId: workspace.id,
      toolId: "github.repos.get", params: { owner: "org", repo: "public" } });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(response.status).toBe(httpStatus);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("retry-after" in headers ? headers["retry-after"] : null);
    expect(response.headers.get("x-ratelimit-reset")).toBe(
      "x-ratelimit-reset" in headers ? headers["x-ratelimit-reset"] : null);
    const body = await response.json() as { error: string; message: string; receiptId?: string };
    expect(body.error).toBe(code);
    expect(body.receiptId).toBeUndefined();
    expect(body.message).toContain(code === "GITHUB_RECONNECT_REQUIRED" ? "Reconnect" : "Retry after");
    expect(JSON.stringify(body)).not.toContain("provider-private-data");
    await expect(service.requestApproval({ principal, toolId: "github.issues.commentPublic",
      params: { owner: "org", repo: "public", issueNumber: 1, body: "Hello" },
      idempotencyKey: "scope-denied" })).rejects.toMatchObject({ code,
        message: expect.stringContaining(code === "GITHUB_RECONNECT_REQUIRED" ? "Reconnect" : "Retry after") });
    expect(calls).toEqual(["https://api.github.com/user", "https://api.github.com/user"]);
    expect(receipts.receipts.size).toBe(0);
    expect(approvals.approvals.size).toBe(0);
  });

  it.each(failures)("settles definite %s comment preflight without POST", async (
    _name, status, headers, message, httpStatus, code,
  ) => {
    const { calls, receipts, approvals, service, principal, post } =
      await fixture("preflight", status, headers, message);
    const approval = await service.requestApproval({ principal, toolId: "github.issues.commentPublic",
      params: { owner: "org", repo: "public", issueNumber: 1, body: "Hello" },
      idempotencyKey: `preflight-${status}-${_name}`.replaceAll(" ", "-") });
    await service.approve(approval.id, principal.userId);
    const started = Date.now();
    const response = await post("/api/approvals/execute", { approvalId: approval.id });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(response.status).toBe(httpStatus);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("retry-after" in headers ? headers["retry-after"] : null);
    expect(response.headers.get("x-ratelimit-reset")).toBe(
      "x-ratelimit-reset" in headers ? headers["x-ratelimit-reset"] : null);
    const body = await response.json() as { error: string; receiptId: string };
    expect(body).toMatchObject({ error: code, receiptId: expect.any(String) });
    expect(JSON.stringify(body)).not.toContain("provider-private-data");
    expect(calls.filter((url) => url.includes("/comments"))).toHaveLength(0);
    expect(receipts.receipts.get(body.receiptId)).toMatchObject({ status: "failed" });
    expect(approvals.approvals.get(approval.id)).toMatchObject({ status: "failed" });
  });

  it.each([failures[0], failures[3]])("fails an approved comment on later %s scope proof without a receipt", async (
    _name, status, headers, message, httpStatus, code,
  ) => {
    const { calls, receipts, approvals, service, principal, post, setFailurePoint } =
      await fixture("preflight", status, headers, message);
    const approval = await service.requestApproval({ principal, toolId: "github.issues.commentPublic",
      params: { owner: "org", repo: "public", issueNumber: 1, body: "Hello" },
      idempotencyKey: `late-scope-${status}` });
    await service.approve(approval.id, principal.userId);
    setFailurePoint("scope");
    const response = await post("/api/approvals/execute", { approvalId: approval.id });
    expect(response.status).toBe(httpStatus);
    expect(response.headers.get("retry-after")).toBe("retry-after" in headers ? headers["retry-after"] : null);
    const body = await response.json() as { error: string; receiptId?: string };
    expect(body.error).toBe(code);
    expect(body.receiptId).toBeUndefined();
    expect(calls.filter((url) => url.includes("/repos/") || url.includes("/comments"))).toHaveLength(0);
    expect(receipts.receipts.size).toBe(0);
    expect(approvals.approvals.get(approval.id)).toMatchObject({ status: "failed" });
  });

  it.each([
    ...failures,
    ["repository becomes private after public preflight", 404, {}, "Not Found", 404, "GITHUB_REPOSITORY_UNAVAILABLE"],
    ["scope denied", 403, {}, "Resource not accessible", 403, "GITHUB_ACCESS_DENIED"],
    ["issue gone after public preflight", 410, {}, "provider-private-data", 410, "GITHUB_COMMENT_UNAVAILABLE"],
    ["invalid or spam comment", 422, {}, "provider-private-data", 422, "GITHUB_COMMENT_REJECTED"],
  ] as const)("settles definite %s comment POST rejection without replaying the write", async (
    _name, status, headers, message, httpStatus, code,
  ) => {
    const { calls, receipts, approvals, service, principal, workspace, binding, workspaceStore, post } =
      await fixture("comment", status, headers, message);
    const other = await new WorkspaceAuthority(workspaceStore)
      .createTeam({ ownerUserId: "alice", name: "Other" });
    await expect(service.requestApproval({ principal: { ...principal, workspaceId: other.workspace.id },
      toolId: "github.issues.commentPublic", connectionId: binding.connection.id,
      params: { owner: "org", repo: "public", issueNumber: 1, body: "Hello" },
      idempotencyKey: "wrong-workspace" })).rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    const approval = await service.requestApproval({ principal, toolId: "github.issues.commentPublic",
      connectionId: binding.connection.id, params: { owner: "org", repo: "public", issueNumber: 1, body: "Hello" },
      idempotencyKey: `post-${status}-${_name}`.replaceAll(" ", "-") });
    expect(calls.filter((url) => url.endsWith("/comments"))).toHaveLength(0);
    await service.approve(approval.id, principal.userId);
    const response = await post("/api/approvals/execute", { approvalId: approval.id });
    expect(response.status).toBe(httpStatus);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("retry-after" in headers ? headers["retry-after"] : null);
    expect(response.headers.get("x-ratelimit-reset")).toBe(
      "x-ratelimit-reset" in headers ? headers["x-ratelimit-reset"] : null);
    const body = await response.json() as { error: string; receiptId: string; message: string };
    expect(body).toMatchObject({ error: code, receiptId: expect.any(String) });
    expect(JSON.stringify(body)).not.toContain("provider-private-data");
    if (status === 410) expect(body.message).toContain("gone");
    if (status === 422) expect(body.message).toContain("invalid or spam");
    expect(calls.filter((url) => url.endsWith("/comments"))).toHaveLength(1);
    expect(receipts.receipts.get(body.receiptId)).toMatchObject({ status: "failed", workspaceId: workspace.id,
      connectionId: binding.connection.id, errorCode: "github_write_rejected" });
    expect(approvals.approvals.get(approval.id)).toMatchObject({ status: "failed", workspaceId: workspace.id });
    await expect(service.executeApproved(principal, approval.id)).rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    expect(calls.filter((url) => url.endsWith("/comments"))).toHaveLength(1);
  });

  it.each(["transport", "server"] as const)("keeps an ambiguous %s comment POST uncertain and fences replay", async (failurePoint) => {
    const { calls, receipts, approvals, service, principal, post } =
      await fixture(failurePoint, 500, {}, "provider-private-data");
    const approval = await service.requestApproval({ principal, toolId: "github.issues.commentPublic",
      params: { owner: "org", repo: "public", issueNumber: 1, body: "Hello" },
      idempotencyKey: "transport-post" });
    await service.approve(approval.id, principal.userId);
    const response = await post("/api/approvals/execute", { approvalId: approval.id });
    expect(response.status).toBe(502);
    const body = await response.json() as { error: string; receiptId: string };
    expect(body).toMatchObject({ error: "EXECUTION_OUTCOME_UNKNOWN", receiptId: expect.any(String) });
    expect(receipts.receipts.get(body.receiptId)).toMatchObject({ status: "uncertain" });
    expect(approvals.approvals.get(approval.id)).toMatchObject({ status: "uncertain" });
    await expect(service.executeApproved(principal, approval.id)).rejects.toMatchObject({
      code: "EXECUTION_OUTCOME_UNKNOWN", receiptId: body.receiptId });
    expect(calls.filter((url) => url.endsWith("/comments"))).toHaveLength(1);
  });
});
