import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  AUTHORIZATION_ORIGIN,
  BLOCKED_USER_AUTH,
  BROWSER_OPENED_MESSAGE,
  MAX_CLI_OUTPUT_BYTES,
  USER_AUTH_COMPLETE,
  authorizationCachePath,
  createBoundedCommandRunner,
  parseAuthorizationComplete,
  parseNoWaitResponse,
  runFeishuUserAuth,
  runFeishuUserAuthMain,
  validateRegularExecutable,
} from "../../scripts/feishu-user-auth.mjs";

const temporaryRoots: string[] = [];
const missingScopes = Object.freeze([
  "calendar:calendar.event:create",
  "minutes:minutes.search:read",
]);

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ea-user-auth-test-")));
  temporaryRoots.push(root);
  chmodSync(root, 0o700);
  return root;
}

function generatedOpaqueValue(): string {
  return randomBytes(24).toString("base64url");
}

function noWaitPayload(
  deviceCode: string,
  verificationUrl = AUTHORIZATION_ORIGIN,
) {
  return Buffer.from(
    JSON.stringify({
      verification_url: verificationUrl,
      device_code: deviceCode,
      expires_in: 600,
      hint: "opaque",
    }),
    "utf8",
  );
}

function authorizationCompletePayload() {
  const principal = generatedOpaqueValue();
  return Buffer.from(
    JSON.stringify({
      event: "authorization_complete",
      user_open_id: principal,
      user_name: generatedOpaqueValue(),
      scope: missingScopes.join(" "),
      requested: [...missingScopes],
      newly_granted: [...missingScopes],
      already_granted: [],
      missing: [],
      granted: [...missingScopes],
    }),
    "utf8",
  );
}

function writeOwnedScopeCache(
  larkHome: string,
  deviceCode: string,
  scopes = missingScopes,
) {
  const cachePath = authorizationCachePath(larkHome, deviceCode);
  mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(cachePath), 0o700);
  writeFileSync(
    cachePath,
    JSON.stringify({ requested_scope: scopes.join(" ") }),
    { mode: 0o600 },
  );
  chmodSync(cachePath, 0o600);
  return cachePath;
}

function flowLockPath(larkHome: string): string {
  return join(
    larkHome,
    ".lark-cli",
    "cache",
    "executive-assistant-user-auth.lock",
  );
}

function controlledChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal: string) => boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const killedSignals: string[] = [];
  child.kill = (signal: string) => {
    killedSignals.push(signal);
    return true;
  };
  return { child, killedSignals };
}

