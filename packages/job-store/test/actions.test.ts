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
  type DatabaseFileLock,
  type JobStore,
} from "../src/index.js";
import { claimApprovedAction as claimApprovedActionOnDatabase } from "../src/actions.js";

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
  return new Date(Date.UTC(2026, 6, 22, 8, 0, seconds));
}

function event(): InboundEvent {
  return {
    appId: "cli_test_app",
    tenantKey: "tenant_test_001",
    eventId: "event_1",
    messageId: "message_1",
    senderOpenId: "ou_synthetic_president",
    chatId: "oc_synthetic_private_chat",
    chatType: "p2p",
    eventType: "im.message.receive_v1",
    receivedAt: at(0).toISOString(),
    payloadRef: `sha256:${"a".repeat(64)}`,
  };
}

function workspace(runtimeDir: string): string {
  const jobs = join(runtimeDir, "jobs");
  mkdirSync(jobs, { recursive: true, mode: 0o700 });
  const path = join(jobs, randomUUID());
  mkdirSync(path, { mode: 0o700 });
  return path;
}

async function storeFixture(
  options: {
    acquireLease?: boolean;
    startTask?: boolean;
    taskTtlMs?: number;
  } = {},
): Promise<{
  filename: string;
  store: JobStore;
  taskId: string;
}> {
  const runtimeDir = mkdtempSync(
    join(realpathSync(tmpdir()), "job-store-actions-"),
  );
  chmodSync(runtimeDir, 0o700);
  temporaryPaths.push(runtimeDir);
  const lock = await acquireDatabaseFileLock(runtimeDir);
  fileLocks.push(lock);
  const filename = join(runtimeDir, "assistant.sqlite");
  const store = openJobStore({
    filename,
    instanceId: "instance-a",
    lock,
  });
  openStores.push(store);
  const { taskId } = store.ingestEvent(event(), workspace(runtimeDir));
  if (options.acquireLease !== false) {
    expect(
      store.acquireRuntimeLease("bridge", "instance-a", at(1), 3_600_000),
    ).toBe(true);
    if (options.startTask !== false) {
      expect(
        store.claimNextTask("instance-a", at(2), options.taskTtlMs ?? 3_600_000)
          ?.id,
      ).toBe(taskId);
      expect(
        store.markRunning({
          taskId,
          owner: "instance-a",
          codexSessionId: "codex-session-actions",
          now: at(3),
          ttlMs: options.taskTtlMs ?? 3_600_000,
        }),
      ).toMatchObject({ id: taskId, state: "RUNNING" });
    }
  }
  return { filename, store, taskId };
}

function mutate(filename: string, sql: string, ...parameters: unknown[]): void {
  const database = new Database(filename);
  try {
    database.prepare(sql).run(...parameters);
  } finally {
    database.close();
  }
}

function rows<T>(filename: string, sql: string, ...parameters: unknown[]): T[] {
  const database = new Database(filename, { readonly: true });
  try {
    return database.prepare(sql).all(...parameters) as T[];
  } finally {
    database.close();
  }
}

type ActionStore = Omit<
  JobStore,
  | "prepareAction"
  | "approveAction"
  | "claimApprovedAction"
  | "getAction"
  | "listUnknownActions"
  | "markDispatching"
  | "finishAction"
  | "startReconciliation"
  | "reconcileAction"
> & {
  prepareAction(input: {
    taskId: string;
    capability: string;
    identity: "bot" | "user";
    payload: unknown;
    preview: unknown;
    now: Date;
  }): {
    actionId: string;
    version: 1;
    payloadHash: string;
    nonce: string;
    expiresAt: string;
    state: "PREPARED";
  };
  approveAction(input: {
    actionId: string;
    version: 1;
    actionPayloadHash: string;
    nonce: string;
    decision: "approve" | "reject";
    actorOpenId: string;
    chatId: string;
    now: Date;
  }): { actionId: string; state: "APPROVED" | "FAILED" };
  claimApprovedAction(input: {
    actionId: string;
    version: 1;
    owner: string;
    now: Date;
    ttlMs: number;
  }): {
    actionId: string;
    version: 1;
    state: "CLAIMED";
    leaseExpiresAt: string;
  } | null;
  getAction(ref: { actionId: string; version: 1 }): {
    actionId: string;
    version: 1;
    state: string;
    payloadHash: string;
    leaseExpiresAt: string | null;
    result: {
      outcome: "SUCCEEDED" | "FAILED_DEFINITE" | "UNKNOWN" | "INDETERMINATE";
      remoteId?: string;
    } | null;
    payload: unknown;
    preview: unknown;
    capability: string;
    identity: "bot" | "user";
    approvalMode: "president" | "system_policy";
    taskId: string | null;
    controlEventId: string | null;
    expiresAt: string;
    idempotencyKey: string;
    reconcileOutcome: "SUCCEEDED" | "FAILED" | "INDETERMINATE" | null;
  } | null;
  listUnknownActions(): Array<{
    actionId: string;
    version: 1;
    state: "UNKNOWN";
  }>;
  startReconciliation(input: {
    actionId: string;
    version: 1;
    owner: string;
    now: Date;
    ttlMs: number;
    attemptId: string;
    requestDigest: string;
  }): { actionId: string; state: "UNKNOWN"; leaseExpiresAt: string } | null;
  markDispatching(input: {
    actionId: string;
    version: 1;
    owner: string;
    leaseExpiresAt: string;
    now: Date;
    attemptId: string;
    requestDigest: string;
  }): { actionId: string; state: "DISPATCHING" } | null;
  finishAction(input: {
    actionId: string;
    version: 1;
    owner: string;
    leaseExpiresAt: string;
    now: Date;
    attemptId: string;
    outcome: "SUCCEEDED" | "FAILED_DEFINITE" | "UNKNOWN";
    remoteId?: string;
  }): { actionId: string; state: "SUCCEEDED" | "FAILED" | "UNKNOWN" } | null;
  reconcileAction(input: {
    actionId: string;
    version: 1;
    owner: string;
    leaseExpiresAt: string;
    now: Date;
    attemptId: string;
    outcome: "SUCCEEDED" | "FAILED" | "INDETERMINATE";
    evidenceDigest: string;
    operatorKind: "automatic" | "manual";
    remoteId?: string;
  }): { actionId: string; state: "RECONCILED" } | null;
};

function actions(store: JobStore): ActionStore {
  return store as unknown as ActionStore;
}

function prepareInput(taskId: string) {
  return {
    taskId,
    capability: "message.send",
    identity: "user" as const,
    payload: { body: { text: "hello" }, recipients: ["ou_recipient"] },
    preview: { body: "hello", recipient: "ou_recipient" },
    now: at(10),
  };
}

function validApproval(prepared: {
  actionId: string;
  version: 1;
  payloadHash: string;
  nonce: string;
}) {
  return {
    actionId: prepared.actionId,
    version: prepared.version,
    actionPayloadHash: prepared.payloadHash,
    nonce: prepared.nonce,
    decision: "approve" as const,
    actorOpenId: "ou_synthetic_president",
    chatId: "oc_synthetic_private_chat",
    now: at(11),
  };
}

async function dispatchingFixture(): Promise<{
  filename: string;
  store: ActionStore;
  prepared: ReturnType<ActionStore["prepareAction"]>;
  leaseExpiresAt: string;
  attemptId: string;
  requestDigest: string;
}> {
  const { filename, store: rawStore, taskId } = await storeFixture();
  const store = actions(rawStore);
  const prepared = store.prepareAction(prepareInput(taskId));
  store.approveAction(validApproval(prepared));
  const claimed = store.claimApprovedAction({
    actionId: prepared.actionId,
    version: 1,
    owner: "instance-a",
    now: at(12),
    ttlMs: 60_000,
  });
  if (claimed === null) throw new Error("claim fixture failed");
  const attemptId = randomUUID();
  const requestDigest = `sha256:${"c".repeat(64)}`;
  const dispatching = store.markDispatching({
    actionId: prepared.actionId,
    version: 1,
    owner: "instance-a",
    leaseExpiresAt: claimed.leaseExpiresAt,
    now: at(13),
    attemptId,
    requestDigest,
  });
  if (dispatching === null) throw new Error("dispatch fixture failed");
  return {
    filename,
    store,
    prepared,
    leaseExpiresAt: claimed.leaseExpiresAt,
    attemptId,
    requestDigest,
  };
}

