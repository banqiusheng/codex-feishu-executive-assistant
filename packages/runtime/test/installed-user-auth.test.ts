import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createInstalledUserAuthorizationAdapter,
  type InstalledUserAuthChild,
  type InstalledUserAuthSpawn,
  type InstalledUserAuthSpawnOptions,
} from "../src/installed-user-auth.js";
import { createRuntimeUserAuthorizationFlow } from "../src/user-auth-flow.js";

const USER_SCOPES = Object.freeze([
  "calendar:calendar.event:create",
  "calendar:calendar.event:update",
  "contact:user:search",
  "minutes:minutes.search:read",
  "minutes:minutes.basic:read",
  "minutes:minutes.artifacts:read",
  "base:app:read",
  "base:table:read",
  "base:field:read",
  "base:view:read",
  "base:record:read",
  "base:record:retrieve",
  "search:docs:read",
  "docx:document:create",
]);
const BOT_SCOPES = Object.freeze([
  "im:message:send_as_bot",
  "im:message:readonly",
  "im:message",
  "im:resource",
]);
const APP_ID = "cli_0123456789abcdef";
const MINIMAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const temporaryRoots: string[] = [];
const INVALID_HELPER_SCOPE_LISTS: ReadonlyArray<readonly [readonly string[]]> =
  [
    [[]],
    [[USER_SCOPES[2]!, USER_SCOPES[1]!]],
    [[USER_SCOPES[0]!, USER_SCOPES[0]!]],
    [["unknown:scope"]],
  ];

type SpawnCall = Readonly<{
  command: string;
  args: readonly string[];
  options: InstalledUserAuthSpawnOptions;
}>;

class ControlledChild extends EventEmitter implements InstalledUserAuthChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killedSignals: NodeJS.Signals[] = [];
  closeOnSignal: NodeJS.Signals | null = "SIGTERM";
  private closed = false;
  private autoResponse:
    | Readonly<{
        stdout: string;
        exitCode: number | null;
        stderr?: string;
        signal?: NodeJS.Signals | null;
      }>
    | undefined;

  constructor(
    autoResponse?: Readonly<{
      stdout: string;
      exitCode: number | null;
      stderr?: string;
      signal?: NodeJS.Signals | null;
    }>,
  ) {
    super();
    this.autoResponse = autoResponse;
  }

  start() {
    const response = this.autoResponse;
    this.autoResponse = undefined;
    if (response) {
      queueMicrotask(() =>
        this.finish(response.stdout, response.exitCode, {
          ...(response.stderr === undefined ? {} : { stderr: response.stderr }),
          ...(response.signal === undefined ? {} : { signal: response.signal }),
        }),
      );
    }
  }

  finish(
    stdout: string,
    exitCode: number | null,
    options: Readonly<{
      stderr?: string;
      signal?: NodeJS.Signals | null;
    }> = {},
  ) {
    if (this.closed) return;
    if (!this.stdout.writableEnded) {
      this.stdout.end(Buffer.from(stdout, "utf8"));
    }
    if (!this.stderr.writableEnded) {
      this.stderr.end(Buffer.from(options.stderr ?? "", "utf8"));
    }
    queueMicrotask(() => {
      if (this.closed) return;
      this.closed = true;
      this.emit("close", exitCode, options.signal ?? null);
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.killedSignals.push(signal);
    if (this.closeOnSignal === signal && !this.closed) {
      this.finish("", null, { signal });
    }
    return true;
  }
}

function temporaryRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ea-installed-auth-")));
  temporaryRoots.push(root);
  chmodSync(root, 0o700);
  return root;
}

