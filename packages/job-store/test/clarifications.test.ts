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
  type ActionJsonValue,
  type ClarificationValueValidator,
  type DatabaseFileLock,
  type JobStore,
} from "../src/index.js";
import { consumeClarificationForTask as consumeDirect } from "../src/clarifications.js";
import * as clarificationOperations from "../src/clarifications.js";

type DirectBatchConsume = (
  database: Database.Database,
  instanceId: string,
  taskId: string,
  optionRefs: readonly string[],
  expectedKind: ClarificationKind,
  now: Date,
) => readonly Readonly<Record<string, unknown>>[];

function consumeBatchDirect(
  database: Database.Database,
  instanceId: string,
  taskId: string,
  optionRefs: readonly string[],
  expectedKind: ClarificationKind,
  now: Date,
): readonly Readonly<Record<string, unknown>>[] {
  return (
    clarificationOperations as unknown as {
      consumeClarificationsForTask: DirectBatchConsume;
    }
  ).consumeClarificationsForTask(
    database,
    instanceId,
    taskId,
    optionRefs,
    expectedKind,
    now,
  );
}

type ClarificationKind = "contact" | "base" | "table";

type ClarificationStore = JobStore & {
  writeClarificationGroupForTask(input: {
    taskId: string;
    kind: ClarificationKind;
    groupLabel: string;
    options: readonly {
      value: unknown;
      displayLabel: string;
    }[];
    now: Date;
  }): Readonly<Record<string, unknown>>;
  listPendingClarificationsForTask(
    taskId: string,
    now: Date,
  ): readonly unknown[];
  consumeClarificationForTask(
    taskId: string,
    optionRef: string,
    expectedKind: ClarificationKind,
    now: Date,
  ): Readonly<Record<string, unknown>>;
  consumeClarificationsForTask(
    taskId: string,
    optionRefs: readonly string[],
    expectedKind: ClarificationKind,
    now: Date,
  ): readonly Readonly<Record<string, unknown>>[];
};

type OptionFixture = Readonly<{
  ordinal: number;
  optionRef: string;
  valueJson: string;
  displayLabel: string;
  payloadHash?: string;
}>;

