import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      "@executive-assistant/action-gateway": resolve(
        import.meta.dirname,
        "../action-gateway/src/index.ts",
      ),
      "@executive-assistant/bridge": resolve(
        import.meta.dirname,
        "../bridge/src/index.ts",
      ),
      "@executive-assistant/contracts": resolve(
        import.meta.dirname,
        "../contracts/src/index.ts",
      ),
      "@executive-assistant/job-store": resolve(
        import.meta.dirname,
        "../job-store/src/index.ts",
      ),
      "@larksuiteoapi/node-sdk": resolve(
        import.meta.dirname,
        "../bridge/node_modules/@larksuiteoapi/node-sdk/es/index.js",
      ),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
