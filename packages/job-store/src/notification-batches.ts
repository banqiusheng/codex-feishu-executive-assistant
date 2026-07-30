import { randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";

import type Database from "better-sqlite3";

import {
  authorizePresidentInstructionAction,
  claimApprovedAction,
  finishAction,
  getExecutableApprovedActionForNotification,
  getAction,
  markDispatching,
} from "./actions.js";
import {
  canonicalStrictIJson,
  payloadHash,
  snapshotStrictIJson,
  type StrictIJson,
} from "./canonical-json.js";
import { canonicalPersistedTimestamp } from "./leases.js";
import {
  RuntimeStateError,
  type ActionRecord,
  type ActionResult,
  type ClaimNextNotificationDeliveryInput,
  type CreateNotificationBatchInput,
  type CreateNotificationBatchResult,
  type FinishNotificationDeliveryInput,
  type FinishedNotificationDelivery,
  type MarkNotificationDeliveryDispatchingInput,
  type NotificationBatchRecord,
  type NotificationBatchState,
  type NotificationBatchSummary,
  type NotificationDeliveryClaim,
  type NotificationDeliveryDispatching,
  type NotificationDeliveryRecord,
  type NotificationPartRecord,
  type NotificationPartState,
} from "./types.js";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/;
const REMOTE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LONE_SURROGATE =
  /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u;
const BATCH_STATES = new Set<NotificationBatchState>([
  "PREPARED",
  "DISPATCHING",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN",
]);
const PART_STATES = new Set<NotificationPartState>([
  "PENDING",
  "CLAIMED",
  "DISPATCHING",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN",
]);
const UNKNOWN_PART_RESULT = Object.freeze({ outcome: "UNKNOWN" as const });
const UNKNOWN_PART_RESULT_JSON = canonicalStrictIJson(UNKNOWN_PART_RESULT);

type ClockSnapshot = Readonly<{ iso: string; milliseconds: number }>;

type RecipientSnapshot = Readonly<{
  recipientRef: string;
  recipientBinding: StrictIJson;
  canonicalBinding: string;
}>;

type AttachmentSnapshot = Readonly<{
  resourceRef: string;
  kind: "image" | "file";
  resourceBinding: StrictIJson;
  canonicalBinding: string;
}>;

type CreateInputSnapshot = Readonly<{
  taskId: string;
  batchKey: string;
  recipients: readonly RecipientSnapshot[];
  content: StrictIJson;
  attachments: readonly AttachmentSnapshot[];
  now: ClockSnapshot;
}>;

type BatchRow = Readonly<{
  batchId: unknown;
  taskId: unknown;
  batchKeyHash: unknown;
  recipientCount: unknown;
  state: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}>;

type PartRow = Readonly<{
  partId: unknown;
  batchId: unknown;
  recipientOrdinal: unknown;
  actionId: unknown;
  partOrdinal: unknown;
  partKind: unknown;
  idempotencyKey: unknown;
  state: unknown;
  attemptCount: unknown;
  leaseOwner: unknown;
  leaseExpiresAt: unknown;
  attemptId: unknown;
  requestDigest: unknown;
  remoteId: unknown;
  resultJson: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}>;

type LoadedBatch = Readonly<{
  batch: NotificationBatchRecord;
  batchKeyHash: string;
  actions: ReadonlyMap<string, ActionRecord>;
}>;

function isProxy(value: object): boolean {
  try {
    return utilTypes.isProxy(value);
  } catch {
    return true;
  }
}

function canonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

function canonicalDigest(value: unknown): value is string {
  return typeof value === "string" && PREFIXED_SHA256.test(value);
}

function safeText(value: unknown, maximumLength: number): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    value.normalize("NFC") !== value ||
    LONE_SURROGATE.test(value)
  ) {
    return false;
  }
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f);
  });
}

function snapshotExactDataObject(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      isProxy(value)
    ) {
      throw new Error("invalid object");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("invalid object prototype");
    }
    const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
    const keys = Reflect.ownKeys(value);
    if (
      keys.length < requiredKeys.length ||
      keys.length > allowedKeys.size ||
      !keys.every((key) => typeof key === "string" && allowedKeys.has(key)) ||
      !requiredKeys.every((key) => keys.includes(key))
    ) {
      throw new Error("invalid object keys");
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
        throw new Error("invalid object descriptor");
      }
      Object.defineProperty(snapshot, key, {
        configurable: false,
        enumerable: true,
        value: descriptor.value,
        writable: false,
      });
    }
    return Object.freeze(snapshot);
  } catch {
    throw new RuntimeStateError("notification_batch_input_is_invalid");
  }
}

function snapshotDate(value: unknown): ClockSnapshot {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      isProxy(value) ||
      Object.getPrototypeOf(value) !== Date.prototype ||
      Reflect.ownKeys(value).length !== 0
    ) {
      throw new Error("invalid date");
    }
    const milliseconds = Date.prototype.getTime.call(value);
    if (!Number.isFinite(milliseconds)) throw new Error("invalid date");
    return Object.freeze({
      iso: new Date(milliseconds).toISOString(),
      milliseconds,
    });
  } catch {
    throw new RuntimeStateError("notification_batch_input_is_invalid");
  }
}

function snapshotRecipients(value: unknown): readonly RecipientSnapshot[] {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      !Array.isArray(value) ||
      isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      throw new Error("invalid recipients");
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 1 ||
      lengthDescriptor.value > 20 ||
      lengthDescriptor.enumerable
    ) {
      throw new Error("invalid recipients");
    }
    const length = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== length + 1 ||
      !keys.includes("length") ||
      !keys.every(
        (key) =>
          key === "length" ||
          (typeof key === "string" &&
            /^(0|[1-9]\d*)$/.test(key) &&
            Number(key) < length),
      )
    ) {
      throw new Error("invalid recipients");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const recipientRefs = new Set<string>();
    const canonicalBindings = new Set<string>();
    const recipients: RecipientSnapshot[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        throw new Error("invalid recipient descriptor");
      }
      const recipient = snapshotExactDataObject(descriptor.value, [
        "recipientRef",
        "recipientBinding",
      ]);
      if (
        !canonicalUuid(recipient.recipientRef) ||
        recipientRefs.has(recipient.recipientRef)
      ) {
        throw new Error("invalid recipient ref");
      }
      const binding = snapshotStrictIJson(
        recipient.recipientBinding,
        "notification_batch_input_is_invalid",
      );
      if (
        binding === null ||
        typeof binding === "boolean" ||
        typeof binding === "number" ||
        Array.isArray(binding) ||
        (typeof binding === "string" && !safeText(binding, 1_024)) ||
        (typeof binding === "object" && Object.keys(binding).length === 0)
      ) {
        throw new Error("invalid recipient binding");
      }
      const canonicalBinding = canonicalStrictIJson(binding);
      if (
        canonicalBinding.length > 8_192 ||
        canonicalBindings.has(canonicalBinding)
      ) {
        throw new Error("invalid recipient binding");
      }
      recipientRefs.add(recipient.recipientRef);
      canonicalBindings.add(canonicalBinding);
      recipients.push(
        Object.freeze({
          recipientRef: recipient.recipientRef,
          recipientBinding: binding,
          canonicalBinding,
        }),
      );
    }
    return Object.freeze(recipients);
  } catch (cause) {
    if (cause instanceof RuntimeStateError) throw cause;
    throw new RuntimeStateError("notification_batch_input_is_invalid");
  }
}

