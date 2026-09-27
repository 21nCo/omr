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

function authorizedQuery(timeline: string[], options: {
  grantState?: "revoked" | "expired";
  member?: boolean;
  session?: boolean;
} = {}) {
  return vi.fn(async (sql: string) => {
    timeline.push(sql);
    if (sql.includes("connection_bindings")) return { rows: [{ workspace_id: "workspace_1",
      provider_connection_id: "remote_1", ownership: "workspace", owner_user_id: null,
      status: "active", readiness: "ready" }] };
    if (sql.includes("workspace_memberships")) return { rows: options.member === false ? [] : [{ id: "member_1" }] };
    if (sql.includes("omr_identity.sessions")) return { rows: options.session ? [{
      id: "session_1", expires_at: new Date(Date.now() + 60_000),
    }] : [] };
    if (sql.includes("client_grants")) return { rows: [{ client_id: "client_1", workspace_id: "workspace_1",
      user_id: "user_1", capabilities: ["tools:write"],
      revoked_at: options.grantState === "revoked" ? "1" : null,
      expires_at: String(Date.now() + (options.grantState === "expired" ? -1 : 60_000)) }] };
    if (sql.includes("omr_control.clients")) return { rows: [{ workspace_id: "workspace_1", revoked_at: null }] };
    return { rows: [] };
  });
}

