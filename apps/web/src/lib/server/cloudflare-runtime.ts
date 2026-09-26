import type { RequestEvent } from "@superfunctions/http-sveltekit";
import type { ClientCapability } from "@oh-my-router/client-access";
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
import { ExecutionService, type ExecutionPrincipal } from "@oh-my-router/execution";
import { connectPostgresExecutionReceipts } from "@oh-my-router/execution/postgres";
import { connectPostgresIdentityRuntime } from "@oh-my-router/identity/postgres";
import { connectPostgresPlugFn } from "@oh-my-router/plugfn-runtime";
import {
  createPlugFnToolCatalog,
  isProviderConfigured,
  v1ProviderCatalog,
  type JsonValue,
  type ProviderBinding,
  type ProviderStatus,
} from "@oh-my-router/tools";
import type { IntegrationConfig } from "plugfn";

import {
  RuntimeUnavailableError,
  type ConnectionRouteServices,
  type ControlPlaneRouteServices,
  type DeviceRouteServices,
  type ExecutionRouteServices,
  type ToolRouteServices,
  RequestOriginDeniedError,
} from "./router.js";
import { resolveScopedCatalog } from "./scoped-catalog.js";
import { publicConnections, publicConnectionsAfterMutation } from "./connection-view.js";

type OMRBindings = Cloudflare.Env & {
  HYPERDRIVE?: { connectionString: string };
  DATABASE_URL?: string;
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
  return decodeWrappingKey(
    requiredSecret(event, "EXECUTION_RESULT_WRAPPING_KEY"),
    "Execution result",
  );
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

/** Include OAuth provider apps only when both server-side credentials exist. */
export function createProviderIntegrationConfig(
  env: Record<string, unknown>,
  origin: string,
): Record<string, IntegrationConfig> {
  const redirectUri = new URL("/app/oauth/callback", origin).toString();
  return Object.fromEntries(Object.entries(OAUTH_BINDINGS).flatMap(([provider, names]) => {
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
): Promise<ExecutionPrincipal> {
  const credential = bearerCredential(request);
  if (credential) {
    const runtime = await connectPostgresClientAccess({
      connectionString: databaseConnectionString(event),
    });
    try {
      const principal = await runtime.clients.authenticate(credential, capability);
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
  const userId = await requireWebUser(event, request);
  return { kind: "web", userId, workspaceId: workspaceId ?? "" };
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

function configuredProviders(plugfn: Awaited<ReturnType<typeof connectPlugFn>>["plugfn"]): Set<string> {
  return new Set(statuses(plugfn).filter((status) => status.available).map((status) => status.provider));
}

/** Restrict the tool catalog to bindings this principal can currently use. */
export async function scopedToolIds(
  catalog: Awaited<ReturnType<typeof createPlugFnToolCatalog>>,
  plugfn: Awaited<ReturnType<typeof connectPlugFn>>["plugfn"],
  authority: Awaited<ReturnType<typeof connectPostgresConnections>>["connections"],
  principal: ExecutionPrincipal,
  workspaceId: string,
  bindings: readonly ConnectionBindingRecord[],
): Promise<{ allowedToolIds: Set<string>; providers: ProviderStatus[] }> {
  const missing = new Set<string>();
  const allowedToolIds = await resolveScopedCatalog(
    catalog,
    statuses(plugfn, bindings),
    (provider) => authority.resolve({ actorUserId: principal.userId, workspaceId, provider }),
    async (connectionId) => (await plugfn.connections.get(connectionId)).scopes,
    async (bindingId) => {
      missing.add(bindingId);
      await markMissingRemoteConnection(authority, bindingId);
    },
  );
  return {
    allowedToolIds,
    providers: statuses(plugfn, bindings.map((binding) => missing.has(binding.id)
      ? { ...binding, status: "needs_reauth", readiness: "unavailable" } : binding)),
  };
}

/** Bind authenticated control-plane routes to disposable server-side runtimes. */
export function createCloudflareRouteServices(event: RequestEvent): CloudflareRouteServices {
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
      const principal = await authenticate(event, request, workspaceId, "connections:read");
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
      const principal = await authenticate(event, request, input.workspaceId, "connections:read");
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
        (selectionRequest, workspaceId, capability) => authenticate(event, selectionRequest, workspaceId, capability),
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
        (healthRequest, capability) => authenticate(event, healthRequest, undefined, capability),
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
      const principal = await authenticate(event, request, input.workspaceId, "tools:discover");
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
      const principal = await authenticate(event, request, workspaceId, "tools:discover");
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

  async function withExecution<T>(callback: (service: ExecutionService) => Promise<T>): Promise<T> {
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
        async (connectionId) => (await plugfn!.plugfn.connections.get(connectionId)).scopes,
        Date.now,
        execution.approvals,
      ));
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
      const principal = await authenticate(event, request, input.workspaceId);
      return withExecution((service) => service.execute({
        principal,
        ...input,
        params: input.params as JsonValue,
      }));
    },
    async requestApproval(request, input) {
      const principal = await authenticate(event, request, input.workspaceId);
      return withExecution((service) => service.requestApproval({
        principal,
        ...input,
        params: input.params as JsonValue,
      }));
    },
    async approve(request, approvalId) {
      requireSameOrigin(request);
      const actorUserId = await requireWebUser(event, request);
      return withExecution((service) => service.approve(approvalId, actorUserId));
    },
    async reject(request, approvalId) {
      requireSameOrigin(request);
      const actorUserId = await requireWebUser(event, request);
      return withExecution((service) => service.reject(approvalId, actorUserId));
    },
    async executeApproved(request, approvalId) {
      const principal = await authenticate(event, request, undefined);
      return withExecution((service) => service.executeApproved(principal, approvalId));
    },
  };

  const controlPlane: ControlPlaneRouteServices = {
    /** Assemble the private workspace overview for a current member. */
    async overview(request, requestedWorkspaceId) {
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
        const [availableConnections, orphanedConnections, approvals, executions] = await Promise.all([
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
          activity.receipts.listForActor({
            actorUserId: session.actorId,
            workspaceId: selected.workspace.id,
            limit: 50,
          }),
        ]);
        return {
          actor: { id: session.actorId, email: session.primaryEmail ?? null },
          workspaces,
          selectedWorkspaceId: selected.workspace.id,
          connections: await publicConnections(
            connections.connections, session.actorId, selected.workspace.id,
            [...availableConnections, ...orphanedConnections.map((binding) => ({ ...binding,
              cleanupOnly: true, selectable: false }))],
          ),
          approvals,
          executions,
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

  return { device, connections, tools, execution, controlPlane };
}
