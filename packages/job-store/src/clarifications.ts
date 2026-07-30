import { randomUUID, timingSafeEqual } from "node:crypto";
import { types as utilTypes } from "node:util";

import type Database from "better-sqlite3";

import {
  canonicalStrictIJson,
  payloadHash,
  snapshotStrictIJson,
  type StrictIJson,
} from "./canonical-json.js";
import { hasLiveBridgeLease } from "./leases.js";
import {
  RuntimeStateError,
  type ClarificationGroup,
  type ClarificationKind,
  type ClarificationSelection,
  type ClarificationValueValidator,
  type WriteClarificationGroupForTaskInput,
} from "./types.js";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RAW_SHA256 = /^[0-9a-f]{64}$/;
const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/;
const LONE_SURROGATE =
  /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u;
const CLARIFICATION_TTL_MS = 24 * 60 * 60 * 1_000;
const KINDS = new Set<ClarificationKind>(["contact", "base", "table"]);
const ACCEPT_CLARIFICATION_VALUE: ClarificationValueValidator = () => undefined;

type ClockSnapshot = Readonly<{ iso: string; milliseconds: number }>;

type TaskContextRow = Readonly<{
  taskId: unknown;
  state: unknown;
  leaseOwner: unknown;
  leaseExpiresAt: unknown;
  codexSessionId: unknown;
  taskCreatedAt: unknown;
  inboundEventId: unknown;
  inboundReceivedAt: unknown;
  appId: unknown;
  tenantKey: unknown;
  principalHash: unknown;
  chatHash: unknown;
}>;

type TaskContext = Readonly<{
  taskId: string;
  state: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  codexSessionId: string | null;
  taskCreatedAt: ClockSnapshot;
  inboundEventId: string;
  inboundReceivedAt: ClockSnapshot;
  appId: string;
  tenantKey: string;
  principalHash: string;
  chatHash: string;
}>;

type ClarificationOptionRow = Readonly<{
  groupId: unknown;
  groupLabel: unknown;
  optionOrdinal: unknown;
  optionRef: unknown;
  kind: unknown;
  sourceTaskId: unknown;
  principalHash: unknown;
  chatHash: unknown;
  valueJson: unknown;
  displayLabel: unknown;
  expiresAt: unknown;
  persistedPayloadHash: unknown;
  createdAt: unknown;
  sourceTaskCreatedAt: unknown;
  sourceInboundEventId: unknown;
  sourceInboundReceivedAt: unknown;
  sourceAppId: unknown;
  sourceTenantKey: unknown;
  sourcePrincipalHash: unknown;
  sourceChatHash: unknown;
  selectionCount: unknown;
}>;

type ValidatedOption = Readonly<{
  groupId: string;
  groupLabel: string;
  optionOrdinal: number;
  optionRef: string;
  kind: ClarificationKind;
  sourceTaskId: string;
  principalHash: string;
  chatHash: string;
  value: StrictIJson;
  displayLabel: string;
  expiresAt: ClockSnapshot;
  createdAt: ClockSnapshot;
  sourceTaskCreatedAt: ClockSnapshot;
  sourceInboundEventId: string;
  sourceInboundReceivedAt: ClockSnapshot;
  sourceAppId: string;
  sourceTenantKey: string;
  selectionCount: number;
}>;

type WriteOptionSnapshot = Readonly<{
  value: StrictIJson;
  displayLabel: string;
}>;

type WriteInputSnapshot = Readonly<{
  taskId: string;
  kind: ClarificationKind;
  groupLabel: string;
  options: readonly WriteOptionSnapshot[];
  now: ClockSnapshot;
}>;

