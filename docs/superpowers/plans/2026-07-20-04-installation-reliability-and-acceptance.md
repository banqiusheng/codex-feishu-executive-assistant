# 一站式安装、24H 运维与真实验收 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把前三阶段的组件包装成一个可恢复、可诊断、可卸载的 Mac mini 安装流程，并以真实飞书资源、真实 PPT 客户端和连续 24 小时证据完成交付验收。

**Architecture:** `ops-cli` 驱动只读 preflight、阶段化安装、配置、doctor 和本机服务操作；三个用户级 LaunchAgent 分别托管 gateway、bridge 和 watchdog。`acceptance` 包只负责 fixture、故障演练、真实租户证据清单和 soak 判定，不把模拟测试升级为生产 PASS。

**Tech Stack:** macOS 14+、Node.js 20/22/24/26 偶数主版本、pnpm、TypeScript、Vitest、launchd/plutil/launchctl、macOS Keychain、Codex CLI 0.142.0 兼容基线、`@larksuite/cli` 1.0.72、`visual-first-ppt` v0.3.0。

## Global Constraints

- 当前 `codex-feishu-executive-assistant/` 只是父仓库 `New project` 中的未跟踪目录；实施前必须取得用户授权并建立独立 repo/clone。未完成时为 `BLOCKED_REPO_BOUNDARY`。
- OAuth 存储固定采用用户于 2026-07-21 确认的 `SECRET_STORAGE_PROFILE=KEYCHAIN_BACKED_ENCRYPTED_STORE`；证据不符时为 `BLOCKED_SECRET_STORAGE`，不得自动降级或切换方案。
- preflight 与 doctor 只读，不修改睡眠、FileVault、网络、TCC、Apple ID、备份或系统升级。
- 安装不运行上游 bridge 默认 wizard，不生成 `secrets.enc`，不跟随 npm/git latest。
- Codex CLI 不自动升级；0.142.0 只是已验证基线，安装时必须做参数与功能探针。
- launchd 使用用户级服务，不以 root 运行 Codex；FileVault 重启后仍需本人登录一次。
- 三个服务启动顺序为 gateway ready → bridge WebSocket ready → watchdog active。
- 真实写操作必须使用已同意的测试对象并逐项确认；`smoke-test --plan` 永远零外部调用。
- 模拟、doctor、dry-run、API success 和客户端可见证据是不同门禁。
- 24H 只在主机供电、保持唤醒、联网、用户登录和外部服务可用前提下衡量。
- uninstall 默认保留 Keychain、OAuth、jobs、outputs 和 ppt-projects；撤销秘密或删除资料必须分别确认。
- commit、push、PR、merge、安装到目标 Mac、真实飞书写入和发布版本分别需要明确授权。

---

## Execution Prerequisites

开始 Task 1 前必须同时满足：

1. 用户确认将本目录建立为独立 Git 仓库或提供已创建远端仓库地址。
2. 使用 `superpowers:using-git-worktrees` 建立隔离 worktree 和 `codex/feishu-assistant-foundation` feature branch。
3. 设计规格和四份计划完成审阅。
4. `SECRET_STORAGE_PROFILE` 已固定为 `KEYCHAIN_BACKED_ENCRYPTED_STORE`。

任何一项缺失都只能继续文档审阅，不能进入实现、commit、目标机安装或真实 API 写入。真实飞书 fixture 的数据所有者许可是 Task 6 的额外前置门禁，不阻塞此前的本地实现和模拟测试。

### Task 1: 建立 ops-cli、安装状态与只读 preflight

**Files:**
- Create: `packages/ops-cli/package.json`
- Create: `packages/ops-cli/tsconfig.json`
- Create: `packages/ops-cli/src/status.ts`
- Create: `packages/ops-cli/src/command-runner.ts`
- Create: `packages/ops-cli/src/preflight.ts`
- Create: `packages/ops-cli/src/install-state.ts`
- Create: `packages/ops-cli/src/cli.ts`
- Create: `packages/ops-cli/src/index.ts`
- Create: `scripts/preflight`
- Test: `packages/ops-cli/test/preflight.test.ts`
- Test: `packages/ops-cli/test/install-state.test.ts`
- Create: `tests/fixtures/host/pmset-ready.txt`
- Create: `tests/fixtures/host/pmset-sleeping.txt`

**Interfaces:**
- Produces: `collectPreflight(deps): Promise<PreflightReport>`。
- Produces: `InstallStateStore.read/writeTransition` with atomic `0600` JSON。
- Consumes: read-only command allowlist and no secret values。

- [ ] **Step 1: 写只读与状态映射红测**

```ts
it("never invokes a mutating host command", async () => {
  const runner = recordingRunner(hostReadyFixtures());
  await collectPreflight({ runner, paths: testPaths });
  expect(runner.commands.every(isReadOnlyPreflightCommand)).toBe(true);
  expect(runner.commands.join(" ")).not.toMatch(/pmset\s+(-a|-b|-c|sleepnow)|fdesetup\s+(disable|enable)|launchctl\s+(bootstrap|bootout)/);
});

it("blocks a host that will sleep on AC power", async () => {
  const report = await collectPreflight({ runner: fixtureRunner("pmset-sleeping.txt"), paths: testPaths });
  expect(report.overall).toBe("BLOCKED_HOST_READINESS");
});
```

