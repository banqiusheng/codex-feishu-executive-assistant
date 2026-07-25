import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
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
  sanitizeLoginScopeCacheKey,
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

function successfulFixture(
  options: {
    deviceCode?: string;
    noWait?: Buffer;
    poll?: Buffer;
    pollStatus?: number;
    openerStatus?: number;
    gui?: boolean;
    verificationUrl?: string;
    abortSignal?: AbortSignal;
    cacheScopes?: readonly string[];
    waitForAbortDuringPoll?: boolean;
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
      writeOwnedScopeCache(
        larkHome,
        deviceCode,
        options.cacheScopes ?? missingScopes,
      );
      return {
        status: 0,
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
  it("owns no-wait, validated browser launch, and device polling without returning temporary values to zsh", async () => {
    const verificationUrl = new URL(AUTHORIZATION_ORIGIN);
    verificationUrl.pathname = `/${generatedOpaqueValue()}`;
    verificationUrl.searchParams.set("state", generatedOpaqueValue());
    const fixture = successfulFixture({
      verificationUrl: verificationUrl.href,
    });
    const unrelatedCode = generatedOpaqueValue();
    const unrelatedPath = writeOwnedScopeCache(
      fixture.larkHome,
      unrelatedCode,
      ["contact:user:search"],
    );
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
    expect(readFileSync(unrelatedPath, "utf8")).toContain(
      "contact:user:search",
    );
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

  it("never deletes a baseline cache entry when sanitizer collisions make ownership ambiguous", async () => {
    const root = temporaryRoot();
    const larkHome = join(root, "lark-home");
    const larkCliPath = join(root, "private-bin", "lark-cli");
    const unsafeCode = `${generatedOpaqueValue()}/suffix`;
    const collidingCode = unsafeCode.replace("/", "?");
    expect(sanitizeLoginScopeCacheKey(unsafeCode)).toBe(
      sanitizeLoginScopeCacheKey(collidingCode),
    );
    mkdirSync(dirname(larkCliPath), { recursive: true, mode: 0o700 });
    writeFileSync(larkCliPath, "", { mode: 0o500 });
    mkdirSync(larkHome, { mode: 0o700 });
    const baselinePath = writeOwnedScopeCache(larkHome, collidingCode, [
      "contact:user:search",
    ]);
    const baselineBytes = readFileSync(baselinePath);
    const calls: unknown[] = [];
    const result = await runFeishuUserAuth(
      { larkCliPath, larkHome, missingScopes },
      {
        abortSignal: undefined,
        emit: () => undefined,
        hasGuiSession: async () => true,
        runCommand: async (request: {
          args: readonly string[];
          executable: string;
        }) => {
          calls.push(request);
          return request.args.includes("--no-wait")
            ? {
                status: 0,
                stdout: noWaitPayload(unsafeCode),
                stderr: Buffer.alloc(0),
              }
            : {
                status: 0,
                stdout: Buffer.alloc(0),
                stderr: Buffer.alloc(0),
              };
        },
      },
    );
    expect(result).toBe(BLOCKED_USER_AUTH);
    expect(readFileSync(baselinePath)).toEqual(baselineBytes);
    expect(calls).toHaveLength(1);
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
