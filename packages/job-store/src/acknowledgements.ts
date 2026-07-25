import { types as utilTypes } from "node:util";

import type Database from "better-sqlite3";

import {
  hasLiveBridgeLease,
  snapshotDate,
  type ClockSnapshot,
} from "./leases.js";
import { invalidateTaskActions } from "./tasks.js";
import {
  RuntimeStateError,
  type BeginNextTaskAcknowledgementInput,
  type FinishTaskAcknowledgementInput,
  type ReconcileTaskAcknowledgementInput,
  type TaskAcknowledgementFailureClass,
  type TaskAcknowledgementRecord,
  type TaskAcknowledgementRecoveryCandidate,
  type TaskAcknowledgementState,
} from "./types.js";

type AcknowledgementRow = Readonly<{
  taskId: unknown;
  state: unknown;
  attemptCount: unknown;
  lastFailureClass: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}>;

const ACK_SELECT = `SELECT task_id AS taskId, state,
  attempt_count AS attemptCount, last_failure_class AS lastFailureClass,
  created_at AS createdAt, updated_at AS updatedAt
  FROM task_acknowledgements`;
const ACK_STATES = new Set<TaskAcknowledgementState>([
  "NOT_ATTEMPTED",
  "SENDING",
  "RETRYABLE_DNS",
  "ACKNOWLEDGED",
  "AMBIGUOUS",
  "FAILED_DEFINITE",
]);
const FAILURE_CLASSES = new Set<TaskAcknowledgementFailureClass>([
  "DNS_UNAVAILABLE",
  "REMOTE_REJECTED",
  "RESULT_AMBIGUOUS",
  "LOCAL_EVIDENCE_FAILED",
]);

function isProxy(value: object): boolean {
  try {
    return utilTypes.isProxy(value);
  } catch {
    return true;
  }
}

function safeText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    [...value].every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point > 0x1f && (point < 0x7f || point > 0x9f);
    })
  );
}

function ownSnapshot(
  input: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  try {
    if (
      input === null ||
      typeof input !== "object" ||
      isProxy(input) ||
      Array.isArray(input)
    )
      throw new RuntimeStateError(
        "task_acknowledgement_input_must_be_own_data_properties",
      );
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null)
      throw new RuntimeStateError(
        "task_acknowledgement_input_must_be_own_data_properties",
      );
    const ownKeys = Reflect.ownKeys(input);
    const expected = new Set(keys);
    if (
      ownKeys.length !== keys.length ||
      !ownKeys.every((key) => typeof key === "string" && expected.has(key))
    )
      throw new RuntimeStateError(
        "task_acknowledgement_input_must_be_own_data_properties",
      );
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      )
        throw new RuntimeStateError(
          "task_acknowledgement_input_must_be_own_data_properties",
        );
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof RuntimeStateError) throw error;
    throw new RuntimeStateError(
      "task_acknowledgement_input_must_be_own_data_properties",
    );
  }
}

