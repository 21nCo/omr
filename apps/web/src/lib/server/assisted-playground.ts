import type { ToolManifest } from "@oh-my-router/tools";

export const ASSISTED_LIMITS = {
  promptChars: 2000, modelChars: 100, tools: 12, schemaChars: 12000,
  argumentsChars: 4096, resultChars: 8000, responseBytes: 32768,
  outputTokens: 384, turnMs: 35000,
} as const;

export class AssistedPlaygroundError extends Error {
  constructor(readonly code: string, readonly status: number,
    readonly usage?: Usage, readonly model?: string) {
    super(code);
    this.name = "AssistedPlaygroundError";
  }
}

type Usage = { promptTokens: number | null; completionTokens: number | null;
  totalTokens: number | null; costUsd: number | null };
type ModelReply = { content: string | null; calls: { name: string; arguments: string }[];
  usage: Usage; model: string };
type TurnOutcome = { kind: "pending" } | { kind: "action"; effect: "read" | "write"; toolId: string;
  servedModel: string; usage: Usage; sensitiveKeys?: string[] } | { kind: "model";
  response: { status: "answered" | "model_error"; answer: string; model: string;
    servedModels: string[]; usage: Usage; errorCode?: string } };
type TurnBinding = { requestFingerprint: string; outcome: TurnOutcome;
  action?: { connectionId: string; params: Record<string, unknown> } };
type Selection = { id: string; workspaceId: string; provider: string; selected: boolean;
  status: string; readiness: string; providerState?: string; selectable?: boolean;
  cleanupOnly?: boolean };
type OfferedTool = { manifest: ToolManifest; name: string; tool: unknown };

export interface AssistedPlaygroundServices {
  enabled(): boolean;
  authenticate(request: Request): Promise<string>;
  fingerprint(input: AssistedTurnInput, prompt: string): Promise<string>;
  reserveTurn(userId: string): Promise<() => Promise<void>>;
  /** Reserve a slot for a saved action without charging another model turn. */
  reserveRecovery(userId: string): Promise<() => Promise<void>>;
  /** Atomically fence a request identity before any paid model dispatch. */
  claimTurn(userId: string, input: { workspaceId: string; requestId: string;
    requestFingerprint: string }): Promise<{ binding: TurnBinding; created: boolean }>;
  /** Remove only an unstarted pending claim owned by this request. */
  abandonTurn(userId: string, input: { workspaceId: string; requestId: string;
    requestFingerprint: string }): Promise<void>;
  withKey<T>(userId: string, callback: (key: string) => Promise<T>): Promise<T>;
  connections(request: Request, workspaceId: string): Promise<Selection[]>;
  discover(request: Request, workspaceId: string, provider: string): Promise<ToolManifest[]>;
  execute(request: Request, input: { workspaceId: string; connectionId: string;
    toolId: string; params: Record<string, unknown>; idempotencyKey: string }): Promise<unknown>;
  readReceipt(request: Request, input: { workspaceId: string; connectionId: string;
    toolId: string; params: Record<string, unknown>; idempotencyKey: string;
    receiptId: string }): Promise<unknown>;
  requestApproval(request: Request, input: { workspaceId: string; connectionId: string;
    toolId: string; params: Record<string, unknown>; idempotencyKey: string }): Promise<unknown>;
  lookupAction(request: Request, input: { workspaceId: string; requestId: string }): Promise<{
    approval: { id: string; status: string } | null;
    receipt: { id: string; status: string } | null }>;
  loadTurn(request: Request, input: { workspaceId: string; requestId: string }): Promise<TurnBinding | null>;
  bindTurn(userId: string, input: { workspaceId: string; requestId: string;
    requestFingerprint: string; outcome: TurnOutcome; action?: NonNullable<TurnBinding["action"]> }):
    Promise<{ binding: TurnBinding; created: boolean }>;
  /** Keep a started action and quota settlement alive after a Worker response. */
  retainAction?(settlement: Promise<void>): void;
  /** Fail before dispatch when the Worker cannot retain a started action. */
  assertActionRetention?(): void;
  fetcher?: typeof fetch;
  /** Internal test seam; production always uses the fixed maximum. */
  turnMs?: number;
}

export interface AssistedTurnInput {
  workspaceId: string; connectionId: string; model: string; prompt: string; requestId: string;
}

export async function assistedActionStatus(request: Request, input: {
  workspaceId: string; requestId: string }, services: AssistedPlaygroundServices) {
  if (!services.enabled()) throw new AssistedPlaygroundError("ASSISTED_DISABLED", 404);
  if (request.headers.has("authorization")) throw new AssistedPlaygroundError("ASSISTED_ORIGIN_DENIED", 403);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId))
    throw new AssistedPlaygroundError("ASSISTED_REQUEST_ID_INVALID", 400);
  await services.authenticate(request);
  return services.lookupAction(request, input);
}

