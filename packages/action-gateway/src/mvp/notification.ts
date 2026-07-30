import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";

import type {
  JobStore,
  NotificationPartState,
  ResolvedTaskResource,
} from "@executive-assistant/job-store";

import { snapshotStrictJson, type JsonValue } from "../ipc/framing.js";
import type { LarkCliRunResult } from "./lark-types.js";
import type { MvpLarkCliRunner } from "./registry.js";

type JsonObject = Readonly<Record<string, JsonValue>>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{1,252}$/;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RAW_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RESOURCE_PATH_PATTERN =
  /^resources\/[0-9]{2}-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:txt|bin)$/;
const MAX_RECIPIENTS = 20;
const MAX_ATTACHMENTS = 20;
const DELIVERY_LEASE_TTL_MS = 60_000;

export type NotificationTextContent = Readonly<{
  kind: "text";
  text: string;
  wording: "composed" | "verbatim";
}>;

export type NotificationDisplayCardContent = Readonly<{
  kind: "display_card";
  title: string;
  source: string;
  body: string;
  items: readonly string[];
  wording: "composed" | "verbatim";
}>;

export type NotificationContent =
  | NotificationTextContent
  | NotificationDisplayCardContent;

export type NotificationResolvedRecipient = Readonly<{
  recipientRef: string;
  openId: string;
  displayName: string;
  recipientBinding: Readonly<{
    provider: "lark";
    recipientOpenId: string;
  }>;
}>;

export type NotificationResolvedResource = Readonly<{
  sourceKind: "current" | "quoted";
  kind: "text" | "image" | "file";
  displayName: string;
  relativePath: string;
  sizeBytes: number;
  sha256: `sha256:${string}`;
  text?: string;
}>;

export type NotificationAttachment = Readonly<{
  kind: "image" | "file";
  displayName: string;
  relativePath: string;
  sizeBytes: number;
  sha256: `sha256:${string}`;
  stableResourceRef: string;
}>;

export function resolveNotificationTaskResource(
  taskWorkspace: string,
  resource: ResolvedTaskResource,
): NotificationResolvedResource {
  try {
    if (
      typeof taskWorkspace !== "string" ||
      resolve(taskWorkspace) !== taskWorkspace ||
      realpathSync(taskWorkspace) !== taskWorkspace ||
      !RESOURCE_PATH_PATTERN.test(resource.relativePath) ||
      !RAW_SHA256_PATTERN.test(resource.sha256) ||
      !Number.isSafeInteger(resource.sizeBytes) ||
      resource.sizeBytes < 1 ||
      resource.sizeBytes > 100 * 1024 * 1024
    ) {
      return invalidPayload();
    }
    const workspaceMetadata = lstatSync(taskWorkspace);
    if (
      workspaceMetadata.isSymbolicLink() ||
      !workspaceMetadata.isDirectory() ||
      (workspaceMetadata.mode & 0o777) !== 0o700 ||
      (typeof process.getuid === "function" &&
        workspaceMetadata.uid !== process.getuid())
    ) {
      return invalidPayload();
    }
    const path = join(taskWorkspace, resource.relativePath);
    if (!path.startsWith(`${taskWorkspace}/`) || realpathSync(path) !== path) {
      return invalidPayload();
    }
    const before = lstatSync(path);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o777) !== 0o600 ||
      before.size !== resource.sizeBytes ||
      (typeof process.getuid === "function" && before.uid !== process.getuid())
    ) {
      return invalidPayload();
    }
    const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.nlink !== 1 ||
        opened.size !== resource.sizeBytes ||
        (opened.mode & 0o777) !== 0o600
      ) {
        return invalidPayload();
      }
      bytes = Buffer.alloc(resource.sizeBytes);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(
          fd,
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (count <= 0) return invalidPayload();
        offset += count;
      }
      if (
        createHash("sha256").update(bytes).digest("hex") !== resource.sha256
      ) {
        return invalidPayload();
      }
      const afterOpen = fstatSync(fd);
      if (
        afterOpen.dev !== opened.dev ||
        afterOpen.ino !== opened.ino ||
        afterOpen.size !== opened.size ||
        afterOpen.nlink !== 1
      ) {
        return invalidPayload();
      }
    } finally {
      closeSync(fd);
    }
    const after = lstatSync(path);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.nlink !== 1 ||
      realpathSync(path) !== path
    ) {
      return invalidPayload();
    }
    let evidenceText: string | undefined;
    if (resource.kind === "text") {
      if (bytes.length > 200_000) return invalidPayload();
      evidenceText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    return Object.freeze({
      sourceKind: resource.sourceKind,
      kind: resource.kind,
      displayName: resource.displayName,
      relativePath: resource.relativePath,
      sizeBytes: resource.sizeBytes,
      sha256: `sha256:${resource.sha256}`,
      ...(evidenceText === undefined ? {} : { text: evidenceText }),
    });
  } catch {
    return invalidPayload();
  }
}

