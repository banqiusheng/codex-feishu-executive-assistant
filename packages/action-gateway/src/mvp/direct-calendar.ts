import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import { snapshotStrictJson, type JsonValue } from "../ipc/framing.js";
import { isStrictShanghaiTimestamp } from "./validation.js";

type JsonObject = Readonly<Record<string, JsonValue>>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{1,252}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const ITEM_KEY_PATTERN = /^calendar:sha256:[0-9a-f]{64}$/;
const LOCAL_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const DEFAULT_DURATION_MS = 60 * 60 * 1_000;
const MAX_ATTENDEES = 20;

export type DirectCalendarInstructionPlan = Readonly<{
  taskId: string;
  capability: "calendar.create.direct";
  identity: "user";
  itemKey: string;
  payload: Readonly<{
    calendar: "primary";
    title: string;
    description: string | null;
    start: string;
    end: string;
    zone: "Asia/Shanghai";
    attendeeOpenIds: readonly string[];
    recurrence: "none";
  }>;
  preview: Readonly<{
    action: "calendar.create.direct";
    title: string;
    description: string | null;
    start: string;
    end: string;
    zone: "Asia/Shanghai";
    attendeeCount: number;
    impact: "将在总裁主日历创建一个单次日程";
  }>;
}>;

export type DirectCalendarPublicResult = Readonly<{
  eventId: string;
  title: string;
  start: string;
  end: string;
  zone: "Asia/Shanghai";
}>;

type LocalTimestamp = Readonly<{
  epochMs: number;
  shanghai: string;
}>;

function invalidPayload(): never {
  throw new Error("invalid direct calendar payload");
}

function invalidTask(): never {
  throw new Error("invalid direct calendar task");
}

function invalidClock(): never {
  throw new Error("invalid direct calendar clock");
}

function invalidAttendee(): never {
  throw new Error("invalid direct calendar attendee");
}

function invalidCliResult(): never {
  throw new Error("invalid direct calendar CLI result");
}

function invalidTrustedPlan(): never {
  throw new Error("invalid trusted direct calendar plan");
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

function strictObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
  error: () => never = invalidPayload,
): JsonObject {
  const snapshot = strictSnapshot(value, error);
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

function exactObject(
  value: JsonValue | undefined,
  expected: readonly string[],
  error: () => never,
): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return error();
  }
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key))
  ) {
    return error();
  }
  return value as JsonObject;
}

function safeText(
  value: JsonValue | undefined,
  maximum: number,
  error: () => never = invalidPayload,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim().length === 0 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  ) {
    return error();
  }
  return value;
}

function exactDate(value: unknown): Date {
  if (
    typeof value !== "object" ||
    value === null ||
    utilTypes.isProxy(value) ||
    !utilTypes.isDate(value) ||
    Object.getPrototypeOf(value) !== Date.prototype ||
    Reflect.ownKeys(value).length !== 0
  ) {
    return invalidClock();
  }
  const epochMs = (value as Date).getTime();
  if (!Number.isFinite(epochMs)) return invalidClock();
  return new Date(epochMs);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function shanghaiFromEpoch(epochMs: number): string {
  const local = new Date(epochMs + SHANGHAI_OFFSET_MS);
  const year = local.getUTCFullYear();
  if (year < 0 || year > 9_999) return invalidPayload();
  return `${pad(year, 4)}-${pad(local.getUTCMonth() + 1)}-${pad(
    local.getUTCDate(),
  )}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(
    local.getUTCSeconds(),
  )}+08:00`;
}

function localTimestamp(value: JsonValue | undefined): LocalTimestamp {
  if (typeof value !== "string") return invalidPayload();
  const match = LOCAL_TIMESTAMP_PATTERN.exec(value);
  if (!match) return invalidPayload();
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    return invalidPayload();
  }
  const [year, month, day, hour, minute, second] = parts as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const wallClock = new Date(0);
  wallClock.setUTCFullYear(year, month - 1, day);
  wallClock.setUTCHours(hour, minute, second, 0);
  if (
    wallClock.getUTCFullYear() !== year ||
    wallClock.getUTCMonth() + 1 !== month ||
    wallClock.getUTCDate() !== day ||
    wallClock.getUTCHours() !== hour ||
    wallClock.getUTCMinutes() !== minute ||
    wallClock.getUTCSeconds() !== second
  ) {
    return invalidPayload();
  }
  const epochMs = wallClock.getTime() - SHANGHAI_OFFSET_MS;
  if (!Number.isFinite(epochMs)) return invalidPayload();
  return Object.freeze({ epochMs, shanghai: `${value}+08:00` });
}

