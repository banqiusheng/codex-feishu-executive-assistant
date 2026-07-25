#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const PRESENTATIONS_PLUGIN_ID = "presentations@openai-primary-runtime";
const MARKETPLACE_NAME = "openai-primary-runtime";
const VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+)+$/;

function fail(code) {
  throw new Error(code);
}

function assertArgumentCount(args, expected) {
  if (args.length !== expected) fail("invalid_argument_count");
}

function assertAbsolutePath(value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail(code);
}

function assertDirectory(pathname, code) {
  let stat;
  try {
    stat = lstatSync(pathname);
  } catch {
    fail(code);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code);
}

function assertRegularFile(pathname, code) {
  let stat;
  try {
    stat = lstatSync(pathname);
  } catch {
    fail(code);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(code);
}

function assertNumericVersion(version, code = "invalid_presentations_version") {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    fail(code);
  }
}

function compareNumericVersions(left, right) {
  assertNumericVersion(left);
  assertNumericVersion(right);
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  if (
    leftParts.some((part) => !Number.isSafeInteger(part)) ||
    rightParts.some((part) => !Number.isSafeInteger(part))
  ) {
    fail("invalid_presentations_version");
  }
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function parseJson(raw, code) {
  try {
    return JSON.parse(raw);
  } catch {
    fail(code);
  }
}

async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

function assertOfficialEntry(entry, expectedRoot) {
  if (
    entry?.pluginId !== PRESENTATIONS_PLUGIN_ID ||
    entry?.marketplaceName !== MARKETPLACE_NAME ||
    entry?.marketplaceSource?.sourceType !== "local" ||
    entry?.marketplaceSource?.source !== expectedRoot
  ) {
    fail("presentations_source_mismatch");
  }
}

function classifyPresentationsState(result, expectedRoot, expectedVersion) {
  assertAbsolutePath(expectedRoot, "invalid_marketplace_root");
  assertNumericVersion(
    expectedVersion,
    "invalid_expected_presentations_version",
  );
  if (
    result == null ||
    typeof result !== "object" ||
    !Array.isArray(result.installed) ||
    !Array.isArray(result.available)
  ) {
    fail("invalid_plugin_list");
  }

  const installed = result.installed.filter(
    (entry) => entry?.pluginId === PRESENTATIONS_PLUGIN_ID,
  );
  const available = result.available.filter(
    (entry) => entry?.pluginId === PRESENTATIONS_PLUGIN_ID,
  );
  if (installed.length > 1 || available.length > 1) {
    fail("ambiguous_presentations_plugin");
  }

  if (available.length === 1) {
    assertOfficialEntry(available[0], expectedRoot);
    if (
      available[0].version !== expectedVersion ||
      available[0].installed === true
    ) {
      fail("available_presentations_contract_mismatch");
    }
  }

  if (installed.length === 0) {
    if (available.length !== 1) fail("presentations_plugin_missing");
    return { state: "install" };
  }

  const current = installed[0];
  assertOfficialEntry(current, expectedRoot);
  if (current.installed !== true || typeof current.enabled !== "boolean") {
    fail("invalid_installed_presentations_state");
  }
  assertNumericVersion(
    current.version,
    "invalid_installed_presentations_version",
  );

  if (current.version === expectedVersion) {
    return current.enabled === true ? { state: "ready" } : { state: "install" };
  }
  const comparison = compareNumericVersions(current.version, expectedVersion);
  if (comparison === 0) fail("presentations_version_identity_mismatch");
  if (comparison > 0) fail("presentations_downgrade_refused");
  if (comparison < 0) {
    return {
      state: "upgrade",
      installedVersion: current.version,
    };
  }
  fail("invalid_presentations_version_comparison");
}

function readPresentationsContract(result) {
  if (
    result == null ||
    typeof result !== "object" ||
    !Array.isArray(result.marketplaces)
  ) {
    fail("invalid_marketplace_list");
  }
  const candidates = result.marketplaces.filter(
    (entry) => entry?.name === MARKETPLACE_NAME,
  );
  if (candidates.length !== 1) fail("ambiguous_primary_runtime_marketplace");
  const candidate = candidates[0];
  const root = candidate.root;
  if (
    candidate.marketplaceSource?.sourceType !== "local" ||
    candidate.marketplaceSource?.source !== root
  ) {
    fail("primary_runtime_marketplace_source_mismatch");
  }
  assertAbsolutePath(root, "invalid_marketplace_root");
  assertDirectory(root, "marketplace_root_unavailable");

  const marketplaceManifestPath = path.join(
    root,
    ".agents",
    "plugins",
    "marketplace.json",
  );
  assertRegularFile(
    marketplaceManifestPath,
    "marketplace_manifest_unavailable",
  );
  const marketplaceManifest = parseJson(
    readFileSync(marketplaceManifestPath, "utf8"),
    "invalid_marketplace_manifest",
  );
  if (
    marketplaceManifest?.name !== MARKETPLACE_NAME ||
    !Array.isArray(marketplaceManifest.plugins)
  ) {
    fail("invalid_marketplace_manifest");
  }
  const presentations = marketplaceManifest.plugins.filter(
    (plugin) => plugin?.name === "presentations",
  );
  if (presentations.length !== 1) {
    fail("ambiguous_presentations_marketplace_entry");
  }
  const source = presentations[0].source;
  if (
    source?.source !== "local" ||
    typeof source.path !== "string" ||
    path.isAbsolute(source.path)
  ) {
    fail("invalid_presentations_marketplace_source");
  }
  const pluginRoot = path.resolve(root, source.path);
  const relativePluginRoot = path.relative(root, pluginRoot);
  if (
    relativePluginRoot === "" ||
    relativePluginRoot === ".." ||
    relativePluginRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePluginRoot)
  ) {
    fail("presentations_marketplace_source_escape");
  }
  assertDirectory(pluginRoot, "presentations_marketplace_source_unavailable");
  if (
    !realpathSync(pluginRoot).startsWith(`${realpathSync(root)}${path.sep}`)
  ) {
    fail("presentations_marketplace_source_escape");
  }

  const pluginManifestPath = path.join(
    pluginRoot,
    ".codex-plugin",
    "plugin.json",
  );
  assertRegularFile(pluginManifestPath, "presentations_manifest_unavailable");
  const pluginManifest = parseJson(
    readFileSync(pluginManifestPath, "utf8"),
    "invalid_presentations_manifest",
  );
  if (pluginManifest?.name !== "presentations") {
    fail("presentations_manifest_identity_mismatch");
  }
  assertNumericVersion(
    pluginManifest.version,
    "invalid_expected_presentations_version",
  );
  return { root, version: pluginManifest.version };
}

