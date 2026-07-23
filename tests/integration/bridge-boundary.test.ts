import { describe, expect, it } from "vitest";

import { createBridgeHarness, type BridgeHarness } from "./bridge-harness.js";

function expectNoPrivilegedEffects(harness: BridgeHarness): void {
  expect(harness.metrics.mediaDownloadsBeforeGuard).toBe(0);
}

function expectNoTaskEffects(harness: BridgeHarness): void {
  expect(harness.metrics.taskSinkCalls).toBe(0);
  expect(harness.metrics.cancelCalls).toBe(0);
  expect(harness.metrics.systemReplyCalls).toBe(0);
  expect(harness.metrics.controlReplyCalls).toBe(0);
  expect(harness.metrics.wakeCalls).toBe(0);
  expectNoPrivilegedEffects(harness);
}

function expectNoForbiddenGatewayData(value: unknown): void {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      expect(current).not.toMatch(/https?:|lark-cli|open_?id|chat_?id/i);
      continue;
    }
    if (current === null || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const key of Reflect.ownKeys(current)) {
      expect(typeof key).toBe("string");
      expect(String(key)).not.toMatch(/chat|principal|open_?id|url|cli|raw/i);
      pending.push((current as Record<PropertyKey, unknown>)[key]);
    }
  }
}

