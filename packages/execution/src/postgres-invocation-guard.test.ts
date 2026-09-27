import type { Client } from "pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresExecutionInvocationGuard } from "./postgres-invocation-guard.js";

const connection = {
  id: "binding_1", workspaceId: "workspace_1", providerConnectionId: "remote_1",
  provider: "linear", ownership: "workspace" as const, ownerUserId: null,
  installedBy: "user_1", label: "Linear", status: "active" as const,
  readiness: "ready" as const, healthReason: null, lastCheckedAt: null,
  revokedAt: null, createdAt: 1, updatedAt: 1,
};
const principal = {
  kind: "client" as const, userId: "user_1", workspaceId: "workspace_1",
  clientId: "client_1", grantId: "grant_1", capabilities: ["tools:write" as const],
};

describe("PostgreSQL invocation transaction contract", () => {
  it("holds binding, membership, client and grant row locks through the provider call", async () => {
    const timeline: string[] = [];
    const query = vi.fn(async (sql: string) => {
      timeline.push(sql);
      if (sql.includes("connection_bindings")) return { rows: [{ workspace_id: "workspace_1",
        provider_connection_id: "remote_1", ownership: "workspace", owner_user_id: null,
        status: "active", readiness: "ready" }] };
      if (sql.includes("workspace_memberships")) return { rows: [{ id: "member_1" }] };
      if (sql.includes("client_grants")) return { rows: [{ client_id: "client_1", workspace_id: "workspace_1",
        user_id: "user_1", capabilities: ["tools:write"], revoked_at: null,
        expires_at: String(Date.now() + 60_000) }] };
      if (sql.includes("omr_control.clients")) return { rows: [{ workspace_id: "workspace_1", revoked_at: null }] };
      return { rows: [] };
    });
    const guard = new PostgresExecutionInvocationGuard({ query } as unknown as Client);
    const invoke = vi.fn(async () => { timeline.push("PROVIDER_ACTION"); return "ok"; });
    await expect(guard.run({ principal, connection, capability: "tools:write" }, invoke))
      .resolves.toBe("ok");
    expect(timeline[0]).toBe("BEGIN");
    expect(timeline[1]).toContain("idle_in_transaction_session_timeout");
    expect(timeline.slice(2, 6).every((sql) => sql.includes("FOR SHARE"))).toBe(true);
    expect(timeline.slice(-2)).toEqual(["PROVIDER_ACTION", "COMMIT"]);
  });

  it.each(["revoked", "expired"] as const)("rolls back before a provider call for a %s grant", async (state) => {
    const queries: string[] = [];
    const query = vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("connection_bindings")) return { rows: [{ workspace_id: "workspace_1",
        provider_connection_id: "remote_1", ownership: "workspace", owner_user_id: null,
        status: "active", readiness: "ready" }] };
      if (sql.includes("workspace_memberships")) return { rows: [{ id: "member_1" }] };
      if (sql.includes("client_grants")) return { rows: [{ client_id: "client_1", workspace_id: "workspace_1",
        user_id: "user_1", capabilities: ["tools:write"], revoked_at: state === "revoked" ? "1" : null,
        expires_at: String(Date.now() + (state === "expired" ? -1 : 60_000)) }] };
      if (sql.includes("omr_control.clients")) return { rows: [{ workspace_id: "workspace_1", revoked_at: null }] };
      return { rows: [] };
    });
    const guard = new PostgresExecutionInvocationGuard({ query } as unknown as Client);
    const invoke = vi.fn(async () => "effect");
    await expect(guard.run({ principal, connection, capability: "tools:write" }, invoke))
      .rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    expect(invoke).not.toHaveBeenCalled();
    expect(queries.at(-1)).toBe("ROLLBACK");
  });

  it("denies a revoked web session after membership is checked", async () => {
    const queries: string[] = [];
    const query = vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("connection_bindings")) return { rows: [{ workspace_id: "workspace_1",
        provider_connection_id: "remote_1", ownership: "workspace", owner_user_id: null,
        status: "active", readiness: "ready" }] };
      if (sql.includes("workspace_memberships")) return { rows: [{ id: "member_1" }] };
      if (sql.includes("omr_identity.sessions")) return { rows: [] };
      return { rows: [] };
    });
    const guard = new PostgresExecutionInvocationGuard({ query } as unknown as Client);
    const invoke = vi.fn(async () => "effect");
    await expect(guard.run({ principal: { kind: "web", userId: "user_1",
      workspaceId: "workspace_1", sessionId: "session_revoked" },
      connection, capability: "tools:write" }, invoke))
      .rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    expect(queries.some((sql) => sql.includes("omr_identity.sessions") && sql.includes("FOR SHARE"))).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    expect(queries.at(-1)).toBe("ROLLBACK");
  });

  it("denies a web approval when membership was revoked before the transaction", async () => {
    const queries: string[] = [];
    const query = vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("connection_bindings")) return { rows: [{ workspace_id: "workspace_1",
        provider_connection_id: "remote_1", ownership: "workspace", owner_user_id: null,
        status: "active", readiness: "ready" }] };
      return { rows: [] };
    });
    const guard = new PostgresExecutionInvocationGuard({ query } as unknown as Client);
    const invoke = vi.fn(async () => "effect");
    await expect(guard.run({ principal: { kind: "web", userId: "user_1",
      workspaceId: "workspace_1", sessionId: "session_1" },
      connection, capability: "tools:write" }, invoke))
      .rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    expect(queries.some((sql) => sql.includes("workspace_memberships") && sql.includes("FOR SHARE"))).toBe(true);
    expect(queries.some((sql) => sql.includes("omr_identity.sessions"))).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(queries.at(-1)).toBe("ROLLBACK");
  });

  it("releases revocation locks after a hung provider reaches the invocation deadline", async () => {
    const timeline: string[] = [];
    const query = vi.fn(async (sql: string) => {
      timeline.push(sql);
      if (sql.includes("connection_bindings")) return { rows: [{ workspace_id: "workspace_1",
        provider_connection_id: "remote_1", ownership: "workspace", owner_user_id: null,
        status: "active", readiness: "ready" }] };
      if (sql.includes("workspace_memberships")) return { rows: [{ id: "member_1" }] };
      if (sql.includes("client_grants")) return { rows: [{ client_id: "client_1", workspace_id: "workspace_1",
        user_id: "user_1", capabilities: ["tools:write"], revoked_at: null,
        expires_at: String(Date.now() + 60_000) }] };
      if (sql.includes("omr_control.clients")) return { rows: [{ workspace_id: "workspace_1", revoked_at: null }] };
      return { rows: [] };
    });
    const guard = new PostgresExecutionInvocationGuard({ query } as unknown as Client, 10);
    const invoke = vi.fn(() => new Promise<string>(() => undefined));
    await expect(guard.run({ principal, connection, capability: "tools:write" }, invoke))
      .rejects.toMatchObject({ code: "EXECUTION_INVOCATION_TIMEOUT" });
    expect(invoke).toHaveBeenCalledOnce();
    expect(timeline.at(-1)).toBe("ROLLBACK");
    expect(timeline).not.toContain("COMMIT");
    expect(query.mock.calls[1]?.[0]).toContain("idle_in_transaction_session_timeout");
  });
});
