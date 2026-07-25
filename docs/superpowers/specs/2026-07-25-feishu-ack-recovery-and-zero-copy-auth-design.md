# 飞书 ACK 安全恢复与零复制授权设计

- 日期：2026-07-25
- 方案状态：方案 A 与本文规格已由用户确认
- 实施状态：`LOCAL_IMPLEMENTED_AWAITING_FULL_GATES_PUBLIC_PUSH_REAL_ACCEPTANCE`
- 适用范围：一位总裁、一台专用 Mac、一个飞书自建应用

本文对应实现已在本地分支完成并通过相关离线定向回归，但完整仓库门禁、公开
`main` 推送、目标 Mac mini 重新安装和真实飞书回放仍待后续门禁。此状态不代表
production ready、24H 就绪或客户验收完成。

## 1. 目标

本次补修解决两个已经在真实模拟安装中暴露的问题：

1. 飞书 REST 域名发生短暂 DNS 解析失败时，消息虽然已经持久化，但接单回复失败，任务会一直停在 `RECEIVED`，直到后续启动恢复把它转为需要人工确认。
2. 飞书用户 OAuth 依赖终端输出授权链接，用户还要复制链接、打开浏览器并粘贴；这不符合给非技术高管使用的“一次执行、按提示授权”体验。

完成后应达到：

- DNS 暂时不可用时，任务继续安全等待；网络恢复后自动补发接单回复，并且只执行一次。
- 任何无法证明“接单回复肯定没有发出”的失败都不自动重试，也不启动 Codex。
- `doctor` 能只读区分飞书 DNS 和 HTTPS/REST 可达性问题。
- 安装器从可信结构化输出取得授权地址，由 macOS 直接打开默认浏览器；正常流程不要求用户复制、粘贴或手工输入 URL。

## 2. 已确认的真实故障事实

本次模拟环境中观察到：

- 两条总裁私聊事件均已进入本地账本。
- 接单阶段出现 6 次飞书开放平台域名解析失败，对应 2 次固定的 `ASSISTANT_TASK_ACK_FAILED`。
- 两条任务没有 ACK 标记，也没有启动 Codex；后续恢复时被安全转为未完成状态。
- DNS 恢复后，同一套 Node、系统解析和 HTTPS 探测重新可用，下一条任务完成了接单、Codex 执行和最终回复。

这些证据说明问题位于“持久化完成之后、ACK 成功之前”，不是飞书长连接丢消息，也不是 Codex 执行失败。

本文和后续测试只记录固定错误分类、数量和状态，不记录客户消息正文、完整人员 ID、Token、Secret、真实路由或原始 SDK 错误。

## 3. 不可放宽的安全不变量

1. 顺序固定为：事件持久化 → ACK 成功证据持久化 → 任务可 claim → Codex 启动。
2. 没有有效 `acknowledged.json` 的任务不得启动 Codex。
3. 数据库没有 `ACKNOWLEDGED` 事实的任务不得被 `claimNextTask` 选中。
4. 自动重试只适用于本机在发起 HTTP 请求前已经得到的、可证明没有远端效果的 DNS 解析失败。
5. 超时、连接中断、进程崩溃、未知 SDK 错误、远端响应丢失和本地 ACK 证据写入失败均视为结果不确定，不自动重发 ACK，也不执行任务。
6. 对外写操作的预览、本人确认、一次性消费和 `UNKNOWN` 对账规则不变。
7. App Secret 仍只通过 macOS Keychain 可见输入；OAuth Token、授权 URL 和设备码不得进入日志、仓库或长期配置。
8. 本次不修改 VPN、DNS、网络代理、FileVault、睡眠、电源、Apple ID 或整机运维设置。

## 4. 方案选择

### 4.1 采用：持久 ACK 协调器

在 runtime 与现有 bridge 端口之间增加一个单实例、FIFO 的 ACK 协调器。它负责：

- 持久记录 ACK 发送前、确定 DNS 失败、成功和结果不确定状态；
- 对确定 DNS 失败执行有上限间隔的持续恢复；
- 重启后只恢复可以证明尚未产生远端效果的 ACK；
- ACK 成功后写文件证据、写数据库事实，再唤醒任务 worker；
- 从私有 `input.json` 恢复回复路由，不把路由放进日志或新增公开配置。

该方案保留现有 bridge 的“persist → ACK → wake”合同。bridge 对重复事件的早返回也不需要放宽：runtime 的 `TaskSink` 在返回 duplicate 之前恢复路由并唤醒 ACK 协调器。

