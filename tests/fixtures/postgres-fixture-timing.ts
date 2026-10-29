import { Client } from "pg";

/** Fresh-socket cost (connect plus one statement) that the fixtures were written against. */
const LOCAL_SOCKET_MS = 5;
/** Fixed upper bound on the measured cost, so a stalled database cannot stretch every budget. */
const MAX_SOCKET_MS = 1_000;
/** Remote round trips one fixture operation may add: a dedicated socket and its statements. */
const OPERATION_SOCKETS = 8;
const SAMPLES = 3;
/** Bound on each probe step (connect, statement, close); suites await calibration before Vitest timeouts apply. */
export const PROBE_TIMEOUT_MS = 5_000;

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
    samples.push(await probe(connectionString));
  }
  samples.sort((a, b) => a - b);
  const measured = samples[Math.floor(samples.length / 2)] ?? 0;
  const socketMs = Math.ceil(Math.min(MAX_SOCKET_MS, measured));
  const remoteMs = Math.max(0, socketMs - LOCAL_SOCKET_MS);
  const scale = Math.max(1, socketMs / LOCAL_SOCKET_MS);
  return {
    socketMs,
    deadline: (localMs) => localMs + OPERATION_SOCKETS * remoteMs,
    test: (localMs) => Math.ceil(localMs * scale),
  };
}

/** Time one fresh socket: connect, SELECT 1 and close, each bounded, closing the socket on any failure. */
async function probe(connectionString: string): Promise<number> {
  const started = performance.now();
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: PROBE_TIMEOUT_MS,
    query_timeout: PROBE_TIMEOUT_MS,
  });
  let step = "connect";
  try {
    await client.connect();
    step = "run SELECT 1";
    await client.query("SELECT 1");
  } catch (error) {
    await close(client);
    throw probeError(step, error);
  }
  if (!(await close(client))) throw probeError("close", new Error("the server did not end the connection"));
  return performance.now() - started;
}

/** End the client; destroy its socket when the server does not finish the close within the bound. */
async function close(client: Client): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = await Promise.race([
    client.end().then(() => true),
    new Promise<false>((resolve) => { timer = setTimeout(resolve, PROBE_TIMEOUT_MS, false); }),
  ]);
  clearTimeout(timer);
  if (!ended) client.connection.stream.destroy();
  return ended;
}

function probeError(step: string, cause: unknown): Error {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `PostgreSQL fixture timing probe could not ${step} (each step is bounded to ${PROBE_TIMEOUT_MS} ms): ${reason}`,
    { cause },
  );
}
