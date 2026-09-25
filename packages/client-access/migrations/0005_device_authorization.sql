CREATE TABLE IF NOT EXISTS omr_control.device_authorizations (
  id text PRIMARY KEY,
  device_code_hash text NOT NULL UNIQUE,
  user_code_hash text NOT NULL UNIQUE,
  client_kind text NOT NULL CHECK (client_kind IN ('cli', 'mcp_stdio')),
  client_name text NOT NULL,
  requested_capabilities text[] NOT NULL CHECK (cardinality(requested_capabilities) > 0),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'consumed')),
  workspace_id text REFERENCES omr_control.workspaces(id) ON DELETE CASCADE,
  user_id text,
  client_id text REFERENCES omr_control.clients(id) ON DELETE CASCADE,
  grant_id text REFERENCES omr_control.client_grants(id) ON DELETE CASCADE,
  sealed_credential text,
  expires_at bigint NOT NULL,
  poll_interval_ms integer NOT NULL CHECK (poll_interval_ms >= 1000),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CHECK (
    (status = 'pending' AND workspace_id IS NULL AND user_id IS NULL AND client_id IS NULL
      AND grant_id IS NULL AND sealed_credential IS NULL)
    OR
    (status = 'approved' AND workspace_id IS NOT NULL AND user_id IS NOT NULL
      AND client_id IS NOT NULL AND grant_id IS NOT NULL AND sealed_credential IS NOT NULL)
    OR
    (status = 'consumed' AND workspace_id IS NOT NULL AND user_id IS NOT NULL
      AND client_id IS NOT NULL AND grant_id IS NOT NULL AND sealed_credential IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS device_authorizations_expires_idx
  ON omr_control.device_authorizations (expires_at);
