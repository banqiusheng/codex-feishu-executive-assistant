# Codex 飞书总裁助理

这是一个只服务一位总裁、一台专用 Mac mini、一个飞书自建应用的个人 AI 助理。总裁在飞书私聊里直接下达指令，家中的 Mac mini 使用 Codex 完成任务，再把文字或文件返回原私聊。

当前版本线为 `v0.1.0-rc.1`。它是源码与安装流程候选版，不代表客户生产环境已经通过验收。

## 能做什么

- 飞书私聊消息先持久化，再回复“收到”，随后单并发交给 Codex；
- 查询会议纪要和详情，并按总裁所属组织、融创中国-直管业务-文旅事业部、融创中国-热雪奇迹
  的顺序优先解析内部联系人；重名时只让总裁选人，不猜测；
- 总裁把时间和人员说清楚后，直接在主日历创建一次日程，不再反复确认；
- 向最多 20 名内部人员直接发送文本、固定展示卡和当前/引用消息中的已登记附件；
- 读取多维表格的结构、明细或受限聚合，并在 `my_library` 创建原生飞书云文档报告；
- 缺少个人 User OAuth 时，机器人直接发送飞书授权卡；总裁点击一次后重新发送原任务；
- “停一下”“停止当前任务”“取消这个任务”可以持久取消当前任务；
- PPT 直接复用锁定版本的 [`visual-first-ppt`](https://github.com/banqiusheng/visual-first-ppt)，不重复实现；
- 正常使用时每天至多检查一次公开 `main`；有新版才提示，总裁精确回复“更新”即可安装；
- 提供安装、只读检查、重启和用户级常驻服务。

### 当前交付状态

本轮源码用于形成上述新增能力的**目标 Mac 验收候选版**。只有本地完整门禁通过、提交成功
推送且 GitHub Actions 通过后，目标 Mac 才应更新；公开状态以 GitHub `main` 的 commit 和
Actions 为准。由于开发机的 App Secret 已重置，新能力的真实飞书写入改在高管目标 Mac
更新后验收。此状态不代表目标 Mac 已通过、24 小时稳定性已确认或 `production ready`。

对应的[设计](docs/superpowers/specs/2026-07-29-direct-feishu-actions-and-base-report-design.md)
和[实施计划](docs/superpowers/plans/2026-07-29-direct-feishu-actions-and-base-report.md)
保留了能力、权限和验收边界。

## 快速开始

交付人员或 Codex 在目标 Mac mini 上执行：

```bash
git clone https://github.com/banqiusheng/codex-feishu-executive-assistant.git
cd codex-feishu-executive-assistant
./scripts/install --plan
```

确认计划无误后，再在交互终端运行：

```bash
./scripts/install --apply
```

飞书自建应用只需准备 App ID 和 App Secret。安装程序不会索要 Tenant Key；
企业标识会在总裁发送正确的一次性私聊配对码时，由可信事件自动绑定并持久化。
App Secret 仍只在 macOS Keychain 的安全提示中输入。
开发者后台需要开通 `config/feishu-scopes.json` 锁定的 Bot/User 最小权限并发布应用版本。
安装程序会核验日历、通讯录、妙记、消息、附件、Base 和云文档所需权限；已有用户授权有效时，
只增量申请当前缺失项，不会重复申请或扩大权限。
安装器不会打开个人 OAuth 页面；缺少个人 User OAuth 时仍会启动服务，机器人随后在总裁
私聊中发送只有一个“点击授权”按钮的飞书卡片。总裁无需复制链接或设备码，点击完成后重新
发送原任务即可。运行时授权 helper 会严格核验锁定 CLI 的结构化输出、授权站点、独占 flow、
临时 cache 基线和完成回执；任一步不可信时固定报 `BLOCKED_USER_AUTH`，不回显临时授权
数据，也不降级为手工复制。`--plan`、`--verify-only` 和 `doctor` 都不会启动个人授权流程。
如果配对码过期或遗失，重新运行 `./scripts/install --apply` 会在尚未配对时安全刷新新码。

`visual-first-ppt` 会从锁定的 `v0.3.0` 中只安装实际 Skill 子目录并核验子树。
安装器早期版本留下的整仓嵌套布局若与锁定来源精确一致，会被可恢复地迁移到正确位置；
旧目录保留在本机私有隔离区，不会直接删除。
如果专用 `CODEX_HOME` 已有来自同一官方 marketplace 的旧版 Presentations，
安装器会先把旧 cache 保存到权限 `0700` 的私有隔离区，再执行官方升级并精确复核；
来源不明、版本倒退或缓存身份异常时仍会停止，不会覆盖。
重复安装时，安装器会等待旧 LaunchAgent 完成卸载，再注册新服务；仅在确认刚刚卸载过
同一服务且 launchd 返回过渡期 I/O 错误时进行有限重试，其他失败仍会立即停止。
常驻 runtime 使用安装配置中记录的 Node 绝对路径启动固定 Codex 脚本，不依赖交互终端
的 `PATH`；只读 doctor 也用相同的精简环境核验 Codex 登录和插件入口，避免出现
“doctor 正常、真实消息任务却无法启动”的误报。重复安装会原子刷新已漂移的 Node/Codex
绝对路径；当前版本只支持安装器验证通过的 Node.js 脚本入口，未知或原生入口会明确停止。
doctor 还会在不读取 App Secret、Bot/User Token 或调用写接口的前提下报告 `feishu-dns` 与
`feishu-https-rest`：前者只检查固定飞书域名能否解析，后者只检查固定 HTTPS `HEAD` 请求
能否到达（任意 HTTP 状态都表示网络可达）。这两项只证明网络连通性，不代表飞书权限、API
业务调用成功、配对完成或 24 小时可用；安装器也会核验该 helper 是普通非符号链接交付文件。
网络 child 在五秒到期时会强制终止；其输出、stderr、退出状态与 JSON schema 任一不可信时，
doctor 只给出固定失败分类，不回显子进程内容。
当前交付回归还验证网络 helper 或用户授权 helper 缺失、非普通文件或符号链接时，
`--verify-only` 会在写入前停止。用户授权 helper 的本地受控 seam 已覆盖严格 JSON/UTF-8/输出
上限、原始授权串的 authority/Unicode/parser-confusion 拒绝、固定 opener 参数、6 项权限差额、
独占 flow lock、空 cache 基线、有界 fd 读取与保守清理、child `close` 结算边界、SIGINT/SIGTERM/
SIGHUP 中止，以及完成后 `auth status --verify` 与 `auth check` 复核；`--plan`、`--verify-only`
与 doctor 测试模式均不会调用浏览器 opener。
该 doctor 回归使用最小合法配置运行正常 JSON 检查路径，而不是帮助参数的早退路径。

也可以直接把下面这句话交给 Codex：

> 请读取本仓库的 AGENTS.md 和 BOOTSTRAP.md，先运行 `./scripts/install --plan`，确认无误后在交互终端运行 `./scripts/install --apply`。App Secret 只在 macOS Keychain 的安全提示中输入，不要写进聊天或文件。

完整准备要求和日常操作见 [Mac mini 安装说明](BOOTSTRAP.md)。

## 日常更新

总裁不需要打开 GitHub 或终端。机器人发现公开 `main` 有新版本时，会在正常任务回复末尾
提示“发现新版本，回复“更新”即可安装。” 只有去除首尾空格后精确等于“更新”的私聊
才会安装；其他文字不会触发。安装期间机器人可能短暂离线几分钟，现有 LaunchAgent 会
自动拉起服务。更新失败时保留或恢复旧版本，不影响下一次正常使用。

已经安装过旧版本的 Mac 只需初始化一次：把本仓库地址交给该 Mac 上的 Codex，并说：

> 请在现有安装仓库中确认没有本地改动，把 main 仅 fast-forward 到这个公开仓库的最新
> main，阅读 README.md 和 BOOTSTRAP.md，然后运行 `./scripts/install --update-existing`
> 和 `./scripts/doctor`。不要读取、输出或要求我粘贴任何 Secret。

这次由 Codex 完成后，后续更新都由总裁在飞书里回复“更新”，不再需要上述步骤。

### App Secret 被重置时

App Secret 被开发者后台重置后，机器人无法在线接收“更新”，这是唯一需要目标 Mac 上
Codex 介入的例外。把本仓库地址交给目标 Mac 的 Codex，并说：

> 请读取仓库的 AGENTS.md、README.md 和 BOOTSTRAP.md，确认当前工作树没有本地改动，把
> main 仅 fast-forward 到公开最新 main，然后在可见交互终端运行
> `./scripts/install --refresh-app-secret`。App Secret 只让我在 macOS Keychain 自身的
> 安全输入中填写；不要读取、输出或要求我把它粘贴到聊天、命令参数或文件。完成后运行
> `./scripts/doctor`，确认服务已启动，并停在真实功能验收前报告结果。

这个入口从现有受保护配置读取非秘密 App ID，刷新同一个 Keychain service/account，并继续
既有更新安装链。默认 `./scripts/install --update-existing` 仍不会显示或覆盖 Secret。

## 安全边界

- App Secret 只保存到 macOS Keychain，不进入仓库、配置、命令行参数或聊天；
- 只接受已配对总裁的原私聊，群聊和其他人员不能下达任务；
- 日程、内部人员通知和基于当前 Base 证据的新建云文档，以总裁完整私聊指令作为持久授权；
  信息不完整时只追问缺失项，信息补齐后不再询问“是否执行”；
- 其他旧写能力仍保留不可变预览和本人确认，不存在通用跳过确认开关；
- 不确定的外部结果不会自动重试，避免重复通知或重复日程；
- 客户资料、飞书正文、Token 和真实用户 ID 不得提交到仓库或公开 Issue。

安全问题请按 [安全报告说明](SECURITY.md) 私下提交。

## 验证状态

本仓库提供格式、静态检查、类型检查、构建、全量测试、供应链离线回放、安装合同和密钥扫描门禁。公开仓库的 `main` 分支 push 与 Pull Request 会在 macOS GitHub Actions 中重新运行这些检查。

截至 2026-07-26，已在一台 MacBook Air 上按公开仓库的 fresh-clone 路径完成旧版 MVP
真实飞书验收：私聊消息回环、妙记与联系人查询、通知确认执行、日程确认与取消、持久停止、
服务重启恢复，以及 PPT 生成与文件回传均已通过。

旧版兼容性补修覆盖锁定 Lark CLI 的两种 macOS 签名输出、Schema 2.0 原生确认按钮、最长
180 秒的网关任务等待，以及客户端提前断开时的连接级错误隔离。该版历史门禁不作为本轮
新增能力已经发布或真实验收通过的证据。

2026-07-30 的直执行、多人/附件通知、Base 读取、飞书云文档报告和运行时授权卡只取得本地
模拟、只读与安全门禁证据；没有沿用旧版验收冒充新功能真实通过。客户目标 Mac mini 尚需
更新后逐项真实验收，也未完成连续 24 小时稳定性观察，因此本候选版不标记为
`production ready`。

## 本地质量命令

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
./scripts/vendor-bridge --offline-replay
ASSISTANT_TEST_MODE=1 ./scripts/install --verify-only
gitleaks git --config .gitleaks.toml --redact --no-banner .
```

## 项目文档

- [Mac mini 安装说明](BOOTSTRAP.md)
- [变更记录](CHANGELOG.md)
- [精简 MVP 计划](docs/superpowers/plans/2026-07-23-lean-mvp.md)
- [ACK 安全恢复与零复制授权实现计划](docs/superpowers/plans/2026-07-25-ack-recovery-and-zero-copy-auth.md)
- [ACK 安全恢复与零复制授权补修设计](docs/superpowers/specs/2026-07-25-feishu-ack-recovery-and-zero-copy-auth-design.md)
- [总裁指令直执行与多维表格报告设计](docs/superpowers/specs/2026-07-29-direct-feishu-actions-and-base-report-design.md)
- [总裁指令直执行与多维表格报告实施计划](docs/superpowers/plans/2026-07-29-direct-feishu-actions-and-base-report.md)
- [设计规格](docs/superpowers/specs/2026-07-20-codex-feishu-executive-assistant-design.md)
- [总路线图](docs/superpowers/plans/2026-07-20-codex-feishu-executive-assistant-roadmap.md)
- [本地开发与证据运行手册](docs/runbook/development.md)

## 许可证

本项目以 [MIT License](LICENSE) 发布。引入或审计保留的第三方组件继续遵循其各自许可证，详见 [`LICENSES/`](LICENSES/)。
