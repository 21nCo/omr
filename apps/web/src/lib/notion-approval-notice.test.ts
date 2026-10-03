import { describe, expect, it } from "vitest";
import { notionApprovalNotice } from "./notion-approval-notice.js";

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
});
