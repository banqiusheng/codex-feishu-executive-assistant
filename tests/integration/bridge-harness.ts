import {
  startChannel,
  type LifecycleState,
  type SdkCardActionEvent,
  type SdkIngressSource,
  type SdkMessageEvent,
  type TrustedCardEvidence,
} from "../../packages/bridge/src/bot/channel.js";
import type {
  AssistantChannelDependencies,
  RawEnvelope,
} from "../../packages/bridge/src/runtime/assistant-channel.js";
import {
  sendProgressReply,
  type ProgressStage,
  type SystemText,
} from "../../packages/bridge/src/runtime/system-reply.js";
import { decideIngress } from "../../packages/bridge/src/security/ingress-guard.js";
import {
  hashPairingCode,
  type AccessPolicy,
} from "../../packages/bridge/src/security/policy.js";

const APP_ID = "cli_a";
const TENANT_KEY = "tenant_a";
const PRESIDENT_OPEN_ID = "ou_president";
const PRESIDENT_CHAT_ID = "oc_president_dm";
const TASK_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a21";
const CREATED_AT_MS = Date.parse("2026-07-21T00:00:00.000Z");
const RECEIVED_AT = new Date(CREATED_AT_MS).toISOString();

export interface BridgeHarnessOptions {
  taskOutcome?: "accepted" | "duplicate" | "reject";
  pairingCode?: string;
  paired?: boolean;
  trustedCard?: boolean;
  cardVerifierThrows?: boolean;
}

export interface HarnessMessageOverrides {
  appId?: unknown;
  tenantKey?: unknown;
  eventType?: unknown;
  chatType?: unknown;
  senderOpenId?: unknown;
  chatId?: unknown;
  messageId?: unknown;
  text?: unknown;
}

export interface HarnessCardOverrides {
  senderOpenId?: unknown;
  chatId?: unknown;
  messageId?: unknown;
  action?: unknown;
}

export interface BridgeHarnessMetrics {
  guardCalls: number;
  contentReads: number;
  bodyReads: number;
  resourceReads: number;
  pairingSinkCalls: number;
  confirmationSinkCalls: number;
  cardVerifierCalls: number;
  cardActionReads: number;
  taskSinkCalls: number;
  cancelCalls: number;
  systemReplyCalls: number;
  controlReplyCalls: number;
  wakeCalls: number;
  mediaDownloadsBeforeGuard: number;
}

export type HarnessGatewayCall = Readonly<{
  method: "sendSystemReply" | "sendControlReply";
  anchorId: string;
  body: SystemText;
}>;

export interface BridgeHarness {
  readonly metrics: BridgeHarnessMetrics;
  readonly order: string[];
  readonly registrations: string[];
  readonly gatewayCalls: HarnessGatewayCall[];
  readonly gatewayArgumentCounts: number[];
  emitMessage(overrides?: HarnessMessageOverrides): Promise<void>;
  emitCard(overrides?: HarnessCardOverrides): Promise<void>;
  sendProgress(stage: ProgressStage): Promise<void>;
  disconnect(): Promise<void>;
}

function selected(
  overrides: Record<string, unknown>,
  key: string,
  fallback: unknown,
): unknown {
  return Object.prototype.hasOwnProperty.call(overrides, key)
    ? overrides[key]
    : fallback;
}

function createPolicy(options: BridgeHarnessOptions): AccessPolicy {
  if (options.pairingCode !== undefined) {
    return {
      appId: APP_ID,
      tenantKey: TENANT_KEY,
      presidentOpenId: null,
      presidentChatId: null,
      pairing: {
        active: true,
        codeHash: hashPairingCode(options.pairingCode),
      },
    };
  }
  if (options.paired === false) {
    return {
      appId: APP_ID,
      tenantKey: TENANT_KEY,
      presidentOpenId: null,
      presidentChatId: null,
      pairing: { active: false, codeHash: null },
    };
  }
  return {
    appId: APP_ID,
    tenantKey: TENANT_KEY,
    presidentOpenId: PRESIDENT_OPEN_ID,
    presidentChatId: PRESIDENT_CHAT_ID,
    pairing: { active: false, codeHash: null },
  };
}

