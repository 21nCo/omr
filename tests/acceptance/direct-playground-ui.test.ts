// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";
import type { ToolManifest } from "@oh-my-router/tools";
import Playground from "../../apps/web/src/routes/app/playground/+page.svelte?client";

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

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((element) =>
    element.textContent?.trim() === label);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`Button missing: ${label}`);
  return found;
}

function select(id: string, value: string) {
  const element = document.getElementById(id) as HTMLSelectElement;
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function submit() {
  document.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true,
    cancelable: true }));
}

function approval(status: string) {
  return { id: "approval_one", workspaceId: "workspace_one", connectionId: "connection_one",
    toolId: "demo.write", status, params: { title: "[REDACTED]" }, previewReady: true,
    manifestCurrent: true, expiresAt: Date.now() + 60_000, browserActionable: true };
}

function overview(connections = [{ id: "connection_one", workspaceId: "workspace_one", provider: "demo",
  label: "Demo account", status: "active", readiness: "ready", providerState: "ready",
  selectable: true, selected: true }], approvals: ReturnType<typeof approval>[] = []) {
  return { selectedWorkspaceId: "workspace_one",
    workspaces: [{ workspace: { id: "workspace_one", name: "Mine" } },
      { workspace: { id: "workspace_two", name: "Other" } }], connections, approvals };
}

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe("direct playground form", () => {
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
    let status = "pending";
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
        return Response.json(approval(status));
      }
      if (path === `/api/approvals/${operation}`) {
        status = "expired";
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

  it("submits the focused form control and ignores an in-flight result after workspace change", async () => {
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
      submitButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
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
        return Response.json({ id: "approval_one", status: approvalStatus });
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
});
