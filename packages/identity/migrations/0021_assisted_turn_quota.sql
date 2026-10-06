-- One active assisted turn and ten starts per one-hour window per authenticated user.
-- The active lease expires after a Worker interruption; its owner alone may release it.
CREATE TABLE IF NOT EXISTS omr_identity.assisted_turn_quota (
  user_id text PRIMARY KEY REFERENCES omr_identity.users(id) ON DELETE CASCADE,
  window_start_ms bigint NOT NULL,
  request_count integer NOT NULL CHECK (request_count BETWEEN 0 AND 10),
  active_id text,
  active_until_ms bigint NOT NULL DEFAULT 0
);
REVOKE ALL ON omr_identity.assisted_turn_quota FROM PUBLIC;
