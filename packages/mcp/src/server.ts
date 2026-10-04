import {
  defineMcpFnServer,
  McpFnRegistry,
  structuredResult,
  type McpFnObjectSchema,
  type McpFnToolDefinition,
} from "@mcpfn/core";
import { OMRClient } from "@oh-my-router/client";
import type { JsonValue, ToolManifest } from "@oh-my-router/tools";

const CONNECTIONS_TOOL = "omr.connections.list";
const SELECT_CONNECTION_TOOL = "omr.connections.select";
const EXECUTE_APPROVAL_TOOL = "omr.approvals.execute";
const STATUS_APPROVAL_TOOL = "omr.approvals.status";
const RECONCILE_APPROVAL_TOOL = "omr.approvals.reconcile";
const REFRESH_CATALOG_TOOL = "omr.catalog.refresh";
const PROVIDERS_TOOL = "omr.catalog.providers";
const IDEMPOTENCY_FIELD = "_omrIdempotencyKey";
type VisibilityContext = { manifests?: Promise<Map<string, string>> };

/** Preserve object unions while giving MCP hosts a discoverable root object. */
function objectSchema(value: unknown): McpFnObjectSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OMR catalog tool has a non-object input schema");
  }
  const schema = value as Record<string, unknown>;
  if (schema.type === "object") return schema as McpFnObjectSchema;
  if (!Array.isArray(schema.anyOf) || !schema.anyOf.length ||
    !schema.anyOf.every((branch) => branch && typeof branch === "object" &&
      !Array.isArray(branch) && (branch as { type?: unknown }).type === "object")) {
    throw new Error("OMR catalog tool has a non-object input schema");
  }
  const branches = schema.anyOf as McpFnObjectSchema[];
  const properties: NonNullable<McpFnObjectSchema["properties"]> = {};
  for (const branch of branches) {
    for (const [name, property] of Object.entries(branch.properties ?? {})) {
      if (!(name in properties)) properties[name] = property;
    }
  }
  const required = (branches[0]?.required ?? []).filter((name) =>
    branches.every((branch) => branch.required?.includes(name)));
  return { ...schema, type: "object", properties, required };
}

/** Add a caller-owned idempotency key only to approval-requiring actions. */
function actionInputSchema(manifest: ToolManifest): McpFnObjectSchema {
  const schema = objectSchema(manifest.inputSchema);
  if (IDEMPOTENCY_FIELD in (schema.properties ?? {})) {
    throw new Error(`OMR catalog tool ${manifest.id} conflicts with the MCP idempotency field`);
  }
  if (manifest.contract.effect === "read") return schema;
  const idempotencyProperty = {
    type: "string",
    description: "Caller-generated stable key for this intended action. Reuse it after an uncertain response; use a new key for a new action.",
  };
  return {
    ...schema,
    properties: {
      ...schema.properties,
      [IDEMPOTENCY_FIELD]: idempotencyProperty,
    },
    required: [...(schema.required ?? []), IDEMPOTENCY_FIELD],
    ...(Array.isArray(schema.anyOf) ? { anyOf: schema.anyOf.map((branch) => ({
      ...branch as McpFnObjectSchema,
      properties: { ...(branch as McpFnObjectSchema).properties, [IDEMPOTENCY_FIELD]: idempotencyProperty },
    })) } : {}),
  };
}

/** Wrap scalar backend results in MCP structured content. */
function structured(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { result: value };
}

/** Give the host a resumable approval handle without executing the action. */
function approvalSummary(value: unknown, toolId: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OMR returned an invalid approval response");
  }
  const approval = value as Record<string, unknown>;
  if (typeof approval.id !== "string" || !approval.id) {
    throw new Error("OMR approval response did not include an approval id");
  }
  return {
    status: "approval_required",
    executed: false,
    approvalId: approval.id,
    toolId,
    ...(typeof approval.expiresAt === "number" ? { expiresAt: approval.expiresAt } : {}),
    message: "Approval was requested in OMR. After it is approved, call omr.approvals.execute with this approvalId.",
    resume: {
      tool: EXECUTE_APPROVAL_TOOL,
      arguments: { approvalId: approval.id },
    },
  };
}

