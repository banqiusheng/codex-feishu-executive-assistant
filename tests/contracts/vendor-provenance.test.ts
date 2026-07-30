import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(".");
const manifestTool = resolve("scripts/bridge-vendor-manifest.mjs");
const patchDirectory = resolve("vendor/patches/lark-codex-bridge");

interface PatchLock {
  path: string;
  sha256: string;
}

interface BridgeLock {
  repository: string;
  tag: string;
  tagObjectSha: string;
  commitSha: string;
  treeSha: string;
  patchedTreeSha: string;
  strictManifestSha256: string;
  licenseSha256: string;
  vendorScriptSha256: string;
  manifestToolSha256: string;
  patches: PatchLock[];
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readBridgeLock(): BridgeLock {
  const lock = JSON.parse(readFileSync("dependencies.lock.json", "utf8")) as {
    larkCodexBridge: BridgeLock;
  };
  return lock.larkCodexBridge;
}

function readStrictManifest(): {
  gitTreeSha: string;
  strictManifestSha256: string;
} {
  const result = spawnSync(
    process.execPath,
    [manifestTool, "manifest", resolve("packages/bridge")],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    gitTreeSha: string;
    strictManifestSha256: string;
  };
}

function lexicalCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

describe("vendored bridge provenance", () => {
  it("pins original and fully patched source evidence", () => {
    const lock = readBridgeLock();

    expect(lock).toMatchObject({
      tagObjectSha: "fcc8b1f4cb6ef45ba598cda2f057bb2798e479a1",
      commitSha: "e8b0dc0cdfe2fb378bef7081618138a20d934aa9",
      treeSha: "9abc1413bf4f44ab048985cbbcebe1e4fc099d8f",
    });
    expect(lock.patchedTreeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(lock.strictManifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lock.licenseSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lock.vendorScriptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lock.manifestToolSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lock.patches.length).toBeGreaterThan(0);
  });

  it("matches the offline strict manifest, scripts, patches, and complete license", () => {
    const lock = readBridgeLock();
    const manifest = readStrictManifest();
    const bridgeLicense = readFileSync("packages/bridge/LICENSE");
    const preservedLicense = readFileSync("LICENSES/lark-codex-bridge-MIT.txt");
    const patchPaths = readdirSync(patchDirectory)
      .filter((name) => name.endsWith(".patch"))
      .map((name) => `vendor/patches/lark-codex-bridge/${name}`)
      .sort(lexicalCompare);

    expect(manifest.gitTreeSha).toBe(lock.patchedTreeSha);
    expect(manifest.strictManifestSha256).toBe(lock.strictManifestSha256);
    expect(preservedLicense.equals(bridgeLicense)).toBe(true);
    expect(sha256("packages/bridge/LICENSE")).toBe(lock.licenseSha256);
    expect(sha256("scripts/vendor-bridge")).toBe(lock.vendorScriptSha256);
    expect(sha256("scripts/bridge-vendor-manifest.mjs")).toBe(
      lock.manifestToolSha256,
    );
    expect(lock.patches.map(({ path }) => path)).toEqual(patchPaths);
    for (const patch of lock.patches) {
      expect(sha256(patch.path)).toBe(patch.sha256);
    }
  });

  it("binds the vendor script and provenance documents to the lock", () => {
    const lock = readBridgeLock();
    const vendorScript = readFileSync("scripts/vendor-bridge", "utf8");
    const upstreamDocument = readFileSync(
      "packages/bridge/UPSTREAM.md",
      "utf8",
    );
    const patchesDocument = readFileSync("packages/bridge/PATCHES.md", "utf8");
    const constants = Object.fromEntries(
      [...vendorScript.matchAll(/^readonly (\w+)="([^"]+)"$/gm)].map(
        (match) => [match[1], match[2]],
      ),
    );

    expect(constants).toMatchObject({
      upstream: lock.repository,
      tag: lock.tag,
      tag_object: lock.tagObjectSha,
      commit: lock.commitSha,
      tree: lock.treeSha,
    });
    expect(vendorScript).toContain(
      'node "$manifest_tool" compare "$stage" "$target"',
    );
    expect(vendorScript).not.toMatch(/^\s*diff(?:\s|$)/m);

    for (const value of [
      lock.repository,
      lock.tag,
      lock.tagObjectSha,
      lock.commitSha,
      lock.treeSha,
    ]) {
      expect(upstreamDocument).toContain(value);
    }
    for (const patch of lock.patches) {
      expect(patchesDocument).toContain(patch.path.split("/").at(-1));
    }
  });

  it("limits audited patch paths and removes nested workspace authority", () => {
    const lock = readBridgeLock();
    const allowedPathsByPatch = new Map([
      [
        "vendor/patches/lark-codex-bridge/0001-workspace-adapter.patch",
        new Set([
          "PATCHES.md",
          "UPSTREAM.md",
          "package.json",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
          "tsconfig.json",
          "vitest.config.ts",
        ]),
      ],
      [
        "vendor/patches/lark-codex-bridge/0002-fail-closed-ingress.patch",
        new Set([
          "PATCHES.md",
          "src/security/ingress-guard.ts",
          "src/security/policy.ts",
          "test/channel-deny.test.ts",
          "test/ingress-guard.test.ts",
        ]),
      ],
      [
        "vendor/patches/lark-codex-bridge/0003-constrained-codex-runner.patch",
        new Set([
          "PATCHES.md",
          "src/agent/codex-runner.ts",
          "src/security/workspace.ts",
          "test/codex-runner.test.ts",
          "test/workspace.test.ts",
        ]),
      ],
      [
        "vendor/patches/lark-codex-bridge/0004-ledger-first-assistant-channel.patch",
        new Set([
          "PATCHES.md",
          "package.json",
          "src/bot/channel.ts",
          "src/cli/commands/start.ts",
          "src/cli/index.ts",
          "src/index.ts",
          "src/runtime/assistant-channel.ts",
          "src/runtime/progress-reporter.ts",
          "src/runtime/system-reply.ts",
          "test/assistant-channel.test.ts",
          "test/channel-adapter.test.ts",
          "test/progress-reporter.test.ts",
          "test/start-fail-closed.test.ts",
        ]),
      ],
      [
        "vendor/patches/lark-codex-bridge/0005-static-dynamic-access-boundary.patch",
        new Set([
          "PATCHES.md",
          "src/agent/codex-runner.ts",
          "src/bot/channel.ts",
          "src/runtime/assistant-channel.ts",
          "src/runtime/progress-reporter.ts",
          "src/runtime/system-reply.ts",
        ]),
      ],
      [
        "vendor/patches/lark-codex-bridge/0006-task-scoped-unix-socket-permission.patch",
        new Set([
          "PATCHES.md",
          "src/agent/codex-runner.ts",
          "test/codex-runner.test.ts",
        ]),
      ],
      [
        "vendor/patches/lark-codex-bridge/0007-task-resource-projection.patch",
        new Set([
          "PATCHES.md",
          "src/bot/channel.ts",
          "src/index.ts",
          "src/runtime/assistant-channel.ts",
          "test/assistant-channel.test.ts",
          "test/channel-adapter.test.ts",
        ]),
      ],
    ]);

    expect(lock.patches.map(({ path }) => path)).toEqual([
      ...allowedPathsByPatch.keys(),
    ]);

    for (const patch of lock.patches) {
      const allowedPaths = allowedPathsByPatch.get(patch.path);
      expect(allowedPaths).toBeDefined();
      const text = readFileSync(patch.path, "utf8");
      const diffPaths = [...text.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)];
      expect(diffPaths.length).toBeGreaterThan(0);
      const actualPaths = new Set<string>();
      for (const match of diffPaths) {
        expect(allowedPaths?.has(match[1] ?? "")).toBe(true);
        expect(allowedPaths?.has(match[2] ?? "")).toBe(true);
        if (match[1] !== undefined) actualPaths.add(match[1]);
        if (match[2] !== undefined) actualPaths.add(match[2]);
      }
      expect([...actualPaths].sort(lexicalCompare)).toEqual(
        [...(allowedPaths ?? [])].sort(lexicalCompare),
      );

      if (patch.path.endsWith("0001-workspace-adapter.patch")) {
        expect(text).not.toMatch(/^diff --git a\/(?:src|test|bin|runtime)\//m);
      }
    }

    expect(existsSync("packages/bridge/pnpm-lock.yaml")).toBe(false);
    expect(existsSync("packages/bridge/pnpm-workspace.yaml")).toBe(false);
  });

  it("pins the private workspace package scripts and direct dependencies", () => {
    const packageJson = JSON.parse(
      readFileSync("packages/bridge/package.json", "utf8"),
    ) as {
      name: string;
      private: boolean;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(packageJson.name).toBe("@executive-assistant/bridge");
    expect(packageJson.private).toBe(true);
    expect(packageJson.scripts).toMatchObject({
      build: "tsup --config tsup.config.ts",
      typecheck: "tsc --project tsconfig.json --noEmit",
      test: "vitest run --config vitest.config.ts",
    });
    expect(packageJson.dependencies).toEqual({
      "@clack/prompts": "1.4.0",
      "@executive-assistant/contracts": "workspace:*",
      "@larksuiteoapi/node-sdk": "1.65.0",
      commander: "12.1.0",
      "https-proxy-agent": "9.0.0",
      "qrcode-terminal": "0.12.0",
    });
    expect(packageJson.devDependencies).toEqual({
      "@types/node": "22.10.0",
      "@types/qrcode-terminal": "0.12.2",
      tsup: "8.3.5",
      typescript: "5.6.3",
      vitest: "2.1.8",
    });
  });
});
