import type { ClientCapability } from "@oh-my-router/client-access";
import { Validator } from "@cfworker/json-schema";
import {
  ConnectionUnavailableError, isMissingRemoteConnection, markMissingRemoteConnection,
  type ConnectionAuthority, type ConnectionBindingRecord,
} from "@oh-my-router/connections";
import { ConfirmedGitHubWriteRejection, githubHttpFailure, hasRequiredScopes, LinearProviderDenial, ProviderPreflightError, type GitHubHttpFailure, type JsonValue, type ToolCatalog, type ToolManifest } from "@oh-my-router/tools";
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

interface AuthorizedInput {
  principal: ExecutionPrincipal;
  manifest: ToolManifest;
  params: JsonValue;
  connection: ConnectionBindingRecord;
  idempotencyKey?: string;
  approvalId?: string;
  approvalExpiresAt?: number;
  deadlineAt: number;
}

interface AuthorizedRunState {
  missingRemoteAfterInvoke: boolean;
  dispatchedReceiptId: string | null;
  succeededReceipt: ExecutionReceipt | null;
}

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
  | "failed"
  | "expired";

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
  intentHash?: string;
  reconciledAs?: "effect_present" | "effect_absent" | null;
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
  reconcile(input: { approvalId: string; actorUserId: string; principalKey: string;
    decision: "effect_present" | "effect_absent"; now: number }): Promise<ExecutionApproval>;
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

/** A GitHub read returned a definite HTTP denial before any provider write. */
export class GitHubReadError extends Error {
  readonly code: "GITHUB_RECONNECT_REQUIRED" | "GITHUB_ACCESS_DENIED" |
    "GITHUB_REPOSITORY_UNAVAILABLE" | "GITHUB_RATE_LIMITED";
  constructor(readonly receiptId: string, status: number, rateLimited: boolean,
    readonly retryAfterSeconds?: number, readonly rateLimitResetAt?: number) {
    let code: GitHubReadError["code"] = "GITHUB_ACCESS_DENIED";
    if (status === 401) code = "GITHUB_RECONNECT_REQUIRED";
    else if (status === 404) code = "GITHUB_REPOSITORY_UNAVAILABLE";
    else if (rateLimited) code = "GITHUB_RATE_LIMITED";
    super({
      GITHUB_RECONNECT_REQUIRED: "GitHub rejected this connection. Reconnect the account.",
      GITHUB_REPOSITORY_UNAVAILABLE: "Repository unavailable. Check its name and private-repository access.",
      GITHUB_RATE_LIMITED: "GitHub rate limit reached. Retry after its reset window.",
      GITHUB_ACCESS_DENIED: "GitHub denied this read. Check repository access and OAuth scopes.",
    }[code]);
    this.code = code;
    this.name = "GitHubReadError";
  }
}

/** Scope proof failed before an execution receipt or approval could be created. */
export class GitHubScopeProofError extends Error {
  readonly code: "GITHUB_RECONNECT_REQUIRED" | "GITHUB_ACCESS_DENIED" | "GITHUB_RATE_LIMITED" |
    "GITHUB_REPOSITORY_UNAVAILABLE";
  readonly status: number;
  readonly retryAfterSeconds?: number;
  readonly rateLimitResetAt?: number;
  constructor(failure: GitHubHttpFailure) {
    let code: GitHubScopeProofError["code"] = "GITHUB_ACCESS_DENIED";
    if (failure.rateLimited) code = "GITHUB_RATE_LIMITED";
    else if (failure.status === 401) code = "GITHUB_RECONNECT_REQUIRED";
    else if (failure.status === 404) code = "GITHUB_REPOSITORY_UNAVAILABLE";
    super({
      GITHUB_RECONNECT_REQUIRED: "GitHub rejected this connection. Reconnect the account.",
      GITHUB_REPOSITORY_UNAVAILABLE: "GitHub account unavailable. Check the selected connection.",
      GITHUB_RATE_LIMITED: "GitHub rate limit reached. Retry after its reset window.",
      GITHUB_ACCESS_DENIED: "GitHub denied scope verification. Check account access and OAuth scopes.",
    }[code]);
    this.name = "GitHubScopeProofError";
    this.code = code;
    this.status = failure.rateLimited ? 429 : failure.status;
    this.retryAfterSeconds = failure.retryAfterSeconds;
    this.rateLimitResetAt = failure.rateLimitResetAt;
  }
}

