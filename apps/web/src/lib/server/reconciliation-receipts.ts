import { ApprovalUnavailableError, publicApproval, type ExecutionApproval, type ExecutionApprovalStore,
  type ExecutionReceipt, type ExecutionReceiptStore } from "@oh-my-router/execution";
import type { ToolManifest } from "@oh-my-router/tools";

/** Merge bounded history with actionable provider approvals and one exact recovery. */
export function visibleApprovals<T extends Pick<ExecutionApproval, "id" | "status" | "expiresAt">>(
  recent: readonly T[], outstandingProvider: readonly T[], recovered: T | null, now: number,
): T[] {
  return [...new Map([...recent, ...outstandingProvider, ...(recovered ? [recovered] : [])]
    .filter((approval) => approval.status === "uncertain" ||
      !["pending", "approved"].includes(approval.status) || approval.expiresAt > now)
    .map((approval) => [approval.id, approval])).values()];
}

/** Recover one older approval or its recorded decision without scanning history.
 * An owned but retired hint must not take down the workspace overview. Unknown or
 * foreign IDs still fail the actor/workspace boundary.
 */
export async function recoverProviderApproval(
  store: ExecutionApprovalStore, approvalId: string | undefined,
  workspaceId: string, actorUserId: string, now: number,
): Promise<ExecutionApproval | null> {
  if (!approvalId) return null;
  const approval = await store.getForActor(approvalId, actorUserId);
  const recorded = approval.reconciledAs;
  const validDecision = Boolean(approval.executionReceiptId) &&
    ((approval.status === "consumed" && recorded === "effect_present") ||
      (approval.status === "failed" && recorded === "effect_absent"));
  if (approval.workspaceId !== workspaceId) {
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

/** Give an authenticated browser a non-replayable link to its saved action key. */
export async function publicBrowserApprovalStatus(
  approval: ExecutionApproval, manifest: ToolManifest | null | undefined, browser: boolean,
  receipt: ExecutionReceipt | null = null,
) {
  const visible = publicApproval(approval, manifest);
  if (!browser) return visible;
  const bytes = new TextEncoder().encode(approval.idempotencyKey);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const actionKeyDigest = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const exactReceipt = Boolean(receipt && approval.executionReceiptId &&
    receipt.id === approval.executionReceiptId &&
    receipt.approvalId === approval.id && receipt.workspaceId === approval.workspaceId &&
    receipt.actorUserId === approval.actorUserId && receipt.principalKey === approval.principalKey &&
    receipt.toolId === approval.toolId && receipt.manifestHash === approval.manifestHash &&
    receipt.connectionId === approval.connectionId &&
    receipt.providerConnectionId === approval.providerConnectionId &&
    receipt.idempotencyKey === approval.idempotencyKey);
  return { ...visible, actionKeyDigest,
    canConfirmPresent: approval.status === "uncertain" && exactReceipt &&
      (receipt?.status === "running" || receipt?.status === "uncertain"),
    canConfirmAbsent: approval.status === "uncertain" && exactReceipt &&
      receipt?.status === "uncertain" && receipt?.errorCode === "provider_response_ambiguous" };
}

/** Keep exact reconciliation evidence available beyond recent history. */
export async function providerReconciliationReceipts(
  approvals: readonly Pick<ExecutionApproval, "id" | "status" | "toolId" | "executionReceiptId">[],
  receipts: ExecutionReceiptStore,
  workspaceId: string, actorUserId: string,
): Promise<ExecutionReceipt[]> {
  const uncertain = approvals.filter((approval) => approval.status === "uncertain" &&
    approval.executionReceiptId);
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
