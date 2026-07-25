import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  readFile,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { TextDecoder } from "node:util";

import { parseStrictJsonText } from "@executive-assistant/action-gateway";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_MARKER_BYTES = 4 * 1024;
const MARKER_FILE = "acknowledged.json";

export type AcknowledgementMarker =
  | Readonly<{
      version: 1;
      acknowledgedAt: string;
    }>
  | Readonly<{
      version: 2;
      taskId: string;
      acknowledgedAt: string;
    }>;

function canonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === "string" && expected.includes(key))
  );
}

async function privateWorkspace(
  workspacePath: string,
  taskId: string,
): Promise<boolean> {
  try {
    if (
      taskId.length === 0 ||
      taskId.length > 256 ||
      taskId !== taskId.trim() ||
      taskId.includes("\0") ||
      basename(workspacePath) !== taskId
    ) {
      return false;
    }
    const metadata = await lstat(workspacePath);
    return (
      !metadata.isSymbolicLink() &&
      metadata.isDirectory() &&
      (metadata.mode & 0o777) === PRIVATE_DIRECTORY_MODE &&
      (typeof process.getuid !== "function" ||
        metadata.uid === process.getuid()) &&
      (await realpath(workspacePath)) === workspacePath
    );
  } catch {
    return false;
  }
}

export async function readAcknowledgementMarker(
  workspacePath: string,
  taskId: string,
  options: Readonly<{ allowLegacyV1: boolean }>,
): Promise<AcknowledgementMarker | null> {
  try {
    if (!(await privateWorkspace(workspacePath, taskId))) return null;
    const markerPath = join(workspacePath, MARKER_FILE);
    const metadata = await lstat(markerPath);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > MAX_MARKER_BYTES ||
      (metadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
      (typeof process.getuid === "function" &&
        metadata.uid !== process.getuid()) ||
      (await realpath(markerPath)) !== markerPath
    ) {
      return null;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      await readFile(markerPath),
    );
    const value = parseStrictJsonText(text);
    if (
      value.version === 2 &&
      exactKeys(value, ["version", "taskId", "acknowledgedAt"]) &&
      value.taskId === taskId &&
      canonicalIso(value.acknowledgedAt)
    ) {
      return Object.freeze({
        version: 2,
        taskId,
        acknowledgedAt: value.acknowledgedAt,
      });
    }
    if (
      options.allowLegacyV1 &&
      value.version === 1 &&
      exactKeys(value, ["version", "acknowledgedAt"]) &&
      canonicalIso(value.acknowledgedAt)
    ) {
      return Object.freeze({
        version: 1,
        acknowledgedAt: value.acknowledgedAt,
      });
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeAcknowledgementMarker(
  workspacePath: string,
  taskId: string,
  acknowledgedAt: Date,
): Promise<void> {
  if (
    !(await privateWorkspace(workspacePath, taskId)) ||
    !Number.isFinite(acknowledgedAt.getTime())
  ) {
    throw new Error("ACKNOWLEDGEMENT_MARKER_INVALID");
  }
  const acknowledgedAtIso = acknowledgedAt.toISOString();
  const markerPath = join(workspacePath, MARKER_FILE);
  const temporaryPath = join(
    workspacePath,
    `.acknowledged-${randomUUID()}.tmp`,
  );
  let temporary: Awaited<ReturnType<typeof open>> | undefined;
  try {
    temporary = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    await temporary.writeFile(
      `${JSON.stringify({
        acknowledgedAt: acknowledgedAtIso,
        taskId,
        version: 2,
      })}\n`,
      "utf8",
    );
    await temporary.sync();
    await temporary.close();
    temporary = undefined;
    await link(temporaryPath, markerPath);
    await unlink(temporaryPath);
    const directory = await open(
      workspacePath,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (cause) {
    await temporary?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw cause;
  }
}
