import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const nativeRoot = fileURLToPath(new URL("../native/", import.meta.url));
const helperRoot = resolve(nativeRoot, "keychain-helper");
const releaseHash = `sha256:${"a".repeat(64)}`;
const provider = "executive-assistant-keychain";
const appId = "cli_testing_app";
const secretId = `app-${appId}`;
const fakeSecret = "ASSISTANT_TEST_KEYCHAIN_SENTINEL";

let productionHelper = "";
let testingHelper = "";
let kernelProbe = "";
let nodeHash = "";
let nodeRequirement = "";

interface Fixture {
  readonly root: string;
  readonly release: string;
  readonly helperPath: string;
  readonly nodePath: string;
  readonly bridgePath: string;
  readonly probePath: string;
  readonly manifestPath: string;
  readonly releaseManifestPath: string;
  readonly scenarioPath: string;
  readonly manifest: Record<string, unknown>;
  readonly releaseManifest: Record<string, unknown>;
  readonly scenario: Record<string, unknown>;
}

interface Invocation {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly lookupCount: number;
}

function sha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function designatedRequirement(path: string): string {
  const result = spawnSync("/usr/bin/codesign", ["-d", "-r-", path], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  });
  expect(result.status, result.stderr).toBe(0);
  const match = `${result.stdout}${result.stderr}`.match(
    /designated => (.+)$/m,
  );
  expect(match).not.toBeNull();
  return match![1]!.trim();
}

function secureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writeSecure(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function cloneExecutable(source: string, destination: string): void {
  const result = spawnSync("/bin/cp", ["-c", source, destination], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  });
  expect(result.status, result.stderr).toBe(0);
  chmodSync(destination, 0o500);
}

