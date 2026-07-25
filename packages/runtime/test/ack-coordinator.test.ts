import { types as utilTypes } from "node:util";

import type {
  TaskAcknowledgementRecord,
  TaskAcknowledgementState,
} from "@executive-assistant/job-store";
import { describe, expect, it } from "vitest";

import {
  acknowledgementBackoffMs,
  createAckCoordinator,
  retryableDnsCode,
  type AckCoordinatorStore,
} from "../src/ack-coordinator.js";

type MutableAck = {
  taskId: string;
  state: TaskAcknowledgementState;
  attemptCount: number;
  lastFailureClass:
    | "DNS_UNAVAILABLE"
    | "REMOTE_REJECTED"
    | "RESULT_AMBIGUOUS"
    | "LOCAL_EVIDENCE_FAILED"
    | null;
  createdAt: string;
  updatedAt: string;
  executable: boolean;
};

function frozen(row: MutableAck): TaskAcknowledgementRecord {
  return Object.freeze({
    taskId: row.taskId,
    state: row.state,
    attemptCount: row.attemptCount,
    lastFailureClass: row.lastFailureClass,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

class MemoryAckStore implements AckCoordinatorStore {
  readonly rows: MutableAck[];
  readonly events: string[] = [];
  throwOnAcknowledged = false;
  commitThenThrowOnAcknowledged = false;
  returnNullOnAcknowledged = false;

  constructor(states: readonly TaskAcknowledgementState[] = ["NOT_ATTEMPTED"]) {
    this.rows = states.map((state, index) => ({
      taskId: `task-${index + 1}`,
      state,
      attemptCount: state === "RETRYABLE_DNS" ? 1 : 0,
      lastFailureClass: state === "RETRYABLE_DNS" ? "DNS_UNAVAILABLE" : null,
      createdAt: `2026-07-25T00:00:0${index}.000Z`,
      updatedAt: "2026-07-25T00:00:00.000Z",
      executable: true,
    }));
  }

  getNextTaskAcknowledgementCandidate(): TaskAcknowledgementRecord | null {
    const row = this.rows.find((candidate) => candidate.executable);
    return row ? frozen(row) : null;
  }

  beginTaskAcknowledgement(input: {
    taskId: string;
    owner: string;
    now: Date;
  }): TaskAcknowledgementRecord | null {
    const row = this.rows.find((candidate) => candidate.executable);
    if (
      row?.taskId !== input.taskId ||
      (row.state !== "NOT_ATTEMPTED" && row.state !== "RETRYABLE_DNS")
    ) {
      return null;
    }
    row.state = "SENDING";
    row.attemptCount += 1;
    row.updatedAt = input.now.toISOString();
    row.lastFailureClass = null;
    this.events.push(`begin:${row.taskId}`);
    return frozen(row);
  }

  finishTaskAcknowledgement(input: {
    taskId: string;
    owner: string;
    now: Date;
    state: TaskAcknowledgementState;
    failureClass: MutableAck["lastFailureClass"];
  }): TaskAcknowledgementRecord | null {
    const row = this.rows.find(
      (candidate) => candidate.taskId === input.taskId,
    );
    if (!row || row.state !== "SENDING") return null;
    if (input.state === "ACKNOWLEDGED" && this.returnNullOnAcknowledged) {
      return null;
    }
    if (
      input.state === "ACKNOWLEDGED" &&
      this.throwOnAcknowledged &&
      !this.commitThenThrowOnAcknowledged
    ) {
      throw new Error("synthetic database uncertainty");
    }
    row.state = input.state;
    row.lastFailureClass = input.failureClass;
    row.updatedAt = input.now.toISOString();
    if (
      input.state === "ACKNOWLEDGED" ||
      input.state === "AMBIGUOUS" ||
      input.state === "FAILED_DEFINITE"
    ) {
      row.executable = false;
    }
    this.events.push(`finish:${input.state}:${String(input.failureClass)}`);
    if (
      input.state === "ACKNOWLEDGED" &&
      this.throwOnAcknowledged &&
      this.commitThenThrowOnAcknowledged
    ) {
      throw new Error("synthetic commit-then-throw uncertainty");
    }
    return frozen(row);
  }
}

function dnsError(code: "ENOTFOUND" | "EAI_AGAIN"): Error {
  const error = new Error("synthetic");
  Object.defineProperty(error, "code", {
    value: code,
    enumerable: true,
    configurable: true,
  });
  return error;
}

function coordinatorOptions(
  store: MemoryAckStore,
  overrides: Partial<Parameters<typeof createAckCoordinator>[0]> = {},
): Parameters<typeof createAckCoordinator>[0] {
  return {
    store,
    owner: "runtime-fixture",
    now: () => new Date("2026-07-25T00:00:00.000Z"),
    delay: async () => undefined,
    loadRoute: async (taskId) =>
      Object.freeze({
        taskId,
        chatId: `chat-${taskId}`,
        messageId: `message-${taskId}`,
      }),
    send: async () => Object.freeze({ messageId: "reply-fixture" }),
    writeMarker: async (taskId) => {
      store.events.push(`marker:${taskId}`);
    },
    wakeWorker: () => {
      store.events.push("wake");
      return true;
    },
    tripExecutionBarrier: () => {
      store.events.push("barrier");
    },
    ...overrides,
  };
}

describe("ACK coordinator safety classification", () => {
  it("accepts only exact own-data DNS codes without traversing wrappers", () => {
    expect(retryableDnsCode(dnsError("ENOTFOUND"))).toBe("ENOTFOUND");
    expect(retryableDnsCode({ code: "EAI_AGAIN" })).toBe("EAI_AGAIN");

    const inherited = Object.create({ code: "ENOTFOUND" });
    const accessor = Object.defineProperty({}, "code", {
      enumerable: true,
      get: () => "ENOTFOUND",
    });
    const proxy = new Proxy({ code: "ENOTFOUND" }, {});
    expect(utilTypes.isProxy(proxy)).toBe(true);
    expect(retryableDnsCode(inherited)).toBeNull();
    expect(retryableDnsCode(accessor)).toBeNull();
    expect(retryableDnsCode(proxy)).toBeNull();
    expect(retryableDnsCode({ cause: dnsError("ENOTFOUND") })).toBeNull();
    expect(retryableDnsCode({ code: "ETIMEDOUT" })).toBeNull();
    expect(retryableDnsCode("ENOTFOUND")).toBeNull();
  });

  it("uses the exact capped retry schedule", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map(acknowledgementBackoffMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000, 60_000, 60_000,
    ]);
  });
});

describe("single FIFO ACK coordinator", () => {
  it("keeps one send in flight and lets the oldest DNS retry block later tasks", async () => {
    const store = new MemoryAckStore(["NOT_ATTEMPTED", "NOT_ATTEMPTED"]);
    const sends: string[] = [];
    const delays: number[] = [];
    let active = 0;
    let maximumActive = 0;
    let firstAttempts = 0;
    const coordinator = createAckCoordinator(
      coordinatorOptions(store, {
        delay: async (milliseconds) => {
          delays.push(milliseconds);
        },
        send: async (route) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          sends.push(route.taskId);
          await Promise.resolve();
          active -= 1;
          if (route.taskId === "task-1" && firstAttempts++ < 2) {
            throw dnsError("ENOTFOUND");
          }
          return Object.freeze({ messageId: `reply-${route.taskId}` });
        },
      }),
    );

    await coordinator.start();
    await coordinator.waitForIdle();

    expect(sends).toEqual(["task-1", "task-1", "task-1", "task-2"]);
    expect(delays).toEqual([1_000, 2_000]);
    expect(maximumActive).toBe(1);
    expect(store.rows.map((row) => row.state)).toEqual([
      "ACKNOWLEDGED",
      "ACKNOWLEDGED",
    ]);
  });

  it("resumes a persisted retry after only the remaining backoff", async () => {
    const store = new MemoryAckStore(["RETRYABLE_DNS"]);
    store.rows[0]!.attemptCount = 3;
    const delays: number[] = [];
    const coordinator = createAckCoordinator(
      coordinatorOptions(store, {
        now: () => new Date("2026-07-25T00:00:01.250Z"),
        delay: async (milliseconds) => {
          delays.push(milliseconds);
        },
      }),
    );

    await coordinator.start();
    await coordinator.waitForIdle();

    expect(delays).toEqual([2_750]);
  });

  it("writes marker, finalizes the database, and only then wakes", async () => {
    const store = new MemoryAckStore();
    const coordinator = createAckCoordinator(coordinatorOptions(store));

    await coordinator.start();
    await coordinator.waitForIdle();

    expect(store.events).toEqual([
      "begin:task-1",
      "marker:task-1",
      "finish:ACKNOWLEDGED:null",
      "wake",
    ]);
  });

  it("retries an acknowledged worker wake until the worker accepts it", async () => {
    const store = new MemoryAckStore(["ACKNOWLEDGED"]);
    const accepted: boolean[] = [];
    const coordinator = createAckCoordinator(
      coordinatorOptions(store, {
        wakeWorker: () => {
          const next = accepted.length > 0;
          accepted.push(next);
          return next;
        },
      }),
    );

    await coordinator.start();
    await coordinator.waitForIdle();
    coordinator.wake();
    await coordinator.waitForIdle();

    expect(accepted).toEqual([false, true]);
  });

  it("rescans FIFO when begin observes that the candidate was cancelled", async () => {
    const store = new MemoryAckStore(["NOT_ATTEMPTED", "NOT_ATTEMPTED"]);
    let cancelled = false;
    const coordinatorStore: AckCoordinatorStore = Object.freeze({
      getNextTaskAcknowledgementCandidate: () =>
        store.getNextTaskAcknowledgementCandidate(),
      beginTaskAcknowledgement: (input) => {
        if (!cancelled && input.taskId === "task-1") {
          cancelled = true;
          store.rows[0]!.executable = false;
          return null;
        }
        return store.beginTaskAcknowledgement(input);
      },
      finishTaskAcknowledgement: (input) =>
        store.finishTaskAcknowledgement(input),
    });
    const sends: string[] = [];
    const coordinator = createAckCoordinator(
      coordinatorOptions(store, {
        store: coordinatorStore,
        send: async (route) => {
          sends.push(route.taskId);
          return Object.freeze({ messageId: `reply-${route.taskId}` });
        },
      }),
    );

    await coordinator.start();
    await coordinator.waitForIdle();

    expect(sends).toEqual(["task-2"]);
    expect(store.rows[1]?.state).toBe("ACKNOWLEDGED");
  });

  it("aborts acknowledgement backoff on wake and promptly rescans after cancellation", async () => {
    const store = new MemoryAckStore(["RETRYABLE_DNS", "NOT_ATTEMPTED"]);
    let observedSignal: AbortSignal | undefined;
    const sends: string[] = [];
    const coordinator = createAckCoordinator(
      coordinatorOptions(store, {
        delay: (_milliseconds, signal) => {
          observedSignal = signal;
          return new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
        send: async (route) => {
          sends.push(route.taskId);
          return Object.freeze({ messageId: `reply-${route.taskId}` });
        },
      }),
    );

    await coordinator.start();
    await Promise.resolve();
    store.rows[0]!.executable = false;
    coordinator.wake();
    try {
      expect(observedSignal?.aborted).toBe(true);
      await coordinator.waitForIdle();
      expect(sends).toEqual(["task-2"]);
    } finally {
      await coordinator.stop();
    }
  });

  it("restarts the remaining persisted backoff when a wake does not change the head", async () => {
    const store = new MemoryAckStore(["RETRYABLE_DNS"]);
    const delays: Array<{
      milliseconds: number;
      signal: AbortSignal;
      resolve: () => void;
    }> = [];
    let sends = 0;
    const coordinator = createAckCoordinator(
      coordinatorOptions(store, {
        delay: (milliseconds, signal) =>
          new Promise<void>((resolve) => {
            delays.push({ milliseconds, signal, resolve });
            signal.addEventListener("abort", () => resolve(), { once: true });
          }),
        send: async () => {
          sends += 1;
          return Object.freeze({ messageId: "reply-fixture" });
        },
      }),
    );

    await coordinator.start();
    await Promise.resolve();
    coordinator.wake();
    await Promise.resolve();
    await Promise.resolve();
    try {
      expect(delays.map((entry) => entry.milliseconds)).toEqual([1_000, 1_000]);
      expect(sends).toBe(0);
      delays[1]!.resolve();
      await coordinator.waitForIdle();
      expect(sends).toBe(1);
    } finally {
      await coordinator.stop();
    }
  });

  it("classifies marker failure as local-evidence ambiguity without resend or wake", async () => {
    const store = new MemoryAckStore();
    let sends = 0;
    const coordinator = createAckCoordinator(
      coordinatorOptions(store, {
        send: async () => {
          sends += 1;
          return Object.freeze({ messageId: "reply-fixture" });
        },
        writeMarker: async () => {
          throw new Error("synthetic marker failure");
        },
      }),
    );

    await coordinator.start();
    await coordinator.waitForIdle();

    expect(sends).toBe(1);
    expect(store.rows[0]).toMatchObject({
      state: "AMBIGUOUS",
      lastFailureClass: "LOCAL_EVIDENCE_FAILED",
    });
    expect(store.events).not.toContain("wake");
  });

  it.each([
    new Error("synthetic timeout"),
    Object.assign(new Error("synthetic disconnect"), { code: "ECONNRESET" }),
    { cause: dnsError("EAI_AGAIN") },
    Object.create({ code: "ENOTFOUND" }),
  ])(
    "never retries or wakes after an ambiguous send failure",
    async (failure) => {
      const store = new MemoryAckStore();
      let sends = 0;
      const coordinator = createAckCoordinator(
        coordinatorOptions(store, {
          send: async () => {
            sends += 1;
            throw failure;
          },
        }),
      );

      await coordinator.start();
      await coordinator.waitForIdle();

      expect(sends).toBe(1);
      expect(store.rows[0]).toMatchObject({
        state: "AMBIGUOUS",
        lastFailureClass: "RESULT_AMBIGUOUS",
      });
      expect(store.events).not.toContain("wake");
    },
  );

  it("trips the execution barrier synchronously after commit-then-throw ACK uncertainty", async () => {
    const store = new MemoryAckStore();
    store.throwOnAcknowledged = true;
    store.commitThenThrowOnAcknowledged = true;
    let sends = 0;
    const coordinator = createAckCoordinator(
      coordinatorOptions(store, {
        send: async () => {
          sends += 1;
          return Object.freeze({ messageId: "reply-fixture" });
        },
      }),
    );

    await coordinator.start();
    await coordinator.waitForIdle();

    expect(sends).toBe(1);
    expect(store.rows[0]?.state).toBe("ACKNOWLEDGED");
    expect(store.events).toContain("barrier");
    expect(store.events.indexOf("barrier")).toBe(
      store.events.indexOf("finish:ACKNOWLEDGED:null") + 1,
    );
    expect(store.events).not.toContain("wake");
  });

  it("trips the execution barrier when ACK finalization returns null", async () => {
    const store = new MemoryAckStore();
    store.returnNullOnAcknowledged = true;
    const coordinator = createAckCoordinator(coordinatorOptions(store));

    await coordinator.start();
    await coordinator.waitForIdle();

    expect(store.rows[0]?.state).toBe("SENDING");
    expect(store.events).toContain("barrier");
    expect(store.events).not.toContain("wake");
  });

  it("cancels a pending delay and prevents every later send", async () => {
    const store = new MemoryAckStore(["RETRYABLE_DNS"]);
    let sends = 0;
    let observedSignal: AbortSignal | undefined;
    const coordinator = createAckCoordinator(
      coordinatorOptions(store, {
        delay: (_milliseconds, signal) => {
          observedSignal = signal;
          return new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
        send: async () => {
          sends += 1;
          return Object.freeze({ messageId: "reply-fixture" });
        },
      }),
    );

    await coordinator.start();
    await Promise.resolve();
    await coordinator.stop();
    await coordinator.waitForIdle();

    expect(observedSignal?.aborted).toBe(true);
    expect(sends).toBe(0);
  });
});
