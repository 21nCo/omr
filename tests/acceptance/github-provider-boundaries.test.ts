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

async function fixture(failurePoint: "scope" | "preflight", status: number,
  headers: Record<string, string>, message: string) {
  let activeFailurePoint: "scope" | "preflight" = failurePoint;
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
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
      return Response.json({ message, secret: "provider-private-data" }, { status, headers: new Headers(headers) });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  }));
  const runtime = plugFn({
    database: new MemoryAdapter(), auth: { getUserId: async () => null },
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
  const connections = new ConnectionAuthority(new MemoryConnectionBindingStore(workspaceStore));
  const orchestrator = new PlugFnConnectionOrchestrator(connections, runtime);
  const redirectUri = "https://omr.local/app/oauth/callback";
  const { authUrl } = await orchestrator.startOAuth({ actorUserId: "alice", workspaceId: workspace.id,
    provider: "github", ownership: "personal", redirectUri, label: "Alice", githubAccess: "public_write" });
  await orchestrator.completeOAuth({ actorUserId: "alice", workspaceId: workspace.id, provider: "github",
    ownership: "personal", code: "fixture-code", state: new URL(authUrl).searchParams.get("state")!,
    redirectUri, label: "Alice" });
  const receipts = new MemoryExecutionReceiptStore(() => true);
  const approvals = new MemoryExecutionApprovalStore(() => true, receipts);
  const service = new ExecutionService(await createPlugFnToolCatalog(runtime), connections, runtime, receipts,
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
  return { calls, receipts, approvals, service, principal, workspace, post,
    setFailurePoint(value: "scope" | "preflight") { activeFailurePoint = value; } };
}

describe("GitHub provider error boundaries through OAuth, PlugFn, execution and HTTP", () => {
  it.each(failures)("returns safe %s scope proof errors before a receipt or approval", async (
    _name, status, headers, message, httpStatus, code,
  ) => {
    const { calls, receipts, approvals, service, principal, workspace, post } =
      await fixture("scope", status, headers, message);
    const started = Date.now();
    const response = await post("/api/tools/execute", { workspaceId: workspace.id,
      toolId: "github.repos.get", params: { owner: "org", repo: "public" } });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(response.status).toBe(httpStatus);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("retry-after" in headers ? headers["retry-after"] : null);
    expect(response.headers.get("x-ratelimit-reset")).toBe(
      "x-ratelimit-reset" in headers ? headers["x-ratelimit-reset"] : null);
    const body = await response.json() as { error: string; receiptId?: string };
    expect(body.error).toBe(code);
    expect(body.receiptId).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("provider-private-data");
    await expect(service.requestApproval({ principal, toolId: "github.issues.commentPublic",
      params: { owner: "org", repo: "public", issueNumber: 1, body: "Hello" },
      idempotencyKey: "scope-denied" })).rejects.toMatchObject({ code });
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
});
