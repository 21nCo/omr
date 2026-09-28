import pg from "pg";

import { PostgresExecutionReceiptStore } from "./postgres-store.js";
import { PostgresExecutionApprovalStore } from "./postgres-approval-store.js";
import { PostgresExecutionInvocationGuard } from "./postgres-invocation-guard.js";
import { PostgresOwnedQueries } from "./postgres-owned-query.js";
import { EXECUTION_INVOCATION_DEADLINE_MS, ExecutionInvocationDeadlineError,
  type ExecutionInvocationGuard } from "./execution.js";

const { Client } = pg;
const SOCKET_CLOSE_MS = 1_000;

interface ExecutionBackend {
  pid: number;
  backend_start: string;
  application_name: string;
}

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
  const ownedQueries = new PostgresOwnedQueries(input.connectionString);
  const activeClients = new Map<InstanceType<typeof Client>, { controller: AbortController;
    done: Promise<void>; cleanupError?: unknown }>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const boundedSocketEnd = async (client: InstanceType<typeof Client>): Promise<void> => {
    client.connection?.stream.destroy();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.end().catch(() => undefined),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, SOCKET_CLOSE_MS); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const terminateBackend = async (backend: ExecutionBackend): Promise<void> => {
    const terminator = new Client({ connectionString: input.connectionString,
      connectionTimeoutMillis: SOCKET_CLOSE_MS });
    terminator.on("error", () => undefined);
    const deadlineAt = Date.now() + SOCKET_CLOSE_MS;
    const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new Error("PostgreSQL execution cancellation timed out");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              terminator.connection?.stream.destroy();
              reject(new Error("PostgreSQL execution cancellation timed out"));
            }, remaining);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    try {
      await bounded(() => terminator.connect());
      const result = await bounded(() => terminator.query<{ terminated: boolean }>(
        `SELECT pg_terminate_backend(pid) AS terminated
         FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2
           AND application_name = $3`,
        [backend.pid, backend.backend_start, backend.application_name],
      ));
      if (result.rows[0] && !result.rows[0].terminated) {
        throw new Error("PostgreSQL execution backend could not be terminated");
      }
      while (Date.now() < deadlineAt) {
        const remaining = await bounded(() => terminator.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2
             AND application_name = $3`,
          [backend.pid, backend.backend_start, backend.application_name],
        ));
        if (!remaining.rows[0]) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("PostgreSQL execution backend did not exit");
    } finally {
      await boundedSocketEnd(terminator);
    }
  };
  const runOwnedClient = async <T>(deadlineAt: number,
    invoke: (client: InstanceType<typeof Client>, shutdownSignal: AbortSignal) => Promise<T>): Promise<T> => {
    if (closed) throw new Error("PostgreSQL execution runtime is closed");
    if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) {
      throw new ExecutionInvocationDeadlineError();
    }
    const operationUrl = new URL(input.connectionString);
    const namePrefix = operationUrl.searchParams.get("application_name") ?? "omr_execution";
    operationUrl.searchParams.set("application_name",
      `${namePrefix.slice(0, 45)}:${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`);
    const client = new Client({ connectionString: operationUrl.toString(),
      connectionTimeoutMillis: Math.max(1, deadlineAt - Date.now()),
      statement_timeout: Math.max(1, deadlineAt - Date.now()) });
    client.on("error", () => undefined);
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const activeOperation: { controller: AbortController; done: Promise<void>; cleanupError?: unknown } =
      { controller, done };
    activeClients.set(client, activeOperation);
    let backend: ExecutionBackend | undefined;
    let mustTerminate = false;
    const opening = async <R>(operation: () => Promise<R>): Promise<R> => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0 || controller.signal.aborted) throw new ExecutionInvocationDeadlineError();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        return await Promise.race([
          operation(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new ExecutionInvocationDeadlineError()), remaining);
          }),
          new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(new ExecutionInvocationDeadlineError());
            controller.signal.addEventListener("abort", onAbort, { once: true });
            if (controller.signal.aborted) onAbort();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      }
    };
    try {
      await opening(() => client.connect());
      const identity = await opening(() => client.query<ExecutionBackend>(
        `SELECT pg_backend_pid() AS pid, backend_start::text AS backend_start,
           application_name FROM pg_stat_activity
         WHERE pid = pg_backend_pid()`));
      backend = identity.rows[0];
      if (controller.signal.aborted || closed) throw new ExecutionInvocationDeadlineError();
      let onAbort: (() => void) | undefined;
      try {
        return await Promise.race([
          invoke(client, controller.signal),
          new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(new ExecutionInvocationDeadlineError());
            controller.signal.addEventListener("abort", onAbort, { once: true });
            if (controller.signal.aborted) onAbort();
          }),
        ]);
      } finally {
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      }
    } catch (error) {
      mustTerminate = controller.signal.aborted || error instanceof ExecutionInvocationDeadlineError;
      throw error;
    } finally {
      try {
        if ((mustTerminate || controller.signal.aborted) && backend) {
          await terminateBackend(backend);
        }
      } catch (error) {
        // Keep the invocation's original outcome; close() reports a failed
        // cancellation separately when shutdown initiated this operation.
        activeOperation.cleanupError = error;
      } finally {
        try {
          await boundedSocketEnd(client);
        } finally {
          activeClients.delete(client);
          finish();
        }
      }
    }
  };
  try {
    return {
      receipts: new PostgresExecutionReceiptStore(null, input.resultWrappingKey, ownedQueries),
      approvals: new PostgresExecutionApprovalStore(null, input.resultWrappingKey,
        input.connectionString, ownedQueries, runOwnedClient),
      // Guard, claim and completion transactions use owned clients. Shutdown
      // fences new work and terminates active backends before returning.
      invocationGuard: {
        async run(guardInput, invoke) {
          const deadlineAt = guardInput.deadlineAt ?? Date.now() + EXECUTION_INVOCATION_DEADLINE_MS;
          return runOwnedClient(deadlineAt, (client, shutdownSignal) =>
            new PostgresExecutionInvocationGuard(client, EXECUTION_INVOCATION_DEADLINE_MS,
              shutdownSignal).run({ ...guardInput, deadlineAt }, invoke));
        },
        async runIdentity(identityInput, invoke) {
          return runOwnedClient(identityInput.deadlineAt, (client, shutdownSignal) =>
            new PostgresExecutionInvocationGuard(client, EXECUTION_INVOCATION_DEADLINE_MS,
              shutdownSignal).runIdentity(identityInput, invoke));
        },
      },
      async close() {
        if (closePromise) return closePromise;
        closed = true;
        const active = [...activeClients.entries()];
        for (const [client, operation] of active) {
          client.connection?.stream.destroy();
          operation.controller.abort();
        }
        closePromise = Promise.all([
          ownedQueries.close(),
          Promise.all(active.map(([, operation]) => operation.done)),
        ]).then(() => {
          const failed = active.find(([, operation]) => operation.cleanupError);
          if (failed) throw new Error("PostgreSQL execution cancellation failed",
            { cause: failed[1].cleanupError });
        });
        return closePromise;
      },
    };
  } catch (error) {
    await ownedQueries.close();
    throw error;
  }
}

export { PostgresExecutionReceiptStore } from "./postgres-store.js";
export { PostgresExecutionApprovalStore } from "./postgres-approval-store.js";
export { PostgresExecutionInvocationGuard } from "./postgres-invocation-guard.js";