function scopeContract(
  userScopes: readonly string[] = USER_SCOPES,
  rootOrder: "official" | "reordered" = "official",
) {
  const content = {
    schemaVersion: 1,
    userScopes: [...userScopes],
    botScopes: [...BOT_SCOPES],
    shortcuts: [
      { identity: "user", command: "minutes", shortcut: "+search" },
      { identity: "user", command: "minutes", shortcut: "+detail" },
      { identity: "user", command: "contact", shortcut: "+search-user" },
      { identity: "bot", command: "im", shortcut: "+messages-send" },
      { identity: "user", command: "calendar", shortcut: "+create" },
      { identity: "user", command: "base", shortcut: "+url-resolve" },
      { identity: "user", command: "base", shortcut: "+title-resolve" },
      { identity: "user", command: "base", shortcut: "+base-get" },
      { identity: "user", command: "base", shortcut: "+table-list" },
      { identity: "user", command: "base", shortcut: "+field-list" },
      { identity: "user", command: "base", shortcut: "+view-list" },
      { identity: "user", command: "base", shortcut: "+record-list" },
      { identity: "user", command: "base", shortcut: "+data-query" },
      { identity: "user", command: "docs", shortcut: "+create" },
    ],
  };
  return Buffer.from(
    JSON.stringify(
      rootOrder === "official"
        ? content
        : {
            userScopes: content.userScopes,
            schemaVersion: content.schemaVersion,
            botScopes: content.botScopes,
            shortcuts: content.shortcuts,
          },
    ),
    "utf8",
  );
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeExecutable(path: string) {
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(path, 0o700);
}

function fixture(
  spawn: InstalledUserAuthSpawn,
  options: Readonly<{
    contractBytes?: Buffer;
    contractSha?: string;
    contractPath?: string;
    inspectTimeoutMs?: number;
    helperTimeoutMs?: number;
  }> = {},
) {
  const root = temporaryRoot();
  const larkCliPath = join(root, "lark");
  const nodePath = join(root, "node");
  const userAuthHelperPath = join(root, "feishu-user-auth.mjs");
  const larkHome = join(root, "lark-home");
  const contractPath = options.contractPath ?? join(root, "feishu-scopes.json");
  writeExecutable(larkCliPath);
  writeExecutable(nodePath);
  writeFileSync(userAuthHelperPath, "export {};\n", { mode: 0o600 });
  writeFileSync(join(root, ".keep"), "", { mode: 0o600 });
  writeFileSync(contractPath, options.contractBytes ?? scopeContract(), {
    mode: 0o600,
  });
  // A real installed lark home is private and must not be inherited from the
  // test runner's ambient HOME.
  writeFileSync(join(root, "lark-home-marker"), "", { mode: 0o600 });
  // mkdir via a path-local fixture keeps every tested absolute path under one
  // disposable root.
  mkdirSync(larkHome, { mode: 0o700 });
  chmodSync(larkHome, 0o700);
  const contractBytes = options.contractBytes ?? scopeContract();
  return {
    root,
    larkCliPath,
    nodePath,
    userAuthHelperPath,
    larkHome,
    contractPath,
    contractBytes,
    appId: APP_ID,
    adapter: createInstalledUserAuthorizationAdapter(
      {
        scopeContractPath: contractPath,
        scopeContractSha256: options.contractSha ?? sha256(contractBytes),
        appId: APP_ID,
        larkCliPath,
        larkHome,
        nodePath,
        userAuthHelperPath,
      },
      {
        spawn,
        inspectTimeoutMs: options.inspectTimeoutMs ?? 1_000,
        helperTimeoutMs: options.helperTimeoutMs ?? 1_000,
      },
    ),
  };
}

function spawnQueue(...children: ControlledChild[]) {
  const calls: SpawnCall[] = [];
  const queue = [...children];
  const spawn: InstalledUserAuthSpawn = (command, args, options) => {
    calls.push({
      command,
      args: Object.freeze([...args]),
      options,
    });
    const child = queue.shift();
    if (!child) throw new Error("unexpected spawn");
    child.start();
    return child;
  };
  return { spawn, calls };
}

function userAppScopesPayload(
  userScopes: readonly string[] = USER_SCOPES,
  appId = APP_ID,
) {
  return JSON.stringify({
    appId,
    brand: "feishu",
    count: userScopes.length,
    tokenType: "user",
    userScopes: [...userScopes],
  });
}

function botAppScopesPayload(botScopes: readonly string[] = BOT_SCOPES) {
  return JSON.stringify({
    code: 0,
    msg: "ok",
    data: {
      app: {
        scopes: botScopes.map((scope) => ({
          scope,
          token_types: ["tenant"],
        })),
      },
    },
  });
}

function appScopeProbeChildren(
  options: Readonly<{
    userPayload?: string;
    userExitCode?: number | null;
    userStderr?: string;
    botPayload?: string;
    botExitCode?: number | null;
    botStderr?: string;
  }> = {},
) {
  return [
    new ControlledChild({
      stdout: options.userPayload ?? userAppScopesPayload(),
      stderr: options.userStderr ?? "Querying app scopes...\n\n",
      exitCode: options.userExitCode ?? 0,
    }),
    new ControlledChild({
      stdout: options.botPayload ?? botAppScopesPayload(),
      stderr: options.botStderr ?? "",
      exitCode: options.botExitCode ?? 0,
    }),
  ] as const;
}

function inspectSpawnQueue(
  authCheckChild: ControlledChild,
  options?: Parameters<typeof appScopeProbeChildren>[0],
) {
  return spawnQueue(...appScopeProbeChildren(options), authCheckChild);
}

function readyPayload() {
  return JSON.stringify({
    granted: [...USER_SCOPES],
    missing: null,
    ok: true,
  });
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("installed runtime Feishu user authorization adapter", () => {
  it("reads the 14 User scopes only from the trusted contract and performs the exact v1.0.72 auth check", async () => {
    const child = new ControlledChild({
      stdout: `${readyPayload()}\n`,
      exitCode: 0,
    });
    const { spawn, calls } = inspectSpawnQueue(child);
    const installed = fixture(spawn);
    const inspection = installed.adapter.inspect();

    await expect(inspection).resolves.toEqual({ state: "READY" });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({
      command: installed.larkCliPath,
      args: ["--profile", "executive-assistant", "auth", "scopes", "--json"],
      options: {
        cwd: installed.larkHome,
        env: {
          HOME: installed.larkHome,
          PATH: MINIMAL_PATH,
          LANG: "C",
          LC_ALL: "C",
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    });
    expect(calls[1]).toEqual({
      command: installed.larkCliPath,
      args: [
        "--profile",
        "executive-assistant",
        "api",
        "GET",
        `/open-apis/application/v6/applications/${installed.appId}`,
        "--as",
        "bot",
        "--params",
        '{"lang":"zh_cn"}',
        "--json",
      ],
      options: calls[0]!.options,
    });
    expect(calls[2]).toEqual({
      command: installed.larkCliPath,
      args: [
        "--profile",
        "executive-assistant",
        "auth",
        "check",
        "--scope",
        USER_SCOPES.join(" "),
        "--json",
      ],
      options: {
        cwd: installed.larkHome,
        env: {
          HOME: installed.larkHome,
          PATH: MINIMAL_PATH,
          LANG: "C",
          LC_ALL: "C",
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    });
  });

  it.each([
    [
      "User",
      {
        userPayload: userAppScopesPayload(USER_SCOPES.slice(1)),
      },
    ],
    [
      "Bot",
      {
        botPayload: botAppScopesPayload(BOT_SCOPES.slice(1)),
      },
    ],
  ] as const)(
    "returns APP_SCOPE_MISSING before auth check when a required %s scope is absent",
    async (_kind, probeOptions) => {
      const authCheck = new ControlledChild({
        stdout: readyPayload(),
        exitCode: 0,
      });
      const { spawn, calls } = inspectSpawnQueue(authCheck, probeOptions);
      const { adapter } = fixture(spawn);

      await expect(adapter.inspect()).resolves.toEqual({
        state: "APP_SCOPE_MISSING",
      });
      expect(calls).toHaveLength(2);
      expect(calls.every((call) => !call.args.includes("check"))).toBe(true);
    },
  );

  it.each([
    [
      "wrong app id",
      {
        userPayload: userAppScopesPayload(USER_SCOPES, "cli_other"),
      },
      1,
    ],
    [
      "wrong user scope count",
      {
        userPayload: JSON.stringify({
          appId: APP_ID,
          brand: "feishu",
          count: USER_SCOPES.length - 1,
          tokenType: "user",
          userScopes: [...USER_SCOPES],
        }),
      },
      1,
    ],
    [
      "unexpected auth-scopes stderr",
      {
        userStderr: "opaque",
      },
      1,
    ],
    [
      "invalid Bot token type",
      {
        botPayload: JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            app: {
              scopes: [
                {
                  scope: BOT_SCOPES[0],
                  token_types: ["root"],
                },
              ],
            },
          },
        }),
      },
      2,
    ],
    [
      "nonzero app-info exit",
      {
        botExitCode: 1,
      },
      2,
    ],
  ] as const)(
    "fails closed on malformed app-scope probe: %s",
    async (_name, probeOptions, expectedCalls) => {
      const authCheck = new ControlledChild({
        stdout: readyPayload(),
        exitCode: 0,
      });
      const { spawn, calls } = inspectSpawnQueue(authCheck, probeOptions);
      const { adapter } = fixture(spawn);

      await expect(adapter.inspect()).rejects.toThrow(
        "INSTALLED_USER_AUTH_INSPECTION_FAILED",
      );
      expect(calls).toHaveLength(expectedCalls);
      expect(calls.every((call) => !call.args.includes("check"))).toBe(true);
    },
  );

  it("returns all scopes in contract order for the official not_logged_in predicate result", async () => {
    const child = new ControlledChild({
      stdout: JSON.stringify({
        error: "not_logged_in",
        missing: [...USER_SCOPES],
        ok: false,
      }),
      exitCode: 1,
    });
    const { spawn } = inspectSpawnQueue(child);
    const { adapter } = fixture(spawn);
    const inspection = adapter.inspect();

    await expect(inspection).resolves.toEqual({
      state: "USER_AUTH_REQUIRED",
      missingScopes: USER_SCOPES,
    });
  });

  it("accepts an official partial-token result only when granted and missing form the ordered contract partition", async () => {
    const missingScopes = [
      USER_SCOPES[1],
      USER_SCOPES[8],
      USER_SCOPES[13],
    ] as const;
    const granted = USER_SCOPES.filter(
      (scope) =>
        !missingScopes.includes(scope as (typeof missingScopes)[number]),
    );
    const child = new ControlledChild({
      stdout: JSON.stringify({
        granted,
        missing: missingScopes,
        ok: false,
        suggestion: `lark-cli auth login --scope "${missingScopes.join(" ")}"`,
      }),
      exitCode: 1,
    });
    const { spawn } = inspectSpawnQueue(child);
    const { adapter } = fixture(spawn);
    const inspection = adapter.inspect();

    await expect(inspection).resolves.toEqual({
      state: "USER_AUTH_REQUIRED",
      missingScopes,
    });
  });

  it.each([
    {
      name: "exit 2",
      stdout: readyPayload(),
      exitCode: 2,
      stderr: "",
    },
    {
      name: "stderr pollution",
      stdout: readyPayload(),
      exitCode: 0,
      stderr: "opaque secret",
    },
    {
      name: "success with an incomplete grant",
      stdout: JSON.stringify({
        granted: USER_SCOPES.slice(1),
        missing: null,
        ok: true,
      }),
      exitCode: 0,
      stderr: "",
    },
    {
      name: "shuffled missing scopes",
      stdout: JSON.stringify({
        error: "no_token",
        missing: [...USER_SCOPES].reverse(),
        ok: false,
      }),
      exitCode: 1,
      stderr: "",
    },
    {
      name: "extra JSON field",
      stdout: JSON.stringify({
        granted: [...USER_SCOPES],
        missing: null,
        ok: true,
        token: "must-not-be-accepted",
      }),
      exitCode: 0,
      stderr: "",
    },
    {
      name: "wrong partial suggestion",
      stdout: JSON.stringify({
        granted: USER_SCOPES.slice(1),
        missing: [USER_SCOPES[0]],
        ok: false,
        suggestion: "open this",
      }),
      exitCode: 1,
      stderr: "",
    },
  ])("fails closed on malformed auth check: $name", async (testCase) => {
    const child = new ControlledChild({
      stdout: testCase.stdout,
      exitCode: testCase.exitCode,
      stderr: testCase.stderr,
    });
    const { spawn } = inspectSpawnQueue(child);
    const { adapter } = fixture(spawn);
    const inspection = adapter.inspect();

    await expect(inspection).rejects.toThrow(
      "INSTALLED_USER_AUTH_INSPECTION_FAILED",
    );
  });

  it.each(["digest", "duplicate", "root-order", "symlink"] as const)(
    "rejects a replaced or structurally unsafe scope contract: %s",
    async (mutation) => {
      const child = new ControlledChild();
      const { spawn, calls } = spawnQueue(child);
      const root = temporaryRoot();
      const contractPath = join(root, "contract.json");
      let bytes = scopeContract();
      let expectedSha = sha256(bytes);
      if (mutation === "digest") {
        writeFileSync(contractPath, bytes, { mode: 0o600 });
        expectedSha = "0".repeat(64);
      } else if (mutation === "duplicate") {
        bytes = scopeContract([...USER_SCOPES.slice(0, 13), USER_SCOPES[0]!]);
        writeFileSync(contractPath, bytes, { mode: 0o600 });
        expectedSha = sha256(bytes);
      } else if (mutation === "root-order") {
        bytes = scopeContract(USER_SCOPES, "reordered");
        writeFileSync(contractPath, bytes, { mode: 0o600 });
        expectedSha = sha256(bytes);
      } else {
        const target = join(root, "target.json");
        writeFileSync(target, bytes, { mode: 0o600 });
        symlinkSync(target, contractPath);
      }
      const installed = fixture(spawn, {
        contractPath,
        contractBytes: bytes,
        contractSha: expectedSha,
      });

      await expect(installed.adapter.inspect()).rejects.toThrow(
        "INSTALLED_USER_AUTH_INSPECTION_FAILED",
      );
      expect(calls).toHaveLength(0);
    },
  );

  it("spawns the fixed Node/helper pair with only a validated ordered subset and streams stdout unchanged", async () => {
    const child = new ControlledChild();
    const { spawn, calls } = spawnQueue(child);
    const installed = fixture(spawn);
    const missing = [USER_SCOPES[2]!, USER_SCOPES[11]!] as const;
    const handle = await installed.adapter.startHelper(missing);
    const streamed: Buffer[] = [];
    const consume = (async () => {
      for await (const chunk of handle.stdout) {
        streamed.push(Buffer.from(chunk));
      }
    })();
    child.finish('{"event":"authorization_result","status":"blocked"}\n', 1);

    await consume;
    await expect(handle.result).resolves.toEqual({
      exitCode: 1,
      signal: null,
    });
    expect(Buffer.concat(streamed).toString("utf8")).toBe(
      '{"event":"authorization_result","status":"blocked"}\n',
    );
    expect(calls).toEqual([
      {
        command: installed.nodePath,
        args: [
          installed.userAuthHelperPath,
          "--presenter",
          "stdout-json",
          "--scope-contract",
          installed.contractPath,
          "--scope-contract-sha256",
          sha256(installed.contractBytes),
          installed.larkCliPath,
          installed.larkHome,
          ...missing,
        ],
        options: {
          cwd: installed.larkHome,
          env: {
            HOME: installed.larkHome,
            PATH: MINIMAL_PATH,
            LANG: "C",
            LC_ALL: "C",
          },
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      },
    ]);
  });

  it.each(INVALID_HELPER_SCOPE_LISTS)(
    "rejects a helper scope list outside the contract order: %j",
    async (missing) => {
      const { spawn, calls } = spawnQueue();
      const { adapter } = fixture(spawn);

      await expect(adapter.startHelper(missing)).rejects.toThrow(
        "INSTALLED_USER_AUTH_HELPER_FAILED",
      );
      expect(calls).toHaveLength(0);
    },
  );

  it("bounds and swallows helper stderr without reflecting its contents", async () => {
    const child = new ControlledChild();
    const { spawn } = spawnQueue(child);
    const { adapter } = fixture(spawn);
    const handle = await adapter.startHelper([USER_SCOPES[0]!]);
    const secret = "SECRET-NEVER-REFLECT-";
    const failed = expect(handle.result).rejects.toThrow(
      "INSTALLED_USER_AUTH_HELPER_FAILED",
    );
    child.stderr.end(
      Buffer.concat([Buffer.alloc(65 * 1024, "x"), Buffer.from(secret)]),
    );

    await failed;
    await expect(handle.result).rejects.not.toThrow(secret);
    expect(child.killedSignals).toContain("SIGTERM");
  });

  it("terminates a helper on timeout and terminates active work on adapter close", async () => {
    vi.useFakeTimers();
    const timedOut = new ControlledChild();
    const active = new ControlledChild();
    const { spawn } = spawnQueue(timedOut, active);
    const { adapter } = fixture(spawn, { helperTimeoutMs: 50 });
    const first = await adapter.startHelper([USER_SCOPES[0]!]);
    const firstFailed = expect(first.result).rejects.toThrow(
      "INSTALLED_USER_AUTH_HELPER_FAILED",
    );
    await vi.advanceTimersByTimeAsync(50);

    await firstFailed;
    expect(timedOut.killedSignals).toContain("SIGTERM");

    const second = await adapter.startHelper([USER_SCOPES[1]!]);
    const secondFailed = expect(second.result).rejects.toThrow(
      "INSTALLED_USER_AUTH_HELPER_FAILED",
    );
    const closing = adapter.close();
    await vi.runAllTimersAsync();
    await closing;
    expect(active.killedSignals).toContain("SIGTERM");
    await secondFailed;
    await expect(adapter.inspect()).rejects.toThrow(
      "INSTALLED_USER_AUTH_ADAPTER_CLOSED",
    );
  });

  it("fails an auth inspection closed when its child times out", async () => {
    vi.useFakeTimers();
    const child = new ControlledChild();
    const { spawn } = inspectSpawnQueue(child);
    const { adapter } = fixture(spawn, { inspectTimeoutMs: 25 });
    const inspection = adapter.inspect();
    const failed = expect(inspection).rejects.toThrow(
      "INSTALLED_USER_AUTH_INSPECTION_FAILED",
    );
    await vi.advanceTimersByTimeAsync(25);

    await failed;
    expect(child.killedSignals).toContain("SIGTERM");
  });

  it("escalates a stubborn inspection from SIGTERM to SIGKILL and waits for close", async () => {
    vi.useFakeTimers();
    const child = new ControlledChild();
    child.closeOnSignal = "SIGKILL";
    const { spawn } = inspectSpawnQueue(child);
    const { adapter } = fixture(spawn, { inspectTimeoutMs: 25 });
    const inspection = adapter.inspect();
    const failed = expect(inspection).rejects.toThrow(
      "INSTALLED_USER_AUTH_INSPECTION_FAILED",
    );
    await vi.advanceTimersByTimeAsync(25);
    expect(child.killedSignals).toEqual(["SIGTERM"]);

    await vi.advanceTimersByTimeAsync(999);
    expect(child.killedSignals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(1);

    await failed;
    expect(child.killedSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("fails a SIGKILL-resistant inspection within a bounded close-confirmation window", async () => {
    vi.useFakeTimers();
    const child = new ControlledChild();
    child.closeOnSignal = null;
    const { spawn } = inspectSpawnQueue(child);
    const { adapter } = fixture(spawn, { inspectTimeoutMs: 25 });
    let settled = false;
    const inspection = adapter.inspect();
    void inspection.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const failed = expect(inspection).rejects.toThrow(
      "INSTALLED_USER_AUTH_INSPECTION_FAILED",
    );
    await vi.advanceTimersByTimeAsync(25 + 1_000);
    expect(child.killedSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await failed;
    expect(settled).toBe(true);
  });

  it("escalates adapter close for a stubborn helper and waits for its real close", async () => {
    vi.useFakeTimers();
    const child = new ControlledChild();
    child.closeOnSignal = "SIGKILL";
    const { spawn } = spawnQueue(child);
    const { adapter } = fixture(spawn);
    const handle = await adapter.startHelper([USER_SCOPES[0]!]);
    const failed = expect(handle.result).rejects.toThrow(
      "INSTALLED_USER_AUTH_HELPER_FAILED",
    );
    const closing = adapter.close();
    expect(child.killedSignals).toEqual(["SIGTERM"]);

    await vi.advanceTimersByTimeAsync(999);
    expect(child.killedSignals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(1);

    await failed;
    await closing;
    expect(child.killedSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("bounds adapter close when a helper never confirms close after SIGKILL", async () => {
    vi.useFakeTimers();
    const child = new ControlledChild();
    child.closeOnSignal = null;
    const { spawn } = spawnQueue(child);
    const { adapter } = fixture(spawn);
    const handle = await adapter.startHelper([USER_SCOPES[0]!]);
    let closeSettled = false;
    const failed = expect(handle.result).rejects.toThrow(
      "INSTALLED_USER_AUTH_HELPER_FAILED",
    );
    const closing = adapter.close().then(() => {
      closeSettled = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.killedSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(closeSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await failed;
    await closing;
    expect(closeSettled).toBe(true);
  });

  it("settles the real adapter + flow when a stubborn helper never closes and keeps stdout open", async () => {
    vi.useFakeTimers();
    const authCheck = new ControlledChild({
      stdout: JSON.stringify({
        error: "not_logged_in",
        missing: [...USER_SCOPES],
        ok: false,
      }),
      exitCode: 1,
    });
    const helperChild = new ControlledChild();
    helperChild.closeOnSignal = null;
    const { spawn, calls } = spawnQueue(
      ...appScopeProbeChildren(),
      authCheck,
      helperChild,
    );
    const { adapter } = fixture(spawn);
    const flow = createRuntimeUserAuthorizationFlow({
      inspect: adapter.inspect,
      startHelper: adapter.startHelper,
      sendAuthorizationCard: vi.fn(async () => undefined),
      sendText: vi.fn(async () => undefined),
    });

    await expect(
      flow.ensureAuthorized({
        chatId: "oc_president",
        replyToMessageId: "om_original",
      }),
    ).resolves.toEqual({ state: "AUTHORIZATION_REQUIRED" });
    for (let index = 0; index < 4 && calls.length < 4; index += 1) {
      await Promise.resolve();
    }
    expect(calls).toHaveLength(4);

    let allClosed = false;
    const closing = Promise.all([
      flow.close(),
      flow.waitForIdle(),
      adapter.close(),
    ]).then(() => {
      allClosed = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(helperChild.killedSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(allClosed).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await closing;
    expect(allClosed).toBe(true);
    expect(helperChild.killedSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("requires canonical absolute installed paths before spawning", () => {
    const { spawn, calls } = spawnQueue();
    const root = temporaryRoot();
    const bytes = scopeContract();
    const contractPath = join(root, "feishu-scopes.json");
    writeFileSync(contractPath, bytes, { mode: 0o600 });

    expect(() =>
      createInstalledUserAuthorizationAdapter(
        {
          scopeContractPath: resolve(contractPath),
          scopeContractSha256: sha256(bytes),
          appId: APP_ID,
          larkCliPath: "relative-lark",
          larkHome: root,
          nodePath: "/usr/bin/node",
          userAuthHelperPath: "/tmp/feishu-user-auth.mjs",
        },
        { spawn },
      ),
    ).toThrow("INSTALLED_USER_AUTH_OPTIONS_INVALID");
    expect(calls).toHaveLength(0);
  });
});
