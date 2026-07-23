import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCodexRunner,
  type CodexChildProcess,
  type CodexRunRequest,
  type CodexRunnerDependencies,
} from "../../packages/bridge/src/agent/codex-runner.js";

const TASK_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a21";
const SESSION_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a22";
const WORKSPACE_ROOT = "/opt/president-assistant/jobs";
const WORKSPACE = `${WORKSPACE_ROOT}/${TASK_ID}`;
const CODEX_PATH = "/opt/president-assistant/bin/codex";
const CODEX_HOME = "/opt/president-assistant/runtime/codex-home";
const GATEWAY_SOCKET = `${WORKSPACE}/gateway.sock`;
const GATEWAY_DIRECTORY = "/opt/president-assistant/runtime/current/public-bin";
const GATEWAY_CLIENT = `${GATEWAY_DIRECTORY}/assistant-gateway`;
const PROMPT = "PROMPT_SENTINEL_只允许标准输入";
const HASH = "a".repeat(64);

const REQUIRED_FEATURES = [
  "exec-json",
  "exec-resume-stdin",
  "approval-never",
  "permission-profiles",
  "network-proxy-unix-socket-allowlist",
] as const;
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
] as const;

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
] as const;

class ProbeChild extends EventEmitter implements CodexChildProcess {
  readonly stdinChunks: string[] = [];
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.stdinChunks.push(Buffer.from(chunk).toString("utf8"));
      callback();
    },
  });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(): boolean {
    return true;
  }

  close(): void {
    this.exitCode = 1;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", 1, null);
  }
}

type ProbeDependencies = CodexRunnerDependencies & {
  spawn: ReturnType<typeof vi.fn>;
  verifyCodexBinary: ReturnType<typeof vi.fn>;
  verifyCodexHome: ReturnType<typeof vi.fn>;
  verifyGatewayRelease: ReturnType<typeof vi.fn>;
  lstatGatewaySocket: ReturnType<typeof vi.fn>;
  resolveWorkspace: ReturnType<typeof vi.fn>;
};

function validDependencies(child = new ProbeChild()): ProbeDependencies {
  return {
    codexPath: CODEX_PATH,
    codexHome: CODEX_HOME,
    workspaceRoot: WORKSPACE_ROOT,
    spawn: vi.fn(() => child),
    resolveWorkspace: vi.fn(async () => WORKSPACE),
    verifyCodexBinary: vi.fn(async () => ({
      path: CODEX_PATH,
      version: "0.142.0",
      executable: true,
      features: REQUIRED_FEATURES,
    })),
    verifyCodexHome: vi.fn(async () => ({
      requestedPath: CODEX_HOME,
      realPath: CODEX_HOME,
      directory: true,
      symlinkFree: true,
      mode: 0o700,
      permissionProfileCompatible: true,
    })),
    lstatGatewaySocket: vi.fn(async () => ({
      symbolicLink: false,
      socket: true,
      mode: 0o600,
    })),
    verifyGatewayRelease: vi.fn(async () => ({
      requestedPath: GATEWAY_CLIENT,
      realPath: GATEWAY_CLIENT,
      publicBinDirectory: GATEWAY_DIRECTORY,
      publicBinEntries: ["assistant-gateway"],
      expectedSha256: HASH,
      actualSha256: HASH,
      signatureVerified: true,
      executable: true,
    })),
  };
}

