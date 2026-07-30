import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ConfirmationCallbackSchema,
  ConfirmationDecisionSchema,
  GatewayRequestSchema,
  InboundEventSchema,
  TaskStateSchema,
  type ExecuteActionRequest,
  type PreparedAction,
  type ApprovalDecision,
  type RunGatewayClient,
} from "../src/index.js";

const validInboundEvent = {
  appId: "cli_a",
  tenantKey: "tenant_a",
  eventId: "evt_a",
  messageId: "msg_a",
  senderOpenId: "ou_a",
  chatId: "oc_a",
  chatType: "p2p",
  eventType: "im.message.receive_v1",
  receivedAt: "2026-07-20T00:00:00.000Z",
  payloadRef: `sha256:${"a".repeat(64)}`,
};

const validGatewayRequest = {
  version: 1,
  requestId: "5ccd8261-b163-4ad5-ae2e-254765d0d2b4",
  kind: "read",
  capability: "minutes.search",
  payload: {},
};

describe("shared contracts", () => {
  it("accepts a strict versioned confirmation callback", () => {
    const callback = {
      version: 1,
      actionId: "5ccd8261-b163-4ad5-ae2e-254765d0d2b4",
      actionPayloadHash: `sha256:${"a".repeat(64)}`,
      nonce: "nonce_0123456789",
      decision: "approve",
      actorOpenId: "ou_president",
      chatId: "oc_private",
    };
    expect(ConfirmationCallbackSchema.parse(callback)).toEqual(callback);
    expect(ConfirmationDecisionSchema.options).toEqual(["approve", "reject"]);
    expectTypeOf<PreparedAction>().toMatchTypeOf<{
      actionId: string;
      version: 1;
      payloadHash: string;
      expiresAt: string;
    }>();
    expectTypeOf<ApprovalDecision>().toEqualTypeOf<
      | Readonly<{ accepted: true }>
      | Readonly<{ accepted: false; reason: "expired_or_changed" }>
    >();
  });

  it.each([
    [
      "missing version",
      {
        actionId: "5ccd8261-b163-4ad5-ae2e-254765d0d2b4",
        actionPayloadHash: `sha256:${"a".repeat(64)}`,
        nonce: "nonce",
        decision: "approve",
        actorOpenId: "ou_president",
        chatId: "oc_private",
      },
    ],
    [
      "SDK payloadHash alias",
      {
        version: 1,
        actionId: "5ccd8261-b163-4ad5-ae2e-254765d0d2b4",
        payloadHash: `sha256:${"a".repeat(64)}`,
        nonce: "nonce",
        decision: "approve",
        actorOpenId: "ou_president",
        chatId: "oc_private",
      },
    ],
    [
      "unknown decision",
      {
        version: 1,
        actionId: "5ccd8261-b163-4ad5-ae2e-254765d0d2b4",
        actionPayloadHash: `sha256:${"a".repeat(64)}`,
        nonce: "nonce",
        decision: "APPROVED",
        actorOpenId: "ou_president",
        chatId: "oc_private",
      },
    ],
    [
      "unknown field",
      {
        version: 1,
        actionId: "5ccd8261-b163-4ad5-ae2e-254765d0d2b4",
        actionPayloadHash: `sha256:${"a".repeat(64)}`,
        nonce: "nonce",
        decision: "reject",
        actorOpenId: "ou_president",
        chatId: "oc_private",
        payloadHash: `sha256:${"b".repeat(64)}`,
      },
    ],
  ])("rejects confirmation callback with %s", (_name, callback) => {
    expect(ConfirmationCallbackSchema.safeParse(callback).success).toBe(false);
  });

  it("accepts a valid private-chat ingress event", () => {
    const result = InboundEventSchema.safeParse(validInboundEvent);

    expect(result.success).toBe(true);
    expect(InboundEventSchema.parse(validInboundEvent).chatType).toBe("p2p");
  });

  it.each([
    ["group chat", { ...validInboundEvent, chatType: "group" }],
    ["unknown field", { ...validInboundEvent, unexpected: true }],
    [
      "wrong event type",
      { ...validInboundEvent, eventType: "im.message.sent_v1" },
    ],
    ["invalid datetime", { ...validInboundEvent, receivedAt: "2026-07-20" }],
    [
      "short SHA-256",
      { ...validInboundEvent, payloadRef: `sha256:${"a".repeat(63)}` },
    ],
    [
      "uppercase SHA-256",
      { ...validInboundEvent, payloadRef: `sha256:${"A".repeat(64)}` },
    ],
  ])("rejects %s ingress", (_caseName, event) => {
    expect(InboundEventSchema.safeParse(event).success).toBe(false);
  });

  it("does not define a silently replayable task state", () => {
    expect(TaskStateSchema.options).toContain(
      "INTERRUPTED_REQUIRES_CONFIRMATION",
    );
    expect(TaskStateSchema.options).toContain("CANCELLED");
    expect(TaskStateSchema.options).not.toContain("RETRYING");
  });

  it("accepts a valid gateway request", () => {
    const result = GatewayRequestSchema.safeParse(validGatewayRequest);

    expect(result.success).toBe(true);
    expect(GatewayRequestSchema.parse(validGatewayRequest).version).toBe(1);
  });

  it("accepts execute through the generic run client contract", () => {
    const request = {
      ...validGatewayRequest,
      kind: "execute",
      capability: "calendar.schedule",
      payload: { title: "季度复盘" },
    };

    expect(GatewayRequestSchema.safeParse(request).success).toBe(true);
    expectTypeOf<RunGatewayClient>().toMatchTypeOf<{
      execute<T>(request: ExecuteActionRequest): Promise<T>;
    }>();
  });

  it.each([
    ["an unsupported protocol version", { ...validGatewayRequest, version: 2 }],
    [
      "an invalid request id",
      { ...validGatewayRequest, requestId: "not-a-uuid" },
    ],
    ["an empty capability", { ...validGatewayRequest, capability: "" }],
    [
      "a missing protocol version",
      {
        requestId: validGatewayRequest.requestId,
        kind: "read",
        capability: "minutes.search",
        payload: {},
      },
    ],
    [
      "a missing request id",
      {
        version: 1,
        kind: "read",
        capability: "minutes.search",
        payload: {},
      },
    ],
    [
      "a missing capability",
      {
        version: 1,
        requestId: validGatewayRequest.requestId,
        kind: "read",
        payload: {},
      },
    ],
    [
      "a missing payload",
      {
        version: 1,
        requestId: validGatewayRequest.requestId,
        kind: "read",
        capability: "minutes.search",
      },
    ],
    [
      "a caller-supplied task id",
      { ...validGatewayRequest, taskId: crypto.randomUUID() },
    ],
    [
      "a caller-supplied identity",
      { ...validGatewayRequest, identity: "user" },
    ],
    ["a caller-supplied actor", { ...validGatewayRequest, actor: "user" }],
    ["a caller-supplied chat", { ...validGatewayRequest, chat: "oc_other" }],
    [
      "a caller-supplied confirmation bypass",
      { ...validGatewayRequest, skipConfirmation: true },
    ],
    [
      "a caller-supplied automatic approval",
      { ...validGatewayRequest, autoApprove: true },
    ],
    ["another unknown field", { ...validGatewayRequest, unexpected: true }],
  ])("rejects gateway request with %s", (_caseName, request) => {
    expect(GatewayRequestSchema.safeParse(request).success).toBe(false);
  });
});
