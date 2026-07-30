# 仓库执行边界

本仓库用于单台专用 Mac mini 上的飞书 Codex 总裁助理。任何实现、审查或文档工作都必须先确认当前阶段和证据等级，不能把本地 seam 测试写成真实运行结论。

## 开工前读取顺序

1. `README.md`
2. `CHANGELOG.md`
3. `docs/superpowers/specs/2026-07-20-codex-feishu-executive-assistant-design.md`
4. `docs/superpowers/plans/2026-07-20-codex-feishu-executive-assistant-roadmap.md`
5. 当前阶段计划
6. `dependencies.lock.json`
7. `packages/bridge/UPSTREAM.md` 与 `packages/bridge/PATCHES.md`

聊天摘要不能覆盖这些文件、Git 状态、测试结果或真实验收证据。

## 必须保持的安全边界

- 只接受已配对总裁在原私聊中的受支持事件。群聊、错人、错 chat/app/tenant、未知事件或畸形 metadata 必须在读取正文、附件或产生任务副作用前拒绝。
- bridge 与 Codex 不得直接调用飞书业务写 API、HTTP endpoint、raw `lark-cli` 或旧 adapter。
  业务读写只能经强类型 gateway。外部动作必须先进入持久账本；已配对总裁完整私聊仅能按已确认
  规格直接授权日程、内部人员通知和基于当前 Base 证据的新建云文档，其他动作继续走不可变预览与
  本人确认，不存在通用跳过确认开关。
- Codex 的 argv、env、cwd、binary、socket 与 gateway client 不能由消息或 skill 自由覆盖。Secret、Token、完整人员 ID、客户正文、原始 SDK error、代理和 raw CLI 路径不得进入 Codex env、argv、日志、报告或测试快照。
- task/workspace/socket/release 路径必须经过 canonical realpath、no-symlink、唯一边界和精确权限验证。不能回退到临时目录、当前目录或调用方自选路径。
- 中断、失败或不确定的任务/动作不得静默重跑。未取得真实结果时保持失败、需确认或 `UNKNOWN`，不得伪造成功。
- vendored legacy 文件可以保留用于审计；“文件存在”不等于受支持入口可达。

## 证据用语

- fake、mock、静态 import graph、doctor、feature probe、loaded process 和本地 manifest 只能证明相应 seam。
- 没有目标 Mac、真实飞书租户、真实 Codex、真实签名/UDS/sandbox/网络阻断或持久数据库证据时，必须标记 `UNVERIFIED_NO_FIXTURE`。
- `STAGE_A_SEAMS_VERIFIED` 是开发门禁，不是运行时 `AssistantStatus`，也不代表生产 `PASS`、部署完成或 24 小时可用。
- 测试不得用 skip、todo、only 或宽松字符串搜索掩盖缺失证据。

## 质量与供应链命令

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm format:check
corepack pnpm lint
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
corepack pnpm --filter @executive-assistant/bridge test
corepack pnpm --filter @executive-assistant/bridge typecheck
./scripts/vendor-bridge --offline-replay
corepack pnpm exec vitest run tests/contracts/vendor-provenance.test.ts tests/contracts/vendor-manifest.test.ts tests/contracts/vendor-replay.test.ts
git diff --check
```

离线 replay 必须在无网络条件下验证 lock、补丁顺序、补丁 SHA、原始 tree、最终 tree 和 strict manifest，且不得修改 `packages/bridge` 或 `LICENSES`。

## 修改与 Git 门禁

- 不得自动升级固定上游、依赖版本或使用 `latest`。
- 每个 bridge 上游改动都必须形成单独命名的审计 patch，并同步 `PATCHES.md`、`dependencies.lock.json`、tree、strict manifest、许可证证据和回归测试。
- 每次本地提交都要同步 `CHANGELOG.md` 与 README 可见状态。
- local edit、local commit、remote 创建/配置、push、PR、merge、deploy、release 和真实飞书写操作是独立授权门禁；前一项授权不包含后一项。
- 禁止把 App ID、Secret、Token、真实 open_id/chat_id、客户正文或机器私有路径提交到仓库。

详细开发和供应链操作见 `docs/runbook/development.md`。
