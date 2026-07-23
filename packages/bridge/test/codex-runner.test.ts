import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCodexRunner,
  type CodexChildProcess,
  type CodexRunEvent,
  type CodexRunnerDependencies,
} from "../src/agent/codex-runner.js";

const TASK_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a21";
const SESSION_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a22";
const WORKSPACE_ROOT = "/Users/test/PresidentAssistant/jobs";
const WORKSPACE = `${WORKSPACE_ROOT}/${TASK_ID}`;
const CODEX_PATH = "/opt/local/bin/codex";
const CODEX_HOME = "/Users/test/PresidentAssistant/runtime/codex-home";
const GATEWAY_SOCKET = `${WORKSPACE}/gateway.sock`;
const GATEWAY_CLIENT =
  "/Users/test/PresidentAssistant/runtime/current/public-bin/assistant-gateway";
const HASH = "a".repeat(64);
const REQUIRED_FEATURES = [
  "exec-json",
  "exec-resume-stdin",
  "approval-never",
  "permission-profiles",
  "network-proxy-unix-socket-allowlist",
] as const;
const THREAD_STARTED = { type: "thread.started", thread_id: SESSION_ID };
const TURN_STARTED = { type: "turn.started" };
const TURN_COMPLETED = {
  type: "turn.completed",
  usage: {
    input_tokens: 12,
    cached_input_tokens: 4,
    output_tokens: 3,
    reasoning_output_tokens: 2,
  },
};
const PERMISSIONS_CONFIG = `permissions.assistant-task={extends=":workspace",network={enabled=true,mode="limited",allow_local_binding=false,enable_socks5=false,enable_socks5_udp=false,allow_upstream_proxy=false,dangerously_allow_non_loopback_proxy=false,dangerously_allow_all_unix_sockets=false,unix_sockets={${JSON.stringify(GATEWAY_SOCKET)}="allow"}}}`;

const NEW_ARGS = [
  "--ask-for-approval",
  "never",
  "--enable",
  "network_proxy",
  "-c",
  'default_permissions="assistant-task"',
  "-c",
  PERMISSIONS_CONFIG,
  "exec",
  "--strict-config",
  "--json",
  "--skip-git-repo-check",
  "-",
];

const RESUME_ARGS = [
  "--ask-for-approval",
  "never",
  "--enable",
  "network_proxy",
  "-c",
  'default_permissions="assistant-task"',
  "-c",
  PERMISSIONS_CONFIG,
  "exec",
  "resume",
  SESSION_ID,
  "--strict-config",
  "--json",
  "--skip-git-repo-check",
  "-",
];

class FakeChild extends EventEmitter implements CodexChildProcess {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kills: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(stdin: Writable = new PassThrough()) {
    super();
    this.stdin = stdin;
  }

  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal);
    return true;
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

function validDependencies(child = new FakeChild()): CodexRunnerDependencies & {
  spawn: ReturnType<typeof vi.fn>;
  verifyCodexBinary: ReturnType<typeof vi.fn>;
  verifyCodexHome: ReturnType<typeof vi.fn>;
  verifyGatewayRelease: ReturnType<typeof vi.fn>;
  resolveWorkspace: ReturnType<typeof vi.fn>;
  lstatGatewaySocket: ReturnType<typeof vi.fn>;
} {
  return {
    codexPath: CODEX_PATH,
    codexHome: CODEX_HOME,
    workspaceRoot: WORKSPACE_ROOT,
    spawn: vi.fn(() => child),
    resolveWorkspace: vi.fn(async () => WORKSPACE),
    verifyCodexBinary: vi.fn(async (path: string) => ({
      path,
      version: "0.142.0" as const,
      executable: true as const,
      features: REQUIRED_FEATURES,
    })),
    verifyCodexHome: vi.fn(async (path: string) => ({
      requestedPath: path,
      realPath: path,
      directory: true as const,
      symlinkFree: true as const,
      mode: 0o700,
      permissionProfileCompatible: true as const,
    })),
    verifyGatewayRelease: vi.fn(async (path: string) => ({
      requestedPath: path,
      realPath: path,
      publicBinDirectory:
        "/Users/test/PresidentAssistant/runtime/current/public-bin",
      publicBinEntries: ["assistant-gateway"],
      expectedSha256: HASH,
      actualSha256: HASH,
      signatureVerified: true as const,
      executable: true as const,
    })),
    lstatGatewaySocket: vi.fn(async () => ({
      symbolicLink: false,
      socket: true,
      mode: 0o600,
    })),
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    taskId: TASK_ID,
    workspace: WORKSPACE,
    gatewaySocket: GATEWAY_SOCKET,
    gatewayClient: GATEWAY_CLIENT,
    prompt: "整理附件",
    ...overrides,
  };
}

async function collectEvents(
  events: AsyncIterable<CodexRunEvent>,
): Promise<CodexRunEvent[]> {
  const collected: CodexRunEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForStdinFinish(child: FakeChild): Promise<void> {
  if (child.stdin.writableFinished) return;
  await new Promise<void>((resolve) => child.stdin.once("finish", resolve));
}

async function withObjectPrototypeProperty<T>(
  key: string,
  value: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
  Object.defineProperty(Object.prototype, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(Object.prototype, key);
    } else {
      Object.defineProperty(Object.prototype, key, previous);
    }
  }
}

function emitEvent(child: FakeChild, event: Record<string, unknown>): void {
  child.stdout.write(`${JSON.stringify(event)}\n`);
}

function emitSuccessfulTurn(child: FakeChild): void {
  emitEvent(child, THREAD_STARTED);
  emitEvent(child, TURN_STARTED);
  emitEvent(child, TURN_COMPLETED);
}