export type NotificationInstructionPlan = Readonly<{
  taskId: string;
  capability: "notification.send.direct";
  identity: "bot";
  batchKey: string;
  recipients: readonly NotificationResolvedRecipient[];
  content: NotificationContent;
  attachments: readonly NotificationAttachment[];
}>;

export type NotificationDeliveryPublicState =
  | "SUCCEEDED"
  | "FAILED"
  | "UNKNOWN";

export type NotificationPublicResult = Readonly<{
  state: NotificationDeliveryPublicState;
  recipients: readonly Readonly<{
    name: string;
    state: NotificationDeliveryPublicState;
  }>[];
  summary: Readonly<{
    total: number;
    succeeded: number;
    failed: number;
    unknown: number;
  }>;
}>;

export type MvpNotificationBatchStore = Pick<
  JobStore,
  | "createNotificationBatch"
  | "claimNextNotificationDelivery"
  | "markNotificationDeliveryDispatching"
  | "finishNotificationDelivery"
  | "getNotificationBatchSummary"
>;

export type MvpNotificationCoordinator = Readonly<{
  execute(plan: NotificationInstructionPlan): Promise<NotificationPublicResult>;
}>;

export type NotificationDisplayCard = Readonly<{
  schema: "2.0";
  header: Readonly<{
    template: "blue";
    title: Readonly<{ tag: "plain_text"; content: string }>;
  }>;
  body: Readonly<{
    direction: "vertical";
    padding: "12px 12px 16px 12px";
    elements: readonly Readonly<{
      tag: "div";
      text: Readonly<{ tag: "plain_text"; content: string }>;
    }>[];
  }>;
}>;

function invalidPayload(): never {
  throw new Error("invalid direct notification payload");
}

function invalidPlan(): never {
  throw new Error("invalid trusted direct notification plan");
}

function strictObject(value: unknown, expected: readonly string[]): JsonObject {
  let snapshot: JsonValue;
  try {
    snapshot = snapshotStrictJson(value);
  } catch {
    return invalidPayload();
  }
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    return invalidPayload();
  }
  const keys = Object.keys(snapshot);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key))
  ) {
    return invalidPayload();
  }
  return snapshot as JsonObject;
}

function text(
  value: JsonValue | undefined,
  maximum: number,
  trim = false,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim().length === 0 ||
    (trim && value !== value.trim()) ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint === 0 || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  ) {
    return invalidPayload();
  }
  return value;
}

type ParsedContent = Readonly<{
  content: NotificationContent;
  verbatimSourceRef: string | null;
}>;