/** Explicit read-only access to the full receipt through current execution policy. */
export async function assistedFullReadReceipt(request: Request, input: {
  workspaceId: string; requestId: string; receiptId: string },
  services: AssistedPlaygroundServices) {
  if (!services.enabled()) throw new AssistedPlaygroundError("ASSISTED_DISABLED", 404);
  if (request.headers.has("authorization")) throw new AssistedPlaygroundError("ASSISTED_ORIGIN_DENIED", 403);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.receiptId) || !input.workspaceId)
    throw new AssistedPlaygroundError("ASSISTED_REQUEST_ID_INVALID", 400);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(ASSISTED_LIMITS.turnMs)]);
  await untilAbort(services.authenticate(request), signal);
  const binding = await untilAbort(services.loadTurn(request, input), signal);
  if (binding?.outcome.kind !== "action" || binding.outcome.effect !== "read" || !binding.action)
    throw new AssistedPlaygroundError("ASSISTED_RECEIPT_UNAVAILABLE", 404);
  const action = await untilAbort(services.lookupAction(request, input), signal);
  if (action.receipt?.id !== input.receiptId ||
      !["succeeded", "failed"].includes(action.receipt.status))
    throw new AssistedPlaygroundError("ASSISTED_RECEIPT_UNAVAILABLE", 404);
  const receipt = await untilAbort(services.readReceipt(request, {
    workspaceId: input.workspaceId, connectionId: binding.action.connectionId,
    toolId: binding.outcome.toolId, params: binding.action.params,
    idempotencyKey: `assisted_${input.requestId}`, receiptId: input.receiptId,
  }), signal);
  const record = object(receipt);
  if (record?.id !== input.receiptId || record.status !== action.receipt.status)
    throw new AssistedPlaygroundError("ASSISTED_RECEIPT_UNAVAILABLE", 404);
  return receipt;
}

/** Return a public code and receipt identity without echoing provider errors. */
function actionFailure(error: unknown) {
  const record = object(error);
  const code = typeof record?.code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(record.code)
    ? record.code : "ASSISTED_TOOL_FAILED";
  const receiptId = typeof record?.receiptId === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(record.receiptId) ? record.receiptId : undefined;
  return { status: "tool_error" as const,
    answer: "The tool could not complete. Check the account and receipt before retrying.",
    errorCode: code, ...(receiptId ? { receiptId } : {}) };
}
/** Preserve only finite usage and cost values supplied by the model. */
function finiteNonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
/** Narrow untrusted JSON values to records without arrays. */
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
/** Distinguish the turn deadline from an explicit browser cancellation. */
function abortFailure(signal: AbortSignal): AssistedPlaygroundError {
  return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
    ? new AssistedPlaygroundError("ASSISTED_TIMEOUT", 504)
    : new AssistedPlaygroundError("ASSISTED_CANCELLED", 499);
}
/** Stop before any new model or tool dispatch after cancellation. */
function checkActive(signal: AbortSignal): void {
  if (signal.aborted) throw abortFailure(signal);
}