function snapshotAttachments(value: unknown): readonly AttachmentSnapshot[] {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      !Array.isArray(value) ||
      isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      throw new Error("invalid attachments");
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > 20 ||
      lengthDescriptor.enumerable
    ) {
      throw new Error("invalid attachments");
    }
    const length = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== length + 1 ||
      !keys.includes("length") ||
      !keys.every(
        (key) =>
          key === "length" ||
          (typeof key === "string" &&
            /^(0|[1-9]\d*)$/.test(key) &&
            Number(key) < length),
      )
    ) {
      throw new Error("invalid attachments");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const refs = new Set<string>();
    const bindings = new Set<string>();
    const attachments: AttachmentSnapshot[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        throw new Error("invalid attachment descriptor");
      }
      const attachment = snapshotExactDataObject(descriptor.value, [
        "resourceRef",
        "kind",
        "resourceBinding",
      ]);
      if (
        !canonicalUuid(attachment.resourceRef) ||
        refs.has(attachment.resourceRef) ||
        (attachment.kind !== "image" && attachment.kind !== "file")
      ) {
        throw new Error("invalid attachment");
      }
      const binding = snapshotStrictIJson(
        attachment.resourceBinding,
        "notification_batch_input_is_invalid",
      );
      if (
        binding === null ||
        Array.isArray(binding) ||
        typeof binding !== "object" ||
        Object.keys(binding).length === 0
      ) {
        throw new Error("invalid attachment binding");
      }
      const canonicalBinding = canonicalStrictIJson(binding);
      if (canonicalBinding.length > 8_192 || bindings.has(canonicalBinding)) {
        throw new Error("invalid attachment binding");
      }
      refs.add(attachment.resourceRef);
      bindings.add(canonicalBinding);
      attachments.push(
        Object.freeze({
          resourceRef: attachment.resourceRef,
          kind: attachment.kind,
          resourceBinding: binding,
          canonicalBinding,
        }),
      );
    }
    return Object.freeze(attachments);
  } catch (cause) {
    if (cause instanceof RuntimeStateError) throw cause;
    throw new RuntimeStateError("notification_batch_input_is_invalid");
  }
}

function snapshotCreateInput(
  inputValue: CreateNotificationBatchInput,
): CreateInputSnapshot {
  const input = snapshotExactDataObject(inputValue, [
    "taskId",
    "batchKey",
    "recipients",
    "content",
    "attachments",
    "now",
  ]);
  if (!canonicalUuid(input.taskId) || !safeText(input.batchKey, 256)) {
    throw new RuntimeStateError("notification_batch_input_is_invalid");
  }
  const content = snapshotStrictIJson(
    input.content,
    "notification_batch_input_is_invalid",
  );
  if (
    content === null ||
    Array.isArray(content) ||
    typeof content !== "object" ||
    Object.keys(content).length === 0 ||
    canonicalStrictIJson(content).length > 65_536
  ) {
    throw new RuntimeStateError("notification_batch_input_is_invalid");
  }
  return Object.freeze({
    taskId: input.taskId,
    batchKey: input.batchKey,
    recipients: snapshotRecipients(input.recipients),
    content,
    attachments: snapshotAttachments(input.attachments),
    now: snapshotDate(input.now),
  });
}

function batchKeyHash(input: CreateInputSnapshot): string {
  return payloadHash(
    snapshotStrictIJson({
      taskId: input.taskId,
      batchKey: input.batchKey,
    }),
  );
}

function actionItemKey(hash: string, recipientOrdinal: number): string {
  return `notification:${hash.slice("sha256:".length)}:${recipientOrdinal}`;
}

function actionPayload(
  recipient: RecipientSnapshot,
  content: StrictIJson,
  attachments: readonly AttachmentSnapshot[],
): StrictIJson {
  return snapshotStrictIJson({
    recipientRef: recipient.recipientRef,
    recipientBinding: recipient.recipientBinding,
    content,
    attachments: attachments.map((attachment) => ({
      resourceRef: attachment.resourceRef,
      kind: attachment.kind,
      resourceBinding: attachment.resourceBinding,
    })),
  });
}

function actionPreview(
  recipientOrdinal: number,
  partCount: number,
): StrictIJson {
  return snapshotStrictIJson({
    recipientOrdinal,
    partCount,
  });
}

function nextOpaqueId(excluded: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = randomUUID();
    if (!excluded.has(candidate)) {
      excluded.add(candidate);
      return candidate;
    }
  }
  throw new RuntimeStateError("notification_batch_persistence_failed");
}

function batchRow(
  database: Database.Database,
  column: "id" | "batch_key_hash",
  value: string,
): BatchRow | undefined {
  return database
    .prepare(
      `SELECT id AS batchId, task_id AS taskId,
              batch_key_hash AS batchKeyHash,
              recipient_count AS recipientCount, state,
              created_at AS createdAt, updated_at AS updatedAt
         FROM notification_batches WHERE ${column}=?`,
    )
    .get(value) as BatchRow | undefined;
}

function partRows(database: Database.Database, batchId: string): PartRow[] {
  return database
    .prepare(
      `SELECT id AS partId, batch_id AS batchId,
              recipient_ordinal AS recipientOrdinal,
              action_id AS actionId, part_ordinal AS partOrdinal,
              part_kind AS partKind, idempotency_key AS idempotencyKey,
              state, attempt_count AS attemptCount,
              lease_owner AS leaseOwner,
              lease_expires_at AS leaseExpiresAt,
              attempt_id AS attemptId,
              request_digest AS requestDigest,
              remote_id AS remoteId,
              result_json AS resultJson, created_at AS createdAt,
              updated_at AS updatedAt
         FROM notification_parts
        WHERE batch_id=?
        ORDER BY recipient_ordinal, part_ordinal`,
    )
    .all(batchId) as PartRow[];
}

