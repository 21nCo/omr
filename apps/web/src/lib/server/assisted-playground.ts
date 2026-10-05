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
type TurnOutcome = { kind: "action"; effect: "read" | "write"; toolId: string;
  servedModel: string; usage: Usage; sensitiveKeys?: string[] } | { kind: "model";
  response: { status: "answered" | "model_error"; answer: string; model: string;
    servedModels: string[]; usage: Usage; errorCode?: string } };
type TurnBinding = { requestFingerprint: string; outcome: TurnOutcome;
  action?: { connectionId: string; params: Record<string, unknown> } };
type Selection = { id: string; workspaceId: string; provider: string; selected: boolean;
  status: string; readiness: string; providerState?: string; selectable?: boolean;
  cleanupOnly?: boolean };

export interface AssistedPlaygroundServices {
  enabled(): boolean;
  authenticate(request: Request): Promise<string>;
  fingerprint(input: AssistedTurnInput, prompt: string): Promise<string>;
  reserveTurn(userId: string): Promise<() => Promise<void>>;
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
    requestFingerprint: string; outcome: TurnOutcome; action?: TurnBinding["action"] }):
    Promise<{ binding: TurnBinding; created: boolean }>;
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
function finiteNonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function abortFailure(signal: AbortSignal): AssistedPlaygroundError {
  return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
    ? new AssistedPlaygroundError("ASSISTED_TIMEOUT", 504)
    : new AssistedPlaygroundError("ASSISTED_CANCELLED", 499);
}
function checkActive(signal: AbortSignal): void {
  if (signal.aborted) throw abortFailure(signal);
}

/** Bound awaits even when an underlying database or policy call ignores cancellation. */
function untilAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortFailure(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortFailure(signal));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
      .catch(() => undefined);
  });
}

const unavailableUsage: Usage = { promptTokens: null, completionTokens: null,
  totalTokens: null, costUsd: null };

