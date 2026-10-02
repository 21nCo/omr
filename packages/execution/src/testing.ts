import type { JsonValue } from "@oh-my-router/tools";

import {
  ApprovalUnavailableError,
  EXECUTION_STALE_AFTER_MS,
  ExecutionIdempotencyConflictError,
  ExecutionInvocationDeadlineError,
  ExecutionOutcomeUnknownError,
  type ExecutionApproval,
  type ExecutionApprovalStore,
  type ExecutionReceipt,
  type ExecutionReceiptStore,
} from "./execution.js";

function key(receipt: ExecutionReceipt): string {
  return `${receipt.workspaceId}\u0000${receipt.principalKey}\u0000${receipt.idempotencyKey}`;
}

export class MemoryExecutionReceiptStore implements ExecutionReceiptStore {
  readonly receipts = new Map<string, ExecutionReceipt>();
  private readonly idempotency = new Map<string, string>();

  constructor(private readonly isMember: (workspaceId: string, actorUserId: string) => boolean) {}

  async findByIdempotency(input: { workspaceId: string; principalKey: string; idempotencyKey: string }): Promise<ExecutionReceipt | null> {
    const id = this.idempotency.get(`${input.workspaceId}\u0000${input.principalKey}\u0000${input.idempotencyKey}`);
    const receipt = id ? this.receipts.get(id) : undefined;
    return receipt && this.isMember(receipt.workspaceId, receipt.actorUserId)
      ? structuredClone(receipt) : null;
  }

  async reserve(receipt: ExecutionReceipt): Promise<{ receipt: ExecutionReceipt; created: boolean }> {
    const existingId = this.idempotency.get(key(receipt));
    if (existingId) {
      const existing = this.receipts.get(existingId)!;
      if (existing.approvalId !== receipt.approvalId ||
          existing.requestHash !== receipt.requestHash || existing.actorUserId !== receipt.actorUserId ||
          existing.toolId !== receipt.toolId || existing.manifestHash !== receipt.manifestHash ||
          existing.connectionId !== receipt.connectionId ||
          existing.providerConnectionId !== receipt.providerConnectionId) {
        return { receipt: structuredClone(existing), created: false };
      }
      if ((existing.status === "reserved" || existing.status === "running") &&
          existing.startedAt <= receipt.startedAt - EXECUTION_STALE_AFTER_MS) {
        existing.errorCode = existing.status === "reserved"
          ? "reservation_expired" : "invocation_outcome_unknown";
        existing.status = existing.status === "reserved" ? "failed" : "uncertain";
        existing.completedAt = receipt.startedAt;
        existing.updatedAt = existing.completedAt;
      }
      return { receipt: structuredClone(existing), created: false };
    }
    this.receipts.set(receipt.id, structuredClone(receipt));
    this.idempotency.set(key(receipt), receipt.id);
    return { receipt: structuredClone(receipt), created: true };
  }

  async beginDispatch(receiptId: string, now: number): Promise<void> {
    const receipt = this.required(receiptId);
    if (receipt.status !== "reserved") throw new Error("Execution reservation is unavailable");
    receipt.status = "running";
    receipt.updatedAt = now;
  }

  async succeed(receiptId: string, result: JsonValue, now: number): Promise<ExecutionReceipt> {
    const receipt = this.required(receiptId);
    if (receipt.status !== "running") throw new Error("Execution receipt is not running");
    receipt.status = "succeeded";
    receipt.result = structuredClone(result);
    receipt.completedAt = now;
    receipt.updatedAt = now;
    return structuredClone(receipt);
  }

  async fail(receiptId: string, errorCode: string, now: number): Promise<ExecutionReceipt> {
    const receipt = this.required(receiptId);
    if (receipt.status !== "reserved" && receipt.status !== "running") {
      throw new Error("Execution receipt is not active");
    }
    receipt.status = "failed";
    receipt.errorCode = errorCode;
    receipt.completedAt = now;
    receipt.updatedAt = now;
    return structuredClone(receipt);
  }

  async uncertain(receiptId: string, errorCode: string, now: number): Promise<ExecutionReceipt> {
    const receipt = this.required(receiptId);
    if (receipt.status !== "running") throw new Error("Execution receipt is not running");
    receipt.status = "uncertain";
    receipt.errorCode = errorCode;
    receipt.completedAt = now;
    receipt.updatedAt = now;
    return structuredClone(receipt);
  }

