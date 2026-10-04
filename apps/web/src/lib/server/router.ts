import { createRouter, RouterError } from "@superfunctions/http";
import {
  CLIENT_CAPABILITIES,
  ClientAccessDeniedError,
  ClientAccessInputError,
  ClientCapabilityDeniedError,
  DeviceAuthorizationError,
  InvalidClientCredentialError,
  type ClientCapability,
  type DeviceClientKind,
} from "@oh-my-router/client-access";
import {
  connectPostgresClientAccess,
  connectPostgresDeviceLogin,
} from "@oh-my-router/client-access/postgres";
import { connectPostgresConnections } from "@oh-my-router/connections/postgres";
import {
  ConnectionAccessDeniedError,
  ConnectionInputError,
  ConnectionSelectionRequiredError,
  ConnectionUnavailableError,
  ConnectionProviderOperationError,
  ConnectionCleanupUntrackedError,
  ProviderUnavailableError,
  type ConnectionOwnership,
  type GithubAccess,
  type LinearAccess,
  type SlackAccess,
} from "@oh-my-router/connections";
import { publicDatafnSchema } from "@oh-my-router/data";
import { connectPostgresDataRuntime } from "@oh-my-router/data/postgres";
import { connectPostgresIdentityRuntime } from "@oh-my-router/identity/postgres";
import {
  WorkspaceAccessDeniedError,
  WorkspaceInputError,
} from "@oh-my-router/identity";
import { LinearProviderDenial, NotionProviderDenial, SlackProviderDenial, ToolCatalogInputError, type ToolEffect } from "@oh-my-router/tools";
import {
  ApprovalUnavailableError,
  ExecutionApprovalRequiredError,
  ExecutionCapabilityDeniedError,
  ExecutionFailedError,
  GitHubReadError,
  GitHubScopeProofError,
  GitHubWritePreflightError,
  GitHubWriteRejectedError,
  LinearExecutionError,
  SlackExecutionError,
  NotionExecutionError,
  LinearIntentTransactionRequiredError,
  ExecutionIdempotencyConflictError,
  ExecutionInProgressError,
  ExecutionInvocationDeadlineError,
  ExecutionOutcomeUnknownError,
  ExecutionInputError,
} from "@oh-my-router/execution";

export interface DeviceRouteServices {
  begin(input: {
    clientKind: DeviceClientKind;
    clientName: string;
    requestedCapabilities: readonly ClientCapability[];
  }): Promise<unknown>;
  poll(deviceCode: string): Promise<unknown>;
  approve(
    request: Request,
    input: { userCode: string; workspaceId: string },
  ): Promise<unknown>;
}

export interface ConnectionRouteServices {
  providerReadiness(request: Request, provider: string, workspaceId?: string): Promise<unknown>;
  list(request: Request, input: { workspaceId: string; provider?: string }): Promise<unknown>;
  select(request: Request, input: { workspaceId: string; provider: string; connectionId: string }): Promise<unknown>;
  startOAuth(request: Request, input: {
    workspaceId: string;
    provider: string;
    ownership: ConnectionOwnership;
    redirectUri: string;
    label: string;
    githubAccess?: GithubAccess;
    linearAccess?: LinearAccess;
    slackAccess?: SlackAccess;
    returnTo?: string;
  }): Promise<unknown>;
  completeOAuth(request: Request, input: {
    workspaceId: string;
    provider: string;
    ownership: ConnectionOwnership;
    code: string;
    state: string;
    label: string;
    redirectUri?: string;
  }): Promise<unknown>;
  connectApiKey(request: Request, input: {
    workspaceId: string;
    provider: string;
    ownership: ConnectionOwnership;
    apiKey: string;
    label: string;
  }): Promise<unknown>;
  checkHealth(request: Request, connectionId: string): Promise<unknown>;
  refresh(request: Request, connectionId: string): Promise<unknown>;
  disconnect(request: Request, connectionId: string): Promise<unknown>;
}

export interface ToolRouteServices {
  discover(request: Request, input: {
    workspaceId: string;
    query?: string;
    providers?: string[];
    effects?: ToolEffect[];
    limit?: number;
    cursor?: string;
  }): Promise<unknown>;
  manifest(request: Request, toolId: string, workspaceId: string): Promise<unknown>;
}

