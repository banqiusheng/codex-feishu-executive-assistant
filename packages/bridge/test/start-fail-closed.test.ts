import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ASSISTANT_RUNTIME_PORTS_REQUIRED,
  runStart,
} from "../src/cli/commands/start.js";

const bridgeRoot = resolve(import.meta.dirname, "..");
const cliEntry = resolve(bridgeRoot, "src/cli/index.ts");
const packageEntry = resolve(bridgeRoot, "src/index.ts");
const repositoryRoot = resolve(bridgeRoot, "../..");
const contractsBuild = "pnpm --filter @executive-assistant/contracts build";

function sourceImportGraph(entry: string): string[] {
  const visited = new Set<string>();
  const visit = (path: string): void => {
    if (visited.has(path)) return;
    visited.add(path);
    if (!path.endsWith(".ts")) return;
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(
      /(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g,
    )) {
      const specifier = match[1];
      if (specifier === undefined || !specifier.startsWith(".")) continue;
      const unresolved = resolve(dirname(path), specifier);
      const candidates = [
        unresolved,
        unresolved.replace(/\.js$/, ".ts"),
        `${unresolved}.ts`,
        `${unresolved}.json`,
      ];
      const resolved = candidates.find((candidate) => existsSync(candidate));
      if (resolved !== undefined) visit(resolved);
    }
  };
  visit(entry);
  return [...visited]
    .map((path) => relative(bridgeRoot, path))
    .sort((left, right) => left.localeCompare(right));
}

const FORBIDDEN_SUPPORTED_ENTRY_TEXT = [
  "CodexAdapter",
  "runServiceStart",
  "runSecrets",
  "lark-cli",
  "keystore",
  "src/agent/",
  "src/config/",
  "src/daemon/",
  "src/runtime/lark-cli-shim",
  "src/card/dispatcher",
  "src/card/run-renderer",
] as const;

function copyWorkspaceFile(tempRoot: string, relativePath: string): void {
  const destination = resolve(tempRoot, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(resolve(repositoryRoot, relativePath), destination, {
    dereference: false,
  });
}

function copyWorkspacePackage(tempRoot: string, packageName: string): void {
  const source = resolve(repositoryRoot, "packages", packageName);
  const destination = resolve(tempRoot, "packages", packageName);
  const excluded = new Set([
    resolve(source, "dist"),
    resolve(source, "node_modules"),
  ]);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    dereference: false,
    filter: (path) => !excluded.has(resolve(path)),
  });
}