  async listForActor(input: {
    workspaceId: string;
    actorUserId: string;
    limit: number;
  }): Promise<ExecutionReceipt[]> {
    return [...this.receipts.values()]
      .filter((receipt) =>
        receipt.workspaceId === input.workspaceId && receipt.actorUserId === input.actorUserId
      )
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, input.limit)
      .map((receipt) => structuredClone(receipt));
  }

  private required(receiptId: string): ExecutionReceipt {
    const receipt = this.receipts.get(receiptId);
    if (!receipt) throw new Error(`Unknown execution receipt ${receiptId}`);
    return receipt;
  }
}

export class MemoryExecutionApprovalStore implements ExecutionApprovalStore {
  readonly approvals = new Map<string, ExecutionApproval>();
  private readonly idempotency = new Map<string, string>();
  private readonly aliases = new Map<string, { id: string; requestHash: string }>();

  constructor(private readonly isMember: (workspaceId: string, actorUserId: string) => boolean,
    private readonly receipts: MemoryExecutionReceiptStore) {}

  async create(approval: ExecutionApproval): Promise<ExecutionApproval> {
    if (approval.intentHash && !approval.requestHash) throw new ExecutionIdempotencyConflictError();
    this.expirePending(approval);
    const key = `${approval.workspaceId}\u0000${approval.principalKey}\u0000${approval.idempotencyKey}`;
    const alias = this.aliases.get(key);
    if (alias) {
      if (alias.requestHash !== approval.requestHash) throw new ExecutionIdempotencyConflictError();
      const target = this.approvals.get(alias.id);
      if (!target || target.workspaceId !== approval.workspaceId ||
          target.principalKey !== approval.principalKey) throw new ApprovalUnavailableError();
      return structuredClone(target);
    }
    const existingId = this.idempotency.get(key);
    if (existingId) {
      const existing = this.approvals.get(existingId)!;
      if (!existing.requestHash || !approval.requestHash || existing.requestHash !== approval.requestHash) {
        throw new ExecutionIdempotencyConflictError();
      }
      return structuredClone(existing);
    }
    if (approval.intentHash) {
      const live = this.liveIntent(approval);
      if (live) {
        this.aliases.set(key, { id: live.id, requestHash: approval.requestHash! });
        return structuredClone(live);
      }
    }
    if (this.approvals.has(approval.id)) throw new ApprovalUnavailableError();
    this.approvals.set(approval.id, structuredClone(approval));
    this.idempotency.set(key, approval.id);
    return structuredClone(approval);
  }

  private expirePending(approval: ExecutionApproval): void {
    for (const candidate of this.approvals.values()) {
      if (candidate.workspaceId !== approval.workspaceId || candidate.principalKey !== approval.principalKey ||
          (candidate.status !== "pending" && candidate.status !== "approved") ||
          candidate.expiresAt > approval.createdAt) continue;
      candidate.status = "expired";
      candidate.updatedAt = approval.createdAt;
    }
  }

  private liveIntent(approval: ExecutionApproval): ExecutionApproval | undefined {
    return [...this.approvals.values()].find((candidate) => {
      if (candidate.workspaceId !== approval.workspaceId || candidate.principalKey !== approval.principalKey ||
          candidate.intentHash !== approval.intentHash) return false;
      if ((candidate.status === "pending" || candidate.status === "approved") &&
          candidate.manifestHash !== approval.manifestHash) {
        candidate.status = "failed";
        candidate.updatedAt = approval.createdAt;
        return false;
      }
      return candidate.status === "pending" || candidate.status === "approved" ||
        candidate.status === "executing" || candidate.status === "uncertain";
    });
  }

  async getForActor(approvalId: string, actorUserId: string): Promise<ExecutionApproval> {
    const approval = this.approvals.get(approvalId);
    if (approval?.actorUserId !== actorUserId || !this.isMember(approval.workspaceId, actorUserId)) {
      throw new ApprovalUnavailableError();
    }
    return structuredClone(approval);
  }

  async approve(input: {
    approvalId: string;
    actorUserId: string;
    now: number;
  }): Promise<ExecutionApproval> {
    const approval = this.pendingForActor(input.approvalId, input.actorUserId, input.now);
    approval.status = "approved";
    approval.approvedBy = input.actorUserId;
    approval.decidedAt = input.now;
    approval.updatedAt = input.now;
    return structuredClone(approval);
  }

