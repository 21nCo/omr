import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { createCdpChannel } from "./cdp-channel.mjs";

const chrome = process.env.CHROME_BIN ?? (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
const profile = await mkdtemp(join(tmpdir(), "omr-playground-keyboard-"));
const server = await createServer({ configFile: resolve("vitest.client.config.ts"),
  server: { host: "127.0.0.1", port: 0 } });
let browser;
let socket;
let channel;

/** Wait for Chrome to open CDP, rejecting a closed or stalled handshake. */
function opened(target) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Chrome debugging connection timed out")), 5_000);
    const finish = (error) => {
      clearTimeout(timer);
      target.removeEventListener("open", onOpen);
      target.removeEventListener("error", onError);
      target.removeEventListener("close", onClose);
      error ? reject(error) : resolve();
    };
    const onOpen = () => finish();
    const onError = () => finish(new Error("Chrome debugging connection failed"));
    const onClose = () => finish(new Error("Chrome debugging connection closed"));
    target.addEventListener("open", onOpen);
    target.addEventListener("error", onError);
    target.addEventListener("close", onClose);
    if (target.readyState === WebSocket.OPEN) finish();
  });
}

/** Wait for the owned Chrome process to exit before removing its profile. */
async function stopBrowser(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const waitForExit = (ms) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off("exit", onExit); resolve(false); }, ms);
    child.once("exit", onExit);
  });
  child.kill();
  if (!await waitForExit(2_000)) {
    child.kill("SIGKILL");
    if (!await waitForExit(2_000)) throw new Error("Chrome did not exit during keyboard fixture cleanup");
  }
}

/** Poll a browser-visible condition with a bounded deadline. */
async function until(check, label, deadline = Date.now() + 15_000) {
  const value = await check();
  if (value) return value;
  if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
  await new Promise((done) => setTimeout(done, 50));
  return until(check, label, deadline);
}

try {
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address !== "string");
  browser = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
  { stdio: "ignore" });
  browser.on("error", (error) => { process.stderr.write(`${error}\n`); });
  const debugPort = await until(async () => {
    const file = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "");
    return Number(file.split("\n")[0]) || 0;
  }, "Chrome debugging port");
  const targets = await fetch(`http://127.0.0.1:${debugPort}/json`).then((response) => response.json());
  const target = targets.find((item) => item.type === "page");
  assert(target?.webSocketDebuggerUrl, "Chrome did not create a page target");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await opened(socket);
  channel = createCdpChannel(socket);
  const send = channel.send;
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true,
      awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${address.port}/tests/fixtures/browser/playground-keyboard.html` });
  await until(() => evaluate("window.__playgroundMounted && !document.querySelector('#playground-tool')?.disabled"),
    "playground catalog");
  await evaluate(`(() => { const select = document.querySelector('#playground-tool');
    select.value = 'demo.read'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(() => evaluate("!document.querySelector('button[type=submit]')?.disabled"), "read button");
  await evaluate(`document.querySelector('button[type=submit]').focus()`);
  assert.equal(await evaluate("document.activeElement === document.querySelector('button[type=submit]')"), true);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter",
    text: "\r", unmodifiedText: "\r", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter",
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await until(() => evaluate("window.__playgroundExecuteCalls === 1 && document.body.textContent.includes('receipt_keyboard')"),
    "one keyboard-submitted receipt").catch(async (error) => {
    const diagnostic = await evaluate("({ calls: window.__playgroundExecuteCalls, " +
      "active: document.activeElement?.outerHTML, body: document.body.textContent })");
    process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
    throw error;
  });
  assert.equal(await evaluate("window.__playgroundExecuteCalls"), 1);
  process.stdout.write("Chrome Enter-key submit: one read request and receipt_keyboard observed\n");
} finally {
  channel?.dispose();
  socket?.close();
  let cleanupFailure;
  try { await stopBrowser(browser); }
  catch (error) { cleanupFailure = error; }
  await server.close();
  await until(async () => {
    try { await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); return true; }
    catch { return false; }
  }, "Chrome profile cleanup").catch((error) => process.stderr.write(`${error}\n`));
  if (cleanupFailure) throw cleanupFailure;
}
