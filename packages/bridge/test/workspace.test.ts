import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveTaskWorkspace } from "../src/security/workspace.js";

const TASK_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a21";
const OTHER_TASK_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a22";
const created: string[] = [];

async function fixtureRoot(): Promise<string> {
  const fixture = await temporaryDirectory("assistant-workspace-");
  created.push(fixture);
  const root = join(fixture, "jobs");
  await mkdir(root, { mode: 0o700 });
  return root;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(await realpath(tmpdir()), prefix));
}

async function taskDirectory(root: string, taskId = TASK_ID): Promise<string> {
  const candidate = join(root, taskId);
  await mkdir(candidate, { mode: 0o700 });
  await chmod(candidate, 0o700);
  return candidate;
}

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("resolveTaskWorkspace", () => {
  it("returns the real path of the one 0700 task directory derived from the UUID", async () => {
    const root = await fixtureRoot();
    const candidate = await taskDirectory(root);

    await expect(resolveTaskWorkspace(root, TASK_ID)).resolves.toBe(candidate);
  });

  it.each([
    "..",
    ".",
    "",
    "018f7d72-7a2b-7f45-8a12-8e20b8426a2",
    "018F7D72-7A2B-7F45-8A12-8E20B8426A21",
    "00000000-0000-0000-0000-000000000000",
    `${TASK_ID}/nested`,
  ])("rejects a non-canonical task id: %s", async (taskId) => {
    const root = await fixtureRoot();

    await expect(resolveTaskWorkspace(root, taskId)).rejects.toThrow(
      "invalid task id",
    );
  });

  it("rejects a relative root", async () => {
    await expect(
      resolveTaskWorkspace("relative/jobs", TASK_ID),
    ).rejects.toThrow("workspace root must be an absolute path");
  });

  it("rejects a root path containing NUL", async () => {
    await expect(
      resolveTaskWorkspace("/tmp/jobs\0escape", TASK_ID),
    ).rejects.toThrow("workspace root contains invalid characters");
  });

  it("rejects a missing root", async () => {
    const fixture = await temporaryDirectory("assistant-workspace-missing-");
    created.push(fixture);

    await expect(
      resolveTaskWorkspace(join(fixture, "missing"), TASK_ID),
    ).rejects.toThrow("workspace root does not exist");
  });

  it("rejects a root that is a file", async () => {
    const fixture = await temporaryDirectory("assistant-workspace-file-root-");
    created.push(fixture);
    const root = join(fixture, "jobs");
    await writeFile(root, "not a directory");

    await expect(resolveTaskWorkspace(root, TASK_ID)).rejects.toThrow(
      "workspace root must be a directory",
    );
  });

  it("rejects a missing task directory and does not create it", async () => {
    const root = await fixtureRoot();

    await expect(resolveTaskWorkspace(root, TASK_ID)).rejects.toThrow(
      "task workspace does not exist",
    );
  });

  it("rejects root directory permissions broader than 0700", async () => {
    const root = await fixtureRoot();
    await chmod(root, 0o755);

    await expect(resolveTaskWorkspace(root, TASK_ID)).rejects.toThrow(
      "workspace root permissions must be 0700",
    );
  });

  it("rejects a task path that is a file", async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, TASK_ID), "not a directory");

    await expect(resolveTaskWorkspace(root, TASK_ID)).rejects.toThrow(
      "task workspace must be a directory",
    );
  });

  it.each([0o755, 0o750, 0o770, 0o777])(
    "rejects task directory permissions %s instead of 0700",
    async (mode) => {
      const root = await fixtureRoot();
      const candidate = await taskDirectory(root);
      await chmod(candidate, mode);

      await expect(resolveTaskWorkspace(root, TASK_ID)).rejects.toThrow(
        "task workspace permissions must be 0700",
      );
    },
  );

  it("rejects the task path when it is a symlink outside the root", async () => {
    const root = await fixtureRoot();
    const outside = join(root, "..", "outside");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(root, TASK_ID));

    await expect(resolveTaskWorkspace(root, TASK_ID)).rejects.toThrow(
      "task workspace must not be a symlink",
    );
  });

  it("rejects the task path when it is a symlink to another directory inside the root", async () => {
    const root = await fixtureRoot();
    await taskDirectory(root, OTHER_TASK_ID);
    await symlink(join(root, OTHER_TASK_ID), join(root, TASK_ID));

    await expect(resolveTaskWorkspace(root, TASK_ID)).rejects.toThrow(
      "task workspace must not be a symlink",
    );
  });

  it("rejects the root when the root itself is a symlink", async () => {
    const fixture = await temporaryDirectory("assistant-workspace-root-link-");
    created.push(fixture);
    const realRoot = join(fixture, "real-jobs");
    const linkedRoot = join(fixture, "jobs");
    await mkdir(realRoot, { mode: 0o700 });
    await taskDirectory(realRoot);
    await symlink(realRoot, linkedRoot);

    await expect(resolveTaskWorkspace(linkedRoot, TASK_ID)).rejects.toThrow(
      "workspace root must not contain symlinks",
    );
  });

  it("rejects a root reached through a symlinked parent component", async () => {
    const fixture = await temporaryDirectory(
      "assistant-workspace-parent-link-",
    );
    created.push(fixture);
    const realParent = join(fixture, "real-parent");
    const linkedParent = join(fixture, "linked-parent");
    const realRoot = join(realParent, "jobs");
    await mkdir(realRoot, { recursive: true, mode: 0o700 });
    await taskDirectory(realRoot);
    await symlink(realParent, linkedParent);

    await expect(
      resolveTaskWorkspace(join(linkedParent, "jobs"), TASK_ID),
    ).rejects.toThrow("workspace root must not contain symlinks");
  });
});
