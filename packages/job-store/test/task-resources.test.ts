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

type TaskResourceKind = "text" | "image" | "file";
type TaskResourceDescriptor = Readonly<{
  sourceKind: "current" | "quoted";
  sourceMessageHash: string;
  kind: TaskResourceKind;
  displayName: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
}>;
type TaskResourceSummary = Readonly<{
  resourceRef: string;
  kind: TaskResourceKind;
  displayName: string;
  sizeBytes: number;
}>;
type ResolvedTaskResource = TaskResourceSummary &
  Readonly<{
    sourceKind: "current" | "quoted";
    sourceMessageHash: string;
    relativePath: string;
    sha256: string;
  }>;
type TaskResourceStore = JobStore & {
  registerTaskResourcesForTask(
    taskId: string,
    descriptors: readonly TaskResourceDescriptor[],
    now: Date,
  ): readonly TaskResourceSummary[];
  resolveTaskResourceForTask(
    taskId: string,
    resourceRef: string,
    expectedKind?: TaskResourceKind,
  ): ResolvedTaskResource;
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
  return new Date(Date.UTC(2026, 6, 30, 2, 0, seconds));
}

function event(suffix = "1"): InboundEvent {
  return {
    appId: "cli_test_app",
    tenantKey: "tenant_test_001",
    eventId: `event_task_resource_${suffix}`,
    messageId: `message_task_resource_${suffix}`,
    senderOpenId: "ou_synthetic_president",
    chatId: "oc_synthetic_private_chat",
    chatType: "p2p",
    eventType: "im.message.receive_v1",
    receivedAt: at(0).toISOString(),
    payloadRef: `sha256:${suffix.padEnd(64, "a").slice(0, 64)}`,
  };
}

function resources(store: JobStore): TaskResourceStore {
  return store as TaskResourceStore;
}

