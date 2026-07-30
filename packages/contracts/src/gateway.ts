import { z } from "zod";

const CanonicalSha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const BoundIdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      [...value].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f);
      }),
    "identifier contains control characters",
  );

export const ConfirmationDecisionSchema = z.enum(["approve", "reject"]);
export type ConfirmationDecision = z.infer<typeof ConfirmationDecisionSchema>;

export type ApprovalDecision =
  | Readonly<{ accepted: true }>
  | Readonly<{ accepted: false; reason: "expired_or_changed" }>;

export const ConfirmationCallbackSchema = z
  .object({
    version: z.literal(1),
    actionId: z.string().uuid(),
    actionPayloadHash: CanonicalSha256Schema,
    nonce: BoundIdentifierSchema,
    decision: ConfirmationDecisionSchema,
    actorOpenId: BoundIdentifierSchema,
    chatId: BoundIdentifierSchema,
  })
  .strict();

export type ConfirmationCallback = z.infer<typeof ConfirmationCallbackSchema>;

export const GatewayRequestSchema = z
  .object({
    version: z.literal(1),
    requestId: z.string().uuid(),
    kind: z.enum(["read", "prepare", "execute", "system_reply"]),
    capability: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type GatewayRequest = z.infer<typeof GatewayRequestSchema>;
export type ReadRequest = GatewayRequest & { kind: "read" };
export type PrepareActionRequest = GatewayRequest & { kind: "prepare" };
export type ExecuteActionRequest = GatewayRequest & { kind: "execute" };
export type SystemReplyRequest = GatewayRequest & { kind: "system_reply" };
export type PreparedAction = Readonly<{
  actionId: string;
  version: 1;
  payloadHash: string;
  expiresAt: string;
}>;
export type GatewayResult = Readonly<{
  state: "SUCCEEDED" | "FAILED" | "UNKNOWN";
  remoteId?: string;
}>;

export interface RunGatewayClient {
  read<T>(request: ReadRequest): Promise<T>;
  prepare(request: PrepareActionRequest): Promise<PreparedAction>;
  execute<T>(request: ExecuteActionRequest): Promise<T>;
  systemReply(request: SystemReplyRequest): Promise<GatewayResult>;
}

export interface BridgeGatewayClient {
  sendSystemReply(
    taskId: string,
    body: Readonly<{ type: "text" | "file"; value: string }>,
  ): Promise<GatewayResult>;
  sendControlReply(
    controlEventId: string,
    body: Readonly<{ type: "text"; value: string }>,
  ): Promise<GatewayResult>;
  submitApproval(callback: ConfirmationCallback): Promise<ApprovalDecision>;
}
