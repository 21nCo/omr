-- Retain every retry key that was coalesced into a Linear approval.
-- Install the expanded status check without scanning rows under the brief
-- ACCESS EXCLUSIVE lock needed to replace the old check.
BEGIN;

DO $status$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'omr_control.execution_approvals'::regclass
      AND conname = 'execution_approvals_status_v2_check') THEN
    ALTER TABLE omr_control.execution_approvals
      ADD CONSTRAINT execution_approvals_status_v2_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'executing', 'uncertain', 'consumed', 'failed', 'expired')) NOT VALID;
  END IF;
END
$status$;
ALTER TABLE omr_control.execution_approvals
  DROP CONSTRAINT IF EXISTS execution_approvals_status_check;

CREATE TABLE IF NOT EXISTS omr_control.execution_approval_aliases (
  workspace_id text NOT NULL REFERENCES omr_control.workspaces(id) ON DELETE CASCADE,
  principal_key text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  approval_id text NOT NULL REFERENCES omr_control.execution_approvals(id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, principal_key, idempotency_key)
);

COMMIT;

-- Validation scans existing rows using a weaker lock that permits reads and writes.
ALTER TABLE omr_control.execution_approvals
  VALIDATE CONSTRAINT execution_approvals_status_v2_check;
