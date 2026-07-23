import type { EventEmitter } from "node:events";
import { isAbsolute, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { TextDecoder, types as utilTypes } from "node:util";

import {
  isCanonicalUuid,
  resolveTaskWorkspace,
} from "../security/workspace.js";

const REQUIRED_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const REQUIRED_CODEX_VERSION = "0.142.0";
const REQUIRED_CODEX_FEATURES = new Set([
  "exec-json",
  "exec-resume-stdin",
  "approval-never",
  "permission-profiles",
  "network-proxy-unix-socket-allowlist",
]);
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const TERMINATION_GRACE_MS = 10 * 1000;
const MAX_JSONL_BYTES = 1024 * 1024;
const MAX_PENDING_EVENTS = 256;
const MAX_PENDING_EVENT_BYTES = 4 * 1024 * 1024;
const SAFE_REQUEST_KEYS = new Set([
  "taskId",
  "sessionId",
  "workspace",
  "gatewaySocket",
  "gatewayClient",
  "prompt",
]);
const REQUIRED_REQUEST_KEYS = [
  "taskId",
  "workspace",
  "gatewaySocket",
  "gatewayClient",
  "prompt",
] as const;
const REQUIRED_DEPENDENCY_KEYS = [
  "codexPath",
  "codexHome",
  "workspaceRoot",
  "spawn",
  "verifyCodexBinary",
  "verifyCodexHome",
  "verifyGatewayRelease",
  "lstatGatewaySocket",
] as const;
const SAFE_DEPENDENCY_KEYS = new Set([
  ...REQUIRED_DEPENDENCY_KEYS,
  "resolveWorkspace",
]);

export type CodexRunEvent = Readonly<Record<string, unknown>>;

export type CodexRunFailureReason =
  | "non_zero_exit"
  | "signal_exit"
  | "spawn_error"
  | "invalid_json"
  | "invalid_utf8"
  | "invalid_event"
  | "unknown_event"
  | "invalid_event_sequence"
  | "missing_success_terminal"
  | "codex_reported_failure"
  | "line_too_large"
  | "buffer_too_large"
  | "event_queue_overflow"
  | "incomplete_line"
  | "stdin_incomplete"
  | "stdin_error"
  | "stdout_error"
  | "stderr_error"
  | "idle_timeout";

export type CodexRunResult =
  | {
      status: "SUCCEEDED";
      exitCode: 0;
      signal: null;
      requiresConfirmation: false;
      automaticRetry: false;
    }
  | {
      status:
        | "EXIT_FAILURE"
        | "SIGNALLED"
        | "SPAWN_ERROR"
        | "CODEX_ERROR"
        | "PROTOCOL_ERROR"
        | "IO_ERROR"
        | "INTERRUPTED_REQUIRES_CONFIRMATION";
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      requiresConfirmation: true;
      automaticRetry: false;
      reason: CodexRunFailureReason;
    };

export interface CodexTerminationUnconfirmed {
  status: "TERMINATION_UNCONFIRMED";
  reason: CodexRunFailureReason;
  termSignalAccepted: boolean;
  killSignalAccepted: boolean;
  requiresConfirmation: true;
  automaticRetry: false;
}

export interface CodexRunRequest {
  taskId: string;
  sessionId?: string;
  workspace: string;
  gatewaySocket: string;
  gatewayClient: string;
  prompt: string;
}

export interface CodexRunHandle {
  events: AsyncIterable<CodexRunEvent>;
  terminationEvents: AsyncIterable<CodexTerminationUnconfirmed>;
  result: Promise<CodexRunResult>;
}

export interface CodexChildProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
}

export interface CodexSpawnOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  shell: false;
  stdio: readonly ["pipe", "pipe", "pipe"];
}

export interface CodexBinaryEvidence {
  path: string;
  version: string;
  executable: boolean;
  features: readonly string[];
}

export interface TrustedDirectoryEvidence {
  requestedPath: string;
  realPath: string;
  directory: boolean;
  symlinkFree: boolean;
  mode: number;
  permissionProfileCompatible: boolean;
}

export interface GatewayReleaseEvidence {
  requestedPath: string;
  realPath: string;
  publicBinDirectory: string;
  publicBinEntries: readonly string[];
  expectedSha256: string;
  actualSha256: string;
  signatureVerified: boolean;
  executable: boolean;
}

export interface GatewaySocketEvidence {
  symbolicLink: boolean;
  socket: boolean;
  mode: number;
}

