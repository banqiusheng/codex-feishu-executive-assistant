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

function at(milliseconds: number): Date {
  return new Date(Date.UTC(2026, 6, 25, 8, 0, 0, milliseconds));
}

function event(sequence = 1): InboundEvent {
  return {
    appId: "cli_test_app",
    tenantKey: "tenant_test_001",
    eventId: `event_${sequence}`,
    messageId: `message_${sequence}`,
    senderOpenId: "ou_synthetic_president",
    chatId: "oc_synthetic_private_chat",
    chatType: "p2p",
    eventType: "im.message.receive_v1",
    receivedAt: at(sequence).toISOString(),
    payloadRef: `sha256:${"a".repeat(64)}`,
  };
}

function workspace(runtimeDir: string, taskId = randomUUID()): string {
  const jobs = join(runtimeDir, "jobs");
  mkdirSync(jobs, { recursive: true, mode: 0o700 });
  const path = join(jobs, taskId);
  mkdirSync(path, { mode: 0o700 });
  return path;
}

async function storeFixture(): Promise<{
  filename: string;
  runtimeDir: string;
  store: JobStore;
}> {
  const runtimeDir = mkdtempSync(
    join(realpathSync(tmpdir()), "job-store-acknowledgements-"),
  );
  chmodSync(runtimeDir, 0o700);
  temporaryPaths.push(runtimeDir);
  const filename = join(runtimeDir, "assistant.sqlite");
  const lock = await acquireDatabaseFileLock(runtimeDir);
  fileLocks.push(lock);
  const store = openJobStore({ filename, instanceId: "instance-a", lock });
  openStores.push(store);
  return { filename, runtimeDir, store };
}

function inspect<T>(filename: string, query: string): readonly T[] {
  const database = new Database(filename, { readonly: true });
  try {
    return database.prepare(query).all() as T[];
  } finally {
    database.close();
  }
}

function acknowledge(store: JobStore, taskId: string, now: Date): void {
  expect(store.acquireRuntimeLease("bridge", "instance-a", now, 10_000)).toBe(
    true,
  );
  expect(
    store.beginNextTaskAcknowledgement({ owner: "instance-a", now }),
  ).toMatchObject({ state: "SENDING", attemptCount: 1 });
  expect(
    store.finishTaskAcknowledgement({
      taskId,
      owner: "instance-a",
      now,
      state: "ACKNOWLEDGED",
      failureClass: null,
    }),
  ).toMatchObject({ state: "ACKNOWLEDGED" });
}

