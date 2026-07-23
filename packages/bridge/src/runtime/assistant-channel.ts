import {
  InboundEventSchema,
  type CancelActiveTaskRequest,
  type CancelActiveTaskResult,
  type InboundEvent,
  type TaskControlSink,
  type TaskSink,
} from "@executive-assistant/contracts";

import {
  DENY_REASON,
  type IngressDecision,
  type RawIngressMetadata,
} from "../security/ingress-guard.js";
import { isCanonicalSha256Digest } from "../security/policy.js";
import {
  sendCancellationReply,
  sendTaskAcceptedReply,
  type AssistantReplyGateway,
  type CancellationReplyKind,
} from "./system-reply.js";

export const ASSISTANT_CHANNEL_ERROR = {
  INGRESS_GUARD_FAILED: "ASSISTANT_INGRESS_GUARD_FAILED",
  PAIRING_SINK_FAILED: "ASSISTANT_PAIRING_SINK_FAILED",
  CONFIRMATION_SINK_FAILED: "ASSISTANT_CONFIRMATION_SINK_FAILED",
  CANCEL_CLASSIFICATION_FAILED: "ASSISTANT_CANCEL_CLASSIFICATION_FAILED",
  CANCEL_NORMALIZATION_FAILED: "ASSISTANT_CANCEL_NORMALIZATION_FAILED",
  CANCEL_SINK_FAILED: "ASSISTANT_CANCEL_SINK_FAILED",
  TASK_NORMALIZATION_FAILED: "ASSISTANT_TASK_NORMALIZATION_FAILED",
  TASK_INGEST_FAILED: "ASSISTANT_TASK_INGEST_FAILED",
  SCHEDULER_WAKE_FAILED: "ASSISTANT_SCHEDULER_WAKE_FAILED",
} as const;

export type CardBinding = Readonly<{
  nonce: string;
  payloadHash: `sha256:${string}`;
}>;

export interface RawEnvelope {
  readonly metadata: RawIngressMetadata;
  readonly eventId: string;
  readonly messageId: string;
  readonly receivedAt: string;
  readText(): unknown;
  readBody(): unknown;
  readResources(): unknown;
}

export interface AssistantNormalizer {
  toInboundEvent(raw: RawEnvelope): InboundEvent;
  toCancelActiveTaskRequest(raw: RawEnvelope): CancelActiveTaskRequest;
}

export interface AssistantChannelDependencies {
  ingressGuard(metadata: RawIngressMetadata): IngressDecision;
  pairingSink: { consume(raw: RawEnvelope): Promise<void> };
  confirmationSink: {
    consume(raw: RawEnvelope, binding: CardBinding): Promise<void>;
  };
  taskSink: TaskSink;
  taskControlSink: TaskControlSink;
  normalizer: AssistantNormalizer;
  gateway: AssistantReplyGateway;
  scheduler: { wake(): void | Promise<void> };
}

export interface AssistantChannel {
  handle(raw: RawEnvelope): Promise<void>;
}

const CANCEL_PHRASES = new Set(["停一下", "停止当前任务", "取消这个任务"]);

const DENY_REASONS = new Set<string>(Object.values(DENY_REASON));
const RAW_METADATA_REQUIRED_KEYS = [
  "appId",
  "tenantKey",
  "eventType",
  "chatType",
  "senderOpenId",
  "chatId",
] as const;
const RAW_METADATA_ALLOWED_KEYS = new Set<string>([
  ...RAW_METADATA_REQUIRED_KEYS,
  "text",
  "signatureVerified",
  "callbackNonce",
  "callbackPayloadHash",
]);

function fixedError(message: string): Error {
  return new Error(message);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) return false;
  const actual = (ownKeys as string[]).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === expected.length &&
    actual.every((key) => sortedExpected.includes(key))
  );
}

