import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createProductionCodexRunner } from "../src/codex-runner.js";

const SESSION_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a21";
const RUN_INPUT = Object.freeze({
  taskId: "task-1",
  prompt: "整理材料",
  workspace: "/private/runtime/jobs/task-1",
  gatewaySocket: "/private/runtime/jobs/task-1/gateway.sock",
  gatewayClient: "/private/runtime/bin/assistant-gateway",
});

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn<(signal: NodeJS.Signals) => boolean>>;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => true);
  child.stdin.resume();
  return child;
}

function runnerFor(child: FakeChild) {
  return createProductionCodexRunner({
    nodePath: "/usr/local/bin/node",
    codexPath: "/usr/local/bin/codex",
    codexHome: "/private/runtime/codex-home",
    spawn: () => child as unknown as ChildProcessWithoutNullStreams,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("production Codex runner hardening", () => {
  it("accepts a complete valid turn only after stdin finish and close(0)", async () => {
    const child = fakeChild();
    const handle = await runnerFor(child).start(RUN_INPUT);
    child.stdout.write(
      [
        JSON.stringify({
          type: "thread.started",
          thread_id: SESSION_ID,
        }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            output_tokens: 1,
            reasoning_output_tokens: 0,
          },
        }),
      ].join("\n") + "\n",
    );
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);

    expect(await handle.result).toEqual({
      status: "SUCCEEDED",
      exitCode: 0,
      signal: null,
    });
  });

  it("rejects a non-canonical resume session before spawning", async () => {
    const child = fakeChild();
    const runner = runnerFor(child);

    await expect(
      runner.start({
        ...RUN_INPUT,
        sessionId: SESSION_ID.toUpperCase(),
      }),
    ).rejects.toThrow("SESSION_ID_INVALID");
  });

  it("rejects malformed UTF-8 before JSON parsing", async () => {
    const child = fakeChild();
    const handle = await runnerFor(child).start(RUN_INPUT);

    child.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));
    child.stdout.end();
    child.stderr.end();
    child.emit("close", null, "SIGTERM");

    await expect(handle.result).resolves.toMatchObject({
      status: "FAILED",
      reason: "invalid_output",
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects a JSONL line above 1 MiB before decoding it", async () => {
    const child = fakeChild();
    const handle = await runnerFor(child).start(RUN_INPUT);

    child.stdout.write(Buffer.alloc(1024 * 1024 + 1, 0x61));
    child.stdout.end();
    child.stderr.end();
    child.emit("close", null, "SIGTERM");

    await expect(handle.result).resolves.toMatchObject({
      status: "FAILED",
      reason: "invalid_output",
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("requires stdin finish as well as turn.completed and close(0)", async () => {
    class BlockedFinalStdin extends PassThrough {
      finalCallback: ((error?: Error | null) => void) | undefined;

      override _final(callback: (error?: Error | null) => void): void {
        this.finalCallback = callback;
      }
    }
    const child = fakeChild();
    child.stdin = new BlockedFinalStdin();
    child.stdin.resume();
    const handle = await runnerFor(child).start(RUN_INPUT);
    child.stdout.end(
      [
        JSON.stringify({
          type: "thread.started",
          thread_id: SESSION_ID,
        }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            output_tokens: 1,
            reasoning_output_tokens: 0,
          },
        }),
      ].join("\n") + "\n",
    );
    child.stderr.end();
    child.emit("close", 0, null);

    await expect(handle.result).resolves.toMatchObject({
      status: "FAILED",
      reason: "invalid_output",
    });
    (child.stdin as BlockedFinalStdin).finalCallback?.();
  });

  it("waits for child close and escalates TERM to KILL after 10 seconds", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const handle = await runnerFor(child).start(RUN_INPUT);
    let stopResolved = false;
    const stopping = handle.stop().then(() => {
      stopResolved = true;
    });

    await Promise.resolve();
    expect(stopResolved).toBe(false);
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(stopResolved).toBe(false);

    child.emit("close", null, "SIGKILL");
    await stopping;
    await vi.advanceTimersByTimeAsync(0);
    await expect(handle.result).resolves.toMatchObject({
      status: "FAILED",
      reason: "stopped",
    });
  });

  it("terminates a child after 30 minutes without output", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const handle = await runnerFor(child).start(RUN_INPUT);

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(0);

    await expect(handle.result).resolves.toMatchObject({
      status: "FAILED",
      reason: "invalid_output",
    });
  });
});
