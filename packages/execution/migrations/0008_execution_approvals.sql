CREATE TABLE IF NOT EXISTS omr_control.execution_approvals (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES omr_control.workspaces(id) ON DELETE CASCADE,
  actor_user_id text NOT NULL,
  principal_key text NOT NULL,
  tool_id text NOT NULL,
  manifest_hash text NOT NULL,
  connection_id text NOT NULL REFERENCES omr_control.connection_bindings(id),
  provider_connection_id text NOT NULL,
  params_ciphertext bytea NOT NULL,
  params_iv bytea NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('pending', 'approved', 'rejected', 'executing', 'consumed', 'failed')
  ),
  approved_by text,
  decided_at bigint,
  expires_at bigint NOT NULL,
  execution_receipt_id text REFERENCES omr_control.execution_receipts(id),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS execution_approvals_actor_pending_idx
  ON omr_control.execution_approvals (workspace_id, actor_user_id, status, expires_at);
