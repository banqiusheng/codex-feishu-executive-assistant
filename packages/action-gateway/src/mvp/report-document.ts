import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import { snapshotStrictJson, type JsonValue } from "../ipc/framing.js";
import type {
  BaseLiteAggregateOperator,
  BaseLiteFilterOperator,
  BaseQueryEvidenceScope,
  BaseReadEvidence,
} from "./base-reader.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const LABEL_SPOOFING_PATTERN = /[|｜\p{Cf}]/u;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const MAX_EVIDENCE_REFS = 20;
const MAX_CONCLUSIONS = 20;
const MAX_REPORT_ITEMS = 50;
const MAX_TEXT_LENGTH = 2_000;
const MAX_EVIDENCE_LABEL_LENGTH = 500;
const MAX_REPORT_XML_BYTES = 256 * 1024;
const AGGREGATE_OPERATORS = new Set<BaseLiteAggregateOperator>([
  "count",
  "sum",
  "avg",
  "min",
  "max",
]);
const FILTER_OPERATORS = new Set<BaseLiteFilterOperator>([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "not_in",
  "is_empty",
  "not_empty",
]);

type JsonObject = Readonly<Record<string, JsonValue>>;

export type ReportDocumentMetric = Readonly<{
  label: string;
  value: string;
  note?: string;
}>;

export type ReportDocumentPayload = Readonly<{
  evidenceRefs: readonly string[];
  conclusions: readonly string[];
  metrics: readonly ReportDocumentMetric[];
  risks: readonly string[];
  actions: readonly string[];
}>;

export type ReportDocumentInstructionPlan = Readonly<{
  taskId: string;
  capability: "document.report.create";
  identity: "user";
  itemKey: string;
  payload: Readonly<{
    docFormat: "xml";
    parentPosition: "my_library";
    title: string;
    content: string;
  }>;
  preview: Readonly<{
    action: "document.report.create";
    title: string;
    conclusions: readonly string[];
    evidenceCount: number;
    impact: "将在总裁个人云空间创建一份原生飞书云文档";
  }>;
}>;

export type ReportDocumentPublicResult = Readonly<{
  url: string;
  title: string;
  conclusions: readonly string[];
}>;

export type ReportEvidenceResolver = (
  taskId: string,
  evidenceRef: string,
) => BaseReadEvidence;

type EvidenceSnapshot = Readonly<{
  digest: string;
  scope: BaseReadEvidence["scope"];
  completeness: BaseReadEvidence["completeness"];
}>;

function invalidPayload(): never {
  throw new Error("invalid report document payload");
}

function invalidTask(): never {
  throw new Error("invalid report document task");
}

function invalidClock(): never {
  throw new Error("invalid report document clock");
}

function invalidEvidence(): never {
  throw new Error("invalid report document evidence");
}

function strictSnapshot(
  value: unknown,
  error: () => never = invalidPayload,
): JsonValue {
  try {
    return snapshotStrictJson(value);
  } catch {
    return error();
  }
}

function exactObject(
  value: JsonValue | undefined,
  required: readonly string[],
  optional: readonly string[] = [],
  error: () => never = invalidPayload,
): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return error();
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key)) ||
    keys.length < required.length ||
    keys.length > allowed.size
  ) {
    return error();
  }
  return value as JsonObject;
}

function safeText(
  value: JsonValue | undefined,
  maximum = MAX_TEXT_LENGTH,
  error: () => never = invalidPayload,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  ) {
    return error();
  }
  return value;
}

function evidenceText(value: JsonValue | undefined): string {
  const result = safeText(value, MAX_EVIDENCE_LABEL_LENGTH, invalidEvidence);
  if (LABEL_SPOOFING_PATTERN.test(result)) return invalidEvidence();
  return result;
}

function textArray(
  value: JsonValue | undefined,
  minimum: number,
  maximum: number,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    return invalidPayload();
  }
  return Object.freeze(value.map((entry) => safeText(entry)));
}

function parseMetric(value: JsonValue): ReportDocumentMetric {
  const metric = exactObject(value, ["label", "value"], ["note"]);
  return Object.freeze({
    label: safeText(metric.label),
    value: safeText(metric.value),
    ...(Object.hasOwn(metric, "note") ? { note: safeText(metric.note) } : {}),
  });
}

