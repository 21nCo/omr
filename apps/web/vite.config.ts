import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
  ssr: {
    noExternal: ["@cloudflare/workers-oauth-provider"],
  },
  build: {
    rollupOptions: {
      external: ["cloudflare:workers"],
    },
  },
});
