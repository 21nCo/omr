import type { RequestEvent } from "@superfunctions/http-sveltekit";
import { ClientAccessDeniedError, type ClientCapability } from "@oh-my-router/client-access";
import {
  connectPostgresClientAccess,
  connectPostgresDeviceLogin,
} from "@oh-my-router/client-access/postgres";
import {
  ConnectionAccessDeniedError, markMissingRemoteConnection,
  PlugFnConnectionOrchestrator,
  type ConnectionAuthority,
  type ConnectionBindingRecord,
} from "@oh-my-router/connections";
import { connectPostgresConnections } from "@oh-my-router/connections/postgres";
import { ApprovalUnavailableError, decodeExecutionWrappingKey, deriveExecutionFingerprintKey, ExecutionService, publicApproval, publicReceipt, type ExecutionPrincipal } from "@oh-my-router/execution";
import { bindPostgresAssistedTurn, connectPostgresExecutionReceipts,
  lookupPostgresAssistedAction, lookupPostgresAssistedTurn } from "@oh-my-router/execution/postgres";
import { AssistedTurnQuotaExceededError, connectPostgresIdentityRuntime,
  connectPostgresOpenRouterVault, reservePostgresAssistedTurn } from "@oh-my-router/identity/postgres";
import { OpenRouterVaultError } from "@oh-my-router/identity";
import { connectPostgresPlugFn, verifiedGithubScopes, verifiedLinearScopes, verifiedNotionScopes, verifiedSlackScopes } from "@oh-my-router/plugfn-runtime";
import {
  createPlugFnToolCatalog,
  isProviderConfigured,
  type NotionProviderDenial,
  v1ProviderCatalog,
  type JsonValue,
  type ProviderBinding,
  type ProviderStatus,
} from "@oh-my-router/tools";
import type { IntegrationConfig } from "plugfn";
import { AssistedPlaygroundError, type AssistedPlaygroundServices } from "./assisted-playground.js";
import { assistedPlaygroundEnabled } from "./direct-playground-rollout.js";

import {
  RuntimeUnavailableError,
  type ConnectionRouteServices,
  type ControlPlaneRouteServices,
  type DeviceRouteServices,
  type ExecutionRouteServices,
  type ToolRouteServices,
  type OpenRouterVaultRouteServices,
  RequestOriginDeniedError,
} from "./router.js";
import { resolveScopedCatalog } from "./scoped-catalog.js";
import { publicConnections, publicConnectionsAfterMutation } from "./connection-view.js";
import { providerReconciliationReceipts, publicBrowserApproval, publicBrowserApprovalStatus,
  recoverProviderApproval, visibleApprovals } from "./reconciliation-receipts.js";

type OMRBindings = Cloudflare.Env & {
  HYPERDRIVE?: { connectionString: string };
  OPENROUTER_VAULT_HYPERDRIVE?: { connectionString: string };
  DATABASE_URL?: string;
  OPENROUTER_VAULT_DATABASE_URL?: string;
  OMR_OPENROUTER_VAULT_ENABLED?: string;
  OMR_OPENROUTER_VAULT_CACHE_DISABLED_CONFIRMED?: string;
  OMR_ASSISTED_PLAYGROUND_ENABLED?: string;
  DEVICE_CREDENTIAL_WRAPPING_KEY?: string;
  EXECUTION_RESULT_WRAPPING_KEY?: string;
  PLUGFN_ENCRYPTION_KEY?: string;
  [key: string]: unknown;
};

export interface CloudflareRouteServices {
  device: DeviceRouteServices;
  connections: ConnectionRouteServices;
  tools: ToolRouteServices;
  execution: ExecutionRouteServices;
  controlPlane: ControlPlaneRouteServices;
  openRouterVault: OpenRouterVaultRouteServices;
  assistedPlayground: AssistedPlaygroundServices;
}

/** Require Worker bindings before constructing any server-side runtime. */
function environment(event: RequestEvent): OMRBindings {
  const env = event.platform?.env as OMRBindings | undefined;
  if (!env) throw new RuntimeUnavailableError("Worker bindings are unavailable");
  return env;
}

/** Resolve the Worker database binding for a request. */
export function databaseConnectionString(event: RequestEvent): string {
  const env = environment(event);
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!connectionString) {
    throw new RuntimeUnavailableError("Database binding is unavailable");
  }
  return connectionString;
}

/** Use the dedicated vault role; never fall back to the primary database binding. */
function openRouterVaultConnectionString(event: RequestEvent): string {
  const env = environment(event);
  const connectionString = env.OPENROUTER_VAULT_HYPERDRIVE?.connectionString ??
    env.OPENROUTER_VAULT_DATABASE_URL;
  if (!connectionString) throw new RuntimeUnavailableError("OpenRouter vault database binding is unavailable");
  return connectionString;
}

/** Require a nonempty server-side secret by binding name. */
function requiredSecret(event: RequestEvent, name: string): string {
  const value = environment(event)[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeUnavailableError(`${name} binding is unavailable`);
  }
  return value;
}