type GroupFixture = Readonly<{
  groupId: string;
  groupLabel: string;
  kind: ClarificationKind;
  sourceTaskId: string;
  principalHash: string;
  chatHash: string;
  createdAt: Date;
  expiresAt?: Date;
  options: readonly OptionFixture[];
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
  return new Date(Date.UTC(2026, 6, 29, 8, 0, seconds));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function payloadHash(valueJson: string): string {
  return `sha256:${createHash("sha256")
    .update(valueJson, "utf8")
    .digest("hex")}`;
}

function asClarificationStore(store: JobStore): ClarificationStore {
  return store as ClarificationStore;
}

async function storeFixture(): Promise<{
  filename: string;
  runtimeDir: string;
  store: JobStore;
  lock: DatabaseFileLock;
}> {
  const runtimeDir = mkdtempSync(
    join(realpathSync(tmpdir()), "job-store-clarifications-"),
  );
  chmodSync(runtimeDir, 0o700);
  temporaryPaths.push(runtimeDir);
  mkdirSync(join(runtimeDir, "jobs"), { mode: 0o700 });
  const lock = await acquireDatabaseFileLock(runtimeDir);
  fileLocks.push(lock);
  const filename = join(runtimeDir, "assistant.sqlite");
  const store = openJobStore({
    filename,
    instanceId: "instance-a",
    lock,
  });
  openStores.push(store);
  expect(
    store.acquireRuntimeLease("bridge", "instance-a", at(-100), 604_800_000),
  ).toBe(true);
  return { filename, runtimeDir, store, lock };
}

async function reopenFixture(
  fixture: Readonly<{
    filename: string;
    runtimeDir: string;
    store: JobStore;
    lock: DatabaseFileLock;
  }>,
): Promise<JobStore> {
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

function inboundEvent(
  sequence: number,
  actor: string,
  chat: string,
): InboundEvent {
  return {
    appId: "cli_test_app",
    tenantKey: "tenant_test_001",
    eventId: `event_clarification_${sequence}`,
    messageId: `message_clarification_${sequence}`,
    senderOpenId: actor,
    chatId: chat,
    chatType: "p2p",
    eventType: "im.message.receive_v1",
    receivedAt: at(sequence * 20).toISOString(),
    payloadRef: `sha256:${sequence.toString(16).padStart(64, "0")}`,
  };
}

function startTask(
  fixture: Readonly<{ runtimeDir: string; store: JobStore }>,
  sequence: number,
  actor = "ou_synthetic_president",
  chat = "oc_synthetic_private_chat",
): Readonly<{ taskId: string; actorHash: string; chatHash: string }> {
  const workspacePath = join(fixture.runtimeDir, "jobs", randomUUID());
  mkdirSync(workspacePath, { mode: 0o700 });
  const { taskId } = fixture.store.ingestEvent(
    inboundEvent(sequence, actor, chat),
    workspacePath,
  );
  expect(
    fixture.store.beginTaskAcknowledgement({
      taskId,
      owner: "instance-a",
      now: at(sequence * 20 + 1),
    }),
  ).toMatchObject({ state: "SENDING" });
  expect(
    fixture.store.finishTaskAcknowledgement({
      taskId,
      owner: "instance-a",
      now: at(sequence * 20 + 2),
      state: "ACKNOWLEDGED",
      failureClass: null,
    }),
  ).toMatchObject({ state: "ACKNOWLEDGED" });
  expect(
    fixture.store.claimNextTask(
      "instance-a",
      at(sequence * 20 + 3),
      604_800_000,
    ),
  ).toMatchObject({ id: taskId, state: "CLAIMED" });
  expect(
    fixture.store.markRunning({
      taskId,
      owner: "instance-a",
      codexSessionId: `codex-session-${sequence}`,
      now: at(sequence * 20 + 4),
      ttlMs: 604_800_000,
    }),
  ).toMatchObject({ id: taskId, state: "RUNNING" });
  return Object.freeze({
    taskId,
    actorHash: sha256(actor),
    chatHash: sha256(chat),
  });
}

function finishTask(store: JobStore, taskId: string, sequence: number): void {
  expect(
    store.finishTask({
      taskId,
      owner: "instance-a",
      codexSessionId: `codex-session-${sequence}`,
      now: at(sequence * 20 + 10),
      outcome: "SUCCEEDED",
    }),
  ).toMatchObject({ id: taskId, state: "SUCCEEDED" });
}

function seedAdditionalRunningTask(
  fixture: Readonly<{ runtimeDir: string; store: JobStore; filename: string }>,
  sequence: number,
): Readonly<{ taskId: string; actorHash: string; chatHash: string }> {
  const workspacePath = join(fixture.runtimeDir, "jobs", randomUUID());
  mkdirSync(workspacePath, { mode: 0o700 });
  const actor = "ou_synthetic_president";
  const chat = "oc_synthetic_private_chat";
  const { taskId } = fixture.store.ingestEvent(
    inboundEvent(sequence, actor, chat),
    workspacePath,
  );
  expect(
    fixture.store.beginTaskAcknowledgement({
      taskId,
      owner: "instance-a",
      now: at(sequence * 20 + 1),
    }),
  ).toMatchObject({ state: "SENDING" });
  expect(
    fixture.store.finishTaskAcknowledgement({
      taskId,
      owner: "instance-a",
      now: at(sequence * 20 + 2),
      state: "ACKNOWLEDGED",
      failureClass: null,
    }),
  ).toMatchObject({ state: "ACKNOWLEDGED" });
  mutate(
    fixture.filename,
    `UPDATE tasks
        SET state='CLAIMED', lease_owner='instance-a', lease_expires_at=?,
            last_event_at=?, updated_at=?
      WHERE id=? AND state='RECEIVED'`,
    at(604_800 + sequence * 20 + 3).toISOString(),
    at(sequence * 20 + 3).toISOString(),
    at(sequence * 20 + 3).toISOString(),
    taskId,
  );
  mutate(
    fixture.filename,
    `UPDATE tasks
        SET state='RUNNING', codex_session_id=?, lease_expires_at=?,
            last_event_at=?, updated_at=?
      WHERE id=? AND state='CLAIMED'`,
    `codex-session-${sequence}`,
    at(604_800 + sequence * 20 + 4).toISOString(),
    at(sequence * 20 + 4).toISOString(),
    at(sequence * 20 + 4).toISOString(),
    taskId,
  );
  return Object.freeze({
    taskId,
    actorHash: sha256(actor),
    chatHash: sha256(chat),
  });
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

function seedGroup(filename: string, group: GroupFixture): void {
  const expiresAt =
    group.expiresAt ??
    new Date(group.createdAt.getTime() + 24 * 60 * 60 * 1_000);
  const database = new Database(filename);
  try {
    database.pragma("foreign_keys = ON");
    const insert = database.prepare(
      `INSERT INTO clarification_options(
         group_id, group_label, option_ordinal, option_ref, kind,
         source_task_id, principal_hash, chat_hash, value_json,
         display_label, expires_at, payload_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    database.transaction(() => {
      for (const option of group.options) {
        insert.run(
          group.groupId,
          group.groupLabel,
          option.ordinal,
          option.optionRef,
          group.kind,
          group.sourceTaskId,
          group.principalHash,
          group.chatHash,
          option.valueJson,
          option.displayLabel,
          expiresAt.toISOString(),
          option.payloadHash ?? payloadHash(option.valueJson),
          group.createdAt.toISOString(),
        );
      }
    })();
  } finally {
    database.close();
  }
}

describe("clarification ledger", () => {
  it("writes an opaque public group from the running task context and survives reopen", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    const input = {
      taskId: source.taskId,
      kind: "contact" as const,
      groupLabel: "选择联系人",
      options: [
        {
          value: {
            department: "融创中国-文旅事业部",
            openId: "ou_internal_first",
          },
          displayLabel: "张伟｜融创中国-文旅事业部",
        },
        {
          value: {
            department: "融创中国-热雪奇迹",
            openId: "ou_internal_second",
          },
          displayLabel: "张伟｜融创中国-热雪奇迹",
        },
      ],
      now: at(25),
    };

    const written = asClarificationStore(
      fixture.store,
    ).writeClarificationGroupForTask(input);

    expect(written).toMatchObject({
      groupLabel: "选择联系人",
      kind: "contact",
      expiresAt: at(86_425).toISOString(),
      options: [
        {
          ordinal: 1,
          displayLabel: "张伟｜融创中国-文旅事业部",
        },
        {
          ordinal: 2,
          displayLabel: "张伟｜融创中国-热雪奇迹",
        },
      ],
    });
    const publicGroup = written as {
      groupId: string;
      expiresAt: string;
      options: readonly { optionRef: string }[];
    };
    expect(publicGroup.groupId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(publicGroup.options.map(({ optionRef }) => optionRef)).toEqual([
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    ]);
    expect(
      new Set(publicGroup.options.map(({ optionRef }) => optionRef)).size,
    ).toBe(2);
    expect(Object.isFrozen(written)).toBe(true);
    expect(Object.isFrozen(written.options)).toBe(true);
    expect((written.options as readonly unknown[]).every(Object.isFrozen)).toBe(
      true,
    );
    expect(JSON.stringify(written)).not.toMatch(
      /value|openId|ou_internal|principal|chat|payloadHash/,
    );

    const persisted = queryRows<{
      groupId: string;
      optionRef: string;
      ordinal: number;
      sourceTaskId: string;
      principalHash: string;
      chatHash: string;
      valueJson: string;
      payloadHash: string;
      createdAt: string;
      expiresAt: string;
    }>(
      fixture.filename,
      `SELECT group_id AS groupId, option_ref AS optionRef,
              option_ordinal AS ordinal, source_task_id AS sourceTaskId,
              principal_hash AS principalHash, chat_hash AS chatHash,
              value_json AS valueJson, payload_hash AS payloadHash,
              created_at AS createdAt, expires_at AS expiresAt
         FROM clarification_options
        ORDER BY option_ordinal`,
    );
    expect(persisted).toEqual([
      {
        groupId: publicGroup.groupId,
        optionRef: publicGroup.options[0]?.optionRef,
        ordinal: 1,
        sourceTaskId: source.taskId,
        principalHash: source.actorHash,
        chatHash: source.chatHash,
        valueJson:
          '{"department":"融创中国-文旅事业部","openId":"ou_internal_first"}',
        payloadHash:
          "sha256:072d8ba55c5811183b6ec5a8132e62a491aeb7fde6ad85bfdaa07c2ac68dc29e",
        createdAt: at(25).toISOString(),
        expiresAt: at(86_425).toISOString(),
      },
      {
        groupId: publicGroup.groupId,
        optionRef: publicGroup.options[1]?.optionRef,
        ordinal: 2,
        sourceTaskId: source.taskId,
        principalHash: source.actorHash,
        chatHash: source.chatHash,
        valueJson:
          '{"department":"融创中国-热雪奇迹","openId":"ou_internal_second"}',
        payloadHash:
          "sha256:4d684ce631549728eb5812dfa823656f044010f109df18cc58c784ac66344b6a",
        createdAt: at(25).toISOString(),
        expiresAt: at(86_425).toISOString(),
      },
    ]);

    finishTask(fixture.store, source.taskId, 1);
    const current = startTask(fixture, 2);
    const reopened = await reopenFixture(fixture);
    expect(
      asClarificationStore(reopened).listPendingClarificationsForTask(
        current.taskId,
        at(45),
      ),
    ).toEqual([written]);
  });

  it("accepts exactly one and twenty dense options while rejecting zero and twenty-one", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    const store = asClarificationStore(fixture.store);

    const one = store.writeClarificationGroupForTask({
      taskId: source.taskId,
      kind: "base",
      groupLabel: "选择数据表",
      options: [{ value: { token: "base-one" }, displayLabel: "经营日报" }],
      now: at(25),
    });
    const twenty = store.writeClarificationGroupForTask({
      taskId: source.taskId,
      kind: "table",
      groupLabel: "选择工作表",
      options: Array.from({ length: 20 }, (_, index) => ({
        value: { tableId: `table-${index + 1}` },
        displayLabel: `工作表 ${index + 1}`,
      })),
      now: at(26),
    });
    expect(one.options as readonly unknown[]).toHaveLength(1);
    expect(twenty.options as readonly unknown[]).toHaveLength(20);

    for (const options of [
      [],
      Array.from({ length: 21 }, (_, index) => ({
        value: { tableId: `too-many-${index + 1}` },
        displayLabel: `too-many-${index + 1}`,
      })),
    ]) {
      expect(() =>
        store.writeClarificationGroupForTask({
          taskId: source.taskId,
          kind: "table",
          groupLabel: "无效选项数量",
          options,
          now: at(27),
        }),
      ).toThrowError(/clarification_input_is_invalid/);
    }
    expect(
      queryRows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM clarification_options",
      ),
    ).toEqual([{ count: 21 }]);
  });

  it("rejects extra authority fields, accessors, proxies, subclasses, and sparse option arrays", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    const store = asClarificationStore(fixture.store);
    const valid = {
      taskId: source.taskId,
      kind: "contact" as const,
      groupLabel: "选择联系人",
      options: [{ value: { openId: "ou_private" }, displayLabel: "张伟" }],
      now: at(25),
    };

    for (const [key, value] of [
      ["principal", "ou_forbidden"],
      ["chat", "oc_forbidden"],
      ["ttlMs", 1],
      ["groupId", randomUUID()],
      ["optionRef", randomUUID()],
      ["hash", "sha256:forbidden"],
      ["actor", "ou_forbidden"],
    ] as const) {
      expect(() =>
        store.writeClarificationGroupForTask({
          ...valid,
          [key]: value,
        }),
      ).toThrowError(/clarification_input_is_invalid/);
    }
    expect(() =>
      store.writeClarificationGroupForTask(new Proxy(valid, {})),
    ).toThrowError(/clarification_input_is_invalid/);
    expect(() =>
      store.writeClarificationGroupForTask(
        Object.create(valid) as typeof valid,
      ),
    ).toThrowError(/clarification_input_is_invalid/);
    const accessorInput = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessorInput, "groupLabel", {
      enumerable: true,
      get: () => "选择联系人",
    });
    expect(() =>
      store.writeClarificationGroupForTask(accessorInput as typeof valid),
    ).toThrowError(/clarification_input_is_invalid/);
    expect(() =>
      store.writeClarificationGroupForTask({
        ...valid,
        now: new Proxy(at(25), {}),
      }),
    ).toThrowError(/clarification_input_is_invalid/);
    class DateSubclass extends Date {}
    expect(() =>
      store.writeClarificationGroupForTask({
        ...valid,
        now: new DateSubclass(at(25).getTime()),
      }),
    ).toThrowError(/clarification_input_is_invalid/);
    const sparse = Array.from({ length: 2 }, (_, index) => ({
      value: { openId: `ou_${index}` },
      displayLabel: `candidate-${index}`,
    }));
    delete sparse[0];
    expect(() =>
      store.writeClarificationGroupForTask({
        ...valid,
        options: sparse,
      }),
    ).toThrowError(/clarification_input_is_invalid/);
    expect(() =>
      store.writeClarificationGroupForTask({
        ...valid,
        options: new Proxy(valid.options, {}),
      }),
    ).toThrowError(/clarification_input_is_invalid/);
    expect(() =>
      store.writeClarificationGroupForTask({
        ...valid,
        options: [
          new Proxy(valid.options[0] as object, {}),
        ] as typeof valid.options,
      }),
    ).toThrowError(/clarification_input_is_invalid/);
    expect(
      queryRows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM clarification_options",
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("rejects invalid kinds, labels, and non-strict-I-JSON values without writing", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    const store = asClarificationStore(fixture.store);
    const valid = {
      taskId: source.taskId,
      kind: "contact" as ClarificationKind,
      groupLabel: "选择联系人",
      options: [{ value: { openId: "ou_private" }, displayLabel: "张伟" }],
      now: at(25),
    };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const invalidInputs = [
      { ...valid, kind: "unknown" as ClarificationKind },
      { ...valid, groupLabel: "" },
      { ...valid, groupLabel: `bad\u0000label` },
      { ...valid, groupLabel: "x".repeat(257) },
      {
        ...valid,
        options: [{ value: { openId: "ou_private" }, displayLabel: "" }],
      },
      {
        ...valid,
        options: [
          { value: { openId: "ou_private" }, displayLabel: "x".repeat(1_025) },
        ],
      },
      {
        ...valid,
        options: [{ value: undefined, displayLabel: "undefined" }],
      },
      {
        ...valid,
        options: [{ value: Number.NaN, displayLabel: "NaN" }],
      },
      {
        ...valid,
        options: [{ value: cyclic, displayLabel: "cyclic" }],
      },
      {
        ...valid,
        options: [
          {
            value: new Proxy({ openId: "ou_private" }, {}),
            displayLabel: "proxy",
          },
        ],
      },
    ];
    for (const input of invalidInputs) {
      expect(() => store.writeClarificationGroupForTask(input)).toThrowError(
        /clarification_input_is_invalid/,
      );
    }
    expect(
      queryRows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM clarification_options",
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("requires a running task and live task and bridge leases owned by this instance", async () => {
    const scenarios = [
      {
        name: "non-running",
        mutate: (filename: string, taskId: string) =>
          mutate(
            filename,
            "UPDATE tasks SET state='SUCCEEDED', lease_owner=NULL, lease_expires_at=NULL WHERE id=?",
            taskId,
          ),
      },
      {
        name: "wrong task owner",
        mutate: (filename: string, taskId: string) =>
          mutate(
            filename,
            "UPDATE tasks SET lease_owner='instance-b' WHERE id=?",
            taskId,
          ),
      },
      {
        name: "expired task lease",
        mutate: (filename: string, taskId: string) =>
          mutate(
            filename,
            "UPDATE tasks SET lease_expires_at=? WHERE id=?",
            at(24).toISOString(),
            taskId,
          ),
      },
      {
        name: "wrong bridge owner",
        mutate: (filename: string) =>
          mutate(
            filename,
            "UPDATE runtime_leases SET owner='instance-b' WHERE name='bridge'",
          ),
      },
      {
        name: "expired bridge lease",
        mutate: (filename: string) =>
          mutate(
            filename,
            "UPDATE runtime_leases SET expires_at=? WHERE name='bridge'",
            at(24).toISOString(),
          ),
      },
    ] as const;

    for (const scenario of scenarios) {
      const fixture = await storeFixture();
      const source = startTask(fixture, 1);
      scenario.mutate(fixture.filename, source.taskId);
      expect(() =>
        asClarificationStore(fixture.store).writeClarificationGroupForTask({
          taskId: source.taskId,
          kind: "contact",
          groupLabel: scenario.name,
          options: [
            { value: { openId: "ou_private" }, displayLabel: "candidate" },
          ],
          now: at(25),
        }),
      ).toThrowError(/clarification_task_is_not_executable/);
      expect(
        queryRows<{ count: number }>(
          fixture.filename,
          "SELECT COUNT(*) AS count FROM clarification_options",
        ),
      ).toEqual([{ count: 0 }]);
    }
  });

  it("fails closed on corrupt task context and rolls back every option on insert failure", async () => {
    const corruptFixture = await storeFixture();
    const corruptSource = startTask(corruptFixture, 1);
    mutate(
      corruptFixture.filename,
      "DROP TRIGGER inbound_events_append_only_update",
    );
    mutate(
      corruptFixture.filename,
      "UPDATE inbound_events SET sender_open_id_hash='corrupt' WHERE id=(SELECT inbound_event_id FROM tasks WHERE id=?)",
      corruptSource.taskId,
    );
    expect(() =>
      asClarificationStore(corruptFixture.store).writeClarificationGroupForTask(
        {
          taskId: corruptSource.taskId,
          kind: "contact",
          groupLabel: "corrupt",
          options: [
            { value: { openId: "ou_private" }, displayLabel: "candidate" },
          ],
          now: at(25),
        },
      ),
    ).toThrowError(/clarification_task_context_is_invalid/);

    const atomicFixture = await storeFixture();
    const atomicSource = startTask(atomicFixture, 1);
    mutate(
      atomicFixture.filename,
      `CREATE TRIGGER reject_second_clarification_option
       BEFORE INSERT ON clarification_options
       WHEN NEW.option_ordinal=2
       BEGIN SELECT RAISE(ABORT, 'synthetic insert failure'); END`,
    );
    expect(() =>
      asClarificationStore(atomicFixture.store).writeClarificationGroupForTask({
        taskId: atomicSource.taskId,
        kind: "contact",
        groupLabel: "atomic",
        options: [
          { value: { openId: "ou_first" }, displayLabel: "first" },
          { value: { openId: "ou_second" }, displayLabel: "second" },
        ],
        now: at(25),
      }),
    ).toThrowError(/clarification_persistence_failed/);
    expect(
      queryRows<{ count: number }>(
        corruptFixture.filename,
        "SELECT COUNT(*) AS count FROM clarification_options",
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      queryRows<{ count: number }>(
        atomicFixture.filename,
        "SELECT COUNT(*) AS count FROM clarification_options",
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("lists every pending group in stable order using only safe display data", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    finishTask(fixture.store, source.taskId, 1);
    const current = startTask(fixture, 2);
    const baseGroupId = "10000000-0000-4000-8000-000000000001";
    const contactGroupId = "20000000-0000-4000-8000-000000000002";
    const firstContactRef = "30000000-0000-4000-8000-000000000003";
    const secondContactRef = "40000000-0000-4000-8000-000000000004";
    const baseRef = "50000000-0000-4000-8000-000000000005";

    seedGroup(fixture.filename, {
      groupId: contactGroupId,
      groupLabel: "选择联系人",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(27),
      options: [
        {
          ordinal: 1,
          optionRef: firstContactRef,
          valueJson:
            '{"department":"融创中国-热雪奇迹","openId":"ou_internal_first"}',
          displayLabel: "张伟｜融创中国-热雪奇迹｜zhangwei@example.test",
        },
        {
          ordinal: 2,
          optionRef: secondContactRef,
          valueJson:
            '{"department":"融创中国-文旅事业部","openId":"ou_internal_second"}',
          displayLabel: "张伟｜融创中国-文旅事业部｜zw@example.test",
        },
      ],
    });
    seedGroup(fixture.filename, {
      groupId: baseGroupId,
      groupLabel: "选择数据表",
      kind: "base",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(26),
      options: [
        {
          ordinal: 1,
          optionRef: baseRef,
          valueJson:
            '{"appToken":"base_token_private","tableId":"tbl_private"}',
          displayLabel: "经营日报",
        },
      ],
    });

    const groups = asClarificationStore(
      fixture.store,
    ).listPendingClarificationsForTask(current.taskId, at(45));

    expect(groups).toEqual([
      {
        groupId: baseGroupId,
        groupLabel: "选择数据表",
        kind: "base",
        expiresAt: at(86_426).toISOString(),
        options: [
          {
            ordinal: 1,
            optionRef: baseRef,
            displayLabel: "经营日报",
          },
        ],
      },
      {
        groupId: contactGroupId,
        groupLabel: "选择联系人",
        kind: "contact",
        expiresAt: at(86_427).toISOString(),
        options: [
          {
            ordinal: 1,
            optionRef: firstContactRef,
            displayLabel: "张伟｜融创中国-热雪奇迹｜zhangwei@example.test",
          },
          {
            ordinal: 2,
            optionRef: secondContactRef,
            displayLabel: "张伟｜融创中国-文旅事业部｜zw@example.test",
          },
        ],
      },
    ]);
    expect(Object.isFrozen(groups)).toBe(true);
    expect(Object.isFrozen(groups[0])).toBe(true);
    expect(JSON.stringify(groups)).not.toMatch(
      /ou_internal|oc_synthetic|base_token|tbl_private|valueJson/,
    );
  });

  it("does not list selected, expired, cross-principal, or cross-chat groups", async () => {
    const fixture = await storeFixture();
    const crossPrincipal = startTask(
      fixture,
      1,
      "ou_another_principal",
      "oc_synthetic_private_chat",
    );
    finishTask(fixture.store, crossPrincipal.taskId, 1);
    const crossChat = startTask(
      fixture,
      2,
      "ou_synthetic_president",
      "oc_another_private_chat",
    );
    finishTask(fixture.store, crossChat.taskId, 2);
    const source = startTask(fixture, 3);
    finishTask(fixture.store, source.taskId, 3);
    const current = startTask(fixture, 4);
    const groups = [
      {
        groupId: "61000000-0000-4000-8000-000000000001",
        source: crossPrincipal,
        createdAt: at(30),
      },
      {
        groupId: "62000000-0000-4000-8000-000000000002",
        source: crossChat,
        createdAt: at(50),
      },
      {
        groupId: "63000000-0000-4000-8000-000000000003",
        source,
        createdAt: at(70),
      },
      {
        groupId: "64000000-0000-4000-8000-000000000004",
        source,
        createdAt: at(70),
      },
    ] as const;
    for (const [index, group] of groups.entries()) {
      seedGroup(fixture.filename, {
        groupId: group.groupId,
        groupLabel: `group-${index + 1}`,
        kind: "contact",
        sourceTaskId: group.source.taskId,
        principalHash: group.source.actorHash,
        chatHash: group.source.chatHash,
        createdAt: group.createdAt,
        options: [
          {
            ordinal: 1,
            optionRef: `70000000-0000-4000-8000-00000000000${index + 1}`,
            valueJson: `{"openId":"ou_private_${index + 1}"}`,
            displayLabel: `candidate-${index + 1}`,
          },
        ],
      });
    }
    mutate(
      fixture.filename,
      `INSERT INTO clarification_selections(
         id, group_id, option_ordinal, task_id, selected_at, created_at
       ) VALUES (?, ?, 1, ?, ?, ?)`,
      "80000000-0000-4000-8000-000000000001",
      groups[2].groupId,
      current.taskId,
      at(85).toISOString(),
      at(85).toISOString(),
    );

    expect(
      asClarificationStore(fixture.store).listPendingClarificationsForTask(
        current.taskId,
        at(90_000),
      ),
    ).toEqual([]);
  });

  it("rejects a group written at or after the current inbound event", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    finishTask(fixture.store, source.taskId, 1);
    const current = startTask(fixture, 2);
    const optionRef = "65000000-0000-4000-8000-000000000005";
    seedGroup(fixture.filename, {
      groupId: "65000000-0000-4000-8000-000000000004",
      groupLabel: "late group",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(45),
      options: [
        {
          ordinal: 1,
          optionRef,
          valueJson: '{"openId":"ou_private_late"}',
          displayLabel: "late candidate",
        },
      ],
    });

    expect(() =>
      asClarificationStore(fixture.store).listPendingClarificationsForTask(
        current.taskId,
        at(50),
      ),
    ).toThrowError(/clarification_persistence_failed/);
    expect(() =>
      asClarificationStore(fixture.store).consumeClarificationForTask(
        current.taskId,
        optionRef,
        "contact",
        at(50),
      ),
    ).toThrowError(/clarification_persistence_failed/);
    expect(
      queryRows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM clarification_selections",
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("rejects a group written exactly at the current inbound boundary", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    finishTask(fixture.store, source.taskId, 1);
    const current = startTask(fixture, 2);
    const optionRef = "65000000-0000-4000-8000-000000000007";
    seedGroup(fixture.filename, {
      groupId: "65000000-0000-4000-8000-000000000006",
      groupLabel: "equal boundary",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(40),
      options: [
        {
          ordinal: 1,
          optionRef,
          valueJson: '{"openId":"ou_private_equal"}',
          displayLabel: "equal candidate",
        },
      ],
    });

    expect(() =>
      asClarificationStore(fixture.store).listPendingClarificationsForTask(
        current.taskId,
        at(50),
      ),
    ).toThrowError(/clarification_persistence_failed/);
    expect(() =>
      asClarificationStore(fixture.store).consumeClarificationForTask(
        current.taskId,
        optionRef,
        "contact",
        at(50),
      ),
    ).toThrowError(/clarification_persistence_failed/);
  });

  it("rejects a group created before its source inbound event", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    finishTask(fixture.store, source.taskId, 1);
    const current = startTask(fixture, 2);
    const optionRef = "66000000-0000-4000-8000-000000000006";
    seedGroup(fixture.filename, {
      groupId: "66000000-0000-4000-8000-000000000005",
      groupLabel: "before source inbound",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(19),
      options: [
        {
          ordinal: 1,
          optionRef,
          valueJson: '{"openId":"ou_private_before_inbound"}',
          displayLabel: "before inbound",
        },
      ],
    });

    expect(() =>
      asClarificationStore(fixture.store).listPendingClarificationsForTask(
        current.taskId,
        at(50),
      ),
    ).toThrowError(/clarification_persistence_failed/);
    expect(() =>
      asClarificationStore(fixture.store).consumeClarificationForTask(
        current.taskId,
        optionRef,
        "contact",
        at(50),
      ),
    ).toThrowError(/clarification_persistence_failed/);
  });

  it("rejects a group created before the persisted source task timestamp", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    finishTask(fixture.store, source.taskId, 1);
    mutate(
      fixture.filename,
      "UPDATE tasks SET created_at=? WHERE id=?",
      at(30).toISOString(),
      source.taskId,
    );
    const current = startTask(fixture, 2);
    const optionRef = "67000000-0000-4000-8000-000000000007";
    seedGroup(fixture.filename, {
      groupId: "67000000-0000-4000-8000-000000000006",
      groupLabel: "before source task",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(25),
      options: [
        {
          ordinal: 1,
          optionRef,
          valueJson: '{"openId":"ou_private_before_task"}',
          displayLabel: "before task",
        },
      ],
    });

    expect(() =>
      asClarificationStore(fixture.store).listPendingClarificationsForTask(
        current.taskId,
        at(50),
      ),
    ).toThrowError(/clarification_persistence_failed/);
    expect(() =>
      asClarificationStore(fixture.store).consumeClarificationForTask(
        current.taskId,
        optionRef,
        "contact",
        at(50),
      ),
    ).toThrowError(/clarification_persistence_failed/);
  });

  it("consumes an option once and returns only its audited trusted value", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    finishTask(fixture.store, source.taskId, 1);
    const current = startTask(fixture, 2);
    const groupId = "90000000-0000-4000-8000-000000000001";
    const firstRef = "91000000-0000-4000-8000-000000000001";
    const secondRef = "92000000-0000-4000-8000-000000000002";
    seedGroup(fixture.filename, {
      groupId,
      groupLabel: "选择联系人",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(25),
      options: [
        {
          ordinal: 1,
          optionRef: firstRef,
          valueJson: '{"openId":"ou_private_first"}',
          displayLabel: "第一个人",
        },
        {
          ordinal: 2,
          optionRef: secondRef,
          valueJson:
            '{"departments":["融创中国","热雪奇迹"],"openId":"ou_private_second"}',
          displayLabel: "第二个人",
        },
      ],
    });

    const selection = asClarificationStore(
      fixture.store,
    ).consumeClarificationForTask(current.taskId, secondRef, "contact", at(50));

    expect(selection).toMatchObject({
      selectionId: expect.any(String),
      groupId,
      optionOrdinal: 2,
      optionRef: secondRef,
      kind: "contact",
      value: {
        departments: ["融创中国", "热雪奇迹"],
        openId: "ou_private_second",
      },
      selectedAt: at(50).toISOString(),
    });
    expect(selection).not.toHaveProperty("sourceTaskId");
    expect(selection).not.toHaveProperty("principalHash");
    expect(selection).not.toHaveProperty("chatHash");
    expect(selection).not.toHaveProperty("actorOpenId");
    expect(selection).not.toHaveProperty("chatId");
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.value)).toBe(true);
    expect(
      queryRows<{
        groupId: string;
        optionOrdinal: number;
        taskId: string;
      }>(
        fixture.filename,
        `SELECT group_id AS groupId, option_ordinal AS optionOrdinal,
                task_id AS taskId
           FROM clarification_selections`,
      ),
    ).toEqual([{ groupId, optionOrdinal: 2, taskId: current.taskId }]);
    expect(
      asClarificationStore(fixture.store).listPendingClarificationsForTask(
        current.taskId,
        at(51),
      ),
    ).toEqual([]);
  });

  it("rolls back a valid option when another batch ref is unavailable", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    finishTask(fixture.store, source.taskId, 1);
    const current = startTask(fixture, 2);
    const validRef = "93000000-0000-4000-8000-000000000003";
    const missingRef = "94000000-0000-4000-8000-000000000004";
    seedGroup(fixture.filename, {
      groupId: "95000000-0000-4000-8000-000000000005",
      groupLabel: "batch atomicity",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(25),
      options: [
        {
          ordinal: 1,
          optionRef: validRef,
          valueJson: '{"openId":"ou_private_valid_batch"}',
          displayLabel: "valid batch candidate",
        },
      ],
    });

    expect(() =>
      asClarificationStore(fixture.store).consumeClarificationsForTask(
        current.taskId,
        [validRef, missingRef],
        "contact",
        at(50),
      ),
    ).toThrowError(/clarification_not_available/);
    expect(
      queryRows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM clarification_selections",
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("rolls back every selection when the trusted validator rejects the second value", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    finishTask(fixture.store, source.taskId, 1);
    const current = startTask(fixture, 2);
    const firstRef = "d1000000-0000-4000-8000-000000000001";
    const secondRef = "d2000000-0000-4000-8000-000000000002";
    seedGroup(fixture.filename, {
      groupId: "d3000000-0000-4000-8000-000000000003",
      groupLabel: "validated first",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(25),
      options: [
        {
          ordinal: 1,
          optionRef: firstRef,
          valueJson: '{"openId":"ou_private_validated_first"}',
          displayLabel: "first",
        },
      ],
    });
    seedGroup(fixture.filename, {
      groupId: "d4000000-0000-4000-8000-000000000004",
      groupLabel: "validated second",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(26),
      options: [
        {
          ordinal: 1,
          optionRef: secondRef,
          valueJson: '{"openId":"ou_private_validated_second"}',
          displayLabel: "second",
        },
      ],
    });

    const validatedIndexes: number[] = [];
    expect(() =>
      asClarificationStore(fixture.store).consumeClarificationsForTaskValidated(
        current.taskId,
        [firstRef, secondRef],
        "contact",
        at(50),
        (_value, index) => {
          validatedIndexes.push(index);
          if (index === 1) throw new Error("trusted_value_rejected");
        },
      ),
    ).toThrow();
    expect(validatedIndexes).toEqual([0, 1]);
    expect(
      queryRows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM clarification_selections",
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("rejects an async trusted validator before inserting any selection", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    finishTask(fixture.store, source.taskId, 1);
    const current = startTask(fixture, 2);
    const optionRef = "db000000-0000-4000-8000-00000000000b";
    seedGroup(fixture.filename, {
      groupId: "dc000000-0000-4000-8000-00000000000c",
      groupLabel: "async validator",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(25),
      options: [
        {
          ordinal: 1,
          optionRef,
          valueJson: '{"openId":"ou_private_async_validator"}',
          displayLabel: "async",
        },
      ],
    });

    expect
      .soft(() =>
        asClarificationStore(
          fixture.store,
        ).consumeClarificationsForTaskValidated(
          current.taskId,
          [optionRef],
          "contact",
          at(50),
          (async () => undefined) as unknown as ClarificationValueValidator,
        ),
      )
      .toThrowError(/clarification_validator_must_return_undefined/);
    expect(
      queryRows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM clarification_selections",
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("rejects an ordinary validator returning a thenable or other non-undefined value before inserts", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    finishTask(fixture.store, source.taskId, 1);
    const current = startTask(fixture, 2);
    const firstRef = "dd000000-0000-4000-8000-00000000000d";
    const secondRef = "de000000-0000-4000-8000-00000000000e";
    seedGroup(fixture.filename, {
      groupId: "df000000-0000-4000-8000-00000000000f",
      groupLabel: "thenable first",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(25),
      options: [
        {
          ordinal: 1,
          optionRef: firstRef,
          valueJson: '{"openId":"ou_private_thenable_first"}',
          displayLabel: "first",
        },
      ],
    });
    seedGroup(fixture.filename, {
      groupId: "e0000000-0000-4000-8000-000000000010",
      groupLabel: "thenable second",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(26),
      options: [
        {
          ordinal: 1,
          optionRef: secondRef,
          valueJson: '{"openId":"ou_private_thenable_second"}',
          displayLabel: "second",
        },
      ],
    });
    const thenable = Object.freeze({
      then(resolve: (value: undefined) => void): void {
        resolve(undefined);
      },
    });
    const validatedIndexes: number[] = [];

    expect
      .soft(() =>
        asClarificationStore(
          fixture.store,
        ).consumeClarificationsForTaskValidated(
          current.taskId,
          [firstRef, secondRef],
          "contact",
          at(50),
          ((_value: ActionJsonValue, index: number) => {
            validatedIndexes.push(index);
            if (index === 1) return thenable;
            return undefined;
          }) as unknown as ClarificationValueValidator,
        ),
      )
      .toThrowError(/clarification_validator_must_return_undefined/);
    expect(validatedIndexes).toEqual([0, 1]);
    expect(
      queryRows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM clarification_selections",
      ),
    ).toEqual([{ count: 0 }]);

    validatedIndexes.length = 0;
    const plainResult = Object.freeze({ ignoredReplacement: true });
    expect(() =>
      asClarificationStore(fixture.store).consumeClarificationsForTaskValidated(
        current.taskId,
        [firstRef, secondRef],
        "contact",
        at(50),
        ((_value: ActionJsonValue, index: number) => {
          validatedIndexes.push(index);
          if (index === 1) return plainResult;
          return undefined;
        }) as unknown as ClarificationValueValidator,
      ),
    ).toThrowError(/clarification_validator_must_return_undefined/);
    expect(validatedIndexes).toEqual([0, 1]);
    expect(
      queryRows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM clarification_selections",
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("lets a trusted validator reject malformed contact-like generic JSON without writing", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    finishTask(fixture.store, source.taskId, 1);
    const current = startTask(fixture, 2);
    const malformedRef = "d5000000-0000-4000-8000-000000000005";
    seedGroup(fixture.filename, {
      groupId: "d6000000-0000-4000-8000-000000000006",
      groupLabel: "malformed contact-like value",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(25),
      options: [
        {
          ordinal: 1,
          optionRef: malformedRef,
          valueJson: '{"displayName":"looks plausible","openId":7}',
          displayLabel: "malformed",
        },
      ],
    });
    expect(
      asClarificationStore(fixture.store).listPendingClarificationsForTask(
        current.taskId,
        at(50),
      ),
    ).toHaveLength(1);
    expect(() =>
      asClarificationStore(fixture.store).consumeClarificationsForTaskValidated(
        current.taskId,
        [malformedRef],
        "contact",
        at(50),
        null as unknown as ClarificationValueValidator,
      ),
    ).toThrowError(/clarification_input_is_invalid/);

    const validatedIndexes: number[] = [];
    expect(() =>
      asClarificationStore(fixture.store).consumeClarificationsForTaskValidated(
        current.taskId,
        [malformedRef],
        "contact",
        at(50),
        (value, index) => {
          validatedIndexes.push(index);
          if (
            value === null ||
            Array.isArray(value) ||
            typeof value !== "object" ||
            typeof (value as { readonly openId?: unknown }).openId !== "string"
          ) {
            throw new Error("malformed_contact_value");
          }
        },
      ),
    ).toThrow();
    expect(validatedIndexes).toEqual([0]);
    expect(
      queryRows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM clarification_selections",
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("passes deeply frozen values to a synchronous void validator in input order", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    finishTask(fixture.store, source.taskId, 1);
    const current = startTask(fixture, 2);
    const firstRef = "d7000000-0000-4000-8000-000000000007";
    const secondRef = "d8000000-0000-4000-8000-000000000008";
    seedGroup(fixture.filename, {
      groupId: "d9000000-0000-4000-8000-000000000009",
      groupLabel: "validated success first",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(25),
      options: [
        {
          ordinal: 1,
          optionRef: firstRef,
          valueJson:
            '{"meta":{"departments":["first"]},"openId":"ou_private_validated_success_first"}',
          displayLabel: "first",
        },
      ],
    });
    seedGroup(fixture.filename, {
      groupId: "da000000-0000-4000-8000-00000000000a",
      groupLabel: "validated success second",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(26),
      options: [
        {
          ordinal: 1,
          optionRef: secondRef,
          valueJson:
            '{"meta":{"departments":["second"]},"openId":"ou_private_validated_success_second"}',
          displayLabel: "second",
        },
      ],
    });

    const observed: Array<Readonly<{ value: ActionJsonValue; index: number }>> =
      [];
    const selections = asClarificationStore(
      fixture.store,
    ).consumeClarificationsForTaskValidated(
      current.taskId,
      [secondRef, firstRef],
      "contact",
      at(50),
      (value, index) => {
        observed.push({ value, index });
        return undefined;
      },
    );

    expect(observed).toMatchObject([
      {
        index: 0,
        value: {
          meta: { departments: ["second"] },
          openId: "ou_private_validated_success_second",
        },
      },
      {
        index: 1,
        value: {
          meta: { departments: ["first"] },
          openId: "ou_private_validated_success_first",
        },
      },
    ]);
    for (const { value } of observed) {
      const contact = value as {
        readonly meta: { readonly departments: readonly string[] };
      };
      expect(Object.isFrozen(value)).toBe(true);
      expect(Object.isFrozen(contact.meta)).toBe(true);
      expect(Object.isFrozen(contact.meta.departments)).toBe(true);
    }
    expect(selections).toMatchObject([
      {
        optionRef: secondRef,
        value: {
          meta: { departments: ["second"] },
          openId: "ou_private_validated_success_second",
        },
      },
      {
        optionRef: firstRef,
        value: {
          meta: { departments: ["first"] },
          openId: "ou_private_validated_success_first",
        },
      },
    ]);
    expect(Object.isFrozen(selections)).toBe(true);
    expect(
      queryRows<{ optionRef: string }>(
        fixture.filename,
        `SELECT clarification_options.option_ref AS optionRef
           FROM clarification_selections
           JOIN clarification_options
             ON clarification_options.group_id=clarification_selections.group_id
            AND clarification_options.option_ordinal=
                clarification_selections.option_ordinal
          ORDER BY clarification_selections.rowid`,
      ),
    ).toEqual([{ optionRef: secondRef }, { optionRef: firstRef }]);
  });

  it("consumes multiple groups atomically in input order and freezes every result", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    finishTask(fixture.store, source.taskId, 1);
    const current = startTask(fixture, 2);
    const firstRef = "96000000-0000-4000-8000-000000000006";
    const secondRef = "97000000-0000-4000-8000-000000000007";
    seedGroup(fixture.filename, {
      groupId: "98000000-0000-4000-8000-000000000008",
      groupLabel: "first group",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(25),
      options: [
        {
          ordinal: 1,
          optionRef: firstRef,
          valueJson: '{"openId":"ou_private_first_batch"}',
          displayLabel: "first",
        },
      ],
    });
    seedGroup(fixture.filename, {
      groupId: "99000000-0000-4000-8000-000000000009",
      groupLabel: "second group",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(26),
      options: [
        {
          ordinal: 1,
          optionRef: secondRef,
          valueJson: '{"openId":"ou_private_second_batch"}',
          displayLabel: "second",
        },
      ],
    });

    const selections = asClarificationStore(
      fixture.store,
    ).consumeClarificationsForTask(
      current.taskId,
      [secondRef, firstRef],
      "contact",
      at(50),
    );

    expect(selections).toMatchObject([
      { optionRef: secondRef, value: { openId: "ou_private_second_batch" } },
      { optionRef: firstRef, value: { openId: "ou_private_first_batch" } },
    ]);
    expect(Object.isFrozen(selections)).toBe(true);
    expect(selections.every(Object.isFrozen)).toBe(true);
    expect(
      selections.every((selection) => Object.isFrozen(selection.value)),
    ).toBe(true);
    expect(
      queryRows<{ optionRef: string }>(
        fixture.filename,
        `SELECT clarification_options.option_ref AS optionRef
           FROM clarification_selections
           JOIN clarification_options
             ON clarification_options.group_id=clarification_selections.group_id
            AND clarification_options.option_ordinal=
                clarification_selections.option_ordinal
          ORDER BY clarification_selections.rowid`,
      ),
    ).toEqual([{ optionRef: secondRef }, { optionRef: firstRef }]);
  });

  it("requires a dense unique list of one to twenty canonical option refs", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    finishTask(fixture.store, source.taskId, 1);
    const current = startTask(fixture, 2);
    const validRef = "9a000000-0000-4000-8000-00000000000a";
    const sparse = [validRef, validRef] as Array<string | undefined>;
    delete sparse[1];
    const tooMany = Array.from({ length: 21 }, () => randomUUID());
    const withExtraKey = [validRef] as string[] & { actorOpenId?: string };
    withExtraKey.actorOpenId = "ou_untrusted";

    for (const optionRefs of [
      [],
      tooMany,
      sparse as string[],
      [validRef, validRef],
      ["not-a-ref"],
      new Proxy([validRef], {}),
      withExtraKey,
    ]) {
      expect(() =>
        asClarificationStore(fixture.store).consumeClarificationsForTask(
          current.taskId,
          optionRefs,
          "contact",
          at(50),
        ),
      ).toThrowError(/clarification_input_is_invalid/);
    }
    expect(
      queryRows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM clarification_selections",
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("rejects selecting two options from the same group without a partial insert", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    finishTask(fixture.store, source.taskId, 1);
    const current = startTask(fixture, 2);
    const firstRef = "9b000000-0000-4000-8000-00000000000b";
    const secondRef = "9c000000-0000-4000-8000-00000000000c";
    seedGroup(fixture.filename, {
      groupId: "9d000000-0000-4000-8000-00000000000d",
      groupLabel: "same group",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(25),
      options: [
        {
          ordinal: 1,
          optionRef: firstRef,
          valueJson: '{"openId":"ou_private_same_group_first"}',
          displayLabel: "first",
        },
        {
          ordinal: 2,
          optionRef: secondRef,
          valueJson: '{"openId":"ou_private_same_group_second"}',
          displayLabel: "second",
        },
      ],
    });

    expect(() =>
      asClarificationStore(fixture.store).consumeClarificationsForTask(
        current.taskId,
        [firstRef, secondRef],
        "contact",
        at(50),
      ),
    ).toThrowError(/clarification_not_available/);
    expect(
      queryRows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM clarification_selections",
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("rolls back the whole batch for cross-chat, wrong-kind, selected, or corrupt options", async () => {
    const fixture = await storeFixture();
    const crossChat = startTask(
      fixture,
      1,
      "ou_synthetic_president",
      "oc_other_private_chat",
    );
    finishTask(fixture.store, crossChat.taskId, 1);
    const source = startTask(fixture, 2);
    finishTask(fixture.store, source.taskId, 2);
    const current = startTask(fixture, 3);
    const goodRef = "9e000000-0000-4000-8000-00000000000e";
    const crossChatRef = "9f000000-0000-4000-8000-00000000000f";
    const wrongKindRef = "aa000000-0000-4000-8000-00000000000a";
    const selectedRef = "ab000000-0000-4000-8000-00000000000b";
    const corruptRef = "ac000000-0000-4000-8000-00000000000c";
    const selectedGroupId = "ad000000-0000-4000-8000-00000000000d";
    const groupFixtures: readonly GroupFixture[] = [
      {
        groupId: "ae000000-0000-4000-8000-00000000000e",
        groupLabel: "good",
        kind: "contact",
        sourceTaskId: source.taskId,
        principalHash: source.actorHash,
        chatHash: source.chatHash,
        createdAt: at(55),
        options: [
          {
            ordinal: 1,
            optionRef: goodRef,
            valueJson: '{"openId":"ou_private_batch_good"}',
            displayLabel: "good",
          },
        ],
      },
      {
        groupId: "af000000-0000-4000-8000-00000000000f",
        groupLabel: "cross chat",
        kind: "contact",
        sourceTaskId: crossChat.taskId,
        principalHash: crossChat.actorHash,
        chatHash: crossChat.chatHash,
        createdAt: at(25),
        options: [
          {
            ordinal: 1,
            optionRef: crossChatRef,
            valueJson: '{"openId":"ou_private_batch_cross_chat"}',
            displayLabel: "cross chat",
          },
        ],
      },
      {
        groupId: "b0000000-0000-4000-8000-000000000010",
        groupLabel: "wrong kind",
        kind: "base",
        sourceTaskId: source.taskId,
        principalHash: source.actorHash,
        chatHash: source.chatHash,
        createdAt: at(56),
        options: [
          {
            ordinal: 1,
            optionRef: wrongKindRef,
            valueJson: '{"appToken":"base_private"}',
            displayLabel: "wrong kind",
          },
        ],
      },
      {
        groupId: selectedGroupId,
        groupLabel: "selected",
        kind: "contact",
        sourceTaskId: source.taskId,
        principalHash: source.actorHash,
        chatHash: source.chatHash,
        createdAt: at(57),
        options: [
          {
            ordinal: 1,
            optionRef: selectedRef,
            valueJson: '{"openId":"ou_private_batch_selected"}',
            displayLabel: "selected",
          },
        ],
      },
      {
        groupId: "b1000000-0000-4000-8000-000000000011",
        groupLabel: "corrupt",
        kind: "contact",
        sourceTaskId: source.taskId,
        principalHash: source.actorHash,
        chatHash: source.chatHash,
        createdAt: at(58),
        options: [
          {
            ordinal: 1,
            optionRef: corruptRef,
            valueJson: '{"openId":"ou_private_batch_corrupt"}',
            displayLabel: "corrupt",
            payloadHash: `sha256:${"0".repeat(64)}`,
          },
        ],
      },
    ];
    for (const group of groupFixtures) seedGroup(fixture.filename, group);
    mutate(
      fixture.filename,
      `INSERT INTO clarification_selections(
         id, group_id, option_ordinal, task_id, selected_at, created_at
       ) VALUES (?, ?, 1, ?, ?, ?)`,
      randomUUID(),
      selectedGroupId,
      current.taskId,
      at(65).toISOString(),
      at(65).toISOString(),
    );

    for (const invalidRef of [crossChatRef, wrongKindRef, selectedRef]) {
      expect(() =>
        asClarificationStore(fixture.store).consumeClarificationsForTask(
          current.taskId,
          [goodRef, invalidRef],
          "contact",
          at(70),
        ),
      ).toThrowError(/clarification_not_available/);
    }
    expect(() =>
      asClarificationStore(fixture.store).consumeClarificationsForTask(
        current.taskId,
        [goodRef, corruptRef],
        "contact",
        at(70),
      ),
    ).toThrowError(/clarification_persistence_failed/);
    expect(
      queryRows<{ groupId: string }>(
        fixture.filename,
        "SELECT group_id AS groupId FROM clarification_selections",
      ),
    ).toEqual([{ groupId: selectedGroupId }]);
  });

  it("rejects a second selection from the same group across later tasks", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    finishTask(fixture.store, source.taskId, 1);
    const firstCurrent = startTask(fixture, 2);
    const groupId = "a0000000-0000-4000-8000-000000000001";
    const firstRef = "a1000000-0000-4000-8000-000000000001";
    const secondRef = "a2000000-0000-4000-8000-000000000002";
    seedGroup(fixture.filename, {
      groupId,
      groupLabel: "选择联系人",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(25),
      options: [
        {
          ordinal: 1,
          optionRef: firstRef,
          valueJson: '{"openId":"ou_private_first"}',
          displayLabel: "第一个人",
        },
        {
          ordinal: 2,
          optionRef: secondRef,
          valueJson: '{"openId":"ou_private_second"}',
          displayLabel: "第二个人",
        },
      ],
    });
    asClarificationStore(fixture.store).consumeClarificationForTask(
      firstCurrent.taskId,
      secondRef,
      "contact",
      at(50),
    );
    finishTask(fixture.store, firstCurrent.taskId, 2);
    const secondCurrent = startTask(fixture, 3);

    expect(() =>
      asClarificationStore(fixture.store).consumeClarificationForTask(
        secondCurrent.taskId,
        firstRef,
        "contact",
        at(70),
      ),
    ).toThrowError(/clarification_not_available/);
    expect(
      queryRows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM clarification_selections",
      ),
    ).toEqual([{ count: 1 }]);
  });

  it("treats exact clarification expiry as unavailable", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    finishTask(fixture.store, source.taskId, 1);
    const current = startTask(fixture, 2);
    const optionRef = "a3000000-0000-4000-8000-000000000003";
    seedGroup(fixture.filename, {
      groupId: "a4000000-0000-4000-8000-000000000004",
      groupLabel: "exact expiry",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(25),
      options: [
        {
          ordinal: 1,
          optionRef,
          valueJson: '{"openId":"ou_private_expiring"}',
          displayLabel: "expiring candidate",
        },
      ],
    });
    const exactExpiry = at(86_425);

    expect(
      asClarificationStore(fixture.store).listPendingClarificationsForTask(
        current.taskId,
        exactExpiry,
      ),
    ).toEqual([]);
    expect(() =>
      asClarificationStore(fixture.store).consumeClarificationForTask(
        current.taskId,
        optionRef,
        "contact",
        exactExpiry,
      ),
    ).toThrowError(/clarification_not_available/);
  });

  it("accepts the exact task lease boundary but rejects the next millisecond", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    finishTask(fixture.store, source.taskId, 1);
    const current = startTask(fixture, 2);
    mutate(
      fixture.filename,
      "UPDATE tasks SET lease_expires_at=? WHERE id=?",
      at(100).toISOString(),
      current.taskId,
    );
    const exactRef = "a5000000-0000-4000-8000-000000000005";
    const expiredRef = "a6000000-0000-4000-8000-000000000006";
    seedGroup(fixture.filename, {
      groupId: "a7000000-0000-4000-8000-000000000007",
      groupLabel: "lease boundary one",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(25),
      options: [
        {
          ordinal: 1,
          optionRef: exactRef,
          valueJson: '{"openId":"ou_private_exact_lease"}',
          displayLabel: "exact lease",
        },
      ],
    });
    seedGroup(fixture.filename, {
      groupId: "a8000000-0000-4000-8000-000000000008",
      groupLabel: "lease boundary two",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(26),
      options: [
        {
          ordinal: 1,
          optionRef: expiredRef,
          valueJson: '{"openId":"ou_private_expired_lease"}',
          displayLabel: "expired lease",
        },
      ],
    });

    expect(
      asClarificationStore(fixture.store).consumeClarificationForTask(
        current.taskId,
        exactRef,
        "contact",
        at(100),
      ),
    ).toMatchObject({ optionRef: exactRef });
    expect(() =>
      asClarificationStore(fixture.store).consumeClarificationForTask(
        current.taskId,
        expiredRef,
        "contact",
        new Date(at(100).getTime() + 1),
      ),
    ).toThrowError(/clarification_task_is_not_executable/);
  });

  it("rejects wrong-kind, expired, cross-identity, and non-executable consumption without writing", async () => {
    const fixture = await storeFixture();
    const other = startTask(
      fixture,
      1,
      "ou_another_principal",
      "oc_synthetic_private_chat",
    );
    finishTask(fixture.store, other.taskId, 1);
    const source = startTask(fixture, 2);
    finishTask(fixture.store, source.taskId, 2);
    const current = startTask(fixture, 3);
    const validRef = "b1000000-0000-4000-8000-000000000001";
    const expiredRef = "b2000000-0000-4000-8000-000000000002";
    const crossRef = "b3000000-0000-4000-8000-000000000003";
    const noRuntimeLeaseRef = "b7000000-0000-4000-8000-000000000007";
    seedGroup(fixture.filename, {
      groupId: "b4000000-0000-4000-8000-000000000004",
      groupLabel: "valid",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(45),
      options: [
        {
          ordinal: 1,
          optionRef: validRef,
          valueJson: '{"openId":"ou_private_valid"}',
          displayLabel: "valid",
        },
      ],
    });
    seedGroup(fixture.filename, {
      groupId: "b5000000-0000-4000-8000-000000000005",
      groupLabel: "expired",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(45),
      options: [
        {
          ordinal: 1,
          optionRef: expiredRef,
          valueJson: '{"openId":"ou_private_expired"}',
          displayLabel: "expired",
        },
      ],
    });
    seedGroup(fixture.filename, {
      groupId: "b6000000-0000-4000-8000-000000000006",
      groupLabel: "cross",
      kind: "contact",
      sourceTaskId: other.taskId,
      principalHash: other.actorHash,
      chatHash: other.chatHash,
      createdAt: at(25),
      options: [
        {
          ordinal: 1,
          optionRef: crossRef,
          valueJson: '{"openId":"ou_private_cross"}',
          displayLabel: "cross",
        },
      ],
    });
    seedGroup(fixture.filename, {
      groupId: "b8000000-0000-4000-8000-000000000008",
      groupLabel: "no-runtime-lease",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(46),
      options: [
        {
          ordinal: 1,
          optionRef: noRuntimeLeaseRef,
          valueJson: '{"openId":"ou_private_no_runtime_lease"}',
          displayLabel: "no-runtime-lease",
        },
      ],
    });

    expect(() =>
      asClarificationStore(fixture.store).consumeClarificationForTask(
        current.taskId,
        validRef,
        "base",
        at(70),
      ),
    ).toThrowError(/clarification_not_available/);
    expect(() =>
      asClarificationStore(fixture.store).consumeClarificationForTask(
        current.taskId,
        expiredRef,
        "contact",
        at(86_445),
      ),
    ).toThrowError(/clarification_not_available/);
    expect(() =>
      asClarificationStore(fixture.store).consumeClarificationForTask(
        current.taskId,
        crossRef,
        "contact",
        at(70),
      ),
    ).toThrowError(/clarification_not_available/);
    expect(fixture.store.releaseRuntimeLease("bridge", "instance-a")).toBe(
      true,
    );
    expect(() =>
      asClarificationStore(fixture.store).consumeClarificationForTask(
        current.taskId,
        noRuntimeLeaseRef,
        "contact",
        at(70),
      ),
    ).toThrowError(/clarification_task_is_not_executable/);
    expect(
      fixture.store.acquireRuntimeLease(
        "bridge",
        "instance-a",
        at(70),
        604_800_000,
      ),
    ).toBe(true);
    finishTask(fixture.store, current.taskId, 3);
    expect(() =>
      asClarificationStore(fixture.store).consumeClarificationForTask(
        current.taskId,
        validRef,
        "contact",
        at(71),
      ),
    ).toThrowError(/clarification_task_is_not_executable/);
    expect(
      queryRows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM clarification_selections",
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("rejects cross-chat consumption for the same principal", async () => {
    const fixture = await storeFixture();
    const crossChat = startTask(
      fixture,
      1,
      "ou_synthetic_president",
      "oc_other_private_chat",
    );
    finishTask(fixture.store, crossChat.taskId, 1);
    const current = startTask(fixture, 2);
    const optionRef = "b9000000-0000-4000-8000-000000000009";
    seedGroup(fixture.filename, {
      groupId: "ba000000-0000-4000-8000-00000000000a",
      groupLabel: "cross chat",
      kind: "contact",
      sourceTaskId: crossChat.taskId,
      principalHash: crossChat.actorHash,
      chatHash: crossChat.chatHash,
      createdAt: at(25),
      options: [
        {
          ordinal: 1,
          optionRef,
          valueJson: '{"openId":"ou_private_cross_chat"}',
          displayLabel: "cross chat candidate",
        },
      ],
    });

    expect(() =>
      asClarificationStore(fixture.store).consumeClarificationForTask(
        current.taskId,
        optionRef,
        "contact",
        at(50),
      ),
    ).toThrowError(/clarification_not_available/);
    expect(
      queryRows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM clarification_selections",
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("allows only one committed selection across two SQLite connections", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    finishTask(fixture.store, source.taskId, 1);
    const firstCurrent = startTask(fixture, 2);
    const secondCurrent = seedAdditionalRunningTask(fixture, 3);
    const groupId = "bb000000-0000-4000-8000-00000000000b";
    const optionRef = "bc000000-0000-4000-8000-00000000000c";
    seedGroup(fixture.filename, {
      groupId,
      groupLabel: "two connections",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(25),
      options: [
        {
          ordinal: 1,
          optionRef,
          valueJson: '{"openId":"ou_private_contested"}',
          displayLabel: "contested candidate",
        },
      ],
    });
    const firstDatabase = new Database(fixture.filename);
    const secondDatabase = new Database(fixture.filename);
    try {
      firstDatabase.pragma("foreign_keys = ON");
      firstDatabase.pragma("busy_timeout = 5000");
      secondDatabase.pragma("foreign_keys = ON");
      secondDatabase.pragma("busy_timeout = 5000");

      expect(
        consumeDirect(
          firstDatabase,
          "instance-a",
          firstCurrent.taskId,
          optionRef,
          "contact",
          at(70),
        ),
      ).toMatchObject({ groupId, optionRef });
      expect(() =>
        consumeDirect(
          secondDatabase,
          "instance-a",
          secondCurrent.taskId,
          optionRef,
          "contact",
          at(70),
        ),
      ).toThrowError(/clarification_not_available/);
    } finally {
      firstDatabase.close();
      secondDatabase.close();
    }
    expect(
      queryRows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM clarification_selections",
      ),
    ).toEqual([{ count: 1 }]);
  });

  it("allows at most one overlapping batch across two SQLite connections", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    finishTask(fixture.store, source.taskId, 1);
    const firstCurrent = startTask(fixture, 2);
    const secondCurrent = seedAdditionalRunningTask(fixture, 3);
    const groupIds = [
      "bd000000-0000-4000-8000-00000000000d",
      "be000000-0000-4000-8000-00000000000e",
      "bf000000-0000-4000-8000-00000000000f",
    ] as const;
    const optionRefs = [
      "c0000000-0000-4000-8000-000000000010",
      "c1000000-0000-4000-8000-000000000011",
      "c2000000-0000-4000-8000-000000000012",
    ] as const;
    for (const [index, groupId] of groupIds.entries()) {
      seedGroup(fixture.filename, {
        groupId,
        groupLabel: `overlap-${index + 1}`,
        kind: "contact",
        sourceTaskId: source.taskId,
        principalHash: source.actorHash,
        chatHash: source.chatHash,
        createdAt: at(25 + index),
        options: [
          {
            ordinal: 1,
            optionRef: optionRefs[index] as string,
            valueJson: `{"openId":"ou_private_overlap_${index + 1}"}`,
            displayLabel: `overlap-${index + 1}`,
          },
        ],
      });
    }
    const firstDatabase = new Database(fixture.filename);
    const secondDatabase = new Database(fixture.filename);
    try {
      firstDatabase.pragma("foreign_keys = ON");
      firstDatabase.pragma("busy_timeout = 5000");
      secondDatabase.pragma("foreign_keys = ON");
      secondDatabase.pragma("busy_timeout = 5000");

      expect(
        consumeBatchDirect(
          firstDatabase,
          "instance-a",
          firstCurrent.taskId,
          [optionRefs[0], optionRefs[1]],
          "contact",
          at(70),
        ),
      ).toHaveLength(2);
      expect(() =>
        consumeBatchDirect(
          secondDatabase,
          "instance-a",
          secondCurrent.taskId,
          [optionRefs[1], optionRefs[2]],
          "contact",
          at(70),
        ),
      ).toThrowError(/clarification_not_available/);
    } finally {
      firstDatabase.close();
      secondDatabase.close();
    }
    expect(
      queryRows<{ groupId: string }>(
        fixture.filename,
        "SELECT group_id AS groupId FROM clarification_selections ORDER BY group_id",
      ),
    ).toEqual([{ groupId: groupIds[0] }, { groupId: groupIds[1] }]);
  });

  it("rejects opaque public identifiers that reuse source ledger identifiers", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    finishTask(fixture.store, source.taskId, 1);
    const current = startTask(fixture, 2);
    seedGroup(fixture.filename, {
      groupId: source.taskId,
      groupLabel: "选择联系人",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(25),
      options: [
        {
          ordinal: 1,
          optionRef: "be000000-0000-4000-8000-000000000001",
          valueJson: '{"openId":"ou_private"}',
          displayLabel: "candidate",
        },
      ],
    });

    expect(() =>
      asClarificationStore(fixture.store).listPendingClarificationsForTask(
        current.taskId,
        at(50),
      ),
    ).toThrowError(/clarification_persistence_failed/);
  });

  it("fails closed on non-canonical values, payload hash drift, and inconsistent group rows", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    finishTask(fixture.store, source.taskId, 1);
    const current = startTask(fixture, 2);
    const groupId = "c0000000-0000-4000-8000-000000000001";
    seedGroup(fixture.filename, {
      groupId,
      groupLabel: "选择联系人",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(25),
      options: [
        {
          ordinal: 1,
          optionRef: "c1000000-0000-4000-8000-000000000001",
          valueJson: '{"openId":"ou_private_first"}',
          displayLabel: "first",
          payloadHash: `sha256:${"0".repeat(64)}`,
        },
        {
          ordinal: 2,
          optionRef: "c2000000-0000-4000-8000-000000000002",
          valueJson: '{"openId": "ou_private_second"}',
          displayLabel: "second",
        },
      ],
    });

    expect(() =>
      asClarificationStore(fixture.store).listPendingClarificationsForTask(
        current.taskId,
        at(50),
      ),
    ).toThrowError(/clarification_persistence_failed/);
    expect(
      queryRows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM clarification_selections",
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("rejects malformed public inputs before querying or consuming", async () => {
    const fixture = await storeFixture();
    const source = startTask(fixture, 1);
    finishTask(fixture.store, source.taskId, 1);
    const current = startTask(fixture, 2);
    const optionRef = "d0000000-0000-4000-8000-000000000001";
    seedGroup(fixture.filename, {
      groupId: "d1000000-0000-4000-8000-000000000001",
      groupLabel: "选择联系人",
      kind: "contact",
      sourceTaskId: source.taskId,
      principalHash: source.actorHash,
      chatHash: source.chatHash,
      createdAt: at(25),
      options: [
        {
          ordinal: 1,
          optionRef,
          valueJson: '{"openId":"ou_private"}',
          displayLabel: "candidate",
        },
      ],
    });

    expect(() =>
      asClarificationStore(fixture.store).listPendingClarificationsForTask(
        "not-a-task",
        at(50),
      ),
    ).toThrowError(/clarification_input_is_invalid/);
    expect(() =>
      asClarificationStore(fixture.store).listPendingClarificationsForTask(
        current.taskId,
        new Date("invalid"),
      ),
    ).toThrowError(/clarification_input_is_invalid/);
    expect(() =>
      asClarificationStore(fixture.store).listPendingClarificationsForTask(
        current.taskId,
        new Proxy(at(50), {}),
      ),
    ).toThrowError(/clarification_input_is_invalid/);
    class DateSubclass extends Date {}
    expect(() =>
      asClarificationStore(fixture.store).listPendingClarificationsForTask(
        current.taskId,
        new DateSubclass(at(50).getTime()),
      ),
    ).toThrowError(/clarification_input_is_invalid/);
    const dateWithOwnProperty = at(50) as Date & { marker?: string };
    dateWithOwnProperty.marker = "untrusted";
    expect(() =>
      asClarificationStore(fixture.store).listPendingClarificationsForTask(
        current.taskId,
        dateWithOwnProperty,
      ),
    ).toThrowError(/clarification_input_is_invalid/);
    expect(() =>
      asClarificationStore(fixture.store).consumeClarificationForTask(
        current.taskId,
        optionRef,
        "contact",
        new Proxy(at(50), {}),
      ),
    ).toThrowError(/clarification_input_is_invalid/);
    expect(() =>
      asClarificationStore(fixture.store).consumeClarificationForTask(
        current.taskId,
        optionRef,
        "other" as ClarificationKind,
        at(50),
      ),
    ).toThrowError(/clarification_input_is_invalid/);
    expect(
      queryRows<{ count: number }>(
        fixture.filename,
        "SELECT COUNT(*) AS count FROM clarification_selections",
      ),
    ).toEqual([{ count: 0 }]);
  });
});
