import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

/** Exercise the browser's actual approval handler with a page returned by pages.get. */
function approvalHarness(parent: { type: string; page_id?: string; database_id?: string;
  data_source_id?: string }) {
  const page = readFileSync(new URL("../routes/app/+page.svelte", import.meta.url), "utf8");
  const script = page.match(/<script lang="ts">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Notion browser script is missing");
  const source = ts.createSourceFile("page.ts", script, ts.ScriptTarget.Latest, true);
  const names = new Set(["notionParams", "notionDatabaseRow", "notionApproval"]);
  const functions = source.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ""));
  if (functions.length !== names.size) throw new Error("Notion approval handlers changed");
  const code = ts.transpileModule(functions.map((node) => node.getText(source)).join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const request = vi.fn(async () => ({ id: "approval-a", status: "pending", expiresAt: 1000 }));
  const state = {
    notionPage: { id: "page-a", title: "Original", parent }, notionPageId: "page-a",
    notionCreateTitle: "Child", notionUpdateTitle: "Renamed", notionBusy: "",
    notionGeneration: 0, selectedWorkspaceId: "workspace-a", error: "", notice: "",
    notionAccount: () => ({ id: "connection-a" }), notionToolAvailable: () => true,
    notionActionKeys: { key: async () => "intent-a" }, request,
    notionApprovalRecovery: (approval: { id: string }) => ({ id: approval.id, automaticLookup: null }),
    notionApprovalNotice: () => "Approval requested", load: async () => {},
  };
  vm.createContext(state);
  vm.runInContext(code, state);
  return { state: state as typeof state & { notionApproval(toolId: string): Promise<void> }, request };
}

describe("Notion browser row boundary", () => {
  it.each(["data_source_id", "database_id"] as const)(
    "does not request rename approval for a selected %s row", async (type) => {
      const { state, request } = approvalHarness({ type, [type]: "database-a" });
      await state.notionApproval("notion.pages.update");
      expect(request).not.toHaveBeenCalled();
      expect(state.error).toContain("Database rows are read-only");
    });

  it("still requests rename approval for an ordinary selected page", async () => {
    const { state, request } = approvalHarness({ type: "page_id", page_id: "parent-a" });
    await state.notionApproval("notion.pages.update");
    expect(request).toHaveBeenCalledWith("/api/approvals", expect.objectContaining({
      body: expect.stringContaining('"toolId":"notion.pages.update"'),
    }));
  });
});
