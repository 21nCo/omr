import type { ClientCapability, DeviceClientKind } from "@oh-my-router/client-access";
import type { JsonValue, ToolDiscoveryPage, ToolEffect, ToolManifest } from "@oh-my-router/tools";

export interface OMRClientOptions {
  baseUrl: string;
  credential: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
}

export interface DeviceCredential {
  credential: string;
  clientId: string;
  grantId: string;
  workspaceId: string;
}

export class OMRHttpError extends Error {
  readonly code = "OMR_HTTP_ERROR";
  readonly details: unknown;
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`OMR request failed (${status}) for ${path}`);
    this.name = "OMRHttpError";
    this.details = body;
  }
}

function normalizedBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("OMR backend must use HTTPS or localhost HTTP");
  }
  return url.toString().replace(/\/$/, "");
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

async function request<T>(input: {
  baseUrl: string;
  path: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  credential?: string;
  method?: "GET" | "POST";
  body?: unknown;
}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await input.fetchImpl(`${input.baseUrl}${input.path}`, {
      method: input.method ?? "GET",
      headers: {
        ...(input.credential ? { authorization: `Bearer ${input.credential}` } : {}),
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: controller.signal,
    });
    const body = await responseBody(response);
    if (!response.ok) throw new OMRHttpError(response.status, input.path, body);
    return body as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function beginDeviceAuthorization(input: {
  baseUrl: string;
  clientKind: DeviceClientKind;
  clientName: string;
  requestedCapabilities: ClientCapability[];
  fetchImpl?: typeof fetch;
}): Promise<DeviceAuthorization> {
  return request({
    baseUrl: normalizedBaseUrl(input.baseUrl),
    path: "/api/device/authorization",
    fetchImpl: input.fetchImpl ?? fetch,
    timeoutMs: 10_000,
    method: "POST",
    body: {
      clientKind: input.clientKind,
      clientName: input.clientName,
      requestedCapabilities: input.requestedCapabilities,
    },
  });
}

export async function pollDeviceAuthorization(input: {
  baseUrl: string;
  deviceCode: string;
  fetchImpl?: typeof fetch;
}): Promise<DeviceCredential> {
  return request({
    baseUrl: normalizedBaseUrl(input.baseUrl),
    path: "/api/device/token",
    fetchImpl: input.fetchImpl ?? fetch,
    timeoutMs: 10_000,
    method: "POST",
    body: { deviceCode: input.deviceCode },
  });
}

export class OMRClient {
  private readonly baseUrl: string;
  private readonly credential: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OMRClientOptions) {
    this.baseUrl = normalizedBaseUrl(options.baseUrl);
    this.credential = options.credential;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  discoverTools(input: {
    workspaceId: string;
    query?: string;
    provider?: string;
    effect?: ToolEffect;
    limit?: number;
    cursor?: string;
  }): Promise<ToolDiscoveryPage> {
    const params = new URLSearchParams();
    params.set("workspaceId", input.workspaceId);
    if (input.query) params.set("q", input.query);
    if (input.provider) params.set("provider", input.provider);
    if (input.effect) params.set("effect", input.effect);
    if (input.limit) params.set("limit", String(input.limit));
    if (input.cursor) params.set("cursor", input.cursor);
    return this.get(`/api/tools${params.size ? `?${params}` : ""}`);
  }

  getTool(toolId: string, workspaceId: string): Promise<ToolManifest> {
    return this.get(`/api/tools/manifest?id=${encodeURIComponent(toolId)}&workspaceId=${encodeURIComponent(workspaceId)}`);
  }

  listConnections(workspaceId: string, provider?: string): Promise<unknown> {
    return this.post("/api/connections/list", { workspaceId, ...(provider ? { provider } : {}) });
  }

  selectConnection(input: { workspaceId: string; provider: string; connectionId: string }): Promise<unknown> {
    return this.post("/api/connections/select", input);
  }

  execute(input: {
    workspaceId: string;
    toolId: string;
    params: JsonValue;
    connectionId?: string;
    idempotencyKey?: string;
  }): Promise<unknown> {
    return this.post("/api/tools/execute", input);
  }

  requestApproval(input: {
    workspaceId: string;
    toolId: string;
    params: JsonValue;
    connectionId?: string;
    idempotencyKey?: string;
  }): Promise<unknown> {
    return this.post("/api/approvals", input);
  }

  approve(approvalId: string): Promise<unknown> {
    return this.post("/api/approvals/approve", { approvalId });
  }

  reject(approvalId: string): Promise<unknown> {
    return this.post("/api/approvals/reject", { approvalId });
  }

  executeApproved(approvalId: string): Promise<unknown> {
    return this.post("/api/approvals/execute", { approvalId });
  }

  private get<T>(path: string): Promise<T> {
    return request({
      baseUrl: this.baseUrl,
      path,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      credential: this.credential,
    });
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return request({
      baseUrl: this.baseUrl,
      path,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      credential: this.credential,
      method: "POST",
      body,
    });
  }
}
