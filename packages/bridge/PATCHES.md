# Audited patches

## `0001-workspace-adapter.patch`

- Purpose: adapt the reviewed upstream package to the private
  `@executive-assistant/bridge` workspace package, make build/typecheck/test
  commands and Vitest discovery explicit, pin direct dependency versions,
  remove the nested pnpm workspace and lock so the root workspace is the only
  dependency authority, and record provenance metadata.
- Runtime or business logic: none.
- Applies to upstream commit:
  `e8b0dc0cdfe2fb378bef7081618138a20d934aa9`.
- Verification: offline provenance and strict-manifest tests, install from the
  bridge directory with the root frozen lock, bridge tests/typecheck, repeated
  identical vendor imports, conflict negative tests, and repository gates.

## `0002-fail-closed-ingress.patch`

- Purpose: add a typed, side-effect-free ingress policy decision and an
  injectable guard boundary that rejects unsupported events, groups, unpaired
  normal messages, principal mismatches, and unbound card callbacks before any
  authorized continuation.
- Runtime or business logic: fail-closed security seam only. The existing live
  channel is intentionally not wired to this seam in Task 4; subscription
  pruning, durable task ingestion, acknowledgements, and live wiring belong to
  Stage A / Task 6.
- Applies after `0001-workspace-adapter.patch` to upstream commit
  `e8b0dc0cdfe2fb378bef7081618138a20d934aa9`.
- Exact paths: `PATCHES.md`, `src/security/ingress-guard.ts`,
  `src/security/policy.ts`, `test/channel-deny.test.ts`, and
  `test/ingress-guard.test.ts`.
- Verification: negative and positive ingress decisions, strict pairing hash
  validation with timing-safe digest comparison, malformed runtime metadata
  rejection without throws, explicit deny-all policy state, sanitized rejection
  audit, shared card gates, deny-before-body/media/task spies, bridge typecheck,
  offline patch path allowlists, deterministic vendor replay, strict manifest,
  and repository gates.

## `0003-constrained-codex-runner.patch`

- Purpose: add a constrained, injectable Codex runner seam and strict task
  workspace resolver without connecting either seam to the existing live
  channel.
- Runtime or business logic: static invocation construction, trusted verifier
  evidence checks, one-time own-data snapshots for requests, dependencies, and
  verifier evidence, minimal child environment, stdin-only prompts with observed
  writable completion, raw-byte-bounded fatal-UTF-8 JSONL parsing, a fail-closed
  Codex 0.142 protocol state machine, and close-confirmed interruption handling.
  Proxies, accessors, hidden/symbol/unknown request fields, sparse or extended
  evidence arrays, and post-construction dependency replacement fail closed;
  captured capabilities run without the mutable dependency record as receiver,
  and the final argv/environment/options are frozen before spawn.
  The verifier interfaces are mandatory seams; Stage A does not claim that a
  real Codex binary, gateway release signature, UDS, macOS sandbox, or network
  denial was exercised.
- Applies after `0001-workspace-adapter.patch` and
  `0002-fail-closed-ingress.patch` to upstream commit
  `e8b0dc0cdfe2fb378bef7081618138a20d934aa9`.
- Exact paths: `PATCHES.md`, `src/agent/codex-runner.ts`,
  `src/security/workspace.ts`, `test/codex-runner.test.ts`, and
  `test/workspace.test.ts`.
- Verification: canonical UUID and realpath boundaries, strict `0700` task
  workspaces and Codex home evidence, `0600` non-symlink UDS evidence, Codex
  minimum-version and required-feature evidence, release manifest/hash/signature
  evidence, async mutation/TOCTOU tests across request, dependencies, verifier
  objects and arrays, exact safe argv, frozen invocation, environment allowlist,
  prompt backpressure and redaction, strict known-event ordering, four-field
  completion usage, sanitized
  nonterminal reconnect diagnostics, resume session binding, raw-byte line and
  queue bounds, fatal UTF-8, 30-minute accepted-event idle reset, TERM/KILL with
  an explicit unconfirmed-termination stream and result settlement only after
  observed close, no automatic retry, deterministic vendor replay, strict
  manifest, and repository gates. Resume JSONL compatibility is a static shared-
  handler inference (`UNVERIFIED_RESUME_PROTOCOL`), not a recorded resume run;
  a minimum-version feature probe also does not establish schema compatibility
  for future Codex versions, whose unknown events therefore fail closed.

