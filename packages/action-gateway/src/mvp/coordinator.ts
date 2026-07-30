import { randomUUID } from "node:crypto";
import type {
  ActionJsonValue,
  ActionRecord,
  ApprovedAction,
  ClaimedAction,
  DispatchingAction,
  JobStore,
} from "@executive-assistant/job-store";

import { snapshotStrictJson, type JsonValue } from "../ipc/framing.js";
import type { LarkCliRequest, LarkCliRunResult } from "./lark-types.js";
import type { MvpLarkCliRunner } from "./registry.js";
import { isStrictShanghaiTimestamp } from "./validation.js";

export type MvpDispatchCoordinatorStore = Pick<
  JobStore,
  "claimApprovedAction" | "markDispatching" | "finishAction"
>;

export type MvpCoordinatorStore = MvpDispatchCoordinatorStore &
  Pick<JobStore, "approveAction">;

export type MvpDispatchAction = Readonly<{
  actionId: string;
  version: 1;
  capability: string;
  identity: "bot" | "user";
  payload: Readonly<Record<string, JsonValue>>;
  payloadHash: string;
  idempotencyKey: string;
}>;

export type MvpProviderResult =
  | Readonly<{ state: "SUCCEEDED"; remoteId?: string }>
  | Readonly<{ state: "FAILED" }>
  | Readonly<{ state: "UNKNOWN" }>;

export interface MvpMutationProvider {
  dispatch(action: MvpDispatchAction): Promise<MvpProviderResult>;
}

export type MvpDispatchStateMachineResult =
  | Readonly<{
      state: "NOT_DISPATCHED";
      actionId: string;
      reason: "CLAIM_UNAVAILABLE" | "DISPATCH_START_UNAVAILABLE";
      retryable: false;
    }>
  | Readonly<{
      state: "SUCCEEDED" | "FAILED" | "UNKNOWN";
      actionId: string;
      remoteId?: string;
    }>;

export type MvpConfirmationCoordinator = Readonly<{
  approveAndDispatch(input: unknown): Promise<
    | Readonly<{ state: "REJECTED" | "NOT_DISPATCHED" }>
    | Readonly<{
        state: "SUCCEEDED" | "FAILED" | "UNKNOWN";
        actionId: string;
        remoteId?: string;
      }>
  >;
}>;

type JsonObject = Readonly<Record<string, JsonValue>>;
type FinishedAction = NonNullable<ReturnType<JobStore["finishAction"]>>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{1,252}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;
const MAX_REPORT_XML_BYTES = 256 * 1024;
const REPORT_SECTION_HEADINGS = Object.freeze([
  "核心结论",
  "关键数据",
  "异常与风险",
  "建议动作",
  "数据来源与口径",
] as const);

type ConfirmationInput = Readonly<{
  version: 1;
  actionId: string;
  actionPayloadHash: string;
  nonce: string;
  decision: "approve" | "reject";
  actorOpenId: string;
  chatId: string;
}>;

function invalidCoordinatorInput(): never {
  throw new Error("invalid mvp confirmation");
}

function jsonObject(value: unknown): JsonObject {
  const snapshot = snapshotStrictJson(value);
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    return invalidCoordinatorInput();
  }
  return snapshot as JsonObject;
}

function exactKeys(value: JsonObject, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key))
  ) {
    invalidCoordinatorInput();
  }
}

function boundString(value: JsonValue | undefined, maximum = 256): string {
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
    return invalidCoordinatorInput();
  }
  return value;
}

