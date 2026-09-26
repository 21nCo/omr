import type { ConnectionAuthority, ConnectionBindingRecord } from "@oh-my-router/connections";

/** Browser and HTTP clients receive binding state, never the remote handle; unannotated bindings are unselected. */
export async function publicConnections(
  authority: ConnectionAuthority,
  actorUserId: string,
  workspaceId: string,
  bindings: readonly (ConnectionBindingRecord & {
    providerState?: string;
    selectable?: boolean;
    cleanupOnly?: boolean;
  })[],
) {
  return projectConnections(authority, actorUserId, workspaceId, bindings, false);
}

/** A committed mutation must still return success when only selection lookup is unavailable. */
export async function publicConnectionsAfterMutation(
  authority: ConnectionAuthority,
  actorUserId: string,
  workspaceId: string,
  bindings: readonly (ConnectionBindingRecord & { providerState?: string; selectable?: boolean; cleanupOnly?: boolean })[],
) {
  return projectConnections(authority, actorUserId, workspaceId, bindings, true);
}

/** Project only safe binding fields and tolerate selection outages after a committed mutation. */
async function projectConnections(
  authority: ConnectionAuthority,
  actorUserId: string,
  workspaceId: string,
  bindings: readonly (ConnectionBindingRecord & { providerState?: string; selectable?: boolean; cleanupOnly?: boolean })[],
  tolerateSelectionFailure: boolean,
) {
  const selections = new Map(await Promise.all(
    [...new Set(bindings.map(({ provider }) => provider))].map(async (provider) => {
      let selectedId: string | undefined;
      try {
        selectedId = (await authority.getSelection({ actorUserId, workspaceId, provider }))?.connectionId;
      } catch (error) {
        if (!tolerateSelectionFailure) throw error;
      }
      return [provider, selectedId] as const;
    }),
  ));
  return bindings.map((binding) => ({
    id: binding.id,
    workspaceId: binding.workspaceId,
    provider: binding.provider,
    ownership: binding.ownership,
    ownerUserId: binding.ownerUserId,
    label: binding.cleanupOnly ? `Former member ${binding.provider} account` : binding.label,
    status: binding.status,
    readiness: binding.readiness,
    healthReason: binding.healthReason,
    lastCheckedAt: binding.lastCheckedAt,
    revokedAt: binding.revokedAt,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
    selected: binding.status === "active" && binding.readiness === "ready" &&
      binding.selectable === true && !binding.cleanupOnly &&
      selections.get(binding.provider) === binding.id,
    ...(binding.providerState ? { providerState: binding.providerState } : {}),
    ...(binding.selectable !== undefined ? { selectable: binding.selectable } : {}),
    ...(binding.cleanupOnly ? { cleanupOnly: true } : {}),
  }));
}
