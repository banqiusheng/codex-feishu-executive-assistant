import type {
  JobStore,
  PrepareActionInput,
  PreparedActionWithNonce,
} from "@executive-assistant/job-store";

import { snapshotStrictJson, type JsonValue } from "../ipc/framing.js";
import type { LarkCliRequest, LarkCliRunResult } from "./lark-types.js";
import {
  createGatewayRouteRegistry,
  type GatewayRouteRegistry,
  type RunGatewayHandlerContext,
} from "../ipc/schemas.js";
import { isStrictShanghaiTimestamp } from "./validation.js";
import {
  parseContactResolvePayload,
  type ContactResolvePayload,
  type ContactResolveResult,
} from "./contact-resolver.js";
import {
  planDirectCalendarInstruction,
  type DirectCalendarInstructionPlan,
} from "./direct-calendar.js";
import type { MvpDirectExecutionCoordinator } from "./direct-coordinator.js";
import {
  planNotificationInstruction,
  type MvpNotificationCoordinator,
  type NotificationResolvedResource,
} from "./notification.js";
import {
  parseBaseDataQueryPayload,
  parseBaseRecordsPayload,
  parseBaseResolvePayload,
  parseBaseSchemaPayload,
  type BaseDataQueryPayload,
  type BaseReader,
  type BaseRecordsPayload,
  type BaseResolvePayload,
  type BaseSchemaPayload,
} from "./base-reader.js";
import {
  planReportDocumentInstruction,
  type ReportDocumentInstructionPlan,
} from "./report-document.js";

export const MVP_CAPABILITIES = Object.freeze([
  "minutes.search",
  "minutes.detail",
  "contact.resolve",
  "message.send",
  "calendar.create",
  "calendar.create.direct",
  "notification.send.direct",
  "base.resolve",
  "base.schema.read",
  "base.records.read",
  "base.data.query",
  "document.report.create",
] as const);

export type MvpCapability = (typeof MVP_CAPABILITIES)[number];
export type MvpReadCapability =
  | "minutes.search"
  | "minutes.detail"
  | "contact.resolve"
  | "base.resolve"
  | "base.schema.read"
  | "base.records.read"
  | "base.data.query";
export type MvpMutationCapability = "message.send" | "calendar.create";
export type MvpExecuteCapability =
  | "calendar.create.direct"
  | "notification.send.direct"
  | "document.report.create";

export interface MvpLarkCliRunner {
  runBot(request: LarkCliRequest): Promise<LarkCliRunResult>;
  runUser(request: LarkCliRequest): Promise<LarkCliRunResult>;
}

export type MvpContactResolver = Readonly<{
  resolve(
    taskId: string,
    payload: ContactResolvePayload,
    now: Date,
  ): Promise<ContactResolveResult>;
  dereferenceRecipient(taskId: string, recipientRef: string): string;
}>;

export type MvpActionPreparer = Pick<JobStore, "prepareAction">;

export type MvpPreparedHook = (
  context: RunGatewayHandlerContext,
  prepared: PreparedActionWithNonce,
  preview: Readonly<Record<string, JsonValue>>,
) => void | Promise<void>;

export type MvpRegistryDependencies = Readonly<{
  runner: MvpLarkCliRunner;
  actionStore: MvpActionPreparer;
  contactResolver: MvpContactResolver;
  directExecutor: MvpDirectExecutionCoordinator;
  notificationExecutor: MvpNotificationCoordinator;
  notificationResourceResolver?: (
    taskId: string,
    resourceRef: string,
  ) => NotificationResolvedResource;
  baseReader: BaseReader;
  onPrepared?: MvpPreparedHook;
  now?: () => Date;
  reportDate: Date;
}>;

type JsonObject = Readonly<Record<string, JsonValue>>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{1,252}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;
const MINUTES_ARTIFACTS = Object.freeze(["summary", "todos"] as const);

function invalidPayload(): never {
  throw new Error("invalid mvp capability payload");
}

function strictObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): JsonObject {
  const snapshot = snapshotStrictJson(value);
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    return invalidPayload();
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(snapshot);
  if (
    required.some((key) => !Object.hasOwn(snapshot, key)) ||
    keys.some((key) => !allowed.has(key)) ||
    keys.length < required.length ||
    keys.length > allowed.size
  ) {
    return invalidPayload();
  }
  return snapshot as JsonObject;
}

function boundedString(
  value: JsonValue | undefined,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    value !== value.trim() ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  ) {
    return invalidPayload();
  }
  return value;
}

function nonBlankText(value: JsonValue | undefined, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim().length === 0
  ) {
    return invalidPayload();
  }
  return value;
}

