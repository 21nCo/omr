# Invocation, approval, and receipt contract

All web, CLI, and MCP tool requests reach the same Worker execution routes and `ExecutionService`.
The Worker authenticates a workspace member or an unexpired client grant, resolves a ready selected
connection, checks action scopes and effect capabilities, and applies one receipt policy. Browser
mutations require a same-origin request; bearer clients use their explicit grant. Reads may execute
immediately. Write, destructive, and unknown-effect actions create an approval with encrypted
parameters and make no provider call until the requesting actor approves it in the web control plane.
The approval binds actor, principal, manifest hash, connection, parameters, requested lifetime,
expiry, and idempotency key. A retry with the same key and different lifetime conflicts; an identical
retry keeps the original expiry. Effectful approval requests require a caller-stable idempotency key
in the web API and CLI. MCP write calls require `_omrIdempotencyKey` in tool arguments; OMR removes
that field before storing or sending provider parameters. A caller reuses the key after a lost
response and chooses a new key for a genuinely new action. Missing or malformed keys are rejected.

On execution, the service atomically claims the approval and rechecks the current manifest, capability,
connection, and scopes. A PostgreSQL transaction then locks the binding, membership, web session or client, and grant
rows through the provider call. A revocation that commits first denies the invocation; a revocation
that starts after these locks waits for the authorized invocation to finish. The receipt reservation
commits on a separate connection **before** calling the provider. It starts as `reserved` and
transitions durably to `running` just before dispatch. A crash after either write leaves a
non-replayable receipt. An ambiguous provider error or a
receipt persistence failure is `uncertain`, with a stable receipt ID and no automatic replay.
The guard has a 60-second end-to-end deadline. It refreshes PostgreSQL's statement timeout with
the remaining invocation time before each authorization query and commit. At the deadline it closes
the dedicated non-pipelined guard connection, canceling an active query and rolling back its
transaction without placing rollback behind a stalled query. A rollback after an earlier failure is
also bounded by the remaining deadline and closes the connection if cleanup stalls. The idle
transaction timeout releases revocation locks if the Worker stops while waiting for the provider.
Pre-dispatch work checks a deadline-bound dispatch callback after fingerprinting
and receipt reservation, so a late continuation cannot call the provider after rollback. The callback
also checks the web session or client grant expiry at dispatch. A pre-dispatch timeout or expiry
attempts to fail a newly reserved receipt without an upstream effect. If the receipt connection
closes first, same-key replay reconciles the durable state after the guard window. A provider call
that outlives the deadline may still finish upstream; its receipt
and approval are marked uncertain and cannot be replayed automatically. Approval and rejection
decisions also require a current workspace membership in the database statement, with a row lock
that serializes concurrent membership removal. Safe reads can use the manifest's retry policy
inside one invocation; effects that may write get one upstream attempt.
Approved completion uses that same original deadline for its separate receipt and approval
transaction. A late provider result cannot open a fresh completion window; the response keeps
the stable receipt ID and reports an uncertain outcome. Successful approval replay rechecks the
current manifest, capability, connection, scopes, membership, session or grant through the same
invocation guard before exposing the saved result. A revoked caller cannot retrieve it.
The provider result is encrypted at rest. History omits results, and public approval
previews mask declared sensitive keys and common credential fields. A contracted preview shows the
action, effect, account, resource metadata and the full redacted argument object without truncation.
An effectful tool with declared sensitive-key metadata gets a complete redacted argument preview.
An unknown-effect tool without sensitive-key metadata or declared resource targets can instead use
an opaque preview: the action, effect, and selected account are shown, but every argument is masked.
The UI explains this before approval. Opaque unknown actions still require an object argument,
caller-stable idempotency key, current authorization, one approval, and one upstream attempt.
Other actions without sensitive-key metadata fail with `EXECUTION_INPUT_INVALID` before storing an
approval or calling the provider. If the manifest changes, every parameter is masked and old
pending approvals cannot be approved or executed. Declared target parameters must also be
present as own properties and visible through every ancestor; a missing, inherited, or redacted
target fails closed. Explicit array indices, `[]` and `[*]` array wildcards, and `*` object-key
wildcards in sensitive paths are redacted in the complete preview. Unsupported selectors fail closed.
Present values with a shape that cannot be traversed by a declared selector fail closed too.
Public responses
omit remote connection handles and internal hashes. Stored request fingerprints are HMACs keyed
with a domain-separated HKDF subkey derived from the server's stable execution wrapping secret.
Old HMAC fingerprints made with the raw wrapping key conflict on retry and remain reserved until
reconciled. Unexpected execution errors log only their class. Approved execution persists
receipt success and approval consumption in one PostgreSQL transaction. If that transaction
fails or its commit response is lost, the service reports an unknown completion with the
receipt ID and does not retry the effect. A committed success remains authoritative even if
the separate invocation guard COMMIT fails afterward: the response and same-key replay
return the successful receipt without another provider call. If an earlier Worker left an
uncertain approval linked to a succeeded receipt, replay verifies the exact association
and reconciles the approval to consumed. Provider ambiguity, a missing-connection reply
after entering the provider action, and receipt persistence failure remain uncertain.
A matching same-key replay of an uncertain read or approval returns the original receipt ID without invoking the provider, even if
the selected binding has since degraded. Approval uncertainty identity still requires current
workspace membership and session or client-grant authorization. A successful result replay also
requires current binding, scope, and guard authorization. A guard transaction owns a separate
PostgreSQL client for each invocation. Each receipt or approval store query owns its own socket,
sets the server statement timeout to the remaining invocation budget, and closes the socket on
timeout; a stalled cleanup write cannot queue the next invocation on a shared client. No schema
migration is needed for this socket-ownership change, and Worker rollback retains the existing
receipt and approval rows.
The HTTP boundary returns `504 EXECUTION_INVOCATION_TIMEOUT` without a receipt ID when the
deadline closes before provider dispatch. After dispatch with an unconfirmed outcome, it returns
`502 EXECUTION_OUTCOME_UNKNOWN` with the receipt ID. CLI JSON errors and MCP structured tool
errors retain these response fields for callers deciding whether to reconcile or retry.
CLI and MCP execution requests allow 70 seconds before aborting the HTTP request, leaving
response time beyond the server's 60-second invocation deadline. Discovery, connection and
approval-request calls keep their shorter client timeout.