const OPTION_SELECT = `SELECT
  clarification_options.group_id AS groupId,
  clarification_options.group_label AS groupLabel,
  clarification_options.option_ordinal AS optionOrdinal,
  clarification_options.option_ref AS optionRef,
  clarification_options.kind,
  clarification_options.source_task_id AS sourceTaskId,
  clarification_options.principal_hash AS principalHash,
  clarification_options.chat_hash AS chatHash,
  clarification_options.value_json AS valueJson,
  clarification_options.display_label AS displayLabel,
  clarification_options.expires_at AS expiresAt,
  clarification_options.payload_hash AS persistedPayloadHash,
  clarification_options.created_at AS createdAt,
  source_tasks.created_at AS sourceTaskCreatedAt,
  source_inbound.id AS sourceInboundEventId,
  source_inbound.received_at AS sourceInboundReceivedAt,
  source_inbound.app_id AS sourceAppId,
  source_inbound.tenant_key AS sourceTenantKey,
  source_inbound.sender_open_id_hash AS sourcePrincipalHash,
  source_inbound.chat_id_hash AS sourceChatHash,
  (
    SELECT COUNT(*)
      FROM clarification_selections
     WHERE clarification_selections.group_id=clarification_options.group_id
  ) AS selectionCount
FROM clarification_options
JOIN tasks AS source_tasks
  ON source_tasks.id=clarification_options.source_task_id
JOIN inbound_events AS source_inbound
  ON source_inbound.id=source_tasks.inbound_event_id`;

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

function safeText(value: unknown, maximumLength: number): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    LONE_SURROGATE.test(value)
  ) {
    return false;
  }
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f);
  });
}

function canonicalRawSha256(value: unknown): value is string {
  return typeof value === "string" && RAW_SHA256.test(value);
}

function canonicalPrefixedSha256(value: unknown): value is string {
  return typeof value === "string" && PREFIXED_SHA256.test(value);
}

function samePrefixedHash(left: string, right: string): boolean {
  return timingSafeEqual(
    Buffer.from(left.slice("sha256:".length), "hex"),
    Buffer.from(right.slice("sha256:".length), "hex"),
  );
}

function canonicalTimestamp(value: unknown, detail: string): ClockSnapshot {
  if (typeof value !== "string") throw new RuntimeStateError(detail);
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new RuntimeStateError(detail);
  }
  return Object.freeze({ iso: value, milliseconds });
}

function snapshotNow(value: Date): ClockSnapshot {
  try {
    const unknownValue: unknown = value;
    if (
      unknownValue === null ||
      typeof unknownValue !== "object" ||
      isProxy(unknownValue) ||
      Object.getPrototypeOf(unknownValue) !== Date.prototype ||
      Reflect.ownKeys(unknownValue).length !== 0
    ) {
      throw new Error("invalid date");
    }
    const milliseconds = Date.prototype.getTime.call(unknownValue);
    if (!Number.isFinite(milliseconds)) throw new Error("invalid date");
    return Object.freeze({
      iso: new Date(milliseconds).toISOString(),
      milliseconds,
    });
  } catch {
    throw new RuntimeStateError("clarification_input_is_invalid");
  }
}

function snapshotOptionRefs(value: readonly string[]): readonly string[] {
  try {
    const unknownValue: unknown = value;
    if (
      unknownValue === null ||
      typeof unknownValue !== "object" ||
      isProxy(unknownValue) ||
      !Array.isArray(unknownValue) ||
      Object.getPrototypeOf(unknownValue) !== Array.prototype
    ) {
      throw new Error("invalid option refs");
    }
    const descriptors = Object.getOwnPropertyDescriptors(unknownValue);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(
      unknownValue,
      "length",
    );
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 1 ||
      lengthDescriptor.value > 20 ||
      lengthDescriptor.enumerable
    ) {
      throw new Error("invalid option refs");
    }
    const length = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(unknownValue);
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
      throw new Error("invalid option refs");
    }
    const refs: string[] = [];
    const uniqueRefs = new Set<string>();
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        !canonicalUuid(descriptor.value) ||
        uniqueRefs.has(descriptor.value)
      ) {
        throw new Error("invalid option refs");
      }
      uniqueRefs.add(descriptor.value);
      refs.push(descriptor.value);
    }
    return Object.freeze(refs);
  } catch {
    throw new RuntimeStateError("clarification_input_is_invalid");
  }
}

function snapshotExactDataObject(
  value: unknown,
  requiredKeys: readonly string[],
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
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== requiredKeys.length ||
      !keys.every(
        (key) => typeof key === "string" && requiredKeys.includes(key),
      ) ||
      !requiredKeys.every((key) => keys.includes(key))
    ) {
      throw new Error("invalid object keys");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of requiredKeys) {
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
    throw new RuntimeStateError("clarification_input_is_invalid");
  }
}