function parseInput(value: unknown): ReportDocumentPayload {
  const root = exactObject(strictSnapshot(value), [
    "evidenceRefs",
    "conclusions",
    "metrics",
    "risks",
    "actions",
  ]);
  if (
    !Array.isArray(root.evidenceRefs) ||
    root.evidenceRefs.length < 1 ||
    root.evidenceRefs.length > MAX_EVIDENCE_REFS
  ) {
    return invalidPayload();
  }
  const evidenceRefs = root.evidenceRefs.map((entry) => {
    if (typeof entry !== "string" || !UUID_PATTERN.test(entry)) {
      return invalidPayload();
    }
    return entry.toLowerCase();
  });
  if (new Set(evidenceRefs).size !== evidenceRefs.length) {
    return invalidPayload();
  }
  if (!Array.isArray(root.metrics) || root.metrics.length > MAX_REPORT_ITEMS) {
    return invalidPayload();
  }
  return Object.freeze({
    evidenceRefs: Object.freeze(evidenceRefs),
    conclusions: textArray(root.conclusions, 1, MAX_CONCLUSIONS),
    metrics: Object.freeze(root.metrics.map(parseMetric)),
    risks: textArray(root.risks, 0, MAX_REPORT_ITEMS),
    actions: textArray(root.actions, 0, MAX_REPORT_ITEMS),
  });
}

function exactDate(value: Date): Date {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    !utilTypes.isDate(value) ||
    Object.getPrototypeOf(value) !== Date.prototype ||
    Reflect.ownKeys(value).length !== 0
  ) {
    return invalidClock();
  }
  const milliseconds = Date.prototype.getTime.call(value);
  if (!Number.isFinite(milliseconds)) return invalidClock();
  return new Date(milliseconds);
}

function shanghaiDate(value: Date): string {
  const local = new Date(value.getTime() + SHANGHAI_OFFSET_MS);
  const year = local.getUTCFullYear();
  if (year < 0 || year > 9_999) return invalidClock();
  return `${String(year).padStart(4, "0")}-${String(
    local.getUTCMonth() + 1,
  ).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}`;
}

function evidenceStringArray(
  value: JsonValue | undefined,
  maximum: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    return invalidEvidence();
  }
  return Object.freeze(value.map(evidenceText));
}

function filterValue(
  value: JsonValue | undefined,
): string | number | readonly string[] | null {
  if (value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return invalidEvidence();
    return value;
  }
  if (typeof value === "string") return evidenceText(value);
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    return invalidEvidence();
  }
  const values = value.map(evidenceText);
  if (new Set(values).size !== values.length) return invalidEvidence();
  return Object.freeze(values);
}

