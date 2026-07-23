import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import type {
  LifecycleState,
  SdkCardActionEvent,
  SdkMessageEvent,
  TrustedCardEvidence,
} from "@executive-assistant/bridge";
import {
  sendGatewayRequest,
  type MvpLarkCliRunner,
} from "@executive-assistant/action-gateway";
import {
  acquireDatabaseFileLock,
  openJobStore,
} from "@executive-assistant/job-store";
import { afterEach, describe, expect, it } from "vitest";

import { createProductionCodexRunner } from "../src/codex-runner.js";
import { parseRuntimeConfig } from "../src/config.js";
import { startExecutiveRuntime } from "../src/runtime.js";
import type {
  CodexRunHandle,
  CodexRunInput,
  CodexRunner,
  RuntimeConfig,
  RuntimeConfirmationCard,
  RuntimeFileReply,
  RuntimeTextReply,
  RuntimeTransport,
} from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

class FakeTransport implements RuntimeTransport {
  messageHandler: ((event: SdkMessageEvent) => Promise<void>) | undefined;
  cardHandler: ((event: SdkCardActionEvent) => Promise<void>) | undefined;
  lifecycleHandler:
    | ((state: LifecycleState, detail?: unknown) => void)
    | undefined;
  readonly textReplies: RuntimeTextReply[] = [];
  readonly fileReplies: RuntimeFileReply[] = [];
  readonly confirmationCards: RuntimeConfirmationCard[] = [];
  connected = false;
  beforeTextReply: ((reply: RuntimeTextReply) => void) | undefined;
  cardEvidence: TrustedCardEvidence | null = null;

  onMessage(handler: (event: SdkMessageEvent) => Promise<void>): void {
    this.messageHandler = handler;
  }

  onCardAction(handler: (event: SdkCardActionEvent) => Promise<void>): void {
    this.cardHandler = handler;
  }

  onLifecycle(
    handler: (state: LifecycleState, detail?: unknown) => void,
  ): void {
    this.lifecycleHandler = handler;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async sendText(
    reply: RuntimeTextReply,
  ): Promise<Readonly<{ messageId: string }>> {
    this.beforeTextReply?.(reply);
    this.textReplies.push(reply);
    return Object.freeze({
      messageId: `reply-${this.textReplies.length}`,
    });
  }

  async sendFile(
    reply: RuntimeFileReply,
  ): Promise<Readonly<{ messageId: string }>> {
    this.fileReplies.push(reply);
    return Object.freeze({
      messageId: `file-${this.fileReplies.length}`,
    });
  }

  async sendConfirmationCard(
    card: RuntimeConfirmationCard,
  ): Promise<Readonly<{ messageId: string }>> {
    this.confirmationCards.push(card);
    return Object.freeze({
      messageId: `confirmation-${this.confirmationCards.length}`,
    });
  }

  async verifyCardAction(): Promise<TrustedCardEvidence | null> {
    return this.cardEvidence;
  }

  async emitMessage(event: SdkMessageEvent): Promise<void> {
    if (!this.messageHandler) throw new Error("message handler missing");
    await this.messageHandler(event);
  }

  async emitCard(event: SdkCardActionEvent): Promise<void> {
    if (!this.cardHandler) throw new Error("card handler missing");
    await this.cardHandler(event);
  }
}

class FakeLarkRunner implements MvpLarkCliRunner {
  readonly botRequests: unknown[] = [];
  readonly userRequests: unknown[] = [];

  async runBot(request: unknown) {
    this.botRequests.push(request);
    return Object.freeze({
      state: "SUCCEEDED" as const,
      value: Object.freeze({ message_id: "om_test_receipt" }),
    });
  }

  async runUser(request: unknown) {
    this.userRequests.push(request);
    return Object.freeze({
      state: "SUCCEEDED" as const,
      value: Object.freeze({ ok: true }),
    });
  }
}

class ImmediateRunner implements CodexRunner {
  readonly starts: CodexRunInput[] = [];

