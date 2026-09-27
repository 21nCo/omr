import type { ClientCapability } from "@oh-my-router/client-access";
import {
  ConnectionUnavailableError, isMissingRemoteConnection, markMissingRemoteConnection,
  type ConnectionAuthority, type ConnectionBindingRecord,
} from "@oh-my-router/connections";
import { hasRequiredScopes, type JsonValue, type ToolCatalog, type ToolManifest } from "@oh-my-router/tools";
import { approvalPreviewReady } from "./projection.js";

export type ExecutionStatus = "reserved" | "running" | "succeeded" | "failed" | "uncertain";

export const EXECUTION_INVOCATION_DEADLINE_MS = 60_000;
// Allow guard cleanup five seconds before reconciling an abandoned receipt.
export const EXECUTION_STALE_AFTER_MS = EXECUTION_INVOCATION_DEADLINE_MS + 5_000;

export class ExecutionInvocationDeadlineError extends Error {
  readonly code = "EXECUTION_INVOCATION_TIMEOUT";
  constructor() {
    super("The invocation deadline expired");
    this.name = "ExecutionInvocationDeadlineError";
  }
}

export async function withinInvocationDeadline<T>(deadlineAt: number, operation: () => Promise<T>): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new ExecutionInvocationDeadlineError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ExecutionInvocationDeadlineError()), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type ExecutionPrincipal =
  | { kind: "web"; userId: string; workspaceId: string; sessionId?: string }
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
  approvalId?: string | null;
  status: ExecutionStatus;
  result: JsonValue | null;
  errorCode: string | null;
  startedAt: number;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ExecutionReceiptStore {
  findByIdempotency(input: { workspaceId: string; principalKey: string; idempotencyKey: string;
    deadlineAt?: number }): Promise<ExecutionReceipt | null>;
  reserve(receipt: ExecutionReceipt, deadlineAt?: number): Promise<{ receipt: ExecutionReceipt; created: boolean }>;
  beginDispatch(receiptId: string, now: number, deadlineAt?: number): Promise<void>;
  succeed(receiptId: string, result: JsonValue, now: number, deadlineAt?: number): Promise<ExecutionReceipt>;
  fail(receiptId: string, errorCode: string, now: number, deadlineAt?: number): Promise<ExecutionReceipt>;
  uncertain(receiptId: string, errorCode: string, now: number, deadlineAt?: number): Promise<ExecutionReceipt>;
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
  | "uncertain"
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
  requestHash?: string;
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
  getForActor(approvalId: string, actorUserId: string, deadlineAt?: number): Promise<ExecutionApproval>;
  approve(input: { approvalId: string; actorUserId: string; now: number }): Promise<ExecutionApproval>;
  reject(input: { approvalId: string; actorUserId: string; now: number }): Promise<ExecutionApproval>;
  claim(input: {
    approvalId: string;
    actorUserId: string;
    principalKey: string;
    now: number;
    deadlineAt: number;
  }): Promise<ExecutionApproval>;
  consume(input: { approvalId: string; receiptId: string; now: number;
    deadlineAt?: number }): Promise<ExecutionApproval>;
  succeedWithReceipt(input: { approvalId: string; receipt: ExecutionReceipt;
    result: JsonValue; now: number; deadlineAt: number }): Promise<ExecutionReceipt>;
  uncertain(input: { approvalId: string; receiptId: string | null; now: number;
    deadlineAt?: number }): Promise<ExecutionApproval>;
  fail(input: { approvalId: string; now: number; deadlineAt?: number }): Promise<ExecutionApproval>;
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

/** Hold current membership, grant, and binding authorization through the provider call. */
export interface ExecutionInvocationGuard {
  run<T>(input: {
    principal: ExecutionPrincipal;
    connection: ConnectionBindingRecord;
    capability: ClientCapability;
    deadlineAt?: number;
  }, invoke: (assertCanDispatch: () => void) => Promise<T>): Promise<T>;
  runIdentity?<T>(input: {
    principal: ExecutionPrincipal;
    capability: ClientCapability;
    deadlineAt: number;
  }, invoke: () => Promise<T>): Promise<T>;
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

export class ExecutionOutcomeUnknownError extends Error {
  readonly code = "EXECUTION_OUTCOME_UNKNOWN";
  constructor(readonly receiptId: string) {
    super("The provider outcome could not be confirmed; do not repeat this action");
    this.name = "ExecutionOutcomeUnknownError";
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
  private readonly fingerprintKey: Uint8Array<ArrayBuffer>;

  constructor(
    private readonly catalog: ToolCatalog,
    private readonly connections: ConnectionAuthority,
    private readonly plugfn: PlugFnActionPort,
    private readonly receipts: ExecutionReceiptStore,
    private readonly connectionScopes: (providerConnectionId: string) => Promise<readonly string[] | undefined>,
    private readonly now: () => number = Date.now,
    private readonly approvals?: ExecutionApprovalStore,
    private readonly invocationGuard?: ExecutionInvocationGuard,
    fingerprintKey?: Uint8Array<ArrayBuffer>,
  ) {
    if (fingerprintKey?.byteLength !== 32) {
      throw new Error("Execution fingerprint key must be 32 bytes");
    }
    this.fingerprintKey = fingerprintKey;
  }

  async execute(input: {
    principal: ExecutionPrincipal;
    toolId: string;
    params: JsonValue;
    connectionId?: string;
    idempotencyKey?: string;
  }): Promise<ExecutionReceipt> {
    const deadlineAt = Date.now() + EXECUTION_INVOCATION_DEADLINE_MS;
    const manifest = this.catalog.get(input.toolId);
    if (!manifest) throw new ExecutionInputError("Unknown tool identifier");
    this.authorizeEffect(input.principal, manifest);
    assertJson(input.params);
    if (input.idempotencyKey !== undefined &&
      (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(input.idempotencyKey))) {
      throw new ExecutionInputError("Invalid idempotency key");
    }
    const params = structuredClone(input.params);

    if (input.idempotencyKey) {
      const idempotencyKey = input.idempotencyKey;
      const prior = await withinInvocationDeadline(deadlineAt, () => this.receipts.findByIdempotency({
        workspaceId: input.principal.workspaceId,
        principalKey: principalKey(input.principal),
        idempotencyKey, deadlineAt,
      }));
      if (prior?.status === "uncertain") {
        if (prior.toolId !== manifest.id || prior.manifestHash !== manifest.hash ||
            (input.connectionId && input.connectionId !== prior.connectionId) ||
            prior.requestHash !== await hashJson({ manifestHash: manifest.hash,
              connectionId: prior.connectionId, params }, this.fingerprintKey)) {
          throw new ExecutionIdempotencyConflictError();
        }
        return this.reportUncertainReceipt(input.principal,
          manifest.contract.effect === "read" ? "tools:read" : "tools:write",
          prior.id, deadlineAt);
      }
    }

    const connection = await withinInvocationDeadline(deadlineAt, () => this.connections.resolve({
      actorUserId: input.principal.userId,
      workspaceId: input.principal.workspaceId,
      provider: manifest.provider,
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    }));
    await withinInvocationDeadline(deadlineAt, () => this.assertScopes(manifest, connection));
    if (manifest.contract.effect !== "read") {
      throw new ExecutionApprovalRequiredError(manifest);
    }
    return this.runAuthorized({
      principal: input.principal,
      manifest,
      params,
      connection,
      idempotencyKey: input.idempotencyKey,
      deadlineAt,
    });
  }

  async requestApproval(input: {
    principal: ExecutionPrincipal;
    toolId: string;
    params: JsonValue;
    connectionId?: string;
    idempotencyKey: string;
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
    if (!approvalPreviewReady(manifest, manifest.hash, input.params)) {
      throw new ExecutionInputError("This tool has no complete, safely redacted approval preview");
    }
    if (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw new ExecutionInputError("Invalid idempotency key");
    }
    const params = structuredClone(input.params);
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
    const idempotencyKey = input.idempotencyKey;
    return approvals.create({
      id: `approval_${crypto.randomUUID()}`,
      workspaceId: input.principal.workspaceId,
      actorUserId: input.principal.userId,
      principalKey: principalKey(input.principal),
      toolId: manifest.id,
      manifestHash: manifest.hash,
      connectionId: connection.id,
      providerConnectionId: connection.providerConnectionId,
      params,
      idempotencyKey,
      requestHash: await hashJson({ manifestHash: manifest.hash, connectionId: connection.id,
        params, ttlMs }, this.fingerprintKey),
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
    const approvals = this.requiredApprovals();
    const approval = await approvals.getForActor(approvalId, actorUserId);
    if (!approvalPreviewReady(this.catalog.get(approval.toolId), approval.manifestHash, approval.params)) {
      throw new ApprovalUnavailableError();
    }
    return approvals.approve({ approvalId, actorUserId, now: this.now() });
  }

  async reject(approvalId: string, actorUserId: string): Promise<ExecutionApproval> {
    return this.requiredApprovals().reject({ approvalId, actorUserId, now: this.now() });
  }

  async executeApproved(
    principal: ExecutionPrincipal,
    approvalId: string,
  ): Promise<ExecutionReceipt> {
    const deadlineAt = Date.now() + EXECUTION_INVOCATION_DEADLINE_MS;
    const approvals = this.requiredApprovals();
    const replay = await this.replayApprovedReceipt(principal, approvalId, deadlineAt);
    if (replay) return replay;
    let approval: ExecutionApproval;
    try {
      approval = await withinInvocationDeadline(deadlineAt, () => approvals.claim({
        approvalId,
        actorUserId: principal.userId,
        principalKey: principalKey(principal),
        now: this.now(),
        deadlineAt,
      }));
    } catch (error) {
      if (error instanceof ExecutionOutcomeUnknownError) {
        const recovered = await this.replayApprovedReceipt(principal, approvalId, deadlineAt);
        if (recovered) return recovered;
      }
      throw error;
    }
    try {
      if (this.now() >= approval.expiresAt) throw new ApprovalUnavailableError();
      const { manifest, effectivePrincipal, connection } = await this.authorizeApproved(
        principal, approval, deadlineAt);
      const receipt = await this.runAuthorized({
        principal: effectivePrincipal,
        manifest,
        params: approval.params,
        connection,
        idempotencyKey: approval.idempotencyKey,
        approvalId: approval.id,
        approvalExpiresAt: approval.expiresAt,
        deadlineAt,
      });
      return receipt;
    } catch (error) {
      // Give cleanup a bounded grace period. The receipt remains authoritative
      // if a timed-out cleanup write cannot finish before the runtime closes.
      const cleanupDeadlineAt = deadlineAt + 5_000;
      if (error instanceof ExecutionOutcomeUnknownError || error instanceof ExecutionInProgressError) {
        await withinInvocationDeadline(cleanupDeadlineAt,
          () => approvals.uncertain({ approvalId, receiptId: error.receiptId, now: this.now(),
            deadlineAt: cleanupDeadlineAt }))
          .catch(() => undefined);
      } else {
        await withinInvocationDeadline(cleanupDeadlineAt,
          () => approvals.fail({ approvalId, now: this.now(), deadlineAt: cleanupDeadlineAt }))
          .catch(() => undefined);
      }
      throw error;
    }
  }

  private async replayApprovedReceipt(principal: ExecutionPrincipal, approvalId: string,
    deadlineAt: number): Promise<ExecutionReceipt | null> {
    const approvals = this.requiredApprovals();
    const prior = await withinInvocationDeadline(deadlineAt,
      () => approvals.getForActor(approvalId, principal.userId, deadlineAt));
    if (prior.principalKey !== principalKey(principal) ||
        (principal.workspaceId !== prior.workspaceId &&
          !(principal.kind === "web" && principal.workspaceId === ""))) {
      throw new ApprovalUnavailableError();
    }
    if (prior.status !== "consumed" && prior.status !== "uncertain" &&
        prior.status !== "executing") return null;
    const receipt = await withinInvocationDeadline(deadlineAt,
      () => this.receipts.findByIdempotency({ workspaceId: prior.workspaceId,
        principalKey: prior.principalKey, idempotencyKey: prior.idempotencyKey, deadlineAt }));
    if (!receipt || !matchesApprovalReceipt(receipt, prior)) {
      throw new ApprovalUnavailableError();
    }
    if (receipt.status === "running" || receipt.status === "uncertain") {
      const manifest = this.approvedManifest(principal, prior);
      const effectivePrincipal: ExecutionPrincipal = { ...principal, workspaceId: prior.workspaceId };
      this.authorizeEffect(effectivePrincipal, manifest);
      return this.reportUncertainReceipt(effectivePrincipal, "tools:write", receipt.id, deadlineAt);
    }
    const { manifest, effectivePrincipal, connection } = await this.authorizeApproved(
      principal, prior, deadlineAt);
    let authorizedResult: ExecutionReceipt | null = null;
    const replay = async (assertAuthorized: () => void): Promise<ExecutionReceipt> => {
      assertAuthorized();
      const result = await this.approvedReplayOutcome(approvals, prior, receipt, deadlineAt);
      authorizedResult = result;
      return result;
    };
    if (!this.invocationGuard) {
      return withinInvocationDeadline(deadlineAt, () => replay(() => undefined));
    }
    try {
      return await this.invocationGuard.run({ principal: effectivePrincipal, connection,
        capability: manifest.contract.effect === "read" ? "tools:read" : "tools:write",
        deadlineAt }, replay);
    } catch (error) {
      if (authorizedResult) return authorizedResult;
      throw error;
    }
  }

  private async approvedReplayOutcome(approvals: ExecutionApprovalStore,
    prior: ExecutionApproval, receipt: ExecutionReceipt, deadlineAt: number): Promise<ExecutionReceipt> {
    if (receipt.status === "succeeded") {
      if (prior.status !== "consumed") {
        await withinInvocationDeadline(deadlineAt,
          () => approvals.consume({ approvalId: prior.id, receiptId: receipt.id, now: this.now(),
            deadlineAt }));
      }
      return receipt;
    }
    if (receipt.status === "running" || receipt.status === "uncertain") {
      throw new ExecutionOutcomeUnknownError(receipt.id);
    }
    throw new ApprovalUnavailableError();
  }

  private async authorizeApproved(principal: ExecutionPrincipal, approval: ExecutionApproval,
    deadlineAt: number) {
    const manifest = this.approvedManifest(principal, approval);
    const effectivePrincipal: ExecutionPrincipal = { ...principal, workspaceId: approval.workspaceId };
    this.authorizeEffect(effectivePrincipal, manifest);
    const connection = await withinInvocationDeadline(deadlineAt, () => this.connections.resolve({
      actorUserId: effectivePrincipal.userId,
      workspaceId: effectivePrincipal.workspaceId,
      provider: manifest.provider,
      connectionId: approval.connectionId,
    }));
    if (connection.providerConnectionId !== approval.providerConnectionId) {
      throw new ApprovalUnavailableError();
    }
    await withinInvocationDeadline(deadlineAt, () => this.assertScopes(manifest, connection));
    return { manifest, effectivePrincipal, connection };
  }

  private approvedManifest(principal: ExecutionPrincipal, approval: ExecutionApproval): ToolManifest {
    const manifest = this.catalog.get(approval.toolId);
    if (manifest?.hash !== approval.manifestHash || manifest.contract.effect === "read" ||
        !approvalPreviewReady(manifest, approval.manifestHash, approval.params) ||
        (principal.workspaceId !== approval.workspaceId &&
          !(principal.kind === "web" && principal.workspaceId === ""))) {
      throw new ApprovalUnavailableError();
    }
    return manifest;
  }

  private reportUncertainReceipt(principal: ExecutionPrincipal, capability: ClientCapability,
    receiptId: string, deadlineAt: number): Promise<never> {
    const report = async (): Promise<never> => { throw new ExecutionOutcomeUnknownError(receiptId); };
    if (!this.invocationGuard) return report();
    if (!this.invocationGuard.runIdentity) throw new ApprovalUnavailableError();
    return this.invocationGuard.runIdentity({ principal, capability, deadlineAt }, report);
  }

  private async runAuthorized(input: {
    principal: ExecutionPrincipal;
    manifest: ToolManifest;
    params: JsonValue;
    connection: Awaited<ReturnType<ConnectionAuthority["resolve"]>>;
    idempotencyKey?: string;
    approvalId?: string;
    approvalExpiresAt?: number;
    deadlineAt: number;
  }): Promise<ExecutionReceipt> {
    const cleanupDeadlineAt = input.deadlineAt + 5_000;
    const settle = (operation: () => Promise<unknown>) =>
      withinInvocationDeadline(cleanupDeadlineAt, operation).catch(() => undefined);
    let missingRemoteAfterInvoke = false;
    let dispatchedReceiptId: string | null = null;
    let succeededReceipt: ExecutionReceipt | null = null;
    const invoke = async (assertCanDispatch: () => void): Promise<ExecutionReceipt> => {
      const assertApprovedCanDispatch = () => {
        assertCanDispatch();
        if (input.approvalExpiresAt !== undefined && this.now() >= input.approvalExpiresAt) {
          throw new ApprovalUnavailableError();
        }
      };
      assertApprovedCanDispatch();
      const principal = principalKey(input.principal);
      const requestHash = await hashJson({
        manifestHash: input.manifest.hash,
        connectionId: input.connection.id,
        params: input.params,
      }, this.fingerprintKey);
      assertApprovedCanDispatch();
      const timestamp = this.now();
      const idempotencyKey = input.idempotencyKey ?? `request_${crypto.randomUUID()}`;
      const expectedReceipt: ExecutionReceipt = {
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
        approvalId: input.approvalId ?? null,
        status: "reserved",
        result: null,
        errorCode: null,
        startedAt: timestamp,
        completedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const reservation = await this.receipts.reserve(expectedReceipt, input.deadlineAt);
      if (!reservation.created) {
        const replay = this.replayReceipt(reservation.receipt, expectedReceipt,
          assertApprovedCanDispatch);
        if (replay.status === "succeeded") succeededReceipt = replay;
        return replay;
      }

      let result: JsonValue;
      try {
        assertApprovedCanDispatch();
      } catch (error) {
        // Reservation is durable, but the provider was never called.
        await settle(() => this.receipts.fail(reservation.receipt.id,
          "authorization_window_closed", this.now(), cleanupDeadlineAt));
        throw error;
      }
      try {
        await this.receipts.beginDispatch(reservation.receipt.id, this.now(), input.deadlineAt);
        assertApprovedCanDispatch();
      } catch (error) {
        // The provider has not been entered. A late database response may have
        // committed the transition, so settle either predispatch state if possible.
        await settle(() => this.receipts.fail(reservation.receipt.id,
          "authorization_window_closed", this.now(), cleanupDeadlineAt));
        throw error;
      }
      try {
        dispatchedReceiptId = reservation.receipt.id;
        result = jsonResult(await this.plugfn.action(input.manifest.provider, input.manifest.action, {
          userId: input.principal.userId,
          connectionId: input.connection.providerConnectionId,
          params: input.params,
          actor: {
            userId: input.principal.userId,
            tenantId: input.principal.workspaceId,
            organizationId: input.principal.workspaceId,
          },
          retry: {
            maxAttempts: input.manifest.contract.effect === "read" && input.manifest.contract.retry === "safe" ? 3 : 1,
            backoff: "exponential",
          },
          cache: false,
        }));
      } catch (error) {
        const missingRemote = isMissingRemoteConnection(error);
        if (missingRemote) {
          missingRemoteAfterInvoke = true;
        }
        await settle(() => this.receipts.uncertain(reservation.receipt.id,
          "provider_outcome_unknown", this.now(), cleanupDeadlineAt));
        throw new ExecutionOutcomeUnknownError(reservation.receipt.id);
      }
      try {
        succeededReceipt = input.approvalId
          ? await withinInvocationDeadline(input.deadlineAt, () =>
            this.requiredApprovals().succeedWithReceipt({ approvalId: input.approvalId!,
            receipt: reservation.receipt, result, now: this.now(),
            deadlineAt: input.deadlineAt }))
          : await withinInvocationDeadline(input.deadlineAt,
            () => this.receipts.succeed(reservation.receipt.id, result, this.now(), input.deadlineAt));
        return succeededReceipt;
      } catch {
        // The upstream call has already returned. A failed receipt write cannot make it safe to retry.
        await settle(() => this.receipts.uncertain(reservation.receipt.id,
          "receipt_persist_failed", this.now(), cleanupDeadlineAt));
        throw new ExecutionOutcomeUnknownError(reservation.receipt.id);
      }
    };
    const run = () => this.invocationGuard ? this.invocationGuard.run({
      principal: input.principal,
      connection: input.connection,
      capability: input.manifest.contract.effect === "read" ? "tools:read" : "tools:write",
      deadlineAt: input.deadlineAt,
    }, invoke) : withinInvocationDeadline(input.deadlineAt, () => invoke(() => {
      if (Date.now() >= input.deadlineAt) {
        throw new ExecutionInvocationDeadlineError();
      }
    }));
    try {
      return await run();
    } catch (error) {
      if (missingRemoteAfterInvoke) {
        await settle(() => markMissingRemoteConnection(this.connections, input.connection.id));
      }
      // The provider result and (for approved effects) approval transition are
      // already durable. A later guard COMMIT failure cannot erase that result.
      if (succeededReceipt) return succeededReceipt;
      if (dispatchedReceiptId &&
          !(error instanceof ExecutionOutcomeUnknownError)) {
        const receiptId = dispatchedReceiptId;
        await settle(() => this.receipts.uncertain(receiptId,
          "invocation_outcome_unknown", this.now(), cleanupDeadlineAt));
        throw new ExecutionOutcomeUnknownError(receiptId);
      }
      throw error;
    }
  }

  private replayReceipt(receipt: ExecutionReceipt, expected: ExecutionReceipt,
    assertCanDispatch: () => void): ExecutionReceipt {
    if (receipt.approvalId !== expected.approvalId || receipt.requestHash !== expected.requestHash ||
        receipt.workspaceId !== expected.workspaceId || receipt.actorUserId !== expected.actorUserId ||
        receipt.principalKey !== expected.principalKey || receipt.toolId !== expected.toolId ||
        receipt.manifestHash !== expected.manifestHash || receipt.connectionId !== expected.connectionId ||
        receipt.providerConnectionId !== expected.providerConnectionId) {
      throw new ExecutionIdempotencyConflictError();
    }
    if (receipt.status === "succeeded") {
      assertCanDispatch();
      return receipt;
    }
    if (receipt.status === "reserved" || receipt.status === "running") {
      throw new ExecutionInProgressError(receipt.id);
    }
    if (receipt.status === "uncertain") throw new ExecutionOutcomeUnknownError(receipt.id);
    throw new ExecutionFailedError(receipt.id);
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
      await markMissingRemoteConnection(this.connections, connection.id);
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

function matchesApprovalReceipt(receipt: ExecutionReceipt, approval: ExecutionApproval): boolean {
  return (receipt.id === approval.executionReceiptId ||
    (approval.status === "executing" && approval.executionReceiptId === null &&
      (receipt.status === "running" || receipt.status === "uncertain" || receipt.status === "succeeded"))) &&
    receipt.approvalId === approval.id &&
    receipt.workspaceId === approval.workspaceId && receipt.actorUserId === approval.actorUserId &&
    receipt.principalKey === approval.principalKey &&
    receipt.idempotencyKey === approval.idempotencyKey && receipt.toolId === approval.toolId &&
    receipt.manifestHash === approval.manifestHash && receipt.connectionId === approval.connectionId &&
    receipt.providerConnectionId === approval.providerConnectionId;
}

function jsonResult(value: unknown): JsonValue {
  if (value === undefined) return null;
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

async function hashJson(value: JsonValue | Record<string, unknown>, secret: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key,
    new TextEncoder().encode(`omr-execution-fingerprint-v1:${canonicalJson(value)}`));
  return `hmac-sha256-${[...new Uint8Array(digest)]
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
