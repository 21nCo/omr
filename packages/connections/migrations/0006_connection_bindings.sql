CREATE TABLE IF NOT EXISTS omr_control.connection_bindings (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES omr_control.workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_connection_id text NOT NULL,
  ownership text NOT NULL CHECK (ownership IN ('personal', 'workspace')),
  owner_user_id text,
  installed_by text NOT NULL,
  label text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'needs_reauth', 'error', 'revoked')),
  readiness text NOT NULL CHECK (readiness IN ('ready', 'degraded', 'unavailable')),
  health_reason text,
  last_checked_at bigint,
  revoked_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (workspace_id, provider_connection_id),
  CHECK (
    (ownership = 'personal' AND owner_user_id IS NOT NULL)
    OR (ownership = 'workspace' AND owner_user_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS connection_bindings_workspace_provider_idx
  ON omr_control.connection_bindings (workspace_id, provider);
CREATE INDEX IF NOT EXISTS connection_bindings_owner_idx
  ON omr_control.connection_bindings (workspace_id, owner_user_id);

CREATE TABLE IF NOT EXISTS omr_control.connection_selections (
  workspace_id text NOT NULL REFERENCES omr_control.workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  provider text NOT NULL,
  connection_id text NOT NULL REFERENCES omr_control.connection_bindings(id) ON DELETE CASCADE,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (workspace_id, user_id, provider)
);

CREATE INDEX IF NOT EXISTS connection_selections_connection_idx
  ON omr_control.connection_selections (connection_id);