export interface CodexRunnerDependencies {
  codexPath: string;
  codexHome: string;
  workspaceRoot: string;
  spawn: (
    command: string,
    args: readonly string[],
    options: CodexSpawnOptions,
  ) => CodexChildProcess;
  verifyCodexBinary: (path: string) => Promise<CodexBinaryEvidence>;
  verifyCodexHome: (path: string) => Promise<TrustedDirectoryEvidence>;
  verifyGatewayRelease: (path: string) => Promise<GatewayReleaseEvidence>;
  lstatGatewaySocket: (path: string) => Promise<GatewaySocketEvidence>;
  resolveWorkspace?: typeof resolveTaskWorkspace;
}

interface VerifiedInvocation {
  command: string;
  args: readonly string[];
  options: CodexSpawnOptions;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: Array<{ value: T; bytes: number }> = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private queuedBytes = 0;
  private closed = false;

  push(value: T, bytes: number): boolean {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return true;
    }
    if (
      this.values.length >= MAX_PENDING_EVENTS ||
      this.queuedBytes + bytes > MAX_PENDING_EVENT_BYTES
    ) {
      return false;
    }
    this.values.push({ value, bytes });
    this.queuedBytes += bytes;
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0))
      waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const entry = this.values.shift();
        if (entry !== undefined) {
          this.queuedBytes -= entry.bytes;
          return Promise.resolve({ done: false, value: entry.value });
        }
        if (this.closed)
          return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<T>>((resolve) =>
          this.waiters.push(resolve),
        );
      },
    };
  }
}

function assertAbsolutePath(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  if (value.includes("\0"))
    throw new Error(`${label} contains invalid characters`);
}

function freezeNullRecord<T extends object>(entries: T): T {
  return Object.freeze(
    Object.assign(Object.create(null) as object, entries),
  ) as T;
}

function snapshotOwnDataRecord(
  input: unknown,
  requiredKeys: readonly string[],
  allowedKeys: ReadonlySet<string>,
): Readonly<Record<string, unknown>> | null {
  if (input === null || typeof input !== "object") {
    return null;
  }
  if (utilTypes.isProxy(input)) return null;
  try {
    if (Array.isArray(input)) return null;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(input);
    if (
      ownKeys.some((key) => typeof key !== "string" || !allowedKeys.has(key)) ||
      requiredKeys.some((key) => !ownKeys.includes(key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return null;
      }
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      });
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function snapshotDenseStringArray(value: unknown): readonly string[] | null {
  if (value === null || typeof value !== "object") return null;
  if (utilTypes.isProxy(value)) return null;
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      return null;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > 256
    ) {
      return null;
    }
    const length = lengthDescriptor.value as number;
    const expectedKeys = new Set([
      "length",
      ...Array.from({ length }, (_, index) => String(index)),
    ]);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== expectedKeys.size ||
      ownKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key))
    ) {
      return null;
    }
    const snapshot: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true ||
        typeof descriptor.value !== "string"
      ) {
        return null;
      }
      snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function snapshotRunRequest(input: unknown): CodexRunRequest {
  const request = snapshotOwnDataRecord(
    input,
    REQUIRED_REQUEST_KEYS,
    SAFE_REQUEST_KEYS,
  );
  if (request === null) throw new Error("invalid Codex run request");
  const taskId = request.taskId;
  const sessionId = request.sessionId;
  const workspace = request.workspace;
  const gatewaySocket = request.gatewaySocket;
  const gatewayClient = request.gatewayClient;
  const prompt = request.prompt;
  if (!isCanonicalUuid(taskId)) throw new Error("invalid task id");
  if (sessionId !== undefined && !isCanonicalUuid(sessionId)) {
    throw new Error("invalid session id");
  }
  assertAbsolutePath(workspace, "workspace");
  assertAbsolutePath(gatewaySocket, "gateway socket");
  assertAbsolutePath(gatewayClient, "gateway client");
  if (
    typeof prompt !== "string" ||
    prompt.length === 0 ||
    prompt.trim().length === 0 ||
    prompt.includes("\0") ||
    Buffer.byteLength(prompt, "utf8") > MAX_JSONL_BYTES
  ) {
    throw new Error("prompt must be a non-empty bounded string");
  }
  return freezeNullRecord<CodexRunRequest>(
    sessionId === undefined
      ? { taskId, workspace, gatewaySocket, gatewayClient, prompt }
      : {
          taskId,
          sessionId,
          workspace,
          gatewaySocket,
          gatewayClient,
          prompt,
        },
  );
}

