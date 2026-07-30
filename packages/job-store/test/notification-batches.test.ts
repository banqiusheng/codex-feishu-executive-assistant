import { randomUUID } from "node:crypto";
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

type NotificationPartState =
  | "PENDING"
  | "CLAIMED"
  | "DISPATCHING"
  | "SUCCEEDED"
  | "FAILED"
  | "UNKNOWN";

type NotificationPartRecord = Readonly<{
  partId: string;
  recipientOrdinal: number;
  actionId: string;
  partOrdinal: number;
  partKind: "content" | "image" | "file";
  idempotencyKey: string;
  state: NotificationPartState;
  attemptCount: number;
  remoteId: string | null;
  result: Readonly<Record<string, unknown>> | null;
  createdAt: string;
  updatedAt: string;
}>;

type NotificationBatchRecord = Readonly<{
  batchId: string;
  taskId: string;
  recipientCount: number;
  state: "PREPARED" | "DISPATCHING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";
  createdAt: string;
  updatedAt: string;
  deliveries: readonly Readonly<{
    recipientOrdinal: number;
    actionId: string;
    part: NotificationPartRecord;
  }>[];
}>;

type NotificationBatchSummary = Readonly<{
  batchId: string;
  state: "PREPARED" | "DISPATCHING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";
  total: number;
  pending: number;
  dispatching: number;
  succeeded: number;
  failed: number;
  unknown: number;
}>;

type NotificationDeliveryClaim = Readonly<{
  batchId: string;
  recipientOrdinal: number;
  action: ActionRecord;
  leaseExpiresAt: string;
  part: NotificationPartRecord;
}>;

type NotificationBatchStore = JobStore & {
  createNotificationBatch(input: {
    taskId: string;
    batchKey: string;
    recipients: readonly Readonly<{
      recipientRef: string;
      recipientBinding: unknown;
    }>[];
    content: unknown;
    attachments: readonly Readonly<{
      resourceRef: string;
      kind: "image" | "file";
      resourceBinding: unknown;
    }>[];
    now: Date;
  }): Readonly<{ batch: NotificationBatchRecord; created: boolean }>;
  claimNextNotificationDelivery(input: {
    batchId: string;
    owner: string;
    now: Date;
    ttlMs: number;
  }): NotificationDeliveryClaim | null;
  markNotificationDeliveryDispatching(input: {
    batchId: string;
    partId: string;
    actionId: string;
    owner: string;
    leaseExpiresAt: string;
    now: Date;
    attemptId: string;
    requestDigest: string;
  }): Readonly<{
    action: ActionRecord;
    part: NotificationPartRecord;
  }> | null;
  finishNotificationDelivery(input: {
    batchId: string;
    partId: string;
    actionId: string;
    owner: string;
    leaseExpiresAt: string;
    now: Date;
    attemptId: string;
    outcome: "SUCCEEDED" | "FAILED_DEFINITE" | "UNKNOWN";
    remoteId?: string;
  }): Readonly<{
    action: ActionRecord;
    part: NotificationPartRecord;
    summary: NotificationBatchSummary;
  }> | null;
  getNotificationBatchSummary(batchId: string): NotificationBatchSummary;
};

type StoreFixture = Readonly<{
  filename: string;
  runtimeDir: string;
  lock: DatabaseFileLock;
  store: JobStore;
  taskId: string;
}>;

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
  return new Date(Date.UTC(2026, 6, 30, 1, 0, seconds));
}

function event(): InboundEvent {
  return {
    appId: "cli_test_app",
    tenantKey: "tenant_test_001",
    eventId: "event_notification_batch_1",
    messageId: "message_notification_batch_1",
    senderOpenId: "ou_synthetic_president",
    chatId: "oc_synthetic_private_chat",
    chatType: "p2p",
    eventType: "im.message.receive_v1",
    receivedAt: at(0).toISOString(),
    payloadRef: `sha256:${"b".repeat(64)}`,
  };
}

function batches(store: JobStore): NotificationBatchStore {
  return store as NotificationBatchStore;
}

async function storeFixture(): Promise<StoreFixture> {
  const runtimeDir = mkdtempSync(
    join(realpathSync(tmpdir()), "job-store-notification-batches-"),
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
  expect(
    store.acquireRuntimeLease("bridge", "instance-a", at(1), 3_600_000),
  ).toBe(true);
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
      codexSessionId: "codex-session-notification-batch",
      now: at(3),
      ttlMs: 3_600_000,
    }),
  ).toMatchObject({ id: taskId, state: "RUNNING" });
  return Object.freeze({ filename, runtimeDir, lock, store, taskId });
}

