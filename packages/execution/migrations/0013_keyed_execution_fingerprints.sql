-- Old unkeyed fingerprints permit offline guesses of low-entropy parameters.
-- Preserve the idempotency reservation while making legacy retries fail closed.
UPDATE omr_control.execution_approvals
SET request_hash = 'legacy-redacted-' || id
WHERE request_hash LIKE 'sha256-%';

UPDATE omr_control.execution_receipts
SET request_hash = 'legacy-redacted-' || id
WHERE request_hash LIKE 'sha256-%';
