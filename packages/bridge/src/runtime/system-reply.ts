export const SYSTEM_REPLY_ERROR = {
  TASK_ACK_FAILED: "ASSISTANT_TASK_ACK_FAILED",
  CONTROL_REPLY_FAILED: "ASSISTANT_CONTROL_REPLY_FAILED",
  PROGRESS_REPLY_FAILED: "ASSISTANT_PROGRESS_REPLY_FAILED",
} as const;

export type ProgressStage =
  | "QUEUED"
  | "PREPARING"
  | "RUNNING"
  | "VERIFYING"
  | "AWAITING_CONFIRMATION"
  | "FINALIZING";

export type CancellationReplyKind =
  | "NOT_RUNNING"
  | "CANCELLED_NO_EXTERNAL_EFFECTS"
  | "CANCELLED_RECONCILING_EXTERNAL_EFFECTS";

export type SystemTextValue =
  | "收到，我开始处理"
  | "当前没有运行中的任务。"
  | "已停止当前任务，没有待执行的外部动作。"
  | "已停止当前任务；已有外部动作正在核对，我会只报告事实。"
  | "任务已进入处理队列。"
  | "正在整理任务所需信息。"
  | "正在处理任务。"
  | "正在核对处理结果。"
  | "正在等待必要的确认。"
  | "正在准备最终回复。";

export type SystemText = Readonly<{
  type: "text";
  value: SystemTextValue;
}>;

export type ActionResult = Readonly<{
  state: "SUCCEEDED" | "FAILED" | "UNKNOWN";
  remoteId?: string;
}>;

export interface AssistantReplyGateway {
  sendSystemReply(taskId: string, body: SystemText): Promise<ActionResult>;
  sendControlReply(
    controlEventId: string,
    body: SystemText,
  ): Promise<ActionResult>;
}

const TASK_ACCEPTED: SystemText = Object.freeze({
  type: "text",
  value: "收到，我开始处理",
});

const CANCELLATION_TEXT: Readonly<Record<CancellationReplyKind, SystemText>> =
  Object.freeze({
    NOT_RUNNING: Object.freeze({
      type: "text",
      value: "当前没有运行中的任务。",
    }),
    CANCELLED_NO_EXTERNAL_EFFECTS: Object.freeze({
      type: "text",
      value: "已停止当前任务，没有待执行的外部动作。",
    }),
    CANCELLED_RECONCILING_EXTERNAL_EFFECTS: Object.freeze({
      type: "text",
      value: "已停止当前任务；已有外部动作正在核对，我会只报告事实。",
    }),
  });

const PROGRESS_TEXT: Readonly<Record<ProgressStage, SystemText>> =
  Object.freeze({
    QUEUED: Object.freeze({ type: "text", value: "任务已进入处理队列。" }),
    PREPARING: Object.freeze({
      type: "text",
      value: "正在整理任务所需信息。",
    }),
    RUNNING: Object.freeze({ type: "text", value: "正在处理任务。" }),
    VERIFYING: Object.freeze({
      type: "text",
      value: "正在核对处理结果。",
    }),
    AWAITING_CONFIRMATION: Object.freeze({
      type: "text",
      value: "正在等待必要的确认。",
    }),
    FINALIZING: Object.freeze({
      type: "text",
      value: "正在准备最终回复。",
    }),
  });

export function taskAcceptedText(): SystemText {
  return TASK_ACCEPTED;
}

export function cancellationText(kind: CancellationReplyKind): SystemText {
  switch (kind) {
    case "NOT_RUNNING":
      return CANCELLATION_TEXT.NOT_RUNNING;
    case "CANCELLED_NO_EXTERNAL_EFFECTS":
      return CANCELLATION_TEXT.CANCELLED_NO_EXTERNAL_EFFECTS;
    case "CANCELLED_RECONCILING_EXTERNAL_EFFECTS":
      return CANCELLATION_TEXT.CANCELLED_RECONCILING_EXTERNAL_EFFECTS;
  }
}

export function progressText(stage: ProgressStage): SystemText {
  switch (stage) {
    case "QUEUED":
      return PROGRESS_TEXT.QUEUED;
    case "PREPARING":
      return PROGRESS_TEXT.PREPARING;
    case "RUNNING":
      return PROGRESS_TEXT.RUNNING;
    case "VERIFYING":
      return PROGRESS_TEXT.VERIFYING;
    case "AWAITING_CONFIRMATION":
      return PROGRESS_TEXT.AWAITING_CONFIRMATION;
    case "FINALIZING":
      return PROGRESS_TEXT.FINALIZING;
  }
}

async function requireSuccessfulReply(
  operation: () => Promise<ActionResult>,
  fixedError: string,
): Promise<void> {
  let state: unknown;
  try {
    const result: unknown = await operation();
    if (
      result === null ||
      typeof result !== "object" ||
      Array.isArray(result)
    ) {
      throw new Error(fixedError);
    }
    const ownKeys = Reflect.ownKeys(result);
    if (ownKeys.some((key) => typeof key !== "string")) {
      throw new Error(fixedError);
    }
    const keys = (ownKeys as string[]).sort();
    const hasOnlyState = keys.length === 1 && keys[0] === "state";
    const hasOptionalRemoteId =
      keys.length === 2 && keys[0] === "remoteId" && keys[1] === "state";
    const record = result as Record<string, unknown>;
    state = record.state;
    const remoteId = hasOptionalRemoteId ? record.remoteId : undefined;
    if (
      (!hasOnlyState && !hasOptionalRemoteId) ||
      !["SUCCEEDED", "FAILED", "UNKNOWN"].includes(state as string) ||
      (hasOptionalRemoteId && typeof remoteId !== "string")
    ) {
      throw new Error(fixedError);
    }
  } catch {
    throw new Error(fixedError);
  }
  if (state !== "SUCCEEDED") throw new Error(fixedError);
}

export function sendTaskAcceptedReply(
  gateway: AssistantReplyGateway,
  taskId: string,
): Promise<void> {
  return requireSuccessfulReply(
    () => gateway.sendSystemReply(taskId, taskAcceptedText()),
    SYSTEM_REPLY_ERROR.TASK_ACK_FAILED,
  );
}

export function sendCancellationReply(
  gateway: AssistantReplyGateway,
  controlEventId: string,
  kind: CancellationReplyKind,
): Promise<void> {
  return requireSuccessfulReply(
    () => gateway.sendControlReply(controlEventId, cancellationText(kind)),
    SYSTEM_REPLY_ERROR.CONTROL_REPLY_FAILED,
  );
}

export function sendProgressReply(
  gateway: Pick<AssistantReplyGateway, "sendSystemReply">,
  taskId: string,
  stage: ProgressStage,
): Promise<void> {
  return requireSuccessfulReply(
    () => gateway.sendSystemReply(taskId, progressText(stage)),
    SYSTEM_REPLY_ERROR.PROGRESS_REPLY_FAILED,
  );
}