function attendeeRefs(value: JsonValue | undefined): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_ATTENDEES) {
    return invalidPayload();
  }
  const refs = value.map((entry) => {
    if (typeof entry !== "string" || !UUID_PATTERN.test(entry)) {
      return invalidPayload();
    }
    return entry.toLowerCase();
  });
  if (new Set(refs).size !== refs.length) return invalidPayload();
  return Object.freeze(refs);
}

function itemKey(
  title: string,
  description: string | null,
  start: string,
  end: string,
  attendeeOpenIds: readonly string[],
): string {
  const semanticRequest = JSON.stringify({
    title,
    description,
    start,
    end,
    attendeeOpenIds: [...attendeeOpenIds].sort(),
  });
  return `calendar:sha256:${createHash("sha256")
    .update(semanticRequest, "utf8")
    .digest("hex")}`;
}

function resolvedAttendees(
  taskId: string,
  refs: readonly string[],
  dereferenceAttendee: (taskId: string, attendeeRef: string) => string,
): readonly string[] {
  if (typeof dereferenceAttendee !== "function") {
    throw new Error("invalid direct calendar attendee resolver");
  }
  const resolved = refs.map((ref) => {
    let value: unknown;
    try {
      value = dereferenceAttendee(taskId, ref);
    } catch {
      throw new Error("direct calendar attendee is unavailable");
    }
    if (
      typeof value !== "string" ||
      value !== value.trim() ||
      !OPEN_ID_PATTERN.test(value)
    ) {
      return invalidAttendee();
    }
    return value;
  });
  if (new Set(resolved).size !== resolved.length) return invalidAttendee();
  return Object.freeze([...resolved].sort());
}

export function planDirectCalendarInstruction(
  taskId: string,
  value: unknown,
  now: Date,
  dereferenceAttendee: (taskId: string, attendeeRef: string) => string,
): DirectCalendarInstructionPlan | null {
  if (typeof taskId !== "string" || !UUID_PATTERN.test(taskId)) {
    return invalidTask();
  }
  const clock = exactDate(now);
  const input = strictObject(
    value,
    ["title", "startLocal", "attendeeRefs"],
    ["description", "endLocal"],
  );
  const title = safeText(input.title, 500);
  const description = Object.hasOwn(input, "description")
    ? safeText(input.description, 20_000)
    : null;
  const start = localTimestamp(input.startLocal);
  const end = Object.hasOwn(input, "endLocal")
    ? localTimestamp(input.endLocal)
    : Object.freeze({
        epochMs: start.epochMs + DEFAULT_DURATION_MS,
        shanghai: shanghaiFromEpoch(start.epochMs + DEFAULT_DURATION_MS),
      });
  if (start.epochMs >= end.epochMs) return invalidPayload();
  const refs = attendeeRefs(input.attendeeRefs);
  if (end.epochMs <= clock.getTime()) return null;
  const attendeeOpenIds = resolvedAttendees(
    taskId.toLowerCase(),
    refs,
    dereferenceAttendee,
  );
  const payload = Object.freeze({
    calendar: "primary" as const,
    title,
    description,
    start: start.shanghai,
    end: end.shanghai,
    zone: "Asia/Shanghai" as const,
    attendeeOpenIds,
    recurrence: "none" as const,
  });
  const preview = Object.freeze({
    action: "calendar.create.direct" as const,
    title,
    description,
    start: start.shanghai,
    end: end.shanghai,
    zone: "Asia/Shanghai" as const,
    attendeeCount: attendeeOpenIds.length,
    impact: "将在总裁主日历创建一个单次日程" as const,
  });
  return Object.freeze({
    taskId: taskId.toLowerCase(),
    capability: "calendar.create.direct" as const,
    identity: "user" as const,
    itemKey: itemKey(
      title,
      description,
      start.shanghai,
      end.shanghai,
      attendeeOpenIds,
    ),
    payload,
    preview,
  });
}