export interface ExecutionRouteServices {
  execute(request: Request, input: {
    workspaceId: string;
    toolId: string;
    params: unknown;
    connectionId?: string;
    idempotencyKey?: string;
  }): Promise<unknown>;
  requestApproval(request: Request, input: {
    workspaceId: string;
    toolId: string;
    params: unknown;
    connectionId?: string;
    idempotencyKey: string;
  }): Promise<unknown>;
  approve(request: Request, approvalId: string): Promise<unknown>;
  reject(request: Request, approvalId: string): Promise<unknown>;
  executeApproved(request: Request, approvalId: string): Promise<unknown>;
  approvalStatus?(request: Request, approvalId: string, workspaceId?: string): Promise<unknown>;
  reconcileUncertain?(request: Request, approvalId: string,
    decision: "effect_present" | "effect_absent", workspaceId?: string): Promise<unknown>;
}

export interface ControlPlaneRouteServices {
  overview(request: Request, workspaceId?: string, approvalId?: string): Promise<unknown>;
  createTeam(request: Request, name: string): Promise<unknown>;
  listManualGrants(request: Request, cursor?: string): Promise<unknown>;
  revokeManualClient(request: Request, clientId: string): Promise<unknown>;
  revokeSelf?(request: Request): Promise<unknown>;
}

class RequestInputError extends Error {
  readonly code = "REQUEST_INPUT_INVALID";
}

export class RuntimeUnavailableError extends Error {
  readonly code = "RUNTIME_UNAVAILABLE";
}

export class RequestOriginDeniedError extends Error {
  readonly code = "REQUEST_ORIGIN_DENIED";
}

const CAPABILITIES = new Set<string>(CLIENT_CAPABILITIES);
const PRIVATE_RESPONSE = { "cache-control": "no-store" };

type GitHubRouteError = GitHubReadError | GitHubScopeProofError |
  GitHubWritePreflightError | GitHubWriteRejectedError;

/** Map safe GitHub failure codes to the public HTTP contract. */
function githubStatus(code: GitHubRouteError["code"]): number {
  switch (code) {
    case "GITHUB_RATE_LIMITED": return 429;
    case "GITHUB_RECONNECT_REQUIRED": return 401;
    case "GITHUB_REPOSITORY_UNAVAILABLE": return 404;
    case "GITHUB_COMMENT_UNAVAILABLE": return 410;
    case "GITHUB_COMMENT_REJECTED": return 422;
    case "GITHUB_PREFLIGHT_UNAVAILABLE": return 503;
    default: return 403;
  }
}

/** Preserve only safe receipt and rate-limit metadata at the HTTP boundary. */
function githubErrorResponse(error: GitHubRouteError): Response {
  const body: { error: string; message: string; receiptId?: string } = {
    error: error.code, message: error.message,
  };
  if ("receiptId" in error) body.receiptId = error.receiptId;
  const headers: Record<string, string> = { ...PRIVATE_RESPONSE };
  if (error.code === "GITHUB_RATE_LIMITED") {
    if (error.retryAfterSeconds !== undefined) headers["retry-after"] = String(error.retryAfterSeconds);
    if (error.rateLimitResetAt !== undefined) headers["x-ratelimit-reset"] = String(error.rateLimitResetAt);
  }
  return Response.json(body, { status: githubStatus(error.code), headers });
}

/** Return the public HTTP status for one safe Linear failure code. */
function linearStatus(code: LinearProviderDenial["code"]): number {
  switch (code) {
    case "LINEAR_RATE_LIMITED": return 429;
    case "LINEAR_RECONNECT_REQUIRED": return 401;
    case "LINEAR_TARGET_UNAVAILABLE": return 404;
    case "LINEAR_WORKSPACE_MISMATCH": return 409;
    case "LINEAR_QUERY_REJECTED": return 502;
    case "LINEAR_INVALID_CHANGE": return 422;
    default: return 403;
  }
}

