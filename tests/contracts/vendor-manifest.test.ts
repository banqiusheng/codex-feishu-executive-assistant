import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const manifestTool = resolve("scripts/bridge-vendor-manifest.mjs");
const temporaryRoots: string[] = [];

function makeRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `bridge-manifest-${name}-`));
  temporaryRoots.push(root);
  return root;
}

function write(root: string, path: string, content: string): void {
  const segments = path.split("/");
  segments.pop();
  mkdirSync(join(root, ...segments), { recursive: true });
  writeFileSync(join(root, path), content);
}

function compare(expected: string, actual: string) {
  return spawnSync(
    process.execPath,
    [manifestTool, "compare", expected, actual],
    { encoding: "utf8" },
  );
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("strict bridge vendor manifest", () => {
  it("ignores only top-level dist and node_modules directories", () => {
    const expected = makeRoot("ignored-expected");
    const actual = makeRoot("ignored-actual");
    write(expected, "src/index.ts", "same\n");
    write(actual, "src/index.ts", "same\n");
    write(expected, "dist/output.js", "expected\n");
    write(actual, "dist/output.js", "actual\n");
    write(expected, "node_modules/pkg/index.js", "expected\n");
    write(actual, "node_modules/pkg/index.js", "actual\n");

    const result = compare(expected, actual);
    expect(result.status, result.stderr).toBe(0);
  });

  it("detects differences inside nested src/dist", () => {
    const expected = makeRoot("nested-expected");
    const actual = makeRoot("nested-actual");
    write(expected, "src/dist/output.js", "expected\n");
    write(actual, "src/dist/output.js", "actual\n");

    const result = compare(expected, actual);
    expect(result.status).toBe(73);
  });

  it("detects a directory replaced by a symlink without following it", () => {
    const expected = makeRoot("directory-expected");
    const actual = makeRoot("symlink-actual");
    const externalTarget = makeRoot("symlink-external-target");
    write(expected, "src/cache/value.txt", "same\n");
    mkdirSync(join(actual, "src"), { recursive: true });
    write(externalTarget, "value.txt", "same\n");
    symlinkSync(externalTarget, join(actual, "src/cache"));

    const result = compare(expected, actual);
    expect(result.status).toBe(73);
  });

  it("detects a regular file mode change from 0644 to 0755", () => {
    const expected = makeRoot("mode-expected");
    const actual = makeRoot("mode-actual");
    write(expected, "script.mjs", "same\n");
    write(actual, "script.mjs", "same\n");
    chmodSync(join(expected, "script.mjs"), 0o644);
    chmodSync(join(actual, "script.mjs"), 0o755);

    const result = compare(expected, actual);
    expect(result.status).toBe(73);
  });

  it("rejects a symlink target root", () => {
    const expected = makeRoot("root-expected");
    const actualParent = makeRoot("root-symlink-parent");
    const actual = join(actualParent, "bridge");
    write(expected, "src/index.ts", "same\n");
    symlinkSync(expected, actual);

    const result = compare(expected, actual);
    expect(result.status).toBe(73);
  });

  it("rejects Git metadata in the target root", () => {
    const expected = makeRoot("git-expected");
    const actual = makeRoot("git-actual");
    write(expected, "src/index.ts", "same\n");
    write(actual, "src/index.ts", "same\n");
    mkdirSync(join(actual, ".git"));

    const result = compare(expected, actual);
    expect(result.status).toBe(73);
  });
});
