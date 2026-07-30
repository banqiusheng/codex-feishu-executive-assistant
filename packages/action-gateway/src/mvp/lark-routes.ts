import {
  createLarkCliRouteRegistry,
  type LarkCliInvocationPlan,
  type LarkCliRoute,
  type LarkCliRouteRegistry,
} from "../lark-cli-runner.js";
import { snapshotStrictJson, type JsonValue } from "../ipc/framing.js";
import { isStrictShanghaiTimestamp } from "./validation.js";

type JsonObject = Readonly<Record<string, JsonValue>>;

const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{1,252}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RESOURCE_PATH_PATTERN =
  /^resources\/[0-9]{2}-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:txt|bin)$/;
const ATTACHMENT_OUTPUT_PATTERN =
  /^attachment-(?:0[2-9]|1[0-9]|2[01])(?:-image)?\.bin$/;
const QUERY_AGGREGATIONS = new Set(["count", "sum", "avg", "min", "max"]);
const QUERY_FILTER_OPERATORS = new Set([
  "is",
  "isNot",
  "isGreater",
  "isGreaterEqual",
  "isLess",
  "isLessEqual",
  "contains",
  "doesNotContain",
  "isEmpty",
  "isNotEmpty",
]);
const MAX_QUERY_DSL_BYTES = 60 * 1024;
const MAX_REPORT_XML_BYTES = 256 * 1024;
const REPORT_SECTION_HEADINGS = Object.freeze([
  "核心结论",
  "关键数据",
  "异常与风险",
  "建议动作",
  "数据来源与口径",
] as const);

function invalidRoutePayload(): never {
  throw new Error("invalid mvp lark-cli payload");
}

function strictObject(value: unknown, expected: readonly string[]): JsonObject {
  const snapshot = snapshotStrictJson(value);
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    return invalidRoutePayload();
  }
  const keys = Object.keys(snapshot);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key))
  ) {
    return invalidRoutePayload();
  }
  return snapshot as JsonObject;
}

function strictObjectWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): JsonObject {
  const snapshot = snapshotStrictJson(value);
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    return invalidRoutePayload();
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(snapshot);
  if (
    required.some((key) => !Object.hasOwn(snapshot, key)) ||
    keys.some((key) => !allowed.has(key)) ||
    keys.length > allowed.size
  ) {
    return invalidRoutePayload();
  }
  return snapshot as JsonObject;
}

function boundedString(
  value: JsonValue | undefined,
  minimum: number,
  maximum: number,
  trim = true,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    (trim && value !== value.trim()) ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  ) {
    return invalidRoutePayload();
  }
  return value;
}

function nonBlankText(value: JsonValue | undefined, maximum: number): string {
  const text = boundedString(value, 1, maximum, false);
  if (text.trim().length === 0) return invalidRoutePayload();
  return text;
}

function openId(value: JsonValue | undefined): string {
  const id = boundedString(value, 4, 256);
  if (!OPEN_ID_PATTERN.test(id)) return invalidRoutePayload();
  return id;
}

function timestamp(value: JsonValue | undefined): string {
  const result = boundedString(value, 25, 29);
  if (!isStrictShanghaiTimestamp(result)) {
    return invalidRoutePayload();
  }
  return result;
}

function minutesSearchPayload(value: unknown): JsonObject {
  const input = strictObjectWithOptional(value, ["start", "end"], ["query"]);
  const start = boundedString(input.start, 20, 40);
  const end = boundedString(input.end, 20, 40);
  if (
    !Number.isFinite(Date.parse(start)) ||
    !Number.isFinite(Date.parse(end)) ||
    Date.parse(start) >= Date.parse(end)
  ) {
    return invalidRoutePayload();
  }
  const result: Record<string, JsonValue> = { start, end };
  if (Object.hasOwn(input, "query")) {
    result.query = boundedString(input.query, 1, 100);
  }
  return Object.freeze(result);
}

