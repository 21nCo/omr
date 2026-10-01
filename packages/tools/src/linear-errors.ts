/** A definite Linear denial, with no provider response body in the public error. */
export class LinearProviderDenial extends Error {
  readonly code: "LINEAR_RATE_LIMITED" | "LINEAR_RECONNECT_REQUIRED" |
    "LINEAR_PERMISSION_DENIED" | "LINEAR_TARGET_UNAVAILABLE" |
    "LINEAR_WORKSPACE_MISMATCH" | "LINEAR_INVALID_CHANGE";
  readonly retryAfterSeconds?: number;
  readonly rateLimitResetAt?: number;

  constructor(readonly phase: "read" | "preflight" | "write", code: LinearProviderDenial["code"],
    timing: { retryAfterSeconds?: number; rateLimitResetAt?: number } = {}) {
    super({
      LINEAR_RATE_LIMITED: "Linear rate limit reached. Retry after its reset window.",
      LINEAR_RECONNECT_REQUIRED: "Linear rejected this connection. Reconnect the account.",
      LINEAR_PERMISSION_DENIED: "Linear denied access. Check the selected account and its scopes.",
      LINEAR_TARGET_UNAVAILABLE: "Linear could not find this team or issue in the selected account.",
      LINEAR_WORKSPACE_MISMATCH: "The selected Linear account belongs to a different Linear workspace.",
      LINEAR_INVALID_CHANGE: "Linear rejected this issue change. Review the target and fields before requesting a new approval.",
    }[code]);
    this.name = "LinearProviderDenial";
    this.code = code;
    this.retryAfterSeconds = timing.retryAfterSeconds;
    this.rateLimitResetAt = timing.rateLimitResetAt;
  }
}

function header(error: object, name: string): unknown {
  if (!("headers" in error) || !error.headers) return undefined;
  if (error.headers instanceof Headers) return error.headers.get(name);
  if (typeof error.headers !== "object") return undefined;
  return Object.entries(error.headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

function integer(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (!/^\d+$/.test(String(value))) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

/** Only a provider HTTP response or GraphQL error can settle a write. */
export function linearDenial(error: unknown, phase: LinearProviderDenial["phase"]): LinearProviderDenial | null {
  if (!error || typeof error !== "object" || error instanceof LinearProviderDenial) {
    return error instanceof LinearProviderDenial ? error : null;
  }
  if ("code" in error && error.code === "CONNECTION_NOT_FOUND") return null;
  const status = "status" in error ? error.status : undefined;
  const data = "data" in error ? error.data : undefined;
  const errors = data && typeof data === "object" && "errors" in data ? data.errors : undefined;
  const graphCode = Array.isArray(errors) && errors[0] && typeof errors[0] === "object" &&
    "extensions" in errors[0] && errors[0].extensions && typeof errors[0].extensions === "object" &&
    "code" in errors[0].extensions ? errors[0].extensions.code : undefined;
  if (status !== 400 && status !== 401 && status !== 403 && status !== 404 &&
      status !== 422 && status !== 429 && graphCode === undefined) return null;
  // A generic mutation error can follow a committed side effect. Preserve the
  // shared receipt's uncertain outcome unless the provider proved a denial.
  if (phase === "write" && !["RATELIMITED", "AUTHENTICATION_ERROR", "FORBIDDEN"].includes(String(graphCode)) &&
    status !== 401 && status !== 403 && status !== 429) return null;
  const code = graphCode === "RATELIMITED" || status === 429 ? "LINEAR_RATE_LIMITED"
    : status === 401 || graphCode === "AUTHENTICATION_ERROR" ? "LINEAR_RECONNECT_REQUIRED"
    : status === 403 || graphCode === "FORBIDDEN" ? "LINEAR_PERMISSION_DENIED"
    : status === 404 ? "LINEAR_TARGET_UNAVAILABLE" : "LINEAR_INVALID_CHANGE";
  const resetMs = integer(header(error, "x-ratelimit-requests-reset")) ??
    integer(header(error, "x-ratelimit-endpoint-requests-reset"));
  return new LinearProviderDenial(phase, code, {
    retryAfterSeconds: integer(header(error, "retry-after")),
    rateLimitResetAt: resetMs,
  });
}
