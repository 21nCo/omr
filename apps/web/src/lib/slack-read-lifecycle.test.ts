import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { sameSlackReadSelection, selectedReadySlackConnection } from "./workspace-catalog.js";

type Reply = { result: { messages: string[] } };

/** Exercise the page's real read flow with deferred responses, without a browser host. */
function pageReadHarness() {
  const page = readFileSync(new URL("../routes/app/+page.svelte", import.meta.url), "utf8");
  const script = page.match(/<script lang="ts">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("App page script is missing");
  const source = ts.createSourceFile("page.ts", script, ts.ScriptTarget.Latest, true);
  const functions = source.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && ["slackAccount", "slackToolAvailable", "slackRead"].includes(node.name?.text ?? ""));
  if (functions.length !== 3) throw new Error("Slack read functions changed");
  const code = ts.transpileModule(functions.map((node) => node.getText(source)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const pending: { resolve: (value: Reply) => void; reject: (reason: Error) => void }[] = [];
  const state = {
    overview: { selectedWorkspaceId: "workspace_a", connections: [{ id: "bot_a", provider: "slack",
      selected: true, status: "active", readiness: "ready", workspaceId: "workspace_a" }] },
    catalog: { tools: [{ id: "slack.messages.list" }] },
    selectedWorkspaceId: "workspace_a",
    loading: false,
    busy: "",
    slackBusy: "",
    slackGeneration: 0,
    slackReadOwner: null as { generation: number; workspaceId: string; accountId: string } | null,
    error: "",
    sameSlackReadSelection,
    selectedReadySlackConnection,
    request: () => new Promise<Reply>((resolve, reject) => pending.push({ resolve, reject })),
  };
  vm.createContext(state);
  vm.runInContext(code, state);
  const read = (state as typeof state & { slackRead: (
    toolId: string, params: object, publish: (value: Reply["result"]) => void,
  ) => Promise<void> }).slackRead;
  return { state, read, pending };
}

describe("Slack page read lifecycle", () => {
  it.each(["busy", "loading"])("releases its own lock when %s hides the account", async (hiddenBy) => {
    const { state, read, pending } = pageReadHarness();
    const published: Reply["result"][] = [];
    const first = read("slack.messages.list", {}, (value) => published.push(value));
    expect(state.slackBusy).toBe("slack.messages.list");
    if (hiddenBy === "busy") state.busy = "reject:unrelated";
    else state.loading = true;
    pending.shift()?.resolve({ result: { messages: ["stale while hidden"] } });
    await first;
    expect(published).toEqual([]);
    expect(state.slackBusy).toBe("");
    expect(state.slackReadOwner).toBeNull();

    state.busy = "";
    state.loading = false;
    const second = read("slack.messages.list", {}, (value) => published.push(value));
    pending.shift()?.resolve({ result: { messages: ["fresh"] } });
    await second;
    expect(published).toEqual([{ messages: ["fresh"] }]);
    expect(state.slackBusy).toBe("");
  });

  it("releases after a hidden read error without showing a stale error", async () => {
    const { state, read, pending } = pageReadHarness();
    const operation = read("slack.messages.list", {}, () => { throw new Error("unexpected publish"); });
    state.busy = "oauth:unrelated";
    pending.shift()?.reject(new Error("provider read failed"));
    await operation;
    expect(state.error).toBe("");
    expect(state.slackBusy).toBe("");
  });

  it("does not let an abandoned read release or publish over the next read", async () => {
    const { state, read, pending } = pageReadHarness();
    const published: Reply["result"][] = [];
    const old = read("slack.messages.list", {}, (value) => published.push(value));
    state.slackGeneration++;
    state.slackBusy = "";
    state.slackReadOwner = null;
    const current = read("slack.messages.list", {}, (value) => published.push(value));
    pending.shift()?.resolve({ result: { messages: ["old channel"] } });
    await old;
    expect(published).toEqual([]);
    expect(state.slackBusy).toBe("slack.messages.list");
    pending.shift()?.resolve({ result: { messages: ["new channel"] } });
    await current;
    expect(published).toEqual([{ messages: ["new channel"] }]);
    expect(state.slackBusy).toBe("");
  });
});
