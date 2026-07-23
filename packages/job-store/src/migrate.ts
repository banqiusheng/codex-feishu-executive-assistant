import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";

import { RuntimeStateError } from "./types.js";

type Migration = Readonly<{
  version: number;
  name: string;
  checksum: string;
  sql: string;
}>;

type AppliedMigration = Readonly<{
  version: number;
  name: string;
  checksum: string;
}>;

function isIdentifierStart(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return (
    character === "_" ||
    (codePoint !== undefined &&
      ((codePoint >= 0x41 && codePoint <= 0x5a) ||
        (codePoint >= 0x61 && codePoint <= 0x7a) ||
        codePoint > 0x7f))
  );
}

function isIdentifierContinuation(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return (
    character === "$" ||
    isIdentifierStart(character) ||
    (codePoint !== undefined && codePoint >= 0x30 && codePoint <= 0x39)
  );
}

function migrationManifest(migrationDirectory: string): Migration[] {
  const migrationEntries = readdirSync(migrationDirectory, {
    withFileTypes: true,
  }).filter((entry) => entry.name.toLowerCase().endsWith(".sql"));

  for (const entry of migrationEntries) {
    if (!entry.isFile()) {
      throw new RuntimeStateError("migration_sql_entry_is_not_regular_file");
    }
    if (!/^\d+_.+\.sql$/.test(entry.name)) {
      throw new RuntimeStateError("migration_sql_name_invalid");
    }
  }

  const migrations = migrationEntries
    .map((entry) => {
      const versionText = entry.name.split("_", 1)[0];
      const version = Number(versionText);
      if (!Number.isSafeInteger(version)) {
        throw new RuntimeStateError("migration_version_is_invalid");
      }
      const sql = readFileSync(join(migrationDirectory, entry.name), "utf8");
      assertMigrationSqlHasNoTransactionControl(sql);
      return {
        version,
        name: entry.name,
        checksum: createHash("sha256").update(sql).digest("hex"),
        sql,
      };
    })
    .sort((left, right) => left.version - right.version);

  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index - 1]?.version === migrations[index]?.version) {
      throw new RuntimeStateError("migration_version_is_duplicated");
    }
  }

  if (migrations.length === 0) {
    throw new RuntimeStateError("migration_manifest_is_empty");
  }

  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1) {
      throw new RuntimeStateError("migration_manifest_has_gap");
    }
  }

  return migrations;
}

function migrationSqlTokens(sql: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];
    const nextCharacter = sql[index + 1];
    if (character === undefined) {
      break;
    }
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "-" && nextCharacter === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") {
        index += 1;
      }
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) {
        throw new RuntimeStateError("migration_sql_lexical_error");
      }
      index = end + 2;
      continue;
    }
    if (
      character === "'" ||
      character === '"' ||
      character === "`" ||
      character === "["
    ) {
      const quote = character;
      const closingQuote = quote === "[" ? "]" : quote;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === closingQuote) {
          if (quote !== "[" && sql[index + 1] === closingQuote) {
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) {
        throw new RuntimeStateError("migration_sql_lexical_error");
      }
      continue;
    }
    if (character === ";") {
      tokens.push(";");
      index += 1;
      continue;
    }
    if (isIdentifierStart(character)) {
      const start = index;
      index += 1;
      while (index < sql.length && isIdentifierContinuation(sql[index] ?? "")) {
        index += 1;
      }
      tokens.push(sql.slice(start, index).toUpperCase());
      continue;
    }
    index += 1;
  }

  return tokens;
}

function isCreateTriggerHeader(words: string[]): boolean {
  return (
    words[0] === "CREATE" &&
    (words[1] === "TRIGGER" ||
      ((words[1] === "TEMP" || words[1] === "TEMPORARY") &&
        words[2] === "TRIGGER"))
  );
}

function isTransactionControlToken(token: string): boolean {
  return (
    token === "BEGIN" ||
    token === "COMMIT" ||
    token === "END" ||
    token === "ROLLBACK" ||
    token === "SAVEPOINT" ||
    token === "RELEASE"
  );
}