/** Bound awaits even when an underlying database or policy call ignores cancellation. */
function untilAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortFailure(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(abortFailure(signal)); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then((value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

const unavailableUsage: Usage = { promptTokens: null, completionTokens: null,
  totalTokens: null, costUsd: null };

type ActionOutcome = Extract<TurnOutcome, { kind: "action" }>;
type TurnLease = { track: (operation: Promise<unknown>, outcome: ActionOutcome) => void };
type RecoveredCommon = { model: string; servedModels: string[]; usage: Usage;
  usageIncomplete: boolean; requestId: string; toolId?: string };
type RecoveryContext = { request: Request; input: AssistedTurnInput;
  services: AssistedPlaygroundServices; signal: AbortSignal; common: RecoveredCommon;
  heldLease?: TurnLease; userId: string };
type ClaimedContext = { request: Request; input: AssistedTurnInput;
  services: AssistedPlaygroundServices; signal: AbortSignal; userId: string;
  fingerprint: string; prompt: string; onModelStart: () => void };

/** Release a claim that arrives after the request has already ended. */
async function releaseLateReservation(reservation: Promise<() => Promise<void>>): Promise<void> {
  try {
    const release = await reservation;
    await release();
  } catch { /* A failed cleanup must not replace the request outcome. */ }
}

/** Render a saved read's terminal state without admitting raw provider text. */
function recoveredReadActionResult(common: RecoveredCommon, receipt: unknown,
  sensitiveKeys: readonly string[] | undefined) {
  const status = object(receipt)?.status;
  const projected = projectReadReceipt(receipt, sensitiveKeys);
  if (status === "succeeded") return { ...common, status: "answered" as const,
    receipt: projected,
    answer: "The selected read completed. Review its receipt; final answer generation was interrupted." };
  if (status === "failed") return { ...common, status: "tool_error" as const,
    terminalFailure: true, receipt: projected,
    answer: "The selected read did not complete. Review its receipt before another action." };
  return { ...common, status: "action_pending" as const, receipt: projected,
    answer: "The selected read is still pending. Check its receipt before another action." };
}

/** Resume the saved action under its original key, retaining any new settlement. */
async function recoverUnstartedAction(context: RecoveryContext, binding: TurnBinding) {
  const { request, input, services, signal, heldLease, common, userId } = context;
  const outcome = binding.outcome;
  if (outcome.kind !== "action" || !binding.action)
    throw new AssistedPlaygroundError("ASSISTED_REQUEST_CONFLICT", 409);
  let release: (() => Promise<void>) | undefined;
  if (!heldLease) {
    const reservation = services.reserveRecovery(userId);
    try { release = await untilAbort(reservation, signal); }
    catch (error) {
      void releaseLateReservation(reservation);
      if (error instanceof AssistedPlaygroundError && error.status === 429)
        return { ...common, status: "action_pending" as const,
          answer: "Another action is settling. Check this request again before retrying." };
      throw error;
    }
  }
  let started = false;
  const track = (operation: Promise<unknown>) => {
    started = true;
    if (heldLease) heldLease.track(operation, outcome);
    else retainActionSettlement(services, operation, release!);
  };
  const original = { workspaceId: input.workspaceId, connectionId: binding.action.connectionId,
    toolId: outcome.toolId, params: binding.action.params,
    idempotencyKey: `assisted_${input.requestId}` };
  try {
    checkActive(signal);
    services.assertActionRetention?.();
    if (outcome.effect === "write") {
      const operation = services.requestApproval(request, original);
      track(operation);
      const approval = await untilAbort(operation, signal);
      return { ...common, status: "approval_required" as const, approval,
        answer: "Review the recovered approval before executing. No change has run." };
    }
    const operation = services.execute(request, original);
    track(operation);
    const receipt = await untilAbort(operation, signal);
    return recoveredReadActionResult(common, receipt, outcome.sensitiveKeys);
  } catch (error) {
    if (signal.aborted) return { ...common, status: "action_pending" as const,
      answer: "The selected action may still be finishing. Check its receipt or approval." };
    return { ...common, ...actionFailure(error) };
  } finally {
    if (!started && release) await release().catch(() => undefined);
  }
}

/** A saved write receipt is evidence to inspect, never a new approval. */
function renderStoredWrite(common: RecoveredCommon, receipt: { id: string; status: string }) {
  const { id, status } = receipt;
  if (status === "succeeded") return { ...common, status: "answered" as const,
    terminalWrite: true, receiptId: id,
    answer: `The previous write completed. Review receipt ${id} before starting another action.` };
  if (status === "failed") return { ...common, status: "tool_error" as const,
    terminalWrite: true, receiptId: id,
    answer: `The previous write failed. Review receipt ${id} and verify the provider outcome before starting another action.` };
  return { ...common, status: "action_pending" as const, receiptId: id,
    answer: `The previous write receipt ${id} is ${status}. Verify its outcome before another action.` };
}

/** Render an existing approval or receipt without starting another action. */
async function renderStoredAction(request: Request, input: AssistedTurnInput,
  services: AssistedPlaygroundServices, signal: AbortSignal,
  binding: TurnBinding | undefined, common: RecoveredCommon,
  action: Awaited<ReturnType<AssistedPlaygroundServices["lookupAction"]>>) {
  const outcome = binding?.outcome;
  if (action.approval) return { ...common, status: "action_pending" as const,
    answer: `The previous approval ${action.approval.id} is ${action.approval.status}. Review its status before another action.` };
  if (action.receipt && outcome?.kind === "action" && outcome.effect === "write")
    return renderStoredWrite(common, action.receipt);
  if (action.receipt && outcome?.kind !== "action") return { ...common,
    status: "action_pending" as const, receiptId: action.receipt.id,
    answer: `The previous action receipt ${action.receipt.id} is ${action.receipt.status}. Its saved kind is unavailable; review the receipt before another action.` };
  if (action.receipt?.status === "succeeded") return { ...common,
    ...await recoverReadResult(request, input, services, signal, binding, action.receipt.id) };
  if (action.receipt?.status === "failed") return { ...common,
    status: "tool_error" as const, receiptId: action.receipt.id, terminalFailure: true,
    answer: `The previous read failed. Review receipt ${action.receipt.id} before another action.` };
  if (action.receipt) return { ...common, status: "action_pending" as const,
    receiptId: action.receipt.id,
    answer: `The previous read receipt ${action.receipt.id} is ${action.receipt.status}. Check it before another action.` };
  return { ...common, status: "action_pending" as const,
    answer: "The previous action may still be starting. Check its receipt or approval before retrying." };
}

/** Recover a persisted selection before considering another paid model choice. */
async function recoverTurn(request: Request, input: AssistedTurnInput,
  services: AssistedPlaygroundServices, signal: AbortSignal,
  binding?: TurnBinding, heldLease?: TurnLease, userId?: string) {
  const outcome = binding?.outcome;
  if (outcome?.kind === "model") return outcome.response;
  if (outcome?.kind === "pending") return { status: "action_pending" as const,
    answer: "The model choice is still pending or its outcome is uncertain. Check this request again; no action will be repeated.",
    model: input.model, servedModels: [], usage: unavailableUsage,
    usageIncomplete: true, requestId: input.requestId };
  const action = await untilAbort(services.lookupAction(request, input), signal);
  const common = { model: input.model,
    servedModels: outcome?.kind === "action" ? [outcome.servedModel] : [],
    usage: outcome?.kind === "action" ? outcome.usage : unavailableUsage,
    usageIncomplete: outcome?.kind !== "action" || outcome.effect === "read",
    requestId: input.requestId, ...(outcome?.kind === "action" ? { toolId: outcome.toolId } : {}) };
  if (!action.approval && !action.receipt && outcome?.kind === "action" && binding?.action)
    return recoverUnstartedAction({ request, input, services, signal, heldLease,
      common, userId: userId! }, binding);
  return renderStoredAction(request, input, services, signal, binding, common, action);
}

/** Register completion before the response can be sent, including quota release. */
async function settleAction(operation: Promise<unknown>, release: () => Promise<void>) {
  try { await operation; } catch { /* The request path reports the action failure. */ }
  await release();
}

function retainActionSettlement(services: AssistedPlaygroundServices,
  operation: Promise<unknown>, release: () => Promise<void>): void {
  const settlement = settleAction(operation, release);
  services.retainAction?.(settlement);
  settlement.catch(() => undefined);
}

/** Replay a committed read through current authorization and the saved action key. */
async function recoverReadResult(request: Request, input: AssistedTurnInput,
  services: AssistedPlaygroundServices, signal: AbortSignal,
  binding: TurnBinding | undefined, expectedReceiptId: string) {
  if (binding?.outcome.kind !== "action" || binding.outcome.effect !== "read" ||
      !binding.action) {
    return { status: "action_pending" as const,
      answer: "The read completed, but its result is unavailable here. Open its receipt." };
  }
  try {
    const operation = services.execute(request, {
      workspaceId: input.workspaceId, connectionId: binding.action.connectionId,
      toolId: binding.outcome.toolId, params: binding.action.params,
      idempotencyKey: `assisted_${input.requestId}`,
    });
    services.retainAction?.(operation.then(() => undefined, () => undefined));
    const receipt = await untilAbort(operation, signal);
    const record = object(receipt);
    if (record?.status !== "succeeded" || record.id !== expectedReceiptId)
      return { status: "tool_error" as const, receiptId: expectedReceiptId,
        answer: "The read could not be recovered. Check its receipt." };
    return { status: "answered" as const, receipt: projectReadReceipt(receipt,
      binding.outcome.sensitiveKeys), receiptId: record.id,
      answer: "The read completed. Review its bounded receipt preview or download the full receipt." };
  } catch (error) {
    if (signal.aborted) return { status: "action_pending" as const,
      answer: "The read receipt is being recovered. Retry this request shortly." };
    return actionFailure(error);
  }
}

/** Read a bounded upstream body, including error responses, without logging provider content. */
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new AssistedPlaygroundError("ASSISTED_MODEL_UNAVAILABLE", 502);
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = false;
  let cancellation: Promise<void> | undefined;
  const cancel = () => { cancellation ??= reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      checkActive(signal);
      // A ReadableStream reader permits one pending read at a time; each chunk
      // must be measured before requesting the next one.
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > ASSISTED_LIMITS.responseBytes) break;
      chunks.push(part.value);
    }
    complete = length <= ASSISTED_LIMITS.responseBytes;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) { cancel(); await cancellation; }
    reader.releaseLock();
  }
  checkActive(signal);
  if (length > ASSISTED_LIMITS.responseBytes)
    throw new AssistedPlaygroundError("ASSISTED_MODEL_RESPONSE_TOO_LARGE", 502);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new AssistedPlaygroundError("ASSISTED_MODEL_RESPONSE_INVALID", 502); }
}