  constructor(
    private readonly threadId = "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
    private readonly createResultFile = false,
  ) {}

  async start(input: CodexRunInput): Promise<CodexRunHandle> {
    this.starts.push(input);
    if (this.createResultFile) {
      const outputPath = join(input.workspace, "董事会简报.txt");
      await writeFile(outputPath, "已完成", { mode: 0o600 });
      await writeFile(
        join(input.workspace, "result-files.json"),
        `${JSON.stringify({
          version: 1,
          files: ["董事会简报.txt"],
        })}\n`,
        { mode: 0o600 },
      );
    }
    const threadId = this.threadId;
    return Object.freeze({
      events: (async function* () {
        yield Object.freeze({
          type: "thread.started",
          thread_id: threadId,
        });
        yield Object.freeze({
          type: "item.completed",
          item: Object.freeze({
            type: "agent_message",
            text: "董事会材料已经整理完成。",
          }),
        });
      })(),
      result: Promise.resolve(
        Object.freeze({
          status: "SUCCEEDED" as const,
          exitCode: 0 as const,
          signal: null,
        }),
      ),
      async stop() {},
    });
  }
}

class StoppableRunner implements CodexRunner {
  readonly starts: CodexRunInput[] = [];
  stopCount = 0;
  private release: (() => void) | undefined;
  private readonly stopped = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  async start(input: CodexRunInput): Promise<CodexRunHandle> {
    this.starts.push(input);
    const stopped = this.stopped;
    return Object.freeze({
      events: (async function* () {
        yield Object.freeze({
          type: "thread.started",
          thread_id: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
        });
        await stopped;
      })(),
      result: stopped.then(() =>
        Object.freeze({
          status: "FAILED" as const,
          exitCode: null,
          signal: "SIGTERM" as const,
          reason: "stopped" as const,
        }),
      ),
      stop: async () => {
        this.stopCount += 1;
        this.release?.();
      },
    });
  }
}

class BlockingStartRunner implements CodexRunner {
  readonly starts: CodexRunInput[] = [];
  stopCount = 0;
  private releaseStart: (() => void) | undefined;
  private readonly startAllowed = new Promise<void>((resolve) => {
    this.releaseStart = resolve;
  });

  allowStart(): void {
    this.releaseStart?.();
  }

  async start(input: CodexRunInput): Promise<CodexRunHandle> {
    this.starts.push(input);
    await this.startAllowed;
    return Object.freeze({
      events: (async function* () {
        yield Object.freeze({
          type: "thread.started",
          thread_id: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
        });
      })(),
      result: Promise.resolve(
        Object.freeze({
          status: "FAILED" as const,
          exitCode: null,
          signal: "SIGTERM" as const,
          reason: "stopped" as const,
        }),
      ),
      stop: async () => {
        this.stopCount += 1;
      },
    });
  }
}

class MessageActionRunner implements CodexRunner {
  gatewayResponse: unknown;

