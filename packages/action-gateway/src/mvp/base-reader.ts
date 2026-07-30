import { createHash, randomUUID } from "node:crypto";
import type {
  ActionJsonValue,
  ClarificationSelection,
  ClarificationValueValidator,
} from "@executive-assistant/job-store";

import { snapshotStrictJson, type JsonValue } from "../ipc/framing.js";
import type { MvpLarkCliRunner } from "./registry.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLI_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const LABEL_SPOOFING_PATTERN = /[|｜\p{Cf}]/u;
const MAX_SCHEMA_ITEMS = 5_000;
const MAX_CLARIFICATION_OPTIONS = 20;
const MAX_RECORD_ROWS = 2_000;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_QUERY_FIELDS = 20;
const MAX_QUERY_SORTS = 10;
const MAX_QUERY_FILTER_DEPTH = 4;
const MAX_QUERY_FILTER_NODES = 64;
const MAX_QUERY_DSL_BYTES = 60 * 1024;
const MAX_QUERY_RESULT_BYTES = 8 * 1024 * 1024;
const LITE_AGGREGATE_OPERATORS = new Set<BaseLiteAggregateOperator>([
  "count",
  "sum",
  "avg",
  "min",
  "max",
]);
const LITE_FILTER_OPERATORS = new Set<BaseLiteFilterOperator>([
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

export type BaseResolvePayload =
  | Readonly<{ source: "url"; url: string }>
  | Readonly<{ source: "title"; title: string }>
  | Readonly<{ source: "selection"; selectionRef: string }>;

export type BaseSchemaPayload = Readonly<{
  baseRef: string;
  tableRef?: string;
  tableSelectionRef?: string;
}>;

export type BaseRecordsPayload = Readonly<{
  tableRef: string;
  fieldRefs: readonly string[];
  viewRef: string | null;
}>;

export type BaseLiteAggregateOperator = "count" | "sum" | "avg" | "min" | "max";

export type BaseLiteFilterOperator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "not_in"
  | "is_empty"
  | "not_empty";

export type BaseLiteFilter =
  | Readonly<{
      kind: "condition";
      fieldRef: string;
      operator: BaseLiteFilterOperator;
      value: string | number | readonly string[] | null;
    }>
  | Readonly<{
      kind: "group";
      conjunction: "and" | "or";
      clauses: readonly BaseLiteFilter[];
    }>;

export type BaseDataQueryPayload = Readonly<{
  baseRef: string;
  tableRef: string;
  dimensionFieldRefs: readonly string[];
  aggregates: readonly Readonly<{
    fieldRef: string;
    operator: BaseLiteAggregateOperator;
  }>[];
  filter: BaseLiteFilter | null;
  sort: readonly Readonly<{
    fieldRef: string;
    aggregate: BaseLiteAggregateOperator | null;
    direction: "asc" | "desc";
  }>[];
  limit: number;
}>;

export type BaseQueryEvidenceScope = Readonly<{
  kind: "AGGREGATE" | "DIMENSION_ROWS";
  dimensions: readonly string[];
  aggregates: readonly Readonly<{
    fieldName: string;
    operator: BaseLiteAggregateOperator;
  }>[];
  filter: null | Readonly<{
    conjunction: "and" | "or";
    conditions: readonly Readonly<{
      fieldName: string;
      operator: BaseLiteFilterOperator;
      value: string | number | readonly string[] | null;
    }>[];
  }>;
  sort: readonly Readonly<{
    fieldName: string;
    aggregate: BaseLiteAggregateOperator | null;
    direction: "asc" | "desc";
  }>[];
  limit: number;
}>;

export type BaseSelectionValue = Readonly<{
  version: 1;
  kind: "base";
  baseToken: string;
  title: string;
}>;

export type TableSelectionValue = Readonly<{
  version: 1;
  kind: "table";
  baseToken: string;
  tableId: string;
  name: string;
}>;

export type BaseClarificationValue = BaseSelectionValue | TableSelectionValue;

export type BaseClarificationWriter = Readonly<{
  writeBaseClarification(input: {
    taskId: string;
    kind: "base" | "table";
    groupLabel: string;
    candidates: readonly Readonly<{
      value: BaseClarificationValue;
      displayLabel: string;
    }>[];
    now: Date;
  }):
    | Readonly<{
        groupId: string;
        options: readonly Readonly<{
          ordinal: number;
          optionRef: string;
          displayLabel: string;
        }>[];
      }>
    | Promise<
        Readonly<{
          groupId: string;
          options: readonly Readonly<{
            ordinal: number;
            optionRef: string;
            displayLabel: string;
          }>[];
        }>
      >;
}>;

export type BaseClarificationConsumer = Readonly<{
  consumeClarificationsForTaskValidated(
    taskId: string,
    optionRefs: readonly string[],
    expectedKind: "base" | "table",
    now: Date,
    assertValue: ClarificationValueValidator,
  ): readonly ClarificationSelection[];
}>;

export type BaseReadEvidence = Readonly<{
  evidenceRef: string;
  digest: string;
  scope: Readonly<{
    resource: "base";
    baseTitle?: string;
    tableName?: string;
    viewName?: string;
    fieldNames: readonly string[];
    query?: BaseQueryEvidenceScope;
  }>;
  completeness: Readonly<{
    complete: boolean;
    hasMore: boolean;
    truncatedBy: null | "row_limit" | "byte_limit";
    itemCount: number;
  }>;
}>;

export type BaseResolveResult =
  | Readonly<{
      status: "RESOLVED";
      resource: Readonly<{
        baseRef: string;
        title?: string;
        tableRef?: string;
        viewRef?: string;
        recordRef?: string;
      }>;
      evidence: BaseReadEvidence;
    }>
  | Readonly<{
      status: "NEEDS_CLARIFICATION";
      groupRef: string;
      label: string;
      candidates: readonly Readonly<{
        selectionRef: string;
        label: string;
        title: string;
        ownerName?: string;
        updateTime?: string;
      }>[];
    }>
  | Readonly<{ status: "BLOCKED_SCOPE"; scope: "wiki:node:retrieve" }>;

export type BaseSchemaResult =
  | Readonly<{
      status: "RESOLVED";
      table: Readonly<{ tableRef: string; name: string }>;
      fields: readonly Readonly<{
        fieldRef: string;
        name: string;
        type: string;
      }>[];
      views: readonly Readonly<{
        viewRef: string;
        name: string;
        type: string;
      }>[];
      evidence: BaseReadEvidence;
    }>
  | Readonly<{
      status: "NEEDS_CLARIFICATION";
      groupRef: string;
      label: "请选择数据表";
      candidates: readonly Readonly<{
        selectionRef: string;
        label: string;
        name: string;
      }>[];
    }>
  | Readonly<{ status: "NOT_FOUND" }>;

export type BaseRecordsResult = Readonly<{
  status: "RESOLVED";
  table: Readonly<{ tableRef: string; name: string }>;
  columns: readonly Readonly<{
    fieldRef: string;
    name: string;
    type: string;
  }>[];
  rows: readonly Readonly<{ values: readonly JsonValue[] }>[];
  evidence: BaseReadEvidence;
}>;

export type BaseDataQueryResult = Readonly<{
  status: "RESOLVED";
  kind: "AGGREGATE" | "DIMENSION_ROWS";
  table: Readonly<{ tableRef: string; name: string }>;
  columns: readonly (
    | Readonly<{
        kind: "dimension";
        fieldRef: string;
        name: string;
        type: string;
      }>
    | Readonly<{
        kind: "aggregate";
        fieldRef: string;
        name: string;
        type: string;
        operator: BaseLiteAggregateOperator;
      }>
  )[];
  rows: readonly Readonly<{ values: readonly JsonValue[] }>[];
  evidence: BaseReadEvidence;
}>;

export type BaseReader = Readonly<{
  resolve(
    taskId: string,
    payload: BaseResolvePayload,
    now: Date,
  ): Promise<BaseResolveResult>;
  readSchema(
    taskId: string,
    payload: BaseSchemaPayload,
    now: Date,
  ): Promise<BaseSchemaResult>;
  readRecords(
    taskId: string,
    payload: BaseRecordsPayload,
    now: Date,
  ): Promise<BaseRecordsResult>;
  queryData(
    taskId: string,
    payload: BaseDataQueryPayload,
    now: Date,
  ): Promise<BaseDataQueryResult>;
  getReadEvidence(taskId: string, evidenceRef: string): BaseReadEvidence;
}>;

export type BaseReaderDependencies = Readonly<{
  runner: Pick<MvpLarkCliRunner, "runUser">;
  clarificationWriter?: BaseClarificationWriter;
  clarificationConsumer?: BaseClarificationConsumer;
  randomUuid?: () => string;
}>;

type BaseHandle = Readonly<{ baseToken: string; title?: string }>;
type TableHandle =
  | Readonly<{
      verified: false;
      baseToken: string;
      tableId: string;
    }>
  | Readonly<{
      verified: true;
      baseToken: string;
      tableId: string;
      name: string;
    }>;
type FieldHandle = Readonly<{
  baseToken: string;
  tableId: string;
  fieldId: string;
  name: string;
  type: string;
}>;
type ViewHandle =
  | Readonly<{
      verified: false;
      baseToken: string;
      tableId: string;
      viewId: string;
    }>
  | Readonly<{
      verified: true;
      baseToken: string;
      tableId: string;
      viewId: string;
      name: string;
      type: string;
    }>;
type RecordHandle = Readonly<{
  baseToken: string;
  tableId: string;
  recordId: string;
}>;

type ResolvedCliResource = Readonly<{
  baseToken: string;
  title?: string;
  tableId?: string;
  viewId?: string;
  recordId?: string;
}>;

type TitleCandidate = Readonly<{
  baseToken: string;
  title: string;
  ownerName: string;
  updateTime: string;
}>;

type TableItem = Readonly<{ id: string; name: string }>;
type FieldItem = Readonly<{ id: string; name: string; type: string }>;
type ViewItem = Readonly<{ id: string; name: string; type: string }>;
type RecordPage = Readonly<{
  fields: readonly string[];
  fieldIds?: readonly string[];
  recordIds: readonly string[];
  rows: readonly (readonly JsonValue[])[];
  total?: number;
  hasMore?: boolean;
}>;
type QueryColumn =
  | Readonly<{
      kind: "dimension";
      alias: string;
      fieldRef: string;
      field: FieldHandle;
    }>
  | Readonly<{
      kind: "aggregate";
      alias: string;
      fieldRef: string;
      field: FieldHandle;
      operator: BaseLiteAggregateOperator;
    }>;
type QueryFilterCondition = Readonly<{
  fieldRef: string;
  field: FieldHandle;
  operator: BaseLiteFilterOperator;
  value: string | number | readonly string[] | null;
  officialOperator:
    | "is"
    | "isNot"
    | "isGreater"
    | "isGreaterEqual"
    | "isLess"
    | "isLessEqual"
    | "contains"
    | "doesNotContain"
    | "isEmpty"
    | "isNotEmpty";
  officialValue: readonly string[];
}>;
type CompiledQuery = Readonly<{
  dsl: JsonObject;
  columns: readonly QueryColumn[];
  scope: BaseQueryEvidenceScope;
  fieldNames: readonly string[];
}>;

function invalidPayload(
  kind: "resolve" | "schema" | "records" | "query",
): never {
  throw new Error(`invalid Base ${kind} payload`);
}

function strictObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
  error: () => never,
): JsonObject {
  const snapshot = snapshotStrictJson(value);
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    return error();
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(snapshot);
  if (
    required.some((key) => !Object.hasOwn(snapshot, key)) ||
    keys.some((key) => !allowed.has(key)) ||
    keys.length < required.length ||
    keys.length > allowed.size
  ) {
    return error();
  }
  return snapshot as JsonObject;
}

function safeString(
  value: JsonValue | undefined,
  maximum: number,
  error: () => never,
  allowEmpty = false,
): string {
  if (allowEmpty && value === "") return "";
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    LABEL_SPOOFING_PATTERN.test(value) ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  ) {
    return error();
  }
  return value;
}

