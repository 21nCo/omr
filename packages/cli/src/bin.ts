#!/usr/bin/env node
import { readFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { OMRProfileStore, InvalidProfileNameError, ProfileRecoveryRequiredError, assertProfileName } from "@oh-my-router/client/profile-store";
import { beginDeviceAuthorization, normalizedBaseUrl, OMRClient, OMRHttpError, OMRProtocolError, OMRTransportError, pollDeviceAuthorization } from "@oh-my-router/client";
import { CLIENT_CAPABILITIES, type ClientCapability } from "@oh-my-router/client-access";
import type { JsonValue, ToolEffect } from "@oh-my-router/tools";

type Parsed = { positionals: string[]; options: Map<string, string | true> };
const valueOptions = new Set(["profile", "url", "kind", "name", "capabilities", "workspace", "provider", "query", "effect", "params", "params-file", "connection", "idempotency", "limit", "cursor", "decision"]);
const flagOptions = new Set(["json", "help", "local"]);
const store = new OMRProfileStore();

class CLIError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode: number, readonly details?: unknown) {
    super(message);
  }
}

function parse(argv: string[]): Parsed {
  const options = new Map<string, string | true>();
  const positionals: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (arg.startsWith("--")) i = parseOption(argv, i, options);
    else positionals.push(arg);
    i++;
  }
  return { options, positionals };
}

function parseOption(argv: string[], index: number, options: Parsed["options"]): number {
  const arg = argv[index]!;
  const equal = arg.indexOf("=");
  const name = arg.slice(2, equal < 0 ? undefined : equal);
  if (options.has(name)) throw new CLIError("INPUT_INVALID", `Duplicate --${name}`, 2);
  if (flagOptions.has(name)) {
    if (equal >= 0) throw new CLIError("INPUT_INVALID", `--${name} takes no value`, 2);
    options.set(name, true);
    return index;
  }
  if (!valueOptions.has(name)) throw new CLIError("INPUT_INVALID", `Unknown option --${name}`, 2);
  const value = equal >= 0 ? arg.slice(equal + 1) : argv[++index];
  if (!value || value.startsWith("--")) throw new CLIError("INPUT_INVALID", `--${name} requires a value`, 2);
  options.set(name, value);
  return index;
}

