import { describe, expect, it } from "vitest";
import { renderApprovalPreview } from "./approval-preview.js";

describe("approval preview", () => {
  it("keeps a target after a long earlier argument visible", () => {
    const preview = renderApprovalPreview({ body: "x".repeat(700), target: "late-resource",
      credential: "[REDACTED]" });
    expect(preview.length).toBeGreaterThan(700);
    expect(preview).toContain('"target": "late-resource"');
    expect(preview).toContain('"credential": "[REDACTED]"');
  });
});