function trustedPlan(value: unknown): DirectCalendarInstructionPlan {
  const root = strictObject(
    value,
    ["taskId", "capability", "identity", "itemKey", "payload", "preview"],
    [],
    invalidTrustedPlan,
  );
  if (
    typeof root.taskId !== "string" ||
    !UUID_PATTERN.test(root.taskId) ||
    root.capability !== "calendar.create.direct" ||
    root.identity !== "user" ||
    typeof root.itemKey !== "string" ||
    !ITEM_KEY_PATTERN.test(root.itemKey)
  ) {
    return invalidTrustedPlan();
  }
  const payload = exactObject(
    root.payload,
    [
      "calendar",
      "title",
      "description",
      "start",
      "end",
      "zone",
      "attendeeOpenIds",
      "recurrence",
    ],
    invalidTrustedPlan,
  );
  const title = safeText(payload.title, 500, invalidTrustedPlan);
  const description =
    payload.description === null
      ? null
      : safeText(payload.description, 20_000, invalidTrustedPlan);
  if (
    payload.calendar !== "primary" ||
    payload.zone !== "Asia/Shanghai" ||
    payload.recurrence !== "none" ||
    typeof payload.start !== "string" ||
    typeof payload.end !== "string" ||
    !isStrictShanghaiTimestamp(payload.start) ||
    !isStrictShanghaiTimestamp(payload.end) ||
    Date.parse(payload.start) >= Date.parse(payload.end) ||
    !Array.isArray(payload.attendeeOpenIds) ||
    payload.attendeeOpenIds.length > MAX_ATTENDEES
  ) {
    return invalidTrustedPlan();
  }
  const attendees = payload.attendeeOpenIds.map((entry) => {
    if (typeof entry !== "string" || !OPEN_ID_PATTERN.test(entry)) {
      return invalidTrustedPlan();
    }
    return entry;
  });
  if (new Set(attendees).size !== attendees.length) {
    return invalidTrustedPlan();
  }
  const preview = exactObject(
    root.preview,
    [
      "action",
      "title",
      "description",
      "start",
      "end",
      "zone",
      "attendeeCount",
      "impact",
    ],
    invalidTrustedPlan,
  );
  if (
    preview.action !== "calendar.create.direct" ||
    preview.title !== title ||
    preview.description !== description ||
    preview.start !== payload.start ||
    preview.end !== payload.end ||
    preview.zone !== "Asia/Shanghai" ||
    preview.attendeeCount !== attendees.length ||
    preview.impact !== "将在总裁主日历创建一个单次日程"
  ) {
    return invalidTrustedPlan();
  }
  return root as unknown as DirectCalendarInstructionPlan;
}

export function parseDirectCalendarCliResult(
  value: unknown,
  expectedPlan: DirectCalendarInstructionPlan,
): DirectCalendarPublicResult {
  const plan = trustedPlan(expectedPlan);
  const root = strictObject(
    value,
    ["ok", "identity", "data"],
    [],
    invalidCliResult,
  );
  if (root.ok !== true || root.identity !== "user") {
    return invalidCliResult();
  }
  const data = exactObject(
    root.data,
    ["event_id", "summary", "start", "end"],
    invalidCliResult,
  );
  if (
    typeof data.event_id !== "string" ||
    !EVENT_ID_PATTERN.test(data.event_id) ||
    data.summary !== plan.payload.title ||
    data.start !== plan.payload.start ||
    data.end !== plan.payload.end
  ) {
    return invalidCliResult();
  }
  return Object.freeze({
    eventId: data.event_id,
    title: plan.payload.title,
    start: plan.payload.start,
    end: plan.payload.end,
    zone: "Asia/Shanghai",
  });
}