function opt(parsed: Parsed, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === "string" ? value : undefined;
}
function required(parsed: Parsed, name: string): string {
  const value = opt(parsed, name);
  if (!value) throw new CLIError("INPUT_INVALID", `--${name} is required`, 2);
  return value;
}
function profileName(parsed: Parsed): string {
  return assertProfileName(opt(parsed, "profile") ?? process.env.OMR_PROFILE ?? store.activeName());
}
function result(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function info(value: string): void { process.stderr.write(`${value}\n`); }
function listProfiles(json: boolean): ReturnType<OMRProfileStore["list"]> {
  return store.list((file) => info(json
    ? JSON.stringify({ warning: "PROFILE_UNREADABLE", file })
    : `PROFILE_UNREADABLE: Cannot read ${JSON.stringify(file)}; inspect and recover that local file`));
}
function recordRetryKey(key: string, json: boolean): void {
  // Complete this small write before dispatch. A signal after the server sees
  // the request must not erase the only retry identity available to the caller.
  const line = json ? JSON.stringify({ event: "IDEMPOTENCY_KEY", idempotencyKey: key }) : `Idempotency key: ${key}`;
  writeSync(2, `${line}\n`);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function filled(value: unknown): value is string { return nonempty(value) && value.trim().length > 0; }
function webUrl(value: unknown): boolean {
  if (!filled(value) || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !!url.hostname &&
      !url.username && !url.password;
  } catch { return false; }
}
function invalidResponse(path: string): never {
  throw new OMRProtocolError(path);
}
function validPagination(value: unknown): boolean {
  return object(value) && ["none", "cursor", "offset", "page"].includes(String(value.kind)) &&
    (value.maxPageSize === undefined || (Number.isInteger(value.maxPageSize) && Number(value.maxPageSize) > 0)) &&
    (value.cursorParameter === undefined || filled(value.cursorParameter));
}
function validResource(value: unknown): boolean {
  return object(value) && filled(value.kind) && (value.parameter === undefined || filled(value.parameter));
}
function validContract(value: unknown): boolean {
  return object(value) && filled(value.version) &&
    ["read", "write", "destructive", "unknown"].includes(String(value.effect)) &&
    Array.isArray(value.requiredScopes) && value.requiredScopes.every(filled) &&
    Array.isArray(value.resources) && value.resources.every(validResource) &&
    Array.isArray(value.sensitiveKeys) && value.sensitiveKeys.every(filled) &&
    ["never", "safe", "provider-key"].includes(String(value.retry)) &&
    (value.idempotencyKeyParameter === undefined || filled(value.idempotencyKeyParameter)) &&
    validPagination(value.pagination);
}
function validManifest(value: unknown): value is Record<string, unknown> {
  return object(value) && value.catalogSchemaVersion === "1.0.0" &&
    filled(value.id) && filled(value.provider) && filled(value.providerVersion) &&
    filled(value.action) && value.id === `${value.provider}.${value.action}` &&
    filled(value.displayName) && typeof value.description === "string" && filled(value.hash) &&
    Object.hasOwn(value, "inputSchema") && Object.hasOwn(value, "outputSchema") && validContract(value.contract);
}
function validProvider(value: unknown): boolean {
  return object(value) && filled(value.provider) && filled(value.displayName) &&
    (value.providerVersion === null || filled(value.providerVersion)) &&
    typeof value.description === "string" &&
    ["oauth", "api_key", "jwt", "basic", "none", "unknown"].includes(String(value.authMode)) &&
    Number.isInteger(value.actionCount) && Number(value.actionCount) >= 0 &&
    ["unsupported", "unconfigured", "disconnected", "expired", "ready"].includes(String(value.state)) &&
    typeof value.available === "boolean";
}
function discovery(value: unknown, provider?: string): unknown {
  if (!object(value) || value.catalogSchemaVersion !== "1.0.0" || !filled(value.revision) ||
      !Array.isArray(value.tools) || !value.tools.every((tool: unknown) =>
        validManifest(tool) && (!provider || tool.provider === provider)) ||
      (value.nextCursor !== undefined && !filled(value.nextCursor)) ||
      (value.providers !== undefined && (!Array.isArray(value.providers) || !value.providers.every(validProvider)))) {
    invalidResponse("/api/tools");
  }
  return value;
}
function manifest(value: unknown, toolId: string): unknown {
  if (!validManifest(value) || value.id !== toolId) invalidResponse("/api/tools/manifest");
  return value;
}
function checkedApproval(value: unknown, path: string,
  expected?: { id?: string; workspaceId: string; toolId?: string; connectionId?: string }): Record<string, unknown> {
  if (!object(value) || !nonempty(value.id) || !nonempty(value.workspaceId) || !nonempty(value.toolId) ||
      !["pending", "approved", "rejected", "executing", "uncertain", "consumed", "failed", "expired"].includes(String(value.status)) ||
      typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt) ||
      (expected && (value.workspaceId !== expected.workspaceId ||
        (expected.id && value.id !== expected.id) || (expected.toolId && value.toolId !== expected.toolId) ||
        (expected.connectionId && value.connectionId !== expected.connectionId)))) invalidResponse(path);
  return value;
}
function receipt(value: unknown, path: string,
  expected: { workspaceId: string; toolId?: string; connectionId?: string; approvalId?: string }): Record<string, unknown> {
  if (!object(value) || !nonempty(value.id) || !nonempty(value.workspaceId) || !nonempty(value.toolId) ||
      !["reserved", "running", "succeeded", "failed", "uncertain"].includes(String(value.status)) ||
      !Object.hasOwn(value, "result") || value.workspaceId !== expected.workspaceId ||
      (expected.toolId && value.toolId !== expected.toolId) ||
      (expected.connectionId && value.connectionId !== expected.connectionId) ||
      (expected.approvalId && value.approvalId !== expected.approvalId)) invalidResponse(path);
  return value;
}
function receiptResult(value: unknown, path: string,
  expected: { workspaceId: string; toolId?: string; connectionId?: string; approvalId?: string }): void {
  const checked = receipt(value, path, expected);
  result(checked);
  if (checked.status === "reserved" || checked.status === "running") process.exitCode = 25;
  else if (checked.status === "uncertain") process.exitCode = 23;
  else if (checked.status === "failed") process.exitCode = 1;
}
function executionInProgress(error: unknown, identity: { idempotencyKey: string } | { approvalId: string }): never {
  if (!(error instanceof OMRHttpError) ||
      (error.body as { error?: unknown } | null)?.error !== "EXECUTION_IN_PROGRESS") throw error;
  const receiptId = (error.body as { receiptId?: unknown } | null)?.receiptId;
  throw new CLIError("EXECUTION_IN_PROGRESS",
    "Execution is still in progress; inspect the receipt or retry with the same request identity", 25,
    { ...identity, ...(typeof receiptId === "string" && /^(?:execution|receipt)_[A-Za-z0-9_-]{1,100}$/.test(receiptId)
      ? { receiptId } : {}) });
}
function ambiguousMutationResponse(error: unknown,
  identity: { idempotencyKey: string } | { approvalId: string },
  operation: "tool execution" | "approval request" | "approved execution"): never {
  if (!(error instanceof OMRHttpError) || error.status < 500) throw error;
  const body = object(error.body) ? error.body : {};
  // These server responses identify a terminal failure or a timeout before
  // dispatch. Other 5xx responses can be generated after the mutation commits.
  const validReceiptId = typeof body.receiptId === "string" &&
    /^(?:execution|receipt)_[A-Za-z0-9_-]{1,100}$/.test(body.receiptId);
  const receiptId = validReceiptId ? { receiptId: body.receiptId } : {};
  // These codes are emitted only by failed reads or target preflight;
  // the provider mutation has not been dispatched.
  if (error.status === 502 &&
      (body.error === "LINEAR_QUERY_REJECTED" || body.error === "SLACK_QUERY_REJECTED")) throw error;
  // Intent reservation failed before an approval or provider call could begin.
  if (error.status === 503 && body.error === "LINEAR_INTENT_TRANSACTION_REQUIRED") {
    throw new CLIError("LINEAR_INTENT_TRANSACTION_REQUIRED",
      "Linear intent could not be reserved atomically; no issue change was sent. Retry with the same request identity after the service is available.",
      1, identity);
  }
  if (operation !== "approval request" &&
      ((error.status === 502 && body.error === "EXECUTION_FAILED" && validReceiptId) ||
       (error.status === 503 && body.error === "GITHUB_PREFLIGHT_UNAVAILABLE" && validReceiptId) ||
       (error.status === 504 && body.error === "EXECUTION_INVOCATION_TIMEOUT"))) throw error;
  let code = "EXECUTION_EFFECT_UNCERTAIN";
  if (body.error === "EXECUTION_OUTCOME_UNKNOWN") code = "EXECUTION_OUTCOME_UNKNOWN";
  else if (operation === "approval request") code = "APPROVAL_DELIVERY_UNCERTAIN";
  throw new CLIError(code,
  `${operation} response cannot prove whether the request committed; recover with the original request identity`,
  23, { ...identity, ...receiptId });
}
/** Read only the server's structured response when projecting a CLI failure. */
function httpBody(error: unknown): { error?: unknown; receiptId?: unknown } | null {
  return error instanceof OMRHttpError ? error.body as { error?: unknown; receiptId?: unknown } | null : null;
}
const publicLinearCodes = new Set([
  "LINEAR_INTENT_TRANSACTION_REQUIRED",
  "LINEAR_RATE_LIMITED", "LINEAR_RECONNECT_REQUIRED", "LINEAR_PERMISSION_DENIED",
  "LINEAR_TARGET_UNAVAILABLE", "LINEAR_WORKSPACE_MISMATCH", "LINEAR_INVALID_CHANGE",
  "LINEAR_QUERY_REJECTED",
]);
const publicSlackCodes = new Set([
  "SLACK_RATE_LIMITED", "SLACK_RECONNECT_REQUIRED", "SLACK_PERMISSION_DENIED",
  "SLACK_WORKSPACE_MISMATCH", "SLACK_CHANNEL_UNAVAILABLE", "SLACK_POST_REJECTED",
  "SLACK_QUERY_REJECTED",
]);
/** Preserve only recognized public server codes; transport errors on writes remain uncertain. */
function failureCode(error: unknown, body: ReturnType<typeof httpBody>): string {
  if (error instanceof CLIError) return error.code;
  if (error instanceof InvalidProfileNameError) return "INPUT_INVALID";
  if (error instanceof ProfileRecoveryRequiredError) return "PROFILE_RECOVERY_REQUIRED";
  if ((error instanceof OMRTransportError || error instanceof OMRProtocolError) &&
      ["/api/tools/execute", "/api/approvals/execute"].includes(error.path)) return "EXECUTION_EFFECT_UNCERTAIN";
  if (typeof body?.error === "string" &&
      (/^(?:EXECUTION|APPROVAL|CLIENT|DEVICE|CONNECTION|TOOL|WORKSPACE|REQUEST|AUTHFN|PROVIDER|RUNTIME|GITHUB)_[A-Z0-9_]{1,64}$/.test(body.error) ||
        publicLinearCodes.has(body.error) || publicSlackCodes.has(body.error))) {
    return body.error;
  }
  return error instanceof OMRHttpError ? "HTTP_ERROR" : "CLI_ERROR";
}
/** Keep ambiguous effects distinct from input, auth, and terminal HTTP failures. */
function failureExit(error: unknown, code: string): number {
  if (error instanceof CLIError) return error.exitCode;
  if (error instanceof InvalidProfileNameError) return 2;
  if (code === "EXECUTION_APPROVAL_REQUIRED" || code === "DEVICE_AUTHORIZATION_PENDING") return 20;
  if (code === "EXECUTION_OUTCOME_UNKNOWN" || code === "EXECUTION_EFFECT_UNCERTAIN") return 23;
  if (code === "DEVICE_AUTHORIZATION_EXPIRED") return 22;
  if (code === "EXECUTION_INVOCATION_TIMEOUT") return 24;
  if (error instanceof OMRHttpError && error.status === 401) return 3;
  if (error instanceof OMRHttpError && error.status === 400) return 2;
  return 1;
}
/** Use fixed recovery guidance for a proven GitHub preflight failure, never arbitrary server text. */
function failureMessage(error: unknown, code: string): string {
  if (error instanceof CLIError) return error.message;
  if (error instanceof OMRHttpError) {
    if (code === "GITHUB_PREFLIGHT_UNAVAILABLE") {
      return "GitHub repository preflight could not be verified. Check the connection before requesting a new approval.";
    }
    return `OMR request failed (${error.status})`;
  }
  if (error instanceof OMRTransportError) return "OMR transport failed";
  if (error instanceof OMRProtocolError) return "Invalid OMR response";
  if (error instanceof SyntaxError) return "Invalid JSON input";
  if (error instanceof Error) return error.message;
  return "CLI failed";
}
function failureDetails(error: unknown, body: ReturnType<typeof httpBody>): unknown {
  if (error instanceof CLIError) return error.details;
  const details: { receiptId?: string; retryAfterSeconds?: number; rateLimitResetAt?: number } = {};
  if (typeof body?.receiptId === "string" &&
      /^(?:execution|receipt)_[A-Za-z0-9_-]{1,100}$/.test(body.receiptId)) details.receiptId = body.receiptId;
  if (error instanceof OMRHttpError && typeof body?.error === "string" &&
      (body.error === "LINEAR_RATE_LIMITED" || body.error === "SLACK_RATE_LIMITED")) {
    if (error.retryAfterSeconds !== undefined) details.retryAfterSeconds = error.retryAfterSeconds;
    if (error.rateLimitResetAt !== undefined) details.rateLimitResetAt = error.rateLimitResetAt;
  }
  return Object.keys(details).length ? details : undefined;
}
function fail(error: unknown, json: boolean): void {
  const body = httpBody(error);
  const code = failureCode(error, body);
  const message = failureMessage(error, code);
  const details = failureDetails(error, body);
  if (json) info(JSON.stringify({ error: code, message, ...(details ? { details } : {}) }));
  else {
    const suffix = details ? ` ${JSON.stringify(details)}` : "";
    info(`${code}: ${message}${suffix}`);
  }
  process.exitCode = failureExit(error, code);
}

function current(parsed: Parsed): { api: OMRClient; workspaceId: string; profile?: string;
  grant?: { backend: string; key: string } } {
  const env = [process.env.OMR_BACKEND, process.env.OMR_API_KEY, process.env.OMR_WORKSPACE_ID];
  if (env.some(Boolean)) {
    if (!env.every(Boolean)) throw new CLIError("HEADLESS_INCOMPLETE", "Set OMR_BACKEND, OMR_API_KEY, and OMR_WORKSPACE_ID together", 2);
    return { api: new OMRClient({ baseUrl: env[0]!, credential: env[1]! }), workspaceId: env[2]! };
  }
  const name = profileName(parsed);
  const profile = store.get(name);
  return { api: new OMRClient({ baseUrl: profile.backend, credential: profile.key }),
    workspaceId: profile.workspaceId, profile: name,
    grant: { backend: profile.backend, key: profile.key } };
}

function workspace(parsed: Parsed, stored: string): string { return opt(parsed, "workspace") ?? stored; }
function params(parsed: Parsed): JsonValue {
  const inline = opt(parsed, "params");
  const file = opt(parsed, "params-file");
  if (inline !== undefined && file !== undefined) throw new CLIError("INPUT_INVALID", "Use one JSON input source", 2);
  let raw = inline ?? "{}";
  try {
    if (file) raw = readFileSync(file, "utf8");
    else if (inline === "-" || inline?.startsWith("@")) raw = readFileSync(inline === "-" ? 0 : inline.slice(1), "utf8");
  } catch {
    throw new CLIError("INPUT_INVALID", "Cannot read JSON input", 2);
  }
  if (Buffer.byteLength(raw) > 16 * 1024) throw new CLIError("INPUT_INVALID", "JSON input exceeds 16 KiB", 2);
  try { return JSON.parse(raw) as JsonValue; }
  catch { throw new CLIError("INPUT_INVALID", "Invalid JSON input", 2); }
}

function checkedDeviceAuthorization(auth: Awaited<ReturnType<typeof beginDeviceAuthorization>>): void {
  if (!object(auth) || !filled(auth.deviceCode) || !filled(auth.userCode) ||
      /[\u0000-\u001f\u007f]/.test(auth.userCode) ||
      !webUrl(auth.verificationUri) || !webUrl(auth.verificationUriComplete) ||
      !Number.isFinite(auth.pollIntervalSeconds) || auth.pollIntervalSeconds < 0 ||
      !Number.isFinite(auth.expiresInSeconds) || auth.expiresInSeconds <= 0) {
    throw new CLIError("DEVICE_RESPONSE_INVALID", "Invalid device authorization response", 1);
  }
}

function saveDeviceGrant(name: string, baseUrl: string,
  grant: Awaited<ReturnType<typeof pollDeviceAuthorization>>): void {
  if (!object(grant) || !filled(grant.credential) || !filled(grant.clientId) ||
      !filled(grant.grantId) || !filled(grant.workspaceId)) {
    throw new CLIError("DEVICE_DELIVERY_UNCERTAIN",
      "Device grant response is invalid; check /app/clients for a grant to revoke before trying again", 1);
  }
  try { store.save(name, { backend: baseUrl, key: grant.credential, workspaceId: grant.workspaceId }); }
  catch { throw new CLIError("LOCAL_STORAGE_FAILED",
    `Device grant could not be fully activated; inspect --profile ${name} and /app/clients before trying again`, 1); }
  result({ profile: name, workspaceId: grant.workspaceId, status: "saved" });
}

function handleDevicePollError(error: unknown): boolean {
  if (error instanceof OMRHttpError &&
      (error.body as { error?: unknown } | null)?.error === "DEVICE_AUTHORIZATION_PENDING") return true;
  if (error instanceof OMRHttpError && error.path === "/api/device/token" && error.status >= 500) {
    const code = (error.body as { error?: unknown } | null)?.error;
    if (!["DEVICE_AUTHORIZATION_INVALID", "DEVICE_AUTHORIZATION_EXPIRED"].includes(String(code))) {
      throw new CLIError("DEVICE_DELIVERY_UNCERTAIN",
        "Device token response cannot prove whether a grant was issued; check /app/clients for a grant to revoke before trying again", 1);
    }
  }
  if ((error instanceof OMRTransportError || error instanceof OMRProtocolError) &&
      error.path === "/api/device/token") {
    throw new CLIError("DEVICE_DELIVERY_UNCERTAIN",
      "Device token response was lost; check /app/clients for a grant to revoke before trying again", 1);
  }
  throw error;
}

/** Keep remote host grants narrow while preserving existing CLI and stdio defaults. */
function loginCapabilities(kind: string, selected: string | undefined): ClientCapability[] {
  if (selected && kind !== "mcp_remote") {
    throw new CLIError("INPUT_INVALID", "--capabilities is only supported for mcp_remote login", 2);
  }
  let capabilities: ClientCapability[];
  if (selected) {
    capabilities = selected.split(",").map((capability) => capability.trim()) as ClientCapability[];
  } else if (kind === "mcp_remote") {
    capabilities = ["tools:discover"];
  } else {
    capabilities = ["connections:read", "tools:discover", "tools:read", "tools:write", "approvals:create"];
  }
  if (kind === "mcp_remote" && (!capabilities.includes("tools:discover") ||
      capabilities.some((capability) => !CLIENT_CAPABILITIES.includes(capability)))) {
    throw new CLIError("INPUT_INVALID", "Remote MCP capabilities require tools:discover and recognized comma-separated capabilities", 2);
  }
  return capabilities;
}

async function login(parsed: Parsed): Promise<void> {
  if ([process.env.OMR_BACKEND, process.env.OMR_API_KEY, process.env.OMR_WORKSPACE_ID].some(Boolean)) {
    throw new CLIError("INPUT_INVALID", "Device login cannot use headless credentials", 2);
  }
  const name = profileName(parsed);
  if (store.has(name)) throw new CLIError("PROFILE_EXISTS", `Profile ${name} already exists; log out first`, 2);
  let baseUrl: string;
  try { baseUrl = normalizedBaseUrl(required(parsed, "url")); }
  catch { throw new CLIError("INPUT_INVALID", "Invalid --url; use HTTPS or localhost HTTP without credentials, query, or fragment", 2); }
  const kind = opt(parsed, "kind") ?? "cli";
  if (kind !== "cli" && kind !== "mcp_stdio" && kind !== "mcp_remote") {
    throw new CLIError("INPUT_INVALID", "--kind must be cli, mcp_stdio, or mcp_remote", 2);
  }
  const capabilities = loginCapabilities(kind, opt(parsed, "capabilities"));
  const auth = await beginDeviceAuthorization({ baseUrl, clientKind: kind,
    clientName: opt(parsed, "name") ?? `OMR ${kind} on ${hostname()}`, requestedCapabilities: capabilities });
  checkedDeviceAuthorization(auth);
  info(`Open ${auth.verificationUriComplete}`);
  info(`Confirm device code ${auth.userCode}`);
  const deadline = Date.now() + auth.expiresInSeconds * 1000;
  while (Date.now() < deadline) {
    await delay(Math.min(auth.pollIntervalSeconds * 1000, Math.max(0, deadline - Date.now())));
    if (Date.now() >= deadline) break;
    try {
      const grant = await pollDeviceAuthorization({ baseUrl, deviceCode: auth.deviceCode });
      saveDeviceGrant(name, baseUrl, grant);
      return;
    } catch (error) {
      if (handleDevicePollError(error)) continue;
    }
  }
  throw new CLIError("DEVICE_AUTHORIZATION_EXPIRED", "Device authorization expired", 22);
}

function approvalResult(value: unknown, expected: { id?: string; workspaceId: string; toolId?: string; connectionId?: string }): void {
  const approval = checkedApproval(value, "/api/approvals/status", expected);
  result(approval);
  if (approval.status === "rejected") process.exitCode = 21;
  else if (approval.status === "executing") process.exitCode = 25;
  else if (approval.status === "uncertain") process.exitCode = 23;
  else if (approval.status === "expired" ||
      ((approval.status === "pending" || approval.status === "approved") &&
      typeof approval.expiresAt === "number" && approval.expiresAt <= Date.now())) process.exitCode = 22;
  else if (approval.status === "pending") process.exitCode = 20;
  else if (approval.status === "failed" ||
      !["approved", "consumed"].includes(String(approval.status))) process.exitCode = 1;
}

async function requestApproval(api: OMRClient, input: Parameters<OMRClient["requestApproval"]>[0]): Promise<Record<string, unknown>> {
  try { return checkedApproval(await api.requestApproval(input), "/api/approvals", input); }
  catch (error) {
    if ((error instanceof OMRTransportError || error instanceof OMRProtocolError) && error.path === "/api/approvals") {
      throw new CLIError("APPROVAL_DELIVERY_UNCERTAIN",
        "Approval response was lost; retry the same request with this idempotency key", 23,
        { idempotencyKey: input.idempotencyKey });
    }
    ambiguousMutationResponse(error, { idempotencyKey: input.idempotencyKey }, "approval request");
  }
}

type CommandAction = "none" | "subject";
const commandActions: Record<string, Record<string, CommandAction>> = {
  login: { "": "none" }, logout: { "": "none" },
  profiles: { list: "none", show: "none", use: "subject" },
  workspaces: { list: "none", show: "none", use: "subject" },
  connections: { list: "none", select: "subject" },
  tools: { list: "none", search: "none", inspect: "subject", get: "subject", run: "subject" },
  approvals: { request: "subject", status: "subject", execute: "subject", reconcile: "subject" },
};

function validateCommand(command: string, action: string | undefined, subject: string | undefined): void {
  const shape = commandActions[command]?.[action ?? ""];
  if (!shape || (shape === "subject" && !subject) || (shape === "none" && subject)) {
    throw new CLIError("USAGE", "Unknown or incomplete command; run omr --help", 2);
  }
}

function profileCommand(parsed: Parsed, action: string, subject?: string): void {
  if (action === "list") return result(listProfiles(parsed.options.has("json")));
  if (action === "show") {
    const name = profileName(parsed);
    const { backend, workspaceId } = store.get(name);
    return result({ name, backend, workspaceId });
  }
  store.use(subject!);
  result({ active: subject });
}

function headlessEnvironment(): string[] | undefined {
  const env = [process.env.OMR_BACKEND, process.env.OMR_API_KEY, process.env.OMR_WORKSPACE_ID];
  if (!env.some(Boolean)) return undefined;
  if (!env.every(Boolean)) {
    throw new CLIError("HEADLESS_INCOMPLETE", "Set OMR_BACKEND, OMR_API_KEY, and OMR_WORKSPACE_ID together", 2);
  }
  return env as string[];
}

function workspaceList(parsed: Parsed): void {
  const env = headlessEnvironment();
  if (env) return result([{ workspaceId: env[2], source: "environment" }]);
  const selected = opt(parsed, "profile") ?? process.env.OMR_PROFILE;
  if (selected) store.get(assertProfileName(selected));
  result(listProfiles(parsed.options.has("json")).map(({ name, backend, workspaceId, active }) =>
    ({ profile: name, backend, workspaceId, active })));
}

async function logout(parsed: Parsed): Promise<void> {
  if (headlessEnvironment()) {
    throw new CLIError("HEADLESS_READ_ONLY", "Headless credentials have no local profile; unset them to log out a saved profile", 2);
  }
  const name = profileName(parsed);
  let revokedGrant: { backend: string; key: string } | undefined;
  if (!parsed.options.has("local")) {
    const { backend, key } = store.get(name);
    revokedGrant = { backend, key };
    try {
      const response = await new OMRClient({ baseUrl: backend, credential: key }).revokeSelf();
      if (!object(response) || response.revoked !== true) invalidResponse("/api/client-grants/revoke-self");
    } catch (error) {
      if (error instanceof OMRHttpError || error instanceof OMRTransportError || error instanceof OMRProtocolError) {
        throw new CLIError("REVOCATION_UNVERIFIED",
          "The server could not verify revocation; keep this profile and revoke the grant in /app/clients, or use logout --local after doing so", 3);
      }
      throw error;
    }
  }
  if (revokedGrant) {
    if (!store.removeIfGrantMatches(name, revokedGrant)) {
      throw new CLIError("PROFILE_CHANGED",
        "The revoked profile was removed or replaced while logout was in progress; inspect the current profile before retrying", 1);
    }
  } else store.remove(name);
  result({ profile: name, revoked: !!revokedGrant });
}

async function workspaceCommand(parsed: Parsed, action: string, subject: string | undefined,
  api: OMRClient, savedWorkspace: string, profile?: string, grant?: { backend: string; key: string }): Promise<void> {
  if (action === "show") return result({ workspaceId: savedWorkspace, profile: profile ?? null });
  if (!profile || !grant) throw new CLIError("HEADLESS_READ_ONLY", "Headless workspace is set by OMR_WORKSPACE_ID", 2);
  discovery(await api.discoverTools({ workspaceId: subject!, limit: 1 }));
  if (!store.setWorkspaceIfGrantMatches(profile, subject!, grant)) {
    throw new CLIError("PROFILE_CHANGED",
      "The profile was removed or replaced while workspace selection was in progress; inspect the current profile before retrying", 1);
  }
  result({ workspaceId: subject, profile });
}

async function connectionCommand(parsed: Parsed, action: string, subject: string | undefined,
  api: OMRClient, workspaceId: string): Promise<void> {
  if (action === "list") {
    const response = await api.listConnections(workspaceId, opt(parsed, "provider"));
    if (!Array.isArray(response) || !response.every((connection: unknown) =>
      object(connection) && nonempty(connection.id) && connection.workspaceId === workspaceId &&
      nonempty(connection.provider) && (!opt(parsed, "provider") || connection.provider === opt(parsed, "provider")))) {
      invalidResponse("/api/connections/list");
    }
    return result(response);
  }
  const provider = required(parsed, "provider");
  const response = await api.selectConnection({ workspaceId, provider, connectionId: subject! });
  if (!object(response) || response.workspaceId !== workspaceId || response.provider !== provider ||
      response.connectionId !== subject || !nonempty(response.userId)) invalidResponse("/api/connections/select");
  result(response);
}

async function toolList(parsed: Parsed, action: string, api: OMRClient, workspaceId: string): Promise<void> {
  if (action === "search") required(parsed, "query");
  const effect = opt(parsed, "effect");
  if (effect && !["read", "write", "destructive", "unknown"].includes(effect)) {
    throw new CLIError("INPUT_INVALID", "Invalid --effect", 2);
  }
  const limit = opt(parsed, "limit") ? Number(opt(parsed, "limit")) : 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new CLIError("INPUT_INVALID", "--limit must be 1..100", 2);
  }
  result(discovery(await api.discoverTools({ workspaceId, provider: opt(parsed, "provider"),
    query: opt(parsed, "query"), effect: effect as ToolEffect | undefined, limit, cursor: opt(parsed, "cursor") }),
  opt(parsed, "provider")));
}

