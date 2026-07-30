#!/usr/bin/env node

import { Buffer } from "node:buffer";
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
  readSync,
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
const LAUNCHD_LABEL = "com.codex-feishu.executive-assistant";
const KEYCHAIN_SERVICE = "com.codex-feishu-executive-assistant.bot";
const VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+)+$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const FORBIDDEN_SECRET_KEYS = new Set([
  "appsecret",
  "clientsecret",
  "client_secret",
  "secretvalue",
  "secret_value",
  "app_secret",
  "secret",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "password",
  "credential",
  "credentials",
]);

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

function assertCodexNodeEntrypoint(nodeExecutable, codexExecutable) {
  assertAbsolutePath(nodeExecutable, "invalid_node_executable");
  assertAbsolutePath(codexExecutable, "invalid_codex_executable");
  assertRegularFile(nodeExecutable, "node_executable_unavailable");
  assertRegularFile(codexExecutable, "codex_executable_unavailable");

  const descriptor = openSync(codexExecutable, "r");
  const prefix = Buffer.alloc(64);
  let length;
  try {
    length = readSync(descriptor, prefix, 0, prefix.length, 0);
  } finally {
    closeSync(descriptor);
  }
  const newline = prefix.subarray(0, length).indexOf(0x0a);
  if (
    newline === -1 ||
    prefix.subarray(0, newline).toString("utf8") !== "#!/usr/bin/env node"
  ) {
    fail("unsupported_codex_entrypoint");
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExactIdentifier(value, nullable = false) {
  if (nullable && value === null) return true;
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value === value.trim() &&
    !value.includes("\0")
  );
}

function isAbsoluteConfigPath(value, nullable = false) {
  if (nullable && value === null) return true;
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    path.isAbsolute(value) &&
    path.resolve(value) === value
  );
}

function hasForbiddenSecretField(value) {
  if (Array.isArray(value)) return value.some(hasForbiddenSecretField);
  if (!isRecord(value)) return false;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_SECRET_KEYS.has(key.toLowerCase())) return true;
    if (hasForbiddenSecretField(entry)) return true;
  }
  return false;
}

function assertRuntimeConfigContract(
  config,
  {
    expectedAppId,
    expectedRuntimeRoot,
    expectedLarkHome,
    expectedLarkCli,
    expectedPresentationsVersion,
  },
) {
  if (hasForbiddenSecretField(config)) {
    fail("runtime_config_contains_secret_field");
  }
  const paired =
    isExactIdentifier(config?.presidentOpenId) &&
    isExactIdentifier(config?.presidentChatId);
  const unpaired =
    config?.presidentOpenId === null && config?.presidentChatId === null;
  const pairing = config?.pairing;
  const pairingShapeValid =
    isRecord(pairing) &&
    typeof pairing.enabled === "boolean" &&
    (pairing.codeHash === null ||
      (typeof pairing.codeHash === "string" &&
        SHA256_PATTERN.test(pairing.codeHash))) &&
    (pairing.expiresAt === null ||
      (typeof pairing.expiresAt === "string" &&
        Number.isFinite(Date.parse(pairing.expiresAt)))) &&
    ((pairing.enabled &&
      pairing.codeHash !== null &&
      pairing.expiresAt !== null) ||
      (!pairing.enabled &&
        pairing.codeHash === null &&
        pairing.expiresAt === null));
  if (
    !isRecord(config) ||
    config.schemaVersion !== 1 ||
    config.appId !== expectedAppId ||
    !isExactIdentifier(config.appId) ||
    !isExactIdentifier(config.tenantKey ?? null, true) ||
    (!paired && !unpaired) ||
    !pairingShapeValid ||
    (paired && pairing.enabled) ||
    (unpaired && !pairing.enabled) ||
    !isRecord(config.secretRef) ||
    config.secretRef.type !== "macos-keychain" ||
    config.secretRef.service !== KEYCHAIN_SERVICE ||
    config.secretRef.account !== expectedAppId ||
    !isRecord(config.paths) ||
    config.paths.runtimeRoot !== expectedRuntimeRoot ||
    !isAbsoluteConfigPath(config.paths.jobsRoot) ||
    !isAbsoluteConfigPath(config.paths.workspaceRoot) ||
    !isAbsoluteConfigPath(config.paths.codexHome) ||
    config.paths.larkHome !== expectedLarkHome ||
    !isAbsoluteConfigPath(config.paths.databasePath) ||
    !isRecord(config.executables) ||
    !isAbsoluteConfigPath(config.executables.node) ||
    !isAbsoluteConfigPath(config.executables.codex) ||
    !isAbsoluteConfigPath(config.executables.gatewayClient) ||
    config.executables.larkCli !== expectedLarkCli ||
    !isAbsoluteConfigPath(config.executables.runtimeEntry, true) ||
    config.visualFirstPpt?.presentationsPlugin?.id !==
      PRESENTATIONS_PLUGIN_ID ||
    config.visualFirstPpt?.presentationsPlugin?.version !==
      expectedPresentationsVersion
  ) {
    fail("runtime_config_identity_mismatch");
  }
}

