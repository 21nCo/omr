import { describe, expect, it } from "vitest";
import { notionApprovalNotice, notionApprovalRecovery } from "./notion-approval-notice.js";

describe("Notion approval notice", () => {
  it("identifies a pending, approved, or replayed page change and its next step", () => {
    expect(notionApprovalNotice("pending")).toContain("awaits approval below");
    expect(notionApprovalNotice("pending")).toContain("destination");
    expect(notionApprovalNotice("approved")).toContain("Execute it from the approvals list");
    expect(notionApprovalNotice("executing")).toContain("Check its status");
    expect(notionApprovalNotice("uncertain")).toContain("reconcile its receipt");
    expect(notionApprovalNotice("consumed")).toContain("already completed");
    expect(notionApprovalNotice("consumed")).not.toContain("awaits approval");
  });

  it("keeps an executing coalesced ID without applying pending expiry cleanup", () => {
    const executing = notionApprovalRecovery({ id: "approval-in-flight", status: "executing", expiresAt: 1 });
    expect(executing).toEqual({ id: "approval-in-flight", automaticLookup: null });
    expect(notionApprovalRecovery({ id: "approval-in-flight", status: "uncertain", expiresAt: 1 }).id)
      .toBe("approval-in-flight");
    expect(notionApprovalRecovery({ id: "approval-in-flight", status: "pending", expiresAt: 100 }))
      .toEqual({ id: "approval-in-flight", automaticLookup: { id: "approval-in-flight", expiresAt: 100 } });
    expect(notionApprovalRecovery({ id: "approval-in-flight", status: "consumed", expiresAt: 1 }).id)
      .toBe("");
  });
});
