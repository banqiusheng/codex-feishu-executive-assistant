import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { types as utilTypes } from "node:util";

import Database from "better-sqlite3";

import {
  approveAction,
  claimApprovedAction,
  finishAction,
  getAction,
  listUnknownActions,
  markDispatching,
  prepareAction,
  reconcileAction,
  startReconciliation,
} from "./actions.js";
import { cancelActiveTask } from "./control-events.js";
import { beginNextTaskAcknowledgement, finishTaskAcknowledgement, getNextTaskAcknowledgementCandidate, getTaskAcknowledgement, reconcileTaskAcknowledgement } from "./acknowledgements.js";
import { ingestEvent } from "./events.js";
import { attachDatabaseFileLock, detachDatabaseFileLock } from "./file-lock.js";
import { acquireRuntimeLease, releaseRuntimeLease } from "./leases.js";
import { applyChecksumVerifiedMigrationsInOneTransaction } from "./migrate.js";
import { bindPrincipal } from "./principals.js";
import { prepareSecureSqlitePath } from "./secure-path.js";
import {
  claimNextTask,
  createReplacementTask,
  finishTask,
  getTask,
  interruptExpiredTasks,
  markRunning,
  recoverOnStartup,
  touchTask,
} from "./tasks.js";
import {
  RuntimeStateError,
  SqliteJobStore,
  type DatabaseFileLock,
  type JobStore,
  type JobStoreOptions,
} from "./types.js";

export function migrationDirectoryForModuleUrl(moduleUrl: string): string {
  return join(dirname(fileURLToPath(moduleUrl)), "../migrations");
}

const defaultMigrationDirectory = migrationDirectoryForModuleUrl(
  import.meta.url,
);

type DatabaseFactory = (filename: string) => Database.Database;

type JobStoreOptionsSnapshot = Readonly<{
  filename: string;
  instanceId: string;
  lock: DatabaseFileLock;
}>;

function snapshotOwnDataOption(
  descriptors: Readonly<Record<string, PropertyDescriptor>>,
  key: string,
): unknown {
  const descriptor = descriptors[key];
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    !descriptor.enumerable
  ) {
    throw new RuntimeStateError(
      "job_store_options_must_be_own_data_properties",
    );
  }
  return descriptor.value;
}

function isProxy(value: object): boolean {
  try {
    return utilTypes.isProxy(value);
  } catch {
    return true;
  }
}

function snapshotJobStoreOptions(
  options: JobStoreOptions,
): JobStoreOptionsSnapshot {
  try {
    const optionsValue: unknown = options;
    if (optionsValue === null || typeof optionsValue !== "object") {
      throw new RuntimeStateError(
        "job_store_options_must_be_own_data_properties",
      );
    }
    if (isProxy(optionsValue) || Array.isArray(optionsValue)) {
      throw new RuntimeStateError(
        "job_store_options_must_be_own_data_properties",
      );
    }
    const prototype = Object.getPrototypeOf(optionsValue);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new RuntimeStateError(
        "job_store_options_must_be_own_data_properties",
      );
    }
    const optionKeys = Reflect.ownKeys(optionsValue);
    if (
      optionKeys.length !== 3 ||
      !optionKeys.every(
        (key) => key === "filename" || key === "instanceId" || key === "lock",
      )
    ) {
      throw new RuntimeStateError(
        "job_store_options_must_be_own_data_properties",
      );
    }
    const descriptors = Object.getOwnPropertyDescriptors(optionsValue);
    const filename = snapshotOwnDataOption(descriptors, "filename");
    const instanceId = snapshotOwnDataOption(descriptors, "instanceId");
    const lock = snapshotOwnDataOption(descriptors, "lock");
    const lockIsProxy =
      lock !== null && typeof lock === "object" && isProxy(lock);
    if (
      typeof filename !== "string" ||
      typeof instanceId !== "string" ||
      lock === null ||
      typeof lock !== "object" ||
      lockIsProxy
    ) {
      throw new RuntimeStateError(
        lockIsProxy
          ? "database_file_lock_is_not_active"
          : "job_store_options_are_invalid",
      );
    }
    return { filename, instanceId, lock: lock as DatabaseFileLock };
  } catch (cause) {
    if (cause instanceof RuntimeStateError) {
      throw cause;
    }
    throw new RuntimeStateError(
      "job_store_options_must_be_own_data_properties",
      cause,
    );
  }
}

function closeAndBlock(
  database: Database.Database,
  detail: string,
  cause?: unknown,
): never {
  database.close();
  throw new RuntimeStateError(detail, cause);
}

export function openJobStore(options: JobStoreOptions): JobStore {
  return openJobStoreWithMigrationDirectory(
    options,
    defaultMigrationDirectory,
    (filename) => new Database(filename),
  );
}

