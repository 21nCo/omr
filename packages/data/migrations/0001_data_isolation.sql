CREATE SCHEMA IF NOT EXISTS omr_app;
CREATE SCHEMA IF NOT EXISTS omr_control;

REVOKE ALL ON SCHEMA omr_control FROM PUBLIC;

CREATE TABLE IF NOT EXISTS omr_app.workspace_profiles (
  __ns text NOT NULL,
  id text NOT NULL,
  display_name text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  created_by text,
  updated_by text,
  PRIMARY KEY (__ns, id)
);

CREATE INDEX IF NOT EXISTS workspace_profiles_namespace_idx
  ON omr_app.workspace_profiles (__ns);
CREATE INDEX IF NOT EXISTS workspace_profiles_display_name_idx
  ON omr_app.workspace_profiles (display_name);

CREATE TABLE IF NOT EXISTS omr_app.kv (
  __ns text NOT NULL,
  id text NOT NULL,
  value jsonb,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  created_by text,
  updated_by text,
  PRIMARY KEY (__ns, id)
);

CREATE INDEX IF NOT EXISTS kv_namespace_idx ON omr_app.kv (__ns);

CREATE TABLE IF NOT EXISTS omr_control.workspaces (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('personal', 'team')),
  name text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS omr_control.workspace_memberships (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES omr_control.workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS workspace_memberships_user_idx
  ON omr_control.workspace_memberships (user_id);
