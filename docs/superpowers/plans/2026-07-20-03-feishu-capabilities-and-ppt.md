# 飞书业务能力与 Visual-First PPT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在持久账本和动作网关之上实现联系人、附件、消息、日历、会议妙记及 PPT 路由，并让自然语言只生成结构化能力请求而不直接调用飞书命令。

**Architecture:** `capabilities` 包负责从已解析意图生成读取请求或冻结动作草稿；`action-gateway` 中的 adapter 才能把合同转换为锁定版 `lark-cli` 命令。`executive-assistant` Skill 保存总裁可见的交互和确认规则；PPT 请求只路由到固定版本 `visual-first-ppt`，沿用其 route、approval、QA 和 delivery 状态机。

**Tech Stack:** TypeScript 5.6.3、Vitest 2.1.8、Zod 4.4.3、Luxon 3.7.2、UUID 14.0.1、`@larksuite/cli` 1.0.72、`visual-first-ppt` v0.3.0、Codex Skills。

## Global Constraints

- `lark-cli` 只能由 action gateway 调用；业务层不得 spawn、拼 shell 或发送自由 HTTP。
- Bot/User 身份由 capability 名固定，调用方不能提交自由 `identity` 或 `--as`。
- 联系人姓名重名必须停下让总裁选择；不得默认选择第一个结果。
- 默认通知身份为 Bot；只有明确要求“以我的名义”并再次确认才使用 User。
- `system_reply` 不接受目标参数；普通回复由 task_id、精确取消回复由 control_event_id 反查为原总裁私聊，control event 只允许文字。
- 日历固定使用总裁 User 身份和 `primary` 日历；创建、更新、参与人变更和取消都先确认。
- 妙记、VC Note 和逐字稿只按真实 API 证据报告；缺 `note_id` 不构造 Note。
- 第一版不调用 `minutes +upload`，不承诺自动创建原生 VC Note。
- PPT setup、doctor、全新飞书任务激活、生产生成、最终审批和交付是独立门禁。
- `visual-first-ppt` 使用 annotated tag `v0.3.0`：tag object `4962eb9bd5c55e8384b5228993c241b2220fcabb`、peeled commit `bb775f68f951c3e444d00623bc88976b20c13e7d`。
- PPT 关键文字、精确数据、表格、图表、坐标轴、引用、页码和 Logo 保持原生；生成图只承担视觉层。
- 真实飞书或 PPT 客户端测试留到第四份计划；本计划先完成自动合同和 fixture 测试。
- 计划中的 commit 必须另获明确授权；不包含 push、PR、发布或目标租户写入授权。

---

### Task 1: 定义能力合同、配置和身份矩阵

**Files:**
- Create: `packages/capabilities/package.json`
- Create: `packages/capabilities/tsconfig.json`
- Create: `packages/capabilities/src/contracts.ts`
- Create: `packages/capabilities/src/index.ts`
- Modify: `packages/contracts/src/gateway.ts`
- Create: `config/capabilities.yaml`
- Create: `config/feishu-scopes.yaml`
- Test: `packages/capabilities/test/contracts.test.ts`
- Test: `tests/contracts/capability-config.test.ts`

**Interfaces:**
- Produces: `CapabilityReadRequestSchema`、`MutationDraftSchema`、`CapabilityRegistry`。
- Consumes: `RunGatewayClient` from contracts。

- [ ] **Step 1: 写身份不可篡改红测**

```ts
it("rejects caller supplied identity and unknown fields", () => {
  expect(() => CapabilityReadRequestSchema.parse({ kind: "minutes.search", identity: "bot", filters: {} })).toThrow();
  expect(() => MutationDraftSchema.parse({ kind: "message.send", requestedIdentity: "default_bot", identity: "admin", target: { type: "user", openId: "ou_a" }, body: { type: "text", text: "x" } })).toThrow();
});

it("maps every enabled capability to exact scopes and identity", () => {
  const registry = loadCapabilityRegistry("config/capabilities.yaml", "config/feishu-scopes.yaml");
  for (const capability of registry.enabled()) {
    expect(capability.scopes.length).toBeGreaterThan(0);
    expect(["bot", "user"]).toContain(capability.identity);
  }
});
```

- [ ] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/capabilities test -- contracts
corepack pnpm vitest run tests/contracts/capability-config.test.ts
```

Expected: FAIL because schemas and config are absent。

- [ ] **Step 3: 实现严格 discriminated unions**

```ts
const RelativeTaskPathSchema = z.string().min(1).max(240).refine(
  (value) => !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") && !value.split("/").includes(".."),
  "relative_task_path_required",
);