- [ ] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/ops-cli test -- preflight install-state
```

Expected: FAIL because ops-cli is absent。

- [ ] **Step 3: 实现显式命令 allowlist**

```ts
export type VerifiedPreflightPaths = Readonly<{
  installParent: string;
  codexExecutable: string;
  nodeExecutable: string;
  corepackExecutable: string;
  installedHelper?: string;
}>;

export function buildPreflightCommands(paths: VerifiedPreflightPaths): readonly (readonly string[])[] {
  return [
    ["/usr/bin/sw_vers", "-productVersion"],
    ["/usr/bin/uname", "-m"],
    ["/usr/bin/fdesetup", "status"],
    ["/usr/bin/pmset", "-g", "custom"],
    ["/usr/bin/stat", "-f", "%Su", "/dev/console"],
    ["/bin/df", "-Pk", paths.installParent],
    ...(paths.installedHelper ? [["/usr/bin/codesign", "--verify", "--strict", paths.installedHelper]] : []),
    [paths.nodeExecutable, "--version"],
    [paths.corepackExecutable, "--version"],
    [paths.codexExecutable, "--version"],
  ];
}
```

`installParent`、`nodeExecutable`、`corepackExecutable`、`codexExecutable` 和可选的 `installedHelper` 都必须先由 console user、安装 manifest 与 realpath 边界解析为绝对路径；helper 不存在代表全新安装，不能伪造路径执行。runner 只接受上述结构与绝对 executable，不通过 shell，也不把 `~`、变量或占位字符串传给子进程。

- [ ] **Step 4: 实现 preflight 判定**

FileVault 未开启、AC sleep 非 0、console user 未登录、空间小于 10 GiB → `BLOCKED_HOST_READINESS`；Codex binary 不兼容、Node 不在 lock 的 20/22/24/26 偶数主版本范围、依赖/网络不可用 → `FAILED_DEPENDENCY`；专用 Codex 登录在 Task 3 单独处理。既有安装签名、hash、DB 或 plist 不可信 → `BLOCKED_RUNTIME_STATE`。报告保留命令 exit、脱敏摘要和时间，不含 home 以外路径正文或秘密。

- [ ] **Step 5: 实现原子安装状态**

允许阶段固定为：

```ts
export const INSTALL_PHASES = [
  "PREFLIGHT_PASSED", "DEPENDENCIES_VERIFIED", "RUNTIME_CREATED",
  "CODEX_AUTH_PENDING", "CODEX_AUTH_VERIFIED", "BOT_SECRET_STORED", "CONFIG_WRITTEN", "PAIRING_PENDING", "PAIRED",
  "JOB_STORE_READY", "USER_AUTH_PENDING", "USER_AUTH_VERIFIED",
  "LAUNCHD_REGISTERED", "DOCTOR_PASSED", "SMOKE_PENDING", "SETUP_VERIFIED",
] as const;
```

每次 transition 写 temp、`fsync`、rename；状态文件只存阶段、版本、hash 和错误码，不存 Secret、Token、配对码或聊天正文。

- [ ] **Step 6: 运行绿测并经授权提交**

```bash
corepack pnpm --filter @executive-assistant/ops-cli test -- preflight install-state
git add packages/ops-cli scripts/preflight tests/fixtures/host
git commit -m "feat(installer): add read-only host preflight"
```

### Task 2: 实现依赖锁校验、release 目录和可恢复安装器

**Files:**
- Create: `packages/ops-cli/src/lock-verifier.ts`
- Create: `packages/ops-cli/src/directory-layout.ts`
- Create: `packages/ops-cli/src/release-builder.ts`
- Create: `packages/ops-cli/src/installer.ts`
- Create: `scripts/install`
- Test: `packages/ops-cli/test/lock-verifier.test.ts`
- Test: `packages/ops-cli/test/installer.test.ts`
- Modify: `dependencies.lock.json`

**Interfaces:**
- Produces: `verifyDependencies(lock, artifacts): DependencyEvidence`。
- Produces: `install({resume,dryRun}): InstallReport`。
- Consumes: exact tag object/commit/tree/integrity fields。

- [ ] **Step 1: 写供应链和幂等红测**

```ts
it("rejects a tag object that peels to another commit", async () => {
  const lock = validLock({ visualFirstPpt: { tagObjectSha: PPT_TAG, commitSha: "bad" } });
  await expect(verifyDependencies(lock, fixtures)).rejects.toThrow(/dependency_hash_mismatch/);
});

it("resumes without overwriting completed phases", async () => {
  const first = await installer.run({ failAfter: "CONFIG_WRITTEN" });
  const second = await installer.run({ resume: true });
  expect(second.reused).toEqual(expect.arrayContaining(["BOT_SECRET_STORED", "CONFIG_WRITTEN"]));
  expect(secretStore.writeCount).toBe(1);
});
```

- [ ] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/ops-cli test -- lock-verifier installer
```

