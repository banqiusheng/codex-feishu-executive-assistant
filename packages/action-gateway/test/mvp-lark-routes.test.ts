import { describe, expect, it } from "vitest";

import { planDirectCalendarInstruction } from "../src/mvp/direct-calendar.js";
import { createMvpLarkCliRouteRegistry } from "../src/mvp/lark-routes.js";
import type { MvpCapability } from "../src/mvp/registry.js";

type ExpectedPublicBaseCapability =
  | "base.resolve"
  | "base.schema.read"
  | "base.records.read"
  | "base.data.query";

const PUBLIC_BASE_CAPABILITIES_ARE_OPAQUE_ONLY: Exclude<
  Extract<MvpCapability, `base.${string}`>,
  ExpectedPublicBaseCapability
> extends never
  ? Exclude<
      ExpectedPublicBaseCapability,
      Extract<MvpCapability, `base.${string}`>
    > extends never
    ? true
    : never
  : never = true;

const REPORT_TITLE = "经营驾驶舱分析报告｜2026-07-31";
const REPORT_XML =
  '<?xml version="1.0" encoding="UTF-8"?><doc>' +
  `<title>${REPORT_TITLE}</title>` +
  "<section><heading>核心结论</heading><list><item>收入保持增长</item></list></section>" +
  "<section><heading>关键数据</heading><metrics><metric><label>收入</label><value>1.2 亿元</value></metric></metrics></section>" +
  "<section><heading>异常与风险</heading><list><item>华南低于预算</item></list></section>" +
  "<section><heading>建议动作</heading><list><item>复核重点项目</item></list></section>" +
  "<section><heading>数据来源与口径</heading><source><paragraph>Base：经营驾驶舱</paragraph></source></section>" +
  "</doc>";

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
      textInputs: [],
      fileInputs: [],
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
      textInputs: [],
      fileInputs: [],
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

    const self = invocation("user", "contact.self", {});
    expect(self.plan.operationArgs).toEqual([
      "contact",
      "+search-user",
      "--user-ids",
      "me",
      "--page-size",
      "20",
      "--exclude-external-users",
    ]);
  });

  it("maps Base resolve and schema reads to exact fixed User argv", () => {
    const url = invocation("user", "base.url.resolve", {
      url: "https://example.feishu.cn/base/bascnTrusted?table=tblTrusted",
    });
    const title = invocation("user", "base.title.resolve", {
      title: "经营日报",
    });
    const base = invocation("user", "base.app.get", {
      baseToken: "bascnTrusted",
    });
    const tables = invocation("user", "base.table.list", {
      baseToken: "bascnTrusted",
      offset: 0,
      limit: 100,
    });
    const fields = invocation("user", "base.field.list", {
      baseToken: "bascnTrusted",
      tableId: "tblTrusted",
      offset: 0,
      limit: 200,
    });
    const views = invocation("user", "base.view.list", {
      baseToken: "bascnTrusted",
      tableId: "tblTrusted",
      offset: 200,
      limit: 200,
    });

    expect(url.route).toMatchObject({
      identity: "user",
      operation: "base.url.resolve",
      effect: "read",
    });
    expect(url.plan.operationArgs).toEqual([
      "base",
      "+url-resolve",
      "--url",
      "https://example.feishu.cn/base/bascnTrusted?table=tblTrusted",
    ]);
    expect(title.plan.operationArgs).toEqual([
      "base",
      "+title-resolve",
      "--title",
      "经营日报",
    ]);
    expect(base.plan.operationArgs).toEqual([
      "base",
      "+base-get",
      "--base-token",
      "bascnTrusted",
    ]);
    expect(tables.plan.operationArgs).toEqual([
      "base",
      "+table-list",
      "--base-token",
      "bascnTrusted",
      "--offset",
      "0",
      "--limit",
      "100",
    ]);
    expect(fields.plan.operationArgs).toEqual([
      "base",
      "+field-list",
      "--base-token",
      "bascnTrusted",
      "--table-id",
      "tblTrusted",
      "--offset",
      "0",
      "--limit",
      "200",
    ]);
    expect(views.plan.operationArgs).toEqual([
      "base",
      "+view-list",
      "--base-token",
      "bascnTrusted",
      "--table-id",
      "tblTrusted",
      "--offset",
      "200",
      "--limit",
      "200",
    ]);
    for (const operation of [
      "base.url.resolve",
      "base.title.resolve",
      "base.app.get",
      "base.table.list",
      "base.field.list",
      "base.view.list",
    ]) {
      expect(
        createMvpLarkCliRouteRegistry().lookup("bot", operation),
      ).toBeUndefined();
    }
  });

  it("maps Base record pages to the locked comma-slice alias without caller-controlled runner flags", () => {
    const result = invocation("user", "base.record.list", {
      baseToken: "bascnTrusted",
      tableId: "tblTrusted",
      viewId: "vewTrusted",
      fieldIds: ["fldName", "fldRevenue"],
      filterJson: null,
      sortJson: null,
      offset: 400,
      limit: 200,
    });

    expect(result.route).toMatchObject({
      identity: "user",
      operation: "base.record.list",
      effect: "read",
    });
    expect(result.plan.operationArgs).toEqual([
      "base",
      "+record-list",
      "--base-token",
      "bascnTrusted",
      "--table-id",
      "tblTrusted",
      "--view-id",
      "vewTrusted",
      "--field-names",
      "fldName,fldRevenue",
      "--offset",
      "400",
      "--limit",
      "200",
    ]);
    expect(result.plan.operationArgs).not.toContain("--format");
    expect(result.plan.operationArgs).not.toContain("--as");
    expect(result.plan.operationArgs).not.toContain("--profile");
    expect(result.plan.operationArgs).not.toContain("--dry-run");
  });

  it("keeps a 200-field Base projection below the runner 256-argument ceiling", () => {
    const fieldIds = Array.from(
      { length: 200 },
      (_, index) => `fldTrusted_${index}`,
    );
    const result = invocation("user", "base.record.list", {
      baseToken: "bascnTrusted",
      tableId: "tblTrusted",
      viewId: null,
      fieldIds,
      filterJson: null,
      sortJson: null,
      offset: 0,
      limit: 200,
    });

    expect(result.plan.operationArgs.length).toBeLessThanOrEqual(256);
    expect(
      result.plan.operationArgs.filter(
        (argument) => argument === "--field-names",
      ),
    ).toEqual(["--field-names"]);
    expect(result.plan.operationArgs).not.toContain("--field-id");
    expect(result.plan.operationArgs).toContain(fieldIds.join(","));
  });

  it("maps one canonical Base LiteQuery DSL to the fixed User data-query argv", () => {
    const dsl = {
      datasource: {
        type: "table",
        table: { tableId: "tblTrusted" },
      },
      dimensions: [{ field_name: "地区", alias: "dimension_0" }],
      measures: [
        {
          field_name: "金额",
          aggregation: "sum",
          alias: "measure_0",
        },
      ],
      filters: {
        type: 1,
        conjunction: "and",
        conditions: [
          { field_name: "金额", operator: "isGreaterEqual", value: ["100"] },
        ],
      },
      sort: [{ field_name: "measure_0", order: "desc" }],
      pagination: { limit: 10 },
      shaper: { format: "flat" },
    };

    const result = invocation("user", "base.data.query", {
      dsl,
      baseToken: "bascnTrusted",
    });

    expect(result.route).toMatchObject({
      identity: "user",
      operation: "base.data.query",
      effect: "read",
    });
    expect(result.plan).toEqual({
      operationArgs: [
        "base",
        "+data-query",
        "--base-token",
        "bascnTrusted",
        "--dsl",
        JSON.stringify(dsl),
      ],
      jsonInputs: [],
      textInputs: [],
      fileInputs: [],
    });
    expect(result.plan.operationArgs).not.toContain("--as");
    expect(result.plan.operationArgs).not.toContain("--profile");
    expect(result.plan.operationArgs).not.toContain("--format");
    expect(result.plan.operationArgs).not.toContain("--dry-run");
    expect(
      createMvpLarkCliRouteRegistry().lookup("bot", "base.data.query"),
    ).toBeUndefined();
  });

  it("omits the optional official filters key instead of sending an undocumented null", () => {
    const dsl = {
      datasource: {
        type: "table",
        table: { tableId: "tblTrusted" },
      },
      dimensions: [{ field_name: "地区", alias: "dimension_0" }],
      measures: [],
      sort: [],
      pagination: { limit: 100 },
      shaper: { format: "flat" },
    };

    const result = invocation("user", "base.data.query", {
      baseToken: "bascnTrusted",
      dsl,
    });

    expect(result.plan.operationArgs.at(-1)).toBe(JSON.stringify(dsl));
    expect(() =>
      route("user", "base.data.query").parsePayload({
        baseToken: "bascnTrusted",
        dsl: { ...dsl, filters: null },
      }),
    ).toThrowError("invalid mvp lark-cli payload");
  });

  it.each([
    [
      "raw DSL string",
      {
        baseToken: "bascnTrusted",
        dsl: '{"datasource":{"type":"table"}}',
      },
    ],
    [
      "raw table name",
      {
        baseToken: "bascnTrusted",
        dsl: {
          datasource: {
            type: "table",
            table: { tableName: "经营数据" },
          },
          dimensions: [{ field_name: "地区", alias: "dimension_0" }],
          measures: [],
          sort: [],
          pagination: { limit: 10 },
          shaper: { format: "flat" },
        },
      },
    ],
    [
      "arbitrary operator",
      {
        baseToken: "bascnTrusted",
        dsl: {
          datasource: {
            type: "table",
            table: { tableId: "tblTrusted" },
          },
          dimensions: [{ field_name: "地区", alias: "dimension_0" }],
          measures: [],
          filters: {
            type: 1,
            conjunction: "and",
            conditions: [
              {
                field_name: "地区",
                operator: "matches",
                value: ["华"],
              },
            ],
          },
          sort: [],
          pagination: { limit: 10 },
          shaper: { format: "flat" },
        },
      },
    ],
    [
      "over-limit query",
      {
        baseToken: "bascnTrusted",
        dsl: {
          datasource: {
            type: "table",
            table: { tableId: "tblTrusted" },
          },
          dimensions: [{ field_name: "地区", alias: "dimension_0" }],
          measures: [],
          sort: [],
          pagination: { limit: 5_001 },
          shaper: { format: "flat" },
        },
      },
    ],
    [
      "empty projection",
      {
        baseToken: "bascnTrusted",
        dsl: {
          datasource: {
            type: "table",
            table: { tableId: "tblTrusted" },
          },
          dimensions: [],
          measures: [],
          sort: [],
          pagination: { limit: 10 },
          shaper: { format: "flat" },
        },
      },
    ],
    [
      "caller authority flag",
      {
        baseToken: "bascnTrusted",
        dsl: {
          datasource: {
            type: "table",
            table: { tableId: "tblTrusted" },
          },
          dimensions: [{ field_name: "地区", alias: "dimension_0" }],
          measures: [],
          sort: [],
          pagination: { limit: 10 },
          shaper: { format: "flat" },
        },
        as: "bot",
      },
    ],
  ] as const)("rejects Base data-query %s", (_name, payload) => {
    expect(() =>
      route("user", "base.data.query").parsePayload(payload),
    ).toThrowError("invalid mvp lark-cli payload");
  });

  it("accepts official Lark Office tenant hosts but rejects lookalike suffixes", () => {
    const result = invocation("user", "base.url.resolve", {
      url: "https://tenant.larkoffice.com/base/bascnTrusted",
    });

    expect(result.plan.operationArgs).toEqual([
      "base",
      "+url-resolve",
      "--url",
      "https://tenant.larkoffice.com/base/bascnTrusted",
    ]);
    for (const url of [
      "https://tenant.larkoffice.com.evil.example/base/bascnInjected",
      "https://evil-larkoffice.com/base/bascnInjected",
    ]) {
      expect(() =>
        route("user", "base.url.resolve").parsePayload({ url }),
      ).toThrowError("invalid mvp lark-cli payload");
    }
  });

  it("keeps raw Base token routes internal and absent from public MVP capabilities", () => {
    expect(PUBLIC_BASE_CAPABILITIES_ARE_OPAQUE_ONLY).toBe(true);
    expect(route("user", "base.table.list")).toMatchObject({
      identity: "user",
      effect: "read",
    });
    expect(route("user", "base.app.get")).toMatchObject({
      identity: "user",
      effect: "read",
    });
  });

  it.each([
    [
      "raw non-Base URL",
      "base.url.resolve",
      { url: "https://example.feishu.cn/wiki/wikcnOutOfScope" },
    ],
    ["overlong title", "base.title.resolve", { title: "经".repeat(31) }],
    [
      "base-get caller authority",
      "base.app.get",
      { baseToken: "bascnTrusted", as: "bot" },
    ],
    [
      "table page-size override",
      "base.table.list",
      { baseToken: "bascnTrusted", offset: 0, limit: 99 },
    ],
    [
      "field page-size override",
      "base.field.list",
      {
        baseToken: "bascnTrusted",
        tableId: "tblTrusted",
        offset: 0,
        limit: 199,
      },
    ],
    [
      "record filter injection",
      "base.record.list",
      {
        baseToken: "bascnTrusted",
        tableId: "tblTrusted",
        viewId: null,
        fieldIds: ["fldName"],
        filterJson: '{"conjunction":"and"}',
        sortJson: null,
        offset: 0,
        limit: 200,
      },
    ],
    [
      "record format override",
      "base.record.list",
      {
        baseToken: "bascnTrusted",
        tableId: "tblTrusted",
        viewId: null,
        fieldIds: ["fldName"],
        filterJson: null,
        sortJson: null,
        offset: 0,
        limit: 200,
        format: "markdown",
      },
    ],
  ] as const)("rejects Base %s", (_name, operation, payload) => {
    expect(() => route("user", operation).parsePayload(payload)).toThrowError(
      "invalid mvp lark-cli payload",
    );
  });

  it.each([
    ["page-size override", { query: "王伟", pageSize: 21 }],
    ["open id", { query: "王伟", pageSize: 20, openId: "ou_bad" }],
    ["user ids", { query: "王伟", pageSize: 20, userIds: "me" }],
    ["chat id", { query: "王伟", pageSize: 20, chatId: "oc_bad" }],
    ["free flag", { query: "王伟", pageSize: 20, hasChatted: true }],
  ])("rejects contact search %s", (_name, payload) => {
    expect(() =>
      route("user", "contact.search").parsePayload(payload),
    ).toThrowError("invalid mvp lark-cli payload");
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

  it("maps direct notification text to exact fixed Bot argv", () => {
    const result = invocation("bot", "notification.send.text", {
      recipientOpenId: "ou_resolved_inside_gateway",
      text: "请于今天下班前反馈经营数据。",
      idempotencyKey: "018f7d72-7a2b-7f45-8a12-8e20b8426a22",
    });

    expect(result.route).toMatchObject({
      identity: "bot",
      operation: "notification.send.text",
      effect: "write",
    });
    expect(result.plan).toEqual({
      operationArgs: [
        "im",
        "+messages-send",
        "--user-id",
        "ou_resolved_inside_gateway",
        "--text",
        "请于今天下班前反馈经营数据。",
        "--idempotency-key",
        "018f7d72-7a2b-7f45-8a12-8e20b8426a22",
      ],
      jsonInputs: [],
      textInputs: [],
      fileInputs: [],
    });
    expect(
      createMvpLarkCliRouteRegistry().lookup("user", "notification.send.text"),
    ).toBeUndefined();
  });

  it("maps a fixed passive Schema 2.0 card through one private content input", () => {
    const card = {
      schema: "2.0",
      header: {
        template: "blue",
        title: { tag: "plain_text", content: "经营提醒" },
      },
      body: {
        direction: "vertical",
        padding: "12px 12px 16px 12px",
        elements: [
          {
            tag: "div",
            text: { tag: "plain_text", content: "来源：总裁办公室" },
          },
          {
            tag: "div",
            text: { tag: "plain_text", content: "请反馈。" },
          },
        ],
      },
    };
    const result = invocation("bot", "notification.send.card", {
      recipientOpenId: "ou_resolved_inside_gateway",
      card,
      idempotencyKey: "018f7d72-7a2b-7f45-8a12-8e20b8426a22",
    });

    expect(result.route).toMatchObject({
      identity: "bot",
      operation: "notification.send.card",
      effect: "write",
    });
    expect(result.plan.operationArgs).toEqual([
      "im",
      "+messages-send",
      "--user-id",
      "ou_resolved_inside_gateway",
      "--msg-type",
      "interactive",
      "--idempotency-key",
      "018f7d72-7a2b-7f45-8a12-8e20b8426a22",
    ]);
    expect(result.plan.textInputs).toEqual([
      {
        flag: "--content",
        fileName: "content.xml",
        value: JSON.stringify(card),
      },
    ]);
    expect(result.plan.jsonInputs).toEqual([]);
    expect(result.plan.fileInputs).toEqual([]);
    expect(result.plan.operationArgs).not.toContain(JSON.stringify(card));
  });

  it.each([
    ["image", "notification.send.image", "--image"],
    ["file", "notification.send.file", "--file"],
  ] as const)(
    "maps a trusted %s attachment to one fixed private file input",
    (_label, operation, flag) => {
      const result = invocation("bot", operation, {
        recipientOpenId: "ou_resolved_inside_gateway",
        sourceRelativePath:
          "resources/01-018f7d72-7a2b-7f45-8a12-8e20b8426a70.bin",
        outputFileName:
          flag === "--image" ? "attachment-02-image.bin" : "attachment-03.bin",
        sizeBytes: 17,
        sha256: `sha256:${"a".repeat(64)}`,
        idempotencyKey: "018f7d72-7a2b-7f45-8a12-8e20b8426a22",
      });

      expect(result.route).toMatchObject({
        identity: "bot",
        operation,
        effect: "write",
      });
      expect(result.plan).toEqual({
        operationArgs: [
          "im",
          "+messages-send",
          "--user-id",
          "ou_resolved_inside_gateway",
          "--idempotency-key",
          "018f7d72-7a2b-7f45-8a12-8e20b8426a22",
        ],
        jsonInputs: [],
        textInputs: [],
        fileInputs: [
          {
            flag,
            sourceRelativePath:
              "resources/01-018f7d72-7a2b-7f45-8a12-8e20b8426a70.bin",
            outputFileName:
              flag === "--image"
                ? "attachment-02-image.bin"
                : "attachment-03.bin",
            sizeBytes: 17,
            sha256: `sha256:${"a".repeat(64)}`,
          },
        ],
      });
      expect(
        createMvpLarkCliRouteRegistry().lookup("user", operation),
      ).toBeUndefined();
    },
  );

  it.each([
    [
      "caller extra flag",
      {
        recipientOpenId: "ou_resolved_inside_gateway",
        text: "请反馈。",
        idempotencyKey: "018f7d72-7a2b-7f45-8a12-8e20b8426a22",
        as: "user",
      },
    ],
    [
      "interactive behavior",
      {
        recipientOpenId: "ou_resolved_inside_gateway",
        card: {
          schema: "2.0",
          header: {
            template: "blue",
            title: { tag: "plain_text", content: "经营提醒" },
          },
          body: {
            direction: "vertical",
            padding: "12px 12px 16px 12px",
            elements: [
              {
                tag: "button",
                text: { tag: "plain_text", content: "打开" },
                behaviors: [{ type: "open_url", default_url: "https://x" }],
              },
            ],
          },
        },
        idempotencyKey: "018f7d72-7a2b-7f45-8a12-8e20b8426a22",
      },
    ],
  ])("rejects direct notification %s", (_name, payload) => {
    const operation = Object.hasOwn(payload, "card")
      ? "notification.send.card"
      : "notification.send.text";
    expect(() => route("bot", operation).parsePayload(payload)).toThrowError(
      "invalid mvp lark-cli payload",
    );
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

  it("maps the trusted direct calendar plan to the same fixed User primary-calendar route", () => {
    const direct = planDirectCalendarInstruction(
      "018f7d72-7a2b-7f45-8a12-8e20b8426a21",
      {
        title: "经营会",
        startLocal: "2026-07-31T10:00:00",
        attendeeRefs: ["018f7d72-7a2b-7f45-8a12-8e20b8426a41"],
      },
      new Date("2026-07-30T00:00:00.000Z"),
      () => "ou_resolved_inside_gateway",
    );
    const result = invocation("user", "calendar.create", direct?.payload);

    expect(result.route).toMatchObject({
      identity: "user",
      operation: "calendar.create",
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
      "2026-07-31T10:00:00+08:00",
      "--end",
      "2026-07-31T11:00:00+08:00",
      "--attendee-ids",
      "ou_resolved_inside_gateway",
    ]);
    expect(result.plan.operationArgs).not.toContain("--rrule");
    expect(result.plan.operationArgs).not.toContain("--as");
    expect(result.plan.operationArgs).not.toContain("--dry-run");
    expect(
      createMvpLarkCliRouteRegistry().lookup("bot", "calendar.create.direct"),
    ).toBeUndefined();
  });

  it("limits even trusted calendar route payloads to twenty resolved attendees", () => {
    expect(() =>
      route("user", "calendar.create").parsePayload({
        calendar: "primary",
        title: "经营会",
        description: null,
        start: "2026-07-31T10:00:00+08:00",
        end: "2026-07-31T11:00:00+08:00",
        zone: "Asia/Shanghai",
        attendeeOpenIds: Array.from(
          { length: 21 },
          (_, index) => `ou_attendee_${index}`,
        ),
        recurrence: "none",
      }),
    ).toThrowError("invalid mvp lark-cli payload");
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
      invocation("user", "base.table.list", {
        baseToken: "bascnTrusted",
        offset: 0,
        limit: 100,
      }).plan,
      invocation("user", "base.app.get", {
        baseToken: "bascnTrusted",
      }).plan,
      invocation("user", "base.record.list", {
        baseToken: "bascnTrusted",
        tableId: "tblTrusted",
        viewId: null,
        fieldIds: ["fldName"],
        filterJson: null,
        sortJson: null,
        offset: 0,
        limit: 200,
      }).plan,
    ];

    for (const plan of plans) {
      expect(Reflect.ownKeys(plan)).toEqual([
        "operationArgs",
        "jsonInputs",
        "textInputs",
        "fileInputs",
      ]);
      expect(plan.jsonInputs).toEqual([]);
      expect(plan.textInputs).toEqual([]);
      expect(plan.fileInputs).toEqual([]);
      const { operationArgs } = plan;
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

  it("maps one trusted report plan to fixed User docs argv with XML only in the private content input", () => {
    const result = invocation("user", "document.report.create", {
      docFormat: "xml",
      parentPosition: "my_library",
      title: REPORT_TITLE,
      content: REPORT_XML,
    });

    expect(result.route).toMatchObject({
      identity: "user",
      operation: "document.report.create",
      effect: "write",
    });
    expect(result.plan).toEqual({
      operationArgs: [
        "docs",
        "+create",
        "--doc-format",
        "xml",
        "--parent-position",
        "my_library",
      ],
      jsonInputs: [],
      textInputs: [
        {
          flag: "--content",
          fileName: "content.xml",
          value: REPORT_XML,
        },
      ],
      fileInputs: [],
    });
    expect(result.plan.operationArgs).not.toContain("--title");
    expect(result.plan.operationArgs).not.toContain(REPORT_TITLE);
    expect(result.plan.operationArgs.join(" ")).not.toContain("<doc>");
    expect(
      createMvpLarkCliRouteRegistry().lookup("bot", "document.report.create"),
    ).toBeUndefined();
  });

  it.each([
    [
      "caller-selected document format",
      {
        docFormat: "markdown",
        parentPosition: "my_library",
        title: REPORT_TITLE,
        content: REPORT_XML,
      },
    ],
    [
      "caller-selected parent",
      {
        docFormat: "xml",
        parentPosition: "fldcnCallerSelected",
        title: REPORT_TITLE,
        content: REPORT_XML,
      },
    ],
    [
      "extra parent token",
      {
        docFormat: "xml",
        parentPosition: "my_library",
        title: REPORT_TITLE,
        content: REPORT_XML,
        parentToken: "fldcnCallerSelected",
      },
    ],
    [
      "free XML",
      {
        docFormat: "xml",
        parentPosition: "my_library",
        title: REPORT_TITLE,
        content: "<doc><title>caller-controlled</title></doc>",
      },
    ],
    [
      "oversize XML",
      {
        docFormat: "xml",
        parentPosition: "my_library",
        title: REPORT_TITLE,
        content: `${REPORT_XML.slice(0, -6)}${"测".repeat(256 * 1024)}</doc>`,
      },
    ],
  ] as const)(
    "rejects report %s at the internal route seam",
    (_label, payload) => {
      expect(() =>
        route("user", "document.report.create").parsePayload(payload),
      ).toThrowError("invalid mvp lark-cli payload");
    },
  );
});
