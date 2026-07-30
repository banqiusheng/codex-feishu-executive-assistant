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
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Readable } from "node:stream";
import { types as utilTypes } from "node:util";

import { snapshotExactOwnDataOptions } from "./internal/exact-options.js";
import {
  parseStrictJsonValue,
  snapshotStrictJson,
  type JsonValue,
} from "./ipc/framing.js";
import type { LarkCliRequest, LarkCliRunResult } from "./mvp/lark-types.js";

export type { LarkCliRequest, LarkCliRunResult } from "./mvp/lark-types.js";

const FIXED_PROFILE = "executive-assistant";
const FIXED_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_FILE_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_FILE_INPUT_BYTES = 300 * 1024 * 1024;
const MAX_FILE_INPUTS = 10;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_CLOSE_CONFIRMATION_MS = 5_000;
const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const RESERVED_ARGUMENTS = Object.freeze([
  "--as",
  "--profile",
  "--format",
  "--data",
  "--params",
  "--content",
  "--image",
  "--file",
]);
const OPERATION_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type LarkCliIdentity = "bot" | "user";
export type LarkCliEffect = "read" | "write";

export type LarkCliJsonInput = Readonly<{
  flag: "--params" | "--data";
  value: JsonValue;
}>;

export type LarkCliTextInput = Readonly<{
  flag: "--content";
  fileName: "content.xml";
  value: string;
}>;

export type LarkCliFileInput = Readonly<{
  flag: "--image" | "--file";
  sourceRelativePath: string;
  outputFileName: string;
  sizeBytes: number;
  sha256: `sha256:${string}`;
}>;

export type LarkCliInvocationPlan = Readonly<{
  operationArgs: readonly string[];
  jsonInputs: readonly LarkCliJsonInput[];
  textInputs: readonly LarkCliTextInput[];
  fileInputs: readonly LarkCliFileInput[];
}>;

export type LarkCliRoute = Readonly<{
  identity: LarkCliIdentity;
  operation: string;
  effect: LarkCliEffect;
  parsePayload: (value: unknown) => unknown;
  buildInvocation: (payload: JsonValue) => LarkCliInvocationPlan;
}>;

type StableLarkCliRoute = Readonly<{
  identity: LarkCliIdentity;
  operation: string;
  effect: LarkCliEffect;
  parsePayload: (value: unknown) => unknown;
  buildInvocation: (payload: JsonValue) => LarkCliInvocationPlan;
}>;

export type LarkCliRouteRegistry = Readonly<{
  lookup(
    identity: LarkCliIdentity,
    operation: string,
  ): StableLarkCliRoute | undefined;
}>;

export type LarkCliReleaseEvidence = Readonly<{
  version: 1;
  requestedPath: string;
  realPath: string;
  releaseRoot: string;
  package: "@larksuite/cli";
  packageVersion: "1.0.72";
  expectedSha256: `sha256:${string}`;
  actualSha256: `sha256:${string}`;
  designatedRequirement: string;
  signatureVerified: boolean;
  ownerUid: number;
  mode: number;
  symlinkFree: boolean;
  profile: "executive-assistant";
  cliSchemaSha256: `sha256:${string}`;
}>;

export interface LarkCliChildProcess {
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

type FrozenSpawnOptions = Readonly<{
  cwd: string;
  env: Readonly<Record<string, string>>;
  shell: false;
  stdio: readonly ["ignore", "pipe", "pipe"];
  windowsHide: true;
}>;

type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: FrozenSpawnOptions,
) => LarkCliChildProcess;

export type LarkCliRunnerOptions = Readonly<{
  executable: string;
  homeDirectory: string;
  taskDirectory: string;
  registry: LarkCliRouteRegistry;
  verifyRelease: (
    executable: string,
  ) => LarkCliReleaseEvidence | Promise<LarkCliReleaseEvidence>;
  spawn?: SpawnFunction;
  timeoutMs?: number;
  killGraceMs?: number;
  closeConfirmationMs?: number;
}>;

const TRUSTED_REGISTRIES = new WeakSet<object>();

function freezeNullRecord<T extends object>(
  fields: Record<string, unknown>,
): T {
  const value = Object.create(null) as Record<string, unknown>;
  for (const [key, field] of Object.entries(fields)) {
    Object.defineProperty(value, key, {
      enumerable: true,
      value: field,
      writable: false,
    });
  }
  return Object.freeze(value) as T;
}

