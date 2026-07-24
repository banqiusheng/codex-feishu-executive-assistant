import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const installPath = join(repositoryRoot, "scripts/install");
const doctorPath = join(repositoryRoot, "scripts/doctor");
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
    });
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
    const doctor = readFileSync(doctorPath, "utf8");

    expect(installer).toContain(
      'pluginId === "presentations@openai-primary-runtime"',
    );
    expect(installer).toContain("plugin marketplace add");
    expect(installer).toContain("presentations@openai-primary-runtime --json");
    expect(installer).toContain('CODEX_HOME="${codex_home}"');
    expect(installer).not.toMatch(/\/Users\/[^/]+\/\.codex\/plugins\/cache/);
    expect(doctor).toContain(
      'const PRESENTATIONS_PLUGIN_ID = "presentations@openai-primary-runtime"',
    );
    expect(doctor).toContain("真实 PPT 保持 BLOCKED_CAPABILITY");
  });

  it("configures and verifies the dedicated Feishu user authorization", () => {
    const installer = readFileSync(installPath, "utf8");
    const doctor = readFileSync(doctorPath, "utf8");

    expect(installer).toContain(
      'readonly lark_home="${runtime_root}/lark-home"',
    );
    expect(installer).toContain('readonly lark_profile="executive-assistant"');
    expect(installer).toContain("config strict-mode off");
    expect(installer).toContain("auth login --domain calendar,contact,minutes");
    expect(installer).toContain("auth status --json --verify");
    expect(installer).toContain("if (result?.ok !== true) process.exit(2)");
    expect(doctor).toContain(
      '["--profile", "executive-assistant", "auth", "status", "--json"]',
    );
    expect(doctor).not.toContain(
      '["--profile", "executive-assistant", "auth", "status", "--json", "--verify"]',
    );
  });
});
