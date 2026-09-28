# OMR CLI

Node.js 22+ command client for an OMR backend. Build with `npm run build --workspace=@oh-my-router/cli`, then create an installable archive with `npm pack --workspace=@oh-my-router/cli`. The archive contains a bundled `omr` executable and has no runtime workspace dependencies. Install that archive from any directory with `npm install -g ./oh-my-router-cli-0.1.0.tgz`.

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

`logout` revokes the remote client before removing its local profile. If the grant was already revoked, it removes the local profile. A network or server error preserves the local profile so revocation can be retried. `logout --local` removes a local profile without contacting the server; use it when the server is unavailable and revoke the grant later in `/app/clients`. A login does not silently replace a profile because that could leave an old grant active.

If the one-time device credential response is lost or local storage fails, check `/app/clients` for a grant to revoke before logging in again.

Headless processes set **all three** environment variables: `OMR_BACKEND`, `OMR_API_KEY`, and `OMR_WORKSPACE_ID`. These bypass profiles. Set `OMR_PROFILE` or `--profile` for a stored profile. Never pass credentials as command arguments. `OMR_CONFIG_DIR` changes the local profile directory.

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

Tool catalog, account selection, execution and approvals use the same authenticated backend routes as the web control plane. `tools run` requests approval when the backend says the effect requires one, returns its ID and idempotency key, and exits 20. `approvals request` requires an explicit idempotency key so an interrupted script can retry safely. A workspace member decides in the browser control plane; `approvals status` checks its state and `approvals execute` runs an approved request. `--connection` selects an account for one request. `--cursor` continues a catalog page. The server owns manifest visibility, capabilities, account access, effects, idempotency, and retry policy. Never retry an uncertain write with a new idempotency key.

Successful commands write one JSON value to stdout. Informational device-login instructions and errors go to stderr. `--json` makes errors JSON too. The CLI never prints a bearer credential or raw server error body. JSON input is limited to 16 KiB, matching the server request limit.

| Exit | Meaning |
| --- | --- |
| 0 | Completed |
| 1 | Other failure, including missing profile or denied workspace |
| 2 | Invalid CLI input or incomplete headless configuration |
| 3 | Invalid or revoked credential |
| 20 | Approval pending |
| 21 | Approval rejected |
| 22 | Approval or device authorization expired |
| 23 | Execution effect uncertain; inspect the receipt or reuse the same idempotency key |
| 24 | Execution timed out before dispatch |

Approval status is bound to the requesting client grant. An approval from another profile cannot be inspected or executed with this one.

## Credential storage and platform evidence

Profiles live in `~/.config/oh-my-router/profiles/<name>.json`, with only an active profile name in `active-profile`. On POSIX, the profile directories are mode `0700` and files mode `0600`. Writes use a temporary file and rename; symlinked profile targets are rejected. The files contain bearer credentials: protect backups and home-directory access. Windows file permissions inherit the user's ACL; clean-install and ACL evidence on Windows, Linux and macOS is deferred to OMR-15, as are live staged login, provider execution and approval handoff. Local fixture tests do not establish those live boundaries.
