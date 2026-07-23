import { EventEmitter } from "node:events";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const fileSystemBarrier = vi.hoisted(() => ({
  afterClose: undefined as ((path: string) => void) | undefined,
  trackedSuffix: undefined as string | undefined,
  trackedLstatCalls: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const controlledLstat = new Proxy(actual.lstat, {
    apply(target, thisArgument, argumentsList) {
      const trackedSuffix = fileSystemBarrier.trackedSuffix;
      if (
        trackedSuffix !== undefined &&
        String(argumentsList[0]).endsWith(trackedSuffix)
      ) {
        fileSystemBarrier.trackedLstatCalls += 1;
      }
      return Reflect.apply(target, thisArgument, argumentsList);
    },
  });
  const controlledOpen = new Proxy(actual.open, {
    async apply(target, thisArgument, argumentsList) {
      const path = String(argumentsList[0]);
      const handle = await Reflect.apply(target, thisArgument, argumentsList);
      return new Proxy(handle, {
        get(fileHandle, property) {
          const value = Reflect.get(fileHandle, property, fileHandle);
          if (property === "close" && typeof value === "function") {
            return async () => {
              await Reflect.apply(value, fileHandle, []);
              const afterClose = fileSystemBarrier.afterClose;
              fileSystemBarrier.afterClose = undefined;
              afterClose?.(path);
            };
          }
          return typeof value === "function" ? value.bind(fileHandle) : value;
        },
      });
    },
  });
  return { ...actual, lstat: controlledLstat, open: controlledOpen };
});

import {
  createLarkCliRouteRegistry,
  createLarkCliRunner,
  type LarkCliChildProcess,
  type LarkCliReleaseEvidence,
  type LarkCliRoute,
} from "../src/lark-cli-runner.js";

const HASH = `sha256:${"a".repeat(64)}` as const;
const SCHEMA_HASH = `sha256:${"b".repeat(64)}` as const;
const SECRET = "private-message-body-secret-sentinel";
const roots: string[] = [];

class FakeChild extends EventEmitter implements LarkCliChildProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => {
    void _signal;
    return true;
  });

  finish(
    stdout: Buffer | string,
    code = 0,
    signal: NodeJS.Signals | null = null,
  ): void {
    queueMicrotask(() => {
      this.stdout.end(stdout);
      this.stderr.end();
      this.emit("close", code, signal);
    });
  }
}

type Fixture = Readonly<{
  root: string;
  homeDirectory: string;
  taskDirectory: string;
  releaseRoot: string;
  executable: string;
}>;

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "assistant-lark-runner-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const homeDirectory = join(root, "home");
  const taskDirectory = join(root, "task");
  const releaseRoot = join(root, "release");
  const privateBin = join(releaseRoot, "private-bin");
  mkdirSync(homeDirectory, { mode: 0o700 });
  mkdirSync(taskDirectory, { mode: 0o700 });
  mkdirSync(privateBin, { recursive: true, mode: 0o700 });
  chmodSync(releaseRoot, 0o700);
  chmodSync(privateBin, 0o700);
  const executable = join(privateBin, "lark-cli");
  writeFileSync(executable, "fixture", { mode: 0o500 });
  chmodSync(executable, 0o500);
  return Object.freeze({
    root: realpathSync(root),
    homeDirectory: realpathSync(homeDirectory),
    taskDirectory: realpathSync(taskDirectory),
    releaseRoot: realpathSync(releaseRoot),
    executable: realpathSync(executable),
  });
}

function releaseEvidence(
  fixture: Fixture,
  overrides: Partial<LarkCliReleaseEvidence> = {},
): LarkCliReleaseEvidence {
  return {
    version: 1,
    requestedPath: fixture.executable,
    realPath: fixture.executable,
    releaseRoot: fixture.releaseRoot,
    package: "@larksuite/cli",
    packageVersion: "1.0.72",
    expectedSha256: HASH,
    actualSha256: HASH,
    designatedRequirement: 'identifier "fixture.lark-cli"',
    signatureVerified: true,
    ownerUid: process.getuid?.() ?? 501,
    mode: 0o500,
    symlinkFree: true,
    profile: "executive-assistant",
    cliSchemaSha256: SCHEMA_HASH,
    ...overrides,
  };
}

