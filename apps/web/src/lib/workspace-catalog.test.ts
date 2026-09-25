import { describe, expect, it } from "vitest";

import { createWorkspaceCatalogLoader, type WorkspaceCatalogState } from "./workspace-catalog.js";

type Overview = { selectedWorkspaceId: string; connections: { provider: string; status: string }[] };
type Catalog = { providers: { provider: string; state: string; available?: boolean; authMode?: string }[] };

describe("workspace catalog loading", () => {
  it("keeps the overview and chosen OAuth provider during a same-workspace refresh", async () => {
    const states: WorkspaceCatalogState<Overview, Catalog>[] = [];
    const providers = [
      { provider: "github", state: "ready", available: true, authMode: "oauth" },
      { provider: "slack", state: "ready", available: true, authMode: "oauth" },
    ];
    let selectedOAuthProvider = "";
    let finishRefresh!: (catalog: Catalog) => void;
    let catalogRequests = 0;
    const load = createWorkspaceCatalogLoader<Overview, Catalog>(
      async () => ({ selectedWorkspaceId: "A", connections: [] }),
      async () => {
        catalogRequests++;
        if (catalogRequests === 2) return new Promise<Catalog>((resolve) => { finishRefresh = resolve; });
        if (catalogRequests === 3) throw new Error("catalog unavailable");
        return { providers };
      },
      (state) => {
        states.push(state);
        if (!state.catalog) selectedOAuthProvider = "";
        else if (!state.catalog.providers.some((item) => item.provider === selectedOAuthProvider && item.available)) {
          selectedOAuthProvider = state.catalog.providers.find((item) => item.available && item.authMode === "oauth")?.provider ?? "";
        }
      },
    );
    await load("A");
    selectedOAuthProvider = "slack";

    const refresh = load("A");
    await Promise.resolve();
    expect(states.at(-1)).toMatchObject({ selectedWorkspaceId: "A", loading: true, overview: { selectedWorkspaceId: "A" } });
    expect(states.at(-1)?.catalog?.providers).toEqual(providers);
    expect(selectedOAuthProvider).toBe("slack");
    finishRefresh({ providers });
    await refresh;
    expect(selectedOAuthProvider).toBe("slack");

    await load("A");
    expect(states.at(-1)).toMatchObject({ catalog: null, error: "catalog unavailable" });
  });

  it("clears A readiness when B discovery fails and restores only B after retry", async () => {
    const states: WorkspaceCatalogState<Overview, Catalog>[] = [];
    let failB = true;
    const load = createWorkspaceCatalogLoader<Overview, Catalog>(
      async (id) => ({ selectedWorkspaceId: id, connections: id === "B"
        ? [{ provider: "github", status: "active" }] : [] }),
      async (id) => {
        if (id === "B" && failB) throw new Error("catalog unavailable");
        return { providers: [{ provider: "github", state: id === "A" ? "ready" : "unconfigured" }] };
      },
      (state) => states.push(state),
    );
    await load("A");
    expect(states.at(-1)?.catalog?.providers[0]?.state).toBe("ready");
    await load("B");
    expect(states.at(-1)).toMatchObject({ selectedWorkspaceId: "B", catalog: null, error: "catalog unavailable" });
    expect(states.at(-1)?.overview?.connections).toEqual([{ provider: "github", status: "active" }]);
    expect(states.slice(-3).every((state) => state.catalog === null)).toBe(true);
    failB = false;
    await load("B");
    expect(states.at(-1)?.catalog?.providers[0]?.state).toBe("unconfigured");
  });

  it("discards a late catalog response from a previous workspace", async () => {
    const states: WorkspaceCatalogState<Overview, Catalog>[] = [];
    let finishA!: (catalog: Catalog) => void;
    const load = createWorkspaceCatalogLoader<Overview, Catalog>(
      async (id) => ({ selectedWorkspaceId: id, connections: [] }),
      (id) => id === "A" ? new Promise((resolve) => { finishA = resolve; })
        : Promise.resolve({ providers: [{ provider: "github", state: "unconfigured" }] }),
      (state) => states.push(state),
    );
    const oldLoad = load("A");
    await Promise.resolve();
    await load("B");
    finishA({ providers: [{ provider: "github", state: "ready" }] });
    await oldLoad;
    expect(states.at(-1)).toMatchObject({ selectedWorkspaceId: "B", catalog: { providers: [{ state: "unconfigured" }] } });
  });
});
