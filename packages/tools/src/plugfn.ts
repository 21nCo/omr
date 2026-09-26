import { zodToJsonSchema } from "zod-to-json-schema";

import { ToolCatalog, type JsonValue, type ToolCatalogSource } from "./catalog.js";
import { V1_PROVIDERS } from "./providers.js";

export function createPlugFnToolCatalog(
  source: ToolCatalogSource,
  allowedProviders: ReadonlySet<string> = new Set(V1_PROVIDERS),
): Promise<ToolCatalog> {
  return ToolCatalog.create(source, (schema) => zodToJsonSchema(schema as never, {
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as JsonValue, allowedProviders);
}
