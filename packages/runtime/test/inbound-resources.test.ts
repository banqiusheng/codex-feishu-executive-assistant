import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ResolvedTaskResource,
  TaskResourceDescriptor,
  TaskResourceKind,
  TaskResourceSummary,
} from "@executive-assistant/job-store";
import { afterEach, describe, expect, it } from "vitest";

import { stageInboundResources } from "../src/inbound-resources.js";
import type {
  RuntimeDownloadResourceRequest,
  RuntimeQuotedMessage,
  RuntimeQuotedMessageRequest,
} from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "runtime-inbound-resources-"),
  );
  roots.push(root);
  const path = join(root, "task");
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

function bytes(value: string): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield Buffer.from(value, "utf8");
  })();
}

class FakeResourceStore {
  readonly registerCalls: Array<{
    taskId: string;
    descriptors: readonly TaskResourceDescriptor[];
    now: Date;
  }> = [];
  readonly resolveCalls: Array<{
    taskId: string;
    resourceRef: string;
    expectedKind?: TaskResourceKind;
  }> = [];
  readonly listCalls: string[] = [];
  registerFailure: Error | undefined;
  #resolved = new Map<string, ResolvedTaskResource>();

  registerTaskResourcesForTask(
    taskId: string,
    descriptors: readonly TaskResourceDescriptor[],
    now: Date,
  ): readonly TaskResourceSummary[] {
    this.registerCalls.push({ taskId, descriptors, now });
    if (this.registerFailure) throw this.registerFailure;
    return Object.freeze(
      descriptors.map((descriptor) => {
        const resourceRef = randomUUID();
        this.#resolved.set(
          resourceRef,
          Object.freeze({
            resourceRef,
            ...descriptor,
          }),
        );
        return Object.freeze({
          resourceRef,
          kind: descriptor.kind,
          displayName: descriptor.displayName,
          sizeBytes: descriptor.sizeBytes,
        });
      }),
    );
  }

  resolveTaskResourceForTask(
    taskId: string,
    resourceRef: string,
    expectedKind?: TaskResourceKind,
  ): ResolvedTaskResource {
    this.resolveCalls.push({
      taskId,
      resourceRef,
      ...(expectedKind === undefined ? {} : { expectedKind }),
    });
    const resolved = this.#resolved.get(resourceRef);
    if (!resolved || (expectedKind && expectedKind !== resolved.kind)) {
      throw new Error("fixture resource not found");
    }
    return resolved;
  }

  listTaskResourcesForTask(taskId: string): readonly ResolvedTaskResource[] {
    this.listCalls.push(taskId);
    return Object.freeze([...this.#resolved.values()]);
  }
}

class FakeResourceTransport {
  readonly readCalls: RuntimeQuotedMessageRequest[] = [];
  readonly downloadCalls: RuntimeDownloadResourceRequest[] = [];
  quotedMessage: RuntimeQuotedMessage | null = null;
  downloads = new Map<string, () => AsyncIterable<Uint8Array>>();

  async readQuotedMessage(
    request: RuntimeQuotedMessageRequest,
  ): Promise<RuntimeQuotedMessage | null> {
    this.readCalls.push(request);
    return this.quotedMessage;
  }

  async downloadResource(
    request: RuntimeDownloadResourceRequest,
  ): Promise<AsyncIterable<Uint8Array>> {
    this.downloadCalls.push(request);
    const key = request.kind === "image" ? request.imageKey : request.fileKey;
    const create = this.downloads.get(key);
    if (!create) throw new Error("fixture download missing");
    return create();
  }
}

function request(
  taskWorkspace: string,
  patch: Readonly<Record<string, unknown>> = {},
) {
  return {
    taskId: randomUUID(),
    taskWorkspace,
    currentMessageId: "om_current_message",
    currentInstructionText: "请把引用报告原话转发给财务负责人",
    currentResources: Object.freeze([
      Object.freeze({
        sourceKind: "current" as const,
        messageId: "om_current_message",
        kind: "image" as const,
        imageKey: "img_current",
        displayName: "../../董事会现场.png",
      }),
    ]),
    quotedCandidate: Object.freeze({ parentId: "om_quoted_message" }),
    presidentChatId: "oc_paired_president_dm",
    presidentOpenId: "ou_paired_president",
    now: new Date("2026-07-30T03:00:00.000Z"),
    ...patch,
  };
}

describe("inbound resource staging", () => {
  it("recovers an owned empty resource directory left by a crash before registration", async () => {
    const taskWorkspace = await workspace();
    const resourcesPath = join(taskWorkspace, "resources");
    await mkdir(resourcesPath, { mode: 0o700 });
    await chmod(resourcesPath, 0o700);
    const transport = new FakeResourceTransport();
    transport.quotedMessage = null;
    transport.downloads.set("img_current", () => bytes("image-current"));
    const store = new FakeResourceStore();

    const result = await stageInboundResources(
      Object.freeze({ transport, store }),
      request(taskWorkspace, { quotedCandidate: null }),
    );

    expect(result.attachments).toHaveLength(1);
    expect(store.registerCalls).toHaveLength(1);
    expect(transport.downloadCalls).toHaveLength(1);
    expect((await lstat(resourcesPath)).mode & 0o777).toBe(0o700);
  });

  it("cleans only valid internal partial files left by a mid-download crash", async () => {
    const taskWorkspace = await workspace();
    const resourcesPath = join(taskWorkspace, "resources");
    await mkdir(resourcesPath, { mode: 0o700 });
    await chmod(resourcesPath, 0o700);
    await writeFile(
      join(resourcesPath, `00-${randomUUID()}.txt`),
      "partial-current-text",
      { mode: 0o600 },
    );
    await writeFile(
      join(resourcesPath, `01-${randomUUID()}.bin`),
      "partial-attachment",
      { mode: 0o600 },
    );
    const transport = new FakeResourceTransport();
    transport.quotedMessage = null;
    transport.downloads.set("img_current", () => bytes("image-current"));
    const store = new FakeResourceStore();

    const result = await stageInboundResources(
      Object.freeze({ transport, store }),
      request(taskWorkspace, { quotedCandidate: null }),
    );

    expect(result.attachments).toHaveLength(1);
    expect(store.registerCalls).toHaveLength(1);
    const names = await readdir(resourcesPath);
    expect(names).toHaveLength(2);
    expect(
      names.every((name) => /^(?:00|01)-[0-9a-f-]+\.(?:txt|bin)$/.test(name)),
    ).toBe(true);
  });

  it("reuses a fully registered resource ledger after a crash before READY input", async () => {
    const taskWorkspace = await workspace();
    const transport = new FakeResourceTransport();
    transport.quotedMessage = null;
    transport.downloads.set("img_current", () => bytes("image-current"));
    const store = new FakeResourceStore();
    const input = request(taskWorkspace, { quotedCandidate: null });
    const first = await stageInboundResources(
      Object.freeze({ transport, store }),
      input,
    );
    const downloadCount = transport.downloadCalls.length;
    const registerCount = store.registerCalls.length;

    const recovered = await stageInboundResources(
      Object.freeze({ transport, store }),
      input,
    );

    expect(recovered).toEqual(first);
    expect(transport.downloadCalls).toHaveLength(downloadCount);
    expect(store.registerCalls).toHaveLength(registerCount);
    expect(store.listCalls).toContain(input.taskId);
  });

  it("does not delete or reuse an unexpected pre-existing resource directory", async () => {
    const taskWorkspace = await workspace();
    const resourcesPath = join(taskWorkspace, "resources");
    await mkdir(resourcesPath, { mode: 0o700 });
    await writeFile(join(resourcesPath, "user-owned.txt"), "do not remove", {
      mode: 0o600,
    });
    const transport = new FakeResourceTransport();
    transport.quotedMessage = null;
    transport.downloads.set("img_current", () => bytes("image-current"));
    const store = new FakeResourceStore();

    await expect(
      stageInboundResources(
        Object.freeze({ transport, store }),
        request(taskWorkspace, { quotedCandidate: null }),
      ),
    ).rejects.toThrow(/INBOUND_RESOURCE_STAGING_FAILED/);

    await expect(
      readFile(join(resourcesPath, "user-owned.txt"), "utf8"),
    ).resolves.toBe("do not remove");
    expect(store.registerCalls).toEqual([]);
    expect(transport.downloadCalls).toEqual([]);
  });

  it("downloads only current and reverified quoted resources, writes private evidence, and exposes opaque summaries", async () => {
    const taskWorkspace = await workspace();
    const transport = new FakeResourceTransport();
    transport.quotedMessage = Object.freeze({
      messageId: "om_quoted_message",
      chatId: "oc_paired_president_dm",
      senderOpenId: "ou_paired_president",
      text: "经营报告原文：本月收入增长 12%。",
      resources: Object.freeze([
        Object.freeze({
          kind: "file" as const,
          fileKey: "file_quoted",
          displayName: "../经营报告.pdf",
        }),
      ]),
    });
    transport.downloads.set("img_current", () => bytes("image-current"));
    transport.downloads.set("file_quoted", () => bytes("file-quoted"));
    const store = new FakeResourceStore();

    const result = await stageInboundResources(
      Object.freeze({ transport, store }),
      request(taskWorkspace),
    );

    expect(transport.readCalls).toEqual([{ messageId: "om_quoted_message" }]);
    expect(transport.downloadCalls).toEqual([
      {
        messageId: "om_current_message",
        kind: "image",
        imageKey: "img_current",
      },
      {
        messageId: "om_quoted_message",
        kind: "file",
        fileKey: "file_quoted",
      },
    ]);
    expect(store.registerCalls).toHaveLength(1);
    const descriptors = store.registerCalls[0]?.descriptors ?? [];
    expect(descriptors).toHaveLength(4);
    expect(
      descriptors.map(({ sourceKind, kind, displayName }) => ({
        sourceKind,
        kind,
        displayName,
      })),
    ).toEqual([
      {
        sourceKind: "current",
        kind: "text",
        displayName: "当前指令.txt",
      },
      {
        sourceKind: "current",
        kind: "image",
        displayName: "../../董事会现场.png",
      },
      {
        sourceKind: "quoted",
        kind: "text",
        displayName: "引用消息.txt",
      },
      {
        sourceKind: "quoted",
        kind: "file",
        displayName: "../经营报告.pdf",
      },
    ]);
    expect(
      descriptors.every(
        ({ relativePath }) =>
          /^resources\/[0-9]{2}-[0-9a-f-]+\.(?:txt|bin)$/.test(relativePath) &&
          !relativePath.includes("董事会") &&
          !relativePath.includes("经营报告") &&
          !relativePath.includes(".."),
      ),
    ).toBe(true);
    expect((await lstat(join(taskWorkspace, "resources"))).mode & 0o777).toBe(
      0o700,
    );
    for (const descriptor of descriptors) {
      const path = join(taskWorkspace, descriptor.relativePath);
      const metadata = await lstat(path);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.isSymbolicLink()).toBe(false);
      expect(metadata.nlink).toBe(1);
      expect(metadata.mode & 0o777).toBe(0o600);
    }
    const evidence = await Promise.all(
      descriptors.map(({ relativePath }) =>
        readFile(join(taskWorkspace, relativePath), "utf8"),
      ),
    );
    expect(evidence).toEqual([
      "请把引用报告原话转发给财务负责人",
      "image-current",
      "经营报告原文：本月收入增长 12%。",
      "file-quoted",
    ]);
    expect(store.resolveCalls).toHaveLength(4);
    expect(result.currentTextRef).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(result.quotedTextRef).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(result.attachments).toHaveLength(2);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.attachments)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /file_quoted|img_current|resources\/|经营报告原文|currentInstructionText|messageId|parentId/,
    );
  });

  it.each([
    {
      label: "a different chat",
      quoted: {
        messageId: "om_quoted_message",
        chatId: "oc_other_chat",
        senderOpenId: "ou_paired_president",
        text: "forbidden",
        resources: [],
      },
    },
    {
      label: "a different author",
      quoted: {
        messageId: "om_quoted_message",
        chatId: "oc_paired_president_dm",
        senderOpenId: "ou_other_author",
        text: "forbidden",
        resources: [],
      },
    },
    {
      label: "a substituted message id",
      quoted: {
        messageId: "om_substituted",
        chatId: "oc_paired_president_dm",
        senderOpenId: "ou_paired_president",
        text: "forbidden",
        resources: [],
      },
    },
  ])(
    "fails closed before download or registration when the quote belongs to $label",
    async ({ quoted }) => {
      const taskWorkspace = await workspace();
      const transport = new FakeResourceTransport();
      transport.quotedMessage = Object.freeze({
        ...quoted,
        resources: Object.freeze(quoted.resources),
      });
      transport.downloads.set("img_current", () => bytes("must-not-download"));
      const store = new FakeResourceStore();

      await expect(
        stageInboundResources(
          Object.freeze({ transport, store }),
          request(taskWorkspace),
        ),
      ).rejects.toThrow(/INBOUND_RESOURCE_QUOTE_INVALID/);

      expect(transport.downloadCalls).toEqual([]);
      expect(store.registerCalls).toEqual([]);
      await expect(
        lstat(join(taskWorkspace, "resources")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("cleans every partial file and registers nothing when a download fails", async () => {
    const taskWorkspace = await workspace();
    const transport = new FakeResourceTransport();
    transport.quotedMessage = Object.freeze({
      messageId: "om_quoted_message",
      chatId: "oc_paired_president_dm",
      senderOpenId: "ou_paired_president",
      text: "引用正文",
      resources: Object.freeze([]),
    });
    transport.downloads.set("img_current", () =>
      (async function* () {
        yield Buffer.from("partial", "utf8");
        throw new Error("synthetic transport failure");
      })(),
    );
    const store = new FakeResourceStore();

    await expect(
      stageInboundResources(
        Object.freeze({ transport, store }),
        request(taskWorkspace),
      ),
    ).rejects.toThrow(/INBOUND_RESOURCE_STAGING_FAILED/);

    expect(store.registerCalls).toEqual([]);
    await expect(lstat(join(taskWorkspace, "resources"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("rejects more than twenty total evidence files before any download or registration", async () => {
    const taskWorkspace = await workspace();
    const transport = new FakeResourceTransport();
    const store = new FakeResourceStore();
    const currentResources = Object.freeze(
      Array.from({ length: 20 }, (_, index) =>
        Object.freeze({
          sourceKind: "current" as const,
          messageId: "om_current_message",
          kind: "file" as const,
          fileKey: `file_limit_${index}`,
          displayName: `附件-${index}.bin`,
        }),
      ),
    );

    await expect(
      stageInboundResources(
        Object.freeze({ transport, store }),
        request(taskWorkspace, {
          currentResources,
          quotedCandidate: null,
        }),
      ),
    ).rejects.toThrow(/INBOUND_RESOURCE_LIMIT_EXCEEDED/);

    expect(transport.downloadCalls).toEqual([]);
    expect(store.registerCalls).toEqual([]);
    await expect(lstat(join(taskWorkspace, "resources"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("bounds a streamed file at one hundred MiB and removes the partial", async () => {
    const taskWorkspace = await workspace();
    const transport = new FakeResourceTransport();
    const oneMiB = Buffer.alloc(1024 * 1024, 0x61);
    transport.downloads.set("img_current", () =>
      (async function* () {
        for (let index = 0; index < 101; index += 1) yield oneMiB;
      })(),
    );
    const store = new FakeResourceStore();

    await expect(
      stageInboundResources(
        Object.freeze({ transport, store }),
        request(taskWorkspace, { quotedCandidate: null }),
      ),
    ).rejects.toThrow(/INBOUND_RESOURCE_STAGING_FAILED/);

    expect(store.registerCalls).toEqual([]);
    await expect(lstat(join(taskWorkspace, "resources"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("bounds the combined streamed evidence at two hundred MiB", async () => {
    const taskWorkspace = await workspace();
    const transport = new FakeResourceTransport();
    const oneMiB = Buffer.alloc(1024 * 1024, 0x62);
    const oneHundredMiB = () =>
      (async function* () {
        for (let index = 0; index < 100; index += 1) yield oneMiB;
      })();
    transport.downloads.set("file_total_a", oneHundredMiB);
    transport.downloads.set("file_total_b", oneHundredMiB);
    const store = new FakeResourceStore();
    const currentResources = Object.freeze([
      Object.freeze({
        sourceKind: "current" as const,
        messageId: "om_current_message",
        kind: "file" as const,
        fileKey: "file_total_a",
        displayName: "总量-A.bin",
      }),
      Object.freeze({
        sourceKind: "current" as const,
        messageId: "om_current_message",
        kind: "file" as const,
        fileKey: "file_total_b",
        displayName: "总量-B.bin",
      }),
    ]);

    await expect(
      stageInboundResources(
        Object.freeze({ transport, store }),
        request(taskWorkspace, {
          currentResources,
          quotedCandidate: null,
        }),
      ),
    ).rejects.toThrow(/INBOUND_RESOURCE_STAGING_FAILED/);

    expect(transport.downloadCalls).toHaveLength(2);
    expect(store.registerCalls).toEqual([]);
    await expect(lstat(join(taskWorkspace, "resources"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it.each(["hardlink", "symlink"] as const)(
    "detects a %s replacement race before registration",
    async (raceKind) => {
      const taskWorkspace = await workspace();
      const outside = join(taskWorkspace, "..", `${raceKind}-outside.bin`);
      const transport = new FakeResourceTransport();
      transport.quotedMessage = null;
      transport.downloads.set("img_current", () =>
        (async function* () {
          yield Buffer.from("first", "utf8");
          const resourceDirectory = join(taskWorkspace, "resources");
          const attachment = (await readdir(resourceDirectory))
            .map((name) => join(resourceDirectory, name))
            .find((path) => path.endsWith(".bin"));
          if (!attachment) throw new Error("fixture attachment missing");
          if (raceKind === "hardlink") {
            await link(attachment, outside);
          } else {
            await rm(attachment);
            await symlink(outside, attachment);
          }
          yield Buffer.from("second", "utf8");
        })(),
      );
      const store = new FakeResourceStore();

      await expect(
        stageInboundResources(
          Object.freeze({ transport, store }),
          request(taskWorkspace, { quotedCandidate: null }),
        ),
      ).rejects.toThrow(/INBOUND_RESOURCE_STAGING_FAILED/);

      expect(store.registerCalls).toEqual([]);
      await expect(
        lstat(join(taskWorkspace, "resources")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["content", "hardlink", "replacement"] as const)(
    "revalidates the whole batch and rejects an earlier-file %s mutation during a later download",
    async (mutation) => {
      const taskWorkspace = await workspace();
      const outside = join(taskWorkspace, "..", `${mutation}-outside.bin`);
      const transport = new FakeResourceTransport();
      transport.quotedMessage = null;
      transport.downloads.set("file_first", () => bytes("first-original"));
      transport.downloads.set("file_second", () =>
        (async function* () {
          const resourceDirectory = join(taskWorkspace, "resources");
          const earlier = (await readdir(resourceDirectory))
            .map((name) => join(resourceDirectory, name))
            .find((path) => path.includes("/01-") && path.endsWith(".bin"));
          if (!earlier) throw new Error("fixture earlier resource missing");
          if (mutation === "content") {
            await writeFile(earlier, "first-tampered", { mode: 0o600 });
          } else if (mutation === "hardlink") {
            await link(earlier, outside);
          } else {
            await rm(earlier);
            await writeFile(earlier, "first-replaced", { mode: 0o600 });
          }
          yield Buffer.from("second", "utf8");
        })(),
      );
      const store = new FakeResourceStore();
      const currentResources = Object.freeze([
        Object.freeze({
          sourceKind: "current" as const,
          messageId: "om_current_message",
          kind: "file" as const,
          fileKey: "file_first",
          displayName: "第一份.bin",
        }),
        Object.freeze({
          sourceKind: "current" as const,
          messageId: "om_current_message",
          kind: "file" as const,
          fileKey: "file_second",
          displayName: "第二份.bin",
        }),
      ]);

      await expect(
        stageInboundResources(
          Object.freeze({ transport, store }),
          request(taskWorkspace, {
            currentResources,
            quotedCandidate: null,
          }),
        ),
      ).rejects.toThrow(/INBOUND_RESOURCE_STAGING_FAILED/);

      expect(transport.downloadCalls).toHaveLength(2);
      expect(store.registerCalls).toEqual([]);
      await expect(
        lstat(join(taskWorkspace, "resources")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("removes all staged files when the atomic store registration rejects", async () => {
    const taskWorkspace = await workspace();
    const transport = new FakeResourceTransport();
    transport.quotedMessage = null;
    transport.downloads.set("img_current", () => bytes("image-current"));
    const store = new FakeResourceStore();
    store.registerFailure = new Error("synthetic registration failure");

    await expect(
      stageInboundResources(
        Object.freeze({ transport, store }),
        request(taskWorkspace, { quotedCandidate: null }),
      ),
    ).rejects.toThrow(/INBOUND_RESOURCE_STAGING_FAILED/);

    expect(store.registerCalls).toHaveLength(1);
    expect(store.resolveCalls).toEqual([]);
    await expect(lstat(join(taskWorkspace, "resources"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });
});