async function toolRun(parsed: Parsed, subject: string, api: OMRClient, workspaceId: string): Promise<void> {
  const input = params(parsed);
  const idempotencyKey = opt(parsed, "idempotency") ?? randomUUID();
  if (!opt(parsed, "idempotency")) recordRetryKey(idempotencyKey, parsed.options.has("json"));
  const connectionId = opt(parsed, "connection");
  try {
    return receiptResult(await api.execute({ workspaceId, toolId: subject, params: input,
      ...(connectionId ? { connectionId } : {}), idempotencyKey }),
    "/api/tools/execute", { workspaceId, toolId: subject, connectionId });
  } catch (error) {
    return handleToolRunError(error, api, { workspaceId, toolId: subject, params: input,
      ...(connectionId ? { connectionId } : {}), idempotencyKey });
  }
}

async function handleToolRunError(error: unknown, api: OMRClient,
  input: Parameters<OMRClient["requestApproval"]>[0]): Promise<void> {
  if ((error instanceof OMRTransportError || error instanceof OMRProtocolError) && error.path === "/api/tools/execute") {
    throw new CLIError("EXECUTION_EFFECT_UNCERTAIN", "Execution response is missing or invalid; retry only with the same idempotency key", 23,
      { idempotencyKey: input.idempotencyKey });
  }
  if (error instanceof OMRHttpError &&
      (error.body as { error?: unknown } | null)?.error === "EXECUTION_IN_PROGRESS") {
    executionInProgress(error, { idempotencyKey: input.idempotencyKey });
  }
  if (error instanceof OMRHttpError && error.status >= 500) {
    ambiguousMutationResponse(error, { idempotencyKey: input.idempotencyKey }, "tool execution");
  }
  if (!(error instanceof OMRHttpError) ||
      (error.body as { error?: unknown } | null)?.error !== "EXECUTION_APPROVAL_REQUIRED") throw error;
  const approval = await requestApproval(api, input);
  return approvalResult({ ...approval, idempotencyKey: input.idempotencyKey }, input);
}