## Changed-surface risk matrix

| Boundary | Failure to prevent | Focused evidence |
| --- | --- | --- |
| Web, CLI, MCP routes | Different approval policy or leaked response | `execution-policy-contract`, router, MCP, and origin tests |
| Caller retry key | Lost response creates a second executable approval | Required-key and same-key replay tests on all three surfaces |
| Approval request and claim | Duplicate pending work, expiry, changed params, concurrent use | Service idempotency and single-claim tests |
| Approval projection | Guessable hashes or secrets after manifest change | Projection, decision, and overview-shaped history tests |
| Approval preview | Hidden late target, wildcard secret, missing redaction metadata, stale manifest, primitive secret | Full-length UI preview, wildcard web/CLI/MCP contract, and old-envelope service tests |
| Default unknown action | No contract blocks all actions or exposes an unclassified secret | Opaque request, decision, overview, execute, and web/CLI/MCP contract checks |
| Nested preview | Masked parent or indexed array secret hides the real target or leaks a value | Projection and request/decision/overview/execute tests |
| Whole array secret | An `items[*]` or nested array selector exposes the element itself | Whole-element projection and web/CLI/MCP policy tests |
| Approval decision | Removed member uses a known approval ID or races revocation | PostgreSQL membership-locked decision fixture |
| Fingerprint key | Reusing the encryption key for HMAC | HKDF separation and existing-fingerprint conflict checks |
| Approval completion | Failed consume after successful effect | Successful receipt and non-replayable approval test |
| Legacy key migration | NULL fingerprints and duplicate old keys permit another approval | Migration and store conflict fixtures |
| Web approval execution | Actor/workspace substitution or revoked membership with an empty route workspace | Empty-workspace principal and guard tests |
| Workspace, grant, connection | Cross-workspace use or use after revocation | Service denial and PostgreSQL guard fixture tests |
| Provider and receipt | Second effect after timeout, crash, or ambiguous error | Uncertain replay and reservation tests |
| Store socket lifetime | Timed-out cleanup blocks the next invocation or commits after its deadline | Stalled-write PostgreSQL and runtime lifecycle fixtures |
| Invocation liveness | A near-deadline query or queued rollback holds locks beyond the client timeout; late reservation dispatches after expiry | Queued-client query and rollback deadline fixtures, pre-dispatch cancellation, and uncertain non-replay tests |
| Reservation response loss | INSERT commits but its response is lost as the guard deadline closes the request | Delayed-INSERT fixture, stale reserved replay and no-provider-call checks |
| Client execution deadline | CLI or MCP aborts before a structured timeout or uncertain receipt arrives | Delayed protocol responses beyond the former 30-second client timeout |
| Timeout response | Predispatch timeout becomes a generic 500 or loses its distinction from an uncertain effect | Router, CLI JSON, and MCP protocol tests for read and approved execution |
| Storage | Plaintext parameters or results | PostgreSQL encryption integration test when a disposable database is available |

