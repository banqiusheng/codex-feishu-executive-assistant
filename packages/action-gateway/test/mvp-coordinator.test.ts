import type {
  ActionRecord,
  ApprovedAction,
  ClaimedAction,
  DispatchingAction,
  JobStore,
} from "@executive-assistant/job-store";
import { describe, expect, it, vi } from "vitest";

import type {
  MvpCoordinatorStore,
  MvpDispatchAction,
  MvpLarkCliRunner,
  MvpMutationProvider,
} from "../src/mvp/index.js";
import {
  createLarkCliMutationProvider,
  createMvpConfirmationCoordinator,
} from "../src/mvp/index.js";

const ACTION_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a22";
const TASK_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a21";
const HASH = `sha256:${"a".repeat(64)}`;
const NOW = new Date("2026-07-23T08:00:00.000Z");
const LEASE_EXPIRY = "2026-07-23T08:01:00.000Z";
type FinishedAction = NonNullable<ReturnType<JobStore["finishAction"]>>;

function messageAction(
  state: ActionRecord["state"],
  overrides: Partial<ActionRecord> = {},
): ActionRecord {
  return {
    actionId: ACTION_ID,
    version: 1,
    taskId: TASK_ID,
    controlEventId: null,
    capability: "message.send",
    identity: "bot",
    approvalMode: "president",
    state,
    payload: {
      receiveIdType: "open_id",
      recipientOpenId: "ou_recipient",
      text: "请参加下午三点的经营会。",
    },
    payloadHash: HASH,
    preview: {},
    expiresAt: "2026-07-23T08:30:00.000Z",
    idempotencyKey: ACTION_ID,
    leaseOwner:
      state === "CLAIMED" || state === "DISPATCHING" ? "bridge-a" : null,
    leaseExpiresAt:
      state === "CLAIMED" || state === "DISPATCHING" ? LEASE_EXPIRY : null,
    remoteId: null,
    result: null,
    reconcileOutcome: null,
    createdAt: "2026-07-23T08:00:00.000Z",
    updatedAt: "2026-07-23T08:00:00.000Z",
    ...overrides,
  };
}

function calendarDispatchAction(): MvpDispatchAction {
  return {
    actionId: ACTION_ID,
    version: 1,
    capability: "calendar.create",
    identity: "user",
    payload: {
      calendar: "primary",
      title: "经营会",
      description: null,
      start: "2026-07-24T10:00:00+08:00",
      end: "2026-07-24T11:00:00+08:00",
      zone: "Asia/Shanghai",
      attendeeOpenIds: [],
      recurrence: "none",
    },
    payloadHash: HASH,
    idempotencyKey: ACTION_ID,
  };
}

function callback(decision: "approve" | "reject" = "approve") {
  return {
    version: 1,
    actionId: ACTION_ID,
    actionPayloadHash: HASH,
    nonce: "signed-card-nonce",
    decision,
    actorOpenId: "ou_president",
    chatId: "oc_president_dm",
  };
}

function coordinatorFixture(
  providerResult: Awaited<ReturnType<MvpMutationProvider["dispatch"]>> = {
    state: "SUCCEEDED",
    remoteId: "om_remote",
  },
  clock: () => Date = () => NOW,
) {
  const approved = messageAction("APPROVED") as ApprovedAction;
  const claimed = messageAction("CLAIMED") as ClaimedAction;
  const dispatching = messageAction("DISPATCHING") as DispatchingAction;
  const approveAction = vi.fn<MvpCoordinatorStore["approveAction"]>(
    () => approved,
  );
  const claimApprovedAction = vi.fn<MvpCoordinatorStore["claimApprovedAction"]>(
    () => claimed,
  );
  const markDispatching = vi.fn<MvpCoordinatorStore["markDispatching"]>(
    () => dispatching,
  );
  const finishAction = vi.fn<MvpCoordinatorStore["finishAction"]>((input) => {
    const state =
      input.outcome === "SUCCEEDED"
        ? "SUCCEEDED"
        : input.outcome === "FAILED_DEFINITE"
          ? "FAILED"
          : "UNKNOWN";
    return messageAction(state, {
      result: {
        outcome: input.outcome,
        ...(input.remoteId === undefined ? {} : { remoteId: input.remoteId }),
      },
      remoteId: input.remoteId ?? null,
    }) as FinishedAction;
  });
  const dispatch = vi.fn<MvpMutationProvider["dispatch"]>(
    async () => providerResult,
  );
  const store: MvpCoordinatorStore = {
    approveAction,
    claimApprovedAction,
    markDispatching,
    finishAction,
  };
  const provider: MvpMutationProvider = { dispatch };
  const coordinator = createMvpConfirmationCoordinator({
    store,
    provider,
    owner: "bridge-a",
    now: clock,
    leaseTtlMs: 60_000,
  });
  return {
    coordinator,
    approveAction,
    claimApprovedAction,
    markDispatching,
    finishAction,
    dispatch,
  };
}

