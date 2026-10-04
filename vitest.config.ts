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
    /** Compile explicit client entrypoints and their relative Svelte children as one graph. */
    resolveId(source, importer) {
      if (!importer) return null;
      const explicit = source.endsWith(".svelte?client");
      if (!explicit && !(importer.startsWith(clientComponentPrefix) &&
        source.startsWith(".") && source.endsWith(".svelte"))) return null;
      const parent = importer.startsWith(clientComponentPrefix)
        ? importer.slice(clientComponentPrefix.length) : importer;
      return `${clientComponentPrefix}${resolve(dirname(parent), explicit
        ? source.slice(0, -"?client".length) : source)}`;
    },
    /** Vitest's DOM suites need the browser-compiled Svelte component module. */
    load(id) {
      if (!id.startsWith(clientComponentPrefix)) return null;
      const filename = id.slice(clientComponentPrefix.length);
      return compile(readFileSync(filename, "utf8"), { filename, generate: "client" }).js.code;
    },
  }],
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./tests/fixtures/cloudflare-workers.ts", import.meta.url)),
      "$lib": fileURLToPath(new URL("./apps/web/src/lib", import.meta.url)),
    },
  },
  test: {
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
});