function snapshotDenseArray(
  value: unknown,
  maximum: number,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new Error("unsafe array");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !lengthDescriptor ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximum
  ) {
    throw new Error("unsafe array");
  }
  const length = lengthDescriptor.value as number;
  const expected = new Set([
    "length",
    ...Array.from({ length }, (_, index) => String(index)),
  ]);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.size ||
    keys.some((key) => typeof key !== "string" || !expected.has(key))
  ) {
    throw new Error("unsafe array");
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("unsafe array");
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function snapshotRoute(input: unknown): StableLarkCliRoute {
  const route = snapshotExactOwnDataOptions(input, [
    "identity",
    "operation",
    "effect",
    "parsePayload",
    "buildInvocation",
  ]);
  if (
    (route.identity !== "bot" && route.identity !== "user") ||
    typeof route.operation !== "string" ||
    !OPERATION_PATTERN.test(route.operation) ||
    (route.effect !== "read" && route.effect !== "write") ||
    typeof route.parsePayload !== "function" ||
    typeof route.buildInvocation !== "function" ||
    utilTypes.isProxy(route.parsePayload) ||
    utilTypes.isProxy(route.buildInvocation)
  ) {
    throw new Error("invalid lark-cli route");
  }
  const parsePayload = route.parsePayload as (value: unknown) => unknown;
  const buildInvocation = route.buildInvocation as (
    payload: JsonValue,
  ) => LarkCliInvocationPlan;
  return Object.freeze({
    identity: route.identity,
    operation: route.operation,
    effect: route.effect,
    parsePayload(value) {
      return Reflect.apply(parsePayload, undefined, [value]);
    },
    buildInvocation(payload) {
      return Reflect.apply(buildInvocation, undefined, [payload]);
    },
  });
}

function registryKey(identity: LarkCliIdentity, operation: string): string {
  return `${identity}\u0000${operation}`;
}

export function createLarkCliRouteRegistry(
  routes: readonly LarkCliRoute[],
): LarkCliRouteRegistry {
  const values = snapshotDenseArray(routes, 256);
  const map = new Map<string, StableLarkCliRoute>();
  for (const value of values) {
    const route = snapshotRoute(value);
    const key = registryKey(route.identity, route.operation);
    if (map.has(key)) throw new Error("duplicate lark-cli route");
    map.set(key, route);
  }
  const registry = Object.freeze({
    lookup(identity: LarkCliIdentity, operation: string) {
      return map.get(registryKey(identity, operation));
    },
  });
  TRUSTED_REGISTRIES.add(registry);
  return registry;
}

function snapshotRequest(input: unknown): LarkCliRequest {
  let request: Readonly<Record<string, unknown>>;
  try {
    request = snapshotExactOwnDataOptions(input, [
      "version",
      "operation",
      "payload",
    ]);
  } catch {
    throw new Error("invalid lark-cli request");
  }
  if (
    request.version !== 1 ||
    typeof request.operation !== "string" ||
    !OPERATION_PATTERN.test(request.operation)
  ) {
    throw new Error("invalid lark-cli request");
  }
  let payload: JsonValue;
  try {
    payload = snapshotStrictJson(request.payload);
  } catch {
    throw new Error("invalid lark-cli request");
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new Error("invalid lark-cli request");
  }
  return freezeNullRecord<LarkCliRequest>({
    version: 1,
    operation: request.operation,
    payload,
  });
}

function snapshotStringArguments(value: unknown): readonly string[] {
  const raw = snapshotDenseArray(value, MAX_ARGUMENTS);
  const result: string[] = [];
  let totalBytes = 0;
  for (const item of raw) {
    if (
      typeof item !== "string" ||
      item.length === 0 ||
      item.includes("\0") ||
      item === "--" ||
      RESERVED_ARGUMENTS.some(
        (reserved) => item === reserved || item.startsWith(`${reserved}=`),
      )
    ) {
      throw new Error("invalid lark-cli invocation");
    }
    totalBytes += Buffer.byteLength(item, "utf8");
    if (totalBytes > MAX_ARGUMENT_BYTES) {
      throw new Error("invalid lark-cli invocation");
    }
    result.push(item);
  }
  return Object.freeze(result);
}

function snapshotJsonInputs(value: unknown): readonly LarkCliJsonInput[] {
  const raw = snapshotDenseArray(value, 2);
  const inputs: LarkCliJsonInput[] = [];
  const flags = new Set<string>();
  for (const entry of raw) {
    const snapshot = snapshotExactOwnDataOptions(entry, ["flag", "value"]);
    if (
      (snapshot.flag !== "--params" && snapshot.flag !== "--data") ||
      flags.has(snapshot.flag)
    ) {
      throw new Error("invalid lark-cli invocation");
    }
    flags.add(snapshot.flag);
    inputs.push(
      Object.freeze({
        flag: snapshot.flag,
        value: snapshotStrictJson(snapshot.value),
      }),
    );
  }
  return Object.freeze(inputs);
}

function strictUtf8Bytes(value: unknown): Buffer {
  if (typeof value !== "string") {
    throw new Error("invalid lark-cli invocation");
  }
  const bytes = Buffer.from(value, "utf8");
  if (
    bytes.length === 0 ||
    bytes.length > MAX_INPUT_BYTES ||
    new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== value
  ) {
    throw new Error("invalid lark-cli invocation");
  }
  return bytes;
}

function snapshotTextInputs(value: unknown): readonly LarkCliTextInput[] {
  const raw = snapshotDenseArray(value, 1);
  const inputs: LarkCliTextInput[] = [];
  for (const entry of raw) {
    const snapshot = snapshotExactOwnDataOptions(entry, [
      "flag",
      "fileName",
      "value",
    ]);
    if (snapshot.flag !== "--content" || snapshot.fileName !== "content.xml") {
      throw new Error("invalid lark-cli invocation");
    }
    const text = snapshot.value;
    strictUtf8Bytes(text);
    inputs.push(
      Object.freeze({
        flag: "--content",
        fileName: "content.xml",
        value: text as string,
      }),
    );
  }
  return Object.freeze(inputs);
}

function isPureRelativeSourcePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

function isPureOutputFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    !value.includes("/") &&
    !value.includes("\\") &&
    value !== "." &&
    value !== ".." &&
    value !== "params.json" &&
    value !== "data.json" &&
    value !== "content.xml"
  );
}

function snapshotFileInputs(value: unknown): readonly LarkCliFileInput[] {
  const raw = snapshotDenseArray(value, MAX_FILE_INPUTS);
  const inputs: LarkCliFileInput[] = [];
  const outputNames = new Set<string>();
  let totalBytes = 0;
  for (const entry of raw) {
    const snapshot = snapshotExactOwnDataOptions(entry, [
      "flag",
      "sourceRelativePath",
      "outputFileName",
      "sizeBytes",
      "sha256",
    ]);
    if (
      (snapshot.flag !== "--image" && snapshot.flag !== "--file") ||
      !isPureRelativeSourcePath(snapshot.sourceRelativePath) ||
      !isPureOutputFileName(snapshot.outputFileName) ||
      outputNames.has(snapshot.outputFileName) ||
      typeof snapshot.sizeBytes !== "number" ||
      !Number.isSafeInteger(snapshot.sizeBytes) ||
      snapshot.sizeBytes <= 0 ||
      snapshot.sizeBytes > MAX_FILE_INPUT_BYTES ||
      typeof snapshot.sha256 !== "string" ||
      !SHA256_PATTERN.test(snapshot.sha256)
    ) {
      throw new Error("invalid lark-cli invocation");
    }
    totalBytes += snapshot.sizeBytes;
    if (totalBytes > MAX_TOTAL_FILE_INPUT_BYTES) {
      throw new Error("invalid lark-cli invocation");
    }
    outputNames.add(snapshot.outputFileName);
    inputs.push(
      Object.freeze({
        flag: snapshot.flag,
        sourceRelativePath: snapshot.sourceRelativePath,
        outputFileName: snapshot.outputFileName,
        sizeBytes: snapshot.sizeBytes,
        sha256: snapshot.sha256 as `sha256:${string}`,
      }),
    );
  }
  return Object.freeze(inputs);
}