describe("codex runner invocation", () => {
  it("uses the exact Codex 0.142.0 safe argv, cwd, shell setting and clean environment", async () => {
    const child = new FakeChild();
    const deps = validDependencies(child);
    vi.stubEnv("HOME", "/Users/leak");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.invalid");
    vi.stubEnv("FEISHU_APP_SECRET", "secret");
    vi.stubEnv("LARK_ACCESS_TOKEN", "token");
    vi.stubEnv("LARK_CLI_PATH", "/unsafe/lark-cli");
    const runner = createCodexRunner(deps);

    await runner.start(request());

    expect(deps.spawn).toHaveBeenCalledWith(CODEX_PATH, NEW_ARGS, {
      cwd: WORKSPACE,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        CODEX_HOME,
        ASSISTANT_GATEWAY_SOCKET: GATEWAY_SOCKET,
        ASSISTANT_GATEWAY_CLIENT: GATEWAY_CLIENT,
        LANG: "zh_CN.UTF-8",
      },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const serialized = JSON.stringify(deps.spawn.mock.calls[0]);
    expect(serialized).not.toContain("整理附件");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("proxy.invalid");
    expect(serialized).not.toContain("lark-cli");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses the same root safety prefix and only an explicit canonical UUID for resume", async () => {
    const deps = validDependencies();
    const runner = createCodexRunner(deps);

    await runner.start(request({ sessionId: SESSION_ID }));

    expect(deps.spawn).toHaveBeenCalledWith(
      CODEX_PATH,
      RESUME_ARGS,
      expect.objectContaining({ cwd: WORKSPACE, shell: false }),
    );
    const args = deps.spawn.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain("--last");
    expect(args).not.toContain("--search");
    expect(args).not.toContain("--add-dir");
    expect(args).not.toContain("danger-full-access");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("derives one TOML-safe Unix socket allow rule from the verified workspace", async () => {
    const specialWorkspace = `${WORKSPACE_ROOT}/quoted-"-backslash-\\-newline-\n[permissions.attacker]`;
    const specialSocket = `${specialWorkspace}/gateway.sock`;
    const deps = validDependencies();
    deps.resolveWorkspace.mockResolvedValue(specialWorkspace);

    await createCodexRunner(deps).start(
      request({ workspace: specialWorkspace, gatewaySocket: specialSocket }),
    );

    const args = deps.spawn.mock.calls[0]?.[1] as readonly string[];
    expect(args).toContain(
      `permissions.assistant-task={extends=":workspace",network={enabled=true,mode="limited",allow_local_binding=false,enable_socks5=false,enable_socks5_udp=false,allow_upstream_proxy=false,dangerously_allow_non_loopback_proxy=false,dangerously_allow_all_unix_sockets=false,unix_sockets={${JSON.stringify(specialSocket)}="allow"}}}`,
    );
    expect(
      args.filter((value) => value.startsWith("permissions.assistant-task=")),
    ).toHaveLength(1);
    expect(args.every((value) => !value.includes("\n"))).toBe(true);
    expect(args).not.toContain('default_permissions=":danger-full-access"');
  });

  it("keeps TCP, local binding, upstream proxies and every other Unix socket denied", async () => {
    const deps = validDependencies();

    await createCodexRunner(deps).start(request());

    const args = deps.spawn.mock.calls[0]?.[1] as readonly string[];
    expect(PERMISSIONS_CONFIG).toContain("enabled=true");
    expect(PERMISSIONS_CONFIG).toContain('mode="limited"');
    expect(PERMISSIONS_CONFIG).toContain("allow_local_binding=false");
    expect(PERMISSIONS_CONFIG).toContain("allow_upstream_proxy=false");
    expect(PERMISSIONS_CONFIG).toContain(
      "dangerously_allow_all_unix_sockets=false",
    );
    expect(PERMISSIONS_CONFIG).not.toContain(
      `${JSON.stringify(WORKSPACE_ROOT)}="allow"`,
    );
    expect(JSON.stringify(args)).not.toContain("action-gateway.sock");
    expect(JSON.stringify(args)).not.toContain("http://");
    expect(JSON.stringify(args)).not.toContain("https://");
  });

  it("does not inherit an implicit resume session from Object.prototype", async () => {
    const child = new FakeChild();
    const deps = validDependencies(child);
    const runner = createCodexRunner(deps);

    await withObjectPrototypeProperty("sessionId", SESSION_ID, () =>
      runner.start(request()),
    );

    expect(deps.spawn.mock.calls[0]?.[1]).toEqual(NEW_ARGS);
    child.close();
  });

  it("does not inherit an optional workspace resolver from Object.prototype", async () => {
    const deps = validDependencies();
    const pollutedResolver = vi.fn(async () => WORKSPACE);
    Reflect.deleteProperty(deps, "resolveWorkspace");

    const error = await withObjectPrototypeProperty(
      "resolveWorkspace",
      pollutedResolver,
      () =>
        createCodexRunner(deps)
          .start(request())
          .catch((caught: unknown) => caught),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("task workspace verification failed");
    expect(pollutedResolver).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("passes a null-prototype five-field environment and options record", async () => {
    const child = new FakeChild();
    const deps = validDependencies(child);

    await withObjectPrototypeProperty(
      "FEISHU_APP_SECRET",
      "prototype-secret",
      () => createCodexRunner(deps).start(request()),
    );

    const options = deps.spawn.mock.calls[0]?.[2];
    expect(Object.getPrototypeOf(options)).toBeNull();
    expect(Object.getPrototypeOf(options?.env)).toBeNull();
    expect(Object.keys(options?.env ?? {})).toEqual([
      "PATH",
      "CODEX_HOME",
      "ASSISTANT_GATEWAY_SOCKET",
      "ASSISTANT_GATEWAY_CLIENT",
      "LANG",
    ]);
    expect(options?.env.FEISHU_APP_SECRET).toBeUndefined();
    child.close();
  });

  it("rejects an accessor request instead of validating one session and spawning another", async () => {
    const child = new FakeChild();
    const deps = validDependencies(child);
    const input = request({ sessionId: SESSION_ID });
    let reads = 0;
    Object.defineProperty(input, "sessionId", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return reads <= 2 ? SESSION_ID : "--last";
      },
    });

    const started = await createCodexRunner(deps)
      .start(input)
      .then(
        () => true,
        () => false,
      );
    if (started) child.close();

    expect(started).toBe(false);
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("rejects an accessor request instead of swapping the verified socket in the child environment", async () => {
    const child = new FakeChild();
    const deps = validDependencies(child);
    const input = request();
    let reads = 0;
    Object.defineProperty(input, "gatewaySocket", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return reads <= 3 ? GATEWAY_SOCKET : "/tmp/unverified.sock";
      },
    });

    const started = await createCodexRunner(deps)
      .start(input)
      .then(
        () => true,
        () => false,
      );
    if (started) child.close();

    expect(started).toBe(false);
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("rejects an accessor request instead of writing a post-validation prompt", async () => {
    const child = new FakeChild();
    const chunks: Buffer[] = [];
    child.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    const deps = validDependencies(child);
    const input = request();
    let reads = 0;
    Object.defineProperty(input, "prompt", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return reads <= 5 ? "safe prompt" : "unsafe\0post-validation";
      },
    });

    const started = await createCodexRunner(deps)
      .start(input)
      .then(
        () => true,
        () => false,
      );
    await flush();
    if (started) child.close();

    expect(started).toBe(false);
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(Buffer.concat(chunks)).toHaveLength(0);
  });

  it("snapshots a data request before an async verifier can mutate its socket", async () => {
    const child = new FakeChild();
    const chunks: Buffer[] = [];
    child.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    const deps = validDependencies(child);
    const input = request({
      sessionId: SESSION_ID,
      prompt: "original prompt",
    });
    deps.verifyGatewayRelease.mockImplementation(async (path: string) => {
      Object.assign(input, {
        sessionId: "018f7d72-7a2b-7f45-8a12-8e20b8426a99",
        gatewaySocket: "/tmp/unverified.sock",
        gatewayClient: "/tmp/lark-cli",
        prompt: "unsafe\0post-validation",
      });
      return {
        requestedPath: path,
        realPath: path,
        publicBinDirectory:
          "/Users/test/PresidentAssistant/runtime/current/public-bin",
        publicBinEntries: ["assistant-gateway"],
        expectedSha256: HASH,
        actualSha256: HASH,
        signatureVerified: true,
        executable: true,
      };
    });

    await createCodexRunner(deps).start(input);
    await waitForStdinFinish(child);

    expect(deps.spawn.mock.calls[0]?.[1]).toEqual(RESUME_ARGS);
    const options = deps.spawn.mock.calls[0]?.[2];
    expect(options?.env.ASSISTANT_GATEWAY_SOCKET).toBe(GATEWAY_SOCKET);
    expect(options?.env.ASSISTANT_GATEWAY_CLIENT).toBe(GATEWAY_CLIENT);
    expect(Buffer.concat(chunks).toString("utf8")).toBe("original prompt");
    child.close();
  });

  it("rejects mutable dependency accessors before a different Codex binary can be spawned", async () => {
    const child = new FakeChild();
    const deps = validDependencies(child);
    let reads = 0;
    Object.defineProperty(deps, "codexPath", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return reads <= 3 ? CODEX_PATH : "/tmp/lark-cli";
      },
    });

    const started = await createCodexRunner(deps)
      .start(request())
      .then(
        () => true,
        () => false,
      );
    if (started) child.close();

    expect(started).toBe(false);
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("rejects mutable Codex home evidence before it can alter the child environment", async () => {
    const child = new FakeChild();
    const deps = validDependencies(child);
    deps.verifyCodexHome.mockImplementation(async () => {
      let reads = 0;
      return {
        requestedPath: CODEX_HOME,
        get realPath() {
          reads += 1;
          return reads === 1 ? CODEX_HOME : "/tmp/unverified-codex-home";
        },
        directory: true,
        symlinkFree: true,
        mode: 0o700,
      };
    });

    const started = await createCodexRunner(deps)
      .start(request())
      .then(
        () => true,
        () => false,
      );
    if (started) child.close();

    expect(started).toBe(false);
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("rejects mutable gateway evidence before it can swap in a raw lark-cli path", async () => {
    const child = new FakeChild();
    const deps = validDependencies(child);
    deps.verifyGatewayRelease.mockImplementation(async () => {
      let reads = 0;
      return {
        requestedPath: GATEWAY_CLIENT,
        get realPath() {
          reads += 1;
          return reads <= 3 ? GATEWAY_CLIENT : "/tmp/lark-cli";
        },
        publicBinDirectory:
          "/Users/test/PresidentAssistant/runtime/current/public-bin",
        publicBinEntries: ["assistant-gateway"],
        expectedSha256: HASH,
        actualSha256: HASH,
        signatureVerified: true,
        executable: true,
      };
    });

    const started = await createCodexRunner(deps)
      .start(request())
      .then(
        () => true,
        () => false,
      );
    if (started) child.close();

    expect(started).toBe(false);
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it.each(["symbol", "hidden"] as const)(
    "rejects a request with an unsupported %s field",
    async (kind) => {
      const child = new FakeChild();
      const deps = validDependencies(child);
      const input = request();
      if (kind === "symbol") {
        Object.defineProperty(input, Symbol("env"), {
          enumerable: true,
          value: { FEISHU_APP_SECRET: "secret" },
        });
      } else {
        Object.defineProperty(input, "env", {
          enumerable: false,
          value: { FEISHU_APP_SECRET: "secret" },
        });
      }

      const started = await createCodexRunner(deps)
        .start(input)
        .then(
          () => true,
          () => false,
        );
      if (started) child.close();

      expect(started).toBe(false);
      expect(deps.spawn).not.toHaveBeenCalled();
    },
  );

  it("replaces a revoked request proxy failure with a fixed error before verification", async () => {
    const deps = validDependencies();
    const revocable = Proxy.revocable(request(), {});
    revocable.revoke();

    const error = await createCodexRunner(deps)
      .start(revocable.proxy)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("invalid Codex run request");
    expect(deps.resolveWorkspace).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("rejects a transparent request proxy before verification", async () => {
    const deps = validDependencies();
    const input = new Proxy(request(), {});

    const error = await createCodexRunner(deps)
      .start(input)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("invalid Codex run request");
    expect(deps.resolveWorkspace).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("keeps dependencies fixed from runner construction onward", async () => {
    const child = new FakeChild();
    const deps = validDependencies(child);
    const originalSpawn = deps.spawn;
    const replacementSpawn = vi.fn(() => child);
    const runner = createCodexRunner(deps);

    deps.codexPath = "/tmp/lark-cli";
    deps.spawn = replacementSpawn;
    await runner.start(request());

    expect(originalSpawn).toHaveBeenCalledWith(
      CODEX_PATH,
      NEW_ARGS,
      expect.any(Object),
    );
    expect(replacementSpawn).not.toHaveBeenCalled();
    child.close();
  });

  it("snapshots the spawn capability before an async verifier can replace it", async () => {
    const child = new FakeChild();
    const deps = validDependencies(child);
    const originalSpawn = deps.spawn;
    const replacementSpawn = vi.fn(() => child);
    deps.verifyGatewayRelease.mockImplementation(async (path: string) => {
      deps.spawn = replacementSpawn;
      return {
        requestedPath: path,
        realPath: path,
        publicBinDirectory:
          "/Users/test/PresidentAssistant/runtime/current/public-bin",
        publicBinEntries: ["assistant-gateway"],
        expectedSha256: HASH,
        actualSha256: HASH,
        signatureVerified: true,
        executable: true,
      };
    });

    await createCodexRunner(deps).start(request());

    expect(originalSpawn).toHaveBeenCalledOnce();
    expect(replacementSpawn).not.toHaveBeenCalled();
    child.close();
  });

  it("passes a frozen invocation to the snapshotted spawn capability", async () => {
    const child = new FakeChild();
    const deps = validDependencies(child);

    await createCodexRunner(deps).start(request());

    const [, args, options] = deps.spawn.mock.calls[0] ?? [];
    expect(Object.isFrozen(args)).toBe(true);
    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.isFrozen(options?.env)).toBe(true);
    expect(Object.isFrozen(options?.stdio)).toBe(true);
    child.close();
  });

  it("invokes snapshotted capabilities without the mutable dependency record as receiver", async () => {
    const child = new FakeChild();
    const deps = validDependencies(child);
    const receivers: unknown[] = [];
    deps.resolveWorkspace = vi.fn(function (this: unknown) {
      receivers.push(this);
      return Promise.resolve(WORKSPACE);
    });
    deps.verifyCodexBinary = vi.fn(function (this: unknown, path: string) {
      receivers.push(this);
      return Promise.resolve({
        path,
        version: "0.142.0",
        executable: true,
        features: REQUIRED_FEATURES,
      });
    });
    deps.verifyCodexHome = vi.fn(function (this: unknown, path: string) {
      receivers.push(this);
      return Promise.resolve({
        requestedPath: path,
        realPath: path,
        directory: true,
        symlinkFree: true,
        mode: 0o700,
        permissionProfileCompatible: true,
      });
    });
    deps.lstatGatewaySocket = vi.fn(function (this: unknown) {
      receivers.push(this);
      return Promise.resolve({
        symbolicLink: false,
        socket: true,
        mode: 0o600,
      });
    });
    deps.verifyGatewayRelease = vi.fn(function (this: unknown, path: string) {
      receivers.push(this);
      return Promise.resolve({
        requestedPath: path,
        realPath: path,
        publicBinDirectory:
          "/Users/test/PresidentAssistant/runtime/current/public-bin",
        publicBinEntries: ["assistant-gateway"],
        expectedSha256: HASH,
        actualSha256: HASH,
        signatureVerified: true,
        executable: true,
      });
    });
    deps.spawn = vi.fn(function (this: unknown) {
      receivers.push(this);
      return child;
    });

    await createCodexRunner(deps).start(request());

    expect(receivers).toEqual(Array(6).fill(undefined));
    child.close();
  });

  it.each(["own includes", "proxy"] as const)(
    "rejects a feature list with a spoofable %s surface",
    async (kind) => {
      const deps = validDependencies();
      const features: string[] = [...REQUIRED_FEATURES];
      const unsafeFeatures =
        kind === "proxy"
          ? new Proxy(features, {})
          : Object.defineProperty(features, "includes", {
              enumerable: true,
              value: () => true,
            });
      deps.verifyCodexBinary.mockResolvedValue({
        path: CODEX_PATH,
        version: "0.142.0",
        executable: true,
        features: unsafeFeatures,
      });

      const error = await createCodexRunner(deps)
        .start(request())
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("codex binary verification failed");
      expect(deps.spawn).not.toHaveBeenCalled();
    },
  );

  it("replaces a throwing evidence accessor with a fixed verification error", async () => {
    const deps = validDependencies();
    deps.verifyCodexHome.mockResolvedValue({
      requestedPath: CODEX_HOME,
      get realPath(): string {
        throw new Error("sensitive verifier detail");
      },
      directory: true,
      symlinkFree: true,
      mode: 0o700,
    });

    const error = await createCodexRunner(deps)
      .start(request())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("codex home verification failed");
    expect((error as Error).message).not.toContain("sensitive");
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["task id", { taskId: ".." }],
    ["uppercase task id", { taskId: TASK_ID.toUpperCase() }],
    ["session id", { sessionId: "--last" }],
    ["uppercase session id", { sessionId: SESSION_ID.toUpperCase() }],
    ["workspace", { workspace: "relative/workspace" }],
    ["workspace NUL", { workspace: `${WORKSPACE}\0escape` }],
    ["gateway socket", { gatewaySocket: "gateway.sock" }],
    ["gateway client", { gatewayClient: "assistant-gateway" }],
    ["empty prompt", { prompt: "" }],
    ["whitespace prompt", { prompt: "  \n\t" }],
    ["non-string prompt", { prompt: Buffer.from("secret") }],
    ["NUL prompt", { prompt: "hello\0secret" }],
    ["overlong prompt", { prompt: "x".repeat(1024 * 1024 + 1) }],
    ["caller argv", { args: ["--dangerously-bypass-approvals-and-sandbox"] }],
    ["caller env", { env: { FEISHU_APP_SECRET: "secret" } }],
    ["caller cwd", { cwd: "/tmp" }],
    [
      "caller permissions profile",
      { defaultPermissions: ":danger-full-access" },
    ],
    [
      "caller Unix sockets",
      { unixSockets: { "/var/run/docker.sock": "allow" } },
    ],
    ["caller network mode", { networkMode: "full" }],
  ])("fails closed before spawn for invalid %s", async (_name, overrides) => {
    const deps = validDependencies();
    const runner = createCodexRunner(deps);

    await expect(runner.start(request(overrides))).rejects.toThrow();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["relative", "bin/codex"],
    ["NUL", "/opt/bin/codex\0evil"],
  ])(
    "rejects an %s configured codex path before its verifier or spawn",
    async (_name, codexPath) => {
      const deps = { ...validDependencies(), codexPath };
      const runner = createCodexRunner(deps);

      await expect(runner.start(request())).rejects.toThrow();
      expect(deps.verifyCodexBinary).not.toHaveBeenCalled();
      expect(deps.spawn).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["codex home relative", { codexHome: "runtime/codex-home" }],
    ["codex home NUL", { codexHome: `${CODEX_HOME}\0evil` }],
    ["workspace root relative", { workspaceRoot: "jobs" }],
  ])("rejects invalid fixed configuration: %s", async (_name, config) => {
    const deps = { ...validDependencies(), ...config };

    await expect(createCodexRunner(deps).start(request())).rejects.toThrow();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("writes the prompt only to stdin and closes stdin", async () => {
    const child = new FakeChild();
    const chunks: Buffer[] = [];
    child.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    const deps = validDependencies(child);

    await createCodexRunner(deps).start(
      request({ prompt: "只在标准输入里的秘密提示" }),
    );
    await flush();

    expect(Buffer.concat(chunks).toString("utf8")).toBe(
      "只在标准输入里的秘密提示",
    );
    expect((child.stdin as Writable).writableEnded).toBe(true);
    expect(JSON.stringify(deps.spawn.mock.calls)).not.toContain(
      "只在标准输入里的秘密提示",
    );
  });

  it.each([
    ["workspace resolver", "resolveWorkspace"],
    ["Codex binary verifier", "verifyCodexBinary"],
    ["Codex home verifier", "verifyCodexHome"],
    ["gateway release verifier", "verifyGatewayRelease"],
    ["gateway socket lstat", "lstatGatewaySocket"],
  ] as const)(
    "sanitizes a thrown %s error before spawn",
    async (_name, dependency) => {
      const deps = validDependencies();
      deps[dependency].mockRejectedValue(
        new Error("raw verifier secret 整理附件"),
      );

      const error = await createCodexRunner(deps)
        .start(request())
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("raw verifier secret");
      expect((error as Error).message).not.toContain("整理附件");
      expect(deps.spawn).not.toHaveBeenCalled();
    },
  );

  it("waits for stdin drain before ending after backpressure", async () => {
    let releaseWrite: (() => void) | undefined;
    const stdin = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        releaseWrite = callback;
      },
    });
    const child = new FakeChild(stdin);
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );

    expect(stdin.writableEnded).toBe(false);
    releaseWrite?.();
    await flush();
    expect(stdin.writableEnded).toBe(true);
    await waitForStdinFinish(child);
    emitSuccessfulTurn(child);
    child.close();
    await expect(run.result).resolves.toMatchObject({ status: "SUCCEEDED" });
  });

  it("fails closed if the child closes before a backpressured prompt can end", async () => {
    const stdin = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, _callback) {
        // Intentionally never drains before the child closes.
      },
    });
    const child = new FakeChild(stdin);
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );

    child.close(0, null);

    await expect(run.result).resolves.toMatchObject({
      status: "IO_ERROR",
      reason: "stdin_incomplete",
      requiresConfirmation: true,
      automaticRetry: false,
    });
  });

  it("requires the stdin finish event instead of treating end invocation as a flush", async () => {
    let releaseFinal: (() => void) | undefined;
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        releaseFinal = callback;
      },
    });
    const child = new FakeChild(stdin);
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );

    expect(stdin.writableEnded).toBe(true);
    expect(stdin.writableFinished).toBe(false);
    emitSuccessfulTurn(child);
    child.close(0, null);

    await expect(run.result).resolves.toMatchObject({
      status: "IO_ERROR",
      reason: "stdin_incomplete",
      requiresConfirmation: true,
      automaticRetry: false,
    });
    releaseFinal?.();
  });
});

describe("codex runner trusted path bindings", () => {
  it("calls every trusted verifier before spawning", async () => {
    const deps = validDependencies();

    await createCodexRunner(deps).start(request());

    expect(deps.resolveWorkspace).toHaveBeenCalledWith(WORKSPACE_ROOT, TASK_ID);
    expect(deps.verifyCodexBinary).toHaveBeenCalledWith(CODEX_PATH);
    expect(deps.verifyCodexHome).toHaveBeenCalledWith(CODEX_HOME);
    expect(deps.verifyGatewayRelease).toHaveBeenCalledWith(GATEWAY_CLIENT);
    expect(deps.lstatGatewaySocket).toHaveBeenCalledWith(GATEWAY_SOCKET);
  });

  it.each([
    [
      "wrong path",
      {
        path: "/other/codex",
        version: "0.142.0",
        executable: true,
        features: REQUIRED_FEATURES,
      },
    ],
    [
      "old version",
      {
        path: CODEX_PATH,
        version: "0.141.9",
        executable: true,
        features: REQUIRED_FEATURES,
      },
    ],
    [
      "malformed version",
      {
        path: CODEX_PATH,
        version: "latest",
        executable: true,
        features: REQUIRED_FEATURES,
      },
    ],
    [
      "missing required feature",
      {
        path: CODEX_PATH,
        version: "0.142.0",
        executable: true,
        features: ["exec-json"],
      },
    ],
    [
      "not executable",
      {
        path: CODEX_PATH,
        version: "0.142.0",
        executable: false,
        features: REQUIRED_FEATURES,
      },
    ],
  ])("rejects codex verifier evidence for %s", async (_name, evidence) => {
    const deps = validDependencies();
    deps.verifyCodexBinary.mockResolvedValue(evidence);

    await expect(createCodexRunner(deps).start(request())).rejects.toThrow(
      "codex binary verification failed",
    );
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("accepts a compatible newer Codex version when all feature probes pass", async () => {
    const deps = validDependencies();
    deps.verifyCodexBinary.mockResolvedValue({
      path: CODEX_PATH,
      version: "0.143.1",
      executable: true,
      features: [...REQUIRED_FEATURES, "future-safe-feature"],
    });

    await createCodexRunner(deps).start(request());

    expect(deps.spawn).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "wrong real path",
      {
        requestedPath: CODEX_HOME,
        realPath: "/other/home",
        directory: true,
        symlinkFree: true,
        mode: 0o700,
        permissionProfileCompatible: true,
      },
    ],
    [
      "not a directory",
      {
        requestedPath: CODEX_HOME,
        realPath: CODEX_HOME,
        directory: false,
        symlinkFree: true,
        mode: 0o700,
        permissionProfileCompatible: true,
      },
    ],
    [
      "symlinked path",
      {
        requestedPath: CODEX_HOME,
        realPath: CODEX_HOME,
        directory: true,
        symlinkFree: false,
        mode: 0o700,
        permissionProfileCompatible: true,
      },
    ],
    [
      "permissions too broad",
      {
        requestedPath: CODEX_HOME,
        realPath: CODEX_HOME,
        directory: true,
        symlinkFree: true,
        mode: 0o755,
        permissionProfileCompatible: true,
      },
    ],
    [
      "legacy sandbox settings present",
      {
        requestedPath: CODEX_HOME,
        realPath: CODEX_HOME,
        directory: true,
        symlinkFree: true,
        mode: 0o700,
        permissionProfileCompatible: false,
      },
    ],
  ])("rejects Codex home verifier evidence for %s", async (_name, evidence) => {
    const deps = validDependencies();
    deps.verifyCodexHome.mockResolvedValue(evidence);

    await expect(createCodexRunner(deps).start(request())).rejects.toThrow(
      "codex home verification failed",
    );
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong requested path", { requestedPath: "/other/gateway" }],
    ["wrong real path", { realPath: "/release/public-bin/not-gateway" }],
    ["wrong public bin", { publicBinDirectory: "/release/bin" }],
    [
      "extra public binary",
      { publicBinEntries: ["assistant-gateway", "lark-cli"] },
    ],
    ["hash mismatch", { actualSha256: "b".repeat(64) }],
    [
      "bad hash format",
      { actualSha256: "A".repeat(64), expectedSha256: "A".repeat(64) },
    ],
    ["signature missing", { signatureVerified: false }],
    ["not executable", { executable: false }],
  ])("rejects gateway release evidence for %s", async (_name, override) => {
    const deps = validDependencies();
    const baseline = await deps.verifyGatewayRelease(GATEWAY_CLIENT);
    deps.verifyGatewayRelease.mockResolvedValue({ ...baseline, ...override });

    await expect(createCodexRunner(deps).start(request())).rejects.toThrow(
      "gateway release verification failed",
    );
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["outside workspace", `${WORKSPACE_ROOT}/${SESSION_ID}/gateway.sock`],
    ["wrong basename", `${WORKSPACE}/other.sock`],
    ["nested path", `${WORKSPACE}/nested/gateway.sock`],
  ])(
    "rejects a gateway socket %s before lstat or spawn",
    async (_name, gatewaySocket) => {
      const deps = validDependencies();

      await expect(
        createCodexRunner(deps).start(request({ gatewaySocket })),
      ).rejects.toThrow(
        "gateway socket must be the task workspace gateway.sock",
      );
      expect(deps.lstatGatewaySocket).not.toHaveBeenCalled();
      expect(deps.spawn).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["symlink", { symbolicLink: true, socket: true, mode: 0o600 }],
    ["not a socket", { symbolicLink: false, socket: false, mode: 0o600 }],
    [
      "permissions too broad",
      { symbolicLink: false, socket: true, mode: 0o666 },
    ],
  ])(
    "rejects gateway socket lstat evidence for %s",
    async (_name, evidence) => {
      const deps = validDependencies();
      deps.lstatGatewaySocket.mockResolvedValue(evidence);

      await expect(createCodexRunner(deps).start(request())).rejects.toThrow(
        "gateway socket verification failed",
      );
      expect(deps.spawn).not.toHaveBeenCalled();
    },
  );

  it("rejects a caller workspace that differs from the resolver result", async () => {
    const deps = validDependencies();
    deps.resolveWorkspace.mockResolvedValue("/trusted/other-workspace");

    await expect(createCodexRunner(deps).start(request())).rejects.toThrow(
      "task workspace verification failed",
    );
    expect(deps.spawn).not.toHaveBeenCalled();
  });
});

describe("codex runner JSONL and lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("yields the known Codex 0.142 event sequence and succeeds only after turn.completed", async () => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );
    const eventsPromise = collectEvents(run.events);

    child.stdout.write(`${JSON.stringify(THREAD_STARTED)}\n\n`);
    emitEvent(child, TURN_STARTED);
    emitEvent(child, {
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: "完成" },
    });
    emitEvent(child, TURN_COMPLETED);
    await waitForStdinFinish(child);
    child.close(0, null);

    await expect(eventsPromise).resolves.toEqual([
      THREAD_STARTED,
      TURN_STARTED,
      {
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "完成" },
      },
      TURN_COMPLETED,
    ]);
    await expect(run.result).resolves.toEqual({
      status: "SUCCEEDED",
      exitCode: 0,
      signal: null,
      requiresConfirmation: false,
      automaticRetry: false,
    });
  });

  it.each([
    ["no events", []],
    ["thread only", [THREAD_STARTED]],
    ["turn without completion", [THREAD_STARTED, TURN_STARTED]],
  ])(
    "does not treat exit zero with %s as success",
    async (_name, protocolEvents) => {
      const child = new FakeChild();
      const run = await createCodexRunner(validDependencies(child)).start(
        request(),
      );
      for (const event of protocolEvents) emitEvent(child, event);

      await waitForStdinFinish(child);
      child.close(0, null);

      await expect(run.result).resolves.toMatchObject({
        status: "PROTOCOL_ERROR",
        reason: "missing_success_terminal",
        requiresConfirmation: true,
        automaticRetry: false,
      });
    },
  );

  it.each([
    [
      "missing reasoning counter",
      { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
    ],
    ["negative input counter", { ...TURN_COMPLETED.usage, input_tokens: -1 }],
    [
      "negative cached-input counter",
      { ...TURN_COMPLETED.usage, cached_input_tokens: -1 },
    ],
    ["negative output counter", { ...TURN_COMPLETED.usage, output_tokens: -1 }],
    [
      "negative reasoning counter",
      { ...TURN_COMPLETED.usage, reasoning_output_tokens: -1 },
    ],
  ])("rejects %s in Codex 0.142 usage", async (_name, usage) => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );
    emitEvent(child, THREAD_STARTED);
    emitEvent(child, TURN_STARTED);
    emitEvent(child, { type: "turn.completed", usage });

    expect(child.kills).toEqual(["SIGTERM"]);
    child.close(null, "SIGTERM");
    await expect(run.result).resolves.toMatchObject({
      status: "PROTOCOL_ERROR",
      reason: "invalid_event",
    });
  });

  it("binds a resumed run to the requested session id", async () => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request({ sessionId: SESSION_ID }),
    );
    emitEvent(child, { type: "thread.started", thread_id: TASK_ID });

    expect(child.kills).toEqual(["SIGTERM"]);
    child.close(null, "SIGTERM");
    await expect(run.result).resolves.toMatchObject({
      status: "PROTOCOL_ERROR",
      reason: "invalid_event",
    });
  });

  it("accepts the observed collab_tool_call item type", async () => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );
    emitEvent(child, THREAD_STARTED);
    emitEvent(child, TURN_STARTED);
    emitEvent(child, {
      type: "item.completed",
      item: { id: "item_1", type: "collab_tool_call", status: "completed" },
    });
    emitEvent(child, TURN_COMPLETED);
    await waitForStdinFinish(child);
    child.close(0, null);

    await expect(run.result).resolves.toMatchObject({ status: "SUCCEEDED" });
  });

  it("rejects the unobserved error item type", async () => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );
    emitEvent(child, THREAD_STARTED);
    emitEvent(child, TURN_STARTED);
    emitEvent(child, {
      type: "item.completed",
      item: { id: "item_1", type: "error", message: "raw secret" },
    });

    expect(child.kills).toEqual(["SIGTERM"]);
    child.close(null, "SIGTERM");
    await expect(run.result).resolves.toMatchObject({
      status: "PROTOCOL_ERROR",
      reason: "invalid_event",
    });
  });

  it("treats turn.failed as a sanitized Codex failure even if the process exits zero", async () => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );
    const eventsPromise = collectEvents(run.events);
    emitEvent(child, THREAD_STARTED);
    emitEvent(child, TURN_STARTED);
    emitEvent(child, {
      type: "turn.failed",
      error: { message: "raw failure secret" },
    });

    expect(child.kills).toEqual(["SIGTERM"]);
    child.close(0, null);

    await expect(run.result).resolves.toMatchObject({
      status: "CODEX_ERROR",
      reason: "codex_reported_failure",
      requiresConfirmation: true,
      automaticRetry: false,
    });
    expect(JSON.stringify(await run.result)).not.toContain(
      "raw failure secret",
    );
    expect(JSON.stringify(await eventsPromise)).not.toContain(
      "raw failure secret",
    );
  });

  it("accepts a bounded reconnect diagnostic but redacts it and still requires turn.completed", async () => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );
    const eventsPromise = collectEvents(run.events);
    emitEvent(child, THREAD_STARTED);
    emitEvent(child, TURN_STARTED);
    emitEvent(child, {
      type: "error",
      message: "Reconnecting... raw secret /Users/private/path",
    });
    emitEvent(child, {
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: "完成" },
    });
    emitEvent(child, TURN_COMPLETED);
    await waitForStdinFinish(child);
    child.close(0, null);

    await expect(run.result).resolves.toMatchObject({ status: "SUCCEEDED" });
    const serializedEvents = JSON.stringify(await eventsPromise);
    expect(serializedEvents).toContain('{"type":"error"}');
    expect(serializedEvents).not.toContain("raw secret");
    expect(serializedEvents).not.toContain("/Users/private/path");
  });

  it("does not let a reconnect diagnostic replace the required success terminal", async () => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );
    emitEvent(child, THREAD_STARTED);
    emitEvent(child, TURN_STARTED);
    emitEvent(child, { type: "error", message: "Reconnecting..." });
    await waitForStdinFinish(child);
    child.close(0, null);

    await expect(run.result).resolves.toMatchObject({
      status: "PROTOCOL_ERROR",
      reason: "missing_success_terminal",
    });
  });

  it.each([
    ["turn before thread", [TURN_STARTED], "invalid_event_sequence"],
    [
      "error before turn",
      [{ type: "error", message: "Reconnecting..." }],
      "invalid_event_sequence",
    ],
    [
      "unknown item type",
      [
        THREAD_STARTED,
        TURN_STARTED,
        {
          type: "item.completed",
          item: { id: "item_1", type: "future_unreviewed_item" },
        },
      ],
      "invalid_event",
    ],
    [
      "second event after success terminal",
      [THREAD_STARTED, TURN_STARTED, TURN_COMPLETED, TURN_STARTED],
      "invalid_event_sequence",
    ],
  ])(
    "fails closed for protocol sequence: %s",
    async (_name, events, reason) => {
      const child = new FakeChild();
      const run = await createCodexRunner(validDependencies(child)).start(
        request(),
      );
      for (const event of events) emitEvent(child, event);

      expect(child.kills).toEqual(["SIGTERM"]);
      child.close(null, "SIGTERM");
      await expect(run.result).resolves.toMatchObject({
        status: "PROTOCOL_ERROR",
        reason,
      });
    },
  );

  it("rejects malformed UTF-8 before JSON parsing", async () => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );

    child.stdout.write(Buffer.from([0xff, 0x0a]));

    expect(child.kills).toEqual(["SIGTERM"]);
    child.close(null, "SIGTERM");
    await expect(run.result).resolves.toMatchObject({
      status: "PROTOCOL_ERROR",
      reason: "invalid_utf8",
    });
  });

  it("accepts CRLF and a UTF-8 code point split across stdout chunks", async () => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );
    const eventsPromise = collectEvents(run.events);
    child.stdout.write(`${JSON.stringify(THREAD_STARTED)}\r\n`);
    child.stdout.write(`${JSON.stringify(TURN_STARTED)}\r\n`);
    const itemLine = Buffer.from(
      `${JSON.stringify({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "完成" },
      })}\r\n`,
      "utf8",
    );
    const multibyteStart = itemLine.indexOf(Buffer.from("完成", "utf8"));
    expect(multibyteStart).toBeGreaterThan(0);
    child.stdout.write(itemLine.subarray(0, multibyteStart + 1));
    child.stdout.write(itemLine.subarray(multibyteStart + 1));
    child.stdout.write(`${JSON.stringify(TURN_COMPLETED)}\r\n`);
    await waitForStdinFinish(child);
    child.close(0, null);

    await expect(run.result).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(JSON.stringify(await eventsPromise)).toContain("完成");
  });

  it("accepts a valid raw JSONL line exactly at the one-MiB limit", async () => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );
    emitEvent(child, THREAD_STARTED);
    emitEvent(child, TURN_STARTED);
    const emptyEvent = {
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: "" },
    };
    const emptyLine = JSON.stringify(emptyEvent);
    const textLength = 1024 * 1024 - Buffer.byteLength(emptyLine, "utf8");
    const boundaryLine = JSON.stringify({
      ...emptyEvent,
      item: { ...emptyEvent.item, text: "x".repeat(textLength) },
    });
    expect(Buffer.byteLength(boundaryLine, "utf8")).toBe(1024 * 1024);
    child.stdout.write(`${boundaryLine}\n`);
    emitEvent(child, TURN_COMPLETED);
    await waitForStdinFinish(child);
    child.close(0, null);

    await expect(run.result).resolves.toMatchObject({ status: "SUCCEEDED" });
  });

  it.each([
    ["invalid JSON", "not-json\n", "invalid_json"],
    ["JSON scalar", '"not-an-event"\n', "invalid_event"],
    ["JSON array", "[]\n", "invalid_event"],
    ["object without type", "{}\n", "invalid_event"],
    ["object with numeric type", '{"type":123}\n', "invalid_event"],
    ["object with empty type", '{"type":""}\n', "invalid_event"],
    [
      "object with multiline type",
      '{"type":"progress\\nsecret-body"}\n',
      "invalid_event",
    ],
    [
      "object with overlong type",
      `{"type":"${"x".repeat(129)}"}\n`,
      "invalid_event",
    ],
    ["unknown safe event", '{"type":"progress"}\n', "unknown_event"],
    ["overlong line", `${"x".repeat(1024 * 1024 + 1)}\n`, "line_too_large"],
    [
      "overlong whitespace line",
      `${" ".repeat(1024 * 1024 + 1)}\n`,
      "line_too_large",
    ],
  ])(
    "fails closed for %s without exposing stdout",
    async (_name, output, reason) => {
      const child = new FakeChild();
      const run = await createCodexRunner(validDependencies(child)).start(
        request(),
      );

      child.stdout.write(output);

      expect(child.kills).toEqual(["SIGTERM"]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
      const resultSpy = vi.fn();
      void run.result.then(resultSpy);
      await flush();
      expect(resultSpy).not.toHaveBeenCalled();
      child.close(null, "SIGKILL");

      await expect(run.result).resolves.toEqual({
        status: "PROTOCOL_ERROR",
        exitCode: null,
        signal: "SIGKILL",
        reason,
        requiresConfirmation: true,
        automaticRetry: false,
      });
      expect(JSON.stringify(await run.result)).not.toContain(
        output.slice(0, 32),
      );
    },
  );

  it("fails closed when the accumulated incomplete buffer exceeds the limit", async () => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );

    child.stdout.write("x".repeat(600_000));
    child.stdout.write("y".repeat(600_000));
    expect(child.kills).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(10_000);
    child.close(null, "SIGKILL");

    await expect(run.result).resolves.toMatchObject({
      status: "PROTOCOL_ERROR",
      reason: "buffer_too_large",
    });
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("fails closed when valid events exceed the bounded pending-event queue", async () => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );
    const largeEvent = `${JSON.stringify({
      type: "item.updated",
      item: {
        id: "item_large",
        type: "agent_message",
        payload: "x".repeat(900_000),
      },
    })}\n`;

    emitEvent(child, THREAD_STARTED);
    emitEvent(child, TURN_STARTED);
    for (let index = 0; index < 5; index += 1) child.stdout.write(largeEvent);

    expect(child.kills).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    child.close(null, "SIGKILL");
    await expect(run.result).resolves.toMatchObject({
      status: "PROTOCOL_ERROR",
      reason: "event_queue_overflow",
      requiresConfirmation: true,
      automaticRetry: false,
    });
  });

  it("does not charge an event delivered directly to an awaiting consumer", async () => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );
    const iterator = run.events[Symbol.asyncIterator]();
    const protocolEvents: Array<Record<string, unknown>> = [
      THREAD_STARTED,
      TURN_STARTED,
      ...Array.from({ length: 6 }, (_, index) => ({
        type: "item.updated",
        item: {
          id: `item_${index}`,
          type: "agent_message",
          payload: "x".repeat(900_000),
        },
      })),
      TURN_COMPLETED,
    ];

    for (const event of protocolEvents) {
      const next = iterator.next();
      emitEvent(child, event);
      await expect(next).resolves.toMatchObject({ done: false });
    }
    await waitForStdinFinish(child);
    child.close(0, null);

    expect(child.kills).toEqual([]);
    await expect(run.result).resolves.toMatchObject({ status: "SUCCEEDED" });
  });

  it("does not SIGKILL when a protocol-failed child closes during the grace period", async () => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );
    child.stdout.write("not-json\n");
    expect(child.kills).toEqual(["SIGTERM"]);

    child.close(null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(child.kills).toEqual(["SIGTERM"]);
    await expect(run.result).resolves.toMatchObject({
      status: "PROTOCOL_ERROR",
      reason: "invalid_json",
      requiresConfirmation: true,
      automaticRetry: false,
    });
  });

  it("keeps the forced-kill timer after a child error that does not prove exit", async () => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );
    child.stdout.write("not-json\n");
    child.emit("error", new Error("kill failed without exit"));

    await vi.advanceTimersByTimeAsync(10_000);

    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    const resultSpy = vi.fn();
    void run.result.then(resultSpy);
    await flush();
    expect(resultSpy).not.toHaveBeenCalled();
    child.close(null, "SIGKILL");
    await expect(run.result).resolves.toMatchObject({
      status: "PROTOCOL_ERROR",
      reason: "invalid_json",
    });
  });

  it("reports unconfirmed termination after accepted TERM and KILL without close", async () => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );
    const termination = run.terminationEvents[Symbol.asyncIterator]().next();
    const resultSpy = vi.fn();
    void run.result.then(resultSpy);

    child.stdout.write("not-json\n");
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();

    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(resultSpy).not.toHaveBeenCalled();
    await expect(termination).resolves.toEqual({
      done: false,
      value: {
        status: "TERMINATION_UNCONFIRMED",
        reason: "invalid_json",
        termSignalAccepted: true,
        killSignalAccepted: true,
        requiresConfirmation: true,
        automaticRetry: false,
      },
    });

    child.close(null, "SIGKILL");
    await expect(run.result).resolves.toMatchObject({
      status: "PROTOCOL_ERROR",
      reason: "invalid_json",
    });
  });

  it("settles reentrantly on a close emitted synchronously by TERM", async () => {
    const child = new FakeChild();
    child.kill = vi.fn((signal: NodeJS.Signals) => {
      child.kills.push(signal);
      child.close(null, signal);
      return true;
    });
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );
    const termination = run.terminationEvents[Symbol.asyncIterator]().next();

    child.stdout.write("not-json\n");

    await expect(run.result).resolves.toMatchObject({
      status: "PROTOCOL_ERROR",
      reason: "invalid_json",
      signal: "SIGTERM",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kills).toEqual(["SIGTERM"]);
    await expect(termination).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it.each(["returns false", "throws"])(
    "reports unconfirmed termination when kill %s and keeps resources open until close",
    async (killBehavior) => {
      const child = new FakeChild();
      child.kill = vi.fn((signal: NodeJS.Signals) => {
        child.kills.push(signal);
        if (killBehavior === "throws") throw new Error("raw kill failure");
        return false;
      });
      const run = await createCodexRunner(validDependencies(child)).start(
        request(),
      );
      const termination = run.terminationEvents[Symbol.asyncIterator]().next();
      const eventStreamDone = run.events[Symbol.asyncIterator]().next();
      const resultSpy = vi.fn();
      const eventDoneSpy = vi.fn();
      void run.result.then(resultSpy);
      void eventStreamDone.then(eventDoneSpy);

      child.stdout.write("not-json\n");
      await vi.advanceTimersByTimeAsync(10_000);
      await flush();

      expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
      expect(resultSpy).not.toHaveBeenCalled();
      expect(eventDoneSpy).not.toHaveBeenCalled();
      expect(child.listenerCount("close")).toBeGreaterThan(0);
      await expect(termination).resolves.toEqual({
        done: false,
        value: {
          status: "TERMINATION_UNCONFIRMED",
          reason: "invalid_json",
          termSignalAccepted: false,
          killSignalAccepted: false,
          requiresConfirmation: true,
          automaticRetry: false,
        },
      });

      child.close(null, "SIGKILL");

      await expect(run.result).resolves.toMatchObject({
        status: "PROTOCOL_ERROR",
        reason: "invalid_json",
        signal: "SIGKILL",
      });
      await expect(eventStreamDone).resolves.toEqual({
        done: true,
        value: undefined,
      });
    },
  );

  it("treats a non-whitespace unterminated line at close as a protocol error", async () => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );
    child.stdout.write('{"type":"incomplete"}');
    child.close(0, null);

    await expect(run.result).resolves.toMatchObject({
      status: "PROTOCOL_ERROR",
      reason: "incomplete_line",
    });
  });

  it("stderr and an incomplete stdout fragment do not reset idle", async () => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );

    await vi.advanceTimersByTimeAsync(29 * 60_000);
    child.stderr.write("noise that must never be surfaced\n");
    child.stdout.write('{"type":"partial"');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(child.kills).toEqual(["SIGTERM"]);
    child.close(null, "SIGTERM");
    await expect(run.result).resolves.toEqual({
      status: "INTERRUPTED_REQUIRES_CONFIRMATION",
      exitCode: null,
      signal: "SIGTERM",
      reason: "idle_timeout",
      requiresConfirmation: true,
      automaticRetry: false,
    });
    expect(JSON.stringify(await run.result)).not.toContain("noise");
    expect(JSON.stringify(await run.result)).not.toContain("partial");
  });

  it("accepts one MiB of whitespace without resetting idle", async () => {
    const child = new FakeChild();
    await createCodexRunner(validDependencies(child)).start(request());

    await vi.advanceTimersByTimeAsync(29 * 60_000 + 59_000);
    child.stdout.write(`${" ".repeat(1024 * 1024)}\n`);
    expect(child.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(child.kills).toEqual(["SIGTERM"]);
  });

  it("does not terminate at 29:59 and sends SIGTERM exactly at 30:00", async () => {
    const child = new FakeChild();
    await createCodexRunner(validDependencies(child)).start(request());

    await vi.advanceTimersByTimeAsync(29 * 60_000 + 59_000);
    expect(child.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kills).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kills).toEqual(["SIGTERM"]);
  });

  it("resets idle only after each valid complete event", async () => {
    const child = new FakeChild();
    await createCodexRunner(validDependencies(child)).start(request());

    await vi.advanceTimersByTimeAsync(29 * 60_000);
    emitEvent(child, THREAD_STARTED);
    await flush();
    await vi.advanceTimersByTimeAsync(29 * 60_000 + 59_000);
    expect(child.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kills).toEqual(["SIGTERM"]);
  });

  it("sends SIGKILL once when the child is still alive ten seconds after idle TERM", async () => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(child.kills).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(child.kills).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    const resultSpy = vi.fn();
    void run.result.then(resultSpy);
    await flush();
    expect(resultSpy).not.toHaveBeenCalled();
    child.close(null, "SIGKILL");
    await expect(run.result).resolves.toEqual({
      status: "INTERRUPTED_REQUIRES_CONFIRMATION",
      exitCode: null,
      signal: "SIGKILL",
      reason: "idle_timeout",
      requiresConfirmation: true,
      automaticRetry: false,
    });
  });

  it("does not SIGKILL after the child exits during the grace period", async () => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    child.close(null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(child.kills).toEqual(["SIGTERM"]);
    await expect(run.result).resolves.toMatchObject({
      status: "INTERRUPTED_REQUIRES_CONFIRMATION",
    });
  });

  it("settles once and does not send signals after an early successful close", async () => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );
    const resultSpy = vi.fn();
    void run.result.then(resultSpy);

    emitSuccessfulTurn(child);
    await waitForStdinFinish(child);
    child.close(0, null);
    child.emit("close", 7, null);
    await flush();
    await vi.advanceTimersByTimeAsync(31 * 60_000);

    expect(resultSpy).toHaveBeenCalledTimes(1);
    expect(child.kills).toEqual([]);
    await expect(run.result).resolves.toMatchObject({ status: "SUCCEEDED" });
  });

  it("does not infer close from non-null child exit fields", async () => {
    const child = new FakeChild();
    child.exitCode = 9;
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );
    const resultSpy = vi.fn();
    void run.result.then(resultSpy);
    emitSuccessfulTurn(child);

    await flush();
    expect(resultSpy).not.toHaveBeenCalled();
    expect(child.listenerCount("close")).toBeGreaterThan(0);

    await waitForStdinFinish(child);
    child.close(9, null);
    await expect(run.result).resolves.toMatchObject({
      status: "EXIT_FAILURE",
      reason: "non_zero_exit",
    });
  });

  it.each([
    ["non-zero exit", 7, null, "EXIT_FAILURE", "non_zero_exit"],
    ["external signal", null, "SIGINT", "SIGNALLED", "signal_exit"],
  ] as const)(
    "distinguishes %s",
    async (_name, code, signal, status, reason) => {
      const child = new FakeChild();
      const run = await createCodexRunner(validDependencies(child)).start(
        request(),
      );
      emitSuccessfulTurn(child);
      await waitForStdinFinish(child);
      child.close(code, signal);

      await expect(run.result).resolves.toEqual({
        status,
        exitCode: code,
        signal,
        reason,
        requiresConfirmation: true,
        automaticRetry: false,
      });
    },
  );

  it("distinguishes a synchronous spawn failure without exposing its message or prompt", async () => {
    const deps = validDependencies();
    deps.spawn.mockImplementation(() => {
      throw new Error("spawn leaked secret 整理附件");
    });
    const run = await createCodexRunner(deps).start(request());

    await expect(run.result).resolves.toEqual({
      status: "SPAWN_ERROR",
      exitCode: null,
      signal: null,
      reason: "spawn_error",
      requiresConfirmation: true,
      automaticRetry: false,
    });
    expect(JSON.stringify(await run.result)).not.toContain("整理附件");
    expect(await collectEvents(run.events)).toEqual([]);
  });

  it("waits for close after an emitted child spawn error", async () => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );
    const resultSpy = vi.fn();
    void run.result.then(resultSpy);
    child.emit("error", new Error("unsafe raw process error"));

    expect(child.kills).toEqual(["SIGTERM"]);
    await flush();
    expect(resultSpy).not.toHaveBeenCalled();

    child.close(null, "SIGTERM");

    await expect(run.result).resolves.toMatchObject({
      status: "SPAWN_ERROR",
      reason: "spawn_error",
    });
  });

  it.each([
    [
      "stdin",
      (child: FakeChild) =>
        child.stdin.emit("error", new Error("stdin raw secret")),
      "stdin_error",
    ],
    [
      "stdout",
      (child: FakeChild) =>
        child.stdout.emit("error", new Error("stdout raw secret")),
      "stdout_error",
    ],
  ] as const)(
    "fails with a sanitized IO status for %s errors",
    async (_name, trigger, reason) => {
      const child = new FakeChild();
      const run = await createCodexRunner(validDependencies(child)).start(
        request(),
      );
      trigger(child);

      expect(child.kills).toEqual(["SIGTERM"]);
      await vi.advanceTimersByTimeAsync(10_000);
      child.close(null, "SIGKILL");

      await expect(run.result).resolves.toEqual({
        status: "IO_ERROR",
        exitCode: null,
        signal: "SIGKILL",
        reason,
        requiresConfirmation: true,
        automaticRetry: false,
      });
      expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
      expect(JSON.stringify(await run.result)).not.toContain("raw secret");
    },
  );

  it("sanitizes stderr stream errors and settles only once across later close/error events", async () => {
    const child = new FakeChild();
    const run = await createCodexRunner(validDependencies(child)).start(
      request(),
    );
    const resultSpy = vi.fn();
    void run.result.then(resultSpy);

    child.stderr.emit("error", new Error("stderr raw secret"));
    child.emit("error", new Error("later child raw secret"));
    child.close(null, "SIGTERM");
    child.emit("close", 7, null);
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(resultSpy).toHaveBeenCalledTimes(1);
    expect(child.kills).toEqual(["SIGTERM"]);
    await expect(run.result).resolves.toEqual({
      status: "IO_ERROR",
      exitCode: null,
      signal: "SIGTERM",
      reason: "stderr_error",
      requiresConfirmation: true,
      automaticRetry: false,
    });
    expect(JSON.stringify(await run.result)).not.toContain("raw secret");
  });
});
