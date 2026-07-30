import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createContactResolver,
  parseContactResolvePayload,
  type ContactClarificationConsumer,
  type ContactClarificationWriter,
} from "../src/mvp/contact-resolver.js";
import type { MvpLarkCliRunner } from "../src/mvp/registry.js";

const TASK_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a21";
const OTHER_TASK_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a29";
const NOW = new Date("2026-07-30T08:00:00.000Z");
const SELECTION_REF_1 = "018f7d72-7a2b-7f45-8a12-8e20b8426a31";
const SELECTION_REF_2 = "018f7d72-7a2b-7f45-8a12-8e20b8426a32";
const RECIPIENT_REF_1 = "018f7d72-7a2b-7f45-8a12-8e20b8426a41";
const RECIPIENT_REF_2 = "018f7d72-7a2b-7f45-8a12-8e20b8426a42";

function user(
  openId: string,
  name: string,
  department: string,
  enterpriseEmail = "",
  isActivated = true,
) {
  return {
    open_id: openId,
    localized_name: name,
    email: "",
    enterprise_email: enterpriseEmail,
    is_activated: isActivated,
    is_cross_tenant: false,
    p2p_chat_id: "oc_private_must_not_escape",
    has_chatted: true,
    department,
    chat_recency_hint: "",
    match_segments: [],
  };
}

function selection(
  optionRef: string,
  openId: string,
  name: string,
  isActivated = true,
) {
  return {
    selectionId: randomUUID(),
    groupId: randomUUID(),
    optionOrdinal: 1,
    optionRef,
    kind: "contact" as const,
    value: {
      version: 1,
      openId,
      name,
      department: "融创中国-热雪奇迹",
      enterpriseEmail: `${openId.slice(3)}@example.com`,
      isActivated,
    },
    selectedAt: NOW.toISOString(),
  };
}

function succeeded(users: readonly ReturnType<typeof user>[], hasMore = false) {
  return {
    state: "SUCCEEDED" as const,
    value: { data: { users, has_more: hasMore } },
  };
}

function runner(
  results: readonly Awaited<ReturnType<MvpLarkCliRunner["runUser"]>>[],
) {
  const runUser = vi.fn<MvpLarkCliRunner["runUser"]>();
  for (const result of results) runUser.mockResolvedValueOnce(result);
  return {
    runUser,
    runBot: vi.fn<MvpLarkCliRunner["runBot"]>(),
  } satisfies MvpLarkCliRunner;
}

function writer() {
  const writeContactClarification = vi.fn<
    ContactClarificationWriter["writeContactClarification"]
  >((input) => ({
    groupId: "018f7d72-7a2b-7f45-8a12-8e20b8426a30",
    options: input.candidates.map((candidate, index) => ({
      ordinal: index + 1,
      optionRef:
        index === 0
          ? "018f7d72-7a2b-7f45-8a12-8e20b8426a31"
          : "018f7d72-7a2b-7f45-8a12-8e20b8426a32",
      displayLabel: candidate.displayLabel,
    })),
  }));
  return { writeContactClarification } satisfies ContactClarificationWriter;
}

