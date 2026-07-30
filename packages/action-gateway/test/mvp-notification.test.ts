import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMvpNotificationCoordinator,
  planNotificationInstruction,
  renderNotificationDisplayCard,
  resolveNotificationTaskResource,
  type MvpNotificationBatchStore,
  type MvpNotificationCoordinator,
} from "../src/mvp/notification.js";
import type { MvpLarkCliRunner } from "../src/mvp/registry.js";

const TASK_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a21";
const REF_A = "018f7d72-7a2b-7f45-8a12-8e20b8426a41";
const REF_B = "018f7d72-7a2b-7f45-8a12-8e20b8426a42";
const CURRENT_TEXT_REF = "018f7d72-7a2b-7f45-8a12-8e20b8426a71";
const IMAGE_REF = "018f7d72-7a2b-7f45-8a12-8e20b8426a72";
const FILE_REF = "018f7d72-7a2b-7f45-8a12-8e20b8426a73";
const NOW = new Date("2026-07-30T08:00:00.000Z");
const temporaryPaths: string[] = [];

afterEach(async () => {
  for (const path of temporaryPaths.splice(0)) {
    await rm(path, { force: true, recursive: true });
  }
});

const planWithResources = planNotificationInstruction as unknown as (
  taskId: string,
  value: unknown,
  dereferenceRecipient: typeof resolve,
  dereferenceResource: (
    taskId: string,
    resourceRef: string,
  ) => Readonly<Record<string, unknown>>,
) => Readonly<Record<string, unknown>>;

function resolve(
  _taskId: string,
  recipientRef: string,
): Readonly<{ openId: string; displayName: string }> {
  if (recipientRef === REF_A) {
    return Object.freeze({ openId: "ou_a", displayName: "王伟" });
  }
  if (recipientRef === REF_B) {
    return Object.freeze({ openId: "ou_b", displayName: "李娜" });
  }
  throw new Error("unknown recipient");
}

describe("trusted notification resource binding", () => {
  it("reopens the task file without following links and verifies its full SHA before exposing exact text", async () => {
    const workspace = await mkdtemp(
      join(await realpath(tmpdir()), "notification-resource-"),
    );
    temporaryPaths.push(workspace);
    await chmod(workspace, 0o700);
    const relativePath =
      "resources/00-018f7d72-7a2b-7f45-8a12-8e20b8426a74.txt";
    const resourceDirectory = join(workspace, "resources");
    await mkdir(resourceDirectory, { mode: 0o700 });
    const body = "请逐字转发：经营数据必须在周五前提交。";
    const path = join(workspace, relativePath);
    await writeFile(path, body, { mode: 0o600 });
    await chmod(path, 0o600);
    const sha256 = createHash("sha256")
      .update(Buffer.from(body, "utf8"))
      .digest("hex");

    const resolved = resolveNotificationTaskResource(workspace, {
      resourceRef: CURRENT_TEXT_REF,
      sourceKind: "current",
      sourceMessageHash: "a".repeat(64),
      kind: "text",
      displayName: "当前指令.txt",
      relativePath,
      sizeBytes: Buffer.byteLength(body, "utf8"),
      sha256,
    });

    expect(resolved).toEqual({
      sourceKind: "current",
      kind: "text",
      displayName: "当前指令.txt",
      relativePath,
      sizeBytes: Buffer.byteLength(body, "utf8"),
      sha256: `sha256:${sha256}`,
      text: body,
    });
    expect(JSON.stringify(resolved)).not.toContain(workspace);
    expect(await readFile(path, "utf8")).toBe(body);

    await writeFile(path, body.replace("经营", "营经"), { mode: 0o600 });
    expect(() =>
      resolveNotificationTaskResource(workspace, {
        resourceRef: CURRENT_TEXT_REF,
        sourceKind: "current",
        sourceMessageHash: "a".repeat(64),
        kind: "text",
        displayName: "当前指令.txt",
        relativePath,
        sizeBytes: Buffer.byteLength(body, "utf8"),
        sha256,
      }),
    ).toThrowError("invalid direct notification payload");
  });
});

