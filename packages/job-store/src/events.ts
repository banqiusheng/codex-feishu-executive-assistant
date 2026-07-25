import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { types as utilTypes } from "node:util";

import {
  InboundEventSchema,
  type InboundEvent,
} from "@executive-assistant/contracts";
import type Database from "better-sqlite3";

import { prepareSecureRuntimeDirectory } from "./secure-path.js";
import { RuntimeStateError, type IngestEventResult } from "./types.js";

const INBOUND_EVENT_KEYS = Object.freeze([
  "appId",
  "tenantKey",
  "eventId",
  "messageId",
  "senderOpenId",
  "chatId",
  "chatType",
  "eventType",
  "receivedAt",
  "payloadRef",
] as const);

const INBOUND_EVENT_KEY_SET = new Set<string>(INBOUND_EVENT_KEYS);
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type ExistingInboundEvent = Readonly<{
  id: string;
  messageId: string;
  senderOpenIdHash: string;
  chatIdHash: string;
  payloadRef: string;
  receivedAt: string;
}>;

type ExistingRootTask = Readonly<{
  id: string;
  workspacePath: string;
}>;

function isProxy(value: object): boolean {
  try {
    return utilTypes.isProxy(value);
  } catch {
    return true;
  }
}

function snapshotInboundEvent(event: InboundEvent): InboundEvent {
  try {
    const value: unknown = event;
    if (
      value === null ||
      typeof value !== "object" ||
      isProxy(value) ||
      Array.isArray(value)
    ) {
      throw new RuntimeStateError("inbound_event_must_be_own_data_properties");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new RuntimeStateError("inbound_event_must_be_own_data_properties");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== INBOUND_EVENT_KEYS.length ||
      !keys.every(
        (key) => typeof key === "string" && INBOUND_EVENT_KEY_SET.has(key),
      )
    ) {
      throw new RuntimeStateError("inbound_event_must_be_own_data_properties");
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const fieldSchemas = InboundEventSchema.shape;
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of INBOUND_EVENT_KEYS) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        throw new RuntimeStateError(
          "inbound_event_must_be_own_data_properties",
        );
      }
      const parsed = fieldSchemas[key].safeParse(descriptor.value);
      if (!parsed.success) {
        throw new RuntimeStateError("inbound_event_is_invalid", parsed.error);
      }
      Object.defineProperty(snapshot, key, {
        value: parsed.data,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(snapshot) as InboundEvent;
  } catch (cause) {
    if (cause instanceof RuntimeStateError) {
      throw cause;
    }
    throw new RuntimeStateError(
      "inbound_event_must_be_own_data_properties",
      cause,
    );
  }
}

function canonicalWorkspace(workspacePath: string): Readonly<{
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
  return { path, taskId };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactResult(taskId: string, duplicate: boolean): IngestEventResult {
  return Object.freeze({ taskId, duplicate });
}

function findExistingEvent(
  database: Database.Database,
  event: InboundEvent,
): ExistingInboundEvent | undefined {
  return database
    .prepare(
      `SELECT id,
              message_id AS messageId,
              sender_open_id_hash AS senderOpenIdHash,
              chat_id_hash AS chatIdHash,
              payload_ref AS payloadRef,
              received_at AS receivedAt
         FROM inbound_events
        WHERE app_id = ? AND tenant_key = ? AND event_id = ?`,
    )
    .get(event.appId, event.tenantKey, event.eventId) as
    | ExistingInboundEvent
    | undefined;
}

function findRootTask(
  database: Database.Database,
  inboundEventId: string,
): ExistingRootTask | undefined {
  return database
    .prepare(
      `SELECT id, workspace_path AS workspacePath
         FROM tasks
        WHERE inbound_event_id = ? AND task_kind = 'ROOT'`,
    )
    .get(inboundEventId) as ExistingRootTask | undefined;
}

function replayResult(
  database: Database.Database,
  existing: ExistingInboundEvent,
  event: InboundEvent,
  senderOpenIdHash: string,
  chatIdHash: string,
): IngestEventResult {
  const rootTask = findRootTask(database, existing.id);
  if (rootTask === undefined) {
    throw new RuntimeStateError("inbound_event_root_task_missing");
  }
  if (
    !CANONICAL_UUID.test(rootTask.id) ||
    basename(rootTask.workspacePath) !== rootTask.id
  ) {
    throw new RuntimeStateError("inbound_event_task_identity_invalid");
  }
  if (
    existing.messageId !== event.messageId ||
    existing.senderOpenIdHash !== senderOpenIdHash ||
    existing.chatIdHash !== chatIdHash ||
    existing.payloadRef !== event.payloadRef ||
    existing.receivedAt !== event.receivedAt
  ) {
    throw new RuntimeStateError("inbound_event_replay_conflict");
  }
  return exactResult(rootTask.id, true);
}

export function ingestEvent(
  database: Database.Database,
  inboundEvent: InboundEvent,
  workspacePath: string,
): IngestEventResult {
  const event = snapshotInboundEvent(inboundEvent);
  const workspace = canonicalWorkspace(workspacePath);
  const senderOpenIdHash = sha256(event.senderOpenId);
  const chatIdHash = sha256(event.chatId);

  const transaction = database.transaction((): IngestEventResult => {
    const existing = findExistingEvent(database, event);
    if (existing !== undefined) {
      return replayResult(
        database,
        existing,
        event,
        senderOpenIdHash,
        chatIdHash,
      );
    }

    const inboundEventId = randomUUID();
    database
      .prepare(
        `INSERT INTO inbound_events (
           id, app_id, tenant_key, event_id, message_id,
           sender_open_id_hash, chat_id_hash, payload_ref, received_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        inboundEventId,
        event.appId,
        event.tenantKey,
        event.eventId,
        event.messageId,
        senderOpenIdHash,
        chatIdHash,
        event.payloadRef,
        event.receivedAt,
      );
    database
      .prepare(
        `INSERT INTO tasks (
           id, inbound_event_id, task_kind, state, recovery_disposition,
           workspace_path, stage, last_event_at, created_at, updated_at
         ) VALUES (?, ?, 'ROOT', 'RECEIVED', 'NONE', ?, 'accepted', ?, ?, ?)`,
      )
      .run(
        workspace.taskId,
        inboundEventId,
        workspace.path,
        event.receivedAt,
        event.receivedAt,
        event.receivedAt,
      );
    database
      .prepare(
        `INSERT INTO task_acknowledgements(
           task_id, state, attempt_count, last_failure_class, created_at, updated_at
         ) VALUES (?, 'NOT_ATTEMPTED', 0, NULL, ?, ?)`,
      )
      .run(workspace.taskId, event.receivedAt, event.receivedAt);
    return exactResult(workspace.taskId, false);
  });

  try {
    return transaction.immediate();
  } catch (cause) {
    if (cause instanceof RuntimeStateError) {
      throw cause;
    }
    throw new RuntimeStateError("inbound_event_persistence_failed");
  }
}
