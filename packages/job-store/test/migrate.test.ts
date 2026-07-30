import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { applyChecksumVerifiedMigrationsInOneTransaction } from "../src/migrate.js";
import { migrationDirectoryForModuleUrl } from "../src/open-store.js";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function createMigrationDirectory(): string {
  const path = mkdtempSync(
    join(realpathSync(tmpdir()), "job-store-migrations-"),
  );
  chmodSync(path, 0o700);
  temporaryPaths.push(path);
  return path;
}

function writeMigration(directory: string, name: string, sql: string): void {
  writeFileSync(join(directory, name), sql, { mode: 0o600 });
}

describe("checksum-verified migrations", () => {
  it("keeps the four historical checksums while appending migration 005", () => {
    const migrationDirectory = migrationDirectoryForModuleUrl(import.meta.url);
    const migrations = readdirSync(migrationDirectory)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(migrations).toEqual([
      "001_initial.sql",
      "002_task_leases_and_control_outcomes.sql",
      "003_task_acknowledgements.sql",
      "004_single_inflight_task_acknowledgement.sql",
      "005_direct_actions_resources_and_batches.sql",
    ]);
    expect(
      migrations.slice(0, 4).map((name) =>
        createHash("sha256")
          .update(readFileSync(join(migrationDirectory, name)))
          .digest("hex"),
      ),
    ).toEqual([
      "1364dcd0d3260154fc43f17c698de8d724f5b2389ee1893597ddc50826356e91",
      "5cb217a310e80619cc98ea8f60913a1df909528742ac42f9e70fed2c464797c1",
      "75b43d38bb30ea4cfe31047a90637c1945170f2e781c18163f569250f36991db",
      "7c7eaaa3fff6716df24b03039ab30d86dcda65c6c7b0aa6ab08e02cfc21c0712",
    ]);
  });

  it("rejects an empty migration manifest", () => {
    const migrationDirectory = createMigrationDirectory();
    const database = new Database(":memory:");

    expect(() =>
      applyChecksumVerifiedMigrationsInOneTransaction(
        database,
        migrationDirectory,
      ),
    ).toThrowError(/migration_manifest_is_empty/);
    database.close();
  });

  it("rejects a manifest version gap before executing migrations", () => {
    const migrationDirectory = createMigrationDirectory();
    writeMigration(
      migrationDirectory,
      "001_initial.sql",
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);",
    );
    writeMigration(
      migrationDirectory,
      "003_late.sql",
      "CREATE TABLE later_table (id INTEGER);",
    );
    const database = new Database(":memory:");

    expect(() =>
      applyChecksumVerifiedMigrationsInOneTransaction(
        database,
        migrationDirectory,
      ),
    ).toThrowError(/migration_manifest_has_gap/);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'schema_migrations'",
        )
        .get(),
    ).toBeUndefined();
    database.close();
  });

  it("rejects a historical migration gap instead of treating it as a prefix", () => {
    const migrationDirectory = createMigrationDirectory();
    writeMigration(
      migrationDirectory,
      "001_initial.sql",
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);",
    );
    writeMigration(
      migrationDirectory,
      "002_second.sql",
      "CREATE TABLE second_table (id INTEGER);",
    );
    writeMigration(
      migrationDirectory,
      "003_third.sql",
      "CREATE TABLE third_table (id INTEGER);",
    );
    const database = new Database(":memory:");
    database.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    database
      .prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      )
      .run(1, "001_initial.sql", "not-checked-yet", "2026-07-21T00:00:00.000Z");
    database
      .prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      )
      .run(3, "003_third.sql", "not-checked-yet", "2026-07-21T00:00:00.000Z");

    expect(() =>
      applyChecksumVerifiedMigrationsInOneTransaction(
        database,
        migrationDirectory,
      ),
    ).toThrowError(/migration_history_is_not_manifest_prefix/);
    database.close();
  });

  it("rejects transaction control before it can escape migration rollback", () => {
    const migrationDirectory = createMigrationDirectory();
    writeMigration(
      migrationDirectory,
      "001_escape.sql",
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL); CREATE TABLE escaped (id INTEGER); COMMIT; THIS IS NOT SQL;",
    );
    const database = new Database(":memory:");

    let thrown: unknown;
    try {
      applyChecksumVerifiedMigrationsInOneTransaction(
        database,
        migrationDirectory,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      detail: "migration_transaction_control_forbidden",
    });
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE name = 'escaped'")
        .get(),
    ).toBeUndefined();
    database.close();
  });

  it("allows TEMPORARY trigger nested CASE END and non-leading rollback words", () => {
    const migrationDirectory = createMigrationDirectory();
    writeMigration(
      migrationDirectory,
      "001_trigger.sql",
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL); CREATE TABLE source (value TEXT); CREATE TABLE audit (value TEXT); CREATE TEMPORARY TRIGGER audit_source AFTER INSERT ON source BEGIN INSERT INTO audit(value) VALUES (CASE WHEN NEW.value = 'COMMIT -- BEGIN' THEN CASE WHEN 1 THEN 'yes' ELSE 'no' END ELSE 'no' END); SELECT CASE WHEN 0 THEN RAISE(ROLLBACK, 'blocked') END; INSERT OR ROLLBACK INTO audit(value) VALUES ('ok'); /* SAVEPOINT RELEASE */ END;",
    );
    const database = new Database(":memory:");

    expect(() =>
      applyChecksumVerifiedMigrationsInOneTransaction(
        database,
        migrationDirectory,
      ),
    ).not.toThrow();
    database.close();
  });

  it.each([
    ["an unclosed single quote", "SELECT 'unterminated"],
    ["an unclosed double quote", 'SELECT "unterminated'],
    ["an unclosed backtick", "SELECT `unterminated"],
    ["an unclosed bracket identifier", "SELECT [unterminated"],
    ["an unclosed block comment", "/* unterminated"],
    ["a NUL byte", "SELECT 1;\u0000"],
    ["a NUL byte inside a single quote", "SELECT '\u0000'"],
    ["a NUL byte inside a double quote", 'SELECT "\u0000"'],
    ["a NUL byte inside a backtick identifier", "SELECT `\u0000`"],
    ["a NUL byte inside a bracket identifier", "SELECT [\u0000]"],
    ["a NUL byte inside a line comment", "-- \u0000\nSELECT 1"],
    ["a NUL byte inside a block comment", "/* \u0000 */ SELECT 1"],
  ])("rejects %s in migration SQL", (_caseName, invalidFragment) => {
    const migrationDirectory = createMigrationDirectory();
    writeMigration(
      migrationDirectory,
      "001_invalid.sql",
      `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL); ${invalidFragment}`,
    );
    const database = new Database(":memory:");

    expect(() =>
      applyChecksumVerifiedMigrationsInOneTransaction(
        database,
        migrationDirectory,
      ),
    ).toThrowError(/migration_sql_lexical_error/);
    database.close();
  });

  it.each([
    "BEGIN",
    "COMMIT",
    "END",
    "END TRANSACTION",
    "ROLLBACK",
    "SAVEPOINT one",
    "RELEASE one",
  ])("rejects bare non-trigger transaction token %s", (transactionControl) => {
    const migrationDirectory = createMigrationDirectory();
    writeMigration(
      migrationDirectory,
      "001_control.sql",
      `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL); ${transactionControl};`,
    );
    const database = new Database(":memory:");

    expect(() =>
      applyChecksumVerifiedMigrationsInOneTransaction(
        database,
        migrationDirectory,
      ),
    ).toThrowError(/migration_transaction_control_forbidden/);
    database.close();
  });

  it("allows transaction words in every quoted/comment form and identifier continuations", () => {
    const migrationDirectory = createMigrationDirectory();
    writeMigration(
      migrationDirectory,
      "001_lexical_forms.sql",
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL); CREATE TABLE COMMIT$column (é INTEGER, \"ROLLBACK\" TEXT, `SAVEPOINT` TEXT, [RELEASE] TEXT, literal TEXT DEFAULT 'BEGIN'); -- END TRANSACTION\n/* COMMIT SAVEPOINT */",
    );
    const database = new Database(":memory:");

    expect(() =>
      applyChecksumVerifiedMigrationsInOneTransaction(
        database,
        migrationDirectory,
      ),
    ).not.toThrow();
    database.close();
  });

  it.each([
    ["a nonconforming lower-case SQL filename", "second.sql"],
    ["an upper-case SQL extension", "001_upper.SQL"],
  ])("rejects %s", (_caseName, filename) => {
    const migrationDirectory = createMigrationDirectory();
    writeMigration(migrationDirectory, filename, "SELECT 1;");
    const database = new Database(":memory:");

    expect(() =>
      applyChecksumVerifiedMigrationsInOneTransaction(
        database,
        migrationDirectory,
      ),
    ).toThrowError(/migration_sql_name_invalid/);
    database.close();
  });

  it("rejects a symbolic-link SQL entry and ignores ordinary non-SQL files", () => {
    const migrationDirectory = createMigrationDirectory();
    writeFileSync(join(migrationDirectory, "notes.txt"), "ordinary file", {
      mode: 0o600,
    });
    const target = join(migrationDirectory, "target.txt");
    writeFileSync(target, "SELECT 1;", { mode: 0o600 });
    symlinkSync(target, join(migrationDirectory, "001_link.sql"));
    mkdirSync(join(migrationDirectory, "not-a-migration"), { mode: 0o700 });
    const database = new Database(":memory:");

    expect(() =>
      applyChecksumVerifiedMigrationsInOneTransaction(
        database,
        migrationDirectory,
      ),
    ).toThrowError(/migration_sql_entry_is_not_regular_file/);
    database.close();
  });

  it("ignores ordinary non-SQL files when valid migrations exist", () => {
    const migrationDirectory = createMigrationDirectory();
    writeFileSync(join(migrationDirectory, "notes.txt"), "ordinary file", {
      mode: 0o600,
    });
    writeMigration(
      migrationDirectory,
      "001_initial.sql",
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);",
    );
    const database = new Database(":memory:");

    expect(() =>
      applyChecksumVerifiedMigrationsInOneTransaction(
        database,
        migrationDirectory,
      ),
    ).not.toThrow();
    database.close();
  });
});