async function storeFixture(
  targetState: "RECEIVED" | "CLAIMED" | "RUNNING" = "RUNNING",
): Promise<StoreFixture> {
  const runtimeDir = mkdtempSync(
    join(realpathSync(tmpdir()), "job-store-task-resources-"),
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
  if (targetState !== "RECEIVED") {
    expect(store.claimNextTask("instance-a", at(2), 3_600_000)).toMatchObject({
      id: taskId,
      state: "CLAIMED",
    });
  }
  if (targetState === "RUNNING") {
    expect(
      store.markRunning({
        taskId,
        owner: "instance-a",
        codexSessionId: "codex-session-task-resources",
        now: at(3),
        ttlMs: 3_600_000,
      }),
    ).toMatchObject({ id: taskId, state: "RUNNING" });
  }
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

function descriptor(
  suffix = "a",
  patch: Readonly<Record<string, unknown>> = {},
): TaskResourceDescriptor {
  return {
    sourceKind: "current",
    sourceMessageHash: suffix.repeat(64).slice(0, 64),
    kind: "file",
    displayName: `合成附件-${suffix}.pdf`,
    relativePath: `resources/${suffix}/fixture-${suffix}.pdf`,
    sizeBytes: 7,
    sha256: suffix.repeat(64).slice(0, 64),
    ...patch,
  } as TaskResourceDescriptor;
}

function rows<T>(
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

function insertTaskResourcesFromSeparateConnection(
  filename: string,
  taskId: string,
  sizes: readonly number[],
): void {
  const database = new Database(filename);
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    const insert = database.prepare(
      `INSERT INTO task_resources(
         id, task_id, resource_ref, source_kind, source_message_hash,
         kind, display_name, relative_path, size_bytes, sha256, created_at
       ) VALUES (?, ?, ?, 'current', ?, 'file', ?, ?, ?, ?, ?)`,
    );
    database.transaction(() => {
      for (const [index, sizeBytes] of sizes.entries()) {
        insert.run(
          randomUUID(),
          taskId,
          randomUUID(),
          "a".repeat(64),
          `external-${index}.bin`,
          `resources/external/file-${index}.bin`,
          sizeBytes,
          "b".repeat(64),
          at(10).toISOString(),
        );
      }
    })();
  } finally {
    database.close();
  }
}

describe("trusted task resource ledger", () => {
  it("registers resources for the current live CLAIMED task before a Codex session exists", async () => {
    const fixture = await storeFixture("CLAIMED");

    const registered = resources(fixture.store).registerTaskResourcesForTask(
      fixture.taskId,
      [descriptor("a")],
      at(10),
    );

    expect(registered).toMatchObject([
      {
        kind: "file",
        displayName: "合成附件-a.pdf",
        sizeBytes: 7,
      },
    ]);
    expect(fixture.store.getTask(fixture.taskId)).toMatchObject({
      state: "CLAIMED",
      leaseOwner: "instance-a",
      codexSessionId: null,
    });
  });

  it("keeps lease validation on runtime time while timestamping evidence no earlier than a skewed inbound event", async () => {
    const fixture = await storeFixture("CLAIMED");
    mutate(
      fixture.filename,
      "UPDATE tasks SET created_at=? WHERE id=?",
      at(20).toISOString(),
      fixture.taskId,
    );

    expect(
      resources(fixture.store).registerTaskResourcesForTask(
        fixture.taskId,
        [descriptor("a")],
        at(10),
      ),
    ).toHaveLength(1);
    expect(
      rows<{ createdAt: string }>(
        fixture.filename,
        "SELECT created_at AS createdAt FROM task_resources WHERE task_id=?",
        fixture.taskId,
      ),
    ).toEqual([{ createdAt: at(20).toISOString() }]);
  });

  it("atomically registers safe resources and exposes only opaque public summaries", async () => {
    const fixture = await storeFixture();
    const descriptors = [
      descriptor("a", {
        sourceKind: "current",
        kind: "text",
        displayName: "会议纪要.txt",
        relativePath: "resources/current/meeting.txt",
        sizeBytes: 0,
      }),
      descriptor("b", {
        sourceKind: "quoted",
        kind: "image",
        displayName: "现场照片.png",
        relativePath: "resources/quoted/photo.png",
        sizeBytes: 104_857_600,
      }),
      descriptor("c", {
        sourceKind: "quoted",
        kind: "file",
        displayName: "经营报告.pdf",
        relativePath: "resources/quoted/report.pdf",
        sizeBytes: 104_857_600,
      }),
    ] as const;

    const registered = resources(fixture.store).registerTaskResourcesForTask(
      fixture.taskId,
      descriptors,
      at(10),
    );

    expect(registered).toMatchObject([
      {
        kind: "text",
        displayName: "会议纪要.txt",
        sizeBytes: 0,
      },
      {
        kind: "image",
        displayName: "现场照片.png",
        sizeBytes: 104_857_600,
      },
      {
        kind: "file",
        displayName: "经营报告.pdf",
        sizeBytes: 104_857_600,
      },
    ]);
    expect(registered.map(({ resourceRef }) => resourceRef)).toEqual([
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    ]);
    expect(new Set(registered.map(({ resourceRef }) => resourceRef)).size).toBe(
      3,
    );
    expect(Object.isFrozen(registered)).toBe(true);
    expect(registered.every(Object.isFrozen)).toBe(true);
    expect(JSON.stringify(registered)).not.toMatch(
      /relativePath|resources\/|sha256|sourceKind|sourceMessageHash|taskId/,
    );
    expect(
      rows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM task_resources",
      ),
    ).toEqual([{ count: 3 }]);
  });

  it("resolves one task-bound trusted resource by opaque ref and survives reopen", async () => {
    const fixture = await storeFixture();
    const input = descriptor("d", {
      sourceKind: "quoted",
      kind: "image",
      displayName: "现场照片.png",
      relativePath: "resources/quoted/photo-d.png",
      sizeBytes: 1_024,
    });
    const [registered] = resources(fixture.store).registerTaskResourcesForTask(
      fixture.taskId,
      [input],
      at(10),
    );
    if (registered === undefined)
      throw new Error("missing registered resource");

    const resolved = resources(fixture.store).resolveTaskResourceForTask(
      fixture.taskId,
      registered.resourceRef,
      "image",
    );
    expect(resolved).toEqual({
      resourceRef: registered.resourceRef,
      sourceKind: "quoted",
      sourceMessageHash: "d".repeat(64),
      kind: "image",
      displayName: "现场照片.png",
      relativePath: "resources/quoted/photo-d.png",
      sizeBytes: 1_024,
      sha256: "d".repeat(64),
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(() =>
      resources(fixture.store).resolveTaskResourceForTask(
        fixture.taskId,
        registered.resourceRef,
        "file",
      ),
    ).toThrowError(/task_resource_kind_mismatch/);

    const secondWorkspace = join(fixture.runtimeDir, "jobs", randomUUID());
    mkdirSync(secondWorkspace, { mode: 0o700 });
    const { taskId: otherTaskId } = fixture.store.ingestEvent(
      event("2"),
      secondWorkspace,
    );
    expect(() =>
      resources(fixture.store).resolveTaskResourceForTask(
        otherTaskId,
        registered.resourceRef,
      ),
    ).toThrowError(/task_resource_not_found/);

    const reopened = await reopenFixture(fixture);
    expect(
      resources(reopened).resolveTaskResourceForTask(
        fixture.taskId,
        registered.resourceRef,
      ),
    ).toEqual(resolved);
  });

  it("replays an identical canonical source without another row and conflicts on changed immutable metadata", async () => {
    const fixture = await storeFixture();
    const store = resources(fixture.store);
    const input = descriptor("e");
    const first = store.registerTaskResourcesForTask(
      fixture.taskId,
      [input],
      at(10),
    );
    const replay = store.registerTaskResourcesForTask(
      fixture.taskId,
      [input, input],
      at(11),
    );
    expect(replay).toEqual([first[0], first[0]]);
    expect(
      rows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM task_resources",
      ),
    ).toEqual([{ count: 1 }]);

    for (const patch of [
      { displayName: "changed.pdf" },
      { sourceKind: "quoted" },
      { sourceMessageHash: "f".repeat(64) },
      { kind: "image" },
      { sizeBytes: 8 },
      { sha256: "f".repeat(64) },
    ]) {
      expect(() =>
        store.registerTaskResourcesForTask(
          fixture.taskId,
          [descriptor("e", patch)],
          at(12),
        ),
      ).toThrowError(/task_resource_replay_conflict/);
    }
    expect(
      rows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM task_resources",
      ),
    ).toEqual([{ count: 1 }]);
  });

  it("enforces the 20-resource limit cumulatively across registrations", async () => {
    const fixture = await storeFixture();
    const store = resources(fixture.store);
    const firstTwenty = Array.from({ length: 20 }, (_, index) =>
      descriptor(String(index % 10), {
        displayName: `count-${index}.bin`,
        relativePath: `resources/count/file-${index}.bin`,
        sizeBytes: 1,
      }),
    );

    expect(
      store.registerTaskResourcesForTask(fixture.taskId, firstTwenty, at(10)),
    ).toHaveLength(20);
    expect(() =>
      store.registerTaskResourcesForTask(
        fixture.taskId,
        [
          descriptor("a", {
            displayName: "count-overflow.bin",
            relativePath: "resources/count/overflow.bin",
            sizeBytes: 1,
          }),
        ],
        at(11),
      ),
    ).toThrowError(/task_resource_persistence_failed/);
    expect(
      rows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM task_resources WHERE task_id=?",
        fixture.taskId,
      ),
    ).toEqual([{ count: 20 }]);
  });

  it("enforces the 200 MiB limit cumulatively while allowing the exact boundary", async () => {
    const fixture = await storeFixture();
    const store = resources(fixture.store);
    const oneHundredMiB = 100 * 1024 * 1024;

    expect(
      store.registerTaskResourcesForTask(
        fixture.taskId,
        [
          descriptor("a", {
            relativePath: "resources/size/first.bin",
            sizeBytes: oneHundredMiB,
          }),
        ],
        at(10),
      ),
    ).toHaveLength(1);
    expect(
      store.registerTaskResourcesForTask(
        fixture.taskId,
        [
          descriptor("b", {
            relativePath: "resources/size/second.bin",
            sizeBytes: oneHundredMiB,
          }),
        ],
        at(11),
      ),
    ).toHaveLength(1);
    expect(() =>
      store.registerTaskResourcesForTask(
        fixture.taskId,
        [
          descriptor("c", {
            relativePath: "resources/size/overflow.bin",
            sizeBytes: 1,
          }),
        ],
        at(12),
      ),
    ).toThrowError(/task_resource_persistence_failed/);
    expect(
      rows<{ count: number; totalSizeBytes: number }>(
        fixture.filename,
        `SELECT COUNT(*) AS count, SUM(size_bytes) AS totalSizeBytes
           FROM task_resources WHERE task_id=?`,
        fixture.taskId,
      ),
    ).toEqual([{ count: 2, totalSizeBytes: 200 * 1024 * 1024 }]);
  });

  it("does not count persisted replays again at the cumulative boundary", async () => {
    const fixture = await storeFixture();
    const store = resources(fixture.store);
    const firstNineteen = Array.from({ length: 19 }, (_, index) =>
      descriptor(String(index % 10), {
        displayName: `replay-boundary-${index}.bin`,
        relativePath: `resources/replay-boundary/file-${index}.bin`,
        sizeBytes: 1,
      }),
    );
    const registered = store.registerTaskResourcesForTask(
      fixture.taskId,
      firstNineteen,
      at(10),
    );
    const twentieth = descriptor("a", {
      displayName: "replay-boundary-19.bin",
      relativePath: "resources/replay-boundary/file-19.bin",
      sizeBytes: 1,
    });

    const boundary = store.registerTaskResourcesForTask(
      fixture.taskId,
      [firstNineteen[0] as TaskResourceDescriptor, twentieth],
      at(11),
    );
    expect(boundary[0]).toEqual(registered[0]);
    expect(boundary).toHaveLength(2);
    expect(() =>
      store.registerTaskResourcesForTask(
        fixture.taskId,
        [
          firstNineteen[0] as TaskResourceDescriptor,
          descriptor("b", {
            displayName: "replay-boundary-overflow.bin",
            relativePath: "resources/replay-boundary/overflow.bin",
            sizeBytes: 1,
          }),
        ],
        at(12),
      ),
    ).toThrowError(/task_resource_persistence_failed/);
    expect(
      rows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM task_resources WHERE task_id=?",
        fixture.taskId,
      ),
    ).toEqual([{ count: 20 }]);
  });

  it("fails closed on cumulative count or size corruption committed by another connection", async () => {
    for (const sizes of [
      Array.from({ length: 21 }, () => 1),
      [100 * 1024 * 1024, 100 * 1024 * 1024, 1],
    ]) {
      const fixture = await storeFixture();
      insertTaskResourcesFromSeparateConnection(
        fixture.filename,
        fixture.taskId,
        sizes,
      );

      expect(() =>
        resources(fixture.store).registerTaskResourcesForTask(
          fixture.taskId,
          [
            descriptor("c", {
              relativePath: "resources/current/new-after-corruption.bin",
            }),
          ],
          at(11),
        ),
      ).toThrowError(/task_resource_persistence_failed/);
      expect(
        rows<{ count: number }>(
          fixture.filename,
          "SELECT COUNT(*) AS count FROM task_resources WHERE task_id=?",
          fixture.taskId,
        ),
      ).toEqual([{ count: sizes.length }]);
      expect(
        rows<{ count: number }>(
          fixture.filename,
          `SELECT COUNT(*) AS count FROM task_resources
            WHERE task_id=? AND relative_path=?`,
          fixture.taskId,
          "resources/current/new-after-corruption.bin",
        ),
      ).toEqual([{ count: 0 }]);
    }
  });

  it("rolls back every new row when a later insert or replay conflicts", async () => {
    const fixture = await storeFixture();
    const store = resources(fixture.store);
    store.registerTaskResourcesForTask(
      fixture.taskId,
      [descriptor("a")],
      at(10),
    );

    expect(() =>
      store.registerTaskResourcesForTask(
        fixture.taskId,
        [descriptor("b"), descriptor("a", { displayName: "conflict.pdf" })],
        at(11),
      ),
    ).toThrowError(/task_resource_replay_conflict/);
    expect(
      rows<{ path: string }>(
        fixture.filename,
        "SELECT relative_path AS path FROM task_resources ORDER BY path",
      ),
    ).toEqual([{ path: "resources/a/fixture-a.pdf" }]);

    mutate(
      fixture.filename,
      `CREATE TRIGGER reject_second_task_resource
       BEFORE INSERT ON task_resources
       WHEN NEW.relative_path='resources/c/fixture-c.pdf'
       BEGIN
         SELECT RAISE(ABORT, 'synthetic resource failure');
       END`,
    );
    expect(() =>
      store.registerTaskResourcesForTask(
        fixture.taskId,
        [descriptor("b"), descriptor("c")],
        at(12),
      ),
    ).toThrowError(/task_resource_persistence_failed/);
    expect(
      rows<{ path: string }>(
        fixture.filename,
        "SELECT relative_path AS path FROM task_resources ORDER BY path",
      ),
    ).toEqual([{ path: "resources/a/fixture-a.pdf" }]);
  });

  it("requires a consistent executable task lease and live bridge lease before writing", async () => {
    const noBridge = await storeFixture();
    expect(noBridge.store.releaseRuntimeLease("bridge", "instance-a")).toBe(
      true,
    );
    expect(() =>
      resources(noBridge.store).registerTaskResourcesForTask(
        noBridge.taskId,
        [descriptor("a")],
        at(10),
      ),
    ).toThrowError(/task_resource_task_is_not_executable/);

    const wrongTaskOwner = await storeFixture();
    mutate(
      wrongTaskOwner.filename,
      "UPDATE tasks SET lease_owner='instance-b' WHERE id=?",
      wrongTaskOwner.taskId,
    );
    expect(() =>
      resources(wrongTaskOwner.store).registerTaskResourcesForTask(
        wrongTaskOwner.taskId,
        [descriptor("b")],
        at(10),
      ),
    ).toThrowError(/task_resource_task_is_not_executable/);

    const finishedTask = await storeFixture();
    expect(
      finishedTask.store.finishTask({
        taskId: finishedTask.taskId,
        owner: "instance-a",
        codexSessionId: "codex-session-task-resources",
        now: at(9),
        outcome: "SUCCEEDED",
      }),
    ).toMatchObject({ state: "SUCCEEDED" });
    expect(() =>
      resources(finishedTask.store).registerTaskResourcesForTask(
        finishedTask.taskId,
        [descriptor("c")],
        at(10),
      ),
    ).toThrowError(/task_resource_task_is_not_executable/);

    const receivedTask = await storeFixture("RECEIVED");
    expect(() =>
      resources(receivedTask.store).registerTaskResourcesForTask(
        receivedTask.taskId,
        [descriptor("d")],
        at(10),
      ),
    ).toThrowError(/task_resource_task_is_not_executable/);

    const expiredClaim = await storeFixture("CLAIMED");
    mutate(
      expiredClaim.filename,
      "UPDATE tasks SET lease_expires_at=? WHERE id=?",
      at(5).toISOString(),
      expiredClaim.taskId,
    );
    expect(() =>
      resources(expiredClaim.store).registerTaskResourcesForTask(
        expiredClaim.taskId,
        [descriptor("e")],
        at(10),
      ),
    ).toThrowError(/task_resource_task_is_not_executable/);

    const inconsistentClaim = await storeFixture("CLAIMED");
    mutate(
      inconsistentClaim.filename,
      "UPDATE tasks SET codex_session_id='unexpected-session' WHERE id=?",
      inconsistentClaim.taskId,
    );
    expect(() =>
      resources(inconsistentClaim.store).registerTaskResourcesForTask(
        inconsistentClaim.taskId,
        [descriptor("f")],
        at(10),
      ),
    ).toThrowError(/task_resource_task_is_not_executable/);

    const inconsistentRunning = await storeFixture();
    mutate(
      inconsistentRunning.filename,
      "UPDATE tasks SET codex_session_id=NULL WHERE id=?",
      inconsistentRunning.taskId,
    );
    expect(() =>
      resources(inconsistentRunning.store).registerTaskResourcesForTask(
        inconsistentRunning.taskId,
        [descriptor("1")],
        at(10),
      ),
    ).toThrowError(/task_resource_task_is_not_executable/);

    for (const fixture of [
      noBridge,
      wrongTaskOwner,
      finishedTask,
      receivedTask,
      expiredClaim,
      inconsistentClaim,
      inconsistentRunning,
    ]) {
      expect(
        rows<{ count: number }>(
          fixture.filename,
          "SELECT COUNT(*) AS count FROM task_resources",
        ),
      ).toEqual([{ count: 0 }]);
    }
  });

  it("rejects malformed descriptor collections, authority extras, and unsafe paths before writing", async () => {
    const fixture = await storeFixture();
    const store = resources(fixture.store);
    const sparse = [descriptor("a"), descriptor("b")];
    delete sparse[0];
    const accessor = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(descriptor("a"))) {
      Object.defineProperty(
        accessor,
        key,
        key === "displayName"
          ? { enumerable: true, get: () => "getter.pdf" }
          : { enumerable: true, value },
      );
    }
    const dateDescriptor = new Date() as Date & Record<string, unknown>;
    Object.assign(dateDescriptor, descriptor("a"));
    const overLimit = Array.from({ length: 21 }, (_, index) =>
      descriptor((index % 10).toString(), {
        relativePath: `resources/limit/file-${index}.bin`,
      }),
    );
    const invalidCollections: unknown[] = [
      [],
      overLimit,
      sparse,
      new Proxy([descriptor("a")], {}),
      [new Proxy(descriptor("a"), {})],
      [accessor],
      [dateDescriptor],
      [
        {
          ...descriptor("a"),
          actor: "ou_forbidden",
        },
      ],
      [
        {
          ...descriptor("a"),
          chatId: "oc_forbidden",
        },
      ],
      [
        {
          ...descriptor("a"),
          absolutePath: "/tmp/forbidden",
        },
      ],
      [
        {
          ...descriptor("a"),
          fileKey: "file_v3_forbidden",
        },
      ],
      [
        {
          ...descriptor("a"),
          url: "https://example.invalid/file",
        },
      ],
    ];
    for (const invalid of invalidCollections) {
      expect(() =>
        store.registerTaskResourcesForTask(
          fixture.taskId,
          invalid as readonly TaskResourceDescriptor[],
          at(10),
        ),
      ).toThrowError(/task_resource_input_is_invalid/);
    }

    for (const relativePath of [
      "/resources/file.pdf",
      "../resources/file.pdf",
      "resources/../file.pdf",
      "resources/./file.pdf",
      "resources/\0file.pdf",
      "resources\\file.pdf",
      "resources//file.pdf",
      "resources/",
      "resources",
      "other/file.pdf",
      "resources/file name.pdf",
    ]) {
      expect(() =>
        store.registerTaskResourcesForTask(
          fixture.taskId,
          [descriptor("a", { relativePath })],
          at(10),
        ),
      ).toThrowError(/task_resource_input_is_invalid/);
    }

    const invalidDates = [
      new Date(Number.NaN),
      Object.assign(new Date(), { authority: "forbidden" }),
      new Proxy(new Date(), {}),
    ];
    for (const now of invalidDates) {
      expect(() =>
        store.registerTaskResourcesForTask(
          fixture.taskId,
          [descriptor("a")],
          now,
        ),
      ).toThrowError(/task_resource_input_is_invalid/);
    }
    expect(
      rows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM task_resources",
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("enforces kinds, lowercase hashes, per-resource size, and total size limits", async () => {
    const fixture = await storeFixture();
    const store = resources(fixture.store);
    const invalidDescriptors = [
      descriptor("a", { sourceKind: "forwarded" }),
      descriptor("a", { kind: "sticker" }),
      descriptor("a", { sourceMessageHash: "A".repeat(64) }),
      descriptor("a", { sourceMessageHash: `sha256:${"a".repeat(64)}` }),
      descriptor("a", { sha256: "A".repeat(64) }),
      descriptor("a", { sha256: `sha256:${"a".repeat(64)}` }),
      descriptor("a", { sizeBytes: -1 }),
      descriptor("a", { sizeBytes: 104_857_601 }),
      descriptor("a", { sizeBytes: 1.5 }),
      descriptor("a", { displayName: "" }),
    ];
    for (const invalid of invalidDescriptors) {
      expect(() =>
        store.registerTaskResourcesForTask(fixture.taskId, [invalid], at(10)),
      ).toThrowError(/task_resource_input_is_invalid/);
    }
    expect(() =>
      store.registerTaskResourcesForTask(
        fixture.taskId,
        [
          descriptor("a", {
            relativePath: "resources/size/a.bin",
            sizeBytes: 104_857_600,
          }),
          descriptor("b", {
            relativePath: "resources/size/b.bin",
            sizeBytes: 104_857_600,
          }),
          descriptor("c", {
            relativePath: "resources/size/c.bin",
            sizeBytes: 1,
          }),
        ],
        at(10),
      ),
    ).toThrowError(/task_resource_input_is_invalid/);
    expect(
      rows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM task_resources",
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("fails closed when an append-only resource row is corrupted", async () => {
    const fixture = await storeFixture();
    const [registered] = resources(fixture.store).registerTaskResourcesForTask(
      fixture.taskId,
      [descriptor("f")],
      at(10),
    );
    if (registered === undefined)
      throw new Error("missing registered resource");
    mutate(fixture.filename, "DROP TRIGGER task_resources_append_only_update");
    mutate(
      fixture.filename,
      "UPDATE task_resources SET relative_path='../escape' WHERE resource_ref=?",
      registered.resourceRef,
    );

    expect(() =>
      resources(fixture.store).resolveTaskResourceForTask(
        fixture.taskId,
        registered.resourceRef,
      ),
    ).toThrowError(/task_resource_persistence_failed/);
    expect(() =>
      resources(fixture.store).registerTaskResourcesForTask(
        fixture.taskId,
        [descriptor("f")],
        at(11),
      ),
    ).toThrowError(/task_resource_persistence_failed/);
  });
});
