/** A definite Linear denial, with no provider response body in the public error. */
export class LinearProviderDenial extends Error {
  readonly code: "LINEAR_RATE_LIMITED" | "LINEAR_RECONNECT_REQUIRED" |
    "LINEAR_PERMISSION_DENIED" | "LINEAR_TARGET_UNAVAILABLE" |
    "LINEAR_WORKSPACE_MISMATCH" | "LINEAR_INVALID_CHANGE" | "LINEAR_QUERY_REJECTED";
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
      LINEAR_QUERY_REJECTED: "Linear could not complete this query. Try again or check the selected account.",
    }[code]);
    this.name = "LinearProviderDenial";
    this.code = code;
    this.retryAfterSeconds = timing.retryAfterSeconds;
    this.rateLimitResetAt = timing.rateLimitResetAt;
  }
}

/** The provider returned a completed response, but its mutation result is unclear. */
export class LinearProviderResponseAmbiguous extends Error {
  constructor() {
    super("Linear mutation response is incomplete");
    this.name = "LinearProviderResponseAmbiguous";
  }
}

/** Read rate timing from either Fetch Headers or a provider header object. */
function header(error: object, name: string): unknown {
  if (!("headers" in error) || !error.headers) return undefined;
  if (error.headers instanceof Headers) return error.headers.get(name);
  if (typeof error.headers !== "object") return undefined;
  return Object.entries(error.headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

/** Accept only unsigned integral provider timing values. */
function integer(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (!/^\d+$/.test(String(value))) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

/** Prefer a recognized provider denial even when a generic GraphQL error comes first. */
function graphDenialCode(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || !("errors" in data) || !Array.isArray(data.errors)) return undefined;
  for (const error of data.errors) {
    if (!error || typeof error !== "object" || !("extensions" in error) ||
        !error.extensions || typeof error.extensions !== "object" || !("code" in error.extensions)) continue;
    const code = error.extensions.code;
    if (["RATELIMITED", "AUTHENTICATION_ERROR", "FORBIDDEN"].includes(String(code))) return String(code);
  }
  return undefined;
}

/** Map a provider status or recognized GraphQL code without exposing its message. */
function denialCode(status: unknown, graphCode: string | undefined,
  phase: LinearProviderDenial["phase"]): LinearProviderDenial["code"] | null {
  if (graphCode === "RATELIMITED" || status === 429) return "LINEAR_RATE_LIMITED";
  if (graphCode === "AUTHENTICATION_ERROR" || status === 401) return "LINEAR_RECONNECT_REQUIRED";
  if (graphCode === "FORBIDDEN" || status === 403) return "LINEAR_PERMISSION_DENIED";
  if (phase === "write" && status === 422) return "LINEAR_INVALID_CHANGE";
  if (phase === "write") return null;
  if (status === 404) return "LINEAR_TARGET_UNAVAILABLE";
  return "LINEAR_QUERY_REJECTED";
}

/** Only a provider HTTP response or GraphQL error can settle a write. */
export function linearDenial(error: unknown, phase: LinearProviderDenial["phase"]): LinearProviderDenial | null {
  if (!error || typeof error !== "object" || error instanceof LinearProviderDenial) {
    return error instanceof LinearProviderDenial ? error : null;
  }
  if ("code" in error && error.code === "CONNECTION_NOT_FOUND") return null;
  const status = "status" in error ? error.status : undefined;
  const data = "data" in error ? error.data : undefined;
  // GraphQL execution data can be partial even when HTTP reports an error.
  // Non-null propagation can also make data null after the mutation ran.
  if (phase === "write" && data && typeof data === "object" && "data" in data) return null;
  const graphCode = graphDenialCode(data);
  if (status !== 400 && status !== 401 && status !== 403 && status !== 404 &&
      status !== 408 && status !== 422 && status !== 429 && graphCode === undefined) return null;
  // A generic mutation error can follow a committed side effect. Preserve the
  // shared receipt's uncertain outcome unless the provider proved a denial.
  const code = denialCode(status, graphCode, phase);
  if (!code) return null;
  const resetMs = integer(header(error, "x-ratelimit-requests-reset")) ??
    integer(header(error, "x-ratelimit-endpoint-requests-reset"));
  return new LinearProviderDenial(phase, code, {
    retryAfterSeconds: integer(header(error, "retry-after")),
    rateLimitResetAt: resetMs,
  });
}
