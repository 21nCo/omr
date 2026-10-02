import type { ExecutionApproval, ExecutionReceipt, ExecutionReceiptStore } from "@oh-my-router/execution";

/** Merge bounded history with every still-actionable Linear approval. */
export function visibleApprovals<T extends Pick<ExecutionApproval, "id">>(
  recent: readonly T[], outstandingLinear: readonly T[],
): T[] {
  return [...new Map([...recent, ...outstandingLinear]
    .map((approval) => [approval.id, approval])).values()];
}

/** Keep exact Linear reconciliation evidence available beyond recent history. */
export async function linearReconciliationReceipts(
  approvals: readonly Pick<ExecutionApproval, "id" | "status" | "toolId" | "executionReceiptId">[],
  receipts: ExecutionReceiptStore,
  workspaceId: string, actorUserId: string,
): Promise<ExecutionReceipt[]> {
  const uncertain = approvals.filter((approval) => approval.status === "uncertain" &&
    approval.toolId.startsWith("linear.") && approval.executionReceiptId);
  const found: (ExecutionReceipt | null)[] = [];
  // Older unresolved approvals are unbounded, so cap concurrent DB lookups.
  for (let index = 0; index < uncertain.length; index += 8) {
    found.push(...await Promise.all(uncertain.slice(index, index + 8).map((approval) =>
      receipts.findForApproval({ workspaceId, actorUserId, approvalId: approval.id,
        receiptId: approval.executionReceiptId! }))));
  }
  return found.filter((receipt): receipt is ExecutionReceipt => receipt !== null);
}
