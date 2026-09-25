import { createDatafnServer, type DatafnServer } from "@datafn/server";
import type { Adapter } from "@superfunctions/db";

import { publicDatafnSchema } from "./schema.js";

export interface WorkspacePrincipal {
  workspaceId: string;
  actorId: string;
}

export type OMRDataAction = Parameters<
  NonNullable<Parameters<typeof createDatafnServer<WorkspacePrincipal>>[0]["authorize"]>
>[1];

export interface CreateOMRDataRuntimeOptions {
  database: Adapter;
  resolvePrincipal(request: Request): Promise<WorkspacePrincipal> | WorkspacePrincipal;
  authorize(
    principal: WorkspacePrincipal,
    action: OMRDataAction,
    payload: unknown,
  ): Promise<boolean> | boolean;
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;

export function assertWorkspacePrincipal(principal: WorkspacePrincipal): void {
  if (!SAFE_IDENTIFIER.test(principal.workspaceId)) {
    throw new Error("Invalid workspace principal");
  }
  if (!SAFE_IDENTIFIER.test(principal.actorId)) {
    throw new Error("Invalid actor principal");
  }
}

export async function createOMRDataRuntime(
  options: CreateOMRDataRuntimeOptions,
): Promise<DatafnServer<WorkspacePrincipal>> {
  return createDatafnServer<WorkspacePrincipal>({
    schema: publicDatafnSchema,
    database: options.database,
    context: async (request) => {
      const principal = await options.resolvePrincipal(request);
      assertWorkspacePrincipal(principal);
      return principal;
    },
    authorize: (principal, action, payload) =>
      options.authorize(principal, action, payload),
    namespaceProvider: {
      getNamespace: (principal) => `workspace:${principal.workspaceId}`,
      getActorId: (principal) => principal.actorId,
    },
    rowLevelNamespace: {
      enabled: true,
      columnName: "__ns",
      mandatory: true,
    },
    allowUnknownResources: false,
    debug: false,
    limits: {
      maxLimit: 100,
      maxTransactSteps: 25,
      maxPayloadBytes: 1_048_576,
      maxPullLimit: 500,
      maxSelectTokens: 20,
      maxFilterKeysPerLevel: 12,
      maxSortFields: 5,
      maxAggregations: 10,
      maxIdLength: 200,
      maxBatchSize: 100,
      maxBatchQueryConcurrency: 8,
    },
  });
}