/** A GitHub comment was rejected before its POST could be sent. */
export class GitHubWritePreflightError extends Error {
  readonly code: "GITHUB_PUBLIC_REPOSITORY_REQUIRED" | "GITHUB_RECONNECT_REQUIRED" |
    "GITHUB_ACCESS_DENIED" | "GITHUB_REPOSITORY_UNAVAILABLE" | "GITHUB_PREFLIGHT_UNAVAILABLE" |
    "GITHUB_RATE_LIMITED";
  readonly retryAfterSeconds?: number;
  readonly rateLimitResetAt?: number;
  constructor(readonly receiptId: string, preflight: ProviderPreflightError) {
    let code: GitHubWritePreflightError["code"] = "GITHUB_PREFLIGHT_UNAVAILABLE";
    if (preflight.reason === "unverified_public_repository") code = "GITHUB_PUBLIC_REPOSITORY_REQUIRED";
    else if (preflight.failure?.rateLimited) code = "GITHUB_RATE_LIMITED";
    else if (preflight.status === 401) code = "GITHUB_RECONNECT_REQUIRED";
    else if (preflight.status === 403) code = "GITHUB_ACCESS_DENIED";
    else if (preflight.status === 404) code = "GITHUB_REPOSITORY_UNAVAILABLE";
    super({
      GITHUB_PUBLIC_REPOSITORY_REQUIRED: "Public issue comments require a verified public repository. Private repositories are unsupported.",
      GITHUB_RECONNECT_REQUIRED: "GitHub rejected this connection. Reconnect the account.",
      GITHUB_ACCESS_DENIED: "GitHub denied repository preflight. Check repository access and OAuth scopes.",
      GITHUB_RATE_LIMITED: "GitHub rate limit reached during repository preflight. Retry after its reset window.",
      GITHUB_REPOSITORY_UNAVAILABLE: "Repository unavailable. Check its name and private-repository access.",
      GITHUB_PREFLIGHT_UNAVAILABLE: "GitHub repository preflight could not be verified. Check the connection before requesting a new approval.",
    }[code]);
    this.code = code;
    this.name = "GitHubWritePreflightError";
    this.retryAfterSeconds = preflight.failure?.retryAfterSeconds;
    this.rateLimitResetAt = preflight.failure?.rateLimitResetAt;
  }
}

/** GitHub returned a definite rejection to the comment POST. */
export class GitHubWriteRejectedError extends Error {
  readonly code: "GITHUB_RECONNECT_REQUIRED" | "GITHUB_ACCESS_DENIED" |
    "GITHUB_REPOSITORY_UNAVAILABLE" | "GITHUB_COMMENT_UNAVAILABLE" |
    "GITHUB_COMMENT_REJECTED" | "GITHUB_RATE_LIMITED";
  readonly retryAfterSeconds?: number;
  readonly rateLimitResetAt?: number;
  constructor(readonly receiptId: string, failure: GitHubHttpFailure) {
    let code: GitHubWriteRejectedError["code"] = "GITHUB_ACCESS_DENIED";
    if (failure.rateLimited) code = "GITHUB_RATE_LIMITED";
    else if (failure.status === 401) code = "GITHUB_RECONNECT_REQUIRED";
    else if (failure.status === 404) code = "GITHUB_REPOSITORY_UNAVAILABLE";
    else if (failure.status === 410) code = "GITHUB_COMMENT_UNAVAILABLE";
    else if (failure.status === 422) code = "GITHUB_COMMENT_REJECTED";
    super({
      GITHUB_RECONNECT_REQUIRED: "GitHub rejected this connection. Reconnect the account before requesting a new approval.",
      GITHUB_REPOSITORY_UNAVAILABLE: "GitHub could not find this issue or repository. Check its name, number, and access before requesting a new approval.",
      GITHUB_COMMENT_UNAVAILABLE: "GitHub reports this issue or repository is gone. Check whether issues remain enabled and the repository is still public before requesting a new approval.",
      GITHUB_COMMENT_REJECTED: "GitHub rejected this comment as invalid or spam. Review the issue and comment content before requesting a new approval.",
      GITHUB_RATE_LIMITED: "GitHub rejected the comment at its rate limit. Retry after its reset window with a new approval.",
      GITHUB_ACCESS_DENIED: "GitHub denied this comment. Check repository access and OAuth scopes before requesting a new approval.",
    }[code]);
    this.code = code;
    this.name = "GitHubWriteRejectedError";
    this.retryAfterSeconds = failure.retryAfterSeconds;
    this.rateLimitResetAt = failure.rateLimitResetAt;
  }
}

