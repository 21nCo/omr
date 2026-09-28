-- PostgreSQL cannot alter a CHECK constraint in place. Existing rows remain valid.
ALTER TABLE omr_control.execution_receipts
  DROP CONSTRAINT IF EXISTS execution_receipts_status_check;
ALTER TABLE omr_control.execution_receipts
  ADD CONSTRAINT execution_receipts_status_check
  CHECK (status IN ('running', 'succeeded', 'failed', 'uncertain'));

-- Legacy approvals have no fingerprint; the partial index leaves them readable.
ALTER TABLE omr_control.execution_approvals ADD COLUMN IF NOT EXISTS request_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS execution_approvals_idempotency_idx
  ON omr_control.execution_approvals (workspace_id, principal_key, idempotency_key)
  WHERE request_hash IS NOT NULL;
