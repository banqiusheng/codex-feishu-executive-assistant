# Mac mini 傻瓜安装

这个仓库只服务一位总裁和一台专用 Mac mini。交付人员准备好飞书自建应用后，Codex 在仓库根目录执行一次安装；以后总裁只需要在飞书私聊机器人。

## 安装前准备

- Mac mini 已登录总裁的专用 macOS 账号，并保持供电、联网和唤醒。
- 已安装 Node.js 22 LTS、Corepack 和 Xcode Command Line Tools。
- 已安装并登录 Codex CLI。
- 已准备飞书自建应用的 App ID 和 App Secret；不需要手工查找 Tenant Key。
- 飞书应用已启用机器人、长连接和私聊消息事件，并完成版本发布与管理员审批。
- 开发者后台已按 `config/feishu-scopes.json` 开通当前 Bot/User 最小权限；权限变化后已重新
  发布应用版本。
- App Secret 不要粘贴到聊天、配置文件或命令行参数中。

## 给 Codex 的一句话

> 请读取本仓库的 AGENTS.md 和 BOOTSTRAP.md，先运行 `./scripts/install --plan`，确认无误后在交互终端运行 `./scripts/install --apply`。App Secret 只在 macOS Keychain 的安全提示中输入，不要写进聊天或文件。

安装程序会：

1. 校验仓库锁定的 bridge、lark-cli、Codex 和 visual-first-ppt 版本；
2. 构建仓库与本机 gateway run client；
3. 创建 `~/PresidentAssistant` 和机器人专用 `CODEX_HOME`；
4. 把锁定的 `lark-cli 1.0.72` 安装到私有运行目录，不加入 Codex PATH；
5. 安装仓库内的 `executive-assistant` Skill；
6. 从当前 Codex 可见的官方 `openai-primary-runtime` marketplace 定位并安装
   `presentations@openai-primary-runtime` 到专用 `CODEX_HOME`，不猜测或复制插件缓存；
7. 精确核验并安装 `visual-first-ppt v0.3.0`，不覆盖来源不一致的已有安装；
8. 引导完成专用 Codex 登录，并把 Bot App Secret 通过 Keychain 自身的安全输入写入 macOS Keychain；
9. 初始化机器人专用飞书 CLI并核验消息、附件、日历、通讯录、妙记、Base 和云文档权限；
   个人 User OAuth 缺失时服务仍可启动，机器人会发送一次经严格校验的飞书授权卡；
10. 生成不含任何 Secret 的运行配置；总裁发送正确的一次性私聊配对码后，程序从可信事件自动绑定企业标识；
11. 注册一个用户级 LaunchAgent，使服务登录后自动启动、异常退出后自动拉起。

`imagegen` 是 Codex 会话级系统能力，不会因为安装 Presentations 插件就自动出现在空的专用 Home。安装器不会复制系统 Skill 或伪造可用性；`doctor` 会保持 `WARN`，直到目标 Mac mini 的新 Codex 任务真实确认 `Presentations` 和 `imagegen` 都已暴露并完成一次 PPT 验收。

用户授权不由 Bot Secret 代替。安装器不打开个人 OAuth 页面；个人 User OAuth 缺失时服务
仍会启动，机器人会在总裁私聊发送只有一个“点击授权”按钮的卡片。总裁无需复制授权链接或
设备码，点击完成后重新发送原任务即可。授权 helper 会严格核验锁定 CLI 的结构化输出、
授权站点、独占 flow、空临时 cache 基线和完成回执；已有 cache entry、已有 flow lock 或
任一步不可信时都固定报 `BLOCKED_USER_AUTH`，保持不确定文件不变并交由人工核查，不会回显
临时授权数据或降级为手工复制。`--plan`、`--verify-only` 和 `doctor` 不会启动个人授权
流程。授权不存在或失效时，`doctor` 会报告 `ACTION_REQUIRED`，不会假装这些能力可用。

