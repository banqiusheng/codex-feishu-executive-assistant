import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const FAIL = "fail\n";

function fail() {
  process.stderr.write(FAIL);
  process.exit(1);
}

function identity(candidate) {
  const stat = fs.lstatSync(candidate);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.nlink !== 1 ||
    fs.realpathSync(candidate) !== candidate
  ) {
    fail();
  }
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    uid: stat.uid,
  });
}

function sameIdentity(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.size === after.size &&
    before.uid === after.uid
  );
}

try {
  const args = process.argv.slice(2);
  if (
    args.length !== 1 ||
    typeof args[0] !== "string" ||
    !path.isAbsolute(args[0]) ||
    args[0].includes("\0")
  ) {
    fail();
  }

  const databasePath = args[0];
  const before = identity(databasePath);
  const requireFromJobStore = createRequire(
    path.join(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      "packages",
      "job-store",
      "package.json",
    ),
  );
  const Database = requireFromJobStore("better-sqlite3");
  const database = new Database(databasePath, {
    fileMustExist: true,
    readonly: true,
  });
  let quickCheck;
  try {
    quickCheck = database.pragma("quick_check", { simple: true });
  } finally {
    database.close();
  }

  const after = identity(databasePath);
  if (quickCheck !== "ok" || !sameIdentity(before, after)) {
    fail();
  }
  process.stdout.write("ok\n");
} catch {
  fail();
}
