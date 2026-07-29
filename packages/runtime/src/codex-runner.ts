import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";

import type {
  CodexRunEvent,
  CodexRunHandle,
  CodexRunInput,
  CodexRunner,
  CodexRunResult,
} from "./types.js";

const MINIMAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const STOP_GRACE_MS = 10_000;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_EVENT_LINE_BYTES = 1024 * 1024;
const MAX_QUEUED_EVENTS = 256;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KNOWN_ITEM_TYPES = new Set([
  "agent_message",
  "reasoning",
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
  "todo_list",
  "collab_tool_call",
]);

type Spawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & {
    stdio: readonly ["pipe", "pipe", "pipe"];
    shell: false;
  },
) => ChildProcessWithoutNullStreams;

export type ProductionCodexRunnerOptions = Readonly<{
  nodePath: string;
  codexPath: string;
  codexHome: string;
  repositoryRoot: string;
  runtimeRoot: string;
  spawn?: Spawn;
}>;

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): boolean {
    if (this.#closed) return false;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return true;
    }
    if (this.#values.length >= MAX_QUEUED_EVENTS) return false;
    this.#values.push(value);
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) {
          return Promise.resolve({ done: false, value });
        }
        if (this.#closed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.#waiters.push(resolve);
        });
      },
    };
  }
}

