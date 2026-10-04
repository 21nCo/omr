import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { defineConfig } from "vitest/config";
import { compile } from "svelte/compiler";

const clientComponentPrefix = "\0omr-client-component:";

export default defineConfig({
  plugins: [{
    name: "omr-vitest-client-component",
    enforce: "pre",
    resolveId(source, importer) {
      if (!source.endsWith(".svelte?client") || !importer) return null;
      return `${clientComponentPrefix}${resolve(dirname(importer), source.slice(0, -"?client".length))}`;
    },
    load(id) {
      if (!id.startsWith(clientComponentPrefix)) return null;
      const filename = id.slice(clientComponentPrefix.length);
      return compile(readFileSync(filename, "utf8"), { filename, generate: "client" }).js.code;
    },
  }],
  resolve: {
    conditions: ["browser"],
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./tests/fixtures/cloudflare-workers.ts", import.meta.url)),
      "$lib": fileURLToPath(new URL("./apps/web/src/lib", import.meta.url)),
    },
  },
  test: {
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
});
