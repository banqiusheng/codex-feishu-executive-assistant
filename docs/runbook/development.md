# 本地开发与证据运行手册

## 当前阶段边界

Stage A 只建立可审计的仓库基础、fail-closed 私聊入口、受限 Codex runner、账本优先 channel ports，以及静态和内存集成门禁。

当前可以做：

- 在固定依赖上运行本地构建、单元测试、集成测试和静态依赖图检查。
- 使用 fake spawn、fake SDK source、注入 verifier 和内存 port 验证顺序及拒绝语义。
- 离线反向/正向重放 vendored bridge 补丁并复算 tree 与 strict manifest。

当前不能据此宣称：

- SQLite 持久账本、重启/lease 恢复或外部动作审批已实现。
- 真实飞书、真实 Codex、真实签名、UDS、macOS sandbox 或网络阻断已通过。
- LaunchAgent、部署、24 小时值守或生产可用性已通过。

上述缺少真实 fixture 的项目统一保持 `UNVERIFIED_NO_FIXTURE`。Stage A 的最高状态 `STAGE_A_SEAMS_VERIFIED` 只是一项开发门禁。

## 安装与全量质量门

在仓库根目录执行：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm format:check
corepack pnpm lint
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
git diff --check
```

所有命令必须退出 0，安全测试不得出现 skip、todo 或 only。

聚焦检查：

```bash
corepack pnpm --filter @executive-assistant/bridge test
corepack pnpm --filter @executive-assistant/bridge typecheck
corepack pnpm exec vitest run tests/integration/bridge-boundary.test.ts
corepack pnpm exec vitest run tests/security/bridge-dependency-boundary.test.ts tests/security/codex-tool-network.test.ts
corepack pnpm exec vitest run tests/contracts/vendor-provenance.test.ts tests/contracts/vendor-manifest.test.ts tests/contracts/vendor-replay.test.ts
```

## 如何阅读 Stage A seam

按下列方向阅读，不要从 legacy 文件反推受支持运行路径：

1. `packages/bridge/src/security/policy.ts` 与 `ingress-guard.ts`：Task 4 的身份、私聊和事件门禁。
2. `packages/bridge/src/runtime/assistant-channel.ts`：TaskSink、ACK、scheduler、取消、配对和卡片的顺序。
3. `packages/bridge/src/bot/channel.ts`：SDK 投影和仅 message/card/lifecycle 的窄 adapter；可信卡片 action 的 canonical JSON SHA-256 必须与验签 evidence 绑定后才能进入 confirmation sink。
4. `packages/bridge/src/agent/codex-runner.ts` 与 `security/workspace.ts`：固定 Codex invocation、最小环境、证据和路径边界。
5. `tests/integration` 与 `tests/security`：组合后的开发门禁和旧旁路不可达证据。AST 门禁对 symlink、动态 loader、全局网络别名、动态代码、非精确 process 使用、显式 raw transport、任何字面量 `get` member/binding/assignment，以及所有非字面量 element access 保守拒绝。属性访问键只接受数字、字符串或无替换模板字面量，不折叠表达式，也没有 primitive、赋值或固定路径例外；嵌套赋值模式会追踪至真实赋值边界。另一项独立 AST 断言要求四个受支持入口只出现字面量下标。以上仍属于静态证据，不等于跨函数、任意 helper/library 传播或任意深度 JavaScript 数据流证明。

正常任务的局部顺序必须保持：

```text
SDK projection -> ingress guard -> TaskSink.ingest -> fixed ACK -> scheduler.wake
```

deny、pairing、card、cancel、duplicate 或任一步失败都必须在各自停点结束，不能隐式启动 Codex 或直接写飞书。

## 离线 vendor 重放

```bash
./scripts/vendor-bridge --offline-replay
```

离线模式会在任何 clone 或联网动作前选择本地路径；脚本 shebang 使用 `/bin/zsh -f`，禁止先读取用户级 zsh 启动文件。入口 Node、Git 与 tar 只从固定系统候选路径解析，入口 Node 由 `/usr/bin/env -i` 启动，后续 Node/Git/tar 子进程也只获得从零构造的固定 PATH/locale/tmp/home 最小环境。Git 另禁用系统/全局配置，并强制 `GIT_CONFIG_COUNT=0`、`GIT_ALLOW_PROTOCOL=file`。随后执行以下校验：

1. 当前 `packages/bridge` 与 lock 中 final tree/strict manifest 完全一致。
2. lock 中补丁列表与磁盘按词法排序的补丁集合、顺序和 SHA-256 完全一致。
3. 在临时 Git 工作树中按反序应用全部补丁，精确恢复锁定的原始 tree。
4. 再按正序应用全部补丁，精确恢复锁定的 final tree。
5. 导出临时 final tree，并与当前 target 做严格 manifest 比较。

任何 target 缺失、symlink、漂移或补丁漂移都以退出码 73 fail closed。离线模式不得写入 target 或 `LICENSES`；hostile `ZDOTDIR/.zshenv`、`NODE_OPTIONS`、PATH shim、fsmonitor、外部 index/config/hook 等环境注入必须由回归测试证明无法生效。无参数执行 `./scripts/vendor-bridge` 才是显式的在线来源刷新路径。

## 新增或修改 vendor patch

每个逻辑任务使用独立 patch，不能直接留下无法重放的 vendored 源码差异：

1. 从锁定 upstream commit 和前序补丁状态创建临时 Git 工作树。
2. 只复制本任务明确允许的路径，生成 full-index binary patch。
3. 在 `packages/bridge/PATCHES.md` 记录目的、精确路径、运行时影响和验证边界。
4. 反向应用本 patch，确认回到前一阶段 tree；反向全部补丁，确认回到 upstream tree。
5. 正向应用全部补丁，确认回到当前 final tree。
6. 复算 patch SHA-256、patched tree、strict manifest、脚本和许可证摘要，更新 `dependencies.lock.json`。
7. 运行 provenance、manifest、offline replay、bridge 和全仓质量门。

不得自动升级 tag/commit、扩大 patch allowlist 或覆盖不一致的 target。

## 证据记录与停点

- 测试报告必须区分 `STATIC_OR_FAKE_ONLY` 与真实运行证据。
- 会生成 tsup 临时文件的 package/bin 构建测试必须使用临时隔离 workspace，不得与 provenance/replay 并行写真实 `packages/bridge`。
- 不得在报告中保存 Secret、Token、完整人员 ID、客户正文、原始 SDK error 或机器私有绝对路径。
- Stage B 开始持久账本和动作审批前，应从干净 Stage A HEAD 重新运行本页全部门禁。
- 目标 Mac 的真实 Codex/飞书/签名/UDS/sandbox/网络阻断验收属于后续真实租户计划；在 fixture 到位前停在 `UNVERIFIED_NO_FIXTURE`。
- commit、push、PR、merge、deploy、release 与真实飞书写操作分别等待明确授权。

## 公开发布停点

- 当前开发历史包含开发机路径和非 GitHub noreply 作者邮箱，禁止把现有 feature 分支的完整历史直接推到公开仓库。
- 公开 `main` 必须从最终已验证树创建净化后的 squash 或全新根提交，并使用当前 GitHub 账号的 noreply 邮箱；不得改写或删除现有本地开发历史。
- 净化快照必须重新运行全量质量门、`gitleaks 8.30.1` 历史与工作树扫描、机器私有路径检索，并在 GitHub 首次 CI 通过后才能创建 `v0.1.0-rc.1` pre-release。
- 创建远端、推送净化 `main`、启用私密漏洞报告、打 Tag 和发布 GitHub Release 仍是相互独立的授权动作。
- GitHub 源码发布不等于目标 Mac mini、真实飞书租户或连续 24 小时生产验收。