export const CapabilityReadRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("contact.resolve_exact"), emails: z.array(z.string().email()).max(20).optional(), mobiles: z.array(z.string().min(6).max(32)).max(20).optional() }).strict(),
  z.object({ kind: z.literal("contact.search"), query: z.string().min(1).max(50), pageSize: z.number().int().min(1).max(30) }).strict(),
  z.object({ kind: z.literal("vc.search"), query: z.string().max(100).optional(), start: z.string().datetime(), end: z.string().datetime() }).strict(),
  z.object({ kind: z.literal("vc.detail"), meetingIds: z.array(z.string().min(1)).min(1).max(20) }).strict(),
  z.object({ kind: z.literal("vc.recording"), meetingIds: z.array(z.string().min(1)).min(1).max(20) }).strict(),
  z.object({ kind: z.literal("note.detail"), noteId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("note.transcript"), noteId: z.string().min(1), locale: z.enum(["zh_cn", "en_us", "ja_jp"]), outputRelativePath: RelativeTaskPathSchema }).strict(),
  z.object({ kind: z.literal("docs.fetch"), docToken: z.string().min(1), docFormat: z.enum(["markdown", "xml"]), scope: z.literal("full") }).strict(),
  z.object({ kind: z.literal("minutes.search"), query: z.string().max(100).optional(), start: z.string().datetime(), end: z.string().datetime(), ownerIds: z.array(z.string()).max(20).optional(), participantIds: z.array(z.string()).max(20).optional() }).strict(),
  z.object({ kind: z.literal("minutes.detail"), minuteToken: z.string().min(1), artifacts: z.array(z.enum(["summary", "todos", "chapters", "keywords", "transcript"])).min(1) }).strict(),
  z.object({ kind: z.literal("calendar.get"), eventId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("chat.inspect"), chatId: z.string().regex(/^oc_/)}).strict(),
  z.object({ kind: z.literal("message.resource.download"), messageId: z.string().min(1), fileKey: z.string().min(1), resourceType: z.enum(["file", "image"]), outputRelativePath: RelativeTaskPathSchema }).strict(),
]);
```

```ts
export const MessageDraftSchema = z.object({
  kind: z.literal("message.send"),
  requestedIdentity: z.enum(["default_bot", "explicit_user"]),
  target: z.union([
    z.object({ type: z.literal("user"), openId: z.string().regex(/^ou_/) }).strict(),
    z.object({ type: z.literal("chat"), chatId: z.string().regex(/^oc_/) }).strict(),
  ]),
  body: z.union([
    z.object({ type: z.literal("text"), text: z.string().min(1).max(20_000) }).strict(),
    z.object({ type: z.literal("file"), artifactId: z.string().uuid() }).strict(),
  ]),
}).strict();

const CalendarPatchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(20_000).optional(),
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
  zone: z.literal("Asia/Shanghai").optional(),
  attendeeOpenIds: z.array(z.string().regex(/^ou_/)).max(50).optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, "calendar_patch_required");

const RecurrenceScopeSchema = z.enum(["single", "all", "this_and_following"]);
export const CalendarMutationDraftSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("calendar.create"), title: z.string().min(1).max(500), description: z.string().max(20_000).optional(), start: z.string().datetime(), end: z.string().datetime(), zone: z.literal("Asia/Shanghai"), attendeeOpenIds: z.array(z.string().regex(/^ou_/)).max(50).default([]) }).strict(),
  z.object({ kind: z.literal("calendar.update"), eventId: z.string().min(1), beforeHash: z.string().regex(/^sha256:[a-f0-9]{64}$/), patch: CalendarPatchSchema, recurrenceScope: RecurrenceScopeSchema.optional() }).strict(),
  z.object({ kind: z.literal("calendar.cancel"), eventId: z.string().min(1), beforeHash: z.string().regex(/^sha256:[a-f0-9]{64}$/), recurrenceScope: RecurrenceScopeSchema.optional() }).strict(),
]);

