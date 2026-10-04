# Bounded assisted playground

OMR-14 adds a single OpenRouter tool choice and, after one read, an optional short answer.
Writes stop at the existing approval; execution still uses the direct approval UI.
`OMR_ASSISTED_PLAYGROUND_ENABLED` remains off until OMR-15's staged personal-key and
connected-provider acceptance. Direct playground use has a separate flag.

Apply `packages/identity/migrations/0021_assisted_turn_quota.sql` after the personal
vault migration before enabling assisted turns. The primary Worker database role needs
`SELECT, INSERT, UPDATE` on `omr_identity.assisted_turn_quota`; the dedicated vault role
must not receive access. A database claim allows one active turn and ten starts per user
hour across Worker instances. A 110-second lease covers a started shared execution
and recovers from interrupted Workers.
Turn processing has a 35-second response deadline. The claim is retained until a started
execution or approval call settles, or the lease expires.

The browser keeps a random request ID against a hash of the current workspace, account,
model and prompt in session storage. It sends that ID again for a retry after cancellation
or a lost response. The shared execution and approval stores use it as the action's
idempotency key. On a pending action, check the visible approval list or retry the same
request before starting another intent. A changed request allocates a different ID.
A completed read or model-only reply clears its retry identity so a deliberate new
submission can run again; a pending approval keeps its identity until settlement.

OMR-14 contract evidence uses fixture model, execution, approval and UI responses, plus
typecheck and build. OMR-15 owns observed Railway PostgreSQL migration and permissions,
OpenRouter and connected-provider sandbox behavior, Cloudflare Preview deadline and
limits, and authenticated Aside Browser recovery with a personal test key. No live
acceptance is implied by the local fixtures.
