#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import process from "node:process";

const EXPECTED_REMOTE =
  "https://github.com/banqiusheng/codex-feishu-executive-assistant.git";
const GIT_PATH = "/usr/bin/git";
const ZSH_PATH = "/bin/zsh";
const CACHE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 4096;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const FEISHU_SCOPE_CONTRACT_SHA256 =
  "40f77b8df33af965544046313016116fd2a249afaed2d96044649863568db93e";

class UpdateFailure extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function output(payload, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = exitCode;
}

function commandEnvironment() {
  return {
    ...process.env,
    ASSISTANT_NODE_PATH: realpathSync(process.execPath),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    LANG: "C",
    LC_ALL: "C",
  };
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? commandEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: options.timeout,
  });
}

function git(repositoryRoot, args) {
  return run(GIT_PATH, ["-C", repositoryRoot, ...args], {
    cwd: repositoryRoot,
  });
}

function gitText(repositoryRoot, args, reason = "repository_untrusted") {
  const result = git(repositoryRoot, args);
  if (result.error || result.signal || result.status !== 0) {
    throw new UpdateFailure(reason);
  }
  return result.stdout.trim();
}

function validCommit(value) {
  return typeof value === "string" && COMMIT_PATTERN.test(value);
}

function requiredRoot(value, reason) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    !existsSync(value)
  ) {
    throw new UpdateFailure(reason);
  }
  const root = realpathSync(value);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new UpdateFailure(reason);
  }
  return root;
}

function runtimeRoot(value) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new UpdateFailure("runtime_root_invalid");
  }
  mkdirSync(value, { recursive: true, mode: 0o700 });
  const root = requiredRoot(value, "runtime_root_invalid");
  chmodSync(root, 0o700);
  return root;
}

