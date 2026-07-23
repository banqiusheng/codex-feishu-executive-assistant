import {
  sendProgressReply,
  type AssistantReplyGateway,
  type ProgressStage,
} from "./system-reply.js";

export const PROGRESS_THRESHOLD_MS = 60_000;

export type ProgressTerminal =
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "INTERRUPTED";

export type PersistedProgressEvent =
  | Readonly<{ kind: "PERSISTED_STAGE"; stage: unknown }>
  | Readonly<{ kind: "PERSISTED_TERMINAL"; terminal: unknown }>;

export type ProgressSubscription = Readonly<{
  snapshot: unknown;
  unsubscribe: () => void | Promise<void>;
}>;

export interface PersistedProgressSource {
  /**
   * Atomically installs the listener and returns the persisted state at the
   * hand-off point. Events committed after that snapshot must be delivered to
   * the listener. A source may synchronously replay older events while this
   * method is running; the returned snapshot is authoritative over that replay.
   */
  subscribeWithSnapshot(
    listener: (event: unknown) => void,
  ): ProgressSubscription;
}

export interface ProgressReporterDependencies {
  taskId: string;
  source: PersistedProgressSource;
  gateway: Pick<AssistantReplyGateway, "sendSystemReply">;
}

export interface ProgressReporter {
  stop(): void;
}

const STAGES = new Set<ProgressStage>([
  "QUEUED",
  "PREPARING",
  "RUNNING",
  "VERIFYING",
  "AWAITING_CONFIRMATION",
  "FINALIZING",
]);

const TERMINALS = new Set<ProgressTerminal>([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED",
]);

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) return false;
  const actual = (ownKeys as string[]).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key) => sortedExpected.includes(key))
  );
}

function projectEvent(value: unknown): PersistedProgressEvent | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  try {
    if (Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const kind = record.kind;
    if (kind === "PERSISTED_STAGE" && hasExactKeys(value, ["kind", "stage"])) {
      const stage = record.stage;
      return Object.freeze({ kind, stage });
    }
    if (
      kind === "PERSISTED_TERMINAL" &&
      hasExactKeys(value, ["kind", "terminal"])
    ) {
      const terminal = record.terminal;
      return Object.freeze({ kind, terminal });
    }
    return null;
  } catch {
    return null;
  }
}

type SubscriptionProjection = Readonly<{
  subscription: ProgressSubscription | null;
  cleanup?: () => void | Promise<void>;
}>;

function bindUnsubscribe(
  owner: object,
  candidate: unknown,
): (() => void | Promise<void>) | undefined {
  if (typeof candidate !== "function") return undefined;
  return () => Reflect.apply(candidate, owner, []) as void | Promise<void>;
}

function recoverDataUnsubscribe(
  value: object,
): (() => void | Promise<void>) | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "unsubscribe");
    return descriptor !== undefined && "value" in descriptor
      ? bindUnsubscribe(value, descriptor.value)
      : undefined;
  } catch {
    return undefined;
  }
}

function projectSubscription(value: unknown): SubscriptionProjection {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return Object.freeze({ subscription: null });
  }

  let arrayValue: boolean;
  try {
    arrayValue = Array.isArray(value);
  } catch {
    return Object.freeze({
      subscription: null,
      cleanup: recoverDataUnsubscribe(value),
    });
  }
  if (arrayValue) {
    return Object.freeze({
      subscription: null,
      cleanup: recoverDataUnsubscribe(value),
    });
  }

  let exactShape: boolean;
  try {
    exactShape = hasExactKeys(value, ["snapshot", "unsubscribe"]);
  } catch {
    return Object.freeze({
      subscription: null,
      cleanup: recoverDataUnsubscribe(value),
    });
  }
  if (!exactShape) {
    return Object.freeze({
      subscription: null,
      cleanup: recoverDataUnsubscribe(value),
    });
  }

  let cleanup: (() => void | Promise<void>) | undefined;
  try {
    cleanup = bindUnsubscribe(
      value,
      (value as Record<string, unknown>).unsubscribe,
    );
  } catch {
    return Object.freeze({
      subscription: null,
      cleanup: recoverDataUnsubscribe(value),
    });
  }
  if (cleanup === undefined) {
    return Object.freeze({
      subscription: null,
      cleanup: recoverDataUnsubscribe(value),
    });
  }

  try {
    const snapshot = (value as Record<string, unknown>).snapshot;
    return Object.freeze({
      subscription: Object.freeze({ snapshot, unsubscribe: cleanup }),
    });
  } catch {
    return Object.freeze({ subscription: null, cleanup });
  }
}

function isStage(value: unknown): value is ProgressStage {
  return typeof value === "string" && STAGES.has(value as ProgressStage);
}

function isTerminal(value: unknown): value is ProgressTerminal {
  return typeof value === "string" && TERMINALS.has(value as ProgressTerminal);
}

export function startProgressReporter(
  dependencies: ProgressReporterDependencies,
): ProgressReporter {
  let active = true;
  let thresholdReached = false;
  let currentStage: ProgressStage | undefined;
  let lastAttemptedStage: ProgressStage | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void | Promise<void>) | undefined;
  let sendTail = Promise.resolve();

  const cleanup = (
    operation: (() => void | Promise<void>) | undefined,
  ): void => {
    if (operation === undefined) return;
    try {
      void Promise.resolve(operation()).catch(() => undefined);
    } catch {
      // Cleanup is best-effort and never exposes source errors.
    }
  };

  const stop = (): void => {
    if (!active) return;
    active = false;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const installedUnsubscribe = unsubscribe;
    unsubscribe = undefined;
    cleanup(installedUnsubscribe);
  };

  const enqueue = (stage: ProgressStage): void => {
    if (!active || stage === lastAttemptedStage) return;
    lastAttemptedStage = stage;
    sendTail = sendTail.then(async () => {
      if (!active) return;
      try {
        await sendProgressReply(
          dependencies.gateway,
          dependencies.taskId,
          stage,
        );
      } catch {
        // A failed ledger reply is a fixed internal state. Do not retry the
        // same stage; a later distinct persisted stage may still proceed.
      }
    });
  };

  const consumeProjected = (event: PersistedProgressEvent): boolean => {
    if (!active) return false;
    if (event.kind === "PERSISTED_TERMINAL") {
      if (!isTerminal(event.terminal)) return false;
      stop();
      return true;
    }
    if (!isStage(event.stage)) return false;
    currentStage = event.stage;
    if (thresholdReached) enqueue(event.stage);
    return true;
  };

  const consume = (value: unknown): boolean => {
    const event = projectEvent(value);
    return event === null ? false : consumeProjected(event);
  };

  let untrustedSubscription: unknown;
  try {
    untrustedSubscription = dependencies.source.subscribeWithSnapshot(
      (event) => {
        consume(event);
      },
    );
  } catch {
    stop();
    return { stop };
  }
  const projectedSubscription = projectSubscription(untrustedSubscription);
  const subscription = projectedSubscription.subscription;
  if (subscription === null) {
    cleanup(projectedSubscription.cleanup);
    stop();
    return { stop };
  }
  if (!active) {
    cleanup(subscription.unsubscribe);
    return { stop };
  }
  unsubscribe = subscription.unsubscribe;

  const initialEvent = projectEvent(subscription.snapshot);
  if (initialEvent !== null) {
    consumeProjected(initialEvent);
  }
  if (!active) return { stop };

  timer = setTimeout(() => {
    timer = undefined;
    if (!active) return;
    thresholdReached = true;
    if (currentStage !== undefined) enqueue(currentStage);
  }, PROGRESS_THRESHOLD_MS);

  return { stop };
}
