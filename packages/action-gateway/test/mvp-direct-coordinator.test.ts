import type {
  ActionRecord,
  ClaimedAction,
  DispatchingAction,
  JobStore,
} from "@executive-assistant/job-store";
import { describe, expect, it, vi } from "vitest";

import type {
  MvpDispatchAction,
  MvpMutationProvider,
} from "../src/mvp/coordinator.js";

const ACTION_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a22";
const OTHER_ACTION_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a23";
const TASK_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a21";
const HASH = `sha256:${"a".repeat(64)}`;
const NOW = new Date("2026-07-30T02:00:00.000Z");
const LEASE_EXPIRY = "2026-07-30T02:01:00.000Z";

type DirectStore = Pick<
  JobStore,
  | "authorizePresidentInstructionAction"
  | "claimApprovedAction"
  | "markDispatching"
  | "finishAction"
>;
type FinishedAction = NonNullable<ReturnType<JobStore["finishAction"]>>;

const input = Object.freeze({
  taskId: TASK_ID,
  capability: "calendar.create.direct",
  identity: "user" as const,
  itemKey: "calendar:经营会:2026-07-31T10:00:00+08:00",
  payload: Object.freeze({
    calendar: "primary",
    title: "经营会",
    description: null,
    start: "2026-07-31T10:00:00+08:00",
    end: "2026-07-31T11:00:00+08:00",
    zone: "Asia/Shanghai",
    attendeeOpenIds: Object.freeze([]),
    recurrence: "none",
  }),
  preview: Object.freeze({
    action: "calendar.create.direct",
    title: "经营会",
    start: "2026-07-31T10:00:00+08:00",
    end: "2026-07-31T11:00:00+08:00",
  }),
});

function directAction(
  state: ActionRecord["state"],
  overrides: Partial<ActionRecord> = {},
): ActionRecord {
  const leased = state === "CLAIMED" || state === "DISPATCHING";
  return Object.freeze({
    actionId: ACTION_ID,
    version: 1,
    taskId: TASK_ID,
    controlEventId: null,
    capability: input.capability,
    identity: input.identity,
    approvalMode: "president_instruction",
    state,
    payload: input.payload,
    payloadHash: HASH,
    preview: input.preview,
    expiresAt: "2026-07-30T02:30:00.000Z",
    idempotencyKey: ACTION_ID,
    leaseOwner: leased ? "bridge-a" : null,
    leaseExpiresAt: leased ? LEASE_EXPIRY : null,
    remoteId: null,
    result: null,
    reconcileOutcome: null,
    createdAt: "2026-07-30T02:00:00.000Z",
    updatedAt: "2026-07-30T02:00:00.000Z",
    ...overrides,
  });
}

function finishedAction(
  state: "SUCCEEDED" | "FAILED" | "UNKNOWN",
  remoteId?: string,
): FinishedAction {
  const outcome =
    state === "FAILED"
      ? ("FAILED_DEFINITE" as const)
      : (state as "SUCCEEDED" | "UNKNOWN");
  return directAction(state, {
    remoteId: remoteId ?? null,
    result: Object.freeze({
      outcome,
      ...(remoteId === undefined ? {} : { remoteId }),
    }),
  }) as FinishedAction;
}

async function loadDirectCoordinator() {
  return import("../src/mvp/direct-coordinator.js");
}

