import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ASSISTANT_CHANNEL_ERROR,
  createAssistantChannel,
  type AssistantChannelDependencies,
  type RawEnvelope,
} from "../src/runtime/assistant-channel.js";
import {
  SYSTEM_REPLY_ERROR,
  cancellationText,
  progressText,
  taskAcceptedText,
} from "../src/runtime/system-reply.js";
import type { IngressDecision } from "../src/security/ingress-guard.js";

function envelope(text = "整理文件"): RawEnvelope {
  return {
    metadata: {
      appId: "cli_a",
      tenantKey: "tenant_a",
      eventType: "im.message.receive_v1",
      chatType: "p2p",
      senderOpenId: "ou_president",
      chatId: "oc_dm",
    },
    eventId: "evt_a",
    messageId: "msg_a",
    receivedAt: "2026-07-21T00:00:00.000Z",
    readText: () => text,
    readBody: () => ({ text }),
    readResources: () => [],
    readQuotedMessageCandidate: () => null,
  } as RawEnvelope;
}

function quotedCandidate(raw: RawEnvelope): unknown {
  return raw.readQuotedMessageCandidate();
}

function dependencies(
  overrides: Partial<AssistantChannelDependencies> = {},
): AssistantChannelDependencies {
  return {
    ingressGuard: () => ({ kind: "allow_task" }),
    pairingSink: { consume: vi.fn(async () => undefined) },
    confirmationSink: { consume: vi.fn(async () => undefined) },
    taskSink: {
      ingest: vi.fn(async () => ({ taskId: randomUUID(), duplicate: false })),
    },
    taskControlSink: {
      cancelActive: vi.fn(async () => ({
        controlEventId: "control-a",
        taskId: "task-a",
        cancelled: true,
        duplicate: false,
        externalEffectsPending: false,
      })),
    },
    normalizer: {
      toInboundEvent: () => ({
        appId: "cli_a",
        tenantKey: "tenant_a",
        eventId: "evt_a",
        messageId: "msg_a",
        senderOpenId: "ou_president",
        chatId: "oc_dm",
        chatType: "p2p",
        eventType: "im.message.receive_v1",
        receivedAt: "2026-07-21T00:00:00.000Z",
        payloadRef: `sha256:${"a".repeat(64)}`,
      }),
      toCancelActiveTaskRequest: () => ({
        appId: "cli_a",
        tenantKey: "tenant_a",
        eventId: "evt_a",
        messageId: "msg_a",
        senderOpenId: "ou_president",
        chatId: "oc_dm",
        receivedAt: "2026-07-21T00:00:00.000Z",
      }),
    },
    gateway: {
      sendSystemReply: vi.fn(async () => ({ state: "SUCCEEDED" as const })),
      sendControlReply: vi.fn(async () => ({ state: "SUCCEEDED" as const })),
    },
    scheduler: { wake: vi.fn() },
    ...overrides,
  };
}

