import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { InboundEvent } from "@executive-assistant/contracts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

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
  sequence: number,
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

function workspace(runtimeDir: string, taskId = randomUUID()): string {
  const jobs = join(runtimeDir, "jobs");
  mkdirSync(jobs, { recursive: true, mode: 0o700 });
  const path = join(jobs, taskId);
  mkdirSync(path, { mode: 0o700 });
  return path;
}

async function stores(): Promise<{
  filename: string;
  runtimeDir: string;
  first: JobStore;
  second: JobStore;
}> {
  const runtimeDir = mkdtempSync(
    join(realpathSync(tmpdir()), "job-store-leases-"),
  );
  chmodSync(runtimeDir, 0o700);
  temporaryPaths.push(runtimeDir);
  const filename = join(runtimeDir, "assistant.sqlite");
  const lock = await acquireDatabaseFileLock(runtimeDir);
  fileLocks.push(lock);
  const first = openJobStore({ filename, instanceId: "instance-a", lock });
  const second = openJobStore({ filename, instanceId: "instance-b", lock });
  openStores.push(first, second);
  return { filename, runtimeDir, first, second };
}

function acknowledgeNext(store: JobStore, now: Date): void {
  const acknowledgement = store.beginNextTaskAcknowledgement({
    owner: "instance-a",
    now,
  });
  expect(acknowledgement).not.toBeNull();
  expect(
    store.finishTaskAcknowledgement({
      taskId: acknowledgement!.taskId,
      owner: "instance-a",
      now,
      state: "ACKNOWLEDGED",
      failureClass: null,
    }),
  ).toMatchObject({ state: "ACKNOWLEDGED" });
}

describe("runtime leases", () => {
  it("excludes a second owner, treats equality as live, and permits strict-expiry takeover", async () => {
    const { first, second } = await stores();

    expect(
      first.acquireRuntimeLease("bridge", "instance-a", at(0), 1_000),
    ).toBe(true);
    expect(
      second.acquireRuntimeLease("bridge", "instance-b", at(999), 1_000),
    ).toBe(false);
    expect(
      second.acquireRuntimeLease("bridge", "instance-b", at(1_000), 1_000),
    ).toBe(false);
    expect(
      second.acquireRuntimeLease("bridge", "instance-b", at(1_001), 1_000),
    ).toBe(true);
  });

  it("renews from now and releases only its own live identity", async () => {
    const { first, second } = await stores();

    expect(
      first.acquireRuntimeLease("bridge", "instance-a", at(0), 1_000),
    ).toBe(true);
    expect(
      first.acquireRuntimeLease("bridge", "instance-a", at(500), 2_000),
    ).toBe(true);
    expect(first.releaseRuntimeLease("bridge", "not-instance-a")).toBe(false);
    expect(second.releaseRuntimeLease("bridge", "instance-b")).toBe(false);
    expect(first.releaseRuntimeLease("bridge", "instance-a")).toBe(true);
    expect(
      second.acquireRuntimeLease("bridge", "instance-b", at(501), 1_000),
    ).toBe(true);
  });

  it("rejects invalid clocks and TTLs and fails closed on malformed persisted lease time", async () => {
    const { filename, first } = await stores();

    expect(() =>
      first.acquireRuntimeLease(
        "bridge",
        "instance-a",
        new Date(Number.NaN),
        1,
      ),
    ).toThrowError(RuntimeStateError);
    for (const ttl of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(() =>
        first.acquireRuntimeLease("bridge", "instance-a", at(0), ttl),
      ).toThrowError(RuntimeStateError);
    }

    const setup = new Database(filename);
    setup
      .prepare(
        "INSERT INTO runtime_leases(name, owner, expires_at, updated_at) VALUES ('bridge', 'instance-a', 'bad', 'bad')",
      )
      .run();
    setup.close();
    expect(() =>
      first.acquireRuntimeLease("bridge", "instance-a", at(1), 1_000),
    ).toThrowError(/runtime_lease_persistence_failed/);
  });
});

