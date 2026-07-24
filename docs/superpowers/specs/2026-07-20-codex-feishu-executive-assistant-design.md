# Mac mini 24H ON CALL 飞书 Codex AI 助理设计规格

- 日期：2026-07-20
- 设计状态：已于 2026-07-21 完整确认并封版；`SECRET_STORAGE_PROFILE=KEYCHAIN_BACKED_ENCRYPTED_STORE`
- 实施状态：Stage A / Tasks 1–7 已达到 `STAGE_A_SEAMS_VERIFIED`；Stage B / Tasks 1–6 已完成本地提交，Task 6 状态为 `STAGE_B_TASK6_LOCAL_COMMITTED`。Task 6 只完成 native Keychain helper、固定身份 runner、synthetic OAuth 存储审计和本地构建/测试证据；真实 Keychain ACL/canary、OAuth health、生产 release evidence producer、live wiring、客户 Mac mini 实际配置栈、真实飞书/Codex E2E、部署与 24 小时可用性仍未完成。动态实施事实以 README 和阶段 B 计划为准。remote 配置/创建、push、PR、deploy 和真实飞书写操作仍须逐项另行授权，且均未执行。
- 目标用户：一位总裁
- 运行设备：一台放在家中的专用 Mac mini
- 主要入口：飞书私聊机器人

## 1. 摘要

本项目交付一个运行在客户 Mac mini 上的个人飞书 AI 助理。总裁通过手机飞书用自然语言下达任务；本机桥接服务把消息、附件和上下文交给已登录的 Codex CLI；Codex 根据仓库内的长期规则和 Skills 完成资料处理，并在需要时调用飞书官方 CLI 操作会议纪要、日历和消息。

系统不自建通用 Agent 平台，也不把客户资料迁移到新的 SaaS。它复用下列成熟组件并增加一层面向总裁的安装、权限、安全和验收流程：

1. lark-codex-bridge 的固定版本分支：飞书长连接、消息收发、附件下载和 Codex 会话。
2. 持久任务账本与动作网关：消息去重、任务恢复、外部动作确认和幂等。
3. Codex CLI：本地任务执行与文件处理。
4. lark-cli：飞书开放接口调用和结构化预处理。
5. executive-assistant Skill：总裁工作流、身份选择、确认规则和自然语言体验。
6. visual-first-ppt：PPT 创建、套模板和局部修改。

交付目标是“一个 GitHub 地址即可让 Codex 完成安装”。安装中必须由人完成的动作会被压缩为中文引导：必要时输入 macOS 管理员密码、为机器人专用 CODEX_HOME 完成一次 Codex 登录、飞书扫码授权和批准必要的系统隐私权限。

## 2. 已确认的核心决策

1. 一位总裁、一台 Mac mini、一个飞书机器人应用。
2. 总裁不使用斜杠命令，只使用自然语言。
3. 机器人收到任务后立即确认；长任务主动汇报进度；最终回复简洁。
4. 读取、整理和本地生成可直接执行；对外发送、创建或变更日程等动作先预览再确认。
5. 默认以机器人身份通知他人；只有总裁明确要求“以我的名义发送”时，才申请使用用户身份并再次确认。
6. 总裁个人日历、会议妙记和个人飞书资源使用用户 OAuth 身份。
7. App ID 和 App Secret 只够完成机器人身份初始化；总裁首次还需扫码授权用户身份。
8. PPT 直接调用 banqiusheng/visual-first-ppt，不重复实现。
9. PPT 默认回传预览图、可编辑 PPTX 和 PDF；完整 ZIP 按项目保存在 Mac mini 上，需要时再取。
10. FileVault 保持开启；整机重启后由本人登录一次，之后服务自动恢复。
11. 本项目不承担客户电脑备份、硬件、家庭网络、Apple ID、Time Machine 或 macOS 日常运维。

## 3. 范围

### 3.1 第一版包含

- 飞书私聊机器人接收自然语言、图片和文件。
- 消息即时确认、排队、进度反馈、完成结果和可理解的错误说明。
- 本地 Codex 会话和受限工作目录。
- 飞书会议妙记检索、读取、逐字稿导出和二次总结。
- 创建、修改、邀请参与人和取消总裁日历中的日程。
- 以机器人身份通知单个内部用户或机器人已加入的既有群。
- 经明确指令和确认后，以总裁用户身份发送消息。
- PPT 从零制作、基于模板制作和局部修改。
- macOS 用户级 launchd 常驻、异常自动拉起和状态诊断。
- GitHub 一站式安装、版本锁定、权限检查、真实租户冒烟测试和中文验收报告。

### 3.2 第一版不包含

- 通用多租户 Agent 平台、管理后台或 SaaS 控制台。
- 多位总裁共用、开放群聊问答或任意员工调用机器人。
- 新建大群、批量广播、批量拉人或跨租户营销消息。
- 自动创建飞书原生 VC Note；公开接口未提供已确认的原生 Note 创建能力。
- 绕过 FileVault、无人值守完成磁盘解锁或静默关闭系统安全能力。
- Mac mini 资料备份、磁盘维护、系统升级、家庭网络和硬件维护。
- 对飞书、Codex 或网络服务不可用期间作绝对不丢消息承诺。
- 自动发布或自动升级上游依赖。

## 4. 可用性承诺

“24H ON CALL”定义为：

> 在 Mac mini 已开机、接通电源、保持系统唤醒、联网、用户已登录，且飞书和 Codex 外部服务可用时，飞书 AI 助理持续监听并自动恢复自身进程。

这不是对断电、硬件故障、家庭网络中断、飞书故障或 Codex 服务故障的无限责任承诺。

客户负责保持主机供电、系统唤醒、网络可用和重启后首次登录。本项目的 preflight 只读检查这些前提；不替客户修改整机电源和睡眠策略。任一前提不满足时，状态为 BLOCKED_HOST_READINESS，不能宣称 24H 验收通过。

### 4.1 正常运行

