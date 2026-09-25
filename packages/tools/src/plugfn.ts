import { zodToJsonSchema } from "zod-to-json-schema";

import { ToolCatalog, type JsonValue, type ToolCatalogSource } from "./catalog.js";

export function createPlugFnToolCatalog(source: ToolCatalogSource): Promise<ToolCatalog> {
  return ToolCatalog.create(source, (schema) => zodToJsonSchema(schema as never, {
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as JsonValue);
}
