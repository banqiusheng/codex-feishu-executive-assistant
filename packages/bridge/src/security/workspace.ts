import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

function assertWorkspaceRoot(root: unknown): asserts root is string {
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw new Error("workspace root must be an absolute path");
  }
  if (root.includes("\0")) {
    throw new Error("workspace root contains invalid characters");
  }
}

async function lstatOrThrow(path: string, missingMessage: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new Error(missingMessage);
    }
    throw error;
  }
}

export async function resolveTaskWorkspace(
  root: string,
  taskId: string,
): Promise<string> {
  assertWorkspaceRoot(root);
  if (!isCanonicalUuid(taskId)) throw new Error("invalid task id");

  const normalizedRoot = resolve(root);
  const rootStat = await lstatOrThrow(
    normalizedRoot,
    "workspace root does not exist",
  );
  if (rootStat.isSymbolicLink()) {
    throw new Error("workspace root must not contain symlinks");
  }
  if (!rootStat.isDirectory()) {
    throw new Error("workspace root must be a directory");
  }
  if ((rootStat.mode & 0o777) !== 0o700) {
    throw new Error("workspace root permissions must be 0700");
  }

  const rootRealPath = await realpath(normalizedRoot);
  if (rootRealPath !== normalizedRoot) {
    throw new Error("workspace root must not contain symlinks");
  }

  const candidate = join(normalizedRoot, taskId);
  const candidateStat = await lstatOrThrow(
    candidate,
    "task workspace does not exist",
  );
  if (candidateStat.isSymbolicLink()) {
    throw new Error("task workspace must not be a symlink");
  }
  if (!candidateStat.isDirectory()) {
    throw new Error("task workspace must be a directory");
  }
  if ((candidateStat.mode & 0o777) !== 0o700) {
    throw new Error("task workspace permissions must be 0700");
  }

  const candidateRealPath = await realpath(candidate);
  const relativePath = relative(rootRealPath, candidateRealPath);
  if (
    relativePath === "" ||
    isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    candidateRealPath !== join(rootRealPath, taskId)
  ) {
    throw new Error("task workspace escapes its root");
  }

  return candidateRealPath;
}