async function toolCommand(parsed: Parsed, action: string, subject: string | undefined,
  api: OMRClient, workspaceId: string): Promise<void> {
  if (action === "list" || action === "search") return toolList(parsed, action, api, workspaceId);
  if (action === "inspect" || action === "get") {
    return result(manifest(await api.getTool(subject!, workspaceId), subject!));
  }
  return toolRun(parsed, subject!, api, workspaceId);
}

function reportableUnavailableStatus(status: Record<string, unknown>): boolean {
  if (["rejected", "pending", "uncertain", "executing", "failed"].includes(String(status.status))) return true;
  return typeof status.expiresAt === "number" && status.expiresAt <= Date.now() && status.status !== "consumed";
}

async function reportUnavailableApproval(subject: string, api: OMRClient, workspaceId: string): Promise<boolean> {
  try {
    const status = checkedApproval(await api.approvalStatus(subject), "/api/approvals/status",
      { id: subject, workspaceId });
    if (!reportableUnavailableStatus(status)) return false;
    approvalResult(status, { id: subject, workspaceId });
    return true;
  } catch { return false; }
}

async function approvalExecute(subject: string, api: OMRClient, workspaceId: string): Promise<void> {
  try {
    return receiptResult(await api.executeApproved(subject), "/api/approvals/execute",
      { workspaceId, approvalId: subject });
  } catch (error) {
    return handleApprovalExecuteError(error, subject, api, workspaceId);
  }
}

