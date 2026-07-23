# Codex 飞书总裁助理总路线图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在一台专用 Mac mini 上交付一个只能由总裁私聊、能安全调用飞书能力并可持续运行的 Codex 助理仓库。

**Architecture:** 仓库采用 TypeScript ESM monorepo，固定 vendor 的飞书长连接桥接层；所有入站事件先经过 fail-closed 检查并进入 SQLite 账本，再启动受限 Codex run。Codex 不能接触飞书凭据或原始 `lark-cli`，读取与写入只通过 Unix socket 动作网关，外部副作用由不可变预览、本人确认、幂等键和对账状态机约束。

**Tech Stack:** macOS 14+、Node.js 20/22/24/26 偶数主版本、pnpm 10.0.0、TypeScript 5.6.3、Vitest 2.1.8、tsup 8.3.5、better-sqlite3 12.11.1、Zod 4.4.3、YAML 2.9.0、Swift 5 Keychain helper、launchd、Codex CLI、`@larksuite/cli` 1.0.72。

## Global Constraints

- 服务对象固定为一位总裁、一台 Mac mini、一个飞书自建应用；第一版不做多租户。
- 上游 bridge 固定为 `v0.1.34` / `e8b0dc0cdfe2fb378bef7081618138a20d934aa9`，保留 MIT License 和补丁清单。
- `visual-first-ppt` 固定为 annotated tag `v0.3.0`：tag object `4962eb9bd5c55e8384b5228993c241b2220fcabb`、peeled commit `bb775f68f951c3e444d00623bc88976b20c13e7d`；安装与生产激活分别验收。
- 入站仅接受配对后的总裁 `open_id` 与私聊 `chat_id`；群聊、评论、表情、入群事件和斜杠命令全部 fail closed。
- `maxConcurrentRuns=1`；事件与任务落库成功后才允许发送“收到”确认。
- Codex 必须使用 `codex --ask-for-approval never --enable network_proxy` 与固定 `assistant-task` permission profile，再进入 `exec --strict-config --json --skip-git-repo-check`；`--ask-for-approval` 是全局参数，不能放在 `exec` 之后。profile 继承 `:workspace`，domain allowlist 为空，只放行 canonical 当前 task `gateway.sock`，并关闭 local binding、SOCKS、upstream proxy、非 loopback 暴露及全 Unix socket 旁路；禁止 `:danger-full-access`、调用方自选 profile 和会覆盖 profile 的旧 sandbox 配置。
- Codex 环境不包含 App Secret、OAuth Token、代理秘密或原始 `lark-cli` 路径。
- 飞书外部副作用只能通过动作网关；当前任务向原总裁私聊的系统回复是唯一无需二次审批的写入例外。
- SQLite 固定启用 WAL、`foreign_keys=ON`、`busy_timeout` 和 `synchronous=FULL`；数据库校验失败时停止接单。
- App Secret 固定存入 macOS Keychain；用户已于 2026-07-21 确认 `SECRET_STORAGE_PROFILE=KEYCHAIN_BACKED_ENCRYPTED_STORE`：官方 `.enc` 凭据文件为 `0600`、AES 主密钥只在 Keychain、严禁 `master.key.file` fallback，并要求生产 Codex sandbox 对同 ACL Keychain canary 的真实读取/使用测试失败；不符合该固定档位时为 `BLOCKED_SECRET_STORAGE`，不得自动切换到 fork 或其他存储方式。
- 所有路径做 `realpath` 校验；拒绝符号链接逃逸。任务目录为 `0700`，任务文件为 `0600`，进程 `umask 077`。
- 真实租户测试只能使用已同意的测试用户、测试群、日历和会议妙记；不得对生产对象做未授权测试。
- `doctor` 只读；`smoke-test` 只有在明确对象和确认后才能产生真实飞书动作。
- 本项目不修改客户整机睡眠、电源、FileVault、Apple ID、备份或系统升级配置。
- 本地 commit、push、PR、merge、发布分别是独立门禁；即使计划内写有 commit 步骤，执行者也必须先取得用户对该动作的明确授权。

---

## 1. 锁定的仓库结构

