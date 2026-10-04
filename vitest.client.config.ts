import { mergeConfig } from "vitest/config";
import base from "./vitest.config";

// Only the DOM component suite resolves Svelte's browser export.
export default mergeConfig(base, {
  resolve: { conditions: ["browser"] },
  test: { include: ["tests/acceptance/direct-playground-ui.test.ts",
    "tests/acceptance/client-component-import.test.ts"] },
});
