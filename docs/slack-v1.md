# Slack v1 bot journey

OMR publishes `slack.workspace.get`, `slack.channels.list`, `slack.messages.list`, and
`slack.messages.post` through the same typed catalog and approval contract used by
the browser, CLI, and MCP. It does not expose channel creation, DMs, private or
shared channels, search, file uploads, reactions, user impersonation, webhooks,
background events, scheduled posts, rich blocks, or arbitrary Slack API calls.

`OMR_SLACK_V1_ENABLED=true` and configured `PLUGFN_SLACK_CLIENT_ID` and
`PLUGFN_SLACK_CLIENT_SECRET` are both required to offer OAuth connections. The
flag defaults off until OMR-15 records Slack sandbox acceptance. Register
`https://<OMR origin>/app/oauth/callback` with the Slack app. The v1 adapter
uses a bot token. User tokens and `user_scope` are unsupported; a user token
without a bot identity cannot authorize these actions.

| Access tier | Requested bot scopes | OMR actions |
| --- | --- | --- |
| Discover | `channels:read` | Workspace and joined public-channel discovery |
| Read | `channels:read,channels:history` | Discovery and channel history |
| Post | `channels:read,chat:write` | Discovery and approved message posts |
| Read and post | `channels:read,channels:history,chat:write` | All four actions |

The selected token's `auth.test` response supplies the current Slack workspace,
bot user and effective `X-OAuth-Scopes` header. OMR intersects that header with
the recorded OAuth grant before exposing an action. A missing header grants no
actions; malformed header entries are ignored individually. Refresh does not
add scopes; reconnect with fresh consent to change a tier. Health, selection,
refresh, and disconnect use the shared connection
lifecycle. Disconnect removes local use and selection before provider cleanup;
if remote revocation is unconfirmed, follow the connection list's guidance.

Read `workspace.get` first. Use its `id` as `workspaceId` and its `sender.id`
as `senderId` for a post. These are Slack identifiers, distinct from the OMR
workspace ID. `channels.list` returns one cursor page of at most 100 joined,
local public channels. It omits private, archived, shared, external-shared, and
unjoined channels. Choose a `channelId` from that result. `messages.list`
checks the selected workspace and channel again before reading one page of at
most 100 messages. It displays messages with text and omits events or blocks-only
messages that the v1 text view cannot represent, while retaining the page cursor.
`messages.post` checks that the token still belongs to the chosen Slack
workspace and bot sender and that the channel remains joined and
local, then sends at most 4,000 plain-text characters. It does not accept a
custom username, avatar, thread, blocks, unfurling, or a channel name. Slack
markup parsing is disabled. The response must identify the selected bot by
either its bot user ID or bot ID before OMR records success.

Every post requires OMR approval with account, workspace, channel, sender and
redacted message context in its preview. Browser approval has a separate
execute step. CLI and MCP use their ordinary approval request, status, execute
and reconcile commands; a changed or revoked connection fails at execution.
Reuse the same idempotency key after a lost response. An uncertain post is
fenced against a second identical live intent. Verify the exact message in
Slack before recording `effect_present`. Record `effect_absent` only when OMR
has a completed but ambiguous response and the absence has been verified;
transport failures may leave the original request running. Reconciliation
never posts. An intentional identical post after settlement needs a new key
and a new approval.

Slack `ok:false`, including unfamiliar error codes, authentication, permission,
target and rate-limit responses produce safe codes; available `Retry-After`
seconds are preserved. An
incomplete or lost response after posting remains uncertain. Reads can retry
safely; posts make one provider attempt. Channel membership and workspace
identity can change at the provider after preflight, so the final provider
response still governs the recorded outcome. OMR never claims an uncertain
post did not happen on its own.

`tests/acceptance/slack-adapter-contract.test.ts` supplies fixture evidence for
schemas, scopes, selection, sender identity, approval, revocation, provider
denials and retry fencing. It does not prove Slack sandbox permissions,
Postgres concurrency, Cloudflare Preview, or authenticated browser, CLI and
MCP operation. OMR-15 owns those live checks and any decision to enable
Slack v1 readiness. Consult Slack's [OAuth guide](https://docs.slack.dev/authentication/installing-with-oauth/),
[auth.test](https://docs.slack.dev/reference/methods/auth.test/), and
[chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/)
for provider details.
