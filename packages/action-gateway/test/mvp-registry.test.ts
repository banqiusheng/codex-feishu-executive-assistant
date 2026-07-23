import { randomUUID } from "node:crypto";
import type { PrepareActionInput } from "@executive-assistant/job-store";
import { describe, expect, it, vi } from "vitest";

import { dispatchGatewayRequest } from "../src/ipc/schemas.js";
import type {
  MvpActionPreparer,
  MvpLarkCliRunner,
  MvpPreparedHook,
} from "../src/mvp/index.js";
import {
  MVP_CAPABILITIES,
  createMvpGatewayRegistry,
} from "../src/mvp/index.js";

const TASK_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a21";
const ACTION_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a22";
const HASH = `sha256:${"a".repeat(64)}`;
const NOW = new Date("2026-07-23T08:00:00.000Z");

function fixture(
  onPrepared?: Parameters<typeof createMvpGatewayRegistry>[0]["onPrepared"],
) {
  const runBot = vi.fn<MvpLarkCliRunner["runBot"]>(async () => ({
    state: "SUCCEEDED",
    value: { ok: true },
  }));
  const runUser = vi.fn<MvpLarkCliRunner["runUser"]>(async () => ({
    state: "SUCCEEDED",
    value: { ok: true },
  }));
  const prepareAction = vi.fn<MvpActionPreparer["prepareAction"]>(
    (input: PrepareActionInput) => {
      void input;
      return {
        actionId: ACTION_ID,
        version: 1,
        payloadHash: HASH,
        nonce: "internal-card-nonce",
        expiresAt: "2026-07-23T08:30:00.000Z",
        state: "PREPARED",
      };
    },
  );
  const runner: MvpLarkCliRunner = { runBot, runUser };
  const actionStore: MvpActionPreparer = { prepareAction };
  const registry = createMvpGatewayRegistry({
    runner,
    actionStore,
    ...(onPrepared === undefined ? {} : { onPrepared }),
    now: () => NOW,
  });
  const context = Object.freeze({
    channel: "run" as const,
    taskId: TASK_ID,
    presidentOpenId: "ou_president",
    presidentChatId: "oc_president_dm",
    capabilities: MVP_CAPABILITIES,
  });
  return { registry, context, runBot, runUser, prepareAction };
}

function request(
  kind: "read" | "prepare",
  capability: string,
  payload: Readonly<Record<string, unknown>>,
) {
  return {
    version: 1 as const,
    requestId: randomUUID(),
    kind,
    capability,
    payload,
  };
}

