import { describe, expect, it } from "vitest";
import { createLinearActionKeys } from "./linear-action-keys.js";
import { slackApprovalNotice } from "./slack-approval-notice.js";

describe("Slack post approval notice", () => {
  it("describes each active approval and settled outcome", () => {
    expect(slackApprovalNotice("pending")).toContain("awaits approval below");
    expect(slackApprovalNotice("approved")).toContain("Execute it from the approvals list");
    expect(slackApprovalNotice("executing")).toContain("is executing");
    expect(slackApprovalNotice("uncertain")).toContain("Check the channel");
    expect(slackApprovalNotice("consumed")).toContain("already completed");
    expect(slackApprovalNotice("rejected")).toContain("was rejected");
    expect(slackApprovalNotice("failed")).toContain("failed");
    expect(slackApprovalNotice("expired")).toContain("expired");
    expect(slackApprovalNotice("unknown")).toContain("unavailable");
  });

  it("explains a repeated identical post after its approval settled", async () => {
    let next = 0;
    const keys = createLinearActionKeys(() => `slack-post-${++next}`, undefined, "Slack");
    const params = { workspaceId: "slack-A", channelId: "channel-A", senderId: "bot-A", text: "Hello" };
    const original = await keys.key("slack.messages.post", "omr-A", "connection-A", params);
    expect(await keys.key("slack.messages.post", "omr-A", "connection-A", { ...params })).toBe(original);
    expect(slackApprovalNotice("consumed")).not.toContain("awaits approval below");
    await keys.resetAfterSettlement("slack.messages.post", "omr-A", "connection-A", params,
      async (key) => { expect(key).toBe(original); return { status: "consumed" }; });
    expect(await keys.key("slack.messages.post", "omr-A", "connection-A", params)).not.toBe(original);
  });
});
