import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InboundEvent } from "@executive-assistant/contracts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireDatabaseFileLock,
  openJobStore,
  RuntimeStateError,
  type DatabaseFileLock,
  type JobStore,
} from "../src/index.js";

const temporaryPaths: string[] = [];
const openStores: JobStore[] = [];
const fileLocks: DatabaseFileLock[] = [];

afterEach(async () => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
  for (const lock of fileLocks.splice(0)) {
    await lock.release();
  }
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function createRuntimeDirectory(): string {
  const path = mkdtempSync(
    join(realpathSync(tmpdir()), "executive-assistant-event-store-"),
  );
  chmodSync(path, 0o700);
  temporaryPaths.push(path);
  return path;
}

function createWorkspace(
  runtimeDir: string,
  taskId: string = randomUUID(),
): string {
  const jobsDir = join(runtimeDir, "jobs");
  mkdirSync(jobsDir, { mode: 0o700, recursive: true });
  const workspacePath = join(jobsDir, taskId);
  mkdirSync(workspacePath, { mode: 0o700 });
  return workspacePath;
}

async function openStorePair(): Promise<{
  filename: string;
  runtimeDir: string;
  lock: DatabaseFileLock;
  first: JobStore;
  second: JobStore;
}> {
  const runtimeDir = createRuntimeDirectory();
  const filename = join(runtimeDir, "assistant.sqlite");
  const lock = await acquireDatabaseFileLock(runtimeDir);
  fileLocks.push(lock);
  const first = openJobStore({ filename, instanceId: "instance-a", lock });
  const second = openJobStore({ filename, instanceId: "instance-b", lock });
  openStores.push(first, second);
  return { filename, runtimeDir, lock, first, second };
}

async function openStore(): Promise<{
  filename: string;
  runtimeDir: string;
  store: JobStore;
}> {
  const { filename, runtimeDir, first, second } = await openStorePair();
  second.close();
  openStores.splice(openStores.indexOf(second), 1);
  return { filename, runtimeDir, store: first };
}

function inspect<T>(filename: string, query: string): T[] {
  const database = new Database(filename, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return database.prepare(query).all() as T[];
  } finally {
    database.close();
  }
}

function event(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    appId: "cli_test_app",
    tenantKey: "tenant_test_001",
    eventId: "event_test_001",
    messageId: "message_test_001",
    senderOpenId: "ou_synthetic_president",
    chatId: "oc_synthetic_private_chat",
    chatType: "p2p",
    eventType: "im.message.receive_v1",
    receivedAt: "2026-07-22T08:00:00.000Z",
    payloadRef: `sha256:${"a".repeat(64)}`,
    ...overrides,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("JobStore.ingestEvent", () => {
  it("atomically creates one inbound event and one ROOT task, then deduplicates an exact replay", async () => {
    const { filename, runtimeDir, store } = await openStore();
    const workspacePath = createWorkspace(runtimeDir);
    const inbound = event();

    const first = store.ingestEvent(inbound, workspacePath);
    const replay = store.ingestEvent(inbound, workspacePath);

    expect(first).toEqual({
      taskId: workspacePath.split("/").at(-1),
      duplicate: false,
    });
    expect(replay).toEqual({ taskId: first.taskId, duplicate: true });
    expect(
      inspect<{ count: number }>(
        filename,
        "SELECT COUNT(*) AS count FROM inbound_events",
      ),
    ).toEqual([{ count: 1 }]);
    expect(
      inspect<{
        id: string;
        taskKind: string;
        state: string;
        stage: string;
        workspacePath: string;
      }>(
        filename,
        `SELECT id, task_kind AS taskKind, state, stage,
                workspace_path AS workspacePath
           FROM tasks`,
      ),
    ).toEqual([
      {
        id: first.taskId,
        taskKind: "ROOT",
        state: "RECEIVED",
        stage: "accepted",
        workspacePath,
      },
    ]);
  });

  it("rolls the inbound event back when task insertion fails", async () => {
    const { filename, runtimeDir, store } = await openStore();
    const workspacePath = createWorkspace(runtimeDir);
    const setup = new Database(filename);
    setup.exec(`
      CREATE TRIGGER test_fail_task_insert
      BEFORE INSERT ON tasks
      BEGIN SELECT RAISE(ABORT, 'synthetic task insert failure'); END;
    `);
    setup.close();

    expect(() => store.ingestEvent(event(), workspacePath)).toThrowError(
      new RuntimeStateError("inbound_event_persistence_failed"),
    );
    expect(
      inspect<{ events: number; tasks: number }>(
        filename,
        `SELECT
           (SELECT COUNT(*) FROM inbound_events) AS events,
           (SELECT COUNT(*) FROM tasks) AS tasks`,
      ),
    ).toEqual([{ events: 0, tasks: 0 }]);
  });

  it("rolls the inbound event and task back when acknowledgement insertion fails", async () => {
    const { filename, runtimeDir, store } = await openStore();
    const workspacePath = createWorkspace(runtimeDir);
    const setup = new Database(filename);
    setup.exec(`
      CREATE TRIGGER test_fail_acknowledgement_insert
      BEFORE INSERT ON task_acknowledgements
      BEGIN SELECT RAISE(ABORT, 'synthetic acknowledgement insert failure'); END;
    `);
    setup.close();

    expect(() => store.ingestEvent(event(), workspacePath)).toThrowError(
      new RuntimeStateError("inbound_event_persistence_failed"),
    );
    expect(
      inspect<{ events: number; tasks: number; acknowledgements: number }>(
        filename,
        `SELECT
           (SELECT COUNT(*) FROM inbound_events) AS events,
           (SELECT COUNT(*) FROM tasks) AS tasks,
           (SELECT COUNT(*) FROM task_acknowledgements) AS acknowledgements`,
      ),
    ).toEqual([{ events: 0, tasks: 0, acknowledgements: 0 }]);
  });

  it("persists hashes instead of raw sender and chat identifiers", async () => {
    const { filename, runtimeDir, store } = await openStore();
    const workspacePath = createWorkspace(runtimeDir);
    const inbound = event();

    store.ingestEvent(inbound, workspacePath);

    const [row] = inspect<{
      senderHash: string;
      chatHash: string;
      allStoredText: string;
    }>(
      filename,
      `SELECT sender_open_id_hash AS senderHash,
              chat_id_hash AS chatHash,
              app_id || tenant_key || event_id || message_id ||
                sender_open_id_hash || chat_id_hash || payload_ref ||
                received_at AS allStoredText
         FROM inbound_events`,
    );
    expect(row).toEqual({
      senderHash: sha256(inbound.senderOpenId),
      chatHash: sha256(inbound.chatId),
      allStoredText: expect.not.stringContaining(inbound.senderOpenId),
    });
    expect(row?.allStoredText).not.toContain(inbound.chatId);
  });

  it("fails closed when immutable event fields drift but returns the original task for a new safe candidate workspace", async () => {
    const { runtimeDir, store } = await openStore();
    const workspacePath = createWorkspace(runtimeDir);
    const otherWorkspacePath = createWorkspace(runtimeDir);
    const inbound = event();
    store.ingestEvent(inbound, workspacePath);

    expect(() =>
      store.ingestEvent(
        event({ messageId: "message_test_changed" }),
        workspacePath,
      ),
    ).toThrowError(/inbound_event_replay_conflict/);
    expect(store.ingestEvent(inbound, otherWorkspacePath)).toEqual({
      taskId: workspacePath.split("/").at(-1),
      duplicate: true,
    });
  });

  it("fails closed if the replay root task is missing or its path basename differs from its task id", async () => {
    const firstCase = await openStore();
    const firstWorkspace = createWorkspace(firstCase.runtimeDir);
    firstCase.store.ingestEvent(event(), firstWorkspace);
    const deleteTask = new Database(firstCase.filename);
    deleteTask.exec("DELETE FROM tasks");
    deleteTask.close();
    expect(() =>
      firstCase.store.ingestEvent(event(), firstWorkspace),
    ).toThrowError(/inbound_event_root_task_missing/);

    const secondCase = await openStore();
    const secondWorkspace = createWorkspace(secondCase.runtimeDir);
    const mismatchedWorkspace = createWorkspace(secondCase.runtimeDir);
    secondCase.store.ingestEvent(
      event({ eventId: "event_test_002", messageId: "message_test_002" }),
      secondWorkspace,
    );
    const changePath = new Database(secondCase.filename);
    changePath
      .prepare("UPDATE tasks SET workspace_path = ?")
      .run(mismatchedWorkspace);
    changePath.close();
    expect(() =>
      secondCase.store.ingestEvent(
        event({ eventId: "event_test_002", messageId: "message_test_002" }),
        mismatchedWorkspace,
      ),
    ).toThrowError(/inbound_event_task_identity_invalid/);
  });

  it("snapshots exact own data fields and rejects adversarial event inputs without invoking accessors or Proxy traps", async () => {
    const { runtimeDir, store } = await openStore();
    const workspacePath = createWorkspace(runtimeDir);
    const getter = vi.fn(() => "cli_test_app");
    const accessorEvent = event() as InboundEvent;
    Object.defineProperty(accessorEvent, "appId", {
      enumerable: true,
      get: getter,
    });
    expect(() => store.ingestEvent(accessorEvent, workspacePath)).toThrowError(
      /inbound_event_must_be_own_data_properties/,
    );
    expect(getter).not.toHaveBeenCalled();

    const ownKeys = vi.fn<() => ArrayLike<string | symbol>>(() => []);
    const get = vi.fn();
    const proxyEvent = new Proxy(event(), { ownKeys, get });
    expect(() => store.ingestEvent(proxyEvent, workspacePath)).toThrowError(
      /inbound_event_must_be_own_data_properties/,
    );
    expect(ownKeys).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();

    expect(() =>
      store.ingestEvent(
        { ...event(), unexpected: "no" } as unknown as InboundEvent,
        workspacePath,
      ),
    ).toThrowError(/inbound_event_must_be_own_data_properties/);
    expect(() =>
      store.ingestEvent(
        { ...event(), [Symbol("unexpected")]: "no" },
        workspacePath,
      ),
    ).toThrowError(/inbound_event_must_be_own_data_properties/);
    const missing = event() as Partial<InboundEvent>;
    delete missing.messageId;
    expect(() =>
      store.ingestEvent(missing as InboundEvent, workspacePath),
    ).toThrowError(/inbound_event_must_be_own_data_properties/);
    expect(() =>
      store.ingestEvent(
        Object.assign(Object.create({}), event()) as InboundEvent,
        workspacePath,
      ),
    ).toThrowError(/inbound_event_must_be_own_data_properties/);
    expect(() =>
      store.ingestEvent([] as unknown as InboundEvent, workspacePath),
    ).toThrowError(/inbound_event_must_be_own_data_properties/);
  });

  it("does not invoke polluted Object.prototype accessors or persist their replacement values", async () => {
    const { filename, runtimeDir, store } = await openStore();
    const workspacePath = createWorkspace(runtimeDir);
    const inbound = event({
      eventId: "event_prototype_pollution",
      messageId: "message_prototype_pollution",
    });
    const replacement = new Map<keyof InboundEvent, string>([
      ["appId", "attacker_app"],
      ["tenantKey", "attacker_tenant"],
      ["eventId", "attacker_event"],
      ["messageId", "attacker_message"],
      ["senderOpenId", "attacker_sender"],
      ["chatId", "attacker_chat"],
      ["chatType", "p2p"],
      ["eventType", "im.message.receive_v1"],
      ["receivedAt", "2026-07-23T08:00:00.000Z"],
      ["payloadRef", `sha256:${"b".repeat(64)}`],
    ]);
    const accesses = new Map<
      keyof InboundEvent,
      Readonly<{ gets: number; sets: number }>
    >();
    const originals = new Map<keyof InboundEvent, PropertyDescriptor>();
    let result: ReturnType<JobStore["ingestEvent"]> | undefined;
    let caught: unknown;

    for (const key of replacement.keys()) {
      const original = Object.getOwnPropertyDescriptor(Object.prototype, key);
      if (original !== undefined) originals.set(key, original);
      accesses.set(key, { gets: 0, sets: 0 });
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        get() {
          const current = accesses.get(key)!;
          accesses.set(key, { gets: current.gets + 1, sets: current.sets });
          return replacement.get(key);
        },
        set() {
          const current = accesses.get(key)!;
          accesses.set(key, { gets: current.gets, sets: current.sets + 1 });
        },
      });
    }

    try {
      result = store.ingestEvent(inbound, workspacePath);
    } catch (error) {
      caught = error;
    } finally {
      for (const key of replacement.keys()) {
        const original = originals.get(key);
        if (original === undefined) {
          delete (Object.prototype as Record<string, unknown>)[key];
        } else {
          Object.defineProperty(Object.prototype, key, original);
        }
      }
    }

    expect(caught).toBeUndefined();
    expect([...accesses.values()]).toEqual(
      [...replacement.keys()].map(() => ({ gets: 0, sets: 0 })),
    );
    expect(result).toEqual({
      taskId: workspacePath.split("/").at(-1),
      duplicate: false,
    });
    expect(
      inspect<{
        appId: string;
        tenantKey: string;
        eventId: string;
        messageId: string;
        senderOpenIdHash: string;
        chatIdHash: string;
        payloadRef: string;
        receivedAt: string;
      }>(
        filename,
        `SELECT app_id AS appId, tenant_key AS tenantKey,
                event_id AS eventId, message_id AS messageId,
                sender_open_id_hash AS senderOpenIdHash,
                chat_id_hash AS chatIdHash, payload_ref AS payloadRef,
                received_at AS receivedAt
           FROM inbound_events`,
      ),
    ).toEqual([
      {
        appId: inbound.appId,
        tenantKey: inbound.tenantKey,
        eventId: inbound.eventId,
        messageId: inbound.messageId,
        senderOpenIdHash: sha256(inbound.senderOpenId),
        chatIdHash: sha256(inbound.chatId),
        payloadRef: inbound.payloadRef,
        receivedAt: inbound.receivedAt,
      },
    ]);
  });

  it("rejects invalid event values and non-private, relative, symlink, or non-UUID workspaces before persistence", async () => {
    const { runtimeDir, store } = await openStore();
    const validWorkspace = createWorkspace(runtimeDir);
    expect(() =>
      store.ingestEvent(event({ chatType: "group" as "p2p" }), validWorkspace),
    ).toThrowError(/inbound_event_is_invalid/);

    const publicWorkspace = createWorkspace(runtimeDir);
    chmodSync(publicWorkspace, 0o755);
    expect(() => store.ingestEvent(event(), publicWorkspace)).toThrowError(
      /runtime_directory_is_not_private/,
    );
    expect(() => store.ingestEvent(event(), "relative/workspace")).toThrowError(
      /runtime_directory_must_be_absolute/,
    );
    const nonUuidWorkspace = createWorkspace(runtimeDir, "not-a-uuid");
    expect(() => store.ingestEvent(event(), nonUuidWorkspace)).toThrowError(
      /workspace_task_id_is_invalid/,
    );
    const symlink = join(runtimeDir, "workspace-link");
    symlinkSync(validWorkspace, symlink);
    expect(() => store.ingestEvent(event(), symlink)).toThrowError(
      /runtime_directory_is_not_private/,
    );
  });

  it("returns an exact frozen result", async () => {
    const { runtimeDir, store } = await openStore();
    const result = store.ingestEvent(event(), createWorkspace(runtimeDir));

    expect(Reflect.ownKeys(result)).toEqual(["taskId", "duplicate"]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("deduplicates through two stores sharing one active file lock without a constraint error", async () => {
    const { filename, runtimeDir, first, second } = await openStorePair();
    const firstWorkspacePath = createWorkspace(runtimeDir);
    const replayWorkspacePath = createWorkspace(runtimeDir);
    const inbound = event();

    const results = [
      first.ingestEvent(inbound, firstWorkspacePath),
      second.ingestEvent(inbound, replayWorkspacePath),
    ];

    expect(results).toEqual([
      { taskId: firstWorkspacePath.split("/").at(-1), duplicate: false },
      { taskId: firstWorkspacePath.split("/").at(-1), duplicate: true },
    ]);
    expect(
      inspect<{ events: number; tasks: number }>(
        filename,
        `SELECT
           (SELECT COUNT(*) FROM inbound_events) AS events,
           (SELECT COUNT(*) FROM tasks) AS tasks`,
      ),
    ).toEqual([{ events: 1, tasks: 1 }]);
  });
});
