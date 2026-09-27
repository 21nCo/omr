import pg, { type Client } from "pg";

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
} from "./execution.js";
import { decryptJson, encryptJson } from "./postgres-crypto.js";

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
  connection_id, provider_connection_id, params_ciphertext, params_iv, idempotency_key, request_hash,
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

export class PostgresExecutionApprovalStore implements ExecutionApprovalStore {
  constructor(
    private readonly client: Client,
    private readonly wrappingKey: Uint8Array<ArrayBuffer>,
    private readonly claimConnectionString?: string,
  ) {
    if (wrappingKey.byteLength !== 32) throw new Error("Execution approval wrapping key must be 32 bytes");
  }

  async create(approval: ExecutionApproval): Promise<ExecutionApproval> {
    const encrypted = await encryptJson(approval.params, this.wrappingKey);
    const result = await this.client.query<ApprovalRow>(
      `INSERT INTO omr_control.execution_approvals
         (id, workspace_id, actor_user_id, principal_key, tool_id, manifest_hash,
          connection_id, provider_connection_id, params_ciphertext, params_iv, idempotency_key, request_hash,
          status, approved_by, decided_at, expires_at, execution_receipt_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
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
    const existing = await this.client.query<ApprovalRow>(
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

  async getForActor(approvalId: string, actorUserId: string): Promise<ExecutionApproval> {
    return this.transition(
      `SELECT ${COLUMNS} FROM omr_control.execution_approvals
       WHERE id = $1 AND actor_user_id = $2
         AND EXISTS (SELECT 1 FROM omr_control.workspace_memberships
                     WHERE workspace_id = execution_approvals.workspace_id AND user_id = $2)`,
      [approvalId, actorUserId],
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
    if (!this.claimConnectionString && this.client instanceof PostgresClient) {
      throw new Error("Approval claims require a dedicated PostgreSQL connection");
    }
    const client = this.claimConnectionString
      ? new PostgresClient({ connectionString: this.claimConnectionString,
        connectionTimeoutMillis: Math.max(1, input.deadlineAt - Date.now()) }) : this.client;
    const query = <R extends object>(sql: string, values?: unknown[]) =>
      withinInvocationDeadline(input.deadlineAt, () => client.query<R>(sql, values));
    if (client !== this.client) {
      client.on("error", () => undefined);
    }
    let claimTransactionOpen = false;
    try {
      if (client !== this.client) {
        await withinInvocationDeadline(input.deadlineAt, () => client.connect());
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
    } finally {
      await this.closeClaimClient(client);
    }
  }

  private async rethrowClaimError(error: unknown, transactionOpen: boolean,
    client: Client, deadlineAt: number): Promise<never> {
    if (transactionOpen && Date.now() < deadlineAt) {
      await withinInvocationDeadline(deadlineAt, () => client.query("ROLLBACK")).catch(() => undefined);
    }
    if (error instanceof ExecutionOutcomeUnknownError) throw error;
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
    const prior = await query<Pick<ApprovalRow, "execution_receipt_id">>(
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
    if (prior.rows[0]?.execution_receipt_id) {
      throw new ExecutionOutcomeUnknownError(prior.rows[0].execution_receipt_id);
    }
    // A timed-out claim can commit before its response is lost. Once the
    // invocation and cleanup budgets are past, reconcile its original key
    // without ever making that approval executable a second time.
    const stale = await query<{ status: ApprovalStatus; execution_receipt_id: string | null }>(
      `UPDATE omr_control.execution_approvals AS approval
       SET status = CASE WHEN EXISTS (
         SELECT 1 FROM omr_control.execution_receipts AS receipt
         WHERE ${EXACT_RECEIPT}
           AND receipt.status IN ('running', 'succeeded', 'uncertain')
       ) THEN 'uncertain' ELSE 'failed' END,
         execution_receipt_id = (
           SELECT id FROM omr_control.execution_receipts AS receipt
           WHERE ${EXACT_RECEIPT}
             AND receipt.status IN ('running', 'succeeded', 'uncertain') LIMIT 1
         ), updated_at = $4
        WHERE approval.id = $1 AND approval.actor_user_id = $2 AND approval.principal_key = $3
         AND approval.status = 'executing' AND approval.execution_receipt_id IS NULL
         AND approval.updated_at <= $5
         AND EXISTS (SELECT 1 FROM omr_control.workspace_memberships
           WHERE workspace_id = approval.workspace_id AND user_id = $2)
       RETURNING approval.status, approval.execution_receipt_id`,
      [input.approvalId, input.actorUserId, input.principalKey, Date.now(),
        Date.now() - EXECUTION_STALE_AFTER_MS],
    );
    if (stale.rows[0]?.execution_receipt_id) {
      throw new ExecutionOutcomeUnknownError(stale.rows[0].execution_receipt_id);
    }
    throw new ApprovalUnavailableError();
  }

  async consume(input: {
    approvalId: string;
    receiptId: string;
    now: number;
  }): Promise<ExecutionApproval> {
    return this.transition(
      `UPDATE omr_control.execution_approvals AS approval
       SET status = 'consumed', execution_receipt_id = $2, updated_at = $3
       WHERE approval.id = $1 AND approval.status = 'executing'
         AND EXISTS (SELECT 1 FROM omr_control.execution_receipts AS receipt
           WHERE receipt.id = $2 AND ${EXACT_RECEIPT} AND receipt.status = 'succeeded')
       RETURNING ${COLUMNS}`,
      [input.approvalId, input.receiptId, input.now],
    );
  }

  async fail(input: { approvalId: string; now: number }): Promise<ExecutionApproval> {
    return this.transition(
      `UPDATE omr_control.execution_approvals
       SET status = 'failed', updated_at = $2
       WHERE id = $1 AND status = 'executing'
       RETURNING ${COLUMNS}`,
      [input.approvalId, input.now],
    );
  }

  async uncertain(input: {
    approvalId: string;
    receiptId: string | null;
    now: number;
  }): Promise<ExecutionApproval> {
    return this.transition(
      `UPDATE omr_control.execution_approvals AS approval
       SET status = 'uncertain', execution_receipt_id = $2, updated_at = $3
       WHERE approval.id = $1 AND approval.status = 'executing'
         AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM omr_control.execution_receipts AS receipt
           WHERE receipt.id = $2 AND ${EXACT_RECEIPT}
             AND receipt.status IN ('running', 'succeeded', 'uncertain')))
       RETURNING ${COLUMNS}`,
      [input.approvalId, input.receiptId, input.now],
    );
  }

  async listForActor(input: {
    workspaceId: string;
    actorUserId: string;
    limit: number;
  }): Promise<ExecutionApproval[]> {
    const result = await this.client.query<ApprovalRow>(
      `SELECT ${COLUMNS}
       FROM omr_control.execution_approvals
       WHERE workspace_id = $1 AND actor_user_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [input.workspaceId, input.actorUserId, input.limit],
    );
    return Promise.all(result.rows.map((row) => this.toApproval(row)));
  }

  private async transition(query: string, values: unknown[]): Promise<ExecutionApproval> {
    const result = await this.client.query<ApprovalRow>(query, values);
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
      params: await decryptJson(row.params_ciphertext, row.params_iv, this.wrappingKey),
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
