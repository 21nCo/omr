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

/** Retain numeric Retry-After guidance from a definite HTTP denial. */
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

/** Classify only a provider response; transport failures never prove a write was rejected. */
function denialCode(status: number, providerCode: string,
  phase: NotionProviderDenial["phase"]): NotionProviderDenial["code"] | null {
  if (status === 429 || status === 529 || providerCode === "rate_limited" ||
      providerCode === "service_overload") return "NOTION_RATE_LIMITED";
  if (status === 401 || providerCode === "unauthorized") return "NOTION_RECONNECT_REQUIRED";
  if (status === 403 || providerCode === "restricted_resource") return "NOTION_PERMISSION_DENIED";
  if (status === 404 || providerCode === "object_not_found") return "NOTION_TARGET_UNAVAILABLE";
  if (status === 400 || providerCode === "validation_error") {
    return phase === "write" ? "NOTION_INVALID_CHANGE" : "NOTION_QUERY_REJECTED";
  }
  return null;
}

/** Read a provider code only from a structured HTTP response body. */
function responseCode(error: object): string {
  const body: unknown = Reflect.get(error, "data");
  if (!body || typeof body !== "object") return "";
  const code: unknown = Reflect.get(body, "code");
  return typeof code === "string" ? code : "";
}

/** Only an HTTP response proves a write was rejected. Transport failures stay uncertain. */
export function notionDenial(error: unknown, phase: NotionProviderDenial["phase"]): NotionProviderDenial | null {
  if (error instanceof NotionProviderDenial) return error;
  if (!error || typeof error !== "object") return null;
  const status: unknown = Reflect.get(error, "status");
  if (typeof status !== "number") return null;
  const code = denialCode(status, responseCode(error), phase);
  if (!code) return null;
  const headers: unknown = Reflect.get(error, "headers");
  return new NotionProviderDenial(phase, code, retryAfter(headers));
}
