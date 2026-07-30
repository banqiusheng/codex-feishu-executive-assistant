import { randomUUID } from "node:crypto";
import type {
  ActionJsonValue,
  ClarificationSelection,
  ClarificationValueValidator,
} from "@executive-assistant/job-store";

import { snapshotStrictJson, type JsonValue } from "../ipc/framing.js";
import type { MvpLarkCliRunner } from "./registry.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{1,252}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const LABEL_SPOOFING_PATTERN = /[|｜\p{Cf}]/u;
const WENLV_DEPARTMENT = "融创中国-直管业务-文旅事业部";
const SKI_DEPARTMENT = "融创中国-热雪奇迹";

type JsonObject = Readonly<Record<string, JsonValue>>;

export type ContactQueryRecipient = Readonly<{
  source: "query";
  name: string;
  departmentHint?: string;
  enterpriseEmail?: string;
}>;

export type ContactSelectionRecipient = Readonly<{
  source: "selection";
  selectionRef: string;
}>;

export type ContactResolvePayload = Readonly<{
  recipients: readonly (ContactQueryRecipient | ContactSelectionRecipient)[];
}>;

export type ContactPublicCandidate = Readonly<{
  selectionRef: string;
  label: string;
  name: string;
  department: string;
  enterpriseEmail?: string;
}>;

export type ContactPublicRecipient = Readonly<{
  status: "RESOLVED" | "NEEDS_CLARIFICATION" | "NOT_FOUND";
  name?: string;
  department?: string;
  enterpriseEmail?: string;
  recipientRef?: string;
  groupRef?: string;
  label?: string;
  candidates?: readonly ContactPublicCandidate[];
}>;

export type ContactResolveResult = Readonly<{
  status: "RESOLVED" | "NEEDS_CLARIFICATION" | "NOT_FOUND" | "INCOMPLETE";
  recipients: readonly ContactPublicRecipient[];
}>;

type ContactSelectionValue = Readonly<{
  version: 1;
  openId: string;
  name: string;
  department: string;
  enterpriseEmail: string;
  isActivated: true;
}>;

