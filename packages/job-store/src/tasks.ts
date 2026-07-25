import { basename } from "node:path";
import { types as utilTypes } from "node:util";

import type Database from "better-sqlite3";

import { assertActionInvalidationReady } from "./actions.js";
import {
  canonicalPersistedTimestamp,
  hasLiveBridgeLease,
  normalizePersistedTimestamp,
  snapshotDate,
  snapshotLeaseWindow,
  type ClockSnapshot,
} from "./leases.js";
import { prepareSecureRuntimeDirectory } from "./secure-path.js";
import {
  RuntimeStateError,
  type FinishTaskInput,
  type MarkRunningInput,
  type RecoverySummary,
  type ReplacementTaskResult,
  type TaskRecord,
  type TouchTaskInput,
} from "./types.js";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TASK_STATES = new Set([
  "RECEIVED",
  "CLAIMED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED_REQUIRES_CONFIRMATION",
]);
const RECOVERY_DISPOSITIONS = new Set([
  "NONE",
  "REQUIRES_CONFIRMATION",
  "RESUME_APPROVED",
  "ABANDONED",
]);

type TaskRow = Readonly<{
  id: unknown;
  inboundEventId: unknown;
  taskKind: unknown;
  resumedFromTaskId: unknown;
  state: unknown;
  recoveryDisposition: unknown;
  codexSessionId: unknown;
  workspacePath: unknown;
  stage: unknown;
  leaseOwner: unknown;
  leaseExpiresAt: unknown;
  lastEventAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}>;

type ActionRow = Readonly<{ id: string; state: string }>;

const TASK_SELECT = `SELECT id,
  inbound_event_id AS inboundEventId,
  task_kind AS taskKind,
  resumed_from_task_id AS resumedFromTaskId,
  state,
  recovery_disposition AS recoveryDisposition,
  codex_session_id AS codexSessionId,
  workspace_path AS workspacePath,
  stage,
  lease_owner AS leaseOwner,
  lease_expires_at AS leaseExpiresAt,
  last_event_at AS lastEventAt,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM tasks`;

function isProxy(value: object): boolean {
  try {
    return utilTypes.isProxy(value);
  } catch {
    return true;
  }
}

function boundedText(value: unknown, maximumLength: number): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    return false;
  }
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f);
  });
}

function safeText(value: unknown): value is string {
  return boundedText(value, 256);
}

function safeStage(value: unknown): value is string {
  return boundedText(value, 128);
}

function nullableSafeText(value: unknown): value is string | null {
  return value === null || safeText(value);
}

function persistedTimestamp(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  return normalizePersistedTimestamp(value, "task_persistence_failed").iso;
}

export function taskRecord(row: TaskRow): TaskRecord {
  if (
    !safeText(row.id) ||
    !safeText(row.inboundEventId) ||
    (row.taskKind !== "ROOT" && row.taskKind !== "RESUME") ||
    !nullableSafeText(row.resumedFromTaskId) ||
    typeof row.state !== "string" ||
    !TASK_STATES.has(row.state) ||
    typeof row.recoveryDisposition !== "string" ||
    !RECOVERY_DISPOSITIONS.has(row.recoveryDisposition) ||
    !nullableSafeText(row.codexSessionId) ||
    !safeText(row.workspacePath) ||
    !safeStage(row.stage) ||
    !nullableSafeText(row.leaseOwner) ||
    (row.leaseExpiresAt !== null && typeof row.leaseExpiresAt !== "string") ||
    (row.lastEventAt !== null && typeof row.lastEventAt !== "string")
  ) {
    throw new RuntimeStateError("task_persistence_failed");
  }
  const record: TaskRecord = {
    id: row.id,
    inboundEventId: row.inboundEventId,
    taskKind: row.taskKind,
    resumedFromTaskId: row.resumedFromTaskId,
    state: row.state as TaskRecord["state"],
    recoveryDisposition:
      row.recoveryDisposition as TaskRecord["recoveryDisposition"],
    codexSessionId: row.codexSessionId,
    workspacePath: row.workspacePath,
    stage: row.stage,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt:
      row.leaseExpiresAt === null
        ? null
        : canonicalPersistedTimestamp(
            row.leaseExpiresAt,
            "task_persistence_failed",
          ).iso,
    lastEventAt: persistedTimestamp(row.lastEventAt, true),
    createdAt: persistedTimestamp(row.createdAt) as string,
    updatedAt: persistedTimestamp(row.updatedAt) as string,
  };
  if ((record.leaseOwner === null) !== (record.leaseExpiresAt === null)) {
    throw new RuntimeStateError("task_persistence_failed");
  }
  return Object.freeze(record);
}

