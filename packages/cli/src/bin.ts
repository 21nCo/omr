#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { OMRProfileStore, assertProfileName } from "@oh-my-router/client/profile-store";
import { beginDeviceAuthorization, OMRClient, OMRHttpError, OMRTransportError, pollDeviceAuthorization } from "@oh-my-router/client";
import type { ClientCapability } from "@oh-my-router/client-access";
import type { JsonValue, ToolEffect } from "@oh-my-router/tools";

type Parsed = { positionals: string[]; options: Map<string, string | true> };
const valueOptions = new Set(["profile", "url", "kind", "name", "workspace", "provider", "query", "effect", "params", "params-file", "connection", "idempotency", "limit", "cursor"]);
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
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith("--")) { positionals.push(arg); continue; }
    const equal = arg.indexOf("=");
    const name = arg.slice(2, equal < 0 ? undefined : equal);
    if (options.has(name)) throw new CLIError("INPUT_INVALID", `Duplicate --${name}`, 2);
    if (flagOptions.has(name)) {
      if (equal >= 0) throw new CLIError("INPUT_INVALID", `--${name} takes no value`, 2);
      options.set(name, true);
    } else if (valueOptions.has(name)) {
      const value = equal >= 0 ? arg.slice(equal + 1) : argv[++i];
      if (!value || value.startsWith("--")) throw new CLIError("INPUT_INVALID", `--${name} requires a value`, 2);
      options.set(name, value);
    } else throw new CLIError("INPUT_INVALID", `Unknown option --${name}`, 2);
  }
  return { options, positionals };
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
function fail(error: unknown, json: boolean): void {
  const body = error instanceof OMRHttpError ? error.body as { error?: unknown; receiptId?: unknown } | null : null;
  const remoteCode = typeof body?.error === "string" &&
    /^(?:EXECUTION|APPROVAL|CLIENT|DEVICE|CONNECTION|TOOL|WORKSPACE|REQUEST|AUTHFN|PROVIDER|RUNTIME)_[A-Z0-9_]{1,64}$/.test(body.error)
      ? body.error : undefined;
  const code = error instanceof CLIError ? error.code :
    error instanceof OMRTransportError && ["/api/tools/execute", "/api/approvals/execute"].includes(error.path)
      ? "EXECUTION_EFFECT_UNCERTAIN" :
    remoteCode ?? (error instanceof OMRHttpError ? "HTTP_ERROR" : "CLI_ERROR");
  const exit = error instanceof CLIError ? error.exitCode :
    code === "EXECUTION_APPROVAL_REQUIRED" || code === "DEVICE_AUTHORIZATION_PENDING" ? 20 :
    code === "EXECUTION_OUTCOME_UNKNOWN" || code === "EXECUTION_EFFECT_UNCERTAIN" ? 23 :
    code === "DEVICE_AUTHORIZATION_EXPIRED" ? 22 :
    code === "EXECUTION_INVOCATION_TIMEOUT" ? 24 :
    error instanceof OMRHttpError && error.status === 401 ? 3 :
    error instanceof OMRHttpError && error.status === 400 ? 2 : 1;
  const message = error instanceof CLIError ? error.message :
    error instanceof OMRHttpError ? `OMR request failed (${error.status})` :
    error instanceof OMRTransportError ? "OMR transport failed" :
    error instanceof SyntaxError ? "Invalid JSON input" :
    error instanceof Error ? error.message : "CLI failed";
  const details = error instanceof CLIError ? error.details :
    typeof body?.receiptId === "string" && /^(?:execution|receipt)_[A-Za-z0-9_-]{1,100}$/.test(body.receiptId)
      ? { receiptId: body.receiptId } : undefined;
  info(json ? JSON.stringify({ error: code, message, ...(details ? { details } : {}) }) :
    `${code}: ${message}${details ? ` ${JSON.stringify(details)}` : ""}`);
  process.exitCode = exit;
}

