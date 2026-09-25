import {
  ConnectionSelectionRequiredError, ConnectionUnavailableError,
  isMissingRemoteConnection,
} from "@oh-my-router/connections";
import { usableToolIds, type ProviderStatus, type ToolCatalog } from "@oh-my-router/tools";

/** A deleted PlugFn connection is an unavailable grant, not a failed catalog. */
export async function resolveScopedCatalog(
  catalog: ToolCatalog,
  providers: readonly ProviderStatus[],
  resolveBinding: (provider: string) => Promise<{ id: string; providerConnectionId: string }>,
  remoteScopes: (connectionId: string) => Promise<readonly string[] | undefined>,
  onRemoteMissing: (bindingId: string) => Promise<void>,
): Promise<Set<string>> {
  return usableToolIds(catalog, providers, async (provider) => {
    let binding: { id: string; providerConnectionId: string };
    try {
      binding = await resolveBinding(provider);
    } catch (error) {
      if (error instanceof ConnectionSelectionRequiredError || error instanceof ConnectionUnavailableError) return null;
      throw error;
    }
    try {
      return await remoteScopes(binding.providerConnectionId);
    } catch (error) {
      if (isMissingRemoteConnection(error)) {
        await onRemoteMissing(binding.id);
        return null;
      }
      throw error;
    }
  });
}