/** Build OMR's policy backed MCP server for local stdio or remote HTTP transport. */
export async function createOMRMcpServer(input: {
  baseUrl: string;
  credential: string;
  workspaceId: string;
  fetchImpl?: typeof fetch;
  statelessHttp?: boolean;
}) {
  const client = new OMRClient(input);
  /** Collect the complete authorized catalog before registering session tools. */
  async function discoverManifests(): Promise<ToolManifest[]> {
    const manifests: ToolManifest[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.discoverTools({ workspaceId: input.workspaceId, limit: 100, ...(cursor ? { cursor } : {}) });
      manifests.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return manifests;
  }
  const manifests = await discoverManifests();

  const reservedNames = new Set([CONNECTIONS_TOOL, SELECT_CONNECTION_TOOL, EXECUTE_APPROVAL_TOOL,
    STATUS_APPROVAL_TOOL,
    RECONCILE_APPROVAL_TOOL, REFRESH_CATALOG_TOOL, PROVIDERS_TOOL]);
  const collision = manifests.find((manifest) => reservedNames.has(manifest.id));
  if (collision) throw new Error(`OMR catalog tool ${collision.id} conflicts with an MCP control tool`);

  /** Project one policy-backed catalog action into the MCP registry. */
  const definition = (manifest: ToolManifest): McpFnToolDefinition<VisibilityContext> => ({
    name: manifest.id,
    title: manifest.displayName,
    description: manifest.description,
    inputSchema: actionInputSchema(manifest),
    annotations: {
      readOnlyHint: manifest.contract.effect === "read",
      destructiveHint: manifest.contract.effect === "destructive",
      idempotentHint: manifest.contract.retry !== "never",
      openWorldHint: true,
    },
    metadata: {
      provider: manifest.provider,
      providerVersion: manifest.providerVersion,
      manifestHash: manifest.hash,
      effect: manifest.contract.effect,
      approvalMode: manifest.contract.effect === "read" ? "none" : "required",
    },
    async handler(args) {
      const { [IDEMPOTENCY_FIELD]: idempotencyKey, ...params } = args;
      const execution = {
        workspaceId: input.workspaceId,
        toolId: manifest.id,
        params: params as JsonValue,
      };
      if (manifest.contract.effect !== "read") {
        if (typeof idempotencyKey !== "string") throw new Error(`${IDEMPOTENCY_FIELD} is required`);
        const approval = await client.requestApproval({ ...execution, idempotencyKey });
        return structuredResult(approvalSummary(approval, manifest.id));
      }
      return structuredResult(structured(await client.execute(execution)));
    },
  });
  const tools: McpFnToolDefinition<VisibilityContext>[] = manifests.map(definition);

  const registeredHashes = new Map(manifests.map(({ id, hash }) => [id, hash]));
  let visibleAtLastRefresh = new Set(manifests.map(({ id }) => id));
  // Published mcpfn selects its validator for Node or Workers at runtime.
  const registry = new McpFnRegistry<VisibilityContext>();

  tools.push(
    {
      name: PROVIDERS_TOOL,
      title: "List OMR Provider Readiness",
      description: "Show the workspace-scoped v1 provider catalog and readiness, including providers with no visible tools or connections.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      metadata: { surface: "omr-control-plane" },
      async handler() {
        const { catalogSchemaVersion, revision, providers } = await client.discoverTools({
          workspaceId: input.workspaceId, limit: 1,
        });
        if (!providers) throw new Error("OMR discovery did not include provider readiness");
        return structuredResult({ catalogSchemaVersion, revision, providers });
      },
    },
    {
      name: REFRESH_CATALOG_TOOL,
      title: "Refresh OMR Tool Catalog",
      description: "Refresh this MCP session after connecting a provider; changed schemas require restarting the session.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      metadata: { surface: "omr-control-plane" },
      async handler(_args, _context, extra) {
        const fresh = await discoverManifests();
        if (fresh.some(({ id, hash }) => registeredHashes.has(id) && registeredHashes.get(id) !== hash)) {
          throw new Error("OMR catalog schema changed; restart this MCP session");
        }
        let added = 0;
        for (const manifest of fresh) {
          if (reservedNames.has(manifest.id)) throw new Error(`OMR catalog tool ${manifest.id} conflicts with an MCP control tool`);
          if (registeredHashes.has(manifest.id)) continue;
          registry.register(definition(manifest));
          registeredHashes.set(manifest.id, manifest.hash);
          added += 1;
        }
        const visible = new Set(fresh.map(({ id }) => id));
        const visibilityChanged = visible.size !== visibleAtLastRefresh.size ||
          [...visible].some((id) => !visibleAtLastRefresh.has(id));
        if (input.statelessHttp) {
          // Each HTTP request has a fresh registry. The remote host's cached
          // list is the only durable baseline, so always invalidate it on an
          // explicit refresh using the notification's response stream.
          await extra.sendNotification({ method: "notifications/tools/list_changed" });
        } else if (visibilityChanged) {
          await server.sendToolListChanged();
        }
        visibleAtLastRefresh = visible;
        return structuredResult({ added, tools: fresh.length, ...(input.statelessHttp ? { relistRequired: true } : {}) });
      },
    },
    {
      name: CONNECTIONS_TOOL,
      title: "List OMR Connections",
      description: "List provider connections available to this OMR workspace.",
      inputSchema: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            description: "Optional provider name to filter by.",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      metadata: { surface: "omr-control-plane" },
      async handler(args) {
        const provider = typeof args.provider === "string" ? args.provider : undefined;
        const connections = await client.listConnections(input.workspaceId, provider);
        return structuredResult({ connections });
      },
    },
    {
      name: SELECT_CONNECTION_TOOL,
      title: "Select an OMR Connection",
      description: "Choose an accessible ready connection for a provider in this workspace; refresh the catalog afterwards.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string", description: "Provider identifier from omr.connections.list." },
          connectionId: { type: "string", description: "Connection id from omr.connections.list." },
        },
        required: ["provider", "connectionId"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      metadata: { surface: "omr-control-plane" },
      async handler(args) {
        const selection = await client.selectConnection({
          workspaceId: input.workspaceId,
          provider: String(args.provider),
          connectionId: String(args.connectionId),
        });
        return structuredResult(structured(selection));
      },
    },
    {
      name: EXECUTE_APPROVAL_TOOL,
      title: "Execute an Approved OMR Action",
      description: "Execute a previously requested OMR approval after a workspace owner approves it.",
      inputSchema: {
        type: "object",
        properties: {
          approvalId: {
            type: "string",
            description: "The approval id returned by a write, destructive, or unknown-effect tool.",
          },
        },
        required: ["approvalId"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      metadata: { surface: "omr-control-plane" },
      async handler(args) {
        return structuredResult(structured(await client.executeApproved(String(args.approvalId))));
      },
    },
    {
      name: STATUS_APPROVAL_TOOL,
      title: "Read OMR Approval Status",
      description: "Read an approval by ID using this MCP client's original grant. After a lost reconciliation response, check reconciledAs before retrying the same decision.",
      inputSchema: {
        type: "object",
        properties: { approvalId: { type: "string", description: "The approval id." } },
        required: ["approvalId"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      metadata: { surface: "omr-control-plane" },
      async handler(args) {
        return structuredResult(structured(await client.approvalStatus(String(args.approvalId))));
      },
    },
    {
      name: RECONCILE_APPROVAL_TOOL,
      title: "Reconcile an Uncertain Approval",
      description: "After checking the selected provider independently, record whether an uncertain Linear issue change, Slack post, or Notion page create or rename happened. Verify a Slack post in its selected channel, or the exact Notion page and title in the selected integration workspace. An effect_absent decision permits a new approval only when OMR received a completed but ambiguous mutation response; transport uncertainty stays fenced.",
      inputSchema: {
        type: "object",
        properties: {
          approvalId: { type: "string", description: "The uncertain approval id." },
          decision: { type: "string", enum: ["effect_present", "effect_absent"],
            description: "The outcome you verified in the selected provider workspace and target." },
        },
        required: ["approvalId", "decision"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      metadata: { surface: "omr-control-plane" },
      async handler(args) {
        const decision = String(args.decision);
        if (decision !== "effect_present" && decision !== "effect_absent") throw new Error("Invalid decision");
        return structuredResult(structured(await client.reconcileUncertain(String(args.approvalId), decision)));
      },
    },
  );

  registry.registerAll(tools);
  const server = defineMcpFnServer({
    info: {
      name: "oh-my-router",
      version: "0.0.0",
      instructions: "Use omr.catalog.providers to inspect the workspace-scoped v1 provider states, including unavailable providers. Tools are projected from the authenticated OMR catalog. For multiple ready connections, list and select one with omr.connections.list and omr.connections.select. Call omr.catalog.refresh after connection or selection changes; changed schemas require restarting this session. Revoked tools are hidden on the next list and call. Write, destructive, and unknown-effect calls create an OMR approval instead of executing immediately. After approval in the OMR control plane, call omr.approvals.execute with the returned approvalId. Verify an uncertain Linear result in Linear, an uncertain Slack post in the selected channel, or a Notion page create or rename by checking the exact page and title in the selected integration workspace, before calling omr.approvals.reconcile. If that response is lost, read omr.approvals.status by the same grant and check reconciledAs before retrying the same decision.",
    },
    transports: ["stdio", "streamable-http"],
    registry,
  }).createServer({
    context: () => ({}),
    toolVisibility: async ({ tool, context }) => {
      if (reservedNames.has(tool.name)) return true;
      context.manifests ??= discoverManifests()
        .then((fresh) => new Map(fresh.map(({ id, hash }) => [id, hash])))
        .catch(() => new Map<string, string>());
      return (await context.manifests).get(tool.name) === registeredHashes.get(tool.name);
    },
  });
  return server;
}
