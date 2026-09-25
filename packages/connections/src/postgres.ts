import pg from "pg";

import { ConnectionAuthority } from "./connections.js";
import { PostgresConnectionBindingStore } from "./postgres-store.js";

const { Client } = pg;

export interface PostgresConnectionRuntime {
  connections: ConnectionAuthority;
  close(): Promise<void>;
}

export async function connectPostgresConnections(input: {
  connectionString: string;
}): Promise<PostgresConnectionRuntime> {
  const parsed = new URL(input.connectionString);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("A PostgreSQL connection string is required");
  }
  const client = new Client({ connectionString: input.connectionString });
  await client.connect();
  return {
    connections: new ConnectionAuthority(new PostgresConnectionBindingStore(client)),
    async close() {
      await client.end();
    },
  };
}

export { PostgresConnectionBindingStore } from "./postgres-store.js";
