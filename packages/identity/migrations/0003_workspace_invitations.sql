CREATE TABLE IF NOT EXISTS omr_control.workspace_invitations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES omr_control.workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash text NOT NULL UNIQUE,
  created_by text NOT NULL,
  expires_at bigint NOT NULL,
  accepted_at bigint,
  accepted_by text,
  revoked_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CHECK (accepted_at IS NULL OR accepted_by IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS workspace_invitations_workspace_idx
  ON omr_control.workspace_invitations (workspace_id);
CREATE INDEX IF NOT EXISTS workspace_invitations_email_idx
  ON omr_control.workspace_invitations (email);
