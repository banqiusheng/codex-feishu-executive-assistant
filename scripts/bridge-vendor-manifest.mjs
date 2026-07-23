#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const FAIL_CLOSED_EXIT = 73;
const TOP_LEVEL_GENERATED_DIRECTORIES = new Set(["dist", "node_modules"]);

class ManifestIntegrityError extends Error {}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function hash(algorithm, content) {
  return createHash(algorithm).update(content).digest();
}

function hashHex(algorithm, content) {
  return hash(algorithm, content).toString("hex");
}

function gitObjectHash(type, content) {
  const header = Buffer.from(`${type} ${content.length}\0`, "utf8");
  return hash("sha1", Buffer.concat([header, content]));
}

function permissionMode(stat) {
  return (stat.mode & 0o777).toString(8).padStart(4, "0");
}

function gitSortKey(entry) {
  return `${entry.name}${entry.stat.isDirectory() ? "/" : ""}`;
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function scanDirectory(root, relativeDirectory, isRoot) {
  const absoluteDirectory = relativeDirectory
    ? join(root, relativeDirectory)
    : root;
  const names = await readdir(absoluteDirectory);
  const children = [];

  for (const name of names) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${name}`
      : name;
    const stat = await lstat(join(root, relativePath));

    if (name === ".git") {
      throw new ManifestIntegrityError(
        `Git metadata is forbidden in a vendored tree: ${relativePath}`,
      );
    }
    if (
      isRoot &&
      TOP_LEVEL_GENERATED_DIRECTORIES.has(name) &&
      stat.isDirectory()
    ) {
      continue;
    }
    children.push({ name, relativePath, stat });
  }

  children.sort((left, right) =>
    byteCompare(gitSortKey(left), gitSortKey(right)),
  );

  const manifestEntries = [];
  const gitTreeEntries = [];

  for (const child of children) {
    const { name, relativePath, stat } = child;
    const absolutePath = join(root, relativePath);
    let gitMode;
    let gitObjectId;

    if (stat.isDirectory()) {
      const nested = await scanDirectory(root, relativePath, false);
      manifestEntries.push({
        path: relativePath,
        type: "directory",
        mode: permissionMode(stat),
        executable: false,
        size: 0,
        symlinkTarget: null,
        contentSha256: null,
      });
      manifestEntries.push(...nested.manifestEntries);
      gitMode = "40000";
      gitObjectId = nested.gitTreeObjectId;
    } else if (stat.isFile()) {
      const content = await readFile(absolutePath);
      const executable = (stat.mode & 0o111) !== 0;
      manifestEntries.push({
        path: relativePath,
        type: "file",
        mode: permissionMode(stat),
        executable,
        size: stat.size,
        symlinkTarget: null,
        contentSha256: hashHex("sha256", content),
      });
      gitMode = executable ? "100755" : "100644";
      gitObjectId = gitObjectHash("blob", content);
    } else if (stat.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      const content = Buffer.from(target, "utf8");
      manifestEntries.push({
        path: relativePath,
        type: "symlink",
        mode: permissionMode(stat),
        executable: false,
        size: content.length,
        symlinkTarget: target,
        contentSha256: hashHex("sha256", content),
      });
      gitMode = "120000";
      gitObjectId = gitObjectHash("blob", content);
    } else {
      throw new ManifestIntegrityError(
        `Unsupported filesystem entry in vendored tree: ${relativePath}`,
      );
    }

    gitTreeEntries.push(
      Buffer.concat([Buffer.from(`${gitMode} ${name}\0`, "utf8"), gitObjectId]),
    );
  }

  const gitTreeContent = Buffer.concat(gitTreeEntries);
  return {
    manifestEntries,
    gitTreeObjectId: gitObjectHash("tree", gitTreeContent),
  };
}

export async function createStrictManifest(rootPath) {
  const root = resolve(rootPath);
  const rootStat = await lstat(root);

  if (rootStat.isSymbolicLink()) {
    throw new ManifestIntegrityError(
      `Vendored tree root must not be a symlink: ${root}`,
    );
  }
  if (!rootStat.isDirectory()) {
    throw new ManifestIntegrityError(
      `Vendored tree root must be a directory: ${root}`,
    );
  }
  if ((await lstatOrNull(join(root, ".git"))) !== null) {
    throw new ManifestIntegrityError(
      `Git metadata is forbidden in a vendored tree: ${join(root, ".git")}`,
    );
  }

  const scanned = await scanDirectory(root, "", true);
  const entries = scanned.manifestEntries.sort((left, right) =>
    byteCompare(left.path, right.path),
  );
  const canonicalManifest = `${entries
    .map((entry) => JSON.stringify(entry))
    .join("\n")}\n`;

  return {
    schemaVersion: 1,
    gitTreeSha: scanned.gitTreeObjectId.toString("hex"),
    strictManifestSha256: hashHex("sha256", canonicalManifest),
    entries,
  };
}

function describeDifference(expected, actual) {
  const count = Math.max(expected.entries.length, actual.entries.length);
  for (let index = 0; index < count; index += 1) {
    const expectedEntry = expected.entries[index] ?? null;
    const actualEntry = actual.entries[index] ?? null;
    if (JSON.stringify(expectedEntry) !== JSON.stringify(actualEntry)) {
      return `first mismatch at entry ${index}: expected ${JSON.stringify(expectedEntry)}, actual ${JSON.stringify(actualEntry)}`;
    }
  }
  return "manifest digests differ";
}

export async function compareStrictManifests(expectedPath, actualPath) {
  const expected = await createStrictManifest(expectedPath);
  const actual = await createStrictManifest(actualPath);

  if (
    expected.strictManifestSha256 !== actual.strictManifestSha256 ||
    expected.gitTreeSha !== actual.gitTreeSha
  ) {
    throw new ManifestIntegrityError(describeDifference(expected, actual));
  }
  return actual;
}

async function runCli() {
  const [command, ...args] = process.argv.slice(2);

  if (command === "manifest" && args.length === 1) {
    process.stdout.write(
      `${JSON.stringify(await createStrictManifest(args[0]))}\n`,
    );
    return;
  }
  if (command === "summary" && args.length === 1) {
    const manifest = await createStrictManifest(args[0]);
    process.stdout.write(
      `${JSON.stringify({
        gitTreeSha: manifest.gitTreeSha,
        strictManifestSha256: manifest.strictManifestSha256,
      })}\n`,
    );
    return;
  }
  if (command === "compare" && args.length === 2) {
    const manifest = await compareStrictManifests(args[0], args[1]);
    process.stdout.write(
      `${JSON.stringify({
        gitTreeSha: manifest.gitTreeSha,
        strictManifestSha256: manifest.strictManifestSha256,
      })}\n`,
    );
    return;
  }
  process.stderr.write(
    "usage: bridge-vendor-manifest.mjs manifest|summary <root> | compare <expected> <actual>\n",
  );
  process.exitCode = 2;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode =
      error instanceof ManifestIntegrityError ? FAIL_CLOSED_EXIT : 1;
  });
}