- 飞书通过长连接把事件送到本机，不要求家庭网络开放公网端口。
- bridge 由用户级 launchd 托管并启用 KeepAlive。
- bridge 异常退出后由 launchd 自动重新拉起。
- 飞书连接断开后自动重连。
- 每个飞书会话保留对应的 Codex 会话映射。

### 4.2 整机重启

1. Mac mini 重启并停留在 FileVault 登录界面。
2. 本人或家里人员登录一次。
3. 用户级 launchd 启动 bridge。
4. bridge 恢复飞书长连接和 Codex 会话映射。
5. 机器人通过自检后恢复接单。

### 4.3 运行中断

- 已完成的结果和会话映射保留在本机。
- 正在运行的任务如果因进程或整机重启中断，不静默重复执行。
- 恢复后机器人说明中断位置，并询问总裁是否继续。
- 任何可能产生外部副作用的步骤在恢复后都必须重新确认。
- 尚未送达本机的消息受飞书事件重试和网络状态约束；系统不得声称绝对不丢。

### 4.4 可测运行目标

- 正常网络下，bridge 收到飞书事件后 10 秒内返回接单确认。
- bridge 进程退出后，launchd 在 60 秒内重新拉起。
- 独立本地 watchdog 每 30 秒检查一次 bridge 心跳；连续两次失败时终止失活进程，由 launchd 重启。
- 网络恢复后，飞书 WebSocket 在 2 分钟内重新连接。
- Codex run 连续 30 分钟没有任何事件时判定为卡死，停止该 run 并告知总裁。
- 正式交付前完成连续 24 小时 soak test，期间定时记录本地心跳、连接状态和进程重启次数。
- 上述时间只衡量本项目服务，不把飞书、Codex、家庭网络或任务生成耗时计入外部 SLA。

## 5. 总体架构

~~~mermaid
flowchart LR
    A["总裁手机飞书"] <-->|"长连接事件 / 回复"| B["飞书自建应用机器人"]
    B <-->|"WebSocket"| C["lark-codex-bridge"]
    C --> D["访问控制与 SQLite 任务账本"]
    D --> E["本机 Codex CLI"]
    E --> F["executive-assistant Skill"]
    F --> M["外部动作确认与幂等网关"]
    M --> G["lark-cli"]
    F --> H["visual-first-ppt"]
    G --> B
    H --> I["PPTX / PDF / 预览 / ZIP"]
    I --> C
    J["macOS launchd"] --> C
    K["macOS Keychain"] --> C
    K --> G
    L["受限本地工作区"] <--> E
~~~

## 6. 组件设计

### 6.1 飞书自建应用

- 仅为该总裁和本项目使用。
- 接收事件使用长连接模式，不暴露家庭公网入口。
- 应用可用范围最小化。
- 首次配对后，入站访问仅允许总裁的 open_id 和私聊 chat_id。
- 群聊默认不作为任务入口；通知到既有群属于出站动作。
- 权限增加、保存、发布、管理员批准和真实生效是四个独立门禁。

### 6.2 lark-codex-bridge

以上游 @vicluo/lark-codex-bridge 0.1.34 为传输层基线，固定 Git tag v0.1.34 和提交 e8b0dc0cdfe2fb378bef7081618138a20d934aa9。生产交付不直接依赖全局 latest npm 包；在本项目仓库中 vendor 一个保留 MIT 声明的最小分支，并记录与上游的补丁差异。

采用原因：

- 已实现飞书/Lark 长连接、附件下载和会话映射。
- 直接调用本机已登录的 Codex CLI，不需要额外 OpenAI API Key。
- 已支持 macOS 用户级 launchd 和 KeepAlive。
- 已支持用户、聊天和管理员白名单。
- 已支持并发限制、运行超时、工具展示隐藏和工作区根目录限制。

硬化要求：

- 上游自称 alpha，因此不跟随 latest 自动更新。
- vendor 副本必须保留上游 LICENSE、来源 commit 和补丁清单。
- 安装时校验来源 commit、构建产物、依赖锁和命令入口。
- allowedUsers 只能包含总裁 open_id。
- allowedChats 只能包含配对后的总裁私聊 chat_id；代码级拒绝所有群聊入站任务。
- 修改上游空列表语义为 fail closed：allowedUsers 或 allowedChats 未完成配对时不执行任何 Codex 任务。
- 第一版不开放飞书远程管理命令；admins 为空表示没有远程管理员，而不是所有获准用户都是管理员。
- vendor 分支默认禁用云文档评论、群消息、创建群、机器人入群、表情和所有斜杠管理命令；只保留私聊消息和经过签名校验的确认卡片回调。
- 所有事件必须先完成 app、tenant、event type、chat type、sender 和 chat 白名单检查，之后才能记录日志、下载附件或启动 Codex。
- FEISHU_CODEX_WORKSPACE_ROOT 只能指向本项目允许访问的目录。
- bridge 配置值 acceptEdits 只表示映射到固定 `assistant-task` permission profile；该 profile 继承 `:workspace`，并只额外放行当前任务的精确 run socket。它不是另一个 Codex 权限模式，生产配置禁止映射到 `:danger-full-access` 或调用方自选 profile。
- showToolCalls 关闭，不把终端细节暴露给总裁。
- maxConcurrentRuns 第一版设为 1，额外任务按到达顺序排队。
- 群聊继续要求 @，但第一版不把群作为入站任务入口。
- 默认二维码向导会把 Secret 写入内置 secrets.enc，因此生产安装不得先运行该默认向导；必须先写入 Keychain 并生成 SecretRef 配置。
- 上游内存队列、active run 和 pending queue 不构成任务持久化，必须由本项目的 SQLite 任务账本替换或包裹。
- 成品附件回传、缓存定期清理和日志轮转由本项目补齐。
- 上游任何默认到 HOME 的工作目录回退均删除；工作区使用 realpath 校验，拒绝符号链接逃逸和不存在路径。

上游内置 secrets.enc 只是本地加密文件，不等同于 macOS Keychain。本项目不得把它作为最终密钥方案；bridge 使用 SecretRef exec provider 接入本项目的 macOS Keychain 读取器。

### 6.3 持久任务账本与动作网关