/** Linear GraphQL limits can arrive with HTTP 400; expose only safe timing metadata. */
function linearErrorResponse(error: LinearExecutionError | LinearProviderDenial): Response {
  const headers: Record<string, string> = { ...PRIVATE_RESPONSE };
  if (error.code === "LINEAR_RATE_LIMITED") {
    if (error.retryAfterSeconds !== undefined) headers["retry-after"] = String(error.retryAfterSeconds);
    if (error.rateLimitResetAt !== undefined) headers["x-ratelimit-requests-reset"] = String(error.rateLimitResetAt);
  }
  return Response.json({ error: error.code, message: error.message,
    ...("receiptId" in error ? { receiptId: error.receiptId } : {}) }, { status: linearStatus(error.code), headers });
}

function slackErrorResponse(error: SlackExecutionError | SlackProviderDenial): Response {
  const status = {
    SLACK_RATE_LIMITED: 429, SLACK_RECONNECT_REQUIRED: 401,
    SLACK_PERMISSION_DENIED: 403, SLACK_WORKSPACE_MISMATCH: 409,
    SLACK_CHANNEL_UNAVAILABLE: 404, SLACK_POST_REJECTED: 422,
    SLACK_QUERY_REJECTED: 502,
  }[error.code];
  const headers: Record<string, string> = { ...PRIVATE_RESPONSE };
  if (error.code === "SLACK_RATE_LIMITED" && error.retryAfterSeconds !== undefined) {
    headers["retry-after"] = String(error.retryAfterSeconds);
  }
  return Response.json({ error: error.code, message: error.message,
    ...("receiptId" in error ? { receiptId: error.receiptId } : {}) }, { status, headers });
}

function notionErrorResponse(error: NotionExecutionError | NotionProviderDenial): Response {
  const status = {
    NOTION_RATE_LIMITED: 429, NOTION_RECONNECT_REQUIRED: 401,
    NOTION_PERMISSION_DENIED: 403, NOTION_ACCESS_RESTRICTED: 403, NOTION_TARGET_UNAVAILABLE: 404,
    NOTION_INVALID_CHANGE: 422, NOTION_QUERY_REJECTED: 502,
  }[error.code];
  const headers: Record<string, string> = { ...PRIVATE_RESPONSE };
  if (error.code === "NOTION_RATE_LIMITED" && error.retryAfterSeconds !== undefined) {
    headers["retry-after"] = String(error.retryAfterSeconds);
  }
  return Response.json({ error: error.code, message: error.message,
    ...("receiptId" in error ? { receiptId: error.receiptId } : {}) }, { status, headers });
}

/** Require a JSON object before reading route-specific fields. */
function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestInputError("A JSON object is required");
  }
  return value as Record<string, unknown>;
}

/** Read a required nonempty string from a validated request body. */
function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new RequestInputError(`${field} is required`);
  }
  return value;
}

/** Accept only declared client capabilities from a device request. */
function requestedCapabilities(body: Record<string, unknown>): ClientCapability[] {
  const value = body.requestedCapabilities;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((capability) => typeof capability !== "string" || !CAPABILITIES.has(capability))
  ) {
    throw new RequestInputError("requestedCapabilities must contain recognized capabilities");
  }
  return value as ClientCapability[];
}

/** Validate an optional nonempty string when the caller supplies it. */
function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new RequestInputError(`${field} must be a non-empty string`);
  }
  return value;
}

/** Require an explicit personal or workspace connection owner. */
function ownership(body: Record<string, unknown>): ConnectionOwnership {
  const value = body.ownership;
  if (value !== "personal" && value !== "workspace") {
    throw new RequestInputError("ownership must be personal or workspace");
  }
  return value;
}

/** Accept only the consent tiers exposed by the GitHub v1 connection journey. */
function githubAccess(body: Record<string, unknown>): GithubAccess | undefined {
  const value = body.githubAccess;
  if (value === undefined) return undefined;
  if (value === "profile" || value === "public_write" || value === "private_repositories") return value;
  throw new RequestInputError("githubAccess must be profile, public_write, or private_repositories");
}