function parseConfirmation(value: unknown): ConfirmationInput {
  const input = jsonObject(value);
  exactKeys(input, [
    "version",
    "actionId",
    "actionPayloadHash",
    "nonce",
    "decision",
    "actorOpenId",
    "chatId",
  ]);
  const actionId = boundString(input.actionId);
  const actionPayloadHash = boundString(input.actionPayloadHash);
  const nonce = boundString(input.nonce);
  const actorOpenId = boundString(input.actorOpenId);
  const chatId = boundString(input.chatId);
  if (
    input.version !== 1 ||
    !UUID_PATTERN.test(actionId) ||
    !SHA256_PATTERN.test(actionPayloadHash) ||
    (input.decision !== "approve" && input.decision !== "reject")
  ) {
    return invalidCoordinatorInput();
  }
  return Object.freeze({
    version: 1,
    actionId,
    actionPayloadHash,
    nonce,
    decision: input.decision,
    actorOpenId,
    chatId,
  });
}

function validOpenId(value: JsonValue | undefined): string {
  const id = boundString(value);
  if (!OPEN_ID_PATTERN.test(id)) return invalidCoordinatorInput();
  return id;
}

function validText(value: JsonValue | undefined, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim().length === 0
  ) {
    return invalidCoordinatorInput();
  }
  return value;
}

function validShanghaiTimestamp(value: JsonValue | undefined): string {
  const timestamp = boundString(value, 40);
  if (!isStrictShanghaiTimestamp(timestamp)) {
    return invalidCoordinatorInput();
  }
  return timestamp;
}

function validateMessagePayload(payload: ActionJsonValue): JsonObject {
  const input = jsonObject(payload);
  exactKeys(input, ["receiveIdType", "recipientOpenId", "text"]);
  if (input.receiveIdType !== "open_id") return invalidCoordinatorInput();
  return Object.freeze({
    receiveIdType: "open_id",
    recipientOpenId: validOpenId(input.recipientOpenId),
    text: validText(input.text, 20_000),
  });
}