SQLite 账本至少记录：

- app_id、tenant_key、event_id 和 message_id；前三者组成入站事件唯一约束。
- 总裁 open_id、chat_id、Codex session_id 和任务状态。
- 输入文件清单、输出路径和最近完成阶段。
- 待确认动作的预览哈希、失效时间和确认人。
- 外部调用的幂等键、请求摘要和脱敏结果。
- 运行中断、恢复决定和最终状态。

持久化规则：

- 先在一个事务中持久化事件并创建任务，再向总裁发送业务接单确认。
- SQLite 使用 WAL、foreign_keys、busy_timeout 和 synchronous=FULL。
- 进程使用文件锁和数据库租约保证同一应用只有一个消费者。
- 每次启动先执行 schema migration 和 integrity_check；校验失败时停止接单并报告，不自动覆盖数据库。
- 任务状态为 RECEIVED → CLAIMED → RUNNING → SUCCEEDED / FAILED / CANCELLED / INTERRUPTED_REQUIRES_CONFIRMATION。
- claim 带租约和进程实例 ID；租约过期只进入 INTERRUPTED，不自动重新执行。

进程重启时：

- 所有未到终态的 RECEIVED、CLAIMED 或 RUNNING 任务转为 INTERRUPTED_REQUIRES_CONFIRMATION，避免已 claim 的任务永久卡住或被静默重放。
- 已完成外部调用保留结果，不重新执行。
- PREPARED、APPROVED 和尚未 dispatch 的 CLAIMED 写动作全部失效；DISPATCHING 动作转为 UNKNOWN 并只做对账；SUCCEEDED、FAILED 与已有 RECONCILED 结果保留。
- 总裁确认恢复后创建引用原任务的新 replacement task，不直接复活旧任务或旧审批；所有仍需执行的写操作重新预览和确认。
- 纯读取任务也由总裁确认后再恢复，避免把过期意图当成当前任务。

动作网关是所有飞书写操作的唯一入口：

- Codex 运行环境不直接暴露原始 lark-cli、飞书凭据或对外网络能力。
- 读取和写入都通过本机受控网关调用；网关只开放能力清单中的结构化动作。
- 写命令先生成标准化 dry-run 预览并写入账本。
- 只有飞书确认事件与预览哈希、总裁 open_id 和未过期状态全部匹配时，网关才签发一次性执行许可。
- 执行许可只能消费一次；结果无论成功、失败还是未知都写回账本。
- 未知结果先查询资源状态，不直接重放请求。

外部动作状态固定为：

> PREPARED → APPROVED → CLAIMED → DISPATCHING → SUCCEEDED / FAILED / UNKNOWN → RECONCILED

- 网关保存规范化、不可变的完整 payload，而不是只保存摘要。
- 审批卡展示完整正文或附件、精确接收人 ID、执行身份、时区、重复规则和通知方式。
- 每个动作包含随机 action_id 和 nonce；第一版只接受固定确认卡片按钮，不把普通“确认/执行”文字当作授权，卡片只能引用同一会话中最近且唯一的未过期动作。
- 网关在一个事务中核对 payload 哈希、版本、总裁 open_id、chat_id、nonce、过期时间和状态，再把 APPROVED 原子变为 CLAIMED。
- Codex 不获得可自行替换 payload 的执行许可；网关只执行账本中已冻结的 payload。

各写能力的幂等与对账：

- 消息发送使用 action_id 派生的稳定 UUID。公开能力没有证明可按 UUID 查询消息时，若响应丢失且没有 message_id，动作保持 UNKNOWN，或在人工核对后进入 `RECONCILED(reconcile_outcome=INDETERMINATE)`；禁止自动重发。只有证明同 UUID 的再次 POST 在有效幂等窗口内不会产生第二条消息且能返回稳定回执后，才可把该方式作为对账步骤。
- 日历创建在描述中写入不可变 action_id 标记；UNKNOWN 时先按时间窗和标记查询，不自动再次创建。
- 日历更新、取消和参与人变更记录 event_id 与操作前状态；UNKNOWN 时读取远端当前状态后再进入 RECONCILED。
- 文件回传记录内容 SHA-256、目标 chat_id 和消息 UUID；UNKNOWN 时先查消息结果。
- 无法定义可靠远端对账规则的写能力第一版不开放。

### 6.4 Codex 运行时

- 使用 Mac mini 上已登录的 Codex CLI。
- 根 AGENTS.md 持久化总裁助手的边界、确认规则、验证命令和错误处理。
- executive-assistant Skill 负责自然语言任务分类和飞书动作协议。
- bridge 启动 Codex 时显式使用全局参数 `codex --ask-for-approval never --enable network_proxy`，以内联、不可由请求覆盖的 `assistant-task` permission profile 继承 `:workspace`，再进入 `exec --strict-config --json --skip-git-repo-check`；不同时传入旧 `--sandbox` 设置，不依赖无人值守终端里的授权提示，配置出现未知键时直接失败。对外副作用仍由独立动作网关审批。
- profile 的 `network.enabled=true` 只用于启用 Codex 的受控网络代理层：domain allowlist 为空，local binding、SOCKS、upstream proxy、非 loopback 暴露和全 Unix socket 旁路全部关闭，`unix_sockets` 只允许 canonical `<task workspace>/gateway.sock`。因此工具子进程没有一般对外网络、控制 socket、本地 HTTP 或其他 task socket 访问权。
- Codex 子进程使用清洗后的最小环境：不继承 App Secret、OAuth Token、代理秘密、lark-cli 路径或无关用户环境变量。
- 机器人使用 `~/PresidentAssistant/runtime/codex-home` 作为专用 `CODEX_HOME`，不复用或复制客户日常 Codex 的 config/auth/skills；安装时在该 home 完成一次 Codex 登录，只安装经 lock 校验的 executive-assistant、visual-first-ppt 和必需官方能力。启动前 verifier 还必须证明所有会被加载的配置不含会覆盖 permission profile 的旧 `sandbox_mode` / `sandbox_workspace_write` 设置；缺失或不兼容证据一律在 spawn 前拒绝。Task 5 的 runner 只消费这个 evidence contract；生产 producer 与有效配置矩阵由 Stage B Task 9 接线、Stage D 在目标机复验，二者完成前不得把 mock `true` 或 clean-home fixture 当成生产证明。
- bridge 维护只供可信本机控制面的 control socket；每个 task 另在其 `0700` 任务目录创建独立 run socket。run socket 的服务端上下文已经绑定 task、总裁和原 chat，Codex 请求不能自带 task_id、identity 或目标系统回复 chat。任务结束立即关闭并移除 run socket。
- Codex 只通过当前任务的 run socket 连接本机动作网关；原始 lark-cli 不进入 Codex PATH，飞书凭据也不进入 Codex 环境。
- 同一 macOS 用户本身不被视为秘密隔离边界；Keychain ACL、清洗环境、沙箱网络限制和网关协议必须同时成立。
- 工作区根目录、任务目录和所有输入路径均按 realpath 校验；拒绝符号链接越界。
- 不以聊天回顾代替文件、API 响应或真实客户端证据。
- 不允许通过当前 Codex 任务再启动嵌套 Codex 来绕过配置和授权边界。

