import { createServer, type Server, type Socket } from "node:net";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExecutionInvocationDeadlineError, type ExecutionReceipt } from "./execution.js";
import { connectPostgresExecutionReceipts } from "./postgres.js";
import { PostgresExecutionApprovalStore } from "./postgres-approval-store.js";
import { PostgresOwnedQueries } from "./postgres-owned-query.js";

const DEADLINE_MS = 200;
const key = new Uint8Array(32) as Uint8Array<ArrayBuffer>;
const servers: Server[] = [];
const accepted = new Set<Socket>();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const socket of accepted) socket.destroy();
  accepted.clear();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** A TCP listener that reads PostgreSQL startup and never answers, so it sees the client's close. */
async function silentDatabase(): Promise<string> {
  const server = createServer((socket) => {
    accepted.add(socket);
    socket.on("close", () => accepted.delete(socket));
    socket.on("error", () => undefined);
    socket.resume();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("silent database has no TCP port");
  return `postgres://fixture:fixture@127.0.0.1:${address.port}/fixture?sslmode=disable`;
}

/** A URL whose port refuses connections, so connect fails for a reason unrelated to the deadline. */
async function refusedDatabase(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string") throw new Error("refused database has no TCP port");
  return `postgres://fixture:fixture@127.0.0.1:${address.port}/fixture?sslmode=disable`;
}

async function socketsClosed(): Promise<number> {
  const until = Date.now() + 2_000;
  while (accepted.size && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  return accepted.size;
}

const claimInput = (deadlineAt: number) => ({ approvalId: "approval_1", actorUserId: "user_1",
  principalKey: "web:user_1", now: Date.now(), clock: Date.now, deadlineAt });
const completionInput = (deadlineAt: number) => ({ approvalId: "approval_1",
  receipt: { id: "receipt_1", workspaceId: "workspace_1" } as ExecutionReceipt,
  result: null, now: Date.now(), deadlineAt });

/** Each dedicated-connection site: prepare it, then return the call that opens the socket. */
const sites: Record<string, (url: string) => Promise<(deadlineAt: number) => Promise<unknown>>> = {
  "owned query": async (url) => {
    const queries = new PostgresOwnedQueries(url);
    cleanups.push(() => queries.close());
    return (deadlineAt) => queries.query("SELECT 1", [], deadlineAt);
  },
  "approval claim": async (url) => {
    const store = new PostgresExecutionApprovalStore(new pg.Client(), key, url);
    return (deadlineAt) => store.claim(claimInput(deadlineAt));
  },
  "approval completion": async (url) => {
    const store = new PostgresExecutionApprovalStore(new pg.Client(), key, url);
    return (deadlineAt) => store.succeedWithReceipt(completionInput(deadlineAt));
  },
  "runtime owned client": async (url) => {
    const runtime = await connectPostgresExecutionReceipts({ connectionString: url, resultWrappingKey: key });
    cleanups.push(() => runtime.close());
    return (deadlineAt) => runtime.approvals.claim(claimInput(deadlineAt));
  },
};

describe("PostgreSQL connect deadline", () => {
  for (const [site, prepare] of Object.entries(sites)) {
    it(`${site}: a deadline that expires while connecting is EXECUTION_INVOCATION_TIMEOUT`, async () => {
      const open = await prepare(await silentDatabase());
      const started = performance.now();
      const deadlineAt = Date.now() + DEADLINE_MS;
      // The invocation deadline's own timer decides, not a later wall-clock
      // comparison: Date.now() stays before the deadline while the call runs.
      const clock = vi.spyOn(Date, "now").mockReturnValue(deadlineAt - DEADLINE_MS);
      const error = await open(deadlineAt).catch((caught: unknown) => caught)
        .finally(() => clock.mockRestore());
      expect(error).toBeInstanceOf(ExecutionInvocationDeadlineError);
      expect(error).toMatchObject({ code: "EXECUTION_INVOCATION_TIMEOUT" });
      expect(performance.now() - started).toBeLessThan(DEADLINE_MS + 1_500);
      expect(await socketsClosed()).toBe(0);
    });

    it(`${site}: a refused connection keeps its own error`, async () => {
      const open = await prepare(await refusedDatabase());
      const error = await open(Date.now() + DEADLINE_MS).catch((caught: unknown) => caught);
      expect(error).not.toBeInstanceOf(ExecutionInvocationDeadlineError);
      expect(error).toMatchObject({ code: "ECONNREFUSED" });
    });
  }
});
