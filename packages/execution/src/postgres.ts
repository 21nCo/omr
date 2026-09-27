import pg from "pg";

import { PostgresExecutionReceiptStore } from "./postgres-store.js";
import { PostgresExecutionApprovalStore } from "./postgres-approval-store.js";
import { PostgresExecutionInvocationGuard } from "./postgres-invocation-guard.js";
import { PostgresOwnedQueries } from "./postgres-owned-query.js";
import { EXECUTION_INVOCATION_DEADLINE_MS, withinInvocationDeadline,
  type ExecutionInvocationGuard } from "./execution.js";

const { Client } = pg;

export interface PostgresExecutionReceiptRuntime {
  receipts: PostgresExecutionReceiptStore;
  approvals: PostgresExecutionApprovalStore;
  invocationGuard: ExecutionInvocationGuard;
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
  try {
    const ownedQueries = new PostgresOwnedQueries(input.connectionString);
    return {
      receipts: new PostgresExecutionReceiptStore(client, input.resultWrappingKey, ownedQueries),
      approvals: new PostgresExecutionApprovalStore(client, input.resultWrappingKey,
        input.connectionString, ownedQueries),
      // A deadline destroys its transaction socket. Each invocation owns its guard
      // client, so a later call on this runtime cannot reuse a closed connection.
      invocationGuard: {
        async run(guardInput, invoke) {
          const guardClient = new Client({ connectionString: input.connectionString });
          guardClient.on("error", () => undefined);
          const deadlineAt = guardInput.deadlineAt ?? Date.now() + EXECUTION_INVOCATION_DEADLINE_MS;
          try {
            await withinInvocationDeadline(deadlineAt, () => guardClient.connect());
            return await new PostgresExecutionInvocationGuard(guardClient).run({
              ...guardInput, deadlineAt,
            }, invoke);
          } finally {
            // Closing a connection that is still establishing must not extend the
            // request beyond its deadline. pg releases its socket asynchronously.
            void guardClient.end().catch(() => undefined);
          }
        },
        async runIdentity(identityInput, invoke) {
          const guardClient = new Client({ connectionString: input.connectionString });
          guardClient.on("error", () => undefined);
          try {
            await withinInvocationDeadline(identityInput.deadlineAt, () => guardClient.connect());
            return await new PostgresExecutionInvocationGuard(guardClient).runIdentity(identityInput, invoke);
          } finally {
            void guardClient.end().catch(() => undefined);
          }
        },
      },
      async close() {
        await ownedQueries.close();
        await client.end();
      },
    };
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}

export { PostgresExecutionReceiptStore } from "./postgres-store.js";
export { PostgresExecutionApprovalStore } from "./postgres-approval-store.js";
export { PostgresExecutionInvocationGuard } from "./postgres-invocation-guard.js";
