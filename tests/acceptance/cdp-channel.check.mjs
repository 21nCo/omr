import assert from "node:assert/strict";
import { test } from "node:test";
import { createCdpChannel } from "./cdp-channel.mjs";

class FakeSocket extends EventTarget {
  readyState = WebSocket.OPEN;
  sent = [];
  send(message) { this.sent.push(JSON.parse(message)); }
}

test("disconnect rejects an in-flight Chrome command and forbids another", async () => {
  const socket = new FakeSocket();
  const channel = createCdpChannel(socket, 1_000);
  const pending = channel.send("Runtime.evaluate");
  assert.equal(socket.sent.length, 1);
  socket.dispatchEvent(new Event("close"));
  await assert.rejects(pending, /connection closed/);
  await assert.rejects(channel.send("Page.navigate"), /connection closed/);
  channel.dispose();
});

test("an unresponsive Chrome command times out", async () => {
  const channel = createCdpChannel(new FakeSocket(), 10);
  await assert.rejects(channel.send("Runtime.evaluate"), /timed out/);
  channel.dispose();
});
