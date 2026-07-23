# 仓库基础与加固 Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可重复构建的 TypeScript monorepo，vendor 固定版本的飞书 bridge，并在任何附件下载或 Codex 启动前落实 fail-closed 私聊入口和受限 Codex runner。

**Architecture:** `contracts` 提供跨包稳定协议；`bridge` 保留上游长连接与消息适配，但把鉴权、任务落库和系统回复改造成显式接口。所有非总裁私聊事件在边界层拒绝，Codex 仅在会话工作区内以 `workspace-write`、无工具网络和清洗环境运行。

**Tech Stack:** Node.js 20/22/24/26 偶数主版本、pnpm 10.0.0、TypeScript 5.6.3、Vitest 2.1.8、tsup 8.3.5、Zod 4.4.3、`@larksuiteoapi/node-sdk` 1.65.x、固定上游 bridge commit。

## 当前执行状态

独立仓库边界已解除，用户已授权 Codex 执行整个 Stage A 的本地实现与本地提交。Stage A / Tasks 1–7 的实现已完成，Task 7 为 `df5c392`，八轮审查修复依次为 `38cfb5c`、`8168bb1`、`b5e70f0`、`28f0940`、`88caebf`、`7e16ea1`、`7ef68fb`、`c210be4`。第七轮已从受支持入口消除全部运行时计算属性访问并删除分析器例外；其 22 个回归中 21 个先复现旧漏检，另一个可选调用用例锁定已有拒绝行为。`7ef68fb` 的两路独立复审又复现普通 `.get` alias/包装、嵌套赋值和表达式属性键缺口。第八轮已加入六个先红后绿回归，把属性访问键收紧为仅字面量、任何 `get` member/binding/assignment 保守拒绝，并追踪嵌套赋值至真实边界；修复已以 `c210be4` 本地提交，状态同步提交为 `1d74e03`。两路独立复审均明确 `APPROVED`，干净 HEAD 总门禁通过，因此 Stage A 本地开发 seam 标记为 `STAGE_A_SEAMS_VERIFIED`。该状态不等于生产 `PASS`。remote 配置/创建、push、PR、deploy 和真实飞书写操作仍须逐项另行授权，且均未执行。

## Global Constraints

- 上游固定为 `v0.1.34` / `e8b0dc0cdfe2fb378bef7081618138a20d934aa9`，不得跟踪 `main` 或 npm `latest`。
- 只允许 `im.message.receive_v1` 私聊消息和经签名验证的 `card.action.trigger`；其余事件永远不启动 Codex。
- 未配对时仅允许消费一次性配对码；任何普通内容都不得进入日志、附件下载、队列或 Codex。
- 配对后 `allowedUsers` 与 `allowedChats` 必须同时命中；空列表语义为拒绝全部。
- Codex argv 固定为全局参数先行：`codex --ask-for-approval never --sandbox workspace-write -c sandbox_workspace_write.network_access=false exec --strict-config --json --skip-git-repo-check -`。
- Codex 工具网络保持关闭；不得映射到 `danger-full-access`。
- 每个任务使用 `~/PresidentAssistant/jobs/<task-id>/` 作为工作区和独立 run socket 边界；禁止回退到 `$HOME`。
- 当前计划只建立接口和 bridge seam；持久账本、Keychain 与动作执行由第二份计划接入。
- 因本阶段只消费 `TaskSink` seam，阶段 A 的最高状态是 `STAGE_A_SEAMS_VERIFIED`；内存 fake 不能证明 SQLite durability、重启恢复、去重或租约，也不能标记生产 `PASS`。
- 用户已明确授权整个 Stage A 的本地实现与本地提交；不得据此推断 remote 配置/创建、push、PR、deploy 或真实飞书写操作授权，这些动作仍须逐项另行授权。

---

### Task 1: 建立可重复构建的 monorepo 骨架

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `eslint.config.js`
- Create: `.gitignore`
- Create: `.prettierignore`
- Create: `.npmrc`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/index.ts`
- Create: `tests/contracts/repository-layout.test.ts`

**Interfaces:**
- Produces: workspace scripts `format:check`, `lint`, `typecheck`, `test`, `build`。
- Produces: package name `@executive-assistant/contracts`。

- [x] **Step 1: 写入最小工具链文件**

```json
{
  "name": "codex-feishu-executive-assistant",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.0.0",
  "engines": { "node": ">=20.0.0 <21.0.0 || >=22.0.0 <23.0.0 || >=24.0.0 <25.0.0 || >=26.0.0 <27.0.0" },
  "scripts": {
    "build": "pnpm -r build",
    "format:check": "prettier --check .",
    "lint": "eslint . --max-warnings 0",
    "typecheck": "pnpm -r typecheck",
    "test": "vitest run --workspace vitest.workspace.ts"
  },
  "devDependencies": {
    "@eslint/js": "9.31.0",
    "@types/node": "22.10.0",
    "eslint": "9.31.0",
    "prettier": "3.6.2",
    "tsup": "8.3.5",
    "typescript": "5.6.3",
    "typescript-eslint": "8.38.0",
    "vitest": "2.1.8"
  }
}
```

```ts
// vitest.workspace.ts
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  { test: { name: "root", include: ["tests/**/*.test.ts"] } },
  { test: { name: "contracts", include: ["packages/contracts/test/**/*.test.ts"] } },
  { test: { name: "bridge", include: ["packages/bridge/test/**/*.test.ts"] } },
]);
```

```js
// eslint.config.js
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", ".superpowers/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
```

```yaml
packages:
  - "packages/*"
```

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true
  }
}
```

- [x] **Step 2: 写仓库结构红测**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pkg from "../../package.json";

describe("repository contract", () => {
  it("pins the package manager and supported even Node majors", () => {
    expect(pkg.packageManager).toBe("pnpm@10.0.0");
    expect(pkg.engines.node).toBe(">=20.0.0 <21.0.0 || >=22.0.0 <23.0.0 || >=24.0.0 <25.0.0 || >=26.0.0 <27.0.0");
  });

  it("exposes all quality gates", () => {
    expect(Object.keys(pkg.scripts).sort()).toEqual(
      ["build", "format:check", "lint", "test", "typecheck"].sort(),
    );
  });

  it("creates the locked contracts workspace package", () => {
    const contractsPkg = JSON.parse(readFileSync("packages/contracts/package.json", "utf8"));
    expect(contractsPkg.name).toBe("@executive-assistant/contracts");
    expect(contractsPkg.dependencies).toEqual({ zod: "4.4.3" });
  });
});
```

- [x] **Step 3: 安装依赖并验证红测可运行**

Run:

```bash
corepack pnpm install
corepack pnpm vitest run tests/contracts/repository-layout.test.ts
```

Expected: test runner starts and FAILS because `packages/contracts/package.json` is absent；这证明红测命中尚未实现的 workspace package，而不是语法或 runner 错误。

- [x] **Step 4: 完成 contracts package build 配置**

```json
{
  "name": "@executive-assistant/contracts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "zod": "4.4.3" }
}
```

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

```ts
export const CONTRACT_VERSION = 1 as const;
```

- [x] **Step 5: 运行基础质量门**

Run:

```bash
corepack pnpm format:check
corepack pnpm lint
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

Expected: all five commands exit `0`。

- [x] **Step 6: 经授权后提交 Task 1**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json vitest.workspace.ts eslint.config.js .gitignore .prettierignore .npmrc packages/contracts tests/contracts
git commit -m "chore: scaffold assistant monorepo"
```

已完成本地提交 `f93ab0a`；未配置 remote，未执行 push、PR、deploy 或真实飞书写操作。

### Task 2: 固化跨包事件、状态和网关合同

**Files:**
- Create: `packages/contracts/src/status.ts`
- Create: `packages/contracts/src/events.ts`
- Create: `packages/contracts/src/tasks.ts`
- Create: `packages/contracts/src/gateway.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/contracts.test.ts`

**Interfaces:**
- Produces: `InboundEventSchema`、`AssistantStatusSchema`、`TaskStateSchema`、`GatewayRequestSchema`。
- Produces: `TaskSink`、`TaskControlSink`、`RunGatewayClient`、`BridgeGatewayClient`、`Clock`。
- Consumes: no runtime services。

- [x] **Step 1: 写合同红测**

```ts
import { describe, expect, it } from "vitest";
import {
  GatewayRequestSchema,
  InboundEventSchema,
  TaskStateSchema,
} from "../src/index.js";