### 4.2 不采用：收到消息后先执行，再补 ACK

这会破坏总裁可见的接单语义，并可能在用户以为任务未受理时产生外部效果。

### 4.3 不采用：对所有 ACK 错误统一重试

超时或连接关闭可能发生在飞书已经接收消息之后。统一重试可能重复发送接单回复，且无法提供“只执行一次”的可信边界。

### 4.4 不采用：只依赖下一条消息或人工重启

这种方式不能满足 24H ON CALL，也会让非技术用户承担诊断和恢复工作。

## 5. 持久 ACK 数据模型

新增 checksum migration 和 `task_acknowledgements` 表。它只保存任务关联、状态、尝试次数、固定失败分类和时间，不保存消息正文、完整路由、远端错误或凭据。

状态固定为：

| 状态 | 含义 | 自动恢复 |
| --- | --- | --- |
| `NOT_ATTEMPTED` | 新任务已与事件在同一事务中持久化，尚未尝试 ACK | 是 |
| `SENDING` | 已在数据库记录即将发送，发送结果尚未确定 | 仅有有效 ACK 文件时 |
| `RETRYABLE_DNS` | 本次失败被严格证明为 DNS 解析阶段失败，未产生远端效果 | 是 |
| `ACKNOWLEDGED` | 远端发送成功、ACK 文件已持久化、数据库已确认 | 不需要 |
| `AMBIGUOUS` | 发送或本地证据结果不确定 | 否 |
| `FAILED_DEFINITE` | 明确拒绝且不会产生远端效果，例如权限或请求合同错误 | 否 |

### 5.1 新任务

`ingestEvent` 在创建 `RECEIVED` 任务的同一 SQLite 事务中创建
`NOT_ATTEMPTED` ACK 行。任何一项写入失败都整笔回滚。

### 5.2 旧任务兼容

迁移不会把历史 `RECEIVED` 任务自动标成 `NOT_ATTEMPTED`。旧版本在尝试 ACK 前没有独立持久状态，因此“没有 ACK 行”不能证明从未发送。

- 有有效 `acknowledged.json`：允许补建 `ACKNOWLEDGED` 事实。
- 没有 ACK 文件且没有 ACK 行：按历史不确定状态转为
  `INTERRUPTED_REQUIRES_CONFIRMATION`。

这样不会把升级前的模糊任务误当作可自动重试任务。

### 5.3 双重执行门禁

`claimNextTask` 只选择：

- `tasks.state = RECEIVED`；
- ACK 行为 `ACKNOWLEDGED`；
- 其他既有租约和单并发条件全部满足。

worker 在启动 Codex 前继续复核任务目录中的 `acknowledged.json`。数据库或文件任一证据缺失都不得启动 runner。

## 6. ACK 状态机

~~~mermaid
stateDiagram-v2
    [*] --> NOT_ATTEMPTED
    NOT_ATTEMPTED --> SENDING: 持久化发送意图
    RETRYABLE_DNS --> SENDING: 到达下一次恢复时间
    SENDING --> RETRYABLE_DNS: 严格 DNS 失败
    SENDING --> ACKNOWLEDGED: 远端成功 + 文件成功 + DB 成功
    SENDING --> AMBIGUOUS: 超时、断连、崩溃或本地证据失败
    SENDING --> FAILED_DEFINITE: 权限或合同明确拒绝
    RETRYABLE_DNS --> AMBIGUOUS: 后续失败不再属于严格 DNS
~~~

发送步骤固定为：

1. 在持有 live bridge lease 的事务中把 ACK 状态改为 `SENDING`，并增加尝试次数。
2. 使用已持久化私有输入恢复的原 `chatId` 和 `messageId` 发送固定接单文案。
3. 只有远端调用明确成功后，原子创建权限 `0600` 的
   `acknowledged.json`。
4. 文件成功后，把数据库状态改为 `ACKNOWLEDGED`。
5. 数据库确认后，唤醒单并发任务 worker。

如果步骤 3 完成而步骤 4 前进程退出，重启恢复可用 ACK 文件补齐数据库事实。若步骤 2 后步骤 3 失败，远端 ACK 已可能成功但本地证据不完整，必须进入 `AMBIGUOUS`，禁止重发和执行。

## 7. DNS 自动恢复

### 7.1 可重试分类

只接受 Node 标准 DNS 解析错误的严格允许列表：

- `ENOTFOUND`
- `EAI_AGAIN`

分类器只读取受控的错误码字段，不输出错误对象、host、地址、请求参数或 SDK 堆栈。无法安全读取、存在未知包装层或错误码不在允许列表时，一律不是可重试 DNS。

