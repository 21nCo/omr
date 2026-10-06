# Bounded assisted playground

OMR-14 adds a single OpenRouter tool choice and, after one read, a local result preview.
Writes stop at the existing approval; execution still uses the direct approval UI.
`OMR_ASSISTED_PLAYGROUND_ENABLED` remains off until OMR-15's staged personal-key and
connected-provider acceptance. Direct playground use has a separate flag.

Apply `packages/identity/migrations/0021_assisted_turn_quota.sql` and
`packages/execution/migrations/0022_assisted_turn_bindings.sql` in numeric order before
enabling assisted turns. The primary Worker database role needs `SELECT, INSERT, UPDATE`
on the quota table and `SELECT, INSERT, DELETE` on the binding table; the dedicated
vault role must not receive access. The binding table
stores only the first selected action metadata, an HMAC request fingerprint, encrypted
model-only responses, and encrypted action arguments under the execution wrapping key.
Bindings expire after 24 hours and are purged on later binding access; execution receipts
and approvals continue to fence prior actions. A database claim allows one active turn and ten starts per user
hour across Worker instances. A 110-second lease covers a started shared execution and
recovers from interrupted Workers.
Turn processing has a 35-second response deadline. The claim is retained until a started
execution or approval call settles, or the lease expires.

The browser keeps a random request ID against a hash of the current workspace, account,
model and prompt in session storage. It sends that ID again for a retry after cancellation
or a lost response. The shared execution and approval stores use it as the action's
idempotency key. The first persisted selection is recovered before another model call;
changed model, prompt, or account data with the same ID is rejected. On a pending action,
check the visible approval list or retry the same request before starting another intent.
A changed request allocates a different ID.
A completed read or model-only reply clears its retry identity so a deliberate new
submission can run again; a pending approval keeps its identity until settlement.
Before binding expiry, a retry of a committed read replays its receipt through current
execution policy and displays its result without another provider invocation. If current
access is denied, the result is withheld.

OMR-14 contract evidence uses fixture model, execution, approval and UI responses, plus
typecheck and build. OMR-15 owns observed Railway PostgreSQL migration and permissions,
OpenRouter and connected-provider sandbox behavior, Cloudflare Preview deadline and
limits, and authenticated Aside Browser recovery with a personal test key. No live
acceptance is implied by the local fixtures.

After a read, a bounded projection of fixed public status and navigation phrases in
known nonsensitive fields can appear in the local answer. Unknown fields and their
values are redacted; other prose, including possible credential assertions or requests
to supply a value, is withheld from the preview. No tool result is sent to OpenRouter.
The assisted response and recovery path include only a bounded, redacted receipt preview
and its identifier. A separate download fetches the full receipt by its saved request ID
through current authenticated execution policy. The browser never renders an unexpected
unbounded result from the assisted response.
