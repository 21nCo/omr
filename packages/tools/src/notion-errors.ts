export class NotionProviderDenial extends Error {
  readonly code: "NOTION_RATE_LIMITED" | "NOTION_RECONNECT_REQUIRED" |
    "NOTION_PERMISSION_DENIED" | "NOTION_TARGET_UNAVAILABLE" |
    "NOTION_INVALID_CHANGE" | "NOTION_QUERY_REJECTED";
  constructor(readonly phase: "read" | "preflight" | "write", code: NotionProviderDenial["code"],
    readonly retryAfterSeconds?: number) {
    super({
      NOTION_RATE_LIMITED: "Notion rate limit reached. Retry after its reset window.",
      NOTION_RECONNECT_REQUIRED: "Notion rejected this connection. Reconnect the account.",
      NOTION_PERMISSION_DENIED: "Notion denied access. Check the integration's content capabilities and page sharing.",
      NOTION_TARGET_UNAVAILABLE: "This page is unavailable to the selected Notion integration.",
      NOTION_INVALID_CHANGE: "Notion rejected this page change. Review the title and destination.",
      NOTION_QUERY_REJECTED: "Notion could not complete this read. Try again later.",
    }[code]);
    this.name = "NotionProviderDenial";
    this.code = code;
  }
}

export class NotionProviderResponseAmbiguous extends Error {
  constructor() {
    super("Notion page response is incomplete");
    this.name = "NotionProviderResponseAmbiguous";
  }
}

function retryAfter(headers: unknown): number | undefined {
  let value: unknown;
  if (headers instanceof Headers) value = headers.get("retry-after");
  else if (headers && typeof headers === "object") {
    const key = Object.keys(headers).find((name) => name.toLowerCase() === "retry-after");
    if (key) value = Reflect.get(headers, key);
  }
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (!/^\d+$/.test(String(value))) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

/** Only an HTTP response proves a write was rejected. Transport failures stay uncertain. */
export function notionDenial(error: unknown, phase: NotionProviderDenial["phase"]): NotionProviderDenial | null {
  if (error instanceof NotionProviderDenial) return error;
  if (!error || typeof error !== "object" || !("status" in error) || typeof error.status !== "number") return null;
  const status = error.status;
  const body = "data" in error && error.data && typeof error.data === "object" ? error.data : null;
  const providerCode = body && "code" in body && typeof body.code === "string" ? body.code : "";
  const code: NotionProviderDenial["code"] | null = status === 429 || providerCode === "rate_limited"
    ? "NOTION_RATE_LIMITED" : status === 401 || providerCode === "unauthorized"
      ? "NOTION_RECONNECT_REQUIRED" : status === 403 || providerCode === "restricted_resource"
        ? "NOTION_PERMISSION_DENIED" : status === 404 || providerCode === "object_not_found"
          ? "NOTION_TARGET_UNAVAILABLE" : status === 400 || providerCode === "validation_error"
            ? phase === "write" ? "NOTION_INVALID_CHANGE" : "NOTION_QUERY_REJECTED" : null;
  return code ? new NotionProviderDenial(phase, code, retryAfter("headers" in error ? error.headers : undefined)) : null;
}
