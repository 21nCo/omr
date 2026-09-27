-- Keep approvals whose provider outcome may have been dispatched available for reconciliation.
ALTER TABLE omr_control.execution_approvals
  DROP CONSTRAINT IF EXISTS execution_approvals_status_check;
ALTER TABLE omr_control.execution_approvals
  ADD CONSTRAINT execution_approvals_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'executing', 'uncertain', 'consumed', 'failed'));

-- Origin/dev allowed duplicate keys and NULL fingerprints. Retain the oldest row as the
-- reservation for each original key; keep later rows for audit under unique legacy keys.
-- Unused duplicate approvals cannot be executed, while an in-flight one stays uncertain.
WITH duplicates AS (
  SELECT id, row_number() OVER (
    PARTITION BY workspace_id, principal_key, idempotency_key
    ORDER BY created_at, id
  ) AS position
  FROM omr_control.execution_approvals
)
UPDATE omr_control.execution_approvals AS approval
SET idempotency_key = 'legacy~duplicate~' || approval.id,
    status = CASE
      WHEN approval.status IN ('pending', 'approved') THEN 'failed'
      WHEN approval.status = 'executing' THEN 'uncertain'
      ELSE approval.status
    END,
    updated_at = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
FROM duplicates
WHERE approval.id = duplicates.id AND duplicates.position > 1;

-- A NULL legacy fingerprint must conflict with every new request using the old key.
UPDATE omr_control.execution_approvals
SET request_hash = 'legacy-redacted-' || id
WHERE request_hash IS NULL;

DROP INDEX IF EXISTS omr_control.execution_approvals_idempotency_idx;
CREATE UNIQUE INDEX execution_approvals_idempotency_idx
  ON omr_control.execution_approvals (workspace_id, principal_key, idempotency_key);
