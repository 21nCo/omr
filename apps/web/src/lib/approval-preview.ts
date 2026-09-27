/** Keep the entire server-redacted argument preview available for review. */
export function renderApprovalPreview(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "—";
}