## Migration and rollback

Apply migrations in numeric order before deploying this Worker. Migration `0012` extends the receipt
status check with `uncertain`, adds nullable approval `request_hash`, and creates a partial unique
index for new approval requests. Migration `0013` replaces any earlier unkeyed fingerprints with
opaque legacy markers. Those rows remain readable, but retrying their idempotency keys conflicts
and requires a new key after reconciliation. Keep the additive schema if rolling the Worker back:
the previous version treats an `uncertain` receipt as non-replayable, and its inserts leave
`request_hash` null. Reapplying `0013` after a rollback removes newly written unkeyed hashes.
Migration `0014` adds the approval `uncertain` state and reserves every original legacy key. Stop
old Worker traffic and drain in-flight approval writes before applying it; keep all old writers
quiesced until the new Worker is deployed and serving requests. The migration has its own
transaction and an exclusive approval-table lock. A consumed, executing, or uncertain duplicate
keeps the original key ahead of any pending or approved sibling, regardless of creation order.
Other duplicates receive collision-checked `legacy~duplicate~<id>~<n>` audit keys (outside the
accepted new-key syntax). Pending and approved duplicates are failed, and executing duplicates
become uncertain for manual reconciliation. NULL fingerprints become opaque legacy markers, and
the approval index becomes unconditional. Apply the file with stop-on-error behavior. If a
statement fails, issue `ROLLBACK` on that migration connection before inspecting data and retrying;
keep traffic quiesced until the schema and Worker are ready. Roll back the Worker
without reversing this additive schema, and quiesce new writers before starting an old Worker.
A downgrade that writes new NULL fingerprints still cannot reuse an existing key. Do not reverse
`0014` while uncertain approvals or duplicate legacy history exist.
Migration `0015` permits the `reserved` receipt state. Apply it before deploying the
new Worker. A reservation stays `reserved` until the durable transition to
`running` has returned and the guard rechecks the dispatch deadline. After 65
seconds, a same-key replay atomically fails a stale `reserved` receipt or marks
a stale `running` receipt `uncertain`. Neither state can dispatch a second
effect. A lost reservation response may leave a `reserved` row until that
replay; list and reconcile it using the original key. Keep `0015` when rolling
back the Worker. The old Worker can read and fail a `reserved` receipt as a
non-replayable state, but rollback must not remove the constraint while these
rows exist. Drain them first if a schema rollback is required.
Migration `0016` adds a nullable, unique `approval_id` to execution receipts.
Quiesce all traffic that reads or writes `execution_receipts`, including history and approval
replay, before applying it. Use a dedicated `psql` session with autocommit enabled and run
`PGOPTIONS='-c lock_timeout=5s -c statement_timeout=300s' psql -X -v ON_ERROR_STOP=1
-f packages/execution/migrations/0016_receipt_approval_identity.sql "$OMR_DATABASE_URL"`.
The two statements commit separately in this executor; a driver call that submits the whole
file as one query instead holds the `ALTER TABLE` lock through the index build and requires
the same full traffic quiescence. Abort the rollout if it
cannot finish within that five-minute window; inspect the index and rerun the
idempotent migration before starting new writers. Do not serve mixed old and
new writers while the build is waiting for a table lock. This bound protects
the deployment window; it is not a claim that production data will build in
five minutes.
Apply it before deploying the Worker that writes the column. New approved
executions store the approval ID with the receipt reservation, before provider
dispatch. Stale approval recovery can attribute only an exact associated
receipt whose operation fields match; `running`, `succeeded`, and `uncertain`
remain outcome-uncertain, while `reserved`, `failed`, and unassociated legacy
receipts cannot certify an external effect. Stale reconciliation fails an exactly
associated `reserved` receipt with `reservation_expired` in the same transaction
that fails its approval; interruption rolls back both changes for a later retry.
An unassociated stale approval is failed and cannot be executed again; inspect
the original key and provider history before any manual retry. Keep `0016` during
Worker rollback: old writers leave the column NULL and old readers ignore it.
Quiesce new writers before an old Worker rollback, and do not drop the column
while associated receipts remain.
Do not reset a `running` or `uncertain` receipt without reconciling the provider
outcome. Rollback does not restore a revoked connection or an expired grant.
This reconciliation and runtime socket shutdown change adds no migration. Drain
in-flight claims and invocations before a Worker rollback; keep the additive schema
and reconcile any predispatch receipts left by the older Worker before retrying keys.