function buildPlan(
  route: StableLarkCliRoute,
  payload: JsonValue,
): LarkCliInvocationPlan {
  let parsed: JsonValue;
  let plan: Readonly<Record<string, unknown>>;
  try {
    parsed = snapshotStrictJson(route.parsePayload(payload));
    plan = snapshotExactOwnDataOptions(route.buildInvocation(parsed), [
      "operationArgs",
      "jsonInputs",
      "textInputs",
      "fileInputs",
    ]);
    return Object.freeze({
      operationArgs: snapshotStringArguments(plan.operationArgs),
      jsonInputs: snapshotJsonInputs(plan.jsonInputs),
      textInputs: snapshotTextInputs(plan.textInputs),
      fileInputs: snapshotFileInputs(plan.fileInputs),
    });
  } catch {
    throw new Error("invalid lark-cli invocation");
  }
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    resolve(value) === value
  );
}

async function verifyDirectory(
  path: string,
  requiredMode?: number,
): Promise<boolean> {
  if (!isCanonicalAbsolutePath(path)) return false;
  try {
    const before = await lstat(path);
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      (typeof process.getuid === "function" &&
        before.uid !== process.getuid()) ||
      (requiredMode !== undefined && (before.mode & 0o7777) !== requiredMode) ||
      (await realpath(path)) !== path
    ) {
      return false;
    }
    const after = await lstat(path);
    return (
      after.isDirectory() &&
      !after.isSymbolicLink() &&
      after.dev === before.dev &&
      after.ino === before.ino &&
      after.uid === before.uid &&
      after.mode === before.mode
    );
  } catch {
    return false;
  }
}

function snapshotReleaseEvidence(
  input: unknown,
): LarkCliReleaseEvidence | null {
  let evidence: Readonly<Record<string, unknown>>;
  try {
    evidence = snapshotExactOwnDataOptions(input, [
      "version",
      "requestedPath",
      "realPath",
      "releaseRoot",
      "package",
      "packageVersion",
      "expectedSha256",
      "actualSha256",
      "designatedRequirement",
      "signatureVerified",
      "ownerUid",
      "mode",
      "symlinkFree",
      "profile",
      "cliSchemaSha256",
    ]);
  } catch {
    return null;
  }
  if (
    evidence.version !== 1 ||
    typeof evidence.requestedPath !== "string" ||
    typeof evidence.realPath !== "string" ||
    typeof evidence.releaseRoot !== "string" ||
    evidence.package !== "@larksuite/cli" ||
    evidence.packageVersion !== "1.0.72" ||
    typeof evidence.expectedSha256 !== "string" ||
    !SHA256_PATTERN.test(evidence.expectedSha256) ||
    typeof evidence.actualSha256 !== "string" ||
    !SHA256_PATTERN.test(evidence.actualSha256) ||
    typeof evidence.designatedRequirement !== "string" ||
    evidence.designatedRequirement.length === 0 ||
    evidence.designatedRequirement.includes("\0") ||
    evidence.signatureVerified !== true ||
    !Number.isSafeInteger(evidence.ownerUid) ||
    (evidence.ownerUid as number) < 0 ||
    evidence.mode !== 0o500 ||
    evidence.symlinkFree !== true ||
    evidence.profile !== FIXED_PROFILE ||
    typeof evidence.cliSchemaSha256 !== "string" ||
    !SHA256_PATTERN.test(evidence.cliSchemaSha256)
  ) {
    return null;
  }
  return freezeNullRecord<LarkCliReleaseEvidence>({
    version: 1,
    requestedPath: evidence.requestedPath,
    realPath: evidence.realPath,
    releaseRoot: evidence.releaseRoot,
    package: "@larksuite/cli",
    packageVersion: "1.0.72",
    expectedSha256: evidence.expectedSha256,
    actualSha256: evidence.actualSha256,
    designatedRequirement: evidence.designatedRequirement,
    signatureVerified: true,
    ownerUid: evidence.ownerUid,
    mode: 0o500,
    symlinkFree: true,
    profile: FIXED_PROFILE,
    cliSchemaSha256: evidence.cliSchemaSha256,
  });
}

function releaseEvidenceMatches(
  evidence: LarkCliReleaseEvidence | null,
  executable: string,
): evidence is LarkCliReleaseEvidence {
  if (evidence === null) return false;
  const expectedExecutable = join(
    evidence.releaseRoot,
    "private-bin",
    "lark-cli",
  );
  return (
    isCanonicalAbsolutePath(evidence.releaseRoot) &&
    isCanonicalAbsolutePath(evidence.requestedPath) &&
    isCanonicalAbsolutePath(evidence.realPath) &&
    evidence.requestedPath === executable &&
    evidence.realPath === executable &&
    expectedExecutable === executable &&
    evidence.expectedSha256 === evidence.actualSha256 &&
    (typeof process.getuid !== "function" ||
      evidence.ownerUid === process.getuid())
  );
}

function sameReleaseEvidence(
  left: LarkCliReleaseEvidence,
  right: LarkCliReleaseEvidence,
): boolean {
  return (
    left.version === right.version &&
    left.requestedPath === right.requestedPath &&
    left.realPath === right.realPath &&
    left.releaseRoot === right.releaseRoot &&
    left.package === right.package &&
    left.packageVersion === right.packageVersion &&
    left.expectedSha256 === right.expectedSha256 &&
    left.actualSha256 === right.actualSha256 &&
    left.designatedRequirement === right.designatedRequirement &&
    left.signatureVerified === right.signatureVerified &&
    left.ownerUid === right.ownerUid &&
    left.mode === right.mode &&
    left.symlinkFree === right.symlinkFree &&
    left.profile === right.profile &&
    left.cliSchemaSha256 === right.cliSchemaSha256
  );
}

type MaterializedPathKind = "directory" | "file";

type MaterializedPathEvidence = Readonly<{
  path: string;
  kind: MaterializedPathKind;
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}>;

type RegisteredSourceEvidence = Readonly<{
  path: string;
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  sha256: `sha256:${string}`;
}>;

type MaterializedInputs = Readonly<{
  arguments: readonly string[];
  directory: MaterializedPathEvidence | null;
  files: readonly MaterializedPathEvidence[];
  sources: readonly RegisteredSourceEvidence[];
}>;

function isMissingPathError(error: unknown): boolean {
  if (error === null || typeof error !== "object" || utilTypes.isProxy(error)) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return (
    descriptor !== undefined &&
    "value" in descriptor &&
    descriptor.value === "ENOENT"
  );
}

