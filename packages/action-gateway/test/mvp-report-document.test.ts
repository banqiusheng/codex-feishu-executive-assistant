import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import {
  createBaseReader,
  type BaseReadEvidence,
} from "../src/mvp/base-reader.js";
import { snapshotStrictJson } from "../src/ipc/framing.js";
import { planReportDocumentInstruction } from "../src/mvp/report-document.js";
import type { MvpLarkCliRunner } from "../src/mvp/registry.js";

const TASK_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a21";
const OTHER_TASK_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a29";
const EVIDENCE_REF_1 = "018f7d72-7a2b-7f45-8a12-8e20b8426a31";
const EVIDENCE_REF_2 = "018f7d72-7a2b-7f45-8a12-8e20b8426a32";
const EVIDENCE_REF_3 = "018f7d72-7a2b-7f45-8a12-8e20b8426a33";
const EVIDENCE_REF_4 = "018f7d72-7a2b-7f45-8a12-8e20b8426a34";
const NOW = new Date("2026-07-30T16:30:00.000Z");

function evidence(
  evidenceRef: string,
  overrides: Partial<BaseReadEvidence> = {},
): BaseReadEvidence {
  return Object.freeze({
    evidenceRef,
    digest: `sha256:${"a".repeat(64)}`,
    scope: Object.freeze({
      resource: "base" as const,
      baseTitle: "经营驾驶舱",
      tableName: "月度经营",
      viewName: "总裁视图",
      fieldNames: Object.freeze(["月份", "区域", "收入"]),
      query: Object.freeze({
        kind: "AGGREGATE" as const,
        dimensions: Object.freeze(["区域"]),
        aggregates: Object.freeze([
          Object.freeze({ fieldName: "收入", operator: "sum" as const }),
        ]),
        filter: Object.freeze({
          conjunction: "and" as const,
          conditions: Object.freeze([
            Object.freeze({
              fieldName: "月份",
              operator: "eq" as const,
              value: "2026-07",
            }),
          ]),
        }),
        sort: Object.freeze([
          Object.freeze({
            fieldName: "收入",
            aggregate: "sum" as const,
            direction: "desc" as const,
          }),
        ]),
        limit: 10,
      }),
    }),
    completeness: Object.freeze({
      complete: true,
      hasMore: false,
      truncatedBy: null,
      itemCount: 10,
    }),
    ...overrides,
  });
}

function input(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    evidenceRefs: [EVIDENCE_REF_1],
    conclusions: ["收入保持增长"],
    metrics: [{ label: "收入", value: "1.2 亿元", note: "同比增长 12%" }],
    risks: ["华南区域低于预算"],
    actions: ["复核华南重点项目"],
    ...overrides,
  };
}

function resolver(
  values: Readonly<Record<string, BaseReadEvidence>>,
): (taskId: string, evidenceRef: string) => BaseReadEvidence {
  return vi.fn((taskId: string, evidenceRef: string) => {
    expect(taskId).toBe(TASK_ID);
    const value = values[evidenceRef];
    if (value === undefined) throw new Error("not found");
    return value;
  });
}