function findTask(
  database: Database.Database,
  taskId: string,
): TaskRecord | null {
  const row = database.prepare(`${TASK_SELECT} WHERE id = ?`).get(taskId) as
    | TaskRow
    | undefined;
  return row === undefined ? null : taskRecord(row);
}

function exactOwnDataSnapshot(
  input: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  try {
    if (
      input === null ||
      typeof input !== "object" ||
      isProxy(input) ||
      Array.isArray(input)
    ) {
      throw new RuntimeStateError(
        "task_lifecycle_input_must_be_own_data_properties",
      );
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new RuntimeStateError(
        "task_lifecycle_input_must_be_own_data_properties",
      );
    }
    const ownKeys = Reflect.ownKeys(input);
    const expected = new Set(keys);
    if (
      ownKeys.length !== keys.length ||
      !ownKeys.every((key) => typeof key === "string" && expected.has(key))
    ) {
      throw new RuntimeStateError(
        "task_lifecycle_input_must_be_own_data_properties",
      );
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        throw new RuntimeStateError(
          "task_lifecycle_input_must_be_own_data_properties",
        );
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof RuntimeStateError) throw error;
    throw new RuntimeStateError(
      "task_lifecycle_input_must_be_own_data_properties",
    );
  }
}

function taskLeaseIsLive(task: TaskRecord, now: ClockSnapshot): boolean {
  if (task.leaseExpiresAt === null) return false;
  return (
    canonicalPersistedTimestamp(task.leaseExpiresAt, "task_persistence_failed")
      .milliseconds >= now.milliseconds
  );
}

function requireOwnLiveBridge(
  database: Database.Database,
  instanceId: string,
  now: ClockSnapshot,
): void {
  if (!hasLiveBridgeLease(database, instanceId, now)) {
    throw new RuntimeStateError("bridge_runtime_lease_is_not_live");
  }
}

function persistenceFailure(error: unknown): never {
  if (error instanceof RuntimeStateError) throw error;
  throw new RuntimeStateError("task_persistence_failed");
}

function summary(
  tasksInterrupted: number,
  actionsFailed: number,
  actionsUnknown: number,
): RecoverySummary {
  return Object.freeze({ tasksInterrupted, actionsFailed, actionsUnknown });
}

