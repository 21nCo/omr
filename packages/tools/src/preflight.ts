/** Thrown only by an adapter before it can dispatch its write request. */
export class ProviderPreflightError extends Error {
  constructor(
    readonly reason: "unverified_public_repository" | "repository_lookup_failed",
    readonly status: number | null = null,
    readonly failure: import("./github-errors.js").GitHubHttpFailure | null = null,
  ) {
    super("Provider write preflight failed");
    this.name = "ProviderPreflightError";
  }
}