function parseContent(value: JsonValue | undefined): ParsedContent {
  const candidate =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonObject)
      : invalidPayload();
  const kind =
    typeof candidate.kind === "string" ? candidate.kind : invalidPayload();
  if (kind === "text") {
    const candidateWording =
      typeof candidate.wording === "string"
        ? candidate.wording
        : invalidPayload();
    const input = strictObject(
      value,
      candidateWording === "verbatim"
        ? ["kind", "text", "wording", "verbatimSourceRef"]
        : ["kind", "text", "wording"],
    );
    if (input.wording !== "composed" && input.wording !== "verbatim") {
      return invalidPayload();
    }
    const sourceRef =
      input.wording === "verbatim"
        ? typeof input.verbatimSourceRef === "string" &&
          UUID_PATTERN.test(input.verbatimSourceRef)
          ? input.verbatimSourceRef
          : invalidPayload()
        : null;
    return Object.freeze({
      content: Object.freeze({
        kind: "text",
        text: text(input.text, 20_000),
        wording: input.wording,
      }),
      verbatimSourceRef: sourceRef,
    });
  }
  if (kind === "display_card") {
    const candidateWording =
      typeof candidate.wording === "string"
        ? candidate.wording
        : invalidPayload();
    const input = strictObject(
      value,
      candidateWording === "verbatim"
        ? [
            "kind",
            "title",
            "source",
            "body",
            "items",
            "wording",
            "verbatimSourceRef",
          ]
        : ["kind", "title", "source", "body", "items", "wording"],
    );
    if (
      (input.wording !== "composed" && input.wording !== "verbatim") ||
      !Array.isArray(input.items)
    ) {
      return invalidPayload();
    }
    if (input.items.length > 20) return invalidPayload();
    const items = input.items.map((item) => text(item, 500));
    return Object.freeze({
      content: Object.freeze({
        kind: "display_card",
        title: text(input.title, 100, true),
        source: text(input.source, 100, true),
        body: text(input.body, 4_000),
        items: Object.freeze(items),
        wording: input.wording,
      }),
      verbatimSourceRef:
        input.wording === "verbatim"
          ? typeof input.verbatimSourceRef === "string" &&
            UUID_PATTERN.test(input.verbatimSourceRef)
            ? input.verbatimSourceRef
            : invalidPayload()
          : null,
    });
  }
  return invalidPayload();
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const object = value as JsonObject;
  return `{${Object.keys(object)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(object[key] as JsonValue)}`,
    )
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableRecipientRef(taskId: string, openId: string): string {
  const bytes = Buffer.from(sha256(`${taskId}\0${openId}`).slice(0, 32), "hex");
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function stableResourceRef(
  taskId: string,
  resource: NotificationResolvedResource,
): string {
  return stableRecipientRef(
    taskId,
    `${resource.kind}\0${resource.relativePath}\0${resource.sha256}`,
  );
}

function trustedResource(
  value: NotificationResolvedResource,
  expectedKind?: "text" | "image" | "file",
): NotificationResolvedResource {
  if (
    value === null ||
    typeof value !== "object" ||
    (value.sourceKind !== "current" && value.sourceKind !== "quoted") ||
    (value.kind !== "text" &&
      value.kind !== "image" &&
      value.kind !== "file") ||
    (expectedKind !== undefined && value.kind !== expectedKind) ||
    typeof value.displayName !== "string" ||
    value.displayName.length < 1 ||
    value.displayName.length > 512 ||
    value.displayName.trim().length === 0 ||
    !RESOURCE_PATH_PATTERN.test(value.relativePath) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 1 ||
    value.sizeBytes > 100 * 1024 * 1024 ||
    !SHA256_PATTERN.test(value.sha256) ||
    (value.kind === "text"
      ? typeof value.text !== "string" ||
        Buffer.byteLength(value.text, "utf8") !== value.sizeBytes ||
        value.text.length > 200_000
      : value.text !== undefined)
  ) {
    return invalidPayload();
  }
  return value;
}

function exactVerbatimContent(
  parsed: ParsedContent,
  source: NotificationResolvedResource,
): NotificationContent {
  if (
    source.kind !== "text" ||
    typeof source.text !== "string" ||
    source.text.normalize("NFC") !== source.text
  ) {
    return invalidPayload();
  }
  const claimed =
    parsed.content.kind === "text" ? parsed.content.text : parsed.content.body;
  if (claimed.normalize("NFC") !== claimed || !source.text.includes(claimed)) {
    return invalidPayload();
  }
  const offset = source.text.indexOf(claimed);
  const exact = source.text.slice(offset, offset + claimed.length);
  if (parsed.content.kind === "text") {
    return Object.freeze({
      kind: "text",
      text: exact,
      wording: "verbatim",
    });
  }
  return Object.freeze({
    ...parsed.content,
    body: exact,
    wording: "verbatim",
  });
}

export function planNotificationInstruction(
  taskId: string,
  value: unknown,
  dereference: (
    taskId: string,
    recipientRef: string,
  ) => Readonly<{ openId: string; displayName: string }>,
  dereferenceResource?: (
    taskId: string,
    resourceRef: string,
  ) => NotificationResolvedResource,
): NotificationInstructionPlan {
  if (!UUID_PATTERN.test(taskId) || typeof dereference !== "function") {
    return invalidPayload();
  }
  const input = strictObject(value, [
    "recipientRefs",
    "content",
    "attachmentRefs",
  ]);

  const parsedContent = parseContent(input.content);
  if (
    !Array.isArray(input.attachmentRefs) ||
    input.attachmentRefs.length > MAX_ATTACHMENTS
  ) {
    return invalidPayload();
  }
  const attachmentRefs = input.attachmentRefs.map((entry) =>
    typeof entry === "string" && UUID_PATTERN.test(entry)
      ? entry
      : invalidPayload(),
  );
  if (new Set(attachmentRefs).size !== attachmentRefs.length) {
    return invalidPayload();
  }
  if (
    (parsedContent.verbatimSourceRef !== null || attachmentRefs.length > 0) &&
    typeof dereferenceResource !== "function"
  ) {
    return invalidPayload();
  }
  if (
    !Array.isArray(input.recipientRefs) ||
    input.recipientRefs.length < 1 ||
    input.recipientRefs.length > MAX_RECIPIENTS
  ) {
    return invalidPayload();
  }
  const callerRefs = input.recipientRefs.map((entry) => {
    if (typeof entry !== "string" || !UUID_PATTERN.test(entry)) {
      return invalidPayload();
    }
    return entry;
  });
  if (new Set(callerRefs).size !== callerRefs.length) return invalidPayload();

  const resolved = callerRefs.map((recipientRef) => {
    const value = dereference(taskId, recipientRef);
    if (
      value === null ||
      typeof value !== "object" ||
      !OPEN_ID_PATTERN.test(value.openId) ||
      typeof value.displayName !== "string" ||
      value.displayName.length < 1 ||
      value.displayName.length > 100 ||
      value.displayName.trim().length === 0
    ) {
      return invalidPayload();
    }
    return Object.freeze({
      recipientRef: stableRecipientRef(taskId, value.openId),
      openId: value.openId,
      displayName: value.displayName,
      recipientBinding: Object.freeze({
        provider: "lark" as const,
        recipientOpenId: value.openId,
      }),
    });
  });
  resolved.sort((left, right) => left.openId.localeCompare(right.openId));
  if (new Set(resolved.map(({ openId }) => openId)).size !== resolved.length) {
    return invalidPayload();
  }
  let content = parsedContent.content;
  if (parsedContent.verbatimSourceRef !== null) {
    const source = trustedResource(
      (dereferenceResource as NonNullable<typeof dereferenceResource>)(
        taskId,
        parsedContent.verbatimSourceRef,
      ),
      "text",
    );
    content = exactVerbatimContent(parsedContent, source);
  }
  const attachments = attachmentRefs.map((resourceRef) => {
    const resource = trustedResource(
      (dereferenceResource as NonNullable<typeof dereferenceResource>)(
        taskId,
        resourceRef,
      ),
    );
    if (resource.kind !== "image" && resource.kind !== "file") {
      return invalidPayload();
    }
    return Object.freeze({
      kind: resource.kind,
      displayName: resource.displayName,
      relativePath: resource.relativePath,
      sizeBytes: resource.sizeBytes,
      sha256: resource.sha256,
      stableResourceRef: stableResourceRef(taskId, resource),
    });
  });
  if (
    new Set(attachments.map(({ stableResourceRef }) => stableResourceRef))
      .size !== attachments.length
  ) {
    return invalidPayload();
  }
  if (attachments.length > 0) {
    const body = content.kind === "text" ? content.text : content.body;
    content = Object.freeze({
      kind: "display_card",
      title: "总裁转发",
      source: "总裁办公室",
      body,
      items: Object.freeze(attachments.map(({ displayName }) => displayName)),
      wording: content.wording,
    });
  }
  const canonical = canonicalJson({
    recipients: resolved.map(({ openId }) => openId),
    content,
    attachments: attachments.map(
      ({ kind, relativePath, sizeBytes, sha256, stableResourceRef }) => ({
        kind,
        relativePath,
        sizeBytes,
        sha256,
        stableResourceRef,
      }),
    ),
  });
  return Object.freeze({
    taskId,
    capability: "notification.send.direct",
    identity: "bot",
    batchKey: `notification:sha256:${sha256(canonical)}`,
    recipients: Object.freeze(resolved),
    content,
    attachments: Object.freeze(attachments),
  });
}

export function renderNotificationDisplayCard(
  content: NotificationDisplayCardContent,
): NotificationDisplayCard {
  return Object.freeze({
    schema: "2.0",
    header: Object.freeze({
      template: "blue",
      title: Object.freeze({
        tag: "plain_text",
        content: content.title,
      }),
    }),
    body: Object.freeze({
      direction: "vertical",
      padding: "12px 12px 16px 12px",
      elements: Object.freeze([
        Object.freeze({
          tag: "div",
          text: Object.freeze({
            tag: "plain_text",
            content: `来源：${content.source}`,
          }),
        }),
        Object.freeze({
          tag: "div",
          text: Object.freeze({ tag: "plain_text", content: content.body }),
        }),
        ...content.items.map((item) =>
          Object.freeze({
            tag: "div" as const,
            text: Object.freeze({
              tag: "plain_text" as const,
              content: `• ${item}`,
            }),
          }),
        ),
      ]),
    }),
  });
}

function parseMessageId(result: LarkCliRunResult): string | null {
  if (result.state !== "SUCCEEDED") return null;
  let value: JsonValue;
  try {
    value = snapshotStrictJson(result.value);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const root = value as JsonObject;
  const rootKeys = Object.keys(root);
  if (
    rootKeys.length !== 3 ||
    !rootKeys.every((key) => ["ok", "identity", "data"].includes(key)) ||
    root.ok !== true ||
    root.identity !== "bot" ||
    root.data === null ||
    typeof root.data !== "object" ||
    Array.isArray(root.data)
  ) {
    return null;
  }
  const data = root.data as JsonObject;
  const dataKeys = Object.keys(data);
  if (
    !Object.hasOwn(data, "message_id") ||
    dataKeys.some(
      (key) => !["message_id", "chat_id", "create_time"].includes(key),
    ) ||
    typeof data.message_id !== "string" ||
    !MESSAGE_ID_PATTERN.test(data.message_id) ||
    (Object.hasOwn(data, "chat_id") && typeof data.chat_id !== "string") ||
    (Object.hasOwn(data, "create_time") && typeof data.create_time !== "string")
  ) {
    return null;
  }
  return data.message_id;
}

function currentTime(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("invalid notification coordinator clock");
  }
  return new Date(value.getTime());
}

function publicState(
  state: NotificationPartState,
): NotificationDeliveryPublicState {
  if (state === "SUCCEEDED" || state === "FAILED") return state;
  return "UNKNOWN";
}

function aggregateRecipientState(
  states: readonly NotificationDeliveryPublicState[],
  expectedParts: number,
): NotificationDeliveryPublicState {
  if (states.length !== expectedParts || states.includes("UNKNOWN")) {
    return "UNKNOWN";
  }
  if (states.includes("FAILED")) return "FAILED";
  return states.every((state) => state === "SUCCEEDED")
    ? "SUCCEEDED"
    : "UNKNOWN";
}

function requestFor(
  plan: NotificationInstructionPlan,
  recipientOrdinal: number,
  partOrdinal: number,
  partKind: "content" | "image" | "file",
  idempotencyKey: string,
) {
  const recipient = plan.recipients[recipientOrdinal];
  if (
    recipient === undefined ||
    !Number.isSafeInteger(partOrdinal) ||
    partOrdinal < 1 ||
    !UUID_PATTERN.test(idempotencyKey)
  ) {
    return invalidPlan();
  }
  if (partKind === "content" && plan.content.kind === "text") {
    return Object.freeze({
      version: 1 as const,
      operation: "notification.send.text",
      payload: Object.freeze({
        recipientOpenId: recipient.openId,
        text: plan.content.text,
        idempotencyKey,
      }),
    });
  }
  if (partKind === "content" && plan.content.kind === "display_card") {
    return Object.freeze({
      version: 1 as const,
      operation: "notification.send.card",
      payload: Object.freeze({
        recipientOpenId: recipient.openId,
        card: renderNotificationDisplayCard(plan.content),
        idempotencyKey,
      }),
    });
  }
  const attachment = plan.attachments[partOrdinal - 2];
  if (
    attachment === undefined ||
    attachment.kind !== partKind ||
    (partKind !== "image" && partKind !== "file")
  ) {
    return invalidPlan();
  }
  return Object.freeze({
    version: 1 as const,
    operation: `notification.send.${partKind}`,
    payload: Object.freeze({
      recipientOpenId: recipient.openId,
      sourceRelativePath: attachment.relativePath,
      outputFileName: `attachment-${String(partOrdinal).padStart(2, "0")}${
        partKind === "image" ? "-image" : ""
      }.bin`,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
      idempotencyKey,
    }),
  });
}

function dispatchOutcome(result: LarkCliRunResult): Readonly<{
  outcome: "SUCCEEDED" | "FAILED_DEFINITE" | "UNKNOWN";
  remoteId?: string;
}> {
  const remoteId = parseMessageId(result);
  if (remoteId !== null)
    return Object.freeze({ outcome: "SUCCEEDED", remoteId });
  if (result.state === "FAILED" && result.code !== "OUTPUT_INVALID") {
    return Object.freeze({ outcome: "FAILED_DEFINITE" });
  }
  return Object.freeze({ outcome: "UNKNOWN" });
}

export function createMvpNotificationCoordinator(
  dependencies: Readonly<{
    store: MvpNotificationBatchStore;
    runner: MvpLarkCliRunner;
    owner: string;
    now?: () => Date;
  }>,
): MvpNotificationCoordinator {
  if (
    dependencies === null ||
    typeof dependencies !== "object" ||
    dependencies.store === null ||
    typeof dependencies.store !== "object" ||
    typeof dependencies.store.createNotificationBatch !== "function" ||
    typeof dependencies.store.claimNextNotificationDelivery !== "function" ||
    typeof dependencies.store.markNotificationDeliveryDispatching !==
      "function" ||
    typeof dependencies.store.finishNotificationDelivery !== "function" ||
    dependencies.runner === null ||
    typeof dependencies.runner !== "object" ||
    typeof dependencies.runner.runBot !== "function" ||
    typeof dependencies.owner !== "string" ||
    dependencies.owner.length < 1 ||
    dependencies.owner.length > 128
  ) {
    throw new Error("invalid notification coordinator dependencies");
  }
  const clock = dependencies.now ?? (() => new Date());

  return Object.freeze({
    async execute(plan) {
      if (
        plan.capability !== "notification.send.direct" ||
        plan.identity !== "bot" ||
        !UUID_PATTERN.test(plan.taskId) ||
        plan.recipients.length < 1 ||
        plan.recipients.length > MAX_RECIPIENTS
      ) {
        return invalidPlan();
      }
      const createInput = Object.freeze({
        taskId: plan.taskId,
        batchKey: plan.batchKey,
        recipients: Object.freeze(
          plan.recipients.map((recipient) =>
            Object.freeze({
              recipientRef: recipient.recipientRef,
              recipientBinding: recipient.recipientBinding,
            }),
          ),
        ),
        content: plan.content,
        attachments: Object.freeze(
          plan.attachments.map((attachment) =>
            Object.freeze({
              resourceRef: attachment.stableResourceRef,
              kind: attachment.kind,
              resourceBinding: Object.freeze({
                relativePath: attachment.relativePath,
                sizeBytes: attachment.sizeBytes,
                sha256: attachment.sha256,
                displayName: attachment.displayName,
              }),
            }),
          ),
        ),
        now: currentTime(clock),
      });
      const created = dependencies.store.createNotificationBatch(createInput);
      const batchId = created.batch.batchId;
      const observed = plan.recipients.map(() =>
        Array<NotificationDeliveryPublicState>(),
      );
      for (const delivery of created.batch.deliveries) {
        const index = delivery.recipientOrdinal - 1;
        if (index >= 0 && index < observed.length) {
          observed[index]![delivery.part.partOrdinal - 1] = publicState(
            delivery.part.state,
          );
        }
      }

      const totalParts = plan.recipients.length * (plan.attachments.length + 1);
      for (let count = 0; count < totalParts; count += 1) {
        const claim = dependencies.store.claimNextNotificationDelivery({
          batchId,
          owner: dependencies.owner,
          now: currentTime(clock),
          ttlMs: DELIVERY_LEASE_TTL_MS,
        });
        if (claim === null) break;
        const ordinal = claim.recipientOrdinal;
        const index = ordinal - 1;
        const request = requestFor(
          plan,
          index,
          claim.part.partOrdinal,
          claim.part.partKind,
          claim.part.idempotencyKey,
        );
        const attemptId = randomUUID();
        const requestDigest = `sha256:${sha256(
          canonicalJson(request as unknown as JsonValue),
        )}`;
        try {
          const dispatching =
            dependencies.store.markNotificationDeliveryDispatching({
              batchId,
              partId: claim.part.partId,
              actionId: claim.action.actionId,
              owner: dependencies.owner,
              leaseExpiresAt: claim.leaseExpiresAt,
              now: currentTime(clock),
              attemptId,
              requestDigest,
            });
          if (dispatching === null) {
            observed[index]![claim.part.partOrdinal - 1] = "UNKNOWN";
            continue;
          }
        } catch {
          observed[index]![claim.part.partOrdinal - 1] = "UNKNOWN";
          continue;
        }

        let outcome: ReturnType<typeof dispatchOutcome>;
        try {
          outcome = dispatchOutcome(await dependencies.runner.runBot(request));
        } catch {
          outcome = Object.freeze({ outcome: "UNKNOWN" });
        }
        observed[index]![claim.part.partOrdinal - 1] =
          outcome.outcome === "SUCCEEDED"
            ? "SUCCEEDED"
            : outcome.outcome === "FAILED_DEFINITE"
              ? "FAILED"
              : "UNKNOWN";
        try {
          const finished = dependencies.store.finishNotificationDelivery({
            batchId,
            partId: claim.part.partId,
            actionId: claim.action.actionId,
            owner: dependencies.owner,
            leaseExpiresAt: claim.leaseExpiresAt,
            now: currentTime(clock),
            attemptId,
            outcome: outcome.outcome,
            ...(outcome.remoteId === undefined
              ? {}
              : { remoteId: outcome.remoteId }),
          });
          if (finished === null) {
            observed[index]![claim.part.partOrdinal - 1] = "UNKNOWN";
          }
        } catch {
          observed[index]![claim.part.partOrdinal - 1] = "UNKNOWN";
        }
      }

      try {
        const replay = dependencies.store.createNotificationBatch({
          ...createInput,
          now: currentTime(clock),
        });
        for (const delivery of replay.batch.deliveries) {
          const index = delivery.recipientOrdinal - 1;
          if (index >= 0 && index < observed.length) {
            observed[index]![delivery.part.partOrdinal - 1] = publicState(
              delivery.part.state,
            );
          }
        }
      } catch {
        // The dispatch ledger remains authoritative. A post-dispatch read
        // failure must not cause a resend; the observed result stays
        // conservative.
      }

      const recipientStates = observed.map((states) =>
        aggregateRecipientState(states, plan.attachments.length + 1),
      );
      const succeeded = recipientStates.filter(
        (state) => state === "SUCCEEDED",
      ).length;
      const failed = recipientStates.filter(
        (state) => state === "FAILED",
      ).length;
      const unknown = recipientStates.length - succeeded - failed;
      const state: NotificationDeliveryPublicState =
        unknown > 0 ? "UNKNOWN" : failed > 0 ? "FAILED" : "SUCCEEDED";
      return Object.freeze({
        state,
        recipients: Object.freeze(
          plan.recipients.map((recipient, ordinal) =>
            Object.freeze({
              name: recipient.displayName,
              state: recipientStates[ordinal] ?? "UNKNOWN",
            }),
          ),
        ),
        summary: Object.freeze({
          total: recipientStates.length,
          succeeded,
          failed,
          unknown,
        }),
      });
    },
  });
}
