import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  ASSISTANT_RUNTIME_PORTS_REQUIRED,
  startChannel,
  type LifecycleState,
  type SdkCardActionEvent,
  type SdkIngressSource,
  type SdkMessageEvent,
  type StartChannelDeps,
  type TrustedCardEvidence,
} from "../src/bot/channel.js";
import type { AssistantChannelDependencies } from "../src/runtime/assistant-channel.js";
import { decideIngress } from "../src/security/ingress-guard.js";
import type { AccessPolicy } from "../src/security/policy.js";

const APP_ID = "cli_a";
const TENANT_KEY = "tenant_a";
const PRESIDENT_OPEN_ID = "ou_president";
const PRESIDENT_CHAT_ID = "oc_dm";
const CREATED_AT_MS = Date.parse("2026-07-21T00:00:00.000Z");
const CARD_ACTION_HASH =
  "sha256:b2131b4cba33c3e696b4f6352fd928f7c7c68358ae291d069c18e5d68878ba63" as const;

const policy: AccessPolicy = {
  appId: APP_ID,
  tenantKey: TENANT_KEY,
  presidentOpenId: PRESIDENT_OPEN_ID,
  presidentChatId: PRESIDENT_CHAT_ID,
  pairing: { active: false, codeHash: null },
};

interface SourceHarness {
  source: SdkIngressSource;
  message: (event: SdkMessageEvent) => Promise<void>;
  cardAction: (event: SdkCardActionEvent) => Promise<void>;
  lifecycle: (state: LifecycleState, detail?: unknown) => void;
  registrations: string[];
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function sourceHarness(): SourceHarness {
  let messageHandler: ((event: SdkMessageEvent) => Promise<void>) | undefined;
  let cardHandler: ((event: SdkCardActionEvent) => Promise<void>) | undefined;
  let lifecycleHandler:
    | ((state: LifecycleState, detail?: unknown) => void)
    | undefined;
  const registrations: string[] = [];
  const connect = vi.fn(async () => undefined);
  const disconnect = vi.fn(async () => undefined);
  const source: SdkIngressSource = {
    onMessage(handler) {
      registrations.push("message");
      messageHandler = handler;
    },
    onCardAction(handler) {
      registrations.push("cardAction");
      cardHandler = handler;
    },
    onLifecycle(handler) {
      registrations.push("lifecycle");
      lifecycleHandler = handler;
    },
    connect,
    disconnect,
  };
  return {
    source,
    message: async (event) => {
      if (!messageHandler) throw new Error("message handler missing");
      await messageHandler(event);
    },
    cardAction: async (event) => {
      if (!cardHandler) throw new Error("card handler missing");
      await cardHandler(event);
    },
    lifecycle: (state, detail) => {
      if (!lifecycleHandler) throw new Error("lifecycle handler missing");
      lifecycleHandler(state, detail);
    },
    registrations,
    connect,
    disconnect,
  };
}

function runtime(): AssistantChannelDependencies {
  return {
    ingressGuard: (metadata) => decideIngress(metadata, policy),
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
      toInboundEvent: (raw) => {
        raw.readBody();
        raw.readResources();
        return {
          appId: APP_ID,
          tenantKey: TENANT_KEY,
          eventId: raw.eventId,
          messageId: raw.messageId,
          senderOpenId: raw.metadata.senderOpenId,
          chatId: raw.metadata.chatId,
          chatType: "p2p",
          eventType: "im.message.receive_v1",
          receivedAt: raw.receivedAt,
          payloadRef: `sha256:${"a".repeat(64)}`,
        };
      },
      toCancelActiveTaskRequest: (raw) => ({
        appId: APP_ID,
        tenantKey: TENANT_KEY,
        eventId: raw.eventId,
        messageId: raw.messageId,
        senderOpenId: raw.metadata.senderOpenId,
        chatId: raw.metadata.chatId,
        receivedAt: raw.receivedAt,
      }),
    },
    gateway: {
      sendSystemReply: vi.fn(async () => ({ state: "SUCCEEDED" as const })),
      sendControlReply: vi.fn(async () => ({ state: "SUCCEEDED" as const })),
    },
    scheduler: { wake: vi.fn() },
  };
}

