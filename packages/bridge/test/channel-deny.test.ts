import { describe, expect, it, vi } from "vitest";

import {
  createIngressBoundary,
  DENY_REASON,
  type RawIngressMetadata,
} from "../src/security/ingress-guard.js";
import { hashPairingCode, type AccessPolicy } from "../src/security/policy.js";

const pairedPolicy: AccessPolicy = {
  appId: "cli_a",
  tenantKey: "tenant_a",
  presidentOpenId: "ou_president",
  presidentChatId: "oc_dm",
  pairing: { active: false, codeHash: null },
};

const unpairedPolicy: AccessPolicy = {
  ...pairedPolicy,
  presidentOpenId: null,
  presidentChatId: null,
  pairing: {
    active: true,
    codeHash: hashPairingCode("PAIR-1234"),
  },
};

const emptyDigestPolicy: AccessPolicy = {
  ...unpairedPolicy,
  pairing: {
    active: true,
    codeHash: hashPairingCode(""),
  },
};

function envelope(
  overrides: Partial<RawIngressMetadata> = {},
): RawIngressMetadata {
  return {
    appId: "cli_a",
    tenantKey: "tenant_a",
    eventType: "im.message.receive_v1",
    chatType: "p2p",
    senderOpenId: "ou_president",
    chatId: "oc_dm",
    text: "绝不能出现在拒绝日志里的正文",
    ...overrides,
  };
}

describe("channel-deny ingress boundary", () => {
  it.each([
    [
      "group message",
      pairedPolicy,
      envelope({ chatType: "group", chatId: "oc_sensitive_group" }),
      DENY_REASON.GROUP_DISABLED,
    ],
    [
      "wrong tenant",
      pairedPolicy,
      envelope({ tenantKey: "tenant_sensitive_other" }),
      DENY_REASON.WRONG_TENANT,
    ],
    [
      "unpaired normal message",
      unpairedPolicy,
      envelope({
        senderOpenId: "ou_sensitive_other",
        chatId: "oc_sensitive_other",
      }),
      DENY_REASON.NOT_PAIRED,
    ],
    [
      "unsigned card",
      pairedPolicy,
      envelope({
        eventType: "card.action.trigger",
        signatureVerified: false,
        callbackNonce: "nonce-sensitive",
        callbackPayloadHash: `sha256:${"a".repeat(64)}`,
      }),
      DENY_REASON.CARD_AUTH_INVALID,
    ],
    [
      "pairing message with empty identifiers",
      unpairedPolicy,
      envelope({ senderOpenId: "", chatId: "", text: "PAIR-1234" }),
      DENY_REASON.NOT_PAIRED,
    ],
    [
      "pairing message with Buffer text",
      unpairedPolicy,
      envelope({
        text: Buffer.from("PAIR-1234") as unknown as string,
      }),
      DENY_REASON.NOT_PAIRED,
    ],
    [
      "pairing message with number text",
      unpairedPolicy,
      envelope({ text: 1234 as unknown as string }),
      DENY_REASON.NOT_PAIRED,
    ],
    [
      "pairing message without text and with the empty digest",
      emptyDigestPolicy,
      envelope({ text: undefined }),
      DENY_REASON.POLICY_INVALID,
    ],
  ])(
    "stops %s before body logging, media, task sink and authorized continuation",
    async (_name, policy, raw, reason) => {
      const bodyLogger = vi.fn();
      const mediaDownloader = vi.fn();
      const taskSink = vi.fn();
      const auditRejected = vi.fn();
      const authorizedContinuation = vi.fn(async (authorizedRaw) => {
        bodyLogger(authorizedRaw.text);
        await mediaDownloader(authorizedRaw);
        await taskSink(authorizedRaw);
      });
      const boundary = createIngressBoundary({
        policy,
        auditRejected,
        authorizedContinuation,
      });

      const decision = await boundary.handle(raw);

      expect(decision).toEqual({ kind: "deny", reason });
      expect(bodyLogger).not.toHaveBeenCalled();
      expect(mediaDownloader).not.toHaveBeenCalled();
      expect(taskSink).not.toHaveBeenCalled();
      expect(authorizedContinuation).not.toHaveBeenCalled();
      expect(auditRejected).toHaveBeenCalledTimes(1);
      expect(auditRejected).toHaveBeenCalledWith({
        reason,
        eventType: raw.eventType,
      });
      expect(
        Object.keys(auditRejected.mock.calls[0]?.[0] ?? {}).sort(),
      ).toEqual(["eventType", "reason"]);
    },
  );

  it("does not forward SDK responses or complete identifiers into rejection audit", async () => {
    const auditRejected = vi.fn();
    const raw = {
      ...envelope({ chatType: "group" }),
      sdkResponse: {
        token: "sdk-secret",
        rawBody: "untrusted-body",
      },
    } as RawIngressMetadata & {
      sdkResponse: { token: string; rawBody: string };
    };
    const boundary = createIngressBoundary({
      policy: pairedPolicy,
      auditRejected,
      authorizedContinuation: vi.fn(),
    });

    await boundary.handle(raw);

    expect(auditRejected.mock.calls).toEqual([
      [
        {
          reason: DENY_REASON.GROUP_DISABLED,
          eventType: "im.message.receive_v1",
        },
      ],
    ]);
    expect(JSON.stringify(auditRejected.mock.calls)).not.toContain(
      "sdk-secret",
    );
    expect(JSON.stringify(auditRejected.mock.calls)).not.toContain(
      "untrusted-body",
    );
    expect(JSON.stringify(auditRejected.mock.calls)).not.toContain(
      "ou_president",
    );
    expect(JSON.stringify(auditRejected.mock.calls)).not.toContain("oc_dm");
  });

  it("normalizes an overlong multiline event type before rejection audit", async () => {
    const auditRejected = vi.fn();
    const authorizedContinuation = vi.fn();
    const eventType = `${"x".repeat(10_000)}\nsecret-body-fragment`;
    const boundary = createIngressBoundary({
      policy: pairedPolicy,
      auditRejected,
      authorizedContinuation,
    });

    const decision = await boundary.handle(envelope({ eventType }));

    expect(decision).toEqual({
      kind: "deny",
      reason: DENY_REASON.EVENT_DISABLED,
    });
    expect(auditRejected.mock.calls).toEqual([
      [
        {
          reason: DENY_REASON.EVENT_DISABLED,
          eventType: "other",
        },
      ],
    ]);
    expect(JSON.stringify(auditRejected.mock.calls)).not.toContain(
      "secret-body-fragment",
    );
    expect(authorizedContinuation).not.toHaveBeenCalled();
  });

  it("passes an allowed decision to the authorized continuation only after guard approval", async () => {
    const order: string[] = [];
    const auditRejected = vi.fn(() => {
      order.push("audit");
    });
    const authorizedContinuation = vi.fn(async () => {
      order.push("authorized");
    });
    const boundary = createIngressBoundary({
      policy: pairedPolicy,
      auditRejected,
      authorizedContinuation,
    });

    const decision = await boundary.handle(envelope({ text: "整理文件" }));

    expect(decision).toEqual({ kind: "allow_task" });
    expect(order).toEqual(["authorized"]);
    expect(auditRejected).not.toHaveBeenCalled();
    expect(authorizedContinuation).toHaveBeenCalledTimes(1);
  });
});
