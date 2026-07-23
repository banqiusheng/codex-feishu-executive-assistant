import lockfile from "proper-lockfile";
import { dirname, isAbsolute } from "node:path";

import { prepareSecureRuntimeDirectory } from "./secure-path.js";
import { RuntimeStateError, type DatabaseFileLock } from "./types.js";

type ProperLockOptions = Readonly<{
  stale: number;
  update: number;
  realpath: false;
  retries: 0;
  onCompromised: (cause: Error) => void;
}>;

type LockFunction = (
  runtimeDir: string,
  options: ProperLockOptions,
) => Promise<() => Promise<void>>;

type FatalHook = (error: RuntimeStateError) => void;

const LOCK_STALE_MS = 60_000;
const LOCK_UPDATE_MS = 10_000;
const databaseFileLockConstructionToken = Object.freeze({});
const databaseFileLockCapability = Object.freeze({});
const issuedDatabaseFileLocks = new WeakSet<object>();

function defaultCompromisedFatal(error: RuntimeStateError): never {
  throw error;
}

class DatabaseFileLockHandle implements DatabaseFileLock {
  #runtimeDir: string;
  #unlock: () => Promise<void>;
  #onCompromisedFatal: FatalHook;
  #released = false;
  #compromised = false;
  #releaseFailure: RuntimeStateError | undefined;
  #attachments = 0;
  #releasing = false;

  constructor(
    runtimeDir: string,
    unlock: () => Promise<void>,
    onCompromisedFatal: FatalHook,
    constructionToken: object,
  ) {
    if (constructionToken !== databaseFileLockConstructionToken) {
      throw new RuntimeStateError("database_file_lock_is_not_active");
    }
    this.#runtimeDir = runtimeDir;
    this.#unlock = unlock;
    this.#onCompromisedFatal = onCompromisedFatal;
    issuedDatabaseFileLocks.add(this);
    Object.preventExtensions(this);
  }

  get runtimeDir(): string {
    return this.#runtimeDir;
  }

  get released(): boolean {
    return this.#released;
  }

  get compromised(): boolean {
    return this.#compromised;
  }

  get releaseFailed(): boolean {
    return this.#releaseFailure !== undefined;
  }

  get releasing(): boolean {
    return this.#releasing;
  }

  async release(): Promise<void> {
    if (!issuedDatabaseFileLocks.has(this)) {
      throw new RuntimeStateError("database_file_lock_is_not_active");
    }
    if (this.#compromised) {
      throw new RuntimeStateError("database_file_lock_is_compromised");
    }
    if (this.#releaseFailure !== undefined) {
      throw this.#releaseFailure;
    }
    if (this.#released) {
      return;
    }
    if (this.#attachments > 0) {
      throw new RuntimeStateError("database_file_lock_has_active_store");
    }
    if (this.#releasing) {
      throw new RuntimeStateError("database_file_lock_release_in_progress");
    }
    if (!this.#released) {
      this.#releasing = true;
      try {
        await this.#unlock();
        this.#released = true;
        this.#releasing = false;
      } catch (cause) {
        this.#releasing = false;
        this.#releaseFailure = new RuntimeStateError(
          "database_file_lock_release_failed",
          cause,
        );
        throw this.#releaseFailure;
      }
    }
  }

  static markCompromised(
    lock: DatabaseFileLockHandle,
    cause: Error,
    capability: object,
  ): void {
    assertDatabaseFileLockCapability(capability);
    assertIssuedDatabaseFileLock(lock);
    if (lock.#compromised) {
      return;
    }
    lock.#compromised = true;
    lock.#onCompromisedFatal(
      new RuntimeStateError("database_file_lock_is_compromised", cause),
    );
  }

  static attach(lock: DatabaseFileLockHandle, capability: object): void {
    assertDatabaseFileLockCapability(capability);
    assertIssuedDatabaseFileLock(lock);
    if (lock.#released) {
      throw new RuntimeStateError("database_file_lock_is_not_active");
    }
    if (lock.#releaseFailure !== undefined) {
      throw lock.#releaseFailure;
    }
    if (lock.#releasing) {
      throw new RuntimeStateError("database_file_lock_release_in_progress");
    }
    if (lock.#compromised) {
      throw new RuntimeStateError("database_file_lock_is_compromised");
    }
    lock.#attachments += 1;
  }

  static detach(lock: DatabaseFileLockHandle, capability: object): void {
    assertDatabaseFileLockCapability(capability);
    assertIssuedDatabaseFileLock(lock);
    if (lock.#attachments === 0) {
      throw new RuntimeStateError("database_file_lock_attachment_missing");
    }
    lock.#attachments -= 1;
  }

  static assertActiveForFilename(
    lock: DatabaseFileLockHandle,
    filename: string,
    capability: object,
  ): void {
    assertDatabaseFileLockCapability(capability);
    assertIssuedDatabaseFileLock(lock);
    if (lock.#released) {
      throw new RuntimeStateError("database_file_lock_is_not_active");
    }
    if (lock.#releaseFailure !== undefined) {
      throw lock.#releaseFailure;
    }
    if (lock.#releasing) {
      throw new RuntimeStateError("database_file_lock_release_in_progress");
    }
    if (lock.#compromised) {
      throw new RuntimeStateError("database_file_lock_is_compromised");
    }
    if (!isAbsolute(filename) || dirname(filename) !== lock.#runtimeDir) {
      throw new RuntimeStateError(
        "database_path_is_not_a_runtime_direct_child",
      );
    }
    prepareSecureRuntimeDirectory(lock.#runtimeDir);
  }
}

