import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Readable } from "node:stream";

import type {
  RuntimeUserAuthHelperHandle,
  RuntimeUserAuthorizationInspection,
} from "./user-auth-flow.js";

const PROFILE = "executive-assistant";
const MINIMAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const DEFAULT_INSPECT_TIMEOUT_MS = 30_000;
const DEFAULT_HELPER_TIMEOUT_MS = 660_000;
const TERMINATION_GRACE_MS = 1_000;
const CLOSE_CONFIRMATION_MS = 1_000;
const MAX_SCOPE_CONTRACT_BYTES = 64 * 1024;
const MAX_INSPECT_OUTPUT_BYTES = 64 * 1024;
const MAX_HELPER_STDERR_BYTES = 64 * 1024;
const SCOPE_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const APP_ID_PATTERN = /^cli_[A-Za-z0-9]{8,128}$/u;
const COMMAND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const SHORTCUT_PATTERN = /^\+[a-z][a-z0-9-]{0,63}$/u;

export type InstalledUserAuthSpawnOptions = Readonly<{
  cwd: string;
  env: Readonly<Record<string, string>>;
  shell: false;
  stdio: readonly ["ignore", "pipe", "pipe"];
  windowsHide: true;
}>;

export interface InstalledUserAuthChild {
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  off(event: "error", listener: (error: Error) => void): this;
  off(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type InstalledUserAuthSpawn = (
  command: string,
  args: readonly string[],
  options: InstalledUserAuthSpawnOptions,
) => InstalledUserAuthChild;

export type InstalledUserAuthorizationAdapterOptions = Readonly<{
  scopeContractPath: string;
  scopeContractSha256: string;
  appId: string;
  larkCliPath: string;
  larkHome: string;
  nodePath: string;
  userAuthHelperPath: string;
}>;

export type InstalledUserAuthorizationAdapterDependencies = Readonly<{
  spawn?: InstalledUserAuthSpawn;
  inspectTimeoutMs?: number;
  helperTimeoutMs?: number;
}>;

export type InstalledUserAuthorizationAdapter = Readonly<{
  inspect(): Promise<RuntimeUserAuthorizationInspection>;
  startHelper(
    missingScopes: readonly string[],
  ): Promise<RuntimeUserAuthHelperHandle>;
  close(): Promise<void>;
}>;

type ScopeContract = Readonly<{
  userScopes: readonly string[];
  botScopes: readonly string[];
}>;

type ChildExit = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}>;

type CapturedCommand = Readonly<{
  stdout: Buffer;
  stderr: Buffer;
  exit: ChildExit;
}>;

type ActiveChild = Readonly<{
  stop(): Promise<void>;
}>;

function fixedError(code: string): Error {
  return new Error(code);
}

function canonicalAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 1 &&
    value.length <= 4_096 &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    resolve(value) === value
  );
}

function validDuration(value: unknown, fallback: number): number {
  const duration = value ?? fallback;
  if (
    typeof duration !== "number" ||
    !Number.isSafeInteger(duration) ||
    duration <= 0 ||
    duration > 15 * 60_000
  ) {
    throw fixedError("INSTALLED_USER_AUTH_OPTIONS_INVALID");
  }
  return duration;
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    !left.isSymbolicLink() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function regularInstalledFile(
  path: string,
  options: Readonly<{
    executable: boolean;
    maximumBytes?: number;
  }>,
): Stats {
  const stats = lstatSync(path);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    stats.size < 1 ||
    (options.maximumBytes !== undefined && stats.size > options.maximumBytes) ||
    (options.executable && (stats.mode & 0o111) === 0) ||
    (typeof process.getuid === "function" && stats.uid !== process.getuid()) ||
    realpathSync(path) !== path
  ) {
    throw fixedError("INSTALLED_USER_AUTH_PATH_INVALID");
  }
  return stats;
}

function privateInstalledDirectory(path: string): void {
  const stats = lstatSync(path);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stats.uid !== process.getuid()) ||
    realpathSync(path) !== path
  ) {
    throw fixedError("INSTALLED_USER_AUTH_PATH_INVALID");
  }
}

function exactRootObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).join(",") !== keys.join(",")
  ) {
    throw fixedError("INSTALLED_USER_AUTH_SCOPE_CONTRACT_INVALID");
  }
  return value as Record<string, unknown>;
}

function strictStringArray(
  value: unknown,
  expectedLength: number,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== expectedLength ||
    new Set(value).size !== value.length ||
    value.some(
      (scope) => typeof scope !== "string" || !SCOPE_PATTERN.test(scope),
    )
  ) {
    throw fixedError("INSTALLED_USER_AUTH_SCOPE_CONTRACT_INVALID");
  }
  return Object.freeze([...value] as string[]);
}

function validateShortcuts(value: unknown): void {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== 14
  ) {
    throw fixedError("INSTALLED_USER_AUTH_SCOPE_CONTRACT_INVALID");
  }
  const seen = new Set<string>();
  for (const entry of value) {
    const snapshot = exactRootObject(entry, [
      "identity",
      "command",
      "shortcut",
    ]);
    if (
      (snapshot.identity !== "user" && snapshot.identity !== "bot") ||
      typeof snapshot.command !== "string" ||
      !COMMAND_PATTERN.test(snapshot.command) ||
      typeof snapshot.shortcut !== "string" ||
      !SHORTCUT_PATTERN.test(snapshot.shortcut)
    ) {
      throw fixedError("INSTALLED_USER_AUTH_SCOPE_CONTRACT_INVALID");
    }
    const key = `${snapshot.identity}:${snapshot.command}:${snapshot.shortcut}`;
    if (seen.has(key)) {
      throw fixedError("INSTALLED_USER_AUTH_SCOPE_CONTRACT_INVALID");
    }
    seen.add(key);
  }
}

function readScopeContract(
  path: string,
  expectedSha256: string,
): ScopeContract {
  const before = regularInstalledFile(path, {
    executable: false,
    maximumBytes: MAX_SCOPE_CONTRACT_BYTES,
  });
  let descriptor: number | undefined;
  let bytes: Buffer;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!sameFile(before, opened)) {
      throw fixedError("INSTALLED_USER_AUTH_SCOPE_CONTRACT_INVALID");
    }
    bytes = readFileSync(descriptor);
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(path);
    if (
      !sameFile(before, afterDescriptor) ||
      !sameFile(before, afterPath) ||
      realpathSync(path) !== path
    ) {
      throw fixedError("INSTALLED_USER_AUTH_SCOPE_CONTRACT_INVALID");
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
    throw fixedError("INSTALLED_USER_AUTH_SCOPE_CONTRACT_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw fixedError("INSTALLED_USER_AUTH_SCOPE_CONTRACT_INVALID");
  }
  const root = exactRootObject(parsed, [
    "schemaVersion",
    "userScopes",
    "botScopes",
    "shortcuts",
  ]);
  if (root.schemaVersion !== 1) {
    throw fixedError("INSTALLED_USER_AUTH_SCOPE_CONTRACT_INVALID");
  }
  const userScopes = strictStringArray(root.userScopes, 14);
  const botScopes = strictStringArray(root.botScopes, 4);
  validateShortcuts(root.shortcuts);
  return Object.freeze({ userScopes, botScopes });
}

function environment(home: string): Readonly<Record<string, string>> {
  return Object.freeze({
    HOME: home,
    PATH: MINIMAL_PATH,
    LANG: "C",
    LC_ALL: "C",
  });
}

function spawnOptions(home: string): InstalledUserAuthSpawnOptions {
  return Object.freeze({
    cwd: home,
    env: environment(home),
    shell: false,
    stdio: Object.freeze(["ignore", "pipe", "pipe"] as const),
    windowsHide: true,
  });
}