export const MutationDraftSchema = z.union([MessageDraftSchema, CalendarMutationDraftSchema]);
```

- [ ] **Step 4: 写能力配置**

`capabilities.yaml` 每项必须含 `enabled`、`identity`、`readOrWrite`、`requiresConfirmation`、`reconcileStrategy`、`smokeFixture`。`feishu-scopes.yaml` 分 `bot` 与 `user` 精确 scope；禁止 `*`、`recommend` 或未被 capability 引用的 scope。

- [ ] **Step 5: 运行绿测并经授权提交**

```bash
corepack pnpm --filter @executive-assistant/capabilities test
corepack pnpm vitest run tests/contracts/capability-config.test.ts
git add packages/capabilities packages/contracts config pnpm-lock.yaml
git commit -m "feat(capabilities): define Feishu capability contracts"
```

### Task 2: 实现固定身份的 lark-cli read dispatcher 与附件编排

**Files:**
- Create: `packages/action-gateway/src/adapters/read-dispatch.ts`
- Create: `packages/action-gateway/src/adapters/message-resource.ts`
- Create: `packages/bridge/src/ingress/attachment-intake.ts`
- Test: `packages/action-gateway/test/adapters/read-dispatch.test.ts`
- Test: `packages/action-gateway/test/adapters/message-resource.test.ts`
- Test: `packages/bridge/test/attachment-intake.test.ts`

**Interfaces:**
- Produces: `ReadDispatcher.execute(request): Promise<unknown>`。
- Consumes: secure `LarkCliRunner.runBot/runUser` from Plan 02。
- Consumes: `stageAttachment` from Plan 02。

- [ ] **Step 1: 写结构化能力请求红测**

```ts
it("uses user identity for name search", async () => {
  await dispatcher.execute({ kind: "contact.search", query: "王伟", pageSize: 20 });
  expect(runner.runUser).toHaveBeenCalledWith({
    version: 1,
    operation: "contact.search",
    payload: { query: "王伟", pageSize: 20 },
  });
});

it("downloads a message resource to a relative staging path", async () => {
  await dispatcher.execute({ kind: "message.resource.download", messageId: "om_a", fileKey: "file_a", resourceType: "file", outputRelativePath: "incoming/report.pdf" });
  expect(runner.runBot).toHaveBeenCalledWith({
    version: 1,
    operation: "message.resource.download",
    payload: {
      messageId: "om_a",
      fileKey: "file_a",
      resourceType: "file",
      outputRelativePath: "incoming/report.pdf",
    },
  });
});
```

- [ ] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/action-gateway test -- read-dispatch message-resource
corepack pnpm --filter @executive-assistant/bridge test -- attachment-intake
```

Expected: FAIL because adapters are absent。

- [ ] **Step 3: 实现 capability-to-argv 静态表**

每个 kind 只能构造版本化的结构化 capability request；Task 6 的受信静态 registry 再使用独立内部 builder 生成固定 argv，并自行追加 identity、profile 与 JSON format。adapter 不得提交 argv、identity、profile、format、method、endpoint 或 URL，也不得把未验证的 output path 直接拼入命令。所有输出路径先经相对路径 schema 和任务 realpath policy，再作为结构化 payload 交给 runner。`chat.inspect` 固定映射为 Bot 路由 `chat.inspect`，其内部 builder 才生成 `lark-cli im chats get --chat-id VALIDATED_OC_ID --as bot --format json`；只用于证明机器人已在既有群，不开放 chat create/update。

- [ ] **Step 4: 接通附件安全阶段**

`attachment-intake` 先从账本取得 task directory 和当前数量/总大小，再通过 read dispatcher 下载 temp 文件，最后调用 `stageAttachment` 做 MIME、SHA、权限和原子移动；任何附件正文都只作为 `untrusted_input` 注入 Codex prompt。

- [ ] **Step 5: 运行绿测并经授权提交**

```bash
corepack pnpm --filter @executive-assistant/action-gateway test -- read-dispatch message-resource
corepack pnpm --filter @executive-assistant/bridge test -- attachment-intake
git add packages/action-gateway packages/bridge
git commit -m "feat(attachments): stage Feishu files as untrusted data"
```

### Task 3: 实现联系人解析、消歧和显式别名

**Files:**
- Create: `packages/capabilities/src/contact/recipient-resolver.ts`
- Create: `packages/capabilities/src/contact/alias-directory.ts`
- Create: `packages/action-gateway/src/adapters/contact.ts`
- Test: `packages/capabilities/test/recipient-resolver.test.ts`
- Test: `packages/capabilities/test/alias-directory.test.ts`
- Test: `packages/action-gateway/test/adapters/contact.test.ts`

**Interfaces:**
- Produces: `RecipientResolver.resolve(query, context): RecipientResolution`。
- Produces: `rememberAlias({explicitUserIntent:true,...})`。
- Consumes: `contact.resolve_exact` Bot read and `contact.search` User read。

- [ ] **Step 1: 写精确解析、重名与跨 App 红测**

```ts
it("returns needs_selection for same-name candidates", async () => {
  gateway.read.mockResolvedValue({ users: [candidate("王伟", "研发"), candidate("王伟", "财务")] });
  await expect(resolver.resolve({ kind: "name", value: "王伟" }, context)).resolves.toMatchObject({ kind: "needs_selection" });
});

it("never reuses an alias after app id changes", async () => {
  await aliases.rememberAlias({ explicitUserIntent: true, alias: "王总", recipient: recipientA, appId: "cli_a", tenantKey: "t" });
  expect(await aliases.lookup("王总", { appId: "cli_b", tenantKey: "t" })).toBeNull();
});
```