function minutesDetailPayload(value: unknown): JsonObject {
  const input = strictObject(value, ["minuteToken", "artifacts"]);
  const minuteToken = boundedString(input.minuteToken, 1, 256);
  if (!TOKEN_PATTERN.test(minuteToken) || !Array.isArray(input.artifacts)) {
    return invalidRoutePayload();
  }
  const artifacts = input.artifacts.map((entry) => boundedString(entry, 1, 16));
  if (
    artifacts.length < 1 ||
    artifacts.length > 2 ||
    new Set(artifacts).size !== artifacts.length ||
    artifacts.some((artifact) => artifact !== "summary" && artifact !== "todos")
  ) {
    return invalidRoutePayload();
  }
  return Object.freeze({
    minuteToken,
    artifacts: Object.freeze(
      ["summary", "todos"].filter((artifact) => artifacts.includes(artifact)),
    ),
  });
}

function contactSearchPayload(value: unknown): JsonObject {
  const input = strictObject(value, ["query", "pageSize"]);
  if (input.pageSize !== 20) return invalidRoutePayload();
  return Object.freeze({
    query: boundedString(input.query, 1, 50),
    pageSize: 20,
  });
}

function contactSelfPayload(value: unknown): JsonObject {
  return strictObject(value, []);
}

function messageSendPayload(value: unknown): JsonObject {
  const input = strictObject(value, [
    "receiveIdType",
    "recipientOpenId",
    "text",
    "idempotencyKey",
  ]);
  const idempotencyKey = boundedString(input.idempotencyKey, 1, 50);
  if (input.receiveIdType !== "open_id" || !UUID_PATTERN.test(idempotencyKey)) {
    return invalidRoutePayload();
  }
  return Object.freeze({
    receiveIdType: "open_id",
    recipientOpenId: openId(input.recipientOpenId),
    text: nonBlankText(input.text, 20_000),
    idempotencyKey,
  });
}

function notificationTextPayload(value: unknown): JsonObject {
  const input = strictObject(value, [
    "recipientOpenId",
    "text",
    "idempotencyKey",
  ]);
  const idempotencyKey = boundedString(input.idempotencyKey, 1, 50);
  if (!UUID_PATTERN.test(idempotencyKey)) return invalidRoutePayload();
  return Object.freeze({
    recipientOpenId: openId(input.recipientOpenId),
    text: nonBlankText(input.text, 20_000),
    idempotencyKey,
  });
}

function notificationCard(value: JsonValue | undefined): JsonObject {
  const card = strictObject(value, ["schema", "header", "body"]);
  if (card.schema !== "2.0") return invalidRoutePayload();
  const header = strictObject(card.header, ["template", "title"]);
  const title = strictObject(header.title, ["tag", "content"]);
  if (
    header.template !== "blue" ||
    title.tag !== "plain_text" ||
    !Array.isArray((card.body as JsonObject | undefined)?.elements)
  ) {
    return invalidRoutePayload();
  }
  const body = strictObject(card.body, ["direction", "padding", "elements"]);
  if (
    body.direction !== "vertical" ||
    body.padding !== "12px 12px 16px 12px" ||
    !Array.isArray(body.elements) ||
    body.elements.length < 2 ||
    body.elements.length > 22
  ) {
    return invalidRoutePayload();
  }
  const elements = body.elements.map((entry, index) => {
    const element = strictObject(entry, ["tag", "text"]);
    const elementText = strictObject(element.text, ["tag", "content"]);
    if (element.tag !== "div" || elementText.tag !== "plain_text") {
      return invalidRoutePayload();
    }
    const content = nonBlankText(
      elementText.content,
      index === 1 ? 4_000 : 502,
    );
    if (index === 0 && !content.startsWith("来源：")) {
      return invalidRoutePayload();
    }
    if (index > 1 && !content.startsWith("• ")) {
      return invalidRoutePayload();
    }
    return Object.freeze({
      tag: "div",
      text: Object.freeze({ tag: "plain_text", content }),
    });
  });
  return Object.freeze({
    schema: "2.0",
    header: Object.freeze({
      template: "blue",
      title: Object.freeze({
        tag: "plain_text",
        content: nonBlankText(title.content, 100),
      }),
    }),
    body: Object.freeze({
      direction: "vertical",
      padding: "12px 12px 16px 12px",
      elements: Object.freeze(elements),
    }),
  });
}

