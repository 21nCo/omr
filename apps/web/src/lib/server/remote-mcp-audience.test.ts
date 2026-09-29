import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  kind: "mcp_remote" as "mcp_remote" | "cli",
  authenticate: vi.fn(async (_credential: string, _capability?: string) => ({
    kind: "mcp_remote" as "mcp_remote" | "cli", userId: "user_one",
    workspaceId: "workspace_one", clientId: "client_one", grantId: "grant_one",
    capabilities: ["tools:discover", "tools:read", "tools:write", "approvals:create"],
  })),
  revokeGrant: vi.fn(async () => undefined),
}));

vi.mock("@oh-my-router/client-access/postgres", () => ({
  connectPostgresClientAccess: async () => ({
    clients: { authenticate: fixture.authenticate, revokeGrant: fixture.revokeGrant },
    close: async () => undefined,
  }),
}));

import { createCloudflareRouteServices, createRemoteMcpRouteServices } from "./cloudflare-runtime.js";
import { createOMRRouter } from "./router.js";

const origin = "https://omr.example";
const bearer = "Bearer omr_" + "a".repeat(64);
function event() {
  return { request: new Request(`${origin}/api/tools`), platform: {
    env: { DATABASE_URL: "postgres://fixture" },
  } } as never;
}

function router(internal: boolean) {
  const services = internal ? createRemoteMcpRouteServices(event()) : createCloudflareRouteServices(event());
  return createOMRRouter(services.device, services.connections, services.tools,
    services.execution, services.controlPlane);
}

function request(path: string, body?: Record<string, unknown>) {
  return new Request(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: bearer, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe("remote MCP credential audience", () => {
  it("rejects a remote host grant on direct public catalog, execution, approval, and grant routes", async () => {
    const publicRouter = router(false);
    const calls = [
      request("/api/tools?workspaceId=workspace_one"),
      request("/api/tools/execute", { workspaceId: "workspace_one", toolId: "fixture.read", params: {} }),
      request("/api/approvals", { workspaceId: "workspace_one", toolId: "fixture.write", params: {}, idempotencyKey: "one" }),
      request("/api/approvals/execute", { approvalId: "approval_one" }),
      request("/api/approvals/status?approvalId=approval_one"),
      request("/api/client-grants/revoke-self", {}),
    ];
    for (const call of calls) {
      const response = await publicRouter.handle(call);
      expect(response.status, new URL(call.url).pathname).toBe(403);
      expect(await response.json()).toEqual({ error: "CLIENT_ACCESS_DENIED" });
    }
    expect(fixture.revokeGrant).not.toHaveBeenCalled();
  });

  it("keeps the internal MCP adapter's validated grant usable and does not exclude CLI grants from public API", async () => {
    const internal = router(true);
    const selfRevoke = await internal.handle(request("/api/client-grants/revoke-self", {}));
    expect(selfRevoke.status).toBe(200);
    expect(fixture.revokeGrant).toHaveBeenCalledWith("user_one", "grant_one");
    fixture.authenticate.mockImplementationOnce(async () => ({
      kind: "cli", userId: "user_one", workspaceId: "workspace_one",
      clientId: "client_cli", grantId: "grant_cli",
      capabilities: ["tools:discover", "tools:read", "tools:write", "approvals:create"],
    }));
    const cli = await router(false).handle(request("/api/client-grants/revoke-self", {}));
    expect(cli.status).toBe(200);
    expect(fixture.revokeGrant).toHaveBeenCalledWith("user_one", "grant_cli");
  });
});