function runCodex(codexExecutable, codexHome, args) {
  const result = spawnSync(codexExecutable, args, {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: codexHome },
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) fail("codex_plugin_command_unavailable");
  return result;
}

function listPresentations(codexExecutable, codexHome) {
  const result = runCodex(codexExecutable, codexHome, [
    "plugin",
    "list",
    "--marketplace",
    MARKETPLACE_NAME,
    "--available",
    "--json",
  ]);
  if (result.status !== 0) fail("presentations_plugin_list_failed");
  return parseJson(result.stdout, "invalid_plugin_list");
}

function validateCachedPlugin(pluginPath, expectedVersion) {
  assertDirectory(pluginPath, "installed_presentations_cache_unavailable");
  const manifestPath = path.join(pluginPath, ".codex-plugin", "plugin.json");
  assertRegularFile(
    manifestPath,
    "installed_presentations_manifest_unavailable",
  );
  const manifest = parseJson(
    readFileSync(manifestPath, "utf8"),
    "invalid_installed_presentations_manifest",
  );
  if (
    manifest?.name !== "presentations" ||
    manifest?.version !== expectedVersion
  ) {
    fail("installed_presentations_manifest_mismatch");
  }
}

function prepareQuarantine(quarantineRoot, pluginPath, installedVersion) {
  if (existsSync(quarantineRoot)) {
    assertDirectory(quarantineRoot, "presentations_quarantine_unavailable");
  } else {
    mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
  }
  chmodSync(quarantineRoot, 0o700);
  const backupPath = mkdtempSync(
    path.join(quarantineRoot, `presentations-${installedVersion}.`),
  );
  chmodSync(backupPath, 0o700);
  cpSync(pluginPath, path.join(backupPath, "presentations"), {
    errorOnExist: true,
    preserveTimestamps: true,
    recursive: true,
  });
  validateCachedPlugin(
    path.join(backupPath, "presentations"),
    installedVersion,
  );
  return backupPath;
}