Migration `0017` adds crypto version columns with default 0 for existing AES-GCM rows.
Quiesce all execution, approval, and history access; apply `0017` with the same dedicated
`psql` options and stop-on-error setting as `0016`. Build the new execution package, then run
`OMR_DATABASE_URL=... EXECUTION_RESULT_WRAPPING_KEY=... node
scripts/rebind-execution-ciphertext.mjs` with the existing 32-byte Worker key. The script
locks and re-encrypts one legacy row per transaction with version-1 associated data containing
record kind, workspace ID, and row ID. The Worker and script accept the same canonical
hexadecimal or base64url key encoding. The five-minute deadline bounds connection, queries,
crypto, commit, and socket cleanup; an interrupted row transaction rolls back when its socket
closes. It stops on a bad ciphertext or when that deadline expires;
keep traffic quiesced, inspect the error without exposing plaintext, and rerun after repair.
Verify zero version-0 rows with non-null ciphertext in both tables before deploying the new
Worker with `SELECT count(*) FROM omr_control.execution_approvals WHERE
params_crypto_version = 0 AND params_ciphertext IS NOT NULL` and the equivalent receipt query
for `result_crypto_version` and `result_ciphertext`. Version-0 reads are available only for
migration compatibility; do not resume traffic with legacy rows still present. To roll the Worker
back, quiesce all execution traffic again,
run the same rebind command with `--rollback`, verify zero version-1 rows with non-null
ciphertext in both tables, and only then deploy the previous Worker. Keep the additive `0017`
columns. A rollback deliberately restores legacy, unbound ciphertext until the version-1
rollout is retried. Never reuse a version-1 ciphertext in another row or treat decryption failure
as an empty result.

## Acceptance boundary

OMR-4 requires local contract, unit, protocol, fixture transaction, typecheck, build, and Super
Functions smoke evidence. OMR-15 owns disposable Railway PostgreSQL migration, transaction, replay,
and recovery canaries; connected provider sandbox calls; Cloudflare Preview; authenticated Aside
Browser flows; and real-host checks. These live boundaries are deferred, not passed by local tests.
