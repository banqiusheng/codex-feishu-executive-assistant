import { createHash } from "node:crypto";

import type {
  CardActionEvent,
  HttpInstance,
  HttpRequestOptions,
  LarkChannel,
  LarkChannelOptions,
  NormalizedMessage,
} from "@larksuiteoapi/node-sdk";
import { describe, expect, it, vi } from "vitest";

import { createBuiltInLarkTransport } from "../src/lark-transport.js";

class RecordingHttpInstance implements HttpInstance {
  readonly calls: Array<
    Readonly<{
      method: string;
      url: string | undefined;
      timeout: number | undefined;
    }>
  > = [];

  constructor(
    private readonly response: (
      method: string,
      url: string | undefined,
    ) => unknown = () => Object.freeze({}),
  ) {}

  private record<R>(
    method: string,
    url: string | undefined,
    options: HttpRequestOptions<unknown> | undefined,
  ): Promise<R> {
    this.calls.push(Object.freeze({ method, url, timeout: options?.timeout }));
    return Promise.resolve(this.response(method, url) as R);
  }

  request<T = unknown, R = T, D = unknown>(
    options: HttpRequestOptions<D>,
  ): Promise<R> {
    return this.record<R>(
      "request",
      options.url,
      options as HttpRequestOptions<unknown>,
    );
  }

  get<T = unknown, R = T, D = unknown>(
    url: string,
    options?: HttpRequestOptions<D>,
  ): Promise<R> {
    return this.record<R>(
      "get",
      url,
      options as HttpRequestOptions<unknown> | undefined,
    );
  }

  delete<T = unknown, R = T, D = unknown>(
    url: string,
    options?: HttpRequestOptions<D>,
  ): Promise<R> {
    return this.record<R>(
      "delete",
      url,
      options as HttpRequestOptions<unknown> | undefined,
    );
  }

  head<T = unknown, R = T, D = unknown>(
    url: string,
    options?: HttpRequestOptions<D>,
  ): Promise<R> {
    return this.record<R>(
      "head",
      url,
      options as HttpRequestOptions<unknown> | undefined,
    );
  }

  options<T = unknown, R = T, D = unknown>(
    url: string,
    options?: HttpRequestOptions<D>,
  ): Promise<R> {
    return this.record<R>(
      "options",
      url,
      options as HttpRequestOptions<unknown> | undefined,
    );
  }

  post<T = unknown, R = T, D = unknown>(
    url: string,
    _data?: D,
    options?: HttpRequestOptions<D>,
  ): Promise<R> {
    return this.record<R>(
      "post",
      url,
      options as HttpRequestOptions<unknown> | undefined,
    );
  }

  put<T = unknown, R = T, D = unknown>(
    url: string,
    _data?: D,
    options?: HttpRequestOptions<D>,
  ): Promise<R> {
    return this.record<R>(
      "put",
      url,
      options as HttpRequestOptions<unknown> | undefined,
    );
  }

