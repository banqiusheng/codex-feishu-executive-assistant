import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execPath, platform } from "node:process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OAuthStorageAuditor,
  createBotSecretRefBundle,
} from "../../src/keychain.js";
import type { AppConfig } from "../../../bridge/src/config/schema.js";
import { analyzeImportGraph } from "../../../../tests/security/import-graph.js";

const roots: string[] = [];
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

function sentinel(label: string): string {
  return `${label}_${randomBytes(24).toString("hex")}`;
}

function encodedForms(value: string): string[] {
  return [
    value,
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value),
    Buffer.from(value, "utf8").toString("base64"),
    Buffer.from(value, "utf8").toString("hex"),
  ];
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("offline no-secret-leak gate", () => {
  it("does not copy poisoned credentials into config, evidence, errors, argv, env, or logs", async () => {
    const appSecret = sentinel("APP_SECRET");
    const accessToken = sentinel("ACCESS_TOKEN");
    const refreshToken = sentinel("REFRESH_TOKEN");
    const masterKey = sentinel("MASTER_KEY");
    const proxyCredential = sentinel("PROXY_PASSWORD");
    const sentinels = [
      appSecret,
      accessToken,
      refreshToken,
      masterKey,
      proxyCredential,
    ];

    vi.stubEnv("FEISHU_APP_SECRET", appSecret);
    vi.stubEnv("LARK_ACCESS_TOKEN", accessToken);
    vi.stubEnv("LARK_REFRESH_TOKEN", refreshToken);
    vi.stubEnv("LARK_MASTER_KEY", masterKey);
    vi.stubEnv(
      "HTTPS_PROXY",
      `https://assistant:${proxyCredential}@proxy.invalid`,
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const createdStoreDirectory = await mkdtemp(
      join(tmpdir(), "assistant-secret-scan-"),
    );
    roots.push(createdStoreDirectory);
    await chmod(createdStoreDirectory, 0o700);
    const storeDirectory = await realpath(createdStoreDirectory);
    await writeFile(join(storeDirectory, "credentials.enc"), randomBytes(128), {
      mode: 0o600,
    });
    await chmod(join(storeDirectory, "credentials.enc"), 0o600);

    const bundle = createBotSecretRefBundle({
      appId: "cli_0123456789abcdef",
    });
    const evidence = await new OAuthStorageAuditor({
      fixtureClass: "synthetic",
      storeDirectory,
    }).inspectKeychainBackedEncryptedStore();
    expect(evidence).toMatchObject({
      status: "UNVERIFIED_NO_FIXTURE",
      reasonCode: "REAL_CANARY_REQUIRED",
      localChecksPassed: true,
      realCanaryVerified: false,
    });
    let rejected = "";
    try {
      createBotSecretRefBundle({
        appId: appSecret,
      });
    } catch (caught) {
      rejected = caught instanceof Error ? caught.message : String(caught);
    }

    const capturedArgv: readonly string[] =
      bundle.secrets.providers["executive-assistant-keychain"].args;
    const capturedLogs = [...log.mock.calls, ...error.mock.calls];
    const publicSurface = JSON.stringify({
      bundle,
      evidence,
      rejected,
      capturedArgv,
      capturedLogs,
    });
    const directoryEntries = await readdir(storeDirectory);
    const storedCiphertext = await readFile(
      join(storeDirectory, "credentials.enc"),
    );

    expect(rejected).toBe("BOT_SECRET_REF_INPUT_INVALID");
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(directoryEntries).toEqual(["credentials.enc"]);
    for (const secret of sentinels) {
      for (const form of encodedForms(secret)) {
        expect(publicSurface).not.toContain(form);
        expect(storedCiphertext.includes(Buffer.from(form, "utf8"))).toBe(
          false,
        );
      }
    }
  });

  it("checks child inputs and logs on the real bridge success-protocol path", async () => {
    // Task 6 exercises only the successful exec-provider protocol. Generic
    // bridge rejection/raw-stderr sanitization and production provider/config
    // lock-down remain Task 9. Task 6's failure-channel guarantee instead
    // depends on the native helper's separate gate requiring empty stderr for
    // every failure.
    const secretResolverModulePath = [
      "../../../bridge/src/config",
      "secret-resolver.js",
    ].join("/");
    const { resolveAppSecret } = (await vi.importActual(
      secretResolverModulePath,
    )) as {
      resolveAppSecret(config: AppConfig): Promise<string>;
    };
    const secret = sentinel("BRIDGE_EXEC_SECRET");
    vi.stubEnv("BRIDGE_EXEC_SECRET_POISON", secret);
    const root = await mkdtemp(join(tmpdir(), "assistant-bridge-exec-"));
    roots.push(root);
    await chmod(root, 0o700);
    const scriptPath = join(root, "fake-keychain-provider.cjs");
    const secretPath = join(root, "secret.fixture");
    const observationPath = join(root, "observation.json");
    const script = [
      `#!${execPath}`,
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const request = JSON.parse(input);",
      "  const root = __dirname;",
      "  const secret = fs.readFileSync(path.join(root, 'secret.fixture'), 'utf8');",
      "  fs.writeFileSync(path.join(root, 'observation.json'), JSON.stringify({",
      "    argv: process.argv.slice(2),",
      "    env: process.env,",
      "    stdin: input,",
      "  }), { mode: 0o600 });",
      "  process.stdout.write(JSON.stringify({",
      "    protocolVersion: 1,",
      "    values: { [request.ids[0]]: secret },",
      "    errors: {},",
      "  }));",
      "});",
      "",
    ].join("\n");
    await writeFile(scriptPath, script, { mode: 0o500 });
    await chmod(scriptPath, 0o500);
    await writeFile(secretPath, secret, { mode: 0o600 });
    await chmod(secretPath, 0o600);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const config: AppConfig = {
      accounts: {
        app: {
          id: "cli_0123456789abcdef",
          tenant: "feishu",
          secret: {
            source: "exec",
            provider: "synthetic-test-provider",
            id: "app-cli_0123456789abcdef",
          },
        },
      },
      secrets: {
        providers: {
          "synthetic-test-provider": {
            source: "exec",
            command: scriptPath,
            args: [],
            passEnv: [],
            noOutputTimeoutMs: 5_000,
            maxOutputBytes: 4_096,
          },
        },
      },
      preferences: {},
    };

    await expect(resolveAppSecret(config)).resolves.toBe(secret);
    const observation = JSON.parse(await readFile(observationPath, "utf8")) as {
      argv: unknown;
      env: unknown;
      stdin: unknown;
    };
    const observedSurface = JSON.stringify({
      observation,
      logs: log.mock.calls,
    });
    const source = await readFile(scriptPath, "utf8");

    expect(observation.argv).toEqual([]);
    expect(observation.env).toEqual(
      platform === "darwin"
        ? { __CF_USER_TEXT_ENCODING: expect.any(String) }
        : {},
    );
    expect(observation.stdin).toBe(
      '{"protocolVersion":1,"provider":"synthetic-test-provider","ids":["app-cli_0123456789abcdef"]}',
    );
    expect(log).not.toHaveBeenCalled();
    for (const form of encodedForms(secret)) {
      expect(observedSurface).not.toContain(form);
      expect(source).not.toContain(form);
    }
  });

  it("keeps the storage module out of the public/Codex surface and free of process execution", async () => {
    const graph = analyzeImportGraph({
      repositoryRoot,
      roots: [
        "packages/action-gateway/src/index.ts",
        "packages/bridge/src/agent/codex-runner.ts",
      ],
    });
    const publicIndex = await readFile(
      resolve(repositoryRoot, "packages/action-gateway/src/index.ts"),
      "utf8",
    );
    const source = await readFile(
      resolve(repositoryRoot, "packages/action-gateway/src/keychain.ts"),
      "utf8",
    );

    expect(graph.reachableFiles).not.toContain(
      "packages/action-gateway/src/keychain.ts",
    );
    expect(graph.reachableFiles).not.toContain(
      "packages/action-gateway/src/lark-cli-runner.ts",
    );
    expect(graph.unresolvedRelativeImports).toEqual([]);
    expect(graph.nonLiteralModuleReferences).toEqual([]);
    expect(graph.parseDiagnostics).toEqual([]);
    expect(
      graph.capabilityViolations.filter(({ file }) =>
        [
          "packages/action-gateway/src/keychain.ts",
          "packages/action-gateway/src/lark-cli-runner.ts",
        ].includes(file),
      ),
    ).toEqual([]);
    expect(publicIndex).not.toMatch(/keychain|OAuthStorageAuditor/u);
    expect(source).not.toMatch(
      /node:child_process|process\.env|console\.|execFile|spawn\s*\(/u,
    );
  });
});
