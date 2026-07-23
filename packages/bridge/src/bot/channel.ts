import { createHash } from "node:crypto";

import {
  createAssistantChannel,
  type AssistantChannelDependencies,
  type RawEnvelope,
} from "../runtime/assistant-channel.js";
import type { RawIngressMetadata } from "../security/ingress-guard.js";
import { isCanonicalSha256Digest } from "../security/policy.js";

export const ASSISTANT_RUNTIME_PORTS_REQUIRED =
  "ASSISTANT_RUNTIME_PORTS_REQUIRED" as const;

const ADAPTER_ERROR = {
  SOURCE_INVALID: "ASSISTANT_INGRESS_SOURCE_INVALID",
  SOURCE_REGISTRATION_FAILED: "ASSISTANT_SOURCE_REGISTRATION_FAILED",
  SOURCE_CONNECT_FAILED: "ASSISTANT_SOURCE_CONNECT_FAILED",
  SOURCE_DISCONNECT_FAILED: "ASSISTANT_SOURCE_DISCONNECT_FAILED",
} as const;

export type LifecycleState =
  | "WS_CONNECTING"
  | "WS_CONNECTED"
  | "WS_RECONNECTING"
  | "WS_RECONNECTED"
  | "WS_ERROR"
  | "WS_DISCONNECTED";

export interface SdkMessageEvent {
  readonly messageId: unknown;
  readonly chatId: unknown;
  readonly chatType: unknown;
  readonly senderId: unknown;
  readonly createTime: unknown;
  readonly content: unknown;
  readonly resources: unknown;
  readonly raw?: unknown;
}

export interface SdkCardActionEvent {
  readonly messageId: unknown;
  readonly chatId: unknown;
  readonly operator: unknown;
  readonly action: unknown;
  readonly raw?: unknown;
}

export interface SdkIngressSource {
  onMessage(
    handler: (event: SdkMessageEvent) => Promise<void>,
  ): void | Promise<void>;
  onCardAction(
    handler: (event: SdkCardActionEvent) => Promise<void>,
  ): void | Promise<void>;
  onLifecycle(
    handler: (state: LifecycleState, detail?: unknown) => void,
  ): void | Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export type SdkIngressSourceFactory = () => SdkIngressSource;

export type CardVerificationInput = Readonly<{
  appId: string;
  tenantKey: string;
  eventType: "card.action.trigger";
  messageId: string;
  chatId: string;
  senderOpenId: string;
}>;

export type TrustedCardEvidence = Readonly<{
  appId: string;
  tenantKey: string;
  eventId: string;
  messageId: string;
  senderOpenId: string;
  chatId: string;
  chatType: "p2p";
  signatureVerified: true;
  nonce: string;
  /** SHA-256 of the signed action encoded as sorted-key canonical JSON. */
  payloadHash: `sha256:${string}`;
  receivedAt: string;
}>;

export interface CardEvidenceVerifier {
  verify(input: CardVerificationInput): Promise<TrustedCardEvidence | null>;
}

export interface LifecycleSink {
  record(state: LifecycleState): void | Promise<void>;
}

export interface StartChannelDeps {
  appId: string;
  tenantKey: string;
  runtime: AssistantChannelDependencies;
  sourceFactory: SdkIngressSourceFactory;
  cardEvidenceVerifier: CardEvidenceVerifier;
  lifecycleSink: LifecycleSink;
}

export interface BridgeChannel {
  disconnect(): Promise<void>;
}

const LIFECYCLE_STATES = new Set<LifecycleState>([
  "WS_CONNECTING",
  "WS_CONNECTED",
  "WS_RECONNECTING",
  "WS_RECONNECTED",
  "WS_ERROR",
  "WS_DISCONNECTED",
]);

const START_DEPENDENCY_KEYS = [
  "appId",
  "tenantKey",
  "runtime",
  "sourceFactory",
  "cardEvidenceVerifier",
  "lifecycleSink",
] as const;

const RUNTIME_PORT_KEYS = [
  "ingressGuard",
  "pairingSink",
  "confirmationSink",
  "taskSink",
  "taskControlSink",
  "normalizer",
  "gateway",
  "scheduler",
] as const;

const SOURCE_KEYS = [
  "onMessage",
  "onCardAction",
  "onLifecycle",
  "connect",
  "disconnect",
] as const;

const RAW_ROOT_KEYS = new Set(["schema", "header", "event"]);
const RAW_HEADER_KEYS = new Set([
  "event_id",
  "event_type",
  "create_time",
  "token",
  "app_id",
  "tenant_key",
]);
const RAW_EVENT_KEYS = new Set(["sender", "message"]);
const RAW_SENDER_KEYS = new Set(["sender_id", "sender_type", "tenant_key"]);
const RAW_SENDER_ID_KEYS = new Set(["union_id", "user_id", "open_id"]);
const RAW_MESSAGE_KEYS = new Set([
  "message_id",
  "root_id",
  "parent_id",
  "create_time",
  "chat_id",
  "chat_type",
  "message_type",
  "content",
  "mentions",
  "user_agent",
]);
const CARD_EVIDENCE_KEYS = [
  "appId",
  "tenantKey",
  "eventId",
  "messageId",
  "senderOpenId",
  "chatId",
  "chatType",
  "signatureVerified",
  "nonce",
  "payloadHash",
  "receivedAt",
] as const;
const MAX_CARD_ACTION_DEPTH = 32;
const MAX_CARD_ACTION_NODES = 2_048;
const INVALID_CARD_ACTION = Symbol("INVALID_CARD_ACTION");
const INVALID_CANONICAL_CARD_ACTION = Symbol("INVALID_CANONICAL_CARD_ACTION");

function fixedError(message: string): Error {
  return new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExactIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value === value.trim()
  );
}

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