async function handleApprovalExecuteError(error: unknown, subject: string,
  api: OMRClient, workspaceId: string): Promise<void> {
  if ((error instanceof OMRTransportError || error instanceof OMRProtocolError) && error.path === "/api/approvals/execute") {
    throw new CLIError("EXECUTION_EFFECT_UNCERTAIN", "Approved execution response is missing or invalid; check the approval status before retrying", 23,
      { approvalId: subject });
  }
  if (error instanceof OMRHttpError &&
      (error.body as { error?: unknown } | null)?.error === "EXECUTION_IN_PROGRESS") {
    executionInProgress(error, { approvalId: subject });
  }
  if (error instanceof OMRHttpError && error.status >= 500) {
    ambiguousMutationResponse(error, { approvalId: subject }, "approved execution");
  }
  if (error instanceof OMRHttpError &&
      (error.body as { error?: unknown } | null)?.error === "APPROVAL_UNAVAILABLE" &&
      await reportUnavailableApproval(subject, api, workspaceId)) return;
  throw error;
}

async function approvalCommand(parsed: Parsed, action: string, subject: string,
  api: OMRClient, workspaceId: string): Promise<void> {
  if (action === "status") {
    return approvalResult(await api.approvalStatus(subject), { id: subject, workspaceId });
  }
  if (action === "execute") return approvalExecute(subject, api, workspaceId);
  if (action === "reconcile") return reconcileApproval(parsed, subject, api, workspaceId);
  const connectionId = opt(parsed, "connection");
  const approval = await requestApproval(api, { workspaceId, toolId: subject, params: params(parsed),
    ...(connectionId ? { connectionId } : {}), idempotencyKey: required(parsed, "idempotency") });
  return approvalResult(approval, { workspaceId, toolId: subject, connectionId });
}

