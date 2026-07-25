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
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const installSupportPath = join(
  repositoryRoot,
  "scripts",
  "install-support.mjs",
);
const plistTemplatePath = join(
  repositoryRoot,
  "launchd",
  "com.codex-feishu.executive-assistant.plist.template",
);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTemporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function officialEntry(
  version: string,
  source: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    pluginId: "presentations@openai-primary-runtime",
    marketplaceName: "openai-primary-runtime",
    marketplaceSource: {
      sourceType: "local",
      source,
    },
    version,
    installed: true,
    enabled: true,
    ...overrides,
  };
}

function classify(
  input: unknown,
  expectedRoot = "/official/openai-primary-runtime",
  expectedVersion = "26.723.12215",
) {
  return spawnSync(
    process.execPath,
    [installSupportPath, "presentations-state", expectedRoot, expectedVersion],
    {
      encoding: "utf8",
      input: `${JSON.stringify(input)}\n`,
    },
  );
}

function writeFakeCodex(fakeCodexPath: string): void {
  writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const codexHome = process.env.CODEX_HOME;
const source = process.env.FAKE_MARKET_ROOT;
const expectedVersion = process.env.FAKE_EXPECTED_VERSION;
const args = process.argv.slice(2);
const cacheRoot = path.join(
  codexHome,
  "plugins",
  "cache",
  "openai-primary-runtime",
  "presentations",
);
const versions = fs.existsSync(cacheRoot)
  ? fs.readdirSync(cacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  : [];
const currentVersion = versions.includes(expectedVersion)
  ? expectedVersion
  : versions[0];

if (args[0] === "plugin" && args[1] === "list") {
  if (
    process.env.FAKE_POST_LIST_FAIL === "1" &&
    currentVersion === expectedVersion
  ) {
    process.exit(74);
  }
  if (currentVersion == null) {
    process.stdout.write(JSON.stringify({
      installed: [],
      available: [{
        pluginId: "presentations@openai-primary-runtime",
        marketplaceName: "openai-primary-runtime",
        marketplaceSource: { sourceType: "local", source },
        version: expectedVersion,
        installed: false,
        enabled: false,
      }],
    }));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    installed: [{
      pluginId: "presentations@openai-primary-runtime",
      marketplaceName: "openai-primary-runtime",
      marketplaceSource: { sourceType: "local", source },
      version: currentVersion,
      installed: true,
      enabled: true,
    }],
    available: [],
  }));
  process.exit(0);
}

if (args[0] === "plugin" && args[1] === "add") {
  const target = path.join(cacheRoot, expectedVersion);
  if (process.env.FAKE_KEEP_OLD_CACHE !== "1") {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
  if (process.env.FAKE_ADD_FAIL === "1") {
    if (process.env.FAKE_LEAVE_PARTIAL_CACHE === "1") {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "partial"), "incomplete");
    }
    process.exit(73);
  }
  fs.mkdirSync(path.join(target, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(target, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "presentations", version: expectedVersion }),
  );
  process.stdout.write(JSON.stringify({
    pluginId: "presentations@openai-primary-runtime",
    version: expectedVersion,
  }));
  process.exit(0);
}