function notificationActionPayload(action: ActionRecord): Readonly<{
  recipientRef: string;
  recipientBinding: StrictIJson;
  canonicalBinding: string;
  content: StrictIJson;
  attachments: readonly Readonly<{
    resourceRef: string;
    kind: "image" | "file";
    resourceBinding: StrictIJson;
  }>[];
}> {
  if (
    action.payload === null ||
    Array.isArray(action.payload) ||
    typeof action.payload !== "object"
  ) {
    throw new RuntimeStateError("notification_batch_persistence_failed");
  }
  const payload = action.payload as Readonly<Record<string, StrictIJson>>;
  const keys = Object.keys(payload);
  if (
    keys.length !== 4 ||
    !keys.every(
      (key) =>
        key === "recipientRef" ||
        key === "recipientBinding" ||
        key === "content" ||
        key === "attachments",
    ) ||
    !canonicalUuid(payload.recipientRef)
  ) {
    throw new RuntimeStateError("notification_batch_persistence_failed");
  }
  const binding = payload.recipientBinding;
  if (
    binding === undefined ||
    binding === null ||
    typeof binding === "boolean" ||
    typeof binding === "number" ||
    Array.isArray(binding)
  ) {
    throw new RuntimeStateError("notification_batch_persistence_failed");
  }
  if (
    payload.content === undefined ||
    payload.content === null ||
    Array.isArray(payload.content) ||
    typeof payload.content !== "object" ||
    !Array.isArray(payload.attachments) ||
    payload.attachments.length > 20
  ) {
    throw new RuntimeStateError("notification_batch_persistence_failed");
  }
  const attachmentRefs = new Set<string>();
  const attachments = payload.attachments.map((value) => {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      throw new RuntimeStateError("notification_batch_persistence_failed");
    }
    const record = value as Readonly<Record<string, StrictIJson>>;
    if (
      Object.keys(record).length !== 3 ||
      !canonicalUuid(record.resourceRef) ||
      attachmentRefs.has(record.resourceRef) ||
      (record.kind !== "image" && record.kind !== "file") ||
      record.resourceBinding === null ||
      Array.isArray(record.resourceBinding) ||
      typeof record.resourceBinding !== "object"
    ) {
      throw new RuntimeStateError("notification_batch_persistence_failed");
    }
    attachmentRefs.add(record.resourceRef);
    return Object.freeze({
      resourceRef: record.resourceRef,
      kind: record.kind,
      resourceBinding: record.resourceBinding,
    });
  });
  return Object.freeze({
    recipientRef: payload.recipientRef,
    recipientBinding: binding,
    canonicalBinding: canonicalStrictIJson(binding),
    content: payload.content,
    attachments: Object.freeze(attachments),
  });
}

function validatedPart(
  row: PartRow,
  batchId: string,
  recipientCount: number,
  action: ActionRecord,
  expectedOrdinal: number,
  expectedKind: "content" | "image" | "file",
): NotificationPartRecord {
  if (
    !canonicalUuid(row.partId) ||
    row.batchId !== batchId ||
    !Number.isSafeInteger(row.recipientOrdinal) ||
    (row.recipientOrdinal as number) < 1 ||
    (row.recipientOrdinal as number) > recipientCount ||
    row.actionId !== action.actionId ||
    row.partOrdinal !== expectedOrdinal ||
    row.partKind !== expectedKind ||
    !canonicalUuid(row.idempotencyKey) ||
    typeof row.state !== "string" ||
    !PART_STATES.has(row.state as NotificationPartState) ||
    !Number.isSafeInteger(row.attemptCount) ||
    (row.attemptCount as number) < 0 ||
    (row.attemptCount as number) > 1 ||
    (row.remoteId !== null && !REMOTE_ID.test(String(row.remoteId)))
  ) {
    throw new RuntimeStateError("notification_batch_persistence_failed");
  }
  const state = row.state as NotificationPartState;
  const attemptCount = row.attemptCount as number;
  const lease =
    typeof row.leaseOwner === "string" &&
    safeText(row.leaseOwner, 128) &&
    typeof row.leaseExpiresAt === "string"
      ? canonicalPersistedTimestamp(
          row.leaseExpiresAt,
          "notification_batch_persistence_failed",
        )
      : null;
  const hasNoLease = row.leaseOwner === null && row.leaseExpiresAt === null;
  const hasAttempt =
    canonicalUuid(row.attemptId) && canonicalDigest(row.requestDigest);
  const hasNoAttempt = row.attemptId === null && row.requestDigest === null;
  if (
    (state === "PENDING" &&
      (attemptCount !== 0 ||
        !hasNoLease ||
        !hasNoAttempt ||
        row.resultJson !== null ||
        row.remoteId !== null)) ||
    (state === "CLAIMED" &&
      (attemptCount !== 0 ||
        lease === null ||
        !hasNoAttempt ||
        row.resultJson !== null ||
        row.remoteId !== null)) ||
    (state === "DISPATCHING" &&
      (attemptCount !== 1 ||
        lease === null ||
        !hasAttempt ||
        row.resultJson !== null ||
        row.remoteId !== null)) ||
    ((state === "SUCCEEDED" || state === "FAILED") &&
      (attemptCount !== 1 || !hasNoLease || !hasAttempt)) ||
    (state === "UNKNOWN" &&
      ((attemptCount !== 0 && attemptCount !== 1) ||
        !hasNoLease ||
        (attemptCount === 0 ? !hasNoAttempt : !hasAttempt)))
  ) {
    throw new RuntimeStateError("notification_batch_persistence_failed");
  }
  const createdAt = canonicalPersistedTimestamp(
    row.createdAt,
    "notification_batch_persistence_failed",
  );
  const updatedAt = canonicalPersistedTimestamp(
    row.updatedAt,
    "notification_batch_persistence_failed",
  );
  if (updatedAt.milliseconds < createdAt.milliseconds) {
    throw new RuntimeStateError("notification_batch_persistence_failed");
  }
  let result: ActionResult | null = null;
  if (state === "SUCCEEDED" || state === "FAILED" || state === "UNKNOWN") {
    if (typeof row.resultJson !== "string") {
      throw new RuntimeStateError("notification_batch_persistence_failed");
    }
    try {
      const parsed = snapshotStrictIJson(
        JSON.parse(row.resultJson) as unknown,
        "notification_batch_persistence_failed",
      );
      const parsedResult =
        parsed !== null && !Array.isArray(parsed) && typeof parsed === "object"
          ? (parsed as Readonly<Record<string, StrictIJson>>)
          : null;
      if (
        parsedResult === null ||
        Object.keys(parsedResult).some(
          (key) => key !== "outcome" && key !== "remoteId",
        ) ||
        (parsedResult.outcome !== "SUCCEEDED" &&
          parsedResult.outcome !== "FAILED_DEFINITE" &&
          parsedResult.outcome !== "UNKNOWN") ||
        (state === "SUCCEEDED" && parsedResult.outcome !== "SUCCEEDED") ||
        (state === "FAILED" && parsedResult.outcome !== "FAILED_DEFINITE") ||
        (state === "UNKNOWN" && parsedResult.outcome !== "UNKNOWN") ||
        (parsedResult.outcome === "SUCCEEDED"
          ? typeof parsedResult.remoteId !== "string" ||
            !REMOTE_ID.test(parsedResult.remoteId) ||
            row.remoteId !== parsedResult.remoteId
          : Object.hasOwn(parsedResult, "remoteId") || row.remoteId !== null)
      ) {
        throw new Error("invalid part result");
      }
      result = parsedResult as ActionResult;
    } catch (cause) {
      if (cause instanceof RuntimeStateError) throw cause;
      throw new RuntimeStateError(
        "notification_batch_persistence_failed",
        cause,
      );
    }
  }
  if (
    ((state === "PENDING" || state === "CLAIMED" || state === "DISPATCHING") &&
      row.resultJson !== null) ||
    ((state === "SUCCEEDED" || state === "FAILED" || state === "UNKNOWN") &&
      result === null)
  ) {
    throw new RuntimeStateError("notification_batch_persistence_failed");
  }
  return Object.freeze({
    partId: row.partId,
    recipientOrdinal: row.recipientOrdinal as number,
    actionId: action.actionId,
    partOrdinal: expectedOrdinal,
    partKind: expectedKind,
    idempotencyKey: row.idempotencyKey,
    state,
    attemptCount,
    remoteId: row.remoteId as string | null,
    result,
    createdAt: createdAt.iso,
    updatedAt: updatedAt.iso,
  });
}

