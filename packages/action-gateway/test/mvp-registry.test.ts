import { randomUUID } from "node:crypto";
import type { PrepareActionInput } from "@executive-assistant/job-store";
import { describe, expect, it, vi } from "vitest";

import { dispatchGatewayRequest } from "../src/ipc/schemas.js";
import type {
  MvpActionPreparer,
  MvpContactResolver,
  MvpLarkCliRunner,
  MvpPreparedHook,
} from "../src/mvp/index.js";
import type { MvpDirectExecutionCoordinator } from "../src/mvp/direct-coordinator.js";
import type {
  MvpNotificationCoordinator,
  NotificationResolvedResource,
} from "../src/mvp/notification.js";
import type { BaseReadEvidence, BaseReader } from "../src/mvp/base-reader.js";
import {
  MVP_CAPABILITIES,
  createMvpGatewayRegistry,
} from "../src/mvp/index.js";

const TASK_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a21";
const ACTION_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a22";
const ATTENDEE_REF = "018f7d72-7a2b-7f45-8a12-8e20b8426a41";
const BASE_REF = "018f7d72-7a2b-7f45-8a12-8e20b8426b01";
const TABLE_REF = "018f7d72-7a2b-7f45-8a12-8e20b8426b02";
const FIELD_REF = "018f7d72-7a2b-7f45-8a12-8e20b8426b03";
const EVIDENCE_REF = "018f7d72-7a2b-7f45-8a12-8e20b8426b04";
const HASH = `sha256:${"a".repeat(64)}`;
const NOW = new Date("2026-07-23T08:00:00.000Z");

function fixture(
  onPrepared?: Parameters<typeof createMvpGatewayRegistry>[0]["onPrepared"],
  contactResolver: MvpContactResolver = Object.freeze({
    async resolve() {
      return Object.freeze({
        status: "NOT_FOUND" as const,
        recipients: Object.freeze([]),
      });
    },
    dereferenceRecipient() {
      throw new Error("recipient reference is not available");
    },
  }),
  directExecutor: MvpDirectExecutionCoordinator = Object.freeze({
    async executePresidentInstruction() {
      return Object.freeze({
        state: "FAILED" as const,
        actionId: ACTION_ID,
      });
    },
  }),
  notificationExecutor: MvpNotificationCoordinator = Object.freeze({
    async execute(plan) {
      return Object.freeze({
        state: "FAILED" as const,
        recipients: Object.freeze(
          plan.recipients.map((recipient) =>
            Object.freeze({
              name: recipient.displayName,
              state: "FAILED" as const,
            }),
          ),
        ),
        summary: Object.freeze({
          total: plan.recipients.length,
          succeeded: 0,
          failed: plan.recipients.length,
          unknown: 0,
        }),
      });
    },
  }),
  baseReader: BaseReader = Object.freeze({
    async resolve() {
      throw new Error("Base resolve is not configured");
    },
    async readSchema() {
      throw new Error("Base schema is not configured");
    },
    async readRecords() {
      throw new Error("Base records are not configured");
    },
    async queryData() {
      throw new Error("Base query is not configured");
    },
    getReadEvidence() {
      throw new Error("Base evidence is not configured");
    },
  }),
  notificationResourceResolver?: (
    taskId: string,
    resourceRef: string,
  ) => NotificationResolvedResource,
  reportDate: Date = NOW,
  now: () => Date = () => NOW,
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
    contactResolver,
    directExecutor,
    notificationExecutor,
    baseReader,
    ...(notificationResourceResolver === undefined
      ? {}
      : { notificationResourceResolver }),
    ...(onPrepared === undefined ? {} : { onPrepared }),
    reportDate,
    now,
  });
  const context = Object.freeze({
    channel: "run" as const,
    taskId: TASK_ID,
    presidentOpenId: "ou_president",
    presidentChatId: "oc_president_dm",
    capabilities: MVP_CAPABILITIES,
  });
  return {
    registry,
    context,
    runBot,
    runUser,
    prepareAction,
    directExecutor,
    notificationExecutor,
    baseReader,
  };
}

