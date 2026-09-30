# GitHub v1 journey

OMR exposes five GitHub actions from its pinned PlugFn adapter: `github.account.get`,
`github.repos.listPublic`, `github.repos.listPrivate`, `github.repos.get`, and
`github.issues.commentPublic`. Other upstream GitHub actions, including pull
requests, issue creation, repository changes, and hooks, are unsupported in OMR
v1. The action IDs, typed inputs and outputs, effect, scope, and retry contract
are the same in HTTP, the CLI, and MCP. Catalog visibility is scoped to the
selected workspace and effective connection.

## Connect and choose access

Configure the GitHub OAuth client ID and secret as Worker secrets and register
`https://<OMR origin>/app/oauth/callback` in the OAuth app. In `/app`, choose a
workspace and personal or team ownership, then select a GitHub access tier:

The Worker also requires `OMR_GITHUB_V1_ENABLED=true` to offer the GitHub
connection. It defaults off even if OAuth credentials are present. OMR-15 owns
turning it on in an isolated sandbox, then deciding when live v1 exposure is
supported by observed evidence.

| Tier | Requested GitHub OAuth scopes | OMR actions |
| --- | --- | --- |
| Account and public reads (default) | `read:user` | Account identity, public repository list and repository read |
| Public issue comments | `read:user public_repo` | Above plus approved public issue comments |
| Private repository reads | `read:user repo` | Account and public reads, plus private repository list |

The `repo` grant is broad in GitHub: it permits repository writes at the token
level even though OMR exposes no private write action. Choose it
only when private repository access is needed. GitHub may normalize scopes in
its token response. OMR checks the selected token's effective `X-OAuth-Scopes`
on an authenticated GitHub response for each catalog or execution request;
requested scopes and PlugFn's stored fallback do not authorize an action. If
GitHub omits that header, no GitHub action is authorized. A failed provider
verification authorizes no GitHub action. Discovery hides GitHub tools while
keeping other providers visible; direct execution and approval return a safe
reconnect, access-denied, or rate-limit error. Retry after the indicated rate
window or reconnect the account as directed.
See [GitHub's OAuth scope reference](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
for the provider's current permission definitions.
OMR requires an explicit `public_repo` grant for its public-comment action; a
`repo`-only connection does not expose that action. An absent scope record never
authorizes an action. Changing tiers requires a new OAuth consent and connection;
refresh alone does not add scopes. Review the exact authorization URL scopes in
OMR before visiting GitHub and review GitHub's own consent screen.

`github.account.get` identifies the selected account. Use the connection's
Health action to update readiness. If health or refresh marks it expired,
reconnect and reselect the new binding. Disconnect removes local access and
selection immediately; OMR displays provider-side revocation guidance if
remote revocation cannot be confirmed. Team connections require owner/admin
management; personal connections remain visible only to their owner.

## Read and comment

`github.repos.listPublic` forces GitHub's `visibility=public`; callers cannot
turn it into a private listing by passing another filter. Pagination is bounded
to five 100-item pages per call. `github.repos.listPrivate` forces
`visibility=private` and requires `repo`. `github.repos.get` reads one repository
by `owner` and `repo`; a private target needs `repo` and the account's actual
repository permission. A private repository that GitHub hides may return 404.
OMR reports that as `GITHUB_REPOSITORY_UNAVAILABLE`, with guidance to check
the name and private access. A definite read 401 asks for reconnect, 403 asks
for access/scope review, and rate limit 403 or 429 returns `GITHUB_RATE_LIMITED`.
OMR returns GitHub's available `Retry-After` and reset time with that error.
It does not wait through a GitHub 429 retry window inside the current invocation;
retry the read after the indicated time.
Missing known grants fail before the provider call with the required scope in
`EXECUTION_INPUT_INVALID`.

For the one v1 write journey, connect with **Public issue comments**, select
the intended GitHub account, and discover `github.issues.commentPublic`. For
example, the CLI can request a comment with:

```sh
omr connections list --provider github --json
omr connections select <connection-id> --provider github --json
omr tools run github.account.get --params '{}' --json
omr tools run github.repos.listPublic --params '{"maxPages":1}' --json
omr approvals request github.issues.commentPublic --params '{"owner":"org","repo":"public-repo","issueNumber":1,"body":"Reviewed"}' --idempotency comment-1 --json
omr approvals status <approval-id> --json
omr approvals execute <approval-id> --json
```

The browser approval preview shows the selected account, repository, issue,
and redacted body. OMR makes zero comment POST requests before approval and
uses one provider attempt after approval. A preflight repository read refuses
an unverified public target. A private, malformed, or denied repository
preflight fails the receipt with an explicit safe error before any comment
POST. A confirmed comment POST rejection (401, 403, 404, 410, 422, or 429)
also fails the receipt and approval, with reconnect, access, issue/repository,
gone-resource, validation/spam, or rate-limit guidance. Rate-limited preflight
and POST responses include available retry and reset timing; request a new
approval only after resolving the rejection.
If a write outcome is uncertain, reconcile the receipt and provider state; do
not repeat it with a new idempotency key. MCP
clients use the same catalog and approval flow and must refresh a long-lived
catalog after connecting, selecting, or changing grants.

## Evidence and rollout

`tests/acceptance/github-adapter-contract.test.ts`,
`tests/acceptance/github-provider-boundaries.test.ts`, and the connection/router
fixtures prove local schemas, scope tiers, selection, approval, revocation,
provider error handling, and zero write before approval. They do not prove
GitHub sandbox permissions or deployment behavior. OMR-15 owns connected
GitHub sandbox read/write smoke through browser, CLI, and MCP; private access
and exact scopes; disposable database and Cloudflare Preview checks; and
real-host evidence. Do not describe GitHub as live v1-ready until OMR-15 records
those observations.
