export interface WorkspaceCatalogState<Overview, Catalog> {
  overview: Overview | null;
  catalog: Catalog | null;
  selectedWorkspaceId: string;
  loading: boolean;
  error: string;
}

/** Bind Linear discovery to the selected account in the current workspace. */
export function selectedLinearAccountId<Connection extends { id: string; provider: string; selected: boolean }>(
  overview: { selectedWorkspaceId: string | null; connections: readonly Connection[] } | null,
  workspaceId: string,
): string | null {
  if (overview?.selectedWorkspaceId !== workspaceId) return null;
  return overview.connections.find((connection) => connection.provider === "linear" && connection.selected)?.id ?? null;
}

/** A completed ambiguous response can be checked for a definite absence. */
export function linearEffectAbsentAvailable(
  approval: { executionReceiptId?: string | null },
  receipts: readonly { id: string; status: string; errorCode: string | null }[],
): boolean {
  return Boolean(approval.executionReceiptId && receipts.some((receipt) =>
    receipt.id === approval.executionReceiptId && receipt.status === "uncertain" &&
    receipt.errorCode === "provider_response_ambiguous"));
}

/** A pending selection cannot reuse the previous account's browser controls. */
export function selectedReadyLinearConnection<Connection extends { provider: string; selected: boolean;
  status: string; readiness: string }>(state: {
  overview: { selectedWorkspaceId: string | null; connections: readonly Connection[] } | null;
  selectedWorkspaceId: string;
  loading: boolean;
  busy: string;
}): Connection | undefined {
  if (state.loading || state.busy || state.overview?.selectedWorkspaceId !== state.selectedWorkspaceId) {
    return undefined;
  }
  return state.overview.connections.find((connection) => connection.provider === "linear" && connection.selected &&
    connection.status === "active" && connection.readiness === "ready");
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
