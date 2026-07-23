import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireDatabaseFileLock,
  openJobStore,
  type DatabaseFileLock,
  type JobStore,
  type JobStoreOptions,
} from "../src/index.js";
import * as publicApi from "../src/index.js";
import { applyChecksumVerifiedMigrationsInOneTransaction } from "../src/migrate.js";
import {
  migrationDirectoryForModuleUrl,
  openJobStoreWithMigrationDirectory,
} from "../src/open-store.js";
import { RuntimeStateError } from "../src/types.js";

const temporaryPaths: string[] = [];
const openStores: JobStore[] = [];
const fileLocks: DatabaseFileLock[] = [];

afterEach(async () => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
  for (const lock of fileLocks.splice(0)) {
    await lock.release();
  }
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function createRuntimeDirectory(): string {
  const path = mkdtempSync(
    join(realpathSync(tmpdir()), "executive-assistant-job-store-"),
  );
  chmodSync(path, 0o700);
  temporaryPaths.push(path);
  return path;
}

function tempDb(runtimeDir = createRuntimeDirectory()): string {
  return join(runtimeDir, "assistant.sqlite");
}

function corruptSqliteFile(): string {
  const filename = tempDb();
  writeFileSync(filename, "not a sqlite database", { mode: 0o600 });
  return filename;
}

function createInitialMigrationDirectory(runtimeDir: string): string {
  const migrationDirectory = join(runtimeDir, "migrations");
  mkdirSync(migrationDirectory, { mode: 0o700 });
  writeFileSync(
    join(migrationDirectory, "001_initial.sql"),
    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);",
    { mode: 0o600 },
  );
  return migrationDirectory;
}

async function acquireLock(runtimeDir: string): Promise<DatabaseFileLock> {
  const lock = await acquireDatabaseFileLock(runtimeDir);
  fileLocks.push(lock);
  return lock;
}

async function openStore(filename = tempDb()): Promise<JobStore> {
  const store = openJobStore({
    filename,
    instanceId: "instance-a",
    lock: await acquireLock(dirname(filename)),
  });
  openStores.push(store);
  return store;
}