function createIsolatedBuildWorkspace(): Readonly<{
  root: string;
  bridgeRoot: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "assistant-bridge-build-"));
  try {
    for (const relativePath of [
      ".npmrc",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.base.json",
    ]) {
      copyWorkspaceFile(root, relativePath);
    }
    copyWorkspacePackage(root, "bridge");
    copyWorkspacePackage(root, "contracts");
    symlinkSync(
      resolve(repositoryRoot, "node_modules"),
      resolve(root, "node_modules"),
      "dir",
    );
    for (const packageName of ["bridge", "contracts"]) {
      symlinkSync(
        resolve(repositoryRoot, "packages", packageName, "node_modules"),
        resolve(root, "packages", packageName, "node_modules"),
        "dir",
      );
    }
    return Object.freeze({
      root,
      bridgeRoot: resolve(root, "packages", "bridge"),
    });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

describe("CLI run entry", () => {
  it("is a fixed fail-closed stub with no legacy static imports", () => {
    const source = readFileSync(
      new URL("../src/cli/commands/start.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/^import\s/m);
    expect(source).toContain("ASSISTANT_RUNTIME_PORTS_REQUIRED");
    for (const forbidden of [
      "CodexAdapter",
      "startChannel",
      "loadConfig",
      "resolveAppSecret",
      "SessionStore",
      "WorkspaceStore",
      "gcMediaCache",
      "register(",
      "runRegistrationWizard",
      "setDefaultResultOrder",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("rejects before any runtime port or legacy CLI path can be used", async () => {
    await expect(
      runStart({ config: "must-not-be-read", skipCheckLarkCli: true }),
    ).rejects.toThrow(ASSISTANT_RUNTIME_PORTS_REQUIRED);
  });

  it("keeps the actual CLI source import graph limited to the fail-closed start stub", () => {
    expect(sourceImportGraph(cliEntry)).toEqual([
      "package.json",
      "src/cli/commands/start.ts",
      "src/cli/index.ts",
    ]);

    const graphText = sourceImportGraph(cliEntry)
      .map((path) => readFileSync(resolve(bridgeRoot, path), "utf8"))
      .join("\n");
    for (const forbidden of FORBIDDEN_SUPPORTED_ENTRY_TEXT) {
      expect(graphText).not.toContain(forbidden);
    }
  });

  it("makes the actual package root expose only the new supported safety seams", () => {
    expect(sourceImportGraph(packageEntry)).toEqual([
      "src/bot/channel.ts",
      "src/index.ts",
      "src/runtime/assistant-channel.ts",
      "src/runtime/progress-reporter.ts",
      "src/runtime/system-reply.ts",
      "src/security/ingress-guard.ts",
      "src/security/policy.ts",
    ]);

    const graphText = sourceImportGraph(packageEntry)
      .map((path) => readFileSync(resolve(bridgeRoot, path), "utf8"))
      .join("\n");
    for (const forbidden of FORBIDDEN_SUPPORTED_ENTRY_TEXT) {
      expect(graphText).not.toContain(forbidden);
    }
  });

  it("builds contracts before every root and standalone bridge quality command", () => {
    for (const packagePath of [
      resolve(repositoryRoot, "package.json"),
      resolve(bridgeRoot, "package.json"),
    ]) {
      const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
        scripts?: Record<string, unknown>;
      };
      expect(packageJson.scripts).toMatchObject({
        prebuild: contractsBuild,
        pretest: contractsBuild,
        pretypecheck: contractsBuild,
      });
    }
  });

  it("builds narrow actual package and CLI bundles before safely executing both bin commands", async () => {
    const isolated = createIsolatedBuildWorkspace();
    try {
      const cliBundle = resolve(isolated.bridgeRoot, "dist/cli.js");
      const packageBundle = resolve(isolated.bridgeRoot, "dist/index.js");
      const cliBin = resolve(isolated.bridgeRoot, "bin/lark-codex-bridge.mjs");
      const build = spawnSync("corepack", ["pnpm", "build"], {
        cwd: isolated.bridgeRoot,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

      const bundle = readFileSync(cliBundle, "utf8");
      for (const forbidden of FORBIDDEN_SUPPORTED_ENTRY_TEXT) {
        expect(bundle).not.toContain(forbidden);
      }

      const packageRootBundle = readFileSync(packageBundle, "utf8");
      for (const forbidden of FORBIDDEN_SUPPORTED_ENTRY_TEXT) {
        expect(packageRootBundle).not.toContain(forbidden);
      }
      const inspectPackageRoot = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          "const bundle = await import(process.argv[1]); process.stdout.write(JSON.stringify(Object.keys(bundle).sort()));",
          pathToFileURL(packageBundle).href,
        ],
        {
          cwd: isolated.bridgeRoot,
          encoding: "utf8",
          timeout: 5_000,
        },
      );
      expect(
        inspectPackageRoot.status,
        `${inspectPackageRoot.stdout}\n${inspectPackageRoot.stderr}`,
      ).toBe(0);
      expect(JSON.parse(inspectPackageRoot.stdout) as string[]).toEqual(
        [
          "ASSISTANT_CHANNEL_ERROR",
          "ASSISTANT_RUNTIME_PORTS_REQUIRED",
          "PROGRESS_THRESHOLD_MS",
          "SYSTEM_REPLY_ERROR",
          "cancellationText",
          "createAssistantChannel",
          "progressText",
          "sendCancellationReply",
          "sendProgressReply",
          "sendTaskAcceptedReply",
          "startChannel",
          "startProgressReporter",
          "taskAcceptedText",
        ].sort(),
      );

      for (const command of ["run", "start"] as const) {
        const execution = spawnSync(process.execPath, [cliBin, command], {
          cwd: isolated.bridgeRoot,
          encoding: "utf8",
          env: { LANG: "C", PATH: process.env.PATH ?? "" },
          timeout: 5_000,
        });
        expect(execution.status).toBe(1);
        expect(`${execution.stdout}\n${execution.stderr}`).toContain(
          ASSISTANT_RUNTIME_PORTS_REQUIRED,
        );
      }
    } finally {
      rmSync(isolated.root, { recursive: true, force: true });
    }
  });
});