function memoizeRead<T>(operation: () => T): () => T {
  let state: "UNREAD" | "VALUE" | "ERROR" = "UNREAD";
  let value: T;
  let error: unknown;
  return () => {
    if (state === "VALUE") return value;
    if (state === "ERROR") throw error;
    try {
      value = operation();
      state = "VALUE";
      return value;
    } catch (caught) {
      error = caught;
      state = "ERROR";
      throw caught;
    }
  };
}

function snapshotRawMetadata(
  value: unknown,
  readText: () => unknown,
): RawIngressMetadata | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some(
        (key) => typeof key !== "string" || !RAW_METADATA_ALLOWED_KEYS.has(key),
      ) ||
      RAW_METADATA_REQUIRED_KEYS.some(
        (key) => !Object.prototype.hasOwnProperty.call(value, key),
      )
    ) {
      return null;
    }

    const record = value as Record<string, unknown>;
    const snapshot: Record<string, unknown> = {
      appId: record.appId,
      tenantKey: record.tenantKey,
      eventType: record.eventType,
      chatType: record.chatType,
      senderOpenId: record.senderOpenId,
      chatId: record.chatId,
    };
    if (Object.prototype.hasOwnProperty.call(value, "signatureVerified")) {
      snapshot.signatureVerified = record.signatureVerified;
    }
    if (Object.prototype.hasOwnProperty.call(value, "callbackNonce")) {
      snapshot.callbackNonce = record.callbackNonce;
    }
    if (Object.prototype.hasOwnProperty.call(value, "callbackPayloadHash")) {
      snapshot.callbackPayloadHash = record.callbackPayloadHash;
    }
    if (Object.prototype.hasOwnProperty.call(value, "text")) {
      Object.defineProperty(snapshot, "text", {
        enumerable: true,
        configurable: false,
        get: readText,
      });
    }
    return Object.freeze(snapshot) as RawIngressMetadata;
  } catch {
    return null;
  }
}

function snapshotIngressDecision(value: unknown): IngressDecision | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  try {
    const record = value as Record<string, unknown>;
    const kind = record.kind;
    if (kind === "allow_task" || kind === "allow_pairing") {
      return exactKeys(value, ["kind"]) ? Object.freeze({ kind }) : null;
    }
    if (kind === "deny" && exactKeys(value, ["kind", "reason"])) {
      const reason = record.reason;
      return typeof reason === "string" && DENY_REASONS.has(reason)
        ? (Object.freeze({ kind, reason }) as IngressDecision)
        : null;
    }
    if (
      kind !== "allow_card" ||
      !exactKeys(value, ["kind", "nonce", "payloadHash"])
    ) {
      return null;
    }
    const nonce = record.nonce;
    const payloadHash = record.payloadHash;
    if (
      typeof nonce !== "string" ||
      nonce.length === 0 ||
      nonce.length > 256 ||
      nonce !== nonce.trim() ||
      !isCanonicalSha256Digest(payloadHash)
    ) {
      return null;
    }
    return Object.freeze({ kind, nonce, payloadHash });
  } catch {
    return null;
  }
}

function stableEnvelope(
  raw: RawEnvelope,
  metadata: RawIngressMetadata,
  readText: () => unknown,
  readBody: () => unknown,
  readResources: () => unknown,
): RawEnvelope {
  const readEventId = memoizeRead(() => raw.eventId);
  const readMessageId = memoizeRead(() => raw.messageId);
  const readReceivedAt = memoizeRead(() => raw.receivedAt);
  return Object.freeze({
    metadata,
    get eventId() {
      return readEventId();
    },
    get messageId() {
      return readMessageId();
    },
    get receivedAt() {
      return readReceivedAt();
    },
    readText,
    readBody,
    readResources,
  });
}

function isExactIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value === value.trim()
  );
}

