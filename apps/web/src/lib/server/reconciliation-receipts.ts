import type { ExecutionApproval, ExecutionReceipt, ExecutionReceiptStore } from "@oh-my-router/execution";

/** Keep exact Linear reconciliation evidence available beyond recent history. */
export async function linearReconciliationReceipts(
  approvals: readonly Pick<ExecutionApproval, "id" | "status" | "toolId" | "executionReceiptId">[],
  receipts: ExecutionReceiptStore,
  workspaceId: string, actorUserId: string,
): Promise<ExecutionReceipt[]> {
  const uncertain = approvals.filter((approval) => approval.status === "uncertain" &&
    approval.toolId.startsWith("linear.") && approval.executionReceiptId);
  const found = await Promise.all(uncertain.map((approval) => receipts.findForApproval({
    workspaceId, actorUserId, approvalId: approval.id,
    receiptId: approval.executionReceiptId!,
  })));
  return found.filter((receipt): receipt is ExecutionReceipt => receipt !== null);
}