Expected: FAIL because verifier and installer are absent。

- [ ] **Step 3: 完整锁定直接依赖**

`dependencies.lock.json` 固定保存下列已核验值：

- bridge `v0.1.34`：tag object `fcc8b1f4cb6ef45ba598cda2f057bb2798e479a1`、commit `e8b0dc0cdfe2fb378bef7081618138a20d934aa9`、tree `9abc1413bf4f44ab048985cbbcebe1e4fc099d8f`、npm integrity `sha512-+4GztTJXLmqPOsmyd4IFSKkYqpw46QeHiAjtlLH9FANn5+HdcoobCZWSlFfRj306aQUk5xn4AWT8em9v2Krhjg==`。
- lark-cli `1.0.72`：npm integrity `sha512-BgK1hmLLMuJNM/Jx5vBQF7pgxwSzREyvQYV2WkkDlBw7fKyJbEZ/baMKq2YZnMFTm+yfmTNEYCsHOf1k2P9S4w==`；Darwin arm64 archive SHA-256 `b27942b83e8821934ebd34fbb02e0b00bbca949255866b5010795d625442eae2`；Darwin amd64 archive SHA-256 `b5dd56d64f9cc1cb7bab80b8eb1dda3c34e76f2a751115a897d0261985b82745`。
- visual-first-ppt `v0.3.0`：tag object `4962eb9bd5c55e8384b5228993c241b2220fcabb`、peeled commit `bb775f68f951c3e444d00623bc88976b20c13e7d`、tree `5ad18d178e8191105dcc68717e4639d3a68f0c73`。

Node 记录实际打包 runtime 的完整版本、架构与 archive SHA-256；Codex 记录最低兼容版 `0.142.0` 和通过的 argv、login、sandbox/network feature probes。所有运行依赖由 lock 解析，不调用 latest；任一已列值漂移都必须先重新审阅并显式更新 lock。

- [ ] **Step 4: 创建运行目录与 immutable release**

```text
~/PresidentAssistant/
  AGENTS.md
  inbox/
  jobs/
  outputs/
  ppt-projects/
  runtime/
    codex-home/
      config.toml
      skills/
    releases/0.1.0/
      public-bin/assistant-gateway
      private-bin/assistant-gateway-control
      private-bin/assistant-keychain-helper
      private-bin/lark-cli
    current -> releases/0.1.0
    config/
    db/
    control/
    install/state.json
    heartbeat/
  logs/
```

除无秘密 plist 可为 `0644`、已签名可执行文件可为 `0500` 外，根及子目录 `0700`、数据文件 `0600`、umask `077`。public-bin 只能包含无密钥 run client；control client、Keychain helper 和 lark-cli 固定在 private-bin，均不加入 Codex PATH。`current` symlink 只由 installer 原子切换到已 hash 验证的完整 release；所有消费者先 realpath 再检查仍在 releases root。

- [ ] **Step 5: 实现 dry-run 与 resume**

`scripts/install --dry-run` 只输出阶段、人工动作和写入路径，external_calls=0。真实安装每完成一个阶段才写状态；失败时只撤回本轮新注册服务，不删除旧 release、客户数据、DB、Keychain 或 OAuth。

- [ ] **Step 6: 运行绿测并经授权提交**

```bash
corepack pnpm --filter @executive-assistant/ops-cli test -- lock-verifier installer
./scripts/install --dry-run
git add packages/ops-cli scripts/install dependencies.lock.json
git commit -m "feat(installer): add locked resumable installation"
```

### Task 3: 实现专用 Codex 登录、App 前置验证、Bot Secret、配对和用户 OAuth

**Files:**
- Create: `packages/ops-cli/src/configure.ts`
- Create: `packages/ops-cli/src/app-preconditions.ts`
- Create: `packages/ops-cli/src/codex-auth.ts`
- Create: `packages/ops-cli/src/oauth.ts`
- Create: `packages/ops-cli/src/secret-storage-audit.ts`
- Create: `packages/ops-cli/native/keychain-configurator/main.swift`
- Create: `packages/ops-cli/native/keychain-configurator/AccessControl.swift`
- Create: `packages/ops-cli/native/keychain-configurator/build.sh`
- Create: `scripts/configure`
- Test: `packages/ops-cli/test/configure.test.ts`
- Test: `packages/ops-cli/test/codex-auth.test.ts`
- Test: `packages/ops-cli/test/oauth.test.ts`
- Test: `packages/ops-cli/test/keychain-acl.test.ts`
- Create: `config/policy.example.yaml`
- Create: `config/policy.schema.json`

**Interfaces:**
- Produces: `verifyAppPreconditions()` with publish/scope/visibility/event states。
- Produces: `initializeDedicatedCodexHome()` and `verifyDedicatedCodexLogin()`。
- Produces: `storeBotSecretFromTTY(appId)` through a separate signed configurator；运行时 SecretRef helper 保持只读。
- Produces: `startUserOAuth(scopes)` and `verifyUserOAuth()`。
- Consumes: fixed `SECRET_STORAGE_PROFILE=KEYCHAIN_BACKED_ENCRYPTED_STORE`。