function parseCancelRequest(value: unknown): CancelActiveTaskRequest | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value, [
      "appId",
      "tenantKey",
      "eventId",
      "messageId",
      "senderOpenId",
      "chatId",
      "receivedAt",
    ])
  ) {
    return null;
  }
  try {
    const request = value as Record<string, unknown>;
    const appId = request.appId;
    const tenantKey = request.tenantKey;
    const eventId = request.eventId;
    const messageId = request.messageId;
    const senderOpenId = request.senderOpenId;
    const chatId = request.chatId;
    const receivedAt = request.receivedAt;
    if (
      !isExactIdentifier(appId) ||
      !isExactIdentifier(tenantKey) ||
      !isExactIdentifier(eventId) ||
      !isExactIdentifier(messageId) ||
      !isExactIdentifier(senderOpenId) ||
      !isExactIdentifier(chatId) ||
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
      receivedAt,
    });
  } catch {
    return null;
  }
}

function parseCancelResult(value: unknown): CancelActiveTaskResult | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value, [
      "controlEventId",
      "taskId",
      "cancelled",
      "duplicate",
      "externalEffectsPending",
    ])
  ) {
    return null;
  }
  try {
    const result = value as Record<string, unknown>;
    const controlEventId = result.controlEventId;
    const taskId = result.taskId;
    const cancelled = result.cancelled;
    const duplicate = result.duplicate;
    const externalEffectsPending = result.externalEffectsPending;
    if (
      !isExactIdentifier(controlEventId) ||
      (taskId !== null && !isExactIdentifier(taskId)) ||
      typeof cancelled !== "boolean" ||
      typeof duplicate !== "boolean" ||
      typeof externalEffectsPending !== "boolean"
    ) {
      return null;
    }
    return Object.freeze({
      controlEventId,
      taskId,
      cancelled,
      duplicate,
      externalEffectsPending,
    });
  } catch {
    return null;
  }
}

function parseTaskAcceptance(
  value: unknown,
): Awaited<ReturnType<TaskSink["ingest"]>> | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value, ["taskId", "duplicate"])
  ) {
    return null;
  }
  try {
    const accepted = value as Record<string, unknown>;
    const taskId = accepted.taskId;
    const duplicate = accepted.duplicate;
    if (!isExactIdentifier(taskId) || typeof duplicate !== "boolean") {
      return null;
    }
    return Object.freeze({ taskId, duplicate });
  } catch {
    return null;
  }
}

function snapshotInboundEvent(value: unknown): unknown {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value, [
      "appId",
      "tenantKey",
      "eventId",
      "messageId",
      "senderOpenId",
      "chatId",
      "chatType",
      "eventType",
      "receivedAt",
      "payloadRef",
    ])
  ) {
    return null;
  }
  try {
    const event = value as Record<string, unknown>;
    return Object.freeze({
      appId: event.appId,
      tenantKey: event.tenantKey,
      eventId: event.eventId,
      messageId: event.messageId,
      senderOpenId: event.senderOpenId,
      chatId: event.chatId,
      chatType: event.chatType,
      eventType: event.eventType,
      receivedAt: event.receivedAt,
      payloadRef: event.payloadRef,
    });
  } catch {
    return null;
  }
}

function cancellationMatches(raw: RawEnvelope): boolean {
  const text = raw.readText();
  return (
    typeof text === "string" && CANCEL_PHRASES.has(text.normalize("NFC").trim())
  );
}

function cancellationReplyKind(
  result: CancelActiveTaskResult,
): CancellationReplyKind {
  if (!result.cancelled) return "NOT_RUNNING";
  return result.externalEffectsPending
    ? "CANCELLED_RECONCILING_EXTERNAL_EFFECTS"
    : "CANCELLED_NO_EXTERNAL_EFFECTS";
}

async function callFixed(
  operation: () => Promise<void>,
  message: string,
): Promise<void> {
  try {
    await operation();
  } catch {
    throw fixedError(message);
  }
}

