import { createMacOsKeychainSecretProvider } from "./keychain-secret.js";
import { createInstalledLarkCliRunnerFactory } from "./installed-lark-cli.js";
import { createBuiltInLarkTransport } from "./lark-transport.js";
import { startExecutiveRuntime } from "./runtime.js";
import type {
  ExecutiveRuntime,
  ProductionRuntimeDependencies,
  RuntimeConfig,
} from "./types.js";

export async function startProductionExecutiveRuntime(
  config: RuntimeConfig,
  dependencies: ProductionRuntimeDependencies,
): Promise<ExecutiveRuntime> {
  const secretProvider =
    dependencies.secretProvider ?? createMacOsKeychainSecretProvider();
  const appSecret = await secretProvider.load(config.appId, config.secretRef);
  const transport = createBuiltInLarkTransport({
    appId: config.appId,
    appSecret,
  });
  const larkCli = config.executables.larkCli;
  if (larkCli === null) throw new Error("LARK_CLI_EXECUTABLE_REQUIRED");
  const larkRunnerFactory =
    dependencies.larkRunnerFactory ??
    createInstalledLarkCliRunnerFactory({
      executable: larkCli,
      homeDirectory: config.paths.larkHome,
    });
  return startExecutiveRuntime(config, {
    transport,
    runner: dependencies.runner,
    larkRunnerFactory,
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.instanceId ? { instanceId: dependencies.instanceId } : {}),
  });
}