- [ ] **Step 1: 写“不能假装管理员”和秘密通道红测**

```ts
it("reports unpublished permissions without trying to publish", async () => {
  const report = await verifyAppPreconditions(fakeApp({ published: false }));
  expect(report.status).toBe("BLOCKED_APP_PUBLISH");
  expect(fakeApp.mutations).toBe(0);
});

it("never places App Secret in argv env log or state", async () => {
  await configureWithSecret("super-secret-value");
  expect(allCapturedText()).not.toContain("super-secret-value");
});
```

- [ ] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/ops-cli test -- configure codex-auth oauth
```

Expected: FAIL because configuration workflow is absent。

- [ ] **Step 3: 初始化专用 CODEX_HOME 并完成一次登录**

创建 `~/PresidentAssistant/runtime/codex-home` 为 `0700`，其 config 只含本项目明确允许的模型/runtime 设置，不复制默认 `~/.codex` 的 config、auth、skills、MCP 或 plugin。以该 `CODEX_HOME` 运行锁定 Codex binary 的 `login status`；未登录时在 attached TTY 启动官方 `codex login` 浏览器流程，完成后再次验证。把仓库内 `executive-assistant` Skill 按 source hash 安装到专用 skills 目录；同名目标已存在但来源/hash 不符时停止并报告 `BLOCKED_RUNTIME_STATE`，不覆盖。登录凭据和 auth 文件不进入 installer 日志、state、release artifact 或 Git。

安装器还必须运行 Stage B Task 9 的 production Codex-home verifier：绑定锁定 binary/hash，核验专用 home、task workspace/project、系统与可见 managed 配置层不存在 legacy sandbox 覆盖，并用最终 `assistant-task` profile 在实际配置栈下复跑 task A socket only 的 UDS/TCP/HTTP 矩阵。只有 verifier 产生可重验的 `permissionProfileCompatible=true` evidence，LaunchAgent 才能启动；常量 true、mock evidence、clean-home fixture 或配置层不可解释一律进入 `BLOCKED_RUNTIME_STATE`。

- [ ] **Step 4: 实现安全 Bot Secret 输入**

只从 attached TTY 无回显读取，通过 stdin pipe 交给独立签名的 `assistant-keychain-configurator`；不得调用会把值放进 argv 的 `security add-generic-password -w ...`。configurator 校验其父进程、安装 manifest、只读 SecretRef helper 的绝对路径/签名/hash，并用 Security.framework 创建或更新 service=`com.codex-feishu-executive-assistant.bot`、account=App ID 的 Generic Password；item ACL 只信任已安装的只读 helper。实现使用可控的 `Data` buffer，并在 Security.framework 调用完成后通过 mutable bytes 清零该 buffer、关闭 pipe，且不声称能清除系统库内部不可控副本。Secret 不进入 argv/env/state；config 只保存 exec SecretRef provider 的固定绝对路径、签名 requirement 和 SHA。测试必须证明 configurator 不能读取 secret、read helper 不能写 secret、未列入 ACL 的测试程序不能静默读取，而 LaunchAgent 等价环境中的已签名 helper 可以静默读取。

- [ ] **Step 5: 实现一次性配对编排**

本地 TTY 显示随机码；bridge 的 pairing route 只消费 p2p 纯码消息，不入 task、不下载附件、不启动 Codex。成功后原子写入唯一 president open_id/chat_id 并关闭 pairing；过期、5 次失败、并发第二人和重放均拒绝。

- [ ] **Step 6: 实现最小 scope OAuth**

从 `feishu-scopes.yaml` 生成精确 scope 字符串，调用锁定 lark-cli 的 `auth login --scope SCOPES --no-wait` 并展示二维码/URL，再轮询 device code；不使用 `--recommend`。完成后运行 `auth status --json --verify` 和 `auth check --scope SCOPES --json`。

- [ ] **Step 7: 按所选 secret profile 验收**

固定档位要求：`.enc` 为 `0600`、父目录 `0700`、Keychain 中存在 `master.key`、`master.key.file` 不存在；安装器中不存在 `config keychain-downgrade` 调用；同 ACL 专用 canary 在生产 Codex sandbox 的 `/usr/bin/security`、Security.framework 和 raw lark-cli 三条越界探针全部失败；证据绑定已安装 Codex binary hash，版本或 hash 变化后必须重验。任一不符 → `BLOCKED_SECRET_STORAGE`，且不得回退到文件主密钥、strict fork 或其他存储方案。

- [ ] **Step 8: 运行绿测并经授权提交**

```bash
corepack pnpm --filter @executive-assistant/ops-cli test -- configure codex-auth oauth
git add packages/ops-cli scripts/configure config
git commit -m "feat(configure): bind Codex app pairing and user auth"
```

### Task 4: 生成并托管 gateway、bridge 和 watchdog LaunchAgents

**Files:**
- Create: `packages/ops-cli/src/launchd/plist.ts`
- Create: `packages/ops-cli/src/launchd/launchctl.ts`
- Create: `packages/ops-cli/src/launchd/watchdog.ts`
- Create: `packages/ops-cli/src/launchd/heartbeat.ts`
- Create: `launchd/com.codex-feishu-executive-assistant.gateway.plist.template`
- Create: `launchd/com.codex-feishu-executive-assistant.bridge.plist.template`
- Create: `launchd/com.codex-feishu-executive-assistant.watchdog.plist.template`
- Create: `tests/fixtures/launchd/com.codex-feishu-executive-assistant.gateway.plist`
- Create: `tests/fixtures/launchd/com.codex-feishu-executive-assistant.bridge.plist`
- Create: `tests/fixtures/launchd/com.codex-feishu-executive-assistant.watchdog.plist`
- Test: `packages/ops-cli/test/plist.test.ts`
- Test: `packages/ops-cli/test/watchdog.test.ts`
- Create: `scripts/status`
- Create: `scripts/restart`

**Interfaces:**
- Produces: `renderPlists(absoluteConfig): PlistSet`。
- Produces: `Watchdog.evaluate(samples): healthy | restart`。
- Consumes: absolute release paths, fixed environment and service labels。

- [ ] **Step 1: 写 plist 与 watchdog 红测**

```ts
it("renders shell-free absolute ProgramArguments", () => {
  const plists = renderPlists(validLaunchdConfig());
  for (const plist of plists) {
    expect(plist.ProgramArguments.every((arg) => !arg.includes("$HOME") && !arg.includes("~"))).toBe(true);
    expect(plist.ProgramArguments[0]?.startsWith("/")).toBe(true);
    expect(plist.ThrottleInterval).toBe(10);
  }
});

