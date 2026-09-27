-- Run as one transaction so the writer barrier covers reconciliation and index creation.
BEGIN;

-- Keep approvals whose provider outcome may have been dispatched available for reconciliation.
ALTER TABLE omr_control.execution_approvals
  DROP CONSTRAINT IF EXISTS execution_approvals_status_check;
ALTER TABLE omr_control.execution_approvals
  ADD CONSTRAINT execution_approvals_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'executing', 'uncertain', 'consumed', 'failed'));

-- The deploy must quiesce old writers before this migration. Within the migration
-- transaction, exclude concurrent writers while ranking and allocating audit keys.
LOCK TABLE omr_control.execution_approvals IN ACCESS EXCLUSIVE MODE;

-- An effect-bearing row owns the original key even when it was created later.
-- Allocate audit keys against every original and previously allocated key.
DO $reconcile$
DECLARE
  duplicate record;
  candidate text;
  suffix bigint;
BEGIN
  FOR duplicate IN
    SELECT id, workspace_id, principal_key, status FROM (
      SELECT id, workspace_id, principal_key, status, created_at,
        row_number() OVER (
          PARTITION BY workspace_id, principal_key, idempotency_key
          ORDER BY CASE WHEN status IN ('consumed', 'executing', 'uncertain') THEN 0 ELSE 1 END,
            created_at, id
        ) AS position
      FROM omr_control.execution_approvals
    ) ranked
    WHERE position > 1
    ORDER BY workspace_id, principal_key, created_at, id
  LOOP
    suffix := 0;
    LOOP
      candidate := 'legacy~duplicate~' || duplicate.id || '~' || suffix;
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM omr_control.execution_approvals
        WHERE workspace_id = duplicate.workspace_id AND principal_key = duplicate.principal_key
          AND idempotency_key = candidate
      );
      suffix := suffix + 1;
    END LOOP;
    UPDATE omr_control.execution_approvals
    SET idempotency_key = candidate,
      status = CASE
        WHEN duplicate.status IN ('pending', 'approved') THEN 'failed'
        WHEN duplicate.status = 'executing' THEN 'uncertain'
        ELSE duplicate.status
      END,
      updated_at = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
    WHERE id = duplicate.id;
  END LOOP;
END
$reconcile$;

-- A NULL legacy fingerprint must conflict with every new request using the old key.
UPDATE omr_control.execution_approvals
SET request_hash = 'legacy-redacted-' || id
WHERE request_hash IS NULL;

DROP INDEX IF EXISTS omr_control.execution_approvals_idempotency_idx;
CREATE UNIQUE INDEX execution_approvals_idempotency_idx
  ON omr_control.execution_approvals (workspace_id, principal_key, idempotency_key);

COMMIT;
