import { randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";

import type Database from "better-sqlite3";

import { canonicalPersistedTimestamp, hasLiveBridgeLease } from "./leases.js";
import {
  RuntimeStateError,
  type ResolvedTaskResource,
  type TaskResourceDescriptor,
  type TaskResourceKind,
  type TaskResourceSourceKind,
  type TaskResourceSummary,
} from "./types.js";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RAW_SHA256 = /^[0-9a-f]{64}$/;
const PORTABLE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LONE_SURROGATE =
  /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u;
const SOURCE_KINDS = new Set<TaskResourceSourceKind>(["current", "quoted"]);
const RESOURCE_KINDS = new Set<TaskResourceKind>(["text", "image", "file"]);
const MAX_RESOURCE_COUNT = 20;
const MAX_RESOURCE_SIZE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_SIZE_BYTES = 200 * 1024 * 1024;

type ClockSnapshot = Readonly<{ iso: string; milliseconds: number }>;

type DescriptorSnapshot = Readonly<{
  sourceKind: TaskResourceSourceKind;
  sourceMessageHash: string;
  kind: TaskResourceKind;
  displayName: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
}>;

type TaskRow = Readonly<{
  taskId: unknown;
  state: unknown;
  leaseOwner: unknown;
  leaseExpiresAt: unknown;
  codexSessionId: unknown;
  createdAt: unknown;
}>;

type TaskResourceRow = Readonly<{
  id: unknown;
  taskId: unknown;
  resourceRef: unknown;
  sourceKind: unknown;
  sourceMessageHash: unknown;
  kind: unknown;
  displayName: unknown;
  relativePath: unknown;
  sizeBytes: unknown;
  sha256: unknown;
  createdAt: unknown;
  taskCreatedAt: unknown;
}>;

type ValidatedTaskResource = Readonly<{
  id: string;
  taskId: string;
  resourceRef: string;
  sourceKind: TaskResourceSourceKind;
  sourceMessageHash: string;
  kind: TaskResourceKind;
  displayName: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  createdAt: ClockSnapshot;
}>;

const RESOURCE_SELECT = `SELECT
  task_resources.id,
  task_resources.task_id AS taskId,
  task_resources.resource_ref AS resourceRef,
  task_resources.source_kind AS sourceKind,
  task_resources.source_message_hash AS sourceMessageHash,
  task_resources.kind,
  task_resources.display_name AS displayName,
  task_resources.relative_path AS relativePath,
  task_resources.size_bytes AS sizeBytes,
  task_resources.sha256,
  task_resources.created_at AS createdAt,
  tasks.created_at AS taskCreatedAt
FROM task_resources
JOIN tasks ON tasks.id=task_resources.task_id`;

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

function canonicalRawSha256(value: unknown): value is string {
  return typeof value === "string" && RAW_SHA256.test(value);
}

function safeToken(value: unknown, maximumLength: number): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
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

function safeDisplayName(value: unknown): value is string {
  return (
    safeToken(value, 512) &&
    value.trim() === value &&
    value !== "." &&
    value !== ".."
  );
}

function portableResourcePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.normalize("NFC") !== value ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/")
  ) {
    return false;
  }
  const segments = value.split("/");
  return (
    segments.length >= 2 &&
    segments[0] === "resources" &&
    segments.every(
      (segment) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        PORTABLE_SEGMENT.test(segment),
    )
  );
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
    throw new RuntimeStateError("task_resource_input_is_invalid");
  }
}