function snapshotWriteOptions(value: unknown): readonly WriteOptionSnapshot[] {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      !Array.isArray(value) ||
      isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      throw new Error("invalid options");
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
      throw new Error("invalid options");
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
      throw new Error("invalid options");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const options: WriteOptionSnapshot[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        throw new Error("invalid option descriptor");
      }
      const option = snapshotExactDataObject(descriptor.value, [
        "value",
        "displayLabel",
      ]);
      if (!safeText(option.displayLabel, 1_024)) {
        throw new Error("invalid display label");
      }
      options.push(
        Object.freeze({
          value: snapshotStrictIJson(
            option.value,
            "clarification_input_is_invalid",
          ),
          displayLabel: option.displayLabel,
        }),
      );
    }
    return Object.freeze(options);
  } catch (cause) {
    if (cause instanceof RuntimeStateError) throw cause;
    throw new RuntimeStateError("clarification_input_is_invalid");
  }
}

function snapshotWriteInput(
  inputValue: WriteClarificationGroupForTaskInput,
): WriteInputSnapshot {
  const input = snapshotExactDataObject(inputValue, [
    "taskId",
    "kind",
    "groupLabel",
    "options",
    "now",
  ]);
  if (
    !canonicalUuid(input.taskId) ||
    typeof input.kind !== "string" ||
    !KINDS.has(input.kind as ClarificationKind) ||
    !safeText(input.groupLabel, 256)
  ) {
    throw new RuntimeStateError("clarification_input_is_invalid");
  }
  return Object.freeze({
    taskId: input.taskId,
    kind: input.kind as ClarificationKind,
    groupLabel: input.groupLabel,
    options: snapshotWriteOptions(input.options),
    now: snapshotNow(input.now as Date),
  });
}

function clarificationExpiry(now: ClockSnapshot): ClockSnapshot {
  try {
    const milliseconds = now.milliseconds + CLARIFICATION_TTL_MS;
    if (!Number.isSafeInteger(milliseconds)) {
      throw new Error("invalid clarification expiry");
    }
    return Object.freeze({
      iso: new Date(milliseconds).toISOString(),
      milliseconds,
    });
  } catch {
    throw new RuntimeStateError("clarification_input_is_invalid");
  }
}

function nextOpaqueId(excluded: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = randomUUID();
    if (!excluded.has(candidate)) {
      excluded.add(candidate);
      return candidate;
    }
  }
  throw new RuntimeStateError("clarification_persistence_failed");
}

function parseCanonicalValue(value: unknown): StrictIJson {
  if (typeof value !== "string") {
    throw new RuntimeStateError("clarification_persistence_failed");
  }
  try {
    const snapshot = snapshotStrictIJson(
      JSON.parse(value) as unknown,
      "clarification_persistence_failed",
    );
    if (canonicalStrictIJson(snapshot) !== value) {
      throw new RuntimeStateError("clarification_persistence_failed");
    }
    return snapshot;
  } catch (cause) {
    if (cause instanceof RuntimeStateError) throw cause;
    throw new RuntimeStateError("clarification_persistence_failed", cause);
  }
}

function taskContext(database: Database.Database, taskId: string): TaskContext {
  const row = database
    .prepare(
      `SELECT tasks.id AS taskId,
              tasks.state,
              tasks.lease_owner AS leaseOwner,
              tasks.lease_expires_at AS leaseExpiresAt,
              tasks.codex_session_id AS codexSessionId,
              tasks.created_at AS taskCreatedAt,
              inbound_events.id AS inboundEventId,
              inbound_events.received_at AS inboundReceivedAt,
              inbound_events.app_id AS appId,
              inbound_events.tenant_key AS tenantKey,
              inbound_events.sender_open_id_hash AS principalHash,
              inbound_events.chat_id_hash AS chatHash
         FROM tasks
         JOIN inbound_events ON inbound_events.id=tasks.inbound_event_id
        WHERE tasks.id=?`,
    )
    .get(taskId) as TaskContextRow | undefined;
  if (
    row === undefined ||
    row.taskId !== taskId ||
    !safeText(row.state, 64) ||
    (row.leaseOwner !== null && !safeText(row.leaseOwner, 128)) ||
    (row.leaseExpiresAt !== null && typeof row.leaseExpiresAt !== "string") ||
    (row.codexSessionId !== null && !safeText(row.codexSessionId, 256)) ||
    !canonicalUuid(row.inboundEventId) ||
    !safeText(row.appId, 256) ||
    !safeText(row.tenantKey, 256) ||
    !canonicalRawSha256(row.principalHash) ||
    !canonicalRawSha256(row.chatHash)
  ) {
    throw new RuntimeStateError("clarification_task_context_is_invalid");
  }
  if (row.leaseExpiresAt !== null) {
    canonicalTimestamp(
      row.leaseExpiresAt,
      "clarification_task_context_is_invalid",
    );
  }
  return Object.freeze({
    taskId,
    state: row.state,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt,
    codexSessionId: row.codexSessionId,
    taskCreatedAt: canonicalTimestamp(
      row.taskCreatedAt,
      "clarification_task_context_is_invalid",
    ),
    inboundEventId: row.inboundEventId,
    inboundReceivedAt: canonicalTimestamp(
      row.inboundReceivedAt,
      "clarification_task_context_is_invalid",
    ),
    appId: row.appId,
    tenantKey: row.tenantKey,
    principalHash: row.principalHash,
    chatHash: row.chatHash,
  });
}

