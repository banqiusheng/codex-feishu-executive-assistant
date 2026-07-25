# ACK Recovery and Zero-Copy Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task by task. Every production change starts with a focused failing test, every task receives an independent review, and no later task may weaken the ACK or credential boundaries in the confirmed design.

**Goal:** Make a persisted Feishu task recover automatically from a provably pre-request DNS failure, keep every ambiguous ACK fail-closed, add credential-free Feishu network diagnosis, and make missing user OAuth scopes open the trusted authorization page directly from the terminal.

**Architecture:** Add an ACK ledger beside `tasks`, gate claims on the ledger plus the existing private marker, and put one FIFO ACK coordinator between the bridge and transport. Keep doctor probes and OAuth parsing in small script modules with injected test seams. Reuse the pinned `lark-cli 1.0.72`; do not change the vendored bridge, broaden scopes, or add a second agent platform.

**Tech Stack:** TypeScript 5.6, Node.js ESM, SQLite/better-sqlite3, Vitest, zsh installer/doctor entrypoints, pinned `@larksuiteoapi/node-sdk` and pinned `lark-cli 1.0.72`.

## Global Constraints

- Source of truth: `docs/superpowers/specs/2026-07-25-feishu-ack-recovery-and-zero-copy-auth-design.md`.
- Runtime order remains `persist -> durable ACK proof -> claim -> Codex`.
- Only exact own-data `code` values `ENOTFOUND` and `EAI_AGAIN` are retryable.
- Timeouts, disconnects, unknown wrappers, local marker failures, and database finalization failures are ambiguous and must never auto-retry or execute.
- Do not log or fixture App Secret, OAuth tokens, authorization URLs, device codes, customer text, full Feishu IDs, private paths, IP addresses, proxy values, or raw SDK errors.
- Do not change DNS, VPN, proxy, FileVault, power, sleep, Apple ID, or macOS security settings.
- `--plan`, `--verify-only`, and doctor are read-only and must never open a browser.
- The authorized release boundary is local commits followed by a push of public `main`; no PR, Tag, or Release.

---

### Task 1: Persist the ACK ledger and enforce the database claim gate

**Files:**