function hasOnlyKeys(value: object, allowed: ReadonlySet<string>): boolean {
  return Reflect.ownKeys(value).every(
    (key) => typeof key === "string" && allowed.has(key),
  );
}

function snapshotRuntimePorts(value: unknown): AssistantChannelDependencies {
  if (!isRecord(value) || !hasExactKeys(value, RUNTIME_PORT_KEYS)) {
    throw fixedError(ASSISTANT_RUNTIME_PORTS_REQUIRED);
  }
  const runtime = value;
  try {
    const ingressGuard = runtime.ingressGuard;
    const pairingSink = runtime.pairingSink;
    const confirmationSink = runtime.confirmationSink;
    const taskSink = runtime.taskSink;
    const taskControlSink = runtime.taskControlSink;
    const normalizer = runtime.normalizer;
    const gateway = runtime.gateway;
    const scheduler = runtime.scheduler;
    if (
      typeof ingressGuard !== "function" ||
      !isRecord(pairingSink) ||
      !isRecord(confirmationSink) ||
      !isRecord(taskSink) ||
      !isRecord(taskControlSink) ||
      !isRecord(normalizer) ||
      !isRecord(gateway) ||
      !isRecord(scheduler)
    ) {
      throw fixedError(ASSISTANT_RUNTIME_PORTS_REQUIRED);
    }
    const pairingConsume = pairingSink.consume;
    const confirmationConsume = confirmationSink.consume;
    const taskIngest = taskSink.ingest;
    const cancelActive = taskControlSink.cancelActive;
    const toInboundEvent = normalizer.toInboundEvent;
    const toCancelActiveTaskRequest = normalizer.toCancelActiveTaskRequest;
    const sendSystemReply = gateway.sendSystemReply;
    const sendControlReply = gateway.sendControlReply;
    const wake = scheduler.wake;
    if (
      typeof pairingConsume !== "function" ||
      typeof confirmationConsume !== "function" ||
      typeof taskIngest !== "function" ||
      typeof cancelActive !== "function" ||
      typeof toInboundEvent !== "function" ||
      typeof toCancelActiveTaskRequest !== "function" ||
      typeof sendSystemReply !== "function" ||
      typeof sendControlReply !== "function" ||
      typeof wake !== "function"
    ) {
      throw fixedError(ASSISTANT_RUNTIME_PORTS_REQUIRED);
    }

    const snapshot: AssistantChannelDependencies = {
      ingressGuard(metadata) {
        return Reflect.apply(ingressGuard, runtime, [metadata]) as ReturnType<
          AssistantChannelDependencies["ingressGuard"]
        >;
      },
      pairingSink: Object.freeze({
        async consume(raw) {
          await Reflect.apply(pairingConsume, pairingSink, [raw]);
        },
      }),
      confirmationSink: Object.freeze({
        async consume(raw, binding) {
          await Reflect.apply(confirmationConsume, confirmationSink, [
            raw,
            binding,
          ]);
        },
      }),
      taskSink: Object.freeze({
        async ingest(
          event: Parameters<
            AssistantChannelDependencies["taskSink"]["ingest"]
          >[0],
        ) {
          return (await Reflect.apply(taskIngest, taskSink, [
            event,
          ])) as Awaited<
            ReturnType<AssistantChannelDependencies["taskSink"]["ingest"]>
          >;
        },
      }),
      taskControlSink: Object.freeze({
        async cancelActive(
          request: Parameters<
            AssistantChannelDependencies["taskControlSink"]["cancelActive"]
          >[0],
        ) {
          return (await Reflect.apply(cancelActive, taskControlSink, [
            request,
          ])) as Awaited<
            ReturnType<
              AssistantChannelDependencies["taskControlSink"]["cancelActive"]
            >
          >;
        },
      }),
      normalizer: Object.freeze({
        toInboundEvent(raw: RawEnvelope) {
          return Reflect.apply(toInboundEvent, normalizer, [raw]) as ReturnType<
            AssistantChannelDependencies["normalizer"]["toInboundEvent"]
          >;
        },
        toCancelActiveTaskRequest(raw: RawEnvelope) {
          return Reflect.apply(toCancelActiveTaskRequest, normalizer, [
            raw,
          ]) as ReturnType<
            AssistantChannelDependencies["normalizer"]["toCancelActiveTaskRequest"]
          >;
        },
      }),
      gateway: Object.freeze({
        async sendSystemReply(
          taskId: string,
          body: Parameters<
            AssistantChannelDependencies["gateway"]["sendSystemReply"]
          >[1],
        ) {
          return (await Reflect.apply(sendSystemReply, gateway, [
            taskId,
            body,
          ])) as Awaited<
            ReturnType<
              AssistantChannelDependencies["gateway"]["sendSystemReply"]
            >
          >;
        },
        async sendControlReply(
          controlEventId: string,
          body: Parameters<
            AssistantChannelDependencies["gateway"]["sendControlReply"]
          >[1],
        ) {
          return (await Reflect.apply(sendControlReply, gateway, [
            controlEventId,
            body,
          ])) as Awaited<
            ReturnType<
              AssistantChannelDependencies["gateway"]["sendControlReply"]
            >
          >;
        },
      }),
      scheduler: Object.freeze({
        wake() {
          return Reflect.apply(wake, scheduler, []) as ReturnType<
            AssistantChannelDependencies["scheduler"]["wake"]
          >;
        },
      }),
    };
    return Object.freeze(snapshot);
  } catch {
    throw fixedError(ASSISTANT_RUNTIME_PORTS_REQUIRED);
  }
}