function validReconciliation(reply: Record<string, unknown>, decision: string): boolean {
  return reply.reconciledAs === decision &&
    reply.status === (decision === "effect_present" ? "consumed" : "failed");
}

async function recoverReconciliation(subject: string, decision: "effect_present" | "effect_absent",
  api: OMRClient, workspaceId: string): Promise<void> {
  try {
    const status = checkedApproval(await api.approvalStatus(subject), "/api/approvals/status",
      { id: subject, workspaceId });
    if (validReconciliation(status, decision)) return approvalResult(status, { id: subject, workspaceId });
  } catch { /* Status may also be unavailable; keep the decision uncertain. */ }
  throw new CLIError("APPROVAL_RECONCILIATION_UNCERTAIN",
    "Reconciliation response cannot prove the decision. Check approval status before retrying the same decision; never execute the write again.",
    23, { approvalId: subject, decision });
}

async function reconcileApproval(parsed: Parsed, subject: string,
  api: OMRClient, workspaceId: string): Promise<void> {
  const decision = required(parsed, "decision");
  if (decision !== "effect_present" && decision !== "effect_absent") {
    throw new CLIError("USAGE", "--decision must be effect_present or effect_absent", 2);
  }
  try {
    const reply = checkedApproval(await api.reconcileUncertain(subject, decision),
      "/api/approvals/reconcile", { id: subject, workspaceId });
    if (!validReconciliation(reply, decision)) invalidResponse("/api/approvals/reconcile");
    return approvalResult(reply, { id: subject, workspaceId });
  } catch (error) {
    if (!(error instanceof OMRTransportError || error instanceof OMRProtocolError ||
        (error instanceof OMRHttpError && error.status >= 500))) throw error;
    return recoverReconciliation(subject, decision, api, workspaceId);
  }
}