function parseQuery(value: JsonValue): BaseQueryEvidenceScope {
  const root = exactObject(
    value,
    ["kind", "dimensions", "aggregates", "filter", "sort", "limit"],
    [],
    invalidEvidence,
  );
  if (
    (root.kind !== "AGGREGATE" && root.kind !== "DIMENSION_ROWS") ||
    !Array.isArray(root.aggregates) ||
    root.aggregates.length > 20 ||
    !Array.isArray(root.sort) ||
    root.sort.length > 10 ||
    typeof root.limit !== "number" ||
    !Number.isSafeInteger(root.limit) ||
    root.limit < 1 ||
    root.limit > 5_000
  ) {
    return invalidEvidence();
  }
  const dimensions = evidenceStringArray(root.dimensions, 20);
  const aggregates = Object.freeze(
    root.aggregates.map((entry) => {
      const aggregate = exactObject(
        entry,
        ["fieldName", "operator"],
        [],
        invalidEvidence,
      );
      if (
        typeof aggregate.operator !== "string" ||
        !AGGREGATE_OPERATORS.has(
          aggregate.operator as BaseLiteAggregateOperator,
        )
      ) {
        return invalidEvidence();
      }
      return Object.freeze({
        fieldName: evidenceText(aggregate.fieldName),
        operator: aggregate.operator as BaseLiteAggregateOperator,
      });
    }),
  );
  if (
    (root.kind === "AGGREGATE" && aggregates.length === 0) ||
    (root.kind === "DIMENSION_ROWS" && aggregates.length !== 0) ||
    (dimensions.length === 0 && aggregates.length === 0)
  ) {
    return invalidEvidence();
  }
  let filter: BaseQueryEvidenceScope["filter"] = null;
  if (root.filter !== null) {
    const filterRoot = exactObject(
      root.filter,
      ["conjunction", "conditions"],
      [],
      invalidEvidence,
    );
    if (
      (filterRoot.conjunction !== "and" && filterRoot.conjunction !== "or") ||
      !Array.isArray(filterRoot.conditions) ||
      filterRoot.conditions.length < 1 ||
      filterRoot.conditions.length > 64
    ) {
      return invalidEvidence();
    }
    filter = Object.freeze({
      conjunction: filterRoot.conjunction,
      conditions: Object.freeze(
        filterRoot.conditions.map((entry) => {
          const condition = exactObject(
            entry,
            ["fieldName", "operator", "value"],
            [],
            invalidEvidence,
          );
          if (
            typeof condition.operator !== "string" ||
            !FILTER_OPERATORS.has(condition.operator as BaseLiteFilterOperator)
          ) {
            return invalidEvidence();
          }
          const operator = condition.operator as BaseLiteFilterOperator;
          const valueSnapshot = filterValue(condition.value);
          if (
            ((operator === "is_empty" || operator === "not_empty") &&
              valueSnapshot !== null) ||
            ((operator === "in" || operator === "not_in") &&
              !Array.isArray(valueSnapshot)) ||
            (operator !== "is_empty" &&
              operator !== "not_empty" &&
              operator !== "in" &&
              operator !== "not_in" &&
              (valueSnapshot === null || Array.isArray(valueSnapshot)))
          ) {
            return invalidEvidence();
          }
          return Object.freeze({
            fieldName: evidenceText(condition.fieldName),
            operator,
            value: valueSnapshot,
          });
        }),
      ),
    });
  }
  const sort = Object.freeze(
    root.sort.map((entry) => {
      const item = exactObject(
        entry,
        ["fieldName", "aggregate", "direction"],
        [],
        invalidEvidence,
      );
      if (
        (item.aggregate !== null &&
          (typeof item.aggregate !== "string" ||
            !AGGREGATE_OPERATORS.has(
              item.aggregate as BaseLiteAggregateOperator,
            ))) ||
        (item.direction !== "asc" && item.direction !== "desc")
      ) {
        return invalidEvidence();
      }
      return Object.freeze({
        fieldName: evidenceText(item.fieldName),
        aggregate:
          item.aggregate === null
            ? null
            : (item.aggregate as BaseLiteAggregateOperator),
        direction: item.direction,
      });
    }),
  );
  return Object.freeze({
    kind: root.kind,
    dimensions,
    aggregates,
    filter,
    sort,
    limit: root.limit,
  });
}

function parseEvidence(value: unknown, expectedRef: string): EvidenceSnapshot {
  const root = exactObject(
    strictSnapshot(value, invalidEvidence),
    ["evidenceRef", "digest", "scope", "completeness"],
    [],
    invalidEvidence,
  );
  if (
    typeof root.evidenceRef !== "string" ||
    !UUID_PATTERN.test(root.evidenceRef) ||
    root.evidenceRef.toLowerCase() !== expectedRef ||
    typeof root.digest !== "string" ||
    !SHA256_PATTERN.test(root.digest)
  ) {
    return invalidEvidence();
  }
  const scopeRoot = exactObject(
    root.scope,
    ["resource", "fieldNames"],
    ["baseTitle", "tableName", "viewName", "query"],
    invalidEvidence,
  );
  if (scopeRoot.resource !== "base") return invalidEvidence();
  const scope = Object.freeze({
    resource: "base" as const,
    ...(Object.hasOwn(scopeRoot, "baseTitle")
      ? { baseTitle: evidenceText(scopeRoot.baseTitle) }
      : {}),
    ...(Object.hasOwn(scopeRoot, "tableName")
      ? { tableName: evidenceText(scopeRoot.tableName) }
      : {}),
    ...(Object.hasOwn(scopeRoot, "viewName")
      ? { viewName: evidenceText(scopeRoot.viewName) }
      : {}),
    fieldNames: evidenceStringArray(scopeRoot.fieldNames, 5_000),
    ...(Object.hasOwn(scopeRoot, "query")
      ? { query: parseQuery(scopeRoot.query as JsonValue) }
      : {}),
  });
  const completenessRoot = exactObject(
    root.completeness,
    ["complete", "hasMore", "truncatedBy", "itemCount"],
    [],
    invalidEvidence,
  );
  if (
    typeof completenessRoot.complete !== "boolean" ||
    typeof completenessRoot.hasMore !== "boolean" ||
    (completenessRoot.truncatedBy !== null &&
      completenessRoot.truncatedBy !== "row_limit" &&
      completenessRoot.truncatedBy !== "byte_limit") ||
    typeof completenessRoot.itemCount !== "number" ||
    !Number.isSafeInteger(completenessRoot.itemCount) ||
    completenessRoot.itemCount < 0 ||
    completenessRoot.itemCount > 100_000 ||
    (completenessRoot.complete &&
      (completenessRoot.hasMore || completenessRoot.truncatedBy !== null)) ||
    (!completenessRoot.complete && !completenessRoot.hasMore) ||
    (completenessRoot.truncatedBy !== null && !completenessRoot.hasMore)
  ) {
    return invalidEvidence();
  }
  return Object.freeze({
    digest: root.digest,
    scope,
    completeness: Object.freeze({
      complete: completenessRoot.complete,
      hasMore: completenessRoot.hasMore,
      truncatedBy: completenessRoot.truncatedBy,
      itemCount: completenessRoot.itemCount,
    }),
  });
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(
          (value as JsonObject)[key] as JsonValue,
        )}`,
    )
    .join(",")}}`;
}

