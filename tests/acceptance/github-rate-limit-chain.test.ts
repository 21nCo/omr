import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryAdapter, plugFn } from "plugfn";
import { omrGithubProvider, verifiedGithubScopes } from "@oh-my-router/plugfn-runtime";
import { createPlugFnToolCatalog } from "@oh-my-router/tools";
import { WorkspaceAuthority } from "@oh-my-router/identity";
import { MemoryWorkspaceStore } from "@oh-my-router/identity/testing";
import { ConnectionAuthority, PlugFnConnectionOrchestrator } from "@oh-my-router/connections";
import { MemoryConnectionBindingStore } from "@oh-my-router/connections/testing";
import { ExecutionService } from "@oh-my-router/execution";
import { MemoryExecutionReceiptStore } from "@oh-my-router/execution/testing";
import { createOMRRouter, type ExecutionRouteServices } from "../../apps/web/src/lib/server/router.js";

afterEach(() => vi.unstubAllGlobals());

describe("GitHub read rate limits through PlugFn and HTTP", () => {
  it.each([
    ["long 429", 429, { "retry-after": "120", "x-ratelimit-reset": "1800000000" }, "API rate limit exceeded"],
    ["primary 403", 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" }, "API rate limit exceeded"],
    ["secondary 403", 403, { "retry-after": "45" }, "secondary rate limit exceeded"],
  ] as const)("settles %s before the invocation deadline with safe HTTP guidance", async (
    _case, status, headers, message,
  ) => {
    const providerCalls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: "sandbox-token", token_type: "bearer", scope: "read:user" });
      }
      if (url === "https://api.github.com/user") {
        return Response.json({ id: 7, login: "alice", html_url: "https://github.com/alice" },
          { headers: { "X-OAuth-Scopes": "read:user" } });
      }
      if (url === "https://api.github.com/repos/org/public") {
        providerCalls.push(url);
        return Response.json({ message, secret: "provider-private-data" }, { status, headers });
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
      provider: "github", ownership: "personal", redirectUri, label: "Alice" });
    await orchestrator.completeOAuth({ actorUserId: "alice", workspaceId: workspace.id, provider: "github",
      ownership: "personal", code: "fixture-code", state: new URL(authUrl).searchParams.get("state")!,
      redirectUri, label: "Alice" });

    const receipts = new MemoryExecutionReceiptStore(() => true);
    const service = new ExecutionService(await createPlugFnToolCatalog(runtime), connections, runtime, receipts,
      (connectionId, _binding, principal) => verifiedGithubScopes(runtime, {
        connectionId, userId: principal.userId, workspaceId: principal.workspaceId,
      }), Date.now, undefined, undefined, new Uint8Array(32).fill(7));
    const execution = { execute: (_request: Request, input: { workspaceId: string; toolId: string; params: unknown }) =>
      service.execute({ principal: { kind: "web", userId: "alice", workspaceId: input.workspaceId },
        toolId: input.toolId, params: input.params }) } as ExecutionRouteServices;
    const started = Date.now();
    const response = await createOMRRouter(undefined, undefined, undefined, execution).handle(new Request(
      "https://omr.invalid/api/tools/execute", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace.id, toolId: "github.repos.get",
          params: { owner: "org", repo: "public" } }) },
    ));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(providerCalls).toHaveLength(1);
    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("retry-after" in headers ? headers["retry-after"] : null);
    expect(response.headers.get("x-ratelimit-reset")).toBe(
      "x-ratelimit-reset" in headers ? headers["x-ratelimit-reset"] : null);
    const body = await response.json() as { error: string; receiptId: string; message: string };
    expect(body).toMatchObject({ error: "GITHUB_RATE_LIMITED", receiptId: expect.any(String),
      message: expect.stringContaining("Retry after") });
    expect(JSON.stringify(body)).not.toContain("provider-private-data");
    expect(receipts.receipts.get(body.receiptId)).toMatchObject({ status: "failed", workspaceId: workspace.id,
      errorCode: "github_read_denied" });
  });
});
