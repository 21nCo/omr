import { mount } from "svelte";
import Playground from "../../../apps/web/src/routes/app/playground/+page.svelte?client";

const tool = { catalogSchemaVersion: "1.0.0", id: "demo.read", provider: "demo",
  providerVersion: "1.0.0", action: "read", displayName: "Read fixture",
  description: "Fixture tool", hash: "demo.read", inputSchema: { type: "object",
    properties: { title: { type: "string" } } }, outputSchema: { type: "object" },
  contract: { version: "1.0.0", effect: "read", requiredScopes: [], resources: [],
    sensitiveKeys: [], pagination: { kind: "none" }, retry: "never" } };

window.__playgroundExecuteCalls = 0;
/** Supply one connected read tool and count browser-initiated executions. */
window.fetch = async (input) => {
  const path = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
  if (path.startsWith("/api/control-plane")) return Response.json({
    selectedWorkspaceId: "workspace_one", workspaces: [
      { workspace: { id: "workspace_one", name: "Mine" } }],
    connections: [{ id: "connection_one", workspaceId: "workspace_one", provider: "demo",
      label: "Demo account", status: "active", readiness: "ready", providerState: "ready",
      selectable: true, selected: true }], approvals: [] });
  if (path.startsWith("/api/tools?")) return Response.json({ tools: [tool],
    providers: [{ provider: "demo", state: "ready" }] });
  if (path.startsWith("/api/tools/manifest")) return Response.json(tool);
  if (path === "/api/tools/execute") {
    window.__playgroundExecuteCalls += 1;
    return Response.json({ id: "receipt_keyboard", status: "succeeded",
      result: { keyboard: true }, errorCode: null });
  }
  return Response.json({ error: "NOT_FOUND" }, { status: 404 });
};

mount(Playground, { target: document.body });
window.__playgroundMounted = true;