function snapshotStartDependencies(value: unknown): StartChannelDeps {
  if (!isRecord(value) || !hasExactKeys(value, START_DEPENDENCY_KEYS)) {
    throw fixedError(ASSISTANT_RUNTIME_PORTS_REQUIRED);
  }
  try {
    const appId = value.appId;
    const tenantKey = value.tenantKey;
    const runtime = value.runtime;
    const sourceFactory = value.sourceFactory;
    const cardEvidenceVerifier = value.cardEvidenceVerifier;
    const lifecycleSink = value.lifecycleSink;
    if (
      !isExactIdentifier(appId) ||
      !isExactIdentifier(tenantKey) ||
      typeof sourceFactory !== "function" ||
      !isRecord(cardEvidenceVerifier) ||
      !isRecord(lifecycleSink)
    ) {
      throw fixedError(ASSISTANT_RUNTIME_PORTS_REQUIRED);
    }
    const verify = cardEvidenceVerifier.verify;
    const record = lifecycleSink.record;
    if (typeof verify !== "function" || typeof record !== "function") {
      throw fixedError(ASSISTANT_RUNTIME_PORTS_REQUIRED);
    }
    const snapshot: StartChannelDeps = {
      appId,
      tenantKey,
      runtime: snapshotRuntimePorts(runtime),
      sourceFactory() {
        return Reflect.apply(sourceFactory, value, []) as SdkIngressSource;
      },
      cardEvidenceVerifier: Object.freeze({
        async verify(input: CardVerificationInput) {
          return (await Reflect.apply(verify, cardEvidenceVerifier, [
            input,
          ])) as TrustedCardEvidence | null;
        },
      }),
      lifecycleSink: Object.freeze({
        record(state: LifecycleState) {
          return Reflect.apply(record, lifecycleSink, [state]) as ReturnType<
            LifecycleSink["record"]
          >;
        },
      }),
    };
    return Object.freeze(snapshot);
  } catch {
    throw fixedError(ASSISTANT_RUNTIME_PORTS_REQUIRED);
  }
}

