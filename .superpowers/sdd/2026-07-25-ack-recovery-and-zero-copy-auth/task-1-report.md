# Task 1 implementation report

Status: DONE_WITH_CONCERNS

## Red test evidence

`corepack pnpm exec vitest run packages/job-store/test/acknowledgements.test.ts packages/job-store/test/events.test.ts packages/job-store/test/tasks.test.ts`

Initial result: expected failure. `task_acknowledgements` did not exist and the store did not expose ACK APIs (`getTaskAcknowledgement` / acknowledgement lifecycle methods were not functions).

## Green verification

- Targeted Vitest: 3 files, 59 tests passed.
- `corepack pnpm --filter @executive-assistant/job-store typecheck`: passed.
- `corepack pnpm --filter @executive-assistant/job-store build`: passed.
- `git diff --check`: passed.

## Changed files

- ACK migration, store implementation, public types and wiring.
- Atomic root/replacement ACK-row creation; strict database claim gate and ACK-aware startup handling.
- Focused ACK, event, and task lifecycle tests.
- README and CHANGELOG status wording.

## Safety clarification incorporated

- `beginNextTaskAcknowledgement` selects the global oldest RECEIVED task inside its immediate transaction and does not skip an unavailable earlier task.
- `claimNextTask` checks the global oldest RECEIVED task before its ACK state, so a later ACK cannot bypass FIFO.
- Migration 003 includes the ACK transition trigger and partial unique `SENDING` index; historical rows are not backfilled.

## Self-review and concerns

No message content, routes, hosts, credentials, full IDs, or raw SDK errors are persisted in ACK failure data. Failure evidence is restricted to the fixed enum. Runtime marker v2/task binding, retry execution, doctor, OAuth, and real E2E remain out of scope and pending.
