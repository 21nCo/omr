import { describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  clients: [] as Array<{ ended: boolean; queries: string[] }>,
  stallConnectAt: -1,
  stallClaimAt: -1,
  uncertainOnClaim: false,
  unavailableOnClaim: false,
  advanceClock: () => undefined,
}));

vi.mock("pg", () => {
  class Client {
    private readonly state = { ended: false, queries: [] as string[] };

    constructor() { mockState.clients.push(this.state); }
    on() { return this; }
    async connect() {
      if (mockState.clients.indexOf(this.state) === mockState.stallConnectAt) {
        return new Promise<void>(() => undefined);
      }
      return undefined;
    }
    async end() { this.state.ended = true; }
    async query(sql: string) {
      this.state.queries.push(sql);
      if (mockState.uncertainOnClaim && sql.includes("status = 'uncertain'")) {
        mockState.advanceClock();
        return { rows: [{ execution_receipt_id: "execution_known_uncertain" }] };
      }
      if (mockState.unavailableOnClaim && sql.includes("SET status = CASE")) {
        mockState.advanceClock();
        return { rows: [] };
      }
      if (mockState.uncertainOnClaim && sql.includes("UPDATE omr_control.execution_approvals")) {
        return { rows: [] };
      }
      if (sql.includes("UPDATE omr_control.execution_approvals") &&
          mockState.clients.indexOf(this.state) === mockState.stallClaimAt) {
        return new Promise<{ rows: never[] }>(() => undefined);
      }
      if (sql.includes("connection_bindings")) {
        if (mockState.clients[1] === this.state) {
          throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
        }
        return { rows: [{ workspace_id: "workspace_1", provider_connection_id: "remote_1",
          ownership: "workspace", owner_user_id: null, status: "active", readiness: "ready" }] };
      }
      if (/^SELECT id FROM omr_control\.workspace_memberships\b/.test(sql.trimStart())) {
        return { rows: [{ id: "member_1" }] };
      }
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
    mockState.stallConnectAt = -1;
    mockState.stallClaimAt = -1;
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

  it("bounds a stalled guard connection before any provider call", async () => {
    mockState.clients.length = 0;
    mockState.stallConnectAt = 1;
    const runtime = await connectPostgresExecutionReceipts({
      connectionString: "postgresql://localhost:5432/fixture",
      resultWrappingKey: new Uint8Array(32).fill(1),
    });
    const invoke = vi.fn(async () => "effect");
    try {
      await expect(runtime.invocationGuard.run({ principal: { kind: "web", userId: "user_1",
        workspaceId: "workspace_1", sessionId: "session_1" },
        connection: { id: "binding_1", providerConnectionId: "remote_1" } as never,
        capability: "tools:read", deadlineAt: Date.now() + 40 }, invoke))
        .rejects.toMatchObject({ code: "EXECUTION_INVOCATION_TIMEOUT" });
      expect(invoke).not.toHaveBeenCalled();
      expect(mockState.clients[1]?.ended).toBe(true);
    } finally {
      mockState.stallConnectAt = -1;
      await runtime.close();
    }
  });

  it("bounds an approved claim waiting behind a revocation lock", async () => {
    mockState.clients.length = 0;
    mockState.stallClaimAt = 1;
    const runtime = await connectPostgresExecutionReceipts({
      connectionString: "postgresql://localhost:5432/fixture",
      resultWrappingKey: new Uint8Array(32).fill(1),
    });
    try {
      await expect(runtime.approvals.claim({ approvalId: "approval_1", actorUserId: "user_1",
        principalKey: "web:user_1", now: Date.now(), deadlineAt: Date.now() + 40 }))
        .rejects.toMatchObject({ code: "EXECUTION_INVOCATION_TIMEOUT" });
      expect(mockState.clients[1]?.ended).toBe(true);
      expect(mockState.clients[0]?.ended).toBe(false);
    } finally {
      mockState.stallClaimAt = -1;
      await runtime.close();
    }
  });

  it("preserves an established uncertain receipt after the claim deadline", async () => {
    mockState.clients.length = 0;
    mockState.uncertainOnClaim = true;
    const actualNow = Date.now.bind(Date);
    let offset = 0;
    mockState.advanceClock = () => { offset = 2_000; };
    vi.spyOn(Date, "now").mockImplementation(() => actualNow() + offset);
    const runtime = await connectPostgresExecutionReceipts({
      connectionString: "postgresql://localhost:5432/fixture",
      resultWrappingKey: new Uint8Array(32).fill(1),
    });
    try {
      await expect(runtime.approvals.claim({ approvalId: "approval_1", actorUserId: "user_1",
        principalKey: "web:user_1", now: Date.now(), deadlineAt: Date.now() + 1_000 }))
        .rejects.toMatchObject({ code: "EXECUTION_OUTCOME_UNKNOWN",
          receiptId: "execution_known_uncertain" });
      expect(mockState.clients[1]?.ended).toBe(true);
    } finally {
      mockState.uncertainOnClaim = false;
      mockState.advanceClock = () => undefined;
      vi.restoreAllMocks();
      await runtime.close();
    }
  });

  it("preserves an established unavailable approval after the claim deadline", async () => {
    mockState.clients.length = 0;
    mockState.unavailableOnClaim = true;
    const actualNow = Date.now.bind(Date);
    let offset = 0;
    mockState.advanceClock = () => { offset = 2_000; };
    vi.spyOn(Date, "now").mockImplementation(() => actualNow() + offset);
    const runtime = await connectPostgresExecutionReceipts({
      connectionString: "postgresql://localhost:5432/fixture",
      resultWrappingKey: new Uint8Array(32).fill(1),
    });
    try {
      await expect(runtime.approvals.claim({ approvalId: "approval_1", actorUserId: "user_1",
        principalKey: "web:user_1", now: Date.now(), deadlineAt: Date.now() + 1_000 }))
        .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
      expect(mockState.clients[1]?.ended).toBe(true);
    } finally {
      mockState.unavailableOnClaim = false;
      mockState.advanceClock = () => undefined;
      vi.restoreAllMocks();
      await runtime.close();
    }
  });

  it("closes every dedicated claim connection before concurrent claims settle", async () => {
    mockState.clients.length = 0;
    const runtime = await connectPostgresExecutionReceipts({
      connectionString: "postgresql://localhost:5432/fixture",
      resultWrappingKey: new Uint8Array(32).fill(1),
    });
    try {
      const results = await Promise.allSettled(Array.from({ length: 20 }, (_, index) =>
        runtime.approvals.claim({ approvalId: `approval_${index}`, actorUserId: "user_1",
          principalKey: "web:user_1", now: Date.now(), deadlineAt: Date.now() + 1_000 })));
      expect(results).toEqual(Array.from({ length: 20 }, () =>
        expect.objectContaining({ status: "rejected",
          reason: expect.objectContaining({ code: "APPROVAL_UNAVAILABLE" }) })));
      expect(mockState.clients).toHaveLength(21);
      expect(mockState.clients.slice(1).every((client) => client.ended)).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});
