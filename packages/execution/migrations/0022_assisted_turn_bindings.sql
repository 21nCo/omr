-- A request ID is bound to its first model outcome before any tool action.
-- Model-only responses and tool arguments are encrypted; no prompt, provider result,
-- or personal key is stored here. Expired rows are purged on subsequent access.
CREATE TABLE IF NOT EXISTS omr_control.assisted_turn_bindings (
  workspace_id text NOT NULL REFERENCES omr_control.workspaces(id) ON DELETE CASCADE,
  actor_user_id text NOT NULL,
  request_id text NOT NULL,
  request_fingerprint text NOT NULL,
  outcome jsonb NOT NULL,
  outcome_ciphertext bytea,
  outcome_iv bytea,
  action_ciphertext bytea,
  action_iv bytea,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  PRIMARY KEY (workspace_id, actor_user_id, request_id),
  CHECK ((outcome_ciphertext IS NULL AND outcome_iv IS NULL)
    OR (outcome_ciphertext IS NOT NULL AND outcome_iv IS NOT NULL)),
  CHECK ((action_ciphertext IS NULL AND action_iv IS NULL)
    OR (action_ciphertext IS NOT NULL AND action_iv IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS assisted_turn_bindings_expiry_idx
  ON omr_control.assisted_turn_bindings (expires_at);

REVOKE ALL ON omr_control.assisted_turn_bindings FROM PUBLIC;
