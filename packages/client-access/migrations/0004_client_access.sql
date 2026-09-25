CREATE TABLE IF NOT EXISTS omr_control.clients (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES omr_control.workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('cli', 'mcp_remote', 'mcp_stdio', 'headless')),
  name text NOT NULL,
  registered_by text NOT NULL,
  revoked_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (id, workspace_id)
);

CREATE INDEX IF NOT EXISTS clients_workspace_idx
  ON omr_control.clients (workspace_id);

CREATE TABLE IF NOT EXISTS omr_control.client_grants (
  id text PRIMARY KEY,
  client_id text NOT NULL,
  workspace_id text NOT NULL REFERENCES omr_control.workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  capabilities text[] NOT NULL CHECK (cardinality(capabilities) > 0),
  credential_hash text NOT NULL UNIQUE,
  expires_at bigint NOT NULL,
  revoked_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  FOREIGN KEY (client_id, workspace_id)
    REFERENCES omr_control.clients(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS client_grants_client_idx
  ON omr_control.client_grants (client_id);
CREATE INDEX IF NOT EXISTS client_grants_workspace_user_idx
  ON omr_control.client_grants (workspace_id, user_id);