export type ContactClarificationWriter = Readonly<{
  writeContactClarification(input: {
    taskId: string;
    kind: "contact";
    groupLabel: string;
    candidates: readonly Readonly<{
      value: ContactSelectionValue;
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

export type ContactClarificationConsumer = Readonly<{
  consumeClarificationsForTaskValidated(
    taskId: string,
    optionRefs: readonly string[],
    expectedKind: "contact",
    now: Date,
    assertValue: ClarificationValueValidator,
  ): readonly ClarificationSelection[];
}>;

export type ContactResolver = Readonly<{
  resolve(
    taskId: string,
    payload: ContactResolvePayload,
    now: Date,
  ): Promise<ContactResolveResult>;
  dereferenceRecipient(taskId: string, recipientRef: string): string;
}>;

export type ContactResolverDependencies = Readonly<{
  runner: Pick<MvpLarkCliRunner, "runUser">;
  clarificationWriter?: ContactClarificationWriter;
  clarificationConsumer?: ContactClarificationConsumer;
  randomUuid?: () => string;
}>;

type ContactCandidate = Readonly<{
  openId: string;
  name: string;
  department: string;
  enterpriseEmail: string;
  isActivated: true;
}>;

type ParsedContactPage = Readonly<{
  users: readonly ContactCandidate[];
  hasMore: boolean;
}>;

type PendingRecipient =
  | Readonly<{ status: "RESOLVED"; candidate: ContactCandidate }>
  | Readonly<{ status: "NOT_FOUND"; name: string }>
  | Readonly<{
      status: "NEEDS_CLARIFICATION";
      groupRef: string;
      label: string;
      candidates: readonly Readonly<{
        candidate: ContactCandidate;
        selectionRef: string;
        label: string;
      }>[];
    }>;

type QueryPlan =
  | Readonly<{ status: "RESOLVED"; candidate: ContactCandidate }>
  | Readonly<{ status: "NOT_FOUND"; name: string }>
  | Readonly<{
      status: "NEEDS_CLARIFICATION";
      name: string;
      candidates: readonly ContactCandidate[];
    }>;

function invalidPayload(): never {
  throw new Error("invalid contact.resolve payload");
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

function safeString(
  value: JsonValue | undefined,
  maximum: number,
  error: () => never = invalidPayload,
): string {
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

function optionalSafeString(
  value: JsonValue | undefined,
  maximum: number,
  error: () => never,
): string {
  if (value === "") return "";
  return safeString(value, maximum, error);
}

function departmentHint(value: JsonValue | undefined): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    value.trim().length === 0 ||
    LABEL_SPOOFING_PATTERN.test(value) ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  ) {
    return invalidPayload();
  }
  if (normalizeDepartment(value).length === 0) return invalidPayload();
  return value;
}

function queryRecipient(value: JsonValue): ContactQueryRecipient {
  const input = strictObject(
    value,
    ["source", "name"],
    ["departmentHint", "enterpriseEmail"],
  );
  if (input.source !== "query") return invalidPayload();
  const result: {
    source: "query";
    name: string;
    departmentHint?: string;
    enterpriseEmail?: string;
  } = {
    source: "query",
    name: safeString(input.name, 100),
  };
  if (Object.hasOwn(input, "departmentHint")) {
    result.departmentHint = departmentHint(input.departmentHint);
  }
  if (Object.hasOwn(input, "enterpriseEmail")) {
    const enterpriseEmail = safeString(input.enterpriseEmail, 254);
    if (!EMAIL_PATTERN.test(enterpriseEmail)) return invalidPayload();
    result.enterpriseEmail = enterpriseEmail;
  }
  return Object.freeze(result);
}

function selectionRecipient(value: JsonValue): ContactSelectionRecipient {
  const input = strictObject(value, ["source", "selectionRef"]);
  if (input.source !== "selection") return invalidPayload();
  const selectionRef = safeString(input.selectionRef, 36);
  if (!UUID_PATTERN.test(selectionRef)) return invalidPayload();
  return Object.freeze({ source: "selection", selectionRef });
}

export function parseContactResolvePayload(
  value: unknown,
): ContactResolvePayload {
  const input = strictObject(value, ["recipients"]);
  if (
    !Array.isArray(input.recipients) ||
    input.recipients.length < 1 ||
    input.recipients.length > 20
  ) {
    return invalidPayload();
  }
  const recipients = input.recipients.map((recipient) => {
    if (
      recipient === null ||
      typeof recipient !== "object" ||
      Array.isArray(recipient)
    ) {
      return invalidPayload();
    }
    const source = (recipient as Readonly<Record<string, JsonValue>>).source;
    if (source === "query") return queryRecipient(recipient);
    if (source === "selection") return selectionRecipient(recipient);
    return invalidPayload();
  });
  const selectionRefs = recipients
    .filter(
      (recipient): recipient is ContactSelectionRecipient =>
        recipient.source === "selection",
    )
    .map((recipient) => recipient.selectionRef);
  if (new Set(selectionRefs).size !== selectionRefs.length) {
    return invalidPayload();
  }
  return Object.freeze({ recipients: Object.freeze(recipients) });
}

function invalidCliResult(): never {
  throw new Error("invalid contact CLI result");
}

function strictCliObject(
  value: JsonValue,
  required: readonly string[],
  optional: readonly string[] = [],
): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidCliResult();
  }
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
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

function cliString(
  value: JsonValue | undefined,
  maximum: number,
  allowEmpty: boolean,
): string {
  if (allowEmpty && value === "") return "";
  return safeString(value, maximum, invalidCliResult);
}

function parseContactPage(value: JsonValue): ParsedContactPage {
  const snapshot = snapshotStrictJson(value);
  const root = strictCliObject(snapshot, ["data"]);
  const data = strictCliObject(root.data as JsonValue, ["users", "has_more"]);
  if (!Array.isArray(data.users) || typeof data.has_more !== "boolean") {
    return invalidCliResult();
  }
  if (data.users.length > 20) return invalidCliResult();
  const openIds = new Set<string>();
  const users = data.users.map((entry) => {
    const row = strictCliObject(
      entry,
      [
        "open_id",
        "localized_name",
        "email",
        "enterprise_email",
        "is_activated",
        "is_cross_tenant",
        "p2p_chat_id",
        "has_chatted",
        "department",
        "chat_recency_hint",
        "match_segments",
      ],
      ["signature"],
    );
    const openId = cliString(row.open_id, 256, false);
    if (
      !OPEN_ID_PATTERN.test(openId) ||
      row.is_activated !== true ||
      openIds.has(openId) ||
      row.is_cross_tenant !== false ||
      typeof row.has_chatted !== "boolean" ||
      !Array.isArray(row.match_segments) ||
      row.match_segments.length > 50 ||
      row.match_segments.some(
        (segment) =>
          typeof segment !== "string" ||
          segment.length > 200 ||
          (segment !== "" && segment !== segment.trim()),
      ) ||
      (Object.hasOwn(row, "signature") && typeof row.signature !== "string")
    ) {
      return invalidCliResult();
    }
    openIds.add(openId);
    const enterpriseEmail = cliString(row.enterprise_email, 254, true);
    if (enterpriseEmail !== "" && !EMAIL_PATTERN.test(enterpriseEmail)) {
      return invalidCliResult();
    }
    cliString(row.email, 254, true);
    cliString(row.p2p_chat_id, 256, true);
    cliString(row.chat_recency_hint, 500, true);
    return Object.freeze({
      openId,
      name: cliString(row.localized_name, 200, false),
      department: cliString(row.department, 500, true),
      enterpriseEmail,
      isActivated: true as const,
    });
  });
  return Object.freeze({
    users: Object.freeze(users),
    hasMore: data.has_more,
  });
}

function snapshotNow(value: Date): Date {
  if (
    !(value instanceof Date) ||
    Object.getPrototypeOf(value) !== Date.prototype ||
    Reflect.ownKeys(value).length !== 0
  ) {
    throw new Error("invalid contact resolver clock");
  }
  const milliseconds = Date.prototype.getTime.call(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error("invalid contact resolver clock");
  }
  return new Date(milliseconds);
}

function normalizeDepartment(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[／/\\>|·•‐‑‒–—―]+/gu, "-")
    .replace(/\s+/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "");
}

function matchesQuery(
  candidate: ContactCandidate,
  query: ContactQueryRecipient,
): boolean {
  if (normalizeName(candidate.name) !== normalizeName(query.name)) return false;
  if (
    query.enterpriseEmail !== undefined &&
    candidate.enterpriseEmail.toLocaleLowerCase("en-US") !==
      query.enterpriseEmail.toLocaleLowerCase("en-US")
  ) {
    return false;
  }
  if (
    query.departmentHint !== undefined &&
    !normalizeDepartment(candidate.department).includes(
      normalizeDepartment(query.departmentHint),
    )
  ) {
    return false;
  }
  return true;
}

function priority(candidate: ContactCandidate, presidentDepartment: string) {
  const department = normalizeDepartment(candidate.department);
  if (department.includes(presidentDepartment)) return 0;
  if (department.includes(normalizeDepartment(WENLV_DEPARTMENT))) return 1;
  if (department.includes(normalizeDepartment(SKI_DEPARTMENT))) return 2;
  return 3;
}

function displayLabel(candidate: ContactCandidate): string {
  return [
    candidate.name,
    candidate.department || "部门未提供",
    candidate.enterpriseEmail || "企业邮箱未提供",
  ].join("｜");
}

function selectionValue(value: ActionJsonValue): ContactSelectionValue {
  const snapshot = snapshotStrictJson(value);
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    throw new Error("invalid contact selection");
  }
  const object = snapshot as JsonObject;
  const keys = Object.keys(object);
  const expected = [
    "version",
    "openId",
    "name",
    "department",
    "enterpriseEmail",
    "isActivated",
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key)) ||
    object.version !== 1 ||
    object.isActivated !== true
  ) {
    throw new Error("invalid contact selection");
  }
  const fail = (): never => {
    throw new Error("invalid contact selection");
  };
  const openId = safeString(object.openId, 256, fail);
  const enterpriseEmail = optionalSafeString(object.enterpriseEmail, 254, fail);
  if (
    !OPEN_ID_PATTERN.test(openId) ||
    (enterpriseEmail !== "" && !EMAIL_PATTERN.test(enterpriseEmail))
  ) {
    return fail();
  }
  return Object.freeze({
    version: 1,
    openId,
    name: safeString(object.name, 200, fail),
    department: optionalSafeString(object.department, 500, fail),
    enterpriseEmail,
    isActivated: true,
  });
}

