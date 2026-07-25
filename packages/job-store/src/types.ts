import type {
  CancelActiveTaskRequest,
  CancelActiveTaskResult,
  InboundEvent,
  TaskState,
} from "@executive-assistant/contracts";
import type Database from "better-sqlite3";

export type JobStoreOptions = Readonly<{
  filename: string;
  instanceId: string;
  lock: DatabaseFileLock;
}>;

export type BindPrincipalInput = Readonly<{
  appId: string;
  tenantKey: string;
  presidentOpenId: string;
  presidentChatId: string;
  pairedAt: Date;
}>;

export type BindPrincipalResult = Readonly<{ created: boolean }>;

export interface DatabaseFileLock {
  readonly runtimeDir: string;
  readonly released: boolean;
  readonly compromised: boolean;
  readonly releaseFailed: boolean;
  release(): Promise<void>;
}

export type ActionIdentity = "bot" | "user";
export type ActionApprovalMode = "president" | "system_policy";
export type ActionState =
  | "PREPARED"
  | "APPROVED"
  | "CLAIMED"
  | "DISPATCHING"
  | "SUCCEEDED"
  | "FAILED"
  | "UNKNOWN"
  | "RECONCILED";
export type DispatchOutcome = "SUCCEEDED" | "FAILED_DEFINITE" | "UNKNOWN";
export type AttemptOutcome = DispatchOutcome | "INDETERMINATE";
export type ReconcileOutcome = "SUCCEEDED" | "FAILED" | "INDETERMINATE";

export type ActionJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ActionJsonValue[]
  | ActionJsonObject;

export interface ActionJsonObject {
  readonly [key: string]: ActionJsonValue;
}

export type ActionRef = Readonly<{ actionId: string; version: 1 }>;

export type PrepareActionInput = Readonly<{
  taskId: string;
  capability: string;
  identity: ActionIdentity;
  payload: unknown;
  preview: unknown;
  now: Date;
}>;

export type PreparedActionWithNonce = Readonly<{
  actionId: string;
  version: 1;
  payloadHash: string;
  nonce: string;
  expiresAt: string;
  state: "PREPARED";
}>;

export type ApproveActionInput = Readonly<{
  actionId: string;
  version: 1;
  actionPayloadHash: string;
  nonce: string;
  decision: "approve" | "reject";
  actorOpenId: string;
  chatId: string;
  now: Date;
}>;

export type ClaimApprovedActionInput = Readonly<{
  actionId: string;
  version: 1;
  owner: string;
  now: Date;
  ttlMs: number;
}>;

export type MarkDispatchingInput = Readonly<{
  actionId: string;
  version: 1;
  owner: string;
  leaseExpiresAt: string;
  now: Date;
  attemptId: string;
  requestDigest: string;
}>;

export type FinishActionInput = Readonly<{
  actionId: string;
  version: 1;
  owner: string;
  leaseExpiresAt: string;
  now: Date;
  attemptId: string;
  outcome: DispatchOutcome;
  remoteId?: string;
}>;

export type StartReconciliationInput = Readonly<{
  actionId: string;
  version: 1;
  owner: string;
  now: Date;
  ttlMs: number;
  attemptId: string;
  requestDigest: string;
}>;

export type ReconcileActionInput = Readonly<{
  actionId: string;
  version: 1;
  owner: string;
  leaseExpiresAt: string;
  now: Date;
  attemptId: string;
  outcome: ReconcileOutcome;
  evidenceDigest: string;
  operatorKind: "automatic" | "manual";
  remoteId?: string;
}>;

export type ActionResult = Readonly<{
  outcome: AttemptOutcome;
  remoteId?: string;
}>;

export type ActionRecord = Readonly<{
  actionId: string;
  version: 1;
  taskId: string | null;
  controlEventId: string | null;
  capability: string;
  identity: ActionIdentity;
  approvalMode: ActionApprovalMode;
  state: ActionState;
  payload: ActionJsonValue;
  payloadHash: string;
  preview: ActionJsonValue;
  expiresAt: string;
  idempotencyKey: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  remoteId: string | null;
  result: ActionResult | null;
  reconcileOutcome: ReconcileOutcome | null;
  createdAt: string;
  updatedAt: string;
}>;

export type ApprovedAction = ActionRecord &
  Readonly<{ state: "APPROVED" | "FAILED" }>;
export type ClaimedAction = ActionRecord & Readonly<{ state: "CLAIMED" }>;
export type DispatchingAction = ActionRecord &
  Readonly<{ state: "DISPATCHING" }>;
export type FinishedAction = ActionRecord &
  Readonly<{ state: "SUCCEEDED" | "FAILED" | "UNKNOWN" }>;
export type ReconciliationClaim = ActionRecord &
  Readonly<{ state: "UNKNOWN"; leaseOwner: string; leaseExpiresAt: string }>;