describe("contact resolver", () => {
  it("caches the current president department and selects the sole highest-priority normalized full-path match", async () => {
    const cli = runner([
      succeeded([
        user(
          "ou_president",
          "总裁",
          "融创中国 ／ 总部　— 总裁办公室",
          "president@example.com",
        ),
      ]),
      succeeded([
        user(
          "ou_dynamic",
          "王伟",
          "融创中国-总部-总裁办公室-战略组",
          "dynamic@example.com",
        ),
        user(
          "ou_wenlv",
          "王伟",
          "融创中国-直管业务-文旅事业部",
          "wenlv@example.com",
        ),
      ]),
      succeeded([
        user(
          "ou_dynamic_2",
          "李明",
          "融创中国-总部-总裁办公室-财务组",
          "liming@example.com",
        ),
      ]),
    ]);
    const resolver = createContactResolver({ runner: cli });

    const first = await resolver.resolve(
      TASK_ID,
      {
        recipients: [{ source: "query", name: "王伟" }],
      },
      NOW,
    );
    const second = await resolver.resolve(
      TASK_ID,
      { recipients: [{ source: "query", name: "李明" }] },
      NOW,
    );

    expect(cli.runUser.mock.calls.map(([request]) => request)).toEqual([
      { version: 1, operation: "contact.self", payload: {} },
      {
        version: 1,
        operation: "contact.search",
        payload: { query: "王伟", pageSize: 20 },
      },
      {
        version: 1,
        operation: "contact.search",
        payload: { query: "李明", pageSize: 20 },
      },
    ]);
    expect(first).toMatchObject({
      status: "RESOLVED",
      recipients: [
        {
          status: "RESOLVED",
          name: "王伟",
          department: "融创中国-总部-总裁办公室-战略组",
          enterpriseEmail: "dynamic@example.com",
          recipientRef: expect.any(String),
        },
      ],
    });
    expect(second.status).toBe("RESOLVED");
    expect(JSON.stringify(first)).not.toContain("ou_dynamic");
    expect(JSON.stringify(first)).not.toContain("oc_private");

    const recipientRef = first.recipients[0]?.recipientRef;
    expect(recipientRef).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(resolver.dereferenceRecipient(TASK_ID, recipientRef!)).toBe(
      "ou_dynamic",
    );
    expect(() =>
      resolver.dereferenceRecipient(OTHER_TASK_ID, recipientRef!),
    ).toThrowError("recipient reference is not available");
  });

  it("ranks 文旅 before 热雪 and persists same-tier choices without issuing recipient refs", async () => {
    const cli = runner([
      succeeded([user("ou_president", "总裁", "融创中国-总部-总裁办公室")]),
      succeeded([
        user("ou_ski", "张三", "融创中国-热雪奇迹", "ski@example.com"),
        user(
          "ou_wenlv_1",
          "张三",
          "融创中国-直管业务-文旅事业部-运营中心",
          "one@example.com",
        ),
        user(
          "ou_wenlv_2",
          "张三",
          "融创中国 ／ 直管业务 — 文旅事业部 ／ 财务中心",
          "two@example.com",
        ),
      ]),
    ]);
    const clarificationWriter = writer();
    const resolver = createContactResolver({
      runner: cli,
      clarificationWriter,
    });

    const result = await resolver.resolve(
      TASK_ID,
      { recipients: [{ source: "query", name: "张三" }] },
      NOW,
    );

    expect(result).toEqual({
      status: "NEEDS_CLARIFICATION",
      recipients: [
        {
          status: "NEEDS_CLARIFICATION",
          groupRef: "018f7d72-7a2b-7f45-8a12-8e20b8426a30",
          label: "联系人：张三",
          candidates: [
            {
              selectionRef: "018f7d72-7a2b-7f45-8a12-8e20b8426a31",
              label:
                "张三｜融创中国-直管业务-文旅事业部-运营中心｜one@example.com",
              name: "张三",
              department: "融创中国-直管业务-文旅事业部-运营中心",
              enterpriseEmail: "one@example.com",
            },
            {
              selectionRef: "018f7d72-7a2b-7f45-8a12-8e20b8426a32",
              label:
                "张三｜融创中国 ／ 直管业务 — 文旅事业部 ／ 财务中心｜two@example.com",
              name: "张三",
              department: "融创中国 ／ 直管业务 — 文旅事业部 ／ 财务中心",
              enterpriseEmail: "two@example.com",
            },
          ],
        },
      ],
    });
    const persisted =
      clarificationWriter.writeContactClarification.mock.calls[0]![0];
    expect(persisted).toMatchObject({
      taskId: TASK_ID,
      kind: "contact",
      groupLabel: "联系人：张三",
      now: NOW,
      candidates: [
        {
          value: {
            version: 1,
            openId: "ou_wenlv_1",
            name: "张三",
            department: "融创中国-直管业务-文旅事业部-运营中心",
            enterpriseEmail: "one@example.com",
            isActivated: true,
          },
        },
        {
          value: {
            version: 1,
            openId: "ou_wenlv_2",
            name: "张三",
            department: "融创中国 ／ 直管业务 — 文旅事业部 ／ 财务中心",
            enterpriseEmail: "two@example.com",
            isActivated: true,
          },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("ou_");
    expect(() =>
      resolver.dereferenceRecipient(
        TASK_ID,
        "018f7d72-7a2b-7f45-8a12-8e20b8426a31",
      ),
    ).toThrowError("recipient reference is not available");
  });

  it("clarifies a sole candidate outside the three preferred organizations", async () => {
    const cli = runner([
      succeeded([user("ou_president", "总裁", "融创中国-总部-总裁办公室")]),
      succeeded([
        user("ou_other", "赵敏", "融创中国-物业集团", "zhaomin@example.com"),
      ]),
    ]);
    const clarificationWriter = writer();
    const result = await createContactResolver({
      runner: cli,
      clarificationWriter,
    }).resolve(
      TASK_ID,
      { recipients: [{ source: "query", name: "赵敏" }] },
      NOW,
    );

    expect(result.status).toBe("NEEDS_CLARIFICATION");
    expect(
      clarificationWriter.writeContactClarification.mock.calls[0]![0]
        .candidates,
    ).toHaveLength(1);
  });

  it("automatically resolves the sole 热雪 candidate when no higher-priority organization matches", async () => {
    const cli = runner([
      succeeded([user("ou_president", "总裁", "融创中国-总部-总裁办公室")]),
      succeeded([
        user(
          "ou_ski",
          "周宁",
          "融创中国-热雪奇迹-运营中心",
          "zhouning@example.com",
        ),
        user("ou_other", "周宁", "融创中国-物业集团", "other@example.com"),
      ]),
    ]);
    const result = await createContactResolver({ runner: cli }).resolve(
      TASK_ID,
      { recipients: [{ source: "query", name: "周宁" }] },
      NOW,
    );

    expect(result).toMatchObject({
      status: "RESOLVED",
      recipients: [
        {
          status: "RESOLVED",
          name: "周宁",
          department: "融创中国-热雪奇迹-运营中心",
        },
      ],
    });
  });

  it("returns INCOMPLETE with no refs or persistence when any search has_more", async () => {
    const cli = runner([
      succeeded([user("ou_president", "总裁", "融创中国-总部-总裁办公室")]),
      succeeded(
        [user("ou_candidate", "王伟", "融创中国-总部-总裁办公室")],
        true,
      ),
    ]);
    const clarificationWriter = writer();
    const resolver = createContactResolver({
      runner: cli,
      clarificationWriter,
    });

    const result = await resolver.resolve(
      TASK_ID,
      { recipients: [{ source: "query", name: "王伟" }] },
      NOW,
    );

    expect(result).toEqual({ status: "INCOMPLETE", recipients: [] });
    expect(
      clarificationWriter.writeContactClarification,
    ).not.toHaveBeenCalled();
    expect(() =>
      resolver.dereferenceRecipient(TASK_ID, randomUUID()),
    ).toThrowError("recipient reference is not available");
  });

  it("does not turn CLI failure or malformed output into an empty result", async () => {
    const failed = runner([{ state: "FAILED", code: "CLI_EXITED" }]);
    await expect(
      createContactResolver({ runner: failed }).resolve(
        TASK_ID,
        { recipients: [{ source: "query", name: "王伟" }] },
        NOW,
      ),
    ).rejects.toThrowError("contact CLI result is unavailable");

    const malformed = runner([
      {
        state: "SUCCEEDED",
        value: {
          data: {
            users: [
              {
                ...user("ou_president", "总裁", "总裁办公室"),
                raw_token: "must-be-rejected",
              },
            ],
            has_more: false,
          },
        },
      },
    ]);
    await expect(
      createContactResolver({ runner: malformed }).resolve(
        TASK_ID,
        { recipients: [{ source: "query", name: "王伟" }] },
        NOW,
      ),
    ).rejects.toThrowError("invalid contact CLI result");
  });

  it("does not issue any recipient ref when one query resolves and another is not found", async () => {
    const cli = runner([
      succeeded([user("ou_president", "总裁", "融创中国-总部-总裁办公室")]),
      succeeded([user("ou_resolved", "王伟", "融创中国-总部-总裁办公室")]),
      succeeded([]),
    ]);
    const resolver = createContactResolver({ runner: cli });

    const result = await resolver.resolve(
      TASK_ID,
      {
        recipients: [
          { source: "query", name: "王伟" },
          { source: "query", name: "不存在" },
        ],
      },
      NOW,
    );

    expect(result.status).toBe("NOT_FOUND");
    expect(JSON.stringify(result)).not.toContain("recipientRef");
  });

  it("does not issue any recipient ref when one query resolves and another needs clarification", async () => {
    const cli = runner([
      succeeded([user("ou_president", "总裁", "融创中国-总部-总裁办公室")]),
      succeeded([user("ou_resolved", "王伟", "融创中国-总部-总裁办公室")]),
      succeeded([
        user("ou_choice_1", "张三", "融创中国-直管业务-文旅事业部"),
        user("ou_choice_2", "张三", "融创中国-直管业务-文旅事业部"),
      ]),
    ]);
    const clarificationWriter = writer();
    const result = await createContactResolver({
      runner: cli,
      clarificationWriter,
    }).resolve(
      TASK_ID,
      {
        recipients: [
          { source: "query", name: "王伟" },
          { source: "query", name: "张三" },
        ],
      },
      NOW,
    );

    expect(result.status).toBe("NEEDS_CLARIFICATION");
    expect(JSON.stringify(result)).not.toContain("recipientRef");
    expect(
      clarificationWriter.writeContactClarification,
    ).toHaveBeenCalledOnce();
  });

  it("consumes multiple opaque contact selections through one trusted batch and reissues current-task refs", async () => {
    const selected = [
      selection(SELECTION_REF_1, "ou_selected_1", "张三"),
      selection(SELECTION_REF_2, "ou_selected_2", "李四"),
    ] as const;
    const consumeClarificationsForTaskValidated = vi.fn<
      ContactClarificationConsumer["consumeClarificationsForTaskValidated"]
    >((_taskId, _optionRefs, _kind, _now, assertValue) => {
      selected.forEach((entry, index) => assertValue(entry.value, index));
      return selected;
    });
    const clarificationConsumer = {
      consumeClarificationsForTaskValidated,
    } satisfies ContactClarificationConsumer;
    const resolver = createContactResolver({
      runner: runner([]),
      clarificationConsumer,
      randomUuid: vi
        .fn()
        .mockReturnValueOnce(RECIPIENT_REF_1)
        .mockReturnValueOnce(RECIPIENT_REF_2),
    });

    const result = await resolver.resolve(
      TASK_ID,
      {
        recipients: [
          {
            source: "selection",
            selectionRef: SELECTION_REF_1,
          },
          {
            source: "selection",
            selectionRef: SELECTION_REF_2,
          },
        ],
      },
      NOW,
    );

    expect(consumeClarificationsForTaskValidated).toHaveBeenCalledOnce();
    expect(consumeClarificationsForTaskValidated).toHaveBeenCalledWith(
      TASK_ID,
      [SELECTION_REF_1, SELECTION_REF_2],
      "contact",
      NOW,
      expect.any(Function),
    );
    expect(result).toMatchObject({
      status: "RESOLVED",
      recipients: [
        {
          status: "RESOLVED",
          name: "张三",
          department: "融创中国-热雪奇迹",
          enterpriseEmail: "selected_1@example.com",
          recipientRef: expect.any(String),
        },
        {
          status: "RESOLVED",
          name: "李四",
          department: "融创中国-热雪奇迹",
          enterpriseEmail: "selected_2@example.com",
          recipientRef: expect.any(String),
        },
      ],
    });
    expect(
      result.recipients.map((recipient) => recipient.recipientRef),
    ).toEqual([RECIPIENT_REF_1, RECIPIENT_REF_2]);
    expect(JSON.stringify(result)).not.toContain("ou_selected_");
    expect(
      resolver.dereferenceRecipient(
        TASK_ID,
        result.recipients[0]!.recipientRef!,
      ),
    ).toBe("ou_selected_1");
    expect(
      resolver.dereferenceRecipient(
        TASK_ID,
        result.recipients[1]!.recipientRef!,
      ),
    ).toBe("ou_selected_2");
  });

  it("rolls back a high-fidelity selection transaction and registers no recipient when contact value validation fails", async () => {
    let persistedSelectionCount = 0;
    const selected = [
      selection(SELECTION_REF_1, "ou_selected_1", "张三"),
      {
        ...selection(SELECTION_REF_2, "ou_selected_2", "李四"),
        value: {
          ...selection(SELECTION_REF_2, "ou_selected_2", "李四").value,
          token: "must-be-rejected",
        },
      },
    ] as const;
    const consumeClarificationsForTaskValidated = vi.fn<
      ContactClarificationConsumer["consumeClarificationsForTaskValidated"]
    >((_taskId, _optionRefs, _kind, _now, assertValue) => {
      selected.forEach((entry, index) => assertValue(entry.value, index));
      persistedSelectionCount += selected.length;
      return selected;
    });
    const randomUuid = vi
      .fn()
      .mockReturnValueOnce(RECIPIENT_REF_1)
      .mockReturnValueOnce(RECIPIENT_REF_2);
    const resolver = createContactResolver({
      runner: runner([]),
      clarificationConsumer: { consumeClarificationsForTaskValidated },
      randomUuid,
    });

    await expect(
      resolver.resolve(
        TASK_ID,
        {
          recipients: [
            {
              source: "selection",
              selectionRef: SELECTION_REF_1,
            },
            {
              source: "selection",
              selectionRef: SELECTION_REF_2,
            },
          ],
        },
        NOW,
      ),
    ).rejects.toThrowError("invalid contact selection");
    expect(persistedSelectionCount).toBe(0);
    expect(() =>
      resolver.dereferenceRecipient(TASK_ID, RECIPIENT_REF_1),
    ).toThrowError("recipient reference is not available");
    expect(() =>
      resolver.dereferenceRecipient(TASK_ID, RECIPIENT_REF_2),
    ).toThrowError("recipient reference is not available");
  });

  it("leaves all selections unconsumed and issues no refs when the batch consumer rejects", async () => {
    const consumeClarificationsForTaskValidated = vi.fn<
      ContactClarificationConsumer["consumeClarificationsForTaskValidated"]
    >(() => {
      throw new Error("clarification_not_available");
    });
    const resolver = createContactResolver({
      runner: runner([]),
      clarificationConsumer: { consumeClarificationsForTaskValidated },
    });

    await expect(
      resolver.resolve(
        TASK_ID,
        {
          recipients: [
            { source: "selection", selectionRef: SELECTION_REF_1 },
            { source: "selection", selectionRef: SELECTION_REF_2 },
          ],
        },
        NOW,
      ),
    ).rejects.toThrowError("clarification_not_available");
    expect(consumeClarificationsForTaskValidated).toHaveBeenCalledOnce();
    expect(consumeClarificationsForTaskValidated).toHaveBeenCalledWith(
      TASK_ID,
      [SELECTION_REF_1, SELECTION_REF_2],
      "contact",
      NOW,
      expect.any(Function),
    );
  });

  it("fails closed on inactive query results and inactive selected values", async () => {
    const inactiveCli = runner([
      succeeded([user("ou_president", "总裁", "融创中国-总部-总裁办公室")]),
      succeeded([
        user("ou_inactive", "王伟", "融创中国-总部-总裁办公室", "", false),
      ]),
    ]);
    await expect(
      createContactResolver({ runner: inactiveCli }).resolve(
        TASK_ID,
        { recipients: [{ source: "query", name: "王伟" }] },
        NOW,
      ),
    ).rejects.toThrowError("invalid contact CLI result");

    const inactiveSelection = [
      selection(SELECTION_REF_1, "ou_inactive_selected", "王伟", false),
    ] as const;
    const consumeClarificationsForTaskValidated = vi.fn<
      ContactClarificationConsumer["consumeClarificationsForTaskValidated"]
    >((_taskId, _optionRefs, _kind, _now, assertValue) => {
      inactiveSelection.forEach((entry, index) =>
        assertValue(entry.value, index),
      );
      return inactiveSelection;
    });
    await expect(
      createContactResolver({
        runner: runner([]),
        clarificationConsumer: { consumeClarificationsForTaskValidated },
      }).resolve(
        TASK_ID,
        {
          recipients: [{ source: "selection", selectionRef: SELECTION_REF_1 }],
        },
        NOW,
      ),
    ).rejects.toThrowError("invalid contact selection");
  });

  it("rejects oversized and duplicate-open-id CLI pages before ranking", async () => {
    const oversized = Array.from({ length: 21 }, (_, index) =>
      user(`ou_candidate_${index}`, "王伟", "融创中国-总部-总裁办公室"),
    );
    const duplicate = user("ou_duplicate", "王伟", "融创中国-总部-总裁办公室");

    for (const users of [oversized, [duplicate, duplicate]]) {
      const cli = runner([
        succeeded([user("ou_president", "总裁", "融创中国-总部-总裁办公室")]),
        succeeded(users),
      ]);
      await expect(
        createContactResolver({ runner: cli }).resolve(
          TASK_ID,
          { recipients: [{ source: "query", name: "王伟" }] },
          NOW,
        ),
      ).rejects.toThrowError("invalid contact CLI result");
    }
  });

  it("rejects label delimiter and bidi-format spoofing before clarification persistence", async () => {
    const clarificationWriter = writer();
    const cli = runner([
      succeeded([user("ou_president", "总裁", "融创中国-总部-总裁办公室")]),
      succeeded([
        user(
          "ou_spoof",
          "王伟\u202e",
          "融创中国｜伪造部门",
          "spoof@example.com",
        ),
      ]),
    ]);

    await expect(
      createContactResolver({
        runner: cli,
        clarificationWriter,
      }).resolve(
        TASK_ID,
        { recipients: [{ source: "query", name: "王伟" }] },
        NOW,
      ),
    ).rejects.toThrowError("invalid contact CLI result");
    expect(
      clarificationWriter.writeContactClarification,
    ).not.toHaveBeenCalled();
  });

  it("caps cumulative live recipient refs at 20 and rejects an overflowing call before any new issuance", async () => {
    const initialNames = Array.from(
      { length: 19 },
      (_, index) => `员工${index}`,
    );
    const cli = runner([
      succeeded([user("ou_president", "总裁", "融创中国-总部-总裁办公室")]),
      ...initialNames.map((name, index) =>
        succeeded([
          user(`ou_initial_${index}`, name, "融创中国-总部-总裁办公室"),
        ]),
      ),
      succeeded([user("ou_overflow_a", "溢出甲", "融创中国-总部-总裁办公室")]),
      succeeded([user("ou_overflow_b", "溢出乙", "融创中国-总部-总裁办公室")]),
    ]);
    const resolver = createContactResolver({ runner: cli });
    const existingRefs: string[] = [];
    for (const name of initialNames) {
      const result = await resolver.resolve(
        TASK_ID,
        { recipients: [{ source: "query", name }] },
        NOW,
      );
      existingRefs.push(result.recipients[0]!.recipientRef!);
    }

    await expect(
      resolver.resolve(
        TASK_ID,
        {
          recipients: [
            { source: "query", name: "溢出甲" },
            { source: "query", name: "溢出乙" },
          ],
        },
        NOW,
      ),
    ).rejects.toThrowError("recipient reference limit exceeded");
    for (const [index, recipientRef] of existingRefs.entries()) {
      expect(resolver.dereferenceRecipient(TASK_ID, recipientRef)).toBe(
        `ou_initial_${index}`,
      );
    }
  });

  it("rejects capacity overflow before consuming a one-time selection batch", async () => {
    const names = Array.from({ length: 20 }, (_, index) => `满额员工${index}`);
    const cli = runner([
      succeeded([user("ou_president", "总裁", "融创中国-总部-总裁办公室")]),
      ...names.map((name, index) =>
        succeeded([
          user(`ou_capacity_${index}`, name, "融创中国-总部-总裁办公室"),
        ]),
      ),
    ]);
    const consumeClarificationsForTaskValidated = vi.fn<
      ContactClarificationConsumer["consumeClarificationsForTaskValidated"]
    >(() => [selection(SELECTION_REF_1, "ou_selected", "张三")]);
    const resolver = createContactResolver({
      runner: cli,
      clarificationConsumer: { consumeClarificationsForTaskValidated },
    });
    await resolver.resolve(
      TASK_ID,
      { recipients: names.map((name) => ({ source: "query", name })) },
      NOW,
    );

    await expect(
      resolver.resolve(
        TASK_ID,
        {
          recipients: [{ source: "selection", selectionRef: SELECTION_REF_1 }],
        },
        NOW,
      ),
    ).rejects.toThrowError("recipient reference limit exceeded");
    expect(consumeClarificationsForTaskValidated).not.toHaveBeenCalled();
  });

  it.each(["throws", "collides"] as const)(
    "does not consume selections or register partial refs when the second random UUID %s",
    async (failure) => {
      let callCount = 0;
      const randomUuid = vi.fn(() => {
        callCount += 1;
        if (callCount === 1) return RECIPIENT_REF_1;
        if (failure === "throws") throw new Error("random source failed");
        return RECIPIENT_REF_1;
      });
      const consumeClarificationsForTaskValidated = vi.fn<
        ContactClarificationConsumer["consumeClarificationsForTaskValidated"]
      >(() => [
        selection(SELECTION_REF_1, "ou_selected_1", "张三"),
        selection(SELECTION_REF_2, "ou_selected_2", "李四"),
      ]);
      const resolver = createContactResolver({
        runner: runner([]),
        clarificationConsumer: { consumeClarificationsForTaskValidated },
        randomUuid,
      });

      await expect(
        resolver.resolve(
          TASK_ID,
          {
            recipients: [
              { source: "selection", selectionRef: SELECTION_REF_1 },
              { source: "selection", selectionRef: SELECTION_REF_2 },
            ],
          },
          NOW,
        ),
      ).rejects.toThrowError(
        failure === "throws"
          ? "random source failed"
          : "recipient reference generation failed",
      );
      expect(randomUuid).toHaveBeenCalledTimes(2);
      expect(consumeClarificationsForTaskValidated).not.toHaveBeenCalled();
      expect(() =>
        resolver.dereferenceRecipient(TASK_ID, RECIPIENT_REF_1),
      ).toThrowError("recipient reference is not available");
    },
  );
});

describe("contact.resolve public payload", () => {
  it("accepts only 1..20 exact query or selection recipients", () => {
    expect(
      parseContactResolvePayload({
        recipients: [
          {
            source: "query",
            name: "王伟",
            departmentHint: "文旅事业部",
            enterpriseEmail: "wangwei@example.com",
          },
          {
            source: "selection",
            selectionRef: "018f7d72-7a2b-7f45-8a12-8e20b8426a31",
          },
        ],
      }),
    ).toEqual({
      recipients: [
        {
          source: "query",
          name: "王伟",
          departmentHint: "文旅事业部",
          enterpriseEmail: "wangwei@example.com",
        },
        {
          source: "selection",
          selectionRef: "018f7d72-7a2b-7f45-8a12-8e20b8426a31",
        },
      ],
    });
  });

  it.each([
    ["empty recipients", { recipients: [] }],
    [
      "more than 20 recipients",
      {
        recipients: Array.from({ length: 21 }, () => ({
          source: "query",
          name: "王伟",
        })),
      },
    ],
    [
      "free open id",
      { recipients: [{ source: "query", name: "王伟", openId: "ou_bad" }] },
    ],
    [
      "free user id",
      { recipients: [{ source: "query", name: "王伟", userId: "u_bad" }] },
    ],
    [
      "free chat id",
      { recipients: [{ source: "query", name: "王伟", chatId: "oc_bad" }] },
    ],
    [
      "free URL",
      {
        recipients: [
          { source: "query", name: "王伟", url: "https://example.invalid" },
        ],
      },
    ],
    [
      "free actor",
      { recipients: [{ source: "query", name: "王伟", actor: "someone" }] },
    ],
    [
      "free identity",
      { recipients: [{ source: "query", name: "王伟", identity: "bot" }] },
    ],
    [
      "query with selection ref",
      {
        recipients: [
          {
            source: "query",
            name: "王伟",
            selectionRef: "018f7d72-7a2b-7f45-8a12-8e20b8426a31",
          },
        ],
      },
    ],
    [
      "selection with a name",
      {
        recipients: [
          {
            source: "selection",
            selectionRef: "018f7d72-7a2b-7f45-8a12-8e20b8426a31",
            name: "王伟",
          },
        ],
      },
    ],
    [
      "department hint empty after normalization",
      {
        recipients: [
          {
            source: "query",
            name: "王伟",
            departmentHint: " ／ — \\ ",
          },
        ],
      },
    ],
    [
      "fullwidth label delimiter",
      { recipients: [{ source: "query", name: "王伟｜财务" }] },
    ],
    [
      "bidi format control",
      { recipients: [{ source: "query", name: "王\u202e伟" }] },
    ],
  ])("rejects %s", (_name, payload) => {
    expect(() => parseContactResolvePayload(payload)).toThrowError(
      "invalid contact.resolve payload",
    );
  });
});