function trustedWriterResult(
  value: unknown,
  candidates: readonly Readonly<{
    value: ContactSelectionValue;
    displayLabel: string;
  }>[],
) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid contact clarification result");
  }
  const result = value as Readonly<Record<string, unknown>>;
  if (
    Reflect.ownKeys(result).length !== 2 ||
    !UUID_PATTERN.test(String(result.groupId)) ||
    !Array.isArray(result.options) ||
    result.options.length !== candidates.length
  ) {
    throw new Error("invalid contact clarification result");
  }
  const optionRefs = new Set<string>();
  const options = result.options.map((option, index) => {
    if (
      option === null ||
      typeof option !== "object" ||
      Array.isArray(option)
    ) {
      throw new Error("invalid contact clarification result");
    }
    const row = option as Readonly<Record<string, unknown>>;
    const expected = ["ordinal", "optionRef", "displayLabel"];
    if (
      Reflect.ownKeys(row).length !== expected.length ||
      Reflect.ownKeys(row).some(
        (key) => typeof key !== "string" || !expected.includes(key),
      ) ||
      row.ordinal !== index + 1 ||
      typeof row.optionRef !== "string" ||
      !UUID_PATTERN.test(row.optionRef) ||
      optionRefs.has(row.optionRef) ||
      row.displayLabel !== candidates[index]?.displayLabel
    ) {
      throw new Error("invalid contact clarification result");
    }
    optionRefs.add(row.optionRef);
    return Object.freeze({
      ordinal: index + 1,
      optionRef: row.optionRef,
      displayLabel: row.displayLabel as string,
    });
  });
  return Object.freeze({
    groupId: String(result.groupId),
    options: Object.freeze(options),
  });
}

