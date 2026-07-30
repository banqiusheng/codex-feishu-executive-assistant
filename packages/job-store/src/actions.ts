import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { types as utilTypes } from "node:util";

import type Database from "better-sqlite3";

import {
  canonicalStrictIJson,
  payloadHash,
  snapshotStrictIJson,
  type StrictIJson,
} from "./canonical-json.js";
import {
  canonicalPersistedTimestamp,
  hasLiveBridgeLease,
  snapshotDate,
  snapshotLeaseWindow,
  type ClockSnapshot,
} from "./leases.js";
import {
  RuntimeStateError,
  type AuthorizedPresidentInstructionAction,
  type AuthorizePresidentInstructionActionInput,
  type ActionApprovalMode,
  type ActionRecord,
  type ActionRef,
  type ActionResult,
  type ActionState,
  type ApprovedAction,
  type ApproveActionInput,
  type AttemptOutcome,
  type ClaimedAction,
  type ClaimApprovedActionInput,
  type DispatchingAction,
  type FinishActionInput,
  type FinishedAction,
  type MarkDispatchingInput,
  type PrepareActionInput,
  type PreparedActionWithNonce,
  type ReconcileActionInput,
  type ReconciledAction,
  type ReconciliationClaim,
  type ReconcileOutcome,
  type StartReconciliationInput,
} from "./types.js";

const APPROVAL_TTL_MS = 30 * 60 * 1_000;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RAW_SHA256 = /^[0-9a-f]{64}$/;
const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/;
const REMOTE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_STATES = new Set<ActionState>([
  "PREPARED",
  "APPROVED",
  "CLAIMED",
  "DISPATCHING",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN",
  "RECONCILED",
]);
const ATTEMPT_OUTCOMES = new Set<AttemptOutcome>([
  "SUCCEEDED",
  "FAILED_DEFINITE",
  "UNKNOWN",
  "INDETERMINATE",
]);
const RECONCILE_OUTCOMES = new Set<ReconcileOutcome>([
  "SUCCEEDED",
  "FAILED",
  "INDETERMINATE",
]);
const INVALIDATABLE_ACTION_STATES = new Set<ActionState>([
  "PREPARED",
  "APPROVED",
  "CLAIMED",
  "DISPATCHING",
]);

type ActionRow = Readonly<{
  id: unknown;
  taskId: unknown;
  controlEventId: unknown;
  version: unknown;
  capability: unknown;
  identity: unknown;
  approvalMode: unknown;
  state: unknown;
  payloadJson: unknown;
  payloadHash: unknown;
  previewJson: unknown;
  actorHash: unknown;
  chatHash: unknown;
  nonceHash: unknown;
  idempotencyKey: unknown;
  expiresAt: unknown;
  leaseOwner: unknown;
  leaseExpiresAt: unknown;
  remoteId: unknown;
  resultJson: unknown;
  reconcileOutcome: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}>;

type SourceIdentityRow = Readonly<{
  sourceId: unknown;
  inboundEventId?: unknown;
  actorHash: unknown;
  chatHash: unknown;
}>;

type ExecutableTaskRow = Readonly<{
  taskId: unknown;
  state: unknown;
  leaseOwner: unknown;
  leaseExpiresAt: unknown;
  codexSessionId: unknown;
}>;

type StartedAttemptRow = Readonly<{
  attemptKind: unknown;
  requestDigest: unknown;
  createdAt: unknown;
}>;

type TransitionAuditRow = Readonly<{
  id: unknown;
  fromState: unknown;
  toState: unknown;
  reasonCode: unknown;
  evidenceDigest: unknown;
  createdAt: unknown;
}>;

type ApprovalAuditRow = Readonly<{
  id: unknown;
  version: unknown;
  actorHash: unknown;
  chatHash: unknown;
  payloadHash: unknown;
  nonceHash: unknown;
  decision: unknown;
  decidedAt: unknown;
}>;

type InstructionAuthorizationAuditRow = Readonly<{
  version: unknown;
  taskId: unknown;
  inboundEventId: unknown;
  capability: unknown;
  payloadHash: unknown;
  itemKey: unknown;
  createdAt: unknown;
}>;

type AttemptAuditRow = Readonly<{
  id: unknown;
  attemptId: unknown;
  phase: unknown;
  attemptKind: unknown;
  outcome: unknown;
  requestDigest: unknown;
  resultDigest: unknown;
  remoteId: unknown;
  createdAt: unknown;
}>;

type ReconciliationAuditRow = Readonly<{
  id: unknown;
  outcome: unknown;
  evidenceDigest: unknown;
  operatorKind: unknown;
  createdAt: unknown;
}>;

type ValidatedTransition = Readonly<{
  fromState: ActionState | null;
  toState: ActionState;
  reasonCode: string;
  evidenceDigest: string | null;
  createdAt: string;
  milliseconds: number;
}>;

type ValidatedAttempt = Readonly<{
  attemptId: string;
  phase: "STARTED" | "FINISHED";
  attemptKind: "DISPATCH" | "RECONCILE" | "SYSTEM_REPLY";
  outcome: AttemptOutcome | null;
  requestDigest: string;
  resultDigest: string | null;
  remoteId: string | null;
  createdAt: string;
  milliseconds: number;
}>;

type InputSnapshot = Readonly<Record<string, unknown>>;

const ACTION_SELECT = `SELECT id,
  task_id AS taskId,
  control_event_id AS controlEventId,
  version,
  capability,
  identity,
  approval_mode AS approvalMode,
  state,
  payload_json AS payloadJson,
  payload_hash AS payloadHash,
  preview_json AS previewJson,
  actor_open_id_hash AS actorHash,
  chat_id_hash AS chatHash,
  nonce_hash AS nonceHash,
  idempotency_key AS idempotencyKey,
  expires_at AS expiresAt,
  lease_owner AS leaseOwner,
  lease_expires_at AS leaseExpiresAt,
  remote_id AS remoteId,
  result_json AS resultJson,
  reconcile_outcome AS reconcileOutcome,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM actions`;

function isProxy(value: object): boolean {
  try {
    return utilTypes.isProxy(value);
  } catch {
    return true;
  }
}

function snapshotExactInput(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  detail: string,
): InputSnapshot {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      isProxy(value)
    ) {
      throw new Error("invalid input object");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("invalid input prototype");
    }
    const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
    const keys = Reflect.ownKeys(value);
    if (
      keys.length < requiredKeys.length ||
      keys.length > allowedKeys.size ||
      !keys.every((key) => typeof key === "string" && allowedKeys.has(key)) ||
      !requiredKeys.every((key) => keys.includes(key))
    ) {
      throw new Error("invalid input keys");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        throw new Error("invalid input descriptor");
      }
      Object.defineProperty(snapshot, key, {
        configurable: false,
        enumerable: true,
        value: descriptor.value,
        writable: false,
      });
    }
    return Object.freeze(snapshot);
  } catch (cause) {
    if (cause instanceof RuntimeStateError) throw cause;
    throw new RuntimeStateError(detail);
  }
}