function validateChild(value: unknown): InstalledUserAuthChild {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as InstalledUserAuthChild).once !== "function" ||
    typeof (value as InstalledUserAuthChild).off !== "function" ||
    typeof (value as InstalledUserAuthChild).kill !== "function" ||
    (value as InstalledUserAuthChild).stdout === null ||
    typeof (value as InstalledUserAuthChild).stdout?.on !== "function" ||
    (value as InstalledUserAuthChild).stderr === null ||
    typeof (value as InstalledUserAuthChild).stderr?.on !== "function"
  ) {
    throw fixedError("INSTALLED_USER_AUTH_SPAWN_FAILED");
  }
  return value as InstalledUserAuthChild;
}

function exactJsonObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  const actual = Object.keys(value);
  const expected = new Set(keys);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !expected.has(key))
  ) {
    return null;
  }
  return value as Record<string, unknown>;
}

function jsonStringArray(
  value: unknown,
  nullable: boolean,
): readonly string[] | null {
  if (nullable && value === null) return null;
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    new Set(value).size !== value.length ||
    value.some(
      (scope) => typeof scope !== "string" || !SCOPE_PATTERN.test(scope),
    )
  ) {
    throw fixedError("INSTALLED_USER_AUTH_CHECK_INVALID");
  }
  return Object.freeze([...value] as string[]);
}

function sameOrdered(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function parseAuthCheck(
  bytes: Buffer,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderr: Buffer,
  userScopes: readonly string[],
): RuntimeUserAuthorizationInspection {
  if (
    signal !== null ||
    (exitCode !== 0 && exitCode !== 1) ||
    stderr.length !== 0
  ) {
    throw fixedError("INSTALLED_USER_AUTH_CHECK_INVALID");
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw fixedError("INSTALLED_USER_AUTH_CHECK_INVALID");
  }
  if (exitCode === 0) {
    const result = exactJsonObject(value, ["granted", "missing", "ok"]);
    const granted =
      result === null ? null : jsonStringArray(result.granted, false);
    if (
      result === null ||
      result.ok !== true ||
      result.missing !== null ||
      granted === null ||
      !sameOrdered(granted, userScopes)
    ) {
      throw fixedError("INSTALLED_USER_AUTH_CHECK_INVALID");
    }
    return Object.freeze({ state: "READY" });
  }

  const tokenMissing = exactJsonObject(value, ["error", "missing", "ok"]);
  if (tokenMissing !== null) {
    const missing = jsonStringArray(tokenMissing.missing, false);
    if (
      tokenMissing.ok !== false ||
      (tokenMissing.error !== "not_logged_in" &&
        tokenMissing.error !== "no_token") ||
      missing === null ||
      !sameOrdered(missing, userScopes)
    ) {
      throw fixedError("INSTALLED_USER_AUTH_CHECK_INVALID");
    }
    return Object.freeze({
      state: "USER_AUTH_REQUIRED",
      missingScopes: Object.freeze([...missing]),
    });
  }

  const partial = exactJsonObject(value, [
    "granted",
    "missing",
    "ok",
    "suggestion",
  ]);
  if (partial === null || partial.ok !== false) {
    throw fixedError("INSTALLED_USER_AUTH_CHECK_INVALID");
  }
  const granted = jsonStringArray(partial.granted, true) ?? [];
  const missing = jsonStringArray(partial.missing, false);
  if (missing === null || missing.length === 0) {
    throw fixedError("INSTALLED_USER_AUTH_CHECK_INVALID");
  }
  const missingSet = new Set(missing);
  const expectedMissing = userScopes.filter((scope) => missingSet.has(scope));
  const expectedGranted = userScopes.filter((scope) => !missingSet.has(scope));
  if (
    !sameOrdered(missing, expectedMissing) ||
    !sameOrdered(granted, expectedGranted) ||
    partial.suggestion !== `lark-cli auth login --scope "${missing.join(" ")}"`
  ) {
    throw fixedError("INSTALLED_USER_AUTH_CHECK_INVALID");
  }
  return Object.freeze({
    state: "USER_AUTH_REQUIRED",
    missingScopes: Object.freeze([...missing]),
  });
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw fixedError("INSTALLED_USER_AUTH_APP_SCOPE_INVALID");
  }
}

