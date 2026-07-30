import { dirname, resolve } from "node:path";

import { createInstalledUserAuthorizationAdapter } from "./installed-user-auth.js";
import { createMacOsKeychainSecretProvider } from "./keychain-secret.js";
import { createInstalledLarkCliRunnerFactory } from "./installed-lark-cli.js";
import { createBuiltInLarkTransport } from "./lark-transport.js";
import { startExecutiveRuntime } from "./runtime.js";
import type {
  ExecutiveRuntime,
  ProductionRuntimeDependencies,
  RuntimeConfig,
} from "./types.js";
import {
  createRuntimeUserAuthorizationFlow,
  type RuntimeUserAuthorizationFlow,
} from "./user-auth-flow.js";

const FEISHU_SCOPE_CONTRACT_SHA256 =
  "40f77b8df33af965544046313016116fd2a249afaed2d96044649863568db93e";

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
  const userAuthHelper = config.executables.userAuthHelper;
  if (userAuthHelper === null) {
    throw new Error("USER_AUTH_HELPER_EXECUTABLE_REQUIRED");
  }
  const larkRunnerFactory =
    dependencies.larkRunnerFactory ??
    createInstalledLarkCliRunnerFactory({
      executable: larkCli,
      homeDirectory: config.paths.larkHome,
    });
  const installedUserAuthorization = createInstalledUserAuthorizationAdapter({
    scopeContractPath: resolve(
      dirname(userAuthHelper),
      "../config/feishu-scopes.json",
    ),
    scopeContractSha256: FEISHU_SCOPE_CONTRACT_SHA256,
    appId: config.appId,
    larkCliPath: larkCli,
    larkHome: config.paths.larkHome,
    nodePath: config.executables.node,
    userAuthHelperPath: userAuthHelper,
  });
  const baseUserAuthorizationFlow = createRuntimeUserAuthorizationFlow({
    inspect: () => installedUserAuthorization.inspect(),
    startHelper: (missingScopes) =>
      installedUserAuthorization.startHelper(missingScopes),
    async sendAuthorizationCard(input) {
      await transport.sendUserAuthorizationCard({
        chatId: input.chatId,
        replyToMessageId: input.replyToMessageId,
        authorizationUrl: input.authorizationUrl,
      });
    },
    async sendText(input) {
      await transport.sendText({
        chatId: input.chatId,
        replyToMessageId: input.replyToMessageId,
        text: input.text,
      });
    },
  });
  const userAuthorizationFlow: RuntimeUserAuthorizationFlow = Object.freeze({
    ensureAuthorized: (route) =>
      baseUserAuthorizationFlow.ensureAuthorized(route),
    waitForIdle: () => baseUserAuthorizationFlow.waitForIdle(),
    async close() {
      await Promise.all([
        baseUserAuthorizationFlow.close(),
        installedUserAuthorization.close(),
      ]);
    },
  });
  try {
    return await startExecutiveRuntime(config, {
      transport,
      runner: dependencies.runner,
      larkRunnerFactory,
      userAuthorizationFlow,
      ...(dependencies.now ? { now: dependencies.now } : {}),
      ...(dependencies.instanceId
        ? { instanceId: dependencies.instanceId }
        : {}),
    });
  } catch (error) {
    await userAuthorizationFlow.close().catch(() => undefined);
    throw error;
  }
}