function semanticEvidence(value: EvidenceSnapshot): JsonObject {
  return strictSnapshot({
    digest: value.digest,
    scope: value.scope,
    completeness: value.completeness,
  }) as JsonObject;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function paragraph(value: string): string {
  return `<paragraph>${xmlEscape(value)}</paragraph>`;
}

function section(title: string, content: string): string {
  return `<section><heading>${title}</heading>${content}</section>`;
}

function textItems(values: readonly string[]): string {
  return values.length === 0
    ? paragraph("暂无")
    : `<list>${values
        .map((value) => `<item>${xmlEscape(value)}</item>`)
        .join("")}</list>`;
}

function filterValueText(
  value: string | number | readonly string[] | null,
): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  return String(value);
}

function filterText(query: BaseQueryEvidenceScope | undefined): string {
  if (query?.filter === null || query?.filter === undefined) {
    return "证据未提供";
  }
  const conjunction = query.filter.conjunction === "and" ? " 且 " : " 或 ";
  return query.filter.conditions
    .map(
      (condition) =>
        `${condition.fieldName} ${condition.operator} ${filterValueText(
          condition.value,
        )}`,
    )
    .join(conjunction);
}

function aggregateText(query: BaseQueryEvidenceScope | undefined): string {
  if (query === undefined || query.aggregates.length === 0) {
    return "证据未提供";
  }
  return query.aggregates
    .map((aggregate) => `${aggregate.operator}(${aggregate.fieldName})`)
    .join("、");
}

function rangeText(evidence: EvidenceSnapshot): string {
  const fields =
    evidence.scope.fieldNames.length === 0
      ? "证据未提供"
      : evidence.scope.fieldNames.join("、");
  if (evidence.scope.query === undefined) return `字段=${fields}`;
  const dimensions =
    evidence.scope.query.dimensions.length === 0
      ? "无"
      : evidence.scope.query.dimensions.join("、");
  return `字段=${fields}；查询维度=${dimensions}；查询上限=${evidence.scope.query.limit}`;
}

function completenessText(
  completeness: BaseReadEvidence["completeness"],
): string {
  if (completeness.complete) {
    return `完整性：完整；结果项数：${completeness.itemCount}`;
  }
  const truncation =
    completeness.truncatedBy === "row_limit"
      ? "行数上限"
      : completeness.truncatedBy === "byte_limit"
        ? "字节上限"
        : "上游仍有更多数据";
  return `完整性：不完整；结果项数：${completeness.itemCount}；仍有更多数据：是；截断原因：${truncation}；不得视为全量`;
}

function sourceXml(evidence: EvidenceSnapshot): string {
  const query = evidence.scope.query;
  return `<source>${[
    `Base：${evidence.scope.baseTitle ?? "证据未提供"}`,
    `数据表：${evidence.scope.tableName ?? "证据未提供"}`,
    `视图：${evidence.scope.viewName ?? "未指定"}`,
    `数据范围：${rangeText(evidence)}`,
    `筛选条件：${filterText(query)}`,
    `聚合口径：${aggregateText(query)}`,
    completenessText(evidence.completeness),
  ]
    .map(paragraph)
    .join("")}</source>`;
}