### 7.2 FIFO 与单实例

- ACK 协调器受现有 bridge runtime lease 约束，同一数据库只能有一个实例。
- ACK 按任务创建顺序串行处理。
- 最早任务处于 `RETRYABLE_DNS` 时，后续任务保持等待，避免可见 ACK 和任务执行乱序。
- 同一任务只允许一个 in-flight ACK promise。
- 重复飞书事件只恢复原 task 的私有路由并唤醒协调器，不创建第二个任务、不增加第二条并行发送链。

### 7.3 退避

确定 DNS 失败采用确定性的逐级退避：

`1s → 2s → 4s → 8s → 15s → 30s → 60s`

之后保持 60 秒上限，直到以下任一条件成立：

- DNS 恢复并 ACK 成功；
- 失败类型变为非 DNS；
- runtime 正常关闭；
- runtime lease 丢失；
- 任务被明确取消或转为终态。

退避计时器不构成事实源。进程重启后根据数据库状态重新排队，尝试次数保留，定时器重新计算。

## 8. 启动与重复事件恢复

启动顺序调整为：

1. 取得数据库文件锁和 bridge runtime lease。
2. 执行 ACK-aware startup recovery。
3. 对安全可恢复任务严格读取 `input.json`，复核 canonical 路径、owner、权限和固定 schema。
4. 建立飞书 transport/channel。
5. 启动 ACK 协调器。
6. 只有 ACK 成功任务才进入原有单并发 worker。

startup recovery 规则：

- `NOT_ATTEMPTED`、`RETRYABLE_DNS`：保持 `RECEIVED` 并排队。
- `SENDING` 且存在有效 ACK 文件：补齐 `ACKNOWLEDGED`。
- `SENDING` 且没有 ACK 文件：转 `AMBIGUOUS`，任务进入
  `INTERRUPTED_REQUIRES_CONFIRMATION`。
- `AMBIGUOUS`、历史无 ACK 行且无 ACK 文件：任务进入
  `INTERRUPTED_REQUIRES_CONFIRMATION`。
- `ACKNOWLEDGED` 但 ACK 文件缺失或不可信：禁止执行并进入
  `BLOCKED_RUNTIME_STATE` 或需要人工确认状态。

## 9. doctor 的飞书网络检查

`doctor` 保持只读，不使用 App Secret、Bot Token、用户 Token，也不调用任何写接口。

新增两项独立检查：

1. `feishu-dns`：使用安装配置中记录的 Node 绝对路径解析
   `open.feishu.cn`，只报告是否至少得到一个结果，不输出 IP。
2. `feishu-https-rest`：在精简环境中对固定公开
   `https://open.feishu.cn/open-apis/` 发起有界 HTTPS 请求。收到任何有效 HTTP 状态码即证明 DNS、TCP、TLS 和 HTTP 路径可达；不把 4xx 当作网络失败，也不发送凭据。

检查使用固定超时，不继承 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、
`NO_PROXY` 或用户 shell 初始化。对用户只输出：

- `PASS`
- `DNS_UNAVAILABLE`
- `REST_UNREACHABLE`

诊断不得输出解析地址、代理信息、私有路径、原始异常、请求头或响应正文。

## 10. 零复制 OAuth

安装器仅在 `--apply` 且确实缺少 MVP 用户权限时执行授权。`--plan`、
`--verify-only` 和 `doctor` 都不得打开浏览器。

流程固定为：

1. 使用锁定的 `lark-cli 1.0.72`、固定 profile 和精确缺失 scope 调用
   `auth login --no-wait --json`。
2. 对 stdout 执行大小限制、fatal UTF-8、strict JSON 和 exact schema 校验。
3. 从官方 1.0.72 实现与真实 fixture 锁定授权 URL 和 device code 字段，不猜测字段，也不从自然语言日志提取。
4. URL 必须为 HTTPS、没有 username/password、换行、NUL 或 fragment，host 必须属于从锁定官方实现审计得到的精确允许列表。
5. 调用绝对路径 `/usr/bin/open` 打开授权 URL。
6. 只向同一个锁定 CLI 进程族提供短期 device code，执行
   `auth login --device-code <code>` 等待授权完成。
7. 再运行既有 `auth status` 和 `auth check --scope`，确认用户身份、令牌健康和 6 项 MVP 权限差额为零。

用户在终端只看到“已打开飞书授权页，请在浏览器完成授权”。安装器不得打印授权 URL 或 device code。

