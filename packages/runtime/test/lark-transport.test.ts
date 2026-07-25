import { createHash } from "node:crypto";

import type {
  CardActionEvent,
  LarkChannel,
  NormalizedMessage,
} from "@larksuiteoapi/node-sdk";
import { describe, expect, it } from "vitest";

import { createBuiltInLarkTransport } from "../src/lark-transport.js";

class FakeLarkChannel {
  messageHandler:
    | ((message: NormalizedMessage) => void | Promise<void>)
    | undefined;
  cardHandler: ((event: CardActionEvent) => void | Promise<void>) | undefined;
  reconnectingHandler: (() => void) | undefined;
  reconnectedHandler: (() => void) | undefined;
  errorHandler: ((error: Error) => void) | undefined;
  connectCalls = 0;
  disconnectCalls = 0;
  sendCalls = 0;
  rawReplyCalls: unknown[] = [];
  rawReplyFailure: unknown;
  rawReplyResult: unknown = {
    code: 0,
    msg: "success",
    data: { message_id: "fixture-ack-reply" },
  };
  readonly rawClient = {
    im: {
      v1: {
        message: {
          reply: async (input: unknown) => {
            this.rawReplyCalls.push(input);
            if (this.rawReplyFailure !== undefined) {
              throw this.rawReplyFailure;
            }
            return this.rawReplyResult;
          },
        },
      },
    },
  };

  on(name: string, handler: unknown): () => void {
    if (name === "message") {
      this.messageHandler = handler as (
        message: NormalizedMessage,
      ) => void | Promise<void>;
    } else if (name === "cardAction") {
      this.cardHandler = handler as (
        event: CardActionEvent,
      ) => void | Promise<void>;
    } else if (name === "reconnecting") {
      this.reconnectingHandler = handler as () => void;
    } else if (name === "reconnected") {
      this.reconnectedHandler = handler as () => void;
    } else if (name === "error") {
      this.errorHandler = handler as (error: Error) => void;
    }
    return () => undefined;
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
  }

  async send(): Promise<Readonly<{ messageId: string }>> {
    this.sendCalls += 1;
    return Object.freeze({ messageId: "fixture-reply" });
  }

  async emitMessage(message: NormalizedMessage): Promise<void> {
    await this.messageHandler?.(message);
  }
}

function normalizedMessage(
  sequence: number,
  tenantKey: string,
  content: string,
  chatType: "p2p" | "group" = "p2p",
): NormalizedMessage {
  const senderId = "ou_fixture_president";
  const chatId =
    chatType === "p2p" ? "oc_fixture_private_chat" : "oc_fixture_group";
  const messageId = `message-${sequence}`;
  const createTime = Date.now() + sequence;
  return Object.freeze({
    messageId,
    chatId,
    chatType,
    senderId,
    content,
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime,
    raw: Object.freeze({
      sender: Object.freeze({
        sender_id: Object.freeze({ open_id: senderId }),
        sender_type: "user",
        tenant_key: tenantKey,
      }),
      message: Object.freeze({
        message_id: messageId,
        create_time: String(createTime),
        chat_id: chatId,
        chat_type: chatType,
        message_type: "text",
        content: JSON.stringify({ text: content }),
        mentions: Object.freeze([]),
      }),
    }),
  });
}