function snapshotDescriptor(value: unknown): DescriptorSnapshot {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      isProxy(value)
    ) {
      throw new Error("invalid descriptor");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("invalid descriptor prototype");
    }
    const requiredKeys = [
      "sourceKind",
      "sourceMessageHash",
      "kind",
      "displayName",
      "relativePath",
      "sizeBytes",
      "sha256",
    ] as const;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== requiredKeys.length ||
      !keys.every(
        (key) =>
          typeof key === "string" &&
          (requiredKeys as readonly string[]).includes(key),
      ) ||
      !requiredKeys.every((key) => keys.includes(key))
    ) {
      throw new Error("invalid descriptor keys");
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
        throw new Error("invalid descriptor property");
      }
      snapshot[key] = descriptor.value;
    }
    if (
      !SOURCE_KINDS.has(snapshot.sourceKind as TaskResourceSourceKind) ||
      !canonicalRawSha256(snapshot.sourceMessageHash) ||
      !RESOURCE_KINDS.has(snapshot.kind as TaskResourceKind) ||
      !safeDisplayName(snapshot.displayName) ||
      !portableResourcePath(snapshot.relativePath) ||
      !Number.isSafeInteger(snapshot.sizeBytes) ||
      (snapshot.sizeBytes as number) < 0 ||
      (snapshot.sizeBytes as number) > MAX_RESOURCE_SIZE_BYTES ||
      !canonicalRawSha256(snapshot.sha256)
    ) {
      throw new Error("invalid descriptor value");
    }
    return Object.freeze({
      sourceKind: snapshot.sourceKind as TaskResourceSourceKind,
      sourceMessageHash: snapshot.sourceMessageHash,
      kind: snapshot.kind as TaskResourceKind,
      displayName: snapshot.displayName,
      relativePath: snapshot.relativePath,
      sizeBytes: snapshot.sizeBytes as number,
      sha256: snapshot.sha256,
    });
  } catch {
    throw new RuntimeStateError("task_resource_input_is_invalid");
  }
}

function snapshotDescriptors(
  value: readonly TaskResourceDescriptor[],
): readonly DescriptorSnapshot[] {
  try {
    const unknownValue: unknown = value;
    if (
      unknownValue === null ||
      typeof unknownValue !== "object" ||
      !Array.isArray(unknownValue) ||
      isProxy(unknownValue) ||
      Object.getPrototypeOf(unknownValue) !== Array.prototype
    ) {
      throw new Error("invalid descriptor collection");
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(
      unknownValue,
      "length",
    );
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 1 ||
      lengthDescriptor.value > MAX_RESOURCE_COUNT ||
      lengthDescriptor.enumerable
    ) {
      throw new Error("invalid descriptor count");
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
      throw new Error("invalid descriptor collection shape");
    }
    const descriptors = Object.getOwnPropertyDescriptors(unknownValue);
    const snapshots: DescriptorSnapshot[] = [];
    const uniquePaths = new Set<string>();
    let totalSizeBytes = 0;
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        throw new Error("invalid descriptor item");
      }
      const snapshot = snapshotDescriptor(descriptor.value);
      if (!uniquePaths.has(snapshot.relativePath)) {
        uniquePaths.add(snapshot.relativePath);
        totalSizeBytes += snapshot.sizeBytes;
        if (
          !Number.isSafeInteger(totalSizeBytes) ||
          totalSizeBytes > MAX_TOTAL_SIZE_BYTES
        ) {
          throw new Error("resource total is too large");
        }
      }
      snapshots.push(snapshot);
    }
    return Object.freeze(snapshots);
  } catch (cause) {
    if (cause instanceof RuntimeStateError) throw cause;
    throw new RuntimeStateError("task_resource_input_is_invalid");
  }
}

function taskRow(
  database: Database.Database,
  taskId: string,
): TaskRow | undefined {
  return database
    .prepare(
      `SELECT id AS taskId, state, lease_owner AS leaseOwner,
              lease_expires_at AS leaseExpiresAt,
              codex_session_id AS codexSessionId, created_at AS createdAt
         FROM tasks WHERE id=?`,
    )
    .get(taskId) as TaskRow | undefined;
}

function taskIsExecutable(
  row: TaskRow | undefined,
  taskId: string,
  instanceId: string,
  now: ClockSnapshot,
): boolean {
  if (row === undefined) return false;
  if (
    row.taskId !== taskId ||
    !safeToken(row.state, 64) ||
    (row.leaseOwner !== null && !safeToken(row.leaseOwner, 128)) ||
    (row.leaseExpiresAt !== null && typeof row.leaseExpiresAt !== "string") ||
    (row.codexSessionId !== null && !safeToken(row.codexSessionId, 256))
  ) {
    throw new RuntimeStateError("task_resource_persistence_failed");
  }
  canonicalPersistedTimestamp(
    row.createdAt,
    "task_resource_persistence_failed",
  );
  const leaseExpiresAt =
    row.leaseExpiresAt === null
      ? null
      : canonicalPersistedTimestamp(
          row.leaseExpiresAt,
          "task_resource_persistence_failed",
        );
  const stateSessionIsConsistent =
    (row.state === "CLAIMED" && row.codexSessionId === null) ||
    (row.state === "RUNNING" && row.codexSessionId !== null);
  return (
    stateSessionIsConsistent &&
    row.leaseOwner === instanceId &&
    leaseExpiresAt !== null &&
    leaseExpiresAt.milliseconds >= now.milliseconds
  );
}