function snapshotSource(value: unknown): SdkIngressSource {
  try {
    if (
      !isRecord(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) ||
      !hasExactKeys(value, SOURCE_KEYS)
    ) {
      throw fixedError(ADAPTER_ERROR.SOURCE_INVALID);
    }
    const onMessage = value.onMessage;
    const onCardAction = value.onCardAction;
    const onLifecycle = value.onLifecycle;
    const connect = value.connect;
    const disconnect = value.disconnect;
    if (
      typeof onMessage !== "function" ||
      typeof onCardAction !== "function" ||
      typeof onLifecycle !== "function" ||
      typeof connect !== "function" ||
      typeof disconnect !== "function"
    ) {
      throw fixedError(ADAPTER_ERROR.SOURCE_INVALID);
    }
    const snapshot: SdkIngressSource = {
      onMessage(handler) {
        return Reflect.apply(onMessage, value, [
          handler,
        ]) as void | Promise<void>;
      },
      onCardAction(handler) {
        return Reflect.apply(onCardAction, value, [
          handler,
        ]) as void | Promise<void>;
      },
      onLifecycle(handler) {
        return Reflect.apply(onLifecycle, value, [
          handler,
        ]) as void | Promise<void>;
      },
      async connect() {
        await Reflect.apply(connect, value, []);
      },
      async disconnect() {
        await Reflect.apply(disconnect, value, []);
      },
    };
    return Object.freeze(snapshot);
  } catch {
    throw fixedError(ADAPTER_ERROR.SOURCE_INVALID);
  }
}