async function reopenFixture(fixture: StoreFixture): Promise<JobStore> {
  fixture.store.close();
  openStores.splice(openStores.indexOf(fixture.store), 1);
  await fixture.lock.release();
  fileLocks.splice(fileLocks.indexOf(fixture.lock), 1);
  const lock = await acquireDatabaseFileLock(fixture.runtimeDir);
  fileLocks.push(lock);
  const reopened = openJobStore({
    filename: fixture.filename,
    instanceId: "instance-a",
    lock,
  });
  openStores.push(reopened);
  return reopened;
}

function createInput(
  taskId: string,
  recipientCount = 2,
  patch: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    taskId,
    batchKey: "notification-primary",
    recipients: Array.from({ length: recipientCount }, () => ({
      recipientRef: randomUUID(),
      recipientBinding: {
        provider: "lark",
        recipient: `opaque-${randomUUID()}`,
      },
    })),
    content: {
      kind: "text",
      text: "合成测试通知",
      wording: "composed",
    },
    attachments: [],
    now: at(10),
    ...patch,
  };
}

function queryRows<T>(
  filename: string,
  sql: string,
  ...parameters: readonly unknown[]
): T[] {
  const database = new Database(filename, { readonly: true });
  try {
    return database.prepare(sql).all(...parameters) as T[];
  } finally {
    database.close();
  }
}

function mutate(
  filename: string,
  sql: string,
  ...parameters: readonly unknown[]
): void {
  const database = new Database(filename);
  try {
    database.pragma("foreign_keys = ON");
    database.prepare(sql).run(...parameters);
  } finally {
    database.close();
  }
}

function sha256Digest(seed: string): string {
  return `sha256:${seed.padEnd(64, "0").slice(0, 64)}`;
}

function dispatchNext(
  store: NotificationBatchStore,
  batchId: string,
  ordinal: number,
  outcome: "SUCCEEDED" | "FAILED_DEFINITE" | "UNKNOWN",
): Readonly<{
  claim: NotificationDeliveryClaim;
  summary: NotificationBatchSummary;
}> {
  const claim = store.claimNextNotificationDelivery({
    batchId,
    owner: "instance-a",
    now: at(20 + ordinal * 10),
    ttlMs: 60_000,
  });
  if (claim === null) throw new Error("expected notification delivery claim");
  expect(claim.recipientOrdinal).toBe(ordinal);
  const attemptId = randomUUID();
  const dispatching = store.markNotificationDeliveryDispatching({
    batchId,
    partId: claim.part.partId,
    actionId: claim.action.actionId,
    owner: "instance-a",
    leaseExpiresAt: claim.leaseExpiresAt,
    now: at(21 + ordinal * 10),
    attemptId,
    requestDigest: sha256Digest(String(ordinal)),
  });
  expect(dispatching).toMatchObject({
    action: { state: "APPROVED" },
    part: { state: "DISPATCHING", attemptCount: 1 },
  });
  const finished = store.finishNotificationDelivery({
    batchId,
    partId: claim.part.partId,
    actionId: claim.action.actionId,
    owner: "instance-a",
    leaseExpiresAt: claim.leaseExpiresAt,
    now: at(22 + ordinal * 10),
    attemptId,
    outcome,
    ...(outcome === "SUCCEEDED" ? { remoteId: `message-${ordinal}` } : {}),
  });
  if (finished === null) throw new Error("expected finished delivery");
  return Object.freeze({ claim, summary: finished.summary });
}

