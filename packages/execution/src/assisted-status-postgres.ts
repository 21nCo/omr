import pg from "pg";

const { Client } = pg;

/** Show only identifiers and status of this browser actor's exact assisted action. */
export async function lookupPostgresAssistedAction(input: {
  connectionString: string; userId: string; workspaceId: string; requestId: string;
}): Promise<{ approval: { id: string; status: string } | null;
  receipt: { id: string; status: string } | null }> {
  const client = new Client({ connectionString: input.connectionString,
    connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  try {
    await client.connect();
    const params = [input.workspaceId, input.userId, `web:${input.userId}`,
      `assisted_${input.requestId}`];
    const approval = await client.query<{ id: string; status: string }>(`
      SELECT id, status FROM (
        SELECT id, status, 0 AS priority FROM omr_control.execution_approvals
        WHERE workspace_id = $1 AND actor_user_id = $2 AND principal_key = $3
          AND idempotency_key = $4
        UNION ALL
        SELECT approval.id, approval.status, 1 AS priority
        FROM omr_control.execution_approval_aliases AS alias
        JOIN omr_control.execution_approvals AS approval ON approval.id = alias.approval_id
        WHERE alias.workspace_id = $1 AND alias.principal_key = $3
          AND alias.idempotency_key = $4 AND approval.workspace_id = $1
          AND approval.actor_user_id = $2 AND approval.principal_key = $3
      ) AS matching ORDER BY priority LIMIT 1`, params);
    const receipt = await client.query<{ id: string; status: string }>(`
      SELECT id, status FROM omr_control.execution_receipts
      WHERE workspace_id = $1 AND actor_user_id = $2 AND principal_key = $3
        AND idempotency_key = $4 LIMIT 1`, params);
    return { approval: approval.rows[0] ?? null, receipt: receipt.rows[0] ?? null };
  } finally { await client.end().catch(() => undefined); }
}