function toReceivedAt(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

function messageEnvelope(
  input: SdkMessageEvent,
  appId: string,
  tenantKey: string,
): RawEnvelope | null {
  try {
    const messageId = input.messageId;
    const chatId = input.chatId;
    const chatType = input.chatType;
    const senderId = input.senderId;
    const receivedAt = toReceivedAt(input.createTime);
    const raw = input.raw;
    if (
      !isExactIdentifier(messageId) ||
      !isExactIdentifier(chatId) ||
      (chatType !== "p2p" && chatType !== "group") ||
      !isExactIdentifier(senderId) ||
      receivedAt === null ||
      !isRecord(raw) ||
      !hasOnlyKeys(raw, RAW_ROOT_KEYS)
    ) {
      return null;
    }

    const header = raw.header;
    const rawEvent = raw.event;
    if (
      !isRecord(header) ||
      !hasOnlyKeys(header, RAW_HEADER_KEYS) ||
      !isRecord(rawEvent) ||
      !hasOnlyKeys(rawEvent, RAW_EVENT_KEYS)
    ) {
      return null;
    }

    const eventId = header.event_id;
    if (
      !isExactIdentifier(eventId) ||
      header.tenant_key !== tenantKey ||
      (header.app_id !== undefined && header.app_id !== appId) ||
      (header.event_type !== undefined &&
        header.event_type !== "im.message.receive_v1")
    ) {
      return null;
    }

    const rawSender = rawEvent.sender;
    const rawMessage = rawEvent.message;
    if (
      !isRecord(rawSender) ||
      !hasOnlyKeys(rawSender, RAW_SENDER_KEYS) ||
      !isRecord(rawMessage) ||
      !hasOnlyKeys(rawMessage, RAW_MESSAGE_KEYS)
    ) {
      return null;
    }
    const rawSenderId = rawSender.sender_id;
    if (
      !isRecord(rawSenderId) ||
      !hasOnlyKeys(rawSenderId, RAW_SENDER_ID_KEYS) ||
      rawSenderId.open_id !== senderId ||
      rawMessage.message_id !== messageId ||
      rawMessage.chat_id !== chatId ||
      rawMessage.chat_type !== chatType
    ) {
      return null;
    }

    const metadataBase = {
      appId,
      tenantKey,
      eventType: "im.message.receive_v1",
      chatType,
      senderOpenId: senderId,
      chatId,
    };
    const metadata = Object.defineProperty(metadataBase, "text", {
      enumerable: true,
      configurable: false,
      get: () => input.content,
    }) as RawIngressMetadata;
    Object.freeze(metadata);

    return Object.freeze({
      metadata,
      eventId,
      messageId,
      receivedAt,
      readText: () => input.content,
      readBody: () => rawMessage.content,
      readResources: () => input.resources,
    });
  } catch {
    return null;
  }
}

function cardVerificationInput(
  input: SdkCardActionEvent,
  appId: string,
  tenantKey: string,
): CardVerificationInput | null {
  try {
    const messageId = input.messageId;
    const chatId = input.chatId;
    const operator = input.operator;
    const senderOpenId = isRecord(operator) ? operator.openId : undefined;
    if (
      !isExactIdentifier(messageId) ||
      !isExactIdentifier(chatId) ||
      !isRecord(operator) ||
      !isExactIdentifier(senderOpenId)
    ) {
      return null;
    }
    return Object.freeze({
      appId,
      tenantKey,
      eventType: "card.action.trigger",
      messageId,
      chatId,
      senderOpenId,
    });
  } catch {
    return null;
  }
}

function trustedCardEvidence(
  value: unknown,
  input: CardVerificationInput,
): TrustedCardEvidence | null {
  try {
    if (!isRecord(value) || !hasExactKeys(value, CARD_EVIDENCE_KEYS)) {
      return null;
    }
    const appId = value.appId;
    const tenantKey = value.tenantKey;
    const eventId = value.eventId;
    const messageId = value.messageId;
    const senderOpenId = value.senderOpenId;
    const chatId = value.chatId;
    const chatType = value.chatType;
    const signatureVerified = value.signatureVerified;
    const nonce = value.nonce;
    const payloadHash = value.payloadHash;
    const receivedAt = value.receivedAt;
    if (
      appId !== input.appId ||
      tenantKey !== input.tenantKey ||
      messageId !== input.messageId ||
      senderOpenId !== input.senderOpenId ||
      chatId !== input.chatId ||
      chatType !== "p2p" ||
      signatureVerified !== true ||
      !isExactIdentifier(eventId) ||
      !isExactIdentifier(nonce) ||
      nonce.length > 256 ||
      !isCanonicalSha256Digest(payloadHash) ||
      typeof receivedAt !== "string" ||
      !Number.isFinite(Date.parse(receivedAt))
    ) {
      return null;
    }
    return Object.freeze({
      appId,
      tenantKey,
      eventId,
      messageId,
      senderOpenId,
      chatId,
      chatType: "p2p",
      signatureVerified: true,
      nonce,
      payloadHash,
      receivedAt,
    });
  } catch {
    return null;
  }
}

function snapshotCardActionValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  budget: { remaining: number },
): unknown | typeof INVALID_CARD_ACTION {
  if (budget.remaining <= 0 || depth > MAX_CARD_ACTION_DEPTH) {
    return INVALID_CARD_ACTION;
  }
  budget.remaining -= 1;

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : INVALID_CARD_ACTION;
  }
  if (typeof value !== "object" || seen.has(value)) {
    return INVALID_CARD_ACTION;
  }

  try {
    seen.add(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        return INVALID_CARD_ACTION;
      }
      const keys = Reflect.ownKeys(value);
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        return INVALID_CARD_ACTION;
      }
      const length = lengthDescriptor.value as number;
      if (
        keys.some((key) => typeof key !== "string") ||
        keys.length !== length + 1 ||
        !keys.includes("length")
      ) {
        return INVALID_CARD_ACTION;
      }
      const snapshot: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (descriptor === undefined || !("value" in descriptor)) {
          return INVALID_CARD_ACTION;
        }
        const item = snapshotCardActionValue(
          descriptor.value,
          depth + 1,
          seen,
          budget,
        );
        if (item === INVALID_CARD_ACTION) return INVALID_CARD_ACTION;
        snapshot.push(item);
      }
      return Object.freeze(snapshot);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return INVALID_CARD_ACTION;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      return INVALID_CARD_ACTION;
    }
    const snapshot = {} as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return INVALID_CARD_ACTION;
      }
      const property = snapshotCardActionValue(
        descriptor.value,
        depth + 1,
        seen,
        budget,
      );
      if (property === INVALID_CARD_ACTION) return INVALID_CARD_ACTION;
      Object.defineProperty(snapshot, key, {
        value: property,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(snapshot);
  } catch {
    return INVALID_CARD_ACTION;
  } finally {
    seen.delete(value);
  }
}

