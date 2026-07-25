import {
  createLarkChannel,
  type CardActionEvent,
  type LarkChannel,
  type LarkChannelOptions,
  type NormalizedMessage,
} from "@larksuiteoapi/node-sdk";
import type {
  CardVerificationInput,
  LifecycleState,
  SdkCardActionEvent,
  SdkMessageEvent,
  TrustedCardEvidence,
} from "@executive-assistant/bridge";
import { createHash, timingSafeEqual } from "node:crypto";
import { types as utilTypes } from "node:util";

import type {
  RuntimeConfirmationCard,
  RuntimeAcknowledgement,
  RuntimeFileReply,
  RuntimeTenantBindingRequest,
  RuntimeTextReply,
  RuntimeTransport,
} from "./types.js";

type CreateLarkChannel = (options: LarkChannelOptions) => LarkChannel;

export type BuiltInLarkTransportOptions = Readonly<{
  appId: string;
  appSecret: string;
  createChannel?: CreateLarkChannel;
}>;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER_MAX_LENGTH = 512;
const MAX_BUFFERED_MESSAGES = 32;
const ignoreLarkSdkLog = (): void => undefined;
const SILENT_LARK_SDK_LOGGER = Object.freeze({
  error: ignoreLarkSdkLog,
  warn: ignoreLarkSdkLog,
  info: ignoreLarkSdkLog,
  debug: ignoreLarkSdkLog,
  trace: ignoreLarkSdkLog,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rawReplyMessageId(value: unknown): string | null {
  try {
    if (!isRecord(value) || utilTypes.isProxy(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const code = descriptors.code;
    const data = descriptors.data;
    if (
      code === undefined ||
      !("value" in code) ||
      code.value !== 0 ||
      data === undefined ||
      !("value" in data) ||
      !isRecord(data.value) ||
      utilTypes.isProxy(data.value)
    ) {
      return null;
    }
    const messageId = Object.getOwnPropertyDescriptor(data.value, "message_id");
    return messageId !== undefined &&
      "value" in messageId &&
      isExactIdentifier(messageId.value)
      ? messageId.value
      : null;
  } catch {
    return null;
  }
}

function isExactIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= IDENTIFIER_MAX_LENGTH &&
    value === value.trim() &&
    !value.includes("\0")
  );
}

function rawTenantKey(message: NormalizedMessage): string | null {
  if (!isRecord(message.raw) || !isRecord(message.raw.sender)) return null;
  const tenantKey = message.raw.sender.tenant_key;
  return isExactIdentifier(tenantKey) ? tenantKey : null;
}

function pairingCodeMatches(value: unknown, expectedHash: string): boolean {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    !SHA256_PATTERN.test(expectedHash)
  ) {
    return false;
  }
  const actual = createHash("sha256").update(value, "utf8").digest();
  const expected = Buffer.from(expectedHash.slice("sha256:".length), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function snapshotTenantBindingRequest(
  value: RuntimeTenantBindingRequest,
): RuntimeTenantBindingRequest {
  const expectedTenantKey = value.expectedTenantKey;
  const presidentOpenId = value.presidentOpenId;
  const presidentChatId = value.presidentChatId;
  const pairingCodeHash = value.pairingCodeHash;
  const pairingExpiresAt = value.pairingExpiresAt;
  const expected =
    expectedTenantKey === null || isExactIdentifier(expectedTenantKey);
  const hasPresident =
    isExactIdentifier(presidentOpenId) && isExactIdentifier(presidentChatId);
  const noPresident = presidentOpenId === null && presidentChatId === null;
  const hasPairing =
    typeof pairingCodeHash === "string" &&
    SHA256_PATTERN.test(pairingCodeHash) &&
    typeof pairingExpiresAt === "string" &&
    Number.isFinite(Date.parse(pairingExpiresAt));
  const noPairing = pairingCodeHash === null && pairingExpiresAt === null;
  if (
    !expected ||
    !(
      expectedTenantKey !== null ||
      (hasPresident && noPairing) ||
      (noPresident && hasPairing)
    )
  ) {
    throw new Error("LARK_TENANT_BINDING_INVALID");
  }
  return Object.freeze({
    expectedTenantKey,
    presidentOpenId,
    presidentChatId,
    pairingCodeHash,
    pairingExpiresAt,
  });
}

function matchesTenantBinding(
  message: NormalizedMessage,
  request: RuntimeTenantBindingRequest,
): boolean {
  if (message.chatType !== "p2p") return false;
  if (request.presidentOpenId !== null && request.presidentChatId !== null) {
    return (
      message.senderId === request.presidentOpenId &&
      message.chatId === request.presidentChatId
    );
  }
  return (
    request.pairingCodeHash !== null &&
    request.pairingExpiresAt !== null &&
    Date.now() <= Date.parse(request.pairingExpiresAt) &&
    pairingCodeMatches(message.content, request.pairingCodeHash)
  );
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (!isRecord(value)) throw new Error("CARD_ACTION_INVALID");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function cardHash(action: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(action), "utf8")
    .digest("hex")}`;
}

function cardEvidenceKey(
  messageId: string,
  chatId: string,
  senderOpenId: string,
): string {
  return `${messageId}\u0000${chatId}\u0000${senderOpenId}`;
}

function confirmationPreview(card: RuntimeConfirmationCard): string {
  const serialized = JSON.stringify(card.preview, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > 16 * 1024) {
    throw new Error("CONFIRMATION_PREVIEW_TOO_LARGE");
  }
  return [
    "**请核对后确认**",
    "",
    "```json",
    serialized,
    "```",
    "",
    `本确认入口将在 ${card.expiresAt} 失效。`,
  ].join("\n");
}

function rawMessageEvent(
  message: NormalizedMessage,
  appId: string,
  tenantKey: string,
): Readonly<Record<string, unknown>> | null {
  if (!isRecord(message.raw)) return null;
  const sender = message.raw.sender;
  const rawMessage = message.raw.message;
  if (!isRecord(sender) || !isRecord(rawMessage)) return null;
  const senderId = sender.sender_id;
  if (
    !isRecord(senderId) ||
    senderId.open_id !== message.senderId ||
    sender.tenant_key !== tenantKey ||
    rawMessage.message_id !== message.messageId ||
    rawMessage.chat_id !== message.chatId ||
    rawMessage.chat_type !== message.chatType ||
    typeof rawMessage.content !== "string"
  ) {
    return null;
  }
  const projectedSenderId = Object.freeze({
    union_id: senderId.union_id,
    user_id: senderId.user_id,
    open_id: senderId.open_id,
  });
  const projectedSender = Object.freeze({
    sender_id: projectedSenderId,
    sender_type: sender.sender_type,
    tenant_key: sender.tenant_key,
  });
  const projectedMessage = Object.freeze({
    message_id: rawMessage.message_id,
    root_id: rawMessage.root_id,
    parent_id: rawMessage.parent_id,
    create_time: rawMessage.create_time,
    chat_id: rawMessage.chat_id,
    chat_type: rawMessage.chat_type,
    message_type: rawMessage.message_type,
    content: rawMessage.content,
    mentions: rawMessage.mentions,
    user_agent: rawMessage.user_agent,
  });
  return Object.freeze({
    header: Object.freeze({
      event_id: `message:${message.messageId}`,
      event_type: "im.message.receive_v1",
      app_id: appId,
      tenant_key: tenantKey,
    }),
    event: Object.freeze({
      sender: projectedSender,
      message: projectedMessage,
    }),
  });
}

function sdkMessageEvent(
  message: NormalizedMessage,
  appId: string,
  tenantKey: string,
): SdkMessageEvent | null {
  const raw = rawMessageEvent(message, appId, tenantKey);
  if (raw === null) return null;
  return Object.freeze({
    messageId: message.messageId,
    chatId: message.chatId,
    chatType: message.chatType,
    senderId: message.senderId,
    createTime: message.createTime,
    content: message.content,
    resources: Object.freeze([...message.resources]),
    raw,
  });
}

export function createBuiltInLarkTransport(
  options: BuiltInLarkTransportOptions,
): RuntimeTransport {
  if (options.appId.length === 0 || options.appSecret.length === 0) {
    throw new Error("LARK_TRANSPORT_CONFIG_INVALID");
  }
  const createChannel = options.createChannel ?? createLarkChannel;
  const channel = createChannel({
    appId: options.appId,
    appSecret: options.appSecret,
    transport: "websocket",
    includeRawEvent: true,
    source: "executive-assistant-runtime",
    logger: SILENT_LARK_SDK_LOGGER,
    policy: {
      dmMode: "open",
      requireMention: true,
      respondToMentionAll: false,
    },
  });
  let messageHandler: ((event: SdkMessageEvent) => Promise<void>) | undefined;
  let cardHandler: ((event: SdkCardActionEvent) => Promise<void>) | undefined;
  let lifecycleHandler:
    | ((state: LifecycleState, detail?: unknown) => void)
    | undefined;
  let boundTenantKey: string | undefined;
  const bufferedMessages: SdkMessageEvent[] = [];
  let messageDeliveryTail: Promise<void> = Promise.resolve();
  let connected = false;
  let connectPromise: Promise<void> | undefined;
  let tenantResolution:
    | {
        request: RuntimeTenantBindingRequest;
        promise: Promise<string>;
        resolve: (tenantKey: string) => void;
      }
    | undefined;
  const cardEvidence = new Map<string, TrustedCardEvidence>();

  const deliverMessage = (event: SdkMessageEvent): Promise<void> => {
    const handler = messageHandler;
    if (!handler) return Promise.resolve();
    const delivery = messageDeliveryTail.then(() => handler(event));
    messageDeliveryTail = delivery.catch(() => undefined);
    return delivery;
  };

  const bufferMessage = (event: SdkMessageEvent): void => {
    if (bufferedMessages.length < MAX_BUFFERED_MESSAGES) {
      bufferedMessages.push(event);
    }
  };

  const ensureConnected = (): Promise<void> => {
    if (connectPromise) return connectPromise;
    lifecycleHandler?.("WS_CONNECTING");
    connectPromise = channel
      .connect()
      .then(() => {
        connected = true;
        lifecycleHandler?.("WS_CONNECTED");
      })
      .catch((cause) => {
        lifecycleHandler?.("WS_ERROR", cause);
        throw cause;
      });
    return connectPromise;
  };

  channel.on("message", async (message: NormalizedMessage) => {
    const candidateTenantKey = rawTenantKey(message);
    if (candidateTenantKey === null) return;
    if (boundTenantKey === undefined) {
      const pending = tenantResolution;
      if (!pending || !matchesTenantBinding(message, pending.request)) {
        return;
      }
      const event = sdkMessageEvent(message, options.appId, candidateTenantKey);
      if (event === null) return;
      boundTenantKey = candidateTenantKey;
      bufferMessage(event);
      pending.resolve(candidateTenantKey);
      return;
    }
    const event = sdkMessageEvent(message, options.appId, boundTenantKey);
    if (event === null) return;
    if (!messageHandler) {
      bufferMessage(event);
      return;
    }
    await deliverMessage(event);
  });
  channel.on("cardAction", async (event: CardActionEvent) => {
    const tenantKey = boundTenantKey;
    if (!cardHandler || tenantKey === undefined) return;
    const action = Object.freeze({
      value: event.action.value,
      tag: event.action.tag,
      ...(typeof event.action.name === "string"
        ? { name: event.action.name }
        : {}),
      ...(typeof event.action.option === "string"
        ? { option: event.action.option }
        : {}),
    });
    const value = isRecord(action.value) ? action.value : null;
    const nonce = value?.nonce;
    if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 256) {
      return;
    }
    const payloadHash = cardHash(action);
    const evidenceKey = cardEvidenceKey(
      event.messageId,
      event.chatId,
      event.operator.openId,
    );
    const eventId = `card:${createHash("sha256")
      .update(`${evidenceKey}\u0000${payloadHash}`, "utf8")
      .digest("hex")}`;
    cardEvidence.set(
      evidenceKey,
      Object.freeze({
        appId: options.appId,
        tenantKey,
        eventId,
        messageId: event.messageId,
        senderOpenId: event.operator.openId,
        chatId: event.chatId,
        chatType: "p2p",
        signatureVerified: true,
        nonce,
        payloadHash,
        receivedAt: new Date().toISOString(),
      }),
    );
    try {
      await cardHandler(
        Object.freeze({
          messageId: event.messageId,
          chatId: event.chatId,
          operator: Object.freeze({ ...event.operator }),
          action,
          raw: event.raw,
        }),
      );
    } finally {
      cardEvidence.delete(evidenceKey);
    }
  });
  channel.on("reconnecting", () => {
    lifecycleHandler?.("WS_RECONNECTING");
  });
  channel.on("reconnected", () => {
    lifecycleHandler?.("WS_RECONNECTED");
  });
  channel.on("error", (error) => {
    lifecycleHandler?.("WS_ERROR", error);
  });

  return Object.freeze({
    async resolveTenantKey(request: RuntimeTenantBindingRequest) {
      const stableRequest = snapshotTenantBindingRequest(request);
      if (boundTenantKey !== undefined) {
        if (
          stableRequest.expectedTenantKey !== null &&
          stableRequest.expectedTenantKey !== boundTenantKey
        ) {
          throw new Error("LARK_TENANT_BINDING_MISMATCH");
        }
        return boundTenantKey;
      }
      if (stableRequest.expectedTenantKey !== null) {
        boundTenantKey = stableRequest.expectedTenantKey;
        return boundTenantKey;
      }
      if (!tenantResolution) {
        let resolveTenant!: (tenantKey: string) => void;
        const promise = new Promise<string>((resolve) => {
          resolveTenant = resolve;
        });
        tenantResolution = {
          request: stableRequest,
          promise,
          resolve: resolveTenant,
        };
      }
      try {
        await ensureConnected();
      } catch {
        tenantResolution = undefined;
        throw new Error("LARK_TENANT_BINDING_FAILED");
      }
      const pending = tenantResolution;
      const expiresAt = pending.request.pairingExpiresAt;
      if (expiresAt === null) return pending.promise;
      const remainingMs = Date.parse(expiresAt) - Date.now();
      if (remainingMs <= 0) {
        tenantResolution = undefined;
        throw new Error("LARK_TENANT_BINDING_EXPIRED");
      }
      let expiryTimer: NodeJS.Timeout | undefined;
      try {
        const resolved = await Promise.race([
          pending.promise,
          new Promise<never>((_resolve, reject) => {
            expiryTimer = setTimeout(
              () => reject(new Error("LARK_TENANT_BINDING_EXPIRED")),
              Math.min(remainingMs, 2_147_483_647),
            );
          }),
        ]);
        if (tenantResolution === pending) tenantResolution = undefined;
        return resolved;
      } catch (cause) {
        if (tenantResolution === pending) tenantResolution = undefined;
        throw cause;
      } finally {
        if (expiryTimer) clearTimeout(expiryTimer);
      }
    },
    async onMessage(handler: (event: SdkMessageEvent) => Promise<void>) {
      messageHandler = handler;
      const pending = bufferedMessages.splice(0);
      await Promise.all(pending.map((event) => deliverMessage(event)));
    },
    onCardAction(handler: (event: SdkCardActionEvent) => Promise<void>) {
      cardHandler = handler;
    },
    onLifecycle(handler: (state: LifecycleState, detail?: unknown) => void) {
      lifecycleHandler = handler;
      if (connected) handler("WS_CONNECTED");
    },
    async connect() {
      await ensureConnected();
    },
    async disconnect() {
      if (connectPromise) await channel.disconnect();
      connected = false;
      lifecycleHandler?.("WS_DISCONNECTED");
    },
    async sendText(reply: RuntimeTextReply) {
      const result = await channel.send(
        reply.chatId,
        { text: reply.text },
        { replyTo: reply.replyToMessageId },
      );
      return Object.freeze({ messageId: result.messageId });
    },
    async sendAcknowledgement(acknowledgement: RuntimeAcknowledgement) {
      const result = await channel.rawClient.im.v1.message.reply({
        data: {
          content: JSON.stringify({ text: acknowledgement.text }),
          msg_type: "text",
        },
        path: { message_id: acknowledgement.replyToMessageId },
      });
      const messageId = rawReplyMessageId(result);
      if (messageId === null) throw new Error("LARK_ACKNOWLEDGEMENT_FAILED");
      return Object.freeze({ messageId });
    },
    async sendFile(reply: RuntimeFileReply) {
      const result = await channel.send(
        reply.chatId,
        {
          file: {
            source: reply.path,
            fileName: reply.fileName,
          },
        },
        { replyTo: reply.replyToMessageId },
      );
      return Object.freeze({ messageId: result.messageId });
    },
    async sendConfirmationCard(card: RuntimeConfirmationCard) {
      const buttonValue = Object.freeze({
        version: 1,
        actionId: card.actionId,
        actionPayloadHash: card.actionPayloadHash,
        nonce: card.nonce,
      });
      const result = await channel.send(
        card.chatId,
        {
          card: {
            schema: "2.0",
            config: { wide_screen_mode: true },
            header: {
              template: "orange",
              title: { tag: "plain_text", content: "请确认执行" },
            },
            body: {
              elements: [
                {
                  tag: "markdown",
                  content: confirmationPreview(card),
                },
                {
                  tag: "action",
                  actions: [
                    {
                      tag: "button",
                      type: "primary",
                      text: { tag: "plain_text", content: "确认执行" },
                      value: { ...buttonValue, decision: "approve" },
                    },
                    {
                      tag: "button",
                      type: "default",
                      text: { tag: "plain_text", content: "取消" },
                      value: { ...buttonValue, decision: "reject" },
                    },
                  ],
                },
              ],
            },
          },
        },
        { replyTo: card.replyToMessageId },
      );
      return Object.freeze({ messageId: result.messageId });
    },
    async verifyCardAction(input: CardVerificationInput) {
      return (
        cardEvidence.get(
          cardEvidenceKey(input.messageId, input.chatId, input.senderOpenId),
        ) ?? null
      );
    },
  });
}