function validateResourceRow(row: TaskResourceRow): ValidatedTaskResource {
  if (
    !canonicalUuid(row.id) ||
    !canonicalUuid(row.taskId) ||
    !canonicalUuid(row.resourceRef) ||
    row.id === row.taskId ||
    row.id === row.resourceRef ||
    row.resourceRef === row.taskId ||
    !SOURCE_KINDS.has(row.sourceKind as TaskResourceSourceKind) ||
    !canonicalRawSha256(row.sourceMessageHash) ||
    !RESOURCE_KINDS.has(row.kind as TaskResourceKind) ||
    !safeDisplayName(row.displayName) ||
    !portableResourcePath(row.relativePath) ||
    !Number.isSafeInteger(row.sizeBytes) ||
    (row.sizeBytes as number) < 0 ||
    (row.sizeBytes as number) > MAX_RESOURCE_SIZE_BYTES ||
    !canonicalRawSha256(row.sha256)
  ) {
    throw new RuntimeStateError("task_resource_persistence_failed");
  }
  const createdAt = canonicalPersistedTimestamp(
    row.createdAt,
    "task_resource_persistence_failed",
  );
  const taskCreatedAt = canonicalPersistedTimestamp(
    row.taskCreatedAt,
    "task_resource_persistence_failed",
  );
  if (createdAt.milliseconds < taskCreatedAt.milliseconds) {
    throw new RuntimeStateError("task_resource_persistence_failed");
  }
  return Object.freeze({
    id: row.id,
    taskId: row.taskId,
    resourceRef: row.resourceRef,
    sourceKind: row.sourceKind as TaskResourceSourceKind,
    sourceMessageHash: row.sourceMessageHash,
    kind: row.kind as TaskResourceKind,
    displayName: row.displayName,
    relativePath: row.relativePath,
    sizeBytes: row.sizeBytes as number,
    sha256: row.sha256,
    createdAt,
  });
}

function rowsForTask(
  database: Database.Database,
  taskId: string,
): readonly ValidatedTaskResource[] {
  const rows = database
    .prepare(
      `${RESOURCE_SELECT}
        WHERE task_resources.task_id=?
        ORDER BY task_resources.relative_path, task_resources.id`,
    )
    .all(taskId) as TaskResourceRow[];
  const resources = rows.map(validateResourceRow);
  const paths = new Set<string>();
  const refs = new Set<string>();
  for (const resource of resources) {
    if (
      resource.taskId !== taskId ||
      paths.has(resource.relativePath) ||
      refs.has(resource.resourceRef)
    ) {
      throw new RuntimeStateError("task_resource_persistence_failed");
    }
    paths.add(resource.relativePath);
    refs.add(resource.resourceRef);
  }
  let totalSizeBytes = 0;
  for (const resource of resources) {
    totalSizeBytes += resource.sizeBytes;
    if (!Number.isSafeInteger(totalSizeBytes)) {
      throw new RuntimeStateError("task_resource_persistence_failed");
    }
  }
  if (
    resources.length > MAX_RESOURCE_COUNT ||
    totalSizeBytes > MAX_TOTAL_SIZE_BYTES
  ) {
    throw new RuntimeStateError("task_resource_persistence_failed");
  }
  return Object.freeze(resources);
}

function resourceRowsByRef(
  database: Database.Database,
  taskId: string,
  resourceRef: string,
): TaskResourceRow[] {
  return database
    .prepare(
      `${RESOURCE_SELECT}
        WHERE task_resources.task_id=? AND task_resources.resource_ref=?`,
    )
    .all(taskId, resourceRef) as TaskResourceRow[];
}

function publicSummary(resource: ValidatedTaskResource): TaskResourceSummary {
  return Object.freeze({
    resourceRef: resource.resourceRef,
    kind: resource.kind,
    displayName: resource.displayName,
    sizeBytes: resource.sizeBytes,
  });
}

