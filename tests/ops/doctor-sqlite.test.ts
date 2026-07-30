import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

type SqliteDatabase = {
  close(): void;
  exec(sql: string): void;
  pragma(sql: string, options: { simple: true }): unknown;
};

type SqliteConstructor = new (
  filename: string,
  options?: Readonly<{
    fileMustExist?: boolean;
    readonly?: boolean;
  }>,
) => SqliteDatabase;

const repositoryRoot = resolve(import.meta.dirname, "../..");
const doctorPath = join(repositoryRoot, "scripts", "doctor");
const sqliteDoctorPath = join(repositoryRoot, "scripts", "doctor-sqlite.mjs");
const requireFromJobStore = createRequire(
  join(repositoryRoot, "packages", "job-store", "package.json"),
);
const Database = requireFromJobStore("better-sqlite3") as SqliteConstructor;
const temporaryRoots: string[] = [];

type DoctorFixture = Readonly<{
  configPath: string;
  databasePath: string;
  doctorPath: string;
  fakeSystemSqliteLog: string;
  root: string;
  sqliteDoctorPath: string;
}>;

function createHealthyDatabase(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    database.exec(`
      CREATE TABLE hidden_doctor_fixture(
        value INTEGER DEFAULT 1_000
      );
      INSERT INTO hidden_doctor_fixture(value) VALUES (7);
    `);
    expect(database.pragma("quick_check", { simple: true })).toBe("ok");
  } finally {
    database.close();
  }
  chmodSync(databasePath, 0o600);
}

