import {
  createLarkCliRunner,
  type LarkCliReleaseEvidence,
} from "../lark-cli-runner.js";
import { createMvpLarkCliRouteRegistry } from "./lark-routes.js";
import type { MvpLarkCliRunner } from "./registry.js";

export type MvpLarkCliReleaseEvidence = LarkCliReleaseEvidence;

export function createMvpInstalledLarkCliRunner(
  options: Readonly<{
    executable: string;
    homeDirectory: string;
    taskDirectory: string;
    verifyRelease: (
      executable: string,
    ) => MvpLarkCliReleaseEvidence | Promise<MvpLarkCliReleaseEvidence>;
  }>,
): MvpLarkCliRunner {
  const runner = createLarkCliRunner({
    executable: options.executable,
    homeDirectory: options.homeDirectory,
    taskDirectory: options.taskDirectory,
    registry: createMvpLarkCliRouteRegistry(),
    verifyRelease: options.verifyRelease,
  });
  return Object.freeze({
    runBot: runner.runBot,
    runUser: runner.runUser,
  });
}