function validateCalendarPayload(payload: ActionJsonValue): JsonObject {
  const input = jsonObject(payload);
  exactKeys(input, [
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
    return invalidCoordinatorInput();
  }
  const start = validShanghaiTimestamp(input.start);
  const end = validShanghaiTimestamp(input.end);
  if (Date.parse(start) >= Date.parse(end)) return invalidCoordinatorInput();
  const attendees = input.attendeeOpenIds.map((entry) => validOpenId(entry));
  if (attendees.length > 50 || new Set(attendees).size !== attendees.length) {
    return invalidCoordinatorInput();
  }
  return Object.freeze({
    calendar: "primary",
    title: validText(input.title, 500),
    description:
      input.description === null ? null : validText(input.description, 20_000),
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

function validateReportDocumentPayload(payload: ActionJsonValue): JsonObject {
  const input = jsonObject(payload);
  exactKeys(input, ["docFormat", "parentPosition", "title", "content"]);
  if (input.docFormat !== "xml" || input.parentPosition !== "my_library") {
    return invalidCoordinatorInput();
  }
  const title = boundString(input.title, 500);
  const content = boundString(input.content, MAX_REPORT_XML_BYTES);
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
    return invalidCoordinatorInput();
  }
  return Object.freeze({
    docFormat: "xml",
    parentPosition: "my_library",
    title,
    content,
  });
}

function dispatchAction(action: ActionRecord): MvpDispatchAction {
  if (
    !UUID_PATTERN.test(action.actionId) ||
    action.version !== 1 ||
    !SHA256_PATTERN.test(action.payloadHash) ||
    typeof action.idempotencyKey !== "string" ||
    action.idempotencyKey.length > 50 ||
    !UUID_PATTERN.test(action.idempotencyKey)
  ) {
    return invalidCoordinatorInput();
  }
  if (action.capability === "message.send" && action.identity === "bot") {
    return Object.freeze({
      actionId: action.actionId,
      version: 1,
      capability: "message.send",
      identity: "bot",
      payload: validateMessagePayload(action.payload),
      payloadHash: action.payloadHash,
      idempotencyKey: action.idempotencyKey,
    });
  }
  if (action.capability === "calendar.create" && action.identity === "user") {
    return Object.freeze({
      actionId: action.actionId,
      version: 1,
      capability: "calendar.create",
      identity: "user",
      payload: validateCalendarPayload(action.payload),
      payloadHash: action.payloadHash,
      idempotencyKey: action.idempotencyKey,
    });
  }
  return invalidCoordinatorInput();
}

function directCalendarDispatchAction(
  action: MvpDispatchAction,
): MvpDispatchAction {
  if (
    !UUID_PATTERN.test(action.actionId) ||
    action.version !== 1 ||
    !SHA256_PATTERN.test(action.payloadHash) ||
    typeof action.idempotencyKey !== "string" ||
    action.idempotencyKey.length > 50 ||
    !UUID_PATTERN.test(action.idempotencyKey) ||
    action.capability !== "calendar.create.direct" ||
    action.identity !== "user"
  ) {
    return invalidCoordinatorInput();
  }
  return Object.freeze({
    actionId: action.actionId,
    version: 1,
    capability: "calendar.create.direct",
    identity: "user",
    payload: validateCalendarPayload(action.payload as ActionJsonValue),
    payloadHash: action.payloadHash,
    idempotencyKey: action.idempotencyKey,
  });
}

function directReportDocumentDispatchAction(
  action: MvpDispatchAction,
): MvpDispatchAction {
  if (
    !UUID_PATTERN.test(action.actionId) ||
    action.version !== 1 ||
    !SHA256_PATTERN.test(action.payloadHash) ||
    typeof action.idempotencyKey !== "string" ||
    action.idempotencyKey.length > 50 ||
    !UUID_PATTERN.test(action.idempotencyKey) ||
    action.capability !== "document.report.create" ||
    action.identity !== "user"
  ) {
    return invalidCoordinatorInput();
  }
  return Object.freeze({
    actionId: action.actionId,
    version: 1,
    capability: "document.report.create",
    identity: "user",
    payload: validateReportDocumentPayload(action.payload as ActionJsonValue),
    payloadHash: action.payloadHash,
    idempotencyKey: action.idempotencyKey,
  });
}

function providerResult(value: unknown): MvpProviderResult {
  const result = jsonObject(value);
  if (result.state === "SUCCEEDED") {
    if (
      !Object.keys(result).every((key) =>
        ["state", "remoteId"].includes(key),
      ) ||
      Object.keys(result).length > 2 ||
      (Object.hasOwn(result, "remoteId") && typeof result.remoteId !== "string")
    ) {
      return invalidCoordinatorInput();
    }
    return typeof result.remoteId === "string"
      ? Object.freeze({ state: "SUCCEEDED", remoteId: result.remoteId })
      : Object.freeze({ state: "SUCCEEDED" });
  }
  if (
    (result.state === "FAILED" || result.state === "UNKNOWN") &&
    Object.keys(result).length === 1
  ) {
    return Object.freeze({ state: result.state });
  }
  return invalidCoordinatorInput();
}

function timestamp(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("invalid mvp coordinator clock");
  }
  return new Date(value.getTime());
}

function requireApproved(
  value: ApprovedAction,
  confirmation: ConfirmationInput,
): ApprovedAction {
  if (
    value.actionId !== confirmation.actionId ||
    value.version !== 1 ||
    value.payloadHash !== confirmation.actionPayloadHash
  ) {
    return invalidCoordinatorInput();
  }
  return value;
}

function requireClaimed(
  value: ClaimedAction | null,
  expectedActionId: string,
  projectAction: (action: ActionRecord) => MvpDispatchAction,
): ClaimedAction | null {
  if (value === null) return null;
  if (
    value.actionId !== expectedActionId ||
    value.state !== "CLAIMED" ||
    value.leaseExpiresAt === null ||
    !Number.isFinite(Date.parse(value.leaseExpiresAt))
  ) {
    return invalidCoordinatorInput();
  }
  projectAction(value);
  return value;
}

function requireDispatching(
  value: DispatchingAction | null,
  expectedActionId: string,
  projectAction: (action: ActionRecord) => MvpDispatchAction,
): DispatchingAction | null {
  if (value === null) return null;
  if (value.actionId !== expectedActionId || value.state !== "DISPATCHING") {
    return invalidCoordinatorInput();
  }
  projectAction(value);
  return value;
}

function requireFinished(
  value: FinishedAction | null,
  expectedActionId: string,
  expected: "SUCCEEDED" | "FAILED" | "UNKNOWN",
): FinishedAction {
  if (
    value === null ||
    value.actionId !== expectedActionId ||
    value.state !== expected
  ) {
    return invalidCoordinatorInput();
  }
  return value;
}

export async function executeMvpDispatchStateMachine(
  dependencies: Readonly<{
    store: MvpDispatchCoordinatorStore;
    provider: MvpMutationProvider;
    owner: string;
    clock: () => Date;
    leaseTtlMs: number;
    projectAction: (action: ActionRecord) => MvpDispatchAction;
  }>,
  actionId: string,
): Promise<MvpDispatchStateMachineResult> {
  const claimed = requireClaimed(
    dependencies.store.claimApprovedAction({
      actionId,
      version: 1,
      owner: dependencies.owner,
      now: timestamp(dependencies.clock),
      ttlMs: dependencies.leaseTtlMs,
    }),
    actionId,
    dependencies.projectAction,
  );
  if (claimed === null) {
    return Object.freeze({
      state: "NOT_DISPATCHED",
      actionId,
      reason: "CLAIM_UNAVAILABLE",
      retryable: false,
    });
  }

  const leaseExpiresAt = claimed.leaseExpiresAt;
  const attemptId = randomUUID();
  const started = requireDispatching(
    dependencies.store.markDispatching({
      actionId: claimed.actionId,
      version: 1,
      owner: dependencies.owner,
      leaseExpiresAt,
      now: timestamp(dependencies.clock),
      attemptId,
      requestDigest: claimed.payloadHash,
    }),
    claimed.actionId,
    dependencies.projectAction,
  );
  if (started === null) {
    return Object.freeze({
      state: "NOT_DISPATCHED",
      actionId,
      reason: "DISPATCH_START_UNAVAILABLE",
      retryable: false,
    });
  }

  let outcome: MvpProviderResult;
  try {
    outcome = providerResult(
      await dependencies.provider.dispatch(dependencies.projectAction(started)),
    );
  } catch {
    outcome = Object.freeze({ state: "UNKNOWN" });
  }
  const persistenceOutcome =
    outcome.state === "FAILED" ? "FAILED_DEFINITE" : outcome.state;
  const remoteId = outcome.state === "SUCCEEDED" ? outcome.remoteId : undefined;
  let finished: FinishedAction | null;
  try {
    finished = dependencies.store.finishAction({
      actionId: started.actionId,
      version: 1,
      owner: dependencies.owner,
      leaseExpiresAt,
      now: timestamp(dependencies.clock),
      attemptId,
      outcome: persistenceOutcome,
      ...(typeof remoteId === "string" ? { remoteId } : {}),
    });
    if (finished !== null) {
      requireFinished(finished, started.actionId, outcome.state);
    }
  } catch {
    return Object.freeze({
      state: "UNKNOWN",
      actionId: started.actionId,
    });
  }
  if (finished === null) {
    return Object.freeze({
      state: "UNKNOWN",
      actionId: started.actionId,
    });
  }
  return typeof remoteId === "string"
    ? Object.freeze({
        state: finished.state,
        actionId: finished.actionId,
        remoteId,
      })
    : Object.freeze({
        state: finished.state,
        actionId: finished.actionId,
      });
}

export function createMvpConfirmationCoordinator(
  dependencies: Readonly<{
    store: MvpCoordinatorStore;
    provider: MvpMutationProvider;
    owner: string;
    now?: () => Date;
    leaseTtlMs?: number;
  }>,
): MvpConfirmationCoordinator {
  if (
    dependencies === null ||
    typeof dependencies !== "object" ||
    dependencies.store === null ||
    typeof dependencies.store !== "object" ||
    typeof dependencies.store.approveAction !== "function" ||
    typeof dependencies.store.claimApprovedAction !== "function" ||
    typeof dependencies.store.markDispatching !== "function" ||
    typeof dependencies.store.finishAction !== "function" ||
    dependencies.provider === null ||
    typeof dependencies.provider !== "object" ||
    typeof dependencies.provider.dispatch !== "function" ||
    typeof dependencies.owner !== "string" ||
    dependencies.owner.length < 1 ||
    dependencies.owner.length > 128 ||
    (dependencies.now !== undefined && typeof dependencies.now !== "function")
  ) {
    throw new Error("invalid mvp coordinator dependencies");
  }
  const leaseTtlMs = dependencies.leaseTtlMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0) {
    throw new Error("invalid mvp coordinator lease");
  }
  const approve = dependencies.store.approveAction.bind(dependencies.store);
  const clock = dependencies.now ?? (() => new Date());

  return Object.freeze({
    async approveAndDispatch(input: unknown) {
      const confirmation = parseConfirmation(input);
      const approvalTime = timestamp(clock);
      const approved = requireApproved(
        approve({
          actionId: confirmation.actionId,
          version: 1,
          actionPayloadHash: confirmation.actionPayloadHash,
          nonce: confirmation.nonce,
          decision: confirmation.decision,
          actorOpenId: confirmation.actorOpenId,
          chatId: confirmation.chatId,
          now: approvalTime,
        }),
        confirmation,
      );
      if (approved.state === "FAILED") {
        return Object.freeze({ state: "REJECTED" as const });
      }

      const result = await executeMvpDispatchStateMachine(
        {
          store: dependencies.store,
          provider: dependencies.provider,
          owner: dependencies.owner,
          clock,
          leaseTtlMs,
          projectAction: dispatchAction,
        },
        confirmation.actionId,
      );
      if (result.state === "NOT_DISPATCHED") {
        return Object.freeze({ state: "NOT_DISPATCHED" as const });
      }
      return result;
    },
  });
}

function runnerProviderResult(result: LarkCliRunResult): MvpProviderResult {
  switch (result.state) {
    case "SUCCEEDED":
      return Object.freeze({ state: "SUCCEEDED" });
    case "FAILED":
      return Object.freeze({ state: "FAILED" });
    case "UNKNOWN":
      return Object.freeze({ state: "UNKNOWN" });
  }
}

function directCalendarRunnerResult(
  result: LarkCliRunResult,
  action: MvpDispatchAction,
): MvpProviderResult {
  if (result.state !== "SUCCEEDED") return runnerProviderResult(result);
  const root = jsonObject(result.value);
  exactKeys(root, ["ok", "identity", "data"]);
  if (root.ok !== true || root.identity !== "user") {
    return invalidCoordinatorInput();
  }
  const data = jsonObject(root.data);
  exactKeys(data, ["event_id", "summary", "start", "end"]);
  const eventId = boundString(data.event_id, 512);
  if (
    !EVENT_ID_PATTERN.test(eventId) ||
    data.summary !== action.payload.title ||
    data.start !== action.payload.start ||
    data.end !== action.payload.end
  ) {
    return invalidCoordinatorInput();
  }
  return Object.freeze({ state: "SUCCEEDED", remoteId: eventId });
}

function trustedDocumentUrl(
  value: JsonValue | undefined,
  documentId: string,
): string {
  const url = boundString(value, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return invalidCoordinatorInput();
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
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== `/docx/${documentId}`
  ) {
    return invalidCoordinatorInput();
  }
  return url;
}

function directReportDocumentRunnerResult(
  result: LarkCliRunResult,
): MvpProviderResult {
  if (result.state !== "SUCCEEDED") return runnerProviderResult(result);
  const root = jsonObject(result.value);
  exactKeys(root, ["ok", "identity", "data"]);
  if (root.ok !== true || root.identity !== "user") {
    return invalidCoordinatorInput();
  }
  const data = jsonObject(root.data);
  exactKeys(data, ["document"]);
  const document = jsonObject(data.document);
  exactKeys(document, ["document_id", "revision_id", "url"]);
  const documentId = boundString(document.document_id, 256);
  if (
    !DOCUMENT_ID_PATTERN.test(documentId) ||
    typeof document.revision_id !== "number" ||
    !Number.isSafeInteger(document.revision_id) ||
    document.revision_id < 1
  ) {
    return invalidCoordinatorInput();
  }
  trustedDocumentUrl(document.url, documentId);
  return Object.freeze({ state: "SUCCEEDED", remoteId: documentId });
}

export function createLarkCliMutationProvider(
  runner: MvpLarkCliRunner,
): MvpMutationProvider {
  if (
    runner === null ||
    typeof runner !== "object" ||
    typeof runner.runBot !== "function" ||
    typeof runner.runUser !== "function"
  ) {
    throw new Error("invalid mvp mutation runner");
  }
  const runBot = runner.runBot.bind(runner);
  const runUser = runner.runUser.bind(runner);
  return Object.freeze({
    async dispatch(action: MvpDispatchAction) {
      const trusted = dispatchAction(action as unknown as ActionRecord);
      const request: LarkCliRequest = Object.freeze({
        version: 1,
        operation: trusted.capability,
        payload:
          trusted.capability === "message.send"
            ? jsonObject({
                ...trusted.payload,
                idempotencyKey: trusted.idempotencyKey,
              })
            : trusted.payload,
      });
      return runnerProviderResult(
        trusted.capability === "message.send"
          ? await runBot(request)
          : await runUser(request),
      );
    },
  });
}

export function createLarkCliDirectCalendarProvider(
  runner: MvpLarkCliRunner,
): MvpMutationProvider {
  if (
    runner === null ||
    typeof runner !== "object" ||
    typeof runner.runBot !== "function" ||
    typeof runner.runUser !== "function"
  ) {
    throw new Error("invalid mvp direct calendar runner");
  }
  const runUser = runner.runUser.bind(runner);
  return Object.freeze({
    async dispatch(action: MvpDispatchAction) {
      const trusted = directCalendarDispatchAction(action);
      const result = await runUser(
        Object.freeze({
          version: 1,
          operation: "calendar.create",
          payload: trusted.payload,
        }),
      );
      return directCalendarRunnerResult(result, trusted);
    },
  });
}

export function createLarkCliDirectActionProvider(
  runner: MvpLarkCliRunner,
): MvpMutationProvider {
  if (
    runner === null ||
    typeof runner !== "object" ||
    typeof runner.runBot !== "function" ||
    typeof runner.runUser !== "function"
  ) {
    throw new Error("invalid mvp direct action runner");
  }
  const runUser = runner.runUser.bind(runner);
  return Object.freeze({
    async dispatch(action: MvpDispatchAction) {
      if (action.capability === "calendar.create.direct") {
        const trusted = directCalendarDispatchAction(action);
        const result = await runUser(
          Object.freeze({
            version: 1,
            operation: "calendar.create",
            payload: trusted.payload,
          }),
        );
        return directCalendarRunnerResult(result, trusted);
      }
      if (action.capability === "document.report.create") {
        const trusted = directReportDocumentDispatchAction(action);
        const result = await runUser(
          Object.freeze({
            version: 1,
            operation: "document.report.create",
            payload: trusted.payload,
          }),
        );
        return directReportDocumentRunnerResult(result);
      }
      return invalidCoordinatorInput();
    },
  });
}
