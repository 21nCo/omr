# OMR v1 live acceptance (OMR-15)

**Decision: HOLD.** This record is for the integrated `origin/dev` baseline
`c83378bac63a7b7195b3956128befff980a13260` on 2026-10-06. It does not
authorize production deployment or v1-ready provider exposure. OMR-1 remains
In Progress. Keep the GitHub, Linear, Slack, Notion, vault, direct playground,
and assisted playground rollout switches disabled until their observed gates
pass. A later exact-head receipt must replace this hold with the actual live
results and verified resource cleanup.

## Surface and risk inventory

| Surface and owner | Sibling operations and transition | Main risk and focused evidence |
| --- | --- | --- |
| `packages/data`, `packages/identity`, `packages/client-access` | Workspace creation and membership, device grant issue/revoke, personal vault save/replace/delete, assisted quota claim/release | Cross-workspace or cross-user disclosure, stale grant, vault role overreach, migration or rollback loss. Run every `*postgres.integration.test.ts` against disposable Railway PostgreSQL, verify vault grants with the restricted login, and restore from a disposable backup. |
| `packages/connections`, `packages/plugfn-runtime`, `packages/tools` | Connect, select, refresh, reconnect, disconnect; ready, expired, error, revoked | A stale or foreign selection could expose a tool. Prove all four provider sandboxes with scoped read and approved write, missing scope, token revocation, reconnect, and readiness readback. |
| `packages/execution` | Read, approval request/decision/execute, receipt lookup, same-key replay, uncertain reconciliation | Duplicate effects or lost receipts across timeout, crash, and concurrent requests. Use real PostgreSQL and provider writes; repeat original keys after interruption, never retry uncertain effects with a new key. |
| `apps/web` | Login, OAuth/PKCE callback, catalog, clients, key settings, direct and assisted playground | Malformed state or arguments, unauthorized browser session, cached vault reads, unbounded model work, or inaccessible error recovery. Exercise the exact Preview through Aside Browser with keyboard and narrow-screen paths. |
| `packages/cli`, `packages/mcp` | Install/upgrade/uninstall, device login/logout, remote HTTP and local stdio MCP discovery/call | Credential file permissions and interruption recovery differ by platform; host grants must not cross workspaces or survive revocation. Use two real MCP hosts and clean installs on macOS, Linux, and Windows. |
| Cloudflare Worker and Railway | Migration, binding, secret rotation, deploy, diagnostics, rollback, resource deletion | Shared staging bindings, cached vault reads, inaccessible database, or orphan disposable resources. Use an isolated Preview and database; inspect exact bindings and cleanup readbacks. |

The focused matrix covers authorization and retry boundaries, malformed input,
concurrency, interrupted operations, and cleanup. Fixture tests distinguish
code contracts from live behavior; they do not substitute for the named
database, provider, Worker, browser, host, or platform observations.

## Integrated coverage matrix

All implementation children were `Done` in Linear when checked on 2026-10-06.
The PR merge commits below are the exact commits present in the integrated
baseline. The local command for each row was `OMR_SUPERFUNCTIONS_WORKTREE=... npm
test` with Node 22.22.1 in this assigned macOS worktree. It passed 943 tests,
with 88 skipped, including PostgreSQL suites that require
`OMR_TEST_DATABASE_URL`. It was a single integrated run, not a separate run at
each historical PR head. No live result is inferred from the earlier merges.

