export interface WorkspaceCatalogState<Overview, Catalog> {
  overview: Overview | null;
  catalog: Catalog | null;
  selectedWorkspaceId: string;
  loading: boolean;
  error: string;
}

/** Keep a workspace overview and its catalog on the same request generation. */
export function createWorkspaceCatalogLoader<Overview extends { selectedWorkspaceId: string | null }, Catalog>(
  fetchOverview: (workspaceId: string) => Promise<Overview>,
  fetchCatalog: (workspaceId: string) => Promise<Catalog>,
  publish: (state: WorkspaceCatalogState<Overview, Catalog>) => void,
): (workspaceId: string) => Promise<void> {
  let generation = 0;
  return async (workspaceId) => {
    const current = ++generation;
    let overview: Overview | null = null;
    let selectedWorkspaceId = workspaceId;
    publish({ overview, catalog: null, selectedWorkspaceId, loading: true, error: "" });
    try {
      overview = await fetchOverview(workspaceId);
      if (current !== generation) return;
      selectedWorkspaceId = overview.selectedWorkspaceId ?? "";
      publish({ overview, catalog: null, selectedWorkspaceId, loading: true, error: "" });
      const catalog = selectedWorkspaceId ? await fetchCatalog(selectedWorkspaceId) : null;
      if (current !== generation) return;
      publish({ overview, catalog, selectedWorkspaceId, loading: false, error: "" });
    } catch (caught) {
      if (current !== generation) return;
      publish({
        overview, catalog: null, selectedWorkspaceId, loading: false,
        error: caught instanceof Error ? caught.message : "Could not load the control plane",
      });
    }
  };
}