### 6.5 lark-cli

采用飞书官方 @larksuite/cli，第一版固定 1.0.72。它运行在动作网关侧，负责飞书 API 预处理和执行，不负责普通聊天长连接，也不直接暴露给 Codex 子进程。

- 机器人身份：接收和回复消息、默认通知他人。
- 用户身份：读取总裁会议纪要、个人日历和按明确要求代表本人发送。
- Bot 与 User 使用两个固定网关动作族，调用方不能自由传入 --as 改变身份。
- Task 6 的本地 runner 只接受版本化结构化 capability request；受信静态 registry 的内部 builder 独占 argv，固定追加 `--profile executive-assistant`、`--as bot|user` 和 JSON format。调用方不能提交 identity、profile、format、method、endpoint、URL 或自由 argv。release evidence 的生产 producer、能力路由接线和真实 CLI/OAuth 调用仍由 Task 9 与 Stage D 验证。
- 用户 OAuth 只申请能力矩阵列出的精确 scope，不使用宽泛推荐权限。
- OAuth access token、refresh token 的刷新、撤销和过期状态由固定 profile 管理；静默续期失败时转为 BLOCKED_USER_AUTH，不降级到 Bot 身份读取个人资源。其落盘方式固定遵守本规格 11.1 已确认的 `KEYCHAIN_BACKED_ENCRYPTED_STORE` 约束。
- 所有写命令经过动作网关先 dry-run；只有得到与当前预览绑定的一次性许可后才使用 yes 执行。
- 解析结构化 JSON 和退出码，不用自然语言日志猜测成功。
- 缺权限时明确区分应用 scope、版本发布、应用可用范围、用户 OAuth 和具体资源权限。

### 6.6 executive-assistant Skill

职责：

- 将自然语言映射为读取、生成、飞书写操作或 PPT 工作流。
- 自动下载并登记附件。
- 给长任务提供阶段性进度。
- 为外部副作用生成中文预览和确认请求。
- 调用 lark-cli 后整理结果并保留脱敏证据。
- 将 PPT 请求显式路由到 visual-first-ppt。
- 对能力未安装、授权过期或资源无权访问时给出可恢复状态。

该 Skill 不包含飞书 SDK、Codex Runtime 或 PPT 生成逻辑，避免重复造轮子。

### 6.7 visual-first-ppt

采用 banqiusheng/visual-first-ppt v0.3.0。该版本是 annotated tag：固定 tag object `4962eb9bd5c55e8384b5228993c241b2220fcabb`，并固定其 peeled commit `bb775f68f951c3e444d00623bc88976b20c13e7d`；安装校验必须同时核对两者。

安装与使用分开：

1. 安装固定版本，不覆盖已有同名 Skill。
2. 对已安装目标运行 doctor。
3. 在新的 Codex 任务中显式调用 visual-first-ppt 完成激活验证。
4. 只有 doctor 和激活证据齐全才记录 SETUP_VERIFIED。
5. 目标运行环境必须真实暴露 Presentations 和 imagegen。

自然语言路由：

- “做一份 PPT”且未给现有 PPTX：create。
- “按这个模板做”并附模板：template。
- “修改这份 PPT”并附源文件：edit。
- 无法判断时只问一次：从零制作、使用模板，还是修改现有文件。

总裁可见流程：

> 确认需求 → 确认提纲 → 确认两页样稿 → 完整制作 → 成品确认 → 下载

最终默认回传预览、PPTX 和 PDF。完整 ZIP 和生产记录保存在本次 PPT 项目目录。

### 6.8 launchd

- 使用用户级 LaunchAgent，不使用 root 身份运行 Codex。
- KeepAlive 保证进程异常退出后重新拉起。
- 使用本项目生成的受控 plist，不直接采用上游捕获当前 shell 环境的默认 plist。
- plist 使用绝对 ProgramArguments，并明确固定 WorkingDirectory、FEISHU_CODEX_WORKSPACE_ROOT、CODEX_HOME、最小 PATH、umask 和日志位置。
- plist 设置 ThrottleInterval，配合单实例锁避免 crash-loop 和重复消费者。
- 独立 watchdog 只检查本地就绪与心跳，不读取客户正文；失活时先优雅停止，再交给 launchd 重启。
- 安装、状态、重启和卸载均由仓库脚本提供。
- 服务日志写入本项目运行目录并使用可验证的重开文件轮转方式，避免只重命名仍被进程持续写入旧文件。
- 整机重启后必须等待 FileVault 用户登录。

## 7. 自然语言交互

### 7.1 普通任务

1. 总裁发送文字或附件。
2. bridge 验证发送人和会话。
3. 事件和任务成功写入 SQLite 后，机器人回复“收到，我开始处理”或同等简短内容。
4. 任务进入单并发队列；落库失败时不发送虚假的接单确认。
5. 超过 60 秒仍未完成时，机器人只汇报有意义的阶段变化。
6. 完成后返回结论、必要附件和下一步；隐藏工具调用细节。

