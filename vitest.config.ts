import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
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
