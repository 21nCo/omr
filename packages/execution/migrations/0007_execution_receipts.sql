CREATE TABLE IF NOT EXISTS omr_control.execution_receipts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES omr_control.workspaces(id) ON DELETE CASCADE,
  actor_user_id text NOT NULL,
  principal_key text NOT NULL,
  tool_id text NOT NULL,
  manifest_hash text NOT NULL,
  connection_id text NOT NULL REFERENCES omr_control.connection_bindings(id),
  provider_connection_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  result_ciphertext bytea,
  result_iv bytea,
  error_code text,
  started_at bigint NOT NULL,
  completed_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (workspace_id, principal_key, idempotency_key),
  CHECK (
    (result_ciphertext IS NULL AND result_iv IS NULL)
    OR (result_ciphertext IS NOT NULL AND result_iv IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS execution_receipts_workspace_created_idx
  ON omr_control.execution_receipts (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS execution_receipts_connection_idx
  ON omr_control.execution_receipts (connection_id);