/** Decode a 32-byte wrapping key from hexadecimal or URL-safe base64. */
function decodeWrappingKey(value: string, label: string): Uint8Array<ArrayBuffer> {
  if (/^[a-f0-9]{64}$/i.test(value)) {
    const key = new Uint8Array(new ArrayBuffer(32));
    for (let index = 0; index < 32; index += 1) {
      key[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
    return key;
  }

  try {
    const padded = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const key = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
      key[index] = binary.charCodeAt(index);
    }
    if (key.byteLength === 32) return key;
  } catch {
    // Report one configuration-safe error below.
  }
  throw new RuntimeUnavailableError(`${label} wrapping key is invalid`);
}

function deviceWrappingKey(event: RequestEvent): Uint8Array<ArrayBuffer> {
  return decodeWrappingKey(
    requiredSecret(event, "DEVICE_CREDENTIAL_WRAPPING_KEY"),
    "Device credential",
  );
}

function executionWrappingKey(event: RequestEvent): Uint8Array<ArrayBuffer> {
  const encoded = requiredSecret(event, "EXECUTION_RESULT_WRAPPING_KEY");
  try {
    return decodeExecutionWrappingKey(encoded);
  } catch {
    throw new RuntimeUnavailableError("Execution result wrapping key is invalid");
  }
}

const OAUTH_BINDINGS: Record<string, readonly [string, string]> = {
  clickup: ["PLUGFN_CLICKUP_CLIENT_ID", "PLUGFN_CLICKUP_CLIENT_SECRET"],
  discord: ["PLUGFN_DISCORD_CLIENT_ID", "PLUGFN_DISCORD_CLIENT_SECRET"],
  github: ["PLUGFN_GITHUB_CLIENT_ID", "PLUGFN_GITHUB_CLIENT_SECRET"],
  gmail: ["PLUGFN_GOOGLE_CLIENT_ID", "PLUGFN_GOOGLE_CLIENT_SECRET"],
  "google-calendar": ["PLUGFN_GOOGLE_CLIENT_ID", "PLUGFN_GOOGLE_CLIENT_SECRET"],
  "google-docs": ["PLUGFN_GOOGLE_CLIENT_ID", "PLUGFN_GOOGLE_CLIENT_SECRET"],
  "google-drive": ["PLUGFN_GOOGLE_CLIENT_ID", "PLUGFN_GOOGLE_CLIENT_SECRET"],
  "google-sheets": ["PLUGFN_GOOGLE_CLIENT_ID", "PLUGFN_GOOGLE_CLIENT_SECRET"],
  jira: ["PLUGFN_JIRA_CLIENT_ID", "PLUGFN_JIRA_CLIENT_SECRET"],
  linear: ["PLUGFN_LINEAR_CLIENT_ID", "PLUGFN_LINEAR_CLIENT_SECRET"],
  notion: ["PLUGFN_NOTION_CLIENT_ID", "PLUGFN_NOTION_CLIENT_SECRET"],
  onedrive: ["PLUGFN_MICROSOFT_CLIENT_ID", "PLUGFN_MICROSOFT_CLIENT_SECRET"],
  outlook: ["PLUGFN_MICROSOFT_CLIENT_ID", "PLUGFN_MICROSOFT_CLIENT_SECRET"],
  slack: ["PLUGFN_SLACK_CLIENT_ID", "PLUGFN_SLACK_CLIENT_SECRET"],
  "slack-user": ["PLUGFN_SLACK_CLIENT_ID", "PLUGFN_SLACK_CLIENT_SECRET"],
  yahoo: ["PLUGFN_YAHOO_CLIENT_ID", "PLUGFN_YAHOO_CLIENT_SECRET"],
};

/** Include credentialed OAuth apps; GitHub also requires its explicit rollout flag. */
export function createProviderIntegrationConfig(
  env: Record<string, unknown>,
  origin: string,
): Record<string, IntegrationConfig> {
  const redirectUri = new URL("/app/oauth/callback", origin).toString();
  return Object.fromEntries(Object.entries(OAUTH_BINDINGS).flatMap(([provider, names]) => {
    if (provider === "github" && env.OMR_GITHUB_V1_ENABLED !== "true") return [];
    if (provider === "linear" && env.OMR_LINEAR_V1_ENABLED !== "true") return [];
    if (provider === "notion" && env.OMR_NOTION_V1_ENABLED !== "true") return [];
    if (provider === "slack" && env.OMR_SLACK_V1_ENABLED !== "true") return [];
    if (provider === "slack-user") return [];
    const clientId = env[names[0]];
    const clientSecret = env[names[1]];
    return typeof clientId === "string" && clientId.length > 0 &&
        typeof clientSecret === "string" && clientSecret.length > 0
      ? [[provider, { type: "oauth2", clientId, clientSecret, redirectUris: [redirectUri] } satisfies IntegrationConfig]]
      : [];
  }));
}

function integrationConfig(event: RequestEvent): Record<string, IntegrationConfig> {
  return createProviderIntegrationConfig(environment(event), new URL(event.request.url).origin);
}

/** Parse a single bearer credential, rejecting malformed authorization headers. */
function bearerCredential(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) throw new RuntimeUnavailableError("Authorization header is invalid");
  return match[1]!;
}

/** Resolve a signed-in web user and close the identity runtime after the request. */
async function requireWebUser(event: RequestEvent, request: Request): Promise<string> {
  const origin = new URL(event.request.url).origin;
  const identity = await connectPostgresIdentityRuntime({
    connectionString: databaseConnectionString(event),
    environment: { resolve: () => ({ issuer: origin, baseUrl: origin }) },
  });
  try {
    return (await identity.requireSession(request)).actorId;
  } finally {
    await identity.close();
  }
}

/** Reject browser mutations that do not declare the request's origin. */
function requireSameOrigin(request: Request): void {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    throw new RequestOriginDeniedError("A same-origin browser request is required");
  }
}

/** Build the browser-only vault boundary with injectable identity and storage for contract probes. */
export function createOpenRouterVaultRouteServices(options: {
  enabled(): boolean;
  requireUser(request: Request): Promise<string>;
  open(): Promise<Awaited<ReturnType<typeof connectPostgresOpenRouterVault>>>;
}): OpenRouterVaultRouteServices {
  /** Authenticate each request and close the vault connection even when an operation fails. */
  async function run<T>(request: Request, mutating: boolean,
    operation: (vault: Awaited<ReturnType<typeof connectPostgresOpenRouterVault>>["vault"], userId: string) => Promise<T>,
  ): Promise<T> {
    if (!options.enabled()) throw new OpenRouterVaultError("OPENROUTER_VAULT_DISABLED");
    if (mutating) requireSameOrigin(request);
    const userId = await options.requireUser(request);
    const runtime = await options.open();
    try { return await operation(runtime.vault, userId); }
    finally { await runtime.close(); }
  }
  return {
    status: (request) => run(request, false, (vault, userId) => vault.status(userId)),
    save: (request, key) => run(request, true, (vault, userId) => vault.save(userId, key)),
    check: (request) => run(request, true, (vault, userId) => vault.check(userId)),
    delete: (request) => run(request, true, (vault, userId) => vault.delete(userId)),
  };
}