describe("built-in Lark transport tenant binding", () => {
  it("sends acceptance ACK through one raw reply and never channel.send", async () => {
    const channel = new FakeLarkChannel();
    const transport = createBuiltInLarkTransport({
      appId: "cli_fixture_app",
      appSecret: "fixture",
      createChannel: () => channel as unknown as LarkChannel,
    });

    await expect(
      transport.sendAcknowledgement({
        chatId: "oc_fixture_private_chat",
        text: "收到，我开始处理",
        replyToMessageId: "message-fixture",
      }),
    ).resolves.toEqual({ messageId: "fixture-ack-reply" });

    expect(channel.sendCalls).toBe(0);
    expect(channel.rawReplyCalls).toEqual([
      {
        data: {
          content: '{"text":"收到，我开始处理"}',
          msg_type: "text",
        },
        path: { message_id: "message-fixture" },
      },
    ]);
  });

  it("never retries or falls back to channel.send after raw ACK failure", async () => {
    const channel = new FakeLarkChannel();
    channel.rawReplyFailure = new Error("synthetic raw reply failure");
    const transport = createBuiltInLarkTransport({
      appId: "cli_fixture_app",
      appSecret: "fixture",
      createChannel: () => channel as unknown as LarkChannel,
    });

    await expect(
      transport.sendAcknowledgement({
        chatId: "oc_fixture_private_chat",
        text: "收到，我开始处理",
        replyToMessageId: "message-fixture",
      }),
    ).rejects.toThrow("synthetic raw reply failure");

    expect(channel.rawReplyCalls).toHaveLength(1);
    expect(channel.sendCalls).toBe(0);
  });

  it("rejects a non-own-data raw success result without fallback", async () => {
    const channel = new FakeLarkChannel();
    channel.rawReplyResult = Object.create({
      code: 0,
      data: { message_id: "fixture-ack-reply" },
    });
    const transport = createBuiltInLarkTransport({
      appId: "cli_fixture_app",
      appSecret: "fixture",
      createChannel: () => channel as unknown as LarkChannel,
    });

    await expect(
      transport.sendAcknowledgement({
        chatId: "oc_fixture_private_chat",
        text: "收到，我开始处理",
        replyToMessageId: "message-fixture",
      }),
    ).rejects.toThrow("LARK_ACKNOWLEDGEMENT_FAILED");
    expect(channel.rawReplyCalls).toHaveLength(1);
    expect(channel.sendCalls).toBe(0);
  });

  it("binds only from the correct unexpired private pairing message and replays it once", async () => {
    const channel = new FakeLarkChannel();
    const transport = createBuiltInLarkTransport({
      appId: "cli_fixture_app",
      appSecret: "fixture",
      createChannel: () => channel as unknown as LarkChannel,
    });
    const pairingCode = "A1B2C3D4";
    const pairingCodeHash = `sha256:${createHash("sha256")
      .update(pairingCode, "utf8")
      .digest("hex")}`;
    let settled = false;
    const binding = transport.resolveTenantKey({
      expectedTenantKey: null,
      presidentOpenId: null,
      presidentChatId: null,
      pairingCodeHash,
      pairingExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    void binding.then(() => {
      settled = true;
    });

    await channel.emitMessage(
      normalizedMessage(1, "tenant_fixture", "WRONG-CODE"),
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    await channel.emitMessage(
      normalizedMessage(2, "tenant_fixture", pairingCode, "group"),
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    await channel.emitMessage(
      normalizedMessage(3, "tenant_fixture", pairingCode),
    );
    await channel.emitMessage(
      normalizedMessage(4, "tenant_fixture", "first instruction"),
    );
    await expect(binding).resolves.toBe("tenant_fixture");
    expect(channel.connectCalls).toBe(1);

    const received: string[] = [];
    await transport.onMessage(async (event) => {
      received.push(event.messageId as string);
    });
    expect(received).toEqual(["message-3", "message-4"]);
  });

  it("keeps rejecting a different tenant after the first trusted binding", async () => {
    const channel = new FakeLarkChannel();
    const transport = createBuiltInLarkTransport({
      appId: "cli_fixture_app",
      appSecret: "fixture",
      createChannel: () => channel as unknown as LarkChannel,
    });
    await expect(
      transport.resolveTenantKey({
        expectedTenantKey: "tenant_fixture",
        presidentOpenId: "ou_fixture_president",
        presidentChatId: "oc_fixture_private_chat",
        pairingCodeHash: null,
        pairingExpiresAt: null,
      }),
    ).resolves.toBe("tenant_fixture");

    const received: string[] = [];
    await transport.onMessage(async (event) => {
      received.push(event.messageId as string);
    });
    await transport.connect();
    await channel.emitMessage(
      normalizedMessage(5, "tenant_other", "should be rejected"),
    );
    await channel.emitMessage(
      normalizedMessage(6, "tenant_fixture", "accepted"),
    );

    expect(received).toEqual(["message-6"]);
    expect(channel.connectCalls).toBe(1);
  });

  it("fails closed when the one-time pairing code is already expired", async () => {
    const channel = new FakeLarkChannel();
    const transport = createBuiltInLarkTransport({
      appId: "cli_fixture_app",
      appSecret: "fixture",
      createChannel: () => channel as unknown as LarkChannel,
    });
    const pairingCodeHash = `sha256:${createHash("sha256")
      .update("EXPIRED", "utf8")
      .digest("hex")}`;

    await expect(
      transport.resolveTenantKey({
        expectedTenantKey: null,
        presidentOpenId: null,
        presidentChatId: null,
        pairingCodeHash,
        pairingExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    ).rejects.toThrow("LARK_TENANT_BINDING_EXPIRED");
    expect(channel.connectCalls).toBe(1);
  });
});
