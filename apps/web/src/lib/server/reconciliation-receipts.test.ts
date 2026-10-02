import { describe, expect, it } from "vitest";
import type { ExecutionApproval, ExecutionReceipt } from "@oh-my-router/execution";
import { MemoryExecutionReceiptStore } from "@oh-my-router/execution/testing";

import { linearEffectAbsentAvailable } from "../workspace-catalog.js";
import { linearReconciliationReceipts } from "./reconciliation-receipts.js";

describe("Linear reconciliation history", () => {
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
    expect(await linearReconciliationReceipts([{ ...approval, status: "consumed" }],
      store, "workspace-A", "alice")).toEqual([]);
  });
});