  async reject(input: {
    approvalId: string;
    actorUserId: string;
    now: number;
  }): Promise<ExecutionApproval> {
    const approval = this.pendingForActor(input.approvalId, input.actorUserId, input.now);
    approval.status = "rejected";
    approval.decidedAt = input.now;
    approval.updatedAt = input.now;
    return structuredClone(approval);
  }

  async claim(input: {
    approvalId: string;
    actorUserId: string;
    principalKey: string;
    now: number;
    deadlineAt: number;
  }): Promise<ExecutionApproval> {
    if (Date.now() >= input.deadlineAt) throw new ExecutionInvocationDeadlineError();
    const approval = this.approvals.get(input.approvalId);
    if (approval?.status === "uncertain" && approval.actorUserId === input.actorUserId &&
        approval.principalKey === input.principalKey && approval.executionReceiptId &&
        this.isMember(approval.workspaceId, input.actorUserId)) {
      const receipt = this.assertReceiptOwnership(approval, approval.executionReceiptId);
      if (!["running", "succeeded", "uncertain"].includes(receipt.status)) {
        throw new ApprovalUnavailableError();
      }
      throw new ExecutionOutcomeUnknownError(approval.executionReceiptId);
    }
    if (approval?.status === "executing" && approval.actorUserId === input.actorUserId &&
        approval.principalKey === input.principalKey &&
        approval.executionReceiptId === null &&
        this.isMember(approval.workspaceId, input.actorUserId) &&
        input.now - approval.updatedAt >= EXECUTION_STALE_AFTER_MS) {
      this.reconcileStaleExecutingClaim(approval, input.now);
    }
    if (
      !approval ||
      approval.status !== "approved" ||
      approval.actorUserId !== input.actorUserId ||
      approval.principalKey !== input.principalKey ||
      approval.expiresAt <= input.now ||
      !this.isMember(approval.workspaceId, input.actorUserId)
    ) {
      throw new ApprovalUnavailableError();
    }
    approval.status = "executing";
    approval.updatedAt = input.now;
    return structuredClone(approval);
  }

  private reconcileStaleExecutingClaim(approval: ExecutionApproval, now: number): never {
    const exactReceipt = [...this.receipts.receipts.values()].find((candidate) =>
      candidate.approvalId === approval.id &&
      candidate.workspaceId === approval.workspaceId &&
      candidate.actorUserId === approval.actorUserId &&
      candidate.principalKey === approval.principalKey &&
      candidate.toolId === approval.toolId &&
      candidate.manifestHash === approval.manifestHash &&
      candidate.connectionId === approval.connectionId &&
      candidate.providerConnectionId === approval.providerConnectionId &&
      candidate.idempotencyKey === approval.idempotencyKey);
    const effectReceipt = exactReceipt && ["running", "succeeded", "uncertain"].includes(exactReceipt.status)
      ? exactReceipt : undefined;
    if (exactReceipt?.status === "reserved") {
      exactReceipt.status = "failed";
      exactReceipt.errorCode = "reservation_expired";
      exactReceipt.completedAt = now;
      exactReceipt.updatedAt = now;
    }
    if (effectReceipt?.status === "running") {
      effectReceipt.status = "uncertain";
      effectReceipt.errorCode = "stale_approval";
      effectReceipt.completedAt = now;
      effectReceipt.updatedAt = now;
    }
    approval.status = effectReceipt ? "uncertain" : "failed";
    approval.executionReceiptId = effectReceipt?.id ?? null;
    approval.updatedAt = now;
    if (effectReceipt) throw new ExecutionOutcomeUnknownError(effectReceipt.id);
    throw new ApprovalUnavailableError();
  }

  async consume(input: {
    approvalId: string;
    receiptId: string;
    now: number;
  }): Promise<ExecutionApproval> {
    const approval = this.approvals.get(input.approvalId);
    if (approval?.status !== "executing" && approval?.status !== "uncertain") {
      throw new ApprovalUnavailableError();
    }
    if (approval.executionReceiptId && approval.executionReceiptId !== input.receiptId) {
      throw new ApprovalUnavailableError();
    }
    if (this.assertReceiptOwnership(approval, input.receiptId).status !== "succeeded") {
      throw new ApprovalUnavailableError();
    }
    approval.status = "consumed";
    approval.executionReceiptId = input.receiptId;
    approval.updatedAt = input.now;
    return structuredClone(approval);
  }

