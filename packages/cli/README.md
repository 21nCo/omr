# OMR CLI

Node.js 22+ command client for an OMR backend. Create an installable archive with `npm pack --workspace=@oh-my-router/cli`; its `prepack` step builds the executable from a clean checkout. The archive contains a bundled `omr` executable and has no runtime workspace dependencies. Install that archive from any directory with `npm install -g ./oh-my-router-cli-0.1.0.tgz`.

## Authentication and profiles

```
omr login --url https://omr.example --profile work
omr profiles list --json
omr profiles use work
omr profiles show
omr workspaces list
omr workspaces show
omr workspaces use <workspace-id>
omr logout
```

`login` prints a browser verification link and code to stderr, waits for approval, and stores a workspace-scoped device grant. A profile can use only the workspace authorized during login. Log in again under another profile to access another workspace. `--workspace` selects a workspace for one command; the backend rejects a workspace outside the grant. `workspaces use` verifies authorization before saving the selection. `profiles list` and `workspaces list` show local profile metadata, not every workspace available to the browser account.

`logout` revokes the authenticated remote grant before removing its local profile. Other grants on the same client remain usable. A 401 cannot prove revocation: it can also occur when workspace membership was removed while the grant remains live. Any lost, malformed, or failed revoke reply preserves the profile and exits 3 as `REVOCATION_UNVERIFIED`. Check or revoke the grant in `/app/clients` before using `logout --local` to remove the local profile without contacting the server. A login does not silently replace a profile because that could leave an old grant active.
If a profile with the same name is replaced while revocation is in progress, logout reports `PROFILE_CHANGED` and keeps the replacement grant.
If a profile is replaced while `workspaces use` checks authorization, the command reports `PROFILE_CHANGED` and leaves the replacement workspace untouched.
`profiles list` and `workspaces list` skip unreadable profile files and report each filename as `PROFILE_UNREADABLE` on stderr. Select that profile explicitly to see its error; a corrupt sibling does not prevent login under a different name. An existing corrupt profile name cannot be overwritten by login.
If `active-profile` contains an invalid name, both list commands report that filename and show healthy profiles as inactive. Commands that need the default selection report the file error. Use `omr profiles use <name>` to repair the selection; `--profile <name>` remains available while it is corrupt.
An interrupted older CLI may leave a grant in `credentials` without its profile metadata. List commands report the `credentials` filename, and login refuses to reuse that profile name. Revoke the orphaned grant in `/app/clients`, then use `logout --local --profile <name>` to remove its local entry.

If the one-time device credential response is lost, malformed, or cannot be stored, check `/app/clients` for a grant to revoke before logging in again.

Headless processes set **all three** environment variables: `OMR_BACKEND`, `OMR_API_KEY`, and `OMR_WORKSPACE_ID`. These bypass profiles. Set `OMR_PROFILE` or `--profile` for a stored profile. Never pass credentials as command arguments. `OMR_CONFIG_DIR` changes the local profile directory.
`logout` and `logout --local` refuse to touch saved profiles while any headless credential variable is set. Unset all three variables to revoke or remove a saved profile; headless credentials are managed by their issuer.

## Tools, accounts and approvals

```
omr connections list --provider linear --json
omr connections select <connection-id> --provider linear --json
omr tools list --provider linear --effect read --limit 20 --json
omr tools search --query 'find issue' --json
omr tools inspect linear.get_issue --json
omr tools run linear.get_issue --params '{"issue_id":"ABC-1"}' --json
omr tools run linear.get_issue --params @input.json --json
cat input.json | omr tools run linear.get_issue --params - --json
omr tools run linear.get_issue --params-file input.json --json
omr approvals request linear.create_issue --params @input.json --idempotency my-key --json
omr approvals status <approval-id> --json
omr approvals execute <approval-id> --json
```