function fixture(
  providerResult: Awaited<ReturnType<MvpMutationProvider["dispatch"]>> = {
    state: "SUCCEEDED",
    remoteId: "evt_remote",
  },
) {
  const order: string[] = [];
  const approved = directAction("APPROVED");
  const claimed = directAction("CLAIMED") as ClaimedAction;
  const dispatching = directAction("DISPATCHING") as DispatchingAction;
  const authorizePresidentInstructionAction = vi.fn<
    DirectStore["authorizePresidentInstructionAction"]
  >(() => {
    order.push("authorize");
    return {
      action: approved as ActionRecord & {
        approvalMode: "president_instruction";
      },
      created: true,
    };
  });
  const claimApprovedAction = vi.fn<DirectStore["claimApprovedAction"]>(() => {
    order.push("claim");
    return claimed;
  });
  const markDispatching = vi.fn<DirectStore["markDispatching"]>(() => {
    order.push("mark");
    return dispatching;
  });
  const finishAction = vi.fn<DirectStore["finishAction"]>((value) => {
    order.push("finish");
    const state =
      value.outcome === "FAILED_DEFINITE" ? "FAILED" : value.outcome;
    return finishedAction(state, value.remoteId);
  });
  const dispatch = vi.fn<MvpMutationProvider["dispatch"]>(async () => {
    order.push("dispatch");
    return providerResult;
  });
  const prepareAction = vi.fn();
  const approveAction = vi.fn();
  const store = {
    authorizePresidentInstructionAction,
    claimApprovedAction,
    markDispatching,
    finishAction,
    prepareAction,
    approveAction,
  };
  const provider: MvpMutationProvider = { dispatch };
  return {
    order,
    store,
    provider,
    authorizePresidentInstructionAction,
    claimApprovedAction,
    markDispatching,
    finishAction,
    dispatch,
    prepareAction,
    approveAction,
  };
}

async function coordinator(
  current: ReturnType<typeof fixture>,
  now: () => Date = () => NOW,
) {
  const module = await loadDirectCoordinator();
  return module.createMvpDirectExecutionCoordinator({
    store: current.store,
    provider: current.provider,
    owner: "bridge-a",
    now,
    leaseTtlMs: 60_000,
  });
}

