import type {
  CardVerificationInput,
  LifecycleState,
  SdkCardActionEvent,
  SdkMessageEvent,
  TrustedCardEvidence,
} from "@executive-assistant/bridge";
import type { MvpLarkCliRunner } from "@executive-assistant/action-gateway";
import type { TaskRecord } from "@executive-assistant/job-store";

export type RuntimePairingConfig = Readonly<{
  enabled: boolean;
  codeHash: string | null;
  expiresAt: string | null;
}>;

export type RuntimePaths = Readonly<{
  runtimeRoot: string;
  jobsRoot: string;
  workspaceRoot: string;
  codexHome: string;
  larkHome: string;
  databasePath: string;
}>;

export type RuntimeExecutables = Readonly<{
  node: string;
  codex: string;
  gatewayClient: string;
  larkCli: string | null;
  runtimeEntry: string | null;
}>;

export type RuntimeSecretRef = Readonly<{
  type: "macos-keychain";
  service: string;
  account: string;
}>;

export type RuntimeConfig = Readonly<{
  schemaVersion: 1;
  appId: string;
  /**
   * Legacy pre-bound tenant support. New self-built app installations omit this
   * value and bind it from the first trusted private pairing event.
   */
  tenantKey: string | null;
  presidentOpenId: string | null;
  presidentChatId: string | null;
  pairing: RuntimePairingConfig;
  secretRef: RuntimeSecretRef;
  paths: RuntimePaths;
  executables: RuntimeExecutables;
  source: Readonly<Record<string, unknown>>;
}>;

export type RuntimeTextReply = Readonly<{
  chatId: string;
  text: string;
  replyToMessageId: string;
}>;

export type RuntimeAcknowledgement = RuntimeTextReply;

export type RuntimeFileReply = Readonly<{
  chatId: string;
  path: string;
  fileName: string;
  replyToMessageId: string;
}>;

export type RuntimeConfirmationCard = Readonly<{
  chatId: string;
  replyToMessageId: string;
  actionId: string;
  actionPayloadHash: string;
  nonce: string;
  expiresAt: string;
  preview: Readonly<Record<string, unknown>>;
}>;

export type RuntimeTenantBindingRequest = Readonly<{
  expectedTenantKey: string | null;
  presidentOpenId: string | null;
  presidentChatId: string | null;
  pairingCodeHash: string | null;
  pairingExpiresAt: string | null;
}>;

export interface RuntimeTransport {
  resolveTenantKey(request: RuntimeTenantBindingRequest): Promise<string>;
  onMessage(
    handler: (event: SdkMessageEvent) => Promise<void>,
  ): void | Promise<void>;
  onCardAction(
    handler: (event: SdkCardActionEvent) => Promise<void>,
  ): void | Promise<void>;
  onLifecycle(
    handler: (state: LifecycleState, detail?: unknown) => void,
  ): void | Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendText(
    reply: RuntimeTextReply,
  ): Promise<void | Readonly<{ messageId: string }>>;
  sendAcknowledgement(
    acknowledgement: RuntimeAcknowledgement,
  ): Promise<Readonly<{ messageId: string }>>;
  sendFile(
    reply: RuntimeFileReply,
  ): Promise<void | Readonly<{ messageId: string }>>;
  sendConfirmationCard(
    card: RuntimeConfirmationCard,
  ): Promise<void | Readonly<{ messageId: string }>>;
  verifyCardAction(
    input: CardVerificationInput,
  ): Promise<TrustedCardEvidence | null>;
}

export type CodexRunEvent = Readonly<Record<string, unknown>>;

export type CodexRunResult =
  | Readonly<{
      status: "SUCCEEDED";
      exitCode: 0;
      signal: null;
    }>
  | Readonly<{
      status: "FAILED";
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      reason:
        | "spawn_error"
        | "non_zero_exit"
        | "signal_exit"
        | "stopped"
        | "invalid_output";
    }>;

export type CodexRunInput = Readonly<{
  taskId: string;
  prompt: string;
  workspace: string;
  gatewaySocket: string;
  gatewayClient: string;
  sessionId?: string;
}>;

export interface CodexRunHandle {
  readonly events: AsyncIterable<CodexRunEvent>;
  readonly result: Promise<CodexRunResult>;
  stop(): Promise<void>;
}

export interface CodexRunner {
  start(input: CodexRunInput): Promise<CodexRunHandle>;
}

export type MvpLarkCliRunnerFactory = (
  taskDirectory: string,
) => MvpLarkCliRunner;

export interface ExecutiveRuntime {
  readonly instanceId: string;
  waitForIdle(): Promise<void>;
  getTask(taskId: string): TaskRecord | null;
  close(): Promise<void>;
}

export type RuntimeDependencies = Readonly<{
  transport: RuntimeTransport;
  runner: CodexRunner;
  larkRunnerFactory: MvpLarkCliRunnerFactory;
  now?: () => Date;
  instanceId?: string;
  acknowledgementDelay?: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
}>;

export interface BotSecretProvider {
  load(appId: string, secretRef: RuntimeSecretRef): Promise<string>;
}

export type ProductionRuntimeDependencies = Readonly<{
  runner: CodexRunner;
  larkRunnerFactory?: MvpLarkCliRunnerFactory;
  secretProvider?: BotSecretProvider;
  now?: () => Date;
  instanceId?: string;
}>;