describe("MVP confirmation coordinator", () => {
  it("dispatches exactly once after a bound approval and persists success", async () => {
    const fixture = coordinatorFixture();

    await expect(
      fixture.coordinator.approveAndDispatch(callback()),
    ).resolves.toEqual({
      state: "SUCCEEDED",
      actionId: ACTION_ID,
      remoteId: "om_remote",
    });
    expect(fixture.approveAction).toHaveBeenCalledWith({
      ...callback(),
      now: NOW,
    });
    expect(fixture.claimApprovedAction).toHaveBeenCalledOnce();
    expect(fixture.markDispatching).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: ACTION_ID,
        owner: "bridge-a",
        leaseExpiresAt: LEASE_EXPIRY,
        requestDigest: HASH,
        attemptId: expect.any(String),
      }),
    );
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    expect(fixture.dispatch).toHaveBeenCalledWith({
      actionId: ACTION_ID,
      version: 1,
      capability: "message.send",
      identity: "bot",
      payload: {
        receiveIdType: "open_id",
        recipientOpenId: "ou_recipient",
        text: "请参加下午三点的经营会。",
      },
      payloadHash: HASH,
      idempotencyKey: ACTION_ID,
    });
    expect(fixture.finishAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: ACTION_ID,
        outcome: "SUCCEEDED",
        remoteId: "om_remote",
      }),
    );
  });

  it("does not claim or dispatch a rejected confirmation", async () => {
    const fixture = coordinatorFixture();
    fixture.approveAction.mockReturnValue(
      messageAction("FAILED") as ApprovedAction,
    );

    await expect(
      fixture.coordinator.approveAndDispatch(callback("reject")),
    ).resolves.toEqual({ state: "REJECTED" });
    expect(fixture.claimApprovedAction).not.toHaveBeenCalled();
    expect(fixture.markDispatching).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(fixture.finishAction).not.toHaveBeenCalled();
  });

  it("persists UNKNOWN once and relies on the ledger to reject replay", async () => {
    const fixture = coordinatorFixture({ state: "UNKNOWN" });

    await expect(
      fixture.coordinator.approveAndDispatch(callback()),
    ).resolves.toEqual({ state: "UNKNOWN", actionId: ACTION_ID });
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    expect(fixture.finishAction).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "UNKNOWN" }),
    );

    fixture.approveAction.mockImplementationOnce(() => {
      throw new Error("expired_or_changed");
    });
    await expect(
      fixture.coordinator.approveAndDispatch(callback()),
    ).rejects.toThrow("expired_or_changed");
    expect(fixture.dispatch).toHaveBeenCalledOnce();
  });

  it("uses a fresh clock for every transition and returns UNKNOWN after a lost finish lease", async () => {
    const times = [
      new Date("2026-07-23T08:00:00.000Z"),
      new Date("2026-07-23T08:00:00.001Z"),
      new Date("2026-07-23T08:00:00.002Z"),
      new Date("2026-07-23T08:02:00.000Z"),
    ];
    let last = times[0]!;
    const clock = vi.fn(() => {
      last = times.shift() ?? last;
      return last;
    });
    const fixture = coordinatorFixture(
      { state: "SUCCEEDED", remoteId: "om_remote" },
      clock,
    );
    fixture.finishAction.mockReturnValueOnce(null);

    await expect(
      fixture.coordinator.approveAndDispatch(callback()),
    ).resolves.toEqual({
      state: "UNKNOWN",
      actionId: ACTION_ID,
    });
    expect(clock).toHaveBeenCalledTimes(4);
    expect(fixture.finishAction).toHaveBeenCalledWith(
      expect.objectContaining({
        now: new Date("2026-07-23T08:02:00.000Z"),
      }),
    );
  });

  it.each([
    { ...callback(), identity: "user" },
    { ...callback(), url: "https://open.feishu.cn/anything" },
    { ...callback(), actionPayloadHash: `sha256:${"B".repeat(64)}` },
  ])(
    "rejects unbound confirmation fields before store access",
    async (input) => {
      const fixture = coordinatorFixture();

      await expect(
        fixture.coordinator.approveAndDispatch(input),
      ).rejects.toThrow("invalid mvp confirmation");
      expect(fixture.approveAction).not.toHaveBeenCalled();
      expect(fixture.dispatch).not.toHaveBeenCalled();
    },
  );
});

