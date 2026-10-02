import { describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import type { ExecutionApproval } from "./execution.js";
import { MemoryExecutionApprovalStore, MemoryExecutionReceiptStore } from "./testing.js";
import { PostgresExecutionApprovalStore } from "./postgres-approval-store.js";

const approval = (id: string, key = id): ExecutionApproval => ({
  id, workspaceId: "workspace-A", actorUserId: "actor-A", principalKey: "web:actor-A",
  toolId: "linear.issues.create", manifestHash: "manifest-A", connectionId: "connection-A",
  providerConnectionId: "linear-A", params: { title: "Issue" }, idempotencyKey: key,
  requestHash: "hash-A", intentHash: "intent-A", status: "pending", approvedBy: null,
  decidedAt: null, expiresAt: 10_000, executionReceiptId: null, createdAt: 1, updatedAt: 1,
});

describe("Linear approval reservation boundaries", () => {
  it("rejects missing intent fingerprints before either store changes state", async () => {
    const receipts = new MemoryExecutionReceiptStore(() => true);
    const memory = new MemoryExecutionApprovalStore(() => true, receipts);
    await expect(memory.create({ ...approval("approval-A"), requestHash: undefined }))
      .rejects.toMatchObject({ code: "EXECUTION_IDEMPOTENCY_CONFLICT" });
    expect(memory.approvals.size).toBe(0);
    const query = vi.fn();
    const postgres = new PostgresExecutionApprovalStore({ query } as unknown as Client,
      new Uint8Array(32));
    await expect(postgres.create({ ...approval("approval-A"), requestHash: undefined }))
      .rejects.toMatchObject({ code: "EXECUTION_IDEMPOTENCY_CONFLICT" });
    expect(query).not.toHaveBeenCalled();
  });

  it("fails closed when a memory alias loses its target", async () => {
    const memory = new MemoryExecutionApprovalStore(() => true,
      new MemoryExecutionReceiptStore(() => true));
    await memory.create(approval("approval-A", "key-A"));
    await memory.create(approval("approval-B", "key-B"));
    memory.approvals.delete("approval-A");
    await expect(memory.create(approval("approval-C", "key-B")))
      .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
  });

  it("rejects a nontransactional Postgres intent before querying", async () => {
    const query = vi.fn();
    const postgres = new PostgresExecutionApprovalStore({ query } as unknown as Client,
      new Uint8Array(32));
    await expect(postgres.create(approval("approval-D")))
      .rejects.toMatchObject({ code: "LINEAR_INTENT_TRANSACTION_REQUIRED" });
    expect(query).not.toHaveBeenCalled();
  });
});
