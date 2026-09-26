export interface WorkspaceCatalogState<Overview, Catalog> {
  overview: Overview | null;
  catalog: Catalog | null;
  selectedWorkspaceId: string;
  loading: boolean;
  error: string;
}

/** Missing discovery is unknown; a known catalog missing a provider is unsupported. */
export function providerDisplayState<State extends string>(
  catalog: { providers: readonly { provider: string; state: State }[] } | null,
  provider: string,
): State | "unsupported" | "unknown" {
  if (!catalog) return "unknown";
  return catalog.providers.find((entry) => entry.provider === provider)?.state ?? "unsupported";
}

/** Keep a workspace overview and its catalog on the same request generation. */
export function createWorkspaceCatalogLoader<Overview extends { selectedWorkspaceId: string | null }, Catalog>(
  fetchOverview: (workspaceId: string) => Promise<Overview>,
  fetchCatalog: (workspaceId: string) => Promise<Catalog>,
  publish: (state: WorkspaceCatalogState<Overview, Catalog>) => void,
): (workspaceId: string) => Promise<void> {
  let generation = 0;
  let visible: WorkspaceCatalogState<Overview, Catalog> | null = null;
  const show = (state: WorkspaceCatalogState<Overview, Catalog>) => {
    visible = state;
    publish(state);
  };
  return async (workspaceId) => {
    const current = ++generation;
    const retained = visible?.selectedWorkspaceId === workspaceId ? visible : null;
    let overview: Overview | null = retained?.overview ?? null;
    let selectedWorkspaceId = workspaceId;
    show({ overview, catalog: retained?.catalog ?? null, selectedWorkspaceId, loading: true, error: "" });
    try {
      overview = await fetchOverview(workspaceId);
      if (current !== generation) return;
      selectedWorkspaceId = overview.selectedWorkspaceId ?? "";
      show({
        overview,
        catalog: retained?.selectedWorkspaceId === selectedWorkspaceId ? retained.catalog : null,
        selectedWorkspaceId, loading: true, error: "",
      });
      const catalog = selectedWorkspaceId ? await fetchCatalog(selectedWorkspaceId) : null;
      if (current !== generation) return;
      show({ overview, catalog, selectedWorkspaceId, loading: false, error: "" });
    } catch (error_) {
      if (current !== generation) return;
      show({
        overview, catalog: null, selectedWorkspaceId, loading: false,
        error: error_ instanceof Error ? error_.message : "Could not load the control plane",
      });
    }
  };
}
