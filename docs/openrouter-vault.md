# Personal OpenRouter key vault (OMR-12)

The web settings route is `/app/settings`; its API is `GET/PUT/DELETE /api/settings/openrouter` and `POST /api/settings/openrouter/check`. It accepts only an authenticated browser user. Mutations require the request's own Origin. The API has no workspace or owner parameter. It returns only masked status, validation state and check time, with `Cache-Control: no-store`. CLI and MCP grants cannot use it. The future playground must call `OpenRouterVault.withKey` with the freshly authenticated user ID for each request and must not cache the decrypted key across requests or put it in a receipt.

`OMR_OPENROUTER_VAULT_ENABLED` defaults off. Keep it off until OMR-15 verifies a disposable PostgreSQL migration, secrets, browser journey and rollback. An unavailable flag returns 503. Do not enable it as part of this migration alone.

## Migration and access

Apply `packages/identity/migrations/0020_openrouter_personal_vault.sql` in the normal numeric sequence after the earlier identity tables. The table is in `omr_identity` and has a one-row-per-user foreign key to AuthFn users with `ON DELETE CASCADE`. It has no workspace column. Active rows contain AES-GCM ciphertext, a random 96-bit IV, key ID, revision, last four characters and validation metadata. A removal leaves a ciphertext-free tombstone with a fresh revision, preventing a concurrent validation that started before removal from restoring the key. A later deliberate save can replace that tombstone. The plaintext never goes to a database column.

Provision a dedicated database login for the vault Worker binding. Grant that login `USAGE` on `omr_identity` and `SELECT, INSERT, UPDATE, DELETE` on **only** `omr_identity.openrouter_keys`; revoke the same grants from `PUBLIC`. The login needs no access to user, session, workspace, connection or execution tables. The existing identity connection authenticates the user first. For Workers, configure a separate `OPENROUTER_VAULT_HYPERDRIVE` with that login; local workerd may use `OPENROUTER_VAULT_DATABASE_URL`. Do not reuse the primary `HYPERDRIVE` or `DATABASE_URL` login for the vault binding. OMR-15 must verify grants against a disposable database, including that the vault login cannot read other tables.

## Secrets and rotation

Generate an independent 32-byte random wrapping key and provide `OPENROUTER_VAULT_KEYS` as a JSON object of key IDs to 64-character hex strings. Set `OPENROUTER_VAULT_ACTIVE_KEY_ID` to one member. Keep both values in Worker secrets, never in `vars`, logs, source, browser storage or a PR. The vault refuses missing or malformed secrets. Existing ciphertext includes the key ID and user-bound authenticated context.

For staged rotation, add a new key ID while retaining all old entries, then make it active. New and replaced user keys use the new ID. To rewrap existing rows, use an authenticated, reviewed maintenance path that decrypts and re-encrypts one user's current revision at a time with compare-and-swap; this application intentionally does not expose a bulk rewrap endpoint. Remove an old key only after a database inventory shows zero rows with its ID and rollback no longer needs it. A premature key removal fails closed with `OPENROUTER_VAULT_UNAVAILABLE`.

## Rollback

First disable `OMR_OPENROUTER_VAULT_ENABLED`; existing encrypted rows remain inaccessible to the UI. Restore the earlier active key ID and retain both key entries if a staged rotation must be rolled back. Restore the dedicated binding or migration before re-enabling. If the feature is abandoned, obtain an approved data-retention decision before deleting rows or dropping the table. Do not roll back by logging, exporting, or copying plaintext keys. OMR-15 owns observed rollback and recovery evidence in disposable infrastructure.

## Acceptance boundary

OMR-12 validates the code contract with fixture provider responses, user isolation, encryption, rotation, deletion, malformed keys, account loss and UI state tests. OpenRouter's [current-key endpoint](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key), `GET /api/v1/key`, is used for validation; provider error bodies are never returned or logged. A 401/403 marks a saved key invalid; network and rate failures leave existing state intact. OMR-15 owns live provider, disposable PostgreSQL, Cloudflare Preview, staged secret rotation, authenticated Aside Browser and real-host evidence. No live result is implied by this document.
