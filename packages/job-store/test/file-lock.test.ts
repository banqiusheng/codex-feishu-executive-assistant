import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireDatabaseFileLockWithLockFunction,
  attachDatabaseFileLock,
  assertActiveDatabaseFileLock,
  createDatabaseFileLockHandle,
} from "../src/file-lock.js";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function createRuntimeDirectory(): string {
  const path = mkdtempSync(join(realTemporaryDirectory(), "job-store-lock-"));
  chmodSync(path, 0o700);
  temporaryPaths.push(path);
  return path;
}

function realTemporaryDirectory(): string {
  // The production guard deliberately rejects lexical aliases such as /tmp.
  // Tests therefore derive their fixtures from the canonical temporary root.
  return realpathSync(tmpdir());
}

describe("database file lock", () => {
  it("releases a newly acquired lock when post-lock path validation fails", async () => {
    const runtimeDir = createRuntimeDirectory();
    chmodSync(runtimeDir, 0o755);
    const unlock = vi.fn(async () => undefined);
    const lock = vi.fn(async () => unlock);

    await expect(
      acquireDatabaseFileLockWithLockFunction(runtimeDir, lock),
    ).rejects.toThrowError(/runtime_directory_is_not_private/);

    expect(lock).toHaveBeenCalledOnce();
    expect(unlock).toHaveBeenCalledOnce();
  });

  it("rejects a symlink-ancestor runtime alias after locking and cleans it up", async () => {
    const parent = createRuntimeDirectory();
    const actualRuntimeDir = join(parent, "actual-runtime");
    mkdirSync(actualRuntimeDir, { mode: 0o700 });
    const alias = join(parent, "alias");
    symlinkSync(parent, alias);
    const lexicalAlias = join(alias, "actual-runtime");
    const unlock = vi.fn(async () => undefined);
    const lock = vi.fn(async () => unlock);

    await expect(
      acquireDatabaseFileLockWithLockFunction(lexicalAlias, lock),
    ).rejects.toThrowError(/runtime_directory_is_not_canonical/);

    expect(unlock).toHaveBeenCalledOnce();
  });

  it("fails closed when proper-lockfile release fails", async () => {
    let attempts = 0;
    const lock = createDatabaseFileLockHandle(
      createRuntimeDirectory(),
      async () => {
        attempts += 1;
        throw new Error("lock directory could not be removed");
      },
    );

    await expect(lock.release()).rejects.toThrow(
      /database_file_lock_release_failed/,
    );
    expect(lock.released).toBe(false);
    expect(lock.releaseFailed).toBe(true);
    expect(() =>
      assertActiveDatabaseFileLock(
        lock,
        join(lock.runtimeDir, "assistant.sqlite"),
      ),
    ).toThrowError(/database_file_lock_release_failed/);
    await expect(lock.release()).rejects.toThrow(
      /database_file_lock_release_failed/,
    );
    expect(attempts).toBe(1);
  });

  it("keeps successful release idempotent", async () => {
    const unlock = vi.fn(async () => undefined);
    const lock = createDatabaseFileLockHandle(createRuntimeDirectory(), unlock);

    await lock.release();
    await lock.release();

    expect(unlock).toHaveBeenCalledOnce();
    expect(lock.released).toBe(true);
  });

  it("uses explicit stale, update, and compromise policy", async () => {
    const runtimeDir = createRuntimeDirectory();
    const unlock = vi.fn(async () => undefined);
    const lock = vi.fn(async () => unlock);

    const handle = await acquireDatabaseFileLockWithLockFunction(
      runtimeDir,
      lock,
    );
    expect(lock).toHaveBeenCalledWith(
      runtimeDir,
      expect.objectContaining({
        realpath: false,
        retries: 0,
        stale: 60_000,
        update: 10_000,
        onCompromised: expect.any(Function),
      }),
    );
    await handle.release();
  });

  it("fails closed after proper-lockfile reports the lock compromised", async () => {
    const runtimeDir = createRuntimeDirectory();
    let capturedOptions:
      | Readonly<{ onCompromised: (cause: Error) => void }>
      | undefined;
    const lock = async (
      _runtimeDir: string,
      options: Readonly<{ onCompromised: (cause: Error) => void }>,
    ) => {
      capturedOptions = options;
      return async () => undefined;
    };
    const fatal = vi.fn();
    const handle = await acquireDatabaseFileLockWithLockFunction(
      runtimeDir,
      lock,
      fatal,
    );
    expect(capturedOptions).toBeDefined();

    capturedOptions?.onCompromised(new Error("lock was replaced"));
    capturedOptions?.onCompromised(new Error("second report is ignored"));

    expect(handle.compromised).toBe(true);
    expect(fatal).toHaveBeenCalledOnce();
    expect(() =>
      assertActiveDatabaseFileLock(
        handle,
        join(runtimeDir, "assistant.sqlite"),
      ),
    ).toThrowError(/database_file_lock_is_compromised/);
  });

  it("uses an explicit fatal default when a held lock is compromised", async () => {
    const runtimeDir = createRuntimeDirectory();
    let capturedOptions:
      | Readonly<{ onCompromised: (cause: Error) => void }>
      | undefined;
    const handle = await acquireDatabaseFileLockWithLockFunction(
      runtimeDir,
      async (_runtimeDir, options) => {
        capturedOptions = options;
        return async () => undefined;
      },
    );

    expect(() =>
      capturedOptions?.onCompromised(new Error("lock replaced")),
    ).toThrowError(/database_file_lock_is_compromised/);
    expect(handle.compromised).toBe(true);
  });

  it("does not lose a compromise reported before lock acquisition resolves", async () => {
    const runtimeDir = createRuntimeDirectory();
    const fatal = vi.fn();
    const handle = await acquireDatabaseFileLockWithLockFunction(
      runtimeDir,
      async (_runtimeDir, options) => {
        options.onCompromised(new Error("early compromise"));
        return async () => undefined;
      },
      fatal,
    );

    expect(handle.compromised).toBe(true);
    expect(fatal).toHaveBeenCalledOnce();
    expect(() =>
      assertActiveDatabaseFileLock(
        handle,
        join(runtimeDir, "assistant.sqlite"),
      ),
    ).toThrowError(/database_file_lock_is_compromised/);
  });

  it("blocks attachment while release is awaiting the underlying unlock", async () => {
    const runtimeDir = createRuntimeDirectory();
    let finishUnlock: (() => void) | undefined;
    const unlockStarted = new Promise<void>((resolve) => {
      finishUnlock = resolve;
    });
    const handle = createDatabaseFileLockHandle(runtimeDir, async () => {
      await unlockStarted;
    });

    const releasing = handle.release();
    expect(() =>
      attachDatabaseFileLock(handle, join(runtimeDir, "assistant.sqlite")),
    ).toThrowError(/database_file_lock_release_in_progress/);
    finishUnlock?.();
    await releasing;
  });
});