describe("assistant channel", () => {
  it("persists before acknowledging and wakes only after a successful ACK", async () => {
    const order: string[] = [];
    const taskId = randomUUID();
    const scheduler = {
      wake: vi.fn(() => {
        order.push("wake");
      }),
    };
    const channel = createAssistantChannel({
      ingressGuard: () => ({ kind: "allow_task" }),
      pairingSink: { consume: vi.fn() },
      confirmationSink: { consume: vi.fn() },
      taskSink: {
        ingest: vi.fn(async () => {
          order.push("persist");
          return { taskId, duplicate: false };
        }),
      },
      taskControlSink: { cancelActive: vi.fn() },
      normalizer: {
        toInboundEvent: () => ({
          appId: "cli_a",
          tenantKey: "tenant_a",
          eventId: "evt_a",
          messageId: "msg_a",
          senderOpenId: "ou_president",
          chatId: "oc_dm",
          chatType: "p2p",
          eventType: "im.message.receive_v1",
          receivedAt: "2026-07-21T00:00:00.000Z",
          payloadRef: `sha256:${"a".repeat(64)}`,
        }),
        toCancelActiveTaskRequest: vi.fn(),
      },
      gateway: {
        sendSystemReply: vi.fn(async () => {
          order.push("ack");
          return { state: "SUCCEEDED" as const };
        }),
        sendControlReply: vi.fn(),
      },
      scheduler,
    });

    await channel.handle(envelope());

    expect(order).toEqual(["persist", "ack", "wake"]);
    expect(scheduler.wake).toHaveBeenCalledOnce();
  });

  it("exposes only fixed metadata to the guard and denies before opaque body access", async () => {
    const raw = envelope();
    const readBody = vi.fn(() => {
      throw new Error("secret body");
    });
    const readResources = vi.fn(() => {
      throw new Error("secret resources");
    });
    const readQuotedMessageCandidate = vi.fn(() => {
      throw new Error("secret quote candidate");
    });
    const guardedRaw: RawEnvelope = {
      ...raw,
      readBody,
      readResources,
      readQuotedMessageCandidate,
    };
    const ingressGuard = vi.fn((metadata) => {
      expect(Object.keys(metadata).sort()).toEqual(
        [
          "appId",
          "chatId",
          "chatType",
          "eventType",
          "senderOpenId",
          "tenantKey",
        ].sort(),
      );
      expect("readBody" in metadata).toBe(false);
      expect("readResources" in metadata).toBe(false);
      return { kind: "deny", reason: "event_disabled" } as const;
    });
    const deps = dependencies({ ingressGuard });

    await createAssistantChannel(deps).handle(guardedRaw);

    expect(ingressGuard).toHaveBeenCalledWith(guardedRaw.metadata);
    expect(readBody).not.toHaveBeenCalled();
    expect(readResources).not.toHaveBeenCalled();
    expect(readQuotedMessageCandidate).not.toHaveBeenCalled();
    expect(deps.taskSink.ingest).not.toHaveBeenCalled();
    expect(deps.gateway.sendSystemReply).not.toHaveBeenCalled();
    expect(deps.scheduler.wake).not.toHaveBeenCalled();
  });

  it("replaces a guard exception with a fixed error and performs no later effects", async () => {
    const deps = dependencies({
      ingressGuard: () => {
        throw new Error("secret guard detail");
      },
    });

    await expect(
      createAssistantChannel(deps).handle(envelope()),
    ).rejects.toThrow(ASSISTANT_CHANNEL_ERROR.INGRESS_GUARD_FAILED);
    await expect(
      createAssistantChannel(deps).handle(envelope()),
    ).rejects.not.toThrow(/secret guard detail/);
    expect(deps.taskSink.ingest).not.toHaveBeenCalled();
    expect(deps.gateway.sendSystemReply).not.toHaveBeenCalled();
    expect(deps.scheduler.wake).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed task sink result", async () => {
    const deps = dependencies({
      taskSink: {
        ingest: vi.fn(async () => ({
          taskId: randomUUID(),
          duplicate: false,
          unexpected: "secret",
        })) as AssistantChannelDependencies["taskSink"]["ingest"],
      },
    });

    await expect(
      createAssistantChannel(deps).handle(envelope()),
    ).rejects.toThrow(ASSISTANT_CHANNEL_ERROR.TASK_INGEST_FAILED);
    expect(deps.gateway.sendSystemReply).not.toHaveBeenCalled();
    expect(deps.scheduler.wake).not.toHaveBeenCalled();
  });

  it("fails closed when a task result getter throws without exposing its message", async () => {
    const result = { taskId: randomUUID() } as {
      taskId: string;
      duplicate: boolean;
    };
    Object.defineProperty(result, "duplicate", {
      enumerable: true,
      get() {
        throw new Error("secret task result");
      },
    });
    const deps = dependencies({
      taskSink: { ingest: vi.fn(async () => result) },
    });

    const promise = createAssistantChannel(deps).handle(envelope());
    await expect(promise).rejects.toThrow(
      ASSISTANT_CHANNEL_ERROR.TASK_INGEST_FAILED,
    );
    await expect(promise).rejects.not.toThrow(/secret task result/);
    expect(deps.gateway.sendSystemReply).not.toHaveBeenCalled();
    expect(deps.scheduler.wake).not.toHaveBeenCalled();
  });

  it("treats an ACK result with unknown fields as a fixed failure", async () => {
    const deps = dependencies({
      gateway: {
        sendSystemReply: vi.fn(async () => ({
          state: "SUCCEEDED" as const,
          unexpected: "secret",
        })),
        sendControlReply: vi.fn(),
      },
    });

    await expect(
      createAssistantChannel(deps).handle(envelope()),
    ).rejects.toThrow(SYSTEM_REPLY_ERROR.TASK_ACK_FAILED);
    expect(deps.scheduler.wake).not.toHaveBeenCalled();
  });

  it("keeps every fixed reply body immutable", () => {
    expect(Object.isFrozen(taskAcceptedText())).toBe(true);
    expect(Object.isFrozen(cancellationText("NOT_RUNNING"))).toBe(true);
    expect(Object.isFrozen(progressText("RUNNING"))).toBe(true);
  });

  const nonTaskRoutes: ReadonlyArray<
    readonly [string, IngressDecision, "none" | "pairing" | "card"]
  > = [
    ["deny", { kind: "deny", reason: "event_disabled" } as const, "none"],
    ["pairing", { kind: "allow_pairing" } as const, "pairing"],
    [
      "card",
      {
        kind: "allow_card",
        nonce: "nonce-a",
        payloadHash: `sha256:${"c".repeat(64)}` as const,
      },
      "card",
    ],
  ];

  it.each(nonTaskRoutes)(
    "routes %s without entering task or control paths",
    async (_name, decision, route) => {
      const readText = vi.fn(() => "取消这个任务");
      const readBody = vi.fn(() => ({ secret: true }));
      const readResources = vi.fn(() => ["secret"]);
      const raw = { ...envelope(), readText, readBody, readResources };
      const deps = dependencies({ ingressGuard: () => decision });

      await createAssistantChannel(deps).handle(raw);

      expect(deps.pairingSink.consume).toHaveBeenCalledTimes(
        route === "pairing" ? 1 : 0,
      );
      expect(deps.confirmationSink.consume).toHaveBeenCalledTimes(
        route === "card" ? 1 : 0,
      );
      expect(deps.taskControlSink.cancelActive).not.toHaveBeenCalled();
      expect(deps.taskSink.ingest).not.toHaveBeenCalled();
      expect(deps.gateway.sendSystemReply).not.toHaveBeenCalled();
      expect(deps.gateway.sendControlReply).not.toHaveBeenCalled();
      expect(deps.scheduler.wake).not.toHaveBeenCalled();
      expect(readText).not.toHaveBeenCalled();
      expect(readBody).not.toHaveBeenCalled();
      expect(readResources).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["pairing", { kind: "allow_pairing" } as const],
    [
      "card",
      {
        kind: "allow_card",
        nonce: "nonce-a",
        payloadHash: `sha256:${"c".repeat(64)}` as const,
      },
    ],
  ] as const)(
    "gives the %s route an empty task-resource view even when the raw envelope is forged",
    async (route, decision) => {
      const readResources = vi.fn(() => {
        throw new Error("forged resources must stay unread");
      });
      const readQuotedMessageCandidate = vi.fn(() => {
        throw new Error("forged quote must stay unread");
      });
      const raw = {
        ...envelope(),
        readResources,
        readQuotedMessageCandidate,
      } as RawEnvelope;
      const inspect = vi.fn(async (stableRaw: RawEnvelope) => {
        expect(stableRaw.readResources()).toEqual([]);
        expect(quotedCandidate(stableRaw)).toBeNull();
      });
      const deps = dependencies({
        ingressGuard: () => decision,
        pairingSink: { consume: route === "pairing" ? inspect : vi.fn() },
        confirmationSink: {
          consume:
            route === "card"
              ? vi.fn(async (stableRaw) => inspect(stableRaw))
              : vi.fn(),
        },
      });

      await createAssistantChannel(deps).handle(raw);

      expect(inspect).toHaveBeenCalledOnce();
      expect(readResources).not.toHaveBeenCalled();
      expect(readQuotedMessageCandidate).not.toHaveBeenCalled();
      expect(deps.taskSink.ingest).not.toHaveBeenCalled();
    },
  );

  it("passes only the guard binding to confirmation and freezes it", async () => {
    const deps = dependencies({
      ingressGuard: () => ({
        kind: "allow_card",
        nonce: "nonce-a",
        payloadHash: `sha256:${"d".repeat(64)}`,
      }),
    });
    const raw = envelope();

    await createAssistantChannel(deps).handle(raw);

    const [stableRaw, binding] = vi.mocked(deps.confirmationSink.consume).mock
      .calls[0] ?? [undefined, undefined];
    expect(stableRaw).not.toBe(raw);
    expect(stableRaw).toMatchObject({
      eventId: raw.eventId,
      messageId: raw.messageId,
      receivedAt: raw.receivedAt,
      metadata: raw.metadata,
    });
    expect(binding).toEqual({
      nonce: "nonce-a",
      payloadHash: `sha256:${"d".repeat(64)}`,
    });
    expect(Object.isFrozen(stableRaw)).toBe(true);
    expect(Object.isFrozen(stableRaw?.metadata)).toBe(true);
    expect(Object.isFrozen(binding)).toBe(true);
  });

  it("turns task sink rejection into a fixed error before ACK and wake", async () => {
    const deps = dependencies({
      taskSink: {
        ingest: vi.fn(async () => {
          throw new Error("secret database error");
        }),
      },
    });

    const promise = createAssistantChannel(deps).handle(envelope());
    await expect(promise).rejects.toThrow(
      ASSISTANT_CHANNEL_ERROR.TASK_INGEST_FAILED,
    );
    await expect(promise).rejects.not.toThrow(/secret database error/);
    expect(deps.gateway.sendSystemReply).not.toHaveBeenCalled();
    expect(deps.scheduler.wake).not.toHaveBeenCalled();
  });

  it("does not ACK or wake a duplicate task", async () => {
    const deps = dependencies({
      taskSink: {
        ingest: vi.fn(async () => ({ taskId: randomUUID(), duplicate: true })),
      },
    });

    await createAssistantChannel(deps).handle(envelope());

    expect(deps.gateway.sendSystemReply).not.toHaveBeenCalled();
    expect(deps.scheduler.wake).not.toHaveBeenCalled();
  });

  it.each(["FAILED", "UNKNOWN"] as const)(
    "does not wake when ACK returns %s",
    async (state) => {
      const deps = dependencies({
        gateway: {
          sendSystemReply: vi.fn(async () => ({ state })),
          sendControlReply: vi.fn(),
        },
      });

      await expect(
        createAssistantChannel(deps).handle(envelope()),
      ).rejects.toThrow(SYSTEM_REPLY_ERROR.TASK_ACK_FAILED);
      expect(deps.taskSink.ingest).toHaveBeenCalledOnce();
      expect(deps.scheduler.wake).not.toHaveBeenCalled();
    },
  );

  it("does not wake when ACK rejects and hides the rejection detail", async () => {
    const deps = dependencies({
      gateway: {
        sendSystemReply: vi.fn(async () => {
          throw new Error("secret remote error");
        }),
        sendControlReply: vi.fn(),
      },
    });

    const promise = createAssistantChannel(deps).handle(envelope());
    await expect(promise).rejects.toThrow(SYSTEM_REPLY_ERROR.TASK_ACK_FAILED);
    await expect(promise).rejects.not.toThrow(/secret remote error/);
    expect(deps.taskSink.ingest).toHaveBeenCalledOnce();
    expect(deps.scheduler.wake).not.toHaveBeenCalled();
  });

  it.each(["停一下", "停止当前任务", "取消这个任务", "  停一下  "])(
    "classifies exact normalized cancellation %s before body and new-task normalization",
    async (text) => {
      const order: string[] = [];
      const raw: RawEnvelope = {
        ...envelope(text),
        readText: vi.fn(() => {
          order.push("classify");
          return text;
        }),
        readBody: vi.fn(() => {
          throw new Error("body must not be read");
        }),
        readResources: vi.fn(() => {
          throw new Error("resources must not be read");
        }),
      };
      const deps = dependencies({
        taskControlSink: {
          cancelActive: vi.fn(async () => {
            order.push("cancel");
            return {
              controlEventId: "control-a",
              taskId: "task-a",
              cancelled: true,
              duplicate: false,
              externalEffectsPending: false,
            };
          }),
        },
        normalizer: {
          ...dependencies().normalizer,
          toCancelActiveTaskRequest: (value) => {
            order.push("normalize-control");
            return dependencies().normalizer.toCancelActiveTaskRequest(value);
          },
          toInboundEvent: vi.fn(() => {
            throw new Error("new task normalizer must not run");
          }),
        },
        gateway: {
          sendSystemReply: vi.fn(),
          sendControlReply: vi.fn(async () => {
            order.push("reply");
            return { state: "SUCCEEDED" as const };
          }),
        },
      });

      await createAssistantChannel(deps).handle(raw);

      expect(order).toEqual([
        "classify",
        "normalize-control",
        "cancel",
        "reply",
      ]);
      expect(raw.readBody).not.toHaveBeenCalled();
      expect(raw.readResources).not.toHaveBeenCalled();
      expect(deps.normalizer.toInboundEvent).not.toHaveBeenCalled();
      expect(deps.taskSink.ingest).not.toHaveBeenCalled();
      expect(deps.scheduler.wake).not.toHaveBeenCalled();
    },
  );

  it("gives cancellation normalization an empty task-resource view", async () => {
    const readResources = vi.fn(() => {
      throw new Error("cancel must not read task resources");
    });
    const readQuotedMessageCandidate = vi.fn(() => {
      throw new Error("cancel must not read quote candidate");
    });
    const raw = {
      ...envelope("停一下"),
      readResources,
      readQuotedMessageCandidate,
    } as RawEnvelope;
    const baseNormalizer = dependencies().normalizer;
    const deps = dependencies({
      normalizer: {
        ...baseNormalizer,
        toCancelActiveTaskRequest: vi.fn((stableRaw) => {
          expect(stableRaw.readResources()).toEqual([]);
          expect(quotedCandidate(stableRaw)).toBeNull();
          return baseNormalizer.toCancelActiveTaskRequest(stableRaw);
        }),
      },
    });

    await createAssistantChannel(deps).handle(raw);

    expect(readResources).not.toHaveBeenCalled();
    expect(readQuotedMessageCandidate).not.toHaveBeenCalled();
    expect(deps.taskSink.ingest).not.toHaveBeenCalled();
  });

  it.each(["请停一下", "停一下！", "停止 当前任务", "取消这个任务。"])(
    "does not fuzzy-match cancellation text %s",
    async (text) => {
      const deps = dependencies();

      await createAssistantChannel(deps).handle(envelope(text));

      expect(deps.taskControlSink.cancelActive).not.toHaveBeenCalled();
      expect(deps.taskSink.ingest).toHaveBeenCalledOnce();
      expect(deps.gateway.sendSystemReply).toHaveBeenCalledOnce();
      expect(deps.scheduler.wake).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [false, false, "当前没有运行中的任务。"],
    [true, false, "已停止当前任务，没有待执行的外部动作。"],
    [true, true, "已停止当前任务；已有外部动作正在核对，我会只报告事实。"],
  ] as const)(
    "uses fixed cancellation truth for cancelled=%s pending=%s",
    async (cancelled, externalEffectsPending, expected) => {
      const deps = dependencies({
        taskControlSink: {
          cancelActive: vi.fn(async () => ({
            controlEventId: "control-a",
            taskId: cancelled ? "task-a" : null,
            cancelled,
            duplicate: false,
            externalEffectsPending,
          })),
        },
      });

      await createAssistantChannel(deps).handle(envelope("停一下"));

      expect(deps.gateway.sendControlReply).toHaveBeenCalledWith("control-a", {
        type: "text",
        value: expected,
      });
      expect(deps.taskSink.ingest).not.toHaveBeenCalled();
      expect(deps.scheduler.wake).not.toHaveBeenCalled();
    },
  );

  it("does not repeat a duplicate cancellation reply", async () => {
    const deps = dependencies({
      taskControlSink: {
        cancelActive: vi.fn(async () => ({
          controlEventId: "control-a",
          taskId: "task-a",
          cancelled: true,
          duplicate: true,
          externalEffectsPending: false,
        })),
      },
    });

    await createAssistantChannel(deps).handle(envelope("停一下"));

    expect(deps.gateway.sendControlReply).not.toHaveBeenCalled();
    expect(deps.taskSink.ingest).not.toHaveBeenCalled();
    expect(deps.scheduler.wake).not.toHaveBeenCalled();
  });

  it("stops after cancellation sink failure without task, reply or wake", async () => {
    const deps = dependencies({
      taskControlSink: {
        cancelActive: vi.fn(async () => {
          throw new Error("secret cancellation failure");
        }),
      },
    });

    const promise = createAssistantChannel(deps).handle(envelope("停一下"));
    await expect(promise).rejects.toThrow(
      ASSISTANT_CHANNEL_ERROR.CANCEL_SINK_FAILED,
    );
    await expect(promise).rejects.not.toThrow(/secret cancellation failure/);
    expect(deps.gateway.sendControlReply).not.toHaveBeenCalled();
    expect(deps.taskSink.ingest).not.toHaveBeenCalled();
    expect(deps.scheduler.wake).not.toHaveBeenCalled();
  });

  it("stops after a failed control reply without creating a task", async () => {
    const deps = dependencies({
      gateway: {
        sendSystemReply: vi.fn(),
        sendControlReply: vi.fn(async () => ({ state: "UNKNOWN" as const })),
      },
    });

    await expect(
      createAssistantChannel(deps).handle(envelope("取消这个任务")),
    ).rejects.toThrow(SYSTEM_REPLY_ERROR.CONTROL_REPLY_FAILED);
    expect(deps.taskSink.ingest).not.toHaveBeenCalled();
    expect(deps.scheduler.wake).not.toHaveBeenCalled();
  });

  it("fails closed on malformed cancellation normalization and sink results", async () => {
    const malformedRequestDeps = dependencies({
      normalizer: {
        ...dependencies().normalizer,
        toCancelActiveTaskRequest: vi.fn(() => ({
          appId: "cli_a",
        })) as unknown as AssistantChannelDependencies["normalizer"]["toCancelActiveTaskRequest"],
      },
    });
    await expect(
      createAssistantChannel(malformedRequestDeps).handle(envelope("停一下")),
    ).rejects.toThrow(ASSISTANT_CHANNEL_ERROR.CANCEL_NORMALIZATION_FAILED);
    expect(
      malformedRequestDeps.taskControlSink.cancelActive,
    ).not.toHaveBeenCalled();

    const malformedResultDeps = dependencies({
      taskControlSink: {
        cancelActive: vi.fn(async () => ({
          controlEventId: "control-a",
          taskId: "task-a",
          cancelled: true,
          duplicate: false,
          externalEffectsPending: false,
          secret: "unexpected",
        })) as AssistantChannelDependencies["taskControlSink"]["cancelActive"],
      },
    });
    await expect(
      createAssistantChannel(malformedResultDeps).handle(envelope("停一下")),
    ).rejects.toThrow(ASSISTANT_CHANNEL_ERROR.CANCEL_SINK_FAILED);
    expect(malformedResultDeps.gateway.sendControlReply).not.toHaveBeenCalled();
    expect(malformedResultDeps.taskSink.ingest).not.toHaveBeenCalled();
  });

  it("fails closed on unknown metadata and malformed guard decisions", async () => {
    const unknownMetadata = {
      ...envelope(),
      metadata: { ...envelope().metadata, unknown: "secret" },
    } as RawEnvelope;
    const metadataGuard = vi.fn(() => ({ kind: "allow_task" as const }));
    const metadataDeps = dependencies({ ingressGuard: metadataGuard });
    await expect(
      createAssistantChannel(metadataDeps).handle(unknownMetadata),
    ).rejects.toThrow(ASSISTANT_CHANNEL_ERROR.INGRESS_GUARD_FAILED);
    expect(metadataGuard).not.toHaveBeenCalled();

    const decisionDeps = dependencies({
      ingressGuard: vi.fn(() => ({
        kind: "allow_task",
        unexpected: "secret",
      })) as AssistantChannelDependencies["ingressGuard"],
    });
    await expect(
      createAssistantChannel(decisionDeps).handle(envelope()),
    ).rejects.toThrow(ASSISTANT_CHANNEL_ERROR.INGRESS_GUARD_FAILED);
    expect(decisionDeps.taskSink.ingest).not.toHaveBeenCalled();
  });

  it("snapshots every card decision field exactly once before routing", async () => {
    const reads: Record<string, number> = {};
    const decision = {};
    for (const [key, value] of [
      ["kind", "allow_card"],
      ["nonce", "nonce-a"],
      ["payloadHash", `sha256:${"d".repeat(64)}`],
    ] as const) {
      Object.defineProperty(decision, key, {
        enumerable: true,
        get() {
          reads[key] = (reads[key] ?? 0) + 1;
          if (reads[key] !== 1) throw new Error(`secret repeated ${key}`);
          return value;
        },
      });
    }
    const deps = dependencies({
      ingressGuard: () => decision as IngressDecision,
    });

    await createAssistantChannel(deps).handle(envelope());

    expect(reads).toEqual({ kind: 1, nonce: 1, payloadHash: 1 });
    expect(deps.confirmationSink.consume).toHaveBeenCalledWith(
      expect.anything(),
      {
        nonce: "nonce-a",
        payloadHash: `sha256:${"d".repeat(64)}`,
      },
    );
  });

  it("snapshots task acceptance and successful gateway results exactly once", async () => {
    const taskId = randomUUID();
    const reads: Record<string, number> = {};
    const once = (key: string, value: unknown): PropertyDescriptor => ({
      enumerable: true,
      get() {
        reads[key] = (reads[key] ?? 0) + 1;
        if (reads[key] !== 1) throw new Error(`secret repeated ${key}`);
        return value;
      },
    });
    const acceptance = Object.defineProperties(
      {},
      {
        taskId: once("taskId", taskId),
        duplicate: once("duplicate", false),
      },
    );
    const actionResult = Object.defineProperties(
      {},
      {
        state: once("state", "SUCCEEDED"),
      },
    );
    const deps = dependencies({
      taskSink: {
        ingest: vi.fn(
          async () => acceptance,
        ) as unknown as AssistantChannelDependencies["taskSink"]["ingest"],
      },
      gateway: {
        sendSystemReply: vi.fn(
          async () => actionResult,
        ) as unknown as AssistantChannelDependencies["gateway"]["sendSystemReply"],
        sendControlReply: vi.fn(),
      },
    });

    await createAssistantChannel(deps).handle(envelope());

    expect(reads).toEqual({ taskId: 1, duplicate: 1, state: 1 });
    expect(deps.scheduler.wake).toHaveBeenCalledOnce();
  });

  it("snapshots cancellation requests and results exactly once", async () => {
    const reads: Record<string, number> = {};
    const once = (key: string, value: unknown): PropertyDescriptor => ({
      enumerable: true,
      get() {
        reads[key] = (reads[key] ?? 0) + 1;
        if (reads[key] !== 1) throw new Error(`secret repeated ${key}`);
        return value;
      },
    });
    const request = Object.defineProperties(
      {},
      {
        appId: once("request.appId", "cli_a"),
        tenantKey: once("request.tenantKey", "tenant_a"),
        eventId: once("request.eventId", "evt_a"),
        messageId: once("request.messageId", "msg_a"),
        senderOpenId: once("request.senderOpenId", "ou_president"),
        chatId: once("request.chatId", "oc_dm"),
        receivedAt: once("request.receivedAt", "2026-07-21T00:00:00.000Z"),
      },
    );
    const result = Object.defineProperties(
      {},
      {
        controlEventId: once("result.controlEventId", "control-a"),
        taskId: once("result.taskId", "task-a"),
        cancelled: once("result.cancelled", true),
        duplicate: once("result.duplicate", false),
        externalEffectsPending: once("result.externalEffectsPending", false),
      },
    );
    const deps = dependencies({
      normalizer: {
        ...dependencies().normalizer,
        toCancelActiveTaskRequest: vi.fn(
          () => request,
        ) as unknown as AssistantChannelDependencies["normalizer"]["toCancelActiveTaskRequest"],
      },
      taskControlSink: {
        cancelActive: vi.fn(
          async () => result,
        ) as unknown as AssistantChannelDependencies["taskControlSink"]["cancelActive"],
      },
    });

    await createAssistantChannel(deps).handle(envelope("停一下"));

    expect(Object.values(reads).every((count) => count === 1)).toBe(true);
    expect(deps.gateway.sendControlReply).toHaveBeenCalledOnce();
  });

  it("shares one lazy text read between guard and pairing sink", async () => {
    const readText = vi
      .fn<() => unknown>()
      .mockReturnValueOnce("pair-code")
      .mockImplementation(() => {
        throw new Error("secret second text read");
      });
    const raw = { ...envelope(), readText };
    Object.defineProperty(raw.metadata, "text", {
      enumerable: true,
      get: readText,
    });
    const deps = dependencies({
      ingressGuard: (metadata) => {
        expect(metadata.text).toBe("pair-code");
        return { kind: "allow_pairing" };
      },
      pairingSink: {
        consume: vi.fn(async (stableRaw) => {
          expect(stableRaw.readText()).toBe("pair-code");
        }),
      },
    });

    await createAssistantChannel(deps).handle(raw);

    expect(readText).toHaveBeenCalledOnce();
  });

  it("shares one lazy text/body/resource projection through classification and normalization", async () => {
    const readText = vi
      .fn<() => unknown>()
      .mockReturnValueOnce("整理文件")
      .mockImplementation(() => {
        throw new Error("secret second text read");
      });
    const body = Object.freeze({ text: "整理文件" });
    const resources = Object.freeze(["resource-a"]);
    const readBody = vi
      .fn<() => unknown>()
      .mockReturnValueOnce(body)
      .mockImplementation(() => {
        throw new Error("secret second body read");
      });
    const readResources = vi
      .fn<() => unknown>()
      .mockReturnValueOnce(resources)
      .mockImplementation(() => {
        throw new Error("secret second resources read");
      });
    const candidate = Object.freeze({ parentId: "om_parent" });
    const readQuotedMessageCandidate = vi
      .fn<() => unknown>()
      .mockReturnValueOnce(candidate)
      .mockImplementation(() => {
        throw new Error("secret second quote read");
      });
    const raw = {
      ...envelope(),
      readText,
      readBody,
      readResources,
      readQuotedMessageCandidate,
    } as RawEnvelope;
    Object.defineProperty(raw.metadata, "text", {
      enumerable: true,
      get: readText,
    });
    const deps = dependencies({
      ingressGuard: (metadata) => {
        expect(metadata.text).toBe("整理文件");
        return { kind: "allow_task" };
      },
      normalizer: {
        ...dependencies().normalizer,
        toInboundEvent: vi.fn((stableRaw) => {
          expect(stableRaw.readText()).toBe("整理文件");
          expect(stableRaw.readBody()).toBe(body);
          expect(stableRaw.readBody()).toBe(body);
          expect(stableRaw.readResources()).toBe(resources);
          expect(stableRaw.readResources()).toBe(resources);
          expect(quotedCandidate(stableRaw)).toBe(candidate);
          expect(quotedCandidate(stableRaw)).toBe(candidate);
          return dependencies().normalizer.toInboundEvent(stableRaw);
        }),
      },
    });

    await createAssistantChannel(deps).handle(raw);

    expect(readText).toHaveBeenCalledOnce();
    expect(readBody).toHaveBeenCalledOnce();
    expect(readResources).toHaveBeenCalledOnce();
    expect(readQuotedMessageCandidate).toHaveBeenCalledOnce();
  });

  it("keeps identical normalized resource descriptors on duplicate inbound without a second acknowledgement or wake", async () => {
    const descriptors = Object.freeze([
      Object.freeze({
        sourceKind: "current",
        messageId: "msg_a",
        kind: "file",
        fileKey: "file_v3_a",
        displayName: "经营报告.pdf",
      }),
    ]);
    const candidate = Object.freeze({ parentId: "om_parent" });
    const raw = {
      ...envelope(),
      readResources: vi.fn(() => descriptors),
      readQuotedMessageCandidate: vi.fn(() => candidate),
    } as RawEnvelope;
    const observed: unknown[] = [];
    const baseNormalizer = dependencies().normalizer;
    const firstTaskId = randomUUID();
    const deps = dependencies({
      normalizer: {
        ...baseNormalizer,
        toInboundEvent: vi.fn((stableRaw) => {
          observed.push(
            Object.freeze({
              resources: stableRaw.readResources(),
              candidate: quotedCandidate(stableRaw),
            }),
          );
          return baseNormalizer.toInboundEvent(stableRaw);
        }),
      },
      taskSink: {
        ingest: vi
          .fn()
          .mockResolvedValueOnce({ taskId: firstTaskId, duplicate: false })
          .mockResolvedValueOnce({ taskId: firstTaskId, duplicate: true }),
      },
    });

    await createAssistantChannel(deps).handle(raw);
    await createAssistantChannel(deps).handle(raw);

    expect(observed).toEqual([
      { resources: descriptors, candidate },
      { resources: descriptors, candidate },
    ]);
    expect(deps.taskSink.ingest).toHaveBeenCalledTimes(2);
    expect(deps.gateway.sendSystemReply).toHaveBeenCalledOnce();
    expect(deps.scheduler.wake).toHaveBeenCalledOnce();
  });

  it("uses the same cached text for guard and exact cancellation", async () => {
    const readText = vi
      .fn<() => unknown>()
      .mockReturnValueOnce("取消这个任务")
      .mockReturnValue("整理文件");
    const raw = { ...envelope(), readText };
    Object.defineProperty(raw.metadata, "text", {
      enumerable: true,
      get: readText,
    });
    const deps = dependencies({
      ingressGuard: (metadata) => {
        expect(metadata.text).toBe("取消这个任务");
        return { kind: "allow_task" };
      },
    });

    await createAssistantChannel(deps).handle(raw);

    expect(readText).toHaveBeenCalledOnce();
    expect(deps.taskControlSink.cancelActive).toHaveBeenCalledOnce();
    expect(deps.taskSink.ingest).not.toHaveBeenCalled();
  });

  it("awaits asynchronous scheduler failure and replaces it with a fixed error", async () => {
    const deps = dependencies({
      scheduler: {
        wake: vi.fn(async () => {
          throw new Error("secret async scheduler failure");
        }),
      },
    });

    const promise = createAssistantChannel(deps).handle(envelope());

    await expect(promise).rejects.toThrow(
      ASSISTANT_CHANNEL_ERROR.SCHEDULER_WAKE_FAILED,
    );
    await expect(promise).rejects.not.toThrow(/secret async scheduler failure/);
  });
});
