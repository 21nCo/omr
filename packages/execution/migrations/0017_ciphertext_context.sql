-- Existing AES-GCM ciphertext has no associated data and remains version 0.
-- New Worker writes version 1 with record type, workspace and row ID bound.
ALTER TABLE omr_control.execution_approvals
  ADD COLUMN IF NOT EXISTS params_crypto_version integer NOT NULL DEFAULT 0;

ALTER TABLE omr_control.execution_receipts
  ADD COLUMN IF NOT EXISTS result_crypto_version integer NOT NULL DEFAULT 0;
