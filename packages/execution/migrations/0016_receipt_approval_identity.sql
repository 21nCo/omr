-- Additive identity for exact approval-to-receipt recovery. Legacy receipts
-- remain unassociated and cannot be attributed during stale reconciliation.
ALTER TABLE omr_control.execution_receipts
  ADD COLUMN IF NOT EXISTS approval_id text;

CREATE UNIQUE INDEX IF NOT EXISTS execution_receipts_approval_id_unique
  ON omr_control.execution_receipts (approval_id)
  WHERE approval_id IS NOT NULL;