function summaryFor(batch: NotificationBatchRecord): NotificationBatchSummary {
  const counts = {
    pending: 0,
    dispatching: 0,
    succeeded: 0,
    failed: 0,
    unknown: 0,
  };
  for (const { part } of batch.deliveries) {
    if (part.state === "PENDING") counts.pending += 1;
    if (part.state === "CLAIMED" || part.state === "DISPATCHING") {
      counts.dispatching += 1;
    }
    if (part.state === "SUCCEEDED") counts.succeeded += 1;
    if (part.state === "FAILED") counts.failed += 1;
    if (part.state === "UNKNOWN") counts.unknown += 1;
  }
  return Object.freeze({
    batchId: batch.batchId,
    state: batch.state,
    total: batch.deliveries.length,
    ...counts,
  });
}

function effectiveSummaryFor(loaded: LoadedBatch): NotificationBatchSummary {
  const counts = {
    pending: 0,
    dispatching: 0,
    succeeded: 0,
    failed: 0,
    unknown: 0,
  };
  for (const delivery of loaded.batch.deliveries) {
    let state = delivery.part.state;
    if (state === "UNKNOWN") {
      const action = loaded.actions.get(delivery.actionId);
      if (action === undefined) {
        throw new RuntimeStateError("notification_batch_persistence_failed");
      }
      if (action.state === "RECONCILED") {
        state =
          action.reconcileOutcome === "SUCCEEDED"
            ? "SUCCEEDED"
            : action.reconcileOutcome === "FAILED"
              ? "FAILED"
              : "UNKNOWN";
      }
    }
    if (state === "PENDING") counts.pending += 1;
    if (state === "CLAIMED" || state === "DISPATCHING") {
      counts.dispatching += 1;
    }
    if (state === "SUCCEEDED") counts.succeeded += 1;
    if (state === "FAILED") counts.failed += 1;
    if (state === "UNKNOWN") counts.unknown += 1;
  }
  return Object.freeze({
    batchId: loaded.batch.batchId,
    state: loaded.batch.state,
    total: loaded.batch.deliveries.length,
    ...counts,
  });
}

