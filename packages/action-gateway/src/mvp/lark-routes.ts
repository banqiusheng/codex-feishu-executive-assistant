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
  if (attendees.length > 50 || new Set(attendees).size !== attendees.length) {
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
  ];
  return createLarkCliRouteRegistry(routes);
}
