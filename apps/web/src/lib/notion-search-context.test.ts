import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { notionSearchParams } from "./notion-search-params.js";
import { selectedLinearAccountId, selectedReadyNotionConnection, selectedSlackAccountId } from "./workspace-catalog.js";

function overview(workspaceId: string, selectedId: string | null) {
  return {
    selectedWorkspaceId: workspaceId,
    connections: selectedId ? [{ id: selectedId, provider: "notion", workspaceId,
      selected: true, status: "active", readiness: "ready" }] : [],
    approvals: [],
  };
}

const catalog = { tools: [{ id: "notion.content.search" }], providers: [] };
type PublishedState = { overview: ReturnType<typeof overview>; catalog: typeof catalog;
  selectedWorkspaceId: string; loading: boolean; error: string };

/** Exercise the page's workspace, catalog, mutation, and search handlers at the request boundary. */
function notionSearchHarness() {
  const page = readFileSync(new URL("../routes/app/+page.svelte", import.meta.url), "utf8");
  const script = page.match(/<script lang="ts">([\s\S]*?)<\/script>/)?.[1];
  const submitBody = page.match(/<form class="inset" onsubmit=\{\(event\) => \{ event\.preventDefault\(\); notionGeneration\+\+;([\s\S]*?)\}\}>\s*<label>Search shared content/)?.[1];
  if (!script || !submitBody) throw new Error("Notion search page handlers are missing");
  const source = ts.createSourceFile("page.ts", script, ts.ScriptTarget.Latest, true);
  const names = new Set(["switchWorkspace", "clearNotion", "notionAccount", "notionToolAvailable",
    "notionRead", "mutate", "reconnectOAuth", "disconnect"]);
  const functions = source.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ""));
  const loader = source.statements.find((node): node is ts.VariableStatement =>
    ts.isVariableStatement(node) && node.declarationList.declarations.some((entry) =>
      ts.isIdentifier(entry.name) && entry.name.text === "loadWorkspace"));
  if (functions.length !== names.size || !loader) throw new Error("Notion page context handlers changed");
  const code = ts.transpileModule(`${loader.getText(source)}\n${functions.map((node) => node.getText(source)).join("\n")}
    async function load(workspaceId = selectedWorkspaceId) { await loadWorkspace(workspaceId); }
    function submitSearch(event: { preventDefault(): void }) { event.preventDefault(); notionGeneration++; ${submitBody} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const calls: { workspaceId: string; connectionId: string; params: { query: string } }[] = [];
  const state = {
    overview: overview("A", "notion_a"), catalog, selectedWorkspaceId: "A", loading: false, busy: "",
    error: "", notice: "", recoveredApprovalId: "", recoveryInput: "", recoveryError: "",
    automaticApprovalLookup: null, apiKey: "", oauthProvider: "notion", credentialProvider: "",
    oauthOwnership: "personal", credentialOwnership: "personal", notionBusy: "", notionGeneration: 0,
    notionItems: [{ type: "page", id: "old" }], notionCursor: "old-cursor",
    notionQuery: "private A title", notionSubmittedQuery: "private A title",
    notionPageId: "old", notionPage: { id: "old" }, notionCreateTitle: "old", notionUpdateTitle: "old",
    notionSearchParams, selectedReadyNotionConnection, selectedLinearAccountId, selectedSlackAccountId,
    clearLinear: () => {}, clearSlack: () => {}, cancelAuthorization: () => {}, canInstallShared: () => true,
    connectOAuth: () => {}, reconnects: 0,
    revocationGuidance: () => null,
    createWorkspaceCatalogLoader: (_fetchOverview: unknown, _fetchCatalog: unknown,
      _publish: (next: PublishedState) => void) => async () => {},
    nextState: null as PublishedState | null,
    publish: (_next: PublishedState) => {},
    request: (path: string, options: { body: string }) => {
      if (path === "/api/tools/execute") {
        calls.push(JSON.parse(options.body));
        return Promise.resolve({ result: { items: [], nextCursor: null } });
      }
      if (path === "/api/connections/disconnect") return Promise.resolve({
        connection: { healthReason: null, label: "Notion" }, provider: { disconnected: true },
      });
      return Promise.resolve({});
    },
  };
  state.connectOAuth = () => { state.reconnects++; };
  state.createWorkspaceCatalogLoader = (_fetchOverview, _fetchCatalog, publish) => {
    state.publish = publish;
    return async () => { publish(state.nextState ?? {
      overview: state.overview, catalog: state.catalog, selectedWorkspaceId: state.selectedWorkspaceId,
      loading: false, error: "",
    }); };
  };
  vm.createContext(state);
  vm.runInContext(code, state);
  const handlers = state as typeof state & {
    switchWorkspace: () => Promise<void>;
    mutate: (name: string, path: string, body: unknown, success: string) => Promise<void>;
    reconnectOAuth: (connection: { provider: string }) => void;
    disconnect: (connection: { provider: string; id: string }) => Promise<void>;
    submitSearch: (event: { preventDefault(): void }) => void;
  };
  const submit = () => handlers.submitSearch({ preventDefault() {} });
  const publish = (workspaceId: string, connectionId: string | null) => handlers.publish({
    overview: overview(workspaceId, connectionId), catalog, selectedWorkspaceId: workspaceId,
    loading: false, error: "",
  });
  return { state: handlers, calls, submit, publish };
}

describe("Notion search context", () => {
  it("clears the draft through the workspace switch handler before searching elsewhere", async () => {
    const { state, calls, submit } = notionSearchHarness();
    state.selectedWorkspaceId = "B";
    state.nextState = { overview: overview("B", "notion_b"), catalog,
      selectedWorkspaceId: "B", loading: false, error: "" };
    await state.switchWorkspace();
    expect(state.notionQuery).toBe("");
    expect(state.notionSubmittedQuery).toBe("");
    submit();
    expect(calls).toEqual([{ workspaceId: "B", connectionId: "notion_b",
      toolId: "notion.content.search", params: { query: "" } }]);
  });

  it("clears the draft when a catalog publication changes the selected Notion binding", () => {
    const { state, calls, publish, submit } = notionSearchHarness();
    publish("A", "notion_other");
    expect(state.notionQuery).toBe("");
    submit();
    expect(calls).toEqual([{ workspaceId: "A", connectionId: "notion_other",
      toolId: "notion.content.search", params: { query: "" } }]);
  });

  it("clears the draft when catalog publication moves to a workspace without a binding", () => {
    const { state, calls, publish, submit } = notionSearchHarness();
    publish("B", null);
    expect(state.notionQuery).toBe("");
    submit();
    expect(calls).toEqual([]);
    publish("B", "notion_b");
    submit();
    expect(calls).toEqual([{ workspaceId: "B", connectionId: "notion_b",
      toolId: "notion.content.search", params: { query: "" } }]);
  });

  it("keeps a draft through unrelated health, refresh, selection, and reconciliation mutations", async () => {
    const { state, calls, submit } = notionSearchHarness();
    for (const name of ["health:github_a", "refresh:linear_a", "select:slack_a", "reconcile:other_approval"]) {
      await state.mutate(name, "/api/test", {}, "ok");
      expect(state.notionQuery).toBe("private A title");
    }
    submit();
    expect(calls).toEqual([{ workspaceId: "A", connectionId: "notion_a",
      toolId: "notion.content.search", params: { query: "private A title" } }]);
  });

  it("clears a draft when selection changes after a mutation", async () => {
    const { state, calls, submit } = notionSearchHarness();
    state.nextState = { overview: overview("A", "notion_other"), catalog,
      selectedWorkspaceId: "A", loading: false, error: "" };
    await state.mutate("select:notion_other", "/api/connections/select", {}, "ok");
    expect(state.notionQuery).toBe("");
    submit();
    expect(calls).toEqual([{ workspaceId: "A", connectionId: "notion_other",
      toolId: "notion.content.search", params: { query: "" } }]);
  });

  it("keeps a disconnected query out of reconnect and subsequent searches", async () => {
    const { state, calls, publish, submit } = notionSearchHarness();
    await state.disconnect({ provider: "notion", id: "notion_a" });
    expect(state.notionQuery).toBe("");
    state.notionQuery = "new draft";
    state.reconnectOAuth({ provider: "notion" });
    expect(state.reconnects).toBe(1);
    expect(state.notionQuery).toBe("");
    publish("A", null);
    submit();
    expect(calls).toEqual([]);
    publish("A", "notion_reconnected");
    submit();
    expect(calls).toEqual([{ workspaceId: "A", connectionId: "notion_reconnected",
      toolId: "notion.content.search", params: { query: "" } }]);
  });
});
