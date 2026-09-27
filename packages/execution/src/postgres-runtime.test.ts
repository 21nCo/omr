import { describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  clients: [] as Array<{ connected: boolean; ended: boolean; queries: string[]; blocked: boolean }>,
  connectHoldMs: 0,
  endHoldMs: 0,
  peakConnections: 0,
  stallConnectAt: -1,
  stallClaimAt: -1,
  uncertainOnClaim: false,
  unavailableOnClaim: false,
  stallReceiptWrite: false,
  advanceClock: () => undefined,
}));

vi.mock("pg", () => {
  class Client {
    private readonly state = { connected: false, ended: false, queries: [] as string[], blocked: false };

    constructor() { mockState.clients.push(this.state); }
    on() { return this; }
    async connect() {
      if (mockState.connectHoldMs) await new Promise((resolve) => setTimeout(resolve, mockState.connectHoldMs));
      if (mockState.clients.indexOf(this.state) === mockState.stallConnectAt) {
        return new Promise<void>(() => undefined);
      }
      this.state.connected = true;
      mockState.peakConnections = Math.max(mockState.peakConnections,
        mockState.clients.filter((client) => client.connected && !client.ended).length);
      return undefined;
    }
    async end() {
      if (this.state.blocked && mockState.endHoldMs) {
        await new Promise((resolve) => setTimeout(resolve, mockState.endHoldMs));
      }
      this.state.ended = true;
    }
    async query(sql: string) {
      this.state.queries.push(sql);
      if (this.state.blocked || (mockState.stallReceiptWrite &&
          /UPDATE omr_control\.execution_receipts\s+SET status = 'uncertain'/.test(sql))) {
        this.state.blocked = true;
        mockState.stallReceiptWrite = false;
        return new Promise<{ rows: never[] }>(() => undefined);
      }
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
        if (mockState.clients[0] === this.state) {
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
  it("starts without an idle socket and bounds concurrent receipt query sockets", async () => {
    mockState.clients.length = 0;
    mockState.peakConnections = 0;
    mockState.connectHoldMs = 30;
    const runtime = await connectPostgresExecutionReceipts({
      connectionString: "postgresql://localhost:5432/fixture",
      resultWrappingKey: new Uint8Array(32).fill(1),
    });
    try {
      expect(mockState.clients.filter((client) => client.connected && !client.ended)).toHaveLength(0);
      const requests = Array.from({ length: 20 }, (_, index) =>
        runtime.receipts.findByIdempotency({ workspaceId: "workspace_1",
          principalKey: "web:user_1", idempotencyKey: `capacity-${index}`,
          deadlineAt: Date.now() + 2_000 }));
      await expect(Promise.all(requests)).resolves.toEqual(Array.from({ length: 20 }, () => null));
      expect(mockState.peakConnections).toBeLessThanOrEqual(8);
      expect(mockState.clients.every((client) => client.ended)).toBe(true);
    } finally {
      mockState.connectHoldMs = 0;
      await runtime.close();
    }
  });

  it("awaits active socket shutdown when the runtime closes", async () => {
    mockState.clients.length = 0;
    mockState.stallReceiptWrite = true;
    mockState.endHoldMs = 50;
    const runtime = await connectPostgresExecutionReceipts({
      connectionString: "postgresql://localhost:5432/fixture",
      resultWrappingKey: new Uint8Array(32).fill(1),
    });
    try {
      const pending = runtime.receipts.uncertain("receipt_1", "unknown", Date.now(),
        Date.now() + 2_000).catch((error: unknown) => error);
      await vi.waitFor(() => expect(mockState.clients.some((client) => client.blocked)).toBe(true));
      await runtime.close();
      expect(mockState.clients.every((client) => client.ended)).toBe(true);
      expect(await pending).toBeInstanceOf(Error);
    } finally {
      mockState.endHoldMs = 0;
      mockState.stallReceiptWrite = false;
    }
  });

  it("requires a caller deadline before opening an identity guard socket", async () => {
    mockState.clients.length = 0;
    const runtime = await connectPostgresExecutionReceipts({
      connectionString: "postgresql://localhost:5432/fixture",
      resultWrappingKey: new Uint8Array(32).fill(1),
    });
    try {
      await expect(runtime.invocationGuard.runIdentity!({ principal: { kind: "web",
        userId: "user_1", workspaceId: "workspace_1" }, capability: "tools:write" } as never,
      async () => "effect")).rejects.toMatchObject({ code: "EXECUTION_INVOCATION_TIMEOUT" });
      expect(mockState.clients).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it("expires a queued store query without opening a ninth socket", async () => {
    mockState.clients.length = 0;
    mockState.connectHoldMs = 80;
    const runtime = await connectPostgresExecutionReceipts({
      connectionString: "postgresql://localhost:5432/fixture",
      resultWrappingKey: new Uint8Array(32).fill(1),
    });
    try {
      const active = Array.from({ length: 8 }, (_, index) =>
        runtime.receipts.findByIdempotency({ workspaceId: "workspace_1",
          principalKey: "web:user_1", idempotencyKey: `active-${index}`,
          deadlineAt: Date.now() + 1_000 }));
      await expect(runtime.receipts.findByIdempotency({ workspaceId: "workspace_1",
        principalKey: "web:user_1", idempotencyKey: "queued",
        deadlineAt: Date.now() + 20 })).rejects.toMatchObject({ code: "EXECUTION_INVOCATION_TIMEOUT" });
      expect(mockState.clients).toHaveLength(8);
      await Promise.all(active);
      await expect(runtime.receipts.findByIdempotency({ workspaceId: "workspace_1",
        principalKey: "web:user_1", idempotencyKey: "next",
        deadlineAt: Date.now() + 1_000 })).resolves.toBeNull();
    } finally {
      mockState.connectHoldMs = 0;
      await runtime.close();
    }
  });

  it("fences a stalled receipt write so the next store call uses a free socket", async () => {
    mockState.clients.length = 0;
    mockState.stallReceiptWrite = true;
    const runtime = await connectPostgresExecutionReceipts({
      connectionString: "postgresql://localhost:5432/fixture",
      resultWrappingKey: new Uint8Array(32).fill(1),
    });
    try {
      await expect(runtime.receipts.uncertain("receipt_1", "unknown", Date.now(), Date.now() + 40))
        .rejects.toMatchObject({ code: "EXECUTION_INVOCATION_TIMEOUT" });
      await expect(runtime.receipts.findByIdempotency({ workspaceId: "workspace_1",
        principalKey: "web:user_1", idempotencyKey: "next", deadlineAt: Date.now() + 200 }))
        .resolves.toBeNull();
      expect(mockState.clients.filter((client) => client.blocked && !client.ended)).toHaveLength(0);
    } finally {
      mockState.stallReceiptWrite = false;
      await runtime.close();
    }
  });

  it("rejects a bad wrapping key without opening a socket", async () => {
    mockState.clients.length = 0;
    await expect(connectPostgresExecutionReceipts({
      connectionString: "postgresql://localhost:5432/fixture",
      resultWrappingKey: new Uint8Array(3),
    })).rejects.toThrow(/32 bytes/);
    expect(mockState.clients).toHaveLength(0);
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
      expect(mockState.clients[0]?.ended).toBe(true);
      await expect(runtime.invocationGuard.run(input, invoke)).resolves.toBe("ok");
      expect(invoke).toHaveBeenCalledOnce();
      expect(mockState.clients).toHaveLength(2);
      expect(mockState.clients[1]?.ended).toBe(true);
    } finally {
      await runtime.close();
    }
    expect(mockState.clients.every((client) => client.ended)).toBe(true);
  });

  it("bounds a stalled guard connection before any provider call", async () => {
    mockState.clients.length = 0;
    mockState.stallConnectAt = 0;
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
      expect(mockState.clients[0]?.ended).toBe(true);
    } finally {
      mockState.stallConnectAt = -1;
      await runtime.close();
    }
  });

  it("bounds an approved claim waiting behind a revocation lock", async () => {
    mockState.clients.length = 0;
    mockState.stallClaimAt = 0;
    const runtime = await connectPostgresExecutionReceipts({
      connectionString: "postgresql://localhost:5432/fixture",
      resultWrappingKey: new Uint8Array(32).fill(1),
    });
    try {
      await expect(runtime.approvals.claim({ approvalId: "approval_1", actorUserId: "user_1",
        principalKey: "web:user_1", now: Date.now(), deadlineAt: Date.now() + 40 }))
        .rejects.toMatchObject({ code: "EXECUTION_INVOCATION_TIMEOUT" });
      expect(mockState.clients[0]?.ended).toBe(true);
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
      expect(mockState.clients[0]?.ended).toBe(true);
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
      expect(mockState.clients[0]?.ended).toBe(true);
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
      expect(mockState.clients).toHaveLength(20);
      expect(mockState.clients.every((client) => client.ended)).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});
