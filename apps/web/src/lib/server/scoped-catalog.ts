import {
  ConnectionSelectionRequiredError, ConnectionUnavailableError,
  isMissingRemoteConnection,
} from "@oh-my-router/connections";
import { githubHttpFailure, usableToolIds, type ProviderStatus, type ToolCatalog } from "@oh-my-router/tools";

/** A deleted PlugFn connection is an unavailable grant, not a failed catalog. */
export async function resolveScopedCatalog(
  catalog: ToolCatalog,
  providers: readonly ProviderStatus[],
  resolveBinding: (provider: string) => Promise<{ id: string; providerConnectionId: string }>,
  remoteScopes: (connectionId: string, provider: string) => Promise<readonly string[] | undefined>,
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
      return await remoteScopes(binding.providerConnectionId, provider);
    } catch (error) {
      if (isMissingRemoteConnection(error)) {
        await onRemoteMissing(binding.id);
        return null;
      }
      // A definite GitHub profile denial makes only that provider's grants
      // unavailable; it must not hide healthy providers in the same catalog.
      if (provider === "github" && githubHttpFailure(error)) return null;
      throw error;
    }
  });
}
