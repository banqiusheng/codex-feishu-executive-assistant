import type { ActionRecord, JobStore } from "@executive-assistant/job-store";

import { snapshotStrictJson, type JsonValue } from "../ipc/framing.js";
import type {
  MvpDispatchAction,
  MvpDispatchCoordinatorStore,
  MvpDispatchStateMachineResult,
  MvpMutationProvider,
} from "./coordinator.js";
import { executeMvpDispatchStateMachine } from "./coordinator.js";

export type MvpDirectCoordinatorStore = MvpDispatchCoordinatorStore &
  Pick<JobStore, "authorizePresidentInstructionAction">;

export type MvpPresidentInstructionInput = Readonly<{
  taskId: string;
  capability: string;
  identity: "bot" | "user";
  itemKey: string;
  payload: Readonly<Record<string, JsonValue>>;
  preview: JsonValue;
}>;

export type MvpDirectExecutionResult =
  | MvpDispatchStateMachineResult
  | Readonly<{
      state: "NOT_DISPATCHED";
      actionId: string;
      reason: "ACTION_ALREADY_CLAIMED" | "ACTION_ALREADY_DISPATCHING";
      retryable: false;
    }>;

export type MvpDirectExecutionCoordinator = Readonly<{
  executePresidentInstruction(
    input: unknown,
  ): Promise<MvpDirectExecutionResult>;
}>;

type JsonObject = Readonly<Record<string, JsonValue>>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

function invalidDirectExecution(): never {
  throw new Error("invalid mvp direct execution");
}

function strictJson(value: unknown): JsonValue {
  try {
    return snapshotStrictJson(value);
  } catch {
    return invalidDirectExecution();
  }
}

function jsonObject(value: unknown): JsonObject {
  const snapshot = strictJson(value);
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    return invalidDirectExecution();
  }
  return snapshot as JsonObject;
}

function exactKeys(value: JsonObject, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key))
  ) {
    invalidDirectExecution();
  }
}

function boundedString(value: JsonValue | undefined, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  ) {
    return invalidDirectExecution();
  }
  return value;
}

