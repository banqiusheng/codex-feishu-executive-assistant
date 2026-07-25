import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readAcknowledgementMarker,
  writeAcknowledgementMarker,
} from "../src/acknowledgement-file.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function workspace(taskId = "task-fixture"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ack-marker-"));
  roots.push(root);
  const path = join(await realpath(root), taskId);
  await mkdir(path, { mode: 0o700 });
  return path;
}

describe("acknowledgement marker v2", () => {
  it("atomically creates an exact 0600 task-bound v2 marker", async () => {
    const path = await workspace();
    await writeAcknowledgementMarker(
      path,
      "task-fixture",
      new Date("2026-07-25T00:00:00.000Z"),
    );

    expect((await lstat(join(path, "acknowledged.json"))).mode & 0o777).toBe(
      0o600,
    );
    expect(await readFile(join(path, "acknowledged.json"), "utf8")).toBe(
      '{"acknowledgedAt":"2026-07-25T00:00:00.000Z","taskId":"task-fixture","version":2}\n',
    );
    await expect(
      readAcknowledgementMarker(path, "task-fixture", {
        allowLegacyV1: false,
      }),
    ).resolves.toEqual({
      version: 2,
      taskId: "task-fixture",
      acknowledgedAt: "2026-07-25T00:00:00.000Z",
    });
  });

  it("never overwrites an existing marker", async () => {
    const path = await workspace();
    await writeAcknowledgementMarker(
      path,
      "task-fixture",
      new Date("2026-07-25T00:00:00.000Z"),
    );
    await expect(
      writeAcknowledgementMarker(
        path,
        "task-fixture",
        new Date("2026-07-25T00:01:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(path, "acknowledged.json"), "utf8")).toContain(
      '"acknowledgedAt":"2026-07-25T00:00:00.000Z"',
    );
  });

  it.each([
    '{"version":2,"taskId":"task-fixture","acknowledgedAt":"2026-07-25T00:00:00.000Z","taskId":"other"}',
    '{"version":2,"taskId":"task-fixture","acknowledgedAt":"2026-07-25T00:00:00.000Z"} trailing',
    '{"version":2,"taskId":"other","acknowledgedAt":"2026-07-25T00:00:00.000Z"}',
    '{"version":2,"taskId":"task-fixture","acknowledgedAt":"2026-07-25T00:00:00Z"}',
    '{"version":2,"taskId":"task-fixture","acknowledgedAt":"2026-07-25T00:00:00.000Z","extra":true}',
  ])(
    "rejects malformed, mismatched, or non-canonical v2 evidence",
    async (text) => {
      const path = await workspace();
      await writeFile(join(path, "acknowledged.json"), text, { mode: 0o600 });
      await expect(
        readAcknowledgementMarker(path, "task-fixture", {
          allowLegacyV1: false,
        }),
      ).resolves.toBeNull();
    },
  );

  it("accepts v1 only when legacy recovery is explicitly enabled", async () => {
    const path = await workspace();
    await writeFile(
      join(path, "acknowledged.json"),
      '{"version":1,"acknowledgedAt":"2026-07-25T00:00:00.000Z"}\n',
      { mode: 0o600 },
    );
    await expect(
      readAcknowledgementMarker(path, "task-fixture", {
        allowLegacyV1: false,
      }),
    ).resolves.toBeNull();
    await expect(
      readAcknowledgementMarker(path, "task-fixture", {
        allowLegacyV1: true,
      }),
    ).resolves.toEqual({
      version: 1,
      acknowledgedAt: "2026-07-25T00:00:00.000Z",
    });
  });

  it("rejects fatal UTF-8 without exposing bytes", async () => {
    const path = await workspace();
    await writeFile(
      join(path, "acknowledged.json"),
      Buffer.from([0x7b, 0xff, 0x7d]),
      { mode: 0o600 },
    );
    await expect(
      readAcknowledgementMarker(path, "task-fixture", {
        allowLegacyV1: false,
      }),
    ).resolves.toBeNull();
  });
});