function openId(value: JsonValue | undefined): string {
  const id = boundedString(value, 4, 256);
  if (!OPEN_ID_PATTERN.test(id)) return invalidPayload();
  return id;
}

function shanghaiTimestamp(value: JsonValue | undefined): string {
  const timestamp = boundedString(value, 25, 29);
  if (!isStrictShanghaiTimestamp(timestamp)) {
    return invalidPayload();
  }
  return timestamp;
}

function stringArray(
  value: JsonValue | undefined,
  maximum: number,
  item: (entry: JsonValue | undefined) => string,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    return invalidPayload();
  }
  const entries = value.map((entry) => item(entry));
  if (new Set(entries).size !== entries.length) return invalidPayload();
  return Object.freeze(entries);
}

function frozenObject(value: Record<string, JsonValue>): JsonObject {
  const snapshot = snapshotStrictJson(value);
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    throw new Error("internal mvp object is invalid");
  }
  return snapshot as JsonObject;
}

function parseMinutesSearch(value: unknown): JsonObject {
  const input = strictObject(value, ["start", "end"], ["query"]);
  const start = boundedString(input.start, 20, 40);
  const end = boundedString(input.end, 20, 40);
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    startMs >= endMs
  ) {
    return invalidPayload();
  }
  const output: Record<string, JsonValue> = { start, end };
  if (Object.hasOwn(input, "query")) {
    output.query = boundedString(input.query, 1, 100);
  }
  return frozenObject(output);
}

function parseMinutesDetail(value: unknown): JsonObject {
  const input = strictObject(value, ["minuteToken", "artifacts"]);
  const minuteToken = boundedString(input.minuteToken, 1, 256);
  if (!TOKEN_PATTERN.test(minuteToken)) return invalidPayload();
  const artifacts = stringArray(input.artifacts, 3, (entry) => {
    const artifact = boundedString(entry, 1, 32);
    if (
      !MINUTES_ARTIFACTS.includes(
        artifact as (typeof MINUTES_ARTIFACTS)[number],
      )
    ) {
      return invalidPayload();
    }
    return artifact;
  });
  if (artifacts.length === 0) return invalidPayload();
  const requested = new Set(artifacts);
  const canonicalArtifacts = MINUTES_ARTIFACTS.filter((artifact) =>
    requested.has(artifact),
  );
  return frozenObject({
    minuteToken,
    artifacts: Object.freeze(canonicalArtifacts),
  });
}

function parseMessageSend(value: unknown): JsonObject {
  const input = strictObject(value, ["recipientOpenId", "text"]);
  return frozenObject({
    receiveIdType: "open_id",
    recipientOpenId: openId(input.recipientOpenId),
    text: nonBlankText(input.text, 20_000),
  });
}

function parseCalendarCreate(value: unknown): JsonObject {
  const input = strictObject(
    value,
    ["title", "start", "end", "zone", "attendeeOpenIds"],
    ["description"],
  );
  if (input.zone !== "Asia/Shanghai") return invalidPayload();
  const start = shanghaiTimestamp(input.start);
  const end = shanghaiTimestamp(input.end);
  if (Date.parse(start) >= Date.parse(end)) return invalidPayload();
  const description = Object.hasOwn(input, "description")
    ? nonBlankText(input.description, 20_000)
    : null;
  return frozenObject({
    calendar: "primary",
    title: nonBlankText(input.title, 500),
    description,
    start,
    end,
    zone: "Asia/Shanghai",
    attendeeOpenIds: stringArray(input.attendeeOpenIds, 50, openId),
    recurrence: "none",
  });
}

function parseDirectCalendarRequest(value: unknown): JsonObject {
  return strictObject(
    value,
    ["title", "startLocal", "attendeeRefs"],
    ["description", "endLocal"],
  );
}

function parseDirectNotificationRequest(value: unknown): JsonObject {
  return strictObject(value, ["recipientRefs", "content", "attachmentRefs"]);
}

function parseReportDocumentRequest(value: unknown): JsonObject {
  return strictObject(value, [
    "evidenceRefs",
    "conclusions",
    "metrics",
    "risks",
    "actions",
  ]);
}

function currentTime(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("invalid mvp clock");
  }
  return new Date(value.getTime());
}

function trustedPreparedAction(
  value: PreparedActionWithNonce,
): PreparedActionWithNonce {
  if (
    value === null ||
    typeof value !== "object" ||
    value.version !== 1 ||
    !UUID_PATTERN.test(value.actionId) ||
    !SHA256_PATTERN.test(value.payloadHash) ||
    typeof value.nonce !== "string" ||
    value.nonce.length < 1 ||
    value.state !== "PREPARED" ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    throw new Error("invalid prepared action result");
  }
  return Object.freeze({
    actionId: value.actionId,
    version: 1,
    payloadHash: value.payloadHash,
    nonce: value.nonce,
    expiresAt: value.expiresAt,
    state: "PREPARED",
  });
}