/** Keep provider HTTP diagnostics out of the browser while retaining usage. */
function rejectedModel(response: Response, usage: Usage, model: string): never {
  let code = "ASSISTED_MODEL_UNAVAILABLE";
  if (response.status === 401 || response.status === 403) code = "ASSISTED_KEY_REJECTED";
  else if ([400, 404, 422].includes(response.status)) code = "ASSISTED_MODEL_REJECTED";
  throw new AssistedPlaygroundError(code, response.status < 500 ? 422 : 502, usage, model);
}

/** Validate the one bounded tool choice returned by OpenRouter. */
function parseModelReply(data: Record<string, unknown> | null, model: string,
  reported: Usage): ModelReply {
  const choice = Array.isArray(data?.choices) ? object(data.choices[0]) : null;
  const message = object(choice?.message);
  if (!message || choice?.finish_reason === "length")
    throw new AssistedPlaygroundError("ASSISTED_MODEL_RESPONSE_INVALID", 502, reported, model);
  const rawCalls = message.tool_calls;
  const calls = Array.isArray(rawCalls) ? rawCalls.map((call) => {
    const fn = object(object(call)?.function);
    return { name: fn?.name, arguments: fn?.arguments };
  }) : [];
  if (calls.some((call) => typeof call.name !== "string" || typeof call.arguments !== "string"))
    throw new AssistedPlaygroundError("ASSISTED_MODEL_RESPONSE_INVALID", 502, reported, model);
  return { content: typeof message.content === "string" ? message.content : null,
    calls: calls as ModelReply["calls"], model: typeof data?.model === "string" ? data.model : model,
    usage: reported };
}

