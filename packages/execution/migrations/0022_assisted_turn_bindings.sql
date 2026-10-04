-- A request ID is permanently bound to its first model outcome before any tool action.
-- No tool arguments, prompt, provider result, or personal key are stored here.
CREATE TABLE IF NOT EXISTS omr_control.assisted_turn_bindings (
  workspace_id text NOT NULL REFERENCES omr_control.workspaces(id) ON DELETE CASCADE,
  actor_user_id text NOT NULL,
  request_id text NOT NULL,
  request_fingerprint text NOT NULL,
  outcome jsonb NOT NULL,
  action_ciphertext bytea,
  action_iv bytea,
  created_at bigint NOT NULL,
  PRIMARY KEY (workspace_id, actor_user_id, request_id),
  CHECK ((action_ciphertext IS NULL AND action_iv IS NULL)
    OR (action_ciphertext IS NOT NULL AND action_iv IS NOT NULL))
);

REVOKE ALL ON omr_control.assisted_turn_bindings FROM PUBLIC;
