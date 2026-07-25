import { types as utilTypes } from "node:util";

import type {
  JobStore,
  TaskAcknowledgementRecord,
} from "@executive-assistant/job-store";

export type AcknowledgementRoute = Readonly<{
  taskId: string;
  chatId: string;
  messageId: string;
}>;

export type AckCoordinatorStore = Pick<
  JobStore,
  | "getNextTaskAcknowledgementCandidate"
  | "beginTaskAcknowledgement"
  | "finishTaskAcknowledgement"
>;

export type AckCoordinatorOptions = Readonly<{
  store: AckCoordinatorStore;
  owner: string;
  now: () => Date;
  delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  loadRoute: (taskId: string) => Promise<AcknowledgementRoute>;
  send: (
    route: AcknowledgementRoute,
  ) => Promise<Readonly<{ messageId: string }>>;
  writeMarker: (taskId: string, acknowledgedAt: Date) => Promise<void>;
  wakeWorker: () => void;
}>;

export function retryableDnsCode(
  value: unknown,
): "ENOTFOUND" | "EAI_AGAIN" | null {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      utilTypes.isProxy(value)
    ) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, "code");
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      (descriptor.value !== "ENOTFOUND" && descriptor.value !== "EAI_AGAIN")
    ) {
      return null;
    }
    return descriptor.value;
  } catch {
    return null;
  }
}

export function acknowledgementBackoffMs(attemptCount: number): number {
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) {
    throw new Error("ACKNOWLEDGEMENT_ATTEMPT_COUNT_INVALID");
  }
  return (
    [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000][
      Math.min(attemptCount - 1, 6)
    ] ?? 60_000
  );
}

function remainingBackoff(
  acknowledgement: TaskAcknowledgementRecord,
  now: Date,
): number {
  const elapsed = Math.max(
    0,
    now.getTime() - Date.parse(acknowledgement.updatedAt),
  );
  return Math.max(
    0,
    acknowledgementBackoffMs(acknowledgement.attemptCount) - elapsed,
  );
}

function defaultDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      finish();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function createAckCoordinator(options: AckCoordinatorOptions): Readonly<{
  start(): Promise<void>;
  wake(): void;
  stop(): Promise<void>;
  waitForIdle(): Promise<void>;
}> {
  let started = false;
  let stopping = false;
  let wakeRequested = false;
  let loopPromise: Promise<void> | undefined;
  const abortController = new AbortController();
  const wokenAcknowledged = new Set<string>();

  const finish = (
    taskId: string,
    state: "RETRYABLE_DNS" | "ACKNOWLEDGED" | "AMBIGUOUS",
    failureClass:
      | "DNS_UNAVAILABLE"
      | "RESULT_AMBIGUOUS"
      | "LOCAL_EVIDENCE_FAILED"
      | null,
  ): TaskAcknowledgementRecord | null =>
    options.store.finishTaskAcknowledgement({
      taskId,
      owner: options.owner,
      now: options.now(),
      state,
      failureClass,
    });

  const processCandidate = async (): Promise<"continue" | "idle" | "halt"> => {
    const candidate = options.store.getNextTaskAcknowledgementCandidate();
    if (candidate === null) return "idle";
    if (candidate.state === "ACKNOWLEDGED") {
      if (!wokenAcknowledged.has(candidate.taskId)) {
        wokenAcknowledged.add(candidate.taskId);
        options.wakeWorker();
      }
      return "idle";
    }
    if (
      candidate.state !== "NOT_ATTEMPTED" &&
      candidate.state !== "RETRYABLE_DNS"
    ) {
      return "halt";
    }
    if (candidate.state === "RETRYABLE_DNS") {
      const wait = remainingBackoff(candidate, options.now());
      if (wait > 0) {
        await options.delay(wait, abortController.signal);
        if (stopping || abortController.signal.aborted) return "halt";
      }
    }

    let route: AcknowledgementRoute;
    try {
      route = await options.loadRoute(candidate.taskId);
    } catch {
      return "halt";
    }
    if (stopping) return "halt";

    let sending: TaskAcknowledgementRecord | null;
    try {
      sending = options.store.beginTaskAcknowledgement({
        taskId: candidate.taskId,
        owner: options.owner,
        now: options.now(),
      });
    } catch {
      return "halt";
    }
    if (sending?.taskId !== candidate.taskId) return "halt";

    try {
      await options.send(route);
    } catch (cause) {
      try {
        if (retryableDnsCode(cause) !== null) {
          return finish(candidate.taskId, "RETRYABLE_DNS", "DNS_UNAVAILABLE")
            ?.state === "RETRYABLE_DNS"
            ? "continue"
            : "halt";
        }
        finish(candidate.taskId, "AMBIGUOUS", "RESULT_AMBIGUOUS");
        return "continue";
      } catch {
        return "halt";
      }
    }

    const acknowledgedAt = options.now();
    try {
      await options.writeMarker(candidate.taskId, acknowledgedAt);
    } catch {
      try {
        finish(candidate.taskId, "AMBIGUOUS", "LOCAL_EVIDENCE_FAILED");
        return "continue";
      } catch {
        return "halt";
      }
    }

    try {
      const acknowledged = finish(candidate.taskId, "ACKNOWLEDGED", null);
      if (acknowledged?.state !== "ACKNOWLEDGED") return "halt";
    } catch {
      return "halt";
    }
    if (stopping) return "halt";
    wokenAcknowledged.add(candidate.taskId);
    options.wakeWorker();
    return "continue";
  };

  const schedule = (): void => {
    if (!started || stopping || loopPromise !== undefined) return;
    loopPromise = (async () => {
      while (!stopping) {
        wakeRequested = false;
        const result = await processCandidate();
        if (result !== "continue") break;
      }
    })().finally(() => {
      loopPromise = undefined;
      if (wakeRequested && !stopping) schedule();
    });
  };

  return Object.freeze({
    async start(): Promise<void> {
      if (started || stopping) return;
      started = true;
      wakeRequested = true;
      schedule();
    },
    wake(): void {
      if (stopping) return;
      wakeRequested = true;
      schedule();
    },
    async stop(): Promise<void> {
      if (stopping) {
        await loopPromise;
        return;
      }
      stopping = true;
      abortController.abort();
      await loopPromise;
    },
    async waitForIdle(): Promise<void> {
      while (loopPromise) {
        const current = loopPromise;
        await current;
        if (loopPromise === current) break;
      }
    },
  });
}

export const sleepForAcknowledgement = defaultDelay;