function notificationCardPayload(value: unknown): JsonObject {
  const input = strictObject(value, [
    "recipientOpenId",
    "card",
    "idempotencyKey",
  ]);
  const idempotencyKey = boundedString(input.idempotencyKey, 1, 50);
  if (!UUID_PATTERN.test(idempotencyKey)) return invalidRoutePayload();
  return Object.freeze({
    recipientOpenId: openId(input.recipientOpenId),
    card: notificationCard(input.card),
    idempotencyKey,
  });
}

function notificationAttachmentPayload(value: unknown): JsonObject {
  const input = strictObject(value, [
    "recipientOpenId",
    "sourceRelativePath",
    "outputFileName",
    "sizeBytes",
    "sha256",
    "idempotencyKey",
  ]);
  const idempotencyKey = boundedString(input.idempotencyKey, 1, 50);
  const sourceRelativePath = boundedString(input.sourceRelativePath, 1, 256);
  const outputFileName = boundedString(input.outputFileName, 1, 64);
  if (
    !UUID_PATTERN.test(idempotencyKey) ||
    !RESOURCE_PATH_PATTERN.test(sourceRelativePath) ||
    !ATTACHMENT_OUTPUT_PATTERN.test(outputFileName) ||
    typeof input.sizeBytes !== "number" ||
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    input.sizeBytes > 100 * 1024 * 1024 ||
    typeof input.sha256 !== "string" ||
    !SHA256_PATTERN.test(input.sha256)
  ) {
    return invalidRoutePayload();
  }
  return Object.freeze({
    recipientOpenId: openId(input.recipientOpenId),
    sourceRelativePath,
    outputFileName,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
    idempotencyKey,
  });
}

function calendarCreatePayload(value: unknown): JsonObject {
  const input = strictObject(value, [
    "calendar",
    "title",
    "description",
    "start",
    "end",
    "zone",
    "attendeeOpenIds",
    "recurrence",
  ]);
  if (
    input.calendar !== "primary" ||
    input.zone !== "Asia/Shanghai" ||
    input.recurrence !== "none" ||
    (input.description !== null && typeof input.description !== "string") ||
    !Array.isArray(input.attendeeOpenIds)
  ) {
    return invalidRoutePayload();
  }
  const start = timestamp(input.start);
  const end = timestamp(input.end);
  if (Date.parse(start) >= Date.parse(end)) return invalidRoutePayload();
  const attendees = input.attendeeOpenIds.map((entry) => openId(entry));
  if (attendees.length > 20 || new Set(attendees).size !== attendees.length) {
    return invalidRoutePayload();
  }
  return Object.freeze({
    calendar: "primary",
    title: nonBlankText(input.title, 500),
    description:
      input.description === null
        ? null
        : nonBlankText(input.description, 20_000),
    start,
    end,
    zone: "Asia/Shanghai",
    attendeeOpenIds: Object.freeze(attendees),
    recurrence: "none",
  });
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function reportDocumentPayload(value: unknown): JsonObject {
  const input = strictObject(value, [
    "docFormat",
    "parentPosition",
    "title",
    "content",
  ]);
  if (input.docFormat !== "xml" || input.parentPosition !== "my_library") {
    return invalidRoutePayload();
  }
  const title = boundedString(input.title, 1, 500);
  const content = boundedString(input.content, 1, MAX_REPORT_XML_BYTES, false);
  const prefix =
    '<?xml version="1.0" encoding="UTF-8"?><doc>' +
    `<title>${xmlEscape(title)}</title>`;
  const headings = [...content.matchAll(/<heading>([^<]*)<\/heading>/gu)].map(
    (match) => match[1],
  );
  if (
    Buffer.byteLength(content, "utf8") > MAX_REPORT_XML_BYTES ||
    !content.startsWith(prefix) ||
    !content.endsWith("</doc>") ||
    headings.length !== REPORT_SECTION_HEADINGS.length ||
    headings.some(
      (heading, index) => heading !== REPORT_SECTION_HEADINGS[index],
    )
  ) {
    return invalidRoutePayload();
  }
  return Object.freeze({
    docFormat: "xml",
    parentPosition: "my_library",
    title,
    content,
  });
}

function baseUrl(value: JsonValue | undefined): string {
  const text = boundedString(value, 1, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return invalidRoutePayload();
  }
  const hostname = parsed.hostname.toLocaleLowerCase("en-US");
  const trustedHost =
    hostname === "feishu.cn" ||
    hostname.endsWith(".feishu.cn") ||
    hostname === "larksuite.com" ||
    hostname.endsWith(".larksuite.com") ||
    hostname === "larkoffice.com" ||
    hostname.endsWith(".larkoffice.com");
  if (
    parsed.protocol !== "https:" ||
    !trustedHost ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.hash !== "" ||
    !/^\/(?:base|record)\/[^/]+\/?$/u.test(parsed.pathname)
  ) {
    return invalidRoutePayload();
  }
  return text;
}

function baseTitle(value: JsonValue | undefined): string {
  const title = boundedString(value, 1, 90);
  if ([...title].length > 30) return invalidRoutePayload();
  return title;
}

/**
 * This validates raw identifiers only at the internal Lark CLI route seam.
 * It is not a public capability parser; public Base reads use opaque task refs.
 */
function cliToken(value: JsonValue | undefined): string {
  const token = boundedString(value, 1, 256);
  if (!TOKEN_PATTERN.test(token)) return invalidRoutePayload();
  return token;
}

function pageOffset(value: JsonValue | undefined): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 1_000_000_000
  ) {
    return invalidRoutePayload();
  }
  return value;
}