function preparedSummary(
  value: PreparedActionWithNonce,
): Readonly<Record<string, JsonValue>> {
  return Object.freeze({
    actionId: value.actionId,
    version: 1,
    payloadHash: value.payloadHash,
    expiresAt: value.expiresAt,
    state: "PREPARED",
  });
}

function messagePreview(payload: JsonObject): JsonObject {
  return frozenObject({
    action: "message.send",
    identity: "bot",
    recipient: frozenObject({
      type: "user",
      openId: payload.recipientOpenId ?? null,
    }),
    body: frozenObject({ type: "text", text: payload.text ?? null }),
    impact: "将以机器人身份向一名内部用户发送一条消息",
  });
}

function calendarPreview(payload: JsonObject): JsonObject {
  return frozenObject({
    action: "calendar.create",
    identity: "user",
    calendar: "primary",
    recurrence: "none",
    title: payload.title ?? null,
    description: payload.description ?? null,
    start: payload.start ?? null,
    end: payload.end ?? null,
    zone: "Asia/Shanghai",
    attendeeOpenIds: payload.attendeeOpenIds ?? Object.freeze([]),
    videoConference: "自动创建飞书视频会议",
    availability: "忙碌",
    reminder: "提前 5 分钟提醒",
    attendeePermission: "参会人可编辑日程",
    impact: "将在总裁主日历创建一个单次日程",
  });
}

function asJsonObject(value: JsonValue): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("internal mvp route payload is invalid");
  }
  return value as JsonObject;
}

async function prepare(
  context: RunGatewayHandlerContext,
  capability: MvpMutationCapability,
  identity: "bot" | "user",
  payload: JsonObject,
  preview: JsonObject,
  prepareAction: (input: PrepareActionInput) => PreparedActionWithNonce,
  onPrepared: MvpPreparedHook | undefined,
  clock: () => Date,
): Promise<Readonly<Record<string, JsonValue>>> {
  const prepared = trustedPreparedAction(
    prepareAction({
      taskId: context.taskId,
      capability,
      identity,
      payload,
      preview,
      now: currentTime(clock),
    }),
  );
  await onPrepared?.(context, prepared, preview);
  return preparedSummary(prepared);
}

