import pg, { type Client, type QueryResult, type QueryResultRow } from "pg";
import type { JsonValue } from "@oh-my-router/tools";

import {
  ApprovalUnavailableError,
  ApprovalTransactionRequiredError,
  ExecutionIdempotencyConflictError,
  LinearIntentTransactionRequiredError,
  ExecutionInvocationDeadlineError,
  ExecutionOutcomeUnknownError,
  EXECUTION_INVOCATION_DEADLINE_MS,
  EXECUTION_STALE_AFTER_MS,
  withinInvocationDeadline,
  type ApprovalStatus,
  type ExecutionApproval,
  type ExecutionApprovalStore,
  type ExecutionReceipt,
} from "./execution.js";
import { decryptJson, encryptJson } from "./postgres-crypto.js";
import { PostgresOwnedQueries } from "./postgres-owned-query.js";

interface ApprovalRow {
  id: string;
  workspace_id: string;
  actor_user_id: string;
  principal_key: string;
  tool_id: string;
  manifest_hash: string;
  connection_id: string;
  provider_connection_id: string;
  params_ciphertext: Buffer;
  params_iv: Buffer;
  params_crypto_version: number;
  idempotency_key: string;
  request_hash: string | null;
  intent_hash: string | null;
  reconciled_as: "effect_present" | "effect_absent" | null;
  status: ApprovalStatus;
  approved_by: string | null;
  decided_at: string | null;
  expires_at: string;
  execution_receipt_id: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id, workspace_id, actor_user_id, principal_key, tool_id, manifest_hash,
  connection_id, provider_connection_id, params_ciphertext, params_iv, params_crypto_version,
  idempotency_key, request_hash, intent_hash, reconciled_as,
  status, approved_by, decided_at, expires_at, execution_receipt_id, created_at, updated_at`;
const EXACT_RECEIPT = `receipt.approval_id = approval.id
  AND receipt.workspace_id = approval.workspace_id
  AND receipt.actor_user_id = approval.actor_user_id
  AND receipt.principal_key = approval.principal_key
  AND receipt.tool_id = approval.tool_id
  AND receipt.manifest_hash = approval.manifest_hash
  AND receipt.connection_id = approval.connection_id
  AND receipt.provider_connection_id = approval.provider_connection_id
  AND receipt.idempotency_key = approval.idempotency_key`;
const { Client: PostgresClient } = pg;

export type RunOwnedApprovalClient = <T>(deadlineAt: number,
  invoke: (client: Client, shutdownSignal: AbortSignal) => Promise<T>) => Promise<T>;
type ApprovalQuery = <R extends QueryResultRow>(sql: string, values?: unknown[]) => Promise<QueryResult<R>>;

export class PostgresExecutionApprovalStore implements ExecutionApprovalStore {
  private decisionTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: Client | null,
    private readonly wrappingKey: Uint8Array<ArrayBuffer>,
    private readonly claimConnectionString?: string,
    private readonly ownedQueries?: PostgresOwnedQueries,
    private readonly runOwnedClient?: RunOwnedApprovalClient,
  ) {
    if (wrappingKey.byteLength !== 32) throw new Error("Execution approval wrapping key must be 32 bytes");
    if (!client && !ownedQueries) throw new Error("An execution approval query connection is required");
    if (!client && !runOwnedClient) {
      throw new ApprovalTransactionRequiredError();
    }
  }

  private query<R extends QueryResultRow>(sql: string, values?: unknown[],
    deadlineAt?: number): Promise<QueryResult<R>> {
    return this.ownedQueries
      ? this.ownedQueries.query<R>(sql, values, deadlineAt)
      : this.client!.query<R>(sql, values);
  }

  async create(approval: ExecutionApproval): Promise<ExecutionApproval> {
    if (approval.intentHash && !approval.requestHash) throw new ExecutionIdempotencyConflictError();
    if (approval.intentHash && !this.runOwnedClient) {
      throw new LinearIntentTransactionRequiredError();
    }
    if (!this.runOwnedClient) return this.createWithQuery(approval, (sql, values) => this.query(sql, values));
    const deadlineAt = Date.now() + EXECUTION_INVOCATION_DEADLINE_MS;
    return this.runOwnedClient(deadlineAt, async (client) => {
      const query: ApprovalQuery = (sql, values) =>
        withinInvocationDeadline(deadlineAt, () => client.query(sql, values));
      await query("BEGIN");
      try {
        // One actor's approval keys and intent reservations share a commit boundary.
        await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [JSON.stringify([approval.workspaceId, approval.principalKey])]);
        const reserved = await this.createWithQuery(approval, query);
        await query("COMMIT");
        return reserved;
      } catch (error) {
        await query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  private async createWithQuery(approval: ExecutionApproval, query: ApprovalQuery): Promise<ExecutionApproval> {
    await query(
      `UPDATE omr_control.execution_approvals SET status = 'expired', updated_at = $3
       WHERE workspace_id = $1 AND principal_key = $2
         AND status IN ('pending', 'approved') AND expires_at <= $3`,
      [approval.workspaceId, approval.principalKey, approval.createdAt],
    );
    const alias = await query<{ approval_id: string; request_hash: string }>(
      `SELECT approval_id, request_hash FROM omr_control.execution_approval_aliases
       WHERE workspace_id = $1 AND principal_key = $2 AND idempotency_key = $3`,
      [approval.workspaceId, approval.principalKey, approval.idempotencyKey],
    );
    if (alias.rows[0]) {
      if (alias.rows[0].request_hash !== approval.requestHash) throw new ExecutionIdempotencyConflictError();
      return this.getAliasedApproval(alias.rows[0].approval_id, approval, query);
    }
    if (approval.intentHash) {
      await query(
        `UPDATE omr_control.execution_approvals SET status = 'failed', updated_at = $5
         WHERE workspace_id = $1 AND principal_key = $2 AND intent_hash = $3
           AND manifest_hash <> $4 AND status IN ('pending', 'approved')`,
        [approval.workspaceId, approval.principalKey, approval.intentHash, approval.manifestHash,
          approval.createdAt],
      );
    }
    const encrypted = await encryptJson(approval.params, this.wrappingKey,
      { kind: "approval-params", workspaceId: approval.workspaceId, id: approval.id });
    const insert = () => query<ApprovalRow>(
      `INSERT INTO omr_control.execution_approvals
         (id, workspace_id, actor_user_id, principal_key, tool_id, manifest_hash,
          connection_id, provider_connection_id, params_ciphertext, params_iv, params_crypto_version,
          idempotency_key, request_hash, intent_hash,
          status, approved_by, decided_at, expires_at, execution_receipt_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       ON CONFLICT DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        approval.id,
        approval.workspaceId,
        approval.actorUserId,
        approval.principalKey,
        approval.toolId,
        approval.manifestHash,
        approval.connectionId,
        approval.providerConnectionId,
        encrypted.ciphertext,
        encrypted.iv,
        approval.idempotencyKey,
        approval.requestHash ?? null,
        approval.intentHash ?? null,
        approval.status,
        approval.approvedBy,
        approval.decidedAt,
        approval.expiresAt,
        approval.executionReceiptId,
        approval.createdAt,
        approval.updatedAt,
      ],
    );
    const result = await insert();
    if (result.rows[0]) return this.toApproval(result.rows[0]);
    const existing = await query<ApprovalRow>(
      `SELECT ${COLUMNS} FROM omr_control.execution_approvals
       WHERE workspace_id = $1 AND principal_key = $2 AND idempotency_key = $3`,
      [approval.workspaceId, approval.principalKey, approval.idempotencyKey],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== approval.requestHash) {
        throw new ExecutionIdempotencyConflictError();
      }
      return this.toApproval(existing.rows[0]);
    }
    if (approval.intentHash) {
      const live = await query<ApprovalRow>(
        `SELECT ${COLUMNS} FROM omr_control.execution_approvals
         WHERE workspace_id = $1 AND principal_key = $2 AND intent_hash = $3
           AND status IN ('pending', 'approved', 'executing', 'uncertain')
         FOR UPDATE`,
        [approval.workspaceId, approval.principalKey, approval.intentHash],
      );
      if (live.rows[0]) {
        await this.recordAlias(approval, live.rows[0].id, query);
        return this.getAliasedApproval(live.rows[0].id, approval, query);
      }
      // The conflicting intent may have been reconciled while the insert
      // waited. Reattempt once under the same actor reservation.
      const retried = await insert();
      if (retried.rows[0]) return this.toApproval(retried.rows[0]);
    }
    throw new ExecutionIdempotencyConflictError();
  }

  private async getAliasedApproval(id: string, approval: ExecutionApproval,
    query: ApprovalQuery): Promise<ExecutionApproval> {
    const result = await query<ApprovalRow>(
      `SELECT ${COLUMNS} FROM omr_control.execution_approvals
       WHERE id = $1 AND workspace_id = $2 AND principal_key = $3`,
      [id, approval.workspaceId, approval.principalKey]);
    if (!result.rows[0]) throw new ApprovalUnavailableError();
    return this.toApproval(result.rows[0]);
  }

  private async recordAlias(approval: ExecutionApproval, targetId: string,
    query: ApprovalQuery): Promise<void> {
    const result = await query<{ approval_id: string; request_hash: string }>(
      `INSERT INTO omr_control.execution_approval_aliases
         (workspace_id, principal_key, idempotency_key, request_hash, approval_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, principal_key, idempotency_key) DO UPDATE
         SET approval_id = execution_approval_aliases.approval_id
       RETURNING approval_id, request_hash`,
      [approval.workspaceId, approval.principalKey, approval.idempotencyKey, approval.requestHash, targetId]);
    if (result.rows[0]?.request_hash !== approval.requestHash ||
        result.rows[0]?.approval_id !== targetId) throw new ExecutionIdempotencyConflictError();
  }

  /** Persist expiry using the service clock without releasing an executing or uncertain write. */
  async getForActor(approvalId: string, actorUserId: string,
    deadlineAt?: number, now?: number): Promise<ExecutionApproval> {
    if (now !== undefined) {
      await this.query(
        `UPDATE omr_control.execution_approvals AS approval
         SET status = 'expired', updated_at = $3
         WHERE id = $1 AND actor_user_id = $2
           AND status IN ('pending', 'approved')
           AND expires_at <= $3
           AND EXISTS (SELECT 1 FROM omr_control.workspace_memberships
             WHERE workspace_id = approval.workspace_id AND user_id = $2)`,
        [approvalId, actorUserId, now], deadlineAt,
      );
    }
    return this.transition(
      `SELECT ${COLUMNS} FROM omr_control.execution_approvals
       WHERE id = $1 AND actor_user_id = $2
         AND EXISTS (SELECT 1 FROM omr_control.workspace_memberships
                     WHERE workspace_id = execution_approvals.workspace_id AND user_id = $2)`,
      [approvalId, actorUserId], deadlineAt,
    );
  }

  /** Apply consent at the service-supplied expiry time while locking membership. */
  async approve(input: {
    approvalId: string;
    actorUserId: string;
    now: number;
    clock: () => number;
  }): Promise<ExecutionApproval> {
    return this.decide(input, "approved");
  }

  /** Reject only a still-live pending intent under the same membership fence. */
  async reject(input: {
    approvalId: string;
    actorUserId: string;
    now: number;
    clock: () => number;
  }): Promise<ExecutionApproval> {
    return this.decide(input, "rejected");
  }

  /** Recheck expiry after lock acquisition before committing a decision. */
  private async decide(input: { approvalId: string; actorUserId: string; now: number;
    clock: () => number }, status: "approved" | "rejected"): Promise<ExecutionApproval> {
    const deadlineAt = Date.now() + EXECUTION_INVOCATION_DEADLINE_MS;
    const decideWithClient = async (client: Client): Promise<ExecutionApproval> => {
      const query = <R extends object>(sql: string, values?: unknown[]) =>
        withinInvocationDeadline(deadlineAt, () => client.query<R>(sql, values));
      await query("BEGIN");
      try {
        const result = await query<ApprovalRow>(
          `UPDATE omr_control.execution_approvals
           SET status = $3, approved_by = CASE WHEN $3 = 'approved' THEN $2 ELSE NULL END,
               decided_at = $4, updated_at = $4
           WHERE id = $1 AND actor_user_id = $2 AND status = 'pending'
             AND expires_at > (SELECT $4::bigint
               FROM omr_control.workspace_memberships
               WHERE workspace_id = execution_approvals.workspace_id AND user_id = $2 FOR SHARE)
           RETURNING ${COLUMNS}`,
          [input.approvalId, input.actorUserId, status, input.now],
        );
        const row = result.rows[0];
        if (!row || Number(row.expires_at) <= input.clock()) {
          throw new ApprovalUnavailableError();
        }
        await query("COMMIT");
        return this.toApproval(row);
      } catch (error) {
        await query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    };
    if (this.runOwnedClient) return this.runOwnedClient(deadlineAt, decideWithClient);
    if (!this.client) throw new ApprovalTransactionRequiredError();
    // A directly supplied client is one PostgreSQL session. Keep its decision
    // transactions separate even when callers approve and reject concurrently.
    const previous = this.decisionTail;
    let release!: () => void;
    this.decisionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await decideWithClient(this.client);
    } finally {
      release();
    }
  }

  async claim(input: {
    approvalId: string;
    actorUserId: string;
    principalKey: string;
    now: number;
    clock: () => number;
    deadlineAt: number;
  }): Promise<ExecutionApproval> {
    if (!this.claimConnectionString && (!this.client || this.client instanceof PostgresClient)) {
      throw new Error("Approval claims require a dedicated PostgreSQL connection");
    }
    if (this.runOwnedClient) {
      return this.runOwnedClient(input.deadlineAt,
        (client) => this.claimWithClient(input, client, true));
    }
    const client = this.claimConnectionString
      ? new PostgresClient({ connectionString: this.claimConnectionString,
        connectionTimeoutMillis: Math.max(1, input.deadlineAt - Date.now()) }) : this.client!;
    try {
      return await this.claimWithClient(input, client, false);
    } finally {
      await this.closeClaimClient(client);
    }
  }

  private async claimWithClient(input: { approvalId: string; actorUserId: string;
    principalKey: string; now: number; clock: () => number; deadlineAt: number }, client: Client,
  connected: boolean): Promise<ExecutionApproval> {
    const query = <R extends object>(sql: string, values?: unknown[]) =>
      withinInvocationDeadline(input.deadlineAt, () => client.query<R>(sql, values));
    if (client !== this.client && !connected) {
      client.on("error", () => undefined);
    }
    let claimTransactionOpen = false;
    try {
      if (client !== this.client && !connected) {
        await withinInvocationDeadline(input.deadlineAt, () => client.connect());
      }
      if (client !== this.client) {
        await query("SELECT set_config('statement_timeout', $1, false)",
          [`${Math.max(1, input.deadlineAt - Date.now())}ms`]);
      }
      await query("BEGIN");
      claimTransactionOpen = true;
      const claimed = await query<ApprovalRow>(
      `UPDATE omr_control.execution_approvals
       SET status = 'executing', updated_at = $4
       WHERE id = $1 AND actor_user_id = $2 AND principal_key = $3
         AND status = 'approved'
         AND expires_at > $4
         AND EXISTS (SELECT 1 FROM omr_control.workspace_memberships
                     WHERE workspace_id = execution_approvals.workspace_id AND user_id = $2 FOR SHARE)
       RETURNING ${COLUMNS}`,
      [input.approvalId, input.actorUserId, input.principalKey, input.now],
    );
      if (claimed.rows[0]) {
        if (Number(claimed.rows[0].expires_at) <= input.clock()) {
          await query("ROLLBACK");
          claimTransactionOpen = false;
          throw new ApprovalUnavailableError();
        }
        await query("COMMIT");
        claimTransactionOpen = false;
        return this.toApproval(claimed.rows[0]);
      }
      await query("ROLLBACK");
      claimTransactionOpen = false;
      return await this.reconcileStaleClaim(input, client);
    } catch (error) {
      return await this.rethrowClaimError(error, claimTransactionOpen, client, input.deadlineAt);
    }
  }

  private async rethrowClaimError(error: unknown, transactionOpen: boolean,
    client: Client, deadlineAt: number): Promise<never> {
    if (transactionOpen && Date.now() < deadlineAt) {
      await withinInvocationDeadline(deadlineAt, () => client.query("ROLLBACK")).catch(() => undefined);
    }
    if (error instanceof ExecutionOutcomeUnknownError ||
        error instanceof ApprovalUnavailableError) throw error;
    if (Date.now() >= deadlineAt ||
      (error instanceof Error && "code" in error && error.code === "57014" &&
        /statement timeout/i.test(error.message))) {
      throw new ExecutionInvocationDeadlineError();
    }
    throw error;
  }

  private async closeClaimClient(client: Client): Promise<void> {
    if (client === this.client) return;
    const closing = client.end();
    try {
      await withinInvocationDeadline(Date.now() + 1_000, () => closing);
    } catch {
      client.connection?.stream.destroy();
      await withinInvocationDeadline(Date.now() + 1_000, () => closing).catch(() => undefined);
    }
  }

  private async reconcileStaleClaim(input: { approvalId: string; actorUserId: string;
    principalKey: string; deadlineAt: number }, client: Client): Promise<never> {
    const query = <R extends object>(sql: string, values?: unknown[]) =>
      withinInvocationDeadline(input.deadlineAt, () => client.query<R>(sql, values));
    const linkedEffect = async () => query<Pick<ApprovalRow, "execution_receipt_id">>(
      `SELECT approval.execution_receipt_id FROM omr_control.execution_approvals AS approval
       WHERE approval.id = $1 AND approval.actor_user_id = $2 AND approval.principal_key = $3
         AND approval.status = 'uncertain' AND approval.execution_receipt_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM omr_control.workspace_memberships
           WHERE workspace_id = approval.workspace_id AND user_id = $2 FOR SHARE)
         AND EXISTS (SELECT 1 FROM omr_control.execution_receipts AS receipt
           WHERE receipt.id = approval.execution_receipt_id AND ${EXACT_RECEIPT}
             AND receipt.status IN ('running', 'succeeded', 'uncertain'))`,
      [input.approvalId, input.actorUserId, input.principalKey],
    );
    const prior = await linkedEffect();
    if (prior.rows[0]?.execution_receipt_id) {
      throw new ExecutionOutcomeUnknownError(prior.rows[0].execution_receipt_id);
    }
    // Lock the approval and its exact receipt together. A reserved receipt has
    // no external effect and must become terminal in the same transaction as
    // the stale approval; an effect-bearing receipt retains its original ID.
    let transactionOpen = false;
    let effectReceiptId: string | null = null;
    try {
      await query("BEGIN");
      transactionOpen = true;
      const stale = await query<{ id: string }>(
        `SELECT approval.id FROM omr_control.execution_approvals AS approval
         WHERE approval.id = $1 AND approval.actor_user_id = $2 AND approval.principal_key = $3
           AND approval.status = 'executing' AND approval.execution_receipt_id IS NULL
           AND approval.updated_at <= $4
           AND EXISTS (SELECT 1 FROM omr_control.workspace_memberships
             WHERE workspace_id = approval.workspace_id AND user_id = $2)
         FOR UPDATE OF approval`,
        [input.approvalId, input.actorUserId, input.principalKey,
          Date.now() - EXECUTION_STALE_AFTER_MS],
      );
      if (stale.rows[0]) {
        const exact = await query<{ id: string; status: ExecutionReceipt["status"] }>(
          `SELECT receipt.id, receipt.status FROM omr_control.execution_receipts AS receipt
           JOIN omr_control.execution_approvals AS approval ON ${EXACT_RECEIPT}
           WHERE approval.id = $1 FOR UPDATE OF receipt`,
          [input.approvalId],
        );
        const receipt = exact.rows[0];
        const now = Date.now();
        effectReceiptId = await this.settleStaleReceipt(receipt, now, query);
        await query(
          `UPDATE omr_control.execution_approvals
           SET status = $2, execution_receipt_id = $3, updated_at = $4
           WHERE id = $1 AND status = 'executing'`,
          [input.approvalId, effectReceiptId ? "uncertain" : "failed", effectReceiptId, now],
        );
      }
      await query("COMMIT");
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen && Date.now() < input.deadlineAt) {
        await query("ROLLBACK").catch(() => undefined);
      }
      throw error;
    }
    if (effectReceiptId) throw new ExecutionOutcomeUnknownError(effectReceiptId);
    // Another retry may have settled the row while this transaction waited
    // for its approval lock. Read the committed association before declining.
    const settled = await linkedEffect();
    if (settled.rows[0]?.execution_receipt_id) {
      throw new ExecutionOutcomeUnknownError(settled.rows[0].execution_receipt_id);
    }
    throw new ApprovalUnavailableError();
  }

  private async settleStaleReceipt(receipt: { id: string; status: ExecutionReceipt["status"] } | undefined,
    now: number, update: (sql: string, values: unknown[]) => Promise<unknown>): Promise<string | null> {
    if (!receipt) return null;
    if (receipt.status === "reserved") {
      await update(
        `UPDATE omr_control.execution_receipts
         SET status = 'failed', error_code = 'reservation_expired',
           completed_at = $2, updated_at = $2
         WHERE id = $1 AND status = 'reserved'`,
        [receipt.id, now],
      );
      return null;
    }
    if (!["running", "succeeded", "uncertain"].includes(receipt.status)) return null;
    if (receipt.status === "running") {
      await update(
        `UPDATE omr_control.execution_receipts
         SET status = 'uncertain', error_code = 'stale_approval',
           completed_at = $2, updated_at = $2
         WHERE id = $1 AND status = 'running'`,
        [receipt.id, now],
      );
    }
    return receipt.id;
  }

  async consume(input: {
    approvalId: string;
    receiptId: string;
    now: number;
    deadlineAt?: number;
  }): Promise<ExecutionApproval> {
    return this.transition(
      `UPDATE omr_control.execution_approvals AS approval
       SET status = 'consumed', execution_receipt_id = $2, updated_at = $3
       WHERE approval.id = $1 AND approval.status IN ('executing', 'uncertain')
         AND (approval.execution_receipt_id IS NULL OR approval.execution_receipt_id = $2)
         AND EXISTS (SELECT 1 FROM omr_control.execution_receipts AS receipt
           WHERE receipt.id = $2 AND ${EXACT_RECEIPT} AND receipt.status = 'succeeded')
       RETURNING ${COLUMNS}`,
      [input.approvalId, input.receiptId, input.now], input.deadlineAt,
    );
  }

  async succeedWithReceipt(input: { approvalId: string; receipt: ExecutionReceipt;
    result: JsonValue; now: number; deadlineAt: number }): Promise<ExecutionReceipt> {
    if (!this.claimConnectionString) {
      throw new Error("Approved completion requires a dedicated PostgreSQL connection");
    }
    if (this.runOwnedClient) {
      return this.runOwnedClient(input.deadlineAt,
        (client) => this.completeWithClient(input, client, true));
    }
    const deadlineAt = input.deadlineAt;
    const client = new PostgresClient({ connectionString: this.claimConnectionString,
      connectionTimeoutMillis: Math.max(1, deadlineAt - Date.now()) });
    client.on("error", () => undefined);
    try {
      return await this.completeWithClient(input, client, false);
    } finally {
      const closing = client.end();
      try {
        await withinInvocationDeadline(Math.min(deadlineAt, Date.now() + 1_000), () => closing);
      } catch {
        client.connection?.stream.destroy();
        void closing.catch(() => undefined);
      }
    }
  }

  private async completeWithClient(input: { approvalId: string; receipt: ExecutionReceipt;
    result: JsonValue; now: number; deadlineAt: number }, client: Client,
  connected: boolean): Promise<ExecutionReceipt> {
    const deadlineAt = input.deadlineAt;
    const query = <R extends object>(sql: string, values?: unknown[]) =>
      withinInvocationDeadline(deadlineAt, () => client.query<R>(sql, values));
    if (!connected) await withinInvocationDeadline(deadlineAt, () => client.connect());
    try {
      await query("BEGIN");
      await query("SELECT set_config('statement_timeout', $1, true)",
        [`${Math.max(1, deadlineAt - Date.now())}ms`]);
      // Reconciliation takes the approval lock before the receipt lock. Use
      // the same order here so stale recovery and completion cannot deadlock.
      const currentApproval = await query<{ workspace_id: string }>(
        `SELECT workspace_id FROM omr_control.execution_approvals
         WHERE id = $1 AND status = 'executing' FOR UPDATE`,
        [input.approvalId],
      );
      if (currentApproval.rows[0]?.workspace_id !== input.receipt.workspaceId) {
        throw new ApprovalUnavailableError();
      }
      const locked = await query<{ workspace_id: string }>(
        `SELECT receipt.workspace_id FROM omr_control.execution_receipts AS receipt
         JOIN omr_control.execution_approvals AS approval ON ${EXACT_RECEIPT}
         WHERE receipt.id = $1 AND approval.id = $2 AND receipt.status = 'running'
           AND approval.status = 'executing'
         FOR UPDATE OF receipt`,
        [input.receipt.id, input.approvalId],
      );
      if (locked.rows[0]?.workspace_id !== input.receipt.workspaceId) {
        throw new ApprovalUnavailableError();
      }
      const encrypted = await withinInvocationDeadline(deadlineAt, () =>
        encryptJson(input.result, this.wrappingKey,
          { kind: "receipt-result", workspaceId: input.receipt.workspaceId, id: input.receipt.id }));
      await query(
        `UPDATE omr_control.execution_receipts
         SET status = 'succeeded', result_ciphertext = $2, result_iv = $3,
             result_crypto_version = 1, completed_at = $4, updated_at = $4 WHERE id = $1`,
        [input.receipt.id, encrypted.ciphertext, encrypted.iv, input.now],
      );
      await query(
        `UPDATE omr_control.execution_approvals
         SET status = 'consumed', execution_receipt_id = $2, updated_at = $3 WHERE id = $1`,
        [input.approvalId, input.receipt.id, input.now],
      );
      await query("COMMIT");
      return { ...input.receipt, status: "succeeded", result: input.result,
        completedAt: input.now, updatedAt: input.now };
    } catch (error) {
      // A server statement timeout can win the race with our client deadline.
      // The transaction must be rolled back before a fresh completion attempt.
      await withinInvocationDeadline(Date.now() + 500, () => client.query("ROLLBACK"))
        .catch(() => { client.connection?.stream.destroy(); });
      if (error instanceof Error && "code" in error && error.code === "57014" &&
          /statement timeout/i.test(error.message)) throw new ExecutionInvocationDeadlineError();
      throw error;
    }
  }

  async fail(input: { approvalId: string; now: number; deadlineAt?: number }): Promise<ExecutionApproval> {
    return this.transition(
      `UPDATE omr_control.execution_approvals
       SET status = 'failed', updated_at = $2
       WHERE id = $1 AND status = 'executing'
       RETURNING ${COLUMNS}`,
      [input.approvalId, input.now], input.deadlineAt,
    );
  }

  /** Atomically close a verified uncertain intent while preserving its receipt audit. */
  async reconcile(input: { approvalId: string; actorUserId: string; principalKey: string;
    decision: "effect_present" | "effect_absent"; now: number }): Promise<ExecutionApproval> {
    return this.transition(
      `UPDATE omr_control.execution_approvals AS approval
       SET status = CASE WHEN $4 = 'effect_present' THEN 'consumed' ELSE 'failed' END,
           reconciled_as = $4, decided_at = $5, updated_at = $5
       WHERE approval.id = $1 AND approval.actor_user_id = $2 AND approval.principal_key = $3
         AND approval.status = 'uncertain' AND approval.execution_receipt_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM omr_control.workspace_memberships
           WHERE workspace_id = approval.workspace_id AND user_id = $2 FOR SHARE)
         AND EXISTS (SELECT 1 FROM omr_control.execution_receipts AS receipt
           WHERE receipt.id = approval.execution_receipt_id AND ${EXACT_RECEIPT}
             AND (receipt.status = 'uncertain' OR
               ($4 = 'effect_present' AND receipt.status = 'running'))
             AND ($4 <> 'effect_absent' OR receipt.error_code = 'provider_response_ambiguous'))
       RETURNING ${COLUMNS}`,
      [input.approvalId, input.actorUserId, input.principalKey, input.decision, input.now],
    );
  }

  async uncertain(input: {
    approvalId: string;
    receiptId: string | null;
    now: number;
    deadlineAt?: number;
  }): Promise<ExecutionApproval> {
    return this.transition(
      `UPDATE omr_control.execution_approvals AS approval
       SET status = 'uncertain', execution_receipt_id = $2, updated_at = $3
       WHERE approval.id = $1 AND approval.status = 'executing'
         AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM omr_control.execution_receipts AS receipt
           WHERE receipt.id = $2 AND ${EXACT_RECEIPT}
             AND receipt.status IN ('running', 'succeeded', 'uncertain')))
       RETURNING ${COLUMNS}`,
      [input.approvalId, input.receiptId, input.now], input.deadlineAt,
    );
  }

  async listForActor(input: {
    workspaceId: string;
    actorUserId: string;
    limit: number;
  }): Promise<ExecutionApproval[]> {
    const result = await this.query<ApprovalRow>(
      `SELECT ${COLUMNS}
       FROM omr_control.execution_approvals
       WHERE workspace_id = $1 AND actor_user_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [input.workspaceId, input.actorUserId, input.limit],
    );
    return Promise.all(result.rows.map((row) => this.toApproval(row)));
  }

  async listOutstandingProviderForActor(input: { workspaceId: string; actorUserId: string;
    now: number; limit: number }): Promise<ExecutionApproval[]> {
    const result = await this.query<ApprovalRow>(
      `SELECT ${COLUMNS} FROM omr_control.execution_approvals
       WHERE workspace_id = $1 AND actor_user_id = $2
         AND (tool_id LIKE 'linear.%' OR tool_id = 'slack.messages.post' OR
           tool_id IN ('notion.pages.create', 'notion.pages.update'))
         AND (status = 'uncertain' OR
           (status = 'executing' AND tool_id IN ('notion.pages.create', 'notion.pages.update')) OR
           (status IN ('pending', 'approved') AND expires_at > $3))
         AND EXISTS (SELECT 1 FROM omr_control.workspace_memberships
           WHERE workspace_id = $1 AND user_id = $2)
       ORDER BY created_at DESC, id DESC LIMIT $4`,
      [input.workspaceId, input.actorUserId, input.now, input.limit],
    );
    return Promise.all(result.rows.map((row) => this.toApproval(row)));
  }

  async listOutstandingBrowserForActor(input: { workspaceId: string; actorUserId: string;
    now: number; limit: number }): Promise<ExecutionApproval[]> {
    const result = await this.query<ApprovalRow>(
      `SELECT ${COLUMNS} FROM omr_control.execution_approvals
       WHERE workspace_id = $1 AND actor_user_id = $2 AND principal_key = $5
         AND (status IN ('executing', 'uncertain') OR
           (status IN ('pending', 'approved') AND expires_at > $3))
         AND EXISTS (SELECT 1 FROM omr_control.workspace_memberships
           WHERE workspace_id = $1 AND user_id = $2)
       ORDER BY created_at DESC, id DESC LIMIT $4`,
      [input.workspaceId, input.actorUserId, input.now, input.limit, `web:${input.actorUserId}`],
    );
    return Promise.all(result.rows.map((row) => this.toApproval(row)));
  }

  private async transition(query: string, values: unknown[], deadlineAt?: number): Promise<ExecutionApproval> {
    const result = await this.query<ApprovalRow>(query, values, deadlineAt);
    if (!result.rows[0]) throw new ApprovalUnavailableError();
    return this.toApproval(result.rows[0]);
  }

  private async toApproval(row: ApprovalRow): Promise<ExecutionApproval> {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      actorUserId: row.actor_user_id,
      principalKey: row.principal_key,
      toolId: row.tool_id,
      manifestHash: row.manifest_hash,
      connectionId: row.connection_id,
      providerConnectionId: row.provider_connection_id,
      params: await decryptJson(row.params_ciphertext, row.params_iv, this.wrappingKey,
        { kind: "approval-params", workspaceId: row.workspace_id, id: row.id },
        row.params_crypto_version),
      idempotencyKey: row.idempotency_key,
      ...(row.request_hash ? { requestHash: row.request_hash } : {}),
      ...(row.intent_hash ? { intentHash: row.intent_hash } : {}),
      ...(row.reconciled_as ? { reconciledAs: row.reconciled_as } : {}),
      status: row.status,
      approvedBy: row.approved_by,
      decidedAt: row.decided_at === null ? null : Number(row.decided_at),
      expiresAt: Number(row.expires_at),
      executionReceiptId: row.execution_receipt_id,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

}