function parsePresidentInstruction(
  value: unknown,
): MvpPresidentInstructionInput {
  const input = jsonObject(value);
  exactKeys(input, [
    "taskId",
    "capability",
    "identity",
    "itemKey",
    "payload",
    "preview",
  ]);
  const taskId = boundedString(input.taskId, 128);
  const capability = boundedString(input.capability, 128);
  const itemKey = boundedString(input.itemKey, 256);
  if (
    !UUID_PATTERN.test(taskId) ||
    capability === "system_reply" ||
    (input.identity !== "bot" && input.identity !== "user")
  ) {
    return invalidDirectExecution();
  }
  return Object.freeze({
    taskId,
    capability,
    identity: input.identity,
    itemKey,
    payload: jsonObject(input.payload),
    preview: strictJson(input.preview),
  });
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const object = value as JsonObject;
  return `{${Object.keys(object)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(object[key] as JsonValue)}`,
    )
    .join(",")}}`;
}

function projectDirectAction(
  action: ActionRecord,
  instruction: MvpPresidentInstructionInput,
): MvpDispatchAction {
  if (
    action === null ||
    typeof action !== "object" ||
    !UUID_PATTERN.test(action.actionId) ||
    action.version !== 1 ||
    action.taskId !== instruction.taskId ||
    action.controlEventId !== null ||
    action.capability !== instruction.capability ||
    action.identity !== instruction.identity ||
    action.approvalMode !== "president_instruction" ||
    !SHA256_PATTERN.test(action.payloadHash) ||
    !UUID_PATTERN.test(action.idempotencyKey) ||
    action.idempotencyKey.length > 50
  ) {
    return invalidDirectExecution();
  }
  const payload = jsonObject(action.payload);
  const preview = strictJson(action.preview);
  if (
    canonicalJson(payload) !== canonicalJson(instruction.payload) ||
    canonicalJson(preview) !== canonicalJson(instruction.preview)
  ) {
    return invalidDirectExecution();
  }
  return Object.freeze({
    actionId: action.actionId,
    version: 1,
    capability: action.capability,
    identity: action.identity,
    payload,
    payloadHash: action.payloadHash,
    idempotencyKey: action.idempotencyKey,
  });
}

function terminalResult(
  action: ActionRecord,
): Exclude<MvpDispatchStateMachineResult, { state: "NOT_DISPATCHED" }> {
  if (action.state === "RECONCILED") {
    if (action.reconcileOutcome === "SUCCEEDED") {
      return typeof action.remoteId === "string"
        ? Object.freeze({
            state: "SUCCEEDED",
            actionId: action.actionId,
            remoteId: action.remoteId,
          })
        : Object.freeze({
            state: "SUCCEEDED",
            actionId: action.actionId,
          });
    }
    if (action.reconcileOutcome === "FAILED") {
      return Object.freeze({
        state: "FAILED",
        actionId: action.actionId,
      });
    }
    if (action.reconcileOutcome === "INDETERMINATE") {
      return Object.freeze({
        state: "UNKNOWN",
        actionId: action.actionId,
      });
    }
    return invalidDirectExecution();
  }
  if (
    action.state !== "SUCCEEDED" &&
    action.state !== "FAILED" &&
    action.state !== "UNKNOWN"
  ) {
    return invalidDirectExecution();
  }
  return action.state === "SUCCEEDED" && typeof action.remoteId === "string"
    ? Object.freeze({
        state: action.state,
        actionId: action.actionId,
        remoteId: action.remoteId,
      })
    : Object.freeze({
        state: action.state,
        actionId: action.actionId,
      });
}

function timestamp(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("invalid mvp direct execution clock");
  }
  return new Date(value.getTime());
}

export function createMvpDirectExecutionCoordinator(
  dependencies: Readonly<{
    store: MvpDirectCoordinatorStore;
    provider: MvpMutationProvider;
    owner: string;
    now?: () => Date;
    leaseTtlMs?: number;
  }>,
): MvpDirectExecutionCoordinator {
  if (
    dependencies === null ||
    typeof dependencies !== "object" ||
    dependencies.store === null ||
    typeof dependencies.store !== "object" ||
    typeof dependencies.store.authorizePresidentInstructionAction !==
      "function" ||
    typeof dependencies.store.claimApprovedAction !== "function" ||
    typeof dependencies.store.markDispatching !== "function" ||
    typeof dependencies.store.finishAction !== "function" ||
    dependencies.provider === null ||
    typeof dependencies.provider !== "object" ||
    typeof dependencies.provider.dispatch !== "function" ||
    typeof dependencies.owner !== "string" ||
    dependencies.owner.length < 1 ||
    dependencies.owner.length > 128 ||
    (dependencies.now !== undefined && typeof dependencies.now !== "function")
  ) {
    throw new Error("invalid mvp direct execution dependencies");
  }
  const leaseTtlMs = dependencies.leaseTtlMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0) {
    throw new Error("invalid mvp direct execution lease");
  }
  const authorize = dependencies.store.authorizePresidentInstructionAction.bind(
    dependencies.store,
  );
  const clock = dependencies.now ?? (() => new Date());

  return Object.freeze({
    async executePresidentInstruction(input: unknown) {
      const instruction = parsePresidentInstruction(input);
      const authorization = authorize({
        ...instruction,
        now: timestamp(clock),
      });
      if (
        authorization === null ||
        typeof authorization !== "object" ||
        typeof authorization.created !== "boolean"
      ) {
        return invalidDirectExecution();
      }
      const action = authorization.action;
      projectDirectAction(action, instruction);

      if (
        action.state === "SUCCEEDED" ||
        action.state === "FAILED" ||
        action.state === "UNKNOWN" ||
        action.state === "RECONCILED"
      ) {
        return terminalResult(action);
      }
      if (action.state === "CLAIMED" || action.state === "DISPATCHING") {
        return Object.freeze({
          state: "NOT_DISPATCHED",
          actionId: action.actionId,
          reason:
            action.state === "CLAIMED"
              ? "ACTION_ALREADY_CLAIMED"
              : "ACTION_ALREADY_DISPATCHING",
          retryable: false,
        });
      }
      if (action.state !== "APPROVED") {
        return invalidDirectExecution();
      }

      return executeMvpDispatchStateMachine(
        {
          store: dependencies.store,
          provider: dependencies.provider,
          owner: dependencies.owner,
          clock,
          leaseTtlMs,
          projectAction: (candidate) =>
            projectDirectAction(candidate, instruction),
        },
        action.actionId,
      );
    },
  });
}