function metricsXml(metrics: readonly ReportDocumentMetric[]): string {
  if (metrics.length === 0) return paragraph("暂无");
  return `<metrics>${metrics
    .map(
      (metric) =>
        `<metric><label>${xmlEscape(metric.label)}</label><value>${xmlEscape(
          metric.value,
        )}</value>${
          metric.note === undefined
            ? ""
            : `<note>${xmlEscape(metric.note)}</note>`
        }</metric>`,
    )
    .join("")}</metrics>`;
}

function reportXml(
  title: string,
  input: ReportDocumentPayload,
  evidences: readonly EvidenceSnapshot[],
): string {
  const incompleteWarning = evidences.some(
    (evidence) => !evidence.completeness.complete,
  )
    ? ["当前证据不完整，报告结论不得视为全量结论"]
    : [];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<doc>",
    `<title>${xmlEscape(title)}</title>`,
    section("核心结论", textItems(input.conclusions)),
    section("关键数据", metricsXml(input.metrics)),
    section(
      "异常与风险",
      textItems(Object.freeze([...input.risks, ...incompleteWarning])),
    ),
    section("建议动作", textItems(input.actions)),
    section(
      "数据来源与口径",
      evidences.map((evidence) => sourceXml(evidence)).join(""),
    ),
    "</doc>",
  ].join("");
}

function itemKey(
  payload: ReportDocumentInstructionPlan["payload"],
  evidences: readonly EvidenceSnapshot[],
): string {
  const semantic = strictSnapshot({
    payload,
    evidence: evidences.map(semanticEvidence),
  });
  return `document-report:sha256:${createHash("sha256")
    .update(canonicalJson(semantic), "utf8")
    .digest("hex")}`;
}

export function planReportDocumentInstruction(
  taskIdValue: string,
  value: unknown,
  nowValue: Date,
  getEvidenceValue: ReportEvidenceResolver,
): ReportDocumentInstructionPlan {
  if (typeof taskIdValue !== "string" || !UUID_PATTERN.test(taskIdValue)) {
    return invalidTask();
  }
  const taskId = taskIdValue.toLowerCase();
  const now = exactDate(nowValue);
  const input = parseInput(value);
  if (typeof getEvidenceValue !== "function") {
    throw new Error("invalid report document evidence resolver");
  }
  const evidences = input.evidenceRefs.map((evidenceRef) => {
    let value: unknown;
    try {
      value = getEvidenceValue(taskId, evidenceRef);
    } catch {
      throw new Error("report document evidence is unavailable");
    }
    return parseEvidence(value, evidenceRef);
  });
  const baseTitles = new Set(
    evidences.flatMap((evidence) =>
      evidence.scope.baseTitle === undefined ? [] : [evidence.scope.baseTitle],
    ),
  );
  if (baseTitles.size !== 1) return invalidEvidence();
  const baseTitle = [...baseTitles][0] as string;
  const semanticPairs = evidences
    .map((evidence) => ({
      evidence,
      semantic: canonicalJson(semanticEvidence(evidence)),
    }))
    .sort((left, right) => left.semantic.localeCompare(right.semantic));
  const sortedEvidence = Object.freeze(
    semanticPairs.map(({ evidence }) => evidence),
  );
  const title = `${baseTitle}分析报告｜${shanghaiDate(now)}`;
  const content = reportXml(title, input, sortedEvidence);
  if (Buffer.byteLength(content, "utf8") > MAX_REPORT_XML_BYTES) {
    throw new Error("report document XML exceeds byte limit");
  }
  const payload = Object.freeze({
    docFormat: "xml" as const,
    parentPosition: "my_library" as const,
    title,
    content,
  });
  const preview = Object.freeze({
    action: "document.report.create" as const,
    title,
    conclusions: Object.freeze(input.conclusions.slice(0, 3)),
    evidenceCount: input.evidenceRefs.length,
    impact: "将在总裁个人云空间创建一份原生飞书云文档" as const,
  });
  return Object.freeze({
    taskId,
    capability: "document.report.create" as const,
    identity: "user" as const,
    itemKey: itemKey(payload, sortedEvidence),
    payload,
    preview,
  });
}
