-- Retain every retry key that was coalesced into a Linear approval.
BEGIN;

ALTER TABLE omr_control.execution_approvals
  DROP CONSTRAINT IF EXISTS execution_approvals_status_check;
ALTER TABLE omr_control.execution_approvals
  ADD CONSTRAINT execution_approvals_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'executing', 'uncertain', 'consumed', 'failed', 'expired'));

CREATE TABLE IF NOT EXISTS omr_control.execution_approval_aliases (
  workspace_id text NOT NULL REFERENCES omr_control.workspaces(id) ON DELETE CASCADE,
  principal_key text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  approval_id text NOT NULL REFERENCES omr_control.execution_approvals(id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, principal_key, idempotency_key)
);

COMMIT;
