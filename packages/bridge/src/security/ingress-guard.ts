import {
  isAccessPolicyValid,
  isCanonicalSha256Digest,
  isExactPairingCode,
  matchesPairingCode,
  type AccessPolicy,
  type Sha256Digest,
} from "./policy.js";

export const DENY_REASON = {
  POLICY_INVALID: "policy_invalid",
  WRONG_APP: "wrong_app",
  WRONG_TENANT: "wrong_tenant",
  GROUP_DISABLED: "group_disabled",
  EVENT_DISABLED: "event_disabled",
  CARD_AUTH_INVALID: "card_auth_invalid",
  CARD_ACTOR_MISMATCH: "card_actor_mismatch",
  NOT_PAIRED: "not_paired",
  PRINCIPAL_MISMATCH: "principal_mismatch",
} as const;

export type DenyReason = (typeof DENY_REASON)[keyof typeof DENY_REASON];

export type RawIngressMetadata = Readonly<{
  appId: string;
  tenantKey: string;
  eventType: string;
  chatType: string;
  senderOpenId: string;
  chatId: string;
  text?: string;
  signatureVerified?: boolean;
  callbackNonce?: string;
  callbackPayloadHash?: string;
}>;

export type AllowedIngressDecision =
  | Readonly<{ kind: "allow_task" }>
  | Readonly<{ kind: "allow_pairing" }>
  | Readonly<{
      kind: "allow_card";
      nonce: string;
      payloadHash: Sha256Digest;
    }>;

export type IngressDecision =
  | AllowedIngressDecision
  | Readonly<{ kind: "deny"; reason: DenyReason }>;

export type RejectionAuditRecord = Readonly<{
  reason: DenyReason;
  eventType: "im.message.receive_v1" | "card.action.trigger" | "other";
}>;

export type IngressBoundaryDependencies = Readonly<{
  policy: AccessPolicy;
  auditRejected: (record: RejectionAuditRecord) => void | Promise<void>;
  authorizedContinuation: (
    raw: RawIngressMetadata,
    decision: AllowedIngressDecision,
  ) => void | Promise<void>;
}>;

function deny(reason: DenyReason): IngressDecision {
  return { kind: "deny", reason };
}

function isBoundNonce(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim()
  );
}

function isPairingIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !/\s/.test(value)
  );
}

function auditedEventType(
  eventType: unknown,
): RejectionAuditRecord["eventType"] {
  if (eventType === "im.message.receive_v1") return eventType;
  if (eventType === "card.action.trigger") return eventType;
  return "other";
}

export function decideIngress(
  raw: RawIngressMetadata,
  policy: AccessPolicy,
): IngressDecision {
  if (!isAccessPolicyValid(policy)) return deny(DENY_REASON.POLICY_INVALID);
  if (raw.appId !== policy.appId) return deny(DENY_REASON.WRONG_APP);
  if (raw.tenantKey !== policy.tenantKey) {
    return deny(DENY_REASON.WRONG_TENANT);
  }
  if (raw.chatType !== "p2p") return deny(DENY_REASON.GROUP_DISABLED);

  if (raw.eventType === "card.action.trigger") {
    if (
      raw.signatureVerified !== true ||
      !isBoundNonce(raw.callbackNonce) ||
      !isCanonicalSha256Digest(raw.callbackPayloadHash)
    ) {
      return deny(DENY_REASON.CARD_AUTH_INVALID);
    }
    if (policy.presidentOpenId === null || policy.presidentChatId === null) {
      return deny(DENY_REASON.NOT_PAIRED);
    }
    if (
      raw.senderOpenId !== policy.presidentOpenId ||
      raw.chatId !== policy.presidentChatId
    ) {
      return deny(DENY_REASON.CARD_ACTOR_MISMATCH);
    }
    return {
      kind: "allow_card",
      nonce: raw.callbackNonce,
      payloadHash: raw.callbackPayloadHash,
    };
  }

  if (raw.eventType !== "im.message.receive_v1") {
    return deny(DENY_REASON.EVENT_DISABLED);
  }

  if (policy.pairing.active) {
    if (
      !isPairingIdentifier(raw.senderOpenId) ||
      !isPairingIdentifier(raw.chatId) ||
      !isExactPairingCode(raw.text)
    ) {
      return deny(DENY_REASON.NOT_PAIRED);
    }
    if (matchesPairingCode(raw.text, policy.pairing.codeHash)) {
      return { kind: "allow_pairing" };
    }
  }
  if (policy.presidentOpenId === null || policy.presidentChatId === null) {
    return deny(DENY_REASON.NOT_PAIRED);
  }
  if (
    raw.senderOpenId !== policy.presidentOpenId ||
    raw.chatId !== policy.presidentChatId
  ) {
    return deny(DENY_REASON.PRINCIPAL_MISMATCH);
  }
  return { kind: "allow_task" };
}

export function createIngressBoundary(deps: IngressBoundaryDependencies): {
  handle(raw: RawIngressMetadata): Promise<IngressDecision>;
} {
  return {
    async handle(raw) {
      const decision = decideIngress(raw, deps.policy);
      if (decision.kind === "deny") {
        await deps.auditRejected({
          reason: decision.reason,
          eventType: auditedEventType(raw.eventType),
        });
        return decision;
      }

      await deps.authorizedContinuation(raw, decision);
      return decision;
    },
  };
}