function safeText(value: unknown, maximumLength = 256): value is string {
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

function canonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

function canonicalRawSha256(value: unknown): value is string {
  return typeof value === "string" && RAW_SHA256.test(value);
}

function canonicalPrefixedSha256(value: unknown): value is string {
  return typeof value === "string" && PREFIXED_SHA256.test(value);
}

function remoteIdentifier(value: unknown): value is string {
  return typeof value === "string" && REMOTE_ID.test(value);
}

function sha256Bytes(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function sha256Hex(value: string): string {
  return sha256Bytes(value).toString("hex");
}

function rawHashBytes(value: string): Buffer {
  return Buffer.from(value, "hex");
}

function prefixedHashBytes(value: string): Buffer {
  return Buffer.from(value.slice("sha256:".length), "hex");
}

function samePrefixedHash(left: string, right: string): boolean {
  return timingSafeEqual(prefixedHashBytes(left), prefixedHashBytes(right));
}

function matchesPlaintextHash(persisted: string, plaintext: string): boolean {
  return timingSafeEqual(rawHashBytes(persisted), sha256Bytes(plaintext));
}

function sameRawHash(left: string, right: string): boolean {
  return timingSafeEqual(rawHashBytes(left), rawHashBytes(right));
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

function parseCanonicalJson(value: unknown): StrictIJson {
  if (typeof value !== "string") {
    throw new RuntimeStateError("action_persistence_failed");
  }
  try {
    const snapshot = snapshotStrictIJson(
      JSON.parse(value) as unknown,
      "action_persistence_failed",
    );
    if (canonicalStrictIJson(snapshot) !== value) {
      throw new RuntimeStateError("action_persistence_failed");
    }
    return snapshot;
  } catch (cause) {
    if (cause instanceof RuntimeStateError) throw cause;
    throw new RuntimeStateError("action_persistence_failed");
  }
}

function parseResult(value: unknown): ActionResult | null {
  if (value === null) return null;
  const parsed = parseCanonicalJson(value);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new RuntimeStateError("action_persistence_failed");
  }
  const resultObject = parsed as Readonly<Record<string, StrictIJson>>;
  const keys = Object.keys(resultObject);
  if (
    (keys.length !== 1 && keys.length !== 2) ||
    !keys.includes("outcome") ||
    !keys.every((key) => key === "outcome" || key === "remoteId")
  ) {
    throw new RuntimeStateError("action_persistence_failed");
  }
  const outcome = resultObject.outcome;
  if (
    typeof outcome !== "string" ||
    !ATTEMPT_OUTCOMES.has(outcome as AttemptOutcome)
  ) {
    throw new RuntimeStateError("action_persistence_failed");
  }
  const remoteId = resultObject.remoteId;
  if (
    remoteId !== undefined &&
    (!remoteIdentifier(remoteId) || outcome !== "SUCCEEDED")
  ) {
    throw new RuntimeStateError("action_persistence_failed");
  }
  return Object.freeze({
    outcome: outcome as AttemptOutcome,
    ...(typeof remoteId === "string" ? { remoteId } : {}),
  });
}

function validatePersistedSourceBinding(
  database: Database.Database,
  taskId: string | null,
  controlEventId: string | null,
  actorHash: string,
  chatHash: string,
): void {
  const row =
    taskId !== null
      ? (database
          .prepare(
            `SELECT tasks.id AS sourceId,
                    inbound_events.sender_open_id_hash AS actorHash,
                    inbound_events.chat_id_hash AS chatHash
               FROM tasks
               JOIN inbound_events
                 ON inbound_events.id = tasks.inbound_event_id
              WHERE tasks.id = ?`,
          )
          .get(taskId) as SourceIdentityRow | undefined)
      : (database
          .prepare(
            `SELECT id AS sourceId, actor_open_id_hash AS actorHash,
                    chat_id_hash AS chatHash
               FROM control_events WHERE id = ?`,
          )
          .get(controlEventId) as SourceIdentityRow | undefined);
  const expectedSourceId = taskId ?? controlEventId;
  if (
    row === undefined ||
    row.sourceId !== expectedSourceId ||
    !canonicalRawSha256(row.actorHash) ||
    !canonicalRawSha256(row.chatHash) ||
    !sameRawHash(row.actorHash, actorHash) ||
    !sameRawHash(row.chatHash, chatHash)
  ) {
    throw new RuntimeStateError("action_persistence_failed");
  }
}

function validateTaskActionLeaseBinding(
  database: Database.Database,
  taskId: string | null,
  approvalMode: ActionApprovalMode,
  state: ActionState,
  leaseOwner: string | null,
): void {
  if (
    taskId === null ||
    approvalMode === "system_policy" ||
    (state !== "CLAIMED" && state !== "DISPATCHING")
  ) {
    return;
  }
  const row = database
    .prepare(
      `SELECT id AS taskId, state, lease_owner AS leaseOwner,
              lease_expires_at AS leaseExpiresAt,
              codex_session_id AS codexSessionId
         FROM tasks WHERE id = ?`,
    )
    .get(taskId) as ExecutableTaskRow | undefined;
  if (
    row === undefined ||
    row.taskId !== taskId ||
    row.state !== "RUNNING" ||
    row.leaseOwner !== leaseOwner ||
    !safeText(row.codexSessionId, 256) ||
    typeof row.leaseExpiresAt !== "string"
  ) {
    throw new RuntimeStateError("action_persistence_failed");
  }
  canonicalPersistedTimestamp(row.leaseExpiresAt, "action_persistence_failed");
}

function actionRecord(
  database: Database.Database,
  row: ActionRow,
): ActionRecord {
  if (
    !canonicalUuid(row.id) ||
    row.version !== 1 ||
    !safeText(row.capability, 128) ||
    (row.identity !== "bot" && row.identity !== "user") ||
    (row.approvalMode !== "president" &&
      row.approvalMode !== "president_instruction" &&
      row.approvalMode !== "system_policy") ||
    typeof row.state !== "string" ||
    !ACTION_STATES.has(row.state as ActionState) ||
    !canonicalRawSha256(row.actorHash) ||
    !canonicalRawSha256(row.chatHash) ||
    !canonicalRawSha256(row.nonceHash) ||
    !canonicalPrefixedSha256(row.payloadHash) ||
    row.idempotencyKey !== row.id ||
    (row.leaseOwner !== null && !safeText(row.leaseOwner, 128)) ||
    (row.remoteId !== null && !remoteIdentifier(row.remoteId)) ||
    (row.reconcileOutcome !== null &&
      (typeof row.reconcileOutcome !== "string" ||
        !RECONCILE_OUTCOMES.has(row.reconcileOutcome as ReconcileOutcome)))
  ) {
    throw new RuntimeStateError("action_persistence_failed");
  }
  const taskId = row.taskId === null ? null : row.taskId;
  const controlEventId =
    row.controlEventId === null ? null : row.controlEventId;
  if (
    (taskId !== null && !canonicalUuid(taskId)) ||
    (controlEventId !== null && !canonicalUuid(controlEventId)) ||
    (taskId === null) === (controlEventId === null)
  ) {
    throw new RuntimeStateError("action_persistence_failed");
  }
  if (
    (row.capability === "system_reply" &&
      (row.approvalMode !== "system_policy" || row.identity !== "bot")) ||
    (row.capability !== "system_reply" &&
      row.approvalMode !== "president" &&
      row.approvalMode !== "president_instruction") ||
    (row.approvalMode === "president_instruction" && taskId === null) ||
    (controlEventId !== null && row.capability !== "system_reply")
  ) {
    throw new RuntimeStateError("action_persistence_failed");
  }
  const expiresAt = canonicalPersistedTimestamp(
    row.expiresAt,
    "action_persistence_failed",
  );
  const createdAt = canonicalPersistedTimestamp(
    row.createdAt,
    "action_persistence_failed",
  );
  const updatedAt = canonicalPersistedTimestamp(
    row.updatedAt,
    "action_persistence_failed",
  );
  if (
    updatedAt.milliseconds < createdAt.milliseconds ||
    ((row.approvalMode === "president" ||
      row.approvalMode === "president_instruction") &&
      expiresAt.milliseconds - createdAt.milliseconds !== APPROVAL_TTL_MS) ||
    (row.approvalMode === "system_policy" &&
      expiresAt.milliseconds < createdAt.milliseconds)
  ) {
    throw new RuntimeStateError("action_persistence_failed");
  }
  let leaseExpiresAt: string | null = null;
  if ((row.leaseOwner === null) !== (row.leaseExpiresAt === null)) {
    throw new RuntimeStateError("action_persistence_failed");
  }
  if (row.leaseExpiresAt !== null) {
    const leaseExpiry = canonicalPersistedTimestamp(
      row.leaseExpiresAt,
      "action_persistence_failed",
    );
    if (leaseExpiry.milliseconds < updatedAt.milliseconds) {
      throw new RuntimeStateError("action_persistence_failed");
    }
    leaseExpiresAt = leaseExpiry.iso;
  }
  const payload = parseCanonicalJson(row.payloadJson);
  const preview = parseCanonicalJson(row.previewJson);
  const calculatedPayloadHash = payloadHash(payload);
  if (!samePrefixedHash(row.payloadHash, calculatedPayloadHash)) {
    throw new RuntimeStateError("action_persistence_failed");
  }
  const result = parseResult(row.resultJson);
  const state = row.state as ActionState;
  const hasLease = row.leaseOwner !== null;
  const leaseRequired = state === "CLAIMED" || state === "DISPATCHING";
  const leaseForbidden =
    state === "PREPARED" ||
    state === "APPROVED" ||
    state === "SUCCEEDED" ||
    state === "FAILED" ||
    state === "RECONCILED";
  const expectedReconciledOutcome =
    row.reconcileOutcome === "SUCCEEDED"
      ? "SUCCEEDED"
      : row.reconcileOutcome === "FAILED"
        ? "FAILED_DEFINITE"
        : row.reconcileOutcome === "INDETERMINATE"
          ? "INDETERMINATE"
          : null;
  const resultMatchesState =
    ((state === "PREPARED" ||
      state === "APPROVED" ||
      state === "CLAIMED" ||
      state === "DISPATCHING") &&
      result === null) ||
    (state === "SUCCEEDED" && result?.outcome === "SUCCEEDED") ||
    (state === "FAILED" &&
      (result === null || result.outcome === "FAILED_DEFINITE")) ||
    (state === "UNKNOWN" &&
      (result === null || result.outcome === "UNKNOWN")) ||
    (state === "RECONCILED" &&
      expectedReconciledOutcome !== null &&
      result?.outcome === expectedReconciledOutcome);
  if (
    (result?.remoteId ?? null) !== row.remoteId ||
    (row.state === "RECONCILED") !== (row.reconcileOutcome !== null) ||
    (row.reconcileOutcome !== null && result === null) ||
    (leaseRequired && !hasLease) ||
    (leaseForbidden && hasLease) ||
    !resultMatchesState ||
    ((state === "PREPARED" ||
      state === "APPROVED" ||
      state === "CLAIMED" ||
      state === "DISPATCHING" ||
      state === "FAILED" ||
      state === "UNKNOWN") &&
      row.reconcileOutcome !== null) ||
    ((state === "PREPARED" ||
      state === "APPROVED" ||
      state === "CLAIMED" ||
      state === "DISPATCHING" ||
      state === "FAILED" ||
      state === "UNKNOWN") &&
      row.remoteId !== null)
  ) {
    throw new RuntimeStateError("action_persistence_failed");
  }
  validatePersistedSourceBinding(
    database,
    taskId,
    controlEventId,
    row.actorHash,
    row.chatHash,
  );
  validateTaskActionLeaseBinding(
    database,
    taskId,
    row.approvalMode,
    state,
    row.leaseOwner,
  );
  const record = Object.freeze({
    actionId: row.id,
    version: 1,
    taskId,
    controlEventId,
    capability: row.capability,
    identity: row.identity,
    approvalMode: row.approvalMode,
    state,
    payload,
    payloadHash: row.payloadHash,
    preview,
    expiresAt: expiresAt.iso,
    idempotencyKey: row.idempotencyKey,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt,
    remoteId: row.remoteId,
    result,
    reconcileOutcome:
      row.reconcileOutcome === null
        ? null
        : (row.reconcileOutcome as ReconcileOutcome),
    createdAt: createdAt.iso,
    updatedAt: updatedAt.iso,
  });
  validateActionAuditLedger(database, record, row);
  return record;
}

function findAction(
  database: Database.Database,
  actionId: string,
  version: 1,
): ActionRecord | null {
  const row = database
    .prepare(`${ACTION_SELECT} WHERE id = ? AND version = ?`)
    .get(actionId, version) as ActionRow | undefined;
  return row === undefined ? null : actionRecord(database, row);
}

export function taskHasExternalEffectsPending(
  database: Database.Database,
  taskId: string,
): boolean {
  const rows = database
    .prepare(
      `${ACTION_SELECT} WHERE task_id = ?
         AND state IN ('UNKNOWN','DISPATCHING') ORDER BY id`,
    )
    .all(taskId) as ActionRow[];
  for (const row of rows) actionRecord(database, row);
  return rows.length !== 0;
}

function actionTimeAllows(action: ActionRecord, now: ClockSnapshot): boolean {
  return (
    canonicalPersistedTimestamp(action.updatedAt, "action_persistence_failed")
      .milliseconds <= now.milliseconds
  );
}

function auditFailure(): never {
  throw new RuntimeStateError("action_persistence_failed");
}

function auditTimestamp(
  value: unknown,
  minimum: number,
  maximum: number,
): ClockSnapshot {
  const timestamp = canonicalPersistedTimestamp(
    value,
    "action_persistence_failed",
  );
  if (timestamp.milliseconds < minimum || timestamp.milliseconds > maximum) {
    return auditFailure();
  }
  return timestamp;
}

function legalAuditTransition(
  fromState: ActionState,
  toState: ActionState,
): boolean {
  return (
    (fromState === "PREPARED" &&
      (toState === "APPROVED" || toState === "FAILED")) ||
    (fromState === "APPROVED" &&
      (toState === "CLAIMED" || toState === "FAILED")) ||
    (fromState === "CLAIMED" &&
      (toState === "DISPATCHING" || toState === "FAILED")) ||
    (fromState === "DISPATCHING" &&
      (toState === "SUCCEEDED" ||
        toState === "FAILED" ||
        toState === "UNKNOWN")) ||
    (fromState === "UNKNOWN" && toState === "RECONCILED")
  );
}

function validAuditReason(
  approvalMode: ActionApprovalMode,
  fromState: ActionState | null,
  toState: ActionState,
  reasonCode: string,
): boolean {
  if (fromState === null) {
    if (approvalMode === "system_policy") {
      return toState === "APPROVED" && reasonCode === "system_policy_approved";
    }
    if (approvalMode === "president_instruction") {
      return (
        toState === "APPROVED" &&
        reasonCode === "president_instruction_approved"
      );
    }
    return toState === "PREPARED" && reasonCode === "prepared";
  }
  if (fromState === "PREPARED" && toState === "APPROVED") {
    return reasonCode === "approved";
  }
  if (fromState === "APPROVED" && toState === "CLAIMED") {
    return reasonCode === "claimed";
  }
  if (fromState === "CLAIMED" && toState === "DISPATCHING") {
    return reasonCode === "dispatch_started";
  }
  if (fromState === "UNKNOWN" && toState === "RECONCILED") {
    return reasonCode === "reconciled";
  }
  if (fromState === "DISPATCHING") {
    if (toState === "SUCCEEDED" || toState === "FAILED") {
      return reasonCode === "dispatch_finished";
    }
    return (
      toState === "UNKNOWN" &&
      (reasonCode === "dispatch_finished" ||
        reasonCode === "restart_dispatch_unknown" ||
        reasonCode === "user_cancelled_dispatch_unknown" ||
        reasonCode === "task_lease_expired_dispatch_unknown" ||
        reasonCode === "task_failed_dispatch_unknown")
    );
  }
  if (toState !== "FAILED") return false;
  if (fromState === "PREPARED") {
    return (
      reasonCode === "rejected" ||
      reasonCode === "approval_expired" ||
      reasonCode === "superseded_by_new_preview" ||
      reasonCode === "restart_invalidated" ||
      reasonCode === "user_cancelled" ||
      reasonCode === "task_lease_expired_invalidated" ||
      reasonCode === "task_failed_invalidated"
    );
  }
  if (fromState === "APPROVED") {
    return (
      reasonCode === "approval_expired_before_claim" ||
      reasonCode === "superseded_by_new_preview" ||
      reasonCode === "restart_invalidated" ||
      reasonCode === "user_cancelled" ||
      reasonCode === "task_lease_expired_invalidated" ||
      reasonCode === "task_failed_invalidated"
    );
  }
  return (
    fromState === "CLAIMED" &&
    (reasonCode === "restart_invalidated" ||
      reasonCode === "user_cancelled" ||
      reasonCode === "task_lease_expired_invalidated" ||
      reasonCode === "task_failed_invalidated")
  );
}

function validateTransitionLedger(
  database: Database.Database,
  action: ActionRecord,
): readonly ValidatedTransition[] {
  const created = canonicalPersistedTimestamp(
    action.createdAt,
    "action_persistence_failed",
  );
  const updated = canonicalPersistedTimestamp(
    action.updatedAt,
    "action_persistence_failed",
  );
  const rows = database
    .prepare(
      `SELECT id, from_state AS fromState, to_state AS toState,
              reason_code AS reasonCode, evidence_digest AS evidenceDigest,
              created_at AS createdAt
         FROM action_transitions WHERE action_id = ? ORDER BY id`,
    )
    .all(action.actionId) as TransitionAuditRow[];
  if (rows.length === 0) return auditFailure();
  const transitions: ValidatedTransition[] = [];
  let currentState: ActionState | null = null;
  let previousTime = created.milliseconds;
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.id) ||
      (row.id as number) <= 0 ||
      (row.fromState !== null &&
        (typeof row.fromState !== "string" ||
          !ACTION_STATES.has(row.fromState as ActionState))) ||
      typeof row.toState !== "string" ||
      !ACTION_STATES.has(row.toState as ActionState) ||
      !safeText(row.reasonCode, 128) ||
      (row.evidenceDigest !== null &&
        !canonicalPrefixedSha256(row.evidenceDigest))
    ) {
      return auditFailure();
    }
    const fromState =
      row.fromState === null ? null : (row.fromState as ActionState);
    const toState = row.toState as ActionState;
    if (
      fromState !== currentState ||
      !validAuditReason(action.approvalMode, fromState, toState, row.reasonCode)
    ) {
      return auditFailure();
    }
    if (currentState === null) {
      const expectedInitial =
        action.approvalMode === "president" ? "PREPARED" : "APPROVED";
      if (toState !== expectedInitial) return auditFailure();
    } else if (!legalAuditTransition(currentState, toState)) {
      return auditFailure();
    }
    if ((toState === "RECONCILED") !== (row.evidenceDigest !== null)) {
      return auditFailure();
    }
    const timestamp = auditTimestamp(
      row.createdAt,
      created.milliseconds,
      updated.milliseconds,
    );
    if (
      timestamp.milliseconds < previousTime ||
      (transitions.length === 0 && timestamp.iso !== created.iso)
    ) {
      return auditFailure();
    }
    previousTime = timestamp.milliseconds;
    transitions.push(
      Object.freeze({
        fromState,
        toState,
        reasonCode: row.reasonCode,
        evidenceDigest: row.evidenceDigest,
        createdAt: timestamp.iso,
        milliseconds: timestamp.milliseconds,
      }),
    );
    currentState = toState;
  }
  const last = transitions.at(-1);
  if (
    last === undefined ||
    currentState !== action.state ||
    (action.state === "UNKNOWN" && action.leaseOwner !== null
      ? last.milliseconds > updated.milliseconds
      : last.milliseconds !== updated.milliseconds)
  ) {
    return auditFailure();
  }
  return Object.freeze(transitions);
}

