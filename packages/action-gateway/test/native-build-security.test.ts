import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const nativeRoot = fileURLToPath(new URL("../native/", import.meta.url));
const components = [
  "run-client",
  "control-client",
  "peer-verifier",
  "keychain-helper",
] as const;

type Component = (typeof components)[number];

function expectedArtifactMode(component: Component): number {
  return component === "run-client" ? 0o555 : 0o500;
}

interface BuildResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function secureRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(root, 0o700);
  return realpathSync(root);
}

function runBuild(
  component: Component,
  output: string,
  sourceRoot = nativeRoot,
  cwd = dirname(output),
): BuildResult {
  return spawnSync(
    "/bin/zsh",
    [resolve(sourceRoot, component, "build.sh"), output],
    {
      cwd,
      encoding: "utf8",
      env: {
        HOME: process.env.HOME ?? "/tmp",
        LANG: "C",
        LC_ALL: "C",
        PATH: "/usr/bin:/bin",
      },
    },
  );
}

describe("native build publication boundary", () => {
  const products = new Map<Component, string>();

  beforeAll(() => {
    for (const component of components) {
      const root = secureRoot(`assistant-${component}-production-`);
      const output = join(root, component);
      const result = runBuild(component, output);
      expect(result.status, result.stderr).toBe(0);
      products.set(component, output);
    }
  });

  it.each(components)(
    "emits a signed owner-only %s production artifact",
    (component) => {
      const output = products.get(component)!;
      const verification = spawnSync(
        "/usr/bin/codesign",
        ["--verify", "--strict", output],
        { encoding: "utf8" },
      );

      expect(verification.status, verification.stderr).toBe(0);
      expect(statSync(output).mode & 0o7777).toBe(
        expectedArtifactMode(component),
      );
      expect(statSync(output).uid).toBe(process.getuid?.());
      expect(statSync(dirname(output)).mode & 0o7777).toBe(0o700);
      expect(statSync(dirname(output)).uid).toBe(process.getuid?.());
    },
  );

  it.each(components)("rejects non-canonical %s output paths", (component) => {
    const root = secureRoot(`assistant-${component}-paths-`);
    const nested = join(root, "nested");
    mkdirSync(nested, { mode: 0o700 });
    const nonCanonical = `${nested}/../artifact`;
    const relative = "relative-artifact";

    expect(runBuild(component, relative, nativeRoot, root).status).toBe(2);
    expect(runBuild(component, nonCanonical).status).toBe(2);
    expect(existsSync(join(root, relative))).toBe(false);
    expect(existsSync(join(root, "artifact"))).toBe(false);
  });

  it.each(components)("rejects symlinked %s output paths", (component) => {
    const root = secureRoot(`assistant-${component}-symlink-`);
    const target = join(root, "target");
    const outputLink = join(root, "output");
    writeFileSync(target, "sentinel", { mode: 0o600 });
    symlinkSync(target, outputLink);

    expect(runBuild(component, outputLink).status).toBe(2);
    expect(readFileSync(target, "utf8")).toBe("sentinel");

    const realParent = join(root, "real-parent");
    const linkedParent = join(root, "linked-parent");
    mkdirSync(realParent, { mode: 0o700 });
    symlinkSync(realParent, linkedParent);
    expect(runBuild(component, join(linkedParent, "artifact")).status).toBe(2);
    expect(existsSync(join(realParent, "artifact"))).toBe(false);

    const nested = join(realParent, "nested");
    mkdirSync(nested, { mode: 0o700 });
    expect(
      runBuild(component, join(linkedParent, "nested", "artifact")).status,
    ).toBe(2);
    expect(existsSync(join(nested, "artifact"))).toBe(false);

    const missing = join(realParent, "missing");
    expect(
      runBuild(
        component,
        join(linkedParent, "missing", "artifact"),
        nativeRoot,
        root,
      ).status,
    ).toBe(2);
    expect(existsSync(missing)).toBe(false);
  });

  it.each(components)(
    "rejects insecure %s output directories and existing artifact modes",
    (component) => {
      const insecureRoot = secureRoot(`assistant-${component}-insecure-`);
      chmodSync(insecureRoot, 0o755);
      expect(runBuild(component, join(insecureRoot, "artifact")).status).toBe(
        2,
      );
      expect(existsSync(join(insecureRoot, "artifact"))).toBe(false);

      const secureTargetRoot = secureRoot(`assistant-${component}-mode-`);
      const output = join(secureTargetRoot, "artifact");
      const wrongMode = component === "run-client" ? 0o500 : 0o555;
      writeFileSync(output, "sentinel", { mode: wrongMode });
      chmodSync(output, wrongMode);
      expect(runBuild(component, output).status).toBe(2);
      expect(readFileSync(output, "utf8")).toBe("sentinel");
      expect(statSync(output).mode & 0o7777).toBe(wrongMode);
    },
  );

  it.each(components)(
    "preserves an existing %s target when compilation fails",
    (component) => {
      const root = secureRoot(`assistant-${component}-atomic-`);
      const copiedNative = join(root, "native");
      cpSync(nativeRoot, copiedNative, { recursive: true });
      writeFileSync(
        join(copiedNative, component, "main.swift"),
        "this is intentionally invalid Swift\n",
      );
      const outputRoot = secureRoot(`assistant-${component}-target-`);
      const output = join(outputRoot, "artifact");
      const expectedMode = expectedArtifactMode(component);
      writeFileSync(output, "original", { mode: expectedMode });
      chmodSync(output, expectedMode);

      const result = runBuild(component, output, copiedNative);

      expect(result.status).toBe(1);
      expect(readFileSync(output, "utf8")).toBe("original");
      expect(statSync(output).mode & 0o7777).toBe(expectedMode);
    },
  );
});
