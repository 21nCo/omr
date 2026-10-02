import { publicApproval, type ExecutionApproval, type ExecutionReceipt, type ExecutionReceiptStore } from "@oh-my-router/execution";
import type { ToolManifest } from "@oh-my-router/tools";

/** Merge bounded history with every still-actionable Linear approval. */
export function visibleApprovals<T extends Pick<ExecutionApproval, "id">>(
  recent: readonly T[], outstandingLinear: readonly T[],
): T[] {
  return [...new Map([...recent, ...outstandingLinear]
    .map((approval) => [approval.id, approval])).values()];
}

/** Browser execution and reconciliation must use the approval's original principal. */
export function publicBrowserApproval(
  approval: ExecutionApproval, manifest: ToolManifest | null | undefined,
  actorUserId: string, workspaceId: string,
) {
  return {
    ...publicApproval(approval, manifest),
    browserActionable: approval.actorUserId === actorUserId && approval.workspaceId === workspaceId &&
      approval.principalKey === `web:${actorUserId}`,
  };
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