Object.freeze(DatabaseFileLockHandle.prototype);
Object.freeze(DatabaseFileLockHandle);

function assertDatabaseFileLockCapability(capability: object): void {
  if (capability !== databaseFileLockCapability) {
    throw new RuntimeStateError("database_file_lock_is_not_active");
  }
}

function isIssuedDatabaseFileLock(
  lock: unknown,
): lock is DatabaseFileLockHandle {
  return (
    typeof lock === "object" &&
    lock !== null &&
    issuedDatabaseFileLocks.has(lock)
  );
}

function assertIssuedDatabaseFileLock(
  lock: unknown,
): asserts lock is DatabaseFileLockHandle {
  if (!isIssuedDatabaseFileLock(lock)) {
    throw new RuntimeStateError("database_file_lock_is_not_active");
  }
}

export async function acquireDatabaseFileLock(
  runtimeDir: string,
): Promise<DatabaseFileLock> {
  return acquireDatabaseFileLockWithLockFunction(
    runtimeDir,
    (path, lockOptions) => lockfile.lock(path, lockOptions),
  );
}

export function createDatabaseFileLockHandle(
  runtimeDir: string,
  unlock: () => Promise<void>,
  onCompromisedFatal: FatalHook = defaultCompromisedFatal,
): DatabaseFileLock {
  return new DatabaseFileLockHandle(
    runtimeDir,
    unlock,
    onCompromisedFatal,
    databaseFileLockConstructionToken,
  );
}

export async function acquireDatabaseFileLockWithLockFunction(
  runtimeDir: string,
  lock: LockFunction,
  onCompromisedFatal: FatalHook = defaultCompromisedFatal,
): Promise<DatabaseFileLock> {
  let handle: DatabaseFileLockHandle | undefined;
  let unlock: (() => Promise<void>) | undefined;
  let pendingCompromise: Error | undefined;

  try {
    unlock = await lock(runtimeDir, {
      stale: LOCK_STALE_MS,
      update: LOCK_UPDATE_MS,
      realpath: false,
      retries: 0,
      onCompromised: (cause) => {
        if (handle === undefined) {
          pendingCompromise = cause;
          return;
        }
        DatabaseFileLockHandle.markCompromised(
          handle,
          cause,
          databaseFileLockCapability,
        );
      },
    });
  } catch (cause) {
    throw new RuntimeStateError("database_file_lock_unavailable", cause);
  }

  try {
    const canonicalRuntimeDir = prepareSecureRuntimeDirectory(runtimeDir);
    handle = createDatabaseFileLockHandle(
      canonicalRuntimeDir,
      unlock,
      onCompromisedFatal,
    ) as DatabaseFileLockHandle;
    if (pendingCompromise !== undefined) {
      DatabaseFileLockHandle.markCompromised(
        handle,
        pendingCompromise,
        databaseFileLockCapability,
      );
    }
    return handle;
  } catch (cause) {
    try {
      await unlock();
    } catch (cleanupCause) {
      throw new RuntimeStateError(
        "database_file_lock_cleanup_failed",
        cleanupCause,
      );
    }
    if (cause instanceof RuntimeStateError) {
      throw cause;
    }
    throw new RuntimeStateError("runtime_directory_is_unavailable", cause);
  }
}

export function assertActiveDatabaseFileLock(
  lock: DatabaseFileLock,
  filename: string,
): DatabaseFileLockHandle {
  assertIssuedDatabaseFileLock(lock);
  DatabaseFileLockHandle.assertActiveForFilename(
    lock,
    filename,
    databaseFileLockCapability,
  );
  return lock;
}

export function attachDatabaseFileLock(
  lock: DatabaseFileLock,
  filename: string,
): void {
  DatabaseFileLockHandle.attach(
    assertActiveDatabaseFileLock(lock, filename),
    databaseFileLockCapability,
  );
}

export function detachDatabaseFileLock(lock: DatabaseFileLock): void {
  assertIssuedDatabaseFileLock(lock);
  DatabaseFileLockHandle.detach(lock, databaseFileLockCapability);
}