describe("PostgreSQL invocation transaction contract", () => {
  it("rechecks membership and grant before reporting an uncertain receipt without binding health", async () => {
    for (const grantState of [undefined, "revoked"] as const) {
      const timeline: string[] = [];
      const query = authorizedQuery(timeline, { grantState });
      const guard = new PostgresExecutionInvocationGuard({ query } as unknown as Client);
      const report = vi.fn(async () => "receipt_1");
      const result = guard.runIdentity({ principal, capability: "tools:write",
        deadlineAt: Date.now() + 1_000 }, report);
      if (grantState === "revoked") {
        await expect(result).rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
        expect(report).not.toHaveBeenCalled();
      } else {
        await expect(result).resolves.toBe("receipt_1");
        expect(report).toHaveBeenCalledOnce();
      }
      expect(timeline.some((sql) => sql.includes("connection_bindings"))).toBe(false);
      expect(timeline.some((sql) => sql.includes("workspace_memberships") && sql.includes("FOR SHARE"))).toBe(true);
      expect(timeline.some((sql) => sql.includes("client_grants") && sql.includes("FOR SHARE"))).toBe(true);
    }
  });

  it.each([
    ["membership", { member: false }, principal],
    ["web session", { session: false }, { kind: "web" as const, userId: "user_1",
      workspaceId: "workspace_1", sessionId: "session_revoked" }],
  ])("denies uncertain receipt identity after %s revocation", async (_name, options, actor) => {
    const queries: string[] = [];
    const query = authorizedQuery(queries, options);
    const guard = new PostgresExecutionInvocationGuard({ query } as unknown as Client);
    const report = vi.fn(async () => "receipt_1");
    await expect(guard.runIdentity({ principal: actor, capability: "tools:write",
      deadlineAt: Date.now() + 1_000 }, report))
      .rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    expect(report).not.toHaveBeenCalled();
    expect(queries.at(-1)).toBe("ROLLBACK");
  });

  it("holds binding, membership, client and grant row locks through the provider call", async () => {
    const timeline: string[] = [];
    const query = authorizedQuery(timeline);
    const guard = new PostgresExecutionInvocationGuard({ query } as unknown as Client);
    const invoke = vi.fn(async () => { timeline.push("PROVIDER_ACTION"); return "ok"; });
    await expect(guard.run({ principal, connection, capability: "tools:write" }, invoke))
      .resolves.toBe("ok");
    expect(timeline[0]).toBe("BEGIN");
    expect(timeline[1]).toContain("idle_in_transaction_session_timeout");
    expect(timeline.filter((sql) => sql.includes("FOR SHARE"))).toHaveLength(4);
    expect(timeline.at(-1)).toBe("COMMIT");
    expect(timeline.indexOf("PROVIDER_ACTION")).toBeLessThan(timeline.indexOf("COMMIT"));
  });

  it.each(["revoked", "expired"] as const)("rolls back before a provider call for a %s grant", async (state) => {
    const queries: string[] = [];
    const query = authorizedQuery(queries, { grantState: state });
    const guard = new PostgresExecutionInvocationGuard({ query } as unknown as Client);
    const invoke = vi.fn(async () => "effect");
    await expect(guard.run({ principal, connection, capability: "tools:write" }, invoke))
      .rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    expect(invoke).not.toHaveBeenCalled();
    expect(queries.at(-1)).toBe("ROLLBACK");
  });

  it("denies a revoked web session after membership is checked", async () => {
    const queries: string[] = [];
    const query = authorizedQuery(queries);
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

  it("dispatches for a current web session after checking its row lock", async () => {
    const queries: string[] = [];
    const query = authorizedQuery(queries, { session: true });
    const guard = new PostgresExecutionInvocationGuard({ query } as unknown as Client);
    const invoke = vi.fn(async () => "effect");
    await expect(guard.run({ principal: { kind: "web", userId: "user_1",
      workspaceId: "workspace_1", sessionId: "session_1" },
      connection, capability: "tools:write" }, invoke)).resolves.toBe("effect");
    expect(queries.some((sql) => sql.includes("omr_identity.sessions") && sql.includes("FOR SHARE"))).toBe(true);
    expect(invoke).toHaveBeenCalledOnce();
    expect(queries.at(-1)).toBe("COMMIT");
  });

  it("denies a web approval when membership was revoked before the transaction", async () => {
    const queries: string[] = [];
    const query = authorizedQuery(queries, { member: false });
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
    const query = authorizedQuery(timeline);
    const end = vi.fn(async () => { timeline.push("DISCONNECT"); });
    const guard = new PostgresExecutionInvocationGuard({ query, end } as unknown as Client, 100);
    const invoke = vi.fn(() => new Promise<string>(() => undefined));
    await expect(guard.run({ principal, connection, capability: "tools:write" }, invoke))
      .rejects.toMatchObject({ code: "EXECUTION_INVOCATION_TIMEOUT" });
    expect(invoke).toHaveBeenCalledOnce();
    expect(timeline.at(-1)).toBe("DISCONNECT");
    expect(end).toHaveBeenCalledOnce();
    expect(timeline).not.toContain("COMMIT");
    expect(query.mock.calls[1]?.[0]).toContain("idle_in_transaction_session_timeout");
  });

  it("cancels pre-dispatch work that completes after rollback", async () => {
    const timeline: string[] = [];
    const query = authorizedQuery(timeline);
    let release!: () => void;
    let entered!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const provider = vi.fn();
    const end = vi.fn(async () => { timeline.push("DISCONNECT"); });
    const guard = new PostgresExecutionInvocationGuard({ query, end } as unknown as Client, 100);
    const pending = guard.run({ principal, connection, capability: "tools:write" }, async (assertCanDispatch) => {
      entered();
      await hold; // Hashing or receipt reservation has not yet dispatched the provider.
      assertCanDispatch();
      provider();
      return "ok";
    });
    await started;
    await expect(pending).rejects.toMatchObject({ code: "EXECUTION_INVOCATION_TIMEOUT" });
    expect(timeline.at(-1)).toBe("DISCONNECT");
    expect(end).toHaveBeenCalledOnce();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([
    ["web read", { kind: "web" as const, userId: "user_1", workspaceId: "workspace_1",
      sessionId: "session_1" }, "tools:read" as const],
    ["client effect", principal, "tools:write" as const],
  ])("disconnects a queued %s authorization query at the invocation deadline", async (_name, actor, capability) => {
    const timeline: string[] = [];
    let releaseQuery!: () => void;
    const heldQuery = new Promise<void>((resolve) => { releaseQuery = resolve; });
    let queue = Promise.resolve();
    const query = vi.fn((sql: string, values?: unknown[]) => {
      const result = queue.then(async () => {
        timeline.push(sql);
        if (sql.includes("connection_bindings")) {
          await new Promise((resolve) => setTimeout(resolve, 85));
          return { rows: [{ workspace_id: "workspace_1", provider_connection_id: "remote_1",
            ownership: "workspace", owner_user_id: null, status: "active", readiness: "ready" }] };
        }
        if (sql.includes("workspace_memberships")) {
          await heldQuery; // A lock wait occupying the one-client PostgreSQL queue.
          return { rows: [{ id: "member_1" }] };
        }
        if (sql.includes("set_config('statement_timeout'")) {
          timeline.push(`TIMEOUT ${String(values?.[0])}`);
        }
        return { rows: [] };
      });
      queue = result.then(() => undefined, () => undefined);
      return result;
    });
    const end = vi.fn(async () => { timeline.push("DISCONNECT"); releaseQuery(); });
    const guard = new PostgresExecutionInvocationGuard({ query, end } as unknown as Client, 130);
    const invoke = vi.fn(async () => "provider effect");
    const started = Date.now();
    await expect(guard.run({ principal: actor, connection, capability }, invoke))
      .rejects.toMatchObject({ code: "EXECUTION_INVOCATION_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(250);
    expect(end).toHaveBeenCalledOnce();
    expect(timeline).not.toContain("ROLLBACK");
    expect(invoke).not.toHaveBeenCalled();
    const timeouts = timeline.filter((entry) => entry.startsWith("TIMEOUT "));
    expect(timeouts.some((entry) => Number.parseInt(entry.slice(8), 10) < 60)).toBe(true);
  });

  it("bounds a stalled rollback after an authorization denial", async () => {
    const timeline: string[] = [];
    let releaseRollback!: () => void;
    const heldRollback = new Promise<void>((resolve) => { releaseRollback = resolve; });
    const query = vi.fn(async (sql: string) => {
      timeline.push(sql);
      if (sql.includes("connection_bindings")) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { rows: [] }; // Denied before dispatch, with little time left for cleanup.
      }
      if (sql === "ROLLBACK") await heldRollback;
      return { rows: [] };
    });
    const end = vi.fn(async () => { timeline.push("DISCONNECT"); releaseRollback(); });
    const guard = new PostgresExecutionInvocationGuard({ query, end } as unknown as Client, 100);
    const invoke = vi.fn(async () => "provider effect");
    const started = Date.now();
    await expect(guard.run({ principal, connection, capability: "tools:write" }, invoke))
      .rejects.toMatchObject({ code: "CONNECTION_ACCESS_DENIED" });
    expect(Date.now() - started).toBeLessThan(200);
    expect(timeline).toContain("ROLLBACK");
    expect(end).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports a server statement timeout as a predispatch invocation timeout", async () => {
    const queries: string[] = [];
    const query = vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("connection_bindings")) {
        throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
      }
      return { rows: [] };
    });
    const guard = new PostgresExecutionInvocationGuard({ query } as unknown as Client);
    const invoke = vi.fn(async () => "provider effect");
    await expect(guard.run({ principal, connection, capability: "tools:write" }, invoke))
      .rejects.toMatchObject({ code: "EXECUTION_INVOCATION_TIMEOUT" });
    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(invoke).not.toHaveBeenCalled();
  });
});