function approvalDecisionForReason(
  reasonCode: string,
): "APPROVED" | "REJECTED" | "EXPIRED" | "INVALIDATED" | null {
  if (reasonCode === "approved") return "APPROVED";
  if (reasonCode === "rejected") return "REJECTED";
  if (reasonCode === "approval_expired") return "EXPIRED";
  if (reasonCode === "superseded_by_new_preview") return "INVALIDATED";
  return null;
}

function incrementCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function validateApprovalLedger(
  database: Database.Database,
  action: ActionRecord,
  actionRow: ActionRow,
  transitions: readonly ValidatedTransition[],
): void {
  const created = canonicalPersistedTimestamp(
    action.createdAt,
    "action_persistence_failed",
  );
  const updated = canonicalPersistedTimestamp(
    action.updatedAt,
    "action_persistence_failed",
  );
  const rows = database
    .prepare(
      `SELECT id, action_version AS version,
              actor_open_id_hash AS actorHash, chat_id_hash AS chatHash,
              payload_hash AS payloadHash, nonce_hash AS nonceHash,
              decision, decided_at AS decidedAt
         FROM approvals WHERE action_id = ? ORDER BY decided_at, id`,
    )
    .all(action.actionId) as ApprovalAuditRow[];
  if (
    !canonicalRawSha256(actionRow.actorHash) ||
    !canonicalRawSha256(actionRow.chatHash) ||
    !canonicalRawSha256(actionRow.nonceHash)
  ) {
    return auditFailure();
  }
  const actual = new Map<string, number>();
  for (const row of rows) {
    if (
      !canonicalUuid(row.id) ||
      row.version !== 1 ||
      !canonicalRawSha256(row.actorHash) ||
      !canonicalRawSha256(row.chatHash) ||
      !canonicalPrefixedSha256(row.payloadHash) ||
      !canonicalRawSha256(row.nonceHash) ||
      (row.decision !== "APPROVED" &&
        row.decision !== "REJECTED" &&
        row.decision !== "EXPIRED" &&
        row.decision !== "INVALIDATED") ||
      !sameRawHash(row.actorHash, actionRow.actorHash) ||
      !sameRawHash(row.chatHash, actionRow.chatHash) ||
      !sameRawHash(row.nonceHash, actionRow.nonceHash) ||
      !samePrefixedHash(row.payloadHash, action.payloadHash)
    ) {
      return auditFailure();
    }
    const timestamp = auditTimestamp(
      row.decidedAt,
      created.milliseconds,
      updated.milliseconds,
    );
    incrementCount(actual, `${row.decision}:${timestamp.iso}`);
  }
  const expected = new Map<string, number>();
  if (action.approvalMode === "president") {
    for (const transition of transitions) {
      const decision = approvalDecisionForReason(transition.reasonCode);
      if (decision !== null) {
        incrementCount(expected, `${decision}:${transition.createdAt}`);
      }
    }
  }
  if (
    actual.size !== expected.size ||
    [...actual].some(([key, count]) => expected.get(key) !== count)
  ) {
    return auditFailure();
  }
}

