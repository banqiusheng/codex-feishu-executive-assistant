import { afterEach, describe, expect, it, vi } from "vitest";

import { startProgressReporter } from "../src/runtime/progress-reporter.js";

function persistedSource(
  snapshot: () => unknown,
  subscribe: (
    listener: (event: unknown) => void,
  ) => () => void | Promise<void> = () => vi.fn(),
) {
  return {
    subscribeWithSnapshot(listener: (event: unknown) => void) {
      const unsubscribe = subscribe(listener);
      return { snapshot: snapshot(), unsubscribe };
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("progress reporter", () => {
  it("sends the persisted stage at 60 seconds but not at 59:59", async () => {
    vi.useFakeTimers();
    const gateway = {
      sendSystemReply: vi.fn(async () => ({ state: "SUCCEEDED" as const })),
    };
    const reporter = startProgressReporter({
      taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      source: persistedSource(() => ({
        kind: "PERSISTED_STAGE",
        stage: "RUNNING",
      })),
      gateway,
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(gateway.sendSystemReply).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(gateway.sendSystemReply).toHaveBeenCalledWith(
      "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      { type: "text", value: "正在处理任务。" },
    );

    reporter.stop();
  });

  it("ignores tool-shaped objects even when they carry an allowlisted stage", async () => {
    vi.useFakeTimers();
    let listener: ((event: unknown) => void) | undefined;
    const gateway = {
      sendSystemReply: vi.fn(async (_taskId: string, _body: unknown) => ({
        state: "SUCCEEDED" as const,
      })),
    };
    const reporter = startProgressReporter({
      taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      source: persistedSource(
        () => ({ kind: "PERSISTED_STAGE", stage: "PREPARING" }),
        (next) => {
          listener = next;
          return vi.fn();
        },
      ),
      gateway,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(gateway.sendSystemReply).toHaveBeenCalledTimes(1);

    const toolEvent = {
      kind: "tool",
      stage: "RUNNING",
      get raw() {
        throw new Error("secret tool arguments");
      },
    };
    expect(() => listener?.(toolEvent)).not.toThrow();
    await Promise.resolve();

    expect(gateway.sendSystemReply).toHaveBeenCalledTimes(1);
    reporter.stop();
  });

  it("rejects extra fields on a persisted event without reading secret getters", async () => {
    vi.useFakeTimers();
    let listener: ((event: unknown) => void) | undefined;
    const gateway = {
      sendSystemReply: vi.fn(async () => ({ state: "SUCCEEDED" as const })),
    };
    const reporter = startProgressReporter({
      taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      source: persistedSource(
        () => ({ kind: "PERSISTED_STAGE", stage: "RUNNING" }),
        (next) => {
          listener = next;
          return vi.fn();
        },
      ),
      gateway,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    gateway.sendSystemReply.mockClear();

    const malformed = {
      kind: "PERSISTED_STAGE",
      stage: "VERIFYING",
      get raw() {
        throw new Error("secret model output");
      },
    };
    expect(() => listener?.(malformed)).not.toThrow();
    await Promise.resolve();

    expect(gateway.sendSystemReply).not.toHaveBeenCalled();
    reporter.stop();
  });

  it("fails closed without throwing when a persisted event proxy is revoked", () => {
    vi.useFakeTimers();
    let listener: ((event: unknown) => void) | undefined;
    const reporter = startProgressReporter({
      taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      source: persistedSource(
        () => ({ kind: "PERSISTED_STAGE", stage: "RUNNING" }),
        (next) => {
          listener = next;
          return vi.fn();
        },
      ),
      gateway: {
        sendSystemReply: vi.fn(async () => ({ state: "SUCCEEDED" as const })),
      },
    });
    const revocable = Proxy.revocable(
      { kind: "PERSISTED_STAGE", stage: "VERIFYING" },
      {},
    );
    revocable.revoke();

    expect(() => listener?.(revocable.proxy)).not.toThrow();
    reporter.stop();
  });

  it("cleans a listener installed by a synchronous terminal emission", () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const gateway = {
      sendSystemReply: vi.fn(async () => ({ state: "SUCCEEDED" as const })),
    };
    const reporter = startProgressReporter({
      taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      source: persistedSource(
        () => ({ kind: "PERSISTED_STAGE", stage: "RUNNING" }),
        (listener) => {
          listener({ kind: "PERSISTED_TERMINAL", terminal: "SUCCEEDED" });
          return unsubscribe;
        },
      ),
      gateway,
    });

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    reporter.stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("subscribes before taking the post-subscription snapshot", () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const unsubscribe = vi.fn();
    const gateway = {
      sendSystemReply: vi.fn(async () => ({ state: "SUCCEEDED" as const })),
    };

    const reporter = startProgressReporter({
      taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      source: persistedSource(
        () => {
          calls.push("snapshot");
          return { kind: "PERSISTED_STAGE", stage: "RUNNING" };
        },
        (listener) => {
          calls.push("subscribe");
          listener({ kind: "PERSISTED_TERMINAL", terminal: "SUCCEEDED" });
          return unsubscribe;
        },
      ),
      gateway,
    });

    expect(calls[0]).toBe("subscribe");
    expect(gateway.sendSystemReply).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(unsubscribe).toHaveBeenCalledOnce();
    reporter.stop();
  });

  it("treats the atomic snapshot as authoritative over synchronous replay", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const gateway = {
      sendSystemReply: vi.fn(async () => ({ state: "SUCCEEDED" as const })),
    };

    const reporter = startProgressReporter({
      taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      source: persistedSource(
        () => {
          calls.push("snapshot");
          return { kind: "PERSISTED_STAGE", stage: "RUNNING" };
        },
        (listener) => {
          calls.push("subscribe");
          listener({ kind: "PERSISTED_STAGE", stage: "FINALIZING" });
          return vi.fn();
        },
      ),
      gateway,
    });

    expect(calls).toEqual(["subscribe", "snapshot"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gateway.sendSystemReply).toHaveBeenCalledWith(
      "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      { type: "text", value: "正在处理任务。" },
    );
    reporter.stop();
  });

  it("uses the atomic subscription snapshot after a synchronous replay", async () => {
    vi.useFakeTimers();
    const gateway = {
      sendSystemReply: vi.fn(async () => ({ state: "SUCCEEDED" as const })),
    };

    const reporter = startProgressReporter({
      taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      source: {
        subscribeWithSnapshot: (listener) => {
          listener({ kind: "PERSISTED_STAGE", stage: "RUNNING" });
          return {
            snapshot: { kind: "PERSISTED_STAGE", stage: "VERIFYING" },
            unsubscribe: vi.fn(),
          };
        },
      },
      gateway,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(gateway.sendSystemReply).toHaveBeenCalledOnce();
    expect(gateway.sendSystemReply).toHaveBeenCalledWith(
      "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      { type: "text", value: "正在核对处理结果。" },
    );
    reporter.stop();
  });

  it("cleans the installed listener when the atomic snapshot getter throws", () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const subscription: { snapshot: unknown; unsubscribe: () => void } = {
      snapshot: undefined,
      unsubscribe,
    };
    Object.defineProperty(subscription, "snapshot", {
      enumerable: true,
      get() {
        throw new Error("secret snapshot failure");
      },
    });
    const gateway = {
      sendSystemReply: vi.fn(async () => ({ state: "SUCCEEDED" as const })),
    };

    const reporter = startProgressReporter({
      taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      source: { subscribeWithSnapshot: () => subscription },
      gateway,
    });

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(gateway.sendSystemReply).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    reporter.stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("best-effort cleans a data unsubscribe from a malformed subscription", () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const gateway = {
      sendSystemReply: vi.fn(async () => ({ state: "SUCCEEDED" as const })),
    };

    const reporter = startProgressReporter({
      taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      source: {
        subscribeWithSnapshot: () => ({
          snapshot: { kind: "PERSISTED_STAGE", stage: "RUNNING" },
          unsubscribe,
          unexpected: "secret",
        }),
      } as never,
      gateway,
    });

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    reporter.stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("best-effort cleans a data unsubscribe from an array subscription", () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const subscription = Object.assign([], {
      snapshot: { kind: "PERSISTED_STAGE", stage: "RUNNING" },
      unsubscribe,
    });
    const reporter = startProgressReporter({
      taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      source: {
        subscribeWithSnapshot: () => subscription,
      } as never,
      gateway: {
        sendSystemReply: vi.fn(async () => ({ state: "SUCCEEDED" as const })),
      },
    });

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    reporter.stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("best-effort cleans a data unsubscribe from a callable subscription", () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const subscription = Object.assign(vi.fn(), {
      snapshot: { kind: "PERSISTED_STAGE", stage: "RUNNING" },
      unsubscribe,
    });
    const reporter = startProgressReporter({
      taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      source: {
        subscribeWithSnapshot: () => subscription,
      } as never,
      gateway: {
        sendSystemReply: vi.fn(async () => ({ state: "SUCCEEDED" as const })),
      },
    });

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    reporter.stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("best-effort cleans a data unsubscribe when own-key inspection throws", () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const subscription = new Proxy(
      {
        snapshot: { kind: "PERSISTED_STAGE", stage: "RUNNING" },
        unsubscribe,
      },
      {
        ownKeys() {
          throw new Error("secret own-key failure");
        },
      },
    );
    const reporter = startProgressReporter({
      taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      source: { subscribeWithSnapshot: () => subscription },
      gateway: {
        sendSystemReply: vi.fn(async () => ({ state: "SUCCEEDED" as const })),
      },
    });

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    reporter.stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it.each(["throws", "returns a non-function"] as const)(
    "recovers a data unsubscribe when direct property access %s",
    (behavior) => {
      vi.useFakeTimers();
      const unsubscribe = vi.fn();
      const subscription = new Proxy(
        {
          snapshot: { kind: "PERSISTED_STAGE", stage: "RUNNING" },
          unsubscribe,
        },
        {
          get(target, property, receiver) {
            if (property !== "unsubscribe") {
              return Reflect.get(target, property, receiver);
            }
            if (behavior === "throws") {
              throw new Error("secret unsubscribe access failure");
            }
            return "not a function";
          },
        },
      );
      const reporter = startProgressReporter({
        taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
        source: { subscribeWithSnapshot: () => subscription },
        gateway: {
          sendSystemReply: vi.fn(async () => ({
            state: "SUCCEEDED" as const,
          })),
        },
      });

      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      reporter.stop();
      expect(unsubscribe).toHaveBeenCalledOnce();
    },
  );

  it("lets a post-subscription terminal snapshot stop a synchronously replayed stage", async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const gateway = {
      sendSystemReply: vi.fn(async () => ({ state: "SUCCEEDED" as const })),
    };

    const reporter = startProgressReporter({
      taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      source: persistedSource(
        () => ({
          kind: "PERSISTED_TERMINAL",
          terminal: "SUCCEEDED",
        }),
        (listener) => {
          listener({ kind: "PERSISTED_STAGE", stage: "RUNNING" });
          return unsubscribe;
        },
      ),
      gateway,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(gateway.sendSystemReply).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(unsubscribe).toHaveBeenCalledOnce();
    reporter.stop();
  });

  it("consumes an asynchronous unsubscribe rejection", async () => {
    vi.useFakeTimers();
    const then = vi.fn(
      (
        _resolve: (value: void | PromiseLike<void>) => void,
        reject: (reason?: unknown) => void,
      ) => reject(new Error("secret async unsubscribe failure")),
    );
    const rejectedThenable = { then } as unknown as Promise<void>;
    const unsubscribe = vi.fn(() => rejectedThenable);
    const gateway = {
      sendSystemReply: vi.fn(async () => ({ state: "SUCCEEDED" as const })),
    };
    const reporter = startProgressReporter({
      taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      source: persistedSource(
        () => ({ kind: "PERSISTED_STAGE", stage: "RUNNING" }),
        () => unsubscribe,
      ),
      gateway,
    });

    reporter.stop();
    await Promise.resolve();
    await Promise.resolve();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(then).toHaveBeenCalledOnce();
  });

  it("keeps all pre-threshold stages silent and reports only the current one at 60 seconds", async () => {
    vi.useFakeTimers();
    let listener: ((event: unknown) => void) | undefined;
    const gateway = {
      sendSystemReply: vi.fn(async () => ({ state: "SUCCEEDED" as const })),
    };
    const reporter = startProgressReporter({
      taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      source: persistedSource(
        () => ({ kind: "PERSISTED_STAGE", stage: "QUEUED" }),
        (next) => {
          listener = next;
          return vi.fn();
        },
      ),
      gateway,
    });

    listener?.({ kind: "PERSISTED_STAGE", stage: "PREPARING" });
    listener?.({ kind: "PERSISTED_STAGE", stage: "VERIFYING" });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(gateway.sendSystemReply).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(gateway.sendSystemReply).toHaveBeenCalledOnce();
    expect(gateway.sendSystemReply).toHaveBeenCalledWith(
      "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      { type: "text", value: "正在核对处理结果。" },
    );
    reporter.stop();
  });

  it("sends only distinct allowlisted persisted stages after the threshold", async () => {
    vi.useFakeTimers();
    let listener: ((event: unknown) => void) | undefined;
    const gateway = {
      sendSystemReply: vi.fn(async (_taskId: string, _body: unknown) => ({
        state: "SUCCEEDED" as const,
      })),
    };
    const reporter = startProgressReporter({
      taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      source: persistedSource(
        () => ({ kind: "PERSISTED_STAGE", stage: "RUNNING" }),
        (next) => {
          listener = next;
          return vi.fn();
        },
      ),
      gateway,
    });
    await vi.advanceTimersByTimeAsync(60_000);

    listener?.({ kind: "PERSISTED_STAGE", stage: "RUNNING" });
    listener?.({ kind: "PERSISTED_STAGE", stage: "UNKNOWN_STAGE" });
    listener?.({ kind: "thinking", stage: "FINALIZING" });
    listener?.({ kind: "message_delta", stage: "FINALIZING" });
    listener?.({ kind: "PERSISTED_STAGE", stage: "FINALIZING" });
    listener?.({ kind: "PERSISTED_STAGE", stage: "FINALIZING" });
    await Promise.resolve();
    await Promise.resolve();

    expect(gateway.sendSystemReply).toHaveBeenCalledTimes(2);
    expect(gateway.sendSystemReply.mock.calls.map((call) => call[1])).toEqual([
      { type: "text", value: "正在处理任务。" },
      { type: "text", value: "正在准备最终回复。" },
    ]);
    reporter.stop();
  });

  it.each(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"] as const)(
    "stops before 60 seconds on terminal %s",
    async (terminal) => {
      vi.useFakeTimers();
      let listener: ((event: unknown) => void) | undefined;
      const unsubscribe = vi.fn();
      const gateway = {
        sendSystemReply: vi.fn(async () => ({ state: "SUCCEEDED" as const })),
      };
      const reporter = startProgressReporter({
        taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
        source: persistedSource(
          () => ({ kind: "PERSISTED_STAGE", stage: "RUNNING" }),
          (next) => {
            listener = next;
            return unsubscribe;
          },
        ),
        gateway,
      });

      listener?.({ kind: "PERSISTED_TERMINAL", terminal });
      listener?.({ kind: "PERSISTED_STAGE", stage: "FINALIZING" });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(gateway.sendSystemReply).not.toHaveBeenCalled();
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      reporter.stop();
      expect(unsubscribe).toHaveBeenCalledOnce();
    },
  );

  it("makes stop idempotent and ignores all later events", async () => {
    vi.useFakeTimers();
    let listener: ((event: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    const gateway = {
      sendSystemReply: vi.fn(async () => ({ state: "SUCCEEDED" as const })),
    };
    const reporter = startProgressReporter({
      taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      source: persistedSource(
        () => ({ kind: "PERSISTED_STAGE", stage: "RUNNING" }),
        (next) => {
          listener = next;
          return unsubscribe;
        },
      ),
      gateway,
    });

    reporter.stop();
    reporter.stop();
    listener?.({ kind: "PERSISTED_STAGE", stage: "FINALIZING" });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(gateway.sendSystemReply).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("serializes progress sends", async () => {
    vi.useFakeTimers();
    let listener: ((event: unknown) => void) | undefined;
    let resolveFirst: ((value: { state: "SUCCEEDED" }) => void) | undefined;
    const first = new Promise<{ state: "SUCCEEDED" }>((resolve) => {
      resolveFirst = resolve;
    });
    let markSecondStarted: (() => void) | undefined;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const gateway = {
      sendSystemReply: vi
        .fn()
        .mockImplementationOnce(async () => first)
        .mockImplementationOnce(async () => {
          markSecondStarted?.();
          return { state: "SUCCEEDED" as const };
        }),
    };
    const reporter = startProgressReporter({
      taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      source: persistedSource(
        () => ({ kind: "PERSISTED_STAGE", stage: "RUNNING" }),
        (next) => {
          listener = next;
          return vi.fn();
        },
      ),
      gateway,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    listener?.({ kind: "PERSISTED_STAGE", stage: "VERIFYING" });
    await Promise.resolve();

    expect(gateway.sendSystemReply).toHaveBeenCalledOnce();
    resolveFirst?.({ state: "SUCCEEDED" });
    await secondStarted;

    expect(gateway.sendSystemReply).toHaveBeenCalledTimes(2);
    reporter.stop();
  });

  it("does not retry a failed stage but continues on a later distinct stage", async () => {
    vi.useFakeTimers();
    let listener: ((event: unknown) => void) | undefined;
    const gateway = {
      sendSystemReply: vi
        .fn()
        .mockRejectedValueOnce(new Error("secret gateway failure"))
        .mockResolvedValue({ state: "SUCCEEDED" as const }),
    };
    const reporter = startProgressReporter({
      taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      source: persistedSource(
        () => ({ kind: "PERSISTED_STAGE", stage: "RUNNING" }),
        (next) => {
          listener = next;
          return vi.fn();
        },
      ),
      gateway,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.resolve();

    listener?.({ kind: "PERSISTED_STAGE", stage: "RUNNING" });
    listener?.({ kind: "PERSISTED_STAGE", stage: "VERIFYING" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(gateway.sendSystemReply).toHaveBeenCalledTimes(2);
    expect(gateway.sendSystemReply.mock.calls[1]?.[1]).toEqual({
      type: "text",
      value: "正在核对处理结果。",
    });
    reporter.stop();
  });

  it("never reads a secret-bearing getter on non-persisted events", async () => {
    vi.useFakeTimers();
    let listener: ((event: unknown) => void) | undefined;
    const gateway = {
      sendSystemReply: vi.fn(async () => ({ state: "SUCCEEDED" as const })),
    };
    const reporter = startProgressReporter({
      taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      source: persistedSource(
        () => ({ kind: "PERSISTED_STAGE", stage: "RUNNING" }),
        (next) => {
          listener = next;
          return vi.fn();
        },
      ),
      gateway,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    gateway.sendSystemReply.mockClear();
    const stage = vi.fn(() => {
      throw new Error("secret model output");
    });
    const event = { kind: "tool" };
    Object.defineProperty(event, "stage", { enumerable: true, get: stage });

    expect(() => listener?.(event)).not.toThrow();
    await Promise.resolve();

    expect(stage).not.toHaveBeenCalled();
    expect(gateway.sendSystemReply).not.toHaveBeenCalled();
    reporter.stop();
  });
});
