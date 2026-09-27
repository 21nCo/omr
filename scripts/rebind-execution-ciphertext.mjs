import pg from "pg";
import { pathToFileURL } from "node:url";
import { decryptJson, encryptJson } from "../packages/execution/dist/postgres-crypto.js";
import { decodeExecutionWrappingKey } from "../packages/execution/dist/wrapping-key.js";

const targets = [
  { table: "execution_approvals", kind: "approval-params", column: "params" },
  { table: "execution_receipts", kind: "receipt-result", column: "result" },
];

function deadlineBudget(client, deadlineAt) {
  let closed = false;
  const abort = () => {
    if (closed) return;
    closed = true;
    if (client.connection?.stream) client.connection.stream.destroy();
    else void client.end().catch(() => undefined);
  };
  const bounded = async (operation) => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      abort();
      throw new Error("Ciphertext rebind deadline exceeded");
    }
    let timer;
    try {
      return await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            abort();
            reject(new Error("Ciphertext rebind deadline exceeded"));
          }, remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const close = async () => {
    if (closed) return;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return abort();
    const ending = client.end().catch(() => undefined);
    let timer;
    try {
      await Promise.race([ending, new Promise((resolve) => {
        timer = setTimeout(() => { abort(); resolve(); }, Math.min(remaining, 1_000));
      })]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    bounded,
    query: (sql, values) => bounded(() => client.query(sql, values)),
    abort,
    close,
    canRollback: () => !closed && Date.now() < deadlineAt,
  };
}

async function encryptLegacy(value, key, bounded) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const imported = await bounded(() => crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]));
  const ciphertext = await bounded(() => crypto.subtle.encrypt({ name: "AES-GCM", iv }, imported,
    new TextEncoder().encode(JSON.stringify(value))));
  return { ciphertext: new Uint8Array(ciphertext), iv };
}

async function convertRow(target, row, key, rollback, budget) {
  const context = { kind: target.kind, workspaceId: row.workspace_id, id: row.id };
  const sourceVersion = rollback ? 1 : 0;
  const value = await budget.bounded(() => decryptJson(row.ciphertext, row.iv, key, context, sourceVersion));
  const sealed = rollback
    ? await encryptLegacy(value, key, budget.bounded)
    : await budget.bounded(() => encryptJson(value, key, context));
  await budget.query(
    `UPDATE omr_control.${target.table}
     SET ${target.column}_ciphertext = $2, ${target.column}_iv = $3,
         ${target.column}_crypto_version = $4 WHERE id = $1`,
    [row.id, sealed.ciphertext, sealed.iv, rollback ? 0 : 1],
  );
}

async function convertTarget(target, key, rollback, budget) {
  let count = 0;
  while (true) {
    await budget.query("BEGIN");
    try {
      await budget.query("SET LOCAL lock_timeout = '5s'");
      await budget.query("SET LOCAL statement_timeout = '30s'");
      const rows = await budget.query(
        `SELECT id, workspace_id, ${target.column}_ciphertext AS ciphertext,
                ${target.column}_iv AS iv
         FROM omr_control.${target.table}
         WHERE ${target.column}_crypto_version = $1 AND ${target.column}_ciphertext IS NOT NULL
         ORDER BY id LIMIT 1 FOR UPDATE`,
        [rollback ? 1 : 0],
      );
      const row = rows.rows[0];
      if (!row) {
        await budget.query("COMMIT");
        return count;
      }
      await convertRow(target, row, key, rollback, budget);
      await budget.query("COMMIT");
      count += 1;
    } catch (error) {
      if (budget.canRollback()) {
        await budget.query("ROLLBACK").catch(() => budget.abort());
      } else {
        budget.abort();
      }
      throw error;
    }
  }
}

export async function rebindCiphertext({ client, key, rollback = false,
  deadlineAt = Date.now() + 300_000, output = process.stdout }) {
  // A deadline destroys a live pg socket. Consume its subsequent error event.
  client.on?.("error", () => undefined);
  const budget = deadlineBudget(client, deadlineAt);
  try {
    await budget.bounded(() => client.connect());
    for (const target of targets) {
      const count = await convertTarget(target, key, rollback, budget);
      output.write(`${target.table}: ${count} ciphertext rows converted to version ${rollback ? 0 : 1}\n`);
    }
  } finally {
    await budget.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const connectionString = process.env.OMR_DATABASE_URL;
  const encodedKey = process.env.EXECUTION_RESULT_WRAPPING_KEY;
  if (!connectionString || !encodedKey) {
    throw new Error("OMR_DATABASE_URL and EXECUTION_RESULT_WRAPPING_KEY are required");
  }
  const rollback = process.argv.slice(2).includes("--rollback");
  if (process.argv.slice(2).some((arg) => arg !== "--rollback")) {
    throw new Error("Only --rollback is supported");
  }
  const key = decodeExecutionWrappingKey(encodedKey);
  const deadlineAt = Date.now() + 300_000;
  const client = new pg.Client({ connectionString,
    connectionTimeoutMillis: Math.max(1, deadlineAt - Date.now()) });
  await rebindCiphertext({ client, key, rollback, deadlineAt });
}