function validateInstructionAuthorizationLedger(
  database: Database.Database,
  action: ActionRecord,
): void {
  const rows = database
    .prepare(
      `SELECT action_version AS version, task_id AS taskId,
              inbound_event_id AS inboundEventId, capability,
              payload_hash AS payloadHash, item_key AS itemKey,
              created_at AS createdAt
         FROM instruction_authorizations
        WHERE action_id = ? ORDER BY action_version`,
    )
    .all(action.actionId) as InstructionAuthorizationAuditRow[];
  if (action.approvalMode !== "president_instruction") {
    if (rows.length !== 0) return auditFailure();
    return;
  }
  if (action.taskId === null || rows.length !== 1) return auditFailure();
  const row = rows[0];
  if (
    row === undefined ||
    row.version !== action.version ||
    row.taskId !== action.taskId ||
    !canonicalUuid(row.inboundEventId) ||
    row.capability !== action.capability ||
    !canonicalPrefixedSha256(row.payloadHash) ||
    !samePrefixedHash(row.payloadHash, action.payloadHash) ||
    !safeText(row.itemKey, 256)
  ) {
    return auditFailure();
  }
  const source = sourceIdentity(database, action.taskId);
  if (row.inboundEventId !== source.inboundEventId) return auditFailure();
  const createdAt = auditTimestamp(
    row.createdAt,
    canonicalPersistedTimestamp(action.createdAt, "action_persistence_failed")
      .milliseconds,
    canonicalPersistedTimestamp(action.updatedAt, "action_persistence_failed")
      .milliseconds,
  );
  if (createdAt.iso !== action.createdAt) return auditFailure();
}

function validateAttemptRow(
  row: AttemptAuditRow,
  minimum: number,
  maximum: number,
  expectedDispatchKind: "DISPATCH" | "SYSTEM_REPLY",
): ValidatedAttempt {
  if (
    !canonicalUuid(row.id) ||
    !canonicalUuid(row.attemptId) ||
    (row.phase !== "STARTED" && row.phase !== "FINISHED") ||
    (row.attemptKind !== "DISPATCH" &&
      row.attemptKind !== "RECONCILE" &&
      row.attemptKind !== "SYSTEM_REPLY") ||
    (row.attemptKind !== "RECONCILE" &&
      row.attemptKind !== expectedDispatchKind) ||
    !canonicalPrefixedSha256(row.requestDigest) ||
    (row.outcome !== null &&
      (typeof row.outcome !== "string" ||
        !ATTEMPT_OUTCOMES.has(row.outcome as AttemptOutcome))) ||
    (row.resultDigest !== null && !canonicalPrefixedSha256(row.resultDigest)) ||
    (row.remoteId !== null && !remoteIdentifier(row.remoteId))
  ) {
    return auditFailure();
  }
  if (
    (row.phase === "STARTED" &&
      (row.outcome !== null ||
        row.resultDigest !== null ||
        row.remoteId !== null)) ||
    (row.phase === "FINISHED" &&
      (row.outcome === null || row.resultDigest === null)) ||
    (row.remoteId !== null && row.outcome !== "SUCCEEDED")
  ) {
    return auditFailure();
  }
  const timestamp = auditTimestamp(row.createdAt, minimum, maximum);
  return Object.freeze({
    attemptId: row.attemptId,
    phase: row.phase,
    attemptKind: row.attemptKind,
    outcome: row.outcome === null ? null : (row.outcome as AttemptOutcome),
    requestDigest: row.requestDigest,
    resultDigest: row.resultDigest,
    remoteId: row.remoteId,
    createdAt: timestamp.iso,
    milliseconds: timestamp.milliseconds,
  });
}

type AttemptPair = {
  started: ValidatedAttempt | null;
  finished: ValidatedAttempt | null;
};

function expectedResultDigest(
  outcome: AttemptOutcome,
  remoteId: string | null,
): string {
  return payloadHash(
    snapshotStrictIJson(
      {
        outcome,
        ...(remoteId === null ? {} : { remoteId }),
      },
      "action_persistence_failed",
    ),
  );
}

function validateAttemptLedger(
  database: Database.Database,
  action: ActionRecord,
  transitions: readonly ValidatedTransition[],
): void {
  const created = canonicalPersistedTimestamp(
    action.createdAt,
    "action_persistence_failed",
  );
  const updated = canonicalPersistedTimestamp(
    action.updatedAt,
    "action_persistence_failed",
  );
  const expectedDispatchKind = attemptKindFor(action);
  const rows = database
    .prepare(
      `SELECT id, attempt_id AS attemptId, phase,
              attempt_kind AS attemptKind, outcome,
              request_digest AS requestDigest,
              result_digest AS resultDigest, remote_id AS remoteId,
              created_at AS createdAt
         FROM action_attempts WHERE action_id = ? ORDER BY created_at, id`,
    )
    .all(action.actionId) as AttemptAuditRow[];
  const pairs = new Map<string, AttemptPair>();
  for (const row of rows) {
    const attempt = validateAttemptRow(
      row,
      created.milliseconds,
      updated.milliseconds,
      expectedDispatchKind,
    );
    const pair = pairs.get(attempt.attemptId) ?? {
      started: null,
      finished: null,
    };
    if (attempt.phase === "STARTED") {
      if (pair.started !== null) return auditFailure();
      pair.started = attempt;
    } else {
      if (pair.finished !== null) return auditFailure();
      pair.finished = attempt;
    }
    pairs.set(attempt.attemptId, pair);
  }
  for (const pair of pairs.values()) {
    if (pair.started === null) return auditFailure();
    if (
      pair.finished !== null &&
      (pair.finished.attemptKind !== pair.started.attemptKind ||
        !samePrefixedHash(
          pair.finished.requestDigest,
          pair.started.requestDigest,
        ) ||
        pair.finished.milliseconds < pair.started.milliseconds)
    ) {
      return auditFailure();
    }
  }

  const dispatchPairs = [...pairs.values()].filter(
    (pair) => pair.started?.attemptKind === expectedDispatchKind,
  );
  const dispatchStarted = transitions.find(
    (transition) =>
      transition.fromState === "CLAIMED" &&
      transition.toState === "DISPATCHING",
  );
  const dispatchFinished = transitions.find(
    (transition) => transition.fromState === "DISPATCHING",
  );
  if (dispatchStarted === undefined) {
    if (
      dispatchPairs.length !== 0 ||
      (action.state === "FAILED" && action.result !== null)
    ) {
      return auditFailure();
    }
  } else {
    if (dispatchPairs.length !== 1) return auditFailure();
    const pair = dispatchPairs[0];
    if (
      pair?.started === null ||
      pair?.started === undefined ||
      pair.started.createdAt !== dispatchStarted.createdAt
    ) {
      return auditFailure();
    }
    if (dispatchFinished === undefined) {
      if (action.state !== "DISPATCHING" || pair.finished !== null) {
        return auditFailure();
      }
    } else if (dispatchFinished.reasonCode === "dispatch_finished") {
      const expectedOutcome: AttemptOutcome =
        dispatchFinished.toState === "SUCCEEDED"
          ? "SUCCEEDED"
          : dispatchFinished.toState === "FAILED"
            ? "FAILED_DEFINITE"
            : "UNKNOWN";
      const expectedRemoteId =
        dispatchFinished.toState === "SUCCEEDED" ? action.remoteId : null;
      if (
        pair.finished === null ||
        pair.finished.createdAt !== dispatchFinished.createdAt ||
        pair.finished.outcome !== expectedOutcome ||
        pair.finished.remoteId !== expectedRemoteId ||
        pair.finished.resultDigest === null ||
        (action.state !== "RECONCILED" &&
          (action.result?.outcome !== expectedOutcome ||
            (action.result?.remoteId ?? null) !== expectedRemoteId)) ||
        !samePrefixedHash(
          pair.finished.resultDigest,
          expectedResultDigest(expectedOutcome, expectedRemoteId),
        )
      ) {
        return auditFailure();
      }
    } else if (
      dispatchFinished.toState !== "UNKNOWN" ||
      pair.finished !== null ||
      (action.state === "UNKNOWN" && action.result !== null)
    ) {
      return auditFailure();
    }
  }

  const reconcilePairs = [...pairs.values()].filter(
    (pair) => pair.started?.attemptKind === "RECONCILE",
  );
  if (action.state === "UNKNOWN") {
    if (action.leaseOwner === null) {
      if (reconcilePairs.length !== 0) return auditFailure();
    } else {
      const current = reconcilePairs.filter(
        (pair) =>
          pair.started?.createdAt === action.updatedAt &&
          pair.finished === null,
      );
      if (
        current.length !== 1 ||
        reconcilePairs.some((pair) => pair.finished !== null)
      ) {
        return auditFailure();
      }
    }
  } else if (action.state === "RECONCILED") {
    const finished = reconcilePairs.filter((pair) => pair.finished !== null);
    const latestStartedAt = Math.max(
      ...reconcilePairs.map(
        (pair) => pair.started?.milliseconds ?? Number.NEGATIVE_INFINITY,
      ),
    );
    const expectedOutcome: AttemptOutcome =
      action.reconcileOutcome === "SUCCEEDED"
        ? "SUCCEEDED"
        : action.reconcileOutcome === "FAILED"
          ? "FAILED_DEFINITE"
          : "INDETERMINATE";
    if (
      finished.length !== 1 ||
      finished[0]?.started?.milliseconds !== latestStartedAt ||
      finished[0]?.finished?.createdAt !== action.updatedAt ||
      finished[0]?.finished?.outcome !== expectedOutcome ||
      finished[0]?.finished?.remoteId !== action.remoteId ||
      finished[0]?.finished?.resultDigest === null ||
      !samePrefixedHash(
        finished[0]?.finished?.resultDigest,
        expectedResultDigest(expectedOutcome, action.remoteId),
      )
    ) {
      return auditFailure();
    }
  } else if (reconcilePairs.length !== 0) {
    return auditFailure();
  }
}

function validateReconciliationLedger(
  database: Database.Database,
  action: ActionRecord,
  transitions: readonly ValidatedTransition[],
): void {
  const created = canonicalPersistedTimestamp(
    action.createdAt,
    "action_persistence_failed",
  );
  const updated = canonicalPersistedTimestamp(
    action.updatedAt,
    "action_persistence_failed",
  );
  const rows = database
    .prepare(
      `SELECT id, outcome, evidence_digest AS evidenceDigest,
              operator_kind AS operatorKind, created_at AS createdAt
         FROM reconciliations WHERE action_id = ? ORDER BY created_at, id`,
    )
    .all(action.actionId) as ReconciliationAuditRow[];
  if (action.state !== "RECONCILED") {
    if (rows.length !== 0) return auditFailure();
    return;
  }
  const finalTransition = transitions.at(-1);
  if (rows.length !== 1 || finalTransition === undefined) {
    return auditFailure();
  }
  const row = rows[0];
  if (
    row === undefined ||
    !canonicalUuid(row.id) ||
    (row.outcome !== "SUCCEEDED" &&
      row.outcome !== "FAILED" &&
      row.outcome !== "INDETERMINATE") ||
    !canonicalPrefixedSha256(row.evidenceDigest) ||
    (row.operatorKind !== "automatic" && row.operatorKind !== "manual") ||
    (row.operatorKind === "automatic" && row.outcome === "INDETERMINATE") ||
    row.outcome !== action.reconcileOutcome ||
    finalTransition.evidenceDigest === null ||
    !samePrefixedHash(row.evidenceDigest, finalTransition.evidenceDigest)
  ) {
    return auditFailure();
  }
  const timestamp = auditTimestamp(
    row.createdAt,
    created.milliseconds,
    updated.milliseconds,
  );
  if (
    timestamp.iso !== action.updatedAt ||
    finalTransition.createdAt !== action.updatedAt
  ) {
    return auditFailure();
  }
}

