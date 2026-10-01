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
browser's approval card then has a separate execute step. CLI and MCP use the
same approval request, status, approval, and execution protocol.

A definite Linear read or preflight denial fails safely. GraphQL
`RATELIMITED`, a token rejection, and a permission denial return safe error
codes; rate limit responses expose available reset timing. A definite
mutation rejection settles its receipt. A transport failure or malformed
mutation response after dispatch stays uncertain and must be reconciled in
Linear before any new approval. See [Linear rate limits](https://linear.app/developers/rate-limiting).

`tests/acceptance/linear-adapter-contract.test.ts` exercises the typed schemas,
OAuth tiers, selected Linear workspace and issue targets, approval, OMR workspace
isolation, revocation, and provider error classification with fixtures. These
tests do not prove provider sandbox permissions, database integration,
Cloudflare behavior, or authenticated browser/CLI/MCP operation. OMR-15 owns
those live checks and the decision to enable Linear v1 readiness.
