# Linear v1 issue journey

OMR publishes `linear.workspace.get`, `linear.teams.list`, `linear.issues.list`,
`linear.issues.get`, `linear.issues.create`, and `linear.issues.update` from its
bounded Linear adapter. The same typed catalog and approval contract serve the
browser, CLI, and MCP. OMR does not publish Linear comments, projects, admin
operations, labels, assignee changes, workflow state transitions, or webhooks.

The rollout flag `OMR_LINEAR_V1_ENABLED=true` and a configured Linear OAuth
client are both required to expose connections. The flag defaults off until
OMR-15 records live sandbox acceptance. Configure `PLUGFN_LINEAR_CLIENT_ID`
and `PLUGFN_LINEAR_CLIENT_SECRET`, and register
`https://<OMR origin>/app/oauth/callback` in the Linear OAuth app.

In `/app`, choose a workspace, connection ownership, and one access tier:

| Tier | Requested Linear OAuth scopes | OMR actions |
| --- | --- | --- |
| Read | `read` | Workspace, team, and issue discovery and issue read |
| Issue write | `read,write` | Reads and approved issue creation or update |

Linear's `write` scope permits broader changes at the provider than OMR exposes.
OMR limits its action catalog and checks the selected connection's recorded
grant before dispatch. A live `workspace.get` probe checks that the selected
token still reads Linear; provider target checks run for each action. If the
grant changes, reconnect with fresh consent. Health, refresh, selection, and
disconnect use the shared connection lifecycle. Disconnect stops local use and
selection before provider cleanup; if remote revocation cannot be confirmed,
follow the guidance in the connection list. See [Linear OAuth scopes](https://linear.app/developers/oauth-2-0-authentication).

Read `linear.workspace.get` first and use its `id` as `linearWorkspaceId` in
every other action. This is Linear's workspace ID, distinct from the OMR
workspace ID. The selected token's current Linear organization must match it.
Choose `teamId` from `teams.list` and `issueId` from `issues.list`; each list
returns one cursor page of at most 50 items. `issues.create` accepts a title,
optional description and priority in one selected team. `issues.update` accepts
only title, description and priority on one selected issue. A missing or foreign
team or issue is denied before mutation. Every create/update requires an OMR
approval with the selected account and explicit target in its preview. The
browser's approval card then has a separate execute step. CLI exposes approval
request, status, execution, and reconciliation. MCP exposes approval request,
status, execution, and reconciliation;
review and approve the pending request in the browser control plane.
For an uncertain Linear write, inspect the receipt and verify the issue in
Linear before choosing **effect happened** in the browser,
`omr approvals reconcile <approvalId> --decision effect_present|effect_absent`,
or `omr.approvals.reconcile` in MCP. This decision is recorded against the
original approval. **No effect** is available only when OMR received a
completed but ambiguous mutation response; a transport error or invocation
timeout may leave the original provider request running, so its approval
remains fenced even if the issue is not visible yet. A verified no-effect
decision for a completed response permits a retry; an
effect-present decision closes the attempt. Either decision requires a new
approval before any later identical change; reconciliation itself never
dispatches a mutation.
An exact linked receipt may still say `running` when its final state could not
be persisted. A verified effect-present decision can close that approval; the
no-effect choice stays unavailable. The browser shows at most 50 current
unresolved Linear approvals alongside recent history. Expired pending and
approved requests have no action buttons. To recover an older unresolved
approval, enter its exact approval ID in **Find an older Linear approval by ID**;
OMR checks the current actor and selected OMR workspace before showing that
approval and its linked receipt. The same lookup recovers a recorded decision
after a lost reconciliation response, including an approval older than the
overview page. A repeated issue action also selects its original approval by
ID. CLI clients use `omr approvals status`; MCP clients use
`omr.approvals.status` with the original grant. Repeating the same
reconciliation decision is safe and does not send another issue mutation;
the opposite decision is denied. If neither the response nor status confirms
the decision, keep the outcome unknown and inspect the approval before retrying.
An expired, rejected, or ordinarily completed lookup is retired from the
browser view; a mistyped or foreign ID is denied, and the current workspace
overview loads without showing controls from that lookup.

The browser retains a request key for the selected action while its form and
account stay the same. Repeating that submission reports the original approval
even after success or an effect-present reconciliation. Use **Start a new
creation action** or **Start a new update action** to deliberately repeat
identical values. CLI and MCP callers supply their own stable key and must
reuse it for retries; a new key represents a new action after settlement.

A definite Linear read or preflight denial fails safely. GraphQL
`RATELIMITED`, a token rejection, and a permission denial return safe error
codes; rate limit responses expose available reset timing. A definite
mutation rejection settles its receipt. A transport failure or incomplete
mutation result with GraphQL errors after dispatch stays uncertain. Repeating
the same issue change returns its existing unresolved approval, including when
a fresh idempotency key is supplied. Unknown read or preflight query
errors return `LINEAR_QUERY_REJECTED`, never an issue-change error. See
[Linear rate limits](https://linear.app/developers/rate-limiting).

Apply execution migrations `0018_linear_intent_fence.sql` and
`0019_linear_approval_aliases.sql` before serving the
Linear write journey. Drain older Worker writers during that change: they do
not populate the intent hash or key aliases and cannot participate in the
approval fence. An expired pending approval reports `expired`; its key remains
bound to that history while a new key can request a new approval.

`tests/acceptance/linear-adapter-contract.test.ts` exercises the typed schemas,
OAuth tiers, selected Linear workspace and issue targets, approval, OMR workspace
isolation, revocation, and provider error classification with fixtures. These
tests do not prove provider sandbox permissions, database integration,
Cloudflare behavior, or authenticated browser/CLI/MCP operation. OMR-15 owns
those live checks and the decision to enable Linear v1 readiness.