/** Make one bounded OpenRouter choice using the requesting user's vault key. */
async function modelCall(fetcher: typeof fetch, key: string, model: string,
  messages: unknown[], tools: unknown[] | undefined, signal: AbortSignal): Promise<ModelReply> {
  let response: Response;
  try {
    response = await untilAbort(fetcher("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false,
        max_tokens: ASSISTED_LIMITS.outputTokens, usage: { include: true },
        ...(tools ? { tools, tool_choice: "auto", parallel_tool_calls: false } : { tool_choice: "none" }) }),
      signal,
    }), signal);
  } catch {
    checkActive(signal);
    throw new AssistedPlaygroundError("ASSISTED_MODEL_UNAVAILABLE", 502);
  }
  let data: Record<string, unknown> | null;
  try { data = object(await untilAbort(boundedJson(response, signal), signal)); }
  catch (error) {
    if (response.ok) throw error;
    checkActive(signal);
    rejectedModel(response, unavailableUsage, model);
  }
  const usage = object(data?.usage);
  const reported: Usage = { promptTokens: finiteNonnegative(usage?.prompt_tokens),
    completionTokens: finiteNonnegative(usage?.completion_tokens),
    totalTokens: finiteNonnegative(usage?.total_tokens),
    costUsd: finiteNonnegative(usage?.cost) };
  if (!response.ok) rejectedModel(response, reported, model);
  return parseModelReply(data, model, reported);
}

/** Only a small, plain-text projection of an untrusted result may enter the answer. */
const withheldResult = "[WITHHELD_UNSAFE_TOOL_RESULT]";
const sensitiveOutputKey = /token|secret|password|key|authorization|credential|private|passphrase|cookie|session|verification|passcode|code|pin|otp/i;
const sensitiveChallengeKey = /security|recovery|backup|challenge|response|answer|memorable|maiden|question|hint/i;
// Provider object keys are untrusted content too. Only fixed, ordinary field
// labels enter a preview; unknown labels and their values are not interpretable.
const previewFieldNames = new Set(["pages", "content", "text", "title", "body",
  "description", "metadata", "note", "slack", "notion", "github", "summary",
  "name", "message", "status", "id", "items", "results"]);
// Admit only public sentence shapes whose entire content is fixed by this policy.
// Unknown prose and values remain available through the separately authorized receipt.
const previewLabels = new Set(["Public summary", "public metadata", "Safe title",
  "Review complete", "Review FAQ for details"]);
const publicStatus = /^(?:Release|Roadmap|The milestone)(?: (?:19|20)\d{2})? (?:is|are) (?:ready|complete|completed|available|published|updated)$/u;
const readableUpdate = /^(?:(?:A )?readable update\s*)+$/i;

/** Admit only complete, fixed public phrases from an untrusted provider result. */
function safeProse(value: string): boolean {
  if (value.length > 512) return false;
  const phrase = value.trim().replace(/[.!?]$/u, "");
  return previewLabels.has(phrase) || publicStatus.test(phrase) ||
    readableUpdate.test(phrase);
}
type PreviewState = { sensitive: Set<string | undefined>; unsafeContent: boolean;
  truncated: boolean; visited: number; textCharsLeft: number };

/** Project an array under the shared tree budget. */
function previewArray(items: unknown[], depth: number, state: PreviewState): unknown[] {
  const result: unknown[] = [];
  for (let index = 0; index < items.length && index < 40; index += 1) {
    if (state.truncated) break;
    result.push(previewValue(items[index], depth + 1, state));
  }
  if (items.length > result.length) state.truncated = true;
  return result;
}

/** Unknown provider keys and their values never become preview labels. */
function previewRecord(record: Record<string, unknown>, depth: number,
  state: PreviewState): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  let index = 0;
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    if (index >= 80 || state.truncated) { state.truncated = true; break; }
    const labelKnown = previewFieldNames.has(key);
    const admitted = labelKnown && !sensitiveOutputKey.test(key) &&
      !sensitiveChallengeKey.test(key) &&
      !state.sensitive.has(key.toLowerCase());
    result[labelKnown ? key : `field_${index + 1}`] = admitted
      ? previewValue(record[key], depth + 1, state) : "[REDACTED]";
    index += 1;
  }
  return result;
}

/** One traversal budget is shared by all nested result branches. */
function previewValue(item: unknown, depth: number, state: PreviewState): unknown {
  if (depth > 8 || state.visited >= 160) { state.truncated = true; return "[TRUNCATED]"; }
  state.visited += 1;
  if (typeof item === "string") {
    if (!safeProse(item)) { state.unsafeContent = true; return "[REDACTED]"; }
    if (item.length > state.textCharsLeft) { state.truncated = true; return "[TRUNCATED]"; }
    state.textCharsLeft -= item.length;
    return item;
  }
  if (typeof item === "number" || typeof item === "bigint") {
    state.unsafeContent = true;
    return "[REDACTED]";
  }
  if (Array.isArray(item)) return previewArray(item, depth, state);
  const record = object(item);
  return record ? previewRecord(record, depth, state) : item;
}