function assertSafeConfigFile(configPath) {
  assertAbsolutePath(configPath, "invalid_runtime_config_path");
  assertRegularFile(configPath, "runtime_config_unavailable");
  const stat = lstatSync(configPath);
  if (
    (stat.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
    realpathSync(configPath) !== configPath
  ) {
    fail("runtime_config_identity_mismatch");
  }
}

function writeAtomicJson(targetPath, value) {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.tmp`,
  );
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

function refreshRuntimeExecutables([
  configPath,
  expectedAppId,
  expectedRuntimeRoot,
  expectedLarkHome,
  expectedLarkCli,
  expectedUserAuthHelper,
  expectedPresentationsVersion,
  nodeExecutable,
  codexExecutable,
]) {
  assertSafeConfigFile(configPath);
  for (const [value, code] of [
    [expectedRuntimeRoot, "invalid_expected_runtime_root"],
    [expectedLarkHome, "invalid_expected_lark_home"],
    [expectedLarkCli, "invalid_expected_lark_cli"],
    [expectedUserAuthHelper, "invalid_expected_user_auth_helper"],
  ]) {
    assertAbsolutePath(value, code);
  }
  assertCodexNodeEntrypoint(nodeExecutable, codexExecutable);
  const config = parseJson(
    readFileSync(configPath, "utf8"),
    "invalid_runtime_config",
  );
  assertRuntimeConfigContract(config, {
    expectedAppId,
    expectedRuntimeRoot,
    expectedLarkHome,
    expectedLarkCli,
    expectedPresentationsVersion,
  });
  if (
    config.executables.userAuthHelper !== undefined &&
    config.executables.userAuthHelper !== expectedUserAuthHelper
  ) {
    fail("runtime_config_identity_mismatch");
  }
  if (
    config.executables.node === nodeExecutable &&
    config.executables.codex === codexExecutable &&
    config.executables.userAuthHelper === expectedUserAuthHelper
  ) {
    return { action: "unchanged" };
  }

  config.executables = {
    ...config.executables,
    node: nodeExecutable,
    codex: codexExecutable,
    userAuthHelper: expectedUserAuthHelper,
  };
  writeAtomicJson(configPath, config);
  assertSafeConfigFile(configPath);
  const verified = parseJson(
    readFileSync(configPath, "utf8"),
    "invalid_refreshed_runtime_config",
  );
  if (
    verified?.executables?.node !== nodeExecutable ||
    verified?.executables?.codex !== codexExecutable ||
    verified?.executables?.userAuthHelper !== expectedUserAuthHelper ||
    verified?.appId !== expectedAppId
  ) {
    fail("runtime_executable_refresh_verification_failed");
  }
  return { action: "updated" };
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

function runLaunchctl(launchctlExecutable, args) {
  const result = spawnSync(launchctlExecutable, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error) fail("launchctl_unavailable");
  return result;
}

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    0,
    0,
    milliseconds,
  );
}

function isRemovalTransitionEio(result) {
  return result.status === 5;
}

function classifyLaunchdPrint(result, unavailableCode) {
  if (result.status === 0) return "loaded";
  if (result.status === 113) return "absent";
  fail(unavailableCode);
}

function reloadLaunchd([
  launchctlExecutable,
  launchDomain,
  launchdLabel,
  plistPath,
]) {
  assertAbsolutePath(launchctlExecutable, "invalid_launchctl_executable");
  assertRegularFile(launchctlExecutable, "launchctl_unavailable");
  assertRegularFile(plistPath, "launchd_plist_unavailable");
  if (!/^gui\/(?:0|[1-9][0-9]*)$/.test(launchDomain)) {
    fail("invalid_launchd_domain");
  }
  if (launchdLabel !== LAUNCHD_LABEL) fail("invalid_launchd_label");

  const serviceTarget = `${launchDomain}/${launchdLabel}`;
  const testMode = process.env.ASSISTANT_TEST_MODE === "1";
  const pollDelayMilliseconds = testMode ? 0 : 250;
  const removalPollLimit = testMode ? 6 : 40;
  const bootstrapAttemptLimit = 3;
  let bootedOut = false;

  const initialState = classifyLaunchdPrint(
    runLaunchctl(launchctlExecutable, ["print", serviceTarget]),
    "launchd_initial_state_unavailable",
  );
  if (initialState === "loaded") {
    runLaunchctl(launchctlExecutable, ["bootout", serviceTarget]);
    bootedOut = true;

    let removed = false;
    for (let poll = 0; poll < removalPollLimit; poll += 1) {
      const currentState = classifyLaunchdPrint(
        runLaunchctl(launchctlExecutable, ["print", serviceTarget]),
        "launchd_removal_state_unavailable",
      );
      if (currentState === "absent") {
        removed = true;
        break;
      }
      if (poll + 1 < removalPollLimit) sleepSync(pollDelayMilliseconds);
    }
    if (!removed) fail("launchd_bootout_timeout");
  }

  let bootstrapAttempts = 0;
  for (;;) {
    bootstrapAttempts += 1;
    const bootstrap = runLaunchctl(launchctlExecutable, [
      "bootstrap",
      launchDomain,
      plistPath,
    ]);
    if (bootstrap.status === 0) break;

    const stateAfterFailure = classifyLaunchdPrint(
      runLaunchctl(launchctlExecutable, ["print", serviceTarget]),
      "launchd_post_failure_state_unavailable",
    );
    if (stateAfterFailure === "loaded") {
      fail("launchd_bootstrap_ambiguous");
    }
    if (
      !bootedOut ||
      bootstrapAttempts >= bootstrapAttemptLimit ||
      !isRemovalTransitionEio(bootstrap)
    ) {
      fail("launchd_bootstrap_failed");
    }
    sleepSync(pollDelayMilliseconds);
  }

  const loadedState = classifyLaunchdPrint(
    runLaunchctl(launchctlExecutable, ["print", serviceTarget]),
    "launchd_post_bootstrap_state_unavailable",
  );
  if (loadedState !== "loaded") {
    fail("launchd_post_bootstrap_verification_failed");
  }
  const kickstart = runLaunchctl(launchctlExecutable, [
    "kickstart",
    "-k",
    serviceTarget,
  ]);
  if (kickstart.status !== 0) fail("launchd_kickstart_failed");

  return {
    action: bootedOut ? "reloaded" : "loaded",
    bootedOut,
    bootstrapAttempts,
  };
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
    case "validate-codex-entry": {
      assertArgumentCount(args, 2);
      assertCodexNodeEntrypoint(...args);
      process.stdout.write('{"kind":"node-script"}\n');
      return;
    }
    case "refresh-runtime-executables": {
      assertArgumentCount(args, 9);
      process.stdout.write(
        `${JSON.stringify(refreshRuntimeExecutables(args))}\n`,
      );
      return;
    }
    case "render-launchd": {
      assertArgumentCount(args, 11);
      renderLaunchd(args);
      return;
    }
    case "reload-launchd": {
      assertArgumentCount(args, 4);
      process.stdout.write(`${JSON.stringify(reloadLaunchd(args))}\n`);
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