/** Safe Linear denial tied to an execution receipt. */
export class LinearExecutionError extends Error {
  readonly code: LinearProviderDenial["code"];
  readonly retryAfterSeconds?: number;
  readonly rateLimitResetAt?: number;
  constructor(readonly receiptId: string, denial: LinearProviderDenial) {
    super(denial.message);
    this.name = "LinearExecutionError";
    this.code = denial.code;
    this.retryAfterSeconds = denial.retryAfterSeconds;
    this.rateLimitResetAt = denial.rateLimitResetAt;
  }
}

const inputValidators = new Map<string, Validator>();

/** Validate the submitted value against the exact manifest schema used for approval. */
function validToolInput(manifest: ToolManifest, params: JsonValue): boolean {
  let validator = inputValidators.get(manifest.hash);
  if (!validator) {
    const schema = manifest.inputSchema;
    if (schema === null || typeof schema !== "object" && typeof schema !== "boolean" || Array.isArray(schema)) {
      return false;
    }
    validator = new Validator(schema as ConstructorParameters<typeof Validator>[0], "7");
    inputValidators.set(manifest.hash, validator);
  }
  return validator.validate(params).valid;
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
    private readonly connectionScopes: (providerConnectionId: string, connection: ConnectionBindingRecord,
      principal: ExecutionPrincipal) => Promise<readonly string[] | undefined>,
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

  /** Validate parameters, selected workspace account, and grants before read dispatch; writes require approval. */
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
    if (!validToolInput(manifest, input.params)) throw new ExecutionInputError("Invalid tool parameters");
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
    await withinInvocationDeadline(deadlineAt, () => this.assertScopes(manifest, connection, input.principal));
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

  /** Reserve a scoped write intent only after effective grants and schema validation. */
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
    if (!validToolInput(manifest, input.params)) throw new ExecutionInputError("Invalid tool parameters");
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
    await this.assertScopes(manifest, connection, input.principal);
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
      // Independent approval keys must not create a second live Linear intent.
      intentHash: (manifest.id === "linear.issues.create" || manifest.id === "linear.issues.update")
        ? await hashJson({
        principalKey: principalKey(input.principal), workspaceId: input.principal.workspaceId,
        connectionId: connection.id, providerConnectionId: connection.providerConnectionId,
        toolId: manifest.id, params,
        }, this.fingerprintKey) : undefined,
      status: "pending",
      approvedBy: null,
      decidedAt: null,
      expiresAt: timestamp + ttlMs,
      executionReceiptId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  /** Revalidate the manifest and redacted preview before recording consent. */
  async approve(approvalId: string, actorUserId: string): Promise<ExecutionApproval> {
    const approvals = this.requiredApprovals();
    const approval = await approvals.getForActor(approvalId, actorUserId);
    const manifest = this.catalog.get(approval.toolId);
    if (!manifest || !validToolInput(manifest, approval.params) ||
        !approvalPreviewReady(manifest, approval.manifestHash, approval.params)) {
      throw new ApprovalUnavailableError();
    }
    return approvals.approve({ approvalId, actorUserId, now: this.now() });
  }

  /** Reject only an approval owned by this actor; no provider effect is entered. */
  async reject(approvalId: string, actorUserId: string): Promise<ExecutionApproval> {
    return this.requiredApprovals().reject({ approvalId, actorUserId, now: this.now() });
  }

  /** Disclose approval state only to its original principal and workspace. */
  async approvalStatus(principal: ExecutionPrincipal, approvalId: string): Promise<ExecutionApproval> {
    if (principal.kind === "client" && !principal.capabilities.includes("approvals:create")) {
      throw new ExecutionCapabilityDeniedError("approvals:create");
    }
    const approval = await this.requiredApprovals().getForActor(approvalId, principal.userId);
    if (approval.principalKey !== principalKey(principal) ||
        (principal.workspaceId !== approval.workspaceId &&
          !(principal.kind === "web" && principal.workspaceId === ""))) {
      throw new ApprovalUnavailableError();
    }
    return approval;
  }

  /** Record an actor's explicit provider-side decision for an uncertain Linear write. */
  async reconcileUncertain(principal: ExecutionPrincipal, approvalId: string,
    decision: "effect_present" | "effect_absent"): Promise<ExecutionApproval> {
    const approval = await this.approvalStatus(principal, approvalId);
    if (!approval.toolId.startsWith("linear.") || approval.status !== "uncertain" ||
        !["effect_present", "effect_absent"].includes(decision)) throw new ApprovalUnavailableError();
    return this.requiredApprovals().reconcile({ approvalId, actorUserId: principal.userId,
      principalKey: principalKey(principal), decision, now: this.now() });
  }

  /** Consume one approved intent with receipt-backed, replay-safe settlement. */
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

  /** Recover an approved attempt from its durable receipt without dispatching again. */
  private async replayApprovedReceipt(principal: ExecutionPrincipal, approvalId: string,
    deadlineAt: number): Promise<ExecutionReceipt | null> {
    const approvals = this.requiredApprovals();
    let prior = await withinInvocationDeadline(deadlineAt,
      () => approvals.getForActor(approvalId, principal.userId, deadlineAt));
    if (prior.principalKey !== principalKey(principal) ||
        (principal.workspaceId !== prior.workspaceId &&
          !(principal.kind === "web" && principal.workspaceId === ""))) {
      throw new ApprovalUnavailableError();
    }
    if (prior.reconciledAs) throw new ApprovalUnavailableError();
    if (prior.status !== "consumed" && prior.status !== "uncertain" &&
        prior.status !== "executing") return null;
    let receipt = await withinInvocationDeadline(deadlineAt,
      () => this.receipts.findByIdempotency({ workspaceId: prior.workspaceId,
        principalKey: prior.principalKey, idempotencyKey: prior.idempotencyKey, deadlineAt }));
    // A claim can commit before its response or reservation reaches this
    // process. Predispatch states still need the store's stale reconciliation.
    if (needsApprovalClaim(prior, receipt)) return null;
    if (!receipt || !matchesApprovalReceipt(receipt, prior)) {
      throw new ApprovalUnavailableError();
    }
    ({ approval: prior, receipt } = await this.refreshStaleApprovedReceipt(
      approvals, principal, prior, receipt, deadlineAt));
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

  /** Refresh a stale claim after its exact receipt and approval settle together. */
  private async refreshStaleApprovedReceipt(approvals: ExecutionApprovalStore,
    principal: ExecutionPrincipal, approval: ExecutionApproval, receipt: ExecutionReceipt,
    deadlineAt: number): Promise<{ approval: ExecutionApproval; receipt: ExecutionReceipt }> {
    if (approval.status !== "executing" || approval.executionReceiptId !== null ||
        this.now() - approval.updatedAt < EXECUTION_STALE_AFTER_MS) return { approval, receipt };
    const settled = await this.reconcileStaleEffect(approvals, principal, approval, receipt, deadlineAt);
    // Completion may have committed while reconciliation waited.
    return { approval: settled, receipt: await this.settledApprovedReceipt(settled, deadlineAt) };
  }

  /** Read back the receipt associated with a claimed approval after reconciliation. */
  private async settledApprovedReceipt(approval: ExecutionApproval,
    deadlineAt: number): Promise<ExecutionReceipt> {
    const receipt = await withinInvocationDeadline(deadlineAt,
      () => this.receipts.findByIdempotency({ workspaceId: approval.workspaceId,
        principalKey: approval.principalKey, idempotencyKey: approval.idempotencyKey, deadlineAt }));
    if (!receipt || !matchesApprovalReceipt(receipt, approval)) throw new ApprovalUnavailableError();
    return receipt;
  }

  /** Resolve an interrupted claim without treating an entered effect as retryable. */
  private async reconcileStaleEffect(approvals: ExecutionApprovalStore,
    principal: ExecutionPrincipal, approval: ExecutionApproval, receipt: ExecutionReceipt,
    deadlineAt: number): Promise<ExecutionApproval> {
    try {
      await withinInvocationDeadline(deadlineAt, () => approvals.claim({
        approvalId: approval.id, actorUserId: principal.userId,
        principalKey: principalKey(principal), now: this.now(), deadlineAt,
      }));
      throw new ApprovalUnavailableError();
    } catch (error) {
      if (!(error instanceof ApprovalUnavailableError) &&
          (!(error instanceof ExecutionOutcomeUnknownError) || error.receiptId !== receipt.id)) {
        throw error;
      }
    }
    // A claim must commit the approval/receipt association before this path
    // exposes an uncertain outcome. A concurrent claim may perform the commit.
    const settled = await withinInvocationDeadline(deadlineAt,
      () => approvals.getForActor(approval.id, principal.userId, deadlineAt));
    if ((settled.status !== "uncertain" && settled.status !== "consumed") ||
        settled.executionReceiptId !== receipt.id) {
      throw new ApprovalUnavailableError();
    }
    return settled;
  }

  /** Return a proven success or preserve the uncertain result of an earlier effect. */
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

  /** Recheck the exact selected connection and effective scopes before a write. */
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
    await withinInvocationDeadline(deadlineAt, () => this.assertScopes(manifest, connection, effectivePrincipal));
    return { manifest, effectivePrincipal, connection };
  }

  /** Reject an approval if its manifest, preview, inputs, or workspace changed. */
  private approvedManifest(principal: ExecutionPrincipal, approval: ExecutionApproval): ToolManifest {
    const manifest = this.catalog.get(approval.toolId);
    if (manifest?.hash !== approval.manifestHash || manifest.contract.effect === "read" ||
        !validToolInput(manifest, approval.params) ||
        !approvalPreviewReady(manifest, approval.manifestHash, approval.params) ||
        (principal.workspaceId !== approval.workspaceId &&
          !(principal.kind === "web" && principal.workspaceId === ""))) {
      throw new ApprovalUnavailableError();
    }
    return manifest;
  }

  /** Use the identity guard, when configured, before disclosing an ambiguous receipt. */
  private reportUncertainReceipt(principal: ExecutionPrincipal, capability: ClientCapability,
    receiptId: string, deadlineAt: number): Promise<never> {
    const report = async (): Promise<never> => { throw new ExecutionOutcomeUnknownError(receiptId); };
    if (!this.invocationGuard) return report();
    if (!this.invocationGuard.runIdentity) throw new ApprovalUnavailableError();
    return this.invocationGuard.runIdentity({ principal, capability, deadlineAt }, report);
  }

  /** Fence an authorized invocation through reservation, dispatch and settlement. */
  private async runAuthorized(input: AuthorizedInput): Promise<ExecutionReceipt> {
    const cleanupDeadlineAt = input.deadlineAt + 5_000;
    const settle = (operation: () => Promise<unknown>) =>
      withinInvocationDeadline(cleanupDeadlineAt, operation).catch(() => undefined);
    const state: AuthorizedRunState = { missingRemoteAfterInvoke: false,
      dispatchedReceiptId: null, succeededReceipt: null };
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
        if (replay.status === "succeeded") state.succeededReceipt = replay;
        return replay;
      }

      await this.beginAuthorizedDispatch(reservation.receipt.id, input.deadlineAt,
        cleanupDeadlineAt, assertApprovedCanDispatch);
      let result: JsonValue;
      try {
        state.dispatchedReceiptId = reservation.receipt.id;
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
        return this.handleAuthorizedDispatchFailure(error, input, reservation.receipt,
          cleanupDeadlineAt, state);
      }
      state.succeededReceipt = await this.persistAuthorizedResult(input, reservation.receipt, result,
        cleanupDeadlineAt);
      return state.succeededReceipt;
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
      if (state.missingRemoteAfterInvoke) {
        await settle(() => markMissingRemoteConnection(this.connections, input.connection.id));
      }
      // The provider result and (for approved effects) approval transition are
      // already durable. A later guard COMMIT failure cannot erase that result.
      if (state.succeededReceipt) return state.succeededReceipt;
      if (error instanceof ConnectionUnavailableError || error instanceof GitHubReadError || error instanceof GitHubWritePreflightError ||
          error instanceof GitHubWriteRejectedError || error instanceof LinearExecutionError) throw error;
      if (state.dispatchedReceiptId &&
          !(error instanceof ExecutionOutcomeUnknownError)) {
        const receiptId = state.dispatchedReceiptId;
        await settle(() => this.receipts.uncertain(receiptId,
          "invocation_outcome_unknown", this.now(), cleanupDeadlineAt));
        throw new ExecutionOutcomeUnknownError(receiptId);
      }
      throw error;
    }
  }

  /** Close a reserved receipt when authorization expires before provider entry. */
  private async beginAuthorizedDispatch(receiptId: string, deadlineAt: number,
    cleanupDeadlineAt: number, assertCanDispatch: () => void): Promise<void> {
    try {
      assertCanDispatch();
      await this.receipts.beginDispatch(receiptId, this.now(), deadlineAt);
      assertCanDispatch();
    } catch (error) {
      // A late begin response may have committed, but no provider call began.
      await withinInvocationDeadline(cleanupDeadlineAt, () =>
        this.receipts.fail(receiptId, "authorization_window_closed", this.now(), cleanupDeadlineAt))
        .catch(() => undefined);
      throw error;
    }
  }

  /** Persist a known failure before exposing it as a retryable client error. */
  private async failDispatchedReceipt(receiptId: string, code: string,
    cleanupDeadlineAt: number): Promise<boolean> {
    try {
      await this.receipts.fail(receiptId, code, this.now(), cleanupDeadlineAt);
      return true;
    } catch {
      return false;
    }
  }

  /** Distinguish proven provider denial from transport or settlement ambiguity. */
  private async handleAuthorizedDispatchFailure(error: unknown, input: AuthorizedInput,
    receipt: ExecutionReceipt, cleanupDeadlineAt: number, state: AuthorizedRunState): Promise<never> {
    state.missingRemoteAfterInvoke = isMissingRemoteConnection(error) ||
      isMissingGithubCommentPreflight(error, input.manifest);
    const confirmed = confirmedDispatchFailure(error, input.manifest, receipt.id);
    if (confirmed && await this.failDispatchedReceipt(receipt.id, confirmed.code, cleanupDeadlineAt)) {
      throw confirmed.error;
    }
    await withinInvocationDeadline(cleanupDeadlineAt, () =>
      this.receipts.uncertain(receipt.id, "provider_outcome_unknown", this.now(), cleanupDeadlineAt))
      .catch(() => undefined);
    throw new ExecutionOutcomeUnknownError(receipt.id);
  }

  /** Keep approved success and its receipt atomic; uncertain persistence never authorizes replay. */
  private async persistAuthorizedResult(input: AuthorizedInput, receipt: ExecutionReceipt,
    result: JsonValue, cleanupDeadlineAt: number): Promise<ExecutionReceipt> {
    try {
      if (input.approvalId) {
        return await withinInvocationDeadline(input.deadlineAt, () =>
          this.requiredApprovals().succeedWithReceipt({ approvalId: input.approvalId!,
            receipt, result, now: this.now(), deadlineAt: input.deadlineAt }));
      }
      return await withinInvocationDeadline(input.deadlineAt,
        () => this.receipts.succeed(receipt.id, result, this.now(), input.deadlineAt));
    } catch {
      // The provider has returned; no failed store write makes a retry safe.
      await withinInvocationDeadline(cleanupDeadlineAt, () =>
        this.receipts.uncertain(receipt.id, "receipt_persist_failed", this.now(), cleanupDeadlineAt))
        .catch(() => undefined);
      throw new ExecutionOutcomeUnknownError(receipt.id);
    }
  }

  /** Enforce identity and request equality on any idempotent receipt replay. */
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

  /** Client grants restrict the effect independently of connection OAuth scopes. */
  private authorizeEffect(principal: ExecutionPrincipal, manifest: ToolManifest): void {
    if (principal.kind !== "client") return;
    const required: ClientCapability = manifest.contract.effect === "read"
      ? "tools:read"
      : "tools:write";
    if (!principal.capabilities.includes(required)) {
      throw new ExecutionCapabilityDeniedError(required);
    }
  }

  /** Check verified grants and retire a remotely deleted selected connection. */
  private async assertScopes(manifest: ToolManifest, connection: ConnectionBindingRecord,
    principal: ExecutionPrincipal): Promise<void> {
    let scopes: readonly string[] | undefined;
    try {
      scopes = await this.connectionScopes(connection.providerConnectionId, connection, principal);
    } catch (error) {
      if (isMissingRemoteConnection(error)) {
        await markMissingRemoteConnection(this.connections, connection.id);
        throw new ConnectionUnavailableError();
      }
      const githubFailure = connection.provider === "github" ? githubHttpFailure(error) : null;
      if (githubFailure) throw new GitHubScopeProofError(githubFailure);
      throw error;
    }
    if (!hasRequiredScopes(manifest, scopes)) {
      throw new ExecutionInputError(`Connection lacks required action scopes: ${manifest.contract.requiredScopes.join(", ")}`);
    }
  }

  /** Fail closed when the approval store needed for a write is absent. */
  private requiredApprovals(): ExecutionApprovalStore {
    if (!this.approvals) throw new Error("Execution approval store is not configured");
    return this.approvals;
  }
}