function taskIsExecutable(
  context: TaskContext,
  instanceId: string,
  now: ClockSnapshot,
): boolean {
  if (
    context.state !== "RUNNING" ||
    context.leaseOwner !== instanceId ||
    context.leaseExpiresAt === null ||
    context.codexSessionId === null
  ) {
    return false;
  }
  return (
    canonicalTimestamp(
      context.leaseExpiresAt,
      "clarification_task_context_is_invalid",
    ).milliseconds >= now.milliseconds
  );
}

function validateOptionRow(row: ClarificationOptionRow): ValidatedOption {
  if (
    !canonicalUuid(row.groupId) ||
    !safeText(row.groupLabel, 256) ||
    !Number.isSafeInteger(row.optionOrdinal) ||
    (row.optionOrdinal as number) < 1 ||
    !canonicalUuid(row.optionRef) ||
    typeof row.kind !== "string" ||
    !KINDS.has(row.kind as ClarificationKind) ||
    !canonicalUuid(row.sourceTaskId) ||
    !canonicalRawSha256(row.principalHash) ||
    !canonicalRawSha256(row.chatHash) ||
    !safeText(row.displayLabel, 1_024) ||
    !canonicalPrefixedSha256(row.persistedPayloadHash) ||
    !canonicalUuid(row.sourceInboundEventId) ||
    !safeText(row.sourceAppId, 256) ||
    !safeText(row.sourceTenantKey, 256) ||
    !canonicalRawSha256(row.sourcePrincipalHash) ||
    !canonicalRawSha256(row.sourceChatHash) ||
    row.principalHash !== row.sourcePrincipalHash ||
    row.chatHash !== row.sourceChatHash ||
    row.groupId === row.sourceTaskId ||
    row.groupId === row.sourceInboundEventId ||
    row.optionRef === row.groupId ||
    row.optionRef === row.sourceTaskId ||
    row.optionRef === row.sourceInboundEventId ||
    !Number.isSafeInteger(row.selectionCount) ||
    (row.selectionCount as number) < 0 ||
    (row.selectionCount as number) > 1
  ) {
    throw new RuntimeStateError("clarification_persistence_failed");
  }
  const createdAt = canonicalTimestamp(
    row.createdAt,
    "clarification_persistence_failed",
  );
  const expiresAt = canonicalTimestamp(
    row.expiresAt,
    "clarification_persistence_failed",
  );
  const sourceTaskCreatedAt = canonicalTimestamp(
    row.sourceTaskCreatedAt,
    "clarification_persistence_failed",
  );
  const sourceInboundReceivedAt = canonicalTimestamp(
    row.sourceInboundReceivedAt,
    "clarification_persistence_failed",
  );
  if (
    expiresAt.milliseconds - createdAt.milliseconds !==
    CLARIFICATION_TTL_MS
  ) {
    throw new RuntimeStateError("clarification_persistence_failed");
  }
  const value = parseCanonicalValue(row.valueJson);
  const calculatedHash = payloadHash(value);
  if (!samePrefixedHash(row.persistedPayloadHash as string, calculatedHash)) {
    throw new RuntimeStateError("clarification_persistence_failed");
  }
  return Object.freeze({
    groupId: row.groupId,
    groupLabel: row.groupLabel,
    optionOrdinal: row.optionOrdinal as number,
    optionRef: row.optionRef,
    kind: row.kind as ClarificationKind,
    sourceTaskId: row.sourceTaskId,
    principalHash: row.principalHash,
    chatHash: row.chatHash,
    value,
    displayLabel: row.displayLabel,
    expiresAt,
    createdAt,
    sourceTaskCreatedAt,
    sourceInboundEventId: row.sourceInboundEventId,
    sourceInboundReceivedAt,
    sourceAppId: row.sourceAppId,
    sourceTenantKey: row.sourceTenantKey,
    selectionCount: row.selectionCount as number,
  });
}