function request(
  kind: "read" | "prepare" | "execute",
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

function reportEvidenceFixture() {
  const evidence: BaseReadEvidence = Object.freeze({
    evidenceRef: EVIDENCE_REF,
    digest: `sha256:${"b".repeat(64)}`,
    scope: Object.freeze({
      resource: "base" as const,
      baseTitle: "经营驾驶舱",
      tableName: "经营数据",
      viewName: "总裁视图",
      fieldNames: Object.freeze(["区域", "收入"]),
    }),
    completeness: Object.freeze({
      complete: true,
      hasMore: false,
      truncatedBy: null,
      itemCount: 10,
    }),
  });
  const getReadEvidence = vi.fn<BaseReader["getReadEvidence"]>(
    (taskId, evidenceRef) => {
      if (taskId !== TASK_ID || evidenceRef !== EVIDENCE_REF) {
        throw new Error("Base evidence is not available");
      }
      return evidence;
    },
  );
  const baseReader: BaseReader = Object.freeze({
    async resolve() {
      throw new Error("Base resolve is not configured");
    },
    async readSchema() {
      throw new Error("Base schema is not configured");
    },
    async readRecords() {
      throw new Error("Base records are not configured");
    },
    async queryData() {
      throw new Error("Base query is not configured");
    },
    getReadEvidence,
  });
  return { baseReader, getReadEvidence, evidence };
}

describe("MVP gateway registry", () => {
  it("routes every public CLI read through the fixed User identity", async () => {
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
    ]);
  });

  it("always exposes contact.resolve through the required resolver seam", async () => {
    const resolve = vi.fn<MvpContactResolver["resolve"]>(async () => ({
      status: "NOT_FOUND",
      recipients: [{ status: "NOT_FOUND", name: "王伟" }],
    }));
    const { registry, context, runBot, runUser } = fixture(undefined, {
      resolve,
      dereferenceRecipient() {
        throw new Error("recipient reference is not available");
      },
    });

    const response = await dispatchGatewayRequest(
      "run",
      request("read", "contact.resolve", {
        recipients: [{ source: "query", name: "王伟" }],
      }),
      registry,
      context,
    );

    expect(response).toMatchObject({
      ok: true,
      result: {
        state: "SUCCEEDED",
        value: {
          status: "NOT_FOUND",
          recipients: [{ status: "NOT_FOUND", name: "王伟" }],
        },
      },
    });
    expect(resolve).toHaveBeenCalledWith(
      TASK_ID,
      { recipients: [{ source: "query", name: "王伟" }] },
      NOW,
    );
    expect(runBot).not.toHaveBeenCalled();
    expect(runUser).not.toHaveBeenCalled();
  });

  it("rejects registry construction when runtime omits the required resolver", () => {
    const runBot = vi.fn<MvpLarkCliRunner["runBot"]>();
    const runUser = vi.fn<MvpLarkCliRunner["runUser"]>();
    const prepareAction = vi.fn<MvpActionPreparer["prepareAction"]>();

    expect(() =>
      createMvpGatewayRegistry({
        runner: { runBot, runUser },
        actionStore: { prepareAction },
        now: () => NOW,
      } as never),
    ).toThrowError("invalid mvp registry dependencies");
  });

  it("rejects registry construction when runtime omits the direct executor", () => {
    const runBot = vi.fn<MvpLarkCliRunner["runBot"]>();
    const runUser = vi.fn<MvpLarkCliRunner["runUser"]>();
    const prepareAction = vi.fn<MvpActionPreparer["prepareAction"]>();

    expect(() =>
      createMvpGatewayRegistry({
        runner: { runBot, runUser },
        actionStore: { prepareAction },
        contactResolver: {
          async resolve() {
            return { status: "NOT_FOUND", recipients: [] };
          },
          dereferenceRecipient() {
            throw new Error("recipient reference is not available");
          },
        },
        now: () => NOW,
      } as never),
    ).toThrowError("invalid mvp registry dependencies");
  });

  it("rejects registry construction when runtime omits the notification executor", () => {
    const runBot = vi.fn<MvpLarkCliRunner["runBot"]>();
    const runUser = vi.fn<MvpLarkCliRunner["runUser"]>();
    const prepareAction = vi.fn<MvpActionPreparer["prepareAction"]>();

    expect(() =>
      createMvpGatewayRegistry({
        runner: { runBot, runUser },
        actionStore: { prepareAction },
        contactResolver: {
          async resolve() {
            return { status: "NOT_FOUND", recipients: [] };
          },
          dereferenceRecipient() {
            throw new Error("recipient reference is not available");
          },
        },
        directExecutor: {
          async executePresidentInstruction() {
            return {
              state: "FAILED",
              actionId: ACTION_ID,
            };
          },
        },
        now: () => NOW,
      } as never),
    ).toThrowError("invalid mvp registry dependencies");
  });

  it("rejects registry construction when runtime omits the task-local Base reader", () => {
    const runBot = vi.fn<MvpLarkCliRunner["runBot"]>();
    const runUser = vi.fn<MvpLarkCliRunner["runUser"]>();
    const prepareAction = vi.fn<MvpActionPreparer["prepareAction"]>();

    expect(() =>
      createMvpGatewayRegistry({
        runner: { runBot, runUser },
        actionStore: { prepareAction },
        contactResolver: {
          async resolve() {
            return { status: "NOT_FOUND", recipients: [] };
          },
          dereferenceRecipient() {
            throw new Error("recipient reference is not available");
          },
        },
        directExecutor: {
          async executePresidentInstruction() {
            return { state: "FAILED", actionId: ACTION_ID };
          },
        },
        notificationExecutor: {
          async execute() {
            return {
              state: "FAILED",
              recipients: [],
              summary: { total: 0, succeeded: 0, failed: 0, unknown: 0 },
            };
          },
        },
        now: () => NOW,
      } as never),
    ).toThrowError("invalid mvp registry dependencies");
  });

  it("denies forged legacy contact.search even when a context advertises it", async () => {
    const { registry, context, runBot, runUser, prepareAction } = fixture();
    const response = await dispatchGatewayRequest(
      "run",
      request("read", "contact.search", { query: "王伟" }),
      registry,
      Object.freeze({
        ...context,
        capabilities: Object.freeze([...MVP_CAPABILITIES, "contact.search"]),
      }),
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: "CAPABILITY_DENIED" },
    });
    expect(runBot).not.toHaveBeenCalled();
    expect(runUser).not.toHaveBeenCalled();
    expect(prepareAction).not.toHaveBeenCalled();
  });

  it("routes all four public Base capabilities through one task-local reader as read-only operations", async () => {
    const evidence = Object.freeze({
      evidenceRef: EVIDENCE_REF,
      digest: `sha256:${"b".repeat(64)}`,
      scope: Object.freeze({
        resource: "base" as const,
        baseTitle: "经营日报",
        tableName: "经营数据",
        fieldNames: Object.freeze(["区域"]),
      }),
      completeness: Object.freeze({
        complete: true,
        hasMore: false,
        truncatedBy: null,
        itemCount: 1,
      }),
    });
    const resolve = vi.fn<BaseReader["resolve"]>(async () => ({
      status: "RESOLVED",
      resource: { baseRef: BASE_REF, title: "经营日报" },
      evidence,
    }));
    const readSchema = vi.fn<BaseReader["readSchema"]>(async () => ({
      status: "RESOLVED",
      table: { tableRef: TABLE_REF, name: "经营数据" },
      fields: [{ fieldRef: FIELD_REF, name: "区域", type: "text" }],
      views: [],
      evidence,
    }));
    const readRecords = vi.fn<BaseReader["readRecords"]>(async () => ({
      status: "RESOLVED",
      table: { tableRef: TABLE_REF, name: "经营数据" },
      columns: [{ fieldRef: FIELD_REF, name: "区域", type: "text" }],
      rows: [{ values: ["华北"] }],
      evidence,
    }));
    const queryData = vi.fn<BaseReader["queryData"]>(async () => ({
      status: "RESOLVED",
      kind: "DIMENSION_ROWS",
      table: { tableRef: TABLE_REF, name: "经营数据" },
      columns: [
        {
          kind: "dimension",
          fieldRef: FIELD_REF,
          name: "区域",
          type: "text",
        },
      ],
      rows: [{ values: ["华北"] }],
      evidence,
    }));
    const baseReader: BaseReader = {
      resolve,
      readSchema,
      readRecords,
      queryData,
      getReadEvidence() {
        return evidence;
      },
    };
    const current = fixture(
      undefined,
      undefined,
      undefined,
      undefined,
      baseReader,
    );

    const responses = await Promise.all([
      dispatchGatewayRequest(
        "run",
        request("read", "base.resolve", {
          source: "url",
          url: "https://example.feishu.cn/base/bascnTrusted",
        }),
        current.registry,
        current.context,
      ),
      dispatchGatewayRequest(
        "run",
        request("read", "base.schema.read", { baseRef: BASE_REF }),
        current.registry,
        current.context,
      ),
      dispatchGatewayRequest(
        "run",
        request("read", "base.records.read", {
          tableRef: TABLE_REF,
          fieldRefs: [FIELD_REF],
          viewRef: null,
        }),
        current.registry,
        current.context,
      ),
      dispatchGatewayRequest(
        "run",
        request("read", "base.data.query", {
          baseRef: BASE_REF,
          tableRef: TABLE_REF,
          dimensionFieldRefs: [FIELD_REF],
          aggregates: [],
          filter: null,
          sort: [],
          limit: 100,
        }),
        current.registry,
        current.context,
      ),
    ]);

    expect(responses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ok: true,
          result: expect.objectContaining({
            state: "SUCCEEDED",
            value: expect.objectContaining({ status: "RESOLVED" }),
          }),
        }),
      ]),
    );
    expect(resolve).toHaveBeenCalledWith(
      TASK_ID,
      {
        source: "url",
        url: "https://example.feishu.cn/base/bascnTrusted",
      },
      NOW,
    );
    expect(readSchema).toHaveBeenCalledWith(
      TASK_ID,
      { baseRef: BASE_REF },
      NOW,
    );
    expect(readRecords).toHaveBeenCalledWith(
      TASK_ID,
      {
        tableRef: TABLE_REF,
        fieldRefs: [FIELD_REF],
        viewRef: null,
      },
      NOW,
    );
    expect(queryData).toHaveBeenCalledWith(
      TASK_ID,
      {
        baseRef: BASE_REF,
        tableRef: TABLE_REF,
        dimensionFieldRefs: [FIELD_REF],
        aggregates: [],
        filter: null,
        sort: [],
        limit: 100,
      },
      NOW,
    );
    expect(current.runBot).not.toHaveBeenCalled();
    expect(current.runUser).not.toHaveBeenCalled();
    expect(current.prepareAction).not.toHaveBeenCalled();
    expect(JSON.stringify(responses)).not.toMatch(
      /bascnTrusted|baseToken|tableId|fieldId|rawDsl|rawError/,
    );
  });

  it.each([
    [
      "URL used as an opaque ref",
      "base.schema.read",
      { baseRef: "https://example.feishu.cn/base/bascnTrusted" },
    ],
    [
      "raw Base token",
      "base.resolve",
      {
        source: "url",
        url: "https://example.feishu.cn/base/bascnTrusted",
        baseToken: "bascnTrusted",
      },
    ],
    [
      "raw table ID",
      "base.schema.read",
      { baseRef: BASE_REF, tableId: "tblTrusted" },
    ],
    [
      "raw record DSL",
      "base.records.read",
      {
        tableRef: TABLE_REF,
        fieldRefs: [FIELD_REF],
        viewRef: null,
        rawDsl: {},
      },
    ],
    [
      "raw query DSL",
      "base.data.query",
      {
        baseRef: BASE_REF,
        tableRef: TABLE_REF,
        dimensionFieldRefs: [FIELD_REF],
        aggregates: [],
        filter: null,
        sort: [],
        limit: 100,
        dsl: { datasource: { tableId: "tblTrusted" } },
      },
    ],
  ] as const)(
    "rejects Base %s before reader, runner, or action-store access",
    async (_label, capability, payload) => {
      const resolve = vi.fn<BaseReader["resolve"]>();
      const readSchema = vi.fn<BaseReader["readSchema"]>();
      const readRecords = vi.fn<BaseReader["readRecords"]>();
      const queryData = vi.fn<BaseReader["queryData"]>();
      const current = fixture(undefined, undefined, undefined, undefined, {
        resolve,
        readSchema,
        readRecords,
        queryData,
        getReadEvidence() {
          throw new Error("unavailable");
        },
      });

      const response = await dispatchGatewayRequest(
        "run",
        request("read", capability, payload),
        current.registry,
        current.context,
      );

      expect(response).toMatchObject({
        ok: false,
        error: { code: "CAPABILITY_DENIED" },
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(readSchema).not.toHaveBeenCalled();
      expect(readRecords).not.toHaveBeenCalled();
      expect(queryData).not.toHaveBeenCalled();
      expect(current.runBot).not.toHaveBeenCalled();
      expect(current.runUser).not.toHaveBeenCalled();
      expect(current.prepareAction).not.toHaveBeenCalled();
    },
  );

  it("keeps internal raw-token Base routes unavailable as public capabilities", async () => {
    const resolve = vi.fn<BaseReader["resolve"]>();
    const current = fixture(undefined, undefined, undefined, undefined, {
      resolve,
      readSchema: vi.fn(),
      readRecords: vi.fn(),
      queryData: vi.fn(),
      getReadEvidence() {
        throw new Error("unavailable");
      },
    });

    const response = await dispatchGatewayRequest(
      "run",
      request("read", "base.url.resolve", {
        url: "https://example.feishu.cn/base/bascnTrusted",
      }),
      current.registry,
      Object.freeze({
        ...current.context,
        capabilities: Object.freeze([...MVP_CAPABILITIES, "base.url.resolve"]),
      }),
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: "CAPABILITY_DENIED" },
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(current.runUser).not.toHaveBeenCalled();
  });

  it("projects an interrupted Base page as a handler failure rather than an empty result", async () => {
    const readRecords = vi.fn<BaseReader["readRecords"]>(async () => {
      throw new Error("Base records CLI result is unavailable");
    });
    const current = fixture(undefined, undefined, undefined, undefined, {
      resolve: vi.fn(),
      readSchema: vi.fn(),
      readRecords,
      queryData: vi.fn(),
      getReadEvidence() {
        throw new Error("unavailable");
      },
    });

    const response = await dispatchGatewayRequest(
      "run",
      request("read", "base.records.read", {
        tableRef: TABLE_REF,
        fieldRefs: [FIELD_REF],
        viewRef: null,
      }),
      current.registry,
      current.context,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: "HANDLER_FAILED" },
    });
    expect(response).not.toHaveProperty("result");
    expect(readRecords).toHaveBeenCalledOnce();
    expect(current.runBot).not.toHaveBeenCalled();
    expect(current.runUser).not.toHaveBeenCalled();
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

  it("executes a no-attendee event directly with a trusted stable plan and no confirmation path", async () => {
    const executePresidentInstruction = vi.fn<
      MvpDirectExecutionCoordinator["executePresidentInstruction"]
    >(async () => ({
      state: "SUCCEEDED",
      actionId: ACTION_ID,
      remoteId: "event_direct_1",
    }));
    const onPrepared = vi.fn<MvpPreparedHook>();
    const current = fixture(
      onPrepared,
      undefined,
      Object.freeze({ executePresidentInstruction }),
    );

    const response = await dispatchGatewayRequest(
      "run",
      request("execute", "calendar.create.direct", {
        title: "经营会",
        startLocal: "2026-07-24T10:00:00",
        attendeeRefs: [],
      }),
      current.registry,
      current.context,
    );

    expect(response).toEqual({
      version: 1,
      requestId: expect.any(String),
      ok: true,
      result: {
        state: "SUCCEEDED",
        value: {
          eventId: "event_direct_1",
          title: "经营会",
          start: "2026-07-24T10:00:00+08:00",
          end: "2026-07-24T11:00:00+08:00",
          zone: "Asia/Shanghai",
          attendeeDisplayNames: [],
        },
      },
    });
    expect(executePresidentInstruction).toHaveBeenCalledWith({
      taskId: TASK_ID,
      capability: "calendar.create.direct",
      identity: "user",
      itemKey: expect.stringMatching(/^calendar:sha256:[0-9a-f]{64}$/),
      payload: {
        calendar: "primary",
        title: "经营会",
        description: null,
        start: "2026-07-24T10:00:00+08:00",
        end: "2026-07-24T11:00:00+08:00",
        zone: "Asia/Shanghai",
        attendeeOpenIds: [],
        recurrence: "none",
      },
      preview: {
        action: "calendar.create.direct",
        title: "经营会",
        description: null,
        start: "2026-07-24T10:00:00+08:00",
        end: "2026-07-24T11:00:00+08:00",
        zone: "Asia/Shanghai",
        attendeeCount: 0,
        impact: "将在总裁主日历创建一个单次日程",
      },
    });
    expect(current.prepareAction).not.toHaveBeenCalled();
    expect(onPrepared).not.toHaveBeenCalled();
    expect(current.runBot).not.toHaveBeenCalled();
    expect(current.runUser).not.toHaveBeenCalled();
  });

  it("uses only same-task resolved refs and returns attendee display names without open IDs", async () => {
    const resolve = vi.fn<MvpContactResolver["resolve"]>(async () => ({
      status: "RESOLVED",
      recipients: [
        {
          status: "RESOLVED",
          name: "王伟",
          department: "融创中国-总部-总裁办公室",
          recipientRef: ATTENDEE_REF,
        },
      ],
    }));
    const dereferenceRecipient = vi.fn(() => "ou_internal_wang");
    const executePresidentInstruction = vi.fn<
      MvpDirectExecutionCoordinator["executePresidentInstruction"]
    >(async () => ({
      state: "SUCCEEDED",
      actionId: ACTION_ID,
      remoteId: "event_direct_attendee",
    }));
    const onPrepared = vi.fn<MvpPreparedHook>();
    const current = fixture(
      onPrepared,
      { resolve, dereferenceRecipient },
      { executePresidentInstruction },
    );

    await dispatchGatewayRequest(
      "run",
      request("read", "contact.resolve", {
        recipients: [{ source: "query", name: "王伟" }],
      }),
      current.registry,
      current.context,
    );
    const response = await dispatchGatewayRequest(
      "run",
      request("execute", "calendar.create.direct", {
        title: "经营会",
        description: "讨论月度经营情况",
        startLocal: "2026-07-24T10:00:00",
        endLocal: "2026-07-24T12:00:00",
        attendeeRefs: [ATTENDEE_REF],
      }),
      current.registry,
      current.context,
    );

    expect(response).toMatchObject({
      ok: true,
      result: {
        state: "SUCCEEDED",
        value: {
          eventId: "event_direct_attendee",
          attendeeDisplayNames: ["王伟"],
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain("ou_internal_wang");
    expect(dereferenceRecipient).toHaveBeenCalledWith(TASK_ID, ATTENDEE_REF);
    expect(executePresidentInstruction).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: TASK_ID,
        identity: "user",
        payload: expect.objectContaining({
          calendar: "primary",
          attendeeOpenIds: ["ou_internal_wang"],
        }),
      }),
    );
    expect(current.prepareAction).not.toHaveBeenCalled();
    expect(onPrepared).not.toHaveBeenCalled();
  });

  it("rejects an unavailable attendee before authorization or any CLI call", async () => {
    const executePresidentInstruction =
      vi.fn<MvpDirectExecutionCoordinator["executePresidentInstruction"]>();
    const current = fixture(undefined, undefined, {
      executePresidentInstruction,
    });

    const response = await dispatchGatewayRequest(
      "run",
      request("execute", "calendar.create.direct", {
        title: "经营会",
        startLocal: "2026-07-24T10:00:00",
        attendeeRefs: [ATTENDEE_REF],
      }),
      current.registry,
      current.context,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: "HANDLER_FAILED" },
    });
    expect(executePresidentInstruction).not.toHaveBeenCalled();
    expect(current.prepareAction).not.toHaveBeenCalled();
    expect(current.runBot).not.toHaveBeenCalled();
    expect(current.runUser).not.toHaveBeenCalled();
  });

  it("returns a non-executed result for a completely past event before authorization", async () => {
    const executePresidentInstruction =
      vi.fn<MvpDirectExecutionCoordinator["executePresidentInstruction"]>();
    const current = fixture(undefined, undefined, {
      executePresidentInstruction,
    });

    const response = await dispatchGatewayRequest(
      "run",
      request("execute", "calendar.create.direct", {
        title: "已经结束的经营会",
        startLocal: "2026-07-23T10:00:00",
        endLocal: "2026-07-23T11:00:00",
        attendeeRefs: [],
      }),
      current.registry,
      current.context,
    );

    expect(response).toMatchObject({
      ok: true,
      result: {
        state: "NOT_EXECUTED",
        reason: "EVENT_ALREADY_ENDED",
      },
    });
    expect(executePresidentInstruction).not.toHaveBeenCalled();
    expect(current.prepareAction).not.toHaveBeenCalled();
  });

  it("projects direct execution uncertainty without exposing a ledger action ID", async () => {
    const current = fixture(undefined, undefined, {
      async executePresidentInstruction() {
        return {
          state: "UNKNOWN",
          actionId: ACTION_ID,
        };
      },
    });

    const response = await dispatchGatewayRequest(
      "run",
      request("execute", "calendar.create.direct", {
        title: "经营会",
        startLocal: "2026-07-24T10:00:00",
        attendeeRefs: [],
      }),
      current.registry,
      current.context,
    );

    expect(response).toMatchObject({
      ok: true,
      result: { state: "UNKNOWN" },
    });
    expect(JSON.stringify(response)).not.toContain(ACTION_ID);
  });

  it("creates one native report from same-task Base evidence and returns only a fixed link, title, and up to three conclusions", async () => {
    const executePresidentInstruction = vi.fn<
      MvpDirectExecutionCoordinator["executePresidentInstruction"]
    >(async () => ({
      state: "SUCCEEDED",
      actionId: ACTION_ID,
      remoteId: "doxcnReportDocument1",
    }));
    const reportEvidence = reportEvidenceFixture();
    const current = fixture(
      undefined,
      undefined,
      { executePresidentInstruction },
      undefined,
      reportEvidence.baseReader,
    );

    const response = await dispatchGatewayRequest(
      "run",
      request("execute", "document.report.create", {
        evidenceRefs: [EVIDENCE_REF],
        conclusions: [
          "收入保持增长",
          "华北贡献最大",
          "回款节奏改善",
          "第四条不进入公开摘要",
        ],
        metrics: [{ label: "收入", value: "1.2 亿元" }],
        risks: ["华南低于预算"],
        actions: ["复核华南重点项目"],
      }),
      current.registry,
      current.context,
    );

    expect(response).toEqual({
      version: 1,
      requestId: expect.any(String),
      ok: true,
      result: {
        state: "SUCCEEDED",
        value: {
          url: "https://feishu.cn/docx/doxcnReportDocument1",
          title: "经营驾驶舱分析报告｜2026-07-23",
          conclusions: ["收入保持增长", "华北贡献最大", "回款节奏改善"],
        },
      },
    });
    expect(reportEvidence.getReadEvidence).toHaveBeenCalledWith(
      TASK_ID,
      EVIDENCE_REF,
    );
    expect(executePresidentInstruction).toHaveBeenCalledWith({
      taskId: TASK_ID,
      capability: "document.report.create",
      identity: "user",
      itemKey: expect.stringMatching(/^document-report:sha256:[0-9a-f]{64}$/),
      payload: {
        docFormat: "xml",
        parentPosition: "my_library",
        title: "经营驾驶舱分析报告｜2026-07-23",
        content: expect.stringContaining("<heading>数据来源与口径</heading>"),
      },
      preview: {
        action: "document.report.create",
        title: "经营驾驶舱分析报告｜2026-07-23",
        conclusions: ["收入保持增长", "华北贡献最大", "回款节奏改善"],
        evidenceCount: 1,
        impact: "将在总裁个人云空间创建一份原生飞书云文档",
      },
    });
    const publicValue = (
      response as unknown as { result: { value: Readonly<object> } }
    ).result.value;
    expect(Reflect.ownKeys(publicValue)).toEqual([
      "url",
      "title",
      "conclusions",
    ]);
    expect(JSON.stringify(response)).not.toMatch(
      /actionId|documentId|document_id|revision|token|<doc>|xml/i,
    );
    expect(current.prepareAction).not.toHaveBeenCalled();
    expect(current.runBot).not.toHaveBeenCalled();
    expect(current.runUser).not.toHaveBeenCalled();
  });

  it("keeps the same report action and title when one task is replayed across Shanghai midnight or a registry restart", async () => {
    const executePresidentInstruction = vi.fn<
      MvpDirectExecutionCoordinator["executePresidentInstruction"]
    >(async () => ({
      state: "UNKNOWN",
      actionId: ACTION_ID,
    }));
    const reportDate = new Date("2026-07-31T15:00:00.000Z");
    const beforeMidnight = reportEvidenceFixture();
    const afterMidnight = reportEvidenceFixture();
    const first = fixture(
      undefined,
      undefined,
      { executePresidentInstruction },
      undefined,
      beforeMidnight.baseReader,
      undefined,
      reportDate,
      () => new Date("2026-07-31T15:59:59.000Z"),
    );
    const restarted = fixture(
      undefined,
      undefined,
      { executePresidentInstruction },
      undefined,
      afterMidnight.baseReader,
      undefined,
      reportDate,
      () => new Date("2026-07-31T16:00:01.000Z"),
    );
    const payload = {
      evidenceRefs: [EVIDENCE_REF],
      conclusions: ["收入保持增长"],
      metrics: [],
      risks: [],
      actions: [],
    };

    const firstResponse = await dispatchGatewayRequest(
      "run",
      request("execute", "document.report.create", payload),
      first.registry,
      first.context,
    );
    const replayResponse = await dispatchGatewayRequest(
      "run",
      request("execute", "document.report.create", payload),
      restarted.registry,
      restarted.context,
    );

    expect(firstResponse).toMatchObject({
      ok: true,
      result: { state: "UNKNOWN" },
    });
    expect(replayResponse).toMatchObject({
      ok: true,
      result: { state: "UNKNOWN" },
    });
    expect(executePresidentInstruction).toHaveBeenCalledTimes(2);
    expect(executePresidentInstruction.mock.calls[1]?.[0]).toEqual(
      executePresidentInstruction.mock.calls[0]?.[0],
    );
    expect(executePresidentInstruction.mock.calls[0]?.[0]).toMatchObject({
      itemKey: expect.stringMatching(/^document-report:sha256:[0-9a-f]{64}$/),
      payload: {
        title: "经营驾驶舱分析报告｜2026-07-31",
      },
    });
  });

  it.each(["FAILED", "UNKNOWN"] as const)(
    "projects a report %s terminal result without ledger identifiers or receipts",
    async (state) => {
      const reportEvidence = reportEvidenceFixture();
      const current = fixture(
        undefined,
        undefined,
        {
          async executePresidentInstruction() {
            return { state, actionId: ACTION_ID };
          },
        },
        undefined,
        reportEvidence.baseReader,
      );

      const response = await dispatchGatewayRequest(
        "run",
        request("execute", "document.report.create", {
          evidenceRefs: [EVIDENCE_REF],
          conclusions: ["收入保持增长"],
          metrics: [],
          risks: [],
          actions: [],
        }),
        current.registry,
        current.context,
      );

      expect(response).toEqual({
        version: 1,
        requestId: expect.any(String),
        ok: true,
        result: { state },
      });
      expect(JSON.stringify(response)).not.toMatch(
        /actionId|documentId|document_id|revision|token|url/i,
      );
    },
  );

  it.each([
    ["free XML", { xml: "<doc>caller-controlled</doc>" }],
    ["free URL", { url: "https://example.feishu.cn/docx/doxcnCaller" }],
    ["document ID", { documentId: "doxcnCaller" }],
    ["parent token", { parentToken: "fldcnCaller" }],
    ["file path", { path: "/tmp/report.xml" }],
    ["identity", { identity: "bot" }],
  ] as const)(
    "rejects report %s before evidence or execution",
    async (_label, extra) => {
      const reportEvidence = reportEvidenceFixture();
      const executePresidentInstruction =
        vi.fn<MvpDirectExecutionCoordinator["executePresidentInstruction"]>();
      const current = fixture(
        undefined,
        undefined,
        { executePresidentInstruction },
        undefined,
        reportEvidence.baseReader,
      );

      const response = await dispatchGatewayRequest(
        "run",
        request("execute", "document.report.create", {
          evidenceRefs: [EVIDENCE_REF],
          conclusions: ["收入保持增长"],
          metrics: [],
          risks: [],
          actions: [],
          ...extra,
        }),
        current.registry,
        current.context,
      );

      expect(response).toMatchObject({
        ok: false,
        error: { code: "CAPABILITY_DENIED" },
      });
      expect(reportEvidence.getReadEvidence).not.toHaveBeenCalled();
      expect(executePresidentInstruction).not.toHaveBeenCalled();
      expect(current.runBot).not.toHaveBeenCalled();
      expect(current.runUser).not.toHaveBeenCalled();
    },
  );

  it("executes a composed multi-recipient notification directly after same-task resolution", async () => {
    const recipientRefB = "018f7d72-7a2b-7f45-8a12-8e20b8426a42";
    const contactResolver: MvpContactResolver = {
      async resolve() {
        return {
          status: "RESOLVED",
          recipients: [
            {
              status: "RESOLVED",
              name: "王伟",
              department: "融创中国-总部-总裁办公室",
              recipientRef: ATTENDEE_REF,
            },
            {
              status: "RESOLVED",
              name: "李娜",
              department: "融创中国-直管业务-文旅事业部",
              recipientRef: recipientRefB,
            },
          ],
        };
      },
      dereferenceRecipient(_taskId, recipientRef) {
        if (recipientRef === ATTENDEE_REF) return "ou_b";
        if (recipientRef === recipientRefB) return "ou_a";
        throw new Error("unavailable recipient");
      },
    };
    const execute = vi.fn<MvpNotificationCoordinator["execute"]>(
      async (plan) => ({
        state: "SUCCEEDED",
        recipients: plan.recipients.map((recipient) => ({
          name: recipient.displayName,
          state: "SUCCEEDED",
        })),
        summary: {
          total: plan.recipients.length,
          succeeded: plan.recipients.length,
          failed: 0,
          unknown: 0,
        },
      }),
    );
    const onPrepared = vi.fn<MvpPreparedHook>();
    const current = fixture(onPrepared, contactResolver, undefined, {
      execute,
    });
    await dispatchGatewayRequest(
      "run",
      request("read", "contact.resolve", {
        recipients: [
          { source: "query", name: "王伟" },
          { source: "query", name: "李娜" },
        ],
      }),
      current.registry,
      current.context,
    );

    const response = await dispatchGatewayRequest(
      "run",
      request("execute", "notification.send.direct", {
        recipientRefs: [ATTENDEE_REF, recipientRefB],
        content: {
          kind: "text",
          text: "请于今天下班前反馈经营数据。",
          wording: "composed",
        },
        attachmentRefs: [],
      }),
      current.registry,
      current.context,
    );

    expect(response).toMatchObject({
      ok: true,
      result: {
        state: "SUCCEEDED",
        recipients: [
          { name: "李娜", state: "SUCCEEDED" },
          { name: "王伟", state: "SUCCEEDED" },
        ],
        summary: { total: 2, succeeded: 2, failed: 0, unknown: 0 },
      },
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: TASK_ID,
        capability: "notification.send.direct",
        identity: "bot",
        batchKey: expect.stringMatching(/^notification:sha256:[0-9a-f]{64}$/),
        recipients: [
          expect.objectContaining({
            openId: "ou_a",
            displayName: "李娜",
          }),
          expect.objectContaining({
            openId: "ou_b",
            displayName: "王伟",
          }),
        ],
      }),
    );
    expect(current.prepareAction).not.toHaveBeenCalled();
    expect(onPrepared).not.toHaveBeenCalled();
    expect(current.runBot).not.toHaveBeenCalled();
    expect(current.runUser).not.toHaveBeenCalled();
  });

  it("aborts the whole notification batch before action creation or execution when any recipient becomes unavailable", async () => {
    const recipientRefB = "018f7d72-7a2b-7f45-8a12-8e20b8426a42";
    let notificationPhase = false;
    const contactResolver: MvpContactResolver = {
      async resolve() {
        return {
          status: "RESOLVED",
          recipients: [
            {
              status: "RESOLVED",
              name: "王伟",
              department: "融创中国-总部-总裁办公室",
              recipientRef: ATTENDEE_REF,
            },
            {
              status: "RESOLVED",
              name: "李娜",
              department: "融创中国-直管业务-文旅事业部",
              recipientRef: recipientRefB,
            },
          ],
        };
      },
      dereferenceRecipient(_taskId, recipientRef) {
        if (recipientRef === ATTENDEE_REF) return "ou_wang";
        if (recipientRef === recipientRefB && !notificationPhase) {
          return "ou_li";
        }
        throw new Error("recipient reference is unavailable");
      },
    };
    const execute = vi.fn<MvpNotificationCoordinator["execute"]>();
    const onPrepared = vi.fn<MvpPreparedHook>();
    const current = fixture(onPrepared, contactResolver, undefined, {
      execute,
    });
    const resolved = await dispatchGatewayRequest(
      "run",
      request("read", "contact.resolve", {
        recipients: [
          { source: "query", name: "王伟" },
          { source: "query", name: "李娜" },
        ],
      }),
      current.registry,
      current.context,
    );
    expect(resolved.ok).toBe(true);
    notificationPhase = true;

    const response = await dispatchGatewayRequest(
      "run",
      request("execute", "notification.send.direct", {
        recipientRefs: [ATTENDEE_REF, recipientRefB],
        content: {
          kind: "text",
          text: "请于今天下班前反馈经营数据。",
          wording: "composed",
        },
        attachmentRefs: [],
      }),
      current.registry,
      current.context,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: "HANDLER_FAILED" },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(current.prepareAction).not.toHaveBeenCalled();
    expect(onPrepared).not.toHaveBeenCalled();
    expect(current.runBot).not.toHaveBeenCalled();
    expect(current.runUser).not.toHaveBeenCalled();
  });

  it("aborts the whole notification batch before action creation or execution when any resource becomes unavailable", async () => {
    const imageRef = "018f7d72-7a2b-7f45-8a12-8e20b8426a70";
    const fileRef = "018f7d72-7a2b-7f45-8a12-8e20b8426a71";
    const contactResolver: MvpContactResolver = {
      async resolve() {
        return {
          status: "RESOLVED",
          recipients: [
            {
              status: "RESOLVED",
              name: "王伟",
              department: "融创中国-总部-总裁办公室",
              recipientRef: ATTENDEE_REF,
            },
          ],
        };
      },
      dereferenceRecipient(_taskId, recipientRef) {
        if (recipientRef === ATTENDEE_REF) return "ou_wang";
        throw new Error("recipient reference is unavailable");
      },
    };
    const resolveResource = vi.fn(
      (_taskId: string, resourceRef: string): NotificationResolvedResource => {
        if (resourceRef === imageRef) {
          return {
            sourceKind: "current",
            kind: "image",
            displayName: "现场照片.png",
            relativePath: `resources/02-${imageRef}.bin`,
            sizeBytes: 8,
            sha256: `sha256:${"b".repeat(64)}`,
          };
        }
        throw new Error("resource reference is unavailable");
      },
    );
    const execute = vi.fn<MvpNotificationCoordinator["execute"]>();
    const onPrepared = vi.fn<MvpPreparedHook>();
    const current = fixture(
      onPrepared,
      contactResolver,
      undefined,
      { execute },
      undefined,
      resolveResource,
    );
    const resolved = await dispatchGatewayRequest(
      "run",
      request("read", "contact.resolve", {
        recipients: [{ source: "query", name: "王伟" }],
      }),
      current.registry,
      current.context,
    );
    expect(resolved.ok).toBe(true);

    const response = await dispatchGatewayRequest(
      "run",
      request("execute", "notification.send.direct", {
        recipientRefs: [ATTENDEE_REF],
        content: {
          kind: "text",
          text: "请查收附件。",
          wording: "composed",
        },
        attachmentRefs: [imageRef, fileRef],
      }),
      current.registry,
      current.context,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: "HANDLER_FAILED" },
    });
    expect(resolveResource).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    expect(current.prepareAction).not.toHaveBeenCalled();
    expect(onPrepared).not.toHaveBeenCalled();
    expect(current.runBot).not.toHaveBeenCalled();
    expect(current.runUser).not.toHaveBeenCalled();
  });

  it.each([
    {
      recipientRefs: [ATTENDEE_REF],
      content: { kind: "text", text: "原文", wording: "verbatim" },
      attachmentRefs: [],
    },
    {
      recipientRefs: [ATTENDEE_REF],
      content: { kind: "text", text: "通知", wording: "composed" },
      attachmentRefs: ["018f7d72-7a2b-7f45-8a12-8e20b8426a70"],
    },
  ])(
    "rejects out-of-scope notification payload before execution or confirmation",
    async (payload) => {
      const execute = vi.fn<MvpNotificationCoordinator["execute"]>();
      const onPrepared = vi.fn<MvpPreparedHook>();
      const current = fixture(onPrepared, undefined, undefined, { execute });

      const response = await dispatchGatewayRequest(
        "run",
        request("execute", "notification.send.direct", payload),
        current.registry,
        current.context,
      );

      expect(response).toMatchObject({
        ok: false,
        error: { code: "HANDLER_FAILED" },
      });
      expect(execute).not.toHaveBeenCalled();
      expect(current.prepareAction).not.toHaveBeenCalled();
      expect(onPrepared).not.toHaveBeenCalled();
      expect(current.runBot).not.toHaveBeenCalled();
      expect(current.runUser).not.toHaveBeenCalled();
    },
  );

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
