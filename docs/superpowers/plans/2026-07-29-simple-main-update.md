# Simple Main Update Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` to execute each task. Use a clean worktree created from `origin/main`; do not reuse the abandoned release-pipeline edits in the current dirty worktree.

**Goal:** 让高管继续只在飞书里使用机器人：系统每天至多检查一次 GitHub `main`，发现更新时提示“回复‘更新’即可安装”，且只有精确回复“更新”才执行安全更新。

**Architecture:** 保留现有单 LaunchAgent、Codex Channel、`scripts/install --apply` 安装链路。新增一个仓库内固定更新入口，负责检查、快进更新、失败回退；Codex Skill 只允许调用这个固定入口。检查发生在高管发起日常消息时，由状态文件控制 24 小时缓存，不新增后台定时进程。

**Tech Stack:** Node.js ESM、TypeScript、Vitest、Git、现有 macOS LaunchAgent 安装器。

---

## Task 1: 固定、安全的 GitHub main 更新入口

**Files:**

- Create: `scripts/update-assistant.mjs`
- Create: `tests/ops/update-assistant.test.ts`

### Step 1: 先写失败测试

覆盖以下行为：

- `--check` 在 24 小时内只读取缓存，不重复访问远端。
- 远端 `main` 与本地一致时返回 `current`。
- 远端有新提交时返回 `available`，同一提交只提示一次。
- GitHub 暂时不可达时返回 `unavailable`，不影响机器人继续处理原任务。
- `--apply` 只接受干净工作树、可信远端和可快进更新。
- 工作树有改动或分支不能快进时停止，不修改仓库。
- 安装失败时恢复旧 commit，并尝试用旧版本重新运行安装器。
- 状态文件固定为 `<runtimeRoot>/update-state.json`，权限为 `0600`。

测试使用临时 Git 仓库和本地 bare remote，不依赖真实 GitHub，不修改当前开发仓库。

### Step 2: 运行测试确认失败

```bash
pnpm exec vitest run tests/ops/update-assistant.test.ts
```

### Step 3: 实现最小更新入口

实现两个固定命令：

```bash
node scripts/update-assistant.mjs --check
node scripts/update-assistant.mjs --apply
```

约束：

- 从 `ASSISTANT_REPOSITORY_ROOT` 和 `ASSISTANT_RUNTIME_ROOT` 读取路径。
- stdout 只输出单行 JSON，诊断信息写 stderr。
- `--check` 不执行 fetch、checkout、安装或重启。
- `--apply` 仅 fast-forward，随后复用内部非交互入口
  `./scripts/install --update-existing`。
- 更新失败时恢复旧 commit 并尝试旧版本安装。
- 不实现 Release、Tag、manifest、签名、校验和、自动安装或第二个 daemon。

### Step 4: 运行测试确认通过

```bash
pnpm exec vitest run tests/ops/update-assistant.test.ts
```

---

## Task 2: 接入 Codex Skill，完成高管无终端更新体验

**Files:**

- Modify: `packages/runtime/src/codex-runner.ts`
- Modify: `packages/runtime/src/cli.ts`
- Modify: `packages/runtime/test/codex-runner-process.test.ts`
- Modify: `scripts/install`
- Modify: `skills/executive-assistant/SKILL.md`
- Create: `tests/contracts/simple-update-skill.test.ts`
- Modify: `tests/ops/delivery-surface.test.ts`
- Modify: `README.md`
- Modify: `BOOTSTRAP.md`
- Modify: `CHANGELOG.md`（仅在进入提交门禁时）

### Step 1: 先写失败测试

覆盖：

- Codex 子进程只新增已配置 Node、仓库根目录和运行时目录三个非敏感固定路径。
- 普通私聊按 24 小时缓存检查，只有 `available` 才附加更新提示。
- 只有去除首尾空格后精确等于 `更新` 才调用 `--apply`。
- 检查失败不阻断原任务，Skill 不允许自由拼接 Git 或 shell 命令。

### Step 2: 实现最小接入

- Runtime 传递三个可信固定路径。
- 安装器增加仅供固定更新入口调用的 `--update-existing`，复用现有 App ID、
  Keychain、用户授权和单一 LaunchAgent，不启动交互输入或浏览器授权。
- Skill 调用固定更新入口。
- README/BOOTSTRAP 只说明“正常使用—看到提示—回复更新—短暂重启”。
- 不创建新服务、数据库、Gateway、后台任务或管理页面。

### Step 3: 验证

```bash
pnpm exec vitest run \
  packages/runtime/test/codex-runner-process.test.ts \
  tests/contracts/simple-update-skill.test.ts \
  tests/ops/update-assistant.test.ts
pnpm test
pnpm build
./scripts/doctor
```

完成后停在提交和推送门禁；不创建 PR、Tag 或 Release。