Tool catalog, account selection, execution and approvals use the same authenticated backend routes as the web control plane. `tools run` requests approval when the backend says the effect requires one, then reports the returned approval state and idempotency key. `approvals request` requires an explicit idempotency key so an interrupted script can retry safely. If an approval response is lost, the CLI exits 23 and prints the key in the error details. Retry the same request with that key to recover the existing approval. A workspace member decides in the browser control plane; `approvals status` checks its state and `approvals execute` runs an approved request. `--connection` selects an account for one request. `--cursor` continues a catalog page. The server owns manifest visibility, capabilities, account access, effects, idempotency, and retry policy. Never retry an uncertain write with a new idempotency key.

When `tools run` generates a key, it writes an `IDEMPOTENCY_KEY` event to stderr **before** sending the request. Capture that key in automation, or supply `--idempotency` yourself. If the process is interrupted after dispatch, repeat the same command and parameters with that key. A malformed or mismatched successful response, or a server error that cannot establish whether a mutation committed, exits 23 with the original retry key or approval ID. Known failed receipts and predispatch timeouts keep their terminal exit codes. Approved execution receipts include the approval ID for this check. Read-only commands reject malformed or mismatched responses as protocol failures.

Successful commands write one JSON value to stdout. Informational device-login instructions and errors go to stderr. `--json` makes errors JSON too. The CLI never prints a bearer credential or raw server error body. JSON input is limited to 16 KiB, matching the server request limit.

| Exit | Meaning |
| --- | --- |
| 0 | Completed |
| 1 | Other failure, including missing profile or denied workspace |
| 2 | Invalid CLI input or incomplete headless configuration |
| 3 | Invalid credential or revocation unverified |
| 20 | Approval pending |
| 21 | Approval rejected |
| 22 | Approval or device authorization expired |
| 23 | Execution effect or approval delivery uncertain; inspect the receipt or reuse the same idempotency key |
| 24 | Execution timed out before dispatch |
| 25 | Execution is still in progress; use the receipt ID and original idempotency key or approval ID to check or retry |

Approval status is bound to the requesting client grant. An approval from another profile cannot be inspected or executed with this one.

## Credential storage and platform evidence

Profiles live in `~/.config/oh-my-router/profiles/<name>.json`, with only an active profile name in `active-profile`. On POSIX, the profile directories are mode `0700` and files mode `0600`. Writes use a temporary file and atomic publication, then flush the file and parent directory before removing any legacy credential copy; symlinked profile targets are rejected. The files contain bearer credentials: protect backups and home-directory access. Windows file permissions inherit the user's ACL; clean-install and ACL evidence on Windows, Linux and macOS is deferred to OMR-15, as are live staged login, provider execution and approval handoff. Local fixture tests do not establish those live boundaries.
After an interrupted write, the next profile mutation removes recognized private temporary files whose writer process has exited. Files from a live writer and unrelated files are retained.
Recovery of an abandoned credential lock uses a separate `credentials.lock.reclaim` guard so two processes cannot remove each other's replacement locks. If the recovering process itself is interrupted, the guard remains and later stale-lock recovery fails closed. Inspect the lock and guard owners before removing that guard manually; active profile operations can still proceed when the regular lock is free.
Profiles created by the prior CLI/MCP release are also readable: it kept the bearer grant in `credentials` and only `workspaceId` in `profiles/<name>.json`. The CLI tightens permissions on that metadata file when first read. An authorized `workspaces use` writes the unified profile and removes its old credential entry; logout removes both formats after confirmed revocation. Keep the old credential file private until every profile has been migrated or removed.
The MCP command also accepts its prior headless setup: `OMR_BACKEND` and `OMR_API_KEY` with a workspace saved in the selected profile (or `default`). Set `OMR_WORKSPACE_ID` to override that selection explicitly. The backend still checks that the supplied grant permits the workspace.
Without a saved workspace, a headless MCP launch requires `OMR_WORKSPACE_ID`.