function inspectRepository(repositoryRoot) {
  let topLevel;
  let remote;
  let branch;
  let currentCommit;
  try {
    topLevel = realpathSync(
      gitText(repositoryRoot, ["rev-parse", "--show-toplevel"]),
    );
    remote = gitText(repositoryRoot, ["config", "--get", "remote.origin.url"]);
    branch = gitText(repositoryRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    currentCommit = gitText(repositoryRoot, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    throw new UpdateFailure("repository_untrusted");
  }
  if (
    topLevel !== repositoryRoot ||
    remote !== EXPECTED_REMOTE ||
    branch !== "main" ||
    !validCommit(currentCommit)
  ) {
    throw new UpdateFailure("repository_untrusted");
  }
  return currentCommit;
}

function defaultState() {
  return {
    schemaVersion: 1,
    lastCheckedAtMs: 0,
    remoteCommit: null,
    promptedCommit: null,
  };
}

function stateIsValid(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  if (
    keys.join(",") !==
    ["lastCheckedAtMs", "promptedCommit", "remoteCommit", "schemaVersion"]
      .sort()
      .join(",")
  ) {
    return false;
  }
  return (
    value.schemaVersion === 1 &&
    Number.isSafeInteger(value.lastCheckedAtMs) &&
    value.lastCheckedAtMs >= 0 &&
    (value.remoteCommit === null || validCommit(value.remoteCommit)) &&
    (value.promptedCommit === null || validCommit(value.promptedCommit))
  );
}

function statePath(root) {
  return join(root, "update-state.json");
}

function readState(root) {
  const path = statePath(root);
  if (!existsSync(path)) return defaultState();
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) {
    throw new UpdateFailure("state_invalid");
  }
  if ((stat.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return stateIsValid(parsed) ? parsed : defaultState();
  } catch {
    return defaultState();
  }
}

function writeState(root, state) {
  const path = statePath(root);
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new UpdateFailure("state_invalid");
    }
  }
  const temporaryPath = join(root, `.update-state.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function remoteMainCommit(repositoryRoot) {
  const result = git(repositoryRoot, [
    "ls-remote",
    "--exit-code",
    "origin",
    "refs/heads/main",
  ]);
  if (result.error || result.signal || result.status !== 0) {
    throw new UpdateFailure("remote_unavailable");
  }
  const lines = result.stdout.trim().split("\n");
  if (lines.length !== 1) throw new UpdateFailure("remote_unavailable");
  const [commit, reference, ...extra] = lines[0].split(/\s+/);
  if (
    !validCommit(commit) ||
    reference !== "refs/heads/main" ||
    extra.length !== 0
  ) {
    throw new UpdateFailure("remote_unavailable");
  }
  return commit;
}

function check(repositoryRoot, root) {
  const currentCommit = inspectRepository(repositoryRoot);
  const state = readState(root);
  const now = Date.now();
  if (
    state.lastCheckedAtMs > 0 &&
    now - state.lastCheckedAtMs < CACHE_WINDOW_MS
  ) {
    return {
      schemaVersion: 1,
      command: "check",
      status: "cached",
      currentCommit,
      remoteCommit: state.remoteCommit ?? currentCommit,
    };
  }

  let remoteCommit;
  try {
    remoteCommit = remoteMainCommit(repositoryRoot);
  } catch {
    try {
      writeState(root, {
        ...state,
        lastCheckedAtMs: now,
      });
    } catch {
      // State caching is best effort; the president's task must continue.
    }
    return {
      schemaVersion: 1,
      command: "check",
      status: "unavailable",
      currentCommit,
    };
  }

  const alreadyPrompted =
    remoteCommit !== currentCommit && state.promptedCommit === remoteCommit;
  const status =
    remoteCommit === currentCommit
      ? "current"
      : alreadyPrompted
        ? "already_prompted"
        : "available";
  try {
    writeState(root, {
      schemaVersion: 1,
      lastCheckedAtMs: now,
      remoteCommit,
      promptedCommit:
        status === "available" ? remoteCommit : state.promptedCommit,
    });
  } catch {
    // A failed cache write must not block the president's current task.
  }
  return {
    schemaVersion: 1,
    command: "check",
    status,
    currentCommit,
    remoteCommit,
  };
}

function worktreeIsClean(repositoryRoot) {
  const result = git(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (result.error || result.signal || result.status !== 0) {
    throw new UpdateFailure("repository_untrusted");
  }
  return result.stdout.length === 0;
}

function validateScopeContract(repositoryRoot) {
  const contractPath = join(repositoryRoot, "config", "feishu-scopes.json");
  if (!existsSync(contractPath)) {
    throw new UpdateFailure("scope_contract_invalid");
  }
  const stat = lstatSync(contractPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    stat.size > 64 * 1024
  ) {
    throw new UpdateFailure("scope_contract_invalid");
  }
  const bytes = readFileSync(contractPath);
  if (
    createHash("sha256").update(bytes).digest("hex") !==
    FEISHU_SCOPE_CONTRACT_SHA256
  ) {
    throw new UpdateFailure("scope_contract_invalid");
  }
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (
      value?.schemaVersion !== 1 ||
      Object.keys(value).join(",") !==
        "schemaVersion,userScopes,botScopes,shortcuts" ||
      !Array.isArray(value.userScopes) ||
      value.userScopes.length !== 14 ||
      new Set(value.userScopes).size !== value.userScopes.length ||
      !Array.isArray(value.botScopes) ||
      value.botScopes.length !== 4 ||
      new Set(value.botScopes).size !== value.botScopes.length ||
      !Array.isArray(value.shortcuts) ||
      value.shortcuts.length !== 14
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new UpdateFailure("scope_contract_invalid");
  }
}

function fetchMain(repositoryRoot) {
  const result = git(repositoryRoot, [
    "fetch",
    "--no-tags",
    "origin",
    "refs/heads/main",
  ]);
  if (result.error || result.signal || result.status !== 0) {
    throw new UpdateFailure("remote_unavailable");
  }
  const commit = gitText(
    repositoryRoot,
    ["rev-parse", "--verify", "FETCH_HEAD"],
    "remote_unavailable",
  );
  if (!validCommit(commit)) throw new UpdateFailure("remote_unavailable");
  return commit;
}

function isAncestor(repositoryRoot, ancestor, descendant) {
  const result = git(repositoryRoot, [
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant,
  ]);
  if (result.status === 0) return true;
  if (!result.error && !result.signal && result.status === 1) return false;
  throw new UpdateFailure("repository_untrusted");
}

function fastForward(repositoryRoot, targetCommit) {
  const result = git(repositoryRoot, [
    "merge",
    "--ff-only",
    "--no-edit",
    targetCommit,
  ]);
  if (result.error || result.signal || result.status !== 0) {
    throw new UpdateFailure("fast_forward_failed");
  }
  const actual = gitText(repositoryRoot, ["rev-parse", "--verify", "HEAD"]);
  if (actual !== targetCommit) {
    throw new UpdateFailure("fast_forward_failed");
  }
}

function runInstaller(repositoryRoot) {
  const installPath = join(repositoryRoot, "scripts", "install");
  if (!existsSync(installPath)) return false;
  const stat = lstatSync(installPath);
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  const result = run(ZSH_PATH, [installPath, "--update-existing"], {
    cwd: repositoryRoot,
    env: commandEnvironment(),
    timeout: 30 * 60 * 1000,
  });
  return !result.error && !result.signal && result.status === 0;
}

function restore(repositoryRoot, commit) {
  const result = git(repositoryRoot, ["reset", "--hard", commit]);
  if (result.error || result.signal || result.status !== 0) return false;
  try {
    return (
      gitText(repositoryRoot, ["rev-parse", "--verify", "HEAD"]) === commit &&
      worktreeIsClean(repositoryRoot)
    );
  } catch {
    return false;
  }
}

function apply(repositoryRoot, root) {
  let currentCommit;
  try {
    currentCommit = inspectRepository(repositoryRoot);
  } catch (error) {
    return blocked(error instanceof UpdateFailure ? error.reason : "unknown");
  }
  try {
    validateScopeContract(repositoryRoot);
    if (!worktreeIsClean(repositoryRoot)) return blocked("worktree_dirty");
    const targetCommit = fetchMain(repositoryRoot);
    if (targetCommit === currentCommit) {
      return {
        payload: {
          schemaVersion: 1,
          command: "apply",
          status: "current",
          currentCommit,
        },
        exitCode: 0,
      };
    }
    if (!isAncestor(repositoryRoot, currentCommit, targetCommit)) {
      return blocked("non_fast_forward");
    }
    fastForward(repositoryRoot, targetCommit);
    try {
      validateScopeContract(repositoryRoot);
    } catch {
      const restored = restore(repositoryRoot, currentCommit);
      const oldInstallRestored = restored && runInstaller(repositoryRoot);
      if (restored && oldInstallRestored) {
        return {
          payload: {
            schemaVersion: 1,
            command: "apply",
            status: "rolled_back",
            reason: "scope_contract_invalid",
            restoredCommit: currentCommit,
            attemptedCommit: targetCommit,
          },
          exitCode: 1,
        };
      }
      return {
        payload: {
          schemaVersion: 1,
          command: "apply",
          status: "recovery_failed",
          reason: restored ? "old_install_failed" : "rollback_failed",
          previousCommit: currentCommit,
          attemptedCommit: targetCommit,
        },
        exitCode: 1,
      };
    }
    if (runInstaller(repositoryRoot)) {
      try {
        writeState(root, {
          schemaVersion: 1,
          lastCheckedAtMs: Date.now(),
          remoteCommit: targetCommit,
          promptedCommit: targetCommit,
        });
      } catch {
        // The update itself succeeded; a cache write is non-critical.
      }
      return {
        payload: {
          schemaVersion: 1,
          command: "apply",
          status: "updated",
          previousCommit: currentCommit,
          currentCommit: targetCommit,
        },
        exitCode: 0,
      };
    }
    const restored = restore(repositoryRoot, currentCommit);
    const oldInstallRestored = restored && runInstaller(repositoryRoot);
    if (restored && oldInstallRestored) {
      return {
        payload: {
          schemaVersion: 1,
          command: "apply",
          status: "rolled_back",
          reason: "install_failed",
          restoredCommit: currentCommit,
          attemptedCommit: targetCommit,
        },
        exitCode: 1,
      };
    }
    return {
      payload: {
        schemaVersion: 1,
        command: "apply",
        status: "recovery_failed",
        reason: restored ? "old_install_failed" : "rollback_failed",
        previousCommit: currentCommit,
        attemptedCommit: targetCommit,
      },
      exitCode: 1,
    };
  } catch (error) {
    const reason =
      error instanceof UpdateFailure ? error.reason : "update_failed";
    return blocked(reason);
  }
}

function blocked(reason) {
  return {
    payload: {
      schemaVersion: 1,
      command: "apply",
      status: "blocked",
      reason,
    },
    exitCode: 1,
  };
}

function main() {
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length !== 0 || (command !== "--check" && command !== "--apply")) {
    output(
      {
        schemaVersion: 1,
        command: "invalid",
        status: "blocked",
        reason: "arguments_invalid",
      },
      64,
    );
    return;
  }

  let repositoryRoot;
  let root;
  try {
    repositoryRoot = requiredRoot(
      process.env.ASSISTANT_REPOSITORY_ROOT,
      "repository_untrusted",
    );
    root = runtimeRoot(process.env.ASSISTANT_RUNTIME_ROOT);
  } catch (error) {
    if (command === "--check") {
      output({
        schemaVersion: 1,
        command: "check",
        status: "unavailable",
      });
    } else {
      const reason =
        error instanceof UpdateFailure ? error.reason : "configuration_invalid";
      const result = blocked(reason);
      output(result.payload, result.exitCode);
    }
    return;
  }

  if (command === "--check") {
    try {
      output(check(repositoryRoot, root));
    } catch {
      output({
        schemaVersion: 1,
        command: "check",
        status: "unavailable",
      });
    }
    return;
  }

  const result = apply(repositoryRoot, root);
  output(result.payload, result.exitCode);
}

main();
