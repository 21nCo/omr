-- Personal keys are keyed only by the AuthFn user, never a workspace.
CREATE TABLE IF NOT EXISTS omr_identity.openrouter_keys (
  user_id text PRIMARY KEY REFERENCES omr_identity.users(id) ON DELETE CASCADE,
  key_id text,
  revision text NOT NULL,
  iv bytea CHECK (octet_length(iv) = 12),
  ciphertext bytea CHECK (octet_length(ciphertext) >= 17),
  last_four text CHECK (length(last_four) = 4),
  validation text CHECK (validation IN ('valid', 'invalid')),
  checked_at bigint,
  deleted boolean NOT NULL DEFAULT false,
  CHECK (
    (deleted AND key_id IS NULL AND iv IS NULL AND ciphertext IS NULL AND last_four IS NULL
      AND validation IS NULL AND checked_at IS NULL)
    OR
    (NOT deleted AND key_id IS NOT NULL AND iv IS NOT NULL AND ciphertext IS NOT NULL
      AND last_four IS NOT NULL AND validation IS NOT NULL AND checked_at IS NOT NULL)
  )
);
REVOKE ALL ON omr_identity.openrouter_keys FROM PUBLIC;