async function recoverTurn(request: Request, input: AssistedTurnInput,
  services: AssistedPlaygroundServices, signal: AbortSignal,
  binding?: TurnBinding, userId?: string) {
  const outcome = binding?.outcome;
  if (outcome?.kind === "model") return outcome.response;
  const action = await untilAbort(services.lookupAction(request, input), signal);
  const usage = outcome?.kind === "action" ? outcome.usage : unavailableUsage;
  const servedModels = outcome?.kind === "action" ? [outcome.servedModel] : [];
  const common = { model: input.model, servedModels, usage,
    usageIncomplete: outcome?.kind !== "action" || outcome.effect === "read",
    requestId: input.requestId, ...(outcome?.kind === "action" ? { toolId: outcome.toolId } : {}) };
  if (!action.approval && !action.receipt && outcome?.kind === "action" && binding?.action) {
    if (!userId) throw new AssistedPlaygroundError("ASSISTED_REQUEST_CONFLICT", 409);
    const reservation = services.reserveTurn(userId);
    const release = await untilAbort(reservation, signal).catch((error: unknown) => {
      reservation.then((lateRelease) => lateRelease()).catch(() => undefined);
      throw error;
    });
    let actionPending = false;
    const original = { workspaceId: input.workspaceId, connectionId: binding.action.connectionId,
      toolId: outcome.toolId, params: binding.action.params,
      idempotencyKey: `assisted_${input.requestId}` };
    try {
      checkActive(signal);
      if (outcome.effect === "write") {
        const operation = services.requestApproval(request, original);
        let approval: unknown;
        try { approval = await untilAbort(operation, signal); }
        catch (error) {
          if (!signal.aborted) throw error;
          actionPending = true;
          operation.then(() => release(), () => release()).catch(() => undefined);
          throw error;
        }
        return { ...common, status: "approval_required" as const, approval,
          answer: "Review the recovered approval before executing. No change has run." };
      }
      const operation = services.execute(request, original);
      let receipt: unknown;
      try { receipt = await untilAbort(operation, signal); }
      catch (error) {
        if (!signal.aborted) throw error;
        actionPending = true;
        operation.then(() => release(), () => release()).catch(() => undefined);
        throw error;
      }
      const succeeded = object(receipt)?.status === "succeeded";
      const failed = object(receipt)?.status === "failed";
      return { ...common, status: succeeded ? "answered" as const
        : failed ? "tool_error" as const : "action_pending" as const,
        ...(failed ? { terminalFailure: true } : {}), receipt: projectReadReceipt(receipt,
          outcome.sensitiveKeys), answer: succeeded
          ? "The selected read completed. Review its receipt; final answer generation was interrupted."
          : failed ? "The selected read did not complete. Review its receipt before another action."
            : "The selected read is still pending. Check its receipt before another action." };
    } catch (error) {
      if (signal.aborted) return { ...common, status: "action_pending" as const,
        answer: "The selected action may still be finishing. Check its receipt or approval." };
      return { ...common, ...actionFailure(error) };
    } finally {
      if (!actionPending) await untilAbort(release(), signal).catch(() => undefined);
    }
  }
  if (action.approval) return { ...common, status: "action_pending" as const,
    answer: `The previous approval ${action.approval.id} is ${action.approval.status}. Review its status before another action.` };
  if (action.receipt && outcome?.kind === "action" && outcome.effect === "write") {
    const { id, status } = action.receipt;
    if (status === "succeeded" || status === "failed") return { ...common,
      status: status === "succeeded" ? "answered" as const : "tool_error" as const,
      terminalWrite: true, receiptId: id,
      answer: status === "succeeded"
        ? `The previous write completed. Review receipt ${id} before starting another action.`
        : `The previous write failed. Review receipt ${id} and verify the provider outcome before starting another action.` };
    return { ...common, status: "action_pending" as const, receiptId: id,
      answer: `The previous write receipt ${id} is ${status}. Verify its outcome before another action.` };
  }
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
  try {
    while (true) {
      checkActive(signal);
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > ASSISTED_LIMITS.responseBytes) {
        await reader.cancel();
        throw new AssistedPlaygroundError("ASSISTED_MODEL_RESPONSE_TOO_LARGE", 502);
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new AssistedPlaygroundError("ASSISTED_MODEL_RESPONSE_INVALID", 502); }
}

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
  const data = object(await untilAbort(boundedJson(response, signal), signal));
  const usage = object(data?.usage);
  const reported: Usage = { promptTokens: finiteNonnegative(usage?.prompt_tokens),
    completionTokens: finiteNonnegative(usage?.completion_tokens),
    totalTokens: finiteNonnegative(usage?.total_tokens),
    costUsd: finiteNonnegative(usage?.cost) };
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? "ASSISTED_KEY_REJECTED"
      : [400, 404, 422].includes(response.status) ? "ASSISTED_MODEL_REJECTED"
        : "ASSISTED_MODEL_UNAVAILABLE";
    throw new AssistedPlaygroundError(code, response.status < 500 ? 422 : 502,
      reported, model);
  }
  const choice = Array.isArray(data?.choices) ? object(data.choices[0]) : null;
  const message = object(choice?.message);
  if (!message) throw new AssistedPlaygroundError("ASSISTED_MODEL_RESPONSE_INVALID", 502,
    reported, model);
  if (choice?.finish_reason === "length") {
    throw new AssistedPlaygroundError("ASSISTED_MODEL_RESPONSE_INVALID", 502, reported, model);
  }
  const rawCalls = message.tool_calls;
  const calls = Array.isArray(rawCalls) ? rawCalls.map((call) => {
    const fn = object(object(call)?.function);
    return { name: fn?.name, arguments: fn?.arguments };
  }) : [];
  if (calls.some((call) => typeof call.name !== "string" || typeof call.arguments !== "string")) {
    throw new AssistedPlaygroundError("ASSISTED_MODEL_RESPONSE_INVALID", 502, reported, model);
  }
  return { content: typeof message.content === "string" ? message.content : null,
    calls: calls as ModelReply["calls"], model: typeof data?.model === "string" ? data.model : model,
    usage: reported };
}