/** Only a bounded projection of fixed public phrases may enter assisted answers. */
export function safeResult(value: unknown, inputSensitiveKeys: readonly string[]): string {
  const state: PreviewState = { sensitive: new Set(inputSensitiveKeys.map((key) =>
    key.replaceAll("[", ".").replaceAll("]", ".").split(".").findLast(Boolean)?.toLowerCase())),
    unsafeContent: false, truncated: false, visited: 0, textCharsLeft: 6000 };
  const encoded = JSON.stringify(previewValue(value, 0, state)) ?? "null";
  if (state.unsafeContent) return withheldResult;
  const marker = "\n[TRUNCATED]";
  return !state.truncated && encoded.length <= ASSISTED_LIMITS.resultChars ? encoded
    : `${encoded.slice(0, ASSISTED_LIMITS.resultChars - marker.length)}${marker}`;
}

/** The assisted response carries a bounded preview and receipt identity only. */
function projectReadReceipt(receipt: unknown, sensitiveKeys?: readonly string[]) {
  const record = object(receipt);
  if (!record) return null;
  if (typeof record.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(record.id) ||
      !["reserved", "running", "succeeded", "failed", "uncertain"].includes(String(record.status)))
    throw new AssistedPlaygroundError("ASSISTED_RECEIPT_INVALID", 502);
  // Old bindings have no manifest sensitivity snapshot: never guess from result keys.
  const preview = Array.isArray(sensitiveKeys) && sensitiveKeys.every((key) => typeof key === "string")
    ? safeResult(record.result, sensitiveKeys) : withheldResult;
  return { id: record.id, status: record.status,
    errorCode: typeof record.errorCode === "string" ? record.errorCode.slice(0, 80) : null,
    result: preview === withheldResult ? null : preview,
    resultWithheld: preview === withheldResult,
    resultTruncated: preview.endsWith("\n[TRUNCATED]"),
  };
}

/** Bound the provider schema before it reaches the one model choice. */
function offerTools(discovered: ToolManifest[], provider: string): OfferedTool[] {
  const offered: OfferedTool[] = [];
  let schemaLength = 0;
  for (const manifest of discovered) {
    if (manifest.provider !== provider || offered.length >= ASSISTED_LIMITS.tools) continue;
    const name = `tool_${offered.length}`;
    const tool = { type: "function", function: { name,
      description: `${manifest.displayName}: ${manifest.description}`.slice(0, 300),
      parameters: manifest.inputSchema } };
    const size = JSON.stringify(tool).length;
    if (size > 3000 || schemaLength + size > ASSISTED_LIMITS.schemaChars) continue;
    schemaLength += size;
    offered.push({ manifest, name, tool });
  }
  if (!offered.length) throw new AssistedPlaygroundError("ASSISTED_NO_TOOLS", 409);
  return offered;
}

type ModelResponse = Extract<TurnOutcome, { kind: "model" }>["response"];
type InterpretedChoice = { kind: "model"; response: ModelResponse } | {
  kind: "action"; chosen: OfferedTool; params: Record<string, unknown>;
  effect: "read" | "write" };

/** Reject invented tools and malformed arguments before binding an action. */
function interpretChoice(choice: ModelReply, offered: OfferedTool[], model: string): InterpretedChoice {
  const modelError = (code: string): InterpretedChoice => ({ kind: "model", response: {
    status: "model_error", answer: "The model did not select one valid offered action. No tool ran.",
    errorCode: code, model, servedModels: [choice.model], usage: choice.usage } });
  if (choice.calls.length === 0) return { kind: "model", response: choice.content
    ? { status: "answered", answer: choice.content.slice(0, 2000), model,
      servedModels: [choice.model], usage: choice.usage }
    : { status: "model_error", answer: "The model returned no usable answer. Choose another tool-capable model.",
      errorCode: "ASSISTED_MODEL_RESPONSE_INVALID", model,
      servedModels: [choice.model], usage: choice.usage } };
  if (choice.calls.length !== 1) return modelError("ASSISTED_MULTIPLE_TOOLS");
  const chosen = offered.find((item) => item.name === choice.calls[0]!.name);
  if (!chosen) return modelError("ASSISTED_TOOL_DENIED");
  const raw = choice.calls[0]!.arguments;
  if (raw.length > ASSISTED_LIMITS.argumentsChars) return modelError("ASSISTED_ARGUMENTS_INVALID");
  let params: unknown;
  try { params = JSON.parse(raw); }
  catch { return modelError("ASSISTED_ARGUMENTS_INVALID"); }
  const parsed = object(params);
  if (!parsed) return modelError("ASSISTED_ARGUMENTS_INVALID");
  return { kind: "action", chosen, params: parsed,
    effect: chosen.manifest.contract.effect === "read" ? "read" : "write" };
}