async function main(parsed: Parsed): Promise<void> {
  const [command, action, subject, ...extra] = parsed.positionals;
  if (parsed.options.has("help") || !command || command === "help") {
    result({ usage: "omr login|logout|profiles list|use|show|workspaces list|show|use|connections list|select|tools list|search|inspect|run|approvals request|status|execute|reconcile" });
    return;
  }
  if (extra.length) throw new CLIError("INPUT_INVALID", "Too many positional arguments", 2);
  validateCommand(command, action, subject);
  if (command === "login") return login(parsed);
  if (command === "profiles") return profileCommand(parsed, action!, subject);
  if (command === "workspaces" && action === "list") return workspaceList(parsed);
  if (command === "logout") return logout(parsed);
  const { api, workspaceId: savedWorkspace, profile, grant } = current(parsed);
  const workspaceId = workspace(parsed, savedWorkspace);
  if (command === "workspaces") {
    return workspaceCommand(parsed, action!, subject, api, savedWorkspace, profile, grant);
  }
  if (command === "connections") return connectionCommand(parsed, action!, subject, api, workspaceId);
  if (command === "tools") return toolCommand(parsed, action!, subject, api, workspaceId);
  return approvalCommand(parsed, action!, subject!, api, workspaceId);
}
try {
  const parsed = parse(process.argv.slice(2));
  await main(parsed);
} catch (error) {
  fail(error, process.argv.includes("--json"));
}
