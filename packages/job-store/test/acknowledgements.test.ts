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
import { afterEach, describe, expect, it, vi } from "vitest";

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

function mutate(
  filename: string,
  sql: string,
  ...parameters: readonly unknown[]
): void {
  const database = new Database(filename);
  try {
    database.prepare(sql).run(...parameters);
  } finally {
    database.close();
  }
}

function seedAcknowledgementState(
  filename: string,
  taskId: string,
  state:
    | "NOT_ATTEMPTED"
    | "SENDING"
    | "RETRYABLE_DNS"
    | "ACKNOWLEDGED"
    | "AMBIGUOUS"
    | "FAILED_DEFINITE",
): void {
  if (state === "NOT_ATTEMPTED") return;
  mutate(
    filename,
    `UPDATE task_acknowledgements
        SET state = 'SENDING', attempt_count = 1, updated_at = ?
      WHERE task_id = ?`,
    at(10).toISOString(),
    taskId,
  );
  if (state === "SENDING") return;
  const failureClass =
    state === "RETRYABLE_DNS"
      ? "DNS_UNAVAILABLE"
      : state === "AMBIGUOUS"
        ? "RESULT_AMBIGUOUS"
        : state === "FAILED_DEFINITE"
          ? "REMOTE_REJECTED"
          : null;
  mutate(
    filename,
    `UPDATE task_acknowledgements
        SET state = ?, last_failure_class = ?, updated_at = ?
      WHERE task_id = ?`,
    state,
    failureClass,
    at(11).toISOString(),
    taskId,
  );
}