describe("task claiming", () => {
  it("allows only one claim across two handles with the same instance identity", async () => {
    const { filename, runtimeDir, first } = await stores();
    const lock = fileLocks[0];
    if (lock === undefined) throw new Error("fixture lock missing");
    const peer = openJobStore({ filename, instanceId: "instance-a", lock });
    openStores.push(peer);
    first.ingestEvent(event(1), workspace(runtimeDir));
    first.ingestEvent(event(2), workspace(runtimeDir));
    expect(
      first.acquireRuntimeLease("bridge", "instance-a", at(10), 1_000),
    ).toBe(true);
    acknowledgeNext(first, at(10));

    const firstClaim = first.claimNextTask("instance-a", at(11), 1_000);
    const peerClaim = peer.claimNextTask("instance-a", at(11), 1_000);

    expect(firstClaim).not.toBeNull();
    expect(peerClaim).toBeNull();
  });

  it.each([
    ["whole seconds", "2026-07-22T08:00:00Z"],
    ["one fractional digit", "2026-07-22T08:00:00.1Z"],
  ])(
    "normalizes %s event task timestamps while claiming",
    async (_caseName, receivedAt) => {
      const { filename, runtimeDir, first } = await stores();
      first.ingestEvent(event(1, { receivedAt }), workspace(runtimeDir));
      expect(
        first.acquireRuntimeLease("bridge", "instance-a", at(1_000), 1_000),
      ).toBe(true);
      acknowledgeNext(first, at(1_000));

      const claimed = first.claimNextTask("instance-a", at(1_001), 1_000);
      const expected = new Date(receivedAt).toISOString();
      expect(claimed).toMatchObject({
        createdAt: expected,
        updatedAt: at(1_001).toISOString(),
      });
      const inspection = new Database(filename, { readonly: true });
      expect(
        inspection
          .prepare("SELECT created_at AS createdAt FROM tasks WHERE id = ?")
          .get(claimed?.id),
      ).toEqual({ createdAt: expected });
      inspection.close();
    },
  );

  it.each([
    ["created_at", "date-only", "2026-07-22"],
    ["created_at", "natural language", "July 22, 2026 08:00:00 UTC"],
    ["created_at", "offset", "2026-07-22T16:00:00+08:00"],
    ["updated_at", "date-only", "2026-07-22"],
    ["updated_at", "natural language", "July 22, 2026 08:00:00 UTC"],
    ["updated_at", "offset", "2026-07-22T16:00:00+08:00"],
    ["last_event_at", "date-only", "2026-07-22"],
    ["last_event_at", "natural language", "July 22, 2026 08:00:00 UTC"],
    ["last_event_at", "offset", "2026-07-22T16:00:00+08:00"],
  ])(
    "fails closed instead of laundering a %s %s task ledger timestamp",
    async (column, _caseName, pollutedTimestamp) => {
      const { filename, runtimeDir, first } = await stores();
      const task = first.ingestEvent(event(1), workspace(runtimeDir));
      const setup = new Database(filename);
      setup
        .prepare(`UPDATE tasks SET ${column} = ? WHERE id = ?`)
        .run(pollutedTimestamp, task.taskId);
      setup.close();
      expect(
        first.acquireRuntimeLease("bridge", "instance-a", at(1_000), 1_000),
      ).toBe(true);

      expect(() =>
        first.claimNextTask("instance-a", at(1_001), 1_000),
      ).toThrowError(/task_persistence_failed/);
      const inspection = new Database(filename, { readonly: true });
      expect(
        inspection
          .prepare(
            `SELECT state, ${column} AS pollutedTimestamp,
                    lease_owner AS leaseOwner
               FROM tasks WHERE id = ?`,
          )
          .get(task.taskId),
      ).toEqual({
        state: "RECEIVED",
        pollutedTimestamp,
        leaseOwner: null,
      });
      inspection.close();
    },
  );

  it("requires the store's live bridge lease and allows at most one active task", async () => {
    const { runtimeDir, first, second } = await stores();
    const firstTask = first.ingestEvent(event(1), workspace(runtimeDir));
    first.ingestEvent(event(2), workspace(runtimeDir));

    expect(first.claimNextTask("instance-a", at(10), 1_000)).toBeNull();
    expect(
      first.acquireRuntimeLease("bridge", "instance-a", at(10), 1_000),
    ).toBe(true);
    acknowledgeNext(first, at(10));
    expect(second.claimNextTask("instance-b", at(11), 1_000)).toBeNull();

    const claimed = first.claimNextTask("instance-a", at(11), 1_000);
    expect(claimed).toMatchObject({
      id: firstTask.taskId,
      state: "CLAIMED",
      leaseOwner: "instance-a",
      leaseExpiresAt: at(1_011).toISOString(),
    });
    expect(Object.isFrozen(claimed)).toBe(true);
    expect(first.claimNextTask("instance-a", at(12), 1_000)).toBeNull();
  });

  it("orders received tasks by actual timestamp then id and returns detached immutable records", async () => {
    const { filename, runtimeDir, first } = await stores();
    const laterId = "00000000-0000-4000-8000-000000000002";
    const earlierId = "00000000-0000-4000-8000-000000000001";
    first.ingestEvent(event(2), workspace(runtimeDir, laterId));
    first.ingestEvent(event(1), workspace(runtimeDir, earlierId));
    expect(
      first.acquireRuntimeLease("bridge", "instance-a", at(10), 1_000),
    ).toBe(true);
    acknowledgeNext(first, at(10));

    const claimed = first.claimNextTask("instance-a", at(11), 1_000);
    expect(claimed?.id).toBe(earlierId);
    expect(typeof claimed?.createdAt).toBe("string");
    expect(Object.isFrozen(claimed)).toBe(true);

    const setup = new Database(filename);
    setup
      .prepare(
        "UPDATE tasks SET created_at = 'malformed' WHERE state = 'RECEIVED'",
      )
      .run();
    setup
      .prepare("UPDATE tasks SET state = 'FAILED' WHERE state = 'CLAIMED'")
      .run();
    setup.close();
    expect(() => first.claimNextTask("instance-a", at(12), 1_000)).toThrowError(
      /task_persistence_failed/,
    );
  });
});