- [ ] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/capabilities test -- recipient-resolver alias-directory
corepack pnpm --filter @executive-assistant/action-gateway test -- contact
```

Expected: FAIL because resolver and adapter are absent。

- [ ] **Step 3: 实现邮箱/手机号 Bot 精确解析**

adapter 固定调用：

```bash
lark-cli api POST /open-apis/contact/v3/users/batch_get_id --as bot --params '{"user_id_type":"open_id"}' --data @REQUEST.json --format json
```

`REQUEST.json` 由网关在私有 temp dir 写入并在调用后删除，字段只允许 `emails` 与 `mobiles`。不得把邮箱/手机号写入日志。

- [ ] **Step 4: 实现 User 姓名搜索与最小候选显示**

固定调用 `contact +search-user --query VALUE --page-size 20 --as user --format json`。候选对总裁只显示姓名和最小部门信息；0 个映射 `BLOCKED_VISIBILITY`，缺 scope 映射 `BLOCKED_SCOPE`，多个返回 `needs_selection`。

- [ ] **Step 5: 实现别名显式保存**

别名记录至少绑定 `app_id`、`tenant_key`、open_id、显示名和创建时间；只有函数参数类型为 `explicitUserIntent: true` 才能写入。普通选择不自动保存。

- [ ] **Step 6: 运行绿测并经授权提交**

```bash
corepack pnpm --filter @executive-assistant/capabilities test -- recipient-resolver alias-directory
corepack pnpm --filter @executive-assistant/action-gateway test -- contact
git add packages/capabilities packages/action-gateway
git commit -m "feat(contacts): resolve recipients without guessing"
```

### Task 4: 实现会议、妙记、Note 和逐字稿证据链

**Files:**
- Create: `packages/capabilities/src/minutes/meeting-locator.ts`
- Create: `packages/capabilities/src/minutes/minutes-orchestrator.ts`
- Create: `packages/capabilities/src/minutes/note-router.ts`
- Create: `packages/capabilities/src/minutes/transcript-artifact.ts`
- Create: `packages/action-gateway/src/adapters/minutes.ts`
- Test: `packages/capabilities/test/minutes-orchestrator.test.ts`
- Test: `packages/capabilities/test/note-router.test.ts`
- Test: `packages/action-gateway/test/adapters/minutes.test.ts`

**Interfaces:**
- Produces: `searchMinutes(intent)` and `loadArtifacts(input)`。
- Produces: `MinutesEvidence` with source token, local path, SHA-256, size and API envelope hash。

- [ ] **Step 1: 写事实边界红测**

```ts
it("reports absent note_id without fabricating a note", async () => {
  gateway.read.mockResolvedValue({ minuteToken: "min_a", noteId: null });
  const result = await orchestrator.loadArtifacts({ taskId, minuteToken: "min_a", artifacts: ["summary"] });
  expect(result.note).toEqual({ kind: "not_present" });
});