  patch<T = unknown, R = T, D = unknown>(
    url: string,
    _data?: D,
    options?: HttpRequestOptions<D>,
  ): Promise<R> {
    return this.record<R>(
      "patch",
      url,
      options as HttpRequestOptions<unknown> | undefined,
    );
  }
}

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
  it("binds a fixed-timeout HTTP wrapper that overrides caller timeout zero on every method", async () => {
    const channel = new FakeLarkChannel();
    const delegate = new RecordingHttpInstance();
    let channelOptions: LarkChannelOptions | undefined;
    createBuiltInLarkTransport({
      appId: "cli_fixture_app",
      appSecret: "fixture",
      httpInstance: delegate,
      acknowledgementHttpTimeoutMs: 17,
      createChannel: (options) => {
        channelOptions = options;
        return channel as unknown as LarkChannel;
      },
    });
    const bounded = channelOptions?.httpInstance;
    expect(bounded).toBeDefined();
    expect(bounded).not.toBe(delegate);

    await bounded?.request({
      url: "https://fixture.invalid/request",
      timeout: 0,
    });
    await bounded?.get("https://fixture.invalid/get", { timeout: 0 });
    await bounded?.delete("https://fixture.invalid/delete", { timeout: 0 });
    await bounded?.head("https://fixture.invalid/head", { timeout: 0 });
    await bounded?.options("https://fixture.invalid/options", { timeout: 0 });
    await bounded?.post("https://fixture.invalid/post", {}, { timeout: 0 });
    await bounded?.put("https://fixture.invalid/put", {}, { timeout: 0 });
    await bounded?.patch("https://fixture.invalid/patch", {}, { timeout: 0 });

    expect(delegate.calls.map((call) => call.timeout)).toEqual([
      17, 17, 17, 17, 17, 17, 17, 17,
    ]);
  });

  it("routes the SDK generated raw reply through the bounded delegate without network fallback", async () => {
    const delegate = new RecordingHttpInstance((_method, url) => {
      if (url?.includes("/auth/v3/tenant_access_token/internal")) {
        return Object.freeze({
          code: 0,
          msg: "success",
          tenant_access_token: "fixture-tenant-access-token",
          expire: 7_200,
        });
      }
      if (url?.includes("/im/v1/messages/")) {
        return Object.freeze({
          code: 0,
          msg: "success",
          data: Object.freeze({ message_id: "fixture-bounded-ack" }),
        });
      }
      throw new Error("UNEXPECTED_OFFLINE_HTTP_REQUEST");
    });
    const transport = createBuiltInLarkTransport({
      appId: "cli_fixture_app",
      appSecret: "fixture",
      httpInstance: delegate,
      acknowledgementHttpTimeoutMs: 19,
    });

    await expect(
      transport.sendAcknowledgement({
        chatId: "oc_fixture_private_chat",
        text: "收到，我开始处理",
        replyToMessageId: "message-fixture",
      }),
    ).resolves.toEqual({ messageId: "fixture-bounded-ack" });
    expect(delegate.calls).toHaveLength(2);
    expect(delegate.calls.map((call) => call.timeout)).toEqual([19, 19]);
    expect(delegate.calls.map((call) => call.method)).toEqual([
      "post",
      "request",
    ]);
  });

  it("installs a fixed no-op SDK logger that cannot expose sensitive arguments", async () => {
    const channel = new FakeLarkChannel();
    let channelOptions: LarkChannelOptions | undefined;
    const consoleOutput: unknown[] = [];
    const consoleSpies = (
      ["error", "warn", "info", "debug", "trace"] as const
    ).map((method) =>
      vi.spyOn(console, method).mockImplementation((...values: unknown[]) => {
        consoleOutput.push(...values);
      }),
    );
    let serializationAttempts = 0;
    const sensitive = Object.freeze({
      host: "sensitive-host.invalid",
      path: "/open-apis/im/v1/messages/sensitive-message",
      toJSON() {
        serializationAttempts += 1;
        return "SENSITIVE_SENTINEL";
      },
      toString() {
        serializationAttempts += 1;
        return "SENSITIVE_SENTINEL";
      },
    });

    try {
      const transport = createBuiltInLarkTransport({
        appId: "cli_fixture_app",
        appSecret: "fixture",
        createChannel: (options) => {
          channelOptions = options;
          return channel as unknown as LarkChannel;
        },
      });

      const logger = channelOptions?.logger;
      expect(logger).toBeDefined();
      await Promise.all(
        (["error", "warn", "info", "debug", "trace"] as const).map(
          async (method) => logger?.[method](sensitive, "SENSITIVE_SENTINEL"),
        ),
      );
      await expect(
        transport.sendAcknowledgement({
          chatId: "oc_fixture_private_chat",
          text: "收到，我开始处理",
          replyToMessageId: "message-fixture",
        }),
      ).resolves.toEqual({ messageId: "fixture-ack-reply" });

      expect(consoleOutput).toEqual([]);
      expect(serializationAttempts).toBe(0);
      expect(channel.rawReplyCalls).toHaveLength(1);
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

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