function restoreCachedPlugin(
  cacheRoot,
  oldPluginPath,
  backupPath,
  installedVersion,
  expectedVersion,
) {
  if (existsSync(cacheRoot)) {
    assertDirectory(cacheRoot, "failed_presentations_cache_unsafe");
    const failedCachePath = path.join(
      backupPath,
      `failed-cache-${expectedVersion}`,
    );
    if (existsSync(failedCachePath)) {
      fail("failed_presentations_backup_collision");
    }
    renameSync(cacheRoot, failedCachePath);
  }
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  cpSync(path.join(backupPath, "presentations"), oldPluginPath, {
    errorOnExist: true,
    preserveTimestamps: true,
    recursive: true,
  });
  validateCachedPlugin(oldPluginPath, installedVersion);
}

function restoreAndVerifyCachedPlugin(
  codexExecutable,
  codexHome,
  marketplaceRoot,
  cacheRoot,
  oldPluginPath,
  backupPath,
  installedVersion,
  expectedVersion,
) {
  restoreCachedPlugin(
    cacheRoot,
    oldPluginPath,
    backupPath,
    installedVersion,
    expectedVersion,
  );
  let restoredState;
  try {
    restoredState = classifyPresentationsState(
      listPresentations(codexExecutable, codexHome),
      marketplaceRoot,
      installedVersion,
    );
  } catch {
    fail("presentations_restore_verification_failed");
  }
  if (restoredState.state !== "ready") {
    fail("presentations_restore_verification_failed");
  }
}