/** Refuse vault traffic until the dedicated Hyperdrive cache setting is verified. */
export function openRouterVaultRolloutEnabled(env: {
  OMR_OPENROUTER_VAULT_ENABLED?: string;
  OMR_OPENROUTER_VAULT_CACHE_DISABLED_CONFIRMED?: string;
}): boolean {
  return env.OMR_OPENROUTER_VAULT_ENABLED === "true" &&
    env.OMR_OPENROUTER_VAULT_CACHE_DISABLED_CONFIRMED === "true";
}

/** Mutating cookie requests need origin proof; bearer clients have explicit credentials. */
export function requireExecutionOrigin(request: Request): void {
  if (!bearerCredential(request) || request.headers.has("cookie")) requireSameOrigin(request);
}

/** A bearer client can revoke only the grant authenticated by its own credential. */
export async function revokeOwnBearerClient(
  request: Request,
  authenticateClient: () => Promise<ExecutionPrincipal>,
  revoke: (actorUserId: string, grantId: string) => Promise<void>,
): Promise<{ revoked: true }> {
  if (!bearerCredential(request) || request.headers.has("cookie")) throw new ClientAccessDeniedError();
  const principal = await authenticateClient();
  if (principal.kind !== "client") throw new ClientAccessDeniedError();
  await revoke(principal.userId, principal.grantId);
  return { revoked: true };
}

/** A saved selection affects later actions from every client of the same user. */
export async function selectAuthorizedConnection<T>(
  request: Request,
  input: { workspaceId: string; provider: string; connectionId: string },
  authenticateSelection: (request: Request, workspaceId: string, capability: ClientCapability) => Promise<{ userId: string }>,
  select: (input: { actorUserId: string; workspaceId: string; provider: string; connectionId: string }) => Promise<T>,
): Promise<T> {
  if (!bearerCredential(request)) requireSameOrigin(request);
  const principal = await authenticateSelection(request, input.workspaceId, "tools:write");
  return select({ actorUserId: principal.userId, ...input });
}

/** Check origin or client capability before reading a connection's health. */
export async function checkAuthorizedConnectionHealth<T>(
  request: Request,
  connectionId: string,
  authenticateHealth: (request: Request, capability: ClientCapability) => Promise<ExecutionPrincipal>,
  check: (principal: ExecutionPrincipal, connectionId: string) => Promise<T>,
): Promise<T> {
  if (!bearerCredential(request)) requireSameOrigin(request);
  const principal = await authenticateHealth(request, "connections:read");
  return check(principal, connectionId);
}

/** Resolve a scoped bearer client or signed-in web principal for a route. */
async function authenticate(
  event: RequestEvent,
  request: Request,
  workspaceId: string | undefined,
  capability?: ClientCapability,
  allowRemoteMcp = false,
): Promise<ExecutionPrincipal> {
  const credential = bearerCredential(request);
  if (credential) {
    const runtime = await connectPostgresClientAccess({
      connectionString: databaseConnectionString(event),
    });
    try {
      const principal = await runtime.clients.authenticate(credential, capability);
      // Remote host grants have one public audience: /mcp. Only the MCP
      // adapter constructs services that may forward them to the shared router.
      if (principal.kind === "mcp_remote" && !allowRemoteMcp) {
        throw new ClientAccessDeniedError();
      }
      if (workspaceId && principal.workspaceId !== workspaceId) {
        throw new ConnectionAccessDeniedError();
      }
      return {
        kind: "client",
        userId: principal.userId,
        workspaceId: principal.workspaceId,
        clientId: principal.clientId,
        grantId: principal.grantId,
        capabilities: principal.capabilities,
      };
    } finally {
      await runtime.close();
    }
  }
  const origin = new URL(event.request.url).origin;
  const identity = await connectPostgresIdentityRuntime({
    connectionString: databaseConnectionString(event),
    environment: { resolve: () => ({ issuer: origin, baseUrl: origin }) },
  });
  try {
    const session = await identity.requireSession(request);
    return { kind: "web", userId: session.actorId, sessionId: session.id,
      workspaceId: workspaceId ?? "" };
  } finally {
    await identity.close();
  }
}

/** Prevent a client grant from probing a binding in another workspace. */
export function assertConnectionWorkspace(principal: ExecutionPrincipal, bindingWorkspaceId: string): void {
  if (principal.kind === "client" && principal.workspaceId !== bindingWorkspaceId) {
    throw new ConnectionAccessDeniedError();
  }
}

/** Open a provider runtime with request origin and server-only secrets. */
async function connectPlugFn(event: RequestEvent) {
  const origin = new URL(event.request.url).origin;
  return connectPostgresPlugFn({
    connectionString: databaseConnectionString(event),
    baseUrl: origin,
    encryptionKey: requiredSecret(event, "PLUGFN_ENCRYPTION_KEY"),
    integrations: integrationConfig(event),
  });
}

/** Keep committed mutation responses redacted and exclude providers that lost eligibility. */
async function publicMutationConnection(
  orchestrator: PlugFnConnectionOrchestrator,
  authority: ConnectionAuthority,
  actorUserId: string,
  binding: ConnectionBindingRecord,
) {
  const selectable = orchestrator.providerReadiness(binding.provider, [binding]).state === "ready";
  const cleanupOnly = binding.ownership === "personal" && binding.ownerUserId !== actorUserId;
  return (await publicConnectionsAfterMutation(authority, actorUserId, binding.workspaceId,
    [{ ...binding, selectable, cleanupOnly }]))[0];
}