it("restarts only after two consecutive failed 30-second probes", () => {
  expect(evaluateWatchdog([healthy(), failed()])).toBe("healthy");
  expect(evaluateWatchdog([failed(), failed()])).toBe("restart");
});
```

- [ ] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/ops-cli test -- plist watchdog
```

Expected: FAIL because launchd support is absent。

- [ ] **Step 3: 固化 plist 字段**

gateway/bridge：`RunAtLoad=true`、`KeepAlive=true`、`ThrottleInterval=10`、`Umask=63`；watchdog：`StartInterval=30`、`ThrottleInterval=10`。三者均固定 `WorkingDirectory`、`CODEX_HOME`、workspace root、最小 PATH、stdout/stderr 路径和绝对 ProgramArguments，不捕获当前 shell env。

- [ ] **Step 4: 实现本机 service 操作**

`launchctl bootstrap/bootout/kickstart/print` 通过 `spawn` 参数数组调用，label 和 plist path 来自常量/verified release。restart 顺序为 gateway ready 后启动 bridge，再启动 watchdog；远程飞书不开放这些命令。

- [ ] **Step 5: 实现失活恢复**

watchdog 只读 heartbeat、PID/instance 和 local readiness；连续两次失败后先验证 PID 属于目标 label，发送 SIGTERM，10 秒后同一 PID 仍存活才 SIGKILL，由 launchd 拉起。不得按模糊进程名 kill。

- [ ] **Step 6: 静态与动态绿测**

Run:

```bash
corepack pnpm --filter @executive-assistant/ops-cli test -- plist watchdog
plutil -lint tests/fixtures/launchd/*.plist
```

Expected: unit tests PASS；测试先证明三个 fixture 是模板加完整测试配置的精确渲染结果，`plutil` 再对三个可加载 plist 返回 `OK`。模板本身不得直接交给 `plutil` 冒充可加载配置。

- [ ] **Step 7: 经授权后提交 Task 4**

```bash
git add packages/ops-cli launchd tests/fixtures/launchd scripts/status scripts/restart
git commit -m "feat(macos): add hardened launchd supervision"
```

### Task 5: 实现只读 doctor、状态和日志轮转

**Files:**
- Create: `packages/ops-cli/src/doctor.ts`
- Create: `packages/ops-cli/src/status-report.ts`
- Create: `packages/ops-cli/src/log-rotation.ts`
- Create: `scripts/doctor`
- Create: `scripts/log-rotate`
- Test: `packages/ops-cli/test/doctor.test.ts`
- Test: `packages/ops-cli/test/log-rotation.test.ts`

**Interfaces:**
- Produces: `runDoctor(): DoctorReport` with capability-level status。
- Produces: `rotateLogs()` that causes writers to reopen file descriptors。

- [ ] **Step 1: 写状态分层红测**

```ts
it("does not call a loaded service healthy", async () => {
  const report = await runDoctor(fixture({ launchdLoaded: true, processAlive: true, heartbeatFresh: false, websocketReady: false }));
  expect(report.overall).not.toBe("PASS");
  expect(report.checks).toMatchObject({ launchdLoaded: true, processAlive: true, heartbeatHealthy: false, websocketReady: false });
});
```