function uuid(value: JsonValue | undefined, error: () => never): string {
  const result = safeString(value, 36, error);
  if (!UUID_PATTERN.test(result)) return error();
  return result;
}

function cliIdentifier(
  value: JsonValue | undefined,
  error: () => never,
): string {
  const result = safeString(value, 256, error);
  if (!CLI_IDENTIFIER_PATTERN.test(result)) return error();
  return result;
}

function snapshotNow(value: Date): Date {
  if (
    !(value instanceof Date) ||
    Object.getPrototypeOf(value) !== Date.prototype ||
    Reflect.ownKeys(value).length !== 0
  ) {
    throw new Error("invalid Base reader clock");
  }
  const milliseconds = Date.prototype.getTime.call(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error("invalid Base reader clock");
  }
  return new Date(milliseconds);
}

function assertTaskId(value: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return invalidPayload("resolve");
  }
  return value;
}

function trustedBaseUrl(value: JsonValue | undefined, allowWiki: boolean): URL {
  const fail = (): never => invalidPayload("resolve");
  const text = safeString(value, 2_048, fail);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return fail();
  }
  const hostname = parsed.hostname.toLocaleLowerCase("en-US");
  const trustedHost =
    hostname === "feishu.cn" ||
    hostname.endsWith(".feishu.cn") ||
    hostname === "larksuite.com" ||
    hostname.endsWith(".larksuite.com") ||
    hostname === "larkoffice.com" ||
    hostname.endsWith(".larkoffice.com");
  const supportedPath = allowWiki
    ? /^\/(?:base|record|wiki)\/[^/]+\/?$/u
    : /^\/(?:base|record)\/[^/]+\/?$/u;
  if (
    parsed.protocol !== "https:" ||
    !trustedHost ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.hash !== "" ||
    !supportedPath.test(parsed.pathname)
  ) {
    return fail();
  }
  return parsed;
}

export function parseBaseResolvePayload(value: unknown): BaseResolvePayload {
  const fail = (): never => invalidPayload("resolve");
  const root = strictObject(
    value,
    ["source"],
    ["url", "title", "selectionRef"],
    fail,
  );
  if (root.source === "url") {
    const input = strictObject(value, ["source", "url"], [], fail);
    const parsed = trustedBaseUrl(input.url, true);
    return Object.freeze({ source: "url", url: parsed.toString() });
  }
  if (root.source === "title") {
    const input = strictObject(value, ["source", "title"], [], fail);
    const title = safeString(input.title, 90, fail);
    if ([...title].length > 30) return fail();
    return Object.freeze({ source: "title", title });
  }
  if (root.source === "selection") {
    const input = strictObject(value, ["source", "selectionRef"], [], fail);
    return Object.freeze({
      source: "selection",
      selectionRef: uuid(input.selectionRef, fail),
    });
  }
  return fail();
}

export function parseBaseSchemaPayload(value: unknown): BaseSchemaPayload {
  const fail = (): never => invalidPayload("schema");
  const input = strictObject(
    value,
    ["baseRef"],
    ["tableRef", "tableSelectionRef"],
    fail,
  );
  const tableRef = Object.hasOwn(input, "tableRef")
    ? uuid(input.tableRef, fail)
    : undefined;
  const tableSelectionRef = Object.hasOwn(input, "tableSelectionRef")
    ? uuid(input.tableSelectionRef, fail)
    : undefined;
  if (tableRef !== undefined && tableSelectionRef !== undefined) return fail();
  return Object.freeze({
    baseRef: uuid(input.baseRef, fail),
    ...(tableRef === undefined ? {} : { tableRef }),
    ...(tableSelectionRef === undefined ? {} : { tableSelectionRef }),
  });
}

export function parseBaseRecordsPayload(value: unknown): BaseRecordsPayload {
  const fail = (): never => invalidPayload("records");
  const input = strictObject(
    value,
    ["tableRef", "fieldRefs", "viewRef"],
    [],
    fail,
  );
  if (
    !Array.isArray(input.fieldRefs) ||
    input.fieldRefs.length < 1 ||
    input.fieldRefs.length > 200 ||
    (input.viewRef !== null && typeof input.viewRef !== "string")
  ) {
    return fail();
  }
  const fieldRefs = input.fieldRefs.map((entry) => uuid(entry, fail));
  if (new Set(fieldRefs).size !== fieldRefs.length) return fail();
  return Object.freeze({
    tableRef: uuid(input.tableRef, fail),
    fieldRefs: Object.freeze(fieldRefs),
    viewRef: input.viewRef === null ? null : uuid(input.viewRef, fail),
  });
}

function queryString(value: JsonValue | undefined, error: () => never): string {
  return safeString(value, 500, error);
}

function parseLiteFilter(
  value: JsonValue,
  depth: number,
  state: { nodes: number },
  error: () => never,
): BaseLiteFilter {
  state.nodes += 1;
  if (depth > MAX_QUERY_FILTER_DEPTH || state.nodes > MAX_QUERY_FILTER_NODES) {
    return error();
  }
  const root = strictObject(
    value,
    ["kind"],
    ["fieldRef", "operator", "value", "conjunction", "clauses"],
    error,
  );
  if (root.kind === "condition") {
    const condition = strictObject(
      value,
      ["kind", "fieldRef", "operator", "value"],
      [],
      error,
    );
    const operator = queryString(
      condition.operator,
      error,
    ) as BaseLiteFilterOperator;
    if (!LITE_FILTER_OPERATORS.has(operator)) return error();
    let filterValue: string | number | readonly string[] | null;
    if (operator === "is_empty" || operator === "not_empty") {
      if (condition.value !== null) return error();
      filterValue = null;
    } else if (operator === "in" || operator === "not_in") {
      if (
        !Array.isArray(condition.value) ||
        condition.value.length < 1 ||
        condition.value.length > 20
      ) {
        return error();
      }
      const values = condition.value.map((entry) => queryString(entry, error));
      if (new Set(values).size !== values.length) return error();
      filterValue = Object.freeze(values);
    } else if (typeof condition.value === "number") {
      if (!Number.isFinite(condition.value)) return error();
      filterValue = condition.value;
    } else {
      filterValue = queryString(condition.value, error);
    }
    return Object.freeze({
      kind: "condition",
      fieldRef: uuid(condition.fieldRef, error),
      operator,
      value: filterValue,
    });
  }
  if (root.kind === "group") {
    const group = strictObject(
      value,
      ["kind", "conjunction", "clauses"],
      [],
      error,
    );
    if (
      (group.conjunction !== "and" && group.conjunction !== "or") ||
      !Array.isArray(group.clauses) ||
      group.clauses.length < 1 ||
      group.clauses.length > MAX_QUERY_FILTER_NODES
    ) {
      return error();
    }
    return Object.freeze({
      kind: "group",
      conjunction: group.conjunction,
      clauses: Object.freeze(
        group.clauses.map((clause) =>
          parseLiteFilter(clause, depth + 1, state, error),
        ),
      ),
    });
  }
  return error();
}