~~~text
codex-feishu-executive-assistant/
  AGENTS.md
  README.md
  BOOTSTRAP.md
  CHANGELOG.md
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  tsconfig.base.json
  vitest.workspace.ts
  dependencies.lock.json
  LICENSES/
    lark-codex-bridge-MIT.txt
  packages/
    contracts/
      src/
    bridge/
      UPSTREAM.md
      PATCHES.md
      src/
      test/
    job-store/
      migrations/
      src/
      test/
    action-gateway/
      native/keychain-helper/
      native/run-client/
      native/control-client/
      src/
      test/
    capabilities/
      src/
      test/
    ops-cli/
      src/
      test/
    acceptance/
      src/
      test/
  config/
    capabilities.yaml
    feishu-scopes.yaml
    policy.schema.json
    policy.example.yaml
  skills/
    executive-assistant/
      SKILL.md
      references/
  scripts/
    preflight
    install
    configure
    doctor
    smoke-test
    soak-test
    uninstall
    vendor-bridge
  launchd/
    com.codex-feishu.executive-assistant.gateway.plist.template
    com.codex-feishu.executive-assistant.bridge.plist.template
    com.codex-feishu.executive-assistant.watchdog.plist.template
  tests/
    contracts/
    integration/
    security/
    e2e/
    fixtures/
  docs/
    permissions/
    runbook/
    acceptance/
    superpowers/specs/
    superpowers/plans/
~~~

职责边界：

- `contracts` 只放跨包稳定类型、错误码和协议解析，不访问磁盘或网络。
- `bridge` 只负责长连接、入站鉴权、附件接收、Codex run 和原会话回复；不直接执行飞书业务 API。
- `job-store` 是事件、任务、动作、审批和执行结果的唯一事实源。
- `action-gateway` 持有飞书凭据、运行固定身份的 `lark-cli`、执行动作并对账。
- `ops-cli` 负责安装、配置、诊断、服务管理和验收，不承载聊天业务逻辑。
- `executive-assistant` Skill 负责自然语言路由和交互规则，不包含飞书 SDK 或 PPT 实现。

## 2. 跨计划稳定接口

以下接口由第一份计划建立，后续计划只能以兼容方式扩展：

```ts
export type AssistantStatus =
  | "PASS"
  | "BLOCKED_HOST_READINESS"
  | "BLOCKED_APP_PUBLISH"
  | "BLOCKED_SCOPE"
  | "BLOCKED_USER_AUTH"
  | "BLOCKED_SECRET_STORAGE"
  | "BLOCKED_VISIBILITY"
  | "BLOCKED_RESOURCE_PERMISSION"
  | "BLOCKED_CAPABILITY"
  | "UNVERIFIED_NO_FIXTURE"
  | "INTERRUPTED_REQUIRES_CONFIRMATION"
  | "BLOCKED_RUNTIME_STATE"
  | "BLOCKED_REPO_BOUNDARY"
  | "FAILED_DEPENDENCY";

export type InboundEvent = Readonly<{
  appId: string;
  tenantKey: string;
  eventId: string;
  messageId: string;
  senderOpenId: string;
  chatId: string;
  chatType: "p2p";
  eventType: "im.message.receive_v1";
  receivedAt: string;
  payloadRef: string;
}>;

export interface TaskSink {
  ingest(event: InboundEvent): Promise<{
    taskId: string;
    duplicate: boolean;
  }>;
}

export type CancelActiveTaskRequest = Readonly<Pick<InboundEvent,
  "appId" | "tenantKey" | "eventId" | "messageId" | "senderOpenId" | "chatId" | "receivedAt"
>>;

export type CancelActiveTaskResult = Readonly<{
  controlEventId: string;
  taskId: string | null;
  cancelled: boolean;
  duplicate: boolean;
  externalEffectsPending: boolean;
}>;

export interface TaskControlSink {
  cancelActive(request: CancelActiveTaskRequest): Promise<CancelActiveTaskResult>;
}

export interface RunGatewayClient {
  read<T>(request: ReadRequest): Promise<T>;
  prepare(request: PrepareActionRequest): Promise<PreparedAction>;
  systemReply(request: SystemReplyRequest): Promise<GatewayResult>;
}

export type SystemReplyBody = Readonly<
  | { type: "text"; value: string }
  | { type: "file"; value: string }
>;

export type ConfirmationCallback = Readonly<{
  actionId: string;
  nonce: string;
  actorOpenId: string;
  chatId: string;
}>;

export type ApprovalDecision = Readonly<{ accepted: boolean }>;

export interface BridgeGatewayClient {
  sendSystemReply(taskId: string, body: SystemReplyBody): Promise<GatewayResult>;
  sendControlReply(controlEventId: string, body: SystemReplyBody): Promise<GatewayResult>;
  submitApproval(callback: ConfirmationCallback): Promise<ApprovalDecision>;
}
```

