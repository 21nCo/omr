// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";
import type { ToolManifest } from "@oh-my-router/tools";
import Playground from "../../apps/web/src/routes/app/playground/+page.svelte?client";
import type { PlaygroundApproval } from "../../apps/web/src/lib/direct-playground.js";

/** Build a minimal catalog entry with a real approval effect contract. */
function manifest(id: string, effect: "read" | "write"): ToolManifest {
  return { catalogSchemaVersion: "1.0.0", id, provider: "demo", providerVersion: "1.0.0",
    action: id.slice(5), displayName: effect === "read" ? "Read fixture" : "Write fixture",
    description: "Fixture tool", hash: id, inputSchema: { type: "object", required: ["title"],
      properties: { title: { type: "string", description: "Item title" } },
      additionalProperties: false }, outputSchema: { type: "object" },
    contract: { version: "1.0.0", effect, requiredScopes: [], resources: [],
      sensitiveKeys: ["secret"], pagination: { kind: "none" }, retry: "never" } };
}

const tools = [manifest("demo.read", "read"), manifest("demo.write", "write")];

/** Find one actionable control by its visible label. */
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((element) =>
    element.textContent?.trim() === label);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`Button missing: ${label}`);
  return found;
}

/** Change a native select through its browser event boundary. */
function select(id: string, value: string) {
  const element = document.getElementById(id) as HTMLSelectElement;
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Trigger the form's submit handler in DOM acceptance tests. */
function submit() {
  document.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true,
    cancelable: true }));
}

/** Project the status payload used by approval recovery cases. */
function approval(status: string): PlaygroundApproval {
  return { id: "approval_one", workspaceId: "workspace_one", connectionId: "connection_one",
    toolId: "demo.write", status, params: { title: "[REDACTED]" }, previewReady: true,
    manifestCurrent: true, action: "Write fixture", effect: "write", resources: [
      { kind: "item", parameter: "title" }], previewMode: "redacted",
    expiresAt: Date.now() + 60_000, browserActionable: true };
}

/** Return the control-plane shape used by client tests. */
function overview(connections = [{ id: "connection_one", workspaceId: "workspace_one", provider: "demo",
  label: "Demo account", status: "active", readiness: "ready", providerState: "ready",
  selectable: true, selected: true }], approvals: PlaygroundApproval[] = []) {
  return { selectedWorkspaceId: "workspace_one",
    workspaces: [{ workspace: { id: "workspace_one", name: "Mine" } },
      { workspace: { id: "workspace_two", name: "Other" } }], connections, approvals };
}

afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); document.body.replaceChildren(); });

