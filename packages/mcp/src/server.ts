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
  const manifests: ToolManifest[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.discoverTools({ limit: 100, ...(cursor ? { cursor } : {}) });
    manifests.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);

  const reservedNames = new Set([CONNECTIONS_TOOL, EXECUTE_APPROVAL_TOOL]);
  const collision = manifests.find((manifest) => reservedNames.has(manifest.id));
  if (collision) throw new Error(`OMR catalog tool ${collision.id} conflicts with an MCP control tool`);

  const tools: McpFnToolDefinition[] = manifests.map((manifest) => ({
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
  }));

  tools.push(
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

  const registry = new McpFnRegistry({ compileSchema: input.schemaCompiler });
  registry.registerAll(tools);
  return defineMcpFnServer({
    info: {
      name: "oh-my-router",
      version: "0.0.0",
      instructions: "Tools are projected from the authenticated OMR catalog. Write, destructive, and unknown-effect calls create an OMR approval instead of executing immediately. After approval in the OMR control plane, call omr.approvals.execute with the returned approvalId.",
    },
    transports: ["stdio", "streamable-http"],
    registry,
  }).createServer();
}
