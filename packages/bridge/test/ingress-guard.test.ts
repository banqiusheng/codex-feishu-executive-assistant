import { describe, expect, it } from "vitest";

import {
  DENY_REASON,
  decideIngress,
  type RawIngressMetadata,
} from "../src/security/ingress-guard.js";
import {
  hashPairingCode,
  matchesPairingCode,
  type AccessPolicy,
} from "../src/security/policy.js";

const APP_ID = "cli_a";
const TENANT_KEY = "tenant_a";
const PRESIDENT_OPEN_ID = "ou_president";
const PRESIDENT_CHAT_ID = "oc_dm";
const CARD_HASH = `sha256:${"a".repeat(64)}` as const;

const pairedPolicy: AccessPolicy = {
  appId: APP_ID,
  tenantKey: TENANT_KEY,
  presidentOpenId: PRESIDENT_OPEN_ID,
  presidentChatId: PRESIDENT_CHAT_ID,
  pairing: { active: false, codeHash: null },
};

function message(
  overrides: Partial<RawIngressMetadata> = {},
): RawIngressMetadata {
  return {
    appId: APP_ID,
    tenantKey: TENANT_KEY,
    eventType: "im.message.receive_v1",
    chatType: "p2p",
    senderOpenId: PRESIDENT_OPEN_ID,
    chatId: PRESIDENT_CHAT_ID,
    text: "整理文件",
    ...overrides,
  };
}

function card(overrides: Partial<RawIngressMetadata> = {}): RawIngressMetadata {
  return {
    appId: APP_ID,
    tenantKey: TENANT_KEY,
    eventType: "card.action.trigger",
    chatType: "p2p",
    senderOpenId: PRESIDENT_OPEN_ID,
    chatId: PRESIDENT_CHAT_ID,
    signatureVerified: true,
    callbackNonce: "nonce-a",
    callbackPayloadHash: CARD_HASH,
    ...overrides,
  };
}