export function openJobStoreWithMigrationDirectory(
  options: JobStoreOptions,
  migrationDirectory: string,
  createDatabase: DatabaseFactory,
): JobStore {
  const { filename, instanceId, lock } = snapshotJobStoreOptions(options);
  attachDatabaseFileLock(lock, filename);

  let database: Database.Database | undefined;
  try {
    prepareSecureSqlitePath(filename);
    database = createDatabase(filename);
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    database.pragma("synchronous = FULL");

    const preMigration = database.pragma("integrity_check", { simple: true });
    if (preMigration !== "ok") {
      closeAndBlock(
        database,
        `pre_migration_integrity=${String(preMigration)}`,
      );
    }

    applyChecksumVerifiedMigrationsInOneTransaction(
      database,
      migrationDirectory,
    );

    const postMigration = database.pragma("integrity_check", { simple: true });
    if (postMigration !== "ok") {
      closeAndBlock(
        database,
        `post_migration_integrity=${String(postMigration)}`,
      );
    }

    if (database.pragma("journal_mode = WAL", { simple: true }) !== "wal") {
      closeAndBlock(database, "journal_mode_not_wal");
    }

    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    database.pragma("synchronous = FULL");
    const storeDatabase = database;
    return new SqliteJobStore(
      storeDatabase,
      instanceId,
      Object.freeze({
        ingestEvent: (event, workspacePath) =>
          ingestEvent(storeDatabase, event, workspacePath),
        bindPrincipal: (input) =>
          bindPrincipal(storeDatabase, instanceId, input),
        acquireRuntimeLease: (name, owner, now, ttlMs) =>
          acquireRuntimeLease(
            storeDatabase,
            instanceId,
            name,
            owner,
            now,
            ttlMs,
          ),
        releaseRuntimeLease: (name, owner) =>
          releaseRuntimeLease(storeDatabase, instanceId, name, owner),
        claimNextTask: (owner, now, ttlMs) =>
          claimNextTask(storeDatabase, instanceId, owner, now, ttlMs),
        getTaskAcknowledgement: (taskId) => getTaskAcknowledgement(storeDatabase, taskId),
        getNextTaskAcknowledgementCandidate: () => getNextTaskAcknowledgementCandidate(storeDatabase),
        beginNextTaskAcknowledgement: (input) => beginNextTaskAcknowledgement(storeDatabase, instanceId, input),
        finishTaskAcknowledgement: (input) => finishTaskAcknowledgement(storeDatabase, instanceId, input),
        reconcileTaskAcknowledgement: (input) => reconcileTaskAcknowledgement(storeDatabase, instanceId, input),
        getTask: (taskId) => getTask(storeDatabase, taskId),
        markRunning: (input) => markRunning(storeDatabase, instanceId, input),
        touchTask: (input) => touchTask(storeDatabase, instanceId, input),
        finishTask: (input) => finishTask(storeDatabase, instanceId, input),
        interruptExpiredTasks: (now) =>
          interruptExpiredTasks(storeDatabase, instanceId, now),
        recoverOnStartup: (now) =>
          recoverOnStartup(storeDatabase, instanceId, now),
        createReplacementTask: (
          interruptedTaskId,
          confirmedAt,
          workspacePath,
        ) =>
          createReplacementTask(
            storeDatabase,
            interruptedTaskId,
            confirmedAt,
            workspacePath,
          ),
        cancelActiveTask: (request) => cancelActiveTask(storeDatabase, request),
        prepareAction: (input) =>
          prepareAction(storeDatabase, instanceId, input),
        approveAction: (input) =>
          approveAction(storeDatabase, instanceId, input),
        claimApprovedAction: (input) =>
          claimApprovedAction(storeDatabase, instanceId, input),
        getAction: (ref) => getAction(storeDatabase, ref),
        listUnknownActions: () => listUnknownActions(storeDatabase),
        markDispatching: (input) =>
          markDispatching(storeDatabase, instanceId, input),
        finishAction: (input) => finishAction(storeDatabase, instanceId, input),
        startReconciliation: (input) =>
          startReconciliation(storeDatabase, instanceId, input),
        reconcileAction: (input) =>
          reconcileAction(storeDatabase, instanceId, input),
      }),
      () => {
        detachDatabaseFileLock(lock);
      },
    );
  } catch (cause) {
    if (database?.open) {
      database.close();
    }
    detachDatabaseFileLock(lock);
    if (cause instanceof RuntimeStateError) {
      throw cause;
    }
    if (database === undefined) {
      throw new RuntimeStateError("database_cannot_be_opened", cause);
    }
    throw new RuntimeStateError(
      "migration_or_database_initialization_failed",
      cause,
    );
  }
}