function publicCandidate(
  candidate: ContactCandidate,
  selectionRef: string,
  label: string,
): ContactPublicCandidate {
  return Object.freeze({
    selectionRef,
    label,
    name: candidate.name,
    department: candidate.department,
    ...(candidate.enterpriseEmail === ""
      ? {}
      : { enterpriseEmail: candidate.enterpriseEmail }),
  });
}

export function createContactResolver(
  dependencies: ContactResolverDependencies,
): ContactResolver {
  if (
    dependencies === null ||
    typeof dependencies !== "object" ||
    dependencies.runner === null ||
    typeof dependencies.runner !== "object" ||
    typeof dependencies.runner.runUser !== "function" ||
    (dependencies.clarificationWriter !== undefined &&
      (dependencies.clarificationWriter === null ||
        typeof dependencies.clarificationWriter !== "object" ||
        typeof dependencies.clarificationWriter.writeContactClarification !==
          "function")) ||
    (dependencies.clarificationConsumer !== undefined &&
      (dependencies.clarificationConsumer === null ||
        typeof dependencies.clarificationConsumer !== "object" ||
        typeof dependencies.clarificationConsumer
          .consumeClarificationsForTaskValidated !== "function")) ||
    (dependencies.randomUuid !== undefined &&
      typeof dependencies.randomUuid !== "function")
  ) {
    throw new Error("invalid contact resolver dependencies");
  }
  const runUser = dependencies.runner.runUser.bind(dependencies.runner);
  const writer =
    dependencies.clarificationWriter?.writeContactClarification.bind(
      dependencies.clarificationWriter,
    );
  const consumeBatch =
    dependencies.clarificationConsumer?.consumeClarificationsForTaskValidated.bind(
      dependencies.clarificationConsumer,
    );
  const generateUuid = dependencies.randomUuid ?? randomUUID;
  const departmentByTask = new Map<string, string>();
  const recipientByTask = new Map<string, Map<string, string>>();

  async function runContact(
    operation: "contact.self" | "contact.search",
    payload: Readonly<Record<string, JsonValue>>,
  ): Promise<ParsedContactPage> {
    const result = await runUser({ version: 1, operation, payload });
    if (result.state !== "SUCCEEDED") {
      throw new Error("contact CLI result is unavailable");
    }
    return parseContactPage(result.value);
  }

  async function presidentDepartment(taskId: string): Promise<string> {
    const cached = departmentByTask.get(taskId);
    if (cached !== undefined) return cached;
    const page = await runContact("contact.self", Object.freeze({}));
    if (page.hasMore || page.users.length !== 1) {
      throw new Error("invalid contact CLI result");
    }
    const department = normalizeDepartment(page.users[0]!.department);
    if (department.length === 0) {
      throw new Error("invalid contact CLI result");
    }
    departmentByTask.set(taskId, department);
    return department;
  }

  function resolvedWithoutRef(
    candidate: ContactCandidate,
  ): ContactPublicRecipient {
    return Object.freeze({
      status: "RESOLVED",
      name: candidate.name,
      department: candidate.department,
      ...(candidate.enterpriseEmail === ""
        ? {}
        : { enterpriseEmail: candidate.enterpriseEmail }),
    });
  }

  function planRecipientRefs(taskId: string, count: number): readonly string[] {
    const existing = recipientByTask.get(taskId);
    if ((existing?.size ?? 0) + count > 20) {
      throw new Error("recipient reference limit exceeded");
    }
    const generated = new Set<string>();
    const refs = Array.from({ length: count }, () => {
      const recipientRef = generateUuid();
      if (
        typeof recipientRef !== "string" ||
        !UUID_PATTERN.test(recipientRef) ||
        existing?.has(recipientRef) === true ||
        generated.has(recipientRef)
      ) {
        throw new Error("recipient reference generation failed");
      }
      generated.add(recipientRef);
      return recipientRef;
    });
    return Object.freeze(refs);
  }

  function registerRecipients(
    taskId: string,
    candidates: readonly ContactCandidate[],
    refs: readonly string[],
  ): readonly ContactPublicRecipient[] {
    const existing = recipientByTask.get(taskId);
    const publicRecipients = candidates.map((candidate, index) =>
      Object.freeze({
        ...resolvedWithoutRef(candidate),
        recipientRef: refs[index]!,
      }),
    );
    const next = new Map(existing);
    candidates.forEach((candidate, index) => {
      next.set(refs[index]!, candidate.openId);
    });
    recipientByTask.set(taskId, next);
    return Object.freeze(publicRecipients);
  }

  async function resolve(
    taskIdValue: string,
    payloadValue: ContactResolvePayload,
    nowValue: Date,
  ): Promise<ContactResolveResult> {
    if (!UUID_PATTERN.test(taskIdValue)) return invalidPayload();
    const payload = parseContactResolvePayload(payloadValue);
    const now = snapshotNow(nowValue);
    const queryInputs = payload.recipients.filter(
      (recipient): recipient is ContactQueryRecipient =>
        recipient.source === "query",
    );
    const department =
      queryInputs.length === 0
        ? undefined
        : await presidentDepartment(taskIdValue);
    const pages: ParsedContactPage[] = [];
    for (const query of queryInputs) {
      pages.push(
        await runContact(
          "contact.search",
          Object.freeze({
            query: query.enterpriseEmail ?? query.name,
            pageSize: 20,
          }),
        ),
      );
    }
    if (pages.some((page) => page.hasMore)) {
      return Object.freeze({
        status: "INCOMPLETE",
        recipients: Object.freeze([]),
      });
    }

    const queryPlans = queryInputs.map((recipient, index): QueryPlan => {
      const page = pages[index]!;
      const matches = page.users.filter((candidate) =>
        matchesQuery(candidate, recipient),
      );
      if (matches.length === 0) {
        return Object.freeze({ status: "NOT_FOUND", name: recipient.name });
      }
      const ranked = matches.map((candidate) => ({
        candidate,
        rank: priority(candidate, department!),
      }));
      const bestRank = Math.min(...ranked.map((entry) => entry.rank));
      const best = ranked
        .filter((entry) => entry.rank === bestRank)
        .map((entry) => entry.candidate);
      if (bestRank < 3 && best.length === 1) {
        return Object.freeze({ status: "RESOLVED", candidate: best[0]! });
      }
      return Object.freeze({
        status: "NEEDS_CLARIFICATION",
        name: recipient.name,
        candidates: Object.freeze(best),
      });
    });

    if (queryPlans.some((plan) => plan.status !== "RESOLVED")) {
      const pending: PendingRecipient[] = [];
      let queryIndex = 0;
      for (const recipient of payload.recipients) {
        if (recipient.source === "selection") continue;
        const plan = queryPlans[queryIndex++]!;
        if (plan.status === "RESOLVED") {
          pending.push(plan);
          continue;
        }
        if (plan.status === "NOT_FOUND") {
          pending.push(plan);
          continue;
        }
        if (writer === undefined) {
          throw new Error("contact clarification writer is unavailable");
        }
        const groupLabel = `联系人：${plan.name}`;
        const writerCandidates = Object.freeze(
          plan.candidates.map((candidate) =>
            Object.freeze({
              value: Object.freeze({
                version: 1 as const,
                openId: candidate.openId,
                name: candidate.name,
                department: candidate.department,
                enterpriseEmail: candidate.enterpriseEmail,
                isActivated: true as const,
              }),
              displayLabel: displayLabel(candidate),
            }),
          ),
        );
        const written = trustedWriterResult(
          await writer({
            taskId: taskIdValue,
            kind: "contact",
            groupLabel,
            candidates: writerCandidates,
            now,
          }),
          writerCandidates,
        );
        pending.push(
          Object.freeze({
            status: "NEEDS_CLARIFICATION",
            groupRef: written.groupId,
            label: groupLabel,
            candidates: Object.freeze(
              plan.candidates.map((candidate, index) =>
                Object.freeze({
                  candidate,
                  selectionRef: written.options[index]!.optionRef,
                  label: written.options[index]!.displayLabel,
                }),
              ),
            ),
          }),
        );
      }
      const recipients = pending.map((recipient): ContactPublicRecipient => {
        if (recipient.status === "RESOLVED") {
          return resolvedWithoutRef(recipient.candidate);
        }
        if (recipient.status === "NOT_FOUND") {
          return Object.freeze({
            status: "NOT_FOUND",
            name: recipient.name,
          });
        }
        return Object.freeze({
          status: "NEEDS_CLARIFICATION",
          groupRef: recipient.groupRef,
          label: recipient.label,
          candidates: Object.freeze(
            recipient.candidates.map((entry) =>
              publicCandidate(entry.candidate, entry.selectionRef, entry.label),
            ),
          ),
        });
      });
      const status = recipients.some(
        (recipient) => recipient.status === "NEEDS_CLARIFICATION",
      )
        ? "NEEDS_CLARIFICATION"
        : "NOT_FOUND";
      return Object.freeze({
        status,
        recipients: Object.freeze(recipients),
      });
    }

    const selectionInputs = payload.recipients.filter(
      (recipient): recipient is ContactSelectionRecipient =>
        recipient.source === "selection",
    );
    if (selectionInputs.length > 0 && consumeBatch === undefined) {
      throw new Error("contact clarification consumer is unavailable");
    }
    const queryCandidates = queryPlans.map((plan) => {
      if (plan.status !== "RESOLVED") {
        throw new Error("invalid contact resolver state");
      }
      return plan.candidate;
    });
    const recipientRefs = planRecipientRefs(
      taskIdValue,
      payload.recipients.length,
    );

    const selectedCandidates: ContactCandidate[] = [];
    if (selectionInputs.length > 0) {
      void consumeBatch!(
        taskIdValue,
        Object.freeze(
          selectionInputs.map((recipient) => recipient.selectionRef),
        ),
        "contact",
        now,
        (value, index) => {
          if (
            index !== selectedCandidates.length ||
            index >= selectionInputs.length
          ) {
            throw new Error("invalid contact selection");
          }
          const selected = selectionValue(value);
          selectedCandidates.push(
            Object.freeze({
              openId: selected.openId,
              name: selected.name,
              department: selected.department,
              enterpriseEmail: selected.enterpriseEmail,
              isActivated: true as const,
            }),
          );
          return undefined;
        },
      );
    }

    const candidates: ContactCandidate[] = [];
    let queryIndex = 0;
    let selectionIndex = 0;
    for (const recipient of payload.recipients) {
      if (recipient.source === "query") {
        candidates.push(queryCandidates[queryIndex++]!);
      } else {
        candidates.push(selectedCandidates[selectionIndex++]!);
      }
    }
    const recipients = registerRecipients(
      taskIdValue,
      Object.freeze(candidates),
      recipientRefs,
    );
    return Object.freeze({
      status: "RESOLVED",
      recipients,
    });
  }

  return Object.freeze({
    resolve,
    dereferenceRecipient(taskId: string, recipientRef: string) {
      if (!UUID_PATTERN.test(taskId) || !UUID_PATTERN.test(recipientRef)) {
        throw new Error("recipient reference is not available");
      }
      const openId = recipientByTask.get(taskId)?.get(recipientRef);
      if (openId === undefined) {
        throw new Error("recipient reference is not available");
      }
      return openId;
    },
  });
}