export function parseBaseDataQueryPayload(
  value: unknown,
): BaseDataQueryPayload {
  const fail = (): never => invalidPayload("query");
  const snapshot = snapshotStrictJson(value);
  if (
    Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_QUERY_DSL_BYTES
  ) {
    return fail();
  }
  const input = strictObject(
    snapshot,
    [
      "baseRef",
      "tableRef",
      "dimensionFieldRefs",
      "aggregates",
      "filter",
      "sort",
      "limit",
    ],
    [],
    fail,
  );
  if (
    !Array.isArray(input.dimensionFieldRefs) ||
    input.dimensionFieldRefs.length > MAX_QUERY_FIELDS ||
    !Array.isArray(input.aggregates) ||
    input.aggregates.length > MAX_QUERY_FIELDS ||
    !Array.isArray(input.sort) ||
    input.sort.length > MAX_QUERY_SORTS ||
    typeof input.limit !== "number" ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 5_000
  ) {
    return fail();
  }
  const dimensionFieldRefs = input.dimensionFieldRefs.map((entry) =>
    uuid(entry, fail),
  );
  if (new Set(dimensionFieldRefs).size !== dimensionFieldRefs.length) {
    return fail();
  }
  const aggregateKeys = new Set<string>();
  const aggregates = input.aggregates.map((entry) => {
    const aggregate = strictObject(entry, ["fieldRef", "operator"], [], fail);
    const operator = queryString(
      aggregate.operator,
      fail,
    ) as BaseLiteAggregateOperator;
    if (!LITE_AGGREGATE_OPERATORS.has(operator)) return fail();
    const fieldRef = uuid(aggregate.fieldRef, fail);
    const key = `${fieldRef}:${operator}`;
    if (aggregateKeys.has(key)) return fail();
    aggregateKeys.add(key);
    return Object.freeze({ fieldRef, operator });
  });
  if (dimensionFieldRefs.length === 0 && aggregates.length === 0) return fail();
  const filter =
    input.filter === null
      ? null
      : parseLiteFilter(input.filter ?? fail(), 1, { nodes: 0 }, fail);
  const sortKeys = new Set<string>();
  const sort = input.sort.map((entry) => {
    const item = strictObject(
      entry,
      ["fieldRef", "aggregate", "direction"],
      [],
      fail,
    );
    const fieldRef = uuid(item.fieldRef, fail);
    const aggregate =
      item.aggregate === null
        ? null
        : (queryString(item.aggregate, fail) as BaseLiteAggregateOperator);
    if (
      (aggregate !== null && !LITE_AGGREGATE_OPERATORS.has(aggregate)) ||
      (item.direction !== "asc" && item.direction !== "desc")
    ) {
      return fail();
    }
    const key = `${fieldRef}:${aggregate ?? "dimension"}`;
    if (sortKeys.has(key)) return fail();
    sortKeys.add(key);
    return Object.freeze({
      fieldRef,
      aggregate,
      direction: item.direction,
    });
  });
  return Object.freeze({
    baseRef: uuid(input.baseRef, fail),
    tableRef: uuid(input.tableRef, fail),
    dimensionFieldRefs: Object.freeze(dimensionFieldRefs),
    aggregates: Object.freeze(aggregates),
    filter,
    sort: Object.freeze(sort),
    limit: input.limit,
  });
}

function invalidCliResult(): never {
  throw new Error("invalid Base CLI result");
}

function cliObject(
  value: JsonValue,
  required: readonly string[],
  optional: readonly string[] = [],
): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidCliResult();
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key)) ||
    keys.length < required.length ||
    keys.length > allowed.size
  ) {
    return invalidCliResult();
  }
  return value as JsonObject;
}

function cliEnvelopeData(value: JsonValue): JsonObject {
  const snapshot = snapshotStrictJson(value);
  const root = cliObject(snapshot, ["ok", "identity", "data"]);
  if (root.ok !== true || root.identity !== "user") {
    return invalidCliResult();
  }
  if (
    root.data === null ||
    typeof root.data !== "object" ||
    Array.isArray(root.data)
  ) {
    return invalidCliResult();
  }
  return root.data as JsonObject;
}

function cliText(
  value: JsonValue | undefined,
  maximum: number,
  allowEmpty = false,
): string {
  return safeString(value, maximum, invalidCliResult, allowEmpty);
}

function cliId(value: JsonValue | undefined): string {
  return cliIdentifier(value, invalidCliResult);
}

function hintObject(value: JsonValue | undefined): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidCliResult();
  }
}

function parseUrlResolveResult(value: JsonValue): ResolvedCliResource {
  const data = cliEnvelopeData(value);
  if (data.input_type === "base_url") {
    const input = cliObject(
      data,
      ["input_type", "resource_type", "base_token", "hint"],
      ["table_id", "view_id", "record_id"],
    );
    if (input.resource_type !== "bitable") return invalidCliResult();
    hintObject(input.hint);
    const tableId = Object.hasOwn(input, "table_id")
      ? cliId(input.table_id)
      : undefined;
    const viewId = Object.hasOwn(input, "view_id")
      ? cliId(input.view_id)
      : undefined;
    const recordId = Object.hasOwn(input, "record_id")
      ? cliId(input.record_id)
      : undefined;
    if (
      (viewId !== undefined || recordId !== undefined) &&
      tableId === undefined
    ) {
      return invalidCliResult();
    }
    return Object.freeze({
      baseToken: cliId(input.base_token),
      ...(tableId === undefined ? {} : { tableId }),
      ...(viewId === undefined ? {} : { viewId }),
      ...(recordId === undefined ? {} : { recordId }),
    });
  }
  if (data.input_type === "record_share_url") {
    const input = cliObject(data, [
      "input_type",
      "resource_type",
      "record_share_token",
      "base_token",
      "table_id",
      "record_id",
      "hint",
    ]);
    if (input.resource_type !== "bitable") return invalidCliResult();
    cliId(input.record_share_token);
    hintObject(input.hint);
    return Object.freeze({
      baseToken: cliId(input.base_token),
      tableId: cliId(input.table_id),
      recordId: cliId(input.record_id),
    });
  }
  return invalidCliResult();
}

function parseBaseAppResult(
  value: JsonValue,
  expectedBaseToken: string,
): string {
  const data = cliEnvelopeData(value);
  const input = cliObject(data, ["base"]);
  const base = cliObject(
    input.base as JsonValue,
    ["name"],
    ["base_token", "app_token"],
  );
  const hasBaseToken = Object.hasOwn(base, "base_token");
  const hasAppToken = Object.hasOwn(base, "app_token");
  if (hasBaseToken === hasAppToken) return invalidCliResult();
  const returnedToken = cliId(hasBaseToken ? base.base_token : base.app_token);
  if (returnedToken !== expectedBaseToken) return invalidCliResult();
  return cliText(base.name, 500);
}

function titleCandidate(value: JsonValue): TitleCandidate {
  const row = cliObject(value, [
    "title",
    "base_token",
    "url",
    "owner_name",
    "update_time",
  ]);
  cliText(row.url, 2_048);
  return Object.freeze({
    baseToken: cliId(row.base_token),
    title: cliText(row.title, 500),
    ownerName: cliText(row.owner_name, 500, true),
    updateTime: cliText(row.update_time, 100, true),
  });
}

function parseTitleResolveResult(
  value: JsonValue,
): ResolvedCliResource | readonly TitleCandidate[] {
  const data = cliEnvelopeData(value);
  if (data.input_type !== "title_query" || data.resource_type !== "bitable") {
    return invalidCliResult();
  }
  if (Object.hasOwn(data, "candidates")) {
    const input = cliObject(data, [
      "input_type",
      "resource_type",
      "candidates",
      "hint",
    ]);
    hintObject(input.hint);
    if (
      !Array.isArray(input.candidates) ||
      input.candidates.length < 2 ||
      input.candidates.length > 5
    ) {
      return invalidCliResult();
    }
    const candidates = input.candidates.map(titleCandidate);
    if (
      new Set(candidates.map((candidate) => candidate.baseToken)).size !==
      candidates.length
    ) {
      return invalidCliResult();
    }
    return Object.freeze(candidates);
  }
  const input = cliObject(data, [
    "input_type",
    "resource_type",
    "title",
    "base_token",
    "url",
    "owner_name",
    "update_time",
    "hint",
  ]);
  hintObject(input.hint);
  cliText(input.url, 2_048);
  cliText(input.owner_name, 500, true);
  cliText(input.update_time, 100, true);
  return Object.freeze({
    baseToken: cliId(input.base_token),
    title: cliText(input.title, 500),
  });
}

function isResolvedCliResource(
  value: ResolvedCliResource | readonly TitleCandidate[],
): value is ResolvedCliResource {
  return !Array.isArray(value);
}

function nonNegativeInteger(value: JsonValue | undefined): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 1_000_000_000
  ) {
    return invalidCliResult();
  }
  return value;
}

function sourceObject(value: JsonValue): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidCliResult();
  }
  return value as JsonObject;
}

function parseTablePage(value: JsonValue, limit: number) {
  const data = cliEnvelopeData(value);
  const input = cliObject(data, ["tables", "total"]);
  if (!Array.isArray(input.tables) || input.tables.length > limit) {
    return invalidCliResult();
  }
  const items = input.tables.map((entry): TableItem => {
    const row = sourceObject(entry);
    return Object.freeze({
      id: cliId(row.id),
      name: cliText(row.name, 500),
    });
  });
  const total = nonNegativeInteger(input.total);
  if (total < items.length) return invalidCliResult();
  return Object.freeze({ items: Object.freeze(items), total });
}

function sourceType(value: JsonValue | undefined): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return cliText(value, 100);
}

function parseFieldPage(value: JsonValue, limit: number) {
  const data = cliEnvelopeData(value);
  const input = cliObject(data, ["fields", "total"]);
  if (!Array.isArray(input.fields) || input.fields.length > limit) {
    return invalidCliResult();
  }
  const items = input.fields.map((entry): FieldItem => {
    const row = sourceObject(entry);
    return Object.freeze({
      id: cliId(row.id),
      name: cliText(row.name, 500),
      type: sourceType(row.type),
    });
  });
  const total = nonNegativeInteger(input.total);
  if (total < items.length) return invalidCliResult();
  return Object.freeze({ items: Object.freeze(items), total });
}