function linearAccess(body: Record<string, unknown>): LinearAccess | undefined {
  const value = body.linearAccess;
  if (value === undefined) return undefined;
  if (value === "read" || value === "issue_write") return value;
  throw new RequestInputError("linearAccess must be read or issue_write");
}

function slackAccess(body: Record<string, unknown>): SlackAccess | undefined {
  const value = body.slackAccess;
  if (value === undefined) return undefined;
  if (value === "discover" || value === "read" || value === "post" || value === "read_post") return value;
  throw new RequestInputError("slackAccess must be discover, read, post, or read_post");
}

function unavailableDeviceServices(): DeviceRouteServices {
  const unavailable = async (): Promise<never> => {
    throw new RuntimeUnavailableError("Device login runtime is not configured");
  };
  return { begin: unavailable, poll: unavailable, approve: unavailable };
}

function unavailableConnectionServices(): ConnectionRouteServices {
  const unavailable = async (): Promise<never> => {
    throw new RuntimeUnavailableError("Connection runtime is not configured");
  };
  return {
    providerReadiness: unavailable,
    list: unavailable,
    select: unavailable,
    startOAuth: unavailable,
    completeOAuth: unavailable,
    connectApiKey: unavailable,
    checkHealth: unavailable,
    refresh: unavailable,
    disconnect: unavailable,
  };
}

function unavailableToolServices(): ToolRouteServices {
  const unavailable = async (): Promise<never> => {
    throw new RuntimeUnavailableError("Tool catalog runtime is not configured");
  };
  return { discover: unavailable, manifest: unavailable };
}

function unavailableExecutionServices(): ExecutionRouteServices {
  const unavailable = async (): Promise<never> => {
    throw new RuntimeUnavailableError("Execution runtime is not configured");
  };
  return {
    execute: unavailable,
    requestApproval: unavailable,
    approve: unavailable,
    reject: unavailable,
    executeApproved: unavailable,
  };
}

function unavailableControlPlaneServices(): ControlPlaneRouteServices {
  const unavailable = async (): Promise<never> => {
    throw new RuntimeUnavailableError("Control-plane runtime is not configured");
  };
  return {
    overview: unavailable,
    createTeam: unavailable,
    listManualGrants: unavailable,
    revokeManualClient: unavailable,
  };
}