function acknowledge(store: JobStore, taskId: string, now: Date): void {
  expect(store.acquireRuntimeLease("bridge", "instance-a", now, 10_000)).toBe(
    true,
  );
  expect(
    store.beginTaskAcknowledgement({ taskId, owner: "instance-a", now }),
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
  it.each([
    ["RETRYABLE_DNS", "DNS_UNAVAILABLE"],
    ["ACKNOWLEDGED", null],
    ["AMBIGUOUS", "RESULT_AMBIGUOUS"],
    ["FAILED_DEFINITE", "REMOTE_REJECTED"],
  ] as const)(
    "finalizes a cancelled SENDING acknowledgement as %s without reviving the task",
    async (state, failureClass) => {
      const { runtimeDir, store } = await storeFixture();
      const first = store.ingestEvent(event(1), workspace(runtimeDir));
      const second = store.ingestEvent(event(2), workspace(runtimeDir));
      expect(
        store.acquireRuntimeLease("bridge", "instance-a", at(10), 1_000),
      ).toBe(true);
      store.bindPrincipal({
        appId: "cli_test_app",
        tenantKey: "tenant_test_001",
        presidentOpenId: "ou_synthetic_president",
        presidentChatId: "oc_synthetic_private_chat",
        pairedAt: at(10),
      });
      expect(
        store.beginTaskAcknowledgement({
          taskId: first.taskId,
          owner: "instance-a",
          now: at(11),
        }),
      ).toMatchObject({ state: "SENDING" });
      expect(
        store.cancelActiveTask({
          appId: "cli_test_app",
          tenantKey: "tenant_test_001",
          eventId: `cancel_${state}`,
          messageId: `cancel_message_${state}`,
          senderOpenId: "ou_synthetic_president",
          chatId: "oc_synthetic_private_chat",
          receivedAt: at(12).toISOString(),
        }),
      ).toMatchObject({ taskId: first.taskId, cancelled: true });

      expect(
        store.finishTaskAcknowledgement({
          taskId: first.taskId,
          owner: "instance-a",
          now: at(13),
          state,
          failureClass,
        }),
      ).toMatchObject({ state, lastFailureClass: failureClass });
      expect(store.getTask(first.taskId)?.state).toBe("CANCELLED");
      expect(
        store.beginTaskAcknowledgement({
          taskId: second.taskId,
          owner: "instance-a",
          now: at(14),
        }),
      ).toMatchObject({ taskId: second.taskId, state: "SENDING" });
    },
  );

  it.each(["CANCELLED", "INTERRUPTED_REQUIRES_CONFIRMATION"] as const)(
    "enumerates an orphan SENDING acknowledgement whose task is %s",
    async (taskState) => {
      const { filename, runtimeDir, store } = await storeFixture();
      const task = store.ingestEvent(event(), workspace(runtimeDir));
      expect(
        store.acquireRuntimeLease("bridge", "instance-a", at(10), 1_000),
      ).toBe(true);
      expect(
        store.beginTaskAcknowledgement({
          taskId: task.taskId,
          owner: "instance-a",
          now: at(11),
        }),
      ).toMatchObject({ state: "SENDING" });
      mutate(
        filename,
        "UPDATE tasks SET state = ? WHERE id = ?",
        taskState,
        task.taskId,
      );

      expect(store.listTaskAcknowledgementRecoveryCandidates()).toEqual([
        {
          taskId: task.taskId,
          workspacePath: store.getTask(task.taskId)?.workspacePath,
        },
      ]);
    },
  );

  it.each([
    ["CANCELLED", false, "AMBIGUOUS"],
    ["CANCELLED", true, "ACKNOWLEDGED"],
    ["INTERRUPTED_REQUIRES_CONFIRMATION", false, "AMBIGUOUS"],
    ["INTERRUPTED_REQUIRES_CONFIRMATION", true, "ACKNOWLEDGED"],
  ] as const)(
    "reconciles an orphan %s SENDING acknowledgement with marker=%s to %s without changing the task",
    async (taskState, markerPresent, expectedAcknowledgement) => {
      const { filename, runtimeDir, store } = await storeFixture();
      const task = store.ingestEvent(event(), workspace(runtimeDir));
      expect(
        store.acquireRuntimeLease("bridge", "instance-a", at(10), 1_000),
      ).toBe(true);
      expect(
        store.beginTaskAcknowledgement({
          taskId: task.taskId,
          owner: "instance-a",
          now: at(11),
        }),
      ).toMatchObject({ state: "SENDING" });
      mutate(
        filename,
        "UPDATE tasks SET state = ? WHERE id = ?",
        taskState,
        task.taskId,
      );

      expect(
        store.reconcileTaskAcknowledgement({
          taskId: task.taskId,
          owner: "instance-a",
          now: at(12),
          markerPresent,
        }),
      ).toMatchObject({
        state: expectedAcknowledgement,
        lastFailureClass: markerPresent ? null : "RESULT_AMBIGUOUS",
      });
      expect(store.getTask(task.taskId)?.state).toBe(taskState);
    },
  );

  it("maps local evidence failure only to AMBIGUOUS and remote rejection only to FAILED_DEFINITE", async () => {
    const { store, runtimeDir } = await storeFixture();
    const localEvidence = store.ingestEvent(event(901), workspace(runtimeDir));
    expect(
      store.acquireRuntimeLease("bridge", "instance-a", at(0), 60_000),
    ).toBe(true);
    expect(
      store.beginTaskAcknowledgement({
        taskId: localEvidence.taskId,
        owner: "instance-a",
        now: at(1),
      }),
    ).toMatchObject({ state: "SENDING" });
    expect(
      store.finishTaskAcknowledgement({
        taskId: localEvidence.taskId,
        owner: "instance-a",
        now: at(2),
        state: "AMBIGUOUS",
        failureClass: "LOCAL_EVIDENCE_FAILED",
      }),
    ).toMatchObject({
      state: "AMBIGUOUS",
      lastFailureClass: "LOCAL_EVIDENCE_FAILED",
    });

    const rejected = store.ingestEvent(event(902), workspace(runtimeDir));
    expect(
      store.beginTaskAcknowledgement({
        taskId: rejected.taskId,
        owner: "instance-a",
        now: at(3),
      }),
    ).toMatchObject({ state: "SENDING" });
    expect(
      store.finishTaskAcknowledgement({
        taskId: rejected.taskId,
        owner: "instance-a",
        now: at(4),
        state: "FAILED_DEFINITE",
        failureClass: "REMOTE_REJECTED",
      }),
    ).toMatchObject({
      state: "FAILED_DEFINITE",
      lastFailureClass: "REMOTE_REJECTED",
    });

    const invalid = store.ingestEvent(event(903), workspace(runtimeDir));
    expect(
      store.beginTaskAcknowledgement({
        taskId: invalid.taskId,
        owner: "instance-a",
        now: at(5),
      }),
    ).toMatchObject({ state: "SENDING" });
    expect(() =>
      store.finishTaskAcknowledgement({
        taskId: invalid.taskId,
        owner: "instance-a",
        now: at(6),
        state: "FAILED_DEFINITE",
        failureClass: "LOCAL_EVIDENCE_FAILED",
      }),
    ).toThrow(/task_acknowledgement_input_is_invalid/);
  });
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
    database
      .prepare("DELETE FROM task_acknowledgements WHERE task_id = ?")
      .run(taskId);
    database.close();

    expect(
      store.acquireRuntimeLease("bridge", "instance-a", at(10), 1_000),
    ).toBe(true);
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

    expect(
      store.acquireRuntimeLease("bridge", "instance-a", at(11), 1_000),
    ).toBe(true);
    expect(store.claimNextTask("instance-a", at(12), 1_000)).toBeNull();
    expect(
      store.beginTaskAcknowledgement({
        taskId: first.taskId,
        owner: "instance-a",
        now: at(13),
      }),
    ).toMatchObject({ taskId: first.taskId, state: "SENDING" });
    store.finishTaskAcknowledgement({
      taskId: first.taskId,
      owner: "instance-a",
      now: at(14),
      state: "ACKNOWLEDGED",
      failureClass: null,
    });
    expect(store.claimNextTask("instance-a", at(15), 1_000)?.id).toBe(
      first.taskId,
    );
  });

  it("begins only recoverable acknowledgement attempts under the live bridge lease", async () => {
    const { runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));

    expect(() =>
      store.beginTaskAcknowledgement({
        taskId,
        owner: "instance-a",
        now: at(10),
      }),
    ).toThrowError(/bridge_runtime_lease_is_not_live/);
    expect(
      store.acquireRuntimeLease("bridge", "instance-a", at(10), 1_000),
    ).toBe(true);
    expect(
      store.beginTaskAcknowledgement({
        taskId,
        owner: "instance-a",
        now: at(11),
      }),
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
      store.beginTaskAcknowledgement({
        taskId,
        owner: "instance-a",
        now: at(13),
      }),
    ).toMatchObject({ state: "SENDING", attemptCount: 2 });
  });

  it("leaves every acknowledgement unchanged when the expected task is not the FIFO head", async () => {
    const { runtimeDir, store } = await storeFixture();
    const first = store.ingestEvent(event(1), workspace(runtimeDir));
    const second = store.ingestEvent(event(2), workspace(runtimeDir));
    expect(
      store.acquireRuntimeLease("bridge", "instance-a", at(10), 1_000),
    ).toBe(true);

    expect(
      store.beginTaskAcknowledgement({
        taskId: second.taskId,
        owner: "instance-a",
        now: at(11),
      }),
    ).toBeNull();
    expect(store.getTaskAcknowledgement(first.taskId)).toMatchObject({
      state: "NOT_ATTEMPTED",
      attemptCount: 0,
    });
    expect(store.getTaskAcknowledgement(second.taskId)).toMatchObject({
      state: "NOT_ATTEMPTED",
      attemptCount: 0,
    });
    expect(
      store.beginTaskAcknowledgement({
        taskId: first.taskId,
        owner: "instance-a",
        now: at(12),
      }),
    ).toMatchObject({
      taskId: first.taskId,
      state: "SENDING",
      attemptCount: 1,
    });
  });

  it("enforces one global SENDING acknowledgement at the database layer", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    const first = store.ingestEvent(event(1), workspace(runtimeDir));
    const second = store.ingestEvent(event(2), workspace(runtimeDir));

    seedAcknowledgementState(filename, first.taskId, "SENDING");
    expect(() =>
      seedAcknowledgementState(filename, second.taskId, "SENDING"),
    ).toThrowError(/UNIQUE constraint failed/);
    expect(store.getTaskAcknowledgement(second.taskId)).toMatchObject({
      state: "NOT_ATTEMPTED",
      attemptCount: 0,
    });
  });

  it("fences wrong and stale acknowledgement owners without changing the row", async () => {
    const { runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    expect(store.acquireRuntimeLease("bridge", "instance-a", at(10), 10)).toBe(
      true,
    );

    expect(
      store.beginTaskAcknowledgement({
        taskId,
        owner: "instance-b",
        now: at(11),
      }),
    ).toBeNull();
    expect(store.getTaskAcknowledgement(taskId)).toMatchObject({
      state: "NOT_ATTEMPTED",
      attemptCount: 0,
    });
    expect(() =>
      store.beginTaskAcknowledgement({
        taskId,
        owner: "instance-a",
        now: at(21),
      }),
    ).toThrowError(/bridge_runtime_lease_is_not_live/);
    expect(store.getTaskAcknowledgement(taskId)).toMatchObject({
      state: "NOT_ATTEMPTED",
      attemptCount: 0,
    });
  });

  it("fences wrong-owner and stale finalization CAS attempts", async () => {
    const { runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    expect(store.acquireRuntimeLease("bridge", "instance-a", at(10), 100)).toBe(
      true,
    );
    expect(
      store.beginTaskAcknowledgement({
        taskId,
        owner: "instance-a",
        now: at(11),
      }),
    ).toMatchObject({ taskId, state: "SENDING" });

    expect(
      store.finishTaskAcknowledgement({
        taskId,
        owner: "instance-b",
        now: at(12),
        state: "ACKNOWLEDGED",
        failureClass: null,
      }),
    ).toBeNull();
    expect(store.getTaskAcknowledgement(taskId)).toMatchObject({
      state: "SENDING",
    });
    expect(() =>
      store.finishTaskAcknowledgement({
        taskId,
        owner: "instance-a",
        now: at(111),
        state: "ACKNOWLEDGED",
        failureClass: null,
      }),
    ).toThrowError(/bridge_runtime_lease_is_not_live/);
    expect(store.getTaskAcknowledgement(taskId)).toMatchObject({
      state: "SENDING",
    });
  });

  it("rejects hostile acknowledgement inputs and raw failure detail before property access", async () => {
    const { runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    expect(
      store.acquireRuntimeLease("bridge", "instance-a", at(10), 1_000),
    ).toBe(true);
    const getter = vi.fn(() => "instance-a");
    const accessor = { taskId, now: at(11) };
    Object.defineProperty(accessor, "owner", {
      enumerable: true,
      get: getter,
    });
    expect(() =>
      store.beginTaskAcknowledgement(
        accessor as unknown as Parameters<
          JobStore["beginTaskAcknowledgement"]
        >[0],
      ),
    ).toThrowError(/task_acknowledgement_input_must_be_own_data_properties/);
    expect(getter).not.toHaveBeenCalled();

    const ownKeys = vi.fn<() => ArrayLike<string | symbol>>(() => []);
    const get = vi.fn();
    expect(() =>
      store.beginTaskAcknowledgement(
        new Proxy(
          { taskId, owner: "instance-a", now: at(11) },
          { ownKeys, get },
        ),
      ),
    ).toThrowError(/task_acknowledgement_input_must_be_own_data_properties/);
    expect(ownKeys).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();

    store.beginTaskAcknowledgement({
      taskId,
      owner: "instance-a",
      now: at(11),
    });
    expect(() =>
      store.finishTaskAcknowledgement({
        taskId,
        owner: "instance-a",
        now: at(12),
        state: "FAILED_DEFINITE",
        failureClass: "REMOTE_REJECTED",
        rawError: "customer.example/private-route",
      } as unknown as Parameters<JobStore["finishTaskAcknowledgement"]>[0]),
    ).toThrowError(/task_acknowledgement_input_must_be_own_data_properties/);
    expect(store.getTaskAcknowledgement(taskId)).toMatchObject({
      state: "SENDING",
      lastFailureClass: null,
    });
  });

  it("enumerates every RECEIVED reconciliation candidate in global FIFO order", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    const later = store.ingestEvent(event(2), workspace(runtimeDir));
    const earlier = store.ingestEvent(event(1), workspace(runtimeDir));
    mutate(
      filename,
      "UPDATE tasks SET created_at = ? WHERE id = ?",
      at(2).toISOString(),
      later.taskId,
    );
    mutate(
      filename,
      "UPDATE tasks SET created_at = ? WHERE id = ?",
      at(1).toISOString(),
      earlier.taskId,
    );

    expect(store.listTaskAcknowledgementRecoveryCandidates()).toEqual([
      {
        taskId: earlier.taskId,
        workspacePath: store.getTask(earlier.taskId)?.workspacePath,
      },
      {
        taskId: later.taskId,
        workspacePath: store.getTask(later.taskId)?.workspacePath,
      },
    ]);
  });

  it("allows only the confirmed SENDING finalization transitions", async () => {
    const { runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    expect(
      store.acquireRuntimeLease("bridge", "instance-a", at(10), 1_000),
    ).toBe(true);
    expect(
      store.finishTaskAcknowledgement({
        taskId,
        owner: "instance-a",
        now: at(11),
        state: "ACKNOWLEDGED",
        failureClass: null,
      }),
    ).toBeNull();
    store.beginTaskAcknowledgement({
      taskId,
      owner: "instance-a",
      now: at(12),
    });
    expect(() =>
      store.finishTaskAcknowledgement({
        taskId,
        owner: "instance-a",
        now: at(13),
        state: "RETRYABLE_DNS",
        failureClass: "REMOTE_REJECTED",
      }),
    ).toThrowError(/task_acknowledgement_input_is_invalid/);
    expect(
      store.finishTaskAcknowledgement({
        taskId,
        owner: "instance-a",
        now: at(14),
        state: "ACKNOWLEDGED",
        failureClass: null,
      }),
    ).toMatchObject({ state: "ACKNOWLEDGED" });
    expect(
      store.finishTaskAcknowledgement({
        taskId,
        owner: "instance-a",
        now: at(15),
        state: "ACKNOWLEDGED",
        failureClass: null,
      }),
    ).toBeNull();
    expect(store.getTaskAcknowledgement(taskId)).toMatchObject({
      state: "ACKNOWLEDGED",
      attemptCount: 1,
    });
  });

  it("reconciles restart states conservatively from a durable marker", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    const acknowledged = store.ingestEvent(event(1), workspace(runtimeDir));
    const recoverable = store.ingestEvent(event(2), workspace(runtimeDir));
    const sending = store.ingestEvent(event(3), workspace(runtimeDir));
    const marker = store.ingestEvent(event(4), workspace(runtimeDir));
    expect(
      store.acquireRuntimeLease("bridge", "instance-a", at(10), 1_000),
    ).toBe(true);
    store.beginTaskAcknowledgement({
      taskId: acknowledged.taskId,
      owner: "instance-a",
      now: at(11),
    });
    store.finishTaskAcknowledgement({
      taskId: acknowledged.taskId,
      owner: "instance-a",
      now: at(12),
      state: "ACKNOWLEDGED",
      failureClass: null,
    });
    let database = new Database(filename);
    database
      .prepare("UPDATE tasks SET state = 'CLAIMED' WHERE id = ?")
      .run(acknowledged.taskId);
    database.close();
    store.beginTaskAcknowledgement({
      taskId: recoverable.taskId,
      owner: "instance-a",
      now: at(13),
    });
    store.finishTaskAcknowledgement({
      taskId: recoverable.taskId,
      owner: "instance-a",
      now: at(14),
      state: "RETRYABLE_DNS",
      failureClass: "DNS_UNAVAILABLE",
    });
    expect(
      store.reconcileTaskAcknowledgement({
        taskId: recoverable.taskId,
        owner: "instance-a",
        now: at(14),
        markerPresent: false,
      }),
    ).toMatchObject({ state: "RETRYABLE_DNS" });
    store.beginTaskAcknowledgement({
      taskId: recoverable.taskId,
      owner: "instance-a",
      now: at(15),
    });
    store.finishTaskAcknowledgement({
      taskId: recoverable.taskId,
      owner: "instance-a",
      now: at(16),
      state: "ACKNOWLEDGED",
      failureClass: null,
    });
    database = new Database(filename);
    database
      .prepare("UPDATE tasks SET state = 'CLAIMED' WHERE id = ?")
      .run(recoverable.taskId);
    database.close();
    store.beginTaskAcknowledgement({
      taskId: sending.taskId,
      owner: "instance-a",
      now: at(17),
    });
    database = new Database(filename);
    database
      .prepare("DELETE FROM task_acknowledgements WHERE task_id = ?")
      .run(marker.taskId);
    database.close();

    expect(
      store.reconcileTaskAcknowledgement({
        taskId: marker.taskId,
        owner: "instance-a",
        now: at(20),
        markerPresent: true,
      }),
    ).toMatchObject({ state: "ACKNOWLEDGED" });
    expect(
      store.reconcileTaskAcknowledgement({
        taskId: sending.taskId,
        owner: "instance-a",
        now: at(20),
        markerPresent: false,
      }),
    ).toMatchObject({
      state: "AMBIGUOUS",
      lastFailureClass: "RESULT_AMBIGUOUS",
    });
    expect(store.getTask(sending.taskId)).toMatchObject({
      state: "INTERRUPTED_REQUIRES_CONFIRMATION",
    });
  });

  it.each([
    [null, false, null, "INTERRUPTED_REQUIRES_CONFIRMATION"],
    [null, true, "ACKNOWLEDGED", "RECEIVED"],
    ["NOT_ATTEMPTED", false, "NOT_ATTEMPTED", "RECEIVED"],
    ["NOT_ATTEMPTED", true, null, "INTERRUPTED_REQUIRES_CONFIRMATION"],
    ["RETRYABLE_DNS", false, "RETRYABLE_DNS", "RECEIVED"],
    ["RETRYABLE_DNS", true, null, "INTERRUPTED_REQUIRES_CONFIRMATION"],
    ["SENDING", false, "AMBIGUOUS", "INTERRUPTED_REQUIRES_CONFIRMATION"],
    ["SENDING", true, "ACKNOWLEDGED", "RECEIVED"],
    ["ACKNOWLEDGED", false, null, "INTERRUPTED_REQUIRES_CONFIRMATION"],
    ["ACKNOWLEDGED", true, "ACKNOWLEDGED", "RECEIVED"],
    ["AMBIGUOUS", false, null, "INTERRUPTED_REQUIRES_CONFIRMATION"],
    ["AMBIGUOUS", true, null, "INTERRUPTED_REQUIRES_CONFIRMATION"],
    ["FAILED_DEFINITE", false, null, "INTERRUPTED_REQUIRES_CONFIRMATION"],
    ["FAILED_DEFINITE", true, null, "INTERRUPTED_REQUIRES_CONFIRMATION"],
  ] as const)(
    "reconciles state %s with marker=%s to acknowledgement=%s task=%s",
    async (
      state,
      markerPresent,
      expectedAcknowledgement,
      expectedTaskState,
    ) => {
      const { filename, runtimeDir, store } = await storeFixture();
      const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
      if (state === null) {
        mutate(
          filename,
          "DELETE FROM task_acknowledgements WHERE task_id = ?",
          taskId,
        );
      } else {
        seedAcknowledgementState(filename, taskId, state);
      }
      expect(
        store.acquireRuntimeLease("bridge", "instance-a", at(20), 1_000),
      ).toBe(true);

      const result = store.reconcileTaskAcknowledgement({
        taskId,
        owner: "instance-a",
        now: at(21),
        markerPresent,
      });

      expect(result?.state ?? null).toBe(expectedAcknowledgement);
      expect(store.getTask(taskId)?.state).toBe(expectedTaskState);
    },
  );

  it("persists only classified acknowledgement failures", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    expect(
      store.acquireRuntimeLease("bridge", "instance-a", at(10), 1_000),
    ).toBe(true);
    store.beginTaskAcknowledgement({
      taskId,
      owner: "instance-a",
      now: at(11),
    });
    store.finishTaskAcknowledgement({
      taskId,
      owner: "instance-a",
      now: at(12),
      state: "AMBIGUOUS",
      failureClass: "LOCAL_EVIDENCE_FAILED",
    });
    const persisted = JSON.stringify(
      inspect(filename, "SELECT * FROM task_acknowledgements"),
    );
    expect(persisted).not.toContain("https://customer.example/route");
    expect(persisted).not.toContain("customer message body");
    expect(persisted).not.toContain("raw remote error");
    expect(persisted).toContain("LOCAL_EVIDENCE_FAILED");
  });
});