function parseViewPage(value: JsonValue, limit: number) {
  const data = cliEnvelopeData(value);
  const input = cliObject(data, ["views", "total"]);
  if (!Array.isArray(input.views) || input.views.length > limit) {
    return invalidCliResult();
  }
  const items = input.views.map((entry): ViewItem => {
    const row = sourceObject(entry);
    return Object.freeze({
      id: cliId(row.id),
      name: cliText(row.name, 500),
      type: sourceType(row.type),
    });
  });
  const total = nonNegativeInteger(input.total);
  if (total < items.length) return invalidCliResult();
  return Object.freeze({ items: Object.freeze(items), total });
}

function optionalInteger(value: JsonValue | undefined): number | undefined {
  return value === undefined ? undefined : nonNegativeInteger(value);
}

function optionalBoolean(value: JsonValue | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") return invalidCliResult();
  return value;
}

function parseRecordPage(value: JsonValue): RecordPage {
  const data = cliEnvelopeData(value);
  const input = cliObject(
    data,
    ["fields", "record_id_list", "data"],
    ["field_id_list", "total", "has_more", "query_context", "ignored_fields"],
  );
  if (
    !Array.isArray(input.fields) ||
    !Array.isArray(input.record_id_list) ||
    !Array.isArray(input.data) ||
    input.data.length > 200 ||
    input.fields.length < 1 ||
    input.fields.length > 200 ||
    (Object.hasOwn(input, "field_id_list") &&
      (!Array.isArray(input.field_id_list) ||
        input.field_id_list.length !== input.fields.length)) ||
    input.record_id_list.length !== input.data.length
  ) {
    return invalidCliResult();
  }
  const fields = input.fields.map((entry) => cliText(entry, 500));
  const fieldIds = Array.isArray(input.field_id_list)
    ? input.field_id_list.map((entry) => cliId(entry))
    : undefined;
  const recordIds = input.record_id_list.map((entry) => cliId(entry));
  if (
    (fieldIds !== undefined && new Set(fieldIds).size !== fieldIds.length) ||
    new Set(recordIds).size !== recordIds.length
  ) {
    return invalidCliResult();
  }
  const rows = input.data.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== fields.length) {
      return invalidCliResult();
    }
    return Object.freeze([...entry]) as readonly JsonValue[];
  });
  const total = optionalInteger(input.total);
  const hasMore = optionalBoolean(input.has_more);
  if (total === undefined && hasMore === undefined) {
    return invalidCliResult();
  }
  if (Object.hasOwn(input, "query_context")) {
    sourceObject(input.query_context as JsonValue);
  }
  if (Object.hasOwn(input, "ignored_fields")) {
    if (
      !Array.isArray(input.ignored_fields) ||
      input.ignored_fields.length !== 0
    ) {
      return invalidCliResult();
    }
  }
  return Object.freeze({
    fields: Object.freeze(fields),
    ...(fieldIds === undefined ? {} : { fieldIds: Object.freeze(fieldIds) }),
    recordIds: Object.freeze(recordIds),
    rows: Object.freeze(rows),
    ...(total === undefined ? {} : { total }),
    ...(hasMore === undefined ? {} : { hasMore }),
  });
}

function parseDataQueryRows(
  value: JsonValue,
  columns: readonly QueryColumn[],
  limit: number,
): readonly Readonly<{ values: readonly JsonValue[] }>[] {
  const data = cliEnvelopeData(value);
  const input = cliObject(data, ["main_data"]);
  if (
    !Array.isArray(input.main_data) ||
    input.main_data.length > limit ||
    (columns.every((column) => column.kind === "aggregate") &&
      input.main_data.length !== 1)
  ) {
    return invalidCliResult();
  }
  const rows = input.main_data.map((entry) => {
    const row = cliObject(
      entry,
      columns.map((column) => column.alias),
    );
    const values = columns.map((column): JsonValue => {
      const cell = cliObject(row[column.alias]!, ["value"]);
      const cellValue = cell.value!;
      if (column.kind === "aggregate") {
        if (
          typeof cellValue !== "number" ||
          !Number.isFinite(cellValue) ||
          (column.operator === "count" &&
            (!Number.isSafeInteger(cellValue) || cellValue < 0))
        ) {
          return invalidCliResult();
        }
      }
      return cellValue;
    });
    return Object.freeze({ values: Object.freeze(values) });
  });
  if (
    Buffer.byteLength(JSON.stringify(rows), "utf8") > MAX_QUERY_RESULT_BYTES
  ) {
    return invalidCliResult();
  }
  return Object.freeze(rows);
}

function selectionObject(value: ActionJsonValue): JsonObject {
  const snapshot = snapshotStrictJson(value);
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    throw new Error("invalid Base clarification selection");
  }
  return snapshot as JsonObject;
}

function parseBaseSelection(value: ActionJsonValue): BaseSelectionValue {
  const fail = (): never => {
    throw new Error("invalid Base clarification selection");
  };
  const input = strictObject(
    selectionObject(value),
    ["version", "kind", "baseToken", "title"],
    [],
    fail,
  );
  if (input.version !== 1 || input.kind !== "base") return fail();
  return Object.freeze({
    version: 1,
    kind: "base",
    baseToken: cliIdentifier(input.baseToken, fail),
    title: safeString(input.title, 500, fail),
  });
}

function parseTableSelection(value: ActionJsonValue): TableSelectionValue {
  const fail = (): never => {
    throw new Error("invalid Base clarification selection");
  };
  const input = strictObject(
    selectionObject(value),
    ["version", "kind", "baseToken", "tableId", "name"],
    [],
    fail,
  );
  if (input.version !== 1 || input.kind !== "table") return fail();
  return Object.freeze({
    version: 1,
    kind: "table",
    baseToken: cliIdentifier(input.baseToken, fail),
    tableId: cliIdentifier(input.tableId, fail),
    name: safeString(input.name, 500, fail),
  });
}

function trustedWriterResult(
  value: unknown,
  candidates: readonly Readonly<{
    value: BaseClarificationValue;
    displayLabel: string;
  }>[],
) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid Base clarification result");
  }
  const result = value as Readonly<Record<string, unknown>>;
  if (
    Reflect.ownKeys(result).length !== 2 ||
    typeof result.groupId !== "string" ||
    !UUID_PATTERN.test(result.groupId) ||
    !Array.isArray(result.options) ||
    result.options.length !== candidates.length
  ) {
    throw new Error("invalid Base clarification result");
  }
  const refs = new Set<string>();
  const options = result.options.map((option, index) => {
    if (
      option === null ||
      typeof option !== "object" ||
      Array.isArray(option)
    ) {
      throw new Error("invalid Base clarification result");
    }
    const row = option as Readonly<Record<string, unknown>>;
    const keys = ["ordinal", "optionRef", "displayLabel"];
    if (
      Reflect.ownKeys(row).length !== keys.length ||
      Reflect.ownKeys(row).some(
        (key) => typeof key !== "string" || !keys.includes(key),
      ) ||
      row.ordinal !== index + 1 ||
      typeof row.optionRef !== "string" ||
      !UUID_PATTERN.test(row.optionRef) ||
      refs.has(row.optionRef) ||
      row.displayLabel !== candidates[index]?.displayLabel
    ) {
      throw new Error("invalid Base clarification result");
    }
    refs.add(row.optionRef);
    return Object.freeze({
      ordinal: index + 1,
      optionRef: row.optionRef,
      displayLabel: row.displayLabel as string,
    });
  });
  return Object.freeze({
    groupId: result.groupId,
    options: Object.freeze(options),
  });
}

function withoutOpaqueRefs(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => withoutOpaqueRefs(entry));
  }
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !/(?:Ref|Refs)$/u.test(key))
      .sort()
      .map((key) => [
        key,
        withoutOpaqueRefs((value as JsonObject)[key] as JsonValue),
      ]),
  );
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

function digest(value: unknown): string {
  const snapshot = snapshotStrictJson(value);
  return `sha256:${createHash("sha256")
    .update(canonicalJson(snapshot), "utf8")
    .digest("hex")}`;
}

function currentBaseTitle(handle: BaseHandle): string | undefined {
  return handle.title;
}

function verifiedTableName(handle: TableHandle): string {
  if (!handle.verified) return invalidCliResult();
  return handle.name;
}

