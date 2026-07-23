import { z } from "zod";

import type { InboundEvent } from "./events.js";

export const TaskStateSchema = z.enum([
  "RECEIVED",
  "CLAIMED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED_REQUIRES_CONFIRMATION",
]);

export type TaskState = z.infer<typeof TaskStateSchema>;

export interface TaskSink {
  ingest(event: InboundEvent): Promise<{ taskId: string; duplicate: boolean }>;
}

export type CancelActiveTaskRequest = Readonly<
  Pick<
    InboundEvent,
    | "appId"
    | "tenantKey"
    | "eventId"
    | "messageId"
    | "senderOpenId"
    | "chatId"
    | "receivedAt"
  >
>;

export type CancelActiveTaskResult = Readonly<{
  controlEventId: string;
  taskId: string | null;
  cancelled: boolean;
  duplicate: boolean;
  externalEffectsPending: boolean;
}>;

export interface TaskControlSink {
  cancelActive(
    request: CancelActiveTaskRequest,
  ): Promise<CancelActiveTaskResult>;
}

export interface Clock {
  now(): Date;
}
