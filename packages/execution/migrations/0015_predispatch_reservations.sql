-- Keep a predispatch reservation distinguishable from a provider invocation.
-- Existing running rows remain running because their provider outcome cannot
-- be inferred during migration. Replay will conservatively reconcile stale
-- running rows as uncertain.
ALTER TABLE omr_control.execution_receipts
  DROP CONSTRAINT IF EXISTS execution_receipts_status_check;
ALTER TABLE omr_control.execution_receipts
  ADD CONSTRAINT execution_receipts_status_check
  CHECK (status IN ('reserved', 'running', 'succeeded', 'failed', 'uncertain'));
