import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { types as utilTypes } from "node:util";

import type {
  CancelActiveTaskRequest,
  CancelActiveTaskResult,
} from "@executive-assistant/contracts";
import type Database from "better-sqlite3";

import { taskHasExternalEffectsPending } from "./actions.js";
import { normalizePersistedTimestamp } from "./leases.js";
import { getTask, invalidateTaskActions } from "./tasks.js";
import { RuntimeStateError } from "./types.js";

const REQUEST_KEYS = Object.freeze([
  "appId",
  "tenantKey",
  "eventId",
  "messageId",
  "senderOpenId",
  "chatId",
  "receivedAt",
] as const);

type RequestSnapshot = Readonly<{
  appId: string;
  tenantKey: string;
  eventId: string;
  messageId: string;
  senderOpenId: string;
  chatId: string;
  receivedAt: string;
}>;

type ExistingControl = Readonly<{
  id: unknown;
  messageId: unknown;
  command: unknown;
  actorOpenIdHash: unknown;
  chatIdHash: unknown;
  targetTaskId: unknown;
  receivedAt: unknown;
  externalEffectsPending: unknown;
}>;

type PrincipalRow = Readonly<{
  presidentOpenId: unknown;
  presidentChatId: unknown;
}>;

type ActiveTaskCandidate = Readonly<{
  id: unknown;
  createdAt: unknown;
}>;

function isProxy(value: object): boolean {
  try {
    return utilTypes.isProxy(value);
  } catch {
    return true;
  }
}

function safeText(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    return false;
  }
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f);
  });
}

function snapshotRequest(request: CancelActiveTaskRequest): RequestSnapshot {
  try {
    const value: unknown = request;
    if (
      value === null ||
      typeof value !== "object" ||
      isProxy(value) ||
      Array.isArray(value)
    ) {
      throw new RuntimeStateError("cancel_request_must_be_own_data_properties");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new RuntimeStateError("cancel_request_must_be_own_data_properties");
    }
    const keys = Reflect.ownKeys(value);
    const expected = new Set<string>(REQUEST_KEYS);
    if (
      keys.length !== REQUEST_KEYS.length ||
      !keys.every((key) => typeof key === "string" && expected.has(key))
    ) {
      throw new RuntimeStateError("cancel_request_must_be_own_data_properties");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot = Object.create(null) as Record<string, string>;
    for (const key of REQUEST_KEYS) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        throw new RuntimeStateError(
          "cancel_request_must_be_own_data_properties",
        );
      }
      if (!safeText(descriptor.value)) {
        throw new RuntimeStateError("cancel_request_is_invalid");
      }
      snapshot[key] = descriptor.value;
    }
    snapshot.receivedAt = normalizePersistedTimestamp(
      snapshot.receivedAt,
      "cancel_request_is_invalid",
    ).iso;
    return Object.freeze(snapshot) as RequestSnapshot;
  } catch (error) {
    if (error instanceof RuntimeStateError) throw error;
    throw new RuntimeStateError("cancel_request_must_be_own_data_properties");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashesEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) {
    return false;
  }
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function result(
  controlEventId: string,
  taskId: string | null,
  cancelled: boolean,
  duplicate: boolean,
  externalEffectsPending: boolean,
): CancelActiveTaskResult {
  return Object.freeze({
    controlEventId,
    taskId,
    cancelled,
    duplicate,
    externalEffectsPending,
  });
}

function replayResult(
  existing: ExistingControl,
  request: RequestSnapshot,
  actorHash: string,
  chatHash: string,
): CancelActiveTaskResult {
  if (
    typeof existing.id !== "string" ||
    typeof existing.messageId !== "string" ||
    existing.command !== "CANCEL_ACTIVE_TASK" ||
    typeof existing.actorOpenIdHash !== "string" ||
    typeof existing.chatIdHash !== "string" ||
    (existing.targetTaskId !== null &&
      typeof existing.targetTaskId !== "string") ||
    typeof existing.receivedAt !== "string" ||
    (existing.externalEffectsPending !== 0 &&
      existing.externalEffectsPending !== 1)
  ) {
    throw new RuntimeStateError("cancel_control_persistence_failed");
  }
  const existingReceivedAt = normalizePersistedTimestamp(
    existing.receivedAt,
    "cancel_control_persistence_failed",
  );
  if (
    existing.messageId !== request.messageId ||
    !hashesEqual(existing.actorOpenIdHash, actorHash) ||
    !hashesEqual(existing.chatIdHash, chatHash) ||
    existingReceivedAt.iso !== request.receivedAt
  ) {
    throw new RuntimeStateError("cancel_control_replay_conflict");
  }
  return result(
    existing.id,
    existing.targetTaskId,
    false,
    true,
    existing.externalEffectsPending === 1,
  );
}