export function createAssistantChannel(
  dependencies: AssistantChannelDependencies,
): AssistantChannel {
  return {
    async handle(raw): Promise<void> {
      const readText = memoizeRead(() => raw.readText());
      const readBody = memoizeRead(() => raw.readBody());
      const readResources = memoizeRead(() => raw.readResources());
      let metadata: RawIngressMetadata;
      let decision: IngressDecision;
      try {
        const projectedMetadata = snapshotRawMetadata(raw.metadata, readText);
        if (projectedMetadata === null) {
          throw fixedError(ASSISTANT_CHANNEL_ERROR.INGRESS_GUARD_FAILED);
        }
        metadata = projectedMetadata;
        const projectedDecision = snapshotIngressDecision(
          dependencies.ingressGuard(metadata),
        );
        if (projectedDecision === null) {
          throw fixedError(ASSISTANT_CHANNEL_ERROR.INGRESS_GUARD_FAILED);
        }
        decision = projectedDecision;
      } catch {
        throw fixedError(ASSISTANT_CHANNEL_ERROR.INGRESS_GUARD_FAILED);
      }

      if (decision.kind === "deny") return;
      const stableRaw = stableEnvelope(
        raw,
        metadata,
        readText,
        readBody,
        readResources,
      );
      if (decision.kind === "allow_pairing") {
        await callFixed(
          () => dependencies.pairingSink.consume(stableRaw),
          ASSISTANT_CHANNEL_ERROR.PAIRING_SINK_FAILED,
        );
        return;
      }
      if (decision.kind === "allow_card") {
        await callFixed(
          () =>
            dependencies.confirmationSink.consume(
              stableRaw,
              Object.freeze({
                nonce: decision.nonce,
                payloadHash: decision.payloadHash,
              }),
            ),
          ASSISTANT_CHANNEL_ERROR.CONFIRMATION_SINK_FAILED,
        );
        return;
      }

      let isCancellation: boolean;
      try {
        isCancellation = cancellationMatches(stableRaw);
      } catch {
        throw fixedError(ASSISTANT_CHANNEL_ERROR.CANCEL_CLASSIFICATION_FAILED);
      }

      if (isCancellation) {
        let request: CancelActiveTaskRequest;
        try {
          const normalized =
            dependencies.normalizer.toCancelActiveTaskRequest(stableRaw);
          const parsed = parseCancelRequest(normalized);
          if (parsed === null) throw new Error("invalid cancel request");
          request = parsed;
        } catch {
          throw fixedError(ASSISTANT_CHANNEL_ERROR.CANCEL_NORMALIZATION_FAILED);
        }
        let result: CancelActiveTaskResult;
        try {
          const cancelled =
            await dependencies.taskControlSink.cancelActive(request);
          const parsed = parseCancelResult(cancelled);
          if (parsed === null) throw new Error("invalid cancel result");
          result = parsed;
        } catch {
          throw fixedError(ASSISTANT_CHANNEL_ERROR.CANCEL_SINK_FAILED);
        }
        if (result.duplicate) return;
        await sendCancellationReply(
          dependencies.gateway,
          result.controlEventId,
          cancellationReplyKind(result),
        );
        return;
      }

      let event: InboundEvent;
      try {
        const normalized = dependencies.normalizer.toInboundEvent(stableRaw);
        const parsed = InboundEventSchema.safeParse(
          snapshotInboundEvent(normalized),
        );
        if (!parsed.success) throw new Error("invalid inbound event");
        event = parsed.data;
      } catch {
        throw fixedError(ASSISTANT_CHANNEL_ERROR.TASK_NORMALIZATION_FAILED);
      }
      let accepted: Awaited<ReturnType<TaskSink["ingest"]>>;
      try {
        const result = await dependencies.taskSink.ingest(event);
        const parsed = parseTaskAcceptance(result);
        if (parsed === null) throw new Error("invalid task acceptance");
        accepted = parsed;
      } catch {
        throw fixedError(ASSISTANT_CHANNEL_ERROR.TASK_INGEST_FAILED);
      }
      if (accepted.duplicate) return;
      await sendTaskAcceptedReply(dependencies.gateway, accepted.taskId);
      try {
        await dependencies.scheduler.wake();
      } catch {
        throw fixedError(ASSISTANT_CHANNEL_ERROR.SCHEDULER_WAKE_FAILED);
      }
    },
  };
}
