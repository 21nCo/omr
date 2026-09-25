import type { ClientCapability } from "@oh-my-router/client-access";
import {
  ConnectionUnavailableError, isMissingRemoteConnection, markMissingRemoteConnection,
  type ConnectionAuthority, type ConnectionBindingRecord,
} from "@oh-my-router/connections";
import { hasRequiredScopes, type JsonValue, type ToolCatalog, type ToolManifest } from "@oh-my-router/tools";

export type ExecutionStatus = "running" | "succeeded" | "failed";

export type ExecutionPrincipal =
  | { kind: "web"; userId: string; workspaceId: string }
  | {
      kind: "client";
      userId: string;
      workspaceId: string;
      clientId: string;
      grantId: string;
      capabilities: ClientCapability[];
    };

export interface ExecutionReceipt {
  id: string;
  workspaceId: string;
  actorUserId: string;
  principalKey: string;
  toolId: string;
  manifestHash: string;
  connectionId: string;
  providerConnectionId: string;
  idempotencyKey: string;
  requestHash: string;
  status: ExecutionStatus;
  result: JsonValue | null;
  errorCode: string | null;
  startedAt: number;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ExecutionReceiptStore {
  reserve(receipt: ExecutionReceipt): Promise<{ receipt: ExecutionReceipt; created: boolean }>;
  succeed(receiptId: string, result: JsonValue, now: number): Promise<ExecutionReceipt>;
  fail(receiptId: string, errorCode: string, now: number): Promise<ExecutionReceipt>;
  listForActor(input: {
    workspaceId: string;
    actorUserId: string;
    limit: number;
  }): Promise<ExecutionReceipt[]>;
}

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executing"
  | "consumed"
  | "failed";

export interface ExecutionApproval {
  id: string;
  workspaceId: string;
  actorUserId: string;
  principalKey: string;
  toolId: string;
  manifestHash: string;
  connectionId: string;
  providerConnectionId: string;
  params: JsonValue;
  idempotencyKey: string;
  status: ApprovalStatus;
  approvedBy: string | null;
  decidedAt: number | null;
  expiresAt: number;
  executionReceiptId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ExecutionApprovalStore {
  create(approval: ExecutionApproval): Promise<ExecutionApproval>;
  approve(input: { approvalId: string; actorUserId: string; now: number }): Promise<ExecutionApproval>;
  reject(input: { approvalId: string; actorUserId: string; now: number }): Promise<ExecutionApproval>;
  claim(input: {
    approvalId: string;
    actorUserId: string;
    principalKey: string;
    now: number;
  }): Promise<ExecutionApproval>;
  consume(input: { approvalId: string; receiptId: string; now: number }): Promise<ExecutionApproval>;
  fail(input: { approvalId: string; now: number }): Promise<ExecutionApproval>;
  listForActor(input: {
    workspaceId: string;
    actorUserId: string;
    limit: number;
  }): Promise<ExecutionApproval[]>;
}

export interface PlugFnActionPort {
  action(
    provider: string,
    action: string,
    options: {
      userId: string;
      connectionId: string;
      params: JsonValue;
      actor: { userId: string; tenantId: string; organizationId: string };
      retry: { maxAttempts: number; backoff: "exponential" };
      cache: boolean;
    },
  ): Promise<unknown>;
}

export class ExecutionInputError extends Error {
  readonly code = "EXECUTION_INPUT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "ExecutionInputError";
  }
}

export class ExecutionCapabilityDeniedError extends Error {
  readonly code = "EXECUTION_CAPABILITY_DENIED";
  constructor(readonly capability: ClientCapability) {
    super(`Client grant does not include ${capability}`);
    this.name = "ExecutionCapabilityDeniedError";
  }
}

export class ExecutionApprovalRequiredError extends Error {
  readonly code = "EXECUTION_APPROVAL_REQUIRED";
  constructor(readonly manifest: Pick<ToolManifest, "id" | "hash" | "contract">) {
    super("This tool requires approval before execution");
    this.name = "ExecutionApprovalRequiredError";
  }
}

export class ExecutionIdempotencyConflictError extends Error {
  readonly code = "EXECUTION_IDEMPOTENCY_CONFLICT";
  constructor() {
    super("Idempotency key was already used for a different request");
    this.name = "ExecutionIdempotencyConflictError";
  }
}

export class ExecutionInProgressError extends Error {
  readonly code = "EXECUTION_IN_PROGRESS";
  constructor(readonly receiptId: string) {
    super("An execution with this idempotency key is still in progress");
    this.name = "ExecutionInProgressError";
  }
}

export class ExecutionFailedError extends Error {
  readonly code = "EXECUTION_FAILED";
  constructor(readonly receiptId: string) {
    super("Tool execution failed");
    this.name = "ExecutionFailedError";
  }
}

export class ApprovalUnavailableError extends Error {
  readonly code = "APPROVAL_UNAVAILABLE";
  constructor() {
    super("Approval is unavailable, expired, or already used");
    this.name = "ApprovalUnavailableError";
  }
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;

export class ExecutionService {
  constructor(
    private readonly catalog: ToolCatalog,
    private readonly connections: ConnectionAuthority,
    private readonly plugfn: PlugFnActionPort,
    private readonly receipts: ExecutionReceiptStore,
    private readonly connectionScopes: (providerConnectionId: string) => Promise<readonly string[] | undefined>,
    private readonly now: () => number = Date.now,
    private readonly approvals?: ExecutionApprovalStore,
  ) {}

