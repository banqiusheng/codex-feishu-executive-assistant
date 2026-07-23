# 持久任务账本与安全动作网关 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每个入站事件、任务、审批和飞书动作都有可恢复的唯一事实，并让 Codex 在拿不到凭据和原始 `lark-cli` 的前提下通过受控网关完成读写。

**Architecture:** `job-store` 用 SQLite 事务实现事件去重、单消费者租约、任务中断和动作状态机；`action-gateway` 通过权限为 `0600` 的 Unix socket 接受 Zod 严格协议，所有写入先冻结 payload 再由总裁确认。Keychain 与 `lark-cli` 只存在于网关侧，Codex 只能获得脱敏结构化结果。

**Tech Stack:** Node.js 20/22/24/26 偶数主版本、TypeScript 5.6.3、Vitest 2.1.8、better-sqlite3 12.11.1、proper-lockfile 4.1.2、json-canonicalize 2.0.0、file-type 21.1.1、Zod 4.4.3、YAML 2.9.0、Swift 5、macOS Security.framework、Unix domain socket、`@larksuite/cli` 1.0.72。

## Global Constraints

- SQLite 固定启用 WAL、`foreign_keys=ON`、`busy_timeout=5000` 和 `synchronous=FULL`。
- `(app_id, tenant_key, event_id)` 是入站事件唯一键；重复事件不得产生第二个任务或第二次 ACK。
- 启动时必须按“进程文件锁 → 安全路径/权限 → pre-integrity → checksum migration → post-integrity → WAL durability pragmas → 数据库 lease”完成，全部通过后才接单。
- Task 1 的 `openJobStore` 只建立“持有有效进程文件锁才允许开库”的前置门禁；它不得提前伪造数据库 lease 已就绪。数据库 lease 与“lease 成功后才接单”的门禁由 Task 3 的 `acquireRuntimeLease` 和后续 bridge 启动编排实现。
- 任务租约过期只能进入 `INTERRUPTED_REQUIRES_CONFIRMATION`，不得自动重跑。
- 配对后的总裁私聊精确取消短语通过 control event 把当前任务转为 `CANCELLED`；它与崩溃中断状态分开，不自动恢复。
- 动作状态只能按 `PREPARED → APPROVED → CLAIMED → DISPATCHING → SUCCEEDED|FAILED|UNKNOWN → RECONCILED` 前进。
- 审批必须核对不可变 payload hash、action version、nonce、actor、chat、expiry 和当前状态。
- App Secret 与 OAuth Token 不得出现在配置、argv、环境、日志、Codex prompt 或测试 fixture。OAuth 存储固定遵循用户于 2026-07-21 确认的 `SECRET_STORAGE_PROFILE=KEYCHAIN_BACKED_ENCRYPTED_STORE`；任何不符都进入 `BLOCKED_SECRET_STORAGE`，不得自动降级或切换方案。
- Codex 只能访问网关 socket；网关不接受自由命令、自由 URL、自由身份或绝对输出路径。
- `system_reply` 只能发往任务或精确取消 control event 账本推导的原总裁私聊，且固定 Bot 身份；control event 只允许文字回复。
- 附件是未信任数据；不得自动解压或执行宏、脚本和附件内指令。
- commit、push、PR、部署和真实租户写入仍分别需要明确授权。

---

### Task 1: 建立 SQLite schema、迁移和安全打开流程

**Files:**
- Create: `packages/job-store/package.json`
- Create: `packages/job-store/tsconfig.json`
- Create: `packages/job-store/migrations/001_initial.sql`
- Create: `packages/job-store/src/open-store.ts`
- Create: `packages/job-store/src/file-lock.ts`
- Create: `packages/job-store/src/secure-path.ts`
- Create: `packages/job-store/src/migrate.ts`
- Create: `packages/job-store/src/types.ts`
- Create: `packages/job-store/src/index.ts`
- Test: `packages/job-store/test/open-store.test.ts`
- Test: `packages/job-store/test/file-lock.test.ts`
- Test: `packages/job-store/test/migrate.test.ts`

**Interfaces:**
- Produces: `acquireDatabaseFileLock(runtimeDir): Promise<DatabaseFileLock>`；返回本模块创建、不可伪造且可释放的锁句柄。
- Produces: `openJobStore({ filename, instanceId, lock }): JobStore`；必须消费仍有效且与数据库直接父目录绑定的锁句柄，不提供无锁 overload。
- Produces: `JobStore.close()`、`JobStore.integrityCheck()` 和只读固定字段 `JobStore.durabilitySettings()`；不得公开接受任意字符串的 PRAGMA 执行接口。
- Consumes: absolute database path under `~/PresidentAssistant/runtime/`。

安全澄清（2026-07-21）：生产调用方固定把 `~/PresidentAssistant/runtime/` 作为 `runtimeDir`；测试可传由当前 uid 持有、非 symlink、权限为 `0700` 的隔离临时 runtime。两者使用同一安全 primitive：`filename` 必须是锁句柄所绑定 runtimeDir 的绝对直接子文件。下方 `tempDb()` 示例是对“创建隔离 runtime、先获取锁、再传入其直接子文件”的简写，不得实现成可绕过锁或可接受任意父目录的生产 overload。

运行时绑定澄清（2026-07-21）：TypeScript 的 `readonly/private` 不构成 JavaScript 运行时安全边界。锁句柄绑定的 runtime、unlock、fatal hook 和状态必须保存在 ECMAScript 私有状态中，真实句柄必须不可扩展或冻结；所有 attach/release/path 判断只能读取私有状态，public getter 仅供观察，不得成为授权依据。`openJobStore` 在任何文件锁、文件系统或 SQLite 副作用前，必须把 `filename`、`instanceId`、`lock` 投影为 exact plain own-data 快照并拒绝 Proxy、accessor、symbol、未知/缺失字段；之后的校验、打开、关闭和 detach 只能捕获该快照，不得再次读取调用方对象。成功返回的 store 同样不得把 database、instanceId 或 detach callback 留在可由调用方改写的普通属性中。

威胁边界澄清（2026-07-21）：Task 1 必须拒绝预先存在的 symlink、非 canonical runtime 路径、错误 owner/mode 和非普通数据库文件；但是 `better-sqlite3` 只接受 pathname，本阶段的 `lstat/realpath` 预检不能被描述为原子抵抗“同一 uid 的活跃恶意进程在检查后、SQLite 打开前替换路径”。阶段 B 的本机假设是 dedicated service account 下不存在敌对的同 uid 进程；若要把该攻击者纳入威胁模型，必须暂停并单独评审 native `openat`/自定义 VFS 等架构，不得用更多 pathname 预检冒充已消除 TOCTOU。

- [x] **Step 1: 写 PRAGMA 与损坏数据库红测**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { acquireDatabaseFileLock, openJobStore } from "../src/index.js";

describe("openJobStore", () => {
  it("enforces durability pragmas", async () => {
    const runtimeDir = tempRuntime();
    const lock = await acquireDatabaseFileLock(runtimeDir);
    try {
      const store = openJobStore({ filename: tempDb(runtimeDir), instanceId: "instance-a", lock });
      expect(store.durabilitySettings()).toEqual({
        journalMode: "wal",
        foreignKeys: 1,
        synchronous: 2,
        busyTimeout: 5000,
      });
      store.close();
    } finally {
      await lock.release();
    }
  });

  it("fails closed when integrity_check is not ok", async () => {
    const filename = corruptSqliteFile();
    const lock = await acquireDatabaseFileLock(dirname(filename));
    try {
      expect(() => openJobStore({ filename, instanceId: "instance-a", lock })).toThrowError(/BLOCKED_RUNTIME_STATE/);
    } finally {
      await lock.release();
    }
  });

  it("allows only one process file lock before SQLite opens", async () => {
    const lock = await acquireDatabaseFileLock(runtimeDir);
    await expect(acquireDatabaseFileLock(runtimeDir)).rejects.toThrow(/BLOCKED_RUNTIME_STATE/);
    await lock.release();
  });
});
```

- [x] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/job-store test -- open-store
```

Expected: FAIL because package and `openJobStore` are absent。

- [x] **Step 3: 写完整初始 migration**

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE principals (
  app_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  president_open_id TEXT NOT NULL,
  president_chat_id TEXT NOT NULL,
  paired_at TEXT NOT NULL,
  PRIMARY KEY (app_id, tenant_key)
);

CREATE TABLE inbound_events (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_open_id_hash TEXT NOT NULL,
  chat_id_hash TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (app_id, tenant_key, event_id)
);