function successfulFixture(
  options: {
    deviceCode?: string;
    noWait?: Buffer;
    noWaitStatus?: number;
    createNoWaitCache?: boolean;
    poll?: Buffer;
    pollStatus?: number;
    openerStatus?: number;
    gui?: boolean;
    verificationUrl?: string;
    abortSignal?: AbortSignal;
    cacheScopes?: readonly string[];
    mutateNoWaitCache?: (cachePath: string) => void;
    waitForAbortDuringPoll?: boolean;
    mutateCacheDuringPoll?: (cachePath: string) => void;
  } = {},
) {
  const root = temporaryRoot();
  const larkHome = join(root, "lark-home");
  const larkCliPath = join(root, "private-bin", "lark-cli");
  const deviceCode = options.deviceCode ?? generatedOpaqueValue();
  mkdirSync(dirname(larkCliPath), { recursive: true, mode: 0o700 });
  writeFileSync(larkCliPath, "", { mode: 0o500 });
  chmodSync(larkCliPath, 0o500);
  mkdirSync(larkHome, { mode: 0o700 });
  const calls: Array<{
    executable: string;
    args: readonly string[];
    environment: Readonly<Record<string, string>>;
  }> = [];
  const messages: string[] = [];
  const runCommand = async (request: {
    executable: string;
    args: readonly string[];
    environment: Readonly<Record<string, string>>;
  }) => {
    calls.push(request);
    if (request.args.includes("--no-wait")) {
      if (options.createNoWaitCache !== false) {
        const cachePath = writeOwnedScopeCache(
          larkHome,
          deviceCode,
          options.cacheScopes ?? missingScopes,
        );
        options.mutateNoWaitCache?.(cachePath);
      }
      return {
        status: options.noWaitStatus ?? 0,
        stdout:
          options.noWait ??
          noWaitPayload(
            deviceCode,
            options.verificationUrl ?? AUTHORIZATION_ORIGIN,
          ),
        stderr: Buffer.alloc(0),
      };
    }
    if (request.executable === "/usr/bin/open") {
      return {
        status: options.openerStatus ?? 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      };
    }
    if (options.waitForAbortDuringPoll) {
      await new Promise<void>((resolvePromise) => {
        options.abortSignal?.addEventListener("abort", () => resolvePromise(), {
          once: true,
        });
      });
      return {
        status: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      };
    }
    options.mutateCacheDuringPoll?.(
      authorizationCachePath(larkHome, deviceCode),
    );
    if ((options.pollStatus ?? 0) === 0) {
      rmSync(authorizationCachePath(larkHome, deviceCode), { force: true });
    }
    return {
      status: options.pollStatus ?? 0,
      stdout: options.poll ?? authorizationCompletePayload(),
      stderr: Buffer.alloc(0),
    };
  };
  return {
    calls,
    deviceCode,
    larkCliPath,
    larkHome,
    messages,
    dependencies: {
      abortSignal: options.abortSignal,
      emit: (message: string) => messages.push(message),
      hasGuiSession: async () => options.gui ?? true,
      runCommand,
    },
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("validated Feishu user authorization", () => {
  it("presents exactly one validated URL event and one terminal event in stdout-json mode without opening a browser", async () => {
    const verificationUrl = new URL(AUTHORIZATION_ORIGIN);
    verificationUrl.pathname = `/${generatedOpaqueValue()}`;
    verificationUrl.searchParams.set("state", generatedOpaqueValue());
    const fixture = successfulFixture({
      gui: false,
      verificationUrl: verificationUrl.href,
    });

    const result = await runFeishuUserAuth(
      {
        larkCliPath: fixture.larkCliPath,
        larkHome: fixture.larkHome,
        missingScopes,
        presenter: "stdout-json",
      },
      fixture.dependencies,
    );

    expect(result).toBe(USER_AUTH_COMPLETE);
    expect(fixture.calls).toHaveLength(2);
    expect(
      fixture.calls.some((call) => call.executable === "/usr/bin/open"),
    ).toBe(false);
    expect(fixture.messages).toEqual([
      JSON.stringify({
        event: "authorization_url",
        url: verificationUrl.href,
      }),
      JSON.stringify({
        event: "authorization_result",
        status: "complete",
      }),
    ]);
    const publicSurface = fixture.messages.join("\n");
    expect(publicSurface).not.toContain(fixture.deviceCode);
    expect(publicSurface).not.toContain(
      authorizationCachePath(fixture.larkHome, fixture.deviceCode),
    );
  });

  it("emits one blocked terminal event and no browser call when stdout-json polling fails", async () => {
    const fixture = successfulFixture({
      gui: false,
      pollStatus: 1,
    });

    const result = await runFeishuUserAuth(
      {
        larkCliPath: fixture.larkCliPath,
        larkHome: fixture.larkHome,
        missingScopes,
        presenter: "stdout-json",
      },
      fixture.dependencies,
    );

    expect(result).toBe(BLOCKED_USER_AUTH);
    expect(fixture.calls).toHaveLength(2);
    expect(
      fixture.calls.some((call) => call.executable === "/usr/bin/open"),
    ).toBe(false);
    expect(fixture.messages).toHaveLength(2);
    expect(JSON.parse(fixture.messages[0]!)).toMatchObject({
      event: "authorization_url",
    });
    expect(fixture.messages[1]).toBe(
      JSON.stringify({
        event: "authorization_result",
        status: "blocked",
      }),
    );
    const publicSurface = fixture.messages.join("\n");
    expect(publicSurface).not.toContain(fixture.deviceCode);
    expect(publicSurface).not.toContain(
      authorizationCachePath(fixture.larkHome, fixture.deviceCode),
    );
  });

  it("loads the ordered scope allowlist before invoking stdout-json authorization", async () => {
    const runtime = new EventEmitter() as EventEmitter & {
      exitCode?: number;
      stdout: { write: (value: string) => boolean };
      stderr: { write: (value: string) => boolean };
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    runtime.stdout = {
      write: (value) => {
        stdout.push(value);
        return true;
      },
    };
    runtime.stderr = {
      write: (value) => {
        stderr.push(value);
        return true;
      },
    };
    let observedInput: unknown;

    await runFeishuUserAuthMain({
      argv: [
        "--presenter",
        "stdout-json",
        "--scope-contract",
        join(process.cwd(), "config", "feishu-scopes.json"),
        "--scope-contract-sha256",
        "40f77b8df33af965544046313016116fd2a249afaed2d96044649863568db93e",
        "/fixed/lark-cli",
        "/fixed/lark-home",
        ...missingScopes,
      ],
      processLike: runtime,
      authorize: async (input: unknown) => {
        observedInput = input;
        return USER_AUTH_COMPLETE;
      },
    });

    expect(observedInput).toEqual({
      larkCliPath: "/fixed/lark-cli",
      larkHome: "/fixed/lark-home",
      missingScopes,
      presenter: "stdout-json",
    });
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
    expect(runtime.exitCode).toBeUndefined();
  });

  it("fails closed before authorization when a requested scope is outside the shared contract", async () => {
    const runtime = new EventEmitter() as EventEmitter & {
      exitCode?: number;
      stdout: { write: (value: string) => boolean };
      stderr: { write: (value: string) => boolean };
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    runtime.stdout = {
      write: (value) => {
        stdout.push(value);
        return true;
      },
    };
    runtime.stderr = {
      write: (value) => {
        stderr.push(value);
        return true;
      },
    };
    let authorizeCalls = 0;

    await runFeishuUserAuthMain({
      argv: [
        "--presenter",
        "stdout-json",
        "--scope-contract",
        join(process.cwd(), "config", "feishu-scopes.json"),
        "--scope-contract-sha256",
        "40f77b8df33af965544046313016116fd2a249afaed2d96044649863568db93e",
        "/fixed/lark-cli",
        "/fixed/lark-home",
        "calendar:calendar.event:delete",
      ],
      processLike: runtime,
      authorize: async () => {
        authorizeCalls += 1;
        return USER_AUTH_COMPLETE;
      },
    });

    expect(authorizeCalls).toBe(0);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([`${BLOCKED_USER_AUTH}\n`]);
    expect(runtime.exitCode).toBe(1);
  });

  it("owns no-wait, validated browser launch, and device polling without returning temporary values to zsh", async () => {
    const verificationUrl = new URL(AUTHORIZATION_ORIGIN);
    verificationUrl.pathname = `/${generatedOpaqueValue()}`;
    verificationUrl.searchParams.set("state", generatedOpaqueValue());
    const fixture = successfulFixture({
      verificationUrl: verificationUrl.href,
    });
    const result = await runFeishuUserAuth(
      {
        larkCliPath: fixture.larkCliPath,
        larkHome: fixture.larkHome,
        missingScopes,
      },
      fixture.dependencies,
    );

    expect(fixture.calls).toHaveLength(3);
    expect(fixture.messages).toEqual([BROWSER_OPENED_MESSAGE]);
    expect(result).toBe(USER_AUTH_COMPLETE);
    expect(fixture.calls[0]?.executable).toBe(fixture.larkCliPath);
    expect(fixture.calls[0]?.args).toEqual([
      "--profile",
      "executive-assistant",
      "auth",
      "login",
      "--scope",
      missingScopes.join(" "),
      "--no-wait",
      "--json",
    ]);
    expect(fixture.calls[1]).toMatchObject({
      executable: "/usr/bin/open",
      args: ["--", verificationUrl.href],
    });
    expect(fixture.calls[2]?.executable).toBe(fixture.larkCliPath);
    expect(fixture.calls[2]?.args).toEqual([
      "--profile",
      "executive-assistant",
      "auth",
      "login",
      "--device-code",
      fixture.deviceCode,
      "--json",
    ]);
    expect(
      existsSync(authorizationCachePath(fixture.larkHome, fixture.deviceCode)),
    ).toBe(false);
    const publicSurface = `${result}\n${fixture.messages.join("\n")}`;
    expect(publicSurface).not.toContain(fixture.deviceCode);
    expect(publicSurface).not.toContain(verificationUrl.href);
  });

  it("accepts only fatal UTF-8 exact-schema no-wait JSON and rejects accessors or proxies", () => {
    const deviceCode = generatedOpaqueValue();
    expect(parseNoWaitResponse(noWaitPayload(deviceCode))).toMatchObject({
      verificationUrl: AUTHORIZATION_ORIGIN,
      deviceCode,
      expiresIn: 600,
    });
    for (const input of [
      Buffer.from([0xff]),
      Buffer.alloc(MAX_CLI_OUTPUT_BYTES + 1, 0x20),
      Buffer.from(
        `{"verification_url":${JSON.stringify(AUTHORIZATION_ORIGIN)},"device_code":${JSON.stringify(deviceCode)},"expires_in":600,"hint":"a","hint":"b"}`,
      ),
      Buffer.from(
        JSON.stringify({
          verification_url: AUTHORIZATION_ORIGIN,
          device_code: deviceCode,
          expires_in: 600,
          hint: "opaque",
          extra: "opaque",
        }),
      ),
    ]) {
      expect(() => parseNoWaitResponse(input)).toThrow("AUTH_OUTPUT_INVALID");
    }
    const accessor = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries({
      verification_url: AUTHORIZATION_ORIGIN,
      device_code: deviceCode,
      expires_in: 600,
      hint: "opaque",
    })) {
      Object.defineProperty(accessor, key, {
        enumerable: true,
        ...(key === "device_code" ? { get: () => value } : { value }),
      });
    }
    expect(() => parseNoWaitResponse(accessor)).toThrow("AUTH_OUTPUT_INVALID");
    expect(() =>
      parseNoWaitResponse(
        new Proxy(
          {
            verification_url: AUTHORIZATION_ORIGIN,
            device_code: deviceCode,
            expires_in: 600,
            hint: "opaque",
          },
          {},
        ),
      ),
    ).toThrow("AUTH_OUTPUT_INVALID");
  });

  it("allows only the exact Feishu HTTPS origin without credentials, controls, fragments, or non-default ports", () => {
    const deviceCode = generatedOpaqueValue();
    const invalidUrls = [
      (() => {
        const value = new URL(AUTHORIZATION_ORIGIN);
        value.protocol = "http:";
        return value.href;
      })(),
      (() => {
        const value = new URL(AUTHORIZATION_ORIGIN);
        value.hostname = ["untrusted", "invalid"].join(".");
        return value.href;
      })(),
      (() => {
        const value = new URL(AUTHORIZATION_ORIGIN);
        value.username = "opaque";
        return value.href;
      })(),
      (() => {
        const value = new URL(AUTHORIZATION_ORIGIN);
        value.hash = "opaque";
        return value.href;
      })(),
      `${AUTHORIZATION_ORIGIN}\n`,
      `${AUTHORIZATION_ORIGIN}\0`,
      (() => {
        const value = new URL(AUTHORIZATION_ORIGIN);
        value.port = "444";
        return value.href;
      })(),
    ];
    for (const verificationUrl of invalidUrls) {
      expect(() =>
        parseNoWaitResponse(noWaitPayload(deviceCode, verificationUrl)),
      ).toThrow("AUTH_OUTPUT_INVALID");
    }
  });

  it("rejects raw URL parser-confusion forms before URL parsing", () => {
    const deviceCode = generatedOpaqueValue();
    const invalidUrls = [
      `${AUTHORIZATION_ORIGIN}:443`,
      AUTHORIZATION_ORIGIN.replace("://", "://@"),
      AUTHORIZATION_ORIGIN.replace("://", "://opaque@"),
      `${AUTHORIZATION_ORIGIN}#`,
      `${AUTHORIZATION_ORIGIN}\\opaque`,
      `${AUTHORIZATION_ORIGIN}/\ud800`,
      `${AUTHORIZATION_ORIGIN}/\u0085`,
      `${AUTHORIZATION_ORIGIN}/\u200b`,
      `${AUTHORIZATION_ORIGIN}/\u2028`,
      `${AUTHORIZATION_ORIGIN}/\u2029`,
      `${AUTHORIZATION_ORIGIN}/\u00a0`,
      `${AUTHORIZATION_ORIGIN}/\u1680`,
    ];
    for (const verificationUrl of invalidUrls) {
      expect(() =>
        parseNoWaitResponse(noWaitPayload(deviceCode, verificationUrl)),
      ).toThrow("AUTH_OUTPUT_INVALID");
    }
    for (const verificationUrl of [
      AUTHORIZATION_ORIGIN,
      `${AUTHORIZATION_ORIGIN}/`,
      `${AUTHORIZATION_ORIGIN}?opaque`,
      `${AUTHORIZATION_ORIGIN}/opaque?opaque`,
    ]) {
      expect(
        parseNoWaitResponse(noWaitPayload(deviceCode, verificationUrl))
          .verificationUrl,
      ).toBe(verificationUrl);
    }
  });

  it("accepts only the verified authorization_complete contract with zero missing scopes", () => {
    expect(
      parseAuthorizationComplete(authorizationCompletePayload(), missingScopes),
    ).toBe(USER_AUTH_COMPLETE);

    const principal = generatedOpaqueValue();
    const warningPayload = Buffer.from(
      JSON.stringify({
        event: "authorization_complete",
        user_open_id: principal,
        user_name: generatedOpaqueValue(),
        scope: missingScopes.join(" "),
        requested: [...missingScopes],
        newly_granted: [],
        already_granted: [],
        missing: [missingScopes[0]],
        granted: [...missingScopes],
        warning: {
          type: "missing_scope",
          message: "opaque",
          hint: "opaque",
        },
      }),
    );
    expect(() =>
      parseAuthorizationComplete(warningPayload, missingScopes),
    ).toThrow("AUTH_OUTPUT_INVALID");
  });

  it("rejects unknown, duplicate, or out-of-order scopes before invoking the CLI", async () => {
    const invalidScopeSets = [
      ["calendar:calendar.event:create", "unknown:scope"],
      ["minutes:minutes.search:read", "calendar:calendar.event:create"],
      ["calendar:calendar.event:create", "calendar:calendar.event:create"],
    ];
    for (const invalidScopes of invalidScopeSets) {
      const fixture = successfulFixture();
      await expect(
        runFeishuUserAuth(
          {
            larkCliPath: fixture.larkCliPath,
            larkHome: fixture.larkHome,
            missingScopes: invalidScopes,
          },
          fixture.dependencies,
        ),
      ).resolves.toBe(BLOCKED_USER_AUTH);
      expect(fixture.calls).toEqual([]);
    }
  });

  it("does not resolve a killed bounded child until close is observed", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (signal: string) => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let killedWith = "";
    child.kill = (signal: string) => {
      killedWith = signal;
      return true;
    };
    const runner = createBoundedCommandRunner(() => child);
    let settled = false;
    const pending = runner({
      executable: "/fixed/executable",
      args: [],
      environment: {},
      timeoutMs: 5,
    }).then((result: unknown) => {
      settled = true;
      return result;
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    expect(killedWith).toBe("SIGKILL");
    expect(settled).toBe(false);
    child.emit("close", null);
    await expect(pending).resolves.toMatchObject({ status: 1 });
  });

  it("drops a single oversized output chunk and waits for close before resolving", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (signal: string) => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let killedWith = "";
    child.kill = (signal: string) => {
      killedWith = signal;
      return true;
    };
    const runner = createBoundedCommandRunner(() => child);
    let settled = false;
    const pending = runner({
      executable: "/fixed/executable",
      args: [],
      environment: {},
      timeoutMs: 1_000,
    }).then((result) => {
      settled = true;
      return result;
    });
    child.stdout.write(Buffer.alloc(MAX_CLI_OUTPUT_BYTES + 1, 0x61));
    expect(killedWith).toBe("SIGKILL");
    expect(settled).toBe(false);
    child.emit("close", null);
    await expect(pending).resolves.toMatchObject({
      status: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
  });

  it("treats child error as forced failure but settles only after close", async () => {
    const { child, killedSignals } = controlledChild();
    const runner = createBoundedCommandRunner(() => child);
    let settled = false;
    const pending = runner({
      executable: "/fixed/executable",
      args: [],
      environment: {},
      timeoutMs: 1_000,
    }).then((result) => {
      settled = true;
      return result;
    });
    child.emit("error", new Error("opaque"));
    expect(killedSignals).toEqual(["SIGKILL"]);
    expect(settled).toBe(false);
    child.emit("close", null);
    await expect(pending).resolves.toMatchObject({
      status: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
  });

  it("treats either pipe error as forced failure but settles only after close", async () => {
    for (const pipeName of ["stdout", "stderr"] as const) {
      const { child, killedSignals } = controlledChild();
      const runner = createBoundedCommandRunner(() => child);
      let settled = false;
      const pending = runner({
        executable: "/fixed/executable",
        args: [],
        environment: {},
        timeoutMs: 1_000,
      }).then((result) => {
        settled = true;
        return result;
      });
      expect(() =>
        child[pipeName].emit("error", new Error("opaque")),
      ).not.toThrow();
      expect(killedSignals).toEqual(["SIGKILL"]);
      expect(settled).toBe(false);
      child.emit("close", null);
      await expect(pending).resolves.toMatchObject({
        status: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      });
    }
  });

  it("keeps abort pending until close and ignores repeated abort attempts", async () => {
    const { child, killedSignals } = controlledChild();
    const controller = new AbortController();
    const runner = createBoundedCommandRunner(() => child);
    let settled = false;
    const pending = runner({
      executable: "/fixed/executable",
      args: [],
      environment: {},
      timeoutMs: 1_000,
      abortSignal: controller.signal,
    }).then((result) => {
      settled = true;
      return result;
    });
    controller.abort();
    controller.abort();
    expect(killedSignals).toEqual(["SIGKILL"]);
    expect(settled).toBe(false);
    child.emit("close", null);
    await expect(pending).resolves.toMatchObject({ status: 1 });
  });

  it("runs real local Node children through the default bounded close gate", async () => {
    const runner = createBoundedCommandRunner();
    const environment = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C",
      LC_ALL: "C",
    };
    const normal = await runner({
      executable: process.execPath,
      args: ["-e", 'process.stdout.write("ok")'],
      environment,
      timeoutMs: 5_000,
    });
    expect(normal).toMatchObject({
      status: 0,
      stdout: Buffer.from("ok"),
      stderr: Buffer.alloc(0),
    });
    const overflow = await runner({
      executable: process.execPath,
      args: [
        "-e",
        `process.stdout.write(Buffer.alloc(${MAX_CLI_OUTPUT_BYTES + 1}, 97))`,
      ],
      environment,
      timeoutMs: 5_000,
    });
    expect(overflow).toMatchObject({
      status: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    const timeout = await runner({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      environment,
      timeoutMs: 20,
    });
    expect(timeout).toMatchObject({
      status: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
  });

  it("fails closed for no GUI, opener failure, CLI failure, and malformed poll output without fallback or leakage", async () => {
    const fixtures = [
      successfulFixture({ gui: false }),
      successfulFixture({ openerStatus: 1 }),
      successfulFixture({ pollStatus: 1 }),
      successfulFixture({ poll: Buffer.from([0xff]) }),
      successfulFixture({
        poll: Buffer.alloc(MAX_CLI_OUTPUT_BYTES + 1, 0x20),
      }),
    ];
    for (const fixture of fixtures) {
      const result = await runFeishuUserAuth(
        {
          larkCliPath: fixture.larkCliPath,
          larkHome: fixture.larkHome,
          missingScopes,
        },
        fixture.dependencies,
      );
      expect(result).toBe(BLOCKED_USER_AUTH);
      expect(
        existsSync(
          authorizationCachePath(fixture.larkHome, fixture.deviceCode),
        ),
      ).toBe(false);
      const publicSurface = `${result}\n${fixture.messages.join("\n")}`;
      expect(publicSurface).not.toContain(fixture.deviceCode);
      expect(publicSurface).not.toContain(AUTHORIZATION_ORIGIN);
      expect(publicSurface).not.toContain("opaque");
    }
  });

  it("rejects authorization_complete plus missing-scope warning when the CLI exits nonzero", async () => {
    const principal = generatedOpaqueValue();
    const fixture = successfulFixture({
      pollStatus: 4,
      poll: Buffer.from(
        JSON.stringify({
          event: "authorization_complete",
          user_open_id: principal,
          user_name: generatedOpaqueValue(),
          scope: missingScopes.join(" "),
          requested: [...missingScopes],
          newly_granted: [],
          already_granted: [],
          missing: [missingScopes[0]],
          granted: [...missingScopes],
          warning: {
            type: "missing_scope",
            message: "opaque",
            hint: "opaque",
          },
        }),
      ),
    });
    await expect(
      runFeishuUserAuth(
        {
          larkCliPath: fixture.larkCliPath,
          larkHome: fixture.larkHome,
          missingScopes,
        },
        fixture.dependencies,
      ),
    ).resolves.toBe(BLOCKED_USER_AUTH);
  });

  it("blocks before the CLI when the scope-cache baseline is nonempty and preserves every byte", async () => {
    const fixture = successfulFixture();
    const baselinePath = writeOwnedScopeCache(
      fixture.larkHome,
      generatedOpaqueValue(),
      ["contact:user:search"],
    );
    const baselineBytes = readFileSync(baselinePath);
    await expect(
      runFeishuUserAuth(
        {
          larkCliPath: fixture.larkCliPath,
          larkHome: fixture.larkHome,
          missingScopes,
        },
        fixture.dependencies,
      ),
    ).resolves.toBe(BLOCKED_USER_AUTH);
    expect(fixture.calls).toEqual([]);
    expect(readFileSync(baselinePath)).toEqual(baselineBytes);
    expect(existsSync(flowLockPath(fixture.larkHome))).toBe(false);
  });

  it("never takes over or deletes an existing user-auth flow lock", async () => {
    const fixture = successfulFixture();
    const lockPath = flowLockPath(fixture.larkHome);
    mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    chmodSync(lockPath, 0o700);
    const sentinelPath = join(lockPath, "sentinel");
    writeFileSync(sentinelPath, "opaque", { mode: 0o600 });
    await expect(
      runFeishuUserAuth(
        {
          larkCliPath: fixture.larkCliPath,
          larkHome: fixture.larkHome,
          missingScopes,
        },
        fixture.dependencies,
      ),
    ).resolves.toBe(BLOCKED_USER_AUTH);
    expect(fixture.calls).toEqual([]);
    expect(readFileSync(sentinelPath, "utf8")).toBe("opaque");
  });

  it("cleans one exact new cache entry after malformed or nonzero no-wait output while holding its own flow lock", async () => {
    for (const fixture of [
      successfulFixture({ noWait: Buffer.from("{}") }),
      successfulFixture({ noWaitStatus: 7 }),
    ]) {
      await expect(
        runFeishuUserAuth(
          {
            larkCliPath: fixture.larkCliPath,
            larkHome: fixture.larkHome,
            missingScopes,
          },
          fixture.dependencies,
        ),
      ).resolves.toBe(BLOCKED_USER_AUTH);
      expect(
        existsSync(
          authorizationCachePath(fixture.larkHome, fixture.deviceCode),
        ),
      ).toBe(false);
      expect(existsSync(flowLockPath(fixture.larkHome))).toBe(false);
    }
  });

  it("confirms an empty cache after malformed no-wait output and releases only its own lock", async () => {
    const fixture = successfulFixture({
      createNoWaitCache: false,
      noWait: Buffer.from("{}"),
    });
    await expect(
      runFeishuUserAuth(
        {
          larkCliPath: fixture.larkCliPath,
          larkHome: fixture.larkHome,
          missingScopes,
        },
        fixture.dependencies,
      ),
    ).resolves.toBe(BLOCKED_USER_AUTH);
    expect(fixture.calls).toHaveLength(1);
    expect(existsSync(flowLockPath(fixture.larkHome))).toBe(false);
  });

  it("does not delete ambiguous multiple new cache entries", async () => {
    const fixture = successfulFixture({
      createNoWaitCache: false,
      noWait: Buffer.from("{}"),
    });
    const firstCode = generatedOpaqueValue();
    const secondCode = generatedOpaqueValue();
    fixture.dependencies.runCommand = async (request: {
      executable: string;
      args: readonly string[];
      environment: Readonly<Record<string, string>>;
    }) => {
      fixture.calls.push(request);
      writeOwnedScopeCache(fixture.larkHome, firstCode);
      writeOwnedScopeCache(fixture.larkHome, secondCode);
      return {
        status: 1,
        stdout: Buffer.from("{}"),
        stderr: Buffer.alloc(0),
      };
    };
    await expect(
      runFeishuUserAuth(
        {
          larkCliPath: fixture.larkCliPath,
          larkHome: fixture.larkHome,
          missingScopes,
        },
        fixture.dependencies,
      ),
    ).resolves.toBe(BLOCKED_USER_AUTH);
    expect(
      existsSync(authorizationCachePath(fixture.larkHome, firstCode)),
    ).toBe(true);
    expect(
      existsSync(authorizationCachePath(fixture.larkHome, secondCode)),
    ).toBe(true);
    expect(existsSync(flowLockPath(fixture.larkHome))).toBe(false);
  });

  it("requires the owned cache entry to be a canonical regular 0600 file with the exact requested scope", async () => {
    const fixture = successfulFixture({
      cacheScopes: ["contact:user:search"],
    });
    const cachePath = authorizationCachePath(
      fixture.larkHome,
      fixture.deviceCode,
    );
    await expect(
      runFeishuUserAuth(
        {
          larkCliPath: fixture.larkCliPath,
          larkHome: fixture.larkHome,
          missingScopes,
        },
        fixture.dependencies,
      ),
    ).resolves.toBe(BLOCKED_USER_AUTH);
    expect(fixture.calls).toHaveLength(1);
    expect(existsSync(cachePath)).toBe(true);
  });

  it("leaves wrong-mode, symlinked, or oversized new cache entries untouched", async () => {
    const fixtures = [
      successfulFixture({
        mutateNoWaitCache: (cachePath) => chmodSync(cachePath, 0o644),
      }),
      successfulFixture({
        mutateNoWaitCache: (cachePath) => {
          const target = join(dirname(cachePath), "..", generatedOpaqueValue());
          writeFileSync(
            target,
            JSON.stringify({ requested_scope: missingScopes.join(" ") }),
            { mode: 0o600 },
          );
          rmSync(cachePath);
          symlinkSync(target, cachePath);
        },
      }),
      successfulFixture({
        mutateNoWaitCache: (cachePath) =>
          writeFileSync(
            cachePath,
            Buffer.alloc(MAX_CLI_OUTPUT_BYTES + 1, 0x61),
          ),
      }),
    ];
    for (const fixture of fixtures) {
      const cachePath = authorizationCachePath(
        fixture.larkHome,
        fixture.deviceCode,
      );
      await expect(
        runFeishuUserAuth(
          {
            larkCliPath: fixture.larkCliPath,
            larkHome: fixture.larkHome,
            missingScopes,
          },
          fixture.dependencies,
        ),
      ).resolves.toBe(BLOCKED_USER_AUTH);
      expect(existsSync(cachePath)).toBe(true);
      expect(fixture.calls).toHaveLength(1);
      expect(existsSync(flowLockPath(fixture.larkHome))).toBe(false);
    }
  });

  it("does not delete an owned cache path that grows or is replaced before cleanup", async () => {
    const growingFixture = successfulFixture({
      pollStatus: 1,
      mutateCacheDuringPoll: (cachePath) => {
        appendFileSync(cachePath, Buffer.alloc(MAX_CLI_OUTPUT_BYTES + 1, 0x61));
      },
    });
    const replacingFixture = successfulFixture({
      pollStatus: 1,
      mutateCacheDuringPoll: (cachePath) => {
        rmSync(cachePath);
        writeFileSync(
          cachePath,
          JSON.stringify({ requested_scope: missingScopes.join(" ") }),
          { mode: 0o600 },
        );
        chmodSync(cachePath, 0o600);
      },
    });
    for (const fixture of [growingFixture, replacingFixture]) {
      await expect(
        runFeishuUserAuth(
          {
            larkCliPath: fixture.larkCliPath,
            larkHome: fixture.larkHome,
            missingScopes,
          },
          fixture.dependencies,
        ),
      ).resolves.toBe(BLOCKED_USER_AUTH);
      expect(
        existsSync(
          authorizationCachePath(fixture.larkHome, fixture.deviceCode),
        ),
      ).toBe(true);
      expect(existsSync(flowLockPath(fixture.larkHome))).toBe(false);
    }
  });

  it("does not remove a replacement flow lock after losing its recorded identity", async () => {
    let observedOwnedLock = false;
    let replacementSentinel = "";
    const fixture = successfulFixture({
      pollStatus: 1,
      mutateCacheDuringPoll: () => {
        const lockPath = flowLockPath(fixture.larkHome);
        observedOwnedLock = existsSync(lockPath);
        rmSync(lockPath, { recursive: true, force: true });
        mkdirSync(lockPath, { recursive: true, mode: 0o700 });
        chmodSync(lockPath, 0o700);
        replacementSentinel = join(lockPath, "replacement");
        writeFileSync(replacementSentinel, "opaque", { mode: 0o600 });
      },
    });
    await expect(
      runFeishuUserAuth(
        {
          larkCliPath: fixture.larkCliPath,
          larkHome: fixture.larkHome,
          missingScopes,
        },
        fixture.dependencies,
      ),
    ).resolves.toBe(BLOCKED_USER_AUTH);
    expect(observedOwnedLock).toBe(true);
    expect(readFileSync(replacementSentinel, "utf8")).toBe("opaque");
  });

  it("aborts the active poll, waits for its fixed result, and cleans only the owned cache", async () => {
    const controller = new AbortController();
    const fixture = successfulFixture({
      abortSignal: controller.signal,
      waitForAbortDuringPoll: true,
    });
    const pending = runFeishuUserAuth(
      {
        larkCliPath: fixture.larkCliPath,
        larkHome: fixture.larkHome,
        missingScopes,
      },
      fixture.dependencies,
    );
    for (
      let attempt = 0;
      attempt < 100 &&
      !fixture.calls.some((call) => call.args.includes("--device-code"));
      attempt += 1
    ) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
    }
    expect(
      fixture.calls.some((call) => call.args.includes("--device-code")),
    ).toBe(true);
    controller.abort();
    await expect(pending).resolves.toBe(BLOCKED_USER_AUTH);
    expect(
      existsSync(authorizationCachePath(fixture.larkHome, fixture.deviceCode)),
    ).toBe(false);
  });

  it("keeps persistent SIGINT, SIGTERM, and SIGHUP handlers until authorization cleanup completes", async () => {
    const module = await import("../../scripts/feishu-user-auth.mjs");
    const main = Reflect.get(module, "runFeishuUserAuthMain") as unknown;
    expect(typeof main).toBe("function");
    if (typeof main !== "function") return;

    const runtime = new EventEmitter() as EventEmitter & {
      exitCode?: number;
      stderr: { write: (value: string) => boolean };
    };
    const stderr: string[] = [];
    runtime.stderr = {
      write: (value) => {
        stderr.push(value);
        return true;
      },
    };
    let observedSignal: AbortSignal | undefined;
    let observedInput: unknown;
    let finishAuthorization: (() => void) | undefined;
    const authorizationPending = new Promise<void>((resolvePromise) => {
      finishAuthorization = resolvePromise;
    });
    const pending = Reflect.apply(main, undefined, [
      {
        argv: [
          "--presenter",
          "browser",
          "--scope-contract",
          join(process.cwd(), "config", "feishu-scopes.json"),
          "--scope-contract-sha256",
          "40f77b8df33af965544046313016116fd2a249afaed2d96044649863568db93e",
          "/fixed/lark-cli",
          "/fixed/lark-home",
          ...missingScopes,
        ],
        processLike: runtime,
        authorize: async (
          input: unknown,
          dependencies: { abortSignal?: AbortSignal },
        ) => {
          observedInput = input;
          observedSignal = dependencies.abortSignal;
          await authorizationPending;
          return BLOCKED_USER_AUTH;
        },
      },
    ]) as Promise<void>;
    await Promise.resolve();
    expect(runtime.listenerCount("SIGINT")).toBe(1);
    expect(runtime.listenerCount("SIGTERM")).toBe(1);
    expect(runtime.listenerCount("SIGHUP")).toBe(1);
    expect(observedInput).toEqual({
      larkCliPath: "/fixed/lark-cli",
      larkHome: "/fixed/lark-home",
      missingScopes,
      presenter: "browser",
    });
    runtime.emit("SIGHUP");
    runtime.emit("SIGINT");
    runtime.emit("SIGTERM");
    runtime.emit("SIGHUP");
    expect(observedSignal?.aborted).toBe(true);
    expect(runtime.listenerCount("SIGHUP")).toBe(1);
    expect(stderr).toEqual([]);
    finishAuthorization?.();
    await pending;
    expect(runtime.listenerCount("SIGINT")).toBe(0);
    expect(runtime.listenerCount("SIGTERM")).toBe(0);
    expect(runtime.listenerCount("SIGHUP")).toBe(0);
    expect(runtime.exitCode).toBe(1);
    expect(stderr).toEqual([`${BLOCKED_USER_AUTH}\n`]);
  });

  it("rejects missing and symlinked executable delivery paths", () => {
    const root = temporaryRoot();
    const executable = join(root, "executable");
    expect(validateRegularExecutable(executable)).toBe(false);
    writeFileSync(executable, "", { mode: 0o500 });
    chmodSync(executable, 0o500);
    expect(validateRegularExecutable(executable)).toBe(true);
    const link = join(root, "link");
    symlinkSync(executable, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(validateRegularExecutable(link)).toBe(false);
  });
});
