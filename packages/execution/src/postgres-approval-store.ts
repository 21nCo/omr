import pg, { type Client, type QueryResult, type QueryResultRow } from "pg";
import type { JsonValue } from "@oh-my-router/tools";

import {
  ApprovalUnavailableError,
  ExecutionIdempotencyConflictError,
  ExecutionInvocationDeadlineError,
  ExecutionOutcomeUnknownError,
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
  idempotency_key, request_hash,
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

export class PostgresExecutionApprovalStore implements ExecutionApprovalStore {
  constructor(
    private readonly client: Client | null,
    private readonly wrappingKey: Uint8Array<ArrayBuffer>,
    private readonly claimConnectionString?: string,
    private readonly ownedQueries?: PostgresOwnedQueries,
    private readonly runOwnedClient?: RunOwnedApprovalClient,
  ) {
    if (wrappingKey.byteLength !== 32) throw new Error("Execution approval wrapping key must be 32 bytes");
    if (!client && !ownedQueries) throw new Error("An execution approval query connection is required");
  }

  private query<R extends QueryResultRow>(sql: string, values?: unknown[],
    deadlineAt?: number): Promise<QueryResult<R>> {
    return this.ownedQueries
      ? this.ownedQueries.query<R>(sql, values, deadlineAt)
      : this.client!.query<R>(sql, values);
  }

  async create(approval: ExecutionApproval): Promise<ExecutionApproval> {
    const encrypted = await encryptJson(approval.params, this.wrappingKey,
      { kind: "approval-params", workspaceId: approval.workspaceId, id: approval.id });
    const result = await this.query<ApprovalRow>(
      `INSERT INTO omr_control.execution_approvals
         (id, workspace_id, actor_user_id, principal_key, tool_id, manifest_hash,
          connection_id, provider_connection_id, params_ciphertext, params_iv, params_crypto_version,
          idempotency_key, request_hash,
          status, approved_by, decided_at, expires_at, execution_receipt_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       ON CONFLICT (workspace_id, principal_key, idempotency_key) DO NOTHING
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
        approval.status,
        approval.approvedBy,
        approval.decidedAt,
        approval.expiresAt,
        approval.executionReceiptId,
        approval.createdAt,
        approval.updatedAt,
      ],
    );
    if (result.rows[0]) return this.toApproval(result.rows[0]);
    const existing = await this.query<ApprovalRow>(
      `SELECT ${COLUMNS} FROM omr_control.execution_approvals
       WHERE workspace_id = $1 AND principal_key = $2 AND idempotency_key = $3`,
      [approval.workspaceId, approval.principalKey, approval.idempotencyKey],
    );
    if (!existing.rows[0]) throw new Error("Approval reservation disappeared");
    if (existing.rows[0].request_hash !== approval.requestHash) {
      throw new ExecutionIdempotencyConflictError();
    }
    return this.toApproval(existing.rows[0]);
  }

  async getForActor(approvalId: string, actorUserId: string,
    deadlineAt?: number): Promise<ExecutionApproval> {
    return this.transition(
      `SELECT ${COLUMNS} FROM omr_control.execution_approvals
       WHERE id = $1 AND actor_user_id = $2
         AND EXISTS (SELECT 1 FROM omr_control.workspace_memberships
                     WHERE workspace_id = execution_approvals.workspace_id AND user_id = $2)`,
      [approvalId, actorUserId], deadlineAt,
    );
  }

  async approve(input: {
    approvalId: string;
    actorUserId: string;
    now: number;
  }): Promise<ExecutionApproval> {
    return this.transition(
      `UPDATE omr_control.execution_approvals
       SET status = 'approved', approved_by = $2,
           decided_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
           updated_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
       WHERE id = $1 AND actor_user_id = $2 AND status = 'pending'
         AND expires_at > (SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
           FROM omr_control.workspace_memberships
           WHERE workspace_id = execution_approvals.workspace_id AND user_id = $2 FOR SHARE)
       RETURNING ${COLUMNS}`,
      [input.approvalId, input.actorUserId],
    );
  }

  async reject(input: {
    approvalId: string;
    actorUserId: string;
    now: number;
  }): Promise<ExecutionApproval> {
    return this.transition(
      `UPDATE omr_control.execution_approvals
       SET status = 'rejected',
           decided_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
           updated_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
       WHERE id = $1 AND actor_user_id = $2 AND status = 'pending'
         AND expires_at > (SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
           FROM omr_control.workspace_memberships
           WHERE workspace_id = execution_approvals.workspace_id AND user_id = $2 FOR SHARE)
       RETURNING ${COLUMNS}`,
      [input.approvalId, input.actorUserId],
    );
  }

  async claim(input: {
    approvalId: string;
    actorUserId: string;
    principalKey: string;
    now: number;
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
    principalKey: string; now: number; deadlineAt: number }, client: Client,
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
         AND expires_at > (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
         AND EXISTS (SELECT 1 FROM omr_control.workspace_memberships
                     WHERE workspace_id = execution_approvals.workspace_id AND user_id = $2 FOR SHARE)
       RETURNING ${COLUMNS}`,
      [input.approvalId, input.actorUserId, input.principalKey, Date.now()],
    );
      if (claimed.rows[0]) {
        const clock = await query<{ now_ms: string }>(
          "SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms");
        if (Number(claimed.rows[0].expires_at) <= Number(clock.rows[0]?.now_ms)) {
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
           WHERE workspace_id = approval.workspace_id AND user_id = $2)
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