function snapshotRunnerDependencies(input: unknown): CodexRunnerDependencies {
  const dependencies = snapshotOwnDataRecord(
    input,
    REQUIRED_DEPENDENCY_KEYS,
    SAFE_DEPENDENCY_KEYS,
  );
  if (dependencies === null) {
    throw new Error("invalid Codex runner dependencies");
  }
  const codexPath = dependencies.codexPath;
  const codexHome = dependencies.codexHome;
  const workspaceRoot = dependencies.workspaceRoot;
  const spawn = dependencies.spawn;
  const resolveWorkspace = dependencies.resolveWorkspace;
  const verifyCodexBinary = dependencies.verifyCodexBinary;
  const verifyCodexHome = dependencies.verifyCodexHome;
  const verifyGatewayRelease = dependencies.verifyGatewayRelease;
  const lstatGatewaySocket = dependencies.lstatGatewaySocket;
  if (
    typeof codexPath !== "string" ||
    typeof codexHome !== "string" ||
    typeof workspaceRoot !== "string" ||
    typeof spawn !== "function" ||
    (resolveWorkspace !== undefined &&
      typeof resolveWorkspace !== "function") ||
    typeof verifyCodexBinary !== "function" ||
    typeof verifyCodexHome !== "function" ||
    typeof verifyGatewayRelease !== "function" ||
    typeof lstatGatewaySocket !== "function"
  ) {
    throw new Error("invalid Codex runner dependencies");
  }
  const stable = freezeNullRecord<CodexRunnerDependencies>({
    codexPath,
    codexHome,
    workspaceRoot,
    spawn(command, args, options) {
      return Reflect.apply(spawn, undefined, [
        command,
        args,
        options,
      ]) as CodexChildProcess;
    },
    async verifyCodexBinary(path) {
      return (await Reflect.apply(verifyCodexBinary, undefined, [
        path,
      ])) as CodexBinaryEvidence;
    },
    async verifyCodexHome(path) {
      return (await Reflect.apply(verifyCodexHome, undefined, [
        path,
      ])) as TrustedDirectoryEvidence;
    },
    async verifyGatewayRelease(path) {
      return (await Reflect.apply(verifyGatewayRelease, undefined, [
        path,
      ])) as GatewayReleaseEvidence;
    },
    async lstatGatewaySocket(path) {
      return (await Reflect.apply(lstatGatewaySocket, undefined, [
        path,
      ])) as GatewaySocketEvidence;
    },
    resolveWorkspace:
      resolveWorkspace === undefined
        ? resolveTaskWorkspace
        : async (root, taskId) =>
            (await Reflect.apply(resolveWorkspace, undefined, [
              root,
              taskId,
            ])) as string,
  });
  return stable;
}

function snapshotCodexBinaryEvidence(
  input: unknown,
): CodexBinaryEvidence | null {
  const evidence = snapshotOwnDataRecord(
    input,
    ["path", "version", "executable", "features"],
    new Set(["path", "version", "executable", "features"]),
  );
  if (evidence === null) return null;
  const features = snapshotDenseStringArray(evidence.features);
  if (
    typeof evidence.path !== "string" ||
    typeof evidence.version !== "string" ||
    typeof evidence.executable !== "boolean" ||
    features === null
  ) {
    return null;
  }
  return freezeNullRecord<CodexBinaryEvidence>({
    path: evidence.path,
    version: evidence.version,
    executable: evidence.executable,
    features,
  });
}

function snapshotCodexHomeEvidence(
  input: unknown,
): TrustedDirectoryEvidence | null {
  const evidence = snapshotOwnDataRecord(
    input,
    [
      "requestedPath",
      "realPath",
      "directory",
      "symlinkFree",
      "mode",
      "permissionProfileCompatible",
    ],
    new Set([
      "requestedPath",
      "realPath",
      "directory",
      "symlinkFree",
      "mode",
      "permissionProfileCompatible",
    ]),
  );
  if (
    evidence === null ||
    typeof evidence.requestedPath !== "string" ||
    typeof evidence.realPath !== "string" ||
    typeof evidence.directory !== "boolean" ||
    typeof evidence.symlinkFree !== "boolean" ||
    typeof evidence.mode !== "number" ||
    typeof evidence.permissionProfileCompatible !== "boolean"
  ) {
    return null;
  }
  return freezeNullRecord<TrustedDirectoryEvidence>({
    requestedPath: evidence.requestedPath,
    realPath: evidence.realPath,
    directory: evidence.directory,
    symlinkFree: evidence.symlinkFree,
    mode: evidence.mode,
    permissionProfileCompatible: evidence.permissionProfileCompatible,
  });
}

function snapshotGatewaySocketEvidence(
  input: unknown,
): GatewaySocketEvidence | null {
  const evidence = snapshotOwnDataRecord(
    input,
    ["symbolicLink", "socket", "mode"],
    new Set(["symbolicLink", "socket", "mode"]),
  );
  if (
    evidence === null ||
    typeof evidence.symbolicLink !== "boolean" ||
    typeof evidence.socket !== "boolean" ||
    typeof evidence.mode !== "number"
  ) {
    return null;
  }
  return freezeNullRecord<GatewaySocketEvidence>({
    symbolicLink: evidence.symbolicLink,
    socket: evidence.socket,
    mode: evidence.mode,
  });
}