describe("MVP gateway registry", () => {
  it("routes every read through the fixed User identity", async () => {
    const { registry, context, runBot, runUser } = fixture();

    await dispatchGatewayRequest(
      "run",
      request("read", "minutes.search", {
        query: "经营会",
        start: "2026-07-01T00:00:00+08:00",
        end: "2026-07-23T23:59:59+08:00",
      }),
      registry,
      context,
    );
    await dispatchGatewayRequest(
      "run",
      request("read", "minutes.detail", {
        minuteToken: "minute_A-1",
        artifacts: ["todos", "summary"],
      }),
      registry,
      context,
    );
    await dispatchGatewayRequest(
      "run",
      request("read", "contact.search", { query: "王伟" }),
      registry,
      context,
    );

    expect(runBot).not.toHaveBeenCalled();
    expect(runUser.mock.calls.map(([value]) => value)).toEqual([
      {
        version: 1,
        operation: "minutes.search",
        payload: {
          query: "经营会",
          start: "2026-07-01T00:00:00+08:00",
          end: "2026-07-23T23:59:59+08:00",
        },
      },
      {
        version: 1,
        operation: "minutes.detail",
        payload: {
          minuteToken: "minute_A-1",
          artifacts: ["summary", "todos"],
        },
      },
      {
        version: 1,
        operation: "contact.search",
        payload: { query: "王伟", pageSize: 20 },
      },
    ]);
  });

  it.each([
    [
      "caller identity on read",
      "read",
      "minutes.search",
      {
        start: "2026-07-01T00:00:00+08:00",
        end: "2026-07-02T00:00:00+08:00",
        identity: "bot",
      },
    ],
    [
      "free URL",
      "read",
      "contact.search",
      { query: "王伟", url: "https://open.feishu.cn/anything" },
    ],
    [
      "transcript file export",
      "read",
      "minutes.detail",
      {
        minuteToken: "minute_A-1",
        artifacts: ["transcript"],
      },
    ],
    [
      "caller identity on message",
      "prepare",
      "message.send",
      { recipientOpenId: "ou_recipient", text: "开会", identity: "user" },
    ],
    [
      "recipient batch",
      "prepare",
      "message.send",
      { recipients: ["ou_a", "ou_b"], text: "开会" },
    ],
    [
      "calendar recurrence",
      "prepare",
      "calendar.create",
      {
        title: "经营会",
        start: "2026-07-24T10:00:00+08:00",
        end: "2026-07-24T11:00:00+08:00",
        zone: "Asia/Shanghai",
        attendeeOpenIds: [],
        recurrence: "weekly",
      },
    ],
    [
      "calendar timezone override",
      "prepare",
      "calendar.create",
      {
        title: "经营会",
        start: "2026-07-24T10:00:00+08:00",
        end: "2026-07-24T11:00:00+08:00",
        zone: "UTC",
        attendeeOpenIds: [],
      },
    ],
    [
      "calendar non-Shanghai timestamp",
      "prepare",
      "calendar.create",
      {
        title: "经营会",
        start: "2026-07-24T02:00:00Z",
        end: "2026-07-24T03:00:00Z",
        zone: "Asia/Shanghai",
        attendeeOpenIds: [],
      },
    ],
    [
      "duplicate attendee",
      "prepare",
      "calendar.create",
      {
        title: "经营会",
        start: "2026-07-24T10:00:00+08:00",
        end: "2026-07-24T11:00:00+08:00",
        zone: "Asia/Shanghai",
        attendeeOpenIds: ["ou_attendee", "ou_attendee"],
      },
    ],
  ] as const)(
    "rejects %s without touching a runner or the action store",
    async (_name, kind, capability, payload) => {
      const { registry, context, runBot, runUser, prepareAction } = fixture();
      const response = await dispatchGatewayRequest(
        "run",
        request(kind, capability, payload),
        registry,
        context,
      );

      expect(response).toMatchObject({
        ok: false,
        error: { code: "CAPABILITY_DENIED" },
      });
      expect(runBot).not.toHaveBeenCalled();
      expect(runUser).not.toHaveBeenCalled();
      expect(prepareAction).not.toHaveBeenCalled();
    },
  );

  it("prepares one Bot message with an immutable complete preview", async () => {
    const { registry, context, runBot, runUser, prepareAction } = fixture();
    const response = await dispatchGatewayRequest(
      "run",
      request("prepare", "message.send", {
        recipientOpenId: "ou_recipient",
        text: "请于下午三点参加经营会。",
      }),
      registry,
      context,
    );

    expect(response).toEqual({
      version: 1,
      requestId: expect.any(String),
      ok: true,
      result: {
        actionId: ACTION_ID,
        version: 1,
        payloadHash: HASH,
        expiresAt: "2026-07-23T08:30:00.000Z",
        state: "PREPARED",
      },
    });
    expect(JSON.stringify(response)).not.toContain("internal-card-nonce");
    expect(prepareAction).toHaveBeenCalledOnce();
    const prepared = prepareAction.mock.calls[0]![0];
    expect(prepared).toMatchObject({
      taskId: TASK_ID,
      capability: "message.send",
      identity: "bot",
      payload: {
        receiveIdType: "open_id",
        recipientOpenId: "ou_recipient",
        text: "请于下午三点参加经营会。",
      },
      preview: {
        action: "message.send",
        identity: "bot",
        recipient: { type: "user", openId: "ou_recipient" },
        body: { type: "text", text: "请于下午三点参加经营会。" },
        impact: "将以机器人身份向一名内部用户发送一条消息",
      },
      now: NOW,
    });
    expect(Object.isFrozen(prepared.payload)).toBe(true);
    expect(Object.isFrozen(prepared.preview)).toBe(true);
    expect(
      Object.isFrozen(
        (prepared.preview as { recipient: Readonly<object> }).recipient,
      ),
    ).toBe(true);
    expect(runBot).not.toHaveBeenCalled();
    expect(runUser).not.toHaveBeenCalled();
  });

  it("hands the nonce and immutable preview to onPrepared without leaking the nonce", async () => {
    const onPrepared = vi.fn<MvpPreparedHook>(async () => undefined);
    const { registry, context, runBot, runUser } = fixture(onPrepared);
    const response = await dispatchGatewayRequest(
      "run",
      request("prepare", "message.send", {
        recipientOpenId: "ou_recipient",
        text: "请于下午三点参加经营会。",
      }),
      registry,
      context,
    );

    expect(onPrepared).toHaveBeenCalledOnce();
    const [hookContext, prepared, preview] = onPrepared.mock.calls[0]!;
    expect(hookContext).toEqual(context);
    expect(prepared).toEqual({
      actionId: ACTION_ID,
      version: 1,
      payloadHash: HASH,
      nonce: "internal-card-nonce",
      expiresAt: "2026-07-23T08:30:00.000Z",
      state: "PREPARED",
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(preview).toMatchObject({
      action: "message.send",
      identity: "bot",
      recipient: { type: "user", openId: "ou_recipient" },
    });
    expect(Object.isFrozen(preview)).toBe(true);
    expect(JSON.stringify(response)).not.toContain("internal-card-nonce");
    expect(runBot).not.toHaveBeenCalled();
    expect(runUser).not.toHaveBeenCalled();
  });

  it("fails the gateway response when onPrepared fails without dispatching", async () => {
    const onPrepared = vi.fn(async () => {
      throw new Error("confirmation-card-unavailable");
    });
    const { registry, context, runBot, runUser, prepareAction } =
      fixture(onPrepared);
    const response = await dispatchGatewayRequest(
      "run",
      request("prepare", "message.send", {
        recipientOpenId: "ou_recipient",
        text: "请于下午三点参加经营会。",
      }),
      registry,
      context,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: "HANDLER_FAILED" },
    });
    expect(prepareAction).toHaveBeenCalledOnce();
    expect(onPrepared).toHaveBeenCalledOnce();
    expect(runBot).not.toHaveBeenCalled();
    expect(runUser).not.toHaveBeenCalled();
  });

  it("prepares only a one-time User event on the primary Shanghai calendar", async () => {
    const { registry, context, runBot, runUser, prepareAction } = fixture();
    await dispatchGatewayRequest(
      "run",
      request("prepare", "calendar.create", {
        title: "经营会",
        start: "2026-07-24T10:00:00+08:00",
        end: "2026-07-24T11:00:00+08:00",
        zone: "Asia/Shanghai",
        attendeeOpenIds: ["ou_attendee"],
      }),
      registry,
      context,
    );

    const prepared = prepareAction.mock.calls[0]![0];
    expect(prepared).toMatchObject({
      taskId: TASK_ID,
      capability: "calendar.create",
      identity: "user",
      payload: {
        calendar: "primary",
        title: "经营会",
        description: null,
        start: "2026-07-24T10:00:00+08:00",
        end: "2026-07-24T11:00:00+08:00",
        zone: "Asia/Shanghai",
        attendeeOpenIds: ["ou_attendee"],
        recurrence: "none",
      },
      preview: {
        action: "calendar.create",
        identity: "user",
        calendar: "primary",
        recurrence: "none",
        videoConference: "自动创建飞书视频会议",
        availability: "忙碌",
        reminder: "提前 5 分钟提醒",
        attendeePermission: "参会人可编辑日程",
        impact: "将在总裁主日历创建一个单次日程",
      },
    });
    expect(
      Object.isFrozen(
        (prepared.payload as { attendeeOpenIds: readonly string[] })
          .attendeeOpenIds,
      ),
    ).toBe(true);
    expect(runBot).not.toHaveBeenCalled();
    expect(runUser).not.toHaveBeenCalled();
  });

  it("rejects a normalized-but-nonexistent Shanghai calendar date", async () => {
    const { registry, context, prepareAction } = fixture();
    const response = await dispatchGatewayRequest(
      "run",
      request("prepare", "calendar.create", {
        title: "不存在的日期",
        start: "2026-02-31T10:00:00+08:00",
        end: "2026-02-31T11:00:00+08:00",
        zone: "Asia/Shanghai",
        attendeeOpenIds: [],
      }),
      registry,
      context,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: "CAPABILITY_DENIED" },
    });
    expect(prepareAction).not.toHaveBeenCalled();
  });
});