describe("direct notification planning", () => {
  it("reads verbatim text from trusted current-task evidence and rejects any rewrite", () => {
    const dereferenceResource = vi.fn(
      (_taskId: string, resourceRef: string) => {
        if (resourceRef !== CURRENT_TEXT_REF) throw new Error("unknown");
        return Object.freeze({
          resourceRef,
          sourceKind: "current",
          kind: "text",
          displayName: "当前指令.txt",
          relativePath: "resources/00-018f7d72-7a2b-7f45-8a12-8e20b8426a74.txt",
          sizeBytes: Buffer.byteLength(
            "请逐字转发：本周经营数据必须在周五前提交。",
            "utf8",
          ),
          sha256: `sha256:${"a".repeat(64)}`,
          text: "请逐字转发：本周经营数据必须在周五前提交。",
        });
      },
    );

    const plan = planWithResources(
      TASK_ID,
      {
        recipientRefs: [REF_A],
        content: {
          kind: "text",
          text: "本周经营数据必须在周五前提交。",
          wording: "verbatim",
          verbatimSourceRef: CURRENT_TEXT_REF,
        },
        attachmentRefs: [],
      },
      resolve,
      dereferenceResource,
    );

    expect(plan).toMatchObject({
      content: {
        kind: "text",
        text: "本周经营数据必须在周五前提交。",
        wording: "verbatim",
      },
    });
    expect(JSON.stringify(plan)).not.toContain(CURRENT_TEXT_REF);
    expect(dereferenceResource).toHaveBeenCalledWith(TASK_ID, CURRENT_TEXT_REF);

    expect(() =>
      planWithResources(
        TASK_ID,
        {
          recipientRefs: [REF_A],
          content: {
            kind: "text",
            text: "本周经营数据最好在周五前提交。",
            wording: "verbatim",
            verbatimSourceRef: CURRENT_TEXT_REF,
          },
          attachmentRefs: [],
        },
        resolve,
        dereferenceResource,
      ),
    ).toThrowError("invalid direct notification payload");
  });

  it("resolves every attachment before persistence and fixes one display-card plus stable image/file parts", () => {
    const dereferenceResource = vi.fn(
      (_taskId: string, resourceRef: string) => {
        if (resourceRef === IMAGE_REF) {
          return Object.freeze({
            resourceRef,
            sourceKind: "current",
            kind: "image",
            displayName: "../../董事会现场.png",
            relativePath:
              "resources/01-018f7d72-7a2b-7f45-8a12-8e20b8426a75.bin",
            sizeBytes: 11,
            sha256: `sha256:${"b".repeat(64)}`,
          });
        }
        if (resourceRef === FILE_REF) {
          return Object.freeze({
            resourceRef,
            sourceKind: "quoted",
            kind: "file",
            displayName: "../经营报告.pdf",
            relativePath:
              "resources/02-018f7d72-7a2b-7f45-8a12-8e20b8426a76.bin",
            sizeBytes: 17,
            sha256: `sha256:${"c".repeat(64)}`,
          });
        }
        throw new Error("unknown");
      },
    );

    const plan = planWithResources(
      TASK_ID,
      {
        recipientRefs: [REF_A, REF_B],
        content: {
          kind: "text",
          text: "请查收并反馈。",
          wording: "composed",
        },
        attachmentRefs: [IMAGE_REF, FILE_REF],
      },
      resolve,
      dereferenceResource,
    );

    expect(plan).toMatchObject({
      content: {
        kind: "display_card",
        title: "总裁转发",
        source: "总裁办公室",
        body: "请查收并反馈。",
        items: ["../../董事会现场.png", "../经营报告.pdf"],
        wording: "composed",
      },
      attachments: [
        {
          kind: "image",
          displayName: "../../董事会现场.png",
          relativePath: "resources/01-018f7d72-7a2b-7f45-8a12-8e20b8426a75.bin",
          sizeBytes: 11,
          sha256: `sha256:${"b".repeat(64)}`,
        },
        {
          kind: "file",
          displayName: "../经营报告.pdf",
          relativePath: "resources/02-018f7d72-7a2b-7f45-8a12-8e20b8426a76.bin",
          sizeBytes: 17,
          sha256: `sha256:${"c".repeat(64)}`,
        },
      ],
    });
    expect(dereferenceResource.mock.calls).toEqual([
      [TASK_ID, IMAGE_REF],
      [TASK_ID, FILE_REF],
    ]);
    expect(JSON.stringify(plan)).not.toContain(IMAGE_REF);
    expect(JSON.stringify(plan)).not.toContain(FILE_REF);
  });

  it("dereferences and canonicalizes the complete recipient set before persistence", () => {
    const first = planNotificationInstruction(
      TASK_ID,
      {
        recipientRefs: [REF_B, REF_A],
        content: {
          kind: "text",
          text: "请于今天下班前反馈经营数据。",
          wording: "composed",
        },
        attachmentRefs: [],
      },
      resolve,
    );
    const replay = planNotificationInstruction(
      TASK_ID,
      {
        recipientRefs: [REF_A, REF_B],
        content: {
          wording: "composed",
          text: "请于今天下班前反馈经营数据。",
          kind: "text",
        },
        attachmentRefs: [],
      },
      resolve,
    );

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      taskId: TASK_ID,
      capability: "notification.send.direct",
      identity: "bot",
      recipients: [
        { openId: "ou_a", displayName: "王伟" },
        { openId: "ou_b", displayName: "李娜" },
      ],
      content: {
        kind: "text",
        text: "请于今天下班前反馈经营数据。",
        wording: "composed",
      },
    });
    expect(first.batchKey).toMatch(/^notification:sha256:[0-9a-f]{64}$/);
    expect(first.recipients.map((recipient) => recipient.recipientRef)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
      ]),
    );
    expect(JSON.stringify(first)).not.toContain(REF_A);
    expect(JSON.stringify(first)).not.toContain(REF_B);
  });

  it.each([
    {
      recipientRefs: [REF_A],
      content: { kind: "text", text: "原文", wording: "verbatim" },
      attachmentRefs: [],
    },
    {
      recipientRefs: [REF_A],
      content: { kind: "text", text: "通知", wording: "composed" },
      attachmentRefs: ["018f7d72-7a2b-7f45-8a12-8e20b8426a70"],
    },
  ])(
    "fails closed for out-of-scope forwarding before dereference",
    (payload) => {
      const dereference = vi.fn(resolve);
      expect(() =>
        planNotificationInstruction(TASK_ID, payload, dereference),
      ).toThrowError("invalid direct notification payload");
      expect(dereference).not.toHaveBeenCalled();
    },
  );

  it("fails the entire batch when any same-task reference is unavailable", () => {
    const dereference = vi.fn(resolve);
    expect(() =>
      planNotificationInstruction(
        TASK_ID,
        {
          recipientRefs: [REF_A, randomUUID()],
          content: {
            kind: "text",
            text: "请反馈。",
            wording: "composed",
          },
          attachmentRefs: [],
        },
        dereference,
      ),
    ).toThrowError();
    expect(dereference).toHaveBeenCalledTimes(2);
  });

  it("generates one fixed passive Schema 2.0 display card", () => {
    const card = renderNotificationDisplayCard({
      kind: "display_card",
      title: "经营提醒",
      source: "总裁办公室",
      body: "请关注本周重点事项。",
      items: ["经营数据", "安全检查"],
      wording: "composed",
    });

    expect(card).toEqual({
      schema: "2.0",
      header: {
        template: "blue",
        title: { tag: "plain_text", content: "经营提醒" },
      },
      body: {
        direction: "vertical",
        padding: "12px 12px 16px 12px",
        elements: [
          {
            tag: "div",
            text: { tag: "plain_text", content: "来源：总裁办公室" },
          },
          {
            tag: "div",
            text: { tag: "plain_text", content: "请关注本周重点事项。" },
          },
          {
            tag: "div",
            text: { tag: "plain_text", content: "• 经营数据" },
          },
          {
            tag: "div",
            text: { tag: "plain_text", content: "• 安全检查" },
          },
        ],
      },
    });
    expect(JSON.stringify(card)).not.toMatch(
      /button|url|callback|behavior|behaviors/i,
    );
  });
});