export function createCloudflareDeviceServices(event: RequestEvent): DeviceRouteServices {
  const origin = new URL(event.request.url).origin;

  async function connectDeviceRuntime() {
    return connectPostgresDeviceLogin({
      connectionString: databaseConnectionString(event),
      credentialWrappingKey: deviceWrappingKey(event),
      verificationUri: `${origin}/device`,
    });
  }

  return {
    async begin(input) {
      const runtime = await connectDeviceRuntime();
      try {
        return await runtime.deviceLogin.begin(input);
      } finally {
        await runtime.close();
      }
    },
    async poll(deviceCode) {
      const runtime = await connectDeviceRuntime();
      try {
        return await runtime.deviceLogin.poll(deviceCode);
      } finally {
        await runtime.close();
      }
    },
    async approve(request, input) {
      requireSameOrigin(request);
      const identity = await connectPostgresIdentityRuntime({
        connectionString: databaseConnectionString(event),
        environment: {
          resolve: () => ({ issuer: origin, baseUrl: origin }),
        },
      });
      let device: Awaited<ReturnType<typeof connectDeviceRuntime>> | undefined;
      try {
        device = await connectDeviceRuntime();
        const session = await identity.requireSession(request);
        const approved = await device.deviceLogin.approve({
          ...input,
          actorUserId: session.actorId,
        });
        return {
          client: {
            id: approved.client.id,
            kind: approved.client.kind,
            name: approved.client.name,
            workspaceId: approved.client.workspaceId,
          },
          grant: {
            id: approved.grant.id,
            capabilities: approved.grant.capabilities,
            expiresAt: approved.grant.expiresAt,
          },
        };
      } finally {
        await Promise.allSettled([identity.close(), device?.close()]);
      }
    },
  };
}

/** Derive public provider readiness from configured apps and this workspace's bindings. */
function statuses(
  plugfn: Awaited<ReturnType<typeof connectPlugFn>>["plugfn"],
  bindings: readonly (ProviderBinding & { provider: string })[] = [],
): ProviderStatus[] {
  const byProvider = new Map<string, ProviderBinding[]>();
  for (const binding of bindings) {
    const entries = byProvider.get(binding.provider) ?? [];
    entries.push(binding);
    byProvider.set(binding.provider, entries);
  }
  return v1ProviderCatalog({
    get: (provider) => plugfn.providers.get(provider),
    configured: (provider) => isProviderConfigured(
      plugfn.providers.get(provider), provider, plugfn.config?.integrations,
    ),
    connections: byProvider,
  });
}

/** Exclude disabled providers before publishing their actions in the tool catalog. */
function configuredProviders(plugfn: Awaited<ReturnType<typeof connectPlugFn>>["plugfn"]): Set<string> {
  return new Set(statuses(plugfn).filter((status) => status.available).map((status) => status.provider));
}

/** Prove the selected provider grant before exposing tools or dispatching actions. */
async function verifiedProviderScopes(
  plugfn: Awaited<ReturnType<typeof connectPlugFn>>["plugfn"],
  input: { provider: string; connectionId: string; userId: string; workspaceId: string },
): Promise<readonly string[] | undefined> {
  const { provider, connectionId, userId, workspaceId } = input;
  if (provider === "github") return verifiedGithubScopes(plugfn, { userId, workspaceId, connectionId });
  if (provider === "linear") return verifiedLinearScopes(plugfn, { userId, workspaceId, connectionId });
  if (provider === "slack") return verifiedSlackScopes(plugfn, { userId, workspaceId, connectionId });
  if (provider === "notion") return verifiedNotionScopes(plugfn, { userId, workspaceId, connectionId });
  return (await plugfn.connections.get(connectionId)).scopes;
}

/** Project accessible bindings, using effective GitHub grants instead of requested scopes. */
export async function scopedToolIds(
  catalog: Awaited<ReturnType<typeof createPlugFnToolCatalog>>,
  plugfn: Awaited<ReturnType<typeof connectPlugFn>>["plugfn"],
  authority: Awaited<ReturnType<typeof connectPostgresConnections>>["connections"],
  principal: ExecutionPrincipal,
  workspaceId: string,
  bindings: readonly ConnectionBindingRecord[],
): Promise<{ allowedToolIds: Set<string>; providers: ProviderStatus[] }> {
  const missing = new Set<string>();
  const notionProof = new Map<string, { issue: NonNullable<ProviderStatus["proofIssue"]>;
    retryAfterSeconds?: number }>();
  const allowedToolIds = await resolveScopedCatalog(
    catalog,
    statuses(plugfn, bindings),
    (provider) => authority.resolve({ actorUserId: principal.userId, workspaceId, provider }),
    (connectionId, provider) => verifiedProviderScopes(plugfn, {
      provider, connectionId, userId: principal.userId, workspaceId,
    }),
    async (bindingId) => {
      missing.add(bindingId);
      await markMissingRemoteConnection(authority, bindingId);
    },
    {
      onReconnectRequired: async (bindingId, provider) => {
        missing.add(bindingId);
        await authority.recordHealth({ connectionId: bindingId, status: "needs_reauth",
          readiness: "unavailable", reason: `${provider ?? "linear"}_reconnect_required` }).catch(() => undefined);
      },
      onPermanentDenial: async (bindingId, code) => {
        missing.add(bindingId);
        await authority.recordHealth({ connectionId: bindingId, status: "needs_reauth",
          readiness: "unavailable", reason: code.toLowerCase() }).catch(() => undefined);
      },
      onNotionProofIssue: (bindingId, code, retryAfterSeconds) => {
        const issue = notionProofIssue(code);
        if (!issue) return;
        missing.add(bindingId);
        notionProof.set(bindingId, { issue, retryAfterSeconds });
      },
    },
  );
  return {
    allowedToolIds,
    providers: statuses(plugfn, bindings.map((binding) => missing.has(binding.id)
      ? { ...binding, status: "needs_reauth", readiness: "unavailable" } : binding))
      .map((provider) => {
        if (provider.provider !== "notion") return provider;
        const proof = [...notionProof].find(([bindingId]) => bindings.some((binding) =>
          binding.provider === "notion" && binding.id === bindingId));
        return proof ? { ...provider, proofIssue: proof[1].issue,
          proofBindingId: proof[0], proofRetryAfterSeconds: proof[1].retryAfterSeconds } : provider;
      }),
  };
}

