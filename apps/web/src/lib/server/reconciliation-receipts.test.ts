import { describe, expect, it } from "vitest";
import type { ExecutionApproval, ExecutionReceipt } from "@oh-my-router/execution";
import { MemoryExecutionApprovalStore, MemoryExecutionReceiptStore } from "@oh-my-router/execution/testing";

import { linearEffectAbsentAvailable, linearEffectPresentAvailable } from "../workspace-catalog.js";
import { linearReconciliationReceipts, publicBrowserApproval, recoverLinearApproval,
  visibleApprovals } from "./reconciliation-receipts.js";

describe("Linear reconciliation history", () => {
  it.each(["pending", "approved", "uncertain"] as const)(
    "keeps %s client-grant approvals visible but reserves browser execution for its own principal", (status) => {
      const approval = { id: `approval-${status}`, status, toolId: "linear.issues.update",
        actorUserId: "alice", workspaceId: "workspace-A", principalKey: "web:alice",
        params: {}, manifestHash: "manifest", executionReceiptId: "receipt-A" } as ExecutionApproval;
      const web = publicBrowserApproval(approval, null, "alice", "workspace-A");
      expect(web.browserActionable).toBe(true);
      const client = { ...approval, principalKey: "client:cli:grant:grant-A" };
      const visible = publicBrowserApproval(client, null, "alice", "workspace-A");
      expect(visible).toMatchObject({ id: approval.id, status, browserActionable: false });
      expect(JSON.stringify(visible)).not.toContain("grant-A");
      expect(publicBrowserApproval(approval, null, "alice", "workspace-B").browserActionable).toBe(false);
      expect(publicBrowserApproval(approval, null, "bob", "workspace-A").browserActionable).toBe(false);
      expect(publicBrowserApproval(client, null, "alice", "workspace-B").browserActionable).toBe(false);
    },
  );

  it.each(["linear.issues.create", "linear.issues.update"])(
    "does not let a browser reconcile a %s client receipt even when either decision has exact evidence", (toolId) => {
      const approval = { id: "approval-A", status: "uncertain", toolId,
        actorUserId: "alice", workspaceId: "workspace-A",
        principalKey: "client:mcp:grant:grant-A", executionReceiptId: "receipt-A",
        params: {}, manifestHash: "manifest" } as ExecutionApproval;
      const receipts = [{ id: "receipt-A", status: "uncertain",
        errorCode: "provider_response_ambiguous" }];
      expect(linearEffectPresentAvailable(approval, receipts)).toBe(true);
      expect(linearEffectAbsentAvailable(approval, receipts)).toBe(true);
      expect(publicBrowserApproval(approval, null, "alice", "workspace-A").browserActionable).toBe(false);
    },
  );

  it.each(["linear.issues.create", "linear.issues.update"])(
    "bounds hundreds of %s approvals, then recovers the exact old receipt for either decision", async (toolId) => {
      let member = true;
      const receipts = new MemoryExecutionReceiptStore(() => member);
      const store = new MemoryExecutionApprovalStore(() => member, receipts);
      const old = { id: "approval-old", workspaceId: "workspace-A", actorUserId: "alice",
        principalKey: "web:alice", toolId, status: "uncertain", expiresAt: 0,
        createdAt: 1, executionReceiptId: "receipt-old" } as ExecutionApproval;
      store.approvals.set(old.id, old);
      receipts.receipts.set("receipt-old", { id: "receipt-old", approvalId: old.id,
        workspaceId: old.workspaceId, actorUserId: old.actorUserId, status: "uncertain",
        errorCode: "provider_response_ambiguous" } as ExecutionReceipt);
      for (let index = 0; index < 250; index++) {
        const id = `approval-new-${index}`;
        store.approvals.set(id, { ...old, id, createdAt: index + 2,
          status: "pending", expiresAt: index % 2 ? 100 : 0 });
      }
      const actor = { workspaceId: "workspace-A", actorUserId: "alice", now: 50, limit: 50 };
      const page = await store.listOutstandingLinearForActor(actor);
      expect(page).toHaveLength(50);
      expect(page.some((approval) => approval.id === old.id)).toBe(false);
      const recent = await store.listForActor({ ...actor, limit: 50 });
      const recovered = await recoverLinearApproval(store, old.id, "workspace-A", "alice", 50);
      const visible = visibleApprovals(recent, page, recovered, 50);
      expect(visible).toHaveLength(51);
      expect(visible.some((approval) => approval.id === old.id)).toBe(true);
      expect(visible.some((approval) => approval.status === "pending" && approval.expiresAt <= 50)).toBe(false);
      const exact = await linearReconciliationReceipts(visible, receipts, "workspace-A", "alice");
      expect(exact.map((receipt) => receipt.id)).toEqual(["receipt-old"]);
      expect(linearEffectPresentAvailable(old, exact)).toBe(true);
      expect(linearEffectAbsentAvailable(old, exact)).toBe(true);
      await expect(recoverLinearApproval(store, old.id, "workspace-B", "alice", 50))
        .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
      await expect(recoverLinearApproval(store, old.id, "workspace-A", "bob", 50))
        .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
      member = false;
      await expect(recoverLinearApproval(store, old.id, "workspace-A", "alice", 50))
        .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    },
  );

  it("does not recover expired, unrelated, or settled approvals", async () => {
    const receipts = new MemoryExecutionReceiptStore(() => true);
    const store = new MemoryExecutionApprovalStore(() => true, receipts);
    const approval = { id: "approval", workspaceId: "workspace-A", actorUserId: "alice",
      toolId: "linear.issues.update", status: "approved", expiresAt: 10 } as ExecutionApproval;
    store.approvals.set(approval.id, approval);
    await expect(recoverLinearApproval(store, approval.id, "workspace-A", "alice", 10))
      .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    store.approvals.set(approval.id, { ...approval, toolId: "github.issues.update", expiresAt: 100 });
    await expect(recoverLinearApproval(store, approval.id, "workspace-A", "alice", 10))
      .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    store.approvals.set(approval.id, { ...approval, status: "consumed", expiresAt: 100 });
    await expect(recoverLinearApproval(store, approval.id, "workspace-A", "alice", 10))
      .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
  });

  it("retains an exact old receipt outside 50 recent executions and scopes it to its approval", async () => {
    let member = true;
    const store = new MemoryExecutionReceiptStore(() => member);
    const approval: Pick<ExecutionApproval, "id" | "status" | "toolId" | "executionReceiptId"> = {
      id: "approval-old", status: "uncertain", toolId: "linear.issues.update",
      executionReceiptId: "execution-old" };
    const old = { id: "execution-old", workspaceId: "workspace-A", actorUserId: "alice",
      approvalId: approval.id, createdAt: 1, status: "uncertain",
      errorCode: "provider_response_ambiguous" } as ExecutionReceipt;
    store.receipts.set(old.id, old);
    for (let index = 0; index < 51; index++) {
      const id = `execution-new-${index}`;
      store.receipts.set(id, { ...old, id, approvalId: `approval-new-${index}`,
        createdAt: index + 2 });
    }
    const recent = await store.listForActor({ workspaceId: "workspace-A", actorUserId: "alice", limit: 50 });
    expect(recent.some((receipt) => receipt.id === old.id)).toBe(false);
    const exact = await linearReconciliationReceipts([approval], store, "workspace-A", "alice");
    expect(exact.map((receipt) => receipt.id)).toEqual([old.id]);
    expect(linearEffectAbsentAvailable(approval, exact)).toBe(true);
    expect(linearEffectPresentAvailable(approval, exact)).toBe(true);
    expect(await linearReconciliationReceipts([approval], store, "workspace-B", "alice")).toEqual([]);
    expect(await linearReconciliationReceipts([approval], store, "workspace-A", "bob")).toEqual([]);
    expect(await linearReconciliationReceipts([{ ...approval, id: "approval-other" }],
      store, "workspace-A", "alice")).toEqual([]);
    member = false;
    expect(await linearReconciliationReceipts([approval], store, "workspace-A", "alice")).toEqual([]);
  });

  it("does not offer a no-effect decision for absent or ineligible receipts", async () => {
    const store = new MemoryExecutionReceiptStore(() => true);
    const approval: Pick<ExecutionApproval, "id" | "status" | "toolId" | "executionReceiptId"> = {
      id: "approval-one", status: "uncertain", toolId: "linear.issues.create",
      executionReceiptId: "execution-one" };
    expect(await linearReconciliationReceipts([approval], store, "workspace-A", "alice")).toEqual([]);
    const receipt = { id: approval.executionReceiptId, workspaceId: "workspace-A", actorUserId: "alice",
      approvalId: approval.id, status: "uncertain", errorCode: "provider_outcome_unknown" } as ExecutionReceipt;
    store.receipts.set(receipt.id, receipt);
    const exact = await linearReconciliationReceipts([approval], store, "workspace-A", "alice");
    expect(linearEffectAbsentAvailable(approval, exact)).toBe(false);
    store.receipts.set(receipt.id, { ...receipt, status: "running",
      errorCode: "provider_response_ambiguous" });
    expect(linearEffectAbsentAvailable(approval,
      await linearReconciliationReceipts([approval], store, "workspace-A", "alice"))).toBe(false);
    expect(linearEffectPresentAvailable(approval,
      await linearReconciliationReceipts([approval], store, "workspace-A", "alice"))).toBe(true);
    expect(await linearReconciliationReceipts([{ ...approval, status: "consumed" }],
      store, "workspace-A", "alice")).toEqual([]);
  });
});
