import type { ToolManifest } from "@oh-my-router/tools";

export type PlaygroundConnection = {
  id: string; workspaceId: string; provider: string; label: string;
  status: string; readiness: string; selected: boolean; cleanupOnly?: boolean;
};
export type PlaygroundApproval = {
  id: string; workspaceId: string; connectionId: string; toolId: string;
  status: string; params: unknown; previewReady: boolean; manifestCurrent: boolean;
  expiresAt: number; executionReceiptId?: string | null;
  browserActionable?: boolean;
};
export type PlaygroundReceipt = {
  id: string; status: string; result: unknown; errorCode: string | null;
};
export type PlaygroundOverview = {
  workspaces: { workspace: { id: string; name: string } }[];
  selectedWorkspaceId: string | null;
  connections: PlaygroundConnection[];
  approvals?: PlaygroundApproval[];
};
export type PlaygroundCatalog = {
  tools: ToolManifest[]; nextCursor?: string;
  providers: { provider: string; state: string }[];
};

export function playgroundConnectionReady(connection: PlaygroundConnection, workspaceId: string): boolean {
  return connection.workspaceId === workspaceId && connection.status === "active" &&
    connection.readiness === "ready" && !connection.cleanupOnly;
}

export function resumablePlaygroundApproval(approval: PlaygroundApproval, workspaceId: string): boolean {
  return approval.workspaceId === workspaceId && approval.browserActionable === true &&
    ["pending", "approved", "executing", "uncertain"].includes(approval.status);
}

export function parsePlaygroundArguments(text: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("Arguments must be valid JSON."); }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Arguments must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function schemaHints(manifest: ToolManifest | null): { name: string; type: string;
  required: boolean; description: string }[] {
  const schema = manifest?.inputSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(properties).map(([name, definition]) => {
    const field = definition && typeof definition === "object" && !Array.isArray(definition)
      ? definition : {};
    return { name, type: typeof field.type === "string" ? field.type : "JSON",
      required: required.has(name),
      description: typeof field.description === "string" ? field.description : "" };
  });
}

export function playgroundError(error: unknown): string {
  if (error instanceof PlaygroundRequestError) {
    const advice: Record<string, string> = {
      CONNECTION_SELECTION_REQUIRED: "Select a connected account and try again.",
      CONNECTION_UNAVAILABLE: "Check or reconnect this account in the control plane.",
      CONNECTION_ACCESS_DENIED: "This account is unavailable in the selected workspace.",
      EXECUTION_INPUT_INVALID: "Check the tool schema and arguments.",
      APPROVAL_UNAVAILABLE: "This approval expired or is no longer available. Check its status before retrying.",
      EXECUTION_OUTCOME_UNKNOWN: "The provider outcome is uncertain. Verify the receipt before another write.",
      EXECUTION_IN_PROGRESS: "This action is still running. Check its approval status before retrying.",
    };
    return [error.message, advice[error.code], error.receiptId && `Receipt: ${error.receiptId}`]
      .filter(Boolean).join(" ");
  }
  return error instanceof Error ? error.message : "The request failed. Try again.";
}

export class PlaygroundRequestError extends Error {
  constructor(readonly code: string, message: string, readonly receiptId?: string) {
    super(message); this.name = "PlaygroundRequestError";
  }
}

export function createPlaygroundRequest(fetchImpl: typeof fetch, login: () => void) {
  return async function request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetchImpl(path, { credentials: "same-origin", cache: "no-store",
      ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body) }) });
    const value = await response.json().catch(() => ({})) as T & { error?: string; message?: string;
      receiptId?: string };
    if (response.status === 401 && !value.error?.endsWith("RECONNECT_REQUIRED")) login();
    if (!response.ok) throw new PlaygroundRequestError(value.error ?? "HTTP_ERROR",
      value.message ?? value.error ?? `Request failed (${response.status})`, value.receiptId);
    return value;
  };
}
