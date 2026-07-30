import { describe, expect, it, vi } from "vitest";

import {
  parseDirectCalendarCliResult,
  planDirectCalendarInstruction,
} from "../src/mvp/direct-calendar.js";

const TASK_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a21";
const ATTENDEE_REF_1 = "018f7d72-7a2b-7f45-8a12-8e20b8426a41";
const ATTENDEE_REF_2 = "018f7d72-7a2b-7f45-8a12-8e20b8426a42";
const NOW = new Date("2026-07-30T00:00:00.000Z");
const LOCKED_LARK_CLI_1_0_72_CALENDAR_CREATE_STDOUT =
  '{"ok":true,"identity":"user","data":{"event_id":"event_8cf4zT-1","summary":"经营会","start":"2026-07-31T10:00:00+08:00","end":"2026-07-31T12:30:00+08:00"}}\n';

function payload(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {
    title: "经营会",
    description: "讨论下季度计划",
    startLocal: "2026-07-31T10:00:00",
    attendeeRefs: [],
    ...overrides,
  };
  for (const [key, value] of Object.entries(result)) {
    if (value === undefined) delete result[key];
  }
  return result;
}

function resolver(
  values: Readonly<Record<string, string>> = {},
): (taskId: string, attendeeRef: string) => string {
  return vi.fn((taskId: string, attendeeRef: string) => {
    expect(taskId).toBe(TASK_ID);
    const value = values[attendeeRef];
    if (value === undefined) throw new Error("not found");
    return value;
  });
}