async function unknownFixture(): Promise<
  Awaited<ReturnType<typeof dispatchingFixture>>
> {
  const fixture = await dispatchingFixture();
  fixture.store.finishAction({
    actionId: fixture.prepared.actionId,
    version: 1,
    owner: "instance-a",
    leaseExpiresAt: fixture.leaseExpiresAt,
    now: at(14),
    attemptId: fixture.attemptId,
    outcome: "UNKNOWN",
  });
  return fixture;
}

describe("immutable action approvals", () => {
  it("creates a version-one preview with a callback-bound nonce", async () => {
    const { store, taskId } = await storeFixture();

    const prepared = actions(store).prepareAction(prepareInput(taskId));

    expect(prepared).toMatchObject({
      version: 1,
      state: "PREPARED",
      payloadHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      nonce: expect.any(String),
    });
    expect(prepared.nonce).not.toHaveLength(0);
    expect(prepared.expiresAt).toBe(at(10 + 30 * 60).toISOString());
  });

  it.each([
    ["wrong nonce", { nonce: "wrong" }],
    ["wrong actor", { actorOpenId: "ou_attacker" }],
    ["wrong chat", { chatId: "oc_other" }],
    ["changed payload", { actionPayloadHash: "sha256:changed" }],
    ["expired", { now: at(10 + 30 * 60) }],
  ])("rejects %s without granting approval", async (_name, patch) => {
    const { store, taskId } = await storeFixture();
    const prepared = actions(store).prepareAction(prepareInput(taskId));

    expect(() =>
      actions(store).approveAction({ ...validApproval(prepared), ...patch }),
    ).toThrow(/expired_or_changed/);
    expect(
      actions(store).getAction({
        actionId: prepared.actionId,
        version: prepared.version,
      })?.state,
    ).toBe(_name === "expired" ? "FAILED" : "PREPARED");
  });

  it("allows only the callback-bound reject to fail a pending preview", async () => {
    const { store, taskId } = await storeFixture();
    const prepared = actions(store).prepareAction(prepareInput(taskId));

    expect(
      actions(store).approveAction({
        ...validApproval(prepared),
        decision: "reject",
      }),
    ).toMatchObject({ actionId: prepared.actionId, state: "FAILED" });
    expect(
      actions(store).getAction({ actionId: prepared.actionId, version: 1 }),
    ).toMatchObject({ state: "FAILED" });
  });

  it("allows an approved action lease to be consumed once", async () => {
    const { store, taskId } = await storeFixture();
    const prepared = actions(store).prepareAction(prepareInput(taskId));
    actions(store).approveAction(validApproval(prepared));
    expect(
      store.acquireRuntimeLease("bridge", "instance-a", at(12), 1_000),
    ).toBe(true);

    const claimed = actions(store).claimApprovedAction({
      actionId: prepared.actionId,
      version: prepared.version,
      owner: "instance-a",
      now: at(13),
      ttlMs: 10_000,
    });
    expect(claimed).not.toBeNull();
    expect(
      actions(store).claimApprovedAction({
        actionId: prepared.actionId,
        version: prepared.version,
        owner: "instance-a",
        now: at(13),
        ttlMs: 1_000,
      }),
    ).toBeNull();
  });

  it("fences a stale action lease after the bridge runtime lease expires", async () => {
    const { store, taskId } = await storeFixture();
    const prepared = actions(store).prepareAction(prepareInput(taskId));
    actions(store).approveAction(validApproval(prepared));
    expect(
      store.acquireRuntimeLease("bridge", "instance-a", at(12), 10_000),
    ).toBe(true);
    const claimed = actions(store).claimApprovedAction({
      actionId: prepared.actionId,
      version: 1,
      owner: "instance-a",
      now: at(13),
      ttlMs: 10_000,
    });
    if (claimed === null) throw new Error("claim fixture failed");

    expect(() =>
      actions(store).markDispatching({
        actionId: prepared.actionId,
        version: 1,
        owner: "instance-a",
        leaseExpiresAt: claimed.leaseExpiresAt,
        now: at(23),
        attemptId: randomUUID(),
        requestDigest: `sha256:${"b".repeat(64)}`,
      }),
    ).toThrow(/bridge_runtime_lease_is_not_live/);
  });

  it("appends one STARTED and one FINISHED attempt and stores only a minimal result", async () => {
    const { store, taskId } = await storeFixture();
    const prepared = actions(store).prepareAction(prepareInput(taskId));
    actions(store).approveAction(validApproval(prepared));
    expect(
      store.acquireRuntimeLease("bridge", "instance-a", at(12), 10_000),
    ).toBe(true);
    const claimed = actions(store).claimApprovedAction({
      actionId: prepared.actionId,
      version: 1,
      owner: "instance-a",
      now: at(13),
      ttlMs: 10_000,
    });
    if (claimed === null) throw new Error("claim fixture failed");
    const attemptId = randomUUID();

    expect(
      actions(store).markDispatching({
        actionId: prepared.actionId,
        version: 1,
        owner: "instance-a",
        leaseExpiresAt: claimed.leaseExpiresAt,
        now: at(14),
        attemptId,
        requestDigest: `sha256:${"c".repeat(64)}`,
      }),
    ).toMatchObject({ state: "DISPATCHING" });
    expect(
      actions(store).finishAction({
        actionId: prepared.actionId,
        version: 1,
        owner: "instance-a",
        leaseExpiresAt: claimed.leaseExpiresAt,
        now: at(15),
        attemptId,
        outcome: "SUCCEEDED",
        remoteId: "message_123",
      }),
    ).toMatchObject({ state: "SUCCEEDED" });
    expect(
      actions(store).getAction({ actionId: prepared.actionId, version: 1 }),
    ).toMatchObject({
      state: "SUCCEEDED",
      result: { outcome: "SUCCEEDED", remoteId: "message_123" },
    });
    expect(
      actions(store).finishAction({
        actionId: prepared.actionId,
        version: 1,
        owner: "instance-a",
        leaseExpiresAt: claimed.leaseExpiresAt,
        now: at(16),
        attemptId,
        outcome: "SUCCEEDED",
      }),
    ).toBeNull();
  });

  it("keeps UNKNOWN append-only until an explicit reconciliation", async () => {
    const { store, taskId } = await storeFixture();
    const prepared = actions(store).prepareAction(prepareInput(taskId));
    actions(store).approveAction(validApproval(prepared));
    expect(
      store.acquireRuntimeLease("bridge", "instance-a", at(12), 10_000),
    ).toBe(true);
    const claimed = actions(store).claimApprovedAction({
      actionId: prepared.actionId,
      version: 1,
      owner: "instance-a",
      now: at(13),
      ttlMs: 10_000,
    });
    if (claimed === null) throw new Error("claim fixture failed");
    const attemptId = randomUUID();
    actions(store).markDispatching({
      actionId: prepared.actionId,
      version: 1,
      owner: "instance-a",
      leaseExpiresAt: claimed.leaseExpiresAt,
      now: at(14),
      attemptId,
      requestDigest: `sha256:${"d".repeat(64)}`,
    });
    actions(store).finishAction({
      actionId: prepared.actionId,
      version: 1,
      owner: "instance-a",
      leaseExpiresAt: claimed.leaseExpiresAt,
      now: at(15),
      attemptId,
      outcome: "UNKNOWN",
    });

    expect(actions(store).listUnknownActions()).toEqual([
      expect.objectContaining({ actionId: prepared.actionId, version: 1 }),
    ]);
    const reconciliationAttemptId = randomUUID();
    const reconciliation = actions(store).startReconciliation({
      actionId: prepared.actionId,
      version: 1,
      owner: "instance-a",
      now: at(16),
      ttlMs: 1_000,
      attemptId: reconciliationAttemptId,
      requestDigest: `sha256:${"e".repeat(64)}`,
    });
    if (reconciliation === null)
      throw new Error("reconciliation fixture failed");
    expect(
      actions(store).reconcileAction({
        actionId: prepared.actionId,
        version: 1,
        owner: "instance-a",
        leaseExpiresAt: reconciliation.leaseExpiresAt,
        now: at(17),
        attemptId: reconciliationAttemptId,
        outcome: "INDETERMINATE",
        evidenceDigest: `sha256:${"f".repeat(64)}`,
        operatorKind: "manual",
      }),
    ).toMatchObject({ state: "RECONCILED" });
    expect(actions(store).listUnknownActions()).toEqual([]);
  });

  it("atomically supersedes a previous preview instead of re-versioning it", async () => {
    const { store, taskId } = await storeFixture();
    const first = actions(store).prepareAction(prepareInput(taskId));
    const nextInput = prepareInput(taskId);
    nextInput.payload = {
      body: { text: "changed" },
      recipients: ["ou_recipient"],
    };
    const second = actions(store).prepareAction(nextInput);

    expect(second.actionId).not.toBe(first.actionId);
    expect(second.version).toBe(1);
    expect(() => actions(store).approveAction(validApproval(first))).toThrow(
      /expired_or_changed/,
    );
    expect(
      actions(store).getAction({ actionId: first.actionId, version: 1 })?.state,
    ).toBe("FAILED");
  });

  it("atomically supersedes an APPROVED preview and makes the old claim unusable", async () => {
    const { filename, store, taskId } = await storeFixture();
    const first = actions(store).prepareAction(prepareInput(taskId));
    expect(actions(store).approveAction(validApproval(first))).toMatchObject({
      state: "APPROVED",
    });
    const nextInput = prepareInput(taskId);
    nextInput.payload = {
      body: { text: "changed after approval" },
      recipients: ["ou_recipient"],
    };
    nextInput.now = at(12);

    const second = actions(store).prepareAction(nextInput);

    expect(second).toMatchObject({ version: 1, state: "PREPARED" });
    expect(second.actionId).not.toBe(first.actionId);
    expect(
      actions(store).getAction({ actionId: first.actionId, version: 1 }),
    ).toMatchObject({ state: "FAILED" });
    expect(
      actions(store).claimApprovedAction({
        actionId: first.actionId,
        version: 1,
        owner: "instance-a",
        now: at(13),
        ttlMs: 1_000,
      }),
    ).toBeNull();
    expect(
      rows<{ decision: string }>(
        filename,
        "SELECT decision FROM approvals WHERE action_id = ? ORDER BY decided_at, id",
        first.actionId,
      ),
    ).toEqual(
      expect.arrayContaining([
        { decision: "APPROVED" },
        { decision: "INVALIDATED" },
      ]),
    );
  });

  it("refuses to supersede an action after it has been claimed", async () => {
    const { store, taskId } = await storeFixture();
    const first = actions(store).prepareAction(prepareInput(taskId));
    actions(store).approveAction(validApproval(first));
    expect(
      actions(store).claimApprovedAction({
        actionId: first.actionId,
        version: 1,
        owner: "instance-a",
        now: at(12),
        ttlMs: 1_000,
      }),
    ).toMatchObject({ state: "CLAIMED" });

    expect(() =>
      actions(store).prepareAction({
        ...prepareInput(taskId),
        payload: { changed: true },
        now: at(13),
      }),
    ).toThrow(/action_supersede_requires_recovery/);
    expect(
      actions(store).getAction({ actionId: first.actionId, version: 1 }),
    ).toMatchObject({ state: "CLAIMED" });
  });

  it("rejects hostile deep I-JSON snapshots before creating an action", async () => {
    const { store, taskId } = await storeFixture();
    const payload = { nested: { value: "safe" } } as {
      nested: { value: string | undefined };
    };
    payload.nested.value = undefined;

    expect(() =>
      actions(store).prepareAction({ ...prepareInput(taskId), payload }),
    ).toThrow(/action_payload_must_be_strict_i_json/);
    expect(() =>
      actions(store).prepareAction({
        ...prepareInput(taskId),
        payload: { number: Number.NaN },
      }),
    ).toThrow(/action_payload_must_be_strict_i_json/);
    const access = new Proxy(
      { value: "unread" },
      {
        get: () => {
          throw new Error("trap");
        },
      },
    );
    expect(() =>
      actions(store).prepareAction({
        ...prepareInput(taskId),
        payload: access,
      }),
    ).toThrow(/action_payload_must_be_strict_i_json/);
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() =>
      actions(store).prepareAction({ ...prepareInput(taskId), payload: cycle }),
    ).toThrow(/action_payload_must_be_strict_i_json/);
    const sparse = new Array<unknown>(2);
    sparse[1] = "sparse";
    expect(() =>
      actions(store).prepareAction({
        ...prepareInput(taskId),
        payload: sparse,
      }),
    ).toThrow(/action_payload_must_be_strict_i_json/);
    expect(() =>
      actions(store).prepareAction({
        ...prepareInput(taskId),
        payload: { value: "\ud800" },
      }),
    ).toThrow(/action_payload_must_be_strict_i_json/);
    expect(() =>
      actions(store).prepareAction({
        ...prepareInput(taskId),
        payload: { value: "safe", [Symbol("hidden")]: "no" },
      }),
    ).toThrow(/action_payload_must_be_strict_i_json/);
  });

  it("uses RFC 8785 key ordering and retains an immutable caller snapshot", async () => {
    const { store, taskId } = await storeFixture();
    const firstPayload = { z: [3, 2, 1], a: { b: true, a: "value" } };
    const first = actions(store).prepareAction({
      ...prepareInput(taskId),
      payload: firstPayload,
    });
    firstPayload.a.a = "changed after prepare";
    const firstRecord = actions(store).getAction({
      actionId: first.actionId,
      version: 1,
    });
    expect(firstRecord).toMatchObject({ payloadHash: first.payloadHash });
    expect(Object.isFrozen(firstRecord)).toBe(true);

    const second = actions(store).prepareAction({
      ...prepareInput(taskId),
      payload: { a: { a: "value", b: true }, z: [3, 2, 1] },
    });
    expect(second.payloadHash).toBe(first.payloadHash);
  });

  describe("repair-1 runtime and source binding", () => {
    it("requires a live bridge lease before prepare and approve", async () => {
      const withoutLease = await storeFixture({ acquireLease: false });
      expect(() =>
        actions(withoutLease.store).prepareAction(
          prepareInput(withoutLease.taskId),
        ),
      ).toThrow(/bridge_runtime_lease_is_not_live/);

      const { store, taskId } = await storeFixture();
      const prepared = actions(store).prepareAction(prepareInput(taskId));
      expect(store.releaseRuntimeLease("bridge", "instance-a")).toBe(true);
      expect(() =>
        actions(store).approveAction(validApproval(prepared)),
      ).toThrow(/bridge_runtime_lease_is_not_live/);
    });

    it("copies the immutable inbound sender and chat hashes into the action", async () => {
      const { filename, store, taskId } = await storeFixture();
      const prepared = actions(store).prepareAction(prepareInput(taskId));
      const [row] = rows<{
        actorHash: string;
        chatHash: string;
      }>(
        filename,
        `SELECT actor_open_id_hash AS actorHash, chat_id_hash AS chatHash
           FROM actions WHERE id = ?`,
        prepared.actionId,
      );
      expect(row).toEqual({
        actorHash: createHash("sha256")
          .update("ou_synthetic_president")
          .digest("hex"),
        chatHash: createHash("sha256")
          .update("oc_synthetic_private_chat")
          .digest("hex"),
      });
    });

    it.each(["missing", "corrupt hash"])(
      "fails closed on %s source identity evidence",
      async (failure) => {
        const { filename, store, taskId } = await storeFixture();
        if (failure === "missing") {
          mutate(filename, "DELETE FROM tasks WHERE id = ?", taskId);
        } else {
          mutate(filename, "DROP TRIGGER inbound_events_append_only_update");
          mutate(
            filename,
            "UPDATE inbound_events SET sender_open_id_hash = 'not-a-hash' WHERE id = (SELECT inbound_event_id FROM tasks WHERE id = ?)",
            taskId,
          );
        }
        expect(() =>
          actions(store).prepareAction(prepareInput(taskId)),
        ).toThrow(/action_source_identity_is_invalid/);
      },
    );
  });

  describe("repair-1 canonical records and persistence validation", () => {
    it("returns a full deeply frozen record backed by canonical payload bytes", async () => {
      const { filename, store, taskId } = await storeFixture();
      const input = prepareInput(taskId);
      const prepared = actions(store).prepareAction(input);
      const record = actions(store).getAction({
        actionId: prepared.actionId,
        version: 1,
      });
      expect(record).toMatchObject({
        capability: "message.send",
        identity: "user",
        approvalMode: "president",
        taskId,
        controlEventId: null,
        payload: input.payload,
        preview: input.preview,
        expiresAt: prepared.expiresAt,
        idempotencyKey: prepared.actionId,
        result: null,
        reconcileOutcome: null,
      });
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(record?.payload)).toBe(true);
      expect(Object.isFrozen((record?.payload as { body: unknown }).body)).toBe(
        true,
      );
      expect(
        rows<{ payloadJson: string; previewJson: string }>(
          filename,
          `SELECT payload_json AS payloadJson, preview_json AS previewJson
             FROM actions WHERE id = ?`,
          prepared.actionId,
        )[0],
      ).toEqual({
        payloadJson: '{"body":{"text":"hello"},"recipients":["ou_recipient"]}',
        previewJson: '{"body":"hello","recipient":"ou_recipient"}',
      });
    });

    it.each([
      [
        "noncanonical payload",
        "payload_json",
        '{"recipients":["ou_recipient"],"body":{"text":"hello"}}',
      ],
      ["payload hash mismatch", "payload_hash", `sha256:${"0".repeat(64)}`],
      ["malformed expiry", "expires_at", "2026-07-22"],
      ["malformed nonce hash", "nonce_hash", "short"],
    ])(
      "fails closed on %s persisted action evidence",
      async (_name, column, value) => {
        const { filename, store, taskId } = await storeFixture();
        const prepared = actions(store).prepareAction(prepareInput(taskId));
        mutate(filename, "DROP TRIGGER actions_frozen_payload");
        mutate(
          filename,
          `UPDATE actions SET ${column} = ? WHERE id = ?`,
          value,
          prepared.actionId,
        );
        expect(() =>
          actions(store).getAction({ actionId: prepared.actionId, version: 1 }),
        ).toThrow(/action_persistence_failed/);
      },
    );
  });

  describe("repair-1 claims, attempts and hostile outer inputs", () => {
    it("fails an approval that reaches its exact expiry before claim", async () => {
      const { store, taskId } = await storeFixture();
      const prepared = actions(store).prepareAction(prepareInput(taskId));
      actions(store).approveAction(validApproval(prepared));
      expect(
        actions(store).claimApprovedAction({
          actionId: prepared.actionId,
          version: 1 as const,
          owner: "instance-a",
          now: at(10 + 30 * 60),
          ttlMs: 1_000,
        }),
      ).toBeNull();
      expect(
        actions(store).getAction({ actionId: prepared.actionId, version: 1 }),
      ).toMatchObject({ state: "FAILED" });
    });

    it("rejects a finish attempt that has no matching STARTED row without state change", async () => {
      const fixture = await dispatchingFixture();
      expect(
        fixture.store.finishAction({
          actionId: fixture.prepared.actionId,
          version: 1 as const,
          owner: "instance-a",
          leaseExpiresAt: fixture.leaseExpiresAt,
          now: at(14),
          attemptId: randomUUID(),
          outcome: "SUCCEEDED",
          remoteId: "msg_123",
        }),
      ).toBeNull();
      expect(
        fixture.store.getAction({
          actionId: fixture.prepared.actionId,
          version: 1,
        }),
      ).toMatchObject({ state: "DISPATCHING", result: null });
    });

    it.each([
      ["UNKNOWN with remote id", "UNKNOWN", "msg_123"],
      ["remote id containing whitespace", "SUCCEEDED", "msg 123"],
      ["remote id containing a URL", "SUCCEEDED", "https://example.com/x"],
    ] as const)("rejects %s", async (_name, outcome, remoteId) => {
      const fixture = await dispatchingFixture();
      expect(() =>
        fixture.store.finishAction({
          actionId: fixture.prepared.actionId,
          version: 1,
          owner: "instance-a",
          leaseExpiresAt: fixture.leaseExpiresAt,
          now: at(14),
          attemptId: fixture.attemptId,
          outcome,
          remoteId,
        }),
      ).toThrow(/action_transition_input_is_invalid/);
      expect(
        fixture.store.getAction({
          actionId: fixture.prepared.actionId,
          version: 1,
        }),
      ).toMatchObject({ state: "DISPATCHING" });
    });

    it("rejects hostile outer finish input without invoking proxy traps", async () => {
      const fixture = await dispatchingFixture();
      let trapped = false;
      const input = new Proxy(
        {
          actionId: fixture.prepared.actionId,
          version: 1 as const,
          owner: "instance-a",
          leaseExpiresAt: fixture.leaseExpiresAt,
          now: at(14),
          attemptId: fixture.attemptId,
          outcome: "SUCCEEDED" as const,
        },
        {
          ownKeys() {
            trapped = true;
            throw new Error("must not inspect proxy");
          },
        },
      );
      expect(() => fixture.store.finishAction(input)).toThrow(
        /action_transition_input_is_invalid/,
      );
      expect(trapped).toBe(false);
    });

    it("rejects null and accessor outer finish inputs without reading business fields", async () => {
      const fixture = await dispatchingFixture();
      expect(() => fixture.store.finishAction(null as never)).toThrow(
        /action_transition_input_is_invalid/,
      );
      let reads = 0;
      const input = {
        actionId: fixture.prepared.actionId,
        version: 1,
        owner: "instance-a",
        leaseExpiresAt: fixture.leaseExpiresAt,
        now: at(14),
        attemptId: fixture.attemptId,
      };
      Object.defineProperty(input, "outcome", {
        enumerable: true,
        get() {
          reads += 1;
          return "SUCCEEDED";
        },
      });
      expect(() => fixture.store.finishAction(input as never)).toThrow(
        /action_transition_input_is_invalid/,
      );
      expect(reads).toBe(0);
    });

    it("writes matching STARTED and FINISHED audit rows with the original request digest", async () => {
      const fixture = await dispatchingFixture();
      fixture.store.finishAction({
        actionId: fixture.prepared.actionId,
        version: 1,
        owner: "instance-a",
        leaseExpiresAt: fixture.leaseExpiresAt,
        now: at(14),
        attemptId: fixture.attemptId,
        outcome: "SUCCEEDED",
        remoteId: "msg_123",
      });
      expect(
        rows<{
          phase: string;
          attemptKind: string;
          requestDigest: string;
        }>(
          fixture.filename,
          `SELECT phase, attempt_kind AS attemptKind,
                  request_digest AS requestDigest
             FROM action_attempts
            WHERE action_id = ? AND attempt_id = ? ORDER BY phase DESC`,
          fixture.prepared.actionId,
          fixture.attemptId,
        ),
      ).toEqual([
        {
          phase: "STARTED",
          attemptKind: "DISPATCH",
          requestDigest: fixture.requestDigest,
        },
        {
          phase: "FINISHED",
          attemptKind: "DISPATCH",
          requestDigest: fixture.requestDigest,
        },
      ]);
    });
  });

  describe("repair-1 reconciliation and claim CAS", () => {
    it("requires reconcile to finish the same STARTED attempt", async () => {
      const fixture = await unknownFixture();
      const reconciliationAttemptId = randomUUID();
      const started = fixture.store.startReconciliation({
        actionId: fixture.prepared.actionId,
        version: 1,
        owner: "instance-a",
        now: at(15),
        ttlMs: 10_000,
        attemptId: reconciliationAttemptId,
        requestDigest: `sha256:${"9".repeat(64)}`,
      });
      if (started === null) throw new Error("reconciliation fixture failed");
      expect(
        fixture.store.reconcileAction({
          actionId: fixture.prepared.actionId,
          version: 1,
          owner: "instance-a",
          leaseExpiresAt: started.leaseExpiresAt,
          now: at(16),
          attemptId: randomUUID(),
          outcome: "SUCCEEDED",
          evidenceDigest: `sha256:${"8".repeat(64)}`,
          operatorKind: "automatic",
        }),
      ).toBeNull();
      expect(
        fixture.store.getAction({
          actionId: fixture.prepared.actionId,
          version: 1,
        }),
      ).toMatchObject({ state: "UNKNOWN" });
    });

    it("rejects automatic INDETERMINATE reconciliation and retains UNKNOWN", async () => {
      const fixture = await unknownFixture();
      const attemptId = randomUUID();
      const started = fixture.store.startReconciliation({
        actionId: fixture.prepared.actionId,
        version: 1,
        owner: "instance-a",
        now: at(15),
        ttlMs: 10_000,
        attemptId,
        requestDigest: `sha256:${"7".repeat(64)}`,
      });
      if (started === null) throw new Error("reconciliation fixture failed");
      expect(() =>
        fixture.store.reconcileAction({
          actionId: fixture.prepared.actionId,
          version: 1,
          owner: "instance-a",
          leaseExpiresAt: started.leaseExpiresAt,
          now: at(16),
          attemptId,
          outcome: "INDETERMINATE",
          evidenceDigest: `sha256:${"6".repeat(64)}`,
          operatorKind: "automatic",
        }),
      ).toThrow(/action_transition_input_is_invalid/);
      expect(
        fixture.store.getAction({
          actionId: fixture.prepared.actionId,
          version: 1,
        }),
      ).toMatchObject({ state: "UNKNOWN" });
    });

    it("finishes reconciliation with the same attempt and mapped audit outcome", async () => {
      const fixture = await unknownFixture();
      const attemptId = randomUUID();
      const requestDigest = `sha256:${"5".repeat(64)}`;
      const started = fixture.store.startReconciliation({
        actionId: fixture.prepared.actionId,
        version: 1,
        owner: "instance-a",
        now: at(15),
        ttlMs: 10_000,
        attemptId,
        requestDigest,
      });
      if (started === null) throw new Error("reconciliation fixture failed");
      expect(
        fixture.store.reconcileAction({
          actionId: fixture.prepared.actionId,
          version: 1,
          owner: "instance-a",
          leaseExpiresAt: started.leaseExpiresAt,
          now: at(16),
          attemptId,
          outcome: "INDETERMINATE",
          evidenceDigest: `sha256:${"4".repeat(64)}`,
          operatorKind: "manual",
        }),
      ).toMatchObject({
        state: "RECONCILED",
        result: { outcome: "INDETERMINATE" },
        reconcileOutcome: "INDETERMINATE",
      });
      expect(
        rows<{
          phase: string;
          requestDigest: string;
          outcome: string | null;
        }>(
          fixture.filename,
          `SELECT phase, request_digest AS requestDigest, outcome
             FROM action_attempts
            WHERE action_id = ? AND attempt_id = ? ORDER BY phase DESC`,
          fixture.prepared.actionId,
          attemptId,
        ),
      ).toEqual([
        { phase: "STARTED", requestDigest, outcome: null },
        { phase: "FINISHED", requestDigest, outcome: "INDETERMINATE" },
      ]);
    });

    it("allows only one sequential raw SQLite claimant", async () => {
      const { filename, store, taskId } = await storeFixture();
      const prepared = actions(store).prepareAction(prepareInput(taskId));
      actions(store).approveAction(validApproval(prepared));
      const firstConnection = new Database(filename);
      const secondConnection = new Database(filename);
      try {
        const input = {
          actionId: prepared.actionId,
          version: 1 as const,
          owner: "instance-a",
          now: at(12),
          ttlMs: 10_000,
        };
        const claims = [
          claimApprovedActionOnDatabase(firstConnection, "instance-a", input),
          claimApprovedActionOnDatabase(secondConnection, "instance-a", input),
        ];
        expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
      } finally {
        firstConnection.close();
        secondConnection.close();
      }
      expect(
        rows<{ count: number }>(
          filename,
          `SELECT count(*) AS count FROM action_transitions
            WHERE action_id = ? AND from_state = 'APPROVED'
              AND to_state = 'CLAIMED'`,
          prepared.actionId,
        ),
      ).toEqual([{ count: 1 }]);
    });
  });

  describe("repair-2 parent task fencing", () => {
    it("allows a task-bound system reply while the acknowledged task is still RECEIVED", async () => {
      const { filename, store, taskId } = await storeFixture({
        startTask: false,
      });
      const actionId = randomUUID();
      const payloadJson = '{"body":{"type":"text","value":"ack"}}';
      const payloadDigest = createHash("sha256")
        .update(payloadJson)
        .digest("hex");
      mutate(
        filename,
        `INSERT INTO actions(
           id, task_id, version, capability, identity, approval_mode, state,
           payload_json, payload_hash, preview_json, actor_open_id_hash,
           chat_id_hash, nonce_hash, idempotency_key, expires_at,
           created_at, updated_at
         ) VALUES (?, ?, 1, 'system_reply', 'bot', 'system_policy', 'APPROVED',
                   ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        actionId,
        taskId,
        payloadJson,
        `sha256:${payloadDigest}`,
        payloadJson,
        createHash("sha256").update("ou_synthetic_president").digest("hex"),
        createHash("sha256").update("oc_synthetic_private_chat").digest("hex"),
        createHash("sha256").update(`nonce-${actionId}`).digest("hex"),
        actionId,
        at(60).toISOString(),
        at(4).toISOString(),
        at(4).toISOString(),
      );
      mutate(
        filename,
        `INSERT INTO action_transitions(
           action_id, from_state, to_state, reason_code, created_at
         ) VALUES (?, NULL, 'APPROVED', 'system_policy_approved', ?)`,
        actionId,
        at(4).toISOString(),
      );

      const claimed = actions(store).claimApprovedAction({
        actionId,
        version: 1,
        owner: "instance-a",
        now: at(5),
        ttlMs: 10_000,
      });
      expect(claimed).toMatchObject({
        state: "CLAIMED",
        approvalMode: "system_policy",
        taskId,
      });
      if (claimed === null) throw new Error("system reply claim failed");
      expect(
        actions(store).markDispatching({
          actionId,
          version: 1,
          owner: "instance-a",
          leaseExpiresAt: claimed.leaseExpiresAt,
          now: at(6),
          attemptId: randomUUID(),
          requestDigest: `sha256:${"9".repeat(64)}`,
        }),
      ).toMatchObject({ state: "DISPATCHING" });
    });

    it.each(["RECEIVED", "FAILED"] as const)(
      "refuses to prepare an action for a %s parent task",
      async (parentState) => {
        const fixture = await storeFixture({ startTask: false });
        if (parentState === "FAILED") {
          mutate(
            fixture.filename,
            "UPDATE tasks SET state = 'CLAIMED', lease_owner = 'instance-a', lease_expires_at = ?, updated_at = ? WHERE id = ?",
            at(100).toISOString(),
            at(2).toISOString(),
            fixture.taskId,
          );
          mutate(
            fixture.filename,
            "UPDATE tasks SET state = 'FAILED', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
            at(3).toISOString(),
            fixture.taskId,
          );
        }

        expect(() =>
          actions(fixture.store).prepareAction(prepareInput(fixture.taskId)),
        ).toThrow(/action_parent_task_is_not_executable/);
      },
    );

    it("atomically invalidates a prepared action when its running task fails", async () => {
      const { filename, store, taskId } = await storeFixture();
      const prepared = actions(store).prepareAction(prepareInput(taskId));

      expect(
        store.finishTask({
          taskId,
          owner: "instance-a",
          codexSessionId: "codex-session-actions",
          now: at(12),
          outcome: "FAILED",
        }),
      ).toMatchObject({ state: "FAILED" });
      expect(
        actions(store).getAction({ actionId: prepared.actionId, version: 1 }),
      ).toMatchObject({ state: "FAILED" });
      expect(
        rows<{ reasonCode: string }>(
          filename,
          `SELECT reason_code AS reasonCode FROM action_transitions
            WHERE action_id = ? AND from_state = 'PREPARED'
              AND to_state = 'FAILED'`,
          prepared.actionId,
        ),
      ).toEqual([{ reasonCode: "task_failed_invalidated" }]);
    });

    it("rolls back a backdated task failure instead of corrupting action timestamps", async () => {
      const { store, taskId } = await storeFixture();
      const prepared = actions(store).prepareAction(prepareInput(taskId));

      expect(() =>
        store.finishTask({
          taskId,
          owner: "instance-a",
          codexSessionId: "codex-session-actions",
          now: at(9),
          outcome: "FAILED",
        }),
      ).toThrow(/action_persistence_failed/);
      expect(store.getTask(taskId)).toMatchObject({ state: "RUNNING" });
      expect(
        actions(store).getAction({ actionId: prepared.actionId, version: 1 }),
      ).toMatchObject({ state: "PREPARED", updatedAt: at(10).toISOString() });
    });

    it("rejects an otherwise valid callback after the parent task becomes terminal", async () => {
      const { filename, store, taskId } = await storeFixture();
      const prepared = actions(store).prepareAction(prepareInput(taskId));
      mutate(
        filename,
        "UPDATE tasks SET state = 'FAILED', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
        at(11).toISOString(),
        taskId,
      );

      expect(() =>
        actions(store).approveAction(validApproval(prepared)),
      ).toThrow(/expired_or_changed/);
      expect(
        actions(store).getAction({ actionId: prepared.actionId, version: 1 }),
      ).toMatchObject({ state: "PREPARED" });
    });

    it("refuses to claim an approved action after the parent task becomes terminal", async () => {
      const { filename, store, taskId } = await storeFixture();
      const prepared = actions(store).prepareAction(prepareInput(taskId));
      actions(store).approveAction(validApproval(prepared));
      mutate(
        filename,
        "UPDATE tasks SET state = 'FAILED', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
        at(12).toISOString(),
        taskId,
      );

      expect(
        actions(store).claimApprovedAction({
          actionId: prepared.actionId,
          version: 1,
          owner: "instance-a",
          now: at(13),
          ttlMs: 10_000,
        }),
      ).toBeNull();
    });

    it("refuses to start dispatch after the parent task becomes terminal", async () => {
      const { filename, store, taskId } = await storeFixture();
      const prepared = actions(store).prepareAction(prepareInput(taskId));
      actions(store).approveAction(validApproval(prepared));
      const claimed = actions(store).claimApprovedAction({
        actionId: prepared.actionId,
        version: 1,
        owner: "instance-a",
        now: at(12),
        ttlMs: 10_000,
      });
      if (claimed === null) throw new Error("claim fixture failed");
      mutate(
        filename,
        "UPDATE tasks SET state = 'FAILED', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
        at(13).toISOString(),
        taskId,
      );

      expect(() =>
        actions(store).markDispatching({
          actionId: prepared.actionId,
          version: 1,
          owner: "instance-a",
          leaseExpiresAt: claimed.leaseExpiresAt,
          now: at(14),
          attemptId: randomUUID(),
          requestDigest: `sha256:${"1".repeat(64)}`,
        }),
      ).toThrow(/action_persistence_failed/);
    });
  });

  describe("repair-2 persisted semantic validation", () => {
    it.each([
      "idempotency key drift",
      "source hash drift",
      "lease on PREPARED",
      "result on PREPARED",
      "SUCCEEDED with UNKNOWN result",
      "RECONCILED outcome mismatch",
      "wrong approval window",
      "updated before created",
    ] as const)("fails closed on %s", async (corruption) => {
      const { filename, store, taskId } = await storeFixture();
      const prepared = actions(store).prepareAction(prepareInput(taskId));

      if (
        corruption === "idempotency key drift" ||
        corruption === "source hash drift" ||
        corruption === "wrong approval window"
      ) {
        mutate(filename, "DROP TRIGGER actions_frozen_payload");
      }
      if (
        corruption === "SUCCEEDED with UNKNOWN result" ||
        corruption === "RECONCILED outcome mismatch"
      ) {
        mutate(filename, "DROP TRIGGER actions_legal_state_transition");
      }

      switch (corruption) {
        case "idempotency key drift":
          mutate(
            filename,
            "UPDATE actions SET idempotency_key = ? WHERE id = ?",
            randomUUID(),
            prepared.actionId,
          );
          break;
        case "source hash drift":
          mutate(
            filename,
            "UPDATE actions SET actor_open_id_hash = ? WHERE id = ?",
            createHash("sha256").update("ou_other").digest("hex"),
            prepared.actionId,
          );
          break;
        case "lease on PREPARED":
          mutate(
            filename,
            "UPDATE actions SET lease_owner = 'instance-a', lease_expires_at = ? WHERE id = ?",
            at(100).toISOString(),
            prepared.actionId,
          );
          break;
        case "result on PREPARED":
          mutate(
            filename,
            `UPDATE actions SET result_json = '{"outcome":"UNKNOWN"}' WHERE id = ?`,
            prepared.actionId,
          );
          break;
        case "SUCCEEDED with UNKNOWN result":
          mutate(
            filename,
            `UPDATE actions SET state = 'SUCCEEDED', result_json = '{"outcome":"UNKNOWN"}' WHERE id = ?`,
            prepared.actionId,
          );
          break;
        case "RECONCILED outcome mismatch":
          mutate(
            filename,
            `UPDATE actions SET state = 'RECONCILED', reconcile_outcome = 'SUCCEEDED', result_json = '{"outcome":"INDETERMINATE"}' WHERE id = ?`,
            prepared.actionId,
          );
          break;
        case "wrong approval window":
          mutate(
            filename,
            "UPDATE actions SET expires_at = ? WHERE id = ?",
            at(10 + 29 * 60).toISOString(),
            prepared.actionId,
          );
          break;
        case "updated before created":
          mutate(
            filename,
            "UPDATE actions SET updated_at = ? WHERE id = ?",
            at(9).toISOString(),
            prepared.actionId,
          );
          break;
      }

      expect(() =>
        actions(store).getAction({ actionId: prepared.actionId, version: 1 }),
      ).toThrow(/action_persistence_failed/);
    });

    it("fails closed when a claimed action lease owner drifts from its running task", async () => {
      const { filename, store, taskId } = await storeFixture();
      const prepared = actions(store).prepareAction(prepareInput(taskId));
      actions(store).approveAction(validApproval(prepared));
      expect(
        actions(store).claimApprovedAction({
          actionId: prepared.actionId,
          version: 1,
          owner: "instance-a",
          now: at(12),
          ttlMs: 10_000,
        }),
      ).not.toBeNull();
      mutate(
        filename,
        "UPDATE actions SET lease_owner = 'instance-b' WHERE id = ?",
        prepared.actionId,
      );

      expect(() =>
        actions(store).getAction({ actionId: prepared.actionId, version: 1 }),
      ).toThrow(/action_persistence_failed/);
    });

    it("rolls task failure back when an active action ledger is corrupted", async () => {
      const { filename, store, taskId } = await storeFixture();
      const prepared = actions(store).prepareAction(prepareInput(taskId));
      mutate(filename, "DROP TRIGGER actions_frozen_payload");
      mutate(
        filename,
        "UPDATE actions SET idempotency_key = ? WHERE id = ?",
        randomUUID(),
        prepared.actionId,
      );

      expect(() =>
        store.finishTask({
          taskId,
          owner: "instance-a",
          codexSessionId: "codex-session-actions",
          now: at(12),
          outcome: "FAILED",
        }),
      ).toThrow(/action_persistence_failed/);
      expect(store.getTask(taskId)).toMatchObject({ state: "RUNNING" });
      expect(
        rows<{ state: string }>(
          filename,
          "SELECT state FROM actions WHERE id = ?",
          prepared.actionId,
        ),
      ).toEqual([{ state: "PREPARED" }]);
      expect(
        rows<{ count: number }>(
          filename,
          "SELECT COUNT(*) AS count FROM action_transitions",
        ),
      ).toEqual([{ count: 1 }]);
    });
  });

  describe("repair-4 append-only audit consistency", () => {
    it("fails closed when a PREPARED action loses its transition history", async () => {
      const { filename, store, taskId } = await storeFixture();
      const prepared = actions(store).prepareAction(prepareInput(taskId));
      mutate(filename, "DROP TRIGGER action_transitions_append_only_delete");
      mutate(
        filename,
        "DELETE FROM action_transitions WHERE action_id = ?",
        prepared.actionId,
      );

      expect(() =>
        actions(store).getAction({ actionId: prepared.actionId, version: 1 }),
      ).toThrow(/action_persistence_failed/);
    });

    it("fails closed when an APPROVED action loses its approval evidence", async () => {
      const { filename, store, taskId } = await storeFixture();
      const prepared = actions(store).prepareAction(prepareInput(taskId));
      actions(store).approveAction(validApproval(prepared));
      mutate(filename, "DROP TRIGGER approvals_append_only_delete");
      mutate(
        filename,
        "DELETE FROM approvals WHERE action_id = ?",
        prepared.actionId,
      );

      expect(() =>
        actions(store).getAction({ actionId: prepared.actionId, version: 1 }),
      ).toThrow(/action_persistence_failed/);
    });

    it("rejects a DISPATCHING action without STARTED evidence and rolls task failure back", async () => {
      const fixture = await dispatchingFixture();
      mutate(
        fixture.filename,
        "DROP TRIGGER action_attempts_append_only_delete",
      );
      mutate(
        fixture.filename,
        "DELETE FROM action_attempts WHERE action_id = ? AND phase = 'STARTED'",
        fixture.prepared.actionId,
      );

      expect(() =>
        fixture.store.getAction({
          actionId: fixture.prepared.actionId,
          version: 1,
        }),
      ).toThrow(/action_persistence_failed/);
      expect(() =>
        fixture.store.finishTask({
          taskId:
            rows<{ taskId: string }>(
              fixture.filename,
              "SELECT task_id AS taskId FROM actions WHERE id = ?",
              fixture.prepared.actionId,
            )[0]?.taskId ?? "missing",
          owner: "instance-a",
          codexSessionId: "codex-session-actions",
          now: at(14),
          outcome: "FAILED",
        }),
      ).toThrow(/action_persistence_failed/);
      expect(
        rows<{ state: string }>(
          fixture.filename,
          "SELECT state FROM actions WHERE id = ?",
          fixture.prepared.actionId,
        ),
      ).toEqual([{ state: "DISPATCHING" }]);
    });

    it("rejects a future STARTED attempt instead of consuming it", async () => {
      const fixture = await dispatchingFixture();
      mutate(
        fixture.filename,
        "DROP TRIGGER action_attempts_append_only_update",
      );
      mutate(
        fixture.filename,
        "UPDATE action_attempts SET created_at = ? WHERE action_id = ? AND attempt_id = ? AND phase = 'STARTED'",
        at(15).toISOString(),
        fixture.prepared.actionId,
        fixture.attemptId,
      );

      expect(() =>
        fixture.store.finishAction({
          actionId: fixture.prepared.actionId,
          version: 1,
          owner: "instance-a",
          leaseExpiresAt: fixture.leaseExpiresAt,
          now: at(14),
          attemptId: fixture.attemptId,
          outcome: "SUCCEEDED",
        }),
      ).toThrow(/action_persistence_failed/);
      expect(
        rows<{ state: string }>(
          fixture.filename,
          "SELECT state FROM actions WHERE id = ?",
          fixture.prepared.actionId,
        ),
      ).toEqual([{ state: "DISPATCHING" }]);
    });

    it("refuses to finish reconciliation with an older expired STARTED attempt", async () => {
      const fixture = await unknownFixture();
      const oldAttemptId = randomUUID();
      const oldClaim = fixture.store.startReconciliation({
        actionId: fixture.prepared.actionId,
        version: 1,
        owner: "instance-a",
        now: at(15),
        ttlMs: 1,
        attemptId: oldAttemptId,
        requestDigest: `sha256:${"7".repeat(64)}`,
      });
      if (oldClaim === null) throw new Error("old reconciliation claim failed");
      const currentAttemptId = randomUUID();
      const currentClaim = fixture.store.startReconciliation({
        actionId: fixture.prepared.actionId,
        version: 1,
        owner: "instance-a",
        now: at(17),
        ttlMs: 1_000,
        attemptId: currentAttemptId,
        requestDigest: `sha256:${"8".repeat(64)}`,
      });
      if (currentClaim === null)
        throw new Error("current reconciliation claim failed");

      expect(
        fixture.store.reconcileAction({
          actionId: fixture.prepared.actionId,
          version: 1,
          owner: "instance-a",
          leaseExpiresAt: currentClaim.leaseExpiresAt,
          now: at(18),
          attemptId: oldAttemptId,
          outcome: "FAILED",
          evidenceDigest: `sha256:${"9".repeat(64)}`,
          operatorKind: "manual",
        }),
      ).toBeNull();
      expect(
        fixture.store.getAction({
          actionId: fixture.prepared.actionId,
          version: 1,
        }),
      ).toMatchObject({ state: "UNKNOWN", leaseOwner: "instance-a" });
      expect(
        fixture.store.reconcileAction({
          actionId: fixture.prepared.actionId,
          version: 1,
          owner: "instance-a",
          leaseExpiresAt: currentClaim.leaseExpiresAt,
          now: at(18),
          attemptId: currentAttemptId,
          outcome: "FAILED",
          evidenceDigest: `sha256:${"a".repeat(64)}`,
          operatorKind: "manual",
        }),
      ).toMatchObject({ state: "RECONCILED", reconcileOutcome: "FAILED" });
    });

    it("fails closed when a RECONCILED action loses its reconciliation evidence", async () => {
      const fixture = await unknownFixture();
      const attemptId = randomUUID();
      const claim = fixture.store.startReconciliation({
        actionId: fixture.prepared.actionId,
        version: 1,
        owner: "instance-a",
        now: at(15),
        ttlMs: 1_000,
        attemptId,
        requestDigest: `sha256:${"a".repeat(64)}`,
      });
      if (claim === null) throw new Error("reconciliation claim failed");
      fixture.store.reconcileAction({
        actionId: fixture.prepared.actionId,
        version: 1,
        owner: "instance-a",
        leaseExpiresAt: claim.leaseExpiresAt,
        now: at(16),
        attemptId,
        outcome: "FAILED",
        evidenceDigest: `sha256:${"b".repeat(64)}`,
        operatorKind: "manual",
      });
      mutate(
        fixture.filename,
        "DROP TRIGGER reconciliations_append_only_delete",
      );
      mutate(
        fixture.filename,
        "DELETE FROM reconciliations WHERE action_id = ?",
        fixture.prepared.actionId,
      );

      expect(() =>
        fixture.store.getAction({
          actionId: fixture.prepared.actionId,
          version: 1,
        }),
      ).toThrow(/action_persistence_failed/);
    });

    it("fails closed on an impossible automatic INDETERMINATE reconciliation ledger", async () => {
      const fixture = await unknownFixture();
      const attemptId = randomUUID();
      const claim = fixture.store.startReconciliation({
        actionId: fixture.prepared.actionId,
        version: 1,
        owner: "instance-a",
        now: at(15),
        ttlMs: 1_000,
        attemptId,
        requestDigest: `sha256:${"c".repeat(64)}`,
      });
      if (claim === null) throw new Error("reconciliation claim failed");
      fixture.store.reconcileAction({
        actionId: fixture.prepared.actionId,
        version: 1,
        owner: "instance-a",
        leaseExpiresAt: claim.leaseExpiresAt,
        now: at(16),
        attemptId,
        outcome: "INDETERMINATE",
        evidenceDigest: `sha256:${"d".repeat(64)}`,
        operatorKind: "manual",
      });
      mutate(
        fixture.filename,
        "DROP TRIGGER reconciliations_append_only_update",
      );
      mutate(
        fixture.filename,
        "UPDATE reconciliations SET operator_kind = 'automatic' WHERE action_id = ?",
        fixture.prepared.actionId,
      );

      expect(() =>
        fixture.store.getAction({
          actionId: fixture.prepared.actionId,
          version: 1,
        }),
      ).toThrow(/action_persistence_failed/);
    });
  });

  describe("repair-2 reconciliation evidence and owner fencing", () => {
    it("persists a reconciled success remote id in the action and FINISHED attempt", async () => {
      const fixture = await unknownFixture();
      const attemptId = randomUUID();
      const started = fixture.store.startReconciliation({
        actionId: fixture.prepared.actionId,
        version: 1,
        owner: "instance-a",
        now: at(15),
        ttlMs: 10_000,
        attemptId,
        requestDigest: `sha256:${"2".repeat(64)}`,
      });
      if (started === null) throw new Error("reconciliation fixture failed");

      expect(
        fixture.store.reconcileAction({
          actionId: fixture.prepared.actionId,
          version: 1,
          owner: "instance-a",
          leaseExpiresAt: started.leaseExpiresAt,
          now: at(16),
          attemptId,
          outcome: "SUCCEEDED",
          evidenceDigest: `sha256:${"3".repeat(64)}`,
          operatorKind: "automatic",
          remoteId: "message_reconciled_123",
        }),
      ).toMatchObject({
        state: "RECONCILED",
        remoteId: "message_reconciled_123",
        result: {
          outcome: "SUCCEEDED",
          remoteId: "message_reconciled_123",
        },
      });
      expect(
        rows<{ actionRemoteId: string; attemptRemoteId: string }>(
          fixture.filename,
          `SELECT actions.remote_id AS actionRemoteId,
                  action_attempts.remote_id AS attemptRemoteId
             FROM actions
             JOIN action_attempts ON action_attempts.action_id = actions.id
            WHERE actions.id = ? AND action_attempts.attempt_id = ?
              AND action_attempts.phase = 'FINISHED'`,
          fixture.prepared.actionId,
          attemptId,
        ),
      ).toEqual([
        {
          actionRemoteId: "message_reconciled_123",
          attemptRemoteId: "message_reconciled_123",
        },
      ]);
    });

    it.each(["FAILED", "INDETERMINATE"] as const)(
      "rejects a remote id for %s reconciliation",
      async (outcome) => {
        const fixture = await unknownFixture();
        const attemptId = randomUUID();
        const started = fixture.store.startReconciliation({
          actionId: fixture.prepared.actionId,
          version: 1,
          owner: "instance-a",
          now: at(15),
          ttlMs: 10_000,
          attemptId,
          requestDigest: `sha256:${"4".repeat(64)}`,
        });
        if (started === null) throw new Error("reconciliation fixture failed");

        expect(() =>
          fixture.store.reconcileAction({
            actionId: fixture.prepared.actionId,
            version: 1,
            owner: "instance-a",
            leaseExpiresAt: started.leaseExpiresAt,
            now: at(16),
            attemptId,
            outcome,
            evidenceDigest: `sha256:${"5".repeat(64)}`,
            operatorKind: "manual",
            remoteId: "must_not_persist",
          }),
        ).toThrow(/action_transition_input_is_invalid/);
      },
    );

    it.each(["mark", "finish", "reconcile"] as const)(
      "rejects a forged non-instance owner before %s",
      async (operation) => {
        if (operation === "reconcile") {
          const fixture = await unknownFixture();
          const attemptId = randomUUID();
          const started = fixture.store.startReconciliation({
            actionId: fixture.prepared.actionId,
            version: 1,
            owner: "instance-a",
            now: at(15),
            ttlMs: 10_000,
            attemptId,
            requestDigest: `sha256:${"6".repeat(64)}`,
          });
          if (started === null)
            throw new Error("reconciliation fixture failed");
          mutate(
            fixture.filename,
            "UPDATE actions SET lease_owner = 'instance-b' WHERE id = ?",
            fixture.prepared.actionId,
          );
          expect(
            fixture.store.reconcileAction({
              actionId: fixture.prepared.actionId,
              version: 1,
              owner: "instance-b",
              leaseExpiresAt: started.leaseExpiresAt,
              now: at(16),
              attemptId,
              outcome: "FAILED",
              evidenceDigest: `sha256:${"7".repeat(64)}`,
              operatorKind: "automatic",
            }),
          ).toBeNull();
          return;
        }

        const fixture = await dispatchingFixture();
        mutate(
          fixture.filename,
          "UPDATE actions SET lease_owner = 'instance-b' WHERE id = ?",
          fixture.prepared.actionId,
        );
        if (operation === "finish") {
          expect(
            fixture.store.finishAction({
              actionId: fixture.prepared.actionId,
              version: 1,
              owner: "instance-b",
              leaseExpiresAt: fixture.leaseExpiresAt,
              now: at(14),
              attemptId: fixture.attemptId,
              outcome: "FAILED_DEFINITE",
            }),
          ).toBeNull();
          return;
        }

        mutate(fixture.filename, "DROP TRIGGER actions_legal_state_transition");
        mutate(
          fixture.filename,
          "UPDATE actions SET state = 'CLAIMED' WHERE id = ?",
          fixture.prepared.actionId,
        );
        expect(
          fixture.store.markDispatching({
            actionId: fixture.prepared.actionId,
            version: 1,
            owner: "instance-b",
            leaseExpiresAt: fixture.leaseExpiresAt,
            now: at(14),
            attemptId: randomUUID(),
            requestDigest: `sha256:${"8".repeat(64)}`,
          }),
        ).toBeNull();
      },
    );
  });
});