function isExpectedPathKind(
  stats: Awaited<ReturnType<typeof lstat>>,
  kind: MaterializedPathKind,
): boolean {
  return kind === "directory" ? stats.isDirectory() : stats.isFile();
}

function sameMaterializedIdentity(
  left: MaterializedPathEvidence,
  right: MaterializedPathEvidence,
): boolean {
  return (
    left.path === right.path &&
    left.kind === right.kind &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    (left.kind === "directory" || left.nlink === right.nlink)
  );
}

function openedFileMatchesEvidence(
  opened: Stats,
  evidence: MaterializedPathEvidence,
): boolean {
  return evidence.kind === "file" && materializedStatsMatch(opened, evidence);
}

function materializedStatsMatch(
  stats: Stats,
  evidence: MaterializedPathEvidence,
): boolean {
  return (
    isExpectedPathKind(stats, evidence.kind) &&
    !stats.isSymbolicLink() &&
    stats.dev === evidence.dev &&
    stats.ino === evidence.ino &&
    stats.uid === evidence.uid &&
    stats.mode === evidence.mode &&
    stats.nlink === evidence.nlink &&
    stats.size === evidence.size &&
    stats.mtimeMs === evidence.mtimeMs &&
    stats.ctimeMs === evidence.ctimeMs
  );
}

function registeredSourceStatsMatch(
  stats: Stats,
  evidence: RegisteredSourceEvidence,
): boolean {
  return (
    stats.isFile() &&
    !stats.isSymbolicLink() &&
    stats.dev === evidence.dev &&
    stats.ino === evidence.ino &&
    stats.uid === evidence.uid &&
    stats.mode === evidence.mode &&
    stats.nlink === evidence.nlink &&
    stats.size === evidence.size &&
    stats.mtimeMs === evidence.mtimeMs &&
    stats.ctimeMs === evidence.ctimeMs
  );
}