### 7.2 外部动作确认

机器人对“当前总裁私聊”的接单确认、进度、错误、最终文字回复，以及把本任务生成的文件回传到同一私聊，属于本次任务的系统通道响应，不需要再做一次外部动作确认。

该例外由网关硬编码为 system_reply：run socket 已绑定当前 task_id；精确取消短语的控制回复则绑定 control_event_id。目标 chat_id 只能由任务或控制账本反查为配对后的总裁私聊，身份必须为 Bot；文件仅允许任务回复且必须属于当前任务并与 hash 匹配，控制回复只允许文字。system_reply 也进入动作账本并自动标记为受系统策略批准，使用稳定 UUID 和 UNKNOWN 对账；调用方不能提交 task_id、control_event_id、目标 chat 或 identity。

以下动作必须先确认：

- 给他人或群发送消息。
- 创建、修改或取消日程。
- 邀请或移除日程参与人。
- 以总裁本人身份发送。
- 上传、覆盖或共享飞书资源。

确认要求：

- 预览必须包含动作、身份、接收人、内容摘要和影响。
- 确认与预览内容哈希、当前飞书会话和总裁 open_id 绑定。
- 第一版普通“可以”“确认”“继续”文字不构成授权；只有同一会话中唯一待确认动作对应的有效卡片按钮 callback 才生效。
- 确认 30 分钟后失效，需重新生成预览。
- 内容、接收人、时间或身份变化后，旧确认立即失效。
- 对外调用使用幂等键；未知结果不得盲目重试。

以下动作第一版默认阻断：

- 批量广播。
- 新建大群或批量拉人。
- 修改应用权限、人员可见范围或共享权限。
- 删除本地客户资料。
- 关闭 FileVault、修改 Apple ID 或管理整台电脑。

### 7.3 中止和纠错

- “停一下”“取消这个任务”立即停止当前 Codex run。
- 该能力由 bridge 对配对后的总裁私聊做确定性控制短语识别并写入 control ledger，不排队等待另一个 Codex run，也不依赖模型理解；不明确的自然语言仍按普通消息处理。
- 已发生的外部动作不能伪装回滚；机器人准确列出已完成与未完成步骤。
- 总裁修改要求后创建新预览，旧审批作废。

## 8. 飞书身份与能力矩阵

| 业务能力 | 默认身份 | 关键权限 | 真实验收 |
| --- | --- | --- | --- |
| 接收和回复总裁私聊 | Bot | im:message、im:message:send_as_bot、im:resource | 总裁发送文字与附件并收到回复 |
| 通知单个内部用户 | Bot | im:message:send_as_bot | 指定测试用户客户端确认收到 |
| 通知既有群 | Bot | im:message:send_as_bot | 机器人已在群内，群成员确认收到 |
| 以总裁身份发送 | User | im:message、im:message.send_as_user | 明确要求、预览确认、接收人确认 |
| 检索和读取妙记 | User | minutes:minutes.basic:read、minutes:minutes.search:read、minutes:minutes.artifacts:read、minutes:minutes.transcript:export | 真实妙记返回标题、逐字稿和产物 |
| 读取 VC Note | User | vc:note:read、docx:document:readonly | 有 note_id 时读取；没有时准确报告 |
| 创建和邀请日程 | User | calendar:calendar:read、calendar:calendar.event:create、calendar:calendar.event:update、calendar:calendar.event:read | 测试参与人的日历出现并收到通知 |
| 更新和取消日程 | User | calendar:calendar.event:update、calendar:calendar.event:delete、calendar:calendar.event:read | 双方客户端确认更新和取消 |
| 映射测试接收人 ID | Bot 或 User | contact:user.id:readonly 或相应搜索权限 | 只使用本应用下的 open_id |
| 回传 PPT 和文件 | Bot | im:resource、消息发送权限 | 飞书收到文件且 PowerPoint/WPS 可打开 |

权限名称以目标租户开发者后台实际可申请项为准；安装程序应输出建议最小权限清单，但生产放行只依据目标租户真实测试。

### 8.1 联系人解析

- 总裁可用姓名、邮箱或手机号描述接收人，不需要手工提供 open_id。
- 精确邮箱或手机号优先使用 contact:user.id:readonly 解析本应用下的 open_id。
- 按姓名搜索使用用户身份和 contact:user:search，并遵守通讯录数据范围。
- 出现重名或多个候选人时，机器人显示姓名、部门等最小必要信息，让总裁选择；不得自动猜人。
- 选定结果只对当前应用有效。更换飞书应用后，旧 open_id 和联系人缓存全部失效并重新解析。
- 只有总裁明确说“记住这个人”时，才在本机保存别名到 open_id 的映射。
- 找不到、超出应用可用范围或通讯录无权读取时，分别报告 BLOCKED_VISIBILITY 或 BLOCKED_SCOPE。

## 9. 会议纪要边界

第一版可承诺：

- 按时间、关键词、所有者或参与者检索妙记。
- 获取妙记基础信息。
- 获取已有 summary、todos、chapters、keywords。
- 导出 TXT/SRT 逐字稿，并基于逐字稿二次总结。
- 有 note_id 时读取关联 VC Note 和文档。

第一版不可承诺：

- 每场会议必然存在妙记或 note_id。
- 没有逐字稿时生成看似真实的会议结论。
- 自动获得任何未分享给总裁或应用的妙记。
- 程序化创建飞书原生 VC Note。

资源无权访问、未完成转写和不允许导出必须分别报告，不得用增加 scope 代替资源所有者授权。

## 10. 日历边界

- 使用用户身份在总裁个人主日历创建日程。
- 创建、修改和取消均先显示参与人、时间、标题和通知方式。
- 添加参与人时启用飞书 Bot 通知，但 API 成功不等于手机 Push 或邮件必达。
- 真实验收必须由测试参与人在客户端确认日程和通知。
- Bot 身份的主日历属于应用自身，不能被误认为总裁个人日历。
- 重复日程的单次实例、此次及以后和全部实例必须分开处理。