function snapshotTrustedCardAction(
  input: SdkCardActionEvent,
): unknown | typeof INVALID_CARD_ACTION {
  try {
    return snapshotCardActionValue(input.action, 0, new WeakSet<object>(), {
      remaining: MAX_CARD_ACTION_NODES,
    });
  } catch {
    return INVALID_CARD_ACTION;
  }
}

function canonicalCardActionValue(
  value: unknown,
): string | typeof INVALID_CANONICAL_CARD_ACTION {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? JSON.stringify(value)
      : INVALID_CANONICAL_CARD_ACTION;
  }
  if (typeof value !== "object") return INVALID_CANONICAL_CARD_ACTION;

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      return INVALID_CANONICAL_CARD_ACTION;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      return INVALID_CANONICAL_CARD_ACTION;
    }
    const length = lengthDescriptor.value as number;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some((key) => typeof key !== "string") ||
      ownKeys.length !== length + 1 ||
      !ownKeys.includes("length")
    ) {
      return INVALID_CANONICAL_CARD_ACTION;
    }
    const items: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) {
        return INVALID_CANONICAL_CARD_ACTION;
      }
      const item = canonicalCardActionValue(descriptor.value);
      if (item === INVALID_CANONICAL_CARD_ACTION) {
        return INVALID_CANONICAL_CARD_ACTION;
      }
      items.push(item);
    }
    return `[${items.join(",")}]`;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return INVALID_CANONICAL_CARD_ACTION;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    return INVALID_CANONICAL_CARD_ACTION;
  }
  const properties: string[] = [];
  for (const key of (ownKeys as string[]).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      return INVALID_CANONICAL_CARD_ACTION;
    }
    const property = canonicalCardActionValue(descriptor.value);
    if (property === INVALID_CANONICAL_CARD_ACTION) {
      return INVALID_CANONICAL_CARD_ACTION;
    }
    properties.push(`${JSON.stringify(key)}:${property}`);
  }
  return `{${properties.join(",")}}`;
}

function hashCanonicalCardAction(action: unknown): `sha256:${string}` | null {
  try {
    const canonical = canonicalCardActionValue(action);
    if (canonical === INVALID_CANONICAL_CARD_ACTION) return null;
    const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
    return `sha256:${digest}`;
  } catch {
    return null;
  }
}

