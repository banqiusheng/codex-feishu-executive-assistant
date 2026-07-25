import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseExactProbeReport,
  probeFeishuDns,
  probeFeishuHttpsRest,
  requestFeishuHttpsStatus,
  runConfiguredFeishuProbes,
  sanitizeProbeEnvironment,
} from "../../scripts/doctor-feishu-network.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const doctorPath = join(repositoryRoot, "scripts", "doctor");
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ea-feishu-doctor-test-"));
  temporaryRoots.push(root);
  return root;
}

function writeDoctorConfig(root: string, configuredNode: string): string {
  const configPath = join(root, "assistant.json");
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
        databasePath: join(root, "assistant.sqlite"),
        codexHome: join(root, "codex"),
      },
      executables: {
        node: configuredNode,
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
  return configPath;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("credential-free Feishu network probes", () => {
  it("uses only the fixed DNS name and never returns resolved addresses", async () => {
    const observed: unknown[] = [];
    const result = await probeFeishuDns({
      lookup: async (...args: unknown[]) => {
        observed.push(args);
        return [{ address: "opaque-address-sentinel", family: 4 }];
      },
    });

    expect(result).toBe("PASS");
    expect(observed).toEqual([
      ["open.feishu.cn", { all: true, verbatim: true }],
    ]);
    expect(JSON.stringify(result)).not.toContain("opaque-address-sentinel");
  });

  it("uses the fixed HTTPS HEAD probe and accepts every HTTP status", async () => {
    const observed: unknown[] = [];
    for (const statusCode of [100, 204, 404, 599]) {
      await expect(
        probeFeishuHttpsRest({
          requestHead: async (...args: unknown[]) => {
            observed.push(args);
            return statusCode;
          },
        }),
      ).resolves.toBe("PASS");
    }

    expect(observed).toEqual([
      ["https://open.feishu.cn/open-apis/"],
      ["https://open.feishu.cn/open-apis/"],
      ["https://open.feishu.cn/open-apis/"],
      ["https://open.feishu.cn/open-apis/"],
    ]);
  });

  it("accepts 1xx production HTTPS events exactly once and safely closes upgrade sockets", async () => {
    for (const statusCode of [100, 101, 199, 204, 599]) {
      const request = new EventEmitter() as EventEmitter & {
        destroy: () => void;
        end: () => void;
        setTimeout: (_milliseconds: number, callback: () => void) => void;
      };
      const socket = { destroy: () => undefined };
      let responseCallback:
        | ((response: { statusCode?: number; resume: () => void }) => void)
        | undefined;
      let settled = 0;
      request.destroy = () => undefined;
      request.setTimeout = () => undefined;
      request.end = () => {
        if (statusCode === 101) {
          request.emit(
            "upgrade",
            { statusCode, resume: () => undefined },
            socket,
            Buffer.alloc(0),
          );
        } else if (statusCode < 200) {
          request.emit("information", { statusCode, resume: () => undefined });
        } else {
          responseCallback?.({ statusCode, resume: () => undefined });
        }
        request.emit("error", new Error("must-not-change-settlement"));
        request.emit("information", {
          statusCode: 199,
          resume: () => undefined,
        });
      };
      await expect(
        requestFeishuHttpsStatus({
          request: (_endpoint, _options, callback) => {
            responseCallback = callback;
            return request;
          },
          onSettled: () => {
            settled += 1;
          },
        }),
      ).resolves.toBe(statusCode);
      expect(settled).toBe(1);
    }
  });

  it("classifies empty DNS, HTTP errors, and malformed injections without exposing raw failures", async () => {
    await expect(probeFeishuDns({ lookup: async () => [] })).resolves.toBe(
      "DNS_UNAVAILABLE",
    );
    await expect(
      probeFeishuDns({
        lookup: async () => {
          throw new Error("private lookup failure");
        },
      }),
    ).resolves.toBe("DNS_UNAVAILABLE");
    await expect(
      probeFeishuHttpsRest({ requestHead: async () => 0 }),
    ).resolves.toBe("REST_UNREACHABLE");
    await expect(
      probeFeishuHttpsRest({
        requestHead: async () => {
          throw new Error("proxy failure");
        },
      }),
    ).resolves.toBe("REST_UNREACHABLE");
    await expect(runConfiguredFeishuProbes(new Proxy({}, {}))).resolves.toEqual(
      {
        schemaVersion: 1,
        dns: "DNS_UNAVAILABLE",
        httpsRest: "REST_UNREACHABLE",
      },
    );
  });

  it("returns from a valid report at the EOF boundary", () => {
    expect(
      parseExactProbeReport(
        Buffer.from(
          '{"schemaVersion":1,"dns":"PASS","httpsRest":"PASS"}',
          "utf8",
        ),
      ),
    ).toEqual({ schemaVersion: 1, dns: "PASS", httpsRest: "PASS" });
  });

  it("sanitizes only an own mutable environment record to the exact three-key child environment", () => {
    const environment: Record<string, string> = {
      PATH: "ambient",
      LANG: "ambient",
      LC_ALL: "ambient",
      HOME: "must-not-remain",
      HTTP_PROXY: "must-not-remain",
      NODE_OPTIONS: "must-not-remain",
      DOCTOR_SENTINEL: "must-not-remain",
    };
    expect(sanitizeProbeEnvironment(environment)).toBe(true);
    expect(environment).toEqual({
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C",
      LC_ALL: "C",
    });
    expect(sanitizeProbeEnvironment(new Proxy({}, {}))).toBe(false);
  });

  it("accepts only the exact own-data report schema with strict UTF-8 and duplicate-key rejection", () => {
    for (const input of [
      '{"schemaVersion":1,"dns":"PASS","httpsRest":"PASS","raw":"no"}',
      '{"schemaVersion":1,"dns":"PASS","dns":"DNS_UNAVAILABLE","httpsRest":"PASS"}',
      Buffer.from(
        '{"schemaVersion":1,"dns":"REST_UNREACHABLE","httpsRest":"DNS_UNAVAILABLE"}',
        "utf8",
      ),
      '{"schemaVersion":1,"dns":"PASS","httpsRest":"PASS"} trailing',
      Buffer.from([0xff, 0xfe]),
    ]) {
      expect(() => parseExactProbeReport(input)).toThrow();
    }

    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "schemaVersion", {
      enumerable: true,
      get: () => 1,
    });
    Object.defineProperty(accessor, "dns", { enumerable: true, value: "PASS" });
    Object.defineProperty(accessor, "httpsRest", {
      enumerable: true,
      value: "PASS",
    });
    expect(() => parseExactProbeReport(accessor)).toThrow();
    expect(() =>
      parseExactProbeReport(
        new Proxy({ schemaVersion: 1, dns: "PASS", httpsRest: "PASS" }, {}),
      ),
    ).toThrow();
  });

  it("runs the helper with the configured absolute Node and an exact sterile child environment", () => {
    const root = temporaryRoot();
    const observationPath = join(root, "environment.json");
    const fakeNode = join(root, "configured-node.mjs");
    const configPath = join(root, "assistant.json");
    writeFileSync(
      fakeNode,
      `#!${process.execPath}\nimport fs from "node:fs";\nconst args = process.argv.slice(2);\nif (args[0] === "--version") { process.stdout.write("v20.0.0\\n"); process.exit(0); }\nif (args[0]?.endsWith("doctor-feishu-network.mjs")) { const helper = await import(args[0]); if (!helper.sanitizeProbeEnvironment(process.env)) process.exit(71); fs.writeFileSync(${JSON.stringify(observationPath)}, JSON.stringify(process.env)); process.stdout.write('{"schemaVersion":1,"dns":"PASS","httpsRest":"PASS"}\\n'); process.exit(0); }\nprocess.exit(0);\n`,
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
          databasePath: join(root, "assistant.sqlite"),
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

    const result = spawnSync(
      "/bin/zsh",
      [doctorPath, "--json", "--config", configPath],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          HTTP_PROXY: "must-not-reach-child",
          HTTPS_PROXY: "must-not-reach-child",
          NODE_OPTIONS: "--no-warnings",
          DOCTOR_SENTINEL: "must-not-reach-child",
        },
      },
    );
    const report = JSON.parse(result.stdout) as {
      checks: Array<{ id: string; status: string; detail: string }>;
    };
    expect(report.checks.find((check) => check.id === "feishu-dns")).toEqual({
      id: "feishu-dns",
      status: "PASS",
      detail: "飞书 DNS 可达。",
    });
    expect(
      report.checks.find((check) => check.id === "feishu-https-rest"),
    ).toEqual({
      id: "feishu-https-rest",
      status: "PASS",
      detail: "飞书 HTTPS/REST 可达。",
    });
    expect(JSON.parse(readFileSync(observationPath, "utf8"))).toEqual({
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C",
      LC_ALL: "C",
    });
  });

  it("hard-kills a configured child that ignores SIGTERM within the five-second boundary", () => {
    const root = temporaryRoot();
    const fakeNode = join(root, "configured-node.mjs");
    writeFileSync(
      fakeNode,
      `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args[0] === "--version") { process.stdout.write("v20.0.0\\n"); process.exit(0); }\nprocess.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n`,
      { mode: 0o500 },
    );
    chmodSync(fakeNode, 0o500);
    const startedAt = Date.now();
    const result = spawnSync(
      "/bin/zsh",
      [doctorPath, "--json", "--config", writeDoctorConfig(root, fakeNode)],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    );
    const elapsedMilliseconds = Date.now() - startedAt;
    const report = JSON.parse(result.stdout) as {
      checks: Array<{ id: string; status: string; detail: string }>;
    };
    expect(elapsedMilliseconds).toBeLessThan(6_500);
    expect(report.checks.find((check) => check.id === "feishu-dns")).toEqual({
      id: "feishu-dns",
      status: "FAIL",
      detail: "飞书 DNS 不可达。",
    });
    expect(
      report.checks.find((check) => check.id === "feishu-https-rest"),
    ).toEqual({
      id: "feishu-https-rest",
      status: "FAIL",
      detail: "飞书 HTTPS/REST 不可达。",
    });
  });

  it("fails closed for every configured-child process and strict-output boundary", () => {
    const scenarios = [
      ["nonzero", 'process.stderr.write("opaque-sentinel"); process.exit(73);'],
      [
        "stderr",
        `process.stderr.write("opaque-sentinel"); process.stdout.write('{"schemaVersion":1,"dns":"PASS","httpsRest":"PASS"}\\n');`,
      ],
      ["oversize", 'process.stdout.write("x".repeat(4097));'],
      ["malformed", 'process.stdout.write("not-json");'],
      ["invalid-utf8", "process.stdout.write(Buffer.from([255]));"],
      [
        "duplicate",
        `process.stdout.write('{"schemaVersion":1,"dns":"PASS","dns":"DNS_UNAVAILABLE","httpsRest":"PASS"}');`,
      ],
      [
        "extra",
        `process.stdout.write('{"schemaVersion":1,"dns":"PASS","httpsRest":"PASS","extra":"opaque-sentinel"}');`,
      ],
      [
        "unknown",
        `process.stdout.write('{"schemaVersion":1,"dns":"UNKNOWN","httpsRest":"PASS"}');`,
      ],
      [
        "wrong-field",
        `process.stdout.write('{"schemaVersion":1,"dns":"REST_UNREACHABLE","httpsRest":"DNS_UNAVAILABLE"}');`,
      ],
    ] as const;
    for (const [, behavior] of scenarios) {
      const root = temporaryRoot();
      const fakeNode = join(root, "configured-node.mjs");
      writeFileSync(
        fakeNode,
        `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args[0] === "--version") { process.stdout.write("v20.0.0\\n"); process.exit(0); }\n${behavior}\n`,
        { mode: 0o500 },
      );
      chmodSync(fakeNode, 0o500);
      const result = spawnSync(
        "/bin/zsh",
        [doctorPath, "--json", "--config", writeDoctorConfig(root, fakeNode)],
        { cwd: repositoryRoot, encoding: "utf8" },
      );
      expect(result.stdout).not.toContain("opaque-sentinel");
      expect(result.stderr).not.toContain("opaque-sentinel");
      const report = JSON.parse(result.stdout) as {
        checks: Array<{ id: string; status: string; detail: string }>;
      };
      expect(report.checks.find((check) => check.id === "feishu-dns")).toEqual({
        id: "feishu-dns",
        status: "FAIL",
        detail: "飞书 DNS 不可达。",
      });
      expect(
        report.checks.find((check) => check.id === "feishu-https-rest"),
      ).toEqual({
        id: "feishu-https-rest",
        status: "FAIL",
        detail: "飞书 HTTPS/REST 不可达。",
      });
    }
  });
});