## 11. 本地数据与密钥

本项目只管理自身运行所需目录，不管理客户整台电脑。

本项目运行根目录：

~~~text
~/PresidentAssistant/
  inbox/
  jobs/
  outputs/
  ppt-projects/
  runtime/
  logs/
~~~

- inbox：飞书下载的原始附件。
- jobs：每个任务的状态、输入清单和阶段证据。
- outputs：正式结果。
- ppt-projects：visual-first-ppt 的 manifest、预览和交付包。
- runtime：bridge 配置、会话映射和非秘密状态。
- logs：脱敏运行日志。

安全规则：

- App Secret 存在 macOS Keychain，service 固定为 com.codex-feishu-executive-assistant.bot，account 为 App ID。
- lark-cli 使用独立 executive-assistant profile；用户 access token 和 refresh token 固定按下述 `KEYCHAIN_BACKED_ENCRYPTED_STORE` 存储。实现证据不符合该档位时，状态为 BLOCKED_SECRET_STORAGE，禁止自动降级到其他存储方式。
- Keychain ACL 只信任固定绝对路径、代码签名和哈希均已验证的 gateway helper。helper 不经过 shell，不接受可变命令，只返回指定 service/account；限制环境、超时和最大输出。
- LaunchAgent 登录环境必须实测 Keychain 静默读取和 OAuth Token 刷新；失败时停止接单并要求重新授权。
- 卸载默认保留 Keychain 项；只有本人单独确认后，注销流程才撤销用户 OAuth 并删除对应项。
- GitHub、日志、任务摘要和错误消息不得出现 Secret 或 Token。
- bridge 配置只保存 SecretRef，不保存明文秘密。
- 运行日志使用字段白名单，禁止记录聊天正文预览、附件正文、API 请求体、Token、Secret 或完整人员 ID；默认保留 14 天。
- 本项目不配置 Time Machine，也不承诺客户文件备份。

### 11.1 已确认的 SECRET_STORAGE_PROFILE

对锁定的 `@larksuite/cli 1.0.72` 源码核验表明：macOS 上完整凭据 JSON 写入 `~/Library/Application Support/lark-cli/*.enc`，AES 主密钥优先放在系统 Keychain；若存在 `master.key.file`，读取路径会优先使用文件主密钥。它不是“完整 OAuth Token 直接作为 Keychain item”的实现。其锁定依赖 `go-keyring v0.2.8` 通过 `/usr/bin/security` 读写 master key，并未显式配置本项目专属的 trusted-app ACL，因此不能只凭“在 Keychain”就推断 Codex 子进程一定无法读取。

用户已于 2026-07-21 确认采用：

- `KEYCHAIN_BACKED_ENCRYPTED_STORE`（已选择）：接受官方实现，即凭据保存在 `0600` 加密文件、主密钥只在 Keychain；安装器和 doctor 必须确认 `master.key.file` 不存在，禁止执行 keychain-downgrade，并用同 ACL 模型的专用 canary 证明生产 Codex sandbox 无法通过 `/usr/bin/security`、Security.framework 或 raw lark-cli 读取/使用 Keychain 材料。任何 file fallback 或 canary 越界都立即 BLOCKED_SECRET_STORAGE。该方案复用官方 CLI，安装与升级成本最低，但其放行依赖每个 Codex 版本和 binary hash 的真实隔离测试。
- `STRICT_KEYCHAIN_TOKEN_FORK`（未选择，仅保留为未来重开设计时的备选）：维护一个最小 lark-cli 安全分支，取消 file-first/fallback，并把凭据存储改为受固定签名 helper 约束的 Keychain 方案；需要额外的 vendor、差异审计、构建、签名和回归测试。

该决定不会放宽“Secret/Token 不进入 Codex 环境、日志和 GitHub”的边界。实施不得自行切换到严格 fork、文件主密钥或其他 fallback；任何 profile 变更都必须重新打开设计评审并取得用户明确确认。

Task 6 的离线审计器只能对显式 synthetic fixture 检查 canonical `0700` 目录、当前 uid、`.enc` 文件 `0600`、完整文件 identity 稳定性及 `master.key.file` 缺失；即使这些本地检查全部通过，状态仍固定为 `UNVERIFIED_NO_FIXTURE / REAL_CANARY_REQUIRED`。真实 LaunchAgent 静默续期、Keychain ACL canary、生产 Codex sandbox 三路越界测试及目标机 OAuth health 均不得由 synthetic fixture 代替。

附件规则：

- 每个任务使用独立 0700 目录，文件权限为 0600，进程 umask 为 077。
- 最多 10 个附件，单个不超过 100 MB，单任务合计不超过 300 MB；超过限制时让总裁拆分。
- 下载到临时文件后校验声明类型、实际 MIME、扩展名和 SHA-256，再原子移入任务目录。
- 压缩包不自动解压；含宏的 Office 文件不执行宏；任何附件内容都只作为不可信数据，不作为系统指令。
- 工作区可用磁盘低于 10 GB 时停止下载新附件并报告 BLOCKED_HOST_READINESS。
- 使用完的附件缓存按 7 天策略清理；正式输出和 PPT 项目不自动删除。

## 12. GitHub 交付仓库

仓库名：codex-feishu-executive-assistant。

~~~text
codex-feishu-executive-assistant/
  AGENTS.md
  README.md
  BOOTSTRAP.md
  CHANGELOG.md
  LICENSES/
    lark-codex-bridge-MIT.txt
  dependencies.lock.json
  packages/
    bridge/
    job-store/
    action-gateway/
  config/
    capabilities.yaml
    feishu-scopes.yaml
    policy.yaml
  skills/
    executive-assistant/
  scripts/
    preflight
    install
    configure
    doctor
    smoke-test
    uninstall
  launchd/
  tests/
  docs/
    permissions/
    runbook/
    superpowers/specs/
~~~

职责：