function validateActionAuditLedger(
  database: Database.Database,
  action: ActionRecord,
  actionRow: ActionRow,
): void {
  const transitions = validateTransitionLedger(database, action);
  validateApprovalLedger(database, action, actionRow, transitions);
  validateInstructionAuthorizationLedger(database, action);
  validateAttemptLedger(database, action, transitions);
  validateReconciliationLedger(database, action, transitions);
}

export function assertActionInvalidationReady(
  database: Database.Database,
  actionId: string,
  expectedState: string,
  now: ClockSnapshot,
): void {
  if (!INVALIDATABLE_ACTION_STATES.has(expectedState as ActionState)) {
    throw new RuntimeStateError("action_persistence_failed");
  }
  const row = database
    .prepare(`${ACTION_SELECT} WHERE id = ? AND version = 1`)
    .get(actionId) as ActionRow | undefined;
  if (row === undefined) {
    throw new RuntimeStateError("action_persistence_failed");
  }
  const action = actionRecord(database, row);
  if (
    action.actionId !== actionId ||
    action.state !== expectedState ||
    !actionTimeAllows(action, now)
  ) {
    throw new RuntimeStateError("action_persistence_failed");
  }
}

function transitionAction(
  database: Database.Database,
  action: ActionRecord,
  toState: ActionState,
  reasonCode: string,
  now: ClockSnapshot,
): void {
  if (!actionTimeAllows(action, now)) {
    throw new RuntimeStateError("action_persistence_failed");
  }
  const changed = database
    .prepare(
      `UPDATE actions
          SET state = ?, lease_owner = NULL, lease_expires_at = NULL,
              updated_at = ?
        WHERE id = ? AND version = ? AND state = ?`,
    )
    .run(
      toState,
      now.iso,
      action.actionId,
      action.version,
      action.state,
    ).changes;
  if (changed !== 1) {
    throw new RuntimeStateError("action_persistence_failed");
  }
  database
    .prepare(
      `INSERT INTO action_transitions(
         action_id, from_state, to_state, reason_code, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(action.actionId, action.state, toState, reasonCode, now.iso);
}

function appendApproval(
  database: Database.Database,
  action: ActionRecord,
  decision: "APPROVED" | "REJECTED" | "EXPIRED" | "INVALIDATED",
  now: ClockSnapshot,
  actorHash?: string,
  chatHash?: string,
  nonceHash?: string,
): void {
  const row = database
    .prepare(
      `SELECT actor_open_id_hash AS actorHash,
              chat_id_hash AS chatHash,
              nonce_hash AS nonceHash
         FROM actions WHERE id = ? AND version = ?`,
    )
    .get(action.actionId, action.version) as
    | Readonly<{
        actorHash: unknown;
        chatHash: unknown;
        nonceHash: unknown;
      }>
    | undefined;
  if (
    row === undefined ||
    !canonicalRawSha256(row.actorHash) ||
    !canonicalRawSha256(row.chatHash) ||
    !canonicalRawSha256(row.nonceHash)
  ) {
    throw new RuntimeStateError("action_persistence_failed");
  }
  database
    .prepare(
      `INSERT INTO approvals(
         id, action_id, action_version, actor_open_id_hash, chat_id_hash,
         payload_hash, nonce_hash, decision, decided_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      action.actionId,
      action.version,
      actorHash ?? row.actorHash,
      chatHash ?? row.chatHash,
      action.payloadHash,
      nonceHash ?? row.nonceHash,
      decision,
      now.iso,
    );
}

function sourceIdentity(
  database: Database.Database,
  taskId: string,
): Readonly<{
  inboundEventId: string;
  actorHash: string;
  chatHash: string;
}> {
  const row = database
    .prepare(
      `SELECT tasks.id AS sourceId,
              tasks.inbound_event_id AS inboundEventId,
              inbound_events.sender_open_id_hash AS actorHash,
              inbound_events.chat_id_hash AS chatHash
         FROM tasks
         JOIN inbound_events ON inbound_events.id = tasks.inbound_event_id
        WHERE tasks.id = ?`,
    )
    .get(taskId) as SourceIdentityRow | undefined;
  if (
    row === undefined ||
    row.sourceId !== taskId ||
    !canonicalUuid(row.inboundEventId) ||
    !canonicalRawSha256(row.actorHash) ||
    !canonicalRawSha256(row.chatHash)
  ) {
    throw new RuntimeStateError("action_source_identity_is_invalid");
  }
  return Object.freeze({
    inboundEventId: row.inboundEventId,
    actorHash: row.actorHash,
    chatHash: row.chatHash,
  });
}

function taskIsExecutable(
  database: Database.Database,
  taskId: string,
  instanceId: string,
  now: ClockSnapshot,
): boolean {
  const row = database
    .prepare(
      `SELECT id AS taskId, state, lease_owner AS leaseOwner,
              lease_expires_at AS leaseExpiresAt,
              codex_session_id AS codexSessionId
         FROM tasks WHERE id = ?`,
    )
    .get(taskId) as ExecutableTaskRow | undefined;
  if (row === undefined || row.taskId !== taskId) return false;
  if (
    typeof row.state !== "string" ||
    (row.leaseOwner !== null && !safeText(row.leaseOwner, 128)) ||
    (row.codexSessionId !== null && !safeText(row.codexSessionId, 256)) ||
    (row.leaseExpiresAt !== null && typeof row.leaseExpiresAt !== "string")
  ) {
    throw new RuntimeStateError("action_persistence_failed");
  }
  if (
    row.state !== "RUNNING" ||
    row.leaseOwner !== instanceId ||
    row.codexSessionId === null ||
    row.leaseExpiresAt === null
  ) {
    return false;
  }
  return (
    canonicalPersistedTimestamp(row.leaseExpiresAt, "action_persistence_failed")
      .milliseconds >= now.milliseconds
  );
}

function actionParentIsExecutable(
  database: Database.Database,
  action: ActionRecord,
  instanceId: string,
  now: ClockSnapshot,
): boolean {
  return (
    action.approvalMode === "system_policy" ||
    action.taskId === null ||
    taskIsExecutable(database, action.taskId, instanceId, now)
  );
}

function attemptKindFor(action: ActionRecord): "DISPATCH" | "SYSTEM_REPLY" {
  return action.capability === "system_reply" ? "SYSTEM_REPLY" : "DISPATCH";
}

function actionLeaseMatches(
  action: ActionRecord,
  owner: string,
  leaseExpiresAt: string,
  now: ClockSnapshot,
): boolean {
  if (
    action.leaseOwner !== owner ||
    action.leaseExpiresAt !== leaseExpiresAt ||
    action.leaseExpiresAt === null
  ) {
    return false;
  }
  return (
    canonicalPersistedTimestamp(
      action.leaseExpiresAt,
      "action_persistence_failed",
    ).milliseconds >= now.milliseconds
  );
}

function startedAttempt(
  database: Database.Database,
  actionId: string,
  attemptId: string,
): Readonly<{
  attemptKind: "DISPATCH" | "SYSTEM_REPLY" | "RECONCILE";
  requestDigest: string;
  createdAt: string;
}> | null {
  const row = database
    .prepare(
      `SELECT attempt_kind AS attemptKind, request_digest AS requestDigest,
              created_at AS createdAt
         FROM action_attempts
        WHERE action_id = ? AND attempt_id = ? AND phase = 'STARTED'`,
    )
    .get(actionId, attemptId) as StartedAttemptRow | undefined;
  if (row === undefined) return null;
  if (
    (row.attemptKind !== "DISPATCH" &&
      row.attemptKind !== "SYSTEM_REPLY" &&
      row.attemptKind !== "RECONCILE") ||
    !canonicalPrefixedSha256(row.requestDigest)
  ) {
    throw new RuntimeStateError("action_persistence_failed");
  }
  const createdAt = canonicalPersistedTimestamp(
    row.createdAt,
    "action_persistence_failed",
  );
  return Object.freeze({
    attemptKind: row.attemptKind,
    requestDigest: row.requestDigest,
    createdAt: createdAt.iso,
  });
}

function persistenceFailure(cause: unknown): never {
  if (cause instanceof RuntimeStateError) throw cause;
  throw new RuntimeStateError("action_persistence_failed", cause);
}

export function prepareAction(
  database: Database.Database,
  instanceId: string,
  inputValue: PrepareActionInput,
): PreparedActionWithNonce {
  const input = snapshotExactInput(
    inputValue,
    ["taskId", "capability", "identity", "payload", "preview", "now"],
    [],
    "action_prepare_input_is_invalid",
  );
  if (
    !canonicalUuid(input.taskId) ||
    !safeText(input.capability, 128) ||
    (input.identity !== "bot" && input.identity !== "user") ||
    input.capability === "system_reply"
  ) {
    throw new RuntimeStateError("action_prepare_input_is_invalid");
  }
  const payload = snapshotStrictIJson(input.payload);
  const preview = snapshotStrictIJson(
    input.preview,
    "action_preview_must_be_strict_i_json",
  );
  const approvalWindow = snapshotLeaseWindow(
    input.now as Date,
    APPROVAL_TTL_MS,
  );
  const actionId = randomUUID();
  const nonce = randomBytes(32).toString("base64url");
  const canonicalPayload = canonicalStrictIJson(payload);
  const canonicalPreview = canonicalStrictIJson(preview);
  const actionPayloadHash = payloadHash(payload);

  try {
    return database
      .transaction(() => {
        requireOwnLiveBridge(database, instanceId, approvalWindow.now);
        const source = sourceIdentity(database, input.taskId as string);
        if (
          !taskIsExecutable(
            database,
            input.taskId as string,
            instanceId,
            approvalWindow.now,
          )
        ) {
          throw new RuntimeStateError("action_parent_task_is_not_executable");
        }
        const existingRows = database
          .prepare(
            `${ACTION_SELECT}
              WHERE task_id = ?
                AND approval_mode = 'president'
                AND state IN ('PREPARED','APPROVED','CLAIMED','DISPATCHING','UNKNOWN')
              ORDER BY id`,
          )
          .all(input.taskId) as ActionRow[];
        const existing = existingRows.map((row) => actionRecord(database, row));
        if (
          existing.some(
            (action) =>
              action.state === "CLAIMED" ||
              action.state === "DISPATCHING" ||
              action.state === "UNKNOWN",
          )
        ) {
          throw new RuntimeStateError("action_supersede_requires_recovery");
        }
        for (const previous of existing) {
          transitionAction(
            database,
            previous,
            "FAILED",
            "superseded_by_new_preview",
            approvalWindow.now,
          );
          appendApproval(database, previous, "INVALIDATED", approvalWindow.now);
        }
        database
          .prepare(
            `INSERT INTO actions(
               id, task_id, version, capability, identity, approval_mode,
               state, payload_json, payload_hash, preview_json,
               actor_open_id_hash, chat_id_hash, nonce_hash, idempotency_key,
               expires_at, created_at, updated_at
             ) VALUES (?, ?, 1, ?, ?, 'president', 'PREPARED', ?, ?, ?,
                       ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            actionId,
            input.taskId,
            input.capability,
            input.identity,
            canonicalPayload,
            actionPayloadHash,
            canonicalPreview,
            source.actorHash,
            source.chatHash,
            sha256Hex(nonce),
            actionId,
            approvalWindow.expiresAt.iso,
            approvalWindow.now.iso,
            approvalWindow.now.iso,
          );
        database
          .prepare(
            `INSERT INTO action_transitions(
               action_id, from_state, to_state, reason_code, created_at
             ) VALUES (?, NULL, 'PREPARED', 'prepared', ?)`,
          )
          .run(actionId, approvalWindow.now.iso);
        return Object.freeze({
          actionId,
          version: 1,
          payloadHash: actionPayloadHash,
          nonce,
          expiresAt: approvalWindow.expiresAt.iso,
          state: "PREPARED",
        });
      })
      .immediate();
  } catch (cause) {
    return persistenceFailure(cause);
  }
}

export function authorizePresidentInstructionAction(
  database: Database.Database,
  instanceId: string,
  inputValue: AuthorizePresidentInstructionActionInput,
): AuthorizedPresidentInstructionAction {
  const input = snapshotExactInput(
    inputValue,
    [
      "taskId",
      "capability",
      "identity",
      "itemKey",
      "payload",
      "preview",
      "now",
    ],
    [],
    "action_instruction_input_is_invalid",
  );
  if (
    !canonicalUuid(input.taskId) ||
    !safeText(input.capability, 128) ||
    (input.identity !== "bot" && input.identity !== "user") ||
    !safeText(input.itemKey, 256) ||
    input.capability === "system_reply"
  ) {
    throw new RuntimeStateError("action_instruction_input_is_invalid");
  }
  const payload = snapshotStrictIJson(input.payload);
  const preview = snapshotStrictIJson(
    input.preview,
    "action_preview_must_be_strict_i_json",
  );
  const authorizationWindow = snapshotLeaseWindow(
    input.now as Date,
    APPROVAL_TTL_MS,
  );
  const canonicalPayload = canonicalStrictIJson(payload);
  const canonicalPreview = canonicalStrictIJson(preview);
  const actionPayloadHash = payloadHash(payload);

  try {
    return database
      .transaction(() => {
        requireOwnLiveBridge(database, instanceId, authorizationWindow.now);
        const source = sourceIdentity(database, input.taskId as string);
        if (
          !taskIsExecutable(
            database,
            input.taskId as string,
            instanceId,
            authorizationWindow.now,
          )
        ) {
          throw new RuntimeStateError("action_parent_task_is_not_executable");
        }
        const replayRow = database
          .prepare(
            `SELECT action_id AS actionId, action_version AS version
               FROM instruction_authorizations
              WHERE task_id = ? AND capability = ? AND item_key = ?`,
          )
          .get(input.taskId, input.capability, input.itemKey) as
          | Readonly<{ actionId: unknown; version: unknown }>
          | undefined;
        if (replayRow !== undefined) {
          if (!canonicalUuid(replayRow.actionId) || replayRow.version !== 1) {
            throw new RuntimeStateError("action_persistence_failed");
          }
          const existing = findAction(database, replayRow.actionId, 1);
          if (existing === null) {
            throw new RuntimeStateError("action_persistence_failed");
          }
          if (!samePrefixedHash(existing.payloadHash, actionPayloadHash)) {
            throw new RuntimeStateError("action_instruction_replay_conflict");
          }
          return Object.freeze({
            action: existing as ActionRecord &
              Readonly<{ approvalMode: "president_instruction" }>,
            created: false,
          });
        }

        const actionId = randomUUID();
        const nonce = randomBytes(32).toString("base64url");
        database
          .prepare(
            `INSERT INTO actions(
               id, task_id, version, capability, identity, approval_mode,
               state, payload_json, payload_hash, preview_json,
               actor_open_id_hash, chat_id_hash, nonce_hash, idempotency_key,
               expires_at, created_at, updated_at
             ) VALUES (?, ?, 1, ?, ?, 'president_instruction', 'APPROVED',
                       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            actionId,
            input.taskId,
            input.capability,
            input.identity,
            canonicalPayload,
            actionPayloadHash,
            canonicalPreview,
            source.actorHash,
            source.chatHash,
            sha256Hex(nonce),
            actionId,
            authorizationWindow.expiresAt.iso,
            authorizationWindow.now.iso,
            authorizationWindow.now.iso,
          );
        database
          .prepare(
            `INSERT INTO instruction_authorizations(
               action_id, action_version, task_id, inbound_event_id,
               capability, payload_hash, item_key, created_at
             ) VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            actionId,
            input.taskId,
            source.inboundEventId,
            input.capability,
            actionPayloadHash,
            input.itemKey,
            authorizationWindow.now.iso,
          );
        database
          .prepare(
            `INSERT INTO action_transitions(
               action_id, from_state, to_state, reason_code, created_at
             ) VALUES (
               ?, NULL, 'APPROVED', 'president_instruction_approved', ?
             )`,
          )
          .run(actionId, authorizationWindow.now.iso);
        const action = findAction(database, actionId, 1);
        if (
          action === null ||
          action.approvalMode !== "president_instruction" ||
          action.state !== "APPROVED"
        ) {
          throw new RuntimeStateError("action_persistence_failed");
        }
        return Object.freeze({
          action: action as ActionRecord &
            Readonly<{ approvalMode: "president_instruction" }>,
          created: true,
        });
      })
      .immediate();
  } catch (cause) {
    return persistenceFailure(cause);
  }
}

const EXPIRED_OR_CHANGED = Symbol("expired_or_changed");

function throwExpiredOrChanged(): never {
  throw new RuntimeStateError("expired_or_changed");
}

export function approveAction(
  database: Database.Database,
  instanceId: string,
  inputValue: ApproveActionInput,
): ApprovedAction {
  let input: InputSnapshot;
  try {
    input = snapshotExactInput(
      inputValue,
      [
        "actionId",
        "version",
        "actionPayloadHash",
        "nonce",
        "decision",
        "actorOpenId",
        "chatId",
        "now",
      ],
      [],
      "expired_or_changed",
    );
  } catch {
    return throwExpiredOrChanged();
  }
  if (
    !canonicalUuid(input.actionId) ||
    input.version !== 1 ||
    !canonicalPrefixedSha256(input.actionPayloadHash) ||
    !safeText(input.nonce) ||
    (input.decision !== "approve" && input.decision !== "reject") ||
    !safeText(input.actorOpenId) ||
    !safeText(input.chatId)
  ) {
    return throwExpiredOrChanged();
  }
  let now: ClockSnapshot;
  try {
    now = snapshotDate(input.now as Date, "expired_or_changed");
  } catch {
    return throwExpiredOrChanged();
  }

  try {
    const result = database
      .transaction(() => {
        requireOwnLiveBridge(database, instanceId, now);
        const action = findAction(database, input.actionId as string, 1);
        if (action === null || action.state !== "PREPARED") {
          return EXPIRED_OR_CHANGED;
        }
        const hashRow = database
          .prepare(
            `SELECT actor_open_id_hash AS actorHash,
                    chat_id_hash AS chatHash,
                    nonce_hash AS nonceHash
               FROM actions WHERE id = ? AND version = 1`,
          )
          .get(action.actionId) as
          | Readonly<{
              actorHash: unknown;
              chatHash: unknown;
              nonceHash: unknown;
            }>
          | undefined;
        if (
          hashRow === undefined ||
          !canonicalRawSha256(hashRow.actorHash) ||
          !canonicalRawSha256(hashRow.chatHash) ||
          !canonicalRawSha256(hashRow.nonceHash)
        ) {
          throw new RuntimeStateError("action_persistence_failed");
        }
        const nonceMatches = matchesPlaintextHash(
          hashRow.nonceHash,
          input.nonce as string,
        );
        const payloadMatches = samePrefixedHash(
          action.payloadHash,
          input.actionPayloadHash as string,
        );
        const actorMatches = matchesPlaintextHash(
          hashRow.actorHash,
          input.actorOpenId as string,
        );
        const chatMatches = matchesPlaintextHash(
          hashRow.chatHash,
          input.chatId as string,
        );
        const bound =
          nonceMatches && payloadMatches && actorMatches && chatMatches;
        if (!bound) return EXPIRED_OR_CHANGED;
        if (
          !actionTimeAllows(action, now) ||
          !actionParentIsExecutable(database, action, instanceId, now)
        ) {
          return EXPIRED_OR_CHANGED;
        }
        const expiry = canonicalPersistedTimestamp(
          action.expiresAt,
          "action_persistence_failed",
        );
        if (expiry.milliseconds <= now.milliseconds) {
          transitionAction(database, action, "FAILED", "approval_expired", now);
          appendApproval(
            database,
            action,
            "EXPIRED",
            now,
            hashRow.actorHash,
            hashRow.chatHash,
            hashRow.nonceHash,
          );
          return EXPIRED_OR_CHANGED;
        }
        const state = input.decision === "approve" ? "APPROVED" : "FAILED";
        transitionAction(
          database,
          action,
          state,
          input.decision === "approve" ? "approved" : "rejected",
          now,
        );
        appendApproval(
          database,
          action,
          input.decision === "approve" ? "APPROVED" : "REJECTED",
          now,
          hashRow.actorHash,
          hashRow.chatHash,
          hashRow.nonceHash,
        );
        const updated = findAction(database, action.actionId, 1);
        if (updated === null) {
          throw new RuntimeStateError("action_persistence_failed");
        }
        return updated as ApprovedAction;
      })
      .immediate();
    if (result === EXPIRED_OR_CHANGED) return throwExpiredOrChanged();
    return result;
  } catch (cause) {
    if (cause instanceof RuntimeStateError) throw cause;
    return persistenceFailure(cause);
  }
}

export function claimApprovedAction(
  database: Database.Database,
  instanceId: string,
  inputValue: ClaimApprovedActionInput,
): ClaimedAction | null {
  const input = snapshotExactInput(
    inputValue,
    ["actionId", "version", "owner", "now", "ttlMs"],
    [],
    "action_claim_input_is_invalid",
  );
  if (
    !canonicalUuid(input.actionId) ||
    input.version !== 1 ||
    !safeText(input.owner, 128)
  ) {
    throw new RuntimeStateError("action_claim_input_is_invalid");
  }
  const leaseWindow = snapshotLeaseWindow(
    input.now as Date,
    input.ttlMs as number,
  );
  if (input.owner !== instanceId) return null;
  try {
    return database
      .transaction(() => {
        requireOwnLiveBridge(database, instanceId, leaseWindow.now);
        const action = findAction(database, input.actionId as string, 1);
        if (action === null || action.state !== "APPROVED") return null;
        if (
          !actionTimeAllows(action, leaseWindow.now) ||
          !actionParentIsExecutable(
            database,
            action,
            instanceId,
            leaseWindow.now,
          )
        ) {
          return null;
        }
        const approvalExpiry = canonicalPersistedTimestamp(
          action.expiresAt,
          "action_persistence_failed",
        );
        if (approvalExpiry.milliseconds <= leaseWindow.now.milliseconds) {
          transitionAction(
            database,
            action,
            "FAILED",
            "approval_expired_before_claim",
            leaseWindow.now,
          );
          return null;
        }
        const changed = database
          .prepare(
            `UPDATE actions
                SET state = 'CLAIMED', lease_owner = ?, lease_expires_at = ?,
                    updated_at = ?
              WHERE id = ? AND version = 1 AND state = 'APPROVED'
                AND expires_at = ? AND lease_owner IS NULL
                AND lease_expires_at IS NULL`,
          )
          .run(
            input.owner,
            leaseWindow.expiresAt.iso,
            leaseWindow.now.iso,
            action.actionId,
            action.expiresAt,
          ).changes;
        if (changed !== 1) return null;
        database
          .prepare(
            `INSERT INTO action_transitions(
               action_id, from_state, to_state, reason_code, created_at
             ) VALUES (?, 'APPROVED', 'CLAIMED', 'claimed', ?)`,
          )
          .run(action.actionId, leaseWindow.now.iso);
        const claimed = findAction(database, action.actionId, 1);
        if (claimed === null || claimed.state !== "CLAIMED") {
          throw new RuntimeStateError("action_persistence_failed");
        }
        return claimed as ClaimedAction;
      })
      .immediate();
  } catch (cause) {
    return persistenceFailure(cause);
  }
}

/**
 * Trusted JobStore composition seam for ledgers that authorize one action but
 * dispatch multiple independently-idempotent child parts. It performs the
 * same live-runtime, parent-task, expiry, and ownership checks as an action
 * claim without consuming the aggregate action state.
 */
export function getExecutableApprovedActionForNotification(
  database: Database.Database,
  instanceId: string,
  actionId: string,
  owner: string,
  nowValue: Date,
): ActionRecord | null {
  if (!canonicalUuid(actionId) || owner !== instanceId) return null;
  const now = snapshotDate(nowValue, "action_claim_input_is_invalid");
  requireOwnLiveBridge(database, instanceId, now);
  const action = findAction(database, actionId, 1);
  if (
    action === null ||
    action.state !== "APPROVED" ||
    !actionTimeAllows(action, now) ||
    !actionParentIsExecutable(database, action, instanceId, now)
  ) {
    return null;
  }
  const expiry = canonicalPersistedTimestamp(
    action.expiresAt,
    "action_persistence_failed",
  );
  return expiry.milliseconds > now.milliseconds ? action : null;
}

export function markDispatching(
  database: Database.Database,
  instanceId: string,
  inputValue: MarkDispatchingInput,
): DispatchingAction | null {
  const input = snapshotExactInput(
    inputValue,
    [
      "actionId",
      "version",
      "owner",
      "leaseExpiresAt",
      "now",
      "attemptId",
      "requestDigest",
    ],
    [],
    "action_transition_input_is_invalid",
  );
  if (
    !canonicalUuid(input.actionId) ||
    input.version !== 1 ||
    !safeText(input.owner, 128) ||
    typeof input.leaseExpiresAt !== "string" ||
    !canonicalUuid(input.attemptId) ||
    !canonicalPrefixedSha256(input.requestDigest)
  ) {
    throw new RuntimeStateError("action_transition_input_is_invalid");
  }
  const now = snapshotDate(input.now as Date);
  canonicalPersistedTimestamp(
    input.leaseExpiresAt,
    "action_transition_input_is_invalid",
  );
  if (input.owner !== instanceId) return null;
  try {
    return database
      .transaction(() => {
        requireOwnLiveBridge(database, instanceId, now);
        const action = findAction(database, input.actionId as string, 1);
        if (
          action === null ||
          action.state !== "CLAIMED" ||
          !actionTimeAllows(action, now) ||
          !actionParentIsExecutable(database, action, instanceId, now) ||
          !actionLeaseMatches(
            action,
            input.owner as string,
            input.leaseExpiresAt as string,
            now,
          )
        ) {
          return null;
        }
        const changed = database
          .prepare(
            `UPDATE actions SET state = 'DISPATCHING', updated_at = ?
              WHERE id = ? AND version = 1 AND state = 'CLAIMED'
                AND lease_owner = ? AND lease_expires_at = ?`,
          )
          .run(
            now.iso,
            action.actionId,
            input.owner,
            input.leaseExpiresAt,
          ).changes;
        if (changed !== 1) return null;
        const attemptKind = attemptKindFor(action);
        database
          .prepare(
            `INSERT INTO action_transitions(
               action_id, from_state, to_state, reason_code, created_at
             ) VALUES (?, 'CLAIMED', 'DISPATCHING', 'dispatch_started', ?)`,
          )
          .run(action.actionId, now.iso);
        database
          .prepare(
            `INSERT INTO action_attempts(
               id, action_id, attempt_id, phase, attempt_kind,
               request_digest, created_at
             ) VALUES (?, ?, ?, 'STARTED', ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            action.actionId,
            input.attemptId,
            attemptKind,
            input.requestDigest,
            now.iso,
          );
        const dispatching = findAction(database, action.actionId, 1);
        if (dispatching === null || dispatching.state !== "DISPATCHING") {
          throw new RuntimeStateError("action_persistence_failed");
        }
        return dispatching as DispatchingAction;
      })
      .immediate();
  } catch (cause) {
    return persistenceFailure(cause);
  }
}

export function finishAction(
  database: Database.Database,
  instanceId: string,
  inputValue: FinishActionInput,
): FinishedAction | null {
  const input = snapshotExactInput(
    inputValue,
    [
      "actionId",
      "version",
      "owner",
      "leaseExpiresAt",
      "now",
      "attemptId",
      "outcome",
    ],
    ["remoteId"],
    "action_transition_input_is_invalid",
  );
  if (
    !canonicalUuid(input.actionId) ||
    input.version !== 1 ||
    !safeText(input.owner, 128) ||
    typeof input.leaseExpiresAt !== "string" ||
    !canonicalUuid(input.attemptId) ||
    (input.outcome !== "SUCCEEDED" &&
      input.outcome !== "FAILED_DEFINITE" &&
      input.outcome !== "UNKNOWN") ||
    (input.remoteId !== undefined && !remoteIdentifier(input.remoteId)) ||
    (input.remoteId !== undefined && input.outcome !== "SUCCEEDED")
  ) {
    throw new RuntimeStateError("action_transition_input_is_invalid");
  }
  const now = snapshotDate(input.now as Date);
  canonicalPersistedTimestamp(
    input.leaseExpiresAt,
    "action_transition_input_is_invalid",
  );
  if (input.owner !== instanceId) return null;
  try {
    return database
      .transaction(() => {
        requireOwnLiveBridge(database, instanceId, now);
        const action = findAction(database, input.actionId as string, 1);
        if (
          action === null ||
          action.state !== "DISPATCHING" ||
          !actionTimeAllows(action, now) ||
          !actionLeaseMatches(
            action,
            input.owner as string,
            input.leaseExpiresAt as string,
            now,
          )
        ) {
          return null;
        }
        const started = startedAttempt(
          database,
          action.actionId,
          input.attemptId as string,
        );
        if (
          started === null ||
          started.attemptKind !== attemptKindFor(action) ||
          started.createdAt !== action.updatedAt
        ) {
          return null;
        }
        const resultSnapshot = snapshotStrictIJson(
          {
            outcome: input.outcome,
            ...(typeof input.remoteId === "string"
              ? { remoteId: input.remoteId }
              : {}),
          },
          "action_persistence_failed",
        );
        const resultJson = canonicalStrictIJson(resultSnapshot);
        const resultDigest = payloadHash(resultSnapshot);
        const toState =
          input.outcome === "SUCCEEDED"
            ? "SUCCEEDED"
            : input.outcome === "FAILED_DEFINITE"
              ? "FAILED"
              : "UNKNOWN";
        const changed = database
          .prepare(
            `UPDATE actions
                SET state = ?, result_json = ?, remote_id = ?,
                    lease_owner = NULL, lease_expires_at = NULL,
                    updated_at = ?
              WHERE id = ? AND version = 1 AND state = 'DISPATCHING'
                AND lease_owner = ? AND lease_expires_at = ?`,
          )
          .run(
            toState,
            resultJson,
            input.remoteId ?? null,
            now.iso,
            action.actionId,
            input.owner,
            input.leaseExpiresAt,
          ).changes;
        if (changed !== 1) return null;
        database
          .prepare(
            `INSERT INTO action_transitions(
               action_id, from_state, to_state, reason_code, created_at
             ) VALUES (?, 'DISPATCHING', ?, 'dispatch_finished', ?)`,
          )
          .run(action.actionId, toState, now.iso);
        database
          .prepare(
            `INSERT INTO action_attempts(
               id, action_id, attempt_id, phase, attempt_kind, outcome,
               request_digest, result_digest, remote_id, created_at
             ) VALUES (?, ?, ?, 'FINISHED', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            action.actionId,
            input.attemptId,
            started.attemptKind,
            input.outcome,
            started.requestDigest,
            resultDigest,
            input.remoteId ?? null,
            now.iso,
          );
        const finished = findAction(database, action.actionId, 1);
        if (
          finished === null ||
          (finished.state !== "SUCCEEDED" &&
            finished.state !== "FAILED" &&
            finished.state !== "UNKNOWN")
        ) {
          throw new RuntimeStateError("action_persistence_failed");
        }
        return finished as FinishedAction;
      })
      .immediate();
  } catch (cause) {
    return persistenceFailure(cause);
  }
}

export function getAction(
  database: Database.Database,
  refValue: ActionRef,
): ActionRecord | null {
  const ref = snapshotExactInput(
    refValue,
    ["actionId", "version"],
    [],
    "action_ref_is_invalid",
  );
  if (!canonicalUuid(ref.actionId) || ref.version !== 1) {
    throw new RuntimeStateError("action_ref_is_invalid");
  }
  try {
    return findAction(database, ref.actionId, 1);
  } catch (cause) {
    return persistenceFailure(cause);
  }
}

export function listUnknownActions(
  database: Database.Database,
): readonly ActionRecord[] {
  try {
    const rows = database
      .prepare(`${ACTION_SELECT} WHERE state = 'UNKNOWN' ORDER BY id`)
      .all() as ActionRow[];
    return Object.freeze(rows.map((row) => actionRecord(database, row)));
  } catch (cause) {
    return persistenceFailure(cause);
  }
}

export function startReconciliation(
  database: Database.Database,
  instanceId: string,
  inputValue: StartReconciliationInput,
): ReconciliationClaim | null {
  const input = snapshotExactInput(
    inputValue,
    [
      "actionId",
      "version",
      "owner",
      "now",
      "ttlMs",
      "attemptId",
      "requestDigest",
    ],
    [],
    "action_transition_input_is_invalid",
  );
  if (
    !canonicalUuid(input.actionId) ||
    input.version !== 1 ||
    !safeText(input.owner, 128) ||
    !canonicalUuid(input.attemptId) ||
    !canonicalPrefixedSha256(input.requestDigest)
  ) {
    throw new RuntimeStateError("action_transition_input_is_invalid");
  }
  const leaseWindow = snapshotLeaseWindow(
    input.now as Date,
    input.ttlMs as number,
  );
  if (input.owner !== instanceId) return null;
  try {
    return database
      .transaction(() => {
        requireOwnLiveBridge(database, instanceId, leaseWindow.now);
        const action = findAction(database, input.actionId as string, 1);
        if (
          action === null ||
          action.state !== "UNKNOWN" ||
          !actionTimeAllows(action, leaseWindow.now)
        ) {
          return null;
        }
        if (action.leaseExpiresAt !== null) {
          const oldExpiry = canonicalPersistedTimestamp(
            action.leaseExpiresAt,
            "action_persistence_failed",
          );
          if (oldExpiry.milliseconds >= leaseWindow.now.milliseconds) {
            return null;
          }
        }
        const changed = database
          .prepare(
            `UPDATE actions
                SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
              WHERE id = ? AND version = 1 AND state = 'UNKNOWN'
                AND lease_owner IS ? AND lease_expires_at IS ?`,
          )
          .run(
            input.owner,
            leaseWindow.expiresAt.iso,
            leaseWindow.now.iso,
            action.actionId,
            action.leaseOwner,
            action.leaseExpiresAt,
          ).changes;
        if (changed !== 1) return null;
        database
          .prepare(
            `INSERT INTO action_attempts(
               id, action_id, attempt_id, phase, attempt_kind,
               request_digest, created_at
             ) VALUES (?, ?, ?, 'STARTED', 'RECONCILE', ?, ?)`,
          )
          .run(
            randomUUID(),
            action.actionId,
            input.attemptId,
            input.requestDigest,
            leaseWindow.now.iso,
          );
        const claimed = findAction(database, action.actionId, 1);
        if (
          claimed === null ||
          claimed.state !== "UNKNOWN" ||
          claimed.leaseOwner !== input.owner ||
          claimed.leaseExpiresAt !== leaseWindow.expiresAt.iso
        ) {
          throw new RuntimeStateError("action_persistence_failed");
        }
        return claimed as ReconciliationClaim;
      })
      .immediate();
  } catch (cause) {
    return persistenceFailure(cause);
  }
}

export function reconcileAction(
  database: Database.Database,
  instanceId: string,
  inputValue: ReconcileActionInput,
): ReconciledAction | null {
  const input = snapshotExactInput(
    inputValue,
    [
      "actionId",
      "version",
      "owner",
      "leaseExpiresAt",
      "now",
      "attemptId",
      "outcome",
      "evidenceDigest",
      "operatorKind",
    ],
    ["remoteId"],
    "action_transition_input_is_invalid",
  );
  if (
    !canonicalUuid(input.actionId) ||
    input.version !== 1 ||
    !safeText(input.owner, 128) ||
    typeof input.leaseExpiresAt !== "string" ||
    !canonicalUuid(input.attemptId) ||
    (input.outcome !== "SUCCEEDED" &&
      input.outcome !== "FAILED" &&
      input.outcome !== "INDETERMINATE") ||
    !canonicalPrefixedSha256(input.evidenceDigest) ||
    (input.operatorKind !== "automatic" && input.operatorKind !== "manual") ||
    (input.operatorKind === "automatic" && input.outcome === "INDETERMINATE") ||
    (input.remoteId !== undefined && !remoteIdentifier(input.remoteId)) ||
    (input.remoteId !== undefined && input.outcome !== "SUCCEEDED")
  ) {
    throw new RuntimeStateError("action_transition_input_is_invalid");
  }
  const now = snapshotDate(input.now as Date);
  canonicalPersistedTimestamp(
    input.leaseExpiresAt,
    "action_transition_input_is_invalid",
  );
  if (input.owner !== instanceId) return null;
  try {
    return database
      .transaction(() => {
        requireOwnLiveBridge(database, instanceId, now);
        const action = findAction(database, input.actionId as string, 1);
        if (
          action === null ||
          action.state !== "UNKNOWN" ||
          !actionTimeAllows(action, now) ||
          !actionLeaseMatches(
            action,
            input.owner as string,
            input.leaseExpiresAt as string,
            now,
          )
        ) {
          return null;
        }
        const started = startedAttempt(
          database,
          action.actionId,
          input.attemptId as string,
        );
        if (
          started === null ||
          started.attemptKind !== "RECONCILE" ||
          started.createdAt !== action.updatedAt
        ) {
          return null;
        }
        const attemptOutcome: AttemptOutcome =
          input.outcome === "SUCCEEDED"
            ? "SUCCEEDED"
            : input.outcome === "FAILED"
              ? "FAILED_DEFINITE"
              : "INDETERMINATE";
        const resultSnapshot = snapshotStrictIJson(
          {
            outcome: attemptOutcome,
            ...(typeof input.remoteId === "string"
              ? { remoteId: input.remoteId }
              : {}),
          },
          "action_persistence_failed",
        );
        const resultJson = canonicalStrictIJson(resultSnapshot);
        const resultDigest = payloadHash(resultSnapshot);
        const changed = database
          .prepare(
            `UPDATE actions
                SET state = 'RECONCILED', reconcile_outcome = ?,
                    result_json = ?, remote_id = ?,
                    lease_owner = NULL, lease_expires_at = NULL,
                    updated_at = ?
              WHERE id = ? AND version = 1 AND state = 'UNKNOWN'
                AND lease_owner = ? AND lease_expires_at = ?`,
          )
          .run(
            input.outcome,
            resultJson,
            input.remoteId ?? null,
            now.iso,
            action.actionId,
            input.owner,
            input.leaseExpiresAt,
          ).changes;
        if (changed !== 1) return null;
        database
          .prepare(
            `INSERT INTO action_transitions(
               action_id, from_state, to_state, reason_code,
               evidence_digest, created_at
             ) VALUES (?, 'UNKNOWN', 'RECONCILED', 'reconciled', ?, ?)`,
          )
          .run(action.actionId, input.evidenceDigest, now.iso);
        database
          .prepare(
            `INSERT INTO reconciliations(
               id, action_id, outcome, evidence_digest, operator_kind,
               created_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            action.actionId,
            input.outcome,
            input.evidenceDigest,
            input.operatorKind,
            now.iso,
          );
        database
          .prepare(
            `INSERT INTO action_attempts(
               id, action_id, attempt_id, phase, attempt_kind, outcome,
               request_digest, result_digest, remote_id, created_at
             ) VALUES (?, ?, ?, 'FINISHED', 'RECONCILE', ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            action.actionId,
            input.attemptId,
            attemptOutcome,
            started.requestDigest,
            resultDigest,
            input.remoteId ?? null,
            now.iso,
          );
        const reconciled = findAction(database, action.actionId, 1);
        if (reconciled === null || reconciled.state !== "RECONCILED") {
          throw new RuntimeStateError("action_persistence_failed");
        }
        return reconciled as ReconciledAction;
      })
      .immediate();
  } catch (cause) {
    return persistenceFailure(cause);
  }
}
