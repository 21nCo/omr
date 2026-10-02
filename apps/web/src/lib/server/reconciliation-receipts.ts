import { ApprovalUnavailableError, publicApproval, type ExecutionApproval, type ExecutionApprovalStore,
  type ExecutionReceipt, type ExecutionReceiptStore } from "@oh-my-router/execution";
import type { ToolManifest } from "@oh-my-router/tools";

/** Merge bounded history with actionable Linear approvals and one exact recovery. */
export function visibleApprovals<T extends Pick<ExecutionApproval, "id" | "status" | "expiresAt">>(
  recent: readonly T[], outstandingLinear: readonly T[], recovered: T | null, now: number,
): T[] {
  return [...new Map([...recent, ...outstandingLinear, ...(recovered ? [recovered] : [])]
    .filter((approval) => approval.status === "uncertain" ||
      !["pending", "approved"].includes(approval.status) || approval.expiresAt > now)
    .map((approval) => [approval.id, approval])).values()];
}

/** Recover one older Linear approval or its recorded decision without scanning history.
 * An owned but retired hint must not take down the workspace overview. Unknown or
 * foreign IDs still fail the actor/workspace boundary.
 */
export async function recoverLinearApproval(
  store: ExecutionApprovalStore, approvalId: string | undefined,
  workspaceId: string, actorUserId: string, now: number,
): Promise<ExecutionApproval | null> {
  if (!approvalId) return null;
  const approval = await store.getForActor(approvalId, actorUserId);
  const recorded = approval.reconciledAs;
  const validDecision = Boolean(approval.executionReceiptId) &&
    ((approval.status === "consumed" && recorded === "effect_present") ||
      (approval.status === "failed" && recorded === "effect_absent"));
  if (approval.workspaceId !== workspaceId || !approval.toolId.startsWith("linear.")) {
    throw new ApprovalUnavailableError();
  }
  if ((["pending", "approved"].includes(approval.status) && approval.expiresAt <= now) ||
      (!["pending", "approved", "executing", "uncertain"].includes(approval.status) && !validDecision) ||
      (recorded && !validDecision)) return null;
  return approval;
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
  const found: (ExecutionReceipt | null)[] = new Array(uncertain.length);
  let next = 0;
  const readNext = async (): Promise<void> => {
    const index = next++;
    if (index >= uncertain.length) return;
    const approval = uncertain[index]!;
    found[index] = await receipts.findForApproval({ workspaceId, actorUserId, approvalId: approval.id,
      receiptId: approval.executionReceiptId! });
    await readNext();
  };
  const results = await Promise.allSettled(Array.from({ length: Math.min(8, uncertain.length) }, () => readNext()));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
  return found.filter((receipt): receipt is ExecutionReceipt => receipt !== null);
}