  async succeedWithReceipt(input: { approvalId: string; receipt: ExecutionReceipt;
    result: JsonValue; now: number; deadlineAt: number }): Promise<ExecutionReceipt> {
    const approval = this.approvals.get(input.approvalId);
    if (approval?.status !== "executing" ||
        this.assertReceiptOwnership(approval, input.receipt.id).status !== "running") {
      throw new ApprovalUnavailableError();
    }
    const receipt = this.receipts.receipts.get(input.receipt.id)!;
    receipt.status = "succeeded";
    receipt.result = structuredClone(input.result);
    receipt.completedAt = input.now;
    receipt.updatedAt = input.now;
    approval.status = "consumed";
    approval.executionReceiptId = receipt.id;
    approval.updatedAt = input.now;
    return structuredClone(receipt);
  }

  async fail(input: { approvalId: string; now: number }): Promise<ExecutionApproval> {
    const approval = this.approvals.get(input.approvalId);
    if (approval?.status !== "executing") throw new ApprovalUnavailableError();
    approval.status = "failed";
    approval.updatedAt = input.now;
    return structuredClone(approval);
  }

  async uncertain(input: { approvalId: string; receiptId: string | null; now: number }): Promise<ExecutionApproval> {
    const approval = this.approvals.get(input.approvalId);
    if (approval?.status !== "executing") throw new ApprovalUnavailableError();
    if (input.receiptId && !["running", "succeeded", "uncertain"].includes(
      this.assertReceiptOwnership(approval, input.receiptId).status)) throw new ApprovalUnavailableError();
    approval.status = "uncertain";
    approval.executionReceiptId = input.receiptId;
    approval.updatedAt = input.now;
    return structuredClone(approval);
  }

  /** Mirror the durable intent decision for fixture-backed execution tests. */
  reconcile(input: { approvalId: string; actorUserId: string; principalKey: string;
    decision: "effect_present" | "effect_absent"; now: number }): Promise<ExecutionApproval> {
    return Promise.resolve().then(() => {
      const approval = this.approvals.get(input.approvalId);
      if (approval?.actorUserId !== input.actorUserId ||
          approval.principalKey !== input.principalKey || !this.isMember(approval.workspaceId, input.actorUserId) ||
          approval.status !== "uncertain" || !approval.executionReceiptId ||
          this.assertReceiptOwnership(approval, approval.executionReceiptId).status !== "uncertain") {
        throw new ApprovalUnavailableError();
      }
      approval.status = input.decision === "effect_present" ? "consumed" : "failed";
      approval.reconciledAs = input.decision;
      approval.decidedAt = input.now;
      approval.updatedAt = input.now;
      return structuredClone(approval);
    });
  }

  async listForActor(input: {
    workspaceId: string;
    actorUserId: string;
    limit: number;
  }): Promise<ExecutionApproval[]> {
    return [...this.approvals.values()]
      .filter((approval) =>
        approval.workspaceId === input.workspaceId && approval.actorUserId === input.actorUserId
      )
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, input.limit)
      .map((approval) => structuredClone(approval));
  }

  private pendingForActor(approvalId: string, actorUserId: string, now: number): ExecutionApproval {
    const approval = this.approvals.get(approvalId);
    if (
      !approval ||
      approval.status !== "pending" ||
      approval.actorUserId !== actorUserId ||
      approval.expiresAt <= now ||
      !this.isMember(approval.workspaceId, actorUserId)
    ) {
      throw new ApprovalUnavailableError();
    }
    return approval;
  }

  private assertReceiptOwnership(approval: ExecutionApproval, receiptId: string): ExecutionReceipt {
    const receipt = this.receipts.receipts.get(receiptId);
    if (receipt?.approvalId !== approval.id ||
        receipt.workspaceId !== approval.workspaceId || receipt.actorUserId !== approval.actorUserId ||
        receipt.principalKey !== approval.principalKey || receipt.toolId !== approval.toolId ||
        receipt.manifestHash !== approval.manifestHash || receipt.connectionId !== approval.connectionId ||
        receipt.providerConnectionId !== approval.providerConnectionId ||
        receipt.idempotencyKey !== approval.idempotencyKey) throw new ApprovalUnavailableError();
    return receipt;
  }
}