describe("MVP lark-cli mutation provider", () => {
  it("fixes message to Bot and calendar to User without passing identity fields", async () => {
    const runBot = vi.fn<MvpLarkCliRunner["runBot"]>(async () => ({
      state: "SUCCEEDED",
      value: { ok: true },
    }));
    const runUser = vi.fn<MvpLarkCliRunner["runUser"]>(async () => ({
      state: "SUCCEEDED",
      value: { ok: true },
    }));
    const provider = createLarkCliMutationProvider({ runBot, runUser });
    const message = {
      actionId: ACTION_ID,
      version: 1 as const,
      capability: "message.send" as const,
      identity: "bot" as const,
      payload: messageAction("DISPATCHING").payload as Readonly<
        Record<string, string>
      >,
      payloadHash: HASH,
      idempotencyKey: ACTION_ID,
    };

    await expect(provider.dispatch(message)).resolves.toEqual({
      state: "SUCCEEDED",
    });
    await expect(provider.dispatch(calendarDispatchAction())).resolves.toEqual({
      state: "SUCCEEDED",
    });

    expect(runBot).toHaveBeenCalledWith({
      version: 1,
      operation: "message.send",
      payload: {
        ...message.payload,
        idempotencyKey: ACTION_ID,
      },
    });
    expect(runUser).toHaveBeenCalledWith({
      version: 1,
      operation: "calendar.create",
      payload: calendarDispatchAction().payload,
    });
    expect(JSON.stringify(runBot.mock.calls)).not.toContain('"identity"');
    expect(JSON.stringify(runUser.mock.calls)).not.toContain('"identity"');
    expect(JSON.stringify(runBot.mock.calls)).not.toContain("http");
    expect(JSON.stringify(runUser.mock.calls)).not.toContain("http");
  });

  it("maps runner UNKNOWN without a second lark-cli call", async () => {
    const runBot = vi.fn<MvpLarkCliRunner["runBot"]>(async () => ({
      state: "UNKNOWN",
      code: "TIMEOUT",
    }));
    const runUser = vi.fn<MvpLarkCliRunner["runUser"]>(async () => ({
      state: "FAILED",
      code: "SPAWN_FAILED",
    }));
    const provider = createLarkCliMutationProvider({ runBot, runUser });
    const action: MvpDispatchAction = {
      actionId: ACTION_ID,
      version: 1,
      capability: "message.send",
      identity: "bot",
      payload: {
        receiveIdType: "open_id",
        recipientOpenId: "ou_recipient",
        text: "开会",
      },
      payloadHash: HASH,
      idempotencyKey: ACTION_ID,
    };

    await expect(provider.dispatch(action)).resolves.toEqual({
      state: "UNKNOWN",
    });
    expect(runBot).toHaveBeenCalledOnce();
    expect(runUser).not.toHaveBeenCalled();
  });

  it("rejects an overlong non-UUID idempotency key before lark-cli", async () => {
    const runBot = vi.fn<MvpLarkCliRunner["runBot"]>(async () => ({
      state: "SUCCEEDED",
      value: { ok: true },
    }));
    const runUser = vi.fn<MvpLarkCliRunner["runUser"]>(async () => ({
      state: "SUCCEEDED",
      value: { ok: true },
    }));
    const provider = createLarkCliMutationProvider({ runBot, runUser });
    const action: MvpDispatchAction = {
      actionId: ACTION_ID,
      version: 1,
      capability: "message.send",
      identity: "bot",
      payload: messageAction("DISPATCHING").payload as Readonly<
        Record<string, string>
      >,
      payloadHash: HASH,
      idempotencyKey: `sha256:${"a".repeat(64)}`,
    };

    await expect(provider.dispatch(action)).rejects.toThrow(
      "invalid mvp confirmation",
    );
    expect(runBot).not.toHaveBeenCalled();
    expect(runUser).not.toHaveBeenCalled();
  });
});
