# Mac mini 傻瓜安装

这个仓库只服务一位总裁和一台专用 Mac mini。交付人员准备好飞书自建应用后，Codex 在仓库根目录执行一次安装；以后总裁只需要在飞书私聊机器人。

## 安装前准备

- Mac mini 已登录总裁的专用 macOS 账号，并保持供电、联网和唤醒。
- 已安装 Node.js 22 LTS、Corepack 和 Xcode Command Line Tools。
- 已安装并登录 Codex CLI。
- 已准备飞书自建应用的 App ID 和 App Secret；不需要手工查找 Tenant Key。
- 飞书应用已启用机器人、长连接和私聊消息事件，并完成版本发布与管理员审批。
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
9. 初始化机器人专用飞书 CLI；若 6 项 MVP 用户权限仍有缺失，安装器会直接打开经严格校验的飞书授权页，由总裁本人在浏览器点击授权；
10. 生成不含任何 Secret 的运行配置；总裁发送正确的一次性私聊配对码后，程序从可信事件自动绑定企业标识；
11. 注册一个用户级 LaunchAgent，使服务登录后自动启动、异常退出后自动拉起。

`imagegen` 是 Codex 会话级系统能力，不会因为安装 Presentations 插件就自动出现在空的专用 Home。安装器不会复制系统 Skill 或伪造可用性；`doctor` 会保持 `WARN`，直到目标 Mac mini 的新 Codex 任务真实确认 `Presentations` 和 `imagegen` 都已暴露并完成一次 PPT 验收。

用户授权不由 Bot Secret 代替。安装器只在 `--apply` 且确有缺失权限时打开飞书授权页，总裁无需复制授权链接或设备码，只需在浏览器点击授权。授权 helper 会严格核验锁定 CLI 的结构化输出、授权站点、GUI、opener、独占 flow、空临时 cache 基线和完成回执；已有 cache entry、已有 flow lock 或任一步不可信时都固定报 `BLOCKED_USER_AUTH`，保持不确定文件不变并交由人工核查，不会回显临时授权数据或降级为手工复制。`--plan`、`--verify-only` 和 `doctor` 不会打开浏览器。授权不存在或失效时，`doctor` 会明确报错，不会假装这些能力可用。

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
   `codex-login`、`lark-cli`、`app-user-scopes`、`user-oauth`、`sqlite`、
   `launchd-plist`、`launchd-service` 和 `pairing` 没有 `FAIL`。
3. 只在机器人私聊里发送一次“测试：请只回复连接正常”。发送后不要因为等待而
   重复点击或重发。
4. 目视确认飞书里恰好出现一条“收到，我开始处理”和一条最终回复；缺少、重复或
   顺序异常都不算通过。

`imagegen` 的 `WARN` 不阻塞上述纯文本验收，但会阻塞 PPT 能力验收。只有在目标
Mac mini 的新 Codex 任务真实暴露 Presentations 与 `imagegen`，并成功回传一份
PPT 后，才能把 PPT 标为已验收。

## 24H 边界

LaunchAgent 只能在 Mac mini 已开机、用户已登录、保持唤醒且网络可用时持续工作。FileVault 重启后仍需本人登录一次；断电、系统睡眠、家庭网络或飞书/Codex 服务故障不属于本程序可以绕过的范围。

安装完成后不要移动或删除本仓库目录；LaunchAgent 使用经过校验的绝对路径运行这里的构建产物。