describe("direct calendar planning", () => {
  it("builds a frozen direct instruction for the president primary calendar and defaults to one hour", () => {
    const plan = planDirectCalendarInstruction(
      TASK_ID,
      payload(),
      NOW,
      resolver(),
    );

    expect(plan).toEqual({
      taskId: TASK_ID,
      capability: "calendar.create.direct",
      identity: "user",
      itemKey: expect.stringMatching(/^calendar:sha256:[0-9a-f]{64}$/),
      payload: {
        calendar: "primary",
        title: "经营会",
        description: "讨论下季度计划",
        start: "2026-07-31T10:00:00+08:00",
        end: "2026-07-31T11:00:00+08:00",
        zone: "Asia/Shanghai",
        attendeeOpenIds: [],
        recurrence: "none",
      },
      preview: {
        action: "calendar.create.direct",
        title: "经营会",
        description: "讨论下季度计划",
        start: "2026-07-31T10:00:00+08:00",
        end: "2026-07-31T11:00:00+08:00",
        zone: "Asia/Shanghai",
        attendeeCount: 0,
        impact: "将在总裁主日历创建一个单次日程",
      },
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan?.payload)).toBe(true);
    expect(Object.isFrozen(plan?.preview)).toBe(true);
    expect(JSON.stringify(plan?.preview)).not.toContain("ou_");
    expect(JSON.stringify(plan?.preview)).not.toContain("video");
    expect(JSON.stringify(plan?.preview)).not.toContain("reminder");
    expect(JSON.stringify(plan?.preview)).not.toContain("busy");
    expect(JSON.stringify(plan?.preview)).not.toContain("editor");
  });

  it("uses exact local wall-clock values, rolls the default end across midnight, and injects only resolver open IDs", () => {
    const dereference = resolver({
      [ATTENDEE_REF_1]: "ou_first",
      [ATTENDEE_REF_2]: "ou_second",
    });
    const plan = planDirectCalendarInstruction(
      TASK_ID,
      payload({
        description: undefined,
        startLocal: "2026-12-31T23:30:00",
        attendeeRefs: [ATTENDEE_REF_1, ATTENDEE_REF_2],
      }),
      NOW,
      dereference,
    );

    expect(plan?.payload).toEqual({
      calendar: "primary",
      title: "经营会",
      description: null,
      start: "2026-12-31T23:30:00+08:00",
      end: "2027-01-01T00:30:00+08:00",
      zone: "Asia/Shanghai",
      attendeeOpenIds: ["ou_first", "ou_second"],
      recurrence: "none",
    });
    expect(plan?.preview).toMatchObject({ attendeeCount: 2 });
    expect(dereference).toHaveBeenCalledTimes(2);
  });

  it("honors a valid explicit end and changes the stable key when the semantic request changes", () => {
    const first = planDirectCalendarInstruction(
      TASK_ID,
      payload({ endLocal: "2026-07-31T12:30:00" }),
      NOW,
      resolver(),
    );
    const replay = planDirectCalendarInstruction(
      TASK_ID,
      payload({ endLocal: "2026-07-31T12:30:00" }),
      NOW,
      resolver(),
    );
    const changed = planDirectCalendarInstruction(
      TASK_ID,
      payload({ endLocal: "2026-07-31T12:30:01" }),
      NOW,
      resolver(),
    );

    expect(first?.payload.end).toBe("2026-07-31T12:30:00+08:00");
    expect(first?.itemKey).toBe(replay?.itemKey);
    expect(first?.itemKey).not.toBe(changed?.itemKey);
  });

  it("deduplicates by resolved attendee semantics instead of transient refs or attendee order", () => {
    const first = planDirectCalendarInstruction(
      TASK_ID,
      payload({ attendeeRefs: [ATTENDEE_REF_1, ATTENDEE_REF_2] }),
      NOW,
      resolver({
        [ATTENDEE_REF_1]: "ou_first",
        [ATTENDEE_REF_2]: "ou_second",
      }),
    );
    const replacementRef = "018f7d72-7a2b-7f45-8a12-8e20b8426a43";
    const replay = planDirectCalendarInstruction(
      TASK_ID,
      payload({ attendeeRefs: [ATTENDEE_REF_2, replacementRef] }),
      NOW,
      resolver({
        [ATTENDEE_REF_2]: "ou_second",
        [replacementRef]: "ou_first",
      }),
    );

    expect(replay?.itemKey).toBe(first?.itemKey);
    expect(replay?.payload).toEqual(first?.payload);
  });

  it("returns zero plan and never dereferences attendees when the event is completely past", () => {
    const dereference = resolver({ [ATTENDEE_REF_1]: "ou_first" });

    expect(
      planDirectCalendarInstruction(
        TASK_ID,
        payload({
          startLocal: "2026-07-29T20:00:00",
          endLocal: "2026-07-30T08:00:00",
          attendeeRefs: [ATTENDEE_REF_1],
        }),
        NOW,
        dereference,
      ),
    ).toBeNull();
    expect(dereference).not.toHaveBeenCalled();
  });

  it("allows an event already in progress because it is not completely past", () => {
    const plan = planDirectCalendarInstruction(
      TASK_ID,
      payload({
        startLocal: "2026-07-30T07:59:59",
        endLocal: "2026-07-30T08:00:01",
      }),
      NOW,
      resolver(),
    );

    expect(plan?.payload.end).toBe("2026-07-30T08:00:01+08:00");
  });

  it.each([
    "2026-02-29T10:00:00",
    "2026-02-31T10:00:00",
    "2026-04-31T10:00:00",
    "2026-07-31T24:00:00",
    "2026-07-31T10:60:00",
    "2026-07-31T10:00:60",
    "2026-07-31T10:00",
    "2026-7-31T10:00:00",
    "2026-07-31 10:00:00",
    "2026-07-31T10:00:00+08:00",
    "明天下午",
  ])("rejects invalid or ambiguous local time %s", (startLocal) => {
    expect(() =>
      planDirectCalendarInstruction(
        TASK_ID,
        payload({ startLocal }),
        NOW,
        resolver(),
      ),
    ).toThrowError("invalid direct calendar payload");
  });

  it("accepts a real leap day but rejects start at or after end", () => {
    expect(
      planDirectCalendarInstruction(
        TASK_ID,
        payload({
          startLocal: "2028-02-29T10:00:00",
          endLocal: "2028-02-29T11:00:00",
        }),
        NOW,
        resolver(),
      )?.payload.start,
    ).toBe("2028-02-29T10:00:00+08:00");

    for (const endLocal of ["2026-07-31T10:00:00", "2026-07-31T09:59:59"]) {
      expect(() =>
        planDirectCalendarInstruction(
          TASK_ID,
          payload({ endLocal }),
          NOW,
          resolver(),
        ),
      ).toThrowError("invalid direct calendar payload");
    }
  });

  it.each([
    ["open id", { open_id: "ou_injected" }],
    ["camel open id", { openId: "ou_injected" }],
    ["attendee ids", { attendeeOpenIds: ["ou_injected"] }],
    ["zone", { zone: "UTC" }],
    ["calendar", { calendar: "shared" }],
    ["identity", { identity: "bot" }],
    ["video", { videoConference: true }],
    ["reminder", { reminderMinutes: 5 }],
    ["busy", { freeBusyStatus: "busy" }],
    ["editor", { attendeeCanEdit: true }],
    ["recurrence", { recurrence: "daily" }],
  ])("rejects caller-supplied %s controls", (_name, injected) => {
    expect(() =>
      planDirectCalendarInstruction(
        TASK_ID,
        payload(injected),
        NOW,
        resolver(),
      ),
    ).toThrowError("invalid direct calendar payload");
  });

  it("requires zero to twenty unique opaque UUID attendee refs", () => {
    const refs = Array.from({ length: 20 }, (_, index) => {
      const suffix = (0x41 + index).toString(16).padStart(2, "0");
      return `018f7d72-7a2b-7f45-8a12-8e20b8426a${suffix}`;
    });
    const values = Object.fromEntries(
      refs.map((ref, index) => [ref, `ou_user_${index}`]),
    );
    expect(
      planDirectCalendarInstruction(
        TASK_ID,
        payload({ attendeeRefs: refs }),
        NOW,
        resolver(values),
      )?.preview.attendeeCount,
    ).toBe(20);

    for (const attendeeRefs of [
      [...refs, "018f7d72-7a2b-7f45-8a12-8e20b8426aff"],
      [ATTENDEE_REF_1, ATTENDEE_REF_1],
      ["ou_injected"],
      ["not-a-reference"],
    ]) {
      expect(() =>
        planDirectCalendarInstruction(
          TASK_ID,
          payload({ attendeeRefs }),
          NOW,
          resolver(values),
        ),
      ).toThrowError("invalid direct calendar payload");
    }
  });

  it("fails closed when the resolver cannot produce distinct trusted user open IDs", () => {
    for (const values of [
      { [ATTENDEE_REF_1]: "oc_chat" },
      { [ATTENDEE_REF_1]: "ou_same", [ATTENDEE_REF_2]: "ou_same" },
    ]) {
      expect(() =>
        planDirectCalendarInstruction(
          TASK_ID,
          payload({ attendeeRefs: Object.keys(values) }),
          NOW,
          resolver(values),
        ),
      ).toThrowError("invalid direct calendar attendee");
    }
    expect(() =>
      planDirectCalendarInstruction(
        TASK_ID,
        payload({ attendeeRefs: [ATTENDEE_REF_1] }),
        NOW,
        resolver(),
      ),
    ).toThrowError("direct calendar attendee is unavailable");
  });

  it("rejects extra, accessor, Proxy, Date, sparse-array, task and clock boundary objects", () => {
    const accessor = {};
    Object.defineProperty(accessor, "title", {
      enumerable: true,
      get: () => "经营会",
    });
    const sparse = payload({ attendeeRefs: new Array(1) });
    const proxied = new Proxy(payload(), {});

    for (const value of [accessor, sparse, proxied, new Date()]) {
      expect(() =>
        planDirectCalendarInstruction(TASK_ID, value, NOW, resolver()),
      ).toThrowError("invalid direct calendar payload");
    }
    expect(() =>
      planDirectCalendarInstruction(
        "ou_not_a_task",
        payload(),
        NOW,
        resolver(),
      ),
    ).toThrowError("invalid direct calendar task");

    class ClockSubclass extends Date {}
    const decorated = new Date(NOW);
    Object.defineProperty(decorated, "extra", {
      enumerable: true,
      value: true,
    });
    for (const clock of [
      new Date("invalid"),
      new ClockSubclass(NOW),
      decorated,
      new Proxy(new Date(NOW), {}),
    ]) {
      expect(() =>
        planDirectCalendarInstruction(TASK_ID, payload(), clock, resolver()),
      ).toThrowError("invalid direct calendar clock");
    }
  });
});