function createMessageEvent(
  metrics: BridgeHarnessMetrics,
  guardReached: () => boolean,
  overrides: HarnessMessageOverrides,
): SdkMessageEvent {
  const values = overrides as Record<string, unknown>;
  const appId = selected(values, "appId", APP_ID);
  const tenantKey = selected(values, "tenantKey", TENANT_KEY);
  const eventType = selected(values, "eventType", "im.message.receive_v1");
  const chatType = selected(values, "chatType", "p2p");
  const senderOpenId = selected(values, "senderOpenId", PRESIDENT_OPEN_ID);
  const chatId = selected(values, "chatId", PRESIDENT_CHAT_ID);
  const messageId = selected(values, "messageId", "msg_a");
  const text = selected(values, "text", "整理文件");
  const rawMessage: Record<string, unknown> = {
    message_id: messageId,
    chat_id: chatId,
    chat_type: chatType,
  };
  Object.defineProperty(rawMessage, "content", {
    enumerable: true,
    configurable: false,
    get() {
      metrics.bodyReads += 1;
      return { text };
    },
  });

  return {
    messageId,
    chatId,
    chatType,
    senderId: senderOpenId,
    createTime: CREATED_AT_MS,
    get content() {
      metrics.contentReads += 1;
      return text;
    },
    get resources() {
      metrics.resourceReads += 1;
      if (!guardReached()) metrics.mediaDownloadsBeforeGuard += 1;
      return [];
    },
    raw: {
      header: {
        event_id: "evt_a",
        event_type: eventType,
        app_id: appId,
        tenant_key: tenantKey,
      },
      event: {
        sender: { sender_id: { open_id: senderOpenId } },
        message: rawMessage,
      },
    },
  };
}

function createCardEvent(
  metrics: BridgeHarnessMetrics,
  overrides: HarnessCardOverrides,
): SdkCardActionEvent {
  const values = overrides as Record<string, unknown>;
  const action = selected(values, "action", {
    value: { action: "confirm" },
  });
  const event: Record<string, unknown> = {
    messageId: selected(values, "messageId", "card_msg_a"),
    chatId: selected(values, "chatId", PRESIDENT_CHAT_ID),
    operator: {
      openId: selected(values, "senderOpenId", PRESIDENT_OPEN_ID),
    },
    raw: { opaque: true },
  };
  Object.defineProperty(event, "action", {
    enumerable: true,
    configurable: false,
    get() {
      metrics.cardActionReads += 1;
      return action;
    },
  });
  return event as unknown as SdkCardActionEvent;
}

