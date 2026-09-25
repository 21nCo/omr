CREATE SCHEMA IF NOT EXISTS omr_identity;
REVOKE ALL ON SCHEMA omr_identity FROM PUBLIC;

CREATE TABLE IF NOT EXISTS omr_identity.users (
  id text PRIMARY KEY,
  primary_email text,
  email_verified_at timestamptz,
  metadata jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS authfn_users_primary_email_idx
  ON omr_identity.users (primary_email);

CREATE TABLE IF NOT EXISTS omr_identity.sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES omr_identity.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  csrf_hash text,
  methods jsonb NOT NULL,
  metadata jsonb,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_authenticated_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS authfn_sessions_expires_at_idx
  ON omr_identity.sessions (expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS authfn_sessions_token_hash_idx
  ON omr_identity.sessions (token_hash);
CREATE INDEX IF NOT EXISTS authfn_sessions_user_created_idx
  ON omr_identity.sessions (user_id, created_at);

CREATE TABLE IF NOT EXISTS omr_identity.password_credentials (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES omr_identity.users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS authfn_password_credentials_user_idx
  ON omr_identity.password_credentials (user_id);
