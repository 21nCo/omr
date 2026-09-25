import {
  defineMcpFnServer,
  McpFnRegistry,
  structuredResult,
  type McpFnObjectSchema,
  type McpFnSchemaCompiler,
  type McpFnToolDefinition,
} from "@mcpfn/core";
import { OMRClient } from "@oh-my-router/client";
import type { JsonValue, ToolManifest } from "@oh-my-router/tools";

const CONNECTIONS_TOOL = "omr.connections.list";
const EXECUTE_APPROVAL_TOOL = "omr.approvals.execute";
const REFRESH_CATALOG_TOOL = "omr.catalog.refresh";

function objectSchema(value: unknown): McpFnObjectSchema {
  if (value && typeof value === "object" && !Array.isArray(value) &&
    (value as { type?: unknown }).type === "object") return value as McpFnObjectSchema;
  return { type: "object", properties: {}, additionalProperties: true };
}

function structured(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { result: value };
}

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

export async function createOMRMcpServer(input: {
  baseUrl: string;
  credential: string;
  workspaceId: string;
  fetchImpl?: typeof fetch;
  schemaCompiler?: McpFnSchemaCompiler;
}) {
  const client = new OMRClient(input);
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

  const reservedNames = new Set([CONNECTIONS_TOOL, EXECUTE_APPROVAL_TOOL, REFRESH_CATALOG_TOOL]);
  const collision = manifests.find((manifest) => reservedNames.has(manifest.id));
  if (collision) throw new Error(`OMR catalog tool ${collision.id} conflicts with an MCP control tool`);

  const definition = (manifest: ToolManifest): McpFnToolDefinition<ReadonlyMap<string, string>> => ({
    name: manifest.id,
    title: manifest.displayName,
    description: manifest.description,
    inputSchema: objectSchema(manifest.inputSchema),
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
      const execution = {
        workspaceId: input.workspaceId,
        toolId: manifest.id,
        params: args as JsonValue,
      };
      if (manifest.contract.effect !== "read") {
        const approval = await client.requestApproval(execution);
        return structuredResult(approvalSummary(approval, manifest.id));
      }
      return structuredResult(structured(await client.execute(execution)));
    },
  });
  const tools: McpFnToolDefinition<ReadonlyMap<string, string>>[] = manifests.map(definition);

  const registeredHashes = new Map(manifests.map(({ id, hash }) => [id, hash]));
  const registry = new McpFnRegistry<ReadonlyMap<string, string>>({ compileSchema: input.schemaCompiler });

  tools.push(
    {
      name: REFRESH_CATALOG_TOOL,
      title: "Refresh OMR Tool Catalog",
      description: "Refresh this MCP session after connecting a provider; changed schemas require restarting the session.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      metadata: { surface: "omr-control-plane" },
      async handler() {
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
        if (added) await server.sendToolListChanged();
        return structuredResult({ added, tools: fresh.length });
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
  );

  registry.registerAll(tools);
  const server = defineMcpFnServer({
    info: {
      name: "oh-my-router",
      version: "0.0.0",
      instructions: "Tools are projected from the authenticated OMR catalog. Call omr.catalog.refresh after connecting a provider to add new tools; changed schemas require restarting this session. Revoked tools are hidden on the next list and call. Write, destructive, and unknown-effect calls create an OMR approval instead of executing immediately. After approval in the OMR control plane, call omr.approvals.execute with the returned approvalId.",
    },
    transports: ["stdio", "streamable-http"],
    registry,
  }).createServer({
    context: async () => new Map((await discoverManifests()).map(({ id, hash }) => [id, hash])),
    toolVisibility: ({ tool, context }) =>
      reservedNames.has(tool.name) || context.get(tool.name) === registeredHashes.get(tool.name),
  });
  return server;
}
