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

import type {
  CancelActiveTaskRequest,
  InboundEvent,
} from "@executive-assistant/contracts";
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
  for (const store of openStores.splice(0)) store.close();
  for (const lock of fileLocks.splice(0)) await lock.release();
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function at(milliseconds: number): Date {
  return new Date(Date.UTC(2026, 6, 22, 8, 0, 0, milliseconds));
}

function event(
  sequence = 1,
  overrides: Partial<InboundEvent> = {},
): InboundEvent {
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
    ...overrides,
  };
}

function cancelRequest(
  overrides: Partial<CancelActiveTaskRequest> = {},
): CancelActiveTaskRequest {
  return {
    appId: "cli_test_app",
    tenantKey: "tenant_test_001",
    eventId: "cancel_event_1",
    messageId: "cancel_message_1",
    senderOpenId: "ou_synthetic_president",
    chatId: "oc_synthetic_private_chat",
    receivedAt: at(50).toISOString(),
    ...overrides,
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
    join(realpathSync(tmpdir()), "job-store-tasks-"),
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

async function storePairFixture(): Promise<{
  filename: string;
  runtimeDir: string;
  first: JobStore;
  second: JobStore;
}> {
  const { filename, runtimeDir, store: first } = await storeFixture();
  const lock = fileLocks.at(-1);
  if (lock === undefined) throw new Error("fixture lock missing");
  const second = openJobStore({ filename, instanceId: "instance-b", lock });
  openStores.push(second);
  return { filename, runtimeDir, first, second };
}

function mutate(filename: string, sql: string, ...parameters: unknown[]): void {
  const database = new Database(filename);
  try {
    database.prepare(sql).run(...parameters);
  } finally {
    database.close();
  }
}

function rows<T>(filename: string, sql: string): T[] {
  const database = new Database(filename, { readonly: true });
  try {
    return database.prepare(sql).all() as T[];
  } finally {
    database.close();
  }
}

function seedPrincipal(
  filename: string,
  input: Readonly<{
    appId?: string;
    tenantKey?: string;
    presidentOpenId?: string;
    presidentChatId?: string;
  }> = {},
): void {
  mutate(
    filename,
    `INSERT INTO principals(app_id, tenant_key, president_open_id, president_chat_id, paired_at)
     VALUES (?, ?, ?, ?, ?)`,
    input.appId ?? "cli_test_app",
    input.tenantKey ?? "tenant_test_001",
    input.presidentOpenId ?? "ou_synthetic_president",
    input.presidentChatId ?? "oc_synthetic_private_chat",
    at(0).toISOString(),
  );
}

type SeedActionState =
  | "PREPARED"
  | "APPROVED"
  | "CLAIMED"
  | "DISPATCHING"
  | "UNKNOWN"
  | "SUCCEEDED"
  | "FAILED"
  | "RECONCILED";

function seedActionAudit(
  filename: string,
  input: Readonly<{
    actionId: string;
    approvalMode: "president" | "system_policy";
    state: SeedActionState;
    actorHash: string;
    chatHash: string;
    nonceHash: string;
    payloadHash: string;
  }>,
): void {
  const createdAt = at(1).toISOString();
  const transition = (
    fromState: SeedActionState | null,
    toState: SeedActionState,
    reasonCode: string,
    evidenceDigest: string | null = null,
  ) => {
    mutate(
      filename,
      `INSERT INTO action_transitions(
         action_id, from_state, to_state, reason_code, evidence_digest,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      input.actionId,
      fromState,
      toState,
      reasonCode,
      evidenceDigest,
      createdAt,
    );
  };
  const approval = (decision: "APPROVED") => {
    mutate(
      filename,
      `INSERT INTO approvals(
         id, action_id, action_version, actor_open_id_hash, chat_id_hash,
         payload_hash, nonce_hash, decision, decided_at
       ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      randomUUID(),
      input.actionId,
      input.actorHash,
      input.chatHash,
      input.payloadHash,
      input.nonceHash,
      decision,
      createdAt,
    );
  };
  const attempt = (
    attemptId: string,
    phase: "STARTED" | "FINISHED",
    attemptKind: "DISPATCH" | "SYSTEM_REPLY" | "RECONCILE",
    outcome: "SUCCEEDED" | "INDETERMINATE" | null,
    resultJson: string | null,
  ) => {
    mutate(
      filename,
      `INSERT INTO action_attempts(
         id, action_id, attempt_id, phase, attempt_kind, outcome,
         request_digest, result_digest, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(),
      input.actionId,
      attemptId,
      phase,
      attemptKind,
      outcome,
      `sha256:${"d".repeat(64)}`,
      resultJson === null
        ? null
        : `sha256:${createHash("sha256").update(resultJson).digest("hex")}`,
      createdAt,
    );
  };

  if (input.approvalMode === "system_policy") {
    if (input.state === "PREPARED") {
      throw new Error(
        "system-policy actions are seeded as automatically approved",
      );
    }
    transition(null, "APPROVED", "system_policy_approved");
  } else {
    transition(null, "PREPARED", "prepared");
    if (input.state === "PREPARED") return;
    transition("PREPARED", "APPROVED", "approved");
    approval("APPROVED");
  }

  if (input.state === "APPROVED") return;
  if (input.state === "FAILED") {
    transition("APPROVED", "FAILED", "restart_invalidated");
    return;
  }
  transition("APPROVED", "CLAIMED", "claimed");
  if (input.state === "CLAIMED") return;
  transition("CLAIMED", "DISPATCHING", "dispatch_started");
  const dispatchAttemptId = randomUUID();
  attempt(
    dispatchAttemptId,
    "STARTED",
    input.approvalMode === "system_policy" ? "SYSTEM_REPLY" : "DISPATCH",
    null,
    null,
  );
  if (input.state === "DISPATCHING") return;
  if (input.state === "SUCCEEDED") {
    const resultJson = '{"outcome":"SUCCEEDED"}';
    transition("DISPATCHING", "SUCCEEDED", "dispatch_finished");
    attempt(
      dispatchAttemptId,
      "FINISHED",
      input.approvalMode === "system_policy" ? "SYSTEM_REPLY" : "DISPATCH",
      "SUCCEEDED",
      resultJson,
    );
    return;
  }
  transition("DISPATCHING", "UNKNOWN", "restart_dispatch_unknown");
  if (input.state === "UNKNOWN") return;
  if (input.state !== "RECONCILED") {
    throw new Error(`unsupported seeded action state: ${input.state}`);
  }
  const reconcileAttemptId = randomUUID();
  attempt(reconcileAttemptId, "STARTED", "RECONCILE", null, null);
  const evidenceDigest = `sha256:${"e".repeat(64)}`;
  transition("UNKNOWN", "RECONCILED", "reconciled", evidenceDigest);
  mutate(
    filename,
    `INSERT INTO reconciliations(
       id, action_id, outcome, evidence_digest, operator_kind, created_at
     ) VALUES (?, ?, 'INDETERMINATE', ?, 'manual', ?)`,
    randomUUID(),
    input.actionId,
    evidenceDigest,
    createdAt,
  );
  attempt(
    reconcileAttemptId,
    "FINISHED",
    "RECONCILE",
    "INDETERMINATE",
    '{"outcome":"INDETERMINATE"}',
  );
}

function seedControlAction(
  filename: string,
  controlEventId: string,
  state:
    | "APPROVED"
    | "CLAIMED"
    | "DISPATCHING"
    | "UNKNOWN"
    | "SUCCEEDED"
    | "FAILED"
    | "RECONCILED",
): string {
  const id = randomUUID();
  const payloadHash = `sha256:${createHash("sha256").update("{}").digest("hex")}`;
  const hasLease = state === "CLAIMED" || state === "DISPATCHING";
  const actorHash = createHash("sha256")
    .update("ou_synthetic_president")
    .digest("hex");
  const chatHash = createHash("sha256")
    .update("oc_synthetic_private_chat")
    .digest("hex");
  const nonceHash = createHash("sha256").update(`nonce-${id}`).digest("hex");
  const resultJson =
    state === "SUCCEEDED"
      ? '{"outcome":"SUCCEEDED"}'
      : state === "RECONCILED"
        ? '{"outcome":"INDETERMINATE"}'
        : null;
  mutate(
    filename,
    `INSERT INTO actions(
       id, control_event_id, version, capability, identity, approval_mode,
       state, payload_json, payload_hash, preview_json, actor_open_id_hash,
       chat_id_hash, nonce_hash, idempotency_key, expires_at, lease_owner,
       lease_expires_at, remote_id, result_json, reconcile_outcome,
       created_at, updated_at
     ) VALUES (?, ?, 1, 'system_reply', 'bot', 'system_policy', ?, '{}', ?, '{}', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    id,
    controlEventId,
    state,
    payloadHash,
    actorHash,
    chatHash,
    nonceHash,
    id,
    at(10_000).toISOString(),
    hasLease ? "instance-a" : null,
    hasLease ? at(10_000).toISOString() : null,
    resultJson,
    state === "RECONCILED" ? "INDETERMINATE" : null,
    at(1).toISOString(),
    at(1).toISOString(),
  );
  seedActionAudit(filename, {
    actionId: id,
    approvalMode: "system_policy",
    state,
    actorHash,
    chatHash,
    nonceHash,
    payloadHash,
  });
  return id;
}

function seedAction(
  filename: string,
  taskId: string,
  state: "PREPARED" | "APPROVED" | "CLAIMED" | "DISPATCHING" | "UNKNOWN",
): string {
  const id = randomUUID();
  const payloadHash = `sha256:${createHash("sha256").update("{}").digest("hex")}`;
  const hasLease = state === "CLAIMED" || state === "DISPATCHING";
  const actorHash = createHash("sha256")
    .update("ou_synthetic_president")
    .digest("hex");
  const chatHash = createHash("sha256")
    .update("oc_synthetic_private_chat")
    .digest("hex");
  const nonceHash = createHash("sha256").update(`nonce-${id}`).digest("hex");
  mutate(
    filename,
    `INSERT INTO actions(
       id, task_id, version, capability, identity, approval_mode, state,
       payload_json, payload_hash, preview_json, actor_open_id_hash,
       chat_id_hash, nonce_hash, idempotency_key, expires_at, lease_owner,
       lease_expires_at, created_at, updated_at
     ) VALUES (?, ?, 1, 'send_message', 'user', 'president', ?, '{}', ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    taskId,
    state,
    payloadHash,
    actorHash,
    chatHash,
    nonceHash,
    id,
    at(1 + 30 * 60 * 1_000).toISOString(),
    hasLease ? "instance-a" : null,
    hasLease ? at(10_000).toISOString() : null,
    at(1).toISOString(),
    at(1).toISOString(),
  );
  seedActionAudit(filename, {
    actionId: id,
    approvalMode: "president",
    state,
    actorHash,
    chatHash,
    nonceHash,
    payloadHash,
  });
  return id;
}

function claimAndRun(store: JobStore, taskId: string): void {
  expect(
    store.acquireRuntimeLease("bridge", "instance-a", at(10), 10_000),
  ).toBe(true);
  expect(
    store.beginTaskAcknowledgement({
      taskId,
      owner: "instance-a",
      now: at(10),
    }),
  ).toMatchObject({ taskId, state: "SENDING" });
  expect(
    store.finishTaskAcknowledgement({
      taskId,
      owner: "instance-a",
      now: at(10),
      state: "ACKNOWLEDGED",
      failureClass: null,
    }),
  ).toMatchObject({ state: "ACKNOWLEDGED" });
  expect(store.claimNextTask("instance-a", at(11), 1_000)?.id).toBe(taskId);
  expect(
    store.markRunning({
      taskId,
      owner: "instance-a",
      codexSessionId: "session-1",
      now: at(12),
      ttlMs: 1_000,
    })?.state,
  ).toBe("RUNNING");
}

function acknowledgeNext(store: JobStore, taskId: string, now: Date): void {
  const acknowledgement = store.beginTaskAcknowledgement({
    taskId,
    owner: "instance-a",
    now,
  });
  expect(acknowledgement).not.toBeNull();
  store.finishTaskAcknowledgement({
    taskId,
    owner: "instance-a",
    now,
    state: "ACKNOWLEDGED",
    failureClass: null,
  });
}

describe("task lifecycle", () => {
  it.each(["mark", "touch", "finish"] as const)(
    "fences stale owner %s after bridge takeover without mutating the task",
    async (operation) => {
      const { runtimeDir, first, second } = await storePairFixture();
      const { taskId } = first.ingestEvent(event(), workspace(runtimeDir));
      expect(
        first.acquireRuntimeLease("bridge", "instance-a", at(10), 100),
      ).toBe(true);
      acknowledgeNext(first, taskId, at(10));
      expect(first.claimNextTask("instance-a", at(11), 1_000)?.state).toBe(
        "CLAIMED",
      );
      if (operation !== "mark") {
        expect(
          first.markRunning({
            taskId,
            owner: "instance-a",
            codexSessionId: "session-1",
            now: at(12),
            ttlMs: 1_000,
          })?.state,
        ).toBe("RUNNING");
      }
      const beforeTakeover = first.getTask(taskId);
      expect(
        second.acquireRuntimeLease("bridge", "instance-b", at(111), 1_000),
      ).toBe(true);

      const lifecycle = () => {
        if (operation === "mark") {
          return first.markRunning({
            taskId,
            owner: "instance-a",
            codexSessionId: "session-1",
            now: at(112),
            ttlMs: 1_000,
          });
        }
        if (operation === "touch") {
          return first.touchTask({
            taskId,
            owner: "instance-a",
            codexSessionId: "session-1",
            now: at(112),
            ttlMs: 1_000,
            stage: "must_not_persist",
          });
        }
        return first.finishTask({
          taskId,
          owner: "instance-a",
          codexSessionId: "session-1",
          now: at(112),
          outcome: "FAILED",
        });
      };

      expect(lifecycle).toThrowError(/bridge_runtime_lease_is_not_live/);
      expect(first.getTask(taskId)).toEqual(beforeTakeover);
    },
  );

  it("blocks touch when the owner's bridge lease expired without takeover", async () => {
    const { runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    expect(store.acquireRuntimeLease("bridge", "instance-a", at(10), 100)).toBe(
      true,
    );
    acknowledgeNext(store, taskId, at(10));
    expect(store.claimNextTask("instance-a", at(11), 1_000)?.state).toBe(
      "CLAIMED",
    );
    expect(
      store.markRunning({
        taskId,
        owner: "instance-a",
        codexSessionId: "session-1",
        now: at(12),
        ttlMs: 1_000,
      })?.state,
    ).toBe("RUNNING");
    const beforeExpiry = store.getTask(taskId);

    expect(() =>
      store.touchTask({
        taskId,
        owner: "instance-a",
        codexSessionId: "session-1",
        now: at(111),
        ttlMs: 1_000,
        stage: "must_not_persist",
      }),
    ).toThrowError(/bridge_runtime_lease_is_not_live/);
    expect(store.getTask(taskId)).toEqual(beforeExpiry);
  });

  it("claims, starts, touches and finishes by owner/session/live-lease CAS", async () => {
    const { runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    claimAndRun(store, taskId);

    expect(
      store.touchTask({
        taskId,
        owner: "wrong",
        codexSessionId: "session-1",
        now: at(13),
        ttlMs: 1_000,
        stage: "working",
      }),
    ).toBeNull();
    expect(
      store.touchTask({
        taskId,
        owner: "instance-a",
        codexSessionId: "session-1",
        now: at(1_013),
        ttlMs: 1_000,
        stage: "working",
      }),
    ).toBeNull();

    const touched = store.touchTask({
      taskId,
      owner: "instance-a",
      codexSessionId: "session-1",
      now: at(13),
      ttlMs: 2_000,
      stage: "tool_call",
    });
    expect(touched).toMatchObject({
      stage: "tool_call",
      lastEventAt: at(13).toISOString(),
      leaseExpiresAt: at(2_013).toISOString(),
    });
    expect(
      store.finishTask({
        taskId,
        owner: "instance-a",
        codexSessionId: "wrong",
        now: at(14),
        outcome: "SUCCEEDED",
      }),
    ).toBeNull();
    expect(
      store.finishTask({
        taskId,
        owner: "instance-a",
        codexSessionId: "session-1",
        now: at(14),
        outcome: "SUCCEEDED",
      }),
    ).toMatchObject({ state: "SUCCEEDED", leaseOwner: null });
  });

  it("snapshots exact lifecycle inputs and rejects accessors, proxies, symbols, and unsafe stages", async () => {
    const { runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    claimAndRun(store, taskId);
    const getter = vi.fn(() => taskId);
    const accessor = {
      owner: "instance-a",
      codexSessionId: "session-1",
      now: at(13),
      ttlMs: 1_000,
      stage: "working",
    } as Parameters<JobStore["touchTask"]>[0];
    Object.defineProperty(accessor, "taskId", {
      enumerable: true,
      get: getter,
    });

    expect(() => store.touchTask(accessor)).toThrowError(
      /task_lifecycle_input_must_be_own_data_properties/,
    );
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      store.touchTask(
        new Proxy(
          {
            taskId,
            owner: "instance-a",
            codexSessionId: "session-1",
            now: at(13),
            ttlMs: 1_000,
            stage: "working",
          },
          {},
        ),
      ),
    ).toThrowError(/task_lifecycle_input_must_be_own_data_properties/);
    expect(() =>
      store.touchTask({
        taskId,
        owner: "instance-a",
        codexSessionId: "session-1",
        now: at(13),
        ttlMs: 1_000,
        stage: "bad\ncontrol",
        [Symbol("polluted")]: true,
      }),
    ).toThrowError(RuntimeStateError);
  });

  it("refuses successful finish while unresolved actions exist", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    claimAndRun(store, taskId);
    seedAction(filename, taskId, "PREPARED");

    expect(
      store.finishTask({
        taskId,
        owner: "instance-a",
        codexSessionId: "session-1",
        now: at(14),
        outcome: "SUCCEEDED",
      }),
    ).toBeNull();
    expect(store.getTask(taskId)?.state).toBe("RUNNING");
  });

  it("rolls failed finish back when a CLAIMED action owner drifts from its task", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    claimAndRun(store, taskId);
    const actionId = seedAction(filename, taskId, "CLAIMED");
    mutate(
      filename,
      "UPDATE actions SET lease_owner = 'instance-b' WHERE id = ?",
      actionId,
    );

    expect(() =>
      store.finishTask({
        taskId,
        owner: "instance-a",
        codexSessionId: "session-1",
        now: at(14),
        outcome: "FAILED",
      }),
    ).toThrowError(/action_persistence_failed/);
    expect(store.getTask(taskId)).toMatchObject({
      state: "RUNNING",
      leaseOwner: "instance-a",
    });
    expect(
      rows<{ state: string; leaseOwner: string }>(
        filename,
        `SELECT state, lease_owner AS leaseOwner FROM actions WHERE id = '${actionId}'`,
      ),
    ).toEqual([{ state: "CLAIMED", leaseOwner: "instance-b" }]);
    expect(
      rows<{ count: number }>(
        filename,
        "SELECT COUNT(*) AS count FROM action_transitions",
      ),
    ).toEqual([{ count: 3 }]);
  });

  it("keeps stale owner, session, and expiry lifecycle attempts as CAS misses", async () => {
    const { runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    expect(
      store.acquireRuntimeLease("bridge", "instance-a", at(10), 10_000),
    ).toBe(true);
    acknowledgeNext(store, taskId, at(10));
    expect(store.claimNextTask("instance-a", at(11), 100)).not.toBeNull();
    expect(
      store.markRunning({
        taskId,
        owner: "wrong-owner",
        codexSessionId: "session-1",
        now: at(12),
        ttlMs: 100,
      }),
    ).toBeNull();
    expect(
      store.markRunning({
        taskId,
        owner: "instance-a",
        codexSessionId: "session-1",
        now: at(112),
        ttlMs: 100,
      }),
    ).toBeNull();
    expect(
      store.markRunning({
        taskId,
        owner: "instance-a",
        codexSessionId: "session-1",
        now: at(12),
        ttlMs: 100,
      }),
    ).not.toBeNull();
    expect(
      store.touchTask({
        taskId,
        owner: "instance-a",
        codexSessionId: "wrong-session",
        now: at(13),
        ttlMs: 100,
        stage: "working",
      }),
    ).toBeNull();
    expect(
      store.finishTask({
        taskId,
        owner: "instance-a",
        codexSessionId: "session-1",
        now: at(113),
        outcome: "FAILED",
      }),
    ).toBeNull();
    expect(store.getTask(taskId)?.state).toBe("RUNNING");
  });
});

describe("recovery and replacement", () => {
  it("interrupts only strictly expired active tasks and invalidates their actions", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    claimAndRun(store, taskId);
    const dispatching = seedAction(filename, taskId, "DISPATCHING");

    expect(store.interruptExpiredTasks(at(1_012))).toEqual({
      tasksInterrupted: 0,
      actionsFailed: 0,
      actionsUnknown: 0,
    });
    expect(store.interruptExpiredTasks(at(1_013))).toEqual({
      tasksInterrupted: 2 - 1,
      actionsFailed: 0,
      actionsUnknown: 1,
    });
    expect(store.getTask(taskId)).toMatchObject({
      state: "INTERRUPTED_REQUIRES_CONFIRMATION",
      recoveryDisposition: "REQUIRES_CONFIRMATION",
      codexSessionId: "session-1",
      leaseOwner: null,
    });
    expect(
      rows<{ id: string; state: string }>(
        filename,
        "SELECT id, state FROM actions ORDER BY id",
      ),
    ).toEqual(expect.arrayContaining([{ id: dispatching, state: "UNKNOWN" }]));
    expect(
      rows<{ count: number }>(
        filename,
        "SELECT COUNT(*) AS count FROM action_transitions",
      ),
    ).toEqual([{ count: 5 }]);
    expect(
      rows<{ reasonCode: string }>(
        filename,
        `SELECT reason_code AS reasonCode FROM action_transitions
          WHERE reason_code = 'task_lease_expired_dispatch_unknown'`,
      ),
    ).toEqual([{ reasonCode: "task_lease_expired_dispatch_unknown" }]);
    expect(store.claimNextTask("instance-a", at(1_014), 1_000)).toBeNull();
  });

  it("records the fixed expired-task undispatched-action reason", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    claimAndRun(store, taskId);
    seedAction(filename, taskId, "CLAIMED");

    expect(store.interruptExpiredTasks(at(1_013))).toMatchObject({
      tasksInterrupted: 1,
      actionsFailed: 1,
      actionsUnknown: 0,
    });
    expect(
      rows<{ reasonCode: string }>(
        filename,
        `SELECT reason_code AS reasonCode FROM action_transitions
          WHERE reason_code = 'task_lease_expired_invalidated'`,
      ),
    ).toEqual([{ reasonCode: "task_lease_expired_invalidated" }]);
  });

  it.each(["CLAIMED", "RUNNING"] as const)(
    "interrupts %s on startup in one frozen summary",
    async (state) => {
      const { filename, runtimeDir, store } = await storeFixture();
      const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
      expect(
        store.acquireRuntimeLease("bridge", "instance-a", at(10), 10_000),
      ).toBe(true);
      acknowledgeNext(store, taskId, at(10));
      expect(store.claimNextTask("instance-a", at(11), 1_000)).not.toBeNull();
      if (state === "RUNNING") {
        expect(
          store.markRunning({
            taskId,
            owner: "instance-a",
            codexSessionId: "session-1",
            now: at(12),
            ttlMs: 1_000,
          }),
        ).not.toBeNull();
      }
      seedAction(filename, taskId, "APPROVED");

      const summary = store.recoverOnStartup(at(20));
      expect(summary).toEqual({
        tasksInterrupted: 1,
        actionsFailed: 1,
        actionsUnknown: 0,
      });
      expect(Object.isFrozen(summary)).toBe(true);
      expect(store.getTask(taskId)).toMatchObject({
        state: "INTERRUPTED_REQUIRES_CONFIRMATION",
        recoveryDisposition: "REQUIRES_CONFIRMATION",
        ...(state === "RUNNING" ? { codexSessionId: "session-1" } : {}),
      });
      expect(
        rows<{ reasonCode: string }>(
          filename,
          `SELECT reason_code AS reasonCode FROM action_transitions
            WHERE reason_code = 'restart_invalidated'`,
        ),
      ).toEqual([{ reasonCode: "restart_invalidated" }]);
    },
  );

  it("invalidates global terminal-task and control-event actions on startup", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    mutate(filename, "UPDATE tasks SET state = 'CLAIMED' WHERE id = ?", taskId);
    mutate(filename, "UPDATE tasks SET state = 'FAILED' WHERE id = ?", taskId);
    const terminalTaskAction = seedAction(filename, taskId, "PREPARED");
    seedPrincipal(filename);
    const control = store.cancelActiveTask(cancelRequest());
    const approved = seedControlAction(
      filename,
      control.controlEventId,
      "APPROVED",
    );
    const claimed = seedControlAction(
      filename,
      control.controlEventId,
      "CLAIMED",
    );
    const dispatching = seedControlAction(
      filename,
      control.controlEventId,
      "DISPATCHING",
    );
    const unchanged = (
      ["UNKNOWN", "SUCCEEDED", "FAILED", "RECONCILED"] as const
    ).map((state) => ({
      id: seedControlAction(filename, control.controlEventId, state),
      state,
    }));
    expect(
      store.acquireRuntimeLease("bridge", "instance-a", at(10), 10_000),
    ).toBe(true);

    expect(store.recoverOnStartup(at(20))).toEqual({
      tasksInterrupted: 0,
      actionsFailed: 3,
      actionsUnknown: 1,
    });
    expect(
      rows<{ id: string; state: string }>(
        filename,
        "SELECT id, state FROM actions ORDER BY id",
      ),
    ).toEqual(
      expect.arrayContaining([
        { id: terminalTaskAction, state: "FAILED" },
        { id: approved, state: "FAILED" },
        { id: claimed, state: "FAILED" },
        { id: dispatching, state: "UNKNOWN" },
        ...unchanged,
      ]),
    );
    expect(
      rows<{ reasonCode: string }>(
        filename,
        "SELECT reason_code AS reasonCode FROM action_transitions ORDER BY action_id",
      ),
    ).toEqual(
      expect.arrayContaining([
        { reasonCode: "restart_invalidated" },
        { reasonCode: "restart_dispatch_unknown" },
      ]),
    );
    expect(
      rows<{ count: number }>(
        filename,
        `SELECT COUNT(*) AS count FROM action_transitions
          WHERE reason_code IN ('restart_invalidated','restart_dispatch_unknown')
            AND created_at = '${at(20).toISOString()}'`,
      ),
    ).toEqual([{ count: 4 }]);
  });

  it("rolls startup task and action recovery back when transition append fails", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    const actionId = seedAction(filename, taskId, "PREPARED");
    expect(
      store.acquireRuntimeLease("bridge", "instance-a", at(10), 10_000),
    ).toBe(true);
    mutate(
      filename,
      `CREATE TRIGGER test_fail_startup_transition
       BEFORE INSERT ON action_transitions
       BEGIN SELECT RAISE(ABORT, 'synthetic startup transition failure'); END`,
    );

    expect(() => store.recoverOnStartup(at(20))).toThrowError(
      /task_persistence_failed/,
    );
    expect(store.getTask(taskId)?.state).toBe("RECEIVED");
    expect(
      rows<{ state: string }>(
        filename,
        `SELECT state FROM actions WHERE id = '${actionId}'`,
      ),
    ).toEqual([{ state: "PREPARED" }]);
    expect(
      rows<{ count: number }>(
        filename,
        "SELECT COUNT(*) AS count FROM action_transitions",
      ),
    ).toEqual([{ count: 1 }]);
  });

  it("rolls startup recovery back when its clock predates an active action", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    const actionId = seedAction(filename, taskId, "APPROVED");
    expect(
      store.acquireRuntimeLease("bridge", "instance-a", at(0), 10_000),
    ).toBe(true);

    expect(() => store.recoverOnStartup(at(0))).toThrowError(
      /action_persistence_failed/,
    );
    expect(store.getTask(taskId)?.state).toBe("RECEIVED");
    expect(
      rows<{ state: string; updatedAt: string }>(
        filename,
        `SELECT state, updated_at AS updatedAt FROM actions WHERE id = '${actionId}'`,
      ),
    ).toEqual([{ state: "APPROVED", updatedAt: at(1).toISOString() }]);
    expect(
      rows<{ count: number }>(
        filename,
        "SELECT COUNT(*) AS count FROM action_transitions",
      ),
    ).toEqual([{ count: 2 }]);
  });

  it("rolls an expired-task DISPATCHING invalidation back instead of creating unreadable UNKNOWN", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    claimAndRun(store, taskId);
    const actionId = seedAction(filename, taskId, "DISPATCHING");
    mutate(filename, "DROP TRIGGER action_transitions_append_only_update");
    mutate(filename, "DROP TRIGGER action_attempts_append_only_update");
    mutate(
      filename,
      `UPDATE action_transitions SET created_at = ?
        WHERE action_id = ? AND from_state = 'CLAIMED' AND to_state = 'DISPATCHING'`,
      at(2_000).toISOString(),
      actionId,
    );
    mutate(
      filename,
      `UPDATE action_attempts SET created_at = ?
        WHERE action_id = ? AND phase = 'STARTED' AND attempt_kind = 'DISPATCH'`,
      at(2_000).toISOString(),
      actionId,
    );
    mutate(
      filename,
      "UPDATE actions SET updated_at = ?, lease_expires_at = ? WHERE id = ?",
      at(2_000).toISOString(),
      at(3_000).toISOString(),
      actionId,
    );

    expect(() => store.interruptExpiredTasks(at(1_013))).toThrowError(
      /action_persistence_failed/,
    );
    expect(store.getTask(taskId)?.state).toBe("RUNNING");
    expect(
      rows<{ state: string; updatedAt: string }>(
        filename,
        `SELECT state, updated_at AS updatedAt FROM actions WHERE id = '${actionId}'`,
      ),
    ).toEqual([{ state: "DISPATCHING", updatedAt: at(2_000).toISOString() }]);
    expect(
      rows<{ count: number }>(
        filename,
        "SELECT COUNT(*) AS count FROM action_transitions",
      ),
    ).toEqual([{ count: 4 }]);
  });

  it("rolls expired-task interruption back when a DISPATCHING action owner drifts", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    claimAndRun(store, taskId);
    const actionId = seedAction(filename, taskId, "DISPATCHING");
    mutate(
      filename,
      "UPDATE actions SET lease_owner = 'instance-b' WHERE id = ?",
      actionId,
    );

    expect(() => store.interruptExpiredTasks(at(1_013))).toThrowError(
      /action_persistence_failed/,
    );
    expect(store.getTask(taskId)).toMatchObject({
      state: "RUNNING",
      leaseOwner: "instance-a",
    });
    expect(
      rows<{ state: string; leaseOwner: string }>(
        filename,
        `SELECT state, lease_owner AS leaseOwner FROM actions WHERE id = '${actionId}'`,
      ),
    ).toEqual([{ state: "DISPATCHING", leaseOwner: "instance-b" }]);
  });

  it("rolls startup recovery back when a CLAIMED action owner drifts", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    claimAndRun(store, taskId);
    const actionId = seedAction(filename, taskId, "CLAIMED");
    mutate(
      filename,
      "UPDATE actions SET lease_owner = 'instance-b' WHERE id = ?",
      actionId,
    );

    expect(() => store.recoverOnStartup(at(20))).toThrowError(
      /action_persistence_failed/,
    );
    expect(store.getTask(taskId)).toMatchObject({
      state: "RUNNING",
      leaseOwner: "instance-a",
    });
    expect(
      rows<{ state: string; leaseOwner: string }>(
        filename,
        `SELECT state, lease_owner AS leaseOwner FROM actions WHERE id = '${actionId}'`,
      ),
    ).toEqual([{ state: "CLAIMED", leaseOwner: "instance-b" }]);
  });

  it("creates one identity-bound replacement and returns its immutable replay", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    expect(
      store.acquireRuntimeLease("bridge", "instance-a", at(10), 10_000),
    ).toBe(true);
    mutate(
      filename,
      `UPDATE tasks SET state = 'INTERRUPTED_REQUIRES_CONFIRMATION',
       recovery_disposition = 'REQUIRES_CONFIRMATION' WHERE id = ?`,
      taskId,
    );
    const replacementPath = workspace(runtimeDir);

    const created = store.createReplacementTask(
      taskId,
      at(30),
      replacementPath,
    );
    expect(created).toMatchObject({
      duplicate: false,
      task: {
        id: replacementPath.split("/").at(-1),
        inboundEventId: expect.any(String),
        taskKind: "RESUME",
        resumedFromTaskId: taskId,
        state: "RECEIVED",
      },
    });
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created?.task)).toBe(true);
    const differentSafeCandidate = workspace(runtimeDir);
    expect(
      store.createReplacementTask(taskId, at(31), differentSafeCandidate),
    ).toEqual({
      task: created?.task,
      duplicate: true,
    });
    expect(store.getTask(taskId)).toMatchObject({
      state: "INTERRUPTED_REQUIRES_CONFIRMATION",
      recoveryDisposition: "RESUME_APPROVED",
    });
  });

  it("fails closed when an approved interruption has no replacement", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    expect(
      store.acquireRuntimeLease("bridge", "instance-a", at(10), 10_000),
    ).toBe(true);
    mutate(
      filename,
      `UPDATE tasks SET state = 'INTERRUPTED_REQUIRES_CONFIRMATION',
       recovery_disposition = 'REQUIRES_CONFIRMATION' WHERE id = ?`,
      taskId,
    );
    mutate(
      filename,
      "UPDATE tasks SET recovery_disposition = 'RESUME_APPROVED' WHERE id = ?",
      taskId,
    );
    expect(() =>
      store.createReplacementTask(taskId, at(30), workspace(runtimeDir)),
    ).toThrowError(/replacement_task_ledger_corrupted/);
  });

  it.each(["wrong inbound", "wrong workspace"] as const)(
    "fails closed on replacement replay with %s identity",
    async (corruption) => {
      const { filename, runtimeDir, store } = await storeFixture();
      const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
      expect(
        store.acquireRuntimeLease("bridge", "instance-a", at(10), 10_000),
      ).toBe(true);
      mutate(
        filename,
        `UPDATE tasks SET state = 'INTERRUPTED_REQUIRES_CONFIRMATION',
         recovery_disposition = 'REQUIRES_CONFIRMATION' WHERE id = ?`,
        taskId,
      );
      const replacementPath = workspace(runtimeDir);
      const replacement = store.createReplacementTask(
        taskId,
        at(30),
        replacementPath,
      );
      if (replacement === null) throw new Error("replacement fixture missing");
      if (corruption === "wrong inbound") {
        const other = store.ingestEvent(event(2), workspace(runtimeDir));
        const [otherTask] = rows<{ inboundEventId: string }>(
          filename,
          `SELECT inbound_event_id AS inboundEventId FROM tasks WHERE id = '${other.taskId}'`,
        );
        mutate(
          filename,
          "UPDATE tasks SET inbound_event_id = ? WHERE id = ?",
          otherTask?.inboundEventId,
          replacement.task.id,
        );
      } else {
        mutate(
          filename,
          "UPDATE tasks SET workspace_path = ? WHERE id = ?",
          workspace(runtimeDir),
          replacement.task.id,
        );
      }

      expect(() =>
        store.createReplacementTask(taskId, at(31), workspace(runtimeDir)),
      ).toThrowError(/replacement_task_ledger_corrupted/);
    },
  );
});

describe("cancel control", () => {
  it("authorizes against the principal, cancels once, invalidates actions, and replays saved pending fact", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    seedPrincipal(filename);
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    claimAndRun(store, taskId);
    const dispatching = seedAction(filename, taskId, "DISPATCHING");
    const request = cancelRequest();

    const first = store.cancelActiveTask(request);
    expect(first).toMatchObject({
      controlEventId: expect.any(String),
      taskId,
      cancelled: true,
      duplicate: false,
      externalEffectsPending: true,
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(store.cancelActiveTask(request)).toEqual({
      ...first,
      cancelled: false,
      duplicate: true,
    });
    expect(store.getTask(taskId)).toMatchObject({
      state: "CANCELLED",
      codexSessionId: "session-1",
      leaseOwner: null,
    });
    expect(
      rows<{ id: string; state: string }>(
        filename,
        "SELECT id, state FROM actions ORDER BY id",
      ),
    ).toEqual(expect.arrayContaining([{ id: dispatching, state: "UNKNOWN" }]));
    expect(
      rows<{ reasonCode: string }>(
        filename,
        `SELECT reason_code AS reasonCode FROM action_transitions
          WHERE reason_code = 'user_cancelled_dispatch_unknown'`,
      ),
    ).toEqual([{ reasonCode: "user_cancelled_dispatch_unknown" }]);
    expect(
      rows<{ count: number; pending: number }>(
        filename,
        "SELECT COUNT(*) AS count, external_effects_pending AS pending FROM control_events",
      ),
    ).toEqual([{ count: 1, pending: 1 }]);
  });

  it("records an authorized no-active cancellation without claiming cancellation", async () => {
    const { filename, store } = await storeFixture();
    seedPrincipal(filename);

    expect(store.cancelActiveTask(cancelRequest())).toMatchObject({
      taskId: null,
      cancelled: false,
      duplicate: false,
      externalEffectsPending: false,
    });
  });

  it("records the fixed user-cancelled reason for an undispatched action", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    seedPrincipal(filename);
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    seedAction(filename, taskId, "APPROVED");

    expect(store.cancelActiveTask(cancelRequest())).toMatchObject({
      taskId,
      cancelled: true,
      externalEffectsPending: false,
    });
    expect(
      rows<{ state: string; reasonCode: string }>(
        filename,
        `SELECT actions.state, action_transitions.reason_code AS reasonCode
           FROM actions
           JOIN action_transitions ON action_transitions.action_id = actions.id
          WHERE action_transitions.reason_code = 'user_cancelled'`,
      ),
    ).toEqual([{ state: "FAILED", reasonCode: "user_cancelled" }]);
  });

  it.each([
    ["whole seconds", "2026-07-22T08:00:00Z"],
    ["one fractional digit", "2026-07-22T08:00:00.1Z"],
  ])(
    "normalizes %s cancel time and deduplicates an equivalent canonical replay",
    async (_caseName, receivedAt) => {
      const { filename, store } = await storeFixture();
      seedPrincipal(filename);
      const request = cancelRequest({ receivedAt });
      const first = store.cancelActiveTask(request);
      const canonicalReceivedAt = new Date(receivedAt).toISOString();

      expect(
        store.cancelActiveTask({ ...request, receivedAt: canonicalReceivedAt }),
      ).toEqual({ ...first, duplicate: true });
      expect(
        rows<{ receivedAt: string }>(
          filename,
          "SELECT received_at AS receivedAt FROM control_events",
        ),
      ).toEqual([{ receivedAt: canonicalReceivedAt }]);
    },
  );

  it.each([
    ["date-only", "2026-07-22"],
    ["natural language", "July 22, 2026 08:00:00 UTC"],
    ["offset", "2026-07-22T16:00:00+08:00"],
  ])(
    "rejects a %s cancel timestamp before persistence",
    async (_caseName, receivedAt) => {
      const { filename, store } = await storeFixture();
      seedPrincipal(filename);

      expect(() =>
        store.cancelActiveTask(cancelRequest({ receivedAt })),
      ).toThrowError(/cancel_request_is_invalid/);
      expect(
        rows<{ count: number }>(
          filename,
          "SELECT COUNT(*) AS count FROM control_events",
        ),
      ).toEqual([{ count: 0 }]);
    },
  );

  it.each([
    ["date-only", "2026-07-22"],
    ["natural language", "July 22, 2026 08:00:00 UTC"],
    ["offset", "2026-07-22T16:00:00+08:00"],
  ])(
    "fails closed when replay encounters a %s control timestamp",
    async (_caseName, receivedAt) => {
      const { filename, store } = await storeFixture();
      const request = cancelRequest();
      mutate(
        filename,
        `INSERT INTO control_events(
           id, app_id, tenant_key, event_id, message_id, command,
           actor_open_id_hash, chat_id_hash, target_task_id, received_at,
           external_effects_pending
         ) VALUES (?, ?, ?, ?, ?, 'CANCEL_ACTIVE_TASK', ?, ?, NULL, ?, 0)`,
        randomUUID(),
        request.appId,
        request.tenantKey,
        request.eventId,
        request.messageId,
        createHash("sha256").update(request.senderOpenId).digest("hex"),
        createHash("sha256").update(request.chatId).digest("hex"),
        receivedAt,
      );

      expect(() => store.cancelActiveTask(request)).toThrowError(
        /cancel_control_persistence_failed/,
      );
    },
  );

  it("isolates app tenant and chat, rejects a wrong paired chat, and cancels the earliest matching task", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    seedPrincipal(filename);
    store.ingestEvent(
      event(1, {
        appId: "other_app",
        eventId: "other_app_event",
        messageId: "other_app_message",
      }),
      workspace(runtimeDir),
    );
    store.ingestEvent(
      event(2, {
        tenantKey: "other_tenant",
        eventId: "other_tenant_event",
        messageId: "other_tenant_message",
      }),
      workspace(runtimeDir),
    );
    store.ingestEvent(
      event(3, {
        chatId: "oc_other_chat",
        eventId: "other_chat_event",
        messageId: "other_chat_message",
      }),
      workspace(runtimeDir),
    );
    const later = store.ingestEvent(event(20), workspace(runtimeDir));
    const earlier = store.ingestEvent(event(10), workspace(runtimeDir));

    expect(
      store.cancelActiveTask(
        cancelRequest({
          eventId: "cancel_earliest",
          messageId: "cancel_earliest",
        }),
      ),
    ).toMatchObject({ taskId: earlier.taskId, cancelled: true });
    expect(store.getTask(later.taskId)?.state).toBe("RECEIVED");
    expect(() =>
      store.cancelActiveTask(
        cancelRequest({
          eventId: "cancel_wrong_chat",
          messageId: "cancel_wrong_chat",
          chatId: "oc_other_chat",
        }),
      ),
    ).toThrowError(/cancel_principal_not_authorized/);
    expect(
      rows<{ count: number }>(
        filename,
        "SELECT COUNT(*) AS count FROM control_events",
      ),
    ).toEqual([{ count: 1 }]);
  });

  it("rolls control, task, action, and transition changes back together", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    seedPrincipal(filename);
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    claimAndRun(store, taskId);
    const actionId = seedAction(filename, taskId, "PREPARED");
    mutate(
      filename,
      `CREATE TRIGGER test_fail_cancel_transition
       BEFORE INSERT ON action_transitions
       BEGIN SELECT RAISE(ABORT, 'synthetic cancel transition failure'); END`,
    );

    expect(() => store.cancelActiveTask(cancelRequest())).toThrowError(
      /cancel_control_persistence_failed/,
    );
    expect(store.getTask(taskId)).toMatchObject({
      state: "RUNNING",
      codexSessionId: "session-1",
      leaseOwner: "instance-a",
    });
    expect(
      rows<{ state: string }>(
        filename,
        `SELECT state FROM actions WHERE id = '${actionId}'`,
      ),
    ).toEqual([{ state: "PREPARED" }]);
    expect(
      rows<{ controls: number; transitions: number }>(
        filename,
        `SELECT
           (SELECT COUNT(*) FROM control_events) AS controls,
           (SELECT COUNT(*) FROM action_transitions) AS transitions`,
      ),
    ).toEqual([{ controls: 0, transitions: 1 }]);
  });

  it("rolls cancellation back when its event time predates an active action", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    seedPrincipal(filename);
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    const actionId = seedAction(filename, taskId, "APPROVED");

    expect(() =>
      store.cancelActiveTask(
        cancelRequest({ receivedAt: at(0).toISOString() }),
      ),
    ).toThrowError(/action_persistence_failed/);
    expect(store.getTask(taskId)?.state).toBe("RECEIVED");
    expect(
      rows<{ state: string; updatedAt: string }>(
        filename,
        `SELECT state, updated_at AS updatedAt FROM actions WHERE id = '${actionId}'`,
      ),
    ).toEqual([{ state: "APPROVED", updatedAt: at(1).toISOString() }]);
    expect(
      rows<{ controls: number; transitions: number }>(
        filename,
        `SELECT
           (SELECT COUNT(*) FROM control_events) AS controls,
           (SELECT COUNT(*) FROM action_transitions) AS transitions`,
      ),
    ).toEqual([{ controls: 0, transitions: 2 }]);
  });

  it("rolls cancellation back when a DISPATCHING action owner drifts from its task", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    seedPrincipal(filename);
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    claimAndRun(store, taskId);
    const actionId = seedAction(filename, taskId, "DISPATCHING");
    mutate(
      filename,
      "UPDATE actions SET lease_owner = 'instance-b' WHERE id = ?",
      actionId,
    );

    expect(() => store.cancelActiveTask(cancelRequest())).toThrowError(
      /action_persistence_failed/,
    );
    expect(store.getTask(taskId)).toMatchObject({
      state: "RUNNING",
      leaseOwner: "instance-a",
    });
    expect(
      rows<{ state: string; leaseOwner: string }>(
        filename,
        `SELECT state, lease_owner AS leaseOwner FROM actions WHERE id = '${actionId}'`,
      ),
    ).toEqual([{ state: "DISPATCHING", leaseOwner: "instance-b" }]);
    expect(
      rows<{ controls: number; transitions: number }>(
        filename,
        `SELECT
           (SELECT COUNT(*) FROM control_events) AS controls,
           (SELECT COUNT(*) FROM action_transitions) AS transitions`,
      ),
    ).toEqual([{ controls: 0, transitions: 4 }]);
  });

  it("fails closed before recording cancellation when an UNKNOWN action audit ledger is corrupt", async () => {
    const { filename, runtimeDir, store } = await storeFixture();
    seedPrincipal(filename);
    const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
    claimAndRun(store, taskId);
    const actionId = seedAction(filename, taskId, "UNKNOWN");
    mutate(
      filename,
      `INSERT INTO action_attempts(
         id, action_id, attempt_id, phase, attempt_kind, outcome,
         request_digest, created_at
       ) VALUES (?, ?, ?, 'STARTED', 'RECONCILE', NULL, ?, ?)`,
      randomUUID(),
      actionId,
      randomUUID(),
      `sha256:${"d".repeat(64)}`,
      at(1).toISOString(),
    );

    expect(() => store.cancelActiveTask(cancelRequest())).toThrowError(
      /action_persistence_failed/,
    );
    expect(store.getTask(taskId)).toMatchObject({
      state: "RUNNING",
      leaseOwner: "instance-a",
    });
    expect(
      rows<{ state: string }>(
        filename,
        `SELECT state FROM actions WHERE id = '${actionId}'`,
      ),
    ).toEqual([{ state: "UNKNOWN" }]);
    expect(
      rows<{ count: number }>(
        filename,
        "SELECT COUNT(*) AS count FROM control_events",
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("rolls back without a control row for missing or mismatched principals", async () => {
    const { filename, store } = await storeFixture();
    expect(() => store.cancelActiveTask(cancelRequest())).toThrowError(
      /cancel_principal_not_authorized/,
    );
    seedPrincipal(filename);
    expect(() =>
      store.cancelActiveTask(
        cancelRequest({ senderOpenId: "ou_not_the_president" }),
      ),
    ).toThrowError(/cancel_principal_not_authorized/);
    expect(
      rows<{ count: number }>(
        filename,
        "SELECT COUNT(*) AS count FROM control_events",
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("rejects replay drift and exact-snapshot/prototype-polluted requests", async () => {
    const { filename, store } = await storeFixture();
    seedPrincipal(filename);
    const request = cancelRequest();
    store.cancelActiveTask(request);
    for (const drifted of [
      { ...request, messageId: "changed" },
      { ...request, senderOpenId: "ou_changed" },
      { ...request, chatId: "oc_changed" },
      { ...request, receivedAt: at(51).toISOString() },
    ]) {
      expect(() => store.cancelActiveTask(drifted)).toThrowError(
        /cancel_control_replay_conflict/,
      );
    }

    const getter = vi.fn(() => request.appId);
    const accessor = { ...request };
    Object.defineProperty(accessor, "appId", { enumerable: true, get: getter });
    expect(() => store.cancelActiveTask(accessor)).toThrowError(
      /cancel_request_must_be_own_data_properties/,
    );
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      store.cancelActiveTask(
        Object.assign(Object.create({ inherited: true }), request),
      ),
    ).toThrowError(/cancel_request_must_be_own_data_properties/);
    expect(() =>
      store.cancelActiveTask({
        ...request,
        [Symbol("polluted")]: true,
      }),
    ).toThrowError(/cancel_request_must_be_own_data_properties/);
    expect(() =>
      store.cancelActiveTask(new Proxy({ ...request }, {})),
    ).toThrowError(/cancel_request_must_be_own_data_properties/);
  });
});
