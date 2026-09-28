import pg, { type QueryResult, type QueryResultRow } from "pg";

import { EXECUTION_INVOCATION_DEADLINE_MS,
  ExecutionInvocationDeadlineError } from "./execution.js";

const { Client } = pg;
const MAX_STORE_CONNECTIONS = 8;
const SOCKET_CLOSE_MS = 1_000;

interface WaitingQuery {
  resolve: () => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Each query owns a cancellable socket; admission bounds simultaneous sockets. */
export class PostgresOwnedQueries {
  private readonly active = new Map<InstanceType<typeof Client>, {
    cancel: () => void;
    done: Promise<void>;
  }>();
  private readonly waiting: WaitingQuery[] = [];
  private slots = 0;
  private closed = false;

  constructor(private readonly connectionString: string) {}

  private async acquire(deadlineAt: number): Promise<void> {
    if (this.closed) throw new Error("PostgreSQL execution runtime is closed");
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new ExecutionInvocationDeadlineError();
    if (this.slots < MAX_STORE_CONNECTIONS) {
      this.slots++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: WaitingQuery = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiting.splice(this.waiting.indexOf(waiter), 1);
          reject(new ExecutionInvocationDeadlineError());
        }, remaining),
      };
      this.waiting.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    } else {
      this.slots--;
    }
  }

  private async endSocket(client: InstanceType<typeof Client>): Promise<void> {
    client.connection?.stream.destroy();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.end().catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, SOCKET_CLOSE_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async query<R extends QueryResultRow>(sql: string, values?: unknown[],
    deadlineAt = Date.now() + EXECUTION_INVOCATION_DEADLINE_MS): Promise<QueryResult<R>> {
    await this.acquire(deadlineAt);
    const remaining = deadlineAt - Date.now();
    if (this.closed || remaining <= 0) {
      this.release();
      if (this.closed) throw new Error("PostgreSQL execution runtime is closed");
      throw new ExecutionInvocationDeadlineError();
    }
    let client: InstanceType<typeof Client>;
    try {
      client = new Client({ connectionString: this.connectionString,
        connectionTimeoutMillis: Math.max(1, remaining) });
    } catch (error) {
      this.release();
      throw error;
    }
    client.on("error", () => undefined);
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new Error("PostgreSQL execution runtime is closed"));
    });
    this.active.set(client, { cancel, done });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          await client.connect();
          const queryRemaining = deadlineAt - Date.now();
          if (queryRemaining <= 1) throw new ExecutionInvocationDeadlineError();
          await client.query("SELECT set_config('statement_timeout', $1, false)",
            [String(Math.max(1, Math.floor(queryRemaining - 1))) + "ms"]);
          return client.query<R>(sql, values);
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            client.connection?.stream.destroy();
            reject(new ExecutionInvocationDeadlineError());
          }, remaining);
        }),
        cancelled,
      ]).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "57014" &&
            /statement timeout/i.test(error.message)) throw new ExecutionInvocationDeadlineError();
        throw error;
      });
    } finally {
      if (timer) clearTimeout(timer);
      try {
        await this.endSocket(client);
      } finally {
        this.active.delete(client);
        finish();
        this.release();
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("PostgreSQL execution runtime is closed"));
    }
    const active = [...this.active.entries()];
    for (const [client, operation] of active) {
      client.connection?.stream.destroy();
      operation.cancel();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(active.map(([, operation]) => operation.done)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("PostgreSQL runtime close timed out")),
            SOCKET_CLOSE_MS + 100);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