function authorizedPrincipal(
  database: Database.Database,
  request: RequestSnapshot,
  actorHash: string,
  chatHash: string,
): void {
  const principal = database
    .prepare(
      `SELECT president_open_id AS presidentOpenId,
              president_chat_id AS presidentChatId
         FROM principals WHERE app_id = ? AND tenant_key = ?`,
    )
    .get(request.appId, request.tenantKey) as PrincipalRow | undefined;
  if (
    principal === undefined ||
    typeof principal.presidentOpenId !== "string" ||
    typeof principal.presidentChatId !== "string" ||
    !hashesEqual(sha256(principal.presidentOpenId), actorHash) ||
    !hashesEqual(sha256(principal.presidentChatId), chatHash)
  ) {
    throw new RuntimeStateError("cancel_principal_not_authorized");
  }
}

function selectActiveTask(
  database: Database.Database,
  request: RequestSnapshot,
  chatHash: string,
): string | null {
  const candidates = database
    .prepare(
      `SELECT tasks.id, tasks.created_at AS createdAt
         FROM tasks
         JOIN inbound_events ON inbound_events.id = tasks.inbound_event_id
        WHERE inbound_events.app_id = ?
          AND inbound_events.tenant_key = ?
          AND inbound_events.chat_id_hash = ?
          AND tasks.state IN ('RECEIVED','CLAIMED','RUNNING')`,
    )
    .all(request.appId, request.tenantKey, chatHash) as ActiveTaskCandidate[];
  const ordered = candidates
    .map((candidate) => {
      if (typeof candidate.id !== "string") {
        throw new RuntimeStateError("cancel_control_persistence_failed");
      }
      return {
        id: candidate.id,
        createdAt: normalizePersistedTimestamp(
          candidate.createdAt,
          "cancel_control_persistence_failed",
        ).milliseconds,
      };
    })
    .sort((left, right) => {
      const byTime = left.createdAt - right.createdAt;
      return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
    });
  const target = ordered[0];
  if (target === undefined) return null;
  if (getTask(database, target.id) === null) {
    throw new RuntimeStateError("cancel_control_persistence_failed");
  }
  return target.id;
}

export function cancelActiveTask(
  database: Database.Database,
  requestValue: CancelActiveTaskRequest,
): CancelActiveTaskResult {
  const request = snapshotRequest(requestValue);
  const actorHash = sha256(request.senderOpenId);
  const chatHash = sha256(request.chatId);
  const receivedAt = normalizePersistedTimestamp(
    request.receivedAt,
    "cancel_request_is_invalid",
  );
  try {
    return database
      .transaction(() => {
        const existing = database
          .prepare(
            `SELECT id, message_id AS messageId, command,
                  actor_open_id_hash AS actorOpenIdHash,
                  chat_id_hash AS chatIdHash, target_task_id AS targetTaskId,
                  received_at AS receivedAt,
                  external_effects_pending AS externalEffectsPending
             FROM control_events
            WHERE app_id = ? AND tenant_key = ? AND event_id = ?`,
          )
          .get(request.appId, request.tenantKey, request.eventId) as
          | ExistingControl
          | undefined;
        if (existing !== undefined) {
          return replayResult(existing, request, actorHash, chatHash);
        }

        authorizedPrincipal(database, request, actorHash, chatHash);
        const targetTaskId = selectActiveTask(database, request, chatHash);
        let externalEffectsPending = false;
        if (targetTaskId !== null) {
          externalEffectsPending = taskHasExternalEffectsPending(
            database,
            targetTaskId,
          );
        }

        const controlEventId = randomUUID();
        database
          .prepare(
            `INSERT INTO control_events(
             id, app_id, tenant_key, event_id, message_id, command,
             actor_open_id_hash, chat_id_hash, target_task_id, received_at,
             external_effects_pending
           ) VALUES (?, ?, ?, ?, ?, 'CANCEL_ACTIVE_TASK', ?, ?, ?, ?, ?)`,
          )
          .run(
            controlEventId,
            request.appId,
            request.tenantKey,
            request.eventId,
            request.messageId,
            actorHash,
            chatHash,
            targetTaskId,
            receivedAt.iso,
            externalEffectsPending ? 1 : 0,
          );

        if (targetTaskId === null) {
          return result(controlEventId, null, false, false, false);
        }
        invalidateTaskActions(
          database,
          targetTaskId,
          receivedAt,
          "user_cancelled",
          "user_cancelled_dispatch_unknown",
        );
        const changed = database
          .prepare(
            `UPDATE tasks
              SET state = 'CANCELLED', lease_owner = NULL,
                  lease_expires_at = NULL,
                  last_event_at = ?, updated_at = ?
            WHERE id = ? AND state IN ('RECEIVED','CLAIMED','RUNNING')`,
          )
          .run(receivedAt.iso, receivedAt.iso, targetTaskId).changes;
        if (changed !== 1) {
          throw new RuntimeStateError("cancel_control_persistence_failed");
        }
        return result(
          controlEventId,
          targetTaskId,
          true,
          false,
          externalEffectsPending,
        );
      })
      .immediate();
  } catch (error) {
    if (error instanceof RuntimeStateError) throw error;
    throw new RuntimeStateError("cancel_control_persistence_failed");
  }
}
