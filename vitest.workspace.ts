import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  { test: { name: "root", include: ["tests/**/*.test.ts"] } },
  {
    test: {
      name: "contracts",
      include: ["packages/contracts/test/**/*.test.ts"],
    },
  },
  {
    test: { name: "bridge", include: ["packages/bridge/test/**/*.test.ts"] },
  },
  {
    test: {
      name: "job-store",
      include: ["packages/job-store/test/**/*.test.ts"],
    },
  },
  {
    test: {
      name: "action-gateway",
      include: ["packages/action-gateway/test/**/*.test.ts"],
    },
  },
  {
    test: {
      name: "runtime",
      include: ["packages/runtime/test/**/*.test.ts"],
    },
  },
]);