`RunGatewayClient` 连接当前任务目录中的 task-bound socket；它的请求不得包含 task_id、identity 或目标 chat。`BridgeGatewayClient` 只在 bridge 控制面使用，不暴露给 Codex。

动作状态固定为：

```ts
export type ActionState =
  | "PREPARED"
  | "APPROVED"
  | "CLAIMED"
  | "DISPATCHING"
  | "SUCCEEDED"
  | "FAILED"
  | "UNKNOWN"
  | "RECONCILED";
```

任务状态固定为：

```ts
export type TaskState =
  | "RECEIVED"
  | "CLAIMED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "INTERRUPTED_REQUIRES_CONFIRMATION";
```

## 3. 四份实施计划与依赖顺序

`SECRET_STORAGE_PROFILE` 决策记录（2026-07-21）：

1. `KEYCHAIN_BACKED_ENCRYPTED_STORE`（已选择）：复用官方 1.0.72 存储，硬阻断 `master.key.file`，并把 Codex Keychain canary 越界测试绑定到已安装 Codex binary hash；版本或 hash 变化就重新验收。
2. `STRICT_KEYCHAIN_TOKEN_FORK`（未选择）：只作为未来重新打开设计评审时的备选，不属于当前实施范围。

当前实施只能走已选择的第一种方案。任何改档都不属于实现中的自由裁量，必须先重新审阅规格并取得用户明确确认；无论改档与否，Token 都不得进入 Codex。

### 阶段 A：仓库基础与加固 bridge

计划文件：`2026-07-20-01-foundation-and-bridge.md`

退出条件：

- monorepo 可重复安装、构建、类型检查和测试。
- vendor 来源、License、锁定提交和补丁都可机器验证。
- 所有非总裁私聊入口在下载附件和启动 Codex 前被拒绝。
- Codex argv、工作目录和环境变量由测试证明符合限制。
- bridge 只依赖 `TaskSink` 与 `BridgeGatewayClient` 接口，不直接调用业务 API。

### 阶段 B：持久账本与安全动作网关

计划文件：`2026-07-20-02-job-store-and-action-gateway.md`

依赖：阶段 A 的 contracts 与 bridge seams。

退出条件：

- 重放同一 `(app_id, tenant_key, event_id)` 只产生一个任务。
- 任务、审批和动作状态机通过崩溃、租约、并发和重启测试。
- Keychain helper、Unix socket ACL、最小环境和固定 `lark-cli` 身份通过安全测试。
- 延迟确认、旧哈希、过期 nonce、二次消费和无法对账的重放全部被拒绝。
- 附件和日志规则通过容量、MIME、权限、脱敏及符号链接测试。

### 阶段 C：飞书业务能力与 PPT

计划文件：`2026-07-20-03-feishu-capabilities-and-ppt.md`

依赖：阶段 B 的 `JobStore`、`RunGatewayClient` 与动作网关。

退出条件：

- 联系人、妙记、日历、通知、文件回传都使用固定结构化动作。
- Bot 与 User 身份由网关动作族固定，调用方不能传入任意身份。
- 所有写能力都有 dry-run、审批、稳定幂等键和 UNKNOWN 对账算法。
- `executive-assistant` Skill 能把自然语言准确路由到能力合同。
- `visual-first-ppt` 的 create、template、edit 均具有生产环境验收脚本和证据格式。

### 阶段 D：一站式安装、24H 运维与真实验收

计划文件：`2026-07-20-04-installation-reliability-and-acceptance.md`

依赖：阶段 A、B、C 全部通过本地自动测试。

退出条件：

