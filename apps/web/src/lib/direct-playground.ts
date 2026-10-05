import type { ToolManifest } from "@oh-my-router/tools";

export type PlaygroundConnection = {
  id: string; workspaceId: string; provider: string; label: string;
  status: string; readiness: string; selected: boolean; cleanupOnly?: boolean;
  providerState?: string; selectable?: boolean;
};
export type PlaygroundApproval = {
  id: string; workspaceId: string; connectionId: string; toolId: string;
  status: string; params: unknown; previewReady: boolean; manifestCurrent: boolean;
  action: string; effect: string; resources: { kind: string; parameter?: string }[];
  previewMode: "opaque" | "redacted" | "unavailable";
  expiresAt: number; executionReceiptId?: string | null;
  actionKeyDigest?: string;
  browserActionable?: boolean;
  reconciledAs?: "effect_present" | "effect_absent" | null;
  canConfirmPresent?: boolean; canConfirmAbsent?: boolean;
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
export type AssistedPlaygroundResult = {
  status: "answered" | "approval_required" | "tool_error" | "model_error" | "action_pending";
  answer: string; model: string; servedModels: string[]; toolId?: string;
  errorCode?: string; receiptId?: string; requestId?: string;
  /** A confirmed failed read permits a fresh identical request. */
  terminalFailure?: boolean;
  /** A terminal write receipt requires an explicit, status-checked fresh intent. */
  terminalWrite?: boolean;
  usageIncomplete?: boolean;
  approval?: PlaygroundApproval; receipt?: PlaygroundReceipt;
  usage: { promptTokens: number | null; completionTokens: number | null;
    totalTokens: number | null; costUsd: number | null };
};

/** Mirror the server's selectable binding gate for the chosen workspace. */
export function playgroundConnectionReady(connection: PlaygroundConnection, workspaceId: string): boolean {
  return connection.workspaceId === workspaceId && connection.status === "active" &&
    connection.readiness === "ready" && connection.providerState === "ready" &&
    connection.selectable === true && !connection.cleanupOnly;
}

/** Offer only this workspace's browser-actionable unsettled approvals for recovery. */
export function resumablePlaygroundApproval(approval: PlaygroundApproval, workspaceId: string): boolean {
  return approval.workspaceId === workspaceId && approval.browserActionable === true &&
    ["pending", "approved", "executing", "uncertain"].includes(approval.status);
}

/** Parse a top-level JSON object before it enters the shared execution service. */
export function parsePlaygroundArguments(text: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("Arguments must be valid JSON."); }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Arguments must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

/** Turn the manifest's top-level fields into short form hints. */
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

/** Pair shared API error codes with a concrete recovery step. */
export function playgroundError(error: unknown): string {
  if (error instanceof PlaygroundRequestError) {
    const advice: Record<string, string> = {
      CONNECTION_SELECTION_REQUIRED: "Select a connected account and try again.",
      CONNECTION_UNAVAILABLE: "Check or reconnect this account in the control plane.",
      CONNECTION_ACCESS_DENIED: "This account is unavailable in the selected workspace.",
      TOOL_NOT_FOUND: "Refresh the tool catalog and select an available tool again.",
      EXECUTION_INPUT_INVALID: "Check the tool schema and arguments.",
      APPROVAL_UNAVAILABLE: "This approval expired or is no longer available. Check its status before retrying.",
      EXECUTION_OUTCOME_UNKNOWN: "The provider outcome is uncertain. Verify the receipt before another write.",
      EXECUTION_IN_PROGRESS: "This action is still running. Check its approval status before retrying.",
      EXECUTION_FAILED: "Check the receipt and account health in the control plane. Verify the provider outcome before retrying a write.",
      ASSISTED_DISABLED: "Assisted testing is not enabled yet.",
      ASSISTED_RATE_LIMITED: "Your assisted requests are limited to one at a time and ten per hour. Try later.",
      ASSISTED_MODEL_INVALID: "Enter a model identifier such as provider/model.",
      ASSISTED_PROMPT_INVALID: "Enter a request under 2,000 characters without an API key.",
      ASSISTED_REQUEST_ID_INVALID: "This request could not be identified. Reload and try again.",
      ASSISTED_REQUEST_CONFLICT: "This request ID belongs to a different model, prompt, or account. Start a new request.",
      ASSISTED_KEY_REJECTED: "OpenRouter rejected your personal key. Check it in Settings.",
      ASSISTED_MODEL_REJECTED: "OpenRouter rejected this model or request. Choose a tool-capable model and check the prompt.",
      ASSISTED_CONNECTION_UNAVAILABLE: "Select a ready account in this workspace again.",
      ASSISTED_NO_TOOLS: "No bounded tools are available for this account.",
      ASSISTED_MODEL_UNAVAILABLE: "OpenRouter did not complete the request. Check the key and model, then retry.",
      ASSISTED_MODEL_RESPONSE_INVALID: "The selected model returned an unusable answer. Choose another tool-capable model.",
      ASSISTED_MODEL_RESPONSE_TOO_LARGE: "The model response exceeded this test's limit.",
      ASSISTED_MULTIPLE_TOOLS: "The model selected more than one tool. No tool ran.",
      ASSISTED_TOOL_DENIED: "The model selected an unavailable tool. No tool ran.",
      ASSISTED_ARGUMENTS_INVALID: "The model returned invalid or oversized tool arguments. No tool ran.",
      ASSISTED_TIMEOUT: "The model request timed out. Check receipts before retrying.",
    };
    return [error.message, advice[error.code], error.receiptId && `Receipt: ${error.receiptId}`]
      .filter(Boolean).join(" ");
  }
  return error instanceof Error ? error.message : "The request failed. Try again.";
}

export class PlaygroundRequestError extends Error {
  /** Preserve the API code and receipt so the page can guide recovery. */
  constructor(readonly code: string, message: string, readonly receiptId?: string,
    readonly usage?: AssistedPlaygroundResult["usage"], readonly model?: string) {
    super(message); this.name = "PlaygroundRequestError";
  }
}

/** Use the same-origin APIs and retain receipt IDs on failed requests. */
export function createPlaygroundRequest(fetchImpl: typeof fetch, login: () => void) {
  /** Send one authenticated same-origin request and surface structured API failures. */
  return async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetchImpl(path, { credentials: "same-origin", cache: "no-store",
      ...(signal ? { signal } : {}),
      ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body) }) });
    const value = await response.json().catch(() => ({})) as T & { error?: string; message?: string;
      receiptId?: string; usage?: AssistedPlaygroundResult["usage"]; model?: string };
    if (response.status === 401 && !value.error?.endsWith("RECONNECT_REQUIRED")) login();
    if (!response.ok) throw new PlaygroundRequestError(value.error ?? "HTTP_ERROR",
      value.message ?? value.error ?? `Request failed (${response.status})`, value.receiptId,
      value.usage, value.model);
    return value;
  };
}