若 `/usr/bin/open` 不存在、返回非零、当前会话没有 macOS 图形界面，或 URL/schema 校验失败：

- 立即停止在 `BLOCKED_USER_AUTH`；
- 提示用户在这台 Mac 的可见终端重新运行安装；
- 不把 URL 作为复制粘贴 fallback；
- 不扩大 scope，不降级为 Bot 身份，不把临时值写入文件或日志。

## 11. 固定诊断分类

运行时和安装器只允许下列与本次补修相关的公开分类：

- `DNS_UNAVAILABLE`
- `REST_UNREACHABLE`
- `PERMISSION_DENIED`
- `TARGET_UNAVAILABLE`
- `AMBIGUOUS_SEND`
- `LOCAL_ACK_PERSIST_FAILED`
- `AUTH_BROWSER_OPEN_FAILED`
- `AUTH_OUTPUT_INVALID`

内部可以保留不含敏感数据的计数和状态迁移，但不得向飞书、GitHub Actions、
公开 Issue 或验收报告复制原始 SDK/CLI 错误。

## 12. 测试策略

实施必须先新增失败测试，再写生产代码。

### 12.1 ACK 与恢复

- 新任务在 ACK 文件和数据库事实完成前不能 claim。
- 连续 3 次 `ENOTFOUND` 后恢复：只发送 1 条成功 ACK，只启动 1 次 Codex。
- `EAI_AGAIN` 重启后从 `RETRYABLE_DNS` 恢复。
- 进程在 `SENDING` 期间崩溃且无 ACK 文件：不重发、不执行，进入人工确认。
- 进程在 ACK 文件写入后、数据库更新前崩溃：重启后补齐事实并只执行一次。
- timeout、连接关闭和未知错误：不自动重试、不执行。
- 权限明确拒绝：不执行，记录 `FAILED_DEFINITE`。
- ACK 成功但文件写入失败：不重发、不执行。
- 重复 event 恢复原路由并唤醒同一任务，不创建第二个任务。
- 多条 DNS 等待任务按 FIFO 恢复。
- 旧任务无 ACK 行、无 ACK 文件时不被自动恢复。
- 日志与错误中没有正文、完整 ID、IP、URL、device code 或原始异常。

### 12.2 doctor

- 系统 DNS 失败与 HTTPS 失败分别返回固定分类。
- HTTP 4xx 仍算 HTTPS/REST transport 可达。
- 超时有界，检查不写配置、不读取秘密、不继承代理环境。
- 使用安装配置中的绝对 Node 路径，而不是交互 shell `PATH`。

### 12.3 OAuth

- fake `lark-cli` 提供锁定的 `--no-wait --json` fixture，fake browser opener
  证明 URL 只通过 argv 传给 opener，终端输出不含 URL。
- URL 的 `http`、错误 host、userinfo、fragment、换行、NUL、额外字段、
  重复 JSON 键和超限输出全部 fail closed。
- opener 失败时不调用 device-code continuation。
- 成功时只申请缺失 scope，并在最终 `auth status`/`auth check` 通过后继续。
- `--plan`、`--verify-only`、`doctor` 不打开浏览器。

## 13. 文档与用户体验

实现完成时同步更新：

- `README.md`：GitHub 地址开始安装、浏览器自动打开、无需 Tenant Key。
- `BOOTSTRAP.md`：用户只需在 Keychain 窗口输入 App Secret、在自动打开的浏览器点击授权、在飞书发送配对码。
- `CHANGELOG.md`：记录 ACK 恢复、doctor 网络诊断和零复制授权。
- 安装输出：每一步只告诉用户当前状态和下一项人工动作，不显示开发者堆栈。

## 14. 验收与发布门禁

本次实现完成不等于客户 Mac mini 生产验收完成。门禁顺序为：

1. 本文书面复核通过。
2. 实施计划复核通过。
3. 红测、最小实现、全仓门禁通过。
4. 本地 commit。
5. 推送公开 `main`，等待 GitHub Actions 通过。
6. 从公开 GitHub 地址在当前 MacBook Air 重跑增量安装。
7. 验证授权页由终端自动打开。
8. 制造可控 DNS fixture，验证等待与恢复；不得修改真实 VPN/DNS。
9. 真实总裁私聊完成一次 ACK → Codex → 最终回复回环。
10. 目标 Mac mini 安装、真实飞书能力和 24 小时 soak test 仍分别验收。

本轮不创建 PR、Tag 或 Release，不修改真实 DNS/VPN，不执行未经总裁确认的日历或通知写操作。
