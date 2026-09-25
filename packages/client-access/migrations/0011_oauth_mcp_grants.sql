CREATE TABLE IF NOT EXISTS omr_control.oauth_mcp_grants (
  omr_client_id text PRIMARY KEY REFERENCES omr_control.clients(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  oauth_client_id text NOT NULL,
  redirect_uri text NOT NULL,
  family_key text NOT NULL,
  oauth_grant_id text NOT NULL,
  client_name text NOT NULL,
  workspace_id text NOT NULL REFERENCES omr_control.workspaces(id) ON DELETE CASCADE,
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0),
  created_at bigint NOT NULL,
  revoked_at bigint
);

CREATE UNIQUE INDEX IF NOT EXISTS oauth_mcp_grants_active_family_idx
  ON omr_control.oauth_mcp_grants (user_id, family_key)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS oauth_mcp_grants_user_created_idx
  ON omr_control.oauth_mcp_grants (user_id, created_at DESC);