| Issue | Merged PR and exact commit | Contract surface covered locally | Live observation and remaining risk |
| --- | --- | --- | --- |
| OMR-2 | [#4](https://github.com/21nCo/omr/pull/4) `50810726f76a518a7893bf5924f0b32af05581d2` | Catalog and readiness | Four-provider scoped readiness unverified. |
| OMR-3 | [#5](https://github.com/21nCo/omr/pull/5) `6cd471f5b95aeced2f85925bec2b9b726b9386dc` | Connection lifecycle and selection | Live OAuth, reconnect, revocation and selection unverified. |
| OMR-4 | [#6](https://github.com/21nCo/omr/pull/6) `924f121dcf265ce8da62327f3fcc703fc6e7648d` | Execution policy and receipts | Real database approval, replay and uncertain-effect canaries unverified. |
| OMR-5 | [#7](https://github.com/21nCo/omr/pull/7) `ced728124307a177982777029365fda2b9b44083` | CLI command contract | macOS archive install and removal observed; staged login, upgrade, Linux and Windows unverified. |
| OMR-6 | [#8](https://github.com/21nCo/omr/pull/8) `c6f3bf4fa586eaa3bdadc5be68d4163479977cb7` | Remote MCP contract | Preview HTTP, OAuth/PKCE and real host unverified. |
| OMR-7 | [#9](https://github.com/21nCo/omr/pull/9) `e2d89acabccb5b31bd2c4dc5315fbadd485d9395` | Stdio MCP contract | macOS archive install and removal observed; authenticated host and other platforms unverified. |
| OMR-8 | [#10](https://github.com/21nCo/omr/pull/10) `07dba8a9c294d1246f37044ff3488811ca222805` | GitHub adapter and denials | Composio account auth observed; OMR sandbox journey unverified. |
| OMR-9 | [#11](https://github.com/21nCo/omr/pull/11) `05353c58a5eaa711b00774d0a39ebf1cb6e24a82` | Linear adapter and intent fence | Configured Linear account read observed; OMR sandbox write/reconciliation unverified. |
| OMR-10 | [#12](https://github.com/21nCo/omr/pull/12) `068dd99fb526814ae0b4f733fd2d95a800a9d845` | Slack adapter and denials | Composio account auth observed; OMR bot sandbox journey unverified. |
| OMR-11 | [#13](https://github.com/21nCo/omr/pull/13) `a4023b6f54d95e3bf6587c42f78c50ffc80f1f5a` | Notion adapter and denials | OMR shared-content sandbox journey unverified. |
| OMR-12 | [#14](https://github.com/21nCo/omr/pull/14) `7367b542b0b36d12c63709a4fcbe6bb142455657` | Personal vault contract | Real PostgreSQL grants, cache-disabled Hyperdrive, secret rotation and browser unverified. |
| OMR-13 | [#15](https://github.com/21nCo/omr/pull/15) `c07514cfed00ce83f6cbc0498059633aef68e5d4` | Direct playground contract | Authenticated Preview read/write and accessibility unverified. |
| OMR-14 | [#16](https://github.com/21nCo/omr/pull/16) `c83378bac63a7b7195b3956128befff980a13260` | Assisted turn, quota and recovery contract | OpenRouter key, real database, Preview deadlines and browser recovery unverified. |

## Observed checks on this host

| Check | Command or observation | Result |
| --- | --- | --- |
| Repository base | `git fetch origin dev`; `git merge-base --is-ancestor origin/dev HEAD` | Pass: both were `c83378bac63a7b7195b3956128befff980a13260` before this document. |
| Local suite | `OMR_SUPERFUNCTIONS_WORKTREE=/Users/serro/Documents/dev/n/worktrees/superfunctions/omr-upstream npm test` (Node 22.22.1) | Pass: 943 tests; 88 skipped. This is fixture/code evidence only. |
| Typecheck and build | `npm run typecheck`; `npm run build` (same Node and dependency path) | Pass: 12 tasks each; Turbo cache hits. |
| Dependency smoke | `npm run sf:smoke` (same path) | Pass: 24 imports and two resolutions from clean `omr/upstream` head `615d6f44e08d30166ca67b1a7dbe2251904d52e2`. |
| Railway | `composio execute RAILWAY_LIST_INTEGRATION_AUTHS -d '{}'`; authenticated GraphQL `me` query through `composio proxy` | **Blocked:** both returned `Not Authorized`. No project or database was created. No migration, real SQL test, backup or restore ran. |
| Connected account preflight | Composio GitHub authenticated user, Linear OMR-15/children reads, Slack `auth.test` | Pass for account authentication only. These are not OMR provider sandbox journeys. |
| Cloudflare preflight | Project-local Wrangler 4.136.2 `whoami` | 21n account authenticated. No Preview was created because the required disposable database is unavailable. |
| macOS packaging | `npm pack` for CLI and MCP; install archives into `/tmp/omr15-install`; execute both usage commands; uninstall both and verify binaries absent | Archive installation and removal observed. `omr --help` exited 0; `omr-mcp --help` printed usage and exited 1. `npm ls` reported an invalid local file spec due the `/tmp` to `/private/tmp` path alias; authenticated operation and upgrade remain unverified. |
| Aside Browser and real MCP hosts | No Preview URL or OMR grant exists | Not run. Linux and Windows not run. |

## Required live gates and next run

| Gate | Status | Required acceptance |
| --- | --- | --- |
| `live-database` | Blocked | Restore the configured Railway connection; create an OMR-15/head-named project and public TLS TCP proxy; migrate in numeric order; run the PostgreSQL isolation, selection, approval/receipt, vault, quota, replay and recovery canaries; verify backup/restore and restricted vault grants. |
| `provider-sandboxes` | Unrun | For GitHub, Linear, Slack and Notion: scoped connect/select/refresh/reconnect/disconnect, one read and one approved write, denial/revocation/uncertain effect, and readiness readback. |
| `cloudflare-preview` | Unrun | Create an isolated Worker Preview with nonproduction bindings/secrets; test web, CLI, remote HTTP MCP, local stdio MCP, OAuth/PKCE, approval, receipts, recovery and diagnostics. Delete it and verify absence. |
| `authenticated-browser` | Unrun | With the personal 21n Aside account, record the exact Preview URL and session while testing connection, catalog, direct and assisted playground, key settings, keyboard, accessibility and errors. |
| `external-host-platform` | Partial | Exercise two real MCP hosts and authenticated CLI/stdio calls; finish clean install, upgrade and uninstall on macOS, Linux and Windows, or record platform gaps. |
| `recovery-rollback` | Unrun | Verify migration, secret rotation, backup/restore, Worker rollback and release documentation against disposable infrastructure. |

Use Composio CLI and Railway first, project-local Wrangler second, and Aside
Browser third. Record exact head, environment, commands, observed results,
defects and follow-up PRs in the private acceptance receipt. Delete every
disposable Railway and Cloudflare resource and read back its absence. Any
remaining gap keeps the release decision at HOLD; do not turn an account auth
probe, fixture pass or skipped suite into a live pass.