function assertMigrationSqlHasNoTransactionControl(sql: string): void {
  if (sql.includes("\u0000")) {
    throw new RuntimeStateError("migration_sql_lexical_error");
  }

  let topLevelStatementWords: string[] = [];
  let topLevelStatementStart = true;
  let inTrigger = false;
  let triggerStatementStart = false;
  let caseDepth = 0;
  let afterTriggerEnd = false;

  for (const token of migrationSqlTokens(sql)) {
    if (token === ";") {
      if (afterTriggerEnd) {
        afterTriggerEnd = false;
        topLevelStatementWords = [];
        topLevelStatementStart = true;
      } else if (inTrigger) {
        triggerStatementStart = true;
      } else {
        topLevelStatementWords = [];
        topLevelStatementStart = true;
      }
      continue;
    }
    if (afterTriggerEnd) {
      throw new RuntimeStateError("migration_sql_lexical_error");
    }
    if (inTrigger) {
      if (token === "CASE") {
        caseDepth += 1;
        triggerStatementStart = false;
        continue;
      }
      if (token === "END") {
        if (caseDepth > 0) {
          caseDepth -= 1;
          triggerStatementStart = false;
          continue;
        }
        if (!triggerStatementStart) {
          throw new RuntimeStateError(
            "migration_transaction_control_forbidden",
          );
        }
        inTrigger = false;
        afterTriggerEnd = true;
        continue;
      }
      if (triggerStatementStart && isTransactionControlToken(token)) {
        throw new RuntimeStateError("migration_transaction_control_forbidden");
      }
      triggerStatementStart = false;
      continue;
    }
    const atTopLevelStatementStart = topLevelStatementStart;
    if (atTopLevelStatementStart) {
      topLevelStatementWords = [];
      topLevelStatementStart = false;
    }
    topLevelStatementWords.push(token);
    if (token === "BEGIN" && isCreateTriggerHeader(topLevelStatementWords)) {
      inTrigger = true;
      triggerStatementStart = true;
      caseDepth = 0;
      continue;
    }
    if (atTopLevelStatementStart && isTransactionControlToken(token)) {
      throw new RuntimeStateError("migration_transaction_control_forbidden");
    }
  }

  if (inTrigger || caseDepth > 0) {
    throw new RuntimeStateError("migration_sql_lexical_error");
  }
}

function migrationTableExists(database: Database.Database): boolean {
  return (
    database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get() !== undefined
  );
}

function assertAppliedMigrationsMatchManifest(
  applied: AppliedMigration[],
  migrations: Migration[],
): void {
  if (applied.length > migrations.length) {
    throw new RuntimeStateError("migration_history_is_not_manifest_prefix");
  }

  for (const [index, recorded] of applied.entries()) {
    const migration = migrations[index];
    if (migration === undefined || recorded.version !== migration.version) {
      throw new RuntimeStateError("migration_history_is_not_manifest_prefix");
    }
  }

  for (const [index, recorded] of applied.entries()) {
    const migration = migrations[index];
    if (
      migration === undefined ||
      recorded.name !== migration.name ||
      migration.checksum !== recorded.checksum
    ) {
      throw new RuntimeStateError("migration_checksum_drift");
    }
  }
}

export function applyChecksumVerifiedMigrationsInOneTransaction(
  database: Database.Database,
  migrationDirectory: string,
): void {
  const migrations = migrationManifest(migrationDirectory);

  database.transaction(() => {
    const applied = migrationTableExists(database)
      ? (database
          .prepare(
            "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
          )
          .all() as AppliedMigration[])
      : [];
    assertAppliedMigrationsMatchManifest(applied, migrations);
    for (const [index, migration] of migrations.entries()) {
      if (index < applied.length) {
        continue;
      }
      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          migration.version,
          migration.name,
          migration.checksum,
          new Date().toISOString(),
        );
    }
  })();
}
