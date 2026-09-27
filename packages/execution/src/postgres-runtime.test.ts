import { describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({ clients: [] as Array<{ ended: boolean; queries: string[] }> }));

vi.mock("pg", () => {
  class Client {
    private readonly state = { ended: false, queries: [] as string[] };

    constructor() { mockState.clients.push(this.state); }
    on() { return this; }
    async connect() { return undefined; }
    async end() { this.state.ended = true; }
    async query(sql: string) {
      this.state.queries.push(sql);
      if (sql.includes("connection_bindings")) {
        if (mockState.clients[1] === this.state) {
          throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
        }
        return { rows: [{ workspace_id: "workspace_1", provider_connection_id: "remote_1",
          ownership: "workspace", owner_user_id: null, status: "active", readiness: "ready" }] };
      }
      if (sql.includes("workspace_memberships")) return { rows: [{ id: "member_1" }] };
      if (sql.includes("omr_identity.sessions")) return { rows: [{
        id: "session_1", expires_at: new Date(Date.now() + 60_000),
      }] };
      return { rows: [] };
    }
  }
  return { default: { Client } };
});

import { connectPostgresExecutionReceipts } from "./postgres.js";

describe("PostgreSQL execution runtime", () => {
  it("closes the primary client if store construction fails", async () => {
    mockState.clients.length = 0;
    await expect(connectPostgresExecutionReceipts({
      connectionString: "postgresql://localhost:5432/fixture",
      resultWrappingKey: new Uint8Array(3),
    })).rejects.toThrow(/32 bytes/);
    expect(mockState.clients).toHaveLength(1);
    expect(mockState.clients[0]?.ended).toBe(true);
  });

  it("owns a new guard client for the invocation after a timed-out authorization query", async () => {
    mockState.clients.length = 0;
    const runtime = await connectPostgresExecutionReceipts({
      connectionString: "postgresql://localhost:5432/fixture",
      resultWrappingKey: new Uint8Array(32).fill(1),
    });
    const input = { principal: { kind: "web" as const, userId: "user_1", workspaceId: "workspace_1",
      sessionId: "session_1" }, connection: { id: "binding_1", providerConnectionId: "remote_1" } as never,
    capability: "tools:read" as const };
    const invoke = vi.fn(async () => "ok");
    try {
      await expect(runtime.invocationGuard.run(input, invoke))
        .rejects.toMatchObject({ code: "EXECUTION_INVOCATION_TIMEOUT" });
      expect(invoke).not.toHaveBeenCalled();
      expect(mockState.clients[1]?.ended).toBe(true);
      await expect(runtime.invocationGuard.run(input, invoke)).resolves.toBe("ok");
      expect(invoke).toHaveBeenCalledOnce();
      expect(mockState.clients).toHaveLength(3);
      expect(mockState.clients[2]?.ended).toBe(true);
      expect(mockState.clients[0]?.ended).toBe(false);
    } finally {
      await runtime.close();
    }
    expect(mockState.clients[0]?.ended).toBe(true);
  });
});