## `0004-ledger-first-assistant-channel.patch`

- Purpose: replace the supported bridge ingress path with a narrow injected
  SDK adapter and a ledger-first assistant channel. The channel routes only
  guarded president-DM messages, verified card bindings, deterministic exact
  cancellation phrases, task acceptance acknowledgements, and persisted-stage
  progress through explicit ports.
- Runtime or business logic: the guard runs before body/resource access;
  `TaskSink.ingest()` resolves before a fixed ACK and scheduler wake; duplicate
  events have no repeated effects; cancellation is normalized and persisted
  before a fixed control reply; progress starts at 60 seconds and emits only
  distinct allowlisted persisted stages from an atomic subscribe-and-snapshot
  hand-off. Trusted card actions are projected into bounded, deeply frozen JSON,
  encoded with sorted-key canonical JSON, and SHA-256-bound to the verifier
  evidence before an asynchronous sink can observe them; a mismatched or
  verifier-pending replacement fails closed. All gateway bodies and internal
  errors are fixed and fail closed.
- Supported adapter boundary: only message, card-action, and sanitized lifecycle
  handlers are registered. Card actions require exact trusted verifier evidence.
  Legacy command, reaction, comment, media, direct-send, secret-resolution, and
  AgentAdapter paths are unreachable from the supported adapter. Until Stage B
  supplies all durable runtime ports, the CLI start command intentionally exits
  with `ASSISTANT_RUNTIME_PORTS_REQUIRED` before reading configuration, secrets,
  or opening a connection. Registration/connect failures perform best-effort
  disconnect cleanup, and the actual package root plus both bin commands expose
  only this fail-closed Stage A surface. Package pre-hooks build the contracts
  dependency so the same checks pass from a clean frozen install.
- Applies after `0001-workspace-adapter.patch`,
  `0002-fail-closed-ingress.patch`, and
  `0003-constrained-codex-runner.patch` to upstream commit
  `e8b0dc0cdfe2fb378bef7081618138a20d934aa9`.
- Exact paths: `PATCHES.md`, `package.json`, `src/bot/channel.ts`,
  `src/cli/commands/start.ts`, `src/cli/index.ts`, `src/index.ts`,
  `src/runtime/assistant-channel.ts`, `src/runtime/progress-reporter.ts`,
  `src/runtime/system-reply.ts`, `test/assistant-channel.test.ts`,
  `test/channel-adapter.test.ts`, `test/progress-reporter.test.ts`, and
  `test/start-fail-closed.test.ts`.
- Verification: ordered persist/ACK/wake tests; deny, pairing, card, duplicate,
  cancel, malformed-port, gateway-failure, and fixed-error matrices; fake-timer
  progress tests including atomic snapshot hand-off, malformed-subscription
  cleanup across every safely recoverable object shape, and revoked-event
  fail-closed behavior; registration cleanup, immutable and payload-bound card
  actions including verifier-pending replacement, actual CLI/package-root, and
  forbidden-import tests;
  bridge tests and typecheck from both the working tree and a clean frozen
  install; package/bin build execution in an isolated temporary workspace so
  the audited vendor tree remains read-only during parallel tests; exact
  per-patch path allowlists; reverse/forward patch checks;
  deterministic vendor replay; strict manifest; and repository gates.
- Evidence boundary: Task 6 proves local seam ordering with injected fakes. It
  does not prove SQLite durability, restart/lease recovery, real Feishu or Codex
  E2E, deployment, or 24-hour availability.

## `0005-static-dynamic-access-boundary.patch`

- Purpose: remove every runtime-computed element access from the four supported
  Stage A entry graphs so the repository security analyzer can reject that
  syntax without contextual, primitive-use, assignment-target, or source-path
  exceptions.
