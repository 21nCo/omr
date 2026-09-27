# Invocation, approval, and receipt contract

All web, CLI, and MCP tool requests reach the same Worker execution routes and `ExecutionService`.
The Worker authenticates a workspace member or an unexpired client grant, resolves a ready selected
connection, checks action scopes and effect capabilities, and applies one receipt policy. Browser
mutations require a same-origin request; bearer clients use their explicit grant. Reads may execute
immediately. Write, destructive, and unknown-effect actions create an approval with encrypted
parameters and make no provider call until the requesting actor approves it in the web control plane.
The approval binds actor, principal, manifest hash, connection, parameters, requested lifetime,
expiry, and idempotency key. A retry with the same key and different lifetime conflicts; an identical
retry keeps the original expiry.

On execution, the service atomically claims the approval and rechecks the current manifest, capability,
connection, and scopes. A PostgreSQL transaction then locks the binding, membership, web session or client, and grant
rows through the provider call. A revocation that commits first denies the invocation; a revocation
that starts after these locks waits for the authorized invocation to finish. The receipt reservation
commits on a separate connection **before** calling the provider. A crash after reservation leaves a
`running` receipt, so retry cannot cause a second provider call. An ambiguous provider error or a
receipt persistence failure is `uncertain`, with a stable receipt ID and no automatic replay. Safe
reads can use the manifest's retry policy inside one invocation; effects that may write get one
upstream attempt. The provider result is encrypted at rest. History omits results, and public approval
previews mask declared sensitive keys and common credential fields. If the manifest changed, every
parameter is masked because the original sensitive-key list is no longer known. Public responses
omit remote connection handles and internal hashes. Stored request fingerprints are HMACs keyed
with the server's stable execution wrapping secret. Unexpected execution errors log only
their class. If the provider receipt succeeds but approval consumption cannot be persisted, the
service reports an unknown completion with the receipt ID and marks the approval uncertain for
reconciliation; it never marks the successful effect failed or retries it. The same state applies
to provider ambiguity, receipt persistence failure, and a guard commit failure after dispatch.

## Changed-surface risk matrix

| Boundary | Failure to prevent | Focused evidence |
| --- | --- | --- |
| Web, CLI, MCP routes | Different approval policy or leaked response | `execution-policy-contract`, router, MCP, and origin tests |
| Approval request and claim | Duplicate pending work, expiry, changed params, concurrent use | Service idempotency and single-claim tests |
| Approval projection | Guessable hashes or secrets after manifest change | Projection, decision, and overview-shaped history tests |
| Approval completion | Failed consume after successful effect | Successful receipt and non-replayable approval test |
| Legacy key migration | NULL fingerprints and duplicate old keys permit another approval | Migration and store conflict fixtures |
| Web approval execution | Actor/workspace substitution or revoked membership with an empty route workspace | Empty-workspace principal and guard tests |
| Workspace, grant, connection | Cross-workspace use or use after revocation | Service denial and PostgreSQL guard fixture tests |
| Provider and receipt | Second effect after timeout, crash, or ambiguous error | Uncertain replay and reservation tests |
| Storage | Plaintext parameters or results | PostgreSQL encryption integration test when a disposable database is available |

## Migration and rollback

Apply migrations in numeric order before deploying this Worker. Migration `0012` extends the receipt
status check with `uncertain`, adds nullable approval `request_hash`, and creates a partial unique
index for new approval requests. Migration `0013` replaces any earlier unkeyed fingerprints with
opaque legacy markers. Those rows remain readable, but retrying their idempotency keys conflicts
and requires a new key after reconciliation. Keep the additive schema if rolling the Worker back:
the previous version treats an `uncertain` receipt as non-replayable, and its inserts leave
`request_hash` null. Reapplying `0013` after a rollback removes newly written unkeyed hashes.
Migration `0014` adds the approval `uncertain` state and reserves every original legacy key. If
origin/dev contains duplicate keys, the oldest row keeps the original key; later rows receive a
`legacy~duplicate~<id>` audit key (outside the accepted new-key syntax). Pending and approved duplicates are failed, and executing
duplicates become uncertain for manual reconciliation. NULL fingerprints become opaque legacy
markers, and the approval index becomes unconditional. Apply `0014` before deploying the new
Worker. Roll back the Worker without reversing this additive schema; a downgrade that writes new
NULL fingerprints still cannot reuse an existing key. Do not reverse `0014` while uncertain
approvals or duplicate legacy history exist.
Do not reset a `running` or `uncertain` receipt without reconciling the provider outcome. Rollback
does not restore a revoked connection or an expired grant.

## Acceptance boundary

OMR-4 requires local contract, unit, protocol, fixture transaction, typecheck, build, and Super
Functions smoke evidence. OMR-15 owns disposable Railway PostgreSQL migration, transaction, replay,
and recovery canaries; connected provider sandbox calls; Cloudflare Preview; authenticated Aside
Browser flows; and real-host checks. These live boundaries are deferred, not passed by local tests.
