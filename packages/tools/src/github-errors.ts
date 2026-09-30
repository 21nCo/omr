/** Safe, provider-independent details from a definite GitHub HTTP response. */
export interface GitHubHttpFailure {
  status: 401 | 403 | 404 | 410 | 422 | 429;
  rateLimited: boolean;
  retryAfterSeconds?: number;
  rateLimitResetAt?: number;
}

/** A confirmed GitHub response to the comment POST, without provider body or a retryable status. */
export class ConfirmedGitHubWriteRejection extends Error {
  constructor(readonly failure: GitHubHttpFailure) {
    super("GitHub rejected the comment request");
    this.name = "ConfirmedGitHubWriteRejection";
  }
}

export function githubHttpFailure(error: unknown, commentPost = false): GitHubHttpFailure | null {
  if (!error || typeof error !== "object") return null;
  const status = "code" in error && error.code === "GITHUB_READ_RATE_LIMIT" ? 429
    : "status" in error ? error.status : null;
  if (status !== 401 && status !== 403 && status !== 404 && status !== 429 &&
      !(commentPost && (status === 410 || status === 422))) return null;
  const rawHeaders = "headers" in error && error.headers && typeof error.headers === "object"
    ? error.headers : {};
  const headers = rawHeaders instanceof Headers
    ? Object.fromEntries(rawHeaders.entries())
    : Object.fromEntries(Object.entries(rawHeaders).map(([key, value]) => [key.toLowerCase(), value]));
  const numericHeader = (name: string): number | undefined => {
    const value = headers[name];
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const stringValue = String(value);
    if (!/^\d+$/.test(stringValue)) return undefined;
    const parsed = Number(stringValue);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  };
  const data = "data" in error && error.data && typeof error.data === "object" ? error.data : null;
  const message = data && "message" in data && typeof data.message === "string" ? data.message
    : "message" in error && typeof error.message === "string" ? error.message : "";
  return { status, rateLimited: status === 429 || status === 403 && (
    String(headers["x-ratelimit-remaining"]) === "0" || headers["retry-after"] !== undefined ||
    /rate.?limit|abuse detection/i.test(message)),
    retryAfterSeconds: numericHeader("retry-after"),
    rateLimitResetAt: numericHeader("x-ratelimit-reset") };
}
