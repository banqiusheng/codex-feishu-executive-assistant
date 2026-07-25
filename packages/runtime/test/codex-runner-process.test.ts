import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProductionCodexRunner } from "../src/codex-runner.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("production Codex process launch", () => {
  it("launches an env-node Codex script through the configured Node executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "executive-codex-process-"));
    roots.push(root);
    await chmod(root, 0o700);
    const codexPath = join(root, "codex-fixture.mjs");
    const gatewaySocket = join(root, "gateway.sock");
    const gatewayClient = join(root, "assistant-gateway");
    await writeFile(
      codexPath,
      `#!/usr/bin/env node
const expectedPath = "/usr/bin:/bin:/usr/sbin:/sbin";
const argv = process.argv.slice(2);
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
if (
  process.env.PATH !== expectedPath ||
  process.env.AMBIENT_SECRET_SENTINEL !== undefined ||
  prompt !== "只回复连接正常" ||
  !argv.includes("exec") ||
  !argv.includes("--json") ||
  !argv.some((value) => value.includes(${JSON.stringify(gatewaySocket)}))
) {
  process.exit(72);
}
const threadId = "018f7d72-7a2b-7f45-8a12-8e20b8426a21";
for (const event of [
  { type: "thread.started", thread_id: threadId },
  { type: "turn.started" },
  {
    type: "item.completed",
    item: { id: "item-1", type: "agent_message", text: "连接正常" },
  },
  {
    type: "turn.completed",
    usage: {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
    },
  },
]) {
  process.stdout.write(JSON.stringify(event) + "\\n");
}
`,
      { mode: 0o500 },
    );

    const runner = createProductionCodexRunner({
      nodePath: process.execPath,
      codexPath,
      codexHome: join(root, "codex-home"),
    });
    const previousSentinel = process.env.AMBIENT_SECRET_SENTINEL;
    process.env.AMBIENT_SECRET_SENTINEL = "must-not-reach-codex";
    const handle = await (async () => {
      try {
        return await runner.start({
          taskId: "task-1",
          prompt: "只回复连接正常",
          workspace: root,
          gatewaySocket,
          gatewayClient,
        });
      } finally {
        if (previousSentinel === undefined) {
          delete process.env.AMBIENT_SECRET_SENTINEL;
        } else {
          process.env.AMBIENT_SECRET_SENTINEL = previousSentinel;
        }
      }
    })();
    const events: unknown[] = [];
    const consuming = (async () => {
      for await (const event of handle.events) events.push(event);
    })();

    await expect(handle.result).resolves.toEqual({
      status: "SUCCEEDED",
      exitCode: 0,
      signal: null,
    });
    await consuming;
    expect(events).toHaveLength(4);
  });
});