function validateGroup(
  rows: readonly ClarificationOptionRow[],
): ValidatedOption[] {
  if (rows.length === 0) {
    throw new RuntimeStateError("clarification_persistence_failed");
  }
  const options = rows.map(validateOptionRow);
  const first = options[0] as ValidatedOption;
  const optionRefs = new Set<string>();
  for (const [index, option] of options.entries()) {
    if (
      option.groupId !== first.groupId ||
      option.groupLabel !== first.groupLabel ||
      option.kind !== first.kind ||
      option.sourceTaskId !== first.sourceTaskId ||
      option.principalHash !== first.principalHash ||
      option.chatHash !== first.chatHash ||
      option.expiresAt.iso !== first.expiresAt.iso ||
      option.createdAt.iso !== first.createdAt.iso ||
      option.sourceTaskCreatedAt.iso !== first.sourceTaskCreatedAt.iso ||
      option.sourceInboundEventId !== first.sourceInboundEventId ||
      option.sourceInboundReceivedAt.iso !==
        first.sourceInboundReceivedAt.iso ||
      option.sourceAppId !== first.sourceAppId ||
      option.sourceTenantKey !== first.sourceTenantKey ||
      option.selectionCount !== first.selectionCount ||
      option.optionOrdinal !== index + 1 ||
      optionRefs.has(option.optionRef)
    ) {
      throw new RuntimeStateError("clarification_persistence_failed");
    }
    optionRefs.add(option.optionRef);
  }
  return options;
}

function optionRowsForCurrentTask(
  database: Database.Database,
  context: TaskContext,
): ClarificationOptionRow[] {
  return database
    .prepare(
      `${OPTION_SELECT}
        WHERE clarification_options.principal_hash=?
          AND clarification_options.chat_hash=?
          AND clarification_options.source_task_id<>?
        ORDER BY clarification_options.created_at,
                 clarification_options.group_id,
                 clarification_options.option_ordinal`,
    )
    .all(
      context.principalHash,
      context.chatHash,
      context.taskId,
    ) as ClarificationOptionRow[];
}

function assertGroupBelongsToCurrentTask(
  options: readonly ValidatedOption[],
  context: TaskContext,
): void {
  const first = options[0] as ValidatedOption;
  if (
    first.principalHash !== context.principalHash ||
    first.chatHash !== context.chatHash ||
    first.sourceAppId !== context.appId ||
    first.sourceTenantKey !== context.tenantKey ||
    first.sourceTaskId === context.taskId ||
    first.sourceInboundReceivedAt.milliseconds > first.createdAt.milliseconds ||
    first.sourceTaskCreatedAt.milliseconds > first.createdAt.milliseconds ||
    first.createdAt.milliseconds >= context.inboundReceivedAt.milliseconds
  ) {
    throw new RuntimeStateError("clarification_persistence_failed");
  }
}

