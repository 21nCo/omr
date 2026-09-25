import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { drizzleAdapter } from "@superfunctions/db/adapters/drizzle";

import {
  createOMRDataRuntime,
  type CreateOMRDataRuntimeOptions,
  type WorkspacePrincipal,
} from "./runtime.js";
import { publicDrizzleSchema } from "./postgres-schema.js";

const { Client } = pg;

export interface ConnectPostgresDataRuntimeOptions
  extends Omit<CreateOMRDataRuntimeOptions, "database"> {
  connectionString: string;
}

export interface PostgresDataRuntime {
  server: Awaited<ReturnType<typeof createOMRDataRuntime>>;
  close(): Promise<void>;
}

function assertPostgresConnectionString(connectionString: string): void {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("A valid PostgreSQL connection string is required");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("A PostgreSQL connection string is required");
  }
}

/**
 * Opens one request-scoped PostgreSQL client. In Workers, pass the current
 * Hyperdrive binding's connectionString and close the returned runtime after
 * the request finishes; Hyperdrive owns the underlying connection pool.
 */
export async function connectPostgresDataRuntime(
  options: ConnectPostgresDataRuntimeOptions,
): Promise<PostgresDataRuntime> {
  assertPostgresConnectionString(options.connectionString);

  const client = new Client({ connectionString: options.connectionString });
  await client.connect();

  try {
    await client.query("SET search_path TO omr_app");
    const database = drizzleAdapter({
      db: drizzle(client, { schema: publicDrizzleSchema }),
      dialect: "postgres",
    });
    const server = await createOMRDataRuntime({
      database,
      resolvePrincipal: options.resolvePrincipal,
      authorize: options.authorize,
    });

    return {
      server,
      async close() {
        await server.close();
        await client.end();
      },
    };
  } catch (error) {
    await client.end();
    throw error;
  }
}

export type { WorkspacePrincipal };