function ensurePresentations(
  codexExecutable,
  codexHome,
  marketplaceRoot,
  expectedVersion,
  quarantineRoot,
) {
  for (const [value, code] of [
    [codexExecutable, "invalid_codex_executable"],
    [codexHome, "invalid_codex_home"],
    [marketplaceRoot, "invalid_marketplace_root"],
    [quarantineRoot, "invalid_quarantine_root"],
  ]) {
    assertAbsolutePath(value, code);
  }
  assertRegularFile(codexExecutable, "codex_executable_unavailable");
  assertDirectory(codexHome, "codex_home_unavailable");
  assertDirectory(marketplaceRoot, "marketplace_root_unavailable");
  assertNumericVersion(
    expectedVersion,
    "invalid_expected_presentations_version",
  );

  const initialState = classifyPresentationsState(
    listPresentations(codexExecutable, codexHome),
    marketplaceRoot,
    expectedVersion,
  );
  if (initialState.state === "ready") {
    return {
      action: "none",
      state: "ready",
      version: expectedVersion,
    };
  }

  let backupPath;
  let cacheRoot;
  let oldPluginPath;
  if (initialState.state === "upgrade") {
    cacheRoot = path.join(
      codexHome,
      "plugins",
      "cache",
      MARKETPLACE_NAME,
      "presentations",
    );
    oldPluginPath = path.join(cacheRoot, initialState.installedVersion);
    const expectedPluginPath = path.join(cacheRoot, expectedVersion);
    validateCachedPlugin(oldPluginPath, initialState.installedVersion);
    if (existsSync(expectedPluginPath)) {
      fail("unexpected_target_presentations_cache");
    }
    backupPath = prepareQuarantine(
      quarantineRoot,
      oldPluginPath,
      initialState.installedVersion,
    );
  }

  const installResult = runCodex(codexExecutable, codexHome, [
    "plugin",
    "add",
    PRESENTATIONS_PLUGIN_ID,
    "--json",
  ]);
  if (installResult.status !== 0) {
    if (backupPath != null) {
      restoreAndVerifyCachedPlugin(
        codexExecutable,
        codexHome,
        marketplaceRoot,
        cacheRoot,
        oldPluginPath,
        backupPath,
        initialState.installedVersion,
        expectedVersion,
      );
    }
    fail("official_presentations_install_failed");
  }

  let finalState;
  try {
    finalState = classifyPresentationsState(
      listPresentations(codexExecutable, codexHome),
      marketplaceRoot,
      expectedVersion,
    );
  } catch (error) {
    if (backupPath != null) {
      restoreAndVerifyCachedPlugin(
        codexExecutable,
        codexHome,
        marketplaceRoot,
        cacheRoot,
        oldPluginPath,
        backupPath,
        initialState.installedVersion,
        expectedVersion,
      );
    }
    throw error;
  }
  if (finalState.state !== "ready") {
    if (backupPath != null) {
      restoreAndVerifyCachedPlugin(
        codexExecutable,
        codexHome,
        marketplaceRoot,
        cacheRoot,
        oldPluginPath,
        backupPath,
        initialState.installedVersion,
        expectedVersion,
      );
    }
    fail("presentations_post_install_verification_failed");
  }

  if (initialState.state === "upgrade") {
    return {
      action: "upgraded",
      backupPath,
      fromVersion: initialState.installedVersion,
      state: "ready",
      version: expectedVersion,
    };
  }
  return {
    action: "installed",
    state: "ready",
    version: expectedVersion,
  };
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderLaunchd([
  templatePath,
  targetPath,
  nodeExecutable,
  runtimeEntry,
  configPath,
  repositoryRoot,
  codexHome,
  homePath,
  minimalPath,
  stdoutPath,
  stderrPath,
]) {
  const replacements = new Map([
    ["__NODE_EXECUTABLE__", nodeExecutable],
    ["__RUNTIME_ENTRY__", runtimeEntry],
    ["__CONFIG_PATH__", configPath],
    ["__REPOSITORY_ROOT__", repositoryRoot],
    ["__CODEX_HOME__", codexHome],
    ["__HOME__", homePath],
    ["__MINIMAL_PATH__", minimalPath],
    ["__STDOUT_PATH__", stdoutPath],
    ["__STDERR_PATH__", stderrPath],
  ]);
  for (const value of replacements.values()) {
    if (typeof value !== "string" || value.length === 0) {
      fail("invalid_launchd_render_value");
    }
  }
  assertRegularFile(templatePath, "launchd_template_unavailable");
  assertAbsolutePath(targetPath, "invalid_launchd_target");
  let output = readFileSync(templatePath, "utf8");
  for (const [token, value] of replacements) {
    output = output.replaceAll(token, escapeXml(value));
  }
  if (/__[A-Z0-9_]+__/.test(output)) fail("unresolved_launchd_placeholder");

  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.tmp`,
  );
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, output, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporaryPath, targetPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "presentations-contract": {
      assertArgumentCount(args, 0);
      const marketplaceList = parseJson(
        await readStdin(),
        "invalid_marketplace_list",
      );
      process.stdout.write(
        `${JSON.stringify(readPresentationsContract(marketplaceList))}\n`,
      );
      return;
    }
    case "presentations-state": {
      assertArgumentCount(args, 2);
      const [expectedRoot, expectedVersion] = args;
      const pluginList = parseJson(await readStdin(), "invalid_plugin_list");
      process.stdout.write(
        `${JSON.stringify(
          classifyPresentationsState(pluginList, expectedRoot, expectedVersion),
        )}\n`,
      );
      return;
    }
    case "ensure-presentations": {
      assertArgumentCount(args, 5);
      process.stdout.write(`${JSON.stringify(ensurePresentations(...args))}\n`);
      return;
    }
    case "render-launchd": {
      assertArgumentCount(args, 11);
      renderLaunchd(args);
      return;
    }
    default:
      fail("unknown_install_support_command");
  }
}

main().catch((error) => {
  process.stderr.write(`install-support:${error.message}\n`);
  process.exitCode = 1;
});