function buildNative(mode: "production" | "testing" | "kernel-probe"): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "assistant-keychain-helper-build-")),
  );
  chmodSync(root, 0o700);
  const output = join(
    root,
    mode === "production"
      ? "production"
      : mode === "testing"
        ? "assistant-keychain-helper-testing"
        : "assistant-keychain-kernel-probe",
  );
  const args = [resolve(helperRoot, "build.sh"), output];
  if (mode !== "production") args.push(`--${mode}`);
  const result = spawnSync("/bin/zsh", args, {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: "/tmp",
      LANG: "C",
      LC_ALL: "C",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
  expect(existsSync(output)).toBe(true);
  expect(
    spawnSync("/usr/bin/codesign", ["--verify", "--strict", output]).status,
  ).toBe(0);
  return output;
}

function wrapperSource(
  root: string,
  helperPath: string,
  probePath: string,
  scenarioPath: string,
): string {
  return [
    'import { chmodSync, readFileSync, writeFileSync } from "node:fs";',
    'import { spawnSync } from "node:child_process";',
    'import { join } from "node:path";',
    `const root = ${JSON.stringify(root)};`,
    `const helperPath = ${JSON.stringify(helperPath)};`,
    `const probePath = ${JSON.stringify(probePath)};`,
    `const scenarioPath = ${JSON.stringify(scenarioPath)};`,
    'const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));',
    'const probe = spawnSync(probePath, [], { encoding: "utf8", env: {} });',
    'if (probe.status !== 0) throw new Error("kernel probe failed");',
    "const parent = JSON.parse(probe.stdout);",
    `const releaseHash = ${JSON.stringify(releaseHash)};`,
    "const bridge = { pid: parent.pid, pidVersion: parent.pidVersion, euid: parent.euid, instanceId: crypto.randomUUID(), ...(scenario.bridgeOverride ?? {}) };",
    "const active = { version: 1, releaseHash: scenario.releaseHash ?? releaseHash, bridge };",
    'const activePath = join(root, "control", "active-instances.json");',
    "writeFileSync(activePath, JSON.stringify(active), { mode: 0o600 });",
    "chmodSync(activePath, scenario.activeMode ?? 0o600);",
    'const lookupPath = join(root, "control", "testing-keychain-lookup-count");',
    'writeFileSync(lookupPath, "0", { mode: 0o600 }); chmodSync(lookupPath, 0o600);',
    "for (const marker of scenario.markers ?? []) {",
    '  const markerPath = join(root, "control", marker);',
    '  writeFileSync(markerPath, "1", { mode: 0o600 }); chmodSync(markerPath, 0o600);',
    "}",
    "const input = Buffer.from(scenario.inputBase64, 'base64');",
    "const child = spawnSync(helperPath, scenario.helperArgs ?? [], {",
    '  encoding: "utf8", input,',
    "  env: { ASSISTANT_TEST_RUNTIME_ROOT: root },",
    "});",
    'const lookupCount = Number(readFileSync(lookupPath, "utf8"));',
    "process.stdout.write(JSON.stringify({ status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr, lookupCount }));",
  ].join("\n");
}

function validRequest(): Record<string, unknown> {
  return { protocolVersion: 1, provider, ids: [secretId] };
}

function makeFixture(): Fixture {
  const root = realpathSync(mkdtempSync("/private/tmp/assistant-keychain-"));
  const release = join(root, "releases", "v1");
  const control = join(root, "control");
  const privateBin = join(release, "private-bin");
  const nodeBin = join(release, "node-bin");
  const bridgeDir = join(release, "bridge");
  for (const path of [
    root,
    join(root, "releases"),
    release,
    control,
    privateBin,
    nodeBin,
    bridgeDir,
  ]) {
    secureDirectory(path);
  }
  symlinkSync("releases/v1", join(root, "current"));

  const helperPath = join(privateBin, "assistant-keychain-helper");
  const probePath = join(privateBin, "assistant-keychain-kernel-probe");
  const nodePath = join(nodeBin, "node");
  const bridgePath = join(bridgeDir, "index.mjs");
  const manifestPath = join(release, "keychain-helper-manifest.json");
  const releaseManifestPath = join(release, "release-manifest.json");
  const scenarioPath = join(control, "testing-keychain-scenario.json");
  copyFileSync(testingHelper, helperPath);
  copyFileSync(kernelProbe, probePath);
  cloneExecutable(process.execPath, nodePath);
  writeFileSync(
    bridgePath,
    wrapperSource(root, helperPath, probePath, scenarioPath),
    { mode: 0o600 },
  );
  chmodSync(helperPath, 0o500);
  chmodSync(probePath, 0o500);
  chmodSync(bridgePath, 0o600);

  const releaseManifest: Record<string, unknown> = {
    version: 1,
    releaseHash,
    node: {
      realPath: realpathSync(nodePath),
      sha256: nodeHash,
      designatedRequirement: nodeRequirement,
    },
    bridge: {
      entryRealPath: realpathSync(bridgePath),
      sha256: sha256(bridgePath),
    },
    binaries: {
      controlClient: {
        realPath: realpathSync(helperPath),
        sha256: sha256(helperPath),
        designatedRequirement: designatedRequirement(helperPath),
      },
      peerVerifier: {
        realPath: realpathSync(probePath),
        sha256: sha256(probePath),
        designatedRequirement: designatedRequirement(probePath),
      },
    },
  };
  writeSecure(releaseManifestPath, releaseManifest);
  const manifest: Record<string, unknown> = {
    version: 1,
    releaseHash,
    appId,
    secretRefProvider: provider,
    releaseManifest: {
      realPath: realpathSync(releaseManifestPath),
      sha256: sha256(releaseManifestPath),
    },
    keychainHelper: {
      realPath: realpathSync(helperPath),
      sha256: sha256(helperPath),
      designatedRequirement: designatedRequirement(helperPath),
    },
  };
  const scenario: Record<string, unknown> = {
    inputBase64: Buffer.from(JSON.stringify(validRequest())).toString("base64"),
  };
  writeSecure(manifestPath, manifest);
  writeSecure(scenarioPath, scenario);
  return {
    root,
    release,
    helperPath,
    nodePath,
    bridgePath,
    probePath,
    manifestPath,
    releaseManifestPath,
    scenarioPath,
    manifest,
    releaseManifest,
    scenario,
  };
}

function refreshFixture(fixture: Fixture): void {
  writeSecure(fixture.releaseManifestPath, fixture.releaseManifest);
  if (fixture.scenario.preserveReleaseManifestDigest !== true) {
    (
      fixture.manifest.releaseManifest as {
        realPath: string;
        sha256: string;
      }
    ).sha256 = sha256(fixture.releaseManifestPath);
  }
  writeSecure(fixture.manifestPath, fixture.manifest);
  writeSecure(fixture.scenarioPath, fixture.scenario);
}

function invoke(
  fixture: Fixture,
  refresh = true,
  parentExtraArgs: readonly string[] = [],
): Invocation {
  if (refresh) refreshFixture(fixture);
  const result = spawnSync(
    fixture.nodePath,
    [fixture.bridgePath, ...parentExtraArgs],
    {
      encoding: "utf8",
      env: {},
      timeout: 30_000,
    },
  );
  expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  return JSON.parse(result.stdout) as Invocation;
}

function rewriteWrapper(
  fixture: Fixture,
  helperPath = fixture.helperPath,
): void {
  writeFileSync(
    fixture.bridgePath,
    wrapperSource(
      fixture.root,
      helperPath,
      fixture.probePath,
      fixture.scenarioPath,
    ),
    { mode: 0o600 },
  );
  chmodSync(fixture.bridgePath, 0o600);
  (
    fixture.releaseManifest.bridge as {
      entryRealPath: string;
      sha256: string;
    }
  ).sha256 = sha256(fixture.bridgePath);
}

function setInput(fixture: Fixture, input: string | Buffer): void {
  fixture.scenario.inputBase64 = Buffer.from(input).toString("base64");
}

function expectDenied(result: Invocation, expectedLookupCount = 0): void {
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
  expect(result.lookupCount).toBe(expectedLookupCount);
}

describe("native Keychain SecretRef helper", () => {
  beforeAll(() => {
    productionHelper = buildNative("production");
    testingHelper = buildNative("testing");
    kernelProbe = buildNative("kernel-probe");
    nodeHash = sha256(process.execPath);
    nodeRequirement = designatedRequirement(process.execPath);
  });

  it("returns the bounded testing probe value for the exact manifest-bound request", () => {
    const fixture = makeFixture();
    const result = invoke(fixture);

    expect(result).toMatchObject({
      status: 0,
      signal: null,
      stderr: "",
      lookupCount: 1,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: { [secretId]: fakeSecret },
      errors: {},
    });
  });

  it("keeps the production artifact isolated from the testing runtime root", () => {
    const fixture = makeFixture();
    const result = spawnSync(productionHelper, [], {
      encoding: "utf8",
      input: JSON.stringify(validRequest()),
      env: { ASSISTANT_TEST_RUNTIME_ROOT: fixture.root },
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("does not retain any testing runtime or mutation seam in production", () => {
    const strings = spawnSync("/usr/bin/strings", [productionHelper], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
    expect(strings.status, strings.stderr).toBe(0);
    expect(strings.stdout).not.toMatch(
      /ASSISTANT_TEST_RUNTIME_ROOT|ASSISTANT_TEST_KEYCHAIN_SENTINEL|testing-keychain-(?:lookup|active|helper|release|current|node|bridge)/,
    );
  });

  it("requires explicit, exact artifact basenames for test compiler modes", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "assistant-keychain-mode-boundary-")),
    );
    chmodSync(root, 0o700);
    for (const mode of ["--testing", "--kernel-probe"] as const) {
      for (const output of [
        "",
        join(root, "assistant-keychain-helper"),
        join(root, "wrong-test-artifact"),
      ]) {
        const result = spawnSync(
          "/bin/zsh",
          [resolve(helperRoot, "build.sh"), output, mode],
          {
            encoding: "utf8",
            env: {
              PATH: "/usr/bin:/bin",
              HOME: "/tmp",
              LANG: "C",
              LC_ALL: "C",
            },
          },
        );
        expect(result.status).toBe(2);
        if (output !== "") expect(existsSync(output)).toBe(false);
      }
    }
  });

  it.each([
    ["empty input", ""],
    ["array", "[]"],
    ["trailing JSON", "{}{}"],
    ["invalid UTF-8", Buffer.from([0xff])],
    ["oversized input", Buffer.alloc(4097, 0x61)],
    [
      "extra field",
      JSON.stringify({ ...validRequest(), unexpected: "rejected" }),
    ],
    [
      "wrong version",
      JSON.stringify({ ...validRequest(), protocolVersion: 2 }),
    ],
    [
      "boolean version",
      JSON.stringify({ ...validRequest(), protocolVersion: true }),
    ],
    [
      "wrong provider",
      JSON.stringify({ ...validRequest(), provider: "other" }),
    ],
    ["zero ids", JSON.stringify({ ...validRequest(), ids: [] })],
    [
      "two ids",
      JSON.stringify({ ...validRequest(), ids: [secretId, secretId] }),
    ],
    ["wrong id", JSON.stringify({ ...validRequest(), ids: ["app-cli_other"] })],
  ])("rejects %s without diagnostic output", (_name, input) => {
    const fixture = makeFixture();
    setInput(fixture, input);
    expectDenied(invoke(fixture));
  });

  it("rejects duplicate JSON object keys", () => {
    const fixture = makeFixture();
    setInput(
      fixture,
      `{"protocolVersion":1,"protocolVersion":1,"provider":"${provider}","ids":["${secretId}"]}`,
    );
    expectDenied(invoke(fixture));
  });

  it("rejects extra argv without diagnostic output", () => {
    const fixture = makeFixture();
    fixture.scenario.helperArgs = ["unexpected"];
    expectDenied(invoke(fixture));
  });

  it("requires the parent argv to be exactly node and the bound bridge", () => {
    const fixture = makeFixture();
    expectDenied(invoke(fixture, true, ["unexpected-parent-argv"]));
  });

  it("rejects a non-active parent before the fake Keychain probe", () => {
    const fixture = makeFixture();
    fixture.scenario.bridgeOverride = { pid: process.pid + 100_000 };
    expectDenied(invoke(fixture));
  });

  it("rejects insecure active-state and manifest permissions", () => {
    const activeFixture = makeFixture();
    activeFixture.scenario.activeMode = 0o644;
    expectDenied(invoke(activeFixture));

    const manifestFixture = makeFixture();
    refreshFixture(manifestFixture);
    chmodSync(manifestFixture.manifestPath, 0o644);
    expectDenied(invoke(manifestFixture, false));
  });

  it("rejects helper, release-manifest parent, and bridge hash mismatches", () => {
    for (const target of ["helper", "node", "bridge"] as const) {
      const fixture = makeFixture();
      if (target === "helper") {
        (fixture.manifest.keychainHelper as { sha256: string }).sha256 =
          `sha256:${"0".repeat(64)}`;
      } else if (target === "node") {
        (fixture.releaseManifest.node as { sha256: string }).sha256 =
          `sha256:${"0".repeat(64)}`;
      } else {
        (fixture.releaseManifest.bridge as { sha256: string }).sha256 =
          `sha256:${"0".repeat(64)}`;
      }
      expectDenied(invoke(fixture));
    }
  });

  it("rejects node or bridge identity fields in the helper manifest", () => {
    for (const field of ["node", "bridge"] as const) {
      const fixture = makeFixture();
      fixture.manifest[field] = fixture.releaseManifest[field];
      expectDenied(invoke(fixture));
    }
  });

  it("rejects a release-manifest digest mismatch", () => {
    const fixture = makeFixture();
    fixture.scenario.preserveReleaseManifestDigest = true;
    (
      fixture.manifest.releaseManifest as {
        realPath: string;
        sha256: string;
      }
    ).sha256 = `sha256:${"0".repeat(64)}`;
    expectDenied(invoke(fixture));
  });

  it("rejects a release-manifest path outside the selected release", () => {
    const fixture = makeFixture();
    const escaped = join(fixture.root, "control", "release-manifest.json");
    writeSecure(escaped, fixture.releaseManifest);
    fixture.manifest.releaseManifest = {
      realPath: realpathSync(escaped),
      sha256: sha256(escaped),
    };
    fixture.scenario.preserveReleaseManifestDigest = true;
    expectDenied(invoke(fixture));
  });

  it("rejects an inexact release-manifest v1 and three-way release hash mismatch", () => {
    const extraFixture = makeFixture();
    extraFixture.releaseManifest.unexpected = true;
    expectDenied(invoke(extraFixture));

    const hashFixture = makeFixture();
    hashFixture.releaseManifest.releaseHash = `sha256:${"b".repeat(64)}`;
    expectDenied(invoke(hashFixture));
  });

  it("rejects insecure release-manifest permissions", () => {
    const fixture = makeFixture();
    refreshFixture(fixture);
    chmodSync(fixture.releaseManifestPath, 0o644);
    expectDenied(invoke(fixture, false));
  });

  it.each([
    ["active state", "testing-keychain-active-after-input", 0],
    ["helper manifest", "testing-keychain-helper-manifest-after-input", 0],
    ["release manifest", "testing-keychain-release-manifest-after-input", 0],
    [
      "release manifest content",
      "testing-keychain-release-manifest-content-after-input",
      0,
    ],
    ["current selection", "testing-keychain-current-after-input", 0],
    ["node binary", "testing-keychain-node-after-input", 0],
    ["bridge entry", "testing-keychain-bridge-after-input", 0],
    [
      "release manifest after lookup",
      "testing-keychain-release-manifest-after-lookup",
      1,
    ],
  ])(
    "rejects %s drift at the authorization stage",
    (_name, marker, lookupCount) => {
      const fixture = makeFixture();
      fixture.scenario.markers = [marker];
      expectDenied(invoke(fixture), lookupCount);
    },
  );

  it("rejects post-lookup active-state drift and discards the secret", () => {
    const fixture = makeFixture();
    fixture.scenario.markers = ["testing-keychain-active-after-lookup"];
    expectDenied(invoke(fixture), 1);
  });

  it("rejects a copied helper that is not the manifest-declared executable", () => {
    const fixture = makeFixture();
    const copied = join(fixture.release, "private-bin", "copied-helper");
    copyFileSync(fixture.helperPath, copied);
    chmodSync(copied, 0o500);
    rewriteWrapper(fixture, copied);
    expectDenied(invoke(fixture));
  });

  it("uses a valid UUID instance in the active state fixture", () => {
    expect(randomUUID()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