function sameStatsIdentity(left: Stats, right: Stats): boolean {
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

async function copyRegisteredSource(
  taskDirectory: string,
  temporaryDirectory: string,
  input: LarkCliFileInput,
): Promise<
  Readonly<{
    materialized: MaterializedPathEvidence;
    source: RegisteredSourceEvidence;
  }>
> {
  const sourcePath = join(taskDirectory, input.sourceRelativePath);
  const outputPath = join(temporaryDirectory, input.outputFileName);
  const sourceBefore = await lstat(sourcePath);
  if (
    !sourceBefore.isFile() ||
    sourceBefore.isSymbolicLink() ||
    (sourceBefore.mode & 0o7777) !== 0o600 ||
    sourceBefore.nlink !== 1 ||
    (typeof process.getuid === "function" &&
      sourceBefore.uid !== process.getuid()) ||
    sourceBefore.size !== input.sizeBytes ||
    (await realpath(sourcePath)) !== sourcePath
  ) {
    throw new Error("unsafe lark-cli registered source");
  }
  const source = await open(
    sourcePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  let target: Awaited<ReturnType<typeof open>> | undefined;
  let sourceOpened: Stats | undefined;
  let targetOpened: Stats | undefined;
  let actualSha256: `sha256:${string}` | undefined;
  try {
    sourceOpened = await source.stat();
    if (!sameStatsIdentity(sourceBefore, sourceOpened)) {
      throw new Error("unsafe lark-cli registered source");
    }
    target = await open(
      outputPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < input.sizeBytes) {
      const maximum = Math.min(chunk.length, input.sizeBytes - position);
      const { bytesRead } = await source.read(chunk, 0, maximum, position);
      if (bytesRead <= 0) {
        throw new Error("unsafe lark-cli registered source");
      }
      hash.update(chunk.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await target.write(
          chunk,
          written,
          bytesRead - written,
          position + written,
        );
        if (result.bytesWritten <= 0) {
          throw new Error("unsafe lark-cli materialized file");
        }
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    const trailing = await source.read(Buffer.allocUnsafe(1), 0, 1, position);
    if (trailing.bytesRead !== 0) {
      throw new Error("unsafe lark-cli registered source");
    }
    actualSha256 = `sha256:${hash.digest("hex")}`;
    if (actualSha256 !== input.sha256) {
      throw new Error("unsafe lark-cli registered source");
    }
    await target.sync();
    targetOpened = await target.stat();
    const sourceAfterDescriptor = await source.stat();
    const sourceAfterPath = await lstat(sourcePath);
    if (
      !sameStatsIdentity(sourceBefore, sourceAfterDescriptor) ||
      !sameStatsIdentity(sourceBefore, sourceAfterPath) ||
      (await realpath(sourcePath)) !== sourcePath
    ) {
      throw new Error("unsafe lark-cli registered source");
    }
    if (
      !targetOpened.isFile() ||
      (targetOpened.mode & 0o7777) !== 0o600 ||
      targetOpened.nlink !== 1 ||
      (typeof process.getuid === "function" &&
        targetOpened.uid !== process.getuid()) ||
      targetOpened.size !== input.sizeBytes
    ) {
      throw new Error("unsafe lark-cli materialized file");
    }
  } finally {
    try {
      await target?.close();
    } finally {
      await source.close();
    }
  }
  const materialized = await captureMaterializedPath(outputPath, "file", 0o600);
  if (
    sourceOpened === undefined ||
    targetOpened === undefined ||
    actualSha256 === undefined ||
    !openedFileMatchesEvidence(targetOpened, materialized)
  ) {
    throw new Error("unsafe lark-cli materialized file");
  }
  return Object.freeze({
    materialized,
    source: freezeNullRecord<RegisteredSourceEvidence>({
      path: sourcePath,
      dev: sourceOpened.dev,
      ino: sourceOpened.ino,
      uid: sourceOpened.uid,
      mode: sourceOpened.mode,
      nlink: sourceOpened.nlink,
      size: sourceOpened.size,
      mtimeMs: sourceOpened.mtimeMs,
      ctimeMs: sourceOpened.ctimeMs,
      sha256: actualSha256,
    }),
  });
}

async function registeredSourceMatches(
  evidence: RegisteredSourceEvidence,
): Promise<boolean> {
  let descriptor: Awaited<ReturnType<typeof open>> | undefined;
  let valid = false;
  try {
    const before = await lstat(evidence.path);
    if (
      !registeredSourceStatsMatch(before, evidence) ||
      (await realpath(evidence.path)) !== evidence.path
    ) {
      throw new Error("unsafe lark-cli registered source");
    }
    descriptor = await open(
      evidence.path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const opened = await descriptor.stat();
    if (!registeredSourceStatsMatch(opened, evidence)) {
      throw new Error("unsafe lark-cli registered source");
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < evidence.size) {
      const maximum = Math.min(chunk.length, evidence.size - position);
      const { bytesRead } = await descriptor.read(chunk, 0, maximum, position);
      if (bytesRead <= 0) {
        throw new Error("unsafe lark-cli registered source");
      }
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const trailing = await descriptor.read(
      Buffer.allocUnsafe(1),
      0,
      1,
      position,
    );
    if (trailing.bytesRead !== 0) {
      throw new Error("unsafe lark-cli registered source");
    }
    const afterDescriptor = await descriptor.stat();
    const afterPath = await lstat(evidence.path);
    valid =
      registeredSourceStatsMatch(afterDescriptor, evidence) &&
      registeredSourceStatsMatch(afterPath, evidence) &&
      (await realpath(evidence.path)) === evidence.path &&
      `sha256:${hash.digest("hex")}` === evidence.sha256;
  } catch {
    valid = false;
  } finally {
    try {
      await descriptor?.close();
    } catch {
      valid = false;
    }
  }
  return valid;
}

function registeredSourceMatchesSynchronously(
  evidence: RegisteredSourceEvidence,
): boolean {
  let descriptor: number | undefined;
  let valid = false;
  try {
    const before = lstatSync(evidence.path);
    if (
      !registeredSourceStatsMatch(before, evidence) ||
      realpathSync(evidence.path) !== evidence.path
    ) {
      return false;
    }
    descriptor = openSync(
      evidence.path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const opened = fstatSync(descriptor);
    if (!registeredSourceStatsMatch(opened, evidence)) return false;
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < evidence.size) {
      const maximum = Math.min(chunk.length, evidence.size - position);
      const bytesRead = readSync(descriptor, chunk, 0, maximum, position);
      if (bytesRead <= 0) return false;
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const trailing = readSync(
      descriptor,
      Buffer.allocUnsafe(1),
      0,
      1,
      position,
    );
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(evidence.path);
    valid =
      trailing === 0 &&
      registeredSourceStatsMatch(afterDescriptor, evidence) &&
      registeredSourceStatsMatch(afterPath, evidence) &&
      realpathSync(evidence.path) === evidence.path &&
      `sha256:${hash.digest("hex")}` === evidence.sha256;
  } catch {
    valid = false;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        valid = false;
      }
    }
  }
  return valid;
}

async function captureMaterializedPath(
  path: string,
  kind: MaterializedPathKind,
  requiredMode: number,
): Promise<MaterializedPathEvidence> {
  if (!isCanonicalAbsolutePath(path)) {
    throw new Error("unsafe lark-cli materialized path");
  }
  const before = await lstat(path);
  if (
    !isExpectedPathKind(before, kind) ||
    before.isSymbolicLink() ||
    (kind === "file" && before.nlink !== 1) ||
    (before.mode & 0o7777) !== requiredMode ||
    (typeof process.getuid === "function" && before.uid !== process.getuid()) ||
    (await realpath(path)) !== path
  ) {
    throw new Error("unsafe lark-cli materialized path");
  }
  const after = await lstat(path);
  if (
    !isExpectedPathKind(after, kind) ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.uid !== before.uid ||
    after.mode !== before.mode ||
    after.nlink !== before.nlink ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  ) {
    throw new Error("unsafe lark-cli materialized path");
  }
  return freezeNullRecord<MaterializedPathEvidence>({
    path,
    kind,
    dev: after.dev,
    ino: after.ino,
    uid: after.uid,
    mode: after.mode,
    nlink: after.nlink,
    size: after.size,
    mtimeMs: after.mtimeMs,
    ctimeMs: after.ctimeMs,
  });
}

async function materializedPathMatches(
  evidence: MaterializedPathEvidence,
  requireExactMetadata: boolean,
): Promise<boolean> {
  try {
    const current = await lstat(evidence.path);
    return (
      isExpectedPathKind(current, evidence.kind) &&
      !current.isSymbolicLink() &&
      current.dev === evidence.dev &&
      current.ino === evidence.ino &&
      current.uid === evidence.uid &&
      (evidence.kind === "directory" ||
        (evidence.nlink === 1 && current.nlink === evidence.nlink)) &&
      (!requireExactMetadata ||
        (current.mode === evidence.mode &&
          current.nlink === evidence.nlink &&
          current.size === evidence.size &&
          current.mtimeMs === evidence.mtimeMs &&
          current.ctimeMs === evidence.ctimeMs)) &&
      (await realpath(evidence.path)) === evidence.path
    );
  } catch {
    return false;
  }
}

async function verifyMaterializedInputs(
  inputs: MaterializedInputs,
  includeSources = true,
): Promise<boolean> {
  if (inputs.directory === null) {
    return inputs.files.length === 0 && inputs.sources.length === 0;
  }
  if (!(await materializedPathMatches(inputs.directory, true))) {
    return false;
  }
  for (const file of inputs.files) {
    if (!(await materializedPathMatches(file, true))) {
      return false;
    }
  }
  if (includeSources) {
    for (const source of inputs.sources) {
      if (!(await registeredSourceMatches(source))) {
        return false;
      }
    }
  }
  return materializedPathMatches(inputs.directory, true);
}

function materializedPathMatchesSynchronously(
  evidence: MaterializedPathEvidence,
): boolean {
  let descriptor: number | undefined;
  let valid = false;
  try {
    const before = lstatSync(evidence.path);
    if (
      !materializedStatsMatch(before, evidence) ||
      realpathSync(evidence.path) !== evidence.path
    ) {
      return false;
    }
    descriptor = openSync(
      evidence.path,
      fsConstants.O_RDONLY |
        fsConstants.O_NOFOLLOW |
        (evidence.kind === "directory" ? fsConstants.O_DIRECTORY : 0),
    );
    const opened = fstatSync(descriptor);
    const after = lstatSync(evidence.path);
    valid =
      materializedStatsMatch(opened, evidence) &&
      materializedStatsMatch(after, evidence) &&
      opened.dev === after.dev &&
      opened.ino === after.ino &&
      realpathSync(evidence.path) === evidence.path;
  } catch {
    valid = false;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        valid = false;
      }
    }
  }
  return valid;
}

function verifyMaterializedInputsSynchronously(
  inputs: MaterializedInputs,
): boolean {
  if (inputs.directory === null) {
    return inputs.files.length === 0 && inputs.sources.length === 0;
  }
  if (!materializedPathMatchesSynchronously(inputs.directory)) {
    return false;
  }
  for (const file of inputs.files) {
    if (!materializedPathMatchesSynchronously(file)) {
      return false;
    }
  }
  for (const source of inputs.sources) {
    if (!registeredSourceMatchesSynchronously(source)) {
      return false;
    }
  }
  return materializedPathMatchesSynchronously(inputs.directory);
}

async function cleanupKnownInputs(
  directoryPath: string | null,
  directoryEvidence: MaterializedPathEvidence | null,
  filePaths: readonly string[],
): Promise<boolean> {
  if (directoryPath === null) return filePaths.length === 0;
  if (directoryEvidence === null) {
    if (filePaths.length !== 0) return false;
    try {
      await rmdir(directoryPath);
      return true;
    } catch (error) {
      return isMissingPathError(error);
    }
  }

  let cleaned = true;
  for (const path of filePaths) {
    if (!(await materializedPathMatches(directoryEvidence, false))) {
      return false;
    }
    try {
      await unlink(path);
    } catch (error) {
      if (!isMissingPathError(error)) cleaned = false;
    }
  }
  if (!(await materializedPathMatches(directoryEvidence, false))) {
    return false;
  }
  try {
    await rmdir(directoryPath);
  } catch (error) {
    if (!isMissingPathError(error)) cleaned = false;
  }
  return cleaned;
}

async function materializeInputs(
  taskDirectory: string,
  jsonInputs: readonly LarkCliJsonInput[],
  textInputs: readonly LarkCliTextInput[],
  fileInputs: readonly LarkCliFileInput[],
): Promise<MaterializedInputs> {
  if (
    jsonInputs.length === 0 &&
    textInputs.length === 0 &&
    fileInputs.length === 0
  ) {
    return Object.freeze({
      arguments: Object.freeze([]),
      directory: null,
      files: Object.freeze([]),
      sources: Object.freeze([]),
    });
  }
  let directoryPath: string | null = null;
  let directoryEvidence: MaterializedPathEvidence | null = null;
  const fileEvidence: MaterializedPathEvidence[] = [];
  const sourceEvidence: RegisteredSourceEvidence[] = [];
  const knownFilePaths: string[] = [];
  try {
    directoryPath = await mkdtemp(join(taskDirectory, ".lark-cli-"));
    await chmod(directoryPath, 0o700);
    if (
      relative(taskDirectory, directoryPath).includes("/") ||
      relative(taskDirectory, directoryPath).startsWith("..")
    ) {
      throw new Error("unsafe lark-cli temporary directory");
    }
    directoryEvidence = await captureMaterializedPath(
      directoryPath,
      "directory",
      0o700,
    );
    const relativeDirectory = relative(taskDirectory, directoryPath);
    const arguments_: string[] = [];
    let totalInputBytes = 0;
    for (const input of jsonInputs) {
      const name = input.flag === "--params" ? "params.json" : "data.json";
      const path = join(directoryPath, name);
      knownFilePaths.push(path);
      const body = Buffer.from(JSON.stringify(input.value), "utf8");
      totalInputBytes += body.length;
      if (body.length === 0 || totalInputBytes > MAX_INPUT_BYTES) {
        throw new Error("lark-cli input limit exceeded");
      }
      const descriptor = await open(
        path,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      let opened: Stats | undefined;
      try {
        await descriptor.writeFile(body);
        await descriptor.sync();
        opened = await descriptor.stat();
        if (
          !opened.isFile() ||
          (opened.mode & 0o7777) !== 0o600 ||
          (typeof process.getuid === "function" &&
            opened.uid !== process.getuid())
        ) {
          throw new Error("unsafe lark-cli input file");
        }
      } finally {
        await descriptor.close();
      }
      const captured = await captureMaterializedPath(path, "file", 0o600);
      if (
        opened === undefined ||
        !openedFileMatchesEvidence(opened, captured)
      ) {
        throw new Error("unsafe lark-cli input file");
      }
      fileEvidence.push(captured);
      arguments_.push(input.flag, `@${relativeDirectory}/${name}`);
    }
    for (const input of textInputs) {
      const path = join(directoryPath, input.fileName);
      knownFilePaths.push(path);
      const body = strictUtf8Bytes(input.value);
      totalInputBytes += body.length;
      if (totalInputBytes > MAX_INPUT_BYTES) {
        throw new Error("lark-cli input limit exceeded");
      }
      const descriptor = await open(
        path,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      let opened: Stats | undefined;
      try {
        await descriptor.writeFile(body);
        await descriptor.sync();
        opened = await descriptor.stat();
        if (
          !opened.isFile() ||
          (opened.mode & 0o7777) !== 0o600 ||
          (typeof process.getuid === "function" &&
            opened.uid !== process.getuid())
        ) {
          throw new Error("unsafe lark-cli input file");
        }
      } finally {
        await descriptor.close();
      }
      const captured = await captureMaterializedPath(path, "file", 0o600);
      if (
        opened === undefined ||
        !openedFileMatchesEvidence(opened, captured)
      ) {
        throw new Error("unsafe lark-cli input file");
      }
      fileEvidence.push(captured);
      arguments_.push(input.flag, `@${relativeDirectory}/${input.fileName}`);
    }
    for (const input of fileInputs) {
      const outputPath = join(directoryPath, input.outputFileName);
      knownFilePaths.push(outputPath);
      const copied = await copyRegisteredSource(
        taskDirectory,
        directoryPath,
        input,
      );
      fileEvidence.push(copied.materialized);
      sourceEvidence.push(copied.source);
      arguments_.push(
        input.flag,
        `@${relativeDirectory}/${input.outputFileName}`,
      );
    }
    const finalDirectoryEvidence = await captureMaterializedPath(
      directoryPath,
      "directory",
      0o700,
    );
    if (!sameMaterializedIdentity(directoryEvidence, finalDirectoryEvidence)) {
      throw new Error("unsafe lark-cli temporary directory");
    }
    directoryEvidence = finalDirectoryEvidence;
    return Object.freeze({
      arguments: Object.freeze(arguments_),
      directory: directoryEvidence,
      files: Object.freeze(fileEvidence),
      sources: Object.freeze(sourceEvidence),
    });
  } catch (error) {
    await cleanupKnownInputs(directoryPath, directoryEvidence, knownFilePaths);
    throw error;
  }
}

async function cleanupInputs(inputs: MaterializedInputs): Promise<boolean> {
  return cleanupKnownInputs(
    inputs.directory?.path ?? null,
    inputs.directory,
    inputs.files.map((file) => file.path),
  );
}

type ChildOutcome = Readonly<{
  closed: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  timedOut: boolean;
  outputLimit: boolean;
  ioFailure: boolean;
}>;

function collectChild(
  child: LarkCliChildProcess,
  timeoutMs: number,
  killGraceMs: number,
  closeConfirmationMs: number,
): Promise<ChildOutcome> {
  return new Promise((resolveOutcome) => {
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let combinedBytes = 0;
    let timedOut = false;
    let outputLimit = false;
    let ioFailure = false;
    let terminating = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (closeTimer) clearTimeout(closeTimer);
      child.stdout.off("data", onStdout);
      child.stdout.off("error", onStreamFailure);
      child.stderr.off("data", onStderr);
      child.stderr.off("error", onStreamFailure);
      child.off("error", onChildError);
      child.off("close", onClose);
    };
    const finish = (outcome: ChildOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveOutcome(outcome);
    };
    const currentOutcome = (
      closed: boolean,
      code: number | null,
      signal: NodeJS.Signals | null,
    ): ChildOutcome =>
      Object.freeze({
        closed,
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks, stdoutBytes),
        timedOut,
        outputLimit,
        ioFailure,
      });
    const beginTermination = () => {
      if (terminating) return;
      terminating = true;
      try {
        child.kill("SIGTERM");
      } catch {
        ioFailure = true;
      }
      graceTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          ioFailure = true;
        }
        closeTimer = setTimeout(() => {
          finish(currentOutcome(false, null, null));
        }, closeConfirmationMs);
      }, killGraceMs);
    };
    const countBytes = (chunk: unknown): Buffer | null => {
      if (!(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)) {
        ioFailure = true;
        beginTermination();
        return null;
      }
      const bytes = Buffer.from(chunk);
      combinedBytes += bytes.length;
      if (combinedBytes > MAX_OUTPUT_BYTES) {
        outputLimit = true;
        beginTermination();
        return null;
      }
      return bytes;
    };
    const onStdout = (chunk: unknown) => {
      const bytes = countBytes(chunk);
      if (bytes === null) return;
      stdoutChunks.push(bytes);
      stdoutBytes += bytes.length;
    };
    const onStderr = (chunk: unknown) => {
      countBytes(chunk);
    };
    const onStreamFailure = () => {
      ioFailure = true;
      beginTermination();
    };
    const onChildError = () => {
      ioFailure = true;
      beginTermination();
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(currentOutcome(true, code, signal));
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      beginTermination();
    }, timeoutMs);
    timeoutTimer.unref?.();
    child.stdout.on("data", onStdout);
    child.stdout.once("error", onStreamFailure);
    child.stderr.on("data", onStderr);
    child.stderr.once("error", onStreamFailure);
    child.once("error", onChildError);
    child.once("close", onClose);
  });
}