function parseUserAppScopes(
  captured: CapturedCommand,
  appId: string,
): readonly string[] {
  if (
    captured.exit.exitCode !== 0 ||
    captured.exit.signal !== null ||
    captured.stderr.toString("utf8") !== "Querying app scopes...\n\n"
  ) {
    throw fixedError("INSTALLED_USER_AUTH_APP_SCOPE_INVALID");
  }
  const result = exactJsonObject(parseJson(captured.stdout), [
    "appId",
    "brand",
    "tokenType",
    "userScopes",
    "count",
  ]);
  const scopes =
    result === null ? null : jsonStringArray(result.userScopes, false);
  if (
    result === null ||
    result.appId !== appId ||
    result.brand !== "feishu" ||
    result.tokenType !== "user" ||
    scopes === null ||
    scopes.length > 4_096 ||
    result.count !== scopes.length
  ) {
    throw fixedError("INSTALLED_USER_AUTH_APP_SCOPE_INVALID");
  }
  return scopes;
}

function parseBotAppScopes(captured: CapturedCommand): readonly string[] {
  if (
    captured.exit.exitCode !== 0 ||
    captured.exit.signal !== null ||
    captured.stderr.length !== 0
  ) {
    throw fixedError("INSTALLED_USER_AUTH_APP_SCOPE_INVALID");
  }
  const root = exactJsonObject(parseJson(captured.stdout), [
    "code",
    "msg",
    "data",
  ]);
  const data = root === null ? null : exactJsonObject(root.data, ["app"]);
  const app =
    data?.app !== null &&
    typeof data?.app === "object" &&
    !Array.isArray(data.app) &&
    Object.getPrototypeOf(data.app) === Object.prototype
      ? (data.app as Record<string, unknown>)
      : null;
  const entries = app?.scopes;
  if (
    root === null ||
    root.code !== 0 ||
    typeof root.msg !== "string" ||
    data === null ||
    app === null ||
    !Array.isArray(entries) ||
    entries.length > 4_096
  ) {
    throw fixedError("INSTALLED_USER_AUTH_APP_SCOPE_INVALID");
  }
  const seen = new Set<string>();
  const botScopes: string[] = [];
  for (const entry of entries) {
    const snapshot = exactJsonObject(entry, ["scope", "token_types"]);
    const tokenTypes =
      snapshot === null ? null : jsonStringArray(snapshot.token_types, false);
    if (
      snapshot === null ||
      typeof snapshot.scope !== "string" ||
      !SCOPE_PATTERN.test(snapshot.scope) ||
      tokenTypes === null ||
      tokenTypes.length < 1 ||
      tokenTypes.length > 2 ||
      tokenTypes.some(
        (tokenType) => tokenType !== "user" && tokenType !== "tenant",
      ) ||
      seen.has(snapshot.scope)
    ) {
      throw fixedError("INSTALLED_USER_AUTH_APP_SCOPE_INVALID");
    }
    seen.add(snapshot.scope);
    if (tokenTypes.includes("tenant")) botScopes.push(snapshot.scope);
  }
  return Object.freeze(botScopes);
}

function signalChild(
  child: InstalledUserAuthChild,
  signal: NodeJS.Signals,
): void {
  try {
    child.kill(signal);
  } catch {
    // A fixed outward failure is produced by the owning monitor.
  }
}

