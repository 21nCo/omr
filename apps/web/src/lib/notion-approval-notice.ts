/** Describe the next step for an original or replayed Notion page approval. */
export function notionApprovalNotice(status: string): string {
  switch (status) {
    case "pending": return "Notion page change awaits approval below. Review the account, destination and title.";
    case "approved": return "Notion page change is approved. Execute it from the approvals list below.";
    case "executing": return "Notion page change is executing. Check its status before requesting another change.";
    case "uncertain": return "Notion page change outcome is uncertain. Check the page in Notion, then reconcile its receipt before another request.";
    case "consumed": return "This Notion page change already completed. Start a new identical change to repeat it.";
    case "rejected": return "This Notion page change was rejected. Start a new identical change if it is still needed.";
    case "failed": return "This Notion page change failed. Check the execution record before starting a new identical change.";
    case "expired": return "This Notion page approval expired. Start a new identical change to request approval again.";
    default: return "This Notion page approval is unavailable. Check its status before starting another change.";
  }
}
