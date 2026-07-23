import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(".");
const temporaryRoots: string[] = [];

interface BridgeLock {
  treeSha: string;
  patchedTreeSha: string;
  vendorScriptSha256: string;
  patches: Array<{ path: string; sha256: string }>;
}

interface DependencyLock {
  larkCodexBridge: BridgeLock;
}

interface ReplayFixture {
  root: string;
  script: string;
  target: string;
  licenses: string;
  gitLog: string;
  environment: NodeJS.ProcessEnv;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function fileSha256(path: string): string {
  return sha256(readFileSync(path));
}

function findExecutable(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, name);
    try {
      const stat = statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) {
        return candidate;
      }
    } catch {
      // Keep searching PATH.
    }
  }
  throw new Error(`${name} is not available on PATH`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function copyIntoFixture(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    dereference: false,
    filter: (path) => {
      const sourceRoot = resolve(source);
      const absolute = resolve(path);
      return (
        absolute === sourceRoot ||
        (absolute !== join(sourceRoot, "dist") &&
          absolute !== join(sourceRoot, "node_modules") &&
          absolute !== join(sourceRoot, ".git"))
      );
    },
  });
}

function updateFixtureScriptHash(root: string): DependencyLock {
  const lockPath = join(root, "dependencies.lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as DependencyLock;
  lock.larkCodexBridge.vendorScriptSha256 = fileSha256(
    join(root, "scripts", "vendor-bridge"),
  );
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}

function createGitShim(root: string): {
  bin: string;
  log: string;
} {
  const bin = join(root, "test-bin");
  const shim = join(bin, "git");
  const log = join(root, "git-shim.log");
  const realGit = findExecutable("git");
  mkdirSync(bin);
  writeFileSync(
    shim,
    `#!/bin/sh
readonly git_shim_log=${shellQuote(log)}
readonly real_git=${shellQuote(realGit)}
printf 'protocol=%s args=%s\\n' "$GIT_ALLOW_PROTOCOL" "$*" >> "$git_shim_log"
for argument in "$@"; do
  case "$argument" in
    clone|fetch|pull|ls-remote)
      printf 'network git command rejected: %s\\n' "$argument" >&2
      exit 97
      ;;
  esac
done
exec "$real_git" "$@"
`,
  );
  chmodSync(shim, 0o755);
  return { bin, log };
}

function writeForwardingShim(
  bin: string,
  name: string,
  realExecutable: string,
  log: string,
): void {
  const shim = join(bin, name);
  writeFileSync(
    shim,
    `#!/bin/sh
printf 'unexpected ambient executable: %s\\n' ${shellQuote(name)} >> ${shellQuote(log)}
exec ${shellQuote(realExecutable)} "$@"
`,
  );
  chmodSync(shim, 0o755);
}

function writeProbeExecutable(path: string, log: string): void {
  writeFileSync(
    path,
    `#!/bin/sh
printf 'unexpected helper execution: %s\\n' "$*" >> ${JSON.stringify(log)}
exit 1
`,
  );
  chmodSync(path, 0o755);
}

function createReplayFixture(): ReplayFixture {
  const root = mkdtempSync(join(tmpdir(), "vendor-replay-contract-"));
  temporaryRoots.push(root);

  copyIntoFixture(
    join(repositoryRoot, "scripts", "vendor-bridge"),
    join(root, "scripts", "vendor-bridge"),
  );
  copyIntoFixture(
    join(repositoryRoot, "scripts", "bridge-vendor-manifest.mjs"),
    join(root, "scripts", "bridge-vendor-manifest.mjs"),
  );
  copyIntoFixture(
    join(repositoryRoot, "dependencies.lock.json"),
    join(root, "dependencies.lock.json"),
  );
  copyIntoFixture(
    join(repositoryRoot, "packages", "bridge"),
    join(root, "packages", "bridge"),
  );
  copyIntoFixture(
    join(repositoryRoot, "vendor", "patches", "lark-codex-bridge"),
    join(root, "vendor", "patches", "lark-codex-bridge"),
  );

  const licenses = join(root, "LICENSES");
  mkdirSync(licenses);
  writeFileSync(join(licenses, "offline-replay-sentinel.txt"), "unchanged\n");
  updateFixtureScriptHash(root);

  const shim = createGitShim(root);
  return {
    root,
    script: join(root, "scripts", "vendor-bridge"),
    target: join(root, "packages", "bridge"),
    licenses,
    gitLog: shim.log,
    environment: {
      ...process.env,
      GIT_ALLOW_PROTOCOL: "file",
      PATH: `${shim.bin}${delimiter}${process.env.PATH ?? ""}`,
    },
  };
}

function runReplay(
  fixture: ReplayFixture,
  args = ["--offline-replay"],
): ReturnType<typeof spawnSync> {
  return spawnSync(fixture.script, args, {
    cwd: fixture.root,
    encoding: "utf8",
    env: fixture.environment,
    timeout: 30_000,
  });
}

function snapshot(path: string): string {
  const root = resolve(path);
  const entries: string[] = [];

  function visit(absolutePath: string): void {
    const stat = lstatSync(absolutePath);
    const relativePath = relative(root, absolutePath) || ".";
    const mode = (stat.mode & 0o777).toString(8).padStart(4, "0");
    if (stat.isSymbolicLink()) {
      entries.push(
        `${relativePath}\tsymlink\t${mode}\t${readlinkSync(absolutePath)}`,
      );
      return;
    }
    if (stat.isFile()) {
      entries.push(
        `${relativePath}\tfile\t${mode}\t${stat.size}\t${fileSha256(absolutePath)}`,
      );
      return;
    }
    if (!stat.isDirectory()) {
      entries.push(`${relativePath}\tother\t${mode}`);
      return;
    }
    entries.push(`${relativePath}\tdirectory\t${mode}`);
    for (const name of readdirSync(absolutePath).sort()) {
      visit(join(absolutePath, name));
    }
  }

  visit(root);
  return sha256(entries.join("\n"));
}

function expectFailClosedAndUnchanged(
  fixture: ReplayFixture,
  beforeTarget: string,
  beforeLicenses: string,
): ReturnType<typeof spawnSync> {
  const result = runReplay(fixture);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(73);
  expect(result.stderr).toContain("offline replay integrity failure:");
  expect(snapshot(fixture.target)).toBe(beforeTarget);
  expect(snapshot(fixture.licenses)).toBe(beforeLicenses);
  return result;
}

describe("offline bridge vendor replay", () => {
  it("reverses and reapplies the locked patches with network Git disabled and no durable writes", () => {
    const fixture = createReplayFixture();
    const lock = JSON.parse(
      readFileSync(join(fixture.root, "dependencies.lock.json"), "utf8"),
    ) as DependencyLock;
    const beforeTarget = snapshot(fixture.target);
    const beforeLicenses = snapshot(fixture.licenses);

    const result = runReplay(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      `offline replay restored original tree: ${lock.larkCodexBridge.treeSha}`,
    );
    expect(result.stdout).toContain(
      `offline replay restored patched tree: ${lock.larkCodexBridge.patchedTreeSha}`,
    );
    expect(snapshot(fixture.target)).toBe(beforeTarget);
    expect(snapshot(fixture.licenses)).toBe(beforeLicenses);

    expect(existsSync(fixture.gitLog)).toBe(false);
  });

  it("scrubs hostile ambient Git capabilities before replaying", () => {
    const fixture = createReplayFixture();
    const helper = join(fixture.root, "hostile-fsmonitor");
    const helperLog = join(fixture.root, "hostile-fsmonitor.log");
    const injectedIndex = join(fixture.licenses, "ambient-index");
    writeProbeExecutable(helper, helperLog);
    fixture.environment = {
      ...fixture.environment,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: helper,
      GIT_INDEX_FILE: injectedIndex,
    };
    const beforeTarget = snapshot(fixture.target);
    const beforeLicenses = snapshot(fixture.licenses);

    const result = runReplay(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(helperLog)).toBe(false);
    expect(existsSync(injectedIndex)).toBe(false);
    expect(snapshot(fixture.target)).toBe(beforeTarget);
    expect(snapshot(fixture.licenses)).toBe(beforeLicenses);
  });

  it("does not execute Node preload hooks from the ambient environment", () => {
    const fixture = createReplayFixture();
    const probe = join(fixture.root, "ambient-node-preload.cjs");
    const probeLog = join(fixture.root, "ambient-node-preload.log");
    writeFileSync(
      probe,
      `require("node:fs").appendFileSync(${JSON.stringify(probeLog)}, "executed\\n");\n`,
    );
    fixture.environment = {
      ...fixture.environment,
      NODE_OPTIONS: `--require=${probe}`,
    };
    const beforeTarget = snapshot(fixture.target);
    const beforeLicenses = snapshot(fixture.licenses);

    const result = runReplay(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(probeLog)).toBe(false);
    expect(existsSync(fixture.gitLog)).toBe(false);
    expect(snapshot(fixture.target)).toBe(beforeTarget);
    expect(snapshot(fixture.licenses)).toBe(beforeLicenses);
  });

  it("does not resolve Node, Git, or tar from the ambient PATH", () => {
    const fixture = createReplayFixture();
    const probeLog = join(fixture.root, "ambient-path.log");
    const ambientBin = fixture.environment.PATH?.split(delimiter)[0];
    expect(ambientBin).toBeTruthy();
    writeForwardingShim(ambientBin!, "node", findExecutable("node"), probeLog);
    writeForwardingShim(ambientBin!, "tar", findExecutable("tar"), probeLog);
    const beforeTarget = snapshot(fixture.target);
    const beforeLicenses = snapshot(fixture.licenses);

    const result = runReplay(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(probeLog)).toBe(false);
    expect(existsSync(fixture.gitLog)).toBe(false);
    expect(snapshot(fixture.target)).toBe(beforeTarget);
    expect(snapshot(fixture.licenses)).toBe(beforeLicenses);
  });

  it("does not load ambient zsh startup files before clearing the environment", () => {
    const fixture = createReplayFixture();
    const hostileZdotdir = join(fixture.root, "hostile-zdotdir");
    const injectedFile = join(fixture.licenses, "zsh-startup-injection");
    mkdirSync(hostileZdotdir);
    writeFileSync(
      join(hostileZdotdir, ".zshenv"),
      `#!/bin/zsh\nprint -r -- injected > ${shellQuote(injectedFile)}\n`,
    );
    fixture.environment = {
      ...fixture.environment,
      ZDOTDIR: hostileZdotdir,
    };
    const beforeTarget = snapshot(fixture.target);
    const beforeLicenses = snapshot(fixture.licenses);

    const result = runReplay(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(injectedFile)).toBe(false);
    expect(snapshot(fixture.target)).toBe(beforeTarget);
    expect(snapshot(fixture.licenses)).toBe(beforeLicenses);
  });

  it("rejects unknown modes before running Git", () => {
    const fixture = createReplayFixture();
    const result = runReplay(fixture, ["--unknown"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "usage: scripts/vendor-bridge [--offline-replay]",
    );
    expect(existsSync(fixture.gitLog)).toBe(false);
  });

  it("rejects a missing or symlinked target with exit 73", () => {
    for (const mode of ["missing", "symlink"] as const) {
      const fixture = createReplayFixture();
      const preservedTarget = `${fixture.target}-${mode}`;
      renameSync(fixture.target, preservedTarget);
      const beforePreservedTarget = snapshot(preservedTarget);
      const beforeLicenses = snapshot(fixture.licenses);
      if (mode === "symlink") {
        symlinkSync(preservedTarget, fixture.target, "dir");
      }

      const result = runReplay(fixture);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(73);
      expect(result.stderr).toContain("offline replay integrity failure:");
      expect(snapshot(preservedTarget)).toBe(beforePreservedTarget);
      expect(snapshot(fixture.licenses)).toBe(beforeLicenses);
      if (mode === "missing") {
        expect(existsSync(fixture.target)).toBe(false);
      } else {
        expect(lstatSync(fixture.target).isSymbolicLink()).toBe(true);
      }
      expect(existsSync(fixture.gitLog)).toBe(false);
    }
  });

  it("rejects target drift with exit 73 and preserves the drifted bytes", () => {
    const fixture = createReplayFixture();
    const targetPackage = join(fixture.target, "package.json");
    writeFileSync(targetPackage, `${readFileSync(targetPackage, "utf8")} `);
    const beforeTarget = snapshot(fixture.target);
    const beforeLicenses = snapshot(fixture.licenses);

    expectFailClosedAndUnchanged(fixture, beforeTarget, beforeLicenses);
    expect(existsSync(fixture.gitLog)).toBe(false);
  });

  it("rejects patch tampering with exit 73 and preserves target, patch, and licenses", () => {
    const fixture = createReplayFixture();
    const lock = JSON.parse(
      readFileSync(join(fixture.root, "dependencies.lock.json"), "utf8"),
    ) as DependencyLock;
    const patch = join(
      fixture.root,
      ...lock.larkCodexBridge.patches[0]!.path.split("/"),
    );
    writeFileSync(patch, `${readFileSync(patch, "utf8")}\n`);
    const beforePatch = readFileSync(patch);
    const beforeTarget = snapshot(fixture.target);
    const beforeLicenses = snapshot(fixture.licenses);

    expectFailClosedAndUnchanged(fixture, beforeTarget, beforeLicenses);
    expect(readFileSync(patch)).toEqual(beforePatch);
    expect(existsSync(fixture.gitLog)).toBe(false);
  });

  it("rejects an out-of-order lock and a vendor script whose self-hash changed", () => {
    for (const mode of ["order", "script"] as const) {
      const fixture = createReplayFixture();
      const lockPath = join(fixture.root, "dependencies.lock.json");
      if (mode === "order") {
        const lock = JSON.parse(
          readFileSync(lockPath, "utf8"),
        ) as DependencyLock;
        [lock.larkCodexBridge.patches[0], lock.larkCodexBridge.patches[1]] = [
          lock.larkCodexBridge.patches[1]!,
          lock.larkCodexBridge.patches[0]!,
        ];
        writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      } else {
        writeFileSync(
          fixture.script,
          `${readFileSync(fixture.script, "utf8")}\n# tampered\n`,
        );
      }
      const beforeTarget = snapshot(fixture.target);
      const beforeLicenses = snapshot(fixture.licenses);

      expectFailClosedAndUnchanged(fixture, beforeTarget, beforeLicenses);
      expect(existsSync(fixture.gitLog)).toBe(false);
    }
  });
});