- [ ] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/ops-cli test -- doctor log-rotation
```

Expected: FAIL because doctor is absent。

- [ ] **Step 3: 实现只读检查集**

检查：dependency/vendor hash、配置 schema、pairing、DB pre/post integrity、文件锁/lease、socket mode、helper 签名/hash、Bot Secret 静默读取、OAuth storage profile、Keychain canary attestation 对应的 Codex binary hash、`auth status/check`、Codex argv feature probe、tool network deny、workspace/symlink、LaunchAgent、heartbeat、WebSocket、磁盘、日志权限、visual-first-ppt installed target/doctor。每项独立输出 PASS/BLOCKED/FAILED，不做修复；Codex 版本/hash 漂移使 canary attestation 失效并停止接单，不能静默沿用旧结果。

- [ ] **Step 4: 实现安全轮转**

按 14 天保留日志；发送本地 reopen 信号或通过 control API 要求 logger `fsync → close → reopen`，确认新 inode 后才压缩/删除旧日志。附件缓存按 7 天清理，outputs 和 ppt-projects 永不自动清理。

- [ ] **Step 5: 运行绿测并经授权提交**

```bash
corepack pnpm --filter @executive-assistant/ops-cli test -- doctor log-rotation
./scripts/doctor --json
git add packages/ops-cli scripts/doctor scripts/log-rotate
git commit -m "feat(ops): add read-only diagnostics and rotation"
```

### Task 6: 建立真实租户 smoke-test 与证据清单

**Files:**
- Create: `packages/acceptance/package.json`
- Create: `packages/acceptance/tsconfig.json`
- Create: `packages/acceptance/src/fixture-schema.ts`
- Create: `packages/acceptance/src/evidence-manifest.ts`
- Create: `packages/acceptance/src/smoke-runner.ts`
- Create: `packages/acceptance/src/index.ts`
- Create: `packages/acceptance/test/fixture-schema.test.ts`
- Create: `packages/acceptance/test/evidence-manifest.test.ts`
- Create: `packages/acceptance/test/smoke-runner.test.ts`
- Create: `scripts/smoke-test`
- Create: `tests/fixtures/acceptance.example.json`
- Create: `docs/runbook/real-tenant-e2e.md`

**Interfaces:**
- Produces: `buildSmokePlan(fixtures): SmokePlan` with zero calls。
- Produces: `executeSmokeCase(caseId, confirmation): EvidenceRecord`。
- Consumes: test user、optional existing test group、real minute、calendar and target client confirmations。

- [ ] **Step 1: 写 plan mode 零副作用红测**

```ts
it("lists all cases without external calls", async () => {
  const harness = acceptanceHarness();
  const plan = await buildSmokePlan(validFixtures(), harness);
  expect(plan.caseIds).toEqual(expect.arrayContaining(["dm", "attachment", "contact", "minutes", "calendar", "bot_message", "ppt_create", "ppt_template", "ppt_edit"]));
  expect(harness.externalCalls).toBe(0);
});
```

- [ ] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/acceptance test -- fixture-schema evidence-manifest smoke-runner
```

Expected: FAIL because acceptance package is absent。

- [ ] **Step 3: 固化真实能力证据**

每个 case 记录：fixture consent、request/action/task IDs 的脱敏值、时间、API response digest、客户端截图路径/确认人、预期与实际、外部影响、cleanup 状态。缺 fixture → `UNVERIFIED_NO_FIXTURE`；scope、visibility、resource 权限、OAuth、依赖分别映射既有状态，不能 SKIP→PASS。

- [ ] **Step 4: 实现逐案例确认**

`smoke-test --plan` 零调用；`--case calendar-create --confirm ACTION_ID` 只执行一个已预览案例。创建日程后必须在测试参与人客户端确认，再单独执行 update 和 cancel；通知测试用户/群同样需接收人确认。不得测试广播或新建群。

- [ ] **Step 5: 运行绿测并经授权提交**

```bash
corepack pnpm --filter @executive-assistant/acceptance test
./scripts/smoke-test --plan --fixtures tests/fixtures/acceptance.example.json
git add packages/acceptance scripts/smoke-test tests/fixtures/acceptance.example.json docs/runbook/real-tenant-e2e.md
git commit -m "test(e2e): add real-tenant acceptance framework"
```

### Task 7: 验证生产环境中的 visual-first-ppt 三条路线

**Files:**
- Create: `packages/acceptance/src/ppt-production.ts`
- Create: `packages/acceptance/test/ppt-production.test.ts`
- Create: `docs/runbook/ppt-production-acceptance.md`
- Modify: `scripts/smoke-test`

**Interfaces:**
- Produces: `PptProductionEvidence` for setup、activation、create、template、edit、client-open。
- Consumes: production LaunchAgent、dedicated production `~/PresidentAssistant/runtime/codex-home`、workspace、Presentations、imagegen and visual-first-ppt state files。

- [ ] **Step 1: 写“doctor 不等于 production”红测**