describe("direct notification coordinator", () => {
  it("sends one fixed card then ordered image/file parts under one recipient action and continues after failure", async () => {
    const plan = planWithResources(
      TASK_ID,
      {
        recipientRefs: [REF_A],
        content: {
          kind: "text",
          text: "请查收。",
          wording: "composed",
        },
        attachmentRefs: [IMAGE_REF, FILE_REF],
      },
      resolve,
      (_taskId, resourceRef) =>
        resourceRef === IMAGE_REF
          ? Object.freeze({
              sourceKind: "current",
              kind: "image",
              displayName: "../../董事会现场.png",
              relativePath:
                "resources/01-018f7d72-7a2b-7f45-8a12-8e20b8426a75.bin",
              sizeBytes: 11,
              sha256: `sha256:${"b".repeat(64)}`,
            })
          : Object.freeze({
              sourceKind: "quoted",
              kind: "file",
              displayName: "../经营报告.pdf",
              relativePath:
                "resources/02-018f7d72-7a2b-7f45-8a12-8e20b8426a76.bin",
              sizeBytes: 17,
              sha256: `sha256:${"c".repeat(64)}`,
            }),
    ) as unknown as Parameters<MvpNotificationCoordinator["execute"]>[0];
    const batchId = randomUUID();
    const actionId = randomUUID();
    const partIds = [randomUUID(), randomUUID(), randomUUID()];
    const idempotencyKeys = [randomUUID(), randomUUID(), randomUUID()];
    const kinds = ["content", "image", "file"] as const;
    const states = ["PENDING", "PENDING", "PENDING"] as Array<
      "PENDING" | "DISPATCHING" | "SUCCEEDED" | "FAILED" | "UNKNOWN"
    >;
    let active = -1;
    const deliveries = () =>
      states.map((state, index) => ({
        recipientOrdinal: 1,
        actionId,
        part: {
          partId: partIds[index],
          recipientOrdinal: 1,
          actionId,
          partOrdinal: index + 1,
          partKind: kinds[index],
          idempotencyKey: idempotencyKeys[index],
          state,
          attemptCount: state === "PENDING" ? 0 : 1,
          remoteId: null,
          result: null,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        },
      }));
    const store = {
      createNotificationBatch: vi.fn(() => ({
        created: true,
        batch: {
          batchId,
          taskId: TASK_ID,
          recipientCount: 1,
          state: states.every((state) => state === "PENDING")
            ? "PREPARED"
            : "DISPATCHING",
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
          deliveries: deliveries(),
        },
      })),
      claimNextNotificationDelivery: vi.fn(() => {
        active = states.findIndex((state) => state === "PENDING");
        if (active < 0) return null;
        return {
          batchId,
          recipientOrdinal: 1,
          leaseExpiresAt: "2026-07-30T08:01:00.000Z",
          action: { actionId, version: 1 },
          part: deliveries()[active]?.part,
        };
      }),
      markNotificationDeliveryDispatching: vi.fn(() => {
        states[active] = "DISPATCHING";
        return { action: {}, part: deliveries()[active]?.part };
      }),
      finishNotificationDelivery: vi.fn(
        (input: { outcome: "SUCCEEDED" | "FAILED_DEFINITE" | "UNKNOWN" }) => {
          states[active] =
            input.outcome === "SUCCEEDED"
              ? "SUCCEEDED"
              : input.outcome === "FAILED_DEFINITE"
                ? "FAILED"
                : "UNKNOWN";
          return { action: {}, part: deliveries()[active]?.part, summary: {} };
        },
      ),
      getNotificationBatchSummary: vi.fn(),
    } as unknown as MvpNotificationBatchStore;
    const runBot = vi
      .fn<MvpLarkCliRunner["runBot"]>()
      .mockResolvedValueOnce({
        state: "SUCCEEDED",
        value: {
          ok: true,
          identity: "bot",
          data: { message_id: "om_card" },
        },
      })
      .mockResolvedValueOnce({
        state: "FAILED",
        code: "CLI_EXITED",
      })
      .mockResolvedValueOnce({
        state: "SUCCEEDED",
        value: {
          ok: true,
          identity: "bot",
          data: { message_id: "om_file" },
        },
      });
    const coordinator = createMvpNotificationCoordinator({
      store,
      runner: { runBot, runUser: vi.fn() },
      owner: "runtime-test",
      now: () => NOW,
    });

    const result = await coordinator.execute(plan);

    expect(runBot.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({ operation: "notification.send.card" }),
      {
        version: 1,
        operation: "notification.send.image",
        payload: {
          recipientOpenId: "ou_a",
          sourceRelativePath:
            "resources/01-018f7d72-7a2b-7f45-8a12-8e20b8426a75.bin",
          outputFileName: "attachment-02-image.bin",
          sizeBytes: 11,
          sha256: `sha256:${"b".repeat(64)}`,
          idempotencyKey: idempotencyKeys[1],
        },
      },
      {
        version: 1,
        operation: "notification.send.file",
        payload: {
          recipientOpenId: "ou_a",
          sourceRelativePath:
            "resources/02-018f7d72-7a2b-7f45-8a12-8e20b8426a76.bin",
          outputFileName: "attachment-03.bin",
          sizeBytes: 17,
          sha256: `sha256:${"c".repeat(64)}`,
          idempotencyKey: idempotencyKeys[2],
        },
      },
    ]);
    expect(result).toEqual({
      state: "FAILED",
      recipients: [{ name: "王伟", state: "FAILED" }],
      summary: { total: 1, succeeded: 0, failed: 1, unknown: 0 },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /ou_|resources\/|sha256|action|idempotency|fileKey|imageKey/,
    );

    await coordinator.execute(plan);
    expect(runBot).toHaveBeenCalledTimes(3);
    expect(
      new Set(deliveries().map((delivery) => delivery.actionId)).size,
    ).toBe(1);
  });

  it("dispatches one fixed Bot action per recipient and never resends terminal parts", async () => {
    const plan = planNotificationInstruction(
      TASK_ID,
      {
        recipientRefs: [REF_A, REF_B],
        content: { kind: "text", text: "请反馈。", wording: "composed" },
        attachmentRefs: [],
      },
      resolve,
    );
    const states = ["PENDING", "PENDING"] as Array<
      "PENDING" | "DISPATCHING" | "SUCCEEDED" | "FAILED" | "UNKNOWN"
    >;
    const ids = [randomUUID(), randomUUID()];
    let claimed = -1;
    const store = {
      createNotificationBatch: vi.fn(() => ({
        created: true,
        batch: {
          batchId: randomUUID(),
          taskId: TASK_ID,
          recipientCount: 2,
          state: "PREPARED",
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
          deliveries: states.map((state, index) => ({
            recipientOrdinal: index + 1,
            actionId: ids[index]!,
            part: {
              partId: ids[index]!,
              recipientOrdinal: index + 1,
              actionId: ids[index]!,
              partOrdinal: 1,
              partKind: "content",
              idempotencyKey: ids[index]!,
              state,
              attemptCount: state === "PENDING" ? 0 : 1,
              remoteId: null,
              result: null,
              createdAt: NOW.toISOString(),
              updatedAt: NOW.toISOString(),
            },
          })),
        },
      })),
      claimNextNotificationDelivery: vi.fn(() => {
        claimed = states.findIndex((state) => state === "PENDING");
        if (claimed < 0) return null;
        states[claimed] = "DISPATCHING";
        return {
          batchId: "018f7d72-7a2b-7f45-8a12-8e20b8426a50",
          recipientOrdinal: claimed + 1,
          leaseExpiresAt: "2026-07-30T08:01:00.000Z",
          action: {
            actionId: ids[claimed],
            version: 1,
          },
          part: {
            partId: ids[claimed],
            recipientOrdinal: claimed + 1,
            actionId: ids[claimed],
            partOrdinal: 1,
            partKind: "content",
            idempotencyKey: ids[claimed],
            state: "PENDING",
            attemptCount: 0,
            remoteId: null,
            result: null,
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
          },
        };
      }),
      markNotificationDeliveryDispatching: vi.fn((input) => ({
        action: {
          actionId: input.actionId,
          version: 1,
          leaseExpiresAt: input.leaseExpiresAt,
        },
        part: { state: "DISPATCHING" },
      })),
      finishNotificationDelivery: vi.fn((input) => {
        states[claimed] =
          input.outcome === "SUCCEEDED"
            ? "SUCCEEDED"
            : input.outcome === "FAILED_DEFINITE"
              ? "FAILED"
              : "UNKNOWN";
        return {
          action: { actionId: input.actionId, version: 1 },
          part: { state: states[claimed] },
          summary: {
            batchId: input.batchId,
            state: states.includes("UNKNOWN")
              ? "UNKNOWN"
              : states.includes("FAILED")
                ? "FAILED"
                : states.every((state) => state === "SUCCEEDED")
                  ? "SUCCEEDED"
                  : "DISPATCHING",
            total: 2,
            pending: states.filter((state) => state === "PENDING").length,
            dispatching: states.filter((state) => state === "DISPATCHING")
              .length,
            succeeded: states.filter((state) => state === "SUCCEEDED").length,
            failed: states.filter((state) => state === "FAILED").length,
            unknown: states.filter((state) => state === "UNKNOWN").length,
          },
        };
      }),
      getNotificationBatchSummary: vi.fn(() => ({
        batchId: "018f7d72-7a2b-7f45-8a12-8e20b8426a50",
        state: "SUCCEEDED",
        total: 2,
        pending: 0,
        dispatching: 0,
        succeeded: 2,
        failed: 0,
        unknown: 0,
      })),
    } as unknown as MvpNotificationBatchStore;
    const runBot = vi
      .fn<MvpLarkCliRunner["runBot"]>()
      .mockResolvedValueOnce({
        state: "SUCCEEDED",
        value: {
          ok: true,
          identity: "bot",
          data: { message_id: "om_message_a" },
        },
      })
      .mockResolvedValueOnce({
        state: "SUCCEEDED",
        value: {
          ok: true,
          identity: "bot",
          data: { message_id: "om_message_b" },
        },
      });
    const coordinator = createMvpNotificationCoordinator({
      store,
      runner: {
        runBot,
        async runUser() {
          throw new Error("user identity is forbidden");
        },
      },
      owner: "runtime-test",
      now: () => NOW,
    });

    const result = await coordinator.execute(plan);
    expect(runBot.mock.calls.map(([request]) => request)).toEqual([
      {
        version: 1,
        operation: "notification.send.text",
        payload: {
          recipientOpenId: "ou_a",
          text: "请反馈。",
          idempotencyKey: ids[0],
        },
      },
      {
        version: 1,
        operation: "notification.send.text",
        payload: {
          recipientOpenId: "ou_b",
          text: "请反馈。",
          idempotencyKey: ids[1],
        },
      },
    ]);
    expect(result).toEqual({
      state: "SUCCEEDED",
      recipients: [
        { name: "王伟", state: "SUCCEEDED" },
        { name: "李娜", state: "SUCCEEDED" },
      ],
      summary: { total: 2, succeeded: 2, failed: 0, unknown: 0 },
    });

    await coordinator.execute(plan);
    expect(runBot).toHaveBeenCalledTimes(2);
  });

  it("continues after UNKNOWN and never exposes IDs or argv", async () => {
    const plan = planNotificationInstruction(
      TASK_ID,
      {
        recipientRefs: [REF_A, REF_B],
        content: {
          kind: "display_card",
          title: "经营提醒",
          source: "总裁办公室",
          body: "请反馈。",
          items: [],
          wording: "composed",
        },
        attachmentRefs: [],
      },
      resolve,
    );
    const calls: unknown[] = [];
    const states = ["PENDING", "PENDING"];
    let index = 0;
    const batchId = randomUUID();
    const actionIds = [randomUUID(), randomUUID()];
    const store = {
      createNotificationBatch() {
        return {
          created: true,
          batch: {
            batchId,
            taskId: TASK_ID,
            recipientCount: 2,
            state: "PREPARED",
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
            deliveries: [],
          },
        };
      },
      claimNextNotificationDelivery() {
        while (index < states.length && states[index] !== "PENDING") index += 1;
        if (index >= states.length) return null;
        const ordinal = index + 1;
        states[index] = "DISPATCHING";
        return {
          batchId,
          recipientOrdinal: ordinal,
          leaseExpiresAt: "2026-07-30T08:01:00.000Z",
          action: {
            actionId: actionIds[index],
            version: 1,
          },
          part: {
            partId: actionIds[index],
            actionId: actionIds[index],
            recipientOrdinal: ordinal,
            partOrdinal: 1,
            partKind: "content",
            idempotencyKey: actionIds[index],
          },
        };
      },
      markNotificationDeliveryDispatching(input: unknown) {
        calls.push(input);
        return { action: {}, part: {} };
      },
      finishNotificationDelivery(input: {
        outcome: "SUCCEEDED" | "FAILED_DEFINITE" | "UNKNOWN";
      }) {
        states[index] =
          input.outcome === "FAILED_DEFINITE" ? "FAILED" : input.outcome;
        index += 1;
        return { action: {}, part: {}, summary: {} };
      },
      getNotificationBatchSummary() {
        return {
          batchId,
          state: "UNKNOWN",
          total: 2,
          pending: 0,
          dispatching: 0,
          succeeded: 1,
          failed: 0,
          unknown: 1,
        };
      },
    } as unknown as MvpNotificationBatchStore;
    const runBot = vi
      .fn<MvpLarkCliRunner["runBot"]>()
      .mockRejectedValueOnce(new Error("socket EPIPE"))
      .mockResolvedValueOnce({
        state: "SUCCEEDED",
        value: {
          ok: true,
          identity: "bot",
          data: { message_id: "om_message_b" },
        },
      });
    const coordinator = createMvpNotificationCoordinator({
      store,
      runner: { runBot, runUser: vi.fn() },
      owner: "runtime-test",
      now: () => NOW,
    });

    const result = await coordinator.execute(plan);
    expect(runBot).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      state: "UNKNOWN",
      recipients: [
        { name: "王伟", state: "UNKNOWN" },
        { name: "李娜", state: "SUCCEEDED" },
      ],
      summary: { total: 2, succeeded: 1, failed: 0, unknown: 1 },
    });
    expect(JSON.stringify(result)).not.toMatch(/ou_|--|message_|action/i);
    expect(calls).toHaveLength(2);
  });
});