function createDoctorFixture(): DoctorFixture {
  const createdRoot = mkdtempSync(join(tmpdir(), "ea-doctor-sqlite-"));
  const root = realpathSync(createdRoot);
  temporaryRoots.push(root);

  const scriptsRoot = join(root, "scripts");
  const configRoot = join(root, "config");
  const runtimeRoot = join(root, "runtime");
  const jobStoreRoot = join(root, "packages", "job-store");
  const jobStoreModules = join(jobStoreRoot, "node_modules");
  const fakeBin = join(root, "fake-bin");
  for (const directory of [
    scriptsRoot,
    configRoot,
    runtimeRoot,
    jobStoreModules,
    fakeBin,
    join(root, "home"),
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  for (const script of [
    "doctor-feishu-network.mjs",
    "feishu-scope-contract.mjs",
    "feishu-user-auth.mjs",
  ]) {
    cpSync(join(repositoryRoot, "scripts", script), join(scriptsRoot, script));
  }
  cpSync(
    join(repositoryRoot, "config", "feishu-scopes.json"),
    join(configRoot, "feishu-scopes.json"),
  );
  cpSync(
    join(repositoryRoot, "packages", "job-store", "package.json"),
    join(jobStoreRoot, "package.json"),
  );
  symlinkSync(
    realpathSync(
      join(
        repositoryRoot,
        "packages",
        "job-store",
        "node_modules",
        "better-sqlite3",
      ),
    ),
    join(jobStoreModules, "better-sqlite3"),
    "dir",
  );
  if (existsSync(sqliteDoctorPath)) {
    cpSync(sqliteDoctorPath, join(scriptsRoot, "doctor-sqlite.mjs"));
  }

  const fakeSystemSqliteLog = join(root, "system-sqlite-invoked.log");
  const fakeSystemSqlite = join(fakeBin, "sqlite3");
  writeFileSync(
    fakeSystemSqlite,
    [
      "#!/bin/zsh",
      'print -r -- "invoked" >> "${SQLITE_INVOCATION_LOG}"',
      'print -u2 -r -- "malformed database schema (hidden_doctor_fixture)"',
      "exit 11",
      "",
    ].join("\n"),
    { mode: 0o500 },
  );
  const fakeSecurity = join(fakeBin, "security");
  writeFileSync(fakeSecurity, "#!/bin/zsh\nexit 44\n", { mode: 0o500 });

  const isolatedDoctorPath = join(scriptsRoot, "doctor");
  const isolatedDoctor = readFileSync(doctorPath, "utf8")
    .replaceAll('"/usr/bin/sqlite3"', JSON.stringify(fakeSystemSqlite))
    .replaceAll('"/usr/bin/security"', JSON.stringify(fakeSecurity));
  writeFileSync(isolatedDoctorPath, isolatedDoctor, { mode: 0o500 });

  const databasePath = join(runtimeRoot, "assistant.sqlite");
  createHealthyDatabase(databasePath);
  const configPath = join(root, "assistant.json");
  const nodePath = realpathSync(process.execPath);
  writeFileSync(
    configPath,
    `${JSON.stringify({
      schemaVersion: 1,
      appId: "cli_TEST123456",
      presidentOpenId: null,
      presidentChatId: null,
      pairing: {
        enabled: true,
        codeHash: `sha256:${"a".repeat(64)}`,
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
      secretRef: {
        type: "macos-keychain",
        service: "com.codex-feishu-executive-assistant.bot",
        account: "cli_TEST123456",
      },
      paths: {
        assistantRoot: root,
        runtimeRoot,
        workspaceRoot: root,
        jobsRoot: join(root, "jobs"),
        outputsRoot: join(root, "outputs"),
        pptProjectsRoot: join(root, "ppt-projects"),
        codexHome: join(root, "codex-home"),
        larkHome: join(root, "lark-home"),
        databasePath,
        logsRoot: join(root, "logs"),
      },
      executables: {
        node: nodePath,
        codex: join(root, "missing-codex"),
        larkCli: join(root, "missing-lark-cli"),
        gatewayClient: join(root, "missing-gateway-client"),
        runtimeEntry: join(root, "missing-runtime-entry"),
        userAuthHelper: join(scriptsRoot, "feishu-user-auth.mjs"),
      },
      visualFirstPpt: {
        skillRoot: join(root, "missing-ppt-skill"),
        tag: "v0.3.0",
        commitSha: "bb775f68f951c3e444d00623bc88976b20c13e7d",
        treeSha: "5ad18d178e8191105dcc68717e4639d3a68f0c73",
        presentationsPlugin: {
          id: "presentations@openai-primary-runtime",
          version: "0.0.0-test",
        },
      },
      launchd: {
        label: "com.codex-feishu.executive-assistant",
      },
    })}\n`,
    { mode: 0o600 },
  );

  return {
    configPath,
    databasePath,
    doctorPath: isolatedDoctorPath,
    fakeSystemSqliteLog,
    root,
    sqliteDoctorPath: join(scriptsRoot, "doctor-sqlite.mjs"),
  };
}

function runSqliteDoctor(helperPath: string, databasePath: string) {
  return spawnSync(realpathSync(process.execPath), [helperPath, databasePath], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C",
      LC_ALL: "C",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runDoctor(fixture: DoctorFixture) {
  return spawnSync(
    "/bin/zsh",
    [fixture.doctorPath, "--json", "--config", fixture.configPath],
    {
      cwd: fixture.root,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: join(fixture.root, "home"),
        ASSISTANT_TEST_MODE: "1",
        SQLITE_INVOCATION_LOG: fixture.fakeSystemSqliteLog,
        PATH: `${dirname(realpathSync(process.execPath))}:/usr/bin:/bin:/usr/sbin:/sbin`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const candidate = temporaryRoots.pop();
    if (candidate?.includes("ea-doctor-sqlite-")) {
      rmSync(candidate, { recursive: true, force: true });
    }
  }
});

describe("doctor SQLite compatibility", () => {
  it("checks a runtime database with the job-store SQLite engine in read-only mode", () => {
    const fixture = createDoctorFixture();
    const before = readFileSync(fixture.databasePath);

    const result = runSqliteDoctor(
      fixture.sqliteDoctorPath,
      fixture.databasePath,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("ok\n");
    expect(result.stderr).toBe("");
    expect(readFileSync(fixture.databasePath)).toEqual(before);
  });

  it("does not invoke an incompatible system sqlite while checking a healthy runtime database", () => {
    const fixture = createDoctorFixture();

    const result = runDoctor(fixture);
    const report = JSON.parse(result.stdout) as {
      checks: Array<{ detail: string; id: string; status: string }>;
    };

    const configCheck = report.checks.find((check) => check.id === "config");
    expect(
      configCheck?.status,
      `${configCheck?.detail ?? ""} fixture=${fixture.root}`,
    ).toBe("PASS");
    expect(report.checks.find((check) => check.id === "sqlite")).toMatchObject({
      detail: "SQLite quick_check 返回 ok。",
      status: "PASS",
    });
    expect(existsSync(fixture.fakeSystemSqliteLog)).toBe(false);
    expect(result.stderr).toBe("");
  });

  it("fails closed with fixed output for a dangling database symlink", () => {
    const fixture = createDoctorFixture();
    rmSync(fixture.databasePath);
    symlinkSync(join(fixture.root, "missing.sqlite"), fixture.databasePath);

    const helperResult = runSqliteDoctor(
      fixture.sqliteDoctorPath,
      fixture.databasePath,
    );
    const doctorResult = runDoctor(fixture);
    const report = JSON.parse(doctorResult.stdout) as {
      checks: Array<{ detail: string; id: string; status: string }>;
    };

    expect(helperResult.status).not.toBe(0);
    expect(helperResult.stdout).toBe("");
    expect(helperResult.stderr).toBe("fail\n");
    expect(report.checks.find((check) => check.id === "sqlite")).toMatchObject({
      detail: "SQLite 必须是权限 0600 的普通文件。",
      status: "FAIL",
    });
  });

  it("does not expose database bytes when quick_check cannot open the file", () => {
    const fixture = createDoctorFixture();
    const sentinel = "DOCTOR_MUST_NOT_ECHO_DATABASE_CONTENT";
    writeFileSync(fixture.databasePath, sentinel, { mode: 0o600 });

    const helperResult = runSqliteDoctor(
      fixture.sqliteDoctorPath,
      fixture.databasePath,
    );
    const doctorResult = runDoctor(fixture);
    const combinedOutput = `${helperResult.stdout}${helperResult.stderr}${doctorResult.stdout}${doctorResult.stderr}`;
    const report = JSON.parse(doctorResult.stdout) as {
      checks: Array<{ detail: string; id: string; status: string }>;
    };

    expect(helperResult.status).not.toBe(0);
    expect(helperResult.stdout).toBe("");
    expect(helperResult.stderr).toBe("fail\n");
    expect(report.checks.find((check) => check.id === "sqlite")).toMatchObject({
      detail: "SQLite quick_check 未通过。",
      status: "FAIL",
    });
    expect(combinedOutput).not.toContain(sentinel);
    expect(Buffer.byteLength(combinedOutput)).toBeLessThan(64 * 1024);
  });
});
