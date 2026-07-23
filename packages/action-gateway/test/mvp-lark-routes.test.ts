import { describe, expect, it } from "vitest";

import { createMvpLarkCliRouteRegistry } from "../src/mvp/lark-routes.js";

function route(identity: "bot" | "user", operation: string) {
  const value = createMvpLarkCliRouteRegistry().lookup(identity, operation);
  if (value === undefined) throw new Error("expected mvp lark-cli route");
  return value;
}

function invocation(
  identity: "bot" | "user",
  operation: string,
  payload: unknown,
) {
  const selected = route(identity, operation);
  const parsed = selected.parsePayload(payload);
  return {
    route: selected,
    plan: selected.buildInvocation(parsed as never),
  };
}

describe("production MVP lark-cli route registry", () => {
  it("maps minutes search and detail to exact fixed User read argv", () => {
    const search = invocation("user", "minutes.search", {
      query: "经营会",
      start: "2026-07-01T00:00:00+08:00",
      end: "2026-07-23T23:59:59+08:00",
    });
    const detail = invocation("user", "minutes.detail", {
      minuteToken: "minute_A-1",
      artifacts: ["todos", "summary"],
    });

    expect(search.route).toMatchObject({
      identity: "user",
      operation: "minutes.search",
      effect: "read",
    });
    expect(search.plan).toEqual({
      operationArgs: [
        "minutes",
        "+search",
        "--start",
        "2026-07-01T00:00:00+08:00",
        "--end",
        "2026-07-23T23:59:59+08:00",
        "--query",
        "经营会",
        "--page-size",
        "15",
      ],
      jsonInputs: [],
    });
    expect(detail.route).toMatchObject({
      identity: "user",
      operation: "minutes.detail",
      effect: "read",
    });
    expect(detail.plan).toEqual({
      operationArgs: [
        "minutes",
        "+detail",
        "--minute-tokens",
        "minute_A-1",
        "--summary",
        "--todo",
      ],
      jsonInputs: [],
    });
    expect(
      createMvpLarkCliRouteRegistry().lookup("bot", "minutes.search"),
    ).toBeUndefined();
  });

  it("maps contact search to fixed User page size 20", () => {
    const result = invocation("user", "contact.search", {
      query: "王伟",
      pageSize: 20,
    });

    expect(result.route).toMatchObject({
      identity: "user",
      effect: "read",
    });
    expect(result.plan.operationArgs).toEqual([
      "contact",
      "+search-user",
      "--query",
      "王伟",
      "--page-size",
      "20",
      "--exclude-external-users",
    ]);
  });

  it("maps a single message to fixed Bot write argv", () => {
    const result = invocation("bot", "message.send", {
      receiveIdType: "open_id",
      recipientOpenId: "ou_recipient",
      text: "请参加经营会。",
      idempotencyKey: "018f7d72-7a2b-7f45-8a12-8e20b8426a22",
    });

    expect(result.route).toMatchObject({
      identity: "bot",
      effect: "write",
    });
    expect(result.plan.operationArgs).toEqual([
      "im",
      "+messages-send",
      "--user-id",
      "ou_recipient",
      "--text",
      "请参加经营会。",
      "--idempotency-key",
      "018f7d72-7a2b-7f45-8a12-8e20b8426a22",
    ]);
    expect(
      createMvpLarkCliRouteRegistry().lookup("user", "message.send"),
    ).toBeUndefined();
  });

  it("maps a one-time primary Shanghai calendar action to fixed User write argv", () => {
    const result = invocation("user", "calendar.create", {
      calendar: "primary",
      title: "经营会",
      description: "讨论下季度计划",
      start: "2026-07-24T10:00:00+08:00",
      end: "2026-07-24T11:00:00+08:00",
      zone: "Asia/Shanghai",
      attendeeOpenIds: ["ou_attendee"],
      recurrence: "none",
    });

    expect(result.route).toMatchObject({
      identity: "user",
      effect: "write",
    });
    expect(result.plan.operationArgs).toEqual([
      "calendar",
      "+create",
      "--calendar-id",
      "primary",
      "--summary",
      "经营会",
      "--start",
      "2026-07-24T10:00:00+08:00",
      "--end",
      "2026-07-24T11:00:00+08:00",
      "--description",
      "讨论下季度计划",
      "--attendee-ids",
      "ou_attendee",
    ]);
    expect(
      createMvpLarkCliRouteRegistry().lookup("bot", "calendar.create"),
    ).toBeUndefined();
  });

  it.each([
    [
      "identity",
      "user",
      "minutes.search",
      {
        start: "2026-07-01T00:00:00+08:00",
        end: "2026-07-02T00:00:00+08:00",
        identity: "bot",
      },
    ],
    [
      "raw URL",
      "user",
      "contact.search",
      {
        query: "王伟",
        pageSize: 20,
        url: "https://open.feishu.cn/anything",
      },
    ],
    [
      "dry-run override",
      "user",
      "calendar.create",
      {
        calendar: "primary",
        title: "经营会",
        description: null,
        start: "2026-07-24T10:00:00+08:00",
        end: "2026-07-24T11:00:00+08:00",
        zone: "Asia/Shanghai",
        attendeeOpenIds: [],
        recurrence: "none",
        dryRun: false,
      },
    ],
    [
      "recipient batch",
      "bot",
      "message.send",
      {
        receiveIdType: "open_id",
        recipientOpenId: "ou_recipient",
        recipients: ["ou_a", "ou_b"],
        text: "开会",
        idempotencyKey: "018f7d72-7a2b-7f45-8a12-8e20b8426a22",
      },
    ],
    [
      "transcript file export",
      "user",
      "minutes.detail",
      {
        minuteToken: "minute_A-1",
        artifacts: ["transcript"],
      },
    ],
    [
      "transcript overwrite",
      "user",
      "minutes.detail",
      {
        minuteToken: "minute_A-1",
        artifacts: ["transcript"],
        overwrite: true,
      },
    ],
    [
      "overlong idempotency key",
      "bot",
      "message.send",
      {
        receiveIdType: "open_id",
        recipientOpenId: "ou_recipient",
        text: "开会",
        idempotencyKey: `sha256:${"a".repeat(64)}`,
      },
    ],
  ] as const)(
    "rejects caller supplied %s",
    (_name, identity, operation, payload) => {
      expect(() =>
        route(identity, operation).parsePayload(payload),
      ).toThrowError("invalid mvp lark-cli payload");
    },
  );

  it("never builds raw API, URL, identity, profile, format, or dry-run argv", () => {
    const plans = [
      invocation("user", "minutes.search", {
        start: "2026-07-01T00:00:00+08:00",
        end: "2026-07-02T00:00:00+08:00",
      }).plan,
      invocation("user", "minutes.detail", {
        minuteToken: "minute_A-1",
        artifacts: ["summary", "todos"],
      }).plan,
      invocation("user", "contact.search", {
        query: "王伟",
        pageSize: 20,
      }).plan,
      invocation("bot", "message.send", {
        receiveIdType: "open_id",
        recipientOpenId: "ou_recipient",
        text: "开会",
        idempotencyKey: "018f7d72-7a2b-7f45-8a12-8e20b8426a22",
      }).plan,
      invocation("user", "calendar.create", {
        calendar: "primary",
        title: "经营会",
        description: null,
        start: "2026-07-24T10:00:00+08:00",
        end: "2026-07-24T11:00:00+08:00",
        zone: "Asia/Shanghai",
        attendeeOpenIds: [],
        recurrence: "none",
      }).plan,
    ];

    for (const { operationArgs } of plans) {
      const serialized = operationArgs.join(" ");
      expect(operationArgs).not.toContain("api");
      expect(operationArgs).not.toContain("--as");
      expect(operationArgs).not.toContain("--profile");
      expect(operationArgs).not.toContain("--format");
      expect(operationArgs).not.toContain("--dry-run");
      expect(serialized).not.toContain("http://");
      expect(serialized).not.toContain("https://");
    }
  });

  it("rejects calendar dates that JavaScript would otherwise normalize", () => {
    expect(() =>
      route("user", "calendar.create").parsePayload({
        calendar: "primary",
        title: "不存在的日期",
        description: null,
        start: "2026-02-31T10:00:00+08:00",
        end: "2026-02-31T11:00:00+08:00",
        zone: "Asia/Shanghai",
        attendeeOpenIds: [],
        recurrence: "none",
      }),
    ).toThrowError("invalid mvp lark-cli payload");
  });
});
