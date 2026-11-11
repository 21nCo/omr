import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROBE_TIMEOUT_MS, postgresFixtureTiming } from "./postgres-fixture-timing.js";

/** AuthenticationOk then ReadyForQuery(idle). */
const STARTUP_OK = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]);
/** CommandComplete("SELECT 1") then ReadyForQuery(idle). */
const QUERY_OK = Buffer.concat([Buffer.from([0x43, 0, 0, 0, 13]), Buffer.from("SELECT 1\0"), Buffer.from([0x5a, 0, 0, 0, 5, 0x49])]);

type Mode = "silent" | "stalled-query" | "stalled-close" | "healthy";

let server: Server | undefined;
const accepted = new Set<Socket>();

afterEach(async () => {
  for (const socket of accepted) socket.destroy();
  accepted.clear();
  await new Promise((resolve) => server ? server.close(resolve) : resolve(undefined));
  server = undefined;
});

/** A local PostgreSQL wire-protocol stand-in that stops answering at the chosen step and never closes first. */
async function fakeDatabase(mode: Mode): Promise<string> {
  server = createServer({ allowHalfOpen: true }, (socket) => {
    accepted.add(socket);
    socket.on("close", () => accepted.delete(socket));
    socket.on("error", () => undefined);
    let started = false;
    socket.on("data", (chunk) => {
      if (mode === "silent") return;
      if (!started) {
        started = true;
        socket.write(STARTUP_OK);
      } else if (chunk[0] === 0x51 && mode !== "stalled-query") {
        socket.write(QUERY_OK);
      } else if (chunk[0] === 0x58 && mode === "healthy") {
        socket.end();
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake database has no TCP port");
  return `postgres://fixture:fixture@127.0.0.1:${address.port}/fixture?sslmode=disable`;
}

describe("PostgreSQL fixture timing calibration", () => {
  it("uses the local timings when no database is configured", async () => {
    const timing = await postgresFixtureTiming(undefined);
    expect(timing.socketMs).toBe(0);
    expect(timing.deadline(80)).toBe(80);
    expect(timing.test(5_000)).toBe(5_000);
  });

  it("measures a responsive database within the sample cap", async () => {
    const timing = await postgresFixtureTiming(await fakeDatabase("healthy"));
    expect(timing.socketMs).toBeGreaterThanOrEqual(0);
    expect(timing.socketMs).toBeLessThanOrEqual(1_000);
  });

  it.each([
    ["silent", /could not connect/],
    ["stalled-query", /could not run SELECT 1/],
    ["stalled-close", /could not close/],
  ] as const)("fails in bounded time and closes its socket when the database is %s", async (mode, message) => {
    const url = await fakeDatabase(mode);
    const started = performance.now();
    await expect(postgresFixtureTiming(url)).rejects.toThrow(message);
    expect(performance.now() - started).toBeLessThan(2 * PROBE_TIMEOUT_MS + 1_000);
    // A destroyed client socket answers server writes with a reset; a leaked or half-closed one keeps accepting them.
    await vi.waitFor(() => {
      for (const socket of accepted) socket.write("\0");
      expect(accepted.size).toBe(0);
    }, { timeout: 1_000, interval: 20 });
  }, 3 * PROBE_TIMEOUT_MS);
});
