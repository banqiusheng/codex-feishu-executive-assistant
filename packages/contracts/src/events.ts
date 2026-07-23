import { z } from "zod";

export const InboundEventSchema = z
  .object({
    appId: z.string().min(1),
    tenantKey: z.string().min(1),
    eventId: z.string().min(1),
    messageId: z.string().min(1),
    senderOpenId: z.string().min(1),
    chatId: z.string().min(1),
    chatType: z.literal("p2p"),
    eventType: z.literal("im.message.receive_v1"),
    receivedAt: z.string().datetime(),
    payloadRef: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

export type InboundEvent = z.infer<typeof InboundEventSchema>;