function baseUrlResolvePayload(value: unknown): JsonObject {
  const input = strictObject(value, ["url"]);
  return Object.freeze({ url: baseUrl(input.url) });
}

function baseTitleResolvePayload(value: unknown): JsonObject {
  const input = strictObject(value, ["title"]);
  return Object.freeze({ title: baseTitle(input.title) });
}

function baseAppGetPayload(value: unknown): JsonObject {
  const input = strictObject(value, ["baseToken"]);
  return Object.freeze({ baseToken: cliToken(input.baseToken) });
}

function baseTableListPayload(value: unknown): JsonObject {
  const input = strictObject(value, ["baseToken", "offset", "limit"]);
  if (input.limit !== 100) return invalidRoutePayload();
  return Object.freeze({
    baseToken: cliToken(input.baseToken),
    offset: pageOffset(input.offset),
    limit: 100,
  });
}

function baseTableScopedListPayload(value: unknown): JsonObject {
  const input = strictObject(value, [
    "baseToken",
    "tableId",
    "offset",
    "limit",
  ]);
  if (input.limit !== 200) return invalidRoutePayload();
  return Object.freeze({
    baseToken: cliToken(input.baseToken),
    tableId: cliToken(input.tableId),
    offset: pageOffset(input.offset),
    limit: 200,
  });
}

function baseRecordListPayload(value: unknown): JsonObject {
  const input = strictObject(value, [
    "baseToken",
    "tableId",
    "viewId",
    "fieldIds",
    "filterJson",
    "sortJson",
    "offset",
    "limit",
  ]);
  if (
    input.limit !== 200 ||
    (input.viewId !== null && typeof input.viewId !== "string") ||
    input.filterJson !== null ||
    input.sortJson !== null ||
    !Array.isArray(input.fieldIds) ||
    input.fieldIds.length < 1 ||
    input.fieldIds.length > 200
  ) {
    return invalidRoutePayload();
  }
  const fieldIds = input.fieldIds.map((entry) => cliToken(entry));
  if (new Set(fieldIds).size !== fieldIds.length) {
    return invalidRoutePayload();
  }
  return Object.freeze({
    baseToken: cliToken(input.baseToken),
    tableId: cliToken(input.tableId),
    viewId: input.viewId === null ? null : cliToken(input.viewId),
    fieldIds: Object.freeze(fieldIds),
    filterJson: null,
    sortJson: null,
    offset: pageOffset(input.offset),
    limit: 200,
  });
}

