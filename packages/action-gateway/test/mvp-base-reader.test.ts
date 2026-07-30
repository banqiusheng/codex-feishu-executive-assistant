import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createBaseReader,
  type BaseClarificationConsumer,
  type BaseClarificationWriter,
} from "../src/mvp/base-reader.js";
import { snapshotStrictJson } from "../src/ipc/framing.js";
import type { MvpLarkCliRunner } from "../src/mvp/registry.js";

const TASK_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a21";
const OTHER_TASK_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a29";
const NOW = new Date("2026-07-30T08:00:00.000Z");
const BASE_SELECTION_REF = "018f7d72-7a2b-7f45-8a12-8e20b8426a31";
const TABLE_SELECTION_REF = "018f7d72-7a2b-7f45-8a12-8e20b8426a32";
const DOCUMENTED_LARK_CLI_1_0_72_DATA_QUERY_FIXTURE =
  '{"ok":true,"identity":"user","data":{"main_data":[{"dimension_0":{"value":"华北"},"measure_0":{"value":1234.5}}]}}';

function succeeded(data: unknown) {
  return {
    state: "SUCCEEDED" as const,
    value: snapshotStrictJson({ ok: true, identity: "user", data }),
  };
}

function succeededEnvelope(value: string) {
  return {
    state: "SUCCEEDED" as const,
    value: snapshotStrictJson(JSON.parse(value)),
  };
}

function runner(
  results: readonly Awaited<ReturnType<MvpLarkCliRunner["runUser"]>>[],
) {
  const runUser = vi.fn<MvpLarkCliRunner["runUser"]>();
  for (const result of results) runUser.mockResolvedValueOnce(result);
  return {
    runUser,
    runBot: vi.fn<MvpLarkCliRunner["runBot"]>(),
  } satisfies MvpLarkCliRunner;
}

function baseUrlData(tableId?: string, viewId?: string) {
  return {
    input_type: "base_url",
    resource_type: "bitable",
    base_token: "bascnSecret",
    ...(tableId === undefined ? {} : { table_id: tableId }),
    ...(viewId === undefined ? {} : { view_id: viewId }),
    hint: { next_step: "official CLI hint is deliberately not exposed" },
  };
}

function baseAppData(name = "经营驾驶舱") {
  return {
    base: {
      base_token: "bascnSecret",
      name,
    },
  };
}

function tablePage(
  tables: readonly Readonly<Record<string, unknown>>[],
  total = tables.length,
) {
  return { tables, total };
}

function fieldPage(
  fields: readonly Readonly<Record<string, unknown>>[],
  total = fields.length,
) {
  return { fields, total };
}

function viewPage(
  views: readonly Readonly<Record<string, unknown>>[],
  total = views.length,
) {
  return { views, total };
}

function recordPage(input: {
  fields: readonly string[];
  fieldIds?: readonly string[];
  recordIds: readonly string[];
  rows: readonly (readonly unknown[])[];
  total?: number;
  hasMore?: boolean;
}) {
  return {
    fields: input.fields,
    ...(input.fieldIds === undefined ? {} : { field_id_list: input.fieldIds }),
    record_id_list: input.recordIds,
    data: input.rows,
    ...(input.total === undefined ? {} : { total: input.total }),
    ...(input.hasMore === undefined ? {} : { has_more: input.hasMore }),
  };
}

function writer() {
  const writeBaseClarification = vi.fn<
    BaseClarificationWriter["writeBaseClarification"]
  >((input) => ({
    groupId: randomUUID(),
    options: input.candidates.map((candidate, index) => ({
      ordinal: index + 1,
      optionRef:
        input.kind === "base"
          ? index === 0
            ? BASE_SELECTION_REF
            : TABLE_SELECTION_REF
          : index === 0
            ? TABLE_SELECTION_REF
            : BASE_SELECTION_REF,
      displayLabel: candidate.displayLabel,
    })),
  }));
  return { writeBaseClarification } satisfies BaseClarificationWriter;
}

async function resolvedTableReader(
  recordResults: readonly Awaited<ReturnType<MvpLarkCliRunner["runUser"]>>[],
) {
  const cli = runner([
    succeeded(baseUrlData("tblSecret")),
    succeeded(baseAppData()),
    succeeded(tablePage([{ id: "tblSecret", name: "经营数据" }])),
    succeeded(
      fieldPage([
        { id: "fldName", name: "客户", type: "text" },
        { id: "fldRevenue", name: "金额", type: "number" },
      ]),
    ),
    succeeded(viewPage([{ id: "vewMain", name: "主视图", type: "grid" }])),
    ...recordResults,
  ]);
  const reader = createBaseReader({ runner: cli });
  const resolved = await reader.resolve(
    TASK_ID,
    {
      source: "url",
      url: "https://example.feishu.cn/base/bascnSecret?table=tblSecret",
    },
    NOW,
  );
  if (
    resolved.status !== "RESOLVED" ||
    resolved.resource.tableRef === undefined
  ) {
    throw new Error("expected resolved Base table");
  }
  const schema = await reader.readSchema(
    TASK_ID,
    {
      baseRef: resolved.resource.baseRef,
      tableRef: resolved.resource.tableRef,
    },
    NOW,
  );
  if (schema.status !== "RESOLVED") {
    throw new Error("expected resolved Base schema");
  }
  return { cli, reader, resolved, schema };
}

async function resolvedQueryReader(
  queryResults: readonly Awaited<ReturnType<MvpLarkCliRunner["runUser"]>>[],
  options: Readonly<{ randomUuid?: () => string }> = {},
) {
  const cli = runner([
    succeeded(baseUrlData("tblSecret")),
    succeeded(baseAppData()),
    succeeded(tablePage([{ id: "tblSecret", name: "经营数据" }])),
    succeeded(
      fieldPage([
        { id: "fldCustomer", name: "客户", type: "text" },
        { id: "fldAmount", name: "金额", type: "number" },
        { id: "fldRegion", name: "地区", type: "select" },
      ]),
    ),
    succeeded(viewPage([{ id: "vewMain", name: "主视图", type: "grid" }])),
    ...queryResults,
  ]);
  const reader = createBaseReader({
    runner: cli,
    ...(options.randomUuid === undefined
      ? {}
      : { randomUuid: options.randomUuid }),
  });
  const resolved = await reader.resolve(
    TASK_ID,
    {
      source: "url",
      url: "https://example.feishu.cn/base/bascnSecret?table=tblSecret",
    },
    NOW,
  );
  if (
    resolved.status !== "RESOLVED" ||
    resolved.resource.tableRef === undefined
  ) {
    throw new Error("expected resolved Base table");
  }
  const schema = await reader.readSchema(
    TASK_ID,
    {
      baseRef: resolved.resource.baseRef,
      tableRef: resolved.resource.tableRef,
    },
    NOW,
  );
  if (schema.status !== "RESOLVED") {
    throw new Error("expected resolved Base schema");
  }
  return { cli, reader, resolved, schema };
}