process.exit(64);
`,
    { mode: 0o700 },
  );
  chmodSync(fakeCodexPath, 0o700);
}

function prepareOlderOfficialPlugin() {
  const root = makeTemporaryRoot("assistant-presentations-upgrade.");
  const codexHome = join(root, "codex-home");
  const marketplaceRoot = join(root, "official-marketplace");
  const quarantineRoot = join(root, "runtime", "quarantine");
  const fakeCodexPath = join(root, "fake-codex.mjs");
  const oldVersion = "26.715.12143";
  const expectedVersion = "26.723.12215";
  const oldPluginPath = join(
    codexHome,
    "plugins",
    "cache",
    "openai-primary-runtime",
    "presentations",
    oldVersion,
  );
  mkdirSync(join(oldPluginPath, ".codex-plugin"), { recursive: true });
  mkdirSync(marketplaceRoot, { recursive: true });
  writeFileSync(
    join(oldPluginPath, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "presentations", version: oldVersion }),
  );
  writeFakeCodex(fakeCodexPath);
  return {
    codexHome,
    expectedVersion,
    fakeCodexPath,
    marketplaceRoot,
    oldPluginPath,
    oldVersion,
    quarantineRoot,
  };
}

function expectedPluginPath(
  fixture: ReturnType<typeof prepareOlderOfficialPlugin>,
) {
  return join(
    fixture.codexHome,
    "plugins",
    "cache",
    "openai-primary-runtime",
    "presentations",
    fixture.expectedVersion,
  );
}

function ensurePresentations(
  fixture: ReturnType<typeof prepareOlderOfficialPlugin>,
  env: Record<string, string> = {},
) {
  return spawnSync(
    process.execPath,
    [
      installSupportPath,
      "ensure-presentations",
      fixture.fakeCodexPath,
      fixture.codexHome,
      fixture.marketplaceRoot,
      fixture.expectedVersion,
      fixture.quarantineRoot,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_EXPECTED_VERSION: fixture.expectedVersion,
        FAKE_MARKET_ROOT: fixture.marketplaceRoot,
        ...env,
      },
    },
  );
}

function prepareFakeLaunchctl(mode: string) {
  const root = makeTemporaryRoot("assistant-launchd-reload.");
  const fakeLaunchctlPath = join(root, "fake-launchctl.mjs");
  const logPath = join(root, "launchctl.log");
  const statePath = join(root, "launchctl-state.json");
  const plistPath = join(root, "assistant.plist");
  writeFileSync(plistPath, '<?xml version="1.0"?><plist></plist>\n');
  writeFileSync(
    fakeLaunchctlPath,
    `#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
const logPath = process.env.FAKE_LAUNCHCTL_LOG;
const statePath = process.env.FAKE_LAUNCHCTL_STATE;
const mode = process.env.FAKE_LAUNCHCTL_MODE;
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, "utf8"))
  : {
      bootedOut: false,
      bootstrapAttempts: 0,
      loaded: mode !== "fresh-eio",
      removalPolls: 0,
      removing: false,
    };
fs.appendFileSync(logPath, \`\${args.join(" ")}\\n\`);

if (args[0] === "print") {
  if (
    mode === "initial-state-unknown" &&
    !state.bootedOut &&
    state.bootstrapAttempts === 0
  ) {
    process.exit(5);
  }
  if (state.loaded) process.exit(0);
  if (!state.removing) process.exit(113);
  if (mode === "removal-state-unknown") process.exit(5);
  state.removalPolls += 1;
  if (mode !== "removal-timeout" && state.removalPolls > 2) {
    state.removing = false;
  }
  fs.writeFileSync(statePath, JSON.stringify(state));
  if (state.removing) process.exit(0);
  process.exit(113);
}

if (args[0] === "bootout") {
  state.bootedOut = true;
  state.loaded = false;
  state.removing = true;
  fs.writeFileSync(statePath, JSON.stringify(state));
  if (mode === "bootout-nonzero-transition") process.exit(5);
  process.exit(0);
}

if (args[0] === "bootstrap") {
  state.bootstrapAttempts += 1;
  fs.writeFileSync(statePath, JSON.stringify(state));
  if (
    (mode === "transition-eio" && state.bootstrapAttempts === 1) ||
    mode === "eio-exhausted"
  ) {
    process.stderr.write("localized launchd status 5\\n");
    process.exit(5);
  }
  if (mode === "fresh-eio") {
    process.stderr.write("Bootstrap failed: 5: Input/output error\\n");
    process.exit(5);
  }
  if (mode === "non-eio-bootstrap") {
    process.stderr.write("different bootstrap failure\\n");
    process.exit(64);
  }
  if (mode === "bootstrap-ambiguous") {
    state.loaded = true;
    fs.writeFileSync(statePath, JSON.stringify(state));
    process.exit(5);
  }
  if (mode === "post-bootstrap-missing") process.exit(0);
  state.loaded = true;
  state.removing = false;
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.exit(0);
}

if (args[0] === "kickstart") {
  process.exit(mode === "kickstart-failure" ? 69 : 0);
}
process.exit(64);
`,
    { mode: 0o700 },
  );
  chmodSync(fakeLaunchctlPath, 0o700);
  return {
    env: {
      ...process.env,
      ASSISTANT_TEST_MODE: "1",
      FAKE_LAUNCHCTL_LOG: logPath,
      FAKE_LAUNCHCTL_MODE: mode,
      FAKE_LAUNCHCTL_STATE: statePath,
    },
    fakeLaunchctlPath,
    logPath,
    plistPath,
    statePath,
  };
}