function snapshotGatewayReleaseEvidence(
  input: unknown,
): GatewayReleaseEvidence | null {
  const evidence = snapshotOwnDataRecord(
    input,
    [
      "requestedPath",
      "realPath",
      "publicBinDirectory",
      "publicBinEntries",
      "expectedSha256",
      "actualSha256",
      "signatureVerified",
      "executable",
    ],
    new Set([
      "requestedPath",
      "realPath",
      "publicBinDirectory",
      "publicBinEntries",
      "expectedSha256",
      "actualSha256",
      "signatureVerified",
      "executable",
    ]),
  );
  if (evidence === null) return null;
  const publicBinEntries = snapshotDenseStringArray(evidence.publicBinEntries);
  if (
    typeof evidence.requestedPath !== "string" ||
    typeof evidence.realPath !== "string" ||
    typeof evidence.publicBinDirectory !== "string" ||
    publicBinEntries === null ||
    typeof evidence.expectedSha256 !== "string" ||
    typeof evidence.actualSha256 !== "string" ||
    typeof evidence.signatureVerified !== "boolean" ||
    typeof evidence.executable !== "boolean"
  ) {
    return null;
  }
  return freezeNullRecord<GatewayReleaseEvidence>({
    requestedPath: evidence.requestedPath,
    realPath: evidence.realPath,
    publicBinDirectory: evidence.publicBinDirectory,
    publicBinEntries,
    expectedSha256: evidence.expectedSha256,
    actualSha256: evidence.actualSha256,
    signatureVerified: evidence.signatureVerified,
    executable: evidence.executable,
  });
}

function isStrictSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCompatibleCodexVersion(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) return false;
  const current = value.split(".").map(Number);
  const minimum = REQUIRED_CODEX_VERSION.split(".").map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    const difference = (current.at(index) ?? 0) - (minimum.at(index) ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

async function trustedCall<T>(
  message: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch {
    throw new Error(message);
  }
}

function buildArgs(
  sessionId: string | undefined,
  verifiedWorkspace: string,
): readonly string[] {
  const gatewaySocket = join(verifiedWorkspace, "gateway.sock");
  const permissionsConfig =
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
  const safetyPrefix = [
    "--ask-for-approval",
    "never",
    "--enable",
    "network_proxy",
    "-c",
    'default_permissions="assistant-task"',
    "-c",
    permissionsConfig,
    "exec",
  ];
  return Object.freeze(
    sessionId
      ? [
          ...safetyPrefix,
          "resume",
          sessionId,
          "--strict-config",
          "--json",
          "--skip-git-repo-check",
          "-",
        ]
      : [
          ...safetyPrefix,
          "--strict-config",
          "--json",
          "--skip-git-repo-check",
          "-",
        ],
  );
}

async function verifyInvocation(
  dependencies: CodexRunnerDependencies,
  request: CodexRunRequest,
): Promise<VerifiedInvocation> {
  assertAbsolutePath(dependencies.codexPath, "codex path");
  assertAbsolutePath(dependencies.codexHome, "codex home");
  assertAbsolutePath(dependencies.workspaceRoot, "workspace root");

  const resolveWorkspace =
    dependencies.resolveWorkspace ?? resolveTaskWorkspace;
  const workspace = await trustedCall(
    "task workspace verification failed",
    () => resolveWorkspace(dependencies.workspaceRoot, request.taskId),
  );
  assertAbsolutePath(workspace, "resolved workspace");
  if (workspace !== request.workspace)
    throw new Error("task workspace verification failed");

  const codexEvidence = snapshotCodexBinaryEvidence(
    await trustedCall("codex binary verification failed", () =>
      dependencies.verifyCodexBinary(dependencies.codexPath),
    ),
  );
  if (
    codexEvidence === null ||
    codexEvidence.path !== dependencies.codexPath ||
    !isCompatibleCodexVersion(codexEvidence.version) ||
    codexEvidence.executable !== true ||
    [...REQUIRED_CODEX_FEATURES].some(
      (feature) => !codexEvidence.features.includes(feature),
    )
  ) {
    throw new Error("codex binary verification failed");
  }

  const codexHomeEvidence = snapshotCodexHomeEvidence(
    await trustedCall("codex home verification failed", () =>
      dependencies.verifyCodexHome(dependencies.codexHome),
    ),
  );
  if (
    codexHomeEvidence === null ||
    codexHomeEvidence.requestedPath !== dependencies.codexHome ||
    codexHomeEvidence.realPath !== dependencies.codexHome ||
    codexHomeEvidence.directory !== true ||
    codexHomeEvidence.symlinkFree !== true ||
    codexHomeEvidence.mode !== 0o700 ||
    codexHomeEvidence.permissionProfileCompatible !== true
  ) {
    throw new Error("codex home verification failed");
  }

  const expectedSocket = join(workspace, "gateway.sock");
  if (request.gatewaySocket !== expectedSocket) {
    throw new Error("gateway socket must be the task workspace gateway.sock");
  }
  const socketEvidence = snapshotGatewaySocketEvidence(
    await trustedCall("gateway socket verification failed", () =>
      dependencies.lstatGatewaySocket(request.gatewaySocket),
    ),
  );
  if (
    socketEvidence === null ||
    socketEvidence.symbolicLink !== false ||
    socketEvidence.socket !== true ||
    socketEvidence.mode !== 0o600
  ) {
    throw new Error("gateway socket verification failed");
  }

  const gatewayEvidence = snapshotGatewayReleaseEvidence(
    await trustedCall("gateway release verification failed", () =>
      dependencies.verifyGatewayRelease(request.gatewayClient),
    ),
  );
  if (gatewayEvidence === null) {
    throw new Error("gateway release verification failed");
  }
  try {
    assertAbsolutePath(
      gatewayEvidence.publicBinDirectory,
      "gateway public bin",
    );
    assertAbsolutePath(gatewayEvidence.realPath, "gateway real path");
  } catch {
    throw new Error("gateway release verification failed");
  }
  const expectedGatewayRealPath = join(
    gatewayEvidence.publicBinDirectory,
    "assistant-gateway",
  );
  if (
    gatewayEvidence.requestedPath !== request.gatewayClient ||
    gatewayEvidence.realPath !== expectedGatewayRealPath ||
    !Array.isArray(gatewayEvidence.publicBinEntries) ||
    gatewayEvidence.publicBinEntries.length !== 1 ||
    gatewayEvidence.publicBinEntries[0] !== "assistant-gateway" ||
    !isStrictSha256(gatewayEvidence.expectedSha256) ||
    !isStrictSha256(gatewayEvidence.actualSha256) ||
    gatewayEvidence.expectedSha256 !== gatewayEvidence.actualSha256 ||
    gatewayEvidence.signatureVerified !== true ||
    gatewayEvidence.executable !== true
  ) {
    throw new Error("gateway release verification failed");
  }

  const env = freezeNullRecord<Record<string, string>>({
    PATH: REQUIRED_PATH,
    CODEX_HOME: codexHomeEvidence.realPath,
    ASSISTANT_GATEWAY_SOCKET: request.gatewaySocket,
    ASSISTANT_GATEWAY_CLIENT: gatewayEvidence.realPath,
    LANG: "zh_CN.UTF-8",
  });
  const stdio = Object.freeze(["pipe", "pipe", "pipe"] as const);
  const options = freezeNullRecord<CodexSpawnOptions>({
    cwd: workspace,
    env,
    shell: false,
    stdio,
  });
  return freezeNullRecord<VerifiedInvocation>({
    command: dependencies.codexPath,
    args: buildArgs(request.sessionId, workspace),
    options,
  });
}

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

type CodexProtocolState =
  | "expect_thread"
  | "expect_turn"
  | "in_turn"
  | "succeeded"
  | "failed";

type ProtocolDecision =
  | { kind: "accepted"; event: CodexRunEvent }
  | { kind: "codex_failure" }
  | {
      kind: "protocol_error";
      reason: "unknown_event" | "invalid_event" | "invalid_event_sequence";
    };

function isBoundedString(
  value: unknown,
  maximumBytes: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

function isUsage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const inputTokens = value.input_tokens;
  const cachedInputTokens = value.cached_input_tokens;
  const outputTokens = value.output_tokens;
  const reasoningOutputTokens = value.reasoning_output_tokens;
  return [
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
  ].every(
    (tokenCount) => Number.isSafeInteger(tokenCount) && Number(tokenCount) >= 0,
  );
}

function isKnownItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isBoundedString(value.id, 256) &&
    /^[A-Za-z0-9._:-]+$/.test(value.id) &&
    typeof value.type === "string" &&
    KNOWN_ITEM_TYPES.has(value.type)
  );
}

function isFailurePayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    isBoundedString(value.message, 4096) &&
    !value.message.includes("\0")
  );
}

