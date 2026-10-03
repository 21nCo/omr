import { describe, expect, it } from "vitest";
import type { ExecutionApproval, ExecutionReceipt } from "@oh-my-router/execution";
import { MemoryExecutionApprovalStore, MemoryExecutionReceiptStore } from "@oh-my-router/execution/testing";

import { createWorkspaceCatalogLoader, effectAbsentAvailable, effectPresentAvailable,
  type WorkspaceCatalogState } from "../workspace-catalog.js";
import { providerReconciliationReceipts, publicBrowserApproval, recoverProviderApproval,
  visibleApprovals } from "./reconciliation-receipts.js";

describe("Linear reconciliation history", () => {
  it.each(["notion.pages.create", "notion.pages.update"])(
    "discovers an old executing %s approval after reload beyond recent history", async (toolId) => {
      const receipts = new MemoryExecutionReceiptStore(() => true);
      const store = new MemoryExecutionApprovalStore(() => true, receipts);
      const old = { id: "executing-old", workspaceId: "workspace-A", actorUserId: "alice",
        principalKey: "web:alice", toolId, status: "executing", expiresAt: 0,
        createdAt: 1, executionReceiptId: "receipt-old" } as ExecutionApproval;
      store.approvals.set(old.id, old);
      for (let index = 0; index < 60; index++) store.approvals.set(`terminal-${index}`,
        { ...old, id: `terminal-${index}`, status: "consumed", createdAt: index + 2 });
      const actor = { workspaceId: old.workspaceId, actorUserId: old.actorUserId, now: 100, limit: 50 };
      const recent = await store.listForActor(actor);
      expect(recent.some((approval) => approval.id === old.id)).toBe(false);
      const outstanding = await store.listOutstandingProviderForActor(actor);
      expect(outstanding.map((approval) => approval.id)).toContain(old.id);
      const visible = visibleApprovals(recent, outstanding, null, actor.now);
      expect(visible.some((approval) => approval.id === old.id)).toBe(true);
      expect(await store.listOutstandingProviderForActor({ ...actor, workspaceId: "workspace-B" }))
        .toEqual([]);
      expect(await store.listOutstandingProviderForActor({ ...actor, actorUserId: "bob" }))
        .toEqual([]);
    });
  it.each(["notion.pages.create", "notion.pages.update", "linear.issues.update", "slack.messages.post"])(
    "discovers an old uncertain %s receipt without a recovery hint", async (toolId) => {
      const receipts = new MemoryExecutionReceiptStore(() => true);
      const store = new MemoryExecutionApprovalStore(() => true, receipts);
      const old = { id: "old", workspaceId: "workspace-A", actorUserId: "alice",
        principalKey: "web:alice", toolId, status: "uncertain", expiresAt: 0,
        createdAt: 1, executionReceiptId: "receipt-old" } as ExecutionApproval;
      store.approvals.set(old.id, old);
      receipts.receipts.set("receipt-old", { id: "receipt-old", approvalId: old.id,
        workspaceId: old.workspaceId, actorUserId: old.actorUserId, principalKey: old.principalKey,
        toolId, status: "uncertain", errorCode: "provider_response_ambiguous" } as ExecutionReceipt);
      for (let index = 0; index < 60; index++) {
        store.approvals.set(`terminal-${index}`, { ...old, id: `terminal-${index}`,
          status: "consumed", executionReceiptId: null, createdAt: index + 2 });
      }
      const actor = { workspaceId: "workspace-A", actorUserId: "alice", now: 100, limit: 50 };
      const recent = await store.listForActor(actor);
      expect(recent.some((item) => item.id === old.id)).toBe(false);
      const outstanding = await store.listOutstandingProviderForActor(actor);
      expect(outstanding.map((item) => item.id)).toEqual([old.id]);
      const visible = visibleApprovals(recent, outstanding, null, actor.now);
      expect((await providerReconciliationReceipts(visible, receipts,
        actor.workspaceId, actor.actorUserId)).map((receipt) => receipt.id)).toEqual(["receipt-old"]);
      expect(await store.listOutstandingProviderForActor({ ...actor, workspaceId: "workspace-B" }))
        .toEqual([]);
      expect(await store.listOutstandingProviderForActor({ ...actor, actorUserId: "bob" }))
        .toEqual([]);
    });

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
      expect(effectPresentAvailable(approval, receipts)).toBe(true);
      expect(effectAbsentAvailable(approval, receipts)).toBe(true);
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
      const page = await store.listOutstandingProviderForActor(actor);
      expect(page).toHaveLength(50);
      expect(page.some((approval) => approval.id === old.id)).toBe(false);
      const recent = await store.listForActor({ ...actor, limit: 50 });
      const recovered = await recoverProviderApproval(store, old.id, "workspace-A", "alice", 50);
      const visible = visibleApprovals(recent, page, recovered, 50);
      expect(visible).toHaveLength(51);
      expect(visible.some((approval) => approval.id === old.id)).toBe(true);
      expect(visible.some((approval) => approval.status === "pending" && approval.expiresAt <= 50)).toBe(false);
      const exact = await providerReconciliationReceipts(visible, receipts, "workspace-A", "alice");
      expect(exact.map((receipt) => receipt.id)).toEqual(["receipt-old"]);
      expect(effectPresentAvailable(old, exact)).toBe(true);
      expect(effectAbsentAvailable(old, exact)).toBe(true);
      await expect(recoverProviderApproval(store, old.id, "workspace-B", "alice", 50))
        .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
      await expect(recoverProviderApproval(store, old.id, "workspace-A", "bob", 50))
        .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
      member = false;
      await expect(recoverProviderApproval(store, old.id, "workspace-A", "alice", 50))
        .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    },
  );

  it.each(["linear.issues.create", "linear.issues.update"])(
    "recovers a settled %s decision with an exact receipt in its original workspace", async (toolId) => {
      let member = true;
      const receipts = new MemoryExecutionReceiptStore(() => member);
      const store = new MemoryExecutionApprovalStore(() => member, receipts);
      const approval = { id: "approval-old", workspaceId: "workspace-A", actorUserId: "alice",
        toolId, status: "consumed", reconciledAs: "effect_present",
        executionReceiptId: "receipt-old", expiresAt: 0, createdAt: 1 } as ExecutionApproval;
      store.approvals.set(approval.id, approval);
      for (let index = 0; index < 120; index++) {
        store.approvals.set(`approval-new-${index}`, { ...approval, id: `approval-new-${index}`,
          status: "pending", reconciledAs: null, expiresAt: 100, createdAt: index + 1 });
      }
      const recent = await store.listForActor({ workspaceId: "workspace-A", actorUserId: "alice", limit: 50 });
      expect(recent.some((item) => item.id === approval.id)).toBe(false);
      expect(await recoverProviderApproval(store, approval.id, "workspace-A", "alice", 10))
        .toMatchObject({ reconciledAs: "effect_present", executionReceiptId: "receipt-old" });
      await expect(recoverProviderApproval(store, approval.id, "workspace-B", "alice", 10))
        .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
      await expect(recoverProviderApproval(store, approval.id, "workspace-A", "bob", 10))
        .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
      store.approvals.set(approval.id, { ...approval, status: "failed", reconciledAs: "effect_absent" });
      expect(await recoverProviderApproval(store, approval.id, "workspace-A", "alice", 10))
        .toMatchObject({ status: "failed", reconciledAs: "effect_absent" });
      member = false;
      await expect(recoverProviderApproval(store, approval.id, "workspace-A", "alice", 10))
        .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    });

  it.each(["linear.issues.create", "linear.issues.update"])(
    "keeps a browser catalog current after lost %s execute or reject responses", async (toolId) => {
    const receipts = new MemoryExecutionReceiptStore(() => true);
    const store = new MemoryExecutionApprovalStore(() => true, receipts);
    const approval = { id: "approval-old", workspaceId: "workspace-A", actorUserId: "alice",
      principalKey: "web:alice", toolId, status: "approved",
      expiresAt: 100, createdAt: 1 } as ExecutionApproval;
    store.approvals.set(approval.id, approval);
    for (let index = 0; index < 100; index++) {
      store.approvals.set(`approval-new-${index}`, { ...approval, id: `approval-new-${index}`,
        createdAt: index + 2, status: "pending" });
    }
    type Overview = { selectedWorkspaceId: string; approvals: ExecutionApproval[] };
    type Catalog = { providers: string[] };
    const states: WorkspaceCatalogState<Overview, Catalog>[] = [];
    const load = createWorkspaceCatalogLoader<Overview, Catalog>(async (workspaceId) => {
      const recent = await store.listForActor({ workspaceId, actorUserId: "alice", limit: 50 });
      const recovered = await recoverProviderApproval(store, approval.id, workspaceId, "alice", 10);
      return { selectedWorkspaceId: workspaceId,
        approvals: visibleApprovals(recent, [], recovered, 10) };
    }, async () => ({ providers: ["github", "linear"] }), (state) => states.push(state));
    for (const status of ["approved", "executing", "consumed", "failed", "rejected"] as const) {
      store.approvals.set(approval.id, { ...approval, status });
      await load("workspace-A");
      expect(states.at(-1)).toMatchObject({ error: "", catalog: { providers: ["github", "linear"] } });
      expect(states.at(-1)?.overview?.approvals.find((item) => item.id === approval.id)?.status)
        .toBe(["consumed", "failed", "rejected"].includes(status) ? undefined : status);
    }
    });

  it("does not recover expired, unrelated, or wrong-workspace approvals", async () => {
    const receipts = new MemoryExecutionReceiptStore(() => true);
    const store = new MemoryExecutionApprovalStore(() => true, receipts);
    const approval = { id: "approval", workspaceId: "workspace-A", actorUserId: "alice",
      toolId: "linear.issues.update", status: "approved", expiresAt: 10 } as ExecutionApproval;
    store.approvals.set(approval.id, approval);
    await expect(recoverProviderApproval(store, approval.id, "workspace-A", "alice", 10))
      .resolves.toBeNull();
    store.approvals.set(approval.id, { ...approval, toolId: "github.issues.update", expiresAt: 100 });
    await expect(recoverProviderApproval(store, approval.id, "workspace-A", "alice", 10))
      .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
    store.approvals.set(approval.id, { ...approval, status: "consumed", expiresAt: 100 });
    await expect(recoverProviderApproval(store, approval.id, "workspace-A", "alice", 10))
      .resolves.toBeNull();
    store.approvals.set(approval.id, { ...approval, status: "consumed", reconciledAs: "effect_absent",
      executionReceiptId: "receipt-old" });
    await expect(recoverProviderApproval(store, approval.id, "workspace-A", "alice", 10))
      .resolves.toBeNull();
    store.approvals.set(approval.id, { ...approval, status: "rejected", reconciledAs: null });
    await expect(recoverProviderApproval(store, approval.id, "workspace-A", "alice", 10))
      .resolves.toBeNull();
    store.approvals.set(approval.id, { ...approval, status: "executing", expiresAt: 0 });
    await expect(recoverProviderApproval(store, approval.id, "workspace-A", "alice", 10))
      .resolves.toMatchObject({ status: "executing" });
    await expect(recoverProviderApproval(store, approval.id, "workspace-B", "alice", 10))
      .rejects.toMatchObject({ code: "APPROVAL_UNAVAILABLE" });
  });

  it("caps concurrent receipt reads while projecting a full overview", async () => {
    const store = new MemoryExecutionReceiptStore(() => true);
    const approvals = Array.from({ length: 101 }, (_, index) => ({
      id: `approval-${index}`, status: "uncertain", toolId: "linear.issues.create",
      executionReceiptId: `receipt-${index}`,
    })) as Pick<ExecutionApproval, "id" | "status" | "toolId" | "executionReceiptId">[];
    let active = 0;
    let maximum = 0;
    let calls = 0;
    store.findForApproval = async () => {
      calls += 1;
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active -= 1;
      return null;
    };
    expect(await providerReconciliationReceipts(approvals, store, "workspace-A", "alice")).toEqual([]);
    expect(calls).toBe(101);
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(8);
  });

  it("settles outstanding receipt reads before closing an overview after one read fails", async () => {
    const store = new MemoryExecutionReceiptStore(() => true);
    const approvals = Array.from({ length: 8 }, (_, index) => ({
      id: `approval-${index}`, status: "uncertain", toolId: "linear.issues.update",
      executionReceiptId: `receipt-${index}`,
    })) as Pick<ExecutionApproval, "id" | "status" | "toolId" | "executionReceiptId">[];
    let active = 0;
    store.findForApproval = async ({ approvalId }) => {
      active++;
      try {
        if (approvalId === "approval-0") throw new Error("receipt read failed");
        await new Promise((resolve) => setTimeout(resolve, 5));
        return null;
      } finally { active--; }
    };
    await expect(providerReconciliationReceipts(approvals, store, "workspace-A", "alice"))
      .rejects.toThrow("receipt read failed");
    expect(active).toBe(0);
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
    const exact = await providerReconciliationReceipts([approval], store, "workspace-A", "alice");
    expect(exact.map((receipt) => receipt.id)).toEqual([old.id]);
    expect(effectAbsentAvailable(approval, exact)).toBe(true);
    expect(effectPresentAvailable(approval, exact)).toBe(true);
    expect(await providerReconciliationReceipts([approval], store, "workspace-B", "alice")).toEqual([]);
    expect(await providerReconciliationReceipts([approval], store, "workspace-A", "bob")).toEqual([]);
    expect(await providerReconciliationReceipts([{ ...approval, id: "approval-other" }],
      store, "workspace-A", "alice")).toEqual([]);
    member = false;
    expect(await providerReconciliationReceipts([approval], store, "workspace-A", "alice")).toEqual([]);
  });

  it("does not offer a no-effect decision for absent or ineligible receipts", async () => {
    const store = new MemoryExecutionReceiptStore(() => true);
    const approval: Pick<ExecutionApproval, "id" | "status" | "toolId" | "executionReceiptId"> = {
      id: "approval-one", status: "uncertain", toolId: "linear.issues.create",
      executionReceiptId: "execution-one" };
    expect(await providerReconciliationReceipts([approval], store, "workspace-A", "alice")).toEqual([]);
    const receipt = { id: approval.executionReceiptId, workspaceId: "workspace-A", actorUserId: "alice",
      approvalId: approval.id, status: "uncertain", errorCode: "provider_outcome_unknown" } as ExecutionReceipt;
    store.receipts.set(receipt.id, receipt);
    const exact = await providerReconciliationReceipts([approval], store, "workspace-A", "alice");
    expect(effectAbsentAvailable(approval, exact)).toBe(false);
    store.receipts.set(receipt.id, { ...receipt, status: "running",
      errorCode: "provider_response_ambiguous" });
    expect(effectAbsentAvailable(approval,
      await providerReconciliationReceipts([approval], store, "workspace-A", "alice"))).toBe(false);
    expect(effectPresentAvailable(approval,
      await providerReconciliationReceipts([approval], store, "workspace-A", "alice"))).toBe(true);
    expect(await providerReconciliationReceipts([{ ...approval, status: "consumed" }],
      store, "workspace-A", "alice")).toEqual([]);
  });
});