export async function createBridgeHarness(
  options: BridgeHarnessOptions = {},
): Promise<BridgeHarness> {
  const metrics: BridgeHarnessMetrics = {
    guardCalls: 0,
    contentReads: 0,
    bodyReads: 0,
    resourceReads: 0,
    pairingSinkCalls: 0,
    confirmationSinkCalls: 0,
    cardVerifierCalls: 0,
    cardActionReads: 0,
    taskSinkCalls: 0,
    cancelCalls: 0,
    systemReplyCalls: 0,
    controlReplyCalls: 0,
    wakeCalls: 0,
    mediaDownloadsBeforeGuard: 0,
  };
  const order: string[] = [];
  const registrations: string[] = [];
  const gatewayCalls: HarnessGatewayCall[] = [];
  const gatewayArgumentCounts: number[] = [];
  const policy = createPolicy(options);
  let guardReachedForCurrentEvent = false;
  let messageHandler: ((event: SdkMessageEvent) => Promise<void>) | undefined;
  let cardHandler: ((event: SdkCardActionEvent) => Promise<void>) | undefined;
  let lifecycleHandler:
    | ((state: LifecycleState, detail?: unknown) => void)
    | undefined;

  const gateway: AssistantChannelDependencies["gateway"] = {
    async sendSystemReply(anchorId, body) {
      gatewayArgumentCounts.push(arguments.length);
      metrics.systemReplyCalls += 1;
      order.push(body.value === "收到，我开始处理" ? "ack" : "progress-reply");
      gatewayCalls.push({ method: "sendSystemReply", anchorId, body });
      return { state: "SUCCEEDED" };
    },
    async sendControlReply(anchorId, body) {
      gatewayArgumentCounts.push(arguments.length);
      metrics.controlReplyCalls += 1;
      order.push("control-reply");
      gatewayCalls.push({ method: "sendControlReply", anchorId, body });
      return { state: "SUCCEEDED" };
    },
  };

  const runtime: AssistantChannelDependencies = {
    ingressGuard(metadata) {
      guardReachedForCurrentEvent = true;
      metrics.guardCalls += 1;
      order.push("guard");
      return decideIngress(metadata, policy);
    },
    pairingSink: {
      async consume() {
        metrics.pairingSinkCalls += 1;
        order.push("pairing");
      },
    },
    confirmationSink: {
      async consume() {
        metrics.confirmationSinkCalls += 1;
        order.push("confirmation");
      },
    },
    taskSink: {
      async ingest() {
        metrics.taskSinkCalls += 1;
        order.push("persist");
        if (options.taskOutcome === "reject") {
          throw new Error("in-memory sink rejection");
        }
        return {
          taskId: TASK_ID,
          duplicate: options.taskOutcome === "duplicate",
        };
      },
    },
    taskControlSink: {
      async cancelActive() {
        metrics.cancelCalls += 1;
        order.push("cancel");
        return {
          controlEventId: "control_evt_a",
          taskId: TASK_ID,
          cancelled: true,
          duplicate: false,
          externalEffectsPending: false,
        };
      },
    },
    normalizer: {
      toInboundEvent(raw: RawEnvelope) {
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
      toCancelActiveTaskRequest(raw: RawEnvelope) {
        return {
          appId: APP_ID,
          tenantKey: TENANT_KEY,
          eventId: raw.eventId,
          messageId: raw.messageId,
          senderOpenId: raw.metadata.senderOpenId,
          chatId: raw.metadata.chatId,
          receivedAt: raw.receivedAt,
        };
      },
    },
    gateway,
    scheduler: {
      wake() {
        metrics.wakeCalls += 1;
        order.push("wake");
      },
    },
  };

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
    async connect() {
      lifecycleHandler?.("WS_CONNECTED");
    },
    async disconnect() {
      lifecycleHandler?.("WS_DISCONNECTED");
    },
  };

  const bridge = await startChannel({
    appId: APP_ID,
    tenantKey: TENANT_KEY,
    runtime,
    sourceFactory: () => source,
    cardEvidenceVerifier: {
      async verify(input) {
        metrics.cardVerifierCalls += 1;
        if (options.cardVerifierThrows === true) {
          throw new Error("untrusted verifier detail");
        }
        if (options.trustedCard !== true) return null;
        const evidence: TrustedCardEvidence = {
          appId: input.appId,
          tenantKey: input.tenantKey,
          eventId: "card_evt_a",
          messageId: input.messageId,
          senderOpenId: input.senderOpenId,
          chatId: input.chatId,
          chatType: "p2p",
          signatureVerified: true,
          nonce: "nonce-a",
          payloadHash:
            "sha256:b2131b4cba33c3e696b4f6352fd928f7c7c68358ae291d069c18e5d68878ba63",
          receivedAt: RECEIVED_AT,
        };
        return evidence;
      },
    },
    lifecycleSink: { record: () => undefined },
  });

  return {
    metrics,
    order,
    registrations,
    gatewayCalls,
    gatewayArgumentCounts,
    async emitMessage(overrides = {}) {
      if (messageHandler === undefined)
        throw new Error("message handler missing");
      guardReachedForCurrentEvent = false;
      await messageHandler(
        createMessageEvent(
          metrics,
          () => guardReachedForCurrentEvent,
          overrides,
        ),
      );
    },
    async emitCard(overrides = {}) {
      if (cardHandler === undefined) throw new Error("card handler missing");
      guardReachedForCurrentEvent = false;
      await cardHandler(createCardEvent(metrics, overrides));
    },
    async sendProgress(stage) {
      await sendProgressReply(gateway, TASK_ID, stage);
    },
    async disconnect() {
      await bridge.disconnect();
    },
  };
}
