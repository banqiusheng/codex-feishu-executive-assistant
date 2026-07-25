import { pathToFileURL } from "node:url";

import { createProductionCodexRunner } from "./codex-runner.js";
import { loadRuntimeConfig } from "./config.js";
import { startProductionExecutiveRuntime } from "./production.js";
import type { ExecutiveRuntime } from "./types.js";

function configPathFromArguments(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): string {
  if (argv[0] !== "start") throw new Error("RUNTIME_COMMAND_INVALID");
  if (argv.length === 1) {
    const path = environment.ASSISTANT_CONFIG_PATH;
    if (!path) throw new Error("RUNTIME_CONFIG_PATH_REQUIRED");
    return path;
  }
  if (argv.length !== 3 || argv[1] !== "--config" || !argv[2]) {
    throw new Error("RUNTIME_ARGUMENTS_INVALID");
  }
  return argv[2];
}

export async function runRuntimeCli(
  argv: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ExecutiveRuntime> {
  const configPath = configPathFromArguments(argv, environment);
  const config = await loadRuntimeConfig(configPath);
  const runner = createProductionCodexRunner({
    nodePath: config.executables.node,
    codexPath: config.executables.codex,
    codexHome: config.paths.codexHome,
  });
  const runtime = await startProductionExecutiveRuntime(config, { runner });
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void runtime
      .close()
      .then(() => {
        process.exitCode = 0;
      })
      .catch(() => {
        process.exitCode = 1;
      });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return runtime;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  runRuntimeCli().catch(() => {
    process.stderr.write("RUNTIME_START_FAILED\n");
    process.exitCode = 1;
  });
}
