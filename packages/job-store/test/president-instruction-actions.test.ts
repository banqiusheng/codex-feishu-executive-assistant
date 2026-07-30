import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InboundEvent } from "@executive-assistant/contracts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  acquireDatabaseFileLock,
  openJobStore,
  type ActionRecord,
  type DatabaseFileLock,
  type JobStore,
} from "../src/index.js";

const temporaryPaths: string[] = [];
const openStores: JobStore[] = [];
const fileLocks: DatabaseFileLock[] = [];

afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  for (const lock of fileLocks.splice(0)) await lock.release();
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function at(seconds: number): Date {
  return new Date(Date.UTC(2026, 6, 29, 8, 0, seconds));
}

function event(): InboundEvent {
  return {
    appId: "cli_test_app",
    tenantKey: "tenant_test_001",
    eventId: "event_direct_1",
    messageId: "message_direct_1",
    senderOpenId: "ou_synthetic_president",
    chatId: "oc_synthetic_private_chat",
    chatType: "p2p",
    eventType: "im.message.receive_v1",
    receivedAt: at(0).toISOString(),
    payloadRef: `sha256:${"a".repeat(64)}`,
  };
}

type DirectAuthorizationInput = Readonly<{
  taskId: string;
  capability: string;
  identity: "bot" | "user";
  itemKey: string;
  payload: unknown;
  preview: unknown;
  now: Date;
}>;

type DirectActionStore = JobStore & {
  authorizePresidentInstructionAction(input: DirectAuthorizationInput): {
    action: ActionRecord & { approvalMode: "president_instruction" };
    created: boolean;
  };
};

function direct(store: JobStore): DirectActionStore {
  return store as DirectActionStore;
}

async function storeFixture(options: { startTask?: boolean } = {}): Promise<{
  filename: string;
  store: JobStore;
  taskId: string;
  inboundEventId: string;
}> {
  const runtimeDir = mkdtempSync(
    join(realpathSync(tmpdir()), "job-store-direct-actions-"),
  );
  chmodSync(runtimeDir, 0o700);
  temporaryPaths.push(runtimeDir);
  const jobsDir = join(runtimeDir, "jobs");
  mkdirSync(jobsDir, { mode: 0o700 });
  const workspacePath = join(jobsDir, randomUUID());
  mkdirSync(workspacePath, { mode: 0o700 });
  const lock = await acquireDatabaseFileLock(runtimeDir);
  fileLocks.push(lock);
  const filename = join(runtimeDir, "assistant.sqlite");
  const store = openJobStore({
    filename,
    instanceId: "instance-a",
    lock,
  });
  openStores.push(store);
  const { taskId } = store.ingestEvent(event(), workspacePath);
  const task = store.getTask(taskId);
  if (task === null) throw new Error("task fixture missing");
  expect(
    store.acquireRuntimeLease("bridge", "instance-a", at(1), 3_600_000),
  ).toBe(true);
  if (options.startTask !== false) {
    expect(
      store.beginTaskAcknowledgement({
        taskId,
        owner: "instance-a",
        now: at(1),
      }),
    ).toMatchObject({ state: "SENDING" });
    expect(
      store.finishTaskAcknowledgement({
        taskId,
        owner: "instance-a",
        now: at(1),
        state: "ACKNOWLEDGED",
        failureClass: null,
      }),
    ).toMatchObject({ state: "ACKNOWLEDGED" });
    expect(store.claimNextTask("instance-a", at(2), 3_600_000)).toMatchObject({
      id: taskId,
      state: "CLAIMED",
    });
    expect(
      store.markRunning({
        taskId,
        owner: "instance-a",
        codexSessionId: "codex-session-direct-actions",
        now: at(3),
        ttlMs: 3_600_000,
      }),
    ).toMatchObject({ id: taskId, state: "RUNNING" });
  }
  return {
    filename,
    store,
    taskId,
    inboundEventId: task.inboundEventId,
  };
}