function createCodexJsonlProtocol(expectedSessionId: string | undefined) {
  let state: CodexProtocolState = "expect_thread";

  return {
    accept(event: CodexRunEvent): ProtocolDecision {
      const type = event.type;
      if (typeof type !== "string") {
        return { kind: "protocol_error", reason: "invalid_event" };
      }
      if (state === "succeeded" || state === "failed") {
        return { kind: "protocol_error", reason: "invalid_event_sequence" };
      }

      switch (type) {
        case "thread.started":
          if (state !== "expect_thread") {
            return {
              kind: "protocol_error",
              reason: "invalid_event_sequence",
            };
          }
          if (!isCanonicalUuid(event.thread_id)) {
            return { kind: "protocol_error", reason: "invalid_event" };
          }
          if (
            expectedSessionId !== undefined &&
            event.thread_id !== expectedSessionId
          ) {
            return { kind: "protocol_error", reason: "invalid_event" };
          }
          state = "expect_turn";
          return { kind: "accepted", event };
        case "turn.started":
          if (state !== "expect_turn") {
            return {
              kind: "protocol_error",
              reason: "invalid_event_sequence",
            };
          }
          state = "in_turn";
          return { kind: "accepted", event };
        case "item.started":
        case "item.updated":
        case "item.completed":
          if (state !== "in_turn") {
            return {
              kind: "protocol_error",
              reason: "invalid_event_sequence",
            };
          }
          if (!isKnownItem(event.item)) {
            return { kind: "protocol_error", reason: "invalid_event" };
          }
          return { kind: "accepted", event };
        case "turn.completed":
          if (state !== "in_turn") {
            return {
              kind: "protocol_error",
              reason: "invalid_event_sequence",
            };
          }
          if (!isUsage(event.usage)) {
            return { kind: "protocol_error", reason: "invalid_event" };
          }
          state = "succeeded";
          return { kind: "accepted", event };
        case "turn.failed":
          if (state !== "in_turn") {
            return {
              kind: "protocol_error",
              reason: "invalid_event_sequence",
            };
          }
          if (!isRecord(event.error) || !isFailurePayload(event.error)) {
            return { kind: "protocol_error", reason: "invalid_event" };
          }
          state = "failed";
          return { kind: "codex_failure" };
        case "error":
          if (state !== "in_turn") {
            return {
              kind: "protocol_error",
              reason: "invalid_event_sequence",
            };
          }
          if (!isFailurePayload(event)) {
            return { kind: "protocol_error", reason: "invalid_event" };
          }
          return { kind: "accepted", event: { type: "error" } };
        default:
          return { kind: "protocol_error", reason: "unknown_event" };
      }
    },
    hasSuccessTerminal(): boolean {
      return state === "succeeded";
    },
  };
}

function completedRun(result: CodexRunResult): CodexRunHandle {
  const queue = new AsyncEventQueue<CodexRunEvent>();
  const terminationEvents = new AsyncEventQueue<CodexTerminationUnconfirmed>();
  queue.close();
  terminationEvents.close();
  return {
    events: queue,
    terminationEvents,
    result: Promise.resolve(result),
  };
}

interface PendingTermination {
  status:
    | "SPAWN_ERROR"
    | "CODEX_ERROR"
    | "PROTOCOL_ERROR"
    | "IO_ERROR"
    | "INTERRUPTED_REQUIRES_CONFIRMATION";
  reason: CodexRunFailureReason;
}