```ts
it("requires activation and all route evidence beyond doctor", () => {
  const evidence = pptEvidence({ doctor: "PASS", activation: "UNVERIFIED", create: null, template: null, edit: null });
  expect(evaluatePptSetup(evidence)).toBe("BLOCKED_CAPABILITY");
});
```

- [ ] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/acceptance test -- ppt-production
```

Expected: FAIL because PPT production evidence is absent。

- [ ] **Step 3: 验证固定安装目标**

从 lock 校验 tag object、peeled commit 和 tree；若 `CODEX_HOME/skills/visual-first-ppt` 已存在则不覆盖，先核对来源。运行该已安装目标自己的 doctor；doctor WARN/FAIL 不得升级为 setup verified。

- [ ] **Step 4: 从真实飞书新任务激活**

安装 turn 到此结束。总裁从飞书发送新消息并建立全新 Codex session，显式调用 `$visual-first-ppt`；生产 LaunchAgent、CODEX_HOME、sandbox、网络和 workspace 必须与日常运行完全相同。不得从 installer 嵌套启动 Codex。

- [ ] **Step 5: 交互完成 create/template/edit**

每条路线遵守 visual-first-ppt 的首轮 route contract、outline/scope、visual/change preview、QA、final approval 和 delivered 门禁。默认回传 preview/PPTX/PDF；ZIP、manifest、production record 和 QA 留在持久项目目录。edit 必须保存源文件并以 PNG/XML 证明未授权页面未变。

- [ ] **Step 6: 目标客户端验收**

在目标 PowerPoint 或 WPS 打开 PPTX，记录 passed/failed；PPTX/PDF/preview 页数和可见内容一致，每页四维评分至少 4/5，硬零 QA 项全部为 0。缺真实客户端确认时保持 `BLOCKED_CAPABILITY`。

- [ ] **Step 7: 运行自动门并经授权提交**

```bash
corepack pnpm --filter @executive-assistant/acceptance test -- ppt-production
git add packages/acceptance docs/runbook/ppt-production-acceptance.md scripts/smoke-test
git commit -m "test(ppt): require production-route evidence"
```

### Task 8: 实现故障演练和连续 24 小时 soak 判定

**Files:**
- Create: `packages/acceptance/src/recovery-runner.ts`
- Create: `packages/acceptance/src/soak-recorder.ts`
- Create: `packages/acceptance/src/soak-analyzer.ts`
- Create: `packages/acceptance/test/recovery-runner.test.ts`
- Create: `packages/acceptance/test/soak-recorder.test.ts`
- Create: `packages/acceptance/test/soak-analyzer.test.ts`
- Create: `scripts/recovery-test`
- Create: `scripts/soak-test`
- Create: `docs/runbook/24h-soak-and-recovery.md`

**Interfaces:**
- Produces: `RecoveryEvidence` and `SoakVerdict`。
- Consumes: heartbeat/WS/process/task/action metrics only；不读取正文。

- [ ] **Step 1: 写 fake-clock 恢复与 24H 红测**

```ts
it("passes only a complete 24-hour evidence window", () => {
  const samples = makeSamples({ durationMs: 86_400_000, intervalMs: 30_000 });
  expect(analyzeSoak(samples).status).toBe("PASS");
  expect(analyzeSoak(samples.slice(0, -1)).status).not.toBe("PASS");
});

it("requires confirmation after every interrupted task", () => {
  expect(analyzeRecovery(interruptedWithoutConfirmation())).toMatchObject({ status: "FAILED", reason: "silent_resume" });
});
```

- [ ] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/acceptance test -- recovery-runner soak-recorder soak-analyzer
```

Expected: FAIL because recovery/soak code is absent。

- [ ] **Step 3: 实现故障矩阵**

覆盖 bridge 退出、gateway 退出、心跳停止但进程存活、断网恢复、Codex 30 分钟无事件、整机重启/人工登录、事件重放、运行中断、DISPATCHING 崩溃和 UNKNOWN 对账。脚本不得自行关闭网络或重启整机；这些由人操作，脚本只观察并记录。

- [ ] **Step 4: 固化 soak PASS 条件**

- 首末样本跨度至少 `86,400,000 ms`。
- 采样间隔 30 秒，相邻最大间隔不超过 90 秒。
- bridge/gateway 退出到 ready 不超过 60 秒。
- network_restored 到 WebSocket ready 不超过 120 秒。
- 无两个活跃消费者、重复 task 或重复 action。
- 所有非终态任务重启后要求确认，所有旧审批失效。
- DISPATCHING/UNKNOWN 只对账，不 dispatch；INDETERMINATE 明确列出。
- SQLite integrity、文件锁、lease、socket mode、Keychain/OAuth profile 和日志敏感扫描均正常。
- 主机前提失败 → `BLOCKED_HOST_READINESS`；外部依赖故障可记 `EXCLUDED_EXTERNAL`，但不能遮盖本地故障。

- [ ] **Step 5: 运行自动判定绿测**

```bash
corepack pnpm --filter @executive-assistant/acceptance test -- recovery-runner soak-recorder soak-analyzer
```

Expected: PASS with fake clock；不使用 24 小时 sleep 做单元测试。