function loadBatch(
  database: Database.Database,
  row: BatchRow | undefined,
): LoadedBatch {
  if (
    row === undefined ||
    !canonicalUuid(row.batchId) ||
    !canonicalUuid(row.taskId) ||
    !canonicalDigest(row.batchKeyHash) ||
    !Number.isSafeInteger(row.recipientCount) ||
    (row.recipientCount as number) < 1 ||
    (row.recipientCount as number) > 20 ||
    typeof row.state !== "string" ||
    !BATCH_STATES.has(row.state as NotificationBatchState)
  ) {
    throw new RuntimeStateError("notification_batch_persistence_failed");
  }
  const recipientCount = row.recipientCount as number;
  const state = row.state as NotificationBatchState;
  const createdAt = canonicalPersistedTimestamp(
    row.createdAt,
    "notification_batch_persistence_failed",
  );
  const updatedAt = canonicalPersistedTimestamp(
    row.updatedAt,
    "notification_batch_persistence_failed",
  );
  if (updatedAt.milliseconds < createdAt.milliseconds) {
    throw new RuntimeStateError("notification_batch_persistence_failed");
  }
  const rows = partRows(database, row.batchId);
  const actions = new Map<string, ActionRecord>();
  const recipientRefs = new Set<string>();
  const bindings = new Set<string>();
  const partIds = new Set<string>();
  const partIdempotencyKeys = new Set<string>();
  const deliveries: NotificationDeliveryRecord[] = [];
  for (
    let recipientOrdinal = 1;
    recipientOrdinal <= recipientCount;
    recipientOrdinal += 1
  ) {
    const recipientRows = rows.filter(
      (candidate) => candidate.recipientOrdinal === recipientOrdinal,
    );
    const firstRow = recipientRows[0];
    if (
      firstRow === undefined ||
      !canonicalUuid(firstRow.actionId) ||
      actions.has(firstRow.actionId) ||
      recipientRows.some(
        (candidate) => candidate.actionId !== firstRow.actionId,
      )
    ) {
      throw new RuntimeStateError("notification_batch_persistence_failed");
    }
    const action = getAction(database, {
      actionId: firstRow.actionId,
      version: 1,
    });
    if (
      action === null ||
      action.taskId !== row.taskId ||
      action.capability !== "notification.send.direct" ||
      action.identity !== "bot" ||
      action.approvalMode !== "president_instruction"
    ) {
      throw new RuntimeStateError("notification_batch_persistence_failed");
    }
    const payload = notificationActionPayload(action);
    if (
      recipientRefs.has(payload.recipientRef) ||
      bindings.has(payload.canonicalBinding)
    ) {
      throw new RuntimeStateError("notification_batch_persistence_failed");
    }
    const authorization = database
      .prepare(
        `SELECT item_key AS itemKey
           FROM instruction_authorizations
          WHERE action_id=? AND action_version=1`,
      )
      .get(action.actionId) as Readonly<{ itemKey: unknown }> | undefined;
    if (
      authorization?.itemKey !==
      actionItemKey(row.batchKeyHash, recipientOrdinal)
    ) {
      throw new RuntimeStateError("notification_batch_persistence_failed");
    }
    const expectedKinds = [
      "content" as const,
      ...payload.attachments.map((attachment) => attachment.kind),
    ];
    if (recipientRows.length !== expectedKinds.length) {
      throw new RuntimeStateError("notification_batch_persistence_failed");
    }
    actions.set(action.actionId, action);
    recipientRefs.add(payload.recipientRef);
    bindings.add(payload.canonicalBinding);
    const recipientParts: NotificationPartRecord[] = [];
    for (const [index, partRow] of recipientRows.entries()) {
      const expectedOrdinal = index + 1;
      const expectedKind = expectedKinds[index];
      if (
        expectedKind === undefined ||
        partRow.partOrdinal !== expectedOrdinal
      ) {
        throw new RuntimeStateError("notification_batch_persistence_failed");
      }
      const part = validatedPart(
        partRow,
        row.batchId,
        recipientCount,
        action,
        expectedOrdinal,
        expectedKind,
      );
      if (
        partIds.has(part.partId) ||
        partIdempotencyKeys.has(part.idempotencyKey) ||
        part.idempotencyKey === part.actionId
      ) {
        throw new RuntimeStateError("notification_batch_persistence_failed");
      }
      partIds.add(part.partId);
      partIdempotencyKeys.add(part.idempotencyKey);
      recipientParts.push(part);
      deliveries.push(
        Object.freeze({
          recipientOrdinal,
          actionId: action.actionId,
          part,
        }),
      );
    }
    const nonterminal = recipientParts.some(
      (part) =>
        part.state === "PENDING" ||
        part.state === "CLAIMED" ||
        part.state === "DISPATCHING",
    );
    const aggregateState = recipientParts.some(
      (part) => part.state === "UNKNOWN",
    )
      ? "UNKNOWN"
      : recipientParts.some((part) => part.state === "FAILED")
        ? "FAILED"
        : "SUCCEEDED";
    if (
      (nonterminal && action.state !== "APPROVED") ||
      (!nonterminal &&
        action.state !== aggregateState &&
        !(aggregateState === "UNKNOWN" && action.state === "RECONCILED"))
    ) {
      throw new RuntimeStateError("notification_batch_persistence_failed");
    }
  }
  if (deliveries.length !== rows.length || actions.size !== recipientCount) {
    throw new RuntimeStateError("notification_batch_persistence_failed");
  }
  const batch = Object.freeze({
    batchId: row.batchId,
    taskId: row.taskId,
    recipientCount,
    state,
    createdAt: createdAt.iso,
    updatedAt: updatedAt.iso,
    deliveries: Object.freeze(deliveries),
  });
  const summary = summaryFor(batch);
  const calculatedTerminalState =
    summary.unknown > 0
      ? "UNKNOWN"
      : summary.failed > 0
        ? "FAILED"
        : "SUCCEEDED";
  if (
    (state === "PREPARED" &&
      (summary.pending !== summary.total ||
        [...actions.values()].some((action) => action.state !== "APPROVED"))) ||
    (state === "DISPATCHING" &&
      summary.pending === 0 &&
      summary.dispatching === 0) ||
    ((state === "SUCCEEDED" || state === "FAILED" || state === "UNKNOWN") &&
      (summary.pending !== 0 ||
        summary.dispatching !== 0 ||
        state !== calculatedTerminalState))
  ) {
    throw new RuntimeStateError("notification_batch_persistence_failed");
  }
  return Object.freeze({
    batch,
    batchKeyHash: row.batchKeyHash,
    actions: actions as ReadonlyMap<string, ActionRecord>,
  });
}

function replayMatches(
  loaded: LoadedBatch,
  input: CreateInputSnapshot,
): boolean {
  if (
    loaded.batch.taskId !== input.taskId ||
    loaded.batch.recipientCount !== input.recipients.length
  ) {
    return false;
  }
  return input.recipients.every((recipient, index) => {
    const delivery = loaded.batch.deliveries.find(
      (candidate) =>
        candidate.recipientOrdinal === index + 1 &&
        candidate.part.partOrdinal === 1,
    );
    const action =
      delivery === undefined
        ? undefined
        : loaded.actions.get(delivery.actionId);
    return (
      delivery !== undefined &&
      action !== undefined &&
      action.payloadHash ===
        payloadHash(actionPayload(recipient, input.content, input.attachments))
    );
  });
}

function persistenceFailure(cause: unknown): never {
  if (
    cause instanceof RuntimeStateError &&
    (cause.detail === "notification_batch_replay_conflict" ||
      cause.detail === "notification_batch_not_found" ||
      cause.detail === "notification_batch_persistence_failed")
  ) {
    throw cause;
  }
  throw new RuntimeStateError("notification_batch_persistence_failed", cause);
}

export function createNotificationBatch(
  database: Database.Database,
  instanceId: string,
  inputValue: CreateNotificationBatchInput,
): CreateNotificationBatchResult {
  const input = snapshotCreateInput(inputValue);
  const keyHash = batchKeyHash(input);
  try {
    return database
      .transaction(() => {
        const existingRow = batchRow(database, "batch_key_hash", keyHash);
        if (existingRow !== undefined) {
          const existing = loadBatch(database, existingRow);
          if (!replayMatches(existing, input)) {
            throw new RuntimeStateError("notification_batch_replay_conflict");
          }
          return Object.freeze({ batch: existing.batch, created: false });
        }
        const excludedIds = new Set<string>([input.taskId]);
        const batchId = nextOpaqueId(excludedIds);
        const inserted = database
          .prepare(
            `INSERT INTO notification_batches(
               id, task_id, batch_key_hash, recipient_count, state,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'PREPARED', ?, ?)`,
          )
          .run(
            batchId,
            input.taskId,
            keyHash,
            input.recipients.length,
            input.now.iso,
            input.now.iso,
          );
        if (inserted.changes !== 1) {
          throw new RuntimeStateError("notification_batch_persistence_failed");
        }
        for (const [index, recipient] of input.recipients.entries()) {
          const recipientOrdinal = index + 1;
          const authorized = authorizePresidentInstructionAction(
            database,
            instanceId,
            {
              taskId: input.taskId,
              capability: "notification.send.direct",
              identity: "bot",
              itemKey: actionItemKey(keyHash, recipientOrdinal),
              payload: actionPayload(
                recipient,
                input.content,
                input.attachments,
              ),
              preview: actionPreview(
                recipientOrdinal,
                input.attachments.length + 1,
              ),
              now: new Date(input.now.milliseconds),
            },
          );
          if (!authorized.created) {
            throw new RuntimeStateError(
              "notification_batch_persistence_failed",
            );
          }
          excludedIds.add(authorized.action.actionId);
          const partKinds = [
            "content" as const,
            ...input.attachments.map((attachment) => attachment.kind),
          ];
          for (const [partIndex, partKind] of partKinds.entries()) {
            const partId = nextOpaqueId(excludedIds);
            const idempotencyKey = nextOpaqueId(excludedIds);
            const partInserted = database
              .prepare(
                `INSERT INTO notification_parts(
                   id, batch_id, recipient_ordinal, action_id, part_ordinal,
                   part_kind, idempotency_key, state, attempt_count,
                   created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)`,
              )
              .run(
                partId,
                batchId,
                recipientOrdinal,
                authorized.action.actionId,
                partIndex + 1,
                partKind,
                idempotencyKey,
                input.now.iso,
                input.now.iso,
              );
            if (partInserted.changes !== 1) {
              throw new RuntimeStateError(
                "notification_batch_persistence_failed",
              );
            }
          }
        }
        const loaded = loadBatch(database, batchRow(database, "id", batchId));
        if (!replayMatches(loaded, input)) {
          throw new RuntimeStateError("notification_batch_persistence_failed");
        }
        return Object.freeze({ batch: loaded.batch, created: true });
      })
      .immediate();
  } catch (cause) {
    return persistenceFailure(cause);
  }
}