function request(overrides: Record<string, unknown> = {}): CodexRunRequest {
  return {
    taskId: TASK_ID,
    workspace: WORKSPACE,
    gatewaySocket: GATEWAY_SOCKET,
    gatewayClient: GATEWAY_CLIENT,
    prompt: PROMPT,
    ...overrides,
  } as CodexRunRequest;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Codex tool and network boundary", () => {
  it.each([
    ["new", undefined, NEW_ARGS],
    ["resume", SESSION_ID, RESUME_ARGS],
  ] as const)(
    "uses the exact %s invocation and a five-variable environment",
    async (_name, sessionId, expectedArgs) => {
      vi.stubEnv("HOME", "/private/home-leak");
      vi.stubEnv("SHELL", "/bin/unsafe-shell");
      vi.stubEnv("HTTPS_PROXY", "http://proxy.invalid");
      vi.stubEnv("ALL_PROXY", "socks5://proxy.invalid");
      vi.stubEnv("NO_PROXY", "internal.invalid");
      vi.stubEnv("FEISHU_APP_SECRET", "secret-sentinel");
      vi.stubEnv("LARK_ACCESS_TOKEN", "token-sentinel");
      vi.stubEnv("LARK_CLI_PATH", "/unsafe/lark-cli");
      const child = new ProbeChild();
      const dependencies = validDependencies(child);
      const runner = createCodexRunner(dependencies);

      await runner.start(
        sessionId === undefined ? request() : request({ sessionId }),
      );

      expect(dependencies.spawn).toHaveBeenCalledOnce();
      const [command, args, options] = dependencies.spawn.mock.calls[0] ?? [];
      expect(command).toBe(CODEX_PATH);
      expect(args).toEqual(expectedArgs);
      expect(Object.isFrozen(args)).toBe(true);
      expect(Object.getPrototypeOf(options)).toBeNull();
      expect(Object.getPrototypeOf(options?.env)).toBeNull();
      expect(Object.isFrozen(options)).toBe(true);
      expect(Object.isFrozen(options?.env)).toBe(true);
      expect(options).toEqual({
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
      expect(child.stdinChunks.join("")).toBe(PROMPT);

      const invocationText = JSON.stringify([command, args, options]);
      expect(invocationText).not.toContain(PROMPT);
      expect(invocationText).not.toContain("danger-full-access");
      expect(invocationText).not.toContain("network_access=true");
      expect(args).toContain(PERMISSIONS_CONFIG);
      expect(PERMISSIONS_CONFIG).toContain("allow_local_binding=false");
      expect(PERMISSIONS_CONFIG).toContain("allow_upstream_proxy=false");
      expect(args).not.toContain("--sandbox");
      expect(invocationText).not.toContain("proxy.invalid");
      expect(invocationText).not.toContain("secret-sentinel");
      expect(invocationText).not.toContain("token-sentinel");
      expect(invocationText).not.toContain("/unsafe/lark-cli");
      child.close();
    },
  );

  it.each([
    ["workspace", { workspace: "/opt/president-assistant/jobs/other" }],
    ["gateway socket", { gatewaySocket: "/tmp/unverified.sock" }],
    ["gateway client", { gatewayClient: "/tmp/lark-cli" }],
  ] as const)("cannot replace the verified %s", async (_name, override) => {
    const dependencies = validDependencies();

    await expect(
      createCodexRunner(dependencies).start(request(override)),
    ).rejects.toThrow();

    expect(dependencies.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["argv", { args: ["--sandbox", "danger-full-access"] }],
    ["sandbox", { sandbox: "danger-full-access" }],
    ["approval", { approvalPolicy: "on-request" }],
    ["network", { networkAccess: true }],
    ["working directory", { cwd: "/tmp" }],
    ["binary", { binary: "/tmp/codex" }],
    ["environment", { env: { FEISHU_APP_SECRET: "secret" } }],
    ["shell", { shell: true }],
    ["URL", { url: "https://invalid.example" }],
    ["proxy", { proxy: "http://proxy.invalid" }],
    ["lark cli", { larkCliPath: "/tmp/lark-cli" }],
  ] as const)(
    "rejects caller-controlled %s before every verifier and spawn",
    async (_name, injection) => {
      const dependencies = validDependencies();
      const runner = createCodexRunner(dependencies);

      await expect(runner.start(request(injection))).rejects.toThrow();

      expect(dependencies.resolveWorkspace).not.toHaveBeenCalled();
      expect(dependencies.verifyCodexBinary).not.toHaveBeenCalled();
      expect(dependencies.verifyCodexHome).not.toHaveBeenCalled();
      expect(dependencies.lstatGatewaySocket).not.toHaveBeenCalled();
      expect(dependencies.verifyGatewayRelease).not.toHaveBeenCalled();
      expect(dependencies.spawn).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "Codex version",
      (dependencies: ProbeDependencies) => {
        dependencies.verifyCodexBinary.mockResolvedValue({
          path: CODEX_PATH,
          version: "0.141.9",
          executable: true,
          features: REQUIRED_FEATURES,
        });
      },
    ],
    [
      "Codex features",
      (dependencies: ProbeDependencies) => {
        dependencies.verifyCodexBinary.mockResolvedValue({
          path: CODEX_PATH,
          version: "0.142.0",
          executable: true,
          features: ["exec-json"],
        });
      },
    ],
    [
      "Codex home",
      (dependencies: ProbeDependencies) => {
        dependencies.verifyCodexHome.mockResolvedValue({
          requestedPath: CODEX_HOME,
          realPath: CODEX_HOME,
          directory: true,
          symlinkFree: true,
          mode: 0o755,
          permissionProfileCompatible: true,
        });
      },
    ],
    [
      "Codex home permission-profile compatibility",
      (dependencies: ProbeDependencies) => {
        dependencies.verifyCodexHome.mockResolvedValue({
          requestedPath: CODEX_HOME,
          realPath: CODEX_HOME,
          directory: true,
          symlinkFree: true,
          mode: 0o700,
          permissionProfileCompatible: false,
        });
      },
    ],
    [
      "gateway socket",
      (dependencies: ProbeDependencies) => {
        dependencies.lstatGatewaySocket.mockResolvedValue({
          symbolicLink: false,
          socket: true,
          mode: 0o644,
        });
      },
    ],
    [
      "gateway release",
      (dependencies: ProbeDependencies) => {
        dependencies.verifyGatewayRelease.mockResolvedValue({
          requestedPath: GATEWAY_CLIENT,
          realPath: GATEWAY_CLIENT,
          publicBinDirectory: GATEWAY_DIRECTORY,
          publicBinEntries: ["assistant-gateway"],
          expectedSha256: HASH,
          actualSha256: HASH,
          signatureVerified: false,
          executable: true,
        });
      },
    ],
  ] as const)(
    "fails closed before spawn for invalid %s evidence",
    async (_name, mutate) => {
      const dependencies = validDependencies();
      mutate(dependencies);
      const runner = createCodexRunner(dependencies);

      await expect(runner.start(request())).rejects.toThrow();
      expect(dependencies.spawn).not.toHaveBeenCalled();
    },
  );

  it("fails closed when a trusted verifier rejects", async () => {
    const dependencies = validDependencies();
    dependencies.verifyCodexBinary.mockRejectedValue(
      new Error("private verifier detail"),
    );
    const runner = createCodexRunner(dependencies);

    const run = runner.start(request());
    await expect(run).rejects.toThrow("codex binary verification failed");
    await expect(run).rejects.not.toThrow(/private verifier detail/);
    expect(dependencies.spawn).not.toHaveBeenCalled();
  });

  it("fails closed when a mandatory verifier capability is missing", async () => {
    const dependencies = validDependencies();
    Reflect.deleteProperty(dependencies, "verifyCodexBinary");
    const runner = createCodexRunner(dependencies);

    await expect(runner.start(request())).rejects.toThrow(
      "invalid Codex runner dependencies",
    );
    expect(dependencies.spawn).not.toHaveBeenCalled();
  });
});