interface ConfirmedDispatchFailure {
  code: string;
  error: Error;
}

/** A wrapped GitHub preflight proves the comment POST was never entered. */
function isMissingGithubCommentPreflight(error: unknown, manifest: ToolManifest): boolean {
  return manifest.id === "github.issues.commentPublic" &&
    error instanceof ProviderPreflightError && error.reason === "remote_connection_missing";
}

/** Classify only failures whose provider effect is known to be absent or rejected. */
function confirmedDispatchFailure(error: unknown, manifest: ToolManifest,
  receiptId: string): ConfirmedDispatchFailure | null {
  if (isMissingGithubCommentPreflight(error, manifest)) {
    return { code: "connection_unavailable", error: new ConnectionUnavailableError() };
  }
  // A raw lookup error does not prove that an already dispatched write had no effect.
  if (isMissingRemoteConnection(error)) {
    return manifest.provider === "github" && manifest.contract.effect === "read"
      ? { code: "connection_unavailable", error: new ConnectionUnavailableError() } : null;
  }
  if (manifest.provider === "github" && manifest.contract.effect === "read") {
    const denied = githubHttpFailure(error);
    if (denied) return { code: "github_read_denied",
      error: new GitHubReadError(receiptId, denied.status, denied.rateLimited,
        denied.retryAfterSeconds, denied.rateLimitResetAt) };
  }
  if (manifest.id === "github.issues.commentPublic" && error instanceof ProviderPreflightError) {
    return { code: "github_write_preflight_failed", error: new GitHubWritePreflightError(receiptId, error) };
  }
  if (manifest.id === "github.issues.commentPublic" && error instanceof ConfirmedGitHubWriteRejection) {
    return { code: "github_write_rejected", error: new GitHubWriteRejectedError(receiptId, error.failure) };
  }
  if (manifest.provider === "linear" && error instanceof LinearProviderDenial) {
    return { code: `linear_${error.phase}_denied`, error: new LinearExecutionError(receiptId, error) };
  }
  return null;
}

/** Bind idempotency to the exact client grant or signed-in web actor. */
function principalKey(principal: ExecutionPrincipal): string {
  return principal.kind === "client"
    ? `client:${principal.clientId}:grant:${principal.grantId}`
    : `web:${principal.userId}`;
}

/** A predispatch claim may be retried; an entered effect requires receipt recovery. */
function needsApprovalClaim(approval: ExecutionApproval, receipt: ExecutionReceipt | null): boolean {
  return approval.status === "executing" &&
    (!receipt || receipt.status === "reserved" || receipt.status === "failed");
}

/** Fence recovery against a receipt from another actor, workspace, grant, or request. */
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