describe("MVP president-instruction direct coordinator", () => {
  it("authorizes the exact trusted instruction before one dispatch without prepare or approval", async () => {
    const current = fixture();
    const executor = await coordinator(current);

    await expect(executor.executePresidentInstruction(input)).resolves.toEqual({
      state: "SUCCEEDED",
      actionId: ACTION_ID,
      remoteId: "evt_remote",
    });

    expect(current.order).toEqual([
      "authorize",
      "claim",
      "mark",
      "dispatch",
      "finish",
    ]);
    expect(current.authorizePresidentInstructionAction).toHaveBeenCalledWith({
      ...input,
      now: NOW,
    });
    expect(current.dispatch).toHaveBeenCalledWith({
      actionId: ACTION_ID,
      version: 1,
      capability: "calendar.create.direct",
      identity: "user",
      payload: input.payload,
      payloadHash: HASH,
      idempotencyKey: ACTION_ID,
    } satisfies MvpDispatchAction);
    expect(current.prepareAction).not.toHaveBeenCalled();
    expect(current.approveAction).not.toHaveBeenCalled();
  });

  it.each([
    ["actor", { ...input, actorOpenId: "ou_president" }],
    ["chat", { ...input, chatId: "oc_president_dm" }],
    ["skip flag", { ...input, skipConfirmation: true }],
    ["auto-approve flag", { ...input, autoApprove: true }],
  ])(
    "rejects caller-supplied %s before authorization",
    async (_name, value) => {
      const current = fixture();
      const executor = await coordinator(current);

      await expect(executor.executePresidentInstruction(value)).rejects.toThrow(
        "invalid mvp direct execution",
      );
      expect(
        current.authorizePresidentInstructionAction,
      ).not.toHaveBeenCalled();
      expect(current.dispatch).not.toHaveBeenCalled();
    },
  );

  it("returns the terminal replay and never dispatches the same action twice", async () => {
    const current = fixture();
    current.authorizePresidentInstructionAction
      .mockReturnValueOnce({
        action: directAction("APPROVED") as ActionRecord & {
          approvalMode: "president_instruction";
        },
        created: true,
      })
      .mockReturnValueOnce({
        action: finishedAction("SUCCEEDED", "evt_remote") as ActionRecord & {
          approvalMode: "president_instruction";
        },
        created: false,
      });
    const executor = await coordinator(current);

    await expect(
      executor.executePresidentInstruction(input),
    ).resolves.toMatchObject({ state: "SUCCEEDED" });
    await expect(executor.executePresidentInstruction(input)).resolves.toEqual({
      state: "SUCCEEDED",
      actionId: ACTION_ID,
      remoteId: "evt_remote",
    });
    expect(current.dispatch).toHaveBeenCalledOnce();
    expect(current.claimApprovedAction).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "SUCCEEDED",
      finishedAction("SUCCEEDED", "evt_existing"),
      {
        state: "SUCCEEDED",
        actionId: ACTION_ID,
        remoteId: "evt_existing",
      },
    ],
    [
      "FAILED",
      finishedAction("FAILED"),
      { state: "FAILED", actionId: ACTION_ID },
    ],
    [
      "UNKNOWN",
      finishedAction("UNKNOWN"),
      { state: "UNKNOWN", actionId: ACTION_ID },
    ],
  ] as const)(
    "returns an existing %s result without claiming or dispatching",
    async (_name, action, expected) => {
      const current = fixture();
      current.authorizePresidentInstructionAction.mockReturnValue({
        action: action as ActionRecord & {
          approvalMode: "president_instruction";
        },
        created: false,
      });
      const executor = await coordinator(current);

      await expect(
        executor.executePresidentInstruction(input),
      ).resolves.toEqual(expected);
      expect(current.claimApprovedAction).not.toHaveBeenCalled();
      expect(current.dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "SUCCEEDED",
      "evt_reconciled",
      {
        state: "SUCCEEDED",
        actionId: ACTION_ID,
        remoteId: "evt_reconciled",
      },
    ],
    ["FAILED", null, { state: "FAILED", actionId: ACTION_ID }],
    ["INDETERMINATE", null, { state: "UNKNOWN", actionId: ACTION_ID }],
  ] as const)(
    "maps a RECONCILED/%s replay to a terminal result without dispatch",
    async (reconcileOutcome, remoteId, expected) => {
      const current = fixture();
      current.authorizePresidentInstructionAction.mockReturnValue({
        action: directAction("RECONCILED", {
          reconcileOutcome,
          remoteId,
          result: { outcome: "UNKNOWN" },
        }) as ActionRecord & {
          approvalMode: "president_instruction";
        },
        created: false,
      });
      const executor = await coordinator(current);

      await expect(
        executor.executePresidentInstruction(input),
      ).resolves.toEqual(expected);
      expect(current.claimApprovedAction).not.toHaveBeenCalled();
      expect(current.dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["CLAIMED", "ACTION_ALREADY_CLAIMED"],
    ["DISPATCHING", "ACTION_ALREADY_DISPATCHING"],
  ] as const)(
    "does not redispatch an existing %s action",
    async (state, reason) => {
      const current = fixture();
      current.authorizePresidentInstructionAction.mockReturnValue({
        action: directAction(state) as ActionRecord & {
          approvalMode: "president_instruction";
        },
        created: false,
      });
      const executor = await coordinator(current);

      await expect(
        executor.executePresidentInstruction(input),
      ).resolves.toEqual({
        state: "NOT_DISPATCHED",
        actionId: ACTION_ID,
        reason,
        retryable: false,
      });
      expect(current.claimApprovedAction).not.toHaveBeenCalled();
      expect(current.markDispatching).not.toHaveBeenCalled();
      expect(current.dispatch).not.toHaveBeenCalled();
    },
  );

  it("returns an explicit non-retryable result when the approved action cannot be claimed", async () => {
    const current = fixture();
    current.claimApprovedAction.mockReturnValue(null);
    const executor = await coordinator(current);

    await expect(executor.executePresidentInstruction(input)).resolves.toEqual({
      state: "NOT_DISPATCHED",
      actionId: ACTION_ID,
      reason: "CLAIM_UNAVAILABLE",
      retryable: false,
    });
    expect(current.markDispatching).not.toHaveBeenCalled();
    expect(current.dispatch).not.toHaveBeenCalled();
  });

  it("returns an explicit non-retryable result when dispatch cannot be marked started", async () => {
    const current = fixture();
    current.markDispatching.mockReturnValue(null);
    const executor = await coordinator(current);

    await expect(executor.executePresidentInstruction(input)).resolves.toEqual({
      state: "NOT_DISPATCHED",
      actionId: ACTION_ID,
      reason: "DISPATCH_START_UNAVAILABLE",
      retryable: false,
    });
    expect(current.dispatch).not.toHaveBeenCalled();
    expect(current.finishAction).not.toHaveBeenCalled();
  });

  it.each(["claim", "mark"] as const)(
    "rejects a different action id returned by %s before provider dispatch",
    async (transition) => {
      const current = fixture();
      if (transition === "claim") {
        current.claimApprovedAction.mockReturnValue(
          directAction("CLAIMED", {
            actionId: OTHER_ACTION_ID,
            idempotencyKey: OTHER_ACTION_ID,
          }) as ClaimedAction,
        );
      } else {
        current.markDispatching.mockReturnValue(
          directAction("DISPATCHING", {
            actionId: OTHER_ACTION_ID,
            idempotencyKey: OTHER_ACTION_ID,
          }) as DispatchingAction,
        );
      }
      const executor = await coordinator(current);

      await expect(
        executor.executePresidentInstruction(input),
      ).rejects.toThrow();
      expect(current.dispatch).not.toHaveBeenCalled();
      expect(current.finishAction).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["provider throw", "throw"],
    ["provider timeout result", "unknown"],
  ] as const)("persists %s as UNKNOWN without retry", async (_name, mode) => {
    const current = fixture();
    if (mode === "throw") {
      current.dispatch.mockRejectedValueOnce(new Error("provider failed"));
    } else {
      current.dispatch.mockResolvedValueOnce({ state: "UNKNOWN" });
    }
    const executor = await coordinator(current);

    await expect(executor.executePresidentInstruction(input)).resolves.toEqual({
      state: "UNKNOWN",
      actionId: ACTION_ID,
    });
    expect(current.dispatch).toHaveBeenCalledOnce();
    expect(current.finishAction).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "UNKNOWN" }),
    );
  });

  it("returns UNKNOWN when finish persistence throws after provider dispatch", async () => {
    const current = fixture();
    current.finishAction.mockImplementationOnce(() => {
      throw new Error("persistence failed");
    });
    const executor = await coordinator(current);

    await expect(executor.executePresidentInstruction(input)).resolves.toEqual({
      state: "UNKNOWN",
      actionId: ACTION_ID,
    });
    expect(current.dispatch).toHaveBeenCalledOnce();
    expect(current.finishAction).toHaveBeenCalledOnce();
  });

  it("returns UNKNOWN when finish loses the lease and a replay cannot dispatch again", async () => {
    const current = fixture();
    current.finishAction.mockReturnValueOnce(null);
    current.authorizePresidentInstructionAction
      .mockReturnValueOnce({
        action: directAction("APPROVED") as ActionRecord & {
          approvalMode: "president_instruction";
        },
        created: true,
      })
      .mockReturnValueOnce({
        action: directAction("DISPATCHING") as ActionRecord & {
          approvalMode: "president_instruction";
        },
        created: false,
      });
    const executor = await coordinator(current);

    await expect(executor.executePresidentInstruction(input)).resolves.toEqual({
      state: "UNKNOWN",
      actionId: ACTION_ID,
    });
    await expect(executor.executePresidentInstruction(input)).resolves.toEqual({
      state: "NOT_DISPATCHED",
      actionId: ACTION_ID,
      reason: "ACTION_ALREADY_DISPATCHING",
      retryable: false,
    });
    expect(current.dispatch).toHaveBeenCalledOnce();
  });

  it.each([
    [
      { state: "SUCCEEDED", remoteId: "evt_created" } as const,
      {
        state: "SUCCEEDED",
        actionId: ACTION_ID,
        remoteId: "evt_created",
      },
    ],
    [{ state: "FAILED" } as const, { state: "FAILED", actionId: ACTION_ID }],
    [{ state: "UNKNOWN" } as const, { state: "UNKNOWN", actionId: ACTION_ID }],
  ])("wraps provider result $state", async (providerResult, expected) => {
    const current = fixture(providerResult);
    const executor = await coordinator(current);

    await expect(executor.executePresidentInstruction(input)).resolves.toEqual(
      expected,
    );
    expect(current.dispatch).toHaveBeenCalledOnce();
  });
});
