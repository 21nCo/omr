import { authorizationScopes } from "./connection-ui.js";
import { oauthCallbackUri, savePendingOAuthConnection } from "./oauth-connection.js";

export interface OAuthReviewInput {
  workspaceId: string;
  provider: string;
  ownership: "personal" | "workspace";
  label: string;
  origin: string;
}

export interface OAuthReviewState {
  destination: string;
  ownership: OAuthReviewInput["ownership"];
  scopes: string[];
}

/** Fence pending OAuth requests so a late response cannot replace a newer workspace review. */
export function createOAuthReviewController(deps: {
  storage: () => Pick<Storage, "setItem" | "removeItem">;
  readiness: (provider: string, workspaceId: string) => Promise<{ available: boolean; authMode: string }>;
  start: (input: OAuthReviewInput & { redirectUri: string }) => Promise<{ authUrl: string }>;
  update: (review: OAuthReviewState | null, busy: boolean) => void;
}) {
  let generation = 0;
  let destination = "";

  /** Remove the prior review's single-use callback intent. */
  function clearReview() {
    if (destination) {
      const state = new URL(destination).searchParams.get("state");
      if (state) deps.storage().removeItem(`omr.provider-oauth.${state}`);
    }
    destination = "";
  }

  return {
    /** Invalidate an in-flight provider response and clear the visible review. */
    cancel() {
      generation++;
      clearReview();
      deps.update(null, false);
    },
    /** Check availability and publish a review only for the current request. */
    async start(input: OAuthReviewInput): Promise<void> {
      const current = ++generation;
      clearReview();
      deps.update(null, true);
      try {
        const readiness = await deps.readiness(input.provider, input.workspaceId);
        if (current !== generation) return;
        if (!readiness.available || readiness.authMode !== "oauth") {
          throw new Error(`${input.provider} OAuth is not configured on this OMR environment.`);
        }
        const redirectUri = oauthCallbackUri(input.origin);
        const { authUrl } = await deps.start({ ...input, redirectUri });
        if (current !== generation) return;
        destination = savePendingOAuthConnection(deps.storage(), authUrl, {
          provider: input.provider,
          workspaceId: input.workspaceId,
          ownership: input.ownership,
          label: input.label,
          redirectUri,
          createdAt: Date.now(),
        });
        deps.update({ destination, ownership: input.ownership, scopes: authorizationScopes(destination) }, false);
      } catch (error) {
        if (current !== generation) return;
        deps.update(null, false);
        throw error;
      }
    },
  };
}