export function createMvpGatewayRegistry(
  dependencies: MvpRegistryDependencies,
): GatewayRouteRegistry {
  if (
    dependencies === null ||
    typeof dependencies !== "object" ||
    dependencies.runner === null ||
    typeof dependencies.runner !== "object" ||
    typeof dependencies.runner.runBot !== "function" ||
    typeof dependencies.runner.runUser !== "function" ||
    dependencies.actionStore === null ||
    typeof dependencies.actionStore !== "object" ||
    typeof dependencies.actionStore.prepareAction !== "function" ||
    (dependencies.onPrepared !== undefined &&
      typeof dependencies.onPrepared !== "function") ||
    dependencies.contactResolver === null ||
    typeof dependencies.contactResolver !== "object" ||
    typeof dependencies.contactResolver.resolve !== "function" ||
    typeof dependencies.contactResolver.dereferenceRecipient !== "function" ||
    dependencies.directExecutor === null ||
    typeof dependencies.directExecutor !== "object" ||
    typeof dependencies.directExecutor.executePresidentInstruction !==
      "function" ||
    dependencies.notificationExecutor === null ||
    typeof dependencies.notificationExecutor !== "object" ||
    typeof dependencies.notificationExecutor.execute !== "function" ||
    (dependencies.notificationResourceResolver !== undefined &&
      typeof dependencies.notificationResourceResolver !== "function") ||
    dependencies.baseReader === null ||
    typeof dependencies.baseReader !== "object" ||
    typeof dependencies.baseReader.resolve !== "function" ||
    typeof dependencies.baseReader.readSchema !== "function" ||
    typeof dependencies.baseReader.readRecords !== "function" ||
    typeof dependencies.baseReader.queryData !== "function" ||
    typeof dependencies.baseReader.getReadEvidence !== "function" ||
    (dependencies.now !== undefined && typeof dependencies.now !== "function")
  ) {
    throw new Error("invalid mvp registry dependencies");
  }
  const runUser = dependencies.runner.runUser.bind(dependencies.runner);
  const prepareAction = dependencies.actionStore.prepareAction.bind(
    dependencies.actionStore,
  );
  const onPrepared = dependencies.onPrepared;
  const resolveContact = dependencies.contactResolver.resolve.bind(
    dependencies.contactResolver,
  );
  const dereferenceContact =
    dependencies.contactResolver.dereferenceRecipient.bind(
      dependencies.contactResolver,
    );
  const executeDirect =
    dependencies.directExecutor.executePresidentInstruction.bind(
      dependencies.directExecutor,
    );
  const executeNotification = dependencies.notificationExecutor.execute.bind(
    dependencies.notificationExecutor,
  );
  const resolveNotificationResource = dependencies.notificationResourceResolver;
  const resolveBase = dependencies.baseReader.resolve.bind(
    dependencies.baseReader,
  );
  const readBaseSchema = dependencies.baseReader.readSchema.bind(
    dependencies.baseReader,
  );
  const readBaseRecords = dependencies.baseReader.readRecords.bind(
    dependencies.baseReader,
  );
  const queryBaseData = dependencies.baseReader.queryData.bind(
    dependencies.baseReader,
  );
  const getBaseReadEvidence = dependencies.baseReader.getReadEvidence.bind(
    dependencies.baseReader,
  );
  const displayNamesByTask = new Map<string, Map<string, string>>();
  const clock = dependencies.now ?? (() => new Date());
  const reportDate = currentTime(() => dependencies.reportDate);

  return createGatewayRouteRegistry([
    {
      channel: "run",
      kind: "read",
      capability: "minutes.search",
      parsePayload: parseMinutesSearch,
      handler: async (_context, payload) =>
        runUser({
          version: 1,
          operation: "minutes.search",
          payload: asJsonObject(payload),
        }),
    },
    {
      channel: "run",
      kind: "read",
      capability: "minutes.detail",
      parsePayload: parseMinutesDetail,
      handler: async (_context, payload) =>
        runUser({
          version: 1,
          operation: "minutes.detail",
          payload: asJsonObject(payload),
        }),
    },
    {
      channel: "run",
      kind: "read",
      capability: "contact.resolve",
      parsePayload: parseContactResolvePayload,
      handler: async (context, payload) => {
        const value = await resolveContact(
          context.taskId,
          payload as unknown as ContactResolvePayload,
          currentTime(clock),
        );
        if (value.status === "RESOLVED") {
          const next = new Map(displayNamesByTask.get(context.taskId));
          for (const recipient of value.recipients) {
            if (
              recipient.status !== "RESOLVED" ||
              typeof recipient.recipientRef !== "string" ||
              !UUID_PATTERN.test(recipient.recipientRef) ||
              typeof recipient.name !== "string" ||
              recipient.name.length < 1 ||
              recipient.name.length > 100
            ) {
              throw new Error("invalid resolved contact result");
            }
            const openId = dereferenceContact(
              context.taskId,
              recipient.recipientRef,
            );
            if (!OPEN_ID_PATTERN.test(openId)) {
              throw new Error("invalid resolved contact binding");
            }
            const existing = next.get(openId);
            if (existing !== undefined && existing !== recipient.name) {
              throw new Error("conflicting resolved contact display name");
            }
            next.set(openId, recipient.name);
          }
          displayNamesByTask.set(context.taskId, next);
        }
        return Object.freeze({
          state: "SUCCEEDED" as const,
          value,
        });
      },
    },
    {
      channel: "run",
      kind: "read",
      capability: "base.resolve",
      parsePayload: parseBaseResolvePayload,
      handler: async (context, payload) =>
        Object.freeze({
          state: "SUCCEEDED" as const,
          value: await resolveBase(
            context.taskId,
            payload as unknown as BaseResolvePayload,
            currentTime(clock),
          ),
        }),
    },
    {
      channel: "run",
      kind: "read",
      capability: "base.schema.read",
      parsePayload: parseBaseSchemaPayload,
      handler: async (context, payload) =>
        Object.freeze({
          state: "SUCCEEDED" as const,
          value: await readBaseSchema(
            context.taskId,
            payload as unknown as BaseSchemaPayload,
            currentTime(clock),
          ),
        }),
    },
    {
      channel: "run",
      kind: "read",
      capability: "base.records.read",
      parsePayload: parseBaseRecordsPayload,
      handler: async (context, payload) =>
        Object.freeze({
          state: "SUCCEEDED" as const,
          value: await readBaseRecords(
            context.taskId,
            payload as unknown as BaseRecordsPayload,
            currentTime(clock),
          ),
        }),
    },
    {
      channel: "run",
      kind: "read",
      capability: "base.data.query",
      parsePayload: parseBaseDataQueryPayload,
      handler: async (context, payload) =>
        Object.freeze({
          state: "SUCCEEDED" as const,
          value: await queryBaseData(
            context.taskId,
            payload as unknown as BaseDataQueryPayload,
            currentTime(clock),
          ),
        }),
    },
    {
      channel: "run",
      kind: "prepare",
      capability: "message.send",
      parsePayload: parseMessageSend,
      handler: (context, payload) => {
        const trustedPayload = asJsonObject(payload);
        return prepare(
          context,
          "message.send",
          "bot",
          trustedPayload,
          messagePreview(trustedPayload),
          prepareAction,
          onPrepared,
          clock,
        );
      },
    },
    {
      channel: "run",
      kind: "prepare",
      capability: "calendar.create",
      parsePayload: parseCalendarCreate,
      handler: (context, payload) => {
        const trustedPayload = asJsonObject(payload);
        return prepare(
          context,
          "calendar.create",
          "user",
          trustedPayload,
          calendarPreview(trustedPayload),
          prepareAction,
          onPrepared,
          clock,
        );
      },
    },
    {
      channel: "run",
      kind: "execute",
      capability: "calendar.create.direct",
      parsePayload: parseDirectCalendarRequest,
      handler: async (context, payload) => {
        const plan = planDirectCalendarInstruction(
          context.taskId,
          payload,
          currentTime(clock),
          (taskId, attendeeRef) => dereferenceContact(taskId, attendeeRef),
        );
        if (plan === null) {
          return Object.freeze({
            state: "NOT_EXECUTED" as const,
            reason: "EVENT_ALREADY_ENDED" as const,
          });
        }
        const displayNames = plan.payload.attendeeOpenIds.map((openId) => {
          const displayName = displayNamesByTask
            .get(context.taskId)
            ?.get(openId);
          if (displayName === undefined) {
            throw new Error("direct calendar attendee display is unavailable");
          }
          return displayName;
        });
        const result = await executeDirect(
          plan as DirectCalendarInstructionPlan,
        );
        if (result.state === "SUCCEEDED") {
          if (
            typeof result.remoteId !== "string" ||
            result.remoteId.length < 1 ||
            result.remoteId.length > 512
          ) {
            return Object.freeze({ state: "UNKNOWN" as const });
          }
          return Object.freeze({
            state: "SUCCEEDED" as const,
            value: Object.freeze({
              eventId: result.remoteId,
              title: plan.payload.title,
              start: plan.payload.start,
              end: plan.payload.end,
              zone: "Asia/Shanghai" as const,
              attendeeDisplayNames: Object.freeze(displayNames),
            }),
          });
        }
        if (result.state === "FAILED") {
          return Object.freeze({ state: "FAILED" as const });
        }
        return Object.freeze({ state: "UNKNOWN" as const });
      },
    },
    {
      channel: "run",
      kind: "execute",
      capability: "document.report.create",
      parsePayload: parseReportDocumentRequest,
      handler: async (context, payload) => {
        const plan = planReportDocumentInstruction(
          context.taskId,
          payload,
          reportDate,
          (taskId, evidenceRef) => getBaseReadEvidence(taskId, evidenceRef),
        );
        const result = await executeDirect(
          plan as ReportDocumentInstructionPlan,
        );
        if (result.state === "SUCCEEDED") {
          if (
            typeof result.remoteId !== "string" ||
            !DOCUMENT_ID_PATTERN.test(result.remoteId)
          ) {
            return Object.freeze({ state: "UNKNOWN" as const });
          }
          return Object.freeze({
            state: "SUCCEEDED" as const,
            value: Object.freeze({
              url: `https://feishu.cn/docx/${result.remoteId}`,
              title: plan.payload.title,
              conclusions: plan.preview.conclusions,
            }),
          });
        }
        if (result.state === "FAILED") {
          return Object.freeze({ state: "FAILED" as const });
        }
        return Object.freeze({ state: "UNKNOWN" as const });
      },
    },
    {
      channel: "run",
      kind: "execute",
      capability: "notification.send.direct",
      parsePayload: parseDirectNotificationRequest,
      handler: async (context, payload) => {
        const plan = planNotificationInstruction(
          context.taskId,
          payload,
          (taskId, recipientRef) => {
            const openId = dereferenceContact(taskId, recipientRef);
            const displayName = displayNamesByTask.get(taskId)?.get(openId);
            if (displayName === undefined) {
              throw new Error(
                "direct notification recipient display is unavailable",
              );
            }
            return Object.freeze({ openId, displayName });
          },
          resolveNotificationResource,
        );
        return executeNotification(plan);
      },
    },
  ]);
}