export function writeClarificationGroupForTask(
  database: Database.Database,
  instanceId: string,
  inputValue: WriteClarificationGroupForTaskInput,
): ClarificationGroup {
  const input = snapshotWriteInput(inputValue);
  const expiresAt = clarificationExpiry(input.now);
  try {
    return database
      .transaction(() => {
        const context = taskContext(database, input.taskId);
        if (
          !hasLiveBridgeLease(database, instanceId, input.now) ||
          !taskIsExecutable(context, instanceId, input.now)
        ) {
          throw new RuntimeStateError("clarification_task_is_not_executable");
        }
        if (
          context.taskCreatedAt.milliseconds > input.now.milliseconds ||
          context.inboundReceivedAt.milliseconds > input.now.milliseconds
        ) {
          throw new RuntimeStateError("clarification_task_context_is_invalid");
        }
        const excludedIds = new Set<string>([
          context.taskId,
          context.inboundEventId,
        ]);
        const groupId = nextOpaqueId(excludedIds);
        const insert = database.prepare(
          `INSERT INTO clarification_options(
             group_id, group_label, option_ordinal, option_ref, kind,
             source_task_id, principal_hash, chat_hash, value_json,
             display_label, expires_at, payload_hash, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const publicOptions = input.options.map((option, index) => {
          const optionRef = nextOpaqueId(excludedIds);
          const valueJson = canonicalStrictIJson(option.value);
          const result = insert.run(
            groupId,
            input.groupLabel,
            index + 1,
            optionRef,
            input.kind,
            context.taskId,
            context.principalHash,
            context.chatHash,
            valueJson,
            option.displayLabel,
            expiresAt.iso,
            payloadHash(option.value),
            input.now.iso,
          );
          if (result.changes !== 1) {
            throw new RuntimeStateError("clarification_persistence_failed");
          }
          return Object.freeze({
            ordinal: index + 1,
            optionRef,
            displayLabel: option.displayLabel,
          });
        });
        return Object.freeze({
          groupId,
          groupLabel: input.groupLabel,
          kind: input.kind,
          expiresAt: expiresAt.iso,
          options: Object.freeze(publicOptions),
        });
      })
      .immediate();
  } catch (cause) {
    if (cause instanceof RuntimeStateError) throw cause;
    throw new RuntimeStateError("clarification_persistence_failed", cause);
  }
}

export function listPendingClarificationsForTask(
  database: Database.Database,
  taskIdValue: string,
  nowValue: Date,
): readonly ClarificationGroup[] {
  if (!canonicalUuid(taskIdValue)) {
    throw new RuntimeStateError("clarification_input_is_invalid");
  }
  const now = snapshotNow(nowValue);
  try {
    const context = taskContext(database, taskIdValue);
    const rows = optionRowsForCurrentTask(database, context);
    const groups: ClarificationGroup[] = [];
    const publicOptionRefs = new Set<string>();
    let index = 0;
    while (index < rows.length) {
      const groupId = rows[index]?.groupId;
      const groupRows: ClarificationOptionRow[] = [];
      while (index < rows.length && rows[index]?.groupId === groupId) {
        groupRows.push(rows[index] as ClarificationOptionRow);
        index += 1;
      }
      const options = validateGroup(groupRows);
      assertGroupBelongsToCurrentTask(options, context);
      const first = options[0] as ValidatedOption;
      if (
        first.selectionCount !== 0 ||
        first.expiresAt.milliseconds <= now.milliseconds
      ) {
        continue;
      }
      const publicOptions = options.map((option) => {
        if (publicOptionRefs.has(option.optionRef)) {
          throw new RuntimeStateError("clarification_persistence_failed");
        }
        publicOptionRefs.add(option.optionRef);
        return Object.freeze({
          ordinal: option.optionOrdinal,
          optionRef: option.optionRef,
          displayLabel: option.displayLabel,
        });
      });
      groups.push(
        Object.freeze({
          groupId: first.groupId,
          groupLabel: first.groupLabel,
          kind: first.kind,
          expiresAt: first.expiresAt.iso,
          options: Object.freeze(publicOptions),
        }),
      );
    }
    return Object.freeze(groups);
  } catch (cause) {
    if (cause instanceof RuntimeStateError) throw cause;
    throw new RuntimeStateError("clarification_persistence_failed", cause);
  }
}

export function consumeClarificationsForTaskValidated(
  database: Database.Database,
  instanceId: string,
  taskIdValue: string,
  optionRefsValue: readonly string[],
  expectedKindValue: ClarificationKind,
  nowValue: Date,
  assertValueValue: ClarificationValueValidator,
): readonly ClarificationSelection[] {
  if (
    !canonicalUuid(taskIdValue) ||
    !KINDS.has(expectedKindValue) ||
    typeof assertValueValue !== "function"
  ) {
    throw new RuntimeStateError("clarification_input_is_invalid");
  }
  const optionRefs = snapshotOptionRefs(optionRefsValue);
  const now = snapshotNow(nowValue);
  try {
    return database
      .transaction(() => {
        const context = taskContext(database, taskIdValue);
        if (
          !hasLiveBridgeLease(database, instanceId, now) ||
          !taskIsExecutable(context, instanceId, now)
        ) {
          throw new RuntimeStateError("clarification_task_is_not_executable");
        }
        const candidateStatement = database.prepare(
          `${OPTION_SELECT}
              WHERE clarification_options.option_ref=?
                AND clarification_options.principal_hash=?
                AND clarification_options.chat_hash=?
                AND clarification_options.source_task_id<>?
              ORDER BY clarification_options.group_id,
                       clarification_options.option_ordinal`,
        );
        const groupStatement = database.prepare(
          `${OPTION_SELECT}
              WHERE clarification_options.group_id=?
              ORDER BY clarification_options.option_ordinal`,
        );
        const selectedOptions: ValidatedOption[] = [];
        const selectedGroupIds = new Set<string>();
        for (const optionRef of optionRefs) {
          const candidateRows = candidateStatement.all(
            optionRef,
            context.principalHash,
            context.chatHash,
            context.taskId,
          ) as ClarificationOptionRow[];
          if (candidateRows.length !== 1) {
            throw new RuntimeStateError("clarification_not_available");
          }
          const candidate = validateOptionRow(
            candidateRows[0] as ClarificationOptionRow,
          );
          const groupRows = groupStatement.all(
            candidate.groupId,
          ) as ClarificationOptionRow[];
          const options = validateGroup(groupRows);
          assertGroupBelongsToCurrentTask(options, context);
          const first = options[0] as ValidatedOption;
          const selected = options.find(
            (option) => option.optionRef === optionRef,
          );
          if (
            selected === undefined ||
            first.kind !== expectedKindValue ||
            first.selectionCount !== 0 ||
            first.expiresAt.milliseconds <= now.milliseconds ||
            selectedGroupIds.has(first.groupId)
          ) {
            throw new RuntimeStateError("clarification_not_available");
          }
          selectedGroupIds.add(first.groupId);
          selectedOptions.push(selected);
        }
        for (const [index, selected] of selectedOptions.entries()) {
          const validatorResult: unknown = assertValueValue(
            selected.value,
            index,
          );
          if (validatorResult !== undefined) {
            if (utilTypes.isPromise(validatorResult)) {
              void validatorResult.catch(() => undefined);
            }
            throw new RuntimeStateError(
              "clarification_validator_must_return_undefined",
            );
          }
        }
        const insertSelection = database.prepare(
          `INSERT INTO clarification_selections(
               id, group_id, option_ordinal, task_id, selected_at, created_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        const selections: ClarificationSelection[] = [];
        for (const selected of selectedOptions) {
          const selectionId = randomUUID();
          const result = insertSelection.run(
            selectionId,
            selected.groupId,
            selected.optionOrdinal,
            context.taskId,
            now.iso,
            now.iso,
          );
          if (result.changes !== 1) {
            throw new RuntimeStateError("clarification_persistence_failed");
          }
          selections.push(
            Object.freeze({
              selectionId,
              groupId: selected.groupId,
              optionOrdinal: selected.optionOrdinal,
              optionRef: selected.optionRef,
              kind: selected.kind,
              value: selected.value,
              selectedAt: now.iso,
            }),
          );
        }
        return Object.freeze(selections);
      })
      .immediate();
  } catch (cause) {
    if (cause instanceof RuntimeStateError) throw cause;
    throw new RuntimeStateError("clarification_persistence_failed", cause);
  }
}

export function consumeClarificationsForTask(
  database: Database.Database,
  instanceId: string,
  taskIdValue: string,
  optionRefsValue: readonly string[],
  expectedKindValue: ClarificationKind,
  nowValue: Date,
): readonly ClarificationSelection[] {
  return consumeClarificationsForTaskValidated(
    database,
    instanceId,
    taskIdValue,
    optionRefsValue,
    expectedKindValue,
    nowValue,
    ACCEPT_CLARIFICATION_VALUE,
  );
}

export function consumeClarificationForTask(
  database: Database.Database,
  instanceId: string,
  taskIdValue: string,
  optionRefValue: string,
  expectedKindValue: ClarificationKind,
  nowValue: Date,
): ClarificationSelection {
  const selections = consumeClarificationsForTask(
    database,
    instanceId,
    taskIdValue,
    [optionRefValue],
    expectedKindValue,
    nowValue,
  );
  const selection = selections[0];
  if (selection === undefined || selections.length !== 1) {
    throw new RuntimeStateError("clarification_persistence_failed");
  }
  return selection;
}