describe("decideIngress", () => {
  it.each([
    ["wrong app", { appId: "cli_other" }, DENY_REASON.WRONG_APP],
    ["wrong tenant", { tenantKey: "tenant_other" }, DENY_REASON.WRONG_TENANT],
  ])("denies an envelope from the %s", (_name, overrides, reason) => {
    expect(decideIngress(message(overrides), pairedPolicy)).toEqual({
      kind: "deny",
      reason,
    });
  });

  it.each([
    ["group", "im.message.receive_v1"],
    ["topic_group", "im.message.receive_v1"],
  ])(
    "denies %s ingress even from the paired president",
    (chatType, eventType) => {
      expect(
        decideIngress(message({ chatType, eventType }), pairedPolicy),
      ).toEqual({ kind: "deny", reason: DENY_REASON.GROUP_DISABLED });
    },
  );

  it.each([
    "drive.file.bitable_record_changed_v1",
    "im.message.reaction.created_v1",
    "application.bot.menu_v6",
    "im.chat.member.bot.added_v1",
    "unknown.event_v1",
  ])("denies disabled event %s", (eventType) => {
    expect(decideIngress(message({ eventType }), pairedPolicy)).toEqual({
      kind: "deny",
      reason: DENY_REASON.EVENT_DISABLED,
    });
  });

  it.each([
    ["empty app id", { appId: "" }],
    ["empty tenant key", { tenantKey: "" }],
    ["empty president open id", { presidentOpenId: "" }],
    ["empty president chat id", { presidentChatId: "" }],
    ["only president open id", { presidentChatId: null }],
    ["only president chat id", { presidentOpenId: null }],
    [
      "active pairing without a hash",
      {
        presidentOpenId: null,
        presidentChatId: null,
        pairing: { active: true, codeHash: null },
      },
    ],
    [
      "inactive pairing with a stale hash",
      { pairing: { active: false, codeHash: hashPairingCode("stale") } },
    ],
  ])("fails closed for an invalid policy: %s", (_name, overrides) => {
    const policy = { ...pairedPolicy, ...overrides } as AccessPolicy;

    expect(decideIngress(message(), policy)).toEqual({
      kind: "deny",
      reason: DENY_REASON.POLICY_INVALID,
    });
  });

  it("allows only a message from both the paired president and original DM", () => {
    expect(decideIngress(message(), pairedPolicy)).toEqual({
      kind: "allow_task",
    });
    expect(
      decideIngress(message({ senderOpenId: "ou_other" }), pairedPolicy),
    ).toEqual({
      kind: "deny",
      reason: DENY_REASON.PRINCIPAL_MISMATCH,
    });
    expect(
      decideIngress(message({ chatId: "oc_other" }), pairedPolicy),
    ).toEqual({
      kind: "deny",
      reason: DENY_REASON.PRINCIPAL_MISMATCH,
    });
  });

  it("denies a normal message before pairing", () => {
    const policy: AccessPolicy = {
      ...pairedPolicy,
      presidentOpenId: null,
      presidentChatId: null,
      pairing: {
        active: true,
        codeHash: hashPairingCode("PAIR-1234"),
      },
    };

    expect(decideIngress(message({ text: "做日报" }), policy)).toEqual({
      kind: "deny",
      reason: DENY_REASON.NOT_PAIRED,
    });
  });

  it("allows the exact one-time pairing code without returning it", () => {
    const policy: AccessPolicy = {
      ...pairedPolicy,
      presidentOpenId: null,
      presidentChatId: null,
      pairing: {
        active: true,
        codeHash: hashPairingCode("PAIR-1234"),
      },
    };

    expect(decideIngress(message({ text: "PAIR-1234" }), policy)).toEqual({
      kind: "allow_pairing",
    });
    expect(decideIngress(message({ text: "pair-1234" }), policy)).toEqual({
      kind: "deny",
      reason: DENY_REASON.NOT_PAIRED,
    });
  });

  it("treats unpaired and pairing disabled as an explicit deny-all state", () => {
    const denyAllPolicy: AccessPolicy = {
      ...pairedPolicy,
      presidentOpenId: null,
      presidentChatId: null,
      pairing: { active: false, codeHash: null },
    };

    expect(
      decideIngress(message({ text: "PAIR-1234" }), denyAllPolicy),
    ).toEqual({ kind: "deny", reason: DENY_REASON.NOT_PAIRED });
    expect(decideIngress(message({ text: "做日报" }), denyAllPolicy)).toEqual({
      kind: "deny",
      reason: DENY_REASON.NOT_PAIRED,
    });
  });

  it("treats the old pairing text as a normal task after pairing", () => {
    expect(decideIngress(message({ text: "PAIR-1234" }), pairedPolicy)).toEqual(
      { kind: "allow_task" },
    );
  });

  it.each([
    ["empty sender id", { senderOpenId: "" }],
    ["whitespace sender id", { senderOpenId: "   " }],
    ["empty chat id", { chatId: "" }],
    ["whitespace chat id", { chatId: "   " }],
  ])("requires exact non-empty pairing metadata: %s", (_name, overrides) => {
    const policy: AccessPolicy = {
      ...pairedPolicy,
      presidentOpenId: null,
      presidentChatId: null,
      pairing: {
        active: true,
        codeHash: hashPairingCode("PAIR-1234"),
      },
    };

    expect(
      decideIngress(message({ ...overrides, text: "PAIR-1234" }), policy),
    ).toEqual({ kind: "deny", reason: DENY_REASON.NOT_PAIRED });
  });

  it.each([
    [
      "Buffer text",
      Buffer.from("PAIR-1234") as unknown as string,
      hashPairingCode("PAIR-1234"),
      DENY_REASON.NOT_PAIRED,
    ],
    [
      "number text",
      1234 as unknown as string,
      hashPairingCode("1234"),
      DENY_REASON.NOT_PAIRED,
    ],
    ["empty text", "", hashPairingCode(""), DENY_REASON.POLICY_INVALID],
    [
      "missing text with the empty digest",
      undefined,
      hashPairingCode(""),
      DENY_REASON.POLICY_INVALID,
    ],
    [
      "whitespace-only text",
      "   ",
      hashPairingCode("   "),
      DENY_REASON.NOT_PAIRED,
    ],
    [
      "text with surrounding whitespace",
      " PAIR-1234 ",
      hashPairingCode(" PAIR-1234 "),
      DENY_REASON.NOT_PAIRED,
    ],
    [
      "overlong text",
      "x".repeat(257),
      hashPairingCode("x".repeat(257)),
      DENY_REASON.NOT_PAIRED,
    ],
  ])(
    "denies malformed pairing %s without throwing",
    (_name, text, codeHash, reason) => {
      const policy: AccessPolicy = {
        ...pairedPolicy,
        presidentOpenId: null,
        presidentChatId: null,
        pairing: { active: true, codeHash },
      };
      const decide = () => decideIngress(message({ text }), policy);

      expect(decide).not.toThrow();
      expect(decide()).toEqual({ kind: "deny", reason });
    },
  );

  it("rejects non-string values at the pairing hash comparison boundary", () => {
    const codeHash = hashPairingCode("PAIR-1234");

    expect(
      matchesPairingCode(Buffer.from("PAIR-1234") as unknown, codeHash),
    ).toBe(false);
    expect(matchesPairingCode(1234, codeHash)).toBe(false);
  });

  it.each([
    "sha256:expected",
    `sha256:${"a".repeat(63)}`,
    `sha256:${"a".repeat(65)}`,
    `sha256:${"A".repeat(64)}`,
    "not-sha256",
  ])("denies malformed pairing hash %s without throwing", (codeHash) => {
    const policy = {
      ...pairedPolicy,
      presidentOpenId: null,
      presidentChatId: null,
      pairing: { active: true, codeHash },
    } as AccessPolicy;

    expect(() =>
      decideIngress(message({ text: "PAIR-1234" }), policy),
    ).not.toThrow();
    expect(decideIngress(message({ text: "PAIR-1234" }), policy)).toEqual({
      kind: "deny",
      reason: DENY_REASON.POLICY_INVALID,
    });
  });

  it.each([
    ["missing signature result", { signatureVerified: undefined }],
    ["failed signature", { signatureVerified: false }],
    ["missing nonce", { callbackNonce: undefined }],
    ["empty nonce", { callbackNonce: "" }],
    ["whitespace nonce", { callbackNonce: "   " }],
    ["missing payload hash", { callbackPayloadHash: undefined }],
    ["short payload hash", { callbackPayloadHash: "sha256:bad" }],
    [
      "uppercase payload hash",
      { callbackPayloadHash: `sha256:${"A".repeat(64)}` },
    ],
    ["missing payload prefix", { callbackPayloadHash: "a".repeat(64) }],
    ["long payload hash", { callbackPayloadHash: `sha256:${"a".repeat(65)}` }],
  ])("denies card callback with %s", (_name, overrides) => {
    expect(decideIngress(card(overrides), pairedPolicy)).toEqual({
      kind: "deny",
      reason: DENY_REASON.CARD_AUTH_INVALID,
    });
  });

  it("requires both the paired president and original DM for card callbacks", () => {
    expect(
      decideIngress(card({ senderOpenId: "ou_other" }), pairedPolicy),
    ).toEqual({
      kind: "deny",
      reason: DENY_REASON.CARD_ACTOR_MISMATCH,
    });
    expect(decideIngress(card({ chatId: "oc_other" }), pairedPolicy)).toEqual({
      kind: "deny",
      reason: DENY_REASON.CARD_ACTOR_MISMATCH,
    });
  });

  it.each([
    ["group", { chatType: "group" }, DENY_REASON.GROUP_DISABLED],
    ["wrong app", { appId: "cli_other" }, DENY_REASON.WRONG_APP],
    ["wrong tenant", { tenantKey: "tenant_other" }, DENY_REASON.WRONG_TENANT],
  ])(
    "applies the shared %s gate before card authorization",
    (_name, overrides, reason) => {
      expect(decideIngress(card(overrides), pairedPolicy)).toEqual({
        kind: "deny",
        reason,
      });
    },
  );

  it("does not allow a card callback to pair the president", () => {
    const pairingPolicy: AccessPolicy = {
      ...pairedPolicy,
      presidentOpenId: null,
      presidentChatId: null,
      pairing: {
        active: true,
        codeHash: hashPairingCode("PAIR-1234"),
      },
    };

    expect(decideIngress(card({ text: "PAIR-1234" }), pairingPolicy)).toEqual({
      kind: "deny",
      reason: DENY_REASON.NOT_PAIRED,
    });
  });

  it("returns only the canonical callback binding for an allowed card", () => {
    expect(decideIngress(card(), pairedPolicy)).toEqual({
      kind: "allow_card",
      nonce: "nonce-a",
      payloadHash: CARD_HASH,
    });
  });
});
