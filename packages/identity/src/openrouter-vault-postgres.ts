import pg from "pg";
import { OpenRouterVault, type OpenRouterKeyRow, type OpenRouterVaultStore } from "./openrouter-vault.js";
import { decodeOpenRouterVaultKeys } from "./openrouter-vault.js";

const { Client } = pg;

export class PostgresOpenRouterVaultStore implements OpenRouterVaultStore {
  constructor(private readonly client: pg.Client) {}

  async get(userId: string): Promise<OpenRouterKeyRow | null> {
    const result = await this.client.query<{
      user_id: string; key_id: string; revision: string; iv: Buffer; ciphertext: Buffer;
      last_four: string; validation: "valid" | "invalid"; checked_at: string;
    }>(`SELECT user_id, key_id, revision, iv, ciphertext, last_four, validation, checked_at
         FROM omr_identity.openrouter_keys WHERE user_id = $1 AND deleted = false`, [userId]);
    const row = result.rows[0];
    return row ? { userId: row.user_id, keyId: row.key_id, revision: row.revision,
      iv: new Uint8Array(row.iv), ciphertext: new Uint8Array(row.ciphertext),
      lastFour: row.last_four, validation: row.validation, checkedAt: Number(row.checked_at) } : null;
  }

  async revision(userId: string): Promise<string | null> {
    const result = await this.client.query<{ revision: string }>(
      "SELECT revision FROM omr_identity.openrouter_keys WHERE user_id=$1", [userId]);
    return result.rows[0]?.revision ?? null;
  }

  async put(row: OpenRouterKeyRow, expectedRevision: string | null): Promise<boolean> {
    const result = await this.client.query(`INSERT INTO omr_identity.openrouter_keys AS current
      (user_id, key_id, revision, iv, ciphertext, last_four, validation, checked_at, deleted)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)
      ON CONFLICT (user_id) DO UPDATE SET key_id=EXCLUDED.key_id, revision=EXCLUDED.revision,
        iv=EXCLUDED.iv, ciphertext=EXCLUDED.ciphertext, last_four=EXCLUDED.last_four,
        validation=EXCLUDED.validation, checked_at=EXCLUDED.checked_at, deleted=false
      WHERE current.revision = $9
      RETURNING user_id`,
    [row.userId, row.keyId, row.revision, Buffer.from(row.iv), Buffer.from(row.ciphertext),
      row.lastFour, row.validation, row.checkedAt, expectedRevision]);
    return result.rowCount === 1;
  }

  async markValidation(userId: string, revision: string, validation: "valid" | "invalid", checkedAt: number): Promise<void> {
    await this.client.query(`UPDATE omr_identity.openrouter_keys SET validation=$3, checked_at=$4
      WHERE user_id=$1 AND revision=$2 AND deleted=false`, [userId, revision, validation, checkedAt]);
  }

  async delete(userId: string): Promise<void> {
    await this.client.query(`INSERT INTO omr_identity.openrouter_keys (user_id, revision, deleted)
      VALUES ($1,$2,true) ON CONFLICT (user_id) DO UPDATE SET
      revision=EXCLUDED.revision, deleted=true, key_id=NULL, iv=NULL, ciphertext=NULL,
      last_four=NULL, validation=NULL, checked_at=NULL`, [userId, crypto.randomUUID()]);
  }
}

export async function connectPostgresOpenRouterVault(options: {
  connectionString: string; keys: string; activeKeyId: string; fetcher?: typeof fetch;
}): Promise<{ vault: OpenRouterVault; close(): Promise<void> }> {
  const ring = decodeOpenRouterVaultKeys(options.keys, options.activeKeyId);
  const client = new Client({ connectionString: options.connectionString });
  await client.connect();
  return { vault: new OpenRouterVault(new PostgresOpenRouterVaultStore(client), ring, options.fetcher),
    close: () => client.end() };
}