function startChildRun(
  child: CodexChildProcess,
  prompt: string,
  expectedSessionId: string | undefined,
): CodexRunHandle {
  const events = new AsyncEventQueue<CodexRunEvent>();
  const terminationEvents = new AsyncEventQueue<CodexTerminationUnconfirmed>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const protocol = createCodexJsonlProtocol(expectedSessionId);
  let buffer = Buffer.alloc(0);
  let stdoutCompleted = false;
  let stdinEndRequested = false;
  let stdinFinishObserved = child.stdin.writableFinished;
  let closeObserved = false;
  let settled = false;
  let pendingTermination: PendingTermination | undefined;
  let termSignalAccepted = false;
  let terminationNoticeEmitted = false;
  let idleTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let resolveResult!: (value: CodexRunResult) => void;
  const result = new Promise<CodexRunResult>((resolve) => {
    resolveResult = resolve;
  });

  const clearTimers = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (killTimer) clearTimeout(killTimer);
    idleTimer = undefined;
    killTimer = undefined;
  };

  const removeListeners = (): void => {
    child.removeListener("error", onChildError);
    child.removeListener("close", onClose);
    child.stdin.removeListener("error", onStdinError);
    child.stdin.removeListener("drain", onDrain);
    child.stdin.removeListener("finish", onStdinFinish);
    child.stdout.removeListener("data", onStdoutData);
    child.stdout.removeListener("end", onStdoutEnd);
    child.stdout.removeListener("error", onStdoutError);
    child.stderr.removeListener("data", discardStderr);
    child.stderr.removeListener("error", onStderrError);
  };

  const finish = (value: CodexRunResult): void => {
    if (settled) return;
    settled = true;
    clearTimers();
    removeListeners();
    events.close();
    terminationEvents.close();
    resolveResult(value);
  };

  const finishTermination = (
    termination: PendingTermination,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    finish({
      status: termination.status,
      exitCode,
      signal,
      reason: termination.reason,
      requiresConfirmation: true,
      automaticRetry: false,
    });
  };

  const safeKill = (signal: NodeJS.Signals): boolean => {
    try {
      return child.kill(signal) === true;
    } catch {
      // Only fixed status/reason values are exposed to the caller.
      return false;
    }
  };

  const beginTermination = (termination: PendingTermination): void => {
    if (settled || pendingTermination) return;
    pendingTermination = termination;
    buffer = Buffer.alloc(0);
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;

    if (closeObserved) return;
    termSignalAccepted = safeKill("SIGTERM");
    if (settled || closeObserved) return;
    killTimer = setTimeout(() => {
      killTimer = undefined;
      if (settled || closeObserved) return;
      const killSignalAccepted = safeKill("SIGKILL");
      if (settled || closeObserved || terminationNoticeEmitted) return;
      terminationNoticeEmitted = true;
      terminationEvents.push(
        {
          status: "TERMINATION_UNCONFIRMED",
          reason: termination.reason,
          termSignalAccepted,
          killSignalAccepted,
          requiresConfirmation: true,
          automaticRetry: false,
        },
        1,
      );
    }, TERMINATION_GRACE_MS);
  };

  const onIdle = (): void => {
    beginTermination({
      status: "INTERRUPTED_REQUIRES_CONFIRMATION",
      reason: "idle_timeout",
    });
  };

  const resetIdle = (): void => {
    if (settled || pendingTermination) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdle, IDLE_TIMEOUT_MS);
  };

  const acceptLine = (rawLine: Buffer): boolean => {
    if (rawLine.byteLength > MAX_JSONL_BYTES) {
      beginTermination({ status: "PROTOCOL_ERROR", reason: "line_too_large" });
      return false;
    }
    let line: string;
    try {
      line = decoder.decode(rawLine);
    } catch {
      beginTermination({ status: "PROTOCOL_ERROR", reason: "invalid_utf8" });
      return false;
    }
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (normalized.trim() === "") return true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(normalized);
    } catch {
      beginTermination({ status: "PROTOCOL_ERROR", reason: "invalid_json" });
      return false;
    }
    if (
      !isRecord(parsed) ||
      typeof parsed.type !== "string" ||
      !/^[a-z0-9._-]{1,128}$/.test(parsed.type)
    ) {
      beginTermination({ status: "PROTOCOL_ERROR", reason: "invalid_event" });
      return false;
    }
    const decision = protocol.accept(parsed as CodexRunEvent);
    if (decision.kind === "protocol_error") {
      beginTermination({
        status: "PROTOCOL_ERROR",
        reason: decision.reason,
      });
      return false;
    }
    if (decision.kind === "codex_failure") {
      beginTermination({
        status: "CODEX_ERROR",
        reason: "codex_reported_failure",
      });
      return false;
    }
    if (!events.push(decision.event, rawLine.byteLength)) {
      beginTermination({
        status: "PROTOCOL_ERROR",
        reason: "event_queue_overflow",
      });
      return false;
    }
    resetIdle();
    return true;
  };

  function onStdoutData(chunk: Buffer | string): void {
    if (settled || pendingTermination) return;
    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk, "utf8")
        : Buffer.from(chunk);
    buffer = buffer.byteLength === 0 ? bytes : Buffer.concat([buffer, bytes]);
    let offset = 0;
    let newline = buffer.indexOf(0x0a, offset);
    while (newline !== -1 && !pendingTermination) {
      const line = buffer.subarray(offset, newline);
      if (!acceptLine(line)) return;
      offset = newline + 1;
      newline = buffer.indexOf(0x0a, offset);
    }
    if (offset > 0) buffer = Buffer.from(buffer.subarray(offset));
    if (!pendingTermination && buffer.byteLength > MAX_JSONL_BYTES) {
      beginTermination({
        status: "PROTOCOL_ERROR",
        reason: "buffer_too_large",
      });
    }
  }

  const completeStdout = (): void => {
    if (stdoutCompleted || pendingTermination) return;
    stdoutCompleted = true;
    if (buffer.byteLength === 0) return;
    if (buffer.byteLength > MAX_JSONL_BYTES) {
      beginTermination({
        status: "PROTOCOL_ERROR",
        reason: "buffer_too_large",
      });
      return;
    }
    let remainder: string;
    try {
      remainder = decoder.decode(buffer);
    } catch {
      beginTermination({ status: "PROTOCOL_ERROR", reason: "invalid_utf8" });
      return;
    }
    buffer = Buffer.alloc(0);
    if (remainder.trim() !== "") {
      beginTermination({ status: "PROTOCOL_ERROR", reason: "incomplete_line" });
    }
  };

  function onStdoutEnd(): void {
    completeStdout();
  }

  function onChildError(): void {
    if (pendingTermination) {
      // A kill failure may emit "error" without proving the child exited.
      // Keep the grace timer and close listener until close or forced kill.
      return;
    }
    beginTermination({
      status: "SPAWN_ERROR",
      reason: "spawn_error",
    });
  }

  function onStdinError(): void {
    beginTermination({ status: "IO_ERROR", reason: "stdin_error" });
  }

  function onStdoutError(): void {
    beginTermination({ status: "IO_ERROR", reason: "stdout_error" });
  }

  function onStderrError(): void {
    beginTermination({ status: "IO_ERROR", reason: "stderr_error" });
  }

  function discardStderr(): void {
    // Draining prevents pipe backpressure; stderr content is never retained or surfaced.
  }

  function onClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (settled) return;
    closeObserved = true;
    if (pendingTermination) {
      finishTermination(pendingTermination, code, signal);
      return;
    }
    completeStdout();
    if (pendingTermination) {
      finishTermination(pendingTermination, code, signal);
      return;
    }
    if (
      !stdinEndRequested ||
      (!stdinFinishObserved && !child.stdin.writableFinished)
    ) {
      finishTermination(
        { status: "IO_ERROR", reason: "stdin_incomplete" },
        code,
        signal,
      );
      return;
    }
    if (signal !== null) {
      finish({
        status: "SIGNALLED",
        exitCode: code,
        signal,
        reason: "signal_exit",
        requiresConfirmation: true,
        automaticRetry: false,
      });
    } else if (code !== 0) {
      finish({
        status: "EXIT_FAILURE",
        exitCode: code,
        signal,
        reason: "non_zero_exit",
        requiresConfirmation: true,
        automaticRetry: false,
      });
    } else if (!protocol.hasSuccessTerminal()) {
      finishTermination(
        { status: "PROTOCOL_ERROR", reason: "missing_success_terminal" },
        code,
        signal,
      );
    } else {
      finish({
        status: "SUCCEEDED",
        exitCode: 0,
        signal: null,
        requiresConfirmation: false,
        automaticRetry: false,
      });
    }
  }

  function onStdinFinish(): void {
    stdinFinishObserved = true;
  }

  const endStdin = (): void => {
    if (stdinEndRequested || child.stdin.writableEnded) return;
    stdinEndRequested = true;
    try {
      child.stdin.end();
    } catch {
      beginTermination({ status: "IO_ERROR", reason: "stdin_error" });
    }
  };

  const onDrain = (): void => {
    if (!settled && !pendingTermination) endStdin();
  };

  child.on("error", onChildError);
  child.on("close", onClose);
  child.stdin.on("error", onStdinError);
  child.stdin.on("finish", onStdinFinish);
  child.stdout.on("data", onStdoutData);
  child.stdout.on("end", onStdoutEnd);
  child.stdout.on("error", onStdoutError);
  child.stderr.on("data", discardStderr);
  child.stderr.on("error", onStderrError);
  resetIdle();

  try {
    const accepted = child.stdin.write(prompt, "utf8");
    if (accepted) endStdin();
    else child.stdin.once("drain", onDrain);
  } catch {
    onStdinError();
  }

  return { events, terminationEvents, result };
}

export function createCodexRunner(dependencies: CodexRunnerDependencies) {
  let stableDependencies: CodexRunnerDependencies | null = null;
  try {
    stableDependencies = snapshotRunnerDependencies(dependencies);
  } catch {
    // Keep construction side-effect free while preserving the async start API.
  }
  return {
    async start(input: CodexRunRequest): Promise<CodexRunHandle> {
      if (stableDependencies === null) {
        throw new Error("invalid Codex runner dependencies");
      }
      const request = snapshotRunRequest(input);
      const invocation = await verifyInvocation(stableDependencies, request);
      let child: CodexChildProcess;
      try {
        child = stableDependencies.spawn(
          invocation.command,
          invocation.args,
          invocation.options,
        );
      } catch {
        return completedRun({
          status: "SPAWN_ERROR",
          exitCode: null,
          signal: null,
          reason: "spawn_error",
          requiresConfirmation: true,
          automaticRetry: false,
        });
      }
      return startChildRun(child, request.prompt, request.sessionId);
    },
  };
}
