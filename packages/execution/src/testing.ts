import type { JsonValue } from "@oh-my-router/tools";

import {
  ApprovalUnavailableError,
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

  async reserve(receipt: ExecutionReceipt): Promise<{ receipt: ExecutionReceipt; created: boolean }> {
    const existingId = this.idempotency.get(key(receipt));
    if (existingId) {
      return { receipt: structuredClone(this.receipts.get(existingId)!), created: false };
    }
    this.receipts.set(receipt.id, structuredClone(receipt));
    this.idempotency.set(key(receipt), receipt.id);
    return { receipt: structuredClone(receipt), created: true };
  }

  async succeed(receiptId: string, result: JsonValue, now: number): Promise<ExecutionReceipt> {
    const receipt = this.required(receiptId);
    receipt.status = "succeeded";
    receipt.result = structuredClone(result);
    receipt.completedAt = now;
    receipt.updatedAt = now;
    return structuredClone(receipt);
  }

  async fail(receiptId: string, errorCode: string, now: number): Promise<ExecutionReceipt> {
    const receipt = this.required(receiptId);
    receipt.status = "failed";
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

  async create(approval: ExecutionApproval): Promise<ExecutionApproval> {
    if (this.approvals.has(approval.id)) throw new ApprovalUnavailableError();
    this.approvals.set(approval.id, structuredClone(approval));
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
  }): Promise<ExecutionApproval> {
    const approval = this.approvals.get(input.approvalId);
    if (
      !approval ||
      approval.status !== "approved" ||
      approval.actorUserId !== input.actorUserId ||
      approval.principalKey !== input.principalKey ||
      approval.expiresAt <= input.now
    ) {
      throw new ApprovalUnavailableError();
    }
    approval.status = "executing";
    approval.updatedAt = input.now;
    return structuredClone(approval);
  }

  async consume(input: {
    approvalId: string;
    receiptId: string;
    now: number;
  }): Promise<ExecutionApproval> {
    const approval = this.approvals.get(input.approvalId);
    if (!approval || approval.status !== "executing") throw new ApprovalUnavailableError();
    approval.status = "consumed";
    approval.executionReceiptId = input.receiptId;
    approval.updatedAt = input.now;
    return structuredClone(approval);
  }

  async fail(input: { approvalId: string; now: number }): Promise<ExecutionApproval> {
    const approval = this.approvals.get(input.approvalId);
    if (!approval || approval.status !== "executing") throw new ApprovalUnavailableError();
    approval.status = "failed";
    approval.updatedAt = input.now;
    return structuredClone(approval);
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
      approval.expiresAt <= now
    ) {
      throw new ApprovalUnavailableError();
    }
    return approval;
  }
}