function failed(
  code:
    | "EXECUTABLE_REJECTED"
    | "SPAWN_FAILED"
    | "CLI_EXITED"
    | "OUTPUT_LIMIT"
    | "OUTPUT_INVALID",
): LarkCliRunResult {
  return Object.freeze({ state: "FAILED", code });
}

function unknown(
  code: "TIMEOUT" | "IO_AFTER_SPAWN" | "TERMINATION_UNCONFIRMED",
): LarkCliRunResult {
  return Object.freeze({ state: "UNKNOWN", code });
}

function classifyFailure(
  effect: LarkCliEffect,
  failedCode: "CLI_EXITED" | "OUTPUT_LIMIT" | "OUTPUT_INVALID",
): LarkCliRunResult {
  return effect === "write" ? unknown("IO_AFTER_SPAWN") : failed(failedCode);
}

function validateDuration(value: unknown, fallback: number): number {
  const duration = value ?? fallback;
  if (
    typeof duration !== "number" ||
    !Number.isSafeInteger(duration) ||
    duration <= 0 ||
    duration > 10 * 60_000
  ) {
    throw new Error("invalid lark-cli runner options");
  }
  return duration;
}

export function createLarkCliRunner(options: LarkCliRunnerOptions) {
  let stable: Readonly<Record<string, unknown>>;
  try {
    stable = snapshotExactOwnDataOptions(
      options,
      [
        "executable",
        "homeDirectory",
        "taskDirectory",
        "registry",
        "verifyRelease",
      ],
      ["spawn", "timeoutMs", "killGraceMs", "closeConfirmationMs"],
    );
  } catch {
    throw new Error("invalid lark-cli runner options");
  }
  const executable = stable.executable;
  const homeDirectory = stable.homeDirectory;
  const taskDirectory = stable.taskDirectory;
  const registry = stable.registry;
  const verifyRelease = stable.verifyRelease;
  const suppliedSpawn = stable.spawn;
  if (
    !isCanonicalAbsolutePath(executable) ||
    !isCanonicalAbsolutePath(homeDirectory) ||
    !isCanonicalAbsolutePath(taskDirectory) ||
    registry === null ||
    typeof registry !== "object" ||
    !TRUSTED_REGISTRIES.has(registry) ||
    typeof verifyRelease !== "function" ||
    utilTypes.isProxy(verifyRelease) ||
    (suppliedSpawn !== undefined &&
      (typeof suppliedSpawn !== "function" || utilTypes.isProxy(suppliedSpawn)))
  ) {
    throw new Error("invalid lark-cli runner options");
  }
  const timeoutMs = validateDuration(stable.timeoutMs, DEFAULT_TIMEOUT_MS);
  const killGraceMs = validateDuration(
    stable.killGraceMs,
    DEFAULT_KILL_GRACE_MS,
  );
  const closeConfirmationMs = validateDuration(
    stable.closeConfirmationMs,
    DEFAULT_CLOSE_CONFIRMATION_MS,
  );
  const verify = verifyRelease as (
    executable: string,
  ) => LarkCliReleaseEvidence | Promise<LarkCliReleaseEvidence>;
  const spawn =
    (suppliedSpawn as SpawnFunction | undefined) ??
    ((command, args, spawnOptions) => {
      const nodeOptions: SpawnOptions = {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      };
      return nodeSpawn(
        command,
        args,
        nodeOptions,
      ) as ChildProcess as LarkCliChildProcess;
    });
  const trustedRegistry = registry as LarkCliRouteRegistry;

  const run = async (
    identity: LarkCliIdentity,
    input: unknown,
  ): Promise<LarkCliRunResult> => {
    const request = snapshotRequest(input);
    const route = trustedRegistry.lookup(identity, request.operation);
    if (!route) throw new Error("lark-cli operation denied");

    let plan: LarkCliInvocationPlan;
    try {
      plan = buildPlan(route, request.payload);
    } catch {
      return failed("OUTPUT_INVALID");
    }
    if (
      !(await verifyDirectory(taskDirectory, 0o700)) ||
      !(await verifyDirectory(homeDirectory, 0o700))
    ) {
      return failed("EXECUTABLE_REJECTED");
    }
    let before: LarkCliReleaseEvidence | null = null;
    try {
      before = snapshotReleaseEvidence(
        await Reflect.apply(verify, undefined, [executable]),
      );
    } catch {
      before = null;
    }
    if (!releaseEvidenceMatches(before, executable)) {
      return failed("EXECUTABLE_REJECTED");
    }

    let inputs: MaterializedInputs;
    try {
      inputs = await materializeInputs(
        taskDirectory,
        plan.jsonInputs,
        plan.textInputs,
        plan.fileInputs,
      );
    } catch {
      return failed("OUTPUT_INVALID");
    }
    if (!(await verifyMaterializedInputs(inputs))) {
      await cleanupInputs(inputs);
      return failed("OUTPUT_INVALID");
    }
    let preSpawn: LarkCliReleaseEvidence | null = null;
    try {
      preSpawn = snapshotReleaseEvidence(
        await Reflect.apply(verify, undefined, [executable]),
      );
    } catch {
      preSpawn = null;
    }
    if (
      !releaseEvidenceMatches(preSpawn, executable) ||
      !sameReleaseEvidence(before, preSpawn)
    ) {
      const cleaned = await cleanupInputs(inputs);
      return cleaned ? failed("EXECUTABLE_REJECTED") : failed("OUTPUT_INVALID");
    }
    if (!verifyMaterializedInputsSynchronously(inputs)) {
      await cleanupInputs(inputs);
      return failed("OUTPUT_INVALID");
    }
    const args = Object.freeze([
      ...plan.operationArgs,
      ...inputs.arguments,
      "--profile",
      FIXED_PROFILE,
      "--as",
      identity,
      "--format",
      "json",
    ]);
    const env = freezeNullRecord<Record<string, string>>({
      HOME: homeDirectory,
      PATH: FIXED_PATH,
      LANG: "C",
      LC_ALL: "C",
    });
    const spawnOptions = freezeNullRecord<FrozenSpawnOptions>({
      cwd: taskDirectory,
      env,
      shell: false,
      stdio: Object.freeze(["ignore", "pipe", "pipe"]),
      windowsHide: true,
    });

    let child: LarkCliChildProcess;
    try {
      child = Reflect.apply(spawn, undefined, [
        executable,
        args,
        spawnOptions,
      ]) as LarkCliChildProcess;
      if (
        child === null ||
        typeof child !== "object" ||
        !child.stdout ||
        typeof child.stdout.on !== "function" ||
        typeof child.stdout.off !== "function" ||
        !child.stderr ||
        typeof child.stderr.on !== "function" ||
        typeof child.stderr.off !== "function" ||
        typeof child.once !== "function" ||
        typeof child.off !== "function" ||
        typeof child.kill !== "function"
      ) {
        throw new Error("invalid lark-cli child");
      }
    } catch {
      await cleanupInputs(inputs);
      return route.effect === "write"
        ? unknown("IO_AFTER_SPAWN")
        : failed("SPAWN_FAILED");
    }

    const outcome = await collectChild(
      child,
      timeoutMs,
      killGraceMs,
      closeConfirmationMs,
    );
    if (!outcome.closed) {
      await cleanupInputs(inputs);
      return unknown("TERMINATION_UNCONFIRMED");
    }

    const inputsIntact = await verifyMaterializedInputs(inputs, false);
    let after: LarkCliReleaseEvidence | null = null;
    try {
      after = snapshotReleaseEvidence(
        await Reflect.apply(verify, undefined, [executable]),
      );
    } catch {
      after = null;
    }
    const cleaned = await cleanupInputs(inputs);
    if (
      !releaseEvidenceMatches(after, executable) ||
      !sameReleaseEvidence(before, after) ||
      !sameReleaseEvidence(preSpawn, after)
    ) {
      return route.effect === "write"
        ? unknown("IO_AFTER_SPAWN")
        : failed("EXECUTABLE_REJECTED");
    }
    if (!inputsIntact || !cleaned) {
      return route.effect === "write"
        ? unknown("IO_AFTER_SPAWN")
        : failed("OUTPUT_INVALID");
    }
    if (outcome.timedOut) return unknown("TIMEOUT");
    if (outcome.outputLimit) {
      return classifyFailure(route.effect, "OUTPUT_LIMIT");
    }
    if (outcome.ioFailure) {
      return classifyFailure(route.effect, "OUTPUT_INVALID");
    }
    if (outcome.code !== 0 || outcome.signal !== null) {
      return classifyFailure(route.effect, "CLI_EXITED");
    }
    let value: JsonValue;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        outcome.stdout,
      );
      value = parseStrictJsonValue(text);
    } catch {
      return classifyFailure(route.effect, "OUTPUT_INVALID");
    }
    return Object.freeze({ state: "SUCCEEDED", value });
  };

  return Object.freeze({
    runBot(input: LarkCliRequest): Promise<LarkCliRunResult> {
      return run("bot", input);
    },
    runUser(input: LarkCliRequest): Promise<LarkCliRunResult> {
      return run("user", input);
    },
  });
}