describe("shared contracts", () => {
  it("accepts only private-chat ingress", () => {
    const base = {
      appId: "cli_a",
      tenantKey: "tenant_a",
      eventId: "evt_a",
      messageId: "msg_a",
      senderOpenId: "ou_a",
      chatId: "oc_a",
      eventType: "im.message.receive_v1",
      receivedAt: "2026-07-20T00:00:00.000Z",
      payloadRef: `sha256:${"a".repeat(64)}`,
    };
    expect(InboundEventSchema.parse({ ...base, chatType: "p2p" }).chatType).toBe("p2p");
    expect(() => InboundEventSchema.parse({ ...base, chatType: "group" })).toThrow();
  });

  it("does not define a silently replayable task state", () => {
    expect(TaskStateSchema.options).toContain("INTERRUPTED_REQUIRES_CONFIRMATION");
    expect(TaskStateSchema.options).toContain("CANCELLED");
    expect(TaskStateSchema.options).not.toContain("RETRYING");
  });

  it("requires protocol version and request id", () => {
    expect(() => GatewayRequestSchema.parse({ kind: "read" })).toThrow();
  });

  it("rejects caller-supplied task or identity context", () => {
    expect(() => GatewayRequestSchema.parse({
      version: 1,
      requestId: crypto.randomUUID(),
      kind: "read",
      capability: "minutes.search",
      payload: {},
      taskId: crypto.randomUUID(),
      identity: "user",
    })).toThrow();
  });
});
```

- [x] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/contracts test
```

Expected: FAIL because schemas are not exported。

- [x] **Step 3: 实现最小稳定合同**

```ts
// packages/contracts/src/events.ts
import { z } from "zod";

export const InboundEventSchema = z.object({
  appId: z.string().min(1),
  tenantKey: z.string().min(1),
  eventId: z.string().min(1),
  messageId: z.string().min(1),
  senderOpenId: z.string().min(1),
  chatId: z.string().min(1),
  chatType: z.literal("p2p"),
  eventType: z.literal("im.message.receive_v1"),
  receivedAt: z.string().datetime(),
  payloadRef: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();
export type InboundEvent = z.infer<typeof InboundEventSchema>;
```

```ts
// packages/contracts/src/tasks.ts
import { z } from "zod";
import type { InboundEvent } from "./events.js";

export const TaskStateSchema = z.enum([
  "RECEIVED",
  "CLAIMED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED_REQUIRES_CONFIRMATION",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;
export interface TaskSink {
  ingest(event: InboundEvent): Promise<{ taskId: string; duplicate: boolean }>;
}
export type CancelActiveTaskRequest = Readonly<Pick<InboundEvent, "appId" | "tenantKey" | "eventId" | "messageId" | "senderOpenId" | "chatId" | "receivedAt">>;
export type CancelActiveTaskResult = Readonly<{ controlEventId: string; taskId: string | null; cancelled: boolean; duplicate: boolean; externalEffectsPending: boolean }>;
export interface TaskControlSink {
  cancelActive(request: CancelActiveTaskRequest): Promise<CancelActiveTaskResult>;
}
export interface Clock { now(): Date }
```

```ts
// packages/contracts/src/gateway.ts
import { z } from "zod";

export const GatewayRequestSchema = z.object({
  version: z.literal(1),
  requestId: z.string().uuid(),
  kind: z.enum(["read", "prepare", "system_reply"]),
  capability: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
}).strict();
export type GatewayRequest = z.infer<typeof GatewayRequestSchema>;
export type ReadRequest = GatewayRequest & { kind: "read" };
export type PrepareActionRequest = GatewayRequest & { kind: "prepare" };
export type SystemReplyRequest = GatewayRequest & { kind: "system_reply" };
export type PreparedAction = Readonly<{ actionId: string; payloadHash: string; expiresAt: string }>;
export type GatewayResult = Readonly<{ state: "SUCCEEDED" | "FAILED" | "UNKNOWN"; remoteId?: string }>;
export interface RunGatewayClient {
  read<T>(request: ReadRequest): Promise<T>;
  prepare(request: PrepareActionRequest): Promise<PreparedAction>;
  systemReply(request: SystemReplyRequest): Promise<GatewayResult>;
}
export interface BridgeGatewayClient {
  sendSystemReply(taskId: string, body: Readonly<{ type: "text" | "file"; value: string }>): Promise<GatewayResult>;
  sendControlReply(controlEventId: string, body: Readonly<{ type: "text"; value: string }>): Promise<GatewayResult>;
  submitApproval(callback: Readonly<{ actionId: string; nonce: string; actorOpenId: string; chatId: string }>): Promise<Readonly<{ accepted: boolean }>>;
}
```

```ts
// packages/contracts/src/status.ts
import { z } from "zod";

export const AssistantStatusSchema = z.enum([
  "PASS", "BLOCKED_HOST_READINESS", "BLOCKED_APP_PUBLISH", "BLOCKED_SCOPE",
  "BLOCKED_USER_AUTH", "BLOCKED_SECRET_STORAGE", "BLOCKED_VISIBILITY",
  "BLOCKED_RESOURCE_PERMISSION", "BLOCKED_CAPABILITY", "UNVERIFIED_NO_FIXTURE",
  "INTERRUPTED_REQUIRES_CONFIRMATION", "BLOCKED_RUNTIME_STATE", "FAILED_DEPENDENCY",
  "BLOCKED_REPO_BOUNDARY",
]);
export type AssistantStatus = z.infer<typeof AssistantStatusSchema>;
```

- [x] **Step 4: 导出合同并运行绿测**

```ts
export * from "./events.js";
export * from "./gateway.js";
export * from "./status.js";
export * from "./tasks.js";
export const CONTRACT_VERSION = 1 as const;
```

Run:

```bash
corepack pnpm --filter @executive-assistant/contracts test
corepack pnpm --filter @executive-assistant/contracts typecheck
```

Expected: PASS and exit `0`。

- [x] **Step 5: 经授权后提交 Task 2**

```bash
git add packages/contracts
git commit -m "feat: define assistant runtime contracts"
```

已按授权完成 Task 2 的本地提交；未配置 remote，未执行 push、PR、deploy 或真实飞书写操作。

### Task 3: Vendor 并验证固定 bridge 来源

**Files:**
- Create: `scripts/vendor-bridge`
- Create: `scripts/bridge-vendor-manifest.mjs`
- Create: `packages/bridge/UPSTREAM.md`
- Create: `packages/bridge/PATCHES.md`
- Create: `LICENSES/lark-codex-bridge-MIT.txt`
- Create: `dependencies.lock.json`
- Create: `tests/contracts/vendor-provenance.test.ts`
- Create: `tests/contracts/vendor-manifest.test.ts`
- Create: `vendor/patches/lark-codex-bridge/0001-workspace-adapter.patch`
- Create: `packages/bridge/**` from verified upstream archive

**Interfaces:**
- Consumes: upstream Git commit `e8b0dc0cdfe2fb378bef7081618138a20d934aa9`。
- Produces: reproducible vendored source with exact commit and License evidence。
- Produces: workspace package `@executive-assistant/bridge` with deterministic `build`、`typecheck` and `test` scripts；adapter changes are represented by audited patch files outside the target tree。
- Produces: root workspace/root lock as the only pnpm authority；vendored bridge 内不得保留 `pnpm-workspace.yaml` 或 `pnpm-lock.yaml`。
- Produces: offline strict manifest and patched Git tree evidence；仅顶层 `dist/`、`node_modules/` 目录可排除，其他路径、类型、mode、size、content SHA-256 与 symlink target 必须完全一致。

