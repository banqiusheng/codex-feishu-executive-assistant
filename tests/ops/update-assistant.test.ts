import {
  execFileSync,
  spawnSync,
  type SpawnSyncReturns,
} from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const updaterPath = join(repositoryRoot, "scripts", "update-assistant.mjs");
const canonicalRemote =
  "https://github.com/banqiusheng/codex-feishu-executive-assistant.git";
const temporaryRoots: string[] = [];

type Fixture = Readonly<{
  root: string;
  remote: string;
  seed: string;
  checkout: string;
  runtime: string;
  installLog: string;
  gitEnvironment: NodeJS.ProcessEnv;
  initialCommit: string;
}>;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("/usr/bin/git", ["-C", cwd, ...args], {
    encoding: "utf8",
  }).trim();
}

function installerSource(logPath: string, label: string, exitCode = 0): string {
  return `#!/bin/zsh
if [[ "$1" != "--update-existing" || "$#" != "1" ]]; then
  exit 64
fi
print -r -- ${JSON.stringify(label)} >> ${JSON.stringify(logPath)}
exit ${exitCode}
`;
}

function prepareFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "assistant-simple-update."));
  temporaryRoots.push(root);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const checkout = join(root, "checkout");
  const runtime = join(root, "runtime");
  const installLog = join(root, "install.log");

  mkdirSync(seed, { recursive: true });
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  execFileSync("/usr/bin/git", [
    "init",
    "--bare",
    "--initial-branch=main",
    remote,
  ]);
  execFileSync("/usr/bin/git", ["init", "--initial-branch=main", seed]);
  git(seed, "config", "user.name", "Updater Test");
  git(seed, "config", "user.email", "updater@example.invalid");
  mkdirSync(join(seed, "scripts"), { recursive: true });
  writeFileSync(join(seed, "README.md"), "initial\n");
  writeFileSync(
    join(seed, "scripts", "install"),
    installerSource(installLog, "old"),
    { mode: 0o700 },
  );
  chmodSync(join(seed, "scripts", "install"), 0o700);
  git(seed, "add", ".");
  git(seed, "commit", "-m", "initial");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  execFileSync("/usr/bin/git", ["clone", "--branch", "main", remote, checkout]);
  git(checkout, "config", "user.name", "Updater Test");
  git(checkout, "config", "user.email", "updater@example.invalid");
  git(checkout, "remote", "set-url", "origin", canonicalRemote);

  const remoteUrl = pathToFileURL(remote).href;
  return {
    root,
    remote,
    seed,
    checkout,
    runtime,
    installLog,
    initialCommit: git(checkout, "rev-parse", "HEAD"),
    gitEnvironment: {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${remoteUrl}.insteadOf`,
      GIT_CONFIG_VALUE_0: canonicalRemote,
    },
  };
}

function advanceRemote(
  fixture: Fixture,
  options: Readonly<{
    installerLabel?: string;
    installerExitCode?: number;
  }> = {},
): string {
  writeFileSync(
    join(fixture.seed, "README.md"),
    `remote-${Date.now()}-${Math.random()}\n`,
  );
  if (options.installerLabel !== undefined) {
    writeFileSync(
      join(fixture.seed, "scripts", "install"),
      installerSource(
        fixture.installLog,
        options.installerLabel,
        options.installerExitCode ?? 0,
      ),
      { mode: 0o700 },
    );
    chmodSync(join(fixture.seed, "scripts", "install"), 0o700);
  }
  git(fixture.seed, "add", ".");
  git(fixture.seed, "commit", "-m", "advance remote");
  git(fixture.seed, "push", "origin", "main");
  return git(fixture.seed, "rev-parse", "HEAD");
}

function runUpdater(
  fixture: Fixture,
  command: "--check" | "--apply",
  environment: NodeJS.ProcessEnv = fixture.gitEnvironment,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [updaterPath, command], {
    cwd: fixture.root,
    encoding: "utf8",
    env: {
      ...environment,
      ASSISTANT_REPOSITORY_ROOT: fixture.checkout,
      ASSISTANT_RUNTIME_ROOT: fixture.runtime,
    },
  });
}

function jsonOutput(result: SpawnSyncReturns<string>): Record<string, unknown> {
  expect(result.stdout, result.stderr).toMatch(/^\{[^\n]*\}\n$/);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function readState(fixture: Fixture): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(fixture.runtime, "update-state.json"), "utf8"),
  ) as Record<string, unknown>;
}

describe("simple GitHub main updater", () => {
  it("checks the remote without changing the checkout and writes private state", () => {
    const fixture = prepareFixture();
    const before = git(fixture.checkout, "rev-parse", "HEAD");

    const result = runUpdater(fixture, "--check");

    expect(result.status, result.stderr).toBe(0);
    expect(jsonOutput(result)).toEqual({
      schemaVersion: 1,
      command: "check",
      status: "current",
      currentCommit: before,
      remoteCommit: before,
    });
    expect(git(fixture.checkout, "rev-parse", "HEAD")).toBe(before);
    expect(
      statSync(join(fixture.runtime, "update-state.json")).mode & 0o777,
    ).toBe(0o600);
  });

  it("uses the 24-hour cache without contacting an unavailable remote", () => {
    const fixture = prepareFixture();
    const statePath = join(fixture.runtime, "update-state.json");
    writeFileSync(
      statePath,
      `${JSON.stringify({
        schemaVersion: 1,
        lastCheckedAtMs: Date.now(),
        remoteCommit: fixture.initialCommit,
        promptedCommit: null,
      })}\n`,
      { mode: 0o600 },
    );
    const missingRemote = pathToFileURL(join(fixture.root, "missing.git")).href;

    const result = runUpdater(fixture, "--check", {
      ...fixture.gitEnvironment,
      GIT_CONFIG_KEY_0: `url.${missingRemote}.insteadOf`,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(jsonOutput(result)).toEqual({
      schemaVersion: 1,
      command: "check",
      status: "cached",
      currentCommit: fixture.initialCommit,
      remoteCommit: fixture.initialCommit,
    });
  });

  it("prompts once for a new commit and suppresses the same commit later", () => {
    const fixture = prepareFixture();
    const remoteCommit = advanceRemote(fixture);

    const first = runUpdater(fixture, "--check");
    expect(first.status, first.stderr).toBe(0);
    expect(jsonOutput(first)).toEqual({
      schemaVersion: 1,
      command: "check",
      status: "available",
      currentCommit: fixture.initialCommit,
      remoteCommit,
    });
    expect(git(fixture.checkout, "rev-parse", "HEAD")).toBe(
      fixture.initialCommit,
    );

    const immediate = runUpdater(fixture, "--check");
    expect(immediate.status, immediate.stderr).toBe(0);
    expect(jsonOutput(immediate).status).toBe("cached");

    const state = readState(fixture);
    writeFileSync(
      join(fixture.runtime, "update-state.json"),
      `${JSON.stringify({ ...state, lastCheckedAtMs: 0 })}\n`,
      { mode: 0o600 },
    );
    const later = runUpdater(fixture, "--check");
    expect(later.status, later.stderr).toBe(0);
    expect(jsonOutput(later)).toEqual({
      schemaVersion: 1,
      command: "check",
      status: "already_prompted",
      currentCommit: fixture.initialCommit,
      remoteCommit,
    });
  });

  it("treats an unreachable remote as a non-blocking check result", () => {
    const fixture = prepareFixture();
    const missingRemote = pathToFileURL(join(fixture.root, "missing.git")).href;

    const result = runUpdater(fixture, "--check", {
      ...fixture.gitEnvironment,
      GIT_CONFIG_KEY_0: `url.${missingRemote}.insteadOf`,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(jsonOutput(result)).toEqual({
      schemaVersion: 1,
      command: "check",
      status: "unavailable",
      currentCommit: fixture.initialCommit,
    });
  });

  it("fast-forwards main and invokes the fixed existing-install mode", () => {
    const fixture = prepareFixture();
    const remoteCommit = advanceRemote(fixture, { installerLabel: "new" });

    const result = runUpdater(fixture, "--apply");

    expect(result.status, result.stderr).toBe(0);
    expect(jsonOutput(result)).toEqual({
      schemaVersion: 1,
      command: "apply",
      status: "updated",
      previousCommit: fixture.initialCommit,
      currentCommit: remoteCommit,
    });
    expect(git(fixture.checkout, "rev-parse", "HEAD")).toBe(remoteCommit);
    expect(readFileSync(fixture.installLog, "utf8")).toBe("new\n");
  });

  it("rejects an untrusted origin without fetching or installing", () => {
    const fixture = prepareFixture();
    git(
      fixture.checkout,
      "remote",
      "set-url",
      "origin",
      "https://example.invalid/attacker.git",
    );

    const result = runUpdater(fixture, "--apply");

    expect(jsonOutput(result)).toEqual({
      schemaVersion: 1,
      command: "apply",
      status: "blocked",
      reason: "repository_untrusted",
    });
    expect(result.status).not.toBe(0);
    expect(git(fixture.checkout, "rev-parse", "HEAD")).toBe(
      fixture.initialCommit,
    );
    expect(existsSync(fixture.installLog)).toBe(false);
  });

  it("rejects a dirty checkout without fetching or installing", () => {
    const fixture = prepareFixture();
    advanceRemote(fixture, { installerLabel: "new" });
    writeFileSync(join(fixture.checkout, "local-note.txt"), "do not touch\n");

    const result = runUpdater(fixture, "--apply");

    expect(jsonOutput(result)).toEqual({
      schemaVersion: 1,
      command: "apply",
      status: "blocked",
      reason: "worktree_dirty",
    });
    expect(result.status).not.toBe(0);
    expect(git(fixture.checkout, "rev-parse", "HEAD")).toBe(
      fixture.initialCommit,
    );
    expect(readFileSync(join(fixture.checkout, "local-note.txt"), "utf8")).toBe(
      "do not touch\n",
    );
    expect(existsSync(fixture.installLog)).toBe(false);
  });

  it("rejects non-fast-forward history without changing the local commit", () => {
    const fixture = prepareFixture();
    advanceRemote(fixture, { installerLabel: "remote" });
    writeFileSync(join(fixture.checkout, "local.txt"), "local branch\n");
    git(fixture.checkout, "add", "local.txt");
    git(fixture.checkout, "commit", "-m", "local divergence");
    const localCommit = git(fixture.checkout, "rev-parse", "HEAD");

    const result = runUpdater(fixture, "--apply");

    expect(jsonOutput(result)).toEqual({
      schemaVersion: 1,
      command: "apply",
      status: "blocked",
      reason: "non_fast_forward",
    });
    expect(result.status).not.toBe(0);
    expect(git(fixture.checkout, "rev-parse", "HEAD")).toBe(localCommit);
    expect(existsSync(fixture.installLog)).toBe(false);
  });

  it("restores the old commit and old install after a new install fails", () => {
    const fixture = prepareFixture();
    const attemptedCommit = advanceRemote(fixture, {
      installerLabel: "new-failed",
      installerExitCode: 72,
    });

    const result = runUpdater(fixture, "--apply");

    expect(jsonOutput(result)).toEqual({
      schemaVersion: 1,
      command: "apply",
      status: "rolled_back",
      reason: "install_failed",
      restoredCommit: fixture.initialCommit,
      attemptedCommit,
    });
    expect(result.status).not.toBe(0);
    expect(git(fixture.checkout, "rev-parse", "HEAD")).toBe(
      fixture.initialCommit,
    );
    expect(readFileSync(fixture.installLog, "utf8")).toBe("new-failed\nold\n");
  });
});