  async execute(input: {
    principal: ExecutionPrincipal;
    toolId: string;
    params: JsonValue;
    connectionId?: string;
    idempotencyKey?: string;
  }): Promise<ExecutionReceipt> {
    const manifest = this.catalog.get(input.toolId);
    if (!manifest) throw new ExecutionInputError("Unknown tool identifier");
    this.authorizeEffect(input.principal, manifest);
    assertJson(input.params);
    if (input.idempotencyKey && !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw new ExecutionInputError("Invalid idempotency key");
    }

    const connection = await this.connections.resolve({
      actorUserId: input.principal.userId,
      workspaceId: input.principal.workspaceId,
      provider: manifest.provider,
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    });
    await this.assertScopes(manifest, connection);
    if (manifest.contract.effect !== "read") {
      throw new ExecutionApprovalRequiredError(manifest);
    }
    return this.runAuthorized({
      principal: input.principal,
      manifest,
      params: input.params,
      connection,
      idempotencyKey: input.idempotencyKey,
    });
  }

  async requestApproval(input: {
    principal: ExecutionPrincipal;
    toolId: string;
    params: JsonValue;
    connectionId?: string;
    idempotencyKey?: string;
    ttlMs?: number;
  }): Promise<ExecutionApproval> {
    const approvals = this.requiredApprovals();
    const manifest = this.catalog.get(input.toolId);
    if (!manifest) throw new ExecutionInputError("Unknown tool identifier");
    this.authorizeEffect(input.principal, manifest);
    if (manifest.contract.effect === "read") {
      throw new ExecutionInputError("Read tools do not require approval");
    }
    if (
      input.principal.kind === "client" &&
      !input.principal.capabilities.includes("approvals:create")
    ) {
      throw new ExecutionCapabilityDeniedError("approvals:create");
    }
    assertJson(input.params);
    if (input.idempotencyKey && !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw new ExecutionInputError("Invalid idempotency key");
    }
    const ttlMs = input.ttlMs ?? 10 * 60_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 60 * 60_000) {
      throw new ExecutionInputError("Approval lifetime must be between one minute and one hour");
    }
    const connection = await this.connections.resolve({
      actorUserId: input.principal.userId,
      workspaceId: input.principal.workspaceId,
      provider: manifest.provider,
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    });
    await this.assertScopes(manifest, connection);
    const timestamp = this.now();
    return approvals.create({
      id: `approval_${crypto.randomUUID()}`,
      workspaceId: input.principal.workspaceId,
      actorUserId: input.principal.userId,
      principalKey: principalKey(input.principal),
      toolId: manifest.id,
      manifestHash: manifest.hash,
      connectionId: connection.id,
      providerConnectionId: connection.providerConnectionId,
      params: structuredClone(input.params),
      idempotencyKey: input.idempotencyKey ?? `approval_${crypto.randomUUID()}`,
      status: "pending",
      approvedBy: null,
      decidedAt: null,
      expiresAt: timestamp + ttlMs,
      executionReceiptId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  async approve(approvalId: string, actorUserId: string): Promise<ExecutionApproval> {
    return this.requiredApprovals().approve({ approvalId, actorUserId, now: this.now() });
  }

  async reject(approvalId: string, actorUserId: string): Promise<ExecutionApproval> {
    return this.requiredApprovals().reject({ approvalId, actorUserId, now: this.now() });
  }

  async executeApproved(
    principal: ExecutionPrincipal,
    approvalId: string,
  ): Promise<ExecutionReceipt> {
    const approvals = this.requiredApprovals();
    const approval = await approvals.claim({
      approvalId,
      actorUserId: principal.userId,
      principalKey: principalKey(principal),
      now: this.now(),
    });
    try {
      const manifest = this.catalog.get(approval.toolId);
      if (!manifest || manifest.hash !== approval.manifestHash || manifest.contract.effect === "read") {
        throw new ApprovalUnavailableError();
      }
      if (principal.kind === "client" && principal.workspaceId !== approval.workspaceId) {
        throw new ApprovalUnavailableError();
      }
      const effectivePrincipal: ExecutionPrincipal = {
        ...principal,
        workspaceId: approval.workspaceId,
      };
      this.authorizeEffect(effectivePrincipal, manifest);
      const connection = await this.connections.resolve({
        actorUserId: effectivePrincipal.userId,
        workspaceId: effectivePrincipal.workspaceId,
        provider: manifest.provider,
        connectionId: approval.connectionId,
      });
      if (connection.providerConnectionId !== approval.providerConnectionId) {
        throw new ApprovalUnavailableError();
      }
      await this.assertScopes(manifest, connection);
      const receipt = await this.runAuthorized({
        principal: effectivePrincipal,
        manifest,
        params: approval.params,
        connection,
        idempotencyKey: approval.idempotencyKey,
      });
      await approvals.consume({ approvalId, receiptId: receipt.id, now: this.now() });
      return receipt;
    } catch (error) {
      await approvals.fail({ approvalId, now: this.now() }).catch(() => undefined);
      throw error;
    }
  }

  private async runAuthorized(input: {
    principal: ExecutionPrincipal;
    manifest: ToolManifest;
    params: JsonValue;
    connection: Awaited<ReturnType<ConnectionAuthority["resolve"]>>;
    idempotencyKey?: string;
  }): Promise<ExecutionReceipt> {
    const principal = principalKey(input.principal);
    const requestHash = await hashJson({
      manifestHash: input.manifest.hash,
      connectionId: input.connection.id,
      params: input.params,
    });
    const timestamp = this.now();
    const idempotencyKey = input.idempotencyKey ?? `request_${crypto.randomUUID()}`;
    const reservation = await this.receipts.reserve({
      id: `execution_${crypto.randomUUID()}`,
      workspaceId: input.principal.workspaceId,
      actorUserId: input.principal.userId,
      principalKey: principal,
      toolId: input.manifest.id,
      manifestHash: input.manifest.hash,
      connectionId: input.connection.id,
      providerConnectionId: input.connection.providerConnectionId,
      idempotencyKey,
      requestHash,
      status: "running",
      result: null,
      errorCode: null,
      startedAt: timestamp,
      completedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    if (!reservation.created) {
      if (reservation.receipt.requestHash !== requestHash) {
        throw new ExecutionIdempotencyConflictError();
      }
      if (reservation.receipt.status === "succeeded") return reservation.receipt;
      if (reservation.receipt.status === "running") {
        throw new ExecutionInProgressError(reservation.receipt.id);
      }
      throw new ExecutionFailedError(reservation.receipt.id);
    }

    try {
      const result = jsonResult(await this.plugfn.action(input.manifest.provider, input.manifest.action, {
        userId: input.principal.userId,
        connectionId: input.connection.providerConnectionId,
        params: input.params,
        actor: {
          userId: input.principal.userId,
          tenantId: input.principal.workspaceId,
          organizationId: input.principal.workspaceId,
        },
        retry: {
          maxAttempts: input.manifest.contract.retry === "safe" ? 3 : 1,
          backoff: "exponential",
        },
        cache: false,
      }));
      return await this.receipts.succeed(reservation.receipt.id, result, this.now());
    } catch (error) {
      const missingRemote = isMissingRemoteConnection(error);
      await this.receipts.fail(
        reservation.receipt.id,
        missingRemote ? "connection_unavailable" : "provider_execution_failed",
        this.now(),
      );
      if (missingRemote) {
        // A failed health write must not replace the unavailable result after the receipt is failed.
        await markMissingRemoteConnection(this.connections, input.connection.id).catch(() => undefined);
        throw new ConnectionUnavailableError();
      }
      throw error;
    }
  }

  private authorizeEffect(principal: ExecutionPrincipal, manifest: ToolManifest): void {
    if (principal.kind !== "client") return;
    const required: ClientCapability = manifest.contract.effect === "read"
      ? "tools:read"
      : "tools:write";
    if (!principal.capabilities.includes(required)) {
      throw new ExecutionCapabilityDeniedError(required);
    }
  }

  private async assertScopes(manifest: ToolManifest, connection: ConnectionBindingRecord): Promise<void> {
    let scopes: readonly string[] | undefined;
    try {
      scopes = await this.connectionScopes(connection.providerConnectionId);
    } catch (error) {
      if (!isMissingRemoteConnection(error)) throw error;
      // The remote grant is unusable even if persisting its health transition fails.
      await markMissingRemoteConnection(this.connections, connection.id).catch(() => undefined);
      throw new ConnectionUnavailableError();
    }
    if (!hasRequiredScopes(manifest, scopes)) {
      throw new ExecutionInputError("Connection lacks required action scopes");
    }
  }

  private requiredApprovals(): ExecutionApprovalStore {
    if (!this.approvals) throw new Error("Execution approval store is not configured");
    return this.approvals;
  }
}

function principalKey(principal: ExecutionPrincipal): string {
  return principal.kind === "client"
    ? `client:${principal.clientId}:grant:${principal.grantId}`
    : `web:${principal.userId}`;
}

function jsonResult(value: unknown): JsonValue {
  assertJson(value);
  return structuredClone(value) as JsonValue;
}

function assertJson(value: unknown, depth = 0): void {
  if (depth > 128) throw new ExecutionInputError("JSON nesting exceeds the limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) assertJson(item, depth + 1);
    return;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const item of Object.values(value)) assertJson(item, depth + 1);
    return;
  }
  throw new ExecutionInputError("Execution values must be JSON-compatible");
}

async function hashJson(value: JsonValue | Record<string, unknown>): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return `sha256-${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}