type ClaimInputSnapshot = Readonly<{
  batchId: string;
  owner: string;
  now: ClockSnapshot;
  ttlMs: number;
}>;

function snapshotClaimInput(
  inputValue: ClaimNextNotificationDeliveryInput,
): ClaimInputSnapshot {
  const input = snapshotExactDataObject(inputValue, [
    "batchId",
    "owner",
    "now",
    "ttlMs",
  ]);
  if (
    !canonicalUuid(input.batchId) ||
    !safeText(input.owner, 128) ||
    !Number.isSafeInteger(input.ttlMs) ||
    (input.ttlMs as number) <= 0 ||
    (input.ttlMs as number) > 86_400_000
  ) {
    throw new RuntimeStateError("notification_batch_input_is_invalid");
  }
  return Object.freeze({
    batchId: input.batchId,
    owner: input.owner,
    now: snapshotDate(input.now),
    ttlMs: input.ttlMs as number,
  });
}

export function claimNextNotificationDelivery(
  database: Database.Database,
  instanceId: string,
  inputValue: ClaimNextNotificationDeliveryInput,
): NotificationDeliveryClaim | null {
  const input = snapshotClaimInput(inputValue);
  try {
    return database
      .transaction(() => {
        let loaded = loadBatch(
          database,
          batchRow(database, "id", input.batchId),
        );
        if (
          loaded.batch.state === "SUCCEEDED" ||
          loaded.batch.state === "FAILED" ||
          loaded.batch.state === "UNKNOWN"
        ) {
          return null;
        }
        const expired = database
          .prepare(
            `UPDATE notification_parts
                SET state='UNKNOWN',
                    lease_owner=NULL, lease_expires_at=NULL,
                    result_json=?, updated_at=?
              WHERE batch_id=?
                AND state IN ('CLAIMED','DISPATCHING')
                AND lease_expires_at<=?`,
          )
          .run(
            UNKNOWN_PART_RESULT_JSON,
            input.now.iso,
            input.batchId,
            input.now.iso,
          ).changes;
        if (expired > 0) {
          finalizeCompletedNotificationActions(
            database,
            instanceId,
            input.batchId,
            input.owner,
            input.now,
          );
          finalizeBatchIfComplete(database, input.batchId, input.now);
          loaded = loadBatch(database, batchRow(database, "id", input.batchId));
          if (
            loaded.batch.state === "SUCCEEDED" ||
            loaded.batch.state === "FAILED" ||
            loaded.batch.state === "UNKNOWN"
          ) {
            return null;
          }
        }
        const delivery = loaded.batch.deliveries.find(
          ({ part }) =>
            part.state === "PENDING" ||
            part.state === "CLAIMED" ||
            part.state === "DISPATCHING",
        );
        if (delivery === undefined || delivery.part.state !== "PENDING") {
          return null;
        }
        const action = getExecutableApprovedActionForNotification(
          database,
          instanceId,
          delivery.actionId,
          input.owner,
          new Date(input.now.milliseconds),
        );
        if (action === null) return null;
        const leaseMilliseconds = input.now.milliseconds + input.ttlMs;
        if (!Number.isSafeInteger(leaseMilliseconds)) {
          throw new RuntimeStateError("notification_batch_input_is_invalid");
        }
        const leaseExpiresAt = new Date(leaseMilliseconds).toISOString();
        const partClaimed = database
          .prepare(
            `UPDATE notification_parts
                SET state='CLAIMED', lease_owner=?, lease_expires_at=?,
                    updated_at=?
              WHERE id=? AND batch_id=? AND action_id=?
                AND state='PENDING' AND attempt_count=0
                AND lease_owner IS NULL AND lease_expires_at IS NULL`,
          )
          .run(
            input.owner,
            leaseExpiresAt,
            input.now.iso,
            delivery.part.partId,
            input.batchId,
            delivery.actionId,
          ).changes;
        if (partClaimed !== 1) return null;
        if (loaded.batch.state === "PREPARED") {
          const changed = database
            .prepare(
              `UPDATE notification_batches
                  SET state='DISPATCHING', updated_at=?
                WHERE id=? AND state='PREPARED'`,
            )
            .run(input.now.iso, loaded.batch.batchId).changes;
          if (changed !== 1) {
            throw new RuntimeStateError(
              "notification_batch_persistence_failed",
            );
          }
        }
        const refreshed = loadBatch(
          database,
          batchRow(database, "id", input.batchId),
        );
        const refreshedDelivery = refreshed.batch.deliveries.find(
          ({ part }) => part.partId === delivery.part.partId,
        );
        if (refreshedDelivery === undefined) {
          throw new RuntimeStateError("notification_batch_persistence_failed");
        }
        return Object.freeze({
          batchId: refreshed.batch.batchId,
          recipientOrdinal: refreshedDelivery.recipientOrdinal,
          action,
          leaseExpiresAt,
          part: refreshedDelivery.part,
        });
      })
      .immediate();
  } catch (cause) {
    return persistenceFailure(cause);
  }
}

type DispatchInputSnapshot = Readonly<{
  batchId: string;
  partId: string;
  actionId: string;
  owner: string;
  leaseExpiresAt: string;
  now: ClockSnapshot;
  attemptId: string;
  requestDigest: string;
}>;