- README：面向交付人员的一页式说明。
- AGENTS.md：Codex 从仓库地址启动时的读取顺序、边界和验证要求。
- BOOTSTRAP.md：首次安装的状态机和人工步骤。
- dependencies.lock.json：锁定 bridge 上游提交、lark-cli、visual-first-ppt 版本和完整性。
- packages/bridge：基于 v0.1.34 的最小 vendor 分支及补丁记录。
- packages/job-store：SQLite 消息去重、任务、确认和外部执行账本。
- packages/action-gateway：Keychain SecretRef、受控 lark-cli、审批和幂等边界。
- capabilities.yaml：能力及其 SETUP、AUTH、E2E 状态。
- policy.yaml：配对用户、系统回复、确认策略和工作区边界。
- doctor：只读诊断，不修改系统。
- smoke-test：在明确测试对象和确认后执行真实飞书测试。
- uninstall：停止并移除本项目服务；默认保留客户输出和钥匙串秘密，分别询问后再处理。

## 13. 一站式安装流程

### 13.1 安装前置条件

交付人员在飞书开放平台提前完成：

- 创建企业自建应用并启用机器人能力。
- 按 capabilities.yaml 申请第一版最小权限。
- 启用长连接并订阅 im.message.receive_v1 和 card.action.trigger。
- 把总裁和测试用户加入应用可用范围及必要通讯录数据范围。
- 创建应用版本、发布并取得管理员批准。

“权限已保存”“版本待发布”和“权限已生效”是不同状态。Codex 在安装时只读验证这些前置条件；缺失时输出 BLOCKED_APP_PUBLISH、BLOCKED_SCOPE 或 BLOCKED_VISIBILITY，由交付人员在开放平台完成后再继续。Codex 不冒充租户管理员批准权限。

### 13.2 Codex 安装

交付人员把唯一 GitHub 地址和下列信息提供给 Mac mini 上的 Codex：

- 飞书 App ID。
- 飞书 App Secret，由本人在安全输入框中输入。
- 一个已同意测试的内部用户姓名、邮箱或手机号，用于在本应用下解析 open_id。
- 一个已同意测试的既有测试群，可不配置。
- 一条总裁有权访问的真实会议妙记。

飞书自建应用的 Tenant Key 不作为人工安装输入。首次启动只接受未过期的一次性
配对码；总裁在机器人私聊发送正确配对码后，运行时从该可信事件读取并持久化
Tenant Key。错误配对码、群聊和卡片事件不得建立企业绑定；绑定后不同 Tenant
的事件继续在入站落库前拒绝。

Codex 按顺序执行：

1. 读取 AGENTS.md 和 BOOTSTRAP.md。
2. 只读 preflight：macOS、Node、Python、Codex CLI 登录、网络和已有安装。
3. 构建并安装仓库内固定来源的 bridge，以及固定版本 lark-cli 和 visual-first-ppt。
4. 创建受限工作区和配置模板。
5. 通过 macOS Keychain 保存 App Secret。
6. 生成 SecretRef 飞书配置；不运行会把 Secret 写入 secrets.enc 的默认向导。
7. 进入一次性配对模式：只接受随机配对码，不允许触发 Codex。
8. 总裁私聊机器人发送配对码；系统记录其 open_id 和私聊 chat_id，关闭配对模式并启用严格白名单。
9. 初始化 SQLite 任务账本和动作网关。
10. 显示二维码，让总裁完成一次用户 OAuth。
11. 配置用户级 launchd 并启动服务。
12. 执行 doctor。
13. 经确认执行目标租户 smoke-test。
14. 生成中文验收报告。

在上述飞书前置条件已完成后，Mac mini 安装阶段的人工动作只包含：

- 必要时在 macOS 弹窗输入管理员密码。
- 扫码完成飞书用户 OAuth。
- 在系统设置中批准必要的隐私权限。

任何步骤失败都停在准确状态，不把“下载成功”“权限已保存”或“API dry-run 成功”写成“生产可用”。

## 14. 状态与错误模型

统一状态：

- PASS：真实验收通过。
- BLOCKED_HOST_READINESS：主机未保持唤醒、未登录、磁盘不足或其他 24H 主机前提不满足。
- BLOCKED_APP_PUBLISH：飞书权限或事件配置已保存但尚未发布、批准或生效。
- BLOCKED_SCOPE：已发布版本仍缺少执行该能力所需的精确 scope。
- BLOCKED_USER_AUTH：总裁 OAuth 未完成或已过期。
- BLOCKED_SECRET_STORAGE：App Secret 未能按 Keychain 边界存储，或用户 OAuth Token 未能按已选 `SECRET_STORAGE_PROFILE` 安全存储、静默解密和刷新。
- BLOCKED_VISIBILITY：目标用户不在应用可用范围或数据范围内。
- BLOCKED_RESOURCE_PERMISSION：具体妙记、日历、群或文件无权访问。
- BLOCKED_CAPABILITY：Codex Runtime 缺少所需能力，例如 Presentations 或 imagegen。
- UNVERIFIED_NO_FIXTURE：没有真实测试对象，尚不能验收。
- INTERRUPTED_REQUIRES_CONFIRMATION：运行中断，等待总裁确认是否继续。
- BLOCKED_RUNTIME_STATE：SQLite integrity、迁移、单实例锁或任务状态不可信。
- BLOCKED_REPO_BOUNDARY：实施目录尚未成为独立仓库或独立 clone，不能在父项目的无关分支中开工。
- FAILED_DEPENDENCY：飞书、Codex、网络或上游工具不可用。

错误回复只回答三件事：

1. 哪一步没有完成。
2. 是否已经产生外部影响。
3. 总裁或本地交付人员接下来只需做什么。

## 15. 验收计划

### 15.1 安装与访问控制

