import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import {
  MVP_CAPABILITIES,
  createLarkCliMutationProvider,
  createMvpConfirmationCoordinator,
  createMvpGatewayRegistry,
  startRunServer,
  type LocalSocketHandle,
  type MvpConfirmationCoordinator,
  type MvpDispatchAction,
  type MvpLarkCliRunner,
  type MvpProviderResult,
  parseStrictJsonText,
} from "@executive-assistant/action-gateway";
import {
  startChannel,
  type AssistantChannelDependencies,
  type BridgeChannel,
  type LifecycleState,
  type RawEnvelope,
  type SdkCardActionEvent,
  type SdkIngressSource,
  type SdkMessageEvent,
  type SystemText,
} from "@executive-assistant/bridge";
import type {
  CancelActiveTaskRequest,
  InboundEvent,
} from "@executive-assistant/contracts";
import {
  acquireDatabaseFileLock,
  openJobStore,
  type DatabaseFileLock,
  type JobStore,
  type TaskRecord,
} from "@executive-assistant/job-store";

import { decideIngress } from "../../bridge/src/security/ingress-guard.js";
import type { AccessPolicy } from "../../bridge/src/security/policy.js";
import { openSessionStore, type SessionStore } from "./session-store.js";
import {
  readAcknowledgementMarker,
  writeAcknowledgementMarker,
} from "./acknowledgement-file.js";
import {
  createAckCoordinator,
  sleepForAcknowledgement,
  type AcknowledgementRoute,
} from "./ack-coordinator.js";
import type {
  CodexRunEvent,
  CodexRunHandle,
  ExecutiveRuntime,
  RuntimeConfig,
  RuntimeDependencies,
  RuntimeTransport,
} from "./types.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const LEASE_TTL_MS = 60_000;
const LEASE_REFRESH_MS = 15_000;
const MAX_PROMPT_LENGTH = 200_000;
const MAX_RESULT_FILES = 10;
const MAX_RESULT_MANIFEST_BYTES = 64 * 1024;
const MAX_RESULT_FILE_BYTES = 25 * 1024 * 1024;
const MAX_RESULT_TOTAL_BYTES = 50 * 1024 * 1024;

type TaskInput = Readonly<{
  version: 1;
  prompt: string;
  chatId: string;
  messageId: string;
  eventId: string;
  receivedAt: string;
}>;

type ReplyRoute = Readonly<{
  chatId: string;
  messageId: string;
}>;

type PairingState = Readonly<{
  version: 1;
  appId: string;
  tenantKey: string;
  presidentOpenId: string;
  presidentChatId: string;
  pairedAt: string;
}>;

type ActiveRun = {
  taskId: string;
  input: TaskInput;
  handle: CodexRunHandle;
  sessionId: string | undefined;
  cancelled: boolean;
};

type PendingActionOutcome =
  | "SUCCEEDED"
  | "FAILED"
  | "UNKNOWN"
  | "REJECTED"
  | "EXPIRED"
  | "CANCELLED";

type PendingAction = {
  actionId: string;
  taskId: string;
  input: TaskInput;
  payloadHash: string;
  nonce: string;
  expiresAt: string;
  cardMessageId: string | undefined;
  ready: Promise<void>;
  markReady(): void;
  outcome: Promise<PendingActionOutcome>;
  settle(outcome: PendingActionOutcome): void;
};

type ResultFile = Readonly<{
  path: string;
  fileName: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value === value.trim() &&
    !value.includes("\0")
  );
}

function taskInput(value: unknown): TaskInput {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 6
  ) {
    throw new Error("TASK_INPUT_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.prompt !== "string" ||
    record.prompt.length === 0 ||
    record.prompt.length > MAX_PROMPT_LENGTH ||
    !exactIdentifier(record.chatId) ||
    !exactIdentifier(record.messageId) ||
    !exactIdentifier(record.eventId) ||
    typeof record.receivedAt !== "string" ||
    !Number.isFinite(Date.parse(record.receivedAt))
  ) {
    throw new Error("TASK_INPUT_INVALID");
  }
  return Object.freeze({
    version: 1,
    prompt: record.prompt,
    chatId: record.chatId,
    messageId: record.messageId,
    eventId: record.eventId,
    receivedAt: record.receivedAt,
  });
}

function messageText(value: unknown): string {
  if (typeof value !== "string") throw new Error("MESSAGE_TEXT_INVALID");
  let text = value;
  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        typeof (parsed as Record<string, unknown>).text === "string"
      ) {
        const parsedText = (parsed as Record<string, unknown>).text;
        if (typeof parsedText === "string") text = parsedText;
      }
    } catch {
      // The bridge test seam already projects text. A non-JSON string is valid.
    }
  }
  const normalized = text.normalize("NFC").trim();
  if (normalized.length === 0 || normalized.length > MAX_PROMPT_LENGTH) {
    throw new Error("MESSAGE_TEXT_INVALID");
  }
  return normalized;
}

function payloadDigest(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new Error("RUNTIME_DIRECTORY_NOT_PRIVATE");
  }
  if ((await realpath(path)) !== path) {
    throw new Error("RUNTIME_DIRECTORY_NOT_CANONICAL");
  }
}

async function writePrivateJson(
  path: string,
  value: Readonly<Record<string, unknown>>,
): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readPairingState(
  path: string,
  config: RuntimeConfig,
): Promise<PairingState | null> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return null;
    }
    throw cause;
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (metadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
    (typeof process.getuid === "function" &&
      metadata.uid !== process.getuid()) ||
    (await realpath(path)) !== path
  ) {
    throw new Error("PAIRING_STATE_INVALID");
  }
  const parsed = JSON.parse((await readFile(path)).toString("utf8")) as unknown;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Reflect.ownKeys(parsed).length !== 6
  ) {
    throw new Error("PAIRING_STATE_INVALID");
  }
  const state = parsed as Record<string, unknown>;
  if (
    state.version !== 1 ||
    state.appId !== config.appId ||
    !exactIdentifier(state.tenantKey) ||
    (config.tenantKey !== null && state.tenantKey !== config.tenantKey) ||
    !exactIdentifier(state.presidentOpenId) ||
    !exactIdentifier(state.presidentChatId) ||
    typeof state.pairedAt !== "string" ||
    !Number.isFinite(Date.parse(state.pairedAt))
  ) {
    throw new Error("PAIRING_STATE_INVALID");
  }
  return Object.freeze({
    version: 1,
    appId: config.appId,
    tenantKey: state.tenantKey,
    presidentOpenId: state.presidentOpenId,
    presidentChatId: state.presidentChatId,
    pairedAt: state.pairedAt,
  });
}