- Create: `packages/job-store/migrations/003_task_acknowledgements.sql`
- Create: `packages/job-store/src/acknowledgements.ts`
- Create: `packages/job-store/test/acknowledgements.test.ts`
- Modify: `packages/job-store/src/events.ts`
- Modify: `packages/job-store/src/tasks.ts`
- Modify: `packages/job-store/src/types.ts`
- Modify: `packages/job-store/src/open-store.ts`
- Modify: `packages/job-store/src/index.ts`
- Modify: `packages/job-store/test/events.test.ts`
- Modify: `packages/job-store/test/tasks.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Step 1: Write and run the failing tests**

Add tests that prove:

1. A new root task and its `NOT_ATTEMPTED` ACK row commit atomically.
2. A replacement task receives its own `NOT_ATTEMPTED` row.
3. A legacy task with no row is not claimable.
4. `claimNextTask` selects only `RECEIVED + ACKNOWLEDGED`.
5. The oldest safe ACK candidate is selected FIFO.
6. `beginTaskAcknowledgement` requires the live bridge lease, accepts only
   `NOT_ATTEMPTED` or `RETRYABLE_DNS`, increments `attemptCount`, and persists
   `SENDING`.
7. Finalization accepts only the exact transitions in the confirmed state
   machine.
8. Startup reconciliation promotes a valid marker to `ACKNOWLEDGED`, keeps
   `NOT_ATTEMPTED` / `RETRYABLE_DNS` recoverable, and turns missing-row,
   markerless `SENDING`, `AMBIGUOUS`, or inconsistent states into
   `INTERRUPTED_REQUIRES_CONFIRMATION`.
9. No persisted failure detail contains host, route, customer text, or raw
   errors.

Run:

```bash
corepack pnpm exec vitest run packages/job-store/test/acknowledgements.test.ts packages/job-store/test/events.test.ts packages/job-store/test/tasks.test.ts
```

Expected first result: FAIL because migration 003 and ACK store APIs do not yet
exist. Capture this expected reason in the task report.

**Step 2: Add the checksum migration**

Create `task_acknowledgements` with:

```sql
CREATE TABLE task_acknowledgements (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN (
    'NOT_ATTEMPTED',
    'SENDING',
    'RETRYABLE_DNS',
    'ACKNOWLEDGED',
    'AMBIGUOUS',
    'FAILED_DEFINITE'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  last_failure_class TEXT
    CHECK (last_failure_class IS NULL OR last_failure_class IN (
      'DNS_UNAVAILABLE',
      'REMOTE_REJECTED',
      'RESULT_AMBIGUOUS',
      'LOCAL_EVIDENCE_FAILED'
    )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX task_acknowledgements_recovery_order
  ON task_acknowledgements(state, created_at, task_id);
```

Do not backfill historical tasks. The absence of a row is intentionally
ambiguous.

**Step 3: Add strict ACK store operations**

Export these exact public types and methods:

```ts
type TaskAcknowledgementState =
  | "NOT_ATTEMPTED"
  | "SENDING"
  | "RETRYABLE_DNS"
  | "ACKNOWLEDGED"
  | "AMBIGUOUS"
  | "FAILED_DEFINITE";

type TaskAcknowledgementFailureClass =
  | "DNS_UNAVAILABLE"
  | "REMOTE_REJECTED"
  | "RESULT_AMBIGUOUS"
  | "LOCAL_EVIDENCE_FAILED";

type TaskAcknowledgementRecord = Readonly<{
  taskId: string;
  state: TaskAcknowledgementState;
  attemptCount: number;
  lastFailureClass: TaskAcknowledgementFailureClass | null;
  createdAt: string;
  updatedAt: string;
}>;
```

Add `getTaskAcknowledgement(taskId)`,
`getNextTaskAcknowledgementCandidate()`,
`beginTaskAcknowledgement({ taskId, owner, now })`,
`finishTaskAcknowledgement({ taskId, owner, now, state, failureClass })`, and
`reconcileTaskAcknowledgement({ taskId, owner, now, markerPresent })` to
`JobStore` and `SqliteJobStore`.

All inputs must use the repository's exact own-data snapshot pattern. Every
mutation must verify a live bridge lease and the task's allowed state inside one
immediate transaction. `finishTaskAcknowledgement` may finalize only a current
`SENDING` row. Ambiguous and definite failure finalization must atomically move
the task to a safe non-executable terminal/recovery state and invalidate pending
task actions through existing task lifecycle helpers.

**Step 4: Wire atomic task creation and claim/recovery**

- Insert `NOT_ATTEMPTED` in the same transaction as each new root or replacement
  task.
- Join `task_acknowledgements` in `claimNextTask` and require
  `state = 'ACKNOWLEDGED'`.
- Keep the runtime file gate even after adding the database gate.
- Replace broad startup interruption of `RECEIVED` tasks with ACK-aware
  reconciliation; continue interrupting expired `CLAIMED` / `RUNNING` tasks.

**Step 5: Re-run the targeted tests**

Run the command from Step 1. Expected: PASS.

**Step 6: Update public status and commit**

README must say the durable database gate is implemented but runtime retry,
doctor, OAuth, and real E2E are still pending. CHANGELOG must record the schema
and claim safety change without claiming release completion.

Run:

```bash
corepack pnpm --filter @executive-assistant/job-store typecheck
corepack pnpm --filter @executive-assistant/job-store build
git diff --check
git status --short
```

Commit only this task.

---

### Task 2: Add the single FIFO ACK coordinator and runtime recovery

**Files:**

- Create: `packages/runtime/src/ack-coordinator.ts`
- Create: `packages/runtime/test/ack-coordinator.test.ts`
- Modify: `packages/runtime/src/runtime.ts`
- Modify: `packages/runtime/test/runtime.e2e.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Step 1: Write deterministic failing coordinator tests**

Use injected `send`, `delay`, `now`, `loadRoute`, `writeMarker`, and `wakeWorker`
functions. Prove:

1. `retryableDnsCode` accepts only an exact own-data `code` equal to
   `ENOTFOUND` or `EAI_AGAIN`.
2. Backoff is exactly `1, 2, 4, 8, 15, 30, 60, 60...` seconds.
3. Only one ACK is in flight and the oldest DNS-retrying task blocks later ACKs.
4. Success writes marker, finalizes the database fact, then wakes the worker.
5. A marker write failure becomes `AMBIGUOUS`, does not resend, and does not
   wake.
6. Timeout, disconnect, wrapped/unknown errors, and database finalization
   uncertainty never retry or wake.
7. `stop()` cancels pending delay and prevents later sends.

Run:

```bash
corepack pnpm exec vitest run packages/runtime/test/ack-coordinator.test.ts
```

Expected first result: FAIL because `ack-coordinator.ts` does not exist.

**Step 2: Implement the coordinator**

Expose a small factory:

```ts
createAckCoordinator(options): Readonly<{
  start(): Promise<void>;
  wake(): void;
  stop(): Promise<void>;
  waitForIdle(): Promise<void>;
}>;
```

The coordinator reads the oldest candidate from `JobStore`, persists `SENDING`
before transport, restores the private route, sends the fixed bridge
acknowledgement, atomically creates `acknowledged.json` with mode `0600`,
finalizes `ACKNOWLEDGED`, and only then wakes the existing single-concurrency
worker. It never stores routes in the database or logs an error object.

**Step 3: Write failing runtime integration tests**

Extend `runtime.e2e.test.ts` to prove:

- a persisted `ENOTFOUND` and `EAI_AGAIN` failure recovers without a new user
  message;
- the ACK and Codex task each happen once;
- an unknown ACK error stays non-executable and is not retried;
- duplicate delivery restores the original private route and wakes the same
  coordinator without creating a second task;
- restart from `RETRYABLE_DNS` resumes safely;
- restart from markerless `SENDING` or legacy no-row interrupts for
  confirmation;
- a valid marker can repair `SENDING`, while a database
  `ACKNOWLEDGED` row with a missing marker never starts the runner.

Run:

```bash
corepack pnpm exec vitest run packages/runtime/test/runtime.e2e.test.ts
```

Expected first result: FAIL on the new recovery assertions.

**Step 4: Integrate runtime startup, duplicate, gateway, and close**

- Acquire the existing store and bridge lease before ACK reconciliation.
- Strictly read `input.json` for every safe recovery candidate and reconstruct
  routes in memory.
- Start the channel, then the coordinator.
- In `taskSink.ingest`, load the accepted original task input for duplicate
  events, restore its route, and call `coordinator.wake()` before returning.
- Make `gateway.sendSystemReply` delegate the acceptance ACK to the coordinator;
  control replies and final replies keep their existing behavior.
- Preserve the worker's `taskWasAcknowledged()` check.
- Close the coordinator before releasing the bridge lease or store.

Do not patch `packages/bridge/vendor`; the runtime adapter owns the recovery.

**Step 5: Run targeted gates and commit**

```bash
corepack pnpm exec vitest run packages/runtime/test/ack-coordinator.test.ts packages/runtime/test/runtime.e2e.test.ts
corepack pnpm --filter @executive-assistant/runtime typecheck
corepack pnpm --filter @executive-assistant/runtime build
git diff --check
```

README and CHANGELOG must say the runtime path is implemented and locally
tested, while doctor, OAuth, full gates, public push, and real Feishu replay
remain pending. Commit only this task.

---

### Task 3: Add credential-free Feishu DNS and HTTPS doctor checks

**Files:**

- Create: `scripts/doctor-feishu-network.mjs`
- Create: `tests/ops/doctor-feishu-network.test.ts`
- Modify: `scripts/doctor`
- Modify: `scripts/install`
- Modify: `tests/ops/delivery-surface.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Step 1: Write the failing tests**

Prove:

- DNS uses the configured absolute Node and resolves fixed
  `open.feishu.cn` without exposing addresses.
- HTTPS uses fixed `HEAD https://open.feishu.cn/open-apis/`; any HTTP status
  from 100 through 599 is `PASS`.
- DNS empty/error is `DNS_UNAVAILABLE`; HTTPS error/timeout is
  `REST_UNREACHABLE`.
- Parent proxy variables, `HOME`, `NODE_OPTIONS`, and sentinels are absent from
  the child environment.
- Nonzero exit, timeout, oversized/malformed output, invalid UTF-8, extra JSON
  keys, raw errors, host, URL, IP, proxy values, and private paths fail closed
  into fixed classifications.
- doctor exposes `feishu-dns` and `feishu-https-rest`; the installer verifies
  the helper is a regular non-symlink delivery file.

Run:

```bash
corepack pnpm exec vitest run tests/ops/doctor-feishu-network.test.ts tests/ops/delivery-surface.test.ts
```

Expected first result: FAIL because the helper and checks do not exist.

**Step 2: Implement the fixed probe helper**

Export injectable `probeFeishuDns`, `probeFeishuHttpsRest`, and
`runConfiguredFeishuProbes`. Production defaults must:

- use `dns.promises.lookup("open.feishu.cn", { all: true, verbatim: true })`;
- use a 4-second HTTPS timeout;
- spawn the configured Node with a 5-second hard timeout and 4096-byte maximum
  output;
- use exact environment
  `{ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" }`;
- output only exact-schema JSON with `PASS`, `DNS_UNAVAILABLE`, or
  `REST_UNREACHABLE`.

`scripts/doctor` maps the classifications into its existing `status/detail`
report shape. It must not use App Secret, bot/user tokens, or any write API.

**Step 3: Run targeted gates and commit**

```bash
/bin/zsh -n scripts/doctor
node --check scripts/doctor-feishu-network.mjs
corepack pnpm exec vitest run tests/ops/doctor-feishu-network.test.ts tests/ops/delivery-surface.test.ts tests/ops/install-compatibility.test.ts
ASSISTANT_TEST_MODE=1 ./scripts/install --verify-only
git diff --check
```

README and CHANGELOG must distinguish network reachability from application
permission or business success. Commit only this task.

---

### Task 4: Replace copy/paste OAuth with validated browser launch

**Files:**

- Create: `scripts/feishu-user-auth.mjs`
- Create: `tests/ops/feishu-user-auth.test.ts`
- Modify: `scripts/install`
- Modify: `tests/ops/delivery-surface.test.ts`
- Modify: `tests/ops/install-compatibility.test.ts`
- Modify: `BOOTSTRAP.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Step 1: Lock the pinned CLI contract before production code**

Read the locally verified `lark-cli 1.0.72` implementation or an official
source/fixture. Record in the test fixture:

- exact top-level JSON keys from `auth login --no-wait --json`;
- exact authorization URL field;
- exact device-code field;
- exact official HTTPS host allowlist;
- exact success behavior of `auth login --device-code <code>`.

If any field cannot be verified, stop this task as `BLOCKED_CLI_CONTRACT`; do not
guess, scrape human text, or add a manual copy/paste fallback.

**Step 2: Write the failing helper and installer tests**

Prove:

1. `--apply` invokes the pinned CLI with exact profile, exact missing scopes,
   `auth login --no-wait --json`, then fixed `/usr/bin/open`, then
   `auth login --device-code <code>`.
2. The helper enforces bounded stdout, fatal UTF-8, strict JSON including
   duplicate-key rejection, and exact schema.
3. The URL must be HTTPS, contain no credentials, newline, NUL, or fragment,
   and use only the audited host allowlist.
4. URL and device code never appear in stdout, stderr, thrown messages,
   installer logs, configuration, or files.
5. `/usr/bin/open` missing/nonzero, no GUI, malformed output, unknown host, and
   CLI failure stop at `BLOCKED_USER_AUTH` without fallback.
6. `--plan`, `--verify-only`, and doctor never spawn `/usr/bin/open`.
7. After browser authorization, existing `auth status` and
   `auth check --scope` prove identity, token health, and zero remaining scope
   delta.

Run:

```bash
corepack pnpm exec vitest run tests/ops/feishu-user-auth.test.ts tests/ops/delivery-surface.test.ts tests/ops/install-compatibility.test.ts
```

Expected first result: FAIL because the helper does not exist and installer
still uses interactive `auth login --scope`.

**Step 3: Implement the helper and wire apply-only flow**

The helper may receive temporary CLI JSON only through in-memory bounded pipes.
It calls absolute `/usr/bin/open` itself and returns only a fixed success/failure
classification to zsh. Test seams must be module-level dependency injection;
production must not allow environment overrides of CLI or opener paths.

The installer user-facing line is exactly the equivalent of:

```text
已打开飞书授权页，请在浏览器完成授权。
```

It must never print a URL or device code. Keep App Secret Keychain behavior and
incremental scope calculation unchanged.

**Step 4: Run targeted gates and commit**

```bash
/bin/zsh -n scripts/install
node --check scripts/feishu-user-auth.mjs
corepack pnpm exec vitest run tests/ops/feishu-user-auth.test.ts tests/ops/delivery-surface.test.ts tests/ops/install-compatibility.test.ts
ASSISTANT_TEST_MODE=1 ./scripts/install --plan
ASSISTANT_TEST_MODE=1 ./scripts/install --verify-only
git diff --check
```

README, BOOTSTRAP, and CHANGELOG must describe the one-click browser flow and
its fail-closed boundary. Commit only this task.

---

### Task 5: Full verification, public-main integration, and real replay

**Files:**

- Modify: `docs/superpowers/specs/2026-07-25-feishu-ack-recovery-and-zero-copy-auth-design.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify only if a verification defect requires a tested correction: files
  already named in Tasks 1–4

**Step 1: Run a clean full local gate**

From the feature branch:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
./scripts/vendor-bridge --offline-replay
ASSISTANT_TEST_MODE=1 ./scripts/install --verify-only
gitleaks detect --source . --config .gitleaks.toml --redact
git diff --check
git status --short
```

Any failure re-enters the nearest task's red/green loop. Do not weaken a test to
make a gate green.

**Step 2: Independent final review**

Review the exact diff against the confirmed design for P0/P1 safety,
credential/log leakage, backward compatibility, browser-open scope, and
documentation truth. Resolve all blocking findings and re-run the complete gate
after the last change.

**Step 3: Update honest release state**

- Mark the design `IMPLEMENTED_AND_LOCALLY_VERIFIED` only after the full gate.
- README and CHANGELOG must state precisely which synthetic/local checks passed.
- Do not state `production ready` or 24H availability.
- Keep customer-Mac and continuous 24-hour validation as separate pending
  acceptance gates.

Commit the verified documentation/final fixes on the feature branch.

**Step 4: Fast-forward public main and push**

Verify the configured remote points at
`banqiusheng/codex-feishu-executive-assistant`, fetch without changing worktree,
and require public `main` to be an ancestor of the feature branch. Then:

```bash
git switch main
git merge --ff-only codex/ack-recovery-zero-copy-auth
git push origin main
```

Do not create a PR, Tag, or Release. Record the exact pushed commit and verify
the remote branch points to it.

**Step 5: Reinstall/restart the current simulated Mac and replay**

Using the pushed public `main` and existing private Keychain/config only:

1. run installer apply from a visible terminal;
2. verify missing authorization opens the default browser automatically;
3. restart the LaunchAgent;
4. run doctor and confirm both fixed network checks;
5. send one unique synthetic private-message test from the paired user;
6. confirm exactly one ACK, one Codex run, and one final reply;
7. if DNS can be safely simulated only by code injection, rely on the targeted
   test—do not change system DNS/VPN/proxy.

Real replay is a post-push acceptance gate. If it requires the user's visible
browser click or Feishu message, report the exact waiting action rather than
claiming completion.

