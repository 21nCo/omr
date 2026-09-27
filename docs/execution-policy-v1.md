# Invocation, approval, and receipt contract

All web, CLI, and MCP tool requests reach the same Worker execution routes and `ExecutionService`.
The Worker authenticates a workspace member or an unexpired client grant, resolves a ready selected
connection, checks action scopes and effect capabilities, and applies one receipt policy. Browser
mutations require a same-origin request; bearer clients use their explicit grant. Reads may execute
immediately. Write, destructive, and unknown-effect actions create an approval with encrypted
parameters and make no provider call until the requesting actor approves it in the web control plane.
The approval binds actor, principal, manifest hash, connection, parameters, expiry, and idempotency key.

On execution, the service atomically claims the approval and rechecks the current manifest, capability,
connection, and scopes. A PostgreSQL transaction then locks the binding, membership, web session or client, and grant
rows through the provider call. A revocation that commits first denies the invocation; a revocation
that starts after these locks waits for the authorized invocation to finish. The receipt reservation
commits on a separate connection **before** calling the provider. A crash after reservation leaves a
`running` receipt, so retry cannot cause a second provider call. An ambiguous provider error or a
receipt persistence failure is `uncertain`, with a stable receipt ID and no automatic replay. Safe
reads can use the manifest's retry policy inside one invocation; effects that may write get one
upstream attempt. The provider result is encrypted at rest. History omits results, and public approval
previews mask declared sensitive keys and common credential fields. Public responses omit remote
connection handles and internal hashes. Unexpected execution errors log only their class.

## Changed-surface risk matrix

| Boundary | Failure to prevent | Focused evidence |
| --- | --- | --- |
| Web, CLI, MCP routes | Different approval policy or leaked response | `execution-policy-contract`, router, MCP, and origin tests |
| Approval request and claim | Duplicate pending work, expiry, changed params, concurrent use | Service idempotency and single-claim tests |
| Workspace, grant, connection | Cross-workspace use or use after revocation | Service denial and PostgreSQL guard fixture tests |
| Provider and receipt | Second effect after timeout, crash, or ambiguous error | Uncertain replay and reservation tests |
| Storage | Plaintext parameters or results | PostgreSQL encryption integration test when a disposable database is available |

## Migration and rollback

Apply migrations in numeric order before deploying this Worker. Migration `0012` extends the receipt
status check with `uncertain`, adds nullable approval `request_hash`, and creates a partial unique
index for new approval requests. Existing approval rows stay readable; old rows have no fingerprint
and are outside the new index. Keep the additive schema if rolling the Worker back: the previous
version treats an `uncertain` receipt as non-replayable, and its inserts leave `request_hash` null.
Do not reset a `running` or `uncertain` receipt without reconciling the provider outcome. Rollback
does not restore a revoked connection or an expired grant.

## Acceptance boundary

OMR-4 requires local contract, unit, protocol, fixture transaction, typecheck, build, and Super
Functions smoke evidence. OMR-15 owns disposable Railway PostgreSQL migration, transaction, replay,
and recovery canaries; connected provider sandbox calls; Cloudflare Preview; authenticated Aside
Browser flows; and real-host checks. These live boundaries are deferred, not passed by local tests.
