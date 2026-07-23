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
import { createHash } from "node:crypto";

import type {
  RuntimeConfirmationCard,
  RuntimeFileReply,
  RuntimeTextReply,
  RuntimeTransport,
} from "./types.js";

type CreateLarkChannel = (options: LarkChannelOptions) => LarkChannel;

export type BuiltInLarkTransportOptions = Readonly<{
  appId: string;
  tenantKey: string;
  appSecret: string;
  createChannel?: CreateLarkChannel;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

export function createBuiltInLarkTransport(
  options: BuiltInLarkTransportOptions,
): RuntimeTransport {
  if (
    options.appId.length === 0 ||
    options.tenantKey.length === 0 ||
    options.appSecret.length === 0
  ) {
    throw new Error("LARK_TRANSPORT_CONFIG_INVALID");
  }
  const createChannel = options.createChannel ?? createLarkChannel;
  const channel = createChannel({
    appId: options.appId,
    appSecret: options.appSecret,
    transport: "websocket",
    includeRawEvent: true,
    source: "executive-assistant-runtime",
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
  const cardEvidence = new Map<string, TrustedCardEvidence>();

  channel.on("message", async (message: NormalizedMessage) => {
    const raw = rawMessageEvent(message, options.appId, options.tenantKey);
    if (!messageHandler || raw === null) return;
    await messageHandler(
      Object.freeze({
        messageId: message.messageId,
        chatId: message.chatId,
        chatType: message.chatType,
        senderId: message.senderId,
        createTime: message.createTime,
        content: message.content,
        resources: Object.freeze([...message.resources]),
        raw,
      }),
    );
  });
  channel.on("cardAction", async (event: CardActionEvent) => {
    if (!cardHandler) return;
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
        tenantKey: options.tenantKey,
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
    onMessage(handler: (event: SdkMessageEvent) => Promise<void>) {
      messageHandler = handler;
    },
    onCardAction(handler: (event: SdkCardActionEvent) => Promise<void>) {
      cardHandler = handler;
    },
    onLifecycle(handler: (state: LifecycleState, detail?: unknown) => void) {
      lifecycleHandler = handler;
    },
    async connect() {
      lifecycleHandler?.("WS_CONNECTING");
      try {
        await channel.connect();
        lifecycleHandler?.("WS_CONNECTED");
      } catch (cause) {
        lifecycleHandler?.("WS_ERROR", cause);
        throw cause;
      }
    },
    async disconnect() {
      await channel.disconnect();
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
