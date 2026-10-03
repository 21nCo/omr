import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { notionSearchParams } from "./notion-search-params.js";
import { selectedReadyNotionConnection } from "./workspace-catalog.js";

/** Run the page's clear and submit handlers against a captured request boundary. */
function notionSearchHarness() {
  const page = readFileSync(new URL("../routes/app/+page.svelte", import.meta.url), "utf8");
  const script = page.match(/<script lang="ts">([\s\S]*?)<\/script>/)?.[1];
  const submitBody = page.match(/<form class="inset" onsubmit=\{\(event\) => \{ event\.preventDefault\(\); notionGeneration\+\+;([\s\S]*?)\}\}>\s*<label>Search shared content/)?.[1];
  if (!script || !submitBody) throw new Error("Notion search page handlers are missing");
  const source = ts.createSourceFile("page.ts", script, ts.ScriptTarget.Latest, true);
  const names = new Set(["clearNotion", "notionAccount", "notionToolAvailable", "notionRead"]);
  const functions = source.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ""));
  if (functions.length !== names.size) throw new Error("Notion search page functions changed");
  const code = ts.transpileModule(`${functions.map((node) => node.getText(source)).join("\n")}
    function submitSearch(event: { preventDefault(): void }) { event.preventDefault(); notionGeneration++; ${submitBody} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const calls: { workspaceId: string; connectionId: string; params: { query: string } }[] = [];
  const state = {
    overview: { selectedWorkspaceId: "A", connections: [{ id: "notion_a", provider: "notion", workspaceId: "A", selected: true,
      status: "active", readiness: "ready" }] },
    catalog: { tools: [{ id: "notion.content.search" }] },
    selectedWorkspaceId: "A",
    loading: false,
    busy: "",
    notionBusy: "",
    notionGeneration: 0,
    notionItems: [{ type: "page", id: "old" }],
    notionCursor: "old-cursor",
    notionQuery: "private A title",
    notionSubmittedQuery: "private A title",
    notionPageId: "old",
    notionPage: { id: "old" },
    notionCreateTitle: "old",
    notionUpdateTitle: "old",
    error: "",
    notionSearchParams,
    selectedReadyNotionConnection,
    request: (_path: string, options: { body: string }) => {
      calls.push(JSON.parse(options.body));
      return Promise.resolve({ result: { items: [], nextCursor: null } });
    },
  };
  vm.createContext(state);
  vm.runInContext(code, state);
  const handlers = state as typeof state & {
    clearNotion: () => void;
    submitSearch: (event: { preventDefault(): void }) => void;
  };
  return { state: handlers, calls };
}

describe("Notion search context", () => {
  it.each([
    ["workspace switch", "B", "notion_b"],
    ["selected integration change", "A", "notion_other"],
    ["reconnect", "A", "notion_reconnected"],
  ])("does not carry an editable query into a %s request", (_change, workspaceId, connectionId) => {
    const { state, calls } = notionSearchHarness();
    state.selectedWorkspaceId = workspaceId;
    state.overview.selectedWorkspaceId = workspaceId;
    state.overview.connections = [{ id: connectionId, provider: "notion", workspaceId,
      selected: true, status: "active", readiness: "ready" }];
    state.clearNotion();
    expect(state.notionQuery).toBe("");
    expect(state.notionSubmittedQuery).toBe("");
    state.submitSearch({ preventDefault() {} });
    expect(calls).toEqual([{ workspaceId, connectionId,
      toolId: "notion.content.search", params: { query: "" } }]);
  });

  it("keeps a disconnected query out of the next integration search", () => {
    const { state, calls } = notionSearchHarness();
    state.overview.connections = [];
    state.clearNotion();
    state.submitSearch({ preventDefault() {} });
    expect(calls).toEqual([]);
    state.overview.connections = [{ id: "notion_new", provider: "notion", workspaceId: "A",
      selected: true, status: "active", readiness: "ready" }];
    state.submitSearch({ preventDefault() {} });
    expect(calls).toEqual([{ workspaceId: "A", connectionId: "notion_new",
      toolId: "notion.content.search", params: { query: "" } }]);
  });
});