function queryArray(
  value: JsonValue | undefined,
  minimum: number,
  maximum: number,
): readonly JsonValue[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    return invalidRoutePayload();
  }
  return value;
}

function queryFieldName(value: JsonValue | undefined): string {
  return boundedString(value, 1, 500);
}

function queryAlias(
  value: JsonValue | undefined,
  prefix: "dimension" | "measure",
  index: number,
): string {
  const alias = boundedString(value, 1, 32);
  if (alias !== `${prefix}_${index}`) return invalidRoutePayload();
  return alias;
}

function queryDimensions(value: JsonValue | undefined): readonly JsonObject[] {
  return Object.freeze(
    queryArray(value, 0, 20).map((entry, index) => {
      const dimension = strictObject(entry, ["field_name", "alias"]);
      return Object.freeze({
        field_name: queryFieldName(dimension.field_name),
        alias: queryAlias(dimension.alias, "dimension", index),
      });
    }),
  );
}

function queryMeasures(value: JsonValue | undefined): readonly JsonObject[] {
  return Object.freeze(
    queryArray(value, 0, 20).map((entry, index) => {
      const measure = strictObject(entry, [
        "field_name",
        "aggregation",
        "alias",
      ]);
      const aggregation = boundedString(measure.aggregation, 3, 5);
      if (!QUERY_AGGREGATIONS.has(aggregation)) return invalidRoutePayload();
      return Object.freeze({
        field_name: queryFieldName(measure.field_name),
        aggregation,
        alias: queryAlias(measure.alias, "measure", index),
      });
    }),
  );
}

function queryFilters(value: JsonValue | undefined): JsonObject {
  const filters = strictObject(value, ["type", "conjunction", "conditions"]);
  if (
    filters.type !== 1 ||
    (filters.conjunction !== "and" && filters.conjunction !== "or")
  ) {
    return invalidRoutePayload();
  }
  const conditions = Object.freeze(
    queryArray(filters.conditions, 1, 64).map((entry) => {
      const condition = strictObject(entry, [
        "field_name",
        "operator",
        "value",
      ]);
      const operator = boundedString(condition.operator, 2, 20);
      if (!QUERY_FILTER_OPERATORS.has(operator)) {
        return invalidRoutePayload();
      }
      const values = Object.freeze(
        queryArray(condition.value, 0, 20).map((item) =>
          boundedString(item, 1, 500),
        ),
      );
      const emptyOperator = operator === "isEmpty" || operator === "isNotEmpty";
      if (
        (emptyOperator && values.length !== 0) ||
        (!emptyOperator && values.length < 1)
      ) {
        return invalidRoutePayload();
      }
      return Object.freeze({
        field_name: queryFieldName(condition.field_name),
        operator,
        value: values,
      });
    }),
  );
  return Object.freeze({
    type: 1,
    conjunction: filters.conjunction,
    conditions,
  });
}

function querySort(
  value: JsonValue | undefined,
  aliases: ReadonlySet<string>,
): readonly JsonObject[] {
  const seen = new Set<string>();
  return Object.freeze(
    queryArray(value, 0, 10).map((entry) => {
      const sort = strictObject(entry, ["field_name", "order"]);
      const fieldName = boundedString(sort.field_name, 1, 32);
      if (
        !aliases.has(fieldName) ||
        seen.has(fieldName) ||
        (sort.order !== "asc" && sort.order !== "desc")
      ) {
        return invalidRoutePayload();
      }
      seen.add(fieldName);
      return Object.freeze({ field_name: fieldName, order: sort.order });
    }),
  );
}

