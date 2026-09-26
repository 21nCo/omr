# v1 web connection lifecycle

The `/app` control plane supports GitHub, Linear, Slack, and Notion when their
PlugFn adapters are registered. A signed-in workspace member may install a
personal connection. Only a workspace owner or admin may install, refresh,
reconnect, or disconnect a team connection. Personal accounts remain visible
and manageable only to their owner. The server checks membership and role for
every mutation; hiding a button is only guidance.

## Setup and access review

Before enabling a provider, configure its OAuth client ID and secret as Worker
secrets: `PLUGFN_GITHUB_CLIENT_ID` / `PLUGFN_GITHUB_CLIENT_SECRET`, and the
corresponding `LINEAR`, `SLACK`, or `NOTION` pair. Register
`https://<OMR origin>/app/oauth/callback` in each provider application. Set the
Worker's `PLUGFN_ENCRYPTION_KEY`, database connection, and identity secrets as
described in the deployment configuration. Do not expose these values through
public environment variables. A missing pair reports `unconfigured`; the UI
does not offer connection setup. This release does not enable live provider
configuration by default.

OAuth start runs an install authorization check and returns a provider URL. The
browser stores only the short-lived, single-use callback intent in
`sessionStorage`, then displays the actual `scope` and `user_scope` parameters
from that URL before navigation. Users review any provider consent details
there. GitHub requests only `read:user` in this initial flow; its repository
actions need a separate broader grant. Linear and Slack request the scopes
declared by their configured provider adapters. Notion may omit a named OAuth
scope parameter and presents access in its own consent screen. API-key entry
is rendered only for a v1 adapter that reports `api_key`; the key is sent once
to the server and cleared from the form. PlugFn encrypts upstream credentials;
OMR bindings store only a remote connection handle, and HTTP projections omit
that handle.

## State and recovery

The per-user selected account is stored by workspace and provider. A sole ready
account is used automatically; with multiple ready accounts, selection is
required. Selection checks current provider configuration, workspace, owner,
and active/ready status. Health probes can mark a binding `needs_reauth` or
`error`; refresh may restore it only when PlugFn returns an active connection.
An unavailable account cannot be selected or used. Reconnect starts a new OAuth
grant or accepts a new supported credential and leaves the old failed binding
visible for cleanup. Failed or denied callbacks show an error and consume the
browser's pending intent. A later attempt must start a new authorization.

Disconnect first revokes the local binding, deletes selections, and records
`provider_cleanup_pending`, then asks PlugFn to revoke/delete the upstream
grant. Local use stops even if provider revocation times out or the Worker is
interrupted. A remote failure is shown without raw provider details;
the user can retry provider cleanup or revoke the grant at the provider. A
revoked binding cannot become ready through a concurrent probe or refresh.

## Migration and rollback

No database schema migration is needed: this uses the existing
`connection_bindings` and `connection_selections` tables from migration 0006.
The code rollout is reversible by deploying the previous Worker version;
existing binding and selection rows stay readable by that version. Revocation
is intentionally terminal and is never rolled back into a usable credential.
If a rollout fails after local revocation but before provider cleanup, retry
the provider revoke or remove the grant in the provider account. Do not restore
the deleted OMR selection or reuse the old binding.

## Acceptance boundary

OMR-3 requires fixture-backed connection lifecycle, role isolation, redaction,
callback, and UI policy tests plus build/typecheck. OMR-15 owns live provider
accounts and OAuth callbacks, disposable Railway PostgreSQL isolation, a
Cloudflare Preview deployment, authenticated Aside Browser flows, and staged
secret checks. Those live boundaries are deferred and have no pass claim here.