function exactBody(value: unknown) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 1 ||
    typeof (value as { body?: unknown }).body !== "string"
  ) {
    throw new Error("invalid body");
  }
  return { body: (value as { body: string }).body };
}

function routes(): readonly LarkCliRoute[] {
  return [
    {
      identity: "bot",
      operation: "message.send",
      effect: "write",
      parsePayload: exactBody,
      buildInvocation: (payload) => ({
        operationArgs: ["api", "POST", "/open-apis/im/v1/messages"] as const,
        jsonInputs: [{ flag: "--data", value: payload }] as const,
      }),
    },
    {
      identity: "user",
      operation: "minutes.search",
      effect: "read",
      parsePayload: exactBody,
      buildInvocation: () => ({
        operationArgs: ["minutes", "+search"] as const,
        jsonInputs: [] as const,
      }),
    },
  ] as const;
}

function request(operation: string, body = SECRET) {
  return {
    version: 1 as const,
    operation,
    payload: { body },
  };
}

function temporaryDirectories(fixture: Fixture): string[] {
  return readdirSync(fixture.taskDirectory)
    .filter((name) => name.startsWith(".lark-cli-"))
    .map((name) => join(fixture.taskDirectory, name));
}

afterEach(() => {
  fileSystemBarrier.afterClose = undefined;
  fileSystemBarrier.trackedSuffix = undefined;
  fileSystemBarrier.trackedLstatCalls = 0;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("fixed-identity lark-cli runner", () => {
  it("uses exact argv/env and an owner-only task-local JSON file", async () => {
    const fixture = createFixture();
    const child = new FakeChild();
    let observedInput = "";
    let observedInputPath = "";
    let childClosed = false;
    let verificationCount = 0;
    child.once("close", () => {
      childClosed = true;
    });
    const verifyRelease = vi.fn(async () => {
      verificationCount += 1;
      if (verificationCount === 1) {
        expect(temporaryDirectories(fixture)).toEqual([]);
      } else {
        expect(temporaryDirectories(fixture)).toHaveLength(1);
      }
      if (verificationCount === 3) {
        expect(childClosed).toBe(true);
      }
      return releaseEvidence(fixture);
    });
    const spawn = vi.fn((_command, args, options) => {
      expect(verifyRelease).toHaveBeenCalledTimes(2);
      const dataIndex = (args as readonly string[]).indexOf("--data");
      const reference = (args as readonly string[])[dataIndex + 1]!;
      expect(reference.startsWith("@")).toBe(true);
      const relativePath = reference.slice(1);
      observedInputPath = join(options.cwd as string, relativePath);
      observedInput = readFileSync(observedInputPath, "utf8");
      expect(lstatSync(observedInputPath).mode & 0o7777).toBe(0o600);
      expect(lstatSync(dirname(observedInputPath)).mode & 0o7777).toBe(0o700);
      child.finish('{"ok":true}');
      return child;
    });
    const runner = createLarkCliRunner({
      executable: fixture.executable,
      homeDirectory: fixture.homeDirectory,
      taskDirectory: fixture.taskDirectory,
      registry: createLarkCliRouteRegistry(routes()),
      verifyRelease,
      spawn,
    });

    await expect(runner.runBot(request("message.send"))).resolves.toEqual({
      state: "SUCCEEDED",
      value: { ok: true },
    });

    expect(verifyRelease).toHaveBeenCalledTimes(3);
    expect(spawn).toHaveBeenCalledOnce();
    const [command, args, options] = spawn.mock.calls[0]!;
    expect(command).toBe(fixture.executable);
    expect(args).toEqual([
      "api",
      "POST",
      "/open-apis/im/v1/messages",
      "--data",
      expect.stringMatching(/^@\.lark-cli-[^/]+\/data\.json$/),
      "--profile",
      "executive-assistant",
      "--as",
      "bot",
      "--format",
      "json",
    ]);
    expect(args.filter((item: string) => item === "--as")).toHaveLength(1);
    expect(args.filter((item: string) => item === "--profile")).toHaveLength(1);
    expect(args.filter((item: string) => item === "--format")).toHaveLength(1);
    expect(Object.isFrozen(args)).toBe(true);
    expect(Object.getPrototypeOf(options)).toBeNull();
    expect(Object.getPrototypeOf(options.env)).toBeNull();
    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.isFrozen(options.env)).toBe(true);
    expect(options).toEqual({
      cwd: fixture.taskDirectory,
      env: {
        HOME: fixture.homeDirectory,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "C",
        LC_ALL: "C",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    expect(JSON.stringify([command, args, options])).not.toContain(SECRET);
    expect(observedInput).toContain(SECRET);
    expect(existsSync(observedInputPath)).toBe(false);
    expect(temporaryDirectories(fixture)).toEqual([]);
  });

  it.each([
    ["identity", { identity: "user" }],
    ["argv", { argv: ["--as", "user"] }],
    ["profile", { profile: "other" }],
    ["method", { method: "DELETE" }],
    ["endpoint", { endpoint: "https://example.invalid" }],
    ["cwd", { cwd: "/tmp" }],
    ["env", { env: { TOKEN: "secret" } }],
    ["executable", { executable: "/tmp/lark-cli" }],
    ["timeout", { timeoutMs: 1 }],
  ])(
    "rejects caller supplied %s before verification or spawn",
    async (_name, extra) => {
      const fixture = createFixture();
      const verifyRelease = vi.fn(async () => releaseEvidence(fixture));
      const spawn = vi.fn();
      const runner = createLarkCliRunner({
        executable: fixture.executable,
        homeDirectory: fixture.homeDirectory,
        taskDirectory: fixture.taskDirectory,
        registry: createLarkCliRouteRegistry(routes()),
        verifyRelease,
        spawn,
      });

      await expect(
        runner.runBot({ ...request("message.send"), ...extra } as never),
      ).rejects.toThrow("invalid lark-cli request");
      expect(verifyRelease).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("rejects Proxy and accessor request fields without invoking them", async () => {
    const fixture = createFixture();
    const verifyRelease = vi.fn(async () => releaseEvidence(fixture));
    const spawn = vi.fn();
    const runner = createLarkCliRunner({
      executable: fixture.executable,
      homeDirectory: fixture.homeDirectory,
      taskDirectory: fixture.taskDirectory,
      registry: createLarkCliRouteRegistry(routes()),
      verifyRelease,
      spawn,
    });
    const proxyGet = vi.fn(Reflect.get);
    const proxy = new Proxy(request("message.send"), { get: proxyGet });
    const getter = vi.fn(() => ({ body: SECRET }));
    const accessor = Object.defineProperty(
      {
        version: 1,
        operation: "message.send",
      },
      "payload",
      { enumerable: true, get: getter },
    );

    await expect(runner.runBot(proxy)).rejects.toThrow(
      "invalid lark-cli request",
    );
    await expect(runner.runBot(accessor as never)).rejects.toThrow(
      "invalid lark-cli request",
    );
    expect(proxyGet).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    expect(verifyRelease).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects unknown and wrong-identity operations before release or filesystem work", async () => {
    const fixture = createFixture();
    const verifyRelease = vi.fn(async () => releaseEvidence(fixture));
    const spawn = vi.fn();
    const runner = createLarkCliRunner({
      executable: fixture.executable,
      homeDirectory: fixture.homeDirectory,
      taskDirectory: fixture.taskDirectory,
      registry: createLarkCliRouteRegistry(routes()),
      verifyRelease,
      spawn,
    });

    await expect(runner.runBot(request("minutes.search"))).rejects.toThrow(
      "lark-cli operation denied",
    );
    await expect(runner.runBot(request("unknown.operation"))).rejects.toThrow(
      "lark-cli operation denied",
    );
    expect(verifyRelease).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(relative(fixture.taskDirectory, fixture.root)).not.toBe("");
  });

  it("requires an owner-only HOME before release verification or spawn", async () => {
    const fixture = createFixture();
    chmodSync(fixture.homeDirectory, 0o755);
    const verifyRelease = vi.fn(async () => releaseEvidence(fixture));
    const spawn = vi.fn();
    const runner = createLarkCliRunner({
      executable: fixture.executable,
      homeDirectory: fixture.homeDirectory,
      taskDirectory: fixture.taskDirectory,
      registry: createLarkCliRouteRegistry(routes()),
      verifyRelease,
      spawn,
    });

    await expect(runner.runBot(request("message.send"))).resolves.toEqual({
      state: "FAILED",
      code: "EXECUTABLE_REJECTED",
    });
    expect(verifyRelease).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(temporaryDirectories(fixture)).toEqual([]);
  });

  it("re-verifies identical release evidence after materialization and cleans on pre-spawn drift", async () => {
    const fixture = createFixture();
    const verifyRelease = vi
      .fn()
      .mockResolvedValueOnce(releaseEvidence(fixture))
      .mockResolvedValueOnce(
        releaseEvidence(fixture, {
          actualSha256: `sha256:${"c".repeat(64)}`,
        }),
      );
    const spawn = vi.fn();
    const runner = createLarkCliRunner({
      executable: fixture.executable,
      homeDirectory: fixture.homeDirectory,
      taskDirectory: fixture.taskDirectory,
      registry: createLarkCliRouteRegistry(routes()),
      verifyRelease,
      spawn,
    });

    await expect(runner.runBot(request("message.send"))).resolves.toEqual({
      state: "FAILED",
      code: "EXECUTABLE_REJECTED",
    });
    expect(verifyRelease).toHaveBeenCalledTimes(2);
    expect(spawn).not.toHaveBeenCalled();
    expect(temporaryDirectories(fixture)).toEqual([]);
  });

  it("finishes input verification before the final release check and synchronously enters spawn", async () => {
    const fixture = createFixture();
    const child = new FakeChild();
    let verificationCount = 0;
    let yieldedAfterFinalReleaseCheck = false;
    fileSystemBarrier.trackedSuffix = "/data.json";
    const verifyRelease = vi.fn(async () => {
      verificationCount += 1;
      if (verificationCount === 2) {
        expect(fileSystemBarrier.trackedLstatCalls).toBeGreaterThanOrEqual(3);
        setImmediate(() => {
          yieldedAfterFinalReleaseCheck = true;
        });
      }
      return releaseEvidence(fixture);
    });
    const spawn = vi.fn(() => {
      expect(yieldedAfterFinalReleaseCheck).toBe(false);
      child.finish('{"ok":true}');
      return child;
    });
    const runner = createLarkCliRunner({
      executable: fixture.executable,
      homeDirectory: fixture.homeDirectory,
      taskDirectory: fixture.taskDirectory,
      registry: createLarkCliRouteRegistry(routes()),
      verifyRelease,
      spawn,
    });

    await expect(runner.runBot(request("message.send"))).resolves.toEqual({
      state: "SUCCEEDED",
      value: { ok: true },
    });
    expect(verifyRelease).toHaveBeenCalledTimes(3);
    expect(spawn).toHaveBeenCalledOnce();
    expect(temporaryDirectories(fixture)).toEqual([]);
  });

  it("blocks spawn when the final release verifier mutates the materialized JSON", async () => {
    const fixture = createFixture();
    let verificationCount = 0;
    const verifyRelease = vi.fn(async () => {
      verificationCount += 1;
      if (verificationCount === 2) {
        const [temporaryDirectory] = temporaryDirectories(fixture);
        expect(temporaryDirectory).toBeDefined();
        appendFileSync(join(temporaryDirectory!, "data.json"), " ");
      }
      return releaseEvidence(fixture);
    });
    const spawn = vi.fn();
    const runner = createLarkCliRunner({
      executable: fixture.executable,
      homeDirectory: fixture.homeDirectory,
      taskDirectory: fixture.taskDirectory,
      registry: createLarkCliRouteRegistry(routes()),
      verifyRelease,
      spawn,
    });

    await expect(runner.runBot(request("message.send"))).resolves.toEqual({
      state: "FAILED",
      code: "OUTPUT_INVALID",
    });
    expect(verifyRelease).toHaveBeenCalledTimes(2);
    expect(spawn).not.toHaveBeenCalled();
    expect(temporaryDirectories(fixture)).toEqual([]);
  });

  it("rejects replacement between descriptor close and path capture", async () => {
    const fixture = createFixture();
    const child = new FakeChild();
    const spawn = vi.fn(() => {
      child.finish('{"ok":true}');
      return child;
    });
    fileSystemBarrier.afterClose = (path) => {
      if (!path.endsWith("/data.json")) return;
      unlinkSync(path);
      writeFileSync(path, '{"replacement":true}', { mode: 0o600 });
    };
    const runner = createLarkCliRunner({
      executable: fixture.executable,
      homeDirectory: fixture.homeDirectory,
      taskDirectory: fixture.taskDirectory,
      registry: createLarkCliRouteRegistry(routes()),
      verifyRelease: vi.fn(async () => releaseEvidence(fixture)),
      spawn,
    });

    await expect(runner.runBot(request("message.send"))).resolves.toEqual({
      state: "FAILED",
      code: "OUTPUT_INVALID",
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(temporaryDirectories(fixture)).toEqual([]);
  });

  it("fails closed before spawn and returns UNKNOWN for post-close write evidence drift", async () => {
    const fixture = createFixture();
    const invalidVerifier = vi.fn(async () =>
      releaseEvidence(fixture, { signatureVerified: false }),
    );
    const spawn = vi.fn();
    const rejected = createLarkCliRunner({
      executable: fixture.executable,
      homeDirectory: fixture.homeDirectory,
      taskDirectory: fixture.taskDirectory,
      registry: createLarkCliRouteRegistry(routes()),
      verifyRelease: invalidVerifier,
      spawn,
    });

    await expect(rejected.runBot(request("message.send"))).resolves.toEqual({
      state: "FAILED",
      code: "EXECUTABLE_REJECTED",
    });
    expect(spawn).not.toHaveBeenCalled();

    const child = new FakeChild();
    const verifyRelease = vi
      .fn()
      .mockResolvedValueOnce(releaseEvidence(fixture))
      .mockResolvedValueOnce(releaseEvidence(fixture))
      .mockResolvedValueOnce(
        releaseEvidence(fixture, {
          actualSha256: `sha256:${"c".repeat(64)}`,
        }),
      );
    const drifted = createLarkCliRunner({
      executable: fixture.executable,
      homeDirectory: fixture.homeDirectory,
      taskDirectory: fixture.taskDirectory,
      registry: createLarkCliRouteRegistry(routes()),
      verifyRelease,
      spawn: vi.fn(() => {
        child.finish('{"ok":true}');
        return child;
      }),
    });

    await expect(drifted.runBot(request("message.send"))).resolves.toEqual({
      state: "UNKNOWN",
      code: "IO_AFTER_SPAWN",
    });
    expect(verifyRelease).toHaveBeenCalledTimes(3);
    expect(temporaryDirectories(fixture)).toEqual([]);
  });

  it("detects post-close input inode replacement and removes the known path", async () => {
    const fixture = createFixture();
    const child = new FakeChild();
    const spawn = vi.fn((_command, args, options) => {
      const dataIndex = (args as readonly string[]).indexOf("--data");
      const reference = (args as readonly string[])[dataIndex + 1]!;
      const inputPath = join(options.cwd, reference.slice(1));
      unlinkSync(inputPath);
      writeFileSync(inputPath, '{"replacement":true}', { mode: 0o600 });
      child.finish('{"ok":true}');
      return child;
    });
    const runner = createLarkCliRunner({
      executable: fixture.executable,
      homeDirectory: fixture.homeDirectory,
      taskDirectory: fixture.taskDirectory,
      registry: createLarkCliRouteRegistry(routes()),
      verifyRelease: vi.fn(async () => releaseEvidence(fixture)),
      spawn,
    });

    await expect(runner.runBot(request("message.send"))).resolves.toEqual({
      state: "UNKNOWN",
      code: "IO_AFTER_SPAWN",
    });
    expect(spawn).toHaveBeenCalledOnce();
    expect(temporaryDirectories(fixture)).toEqual([]);
  });

  it.each([
    [
      "size",
      (path: string) => {
        appendFileSync(path, " ");
      },
    ],
    [
      "mtime",
      (path: string) => {
        utimesSync(path, new Date(1_000), new Date(1_000));
      },
    ],
    [
      "ctime",
      (path: string) => {
        chmodSync(path, 0o400);
        chmodSync(path, 0o600);
      },
    ],
  ])(
    "detects post-spawn same-inode %s drift",
    async (_metadata, mutateInput) => {
      const fixture = createFixture();
      const child = new FakeChild();
      const spawn = vi.fn((_command, args, options) => {
        const dataIndex = (args as readonly string[]).indexOf("--data");
        const reference = (args as readonly string[])[dataIndex + 1]!;
        const inputPath = join(options.cwd, reference.slice(1));
        mutateInput(inputPath);
        child.finish('{"ok":true}');
        return child;
      });
      const runner = createLarkCliRunner({
        executable: fixture.executable,
        homeDirectory: fixture.homeDirectory,
        taskDirectory: fixture.taskDirectory,
        registry: createLarkCliRouteRegistry(routes()),
        verifyRelease: vi.fn(async () => releaseEvidence(fixture)),
        spawn,
      });

      await expect(runner.runBot(request("message.send"))).resolves.toEqual({
        state: "UNKNOWN",
        code: "IO_AFTER_SPAWN",
      });
      expect(spawn).toHaveBeenCalledOnce();
      expect(temporaryDirectories(fixture)).toEqual([]);
    },
  );

  it.each([
    ["invalid UTF-8", Buffer.from([0xc0, 0xaf])],
    ["duplicate key", '{"ok":true,"ok":false}'],
    ["trailing JSON", '{"ok":true}{}'],
  ])("rejects %s without exposing raw output", async (_name, output) => {
    const fixture = createFixture();
    const child = new FakeChild();
    const runner = createLarkCliRunner({
      executable: fixture.executable,
      homeDirectory: fixture.homeDirectory,
      taskDirectory: fixture.taskDirectory,
      registry: createLarkCliRouteRegistry(routes()),
      verifyRelease: vi.fn(async () => releaseEvidence(fixture)),
      spawn: vi.fn(() => {
        child.finish(output);
        return child;
      }),
    });

    await expect(runner.runUser(request("minutes.search"))).resolves.toEqual({
      state: "FAILED",
      code: "OUTPUT_INVALID",
    });
  });

  it("bounds combined raw output before UTF-8 decoding", async () => {
    const fixture = createFixture();
    const child = new FakeChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.write(Buffer.alloc(8 * 1024 * 1024, 0x20));
        child.stderr.write(Buffer.from([0x20]));
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 1, null);
      });
      return child;
    });
    const runner = createLarkCliRunner({
      executable: fixture.executable,
      homeDirectory: fixture.homeDirectory,
      taskDirectory: fixture.taskDirectory,
      registry: createLarkCliRouteRegistry(routes()),
      verifyRelease: vi.fn(async () => releaseEvidence(fixture)),
      spawn,
    });

    await expect(runner.runUser(request("minutes.search"))).resolves.toEqual({
      state: "FAILED",
      code: "OUTPUT_LIMIT",
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it.each([
    [
      "a throwing spawn",
      () => {
        throw new Error("spawn fixture failure");
      },
    ],
    ["an invalid child", () => ({}) as never],
  ])(
    "best-effort cleans inputs after %s",
    async (_name, spawnImplementation) => {
      const fixture = createFixture();
      const runner = createLarkCliRunner({
        executable: fixture.executable,
        homeDirectory: fixture.homeDirectory,
        taskDirectory: fixture.taskDirectory,
        registry: createLarkCliRouteRegistry(routes()),
        verifyRelease: vi.fn(async () => releaseEvidence(fixture)),
        spawn: vi.fn(spawnImplementation),
      });

      await expect(runner.runBot(request("message.send"))).resolves.toEqual({
        state: "FAILED",
        code: "SPAWN_FAILED",
      });
      expect(temporaryDirectories(fixture)).toEqual([]);
    },
  );

  it("uses TERM then KILL and reports a timed-out write as UNKNOWN", async () => {
    const fixture = createFixture();
    const child = new FakeChild();
    child.kill.mockImplementation((signal?: NodeJS.Signals) => {
      if (signal === "SIGKILL") child.finish("", null as never, "SIGKILL");
      return true;
    });
    const runner = createLarkCliRunner({
      executable: fixture.executable,
      homeDirectory: fixture.homeDirectory,
      taskDirectory: fixture.taskDirectory,
      registry: createLarkCliRouteRegistry(routes()),
      verifyRelease: vi.fn(async () => releaseEvidence(fixture)),
      spawn: vi.fn(() => child),
      timeoutMs: 10,
      killGraceMs: 10,
      closeConfirmationMs: 25,
    });

    await expect(runner.runBot(request("message.send"))).resolves.toEqual({
      state: "UNKNOWN",
      code: "TIMEOUT",
    });
    expect(child.kill.mock.calls.map((call) => call[0])).toEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
    expect(temporaryDirectories(fixture)).toEqual([]);
  });

  it("does not turn an unconfirmed kill into a normal failure and best-effort cleans inputs", async () => {
    const fixture = createFixture();
    const child = new FakeChild();
    const runner = createLarkCliRunner({
      executable: fixture.executable,
      homeDirectory: fixture.homeDirectory,
      taskDirectory: fixture.taskDirectory,
      registry: createLarkCliRouteRegistry(routes()),
      verifyRelease: vi.fn(async () => releaseEvidence(fixture)),
      spawn: vi.fn(() => child),
      timeoutMs: 5,
      killGraceMs: 5,
      closeConfirmationMs: 5,
    });

    await expect(runner.runBot(request("message.send"))).resolves.toEqual({
      state: "UNKNOWN",
      code: "TERMINATION_UNCONFIRMED",
    });
    expect(child.kill.mock.calls.map((call) => call[0])).toEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
    expect(temporaryDirectories(fixture)).toEqual([]);
  });

  it.each([
    ["write", "bot", { state: "UNKNOWN", code: "IO_AFTER_SPAWN" }],
    ["read", "user", { state: "FAILED", code: "OUTPUT_INVALID" }],
  ] as const)(
    "does not recursively remove unexpected temporary-directory contents and reports %s cleanup failure",
    async (effect, identity, expected) => {
      const fixture = createFixture();
      const child = new FakeChild();
      let unexpectedPath = "";
      const spawn = vi.fn((_command, args, options) => {
        const dataIndex = (args as readonly string[]).indexOf("--data");
        const reference = (args as readonly string[])[dataIndex + 1]!;
        const inputPath = join(options.cwd, reference.slice(1));
        unexpectedPath = join(dirname(inputPath), "unexpected");
        writeFileSync(unexpectedPath, "do-not-recursively-delete", {
          mode: 0o600,
        });
        child.finish('{"ok":true}');
        return child;
      });
      const cleanupFailureRoute: LarkCliRoute = {
        identity,
        operation: "cleanup.failure",
        effect,
        parsePayload: exactBody,
        buildInvocation: (payload) => ({
          operationArgs: ["fixture", "cleanup"],
          jsonInputs: [{ flag: "--data", value: payload }],
        }),
      };
      const runner = createLarkCliRunner({
        executable: fixture.executable,
        homeDirectory: fixture.homeDirectory,
        taskDirectory: fixture.taskDirectory,
        registry: createLarkCliRouteRegistry([cleanupFailureRoute]),
        verifyRelease: vi.fn(async () => releaseEvidence(fixture)),
        spawn,
      });

      const result =
        identity === "bot"
          ? runner.runBot(request("cleanup.failure"))
          : runner.runUser(request("cleanup.failure"));
      await expect(result).resolves.toEqual(expected);
      expect(existsSync(unexpectedPath)).toBe(true);
      expect(temporaryDirectories(fixture)).toHaveLength(1);
    },
  );

  it.each([
    "--",
    "--as",
    "--as=user",
    "--profile",
    "--profile=other",
    "--format",
    "--format=text",
    "--data",
    "--data=@attacker.json",
    "--params",
    "--params=@attacker.json",
  ])(
    "rejects reserved builder token %s before release verification or spawn",
    async (reservedToken) => {
      const fixture = createFixture();
      const unsafeRoute: LarkCliRoute = {
        identity: "bot",
        operation: "unsafe",
        effect: "read",
        parsePayload: exactBody,
        buildInvocation: () => ({
          operationArgs: ["auth", "status", reservedToken, "attacker-value"],
          jsonInputs: [],
        }),
      };
      const verifyRelease = vi.fn(async () => releaseEvidence(fixture));
      const spawn = vi.fn();
      const runner = createLarkCliRunner({
        executable: fixture.executable,
        homeDirectory: fixture.homeDirectory,
        taskDirectory: fixture.taskDirectory,
        registry: createLarkCliRouteRegistry([unsafeRoute]),
        verifyRelease,
        spawn,
      });

      await expect(runner.runBot(request("unsafe"))).resolves.toEqual({
        state: "FAILED",
        code: "OUTPUT_INVALID",
      });
      expect(verifyRelease).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(temporaryDirectories(fixture)).toEqual([]);
    },
  );
});
