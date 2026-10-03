# Notion v1 page journey

OMR publishes `notion.connection.verify`, `notion.content.search`, `notion.pages.get`,
`notion.pages.create`, and `notion.pages.update` through the same typed catalog,
workspace binding, and approval contract used by the browser, CLI, and MCP.
Search returns one cursor page of at most 100 accessible pages and databases.
`pages.get` reads one accessible page's title and parent. Creation makes one
plain titled child beneath an explicitly selected accessible page; update
renames one explicitly selected accessible page. The adapter does not expose
database-row creation, database property edits, page body blocks, comments,
uploads, icons, covers, archiving, broad import, sync, or arbitrary Notion API
calls. Databases found in search are shown for context and cannot be selected
as creation destinations in v1.

`OMR_NOTION_V1_ENABLED=true` and configured `PLUGFN_NOTION_CLIENT_ID` and
`PLUGFN_NOTION_CLIENT_SECRET` are required to offer OAuth connections. The
flag defaults off until OMR-15 records live Notion sandbox acceptance. Register
`https://<OMR origin>/app/oauth/callback` with the Notion integration. Configure
the integration's **read content**, **insert content**, and **update content**
capabilities for the actions used here. Notion's OAuth URL has no named
per-action scopes: its consent screen chooses pages and databases to share.
OMR can see only content exposed to that selected integration token. Share or
unshare content in Notion to change visibility. Reconnect with fresh consent
to change the grant; refresh, health, selection, and disconnect use the shared
connection lifecycle. Disconnect removes OMR use before remote cleanup; if
provider revocation is unconfirmed, revoke the integration in Notion too.

In `/app`, select an OMR workspace and a ready Notion account, search shared
content, choose a page, and read it before requesting a create or rename
approval. A page ID passed through CLI or MCP is checked against the selected
integration immediately before any write. The approval preview includes the
selected account and page target; title text is redacted there. Review it in
the request form before requesting approval. Approving alone does not
write; the originating browser, CLI, or MCP client must separately execute.
The OMR workspace and account binding are checked again at execution, so a
revoked or switched connection cannot be reused. Browser results from an old
workspace or account are discarded.

Reuse the original idempotency key after a lost response. A dispatched write
with an incomplete response or transport error has an unknown outcome; inspect
the exact page in Notion before recording `effect_present` or, only when OMR
permits it for a completed ambiguous response, `effect_absent`. Reconciliation
never dispatches a write. Start a new identical action only after settlement.
Definite Notion authentication, permission, missing-target, validation, and
rate-limit responses use safe error codes. `Retry-After` is preserved when
available. Reads may retry; writes make one provider attempt.

`tests/acceptance/notion-adapter-contract.test.ts` is the fixture-backed
schema, authorization, visibility, approval, isolation, revocation, and
error evidence. It does not prove live provider permissions, Railway Postgres,
Cloudflare Preview, or authenticated browser, CLI, and MCP operation. OMR-15
owns those checks and the decision to enable Notion v1 readiness.

Provider references: [authorization](https://developers.notion.com/docs/authorization),
[search](https://developers.notion.com/reference/post-search),
[create page](https://developers.notion.com/reference/post-page), and
[request limits](https://developers.notion.com/reference/request-limits).
