import { Client } from "pg";

/** Fresh-socket cost (connect plus one statement) that the fixtures were written against. */
const LOCAL_SOCKET_MS = 5;
/** Fixed upper bound on the measured cost, so a stalled database cannot stretch every budget. */
const MAX_SOCKET_MS = 1_000;
/** Remote round trips one fixture operation may add: a dedicated socket and its statements. */
const OPERATION_SOCKETS = 8;
const SAMPLES = 3;

export interface PostgresFixtureTiming {
  /** Median measured fresh-socket cost, capped at the fixed upper bound. */
  readonly socketMs: number;
  /** A deadline, wait or pause written for local PostgreSQL, extended by the remote allowance. */
  deadline(localMs: number): number;
  /** A whole-test timeout written for local PostgreSQL, scaled by the measured socket cost. */
  test(localMs: number): number;
}

/** Derive fixture timings from the test database's measured round trip. */
export async function postgresFixtureTiming(
  connectionString: string | undefined,
): Promise<PostgresFixtureTiming> {
  const samples: number[] = [];
  for (let index = 0; connectionString && index < SAMPLES; index++) {
    const started = performance.now();
    const client = new Client({ connectionString });
    try {
      await client.connect();
      await client.query("SELECT 1");
    } finally {
      await client.end();
    }
    samples.push(performance.now() - started);
  }
  const measured = samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)] ?? 0;
  const socketMs = Math.ceil(Math.min(MAX_SOCKET_MS, measured));
  const remoteMs = Math.max(0, socketMs - LOCAL_SOCKET_MS);
  const scale = Math.max(1, socketMs / LOCAL_SOCKET_MS);
  return {
    socketMs,
    deadline: (localMs) => localMs + OPERATION_SOCKETS * remoteMs,
    test: (localMs) => Math.ceil(localMs * scale),
  };
}
