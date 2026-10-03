/** Describe the next step when a Slack post approval is replayed. */
export function slackApprovalNotice(status: string): string {
  switch (status) {
    case "pending": return "Slack post awaits approval below. Review the bot, workspace, channel and message.";
    case "approved": return "Slack post is approved. Execute it from the approvals list below.";
    case "executing": return "Slack post is executing. Check its status before requesting another post.";
    case "uncertain": return "Slack post outcome is uncertain. Check the channel before another request.";
    case "consumed": return "This Slack post already completed. Start a new identical post to send it again.";
    case "rejected": return "This Slack post was rejected. Start a new identical post if you still want to send it.";
    case "failed": return "This Slack post failed. Check the execution record before starting a new identical post.";
    case "expired": return "This Slack post approval expired. Start a new identical post to request approval again.";
    default: return "This Slack post approval is unavailable. Check its status before starting another post.";
  }
}