function codedError(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Mount health, device, connection, tool, execution, and control-plane routes. */
export function createOMRRouter(
  deviceServices: DeviceRouteServices = unavailableDeviceServices(),
  connectionServices: ConnectionRouteServices = unavailableConnectionServices(),
  toolServices: ToolRouteServices = unavailableToolServices(),
  executionServices: ExecutionRouteServices = unavailableExecutionServices(),
  controlPlaneServices: ControlPlaneRouteServices = unavailableControlPlaneServices(),
) {
  return createRouter({
    maxBodyBytes: 16 * 1024,
    onError: (error, request) => {
      if (error instanceof RouterError) return error.toResponse();
      if (error instanceof DeviceAuthorizationError) {
        return Response.json(
          {
            error: error.code,
            ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}),
          },
          { status: 400 },
        );
      }
      if (error instanceof ClientAccessInputError || error instanceof RequestInputError) {
        return Response.json({ error: error.code, message: error.message }, { status: 400 });
      }
      if (codedError(error, "AUTHFN_UNAUTHENTICATED")) {
        return Response.json({ error: error.code }, { status: 401 });
      }
      if (error instanceof WorkspaceAccessDeniedError) {
        return Response.json({ error: error.code }, { status: 403 });
      }
      if (error instanceof RequestOriginDeniedError) {
        return Response.json({ error: error.code }, { status: 403 });
      }
      if (error instanceof WorkspaceInputError) {
        return Response.json({ error: error.code, message: error.message }, { status: 400 });
      }
      if (error instanceof InvalidClientCredentialError) {
        return Response.json({ error: error.code }, { status: 401 });
      }
      if (error instanceof ClientCapabilityDeniedError) {
        return Response.json({ error: error.code, capability: error.capability }, { status: 403 });
      }
      if (error instanceof ClientAccessDeniedError) {
        return Response.json({ error: error.code }, { status: 403 });
      }
      if (error instanceof ConnectionInputError) {
        return Response.json({ error: error.code, message: error.message }, { status: 400 });
      }
      if (error instanceof ToolCatalogInputError) {
        return Response.json({ error: error.code, message: error.message }, { status: 400 });
      }
      if (error instanceof ExecutionInputError) {
        return Response.json({ error: error.code, message: error.message }, { status: 400 });
      }
      if (error instanceof ExecutionCapabilityDeniedError) {
        return Response.json(
          { error: error.code, capability: error.capability },
          { status: 403 },
        );
      }
      if (error instanceof ExecutionApprovalRequiredError) {
        return Response.json({
          error: error.code,
          tool: error.manifest,
        }, { status: 409 });
      }
      if (error instanceof ExecutionIdempotencyConflictError) {
        return Response.json({ error: error.code }, { status: 409 });
      }
      if (error instanceof LinearIntentTransactionRequiredError) {
        return Response.json({ error: error.code }, { status: 503, headers: PRIVATE_RESPONSE });
      }
      if (error instanceof ExecutionInProgressError) {
        return Response.json(
          { error: error.code, receiptId: error.receiptId },
          { status: 409, headers: { ...PRIVATE_RESPONSE, "retry-after": "2" } },
        );
      }
      if (error instanceof ExecutionFailedError) {
        return Response.json(
          { error: error.code, receiptId: error.receiptId },
          { status: 502, headers: PRIVATE_RESPONSE },
        );
      }
      if (error instanceof GitHubReadError) {
        return githubErrorResponse(error);
      }
      if (error instanceof GitHubScopeProofError) {
        return githubErrorResponse(error);
      }
      if (error instanceof GitHubWritePreflightError) {
        return githubErrorResponse(error);
      }
      if (error instanceof GitHubWriteRejectedError) {
        return githubErrorResponse(error);
      }
      if (error instanceof LinearExecutionError || error instanceof LinearProviderDenial) {
        return linearErrorResponse(error);
      }
      if (error instanceof SlackExecutionError || error instanceof SlackProviderDenial) {
        return slackErrorResponse(error);
      }
      if (error instanceof NotionExecutionError || error instanceof NotionProviderDenial) {
        return notionErrorResponse(error);
      }
      if (error instanceof ExecutionInvocationDeadlineError) {
        return Response.json({ error: error.code },
          { status: 504, headers: PRIVATE_RESPONSE });
      }
      if (error instanceof ExecutionOutcomeUnknownError) {
        return Response.json(
          { error: error.code, receiptId: error.receiptId },
          { status: 502, headers: PRIVATE_RESPONSE },
        );
      }
      if (error instanceof ApprovalUnavailableError) {
        return Response.json({ error: error.code }, { status: 409 });
      }
      if (error instanceof ConnectionAccessDeniedError) {
        return Response.json({ error: error.code }, { status: 403 });
      }
      if (error instanceof ConnectionSelectionRequiredError) {
        return Response.json(
          { error: error.code, connectionIds: error.connectionIds },
          { status: 409 },
        );
      }
      if (error instanceof ConnectionUnavailableError) {
        return Response.json({ error: error.code }, { status: 409 });
      }
      if (error instanceof ProviderUnavailableError) {
        return Response.json({ error: error.code, state: error.state }, { status: 409 });
      }
      if (error instanceof ConnectionProviderOperationError) {
        return Response.json({ error: error.code, message: error.message, operation: error.operation },
          { status: 502, headers: PRIVATE_RESPONSE });
      }
      if (error instanceof ConnectionCleanupUntrackedError) {
        return Response.json({ error: error.code, message: error.message },
          { status: 409, headers: PRIVATE_RESPONSE });
      }
      if (error instanceof RuntimeUnavailableError) {
        return Response.json({ error: error.code }, { status: 503 });
      }
      const authError = error as { code?: unknown };
      if (authError?.code === "AUTHFN_UNAUTHENTICATED") {
        return Response.json({ error: "AUTHFN_UNAUTHENTICATED" }, { status: 401 });
      }
      const path = new URL(request.url).pathname;
      const connectionRequest = path.startsWith("/api/connections/");
      const executionRequest = path === "/api/tools/execute" || path.startsWith("/api/approvals");
      let loggedError: string;
      if (connectionRequest || executionRequest) {
        loggedError = error instanceof Error ? error.name : "Unknown connection failure";
      } else {
        loggedError = error instanceof Error ? error.message : String(error);
      }
      console.error(JSON.stringify({
        message: "OMR request failed",
        method: request.method,
        path,
        error: loggedError,
      }));
      return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
    },
    routes: [
      {
        method: "GET",
        path: "/api/health",
        handler: () =>
          Response.json({
            ok: true,
            service: "omr-web",
            runtime: "cloudflare-workers",
          }),
      },
      {
        method: "GET",
        path: "/api/runtime-capabilities",
        handler: () =>
          Response.json({
            datafnSchemaVersion: publicDatafnSchema.version,
            postgresClientAccessRuntime: typeof connectPostgresClientAccess === "function",
            postgresConnectionRuntime: typeof connectPostgresConnections === "function",
            postgresDataRuntime: typeof connectPostgresDataRuntime === "function",
            postgresDeviceLoginRuntime: typeof connectPostgresDeviceLogin === "function",
            postgresIdentityRuntime: typeof connectPostgresIdentityRuntime === "function",
          }),
      },
      {
        method: "GET",
        path: "/api/control-plane",
        handler: async (request) => {
          const params = new URL(request.url).searchParams;
          const workspaceId = params.get("workspaceId") ?? undefined;
          const approvalId = params.get("approvalId") ?? undefined;
          return Response.json(await controlPlaneServices.overview(request, workspaceId, approvalId), {
            headers: PRIVATE_RESPONSE,
          });
        },
      },
      {
        method: "POST",
        path: "/api/workspaces/team",
        handler: async (request, context) => {
          const body = objectBody(await context.json());
          return Response.json(
            await controlPlaneServices.createTeam(request, requiredString(body, "name")),
            { status: 201 },
          );
        },
      },
      {
        method: "GET",
        path: "/api/client-grants",
        handler: async (request) => {
          const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
          return Response.json(await controlPlaneServices.listManualGrants(request, cursor), {
            headers: { "cache-control": "no-store" },
          });
        },
      },
      {
        method: "POST",
        path: "/api/client-grants/revoke",
        handler: async (request, context) => {
          const body = objectBody(await context.json());
          return Response.json(await controlPlaneServices.revokeManualClient(
            request, requiredString(body, "clientId"),
          ));
        },
      },
      {
        method: "POST",
        path: "/api/client-grants/revoke-self",
        handler: async (request) => {
          if (!controlPlaneServices.revokeSelf) throw new RuntimeUnavailableError("Client revocation is unavailable");
          return Response.json(await controlPlaneServices.revokeSelf(request), { headers: PRIVATE_RESPONSE });
        },
      },
      {
        method: "POST",
        path: "/api/device/authorization",
        handler: async (_request, context) => {
          const body = objectBody(await context.json());
          const clientKind = requiredString(body, "clientKind");
          if (clientKind !== "cli" && clientKind !== "mcp_remote" &&
            clientKind !== "mcp_stdio") {
            throw new RequestInputError("clientKind must be cli, mcp_remote, or mcp_stdio");
          }
          const result = await deviceServices.begin({
            clientKind,
            clientName: requiredString(body, "clientName"),
            requestedCapabilities: requestedCapabilities(body),
          });
          return Response.json(result, { status: 201 });
        },
      },
      {
        method: "POST",
        path: "/api/device/token",
        handler: async (_request, context) => {
          const body = objectBody(await context.json());
          return Response.json(await deviceServices.poll(requiredString(body, "deviceCode")));
        },
      },
      {
        method: "POST",
        path: "/api/device/approve",
        handler: async (request, context) => {
          const body = objectBody(await context.json());
          return Response.json(
            await deviceServices.approve(request, {
              userCode: requiredString(body, "userCode"),
              workspaceId: requiredString(body, "workspaceId"),
            }),
          );
        },
      },
      {
        method: "GET",
        path: "/api/connections/providers/readiness",
        handler: async (request) => {
          const provider = new URL(request.url).searchParams.get("provider");
          if (!provider) throw new RequestInputError("provider is required");
          const workspaceId = new URL(request.url).searchParams.get("workspaceId") ?? undefined;
          return Response.json(await connectionServices.providerReadiness(request, provider, workspaceId), {
            headers: PRIVATE_RESPONSE,
          });
        },
      },
      {
        method: "POST",
        path: "/api/connections/list",
        handler: async (request, context) => {
          const body = objectBody(await context.json());
          const provider = optionalString(body, "provider");
          return Response.json(await connectionServices.list(request, {
            workspaceId: requiredString(body, "workspaceId"),
            ...(provider ? { provider } : {}),
          }), { headers: PRIVATE_RESPONSE });
        },
      },
      {
        method: "POST",
        path: "/api/connections/select",
        handler: async (request, context) => {
          const body = objectBody(await context.json());
          return Response.json(await connectionServices.select(request, {
            workspaceId: requiredString(body, "workspaceId"),
            provider: requiredString(body, "provider"),
            connectionId: requiredString(body, "connectionId"),
          }), { headers: PRIVATE_RESPONSE });
        },
      },
      {
        method: "POST",
        path: "/api/connections/oauth/start",
        handler: async (request, context) => {
          const body = objectBody(await context.json());
          const returnTo = optionalString(body, "returnTo");
          const access = githubAccess(body);
          const linear = linearAccess(body);
          const slack = slackAccess(body);
          return Response.json(await connectionServices.startOAuth(request, {
            workspaceId: requiredString(body, "workspaceId"),
            provider: requiredString(body, "provider"),
            ownership: ownership(body),
            redirectUri: requiredString(body, "redirectUri"),
            label: requiredString(body, "label"),
            ...(access ? { githubAccess: access } : {}),
            ...(linear ? { linearAccess: linear } : {}),
            ...(slack ? { slackAccess: slack } : {}),
            ...(returnTo ? { returnTo } : {}),
          }), { status: 201, headers: PRIVATE_RESPONSE });
        },
      },
      {
        method: "POST",
        path: "/api/connections/oauth/callback",
        handler: async (request, context) => {
          const body = objectBody(await context.json());
          const redirectUri = optionalString(body, "redirectUri");
          return Response.json(await connectionServices.completeOAuth(request, {
            workspaceId: requiredString(body, "workspaceId"),
            provider: requiredString(body, "provider"),
            ownership: ownership(body),
            code: requiredString(body, "code"),
            state: requiredString(body, "state"),
            label: requiredString(body, "label"),
            ...(redirectUri ? { redirectUri } : {}),
          }), { status: 201, headers: PRIVATE_RESPONSE });
        },
      },
      {
        method: "POST",
        path: "/api/connections/api-key",
        handler: async (request, context) => {
          const body = objectBody(await context.json());
          return Response.json(await connectionServices.connectApiKey(request, {
            workspaceId: requiredString(body, "workspaceId"),
            provider: requiredString(body, "provider"),
            ownership: ownership(body),
            apiKey: requiredString(body, "apiKey"),
            label: requiredString(body, "label"),
          }), { status: 201, headers: PRIVATE_RESPONSE });
        },
      },
      ...(["health", "refresh", "disconnect"] as const).map((operation) => ({
        method: "POST" as const,
        path: `/api/connections/${operation}`,
        handler: async (request: Request, context: { json(): Promise<unknown> }) => {
          const body = objectBody(await context.json());
          const connectionId = requiredString(body, "connectionId");
          return Response.json(await connectionServices[operation === "health"
            ? "checkHealth"
            : operation](request, connectionId), { headers: PRIVATE_RESPONSE });
        },
      })),
      {
        method: "GET",
        path: "/api/tools",
        handler: async (request) => {
          const params = new URL(request.url).searchParams;
          const workspaceId = params.get("workspaceId");
          if (!workspaceId) throw new RequestInputError("workspaceId is required");
          const limitValue = params.get("limit");
          const effects = params.getAll("effect") as ToolEffect[];
          return Response.json(await toolServices.discover(request, {
            workspaceId,
            ...(params.get("q") ? { query: params.get("q")! } : {}),
            ...(params.has("provider") ? { providers: params.getAll("provider") } : {}),
            ...(effects.length > 0 ? { effects } : {}),
            ...(limitValue ? { limit: Number(limitValue) } : {}),
            ...(params.get("cursor") ? { cursor: params.get("cursor")! } : {}),
          }));
        },
      },
      {
        method: "GET",
        path: "/api/tools/manifest",
        handler: async (request) => {
          const toolId = new URL(request.url).searchParams.get("id");
          if (!toolId) throw new RequestInputError("id is required");
          const workspaceId = new URL(request.url).searchParams.get("workspaceId") ?? "";
          if (!workspaceId) throw new RequestInputError("workspaceId is required");
          const manifest = await toolServices.manifest(request, toolId, workspaceId);
          return manifest
            ? Response.json(manifest)
            : Response.json({ error: "TOOL_NOT_FOUND" }, { status: 404 });
        },
      },
      {
        method: "POST",
        path: "/api/tools/execute",
        handler: async (request, context) => {
          const body = objectBody(await context.json());
          const connectionId = optionalString(body, "connectionId");
          const idempotencyKey = optionalString(body, "idempotencyKey");
          if (!("params" in body)) throw new RequestInputError("params is required");
          return Response.json(await executionServices.execute(request, {
            workspaceId: requiredString(body, "workspaceId"),
            toolId: requiredString(body, "toolId"),
            params: body.params,
            ...(connectionId ? { connectionId } : {}),
            ...(idempotencyKey ? { idempotencyKey } : {}),
          }), { headers: PRIVATE_RESPONSE });
        },
      },
      {
        method: "POST",
        path: "/api/approvals",
        handler: async (request, context) => {
          const body = objectBody(await context.json());
          const connectionId = optionalString(body, "connectionId");
          const idempotencyKey = requiredString(body, "idempotencyKey");
          if (!("params" in body)) throw new RequestInputError("params is required");
          return Response.json(await executionServices.requestApproval(request, {
            workspaceId: requiredString(body, "workspaceId"),
            toolId: requiredString(body, "toolId"),
            params: body.params,
            ...(connectionId ? { connectionId } : {}),
            idempotencyKey,
          }), { status: 201, headers: PRIVATE_RESPONSE });
        },
      },
      {
        method: "GET",
        path: "/api/approvals/status",
        handler: async (request) => {
          const approvalId = new URL(request.url).searchParams.get("approvalId");
          if (!approvalId) throw new RequestInputError("approvalId is required");
          if (!executionServices.approvalStatus) throw new RuntimeUnavailableError("Approval status is unavailable");
          const workspaceId = new URL(request.url).searchParams.get("workspaceId") ?? undefined;
          return Response.json(await executionServices.approvalStatus(request, approvalId, workspaceId),
            { headers: PRIVATE_RESPONSE });
        },
      },
      {
        method: "POST",
        path: "/api/approvals/reconcile",
        handler: async (request, context) => {
          const body = objectBody(await context.json());
          const approvalId = requiredString(body, "approvalId");
          const decision = requiredString(body, "decision");
          const workspaceId = optionalString(body, "workspaceId");
          if (decision !== "effect_present" && decision !== "effect_absent") {
            throw new RequestInputError("decision must be effect_present or effect_absent");
          }
          if (!executionServices.reconcileUncertain) throw new RuntimeUnavailableError("Reconciliation is unavailable");
          return Response.json(await executionServices.reconcileUncertain(request, approvalId, decision, workspaceId),
            { headers: PRIVATE_RESPONSE });
        },
      },
      ...(["approve", "reject", "execute"] as const).map((operation) => ({
        method: "POST" as const,
        path: `/api/approvals/${operation}`,
        handler: async (request: Request, context: { json(): Promise<unknown> }) => {
          const body = objectBody(await context.json());
          const approvalId = requiredString(body, "approvalId");
          return Response.json(await executionServices[
            operation === "execute" ? "executeApproved" : operation
          ](request, approvalId), { headers: PRIVATE_RESPONSE });
        },
      })),
    ],
  });
}

export const router = createOMRRouter();
