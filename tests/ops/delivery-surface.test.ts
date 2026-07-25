import { execFileSync, spawnSync } from "node:child_process";
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
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const installPath = join(repositoryRoot, "scripts/install");
const installSupportPath = join(
  repositoryRoot,
  "scripts",
  "install-support.mjs",
);
const doctorPath = join(repositoryRoot, "scripts/doctor");
const feishuNetworkDoctorPath = join(
  repositoryRoot,
  "scripts",
  "doctor-feishu-network.mjs",
);
const restartPath = join(repositoryRoot, "scripts/restart");
const temporaryRoots: string[] = [];

function temporaryHome(): string {
  const root = mkdtempSync(join(tmpdir(), "ea-ops-test-"));
  temporaryRoots.push(root);
  return root;
}

function runZsh(
  script: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
) {
  return spawnSync("/bin/zsh", [script, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function copyMinimalInstallDelivery(root: string): string {
  for (const entry of [
    "dependencies.lock.json",
    "config",
    "launchd",
    "skills/executive-assistant",
    "LICENSES/visual-first-ppt-MIT.txt",
    "scripts/install",
    "scripts/install-support.mjs",
    "scripts/doctor-feishu-network.mjs",
  ]) {
    cpSync(join(repositoryRoot, entry), join(root, entry), { recursive: true });
  }
  return join(root, "scripts", "install");
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const candidate = temporaryRoots.pop();
    if (candidate?.startsWith(join(tmpdir(), "ea-ops-test-"))) {
      rmSync(candidate, { recursive: true, force: true });
    }
  }
});

describe("lean delivery surface", () => {
  it("keeps every shell entry syntactically valid", () => {
    for (const script of [installPath, doctorPath, restartPath]) {
      expect(() => execFileSync("/bin/zsh", ["-n", script])).not.toThrow();
    }
  });

  it("verifies the pinned repository contract without writing installation state", () => {
    const home = temporaryHome();
    const result = runZsh(installPath, ["--verify-only"], {
      HOME: home,
      ASSISTANT_TEST_MODE: "1",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("仓库交付面校验通过");
    expect(() => statSync(join(home, "PresidentAssistant"))).toThrow();
    expect(() => statSync(join(home, "Library", "LaunchAgents"))).toThrow();
  });

  it("delivers the Feishu network doctor helper as a regular non-symlink file", () => {
    const stat = lstatSync(feishuNetworkDoctorPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
  });

  it("rejects a missing or symlinked Feishu helper before verify-only can write installation state", () => {
    for (const mode of ["missing", "symlink"] as const) {
      const root = temporaryHome();
      const localInstall = copyMinimalInstallDelivery(root);
      const helper = join(root, "scripts", "doctor-feishu-network.mjs");
      if (mode === "missing") {
        rmSync(helper);
      } else {
        rmSync(helper);
        symlinkSync(
          join(repositoryRoot, "scripts", "doctor-feishu-network.mjs"),
          helper,
        );
      }
      const result = spawnSync("/bin/zsh", [localInstall, "--verify-only"], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: join(root, "home"),
          ASSISTANT_TEST_MODE: "1",
        },
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "飞书网络 doctor helper 缺失或不是可信普通文件",
      );
      expect(existsSync(join(root, "home", "PresidentAssistant"))).toBe(false);
    }
  });

  it("does not invoke an opener for plan, verify-only, or the normal test-mode doctor path", () => {
    const root = temporaryHome();
    const fakeBin = join(root, "bin");
    const logPath = join(root, "open.log");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(
      join(fakeBin, "open"),
      `#!${process.execPath}\nimport fs from "node:fs";\nfs.appendFileSync(process.env.OPEN_CALL_LOG, "open\\n"); process.exit(99);\n`,
      { mode: 0o500 },
    );
    chmodSync(join(fakeBin, "open"), 0o500);
    for (const [script, args] of [
      [installPath, ["--plan"]],
      [installPath, ["--verify-only"]],
    ] as const) {
      const result = runZsh(script, args, {
        HOME: root,
        ASSISTANT_TEST_MODE: "1",
        PATH: `${fakeBin}:${process.env.PATH}`,
        OPEN_CALL_LOG: logPath,
      });
      expect(result.status).toBe(0);
    }
    const fakeNode = join(root, "configured-node.mjs");
    const configPath = join(root, "assistant.json");
    writeFileSync(
      fakeNode,
      `#!${process.execPath}\nif (process.argv[2] === "--version") process.stdout.write("v20.0.0\\n");\n`,
      { mode: 0o500 },
    );
    chmodSync(fakeNode, 0o500);
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
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        secretRef: {
          type: "macos-keychain",
          service: "com.codex-feishu-executive-assistant.bot",
          account: "cli_TEST123456",
        },
        paths: {
          runtimeRoot: root,
          larkHome: join(root, "lark"),
          databasePath: join(root, "missing.sqlite"),
          codexHome: join(root, "codex"),
        },
        executables: {
          node: fakeNode,
          codex: join(root, "missing-codex"),
          larkCli: join(root, "missing-lark"),
          runtimeEntry: join(root, "missing-runtime"),
        },
        visualFirstPpt: {
          skillRoot: join(root, "missing-ppt"),
          presentationsPlugin: {
            id: "presentations@openai-primary-runtime",
            version: "test",
          },
        },
      })}\n`,
      { mode: 0o600 },
    );
    chmodSync(configPath, 0o600);
    const doctorResult = runZsh(
      doctorPath,
      ["--json", "--config", configPath],
      {
        HOME: root,
        ASSISTANT_TEST_MODE: "1",
        PATH: `${fakeBin}:${process.env.PATH}`,
        OPEN_CALL_LOG: logPath,
      },
    );
    const doctorReport = JSON.parse(doctorResult.stdout) as {
      checks: Array<{ id: string }>;
    };
    expect(doctorReport.checks.some((check) => check.id === "node")).toBe(true);
    expect(existsSync(logPath)).toBe(false);
    expect(readFileSync(installPath, "utf8")).not.toContain("/usr/bin/open");
    expect(readFileSync(doctorPath, "utf8")).not.toContain("/usr/bin/open");
  });

  it("blocks apply mode before any Keychain launchctl build or directory side effect in tests", () => {
    const home = temporaryHome();
    const result = runZsh(
      installPath,
      ["--apply", "--app-id", "cli_TEST123456"],
      { HOME: home, ASSISTANT_TEST_MODE: "1" },
    );

    expect(result.status).toBe(64);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "测试模式禁止 --apply",
    );
    expect(() => statSync(join(home, "PresidentAssistant"))).toThrow();
    expect(() => statSync(join(home, "Library", "LaunchAgents"))).toThrow();
  });

  it("rejects every command-line secret option", () => {
    const result = runZsh(
      installPath,
      ["--app-secret", "must-not-be-accepted"],
      {
        HOME: temporaryHome(),
        ASSISTANT_TEST_MODE: "1",
      },
    );

    expect(result.status).toBe(64);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "秘密不能通过命令行参数传入",
    );
  });

  it("asks installers only for the App ID while keeping the App Secret in Keychain", () => {
    const result = runZsh(installPath, ["--help"], {
      HOME: temporaryHome(),
      ASSISTANT_TEST_MODE: "1",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("--app-id");
    expect(result.stdout).not.toMatch(/tenant[- ]key/i);
    expect(result.stdout).toContain("App Secret 永远不能作为参数");
  });

  it("renews an unfinished pairing without changing completed pairing state", () => {
    const installer = readFileSync(installPath, "utf8");
    const doctor = readFileSync(doctorPath, "utf8");

    expect(installer).toContain('canRenewPairing ? "renew-pairing"');
    expect(installer).toContain("尚未完成总裁配对，已安全刷新一次性配对码");
    expect(installer).toContain("不重置已完成的配对状态");
    expect(doctor).toContain("一次性配对码已过期");
    expect(doctor).toContain("./scripts/install --apply 获取新码");
  });

  it("keeps restart non-mutating unless apply is explicitly authorized", () => {
    const plan = runZsh(restartPath, ["--plan"], {
      HOME: temporaryHome(),
      ASSISTANT_TEST_MODE: "1",
    });
    expect(plan.status, `${plan.stdout}\n${plan.stderr}`).toBe(0);
    expect(plan.stdout).toContain("不修改配置、Keychain 或客户文件");

    const apply = runZsh(restartPath, ["--apply"], {
      HOME: temporaryHome(),
      ASSISTANT_TEST_MODE: "1",
    });
    expect(apply.status).toBe(64);
    expect(`${apply.stdout}\n${apply.stderr}`).toContain("没有调用 launchctl");
  });

  it("uses one RunAtLoad KeepAlive LaunchAgent for the runtime CLI", () => {
    const launchdRoot = join(repositoryRoot, "launchd");
    const templates = readdirSync(launchdRoot).filter((name) =>
      name.endsWith(".plist.template"),
    );
    expect(templates).toEqual([
      "com.codex-feishu.executive-assistant.plist.template",
    ]);

    const plist = readFileSync(join(launchdRoot, templates[0]!), "utf8");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("__RUNTIME_ENTRY__");
    expect(plist).toContain("<string>start</string>");
    expect(plist).toContain("<string>--config</string>");
    expect(plist).not.toMatch(/AppSecret|APP_SECRET|TOKEN|Token/);
  });

  it("keeps doctor read-only and limits Keychain inspection to item existence", () => {
    const doctor = readFileSync(doctorPath, "utf8");
    expect(doctor).toContain('"find-generic-password"');
    expect(doctor).not.toContain('"add-generic-password"');
    expect(doctor).not.toMatch(
      /launchctl", \["(?:bootstrap|bootout|kickstart)/,
    );

    const help = runZsh(doctorPath, ["--help"], {
      HOME: temporaryHome(),
      ASSISTANT_TEST_MODE: "1",
    });
    expect(help.status, `${help.stdout}\n${help.stderr}`).toBe(0);
    expect(help.stdout).toContain("doctor 只读取状态");
  });

  it("checks Codex login through configured Node with the production-minimal environment", () => {
    const home = temporaryHome();
    const runtimeRoot = join(home, "PresidentAssistant", "runtime");
    const codexHome = join(runtimeRoot, "codex-home");
    const larkHome = join(runtimeRoot, "lark-home");
    const configRoot = join(runtimeRoot, "config");
    const configPath = join(configRoot, "assistant.json");
    const codexFixture = join(runtimeRoot, "codex-fixture.mjs");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(larkHome, { recursive: true, mode: 0o700 });
    mkdirSync(configRoot, { recursive: true, mode: 0o700 });
    writeFileSync(
      codexFixture,
      `#!/usr/bin/env node
if (
  process.env.PATH !== "/usr/bin:/bin:/usr/sbin:/sbin" ||
  process.env.DOCTOR_AMBIENT_SENTINEL !== undefined ||
  process.env.CODEX_HOME !== ${JSON.stringify(codexHome)}
) {
  process.exit(72);
}
const args = process.argv.slice(2);
if (args.join(" ") === "login status") {
  process.stdout.write("Logged in\\n");
  process.exit(0);
}
if (args.includes("plugin")) {
  process.stdout.write(JSON.stringify({
    installed: [{
      pluginId: "presentations@openai-primary-runtime",
      marketplaceName: "openai-primary-runtime",
      marketplaceSource: { sourceType: "local" },
      version: "test",
      installed: true,
      enabled: true,
    }],
    available: [],
  }) + "\\n");
  process.exit(0);
}
process.exit(64);
`,
      { mode: 0o500 },
    );
    chmodSync(codexFixture, 0o500);
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          appId: "cli_TEST123456",
          presidentOpenId: null,
          presidentChatId: null,
          pairing: {
            enabled: true,
            codeHash: `sha256:${"a".repeat(64)}`,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          secretRef: {
            type: "macos-keychain",
            service: "com.codex-feishu-executive-assistant.bot",
            account: "cli_TEST123456",
          },
          paths: {
            runtimeRoot,
            larkHome,
            databasePath: join(runtimeRoot, "assistant.sqlite"),
            codexHome,
          },
          executables: {
            node: process.execPath,
            codex: codexFixture,
            larkCli: join(runtimeRoot, "missing-lark-cli"),
            runtimeEntry: codexFixture,
          },
          visualFirstPpt: {
            skillRoot: join(runtimeRoot, "missing-ppt"),
            presentationsPlugin: {
              id: "presentations@openai-primary-runtime",
              version: "test",
            },
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    chmodSync(configPath, 0o600);

    const result = runZsh(doctorPath, ["--json", "--config", configPath], {
      HOME: home,
      ASSISTANT_TEST_MODE: "1",
      DOCTOR_AMBIENT_SENTINEL: "must-not-reach-codex",
    });
    const report = JSON.parse(result.stdout) as {
      checks: Array<{ id: string; status: string }>;
    };

    expect(report.checks.find((check) => check.id === "codex-login")).toEqual({
      id: "codex-login",
      status: "PASS",
      detail: "专用 CODEX_HOME 已登录。",
    });
    expect(report.checks.find((check) => check.id === "presentations")).toEqual(
      {
        id: "presentations",
        status: "PASS",
        detail: "专用 CODEX_HOME 已启用官方 Presentations test。",
      },
    );
  });

  it("stores only a Keychain reference in the config template", () => {
    const config = JSON.parse(
      readFileSync(
        join(repositoryRoot, "config", "assistant.example.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const serialized = JSON.stringify(config);

    expect(config.schemaVersion).toBe(1);
    expect(config.tenantKey).toBeUndefined();
    expect(config.presidentOpenId).toBeNull();
    expect(config.presidentChatId).toBeNull();
    expect(serialized).toContain("macos-keychain");
    expect(serialized).toContain('"larkHome":"__LARK_HOME__"');
    expect(serialized).toContain('"databasePath":"__DATABASE_PATH__"');
    expect(serialized).not.toMatch(
      /"(?:appSecret|app_secret|secretValue|accessToken|refreshToken|token)"\s*:/,
    );
    expect(serialized).toContain('"larkCli":"__LARK_CLI_EXECUTABLE__"');
    expect(serialized).toContain('"id":"presentations@openai-primary-runtime"');
    expect(serialized).toContain(
      '"version":"__PRESENTATIONS_PLUGIN_VERSION__"',
    );
    expect(serialized).not.toContain("transportModule");
  });

  it("ships and locks the project and visual-first-ppt MIT licenses", () => {
    const rootLicense = readFileSync(join(repositoryRoot, "LICENSE"), "utf8");
    const pptLicense = readFileSync(
      join(repositoryRoot, "LICENSES", "visual-first-ppt-MIT.txt"),
      "utf8",
    );
    const lock = JSON.parse(
      readFileSync(join(repositoryRoot, "dependencies.lock.json"), "utf8"),
    ) as {
      visualFirstPpt?: {
        license?: string;
        licenseSha256?: string;
        skillPath?: string;
        skillTreeSha?: string;
      };
    };
    const packageManifest = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ) as { license?: string };

    expect(rootLicense).toContain("MIT License");
    expect(packageManifest.license).toBe("MIT");
    for (const packageName of [
      "action-gateway",
      "bridge",
      "contracts",
      "job-store",
      "runtime",
    ]) {
      const workspaceManifest = JSON.parse(
        readFileSync(
          join(repositoryRoot, "packages", packageName, "package.json"),
          "utf8",
        ),
      ) as { license?: string };
      expect(workspaceManifest.license, packageName).toBe("MIT");
    }
    expect(pptLicense).toContain("MIT License");
    expect(lock.visualFirstPpt).toMatchObject({
      license: "MIT",
      licenseSha256: createHash("sha256").update(pptLicense).digest("hex"),
      skillPath: "skills/visual-first-ppt",
      skillTreeSha: "b2fc38bcd1c1d36f18f47543aa63abd1c7e13eba",
    });
  });

  it("installs the pinned visual-first-ppt skill subtree and only recoverably migrates the legacy whole-repository layout", () => {
    const installer = readFileSync(installPath, "utf8");
    const doctor = readFileSync(doctorPath, "utf8");

    expect(installer).toContain(
      'rev-parse "${ppt_contract[2]}:${ppt_contract[6]}"',
    );
    expect(installer).toContain(
      'archive "${ppt_contract[2]}" -- "${ppt_contract[6]}"',
    );
    expect(installer).toContain("--strip-components 2");
    expect(installer).toContain(
      '"${ppt_skill_root}/skills/visual-first-ppt/SKILL.md"',
    );
    expect(installer).toContain("visual-first-ppt-legacy.");
    expect(installer).toContain("不会直接删除");
    expect(installer).toContain("visual-first-ppt-failed-migration");
    expect(installer).toContain("ppt_install_receipt_shape");
    expect(installer).not.toContain('/bin/rm -rf "${ppt_skill_root}"');
    expect(doctor).toContain("schemaVersion: 2");
    expect(doctor).toContain('skillPath: "skills/visual-first-ppt"');
    expect(doctor).toContain(
      'skillTreeSha: "b2fc38bcd1c1d36f18f47543aa63abd1c7e13eba"',
    );
  });

  it("delegates PPT production and forbids raw Feishu execution in the assistant skill", () => {
    const skill = readFileSync(
      join(repositoryRoot, "skills", "executive-assistant", "SKILL.md"),
      "utf8",
    );

    for (const phrase of [
      "$visual-first-ppt",
      "外部写操作",
      "中文预览",
      "确认卡片",
      "不得直接调用 raw `lark-cli`",
      "Presentations",
      "imagegen",
      "BLOCKED_CAPABILITY",
      '"$ASSISTANT_GATEWAY_CLIENT" < gateway-request.json',
      '"capability": "minutes.search"',
      '"capability": "minutes.detail"',
      '"capability": "contact.search"',
      '"capability": "message.send"',
      '"capability": "calendar.create"',
      "result.state",
      "PREPARED",
    ]) {
      expect(skill).toContain(phrase);
    }
  });

  it("prompts Keychain itself instead of passing an App Secret argument", () => {
    const installer = readFileSync(installPath, "utf8");
    expect(installer).toMatch(
      /security add-generic-password[\s\S]*?-a "\$\{app_id\}"[\s\S]*?-s "\$\{KEYCHAIN_SERVICE\}"[\s\S]*?-w\n/,
    );
    expect(installer).not.toMatch(/(?:APP_SECRET|app_secret|secret_value)=/);
    expect(installer).not.toContain('security add-generic-password -w "');
    expect(installer).toMatch(
      /security find-generic-password[\s\S]*?-w[\s\S]*?\|\n\s+HOME="\$\{lark_home\}" "\$\{lark_cli_executable\}"/,
    );
    expect(installer).toContain("--app-secret-stdin");
  });

  it("installs the locked lark-cli in a private path that is absent from Codex PATH", () => {
    const installer = readFileSync(installPath, "utf8");
    const plist = readFileSync(
      join(
        repositoryRoot,
        "launchd",
        "com.codex-feishu.executive-assistant.plist.template",
      ),
      "utf8",
    );

    expect(installer).toContain('lark_cli_version="${dependency_contract[1]}"');
    expect(installer).toContain(
      'lark_cli_install_root="${runtime_root}/lark-cli-${lark_cli_version}"',
    );
    expect(installer).toContain(
      'lark_cli_executable="${lark_cli_private_bin}/lark-cli"',
    );
    expect(installer).toContain(
      'lark_cli_receipt="${lark_cli_install_root}/install-receipt.json"',
    );
    expect(installer).toContain("lark_archive_sha");
    expect(installer).toContain("verify_lark_cli_install");
    expect(plist).not.toContain("private-bin");
    expect(plist).not.toContain("lark-cli");
  });

  it("discovers and installs Presentations through the official Codex marketplace", () => {
    const installer = readFileSync(installPath, "utf8");
    const installSupport = readFileSync(installSupportPath, "utf8");
    const doctor = readFileSync(doctorPath, "utf8");

    expect(installSupport).toContain(
      'const PRESENTATIONS_PLUGIN_ID = "presentations@openai-primary-runtime"',
    );
    expect(installer).toContain("plugin marketplace list --json");
    expect(installer).toContain("plugin marketplace add");
    expect(installer).toContain("ensure-presentations");
    expect(installSupport).toContain('"add",');
    expect(installSupport).toContain("PRESENTATIONS_PLUGIN_ID");
    expect(installer).not.toMatch(/\/Users\/[^/]+\/\.codex\/plugins\/cache/);
    expect(doctor).toContain(
      'const PRESENTATIONS_PLUGIN_ID = "presentations@openai-primary-runtime"',
    );
    expect(doctor).toContain("真实 PPT 保持 BLOCKED_CAPABILITY");
  });

  it("renders launchd without assigning the readonly repository root", () => {
    const installer = readFileSync(installPath, "utf8");

    expect(installer).toContain('"${INSTALL_SUPPORT}" render-launchd');
    expect(installer).not.toContain('REPOSITORY_ROOT="${REPOSITORY_ROOT}"');
  });

  it("configures and verifies the dedicated Feishu user authorization", () => {
    const installer = readFileSync(installPath, "utf8");
    const doctor = readFileSync(doctorPath, "utf8");
    const requiredUserScopes = [
      "calendar:calendar.event:create",
      "calendar:calendar.event:update",
      "contact:user:search",
      "minutes:minutes.search:read",
      "minutes:minutes.basic:read",
      "minutes:minutes.artifacts:read",
    ];

    expect(installer).toContain(
      'readonly lark_home="${runtime_root}/lark-home"',
    );
    expect(installer).toContain('readonly lark_profile="executive-assistant"');
    expect(installer).toContain("config strict-mode off");
    for (const scope of requiredUserScopes) {
      expect(installer).toContain(scope);
      expect(doctor).toContain(scope);
    }
    expect(installer).not.toContain("auth login --domain");
    expect(installer).toContain("auth scopes --json");
    expect(installer).toContain("auth status --json --verify");
    expect(installer).toContain("auth check --scope");
    expect(installer).toContain('result?.identity !== "user"');
    expect(installer).toContain("result?.verified !== true");
    expect(installer).toContain("result?.identities?.user?.verified !== true");
    expect(installer).toContain(
      "result?.missing == null ? [] : result.missing",
    );
    expect(installer).toContain('if [[ -n "${missing_app_scope_output}" ]]');
    expect(installer).toContain('if [[ -n "${missing_user_scope_output}" ]]');
    expect(installer).toContain("auth login --scope");
    expect(doctor).toMatch(/"auth",\s*"status",\s*"--json",\s*"--verify"/);
    expect(doctor).toMatch(/"auth",\s*"check",\s*"--scope"/);
    expect(doctor).toMatch(/"auth",\s*"scopes",\s*"--json"/);
    expect(doctor).toContain("report?.missing == null ? [] : report.missing");
  });
});