function captureInspection(
  child: InstalledUserAuthChild,
  timeoutMs: number,
  active: Set<ActiveChild>,
): Promise<CapturedCommand> {
  let resolveStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolveValue) => {
    resolveStopped = resolveValue;
  });
  return new Promise((resolveResult, rejectResult) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let failed = false;
    let killTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (closeTimer) clearTimeout(closeTimer);
      child.stdout.off("data", onStdout);
      child.stdout.off("error", onStreamError);
      child.stderr.off("data", onStderr);
      child.stderr.off("error", onStreamError);
      child.off("error", onChildError);
      child.off("close", onClose);
      active.delete(activeChild);
      resolveStopped();
    };
    const rejectFixed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectResult(fixedError("INSTALLED_USER_AUTH_INSPECTION_FAILED"));
    };
    const beginFailure = () => {
      if (failed) return;
      failed = true;
      signalChild(child, "SIGTERM");
      killTimer = setTimeout(() => {
        signalChild(child, "SIGKILL");
        closeTimer = setTimeout(rejectFixed, CLOSE_CONFIRMATION_MS);
        closeTimer.unref?.();
      }, TERMINATION_GRACE_MS);
      killTimer.unref?.();
    };
    const bytes = (chunk: unknown): Buffer | null => {
      if (!(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)) {
        beginFailure();
        return null;
      }
      return Buffer.from(chunk);
    };
    const onStdout = (chunk: unknown) => {
      const value = bytes(chunk);
      if (value === null) return;
      stdoutBytes += value.length;
      if (stdoutBytes > MAX_INSPECT_OUTPUT_BYTES) {
        beginFailure();
        return;
      }
      stdout.push(value);
    };
    const onStderr = (chunk: unknown) => {
      const value = bytes(chunk);
      if (value === null) return;
      stderrBytes += value.length;
      if (stderrBytes > MAX_INSPECT_OUTPUT_BYTES) beginFailure();
      else stderr.push(value);
    };
    const onStreamError = () => beginFailure();
    const onChildError = () => beginFailure();
    const onClose = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ) => {
      if (settled) return;
      if (failed) {
        rejectFixed();
        return;
      }
      settled = true;
      cleanup();
      resolveResult(
        Object.freeze({
          stdout: Buffer.concat(stdout, stdoutBytes),
          stderr: Buffer.concat(stderr, stderrBytes),
          exit: Object.freeze({ exitCode, signal }),
        }),
      );
    };
    const activeChild: ActiveChild = Object.freeze({
      async stop() {
        beginFailure();
        await stopped;
      },
    });
    const timeoutTimer = setTimeout(beginFailure, timeoutMs);
    timeoutTimer.unref?.();
    active.add(activeChild);
    child.stdout.on("data", onStdout);
    child.stdout.once("error", onStreamError);
    child.stderr.on("data", onStderr);
    child.stderr.once("error", onStreamError);
    child.once("error", onChildError);
    child.once("close", onClose);
  });
}

function controlledHelperStdout(
  stream: Readable,
  terminalFailure: Promise<void>,
): AsyncIterable<Uint8Array> {
  return Object.freeze({
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      const source = stream[Symbol.asyncIterator]();
      let ended = false;
      const stopSource = () => {
        try {
          const stopping = source.return?.();
          if (stopping) void Promise.resolve(stopping).catch(() => undefined);
        } catch {
          // The controlled iterator already exposes a fixed failure.
        }
      };
      return Object.freeze({
        async next(): Promise<IteratorResult<Uint8Array>> {
          if (ended) return { done: true, value: undefined };
          const outcome = await Promise.race([
            source.next().then(
              (result) => ({ kind: "stream" as const, result }),
              () => ({ kind: "stream-error" as const }),
            ),
            terminalFailure.then(() => ({ kind: "terminal" as const })),
          ]);
          if (outcome.kind !== "stream") {
            ended = true;
            stopSource();
            throw fixedError("INSTALLED_USER_AUTH_HELPER_FAILED");
          }
          if (outcome.result.done) {
            ended = true;
            return { done: true, value: undefined };
          }
          if (!(outcome.result.value instanceof Uint8Array)) {
            ended = true;
            stopSource();
            throw fixedError("INSTALLED_USER_AUTH_HELPER_FAILED");
          }
          return { done: false, value: outcome.result.value };
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          if (!ended) {
            ended = true;
            stopSource();
          }
          return { done: true, value: undefined };
        },
      });
    },
  });
}