function current(parsed: Parsed): { api: OMRClient; workspaceId: string; profile?: string } {
  const env = [process.env.OMR_BACKEND, process.env.OMR_API_KEY, process.env.OMR_WORKSPACE_ID];
  if (env.some(Boolean)) {
    if (!env.every(Boolean)) throw new CLIError("HEADLESS_INCOMPLETE", "Set OMR_BACKEND, OMR_API_KEY, and OMR_WORKSPACE_ID together", 2);
    return { api: new OMRClient({ baseUrl: env[0]!, credential: env[1]! }), workspaceId: env[2]! };
  }
  const name = profileName(parsed);
  const profile = store.get(name);
  return { api: new OMRClient({ baseUrl: profile.backend, credential: profile.key }),
    workspaceId: profile.workspaceId, profile: name };
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

async function login(parsed: Parsed): Promise<void> {
  if ([process.env.OMR_BACKEND, process.env.OMR_API_KEY, process.env.OMR_WORKSPACE_ID].some(Boolean)) {
    throw new CLIError("INPUT_INVALID", "Device login cannot use headless credentials", 2);
  }
  const name = profileName(parsed);
  if (store.list().some((item) => item.name === name)) throw new CLIError("PROFILE_EXISTS", `Profile ${name} already exists; log out first`, 2);
  const baseUrl = required(parsed, "url");
  const kind = opt(parsed, "kind") ?? "cli";
  if (kind !== "cli" && kind !== "mcp_stdio" && kind !== "mcp_remote") {
    throw new CLIError("INPUT_INVALID", "--kind must be cli, mcp_stdio, or mcp_remote", 2);
  }
  const capabilities: ClientCapability[] = ["connections:read", "tools:discover", "tools:read", "tools:write", "approvals:create"];
  const auth = await beginDeviceAuthorization({ baseUrl, clientKind: kind,
    clientName: opt(parsed, "name") ?? `OMR ${kind} on ${hostname()}`, requestedCapabilities: capabilities });
  info(`Open ${auth.verificationUriComplete}`);
  info(`Confirm device code ${auth.userCode}`);
  if (!Number.isFinite(auth.pollIntervalSeconds) || auth.pollIntervalSeconds < 0 ||
      !Number.isFinite(auth.expiresInSeconds) || auth.expiresInSeconds <= 0) {
    throw new CLIError("DEVICE_RESPONSE_INVALID", "Invalid device authorization response", 1);
  }
  const deadline = Date.now() + auth.expiresInSeconds * 1000;
  while (Date.now() < deadline) {
    await delay(Math.min(auth.pollIntervalSeconds * 1000, Math.max(0, deadline - Date.now())));
    if (Date.now() >= deadline) break;
    try {
      const grant = await pollDeviceAuthorization({ baseUrl, deviceCode: auth.deviceCode });
      if (!grant.credential || !grant.workspaceId) throw new CLIError("DEVICE_RESPONSE_INVALID", "Invalid device grant", 1);
      try { store.save(name, { backend: baseUrl, key: grant.credential, workspaceId: grant.workspaceId }); }
      catch { throw new CLIError("LOCAL_STORAGE_FAILED",
        "Device grant was issued but could not be stored; revoke it at /app/clients before trying again", 1); }
      result({ profile: name, workspaceId: grant.workspaceId, status: "saved" });
      return;
    } catch (error) {
      if (error instanceof OMRHttpError &&
          (error.body as { error?: unknown } | null)?.error === "DEVICE_AUTHORIZATION_PENDING") continue;
      if (error instanceof OMRTransportError && error.path === "/api/device/token") {
        throw new CLIError("DEVICE_DELIVERY_UNCERTAIN",
          "Device token response was lost; check /app/clients for a grant to revoke before trying again", 1);
      }
      throw error;
    }
  }
  throw new CLIError("DEVICE_AUTHORIZATION_EXPIRED", "Device authorization expired", 22);
}

function approvalResult(value: unknown): void {
  result(value);
  const approval = value as { status?: unknown; expiresAt?: unknown };
  if (approval.status === "rejected") process.exitCode = 21;
  else if (approval.status === "uncertain" || approval.status === "executing") process.exitCode = 23;
  else if (approval.status === "expired" ||
      ((approval.status === "pending" || approval.status === "approved") &&
      typeof approval.expiresAt === "number" && approval.expiresAt <= Date.now())) process.exitCode = 22;
  else if (approval.status === "pending") process.exitCode = 20;
  else if (approval.status === "failed" ||
      !["approved", "consumed"].includes(String(approval.status))) process.exitCode = 1;
}

async function requestApproval(api: OMRClient, input: Parameters<OMRClient["requestApproval"]>[0]): Promise<unknown> {
  try { return await api.requestApproval(input); }
  catch (error) {
    if (error instanceof OMRTransportError && error.path === "/api/approvals") {
      throw new CLIError("APPROVAL_DELIVERY_UNCERTAIN",
        "Approval response was lost; retry the same request with this idempotency key", 23,
        { idempotencyKey: input.idempotencyKey });
    }
    throw error;
  }
}

async function main(parsed: Parsed): Promise<void> {
  const [command, action, subject, ...extra] = parsed.positionals;
  if (parsed.options.has("help") || !command || command === "help") {
    result({ usage: "omr login|logout|profiles list|use|show|workspaces list|show|use|connections list|select|tools list|search|inspect|run|approvals request|status|execute" });
    return;
  }
  if (extra.length) throw new CLIError("INPUT_INVALID", "Too many positional arguments", 2);
  const valid = (command === "login" && !action) || (command === "logout" && !action) ||
    (command === "profiles" && ((["list", "show"].includes(action ?? "") && !subject) ||
      (action === "use" && !!subject))) ||
    (command === "workspaces" && ((["list", "show"].includes(action ?? "") && !subject) ||
      (action === "use" && !!subject))) ||
    (command === "connections" && ((action === "list" && !subject) ||
      (action === "select" && !!subject))) ||
    (command === "tools" && ((["list", "search"].includes(action ?? "") && !subject) ||
      (["inspect", "get", "run"].includes(action ?? "") && !!subject))) ||
    (command === "approvals" && (["request", "status", "execute"].includes(action ?? "") && !!subject));
  if (!valid) throw new CLIError("USAGE", "Unknown or incomplete command; run omr --help", 2);
  if (command === "login" && !action) return login(parsed);
  if (command === "profiles") {
    if (action === "list" && !subject) return result(store.list());
    if (action === "show" && !subject) {
      const name = profileName(parsed); const { backend, workspaceId } = store.get(name);
      return result({ name, backend, workspaceId });
    }
    if (action === "use" && subject) { store.use(subject); return result({ active: subject }); }
  }
  if (command === "logout" && !action) {
    const env = [process.env.OMR_BACKEND, process.env.OMR_API_KEY, process.env.OMR_WORKSPACE_ID];
    if (env.some(Boolean)) {
      if (!env.every(Boolean)) throw new CLIError("HEADLESS_INCOMPLETE", "Set OMR_BACKEND, OMR_API_KEY, and OMR_WORKSPACE_ID together", 2);
      throw new CLIError("HEADLESS_READ_ONLY", "Headless credentials have no local profile; unset them to log out a saved profile", 2);
    }
    const name = profileName(parsed);
    if (!parsed.options.has("local")) {
      const { backend, key } = store.get(name);
      try { await new OMRClient({ baseUrl: backend, credential: key }).revokeSelf(); }
      catch (error) {
        if (error instanceof OMRHttpError && error.status === 401) {
          throw new CLIError("REVOCATION_UNVERIFIED",
            "The server could not verify revocation; keep this profile and revoke the grant in /app/clients, or use logout --local after doing so", 3);
        }
        throw error;
      }
    }
    store.remove(name); result({ profile: name, revoked: !parsed.options.has("local") }); return;
  }
  const { api, workspaceId: savedWorkspace, profile } = current(parsed);
  const workspaceId = workspace(parsed, savedWorkspace);
  if (command === "workspaces") {
    if (action === "list" && !subject) return result(profile ? store.list().map(({ name, backend, workspaceId, active }) =>
      ({ profile: name, backend, workspaceId, active })) : [{ workspaceId: savedWorkspace, source: "environment" }]);
    if (action === "show" && !subject) return result({ workspaceId: savedWorkspace, profile: profile ?? null });
    if (action === "use" && subject) {
      if (!profile) throw new CLIError("HEADLESS_READ_ONLY", "Headless workspace is set by OMR_WORKSPACE_ID", 2);
      await api.discoverTools({ workspaceId: subject, limit: 1 });
      store.setWorkspace(profile, subject);
      return result({ workspaceId: subject, profile });
    }
  }
  if (command === "connections") {
    if (action === "list" && !subject) return result(await api.listConnections(workspaceId, opt(parsed, "provider")));
    if (action === "select" && subject) return result(await api.selectConnection({ workspaceId,
      provider: required(parsed, "provider"), connectionId: subject }));
  }
  if (command === "tools") {
    if ((action === "list" || action === "search") && !subject) {
      if (action === "search") required(parsed, "query");
      const effect = opt(parsed, "effect");
      if (effect && !["read", "write", "destructive", "unknown"].includes(effect))
        throw new CLIError("INPUT_INVALID", "Invalid --effect", 2);
      const limit = opt(parsed, "limit") ? Number(opt(parsed, "limit")) : 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CLIError("INPUT_INVALID", "--limit must be 1..100", 2);
      return result(await api.discoverTools({ workspaceId, provider: opt(parsed, "provider"),
        query: opt(parsed, "query"), effect: effect as ToolEffect | undefined, limit, cursor: opt(parsed, "cursor") }));
    }
    if ((action === "inspect" || action === "get") && subject) return result(await api.getTool(subject, workspaceId));
    if (action === "run" && subject) {
      const input = params(parsed);
      const idempotencyKey = opt(parsed, "idempotency") ?? randomUUID();
      try {
        return result(await api.execute({ workspaceId, toolId: subject, params: input,
          ...(opt(parsed, "connection") ? { connectionId: opt(parsed, "connection") } : {}), idempotencyKey }));
      } catch (error) {
        if (error instanceof OMRTransportError && error.path === "/api/tools/execute") {
          throw new CLIError("EXECUTION_EFFECT_UNCERTAIN", "Execution response was lost; check the same idempotency key before retrying", 23,
            { idempotencyKey });
        }
        if (!(error instanceof OMRHttpError) ||
            (error.body as { error?: unknown } | null)?.error !== "EXECUTION_APPROVAL_REQUIRED") throw error;
        const approval = await requestApproval(api, { workspaceId, toolId: subject, params: input,
          ...(opt(parsed, "connection") ? { connectionId: opt(parsed, "connection") } : {}), idempotencyKey });
        return approvalResult({ ...(approval as object), idempotencyKey });
      }
    }
  }
  if (command === "approvals") {
    if (action === "request" && subject) {
      const approval = await requestApproval(api, { workspaceId, toolId: subject, params: params(parsed),
        ...(opt(parsed, "connection") ? { connectionId: opt(parsed, "connection") } : {}),
        idempotencyKey: required(parsed, "idempotency") });
      return approvalResult(approval);
    }
    if (action === "status" && subject) return approvalResult(await api.approvalStatus(subject));
    if (action === "execute" && subject) {
      try { return result(await api.executeApproved(subject)); }
      catch (error) {
        if (error instanceof OMRHttpError &&
            (error.body as { error?: unknown } | null)?.error === "APPROVAL_UNAVAILABLE") {
          const status = await api.approvalStatus(subject) as { status?: string; expiresAt?: number };
          if (["rejected", "pending", "uncertain", "executing", "failed"].includes(status.status ?? "") ||
              (typeof status.expiresAt === "number" && status.expiresAt <= Date.now() &&
                status.status !== "consumed")) return approvalResult(status);
        }
        throw error;
      }
    }
  }
  throw new CLIError("USAGE", "Unknown or incomplete command; run omr --help", 2);
}

let parsed: Parsed;
try { parsed = parse(process.argv.slice(2)); }
catch (error) { fail(error, process.argv.includes("--json")); process.exit(); }
main(parsed).catch((error) => fail(error, parsed.options.has("json")));