it("does not summarize when transcript retrieval failed", async () => {
  gateway.read.mockRejectedValue(new CapabilityError("MINUTES_NOT_READY"));
  await expect(orchestrator.loadArtifacts({ taskId, minuteToken: "min_a", artifacts: ["transcript"] })).rejects.toMatchObject({ status: "FAILED_DEPENDENCY" });
  expect(summaryModel).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/capabilities test -- minutes-orchestrator note-router
corepack pnpm --filter @executive-assistant/action-gateway test -- minutes
```

Expected: FAIL because minutes capability is absent。

- [ ] **Step 3: 实现固定 read commands**

使用锁定版存在的命令：

```bash
lark-cli vc +search --query KEYWORD --start RFC3339 --end RFC3339 --as user --format json
lark-cli vc +detail --meeting-ids MEETING_IDS --as user --format json
lark-cli vc +recording --meeting-ids MEETING_IDS --as user --format json
lark-cli minutes +search --query KEYWORD --start RFC3339 --end RFC3339 --as user --format json
lark-cli minutes +detail --minute-tokens TOKENS --summary --todo --chapter --keyword --transcript --output-dir RELATIVE_DIR --as user --format json
lark-cli note +detail --note-id NOTE_ID --as user --format json
lark-cli note +transcript --note-id NOTE_ID --locale zh_cn --transcript-format markdown --output RELATIVE_FILE --as user --format json
lark-cli docs +fetch --doc DOC_TOKEN --scope full --detail simple --doc-format markdown --as user --format json
```

实施 adapter 前先运行锁定版 `lark-cli skills read lark-doc references/lark-doc-fetch.md`，把版本匹配的读取约束记录进 `docs/permissions/capability-matrix.md`；运行时只用上面的固定只读参数，不让 Codex 自由选择 docs flags。时间范围超过一个月拆窗；owner 与 participant 查询分别执行后按 minute token 去重；默认累计不超过 50 条。note_id 为空时准确返回 `not_present`；有 note_id 时先 `note +detail`，再按请求读取 unified transcript 或其 document token，所有输出相对路径均经过 task realpath policy。

- [ ] **Step 4: 实现错误映射和证据登记**

`2091003 → FAILED_DEPENDENCY/MINUTES_NOT_READY`；`2091005 → BLOCKED_RESOURCE_PERMISSION`；OAuth 失败 → `BLOCKED_USER_AUTH`；scope 缺失 → `BLOCKED_SCOPE`。逐字稿写入任务目录后登记 SHA、大小、token 和来源命令结果 hash，再允许二次总结。

- [ ] **Step 5: 加无 note、有 note、未转写、无权限 fixture 测试**

测试明确断言 `minutes +upload`、`+summary`、`+todo` 和其他写命令从未调用。

- [ ] **Step 6: 运行绿测并经授权提交**

```bash
corepack pnpm --filter @executive-assistant/capabilities test -- minutes-orchestrator note-router
corepack pnpm --filter @executive-assistant/action-gateway test -- minutes
git add packages/capabilities packages/action-gateway tests/fixtures
git commit -m "feat(minutes): build evidence-backed meeting preprocessing"
```

### Task 5: 实现第三方通知、本人发送和 system reply

**Files:**
- Create: `packages/capabilities/src/messaging/message-orchestrator.ts`
- Create: `packages/capabilities/src/messaging/system-reply-policy.ts`
- Create: `packages/action-gateway/src/adapters/message.ts`
- Test: `packages/capabilities/test/message-orchestrator.test.ts`
- Test: `packages/capabilities/test/system-reply-policy.test.ts`
- Test: `packages/action-gateway/test/adapters/message.test.ts`

**Interfaces:**
- Produces: `createMessageDraft(intent, recipient): MessageDraft`。
- Produces: `sendSystemReply(taskId, body)` with no target argument。
- Consumes: action prepare/approve/dispatch from Plan 02。

- [ ] **Step 1: 写身份、批量和跨 chat 红测**

```ts
it("defaults to bot and rejects multiple targets", () => {
  expect(createMessageDraft({ text: "请通知王伟", explicitUserIdentity: false }, recipientA).requestedIdentity).toBe("default_bot");
  expect(() => createMessageDraft({ text: "通知所有人", explicitUserIdentity: false }, [recipientA, recipientB])).toThrow(/batch_disabled/);
});

it("derives system reply target from task", async () => {
  await service.sendSystemReply(taskId, { type: "text", value: "处理完成" });
  expect(cli.runBot).toHaveBeenCalledWith(expect.arrayContaining(["--chat-id", "oc_president"]));
});
```

- [ ] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/capabilities test -- message-orchestrator system-reply-policy
corepack pnpm --filter @executive-assistant/action-gateway test -- message
```

Expected: FAIL because messaging capability is absent。

- [ ] **Step 3: 实现冻结预览和固定命令**

预览必须包含身份、精确接收人 ID 的脱敏显示、目标类型、完整消息正文或文件信息和影响。执行时 Bot/User 只由 `requestedIdentity` 的封闭转换决定。文字正文、接收人和 UUID 写入 gateway 私有 `0600` JSON 文件，argv 只使用固定 endpoint 与 `@file`：

```bash
lark-cli api POST /open-apis/im/v1/messages --params @PARAMS.json --data @BODY.json --as bot --format json
lark-cli api POST /open-apis/im/v1/messages --params @PARAMS.json --data @BODY.json --as user --format json
```

`PARAMS.json` 只含固定枚举 `receive_id_type=open_id|chat_id`；`BODY.json` 只含冻结的 `receive_id`、`msg_type`、`content` 与稳定 `uuid`。两个文件调用后安全删除；不得把正文改回 `--text` argv。

本任务文件回传使用锁定版已经存在的 media shortcut，不自行实现上传协议：

```bash
lark-cli im +messages-send --chat-id CHAT_ID --file RELATIVE_TASK_FILE --idempotency-key UUID --as bot --format json
```

User 身份发送文件时只把固定 `--as bot` 换为 `--as user`。`RELATIVE_TASK_FILE` 必须先由 task_files 的 artifact ID 解析、realpath 与 SHA 复核，工作目录固定为对应 task；绝对路径、`..`、URL、未登记文件和跨 task 文件全部拒绝。system reply 只能使用 Bot 版本和账本推导的原总裁 chat。runner 与日志不得记录完整 argv 中的 chat/user ID。

- [ ] **Step 4: 实现 UNKNOWN 对账和群限制**

群目标在 prepare 前调用 `chat.inspect`，证明机器人已在既有群；不提供 chat create 能力。UNKNOWN 有已返回 message_id 时按 message_id 查询；只有 UUID 而没有官方查询能力时保持 UNKNOWN，或在人工核对后进入 `RECONCILED(reconcile_outcome=INDETERMINATE)`，不自动重发。若未来证明同 UUID 再 POST 在有效窗口内只返回原动作回执，须单独审阅后才能启用。

- [ ] **Step 5: 运行绿测并经授权提交**

```bash
corepack pnpm --filter @executive-assistant/capabilities test -- message-orchestrator system-reply-policy
corepack pnpm --filter @executive-assistant/action-gateway test -- message
git add packages/capabilities packages/action-gateway
git commit -m "feat(messages): enforce identity and confirmation policy"
```

### Task 6: 实现个人日历创建、更新、参与人和取消

**Files:**
- Create: `packages/capabilities/src/calendar/calendar-orchestrator.ts`
- Create: `packages/capabilities/src/calendar/recurrence-plan.ts`
- Create: `packages/action-gateway/src/adapters/calendar.ts`
- Test: `packages/capabilities/test/calendar-orchestrator.test.ts`
- Test: `packages/capabilities/test/recurrence-plan.test.ts`
- Test: `packages/action-gateway/test/adapters/calendar.test.ts`

**Interfaces:**
- Produces: `CalendarMutationDraft` variants create/update/cancel。
- Produces: `RecurrenceScope = single | all | this_and_following`。
- Consumes: User identity only, calendar `primary` only。

- [ ] **Step 1: 写时区、原时长和重复范围红测**

```ts
it("preserves duration when only start changes", async () => {
  gateway.read.mockResolvedValue(eventSnapshot({ start: "2026-07-21T10:00:00+08:00", end: "2026-07-21T11:00:00+08:00" }));
  const draft = await calendar.update({ eventId: "evt_a", newStart: "2026-07-21T14:00:00+08:00", zone: "Asia/Shanghai" });
  expect(draft.patch.end).toBe("2026-07-21T15:00:00+08:00");
});

it("requires an explicit scope for recurring events", async () => {
  gateway.read.mockResolvedValue(recurringEventSnapshot());
  await expect(calendar.cancel({ eventId: "evt_a" })).rejects.toThrow(/recurrence_scope_required/);
});
```

- [ ] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/capabilities test -- calendar-orchestrator recurrence-plan
corepack pnpm --filter @executive-assistant/action-gateway test -- calendar
```

Expected: FAIL because calendar capability is absent。

- [ ] **Step 3: 实现 create/update/cancel 命令适配**

gateway 先用只读命令解析 `primary` 的真实 calendar_id。标题、描述、时间、参与人、action marker 与通知选项写入 `0600` 参数/正文文件，执行器固定调用：

```bash
lark-cli api POST /open-apis/calendar/v4/calendars/CALENDAR_ID/events --params @PARAMS.json --data @BODY.json --as user --dry-run --format json
lark-cli api PATCH /open-apis/calendar/v4/calendars/CALENDAR_ID/events/EVENT_ID --params @PARAMS.json --data @BODY.json --as user --dry-run --format json
lark-cli api DELETE /open-apis/calendar/v4/calendars/CALENDAR_ID/events/EVENT_ID --params @PARAMS.json --as user --dry-run --format json
```

执行批准动作时仅去掉 `--dry-run`，其余 method、endpoint、params/body 文件 hash 必须与冻结 payload 和预览一致；调用方不能提交自由 URL。

- [ ] **Step 4: 实现重复日程和 UNKNOWN 对账**

`single`、`all`、`this_and_following` 生成显式有序子操作；后一种包含截短原系列与创建新系列，任一子操作都独立写入 action ledger。create UNKNOWN 按 action marker + time window 查询；update/cancel UNKNOWN 读 `calendar +get --calendar-id primary --event-id ID --as user --format json`。

- [ ] **Step 5: 运行绿测并经授权提交**

```bash
corepack pnpm --filter @executive-assistant/capabilities test -- calendar-orchestrator recurrence-plan
corepack pnpm --filter @executive-assistant/action-gateway test -- calendar
git add packages/capabilities packages/action-gateway pnpm-lock.yaml
git commit -m "feat(calendar): add confirmed personal calendar actions"
```

### Task 7: 创建 executive-assistant Skill

**Files:**
- Create: `skills/executive-assistant/SKILL.md`
- Create: `skills/executive-assistant/references/interaction.md`
- Create: `skills/executive-assistant/references/feishu-capabilities.md`
- Create: `skills/executive-assistant/references/ppt-routing.md`
- Create: `skills/executive-assistant/references/error-model.md`
- Test: `tests/contracts/executive-assistant-skill.test.ts`

**Interfaces:**
- Consumes: the exact executable in `ASSISTANT_GATEWAY_CLIENT` only；不发现或调用 raw `lark-cli`。
- Produces: natural-language routing rules and response contract。
- Delegates: all presentation production to installed `visual-first-ppt`。

- [ ] **Step 1: 写 Skill contract 红测**

```ts
it("contains every hard boundary", () => {
  const skill = readFileSync("skills/executive-assistant/SKILL.md", "utf8");
  for (const phrase of [
    "只接受总裁私聊", "外部动作先预览再确认", "不得直接调用 lark-cli",
    "不得猜测重名联系人", "不得伪造会议纪要", "visual-first-ppt",
    "INTERRUPTED_REQUIRES_CONFIRMATION",
  ]) expect(skill).toContain(phrase);
});
```

- [ ] **Step 2: 运行红测**

Run:

```bash
corepack pnpm vitest run tests/contracts/executive-assistant-skill.test.ts
```

Expected: FAIL because Skill is absent。

- [ ] **Step 3: 写自然语言路由与中止规则**

Skill 明确四类任务：本地读取/生成、飞书只读、飞书写入、PPT。调用飞书能力时，只在当前 task 的 `0700` 工作目录写 `0600` request JSON，再把它作为 stdin 交给 `ASSISTANT_GATEWAY_CLIENT`；请求不得含 task_id、identity、chat、endpoint 或自由命令，响应必须通过合同解析。精确的“停一下/停止当前任务/取消这个任务”由 bridge 在启动新 Codex run 前写入 control ledger 并处理，不路由给 Skill；若外部动作已经发生，回复只列事实，不宣称回滚。

- [ ] **Step 4: 写错误回复合同**

每个错误只回答：哪一步未完成、是否产生外部影响、下一步只需做什么；使用统一 `BLOCKED_*`/`FAILED_DEPENDENCY` 状态，不展示命令、堆栈或 token。

- [ ] **Step 5: 验证 Skill 结构**

Run:

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py" skills/executive-assistant
corepack pnpm vitest run tests/contracts/executive-assistant-skill.test.ts
```

Expected: `Skill is valid` and tests PASS。

- [ ] **Step 6: 经授权后提交 Task 7**

```bash
git add skills/executive-assistant tests/contracts/executive-assistant-skill.test.ts
git commit -m "feat(skill): add executive assistant workflow"
```

### Task 8: 集成 visual-first-ppt 的安装、路由和产物合同

**Files:**
- Create: `packages/capabilities/src/ppt/ppt-router.ts`
- Create: `packages/capabilities/src/ppt/ppt-capability-probe.ts`
- Create: `packages/capabilities/src/ppt/ppt-artifact-validator.ts`
- Create: `packages/contracts/src/ppt.ts`
- Test: `packages/capabilities/test/ppt-router.test.ts`
- Test: `packages/capabilities/test/ppt-capability-probe.test.ts`
- Test: `packages/capabilities/test/ppt-artifact-validator.test.ts`
- Modify: `skills/executive-assistant/references/ppt-routing.md`

**Interfaces:**
- Produces: `PptRoute = create | template | edit`。
- Produces: `PptCapabilityProbeResult` and `PptDeliverables`。
- Consumes: installed `visual-first-ppt` public entry and its state files；不复制其脚本。

- [ ] **Step 1: 写路由和 setup 分离红测**

```ts
it.each([
  [{ text: "做一份发布会PPT", attachments: [] }, "create"],
  [{ text: "按这个模板做", attachments: [pptx("template.pptx")] }, "template"],
  [{ text: "修改第4页", attachments: [pptx("source.pptx")] }, "edit"],
])("routes a clear request", (input, expected) => {
  expect(routePpt(input)).toEqual({ kind: "selected", route: expected });
});

it("does not mark setup verified from doctor alone", () => {
  expect(computeSetupStatus({ doctorStatus: "PASS", activationStatus: "UNVERIFIED" })).toBe("SETUP_NOT_VERIFIED");
});
```

- [ ] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/capabilities test -- ppt-router ppt-capability-probe ppt-artifact-validator
```

Expected: FAIL because PPT integration types are absent。

- [ ] **Step 3: 实现三路路由与首轮停点**

明确请求直接选 route；歧义只问一次三选一。进入新的 PPT 项目首轮时，回复必须完整暴露 route contract 和该 route 的批准门禁，然后结束当前 turn，不读取附件或开始制作。setup/upgrade turn 不得同时嵌套启动一个 PPT production Codex。

- [ ] **Step 4: 固化 visual-first-ppt 状态机**

`create/template`：`OUTLINE_REVIEW → OUTLINE_APPROVED → VISUAL_REVIEW → VISUAL_LOCKED → BUILDING → QA → FINAL_REVIEW → FINAL_APPROVED → DELIVERED`。

`edit`：`COMPATIBILITY_REVIEW → SCOPE_REVIEW → SCOPE_APPROVED → CHANGE_PREVIEW → BUILDING → QA → FINAL_REVIEW → FINAL_APPROVED → DELIVERED`。

批准记录必须含 artifact hash、时间和用户原消息；内容或视觉变化按原 Skill 的 invalidation matrix 回退。

- [ ] **Step 5: 实现能力探针和产物验证**

探针必须区分 fixed commit 安装、doctor、全新飞书 task/Codex session 激活、Presentations、imagegen 和 production route。产物验证要求非空 preview、PPTX、PDF、ZIP、manifest、QA report；只有 preview/PPTX/PDF 默认回传，ZIP 保存在持久目录。

- [ ] **Step 6: 固化 QA 与交付要求**

强制 `pptxParse`、`pdfParse`、页数/画布、overflow、overlap、placeholder、relationship、font、native objects、data mismatch、PPTX/PDF/preview parity；硬零项为 overflow、unexpectedOverlap、unresolvedPlaceholder、brokenRelationship、dataMismatch。每页四维评分至少 `4/5`，目标 PowerPoint/WPS 必须打开确认。

- [ ] **Step 7: 运行绿测并经授权提交**

```bash
corepack pnpm --filter @executive-assistant/capabilities test -- ppt-router ppt-capability-probe ppt-artifact-validator
git add packages/capabilities packages/contracts skills/executive-assistant/references/ppt-routing.md
git commit -m "feat(ppt): integrate visual-first presentation workflow"
```

### Task 9: 阶段 C 能力合同与 fixture 门禁

**Files:**
- Create: `tests/fixtures/lark-cli/contact-exact-one.json`
- Create: `tests/fixtures/lark-cli/contact-ambiguous.json`
- Create: `tests/fixtures/lark-cli/calendar-event.json`
- Create: `tests/fixtures/lark-cli/minutes-complete.json`
- Create: `tests/fixtures/lark-cli/minutes-no-note.json`
- Create: `tests/fixtures/lark-cli/minutes-not-ready.json`
- Create: `tests/integration/capability-flow.test.ts`
- Create: `docs/permissions/capability-matrix.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Tasks 1–8 and Plan 02 gateway harness。
- Produces: stage-C automated capability evidence。

- [ ] **Step 1: 写端到端 fixture 红测**

```ts
it("resolves, previews, confirms and sends exactly once", async () => {
  const harness = await capabilityHarness({ fixtures: "tests/fixtures/lark-cli" });
  const preview = await harness.handle("通知王伟，明早十点开会");
  expect(preview.state).toBe("PREPARED");
  await harness.confirm(preview.actionId, preview.nonce);
  await harness.replayConfirmation(preview.actionId, preview.nonce);
  expect(harness.remoteCalls("message.send")).toHaveLength(1);
});
```

- [ ] **Step 2: 运行红测并补齐 fixtures**

Run:

```bash
corepack pnpm vitest run tests/integration/capability-flow.test.ts
```

Expected: initial FAIL；补齐脱敏 fixture 和 harness 后 PASS。

- [ ] **Step 3: 验证禁止能力不可达**

断言批量广播、创建群、修改共享权限、妙记上传、Note 创建、任意 HTTP、自由 identity 和 raw lark-cli 都不存在于 registry，直接请求返回 `BLOCKED_CAPABILITY`。

- [ ] **Step 4: 执行阶段 C 全量质量门**

Run:

```bash
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
git diff --check
```

Expected: all exit `0`；所有 capability fixture tests PASS，无安全用例 skipped。

- [ ] **Step 5: 经授权后提交阶段 C 收口**

```bash
git add tests/fixtures tests/integration/capability-flow.test.ts docs/permissions/capability-matrix.md CHANGELOG.md
git commit -m "test: verify Feishu capability contracts"
```

## Stage C Review Gate

Reviewer 必须确认：

- 每个 adapter 的 argv 与 `lark-cli 1.0.72 --help/schema` 对得上。
- Bot/User 身份不能由模型或附件内容改变。
- 联系人、妙记、Note 和日历的事实边界都存在负向测试。
- 每个外部写能力先 PREPARED，确认后最多执行一次，UNKNOWN 不盲重试。
- executive-assistant Skill 不包含飞书 SDK、PPT 实现或秘密读取逻辑。
- visual-first-ppt 的安装、doctor、激活、route gates、QA、目标客户端和交付证据没有合并成一个 PASS。
- 只有以上全部成立，阶段 C 才能标记 `PASS` 并进入真实安装与验收计划。