/** Present a read using only the bounded local preview and receipt identity. */
function presentFreshRead(receipt: unknown, chosen: OfferedTool, choice: ModelReply,
  input: AssistedTurnInput, signal: AbortSignal) {
  const record = object(receipt);
  const common = { toolId: chosen.manifest.id,
    receipt: projectReadReceipt(receipt, chosen.manifest.contract.sensitiveKeys),
    model: input.model, servedModels: [choice.model], usage: choice.usage };
  if (record?.status === "failed") return { ...common, status: "tool_error" as const,
    terminalFailure: true,
    answer: "The tool did not complete. Check its receipt before retrying." };
  if (record?.status !== "succeeded") return { ...common, status: "action_pending" as const,
    requestId: input.requestId,
    answer: "The read may still be finishing. Check its receipt before retrying this request." };
  if (signal.aborted) return { ...common, status: "answered" as const,
    usageIncomplete: true,
    answer: "The tool completed, but preview generation was interrupted. Review the receipt." };
  const result = safeResult(record.result, chosen.manifest.contract.sensitiveKeys);
  return { ...common, status: "answered" as const,
    answer: result === withheldResult
      ? "The tool completed, but its result could not be safely previewed. Review the receipt."
      : `The read completed. Result preview: ${result.slice(0, 1600)}. Review the receipt for the full result.` };
}

/** Validate the browser request before quota, vault, or model use. */
function assistedPrompt(request: Request, input: AssistedTurnInput,
  services: AssistedPlaygroundServices): string {
  if (!services.enabled()) throw new AssistedPlaygroundError("ASSISTED_DISABLED", 404);
  if (request.headers.get("origin") !== new URL(request.url).origin ||
      request.headers.has("authorization")) throw new AssistedPlaygroundError("ASSISTED_ORIGIN_DENIED", 403);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{2,99}$/.test(input.model))
    throw new AssistedPlaygroundError("ASSISTED_MODEL_INVALID", 400);
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > ASSISTED_LIMITS.promptChars || /sk-or-[a-z0-9-]+/i.test(prompt))
    throw new AssistedPlaygroundError("ASSISTED_PROMPT_INVALID", 400);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId))
    throw new AssistedPlaygroundError("ASSISTED_REQUEST_ID_INVALID", 400);
  return prompt;
}

/** One user turn: one model tool choice and one policy checked tool action. */
export async function runAssistedTurn(request: Request, input: AssistedTurnInput,
  services: AssistedPlaygroundServices) {
  const prompt = assistedPrompt(request, input, services);
  const deadlineMs = Math.max(1, Math.min(services.turnMs ?? ASSISTED_LIMITS.turnMs,
    ASSISTED_LIMITS.turnMs));
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(deadlineMs)]);
  const userId = await untilAbort(services.authenticate(request), signal);
  const fingerprint = await untilAbort(services.fingerprint(input, prompt), signal);
  const prior = await untilAbort(services.loadTurn(request, input), signal);
  if (prior) {
    if (prior.requestFingerprint !== fingerprint)
      throw new AssistedPlaygroundError("ASSISTED_REQUEST_CONFLICT", 409);
    return recoverTurn(request, input, services, signal, prior, undefined, userId);
  }
  // Existing receipts and approvals from an earlier deployment also fence this identity.
  const legacyAction = await untilAbort(services.lookupAction(request, input), signal);
  if (legacyAction.approval || legacyAction.receipt)
    return recoverTurn(request, input, services, signal, undefined, undefined, userId);
  checkActive(signal);
  const claimInput = { workspaceId: input.workspaceId, requestId: input.requestId,
    requestFingerprint: fingerprint };
  const claim = await services.claimTurn(userId, claimInput);
  if (claim.binding.requestFingerprint !== fingerprint)
    throw new AssistedPlaygroundError("ASSISTED_REQUEST_CONFLICT", 409);
  if (!claim.created) return recoverTurn(request, input, services, signal,
    claim.binding, undefined, userId);
  let modelStarted = false;
  try {
    checkActive(signal);
    return await runClaimedTurn({ request, input, services, signal, userId,
      fingerprint, prompt, onModelStart: () => { modelStarted = true; } });
  } finally {
    if (!modelStarted) await services.abandonTurn(userId, claimInput).catch(() => undefined);
  }
}