function transitionActions(
  database: Database.Database,
  actions: readonly ActionRow[],
  now: ClockSnapshot,
  failureReason: string,
  unknownReason: string,
): Readonly<{ failed: number; unknown: number }> {
  let failed = 0;
  let unknown = 0;
  for (const action of actions) {
    assertActionInvalidationReady(database, action.id, action.state, now);
  }
  for (const action of actions) {
    const toState = action.state === "DISPATCHING" ? "UNKNOWN" : "FAILED";
    const reason =
      action.state === "DISPATCHING" ? unknownReason : failureReason;
    const changed = database
      .prepare(
        `UPDATE actions
            SET state = ?, lease_owner = NULL, lease_expires_at = NULL,
                updated_at = ?
          WHERE id = ? AND version = 1 AND state = ?`,
      )
      .run(toState, now.iso, action.id, action.state).changes;
    if (changed !== 1) throw new RuntimeStateError("task_persistence_failed");
    database
      .prepare(
        `INSERT INTO action_transitions(
           action_id, from_state, to_state, reason_code, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(action.id, action.state, toState, reason, now.iso);
    if (toState === "FAILED") failed += 1;
    else unknown += 1;
  }
  return Object.freeze({ failed, unknown });
}

export function invalidateTaskActions(
  database: Database.Database,
  taskId: string,
  now: ClockSnapshot,
  failureReason: string,
  unknownReason: string,
): Readonly<{ failed: number; unknown: number }> {
  const actions = database
    .prepare(
      `SELECT id, state FROM actions
        WHERE task_id = ?
          AND state IN ('PREPARED','APPROVED','CLAIMED','DISPATCHING')
        ORDER BY id`,
    )
    .all(taskId) as ActionRow[];
  return transitionActions(
    database,
    actions,
    now,
    failureReason,
    unknownReason,
  );
}

function invalidateAllActiveActions(
  database: Database.Database,
  now: ClockSnapshot,
): Readonly<{ failed: number; unknown: number }> {
  const actions = database
    .prepare(
      `SELECT id, state FROM actions
        WHERE state IN ('PREPARED','APPROVED','CLAIMED','DISPATCHING')
        ORDER BY id`,
    )
    .all() as ActionRow[];
  return transitionActions(
    database,
    actions,
    now,
    "restart_invalidated",
    "restart_dispatch_unknown",
  );
}

export function claimNextTask(
  database: Database.Database,
  instanceId: string,
  owner: string,
  nowValue: Date,
  ttlMs: number,
): TaskRecord | null {
  if (!safeText(owner)) throw new RuntimeStateError("task_owner_is_invalid");
  const window = snapshotLeaseWindow(nowValue, ttlMs);
  if (owner !== instanceId) return null;
  try {
    return database
      .transaction(() => {
        if (!hasLiveBridgeLease(database, instanceId, window.now)) return null;
        const activeRows = database
          .prepare(`${TASK_SELECT} WHERE state IN ('CLAIMED','RUNNING')`)
          .all() as TaskRow[];
        for (const row of activeRows) taskRecord(row);
        if (activeRows.length > 0) return null;
        const row = database
          .prepare(`${TASK_SELECT} WHERE state = 'RECEIVED' ORDER BY created_at, id LIMIT 1`)
          .get() as TaskRow | undefined;
        const next = row === undefined ? undefined : taskRecord(row);
        if (next === undefined) return null;
        const acknowledgement = database
          .prepare("SELECT state FROM task_acknowledgements WHERE task_id = ?")
          .get(next.id) as { state: unknown } | undefined;
        if (acknowledgement?.state !== "ACKNOWLEDGED") return null;
        const changed = database
          .prepare(
            `UPDATE tasks
              SET state = 'CLAIMED', lease_owner = ?, lease_expires_at = ?,
                  last_event_at = ?, created_at = ?, updated_at = ?
            WHERE id = ? AND state = 'RECEIVED'`,
          )
          .run(
            owner,
            window.expiresAt.iso,
            window.now.iso,
            next.createdAt,
            window.now.iso,
            next.id,
          ).changes;
        return changed === 1 ? findTask(database, next.id) : null;
      })
      .immediate();
  } catch (error) {
    return persistenceFailure(error);
  }
}

export function getTask(
  database: Database.Database,
  taskId: string,
): TaskRecord | null {
  if (!safeText(taskId)) throw new RuntimeStateError("task_id_is_invalid");
  try {
    return findTask(database, taskId);
  } catch (error) {
    return persistenceFailure(error);
  }
}

export function markRunning(
  database: Database.Database,
  instanceId: string,
  inputValue: MarkRunningInput,
): TaskRecord | null {
  const input = exactOwnDataSnapshot(inputValue, [
    "taskId",
    "owner",
    "codexSessionId",
    "now",
    "ttlMs",
  ]);
  if (
    !safeText(input.taskId) ||
    !safeText(input.owner) ||
    !safeText(input.codexSessionId)
  ) {
    throw new RuntimeStateError("task_lifecycle_input_is_invalid");
  }
  const window = snapshotLeaseWindow(input.now as Date, input.ttlMs as number);
  if (input.owner !== instanceId) return null;
  try {
    return database
      .transaction(() => {
        requireOwnLiveBridge(database, instanceId, window.now);
        const task = findTask(database, input.taskId as string);
        if (
          task === null ||
          task.state !== "CLAIMED" ||
          task.leaseOwner !== input.owner ||
          task.codexSessionId !== null ||
          !taskLeaseIsLive(task, window.now)
        ) {
          return null;
        }
        const changed = database
          .prepare(
            `UPDATE tasks
              SET state = 'RUNNING', codex_session_id = ?, lease_expires_at = ?,
                  last_event_at = ?, updated_at = ?
            WHERE id = ? AND state = 'CLAIMED' AND lease_owner = ?
              AND codex_session_id IS NULL AND lease_expires_at = ?`,
          )
          .run(
            input.codexSessionId,
            window.expiresAt.iso,
            window.now.iso,
            window.now.iso,
            task.id,
            input.owner,
            task.leaseExpiresAt,
          ).changes;
        return changed === 1 ? findTask(database, task.id) : null;
      })
      .immediate();
  } catch (error) {
    return persistenceFailure(error);
  }
}

export function touchTask(
  database: Database.Database,
  instanceId: string,
  inputValue: TouchTaskInput,
): TaskRecord | null {
  const input = exactOwnDataSnapshot(inputValue, [
    "taskId",
    "owner",
    "codexSessionId",
    "now",
    "ttlMs",
    "stage",
  ]);
  if (
    !safeText(input.taskId) ||
    !safeText(input.owner) ||
    !safeText(input.codexSessionId) ||
    !safeStage(input.stage)
  ) {
    throw new RuntimeStateError("task_lifecycle_input_is_invalid");
  }
  const window = snapshotLeaseWindow(input.now as Date, input.ttlMs as number);
  if (input.owner !== instanceId) return null;
  try {
    return database
      .transaction(() => {
        requireOwnLiveBridge(database, instanceId, window.now);
        const task = findTask(database, input.taskId as string);
        if (
          task === null ||
          task.state !== "RUNNING" ||
          task.leaseOwner !== input.owner ||
          task.codexSessionId !== input.codexSessionId ||
          !taskLeaseIsLive(task, window.now)
        ) {
          return null;
        }
        const changed = database
          .prepare(
            `UPDATE tasks
              SET stage = ?, lease_expires_at = ?, last_event_at = ?, updated_at = ?
            WHERE id = ? AND state = 'RUNNING' AND lease_owner = ?
              AND codex_session_id = ? AND lease_expires_at = ?`,
          )
          .run(
            input.stage,
            window.expiresAt.iso,
            window.now.iso,
            window.now.iso,
            task.id,
            input.owner,
            input.codexSessionId,
            task.leaseExpiresAt,
          ).changes;
        return changed === 1 ? findTask(database, task.id) : null;
      })
      .immediate();
  } catch (error) {
    return persistenceFailure(error);
  }
}

export function finishTask(
  database: Database.Database,
  instanceId: string,
  inputValue: FinishTaskInput,
): TaskRecord | null {
  const input = exactOwnDataSnapshot(inputValue, [
    "taskId",
    "owner",
    "codexSessionId",
    "now",
    "outcome",
  ]);
  if (
    !safeText(input.taskId) ||
    !safeText(input.owner) ||
    !safeText(input.codexSessionId) ||
    (input.outcome !== "SUCCEEDED" && input.outcome !== "FAILED")
  ) {
    throw new RuntimeStateError("task_lifecycle_input_is_invalid");
  }
  const now = snapshotDate(input.now as Date);
  if (input.owner !== instanceId) return null;
  try {
    return database
      .transaction(() => {
        requireOwnLiveBridge(database, instanceId, now);
        const task = findTask(database, input.taskId as string);
        if (
          task === null ||
          task.state !== "RUNNING" ||
          task.leaseOwner !== input.owner ||
          task.codexSessionId !== input.codexSessionId ||
          !taskLeaseIsLive(task, now)
        ) {
          return null;
        }
        if (input.outcome === "SUCCEEDED") {
          const unresolved = database
            .prepare(
              `SELECT 1 FROM actions WHERE task_id = ?
              AND state IN ('PREPARED','APPROVED','CLAIMED','DISPATCHING','UNKNOWN')
              LIMIT 1`,
            )
            .get(task.id);
          if (unresolved !== undefined) return null;
        }
        if (input.outcome === "FAILED") {
          invalidateTaskActions(
            database,
            task.id,
            now,
            "task_failed_invalidated",
            "task_failed_dispatch_unknown",
          );
        }
        const changed = database
          .prepare(
            `UPDATE tasks
              SET state = ?, lease_owner = NULL, lease_expires_at = NULL,
                  last_event_at = ?, updated_at = ?
            WHERE id = ? AND state = 'RUNNING' AND lease_owner = ?
              AND codex_session_id = ? AND lease_expires_at = ?`,
          )
          .run(
            input.outcome,
            now.iso,
            now.iso,
            task.id,
            input.owner,
            input.codexSessionId,
            task.leaseExpiresAt,
          ).changes;
        if (changed !== 1) {
          throw new RuntimeStateError("task_persistence_failed");
        }
        return findTask(database, task.id);
      })
      .immediate();
  } catch (error) {
    return persistenceFailure(error);
  }
}

export function interruptExpiredTasks(
  database: Database.Database,
  instanceId: string,
  nowValue: Date,
): RecoverySummary {
  const now = snapshotDate(nowValue);
  try {
    return database
      .transaction(() => {
        requireOwnLiveBridge(database, instanceId, now);
        const active = (
          database
            .prepare(`${TASK_SELECT} WHERE state IN ('CLAIMED','RUNNING')`)
            .all() as TaskRow[]
        ).map(taskRecord);
        let tasksInterrupted = 0;
        let actionsFailed = 0;
        let actionsUnknown = 0;
        for (const task of active) {
          if (task.leaseExpiresAt === null) {
            throw new RuntimeStateError("task_persistence_failed");
          }
          const expiry = canonicalPersistedTimestamp(
            task.leaseExpiresAt,
            "task_persistence_failed",
          );
          if (expiry.milliseconds >= now.milliseconds) continue;
          const changedActions = invalidateTaskActions(
            database,
            task.id,
            now,
            "task_lease_expired_invalidated",
            "task_lease_expired_dispatch_unknown",
          );
          const changed = database
            .prepare(
              `UPDATE tasks
                SET state = 'INTERRUPTED_REQUIRES_CONFIRMATION',
                    recovery_disposition = 'REQUIRES_CONFIRMATION',
                    lease_owner = NULL, lease_expires_at = NULL,
                    last_event_at = ?, updated_at = ?
              WHERE id = ? AND state = ? AND lease_expires_at = ?`,
            )
            .run(
              now.iso,
              now.iso,
              task.id,
              task.state,
              task.leaseExpiresAt,
            ).changes;
          if (changed !== 1)
            throw new RuntimeStateError("task_persistence_failed");
          tasksInterrupted += 1;
          actionsFailed += changedActions.failed;
          actionsUnknown += changedActions.unknown;
        }
        return summary(tasksInterrupted, actionsFailed, actionsUnknown);
      })
      .immediate();
  } catch (error) {
    return persistenceFailure(error);
  }
}

export function recoverOnStartup(
  database: Database.Database,
  instanceId: string,
  nowValue: Date,
): RecoverySummary {
  const now = snapshotDate(nowValue);
  try {
    return database
      .transaction(() => {
        requireOwnLiveBridge(database, instanceId, now);
        const active = (
          database
            .prepare(
              `${TASK_SELECT} WHERE state IN ('CLAIMED','RUNNING')`,
            )
            .all() as TaskRow[]
        ).map(taskRecord);
        const changedActions = invalidateAllActiveActions(database, now);
        for (const task of active) {
          const changed = database
            .prepare(
              `UPDATE tasks
                SET state = 'INTERRUPTED_REQUIRES_CONFIRMATION',
                    recovery_disposition = 'REQUIRES_CONFIRMATION',
                    lease_owner = NULL, lease_expires_at = NULL,
                    last_event_at = ?, updated_at = ?
              WHERE id = ? AND state = ?`,
            )
            .run(now.iso, now.iso, task.id, task.state).changes;
          if (changed !== 1)
            throw new RuntimeStateError("task_persistence_failed");
        }
        return summary(
          active.length,
          changedActions.failed,
          changedActions.unknown,
        );
      })
      .immediate();
  } catch (error) {
    return persistenceFailure(error);
  }
}

function replacementWorkspace(workspacePath: string): Readonly<{
  path: string;
  taskId: string;
}> {
  if (typeof workspacePath !== "string") {
    throw new RuntimeStateError("workspace_path_is_invalid");
  }
  const path = prepareSecureRuntimeDirectory(workspacePath);
  const taskId = basename(path);
  if (!CANONICAL_UUID.test(taskId)) {
    throw new RuntimeStateError("workspace_task_id_is_invalid");
  }
  return Object.freeze({ path, taskId });
}

export function createReplacementTask(
  database: Database.Database,
  interruptedTaskId: string,
  confirmedAtValue: Date,
  workspacePath: string,
): ReplacementTaskResult | null {
  if (!safeText(interruptedTaskId)) {
    throw new RuntimeStateError("task_id_is_invalid");
  }
  const confirmedAt = snapshotDate(confirmedAtValue, "confirmed_at_is_invalid");
  const workspace = replacementWorkspace(workspacePath);
  try {
    return database
      .transaction(() => {
        const interrupted = findTask(database, interruptedTaskId);
        if (
          interrupted === null ||
          interrupted.state !== "INTERRUPTED_REQUIRES_CONFIRMATION" ||
          interrupted.recoveryDisposition === "NONE" ||
          interrupted.recoveryDisposition === "ABANDONED"
        ) {
          return null;
        }
        const replacements = (
          database
            .prepare(`${TASK_SELECT} WHERE resumed_from_task_id = ?`)
            .all(interruptedTaskId) as TaskRow[]
        ).map(taskRecord);
        if (interrupted.recoveryDisposition === "RESUME_APPROVED") {
          const replacement = replacements[0];
          if (
            replacements.length !== 1 ||
            replacement === undefined ||
            replacement.inboundEventId !== interrupted.inboundEventId ||
            replacement.taskKind !== "RESUME" ||
            replacement.resumedFromTaskId !== interrupted.id ||
            !CANONICAL_UUID.test(replacement.id) ||
            basename(replacement.workspacePath) !== replacement.id
          ) {
            throw new RuntimeStateError("replacement_task_ledger_corrupted");
          }
          return Object.freeze({
            task: replacement,
            duplicate: true,
          });
        }
        if (replacements.length !== 0) {
          throw new RuntimeStateError("replacement_task_ledger_corrupted");
        }
        const approved = database
          .prepare(
            `UPDATE tasks SET recovery_disposition = 'RESUME_APPROVED', updated_at = ?
            WHERE id = ? AND state = 'INTERRUPTED_REQUIRES_CONFIRMATION'
              AND recovery_disposition = 'REQUIRES_CONFIRMATION'`,
          )
          .run(confirmedAt.iso, interruptedTaskId).changes;
        if (approved !== 1) return null;
        database
          .prepare(
            `INSERT INTO tasks(
             id, inbound_event_id, task_kind, resumed_from_task_id, state,
             recovery_disposition, workspace_path, stage, last_event_at,
             created_at, updated_at
           ) VALUES (?, ?, 'RESUME', ?, 'RECEIVED', 'NONE', ?, 'accepted', ?, ?, ?)`,
          )
          .run(
            workspace.taskId,
            interrupted.inboundEventId,
            interrupted.id,
            workspace.path,
            confirmedAt.iso,
            confirmedAt.iso,
            confirmedAt.iso,
          );
        database
          .prepare(
            `INSERT INTO task_acknowledgements(
               task_id, state, attempt_count, last_failure_class, created_at, updated_at
             ) VALUES (?, 'NOT_ATTEMPTED', 0, NULL, ?, ?)`,
          )
          .run(workspace.taskId, confirmedAt.iso, confirmedAt.iso);
        const task = findTask(database, workspace.taskId);
        if (task === null)
          throw new RuntimeStateError("task_persistence_failed");
        return Object.freeze({ task, duplicate: false });
      })
      .immediate();
  } catch (error) {
    return persistenceFailure(error);
  }
}
