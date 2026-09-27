import pg, { type QueryResult, type QueryResultRow } from "pg";

import { EXECUTION_INVOCATION_DEADLINE_MS,
  ExecutionInvocationDeadlineError } from "./execution.js";

const { Client } = pg;

/** A store query owns its socket; a timed-out write cannot queue a later invocation. */
export class PostgresOwnedQueries {
  private readonly active = new Set<InstanceType<typeof Client>>();
  private closed = false;

  constructor(private readonly connectionString: string) {}

  async query<R extends QueryResultRow>(sql: string, values?: unknown[],
    deadlineAt = Date.now() + EXECUTION_INVOCATION_DEADLINE_MS): Promise<QueryResult<R>> {
    if (this.closed) throw new Error("PostgreSQL execution runtime is closed");
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new ExecutionInvocationDeadlineError();
    const client = new Client({ connectionString: this.connectionString,
      connectionTimeoutMillis: Math.max(1, remaining) });
    client.on("error", () => undefined);
    this.active.add(client);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          await client.connect();
          const queryRemaining = deadlineAt - Date.now();
          if (queryRemaining <= 1) throw new ExecutionInvocationDeadlineError();
          await client.query("SELECT set_config('statement_timeout', $1, false)",
            [`${Math.max(1, Math.floor(queryRemaining - 1))}ms`]);
          return client.query<R>(sql, values);
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            client.connection?.stream.destroy();
            reject(new ExecutionInvocationDeadlineError());
          }, remaining);
        }),
      ]).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "57014" &&
            /statement timeout/i.test(error.message)) throw new ExecutionInvocationDeadlineError();
        throw error;
      });
    } finally {
      if (timer) clearTimeout(timer);
      client.connection?.stream.destroy();
      void client.end().catch(() => undefined);
      this.active.delete(client);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const client of this.active) {
      client.connection?.stream.destroy();
      void client.end().catch(() => undefined);
    }
    this.active.clear();
  }
}