  async start(input: CodexRunInput): Promise<CodexRunHandle> {
    let resolveResult: (
      result: Awaited<CodexRunHandle["result"]>,
    ) => void = () => undefined;
    const result = new Promise<Awaited<CodexRunHandle["result"]>>((resolve) => {
      resolveResult = resolve;
    });
    const setGatewayResponse = (response: unknown): void => {
      this.gatewayResponse = response;
    };
    return Object.freeze({
      events: (async function* () {
        try {
          yield Object.freeze({
            type: "thread.started",
            thread_id: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
          });
          setGatewayResponse(
            await sendGatewayRequest(input.gatewaySocket, {
              version: 1,
              requestId: randomUUID(),
              kind: "prepare",
              capability: "message.send",
              payload: {
                recipientOpenId: "ou_synthetic_colleague",
                text: "明天十点参加经营会。",
              },
            }),
          );
          yield Object.freeze({
            type: "item.completed",
            item: Object.freeze({
              type: "agent_message",
              text: "已生成通知预览，请在飞书卡片中确认。",
            }),
          });
          resolveResult(
            Object.freeze({
              status: "SUCCEEDED" as const,
              exitCode: 0 as const,
              signal: null,
            }),
          );
        } catch {
          resolveResult(
            Object.freeze({
              status: "FAILED" as const,
              exitCode: 1,
              signal: null,
              reason: "invalid_output" as const,
            }),
          );
        }
      })(),
      result,
      async stop() {},
    });
  }
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

async function fixtureConfig(unpaired = false): Promise<RuntimeConfig> {
  const created = await mkdtemp(join(tmpdir(), "executive-runtime-"));
  await chmod(created, 0o700);
  const root = await realpath(created);
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  const workspaceRoot = join(root, "workspace");
  const codexHome = join(runtimeRoot, "codex-home");
  const larkHome = join(runtimeRoot, "lark-home");
  await mkdir(runtimeRoot, { mode: 0o700 });
  await mkdir(workspaceRoot, { mode: 0o700 });
  await mkdir(codexHome, { mode: 0o700 });
  await mkdir(larkHome, { mode: 0o700 });
  return parseRuntimeConfig({
    schemaVersion: 1,
    appId: "cli_test_app",
    tenantKey: "tenant_test_001",
    presidentOpenId: unpaired ? null : "ou_synthetic_president",
    presidentChatId: unpaired ? null : "oc_synthetic_private_chat",
    pairing: {
      enabled: unpaired,
      codeHash: unpaired
        ? `sha256:${createHash("sha256")
            .update("482913", "utf8")
            .digest("hex")}`
        : null,
      expiresAt: unpaired ? new Date(Date.now() + 60_000).toISOString() : null,
    },
    secretRef: {
      type: "macos-keychain",
      service: "com.example.executive-assistant",
      account: "cli_test_app",
    },
    paths: {
      runtimeRoot,
      jobsRoot: join(runtimeRoot, "jobs"),
      workspaceRoot,
      codexHome,
      larkHome,
      databasePath: join(runtimeRoot, "assistant.sqlite"),
    },
    executables: {
      codex: "/usr/local/bin/codex",
      gatewayClient: "/usr/local/bin/assistant-gateway",
      larkCli: "/usr/local/bin/lark-cli",
      runtimeEntry: null,
    },
  });
}

function message(
  sequence: number,
  text: string,
  overrides: Partial<{
    senderId: string;
    chatId: string;
  }> = {},
): SdkMessageEvent {
  const senderId = overrides.senderId ?? "ou_synthetic_president";
  const chatId = overrides.chatId ?? "oc_synthetic_private_chat";
  const messageId = `message-${sequence}`;
  const createTime = Date.now() + sequence;
  return Object.freeze({
    messageId,
    chatId,
    chatType: "p2p",
    senderId,
    createTime,
    content: text,
    resources: Object.freeze([]),
    raw: Object.freeze({
      header: Object.freeze({
        event_id: `event-${sequence}`,
        event_type: "im.message.receive_v1",
        app_id: "cli_test_app",
        tenant_key: "tenant_test_001",
      }),
      event: Object.freeze({
        sender: Object.freeze({
          sender_id: Object.freeze({
            open_id: senderId,
          }),
          sender_type: "user",
          tenant_key: "tenant_test_001",
        }),
        message: Object.freeze({
          message_id: messageId,
          create_time: String(createTime),
          chat_id: chatId,
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text }),
          mentions: Object.freeze([]),
        }),
      }),
    }),
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not reached");
}

describe("executive runtime offline integration", () => {
  it("persists a strict BOSS DM before ACK, runs one Codex task, saves the session, and replies", async () => {
    const config = await fixtureConfig();
    const transport = new FakeTransport();
    const runner = new ImmediateRunner();
    const ackObservedStartCounts: number[] = [];
    transport.beforeTextReply = (reply) => {
      if (reply.text === "收到，我开始处理") {
        ackObservedStartCounts.push(runner.starts.length);
      }
    };
    const runtime = await startExecutiveRuntime(config, {
      transport,
      runner,
      larkRunnerFactory: () => new FakeLarkRunner(),
      instanceId: "runtime-test-instance",
    });
    try {
      await transport.emitMessage(
        message(0, "把今天的董事会材料整理成三点摘要"),
      );
      await runtime.waitForIdle();

      expect(transport.textReplies.map((reply) => reply.text)).toEqual([
        "收到，我开始处理",
        "董事会材料已经整理完成。",
      ]);
      expect(ackObservedStartCounts).toEqual([0]);
      expect(runner.starts).toHaveLength(1);
      const start = runner.starts[0];
      expect(start?.gatewaySocket).toBe(
        join(start?.workspace ?? "", "gateway.sock"),
      );
      expect(start?.gatewayClient).toBe("/usr/local/bin/assistant-gateway");
      expect(start?.prompt).toContain("$executive-assistant");
      expect(start?.prompt).toContain("五项 stdin JSON 合同");
      expect(runtime.getTask(start?.taskId ?? "")?.state).toBe("SUCCEEDED");
      expect(
        await readFile(join(config.paths.runtimeRoot, "sessions.json"), "utf8"),
      ).toContain("018f7d72-7a2b-7f45-8a12-8e20b8426a21");

      await transport.emitMessage(message(1, "继续补上风险和下一步"));
      await runtime.waitForIdle();
      expect(runner.starts[1]?.sessionId).toBe(
        "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      );

      await transport.emitMessage(
        message(2, "不应执行", {
          senderId: "ou_other_user",
          chatId: "oc_other_chat",
        }),
      );
      await runtime.waitForIdle();
      expect(runner.starts).toHaveLength(2);
    } finally {
      await runtime.close();
    }
  });

  it("never executes a persisted task whose acknowledgement failed", async () => {
    const config = await fixtureConfig();
    const transport = new FakeTransport();
    const runner = new ImmediateRunner();
    let rejectAcknowledgement = true;
    transport.beforeTextReply = (reply) => {
      if (reply.text === "收到，我开始处理" && rejectAcknowledgement) {
        throw new Error("synthetic acknowledgement failure");
      }
    };
    const runtime = await startExecutiveRuntime(config, {
      transport,
      runner,
      larkRunnerFactory: () => new FakeLarkRunner(),
      instanceId: "runtime-ack-instance",
    });
    try {
      await expect(
        transport.emitMessage(message(3, "这条任务的接单回复会失败")),
      ).rejects.toThrow("ASSISTANT_TASK_ACK_FAILED");
      await runtime.waitForIdle();
      expect(runner.starts).toHaveLength(0);

      rejectAcknowledgement = false;
      await transport.emitMessage(message(4, "只执行这一条新任务"));
      await runtime.waitForIdle();
      expect(runner.starts).toHaveLength(1);
      expect(runner.starts[0]?.prompt).toContain("只执行这一条新任务");
      expect(runner.starts[0]?.prompt).not.toContain("接单回复会失败");
    } finally {
      await runtime.close();
    }
  });

  it("prepares a Feishu mutation, waits for the signed BOSS card decision, and dispatches exactly once", async () => {
    const config = await fixtureConfig();
    const transport = new FakeTransport();
    const runner = new MessageActionRunner();
    const lark = new FakeLarkRunner();
    const runtime = await startExecutiveRuntime(config, {
      transport,
      runner,
      larkRunnerFactory: () => lark,
      instanceId: "runtime-action-instance",
    });
    try {
      await transport.emitMessage(message(5, "通知王伟明天十点参加经营会"));
      await waitUntil(() => transport.confirmationCards.length === 1);
      const card = transport.confirmationCards[0];
      if (!card) throw new Error("confirmation card missing");
      expect(card.preview).toMatchObject({
        action: "message.send",
        identity: "bot",
      });
      const action = Object.freeze({
        value: Object.freeze({
          version: 1,
          actionId: card.actionId,
          actionPayloadHash: card.actionPayloadHash,
          nonce: card.nonce,
          decision: "approve",
        }),
        tag: "button",
      });
      const payloadHash = `sha256:${createHash("sha256")
        .update(canonicalJson(action), "utf8")
        .digest("hex")}` as const;
      transport.cardEvidence = Object.freeze({
        appId: config.appId,
        tenantKey: config.tenantKey,
        eventId: "card-action-5",
        messageId: "confirmation-1",
        senderOpenId: "ou_synthetic_president",
        chatId: "oc_synthetic_private_chat",
        chatType: "p2p",
        signatureVerified: true,
        nonce: card.nonce,
        payloadHash,
        receivedAt: new Date().toISOString(),
      });
      await transport.emitCard(
        Object.freeze({
          messageId: "confirmation-1",
          chatId: "oc_synthetic_private_chat",
          operator: Object.freeze({ openId: "ou_synthetic_president" }),
          action,
          raw: Object.freeze({}),
        }),
      );
      await runtime.waitForIdle();

      expect(lark.botRequests).toHaveLength(1);
      expect(lark.userRequests).toHaveLength(0);
      expect(transport.textReplies.map((reply) => reply.text)).toEqual([
        "收到，我开始处理",
        "已生成通知预览，请在飞书卡片中确认。",
        "操作已执行成功。",
      ]);
      expect(runner.gatewayResponse).toMatchObject({
        ok: true,
        result: { state: "PREPARED" },
      });
    } finally {
      await runtime.close();
    }
  });

  it("stops the active run when the BOSS sends an exact cancellation phrase", async () => {
    const config = await fixtureConfig();
    const transport = new FakeTransport();
    const runner = new StoppableRunner();
    const runtime = await startExecutiveRuntime(config, {
      transport,
      runner,
      larkRunnerFactory: () => new FakeLarkRunner(),
      instanceId: "runtime-cancel-instance",
    });
    try {
      await transport.emitMessage(message(10, "生成本月经营复盘"));
      await waitUntil(() => runner.starts.length === 1);
      await transport.emitMessage(message(11, "停止当前任务"));
      await runtime.waitForIdle();

      expect(runner.stopCount).toBe(1);
      expect(transport.textReplies.map((reply) => reply.text)).toEqual([
        "收到，我开始处理",
        "已停止当前任务，没有待执行的外部动作。",
      ]);
      const taskId = runner.starts[0]?.taskId ?? "";
      expect(runtime.getTask(taskId)?.state).toBe("CANCELLED");
      await expect(
        readFile(join(config.paths.jobsRoot, taskId, "cancelled.json"), "utf8"),
      ).resolves.toContain('"version":1');
    } finally {
      await runtime.close();
    }
  });

  it("honors a persisted cancellation that arrives while the Codex runner is starting", async () => {
    const config = await fixtureConfig();
    const transport = new FakeTransport();
    const runner = new BlockingStartRunner();
    const runtime = await startExecutiveRuntime(config, {
      transport,
      runner,
      larkRunnerFactory: () => new FakeLarkRunner(),
      instanceId: "runtime-cancel-start-race-instance",
    });
    try {
      await transport.emitMessage(message(12, "生成季度经营复盘"));
      await waitUntil(() => runner.starts.length === 1);
      await transport.emitMessage(message(13, "停止当前任务"));
      runner.allowStart();
      await runtime.waitForIdle();

      const taskId = runner.starts[0]?.taskId ?? "";
      expect(runner.stopCount).toBe(1);
      expect(runtime.getTask(taskId)?.state).toBe("CANCELLED");
      expect(transport.textReplies.map((reply) => reply.text)).toEqual([
        "收到，我开始处理",
        "已停止当前任务，没有待执行的外部动作。",
      ]);
      expect(transport.fileReplies).toHaveLength(0);
      await expect(
        readFile(join(config.paths.jobsRoot, taskId, "cancelled.json"), "utf8"),
      ).resolves.toContain('"version":1');
    } finally {
      runner.allowStart();
      await runtime.close();
    }
  });

  it("returns only files explicitly listed by the successful task", async () => {
    const config = await fixtureConfig();
    const transport = new FakeTransport();
    const runner = new ImmediateRunner(
      "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      true,
    );
    const runtime = await startExecutiveRuntime(config, {
      transport,
      runner,
      larkRunnerFactory: () => new FakeLarkRunner(),
      instanceId: "runtime-file-instance",
    });
    try {
      await transport.emitMessage(message(20, "做一份简报文件"));
      await runtime.waitForIdle();
      expect(transport.fileReplies).toHaveLength(1);
      expect(transport.fileReplies[0]?.fileName).toBe("董事会简报.txt");
      expect(
        transport.fileReplies[0]?.path.startsWith(config.paths.jobsRoot),
      ).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it("persists the first pairing and restores it without re-running completed work", async () => {
    const config = await fixtureConfig(true);
    const firstTransport = new FakeTransport();
    const firstRunner = new ImmediateRunner();
    const firstRuntime = await startExecutiveRuntime(config, {
      transport: firstTransport,
      runner: firstRunner,
      larkRunnerFactory: () => new FakeLarkRunner(),
      instanceId: "runtime-pairing-first",
    });
    await firstTransport.emitMessage(message(30, "482913"));
    expect(firstRunner.starts).toHaveLength(0);
    expect(firstTransport.textReplies.map((reply) => reply.text)).toEqual([
      "配对完成，可以开始给我任务了。",
    ]);
    const pairingPath = join(config.paths.runtimeRoot, "pairing.json");
    const pairing = await readFile(pairingPath, "utf8");
    expect(pairing).toContain('"presidentOpenId":"ou_synthetic_president"');
    expect((await lstat(pairingPath)).mode & 0o777).toBe(0o600);

    await firstTransport.emitMessage(message(31, "整理会前材料"));
    await firstRuntime.waitForIdle();
    expect(firstRunner.starts).toHaveLength(1);
    await firstRuntime.close();

    const secondTransport = new FakeTransport();
    const secondRunner = new ImmediateRunner();
    const secondRuntime = await startExecutiveRuntime(config, {
      transport: secondTransport,
      runner: secondRunner,
      larkRunnerFactory: () => new FakeLarkRunner(),
      instanceId: "runtime-pairing-second",
    });
    try {
      expect(secondRunner.starts).toHaveLength(0);
      await secondTransport.emitMessage(message(32, "继续补一页摘要"));
      await secondRuntime.waitForIdle();
      expect(secondRunner.starts).toHaveLength(1);
      expect(secondRunner.starts[0]?.sessionId).toBe(
        "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      );
    } finally {
      await secondRuntime.close();
    }
  });

  it("marks a pre-crash received task interrupted instead of silently running it again", async () => {
    const config = await fixtureConfig();
    await mkdir(config.paths.jobsRoot, { mode: 0o700 });
    const taskId = randomUUID();
    const workspace = join(config.paths.jobsRoot, taskId);
    await mkdir(workspace, { mode: 0o700 });
    const lock = await acquireDatabaseFileLock(config.paths.runtimeRoot);
    const store = openJobStore({
      filename: config.paths.databasePath,
      instanceId: "seed-instance",
      lock,
    });
    const receivedAt = new Date().toISOString();
    store.ingestEvent(
      {
        appId: config.appId,
        tenantKey: config.tenantKey,
        eventId: "pre-crash-event",
        messageId: "pre-crash-message",
        senderOpenId: "ou_synthetic_president",
        chatId: "oc_synthetic_private_chat",
        chatType: "p2p",
        eventType: "im.message.receive_v1",
        receivedAt,
        payloadRef: `sha256:${"a".repeat(64)}`,
      },
      workspace,
    );
    store.close();
    await lock.release();

    const transport = new FakeTransport();
    const runner = new ImmediateRunner();
    const runtime = await startExecutiveRuntime(config, {
      transport,
      runner,
      larkRunnerFactory: () => new FakeLarkRunner(),
      instanceId: "recovery-instance",
    });
    try {
      expect(runner.starts).toHaveLength(0);
      expect(runtime.getTask(taskId)?.state).toBe(
        "INTERRUPTED_REQUIRES_CONFIRMATION",
      );
    } finally {
      await runtime.close();
    }
  });
});

describe("production boundaries", () => {
  it("rejects inline secrets in otherwise valid JSON configuration", async () => {
    const config = await fixtureConfig();
    expect(() =>
      parseRuntimeConfig({
        ...config.source,
        appSecret: "must-never-be-here",
      }),
    ).toThrow(/inline secret field/);
  });

  it("spawns Codex with shell:false, assistant-task gateway binding, and a minimal secret-free environment", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill(signal: NodeJS.Signals): boolean;
    };
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => true;
    stdin.resume();
    let invocation:
      | Readonly<{
          command: string;
          args: readonly string[];
          options: SpawnOptionsWithoutStdio & {
            stdio: readonly ["pipe", "pipe", "pipe"];
            shell: false;
          };
        }>
      | undefined;
    const runner = createProductionCodexRunner({
      codexPath: "/usr/local/bin/codex",
      codexHome: "/private/runtime/codex-home",
      spawn: (command, args, options) => {
        invocation = { command, args, options };
        queueMicrotask(() => {
          stdout.write(
            [
              {
                type: "thread.started",
                thread_id: "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
              },
              { type: "turn.started" },
              {
                type: "item.completed",
                item: {
                  id: "item-1",
                  type: "agent_message",
                  text: "完成",
                },
              },
              {
                type: "turn.completed",
                usage: {
                  input_tokens: 1,
                  cached_input_tokens: 0,
                  output_tokens: 1,
                  reasoning_output_tokens: 0,
                },
              },
            ]
              .map((event) => JSON.stringify(event))
              .join("\n") + "\n",
          );
          stdout.end();
          stderr.end();
          child.emit("close", 0, null);
        });
        return child as unknown as ChildProcessWithoutNullStreams;
      },
    });
    const handle = await runner.start({
      taskId: "task-1",
      prompt: "整理材料",
      workspace: "/private/runtime/jobs/task-1",
      gatewaySocket: "/private/runtime/jobs/task-1/gateway.sock",
      gatewayClient: "/private/runtime/bin/assistant-gateway",
    });
    const observed: unknown[] = [];
    const consume = (async () => {
      for await (const event of handle.events) observed.push(event);
    })();
    await expect(handle.result).resolves.toMatchObject({
      status: "SUCCEEDED",
    });
    await consume;

    expect(observed).toHaveLength(4);
    expect(invocation?.command).toBe("/usr/local/bin/codex");
    expect(invocation?.options.shell).toBe(false);
    expect(invocation?.args).toContain("network_proxy");
    expect(invocation?.args.join(" ")).toContain(
      'default_permissions="assistant-task"',
    );
    expect(invocation?.args.join(" ")).toContain(
      "/private/runtime/jobs/task-1/gateway.sock",
    );
    expect(invocation?.args.join(" ")).not.toContain(
      "sandbox_workspace_write.network_access",
    );
    expect(invocation?.options.env).toEqual({
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      CODEX_HOME: "/private/runtime/codex-home",
      ASSISTANT_GATEWAY_SOCKET: "/private/runtime/jobs/task-1/gateway.sock",
      ASSISTANT_GATEWAY_CLIENT: "/private/runtime/bin/assistant-gateway",
      LANG: "zh_CN.UTF-8",
      LC_ALL: "zh_CN.UTF-8",
    });
    expect(JSON.stringify(invocation)).not.toMatch(
      /app.?secret|lark.?cli|feishu|token/i,
    );
  });
});