function acknowledgementRecord(
  row: AcknowledgementRow,
): TaskAcknowledgementRecord {
  if (
    !safeText(row.taskId) ||
    typeof row.state !== "string" ||
    !ACK_STATES.has(row.state as TaskAcknowledgementState) ||
    typeof row.attemptCount !== "number" ||
    !Number.isSafeInteger(row.attemptCount) ||
    row.attemptCount < 0 ||
    (row.lastFailureClass !== null &&
      (typeof row.lastFailureClass !== "string" ||
        !FAILURE_CLASSES.has(
          row.lastFailureClass as TaskAcknowledgementFailureClass,
        ))) ||
    !safeText(row.createdAt) ||
    !safeText(row.updatedAt)
  )
    throw new RuntimeStateError("task_acknowledgement_persistence_failed");
  return Object.freeze({
    taskId: row.taskId,
    state: row.state as TaskAcknowledgementState,
    attemptCount: row.attemptCount,
    lastFailureClass:
      row.lastFailureClass as TaskAcknowledgementFailureClass | null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function findAcknowledgement(
  database: Database.Database,
  taskId: string,
): TaskAcknowledgementRecord | null {
  const row = database
    .prepare(`${ACK_SELECT} WHERE task_id = ?`)
    .get(taskId) as AcknowledgementRow | undefined;
  return row === undefined ? null : acknowledgementRecord(row);
}

function requireOwnLease(
  database: Database.Database,
  instanceId: string,
  now: ClockSnapshot,
): void {
  if (!hasLiveBridgeLease(database, instanceId, now))
    throw new RuntimeStateError("bridge_runtime_lease_is_not_live");
}

function persistenceFailure(error: unknown): never {
  if (error instanceof RuntimeStateError) throw error;
  throw new RuntimeStateError("task_acknowledgement_persistence_failed");
}

function earliestReceived(database: Database.Database): Readonly<{
  taskId: string;
  acknowledgement: TaskAcknowledgementRecord | null;
}> | null {
  const task = database
    .prepare(
      `SELECT id FROM tasks WHERE state = 'RECEIVED' ORDER BY created_at, id LIMIT 1`,
    )
    .get() as { id: unknown } | undefined;
  if (task === undefined) return null;
  if (!safeText(task.id))
    throw new RuntimeStateError("task_acknowledgement_persistence_failed");
  return Object.freeze({
    taskId: task.id,
    acknowledgement: findAcknowledgement(database, task.id),
  });
}

function validFinalization(
  state: TaskAcknowledgementState,
  failureClass: TaskAcknowledgementFailureClass | null,
): boolean {
  return (
    (state === "ACKNOWLEDGED" && failureClass === null) ||
    (state === "RETRYABLE_DNS" && failureClass === "DNS_UNAVAILABLE") ||
    (state === "AMBIGUOUS" && failureClass === "RESULT_AMBIGUOUS") ||
    (state === "FAILED_DEFINITE" &&
      (failureClass === "REMOTE_REJECTED" ||
        failureClass === "LOCAL_EVIDENCE_FAILED"))
  );
}

function interruptTask(
  database: Database.Database,
  taskId: string,
  now: ClockSnapshot,
): void {
  invalidateTaskActions(
    database,
    taskId,
    now,
    "task_acknowledgement_invalidated",
    "task_acknowledgement_dispatch_unknown",
  );
  const changed = database
    .prepare(
      `UPDATE tasks SET state = 'INTERRUPTED_REQUIRES_CONFIRMATION', recovery_disposition = 'REQUIRES_CONFIRMATION', lease_owner = NULL, lease_expires_at = NULL, last_event_at = ?, updated_at = ? WHERE id = ? AND state = 'RECEIVED'`,
    )
    .run(now.iso, now.iso, taskId).changes;
  if (changed !== 1)
    throw new RuntimeStateError("task_acknowledgement_persistence_failed");
}

export function getTaskAcknowledgement(
  database: Database.Database,
  taskId: string,
): TaskAcknowledgementRecord | null {
  if (!safeText(taskId)) throw new RuntimeStateError("task_id_is_invalid");
  try {
    return findAcknowledgement(database, taskId);
  } catch (error) {
    return persistenceFailure(error);
  }
}

export function getNextTaskAcknowledgementCandidate(
  database: Database.Database,
): TaskAcknowledgementRecord | null {
  try {
    return earliestReceived(database)?.acknowledgement ?? null;
  } catch (error) {
    return persistenceFailure(error);
  }
}

export function listTaskAcknowledgementRecoveryCandidates(
  database: Database.Database,
): readonly TaskAcknowledgementRecoveryCandidate[] {
  try {
    const rows = database
      .prepare(
        `SELECT id AS taskId, workspace_path AS workspacePath
           FROM tasks
          WHERE state = 'RECEIVED'
          ORDER BY created_at, id`,
      )
      .all() as ReadonlyArray<{
      taskId: unknown;
      workspacePath: unknown;
    }>;
    return Object.freeze(
      rows.map((row) => {
        if (!safeText(row.taskId) || !safeText(row.workspacePath)) {
          throw new RuntimeStateError(
            "task_acknowledgement_persistence_failed",
          );
        }
        return Object.freeze({
          taskId: row.taskId,
          workspacePath: row.workspacePath,
        });
      }),
    );
  } catch (error) {
    return persistenceFailure(error);
  }
}

export function beginNextTaskAcknowledgement(
  database: Database.Database,
  instanceId: string,
  inputValue: BeginNextTaskAcknowledgementInput,
): TaskAcknowledgementRecord | null {
  const input = ownSnapshot(inputValue, ["owner", "now"]);
  if (!safeText(input.owner))
    throw new RuntimeStateError("task_acknowledgement_input_is_invalid");
  const now = snapshotDate(input.now as Date);
  if (input.owner !== instanceId) return null;
  try {
    return database
      .transaction(() => {
        requireOwnLease(database, instanceId, now);
        const next = earliestReceived(database);
        if (
          next === null ||
          next.acknowledgement === null ||
          (next.acknowledgement.state !== "NOT_ATTEMPTED" &&
            next.acknowledgement.state !== "RETRYABLE_DNS")
        )
          return null;
        const changed = database
          .prepare(
            `UPDATE task_acknowledgements SET state = 'SENDING', attempt_count = attempt_count + 1, last_failure_class = NULL, updated_at = ? WHERE task_id = ? AND state = ?`,
          )
          .run(now.iso, next.taskId, next.acknowledgement.state).changes;
        return changed === 1
          ? findAcknowledgement(database, next.taskId)
          : null;
      })
      .immediate();
  } catch (error) {
    return persistenceFailure(error);
  }
}

export function finishTaskAcknowledgement(
  database: Database.Database,
  instanceId: string,
  inputValue: FinishTaskAcknowledgementInput,
): TaskAcknowledgementRecord | null {
  const input = ownSnapshot(inputValue, [
    "taskId",
    "owner",
    "now",
    "state",
    "failureClass",
  ]);
  if (
    !safeText(input.taskId) ||
    !safeText(input.owner) ||
    typeof input.state !== "string" ||
    !ACK_STATES.has(input.state as TaskAcknowledgementState) ||
    !(
      input.failureClass === null ||
      (typeof input.failureClass === "string" &&
        FAILURE_CLASSES.has(
          input.failureClass as TaskAcknowledgementFailureClass,
        ))
    ) ||
    !validFinalization(
      input.state as TaskAcknowledgementState,
      input.failureClass as TaskAcknowledgementFailureClass | null,
    )
  )
    throw new RuntimeStateError("task_acknowledgement_input_is_invalid");
  const now = snapshotDate(input.now as Date);
  if (input.owner !== instanceId) return null;
  try {
    return database
      .transaction(() => {
        requireOwnLease(database, instanceId, now);
        const acknowledgement = findAcknowledgement(
          database,
          input.taskId as string,
        );
        const task = database
          .prepare("SELECT state FROM tasks WHERE id = ?")
          .get(input.taskId) as { state: unknown } | undefined;
        if (
          acknowledgement === null ||
          acknowledgement.state !== "SENDING" ||
          task?.state !== "RECEIVED"
        )
          return null;
        const changed = database
          .prepare(
            "UPDATE task_acknowledgements SET state = ?, last_failure_class = ?, updated_at = ? WHERE task_id = ? AND state = 'SENDING'",
          )
          .run(input.state, input.failureClass, now.iso, input.taskId).changes;
        if (changed !== 1)
          throw new RuntimeStateError(
            "task_acknowledgement_persistence_failed",
          );
        if (input.state === "AMBIGUOUS" || input.state === "FAILED_DEFINITE")
          interruptTask(database, input.taskId as string, now);
        return findAcknowledgement(database, input.taskId as string);
      })
      .immediate();
  } catch (error) {
    return persistenceFailure(error);
  }
}

export function reconcileTaskAcknowledgement(
  database: Database.Database,
  instanceId: string,
  inputValue: ReconcileTaskAcknowledgementInput,
): TaskAcknowledgementRecord | null {
  const input = ownSnapshot(inputValue, [
    "taskId",
    "owner",
    "now",
    "markerPresent",
  ]);
  if (
    !safeText(input.taskId) ||
    !safeText(input.owner) ||
    typeof input.markerPresent !== "boolean"
  )
    throw new RuntimeStateError("task_acknowledgement_input_is_invalid");
  const now = snapshotDate(input.now as Date);
  if (input.owner !== instanceId) return null;
  try {
    return database
      .transaction(() => {
        requireOwnLease(database, instanceId, now);
        const task = database
          .prepare("SELECT state FROM tasks WHERE id = ?")
          .get(input.taskId) as { state: unknown } | undefined;
        if (task === undefined || task.state !== "RECEIVED") return null;
        const acknowledgement = findAcknowledgement(
          database,
          input.taskId as string,
        );
        if (acknowledgement === null && input.markerPresent) {
          database
            .prepare(
              "INSERT INTO task_acknowledgements(task_id, state, attempt_count, last_failure_class, created_at, updated_at) VALUES (?, 'ACKNOWLEDGED', 0, NULL, ?, ?)",
            )
            .run(input.taskId, now.iso, now.iso);
          return findAcknowledgement(database, input.taskId as string);
        }
        if (
          acknowledgement !== null &&
          acknowledgement.state === "SENDING" &&
          input.markerPresent
        ) {
          const changed = database
            .prepare(
              "UPDATE task_acknowledgements SET state = 'ACKNOWLEDGED', last_failure_class = NULL, updated_at = ? WHERE task_id = ? AND state = 'SENDING'",
            )
            .run(now.iso, input.taskId).changes;
          if (changed !== 1)
            throw new RuntimeStateError(
              "task_acknowledgement_persistence_failed",
            );
          return findAcknowledgement(database, input.taskId as string);
        }
        if (
          acknowledgement !== null &&
          !input.markerPresent &&
          (acknowledgement.state === "NOT_ATTEMPTED" ||
            acknowledgement.state === "RETRYABLE_DNS")
        ) {
          return acknowledgement;
        }
        if (
          acknowledgement !== null &&
          input.markerPresent &&
          acknowledgement.state === "ACKNOWLEDGED"
        ) {
          return acknowledgement;
        }
        interruptTask(database, input.taskId as string, now);
        return null;
      })
      .immediate();
  } catch (error) {
    return persistenceFailure(error);
  }
}
