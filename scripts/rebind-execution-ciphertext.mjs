import pg from "pg";
import { decryptJson, encryptJson } from "../packages/execution/dist/postgres-crypto.js";

const connectionString = process.env.OMR_DATABASE_URL;
const encodedKey = process.env.EXECUTION_RESULT_WRAPPING_KEY;
if (!connectionString || !encodedKey) {
  throw new Error("OMR_DATABASE_URL and EXECUTION_RESULT_WRAPPING_KEY are required");
}
const keyBytes = /^[0-9a-f]{64}$/i.test(encodedKey)
  ? Buffer.from(encodedKey, "hex") : Buffer.from(encodedKey, "base64url");
if (keyBytes.length !== 32) throw new Error("Execution wrapping key must be 32 bytes");
const key = new Uint8Array(keyBytes);
const rollback = process.argv.slice(2).includes("--rollback");
if (process.argv.slice(2).some((arg) => arg !== "--rollback")) {
  throw new Error("Only --rollback is supported");
}
const sourceVersion = rollback ? 1 : 0;
const targetVersion = rollback ? 0 : 1;
const encryptLegacy = async (value) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const imported = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, imported,
    new TextEncoder().encode(JSON.stringify(value)));
  return { ciphertext: new Uint8Array(ciphertext), iv };
};
const deadlineAt = Date.now() + 300_000;
const client = new pg.Client({ connectionString });
const targets = [
  { table: "execution_approvals", kind: "approval-params", column: "params" },
  { table: "execution_receipts", kind: "receipt-result", column: "result" },
];

await client.connect();
try {
  for (const target of targets) {
    let count = 0;
    while (true) {
      if (Date.now() >= deadlineAt) throw new Error("Ciphertext rebind deadline exceeded");
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '30s'");
        const rows = await client.query(
          `SELECT id, workspace_id, ${target.column}_ciphertext AS ciphertext,
                  ${target.column}_iv AS iv
           FROM omr_control.${target.table}
           WHERE ${target.column}_crypto_version = $1 AND ${target.column}_ciphertext IS NOT NULL
           ORDER BY id LIMIT 1 FOR UPDATE`,
          [sourceVersion],
        );
        const row = rows.rows[0];
        if (!row) {
          await client.query("COMMIT");
          break;
        }
        const context = { kind: target.kind, workspaceId: row.workspace_id, id: row.id };
        const value = await decryptJson(row.ciphertext, row.iv, key, context, sourceVersion);
        const sealed = rollback ? await encryptLegacy(value) : await encryptJson(value, key, context);
        await client.query(
          `UPDATE omr_control.${target.table}
           SET ${target.column}_ciphertext = $2, ${target.column}_iv = $3,
               ${target.column}_crypto_version = $4 WHERE id = $1`,
          [row.id, sealed.ciphertext, sealed.iv, targetVersion],
        );
        await client.query("COMMIT");
        count += 1;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
    process.stdout.write(`${target.table}: ${count} ciphertext rows converted to version ${targetVersion}\n`);
  }
} finally {
  await client.end();
}