function resolvedResource(
  resource: ValidatedTaskResource,
): ResolvedTaskResource {
  return Object.freeze({
    resourceRef: resource.resourceRef,
    sourceKind: resource.sourceKind,
    sourceMessageHash: resource.sourceMessageHash,
    kind: resource.kind,
    displayName: resource.displayName,
    relativePath: resource.relativePath,
    sizeBytes: resource.sizeBytes,
    sha256: resource.sha256,
  });
}

function descriptorMatchesResource(
  descriptor: DescriptorSnapshot,
  resource: ValidatedTaskResource,
): boolean {
  return (
    descriptor.sourceKind === resource.sourceKind &&
    descriptor.sourceMessageHash === resource.sourceMessageHash &&
    descriptor.kind === resource.kind &&
    descriptor.displayName === resource.displayName &&
    descriptor.relativePath === resource.relativePath &&
    descriptor.sizeBytes === resource.sizeBytes &&
    descriptor.sha256 === resource.sha256
  );
}

function descriptorsMatch(
  left: DescriptorSnapshot,
  right: DescriptorSnapshot,
): boolean {
  return (
    left.sourceKind === right.sourceKind &&
    left.sourceMessageHash === right.sourceMessageHash &&
    left.kind === right.kind &&
    left.displayName === right.displayName &&
    left.relativePath === right.relativePath &&
    left.sizeBytes === right.sizeBytes &&
    left.sha256 === right.sha256
  );
}

function nextOpaqueId(
  database: Database.Database,
  excluded: Set<string>,
): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = randomUUID();
    if (excluded.has(candidate)) continue;
    const collision = database
      .prepare(
        `SELECT 1
           FROM task_resources
          WHERE id=? OR resource_ref=?
          LIMIT 1`,
      )
      .get(candidate, candidate);
    if (collision === undefined) {
      excluded.add(candidate);
      return candidate;
    }
  }
  throw new RuntimeStateError("task_resource_persistence_failed");
}

