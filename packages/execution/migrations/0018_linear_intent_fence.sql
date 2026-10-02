-- One unresolved Linear intent owns all approval keys for its principal.
ALTER TABLE omr_control.execution_approvals ADD COLUMN IF NOT EXISTS intent_hash text;
ALTER TABLE omr_control.execution_approvals ADD COLUMN IF NOT EXISTS reconciled_as text
  CHECK (reconciled_as IN ('effect_present', 'effect_absent'));

CREATE UNIQUE INDEX IF NOT EXISTS execution_approvals_live_intent_unique
  ON omr_control.execution_approvals (workspace_id, principal_key, intent_hash)
  WHERE intent_hash IS NOT NULL
    AND status IN ('pending', 'approved', 'executing', 'uncertain');