describe("openJobStore", () => {
  it("reports fixed durability settings without exposing arbitrary pragmas", async () => {
    const store = await openStore();

    expect(store.durabilitySettings()).toEqual({
      journalMode: "wal",
      foreignKeys: 1,
      synchronous: 2,
      busyTimeout: 5000,
    });
  });

  it("does not export internal path primitives from the package root", () => {
    expect(publicApi).not.toHaveProperty("prepareSecureSqlitePath");
  });

  it("fails closed when integrity_check is not ok", async () => {
    const filename = corruptSqliteFile();
    const lock = await acquireLock(dirname(filename));
    expect(() =>
      openJobStore({ filename, instanceId: "instance-a", lock }),
    ).toThrowError(/BLOCKED_RUNTIME_STATE/);
  });

  it("allows only one process file lock before SQLite opens", async () => {
    const runtimeDir = createRuntimeDirectory();
    const lock = await acquireDatabaseFileLock(runtimeDir);

    await expect(acquireDatabaseFileLock(runtimeDir)).rejects.toThrow(
      /BLOCKED_RUNTIME_STATE/,
    );
    await lock.release();

    const lockAgain = await acquireDatabaseFileLock(runtimeDir);
    await lockAgain.release();
  });

  it("requires an active lock for the database runtime directory", async () => {
    const runtimeDir = createRuntimeDirectory();
    const lock = await acquireLock(runtimeDir);
    await lock.release();

    expect(() =>
      openJobStore({
        filename: tempDb(runtimeDir),
        instanceId: "instance-a",
        lock,
      }),
    ).toThrowError(/BLOCKED_RUNTIME_STATE/);
  });

  it("does not trust a real lock handle's runtimeDir after a public overwrite attempt", async () => {
    const runtimeDir = createRuntimeDirectory();
    const otherRuntimeDir = createRuntimeDirectory();
    const lock = await acquireLock(runtimeDir);
    const otherFilename = tempDb(otherRuntimeDir);
    let opened: JobStore | undefined;

    try {
      try {
        Object.defineProperty(lock, "runtimeDir", {
          configurable: true,
          value: otherRuntimeDir,
        });
      } catch {
        // A hardened handle rejects the overwrite; either way open must use its
        // original, private runtime directory.
      }

      expect(Object.isExtensible(lock)).toBe(false);
      expect(lock.runtimeDir).toBe(runtimeDir);
      expect(() => {
        opened = openJobStore({
          filename: otherFilename,
          instanceId: "instance-a",
          lock,
        });
      }).toThrowError(/database_path_is_not_a_runtime_direct_child/);
      expect(existsSync(otherFilename)).toBe(false);
    } finally {
      opened?.close();
    }
  });

  it("does not trust a released real lock after a public released overwrite attempt", async () => {
    const runtimeDir = createRuntimeDirectory();
    const filename = tempDb(runtimeDir);
    const lock = await acquireLock(runtimeDir);
    await lock.release();
    let opened: JobStore | undefined;

    try {
      try {
        Object.defineProperty(lock, "released", {
          configurable: true,
          value: false,
        });
      } catch {
        // A hardened handle rejects the overwrite; either way its release state
        // remains authoritative.
      }

      expect(lock.released).toBe(true);
      expect(() => {
        opened = openJobStore({ filename, instanceId: "instance-a", lock });
      }).toThrowError(/database_file_lock_is_not_active/);
      expect(existsSync(filename)).toBe(false);
    } finally {
      opened?.close();
    }
  });

  it("rejects an alternating filename accessor before it can create another database", async () => {
    const runtimeDir = createRuntimeDirectory();
    const otherRuntimeDir = createRuntimeDirectory();
    const lock = await acquireLock(runtimeDir);
    const firstFilename = tempDb(runtimeDir);
    const otherFilename = tempDb(otherRuntimeDir);
    const filenameGetter = vi
      .fn<() => string>()
      .mockReturnValueOnce(firstFilename)
      .mockReturnValue(otherFilename);
    const options = {
      instanceId: "instance-a",
      lock,
    } as JobStoreOptions;
    Object.defineProperty(options, "filename", {
      configurable: true,
      get: filenameGetter,
    });

    let opened: JobStore | undefined;
    try {
      expect(() => {
        opened = openJobStore(options);
      }).toThrowError(/job_store_options_must_be_own_data_properties/);
      expect(filenameGetter).not.toHaveBeenCalled();
      expect(existsSync(firstFilename)).toBe(false);
      expect(existsSync(otherFilename)).toBe(false);
    } finally {
      opened?.close();
    }
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("rejects a lock accessor before attaching or detaching a real lock", async () => {
    const runtimeDir = createRuntimeDirectory();
    const filename = tempDb(runtimeDir);
    const lock = await acquireLock(runtimeDir);
    const lockGetter = vi.fn(() => lock);
    const options = {
      filename,
      instanceId: "instance-a",
    } as JobStoreOptions;
    Object.defineProperty(options, "lock", {
      configurable: true,
      get: lockGetter,
    });

    let opened: JobStore | undefined;
    try {
      expect(() => {
        opened = openJobStore(options);
      }).toThrowError(/job_store_options_must_be_own_data_properties/);
      expect(lockGetter).not.toHaveBeenCalled();
      expect(existsSync(filename)).toBe(false);
    } finally {
      opened?.close();
    }
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("rejects a Proxy options object without invoking its business traps", async () => {
    const runtimeDir = createRuntimeDirectory();
    const filename = tempDb(runtimeDir);
    const lock = await acquireLock(runtimeDir);
    const ownKeys = vi.fn<() => ArrayLike<string | symbol>>(() => [
      "filename",
      "instanceId",
      "lock",
    ]);
    const get = vi.fn();
    const options = new Proxy(
      { filename, instanceId: "instance-a", lock },
      { get, ownKeys },
    ) as JobStoreOptions;

    let opened: JobStore | undefined;
    try {
      expect(() => {
        opened = openJobStore(options);
      }).toThrowError(/job_store_options_must_be_own_data_properties/);
      expect(ownKeys).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(existsSync(filename)).toBe(false);
    } finally {
      opened?.close();
    }
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("rejects symbol and unknown own option fields before attaching", async () => {
    const runtimeDir = createRuntimeDirectory();
    const filename = tempDb(runtimeDir);
    const lock = await acquireLock(runtimeDir);
    const options = {
      filename,
      instanceId: "instance-a",
      lock,
      unexpected: "no",
      [Symbol("unexpected")]: "no",
    } as unknown as JobStoreOptions;

    let opened: JobStore | undefined;
    try {
      expect(() => {
        opened = openJobStore(options);
      }).toThrowError(/job_store_options_must_be_own_data_properties/);
      expect(existsSync(filename)).toBe(false);
    } finally {
      opened?.close();
    }
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("rejects a non-plain options prototype before attaching", async () => {
    const runtimeDir = createRuntimeDirectory();
    const filename = tempDb(runtimeDir);
    const lock = await acquireLock(runtimeDir);
    const options = Object.assign(Object.create({}), {
      filename,
      instanceId: "instance-a",
      lock,
    }) as JobStoreOptions;

    expect(() => openJobStore(options)).toThrowError(
      /job_store_options_must_be_own_data_properties/,
    );
    expect(existsSync(filename)).toBe(false);
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("rejects a non-enumerable own option descriptor before attaching", async () => {
    const runtimeDir = createRuntimeDirectory();
    const filename = tempDb(runtimeDir);
    const lock = await acquireLock(runtimeDir);
    const options = { filename, instanceId: "instance-a", lock };
    Object.defineProperty(options, "filename", {
      configurable: true,
      enumerable: false,
      value: filename,
    });

    expect(() => openJobStore(options)).toThrowError(
      /job_store_options_must_be_own_data_properties/,
    );
    expect(existsSync(filename)).toBe(false);
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("rejects constructor-reflected and prototype-forged lock handles", async () => {
    const runtimeDir = createRuntimeDirectory();
    const filename = tempDb(runtimeDir);
    const lock = await acquireLock(runtimeDir);
    const LockConstructor = Object.getPrototypeOf(lock).constructor as new (
      runtimeDir: string,
      unlock: () => Promise<void>,
      fatal: (error: RuntimeStateError) => void,
    ) => DatabaseFileLock;

    expect(
      () =>
        new LockConstructor(
          runtimeDir,
          async () => undefined,
          () => undefined,
        ),
    ).toThrowError(/database_file_lock_is_not_active/);
    const prototypeForged = Object.create(
      Object.getPrototypeOf(lock),
    ) as DatabaseFileLock;
    expect(() =>
      openJobStore({
        filename,
        instanceId: "instance-a",
        lock: prototypeForged,
      }),
    ).toThrowError(/database_file_lock_is_not_active/);
    expect(existsSync(filename)).toBe(false);
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("rejects transparent, bound-get, and revoked Proxy lock handles consistently", async () => {
    const runtimeDir = createRuntimeDirectory();
    const filename = tempDb(runtimeDir);
    const lock = await acquireLock(runtimeDir);
    const transparent = new Proxy(lock, {});
    const get = vi.fn<
      (target: DatabaseFileLock, property: PropertyKey) => unknown
    >((target, property) => {
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    });
    const boundGet = new Proxy(lock, { get });
    const getPrototypeOf = vi.fn(() => Object.getPrototypeOf(lock));
    const prototypeTrap = new Proxy(lock, { getPrototypeOf });
    const { proxy: revoked, revoke } = Proxy.revocable(lock, {});
    revoke();

    for (const proxiedLock of [transparent, boundGet, prototypeTrap, revoked]) {
      expect(() =>
        openJobStore({
          filename,
          instanceId: "instance-a",
          lock: proxiedLock,
        }),
      ).toThrowError(/database_file_lock_is_not_active/);
    }
    expect(get).not.toHaveBeenCalled();
    expect(getPrototypeOf).not.toHaveBeenCalled();
    expect(existsSync(filename)).toBe(false);
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("does not let a lock constructor detach an open store", async () => {
    const runtimeDir = createRuntimeDirectory();
    const filename = tempDb(runtimeDir);
    const lock = await acquireLock(runtimeDir);
    const store = openJobStore({ filename, instanceId: "instance-a", lock });
    const LockConstructor = Object.getPrototypeOf(lock).constructor as {
      attach(lock: DatabaseFileLock): void;
      detach(lock: DatabaseFileLock): void;
    };
    let bypassed = false;

    try {
      try {
        LockConstructor.detach(lock);
        bypassed = true;
      } catch {
        // The capability boundary must reject constructor reflection.
      }
      expect(bypassed).toBe(false);
      await expect(lock.release()).rejects.toThrowError(
        /database_file_lock_has_active_store/,
      );
    } finally {
      if (bypassed) {
        LockConstructor.attach(lock);
      }
      store.close();
    }
  });

  it("closes the captured database and detaches despite public store overwrite attempts", async () => {
    const runtimeDir = createRuntimeDirectory();
    const filename = tempDb(runtimeDir);
    const lock = await acquireLock(runtimeDir);
    let capturedDatabase: Database.Database | undefined;
    const store = openJobStoreWithMigrationDirectory(
      { filename, instanceId: "instance-a", lock },
      createInitialMigrationDirectory(runtimeDir),
      (path) => {
        capturedDatabase = new Database(path);
        return capturedDatabase;
      },
    );
    const mutableStore = store as unknown as {
      database?: Database.Database;
      onClose?: () => void;
    };
    const originalOnClose = mutableStore.onClose;
    const replacementDatabase = new Database(":memory:");
    let overwriteSucceeded = false;

    try {
      try {
        Object.defineProperties(mutableStore, {
          database: { configurable: true, value: replacementDatabase },
          onClose: { configurable: true, value: () => undefined },
        });
        overwriteSucceeded = true;
      } catch {
        // A hardened store rejects the overwrite and keeps private references.
      }
      expect(store.instanceId).toBe("instance-a");
      store.close();
      expect(capturedDatabase?.open).toBe(false);
      await expect(lock.release()).resolves.toBeUndefined();
    } finally {
      if (capturedDatabase?.open) {
        capturedDatabase.close();
      }
      if (overwriteSucceeded && originalOnClose !== undefined) {
        originalOnClose();
      }
      if (replacementDatabase.open) {
        replacementDatabase.close();
      }
    }
  });

  it("retains the initial own-data snapshot when the caller mutates options before close", async () => {
    const runtimeA = createRuntimeDirectory();
    const runtimeB = createRuntimeDirectory();
    const filenameA = tempDb(runtimeA);
    const filenameB = tempDb(runtimeB);
    const lockA = await acquireLock(runtimeA);
    const lockB = await acquireLock(runtimeB);
    const options = {
      filename: filenameA,
      instanceId: "instance-a",
      lock: lockA,
    };
    const store = openJobStore(options);

    options.filename = filenameB;
    options.instanceId = "instance-b";
    options.lock = lockB;

    expect(store.instanceId).toBe("instance-a");
    store.close();
    await expect(lockA.release()).resolves.toBeUndefined();
    await expect(lockB.release()).resolves.toBeUndefined();
    expect(existsSync(filenameB)).toBe(false);
  });

  it("detaches the initial own-data lock when database creation mutates caller options then fails", async () => {
    const runtimeA = createRuntimeDirectory();
    const runtimeB = createRuntimeDirectory();
    const filenameA = tempDb(runtimeA);
    const filenameB = tempDb(runtimeB);
    const lockA = await acquireLock(runtimeA);
    const lockB = await acquireLock(runtimeB);
    const options = {
      filename: filenameA,
      instanceId: "instance-a",
      lock: lockA,
    };

    expect(() =>
      openJobStoreWithMigrationDirectory(
        options,
        createInitialMigrationDirectory(runtimeA),
        () => {
          options.lock = lockB;
          options.filename = filenameB;
          options.instanceId = "instance-b";
          throw new Error("database factory failed");
        },
      ),
    ).toThrowError(/database_cannot_be_opened/);
    await expect(lockA.release()).resolves.toBeUndefined();
    await expect(lockB.release()).resolves.toBeUndefined();
    expect(existsSync(filenameB)).toBe(false);
  });

  it("does not release an attached lock until the store closes", async () => {
    const runtimeDir = createRuntimeDirectory();
    const filename = tempDb(runtimeDir);
    const lock = await acquireLock(runtimeDir);
    const store = openJobStore({ filename, instanceId: "instance-a", lock });

    await expect(lock.release()).rejects.toThrowError(
      /database_file_lock_has_active_store/,
    );
    store.close();
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("rejects a database outside the locked runtime directory", async () => {
    const runtimeDir = createRuntimeDirectory();
    const nestedRuntimeDir = join(runtimeDir, "nested");
    mkdirSync(nestedRuntimeDir, { mode: 0o700 });
    const lock = await acquireLock(runtimeDir);

    expect(() =>
      openJobStore({
        filename: tempDb(nestedRuntimeDir),
        instanceId: "instance-a",
        lock,
      }),
    ).toThrowError(/BLOCKED_RUNTIME_STATE/);
  });

  it("rejects a forged structural lock handle", () => {
    const runtimeDir = createRuntimeDirectory();
    const forged = {
      runtimeDir,
      released: false,
      compromised: false,
      releaseFailed: false,
      release: async () => undefined,
    } as DatabaseFileLock;

    expect(() =>
      openJobStore({
        filename: tempDb(runtimeDir),
        instanceId: "instance-a",
        lock: forged,
      }),
    ).toThrowError(/database_file_lock_is_not_active/);
  });

  it("creates the database as a private regular file", async () => {
    const filename = tempDb();
    await openStore(filename);

    const metadata = lstatSync(filename);
    expect(metadata.isFile()).toBe(true);
    expect(metadata.isSymbolicLink()).toBe(false);
    expect(metadata.mode & 0o777).toBe(0o600);
  });

  it("rejects a relative database path with the path detail", async () => {
    const runtimeDir = createRuntimeDirectory();
    const lock = await acquireLock(runtimeDir);
    expectRuntimeStateDetail(
      () =>
        openJobStore({
          filename: "assistant.sqlite",
          instanceId: "instance-a",
          lock,
        }),
      "database_path_is_not_a_runtime_direct_child",
    );
  });

  it("rejects a world-readable locked runtime directory", async () => {
    const runtimeDir = createRuntimeDirectory();
    const lock = await acquireLock(runtimeDir);
    chmodSync(runtimeDir, 0o755);

    expectRuntimeStateDetail(
      () =>
        openJobStore({
          filename: tempDb(runtimeDir),
          instanceId: "instance-a",
          lock,
        }),
      "runtime_directory_is_not_private",
    );
  });

  it("rejects a world-readable database file in the locked runtime directory", async () => {
    const runtimeDir = createRuntimeDirectory();
    const filename = tempDb(runtimeDir);
    writeFileSync(filename, "", { mode: 0o600 });
    chmodSync(filename, 0o644);
    const lock = await acquireLock(runtimeDir);

    expectRuntimeStateDetail(
      () => openJobStore({ filename, instanceId: "instance-a", lock }),
      "database_file_is_not_private",
    );
  });

  it("rejects a symbolic-link database file", async () => {
    const runtimeDir = createRuntimeDirectory();
    const target = join(runtimeDir, "target.sqlite");
    writeFileSync(target, "", { mode: 0o600 });
    const filename = join(runtimeDir, "assistant.sqlite");
    symlinkSync(target, filename);

    const lock = await acquireLock(runtimeDir);
    expect(() =>
      openJobStore({ filename, instanceId: "instance-a", lock }),
    ).toThrowError(/BLOCKED_RUNTIME_STATE/);
  });

  it("does not rerun an already applied migration", async () => {
    const filename = tempDb();
    const firstLock = await acquireLock(dirname(filename));
    openJobStore({
      filename,
      instanceId: "instance-a",
      lock: firstLock,
    }).close();
    await firstLock.release();
    openStores.pop();
    await openStore(filename);
    const verificationDb = new Database(filename, { readonly: true });
    expect(
      verificationDb
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get(),
    ).toEqual({ count: 2 });
    verificationDb.close();
  });

  it("forwards a real v1-only database to v2 while preserving controls with pending defaulted false", async () => {
    const runtimeDir = createRuntimeDirectory();
    const filename = tempDb(runtimeDir);
    const v1Migrations = join(runtimeDir, "v1-migrations");
    mkdirSync(v1Migrations, { mode: 0o700 });
    writeFileSync(
      join(v1Migrations, "001_initial.sql"),
      readFileSync(
        join(
          migrationDirectoryForModuleUrl(import.meta.url),
          "001_initial.sql",
        ),
        "utf8",
      ),
      { mode: 0o600 },
    );
    const lock = await acquireLock(runtimeDir);
    const v1Store = openJobStoreWithMigrationDirectory(
      { filename, instanceId: "instance-a", lock },
      v1Migrations,
      (path) => new Database(path),
    );
    v1Store.close();

    const setup = new Database(filename);
    setup
      .prepare(
        `INSERT INTO control_events(
           id, app_id, tenant_key, event_id, message_id, command,
           actor_open_id_hash, chat_id_hash, target_task_id, received_at
         ) VALUES (?, ?, ?, ?, ?, 'CANCEL_ACTIVE_TASK', ?, ?, NULL, ?)`,
      )
      .run(
        "control-v1",
        "app-v1",
        "tenant-v1",
        "event-v1",
        "message-v1",
        "a".repeat(64),
        "b".repeat(64),
        "2026-07-22T08:00:00.000Z",
      );
    setup.close();

    const upgraded = openJobStore({
      filename,
      instanceId: "instance-a",
      lock,
    });
    openStores.push(upgraded);
    const verification = new Database(filename, { readonly: true });
    expect(
      verification
        .prepare(
          `SELECT external_effects_pending AS pending
             FROM control_events WHERE id = 'control-v1'`,
        )
        .get(),
    ).toEqual({ pending: 0 });
    expect(
      verification
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
        .get(),
    ).toEqual({ count: 2 });
    verification.close();
  });

  it("rejects migration checksum drift without overwriting the database", async () => {
    const filename = tempDb();
    const firstLock = await acquireLock(dirname(filename));
    openJobStore({
      filename,
      instanceId: "instance-a",
      lock: firstLock,
    }).close();
    await firstLock.release();
    openStores.pop();
    const db = new Database(filename);
    db.prepare("UPDATE schema_migrations SET checksum = 'drifted'").run();
    db.close();

    const lock = await acquireLock(dirname(filename));
    expect(() =>
      openJobStore({ filename, instanceId: "instance-a", lock }),
    ).toThrowError(/BLOCKED_RUNTIME_STATE/);

    const verificationDb = new Database(filename, { readonly: true });
    expect(
      verificationDb
        .prepare("SELECT checksum FROM schema_migrations WHERE version = 1")
        .get(),
    ).toEqual({ checksum: "drifted" });
    verificationDb.close();
  });

  it("closes the original SQLite handle when a migration fails", async () => {
    const runtimeDir = createRuntimeDirectory();
    const filename = tempDb(runtimeDir);
    const migrationDir = join(runtimeDir, "migrations");
    mkdirSync(migrationDir, { mode: 0o700 });
    writeFileSync(join(migrationDir, "001_bad.sql"), "THIS IS NOT SQL", {
      mode: 0o600,
    });

    const lock = await acquireLock(runtimeDir);
    let openedDatabase: Database.Database | undefined;
    expect(() =>
      openJobStoreWithMigrationDirectory(
        { filename, instanceId: "instance-a", lock },
        migrationDir,
        (path) => {
          openedDatabase = new Database(path);
          return openedDatabase;
        },
      ),
    ).toThrowError(/BLOCKED_RUNTIME_STATE/);

    expect(openedDatabase?.open).toBe(false);
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("converts percent-encoded module URLs before resolving migrations", () => {
    expect(
      migrationDirectoryForModuleUrl(
        "file:///private/tmp/with%20space/dist/index.js",
      ),
    ).toBe("/private/tmp/with space/migrations");
  });

  it("applies each migration transactionally", () => {
    const runtimeDir = createRuntimeDirectory();
    const migrationDir = join(runtimeDir, "migrations");
    mkdirSync(migrationDir, { mode: 0o700 });
    writeFileSync(
      join(migrationDir, "001_partial.sql"),
      "CREATE TABLE committed_table (id INTEGER); THIS IS NOT SQL",
      { mode: 0o600 },
    );
    const db = new Database(tempDb(runtimeDir));

    expect(() =>
      applyChecksumVerifiedMigrationsInOneTransaction(db, migrationDir),
    ).toThrow();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'committed_table'",
        )
        .get(),
    ).toBeUndefined();
    db.close();
  });
});

function compileOnlyPublicApiSurfaceCheck(runtimeDir: string): void {
  // @ts-expect-error public lock acquisition intentionally has no callback channel
  acquireDatabaseFileLock(runtimeDir, () => undefined);
}

void compileOnlyPublicApiSurfaceCheck;

function compileOnlyNoArbitraryPragma(store: JobStore): void {
  // @ts-expect-error callers cannot weaken durability using arbitrary PRAGMA text
  store.pragma("synchronous = OFF");
}

void compileOnlyNoArbitraryPragma;

function expectRuntimeStateDetail(
  operation: () => unknown,
  detail: string,
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeStateError);
    expect(error).toMatchObject({ detail });
    return;
  }
  throw new Error("expected BLOCKED_RUNTIME_STATE");
}