CREATE TABLE control_events (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  command TEXT NOT NULL CHECK (command='CANCEL_ACTIVE_TASK'),
  actor_open_id_hash TEXT NOT NULL,
  chat_id_hash TEXT NOT NULL,
  target_task_id TEXT REFERENCES tasks(id),
  received_at TEXT NOT NULL,
  UNIQUE (app_id, tenant_key, event_id)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  inbound_event_id TEXT NOT NULL REFERENCES inbound_events(id),
  task_kind TEXT NOT NULL DEFAULT 'ROOT' CHECK (task_kind IN ('ROOT','RESUME')),
  resumed_from_task_id TEXT REFERENCES tasks(id),
  state TEXT NOT NULL CHECK (state IN ('RECEIVED','CLAIMED','RUNNING','SUCCEEDED','FAILED','CANCELLED','INTERRUPTED_REQUIRES_CONFIRMATION')),
  recovery_disposition TEXT NOT NULL DEFAULT 'NONE' CHECK (recovery_disposition IN ('NONE','REQUIRES_CONFIRMATION','RESUME_APPROVED','ABANDONED')),
  codex_session_id TEXT,
  workspace_path TEXT NOT NULL,
  stage TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_event_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  control_event_id TEXT REFERENCES control_events(id),
  version INTEGER NOT NULL,
  capability TEXT NOT NULL,
  identity TEXT NOT NULL CHECK (identity IN ('bot','user')),
  approval_mode TEXT NOT NULL CHECK (approval_mode IN ('president','system_policy')),
  state TEXT NOT NULL CHECK (state IN ('PREPARED','APPROVED','CLAIMED','DISPATCHING','SUCCEEDED','FAILED','UNKNOWN','RECONCILED')),
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  preview_json TEXT NOT NULL,
  actor_open_id_hash TEXT NOT NULL,
  chat_id_hash TEXT NOT NULL,
  nonce_hash TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  remote_id TEXT,
  result_json TEXT,
  reconcile_outcome TEXT CHECK (reconcile_outcome IN ('SUCCEEDED','FAILED','INDETERMINATE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, version),
  CHECK ((task_id IS NOT NULL AND control_event_id IS NULL) OR (task_id IS NULL AND control_event_id IS NOT NULL)),
  CHECK ((capability='system_reply' AND approval_mode='system_policy' AND identity='bot') OR (capability<>'system_reply' AND approval_mode='president')),
  CHECK (control_event_id IS NULL OR capability='system_reply')
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES actions(id),
  action_version INTEGER NOT NULL,
  actor_open_id_hash TEXT NOT NULL,
  chat_id_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED','REJECTED','EXPIRED','INVALIDATED')),
  decided_at TEXT NOT NULL,
  FOREIGN KEY (action_id, action_version) REFERENCES actions(id, version)
);

CREATE TABLE action_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL REFERENCES actions(id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  evidence_digest TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE action_attempts (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES actions(id),
  attempt_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('STARTED','FINISHED')),
  attempt_kind TEXT NOT NULL CHECK (attempt_kind IN ('DISPATCH','RECONCILE','SYSTEM_REPLY')),
  outcome TEXT CHECK (outcome IN ('SUCCEEDED','FAILED_DEFINITE','UNKNOWN','INDETERMINATE')),
  request_digest TEXT NOT NULL,
  result_digest TEXT,
  remote_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (action_id, attempt_id, phase),
  CHECK (
    (phase='STARTED' AND outcome IS NULL AND result_digest IS NULL AND remote_id IS NULL) OR
    (phase='FINISHED' AND outcome IS NOT NULL)
  )
);

CREATE TABLE reconciliations (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES actions(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCEEDED','FAILED','INDETERMINATE')),
  evidence_digest TEXT NOT NULL,
  operator_kind TEXT NOT NULL CHECK (operator_kind IN ('automatic','manual')),
  created_at TEXT NOT NULL
);

CREATE TABLE task_files (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  role TEXT NOT NULL CHECK (role IN ('input','output','evidence')),
  relative_path TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, relative_path)
);

CREATE TABLE runtime_leases (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX tasks_state_created_idx ON tasks(state, created_at);
CREATE INDEX actions_state_updated_idx ON actions(state, updated_at);
CREATE UNIQUE INDEX one_root_task_per_event
  ON tasks(inbound_event_id)
  WHERE task_kind='ROOT';
CREATE UNIQUE INDEX one_president_pending_action_per_task
  ON actions(task_id)
  WHERE task_id IS NOT NULL AND approval_mode='president' AND state IN ('PREPARED','APPROVED','CLAIMED','DISPATCHING');

CREATE TRIGGER tasks_legal_state_transition
BEFORE UPDATE OF state ON tasks
WHEN NOT (
  (OLD.state='RECEIVED' AND NEW.state IN ('CLAIMED','CANCELLED','INTERRUPTED_REQUIRES_CONFIRMATION')) OR
  (OLD.state='CLAIMED' AND NEW.state IN ('RUNNING','FAILED','CANCELLED','INTERRUPTED_REQUIRES_CONFIRMATION')) OR
  (OLD.state='RUNNING' AND NEW.state IN ('SUCCEEDED','FAILED','CANCELLED','INTERRUPTED_REQUIRES_CONFIRMATION'))
)
BEGIN
  SELECT RAISE(ABORT, 'illegal task state transition');
END;

CREATE TRIGGER tasks_legal_recovery_transition
BEFORE UPDATE OF recovery_disposition ON tasks
WHEN NOT (
  (OLD.recovery_disposition='NONE' AND NEW.recovery_disposition='REQUIRES_CONFIRMATION') OR
  (OLD.recovery_disposition='REQUIRES_CONFIRMATION' AND NEW.recovery_disposition IN ('RESUME_APPROVED','ABANDONED'))
)
BEGIN
  SELECT RAISE(ABORT, 'illegal recovery transition');
END;

CREATE TRIGGER actions_frozen_payload
BEFORE UPDATE ON actions
WHEN NEW.task_id IS NOT OLD.task_id
  OR NEW.control_event_id IS NOT OLD.control_event_id
  OR NEW.version IS NOT OLD.version
  OR NEW.capability IS NOT OLD.capability
  OR NEW.identity IS NOT OLD.identity
  OR NEW.approval_mode IS NOT OLD.approval_mode
  OR NEW.payload_json IS NOT OLD.payload_json
  OR NEW.payload_hash IS NOT OLD.payload_hash
  OR NEW.preview_json IS NOT OLD.preview_json
  OR NEW.actor_open_id_hash IS NOT OLD.actor_open_id_hash
  OR NEW.chat_id_hash IS NOT OLD.chat_id_hash
  OR NEW.nonce_hash IS NOT OLD.nonce_hash
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'immutable action fields');
END;

CREATE TRIGGER actions_legal_state_transition
BEFORE UPDATE OF state ON actions
WHEN NOT (
  (OLD.state='PREPARED' AND NEW.state IN ('APPROVED','FAILED')) OR
  (OLD.state='APPROVED' AND NEW.state IN ('CLAIMED','FAILED')) OR
  (OLD.state='CLAIMED' AND NEW.state IN ('DISPATCHING','FAILED')) OR
  (OLD.state='DISPATCHING' AND NEW.state IN ('SUCCEEDED','FAILED','UNKNOWN')) OR
  (OLD.state='UNKNOWN' AND NEW.state='RECONCILED')
)
BEGIN
  SELECT RAISE(ABORT, 'illegal action state transition');
END;

CREATE TRIGGER action_transitions_append_only_update
BEFORE UPDATE ON action_transitions BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER action_transitions_append_only_delete
BEFORE DELETE ON action_transitions BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER approvals_append_only_update
BEFORE UPDATE ON approvals BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER approvals_append_only_delete
BEFORE DELETE ON approvals BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER action_attempts_append_only_update
BEFORE UPDATE ON action_attempts BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER action_attempts_append_only_delete
BEFORE DELETE ON action_attempts BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER reconciliations_append_only_update
BEFORE UPDATE ON reconciliations BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER reconciliations_append_only_delete
BEFORE DELETE ON reconciliations BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER inbound_events_append_only_update
BEFORE UPDATE ON inbound_events BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER inbound_events_append_only_delete
BEFORE DELETE ON inbound_events BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER control_events_append_only_update
BEFORE UPDATE ON control_events BEGIN SELECT RAISE(ABORT, 'append only'); END;
CREATE TRIGGER control_events_append_only_delete
BEFORE DELETE ON control_events BEGIN SELECT RAISE(ABORT, 'append only'); END;
```

- [x] **Step 4: 实现文件锁、迁移校验和安全打开顺序**

```ts
export function openJobStore(options: {
  filename: string;
  instanceId: string;
  lock: DatabaseFileLock;
}): JobStore {
  const { filename, instanceId, lock } = snapshotExactOwnDataOptions(options);
  attachDatabaseFileLock(lock, filename);
  prepareSecureSqlitePath(filename);
  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = FULL");
  const preMigration = db.pragma("integrity_check", { simple: true });
  if (preMigration !== "ok") {
    db.close();
    throw new RuntimeStateError(`pre_migration_integrity=${String(preMigration)}`);
  }
  applyChecksumVerifiedMigrationsInOneTransaction(db);
  const postMigration = db.pragma("integrity_check", { simple: true });
  if (postMigration !== "ok") {
    db.close();
    throw new RuntimeStateError(`post_migration_integrity=${String(postMigration)}`);
  }
  if (db.pragma("journal_mode = WAL", { simple: true }) !== "wal") {
    db.close();
    throw new RuntimeStateError("journal_mode_not_wal");
  }
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = FULL");
  return new SqliteJobStore(db, instanceId, () => detachDatabaseFileLock(lock));
}
```

`acquireDatabaseFileLock` 必须先以 `proper-lockfile` 的 `realpath:false` 尝试取得锁，再在锁内完成 runtime realpath、`0700` 和当前 uid 校验；校验失败必须释放刚取得的锁。公共 `acquireDatabaseFileLock(runtimeDir)` 固定使用不可被调用方覆盖的一次性 fatal 行为；自定义 compromise hook 只能存在于未从包根导出的测试 seam。句柄的安全绑定与状态必须是运行时私有且不可由 own-property 遮蔽，Proxy 包装、已释放、compromised、releaseFailed 或 release-in-progress 的句柄都不能重新开库。`prepareSecureSqlitePath` 对已存在目标使用 `lstat` 证明它是当前 uid 的普通非 symlink `0600` 文件，不存在时用 `O_CREAT|O_EXCL|O_NOFOLLOW` 和 `0600` 创建，且该 primitive 不从包根单独导出。调用方顺序必须是：`acquireDatabaseFileLock(runtimeDir) → openJobStore → acquireRuntimeLease`；Task 3 的 lease 未成功前，后续接单入口保持禁用。`openJobStore` 必须先拒绝非 exact own-data options 并形成一次性快照，再把成功打开的 store 附着到该快照中的锁句柄：任何 store 未成功 `close()` 前均拒绝 release，release 已开始后拒绝新 attach，打开失败必须解除 attach；关闭回调不得重新读取调用方的 options。`proper-lockfile` 固定 `retries=0`、`stale=60_000`、`update=10_000`；compromise 必须先让句柄和后续开库立即 fail closed，再触发一次性 fatal hook。这个阈值以交付 preflight 已阻断 AC sleep 非 0、watchdog/launchd 采用约 60 秒恢复目标为前提，不能把可能长时间睡眠包装成可验收状态。正常进程退出才主动释放；若依赖的 release callback 失败，由于 4.1.2 已在删除 lockdir 前清除内部 owner 状态，句柄必须进入不可重试的 `releaseFailed` fail-closed 状态，不得谎称已释放或伪造可重试保证，遗留 lockdir 交由 stale 回收或运维处置。

migration manifest 必须非空；先检查所有大小写不敏感以 `.sql` 结尾的目录条目，任何非普通文件、symlink、目录或不符合精确小写 `^\d+_.+\.sql$` 命名的 SQL 都 fail closed，其他非 SQL 旁车文件可忽略。每个有效 SQL 保存 SHA-256，已应用记录只能是 manifest 的严格连续前缀；checksum、名称、顺序或前缀不符时不执行或覆盖数据库。执行前必须用能识别字符串、引号标识符、行/块注释、trigger body 与嵌套 `CASE ... END` 的 lexical/state scanner，在顶层或 trigger body 语句首拒绝 `BEGIN/COMMIT/END/ROLLBACK/SAVEPOINT/RELEASE` 等事务控制，同时不得误伤 `INSERT OR ROLLBACK` 或 `RAISE(ROLLBACK, ...)`；不闭合 token、trigger、CASE 或 NUL 也 fail closed。不得让显式 `COMMIT/END` 逃出外层 transaction 后留下部分 schema。该 scanner 只作为仓库内、经代码审查 migration 的防御门禁，不是完整 SQLite parser；若未来允许不可信 migration 输入，必须改用能在 SQLite 解析层拒绝 `SQLITE_TRANSACTION/SQLITE_SAVEPOINT` 的 native authorizer 方案并重新评审。

- [x] **Step 5: 运行绿测和 migration 重入测试**

Run:

```bash
corepack pnpm --filter @executive-assistant/job-store test
corepack pnpm --filter @executive-assistant/job-store typecheck
```

Expected: PASS；同一 DB 连续打开两次不重复 migration。

- [x] **Step 6: 经授权后提交 Task 1**

```bash
git add CHANGELOG.md README.md docs/superpowers/plans/2026-07-20-02-job-store-and-action-gateway.md package.json pnpm-lock.yaml vitest.workspace.ts packages/job-store
git commit -m "feat(store): add durable assistant database"
```

### Task 2: 原子接收入站事件并持久去重

**Files:**
- Create: `packages/job-store/src/events.ts`
- Test: `packages/job-store/test/events.test.ts`
- Modify: `packages/job-store/src/types.ts`
- Modify: `packages/job-store/src/open-store.ts`
- Modify: `packages/job-store/src/index.ts`
- Modify: `packages/job-store/src/tasks.ts`
- Modify: `packages/job-store/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `InboundEvent`。
- Produces: `JobStore.ingestEvent(event, workspacePath): { taskId, duplicate }`。

信任边界澄清（2026-07-22）：`workspacePath` 是受信任 TaskSink adapter 预先创建的完整候选目录，不是来自飞书消息或 Codex 的输入。adapter 生成 canonical UUID 并以 `0700` 创建 `jobs/<uuid>`；store 验证该叶目录为当前 uid 持有、canonical、非 symlink、`0700`，并以 basename 作为 task ID。store 本身不持有 `jobsRoot`，因此本 Task 不声称独立证明 root containment；Task 9 接线必须把固定 `jobsRoot` 绑定进 adapter，并在 duplicate 返回的账本 task ID 与 candidate UUID 不同时，只删除本次刚创建且仍为空的 candidate，绝不能删除账本已有任务目录。

并发证据澄清（2026-07-22）：Task 1 的进程文件锁禁止第二进程同时打开生产数据库，且当前 API 是单 Node isolate 的同步 `better-sqlite3` 调用。因此本 Task 的双连接用例证明“同一有效进程锁下两个 SQLite connection 的顺序重放语义”，不宣称证明跨进程并行竞争；真正的单消费者和过期接管由 Task 3 runtime lease 另行验证。

- [x] **Step 1: 写原子性和两连接去重红测**

```ts
it("creates one task for a replayed event", () => {
  const first = store.ingestEvent(eventA, workspaceA);
  const second = store.ingestEvent(eventA, workspaceA);
  expect(first.duplicate).toBe(false);
  expect(second).toEqual({ taskId: first.taskId, duplicate: true });
  expect(store.count("inbound_events")).toBe(1);
  expect(store.count("tasks")).toBe(1);
});

it("rolls back the event when task creation fails", () => {
  installExternalTestOnlyTaskInsertFailureTrigger(filename);
  expect(() => store.ingestEvent(eventA, workspaceA)).toThrow(/BLOCKED_RUNTIME_STATE/);
  expect(readOnlyCounts(filename)).toEqual({ events: 0, tasks: 0 });
});
```

- [x] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/job-store test -- events
```

Observed: RED；新增 9 个用例因 `ingestEvent` 不存在而失败，既有 70 个 job-store 用例仍通过。独立审查后新增的 `Object.prototype` 污染回归又先以 1 failed / 79 passed 复现身份字段可被继承 accessor 篡改。

- [x] **Step 3: 用单个 IMMEDIATE transaction 实现**

```ts
const ingest = db.transaction((event: InboundEvent, workspacePath: string) => {
  const existing = findEventByUniqueKey(event.appId, event.tenantKey, event.eventId);
  if (existing) return { taskId: existing.task_id, duplicate: true } as const;
  const inboundId = randomUUID();
  const taskId = basename(validatePrivateCanonicalWorkspace(workspacePath));
  insertInboundEvent(inboundId, event);
  insertTask({ id: taskId, inboundEventId: inboundId, workspacePath, state: "RECEIVED", stage: "accepted" });
  return { taskId, duplicate: false } as const;
});

export function ingestEvent(event: InboundEvent, workspacePath: string) {
  return ingest.immediate(event, workspacePath);
}
```

入站对象先以 exact own-data descriptors 一次性读取，拒绝 Proxy、accessor、symbol、未知/缺失字段和非 plain prototype；每个字段分别通过 canonical `InboundEventSchema.shape` 校验后，以 `Object.create(null)` + `Object.defineProperty` 构造冻结快照，不能让 `Object.prototype` getter/setter 参与赋值或读取。sender/chat 仅持久化 SHA-256；数据库异常只向外暴露固定 `RuntimeStateError` detail。

- [x] **Step 4: 加两连接重放语义测试**

同一进程文件锁下用两个 `JobStore` connection 和两个不同安全 candidate 顺序接收相同 event；一个返回 `duplicate=false`，另一个返回原账本 task ID 与 `duplicate=true`，不得出现 constraint error 泄漏或第二个 task。该用例不表述为跨进程并发证明。

- [x] **Step 5: 运行绿测与本地门禁**

```bash
corepack pnpm --filter @executive-assistant/job-store test -- events
corepack pnpm test
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
```

Observed: job-store 4 files / 80 tests、全仓 27 files / 619 tests 全部 PASS；format、lint、typecheck、build 与 `git diff --check` 均退出 0。首轮独立审查复现的 prototype pollution 身份篡改已先红后绿封闭，修复后复核为 Critical / Important / Minor 全部 0、结论 `READY`。Task 2 仍保持未提交。

- [x] **Step 6: 经单独授权后本地提交 Task 2**

```bash
git add CHANGELOG.md README.md docs/superpowers/plans/2026-07-20-02-job-store-and-action-gateway.md packages/job-store pnpm-lock.yaml
git commit -m "feat(store): persist and deduplicate inbound events"
```

已按用户对 Task 2 的单独授权完成本地提交。未配置或创建 remote，未 push、创建 PR、部署、调用真实飞书/Codex/gateway API、修改 LaunchAgent 或处理客户凭据；Task 3 实现需要新的明确授权。

### Task 3: 实现单消费者租约与中断恢复

**Files:**
- Create: `packages/job-store/src/leases.ts`
- Create: `packages/job-store/src/tasks.ts`
- Create: `packages/job-store/src/control-events.ts`
- Create: `packages/job-store/migrations/002_task_leases_and_control_outcomes.sql`
- Test: `packages/job-store/test/leases.test.ts`
- Test: `packages/job-store/test/tasks.test.ts`
- Modify: `packages/job-store/src/types.ts`
- Modify: `packages/job-store/src/open-store.ts`
- Modify: `packages/job-store/src/index.ts`
- Modify: `packages/job-store/test/open-store.test.ts`（migration count 与真实 v1→v2 回归）

**Interfaces:**
- Produces: `acquireRuntimeLease(name, owner, now, ttlMs): boolean`。
- Produces: `releaseRuntimeLease(name, owner): boolean`。
- Produces: `claimNextTask(owner, now, ttlMs): TaskRecord | null`。
- Produces: `getTask`、`markRunning`、`touchTask`、`finishTask`、`interruptExpiredTasks`、`recoverOnStartup`、`createReplacementTask`、`cancelActiveTask`。

- [x] **Step 1: 写单实例与过期任务红测**

```ts
it("allows only one live bridge lease", () => {
  expect(storeA.acquireRuntimeLease("bridge", "a", at(0), 60_000)).toBe(true);
  expect(storeB.acquireRuntimeLease("bridge", "b", at(1_000), 60_000)).toBe(false);
});

it("interrupts but never reclaims an expired running task", () => {
  const task = seedRunningTask({ leaseExpiresAt: at(1_000) });
  store.interruptExpiredTasks(at(2_000));
  expect(store.getTask(task.id).state).toBe("INTERRUPTED_REQUIRES_CONFIRMATION");
  expect(store.claimNextTask("worker-b", at(2_001), 60_000)).toBeNull();
});

it.each(["RECEIVED", "CLAIMED", "RUNNING"] as const)("interrupts %s on startup", (state) => {
  const task = seedTask({ state });
  store.recoverOnStartup(at(2_000), "instance-b");
  expect(store.getTask(task.id)).toMatchObject({ state: "INTERRUPTED_REQUIRES_CONFIRMATION", recoveryDisposition: "REQUIRES_CONFIRMATION" });
});

it("records one cancel control event and cancels the current task", () => {
  const task = seedRunningTask({ chatId: "oc_dm" });
  const request = cancelControlEvent({ eventId: "evt_cancel", chatId: "oc_dm" });
  expect(store.cancelActiveTask(request)).toMatchObject({ taskId: task.id, cancelled: true });
  expect(store.cancelActiveTask(request)).toMatchObject({ taskId: task.id, cancelled: false, duplicate: true });
  expect(store.getTask(task.id).state).toBe("CANCELLED");
});
```

- [x] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/job-store test -- leases tasks
```

Observed: 初始 RED 为 2 个文件失败、18 项失败、80 项通过，共 98 项；缺失 runtime lease、task lifecycle/recovery/replacement 与 cancel-control 方法。后续独立复审 finding 均先增加保持不变的回归，再执行最小修复；证据记录在本 Task 的本地报告中。

- [x] **Step 3: 实现 compare-and-swap 租约**

使用 `BEGIN IMMEDIATE`；只有 lease 不存在、属于当前 owner，或 `expires_at < now` 时更新，相等仍视为 live。`claimNextTask` 只在当前实例持有 live `bridge` lease 且全库无 `CLAIMED|RUNNING` 时选择最早 `RECEIVED`。`markRunning`、`touchTask`、`finishTask` 也在各自同一 IMMEDIATE transaction 内、读取 task 前核验同一 snapped time 下的 live bridge lease，再执行 task owner/session/lease CAS；因此 takeover 先提交时旧实例被 fence，lifecycle 先提交时则允许完成该次写入。

- [x] **Step 4: 实现启动恢复规则**

启动恢复必须在一个事务中完成：所有 `RECEIVED`、`CLAIMED`、`RUNNING` 任务改为 `INTERRUPTED_REQUIRES_CONFIRMATION` 并设置 `recovery_disposition=REQUIRES_CONFIRMATION`；PREPARED、APPROVED 和尚未 dispatch 的 CLAIMED 动作转为 FAILED 并记录 `restart_invalidated`；DISPATCHING 转 UNKNOWN；UNKNOWN 仅进入 reconcile 队列；SUCCEEDED、FAILED 和 RECONCILED 保留。

总裁确认继续时调用 `createReplacementTask(interruptedTaskId, confirmedAt, workspacePath)`：调用方提供受信任、预创建的 canonical UUID `0700` 叶目录；固定 `jobsRoot` containment 与未使用候选清理由 Task 9 负责。在同一事务中以 compare-and-swap 把旧任务的 `recovery_disposition` 从 `REQUIRES_CONFIRMATION` 改为 `RESUME_APPROVED`，再创建 `task_kind=RESUME` 的新 RECEIVED task，复用根 `inbound_event_id` 并写 `resumed_from_task_id`。第二次确认返回唯一既有 replacement 且 `duplicate=true`；任何 inbound、kind、link、UUID 或 workspace basename 漂移均按损坏账本阻断。旧任务保持 interrupted 作为审计事实，旧 action/approval/nonce 永不复活；纯读取任务也走 replacement task。

`cancelActiveTask` 在一个 `BEGIN IMMEDIATE` 事务中按“精确重放/漂移检查 → principal actor/chat 校验 → 只读解析最早目标与 pending 事实 → 插入最终不可变 control row → task/action CAS 与 transition”执行，任一步失败均整体回滚。PREPARED/APPROVED/尚未 dispatch 的 CLAIMED 动作转 FAILED(reason=`user_cancelled`)；DISPATCHING 转 UNKNOWN 并只做对账；已 UNKNOWN/SUCCEEDED/FAILED/RECONCILED 的外部事实不改写。重复 control event 返回原 control/task/pending 事实，但固定 `cancelled=false, duplicate=true`。本 Task 只提交账本事实；后续 TaskControl adapter 才负责 SIGTERM、同 PID 10 秒后仍存活再 SIGKILL，以及控制回复，重复事件不得再次产生这些效果。

- [x] **Step 5: 运行绿测和 fake clock 确定性测试**

Run:

```bash
corepack pnpm --filter @executive-assistant/job-store test -- leases tasks
```

Observed: fake clock + 实际临时 SQLite、无真实 sleep 的最终聚焦门禁为 6 个文件、132/132 PASS。三轮独立修复分别封闭 startup 全局动作/session/replacement 身份、非合同时间 fail-open，以及 runtime takeover 后旧 worker 生命周期写入；最终独立复审为 Critical / Important / Minor 全部 0、结论 `READY`。提交前主控全仓门禁为 29 个文件、671/671 PASS；format、lint、typecheck、build、离线 vendor replay 与 `git diff --check` 均退出 0。

- [x] **Step 6: 经授权后本地提交 Task 3**

```bash
git add CHANGELOG.md README.md docs/superpowers/plans/2026-07-20-02-job-store-and-action-gateway.md packages/job-store
git commit -m "feat(store): add single-consumer task leases"
```

已按用户对 Task 3 的单独授权完成本地提交，状态为 `STAGE_B_TASK3_LOCAL_COMMITTED`。未配置或创建 remote，未 push、创建 PR、部署、调用真实飞书/Codex/gateway API、修改 LaunchAgent 或处理客户凭据；Task 4 实现需要新的明确授权。

### Task 4: 实现不可变动作、审批与一次性 claim

**Files:**
- Create: `packages/job-store/src/actions.ts`
- Create: `packages/job-store/src/canonical-json.ts`
- Test: `packages/job-store/test/actions.test.ts`
- Modify: `packages/job-store/src/types.ts`
- Modify: `packages/job-store/src/open-store.ts`
- Modify: `packages/job-store/src/index.ts`
- Modify: `packages/job-store/src/tasks.ts`
- Modify: `packages/job-store/src/control-events.ts`
- Modify: `packages/job-store/package.json`
- Modify: `packages/contracts/src/gateway.ts`
- Test: `packages/contracts/test/contracts.test.ts`
- Test: `packages/job-store/test/tasks.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `prepareAction(input): PreparedActionWithNonce`。
- Produces: `approveAction(input): ApprovedAction`。
- Produces: `claimApprovedAction(input): ClaimedAction`。
- Produces: `markDispatching`、`finishAction`、`reconcileAction`。

动作身份澄清（2026-07-22）：`actions.id` 是随机主键，后续幂等键也由 `actionId` 派生，因此每次正文、目标、时间或身份变化都必须在同一事务中把旧 `PREPARED` 或 `APPROVED` 动作转为 `FAILED(reason=superseded_by_new_preview)`，再创建新的随机 `actionId`；每个动作固定 `version=1`。已经 `CLAIMED`、`DISPATCHING` 或 `UNKNOWN` 的动作不得被新预览静默覆盖，必须先走取消、恢复或对账。不得把同一 `actionId` 复用为 version 2，也不得修改已提交的 `001_initial.sql`。确认 callback 和所有动作读写仍必须显式携带并核对 `actionId + version`，以便卡片合同 fail closed。

接口与租约澄清（2026-07-22）：`PreparedAction` 必须返回 `version`；确认 callback 必须包含 `actionId`、`version`、`actionPayloadHash`、`nonce`、`decision`、`actorOpenId` 和 `chatId`。其中 `actionPayloadHash` 是账本冻结业务 payload 的 RFC 8785 哈希，不得与 bridge 对 SDK callback action body 验签后计算的 `signedCallbackActionHash` 混用。首版确认有效期由 store 按 `now + 30 minutes` 固定计算，不接受调用方自由 `expiresAt`。claim 输入必须包含 owner、now 和 ttl；`markDispatching` 与 `finishAction` 携带原 dispatch claim lease。UNKNOWN 可能来自重启并已清空旧 lease，因此 `startReconciliation` 必须以 live `bridge` runtime lease 对 UNKNOWN CAS 获取一份新的 action lease并追加 RECONCILE STARTED；`reconcileAction` 只使用这份新 lease 追加 FINISHED/reconciliation 并进入 RECONCILED。所有状态写入都验证 live `bridge` runtime lease，并以 `id + version + state + lease_owner + lease_expires_at` CAS。`getAction(ref)` 和 `listUnknownActions()` 是 Task 7 所需的只读恢复面。

父任务与持久语义澄清（2026-07-22）：总裁审批动作的 `prepareAction`、`approveAction`、`claimApprovedAction` 和最后的 `markDispatching` 边界，必须在各自同一个 `BEGIN IMMEDIATE` 中证明父 task 仍为当前实例持有 live task lease、已绑定非空 Codex session 的 `RUNNING` task；`finishAction` 不重复要求父 task 仍运行，因为远端调用可能已经发生，结果必须落账或转入 UNKNOWN 对账。task 进入 FAILED、CANCELLED、INTERRUPTED 或启动恢复时，必须在父 task 原 state/session/lease 仍可核对时完整验证并迁移 actions，再在同一事务内改变父 task；未 dispatch 动作失效，DISPATCHING 转 UNKNOWN。所有公开 action 读取和状态写入前必须校验 state × lease × result × remoteId × reconcileOutcome、`idempotency_key = action_id`、task/control 来源 actor/chat hash、task/action lease owner、canonical 时间顺序、president 固定 30 分钟窗口，以及 append-only transitions、approvals、STARTED/FINISHED attempts 与 reconciliations 的状态链、哈希和时间一致性；任何损坏、缺失、未来或陈旧 attempt 均 fail closed。对账成功可携带安全 remoteId，并同时写 `result_json`、`actions.remote_id` 与当前 STARTED attempt 对应的 FINISHED row；失败或不确定结果不得携带 remoteId。Task 9 创建 `system_reply/system_policy` 时必须原子写入固定 `NULL -> APPROVED(reason=system_policy_approved)` 初始 transition；Task 4 只验证并消费该 seam，不负责创建 ACK/control reply。

- [x] **Step 1: 写审批攻击面红测**

```ts
it.each([
  ["wrong nonce", { nonce: "wrong" }],
  ["wrong actor", { actorOpenId: "ou_attacker" }],
  ["wrong chat", { chatId: "oc_other" }],
  ["changed payload", { payloadHash: "sha256:changed" }],
  ["expired", { now: "2026-07-20T00:31:00.000Z" }],
])("rejects %s", (_name, patch) => {
  const prepared = seedPreparedAction();
  expect(() => store.approveAction({ ...validApproval(prepared), ...patch })).toThrow();
});

it("allows a claim token to be consumed once", () => {
  const approved = seedApprovedAction();
  expect(store.claimApprovedAction(approved.id, "gateway-a", now())).not.toBeNull();
  expect(store.claimApprovedAction(approved.id, "gateway-b", now())).toBeNull();
});
```

- [x] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/job-store test -- actions
```

Expected: FAIL because action state methods are absent。

- [x] **Step 3: 使用 RFC 8785 兼容库实现 canonical payload 与 hash**

```ts
import { canonicalize } from "json-canonicalize";

export function payloadHash(value: unknown): string {
  const canonical = canonicalize(assertStrictIJson(value));
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
```

`assertStrictIJson` 由每个 capability 的 Zod `.strict()` schema 实现，只允许 JSON 类型和有限数值，拒绝 `undefined`、`NaN`、`Infinity`、重复语义字段及未知字段。不得自写 locale 排序 canonicalizer。

Task 4 先实现深层 exact own-data I-JSON 快照和 RFC 8785 哈希；具体消息、日历等业务字段的 `.strict()` discriminated union 由第三份计划的 capability contract Task 负责。两层都必须通过，通用 I-JSON 检查不得被描述为已替代 capability 未知字段校验。

- [x] **Step 4: 实现原子状态迁移**

每个方法使用 `UPDATE ... WHERE id=? AND state=?` 并检查 `changes===1`。`approveAction` 在同一事务中以 timing-safe 比较 nonce hash 与 payload hash；`claimApprovedAction` 写 lease；`markDispatching` 只能从 CLAIMED 进入；结果不能从终态倒退。数据库 trigger 必须同时拒绝冻结字段变化和非法状态迁移。审批、transition 和 reconciliation 各写一条 append-only 记录；一次远端尝试以相同 `attempt_id` 追加 `STARTED`、`FINISHED` 两条记录，绝不回写旧记录。`result_json` 只保存经过 schema 脱敏的结果。

- [x] **Step 5: 添加并发、重启和旧卡片测试**

两连接同时 claim 只能一个成功；同一 nonce 第二次审批失败；动作内容变化必须原子失效旧动作并创建新的随机 `actionId(version=1)`；旧 card callback 返回固定 `expired_or_changed`，不得执行。无签名、错误 actor/chat/hash/nonce 的 callback 不得把仍有效动作变成 FAILED，避免形成拒绝服务；只有绑定正确的显式放弃或到期收束可以使 PREPARED 进入 FAILED。

- [x] **Step 6: 运行绿测并完成独立复审**

```bash
corepack pnpm --filter @executive-assistant/job-store test -- actions
corepack pnpm test
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
./scripts/vendor-bridge --offline-replay
git diff --check
```

结果：job-store 208/208、全仓 30 个文件 752/752；两路最终独立复审均为 `READY`，Critical / Important / Minor 全部为 0。

- [x] **Step 7: 经单独授权后本地提交 Task 4**

```bash
git add README.md CHANGELOG.md \
  docs/superpowers/plans/2026-07-20-02-job-store-and-action-gateway.md \
  packages/contracts packages/job-store pnpm-lock.yaml
git commit -m "feat(store): enforce immutable confirmed actions"
```

结果：Task 4 本地实现提交为 `c308c41`；未配置 remote，未 push、未创建 PR、未部署或调用真实 API。

### Task 5: 建立严格 Unix socket 协议和网关服务器

**Files:**
- Create: `packages/action-gateway/package.json`
- Create: `packages/action-gateway/tsconfig.json`
- Create: `packages/action-gateway/src/server.ts`
- Create: `packages/action-gateway/src/client.ts`
- Create: `packages/action-gateway/src/ipc/framing.ts`
- Create: `packages/action-gateway/src/ipc/control-server.ts`
- Create: `packages/action-gateway/src/ipc/run-server.ts`
- Create: `packages/action-gateway/src/ipc/schemas.ts`
- Create: `packages/action-gateway/src/ipc/socket-server.ts`
- Create: `packages/action-gateway/src/internal/exact-options.ts`
- Create: `packages/action-gateway/src/policy.ts`
- Create: `packages/action-gateway/src/index.ts`
- Create: `packages/action-gateway/native/run-client/main.swift`
- Create: `packages/action-gateway/native/run-client/Framing.swift`
- Create: `packages/action-gateway/native/run-client/build.sh`
- Create: `packages/action-gateway/native/control-client/main.swift`
- Create: `packages/action-gateway/native/control-client/ParentVerifier.swift`
- Create: `packages/action-gateway/native/control-client/KernelProbe.swift`
- Create: `packages/action-gateway/native/control-client/StrictJSON.swift`
- Create: `packages/action-gateway/native/control-client/build.sh`
- Create: `packages/action-gateway/native/peer-verifier/main.swift`
- Create: `packages/action-gateway/native/peer-verifier/PeerVerifier.swift`
- Create: `packages/action-gateway/native/peer-verifier/KernelProbe.swift`
- Create: `packages/action-gateway/native/peer-verifier/StrictJSON.swift`
- Create: `packages/action-gateway/native/peer-verifier/TestPeer.swift`
- Create: `packages/action-gateway/native/peer-verifier/build.sh`
- Create: `packages/action-gateway/native/swift-vfs-overlay.yaml`
- Test: `packages/action-gateway/test/protocol.test.ts`
- Test: `packages/action-gateway/test/cli.test.ts`
- Test: `packages/action-gateway/test/socket-permissions.test.ts`
- Test: `packages/action-gateway/test/run-binding.test.ts`
- Test: `packages/action-gateway/test/control-auth.test.ts`
- Test: `packages/action-gateway/test/client-boundary.test.ts`
- Test: `packages/action-gateway/test/run-client-strict.test.ts`
- Test: `packages/action-gateway/test/control-client.test.ts`
- Test: `packages/action-gateway/test/peer-verifier.test.ts`
- Test: `packages/action-gateway/test/native-build-security.test.ts`
- Modify: `packages/bridge/src/agent/codex-runner.ts`
- Modify: `packages/bridge/test/codex-runner.test.ts`
- Modify: `packages/bridge/PATCHES.md`
- Create: `vendor/patches/lark-codex-bridge/0006-task-scoped-unix-socket-permission.patch`
- Modify: `dependencies.lock.json`
- Modify: `tests/contracts/vendor-provenance.test.ts`
- Modify: `tests/security/codex-tool-network.test.ts`
- Modify: `pnpm-lock.yaml`
- Modify: `vitest.workspace.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/plans/2026-07-20-04-installation-reliability-and-acceptance.md`
- Modify: `docs/superpowers/plans/2026-07-20-codex-feishu-executive-assistant-roadmap.md`
- Modify: `docs/superpowers/specs/2026-07-20-codex-feishu-executive-assistant-design.md`

**Interfaces:**
- Consumes: `GatewayRequestSchema` and `JobStore`。
- Produces: 4-byte big-endian length-prefixed JSON frames, maximum 1 MiB。
- Produces: bridge-only control socket and task-bound run socket, each mode `0600` under `0700` parent。
- Produces: immutable native `public-bin/assistant-gateway` run client、private `assistant-gateway-control` client 和 private fd3 `assistant-gateway-peer-verifier`；前两个只从 stdin 读一帧请求、只向 stdout 写一帧响应，peer verifier 不读取 fd3 业务字节且成功时保持 stdout/stderr 为空。

**Task 5 implementation clarification (2026-07-22):** `GatewayRequestSchema` 只定义 run envelope，真实飞书 capability unions 属 Stage C；因此本 Task 建立按 `channel + kind + capability` 绑定的可信注入式 strict registry，启动前一次性投影并冻结 parser/handler，默认 registry 为空，未知 route 一律拒绝。control transport 同样默认无业务 route；`sendSystemReply`、`sendControlReply` 与 `submitApproval` 的真实 schema/handler 仍由 Task 9 接线。framing 只有在观察到精确一帧及 request EOF 后才 dispatch，使用 fatal UTF-8、duplicate-key 拒绝、depth 64 / nodes 10,000 上限；peer/framing/JSON/envelope 失败时因没有可信 request ID 而静默关闭，只有 envelope 已验证后的 payload/policy/handler 错误可返回同 request ID 的白名单错误码。

Node 不使用私有 `_handle.fd`。control server 在 accept 后立即 pause，借助 Node 官方 `child_process` stdio Stream 传递能力，把同一个 accepted AF_UNIX socket 复制为锁定 private `assistant-gateway-peer-verifier` 的 fd 3。helper 不读取 fd 3，只在该 fd 上读取 `LOCAL_PEERTOKEN`、`LOCAL_PEERPID` 与 socket metadata，以 `pid + pidversion + euid` 绑定 peer execution，并核验运行中 control client 的 realpath、签名、SHA、parent bridge 与 active instance/release。Node 只在 helper `close`、exit `0`、空 stdout、原 socket 仍有效且 active instance/lease 复核通过后恢复读取；失败、timeout、状态漂移或未确认关闭均销毁连接且 parser/handler 调用为零。该 helper 只进入 `private-bin`，Stage D release manifest 与 installer 必须登记它。若本机 CLT 同时暴露重复 `SwiftBridging` module map，native build script 只可用受控 `swiftc -vfsoverlay` 编译视图兼容层，不得修改或删除系统工具链文件。

- [x] **Step 1: 写协议拒绝红测**

```ts
it.each([
  { version: 2, requestId: crypto.randomUUID(), kind: "read", capability: "minutes.search", payload: {} },
  { version: 1, requestId: crypto.randomUUID(), taskId: crypto.randomUUID(), kind: "read", capability: "minutes.search", payload: {} },
  { version: 1, requestId: crypto.randomUUID(), kind: "shell", capability: "exec", payload: { command: "curl" } },
  { version: 1, requestId: crypto.randomUUID(), kind: "read", capability: "http.fetch", payload: { url: "https://example.com" } },
  { version: 1, requestId: crypto.randomUUID(), kind: "read", capability: "file.export", payload: { path: "/tmp/out" } },
])("rejects non-contract input", (request) => {
  expect(() => parseGatewayRequest(JSON.stringify(request))).toThrow();
});
```

- [x] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/action-gateway test -- protocol socket-permissions
```

Expected: FAIL because gateway package and public client are absent。

结果：先红后绿覆盖非法 envelope/frame、重复键、Proxy/accessor、跨 task socket、公开/私有客户端严格响应、native parent/peer identity、非 canonical 发布路径、symlink、中间目录副作用、错误权限和编译失败保留旧产物。

- [x] **Step 3: 实现有界 framing 与严格 schema**

每帧为 4-byte big-endian 长度加 UTF-8 JSON body，最大 1 MiB；长度为 0、超限、截断、尾随第二对象、未知字段、未知 capability、非法 UUID 或绝对路径立即关闭连接。响应只含 `{version,requestId,ok,result|error}`，错误正文使用白名单错误码。

```ts
const MAX_FRAME_BYTES = 1024 * 1024;

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length === 0 || body.length > MAX_FRAME_BYTES) throw new ProtocolError("frame_size");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function decodeFrame(frame: Buffer): unknown {
  if (frame.length < 4) throw new ProtocolError("truncated_header");
  const length = frame.readUInt32BE(0);
  if (length === 0 || length > MAX_FRAME_BYTES || frame.length !== length + 4) throw new ProtocolError("frame_size");
  return JSON.parse(frame.subarray(4).toString("utf8"));
}
```

- [x] **Step 4: 实现 socket 生命周期**

control socket 固定为 `~/PresidentAssistant/runtime/control/action-gateway.sock`，只接收 bridge 管理协议。bridge 建立 lease 时把 `pid + release hash` 原子登记在 `0600` control state；该文件可读但不能作为单独认证凭据。私有 native control client 在连接前要求 `getppid()` 等于活动 bridge PID，并用 `proc_pidpath`、`KERN_PROCARGS2`、release manifest 核对 Node executable 与 bridge entry script 的 realpath/hash；control server 再通过 `LOCAL_PEERPID` 核对 peer 是 manifest 锁定的 control client 路径/签名/hash。任一失败立即断开且不解析业务正文。每次 task 启动时，gateway 在 `jobs/<task_id>/gateway.sock` 创建 run socket，服务端上下文固定 task_id、president、原 chat 和允许能力；run 请求 schema 不包含 task_id、identity 或目标 chat。启动前用 `lstat` 拒绝 symlink；创建后 `chmod 0600`；任务结束等待 dispatch 进入安全状态后关闭并 unlink run socket。

native `assistant-gateway` run client 不接受 socket、task、identity、endpoint、command 或 output path 参数；它从受信任环境变量读取 `ASSISTANT_GATEWAY_SOCKET`，stdin 只接受一个严格 JSON request，完成 length-prefix framing 后连接 run socket，stdout 只输出严格 JSON response。缺环境变量、argv 非空、额外 stdin 对象、超时或超限时 fail closed。installer 只把这个无密钥、签名/hash 已锁定的 client 放入 `runtime/current/public-bin/`；private control client、`lark-cli` 和 helper 不进入 public-bin、PATH 或 Codex 环境。即使 private path 被猜到，control-client 父进程校验、control-server peer 校验、工具网络 deny 和服务端 schema 仍必须分别阻止旁路。

**Codex 0.142 compatibility clarification (2026-07-22):** 本机实测旧 `workspace-write + network_access=false` 会连同 AF_UNIX 一并阻断，因此 Task 5 经架构复核改为固定 `assistant-task` permission profile：继承 `:workspace`，启用 `network_proxy` 的 limited mediation，domain allowlist 为空，只对 canonical 当前 task `gateway.sock` 设置一条 Unix socket allow；local binding、SOCKS、upstream proxy、非 loopback 暴露和全 Unix socket 旁路均关闭。`network.enabled=true` 只激活该受控代理层，不代表开放一般工具网络。runner 还要求可信 Codex-home verifier 明确证明无旧 `sandbox_mode` / `sandbox_workspace_write` 配置覆盖 profile；缺失或 false evidence 在 spawn 前拒绝。阶段 B fixture 必须证明 task A run client 可连接 task A socket，但 task B socket、control socket、本地 HTTP、直接外部 TCP 与 private control client 全部失败；任何额外目的地成功都进入 `BLOCKED_RUNTIME_STATE`，不得扩大 allowlist。

Task 5 只定义并消费 `permissionProfileCompatible` 的 fail-closed evidence contract，不实现生产 evidence producer，也不接通 live runner。Task 9 必须实现该 producer 并在注入前检查专用 `CODEX_HOME`、task workspace 的受信任 project config、`/etc/codex/config.toml` 与可见 managed requirements；Stage D 再以锁定 binary/hash、真实 production config stack 和同一 profile 执行 task-A-only UDS/TCP/HTTP 矩阵。producer 未实现、配置身份漂移或矩阵不精确时只能返回 false，因此当前本机 clean-home fixture 不能表述为客户 Mac mini 的生产配置证明。

- [x] **Step 5: 构建、签名并记录三个 native 二进制**

```bash
/bin/zsh packages/action-gateway/native/run-client/build.sh
/bin/zsh packages/action-gateway/native/control-client/build.sh
/bin/zsh packages/action-gateway/native/peer-verifier/build.sh
codesign --verify --strict dist/public-bin/assistant-gateway
codesign --verify --strict dist/private-bin/assistant-gateway-control
codesign --verify --strict dist/private-bin/assistant-gateway-peer-verifier
shasum -a 256 dist/public-bin/assistant-gateway \
  dist/private-bin/assistant-gateway-control \
  dist/private-bin/assistant-gateway-peer-verifier
```

Expected: 三个签名验证退出 `0`；run client 与两个 private binary 不在同一目录。Task 5 记录本地构建 SHA，Stage D installer 再把目标 Mac 的最终 SHA、签名和路径写入 release manifest。

结果：三枚本地 ad-hoc 签名产物均通过 `codesign --verify --strict`；public/private 目录均为 `0700`，run 为 `0555`，control/peer 为 `0500`。SHA-256：

- `assistant-gateway`: `79e0a1af4f0545995283312569eb196c71940aa18ed23733a8a20531763d6e13`
- `assistant-gateway-control`: `3d6e8253f7a8fcfd3f7f5318890f93edc474a69d13a1a13aec561fe1707e9703`
- `assistant-gateway-peer-verifier`: `705c034a8bea02c02473ce1e9bdd95aa417cbd6102b1cfbe554246e8f8c4fbbb`

这些只是不进入 Git 的本机构建证据；目标 Mac 的 installer 仍须重新构建或核验并记录自己的最终 SHA、签名和路径。

- [x] **Step 6: 运行绿测和 fuzz 小样本**

Run:

```bash
corepack pnpm --filter @executive-assistant/action-gateway test
```

Expected: PASS；随机 1,000 个无效 frame 全部拒绝且 decoder 保持可用；task A 客户端不能冒充 task B，Codex sandbox 能连接当前 run socket但不能连接 control socket。

结果：action-gateway 10 个测试文件 235/235、全仓 40 个测试文件 994/994 通过；format、lint、typecheck、build、Swift 严格格式、zsh 语法、签名、离线 vendor replay 与 `git diff --check` 均退出 0。两路最终 native 复核均为 `READY`、Critical 0 / Important 0，补充预检保留 2 个不阻塞 Minor（callback 主动改 mode 的专项覆盖增强、测试临时目录未统一回收）。本机 Codex native 0.142.0（SHA-256 `1b7475962a4e8aa79079723d54b062c33e60a859624624dd5f1344a2c7316590`）clean-home 无模型矩阵在显式 profile 与 `default_permissions` 两条路径均得到 `{taskA_uds:true, taskB_uds:false, control_uds:false, local_http:false, external_tcp:false}`；本次含临时 task A 绝对路径的 profile SHA-256 为 `e61489616d4b32b5d1c4c46bc306d48ed0785e60d2997311d7e8c4e5021fbb93`。private control client 在沙箱内外均固定 exit `2`。该 fixture 不能替代 Task 9 producer 或目标 Mac Stage D 重验。

- [x] **Step 7: 经授权后提交 Task 5**

```bash
git add README.md CHANGELOG.md dependencies.lock.json pnpm-lock.yaml vitest.workspace.ts \
  docs/superpowers/plans/2026-07-20-02-job-store-and-action-gateway.md \
  docs/superpowers/plans/2026-07-20-04-installation-reliability-and-acceptance.md \
  docs/superpowers/plans/2026-07-20-codex-feishu-executive-assistant-roadmap.md \
  docs/superpowers/specs/2026-07-20-codex-feishu-executive-assistant-design.md \
  packages/action-gateway packages/bridge/PATCHES.md \
  packages/bridge/src/agent/codex-runner.ts packages/bridge/test/codex-runner.test.ts \
  tests/contracts/vendor-provenance.test.ts tests/security/codex-tool-network.test.ts \
  vendor/patches/lark-codex-bridge/0006-task-scoped-unix-socket-permission.patch
git commit -m "feat(gateway): add strict local action protocol"
```

结果：用户已单独授权 Task 5 本地提交；本步骤随该提交完成。remote、push、PR、部署、LaunchAgent、凭据和真实飞书/Codex 操作仍未执行。

### Task 6: 构建 Keychain 读取器和固定身份执行边界

**Files:**
- Create: `packages/action-gateway/native/keychain-helper/main.swift`
- Create: `packages/action-gateway/native/keychain-helper/VerifiedInstallManifest.swift`
- Create: `packages/action-gateway/native/keychain-helper/ParentVerifier.swift`
- Create: `packages/action-gateway/native/keychain-helper/StrictJSON.swift`
- Create: `packages/action-gateway/native/keychain-helper/KernelProbe.swift`
- Create: `packages/action-gateway/native/keychain-helper/build.sh`
- Create: `packages/action-gateway/src/keychain.ts`
- Create: `packages/action-gateway/src/lark-cli-runner.ts`
- Test: `packages/action-gateway/test/keychain-helper-native.test.ts`
- Test: `packages/action-gateway/test/keychain-storage.test.ts`
- Test: `packages/action-gateway/test/lark-cli-runner.test.ts`
- Test: `packages/action-gateway/test/native-build-security.test.ts`
- Create: `packages/action-gateway/test/security/no-secret-leak.test.ts`

**Interfaces:**
- Produces: bridge-compatible exec SecretRef JSON protocol for the Bot App Secret only。
- Produces: `OAuthStorageAuditor.inspectKeychainBackedEncryptedStore(): SecretStorageEvidence`；不通过 Bot helper 假装读取 OAuth。
- Produces: `LarkCliRunner.runBot(request)` and `runUser(request)`；内部 builder 固定加入 `--as bot|user`，调用方不能传 identity。
- Consumes: Keychain service `com.codex-feishu-executive-assistant.bot` and profile `executive-assistant`。

**Decision Record:** 用户已于 2026-07-21 确认 `SECRET_STORAGE_PROFILE=KEYCHAIN_BACKED_ENCRYPTED_STORE`。本 Task 只能实现该档位，不得包含自动切换到 `STRICT_KEYCHAIN_TOKEN_FORK`、文件主密钥或其他 fallback 的路径；证据不符时状态为 `BLOCKED_SECRET_STORAGE`。

**实施拆分：** Task 6A 只实现可离线重复的本地安全 seam 和 synthetic fixture；Task 6B 才在 Stage D 的目标 Mac 上使用专用非真实 canary、真实 LaunchAgent 环境和真实 OAuth health 取得 live 证据。6A 通过不能替代 6B，也不能升级为生产 `PASS`。Task 6 不修补 vendored bridge 的通用失败 stderr 或锁定生产 provider/config；这两项随生产接线归 Task 9，当前只验证成功协议面及 native helper 所有失败均为空 stderr。

**当前状态：** `STAGE_B_TASK6_LOCAL_COMMITTED`。Task 6A 已通过本地门禁和独立复审并完成本地提交；Task 6B 仍未授权执行。

- [x] **Step 1: 写秘密泄漏、身份篡改与 TOCTOU 红测**

红测覆盖：调用方提交 identity/profile/format/method/endpoint/URL/free argv；`--`、保留参数及 `--flag=value`；秘密进入 argv/env/log；helper manifest 自带 node/bridge；release manifest、current、active state、parent 和输入文件在授权窗口漂移；测试编译 seam 产出生产 basename；`.enc` 或目录在检查后漂移。

- [x] **Step 2: 运行精确红测**

Run:

```bash
corepack pnpm exec vitest run \
  packages/action-gateway/test/keychain-helper-native.test.ts \
  packages/action-gateway/test/native-build-security.test.ts \
  packages/action-gateway/test/keychain-storage.test.ts \
  packages/action-gateway/test/security/no-secret-leak.test.ts \
  packages/action-gateway/test/lark-cli-runner.test.ts
```

Expected: 首轮因安全 adapter 缺失失败；后续独立审查反例也必须先在旧实现上失败，再进入修复。

- [x] **Step 3: 实现不经过 shell、兼容 bridge SecretRef 的 Keychain helper**

Swift helper 不接受命令行参数。它先有界读取不含秘密的 stdin，再建立完整授权上下文并解析严格 JSON `{protocolVersion:1,provider,ids}`；只允许一个与安装 App ID 精确对应的 `app-<AppID>`。读取 Secret 之前和之后都重新核验 install/current/release/helper/active/parent/running-code 全链，任何漂移均不向 stdout 输出 Secret。成功时 stdout 仅返回 bridge-compatible `{protocolVersion:1,values:{id:secret},errors:{}}`；所有失败为空 stderr。

installer 另写 exact `keychain-helper-manifest v1`，其中只允许 App ID、provider、helper identity 与既有 `release-manifest.json` 的当前 release 固定绝对路径和 SHA-256；不得在 sidecar 自报 node/bridge。helper 不扩展既有 `release-manifest v1` schema，而是从它读取 node/bridge identity，并要求 sidecar、release manifest 与 active state 的 release hash 一致。manifest/control state 均要求当前 uid、非 symlink、固定 `0600`，父目录链为 `0700`。父进程还必须满足 `getppid`、PID version、euid、`proc_pidpath`、exact `[node, bridgeEntry]` argv、running code designated requirement/CDHash 与活动 instance 全部匹配；仅复制或再次启动同一 binary 不能通过。

- [x] **Step 4: 构建、签名并校验 helper**

```bash
/bin/zsh packages/action-gateway/native/keychain-helper/build.sh
codesign --verify --strict dist/private-bin/assistant-keychain-helper
/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C LANG=C \
  /usr/bin/shasum -a 256 dist/private-bin/assistant-keychain-helper
```

Expected: mode `0500`、codesign verify exit `0`；SHA 由 installer 写入 manifest，不写入源码常量。`ASSISTANT_TESTING` 只能生成精确的 testing/kernel-probe basename，不能生成默认或生产 basename；生产 strings 不含测试 runtime root、sentinel 或 mutation marker。

结果：fresh 本地产物目录 `0700`、binary `0500`、owner uid `501`，strict codesign 通过，测试 marker 匹配数为 `0`；SHA-256 为 `65afd3c24e7c0443ae9a0e6bfb8fa0d26a413d63cb490c29b5a59b32a12405c1`。该哈希只属于当前本机构建，目标 Mac installer 仍须生成并记录自己的最终证据。

- [x] **Step 5: 实现固定 Bot/User 执行器与离线 OAuth 存储审计**

Bot 与 User 使用受信静态 capability registry 和内部 argv builder；runner 只接受版本化结构化 request，builder 固定追加 `--as bot|user`、`--profile executive-assistant` 与 JSON format。调用方提交 identity、method、endpoint、URL、profile、format 或自由 argv 均被拒绝。敏感正文和请求体写入 gateway 私有 `0600` 临时 JSON，经固定 `--data/--params @FILE` 传入；目录为 `0700`，FD 与路径 identity 在关闭后、spawn 前和执行后核对。第二次异步 release evidence 完成后再做最后一次同步 input identity 校验，随后无事件循环让步直接 `spawn`。child process 使用 `shell:false`、最小环境、stdout/stderr 合计 8 MiB、60 秒默认 timeout、TERM→KILL→close 确认和 strict JSON；写操作在 spawn 后无法确认时固定进入 `UNKNOWN`。

`OAuthStorageAuditor` 只接受 synthetic fixture；它检查 canonical 当前 uid `0700` 目录、所有 `.enc` 为 `0600` 且完整 identity 在双重目录枚举与最终重开中稳定，并硬阻断 `master.key.file`。即使本地检查全部通过也只返回 `UNVERIFIED_NO_FIXTURE / REAL_CANARY_REQUIRED`，不能伪造真实 OAuth/Keychain canary。

- [x] **Step 6A: 完成本地 synthetic/fake 联合门禁**

Run exact Task 6 tests、action-gateway 包级测试、全仓 test/format/lint/typecheck/build、Swift strict format、zsh syntax、production codesign/strings、离线 vendor replay 与 `git diff --check`。全部完成并经独立复审后、Step 7 之前，状态只能标记为 `STAGE_B_TASK6_LOCAL_SEAMS_VERIFIED_UNCOMMITTED`。

结果：Task 6 聚焦 5 个测试文件 120/120、action-gateway 14 个文件 340/340、全仓 44 个文件 1099/1099 通过；format、lint、typecheck、build、Swift strict format、zsh syntax、production codesign/marker、离线 vendor replay 与 `git diff --check` 均退出 `0`。Keychain helper 与 runner 的独立最终复审均为 `READY_FOR_LOCAL_SEAM`。未访问真实 Keychain、凭据或网络，未运行真实 CLI/API、OAuth health 或 LaunchAgent。

- [ ] **Step 6B: 在 Stage D 运行 LaunchAgent 等价 live 验证**

目标机使用 `env -i` 仅保留固定 PATH/HOME/运行目录，证明 helper 能以 JSON protocol 静默读取专用测试 App Secret、`lark-cli auth status --json --verify` 能完成 OAuth health、且所有日志/进程参数无 secret。必须证明 `~/Library/Application Support/lark-cli/master.key.file` 不存在、创建后 doctor 立即阻断、凭据 `.enc` 为 `0600`；另用专用非真实 canary 复现 go-keyring 的 `/usr/bin/security` ACL 模型，在生产同参数 Codex sandbox 中尝试 `security find-generic-password`、Security.framework 小探针和 raw lark-cli，三条都必须拿不到 canary且不能发出网络请求。验证证据绑定已安装 Codex binary hash；版本或 hash 变化必须重验。任一越界成功或 file fallback 即 `BLOCKED_SECRET_STORAGE`。测试结束只删除专用测试 service，不触碰真实 item。

- [x] **Step 7: 经授权后提交 Task 6**

```bash
git add README.md CHANGELOG.md \
  docs/superpowers/plans/2026-07-20-02-job-store-and-action-gateway.md \
  docs/superpowers/plans/2026-07-20-03-feishu-capabilities-and-ppt.md \
  docs/superpowers/specs/2026-07-20-codex-feishu-executive-assistant-design.md \
  packages/action-gateway
git commit -m "feat(gateway): isolate Keychain and lark credentials"
```

结果：用户已单独授权 Task 6 本地提交；本步骤随该提交完成。remote、push、PR、部署、LaunchAgent、凭据和真实飞书/Codex 操作仍未执行。

### Task 7: 为每种写能力实现幂等与 UNKNOWN 对账框架

**Files:**
- Create: `packages/action-gateway/src/execution/dispatcher.ts`
- Create: `packages/action-gateway/src/execution/idempotency.ts`
- Create: `packages/action-gateway/src/execution/reconcile.ts`
- Create: `packages/action-gateway/src/execution/adapters.ts`
- Test: `packages/action-gateway/test/dispatcher.test.ts`
- Test: `packages/action-gateway/test/reconcile.test.ts`

**Interfaces:**
- Produces: `ActionAdapter<T>.dispatch(action)` and `.reconcile(action)`。
- Produces: adapters for `message.send`、`calendar.create`、`calendar.update`、`calendar.cancel`、`system_reply`。

- [ ] **Step 1: 写崩溃窗口红测**

```ts
it("reconciles instead of replaying DISPATCHING after restart", async () => {
  const action = seedAction({ state: "DISPATCHING", capability: "calendar.create" });
  const adapter = fakeAdapter({ reconcile: { state: "SUCCEEDED", remoteId: "evt_remote" } });
  await recoverAction(action, adapter, store);
  expect(adapter.dispatch).not.toHaveBeenCalled();
  expect(store.getAction(action.id).state).toBe("RECONCILED");
});

it("keeps unresolved UNKNOWN without dispatch retry", async () => {
  const action = seedAction({ state: "UNKNOWN", capability: "message.send" });
  const adapter = fakeAdapter({ reconcile: { state: "UNKNOWN" } });
  await recoverAction(action, adapter, store);
  expect(adapter.dispatch).not.toHaveBeenCalled();
  expect(store.getAction(action.id).state).toBe("UNKNOWN");
});
```

- [ ] **Step 2: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/action-gateway test -- dispatcher reconcile
```

Expected: FAIL because dispatch/reconcile framework is absent。

- [ ] **Step 3: 固定能力级策略**

```ts
export const IDEMPOTENCY_POLICY = {
  "message.send": { key: "uuid-v5(actionId)", reconcile: "message-id-or-indeterminate" },
  "calendar.create": { key: "action marker in description", reconcile: "marker-and-time-window" },
  "calendar.update": { key: "eventId+beforeHash+actionId", reconcile: "read-current-event" },
  "calendar.cancel": { key: "eventId+beforeHash+actionId", reconcile: "read-current-event" },
  "system_reply": { key: "taskOrControlRef+contentSha256+chatIdHash+uuid-v5(actionId)", reconcile: "message-id-or-indeterminate" },
} as const;
```

- [ ] **Step 4: 实现安全 dispatch 顺序**

`claimApprovedAction → markDispatching → adapter.dispatch → finishAction`。若调用开始后发生 timeout、连接断开或进程退出，记录 `UNKNOWN`；只在确定远端拒绝且无副作用时记录 `FAILED`。恢复只调用 `reconcile`，不得直接 dispatch。消息动作若没有 message_id 且没有已证明的按 UUID 查询能力，必须保持 `UNKNOWN`，或在人工核对后进入 `RECONCILED(reconcile_outcome=INDETERMINATE)`；不得把“再 POST 一次”当作默认查询。

- [ ] **Step 5: 运行绿测和故障注入矩阵**

故障点覆盖：claim 后、DISPATCHING 前、请求发送后响应前、响应写库前、写库后 ACK 前。每个故障点断言远端动作至多一次或停在 UNKNOWN，永不静默二次执行。

- [ ] **Step 6: 经授权后提交 Task 7**

```bash
git add packages/action-gateway
git commit -m "feat(gateway): reconcile uncertain external actions"
```

### Task 8: 实现附件隔离与白名单日志

**Files:**
- Create: `packages/action-gateway/src/files/stage-attachment.ts`
- Create: `packages/action-gateway/src/files/file-policy.ts`
- Create: `packages/action-gateway/src/files/retention.ts`
- Create: `packages/action-gateway/src/logging/safe-log.ts`
- Create: `packages/action-gateway/src/logging/rotation.ts`
- Test: `packages/action-gateway/test/stage-attachment.test.ts`
- Test: `packages/action-gateway/test/safe-log.test.ts`
- Test: `packages/action-gateway/test/retention.test.ts`
- Test: `packages/action-gateway/test/rotation.test.ts`
- Create: `tests/fixtures/attachments/manifest.json`

**Interfaces:**
- Produces: `stageAttachment(input): StagedAttachment`。
- Produces: `SafeLogger.info(eventName, allowedFields)`。
- Consumes: temporary download stream supplied by bridge；不接受任意 source path。

- [ ] **Step 1: 写附件策略红测**

测试必须覆盖：第 11 个附件、单件 `100 MiB + 1`、合计 `300 MiB + 1`、剩余磁盘 `<10 GiB`、扩展名与实际 MIME 不符、symlink、绝对路径、`..`、ZIP/7z/tar、docm/xlsm/pptm、正常 PDF。正常文件最终 mode `0600`，任务目录 `0700`，SHA 与内容一致；压缩包标 `OPAQUE_ARCHIVE`，宏文档标 `MACRO_DOCUMENT`，两者都不得自动打开或解压。

- [ ] **Step 2: 写日志泄漏红测**

```ts
it("drops unapproved fields", () => {
  const output = captureSafeLog({ event: "gateway_error", status: "FAILED_DEPENDENCY", token: "secret", body: "private text", openId: "ou_full" });
  expect(output).toContain("gateway_error");
  expect(output).not.toMatch(/secret|private text|ou_full/);
});
```

- [ ] **Step 3: 运行红测**

Run:

```bash
corepack pnpm --filter @executive-assistant/action-gateway test -- stage-attachment safe-log
```

Expected: FAIL because file and log policies are absent。

- [ ] **Step 4: 实现流式限制与原子落盘**

先检查计数和磁盘；使用 Node `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW` 在最终目录旁创建 mode `0600` temp file，流式计数和 SHA；用锁定的 `file-type@21.1.1` 校验 magic bytes 后在同一目录原子 `rename`。ZIP/7z/tar 仅保存为 `OPAQUE_ARCHIVE`，docm/xlsm/pptm 保存为 `MACRO_DOCUMENT`；不得列目录、解压、执行、调用 Office/LibreOffice 或把附件内容当系统指令。任何失败都关闭句柄并删除 temp。

- [ ] **Step 5: 实现白名单结构化日志**

每个 eventName 使用 discriminated union 显式定义允许字段，不接受任意 object；ID 只记录不可逆短 hash，错误只记录内部 error code，不序列化 `Error.message`、stack、SDK response、raw CLI stderr、request body、附件正文、聊天预览、真实文件名或环境变量。轮转流程由 logger 自己 `fsync → close → rotate → reopen`，测试确认旧 inode 不再增长。

- [ ] **Step 6: 运行绿测与权限扫描**

Run:

```bash
corepack pnpm --filter @executive-assistant/action-gateway test -- stage-attachment safe-log retention rotation
corepack pnpm vitest run tests/security/no-secret-leak.test.ts
```

Expected: PASS；fixture secrets scan count `0`；附件缓存 7 天后清理，日志 14 天后清理，正式 outputs/ppt-projects 不自动删除。

- [ ] **Step 7: 经授权后提交 Task 8**

```bash
git add packages/action-gateway tests/fixtures tests/security
git commit -m "feat(security): isolate attachments and redact logs"
```

### Task 9: 完成一次性配对并把账本、bridge、网关接通

**Files:**
- Create: `packages/job-store/src/pairing.ts`
- Create: `packages/action-gateway/src/pairing.ts`
- Create: `packages/action-gateway/src/approval-card.ts`
- Create: `packages/bridge/src/runtime/codex-home-verifier.ts`
- Create: `vendor/patches/lark-codex-bridge/0007-production-codex-home-verifier.patch`
- Modify: `packages/bridge/src/runtime/assistant-channel.ts`
- Modify: `packages/bridge/PATCHES.md`
- Modify: `dependencies.lock.json`
- Test: `packages/job-store/test/pairing.test.ts`
- Test: `packages/action-gateway/test/approval-card.test.ts`
- Test: `tests/integration/pairing-and-ingest.test.ts`
- Test: `tests/integration/approval-flow.test.ts`
- Test: `packages/bridge/test/codex-home-verifier.test.ts`
- Test: `tests/contracts/vendor-provenance.test.ts`

**Interfaces:**
- Produces: `beginPairing(ttlMs): { code, expiresAt }`，明文 code 只返回一次。
- Produces: `consumePairing(raw): PrincipalBinding`。
- Consumes: bridge `allow_pairing` decision。

- [ ] **Step 1: 写配对与完整审批红测**

```ts
it("binds the first valid private pairing code and then locks", async () => {
  const pairing = store.beginPairing(10 * 60_000);
  await harness.emit(dm({ sender: "ou_president", chat: "oc_dm", text: pairing.code }));
  expect(store.getPrincipal()).toMatchObject({ presidentOpenId: "ou_president", presidentChatId: "oc_dm" });
  await harness.emit(dm({ sender: "ou_other", chat: "oc_other", text: pairing.code }));
  expect(store.getPrincipal()?.presidentOpenId).toBe("ou_president");
});

it("dispatches only the frozen action confirmed by the same president chat", async () => {
  const action = await harness.prepareMessageToThirdParty();
  expect(harness.lastApprovalCard()).toMatchObject({ actionId: action.id, version: action.version, payloadHash: action.payloadHash });
  await harness.confirmCard({ actionId: action.id, nonce: action.nonce, actor: "ou_president", chat: "oc_dm" });
  expect(harness.remoteDispatches).toHaveLength(1);
  expect(harness.remoteDispatches[0].payloadHash).toBe(action.payloadHash);
});

it("records system reply as a policy-approved action bound to the task chat", async () => {
  const task = seedPresidentTask({ chatId: "oc_dm" });
  await harness.sendSystemReply(task.id, outputFileOwnedBy(task));
  const action = store.lastAction(task.id);
  expect(action).toMatchObject({ capability: "system_reply", identity: "bot", approvalMode: "system_policy", state: "SUCCEEDED" });
  expect(action.chatIdHash).toBe(hashId("oc_dm"));
});

it("records a no-active-task cancel reply against the control event", async () => {
  const control = seedCancelControlEvent({ chatId: "oc_dm", targetTaskId: null });
  await harness.sendControlReply(control.id, { type: "text", value: "当前没有运行中的任务。" });
  expect(store.lastActionForControl(control.id)).toMatchObject({
    taskId: null,
    controlEventId: control.id,
    capability: "system_reply",
    identity: "bot",
    approvalMode: "system_policy",
  });
});
```

- [ ] **Step 2: 运行红测**

Run:

```bash
corepack pnpm vitest run packages/job-store/test/pairing.test.ts tests/integration/pairing-and-ingest.test.ts tests/integration/approval-flow.test.ts
```

Expected: FAIL because persistence and integration wiring are incomplete。

- [ ] **Step 3: 实现随机码和单次原子绑定**

使用 128-bit CSPRNG，向人显示 Crockford Base32；数据库只存 SHA-256、app、tenant、expiry 和 active flag。消费时在 transaction 中核对 active/expiry/hash/chatType，再写 principal 并永久关闭该 pairing record。不得记录明文码。

- [ ] **Step 4: 把 bridge 接到真实 JobStore/BridgeGatewayClient**

启动顺序固定为：文件锁 → pre-integrity → checksum migration → post-integrity → runtime lease → gateway ready → 原子写 active-instances control state → bridge WebSocket ready。任一失败均不启动 Codex。bridge 的 ACK、进度、错误、结果、本任务文件回传和控制事件回复都调用 control API；gateway 创建 `system_reply` action，固定 Bot、账本推导出的原总裁 chat、稳定 UUID。任务文件还必须属于当前 task 且 SHA 匹配；控制回复只允许 text 且绑定 control_event。两者都以 `system_policy` 自动 APPROVED，并经过 CLAIMED/DISPATCHING/结果和 UNKNOWN 对账，不能绕过 action ledger。

真实 TaskSink adapter 必须绑定安装配置中的 canonical `jobsRoot`：先生成 UUID、以 `0700` 原子创建唯一 candidate，再调用 `JobStore.ingestEvent`。若返回 `duplicate=true` 且账本 task ID 与 candidate UUID 不同，只允许在重新核验 candidate 仍是本次创建、位于固定 root、无 symlink 且为空后删除该 candidate；已有账本 workspace 永不由这条清理路径删除。对应集成测试必须覆盖重复投递、清理失败留作 doctor 处理，以及不得越出固定 root。

production `verifyCodexHome` adapter 必须生成而非硬编码 `permissionProfileCompatible`：安全读取并绑定专用 `CODEX_HOME`、从 jobs root 到 task workspace 的所有受信任 `.codex/config.toml`、`/etc/codex/config.toml` 及本机可见 managed requirements/config，拒绝任何 legacy `sandbox_mode` / `sandbox_workspace_write` 或无法解释的配置层。随后用锁定 Codex binary/hash 和最终 `assistant-task` profile 运行无模型 sandbox probe，只有 task A socket 成功且 task B、control、本地 HTTP、外部 TCP 全部失败才返回 true；证据必须绑定文件 identity/hash、binary hash 和 profile canonical hash，任一漂移在下次 spawn 前变回 false。云端/MDM 层无法直接枚举时，以实际有效配置矩阵为最终门禁，不得用一个常量布尔值替代。

由于 production verifier 位于锁定的 vendored bridge 依赖，Task 9 还必须把实现与 wiring 生成为独立的 `0007` vendor patch，更新 `PATCHES.md`、`dependencies.lock.json` 的 patch SHA、patched tree SHA 与 strict manifest SHA，并让 provenance test 在离线 clean-room 中从锁定源码重放 `0001..0007` 后校验完全一致。只改当前工作树、漏记 patch、或无法离线重放都不得产出 compatible evidence。

`prepareAction` 落库成功后由 gateway 从冻结的 `preview_json + action_id + version + payload_hash + nonce + expires_at` 渲染固定飞书确认卡；Codex 和 capability adapter 不能提交 card JSON。卡片正文通过 gateway 私有 `0600` body file 发送到任务原总裁 chat，固定 Bot 身份，只提供“确认执行/放弃”两个 callback。发送卡片本身也记录为 `system_reply` action；卡片发送 UNKNOWN 时不自动重发，旧动作保持 PREPARED 但不能在未收到有效 callback 时执行。callback 必须走 bridge control API，并在同一事务中核对签名、tenant、actor、chat、action/version/hash/nonce/expiry；拒绝或过期使 PREPARED 动作进入 FAILED 并记录原因。

- [ ] **Step 5: 运行绿测和进程重启集成测试**

Run:

```bash
corepack pnpm vitest run packages/job-store/test/pairing.test.ts tests/integration/pairing-and-ingest.test.ts tests/integration/approval-flow.test.ts
corepack pnpm vitest run packages/bridge/test/codex-home-verifier.test.ts tests/contracts/vendor-provenance.test.ts
corepack pnpm vendor:verify-offline
corepack pnpm test
```

Expected: PASS；重启后 principal 仍生效，pairing code 不可复用，运行任务变成 `INTERRUPTED_REQUIRES_CONFIRMATION`。

- [ ] **Step 6: 经授权后提交 Task 9**

```bash
git add packages/job-store packages/action-gateway packages/bridge tests/integration \
  dependencies.lock.json tests/contracts/vendor-provenance.test.ts \
  vendor/patches/lark-codex-bridge/0007-production-codex-home-verifier.patch
git commit -m "feat: connect pairing ledger and action gateway"
```

### Task 10: 阶段 B 安全门禁

**Files:**
- Create: `tests/security/gateway-bypass.test.ts`
- Create: `tests/security/action-replay.test.ts`
- Create: `docs/runbook/runtime-security.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Tasks 1–9。
- Produces: stage-B evidence report under test output only；不包含客户数据。

- [ ] **Step 1: 写绕过和重放集成测试**

测试模拟恶意附件提示词要求：调用绝对 `lark-cli`、读取 Keychain、修改 socket 请求 identity、重用审批 nonce、改 payload 后沿用旧确认、直接联网飞书。每条都必须在技术边界失败，不允许只靠 prompt 文案通过。

- [ ] **Step 2: 运行所有安全测试**

Run:

```bash
corepack pnpm vitest run tests/security
```

Expected: PASS；`external_dispatch_count=0` for every bypass case。

- [ ] **Step 3: 故障注入数据库和进程窗口**

Run:

```bash
corepack pnpm vitest run packages/job-store/test tests/integration/approval-flow.test.ts --reporter=verbose
```

Expected: duplicate task count `0`；duplicate remote action count `0`；unresolved cases remain `UNKNOWN`。

- [ ] **Step 4: 执行阶段 B 全量质量门**

Run:

```bash
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
git diff --check
```

Expected: all exit `0`；无 skipped security tests。

- [ ] **Step 5: 经授权后提交阶段 B 收口**

```bash
git add tests/security docs/runbook/runtime-security.md CHANGELOG.md
git commit -m "test: close durable action security gate"
```

## Stage B Review Gate

Reviewer 必须确认：

- 重放入站事件只返回已有 task_id，不重复 ACK 或调度。
- crash/restart 后没有任务或动作静默重跑。
- Codex 进程、prompt、argv、env、日志和 fixture 均无凭据。
- 未经确认、确认过期、actor/chat 不符、payload 改变、nonce 重用全部被拒绝。
- `system_reply` 不能改变目标或身份。
- Keychain helper 的父进程、签名、路径和 hash 校验有真实 macOS 测试，不是 mock-only。
- UNKNOWN 对账无结论时保持 UNKNOWN，不自动再次发送。
- 只有全部成立，阶段 B 才能标记 `PASS` 并进入飞书业务能力实施。
