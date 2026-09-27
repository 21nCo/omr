import pg from "pg";

import { PostgresExecutionReceiptStore } from "./postgres-store.js";
import { PostgresExecutionApprovalStore } from "./postgres-approval-store.js";
import { PostgresExecutionInvocationGuard } from "./postgres-invocation-guard.js";

const { Client } = pg;

export interface PostgresExecutionReceiptRuntime {
  receipts: PostgresExecutionReceiptStore;
  approvals: PostgresExecutionApprovalStore;
  invocationGuard: PostgresExecutionInvocationGuard;
  close(): Promise<void>;
}

export async function connectPostgresExecutionReceipts(input: {
  connectionString: string;
  resultWrappingKey: Uint8Array<ArrayBuffer>;
}): Promise<PostgresExecutionReceiptRuntime> {
  const parsed = new URL(input.connectionString);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("A PostgreSQL connection string is required");
  }
  const client = new Client({ connectionString: input.connectionString });
  await client.connect();
  const guardClient = new Client({ connectionString: input.connectionString });
  try {
    await guardClient.connect();
  } catch (error) {
    await client.end();
    throw error;
  }
  try {
    return {
      receipts: new PostgresExecutionReceiptStore(client, input.resultWrappingKey),
      approvals: new PostgresExecutionApprovalStore(client, input.resultWrappingKey),
      invocationGuard: new PostgresExecutionInvocationGuard(guardClient),
      async close() { await Promise.all([client.end(), guardClient.end()]); },
    };
  } catch (error) {
    await Promise.allSettled([client.end(), guardClient.end()]);
    throw error;
  }
}

export { PostgresExecutionReceiptStore } from "./postgres-store.js";
export { PostgresExecutionApprovalStore } from "./postgres-approval-store.js";
export { PostgresExecutionInvocationGuard } from "./postgres-invocation-guard.js";