- 从全新用户环境按 GitHub 地址完成安装。
- preflight 证明主机保持唤醒；不满足时准确阻断。
- 仓库和日志中无 Secret、Token 和完整敏感正文。
- LaunchAgent 环境能按已确认的 `KEYCHAIN_BACKED_ENCRYPTED_STORE` 静默解密凭据并完成 OAuth Token 刷新；`master.key.file` 一旦存在必须立即进入 `BLOCKED_SECRET_STORAGE`。
- 非总裁用户私聊机器人不能触发 Codex。
- 群聊消息不能触发 Codex，即使发送人是总裁。
- 云文档评论、机器人入群、表情和斜杠命令不能触发 Codex。
- 总裁不能使用本机维护命令；维护只从 Mac mini 本地执行。
- Codex 无法写出允许工作区。
- realpath 和符号链接越界测试均被拒绝。
- 相同飞书 event_id 重放不会产生第二个任务。
- 未经账本确认许可，任何 lark-cli 写操作均被拒绝。
- SQLite 单实例锁、租约过期、UNKNOWN 对账和 integrity_check 失败均按状态机处理。
- 重启 bridge 进程后 launchd 自动拉起。
- 重启 Mac mini、人工登录后服务自动恢复。
- 人为制造 bridge 存活但心跳停止，watchdog 能停止并恢复服务。
- 断网后恢复，WebSocket 在目标时间内重连。
- 完成连续 24 小时 soak test。

### 15.2 飞书基本链路

- 总裁发送文字，收到确认和最终回复。
- 总裁发送图片和文件，Codex 能读取本地副本。
- 长任务能发送阶段进度。
- 中止指令能停止当前任务。
- 服务中断后账本把运行任务标记为需确认恢复，不重复已完成的外部动作。
- 系统回复和回传当前任务文件不要求二次确认；向第三方发送或修改飞书资源必须确认。
- 延迟卡片、过期 nonce、旧 payload 哈希和第二次消费均被拒绝。
- 超限附件、伪造 MIME、符号链接、压缩包和宏文件按附件规则处理，不执行其中内容。

### 15.3 会议纪要

- 使用一条已完成转写、允许导出且总裁有权访问的真实妙记。
- 获取基础信息、逐字稿和已有 AI 产物。
- 基于逐字稿生成二次总结。
- 有 note_id 与无 note_id 两种情况都按事实报告。

### 15.4 日历

- 创建 10 至 30 分钟的测试日程并邀请测试用户。
- 测试用户客户端确认日程和通知。
- 修改标题或时间，双方确认更新。
- 取消日程，双方确认取消。
- 保存脱敏 calendar_id、event_id、响应和截图证据。

### 15.5 通知他人

- 先 dry-run 和预览。
- 总裁确认后，以机器人身份通知测试用户。
- 测试用户客户端确认收到。
- 机器人向已加入的测试群发送消息，群成员确认收到。
- 不测试或启用批量广播。

### 15.6 PPT

- 对安装目标运行 visual-first-ppt doctor。
- 服务启动后，通过飞书测试消息创建全新 Codex session 并显式激活 Skill；不得由当前安装任务嵌套启动 Codex。
- 验证 Presentations 和 imagegen。
- 在与生产完全相同的 LaunchAgent、CODEX_HOME、sandbox、网络和工作区环境中，分别完成 create、template 和 edit 的最小样例。
- 在飞书收到预览、PPTX 和 PDF。
- 在目标 PowerPoint 或 WPS 中真实打开。
- 验证完整 ZIP 保存在持久项目目录。
- 任一能力在生产运行时缺失，都保持 BLOCKED_CAPABILITY；doctor 通过不能替代真实生成和回传证据。

## 16. 发布门禁

1. 设计规格审阅通过。
2. 实施计划审阅通过。
3. 本地实现和自动测试通过。
4. 干净环境安装验证通过。
5. 目标 Mac mini 首次安装完成。
6. 目标飞书租户真实 E2E 通过。
7. 总裁或交付负责人完成最终验收。
8. 另行授权后才允许创建 GitHub 提交、推送、PR 或发布版本。

这些门禁相互独立。任何一个通过都不能替代后续门禁。

## 17. 直接依赖与资料

- lark-codex-bridge v0.1.34：
  https://github.com/VicLuoV5/lark-codex-bridge/tree/v0.1.34
- lark-codex-bridge MIT License：
  https://github.com/VicLuoV5/lark-codex-bridge/blob/v0.1.34/LICENSE
- 飞书官方 lark-cli：
  https://github.com/larksuite/cli
- visual-first-ppt v0.3.0：
  https://github.com/banqiusheng/visual-first-ppt/tree/v0.3.0
- Codex Skills：
  https://learn.chatgpt.com/docs/build-skills
- Codex AGENTS.md：
  https://learn.chatgpt.com/docs/agent-configuration/agents-md
- 飞书发送消息 API：
  https://open.feishu.cn/document/server-docs/im-v1/message/create
- 飞书创建日程 API：
  https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/create
- 飞书妙记 API：
  https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/minutes-v1/minute/get

## 18. 最终判断

该方案技术上可行，且符合“一位总裁、一台家中 Mac mini、飞书手机入口、尽量不重复造轮子”的目标。

生产可用的关键不在于是否能调用 API，而在于五件事同时成立：

1. 本机 Codex 和加固后的桥接服务稳定。
2. 持久任务账本能在崩溃和重启后给出可信状态。
3. 机器人身份与总裁用户身份边界清楚。
4. 所有外部副作用都有代码级预览、确认和幂等保护。
5. 每项飞书能力都在目标租户用真实资源完成 E2E。

本规格与实施计划已经于 2026-07-21 完整确认并封版。Stage A / Tasks 1–7 已达到 `STAGE_A_SEAMS_VERIFIED`；Stage B / Tasks 1–6 已本地提交，Task 6 为 `STAGE_B_TASK6_LOCAL_COMMITTED`。Stage A 的静态门禁仍不提供跨函数、任意 helper/library 传播或任意深度 JavaScript 数据流证明；Stage B / Tasks 5–6 的本机构建、clean-home、synthetic/fake fixture 也不替代 Task 9 production verifier、真实 Keychain/OAuth canary、目标 Mac 实际配置栈、真实飞书/Codex E2E、部署或 24 小时可用性证据。动态实施事实以 README 和阶段 B 计划为准；remote 配置/创建、push、PR、deploy 和真实飞书写操作仍须逐项另行授权，且均未执行。