首次配置会显示一次性飞书配对码。总裁只需在机器人私聊中发送该码；任何群聊或其他人员都不能完成配对。

## 常用操作

只查看安装计划，不改变电脑：

```bash
./scripts/install --plan
```

实际安装：

```bash
./scripts/install --apply
```

日常更新不需要总裁操作终端：机器人发现公开 `main` 有新版时才会提示
“发现新版本，回复“更新”即可安装。” 总裁在私聊中只回复“更新”即可；机器人会短暂
离线并自动恢复。其他文字不会触发安装，24 小时内也不会重复检查或重复提示同一版本。

如果这台 Mac 已经装过不含更新能力的旧版本，交付人员只需让本机 Codex 把现有仓库的
`main` 仅 fast-forward 到公开最新 `main`，然后运行一次
`./scripts/install --update-existing` 和 `./scripts/doctor`。该模式从现有配置读取非秘密
App ID，并复用 Keychain 与用户授权；不会询问 App Secret，也不会打开授权流程。

如果开发者后台重置过 App Secret，机器人会先离线，无法接收“更新”。让目标 Mac 上的
Codex 先 fast-forward 到公开最新 `main`，再在可见交互终端运行：

```bash
./scripts/install --refresh-app-secret
./scripts/doctor
```

`--refresh-app-secret` 只适用于现有安装：它从受保护配置读取非秘密 App ID，由
`/usr/bin/security` 自己安全收集并更新同一个 Keychain item，然后继续既有更新安装链。
不要把 Secret 发给 Codex，也不要写进命令行、环境或文件。默认 `--update-existing` 仍不会
覆盖 Secret。

只读检查：

```bash
./scripts/doctor
```

重启助理：

```bash
./scripts/restart --apply
```

## 安装后简单验收

安装命令退出 `0` 只说明安装流程没有报错，不等于助理服务已经验收。请让 Codex
在同一台 Mac mini 上完成下面检查，不需要总裁复制任何链接或终端内容：

1. 核验
   `launchctl print gui/$(id -u)/com.codex-feishu.executive-assistant`
   中的服务状态为 `state = running`，不能只确认 plist 已存在。
2. 运行 `./scripts/doctor`，确认 `config`、`node`、`runtime-entry`、
   `user-auth-helper`、`codex-login`、`lark-cli`、`app-user-scopes`、`sqlite`、
   `launchd-plist`、`launchd-service` 和 `pairing` 没有 `FAIL`。
   `user-oauth` 为 `ACTION_REQUIRED` 时按机器人授权卡完成一次授权，再复查。
3. 只在机器人私聊里发送一次“测试：请只回复连接正常”。发送后不要因为等待而
   重复点击或重发。
4. 目视确认飞书里恰好出现一条“收到，我开始处理”和一条最终回复；缺少、重复或
   顺序异常都不算通过。

连接回环通过后，再按真实验收清单各执行一次：直接创建单次日程、向测试联系人发送文本、
发送多人固定展示卡、转发一个已登记附件、读取指定 Base，以及创建一份原生飞书云文档报告。
只验证能力是否达标；不要用视觉微调阻塞验收。写操作遇到 `UNKNOWN` 时不要重发。

`imagegen` 的 `WARN` 不阻塞上述纯文本验收，但会阻塞 PPT 能力验收。只有在目标
Mac mini 的新 Codex 任务真实暴露 Presentations 与 `imagegen`，并成功回传一份
PPT 后，才能把 PPT 标为已验收。

## 24H 边界

LaunchAgent 只能在 Mac mini 已开机、用户已登录、保持唤醒且网络可用时持续工作。FileVault 重启后仍需本人登录一次；断电、系统睡眠、家庭网络或飞书/Codex 服务故障不属于本程序可以绕过的范围。

安装完成后不要移动或删除本仓库目录；LaunchAgent 使用经过校验的绝对路径运行这里的构建产物。