export function createBaseReader(
  dependencies: BaseReaderDependencies,
): BaseReader {
  if (
    dependencies === null ||
    typeof dependencies !== "object" ||
    dependencies.runner === null ||
    typeof dependencies.runner !== "object" ||
    typeof dependencies.runner.runUser !== "function" ||
    (dependencies.clarificationWriter !== undefined &&
      (dependencies.clarificationWriter === null ||
        typeof dependencies.clarificationWriter !== "object" ||
        typeof dependencies.clarificationWriter.writeBaseClarification !==
          "function")) ||
    (dependencies.clarificationConsumer !== undefined &&
      (dependencies.clarificationConsumer === null ||
        typeof dependencies.clarificationConsumer !== "object" ||
        typeof dependencies.clarificationConsumer
          .consumeClarificationsForTaskValidated !== "function")) ||
    (dependencies.randomUuid !== undefined &&
      typeof dependencies.randomUuid !== "function")
  ) {
    throw new Error("invalid Base reader dependencies");
  }
  const runUser = dependencies.runner.runUser.bind(dependencies.runner);
  const writeClarification =
    dependencies.clarificationWriter?.writeBaseClarification.bind(
      dependencies.clarificationWriter,
    );
  const consumeClarification =
    dependencies.clarificationConsumer?.consumeClarificationsForTaskValidated.bind(
      dependencies.clarificationConsumer,
    );
  const generateUuid = dependencies.randomUuid ?? randomUUID;

  const issuedByTask = new Map<string, Set<string>>();
  const baseByTask = new Map<string, Map<string, BaseHandle>>();
  const tableByTask = new Map<string, Map<string, TableHandle>>();
  const fieldByTask = new Map<string, Map<string, FieldHandle>>();
  const viewByTask = new Map<string, Map<string, ViewHandle>>();
  const recordByTask = new Map<string, Map<string, RecordHandle>>();
  const evidenceByTask = new Map<string, Map<string, BaseReadEvidence>>();
  const urlViewRefByTableRef = new Map<string, Map<string, string>>();

  function issueUuid(taskId: string): string {
    const result = generateUuid();
    const issued = issuedByTask.get(taskId) ?? new Set<string>();
    if (
      typeof result !== "string" ||
      !UUID_PATTERN.test(result) ||
      issued.has(result)
    ) {
      throw new Error("Base reference generation failed");
    }
    issued.add(result);
    issuedByTask.set(taskId, issued);
    return result;
  }

  function register<T>(
    store: Map<string, Map<string, T>>,
    taskId: string,
    value: T,
  ): string {
    const ref = issueUuid(taskId);
    const values = store.get(taskId) ?? new Map<string, T>();
    values.set(ref, value);
    store.set(taskId, values);
    return ref;
  }

  function dereference<T>(
    store: Map<string, Map<string, T>>,
    taskId: string,
    ref: string,
    label: string,
  ): T {
    const value = store.get(taskId)?.get(ref);
    if (value === undefined) {
      throw new Error(`${label} reference is not available`);
    }
    return value;
  }

  function baseTitleForToken(
    taskId: string,
    baseToken: string,
  ): string | undefined {
    const titles = new Set(
      [...(baseByTask.get(taskId)?.values() ?? [])]
        .filter((base) => base.baseToken === baseToken)
        .flatMap((base) => (base.title === undefined ? [] : [base.title])),
    );
    if (titles.size > 1) return invalidCliResult();
    return titles.values().next().value;
  }

  function replaceRegistered<T>(
    store: Map<string, Map<string, T>>,
    taskId: string,
    ref: string,
    value: T,
    label: string,
  ): void {
    const values = store.get(taskId);
    if (values === undefined || !values.has(ref)) {
      throw new Error(`${label} reference is not available`);
    }
    values.set(ref, value);
  }

  function prepareEvidence(
    taskId: string,
    content: unknown,
    scope: BaseReadEvidence["scope"],
    completeness: BaseReadEvidence["completeness"],
  ): BaseReadEvidence {
    const evidenceRef = issueUuid(taskId);
    const evidence = Object.freeze({
      evidenceRef,
      digest: digest({
        content: withoutOpaqueRefs(snapshotStrictJson(content)),
        scope,
        completeness,
      }),
      scope: Object.freeze({
        ...scope,
        fieldNames: Object.freeze([...scope.fieldNames]),
      }),
      completeness: Object.freeze({ ...completeness }),
    });
    return evidence;
  }

  function storeEvidence(
    taskId: string,
    evidence: BaseReadEvidence,
  ): BaseReadEvidence {
    const taskEvidence =
      evidenceByTask.get(taskId) ?? new Map<string, BaseReadEvidence>();
    taskEvidence.set(evidence.evidenceRef, evidence);
    evidenceByTask.set(taskId, taskEvidence);
    return evidence;
  }

  function makeEvidence(
    taskId: string,
    content: unknown,
    scope: BaseReadEvidence["scope"],
    completeness: BaseReadEvidence["completeness"],
  ): BaseReadEvidence {
    return storeEvidence(
      taskId,
      prepareEvidence(taskId, content, scope, completeness),
    );
  }

  async function run(
    operation: string,
    payload: Readonly<Record<string, JsonValue>>,
    unavailableMessage: string,
  ): Promise<JsonValue> {
    const result = await runUser({ version: 1, operation, payload });
    if (result.state !== "SUCCEEDED") {
      throw new Error(unavailableMessage);
    }
    return result.value;
  }

  async function writeChoices(
    taskId: string,
    kind: "base" | "table",
    groupLabel: string,
    candidates: readonly Readonly<{
      value: BaseClarificationValue;
      displayLabel: string;
    }>[],
    now: Date,
  ) {
    if (
      writeClarification === undefined ||
      candidates.length < 2 ||
      candidates.length > MAX_CLARIFICATION_OPTIONS
    ) {
      throw new Error("Base clarification writer is not available");
    }
    return trustedWriterResult(
      await writeClarification({
        taskId,
        kind,
        groupLabel,
        candidates,
        now,
      }),
      candidates,
    );
  }

  function consumeChoice(
    taskId: string,
    optionRef: string,
    kind: "base" | "table",
    now: Date,
  ): BaseSelectionValue | TableSelectionValue {
    if (consumeClarification === undefined) {
      throw new Error("Base clarification consumer is not available");
    }
    const assertValue: ClarificationValueValidator = (value) => {
      if (kind === "base") parseBaseSelection(value);
      else parseTableSelection(value);
      return undefined;
    };
    const selections = consumeClarification(
      taskId,
      Object.freeze([optionRef]),
      kind,
      now,
      assertValue,
    );
    if (
      selections.length !== 1 ||
      selections[0]?.optionRef !== optionRef ||
      selections[0].kind !== kind
    ) {
      throw new Error("invalid Base clarification selection");
    }
    return kind === "base"
      ? parseBaseSelection(selections[0].value)
      : parseTableSelection(selections[0].value);
  }

  function registerResolvedResource(
    taskId: string,
    resource: ResolvedCliResource,
  ) {
    const baseHandle: BaseHandle = Object.freeze({
      baseToken: resource.baseToken,
      ...(resource.title === undefined ? {} : { title: resource.title }),
    });
    const baseRef = register(baseByTask, taskId, baseHandle);
    const tableRef =
      resource.tableId === undefined
        ? undefined
        : register(
            tableByTask,
            taskId,
            Object.freeze({
              verified: false as const,
              baseToken: resource.baseToken,
              tableId: resource.tableId,
            }),
          );
    const viewRef =
      resource.viewId === undefined || resource.tableId === undefined
        ? undefined
        : register(
            viewByTask,
            taskId,
            Object.freeze({
              verified: false as const,
              baseToken: resource.baseToken,
              tableId: resource.tableId,
              viewId: resource.viewId,
            }),
          );
    const recordRef =
      resource.recordId === undefined || resource.tableId === undefined
        ? undefined
        : register(
            recordByTask,
            taskId,
            Object.freeze({
              baseToken: resource.baseToken,
              tableId: resource.tableId,
              recordId: resource.recordId,
            }),
          );
    if (tableRef !== undefined && viewRef !== undefined) {
      const taskLinks =
        urlViewRefByTableRef.get(taskId) ?? new Map<string, string>();
      taskLinks.set(tableRef, viewRef);
      urlViewRefByTableRef.set(taskId, taskLinks);
    }
    return Object.freeze({
      baseRef,
      ...(resource.title === undefined ? {} : { title: resource.title }),
      ...(tableRef === undefined ? {} : { tableRef }),
      ...(viewRef === undefined ? {} : { viewRef }),
      ...(recordRef === undefined ? {} : { recordRef }),
    });
  }

  async function resolve(
    taskIdValue: string,
    payloadValue: BaseResolvePayload,
    nowValue: Date,
  ): Promise<BaseResolveResult> {
    const taskId = assertTaskId(taskIdValue);
    const payload = parseBaseResolvePayload(payloadValue);
    const now = snapshotNow(nowValue);

    if (payload.source === "url") {
      const parsed = trustedBaseUrl(payload.url, true);
      if (/^\/wiki\/[^/]+/u.test(parsed.pathname)) {
        return Object.freeze({
          status: "BLOCKED_SCOPE",
          scope: "wiki:node:retrieve",
        });
      }
      const raw = await run(
        "base.url.resolve",
        Object.freeze({ url: payload.url }),
        "Base CLI result is unavailable",
      );
      const resolvedWithoutTitle = parseUrlResolveResult(raw);
      const baseRaw = await run(
        "base.app.get",
        Object.freeze({ baseToken: resolvedWithoutTitle.baseToken }),
        "Base CLI result is unavailable",
      );
      const resolved = Object.freeze({
        ...resolvedWithoutTitle,
        title: parseBaseAppResult(baseRaw, resolvedWithoutTitle.baseToken),
      });
      const resource = registerResolvedResource(taskId, resolved);
      const evidence = makeEvidence(
        taskId,
        resource,
        Object.freeze({
          resource: "base",
          ...(resolved.title === undefined
            ? {}
            : { baseTitle: resolved.title }),
          fieldNames: Object.freeze([]),
        }),
        Object.freeze({
          complete: true,
          hasMore: false,
          truncatedBy: null,
          itemCount: 1,
        }),
      );
      return Object.freeze({ status: "RESOLVED", resource, evidence });
    }

    if (payload.source === "title") {
      const raw = await run(
        "base.title.resolve",
        Object.freeze({ title: payload.title }),
        "Base CLI result is unavailable",
      );
      const parsed = parseTitleResolveResult(raw);
      if (isResolvedCliResource(parsed)) {
        const resource = registerResolvedResource(taskId, parsed);
        const evidence = makeEvidence(
          taskId,
          resource,
          Object.freeze({
            resource: "base",
            ...(parsed.title === undefined ? {} : { baseTitle: parsed.title }),
            fieldNames: Object.freeze([]),
          }),
          Object.freeze({
            complete: true,
            hasMore: false,
            truncatedBy: null,
            itemCount: 1,
          }),
        );
        return Object.freeze({ status: "RESOLVED", resource, evidence });
      }
      const choices = parsed.map((candidate) =>
        Object.freeze({
          value: Object.freeze({
            version: 1 as const,
            kind: "base" as const,
            baseToken: candidate.baseToken,
            title: candidate.title,
          }),
          displayLabel: [
            candidate.title,
            candidate.ownerName || "所有者未提供",
            candidate.updateTime || "更新时间未提供",
          ].join("｜"),
        }),
      );
      const label = `多维表格：${payload.title}`;
      const written = await writeChoices(taskId, "base", label, choices, now);
      return Object.freeze({
        status: "NEEDS_CLARIFICATION",
        groupRef: written.groupId,
        label,
        candidates: Object.freeze(
          parsed.map((candidate, index) =>
            Object.freeze({
              selectionRef: written.options[index]!.optionRef,
              label: written.options[index]!.displayLabel,
              title: candidate.title,
              ...(candidate.ownerName === ""
                ? {}
                : { ownerName: candidate.ownerName }),
              ...(candidate.updateTime === ""
                ? {}
                : { updateTime: candidate.updateTime }),
            }),
          ),
        ),
      });
    }

    const selection = consumeChoice(taskId, payload.selectionRef, "base", now);
    if (selection.kind !== "base") {
      throw new Error("invalid Base clarification selection");
    }
    const resource = registerResolvedResource(
      taskId,
      Object.freeze({
        baseToken: selection.baseToken,
        title: selection.title,
      }),
    );
    const evidence = makeEvidence(
      taskId,
      resource,
      Object.freeze({
        resource: "base",
        baseTitle: selection.title,
        fieldNames: Object.freeze([]),
      }),
      Object.freeze({
        complete: true,
        hasMore: false,
        truncatedBy: null,
        itemCount: 1,
      }),
    );
    return Object.freeze({ status: "RESOLVED", resource, evidence });
  }

  async function listAllTables(
    baseToken: string,
  ): Promise<readonly TableItem[]> {
    const items: TableItem[] = [];
    const ids = new Set<string>();
    let offset = 0;
    let expectedTotal: number | undefined;
    for (;;) {
      const raw = await run(
        "base.table.list",
        Object.freeze({ baseToken, offset, limit: 100 }),
        "Base schema CLI result is unavailable",
      );
      const page = parseTablePage(raw, 100);
      expectedTotal ??= page.total;
      if (
        page.total !== expectedTotal ||
        expectedTotal > MAX_SCHEMA_ITEMS ||
        page.items.some((item) => ids.has(item.id))
      ) {
        return invalidCliResult();
      }
      for (const item of page.items) {
        ids.add(item.id);
        items.push(item);
      }
      offset += page.items.length;
      if (offset === expectedTotal) break;
      if (offset > expectedTotal || page.items.length === 0) {
        return invalidCliResult();
      }
    }
    return Object.freeze(items);
  }

  async function verifyTableRef(
    taskId: string,
    tableRef: string,
    expectedBaseToken?: string,
  ): Promise<Extract<TableHandle, { verified: true }>> {
    const existing = dereference(tableByTask, taskId, tableRef, "table");
    if (
      expectedBaseToken !== undefined &&
      existing.baseToken !== expectedBaseToken
    ) {
      throw new Error("table reference is not available");
    }
    if (existing.verified) return existing;
    const tables = await listAllTables(existing.baseToken);
    const matched = tables.find((table) => table.id === existing.tableId);
    if (matched === undefined) return invalidCliResult();
    const verified = Object.freeze({
      verified: true as const,
      baseToken: existing.baseToken,
      tableId: existing.tableId,
      name: matched.name,
    });
    replaceRegistered(tableByTask, taskId, tableRef, verified, "table");
    return verified;
  }

  async function listAllFields(
    baseToken: string,
    tableId: string,
  ): Promise<readonly FieldItem[]> {
    const items: FieldItem[] = [];
    const ids = new Set<string>();
    let offset = 0;
    let expectedTotal: number | undefined;
    for (;;) {
      const raw = await run(
        "base.field.list",
        Object.freeze({ baseToken, tableId, offset, limit: 200 }),
        "Base schema CLI result is unavailable",
      );
      const page = parseFieldPage(raw, 200);
      expectedTotal ??= page.total;
      if (
        page.total !== expectedTotal ||
        expectedTotal > MAX_SCHEMA_ITEMS ||
        page.items.some((item) => ids.has(item.id))
      ) {
        return invalidCliResult();
      }
      for (const item of page.items) {
        ids.add(item.id);
        items.push(item);
      }
      offset += page.items.length;
      if (offset === expectedTotal) break;
      if (offset > expectedTotal || page.items.length === 0) {
        return invalidCliResult();
      }
    }
    return Object.freeze(items);
  }

  async function listAllViews(
    baseToken: string,
    tableId: string,
  ): Promise<readonly ViewItem[]> {
    const items: ViewItem[] = [];
    const ids = new Set<string>();
    let offset = 0;
    let expectedTotal: number | undefined;
    for (;;) {
      const raw = await run(
        "base.view.list",
        Object.freeze({ baseToken, tableId, offset, limit: 200 }),
        "Base schema CLI result is unavailable",
      );
      const page = parseViewPage(raw, 200);
      expectedTotal ??= page.total;
      if (
        page.total !== expectedTotal ||
        expectedTotal > MAX_SCHEMA_ITEMS ||
        page.items.some((item) => ids.has(item.id))
      ) {
        return invalidCliResult();
      }
      for (const item of page.items) {
        ids.add(item.id);
        items.push(item);
      }
      offset += page.items.length;
      if (offset === expectedTotal) break;
      if (offset > expectedTotal || page.items.length === 0) {
        return invalidCliResult();
      }
    }
    return Object.freeze(items);
  }

  async function verifyViewRef(
    taskId: string,
    viewRef: string,
    table: Extract<TableHandle, { verified: true }>,
  ): Promise<Extract<ViewHandle, { verified: true }>> {
    const existing = dereference(viewByTask, taskId, viewRef, "view");
    if (
      existing.baseToken !== table.baseToken ||
      existing.tableId !== table.tableId
    ) {
      throw new Error("view reference is not available");
    }
    if (existing.verified) return existing;
    const views = await listAllViews(table.baseToken, table.tableId);
    const matched = views.find((view) => view.id === existing.viewId);
    if (matched === undefined) return invalidCliResult();
    const verified = Object.freeze({
      verified: true as const,
      baseToken: existing.baseToken,
      tableId: existing.tableId,
      viewId: existing.viewId,
      name: matched.name,
      type: matched.type,
    });
    replaceRegistered(viewByTask, taskId, viewRef, verified, "view");
    return verified;
  }

  function queryField(
    taskId: string,
    fieldRef: string,
    table: Extract<TableHandle, { verified: true }>,
  ): FieldHandle {
    const field = dereference(fieldByTask, taskId, fieldRef, "field");
    if (
      field.baseToken !== table.baseToken ||
      field.tableId !== table.tableId
    ) {
      throw new Error("field reference is not available");
    }
    return field;
  }

  function compileFilterCondition(
    taskId: string,
    condition: Extract<BaseLiteFilter, { kind: "condition" }>,
    table: Extract<TableHandle, { verified: true }>,
  ): QueryFilterCondition {
    const field = queryField(taskId, condition.fieldRef, table);
    const emptyOperator =
      condition.operator === "is_empty" || condition.operator === "not_empty";
    let officialOperator: QueryFilterCondition["officialOperator"];
    let officialValue: readonly string[];

    if (emptyOperator) {
      if (
        condition.value !== null ||
        (field.type !== "text" &&
          field.type !== "number" &&
          field.type !== "select")
      ) {
        return invalidPayload("query");
      }
      officialOperator =
        condition.operator === "is_empty" ? "isEmpty" : "isNotEmpty";
      officialValue = Object.freeze([]);
    } else if (field.type === "text") {
      if (
        (condition.operator !== "eq" && condition.operator !== "ne") ||
        typeof condition.value !== "string"
      ) {
        return invalidPayload("query");
      }
      officialOperator = condition.operator === "eq" ? "is" : "isNot";
      officialValue = Object.freeze([condition.value]);
    } else if (field.type === "number") {
      if (
        typeof condition.value !== "number" ||
        !Number.isFinite(condition.value)
      ) {
        return invalidPayload("query");
      }
      const numericOperators = Object.freeze({
        eq: "is",
        ne: "isNot",
        gt: "isGreater",
        gte: "isGreaterEqual",
        lt: "isLess",
        lte: "isLessEqual",
      } as const);
      if (!Object.hasOwn(numericOperators, condition.operator)) {
        return invalidPayload("query");
      }
      officialOperator =
        numericOperators[condition.operator as keyof typeof numericOperators];
      officialValue = Object.freeze([String(condition.value)]);
    } else if (field.type === "select") {
      if (condition.operator === "eq" || condition.operator === "ne") {
        if (typeof condition.value !== "string") {
          return invalidPayload("query");
        }
        officialOperator = condition.operator === "eq" ? "is" : "isNot";
        officialValue = Object.freeze([condition.value]);
      } else if (
        condition.operator === "in" ||
        condition.operator === "not_in"
      ) {
        if (
          !Array.isArray(condition.value) ||
          condition.value.length < 1 ||
          condition.value.some((entry) => typeof entry !== "string")
        ) {
          return invalidPayload("query");
        }
        officialOperator =
          condition.operator === "in" ? "contains" : "doesNotContain";
        officialValue = Object.freeze([...condition.value]);
      } else {
        return invalidPayload("query");
      }
    } else {
      return invalidPayload("query");
    }

    return Object.freeze({
      fieldRef: condition.fieldRef,
      field,
      operator: condition.operator,
      value: condition.value,
      officialOperator,
      officialValue,
    });
  }

  function compileFilter(
    taskId: string,
    filter: BaseLiteFilter | null,
    table: Extract<TableHandle, { verified: true }>,
  ): null | Readonly<{
    conjunction: "and" | "or";
    conditions: readonly QueryFilterCondition[];
  }> {
    if (filter === null) return null;
    const conjunction =
      filter.kind === "group" ? filter.conjunction : ("and" as const);
    const conditions: QueryFilterCondition[] = [];
    const visit = (node: BaseLiteFilter): void => {
      if (node.kind === "condition") {
        conditions.push(compileFilterCondition(taskId, node, table));
        return;
      }
      if (node.conjunction !== conjunction) {
        invalidPayload("query");
      }
      for (const clause of node.clauses) visit(clause);
    };
    visit(filter);
    if (conditions.length < 1 || conditions.length > MAX_QUERY_FILTER_NODES) {
      return invalidPayload("query");
    }
    return Object.freeze({
      conjunction,
      conditions: Object.freeze(conditions),
    });
  }

  function compileQuery(
    taskId: string,
    payload: BaseDataQueryPayload,
    table: Extract<TableHandle, { verified: true }>,
  ): CompiledQuery {
    const dimensions = payload.dimensionFieldRefs.map(
      (fieldRef, index): Extract<QueryColumn, { kind: "dimension" }> =>
        Object.freeze({
          kind: "dimension",
          alias: `dimension_${index}`,
          fieldRef,
          field: queryField(taskId, fieldRef, table),
        }),
    );
    const measures = payload.aggregates.map(
      (aggregate, index): Extract<QueryColumn, { kind: "aggregate" }> => {
        const field = queryField(taskId, aggregate.fieldRef, table);
        if (aggregate.operator !== "count" && field.type !== "number") {
          return invalidPayload("query");
        }
        return Object.freeze({
          kind: "aggregate",
          alias: `measure_${index}`,
          fieldRef: aggregate.fieldRef,
          field,
          operator: aggregate.operator,
        });
      },
    );
    const columns = Object.freeze([...dimensions, ...measures]);
    const filter = compileFilter(taskId, payload.filter, table);
    const sort = payload.sort.map((item) => {
      const column =
        item.aggregate === null
          ? dimensions.find((candidate) => candidate.fieldRef === item.fieldRef)
          : measures.find(
              (candidate) =>
                candidate.fieldRef === item.fieldRef &&
                candidate.operator === item.aggregate,
            );
      if (column === undefined) return invalidPayload("query");
      return Object.freeze({
        public: Object.freeze({
          fieldName: column.field.name,
          aggregate: item.aggregate,
          direction: item.direction,
        }),
        official: Object.freeze({
          field_name: column.alias,
          order: item.direction,
        }),
      });
    });
    const publicFilter =
      filter === null
        ? null
        : Object.freeze({
            conjunction: filter.conjunction,
            conditions: Object.freeze(
              filter.conditions.map((condition) =>
                Object.freeze({
                  fieldName: condition.field.name,
                  operator: condition.operator,
                  value: condition.value,
                }),
              ),
            ),
          });
    const kind =
      measures.length > 0
        ? ("AGGREGATE" as const)
        : ("DIMENSION_ROWS" as const);
    const scope: BaseQueryEvidenceScope = Object.freeze({
      kind,
      dimensions: Object.freeze(
        dimensions.map((dimension) => dimension.field.name),
      ),
      aggregates: Object.freeze(
        measures.map((measure) =>
          Object.freeze({
            fieldName: measure.field.name,
            operator: measure.operator,
          }),
        ),
      ),
      filter: publicFilter,
      sort: Object.freeze(sort.map((item) => item.public)),
      limit: payload.limit,
    });
    const dsl = Object.freeze({
      datasource: Object.freeze({
        type: "table",
        table: Object.freeze({ tableId: table.tableId }),
      }),
      dimensions: Object.freeze(
        dimensions.map((dimension) =>
          Object.freeze({
            field_name: dimension.field.name,
            alias: dimension.alias,
          }),
        ),
      ),
      measures: Object.freeze(
        measures.map((measure) =>
          Object.freeze({
            field_name: measure.field.name,
            aggregation: measure.operator,
            alias: measure.alias,
          }),
        ),
      ),
      ...(filter === null
        ? {}
        : {
            filters: Object.freeze({
              type: 1,
              conjunction: filter.conjunction,
              conditions: Object.freeze(
                filter.conditions.map((condition) =>
                  Object.freeze({
                    field_name: condition.field.name,
                    operator: condition.officialOperator,
                    value: condition.officialValue,
                  }),
                ),
              ),
            }),
          }),
      sort: Object.freeze(sort.map((item) => item.official)),
      pagination: Object.freeze({ limit: payload.limit }),
      shaper: Object.freeze({ format: "flat" }),
    });
    if (Buffer.byteLength(JSON.stringify(dsl), "utf8") > MAX_QUERY_DSL_BYTES) {
      return invalidPayload("query");
    }
    const fieldNames: string[] = [];
    const seenFieldNames = new Set<string>();
    for (const field of [
      ...dimensions.map((column) => column.field),
      ...measures.map((column) => column.field),
      ...(filter?.conditions.map((condition) => condition.field) ?? []),
    ]) {
      if (!seenFieldNames.has(field.name)) {
        seenFieldNames.add(field.name);
        fieldNames.push(field.name);
      }
    }
    return Object.freeze({
      dsl,
      columns,
      scope,
      fieldNames: Object.freeze(fieldNames),
    });
  }

  async function tableForSchema(
    taskId: string,
    base: BaseHandle,
    payload: BaseSchemaPayload,
    now: Date,
  ): Promise<
    | Readonly<{
        status: "RESOLVED";
        tableRef: string;
        table: Extract<TableHandle, { verified: true }>;
      }>
    | Extract<BaseSchemaResult, { status: "NEEDS_CLARIFICATION" | "NOT_FOUND" }>
  > {
    if (payload.tableRef !== undefined) {
      const table = await verifyTableRef(
        taskId,
        payload.tableRef,
        base.baseToken,
      );
      return Object.freeze({
        status: "RESOLVED",
        tableRef: payload.tableRef,
        table,
      });
    }
    if (payload.tableSelectionRef !== undefined) {
      const selection = consumeChoice(
        taskId,
        payload.tableSelectionRef,
        "table",
        now,
      );
      if (
        selection.kind !== "table" ||
        selection.baseToken !== base.baseToken
      ) {
        throw new Error("invalid Base clarification selection");
      }
      const table = Object.freeze({
        verified: true as const,
        baseToken: selection.baseToken,
        tableId: selection.tableId,
        name: selection.name,
      });
      return Object.freeze({
        status: "RESOLVED",
        tableRef: register(tableByTask, taskId, table),
        table,
      });
    }
    const tables = await listAllTables(base.baseToken);
    if (tables.length === 0) return Object.freeze({ status: "NOT_FOUND" });
    if (tables.length === 1) {
      const selected = tables[0]!;
      const table = Object.freeze({
        verified: true as const,
        baseToken: base.baseToken,
        tableId: selected.id,
        name: selected.name,
      });
      return Object.freeze({
        status: "RESOLVED",
        tableRef: register(tableByTask, taskId, table),
        table,
      });
    }
    if (tables.length > MAX_CLARIFICATION_OPTIONS) {
      return invalidCliResult();
    }
    const choices = tables.map((table) =>
      Object.freeze({
        value: Object.freeze({
          version: 1 as const,
          kind: "table" as const,
          baseToken: base.baseToken,
          tableId: table.id,
          name: table.name,
        }),
        displayLabel: table.name,
      }),
    );
    const written = await writeChoices(
      taskId,
      "table",
      "请选择数据表",
      choices,
      now,
    );
    return Object.freeze({
      status: "NEEDS_CLARIFICATION",
      groupRef: written.groupId,
      label: "请选择数据表",
      candidates: Object.freeze(
        tables.map((table, index) =>
          Object.freeze({
            selectionRef: written.options[index]!.optionRef,
            label: written.options[index]!.displayLabel,
            name: table.name,
          }),
        ),
      ),
    });
  }

  async function readSchema(
    taskIdValue: string,
    payloadValue: BaseSchemaPayload,
    nowValue: Date,
  ): Promise<BaseSchemaResult> {
    const taskId = assertTaskId(taskIdValue);
    const payload = parseBaseSchemaPayload(payloadValue);
    const now = snapshotNow(nowValue);
    const base = dereference(baseByTask, taskId, payload.baseRef, "base");
    const selected = await tableForSchema(taskId, base, payload, now);
    if (selected.status !== "RESOLVED") return selected;

    const fields = await listAllFields(
      selected.table.baseToken,
      selected.table.tableId,
    );
    const views = await listAllViews(
      selected.table.baseToken,
      selected.table.tableId,
    );
    const linkedViewRef = urlViewRefByTableRef
      .get(taskId)
      ?.get(selected.tableRef);
    const linkedView =
      linkedViewRef === undefined
        ? undefined
        : dereference(viewByTask, taskId, linkedViewRef, "view");
    const linkedViewItem =
      linkedView === undefined
        ? undefined
        : views.find((view) => view.id === linkedView.viewId);
    if (
      linkedView !== undefined &&
      (linkedView.baseToken !== selected.table.baseToken ||
        linkedView.tableId !== selected.table.tableId ||
        linkedViewItem === undefined)
    ) {
      return invalidCliResult();
    }
    if (linkedViewRef !== undefined && linkedViewItem !== undefined) {
      replaceRegistered(
        viewByTask,
        taskId,
        linkedViewRef,
        Object.freeze({
          verified: true as const,
          baseToken: selected.table.baseToken,
          tableId: selected.table.tableId,
          viewId: linkedViewItem.id,
          name: linkedViewItem.name,
          type: linkedViewItem.type,
        }),
        "view",
      );
    }
    const publicFields = Object.freeze(
      fields.map((field) => {
        const fieldRef = register(
          fieldByTask,
          taskId,
          Object.freeze({
            baseToken: selected.table.baseToken,
            tableId: selected.table.tableId,
            fieldId: field.id,
            name: field.name,
            type: field.type,
          }),
        );
        return Object.freeze({
          fieldRef,
          name: field.name,
          type: field.type,
        });
      }),
    );
    const publicViews = Object.freeze(
      views.map((view) => {
        const viewRef =
          linkedViewRef !== undefined && linkedViewItem?.id === view.id
            ? linkedViewRef
            : register(
                viewByTask,
                taskId,
                Object.freeze({
                  verified: true as const,
                  baseToken: selected.table.baseToken,
                  tableId: selected.table.tableId,
                  viewId: view.id,
                  name: view.name,
                  type: view.type,
                }),
              );
        return Object.freeze({
          viewRef,
          name: view.name,
          type: view.type,
        });
      }),
    );
    const tableName = selected.table.name;
    const content = Object.freeze({
      table: Object.freeze({ tableRef: selected.tableRef, name: tableName }),
      fields: publicFields,
      views: publicViews,
    });
    const evidence = makeEvidence(
      taskId,
      content,
      Object.freeze({
        resource: "base",
        ...(currentBaseTitle(base) === undefined
          ? {}
          : { baseTitle: currentBaseTitle(base)! }),
        tableName,
        fieldNames: Object.freeze(fields.map((field) => field.name)),
      }),
      Object.freeze({
        complete: true,
        hasMore: false,
        truncatedBy: null,
        itemCount: 1 + fields.length + views.length,
      }),
    );
    return Object.freeze({
      status: "RESOLVED",
      ...content,
      evidence,
    });
  }

  function validateRecordPage(
    page: RecordPage,
    fields: readonly FieldHandle[],
    recordIds: Set<string>,
    offset: number,
    expectedTotal: number | undefined,
  ): Readonly<{ expectedTotal?: number; hasMore: boolean }> {
    const cumulative = offset + page.rows.length;
    if (
      (page.fieldIds !== undefined &&
        (page.fieldIds.length !== fields.length ||
          page.fieldIds.some(
            (fieldId, index) => fieldId !== fields[index]!.fieldId,
          ))) ||
      page.fields.length !== fields.length ||
      page.fields.some((name, index) => name !== fields[index]!.name) ||
      page.recordIds.some((recordId) => recordIds.has(recordId)) ||
      (page.total !== undefined && page.total < cumulative) ||
      (expectedTotal !== undefined && page.total !== expectedTotal)
    ) {
      return invalidCliResult();
    }
    const total = expectedTotal ?? page.total;
    const hasMore =
      page.hasMore ?? (total === undefined ? false : cumulative < total);
    if (
      total !== undefined &&
      ((!hasMore && cumulative !== total) || (hasMore && cumulative >= total))
    ) {
      return invalidCliResult();
    }
    for (const recordId of page.recordIds) recordIds.add(recordId);
    return Object.freeze({
      ...(total === undefined ? {} : { expectedTotal: total }),
      hasMore,
    });
  }

  async function readRecords(
    taskIdValue: string,
    payloadValue: BaseRecordsPayload,
    nowValue: Date,
  ): Promise<BaseRecordsResult> {
    const taskId = assertTaskId(taskIdValue);
    const payload = parseBaseRecordsPayload(payloadValue);
    snapshotNow(nowValue);
    const table = await verifyTableRef(taskId, payload.tableRef);
    const fields = payload.fieldRefs.map((fieldRef) => {
      const field = dereference(fieldByTask, taskId, fieldRef, "field");
      if (
        field.baseToken !== table.baseToken ||
        field.tableId !== table.tableId
      ) {
        throw new Error("field reference is not available");
      }
      return field;
    });
    const view =
      payload.viewRef === null
        ? undefined
        : await verifyViewRef(taskId, payload.viewRef, table);

    const tableName = verifiedTableName(table);
    const columns = Object.freeze(
      fields.map((field, index) =>
        Object.freeze({
          fieldRef: payload.fieldRefs[index]!,
          name: field.name,
          type: field.type,
        }),
      ),
    );
    const scope = Object.freeze({
      resource: "base" as const,
      ...(baseTitleForToken(taskId, table.baseToken) === undefined
        ? {}
        : { baseTitle: baseTitleForToken(taskId, table.baseToken)! }),
      tableName,
      ...(view === undefined ? {} : { viewName: view.name }),
      fieldNames: Object.freeze(fields.map((field) => field.name)),
    });
    const rows: Readonly<{ values: readonly JsonValue[] }>[] = [];
    const recordIds = new Set<string>();
    let structuredBytes =
      Buffer.byteLength(
        JSON.stringify({
          status: "RESOLVED",
          table: { tableRef: payload.tableRef, name: tableName },
          columns,
          rows: [],
          evidence: {
            evidenceRef: "00000000-0000-4000-8000-000000000000",
            digest: `sha256:${"0".repeat(64)}`,
            scope,
            completeness: {
              complete: false,
              hasMore: true,
              truncatedBy: "byte_limit",
              itemCount: MAX_RECORD_ROWS,
            },
          },
        }),
        "utf8",
      ) + 32;
    let offset = 0;
    let expectedTotal: number | undefined;
    let sourceHasMore = false;
    let truncatedBy: null | "row_limit" | "byte_limit" = null;

    for (;;) {
      const raw = await run(
        "base.record.list",
        Object.freeze({
          baseToken: table.baseToken,
          tableId: table.tableId,
          viewId: view?.viewId ?? null,
          fieldIds: Object.freeze(fields.map((field) => field.fieldId)),
          filterJson: null,
          sortJson: null,
          offset,
          limit: 200,
        }),
        "Base records CLI result is unavailable",
      );
      const page = parseRecordPage(raw);
      const validated = validateRecordPage(
        page,
        fields,
        recordIds,
        offset,
        expectedTotal,
      );
      expectedTotal = validated.expectedTotal;
      sourceHasMore = validated.hasMore;

      for (const values of page.rows) {
        if (rows.length >= MAX_RECORD_ROWS) {
          truncatedBy = "row_limit";
          break;
        }
        const row = Object.freeze({ values: Object.freeze([...values]) });
        const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
        const nextBytes =
          structuredBytes + rowBytes + (rows.length === 0 ? 0 : 1);
        if (nextBytes > MAX_RECORD_BYTES) {
          truncatedBy = "byte_limit";
          break;
        }
        rows.push(row);
        structuredBytes = nextBytes;
      }

      if (truncatedBy !== null) {
        sourceHasMore = true;
        break;
      }
      offset += page.rows.length;
      if (rows.length === MAX_RECORD_ROWS && sourceHasMore) {
        truncatedBy = "row_limit";
        break;
      }
      if (!sourceHasMore) break;
      if (page.rows.length === 0) return invalidCliResult();
    }

    const publicRows = Object.freeze(rows);
    const content = Object.freeze({
      table: Object.freeze({ tableRef: payload.tableRef, name: tableName }),
      columns,
      rows: publicRows,
    });
    const evidence = makeEvidence(
      taskId,
      content,
      scope,
      Object.freeze({
        complete: truncatedBy === null && !sourceHasMore,
        hasMore: truncatedBy !== null || sourceHasMore,
        truncatedBy,
        itemCount: rows.length,
      }),
    );
    return Object.freeze({
      status: "RESOLVED",
      ...content,
      evidence,
    });
  }

  async function queryData(
    taskIdValue: string,
    payloadValue: BaseDataQueryPayload,
    nowValue: Date,
  ): Promise<BaseDataQueryResult> {
    const taskId = assertTaskId(taskIdValue);
    const payload = parseBaseDataQueryPayload(payloadValue);
    snapshotNow(nowValue);
    const base = dereference(baseByTask, taskId, payload.baseRef, "base");
    const table = await verifyTableRef(
      taskId,
      payload.tableRef,
      base.baseToken,
    );
    const compiled = compileQuery(taskId, payload, table);
    const raw = await run(
      "base.data.query",
      Object.freeze({
        baseToken: table.baseToken,
        dsl: compiled.dsl,
      }),
      "Base query CLI result is unavailable",
    );
    const rows = parseDataQueryRows(raw, compiled.columns, payload.limit);
    const tableName = verifiedTableName(table);
    const columns = Object.freeze(
      compiled.columns.map((column) =>
        column.kind === "dimension"
          ? Object.freeze({
              kind: "dimension" as const,
              fieldRef: column.fieldRef,
              name: column.field.name,
              type: column.field.type,
            })
          : Object.freeze({
              kind: "aggregate" as const,
              fieldRef: column.fieldRef,
              name: column.field.name,
              type: column.field.type,
              operator: column.operator,
            }),
      ),
    );
    const content = Object.freeze({
      kind: compiled.scope.kind,
      table: Object.freeze({ tableRef: payload.tableRef, name: tableName }),
      columns,
      rows,
    });
    if (
      Buffer.byteLength(JSON.stringify(content), "utf8") >
      MAX_QUERY_RESULT_BYTES
    ) {
      return invalidCliResult();
    }
    const atUnprovableDimensionLimit =
      payload.dimensionFieldRefs.length > 0 && rows.length === payload.limit;
    const scope = Object.freeze({
      resource: "base" as const,
      ...(currentBaseTitle(base) === undefined
        ? {}
        : { baseTitle: currentBaseTitle(base)! }),
      tableName,
      fieldNames: compiled.fieldNames,
      query: compiled.scope,
    });
    const evidence = prepareEvidence(
      taskId,
      Object.freeze({ query: compiled.scope, result: content }),
      scope,
      Object.freeze({
        complete: !atUnprovableDimensionLimit,
        hasMore: atUnprovableDimensionLimit,
        truncatedBy: atUnprovableDimensionLimit ? "row_limit" : null,
        itemCount: rows.length,
      }),
    );
    const result = Object.freeze({
      status: "RESOLVED",
      ...content,
      evidence,
    });
    if (
      Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_QUERY_RESULT_BYTES
    ) {
      return invalidCliResult();
    }
    storeEvidence(taskId, evidence);
    return result;
  }

  function getReadEvidence(
    taskIdValue: string,
    evidenceRefValue: string,
  ): BaseReadEvidence {
    const taskId = assertTaskId(taskIdValue);
    const fail = (): never => {
      throw new Error("read evidence reference is not available");
    };
    const evidenceRef =
      typeof evidenceRefValue === "string" &&
      UUID_PATTERN.test(evidenceRefValue)
        ? evidenceRefValue
        : fail();
    return evidenceByTask.get(taskId)?.get(evidenceRef) ?? fail();
  }

  return Object.freeze({
    resolve,
    readSchema,
    readRecords,
    queryData,
    getReadEvidence,
  });
}
