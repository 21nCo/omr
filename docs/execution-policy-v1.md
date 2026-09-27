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
inside one invocation; effects that may write get one
upstream attempt. The provider result is encrypted at rest. History omits results, and public approval
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
reconciled. Unexpected execution errors log only
their class. If the provider receipt succeeds but approval consumption cannot be persisted, the
service reports an unknown completion with the receipt ID and marks the approval uncertain for
reconciliation; it never marks the successful effect failed or retries it. The same state applies
to provider ambiguity, receipt persistence failure, and a guard commit failure after dispatch.
The HTTP boundary returns `504 EXECUTION_INVOCATION_TIMEOUT` without a receipt ID when the
deadline closes before provider dispatch. After dispatch, it returns
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
Migration `0014` adds the approval `uncertain` state and reserves every original legacy key. If
origin/dev contains duplicate keys, the oldest row keeps the original key; later rows receive a
`legacy~duplicate~<id>` audit key (outside the accepted new-key syntax). Pending and approved duplicates are failed, and executing
duplicates become uncertain for manual reconciliation. NULL fingerprints become opaque legacy
markers, and the approval index becomes unconditional. Apply `0014` before deploying the new
Worker. Roll back the Worker without reversing this additive schema; a downgrade that writes new
NULL fingerprints still cannot reuse an existing key. Do not reverse `0014` while uncertain
approvals or duplicate legacy history exist.
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
Do not reset a `running` or `uncertain` receipt without reconciling the provider outcome. Rollback
does not restore a revoked connection or an expired grant.

## Acceptance boundary

OMR-4 requires local contract, unit, protocol, fixture transaction, typecheck, build, and Super
Functions smoke evidence. OMR-15 owns disposable Railway PostgreSQL migration, transaction, replay,
and recovery canaries; connected provider sandbox calls; Cloudflare Preview; authenticated Aside
Browser flows; and real-host checks. These live boundaries are deferred, not passed by local tests.