- Runtime or business logic: key-set comparisons use equal length plus static
  `includes`; raw ingress metadata is copied through explicit named fields;
  runner snapshots preserve ordinary assignment descriptors through
  `Object.defineProperty`; version components use static `Array.at`; usage
  fields are read once through named properties; fixed system replies use
  exhaustive switches. These changes preserve supported outputs while removing
  identifier-shadow, coercion, callable-assignment, and repeated-read ambiguity.
- Applies after `0001-workspace-adapter.patch` through
  `0004-ledger-first-assistant-channel.patch` to upstream commit
  `e8b0dc0cdfe2fb378bef7081618138a20d934aa9`.
- Exact paths: `PATCHES.md`, `src/agent/codex-runner.ts`,
  `src/bot/channel.ts`, `src/runtime/assistant-channel.ts`,
  `src/runtime/progress-reporter.ts`, and `src/runtime/system-reply.ts`.
- Verification: bridge unit/type tests; exact supported dependency graphs;
  fail-closed regressions for nested dynamic calls/constructors, coercion,
  `instanceof`, local `Number` shadowing, const-key lexical shadowing, consumed
  assignment results, source-path lookalikes, and direct `Reflect.get`
  destructuring aliases; exact per-patch path allowlists; deterministic reverse
  and forward offline replay; strict manifest; and repository gates.
- Evidence boundary: this is a conservative source regression gate. It does not
  claim arbitrary interprocedural JavaScript data-flow analysis or replace
  runtime sandbox and network-denial evidence.

## `0006-task-scoped-unix-socket-permission.patch`

- Purpose: replace the incompatible legacy `workspace-write` network-deny
  invocation with the Codex 0.142 permission-profile path needed for one
  verified task gateway Unix socket.
- Runtime or business logic: new and resume invocations enable
  `network_proxy`, select a fixed `assistant-task` profile extending
  `:workspace`, enable limited network mediation, keep local binding, upstream
  proxying, SOCKS, non-loopback proxy exposure, and broad Unix-socket access
  disabled, and allow only the exact `<verified workspace>/gateway.sock` path.
  The dynamic TOML key is JSON/TOML basic-string encoded from the already
  canonical workspace result, not from caller-supplied argv or policy fields.
  The trusted Codex-home verifier must also attest that no loaded legacy
  `sandbox_mode` / `sandbox_workspace_write` setting can override permission
  profiles; absent or false compatibility evidence rejects before spawn.
  The invocation, environment, stdio, and shell boundary remain frozen and
  exact. Codex feature evidence now requires permission-profile and scoped
  Unix-socket proxy support instead of the incompatible legacy network-deny
  claim.
- Applies after `0001-workspace-adapter.patch` through
  `0005-static-dynamic-access-boundary.patch` to upstream commit
  `e8b0dc0cdfe2fb378bef7081618138a20d934aa9`.
- Exact paths: `PATCHES.md`, `src/agent/codex-runner.ts`, and
  `test/codex-runner.test.ts`.
- Verification: exact frozen new/resume argv, updated feature evidence,
  caller-policy override rejection, quote/backslash/newline TOML-injection
  regression, false/missing permission-profile compatibility evidence, exact
  task socket allowlisting with jobs-root/control/HTTP/TCP denial settings,
  bridge unit/type tests, root Codex tool-network security test, and direct
  Codex 0.142 strict-config parsing of both ordinary and adversarially encoded
  final argv.
- Repository synchronization: patch hash, final tree, strict manifest,
  provenance tests, and offline replay are maintained by the repository owner
  and completed for this local Task 5 working tree.
- Evidence boundary: direct binary/config parsing and a local clean-home
  sandbox fixture do not produce the production
  `permissionProfileCompatible` evidence. Stage B Task 9 must bind the locked
  binary/profile to every effective config layer and live wiring; Stage D must
  repeat the matrix on the customer Mac mini before production startup.

Every future upstream modification must use a separately named patch file and
record its reason and verification here.
