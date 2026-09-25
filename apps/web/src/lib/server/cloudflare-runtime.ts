import type { RequestEvent } from "@superfunctions/http-sveltekit";
import type { ClientCapability } from "@oh-my-router/client-access";
import {
  connectPostgresClientAccess,
  connectPostgresDeviceLogin,
} from "@oh-my-router/client-access/postgres";
import {
  ConnectionAccessDeniedError, markMissingRemoteConnection,
  PlugFnConnectionOrchestrator,
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

function environment(event: RequestEvent): OMRBindings {
  const env = event.platform?.env as OMRBindings | undefined;
  if (!env) throw new RuntimeUnavailableError("Worker bindings are unavailable");
  return env;
}

export function databaseConnectionString(event: RequestEvent): string {
  const env = environment(event);
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!connectionString) {
    throw new RuntimeUnavailableError("Database binding is unavailable");
  }
  return connectionString;
}

function requiredSecret(event: RequestEvent, name: string): string {
  const value = environment(event)[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeUnavailableError(`${name} binding is unavailable`);
  }
  return value;
}

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

function bearerCredential(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) throw new RuntimeUnavailableError("Authorization header is invalid");
  return match[1]!;
}

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

function requireSameOrigin(request: Request): void {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    throw new RequestOriginDeniedError("A same-origin browser request is required");
  }
}

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

async function connectPlugFn(event: RequestEvent) {
  const origin = new URL(event.request.url).origin;
  return connectPostgresPlugFn({
    connectionString: databaseConnectionString(event),
    baseUrl: origin,
    encryptionKey: requiredSecret(event, "PLUGFN_ENCRYPTION_KEY"),
    integrations: integrationConfig(event),
  });
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

export function createCloudflareRouteServices(event: RequestEvent): CloudflareRouteServices {
  const device = createCloudflareDeviceServices(event);

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
    async list(request, input) {
      const principal = await authenticate(event, request, input.workspaceId, "connections:read");
      return withConnections((orchestrator) => orchestrator.listAvailable({
        actorUserId: principal.userId,
        workspaceId: input.workspaceId,
        ...(input.provider ? { provider: input.provider } : {}),
      }));
    },
    async select(request, input) {
      if (!bearerCredential(request)) requireSameOrigin(request);
      const principal = await authenticate(event, request, input.workspaceId, "connections:read");
      return withConnections((orchestrator) => orchestrator.select({
        actorUserId: principal.userId,
        ...input,
      }));
    },
    async startOAuth(request, input) {
      requireSameOrigin(request);
      const actorUserId = await requireWebUser(event, request);
      return withConnections((orchestrator) => orchestrator.startOAuth({ actorUserId, ...input }));
    },
    async completeOAuth(request, input) {
      requireSameOrigin(request);
      const actorUserId = await requireWebUser(event, request);
      return withConnections((orchestrator) => orchestrator.completeOAuth({ actorUserId, ...input }));
    },
    async connectApiKey(request, input) {
      requireSameOrigin(request);
      const actorUserId = await requireWebUser(event, request);
      return withConnections((orchestrator) => orchestrator.connectApiKey({ actorUserId, ...input }));
    },
    async checkHealth(request, connectionId) {
      const principal = await authenticate(event, request, undefined, "connections:read");
      return withConnections((orchestrator) => orchestrator.checkHealth(principal.userId, connectionId));
    },
    async refresh(request, connectionId) {
      requireSameOrigin(request);
      const actorUserId = await requireWebUser(event, request);
      return withConnections((orchestrator) => orchestrator.refresh(actorUserId, connectionId));
    },
    async disconnect(request, connectionId) {
      requireSameOrigin(request);
      const actorUserId = await requireWebUser(event, request);
      return withConnections((orchestrator) => orchestrator.disconnect(actorUserId, connectionId));
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

  async function scopedToolIds(
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
        activity = await connectPostgresExecutionReceipts({
          connectionString: databaseConnectionString(event),
          resultWrappingKey: executionWrappingKey(event),
        });
        const [availableConnections, approvals, executions] = await Promise.all([
          connections.connections.listAvailable({
            actorUserId: session.actorId,
            workspaceId: selected.workspace.id,
          }),
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
          connections: availableConnections,
          approvals,
          executions,
        };
      } finally {
        await Promise.allSettled([identity.close(), connections?.close(), activity?.close()]);
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