function cardEnvelope(
  verificationInput: CardVerificationInput,
  evidence: TrustedCardEvidence | null,
  action: unknown,
): RawEnvelope {
  const metadata: RawIngressMetadata = evidence
    ? Object.freeze({
        appId: evidence.appId,
        tenantKey: evidence.tenantKey,
        eventType: "card.action.trigger",
        chatType: evidence.chatType,
        senderOpenId: evidence.senderOpenId,
        chatId: evidence.chatId,
        signatureVerified: true,
        callbackNonce: evidence.nonce,
        callbackPayloadHash: evidence.payloadHash,
      })
    : Object.freeze({
        appId: verificationInput.appId,
        tenantKey: verificationInput.tenantKey,
        eventType: "card.action.trigger",
        chatType: "unknown",
        senderOpenId: verificationInput.senderOpenId,
        chatId: verificationInput.chatId,
        signatureVerified: false,
      });

  return Object.freeze({
    metadata,
    eventId: evidence?.eventId ?? "",
    messageId: verificationInput.messageId,
    receivedAt: evidence?.receivedAt ?? "",
    readText: () => undefined,
    readBody: () => action,
    readResources: () => [],
  });
}

function recordLifecycle(sink: LifecycleSink, state: LifecycleState): void {
  if (!LIFECYCLE_STATES.has(state)) return;
  try {
    Promise.resolve(sink.record(state)).catch(() => undefined);
  } catch {
    // Lifecycle reporting never reads or exposes SDK error details.
  }
}

export async function startChannel(
  dependencies: StartChannelDeps,
): Promise<BridgeChannel> {
  const stableDependencies = snapshotStartDependencies(dependencies);

  const assistant = createAssistantChannel(stableDependencies.runtime);
  let untrustedSource: unknown;
  try {
    untrustedSource = stableDependencies.sourceFactory();
  } catch {
    throw fixedError(ADAPTER_ERROR.SOURCE_INVALID);
  }
  const source = snapshotSource(untrustedSource);

  try {
    await source.onMessage(async (event) => {
      const envelope = messageEnvelope(
        event,
        stableDependencies.appId,
        stableDependencies.tenantKey,
      );
      if (envelope === null) return;
      await assistant.handle(envelope);
    });
    await source.onCardAction(async (event) => {
      const verificationInput = cardVerificationInput(
        event,
        stableDependencies.appId,
        stableDependencies.tenantKey,
      );
      if (verificationInput === null) return;
      let untrustedEvidence: unknown = null;
      try {
        untrustedEvidence =
          await stableDependencies.cardEvidenceVerifier.verify(
            verificationInput,
          );
      } catch {
        untrustedEvidence = null;
      }
      const evidence = trustedCardEvidence(
        untrustedEvidence,
        verificationInput,
      );
      const action =
        evidence === null ? undefined : snapshotTrustedCardAction(event);
      const actionHash =
        action === INVALID_CARD_ACTION || evidence === null
          ? null
          : hashCanonicalCardAction(action);
      const stableEvidence =
        actionHash !== null && actionHash === evidence?.payloadHash
          ? evidence
          : null;
      await assistant.handle(
        cardEnvelope(
          verificationInput,
          stableEvidence,
          stableEvidence === null ? undefined : action,
        ),
      );
    });
    await source.onLifecycle((state, _detail) => {
      recordLifecycle(stableDependencies.lifecycleSink, state);
    });
  } catch {
    try {
      await source.disconnect();
    } catch {
      // Registration cleanup is best-effort and preserves the fixed error.
    }
    throw fixedError(ADAPTER_ERROR.SOURCE_REGISTRATION_FAILED);
  }

  try {
    await source.connect();
  } catch {
    try {
      await source.disconnect();
    } catch {
      // Connection cleanup is best-effort and never changes the fixed error.
    }
    throw fixedError(ADAPTER_ERROR.SOURCE_CONNECT_FAILED);
  }

  let disconnected = false;
  let disconnecting: Promise<void> | undefined;
  return Object.freeze({
    disconnect(): Promise<void> {
      if (disconnected) return Promise.resolve();
      if (disconnecting !== undefined) return disconnecting;

      const attempt = Promise.resolve()
        .then(async () => {
          await source.disconnect();
          disconnected = true;
        })
        .catch(() => {
          throw fixedError(ADAPTER_ERROR.SOURCE_DISCONNECT_FAILED);
        })
        .finally(() => {
          if (disconnecting === attempt) disconnecting = undefined;
        });
      disconnecting = attempt;
      return attempt;
    },
  });
}