function baseDataQueryPayload(value: unknown): JsonObject {
  const input = strictObject(value, ["baseToken", "dsl"]);
  const dsl = strictObjectWithOptional(
    input.dsl,
    ["datasource", "dimensions", "measures", "sort", "pagination", "shaper"],
    ["filters"],
  );
  const datasource = strictObject(dsl.datasource, ["type", "table"]);
  const table = strictObject(datasource.table, ["tableId"]);
  if (datasource.type !== "table") return invalidRoutePayload();
  const dimensions = queryDimensions(dsl.dimensions);
  const measures = queryMeasures(dsl.measures);
  if (dimensions.length === 0 && measures.length === 0) {
    return invalidRoutePayload();
  }
  const aliases = new Set<string>([
    ...dimensions.map((entry) => String(entry.alias)),
    ...measures.map((entry) => String(entry.alias)),
  ]);
  const filters = Object.hasOwn(dsl, "filters")
    ? queryFilters(dsl.filters)
    : undefined;
  const sort = querySort(dsl.sort, aliases);
  const pagination = strictObject(dsl.pagination, ["limit"]);
  if (
    typeof pagination.limit !== "number" ||
    !Number.isSafeInteger(pagination.limit) ||
    pagination.limit < 1 ||
    pagination.limit > 5_000
  ) {
    return invalidRoutePayload();
  }
  const shaper = strictObject(dsl.shaper, ["format"]);
  if (shaper.format !== "flat") return invalidRoutePayload();
  const canonicalDsl = Object.freeze({
    datasource: Object.freeze({
      type: "table",
      table: Object.freeze({ tableId: cliToken(table.tableId) }),
    }),
    dimensions,
    measures,
    ...(filters === undefined ? {} : { filters }),
    sort,
    pagination: Object.freeze({ limit: pagination.limit }),
    shaper: Object.freeze({ format: "flat" }),
  });
  if (
    Buffer.byteLength(JSON.stringify(canonicalDsl), "utf8") >
    MAX_QUERY_DSL_BYTES
  ) {
    return invalidRoutePayload();
  }
  return Object.freeze({
    baseToken: cliToken(input.baseToken),
    dsl: canonicalDsl,
  });
}

function asObject(value: JsonValue): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid trusted mvp lark-cli payload");
  }
  return value as JsonObject;
}

function plan(operationArgs: readonly string[]): LarkCliInvocationPlan {
  return Object.freeze({
    operationArgs: Object.freeze([...operationArgs]),
    jsonInputs: Object.freeze([]),
    textInputs: Object.freeze([]),
    fileInputs: Object.freeze([]),
  });
}

function optionalQuery(payload: JsonObject): readonly string[] {
  return typeof payload.query === "string"
    ? Object.freeze(["--query", payload.query])
    : Object.freeze([]);
}

function minutesFlags(payload: JsonObject): readonly string[] {
  const artifacts = payload.artifacts;
  if (!Array.isArray(artifacts)) {
    throw new Error("invalid trusted minutes artifacts");
  }
  const flags: string[] = [];
  if (artifacts.includes("summary")) flags.push("--summary");
  if (artifacts.includes("todos")) flags.push("--todo");
  return Object.freeze(flags);
}

function attendeeFlags(payload: JsonObject): readonly string[] {
  const attendees = payload.attendeeOpenIds;
  if (!Array.isArray(attendees) || attendees.length === 0) {
    return Object.freeze([]);
  }
  return Object.freeze(["--attendee-ids", attendees.join(",")]);
}

function descriptionFlags(payload: JsonObject): readonly string[] {
  return typeof payload.description === "string"
    ? Object.freeze(["--description", payload.description])
    : Object.freeze([]);
}

function tableScopeArgs(payload: JsonObject): readonly string[] {
  return Object.freeze([
    "--base-token",
    String(payload.baseToken),
    "--table-id",
    String(payload.tableId),
  ]);
}

function viewFlags(payload: JsonObject): readonly string[] {
  return typeof payload.viewId === "string"
    ? Object.freeze(["--view-id", payload.viewId])
    : Object.freeze([]);
}

function fieldProjectionFlags(payload: JsonObject): readonly string[] {
  if (!Array.isArray(payload.fieldIds)) {
    throw new Error("invalid trusted Base field IDs");
  }
  return Object.freeze([
    "--field-names",
    payload.fieldIds.map((fieldId) => String(fieldId)).join(","),
  ]);
}