/** Only a small, plain-text projection of an untrusted result may enter the answer. */
const withheldResult = "[WITHHELD_UNSAFE_TOOL_RESULT]";
const sensitiveOutputKey = /(?:token|secret|password|key|authorization|credential|private|passphrase|cookie|session|verification|passcode|code|pin|otp)/i;
// Provider object keys are untrusted content too. Only fixed, ordinary field
// labels enter a preview; every other label gets a position-based replacement.
const previewFieldNames = new Set(["pages", "content", "text", "title", "body",
  "description", "metadata", "note", "slack", "notion", "github", "summary",
  "name", "message", "status", "id", "items", "results"]);
// Long credential markers are unsafe even when a provider glues them to other
// letters or digits (for example, "hunter2password" or "token4321"). Short,
// common words still need word boundaries to preserve ordinary prose.
const credentialMarker = /(?:password|passphrase|credential|authorization|bearer|cookie|session|private|secret|token)/i;
const sensitiveWord = /\b(?:api|access|refresh|client|auth|key|verification|verify|passcode|code|otp|pin|login|unlock)\b|\b(?:sign|log)\s+in\b/i;
// A mixed letter/number word can be a credential with no separator. Whole
// number words remain useful for years; longer runs can be one-time codes.
// Allow ordinary lowercase, initial-capital, or short uppercase words, but
// withhold mixed-case identifiers even when they contain only letters.
const plainWord = /^(?:\p{Lu}?\p{Ll}[\p{Ll}\p{M}]{0,18}|\p{Lu}{1,12}|\p{N}{1,4})$/u;
/**
 * Provider text can contain arbitrary serialized or encoded credentials. Do not try to
 * enumerate their formats: admit only short ordinary prose to the local preview.
 * No part of the tool result is sent to the model, even after this projection.
 */