describe("notification batch ledger", () => {
  it("creates one recipient action with stable content, image, and file parts", async () => {
    const fixture = await storeFixture();
    const imageRef = randomUUID();
    const fileRef = randomUUID();
    const input = createInput(fixture.taskId, 1, {
      batchKey: "notification-multipart",
      attachments: [
        {
          resourceRef: imageRef,
          kind: "image",
          resourceBinding: {
            relativePath: `resources/01-${randomUUID()}.bin`,
            sizeBytes: 11,
            sha256: `sha256:${"1".repeat(64)}`,
            displayName: "../../董事会现场.png",
          },
        },
        {
          resourceRef: fileRef,
          kind: "file",
          resourceBinding: {
            relativePath: `resources/02-${randomUUID()}.bin`,
            sizeBytes: 17,
            sha256: `sha256:${"2".repeat(64)}`,
            displayName: "../经营报告.pdf",
          },
        },
      ],
    }) as Parameters<NotificationBatchStore["createNotificationBatch"]>[0];

    const created = batches(fixture.store).createNotificationBatch(input);

    expect(created.batch.deliveries).toHaveLength(3);
    expect(
      created.batch.deliveries.map(({ recipientOrdinal, actionId, part }) => ({
        recipientOrdinal,
        actionId,
        partOrdinal: part.partOrdinal,
        partKind: part.partKind,
        state: part.state,
        attemptCount: part.attemptCount,
      })),
    ).toEqual([
      {
        recipientOrdinal: 1,
        actionId: created.batch.deliveries[0]?.actionId,
        partOrdinal: 1,
        partKind: "content",
        state: "PENDING",
        attemptCount: 0,
      },
      {
        recipientOrdinal: 1,
        actionId: created.batch.deliveries[0]?.actionId,
        partOrdinal: 2,
        partKind: "image",
        state: "PENDING",
        attemptCount: 0,
      },
      {
        recipientOrdinal: 1,
        actionId: created.batch.deliveries[0]?.actionId,
        partOrdinal: 3,
        partKind: "file",
        state: "PENDING",
        attemptCount: 0,
      },
    ]);
    expect(
      new Set(created.batch.deliveries.map(({ actionId }) => actionId)).size,
    ).toBe(1);
    expect(
      new Set(created.batch.deliveries.map(({ part }) => part.idempotencyKey))
        .size,
    ).toBe(3);
    expect(
      queryRows<{ actions: number; parts: number }>(
        fixture.filename,
        `SELECT
           (SELECT COUNT(*) FROM actions
             WHERE capability='notification.send.direct') AS actions,
           (SELECT COUNT(*) FROM notification_parts) AS parts`,
      ),
    ).toEqual([{ actions: 1, parts: 3 }]);
    expect(JSON.stringify(created)).not.toMatch(
      /ou_|resources\/|sha256|董事会现场|经营报告/,
    );

    const firstClaim = batches(fixture.store).claimNextNotificationDelivery({
      batchId: created.batch.batchId,
      owner: "instance-a",
      now: at(20),
      ttlMs: 60_000,
    });
    if (firstClaim === null) throw new Error("expected content claim");
    expect(firstClaim.part).toMatchObject({
      partOrdinal: 1,
      partKind: "content",
    });
    const firstAttempt = randomUUID();
    expect(
      batches(fixture.store).markNotificationDeliveryDispatching({
        batchId: created.batch.batchId,
        partId: firstClaim.part.partId,
        actionId: firstClaim.action.actionId,
        owner: "instance-a",
        leaseExpiresAt: firstClaim.leaseExpiresAt,
        now: at(21),
        attemptId: firstAttempt,
        requestDigest: `sha256:${"c".repeat(64)}`,
      }),
    ).toMatchObject({ part: { state: "DISPATCHING" } });
    expect(
      batches(fixture.store).finishNotificationDelivery({
        batchId: created.batch.batchId,
        partId: firstClaim.part.partId,
        actionId: firstClaim.action.actionId,
        owner: "instance-a",
        leaseExpiresAt: firstClaim.leaseExpiresAt,
        now: at(22),
        attemptId: firstAttempt,
        outcome: "SUCCEEDED",
        remoteId: "message-content",
      }),
    ).toMatchObject({
      part: { state: "SUCCEEDED" },
      summary: { total: 3, succeeded: 1, pending: 2 },
    });

    const reopened = batches(await reopenFixture(fixture));
    const imageClaim = reopened.claimNextNotificationDelivery({
      batchId: created.batch.batchId,
      owner: "instance-a",
      now: at(30),
      ttlMs: 60_000,
    });
    if (imageClaim === null) throw new Error("expected image claim");
    expect(imageClaim).toMatchObject({
      recipientOrdinal: 1,
      action: { actionId: firstClaim.action.actionId, state: "APPROVED" },
      part: { partOrdinal: 2, partKind: "image", state: "CLAIMED" },
    });
    const imageAttempt = randomUUID();
    reopened.markNotificationDeliveryDispatching({
      batchId: created.batch.batchId,
      partId: imageClaim.part.partId,
      actionId: imageClaim.action.actionId,
      owner: "instance-a",
      leaseExpiresAt: imageClaim.leaseExpiresAt,
      now: at(31),
      attemptId: imageAttempt,
      requestDigest: `sha256:${"d".repeat(64)}`,
    });
    expect(
      reopened.finishNotificationDelivery({
        batchId: created.batch.batchId,
        partId: imageClaim.part.partId,
        actionId: imageClaim.action.actionId,
        owner: "instance-a",
        leaseExpiresAt: imageClaim.leaseExpiresAt,
        now: at(32),
        attemptId: imageAttempt,
        outcome: "FAILED_DEFINITE",
      }),
    ).toMatchObject({
      part: { state: "FAILED" },
      summary: { total: 3, succeeded: 1, failed: 1, pending: 1 },
    });
    const fileClaim = reopened.claimNextNotificationDelivery({
      batchId: created.batch.batchId,
      owner: "instance-a",
      now: at(40),
      ttlMs: 60_000,
    });
    if (fileClaim === null) throw new Error("expected file claim");
    expect(fileClaim.part).toMatchObject({
      partOrdinal: 3,
      partKind: "file",
    });
    const fileAttempt = randomUUID();
    reopened.markNotificationDeliveryDispatching({
      batchId: created.batch.batchId,
      partId: fileClaim.part.partId,
      actionId: fileClaim.action.actionId,
      owner: "instance-a",
      leaseExpiresAt: fileClaim.leaseExpiresAt,
      now: at(41),
      attemptId: fileAttempt,
      requestDigest: `sha256:${"e".repeat(64)}`,
    });
    expect(
      reopened.finishNotificationDelivery({
        batchId: created.batch.batchId,
        partId: fileClaim.part.partId,
        actionId: fileClaim.action.actionId,
        owner: "instance-a",
        leaseExpiresAt: fileClaim.leaseExpiresAt,
        now: at(42),
        attemptId: fileAttempt,
        outcome: "SUCCEEDED",
        remoteId: "message-file",
      }),
    ).toMatchObject({
      action: { state: "FAILED" },
      summary: {
        state: "FAILED",
        total: 3,
        succeeded: 2,
        failed: 1,
        pending: 0,
      },
    });
    expect(
      reopened.claimNextNotificationDelivery({
        batchId: created.batch.batchId,
        owner: "instance-a",
        now: at(50),
        ttlMs: 60_000,
      }),
    ).toBeNull();
    expect(
      queryRows<{
        partOrdinal: number;
        state: string;
        attemptCount: number;
        attemptId: string | null;
        requestDigest: string | null;
        remoteId: string | null;
        resultJson: string | null;
      }>(
        fixture.filename,
        `SELECT part_ordinal AS partOrdinal, state,
                attempt_count AS attemptCount, attempt_id AS attemptId,
                request_digest AS requestDigest, remote_id AS remoteId,
                result_json AS resultJson
           FROM notification_parts
          ORDER BY part_ordinal`,
      ),
    ).toEqual([
      {
        partOrdinal: 1,
        state: "SUCCEEDED",
        attemptCount: 1,
        attemptId: firstAttempt,
        requestDigest: `sha256:${"c".repeat(64)}`,
        remoteId: "message-content",
        resultJson: '{"outcome":"SUCCEEDED","remoteId":"message-content"}',
      },
      {
        partOrdinal: 2,
        state: "FAILED",
        attemptCount: 1,
        attemptId: imageAttempt,
        requestDigest: `sha256:${"d".repeat(64)}`,
        remoteId: null,
        resultJson: '{"outcome":"FAILED_DEFINITE"}',
      },
      {
        partOrdinal: 3,
        state: "SUCCEEDED",
        attemptCount: 1,
        attemptId: fileAttempt,
        requestDigest: `sha256:${"e".repeat(64)}`,
        remoteId: "message-file",
        resultJson: '{"outcome":"SUCCEEDED","remoteId":"message-file"}',
      },
    ]);
  });

  it("atomically creates one audited president-instruction action and content part per recipient", async () => {
    const fixture = await storeFixture();
    const input = createInput(fixture.taskId) as Parameters<
      NotificationBatchStore["createNotificationBatch"]
    >[0];

    const created = batches(fixture.store).createNotificationBatch(input);

    expect(created).toMatchObject({
      created: true,
      batch: {
        taskId: fixture.taskId,
        recipientCount: 2,
        state: "PREPARED",
        deliveries: [
          {
            recipientOrdinal: 1,
            part: {
              recipientOrdinal: 1,
              partOrdinal: 1,
              partKind: "content",
              state: "PENDING",
              attemptCount: 0,
              remoteId: null,
              result: null,
            },
          },
          {
            recipientOrdinal: 2,
            part: {
              recipientOrdinal: 2,
              partOrdinal: 1,
              partKind: "content",
              state: "PENDING",
              attemptCount: 0,
              remoteId: null,
              result: null,
            },
          },
        ],
      },
    });
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.batch)).toBe(true);
    expect(Object.isFrozen(created.batch.deliveries)).toBe(true);
    expect(created.batch.deliveries.every(Object.isFrozen)).toBe(true);
    expect(
      created.batch.deliveries.map(({ recipientOrdinal }) => recipientOrdinal),
    ).toEqual([1, 2]);
    expect(JSON.stringify(created)).not.toMatch(
      /recipientRef|ou_|oc_|合成测试通知|batchKeyHash/,
    );

    const actionIds = created.batch.deliveries.map(({ actionId }) => actionId);
    expect(new Set(actionIds).size).toBe(2);
    const partKeys = created.batch.deliveries.map(
      ({ part }) => part.idempotencyKey,
    );
    expect(new Set(partKeys).size).toBe(2);
    expect(partKeys.every((key) => !actionIds.includes(key))).toBe(true);
    for (const [index, delivery] of created.batch.deliveries.entries()) {
      const action = fixture.store.getAction({
        actionId: delivery.actionId,
        version: 1,
      });
      expect(action).toMatchObject({
        taskId: fixture.taskId,
        capability: "notification.send.direct",
        identity: "bot",
        approvalMode: "president_instruction",
        state: "APPROVED",
        idempotencyKey: delivery.actionId,
        payload: {
          recipientRef: input.recipients[index]?.recipientRef,
          recipientBinding: input.recipients[index]?.recipientBinding,
          content: input.content,
        },
      });
    }
    expect(
      queryRows<{ count: number }>(
        fixture.filename,
        `SELECT COUNT(*) AS count
           FROM instruction_authorizations
          WHERE capability='notification.send.direct'`,
      ),
    ).toEqual([{ count: 2 }]);
    expect(
      queryRows<{ count: number }>(
        fixture.filename,
        `SELECT COUNT(*) AS count
           FROM action_transitions
           JOIN actions ON actions.id=action_transitions.action_id
          WHERE actions.capability='notification.send.direct'
            AND action_transitions.to_state='APPROVED'
            AND action_transitions.reason_code='president_instruction_approved'`,
      ),
    ).toEqual([{ count: 2 }]);
    expect(
      queryRows<{ count: number }>(
        fixture.filename,
        `SELECT COUNT(*) AS count
           FROM approvals
           JOIN actions ON actions.id=approvals.action_id
          WHERE actions.capability='notification.send.direct'`,
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("marks an expired in-flight part UNKNOWN and continues with the next ordered part after restart", async () => {
    const fixture = await storeFixture();
    const created = batches(fixture.store).createNotificationBatch(
      createInput(fixture.taskId, 1, {
        batchKey: "notification-expired-part",
        attachments: [
          {
            resourceRef: randomUUID(),
            kind: "file",
            resourceBinding: {
              relativePath: `resources/01-${randomUUID()}.bin`,
              sizeBytes: 7,
              sha256: `sha256:${"f".repeat(64)}`,
              displayName: "经营报告.pdf",
            },
          },
        ],
      }) as Parameters<NotificationBatchStore["createNotificationBatch"]>[0],
    );
    const first = batches(fixture.store).claimNextNotificationDelivery({
      batchId: created.batch.batchId,
      owner: "instance-a",
      now: at(20),
      ttlMs: 60_000,
    });
    if (first === null) throw new Error("expected first claim");
    expect(first.part).toMatchObject({
      partOrdinal: 1,
      state: "CLAIMED",
    });

    const reopened = batches(await reopenFixture(fixture));
    const next = reopened.claimNextNotificationDelivery({
      batchId: created.batch.batchId,
      owner: "instance-a",
      now: at(81),
      ttlMs: 60_000,
    });
    if (next === null) throw new Error("expected next claim");
    expect(next).toMatchObject({
      recipientOrdinal: 1,
      action: { actionId: first.action.actionId, state: "APPROVED" },
      part: { partOrdinal: 2, partKind: "file", state: "CLAIMED" },
    });
    expect(
      queryRows<{
        partOrdinal: number;
        state: string;
        attemptCount: number;
        resultJson: string | null;
      }>(
        fixture.filename,
        `SELECT part_ordinal AS partOrdinal, state,
                attempt_count AS attemptCount, result_json AS resultJson
           FROM notification_parts
          ORDER BY part_ordinal`,
      ),
    ).toEqual([
      {
        partOrdinal: 1,
        state: "UNKNOWN",
        attemptCount: 0,
        resultJson: '{"outcome":"UNKNOWN"}',
      },
      {
        partOrdinal: 2,
        state: "CLAIMED",
        attemptCount: 0,
        resultJson: null,
      },
    ]);
  });

  it("accepts one and twenty stable recipients while rejecting zero, twenty-one, duplicates, and untrusted descriptors", async () => {
    const fixture = await storeFixture();
    const store = batches(fixture.store);
    const one = store.createNotificationBatch(
      createInput(fixture.taskId, 1, {
        batchKey: "notification-one",
      }) as Parameters<NotificationBatchStore["createNotificationBatch"]>[0],
    );
    const twenty = store.createNotificationBatch(
      createInput(fixture.taskId, 20, {
        batchKey: "notification-twenty",
      }) as Parameters<NotificationBatchStore["createNotificationBatch"]>[0],
    );
    expect(
      one.batch.deliveries.map(({ recipientOrdinal }) => recipientOrdinal),
    ).toEqual([1]);
    expect(
      twenty.batch.deliveries.map(({ recipientOrdinal }) => recipientOrdinal),
    ).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));

    const duplicateRef = randomUUID();
    const sparse = [
      {
        recipientRef: randomUUID(),
        recipientBinding: { provider: "lark", recipient: "sparse-1" },
      },
      {
        recipientRef: randomUUID(),
        recipientBinding: { provider: "lark", recipient: "sparse-2" },
      },
    ];
    delete sparse[0];
    const invalidInputs = [
      createInput(fixture.taskId, 0, { batchKey: "invalid-zero" }),
      createInput(fixture.taskId, 21, { batchKey: "invalid-twenty-one" }),
      createInput(fixture.taskId, 2, {
        batchKey: "invalid-duplicate",
        recipients: [
          {
            recipientRef: duplicateRef,
            recipientBinding: { provider: "lark", recipient: "duplicate-1" },
          },
          {
            recipientRef: duplicateRef,
            recipientBinding: { provider: "lark", recipient: "duplicate-2" },
          },
        ],
      }),
      createInput(fixture.taskId, 2, {
        batchKey: "invalid-duplicate-binding",
        recipients: [
          {
            recipientRef: randomUUID(),
            recipientBinding: {
              provider: "lark",
              recipient: "duplicate-binding",
            },
          },
          {
            recipientRef: randomUUID(),
            recipientBinding: {
              provider: "lark",
              recipient: "duplicate-binding",
            },
          },
        ],
      }),
      createInput(fixture.taskId, 1, {
        batchKey: "invalid-raw-open-id",
        recipients: [
          {
            recipientRef: "ou_raw_identifier",
            recipientBinding: {
              provider: "lark",
              recipient: "opaque-binding",
            },
          },
        ],
      }),
      createInput(fixture.taskId, 1, {
        batchKey: "invalid-extra-recipient-field",
        recipients: [
          {
            recipientRef: randomUUID(),
            recipientBinding: {
              provider: "lark",
              recipient: "opaque-binding",
            },
            openId: "ou_forbidden",
          },
        ],
      }),
      createInput(fixture.taskId, 2, {
        batchKey: "invalid-sparse",
        recipients: sparse,
      }),
      createInput(fixture.taskId, 1, {
        batchKey: "invalid-content",
        content: undefined,
      }),
      {
        ...createInput(fixture.taskId, 1, {
          batchKey: "invalid-top-level-field",
        }),
        actor: "ou_forbidden",
      },
      new Proxy(createInput(fixture.taskId, 1), {}),
    ];
    for (const invalid of invalidInputs) {
      expect(() =>
        store.createNotificationBatch(
          invalid as Parameters<
            NotificationBatchStore["createNotificationBatch"]
          >[0],
        ),
      ).toThrowError(/notification_batch_input_is_invalid/);
    }
    expect(
      queryRows<{ count: number }>(
        fixture.filename,
        `SELECT COUNT(*) AS count
           FROM actions WHERE capability='notification.send.direct'`,
      ),
    ).toEqual([{ count: 21 }]);
  });

  it("rolls back the entire batch and every audited action when any recipient insert fails", async () => {
    const fixture = await storeFixture();
    mutate(
      fixture.filename,
      `CREATE TRIGGER reject_second_notification_action
       BEFORE INSERT ON actions
       WHEN NEW.capability='notification.send.direct'
        AND (
          SELECT COUNT(*) FROM actions
           WHERE capability='notification.send.direct'
        )=1
       BEGIN
         SELECT RAISE(ABORT, 'synthetic second recipient failure');
       END`,
    );

    expect(() =>
      batches(fixture.store).createNotificationBatch(
        createInput(fixture.taskId) as Parameters<
          NotificationBatchStore["createNotificationBatch"]
        >[0],
      ),
    ).toThrowError(/notification_batch_persistence_failed/);

    for (const table of [
      "notification_batches",
      "notification_parts",
      "actions",
      "instruction_authorizations",
      "action_transitions",
    ]) {
      expect(
        queryRows<{ count: number }>(
          fixture.filename,
          `SELECT COUNT(*) AS count FROM ${table}`,
        ),
      ).toEqual([{ count: 0 }]);
    }
  });

  it("replays the same canonical batch key and rejects changed recipients or content", async () => {
    const fixture = await storeFixture();
    const store = batches(fixture.store);
    const input = createInput(fixture.taskId) as Parameters<
      NotificationBatchStore["createNotificationBatch"]
    >[0];
    const first = store.createNotificationBatch(input);
    const replay = store.createNotificationBatch({
      ...input,
      now: at(11),
    });
    expect(replay).toEqual({ batch: first.batch, created: false });

    expect(() =>
      store.createNotificationBatch({
        ...input,
        content: { kind: "text", text: "冲突内容", wording: "composed" },
        now: at(12),
      }),
    ).toThrowError(/notification_batch_replay_conflict/);
    expect(() =>
      store.createNotificationBatch({
        ...input,
        recipients: [...input.recipients].reverse(),
        now: at(13),
      }),
    ).toThrowError(/notification_batch_replay_conflict/);
    expect(
      queryRows<{ batchCount: number; actionCount: number; partCount: number }>(
        fixture.filename,
        `SELECT
           (SELECT COUNT(*) FROM notification_batches) AS batchCount,
           (SELECT COUNT(*) FROM actions
             WHERE capability='notification.send.direct') AS actionCount,
           (SELECT COUNT(*) FROM notification_parts) AS partCount`,
      ),
    ).toEqual([{ batchCount: 1, actionCount: 2, partCount: 2 }]);
    expect(
      queryRows<{ batchKeyHash: string }>(
        fixture.filename,
        "SELECT batch_key_hash AS batchKeyHash FROM notification_batches",
      )[0]?.batchKeyHash,
    ).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("restores the trusted recipient binding from the audited action after process restart", async () => {
    const fixture = await storeFixture();
    const input = createInput(fixture.taskId, 1) as Parameters<
      NotificationBatchStore["createNotificationBatch"]
    >[0];
    const created = batches(fixture.store).createNotificationBatch(input);
    expect(JSON.stringify(created)).not.toContain("recipientBinding");

    const reopened = await reopenFixture(fixture);
    const claim = batches(reopened).claimNextNotificationDelivery({
      batchId: created.batch.batchId,
      owner: "instance-a",
      now: at(20),
      ttlMs: 60_000,
    });

    expect(claim).toMatchObject({
      recipientOrdinal: 1,
      action: {
        payload: {
          recipientRef: input.recipients[0]?.recipientRef,
          recipientBinding: input.recipients[0]?.recipientBinding,
          content: input.content,
        },
      },
    });
  });

  it("never reclaims terminal parts, continues after definite failure and unknown, and restores summary after reopen", async () => {
    const fixture = await storeFixture();
    const store = batches(fixture.store);
    const created = store.createNotificationBatch(
      createInput(fixture.taskId, 4) as Parameters<
        NotificationBatchStore["createNotificationBatch"]
      >[0],
    );

    expect(
      dispatchNext(store, created.batch.batchId, 1, "SUCCEEDED").summary,
    ).toMatchObject({ succeeded: 1, pending: 3 });
    expect(
      dispatchNext(store, created.batch.batchId, 2, "FAILED_DEFINITE").summary,
    ).toMatchObject({ succeeded: 1, failed: 1, pending: 2 });
    expect(
      dispatchNext(store, created.batch.batchId, 3, "UNKNOWN").summary,
    ).toMatchObject({ succeeded: 1, failed: 1, unknown: 1, pending: 1 });
    const final = dispatchNext(
      store,
      created.batch.batchId,
      4,
      "SUCCEEDED",
    ).summary;
    expect(final).toEqual({
      batchId: created.batch.batchId,
      state: "UNKNOWN",
      total: 4,
      pending: 0,
      dispatching: 0,
      succeeded: 2,
      failed: 1,
      unknown: 1,
    });
    expect(
      store.claimNextNotificationDelivery({
        batchId: created.batch.batchId,
        owner: "instance-a",
        now: at(100),
        ttlMs: 60_000,
      }),
    ).toBeNull();

    expect(
      queryRows<{
        recipientOrdinal: number;
        state: string;
        attemptCount: number;
      }>(
        fixture.filename,
        `SELECT recipient_ordinal AS recipientOrdinal, state,
                attempt_count AS attemptCount
           FROM notification_parts
          ORDER BY recipient_ordinal`,
      ),
    ).toEqual([
      { recipientOrdinal: 1, state: "SUCCEEDED", attemptCount: 1 },
      { recipientOrdinal: 2, state: "FAILED", attemptCount: 1 },
      { recipientOrdinal: 3, state: "UNKNOWN", attemptCount: 1 },
      { recipientOrdinal: 4, state: "SUCCEEDED", attemptCount: 1 },
    ]);
    expect(
      queryRows<{ actionId: string; attemptRows: number }>(
        fixture.filename,
        `SELECT actions.id AS actionId, COUNT(action_attempts.id) AS attemptRows
           FROM actions
           JOIN action_attempts ON action_attempts.action_id=actions.id
          WHERE actions.capability='notification.send.direct'
          GROUP BY actions.id`,
      ),
    ).toEqual(
      expect.arrayContaining(
        created.batch.deliveries.map(({ actionId }) => ({
          actionId,
          attemptRows: 2,
        })),
      ),
    );

    const reopened = await reopenFixture(fixture);
    expect(
      batches(reopened).getNotificationBatchSummary(created.batch.batchId),
    ).toEqual(final);
  });

  it.each([
    {
      reconciliationOutcome: "SUCCEEDED" as const,
      operatorKind: "automatic" as const,
      expected: { succeeded: 2, failed: 0, unknown: 0 },
    },
    {
      reconciliationOutcome: "FAILED" as const,
      operatorKind: "automatic" as const,
      expected: { succeeded: 1, failed: 1, unknown: 0 },
    },
    {
      reconciliationOutcome: "INDETERMINATE" as const,
      operatorKind: "manual" as const,
      expected: { succeeded: 1, failed: 0, unknown: 1 },
    },
  ])(
    "preserves the first UNKNOWN dispatch, never reclaims it, and continues the batch after $reconciliationOutcome reconciliation",
    async ({ reconciliationOutcome, operatorKind, expected }) => {
      const fixture = await storeFixture();
      const store = batches(fixture.store);
      const created = store.createNotificationBatch(
        createInput(fixture.taskId, 2) as Parameters<
          NotificationBatchStore["createNotificationBatch"]
        >[0],
      );
      const first = dispatchNext(store, created.batch.batchId, 1, "UNKNOWN");
      expect(first.summary).toMatchObject({
        state: "DISPATCHING",
        pending: 1,
        unknown: 1,
      });

      const reconciliationAttemptId = randomUUID();
      const reconciliation = store.startReconciliation({
        actionId: first.claim.action.actionId,
        version: 1,
        owner: "instance-a",
        now: at(33),
        ttlMs: 60_000,
        attemptId: reconciliationAttemptId,
        requestDigest: `sha256:${"a".repeat(64)}`,
      });
      if (reconciliation === null) {
        throw new Error("expected reconciliation claim");
      }
      expect(
        store.reconcileAction({
          actionId: first.claim.action.actionId,
          version: 1,
          owner: "instance-a",
          leaseExpiresAt: reconciliation.leaseExpiresAt,
          now: at(34),
          attemptId: reconciliationAttemptId,
          outcome: reconciliationOutcome,
          evidenceDigest: `sha256:${"b".repeat(64)}`,
          operatorKind,
          ...(reconciliationOutcome === "SUCCEEDED"
            ? { remoteId: "message-reconciled-1" }
            : {}),
        }),
      ).toMatchObject({
        state: "RECONCILED",
        reconcileOutcome: reconciliationOutcome,
      });
      expect(store.getNotificationBatchSummary(created.batch.batchId)).toEqual({
        batchId: created.batch.batchId,
        state: "DISPATCHING",
        total: 2,
        pending: 1,
        dispatching: 0,
        succeeded: expected.succeeded - 1,
        failed: expected.failed,
        unknown: expected.unknown,
      });

      const second = dispatchNext(store, created.batch.batchId, 2, "SUCCEEDED");
      expect(second.claim.action.actionId).not.toBe(
        first.claim.action.actionId,
      );
      expect(second.summary).toEqual({
        batchId: created.batch.batchId,
        state: "UNKNOWN",
        total: 2,
        pending: 0,
        dispatching: 0,
        ...expected,
      });
      expect(
        store.claimNextNotificationDelivery({
          batchId: created.batch.batchId,
          owner: "instance-a",
          now: at(50),
          ttlMs: 60_000,
        }),
      ).toBeNull();

      expect(
        queryRows<{
          state: string;
          resultJson: string | null;
          remoteId: string | null;
        }>(
          fixture.filename,
          `SELECT state, result_json AS resultJson, remote_id AS remoteId
             FROM notification_parts
            WHERE action_id=?`,
          first.claim.action.actionId,
        ),
      ).toEqual([
        {
          state: "UNKNOWN",
          resultJson: '{"outcome":"UNKNOWN"}',
          remoteId: null,
        },
      ]);

      const reopened = await reopenFixture(fixture);
      expect(
        batches(reopened).getNotificationBatchSummary(created.batch.batchId),
      ).toEqual(second.summary);
      expect(
        batches(reopened).claimNextNotificationDelivery({
          batchId: created.batch.batchId,
          owner: "instance-a",
          now: at(51),
          ttlMs: 60_000,
        }),
      ).toBeNull();
    },
  );

  it("rejects lifecycle authority extras before changing the batch", async () => {
    const fixture = await storeFixture();
    const store = batches(fixture.store);
    const created = store.createNotificationBatch(
      createInput(fixture.taskId, 1) as Parameters<
        NotificationBatchStore["createNotificationBatch"]
      >[0],
    );

    expect(() =>
      store.claimNextNotificationDelivery({
        batchId: created.batch.batchId,
        owner: "instance-a",
        now: at(20),
        ttlMs: 60_000,
        actor: "ou_forbidden",
      } as Parameters<
        NotificationBatchStore["claimNextNotificationDelivery"]
      >[0]),
    ).toThrowError(/notification_batch_input_is_invalid/);
    expect(store.getNotificationBatchSummary(created.batch.batchId)).toEqual({
      batchId: created.batch.batchId,
      state: "PREPARED",
      total: 1,
      pending: 1,
      dispatching: 0,
      succeeded: 0,
      failed: 0,
      unknown: 0,
    });
  });
});