export function createMvpLarkCliRouteRegistry(): LarkCliRouteRegistry {
  const routes: readonly LarkCliRoute[] = [
    {
      identity: "user",
      operation: "minutes.search",
      effect: "read",
      parsePayload: minutesSearchPayload,
      buildInvocation: (value) => {
        const payload = asObject(value);
        return plan([
          "minutes",
          "+search",
          "--start",
          String(payload.start),
          "--end",
          String(payload.end),
          ...optionalQuery(payload),
          "--page-size",
          "15",
        ]);
      },
    },
    {
      identity: "user",
      operation: "minutes.detail",
      effect: "read",
      parsePayload: minutesDetailPayload,
      buildInvocation: (value) => {
        const payload = asObject(value);
        return plan([
          "minutes",
          "+detail",
          "--minute-tokens",
          String(payload.minuteToken),
          ...minutesFlags(payload),
        ]);
      },
    },
    {
      identity: "user",
      operation: "contact.self",
      effect: "read",
      parsePayload: contactSelfPayload,
      buildInvocation: () =>
        plan([
          "contact",
          "+search-user",
          "--user-ids",
          "me",
          "--page-size",
          "20",
          "--exclude-external-users",
        ]),
    },
    {
      identity: "user",
      operation: "contact.search",
      effect: "read",
      parsePayload: contactSearchPayload,
      buildInvocation: (value) => {
        const payload = asObject(value);
        return plan([
          "contact",
          "+search-user",
          "--query",
          String(payload.query),
          "--page-size",
          "20",
          "--exclude-external-users",
        ]);
      },
    },
    {
      identity: "bot",
      operation: "message.send",
      effect: "write",
      parsePayload: messageSendPayload,
      buildInvocation: (value) => {
        const payload = asObject(value);
        return plan([
          "im",
          "+messages-send",
          "--user-id",
          String(payload.recipientOpenId),
          "--text",
          String(payload.text),
          "--idempotency-key",
          String(payload.idempotencyKey),
        ]);
      },
    },
    {
      identity: "bot",
      operation: "notification.send.text",
      effect: "write",
      parsePayload: notificationTextPayload,
      buildInvocation: (value) => {
        const payload = asObject(value);
        return plan([
          "im",
          "+messages-send",
          "--user-id",
          String(payload.recipientOpenId),
          "--text",
          String(payload.text),
          "--idempotency-key",
          String(payload.idempotencyKey),
        ]);
      },
    },
    {
      identity: "bot",
      operation: "notification.send.card",
      effect: "write",
      parsePayload: notificationCardPayload,
      buildInvocation: (value) => {
        const payload = asObject(value);
        return Object.freeze({
          operationArgs: Object.freeze([
            "im",
            "+messages-send",
            "--user-id",
            String(payload.recipientOpenId),
            "--msg-type",
            "interactive",
            "--idempotency-key",
            String(payload.idempotencyKey),
          ]),
          jsonInputs: Object.freeze([]),
          textInputs: Object.freeze([
            Object.freeze({
              flag: "--content" as const,
              fileName: "content.xml" as const,
              value: JSON.stringify(payload.card),
            }),
          ]),
          fileInputs: Object.freeze([]),
        });
      },
    },
    ...(["image", "file"] as const).map(
      (kind): LarkCliRoute => ({
        identity: "bot",
        operation: `notification.send.${kind}`,
        effect: "write",
        parsePayload: notificationAttachmentPayload,
        buildInvocation: (value) => {
          const payload = asObject(value);
          return Object.freeze({
            operationArgs: Object.freeze([
              "im",
              "+messages-send",
              "--user-id",
              String(payload.recipientOpenId),
              "--idempotency-key",
              String(payload.idempotencyKey),
            ]),
            jsonInputs: Object.freeze([]),
            textInputs: Object.freeze([]),
            fileInputs: Object.freeze([
              Object.freeze({
                flag:
                  kind === "image" ? ("--image" as const) : ("--file" as const),
                sourceRelativePath: String(payload.sourceRelativePath),
                outputFileName: String(payload.outputFileName),
                sizeBytes: Number(payload.sizeBytes),
                sha256: String(payload.sha256) as `sha256:${string}`,
              }),
            ]),
          });
        },
      }),
    ),
    {
      identity: "user",
      operation: "calendar.create",
      effect: "write",
      parsePayload: calendarCreatePayload,
      buildInvocation: (value) => {
        const payload = asObject(value);
        return plan([
          "calendar",
          "+create",
          "--calendar-id",
          "primary",
          "--summary",
          String(payload.title),
          "--start",
          String(payload.start),
          "--end",
          String(payload.end),
          ...descriptionFlags(payload),
          ...attendeeFlags(payload),
        ]);
      },
    },
    {
      identity: "user",
      operation: "document.report.create",
      effect: "write",
      parsePayload: reportDocumentPayload,
      buildInvocation: (value) => {
        const payload = asObject(value);
        return Object.freeze({
          operationArgs: Object.freeze([
            "docs",
            "+create",
            "--doc-format",
            "xml",
            "--parent-position",
            "my_library",
          ]),
          jsonInputs: Object.freeze([]),
          textInputs: Object.freeze([
            Object.freeze({
              flag: "--content" as const,
              fileName: "content.xml" as const,
              value: String(payload.content),
            }),
          ]),
          fileInputs: Object.freeze([]),
        });
      },
    },
    {
      identity: "user",
      operation: "base.url.resolve",
      effect: "read",
      parsePayload: baseUrlResolvePayload,
      buildInvocation: (value) => {
        const payload = asObject(value);
        return plan(["base", "+url-resolve", "--url", String(payload.url)]);
      },
    },
    {
      identity: "user",
      operation: "base.title.resolve",
      effect: "read",
      parsePayload: baseTitleResolvePayload,
      buildInvocation: (value) => {
        const payload = asObject(value);
        return plan([
          "base",
          "+title-resolve",
          "--title",
          String(payload.title),
        ]);
      },
    },
    {
      identity: "user",
      operation: "base.app.get",
      effect: "read",
      parsePayload: baseAppGetPayload,
      buildInvocation: (value) => {
        const payload = asObject(value);
        return plan([
          "base",
          "+base-get",
          "--base-token",
          String(payload.baseToken),
        ]);
      },
    },
    {
      identity: "user",
      operation: "base.table.list",
      effect: "read",
      parsePayload: baseTableListPayload,
      buildInvocation: (value) => {
        const payload = asObject(value);
        return plan([
          "base",
          "+table-list",
          "--base-token",
          String(payload.baseToken),
          "--offset",
          String(payload.offset),
          "--limit",
          "100",
        ]);
      },
    },
    {
      identity: "user",
      operation: "base.field.list",
      effect: "read",
      parsePayload: baseTableScopedListPayload,
      buildInvocation: (value) => {
        const payload = asObject(value);
        return plan([
          "base",
          "+field-list",
          ...tableScopeArgs(payload),
          "--offset",
          String(payload.offset),
          "--limit",
          "200",
        ]);
      },
    },
    {
      identity: "user",
      operation: "base.view.list",
      effect: "read",
      parsePayload: baseTableScopedListPayload,
      buildInvocation: (value) => {
        const payload = asObject(value);
        return plan([
          "base",
          "+view-list",
          ...tableScopeArgs(payload),
          "--offset",
          String(payload.offset),
          "--limit",
          "200",
        ]);
      },
    },
    {
      identity: "user",
      operation: "base.record.list",
      effect: "read",
      parsePayload: baseRecordListPayload,
      buildInvocation: (value) => {
        const payload = asObject(value);
        return plan([
          "base",
          "+record-list",
          ...tableScopeArgs(payload),
          ...viewFlags(payload),
          ...fieldProjectionFlags(payload),
          "--offset",
          String(payload.offset),
          "--limit",
          "200",
        ]);
      },
    },
    {
      identity: "user",
      operation: "base.data.query",
      effect: "read",
      parsePayload: baseDataQueryPayload,
      buildInvocation: (value) => {
        const payload = asObject(value);
        return plan([
          "base",
          "+data-query",
          "--base-token",
          String(payload.baseToken),
          "--dsl",
          JSON.stringify(payload.dsl),
        ]);
      },
    },
  ];
  return createLarkCliRouteRegistry(routes);
}