describe("task acknowledgement ledger", () => {
  it("atomically records a NOT_ATTEMPTED row with each new root task", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));

    expect(store.getTaskAcknowledgement(taskId)).toMatchObject({
      taskId,
      state: "NOT_ATTEMPTED",
      attemptCount: 0,
      lastFailureClass: null,
    });
    expect(
      inspect<{ taskId: string; state: string }>(
        filename,
        `SELECT task_id AS taskId, state FROM task_acknowledgements`,
      ),
    ).toEqual([{ taskId, state: "NOT_ATTEMPTED" }]);
  });

  it("gives a replacement task its own NOT_ATTEMPTED acknowledgement row", async () => {
    const { runtimeDir, store } = await storeFixture();
    const original = store.ingestEvent(event(), workspace(runtimeDir));
    acknowledge(store, original.taskId, at(10));
    const claimed = store.claimNextTask("instance-a", at(11), 1);
    expect(claimed?.id).toBe(original.taskId);
    store.recoverOnStartup(at(20));

    const replacement = store.createReplacementTask(
      original.taskId,
      at(21),
      workspace(runtimeDir),
    );
    expect(replacement?.duplicate).toBe(false);
    expect(store.getTaskAcknowledgement(replacement!.task.id)).toMatchObject({
      state: "NOT_ATTEMPTED",
      attemptCount: 0,
    });
  });

  it("never claims a legacy RECEIVED task without an acknowledgement row", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    const database = new Database(filename);
    database.prepare("DELETE FROM task_acknowledgements WHERE task_id = ?").run(taskId);
    database.close();

    expect(store.acquireRuntimeLease("bridge", "instance-a", at(10), 1_000)).toBe(
      true,
    );
    expect(store.claimNextTask("instance-a", at(11), 1_000)).toBeNull();
  });

  it("does not skip the global oldest RECEIVED task when only a later task is ACKNOWLEDGED", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    const first = store.ingestEvent(event(1), workspace(runtimeDir));
    const second = store.ingestEvent(event(2), workspace(runtimeDir));
    const database = new Database(filename);
    database
      .prepare(
        `UPDATE task_acknowledgements
            SET state = 'SENDING', updated_at = ?
          WHERE task_id = ?`,
      )
      .run(at(10).toISOString(), second.taskId);
    database
      .prepare(
        `UPDATE task_acknowledgements
            SET state = 'ACKNOWLEDGED', updated_at = ?
          WHERE task_id = ?`,
      )
      .run(at(10).toISOString(), second.taskId);
    database.close();

    expect(store.acquireRuntimeLease("bridge", "instance-a", at(11), 1_000)).toBe(
      true,
    );
    expect(store.claimNextTask("instance-a", at(12), 1_000)).toBeNull();
    expect(
      store.beginNextTaskAcknowledgement({ owner: "instance-a", now: at(13) }),
    ).toMatchObject({ taskId: first.taskId, state: "SENDING" });
    store.finishTaskAcknowledgement({
      taskId: first.taskId,
      owner: "instance-a",
      now: at(14),
      state: "ACKNOWLEDGED",
      failureClass: null,
    });
    expect(store.claimNextTask("instance-a", at(15), 1_000)?.id).toBe(first.taskId);
  });

  it("begins only recoverable acknowledgement attempts under the live bridge lease", async () => {
    const { runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));

    expect(() =>
      store.beginNextTaskAcknowledgement({ owner: "instance-a", now: at(10) }),
    ).toThrowError(/bridge_runtime_lease_is_not_live/);
    expect(store.acquireRuntimeLease("bridge", "instance-a", at(10), 1_000)).toBe(
      true,
    );
    expect(
      store.beginNextTaskAcknowledgement({ owner: "instance-a", now: at(11) }),
    ).toMatchObject({ state: "SENDING", attemptCount: 1 });
    expect(
      store.finishTaskAcknowledgement({
        taskId,
        owner: "instance-a",
        now: at(12),
        state: "RETRYABLE_DNS",
        failureClass: "DNS_UNAVAILABLE",
      }),
    ).toMatchObject({ state: "RETRYABLE_DNS" });
    expect(
      store.beginNextTaskAcknowledgement({ owner: "instance-a", now: at(13) }),
    ).toMatchObject({ state: "SENDING", attemptCount: 2 });
  });

  it("allows only the confirmed SENDING finalization transitions", async () => {
    const { runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    expect(store.acquireRuntimeLease("bridge", "instance-a", at(10), 1_000)).toBe(
      true,
    );
    expect(
      store.finishTaskAcknowledgement({
        taskId,
        owner: "instance-a",
        now: at(11),
        state: "ACKNOWLEDGED",
        failureClass: null,
      }),
    ).toBeNull();
    store.beginNextTaskAcknowledgement({ owner: "instance-a", now: at(12) });
    expect(() =>
      store.finishTaskAcknowledgement({
        taskId,
        owner: "instance-a",
        now: at(13),
        state: "RETRYABLE_DNS",
        failureClass: "REMOTE_REJECTED",
      }),
    ).toThrowError(/task_acknowledgement_input_is_invalid/);
  });

  it("reconciles restart states conservatively from a durable marker", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    const acknowledged = store.ingestEvent(event(1), workspace(runtimeDir));
    const recoverable = store.ingestEvent(event(2), workspace(runtimeDir));
    const sending = store.ingestEvent(event(3), workspace(runtimeDir));
    const marker = store.ingestEvent(event(4), workspace(runtimeDir));
    expect(store.acquireRuntimeLease("bridge", "instance-a", at(10), 1_000)).toBe(
      true,
    );
    store.beginNextTaskAcknowledgement({ owner: "instance-a", now: at(11) });
    store.finishTaskAcknowledgement({ taskId: acknowledged.taskId, owner: "instance-a", now: at(12), state: "ACKNOWLEDGED", failureClass: null });
    let database = new Database(filename);
    database.prepare("UPDATE tasks SET state = 'CLAIMED' WHERE id = ?").run(acknowledged.taskId);
    database.close();
    store.beginNextTaskAcknowledgement({ owner: "instance-a", now: at(13) });
    store.finishTaskAcknowledgement({ taskId: recoverable.taskId, owner: "instance-a", now: at(14), state: "RETRYABLE_DNS", failureClass: "DNS_UNAVAILABLE" });
    expect(store.reconcileTaskAcknowledgement({ taskId: recoverable.taskId, owner: "instance-a", now: at(14), markerPresent: false })).toMatchObject({ state: "RETRYABLE_DNS" });
    store.beginNextTaskAcknowledgement({ owner: "instance-a", now: at(15) });
    store.finishTaskAcknowledgement({ taskId: recoverable.taskId, owner: "instance-a", now: at(16), state: "ACKNOWLEDGED", failureClass: null });
    database = new Database(filename);
    database.prepare("UPDATE tasks SET state = 'CLAIMED' WHERE id = ?").run(recoverable.taskId);
    database.close();
    store.beginNextTaskAcknowledgement({ owner: "instance-a", now: at(17) });
    database = new Database(filename);
    database.prepare("DELETE FROM task_acknowledgements WHERE task_id = ?").run(marker.taskId);
    database.close();

    expect(store.reconcileTaskAcknowledgement({ taskId: marker.taskId, owner: "instance-a", now: at(20), markerPresent: true })).toMatchObject({ state: "ACKNOWLEDGED" });
    expect(store.reconcileTaskAcknowledgement({ taskId: sending.taskId, owner: "instance-a", now: at(20), markerPresent: false })).toBeNull();
    expect(store.getTask(sending.taskId)).toMatchObject({ state: "INTERRUPTED_REQUIRES_CONFIRMATION" });
  });

  it("persists only classified acknowledgement failures", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    expect(store.acquireRuntimeLease("bridge", "instance-a", at(10), 1_000)).toBe(
      true,
    );
    store.beginNextTaskAcknowledgement({ owner: "instance-a", now: at(11) });
    store.finishTaskAcknowledgement({ taskId, owner: "instance-a", now: at(12), state: "FAILED_DEFINITE", failureClass: "LOCAL_EVIDENCE_FAILED" });
    const persisted = JSON.stringify(
      inspect(filename, "SELECT * FROM task_acknowledgements"),
    );
    expect(persisted).not.toContain("https://customer.example/route");
    expect(persisted).not.toContain("customer message body");
    expect(persisted).not.toContain("raw remote error");
    expect(persisted).toContain("LOCAL_EVIDENCE_FAILED");
  });
});