describe("stage A bridge boundary", () => {
  it("exposes only metrics backed by an injected production boundary", async () => {
    const harness = await createBridgeHarness();

    expect(Object.keys(harness.metrics).sort()).toEqual(
      [
        "guardCalls",
        "contentReads",
        "bodyReads",
        "resourceReads",
        "pairingSinkCalls",
        "confirmationSinkCalls",
        "cardVerifierCalls",
        "cardActionReads",
        "taskSinkCalls",
        "cancelCalls",
        "systemReplyCalls",
        "controlReplyCalls",
        "wakeCalls",
        "mediaDownloadsBeforeGuard",
      ].sort(),
    );
    await harness.disconnect();
  });

  it("registers only message, card action, and sanitized lifecycle handlers", async () => {
    const harness = await createBridgeHarness();

    expect(harness.registrations).toEqual([
      "message",
      "cardAction",
      "lifecycle",
    ]);
    expectNoPrivilegedEffects(harness);
    await harness.disconnect();
  });

  it("rejects a president group message before content, attachments, task, ACK, wake, or Codex", async () => {
    const harness = await createBridgeHarness();

    await harness.emitMessage({ chatType: "group", chatId: "oc_group" });

    expect(harness.order).toEqual(["guard"]);
    expect(harness.metrics.contentReads).toBe(0);
    expect(harness.metrics.bodyReads).toBe(0);
    expect(harness.metrics.resourceReads).toBe(0);
    expectNoTaskEffects(harness);
  });

  it.each([
    ["non-president", { senderOpenId: "ou_other" }],
    ["wrong private chat", { chatId: "oc_other" }],
  ] as const)("rejects %s before opaque message data", async (_name, event) => {
    const harness = await createBridgeHarness();

    await harness.emitMessage(event);

    expect(harness.order).toEqual(["guard"]);
    expect(harness.metrics.contentReads).toBe(0);
    expect(harness.metrics.bodyReads).toBe(0);
    expect(harness.metrics.resourceReads).toBe(0);
    expectNoTaskEffects(harness);
  });

  it.each([
    ["wrong app", { appId: "cli_other" }],
    ["wrong tenant", { tenantKey: "tenant_other" }],
    ["unknown event", { eventType: "im.message.reaction.created_v1" }],
    ["malformed metadata", { messageId: 42 }],
  ] as const)(
    "rejects %s at the SDK projection boundary",
    async (_name, event) => {
      const harness = await createBridgeHarness();

      await harness.emitMessage(event);

      expect(harness.metrics.guardCalls).toBe(0);
      expect(harness.metrics.contentReads).toBe(0);
      expect(harness.metrics.bodyReads).toBe(0);
      expect(harness.metrics.resourceReads).toBe(0);
      expectNoTaskEffects(harness);
    },
  );

  it("keeps an unpaired ordinary message outside every task path", async () => {
    const harness = await createBridgeHarness({ paired: false });

    await harness.emitMessage({ text: "整理文件" });

    expect(harness.order).toEqual(["guard"]);
    expect(harness.metrics.contentReads).toBe(0);
    expect(harness.metrics.bodyReads).toBe(0);
    expect(harness.metrics.resourceReads).toBe(0);
    expect(harness.metrics.pairingSinkCalls).toBe(0);
    expectNoTaskEffects(harness);
  });

  it("accepts a president DM only in guard, persist, ACK, wake order", async () => {
    const harness = await createBridgeHarness();

    await harness.emitMessage();

    expect(harness.order).toEqual(["guard", "persist", "ack", "wake"]);
    expect(harness.metrics.taskSinkCalls).toBe(1);
    expect(harness.metrics.systemReplyCalls).toBe(1);
    expect(harness.metrics.wakeCalls).toBe(1);
    expect(harness.metrics.bodyReads).toBe(1);
    expect(harness.metrics.resourceReads).toBe(1);
    expectNoPrivilegedEffects(harness);
  });

  it("stops before ACK and wake when the task sink rejects", async () => {
    const harness = await createBridgeHarness({ taskOutcome: "reject" });

    await expect(harness.emitMessage()).rejects.toThrow(
      "ASSISTANT_TASK_INGEST_FAILED",
    );

    expect(harness.order).toEqual(["guard", "persist"]);
    expect(harness.metrics.systemReplyCalls).toBe(0);
    expect(harness.metrics.wakeCalls).toBe(0);
    expectNoPrivilegedEffects(harness);
  });

  it("does not repeat ACK or wake for a duplicate event", async () => {
    const harness = await createBridgeHarness({ taskOutcome: "duplicate" });

    await harness.emitMessage();

    expect(harness.order).toEqual(["guard", "persist"]);
    expect(harness.metrics.taskSinkCalls).toBe(1);
    expect(harness.metrics.systemReplyCalls).toBe(0);
    expect(harness.metrics.wakeCalls).toBe(0);
    expectNoPrivilegedEffects(harness);
  });

  it("routes an exact pairing code only to the pairing sink", async () => {
    const harness = await createBridgeHarness({ pairingCode: "PAIR-2468" });

    await harness.emitMessage({ text: "PAIR-2468" });

    expect(harness.order).toEqual(["guard", "pairing"]);
    expect(harness.metrics.pairingSinkCalls).toBe(1);
    expect(harness.metrics.confirmationSinkCalls).toBe(0);
    expect(harness.metrics.bodyReads).toBe(0);
    expect(harness.metrics.resourceReads).toBe(0);
    expectNoTaskEffects(harness);
  });

  it("routes a trusted president card only to the confirmation sink", async () => {
    const harness = await createBridgeHarness({ trustedCard: true });

    await harness.emitCard();

    expect(harness.order).toEqual(["guard", "confirmation"]);
    expect(harness.metrics.confirmationSinkCalls).toBe(1);
    expect(harness.metrics.cardVerifierCalls).toBe(1);
    expect(harness.metrics.cardActionReads).toBe(1);
    expect(harness.metrics.pairingSinkCalls).toBe(0);
    expectNoTaskEffects(harness);
  });

  it.each([
    ["null", {}],
    ["throwing", { cardVerifierThrows: true }],
  ] as const)(
    "keeps a %s card verifier result away from action and confirmation",
    async (_name, options) => {
      const harness = await createBridgeHarness(options);

      await harness.emitCard();

      expect(harness.order).toEqual(["guard"]);
      expect(harness.metrics.cardVerifierCalls).toBe(1);
      expect(harness.metrics.cardActionReads).toBe(0);
      expect(harness.metrics.bodyReads).toBe(0);
      expect(harness.metrics.confirmationSinkCalls).toBe(0);
      expectNoTaskEffects(harness);
    },
  );

  it.each(["停一下", "停止当前任务", "取消这个任务", "  停一下\n"])(
    "routes exact cancellation %s before body, attachments, or a new task",
    async (text) => {
      const harness = await createBridgeHarness();

      await harness.emitMessage({ text });

      expect(harness.order).toEqual(["guard", "cancel", "control-reply"]);
      expect(harness.metrics.cancelCalls).toBe(1);
      expect(harness.metrics.bodyReads).toBe(0);
      expect(harness.metrics.resourceReads).toBe(0);
      expect(harness.metrics.taskSinkCalls).toBe(0);
      expect(harness.metrics.wakeCalls).toBe(0);
      expectNoPrivilegedEffects(harness);
    },
  );

  it.each([
    [
      "president group",
      { text: "停一下", chatType: "group", chatId: "oc_group" },
      0,
    ],
    ["wrong sender", { text: "停一下", senderOpenId: "ou_other" }, 0],
    ["substring", { text: "请停一下" }, 1],
    ["punctuation", { text: "停一下！" }, 1],
  ] as const)(
    "does not treat %s as an authorized cancellation",
    async (_name, event, expectedTasks) => {
      const harness = await createBridgeHarness();

      await harness.emitMessage(event);

      expect(harness.metrics.cancelCalls).toBe(0);
      expect(harness.metrics.taskSinkCalls).toBe(expectedTasks);
      expectNoPrivilegedEffects(harness);
    },
  );

  it("keeps task, control, and progress replies on the narrow gateway port", async () => {
    const taskHarness = await createBridgeHarness();
    await taskHarness.emitMessage();
    await taskHarness.sendProgress("VERIFYING");
    const cancelHarness = await createBridgeHarness();
    await cancelHarness.emitMessage({ text: "停一下" });

    const calls = [...taskHarness.gatewayCalls, ...cancelHarness.gatewayCalls];
    expect(calls.map(({ method }) => method)).toEqual([
      "sendSystemReply",
      "sendSystemReply",
      "sendControlReply",
    ]);
    expect([
      ...taskHarness.gatewayArgumentCounts,
      ...cancelHarness.gatewayArgumentCounts,
    ]).toEqual([2, 2, 2]);
    for (const call of calls) {
      expect(Object.keys(call).sort()).toEqual(
        ["anchorId", "body", "method"].sort(),
      );
      expectNoForbiddenGatewayData(call);
    }
    expectNoPrivilegedEffects(taskHarness);
    expectNoPrivilegedEffects(cancelHarness);
  });
});