function monitorHelper(
  child: InstalledUserAuthChild,
  timeoutMs: number,
  active: Set<ActiveChild>,
): RuntimeUserAuthHelperHandle {
  let settled = false;
  let failed = false;
  let killTimer: NodeJS.Timeout | undefined;
  let closeTimer: NodeJS.Timeout | undefined;
  let beginFailureFromStop: () => void = () => undefined;
  let resolveStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolveValue) => {
    resolveStopped = resolveValue;
  });
  let resolveTerminalFailure: () => void = () => undefined;
  const terminalFailure = new Promise<void>((resolveValue) => {
    resolveTerminalFailure = resolveValue;
  });
  const stopHandle: ActiveChild = Object.freeze({
    async stop() {
      beginFailureFromStop();
      await stopped;
    },
  });

  const result = new Promise<ChildExit>((resolveResult, reject) => {
    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (closeTimer) clearTimeout(closeTimer);
      child.stdout.off("error", onStreamError);
      child.stderr.off("data", onStderr);
      child.stderr.off("error", onStreamError);
      child.off("error", onChildError);
      child.off("close", onClose);
      active.delete(stopHandle);
      resolveStopped();
    };
    const rejectFixed = () => {
      if (settled) return;
      settled = true;
      resolveTerminalFailure();
      cleanup();
      reject(fixedError("INSTALLED_USER_AUTH_HELPER_FAILED"));
    };
    const beginFailure = () => {
      if (failed) return;
      failed = true;
      signalChild(child, "SIGTERM");
      killTimer = setTimeout(() => {
        signalChild(child, "SIGKILL");
        closeTimer = setTimeout(rejectFixed, CLOSE_CONFIRMATION_MS);
        closeTimer.unref?.();
      }, TERMINATION_GRACE_MS);
      killTimer.unref?.();
    };
    beginFailureFromStop = beginFailure;
    const onStderr = (chunk: unknown) => {
      if (!(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)) {
        beginFailure();
        return;
      }
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_HELPER_STDERR_BYTES) beginFailure();
    };
    const onStreamError = () => beginFailure();
    const onChildError = () => beginFailure();
    const onClose = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ) => {
      if (settled) return;
      if (failed) {
        rejectFixed();
        return;
      }
      settled = true;
      cleanup();
      resolveResult(Object.freeze({ exitCode, signal }));
    };
    let stderrBytes = 0;
    const timeoutTimer = setTimeout(beginFailure, timeoutMs);
    timeoutTimer.unref?.();
    child.stdout.once("error", onStreamError);
    child.stderr.on("data", onStderr);
    child.stderr.once("error", onStreamError);
    child.once("error", onChildError);
    child.once("close", onClose);
  });

  active.add(stopHandle);
  void result.then(
    () => active.delete(stopHandle),
    () => active.delete(stopHandle),
  );
  return Object.freeze({
    stdout: controlledHelperStdout(child.stdout, terminalFailure),
    result,
    stop: stopHandle.stop,
  });
}

