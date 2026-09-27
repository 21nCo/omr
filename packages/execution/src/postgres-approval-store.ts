import type { Client } from "pg";
import type { JsonValue } from "@oh-my-router/tools";

import {
  ApprovalUnavailableError,
  ExecutionIdempotencyConflictError,
  type ApprovalStatus,
  type ExecutionApproval,
  type ExecutionApprovalStore,
} from "./execution.js";

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

export class PostgresExecutionApprovalStore implements ExecutionApprovalStore {
  constructor(
    private readonly client: Client,
    private readonly wrappingKey: Uint8Array<ArrayBuffer>,
  ) {
    if (wrappingKey.byteLength !== 32) throw new Error("Execution approval wrapping key must be 32 bytes");
  }

  async create(approval: ExecutionApproval): Promise<ExecutionApproval> {
    const encrypted = await this.encrypt(approval.params);
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
       WHERE id = $1 AND actor_user_id = $2`,
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
       SET status = 'approved', approved_by = $2, decided_at = $3, updated_at = $3
       WHERE id = $1 AND actor_user_id = $2 AND status = 'pending' AND expires_at > $3
       RETURNING ${COLUMNS}`,
      [input.approvalId, input.actorUserId, input.now],
    );
  }

  async reject(input: {
    approvalId: string;
    actorUserId: string;
    now: number;
  }): Promise<ExecutionApproval> {
    return this.transition(
      `UPDATE omr_control.execution_approvals
       SET status = 'rejected', decided_at = $3, updated_at = $3
       WHERE id = $1 AND actor_user_id = $2 AND status = 'pending' AND expires_at > $3
       RETURNING ${COLUMNS}`,
      [input.approvalId, input.actorUserId, input.now],
    );
  }

  async claim(input: {
    approvalId: string;
    actorUserId: string;
    principalKey: string;
    now: number;
  }): Promise<ExecutionApproval> {
    return this.transition(
      `UPDATE omr_control.execution_approvals
       SET status = 'executing', updated_at = $4
       WHERE id = $1 AND actor_user_id = $2 AND principal_key = $3
         AND status = 'approved' AND expires_at > $4
       RETURNING ${COLUMNS}`,
      [input.approvalId, input.actorUserId, input.principalKey, input.now],
    );
  }

  async consume(input: {
    approvalId: string;
    receiptId: string;
    now: number;
  }): Promise<ExecutionApproval> {
    return this.transition(
      `UPDATE omr_control.execution_approvals
       SET status = 'consumed', execution_receipt_id = $2, updated_at = $3
       WHERE id = $1 AND status = 'executing'
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
      `UPDATE omr_control.execution_approvals
       SET status = 'uncertain', execution_receipt_id = $2, updated_at = $3
       WHERE id = $1 AND status = 'executing'
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
      params: await this.decrypt(row.params_ciphertext, row.params_iv),
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

  private async encrypt(value: JsonValue): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey("raw", this.wrappingKey, "AES-GCM", false, ["encrypt"]);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(value)),
    );
    return { ciphertext: new Uint8Array(ciphertext), iv };
  }

  private async decrypt(ciphertext: Buffer, iv: Buffer): Promise<JsonValue> {
    const key = await crypto.subtle.importKey("raw", this.wrappingKey, "AES-GCM", false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(iv) },
      key,
      new Uint8Array(ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as JsonValue;
  }
}
