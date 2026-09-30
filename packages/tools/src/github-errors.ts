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

/** Distinguish a provider response from a PlugFn credential lookup failure. */
function failureStatus(error: object, commentPost: boolean): GitHubHttpFailure["status"] | null {
  if ("code" in error && error.code === "CONNECTION_NOT_FOUND") return null;
  let status: unknown = null;
  if ("code" in error && error.code === "GITHUB_READ_RATE_LIMIT") status = 429;
  else if ("status" in error) status = error.status;
  if (status === 401 || status === 403 || status === 404 || status === 429) return status;
  if (commentPost && (status === 410 || status === 422)) return status;
  return null;
}

/** Normalize native Headers and plain provider headers for safe metadata parsing. */
function failureHeaders(error: object): Record<string, unknown> {
  if (!("headers" in error) || !error.headers || typeof error.headers !== "object") return {};
  if (error.headers instanceof Headers) return Object.fromEntries(error.headers.entries());
  return Object.fromEntries(Object.entries(error.headers).map(([key, value]) => [key.toLowerCase(), value]));
}

/** Accept only nonnegative, safe integer timing headers. */
function numericHeader(headers: Record<string, unknown>, name: string): number | undefined {
  const value = headers[name];
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const stringValue = String(value);
  if (!/^\d+$/.test(stringValue)) return undefined;
  const parsed = Number(stringValue);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Read provider text only to detect a limit; never return it to callers. */
function failureMessage(error: object): string {
  if ("data" in error && error.data && typeof error.data === "object" &&
      "message" in error.data && typeof error.data.message === "string") return error.data.message;
  if ("message" in error && typeof error.message === "string") return error.message;
  return "";
}

/** Return safe metadata only for definite GitHub HTTP denials. */
export function githubHttpFailure(error: unknown, commentPost = false): GitHubHttpFailure | null {
  if (!error || typeof error !== "object") return null;
  const status = failureStatus(error, commentPost);
  if (status === null) return null;
  const headers = failureHeaders(error);
  const message = failureMessage(error);
  return { status, rateLimited: status === 429 || status === 403 && (
    String(headers["x-ratelimit-remaining"]) === "0" || headers["retry-after"] !== undefined ||
    /rate.?limit|abuse detection/i.test(message)),
    retryAfterSeconds: numericHeader(headers, "retry-after"),
    rateLimitResetAt: numericHeader(headers, "x-ratelimit-reset") };
}