async function readTaskInput(workspacePath: string): Promise<TaskInput> {
  const path = join(workspacePath, "input.json");
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size <= 0 ||
    metadata.size > MAX_PROMPT_LENGTH + 4 * 1024 ||
    (metadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
    (typeof process.getuid === "function" &&
      metadata.uid !== process.getuid()) ||
    (await realpath(path)) !== path
  ) {
    throw new Error("TASK_INPUT_INVALID");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    await readFile(path),
  );
  return taskInput(parseStrictJsonText(text));
}

function confirmationValue(value: unknown): Readonly<{
  actionId: string;
  actionPayloadHash: string;
  nonce: string;
  decision: "approve" | "reject";
}> | null {
  if (!isRecord(value) || !isRecord(value.value)) return null;
  const action = value.value;
  const keys = Reflect.ownKeys(action);
  if (
    keys.length !== 5 ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        ![
          "version",
          "actionId",
          "actionPayloadHash",
          "nonce",
          "decision",
        ].includes(key),
    ) ||
    action.version !== 1 ||
    !exactIdentifier(action.actionId) ||
    !exactIdentifier(action.actionPayloadHash) ||
    !exactIdentifier(action.nonce) ||
    (action.decision !== "approve" && action.decision !== "reject")
  ) {
    return null;
  }
  return Object.freeze({
    actionId: action.actionId,
    actionPayloadHash: action.actionPayloadHash,
    nonce: action.nonce,
    decision: action.decision,
  });
}

function runnerPrompt(prompt: string): string {
  return [
    prompt,
    "",
    "必须先完整读取并遵守已安装的 $executive-assistant Skill。需要飞书能力时，只能按该 Skill 的五项 stdin JSON 合同调用 ASSISTANT_GATEWAY_CLIENT；不得直接调用 lark-cli、飞书 API 或自行发送外部写操作。",
    "运行时交付约定：如需把文件回传到当前飞书私聊，只能把文件写入当前任务目录，并在任务目录创建 result-files.json。",
    '清单格式必须是 {"version":1,"files":["相对路径"]}；没有文件时不要创建该清单。不要把目录、符号链接或任务目录外路径写入清单。',
  ].join("\n");
}

async function resultFiles(
  workspacePath: string,
): Promise<readonly ResultFile[]> {
  const manifestPath = join(workspacePath, "result-files.json");
  let manifestMetadata: Awaited<ReturnType<typeof lstat>>;
  try {
    manifestMetadata = await lstat(manifestPath);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return Object.freeze([]);
    }
    throw cause;
  }
  if (
    manifestMetadata.isSymbolicLink() ||
    !manifestMetadata.isFile() ||
    manifestMetadata.size <= 0 ||
    manifestMetadata.size > MAX_RESULT_MANIFEST_BYTES ||
    (typeof process.getuid === "function" &&
      manifestMetadata.uid !== process.getuid()) ||
    (await realpath(manifestPath)) !== manifestPath
  ) {
    throw new Error("RESULT_FILE_MANIFEST_INVALID");
  }
  const parsed = JSON.parse(
    (await readFile(manifestPath)).toString("utf8"),
  ) as unknown;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Reflect.ownKeys(parsed).length !== 2
  ) {
    throw new Error("RESULT_FILE_MANIFEST_INVALID");
  }
  const manifest = parsed as Record<string, unknown>;
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.length > MAX_RESULT_FILES
  ) {
    throw new Error("RESULT_FILE_MANIFEST_INVALID");
  }
  const seen = new Set<string>();
  const files: ResultFile[] = [];
  let totalBytes = 0;
  for (const entry of manifest.files) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > 512 ||
      entry.includes("\0") ||
      isAbsolute(entry) ||
      entry === "result-files.json"
    ) {
      throw new Error("RESULT_FILE_PATH_INVALID");
    }
    const candidate = resolve(workspacePath, entry);
    if (
      candidate === workspacePath ||
      !candidate.startsWith(`${workspacePath}${sep}`) ||
      seen.has(candidate)
    ) {
      throw new Error("RESULT_FILE_PATH_INVALID");
    }
    const metadata = await lstat(candidate);
    const canonical = await realpath(candidate);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      canonical !== candidate ||
      !canonical.startsWith(`${workspacePath}${sep}`) ||
      metadata.size <= 0 ||
      metadata.size > MAX_RESULT_FILE_BYTES ||
      (typeof process.getuid === "function" &&
        metadata.uid !== process.getuid())
    ) {
      throw new Error("RESULT_FILE_INVALID");
    }
    totalBytes += metadata.size;
    if (totalBytes > MAX_RESULT_TOTAL_BYTES) {
      throw new Error("RESULT_FILES_TOO_LARGE");
    }
    await chmod(candidate, PRIVATE_FILE_MODE);
    seen.add(candidate);
    files.push(
      Object.freeze({
        path: candidate,
        fileName: basename(candidate),
      }),
    );
  }
  return Object.freeze(files);
}

function sourceProjection(transport: RuntimeTransport): SdkIngressSource {
  return Object.freeze({
    onMessage(handler: (event: SdkMessageEvent) => Promise<void>) {
      return transport.onMessage(handler);
    },
    onCardAction(handler: (event: SdkCardActionEvent) => Promise<void>) {
      return transport.onCardAction(handler);
    },
    onLifecycle(handler: (state: LifecycleState, detail?: unknown) => void) {
      return transport.onLifecycle(handler);
    },
    async connect() {
      await transport.connect();
    },
    async disconnect() {
      await transport.disconnect();
    },
  });
}