describe("direct calendar locked CLI result parser", () => {
  const plan = planDirectCalendarInstruction(
    TASK_ID,
    payload({ endLocal: "2026-07-31T12:30:00" }),
    NOW,
    resolver(),
  );

  it("accepts the locked v1.0.72 raw stdout success envelope and emits the minimal public result", () => {
    const result = parseDirectCalendarCliResult(
      JSON.parse(LOCKED_LARK_CLI_1_0_72_CALENDAR_CREATE_STDOUT),
      plan!,
    );

    expect(result).toEqual({
      eventId: "event_8cf4zT-1",
      title: "经营会",
      start: "2026-07-31T10:00:00+08:00",
      end: "2026-07-31T12:30:00+08:00",
      zone: "Asia/Shanghai",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("ou_");
    expect(Reflect.ownKeys(result)).toEqual([
      "eventId",
      "title",
      "start",
      "end",
      "zone",
    ]);
  });

  it.each([
    [
      "legacy data-only projection",
      {
        data: {
          event_id: "event_1",
          summary: "经营会",
          start: "2026-07-31T10:00:00+08:00",
          end: "2026-07-31T12:30:00+08:00",
        },
      },
    ],
    [
      "extra root",
      {
        ok: true,
        identity: "user",
        data: {
          event_id: "event_1",
          summary: "经营会",
          start: "2026-07-31T10:00:00+08:00",
          end: "2026-07-31T12:30:00+08:00",
        },
        request_id: "leak",
      },
    ],
    [
      "unproven notice root",
      {
        ok: true,
        identity: "user",
        data: {
          event_id: "event_1",
          summary: "经营会",
          start: "2026-07-31T10:00:00+08:00",
          end: "2026-07-31T12:30:00+08:00",
        },
        _notice: "not in the locked fixture",
      },
    ],
    [
      "false success marker",
      {
        ok: false,
        identity: "user",
        data: {
          event_id: "event_1",
          summary: "经营会",
          start: "2026-07-31T10:00:00+08:00",
          end: "2026-07-31T12:30:00+08:00",
        },
      },
    ],
    [
      "wrong identity",
      {
        ok: true,
        identity: "bot",
        data: {
          event_id: "event_1",
          summary: "经营会",
          start: "2026-07-31T10:00:00+08:00",
          end: "2026-07-31T12:30:00+08:00",
        },
      },
    ],
    [
      "error envelope",
      {
        ok: false,
        identity: "user",
        error: { code: "CLI_EXITED", message: "failed" },
      },
    ],
    [
      "extra data",
      {
        ok: true,
        identity: "user",
        data: {
          event_id: "event_1",
          summary: "经营会",
          start: "2026-07-31T10:00:00+08:00",
          end: "2026-07-31T12:30:00+08:00",
          recurrence: "FREQ=DAILY",
        },
      },
    ],
    [
      "open id",
      {
        ok: true,
        identity: "user",
        data: {
          event_id: "event_1",
          summary: "经营会",
          start: "2026-07-31T10:00:00+08:00",
          end: "2026-07-31T12:30:00+08:00",
          attendee_open_ids: ["ou_leak"],
        },
      },
    ],
    [
      "summary mismatch",
      {
        ok: true,
        identity: "user",
        data: {
          event_id: "event_1",
          summary: "别的日程",
          start: "2026-07-31T10:00:00+08:00",
          end: "2026-07-31T12:30:00+08:00",
        },
      },
    ],
    [
      "start mismatch",
      {
        ok: true,
        identity: "user",
        data: {
          event_id: "event_1",
          summary: "经营会",
          start: "2026-07-31T10:00:01+08:00",
          end: "2026-07-31T12:30:00+08:00",
        },
      },
    ],
    [
      "unsafe event id",
      {
        ok: true,
        identity: "user",
        data: {
          event_id: "not a real id",
          summary: "经营会",
          start: "2026-07-31T10:00:00+08:00",
          end: "2026-07-31T12:30:00+08:00",
        },
      },
    ],
    ["missing data", { ok: true, identity: "user" }],
    ["array", []],
    ["date", new Date()],
  ])("rejects %s", (_name, value) => {
    expect(() => parseDirectCalendarCliResult(value, plan!)).toThrowError(
      "invalid direct calendar CLI result",
    );
  });

  it("rejects Proxy output and a plan that was not produced by the planner", () => {
    expect(() =>
      parseDirectCalendarCliResult(
        new Proxy(
          {
            ok: true,
            identity: "user",
            data: {
              event_id: "event_1",
              summary: "经营会",
              start: "2026-07-31T10:00:00+08:00",
              end: "2026-07-31T12:30:00+08:00",
            },
          },
          {},
        ),
        plan!,
      ),
    ).toThrowError("invalid direct calendar CLI result");
    const accessorEnvelope = {
      ok: true,
      identity: "user",
    };
    Object.defineProperty(accessorEnvelope, "data", {
      enumerable: true,
      get: () => ({
        event_id: "event_1",
        summary: "经营会",
        start: "2026-07-31T10:00:00+08:00",
        end: "2026-07-31T12:30:00+08:00",
      }),
    });
    expect(() =>
      parseDirectCalendarCliResult(accessorEnvelope, plan!),
    ).toThrowError("invalid direct calendar CLI result");
    expect(() =>
      parseDirectCalendarCliResult(
        {
          ok: true,
          identity: "user",
          data: {
            event_id: "event_1",
            summary: "经营会",
            start: "2026-07-31T10:00:00+08:00",
            end: "2026-07-31T12:30:00+08:00",
          },
        },
        { ...plan, identity: "bot" } as unknown as NonNullable<typeof plan>,
      ),
    ).toThrowError("invalid trusted direct calendar plan");
  });
});