function snapshotDispatchInput(
  inputValue: MarkNotificationDeliveryDispatchingInput,
): DispatchInputSnapshot {
  const input = snapshotExactDataObject(inputValue, [
    "batchId",
    "partId",
    "actionId",
    "owner",
    "leaseExpiresAt",
    "now",
    "attemptId",
    "requestDigest",
  ]);
  if (
    !canonicalUuid(input.batchId) ||
    !canonicalUuid(input.partId) ||
    !canonicalUuid(input.actionId) ||
    !safeText(input.owner, 128) ||
    typeof input.leaseExpiresAt !== "string" ||
    !canonicalUuid(input.attemptId) ||
    !canonicalDigest(input.requestDigest)
  ) {
    throw new RuntimeStateError("notification_batch_input_is_invalid");
  }
  canonicalPersistedTimestamp(
    input.leaseExpiresAt,
    "notification_batch_input_is_invalid",
  );
  return Object.freeze({
    batchId: input.batchId,
    partId: input.partId,
    actionId: input.actionId,
    owner: input.owner,
    leaseExpiresAt: input.leaseExpiresAt,
    now: snapshotDate(input.now),
    attemptId: input.attemptId,
    requestDigest: input.requestDigest,
  });
}

export function markNotificationDeliveryDispatching(
  database: Database.Database,
  instanceId: string,
  inputValue: MarkNotificationDeliveryDispatchingInput,
): NotificationDeliveryDispatching | null {
  const input = snapshotDispatchInput(inputValue);
  try {
    return database
      .transaction(() => {
        const loaded = loadBatch(
          database,
          batchRow(database, "id", input.batchId),
        );
        const delivery = loaded.batch.deliveries.find(
          ({ part }) => part.partId === input.partId,
        );
        if (
          delivery === undefined ||
          delivery.actionId !== input.actionId ||
          delivery.part.state !== "CLAIMED"
        ) {
          return null;
        }
        const action = getExecutableApprovedActionForNotification(
          database,
          instanceId,
          input.actionId,
          input.owner,
          new Date(input.now.milliseconds),
        );
        if (action === null) return null;
        const changed = database
          .prepare(
            `UPDATE notification_parts
                SET state='DISPATCHING', attempt_count=1,
                    attempt_id=?, request_digest=?, updated_at=?
              WHERE id=? AND batch_id=? AND action_id=?
                AND state='CLAIMED' AND attempt_count=0
                AND lease_owner=? AND lease_expires_at=?`,
          )
          .run(
            input.attemptId,
            input.requestDigest,
            input.now.iso,
            input.partId,
            input.batchId,
            input.actionId,
            input.owner,
            input.leaseExpiresAt,
          ).changes;
        if (changed !== 1) {
          throw new RuntimeStateError("notification_batch_persistence_failed");
        }
        const refreshed = loadBatch(
          database,
          batchRow(database, "id", input.batchId),
        );
        const part = refreshed.batch.deliveries.find(
          (candidate) => candidate.part.partId === input.partId,
        )?.part;
        if (part === undefined) {
          throw new RuntimeStateError("notification_batch_persistence_failed");
        }
        return Object.freeze({ action, part });
      })
      .immediate();
  } catch (cause) {
    return persistenceFailure(cause);
  }
}

type FinishInputSnapshot = Readonly<{
  batchId: string;
  partId: string;
  actionId: string;
  owner: string;
  leaseExpiresAt: string;
  now: ClockSnapshot;
  attemptId: string;
  outcome: "SUCCEEDED" | "FAILED_DEFINITE" | "UNKNOWN";
  remoteId?: string;
}>;

function snapshotFinishInput(
  inputValue: FinishNotificationDeliveryInput,
): FinishInputSnapshot {
  const input = snapshotExactDataObject(
    inputValue,
    [
      "batchId",
      "partId",
      "actionId",
      "owner",
      "leaseExpiresAt",
      "now",
      "attemptId",
      "outcome",
    ],
    ["remoteId"],
  );
  if (
    !canonicalUuid(input.batchId) ||
    !canonicalUuid(input.partId) ||
    !canonicalUuid(input.actionId) ||
    !safeText(input.owner, 128) ||
    typeof input.leaseExpiresAt !== "string" ||
    !canonicalUuid(input.attemptId) ||
    (input.outcome !== "SUCCEEDED" &&
      input.outcome !== "FAILED_DEFINITE" &&
      input.outcome !== "UNKNOWN") ||
    (input.remoteId !== undefined &&
      (input.outcome !== "SUCCEEDED" ||
        typeof input.remoteId !== "string" ||
        !REMOTE_ID.test(input.remoteId)))
  ) {
    throw new RuntimeStateError("notification_batch_input_is_invalid");
  }
  canonicalPersistedTimestamp(
    input.leaseExpiresAt,
    "notification_batch_input_is_invalid",
  );
  return Object.freeze({
    batchId: input.batchId,
    partId: input.partId,
    actionId: input.actionId,
    owner: input.owner,
    leaseExpiresAt: input.leaseExpiresAt,
    now: snapshotDate(input.now),
    attemptId: input.attemptId,
    outcome: input.outcome,
    ...(typeof input.remoteId === "string" ? { remoteId: input.remoteId } : {}),
  });
}

function terminalPartState(
  outcome: "SUCCEEDED" | "FAILED_DEFINITE" | "UNKNOWN",
): "SUCCEEDED" | "FAILED" | "UNKNOWN" {
  if (outcome === "SUCCEEDED") return "SUCCEEDED";
  if (outcome === "FAILED_DEFINITE") return "FAILED";
  return "UNKNOWN";
}