function threadIdFromEvent(event: CodexRunEvent): string | null {
  return event.type === "thread.started" && exactIdentifier(event.thread_id)
    ? event.thread_id
    : null;
}

function agentMessageFromEvent(event: CodexRunEvent): string | null {
  if (
    event.type !== "item.completed" ||
    event.item === null ||
    typeof event.item !== "object" ||
    Array.isArray(event.item)
  ) {
    return null;
  }
  const item = event.item as Record<string, unknown>;
  return item.type === "agent_message" &&
    typeof item.text === "string" &&
    item.text.trim().length > 0
    ? item.text.trim()
    : null;
}

function replyResult(
  result: void | Readonly<{ messageId: string }>,
): Readonly<{ state: "SUCCEEDED"; remoteId?: string }> {
  if (result && exactIdentifier(result.messageId)) {
    return Object.freeze({
      state: "SUCCEEDED" as const,
      remoteId: result.messageId,
    });
  }
  return Object.freeze({ state: "SUCCEEDED" as const });
}

export async function startExecutiveRuntime(
  config: RuntimeConfig,
  dependencies: RuntimeDependencies,
): Promise<ExecutiveRuntime> {
  if (dirname(config.paths.databasePath) !== config.paths.runtimeRoot) {
    throw new Error("DATABASE_PATH_MUST_BE_RUNTIME_CHILD");
  }
  await ensurePrivateDirectory(config.paths.runtimeRoot);
  await ensurePrivateDirectory(config.paths.jobsRoot);
  const pairingPath = join(config.paths.runtimeRoot, "pairing.json");
  const persistedPairing = await readPairingState(pairingPath, config);
  if (
    persistedPairing &&
    config.presidentOpenId !== null &&
    (persistedPairing.presidentOpenId !== config.presidentOpenId ||
      persistedPairing.presidentChatId !== config.presidentChatId)
  ) {
    throw new Error("PAIRING_STATE_CONFLICT");
  }

  const instanceId = dependencies.instanceId ?? randomUUID();
  const now = dependencies.now ?? (() => new Date());
  const lock: DatabaseFileLock = await acquireDatabaseFileLock(
    config.paths.runtimeRoot,
  );
  let store: JobStore | undefined;
  let channel: BridgeChannel | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let startupLeaseHeartbeat: NodeJS.Timeout | undefined;
  let acknowledgementCoordinator:
    | ReturnType<typeof createAckCoordinator>
    | undefined;
  try {
    store = openJobStore({
      filename: config.paths.databasePath,
      instanceId,
      lock,
    });
    if (!store.acquireRuntimeLease("bridge", instanceId, now(), LEASE_TTL_MS)) {
      throw new Error("RUNTIME_LEASE_UNAVAILABLE");
    }
    const taskRoutes = new Map<string, ReplyRoute>();
    const legacyAcknowledgementTasks = new Set<string>();
    for (const candidate of store.listTaskAcknowledgementRecoveryCandidates()) {
      const before = store.getTaskAcknowledgement(candidate.taskId);
      const marker = await readAcknowledgementMarker(
        candidate.workspacePath,
        candidate.taskId,
        Object.freeze({ allowLegacyV1: before === null }),
      );
      if (marker?.version === 1) {
        legacyAcknowledgementTasks.add(candidate.taskId);
      }
      const reconciled = store.reconcileTaskAcknowledgement({
        taskId: candidate.taskId,
        owner: instanceId,
        now: now(),
        markerPresent: marker !== null,
      });
      if (
        reconciled?.state === "NOT_ATTEMPTED" ||
        reconciled?.state === "RETRYABLE_DNS" ||
        reconciled?.state === "ACKNOWLEDGED"
      ) {
        const input = await readTaskInput(candidate.workspacePath);
        taskRoutes.set(
          candidate.taskId,
          Object.freeze({ chatId: input.chatId, messageId: input.messageId }),
        );
      }
    }
    store.recoverOnStartup(now());
    startupLeaseHeartbeat = setInterval(() => {
      try {
        store?.acquireRuntimeLease("bridge", instanceId, now(), LEASE_TTL_MS);
      } catch {
        // The post-resolution lease check below remains the startup gate.
      }
    }, LEASE_REFRESH_MS);
    startupLeaseHeartbeat.unref();
    const tenantKey = await dependencies.transport.resolveTenantKey(
      Object.freeze({
        expectedTenantKey: persistedPairing?.tenantKey ?? config.tenantKey,
        presidentOpenId:
          config.presidentOpenId ?? persistedPairing?.presidentOpenId ?? null,
        presidentChatId:
          config.presidentChatId ?? persistedPairing?.presidentChatId ?? null,
        pairingCodeHash: config.pairing.codeHash,
        pairingExpiresAt: config.pairing.expiresAt,
      }),
    );
    clearInterval(startupLeaseHeartbeat);
    startupLeaseHeartbeat = undefined;
    if (!store.acquireRuntimeLease("bridge", instanceId, now(), LEASE_TTL_MS)) {
      throw new Error("RUNTIME_LEASE_LOST");
    }
    const boundPresidentOpenId =
      config.presidentOpenId ?? persistedPairing?.presidentOpenId ?? null;
    const boundPresidentChatId =
      config.presidentChatId ?? persistedPairing?.presidentChatId ?? null;
    if (boundPresidentOpenId !== null && boundPresidentChatId !== null) {
      store.bindPrincipal({
        appId: config.appId,
        tenantKey,
        presidentOpenId: boundPresidentOpenId,
        presidentChatId: boundPresidentChatId,
        pairedAt: now(),
      });
    }

    const sessionStore: SessionStore = await openSessionStore(
      join(config.paths.runtimeRoot, "sessions.json"),
    );
    let policy: AccessPolicy = Object.freeze({
      appId: config.appId,
      tenantKey,
      presidentOpenId:
        config.presidentOpenId ?? persistedPairing?.presidentOpenId ?? null,
      presidentChatId:
        config.presidentChatId ?? persistedPairing?.presidentChatId ?? null,
      pairing: Object.freeze(
        config.presidentOpenId === null && persistedPairing === null
          ? {
              active: true,
              codeHash: config.pairing.codeHash,
            }
          : { active: false, codeHash: null },
      ),
    });
    const staged = new Map<string, TaskInput>();
    const controlRoutes = new Map<string, ReplyRoute>();
    const pendingActions = new Map<string, PendingAction>();
    const pendingActionByTask = new Map<string, string>();
    const confirmationOperations = new Map<string, Promise<void>>();
    let activeRun: ActiveRun | undefined;
    let drainPromise: Promise<void> | undefined;
    let lastError: unknown;
    let closing = false;

    const renewLease = (): void => {
      if (
        !store?.acquireRuntimeLease("bridge", instanceId, now(), LEASE_TTL_MS)
      ) {
        throw new Error("RUNTIME_LEASE_LOST");
      }
    };

    const actionProvider = Object.freeze({
      async dispatch(action: MvpDispatchAction): Promise<MvpProviderResult> {
        if (!store) return Object.freeze({ state: "UNKNOWN" as const });
        const persisted = store.getAction({
          actionId: action.actionId,
          version: 1,
        });
        if (
          persisted?.taskId === null ||
          persisted?.taskId === undefined ||
          persisted.taskId.length === 0
        ) {
          return Object.freeze({ state: "UNKNOWN" as const });
        }
        const task = store.getTask(persisted.taskId);
        if (task === null) {
          return Object.freeze({ state: "UNKNOWN" as const });
        }
        const runner = dependencies.larkRunnerFactory(task.workspacePath);
        return createLarkCliMutationProvider(runner).dispatch(action);
      },
    });
    const confirmationCoordinator: MvpConfirmationCoordinator =
      createMvpConfirmationCoordinator({
        store,
        provider: actionProvider,
        owner: instanceId,
        now,
      });

    const settlePendingAction = (
      pending: PendingAction,
      outcome: PendingActionOutcome,
    ): void => {
      pending.settle(outcome);
      pendingActions.delete(pending.actionId);
      if (pendingActionByTask.get(pending.taskId) === pending.actionId) {
        pendingActionByTask.delete(pending.taskId);
      }
    };

    const createPendingAction = (
      taskId: string,
      input: TaskInput,
      prepared: Readonly<{
        actionId: string;
        payloadHash: string;
        nonce: string;
        expiresAt: string;
      }>,
    ): PendingAction => {
      let resolveOutcome: (outcome: PendingActionOutcome) => void = () =>
        undefined;
      let resolveReady: () => void = () => undefined;
      let settled = false;
      let ready = false;
      const expiryTimer: { current: NodeJS.Timeout | undefined } = {
        current: undefined,
      };
      const outcome = new Promise<PendingActionOutcome>(
        (resolveOutcomeValue) => {
          resolveOutcome = resolveOutcomeValue;
        },
      );
      const readyPromise = new Promise<void>((resolveReadyValue) => {
        resolveReady = resolveReadyValue;
      });
      const pending: PendingAction = {
        actionId: prepared.actionId,
        taskId,
        input,
        payloadHash: prepared.payloadHash,
        nonce: prepared.nonce,
        expiresAt: prepared.expiresAt,
        cardMessageId: undefined,
        ready: readyPromise,
        markReady() {
          if (ready) return;
          ready = true;
          resolveReady();
        },
        outcome,
        settle(nextOutcome) {
          if (settled) return;
          settled = true;
          if (expiryTimer.current) clearTimeout(expiryTimer.current);
          resolveOutcome(nextOutcome);
        },
      };
      const previousId = pendingActionByTask.get(taskId);
      const previous = previousId ? pendingActions.get(previousId) : undefined;
      if (previous) settlePendingAction(previous, "REJECTED");
      pendingActions.set(pending.actionId, pending);
      pendingActionByTask.set(taskId, pending.actionId);
      const expiresIn = Math.max(
        0,
        Date.parse(prepared.expiresAt) - now().getTime(),
      );
      expiryTimer.current = setTimeout(() => {
        if (pendingActions.get(pending.actionId) !== pending) return;
        void (async () => {
          await pending.ready;
          if (pendingActions.get(pending.actionId) !== pending) return;
          await dependencies.transport
            .sendText(
              Object.freeze({
                chatId: input.chatId,
                text: "确认已超时，这项操作没有执行。",
                replyToMessageId: input.messageId,
              }),
            )
            .catch(() => undefined);
          settlePendingAction(pending, "EXPIRED");
        })();
      }, expiresIn);
      expiryTimer.current.unref();
      return pending;
    };

    const markFailed = async (
      task: TaskRecord,
      preferredSessionId?: string,
    ): Promise<void> => {
      if (!store) return;
      renewLease();
      let current = store.getTask(task.id);
      if (current?.state === "CLAIMED") {
        const sessionId = preferredSessionId ?? `unavailable:${task.id}`;
        current = store.markRunning({
          taskId: task.id,
          owner: instanceId,
          codexSessionId: sessionId,
          now: now(),
          ttlMs: LEASE_TTL_MS,
        });
      }
      if (current?.state === "RUNNING" && current.codexSessionId !== null) {
        store.finishTask({
          taskId: task.id,
          owner: instanceId,
          codexSessionId: current.codexSessionId,
          now: now(),
          outcome: "FAILED",
        });
      }
    };

    const sendFailure = async (input: TaskInput): Promise<void> => {
      await dependencies.transport.sendText(
        Object.freeze({
          chatId: input.chatId,
          text: "任务未完成，请稍后重试。",
          replyToMessageId: input.messageId,
        }),
      );
    };

    const processTask = async (task: TaskRecord): Promise<void> => {
      if (!store) throw new Error("RUNTIME_CLOSED");
      const input = await readTaskInput(task.workspacePath);
      if (
        (await readAcknowledgementMarker(
          task.workspacePath,
          task.id,
          Object.freeze({
            allowLegacyV1: legacyAcknowledgementTasks.has(task.id),
          }),
        )) === null
      ) {
        await markFailed(task);
        return;
      }
      if (store.getTask(task.id)?.state === "CANCELLED") return;
      const priorSessionId = sessionStore.get(input.chatId);
      const runInput = priorSessionId
        ? Object.freeze({
            taskId: task.id,
            prompt: runnerPrompt(input.prompt),
            workspace: task.workspacePath,
            gatewaySocket: join(task.workspacePath, "gateway.sock"),
            gatewayClient: config.executables.gatewayClient,
            sessionId: priorSessionId,
          })
        : Object.freeze({
            taskId: task.id,
            prompt: runnerPrompt(input.prompt),
            workspace: task.workspacePath,
            gatewaySocket: join(task.workspacePath, "gateway.sock"),
            gatewayClient: config.executables.gatewayClient,
          });
      const gatewayActivity = new Set<Promise<unknown>>();
      const trackGatewayActivity = <T>(
        operation: () => Promise<T>,
      ): Promise<T> => {
        const activeOperation = Promise.resolve().then(operation);
        gatewayActivity.add(activeOperation);
        void activeOperation.then(
          () => gatewayActivity.delete(activeOperation),
          () => gatewayActivity.delete(activeOperation),
        );
        return activeOperation;
      };
      const rawLarkRunner = dependencies.larkRunnerFactory(task.workspacePath);
      const larkRunner: MvpLarkCliRunner = Object.freeze({
        runBot(request: Parameters<MvpLarkCliRunner["runBot"]>[0]) {
          return trackGatewayActivity(() => rawLarkRunner.runBot(request));
        },
        runUser(request: Parameters<MvpLarkCliRunner["runUser"]>[0]) {
          return trackGatewayActivity(() => rawLarkRunner.runUser(request));
        },
      });
      let gateway: LocalSocketHandle | undefined;
      const startGateway = async (): Promise<void> => {
        if (gateway) return;
        const presidentOpenId = policy.presidentOpenId;
        const presidentChatId = policy.presidentChatId;
        if (
          !exactIdentifier(presidentOpenId) ||
          !exactIdentifier(presidentChatId)
        ) {
          throw new Error("TASK_PRINCIPAL_NOT_PAIRED");
        }
        const registry = createMvpGatewayRegistry({
          runner: larkRunner,
          actionStore: store as JobStore,
          now,
          onPrepared: async (_context, prepared, preview) => {
            await trackGatewayActivity(async () => {
              const pending = createPendingAction(task.id, input, {
                actionId: prepared.actionId,
                payloadHash: prepared.payloadHash,
                nonce: prepared.nonce,
                expiresAt: prepared.expiresAt,
              });
              try {
                const result =
                  await dependencies.transport.sendConfirmationCard(
                    Object.freeze({
                      chatId: input.chatId,
                      replyToMessageId: input.messageId,
                      actionId: prepared.actionId,
                      actionPayloadHash: prepared.payloadHash,
                      nonce: prepared.nonce,
                      expiresAt: prepared.expiresAt,
                      preview,
                    }),
                  );
                if (!result || !exactIdentifier(result.messageId)) {
                  settlePendingAction(pending, "FAILED");
                  throw new Error("CONFIRMATION_CARD_MESSAGE_ID_MISSING");
                }
                pending.cardMessageId = result.messageId;
              } catch (cause) {
                settlePendingAction(pending, "FAILED");
                throw cause;
              }
            });
          },
        });
        gateway = await startRunServer({
          socketPath: runInput.gatewaySocket,
          context: Object.freeze({
            channel: "run",
            taskId: task.id,
            presidentOpenId,
            presidentChatId,
            capabilities: MVP_CAPABILITIES,
          }),
          jobStore: store as JobStore,
          registry,
          waitUntilTaskActionsSafe: async () => {
            await Promise.allSettled([...gatewayActivity]);
          },
        });
      };

      if (priorSessionId) {
        renewLease();
        const running = store.markRunning({
          taskId: task.id,
          owner: instanceId,
          codexSessionId: priorSessionId,
          now: now(),
          ttlMs: LEASE_TTL_MS,
        });
        if (running === null) throw new Error("TASK_MARK_RUNNING_FAILED");
        await startGateway();
      }

      let handle: CodexRunHandle;
      try {
        handle = await dependencies.runner.start(runInput);
      } catch (cause) {
        await gateway?.close().catch(() => undefined);
        await markFailed(task, priorSessionId);
        await sendFailure(input).catch(() => undefined);
        throw cause;
      }
      const active: ActiveRun = {
        taskId: task.id,
        input,
        handle,
        sessionId: priorSessionId,
        cancelled: false,
      };
      activeRun = active;
      if (store.getTask(task.id)?.state === "CANCELLED") {
        active.cancelled = true;
        await handle.stop().catch(() => undefined);
        await gateway?.close().catch(() => undefined);
        if (activeRun === active) activeRun = undefined;
        return;
      }
      const cancellationObserved = (): boolean => {
        const cancelled =
          active.cancelled || store?.getTask(task.id)?.state === "CANCELLED";
        if (cancelled) active.cancelled = true;
        return cancelled;
      };
      let threadId: string | undefined;
      let finalMessage: string | undefined;
      let eventError: unknown;
      const consumeEvents = async (): Promise<void> => {
        try {
          for await (const event of handle.events) {
            const observedThreadId = threadIdFromEvent(event);
            if (observedThreadId !== null) {
              if (threadId !== undefined && threadId !== observedThreadId) {
                throw new Error("CODEX_THREAD_ID_CHANGED");
              }
              threadId = observedThreadId;
              active.sessionId = observedThreadId;
              const current = store?.getTask(task.id);
              if (current?.state === "CLAIMED") {
                renewLease();
                const running = store?.markRunning({
                  taskId: task.id,
                  owner: instanceId,
                  codexSessionId: observedThreadId,
                  now: now(),
                  ttlMs: LEASE_TTL_MS,
                });
                if (running === null) {
                  throw new Error("TASK_MARK_RUNNING_FAILED");
                }
                await startGateway();
              }
            }
            const observedMessage = agentMessageFromEvent(event);
            if (observedMessage !== null) finalMessage = observedMessage;
          }
        } catch (cause) {
          eventError = cause;
        }
      };

      try {
        const [runResult] = await Promise.all([handle.result, consumeEvents()]);
        await gateway?.close();
        gateway = undefined;
        if (eventError) throw eventError;
        if (cancellationObserved()) return;
        if (
          runResult.status !== "SUCCEEDED" ||
          threadId === undefined ||
          finalMessage === undefined
        ) {
          await markFailed(task, active.sessionId);
          await sendFailure(input);
          return;
        }

        const files = await resultFiles(task.workspacePath);
        if (cancellationObserved()) return;
        await sessionStore.set(input.chatId, threadId);
        if (cancellationObserved()) return;
        await dependencies.transport.sendText(
          Object.freeze({
            chatId: input.chatId,
            text: finalMessage,
            replyToMessageId: input.messageId,
          }),
        );
        for (const file of files) {
          if (cancellationObserved()) return;
          await dependencies.transport.sendFile(
            Object.freeze({
              chatId: input.chatId,
              path: file.path,
              fileName: file.fileName,
              replyToMessageId: input.messageId,
            }),
          );
        }
        const pendingActionId = pendingActionByTask.get(task.id);
        const pending = pendingActionId
          ? pendingActions.get(pendingActionId)
          : undefined;
        if (cancellationObserved()) return;
        if (pending) {
          pending.markReady();
          const outcome = await pending.outcome;
          if (cancellationObserved() || outcome === "CANCELLED") return;
          if (outcome === "UNKNOWN" || outcome === "EXPIRED") {
            await markFailed(task, threadId);
            return;
          }
        }
        if (cancellationObserved()) return;
        renewLease();
        const finished = store.finishTask({
          taskId: task.id,
          owner: instanceId,
          codexSessionId: threadId,
          now: now(),
          outcome: "SUCCEEDED",
        });
        if (finished === null) throw new Error("TASK_FINISH_FAILED");
      } catch (cause) {
        await markFailed(task, active.sessionId).catch(() => undefined);
        const pendingId = pendingActionByTask.get(task.id);
        const pending = pendingId ? pendingActions.get(pendingId) : undefined;
        if (pending) {
          pending.markReady();
          settlePendingAction(pending, "FAILED");
        }
        if (!cancellationObserved()) {
          await sendFailure(input).catch(() => undefined);
          throw cause;
        }
      } finally {
        await gateway?.close().catch(() => undefined);
        if (activeRun === active) activeRun = undefined;
      }
    };

    const drain = async (): Promise<void> => {
      if (!store) return;
      while (!closing) {
        renewLease();
        const task = store.claimNextTask(instanceId, now(), LEASE_TTL_MS);
        if (task === null) return;
        try {
          await processTask(task);
        } catch (cause) {
          lastError = cause;
          return;
        }
      }
    };

    const wakeWorker = (): void => {
      if (closing || drainPromise !== undefined) return;
      drainPromise = drain()
        .catch((cause) => {
          lastError = cause;
        })
        .finally(() => {
          drainPromise = undefined;
        });
    };

    const activeStore = store;
    const loadAcknowledgementRoute = async (
      taskId: string,
    ): Promise<AcknowledgementRoute> => {
      const existing = taskRoutes.get(taskId);
      if (existing) {
        return Object.freeze({ taskId, ...existing });
      }
      const task = activeStore.getTask(taskId);
      if (task === null) throw new Error("ACKNOWLEDGEMENT_ROUTE_UNAVAILABLE");
      const input = await readTaskInput(task.workspacePath);
      const route = Object.freeze({
        chatId: input.chatId,
        messageId: input.messageId,
      });
      taskRoutes.set(taskId, route);
      return Object.freeze({ taskId, ...route });
    };

    acknowledgementCoordinator = createAckCoordinator({
      store: activeStore,
      owner: instanceId,
      now,
      delay: dependencies.acknowledgementDelay ?? sleepForAcknowledgement,
      loadRoute: loadAcknowledgementRoute,
      async send(route) {
        return dependencies.transport.sendAcknowledgement(
          Object.freeze({
            chatId: route.chatId,
            text: "收到，我开始处理",
            replyToMessageId: route.messageId,
          }),
        );
      },
      async writeMarker(taskId, acknowledgedAt) {
        const task = activeStore.getTask(taskId);
        if (task === null) throw new Error("ACKNOWLEDGEMENT_TASK_UNAVAILABLE");
        await writeAcknowledgementMarker(
          task.workspacePath,
          taskId,
          acknowledgedAt,
        );
      },
      wakeWorker,
    });

    const runtimePorts: AssistantChannelDependencies = Object.freeze({
      ingressGuard(
        metadata: Parameters<AssistantChannelDependencies["ingressGuard"]>[0],
      ) {
        if (
          policy.pairing.active &&
          config.pairing.expiresAt !== null &&
          Date.parse(config.pairing.expiresAt) < now().getTime()
        ) {
          return Object.freeze({
            kind: "deny" as const,
            reason: "not_paired" as const,
          });
        }
        return decideIngress(metadata, policy);
      },
      pairingSink: Object.freeze({
        async consume(raw: RawEnvelope) {
          if (
            !policy.pairing.active ||
            !exactIdentifier(raw.metadata.senderOpenId) ||
            !exactIdentifier(raw.metadata.chatId)
          ) {
            throw new Error("PAIRING_STATE_INVALID");
          }
          const next: PairingState = Object.freeze({
            version: 1,
            appId: config.appId,
            tenantKey,
            presidentOpenId: raw.metadata.senderOpenId,
            presidentChatId: raw.metadata.chatId,
            pairedAt: raw.receivedAt,
          });
          try {
            await writePrivateJson(pairingPath, next);
          } catch (cause) {
            if (
              !(
                cause instanceof Error &&
                "code" in cause &&
                cause.code === "EEXIST"
              )
            ) {
              throw cause;
            }
            const existing = await readPairingState(pairingPath, config);
            if (
              existing?.presidentOpenId !== next.presidentOpenId ||
              existing.presidentChatId !== next.presidentChatId
            ) {
              throw new Error("PAIRING_STATE_CONFLICT");
            }
          }
          store?.bindPrincipal({
            appId: config.appId,
            tenantKey,
            presidentOpenId: next.presidentOpenId,
            presidentChatId: next.presidentChatId,
            pairedAt: now(),
          });
          policy = Object.freeze({
            appId: config.appId,
            tenantKey,
            presidentOpenId: next.presidentOpenId,
            presidentChatId: next.presidentChatId,
            pairing: Object.freeze({ active: false, codeHash: null }),
          });
          await dependencies.transport.sendText(
            Object.freeze({
              chatId: next.presidentChatId,
              text: "配对完成，可以开始给我任务了。",
              replyToMessageId: raw.messageId,
            }),
          );
        },
      }),
      confirmationSink: Object.freeze({
        async consume(
          raw: Parameters<
            AssistantChannelDependencies["confirmationSink"]["consume"]
          >[0],
          binding: Parameters<
            AssistantChannelDependencies["confirmationSink"]["consume"]
          >[1],
        ) {
          const action = confirmationValue(raw.readBody());
          if (
            action === null ||
            action.nonce !== binding.nonce ||
            raw.metadata.senderOpenId !== policy.presidentOpenId ||
            raw.metadata.chatId !== policy.presidentChatId
          ) {
            return;
          }
          const pending = pendingActions.get(action.actionId);
          if (
            pending === undefined ||
            pending.payloadHash !== action.actionPayloadHash ||
            pending.nonce !== action.nonce ||
            pending.cardMessageId !== raw.messageId
          ) {
            await dependencies.transport.sendText(
              Object.freeze({
                chatId: raw.metadata.chatId,
                text: "这个确认已经失效或处理过，不会重复执行。",
                replyToMessageId: raw.messageId,
              }),
            );
            return;
          }
          const existing = confirmationOperations.get(action.actionId);
          if (existing) {
            await existing;
            return;
          }
          const operation = (async (): Promise<void> => {
            let outcome: PendingActionOutcome = "FAILED";
            let text = "操作执行失败，未自动重试。";
            try {
              const result = await confirmationCoordinator.approveAndDispatch({
                version: 1,
                actionId: action.actionId,
                actionPayloadHash: action.actionPayloadHash,
                nonce: action.nonce,
                decision: action.decision,
                actorOpenId: raw.metadata.senderOpenId,
                chatId: raw.metadata.chatId,
              });
              switch (result.state) {
                case "REJECTED":
                  outcome = "REJECTED";
                  text = "已取消，这项操作不会执行。";
                  break;
                case "SUCCEEDED":
                  outcome = "SUCCEEDED";
                  text =
                    typeof result.remoteId === "string"
                      ? `操作已执行成功。回执：${result.remoteId}`
                      : "操作已执行成功。";
                  break;
                case "FAILED":
                  outcome = "FAILED";
                  text = "操作执行失败，未自动重试。";
                  break;
                case "UNKNOWN":
                  outcome = "UNKNOWN";
                  text =
                    "操作结果暂时无法确认，我没有自动重试，请先在飞书中核对。";
                  break;
                case "NOT_DISPATCHED":
                  outcome = "FAILED";
                  text = "这个确认已经失效或处理过，不会重复执行。";
                  break;
              }
            } catch {
              outcome = "FAILED";
              text = "这个确认已经失效或处理过，不会重复执行。";
            }
            await pending.ready;
            await dependencies.transport.sendText(
              Object.freeze({
                chatId: pending.input.chatId,
                text,
                replyToMessageId: pending.input.messageId,
              }),
            );
            settlePendingAction(pending, outcome);
          })();
          confirmationOperations.set(action.actionId, operation);
          try {
            await operation;
          } finally {
            if (confirmationOperations.get(action.actionId) === operation) {
              confirmationOperations.delete(action.actionId);
            }
          }
        },
      }),
      normalizer: Object.freeze({
        toInboundEvent(raw: RawEnvelope): InboundEvent {
          const prompt = messageText(raw.readText());
          const event: InboundEvent = Object.freeze({
            appId: raw.metadata.appId,
            tenantKey: raw.metadata.tenantKey,
            eventId: raw.eventId,
            messageId: raw.messageId,
            senderOpenId: raw.metadata.senderOpenId,
            chatId: raw.metadata.chatId,
            chatType: "p2p" as const,
            eventType: "im.message.receive_v1" as const,
            receivedAt: raw.receivedAt,
            payloadRef: payloadDigest(prompt),
          });
          staged.set(
            `${event.appId}\u0000${event.tenantKey}\u0000${event.eventId}`,
            Object.freeze({
              version: 1,
              prompt,
              chatId: event.chatId,
              messageId: event.messageId,
              eventId: event.eventId,
              receivedAt: event.receivedAt,
            }),
          );
          return event;
        },
        toCancelActiveTaskRequest(raw: RawEnvelope): CancelActiveTaskRequest {
          return Object.freeze({
            appId: raw.metadata.appId,
            tenantKey: raw.metadata.tenantKey,
            eventId: raw.eventId,
            messageId: raw.messageId,
            senderOpenId: raw.metadata.senderOpenId,
            chatId: raw.metadata.chatId,
            receivedAt: raw.receivedAt,
          });
        },
      }),
      taskSink: Object.freeze({
        async ingest(event: InboundEvent) {
          if (!store) throw new Error("RUNTIME_CLOSED");
          const key = `${event.appId}\u0000${event.tenantKey}\u0000${event.eventId}`;
          const input = staged.get(key);
          if (!input) throw new Error("TASK_INPUT_NOT_STAGED");
          const candidateTaskId = randomUUID();
          const workspacePath = join(config.paths.jobsRoot, candidateTaskId);
          await ensurePrivateDirectory(workspacePath);
          await writePrivateJson(join(workspacePath, "input.json"), input);
          try {
            const accepted = store.ingestEvent(event, workspacePath);
            if (accepted.duplicate) {
              await rm(workspacePath, { recursive: true, force: false });
              const original = store.getTask(accepted.taskId);
              if (original === null) throw new Error("TASK_DUPLICATE_INVALID");
              const originalInput = await readTaskInput(original.workspacePath);
              taskRoutes.set(
                accepted.taskId,
                Object.freeze({
                  chatId: originalInput.chatId,
                  messageId: originalInput.messageId,
                }),
              );
            } else {
              taskRoutes.set(
                accepted.taskId,
                Object.freeze({
                  chatId: input.chatId,
                  messageId: input.messageId,
                }),
              );
            }
            acknowledgementCoordinator?.wake();
            return accepted;
          } finally {
            staged.delete(key);
          }
        },
      }),
      taskControlSink: Object.freeze({
        async cancelActive(request: CancelActiveTaskRequest) {
          if (!store) throw new Error("RUNTIME_CLOSED");
          const result = store.cancelActiveTask(request);
          controlRoutes.set(
            result.controlEventId,
            Object.freeze({
              chatId: request.chatId,
              messageId: request.messageId,
            }),
          );
          const active =
            result.cancelled &&
            result.taskId !== null &&
            activeRun &&
            activeRun.taskId === result.taskId &&
            activeRun.input.chatId === request.chatId &&
            !activeRun.cancelled
              ? activeRun
              : undefined;
          if (active) active.cancelled = true;
          const pendingId =
            result.cancelled && result.taskId !== null
              ? pendingActionByTask.get(result.taskId)
              : undefined;
          const pending = pendingId ? pendingActions.get(pendingId) : undefined;
          if (pending) {
            pending.markReady();
            settlePendingAction(pending, "CANCELLED");
          }
          const cancelledTask =
            result.cancelled && result.taskId !== null
              ? store.getTask(result.taskId)
              : null;
          const marker = cancelledTask
            ? writePrivateJson(
                join(cancelledTask.workspacePath, "cancelled.json"),
                Object.freeze({
                  version: 1,
                  eventId: request.eventId,
                  receivedAt: request.receivedAt,
                }),
              )
            : Promise.resolve();
          if (active) {
            await Promise.all([marker, active.handle.stop()]);
          } else {
            await marker;
          }
          return result;
        },
      }),
      gateway: Object.freeze({
        async sendSystemReply(taskId: string, body: SystemText) {
          const route = taskRoutes.get(taskId);
          if (!route || !store || body.value !== "收到，我开始处理") {
            return Object.freeze({ state: "FAILED" as const });
          }
          acknowledgementCoordinator?.wake();
          return Object.freeze({ state: "SUCCEEDED" as const });
        },
        async sendControlReply(controlEventId: string, body: SystemText) {
          const route = controlRoutes.get(controlEventId);
          if (!route) return Object.freeze({ state: "FAILED" as const });
          try {
            return replyResult(
              await dependencies.transport.sendText(
                Object.freeze({
                  chatId: route.chatId,
                  text: body.value,
                  replyToMessageId: route.messageId,
                }),
              ),
            );
          } catch {
            return Object.freeze({ state: "FAILED" as const });
          }
        },
      }),
      scheduler: Object.freeze({
        wake() {
          acknowledgementCoordinator?.wake();
        },
      }),
    });

    channel = await startChannel({
      appId: config.appId,
      tenantKey,
      runtime: runtimePorts,
      sourceFactory: () => sourceProjection(dependencies.transport),
      cardEvidenceVerifier: Object.freeze({
        async verify(
          input: Parameters<RuntimeTransport["verifyCardAction"]>[0],
        ) {
          return dependencies.transport.verifyCardAction(input);
        },
      }),
      lifecycleSink: Object.freeze({
        record() {},
      }),
    });
    await acknowledgementCoordinator.start();

    heartbeat = setInterval(() => {
      if (closing || !store) return;
      try {
        renewLease();
        const active = activeRun;
        if (active?.sessionId) {
          store.touchTask({
            taskId: active.taskId,
            owner: instanceId,
            codexSessionId: active.sessionId,
            now: now(),
            ttlMs: LEASE_TTL_MS,
            stage: "running",
          });
        }
      } catch (cause) {
        lastError = cause;
      }
    }, LEASE_REFRESH_MS);
    heartbeat.unref();

    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      instanceId,
      async waitForIdle(): Promise<void> {
        await acknowledgementCoordinator?.waitForIdle();
        while (drainPromise) {
          const current = drainPromise;
          await current;
          if (drainPromise === current) break;
        }
        if (lastError) throw lastError;
      },
      getTask(taskId: string): TaskRecord | null {
        return store?.getTask(taskId) ?? null;
      },
      close(): Promise<void> {
        if (closePromise) return closePromise;
        closePromise = (async () => {
          closing = true;
          if (heartbeat) clearInterval(heartbeat);
          if (activeRun) activeRun.cancelled = true;
          for (const pending of [...pendingActions.values()]) {
            pending.markReady();
            settlePendingAction(pending, "CANCELLED");
          }
          await acknowledgementCoordinator?.stop();
          await channel?.disconnect();
          await activeRun?.handle.stop();
          await Promise.allSettled([...confirmationOperations.values()]);
          await drainPromise;
          store?.releaseRuntimeLease("bridge", instanceId);
          store?.close();
          store = undefined;
          await lock.release();
        })();
        return closePromise;
      },
    });
  } catch (cause) {
    if (startupLeaseHeartbeat) clearInterval(startupLeaseHeartbeat);
    if (heartbeat) clearInterval(heartbeat);
    await acknowledgementCoordinator?.stop().catch(() => undefined);
    if (channel) {
      await channel.disconnect().catch(() => undefined);
    } else {
      await dependencies.transport.disconnect().catch(() => undefined);
    }
    store?.releaseRuntimeLease("bridge", instanceId);
    store?.close();
    await lock.release().catch(() => undefined);
    throw cause;
  }
}