describe("direct playground form", () => {
  it.each([
    { code: "AUTHFN_UNAUTHENTICATED", message: "Sign in again", redirects: true },
    { code: "LINEAR_RECONNECT_REQUIRED", message: "Reconnect Linear in the control plane", redirects: false },
  ])("handles $code during workspace load", async ({ code, message, redirects }) => {
    const assign = vi.fn();
    vi.stubGlobal("location", { pathname: "/app/playground", assign });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: code, message }, { status: 401 })));
    const app = mount(Playground, { target: document.body });
    try {
      await vi.waitFor(() => expect(document.querySelector("[role=alert]")?.textContent)
        .toContain(message));
      expect(assign.mock.calls).toEqual(redirects
        ? [["/login?returnTo=%2Fapp%2Fplayground"]] : []);
    } finally { await unmount(app); }
  });

  it("refreshes selection and catalog after switching provider accounts", async () => {
    const connections = ["one", "two"].map((id) => ({ id: `connection_${id}`,
      workspaceId: "workspace_one", provider: "demo", label: `Account ${id}`,
      status: "active", readiness: "ready", providerState: "ready", selectable: true,
      selected: id === "one" }));
    let selected = "connection_one";
    let catalogReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/control-plane")) return Response.json(overview(connections.map(
        (connection) => ({ ...connection, selected: connection.id === selected }))));
      if (path.startsWith("/api/tools?")) {
        catalogReads += 1;
        return Response.json({ tools, providers: [{ provider: "demo", state: "ready" }] });
      }
      if (path === "/api/connections/select") {
        selected = (JSON.parse(String(init?.body)) as { connectionId: string }).connectionId;
        return Response.json({ id: selected });
      }
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = mount(Playground, { target: document.body });
    try {
      await vi.waitFor(() => expect(catalogReads).toBe(1));
      select("playground-connection", "connection_two");
      await vi.waitFor(() => expect(catalogReads).toBe(2));
      expect(selected).toBe("connection_two");
      expect(document.querySelector<HTMLSelectElement>("#playground-connection")?.value)
        .toBe("connection_two");
      await vi.waitFor(() => expect(document.body.textContent).toContain("Account two is ready"));
    } finally { await unmount(app); }
  });

  it.each(["rejected", "no longer ready"] as const)(
    "does not show an unconfirmed account as ready when selection is %s", async (failure) => {
      const connections = ["one", "two"].map((id) => ({ id: `connection_${id}`,
        workspaceId: "workspace_one", provider: "demo", label: `Account ${id}`,
        status: "active", readiness: "ready", providerState: "ready",
        selectable: failure === "rejected" || id === "one",
        selected: id === "one" }));
      let selectionPosts = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.startsWith("/api/control-plane")) return Response.json(overview(connections));
        if (path.startsWith("/api/tools?")) return Response.json({ tools,
          providers: [{ provider: "demo", state: "ready" }] });
        if (path === "/api/connections/select") {
          selectionPosts += 1;
          return Response.json({ error: "CONNECTION_UNAVAILABLE" }, { status: 409 });
        }
        return Response.json({ error: "NOT_FOUND" }, { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const app = mount(Playground, { target: document.body });
      try {
        await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>(
          "#playground-connection")?.disabled).toBe(false));
        select("playground-connection", "connection_two");
        await vi.waitFor(() => expect(document.querySelector("[role=alert]")?.textContent)
          .toContain(failure === "rejected" ? "select it again" : "no longer ready"));
        expect(document.querySelector<HTMLSelectElement>("#playground-connection")?.value).toBe("");
        await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>("#playground-tool")?.disabled)
          .toBe(true));
        expect(document.body.textContent).not.toContain("Account two is ready");
        expect(selectionPosts).toBe(failure === "rejected" ? 1 : 0);
      } finally { await unmount(app); }
    });

  it("guides refresh and reselection when a catalog tool disappears before manifest load", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/control-plane")) return Response.json(overview());
      if (path.startsWith("/api/tools?")) return Response.json({ tools,
        providers: [{ provider: "demo", state: "ready" }] });
      if (path.startsWith("/api/tools/manifest")) return Response.json({ error: "TOOL_NOT_FOUND" },
        { status: 404 });
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = mount(Playground, { target: document.body });
    try {
      await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>(
        "#playground-tool")?.disabled).toBe(false));
      select("playground-tool", "demo.read");
      await vi.waitFor(() => expect(document.querySelector("[role=alert]")?.textContent)
        .toContain("Refresh the tool catalog and select an available tool again"));
      expect(document.querySelector("#playground-arguments")).toBeNull();
    } finally { await unmount(app); }
  });

  it("holds an uncertain resumed write until status confirms settlement", async () => {
    let status = "uncertain";
    let newApprovals = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/control-plane")) return Response.json(overview(undefined,
        [approval("uncertain")]));
      if (path.startsWith("/api/tools?")) return Response.json({ tools,
        providers: [{ provider: "demo", state: "ready" }] });
      if (path.startsWith("/api/approvals/status")) return Response.json(approval(status));
      if (path === "/api/approvals") newApprovals += 1;
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = mount(Playground, { target: document.body });
    try {
      await vi.waitFor(() => expect(button("Review approval").disabled).toBe(false));
      button("Review approval").click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("outcome is uncertain"));
      expect([...document.querySelectorAll("button")].some((item) =>
        item.textContent?.trim() === "Start a new action")).toBe(false);
      status = "consumed";
      button("Check status").click();
      await vi.waitFor(() => expect(button("Start a new action").disabled).toBe(false));
      button("Start a new action").click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Ready to choose another action"));
      expect(newApprovals).toBe(0);
    } finally { await unmount(app); }
  });

  it("recovers an uncertain GitHub write through its verified receipt without another provider call", async () => {
    let current = { ...approval("uncertain"), toolId: "github.issues.create",
      executionReceiptId: "receipt-github", canConfirmPresent: true, canConfirmAbsent: true,
      reconciledAs: null as "effect_present" | "effect_absent" | null };
    let decisions = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/control-plane")) return Response.json(overview(undefined, [current]));
      if (path.startsWith("/api/tools?")) return Response.json({ tools,
        providers: [{ provider: "demo", state: "ready" }] });
      if (path.startsWith("/api/approvals/status")) return Response.json(current);
      if (path === "/api/approvals/reconcile") {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({ approvalId: current.id, decision: "effect_absent",
          workspaceId: current.workspaceId });
        decisions++;
        current = { ...current, status: "failed", reconciledAs: "effect_absent",
          canConfirmPresent: false, canConfirmAbsent: false };
        return Response.json(current);
      }
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = mount(Playground, { target: document.body });
    try {
      await vi.waitFor(() => expect(button("Review approval").disabled).toBe(false));
      button("Review approval").click();
      await vi.waitFor(() => expect(button("I verified the action did not happen").disabled).toBe(false));
      expect(document.querySelector("[aria-label='Approval']")?.textContent)
        .not.toContain("control plane");
      button("I verified the action did not happen").click();
      await vi.waitFor(() => expect(button("Start a new action").disabled).toBe(false));
      expect(document.body.textContent).toContain("No provider write was repeated");
      expect(decisions).toBe(1);
      expect(fetchMock.mock.calls.some(([path]) => String(path) === "/api/approvals/execute"))
        .toBe(false);
    } finally { await unmount(app); }
  });

  it.each(["executing", "uncertain"])(
    "recovers a resumed %s write through the same receipt without another approval", async (state) => {
      let current = { ...approval(state), executionReceiptId: "receipt-existing" };
      let executeCalls = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.startsWith("/api/control-plane")) return Response.json(overview(undefined, [current]));
        if (path.startsWith("/api/tools?")) return Response.json({ tools,
          providers: [{ provider: "demo", state: "ready" }] });
        if (path.startsWith("/api/approvals/status")) return Response.json(current);
        if (path === "/api/approvals/execute") {
          executeCalls++;
          current = { ...current, status: "consumed" };
          return Response.json({ id: "receipt-existing", status: "succeeded", result: {},
            errorCode: null });
        }
        return Response.json({ error: "NOT_FOUND" }, { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const app = mount(Playground, { target: document.body });
      try {
        await vi.waitFor(() => expect(button("Review approval").disabled).toBe(false));
        button("Review approval").click();
        await vi.waitFor(() => expect(button("Recover execution from receipt").disabled).toBe(false));
        button("Recover execution from receipt").click();
        await vi.waitFor(() => expect(button("Start a new action").disabled).toBe(false));
        expect(executeCalls).toBe(1);
        expect(document.body.textContent).toContain("receipt-existing");
        expect(fetchMock.mock.calls.some(([path]) => String(path) === "/api/approvals"))
          .toBe(false);
      } finally { await unmount(app); }
    });

  it("repeats a settled resumed write after reload despite a different selected tool", async () => {
    const approvals = new Map<string, ReturnType<typeof approval>>();
    const keys = new Map<string, string>();
    let next = 0;
    let writes = 0;
    let approvalPosts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
      if (path.startsWith("/api/control-plane")) return Response.json(overview(undefined,
        [...approvals.values()].filter((item) => ["pending", "approved", "executing", "uncertain"]
          .includes(item.status))));
      if (path.startsWith("/api/tools?")) return Response.json({ tools,
        providers: [{ provider: "demo", state: "ready" }] });
      if (path.startsWith("/api/tools/manifest")) return Response.json(
        tools.find((tool) => path.includes(tool.id)));
      if (path === "/api/approvals") {
        approvalPosts += 1;
        let id = keys.get(body.idempotencyKey);
        if (!id) { id = `approval_${++next}`; keys.set(body.idempotencyKey, id);
          approvals.set(id, { ...approval("pending"), id }); }
        return Response.json(approvals.get(id));
      }
      if (path.startsWith("/api/approvals/status")) return Response.json(
        approvals.get(new URL(`https://omr.invalid${path}`).searchParams.get("approvalId") ?? ""));
      if (path === "/api/approvals/approve") {
        const current = approvals.get(body.approvalId)!;
        approvals.set(current.id, { ...current, status: "approved" });
        return Response.json(approvals.get(current.id));
      }
      if (path === "/api/approvals/execute") {
        writes += 1;
        const current = approvals.get(body.approvalId)!;
        approvals.set(current.id, { ...current, status: "consumed", executionReceiptId: `receipt_${writes}` });
        return Response.json({ id: `receipt_${writes}`, status: "succeeded", result: {},
          errorCode: null });
      }
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    let app = mount(Playground, { target: document.body });
    const writeArgs = '{"title":"repeat me"}';
    try {
      await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>(
        "#playground-tool")?.disabled).toBe(false));
      select("playground-tool", "demo.write");
      await vi.waitFor(() => expect(button("Request approval").disabled).toBe(false));
      const field = document.getElementById("playground-arguments") as HTMLTextAreaElement;
      field.value = writeArgs;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      submit();
      await vi.waitFor(() => expect(button("Approve").disabled).toBe(false));
      expect(writes).toBe(0);
      await unmount(app);
      document.body.replaceChildren();
      app = mount(Playground, { target: document.body });
      await vi.waitFor(() => expect(button("Review approval").disabled).toBe(false));
      select("playground-tool", "demo.read");
      await vi.waitFor(() => expect(button("Run read").disabled).toBe(false));
      button("Review approval").click();
      await vi.waitFor(() => expect(button("Approve").disabled).toBe(false));
      const panel = document.querySelector("[aria-label='Approval']")?.textContent ?? "";
      expect(panel).toContain("Write fixture");
      expect(panel).toContain("demo.write");
      expect(panel).toContain("Effect: write");
      expect(panel).toContain("item · argument title");
      expect(panel).toContain("Server-redacted argument preview");
      button("Approve").click();
      await vi.waitFor(() => expect(button("Execute approved change").disabled).toBe(false));
      button("Execute approved change").click();
      await vi.waitFor(() => expect(button("Start a new action").disabled).toBe(false));
      expect(writes).toBe(1);
      button("Start a new action").click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Ready for a new action"));
      expect(approvalPosts).toBe(1);
      select("playground-tool", "demo.write");
      await vi.waitFor(() => expect(button("Request approval").disabled).toBe(false));
      const repeated = document.getElementById("playground-arguments") as HTMLTextAreaElement;
      repeated.value = writeArgs;
      repeated.dispatchEvent(new Event("input", { bubbles: true }));
      submit();
      await vi.waitFor(() => expect(approvals.size).toBe(2));
      expect(writes).toBe(1);
      await vi.waitFor(() => expect(button("Approve").disabled).toBe(false));
      button("Approve").click();
      await vi.waitFor(() => expect(button("Execute approved change").disabled).toBe(false));
      button("Execute approved change").click();
      await vi.waitFor(() => expect(button("Start a new action").disabled).toBe(false));
      expect(writes).toBe(2);
      await unmount(app);
      document.body.replaceChildren();
      app = mount(Playground, { target: document.body });
      await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>(
        "#playground-tool")?.disabled).toBe(false));
      select("playground-tool", "demo.write");
      await vi.waitFor(() => expect(button("Request approval").disabled).toBe(false));
      const afterReload = document.getElementById("playground-arguments") as HTMLTextAreaElement;
      afterReload.value = writeArgs;
      afterReload.dispatchEvent(new Event("input", { bubbles: true }));
      submit();
      await vi.waitFor(() => expect(document.body.textContent).toContain("already completed"));
      expect(writes).toBe(2);
      expect(approvals.size).toBe(2);
      button("Start a new action").click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Ready for a new action"));
      select("playground-tool", "demo.write");
      await vi.waitFor(() => expect(button("Request approval").disabled).toBe(false));
      const third = document.getElementById("playground-arguments") as HTMLTextAreaElement;
      third.value = writeArgs;
      third.dispatchEvent(new Event("input", { bubbles: true }));
      submit();
      await vi.waitFor(() => expect(approvals.size).toBe(3));
      expect(writes).toBe(2);
    } finally { await unmount(app); }
  });

  it("starts a fresh identical write after a lost approval response and resumed settlement", async () => {
    const approvals = new Map<string, PlaygroundApproval>();
    const keyToApproval = new Map<string, string>();
    let firstKey = "";
    let approvalPosts = 0;
    let writes = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
      if (path.startsWith("/api/control-plane")) return Response.json(overview(undefined,
        [...approvals.values()].filter((item) => item.status === "pending")));
      if (path.startsWith("/api/tools?")) return Response.json({ tools,
        providers: [{ provider: "demo", state: "ready" }] });
      if (path.startsWith("/api/tools/manifest")) return Response.json(tools[1]);
      if (path === "/api/approvals") {
        approvalPosts += 1;
        let id = keyToApproval.get(body.idempotencyKey);
        if (!id) {
          id = `approval_${keyToApproval.size + 1}`;
          keyToApproval.set(body.idempotencyKey, id);
          approvals.set(id, { ...approval("pending"), id });
        }
        if (!firstKey) {
          firstKey = body.idempotencyKey;
          throw new TypeError("response lost after approval commit");
        }
        return Response.json(approvals.get(id));
      }
      if (path.startsWith("/api/approvals/status")) {
        const id = new URL(`https://omr.invalid${path}`).searchParams.get("approvalId") ?? "";
        const rawKey = [...keyToApproval].find(([, value]) => value === id)?.[0] ?? "";
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey));
        return Response.json({ ...approvals.get(id), actionKeyDigest: [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0")).join("") });
      }
      if (path === "/api/approvals/approve") {
        const current = approvals.get(body.approvalId)!;
        approvals.set(current.id, { ...current, status: "approved" });
        return Response.json(approvals.get(current.id));
      }
      if (path === "/api/approvals/execute") {
        writes += 1;
        const current = approvals.get(body.approvalId)!;
        approvals.set(current.id, { ...current, status: "consumed" });
        return Response.json({ id: `receipt_${writes}`, status: "succeeded", result: {}, errorCode: null });
      }
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    let app = mount(Playground, { target: document.body });
    const argumentsText = '{"title":"same action"}';
    const enterWrite = async () => {
      select("playground-tool", "demo.write");
      await vi.waitFor(() => expect(button("Request approval").disabled).toBe(false));
      const field = document.getElementById("playground-arguments") as HTMLTextAreaElement;
      field.value = argumentsText;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      submit();
    };
    try {
      await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>(
        "#playground-tool")?.disabled).toBe(false));
      await enterWrite();
      await vi.waitFor(() => expect(document.querySelector("[role=alert]")?.textContent)
        .toContain("response lost"));
      expect(writes).toBe(0);
      expect(approvalPosts).toBe(1);
      await unmount(app);
      document.body.replaceChildren();
      app = mount(Playground, { target: document.body });
      await vi.waitFor(() => expect(button("Review approval").disabled).toBe(false));
      button("Review approval").click();
      await vi.waitFor(() => expect(button("Approve").disabled).toBe(false));
      button("Approve").click();
      await vi.waitFor(() => expect(button("Execute approved change").disabled).toBe(false));
      button("Execute approved change").click();
      await vi.waitFor(() => expect(button("Start a new action").disabled).toBe(false));
      button("Start a new action").click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Ready for a new action"));
      await enterWrite();
      await vi.waitFor(() => expect(keyToApproval.size).toBe(2));
      expect([...keyToApproval.keys()][1]).not.toBe(firstKey);
      expect(writes).toBe(1);
    } finally { await unmount(app); }
  });
  it.each(["destructive", "unknown"])(
    "warns about an opaque %s approval before a resumed decision", async (effect) => {
    const opaque = { ...approval("pending"), action: "Delete remote fixture",
      effect, resources: [{ kind: "remote item" }],
      previewMode: "opaque" as const, params: "[REDACTED]" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/control-plane")) return Response.json(overview(undefined,
        [opaque]));
      if (path.startsWith("/api/tools?")) return Response.json({ tools,
        providers: [{ provider: "demo", state: "ready" }] });
      if (path.startsWith("/api/tools/manifest")) return Response.json(tools[0]);
      if (path.startsWith("/api/approvals/status")) return Response.json(opaque);
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = mount(Playground, { target: document.body });
    try {
      await vi.waitFor(() => expect(button("Review approval").disabled).toBe(false));
      select("playground-tool", "demo.read");
      await vi.waitFor(() => expect(button("Run read").disabled).toBe(false));
      button("Review approval").click();
      await vi.waitFor(() => expect(button("Approve").disabled).toBe(false));
      const panel = document.querySelector("[aria-label='Approval']")?.textContent ?? "";
      expect(panel).toContain("Delete remote fixture");
      expect(panel).toContain(`Effect: ${effect}`);
      expect(panel).toContain("remote item · target unspecified");
      expect(panel).toContain("cannot show this action's arguments or target");
      expect(panel).toContain("[REDACTED]");
      expect(panel).not.toContain("Read fixture");
    } finally { await unmount(app); }
  });

  it("guides recovery from failed execution responses and returned failed receipts", async () => {
    let failedAsResponse = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/control-plane")) return Response.json(overview());
      if (path.startsWith("/api/tools?")) return Response.json({ tools,
        providers: [{ provider: "demo", state: "ready" }] });
      if (path.startsWith("/api/tools/manifest")) return Response.json(tools[0]);
      if (path === "/api/tools/execute") return failedAsResponse
        ? Response.json({ error: "EXECUTION_FAILED", receiptId: "receipt_failed" }, { status: 502 })
        : Response.json({ id: "receipt_failed", status: "failed", result: null,
          errorCode: "connection_unavailable" });
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = mount(Playground, { target: document.body });
    try {
      await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>(
        "#playground-tool")?.disabled).toBe(false));
      select("playground-tool", "demo.read");
      await vi.waitFor(() => expect(button("Run read").disabled).toBe(false));
      submit();
      await vi.waitFor(() => expect(document.querySelector("[role=alert]")?.textContent)
        .toContain("Check the receipt and account health"));
      expect(document.querySelector("[role=alert]")?.textContent).toContain("receipt_failed");
      failedAsResponse = false;
      submit();
      await vi.waitFor(() => expect(document.querySelector("[aria-label='Execution result']")?.textContent)
        .toContain("connection_unavailable"));
      expect(document.querySelector("[aria-label='Execution result']")?.textContent)
        .toContain("Verify the provider outcome before retrying a write");
    } finally { await unmount(app); }
  });
  it("does not offer a provider that the shared selection service marks unconfigured", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/control-plane")) return Response.json(overview([{
        id: "connection_one", workspaceId: "workspace_one", provider: "demo",
        label: "Demo account", status: "active", readiness: "ready",
        providerState: "unconfigured", selectable: false, selected: false,
      }]));
      if (path.startsWith("/api/tools?")) return Response.json({ tools, providers: [
        { provider: "demo", state: "unconfigured" }] });
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = mount(Playground, { target: document.body });
    try {
      await vi.waitFor(() => expect(document.body.textContent).toContain("No ready account"));
      expect(document.querySelector<HTMLOptionElement>("#playground-connection option[value=connection_one]")
        ?.disabled).toBe(true);
      expect(document.querySelector<HTMLSelectElement>("#playground-tool")?.disabled).toBe(true);
      expect(fetchMock.mock.calls.some(([path]) => String(path) === "/api/connections/select")).toBe(false);
    } finally { await unmount(app); }
  });

  it.each(["approve", "reject"] as const)("refreshes a failed %s decision and exposes expiry recovery", async (operation) => {
    const expiresAt = Date.now() + 60_000;
    let expired = false;
    let statusCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/control-plane")) return Response.json(overview(undefined,
        [approval("pending")]));
      if (path.startsWith("/api/tools?")) return Response.json({ tools, providers: [
        { provider: "demo", state: "ready" }] });
      if (path.startsWith("/api/tools/manifest")) return Response.json(tools[1]);
      if (path.startsWith("/api/approvals/status")) {
        statusCalls += 1;
        return Response.json({ ...approval(expired ? "expired" : "pending"),
          expiresAt });
      }
      if (path === `/api/approvals/${operation}`) {
        return Response.json({ error: "APPROVAL_UNAVAILABLE" }, { status: 409 });
      }
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = mount(Playground, { target: document.body });
    try {
      await vi.waitFor(() => expect(button("Review approval").disabled).toBe(false));
      select("playground-tool", "demo.write");
      await vi.waitFor(() => expect(button("Request approval").disabled).toBe(false));
      button("Review approval").click();
      await vi.waitFor(() => expect(button(operation === "approve" ? "Approve" : "Reject")
        .disabled).toBe(false));
      const panel = document.querySelector("[aria-label='Approval']")?.textContent ?? "";
      expect(panel).toContain("Write fixture");
      expect(panel).toContain("demo.write");
      expect(panel).toContain("item · argument title");
      expired = true;
      button(operation === "approve" ? "Approve" : "Reject").click();
      await vi.waitFor(() => expect(document.querySelector("[aria-label='Approval']")?.textContent)
        .toContain("Approval · expired"));
      expect(statusCalls).toBe(2);
      expect(button("Start a new action").disabled).toBe(false);
      expect(document.querySelector("[role=alert]")?.textContent).toContain("expired");
    } finally { await unmount(app); }
  });

  it("blocks stale approval decisions when status refresh fails, then recovers on a manual check", async () => {
    let statusCalls = 0;
    let decisions = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/control-plane")) return Response.json(overview(undefined,
        [approval("pending")]));
      if (path.startsWith("/api/tools?")) return Response.json({ tools, providers: [
        { provider: "demo", state: "ready" }] });
      if (path.startsWith("/api/approvals/status")) {
        statusCalls += 1;
        return statusCalls === 2 ? Response.json({ error: "HTTP_ERROR" }, { status: 503 })
          : Response.json(approval("pending"));
      }
      if (path === "/api/approvals/approve") {
        decisions += 1;
        return Response.json({ error: "HTTP_ERROR" }, { status: 503 });
      }
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = mount(Playground, { target: document.body });
    try {
      await vi.waitFor(() => expect(button("Review approval").disabled).toBe(false));
      button("Review approval").click();
      await vi.waitFor(() => expect(button("Approve").disabled).toBe(false));
      button("Approve").click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Approval status is unconfirmed"));
      expect(button("Approve").disabled).toBe(true);
      button("Approve").click();
      expect(decisions).toBe(1);
      button("Check status").click();
      await vi.waitFor(() => expect(button("Approve").disabled).toBe(false));
      expect(statusCalls).toBe(3);
    } finally { await unmount(app); }
  });

  it("submits through requestSubmit and ignores an in-flight result after workspace change", async () => {
    let finishRead!: (response: Response) => void;
    const pendingRead = new Promise<Response>((resolve) => { finishRead = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/control-plane?workspaceId=workspace_two")) return Response.json({
        ...overview([]), selectedWorkspaceId: "workspace_two" });
      if (path.startsWith("/api/control-plane")) return Response.json(overview());
      if (path.startsWith("/api/tools?")) return Response.json({ tools, providers: [
        { provider: "demo", state: "ready" }] });
      if (path.startsWith("/api/tools/manifest")) return Response.json(tools[0]);
      if (path === "/api/tools/execute") return pendingRead;
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = mount(Playground, { target: document.body });
    try {
      await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>(
        "#playground-tool")?.disabled).toBe(false));
      select("playground-tool", "demo.read");
      await vi.waitFor(() => expect(button("Run read").disabled).toBe(false));
      const field = document.getElementById("playground-arguments") as HTMLTextAreaElement;
      field.value = '{"title":"fixture"}';
      field.dispatchEvent(new Event("input", { bubbles: true }));
      const submitButton = button("Run read");
      submitButton.focus();
      expect(document.activeElement).toBe(submitButton);
      submitButton.form?.requestSubmit(submitButton);
      await vi.waitFor(() => expect(fetchMock.mock.calls.some(([path]) =>
        String(path) === "/api/tools/execute")).toBe(true));
      select("playground-workspace", "workspace_two");
      await vi.waitFor(() => expect(document.body.textContent).toContain("No ready account"));
      finishRead(Response.json({ id: "receipt_old", status: "succeeded", result: {}, errorCode: null }));
      await vi.waitFor(() => expect(document.querySelector("[aria-label='Execution result']")).toBeNull());
      expect(document.querySelector<HTMLSelectElement>("#playground-tool")?.disabled).toBe(true);
    } finally { await unmount(app); }
  });

  it("ignores a stale manifest when tool selection changes during loading", async () => {
    let finishManifest!: (response: Response) => void;
    const pendingManifest = new Promise<Response>((resolve) => { finishManifest = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/control-plane")) return Response.json(overview());
      if (path.startsWith("/api/tools?")) return Response.json({ tools, providers: [
        { provider: "demo", state: "ready" }] });
      if (path.startsWith("/api/tools/manifest")) return pendingManifest;
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = mount(Playground, { target: document.body });
    try {
      await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>(
        "#playground-tool")?.disabled).toBe(false));
      select("playground-tool", "demo.read");
      await vi.waitFor(() => expect(document.body.textContent).toContain("Loading tool"));
      select("playground-tool", "");
      finishManifest(Response.json(tools[0]));
      await vi.waitFor(() => expect(document.querySelector("#playground-arguments")).toBeNull());
      expect(document.querySelector<HTMLSelectElement>("#playground-tool")?.value).toBe("");
    } finally { await unmount(app); }
  });

  it("keeps labeled controls keyboard usable and moves read/write through errors, approval and receipt", async () => {
    let writes = 0;
    let reads = 0;
    let approvalStatus = "pending";
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push(path);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (path.startsWith("/api/control-plane")) return Response.json(overview());
      if (path.startsWith("/api/tools?")) return Response.json({ tools,
        providers: [{ provider: "demo", state: "ready" }] });
      if (path.startsWith("/api/tools/manifest")) return Response.json(
        tools.find((tool) => path.includes(encodeURIComponent(tool.id)) || path.includes(tool.id)));
      if (path === "/api/tools/execute") {
        reads += 1;
        return Response.json({ id: "receipt_read", status: "succeeded", result: { title: body.params },
          errorCode: null });
      }
      if (path === "/api/approvals") return Response.json(approval(approvalStatus));
      if (path === "/api/approvals/approve") {
        approvalStatus = "approved";
        return Response.json(approval(approvalStatus));
      }
      if (path.startsWith("/api/approvals/status")) return Response.json({ ...approval(approvalStatus),
        executionReceiptId: approvalStatus === "consumed" ? "receipt_write" : null });
      if (path === "/api/approvals/execute") {
        writes += 1;
        approvalStatus = "consumed";
        return Response.json({ id: "receipt_write", status: "succeeded",
          result: { saved: true }, errorCode: null });
      }
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = mount(Playground, { target: document.body });
    try {
      await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>(
        "#playground-tool")?.disabled).toBe(false));
      for (const id of ["playground-workspace", "playground-connection", "playground-tool",
        "playground-arguments"]) {
        const control = document.getElementById(id);
        expect(document.querySelector<HTMLLabelElement>(`label[for="${id}"]`)?.htmlFor).toBe(control?.id);
      }
      select("playground-tool", "demo.read");
      await vi.waitFor(() => expect(button("Run read").disabled).toBe(false));
      const argumentsField = document.getElementById("playground-arguments") as HTMLTextAreaElement;
      argumentsField.value = "{";
      argumentsField.dispatchEvent(new Event("input", { bubbles: true }));
      submit();
      await vi.waitFor(() => expect(document.querySelector("[role=alert]")?.textContent)
        .toContain("valid JSON"));
      expect(reads).toBe(0);
      argumentsField.value = '{"title":"fixture"}';
      argumentsField.dispatchEvent(new Event("input", { bubbles: true }));
      submit();
      await vi.waitFor(() => expect(document.querySelector("[aria-label='Execution result']")?.textContent)
        .toContain("receipt_read"));
      expect(reads).toBe(1);

      select("playground-tool", "demo.write");
      await vi.waitFor(() => expect(button("Request approval").disabled).toBe(false));
      const writeArguments = document.getElementById("playground-arguments") as HTMLTextAreaElement;
      writeArguments.value = '{"title":"fixture"}';
      writeArguments.dispatchEvent(new Event("input", { bubbles: true }));
      submit();
      await vi.waitFor(() => expect(document.querySelector("[aria-label='Approval']")?.textContent)
        .toContain("pending"));
      expect(writes).toBe(0);
      submit();
      expect(calls.filter((path) => path === "/api/approvals")).toHaveLength(1);
      button("Approve").click();
      await vi.waitFor(() => expect(document.querySelector("[aria-label='Approval']")?.textContent)
        .toContain("approved"));
      expect(writes).toBe(0);
      button("Execute approved change").click();
      await vi.waitFor(() => expect(document.querySelector("[aria-label='Execution result']")?.textContent)
        .toContain("receipt_write"));
      expect(writes).toBe(1);
      expect(calls).not.toContain("/api/settings/openrouter");
    } finally { await unmount(app); }
  });

  it("shows a bounded assisted answer, model usage and the direct receipt without a key field", async () => {
    const requestIds: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/control-plane")) return Response.json(overview());
      if (path.startsWith("/api/tools?")) return Response.json({ tools,
        providers: [{ provider: "demo", state: "ready" }] });
      if (path === "/api/playground/assisted") {
        const sent = JSON.parse(String(init?.body));
        requestIds.push(sent.requestId);
        expect(sent).toMatchObject({ workspaceId: "workspace_one",
          connectionId: "connection_one", model: "fixture/model", prompt: "Find fixture" });
        expect(sent.requestId).toMatch(/^[0-9a-f-]{36}$/);
        return Response.json({ status: "answered", answer: "Fixture found.", model: "fixture/model",
          servedModels: ["fixture/served"], toolId: "demo.read",
          usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14, costUsd: 0.00002 },
          receipt: { id: "receipt_assisted", status: "succeeded", result: { title: "fixture" },
            errorCode: null } });
      }
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = mount(Playground, { target: document.body,
      props: { data: { assistedEnabled: true } as never } });
    try {
      await vi.waitFor(() => expect(button("Ask model").disabled).toBe(true));
      for (const [id, value] of [["assisted-model", "fixture/model"],
        ["assisted-prompt", "Find fixture"]]) {
        const field = document.getElementById(id) as HTMLInputElement;
        field.value = value;
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await vi.waitFor(() => expect(button("Ask model").disabled).toBe(false));
      button("Ask model").click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Fixture found."));
      expect(document.body.textContent).toContain("Tokens: 14");
      expect(document.body.textContent).toContain("$0.000020");
      expect(document.body.textContent).toContain("receipt_assisted");
      expect(document.querySelector("input[type=password]")).toBeNull();
      await vi.waitFor(() => expect(button("Ask model").disabled).toBe(false));
      button("Ask model").click();
      await vi.waitFor(() => expect(requestIds).toHaveLength(2));
      expect(requestIds[1]).not.toBe(requestIds[0]);
    } finally { await unmount(app); }
  });

  it.each([
    { status: "tool_error", terminalFailure: true, fresh: true },
    { status: "tool_error", terminalFailure: false, fresh: false },
    { status: "action_pending", terminalFailure: false, fresh: false },
  ])("uses a fresh ID only after a confirmed failed read ($status, terminal: $terminalFailure)",
    async ({ status, terminalFailure, fresh }) => {
      const requestIds: string[] = [];
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.startsWith("/api/control-plane")) return Response.json(overview());
        if (path.startsWith("/api/tools?")) return Response.json({ tools,
          providers: [{ provider: "demo", state: "ready" }] });
        if (path === "/api/playground/assisted") {
          requestIds.push(JSON.parse(String(init?.body)).requestId);
          return Response.json({ status, terminalFailure,
            answer: "Check read receipt", model: "fixture/model", servedModels: ["fixture/served"],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.00001 },
            receipt: { id: "receipt_read", status: terminalFailure ? "failed" : "running",
              result: null, errorCode: terminalFailure ? "READ_FAILED" : null } });
        }
        return Response.json({ error: "NOT_FOUND" }, { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const app = mount(Playground, { target: document.body,
        props: { data: { assistedEnabled: true } as never } });
      try {
        await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>("#playground-connection")?.value)
          .toBe("connection_one"));
        for (const [id, value] of [["assisted-model", "fixture/model"],
          ["assisted-prompt", "Find fixture"]]) {
          const field = document.getElementById(id) as HTMLInputElement;
          field.value = value;
          field.dispatchEvent(new Event("input", { bubbles: true }));
        }
        await vi.waitFor(() => expect(button("Ask model").disabled).toBe(false));
        button("Ask model").click();
        await vi.waitFor(() => expect(document.body.textContent).toContain("Check read receipt"));
        await vi.waitFor(() => expect(button("Ask model").disabled).toBe(false));
        button("Ask model").click();
        await vi.waitFor(() => expect(requestIds).toHaveLength(2));
        expect(requestIds[1] === requestIds[0]).toBe(!fresh);
      } finally { await unmount(app); }
    });

  it("keeps a lost failed-read identity until retry confirms the terminal receipt", async () => {
    const requestIds: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/control-plane")) return Response.json(overview());
      if (path.startsWith("/api/tools?")) return Response.json({ tools,
        providers: [{ provider: "demo", state: "ready" }] });
      if (path === "/api/playground/assisted") {
        requestIds.push(JSON.parse(String(init?.body)).requestId);
        if (requestIds.length === 1) throw new TypeError("lost response");
        return Response.json({ status: "tool_error", terminalFailure: true,
          answer: "The previous read failed", receiptId: "receipt_failed",
          model: "fixture/model", servedModels: ["fixture/served"],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.00001 } });
      }
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = mount(Playground, { target: document.body,
      props: { data: { assistedEnabled: true } as never } });
    try {
      await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>("#playground-connection")?.value)
        .toBe("connection_one"));
      for (const [id, value] of [["assisted-model", "fixture/model"],
        ["assisted-prompt", "Find fixture"]]) {
        const field = document.getElementById(id) as HTMLInputElement;
        field.value = value;
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await vi.waitFor(() => expect(button("Ask model").disabled).toBe(false));
      button("Ask model").click();
      await vi.waitFor(() => expect(requestIds).toHaveLength(1));
      await vi.waitFor(() => expect(button("Ask model").disabled).toBe(false));
      button("Ask model").click();
      await vi.waitFor(() => expect(requestIds).toHaveLength(2));
      expect(requestIds[1]).toBe(requestIds[0]);
      await vi.waitFor(() => expect(document.body.textContent).toContain("The previous read failed"));
      button("Ask model").click();
      await vi.waitFor(() => expect(requestIds).toHaveLength(3));
      expect(requestIds[2]).not.toBe(requestIds[1]);
    } finally { await unmount(app); }
  });

  it.each(["succeeded", "failed", "running", "uncertain"])(
    "keeps a recovered %s write identity until explicit receipt settlement", async (receiptStatus) => {
      const requestIds: string[] = [];
      const terminal = receiptStatus === "succeeded" || receiptStatus === "failed";
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.startsWith("/api/control-plane")) return Response.json(overview());
        if (path.startsWith("/api/tools?")) return Response.json({ tools,
          providers: [{ provider: "demo", state: "ready" }] });
        if (path.startsWith("/api/playground/assisted/status")) return Response.json({
          approval: null, receipt: { id: "receipt_write", status: receiptStatus } });
        if (path === "/api/playground/assisted") {
          requestIds.push(JSON.parse(String(init?.body)).requestId);
          return Response.json({ status: receiptStatus === "failed" ? "tool_error"
            : terminal ? "answered" : "action_pending", terminalWrite: terminal,
            answer: `The previous write is ${receiptStatus}`, receiptId: "receipt_write",
            model: "fixture/model", servedModels: ["fixture/served"], toolId: "demo.write",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.00001 } });
        }
        return Response.json({ error: "NOT_FOUND" }, { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const app = mount(Playground, { target: document.body,
        props: { data: { assistedEnabled: true } as never } });
      try {
        await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>("#playground-connection")?.value)
          .toBe("connection_one"));
        for (const [id, value] of [["assisted-model", "fixture/model"],
          ["assisted-prompt", "Write fixture"]]) {
          const field = document.getElementById(id) as HTMLInputElement;
          field.value = value;
          field.dispatchEvent(new Event("input", { bubbles: true }));
        }
        await vi.waitFor(() => expect(button("Ask model").disabled).toBe(false));
        button("Ask model").click();
        await vi.waitFor(() => expect(document.body.textContent).toContain(`The previous write is ${receiptStatus}`));
        button("Ask model").click();
        await vi.waitFor(() => expect(requestIds).toHaveLength(2));
        expect(requestIds[1]).toBe(requestIds[0]);
        const start = [...document.querySelectorAll("button")].find((item) =>
          item.textContent?.trim() === "Start a new action");
        expect(!!start).toBe(terminal);
        if (terminal) {
          if (receiptStatus === "succeeded") {
            const prompt = document.getElementById("assisted-prompt") as HTMLTextAreaElement;
            prompt.value = "A different draft";
            prompt.dispatchEvent(new Event("input", { bubbles: true }));
          }
          start!.click();
          await vi.waitFor(() => expect(document.body.textContent).toContain("Ready for a new action"));
          if (receiptStatus === "succeeded") {
            const prompt = document.getElementById("assisted-prompt") as HTMLTextAreaElement;
            prompt.value = "Write fixture";
            prompt.dispatchEvent(new Event("input", { bubbles: true }));
          }
          button("Ask model").click();
          await vi.waitFor(() => expect(requestIds).toHaveLength(3));
          expect(requestIds[2]).not.toBe(requestIds[1]);
        }
      } finally { await unmount(app); }
    });

  it("refuses a fresh write identity when the receipt settlement probe disagrees", async () => {
    const requestIds: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/control-plane")) return Response.json(overview());
      if (path.startsWith("/api/tools?")) return Response.json({ tools,
        providers: [{ provider: "demo", state: "ready" }] });
      if (path.startsWith("/api/playground/assisted/status")) return Response.json({
        approval: null, receipt: { id: "receipt_write", status: "uncertain" } });
      if (path === "/api/playground/assisted") {
        requestIds.push(JSON.parse(String(init?.body)).requestId);
        return Response.json({ status: "answered", terminalWrite: true,
          answer: "The previous write completed", receiptId: "receipt_write",
          model: "fixture/model", servedModels: ["fixture/served"], toolId: "demo.write",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.00001 } });
      }
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = mount(Playground, { target: document.body,
      props: { data: { assistedEnabled: true } as never } });
    try {
      await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>("#playground-connection")?.value)
        .toBe("connection_one"));
      for (const [id, value] of [["assisted-model", "fixture/model"],
        ["assisted-prompt", "Write fixture"]]) {
        const field = document.getElementById(id) as HTMLInputElement;
        field.value = value;
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await vi.waitFor(() => expect(button("Ask model").disabled).toBe(false));
      button("Ask model").click();
      await vi.waitFor(() => expect(button("Start a new action").disabled).toBe(false));
      button("Start a new action").click();
      await vi.waitFor(() => expect(document.querySelector("[role=alert]")?.textContent)
        .toContain("not confirmed"));
      button("Ask model").click();
      await vi.waitFor(() => expect(requestIds).toHaveLength(2));
      expect(requestIds[1]).toBe(requestIds[0]);
    } finally { await unmount(app); }
  });

  it("cancels an in-flight assisted request and does not render its late result", async () => {
    let release: ((response: Response) => void) | undefined;
    const requestIds: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/control-plane")) return Response.json(overview());
      if (path.startsWith("/api/tools?")) return Response.json({ tools,
        providers: [{ provider: "demo", state: "ready" }] });
      if (path === "/api/playground/assisted") {
        requestIds.push(JSON.parse(String(init?.body)).requestId);
        return requestIds.length === 1 ? new Promise<Response>((resolve) => { release = resolve; })
          : Response.json({ status: "answered",
            answer: "The read completed. Its result is shown in the receipt below.",
            receiptId: "receipt_recovered",
            receipt: { id: "receipt_recovered", status: "succeeded",
              result: { title: "Recovered private item" }, errorCode: null },
            model: "fixture/model",
            servedModels: ["fixture/served"], usage: { promptTokens: 1,
              completionTokens: 1, totalTokens: 2, costUsd: 0.00001 } });
      }
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = mount(Playground, { target: document.body,
      props: { data: { assistedEnabled: true } as never } });
    try {
      await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>("#playground-connection")?.value)
        .toBe("connection_one"));
      for (const [id, value] of [["assisted-model", "fixture/model"],
        ["assisted-prompt", "Find fixture"]]) {
        const field = document.getElementById(id) as HTMLInputElement;
        field.value = value;
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await vi.waitFor(() => expect(button("Ask model").disabled).toBe(false));
      button("Ask model").click();
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      button("Cancel request").click();
      release!(Response.json({ status: "answered", answer: "Late answer", model: "fixture/model",
        servedModels: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2,
          costUsd: null } }));
      await vi.waitFor(() => expect(document.body.textContent).toContain("Request cancelled"));
      expect(document.body.textContent).not.toContain("Late answer");
      button("Ask model").click();
      await vi.waitFor(() => expect(document.body.textContent)
        .toContain("Recovered private item"));
      expect(document.querySelector("[aria-label='Execution result']")?.textContent)
        .toContain("receipt_recovered");
      expect(requestIds).toHaveLength(2);
      expect(requestIds[1]).toBe(requestIds[0]);
    } finally { await unmount(app); }
  });

  it("recovers a committed assisted approval after its response is lost", async () => {
    let release: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/control-plane")) return Response.json(overview());
      if (path.startsWith("/api/tools?")) return Response.json({ tools,
        providers: [{ provider: "demo", state: "ready" }] });
      if (path === "/api/playground/assisted") return new Promise<Response>((resolve) => { release = resolve; });
      if (path.startsWith("/api/playground/assisted/status")) return Response.json({
        approval: { id: "approval_one", status: "pending" }, receipt: null });
      if (path.startsWith("/api/approvals/status")) return Response.json(approval("pending"));
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = mount(Playground, { target: document.body,
      props: { data: { assistedEnabled: true } as never } });
    try {
      await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>("#playground-connection")?.value)
        .toBe("connection_one"));
      for (const [id, value] of [["assisted-model", "fixture/model"],
        ["assisted-prompt", "Write fixture"]]) {
        const field = document.getElementById(id) as HTMLInputElement;
        field.value = value;
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await vi.waitFor(() => expect(button("Ask model").disabled).toBe(false));
      button("Ask model").click();
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      button("Cancel request").click();
      release!(Response.json({ status: "approval_required", answer: "Late approval",
        model: "fixture/model", servedModels: [], usage: { promptTokens: 1,
          completionTokens: 1, totalTokens: 2, costUsd: null }, approval: approval("pending") }));
      await vi.waitFor(() => expect(document.querySelector("[aria-label='Approval']")?.textContent)
        .toContain("pending"));
      expect(document.body.textContent).not.toContain("Late approval");
      expect(fetchMock.mock.calls.filter(([path]) => String(path) === "/api/playground/assisted"))
        .toHaveLength(1);
    } finally { await unmount(app); }
  });

  it.each([
    { settlement: "consumed", lostResponse: false },
    { settlement: "rejected", lostResponse: false },
    { settlement: "consumed", lostResponse: true },
  ])("starts a fresh identical assisted request after $settlement (lost response: $lostResponse)",
    async ({ settlement, lostResponse }) => {
      const requestIds: string[] = [];
      const approvals = new Map<string, PlaygroundApproval>();
      let writes = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
        if (path.startsWith("/api/control-plane")) return Response.json(overview(undefined,
          [...approvals.values()].filter((item) => item.status === "pending")));
        if (path.startsWith("/api/tools?")) return Response.json({ tools,
          providers: [{ provider: "demo", state: "ready" }] });
        if (path.startsWith("/api/playground/assisted/status")) return Response.json({
          approval: approvals.get("approval_1") ?? null, receipt: null });
        if (path === "/api/playground/assisted") {
          const id = body.requestId;
          requestIds.push(id);
          const approvalId = `approval_${approvals.size + 1}`;
          approvals.set(approvalId, { ...approval("pending"), id: approvalId });
          if (lostResponse && requestIds.length === 1) throw new TypeError("response lost after commit");
          return Response.json({ status: "approval_required", answer: "Review the action.",
            model: "fixture/model", servedModels: ["fixture/served"], toolId: "demo.write",
            usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3, costUsd: 0.00001 },
            approval: approvals.get(approvalId) });
        }
        if (path.startsWith("/api/approvals/status")) {
          const id = new URL(`https://omr.invalid${path}`).searchParams.get("approvalId") ?? "";
          const key = `assisted_${requestIds[Number(id.slice(-1)) - 1]}`;
          const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
          return Response.json({ ...approvals.get(id), actionKeyDigest: [...new Uint8Array(bytes)]
            .map((byte) => byte.toString(16).padStart(2, "0")).join("") });
        }
        if (path === "/api/approvals/approve" || path === "/api/approvals/reject") {
          const current = approvals.get(body.approvalId)!;
          const next = { ...current, status: path.endsWith("reject") ? "rejected" : "approved" };
          approvals.set(current.id, next);
          return Response.json(next);
        }
        if (path === "/api/approvals/execute") {
          writes += 1;
          const current = approvals.get(body.approvalId)!;
          approvals.set(current.id, { ...current, status: "consumed",
            executionReceiptId: `receipt_${writes}` });
          return Response.json({ id: `receipt_${writes}`, status: "succeeded", result: {},
            errorCode: null });
        }
        return Response.json({ error: "NOT_FOUND" }, { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);
      let app = mount(Playground, { target: document.body,
        props: { data: { assistedEnabled: true } as never } });
      try {
        await vi.waitFor(() => expect(button("Ask model").disabled).toBe(true));
        for (const [id, value] of [["assisted-model", "fixture/model"],
          ["assisted-prompt", "Repeat this exact change"]]) {
          const field = document.getElementById(id) as HTMLInputElement;
          field.value = value;
          field.dispatchEvent(new Event("input", { bubbles: true }));
        }
        await vi.waitFor(() => expect(button("Ask model").disabled).toBe(false));
        button("Ask model").click();
        await vi.waitFor(() => expect(requestIds).toHaveLength(1));
        if (lostResponse) {
          await vi.waitFor(() => expect(button("Review approval").disabled).toBe(false));
          await unmount(app);
          document.body.replaceChildren();
          app = mount(Playground, { target: document.body,
            props: { data: { assistedEnabled: true } as never } });
          await vi.waitFor(() => expect(button("Review approval").disabled).toBe(false));
          button("Review approval").click();
        }
        await vi.waitFor(() => expect(button(settlement === "rejected" ? "Reject" : "Approve")
          .disabled).toBe(false));
        button(settlement === "rejected" ? "Reject" : "Approve").click();
        if (settlement === "consumed") {
          await vi.waitFor(() => expect(button("Execute approved change").disabled).toBe(false));
          button("Execute approved change").click();
          await vi.waitFor(() => expect(writes).toBe(1));
        }
        await vi.waitFor(() => expect(button("Start a new action").disabled).toBe(false));
        button("Start a new action").click();
        await vi.waitFor(() => expect(document.body.textContent).toContain("Ready for a new action"));
        expect(approvals.get("approval_1")?.status).toBe(settlement);
        expect(writes).toBe(settlement === "consumed" ? 1 : 0);
        if (lostResponse) {
          for (const [id, value] of [["assisted-model", "fixture/model"],
            ["assisted-prompt", "Repeat this exact change"]]) {
            const field = document.getElementById(id) as HTMLInputElement;
            field.value = value;
            field.dispatchEvent(new Event("input", { bubbles: true }));
          }
          await vi.waitFor(() => expect(button("Ask model").disabled).toBe(false));
        }
        button("Ask model").click();
        await vi.waitFor(() => expect(requestIds).toHaveLength(2));
        expect(requestIds[1]).not.toBe(requestIds[0]);
      } finally { await unmount(app); }
    });

  it("routes an assisted write through the visible approval before execution", async () => {
    let status = "pending";
    let writes = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/control-plane")) return Response.json(overview());
      if (path.startsWith("/api/tools?")) return Response.json({ tools,
        providers: [{ provider: "demo", state: "ready" }] });
      if (path === "/api/playground/assisted") return Response.json({
        status: "approval_required", answer: "Review before approving. No change has run.",
        model: "fixture/model", servedModels: ["fixture/served"], toolId: "demo.write",
        usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14, costUsd: 0.00002 },
        approval: approval("pending"),
      });
      if (path.startsWith("/api/approvals/status")) return Response.json(approval(status));
      if (path === "/api/approvals/approve") {
        status = "approved";
        return Response.json(approval(status));
      }
      if (path === "/api/approvals/execute") {
        writes += 1;
        status = "consumed";
        return Response.json({ id: "receipt_assisted_write", status: "succeeded",
          result: { title: "fixture" }, errorCode: null });
      }
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = mount(Playground, { target: document.body,
      props: { data: { assistedEnabled: true } as never } });
    try {
      await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>("#playground-connection")?.value)
        .toBe("connection_one"));
      for (const [id, value] of [["assisted-model", "fixture/model"],
        ["assisted-prompt", "Change fixture"]]) {
        const field = document.getElementById(id) as HTMLInputElement;
        field.value = value;
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await vi.waitFor(() => expect(button("Ask model").disabled).toBe(false));
      button("Ask model").click();
      await vi.waitFor(() => expect(document.querySelector("[aria-label='Approval']")?.textContent)
        .toContain("pending"));
      expect(writes).toBe(0);
      button("Approve").click();
      await vi.waitFor(() => expect(document.querySelector("[aria-label='Approval']")?.textContent)
        .toContain("approved"));
      expect(writes).toBe(0);
      button("Execute approved change").click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Approved change completed"));
      expect(writes).toBe(1);
      expect(document.body.textContent).toContain("receipt_assisted_write");
    } finally { await unmount(app); }
  });
});