function finalizeCompletedNotificationActions(
  database: Database.Database,
  instanceId: string,
  batchId: string,
  owner: string,
  now: ClockSnapshot,
): void {
  const rows = database
    .prepare(
      `SELECT action_id AS actionId,
              SUM(CASE WHEN state IN ('PENDING','CLAIMED','DISPATCHING')
                       THEN 1 ELSE 0 END) AS nonterminal,
              SUM(CASE WHEN state='FAILED' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN state='UNKNOWN' THEN 1 ELSE 0 END) AS unknown
         FROM notification_parts
        WHERE batch_id=?
        GROUP BY action_id`,
    )
    .all(batchId) as Readonly<
    Array<{
      actionId: unknown;
      nonterminal: unknown;
      failed: unknown;
      unknown: unknown;
    }>
  >;
  for (const row of rows) {
    if (
      !canonicalUuid(row.actionId) ||
      !Number.isSafeInteger(row.nonterminal) ||
      !Number.isSafeInteger(row.failed) ||
      !Number.isSafeInteger(row.unknown)
    ) {
      throw new RuntimeStateError("notification_batch_persistence_failed");
    }
    if ((row.nonterminal as number) > 0) continue;
    const current = getAction(database, { actionId: row.actionId, version: 1 });
    if (current === null) {
      throw new RuntimeStateError("notification_batch_persistence_failed");
    }
    if (
      current.state === "SUCCEEDED" ||
      current.state === "FAILED" ||
      current.state === "UNKNOWN" ||
      current.state === "RECONCILED"
    ) {
      continue;
    }
    if (current.state !== "APPROVED") {
      throw new RuntimeStateError("notification_batch_persistence_failed");
    }
    const claimed = claimApprovedAction(database, instanceId, {
      actionId: current.actionId,
      version: 1,
      owner,
      now: new Date(now.milliseconds),
      ttlMs: 60_000,
    });
    if (claimed === null) {
      throw new RuntimeStateError("notification_batch_persistence_failed");
    }
    const attemptId = randomUUID();
    const requestDigest = payloadHash(
      snapshotStrictIJson({
        batchId,
        actionId: current.actionId,
        kind: "notification_parts_aggregate",
      }),
    );
    const dispatching = markDispatching(database, instanceId, {
      actionId: current.actionId,
      version: 1,
      owner,
      leaseExpiresAt: claimed.leaseExpiresAt,
      now: new Date(now.milliseconds),
      attemptId,
      requestDigest,
    });
    if (dispatching === null) {
      throw new RuntimeStateError("notification_batch_persistence_failed");
    }
    const outcome =
      (row.unknown as number) > 0
        ? "UNKNOWN"
        : (row.failed as number) > 0
          ? "FAILED_DEFINITE"
          : "SUCCEEDED";
    const finished = finishAction(database, instanceId, {
      actionId: current.actionId,
      version: 1,
      owner,
      leaseExpiresAt: claimed.leaseExpiresAt,
      now: new Date(now.milliseconds),
      attemptId,
      outcome,
    });
    if (finished === null) {
      throw new RuntimeStateError("notification_batch_persistence_failed");
    }
  }
}

function finalizeBatchIfComplete(
  database: Database.Database,
  batchId: string,
  now: ClockSnapshot,
): void {
  const counts = database
    .prepare(
      `SELECT
         SUM(CASE WHEN state='PENDING' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN state IN ('CLAIMED','DISPATCHING')
                  THEN 1 ELSE 0 END) AS dispatching,
         SUM(CASE WHEN state='FAILED' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN state='UNKNOWN' THEN 1 ELSE 0 END) AS unknown
       FROM notification_parts WHERE batch_id=?`,
    )
    .get(batchId) as
    | Readonly<{
        pending: unknown;
        dispatching: unknown;
        failed: unknown;
        unknown: unknown;
      }>
    | undefined;
  if (
    counts === undefined ||
    !Number.isSafeInteger(counts.pending) ||
    !Number.isSafeInteger(counts.dispatching) ||
    !Number.isSafeInteger(counts.failed) ||
    !Number.isSafeInteger(counts.unknown)
  ) {
    throw new RuntimeStateError("notification_batch_persistence_failed");
  }
  if ((counts.pending as number) > 0 || (counts.dispatching as number) > 0) {
    return;
  }
  const finalState =
    (counts.unknown as number) > 0
      ? "UNKNOWN"
      : (counts.failed as number) > 0
        ? "FAILED"
        : "SUCCEEDED";
  const changed = database
    .prepare(
      `UPDATE notification_batches
          SET state=?, updated_at=?
        WHERE id=? AND state='DISPATCHING'`,
    )
    .run(finalState, now.iso, batchId).changes;
  if (changed !== 1) {
    throw new RuntimeStateError("notification_batch_persistence_failed");
  }
}

export function finishNotificationDelivery(
  database: Database.Database,
  instanceId: string,
  inputValue: FinishNotificationDeliveryInput,
): FinishedNotificationDelivery | null {
  const input = snapshotFinishInput(inputValue);
  try {
    return database
      .transaction(() => {
        const loaded = loadBatch(
          database,
          batchRow(database, "id", input.batchId),
        );
        const delivery = loaded.batch.deliveries.find(
          ({ part }) => part.partId === input.partId,
        );
        if (
          delivery === undefined ||
          delivery.actionId !== input.actionId ||
          delivery.part.state !== "DISPATCHING"
        ) {
          return null;
        }
        const action = getExecutableApprovedActionForNotification(
          database,
          instanceId,
          input.actionId,
          input.owner,
          new Date(input.now.milliseconds),
        );
        if (action === null) return null;
        const partState = terminalPartState(input.outcome);
        const result = Object.freeze({
          outcome: input.outcome,
          ...(input.remoteId === undefined ? {} : { remoteId: input.remoteId }),
        });
        const resultJson = canonicalStrictIJson(result);
        const changed = database
          .prepare(
            `UPDATE notification_parts
                SET state=?, lease_owner=NULL, lease_expires_at=NULL,
                    remote_id=?, result_json=?, updated_at=?
              WHERE id=? AND batch_id=? AND action_id=?
                AND state='DISPATCHING' AND attempt_count=1
                AND lease_owner=? AND lease_expires_at=?
                AND attempt_id=?`,
          )
          .run(
            partState,
            input.remoteId ?? null,
            resultJson,
            input.now.iso,
            input.partId,
            input.batchId,
            input.actionId,
            input.owner,
            input.leaseExpiresAt,
            input.attemptId,
          ).changes;
        if (changed !== 1) {
          throw new RuntimeStateError("notification_batch_persistence_failed");
        }
        finalizeCompletedNotificationActions(
          database,
          instanceId,
          input.batchId,
          input.owner,
          input.now,
        );
        finalizeBatchIfComplete(database, input.batchId, input.now);
        const refreshed = loadBatch(
          database,
          batchRow(database, "id", input.batchId),
        );
        const part = refreshed.batch.deliveries.find(
          (candidate) => candidate.part.partId === input.partId,
        )?.part;
        if (part === undefined) {
          throw new RuntimeStateError("notification_batch_persistence_failed");
        }
        const refreshedAction = refreshed.actions.get(input.actionId);
        if (refreshedAction === undefined) {
          throw new RuntimeStateError("notification_batch_persistence_failed");
        }
        return Object.freeze({
          action: refreshedAction,
          part,
          summary: effectiveSummaryFor(refreshed),
        });
      })
      .immediate();
  } catch (cause) {
    return persistenceFailure(cause);
  }
}

export function getNotificationBatchSummary(
  database: Database.Database,
  batchIdValue: string,
): NotificationBatchSummary {
  if (!canonicalUuid(batchIdValue)) {
    throw new RuntimeStateError("notification_batch_input_is_invalid");
  }
  try {
    const row = batchRow(database, "id", batchIdValue);
    if (row === undefined) {
      throw new RuntimeStateError("notification_batch_not_found");
    }
    return effectiveSummaryFor(loadBatch(database, row));
  } catch (cause) {
    return persistenceFailure(cause);
  }
}