export function createInstalledUserAuthorizationAdapter(
  options: InstalledUserAuthorizationAdapterOptions,
  dependencies: InstalledUserAuthorizationAdapterDependencies = {},
): InstalledUserAuthorizationAdapter {
  if (
    options === null ||
    typeof options !== "object" ||
    !canonicalAbsolutePath(options.scopeContractPath) ||
    typeof options.scopeContractSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(options.scopeContractSha256) ||
    typeof options.appId !== "string" ||
    !APP_ID_PATTERN.test(options.appId) ||
    !canonicalAbsolutePath(options.larkCliPath) ||
    !canonicalAbsolutePath(options.larkHome) ||
    !canonicalAbsolutePath(options.nodePath) ||
    !canonicalAbsolutePath(options.userAuthHelperPath) ||
    dependencies === null ||
    typeof dependencies !== "object" ||
    (dependencies.spawn !== undefined &&
      typeof dependencies.spawn !== "function")
  ) {
    throw fixedError("INSTALLED_USER_AUTH_OPTIONS_INVALID");
  }
  const inspectTimeoutMs = validDuration(
    dependencies.inspectTimeoutMs,
    DEFAULT_INSPECT_TIMEOUT_MS,
  );
  const helperTimeoutMs = validDuration(
    dependencies.helperTimeoutMs,
    DEFAULT_HELPER_TIMEOUT_MS,
  );
  const spawn =
    dependencies.spawn ??
    ((command, args, optionsValue) => {
      const nodeOptions: SpawnOptions = {
        cwd: optionsValue.cwd,
        env: optionsValue.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      };
      return nodeSpawn(
        command,
        args,
        nodeOptions,
      ) as ChildProcess as InstalledUserAuthChild;
    });
  const active = new Set<ActiveChild>();
  let closed = false;

  const validateInstalledPaths = () => {
    regularInstalledFile(options.larkCliPath, { executable: true });
    regularInstalledFile(options.nodePath, { executable: true });
    regularInstalledFile(options.userAuthHelperPath, { executable: false });
    privateInstalledDirectory(options.larkHome);
  };
  const runInspectionCommand = async (
    args: readonly string[],
  ): Promise<CapturedCommand> => {
    const child = validateChild(
      spawn(
        options.larkCliPath,
        Object.freeze([...args]),
        spawnOptions(options.larkHome),
      ),
    );
    return captureInspection(child, inspectTimeoutMs, active);
  };

  return Object.freeze({
    async inspect() {
      if (closed) {
        throw fixedError("INSTALLED_USER_AUTH_ADAPTER_CLOSED");
      }
      try {
        const contract = readScopeContract(
          options.scopeContractPath,
          options.scopeContractSha256,
        );
        validateInstalledPaths();
        const enabledUserScopes = parseUserAppScopes(
          await runInspectionCommand([
            "--profile",
            PROFILE,
            "auth",
            "scopes",
            "--json",
          ]),
          options.appId,
        );
        const enabledBotScopes = parseBotAppScopes(
          await runInspectionCommand([
            "--profile",
            PROFILE,
            "api",
            "GET",
            `/open-apis/application/v6/applications/${options.appId}`,
            "--as",
            "bot",
            "--params",
            '{"lang":"zh_cn"}',
            "--json",
          ]),
        );
        const enabledUsers = new Set(enabledUserScopes);
        const enabledBots = new Set(enabledBotScopes);
        if (
          contract.userScopes.some((scope) => !enabledUsers.has(scope)) ||
          contract.botScopes.some((scope) => !enabledBots.has(scope))
        ) {
          return Object.freeze({ state: "APP_SCOPE_MISSING" as const });
        }
        const captured = await runInspectionCommand([
          "--profile",
          PROFILE,
          "auth",
          "check",
          "--scope",
          contract.userScopes.join(" "),
          "--json",
        ]);
        return parseAuthCheck(
          captured.stdout,
          captured.exit.exitCode,
          captured.exit.signal,
          captured.stderr,
          contract.userScopes,
        );
      } catch {
        throw fixedError("INSTALLED_USER_AUTH_INSPECTION_FAILED");
      }
    },
    async startHelper(missingScopes) {
      if (closed) {
        throw fixedError("INSTALLED_USER_AUTH_ADAPTER_CLOSED");
      }
      try {
        const contract = readScopeContract(
          options.scopeContractPath,
          options.scopeContractSha256,
        );
        validateInstalledPaths();
        if (
          !Array.isArray(missingScopes) ||
          missingScopes.length < 1 ||
          new Set(missingScopes).size !== missingScopes.length
        ) {
          throw fixedError("INSTALLED_USER_AUTH_HELPER_FAILED");
        }
        const positions = missingScopes.map((scope) =>
          contract.userScopes.indexOf(scope),
        );
        if (
          positions.some((position) => position < 0) ||
          positions.some(
            (position, index) =>
              index > 0 && position <= (positions[index - 1] ?? -1),
          )
        ) {
          throw fixedError("INSTALLED_USER_AUTH_HELPER_FAILED");
        }
        const child = validateChild(
          spawn(
            options.nodePath,
            Object.freeze([
              options.userAuthHelperPath,
              "--presenter",
              "stdout-json",
              "--scope-contract",
              options.scopeContractPath,
              "--scope-contract-sha256",
              options.scopeContractSha256,
              options.larkCliPath,
              options.larkHome,
              ...missingScopes,
            ]),
            spawnOptions(options.larkHome),
          ),
        );
        return monitorHelper(child, helperTimeoutMs, active);
      } catch {
        throw fixedError("INSTALLED_USER_AUTH_HELPER_FAILED");
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...active].map((child) => child.stop()));
    },
  });
}
