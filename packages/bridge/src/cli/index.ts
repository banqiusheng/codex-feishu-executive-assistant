import { Command } from "commander";

import pkg from "../../package.json";
import { runStart } from "./commands/start.js";

const program = new Command();

program
  .name("lark-codex-bridge")
  .description("Fail-closed bridge runtime entry")
  .version(pkg.version, "-v, --version");

for (const command of ["run", "start"] as const) {
  program
    .command(command)
    .description("Requires injected durable assistant runtime ports")
    .action(async () => {
      await runStart({});
    });
}

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