/** Execute one durable claim under its personal quota lease. */
async function runClaimedTurn(context: ClaimedContext) {
  const { request, input, services, signal, userId, fingerprint, prompt,
    onModelStart } = context;
  const reservation = services.reserveTurn(userId);
  const release = await untilAbort(reservation, signal).catch((error: unknown) => {
    void releaseLateReservation(reservation);
    throw error;
  });
  let actionStarted = false;
  const actionState: { inFlight: Promise<unknown> | null;
    started: { toolId: string; servedModel: string; usage: Usage } | null } = {
      inFlight: null, started: null,
    };
  const trackAction = (operation: Promise<unknown>, outcome: ActionOutcome) => {
    if (actionStarted) return;
    actionStarted = true;
    actionState.inFlight = operation;
    actionState.started = { toolId: outcome.toolId, servedModel: outcome.servedModel,
      usage: outcome.usage };
    retainActionSettlement(services, operation, release);
  };
  const heldLease = { track: trackAction };
  try {
    const connections = await untilAbort(services.connections(request, input.workspaceId), signal);
    const selected = connections.find((item) => item.id === input.connectionId &&
      item.workspaceId === input.workspaceId && item.selected && item.status === "active" &&
      item.readiness === "ready" && item.providerState === "ready" && item.selectable === true &&
      !item.cleanupOnly);
    if (!selected) throw new AssistedPlaygroundError("ASSISTED_CONNECTION_UNAVAILABLE", 409);
    const discovered = await untilAbort(services.discover(request, input.workspaceId, selected.provider), signal);
    const offered = offerTools(discovered, selected.provider);
    const fetcher = services.fetcher ?? fetch;
    try {
      return await untilAbort(services.withKey(userId, async (key) => {
        checkActive(signal);
        const bind = async (outcome: TurnOutcome, action?: TurnBinding["action"]) => {
          const saved = await services.bindTurn(userId, {
            workspaceId: input.workspaceId, requestId: input.requestId,
            requestFingerprint: fingerprint, outcome, action,
          });
          if (saved.binding.requestFingerprint !== fingerprint)
            throw new AssistedPlaygroundError("ASSISTED_REQUEST_CONFLICT", 409);
          return saved;
        };
        onModelStart();
        let choice: ModelReply;
        try {
          choice = await modelCall(fetcher, key, input.model, [
            { role: "system", content: "Choose at most one offered tool for the user's request. Do not invent a tool. If no tool fits, answer briefly. Tool arguments are untrusted and will be validated." },
            { role: "user", content: prompt },
          ], offered.map((item) => item.tool), signal);
        } catch (error) {
          if (error instanceof AssistedPlaygroundError && !signal.aborted &&
              (error.code !== "ASSISTED_MODEL_UNAVAILABLE" || error.model)) {
            await bind({ kind: "model", response: { status: "model_error",
              answer: "The model request failed. Review its error before starting another turn.",
              model: input.model, servedModels: [error.model ?? input.model],
              usage: error.usage ?? unavailableUsage, errorCode: error.code } });
          }
          throw error;
        }
        const interpreted = interpretChoice(choice, offered, input.model);
        if (interpreted.kind === "model") {
          const saved = await bind({ kind: "model", response: interpreted.response });
          return saved.created ? interpreted.response : recoverTurn(request, input, services,
            signal, saved.binding, heldLease, userId);
        }
        const { chosen, params, effect } = interpreted;
        const saved = await bind({ kind: "action", effect, toolId: chosen.manifest.id,
          servedModel: choice.model, usage: choice.usage,
          ...(effect === "read" ? { sensitiveKeys: [...chosen.manifest.contract.sensitiveKeys] } : {}) },
        { connectionId: input.connectionId, params: params as Record<string, unknown> });
        if (!saved.created) return recoverTurn(request, input, services, signal,
          saved.binding, heldLease, userId);
        checkActive(signal);
        services.assertActionRetention?.();
        const action = { workspaceId: input.workspaceId, connectionId: input.connectionId,
          toolId: chosen.manifest.id, params: params as Record<string, unknown>,
          idempotencyKey: `assisted_${input.requestId}` };
        const operation = effect === "read"
          ? services.execute(request, action) : services.requestApproval(request, action);
        trackAction(operation, saved.binding.outcome as ActionOutcome);
        let settled: unknown;
        try { settled = await untilAbort(operation, signal); }
        catch (error) {
          if (signal.aborted) return { status: "action_pending" as const,
            answer: effect === "read"
              ? "The read may still be finishing. Retry this request with its saved identity to recover its receipt."
              : "Approval creation may still be finishing. Check open approvals before retrying this request.",
            toolId: chosen.manifest.id, requestId: input.requestId,
            model: input.model, servedModels: [choice.model], usage: choice.usage };
          return { ...actionFailure(error), toolId: chosen.manifest.id,
            model: input.model, servedModels: [choice.model], usage: choice.usage };
        }
        if (effect !== "read") return { status: "approval_required" as const,
          answer: "Review the selected tool and redacted arguments before approving. No change has run.",
          toolId: chosen.manifest.id, approval: settled, model: input.model,
          servedModels: [choice.model], usage: choice.usage };
        return presentFreshRead(settled, chosen, choice, input, signal);
      }), signal);
    } catch (error) {
      if (signal.aborted) {
        if (actionState.started && actionState.inFlight) {
          return { status: "action_pending" as const,
            answer: "The selected action may still be finishing. Check its receipt or approval before retrying.",
            toolId: actionState.started.toolId, requestId: input.requestId,
            model: input.model, servedModels: [actionState.started.servedModel],
            usage: actionState.started.usage, usageIncomplete: true };
        }
        throw abortFailure(signal);
      }
      throw error;
    }
  } finally {
    if (!actionStarted) await untilAbort(release(), signal).catch(() => undefined);
  }
}