function reloadLaunchd(fixture: ReturnType<typeof prepareFakeLaunchctl>) {
  return spawnSync(
    process.execPath,
    [
      installSupportPath,
      "reload-launchd",
      fixture.fakeLaunchctlPath,
      "gui/501",
      "com.codex-feishu.executive-assistant",
      fixture.plistPath,
    ],
    { encoding: "utf8", env: fixture.env },
  );
}

describe("installer compatibility support", () => {
  it("derives the expected version from the unique official marketplace source", () => {
    const root = makeTemporaryRoot("assistant-presentations-contract.");
    const marketplaceRoot = join(root, "openai-primary-runtime");
    mkdirSync(
      join(marketplaceRoot, "plugins", "presentations", ".codex-plugin"),
      { recursive: true },
    );
    mkdirSync(join(marketplaceRoot, ".agents", "plugins"), { recursive: true });
    writeFileSync(
      join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
      JSON.stringify({
        name: "openai-primary-runtime",
        plugins: [
          {
            name: "presentations",
            source: { source: "local", path: "./plugins/presentations" },
          },
        ],
      }),
    );
    writeFileSync(
      join(
        marketplaceRoot,
        "plugins",
        "presentations",
        ".codex-plugin",
        "plugin.json",
      ),
      JSON.stringify({ name: "presentations", version: "26.723.12215" }),
    );

    const result = spawnSync(
      process.execPath,
      [installSupportPath, "presentations-contract"],
      {
        encoding: "utf8",
        input: `${JSON.stringify({
          marketplaces: [
            {
              name: "openai-primary-runtime",
              root: marketplaceRoot,
              marketplaceSource: {
                sourceType: "local",
                source: marketplaceRoot,
              },
            },
          ],
        })}\n`,
      },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      root: marketplaceRoot,
      version: "26.723.12215",
    });
  });

  it("classifies only an older plugin from the same official source as upgradeable", () => {
    const expectedRoot = "/official/openai-primary-runtime";
    const older = classify({
      installed: [officialEntry("26.715.12143", expectedRoot)],
      available: [],
    });
    expect(older.status).toBe(0);
    expect(JSON.parse(older.stdout)).toEqual({
      state: "upgrade",
      installedVersion: "26.715.12143",
    });

    const wrongSource = classify({
      installed: [officialEntry("26.715.12143", "/untrusted/marketplace")],
      available: [],
    });
    expect(wrongSource.status).not.toBe(0);

    const downgrade = classify({
      installed: [officialEntry("26.800.1", expectedRoot)],
      available: [],
    });
    expect(downgrade.status).not.toBe(0);

    for (const equivalentButDifferent of ["26.723.12215.0", "026.723.12215"]) {
      const result = classify({
        installed: [officialEntry(equivalentButDifferent, expectedRoot)],
        available: [],
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "presentations_version_identity_mismatch",
      );
    }
  });

  it("distinguishes a fresh install from an already ready official plugin", () => {
    const expectedRoot = "/official/openai-primary-runtime";
    const version = "26.723.12215";
    const fresh = classify({
      installed: [],
      available: [
        officialEntry(version, expectedRoot, {
          installed: false,
          enabled: false,
        }),
      ],
    });
    expect(fresh.status).toBe(0);
    expect(JSON.parse(fresh.stdout)).toEqual({ state: "install" });

    const ready = classify({
      installed: [officialEntry(version, expectedRoot)],
      available: [],
    });
    expect(ready.status).toBe(0);
    expect(JSON.parse(ready.stdout)).toEqual({ state: "ready" });
  });

  it("backs up an older official cache before upgrading and verifies the result", () => {
    const fixture = prepareOlderOfficialPlugin();
    const result = ensurePresentations(fixture);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      action: "upgraded",
      fromVersion: fixture.oldVersion,
      state: "ready",
      version: fixture.expectedVersion,
    });
    expect(existsSync(fixture.oldPluginPath)).toBe(false);
    expect(existsSync(expectedPluginPath(fixture))).toBe(true);
    expect(existsSync(join(output.backupPath, "presentations"))).toBe(true);
    expect(statSync(output.backupPath).mode & 0o777).toBe(0o700);
  });

  it("restores the older cache if the official upgrade command fails", () => {
    const fixture = prepareOlderOfficialPlugin();
    const result = ensurePresentations(fixture, { FAKE_ADD_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("official_presentations_install_failed");
    expect(existsSync(fixture.oldPluginPath)).toBe(true);
    expect(
      JSON.parse(
        readFileSync(
          join(fixture.oldPluginPath, ".codex-plugin", "plugin.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      name: "presentations",
      version: fixture.oldVersion,
    });
  });

  it("removes a partial new cache even when the old cache survived an add failure", () => {
    const fixture = prepareOlderOfficialPlugin();
    const result = ensurePresentations(fixture, {
      FAKE_ADD_FAIL: "1",
      FAKE_KEEP_OLD_CACHE: "1",
      FAKE_LEAVE_PARTIAL_CACHE: "1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("official_presentations_install_failed");
    expect(existsSync(fixture.oldPluginPath)).toBe(true);
    expect(existsSync(expectedPluginPath(fixture))).toBe(false);
  });

  it("restores the exact old cache after an upgraded cache fails post-verification", () => {
    const fixture = prepareOlderOfficialPlugin();
    const result = ensurePresentations(fixture, {
      FAKE_KEEP_OLD_CACHE: "1",
      FAKE_POST_LIST_FAIL: "1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("presentations_plugin_list_failed");
    expect(existsSync(fixture.oldPluginPath)).toBe(true);
    expect(existsSync(expectedPluginPath(fixture))).toBe(false);
  });

  it("renders the LaunchAgent while REPOSITORY_ROOT remains readonly", () => {
    const root = makeTemporaryRoot("assistant-launchd-render.");
    const targetPath = join(root, "assistant.plist");
    const repositoryPath = join(root, "repository & source");
    const shell = `
      emulate -LR zsh
      set -euo pipefail
      readonly REPOSITORY_ROOT="$1"
      "$2" "$3" render-launchd \
        "$4" "$5" "$6" "$7" "$8" "\${REPOSITORY_ROOT}" \
        "$9" "\${10}" "\${11}" "\${12}" "\${13}"
    `;
    const result = spawnSync(
      "/bin/zsh",
      [
        "-c",
        shell,
        "install-render-test",
        repositoryPath,
        process.execPath,
        installSupportPath,
        plistTemplatePath,
        targetPath,
        "/opt/node & runtime",
        "/runtime/entry.js",
        "/config/assistant.json",
        "/dedicated/codex-home",
        "/Users/executive",
        "/opt/bin:/usr/bin:/bin",
        "/logs/stdout.log",
        "/logs/stderr.log",
      ],
      { encoding: "utf8" },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const rendered = readFileSync(targetPath, "utf8");
    expect(rendered).toContain("<string>/opt/node &amp; runtime</string>");
    expect(rendered).toContain(
      `<string>${repositoryPath.replace("&", "&amp;")}</string>`,
    );
    expect(rendered).not.toMatch(/__[A-Z0-9_]+__/);
  });

  it("waits for a removed LaunchAgent and retries only its transition EIO", () => {
    const fixture = prepareFakeLaunchctl("transition-eio");
    const result = reloadLaunchd(fixture);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      action: "reloaded",
      bootedOut: true,
      bootstrapAttempts: 2,
    });
    expect(readFileSync(fixture.logPath, "utf8").trim().split("\n")).toEqual([
      "print gui/501/com.codex-feishu.executive-assistant",
      "bootout gui/501/com.codex-feishu.executive-assistant",
      "print gui/501/com.codex-feishu.executive-assistant",
      "print gui/501/com.codex-feishu.executive-assistant",
      "print gui/501/com.codex-feishu.executive-assistant",
      `bootstrap gui/501 ${fixture.plistPath}`,
      "print gui/501/com.codex-feishu.executive-assistant",
      `bootstrap gui/501 ${fixture.plistPath}`,
      "print gui/501/com.codex-feishu.executive-assistant",
      "kickstart -k gui/501/com.codex-feishu.executive-assistant",
    ]);
  });

  it("does not retry a bootstrap EIO when no prior service was removed", () => {
    const fixture = prepareFakeLaunchctl("fresh-eio");
    const result = reloadLaunchd(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("launchd_bootstrap_failed");
    expect(readFileSync(fixture.logPath, "utf8").trim().split("\n")).toEqual([
      "print gui/501/com.codex-feishu.executive-assistant",
      `bootstrap gui/501 ${fixture.plistPath}`,
      "print gui/501/com.codex-feishu.executive-assistant",
    ]);
  });

  it("fails closed before bootstrap if launchd never finishes removal", () => {
    const fixture = prepareFakeLaunchctl("removal-timeout");
    const result = reloadLaunchd(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("launchd_bootout_timeout");
    expect(readFileSync(fixture.logPath, "utf8")).not.toContain("bootstrap");
  });

  it("rejects an unknown initial launchd state instead of treating it as absent", () => {
    const fixture = prepareFakeLaunchctl("initial-state-unknown");
    const result = reloadLaunchd(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("launchd_initial_state_unavailable");
    expect(readFileSync(fixture.logPath, "utf8").trim()).toBe(
      "print gui/501/com.codex-feishu.executive-assistant",
    );
  });

  it("rejects an unknown removal poll state before bootstrap", () => {
    const fixture = prepareFakeLaunchctl("removal-state-unknown");
    const result = reloadLaunchd(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("launchd_removal_state_unavailable");
    expect(readFileSync(fixture.logPath, "utf8")).not.toContain("bootstrap");
  });

  it("accepts a nonzero bootout only after print confirms status 113", () => {
    const fixture = prepareFakeLaunchctl("bootout-nonzero-transition");
    const result = reloadLaunchd(fixture);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "reloaded",
      bootedOut: true,
    });
  });

  it("does not retry a non-EIO bootstrap failure after removal", () => {
    const fixture = prepareFakeLaunchctl("non-eio-bootstrap");
    const result = reloadLaunchd(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("launchd_bootstrap_failed");
    expect(
      readFileSync(fixture.logPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("bootstrap ")),
    ).toHaveLength(1);
  });

  it("limits a removal-transition EIO to three bootstrap attempts", () => {
    const fixture = prepareFakeLaunchctl("eio-exhausted");
    const result = reloadLaunchd(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("launchd_bootstrap_failed");
    expect(
      readFileSync(fixture.logPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("bootstrap ")),
    ).toHaveLength(3);
  });

  it("fails closed if a failed bootstrap nevertheless leaves a loaded service", () => {
    const fixture = prepareFakeLaunchctl("bootstrap-ambiguous");
    const result = reloadLaunchd(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("launchd_bootstrap_ambiguous");
  });

  it("verifies the service is loaded after a successful bootstrap", () => {
    const fixture = prepareFakeLaunchctl("post-bootstrap-missing");
    const result = reloadLaunchd(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "launchd_post_bootstrap_verification_failed",
    );
  });

  it("propagates a kickstart failure without claiming success", () => {
    const fixture = prepareFakeLaunchctl("kickstart-failure");
    const result = reloadLaunchd(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("launchd_kickstart_failed");
  });
});