function assertAbsolutePath(value: string, label: string): void {
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${label.toUpperCase()}_INVALID`);
  }
}

function isRunEvent(value: unknown): value is CodexRunEvent {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

function usageIsValid(value: unknown): boolean {
  if (!isRunEvent(value)) return false;
  return [
    value.input_tokens,
    value.cached_input_tokens,
    value.output_tokens,
    value.reasoning_output_tokens,
  ].every((count) => Number.isSafeInteger(count) && Number(count) >= 0);
}

function itemIsValid(value: unknown): boolean {
  if (!isRunEvent(value)) return false;
  return (
    boundedString(value.id, 256) &&
    /^[A-Za-z0-9._:-]+$/.test(value.id) &&
    typeof value.type === "string" &&
    KNOWN_ITEM_TYPES.has(value.type)
  );
}

function failureIsValid(value: unknown): boolean {
  return (
    isRunEvent(value) &&
    boundedString(value.message, 4096) &&
    !value.message.includes("\0")
  );
}

function createJsonlProtocol(expectedSessionId: string | undefined): {
  accept(value: unknown): CodexRunEvent | null;
  hasSuccessTerminal(): boolean;
} {
  let state:
    | "expect_thread"
    | "expect_turn"
    | "in_turn"
    | "succeeded"
    | "failed" = "expect_thread";
  return Object.freeze({
    accept(value: unknown): CodexRunEvent | null {
      if (
        !isRunEvent(value) ||
        typeof value.type !== "string" ||
        state === "succeeded" ||
        state === "failed"
      ) {
        return null;
      }
      switch (value.type) {
        case "thread.started":
          if (
            state !== "expect_thread" ||
            typeof value.thread_id !== "string" ||
            !CANONICAL_UUID.test(value.thread_id) ||
            (expectedSessionId !== undefined &&
              value.thread_id !== expectedSessionId)
          ) {
            return null;
          }
          state = "expect_turn";
          return value;
        case "turn.started":
          if (state !== "expect_turn") return null;
          state = "in_turn";
          return value;
        case "item.started":
        case "item.updated":
        case "item.completed":
          return state === "in_turn" && itemIsValid(value.item) ? value : null;
        case "turn.completed":
          if (state !== "in_turn" || !usageIsValid(value.usage)) {
            return null;
          }
          state = "succeeded";
          return value;
        case "turn.failed":
          if (
            state !== "in_turn" ||
            !isRunEvent(value.error) ||
            !failureIsValid(value.error)
          ) {
            return null;
          }
          state = "failed";
          return null;
        case "error":
          return state === "in_turn" && failureIsValid(value)
            ? Object.freeze({ type: "error" })
            : null;
        default:
          return null;
      }
    },
    hasSuccessTerminal(): boolean {
      return state === "succeeded";
    },
  });
}

function commandArguments(
  sessionId: string | undefined,
  gatewaySocket: string,
): readonly string[] {
  const permissionProfile =
    `permissions.assistant-task={extends=":workspace",network={` +
    "enabled=true," +
    'mode="limited",' +
    "allow_local_binding=false," +
    "enable_socks5=false," +
    "enable_socks5_udp=false," +
    "allow_upstream_proxy=false," +
    "dangerously_allow_non_loopback_proxy=false," +
    "dangerously_allow_all_unix_sockets=false," +
    `unix_sockets={${JSON.stringify(gatewaySocket)}="allow"}}}`;
  const prefix = [
    "--ask-for-approval",
    "never",
    "--enable",
    "network_proxy",
    "-c",
    'default_permissions="assistant-task"',
    "-c",
    permissionProfile,
    "exec",
  ] as const;
  return Object.freeze(
    sessionId
      ? [
          ...prefix,
          "resume",
          sessionId,
          "--strict-config",
          "--json",
          "--skip-git-repo-check",
          "-",
        ]
      : [...prefix, "--strict-config", "--json", "--skip-git-repo-check", "-"],
  );
}

function failure(
  reason: Extract<CodexRunResult, { status: "FAILED" }>["reason"],
  exitCode: number | null = null,
  signal: NodeJS.Signals | null = null,
): CodexRunResult {
  return Object.freeze({
    status: "FAILED",
    exitCode,
    signal,
    reason,
  });
}

function createRawJsonlParser(
  accept: (value: unknown) => boolean,
  invalidate: () => void,
): Readonly<{
  push(chunk: Buffer): void;
  finish(): void;
}> {
  let parts: Buffer[] = [];
  let lineBytes = 0;
  let invalid = false;
  let finished = false;

  const reject = (): void => {
    if (invalid) return;
    invalid = true;
    parts = [];
    lineBytes = 0;
    invalidate();
  };

  const parseLine = (): void => {
    if (invalid) return;
    let bytes =
      parts.length === 1 ? parts[0]! : Buffer.concat(parts, lineBytes);
    parts = [];
    lineBytes = 0;
    if (bytes.length > 0 && bytes[bytes.length - 1] === 0x0d) {
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    if (bytes.length === 0) {
      reject();
      return;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!accept(JSON.parse(text) as unknown)) reject();
    } catch {
      reject();
    }
  };

  return Object.freeze({
    push(chunk: Buffer): void {
      if (invalid || finished) return;
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline === -1 ? chunk.length : newline;
        const part = chunk.subarray(offset, end);
        if (lineBytes + part.length > MAX_EVENT_LINE_BYTES) {
          reject();
          return;
        }
        if (part.length > 0) {
          parts.push(part);
          lineBytes += part.length;
        }
        if (newline === -1) return;
        parseLine();
        if (invalid) return;
        offset = newline + 1;
      }
    },
    finish(): void {
      if (invalid || finished) return;
      finished = true;
      if (lineBytes > 0) parseLine();
    },
  });
}

export function createProductionCodexRunner(
  options: ProductionCodexRunnerOptions,
): CodexRunner {
  assertAbsolutePath(options.nodePath, "node path");
  assertAbsolutePath(options.codexPath, "codex path");
  assertAbsolutePath(options.codexHome, "codex home");
  assertAbsolutePath(options.repositoryRoot, "repository root");
  assertAbsolutePath(options.runtimeRoot, "runtime root");
  const spawn = options.spawn ?? (nodeSpawn as Spawn);

  return Object.freeze({
    async start(input: CodexRunInput): Promise<CodexRunHandle> {
      assertAbsolutePath(input.workspace, "workspace");
      assertAbsolutePath(input.gatewaySocket, "gateway socket");
      assertAbsolutePath(input.gatewayClient, "gateway client");
      if (
        input.sessionId !== undefined &&
        !CANONICAL_UUID.test(input.sessionId)
      ) {
        throw new Error("SESSION_ID_INVALID");
      }
      const queue = new AsyncQueue<CodexRunEvent>();
      const env = Object.freeze({
        PATH: MINIMAL_PATH,
        CODEX_HOME: options.codexHome,
        ASSISTANT_GATEWAY_SOCKET: input.gatewaySocket,
        ASSISTANT_GATEWAY_CLIENT: input.gatewayClient,
        ASSISTANT_NODE_PATH: options.nodePath,
        ASSISTANT_REPOSITORY_ROOT: options.repositoryRoot,
        ASSISTANT_RUNTIME_ROOT: options.runtimeRoot,
        LANG: "zh_CN.UTF-8",
        LC_ALL: "zh_CN.UTF-8",
      });
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(
          options.nodePath,
          [
            options.codexPath,
            ...commandArguments(input.sessionId, input.gatewaySocket),
          ],
          {
            cwd: input.workspace,
            env,
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
      } catch {
        queue.close();
        return Object.freeze({
          events: queue,
          result: Promise.resolve(failure("spawn_error")),
          async stop() {},
        });
      }

      let stopped = false;
      let invalidOutput = false;
      let spawnErrored = false;
      let settled = false;
      let stdinFinished = false;
      let stdoutFinished = false;
      let stopTimer: NodeJS.Timeout | undefined;
      let idleTimer: NodeJS.Timeout | undefined;
      let resolveClosed: () => void = () => undefined;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const protocol = createJsonlProtocol(input.sessionId);
      let resolveResult: (result: CodexRunResult) => void = () => undefined;
      const result = new Promise<CodexRunResult>((resolve) => {
        resolveResult = resolve;
      });
      const settle = (outcome: CodexRunResult): void => {
        if (settled) return;
        settled = true;
        if (stopTimer) clearTimeout(stopTimer);
        if (idleTimer) clearTimeout(idleTimer);
        queue.close();
        resolveResult(outcome);
      };

      const terminate = (reason: "stopped" | "invalid_output"): void => {
        if (settled) return;
        if (reason === "stopped") stopped = true;
        else invalidOutput = true;
        child.kill("SIGTERM");
        if (stopTimer === undefined) {
          stopTimer = setTimeout(() => {
            if (!settled) child.kill("SIGKILL");
          }, STOP_GRACE_MS);
          stopTimer.unref();
        }
      };
      const invalidate = (): void => {
        if (invalidOutput) return;
        terminate("invalid_output");
      };
      const resetIdleTimer = (): void => {
        if (settled || invalidOutput || stopped) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          invalidate();
        }, IDLE_TIMEOUT_MS);
        idleTimer.unref();
      };
      const parser = createRawJsonlParser((parsed) => {
        const accepted = protocol.accept(parsed);
        return accepted !== null && queue.push(Object.freeze(accepted));
      }, invalidate);

      resetIdleTimer();
      child.stdout.on("data", (chunk: Buffer | string) => {
        resetIdleTimer();
        parser.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.stdout.on("end", () => {
        stdoutFinished = true;
        parser.finish();
      });
      child.stdout.on("error", invalidate);
      child.stderr.on("data", () => {
        resetIdleTimer();
      });
      child.stderr.on("error", invalidate);
      child.on("error", () => {
        spawnErrored = true;
      });
      child.on("close", (exitCode, signal) => {
        if (!stdoutFinished) {
          stdoutFinished = true;
          parser.finish();
        }
        resolveClosed();
        if (stopTimer) clearTimeout(stopTimer);
        if (idleTimer) clearTimeout(idleTimer);
        // A ChildProcess "close" notification and the writable "finish"
        // callback can be queued in the same turn. Defer classification once
        // so a completed stdin flush is observed, while still refusing
        // success when "finish" never occurs.
        setImmediate(() => {
          if (stopped) {
            settle(failure("stopped", exitCode, signal));
          } else if (spawnErrored) {
            settle(failure("spawn_error", exitCode, signal));
          } else if (
            invalidOutput ||
            !stdinFinished ||
            !protocol.hasSuccessTerminal()
          ) {
            settle(failure("invalid_output", exitCode, signal));
          } else if (signal !== null) {
            settle(failure("signal_exit", exitCode, signal));
          } else if (exitCode !== 0) {
            settle(failure("non_zero_exit", exitCode));
          } else {
            settle(
              Object.freeze({
                status: "SUCCEEDED",
                exitCode: 0,
                signal: null,
              }),
            );
          }
        });
      });
      child.stdin.on("finish", () => {
        stdinFinished = true;
      });
      child.stdin.on("error", invalidate);
      try {
        child.stdin.end(input.prompt, "utf8");
      } catch {
        invalidate();
      }

      return Object.freeze({
        events: queue,
        result,
        async stop(): Promise<void> {
          if (settled) return;
          if (!stopped && !invalidOutput) terminate("stopped");
          await closed;
        },
      });
    },
  });
}