function safeProse(value: string): boolean {
  if (value.length > 512 || credentialMarker.test(value) || sensitiveWord.test(value)) return false;
  const words = value.split(/[ \t\n.,!?;:'"()]+/u).filter(Boolean);
  // A long number inside a sentence can be a login code. Only a year with an
  // explicit temporal label is distinguishable enough for this small preview.
  const numericSafe = words.every((word, index) => !/^\p{N}{4,}$/u.test(word) ||
    (/^(?:19|20)\d{2}$/.test(word) &&
      /^(?:release|roadmap|year|in|during|since|for|by)$/i.test(words[index - 1] ?? "")));
  // A standalone number has no context to distinguish a year from a code.
  return words.length > 0 && !(words.length === 1 && /^\p{N}+$/u.test(words[0]!)) &&
    numericSafe && words.every((word) => plainWord.test(word)) &&
    !/[^\p{L}\p{M}\p{N} \t\n.,!?;:'"()]/u.test(value) &&
    !/[.]{2,}/u.test(value);
}
export function safeResult(value: unknown, inputSensitiveKeys: readonly string[]): string {
  const sensitive = new Set(inputSensitiveKeys.map((key) => key.split(/[.\[\]]/).filter(Boolean).at(-1)?.toLowerCase()));
  let unsafeContent = false;
  let truncated = false;
  let visited = 0;
  let textCharsLeft = 6000;
  // These shared budgets bound work across the whole tree, not once per level.
  // A provider can return very wide or deeply nested objects on any read path.
  const redact = (item: unknown, depth: number): unknown => {
    if (depth > 8 || visited >= 160) { truncated = true; return "[TRUNCATED]"; }
    visited += 1;
    if (typeof item === "string") {
      if (!safeProse(item)) { unsafeContent = true; return "[REDACTED]"; }
      if (item.length > textCharsLeft) { truncated = true; return "[TRUNCATED]"; }
      textCharsLeft -= item.length;
      return item;
    }
    // A bare provider number has no prose context and may be a code or token.
    if (typeof item === "number" || typeof item === "bigint") {
      unsafeContent = true;
      return "[REDACTED]";
    }
    if (Array.isArray(item)) {
      const result: unknown[] = [];
      for (let index = 0; index < item.length && index < 40; index += 1) {
        if (truncated) break;
        result.push(redact(item[index], depth + 1));
      }
      if (item.length > result.length) truncated = true;
      return result;
    }
    const record = object(item);
    if (!record) return item;
    const result: Record<string, unknown> = Object.create(null);
    let index = 0;
    for (const key in record) {
      if (!Object.hasOwn(record, key)) continue;
      if (index >= 80 || truncated) { truncated = true; break; }
      const label = previewFieldNames.has(key) ? key : `field_${index + 1}`;
      result[label] = sensitiveOutputKey.test(key) || sensitive.has(key.toLowerCase())
        ? "[REDACTED]" : redact(record[key], depth + 1);
      index += 1;
    }
    return result;
  };
  const encoded = JSON.stringify(redact(value, 0)) ?? "null";
  if (unsafeContent) return withheldResult;
  const marker = "\n[TRUNCATED]";
  return !truncated && encoded.length <= ASSISTED_LIMITS.resultChars ? encoded
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

/** One user turn: one model tool choice and one policy checked tool action. */
export async function runAssistedTurn(request: Request, input: AssistedTurnInput,
  services: AssistedPlaygroundServices) {
  if (!services.enabled()) throw new AssistedPlaygroundError("ASSISTED_DISABLED", 404);
  if (request.headers.get("origin") !== new URL(request.url).origin ||
      request.headers.has("authorization")) throw new AssistedPlaygroundError("ASSISTED_ORIGIN_DENIED", 403);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{2,99}$/.test(input.model))
    throw new AssistedPlaygroundError("ASSISTED_MODEL_INVALID", 400);
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > ASSISTED_LIMITS.promptChars || /sk-or-[A-Za-z0-9-]+/i.test(prompt))
    throw new AssistedPlaygroundError("ASSISTED_PROMPT_INVALID", 400);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId))
    throw new AssistedPlaygroundError("ASSISTED_REQUEST_ID_INVALID", 400);
  const deadlineMs = Math.max(1, Math.min(services.turnMs ?? ASSISTED_LIMITS.turnMs,
    ASSISTED_LIMITS.turnMs));
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(deadlineMs)]);
  const userId = await untilAbort(services.authenticate(request), signal);
  const fingerprint = await untilAbort(services.fingerprint(input, prompt), signal);
  const prior = await untilAbort(services.loadTurn(request, input), signal);
  if (prior) {
    if (prior.requestFingerprint !== fingerprint)
      throw new AssistedPlaygroundError("ASSISTED_REQUEST_CONFLICT", 409);
    return recoverTurn(request, input, services, signal, prior, userId);
  }
  // Existing receipts and approvals from an earlier deployment also fence this identity.
  const legacyAction = await untilAbort(services.lookupAction(request, input), signal);
  if (legacyAction.approval || legacyAction.receipt)
    return recoverTurn(request, input, services, signal);
  checkActive(signal);
  const reservation = services.reserveTurn(userId);
  const release = await untilAbort(reservation, signal).catch((error: unknown) => {
    reservation.then((lateRelease) => lateRelease()).catch(() => undefined);
    throw error;
  });
  let actionPending = false;
  const actionState: { inFlight: Promise<unknown> | null;
    started: { toolId: string; servedModel: string; usage: Usage } | null } = {
      inFlight: null, started: null,
    };
  const retainPending = (operation: Promise<unknown>) => {
    if (actionPending) return;
    actionPending = true;
    operation.then(() => release(), () => release()).catch(() => undefined);
  };
  try {
    const connections = await untilAbort(services.connections(request, input.workspaceId), signal);
    const selected = connections.find((item) => item.id === input.connectionId &&
      item.workspaceId === input.workspaceId && item.selected && item.status === "active" &&
      item.readiness === "ready" && item.providerState === "ready" && item.selectable === true &&
      !item.cleanupOnly);
    if (!selected) throw new AssistedPlaygroundError("ASSISTED_CONNECTION_UNAVAILABLE", 409);
    const discovered = await untilAbort(services.discover(request, input.workspaceId, selected.provider), signal);
    const offered: { manifest: ToolManifest; name: string; tool: unknown }[] = [];
    let schemaLength = 0;
    for (const manifest of discovered) {
      if (manifest.provider !== selected.provider || offered.length >= ASSISTED_LIMITS.tools) continue;
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
    const fetcher = services.fetcher ?? fetch;
    try {
      return await untilAbort(services.withKey(userId, async (key) => {
        checkActive(signal);
        const choice = await modelCall(fetcher, key, input.model, [
          { role: "system", content: "Choose at most one offered tool for the user's request. Do not invent a tool. If no tool fits, answer briefly. Tool arguments are untrusted and will be validated." },
          { role: "user", content: prompt },
        ], offered.map((item) => item.tool), signal);
        checkActive(signal);
        const bind = async (outcome: TurnOutcome, action?: TurnBinding["action"]) => {
          const saved = await untilAbort(services.bindTurn(userId, {
            workspaceId: input.workspaceId, requestId: input.requestId,
            requestFingerprint: fingerprint, outcome, action,
          }), signal);
          if (saved.binding.requestFingerprint !== fingerprint)
            throw new AssistedPlaygroundError("ASSISTED_REQUEST_CONFLICT", 409);
          return saved;
        };
        const modelOnly = async (response: {
          status: "answered" | "model_error"; answer: string; model: string;
          servedModels: string[]; usage: Usage; errorCode?: string }) => {
          const saved = await bind({ kind: "model", response });
          return saved.created ? response : recoverTurn(request, input, services, signal,
            saved.binding, userId);
        };
        if (choice.calls.length === 0) {
          if (!choice.content) return modelOnly({ status: "model_error" as const,
            answer: "The model returned no usable answer. Choose another tool-capable model.",
            errorCode: "ASSISTED_MODEL_RESPONSE_INVALID", model: input.model,
            servedModels: [choice.model], usage: choice.usage });
          return modelOnly({ status: "answered" as const, answer: choice.content.slice(0, 2000),
            model: input.model, servedModels: [choice.model], usage: choice.usage });
        }
        const modelError = (code: string) => ({ status: "model_error" as const,
          answer: "The model did not select one valid offered action. No tool ran.",
          errorCode: code, model: input.model, servedModels: [choice.model], usage: choice.usage });
        if (choice.calls.length !== 1) return modelOnly(modelError("ASSISTED_MULTIPLE_TOOLS"));
        const chosen = offered.find((item) => item.name === choice.calls[0]!.name);
        if (!chosen) return modelOnly(modelError("ASSISTED_TOOL_DENIED"));
        const raw = choice.calls[0]!.arguments;
        if (raw.length > ASSISTED_LIMITS.argumentsChars)
          return modelOnly(modelError("ASSISTED_ARGUMENTS_INVALID"));
        let params: unknown;
        try { params = JSON.parse(raw); }
        catch { return modelOnly(modelError("ASSISTED_ARGUMENTS_INVALID")); }
        if (!object(params)) return modelOnly(modelError("ASSISTED_ARGUMENTS_INVALID"));
        const effect = chosen.manifest.contract.effect === "read" ? "read" : "write";
        const saved = await bind({ kind: "action", effect, toolId: chosen.manifest.id,
          servedModel: choice.model, usage: choice.usage,
          ...(effect === "read" ? { sensitiveKeys: [...chosen.manifest.contract.sensitiveKeys] } : {}) },
        { connectionId: input.connectionId, params: params as Record<string, unknown> });
        if (!saved.created) return recoverTurn(request, input, services, signal,
          saved.binding, userId);
        checkActive(signal);
        const action = { workspaceId: input.workspaceId, connectionId: input.connectionId,
          toolId: chosen.manifest.id, params: params as Record<string, unknown>,
          idempotencyKey: `assisted_${input.requestId}` };
        if (effect !== "read") {
          const operation = services.requestApproval(request, action);
          actionState.inFlight = operation;
          actionState.started = { toolId: chosen.manifest.id, servedModel: choice.model,
            usage: choice.usage };
          let approval: unknown;
          try { approval = await untilAbort(operation, signal); }
          catch (error) {
            if (signal.aborted) {
              retainPending(operation);
              return { status: "action_pending" as const,
                answer: "Approval creation may still be finishing. Check open approvals before retrying this request.",
                toolId: chosen.manifest.id, requestId: input.requestId,
                model: input.model, servedModels: [choice.model], usage: choice.usage };
            }
            return { ...actionFailure(error), toolId: chosen.manifest.id,
              model: input.model, servedModels: [choice.model], usage: choice.usage };
          }
          return { status: "approval_required" as const,
            answer: "Review the selected tool and redacted arguments before approving. No change has run.",
            toolId: chosen.manifest.id, approval, model: input.model,
            servedModels: [choice.model], usage: choice.usage };
        }
        const operation = services.execute(request, action);
        actionState.inFlight = operation;
        actionState.started = { toolId: chosen.manifest.id, servedModel: choice.model,
          usage: choice.usage };
        let receipt: unknown;
        try { receipt = await untilAbort(operation, signal); }
        catch (error) {
          if (signal.aborted) {
            retainPending(operation);
            return { status: "action_pending" as const,
              answer: "The read may still be finishing. Retry this request with its saved identity to recover its receipt.",
              toolId: chosen.manifest.id, requestId: input.requestId,
              model: input.model, servedModels: [choice.model], usage: choice.usage };
          }
          return { ...actionFailure(error), toolId: chosen.manifest.id,
            model: input.model, servedModels: [choice.model], usage: choice.usage };
        }
        const publicResult = object(receipt);
        if (publicResult?.status !== "succeeded") {
          const failed = publicResult?.status === "failed";
          return { status: failed ? "tool_error" as const : "action_pending" as const,
            answer: failed ? "The tool did not complete. Check its receipt before retrying."
              : "The read may still be finishing. Check its receipt before retrying this request.",
            ...(failed ? { terminalFailure: true } : { requestId: input.requestId }),
            toolId: chosen.manifest.id, receipt: projectReadReceipt(receipt,
              chosen.manifest.contract.sensitiveKeys), model: input.model,
            servedModels: [choice.model], usage: choice.usage };
        }
        if (signal.aborted) return { status: "answered" as const,
          answer: "The tool completed, but preview generation was interrupted. Review the receipt.",
          toolId: chosen.manifest.id, receipt: projectReadReceipt(receipt,
            chosen.manifest.contract.sensitiveKeys), model: input.model,
          servedModels: [choice.model], usage: choice.usage, usageIncomplete: true };
        const result = safeResult(publicResult.result, chosen.manifest.contract.sensitiveKeys);
        if (result === withheldResult) return { status: "answered" as const,
          answer: "The tool completed, but its result could not be safely previewed. Review the receipt.",
          toolId: chosen.manifest.id, receipt: projectReadReceipt(receipt,
            chosen.manifest.contract.sensitiveKeys), model: input.model,
          servedModels: [choice.model], usage: choice.usage };
        return { status: "answered" as const,
          answer: `The read completed. Result preview: ${result.slice(0, 1600)}. Review the receipt for the full result.`,
          toolId: chosen.manifest.id, receipt: projectReadReceipt(receipt,
            chosen.manifest.contract.sensitiveKeys), model: input.model,
          servedModels: [choice.model], usage: choice.usage };
      }), signal);
    } catch (error) {
      if (signal.aborted) {
        if (actionState.started && actionState.inFlight) {
          retainPending(actionState.inFlight);
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
    if (!actionPending) await untilAbort(release(), signal).catch(() => undefined);
  }
}