function messageEvent(
  overrides: Partial<SdkMessageEvent> = {},
): SdkMessageEvent {
  return {
    messageId: "msg_a",
    chatId: PRESIDENT_CHAT_ID,
    chatType: "p2p",
    senderId: PRESIDENT_OPEN_ID,
    createTime: CREATED_AT_MS,
    content: "整理文件",
    resources: [],
    raw: {
      header: {
        event_id: "evt_a",
        event_type: "im.message.receive_v1",
        app_id: APP_ID,
        tenant_key: TENANT_KEY,
      },
      event: {
        sender: { sender_id: { open_id: PRESIDENT_OPEN_ID } },
        message: {
          message_id: "msg_a",
          chat_id: PRESIDENT_CHAT_ID,
          chat_type: "p2p",
        },
      },
    },
    ...overrides,
  };
}

function cardEvent(
  overrides: Partial<SdkCardActionEvent> = {},
): SdkCardActionEvent {
  return {
    messageId: "card_msg_a",
    chatId: PRESIDENT_CHAT_ID,
    operator: { openId: PRESIDENT_OPEN_ID },
    action: { value: { action: "confirm" } },
    raw: { opaque: true },
    ...overrides,
  };
}

function startDependencies(
  harness: SourceHarness,
  assistantRuntime = runtime(),
): StartChannelDeps {
  return {
    appId: APP_ID,
    tenantKey: TENANT_KEY,
    runtime: assistantRuntime,
    sourceFactory: vi.fn(() => harness.source),
    cardEvidenceVerifier: { verify: vi.fn(async () => null) },
    lifecycleSink: { record: vi.fn() },
  };
}

