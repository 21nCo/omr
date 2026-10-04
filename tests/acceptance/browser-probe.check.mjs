import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanupAll, until } from "./browser-probe.mjs";

test("polling never starts a browser request after a sleep crosses its deadline", async () => {
  let now = 0;
  let calls = 0;
  await assert.rejects(until(() => { calls++; return false; }, "receipt", 10, {
    now: () => now, pause: async () => { now = 10; },
  }), /Timed out/);
  assert.equal(calls, 1);
});

test("polling rejects a success delivered at the deadline", async () => {
  let now = 0;
  await assert.rejects(until(async () => { now = 10; return true; }, "receipt", 10,
    { now: () => now }), /Timed out/);
});

test("polling bounds an unresponsive browser request", async () => {
  await assert.rejects(until(() => new Promise(() => undefined), "receipt", Date.now() + 10),
    /Timed out/);
});

test("cleanup reports every failure and still reaches later steps", async () => {
  const reported = [];
  const reached = [];
  const failed = await cleanupAll([
    async () => {
      reached.push("Chrome start");
      await Promise.resolve();
      reached.push("Chrome end");
      throw new Error("Chrome shutdown failed");
    },
    async () => { reached.push("server"); },
    async () => { throw new Error("profile removal failed"); },
  ], (error) => reported.push(error.message));
  assert.equal(failed, true);
  assert.deepEqual(reached, ["Chrome start", "Chrome end", "server"]);
  assert.deepEqual(reported, ["Chrome shutdown failed", "profile removal failed"]);
});
