# Changelog

本项目的变更记录遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。

## [Unreleased]

### Fixed

- 修复 GitHub Actions 中 Gitleaks 临时 SARIF 报告被 Prettier 当作项目文件检查，导致首次公开 `main` CI 误报失败。

## [0.1.0-rc.1] - 2026-07-23

### Security

- 新增根 MIT 许可证、`visual-first-ppt v0.3.0` 许可证哈希与第三方声明、安全报告入口、全历史密钥扫描和最小权限 macOS CI；公开 `main` 必须使用净化快照与 GitHub noreply 身份，禁止直接推送开发历史。

### Fixed

- 修复 macOS 全量 CI 中 control client 慢速响应测试在连接关闭后偶发 `EPIPE` 的资源清理竞态。

### Added

- 精简 MVP 已完成本地实现、独立 P0/P1 复核、全仓验收与本地提交，并整理为公开 `v0.1.0-rc.1` 候选版；真实飞书和目标 Mac mini 仍待验收。
- 新增面向一位总裁和一台 Mac mini 的精简 MVP runtime：内置飞书长连接、SQLite 接单账本、单并发 Codex 执行、会话续接、文字与显式文件回传、持久取消、ACK 失败隔离和中断后不静默重跑。
- 接通 5 项固定飞书能力：`minutes.search`、`minutes.detail`、`contact.search`、`message.send` 和 `calendar.create`。后两项通过不可变中文预览与总裁签名确认卡片执行一次，失败或 `UNKNOWN` 均不自动重发。
- 新增锁定 `lark-cli 1.0.72` 的私有执行器、官方 release/receipt/签名核验、Bot/User 固定身份路由，以及 App Secret 仅由 macOS Keychain 提供的生产配置。
- 新增 `executive-assistant` Skill，PPT 请求直接委托锁定版本的 `$visual-first-ppt`；安装面同时核验 Presentations 与 `imagegen` 的真实可用性，不伪造能力。
- 新增中文 `BOOTSTRAP.md`、安装/只读 doctor/重启入口和单一 `RunAtLoad + KeepAlive` 用户级 LaunchAgent；本轮只完成本地代码与离线验证，未配置真实凭据、未调用真实飞书、未注册 LaunchAgent。
- 完成 Stage B / Task 6 的本地提交：新增 bridge-compatible Bot SecretRef 配置和 native Keychain helper。helper manifest 以固定路径与 SHA-256 锚定当前 release 的既有 exact `release-manifest v1`，不自报 Node/bridge；父进程必须与 active bridge 的 PID version、euid、release、exact `[node, bridgeEntry]` argv 和运行代码身份一致。请求先有界读取，固定 service/account 的 Secret 读取前后都复验 current、双 manifest、active state、parent 与代码身份，任一漂移均为空 stdout/stderr 且不泄漏 Secret。
- 新增固定 Bot/User 的内部 `lark-cli` runner：外部只提交版本化结构化 capability request，受信静态 registry 独占 argv builder 并固定 `--profile executive-assistant`、`--as bot|user` 和 JSON format；identity/profile/format/method/endpoint/URL/free argv、`--` 及保留 flag 都不能由请求注入。JSON body 使用 `0700/0600` 临时文件和 FD/path identity 绑定，最终异步 release evidence 之后再同步复核 dev/inode/uid/mode/size/mtime/ctime/realpath，无事件循环让步进入 `shell:false` spawn；stdout/stderr 合计 8 MiB、fatal UTF-8、strict JSON、TERM→KILL→close 和写操作 `UNKNOWN` 语义均已锁定。
- 新增仅接受 synthetic fixture 的 OAuth 存储审计与 no-secret-leak 门禁：检查 canonical 当前 uid `0700` 目录、`.enc` 文件 `0600` 及完整 identity 稳定、双目录枚举和 `master.key.file` 缺失；本地检查通过仍固定返回 `UNVERIFIED_NO_FIXTURE / REAL_CANARY_REQUIRED`。App Secret/OAuth/master key/proxy sentinel 不进入 config、evidence、错误、argv、env 或日志；Keychain/runner 模块保持不从 action-gateway public/Codex surface 可达。通用 bridge 失败 stderr 与生产 provider/config lock-down 仍归 Task 9。
- Task 6 聚焦 5 个测试文件 120/120、action-gateway 14 个文件 340/340、全仓 44 个文件 1099/1099 通过；typecheck、lint、build、Swift 严格格式、zsh 语法、生产 codesign/marker、离线 vendor replay 与 `git diff --check` 均退出 0。两条独立最终复审均为 `READY_FOR_LOCAL_SEAM`；本地 helper SHA-256 为 `65afd3c24e7c0443ae9a0e6bfb8fa0d26a413d63cb490c29b5a59b32a12405c1`。当前状态为 `STAGE_B_TASK6_LOCAL_COMMITTED`；未访问真实 Keychain/凭据/网络，未运行真实 CLI/API、OAuth health、LaunchAgent、remote、push、PR 或部署。
- 完成 Stage B / Task 5 的本地提交：新增 `@executive-assistant/action-gateway`，以 4-byte big-endian、1 MiB 上限、fatal UTF-8、重复键/深度/节点约束和精确 own-data schema 建立 bridge-only control socket 与逐任务 run socket；未知 route、非法 frame、跨任务身份和未冻结输入均 fail closed。
- 新增三枚签名 native 组件及原子构建边界：公开 `assistant-gateway` 只从受信环境读取当前 task socket，私有 control client 核验父 bridge、active state、release manifest、路径、权限、签名与哈希，peer verifier 通过 fd 3 kernel identity 和代码身份链反向核验 control client。canonical 发布目录为 `0700`，run 产物精确 `0555`，control/peer 精确 `0500`；构建拒绝非 canonical、symlink、错误 owner/mode 和失败编译覆盖。
- 新增 `0006-task-scoped-unix-socket-permission.patch`：用固定 `assistant-task` permission profile 替换不兼容的旧 `workspace-write` 网络设置，仅放行 canonical 当前 task `gateway.sock`，关闭 local binding、SOCKS、upstream proxy、非 loopback 暴露和全 Unix socket 旁路；缺失或 false `permissionProfileCompatible` evidence 在 spawn 前拒绝。patch SHA `e3c9497b…7ed934`、patched tree `3be456b1…0247a`、strict manifest `23309c3e…8cf151` 已同步并通过 provenance/offline replay。
- Task 5 action-gateway 10 个测试文件 235/235、全仓 40 个测试文件 994/994 通过；format、lint、typecheck、build、Swift 严格格式、zsh 语法、签名、离线 vendor replay 与 `git diff --check` 均退出 0。两路最终 native 复核均为 `READY`、Critical 0 / Important 0，其中补充预检保留 2 个不阻塞 Minor（callback 主动改 mode 的专项覆盖增强、测试临时目录未统一回收）。三枚本地生产构建 SHA-256 为 run `79e0a1af…d6e13`、control `3d6e8253…e9703`、peer `705c034a…fbbb`，严格签名验证通过。本机 Codex 0.142 clean-home 无模型矩阵为 `{taskA_uds:true, taskB_uds:false, control_uds:false, local_http:false, external_tcp:false}`，private control client 在沙箱内外均固定 exit 2。Task 5 已按单独授权完成本地提交；未执行真实飞书/Codex E2E、客户 Mac 安装、凭据、LaunchAgent、remote、push、PR 或部署。生产 `permissionProfileCompatible` producer 与 live wiring 仍属 Task 9，目标机实际配置栈重验仍属 Stage D。
- 完成 Stage B / Task 4 的本地提交前实现：新增 RFC 8785 canonical I-JSON、不可变 action/payload/preview、固定 30 分钟审批、版本化确认 callback、一次性 claim、dispatch attempt、UNKNOWN 恢复对账，以及 `getAction` / `listUnknownActions` 只读恢复面。
- 动作读写在同一事务内校验 live bridge lease、父 task/session/lease、action lease、来源 actor/chat 和完整 append-only audit chain；PREPARED/APPROVED 新预览原子 supersede，CLAIMED/DISPATCHING/UNKNOWN 要求显式恢复。task 终止与取消先在原父 task 关系下验证/迁移动作，再写 task/control 事实；损坏的 UNKNOWN/DISPATCHING pending 账本也会在取消落账前 fail closed。
- 固定 Task 9 `system_reply` seam 为 `bot/system_policy` 与 `NULL -> APPROVED(reason=system_policy_approved)`；Task 4 只验证消费，不创建 ACK/control reply，也不调用真实 adapter。两路最终独立复审均为 Critical / Important / Minor 全部 0、结论 `READY`；提交前门禁为 job-store 208/208、全仓 30 个文件 752/752，format、lint、typecheck、build、离线 vendor replay 与 `git diff --check` 全部通过。本变更已按单独授权以 `c308c41` 完成 Task 4 本地实现提交；未配置 remote、未 push、未创建 PR、未部署或调用真实飞书/Codex/gateway API。
- 完成 Stage B / Task 3 的本地提交前实现：新增 checksum migration 002，持久化取消时的外部效果待对账事实，并以唯一索引锁住每个中断任务最多一个 replacement；`JobStore` 新增 runtime lease、单活动任务 claim、任务生命周期、启动/过期恢复、replacement 与取消控制接口，数据库句柄仍保持私有。
- runtime lease 采用 `BEGIN IMMEDIATE`、严格 `< now` 过期和 owner CAS；claim 同时要求当前实例持有 live `bridge` lease 且全库没有其他 `CLAIMED|RUNNING`。`markRunning`、`touchTask`、`finishTask` 也在各自同一写事务内先校验 live bridge lease，再校验 task owner/session/lease，阻止接管后的旧实例续租或写入终态。
- 启动恢复会全局失效 `PREPARED|APPROVED|CLAIMED` 动作、把 `DISPATCHING` 转为 `UNKNOWN` 并追加不可变 transition；取消控制先完成精确输入、principal 和重放漂移校验，再以最终 target/pending 事实写入不可变 control row，并与 task/action 变更原子提交。replacement 复用原 inbound event，但不会复活旧 action、approval 或 nonce；固定 `jobsRoot` containment 与未使用候选清理由 Task 9 负责。
- 三轮独立修复封闭了全局 startup action 遗漏、合法合同时间误拒绝、session 审计证据丢失、replacement replay 身份缺口、宽松 `Date.parse` 洗白损坏账本，以及 runtime takeover 后旧 worker 仍可写入的问题。最终独立复审为 Critical / Important / Minor 全部 0、结论 `READY`；主控最终门禁为 job-store 132/132、全仓 29 个文件 671/671，format、lint、typecheck、build、离线 vendor replay 与 `git diff --check` 全部通过。本变更已按单独授权完成 Task 3 本地提交；未配置 remote、未 push、未创建 PR、未部署或调用真实飞书/Codex/gateway API。
- 完成 Stage B / Task 2 的本地提交前实现：`JobStore.ingestEvent` 以单个 `BEGIN IMMEDIATE` 原子写入入站事件与唯一 ROOT task，按 `(app_id, tenant_key, event_id)` 持久去重，精确重放返回原账本 task ID，任务插入失败时整笔回滚。
- 入站账本只持久化 sender/chat 的 SHA-256；完整任务目录必须是当前 uid 持有、canonical、非 symlink、`0700` 且 basename 为 UUID。受信任 TaskSink adapter 与固定 `jobsRoot` 的绑定、重复 candidate 安全清理由 Task 9 接线负责，当前 store 不将叶目录验证表述为 root containment 证明。
- 加固 Task 2 的 JavaScript 输入边界：拒绝 Proxy、accessor、symbol、未知/缺失字段与非 plain prototype；逐字段使用 canonical contract schema，并以冻结 null-prototype own-data record 抵抗 `Object.prototype` getter/setter 污染。独立审查实际复现的 `appId` 持久化篡改已由先红后绿回归封闭，同时消除 `types` 与 `events` 的运行时循环依赖；修复后独立复核为 Critical / Important / Minor 全部 0、结论 `READY`。
- job-store 回归增至 80 项，全仓增至 619 项，覆盖原子回滚、重放字段漂移、两个 connection/不同 candidate 的单进程同步去重语义、原始标识符不落库、恶意输入、安全 workspace、冻结精确返回及原型污染；format、lint、typecheck、build 全部通过。跨进程并行不是本用例结论：生产第二进程由 Task 1 文件锁拒绝，runtime lease/接管仍由 Task 3 验证。本变更已按单独授权完成 Task 2 本地提交；未配置 remote、未 push、未创建 PR、未部署或调用真实 API。
- 完成 Stage B / Task 1 的本地提交前实现：新增 `@executive-assistant/job-store`、初始 SQLite 账本 schema、连续 checksum migration manifest、迁移前后完整性检查，以及固定 WAL / foreign keys / synchronous / busy timeout 耐久参数。
- 新增数据库文件独占锁与安全路径门禁：锁先于 runtime 校验，runtime/数据库必须满足 canonical、owner、`0700`/`0600`、非 symlink 和直接子文件约束；store 生命周期与锁 attachment 绑定，release/compromise/failure 均 fail closed。
- 加固 JavaScript 运行时能力边界：锁句柄使用私有 construction token、issued registry、私有状态和内部 capability，拒绝反射构造、静态 detach、属性遮蔽、伪原型与 Proxy；`openJobStore` 在副作用前只接受 exact plain own-data options 并一次性快照，SQLite store 的数据库与关闭回调也改为 ECMAScript 私有状态。
- 增加 70 项 job-store 实文件/真实 SQLite 回归，覆盖 migration 漂移与事务逃逸、锁/store 生命周期、路径权限、句柄反射与 Proxy、options accessor/快照漂移及固定公开 API。本变更集完成 Task 1 本地提交；未配置 remote、未 push，Task 3 runtime lease、真实飞书/Codex E2E、部署与 24 小时可用性仍未完成。
- 建立独立 Git 仓库的初始基线。
- 完成 Stage A / Task 1：pnpm monorepo 和 `@executive-assistant/contracts` 骨架。
- 锁定 pnpm 10.0.0、支持的 Node 偶数主版本及 TypeScript、Vitest、ESLint、Prettier、tsup、Zod 工具链版本。
- 增加仓库结构测试；最终验证通过 format、lint、test（3/3）、typecheck 和 build。
- 同步设计规格和阶段 A 计划的 Task 1 本地基线状态（`f93ab0a`）。
- 同步 Stage A 本地实现与本地提交的授权口径；远端和真实飞书写操作仍逐项另行授权。
- 完成 Stage A / Task 2：新增 fail-closed 私聊入站、任务状态、助理状态和网关请求的跨包合同。
- 增加合同测试，拒绝非私聊入口、调用方注入的任务/身份上下文和可静默重放的 `RETRYING` 任务状态。
- 强化 Task 2 安全边界回归测试：覆盖有效合同，以及群聊、未知字段、错误事件类型、非法时间戳、非完整/大写 SHA-256、错误协议版本和非法网关字段的 fail-closed 拒绝。
- 增加网关协议必填字段回归：分别拒绝缺失 `version`、`requestId`、`capability` 或 `payload` 的请求。
- 完成 Stage A / Task 3：固定并核验 `lark-codex-bridge` v0.1.34 的 tag object、commit、tree 和 MIT 许可证。
- 新增 fail-closed `scripts/vendor-bridge`，按文件名顺序应用审计补丁；首次导入、第二次幂等导入及目标冲突退出码 73 均已验证。
- 新增 `0001-workspace-adapter.patch`，仅负责私有 workspace 包名、确定性脚本、Vitest 发现、依赖精确版本和来源文档，不改运行时业务逻辑。
- 增加来源回归测试、bridge Vitest 版本 smoke、bridge typecheck，以及 vendored bridge 的 25 项上游测试；全仓测试为 48/48。
- 对已核验的上游格式基线采用逐文件 Prettier 排除，并为两个已知上游文件收窄 ESLint unused 兼容范围；新文件仍进入默认检查。
- 对两个保留上游 EOF 空行的文件设置精确 Git whitespace 属性，未全局放宽差异检查。
- 根据 Task 3 复审移除 vendored bridge 内整份上游 `pnpm-lock.yaml` 和 `pnpm-workspace.yaml`，确保根 workspace 与根冻结锁是唯一依赖权威；从 bridge 目录安装仍解析到根 workspace。
- 用离线严格清单替代 `diff -qr/-x`：通过 `lstat` 且不跟随 symlink，摘要覆盖路径、类型、权限/可执行位、稳定大小、内容 SHA-256 和 symlink target，仅排除顶层 `dist/` 与 `node_modules/` 目录。
- 扩展来源锁，记录补丁后 Git tree、严格清单、完整许可证、vendor/manifest 脚本及按词法排序补丁集合的 SHA-256；回归测试离线复算全部证据并限制补丁路径。
- 增加 strict manifest 负测，分别覆盖嵌套 `src/dist`、目录替换为 symlink、`0644`→`0755`、根 symlink、根 `.git`，并证明仅顶层生成目录可忽略。
- 完成 Stage A / Task 4：新增 fail-closed 入站 policy、无副作用 `decideIngress` 与可注入 guard boundary seam。
- policy 只接受“完整已配对”“带非空内容严格小写 SHA-256 的主动配对”或“未配对且 pairing 关闭的显式 deny-all”三种受控状态；配对码以 digest bytes 和 `timingSafeEqual` 精确比较，非法或长度错误的 stored hash 安全拒绝且不抛异常。
- 入站负测覆盖错误 app/tenant、群聊、未知/drive/reaction/menu 事件、未配对普通消息、用户或私聊不匹配、卡片签名/nonce/canonical payload hash 不完整，以及卡片不得用于配对。
- 增加 deny-before-effects seam 测试：拒绝事件不会触发正文 logger、附件下载、`TaskSink` 或 authorized continuation；拒绝审计仅包含固定 reason 与归一化 event type。
- 新增可机械重放的 `0002-fail-closed-ingress.patch`，并把来源回归收紧为每个补丁的实际 diff path 集合必须与独立 allowlist 完全相等；更新补丁后 tree 与 strict manifest 锁，并对 unified-diff 必需的空白上下文设置精确 Git whitespace 属性。
- Task 4 未修改现有 live channel；订阅裁剪、持久化、ACK 与生产接线明确留给 Stage A / Task 6。
- 完成 Task 4 独立复审修复：配对前必须同时具备非空无空白 sender/chat ID 与 1–256 字符无首尾空白的显式字符串；Buffer、数字、缺失/空白/过长文本及已知空字符串 SHA-256 均拒绝且不进入授权 continuation。
- 增加恶意超长多行 event type 的审计归一化回归，以及卡片 group/wrong app/wrong tenant 共用门禁回归；配对完成后的同样文本只作为普通任务处理。
- 完成 Stage A / Task 5：新增 canonical UUID、realpath、symlink 和严格 `0700` 权限约束的任务工作区解析器；函数只验证受信进程已创建的目录，不自行创建或回退到其他路径。
- 新增受限 Codex runner seam：Stage A 当时固定 `workspace-write`、`approval never`、工具网络关闭、`strict-config` 和 stdin-only prompt；新会话与显式 UUID resume 都拒绝自由 argv、`--last`、`--add-dir`、search 与 danger/bypass 参数。该 `workspace-write` 网络设置已在 Stage B / Task 5 被 `0006` 的固定 `assistant-task` permission profile 替换。
- 子进程环境从零构造，只含固定系统 `PATH`、`CODEX_HOME`、gateway socket/client 与 `LANG`；污染的 HOME、代理、飞书/Lark secret/token 和 raw lark-cli 路径不会继承。
- 强制消费 Codex 最低版本与 feature probes、`0700` Codex home、`0600` 非 symlink UDS，以及唯一 `public-bin/assistant-gateway` 的 manifest hash、signature 和 executable verifier evidence；任一证据错误或 verifier 异常均在 spawn 前脱敏拒绝。
- 封闭 Task 7 预检发现的异步 TOCTOU 与原型污染缺口：request、依赖函数和 verifier evidence 只接受普通 own-data 形状并一次性快照；Proxy、accessor、隐藏/符号/未知字段及扩展数组均拒绝。依赖在 runner 构造时固定并以空 receiver 调用，安全投影、五字段 env、spawn options 与 invocation 全部使用冻结 null-prototype record，调用方异步修改或 `Object.prototype` 污染不能改变 command、argv、cwd、env 或 stdin。
- JSONL 以原始字节检查单行/累计缓冲上限并使用 fatal UTF-8，只接受已知 0.142 lifecycle、item allowlist、四字段 completion usage 与受控顺序；顶层 reconnect `error` 仅在 turn 内作为脱敏非终态事件，未知事件、未知 item、非法顺序及缺失 success terminal 均 fail closed。空行、stderr 和不完整片段不保活，待消费事件队列仍有数量与字节上限。
- 加固 Codex 子进程完成语义：stdin 只有实际观察到 `finish`/`writableFinished` 才算完整；协议、Codex、IO 与 idle 失败先 TERM、10 秒无 `close` 再 KILL，但 signal 返回值和非空 exit fields 都不替代真实 `close`。无法确认关闭时通过独立 `TERMINATION_UNCONFIRMED` stream 要求人工介入，final result、事件关闭和 listener 释放继续等待真实 close；所有非成功结果禁止自动重跑。
- resume runner 将 `thread.started.thread_id` 绑定显式 session UUID；共用 JSONL handler 仍标记 `UNVERIFIED_RESUME_PROTOCOL`，因为本阶段没有真实 resume transcript。最低版本/feature probes 不被表述为高版本 schema 兼容保证，未来未知 schema 继续 fail closed。
- Task 6 与未来 caller 必须同时观察 runner 的 `events`、`terminationEvents` 和 `result`，不得只裸等待 final result。
- 新增可机械重放的 `0003-constrained-codex-runner.patch`，来源锁继续以独立 exact path allowlist、补丁 SHA、patched tree 与 strict manifest 绑定全部 vendored 变化。
- 对 0003 unified diff 所需的空白上下文设置仅该补丁文件的精确 Git whitespace 属性，不放宽源码或其他补丁检查。
- Stage A / Task 5 仅通过 fake spawn/timer 和注入 verifier 验证静态 seam；Stage B / Task 5 后续补充了本机 native 签名/UDS 与 clean-home permission-profile fixture，但生产 evidence producer、客户 Mac 实际配置栈和 live runner 仍未接通。旧上游 adapter 在 Task 6 替换前不是受支持生产入口。
- 完成 Stage A / Task 6：新增账本优先 `AssistantChannel`、固定 system/control reply wrapper，以及仅消费持久 stage/terminal 的 60 秒进度 reporter。
- `AssistantChannel` 在 guard 后按 deny、pairing、verified card、exact cancel、normal task 分流；任务持久接收先于固定 ACK，ACK 先于 scheduler wake，duplicate、sink/gateway 失败和畸形返回均 fail closed 且使用固定内部错误。
- 取消分类只接受“停一下”“停止当前任务”“取消这个任务”的 NFC + trim 后精确相等；substring、标点变体和模糊文本作为普通任务，控制回复只使用三条固定事实文案。
- 用窄注入 adapter 替换受支持的旧 live channel 依赖图，只注册 message、cardAction 和脱敏 lifecycle；guard 前不读取正文/资源，卡片必须取得 exact trusted verifier evidence，旧 comment/reaction/command/media/direct-send/AgentAdapter 路径均不可达。
- 将 CLI start 改为 `ASSISTANT_RUNTIME_PORTS_REQUIRED` fail-closed stub；Stage B 注入持久 runtime ports 前，它会在读取配置、秘密或建网前退出，不回退到旧上游入口。
- 收口实际 package root 与两个 bin 命令的旁路：只导出 Stage A 安全 seam，两个命令都固定进入缺少持久端口的 fail-closed 起点；bridge 的 prebuild/pretest/pretypecheck 会从干净源码先构建 contracts。
- 将进度 source 收紧为原子 subscribe-and-snapshot 契约，修复同步 replay 与更新快照之间的丢失窗口；卡片 action 在 trusted evidence 后、异步 sink 前形成受限深冻结 JSON 快照；注册或连接中途失败均 best-effort disconnect。
- 原子进度订阅的失败路径也会 best-effort 清理：数组、可调用对象、额外字段、snapshot/unsubscribe getter 异常、非函数伪装或 own-key 检查异常，只要能通过 own data descriptor 安全恢复 unsubscribe，就不会遗留 listener；被撤销的 event Proxy 也只会 fail closed，不向 listener 调用方抛错。
- 新增可机械重放的 `0004-ledger-first-assistant-channel.patch`；Task 5 安全补修后重新生成完整补丁链，exact 13-path allowlist、0004 补丁 SHA `be17a41f…35b3eb`、patched tree `85d9128a…6e171e` 和 strict manifest `d59d9c3d…412f85` 已锁定。0004 可反向精确回到 Task 5 tree `15e688f9…f9fc7`，完整 0001–0004 也可反向回到原始上游 tree 后再正向恢复最终 tree。
- Task 5 安全补修后的 bridge 语义矩阵为 15 个 test files、362/362 tests；覆盖原有 Task 6 顺序、重复事件、固定回复、精确取消、原子进度交接/串行化/清理与入口门禁，并新增 request/dependency/evidence 异步漂移、Proxy/accessor、能力 receiver、冻结 invocation 和 `Object.prototype` 污染回归。
- Task 6 只证明本地 injected seam 与内存 fake 顺序；不证明 SQLite durability、重启/lease 恢复、真实飞书/Codex E2E、生产接线、部署或 24 小时可用性。
- 完成 Stage A / Task 7 的提交前实现：新增组合 Task 4 guard 与 Task 6 production seam 的内存 bridge harness，25/25 tests 覆盖群聊/错人/错 chat/app/tenant/未知/畸形事件零副作用、未配对普通消息、persist→ACK→wake、sink failure、duplicate、pairing、可信/不可信 card、精确取消和窄 gateway 两参数边界。
- 新增 TypeScript Compiler API 依赖图门禁，解析 import/export/import-equals/dynamic import/require/require.resolve/import type，并对 CLI、package root、channel、runner 分别锁定 exact reachable/external 集合；解析错误、非字面量 loader、未解析路径、symlink 越界、网络/环境/raw transport/URL/`lark-cli` 能力均 fail closed，12/12 tests 通过。
- 扩展 Codex 静态/fake 安全矩阵至 23/23：固定 new/resume argv、冻结 null-prototype 五字段环境、stdin-only prompt、调用方注入拒绝、workspace/socket/release 绑定，以及缺失或不合格 verifier evidence 时 spawn 为零。真实 Codex 工具网络仍为 `UNVERIFIED_NO_FIXTURE`。
- 为 `scripts/vendor-bridge` 增加真正的 `--offline-replay`：在任何在线 clone 前分流，校验 lock、脚本/manifest/license/patch hash，在临时树中反向恢复原始 tree 后再正向恢复最终 tree，并以 strict manifest 比较 archive/target；target 缺失、symlink、漂移、补丁或 lock 漂移退出 73，未知模式退出 2，且不写 target/`LICENSES`。离线/负测 6/6 通过，脚本 SHA-256 锁为 `ecd4239b…3c1d`。
- 新增仓库级 `AGENTS.md` 与本地开发/证据 runbook，固化读取顺序、gateway-only、秘密隔离、真实证据用语、供应链重放和 commit/push/PR/deploy 分离门禁。
- Task 7 提交前全量门禁为 23 files、461/461 tests；bridge 15 files、362/362；离线 frozen install、format、lint、typecheck、build、vendor replay 和 diff-check 全部 exit 0。最终 `STAGE_A_SEAMS_VERIFIED` 状态暂缓到提交后独立审查与干净 HEAD 总门禁完成。
- Task 7 已以 `df5c392` 本地提交；两路提交后独立审查均给出 `CHANGES_REQUIRED`。审查复现了卡片 action 与验签 evidence 未绑定的异步替换、AST 依赖图的 symlink/别名/动态加载绕过、offline replay 继承 ambient `GIT_*` 后可执行 helper 或改写外部 index、真实 bridge 构建与 vendor fixture 扫描竞态，以及 integration harness 恒零伪指标。
- 卡片 action 现在先形成受限深冻结快照，再以排序键 canonical JSON 计算 SHA-256，并仅在与可信 evidence 的 `payloadHash` 精确相等时进入 guard/confirmation sink；新增错误哈希、验签等待期间替换和不同插入顺序的固定向量回归。
- AST 门禁扩展到 18/18：拒绝源码文件与任一父目录 symlink、`process.getBuiltinModule`、非字面量 loader、网络全局及其别名、`globalThis/global/self/navigator` 逃逸、非精确 `process.argv`/`process.exitCode` 访问、`eval`/`Function`/`.constructor`、组合 URL 和所有通用 `.send/.stream`；保守误报优先于静默旁路。
- offline replay 的 Git 子进程不再展开 `process.env`，只保留固定 PATH/locale/tmp/home 和禁用系统/全局配置的 Git 最小环境，并强制 `GIT_CONFIG_COUNT=0`、`GIT_ALLOW_PROTOCOL=file`；hostile fsmonitor、`GIT_INDEX_FILE` 和同类 ambient 能力不能执行或写入 target/`LICENSES`。vendor replay 负测增至 7/7。
- 将实际 package/bin 构建迁入临时隔离 workspace，避免 tsup 临时配置与 vendor 扫描并发争用真实 `packages/bridge`；隔离构建与 replay 并发 13/13 连续三轮通过。integration harness 删除无法连接生产 seam 的 Codex、Secret、legacy 和 direct-business 恒零计数，只保留可观察指标。
- 审查修复后的提交前门禁为 Task 7 聚焦 74/74、全仓 23 files / 472/472、bridge 15 files / 365/365；format、lint、typecheck、build、离线 frozen install、实际 vendor replay 与 diff-check 全部通过。新的 0004 SHA 为 `ef8af2ba…2d5d`，patched tree 为 `1158208f…a17c`，strict manifest 为 `cb2a742b…b3ef`，vendor script SHA 为 `183af099…bdde`；修复提交后的独立复审仍待执行，因此尚未标记 `STAGE_A_SEAMS_VERIFIED`。
- 首轮审查修复已以 `38cfb5c` 本地提交。修复提交后的两路独立复审再次给出 `CHANGES_REQUIRED`：AST raw transport 门禁只识别直接 `.send/.stream` call，无法识别解构、属性赋值、常量计算键或运行时动态方法选择；offline replay 虽清洗 Git 配置变量，但入口 Node、manifest 子进程、Git 与 tar 仍可由 ambient PATH / `NODE_OPTIONS` 注入。
- 以新增红测固化上述反例：raw transport 别名此前返回空 capability 集；Node preload probe 在一次成功 replay 中执行三次；PATH shim 可取代 Node/Git/tar。AST 现在对 object binding、显式/计算属性提取及动态 computed callee 保守拒绝，并将任意深度的数据流分析明确排除在静态门禁声明之外。
- offline replay 现在只从固定系统候选路径解析 Node/Git/tar，以 `/usr/bin/env -i` 启动入口 Node，并为 manifest、Git 和 tar 子进程分别传入从零构造的最小环境；ambient `NODE_OPTIONS`、PATH shim、Git config/fsmonitor/index 注入均未执行。vendor script SHA 更新为 `bdbb935d…c0b0`，patched tree 与 strict manifest 保持 `1158208f…a17c` / `cb2a742b…b3ef`。
- 第二轮修复后的提交前门禁为 Task 7 聚焦 77/77、全仓 23 files / 475/475、bridge 15 files / 365/365；format、lint、typecheck、build、离线 frozen install、实际 vendor replay 与 diff-check 均通过。新的修复提交、独立复审和干净 HEAD 总门禁仍待执行，因此仍未标记 `STAGE_A_SEAMS_VERIFIED`。
- 第二轮修复已以 `8168bb1` 本地提交。其两路独立复审再次给出 `CHANGES_REQUIRED`：`rawClient[method]` 经直接变量、computed object binding、comma callee、`Reflect.apply` 或 `.call` 一跳提取后仍可空集通过；offline replay 的 zsh 解释器也会在 `/usr/bin/env -i` 之前读取 hostile `ZDOTDIR/.zshenv` 并写入 `LICENSES`。
- 新增 6 个红测分别复现五种动态提取与 zsh startup hook。AST 现在在不将正常数组/record 索引误报为 callable 的前提下，拒绝直接变量/赋值提取、computed binding、任意 callee 子表达式及 Reflect dispatch 参数；声明继续明确排除任意深度 JavaScript 数据流证明。vendor 脚本 shebang 改为 `/bin/zsh -f`，用户级 `.zshenv` 不再先于空环境入口执行。
- 第三轮修复后的提交前门禁为 Task 7 聚焦 83/83、全仓 23 files / 481/481、bridge 15 files / 365/365；format、lint、typecheck、build、离线 frozen install、实际 vendor replay 与 diff-check 均通过。vendor script SHA 更新为 `0c3c1c6f…4e7f`，patched tree / strict manifest 保持不变。新的修复提交、独立复审和干净 HEAD 总门禁仍待执行，当前仍不是生产 `PASS`。
- 第三轮修复已以 `b5e70f0` 本地提交。其两路独立复审再次给出 `CHANGES_REQUIRED`：`Reflect.get`、computed assignment、conditional/nullish/comma/object initializer、static/compound assignment 与 tagged template 仍可绕过 `dynamic_method_call`；原卡片哈希、zsh/Node/PATH/Git、symlink、并发 build/replay 与 harness 问题均未回归。
- 先新增 9 个审查反例，提交前只读缺口审计再以 8 个红测复现解构赋值、类字段、`for…of`、decorator、throw/catch 与双重 `Function.call/apply` 调度。AST 现在拒绝 `Reflect.get`、动态 computed property assignment、value-preserving variable/property/compound/destructuring assignment、变量/类字段/loop/control-flow initializer 或 binding、call/new/tagged-template/decorator callee 子表达式及直接 Reflect/Function dispatch 参数；明确的 primitive 二元运算不会被误判为 callable，跨函数或任意深度数据流仍不在本静态门禁声明内。
- 第四轮修复后的提交前门禁为 Task 7 聚焦 100/100、全仓 23 files / 498/498、bridge 15 files / 365/365；format、lint、typecheck、build、离线 frozen install、实际 vendor replay 与 diff-check 均通过。patched tree、strict manifest 与 vendor script SHA 保持不变；新的修复提交、独立复审和干净 HEAD 总门禁仍待执行。
- 第四轮修复已以 `28f0940` 本地提交。其两路独立复审再次给出 `CHANGES_REQUIRED`：`Reflect.get` 通过自身 `call/apply` 或直接 alias 调用仍可漏报；常量计算属性赋值目标也未被静态折叠。复审同时建议把同等级的 class heritage、参数默认值与对象 descriptor 纳入直接语法矩阵；历史卡片、环境、symlink、隔离构建/replay 和 harness 问题均未回归。
- 新增 7 个红测。AST 对任何直接 `Reflect.get` member reference 保守拒绝，静态折叠单一定义的 const 字符串属性键，并覆盖 parameter/property/heritage initializer 与 descriptor `value`；任意 runtime-computed destination key 和通过任意 helper/library 传递的值仍明确属于本静态语法门禁之外的数据流问题。
- 第五轮修复后的提交前门禁为 Task 7 聚焦 107/107、全仓 23 files / 505/505、bridge 15 files / 365/365；format、lint、typecheck、build、离线 frozen install、实际 vendor replay 与 diff-check 均通过。patched tree、strict manifest 与 vendor script SHA 保持不变；新的修复提交、独立复审和干净 HEAD 总门禁仍待执行。
- 第五轮修复已以 `88caebf` 本地提交。其两路独立复审再次给出 `CHANGES_REQUIRED`：destructuring default、computed descriptor、`Reflect.get` 声明/赋值式解构 alias、类型 wrapper 与不同词法块同名 const 仍可漏报，证明继续枚举“像 callable 的上下文”不能形成稳定 fail-closed 门禁。
- 新增 6 个红测后，AST 改为拒绝除审计例外外的所有运行时计算属性访问，并删除原上下文枚举器。例外仅限简单 `=` 左值、primitive-only 比较/算术或固定 `Number` 检查、`snapshotRawMetadata` 的精确元数据复制、两个固定系统文案表读取；任何 RHS 动态访问仍独立拒绝。`Reflect.get` 的 member、声明式与赋值式解构 alias 均拒绝。
- 第六轮修复后的提交前门禁为 Task 7 聚焦 113/113、全仓 23 files / 511/511、bridge 15 files / 365/365；format、lint、typecheck、build、离线 frozen install、实际 vendor replay 与 diff-check 均通过。patched tree、strict manifest 与 vendor script SHA 保持不变；新的修复提交、独立复审和干净 HEAD 总门禁仍待执行。
- 第六轮修复已以 `7e16ea1` 本地提交。其两路独立复审给出 `CHANGES_REQUIRED`：primitive-only、简单赋值和固定路径例外可被 call/new/coercion/赋值结果消费；全文件 const 折叠无法证明词法绑定，参数、`let`、catch 与局部 `Number` shadow 可漏报；`Reflect.get` 的 for-of、嵌套数组和 catch 解构 alias 也未覆盖。
- 新增 22 个回归用例：其中 21 个先在旧分析器上复现调用/构造被比较、算术和 `Number` 包裹，`instanceof`/`in`/宽松比较、const 与全局名 shadow、独立或被消费的动态赋值、固定路径 lookalike 及三种直接 `Reflect.get` 解构漏检；可选调用用例在旧分析器上已拒绝，用于锁定硬化行为。另以独立 TypeScript AST 断言锁住四个支持入口的运行时计算属性访问数为 0。
- 删除 identifier const 折叠、primitive/赋值/固定路径的全部计算属性例外；任何非字面量 element access 现在直接产生 `dynamic_method_call`，任何 `get` object binding 或 destructuring assignment 也保守拒绝。生产侧把 14 个动态下标改为静态 `includes`、固定字段、`Object.defineProperty`、`Array.at`、单次 usage 字段读取和穷尽系统文案 switch。
- 新增可机械重放的 `0005-static-dynamic-access-boundary.patch`，exact 6-path allowlist 与补丁 SHA `2bf899fe4e8b7040545591ec9eb0133f1f0a85864b6420397ebccf9f94f1fae3` 已锁定；patched tree 更新为 `2881144148cb3ef4d770853b02823a7c23eb3637`，strict manifest 更新为 `c283512b76d9070ea7da16558b4a3037882e4c4588cf7e353c0d8566b24485a4`，完整 0001–0005 可反向恢复原始 tree 后正向恢复最终 tree。
- 第七轮修复后的提交前门禁为 Task 7 聚焦 135/135、全仓 23 files / 533/533、bridge 15 files / 365/365；format、lint、typecheck、build、离线 frozen install、实际 vendor replay 与 diff-check 均通过。新的修复提交、独立复审和干净 HEAD 总门禁仍待执行。
- 第七轮修复已以 `7ef68fb` 本地提交。其两路独立复审给出 `CHANGES_REQUIRED`：`Reflect` 对象 alias 与逗号包装可把调用变成普通 `.get` member；嵌套数组/对象及 for-of 解构赋值未被追踪到实际赋值边界；`rawClient[1 + 2]` 还会被按字符串拼接错误折叠为字面键。
- 第八轮修复新增六个先红后绿的回归，覆盖对象 alias、逗号包装、嵌套数组赋值、嵌套对象赋值、for-of 赋值和数值表达式属性键。属性访问安全判定现在只接受数字、字符串或无替换模板字面量键，不再折叠表达式；任何字面量 `get` member/binding/assignment 均保守拒绝，嵌套赋值会向上追踪至简单赋值或 for-in/for-of 边界。`process["get" + "BuiltinModule"](...)` 仍能被归类为动态模块加载器，同时继续触发非字面量属性拒绝。
- 第八轮修复后的提交前门禁为 integration 26/26、Codex 23/23、dependency graph 82/82、offline replay 10/10，共 141/141；全仓为 23 files / 539/539，bridge 保持 15 files / 365/365；format、lint、typecheck、build、离线 frozen install、实际 vendor replay 与 diff-check 均通过。新的修复提交、独立复审和干净 HEAD 总门禁仍待执行。
- 第八轮修复已以 `c210be4` 本地提交；两路提交后独立复审与干净 HEAD 总门禁仍待执行，因此尚未标记 `STAGE_A_SEAMS_VERIFIED`。
- 精确 HEAD `1d74e03` 的安全复审与全量复审均明确 `APPROVED`：上一轮六个 blocker 全部关闭，文档与供应链证据一致，无 skip/todo/only；干净 HEAD 总门禁为 23 files / 539 tests、bridge 15 files / 365 tests、Task 7 聚焦 141/141，离线 frozen install、format、lint、typecheck、build、vendor replay、diff-check、clean worktree 和 remote=0 均通过。
- Stage A 状态升级为 `STAGE_A_SEAMS_VERIFIED`。该状态只确认本地开发 seam 与静态/fake 证据，不代表生产 `PASS`、真实飞书/Codex E2E、macOS sandbox/网络阻断、部署或 24 小时可用性。

### Known limitations

- 尚未完成客户 Mac mini 安装、真实飞书 API、PPT 客户端、Keychain/OAuth 续期和 LaunchAgent 恢复验收。
- 尚未完成连续 24 小时实机测试，因此本候选版不标记为 `production ready`。

[Unreleased]: https://github.com/banqiusheng/codex-feishu-executive-assistant/compare/v0.1.0-rc.1...HEAD
[0.1.0-rc.1]: https://github.com/banqiusheng/codex-feishu-executive-assistant/releases/tag/v0.1.0-rc.1
