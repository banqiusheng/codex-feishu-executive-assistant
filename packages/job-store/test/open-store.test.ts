import { createHash, randomUUID } from "node:crypto";
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
    ).toEqual({ count: 5 });
    verificationDb.close();
  });

  it("forwards a real v1-only database through all migrations while preserving controls with pending defaulted false", async () => {
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
    ).toEqual({ count: 5 });
    verification.close();
  });

  it("upgrades a database with the predecessor migration 003 checksum through append-only migration 004", async () => {
    const runtimeDir = createRuntimeDirectory();
    const filename = tempDb(runtimeDir);
    const predecessorMigrations = join(runtimeDir, "predecessor-migrations");
    const currentMigrations = migrationDirectoryForModuleUrl(import.meta.url);
    mkdirSync(predecessorMigrations, { mode: 0o700 });
    for (const migration of [
      "001_initial.sql",
      "002_task_leases_and_control_outcomes.sql",
    ]) {
      writeFileSync(
        join(predecessorMigrations, migration),
        readFileSync(join(currentMigrations, migration), "utf8"),
        { mode: 0o600 },
      );
    }
    const predecessorMigration003 = readFileSync(
      join(
        dirname(currentMigrations),
        "test",
        "fixtures",
        "003_task_acknowledgements_predecessor.sql",
      ),
      "utf8",
    );
    expect(
      createHash("sha256").update(predecessorMigration003).digest("hex"),
    ).toBe("75b43d38bb30ea4cfe31047a90637c1945170f2e781c18163f569250f36991db");
    writeFileSync(
      join(predecessorMigrations, "003_task_acknowledgements.sql"),
      predecessorMigration003,
      { mode: 0o600 },
    );

    const lock = await acquireLock(runtimeDir);
    const predecessor = openJobStoreWithMigrationDirectory(
      { filename, instanceId: "instance-a", lock },
      predecessorMigrations,
      (path) => new Database(path),
    );
    predecessor.close();

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
          "SELECT version, name FROM schema_migrations WHERE version >= 3 ORDER BY version",
        )
        .all(),
    ).toEqual([
      { version: 3, name: "003_task_acknowledgements.sql" },
      {
        version: 4,
        name: "004_single_inflight_task_acknowledgement.sql",
      },
      {
        version: 5,
        name: "005_direct_actions_resources_and_batches.sql",
      },
    ]);
    expect(
      verification
        .prepare("PRAGMA index_info(one_inflight_task_acknowledgement)")
        .all(),
    ).toEqual([{ seqno: 0, cid: 1, name: "state" }]);
    verification.close();
  });

  it("upgrades a real v4 ledger without losing action audit rows or foreign keys", async () => {
    const runtimeDir = createRuntimeDirectory();
    const filename = tempDb(runtimeDir);
    const v4Migrations = join(runtimeDir, "v4-migrations");
    const currentMigrations = migrationDirectoryForModuleUrl(import.meta.url);
    mkdirSync(v4Migrations, { mode: 0o700 });
    for (const migration of [
      "001_initial.sql",
      "002_task_leases_and_control_outcomes.sql",
      "003_task_acknowledgements.sql",
      "004_single_inflight_task_acknowledgement.sql",
    ]) {
      writeFileSync(
        join(v4Migrations, migration),
        readFileSync(join(currentMigrations, migration)),
        { mode: 0o600 },
      );
    }

    const inboundEventId = randomUUID();
    const taskId = randomUUID();
    const actionId = randomUUID();
    const reconciliationActionId = randomUUID();
    const attemptId = randomUUID();
    const actorHash = createHash("sha256")
      .update("ou_v4_fixture")
      .digest("hex");
    const chatHash = createHash("sha256").update("oc_v4_fixture").digest("hex");
    const payloadJson = '{"body":"v4 fixture"}';
    const payloadHash = `sha256:${createHash("sha256")
      .update(payloadJson)
      .digest("hex")}`;
    const resultJson = '{"outcome":"SUCCEEDED","remoteId":"remote_v4_fixture"}';
    const resultDigest = `sha256:${createHash("sha256")
      .update(resultJson)
      .digest("hex")}`;
    const requestDigest = `sha256:${"b".repeat(64)}`;
    const createdAt = "2026-07-29T08:00:10.000Z";
    const approvedAt = "2026-07-29T08:00:11.000Z";
    const claimedAt = "2026-07-29T08:00:12.000Z";
    const dispatchingAt = "2026-07-29T08:00:13.000Z";
    const finishedAt = "2026-07-29T08:00:14.000Z";
    const expiresAt = "2026-07-29T08:30:10.000Z";

    const v4 = new Database(filename);
    v4.pragma("foreign_keys = ON");
    applyChecksumVerifiedMigrationsInOneTransaction(v4, v4Migrations);
    v4.prepare(
      `INSERT INTO inbound_events(
         id, app_id, tenant_key, event_id, message_id,
         sender_open_id_hash, chat_id_hash, payload_ref, received_at
       ) VALUES (?, 'app-v4', 'tenant-v4', 'event-v4', 'message-v4',
                 ?, ?, ?, ?)`,
    ).run(
      inboundEventId,
      actorHash,
      chatHash,
      `sha256:${"a".repeat(64)}`,
      "2026-07-29T08:00:00.000Z",
    );
    v4.prepare(
      `INSERT INTO tasks(
         id, inbound_event_id, state, workspace_path, stage,
         lease_owner, lease_expires_at, codex_session_id,
         created_at, updated_at
       ) VALUES (?, ?, 'RUNNING', '/fixture/v4', 'RUNNING_CODEX',
                 'instance-a', '2026-07-29T09:00:00.000Z',
                 'codex-v4-fixture', ?, ?)`,
    ).run(taskId, inboundEventId, createdAt, finishedAt);
    v4.prepare(
      `INSERT INTO actions(
         id, task_id, version, capability, identity, approval_mode, state,
         payload_json, payload_hash, preview_json, actor_open_id_hash,
         chat_id_hash, nonce_hash, idempotency_key, expires_at,
         remote_id, result_json, created_at, updated_at
       ) VALUES (?, ?, 1, 'message.send', 'bot', 'president', 'SUCCEEDED',
                 ?, ?, ?, ?, ?, ?, ?, ?, 'remote_v4_fixture', ?, ?, ?)`,
    ).run(
      actionId,
      taskId,
      payloadJson,
      payloadHash,
      payloadJson,
      actorHash,
      chatHash,
      createHash("sha256").update("nonce-v4-fixture").digest("hex"),
      actionId,
      expiresAt,
      resultJson,
      createdAt,
      finishedAt,
    );
    v4.prepare(
      `INSERT INTO actions(
         id, task_id, version, capability, identity, approval_mode, state,
         payload_json, payload_hash, preview_json, actor_open_id_hash,
         chat_id_hash, nonce_hash, idempotency_key, expires_at,
         remote_id, result_json, created_at, updated_at
       ) VALUES (?, ?, 1, 'calendar.create', 'user', 'president', 'SUCCEEDED',
                 ?, ?, ?, ?, ?, ?, ?, ?, 'remote_reconciliation_fixture', ?, ?, ?)`,
    ).run(
      reconciliationActionId,
      taskId,
      payloadJson,
      payloadHash,
      payloadJson,
      actorHash,
      chatHash,
      createHash("sha256")
        .update("nonce-v4-reconciliation-fixture")
        .digest("hex"),
      `${reconciliationActionId}-idempotency`,
      expiresAt,
      resultJson,
      createdAt,
      finishedAt,
    );
    for (const transition of [
      [null, "PREPARED", "prepared", createdAt],
      ["PREPARED", "APPROVED", "approved", approvedAt],
      ["APPROVED", "CLAIMED", "claimed", claimedAt],
      ["CLAIMED", "DISPATCHING", "dispatch_started", dispatchingAt],
      ["DISPATCHING", "SUCCEEDED", "dispatch_finished", finishedAt],
    ] as const) {
      v4.prepare(
        `INSERT INTO action_transitions(
           action_id, from_state, to_state, reason_code, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      ).run(actionId, ...transition);
    }
    v4.prepare(
      `INSERT INTO approvals(
         id, action_id, action_version, actor_open_id_hash, chat_id_hash,
         payload_hash, nonce_hash, decision, decided_at
       ) VALUES (?, ?, 1, ?, ?, ?, ?, 'APPROVED', ?)`,
    ).run(
      randomUUID(),
      actionId,
      actorHash,
      chatHash,
      payloadHash,
      createHash("sha256").update("nonce-v4-fixture").digest("hex"),
      approvedAt,
    );
    v4.prepare(
      `INSERT INTO action_attempts(
         id, action_id, attempt_id, phase, attempt_kind,
         request_digest, created_at
       ) VALUES (?, ?, ?, 'STARTED', 'DISPATCH', ?, ?)`,
    ).run(randomUUID(), actionId, attemptId, requestDigest, dispatchingAt);
    v4.prepare(
      `INSERT INTO action_attempts(
         id, action_id, attempt_id, phase, attempt_kind, outcome,
         request_digest, result_digest, remote_id, created_at
       ) VALUES (?, ?, ?, 'FINISHED', 'DISPATCH', 'SUCCEEDED',
                 ?, ?, 'remote_v4_fixture', ?)`,
    ).run(
      randomUUID(),
      actionId,
      attemptId,
      requestDigest,
      resultDigest,
      finishedAt,
    );
    v4.prepare(
      `INSERT INTO reconciliations(
         id, action_id, outcome, evidence_digest, operator_kind, created_at
       ) VALUES (?, ?, 'SUCCEEDED', ?, 'manual', ?)`,
    ).run(
      randomUUID(),
      reconciliationActionId,
      `sha256:${"c".repeat(64)}`,
      finishedAt,
    );
    expect(v4.pragma("foreign_key_check")).toEqual([]);
    v4.close();
    chmodSync(filename, 0o600);

    const lock = await acquireLock(runtimeDir);
    const upgraded = openJobStore({
      filename,
      instanceId: "instance-a",
      lock,
    });
    openStores.push(upgraded);
    expect(upgraded.getAction({ actionId, version: 1 })).toMatchObject({
      actionId,
      taskId,
      approvalMode: "president",
      state: "SUCCEEDED",
      result: { outcome: "SUCCEEDED", remoteId: "remote_v4_fixture" },
    });

    const verification = new Database(filename, { readonly: true });
    expect(verification.pragma("foreign_key_check")).toEqual([]);
    expect(
      verification
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM actions WHERE id = ?) AS actions,
             (SELECT COUNT(*) FROM approvals WHERE action_id = ?) AS approvals,
             (SELECT COUNT(*) FROM action_transitions WHERE action_id = ?) AS transitions,
             (SELECT COUNT(*) FROM action_attempts WHERE action_id = ?) AS attempts,
             (SELECT COUNT(*) FROM reconciliations WHERE action_id = ?) AS reconciliations`,
        )
        .get(actionId, actionId, actionId, actionId, reconciliationActionId),
    ).toEqual({
      actions: 1,
      approvals: 1,
      transitions: 5,
      attempts: 2,
      reconciliations: 1,
    });
    expect(
      verification
        .prepare(
          "SELECT version, checksum FROM schema_migrations ORDER BY version",
        )
        .all(),
    ).toEqual([
      {
        version: 1,
        checksum:
          "1364dcd0d3260154fc43f17c698de8d724f5b2389ee1893597ddc50826356e91",
      },
      {
        version: 2,
        checksum:
          "5cb217a310e80619cc98ea8f60913a1df909528742ac42f9e70fed2c464797c1",
      },
      {
        version: 3,
        checksum:
          "75b43d38bb30ea4cfe31047a90637c1945170f2e781c18163f569250f36991db",
      },
      {
        version: 4,
        checksum:
          "7c7eaaa3fff6716df24b03039ab30d86dcda65c6c7b0aa6ab08e02cfc21c0712",
      },
      { version: 5, checksum: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    expect(
      verification
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table'
              AND name IN (
                'instruction_authorizations',
                'clarification_options',
                'clarification_selections',
                'task_resources',
                'notification_batches',
                'notification_parts'
              )
            ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "clarification_options" },
      { name: "clarification_selections" },
      { name: "instruction_authorizations" },
      { name: "notification_batches" },
      { name: "notification_parts" },
      { name: "task_resources" },
    ]);
    expect(
      verification
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'trigger'
              AND name IN ('actions_frozen_payload', 'actions_legal_state_transition')
            ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "actions_frozen_payload" },
      { name: "actions_legal_state_transition" },
    ]);
    expect(
      verification
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'one_president_pending_action_per_task'",
        )
        .get(),
    ).toMatchObject({
      sql: expect.stringMatching(/approval_mode='president'/),
    });
    verification.close();
  });

  it("preserves confirmation semantics while adding direct-action and append-only ledger constraints", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    applyChecksumVerifiedMigrationsInOneTransaction(
      database,
      migrationDirectoryForModuleUrl(import.meta.url),
    );
    const inboundEventId = randomUUID();
    const taskId = randomUUID();
    const actorHash = createHash("sha256").update("actor").digest("hex");
    const chatHash = createHash("sha256").update("chat").digest("hex");
    const now = "2026-07-29T08:00:00.000Z";
    database
      .prepare(
        `INSERT INTO inbound_events(
           id, app_id, tenant_key, event_id, message_id,
           sender_open_id_hash, chat_id_hash, payload_ref, received_at
         ) VALUES (?, 'app', 'tenant', 'event', 'message', ?, ?, ?, ?)`,
      )
      .run(
        inboundEventId,
        actorHash,
        chatHash,
        `sha256:${"a".repeat(64)}`,
        now,
      );
    database
      .prepare(
        `INSERT INTO tasks(
           id, inbound_event_id, state, workspace_path, stage, created_at, updated_at
         ) VALUES (?, ?, 'RUNNING', '/fixture', 'RUNNING_CODEX', ?, ?)`,
      )
      .run(taskId, inboundEventId, now, now);

    const insertAction = (
      id: string,
      capability: string,
      approvalMode: string,
      identity = "bot",
      actionTaskId = taskId,
    ): void => {
      database
        .prepare(
          `INSERT INTO actions(
             id, task_id, version, capability, identity, approval_mode, state,
             payload_json, payload_hash, preview_json, actor_open_id_hash,
             chat_id_hash, nonce_hash, idempotency_key, expires_at,
             created_at, updated_at
           ) VALUES (?, ?, 1, ?, ?, ?, 'PREPARED',
                     '{}', ?, '{}', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          actionTaskId,
          capability,
          identity,
          approvalMode,
          `sha256:${"b".repeat(64)}`,
          actorHash,
          chatHash,
          `nonce-${id}`,
          `idempotency-${id}`,
          "2026-07-29T08:30:00.000Z",
          now,
          now,
        );
    };

    const presidentActionId = randomUUID();
    insertAction(presidentActionId, "message.send", "president");
    expect(() =>
      insertAction(randomUUID(), "calendar.create", "president"),
    ).toThrow(/UNIQUE constraint failed: actions.task_id/);

    const instructionActionId = randomUUID();
    expect(() =>
      insertAction(
        instructionActionId,
        "calendar.create.direct",
        "president_instruction",
        "user",
      ),
    ).not.toThrow();
    expect(() =>
      insertAction(randomUUID(), "calendar.create.direct", "unknown_mode"),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      insertAction(randomUUID(), "system_reply", "president_instruction"),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      insertAction(randomUUID(), "system_reply", "system_policy"),
    ).not.toThrow();

    const otherInboundEventId = randomUUID();
    const otherTaskId = randomUUID();
    database
      .prepare(
        `INSERT INTO inbound_events(
           id, app_id, tenant_key, event_id, message_id,
           sender_open_id_hash, chat_id_hash, payload_ref, received_at
         ) VALUES (?, 'app', 'tenant', 'event-other', 'message-other', ?, ?, ?, ?)`,
      )
      .run(
        otherInboundEventId,
        actorHash,
        chatHash,
        `sha256:${"g".repeat(64)}`,
        now,
      );
    database
      .prepare(
        `INSERT INTO tasks(
           id, inbound_event_id, state, workspace_path, stage, created_at, updated_at
         ) VALUES (?, ?, 'RUNNING', '/fixture-other', 'RUNNING_CODEX', ?, ?)`,
      )
      .run(otherTaskId, otherInboundEventId, now, now);
    const otherInstructionActionId = randomUUID();
    insertAction(
      otherInstructionActionId,
      "calendar.create.direct",
      "president_instruction",
      "user",
      otherTaskId,
    );

    const insertAuthorization = (
      actionId: string,
      actionVersion: number,
      authorizationTaskId: string,
      authorizationInboundEventId: string,
      capability: string,
      payloadHash: string,
      itemKey: string,
    ): void => {
      database
        .prepare(
          `INSERT INTO instruction_authorizations(
             action_id, action_version, task_id, inbound_event_id,
             capability, payload_hash, item_key, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          actionId,
          actionVersion,
          authorizationTaskId,
          authorizationInboundEventId,
          capability,
          payloadHash,
          itemKey,
          now,
        );
    };

    insertAuthorization(
      instructionActionId,
      1,
      taskId,
      inboundEventId,
      "calendar.create.direct",
      `sha256:${"b".repeat(64)}`,
      "calendar-primary",
    );
    for (const invalidAuthorization of [
      {
        actionId: presidentActionId,
        actionVersion: 1,
        taskId,
        inboundEventId,
        capability: "message.send",
        payloadHash: `sha256:${"b".repeat(64)}`,
        itemKey: "president-is-not-direct",
      },
      {
        actionId: otherInstructionActionId,
        actionVersion: 1,
        taskId,
        inboundEventId,
        capability: "calendar.create.direct",
        payloadHash: `sha256:${"b".repeat(64)}`,
        itemKey: "action-task-mismatch",
      },
      {
        actionId: instructionActionId,
        actionVersion: 1,
        taskId,
        inboundEventId: otherInboundEventId,
        capability: "calendar.create.direct",
        payloadHash: `sha256:${"b".repeat(64)}`,
        itemKey: "inbound-event-mismatch",
      },
      {
        actionId: instructionActionId,
        actionVersion: 1,
        taskId,
        inboundEventId,
        capability: "calendar.update.direct",
        payloadHash: `sha256:${"b".repeat(64)}`,
        itemKey: "capability-mismatch",
      },
      {
        actionId: instructionActionId,
        actionVersion: 1,
        taskId,
        inboundEventId,
        capability: "calendar.create.direct",
        payloadHash: `sha256:${"h".repeat(64)}`,
        itemKey: "payload-mismatch",
      },
      {
        actionId: instructionActionId,
        actionVersion: 2,
        taskId,
        inboundEventId,
        capability: "calendar.create.direct",
        payloadHash: `sha256:${"b".repeat(64)}`,
        itemKey: "version-mismatch",
      },
    ]) {
      expect(() =>
        insertAuthorization(
          invalidAuthorization.actionId,
          invalidAuthorization.actionVersion,
          invalidAuthorization.taskId,
          invalidAuthorization.inboundEventId,
          invalidAuthorization.capability,
          invalidAuthorization.payloadHash,
          invalidAuthorization.itemKey,
        ),
      ).toThrow(/action_instruction_authorization_mismatch/);
    }
    expect(() =>
      database
        .prepare("UPDATE instruction_authorizations SET item_key = 'changed'")
        .run(),
    ).toThrow(/append only/);

    const groupId = randomUUID();
    database
      .prepare(
        `INSERT INTO clarification_options(
           group_id, group_label, option_ordinal, option_ref, kind,
           source_task_id, principal_hash, chat_hash, value_json,
           display_label, expires_at, payload_hash, created_at
         ) VALUES (?, 'choices', 1, ?, 'contact', ?, ?, ?, '{}', 'choice', ?, ?, ?)`,
      )
      .run(
        groupId,
        randomUUID(),
        taskId,
        actorHash,
        chatHash,
        "2026-07-29T08:30:00.000Z",
        `sha256:${"c".repeat(64)}`,
        now,
      );
    expect(() =>
      database.prepare("DELETE FROM clarification_options").run(),
    ).toThrow(/append only/);
    database
      .prepare(
        `INSERT INTO task_resources(
           id, task_id, resource_ref, source_kind, source_message_hash,
           kind, display_name, relative_path, size_bytes, sha256, created_at
         ) VALUES (?, ?, ?, 'current', ?, 'file', 'fixture.pdf',
                   'resources/fixture.pdf', 7, ?, ?)`,
      )
      .run(
        randomUUID(),
        taskId,
        randomUUID(),
        `sha256:${"d".repeat(64)}`,
        `sha256:${"e".repeat(64)}`,
        now,
      );
    const batchId = randomUUID();
    database
      .prepare(
        `INSERT INTO notification_batches(
           id, task_id, batch_key_hash, recipient_count, state, created_at, updated_at
         ) VALUES (?, ?, ?, 1, 'PREPARED', ?, ?)`,
      )
      .run(batchId, taskId, `sha256:${"f".repeat(64)}`, now, now);
    database
      .prepare(
        `INSERT INTO notification_parts(
           id, batch_id, recipient_ordinal, action_id, part_ordinal,
           part_kind, idempotency_key, state, attempt_count, created_at, updated_at
         ) VALUES (?, ?, 1, ?, 1, 'content', ?, 'PENDING', 0, ?, ?)`,
      )
      .run(randomUUID(), batchId, instructionActionId, randomUUID(), now, now);
    expect(() =>
      database
        .prepare(
          `INSERT INTO notification_parts(
             id, batch_id, recipient_ordinal, action_id, part_ordinal,
             part_kind, idempotency_key, state, attempt_count, created_at, updated_at
           ) VALUES (?, ?, 2, ?, 2, 'content', ?, 'PENDING', 0, ?, ?)`,
        )
        .run(
          randomUUID(),
          batchId,
          instructionActionId,
          randomUUID(),
          now,
          now,
        ),
    ).toThrow(/notification_recipient_ordinal_out_of_range/);
    expect(() =>
      database
        .prepare(
          `INSERT INTO notification_parts(
             id, batch_id, recipient_ordinal, action_id, part_ordinal,
             part_kind, idempotency_key, state, attempt_count, created_at, updated_at
           ) VALUES (?, ?, 1, ?, 1, 'content', ?, 'PENDING', 0, ?, ?)`,
        )
        .run(randomUUID(), batchId, presidentActionId, randomUUID(), now, now),
    ).toThrow(/notification_recipient_action_mismatch/);
    expect(() =>
      database
        .prepare("UPDATE notification_parts SET state = 'SUCCEEDED'")
        .run(),
    ).toThrow(/illegal notification part state transition/);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(database.pragma("integrity_check")).toEqual([
      { integrity_check: "ok" },
    ]);
    database.close();
  });

  it("wires president-instruction authorization on the public store", async () => {
    const store = await openStore();
    expect(store.authorizePresidentInstructionAction).toBeTypeOf("function");
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