function authorizationInput(
  taskId: string,
  patch: Partial<DirectAuthorizationInput> = {},
): DirectAuthorizationInput {
  return {
    taskId,
    capability: "calendar.create.direct",
    identity: "user",
    itemKey: "calendar-primary-item",
    payload: {
      title: "合成测试日程",
      startLocal: "2026-07-30T10:00:00",
      endLocal: "2026-07-30T11:00:00",
    },
    preview: {
      title: "合成测试日程",
      time: "2026-07-30 10:00-11:00",
    },
    now: at(10),
    ...patch,
  };
}

function queryRows<T>(
  filename: string,
  sql: string,
  ...parameters: unknown[]
): T[] {
  const database = new Database(filename, { readonly: true });
  try {
    return database.prepare(sql).all(...parameters) as T[];
  } finally {
    database.close();
  }
}

function mutate(filename: string, sql: string, ...parameters: unknown[]): void {
  const database = new Database(filename);
  try {
    database.pragma("foreign_keys = ON");
    database.prepare(sql).run(...parameters);
  } finally {
    database.close();
  }
}

describe("president instruction action authorization", () => {
  it("derives the actor, chat, and inbound event from the task in one transaction", async () => {
    const { filename, store, taskId, inboundEventId } = await storeFixture();

    const authorized = direct(store).authorizePresidentInstructionAction(
      authorizationInput(taskId),
    );

    expect(authorized).toMatchObject({
      created: true,
      action: {
        taskId,
        controlEventId: null,
        capability: "calendar.create.direct",
        identity: "user",
        approvalMode: "president_instruction",
        state: "APPROVED",
        idempotencyKey: expect.any(String),
      },
    });
    expect(authorized.action.idempotencyKey).toBe(authorized.action.actionId);
    expect(authorized).not.toHaveProperty("nonce");
    expect(authorized.action).not.toHaveProperty("nonce");
    expect(Object.isFrozen(authorized)).toBe(true);
    expect(Object.isFrozen(authorized.action)).toBe(true);

    const actorHash = createHash("sha256")
      .update("ou_synthetic_president")
      .digest("hex");
    const chatHash = createHash("sha256")
      .update("oc_synthetic_private_chat")
      .digest("hex");
    expect(
      queryRows(
        filename,
        `SELECT actor_open_id_hash AS actorHash, chat_id_hash AS chatHash
           FROM actions WHERE id = ?`,
        authorized.action.actionId,
      ),
    ).toEqual([{ actorHash, chatHash }]);
    expect(
      queryRows(
        filename,
        `SELECT action_id AS actionId, action_version AS actionVersion,
                task_id AS taskId, inbound_event_id AS inboundEventId,
                capability, payload_hash AS payloadHash, item_key AS itemKey
           FROM instruction_authorizations WHERE action_id = ?`,
        authorized.action.actionId,
      ),
    ).toEqual([
      {
        actionId: authorized.action.actionId,
        actionVersion: 1,
        taskId,
        inboundEventId,
        capability: "calendar.create.direct",
        payloadHash: authorized.action.payloadHash,
        itemKey: "calendar-primary-item",
      },
    ]);
    expect(
      queryRows(
        filename,
        `SELECT from_state AS fromState, to_state AS toState,
                reason_code AS reasonCode
           FROM action_transitions WHERE action_id = ?`,
        authorized.action.actionId,
      ),
    ).toEqual([
      {
        fromState: null,
        toState: "APPROVED",
        reasonCode: "president_instruction_approved",
      },
    ]);
    expect(
      queryRows(
        filename,
        "SELECT id FROM approvals WHERE action_id = ?",
        authorized.action.actionId,
      ),
    ).toEqual([]);
  });

  it("rejects caller-supplied authorization fields before any ledger write", async () => {
    const { filename, store, taskId } = await storeFixture();
    for (const [key, value] of [
      ["actorOpenId", "ou_attacker"],
      ["chatId", "oc_attacker"],
      ["inboundEventId", randomUUID()],
      ["approvalMode", "president_instruction"],
      ["nonce", "caller-supplied-nonce"],
      ["idempotencyKey", randomUUID()],
    ] as const) {
      expect(() =>
        direct(store).authorizePresidentInstructionAction({
          ...authorizationInput(taskId),
          [key]: value,
        } as DirectAuthorizationInput),
      ).toThrow(/action_instruction_input_is_invalid/);
    }
    expect(queryRows(filename, "SELECT id FROM actions")).toEqual([]);
    expect(
      queryRows(filename, "SELECT action_id FROM instruction_authorizations"),
    ).toEqual([]);
  });

  it("replays the same task capability item and rejects a changed payload without overwriting", async () => {
    const { filename, store, taskId } = await storeFixture();
    const input = authorizationInput(taskId);
    const first = direct(store).authorizePresidentInstructionAction(input);

    const replay = direct(store).authorizePresidentInstructionAction({
      ...input,
      preview: { title: "重新渲染但不改变动作" },
      now: at(11),
    });

    expect(replay).toEqual({ action: first.action, created: false });
    expect(() =>
      direct(store).authorizePresidentInstructionAction({
        ...input,
        payload: { title: "冲突动作" },
        now: at(12),
      }),
    ).toThrow(/action_instruction_replay_conflict/);
    expect(
      queryRows<{ count: number }>(
        filename,
        "SELECT COUNT(*) AS count FROM actions",
      ),
    ).toEqual([{ count: 1 }]);
    expect(
      direct(store).getAction({
        actionId: first.action.actionId,
        version: 1,
      }),
    ).toMatchObject({ payload: input.payload });
  });

  it("requires a running task, a live task lease, and a live runtime lease", async () => {
    const received = await storeFixture({ startTask: false });
    expect(() =>
      direct(received.store).authorizePresidentInstructionAction(
        authorizationInput(received.taskId),
      ),
    ).toThrow(/action_parent_task_is_not_executable/);

    const lostRuntime = await storeFixture();
    expect(lostRuntime.store.releaseRuntimeLease("bridge", "instance-a")).toBe(
      true,
    );
    expect(() =>
      direct(lostRuntime.store).authorizePresidentInstructionAction(
        authorizationInput(lostRuntime.taskId),
      ),
    ).toThrow(/bridge_runtime_lease_is_not_live/);

    const wrongOwner = await storeFixture();
    mutate(
      wrongOwner.filename,
      "UPDATE tasks SET lease_owner = 'instance-b' WHERE id = ?",
      wrongOwner.taskId,
    );
    expect(() =>
      direct(wrongOwner.store).authorizePresidentInstructionAction(
        authorizationInput(wrongOwner.taskId),
      ),
    ).toThrow(/action_parent_task_is_not_executable/);

    const expiredTaskLease = await storeFixture();
    mutate(
      expiredTaskLease.filename,
      "UPDATE tasks SET lease_expires_at = ? WHERE id = ?",
      at(9).toISOString(),
      expiredTaskLease.taskId,
    );
    expect(() =>
      direct(expiredTaskLease.store).authorizePresidentInstructionAction(
        authorizationInput(expiredTaskLease.taskId),
      ),
    ).toThrow(/action_parent_task_is_not_executable/);

    const cancelled = await storeFixture();
    cancelled.store.bindPrincipal({
      appId: event().appId,
      tenantKey: event().tenantKey,
      presidentOpenId: event().senderOpenId,
      presidentChatId: event().chatId,
      pairedAt: at(4),
    });
    expect(
      cancelled.store.cancelActiveTask({
        appId: event().appId,
        tenantKey: event().tenantKey,
        eventId: "cancel_direct_1",
        messageId: "cancel_message_direct_1",
        senderOpenId: event().senderOpenId,
        chatId: event().chatId,
        receivedAt: at(5).toISOString(),
      }),
    ).toMatchObject({ taskId: cancelled.taskId, cancelled: true });
    expect(() =>
      direct(cancelled.store).authorizePresidentInstructionAction(
        authorizationInput(cancelled.taskId),
      ),
    ).toThrow(/action_parent_task_is_not_executable/);
  });

  it("reuses claim through terminal states without reclaiming success or UNKNOWN", async () => {
    const { store, taskId } = await storeFixture();
    const first = direct(store).authorizePresidentInstructionAction(
      authorizationInput(taskId),
    ).action;
    const second = direct(store).authorizePresidentInstructionAction(
      authorizationInput(taskId, {
        capability: "notification.send.direct",
        identity: "bot",
        itemKey: "recipient-1",
        payload: { recipientRef: "synthetic-ref", text: "fixture" },
      }),
    ).action;

    expect(
      store.prepareAction({
        taskId,
        capability: "message.send",
        identity: "bot",
        payload: { text: "legacy confirmation" },
        preview: { text: "legacy confirmation" },
        now: at(11),
      }),
    ).toMatchObject({ state: "PREPARED" });

    const claimedFirst = store.claimApprovedAction({
      actionId: first.actionId,
      version: 1,
      owner: "instance-a",
      now: at(12),
      ttlMs: 60_000,
    });
    if (claimedFirst === null) throw new Error("first claim missing");
    const firstAttemptId = randomUUID();
    expect(
      store.markDispatching({
        actionId: first.actionId,
        version: 1,
        owner: "instance-a",
        leaseExpiresAt: claimedFirst.leaseExpiresAt,
        now: at(13),
        attemptId: firstAttemptId,
        requestDigest: `sha256:${"b".repeat(64)}`,
      }),
    ).toMatchObject({ state: "DISPATCHING" });
    expect(
      store.finishAction({
        actionId: first.actionId,
        version: 1,
        owner: "instance-a",
        leaseExpiresAt: claimedFirst.leaseExpiresAt,
        now: at(14),
        attemptId: firstAttemptId,
        outcome: "SUCCEEDED",
        remoteId: "event_fixture_1",
      }),
    ).toMatchObject({ state: "SUCCEEDED" });

    const claimedSecond = store.claimApprovedAction({
      actionId: second.actionId,
      version: 1,
      owner: "instance-a",
      now: at(15),
      ttlMs: 60_000,
    });
    if (claimedSecond === null) throw new Error("second claim missing");
    const secondAttemptId = randomUUID();
    store.markDispatching({
      actionId: second.actionId,
      version: 1,
      owner: "instance-a",
      leaseExpiresAt: claimedSecond.leaseExpiresAt,
      now: at(16),
      attemptId: secondAttemptId,
      requestDigest: `sha256:${"c".repeat(64)}`,
    });
    expect(
      store.finishAction({
        actionId: second.actionId,
        version: 1,
        owner: "instance-a",
        leaseExpiresAt: claimedSecond.leaseExpiresAt,
        now: at(17),
        attemptId: secondAttemptId,
        outcome: "UNKNOWN",
      }),
    ).toMatchObject({ state: "UNKNOWN" });

    for (const action of [first, second]) {
      expect(
        store.claimApprovedAction({
          actionId: action.actionId,
          version: 1,
          owner: "instance-a",
          now: at(18),
          ttlMs: 60_000,
        }),
      ).toBeNull();
    }
    expect(store.listUnknownActions()).toEqual([
      expect.objectContaining({ actionId: second.actionId, state: "UNKNOWN" }),
    ]);
  });

  it("fails closed when direct instruction authorization evidence is missing", async () => {
    const { filename, store, taskId } = await storeFixture();
    const action = direct(store).authorizePresidentInstructionAction(
      authorizationInput(taskId),
    ).action;
    mutate(
      filename,
      "DROP TRIGGER instruction_authorizations_append_only_delete",
    );
    mutate(
      filename,
      "DELETE FROM instruction_authorizations WHERE action_id = ?",
      action.actionId,
    );

    expect(() =>
      store.getAction({ actionId: action.actionId, version: 1 }),
    ).toThrow(/action_persistence_failed/);
  });

  it("keeps every part of one action on one recipient while allowing multiple parts", async () => {
    const { filename, store, taskId } = await storeFixture();
    const action = direct(store).authorizePresidentInstructionAction(
      authorizationInput(taskId, {
        capability: "notification.send.direct",
        identity: "bot",
        itemKey: "recipient-action-one",
      }),
    ).action;
    const batchId = randomUUID();
    const now = at(20).toISOString();
    mutate(
      filename,
      `INSERT INTO notification_batches(
         id, task_id, batch_key_hash, recipient_count, state,
         created_at, updated_at
       ) VALUES (?, ?, ?, 2, 'PREPARED', ?, ?)`,
      batchId,
      taskId,
      `sha256:${"1".repeat(64)}`,
      now,
      now,
    );
    for (const [partOrdinal, partKind] of [
      [1, "content"],
      [2, "attachment"],
    ] as const) {
      mutate(
        filename,
        `INSERT INTO notification_parts(
           id, batch_id, recipient_ordinal, action_id, part_ordinal,
           part_kind, idempotency_key, state, attempt_count,
           created_at, updated_at
         ) VALUES (?, ?, 1, ?, ?, ?, ?, 'PENDING', 0, ?, ?)`,
        randomUUID(),
        batchId,
        action.actionId,
        partOrdinal,
        partKind,
        randomUUID(),
        now,
        now,
      );
    }

    expect(() =>
      mutate(
        filename,
        `INSERT INTO notification_parts(
           id, batch_id, recipient_ordinal, action_id, part_ordinal,
           part_kind, idempotency_key, state, attempt_count,
           created_at, updated_at
         ) VALUES (?, ?, 2, ?, 3, 'content', ?, 'PENDING', 0, ?, ?)`,
        randomUUID(),
        batchId,
        action.actionId,
        randomUUID(),
        now,
        now,
      ),
    ).toThrow(/notification_action_recipient_mismatch/);
  });

  it("does not reuse one recipient action in another notification batch", async () => {
    const { filename, store, taskId } = await storeFixture();
    const action = direct(store).authorizePresidentInstructionAction(
      authorizationInput(taskId, {
        capability: "notification.send.direct",
        identity: "bot",
        itemKey: "recipient-action-cross-batch",
      }),
    ).action;
    const firstBatchId = randomUUID();
    const secondBatchId = randomUUID();
    const now = at(20).toISOString();
    for (const [batchId, batchKeyHash] of [
      [firstBatchId, `sha256:${"2".repeat(64)}`],
      [secondBatchId, `sha256:${"3".repeat(64)}`],
    ] as const) {
      mutate(
        filename,
        `INSERT INTO notification_batches(
           id, task_id, batch_key_hash, recipient_count, state,
           created_at, updated_at
         ) VALUES (?, ?, ?, 2, 'PREPARED', ?, ?)`,
        batchId,
        taskId,
        batchKeyHash,
        now,
        now,
      );
    }
    mutate(
      filename,
      `INSERT INTO notification_parts(
         id, batch_id, recipient_ordinal, action_id, part_ordinal,
         part_kind, idempotency_key, state, attempt_count,
         created_at, updated_at
       ) VALUES (?, ?, 1, ?, 1, 'content', ?, 'PENDING', 0, ?, ?)`,
      randomUUID(),
      firstBatchId,
      action.actionId,
      randomUUID(),
      now,
      now,
    );

    expect(() =>
      mutate(
        filename,
        `INSERT INTO notification_parts(
           id, batch_id, recipient_ordinal, action_id, part_ordinal,
           part_kind, idempotency_key, state, attempt_count,
           created_at, updated_at
         ) VALUES (?, ?, 2, ?, 2, 'attachment', ?, 'PENDING', 0, ?, ?)`,
        randomUUID(),
        secondBatchId,
        action.actionId,
        randomUUID(),
        now,
        now,
      ),
    ).toThrow(/notification_action_recipient_mismatch/);
  });

  it("prebuilds append-only resource and clarification ledgers plus one-action notification parts", async () => {
    const { filename, store, taskId } = await storeFixture();
    const first = direct(store).authorizePresidentInstructionAction(
      authorizationInput(taskId, {
        capability: "notification.send.direct",
        identity: "bot",
        itemKey: "recipient-1",
      }),
    ).action;
    const second = direct(store).authorizePresidentInstructionAction(
      authorizationInput(taskId, {
        capability: "notification.send.direct",
        identity: "bot",
        itemKey: "recipient-2",
      }),
    ).action;
    const batchId = randomUUID();
    const now = at(20).toISOString();
    mutate(
      filename,
      `INSERT INTO clarification_options(
         group_id, group_label, option_ordinal, option_ref, kind,
         source_task_id, principal_hash, chat_hash, value_json,
         display_label, expires_at, payload_hash, created_at
       ) VALUES (?, '联系人选择', 1, ?, 'contact', ?, ?, ?,
                 '{"candidate":"fixture"}', '合成候选人',
                 '2026-07-30T08:00:20.000Z', ?, ?)`,
      randomUUID(),
      randomUUID(),
      taskId,
      createHash("sha256").update("ou_synthetic_president").digest("hex"),
      createHash("sha256").update("oc_synthetic_private_chat").digest("hex"),
      `sha256:${"d".repeat(64)}`,
      now,
    );
    mutate(
      filename,
      `INSERT INTO task_resources(
         id, task_id, resource_ref, source_kind, source_message_hash,
         kind, display_name, relative_path, size_bytes, sha256, created_at
       ) VALUES (?, ?, ?, 'current', ?, 'file', 'fixture.pdf',
                 'resources/fixture.bin', 7, ?, ?)`,
      randomUUID(),
      taskId,
      randomUUID(),
      createHash("sha256").update("message_direct_1").digest("hex"),
      `sha256:${"e".repeat(64)}`,
      now,
    );
    mutate(
      filename,
      `INSERT INTO notification_batches(
         id, task_id, batch_key_hash, recipient_count, state,
         created_at, updated_at
       ) VALUES (?, ?, ?, 2, 'PREPARED', ?, ?)`,
      batchId,
      taskId,
      `sha256:${"f".repeat(64)}`,
      now,
      now,
    );
    mutate(
      filename,
      `INSERT INTO notification_parts(
         id, batch_id, recipient_ordinal, action_id, part_ordinal,
         part_kind, idempotency_key, state, attempt_count,
         created_at, updated_at
       ) VALUES (?, ?, 1, ?, 1, 'content', ?, 'PENDING', 0, ?, ?)`,
      randomUUID(),
      batchId,
      first.actionId,
      randomUUID(),
      now,
      now,
    );
    expect(() =>
      mutate(
        filename,
        `INSERT INTO notification_parts(
           id, batch_id, recipient_ordinal, action_id, part_ordinal,
           part_kind, idempotency_key, state, attempt_count,
           created_at, updated_at
         ) VALUES (?, ?, 1, ?, 2, 'attachment', ?, 'PENDING', 0, ?, ?)`,
        randomUUID(),
        batchId,
        second.actionId,
        randomUUID(),
        now,
        now,
      ),
    ).toThrow(/notification_recipient_action_mismatch/);
    expect(() =>
      mutate(
        filename,
        "UPDATE instruction_authorizations SET item_key = 'changed'",
      ),
    ).toThrow(/append only/);
    expect(() => mutate(filename, "DELETE FROM clarification_options")).toThrow(
      /append only/,
    );
    expect(() =>
      mutate(filename, "UPDATE task_resources SET display_name = 'changed'"),
    ).toThrow(/append only/);
    expect(() =>
      mutate(filename, "UPDATE notification_parts SET state = 'SUCCEEDED'"),
    ).toThrow(/illegal notification part state transition/);
  });
});