/** Only these Notion denials provide catalog guidance for a selected binding. */
function notionProofIssue(code: NotionProviderDenial["code"]): ProviderStatus["proofIssue"] {
  switch (code) {
    case "NOTION_ACCESS_RESTRICTED": return "notion_access_restricted";
    case "NOTION_RATE_LIMITED": return "notion_rate_limited";
    case "NOTION_PERMISSION_DENIED": return "notion_permission_denied";
    case "NOTION_RECONNECT_REQUIRED": return undefined;
    default: return "notion_query_rejected";
  }
}

/** Bind authenticated control-plane routes to disposable server-side runtimes. */
function createRouteServices(event: RequestEvent, allowRemoteMcp: boolean): CloudflareRouteServices {
  const device = createCloudflareDeviceServices(event);

  /** Close both connection runtimes after each operation, including failures. */
  async function withConnections<T>(
    callback: (
      orchestrator: PlugFnConnectionOrchestrator,
      authority: Awaited<ReturnType<typeof connectPostgresConnections>>["connections"],
    ) => Promise<T>,
  ): Promise<T> {
    const connections = await connectPostgresConnections({
      connectionString: databaseConnectionString(event),
    });
    let plugfn: Awaited<ReturnType<typeof connectPlugFn>> | undefined;
    try {
      plugfn = await connectPlugFn(event);
      return await callback(
        new PlugFnConnectionOrchestrator(connections.connections, plugfn.plugfn),
        connections.connections,
      );
    } finally {
      await Promise.allSettled([connections.close(), plugfn?.close()]);
    }
  }

  const connections: ConnectionRouteServices = {
    /** Read provider setup availability in the caller's workspace context. */
    async providerReadiness(request, provider, workspaceId) {
      const principal = await authenticate(event, request, workspaceId, "connections:read", allowRemoteMcp);
      return withConnections(async (orchestrator, authority) => orchestrator.providerReadiness(
        provider,
        workspaceId ? await authority.listAvailable({
          actorUserId: principal.userId,
          workspaceId,
          provider,
        }) : [],
      ));
    },
    /** Project only connections available to the authenticated workspace member. */
    async list(request, input) {
      const principal = await authenticate(event, request, input.workspaceId, "connections:read", allowRemoteMcp);
      return withConnections(async (orchestrator, authority) => publicConnections(
        authority, principal.userId, input.workspaceId,
        await orchestrator.listAvailable({
          actorUserId: principal.userId,
          workspaceId: input.workspaceId,
          ...(input.provider ? { provider: input.provider } : {}),
        }),
      ));
    },
    /** Save a selection after origin, client scope, and ownership checks. */
    async select(request, input) {
      return selectAuthorizedConnection(request, input,
        (selectionRequest, workspaceId, capability) => authenticate(event, selectionRequest, workspaceId, capability, allowRemoteMcp),
        (selection) => withConnections((orchestrator) => orchestrator.select(selection)));
    },
    /** Start provider authorization for a signed-in same-origin web user. */
    async startOAuth(request, input) {
      requireSameOrigin(request);
      const actorUserId = await requireWebUser(event, request);
      return withConnections((orchestrator) => orchestrator.startOAuth({ actorUserId, ...input }));
    },
    /** Commit a callback and return a redacted public binding. */
    async completeOAuth(request, input) {
      requireSameOrigin(request);
      const actorUserId = await requireWebUser(event, request);
      return withConnections(async (orchestrator, authority) => {
        const result = await orchestrator.completeOAuth({ actorUserId, ...input });
        const connection = await publicMutationConnection(orchestrator, authority, actorUserId, result.connection);
        return { connection, ...(result.returnTo ? { returnTo: result.returnTo } : {}) };
      });
    },
    /** Submit a credential server-side and return its redacted binding. */
    async connectApiKey(request, input) {
      requireSameOrigin(request);
      const actorUserId = await requireWebUser(event, request);
      return withConnections(async (orchestrator, authority) => {
        const binding = await orchestrator.connectApiKey({ actorUserId, ...input });
        return publicMutationConnection(orchestrator, authority, actorUserId, binding);
      });
    },
    /** Enforce binding and client workspace access before a provider probe. */
    async checkHealth(request, connectionId) {
      return checkAuthorizedConnectionHealth(request, connectionId,
        (healthRequest, capability) => authenticate(event, healthRequest, undefined, capability, allowRemoteMcp),
        (principal, id) => withConnections(async (orchestrator, authority) => {
          const accessible = await authority.getAccessible(principal.userId, id);
          assertConnectionWorkspace(principal, accessible.workspaceId);
          const binding = await orchestrator.checkHealth(principal.userId, id);
          return publicMutationConnection(orchestrator, authority, principal.userId, binding);
        }));
    },
    /** Refresh a binding under the signed-in member's authority. */
    async refresh(request, connectionId) {
      requireSameOrigin(request);
      const actorUserId = await requireWebUser(event, request);
      return withConnections(async (orchestrator, authority) => {
        const binding = await orchestrator.refresh(actorUserId, connectionId);
        return publicMutationConnection(orchestrator, authority, actorUserId, binding);
      });
    },
    /** End local use before returning redacted provider cleanup guidance. */
    async disconnect(request, connectionId) {
      requireSameOrigin(request);
      const actorUserId = await requireWebUser(event, request);
      return withConnections(async (orchestrator, authority) => {
        const result = await orchestrator.disconnect(actorUserId, connectionId);
        const connection = await publicMutationConnection(orchestrator, authority, actorUserId, result.connection);
        return { connection, provider: result.provider };
      });
    },
  };

  async function withCatalog<T>(callback: (
    catalog: Awaited<ReturnType<typeof createPlugFnToolCatalog>>,
    plugfn: Awaited<ReturnType<typeof connectPlugFn>>["plugfn"],
  ) => Promise<T> | T): Promise<T> {
    const plugfn = await connectPlugFn(event);
    try {
      return await callback(
        await createPlugFnToolCatalog(plugfn.plugfn, configuredProviders(plugfn.plugfn)),
        plugfn.plugfn,
      );
    } finally {
      await plugfn.close();
    }
  }

  const tools: ToolRouteServices = {
    async discover(request, input) {
      const principal = await authenticate(event, request, input.workspaceId, "tools:discover", allowRemoteMcp);
      return withCatalog(async (catalog, plugfn) => {
        const runtime = await connectPostgresConnections({ connectionString: databaseConnectionString(event) });
        try {
          const bindings = await runtime.connections.listAvailable({
            actorUserId: principal.userId,
            workspaceId: input.workspaceId,
          });
          const { allowedToolIds, providers } = await scopedToolIds(
            catalog, plugfn, runtime.connections, principal, input.workspaceId, bindings,
          );
          return { ...catalog.discover({ ...input, allowedToolIds }), providers };
        } finally {
          await runtime.close();
        }
      });
    },
    async manifest(request, toolId, workspaceId) {
      const principal = await authenticate(event, request, workspaceId, "tools:discover", allowRemoteMcp);
      return withCatalog(async (catalog, plugfn) => {
        const manifest = catalog.get(toolId);
        if (!manifest || !statuses(plugfn).some((entry) => entry.provider === manifest.provider && entry.available)) {
          return null;
        }
        const runtime = await connectPostgresConnections({ connectionString: databaseConnectionString(event) });
        try {
          const bindings = await runtime.connections.listAvailable({
            actorUserId: principal.userId,
            workspaceId,
            provider: manifest.provider,
          });
          const { allowedToolIds } = await scopedToolIds(catalog, plugfn, runtime.connections, principal, workspaceId, bindings);
          return allowedToolIds.has(manifest.id) ? manifest : null;
        } finally {
          await runtime.close();
        }
      });
    },
  };

  /** Scope each invocation to fresh connection and receipt stores, closing all opened runtimes. */
  async function withExecution<T>(callback: (
    service: ExecutionService,
    catalog: Awaited<ReturnType<typeof createPlugFnToolCatalog>>,
    runtime: Awaited<ReturnType<typeof connectPostgresExecutionReceipts>>,
  ) => Promise<T>): Promise<T> {
    const connectionRuntime = await connectPostgresConnections({
      connectionString: databaseConnectionString(event),
    });
    let plugfn: Awaited<ReturnType<typeof connectPlugFn>> | undefined;
    let execution: Awaited<ReturnType<typeof connectPostgresExecutionReceipts>> | undefined;
    try {
      plugfn = await connectPlugFn(event);
      execution = await connectPostgresExecutionReceipts({
        connectionString: databaseConnectionString(event),
        resultWrappingKey: executionWrappingKey(event),
      });
      const catalog = await createPlugFnToolCatalog(plugfn.plugfn, configuredProviders(plugfn.plugfn));
      return await callback(new ExecutionService(
        catalog,
        connectionRuntime.connections,
        plugfn.plugfn,
        execution.receipts,
        (connectionId, connection, principal) => verifiedProviderScopes(plugfn!.plugfn, {
          provider: connection.provider, connectionId,
          userId: principal.userId, workspaceId: principal.workspaceId,
        }),
        Date.now,
        execution.approvals,
        execution.invocationGuard,
        await deriveExecutionFingerprintKey(executionWrappingKey(event)),
      ), catalog, execution);
    } finally {
      await Promise.allSettled([
        connectionRuntime.close(),
        plugfn?.close(),
        execution?.close(),
      ]);
    }
  }

  const execution: ExecutionRouteServices = {
    async execute(request, input) {
      requireExecutionOrigin(request);
      const principal = await authenticate(event, request, input.workspaceId, undefined, allowRemoteMcp);
      return withExecution(async (service) => publicReceipt(await service.execute({
        principal,
        ...input,
        params: input.params as JsonValue,
      })));
    },
    async requestApproval(request, input) {
      requireExecutionOrigin(request);
      const principal = await authenticate(event, request, input.workspaceId, undefined, allowRemoteMcp);
      return withExecution(async (service, catalog) => {
        const approval = await service.requestApproval({
          principal,
          ...input,
          params: input.params as JsonValue,
        });
        return publicApproval(approval, catalog.get(approval.toolId));
      });
    },
    async approve(request, approvalId) {
      requireSameOrigin(request);
      const actorUserId = await requireWebUser(event, request);
      return withExecution(async (service, catalog) => {
        const approval = await service.approve(approvalId, actorUserId);
        return publicApproval(approval, catalog.get(approval.toolId));
      });
    },
    async reject(request, approvalId) {
      requireSameOrigin(request);
      const actorUserId = await requireWebUser(event, request);
      return withExecution(async (service, catalog) => {
        const approval = await service.reject(approvalId, actorUserId);
        return publicApproval(approval, catalog.get(approval.toolId));
      });
    },
    async executeApproved(request, approvalId) {
      requireExecutionOrigin(request);
      const principal = await authenticate(event, request, undefined, undefined, allowRemoteMcp);
      return withExecution(async (service) => publicReceipt(await service.executeApproved(principal, approvalId)));
    },
    async approvalStatus(request, approvalId, workspaceId) {
      const principal = await authenticate(event, request, workspaceId, "approvals:create", allowRemoteMcp);
      if (principal.kind === "web" && !workspaceId) throw new ApprovalUnavailableError();
      return withExecution(async (service, catalog, runtime) => {
        const approval = await service.approvalStatus(principal, approvalId);
        const receipt = principal.kind === "web" && approval.status === "uncertain" &&
          approval.executionReceiptId ? await runtime.receipts.findForApproval({
            workspaceId: approval.workspaceId, actorUserId: principal.userId,
            approvalId: approval.id, receiptId: approval.executionReceiptId,
          }) : null;
        return publicBrowserApprovalStatus(approval, catalog.get(approval.toolId),
          principal.kind === "web", receipt);
      });
    },
    async reconcileUncertain(request, approvalId, decision, workspaceId) {
      requireExecutionOrigin(request);
      const principal = await authenticate(event, request, workspaceId, "approvals:create", allowRemoteMcp);
      if (principal.kind === "web" && !workspaceId) throw new ApprovalUnavailableError();
      return withExecution(async (service, catalog) => {
        const approval = await service.reconcileUncertain(principal, approvalId, decision);
        return publicApproval(approval, catalog.get(approval.toolId));
      });
    },
  };

  const controlPlane: ControlPlaneRouteServices = {
    async revokeSelf(request) {
      // Manual remote MCP grants need this single public cleanup route. Other
      // public API operations still reject their audience in authenticate().
      return revokeOwnBearerClient(request, () => authenticate(event, request, undefined, undefined, true),
        async (actorUserId, grantId) => {
          const access = await connectPostgresClientAccess({ connectionString: databaseConnectionString(event) });
          try { await access.clients.revokeGrant(actorUserId, grantId); }
          finally { await access.close(); }
        });
    },
    /** Assemble the private workspace overview for a current member. */
    async overview(request, requestedWorkspaceId, recoveredApprovalId) {
      const identity = await connectPostgresIdentityRuntime({
        connectionString: databaseConnectionString(event),
        environment: {
          resolve: () => {
            const origin = new URL(event.request.url).origin;
            return { issuer: origin, baseUrl: origin };
          },
        },
      });
      let connections: Awaited<ReturnType<typeof connectPostgresConnections>> | undefined;
      let activity: Awaited<ReturnType<typeof connectPostgresExecutionReceipts>> | undefined;
      let plugfn: Awaited<ReturnType<typeof connectPlugFn>> | undefined;
      try {
        const session = await identity.requireSession(request);
        const workspaces = await identity.workspaces.listWorkspaceAccess(session.actorId);
        const selected = requestedWorkspaceId
          ? workspaces.find(({ workspace }) => workspace.id === requestedWorkspaceId)
          : workspaces[0];
        if (requestedWorkspaceId && !selected) {
          await identity.workspaces.requireMembership(requestedWorkspaceId, session.actorId);
        }
        if (!selected) {
          return {
            actor: { id: session.actorId, email: session.primaryEmail ?? null },
            workspaces,
            selectedWorkspaceId: null,
            connections: [],
            approvals: [],
            executions: [],
            reconciliationReceipts: [],
          };
        }

        connections = await connectPostgresConnections({
          connectionString: databaseConnectionString(event),
        });
        plugfn = await connectPlugFn(event);
        activity = await connectPostgresExecutionReceipts({
          connectionString: databaseConnectionString(event),
          resultWrappingKey: executionWrappingKey(event),
        });
        const connectionService = new PlugFnConnectionOrchestrator(connections.connections, plugfn.plugfn);
        const now = Date.now();
        const [availableConnections, orphanedConnections, recentApprovals, outstandingProvider,
          outstandingBrowser, recoveredApproval, executions] = await Promise.all([
          connectionService.listAvailable({
            actorUserId: session.actorId,
            workspaceId: selected.workspace.id,
          }),
          selected.membership.role === "owner" || selected.membership.role === "admin"
            ? connections.connections.listOrphanedForCleanup({ actorUserId: session.actorId,
              workspaceId: selected.workspace.id })
            : Promise.resolve([]),
          activity.approvals.listForActor({
            actorUserId: session.actorId,
            workspaceId: selected.workspace.id,
            limit: 50,
          }),
          activity.approvals.listOutstandingProviderForActor({
            actorUserId: session.actorId,
            workspaceId: selected.workspace.id,
            now,
            limit: 50,
          }),
          activity.approvals.listOutstandingBrowserForActor({
            actorUserId: session.actorId,
            workspaceId: selected.workspace.id,
            now,
            limit: 50,
          }),
          recoverProviderApproval(activity.approvals, recoveredApprovalId,
            selected.workspace.id, session.actorId, now),
          activity.receipts.listForActor({
            actorUserId: session.actorId,
            workspaceId: selected.workspace.id,
            limit: 50,
          }),
        ]);
        const approvals = visibleApprovals(recentApprovals,
          [...outstandingProvider, ...outstandingBrowser], recoveredApproval, now);
        const approvalCatalog = await createPlugFnToolCatalog(plugfn.plugfn, configuredProviders(plugfn.plugfn));
        const reconciliationReceipts = await providerReconciliationReceipts(
          approvals, activity.receipts, selected.workspace.id, session.actorId);
        return {
          actor: { id: session.actorId, email: session.primaryEmail ?? null },
          workspaces,
          selectedWorkspaceId: selected.workspace.id,
          connections: await publicConnections(
            connections.connections, session.actorId, selected.workspace.id,
            [...availableConnections, ...orphanedConnections.map((binding) => ({ ...binding,
              cleanupOnly: true, selectable: false }))],
          ),
          approvals: approvals.map((approval) => publicBrowserApproval(
            approval, approvalCatalog.get(approval.toolId), session.actorId, selected.workspace.id)),
          executions: executions.map((receipt) => publicReceipt(receipt, false)),
          reconciliationReceipts: reconciliationReceipts.map((receipt) => publicReceipt(receipt, false)),
        };
      } finally {
        await Promise.allSettled([identity.close(), connections?.close(), activity?.close(), plugfn?.close()]);
      }
    },
    async createTeam(request, name) {
      requireSameOrigin(request);
      const identity = await connectPostgresIdentityRuntime({
        connectionString: databaseConnectionString(event),
      });
      try {
        const session = await identity.requireSession(request);
        return await identity.workspaces.createTeam({ ownerUserId: session.actorId, name });
      } finally {
        await identity.close();
      }
    },
    async listManualGrants(request, cursor) {
      const actorUserId = await requireWebUser(event, request);
      const access = await connectPostgresClientAccess({
        connectionString: databaseConnectionString(event),
      });
      try {
        return await access.clients.listManualGrants(actorUserId, cursor);
      } finally {
        await access.close();
      }
    },
    async revokeManualClient(request, clientId) {
      requireSameOrigin(request);
      const actorUserId = await requireWebUser(event, request);
      const access = await connectPostgresClientAccess({
        connectionString: databaseConnectionString(event),
      });
      try {
        await access.clients.revokeManualClient(actorUserId, clientId);
        return { revoked: true };
      } finally {
        await access.close();
      }
    },
  };

  const openRouterVault = createOpenRouterVaultRouteServices({
    enabled: () => openRouterVaultRolloutEnabled(environment(event)),
    requireUser: (request) => requireWebUser(event, request),
    open: () => connectPostgresOpenRouterVault({
      connectionString: openRouterVaultConnectionString(event),
      keys: requiredSecret(event, "OPENROUTER_VAULT_KEYS"),
      activeKeyId: requiredSecret(event, "OPENROUTER_VAULT_ACTIVE_KEY_ID"),
    }),
  });

  const assistedActor = async (request: Request, workspaceId: string) => {
    const origin = new URL(event.request.url).origin;
    const identity = await connectPostgresIdentityRuntime({
      connectionString: databaseConnectionString(event),
      environment: { resolve: () => ({ issuer: origin, baseUrl: origin }) },
    });
    try {
      const session = await identity.requireSession(request);
      await identity.workspaces.requireMembership(workspaceId, session.actorId);
      return session.actorId;
    } finally { await identity.close(); }
  };

  const assistedPlayground: AssistedPlaygroundServices = {
    enabled: () => assistedPlaygroundEnabled(environment(event)),
    authenticate: (request) => requireWebUser(event, request),
    async fingerprint(input, prompt) {
      const bytes = await deriveExecutionFingerprintKey(executionWrappingKey(event));
      const key = await crypto.subtle.importKey("raw", bytes,
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const data = new TextEncoder().encode(JSON.stringify([
        "omr-assisted-turn-v1", input.workspaceId, input.connectionId, input.model, prompt]));
      const digest = await crypto.subtle.sign("HMAC", key, data);
      return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0"))
        .join("");
    },
    async reserveTurn(userId) {
      try { return await reservePostgresAssistedTurn(databaseConnectionString(event), userId); }
      catch (error) {
        if (error instanceof AssistedTurnQuotaExceededError) {
          throw new AssistedPlaygroundError("ASSISTED_RATE_LIMITED", 429);
        }
        throw error;
      }
    },
    async withKey(userId, callback) {
      const runtime = await connectPostgresOpenRouterVault({
        connectionString: openRouterVaultConnectionString(event),
        keys: requiredSecret(event, "OPENROUTER_VAULT_KEYS"),
        activeKeyId: requiredSecret(event, "OPENROUTER_VAULT_ACTIVE_KEY_ID"),
      });
      let key: string;
      try { key = await runtime.vault.withKey(userId, async (value) => value); }
      finally { await runtime.close(); }
      return callback(key);
    },
    async connections(request, workspaceId) {
      const overview = await controlPlane.overview(request, workspaceId) as {
        connections: Awaited<ReturnType<AssistedPlaygroundServices["connections"]>> };
      return overview.connections;
    },
    async discover(request, workspaceId, provider) {
      const found = await tools.discover(request, { workspaceId, providers: [provider], limit: 100 }) as {
        tools: Awaited<ReturnType<AssistedPlaygroundServices["discover"]>> };
      return found.tools;
    },
    execute: (request, input) => execution.execute(request, input),
    requestApproval: (request, input) => execution.requestApproval(request, input),
    async lookupAction(request, input) {
      const userId = await assistedActor(request, input.workspaceId);
      return lookupPostgresAssistedAction({ connectionString: databaseConnectionString(event),
        userId, workspaceId: input.workspaceId, requestId: input.requestId });
    },
    async loadTurn(request, input) {
      const userId = await assistedActor(request, input.workspaceId);
      const binding = await lookupPostgresAssistedTurn({
        connectionString: databaseConnectionString(event), userId,
        workspaceId: input.workspaceId, requestId: input.requestId,
        wrappingKey: decodeExecutionWrappingKey(requiredSecret(event,
          "EXECUTION_RESULT_WRAPPING_KEY")),
      });
      return binding as Awaited<ReturnType<AssistedPlaygroundServices["loadTurn"]>>;
    },
    async bindTurn(userId, input) {
      const result = await bindPostgresAssistedTurn({
        connectionString: databaseConnectionString(event), userId, ...input,
        wrappingKey: decodeExecutionWrappingKey(requiredSecret(event,
          "EXECUTION_RESULT_WRAPPING_KEY")),
      });
      return result as Awaited<ReturnType<AssistedPlaygroundServices["bindTurn"]>>;
    },
  };

  return { device, connections, tools, execution, controlPlane, openRouterVault, assistedPlayground };
}

/** Public /api routes accept remote MCP grants only for self-revocation. */
export function createCloudflareRouteServices(event: RequestEvent): CloudflareRouteServices {
  return createRouteServices(event, false);
}

/** The /mcp adapter alone forwards a validated remote grant into the shared router. */
export function createRemoteMcpRouteServices(event: RequestEvent): CloudflareRouteServices {
  return createRouteServices(event, true);
}