- [x] **Step 1: 写来源红测**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("vendored bridge provenance", () => {
  it("pins the reviewed upstream commit and preserves MIT", () => {
    const lock = JSON.parse(readFileSync("dependencies.lock.json", "utf8"));
    expect(lock.larkCodexBridge).toMatchObject({
      tagObjectSha: "fcc8b1f4cb6ef45ba598cda2f057bb2798e479a1",
      commitSha: "e8b0dc0cdfe2fb378bef7081618138a20d934aa9",
      treeSha: "9abc1413bf4f44ab048985cbbcebe1e4fc099d8f",
    });
    expect(readFileSync("LICENSES/lark-codex-bridge-MIT.txt", "utf8")).toContain("MIT License");
  });
});
```

- [x] **Step 2: 运行红测**

Run:

```bash
corepack pnpm vitest run tests/contracts/vendor-provenance.test.ts
```

Expected: FAIL because lock and License are absent。

- [x] **Step 3: 编写可重复 vendor 脚本**

```bash
#!/bin/zsh
set -euo pipefail
readonly upstream="https://github.com/VicLuoV5/lark-codex-bridge.git"
readonly tag_object="fcc8b1f4cb6ef45ba598cda2f057bb2798e479a1"
readonly commit="e8b0dc0cdfe2fb378bef7081618138a20d934aa9"
readonly tree="9abc1413bf4f44ab048985cbbcebe1e4fc099d8f"
readonly target="packages/bridge"
readonly manifest_tool="scripts/bridge-vendor-manifest.mjs"
readonly temp_dir="$(mktemp -d)"
readonly stage="$temp_dir/stage"
git clone --filter=blob:none "$upstream" "$temp_dir/repo"
git -C "$temp_dir/repo" checkout --detach "$commit"
test "$(git -C "$temp_dir/repo" rev-parse HEAD)" = "$commit"
test "$(git -C "$temp_dir/repo" rev-parse refs/tags/v0.1.34)" = "$tag_object"
test "$(git -C "$temp_dir/repo" rev-parse HEAD^{tree})" = "$tree"
for patch in vendor/patches/lark-codex-bridge/*.patch(N); do
  git -C "$temp_dir/repo" apply --index "$PWD/$patch"
done
readonly export_tree="$(git -C "$temp_dir/repo" write-tree)"
mkdir -p "$stage"
git -C "$temp_dir/repo" archive "$export_tree" | tar -x -C "$stage"
if [[ -e "$target" || -L "$target" ]]; then
  node "$manifest_tool" compare "$stage" "$target" || {
    print -u2 -- "refusing to overlay a non-identical bridge tree: $target"
    exit 73
  }
else
  mv "$stage" "$target"
  node "$manifest_tool" summary "$target"
fi
mkdir -p LICENSES
cp "$target/LICENSE" LICENSES/lark-codex-bridge-MIT.txt
print -r -- "verified temporary source retained for OS cleanup: $temp_dir"
```

`0001-workspace-adapter.patch` 只允许把上游 package 适配为 `@executive-assistant/bridge`，固定 workspace scripts、tsconfig、Vitest include 和锁定依赖，并删除整份上游 nested `pnpm-lock.yaml` / `pnpm-workspace.yaml`；不得混入业务逻辑。脚本先验证原始 tag/commit/tree，再在临时 clone 应用按文件名排序的审计补丁并导出。严格清单工具递归使用 `lstat`、不跟随 symlink，拒绝 symlink root、`.git` 和除顶层生成目录外的任何差异；不得使用宽泛名称排除。后续每项上游修改必须同时写入独立 patch 文件和 `PATCHES.md`。

- [x] **Step 4: 写锁文件与补丁基线**

```json
{
  "schemaVersion": 1,
  "larkCodexBridge": {
    "repository": "https://github.com/VicLuoV5/lark-codex-bridge.git",
    "tag": "v0.1.34",
    "tagObjectSha": "fcc8b1f4cb6ef45ba598cda2f057bb2798e479a1",
    "commitSha": "e8b0dc0cdfe2fb378bef7081618138a20d934aa9",
    "treeSha": "9abc1413bf4f44ab048985cbbcebe1e4fc099d8f",
    "patchedTreeSha": "53d1cf79df42852eac580503304a8651df6b1850",
    "strictManifestSha256": "a456640be1d8fdc5985ff1efe0a48b41e709858e2172ff193043363a04a312fc",
    "licenseSha256": "4d0cfede2f5089f10c0caf8f270c27797286a27be594da28ef441bfa83a3c782",
    "vendorScriptSha256": "447f1e0a1d0ba02d118ba7aee456ba76f8fbd6d92fb315fd301627e18a83c525",
    "manifestToolSha256": "e23a2d4256b6a99fb59a6ef6529b9dfb26c52c0f58c8a666dfb0a3c695241cf4",
    "patches": [{ "path": "vendor/patches/lark-codex-bridge/0001-workspace-adapter.patch", "sha256": "9a7a2ff6db2705234857492eb3a5c8c8309bb02c81da6cf73819375a86e7e381" }],
    "npmIntegrity": "sha512-+4GztTJXLmqPOsmyd4IFSKkYqpw46QeHiAjtlLH9FANn5+HdcoobCZWSlFfRj306aQUk5xn4AWT8em9v2Krhjg==",
    "license": "MIT"
  },
  "larkCli": {
    "package": "@larksuite/cli",
    "version": "1.0.72",
    "npmIntegrity": "sha512-BgK1hmLLMuJNM/Jx5vBQF7pgxwSzREyvQYV2WkkDlBw7fKyJbEZ/baMKq2YZnMFTm+yfmTNEYCsHOf1k2P9S4w==",
    "darwinArm64ArchiveSha256": "b27942b83e8821934ebd34fbb02e0b00bbca949255866b5010795d625442eae2",
    "darwinAmd64ArchiveSha256": "b5dd56d64f9cc1cb7bab80b8eb1dda3c34e76f2a751115a897d0261985b82745"
  },
  "visualFirstPpt": {
    "repository": "https://github.com/banqiusheng/visual-first-ppt.git",
    "tag": "v0.3.0",
    "tagObjectSha": "4962eb9bd5c55e8384b5228993c241b2220fcabb",
    "commitSha": "bb775f68f951c3e444d00623bc88976b20c13e7d",
    "treeSha": "5ad18d178e8191105dcc68717e4639d3a68f0c73"
  },
  "codex": { "minimumVersion": "0.142.0", "requiredFeatures": ["exec-json", "exec-resume-stdin", "approval-never", "workspace-write-network-deny"] },
  "node": { "supportedRange": ">=20.0.0 <21.0.0 || >=22.0.0 <23.0.0 || >=24.0.0 <25.0.0 || >=26.0.0 <27.0.0" },
  "pnpm": { "version": "10.0.0" }
}
```

`UPSTREAM.md` 必须写明仓库、tag、commit、导入日期和 MIT；`PATCHES.md` 登记已存在的 `0001-workspace-adapter.patch`，说明其仅用于 workspace 包名、确定性脚本、Vitest 发现、依赖精确版本、删除 nested pnpm 权威和来源元数据，并记录来源测试、strict manifest 负测、bridge-directory frozen install、bridge smoke/typecheck、两次幂等导入和全仓质量门禁。后续每项补丁继续分别记录文件、原因和测试。

- [x] **Step 5: 执行 vendor、安装锁定依赖并跑绿测**

Run:

```bash
chmod +x scripts/vendor-bridge
./scripts/vendor-bridge
corepack pnpm install
corepack pnpm vitest run tests/contracts/vendor-provenance.test.ts tests/contracts/vendor-manifest.test.ts
(cd packages/bridge && corepack pnpm install --frozen-lockfile)
corepack pnpm --filter @executive-assistant/bridge exec vitest --version
corepack pnpm --filter @executive-assistant/bridge typecheck
```

Expected: upstream HEAD matches exact commit；provenance test PASS；workspace filter resolves exactly one bridge package and both smoke commands exit `0`。

Task 3 复审加固还必须证明：clean-room 首次导入和 existing-target 幂等导入均产生 patched tree `53d1cf79df42852eac580503304a8651df6b1850` / strict manifest `a456640be1d8fdc5985ff1efe0a48b41e709858e2172ff193043363a04a312fc`；嵌套 `src/dist`、directory→symlink、`0644`→`0755` 均 exit `73`，而顶层 `dist/` 与 `node_modules/` 生成目录可忽略。

- [x] **Step 6: 经授权后提交 Task 3**

```bash
git add scripts/vendor-bridge vendor/patches/lark-codex-bridge packages/bridge LICENSES dependencies.lock.json pnpm-lock.yaml tests/contracts/vendor-provenance.test.ts .gitattributes .prettierignore eslint.config.js README.md CHANGELOG.md docs/superpowers/plans/2026-07-20-01-foundation-and-bridge.md
git commit -m "chore: vendor reviewed lark bridge source"
```

已按 Stage A 本地提交授权执行 Task 3；未配置或创建项目 remote，未执行 push、PR、deploy 或真实飞书 API/写操作。Task 3 的 bridge 仅为经过来源核验的审计导入，不代表生产接线完成。

Task 3 复审加固使用独立后续提交 `fix: harden bridge vendor provenance`，不 amend 原提交；提交范围包括 strict manifest 工具/测试、来源锁、审计补丁、机械重生成 bridge、README/CHANGELOG/本计划。边界仍为本地提交，不包含 remote、push、PR、deploy 或真实飞书操作。

### Task 4: 在最早边界实现 fail-closed 入站检查

**Files:**
- Create: `packages/bridge/src/security/ingress-guard.ts`
- Create: `packages/bridge/src/security/policy.ts`
- Test: `packages/bridge/test/ingress-guard.test.ts`
- Modify: `packages/bridge/PATCHES.md`

**Interfaces:**
- Consumes: typed SDK adapter metadata，不读取附件正文；卡片 metadata 必须携带 SDK 已验证的签名结果、callback nonce 和 canonical payload SHA-256。
- Produces: `IngressDecision = allow_task | allow_pairing | allow_card{nonce,payloadHash} | deny`。

- [x] **Step 1: 写完整负向红测**

```ts
import { describe, expect, it } from "vitest";
import { decideIngress } from "../src/security/ingress-guard.js";

const paired = {
  appId: "cli_a", tenantKey: "t_a", presidentOpenId: "ou_president",
  presidentChatId: "oc_dm", pairing: { active: false, codeHash: null },
} as const;

describe("decideIngress", () => {
  it.each([
    ["im.message.receive_v1", "group", "ou_president", "oc_group"],
    ["drive.file.bitable_record_changed_v1", "p2p", "ou_president", "oc_dm"],
    ["im.message.reaction.created_v1", "p2p", "ou_president", "oc_dm"],
    ["application.bot.menu_v6", "p2p", "ou_president", "oc_dm"],
  ])("denies non-task ingress", (eventType, chatType, senderOpenId, chatId) => {
    expect(decideIngress({ appId: "cli_a", tenantKey: "t_a", eventType, chatType, senderOpenId, chatId, text: "x" }, paired).kind).toBe("deny");
  });

  it("denies an unpaired normal message", () => {
    const policy = { ...paired, presidentOpenId: null, presidentChatId: null, pairing: { active: true, codeHash: "sha256:expected" } };
    expect(decideIngress({ appId: "cli_a", tenantKey: "t_a", eventType: "im.message.receive_v1", chatType: "p2p", senderOpenId: "ou_x", chatId: "oc_x", text: "做日报" }, policy).kind).toBe("deny");
  });

  it("allows only the paired president DM", () => {
    expect(decideIngress({ appId: "cli_a", tenantKey: "t_a", eventType: "im.message.receive_v1", chatType: "p2p", senderOpenId: "ou_president", chatId: "oc_dm", text: "整理文件" }, paired).kind).toBe("allow_task");
  });

  it.each([
    [{ signatureVerified: false, callbackNonce: "nonce-a", callbackPayloadHash: `sha256:${"a".repeat(64)}` }],
    [{ signatureVerified: true, callbackNonce: "", callbackPayloadHash: `sha256:${"a".repeat(64)}` }],
    [{ signatureVerified: true, callbackNonce: "nonce-a", callbackPayloadHash: "sha256:bad" }],
  ])("denies an unverified or unbound card callback", (auth) => {
    expect(decideIngress({
      appId: "cli_a", tenantKey: "t_a", eventType: "card.action.trigger", chatType: "p2p",
      senderOpenId: "ou_president", chatId: "oc_dm", ...auth,
    }, paired).kind).toBe("deny");
  });
});
```

- [x] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/bridge test -- ingress-guard
```

Expected: FAIL because `decideIngress` is missing。

- [x] **Step 3: 实现无副作用的检查函数**

```ts
import { createHash, timingSafeEqual } from "node:crypto";

export type AccessPolicy = Readonly<{
  appId: string;
  tenantKey: string;
  presidentOpenId: string | null;
  presidentChatId: string | null;
  pairing: Readonly<{ active: boolean; codeHash: string | null }>;
}>;

export type IngressDecision =
  | Readonly<{ kind: "allow_task" }>
  | Readonly<{ kind: "allow_pairing" }>
  | Readonly<{ kind: "allow_card"; nonce: string; payloadHash: `sha256:${string}` }>
  | Readonly<{ kind: "deny"; reason: string }>;

export type RawIngressMetadata = Readonly<{
  appId: string;
  tenantKey: string;
  eventType: string;
  chatType: string;
  senderOpenId: string;
  chatId: string;
  text?: string;
  signatureVerified?: boolean;
  callbackNonce?: string;
  callbackPayloadHash?: string;
}>;

const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export function decideIngress(raw: RawIngressMetadata, policy: AccessPolicy): IngressDecision {
  if (raw.appId !== policy.appId || raw.tenantKey !== policy.tenantKey) return { kind: "deny", reason: "wrong_tenant" };
  if (raw.chatType !== "p2p") return { kind: "deny", reason: "group_disabled" };
  if (raw.eventType === "card.action.trigger") {
    const payloadHash = raw.callbackPayloadHash;
    const cardBound = raw.signatureVerified === true
      && typeof raw.callbackNonce === "string" && raw.callbackNonce.length > 0
      && typeof payloadHash === "string" && /^sha256:[a-f0-9]{64}$/.test(payloadHash);
    if (!cardBound) return { kind: "deny", reason: "card_auth_invalid" };
    return raw.senderOpenId === policy.presidentOpenId && raw.chatId === policy.presidentChatId
      ? { kind: "allow_card", nonce: raw.callbackNonce, payloadHash: payloadHash as `sha256:${string}` }
      : { kind: "deny", reason: "card_actor_mismatch" };
  }
  if (raw.eventType !== "im.message.receive_v1") return { kind: "deny", reason: "event_disabled" };
  if (policy.pairing.active && policy.pairing.codeHash) {
    const actual = Buffer.from(hash(raw.text ?? ""));
    const expected = Buffer.from(policy.pairing.codeHash);
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return { kind: "allow_pairing" };
  }
  if (!policy.presidentOpenId || !policy.presidentChatId) return { kind: "deny", reason: "not_paired" };
  return raw.senderOpenId === policy.presidentOpenId && raw.chatId === policy.presidentChatId
    ? { kind: "allow_task" }
    : { kind: "deny", reason: "principal_mismatch" };
}
```

- [x] **Step 4: 证明检查发生在日志与附件之前**

在 channel 单元测试注入 `logger`、`mediaDownloader` 和 `taskSink` spies；对每个 deny case 断言三者的正文方法、下载方法和 `ingest` 均未调用。允许记录的唯一拒绝日志为固定字段 `{reason,eventType}`，不得包含正文、完整 ID 或 SDK response。

Run:

```bash
corepack pnpm --filter @executive-assistant/bridge test -- ingress-guard channel-deny
```

Expected: PASS；所有 deny spies call count 为 `0`。

- [x] **Step 5: 更新补丁清单并经授权提交**

```bash
git add packages/bridge/src/security packages/bridge/test packages/bridge/PATCHES.md
git commit -m "fix: fail closed before bridge task handling"
```

已按 Stage A 本地提交授权执行 Task 4；实现以独立
`0002-fail-closed-ingress.patch` 从固定上游和 `0001` 后状态机械重放，
per-patch 回归要求实际 diff path 集合与明确 allowlist 完全相等。Task 4
只建立并验证最早入口的 guard seam，未把它接入现有 live channel；订阅裁剪、
持久 TaskSink、ACK 顺序与 live wiring 仍属于 Task 6。未配置或创建项目 remote，
未执行 push、PR、deploy 或真实飞书 API/写操作。

Task 4 独立复审后以 follow-up 修复（不 amend 原提交）：配对入口对 SDK
adapter 的运行时 metadata 再做非空 ID、字符串类型、首尾空白和 256 字符上限
检查，拒绝 Buffer/数字/缺失文本及已知空字符串 SHA-256，所有 malformed 输入
均 deny 且不抛异常；审计把任意未知、超长或多行 event type 归一为 `other`。
policy 口径明确为 paired、active pairing、explicit deny-all 三种受控状态，现有
live channel 仍未接线。供应链仍机械更新同一个 0002，exact path set 不变。

### Task 5: 建立受限 Codex runner

**Files:**
- Create: `packages/bridge/src/agent/codex-runner.ts`
- Create: `packages/bridge/src/security/workspace.ts`
- Test: `packages/bridge/test/codex-runner.test.ts`
- Test: `packages/bridge/test/workspace.test.ts`
- Modify: `packages/bridge/PATCHES.md`

**Interfaces:**
- Consumes: `CodexRunRequest { taskId, sessionId?, workspace, gatewaySocket, gatewayClient, prompt }`。
- Produces: async JSONL event stream、async `TERMINATION_UNCONFIRMED` stream 和仅在真实 child `close` 后完成的 final `CodexRunResult`；同步 spawn throw 是唯一无 child 的例外。
- Produces: `resolveTaskWorkspace(root, taskId): Promise<string>`；`taskId` 必须是 UUID，chat hash 不参与任务目录构造。

- [x] **Step 1: 写 argv、环境和路径红测**

```ts
import { describe, expect, it, vi } from "vitest";
import { createCodexRunner } from "../src/agent/codex-runner.js";

describe("codex runner", () => {
  it("uses workspace-write, never approval and a clean environment", async () => {
    const spawn = vi.fn(() => fakeChildProcess());
    const runner = createCodexRunner({ spawn, codexPath: "/opt/local/bin/codex", codexHome: "/Users/test/PresidentAssistant/runtime/codex-home" });
    await runner.start({ taskId: "018f7d72-7a2b-7f45-8a12-8e20b8426a21", workspace: "/Users/test/PresidentAssistant/jobs/018f7d72-7a2b-7f45-8a12-8e20b8426a21", gatewaySocket: "/Users/test/PresidentAssistant/jobs/018f7d72-7a2b-7f45-8a12-8e20b8426a21/gateway.sock", gatewayClient: "/Users/test/PresidentAssistant/runtime/current/public-bin/assistant-gateway", prompt: "整理附件" });
    expect(spawn).toHaveBeenCalledWith(
      "/opt/local/bin/codex",
      ["--ask-for-approval", "never", "--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=false", "exec", "--strict-config", "--json", "--skip-git-repo-check", "-"],
      expect.objectContaining({ cwd: "/Users/test/PresidentAssistant/jobs/018f7d72-7a2b-7f45-8a12-8e20b8426a21" }),
    );
    const env = spawn.mock.calls[0]![2].env;
    expect(env.FEISHU_APP_SECRET).toBeUndefined();
    expect(env.LARK_CLI_PATH).toBeUndefined();
    expect(env.CODEX_HOME).toBe("/Users/test/PresidentAssistant/runtime/codex-home");
    expect(env.ASSISTANT_GATEWAY_SOCKET).toBe("/Users/test/PresidentAssistant/jobs/018f7d72-7a2b-7f45-8a12-8e20b8426a21/gateway.sock");
    expect(env.ASSISTANT_GATEWAY_CLIENT).toBe("/Users/test/PresidentAssistant/runtime/current/public-bin/assistant-gateway");
  });
});
```

路径测试必须包含：正常子目录、`..`、不存在路径、指向根外的 symlink、根本身为 symlink；只有 normal child PASS。

- [x] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/bridge test -- codex-runner workspace
```

Expected: FAIL because the hardened runner does not exist。

- [x] **Step 3: 实现 argv 与最小环境构造**

```ts
const REQUIRED_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export function buildCodexInvocation(input: {
  codexPath: string; codexHome: string; workspace: string; gatewaySocket: string; gatewayClient: string; sessionId?: string;
}) {
  const safetyPrefix = [
    "--ask-for-approval", "never", "--sandbox", "workspace-write",
    "-c", "sandbox_workspace_write.network_access=false",
    "exec",
  ];
  const args = input.sessionId
    ? [...safetyPrefix, "resume", input.sessionId, "--strict-config", "--json", "--skip-git-repo-check", "-"]
    : [...safetyPrefix, "--strict-config", "--json", "--skip-git-repo-check", "-"];
  return {
    command: input.codexPath,
    args,
    options: {
      cwd: input.workspace,
      env: { PATH: REQUIRED_PATH, CODEX_HOME: input.codexHome, ASSISTANT_GATEWAY_SOCKET: input.gatewaySocket, ASSISTANT_GATEWAY_CLIENT: input.gatewayClient, LANG: "zh_CN.UTF-8" },
      stdio: ["pipe", "pipe", "pipe"] as const,
    },
  };
}
```

- [x] **Step 4: 实现 realpath 边界和 30 分钟 idle timer**

`resolveTaskWorkspace(root, taskId)` 必须先验证 `taskId` 为 UUID，以 `join(root, taskId)` 构造唯一 candidate，分别 `realpath(root)` 与 `realpath(candidate)`，再用 `relative(root,candidate)` 检查结果非绝对、不是 `..`、不以 `../` 开头；目录必须由受信任进程以 `0700` 创建。`gatewayClient` 必须 realpath 到当前已校验 release 的 `public-bin/assistant-gateway`，签名和 SHA 与安装 manifest 一致；该 public-bin 不得包含 `lark-cli` 或秘密工具。runner 只在收到并接受符合已知 0.142 状态机的完整 JSONL event 后重置 30 分钟 timer；原始 line bytes 必须先于 UTF-8 解码和空白忽略执行 1 MiB 限制，解码为 fatal UTF-8。`turn.completed` 必须有四项非负 safe-integer usage；`turn.failed` 是失败 terminal，顶层 `error` 只在 turn 内作为脱敏非终态 reconnect diagnostic，未知事件 fail closed。resume 的 `thread.started` 必须绑定请求中的 session UUID，但共用事件流仅是静态推断，标记 `UNVERIFIED_RESUME_PROTOCOL`。到期先发送 `SIGTERM`，10 秒仍未观察到 child `close` 才 `SIGKILL`；若 KILL 后仍无 close，发出一次 `TERMINATION_UNCONFIRMED` 并继续保留 result、事件流和 listeners，直到真实 close。Task 6 caller 必须同时消费 `events`、`terminationEvents` 与 `result`，不得裸等待 result。

- [x] **Step 5: 运行绿测和 CLI 参数静态验证**

Run:

```bash
corepack pnpm --filter @executive-assistant/bridge test -- codex-runner workspace
corepack pnpm --filter @executive-assistant/bridge typecheck
```

Expected: PASS；测试证明 argv 不含 `danger-full-access`，环境不继承飞书秘密，symlink escape 被拒绝。

- [x] **Step 6: 经授权后提交 Task 5**

```bash
git add packages/bridge/src/agent packages/bridge/src/security/workspace.ts packages/bridge/test packages/bridge/PATCHES.md
git commit -m "fix: constrain codex runtime environment"
```

已按 Stage A 本地提交授权执行 Task 5。首次 focused 红测因两个新模块不存在而
exit 1，既有 91 项仍通过；实现与复审加固后 bridge 为 201/201。新 runner
固定安全 argv 和最小环境，要求 Codex 最低版本与 feature evidence、可信 release
gateway evidence、`0700` Codex home、`0600` UDS，并对 JSONL、待消费队列和
30 分钟 idle 实施有界 fail-closed 终止。所有非成功状态均
`requiresConfirmation: true`、`automaticRetry: false`。

独立复审随后发现 close、stdin flush 与协议 terminal 语义仍需收紧；新增红测命中
这些缺口后，runner 改为只在真实 child `close` 后完成并释放资源，KILL 后仍无
close 时通过独立 `TERMINATION_UNCONFIRMED` stream 通知人工介入；stdin 必须观察
`finish`/`writableFinished`。JSONL 改为 raw-byte-first、fatal UTF-8 和已知 0.142
状态机，要求四项 completion usage，区分 `turn.failed` 与脱敏非终态 reconnect
diagnostic，并将 resume thread id 绑定显式 session UUID。Task 6/未来 caller 必须
同时消费两个事件流与 final result，不能只裸等待 result。resume 共用协议仍为
`UNVERIFIED_RESUME_PROTOCOL`，feature probe 不被视作高版本 schema 兼容证明。
复审修正后的 bridge 为 11 files、231/231，全仓为 15 files、264/264；format、
lint、typecheck、build、vendor replay、provenance/strict manifest 均为 exit 0。

vendored 变化由独立 `0003-constrained-codex-runner.patch` 从 `0001`、`0002`
后状态机械重放；patched tree 为
`15e688f9fd7e70f55c155aac5c8c28bcbaff9fc7`，strict manifest 为
`082ceaac8e95762fef0a0a9600789e5f6f1b721b3b618085226e32605bf51c85`。
Task 7 预检重新打开 Task 5 后，新增 request、dependency capability 与 verifier
evidence 的一次性 own-data 快照：Proxy、accessor、隐藏/符号/未知字段、扩展数组、
异步修改及 `Object.prototype` 污染均 fail closed；依赖在 runner 构造时固定并以空
receiver 调用，最终 argv、null-prototype 五字段 env、options 与 invocation 均冻结。
聚焦 runner 为 138/138，补修后的 bridge 为 15 files、362/362；0003 SHA-256 为
`9df09fdb2dbbd5d9d4647834b500c5d59c33f837d344613bcc01762db439e89c`。
Task 5 未启动真实 Codex，未证明目标机真实签名、UDS、sandbox 或网络阻断，
未修改 live channel；旧上游 adapter 在 Task 6 替换前不是受支持生产路径。未
配置或创建项目 remote，未执行 push、PR、deploy 或真实飞书 API/写操作。

### Task 6: 把 bridge 改造成账本优先的可插拔通道

**Files:**
- Create: `packages/bridge/src/runtime/assistant-channel.ts`
- Create: `packages/bridge/src/runtime/system-reply.ts`
- Create: `packages/bridge/src/runtime/progress-reporter.ts`
- Test: `packages/bridge/test/assistant-channel.test.ts`
- Test: `packages/bridge/test/progress-reporter.test.ts`
- Modify: `packages/bridge/src/bot/channel.ts`
- Modify: `packages/bridge/PATCHES.md`

**Interfaces:**
- Consumes: `TaskSink.ingest(event)`。
- Consumes: `TaskControlSink.cancelActive(request)` for deterministic president-DM cancel phrases。
- Consumes: `BridgeGatewayClient.sendSystemReply(taskId, body)`。
- Produces: `AssistantChannel.handle(rawEnvelope): Promise<void>`。
- Does not consume: raw `lark-cli` or Feishu credentials。

- [x] **Step 1: 写 TaskSink 成功先于 ACK 的红测**

```ts
it("persists before acknowledging", async () => {
  const order: string[] = [];
  const taskSink = { ingest: vi.fn(async () => { order.push("persist"); return { taskId: crypto.randomUUID(), duplicate: false }; }) };
  const gateway = { sendSystemReply: vi.fn(async () => { order.push("ack"); return { state: "SUCCEEDED" as const }; }) };
  const scheduler = { wake: vi.fn() };
  const channel = createAssistantChannel({ taskSink, gateway, ingressGuard: allowPresidentDm, scheduler });
  await channel.handle(presidentTextEnvelope());
  expect(order).toEqual(["persist", "ack"]);
  expect(scheduler.wake).toHaveBeenCalledOnce();
});

it("does not acknowledge a failed persistence", async () => {
  const taskSink = { ingest: vi.fn(async () => { throw new Error("disk full"); }) };
  const gateway = { sendSystemReply: vi.fn() };
  const scheduler = { wake: vi.fn() };
  await expect(createAssistantChannel({ taskSink, gateway, ingressGuard: allowPresidentDm, scheduler }).handle(presidentTextEnvelope())).rejects.toThrow("disk full");
  expect(gateway.sendSystemReply).not.toHaveBeenCalled();
  expect(scheduler.wake).not.toHaveBeenCalled();
});

it("handles an exact cancel phrase before creating another task", async () => {
  const taskSink = { ingest: vi.fn() };
  const taskControlSink = { cancelActive: vi.fn(async () => ({ controlEventId: crypto.randomUUID(), taskId: "task-a", cancelled: true, duplicate: false, externalEffectsPending: false })) };
  const gateway = { sendControlReply: vi.fn(async () => ({ state: "SUCCEEDED" as const })) };
  const scheduler = { wake: vi.fn() };
  const channel = createAssistantChannel({ taskSink, taskControlSink, gateway, ingressGuard: allowPresidentDm, cancelClassifier: exactCancelClassifier, scheduler });
  await channel.handle(presidentTextEnvelope("取消这个任务"));
  expect(taskControlSink.cancelActive).toHaveBeenCalledOnce();
  expect(taskSink.ingest).not.toHaveBeenCalled();
  expect(gateway.sendControlReply).toHaveBeenCalledOnce();
});
```

- [x] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/bridge test -- assistant-channel
```

Expected: FAIL because `createAssistantChannel` is absent。

- [x] **Step 3: 实现通道顺序和重复事件行为**

```ts
export function createAssistantChannel(deps: ChannelDependencies) {
  return {
    async handle(raw: RawEnvelope): Promise<void> {
      const decision = deps.ingressGuard(raw);
      if (decision.kind === "deny") return;
      if (decision.kind === "allow_pairing") return deps.pairingSink.consume(raw);
      if (decision.kind === "allow_card") return deps.confirmationSink.consume(raw);
      if (deps.cancelClassifier.matchesExact(raw)) {
        const request = deps.normalizer.toCancelActiveTaskRequest(raw);
        const result = await deps.taskControlSink.cancelActive(request);
        if (result.duplicate) return;
        const value = result.cancelled
          ? (result.externalEffectsPending ? "已停止当前任务；已有外部动作正在核对，我会只报告事实。" : "已停止当前任务，没有待执行的外部动作。")
          : "当前没有运行中的任务。";
        await deps.gateway.sendControlReply(result.controlEventId, { type: "text", value });
        return;
      }
      const event = deps.normalizer.toInboundEvent(raw);
      const accepted = await deps.taskSink.ingest(event);
      if (accepted.duplicate) return;
      await deps.gateway.sendSystemReply(accepted.taskId, { type: "text", value: "收到，我开始处理" });
      deps.scheduler.wake();
    },
  };
}
```

本 Task 只证明调用顺序和失败传播：`TaskSink.ingest()` resolve 后才允许 ACK。内存 fake 的 `persist` 标签不是 SQLite durability 证据；第二份计划必须让同一接口接入事务账本并通过重启、重复事件和 lease 测试后，运行态才能使用该通道。

- [x] **Step 4: 删除或硬禁用上游旁路入口**

从注册列表中移除 comments、group create、bot-added、reaction 和 slash handlers；对保留的卡片 callback 先执行签名、tenant、actor、chat 和 nonce 检查。取消分类器只接受配置中精确列出的标准化短语（首版为“停一下”“停止当前任务”“取消这个任务”），且必须是配对后的原私聊；它在附件下载和新任务创建前调用 `TaskControlSink`。测试以注册 spy 断言只订阅 `im.message.receive_v1` 和 `card.action.trigger`。

`progress-reporter` 在任务满 60 秒前不发进度；之后只在持久 stage 发生变化时把一条简短中文状态交给 `sendSystemReply`，相同 stage 不重复，工具调用/思维过程不外发。完成、失败、取消或中断后停止 reporter；所有进度仍走 system_reply action ledger。

- [x] **Step 5: 运行 bridge 回归与旁路负向测试**

Run:

```bash
corepack pnpm --filter @executive-assistant/bridge test
corepack pnpm --filter @executive-assistant/bridge typecheck
```

Expected: PASS；拒绝事件不下载附件、不记录正文、不调用 `TaskSink`、不启动 Codex。

- [x] **Step 6: 经授权后提交 Task 6**

```bash
git add packages/bridge
git commit -m "feat: route bridge ingress through durable seams"
```

已按 Stage A 本地实现与本地提交授权完成 Task 6。首轮 focused 红测因三个 runtime
模块不存在而退出 1；入口适配器/CLI 红测随后命中旧 secret resolver 与 legacy import
路径。独立复核又以红测证明了实际 package/bin 旁路、干净源码缺少 contracts build、
进度 replay/snapshot 丢失窗口、卡片 action 跨异步边界漂移和注册中途失败未清理。
完成补修后，Task 6 原始门禁为 bridge 341/341、全仓 374/374；Task 7 预检触发的
Task 5 安全补修将当前 bridge 扩展为 15 个 test files、362/362 tests，bridge
typecheck 退出 0。`AssistantChannel` 只在 guard 放行后读取任务
正文；任务接收、固定 ACK、scheduler wake 严格按顺序发生，duplicate 无重复效果；
取消只接受三条 NFC + trim 后精确短语并先走 `TaskControlSink`。进度 reporter 以原子
subscribe-and-snapshot 契约接收持久状态，在 60 秒前静默，之后只串行发送 distinct
allowlisted persisted stage，终态清理 timer/listener。

支持 adapter 只注册 message、cardAction 与脱敏 lifecycle；卡片只有 exact trusted
verifier evidence 才能进入 confirmation sink，并在异步 sink 前将 action 投影为受限
深冻结 JSON。注册或连接失败会 best-effort disconnect。旧 comment/reaction/command/
media、直接 send、secret resolver、raw lark-cli 和 AgentAdapter 不在支持入口依赖图
中。实际 package root 与两个 bin 命令只暴露 Stage A 安全面；Stage B 持久端口注入
前，CLI 以 `ASSISTANT_RUNTIME_PORTS_REQUIRED` 在配置/秘密/建网前停止。独立临时副本
删除所有预生成 dist 后，离线 frozen install、bridge test/typecheck 与全仓 typecheck
均通过。

vendored 变化由 `0004-ledger-first-assistant-channel.patch` 从 `0001`–`0003` 后状态
机械重放；exact 13-path allowlist、补丁 SHA
`be17a41feef3b8135e9e006573a04b2159e8b521f0de11aeb219e87cbc35b3eb`、patched tree
`85d9128aa35f0b91111f34ad47ffcc9f7a6e171e` 与 strict manifest
`d59d9c3d554e62078082b9cf9363111cdf76525878f38324dc9654f226412f85` 已锁定。反向
应用精确回到 Task 5 tree `15e688f9fd7e70f55c155aac5c8c28bcbaff9fc7`，再正向恢复
Task 6 tree；完整 0001–0004 也可反向回到原始 tree 后再正向恢复。这里只证明
injected seam、内存 fake 与静态 adapter 边界；未证明
SQLite durability、重启/lease、真实飞书/Codex E2E、部署或 24 小时可用性。未配置
或创建项目 remote，未执行 push、PR、deploy 或真实 API/写操作。

### Task 7: 建立阶段 A 集成门禁与基础文档

**Files:**
- Create: `AGENTS.md`
- Create: `README.md`
- Create: `CHANGELOG.md`
- Create: `tests/integration/bridge-boundary.test.ts`
- Create: `tests/security/codex-tool-network.test.ts`
- Create: `docs/runbook/development.md`

**Interfaces:**
- Consumes: Tasks 1–6。
- Produces: stage-A quality command and machine-readable evidence。

- [x] **Step 1: 写阶段 A 集成红测**

```ts
describe("stage A boundary", () => {
  it("rejects a president group message before media and Codex", async () => {
    const harness = await createBridgeHarness({ paired: true });
    await harness.emit(groupMessageFromPresident());
    expect(harness.mediaDownloads).toBe(0);
    expect(harness.codexRuns).toBe(0);
    expect(harness.taskSinkCalls).toBe(0);
  });

  it("accepts a president DM only through TaskSink", async () => {
    const harness = await createBridgeHarness({ paired: true });
    await harness.emit(privateMessageFromPresident());
    expect(harness.taskSinkCalls).toBe(1);
    expect(harness.directBusinessApiCalls).toBe(0);
  });
});
```

- [x] **Step 2: 运行红测并补齐 harness**

Run:

```bash
corepack pnpm vitest run tests/integration/bridge-boundary.test.ts
```

Expected: initial FAIL because harness wiring is absent；补齐仅由内存 fake 构成的 seam harness 后 PASS。该结果不得表述为持久账本、重启恢复或生产运行 PASS。

- [x] **Step 3: 写 durable AGENTS 边界**

`AGENTS.md` 必须明确：读取顺序、质量命令、禁止直接飞书写入、禁止秘密进入 Codex env、禁止群聊入口、外部动作必须走 gateway、文件路径 realpath、没有真实证据不得标 PASS、以及 commit/push/PR/release 分离授权。

- [x] **Step 4: 离线验证 Codex 网络拒绝配置**

测试只通过注入的 process adapter 验证生产 invocation：argv 必须精确包含 `-c sandbox_workspace_write.network_access=false`、不得包含 `danger-full-access`，子进程环境不得出现代理、飞书 Secret/Token 或 raw lark-cli 路径；fixture 还应拒绝任何试图替换这些参数的调用。阶段 A 不启动真实 Codex，也不把 mock 当成 macOS sandbox 证据。真实 Codex 能运行且其工具命令无法访问本机/公网的验证移至第四份计划的目标 Mac、已登录 Codex E2E 门禁，并在此前保持 `UNVERIFIED_NO_FIXTURE`。

- [x] **Step 5: 执行阶段 A 全量质量门**

Run:

```bash
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
git diff --check
```

Expected: all exit `0`；安全测试无 skipped；`git diff --check` 无输出。

- [x] **Step 6: 经授权后提交阶段 A 收口**

```bash
git add AGENTS.md README.md CHANGELOG.md docs/runbook/development.md tests/integration tests/security
git commit -m "test: verify hardened bridge boundary"
```

Task 7 首轮 RED 为 4 个文件中 1 个通过、3 个失败：integration harness 与 AST
analyzer 尚不存在，旧 vendor 脚本将离线/未知参数误入在线 clone；Codex fake/static
矩阵 19/19 已通过。完成实现与 Task 5 安全回补后，Task 7 聚焦门禁为 integration
25/25、Codex 23/23、dependency graph 12/12、offline replay 6/6，共 66/66。

提交前全量门禁为 23 files、461/461 tests；bridge 为 15 files、362/362；离线
frozen install、format、lint、typecheck、build、真实本地 offline replay 和
`git diff --check` 均 exit 0。offline replay 将锁定补丁反向恢复 original tree
`9abc1413bf4f44ab048985cbbcebe1e4fc099d8f`，再正向恢复 patched tree
`85d9128aa35f0b91111f34ad47ffcc9f7a6e171e`，并验证 strict manifest
`d59d9c3d554e62078082b9cf9363111cdf76525878f38324dc9654f226412f85`；无 target 或
`LICENSES` 写入。新增 `AGENTS.md` 与 development runbook 固化长期边界。

以上均为 `STATIC_OR_FAKE_ONLY` 或本地供应链证据。真实飞书/Codex、签名、UDS、
macOS sandbox、工具网络阻断、SQLite durability、重启恢复、部署与 24H 仍为
`UNVERIFIED_NO_FIXTURE`。本地提交完成后还必须执行独立代码审查和干净 HEAD 总门禁，
才能把开发门禁升级为 `STAGE_A_SEAMS_VERIFIED`。

Task 7 本地提交 `df5c392` 后，两路独立审查均给出 `CHANGES_REQUIRED`。红测分别证明：
验签等待期间可替换 card action；内部文件/目录 symlink 与网络/`process`/动态代码别名
可绕过 AST；ambient `GIT_CONFIG_*` / `GIT_INDEX_FILE` 可在 offline replay 执行 helper
或写到 `LICENSES`；真实 bridge build 与 vendor fixture 扫描存在 tsup 临时文件竞态；
integration harness 的四个恒零指标没有 production 注入点。修复后 card action 以排序键
canonical JSON SHA-256 与 evidence 绑定；AST 对上述动态能力保守拒绝；Git 子进程只获
最小环境；package/bin 构建移入隔离 workspace；伪指标已删除。

审查修复后的提交前门禁为 integration 26/26、Codex 23/23、dependency graph 18/18、
offline replay 7/7，共 74/74；全仓 23 files / 472/472，bridge 15 files / 365/365。
format、lint、typecheck、build、离线 frozen install、实际 offline replay 和
`git diff --check` 均 exit 0。新的 0004 SHA 为
`ef8af2badc40f7c2a51e8b5f7d340e9b7bf4caf52222e2631b6934e9906d2d5d`，patched tree
为 `1158208f5db6c4774ea5d4d8590aa5643ceaa17c`，strict manifest 为
`cb2a742b0cb9e1dfbb999cbb31d7c5756a8ad87afa17363034128c5b3d1eb3ef`。隔离 build 与
vendor replay 并发 13/13 连续三轮通过。首轮修复随后以 `38cfb5c` 本地提交。

修复提交后的两路独立复审再次给出 `CHANGES_REQUIRED`。最小反例证明 raw transport
方法可通过 object binding、属性赋值、计算键和动态 method selection 绕过 AST；ambient
`NODE_OPTIONS` 可在入口及两个 manifest Node 进程执行 preload，PATH shim 也可替代
Node/Git/tar。新增红测确认旧实现失败后，AST 改为拒绝显式 send/stream 提取与动态
computed callee；offline replay 改为只从固定系统候选路径解析工具，以空环境启动入口
Node，并向所有 Node/Git/tar 子进程显式传入最小环境。任意 JavaScript 数据流证明仍不在
该静态门禁的声明范围内。

第二轮修复后的提交前门禁为 integration 26/26、Codex 23/23、dependency graph 19/19、
offline replay 9/9，共 77/77；全仓 23 files / 475/475，bridge 15 files / 365/365。
format、lint、typecheck、build、离线 frozen install、实际 offline replay 和
`git diff --check` 均 exit 0。vendor script SHA 更新为
`bdbb935d7919e468964862247f54f3743781cf29cf647a8b4f448e4f4e03c0b0`；patched tree 与
strict manifest 仍为 `1158208f5db6c4774ea5d4d8590aa5643ceaa17c` /
`cb2a742b0cb9e1dfbb999cbb31d7c5756a8ad87afa17363034128c5b3d1eb3ef`。以上仍须形成新的
修复本地提交，再做独立复审和干净 HEAD 总门禁；当前不升级状态。

第二轮修复随后以 `8168bb1` 本地提交。其两路独立复审再次给出
`CHANGES_REQUIRED`：动态 element access 只在直接作为 callee 时被拒绝，经变量、computed
object binding、comma callee、`Reflect.apply` 或 `.call` 一跳提取仍可空集通过；同时
`#!/bin/zsh` 会在 `/usr/bin/env -i` 前读取 hostile `ZDOTDIR/.zshenv` 并写入
`LICENSES`。六个新增红测确认旧实现失败。

第三轮修复将动态 element access 的直接变量/赋值、computed binding、callee 子表达式及
Reflect dispatch 参数纳入 `dynamic_method_call`；正常数组/record 索引保持可用，任意深度
JavaScript 数据流证明仍明确不在本静态门禁范围。vendor script 改为 `/bin/zsh -f`，先禁用
用户级启动文件，再进入固定 executable 与空环境边界。提交前门禁为 integration 26/26、
Codex 23/23、dependency graph 24/24、offline replay 10/10，共 83/83；全仓 23 files /
481/481，bridge 15 files / 365/365。format、lint、typecheck、build、离线 frozen install、
实际 offline replay 和 `git diff --check` 均 exit 0。vendor script SHA 更新为
`0c3c1c6f81e86d5e0e7635320a6a5b8bccf5fd29b8576c43e811096a786d4e7f`；patched tree 与
strict manifest 不变。以上仍须形成新的修复本地提交，再做独立复审和干净 HEAD 总门禁；
当前不升级状态。

第三轮修复随后以 `b5e70f0` 本地提交。其独立复审再次给出
`CHANGES_REQUIRED`：`Reflect.get`、computed assignment、conditional/nullish/comma/object
initializer、static/compound assignment 与 tagged template 仍可作为一跳等价语法绕过
`dynamic_method_call`。卡片哈希证据、zsh/Node/PATH/Git 环境、symlink、隔离构建/replay
与 integration harness 未发现新的回归。

第四轮修复先新增九个审查反例；提交前只读缺口审计又以八个红测复现解构赋值、类字段、
`for…of`、decorator、throw/catch 与双重 `Function.call/apply` 调度。AST 现在把
`Reflect.get`、动态 computed property assignment、value-preserving
variable/property/compound/destructuring assignment、变量/类字段/loop/control-flow
initializer 或 binding、call/new/tagged-template/decorator callee 子表达式及直接
Reflect/Function dispatch 参数纳入 fail-closed 判定；可静态确定只产生 primitive 的二元
运算不误报为 callable。该声明只覆盖受支持入口内的直接一跳语法，不声称提供跨函数或任意
深度 JavaScript 数据流证明。

第四轮修复后的提交前门禁为 integration 26/26、Codex 23/23、dependency graph 41/41、
offline replay 10/10，共 100/100；全仓 23 files / 498/498，bridge 15 files / 365/365。
format、lint、typecheck、build、离线 frozen install、实际 offline replay 和
`git diff --check` 均 exit 0。vendor script SHA 保持
`0c3c1c6f81e86d5e0e7635320a6a5b8bccf5fd29b8576c43e811096a786d4e7f`；patched tree 与
strict manifest 仍为 `1158208f5db6c4774ea5d4d8590aa5643ceaa17c` /
`cb2a742b0cb9e1dfbb999cbb31d7c5756a8ad87afa17363034128c5b3d1eb3ef`。新的修复本地提交、
独立复审和干净 HEAD 总门禁仍待执行，当前不升级状态。

第四轮修复随后以 `28f0940` 本地提交。其两路独立复审再次给出
`CHANGES_REQUIRED`：`Reflect.get` 通过自身 `call/apply` 或直接 alias 调用时仍可空集通过，
常量计算属性赋值目标也未被静态折叠；复审同时建议把同等级的 class heritage、参数默认值与
对象 descriptor 纳入直接语法矩阵。历史卡片 evidence、zsh/Node/PATH/Git 环境、symlink、
隔离构建/replay 和 integration harness 未发现回归。

第五轮修复新增七个红测。AST 现在对任何直接 `Reflect.get` member reference 保守拒绝，
静态折叠单一定义的 const 字符串属性键，并覆盖 parameter/property/heritage initializer 与
descriptor `value`。assignment 目标只在 identifier、静态/可静态折叠属性或 destructuring
时作语法判定；任意 runtime-computed destination key，以及通过任意 helper/library 传递的值，
仍明确属于该静态语法门禁之外的数据流问题。

第五轮修复后的提交前门禁为 integration 26/26、Codex 23/23、dependency graph 48/48、
offline replay 10/10，共 107/107；全仓 23 files / 505/505，bridge 15 files / 365/365。
format、lint、typecheck、build、离线 frozen install、实际 offline replay 和
`git diff --check` 均 exit 0。vendor script、patched tree 与 strict manifest 均未变化。
新的修复本地提交、独立复审和干净 HEAD 总门禁仍待执行，当前不升级状态。

第五轮修复随后以 `88caebf` 本地提交。其两路独立复审再次给出
`CHANGES_REQUIRED`：destructuring default、computed descriptor、`Reflect.get` 的声明/赋值式
解构 alias、类型 wrapper 与不同词法块同名 const 仍可漏报。审查结论证明继续枚举
“像 callable 的上下文”不能形成稳定的 fail-closed 静态门禁。

第六轮修复新增六个红测，并把策略改为：除审计例外外，所有运行时计算属性访问均产生
`dynamic_method_call`。例外仅限简单 `=` 左值、确定产生 primitive 的比较/算术或固定
`Number` 检查、`snapshotRawMetadata` 内精确 `snapshot[key] = record[key]` 复制、
`CANCELLATION_TEXT[kind]` 与 `PROGRESS_TEXT[stage]`；RHS 动态访问仍独立拒绝。原上下文
枚举器已删除，任何直接 `Reflect.get` member、声明式或赋值式解构 alias 均拒绝。

第六轮修复后的提交前门禁为 integration 26/26、Codex 23/23、dependency graph 54/54、
offline replay 10/10，共 113/113；全仓 23 files / 511/511，bridge 15 files / 365/365。
format、lint、typecheck、build、离线 frozen install、实际 offline replay 和
`git diff --check` 均 exit 0。vendor script、patched tree 与 strict manifest 均未变化。
新的修复本地提交、独立复审和干净 HEAD 总门禁仍待执行，当前不升级状态。

第六轮修复随后以 `7e16ea1` 本地提交。其两路独立复审再次给出
`CHANGES_REQUIRED`：primitive-only、简单赋值与固定文件形状例外可被 call/new/coercion
或赋值结果消费；文件级 const 折叠没有词法 binding 证明，参数、`let`、catch 和局部
`Number` shadow 可漏报；`Reflect.get` 的 for-of、嵌套数组及 catch 解构 alias 也未覆盖。

第七轮修复先以 22 个新增用例固定回归矩阵，其中 21 个在旧分析器上复现漏检，另一个
可选调用用例锁定已有拒绝行为；随后删除 identifier const 折叠及
primitive/赋值/固定路径的所有计算属性例外。任何非字面量 element access 现在直接产生
`dynamic_method_call`，任何 `get` object binding 或 destructuring assignment 也保守拒绝。
生产侧把原有 14 个动态下标改写为静态 `includes`、固定字段、
`Object.defineProperty`、`Array.at`、四个 usage 字段单次读取和穷尽系统文案 switch；独立
TypeScript AST 正向断言要求四个受支持入口的运行时计算属性访问数恒为 0。

vendored 改动由 `0005-static-dynamic-access-boundary.patch` 记录，exact 6-path allowlist
与补丁 SHA `2bf899fe4e8b7040545591ec9eb0133f1f0a85864b6420397ebccf9f94f1fae3`
已锁定；patched tree 为 `2881144148cb3ef4d770853b02823a7c23eb3637`，strict manifest
为 `c283512b76d9070ea7da16558b4a3037882e4c4588cf7e353c0d8566b24485a4`。完整
0001–0005 可反向恢复 original tree `9abc1413bf4f44ab048985cbbcebe1e4fc099d8f`
后再正向恢复最终 tree。

第七轮修复后的提交前门禁为 integration 26/26、Codex 23/23、dependency graph 76/76、
offline replay 10/10，共 135/135；全仓 23 files / 533/533，bridge 15 files / 365/365。
format、lint、typecheck、build、离线 frozen install、实际 offline replay 和
`git diff --check` 均 exit 0。新的修复本地提交、独立复审和干净 HEAD 总门禁仍待执行，
当前不升级状态。

第七轮修复随后以 `7ef68fb` 本地提交。其两路独立复审再次给出
`CHANGES_REQUIRED`：`const R = Reflect; R.get(...)` 与 `(0, Reflect).get(...)` 可避开只识别
直接 `Reflect.get` 的判定；嵌套数组/对象及 for-of 解构赋值没有被追踪到真实赋值边界；
`rawClient[1 + 2]` 还会被字符串式常量折叠误认为字面键。

第八轮修复新增六个先红后绿回归。属性访问安全判定现在只接受 NumericLiteral、
StringLiteral 或 NoSubstitutionTemplateLiteral，不再折叠表达式；任何字面量 `get`
member、binding 或 assignment 均保守产生 `dynamic_method_call`，解构赋值会跨数组和嵌套
对象向上追踪至简单赋值或 for-in/for-of 边界。模块引用识别仍能将
`process["get" + "BuiltinModule"](...)` 归类为动态模块加载器，但该非字面量属性访问同时
继续被安全门禁拒绝。

第八轮修复后的提交前聚焦门禁为 integration 26/26、Codex 23/23、dependency graph
82/82、offline replay 10/10，共 141/141；全仓 23 files / 539/539，bridge 保持
15 files / 365/365。format、lint、typecheck、build、离线 frozen install、实际 offline
replay 和 `git diff --check` 均通过；新的修复本地提交、提交后独立复审和干净 HEAD
总门禁仍待执行，当前不升级状态。

第八轮修复随后以 `c210be4` 本地提交。两路提交后独立复审与干净 HEAD 总门禁仍待执行；
在 reviewer 明确批准前不标记 `STAGE_A_SEAMS_VERIFIED`。

状态同步后精确 HEAD 为 `1d74e03`。安全复审与全量复审均明确 `APPROVED`：上一轮六个
blocker 全部关闭，广义 `get` 拒绝是已记录的保守策略，文档、测试和供应链证据一致；
skip/todo/only 为 0。干净 HEAD 总门禁再次通过 23 files / 539 tests、bridge 15 files /
365 tests、Task 7 聚焦 141/141，以及离线 frozen install、format、lint、typecheck、build、
实际 offline replay、`git diff --check`、clean worktree 和 remote=0。Stage A 本地开发 seam
据此标记为 `STAGE_A_SEAMS_VERIFIED`；真实飞书/Codex E2E、macOS sandbox/网络阻断、部署和
24 小时可用性仍保持未验证。

## Stage A Review Gate

Reviewer 必须逐项确认：

- `git diff` 中没有未说明的上游代码改动。
- `PATCHES.md` 能把每个 bridge 改动映射到测试。
- 任一白名单缺失时无法进入 Codex。
- 任一非私聊入口无法下载附件或记录正文。
- runner 的静态 invocation、最小环境和参数篡改负测通过；“真实 Codex 能工作且模型生成工具命令无网络”在第四份计划取得目标机证据前保持 `UNVERIFIED_NO_FIXTURE`。
- bridge 中不存在直接 `lark-cli`、HTTP 飞书写入或 Secret 解密代码。
- 只有以上全部成立，阶段 A 才能标记 `STAGE_A_SEAMS_VERIFIED` 并进入第二份计划实现持久账本；这不等于生产 `PASS`、真实飞书 E2E 或部署授权。
