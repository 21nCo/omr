import type { Client, QueryResult, QueryResultRow } from "pg";
import type { JsonValue } from "@oh-my-router/tools";

import { EXECUTION_STALE_AFTER_MS,
  type ExecutionReceipt, type ExecutionReceiptStore, type ExecutionStatus } from "./execution.js";
import { decryptJson, encryptJson } from "./postgres-crypto.js";
import { PostgresOwnedQueries } from "./postgres-owned-query.js";

interface ReceiptRow {
  id: string;
  workspace_id: string;
  actor_user_id: string;
  principal_key: string;
  tool_id: string;
  manifest_hash: string;
  connection_id: string;
  provider_connection_id: string;
  idempotency_key: string;
  request_hash: string;
  approval_id: string | null;
  status: ExecutionStatus;
  result_ciphertext: Buffer | null;
  result_iv: Buffer | null;
  result_crypto_version: number;
  error_code: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id, workspace_id, actor_user_id, principal_key, tool_id, manifest_hash,
  connection_id, provider_connection_id, idempotency_key, request_hash, approval_id, status,
  result_ciphertext, result_iv, result_crypto_version, error_code, started_at, completed_at,
  created_at, updated_at`;

export class PostgresExecutionReceiptStore implements ExecutionReceiptStore {
  constructor(
    private readonly client: Client | null,
    private readonly wrappingKey: Uint8Array<ArrayBuffer>,
    private readonly ownedQueries?: PostgresOwnedQueries,
  ) {
    if (wrappingKey.byteLength !== 32) throw new Error("Execution receipt wrapping key must be 32 bytes");
    if (!client && !ownedQueries) throw new Error("An execution receipt query connection is required");
  }

  private query<R extends QueryResultRow>(sql: string, values?: unknown[],
    deadlineAt?: number): Promise<QueryResult<R>> {
    return this.ownedQueries
      ? this.ownedQueries.query<R>(sql, values, deadlineAt)
      : this.client!.query<R>(sql, values);
  }

  async findByIdempotency(input: { workspaceId: string; principalKey: string; idempotencyKey: string;
    deadlineAt?: number }): Promise<ExecutionReceipt | null> {
    const result = await this.query<ReceiptRow>(
      `SELECT ${COLUMNS} FROM omr_control.execution_receipts
       WHERE workspace_id = $1 AND principal_key = $2 AND idempotency_key = $3
         AND EXISTS (SELECT 1 FROM omr_control.workspace_memberships
                     WHERE workspace_id = $1 AND user_id = actor_user_id)`,
      [input.workspaceId, input.principalKey, input.idempotencyKey], input.deadlineAt,
    );
    return result.rows[0] ? this.toReceipt(result.rows[0]) : null;
  }

  /** Read an exact approval receipt even after it leaves bounded history. */
  async findForApproval(input: { workspaceId: string; actorUserId: string; approvalId: string;
    receiptId: string }): Promise<ExecutionReceipt | null> {
    const result = await this.query<ReceiptRow>(
      `SELECT ${COLUMNS} FROM omr_control.execution_receipts
       WHERE id = $1 AND workspace_id = $2 AND actor_user_id = $3 AND approval_id = $4
         AND EXISTS (SELECT 1 FROM omr_control.workspace_memberships
                     WHERE workspace_id = $2 AND user_id = $3)`,
      [input.receiptId, input.workspaceId, input.actorUserId, input.approvalId],
    );
    return result.rows[0] ? this.toReceipt(result.rows[0]) : null;
  }

  async reserve(receipt: ExecutionReceipt, deadlineAt?: number): Promise<{ receipt: ExecutionReceipt; created: boolean }> {
    const result = await this.query<ReceiptRow>(
      `INSERT INTO omr_control.execution_receipts
         (id, workspace_id, actor_user_id, principal_key, tool_id, manifest_hash,
          connection_id, provider_connection_id, idempotency_key, request_hash, approval_id, status,
          error_code, started_at, completed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (workspace_id, principal_key, idempotency_key) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        receipt.id,
        receipt.workspaceId,
        receipt.actorUserId,
        receipt.principalKey,
        receipt.toolId,
        receipt.manifestHash,
        receipt.connectionId,
        receipt.providerConnectionId,
        receipt.idempotencyKey,
        receipt.requestHash,
        receipt.approvalId ?? null,
        receipt.status,
        receipt.errorCode,
        receipt.startedAt,
        receipt.completedAt,
        receipt.createdAt,
        receipt.updatedAt,
      ], deadlineAt,
    );
    if (result.rows[0]) return { receipt: await this.toReceipt(result.rows[0]), created: true };
    const existing = await this.query<ReceiptRow>(
      `UPDATE omr_control.execution_receipts
       SET status = CASE WHEN status = 'reserved' THEN 'failed' ELSE 'uncertain' END,
           error_code = CASE WHEN status = 'reserved' THEN 'reservation_expired'
                             ELSE 'invocation_outcome_unknown' END,
           completed_at = $4, updated_at = $4
       WHERE workspace_id = $1 AND principal_key = $2 AND idempotency_key = $3
         AND approval_id IS NOT DISTINCT FROM $6
         AND request_hash = $7 AND actor_user_id = $8 AND tool_id = $9
         AND manifest_hash = $10 AND connection_id = $11 AND provider_connection_id = $12
         AND status IN ('reserved', 'running') AND started_at <= $5
       RETURNING ${COLUMNS}`,
      [receipt.workspaceId, receipt.principalKey, receipt.idempotencyKey,
        receipt.startedAt, receipt.startedAt - EXECUTION_STALE_AFTER_MS, receipt.approvalId ?? null,
        receipt.requestHash, receipt.actorUserId, receipt.toolId, receipt.manifestHash,
        receipt.connectionId, receipt.providerConnectionId], deadlineAt,
    );
    if (existing.rows[0]) return { receipt: await this.toReceipt(existing.rows[0]), created: false };
    const current = await this.query<ReceiptRow>(
      `SELECT ${COLUMNS} FROM omr_control.execution_receipts
       WHERE workspace_id = $1 AND principal_key = $2 AND idempotency_key = $3`,
      [receipt.workspaceId, receipt.principalKey, receipt.idempotencyKey], deadlineAt,
    );
    if (!current.rows[0]) throw new Error("Idempotency reservation disappeared");
    return { receipt: await this.toReceipt(current.rows[0]), created: false };
  }

  async beginDispatch(receiptId: string, now: number, deadlineAt?: number): Promise<void> {
    const updated = await this.query(
      `UPDATE omr_control.execution_receipts SET status = 'running', updated_at = $2
       WHERE id = $1 AND status = 'reserved' RETURNING id`,
      [receiptId, now], deadlineAt,
    );
    if (!updated.rows[0]) throw new Error("Execution reservation is unavailable");
  }

  async succeed(receiptId: string, result: JsonValue, now: number,
    deadlineAt?: number): Promise<ExecutionReceipt> {
    const context = await this.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM omr_control.execution_receipts WHERE id = $1 AND status = 'running'`,
      [receiptId], deadlineAt,
    );
    if (!context.rows[0]) throw new Error("Execution receipt is not running");
    const encrypted = await encryptJson(result, this.wrappingKey,
      { kind: "receipt-result", workspaceId: context.rows[0].workspace_id, id: receiptId });
    const updated = await this.query<ReceiptRow>(
      `UPDATE omr_control.execution_receipts
       SET status = 'succeeded', result_ciphertext = $1, result_iv = $2,
           result_crypto_version = 1,
           completed_at = $3, updated_at = $3
       WHERE id = $4 AND status = 'running'
       RETURNING ${COLUMNS}`,
      [encrypted.ciphertext, encrypted.iv, now, receiptId], deadlineAt,
    );
    if (!updated.rows[0]) throw new Error("Execution receipt is not running");
    return this.toReceipt(updated.rows[0]);
  }

  async fail(receiptId: string, errorCode: string, now: number,
    deadlineAt?: number): Promise<ExecutionReceipt> {
    const updated = await this.query<ReceiptRow>(
      `UPDATE omr_control.execution_receipts
       SET status = 'failed', error_code = $1, completed_at = $2, updated_at = $2
       WHERE id = $3 AND status IN ('reserved', 'running')
       RETURNING ${COLUMNS}`,
      [errorCode, now, receiptId], deadlineAt,
    );
    if (!updated.rows[0]) throw new Error("Execution receipt is not running");
    return this.toReceipt(updated.rows[0]);
  }

  async uncertain(receiptId: string, errorCode: string, now: number,
    deadlineAt?: number): Promise<ExecutionReceipt> {
    const updated = await this.query<ReceiptRow>(
      `UPDATE omr_control.execution_receipts
       SET status = 'uncertain', error_code = $1, completed_at = $2, updated_at = $2
       WHERE id = $3 AND status = 'running'
       RETURNING ${COLUMNS}`,
      [errorCode, now, receiptId], deadlineAt,
    );
    if (!updated.rows[0]) throw new Error("Execution receipt is not running");
    return this.toReceipt(updated.rows[0]);
  }

  async listForActor(input: {
    workspaceId: string;
    actorUserId: string;
    limit: number;
  }): Promise<ExecutionReceipt[]> {
    const result = await this.query<ReceiptRow>(
      `SELECT ${COLUMNS}
       FROM omr_control.execution_receipts
       WHERE workspace_id = $1 AND actor_user_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [input.workspaceId, input.actorUserId, input.limit],
    );
    return Promise.all(result.rows.map((row) => this.toReceipt(row)));
  }

  private async toReceipt(row: ReceiptRow): Promise<ExecutionReceipt> {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      actorUserId: row.actor_user_id,
      principalKey: row.principal_key,
      toolId: row.tool_id,
      manifestHash: row.manifest_hash,
      connectionId: row.connection_id,
      providerConnectionId: row.provider_connection_id,
      idempotencyKey: row.idempotency_key,
      requestHash: row.request_hash,
      approvalId: row.approval_id,
      status: row.status,
      result: row.result_ciphertext && row.result_iv
        ? await decryptJson(row.result_ciphertext, row.result_iv, this.wrappingKey,
          { kind: "receipt-result", workspaceId: row.workspace_id, id: row.id },
          row.result_crypto_version)
        : null,
      errorCode: row.error_code,
      startedAt: Number(row.started_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
