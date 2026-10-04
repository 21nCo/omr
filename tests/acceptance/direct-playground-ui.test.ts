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

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe("direct playground form", () => {
  it("keeps labeled controls keyboard usable and moves read/write through errors, approval and receipt", async () => {
    let writes = 0;
    let reads = 0;
    let approvalStatus = "pending";
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push(path);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (path.startsWith("/api/control-plane")) return Response.json({
        selectedWorkspaceId: "workspace_one",
        workspaces: [{ workspace: { id: "workspace_one", name: "Mine" } }],
        connections: [{ id: "connection_one", workspaceId: "workspace_one", provider: "demo",
          label: "Demo account", status: "active", readiness: "ready", selected: true }],
        approvals: [],
      });
      if (path.startsWith("/api/tools?")) return Response.json({ tools,
        providers: [{ provider: "demo", state: "ready" }] });
      if (path.startsWith("/api/tools/manifest")) return Response.json(
        tools.find((tool) => path.includes(encodeURIComponent(tool.id)) || path.includes(tool.id)));
      if (path === "/api/tools/execute") {
        reads += 1;
        return Response.json({ id: "receipt_read", status: "succeeded", result: { title: body.params },
          errorCode: null });
      }
      if (path === "/api/approvals") return Response.json({ id: "approval_one",
        workspaceId: "workspace_one", connectionId: "connection_one", toolId: "demo.write",
        status: approvalStatus, params: { title: "[REDACTED]" }, previewReady: true,
        manifestCurrent: true, expiresAt: Date.now() + 60_000 });
      if (path === "/api/approvals/approve") {
        approvalStatus = "approved";
        return Response.json({ id: "approval_one", status: approvalStatus });
      }
      if (path.startsWith("/api/approvals/status")) return Response.json({ id: "approval_one",
        workspaceId: "workspace_one", connectionId: "connection_one", toolId: "demo.write",
        status: approvalStatus, params: { title: "[REDACTED]" }, previewReady: true,
        manifestCurrent: true, expiresAt: Date.now() + 60_000,
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