describe("native Feishu report document planning", () => {
  it("builds one frozen User direct plan with a fixed title, XML structure, evidence scope, and escaped content", () => {
    const plan = planReportDocumentInstruction(
      TASK_ID,
      input({
        evidenceRefs: [EVIDENCE_REF_1, EVIDENCE_REF_2],
        conclusions: [`收入 & 利润 <预期> "改善" '确认'`],
        metrics: [
          {
            label: `收入 & 利润`,
            value: `<1.2 亿元>`,
            note: `"同比" '增长'`,
          },
        ],
        risks: [`区域 <风险> & "预算" '偏差'`],
        actions: [`复核 <华南> & "重点" '项目'`],
      }),
      NOW,
      resolver({
        [EVIDENCE_REF_1]: evidence(EVIDENCE_REF_1),
        [EVIDENCE_REF_2]: evidence(EVIDENCE_REF_2, {
          digest: `sha256:${"b".repeat(64)}`,
        }),
      }),
    );

    expect(plan).toEqual({
      taskId: TASK_ID,
      capability: "document.report.create",
      identity: "user",
      itemKey: expect.stringMatching(/^document-report:sha256:[0-9a-f]{64}$/),
      payload: {
        docFormat: "xml",
        parentPosition: "my_library",
        title: "经营驾驶舱分析报告｜2026-07-31",
        content: expect.any(String),
      },
      preview: {
        action: "document.report.create",
        title: "经营驾驶舱分析报告｜2026-07-31",
        conclusions: [`收入 & 利润 <预期> "改善" '确认'`],
        evidenceCount: 2,
        impact: "将在总裁个人云空间创建一份原生飞书云文档",
      },
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.payload)).toBe(true);
    expect(Object.isFrozen(plan.preview)).toBe(true);
    expect(Object.isFrozen(plan.preview.conclusions)).toBe(true);
    expect(Reflect.ownKeys(plan.payload)).toEqual([
      "docFormat",
      "parentPosition",
      "title",
      "content",
    ]);

    const xml = plan.payload.content;
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><doc>')).toBe(
      true,
    );
    expect(Buffer.byteLength(xml, "utf8")).toBeLessThan(256 * 1024);
    expect(xml).toContain(
      "收入 &amp; 利润 &lt;预期&gt; &quot;改善&quot; &apos;确认&apos;",
    );
    expect(xml).toContain("&lt;1.2 亿元&gt;");
    expect(xml).not.toContain("<预期>");
    expect(xml).not.toContain("<华南>");
    expect(xml).toContain("Base：经营驾驶舱");
    expect(xml).toContain("数据表：月度经营");
    expect(xml).toContain("视图：总裁视图");
    expect(xml).toContain("筛选条件：月份 eq 2026-07");
    expect(xml).toContain("聚合口径：sum(收入)");
    expect(xml).toContain("完整性：完整；结果项数：10");
    const sectionOffsets = [
      "核心结论",
      "关键数据",
      "异常与风险",
      "建议动作",
      "数据来源与口径",
    ].map((section) => xml.indexOf(section));
    expect(sectionOffsets.every((offset) => offset >= 0)).toBe(true);
    expect(sectionOffsets).toEqual([...sectionOffsets].sort((a, b) => a - b));
    expect(xml).not.toMatch(
      /018f7d72|sha256:|base_token|parent_token|https?:\/\/|file:\/\//u,
    );
  });

  it("uses semantic report and evidence content rather than opaque refs or ref order for idempotency", () => {
    const first = planReportDocumentInstruction(
      TASK_ID,
      input({ evidenceRefs: [EVIDENCE_REF_1, EVIDENCE_REF_2] }),
      NOW,
      resolver({
        [EVIDENCE_REF_1]: evidence(EVIDENCE_REF_1),
        [EVIDENCE_REF_2]: evidence(EVIDENCE_REF_2, {
          digest: `sha256:${"b".repeat(64)}`,
        }),
      }),
    );
    const semanticReplay = planReportDocumentInstruction(
      TASK_ID,
      input({ evidenceRefs: [EVIDENCE_REF_4, EVIDENCE_REF_3] }),
      NOW,
      resolver({
        [EVIDENCE_REF_3]: evidence(EVIDENCE_REF_3),
        [EVIDENCE_REF_4]: evidence(EVIDENCE_REF_4, {
          digest: `sha256:${"b".repeat(64)}`,
        }),
      }),
    );
    const changedEvidence = planReportDocumentInstruction(
      TASK_ID,
      input({ evidenceRefs: [EVIDENCE_REF_1, EVIDENCE_REF_2] }),
      NOW,
      resolver({
        [EVIDENCE_REF_1]: evidence(EVIDENCE_REF_1),
        [EVIDENCE_REF_2]: evidence(EVIDENCE_REF_2, {
          digest: `sha256:${"c".repeat(64)}`,
        }),
      }),
    );
    const changedReport = planReportDocumentInstruction(
      TASK_ID,
      input({
        evidenceRefs: [EVIDENCE_REF_1, EVIDENCE_REF_2],
        actions: ["采取另一项动作"],
      }),
      NOW,
      resolver({
        [EVIDENCE_REF_1]: evidence(EVIDENCE_REF_1),
        [EVIDENCE_REF_2]: evidence(EVIDENCE_REF_2, {
          digest: `sha256:${"b".repeat(64)}`,
        }),
      }),
    );

    expect(semanticReplay.payload).toEqual(first.payload);
    expect(semanticReplay.itemKey).toBe(first.itemKey);
    expect(changedEvidence.itemKey).not.toBe(first.itemKey);
    expect(changedReport.itemKey).not.toBe(first.itemKey);
  });

  it("keeps report identity stable across task-local record refs and changes it with data or projection", async () => {
    const makeReader = (
      refPrefix: "1" | "2" | "3" | "4",
      values: readonly (string | number)[],
    ) => {
      const runUser = vi.fn<MvpLarkCliRunner["runUser"]>();
      const fields = [
        { id: "fldRevenue", name: "收入", type: "number" },
        ...(values.length === 1
          ? []
          : [{ id: "fldProfit", name: "利润", type: "number" }]),
      ];
      for (const data of [
        {
          input_type: "base_url",
          resource_type: "bitable",
          base_token: "bascnSecret",
          table_id: "tblSecret",
          hint: {},
        },
        {
          base: {
            base_token: "bascnSecret",
            name: "经营驾驶舱",
          },
        },
        {
          tables: [{ id: "tblSecret", name: "月度经营" }],
          total: 1,
        },
        {
          fields,
          total: fields.length,
        },
        {
          views: [{ id: "vewMain", name: "总裁视图", type: "grid" }],
          total: 1,
        },
        {
          fields: fields.map((field) => field.name),
          field_id_list: fields.map((field) => field.id),
          record_id_list: ["recSecret"],
          data: [values],
          total: 1,
          has_more: false,
        },
      ]) {
        runUser.mockResolvedValueOnce({
          state: "SUCCEEDED",
          value: snapshotStrictJson({
            ok: true,
            identity: "user",
            data,
          }),
        });
      }
      let ordinal = 0;
      return createBaseReader({
        runner: {
          runUser,
        },
        randomUuid: () => {
          ordinal += 1;
          return `00000000-0000-4000-8000-${refPrefix}${String(
            ordinal,
          ).padStart(11, "0")}`;
        },
      });
    };
    const readRecords = async (
      taskId: string,
      reader: ReturnType<typeof createBaseReader>,
    ) => {
      const resolved = await reader.resolve(
        taskId,
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
        taskId,
        {
          baseRef: resolved.resource.baseRef,
          tableRef: resolved.resource.tableRef,
        },
        NOW,
      );
      if (schema.status !== "RESOLVED") {
        throw new Error("expected resolved Base schema");
      }
      return reader.readRecords(
        taskId,
        {
          tableRef: schema.table.tableRef,
          fieldRefs: schema.fields.map((field) => field.fieldRef),
          viewRef: schema.views[0]?.viewRef ?? null,
        },
        NOW,
      );
    };
    const firstReader = makeReader("1", [1200]);
    const secondReader = makeReader("2", [1200]);
    const changedDataReader = makeReader("3", [1500]);
    const changedProjectionReader = makeReader("4", [1200, 300]);
    const firstRecords = await readRecords(TASK_ID, firstReader);
    const secondRecords = await readRecords(OTHER_TASK_ID, secondReader);
    const changedDataRecords = await readRecords(TASK_ID, changedDataReader);
    const changedProjectionRecords = await readRecords(
      TASK_ID,
      changedProjectionReader,
    );

    const firstPlan = planReportDocumentInstruction(
      TASK_ID,
      input({ evidenceRefs: [firstRecords.evidence.evidenceRef] }),
      NOW,
      firstReader.getReadEvidence,
    );
    const secondPlan = planReportDocumentInstruction(
      OTHER_TASK_ID,
      input({ evidenceRefs: [secondRecords.evidence.evidenceRef] }),
      NOW,
      secondReader.getReadEvidence,
    );
    const changedDataPlan = planReportDocumentInstruction(
      TASK_ID,
      input({ evidenceRefs: [changedDataRecords.evidence.evidenceRef] }),
      NOW,
      changedDataReader.getReadEvidence,
    );
    const changedProjectionPlan = planReportDocumentInstruction(
      TASK_ID,
      input({ evidenceRefs: [changedProjectionRecords.evidence.evidenceRef] }),
      NOW,
      changedProjectionReader.getReadEvidence,
    );

    expect(firstRecords.evidence.scope.baseTitle).toBe("经营驾驶舱");
    expect(secondRecords.evidence.scope.baseTitle).toBe("经营驾驶舱");
    expect(firstRecords.evidence.digest).toBe(secondRecords.evidence.digest);
    expect(firstPlan.payload).toEqual(secondPlan.payload);
    expect(firstPlan.itemKey).toBe(secondPlan.itemKey);
    expect(changedDataRecords.evidence.digest).not.toBe(
      firstRecords.evidence.digest,
    );
    expect(changedDataPlan.itemKey).not.toBe(firstPlan.itemKey);
    expect(changedProjectionRecords.evidence.digest).not.toBe(
      firstRecords.evidence.digest,
    );
    expect(changedProjectionPlan.itemKey).not.toBe(firstPlan.itemKey);
  });

  it("makes incomplete or truncated evidence explicit and never labels it as full data", () => {
    const plan = planReportDocumentInstruction(
      TASK_ID,
      input({ risks: [] }),
      NOW,
      resolver({
        [EVIDENCE_REF_1]: evidence(EVIDENCE_REF_1, {
          completeness: Object.freeze({
            complete: false,
            hasMore: true,
            truncatedBy: "row_limit",
            itemCount: 2_000,
          }),
        }),
      }),
    );

    expect(plan.payload.content).toContain(
      "完整性：不完整；结果项数：2000；仍有更多数据：是；截断原因：行数上限；不得视为全量",
    );
    expect(plan.payload.content).toContain(
      "当前证据不完整，报告结论不得视为全量结论",
    );
    expect(plan.payload.content).not.toContain("完整性：完整；结果项数：2000");
  });

  it.each([
    ["free XML", { xml: "<doc><text>injected</text></doc>" }],
    ["HTML", { html: "<h1>injected</h1>" }],
    ["Markdown", { markdown: "# injected" }],
    ["parent token", { parentToken: "fldcnInjected" }],
    ["parent snake token", { parent_token: "fldcnInjected" }],
    ["file path", { path: "/tmp/report.xml" }],
    ["URL", { url: "https://example.feishu.cn/docx/injected" }],
    ["document ID", { documentId: "doccnInjected" }],
    ["document snake ID", { document_id: "doccnInjected" }],
    ["title", { title: "caller title" }],
    ["identity", { identity: "bot" }],
  ])(
    "rejects caller-supplied %s authority before evidence access",
    (_name, extra) => {
      const getEvidence = resolver({
        [EVIDENCE_REF_1]: evidence(EVIDENCE_REF_1),
      });

      expect(() =>
        planReportDocumentInstruction(TASK_ID, input(extra), NOW, getEvidence),
      ).toThrowError("invalid report document payload");
      expect(getEvidence).not.toHaveBeenCalled();
    },
  );

  it("rejects extra, accessor, Proxy, Date, sparse arrays, and malformed metric objects", () => {
    const getEvidence = resolver({
      [EVIDENCE_REF_1]: evidence(EVIDENCE_REF_1),
    });
    const accessor = {};
    Object.defineProperty(accessor, "evidenceRefs", {
      enumerable: true,
      get: () => [EVIDENCE_REF_1],
    });
    const sparse = input({ actions: new Array(1) });
    const metricWithAuthority = input({
      metrics: [{ label: "收入", value: "1", url: "https://invalid.example" }],
    });

    for (const value of [
      accessor,
      new Proxy(input(), {}),
      new Date(),
      sparse,
      metricWithAuthority,
    ]) {
      expect(() =>
        planReportDocumentInstruction(TASK_ID, value, NOW, getEvidence),
      ).toThrowError("invalid report document payload");
    }
    expect(getEvidence).not.toHaveBeenCalled();
  });

  it("requires unique current-task Base evidence with one consistent evidence-derived Base title", () => {
    const valid = evidence(EVIDENCE_REF_1);

    for (const [payload, getEvidence] of [
      [input({ evidenceRefs: [] }), resolver({ [EVIDENCE_REF_1]: valid })],
      [
        input({ evidenceRefs: [EVIDENCE_REF_1, EVIDENCE_REF_1] }),
        resolver({ [EVIDENCE_REF_1]: valid }),
      ],
      [
        input(),
        resolver({
          [EVIDENCE_REF_1]: evidence(EVIDENCE_REF_2),
        }),
      ],
      [
        input({ evidenceRefs: [EVIDENCE_REF_1, EVIDENCE_REF_2] }),
        resolver({
          [EVIDENCE_REF_1]: valid,
          [EVIDENCE_REF_2]: evidence(EVIDENCE_REF_2, {
            scope: Object.freeze({
              ...valid.scope,
              baseTitle: "另一个 Base",
            }),
          }),
        }),
      ],
      [
        input(),
        resolver({
          [EVIDENCE_REF_1]: evidence(EVIDENCE_REF_1, {
            scope: Object.freeze({
              resource: "base",
              tableName: "月度经营",
              fieldNames: Object.freeze(["收入"]),
            }),
          }),
        }),
      ],
    ] as const) {
      expect(() =>
        planReportDocumentInstruction(TASK_ID, payload, NOW, getEvidence),
      ).toThrowError(/invalid report document (?:payload|evidence)/u);
    }
  });

  it("fails closed when evidence is unavailable, malformed, accessor-backed, or carries hidden authority", () => {
    const malformed = {
      ...evidence(EVIDENCE_REF_1),
      path: "/tmp/evidence.json",
    } as BaseReadEvidence;
    const accessor = { ...evidence(EVIDENCE_REF_1) };
    Object.defineProperty(accessor, "scope", {
      enumerable: true,
      get: () => evidence(EVIDENCE_REF_1).scope,
    });

    for (const getEvidence of [
      vi.fn(() => {
        throw new Error("not found");
      }),
      resolver({ [EVIDENCE_REF_1]: malformed }),
      resolver({
        [EVIDENCE_REF_1]: new Proxy(evidence(EVIDENCE_REF_1), {}),
      }),
      resolver({
        [EVIDENCE_REF_1]: accessor as BaseReadEvidence,
      }),
    ]) {
      expect(() =>
        planReportDocumentInstruction(TASK_ID, input(), NOW, getEvidence),
      ).toThrowError(/report document evidence/u);
    }
  });

  it("rejects inconsistent completeness evidence instead of inventing a full-data claim", () => {
    for (const completeness of [
      {
        complete: true,
        hasMore: true,
        truncatedBy: null,
        itemCount: 10,
      },
      {
        complete: true,
        hasMore: false,
        truncatedBy: "row_limit",
        itemCount: 10,
      },
      {
        complete: false,
        hasMore: false,
        truncatedBy: null,
        itemCount: 10,
      },
      {
        complete: false,
        hasMore: true,
        truncatedBy: "byte_limit",
        itemCount: -1,
      },
    ] as const) {
      expect(() =>
        planReportDocumentInstruction(
          TASK_ID,
          input(),
          NOW,
          resolver({
            [EVIDENCE_REF_1]: evidence(EVIDENCE_REF_1, {
              completeness: completeness as BaseReadEvidence["completeness"],
            }),
          }),
        ),
      ).toThrowError("invalid report document evidence");
    }
  });

  it("rejects a final UTF-8 XML document above the fixed byte ceiling", () => {
    expect(() =>
      planReportDocumentInstruction(
        TASK_ID,
        input({
          actions: Array.from({ length: 50 }, () => "界".repeat(2_000)),
        }),
        NOW,
        resolver({ [EVIDENCE_REF_1]: evidence(EVIDENCE_REF_1) }),
      ),
    ).toThrowError("report document XML exceeds byte limit");
  });

  it("rejects invalid task, clock, resolver, and text collection boundaries", () => {
    const getEvidence = resolver({
      [EVIDENCE_REF_1]: evidence(EVIDENCE_REF_1),
    });
    expect(() =>
      planReportDocumentInstruction(
        OTHER_TASK_ID.replace("29", "zz"),
        input(),
        NOW,
        getEvidence,
      ),
    ).toThrowError("invalid report document task");

    class ClockSubclass extends Date {}
    const decoratedClock = new Date(NOW);
    Object.defineProperty(decoratedClock, "extra", {
      enumerable: true,
      value: true,
    });
    for (const clock of [
      new Date("invalid"),
      new ClockSubclass(NOW),
      decoratedClock,
      new Proxy(new Date(NOW), {}),
    ]) {
      expect(() =>
        planReportDocumentInstruction(TASK_ID, input(), clock, getEvidence),
      ).toThrowError("invalid report document clock");
    }
    expect(() =>
      planReportDocumentInstruction(TASK_ID, input(), NOW, null as never),
    ).toThrowError("invalid report document evidence resolver");

    for (const value of [
      input({ conclusions: [] }),
      input({ conclusions: [""] }),
      input({ conclusions: [" leading"] }),
      input({ conclusions: ["line\nbreak"] }),
      input({ metrics: new Array(51).fill({ label: "x", value: "1" }) }),
      input({ risks: new Array(51).fill("risk") }),
      input({ actions: new Array(51).fill("action") }),
      input({
        evidenceRefs: new Array(21).fill(EVIDENCE_REF_1),
      }),
    ]) {
      expect(() =>
        planReportDocumentInstruction(TASK_ID, value, NOW, getEvidence),
      ).toThrowError("invalid report document payload");
    }
  });
});