export type ReconciledAction = ActionRecord & Readonly<{ state: "RECONCILED" }>;

export interface JobStore {
  readonly instanceId: string;
  ingestEvent(event: InboundEvent, workspacePath: string): IngestEventResult;
  bindPrincipal(input: BindPrincipalInput): BindPrincipalResult;
  acquireRuntimeLease(
    name: string,
    owner: string,
    now: Date,
    ttlMs: number,
  ): boolean;
  releaseRuntimeLease(name: string, owner: string): boolean;
  claimNextTask(owner: string, now: Date, ttlMs: number): TaskRecord | null;
  getTaskAcknowledgement(taskId: string): TaskAcknowledgementRecord | null;
  getNextTaskAcknowledgementCandidate(): TaskAcknowledgementRecord | null;
  listTaskAcknowledgementRecoveryCandidates(): readonly TaskAcknowledgementRecoveryCandidate[];
  beginTaskAcknowledgement(
    input: BeginTaskAcknowledgementInput,
  ): TaskAcknowledgementRecord | null;
  finishTaskAcknowledgement(
    input: FinishTaskAcknowledgementInput,
  ): TaskAcknowledgementRecord | null;
  reconcileTaskAcknowledgement(
    input: ReconcileTaskAcknowledgementInput,
  ): TaskAcknowledgementRecord | null;
  getTask(taskId: string): TaskRecord | null;
  markRunning(input: MarkRunningInput): TaskRecord | null;
  touchTask(input: TouchTaskInput): TaskRecord | null;
  finishTask(input: FinishTaskInput): TaskRecord | null;
  interruptExpiredTasks(now: Date): RecoverySummary;
  recoverOnStartup(now: Date): RecoverySummary;
  createReplacementTask(
    interruptedTaskId: string,
    confirmedAt: Date,
    workspacePath: string,
  ): ReplacementTaskResult | null;
  cancelActiveTask(request: CancelActiveTaskRequest): CancelActiveTaskResult;
  prepareAction(input: PrepareActionInput): PreparedActionWithNonce;
  approveAction(input: ApproveActionInput): ApprovedAction;
  claimApprovedAction(input: ClaimApprovedActionInput): ClaimedAction | null;
  getAction(ref: ActionRef): ActionRecord | null;
  listUnknownActions(): readonly ActionRecord[];
  markDispatching(input: MarkDispatchingInput): DispatchingAction | null;
  finishAction(input: FinishActionInput): FinishedAction | null;
  startReconciliation(
    input: StartReconciliationInput,
  ): ReconciliationClaim | null;
  reconcileAction(input: ReconcileActionInput): ReconciledAction | null;
  durabilitySettings(): Readonly<{
    journalMode: string;
    foreignKeys: number;
    synchronous: number;
    busyTimeout: number;
  }>;
  integrityCheck(): boolean;
  close(): void;
}

export type IngestEventResult = Readonly<{
  taskId: string;
  duplicate: boolean;
}>;

export type TaskAcknowledgementState =
  | "NOT_ATTEMPTED"
  | "SENDING"
  | "RETRYABLE_DNS"
  | "ACKNOWLEDGED"
  | "AMBIGUOUS"
  | "FAILED_DEFINITE";
export type TaskAcknowledgementFailureClass =
  | "DNS_UNAVAILABLE"
  | "REMOTE_REJECTED"
  | "RESULT_AMBIGUOUS"
  | "LOCAL_EVIDENCE_FAILED";
export type TaskAcknowledgementRecord = Readonly<{
  taskId: string;
  state: TaskAcknowledgementState;
  attemptCount: number;
  lastFailureClass: TaskAcknowledgementFailureClass | null;
  createdAt: string;
  updatedAt: string;
}>;
export type TaskAcknowledgementRecoveryCandidate = Readonly<{
  taskId: string;
  workspacePath: string;
}>;
export type BeginTaskAcknowledgementInput = Readonly<{
  taskId: string;
  owner: string;
  now: Date;
}>;
export type FinishTaskAcknowledgementInput = Readonly<{
  taskId: string;
  owner: string;
  now: Date;
  state: TaskAcknowledgementState;
  failureClass: TaskAcknowledgementFailureClass | null;
}>;
export type ReconcileTaskAcknowledgementInput = Readonly<{
  taskId: string;
  owner: string;
  now: Date;
  markerPresent: boolean;
}>;