describe("narrow SDK channel adapter", () => {
  const missingPortCases: ReadonlyArray<
    readonly [string, (deps: Record<string, unknown>) => void]
  > = [
    ["appId", (deps) => void (deps.appId = "")],
    ["tenantKey", (deps) => void (deps.tenantKey = 123)],
    ["sourceFactory", (deps) => void (deps.sourceFactory = undefined)],
    ["cardEvidenceVerifier", (deps) => void (deps.cardEvidenceVerifier = null)],
    [
      "card verifier function",
      (deps) => {
        (deps.cardEvidenceVerifier as { verify: unknown }).verify = "verify";
      },
    ],
    ["lifecycleSink", (deps) => void (deps.lifecycleSink = undefined)],
    [
      "lifecycle function",
      (deps) => {
        (deps.lifecycleSink as { record: unknown }).record = false;
      },
    ],
    [
      "ingressGuard",
      (deps) => {
        (deps.runtime as Record<string, unknown>).ingressGuard = undefined;
      },
    ],
    [
      "pairingSink",
      (deps) => {
        (deps.runtime as Record<string, unknown>).pairingSink = undefined;
      },
    ],
    [
      "pairing consume",
      (deps) => {
        const runtimePorts = deps.runtime as Record<string, unknown>;
        (runtimePorts.pairingSink as { consume: unknown }).consume = null;
      },
    ],
    [
      "confirmationSink",
      (deps) => {
        (deps.runtime as Record<string, unknown>).confirmationSink = "sink";
      },
    ],
    [
      "taskSink",
      (deps) => {
        (deps.runtime as Record<string, unknown>).taskSink = {};
      },
    ],
    [
      "taskControlSink",
      (deps) => {
        (deps.runtime as Record<string, unknown>).taskControlSink = undefined;
      },
    ],
    [
      "normalizer inbound",
      (deps) => {
        const runtimePorts = deps.runtime as Record<string, unknown>;
        (
          runtimePorts.normalizer as { toInboundEvent: unknown }
        ).toInboundEvent = 1;
      },
    ],
    [
      "normalizer cancel",
      (deps) => {
        const runtimePorts = deps.runtime as Record<string, unknown>;
        (
          runtimePorts.normalizer as { toCancelActiveTaskRequest: unknown }
        ).toCancelActiveTaskRequest = undefined;
      },
    ],
    [
      "gateway system reply",
      (deps) => {
        const runtimePorts = deps.runtime as Record<string, unknown>;
        (runtimePorts.gateway as { sendSystemReply: unknown }).sendSystemReply =
          undefined;
      },
    ],
    [
      "gateway control reply",
      (deps) => {
        const runtimePorts = deps.runtime as Record<string, unknown>;
        (
          runtimePorts.gateway as { sendControlReply: unknown }
        ).sendControlReply = "send";
      },
    ],
    [
      "scheduler wake",
      (deps) => {
        const runtimePorts = deps.runtime as Record<string, unknown>;
        (runtimePorts.scheduler as { wake: unknown }).wake = null;
      },
    ],
  ];

  it.each(missingPortCases)(
    "fails before the source factory for missing or malformed %s",
    async (_name, mutate) => {
      expect(ASSISTANT_RUNTIME_PORTS_REQUIRED).toBe(
        "ASSISTANT_RUNTIME_PORTS_REQUIRED",
      );
      const harness = sourceHarness();
      const deps = startDependencies(harness);
      const sourceFactory = deps.sourceFactory as ReturnType<typeof vi.fn>;
      mutate(deps as unknown as Record<string, unknown>);

      await expect(startChannel(deps)).rejects.toThrow(
        "ASSISTANT_RUNTIME_PORTS_REQUIRED",
      );
      expect(sourceFactory).not.toHaveBeenCalled();
      expect(harness.registrations).toEqual([]);
      expect(harness.connect).not.toHaveBeenCalled();
    },
  );

  it("registers only message, cardAction and fixed lifecycle handlers", async () => {
    const harness = sourceHarness();
    const bridge = await startChannel(startDependencies(harness));

    expect(harness.registrations).toEqual([
      "message",
      "cardAction",
      "lifecycle",
    ]);
    expect(harness.connect).toHaveBeenCalledOnce();
    expect(Object.keys(bridge)).toEqual(["disconnect"]);

    await bridge.disconnect();
    expect(harness.disconnect).toHaveBeenCalledOnce();
  });

  it("denies a group message without reading normalized content or resources", async () => {
    const harness = sourceHarness();
    const assistantRuntime = runtime();
    await startChannel(startDependencies(harness, assistantRuntime));
    const event = messageEvent({ chatId: "oc_group", chatType: "group" });
    const raw = event.raw as {
      event: { message: { chat_id: string; chat_type: string } };
    };
    raw.event.message.chat_id = "oc_group";
    raw.event.message.chat_type = "group";
    const content = vi.fn(() => {
      throw new Error("secret content");
    });
    const resources = vi.fn(() => {
      throw new Error("secret resources");
    });
    Object.defineProperty(event, "content", { enumerable: true, get: content });
    Object.defineProperty(event, "resources", {
      enumerable: true,
      get: resources,
    });

    await harness.message(event);

    expect(content).not.toHaveBeenCalled();
    expect(resources).not.toHaveBeenCalled();
    expect(assistantRuntime.taskSink.ingest).not.toHaveBeenCalled();
    expect(assistantRuntime.gateway.sendSystemReply).not.toHaveBeenCalled();
    expect(assistantRuntime.scheduler.wake).not.toHaveBeenCalled();
  });

  it("denies when raw sender open_id is missing or conflicts with normalized senderId", async () => {
    const harness = sourceHarness();
    const assistantRuntime = runtime();
    await startChannel(startDependencies(harness, assistantRuntime));
    const missing = messageEvent();
    const missingRaw = missing.raw as {
      event: { sender: { sender_id: Record<string, unknown> } };
    };
    missingRaw.event.sender.sender_id = {};
    const conflicting = messageEvent();
    const conflictingRaw = conflicting.raw as {
      event: { sender: { sender_id: { open_id: string } } };
    };
    conflictingRaw.event.sender.sender_id.open_id = "ou_other";

    await harness.message(missing);
    await harness.message(conflicting);

    expect(assistantRuntime.taskSink.ingest).not.toHaveBeenCalled();
    expect(assistantRuntime.gateway.sendSystemReply).not.toHaveBeenCalled();
  });

  it("fails closed on conflicting or malformed raw message headers", async () => {
    const harness = sourceHarness();
    const assistantRuntime = runtime();
    await startChannel(startDependencies(harness, assistantRuntime));
    const wrongApp = messageEvent();
    (wrongApp.raw as { header: { app_id: string } }).header.app_id =
      "cli_other";
    const wrongTenant = messageEvent();
    (wrongTenant.raw as { header: { tenant_key: string } }).header.tenant_key =
      "tenant_other";
    const wrongEventType = messageEvent();
    (
      wrongEventType.raw as { header: { event_type: string } }
    ).header.event_type = "im.message.reaction.created_v1";
    const missingEventId = messageEvent();
    (missingEventId.raw as { header: { event_id: unknown } }).header.event_id =
      undefined;
    const unknownHeader = messageEvent();
    (
      unknownHeader.raw as { header: Record<string, unknown> }
    ).header.unexpected = "secret";
    const throwingRaw = messageEvent();
    Object.defineProperty(throwingRaw, "raw", {
      enumerable: true,
      get() {
        throw new Error("secret raw body");
      },
    });

    for (const event of [
      wrongApp,
      wrongTenant,
      wrongEventType,
      missingEventId,
      unknownHeader,
      throwingRaw,
    ]) {
      await expect(harness.message(event)).resolves.toBeUndefined();
    }

    expect(assistantRuntime.taskSink.ingest).not.toHaveBeenCalled();
    expect(assistantRuntime.gateway.sendSystemReply).not.toHaveBeenCalled();
    expect(assistantRuntime.scheduler.wake).not.toHaveBeenCalled();
  });

  it("fails closed for a card without trusted evidence and never reads its action", async () => {
    const harness = sourceHarness();
    const assistantRuntime = runtime();
    const deps = startDependencies(harness, assistantRuntime);
    await startChannel(deps);
    const event = cardEvent();
    const action = vi.fn(() => {
      throw new Error("secret card body");
    });
    const raw = vi.fn(() => {
      throw new Error("secret raw card");
    });
    Object.defineProperty(event, "action", { enumerable: true, get: action });
    Object.defineProperty(event, "raw", { enumerable: true, get: raw });

    await harness.cardAction(event);

    expect(action).not.toHaveBeenCalled();
    expect(raw).not.toHaveBeenCalled();
    expect(deps.cardEvidenceVerifier.verify).toHaveBeenCalledOnce();
    const verifierInput = vi.mocked(deps.cardEvidenceVerifier.verify).mock
      .calls[0]?.[0];
    expect(verifierInput).toEqual({
      appId: APP_ID,
      tenantKey: TENANT_KEY,
      eventType: "card.action.trigger",
      messageId: "card_msg_a",
      chatId: PRESIDENT_CHAT_ID,
      senderOpenId: PRESIDENT_OPEN_ID,
    });
    expect(Object.keys(verifierInput ?? {}).sort()).toEqual(
      [
        "appId",
        "tenantKey",
        "eventType",
        "messageId",
        "chatId",
        "senderOpenId",
      ].sort(),
    );
    expect(Object.isFrozen(verifierInput)).toBe(true);
    expect(assistantRuntime.confirmationSink.consume).not.toHaveBeenCalled();
    expect(assistantRuntime.taskSink.ingest).not.toHaveBeenCalled();
    expect(assistantRuntime.gateway.sendSystemReply).not.toHaveBeenCalled();
  });

  it("rejects trusted evidence whose payload hash does not bind the card action", async () => {
    const harness = sourceHarness();
    const assistantRuntime = runtime();
    const evidence: TrustedCardEvidence = {
      appId: APP_ID,
      tenantKey: TENANT_KEY,
      eventId: "card_evt_a",
      messageId: "card_msg_a",
      senderOpenId: PRESIDENT_OPEN_ID,
      chatId: PRESIDENT_CHAT_ID,
      chatType: "p2p",
      signatureVerified: true,
      nonce: "nonce-a",
      payloadHash: `sha256:${"f".repeat(64)}`,
      receivedAt: "2026-07-21T00:00:00.000Z",
    };
    const deps = startDependencies(harness, assistantRuntime);
    deps.cardEvidenceVerifier.verify = vi.fn(async () => evidence);
    await startChannel(deps);

    await harness.cardAction(cardEvent());

    expect(assistantRuntime.confirmationSink.consume).not.toHaveBeenCalled();
    expect(assistantRuntime.taskSink.ingest).not.toHaveBeenCalled();
    expect(assistantRuntime.gateway.sendSystemReply).not.toHaveBeenCalled();
  });

  it("rejects a card action replaced while trusted evidence is being verified", async () => {
    const harness = sourceHarness();
    const assistantRuntime = runtime();
    let releaseVerifier: (() => void) | undefined;
    const verifierReleased = new Promise<void>((resolve) => {
      releaseVerifier = resolve;
    });
    let markVerifierEntered: (() => void) | undefined;
    const verifierEntered = new Promise<void>((resolve) => {
      markVerifierEntered = resolve;
    });
    const evidence: TrustedCardEvidence = {
      appId: APP_ID,
      tenantKey: TENANT_KEY,
      eventId: "card_evt_a",
      messageId: "card_msg_a",
      senderOpenId: PRESIDENT_OPEN_ID,
      chatId: PRESIDENT_CHAT_ID,
      chatType: "p2p",
      signatureVerified: true,
      nonce: "nonce-a",
      payloadHash: CARD_ACTION_HASH,
      receivedAt: "2026-07-21T00:00:00.000Z",
    };
    const deps = startDependencies(harness, assistantRuntime);
    deps.cardEvidenceVerifier.verify = vi.fn(async () => {
      markVerifierEntered?.();
      await verifierReleased;
      return evidence;
    });
    await startChannel(deps);
    const event = cardEvent();

    const handling = harness.cardAction(event);
    await verifierEntered;
    (event as { action: unknown }).action = {
      value: { action: "cancel" },
    };
    releaseVerifier?.();
    await handling;

    expect(assistantRuntime.confirmationSink.consume).not.toHaveBeenCalled();
    expect(assistantRuntime.taskSink.ingest).not.toHaveBeenCalled();
    expect(assistantRuntime.gateway.sendSystemReply).not.toHaveBeenCalled();
  });

  it("passes only a frozen binding from one trusted card evidence result", async () => {
    const harness = sourceHarness();
    const assistantRuntime = runtime();
    const evidence: TrustedCardEvidence = {
      appId: APP_ID,
      tenantKey: TENANT_KEY,
      eventId: "card_evt_a",
      messageId: "card_msg_a",
      senderOpenId: PRESIDENT_OPEN_ID,
      chatId: PRESIDENT_CHAT_ID,
      chatType: "p2p",
      signatureVerified: true,
      nonce: "nonce-a",
      payloadHash: CARD_ACTION_HASH,
      receivedAt: "2026-07-21T00:00:00.000Z",
    };
    const deps = startDependencies(harness, assistantRuntime);
    deps.cardEvidenceVerifier.verify = vi.fn(async () => evidence);
    await startChannel(deps);

    await harness.cardAction(cardEvent());

    expect(assistantRuntime.confirmationSink.consume).toHaveBeenCalledOnce();
    const binding = vi.mocked(assistantRuntime.confirmationSink.consume).mock
      .calls[0]?.[1];
    expect(binding).toEqual({
      nonce: "nonce-a",
      payloadHash: CARD_ACTION_HASH,
    });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(assistantRuntime.taskSink.ingest).not.toHaveBeenCalled();
    expect(assistantRuntime.gateway.sendSystemReply).not.toHaveBeenCalled();
  });

  it("binds card evidence to sorted-key canonical JSON independent of insertion order", async () => {
    const harness = sourceHarness();
    const assistantRuntime = runtime();
    const action = {
      zeta: [true, null, 3],
      value: { action: "confirm" },
      alpha: { z: 2, a: 1 },
    };
    const evidence: TrustedCardEvidence = {
      appId: APP_ID,
      tenantKey: TENANT_KEY,
      eventId: "card_evt_a",
      messageId: "card_msg_a",
      senderOpenId: PRESIDENT_OPEN_ID,
      chatId: PRESIDENT_CHAT_ID,
      chatType: "p2p",
      signatureVerified: true,
      nonce: "nonce-a",
      payloadHash:
        "sha256:8cc41c4c00ffdb2c4809e61b987d01eb1840514ec4ec2adab2898c34df6ca8e6",
      receivedAt: "2026-07-21T00:00:00.000Z",
    };
    const deps = startDependencies(harness, assistantRuntime);
    deps.cardEvidenceVerifier.verify = vi.fn(async () => evidence);
    await startChannel(deps);

    await harness.cardAction(cardEvent({ action }));

    expect(assistantRuntime.confirmationSink.consume).toHaveBeenCalledOnce();
    const raw = vi.mocked(assistantRuntime.confirmationSink.consume).mock
      .calls[0]?.[0];
    expect(raw?.readBody()).toEqual(action);
  });

  it("snapshots a trusted card action before an asynchronous sink can observe mutation", async () => {
    const harness = sourceHarness();
    let releaseSink: (() => void) | undefined;
    const sinkReleased = new Promise<void>((resolve) => {
      releaseSink = resolve;
    });
    let markSinkEntered: (() => void) | undefined;
    const sinkEntered = new Promise<void>((resolve) => {
      markSinkEntered = resolve;
    });
    let observedBody: unknown;
    const assistantRuntime = runtime();
    assistantRuntime.confirmationSink.consume = vi.fn(async (raw) => {
      markSinkEntered?.();
      await sinkReleased;
      observedBody = raw.readBody();
    });
    const evidence: TrustedCardEvidence = {
      appId: APP_ID,
      tenantKey: TENANT_KEY,
      eventId: "card_evt_a",
      messageId: "card_msg_a",
      senderOpenId: PRESIDENT_OPEN_ID,
      chatId: PRESIDENT_CHAT_ID,
      chatType: "p2p",
      signatureVerified: true,
      nonce: "nonce-a",
      payloadHash: CARD_ACTION_HASH,
      receivedAt: "2026-07-21T00:00:00.000Z",
    };
    const deps = startDependencies(harness, assistantRuntime);
    deps.cardEvidenceVerifier.verify = vi.fn(async () => evidence);
    await startChannel(deps);
    const originalAction = { value: { action: "confirm" } };
    const event = cardEvent({ action: originalAction });

    const handling = harness.cardAction(event);
    await sinkEntered;
    originalAction.value.action = "cancel";
    (event as { action: unknown }).action = {
      value: { action: "replaced" },
    };
    releaseSink?.();
    await handling;

    expect(observedBody).toEqual({ value: { action: "confirm" } });
    expect(Object.isFrozen(observedBody)).toBe(true);
    expect(Object.isFrozen((observedBody as { value: object }).value)).toBe(
      true,
    );
  });

  it("records only a fixed lifecycle enum without reading secret error details", async () => {
    const harness = sourceHarness();
    const deps = startDependencies(harness);
    await startChannel(deps);
    const secretError = Object.create(Error.prototype) as Error;
    Object.defineProperty(secretError, "message", {
      get() {
        throw new Error("secret lifecycle message");
      },
    });

    expect(() => harness.lifecycle("WS_ERROR", secretError)).not.toThrow();

    expect(deps.lifecycleSink.record).toHaveBeenCalledWith("WS_ERROR");
  });

  it("keeps the supported adapter import graph free of legacy live paths", () => {
    const source = readFileSync(
      new URL("../src/bot/channel.ts", import.meta.url),
      "utf8",
    );

    for (const forbidden of [
      "createLarkChannel",
      "@larksuiteoapi/node-sdk",
      "../agent/",
      "../config/",
      "../media/",
      "../commands",
      "../card/",
      "../session/",
      "../workspace/",
      "rawClient",
      "getChatInfo",
      "downloadResource",
      ".send(",
      ".stream(",
      "lark-cli",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("snapshots the runtime dependency getter once before creating a source", async () => {
    const harness = sourceHarness();
    const deps = startDependencies(harness);
    const stableRuntime = deps.runtime;
    let reads = 0;
    Object.defineProperty(deps, "runtime", {
      enumerable: true,
      get() {
        reads += 1;
        if (reads !== 1) throw new Error("secret replacement runtime");
        return stableRuntime;
      },
    });

    const bridge = await startChannel(deps);

    expect(reads).toBe(1);
    expect(harness.connect).toHaveBeenCalledOnce();
    await bridge.disconnect();
  });

  it.each(["hidden-own", "symbol", "prototype"] as const)(
    "rejects a source with an extra %s capability",
    async (variant) => {
      const harness = sourceHarness();
      if (variant === "hidden-own") {
        Object.defineProperty(harness.source, "onReaction", {
          enumerable: false,
          value: vi.fn(),
        });
      } else if (variant === "symbol") {
        Object.defineProperty(harness.source, Symbol("onReaction"), {
          enumerable: false,
          value: vi.fn(),
        });
      } else {
        const prototype = Object.create(Object.prototype) as Record<
          string,
          unknown
        >;
        Object.defineProperty(prototype, "onReaction", {
          enumerable: false,
          value: vi.fn(),
        });
        Object.setPrototypeOf(harness.source, prototype);
      }
      const deps = startDependencies(harness);

      await expect(startChannel(deps)).rejects.toThrow(
        "ASSISTANT_INGRESS_SOURCE_INVALID",
      );
      expect(harness.registrations).toEqual([]);
      expect(harness.connect).not.toHaveBeenCalled();
    },
  );

  it("snapshots every source method once before registration and use", async () => {
    const harness = sourceHarness();
    const reads: Record<string, number> = {};
    const source = {} as Record<string, unknown>;
    for (const key of [
      "onMessage",
      "onCardAction",
      "onLifecycle",
      "connect",
      "disconnect",
    ] as const) {
      const method = harness.source[key];
      Object.defineProperty(source, key, {
        enumerable: true,
        get() {
          reads[key] = (reads[key] ?? 0) + 1;
          if (reads[key] !== 1) throw new Error(`secret replaced ${key}`);
          return method;
        },
      });
    }
    const deps = startDependencies(harness);
    deps.sourceFactory = vi.fn(() => source as unknown as SdkIngressSource);

    const bridge = await startChannel(deps);
    await bridge.disconnect();

    expect(Object.values(reads).every((count) => count === 1)).toBe(true);
    expect(harness.registrations).toEqual([
      "message",
      "cardAction",
      "lifecycle",
    ]);
  });

  it("awaits asynchronous registration rejection before connect", async () => {
    const harness = sourceHarness();
    harness.source.onMessage = vi.fn(async () =>
      Promise.reject(new Error("secret registration failure")),
    ) as unknown as SdkIngressSource["onMessage"];

    await expect(startChannel(startDependencies(harness))).rejects.toThrow(
      "ASSISTANT_SOURCE_REGISTRATION_FAILED",
    );
    expect(harness.connect).not.toHaveBeenCalled();
  });

  it("best-effort disconnects when a later registration rejects", async () => {
    const harness = sourceHarness();
    harness.source.onCardAction = vi.fn(async () =>
      Promise.reject(new Error("secret registration failure")),
    ) as unknown as SdkIngressSource["onCardAction"];

    await expect(startChannel(startDependencies(harness))).rejects.toThrow(
      "ASSISTANT_SOURCE_REGISTRATION_FAILED",
    );
    expect(harness.connect).not.toHaveBeenCalled();
    expect(harness.disconnect).toHaveBeenCalledOnce();
  });

  it("best-effort disconnects after connect failure and keeps a fixed error", async () => {
    const harness = sourceHarness();
    harness.source.connect = vi.fn(async () => {
      throw new Error("secret connect failure");
    });

    await expect(startChannel(startDependencies(harness))).rejects.toThrow(
      "ASSISTANT_SOURCE_CONNECT_FAILED",
    );
    expect(harness.disconnect).toHaveBeenCalledOnce();
  });

  it("shares one in-flight disconnect across concurrent callers", async () => {
    const harness = sourceHarness();
    let resolveDisconnect: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      resolveDisconnect = resolve;
    });
    harness.source.disconnect = vi.fn(async () => blocked);
    const bridge = await startChannel(startDependencies(harness));

    const first = bridge.disconnect();
    const second = bridge.disconnect();
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();

    expect(harness.source.disconnect).toHaveBeenCalledOnce();
    expect(secondSettled).toBe(false);
    resolveDisconnect?.();
    await Promise.all([first, second]);
  });

  it("allows a failed disconnect to be retried", async () => {
    const harness = sourceHarness();
    harness.source.disconnect = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret disconnect failure"))
      .mockResolvedValueOnce(undefined);
    const bridge = await startChannel(startDependencies(harness));

    await expect(bridge.disconnect()).rejects.toThrow(
      "ASSISTANT_SOURCE_DISCONNECT_FAILED",
    );
    await expect(bridge.disconnect()).resolves.toBeUndefined();

    expect(harness.source.disconnect).toHaveBeenCalledTimes(2);
  });

  it("snapshots every trusted card evidence field exactly once", async () => {
    const harness = sourceHarness();
    const assistantRuntime = runtime();
    const reads: Record<string, number> = {};
    const evidence = {};
    for (const [key, value] of [
      ["appId", APP_ID],
      ["tenantKey", TENANT_KEY],
      ["eventId", "card_evt_a"],
      ["messageId", "card_msg_a"],
      ["senderOpenId", PRESIDENT_OPEN_ID],
      ["chatId", PRESIDENT_CHAT_ID],
      ["chatType", "p2p"],
      ["signatureVerified", true],
      ["nonce", "nonce-a"],
      ["payloadHash", CARD_ACTION_HASH],
      ["receivedAt", "2026-07-21T00:00:00.000Z"],
    ] as const) {
      Object.defineProperty(evidence, key, {
        enumerable: true,
        get() {
          reads[key] = (reads[key] ?? 0) + 1;
          if (reads[key] !== 1) throw new Error(`secret repeated ${key}`);
          return value;
        },
      });
    }
    const deps = startDependencies(harness, assistantRuntime);
    deps.cardEvidenceVerifier.verify = vi.fn(
      async () => evidence,
    ) as unknown as (
      input: Parameters<typeof deps.cardEvidenceVerifier.verify>[0],
    ) => Promise<TrustedCardEvidence | null>;
    await startChannel(deps);

    await harness.cardAction(cardEvent());

    expect(Object.values(reads).every((count) => count === 1)).toBe(true);
    expect(assistantRuntime.confirmationSink.consume).toHaveBeenCalledOnce();
  });
});