- [ ] **Step 6: 经目标机授权后运行真实证据**

```bash
./scripts/recovery-test process-restart --confirm
./scripts/recovery-test heartbeat-stall --confirm
./scripts/recovery-test network-reconnect --observe-only
./scripts/soak-test start --duration 24h --interval 30s
./scripts/soak-test analyze --latest
```

Expected: recovery cases PASS；soak analyzer PASS。整机重启场景由人在窗口内执行并登录。

- [ ] **Step 7: 经授权后提交 Task 8**

```bash
git add packages/acceptance scripts/recovery-test scripts/soak-test docs/runbook/24h-soak-and-recovery.md
git commit -m "test(reliability): verify recovery and 24-hour service"
```

### Task 9: 实现安全卸载、干净环境验证和中文交付包

**Files:**
- Create: `packages/ops-cli/src/uninstall.ts`
- Create: `scripts/uninstall`
- Test: `packages/ops-cli/test/uninstall.test.ts`
- Create: `tests/integration/clean-install.test.ts`
- Create: `tests/integration/service-recovery.test.ts`
- Create: `BOOTSTRAP.md`
- Create: `docs/runbook/install.md`
- Create: `docs/runbook/uninstall.md`
- Create: `docs/acceptance/report-template.md`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: dry-run-first uninstall plan and separately confirmed cleanup actions。
- Produces: Chinese acceptance report with evidence links and independent gate states。

- [ ] **Step 1: 写 destructive-boundary 红测**

```ts
it("preserves secrets and customer data by default", async () => {
  const plan = buildUninstallPlan({ revokeOAuth: false, deleteSecrets: false, deleteCustomerData: false });
  expect(plan.remove).toEqual(expect.arrayContaining(["launchd-services", "installed-release"]));
  expect(plan.preserve).toEqual(expect.arrayContaining(["keychain", "oauth", "jobs", "outputs", "ppt-projects"]));
});

it.each(["/", "/Users/test", "~/PresidentAssistant", "../outside"])("rejects broad delete target %s", (path) => {
  expect(() => validateCleanupTarget(path)).toThrow();
});
```

- [ ] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/ops-cli test -- uninstall
corepack pnpm vitest run tests/integration/clean-install.test.ts tests/integration/service-recovery.test.ts
```

Expected: FAIL because uninstall and integration harness are absent。

- [ ] **Step 3: 实现安全卸载状态机**

默认只预览；首次确认只停止并移除本项目 LaunchAgents 和当前 release。撤销 OAuth/删除 Keychain 是第二个独立确认；删除客户 jobs/outputs/ppt-projects 是第三个独立确认，必须列出 resolved paths 和数量。不得接受 `/`、HOME、`~`、未解析变量、glob、symlink root 或 workspace root 作为递归删除目标。

- [ ] **Step 4: 干净环境集成验证**

测试使用 `EA_TEST_ROOT="$(mktemp -d)"` 和 fake Keychain/OAuth/Feishu；验证 first install、resume、重跑幂等、wrong user/chat/tenant、event replay、process recovery 和 uninstall preserve。开发 checkout 只用于测试实现，最终陌生用户验证必须从 release artifact 安装。

- [ ] **Step 5: 完成一页式中文入口**

README 只写客户交付者需要知道的入口；AGENTS 固定读取顺序、执行边界和门禁；BOOTSTRAP 按状态机解释三个人工动作。报告分别列：repo boundary、local automated、clean install、target Mac setup、real tenant E2E、PPT production、24H soak、final acceptance；不得用一个“完成”覆盖全部。

- [ ] **Step 6: 执行最终自动质量门**

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
git diff --check
```

Expected: all exit `0`；无 skipped security/recovery tests；diff 只包含项目范围。

- [ ] **Step 7: 经授权后提交阶段 D 收口**

```bash
git add packages/ops-cli scripts/uninstall tests/integration README.md AGENTS.md BOOTSTRAP.md CHANGELOG.md docs
git commit -m "docs: close install and acceptance workflow"
```

## Stage D Review Gate

Reviewer 必须分别核对：

- `REPO_BOUNDARY_VERIFIED`：独立 repo/clone 和 feature branch 事实。
- `LOCAL_AUTOMATED_PASS`：构建、类型、单元、集成和安全测试。
- `CLEAN_INSTALL_VERIFIED`：从 release artifact 的陌生用户安装。
- `TARGET_MAC_SETUP_VERIFIED`：Keychain/OAuth/launchd/Codex 生产环境。
- `REAL_TENANT_E2E_VERIFIED`：联系人、妙记、日历、通知和客户端证据。
- `PPT_PRODUCTION_VERIFIED`：doctor + 新 session activation + 三路线 + WPS/PowerPoint。
- `SOAK_24H_VERIFIED`：完整 24 小时和恢复指标。
- `FINAL_ACCEPTED`：总裁或交付负责人确认。

这些状态必须逐项保存；前一项通过不代表后一项通过。只有全部通过，才可以说“24H ON CALL 助理已交付”；push、PR、merge 和 release 仍需独立授权。