export type TaskRecord = Readonly<{
  id: string;
  inboundEventId: string;
  taskKind: "ROOT" | "RESUME";
  resumedFromTaskId: string | null;
  state: TaskState;
  recoveryDisposition:
    | "NONE"
    | "REQUIRES_CONFIRMATION"
    | "RESUME_APPROVED"
    | "ABANDONED";
  codexSessionId: string | null;
  workspacePath: string;
  stage: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastEventAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type RecoverySummary = Readonly<{
  tasksInterrupted: number;
  actionsFailed: number;
  actionsUnknown: number;
}>;

export type ReplacementTaskResult = Readonly<{
  task: TaskRecord;
  duplicate: boolean;
}>;

export type MarkRunningInput = Readonly<{
  taskId: string;
  owner: string;
  codexSessionId: string;
  now: Date;
  ttlMs: number;
}>;

export type TouchTaskInput = Readonly<{
  taskId: string;
  owner: string;
  codexSessionId: string;
  now: Date;
  ttlMs: number;
  stage: string;
}>;

export type FinishTaskInput = Readonly<{
  taskId: string;
  owner: string;
  codexSessionId: string;
  now: Date;
  outcome: "SUCCEEDED" | "FAILED";
}>;

export type EventIngestor = (
  event: InboundEvent,
  workspacePath: string,
) => IngestEventResult;

export type JobStoreOperations = Readonly<{
  ingestEvent: EventIngestor;
  bindPrincipal(input: BindPrincipalInput): BindPrincipalResult;
  acquireRuntimeLease(
    name: string,
    owner: string,
    now: Date,
    ttlMs: number,
  ): boolean;
  releaseRuntimeLease(name: string, owner: string): boolean;
  claimNextTask(owner: string, now: Date, ttlMs: number): TaskRecord | null;
  getTaskAcknowledgement(taskId: string): TaskAcknowledgementRecord | null;
  getNextTaskAcknowledgementCandidate(): TaskAcknowledgementRecord | null;
  listTaskAcknowledgementRecoveryCandidates(): readonly TaskAcknowledgementRecoveryCandidate[];
  beginTaskAcknowledgement(
    input: BeginTaskAcknowledgementInput,
  ): TaskAcknowledgementRecord | null;
  finishTaskAcknowledgement(
    input: FinishTaskAcknowledgementInput,
  ): TaskAcknowledgementRecord | null;
  reconcileTaskAcknowledgement(
    input: ReconcileTaskAcknowledgementInput,
  ): TaskAcknowledgementRecord | null;
  getTask(taskId: string): TaskRecord | null;
  markRunning(input: MarkRunningInput): TaskRecord | null;
  touchTask(input: TouchTaskInput): TaskRecord | null;
  finishTask(input: FinishTaskInput): TaskRecord | null;
  interruptExpiredTasks(now: Date): RecoverySummary;
  recoverOnStartup(now: Date): RecoverySummary;
  createReplacementTask(
    interruptedTaskId: string,
    confirmedAt: Date,
    workspacePath: string,
  ): ReplacementTaskResult | null;
  cancelActiveTask(request: CancelActiveTaskRequest): CancelActiveTaskResult;
  prepareAction(input: PrepareActionInput): PreparedActionWithNonce;
  approveAction(input: ApproveActionInput): ApprovedAction;
  claimApprovedAction(input: ClaimApprovedActionInput): ClaimedAction | null;
  getAction(ref: ActionRef): ActionRecord | null;
  listUnknownActions(): readonly ActionRecord[];
  markDispatching(input: MarkDispatchingInput): DispatchingAction | null;
  finishAction(input: FinishActionInput): FinishedAction | null;
  startReconciliation(
    input: StartReconciliationInput,
  ): ReconciliationClaim | null;
  reconcileAction(input: ReconcileActionInput): ReconciledAction | null;
}>;

export class RuntimeStateError extends Error {
  readonly code = "BLOCKED_RUNTIME_STATE" as const;

  constructor(
    readonly detail: string,
    cause?: unknown,
  ) {
    super(`BLOCKED_RUNTIME_STATE: ${detail}`, { cause });
    this.name = "RuntimeStateError";
  }
}

export class SqliteJobStore implements JobStore {
  #database: Database.Database;
  #instanceId: string;
  #operations: JobStoreOperations;
  #onClose: () => void;
  #closed = false;

  constructor(
    database: Database.Database,
    instanceId: string,
    operations: JobStoreOperations,
    onClose: () => void,
  ) {
    this.#database = database;
    this.#instanceId = instanceId;
    this.#operations = operations;
    this.#onClose = onClose;
    Object.preventExtensions(this);
  }

  get instanceId(): string {
    return this.#instanceId;
  }

  ingestEvent(event: InboundEvent, workspacePath: string): IngestEventResult {
    return this.#operations.ingestEvent(event, workspacePath);
  }

  bindPrincipal(input: BindPrincipalInput): BindPrincipalResult {
    return this.#operations.bindPrincipal(input);
  }

  acquireRuntimeLease(
    name: string,
    owner: string,
    now: Date,
    ttlMs: number,
  ): boolean {
    return this.#operations.acquireRuntimeLease(name, owner, now, ttlMs);
  }

  releaseRuntimeLease(name: string, owner: string): boolean {
    return this.#operations.releaseRuntimeLease(name, owner);
  }

  claimNextTask(owner: string, now: Date, ttlMs: number): TaskRecord | null {
    return this.#operations.claimNextTask(owner, now, ttlMs);
  }

  getTaskAcknowledgement(taskId: string): TaskAcknowledgementRecord | null {
    return this.#operations.getTaskAcknowledgement(taskId);
  }
  getNextTaskAcknowledgementCandidate(): TaskAcknowledgementRecord | null {
    return this.#operations.getNextTaskAcknowledgementCandidate();
  }
  listTaskAcknowledgementRecoveryCandidates(): readonly TaskAcknowledgementRecoveryCandidate[] {
    return this.#operations.listTaskAcknowledgementRecoveryCandidates();
  }
  beginTaskAcknowledgement(
    input: BeginTaskAcknowledgementInput,
  ): TaskAcknowledgementRecord | null {
    return this.#operations.beginTaskAcknowledgement(input);
  }
  finishTaskAcknowledgement(
    input: FinishTaskAcknowledgementInput,
  ): TaskAcknowledgementRecord | null {
    return this.#operations.finishTaskAcknowledgement(input);
  }
  reconcileTaskAcknowledgement(
    input: ReconcileTaskAcknowledgementInput,
  ): TaskAcknowledgementRecord | null {
    return this.#operations.reconcileTaskAcknowledgement(input);
  }

  getTask(taskId: string): TaskRecord | null {
    return this.#operations.getTask(taskId);
  }

  markRunning(input: MarkRunningInput): TaskRecord | null {
    return this.#operations.markRunning(input);
  }

  touchTask(input: TouchTaskInput): TaskRecord | null {
    return this.#operations.touchTask(input);
  }

  finishTask(input: FinishTaskInput): TaskRecord | null {
    return this.#operations.finishTask(input);
  }

  interruptExpiredTasks(now: Date): RecoverySummary {
    return this.#operations.interruptExpiredTasks(now);
  }

  recoverOnStartup(now: Date): RecoverySummary {
    return this.#operations.recoverOnStartup(now);
  }

  createReplacementTask(
    interruptedTaskId: string,
    confirmedAt: Date,
    workspacePath: string,
  ): ReplacementTaskResult | null {
    return this.#operations.createReplacementTask(
      interruptedTaskId,
      confirmedAt,
      workspacePath,
    );
  }

  cancelActiveTask(request: CancelActiveTaskRequest): CancelActiveTaskResult {
    return this.#operations.cancelActiveTask(request);
  }

  prepareAction(input: PrepareActionInput): PreparedActionWithNonce {
    return this.#operations.prepareAction(input);
  }

  approveAction(input: ApproveActionInput): ApprovedAction {
    return this.#operations.approveAction(input);
  }

  claimApprovedAction(input: ClaimApprovedActionInput): ClaimedAction | null {
    return this.#operations.claimApprovedAction(input);
  }

  getAction(ref: ActionRef): ActionRecord | null {
    return this.#operations.getAction(ref);
  }

  listUnknownActions(): readonly ActionRecord[] {
    return this.#operations.listUnknownActions();
  }

  markDispatching(input: MarkDispatchingInput): DispatchingAction | null {
    return this.#operations.markDispatching(input);
  }

  finishAction(input: FinishActionInput): FinishedAction | null {
    return this.#operations.finishAction(input);
  }

  startReconciliation(
    input: StartReconciliationInput,
  ): ReconciliationClaim | null {
    return this.#operations.startReconciliation(input);
  }

  reconcileAction(input: ReconcileActionInput): ReconciledAction | null {
    return this.#operations.reconcileAction(input);
  }

  durabilitySettings(): Readonly<{
    journalMode: string;
    foreignKeys: number;
    synchronous: number;
    busyTimeout: number;
  }> {
    return {
      journalMode: String(
        this.#database.pragma("journal_mode", { simple: true }),
      ),
      foreignKeys: Number(
        this.#database.pragma("foreign_keys", { simple: true }),
      ),
      synchronous: Number(
        this.#database.pragma("synchronous", { simple: true }),
      ),
      busyTimeout: Number(
        this.#database.pragma("busy_timeout", { simple: true }),
      ),
    };
  }

  integrityCheck(): boolean {
    return this.#database.pragma("integrity_check", { simple: true }) === "ok";
  }

  close(): void {
    if (!this.#closed) {
      this.#database.close();
      this.#onClose();
      this.#closed = true;
    }
  }
}

Object.freeze(SqliteJobStore.prototype);
Object.freeze(SqliteJobStore);
