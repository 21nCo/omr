# OMR v1 live acceptance (OMR-15)

**Decision: HOLD. Do not release or roll forward to production.** This record
covers the integrated `origin/dev` baseline
`c83378bac63a7b7195b3956128befff980a13260` (runs on 2026-10-06 and
2026-10-09), then `6a43e8f5b6a663f299b8b13fe0d69eb974f940ca` with Super
Functions `omr/upstream` `faa3042940e76d0775d38fd0d1cf712927cf6234` (run on
2026-10-10), plus the OMR-15 fixes below. It does not authorize production
deployment or v1-ready provider exposure. OMR-1 remains In Progress. Keep the
GitHub, Linear, Slack, Notion, vault, direct playground, and assisted
playground rollout switches disabled in staging and production. The rollback
position is the current one: every v1 rollout switch off, which this run
observed returning the documented disabled responses. A later exact-head
receipt must replace this hold once the remaining gates pass.

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
baseline. Local evidence is one integrated run per date, not a separate run at
each historical PR head. Live results are from the 2026-10-09 disposable
environment described below; none is inferred from earlier merges.

| Issue | Merged PR and exact commit | Live observation (2026-10-09) | Remaining risk |
| --- | --- | --- | --- |
| OMR-2 | [#4](https://github.com/21nCo/omr/pull/4) `50810726f76a518a7893bf5924f0b32af05581d2` | Preview web, CLI, stdio and HTTP MCP all reported GitHub, Linear, Slack and Notion as `unconfigured` with no ready tools. | Ready-state readback needs provider OAuth applications. |
| OMR-3 | [#5](https://github.com/21nCo/omr/pull/5) `6cd471f5b95aeced2f85925bec2b9b726b9386dc` | Connection PostgreSQL suites passed; empty connection list and disabled connect action observed. | Live connect/select/refresh/reconnect/disconnect unrun. |
| OMR-4 | [#6](https://github.com/21nCo/omr/pull/6) `924f121dcf265ce8da62327f3fcc703fc6e7648d` | Execution PostgreSQL suites passed except latency-bound fixtures (see database). Unknown approvals return `APPROVAL_UNAVAILABLE`. | Provider approval, receipt, replay and uncertain-effect journeys unrun. |
| OMR-5 | [#7](https://github.com/21nCo/omr/pull/7) `ced728124307a177982777029365fda2b9b44083` | macOS and Linux archive install, device login, profiles, workspace denial, reinstall, logout with remote revocation and uninstall passed. | Windows not run. |
| OMR-6 | [#8](https://github.com/21nCo/omr/pull/8) `c6f3bf4fa586eaa3bdadc5be68d4163479977cb7` | Preview `/mcp` bearer, Origin, OAuth 2.1/PKCE, refresh and revocation passed; Codex CLI and Claude Code connected. | Tool calls against connected providers unrun. |
| OMR-7 | [#9](https://github.com/21nCo/omr/pull/9) `e2d89acabccb5b31bd2c4dc5315fbadd485d9395` | `omr-mcp` stdio passed in Codex CLI and Claude Code (macOS) and initialized on Linux. | Windows not run. |
| OMR-8 | [#10](https://github.com/21nCo/omr/pull/10) `07dba8a9c294d1246f37044ff3488811ca222805` | Not exercised: no Preview-registered GitHub OAuth application. 2026-10-10: the PlugFn REST action dispatches in local workerd after the lock update. | Connected journeys unrun. |
| OMR-9 | [#11](https://github.com/21nCo/omr/pull/11) `05353c58a5eaa711b00774d0a39ebf1cb6e24a82` | Not exercised: no Linear OAuth application. | Sandbox write, intent fence and reconciliation unrun. |
| OMR-10 | [#12](https://github.com/21nCo/omr/pull/12) `068dd99fb526814ae0b4f733fd2d95a800a9d845` | Not exercised: no Slack OAuth application. 2026-10-10: `files.upload` dispatches in local workerd after the lock update. | Connected journeys unrun. |
| OMR-11 | [#13](https://github.com/21nCo/omr/pull/13) `a4023b6f54d95e3bf6587c42f78c50ffc80f1f5a` | Not exercised: no Notion OAuth application. 2026-10-10: Notion REST actions dispatch in local workerd after the lock update. | No Notion integration exists. |
| OMR-12 | [#14](https://github.com/21nCo/omr/pull/14) `7367b542b0b36d12c63709a4fcbe6bb142455657` | Defect found and fixed (vault validation). Restricted grants, live-key journey and staged rotation passed; disabled rollout observed on the Preview. | Deployed journey through the dedicated vault Hyperdrive unrun (account limit). |
| OMR-13 | [#15](https://github.com/21nCo/omr/pull/15) `c07514cfed00ce83f6cbc0498059633aef68e5d4` | Preview playground showed the truthful empty state with the tool selector disabled. | Read/write and approval journeys need a connected provider. |
| OMR-14 | [#16](https://github.com/21nCo/omr/pull/16) `c83378bac63a7b7195b3956128befff980a13260` | Assisted quota and binding PostgreSQL suites passed. | Deployed assisted turn needs the vault binding and a connected provider. |

## 2026-10-09 run

Environment: Node 22.22.1 on macOS (Apple silicon); Super Functions
`omr/upstream` `615d6f44e08d30166ca67b1a7dbe2251904d52e2`; Composio Railway
connection `railway_cit-triple` (workspace-scoped `projects` read succeeded;
`me` is not a valid probe for these tokens); project-local Wrangler 4.136.2 on
the 21n account; Aside `u0` personal 21n profile. All resources were named
`omr15-4ce5677` and deleted after use. Credentials stayed in a private mode-0700
directory and were removed after cleanup.

Local validation on the same tree, with the fixes applied: `npm test` passed
6 Node checks and 944 Vitest tests, with 88 PostgreSQL tests skipped because
no `OMR_TEST_DATABASE_URL` was set; their live results are in the database row
below. `npm run typecheck`, `npm run build` and `npm run sf:smoke` passed.

| Gate | Result | Observation |
| --- | --- | --- |
| `live-database` | Passed with noted fixture limits | Railway project `753d6b1e-9611-4aa6-8871-48aa7bb12a2b`, PostgreSQL 16.15, TLS 1.3 `verify-full` against a disposable CA. All 22 migrations applied in numeric order and re-applied idempotently. All 15 PostgreSQL suites ran: 117/122 tests passed at about 65 ms round-trip; 8 of them needed a longer per-test budget. The remaining 5 use sub-100 ms deadlines that a remote round-trip cannot meet. The same 122 tests passed in 29 s on local PostgreSQL 16 with the same migrations. The restricted vault login could use only `omr_identity.openrouter_keys`; reads of users, sessions and every other OMR schema were denied. |
| `cloudflare-preview` | Partial | Preview `23fe80fbfd4b472d9b5372363af26ec0` on `omr-web-staging`, with base config ignored and only disposable bindings. Shared staging bindings and secrets were not used. Health, OAuth metadata, AuthFn sign-up/session, control plane, team creation, catalog, runtime capabilities, Origin denial and unauthenticated denial passed through Hyperdrive `verify-full`. The deployed vault journey is unrun (account limit below). Workers Observability logs were not readable with the Wrangler OAuth token. |
| `authenticated-browser` | Partial | Aside `u0` session `PBkOdQ0IvNiWtn1E` on the exact Preview URL. Passed: keyboard-only sign-up with visible focus, control plane and catalog, team creation, clients, OAuth management, disabled key settings, playground empty state, sign-out, `role="alert"` wrong-password error, and the signed-out device gate. Same-origin 375 px frames found `/device` overflowing (fixed below); `/app`, playground, settings and clients fit. `/oauth/manage` refuses framing and `/login` was not measured at 375 px. |
| `external-host-platform` | Partial | Codex CLI 0.145.0 and Claude Code 2.1.295 called `omr.catalog.providers` over both `omr-mcp` stdio and Preview HTTP. Linux Debian 12 container: archive install, device login, 0700/0600 profile modes, catalog, stdio initialize, reinstall-over-existing, logout with revocation and uninstall. macOS isolated-prefix install and uninstall passed. Gemini CLI 0.62.0 is retired for this account. Windows was not run. |
| `provider-sandboxes` | Blocked | No OMR OAuth applications exist for Linear, Slack or Notion. Staging holds GitHub client secrets only, registered to the staging origin. PlugFn sends `redirect: "error"` from the shared REST action used by GitHub, Notion and Slack; Workers reject it before dispatch. |
| `recovery-rollback` | Partial | `pg_dump`/`pg_restore` into a fresh database matched row counts in all 31 tables and all 98 constraints. Staged vault key rotation, rollback and fail-closed removal are listed below. Preview redeploys toggled the vault rollout off and observed `OPENROUTER_VAULT_DISABLED`. Worker version rollback was not exercised because only the shared staging Worker supports it. |

Remote MCP OAuth evidence: dynamic registration; authorization without PKCE
or with `plain` returned `invalid_request`; an unknown scope returned 400; an
unauthenticated user was sent to login. Cross-origin and foreign-workspace
consent returned 403; a wrong verifier returned `invalid_grant`. Exchange,
MCP call, refresh, MCP call, revocation from `/oauth/manage`, then a 401 MCP
call and a rejected refresh passed. Code replay and denial returned their
OAuth errors.

Vault evidence after the fix ran in local workerd against the disposable
database and the live OpenRouter current-key endpoint. Save, masked status,
cross-user isolation, check, rejected invalid replacement that kept the old
key, replacement, deletion to a ciphertext-free tombstone, and 404 after
deletion all passed. No plaintext key fragment was stored. Rotation: a v1 row
stayed readable after v2 became active, and replacement wrote `key_id` v2.
Rolling the active ID back to v1 still decrypted the v2 row. Removing v2 failed
closed with 503 `OPENROUTER_VAULT_UNAVAILABLE`, while masked status remained
readable.

## 2026-10-10 run

Environment: the task branch rebased onto `origin/dev`
`6a43e8f5b6a663f299b8b13fe0d69eb974f940ca` (staging moved to the `21n-dev`
Cloudflare account), Super Functions `omr/upstream` fast-forwarded to
`faa3042940e76d0775d38fd0d1cf712927cf6234` (21nCo/super-functions#237) and
`superfunctions.lock.json` updated to it. Node 22.22.1 on macOS, Wrangler
4.136.2 with local workerd, Docker PostgreSQL 16.15, and Aside CLI
1.26.1010.1739 driving the personal `u0` profile. All local resources were
named `omr15-20261010` and removed afterwards. No Railway, Cloudflare or
provider resource was created.

| Gate | Result | Observation |
| --- | --- | --- |
| `local-validation` | Passed | `npm test` passed 6 Node checks and 945 Vitest tests, with the 88 PostgreSQL tests skipped. `npm run typecheck`, `npm run build` and `npm run sf:smoke` passed. The PlugFn redirect tests passed in Super Functions (10/10). |
| `plugfn-workerd` | Passed in local workerd, not deployed | A standalone Worker bundling the linked PlugFn ran in workerd. As a control, a raw `fetch` with `redirect: "error"` threw the workerd `Invalid redirect value` TypeError. Through `FetchHttpClient`, GitHub `pulls.get` returned a public pull request. Notion `dataSources.list` and `search` reached Notion and returned HTTP 401 without a token. Slack `files.upload` reached Slack and failed its `ok: true` schema check without a token. A GitHub 302 was rejected as `Redirect blocked` and was not followed. |
| `live-database` | Local only | All 22 migrations applied in order to a fresh PostgreSQL 16.15 container and then re-applied without error. All 15 PostgreSQL suites passed (122/122). Railway was not repeated, because no database code changed since 2026-10-09. The final exact-head run still needs Railway. |
| `remote-mcp-oauth` | Passed in local workerd, not deployed | The 2026-10-09 PKCE script ran against the built Worker in local workerd over HTTPS and passed. Authorization without PKCE, or with `plain`, was refused; an unknown scope returned 400; and an unauthenticated user was sent to login. Cross-origin and foreign-workspace consent returned 403, and a wrong verifier returned `invalid_grant`. The rest passed: exchange, `tools/list`, refresh, `tools/list` again, cross-origin revoke denial, revoke, then 401 on `/mcp` and `invalid_grant` on refresh. Code replay and consent denial returned their OAuth errors. |
| `authenticated-browser` | Passed for narrow screens, local only | Aside `u0` (`aside repl`) on `https://localhost:8788`, with the self-signed certificate accepted for `localhost` only. A UI sign-out then a keyboard sign-in (type email, Tab, type password, Enter) reached `/app`. Measured in same-origin 375 px frames: `/login` signed out and after a wrong password (`role="alert"` "Invalid email or password"), `/app`, `/app/clients`, `/app/settings`, `/app/playground` and `/device` all had `scrollWidth` equal to the frame width and no clipped controls. `/oauth/manage` sends `frame-ancestors 'none'`, so the management and consent pages were measured from their served markup in a 375 px `srcdoc` frame. With one active grant, management measured 815 px wide. Consent with a long redirect URI measured 434 px, with its workspace select clipped. Both are fixed below and re-measured at 375 px. |
| `cloudflare-preview` | Blocked | The local Wrangler OAuth login reaches only the `21n` account. Listing secrets for `omr-web-staging` on `21n-dev` returned `Authentication error [code: 10000]`. Per owner direction, no OMR resource was created on the `21n` production account. |
| `provider-sandboxes` | Blocked | Linear and Slack nonproduction OAuth apps exist, but their client secrets are not available on this host. Their callbacks only match the staging origins, which need `21n-dev` access. The GitHub OAuth app only allows `omr-web-staging.21n.workers.dev` on the production account. No Notion integration exists. |
| `external-host-platform` | Not repeated | No host or packaging change since 2026-10-09. Windows remains an explicit platform gap. |

## Defects and follow-ups

| Finding | Status |
| --- | --- |
| The vault validator passed `redirect: "error"` to `fetch`. Workers reject that mode, so every save and check returned `OPENROUTER_VALIDATION_UNAVAILABLE` and no key could be saved. | Fixed here: `redirect: "manual"`; a 3xx is unavailable and never followed. The regression test models the workerd rejection. |
| `/device` overflowed a 375 px viewport: workspace names widened the grid track and clipped all three controls. | Fixed here with zero-minimum grid tracks; the redeployed Preview measured 375 px with no clipped controls. |
| PlugFn `HttpClient` forwards `redirect` to `fetch`. `plugfn/providers/src/shared/rest-action.ts` and Slack actions send `redirect: "error"`, so GitHub, Notion and Slack actions throw on Workers. | Fixed upstream in `faa3042940e76d0775d38fd0d1cf712927cf6234` (21nCo/super-functions#237); `superfunctions.lock.json` now pins it. Verified in local workerd. Deployed provider journeys are still unrun. |
| A deployed Preview reaching Railway directly (`DATABASE_URL` or `OPENROUTER_VAULT_DATABASE_URL`) failed or returned 500 intermittently. The same code via Hyperdrive, and via local workerd, was reliable. | Deployed Workers must use `HYPERDRIVE` and `OPENROUTER_VAULT_HYPERDRIVE`; direct URLs are for local workerd only. |
| The 21n Cloudflare account is at its 25-Hyperdrive limit. A Preview cannot hold both the primary binding and the dedicated cache-disabled vault binding. | Superseded. The owner clarified that `21n` is the production account. OMR nonproduction resources belong in `21n-dev`, which has capacity, but this host's Wrangler identity cannot reach `21n-dev` (`code: 10000`). `--caching-disabled` read back `caching.disabled=true` with the vault login on the single disposable configuration on 2026-10-09. |
| Five PostgreSQL fixtures assume sub-100 ms database deadlines. | Test-only; they pass locally. Run them near the database or adjust the fixture budgets. |
| `/oauth/manage` and `/oauth/authorize` overflowed a 375 px screen. An unbroken workspace ID widened management to 815 px. On consent, a long redirect URI and the workspace select widened the page to 434 px, because a `<fieldset>` defaults to min-content width. | Fixed here: `<code>` values wrap anywhere, the select is limited to its container, and the fieldset has a zero minimum width. Both pages re-measured at 375 px with no clipped controls. A contract test covers the served stylesheet. |
| After team creation, focus moves to `<body>`. | Minor accessibility follow-up. |

## Remaining gates and next run

OMR-15 stays open until these pass at one exact head with cleanup readback:

1. Owner actions: give this host's project-local Wrangler access to the
   `21n-dev` account, for example by adding the Wrangler user to `21n-dev`
   or providing a scoped `21n-dev` API token. Make the Linear and Slack
   nonproduction client secrets, and a GitHub OAuth app whose callback
   matches a `21n-dev` origin, available to the acceptance Worker. Create a
   Notion nonproduction integration. Grant observability read access on
   `21n-dev`, or provide another way to read Preview logs.
2. Agree how acceptance may use the exact-match staging callbacks without
   overwriting shared staging, or register a callback for a dedicated
   acceptance Preview origin on `21n-dev`.
3. Repeat the Railway database, Preview, browser, host and recovery matrix at
   that head. Add each provider's scoped connect/select/refresh/reconnect/
   disconnect, one read and one approved write, denial, revocation and
   uncertain-effect journeys. Also run the deployed vault and assisted
   journeys through dedicated Hyperdrive bindings, and repeat the 375 px
   checks on the deployed origin. Windows install/upgrade/uninstall stays an
   explicit platform gap unless a Windows host is provided.

Use Composio CLI and Railway first, project-local Wrangler second, and Aside
Browser third. Delete every disposable Railway and Cloudflare resource and read
back its absence. Do not turn an account auth probe, fixture pass or skipped
suite into a live pass.

## Cleanup readback (2026-10-09)

The Railway `projectDelete` call returned true, and the workspace listing now
shows only the two pre-existing projects. Deleting the Preview succeeded; a
second delete returned `10025` and the URL returned 404. Hyperdrive `get`
returned `2006`. The CA certificate and KV namespace are absent from their
listings. The local Docker PostgreSQL and Linux containers were removed, the
macOS prefix holds no `omr` or `omr-mcp`, and every test grant was revoked
before the database was deleted.

## Cleanup readback (2026-10-10)

The `omr15-20261010-pg` container was removed and `docker ps -a` lists no
`omr15` container. Both local workerd processes were stopped, and the local
KV/cache state and generated secrets were deleted. The OAuth grant left
active for the narrow-screen check was deleted with the database. No
Railway, Cloudflare or provider resource was created in this run.
