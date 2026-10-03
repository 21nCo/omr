/** Safe Slack failure, without provider response text or token details. */
export class SlackProviderDenial extends Error {
  readonly code: "SLACK_RATE_LIMITED" | "SLACK_RECONNECT_REQUIRED" |
    "SLACK_PERMISSION_DENIED" | "SLACK_WORKSPACE_MISMATCH" |
    "SLACK_CHANNEL_UNAVAILABLE" | "SLACK_POST_REJECTED" | "SLACK_QUERY_REJECTED";
  readonly retryAfterSeconds?: number;

  constructor(readonly phase: "read" | "preflight" | "write", code: SlackProviderDenial["code"],
    retryAfterSeconds?: number) {
    super({
      SLACK_RATE_LIMITED: "Slack rate limit reached. Retry after its reset window.",
      SLACK_RECONNECT_REQUIRED: "Slack rejected this connection. Reconnect the account.",
      SLACK_PERMISSION_DENIED: "Slack denied access. Check the bot's channel membership and scopes.",
      SLACK_WORKSPACE_MISMATCH: "The selected Slack account belongs to another workspace or sender.",
      SLACK_CHANNEL_UNAVAILABLE: "This channel is unavailable to the selected Slack bot.",
      SLACK_POST_REJECTED: "Slack rejected this message. Review its channel and text before requesting another approval.",
      SLACK_QUERY_REJECTED: "Slack could not complete this read. Try again or check the selected account.",
    }[code]);
    this.name = "SlackProviderDenial";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A dispatched post produced no trustworthy completed result. */
export class SlackProviderResponseAmbiguous extends Error {
  constructor() {
    super("Slack post response is incomplete");
    this.name = "SlackProviderResponseAmbiguous";
  }
}

/** Read Slack's retry window from either Fetch Headers or a plain response header map. */
function retryAfter(error: object): number | undefined {
  const headers = "headers" in error ? error.headers : undefined;
  let value: unknown;
  if (headers instanceof Headers) value = headers.get("retry-after");
  else if (headers && typeof headers === "object") {
    const name = Object.keys(headers).find((key) => key.toLowerCase() === "retry-after");
    value = name ? Reflect.get(headers, name) : undefined;
  }
  const seconds = typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (!/^\d+$/.test(seconds)) return undefined;
  const parsed = Number(seconds);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

const apiDenials: Record<string, SlackProviderDenial["code"]> = {
  invalid_auth: "SLACK_RECONNECT_REQUIRED", token_expired: "SLACK_RECONNECT_REQUIRED",
  token_revoked: "SLACK_RECONNECT_REQUIRED", account_inactive: "SLACK_RECONNECT_REQUIRED",
  not_authed: "SLACK_RECONNECT_REQUIRED", missing_scope: "SLACK_PERMISSION_DENIED",
  not_allowed_token_type: "SLACK_PERMISSION_DENIED", restricted_action: "SLACK_PERMISSION_DENIED",
  no_permission: "SLACK_PERMISSION_DENIED", channel_not_found: "SLACK_CHANNEL_UNAVAILABLE",
  not_in_channel: "SLACK_CHANNEL_UNAVAILABLE", is_archived: "SLACK_CHANNEL_UNAVAILABLE",
  msg_too_long: "SLACK_POST_REJECTED", no_text: "SLACK_POST_REJECTED",
  invalid_text: "SLACK_POST_REJECTED", invalid_arguments: "SLACK_POST_REJECTED",
};

/** Preserve HTTP priority, then classify Slack's HTTP 200 ok:false API code. */
function denialCode(status: unknown, providerCode: string | undefined,
  phase: SlackProviderDenial["phase"]): SlackProviderDenial["code"] | undefined {
  if (status === 429 || providerCode === "ratelimited" || providerCode === "rate_limited") {
    return "SLACK_RATE_LIMITED";
  }
  if (status === 401) return "SLACK_RECONNECT_REQUIRED";
  if (status === 403) return "SLACK_PERMISSION_DENIED";
  const mapped = providerCode && Object.hasOwn(apiDenials, providerCode) ? apiDenials[providerCode] : undefined;
  if (mapped === "SLACK_POST_REJECTED") {
    return phase === "write" ? mapped : "SLACK_QUERY_REJECTED";
  }
  if (mapped) return mapped;
  return phase === "write" ? undefined : "SLACK_QUERY_REJECTED";
}

/** Slack uses HTTP 200 with ok:false for most definite API denials. */
export function slackDenial(error: unknown, phase: SlackProviderDenial["phase"]): SlackProviderDenial | null {
  if (error instanceof SlackProviderDenial) return error;
  if (!error || typeof error !== "object") return null;
  if ("code" in error && error.code === "CONNECTION_NOT_FOUND") return null;
  const status = "status" in error ? error.status : undefined;
  const body = "data" in error && error.data && typeof error.data === "object" ? error.data : error;
  const providerCode = "error" in body && typeof body.error === "string" ? body.error : undefined;
  const code = denialCode(status, providerCode, phase);
  return code ? new SlackProviderDenial(phase, code, retryAfter(error)) : null;
}