describe("Base task-local reader", () => {
  it("resolves the official Base name for URL sources before issuing report evidence", async () => {
    const cli = runner([
      succeeded(baseUrlData("tblSecret")),
      succeeded(baseAppData()),
    ]);
    const reader = createBaseReader({ runner: cli });

    const result = await reader.resolve(
      TASK_ID,
      {
        source: "url",
        url: "https://example.feishu.cn/base/bascnSecret?table=tblSecret",
      },
      NOW,
    );

    expect(result).toMatchObject({
      status: "RESOLVED",
      resource: {
        title: "经营驾驶舱",
      },
      evidence: {
        scope: {
          baseTitle: "经营驾驶舱",
        },
      },
    });
    expect(cli.runUser.mock.calls.map(([request]) => request)).toEqual([
      {
        version: 1,
        operation: "base.url.resolve",
        payload: {
          url: "https://example.feishu.cn/base/bascnSecret?table=tblSecret",
        },
      },
      {
        version: 1,
        operation: "base.app.get",
        payload: {
          baseToken: "bascnSecret",
        },
      },
    ]);
  });

  it.each([
    [
      "mismatched token",
      succeeded({
        base: { base_token: "bascnOther", name: "经营驾驶舱" },
      }),
    ],
    [
      "both token aliases",
      succeeded({
        base: {
          base_token: "bascnSecret",
          app_token: "bascnSecret",
          name: "经营驾驶舱",
        },
      }),
    ],
    ["missing token", succeeded({ base: { name: "经营驾驶舱" } })],
    [
      "extra Base property",
      succeeded({
        base: {
          base_token: "bascnSecret",
          name: "经营驾驶舱",
          url: "https://example.feishu.cn/base/bascnSecret",
        },
      }),
    ],
  ])("fails closed on a %s from base-get", async (_label, appResult) => {
    const cli = runner([succeeded(baseUrlData("tblSecret")), appResult]);
    const reader = createBaseReader({ runner: cli });

    await expect(
      reader.resolve(
        TASK_ID,
        {
          source: "url",
          url: "https://example.feishu.cn/base/bascnSecret?table=tblSecret",
        },
        NOW,
      ),
    ).rejects.toThrowError("invalid Base CLI result");
  });

  it("resolves supported /base URLs through the fixed User route and blocks /wiki before the runner", async () => {
    const cli = runner([
      succeeded(baseUrlData("tblSecret")),
      succeeded(baseAppData()),
    ]);
    const reader = createBaseReader({ runner: cli });

    const result = await reader.resolve(
      TASK_ID,
      {
        source: "url",
        url: "https://example.feishu.cn/base/bascnSecret?table=tblSecret",
      },
      NOW,
    );
    const blocked = await reader.resolve(
      TASK_ID,
      {
        source: "url",
        url: "https://example.feishu.cn/wiki/wikcnNeedsExtraScope",
      },
      NOW,
    );

    expect(result).toMatchObject({
      status: "RESOLVED",
      resource: {
        baseRef: expect.any(String),
        tableRef: expect.any(String),
      },
      evidence: {
        evidenceRef: expect.any(String),
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        completeness: {
          complete: true,
          hasMore: false,
          truncatedBy: null,
          itemCount: 1,
        },
      },
    });
    expect(blocked).toEqual({
      status: "BLOCKED_SCOPE",
      scope: "wiki:node:retrieve",
    });
    expect(cli.runUser).toHaveBeenCalledTimes(2);
    expect(cli.runUser).toHaveBeenCalledWith({
      version: 1,
      operation: "base.url.resolve",
      payload: {
        url: "https://example.feishu.cn/base/bascnSecret?table=tblSecret",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /bascnSecret|tblSecret|base_token|table_id/,
    );
  });

  it("resolves /record share URLs without exposing the share, Base, table, or record identifiers", async () => {
    const cli = runner([
      succeeded({
        input_type: "record_share_url",
        resource_type: "bitable",
        record_share_token: "recshareSecret",
        base_token: "bascnSecret",
        table_id: "tblSecret",
        record_id: "recSecret",
        hint: { next_step: "official CLI hint is deliberately not exposed" },
      }),
      succeeded(baseAppData()),
    ]);
    const reader = createBaseReader({ runner: cli });

    const result = await reader.resolve(
      TASK_ID,
      {
        source: "url",
        url: "https://example.feishu.cn/record/recshareSecret",
      },
      NOW,
    );

    expect(result).toMatchObject({
      status: "RESOLVED",
      resource: {
        baseRef: expect.any(String),
        tableRef: expect.any(String),
        recordRef: expect.any(String),
      },
    });
    expect(cli.runUser).toHaveBeenCalledWith({
      version: 1,
      operation: "base.url.resolve",
      payload: {
        url: "https://example.feishu.cn/record/recshareSecret",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /recshareSecret|bascnSecret|tblSecret|recSecret/,
    );
  });

  it("accepts an official Lark Office tenant URL without weakening the host suffix boundary", async () => {
    const cli = runner([succeeded(baseUrlData()), succeeded(baseAppData())]);
    const reader = createBaseReader({ runner: cli });

    const result = await reader.resolve(
      TASK_ID,
      {
        source: "url",
        url: "https://tenant.larkoffice.com/base/bascnSecret",
      },
      NOW,
    );

    expect(result.status).toBe("RESOLVED");
    expect(cli.runUser).toHaveBeenCalledWith({
      version: 1,
      operation: "base.url.resolve",
      payload: {
        url: "https://tenant.larkoffice.com/base/bascnSecret",
      },
    });
    await expect(
      reader.resolve(
        TASK_ID,
        {
          source: "url",
          url: "https://tenant.larkoffice.com.evil.example/base/bascnSecret",
        },
        NOW,
      ),
    ).rejects.toThrowError("invalid Base resolve payload");
  });

  it("verifies table and view IDs from a URL and replaces them with official display metadata before schema use", async () => {
    const cli = runner([
      succeeded(baseUrlData("tblSecret", "vewSecret")),
      succeeded(baseAppData()),
      succeeded(tablePage([{ id: "tblSecret", name: "经营数据" }])),
      succeeded(
        fieldPage([{ id: "fldRevenue", name: "金额", type: "number" }]),
      ),
      succeeded(
        viewPage([{ id: "vewSecret", name: "董事会视图", type: "grid" }]),
      ),
    ]);
    const reader = createBaseReader({ runner: cli });
    const resolved = await reader.resolve(
      TASK_ID,
      {
        source: "url",
        url: "https://example.feishu.cn/base/bascnSecret?table=tblSecret&view=vewSecret",
      },
      NOW,
    );
    if (
      resolved.status !== "RESOLVED" ||
      resolved.resource.tableRef === undefined ||
      resolved.resource.viewRef === undefined
    ) {
      throw new Error("expected URL table and view refs");
    }

    const schema = await reader.readSchema(
      TASK_ID,
      {
        baseRef: resolved.resource.baseRef,
        tableRef: resolved.resource.tableRef,
      },
      NOW,
    );

    expect(schema).toMatchObject({
      status: "RESOLVED",
      table: {
        tableRef: resolved.resource.tableRef,
        name: "经营数据",
      },
      views: [
        {
          viewRef: resolved.resource.viewRef,
          name: "董事会视图",
          type: "grid",
        },
      ],
      evidence: {
        scope: {
          tableName: "经营数据",
          fieldNames: ["金额"],
        },
      },
    });
    expect(
      cli.runUser.mock.calls.map(([request]) => request.operation),
    ).toEqual([
      "base.url.resolve",
      "base.app.get",
      "base.table.list",
      "base.field.list",
      "base.view.list",
    ]);
    expect(JSON.stringify(schema)).not.toMatch(
      /bascnSecret|tblSecret|vewSecret/,
    );
  });

  it("fails closed when a table or view identifier from a URL is not present in the verified schema", async () => {
    const missingTableCli = runner([
      succeeded(baseUrlData("tblMissing")),
      succeeded(baseAppData()),
      succeeded(tablePage([{ id: "tblOther", name: "其他数据" }])),
    ]);
    const missingTableReader = createBaseReader({
      runner: missingTableCli,
    });
    const missingTableResolved = await missingTableReader.resolve(
      TASK_ID,
      {
        source: "url",
        url: "https://example.feishu.cn/base/bascnSecret?table=tblMissing",
      },
      NOW,
    );
    if (
      missingTableResolved.status !== "RESOLVED" ||
      missingTableResolved.resource.tableRef === undefined
    ) {
      throw new Error("expected unresolved URL table ref");
    }
    await expect(
      missingTableReader.readSchema(
        TASK_ID,
        {
          baseRef: missingTableResolved.resource.baseRef,
          tableRef: missingTableResolved.resource.tableRef,
        },
        NOW,
      ),
    ).rejects.toThrowError("invalid Base CLI result");
    expect(missingTableCli.runUser).toHaveBeenCalledTimes(3);

    const missingViewCli = runner([
      succeeded(baseUrlData("tblSecret", "vewMissing")),
      succeeded(baseAppData()),
      succeeded(tablePage([{ id: "tblSecret", name: "经营数据" }])),
      succeeded(
        fieldPage([{ id: "fldRevenue", name: "金额", type: "number" }]),
      ),
      succeeded(viewPage([{ id: "vewOther", name: "其他视图", type: "grid" }])),
    ]);
    const missingViewReader = createBaseReader({ runner: missingViewCli });
    const missingViewResolved = await missingViewReader.resolve(
      OTHER_TASK_ID,
      {
        source: "url",
        url: "https://example.feishu.cn/base/bascnSecret?table=tblSecret&view=vewMissing",
      },
      NOW,
    );
    if (
      missingViewResolved.status !== "RESOLVED" ||
      missingViewResolved.resource.tableRef === undefined
    ) {
      throw new Error("expected unresolved URL view ref");
    }
    await expect(
      missingViewReader.readSchema(
        OTHER_TASK_ID,
        {
          baseRef: missingViewResolved.resource.baseRef,
          tableRef: missingViewResolved.resource.tableRef,
        },
        NOW,
      ),
    ).rejects.toThrowError("invalid Base CLI result");
    expect(missingViewCli.runUser).toHaveBeenCalledTimes(5);
  });

  it("persists multiple title candidates behind task-bound opaque selections and validates the chosen value", async () => {
    const cli = runner([
      succeeded({
        input_type: "title_query",
        resource_type: "bitable",
        candidates: [
          {
            title: "经营日报（华北）",
            base_token: "bascnNorth",
            url: "https://example.feishu.cn/base/bascnNorth",
            owner_name: "王总",
            update_time: "2026-07-29T08:00:00Z",
          },
          {
            title: "经营日报（华东）",
            base_token: "bascnEast",
            url: "https://example.feishu.cn/base/bascnEast",
            owner_name: "李总",
            update_time: "2026-07-30T08:00:00Z",
          },
        ],
        hint: { next_step: "choose one" },
      }),
    ]);
    const clarificationWriter = writer();
    const selectedValue = {
      version: 1,
      kind: "base",
      baseToken: "bascnNorth",
      title: "经营日报（华北）",
    } as const;
    const consumeClarificationsForTaskValidated = vi.fn<
      BaseClarificationConsumer["consumeClarificationsForTaskValidated"]
    >((taskId, optionRefs, expectedKind, now, assertValue) => {
      expect(taskId).toBe(TASK_ID);
      expect(optionRefs).toEqual([BASE_SELECTION_REF]);
      expect(expectedKind).toBe("base");
      expect(now).toEqual(NOW);
      expect(assertValue(selectedValue, 0)).toBeUndefined();
      return [
        {
          selectionId: randomUUID(),
          groupId: randomUUID(),
          optionOrdinal: 1,
          optionRef: BASE_SELECTION_REF,
          kind: "base",
          value: selectedValue,
          selectedAt: NOW.toISOString(),
        },
      ];
    });
    const reader = createBaseReader({
      runner: cli,
      clarificationWriter,
      clarificationConsumer: {
        consumeClarificationsForTaskValidated,
      },
    });

    const choices = await reader.resolve(
      TASK_ID,
      { source: "title", title: "经营日报" },
      NOW,
    );
    const resolved = await reader.resolve(
      TASK_ID,
      { source: "selection", selectionRef: BASE_SELECTION_REF },
      NOW,
    );

    expect(choices).toMatchObject({
      status: "NEEDS_CLARIFICATION",
      groupRef: expect.any(String),
      label: "多维表格：经营日报",
      candidates: [
        {
          selectionRef: BASE_SELECTION_REF,
          title: "经营日报（华北）",
          ownerName: "王总",
          updateTime: "2026-07-29T08:00:00Z",
        },
        {
          selectionRef: TABLE_SELECTION_REF,
          title: "经营日报（华东）",
          ownerName: "李总",
          updateTime: "2026-07-30T08:00:00Z",
        },
      ],
    });
    expect(resolved).toMatchObject({
      status: "RESOLVED",
      resource: {
        title: "经营日报（华北）",
        baseRef: expect.any(String),
      },
    });
    expect(cli.runUser).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(choices)).not.toMatch(/bascnNorth|bascnEast/);
    expect(
      clarificationWriter.writeBaseClarification.mock.calls[0]![0],
    ).toMatchObject({
      taskId: TASK_ID,
      kind: "base",
      groupLabel: "多维表格：经营日报",
      now: NOW,
      candidates: [
        { value: { version: 1, kind: "base", baseToken: "bascnNorth" } },
        { value: { version: 1, kind: "base", baseToken: "bascnEast" } },
      ],
    });
  });

  it("auto-selects one table, paginates fields and views, and exposes only opaque schema refs", async () => {
    const fields = Array.from({ length: 201 }, (_, index) => ({
      id: `fld_${index}`,
      name: `字段${index}`,
      type: index % 2 === 0 ? "text" : "number",
      property: { internal: "must not escape" },
    }));
    const views = Array.from({ length: 201 }, (_, index) => ({
      id: `vew_${index}`,
      name: `视图${index}`,
      type: "grid",
    }));
    const cli = runner([
      succeeded(baseUrlData()),
      succeeded(baseAppData()),
      succeeded(tablePage([{ id: "tblOnly", name: "经营数据" }])),
      succeeded(fieldPage(fields.slice(0, 200), 201)),
      succeeded(fieldPage(fields.slice(200), 201)),
      succeeded(viewPage(views.slice(0, 200), 201)),
      succeeded(viewPage(views.slice(200), 201)),
    ]);
    const reader = createBaseReader({ runner: cli });
    const resolved = await reader.resolve(
      TASK_ID,
      {
        source: "url",
        url: "https://example.feishu.cn/base/bascnSecret",
      },
      NOW,
    );
    if (resolved.status !== "RESOLVED") {
      throw new Error("expected resolved Base");
    }

    const schema = await reader.readSchema(
      TASK_ID,
      { baseRef: resolved.resource.baseRef },
      NOW,
    );

    expect(schema).toMatchObject({
      status: "RESOLVED",
      table: { tableRef: expect.any(String), name: "经营数据" },
      fields: expect.arrayContaining([
        {
          fieldRef: expect.any(String),
          name: "字段0",
          type: "text",
        },
        {
          fieldRef: expect.any(String),
          name: "字段200",
          type: "text",
        },
      ]),
      views: expect.arrayContaining([
        {
          viewRef: expect.any(String),
          name: "视图200",
          type: "grid",
        },
      ]),
      evidence: {
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        completeness: {
          complete: true,
          hasMore: false,
          truncatedBy: null,
          itemCount: 403,
        },
      },
    });
    if (schema.status !== "RESOLVED") {
      throw new Error("expected resolved schema");
    }
    expect(schema.fields).toHaveLength(201);
    expect(schema.views).toHaveLength(201);
    expect(cli.runUser.mock.calls.map(([request]) => request)).toEqual([
      {
        version: 1,
        operation: "base.url.resolve",
        payload: { url: "https://example.feishu.cn/base/bascnSecret" },
      },
      {
        version: 1,
        operation: "base.app.get",
        payload: { baseToken: "bascnSecret" },
      },
      {
        version: 1,
        operation: "base.table.list",
        payload: { baseToken: "bascnSecret", offset: 0, limit: 100 },
      },
      {
        version: 1,
        operation: "base.field.list",
        payload: {
          baseToken: "bascnSecret",
          tableId: "tblOnly",
          offset: 0,
          limit: 200,
        },
      },
      {
        version: 1,
        operation: "base.field.list",
        payload: {
          baseToken: "bascnSecret",
          tableId: "tblOnly",
          offset: 200,
          limit: 200,
        },
      },
      {
        version: 1,
        operation: "base.view.list",
        payload: {
          baseToken: "bascnSecret",
          tableId: "tblOnly",
          offset: 0,
          limit: 200,
        },
      },
      {
        version: 1,
        operation: "base.view.list",
        payload: {
          baseToken: "bascnSecret",
          tableId: "tblOnly",
          offset: 200,
          limit: 200,
        },
      },
    ]);
    expect(JSON.stringify(schema)).not.toMatch(
      /bascnSecret|tblOnly|fld_|vew_|property|internal/,
    );
  });

  it("requires a trusted table clarification and validates the selected table before schema reads", async () => {
    const cli = runner([
      succeeded(baseUrlData()),
      succeeded(baseAppData()),
      succeeded(
        tablePage([
          { id: "tblNorth", name: "华北经营数据" },
          { id: "tblEast", name: "华东经营数据" },
        ]),
      ),
      succeeded(
        fieldPage([{ id: "fldRevenue", name: "金额", type: "number" }]),
      ),
      succeeded(viewPage([{ id: "vewMain", name: "主视图", type: "grid" }])),
    ]);
    const clarificationWriter = writer();
    const selectedValue = {
      version: 1,
      kind: "table",
      baseToken: "bascnSecret",
      tableId: "tblNorth",
      name: "华北经营数据",
    } as const;
    const consumeClarificationsForTaskValidated = vi.fn<
      BaseClarificationConsumer["consumeClarificationsForTaskValidated"]
    >((_taskId, _optionRefs, _expectedKind, _now, assertValue) => {
      expect(assertValue(selectedValue, 0)).toBeUndefined();
      return [
        {
          selectionId: randomUUID(),
          groupId: randomUUID(),
          optionOrdinal: 1,
          optionRef: TABLE_SELECTION_REF,
          kind: "table",
          value: selectedValue,
          selectedAt: NOW.toISOString(),
        },
      ];
    });
    const reader = createBaseReader({
      runner: cli,
      clarificationWriter,
      clarificationConsumer: {
        consumeClarificationsForTaskValidated,
      },
    });
    const resolved = await reader.resolve(
      TASK_ID,
      {
        source: "url",
        url: "https://example.feishu.cn/base/bascnSecret",
      },
      NOW,
    );
    if (resolved.status !== "RESOLVED") {
      throw new Error("expected resolved Base");
    }

    const schema = await reader.readSchema(
      TASK_ID,
      { baseRef: resolved.resource.baseRef },
      NOW,
    );
    const selectedSchema = await reader.readSchema(
      TASK_ID,
      {
        baseRef: resolved.resource.baseRef,
        tableSelectionRef: TABLE_SELECTION_REF,
      },
      NOW,
    );

    expect(schema).toMatchObject({
      status: "NEEDS_CLARIFICATION",
      label: "请选择数据表",
      candidates: [
        {
          selectionRef: TABLE_SELECTION_REF,
          name: "华北经营数据",
        },
        {
          selectionRef: BASE_SELECTION_REF,
          name: "华东经营数据",
        },
      ],
    });
    expect(JSON.stringify(schema)).not.toMatch(/tblNorth|tblEast|bascnSecret/);
    expect(selectedSchema).toMatchObject({
      status: "RESOLVED",
      table: { tableRef: expect.any(String), name: "华北经营数据" },
      fields: [{ fieldRef: expect.any(String), name: "金额", type: "number" }],
      views: [{ viewRef: expect.any(String), name: "主视图", type: "grid" }],
    });
    expect(consumeClarificationsForTaskValidated).toHaveBeenCalledWith(
      TASK_ID,
      [TABLE_SELECTION_REF],
      "table",
      NOW,
      expect.any(Function),
    );
    expect(cli.runUser).toHaveBeenCalledTimes(5);
  });

  it("compiles verified refs into the canonical v1.0.72 aggregate DSL and parses its locked envelope", async () => {
    const { cli, reader, resolved, schema } = await resolvedQueryReader([
      succeededEnvelope(DOCUMENTED_LARK_CLI_1_0_72_DATA_QUERY_FIXTURE),
    ]);
    const amount = schema.fields[1]!;
    const region = schema.fields[2]!;

    const result = await reader.queryData(
      TASK_ID,
      {
        baseRef: resolved.resource.baseRef,
        tableRef: schema.table.tableRef,
        dimensionFieldRefs: [region.fieldRef],
        aggregates: [{ fieldRef: amount.fieldRef, operator: "sum" }],
        filter: {
          kind: "group",
          conjunction: "and",
          clauses: [
            {
              kind: "condition",
              fieldRef: amount.fieldRef,
              operator: "gte",
              value: 100,
            },
            {
              kind: "group",
              conjunction: "and",
              clauses: [
                {
                  kind: "condition",
                  fieldRef: region.fieldRef,
                  operator: "in",
                  value: ["华北", "华东"],
                },
              ],
            },
          ],
        },
        sort: [
          {
            fieldRef: amount.fieldRef,
            aggregate: "sum",
            direction: "desc",
          },
        ],
        limit: 10,
      },
      NOW,
    );

    expect(cli.runUser.mock.calls.at(-1)?.[0]).toEqual({
      version: 1,
      operation: "base.data.query",
      payload: {
        baseToken: "bascnSecret",
        dsl: {
          datasource: {
            type: "table",
            table: { tableId: "tblSecret" },
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
              {
                field_name: "金额",
                operator: "isGreaterEqual",
                value: ["100"],
              },
              {
                field_name: "地区",
                operator: "contains",
                value: ["华北", "华东"],
              },
            ],
          },
          sort: [{ field_name: "measure_0", order: "desc" }],
          pagination: { limit: 10 },
          shaper: { format: "flat" },
        },
      },
    });
    expect(result).toMatchObject({
      status: "RESOLVED",
      kind: "AGGREGATE",
      table: { tableRef: schema.table.tableRef, name: "经营数据" },
      columns: [
        {
          kind: "dimension",
          fieldRef: region.fieldRef,
          name: "地区",
          type: "select",
        },
        {
          kind: "aggregate",
          fieldRef: amount.fieldRef,
          name: "金额",
          type: "number",
          operator: "sum",
        },
      ],
      rows: [{ values: ["华北", 1234.5] }],
      evidence: {
        evidenceRef: expect.any(String),
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        scope: {
          resource: "base",
          tableName: "经营数据",
          fieldNames: ["地区", "金额"],
          query: {
            kind: "AGGREGATE",
            dimensions: ["地区"],
            aggregates: [{ fieldName: "金额", operator: "sum" }],
            filter: {
              conjunction: "and",
              conditions: [
                { fieldName: "金额", operator: "gte", value: 100 },
                {
                  fieldName: "地区",
                  operator: "in",
                  value: ["华北", "华东"],
                },
              ],
            },
            sort: [
              {
                fieldName: "金额",
                aggregate: "sum",
                direction: "desc",
              },
            ],
            limit: 10,
          },
        },
        completeness: {
          complete: true,
          hasMore: false,
          truncatedBy: null,
          itemCount: 1,
        },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /bascnSecret|tblSecret|fldAmount|fldRegion|dimension_0|measure_0/,
    );
    expect(
      reader.getReadEvidence(TASK_ID, result.evidence.evidenceRef),
    ).toEqual(result.evidence);
    expect(() =>
      reader.getReadEvidence(OTHER_TASK_ID, result.evidence.evidenceRef),
    ).toThrowError("read evidence reference is not available");
  });

  it("labels dimension-only output as grouped dimension rows rather than raw records", async () => {
    const { cli, reader, resolved, schema } = await resolvedQueryReader([
      succeeded({
        main_data: [{ dimension_0: { value: "甲公司" } }],
      }),
    ]);
    const customer = schema.fields[0]!;

    const result = await reader.queryData(
      TASK_ID,
      {
        baseRef: resolved.resource.baseRef,
        tableRef: schema.table.tableRef,
        dimensionFieldRefs: [customer.fieldRef],
        aggregates: [],
        filter: null,
        sort: [
          {
            fieldRef: customer.fieldRef,
            aggregate: null,
            direction: "asc",
          },
        ],
        limit: 100,
      },
      NOW,
    );

    expect(result).toMatchObject({
      status: "RESOLVED",
      kind: "DIMENSION_ROWS",
      columns: [
        {
          kind: "dimension",
          fieldRef: customer.fieldRef,
          name: "客户",
          type: "text",
        },
      ],
      rows: [{ values: ["甲公司"] }],
      evidence: {
        scope: {
          query: {
            kind: "DIMENSION_ROWS",
            dimensions: ["客户"],
            aggregates: [],
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("recordRef");
    expect(JSON.stringify(result)).not.toContain("record_id");
    expect(JSON.stringify(result)).not.toContain("RAW");
    const queryPayload = cli.runUser.mock.calls.at(-1)?.[0].payload;
    expect(queryPayload).toMatchObject({
      dsl: {
        datasource: {
          type: "table",
          table: { tableId: "tblSecret" },
        },
        dimensions: [{ field_name: "客户", alias: "dimension_0" }],
        measures: [],
        sort: [{ field_name: "dimension_0", order: "asc" }],
        pagination: { limit: 100 },
        shaper: { format: "flat" },
      },
    });
    expect(
      Object.hasOwn(
        (queryPayload?.dsl as Readonly<Record<string, unknown>>) ?? {},
        "filters",
      ),
    ).toBe(false);
  });

  it("treats count as a non-empty field count and accepts a non-negative integer result", async () => {
    const { reader, resolved, schema } = await resolvedQueryReader([
      succeeded({ main_data: [{ measure_0: { value: 3 } }] }),
    ]);
    const customer = schema.fields[0]!;

    const result = await reader.queryData(
      TASK_ID,
      {
        baseRef: resolved.resource.baseRef,
        tableRef: schema.table.tableRef,
        dimensionFieldRefs: [],
        aggregates: [{ fieldRef: customer.fieldRef, operator: "count" }],
        filter: null,
        sort: [],
        limit: 10,
      },
      NOW,
    );

    expect(result).toMatchObject({
      kind: "AGGREGATE",
      columns: [
        {
          kind: "aggregate",
          fieldRef: customer.fieldRef,
          name: "客户",
          type: "text",
          operator: "count",
        },
      ],
      rows: [{ values: [3] }],
    });
  });

  it("rejects raw authority, unknown refs, unsupported field/operator pairs, and ambiguous sort targets before the query route", async () => {
    const { cli, reader, resolved, schema } = await resolvedQueryReader([]);
    const customer = schema.fields[0]!;
    const amount = schema.fields[1]!;
    const region = schema.fields[2]!;
    const base = {
      baseRef: resolved.resource.baseRef,
      tableRef: schema.table.tableRef,
      dimensionFieldRefs: [customer.fieldRef],
      aggregates: [],
      filter: null,
      sort: [],
      limit: 10,
    } as const;
    const cases: readonly unknown[] = [
      { ...base, dsl: { datasource: {} } },
      { ...base, baseToken: "bascnInjected" },
      { ...base, tableId: "tblInjected" },
      { ...base, url: "https://example.feishu.cn/base/bascnInjected" },
      { ...base, dimensionFieldRefs: [randomUUID()] },
      {
        ...base,
        filter: {
          kind: "condition",
          fieldRef: customer.fieldRef,
          operator: "gt",
          value: "甲公司",
        },
      },
      {
        ...base,
        filter: {
          kind: "condition",
          fieldRef: amount.fieldRef,
          operator: "in",
          value: [1, 2],
        },
      },
      {
        ...base,
        aggregates: [{ fieldRef: region.fieldRef, operator: "sum" }],
      },
      {
        ...base,
        sort: [
          {
            fieldRef: amount.fieldRef,
            aggregate: "sum",
            direction: "desc",
          },
        ],
      },
      { ...base, limit: 0 },
      { ...base, limit: 5_001 },
    ];

    for (const payload of cases) {
      await expect(
        reader.queryData(TASK_ID, payload as never, NOW),
      ).rejects.toThrow();
    }
    expect(cli.runUser).toHaveBeenCalledTimes(5);
  });

  it("rejects mixed Boolean nesting, excessive nodes, excessive bytes, Proxy, and accessor inputs", async () => {
    const { cli, reader, resolved, schema } = await resolvedQueryReader([]);
    const customer = schema.fields[0]!;
    const region = schema.fields[2]!;
    const base = {
      baseRef: resolved.resource.baseRef,
      tableRef: schema.table.tableRef,
      dimensionFieldRefs: [customer.fieldRef],
      aggregates: [],
      sort: [],
      limit: 10,
    } as const;
    const condition = {
      kind: "condition",
      fieldRef: customer.fieldRef,
      operator: "eq",
      value: "甲公司",
    } as const;
    const mixed = {
      ...base,
      filter: {
        kind: "group",
        conjunction: "and",
        clauses: [
          condition,
          {
            kind: "group",
            conjunction: "or",
            clauses: [condition],
          },
        ],
      },
    };
    const tooManyNodes = {
      ...base,
      filter: {
        kind: "group",
        conjunction: "and",
        clauses: Array.from({ length: 64 }, () => condition),
      },
    };
    const tooManyBytes = {
      ...base,
      filter: {
        kind: "group",
        conjunction: "and",
        clauses: Array.from({ length: 7 }, (_, conditionIndex) => ({
          kind: "condition",
          fieldRef: region.fieldRef,
          operator: "in",
          value: Array.from(
            { length: 20 },
            (_, valueIndex) =>
              `${conditionIndex}-${valueIndex}-${"值".repeat(490)}`,
          ),
        })),
      },
    };
    const proxied = new Proxy({ ...base, filter: null }, {});
    const accessor = { ...base, filter: null } as Record<string, unknown>;
    Object.defineProperty(accessor, "rawDsl", {
      enumerable: true,
      get: () => '{"datasource":{}}',
    });

    for (const payload of [
      mixed,
      tooManyNodes,
      tooManyBytes,
      proxied,
      accessor,
    ]) {
      await expect(
        reader.queryData(TASK_ID, payload as never, NOW),
      ).rejects.toThrow();
    }
    expect(cli.runUser).toHaveBeenCalledTimes(5);
  });

  it.each([
    [
      "runner UNKNOWN",
      { state: "UNKNOWN", code: "TIMEOUT" } as const,
      "Base query CLI result is unavailable",
    ],
    [
      "wrong aggregate value type",
      succeeded({ main_data: [{ measure_0: { value: "123" } }] }),
      "invalid Base CLI result",
    ],
    [
      "extra CellValue property",
      succeeded({
        main_data: [{ measure_0: { value: 123, raw_value: "123" } }],
      }),
      "invalid Base CLI result",
    ],
    [
      "negative count",
      succeeded({ main_data: [{ measure_0: { value: -1 } }] }),
      "invalid Base CLI result",
    ],
    [
      "fractional count",
      succeeded({ main_data: [{ measure_0: { value: 1.5 } }] }),
      "invalid Base CLI result",
    ],
    [
      "more rows than the fixed limit",
      succeeded({
        main_data: [{ measure_0: { value: 1 } }, { measure_0: { value: 2 } }],
      }),
      "invalid Base CLI result",
    ],
  ] as const)(
    "fails closed on data-query %s",
    async (_name, response, error) => {
      const { reader, resolved, schema } = await resolvedQueryReader([
        response,
      ]);
      const field =
        _name === "negative count" || _name === "fractional count"
          ? schema.fields[0]!
          : schema.fields[1]!;

      await expect(
        reader.queryData(
          TASK_ID,
          {
            baseRef: resolved.resource.baseRef,
            tableRef: schema.table.tableRef,
            dimensionFieldRefs: [],
            aggregates: [
              {
                fieldRef: field.fieldRef,
                operator:
                  _name === "negative count" || _name === "fractional count"
                    ? "count"
                    : "sum",
              },
            ],
            filter: null,
            sort: [],
            limit: _name === "more rows than the fixed limit" ? 1 : 10,
          },
          NOW,
        ),
      ).rejects.toThrowError(error);
    },
  );

  it("marks a dimension result at the query limit incomplete because v1.0.72 returns no total or has_more", async () => {
    const { reader, resolved, schema } = await resolvedQueryReader([
      succeeded({
        main_data: [{ dimension_0: { value: "甲公司" } }],
      }),
    ]);
    const customer = schema.fields[0]!;

    const result = await reader.queryData(
      TASK_ID,
      {
        baseRef: resolved.resource.baseRef,
        tableRef: schema.table.tableRef,
        dimensionFieldRefs: [customer.fieldRef],
        aggregates: [],
        filter: null,
        sort: [],
        limit: 1,
      },
      NOW,
    );

    expect(result.evidence.completeness).toEqual({
      complete: false,
      hasMore: true,
      truncatedBy: "row_limit",
      itemCount: 1,
    });
  });

  it("rejects a successful data-query envelope above the 8 MiB structured result boundary", async () => {
    const { reader, resolved, schema } = await resolvedQueryReader([
      succeeded({
        main_data: [{ dimension_0: { value: "x".repeat(8 * 1024 * 1024) } }],
      }),
    ]);
    const customer = schema.fields[0]!;

    await expect(
      reader.queryData(
        TASK_ID,
        {
          baseRef: resolved.resource.baseRef,
          tableRef: schema.table.tableRef,
          dimensionFieldRefs: [customer.fieldRef],
          aggregates: [],
          filter: null,
          sort: [],
          limit: 1,
        },
        NOW,
      ),
    ).rejects.toThrowError("invalid Base CLI result");
  });

  it("rejects when status and evidence push the complete frozen result above 8 MiB without storing partial evidence", async () => {
    const refs = Array.from(
      { length: 9 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    const tableRef = refs[1]!;
    const customerRef = refs[3]!;
    const queryEvidenceRef = refs[8]!;
    const maximumBytes = 8 * 1024 * 1024;
    const escapedSuffix = '"\\\n';
    const contentFor = (value: string) => ({
      kind: "DIMENSION_ROWS" as const,
      table: { tableRef, name: "经营数据" },
      columns: [
        {
          kind: "dimension" as const,
          fieldRef: customerRef,
          name: "客户",
          type: "text",
        },
      ],
      rows: [{ values: [value] }],
    });
    const seedBytes = Buffer.byteLength(
      JSON.stringify(contentFor(escapedSuffix)),
      "utf8",
    );
    const boundaryValue =
      "x".repeat(maximumBytes - 1 - seedBytes) + escapedSuffix;
    const content = contentFor(boundaryValue);
    const queryScope = {
      kind: "DIMENSION_ROWS" as const,
      dimensions: ["客户"],
      aggregates: [],
      filter: null,
      sort: [],
      limit: 2,
    };
    const completeResult = {
      status: "RESOLVED",
      ...content,
      evidence: {
        evidenceRef: queryEvidenceRef,
        digest: `sha256:${"0".repeat(64)}`,
        scope: {
          resource: "base",
          tableName: "经营数据",
          fieldNames: ["客户"],
          query: queryScope,
        },
        completeness: {
          complete: true,
          hasMore: false,
          truncatedBy: null,
          itemCount: 1,
        },
      },
    };
    expect(Buffer.byteLength(JSON.stringify(content), "utf8")).toBe(
      maximumBytes - 1,
    );
    expect(
      Buffer.byteLength(JSON.stringify(completeResult), "utf8"),
    ).toBeGreaterThan(maximumBytes);

    let nextRef = 0;
    const { reader, resolved, schema } = await resolvedQueryReader(
      [
        succeeded({
          main_data: [{ dimension_0: { value: boundaryValue } }],
        }),
      ],
      { randomUuid: () => refs[nextRef++]! },
    );
    const customer = schema.fields[0]!;
    expect(schema.table.tableRef).toBe(tableRef);
    expect(customer.fieldRef).toBe(customerRef);

    const outcome = await reader
      .queryData(
        TASK_ID,
        {
          baseRef: resolved.resource.baseRef,
          tableRef: schema.table.tableRef,
          dimensionFieldRefs: [customer.fieldRef],
          aggregates: [],
          filter: null,
          sort: [],
          limit: 2,
        },
        NOW,
      )
      .then(
        () => ({ state: "RETURNED" as const }),
        (error: unknown) => ({ state: "REJECTED" as const, error }),
      );

    expect.soft(outcome.state).toBe("REJECTED");
    if (outcome.state === "REJECTED") {
      expect(outcome.error).toEqual(new Error("invalid Base CLI result"));
    }
    expect(() =>
      reader.getReadEvidence(TASK_ID, queryEvidenceRef),
    ).toThrowError("read evidence reference is not available");
  });

  it("serially paginates record pages, strips record IDs, and stores completeness evidence", async () => {
    const { cli, reader, schema } = await resolvedTableReader([
      succeeded(
        recordPage({
          fields: ["客户", "金额"],
          fieldIds: ["fldName", "fldRevenue"],
          recordIds: ["recSecret1", "recSecret2"],
          rows: [
            ["甲公司", 100],
            ["乙公司", 200],
          ],
          total: 3,
          hasMore: true,
        }),
      ),
      succeeded(
        recordPage({
          fields: ["客户", "金额"],
          fieldIds: ["fldName", "fldRevenue"],
          recordIds: ["recSecret3"],
          rows: [["丙公司", 300]],
          total: 3,
          hasMore: false,
        }),
      ),
    ]);

    const result = await reader.readRecords(
      TASK_ID,
      {
        tableRef: schema.table.tableRef,
        fieldRefs: schema.fields.map((field) => field.fieldRef),
        viewRef: schema.views[0]!.viewRef,
      },
      NOW,
    );

    expect(result).toMatchObject({
      status: "RESOLVED",
      table: { tableRef: schema.table.tableRef, name: "经营数据" },
      columns: [
        { fieldRef: schema.fields[0]!.fieldRef, name: "客户", type: "text" },
        {
          fieldRef: schema.fields[1]!.fieldRef,
          name: "金额",
          type: "number",
        },
      ],
      rows: [
        { values: ["甲公司", 100] },
        { values: ["乙公司", 200] },
        { values: ["丙公司", 300] },
      ],
      evidence: {
        evidenceRef: expect.any(String),
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        scope: {
          tableName: "经营数据",
          viewName: "主视图",
          fieldNames: ["客户", "金额"],
        },
        completeness: {
          complete: true,
          hasMore: false,
          truncatedBy: null,
          itemCount: 3,
        },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /recSecret|bascnSecret|tblSecret"?[:,]|fldName|fldRevenue|vewMain/,
    );
    if (result.status !== "RESOLVED") {
      throw new Error("expected resolved records");
    }
    expect(
      reader.getReadEvidence(TASK_ID, result.evidence.evidenceRef),
    ).toEqual(result.evidence);
    expect(() =>
      reader.getReadEvidence(OTHER_TASK_ID, result.evidence.evidenceRef),
    ).toThrowError("read evidence reference is not available");
    expect(
      cli.runUser.mock.calls.slice(-2).map(([request]) => request),
    ).toEqual([
      {
        version: 1,
        operation: "base.record.list",
        payload: {
          baseToken: "bascnSecret",
          tableId: "tblSecret",
          viewId: "vewMain",
          fieldIds: ["fldName", "fldRevenue"],
          filterJson: null,
          sortJson: null,
          offset: 0,
          limit: 200,
        },
      },
      {
        version: 1,
        operation: "base.record.list",
        payload: {
          baseToken: "bascnSecret",
          tableId: "tblSecret",
          viewId: "vewMain",
          fieldIds: ["fldName", "fldRevenue"],
          filterJson: null,
          sortJson: null,
          offset: 2,
          limit: 200,
        },
      },
    ]);
  });

  it("fails closed before listing records when one task observes conflicting titles for the same Base token", async () => {
    const cli = runner([
      succeeded(baseUrlData("tblSecret")),
      succeeded(baseAppData("经营驾驶舱")),
      succeeded(tablePage([{ id: "tblSecret", name: "经营数据" }])),
      succeeded(
        fieldPage([{ id: "fldRevenue", name: "收入", type: "number" }]),
      ),
      succeeded(viewPage([])),
      succeeded(baseUrlData("tblSecret")),
      succeeded(baseAppData("冲突标题")),
    ]);
    const reader = createBaseReader({ runner: cli });
    const first = await reader.resolve(
      TASK_ID,
      {
        source: "url",
        url: "https://example.feishu.cn/base/bascnSecret?table=tblSecret",
      },
      NOW,
    );
    if (first.status !== "RESOLVED" || first.resource.tableRef === undefined) {
      throw new Error("expected first resolved Base table");
    }
    const schema = await reader.readSchema(
      TASK_ID,
      {
        baseRef: first.resource.baseRef,
        tableRef: first.resource.tableRef,
      },
      NOW,
    );
    if (schema.status !== "RESOLVED") {
      throw new Error("expected resolved Base schema");
    }
    const conflicting = await reader.resolve(
      TASK_ID,
      {
        source: "url",
        url: "https://example.feishu.cn/base/bascnSecret?table=tblSecret",
      },
      NOW,
    );
    expect(conflicting.status).toBe("RESOLVED");

    await expect(
      reader.readRecords(
        TASK_ID,
        {
          tableRef: schema.table.tableRef,
          fieldRefs: schema.fields.map((field) => field.fieldRef),
          viewRef: null,
        },
        NOW,
      ),
    ).rejects.toThrow("invalid Base CLI result");
    expect(
      cli.runUser.mock.calls.filter(
        ([request]) => request.operation === "base.record.list",
      ),
    ).toHaveLength(0);
  });

  it("accepts the locked record envelope without field_id_list when field names and order match the selected schema", async () => {
    const { reader, schema } = await resolvedTableReader([
      succeeded(
        recordPage({
          fields: ["客户", "金额"],
          recordIds: ["recSecret1"],
          rows: [["甲公司", 100]],
          total: 1,
        }),
      ),
    ]);

    const result = await reader.readRecords(
      TASK_ID,
      {
        tableRef: schema.table.tableRef,
        fieldRefs: schema.fields.map((field) => field.fieldRef),
        viewRef: null,
      },
      NOW,
    );

    expect(result).toMatchObject({
      status: "RESOLVED",
      rows: [{ values: ["甲公司", 100] }],
      evidence: {
        completeness: {
          complete: true,
          hasMore: false,
          truncatedBy: null,
          itemCount: 1,
        },
      },
    });
  });

  it.each([
    [
      "drops a previously known total",
      [
        recordPage({
          fields: ["客户", "金额"],
          fieldIds: ["fldName", "fldRevenue"],
          recordIds: ["recSecret1"],
          rows: [["甲公司", 100]],
          total: 2,
          hasMore: true,
        }),
        recordPage({
          fields: ["客户", "金额"],
          fieldIds: ["fldName", "fldRevenue"],
          recordIds: ["recSecret2"],
          rows: [["乙公司", 200]],
          hasMore: false,
        }),
      ],
    ],
    [
      "changes a previously known total",
      [
        recordPage({
          fields: ["客户", "金额"],
          fieldIds: ["fldName", "fldRevenue"],
          recordIds: ["recSecret1"],
          rows: [["甲公司", 100]],
          total: 2,
          hasMore: true,
        }),
        recordPage({
          fields: ["客户", "金额"],
          fieldIds: ["fldName", "fldRevenue"],
          recordIds: ["recSecret2"],
          rows: [["乙公司", 200]],
          total: 3,
          hasMore: false,
        }),
      ],
    ],
    [
      "claims has_more=false before reaching total",
      [
        recordPage({
          fields: ["客户", "金额"],
          fieldIds: ["fldName", "fldRevenue"],
          recordIds: ["recSecret1"],
          rows: [["甲公司", 100]],
          total: 2,
          hasMore: false,
        }),
      ],
    ],
    [
      "claims has_more=true after reaching total",
      [
        recordPage({
          fields: ["客户", "金额"],
          fieldIds: ["fldName", "fldRevenue"],
          recordIds: ["recSecret1"],
          rows: [["甲公司", 100]],
          total: 1,
          hasMore: true,
        }),
      ],
    ],
  ] as const)("rejects a record page that %s", async (_name, pages) => {
    const { reader, schema } = await resolvedTableReader(
      pages.map((page) => succeeded(page)),
    );

    await expect(
      reader.readRecords(
        TASK_ID,
        {
          tableRef: schema.table.tableRef,
          fieldRefs: schema.fields.map((field) => field.fieldRef),
          viewRef: null,
        },
        NOW,
      ),
    ).rejects.toThrowError("invalid Base CLI result");
  });

  it("derives hasMore from a stable total when the locked envelope omits has_more", async () => {
    const { reader, schema } = await resolvedTableReader([
      succeeded(
        recordPage({
          fields: ["客户", "金额"],
          fieldIds: ["fldName", "fldRevenue"],
          recordIds: ["recSecret1"],
          rows: [["甲公司", 100]],
          total: 2,
        }),
      ),
      succeeded(
        recordPage({
          fields: ["客户", "金额"],
          fieldIds: ["fldName", "fldRevenue"],
          recordIds: ["recSecret2"],
          rows: [["乙公司", 200]],
          total: 2,
        }),
      ),
    ]);

    const result = await reader.readRecords(
      TASK_ID,
      {
        tableRef: schema.table.tableRef,
        fieldRefs: schema.fields.map((field) => field.fieldRef),
        viewRef: null,
      },
      NOW,
    );

    expect(result.evidence.completeness).toEqual({
      complete: true,
      hasMore: false,
      truncatedBy: null,
      itemCount: 2,
    });
  });

  it("fails closed when an intermediate record page is unavailable instead of returning partial data", async () => {
    const { reader, schema } = await resolvedTableReader([
      succeeded(
        recordPage({
          fields: ["客户", "金额"],
          fieldIds: ["fldName", "fldRevenue"],
          recordIds: ["recSecret1"],
          rows: [["甲公司", 100]],
          total: 2,
          hasMore: true,
        }),
      ),
      { state: "UNKNOWN", code: "TIMEOUT" },
    ]);

    await expect(
      reader.readRecords(
        TASK_ID,
        {
          tableRef: schema.table.tableRef,
          fieldRefs: schema.fields.map((field) => field.fieldRef),
          viewRef: null,
        },
        NOW,
      ),
    ).rejects.toThrowError("Base records CLI result is unavailable");
  });

  it("stops at 2,000 records while preserving hasMore and truncation evidence", async () => {
    const pages = Array.from({ length: 10 }, (_, page) =>
      succeeded(
        recordPage({
          fields: ["客户"],
          fieldIds: ["fldName"],
          recordIds: Array.from(
            { length: 200 },
            (_, row) => `rec_${page}_${row}`,
          ),
          rows: Array.from({ length: 200 }, (_, row) => [
            `客户${page * 200 + row}`,
          ]),
          total: 2_001,
          hasMore: true,
        }),
      ),
    );
    const cli = runner([
      succeeded(baseUrlData("tblSecret")),
      succeeded(baseAppData()),
      succeeded(tablePage([{ id: "tblSecret", name: "经营数据" }])),
      succeeded(fieldPage([{ id: "fldName", name: "客户", type: "text" }])),
      succeeded(viewPage([])),
      ...pages,
    ]);
    const reader = createBaseReader({ runner: cli });
    const resolved = await reader.resolve(
      TASK_ID,
      {
        source: "url",
        url: "https://example.feishu.cn/base/bascnSecret?table=tblSecret",
      },
      NOW,
    );
    if (
      resolved.status !== "RESOLVED" ||
      resolved.resource.tableRef === undefined
    ) {
      throw new Error("expected resolved table");
    }
    const schema = await reader.readSchema(
      TASK_ID,
      {
        baseRef: resolved.resource.baseRef,
        tableRef: resolved.resource.tableRef,
      },
      NOW,
    );
    if (schema.status !== "RESOLVED") throw new Error("expected schema");

    const result = await reader.readRecords(
      TASK_ID,
      {
        tableRef: schema.table.tableRef,
        fieldRefs: [schema.fields[0]!.fieldRef],
        viewRef: null,
      },
      NOW,
    );

    expect(result).toMatchObject({
      status: "RESOLVED",
      rows: expect.any(Array),
      evidence: {
        completeness: {
          complete: false,
          hasMore: true,
          truncatedBy: "row_limit",
          itemCount: 2_000,
        },
      },
    });
    if (result.status !== "RESOLVED") throw new Error("expected records");
    expect(result.rows).toHaveLength(2_000);
    expect(
      cli.runUser.mock.calls.filter(
        ([request]) => request.operation === "base.record.list",
      ),
    ).toHaveLength(10);
  });

  it("stops before the 8 MiB structured-output boundary and reports the unread row", async () => {
    const { reader, schema } = await resolvedTableReader([
      succeeded(
        recordPage({
          fields: ["客户", "金额"],
          fieldIds: ["fldName", "fldRevenue"],
          recordIds: ["recLarge1", "recLarge2"],
          rows: [
            ["甲公司", "x".repeat(7 * 1024 * 1024)],
            ["乙公司", "y".repeat(2 * 1024 * 1024)],
          ],
          total: 2,
          hasMore: false,
        }),
      ),
    ]);

    const result = await reader.readRecords(
      TASK_ID,
      {
        tableRef: schema.table.tableRef,
        fieldRefs: schema.fields.map((field) => field.fieldRef),
        viewRef: null,
      },
      NOW,
    );

    expect(result).toMatchObject({
      status: "RESOLVED",
      rows: [{ values: ["甲公司", expect.any(String)] }],
      evidence: {
        completeness: {
          complete: false,
          hasMore: true,
          truncatedBy: "byte_limit",
          itemCount: 1,
        },
      },
    });
  });

  it("rejects cross-task refs, hidden controls, and malformed official envelopes", async () => {
    const cli = runner([
      succeeded(baseUrlData("tblSecret")),
      succeeded(baseAppData()),
      {
        state: "SUCCEEDED",
        value: {
          ok: true,
          identity: "bot",
          data: baseUrlData("tblSecret"),
        },
      },
    ]);
    const reader = createBaseReader({ runner: cli });
    const resolved = await reader.resolve(
      TASK_ID,
      {
        source: "url",
        url: "https://example.feishu.cn/base/bascnSecret?table=tblSecret",
      },
      NOW,
    );
    if (resolved.status !== "RESOLVED") throw new Error("expected Base");

    await expect(
      reader.readSchema(
        OTHER_TASK_ID,
        { baseRef: resolved.resource.baseRef },
        NOW,
      ),
    ).rejects.toThrowError("base reference is not available");
    await expect(
      reader.resolve(
        TASK_ID,
        {
          source: "title",
          title: "经营日报",
          token: "bascnInjected",
        } as never,
        NOW,
      ),
    ).rejects.toThrowError("invalid Base resolve payload");
    await expect(
      reader.resolve(
        TASK_ID,
        { source: "url", url: "https://evil.example/base/bascnInjected" },
        NOW,
      ),
    ).rejects.toThrowError("invalid Base resolve payload");
    await expect(
      reader.resolve(
        TASK_ID,
        {
          source: "url",
          url: "https://example.feishu.cn/base/bascnSecond",
        },
        NOW,
      ),
    ).rejects.toThrowError("invalid Base CLI result");
  });
});