- `preflight → install → configure → doctor → smoke-test → soak-test` 状态闭环。
- 受控 LaunchAgent 和 watchdog 满足 60 秒拉起、30 秒心跳、2 分钟重连及 30 分钟 Codex idle 停止指标。
- 连续 24 小时 soak test 生成脱敏机器证据与中文报告。
- 干净 macOS 用户环境可以只凭 GitHub 地址和明确人工步骤完成安装。
- uninstall 默认保留输出和 Keychain，删除秘密必须另行确认。

## 4. 逐门禁执行顺序

1. 审阅并批准本路线图和四份子计划。
2. 当前目录只是父仓库中的未跟踪目录；实施前先取得用户授权，将其建立为独立 GitHub 仓库或独立 clone，再创建 feature branch/worktree，并使用 `superpowers:using-git-worktrees`。
3. 按 A → B → C → D 顺序执行；每个任务先红测、再最小实现、再绿测。
4. 每项任务完成后做规格符合性 review，再进入下一项。
5. 所有本地测试通过后，单独申请本地 commit 授权。
6. 在干净 macOS 用户环境执行安装测试，不使用开发 checkout 作为交付证据。
7. 在目标 Mac mini 执行安装；目标飞书租户写操作逐项确认。
8. 完成 24 小时 soak test 和真实客户端证据后，状态才能进入 `VERIFIED`。
9. push、PR、merge 和 release 必须分别获得授权。

## 5. 规格追踪矩阵

| 规格章节 | 主要实施计划 | 证明方式 |
| --- | --- | --- |
| 3 范围 | A、C、D | 能力清单测试与首版阻断测试 |
| 4 可用性 | D | launchd、watchdog、重连、idle、24H soak |
| 5 总体架构 | A、B | package 边界和集成测试 |
| 6.1–6.2 飞书与 bridge | A | vendor、鉴权、私聊负向测试 |
| 6.3 账本与网关 | B | SQLite 状态机、审批、幂等、对账 |
| 6.4 Codex Runtime | A、B | argv/env/cwd/socket/网络边界测试 |
| 6.5 lark-cli | B、C | 固定身份执行器和 JSON 解析测试 |
| 6.6 Skill | C | 路由 contract test 与真实任务证据 |
| 6.7 PPT | C、D | doctor + 生产 LaunchAgent create/template/edit |
| 6.8 launchd | D | plist 静态测试与运行恢复测试 |
| 7 自然语言交互 | A、B、C | 事件、进度、审批、中止集成测试 |
| 8–10 飞书能力边界 | C | 真实租户 capability smoke test |
| 11 数据与密钥 | B、D | Keychain、权限、附件、日志、卸载测试 |
| 12–13 仓库与安装 | A、D | clean-room 安装和中文报告 |
| 14 状态模型 | A、B、C、D | 共享 enum 与失败注入测试 |
| 15 验收 | D | 自动测试、真实客户端证据、24H 报告 |
| 16 发布门禁 | 本路线图 | 独立状态记录与逐项授权 |

## 6. 每阶段统一质量命令

每份子计划完成后都必须执行：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

预期结果：六条命令退出码均为 `0`，测试输出没有 skipped 的安全或状态机用例。

提交前还必须执行：

```bash
git diff --check
git status --short
```

预期结果：`git diff --check` 无输出；`git status --short` 只列出当前获批任务范围内的文件。

## 7. 计划完成定义

- 四份子计划中的每个接口都能追溯到创建它的任务。
- 每个安全承诺至少有一个正向测试和一个负向测试。
- 每个真实飞书动作都有自动 dry-run 测试与独立的目标租户 E2E 门禁。
- 所有人工步骤均出现在 `BOOTSTRAP.md` 或验收 runbook 中，不隐藏在开发者终端历史里。
- 任何未获得真实租户证据的能力只能标为 `UNVERIFIED_NO_FIXTURE` 或对应 `BLOCKED_*`，不能写成 `PASS`。
- 规格、路线图和四份子计划已于 2026-07-21 封版；`SECRET_STORAGE_PROFILE` 固定为 `KEYCHAIN_BACKED_ENCRYPTED_STORE`。
- 计划获批不等于授权实现、commit、push、PR、merge、部署或发布。
