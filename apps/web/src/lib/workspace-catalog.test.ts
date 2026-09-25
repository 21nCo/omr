import { describe, expect, it } from "vitest";

import { createWorkspaceCatalogLoader, type WorkspaceCatalogState } from "./workspace-catalog.js";

type Overview = { selectedWorkspaceId: string; connections: { provider: string; status: string }[] };
type Catalog = { providers: { provider: string; state: string }[] };

describe("workspace catalog loading", () => {
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