export function registerTaskResourcesForTask(
  database: Database.Database,
  instanceId: string,
  taskIdValue: string,
  descriptorsValue: readonly TaskResourceDescriptor[],
  nowValue: Date,
): readonly TaskResourceSummary[] {
  if (!canonicalUuid(taskIdValue)) {
    throw new RuntimeStateError("task_resource_input_is_invalid");
  }
  const descriptors = snapshotDescriptors(descriptorsValue);
  const now = snapshotNow(nowValue);
  try {
    return database
      .transaction(() => {
        const task = taskRow(database, taskIdValue);
        if (
          !hasLiveBridgeLease(database, instanceId, now) ||
          !taskIsExecutable(task, taskIdValue, instanceId, now)
        ) {
          throw new RuntimeStateError("task_resource_task_is_not_executable");
        }
        if (task === undefined) {
          throw new RuntimeStateError("task_resource_persistence_failed");
        }
        const taskCreatedAt = canonicalPersistedTimestamp(
          task.createdAt,
          "task_resource_persistence_failed",
        );
        const resourceCreatedAt =
          taskCreatedAt.milliseconds > now.milliseconds
            ? taskCreatedAt.iso
            : now.iso;
        const persisted = rowsForTask(database, taskIdValue);
        const byPath = new Map(
          persisted.map((resource) => [resource.relativePath, resource]),
        );
        const newByPath = new Map<string, DescriptorSnapshot>();
        for (const descriptor of descriptors) {
          const existing = byPath.get(descriptor.relativePath);
          if (existing !== undefined) {
            if (!descriptorMatchesResource(descriptor, existing)) {
              throw new RuntimeStateError("task_resource_replay_conflict");
            }
            continue;
          }
          const pending = newByPath.get(descriptor.relativePath);
          if (pending !== undefined) {
            if (!descriptorsMatch(descriptor, pending)) {
              throw new RuntimeStateError("task_resource_replay_conflict");
            }
            continue;
          }
          newByPath.set(descriptor.relativePath, descriptor);
        }
        let projectedSizeBytes = persisted.reduce(
          (total, resource) => total + resource.sizeBytes,
          0,
        );
        for (const descriptor of newByPath.values()) {
          projectedSizeBytes += descriptor.sizeBytes;
          if (!Number.isSafeInteger(projectedSizeBytes)) {
            throw new RuntimeStateError("task_resource_persistence_failed");
          }
        }
        if (
          persisted.length + newByPath.size > MAX_RESOURCE_COUNT ||
          projectedSizeBytes > MAX_TOTAL_SIZE_BYTES
        ) {
          throw new RuntimeStateError("task_resource_persistence_failed");
        }
        const excludedIds = new Set<string>([
          taskIdValue,
          ...persisted.flatMap(({ id, resourceRef }) => [id, resourceRef]),
        ]);
        const insert = database.prepare(
          `INSERT INTO task_resources(
             id, task_id, resource_ref, source_kind, source_message_hash,
             kind, display_name, relative_path, size_bytes, sha256, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const descriptor of newByPath.values()) {
          const id = nextOpaqueId(database, excludedIds);
          const resourceRef = nextOpaqueId(database, excludedIds);
          const inserted = insert.run(
            id,
            taskIdValue,
            resourceRef,
            descriptor.sourceKind,
            descriptor.sourceMessageHash,
            descriptor.kind,
            descriptor.displayName,
            descriptor.relativePath,
            descriptor.sizeBytes,
            descriptor.sha256,
            resourceCreatedAt,
          );
          if (inserted.changes !== 1) {
            throw new RuntimeStateError("task_resource_persistence_failed");
          }
          const insertedRows = resourceRowsByRef(
            database,
            taskIdValue,
            resourceRef,
          );
          if (insertedRows.length !== 1) {
            throw new RuntimeStateError("task_resource_persistence_failed");
          }
          const resource = validateResourceRow(
            insertedRows[0] as TaskResourceRow,
          );
          if (!descriptorMatchesResource(descriptor, resource)) {
            throw new RuntimeStateError("task_resource_persistence_failed");
          }
          byPath.set(resource.relativePath, resource);
        }
        return Object.freeze(
          descriptors.map((descriptor) => {
            const resource = byPath.get(descriptor.relativePath);
            if (
              resource === undefined ||
              !descriptorMatchesResource(descriptor, resource)
            ) {
              throw new RuntimeStateError("task_resource_persistence_failed");
            }
            return publicSummary(resource);
          }),
        );
      })
      .immediate();
  } catch (cause) {
    if (cause instanceof RuntimeStateError) throw cause;
    throw new RuntimeStateError("task_resource_persistence_failed", cause);
  }
}

export function resolveTaskResourceForTask(
  database: Database.Database,
  taskIdValue: string,
  resourceRefValue: string,
  expectedKindValue?: TaskResourceKind,
): ResolvedTaskResource {
  if (
    !canonicalUuid(taskIdValue) ||
    !canonicalUuid(resourceRefValue) ||
    (expectedKindValue !== undefined && !RESOURCE_KINDS.has(expectedKindValue))
  ) {
    throw new RuntimeStateError("task_resource_input_is_invalid");
  }
  try {
    const rows = resourceRowsByRef(database, taskIdValue, resourceRefValue);
    if (rows.length === 0) {
      throw new RuntimeStateError("task_resource_not_found");
    }
    if (rows.length !== 1) {
      throw new RuntimeStateError("task_resource_persistence_failed");
    }
    const resource = validateResourceRow(rows[0] as TaskResourceRow);
    if (
      resource.taskId !== taskIdValue ||
      resource.resourceRef !== resourceRefValue
    ) {
      throw new RuntimeStateError("task_resource_persistence_failed");
    }
    if (
      expectedKindValue !== undefined &&
      resource.kind !== expectedKindValue
    ) {
      throw new RuntimeStateError("task_resource_kind_mismatch");
    }
    return resolvedResource(resource);
  } catch (cause) {
    if (cause instanceof RuntimeStateError) throw cause;
    throw new RuntimeStateError("task_resource_persistence_failed", cause);
  }
}

export function listTaskResourcesForTask(
  database: Database.Database,
  taskIdValue: string,
): readonly ResolvedTaskResource[] {
  if (!canonicalUuid(taskIdValue)) {
    throw new RuntimeStateError("task_resource_input_is_invalid");
  }
  try {
    return Object.freeze(
      rowsForTask(database, taskIdValue).map((resource) =>
        resolvedResource(resource),
      ),
    );
  } catch (cause) {
    if (cause instanceof RuntimeStateError) throw cause;
    throw new RuntimeStateError("task_resource_persistence_failed", cause);
  }
}
