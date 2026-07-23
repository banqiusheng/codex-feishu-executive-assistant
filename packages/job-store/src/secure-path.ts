import { closeSync, lstatSync, openSync, realpathSync } from "node:fs";
import { constants } from "node:fs";
import { dirname, isAbsolute } from "node:path";

import { RuntimeStateError } from "./types.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new RuntimeStateError("uid_is_unavailable");
  }
  return process.getuid();
}

function assertPrivateDirectory(path: string): string {
  if (!isAbsolute(path)) {
    throw new RuntimeStateError("runtime_directory_must_be_absolute");
  }

  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch (cause) {
    throw new RuntimeStateError("runtime_directory_is_unavailable", cause);
  }

  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.uid !== currentUid() ||
    (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
  ) {
    throw new RuntimeStateError("runtime_directory_is_not_private");
  }

  try {
    const canonicalPath = realpathSync(path);
    if (canonicalPath !== path) {
      throw new RuntimeStateError("runtime_directory_is_not_canonical");
    }
    return canonicalPath;
  } catch (cause) {
    if (cause instanceof RuntimeStateError) {
      throw cause;
    }
    throw new RuntimeStateError("runtime_directory_is_unavailable", cause);
  }
}

export function prepareSecureRuntimeDirectory(runtimeDir: string): string {
  return assertPrivateDirectory(runtimeDir);
}

export function prepareSecureSqlitePath(filename: string): void {
  if (!isAbsolute(filename)) {
    throw new RuntimeStateError("database_path_must_be_absolute");
  }

  assertPrivateDirectory(dirname(filename));

  try {
    const metadata = lstatSync(filename);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.uid !== currentUid() ||
      (metadata.mode & 0o777) !== PRIVATE_FILE_MODE
    ) {
      throw new RuntimeStateError("database_file_is_not_private");
    }
    return;
  } catch (cause) {
    if (cause instanceof RuntimeStateError) {
      throw cause;
    }
    if (
      !(cause instanceof Error) ||
      !("code" in cause) ||
      cause.code !== "ENOENT"
    ) {
      throw new RuntimeStateError("database_file_cannot_be_checked", cause);
    }
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      filename,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
  } catch (cause) {
    throw new RuntimeStateError("database_file_cannot_be_created", cause);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }

  try {
    const metadata = lstatSync(filename);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.uid !== currentUid() ||
      (metadata.mode & 0o777) !== PRIVATE_FILE_MODE
    ) {
      throw new RuntimeStateError("database_file_is_not_private");
    }
  } catch (cause) {
    if (cause instanceof RuntimeStateError) {
      throw cause;
    }
    throw new RuntimeStateError("database_file_cannot_be_checked", cause);
  }
}
