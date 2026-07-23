import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const nativeRoot = fileURLToPath(new URL("../native/", import.meta.url));
const releaseHash = `sha256:${"a".repeat(64)}`;
const sentinel = "PEER_VERIFIER_MUST_NOT_READ_FD3";

let productionVerifier = "";
let testingVerifier = "";
let testingPeer = "";
let kernelProbe = "";
let nodeHash = "";
let nodeRequirement = "";

interface Fixture {
  root: string;
  release: string;
  helperPath: string;
  controlPath: string;
  nodePath: string;
  bridgePath: string;
  manifestPath: string;
  activePath: string;
  scenarioPath: string;
  manifest: Record<string, unknown>;
  scenario: Record<string, unknown>;
}

interface WrapperResult {
  helperStatus: number | null;
  helperSignal: string | null;
  helperStdout: string;
  helperStderr: string;
  preservedData: string;
  peerStatus: number | null;
  peerStderr: string;
}

function buildNative(
  mode: "production" | "testing" | "test-peer" | "kernel-probe",
): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "assistant-gateway-peer-verifier-build-")),
  );
  const output = join(root, mode);
  const args = [resolve(nativeRoot, "peer-verifier/build.sh"), output];
  if (mode !== "production") args.push(`--${mode}`);
  const result = spawnSync("/bin/zsh", args, {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
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

function sha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function designatedRequirement(path: string): string {
  const result = spawnSync("/usr/bin/codesign", ["-d", "-r-", path], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const match = `${result.stdout}${result.stderr}`.match(
    /designated => (.+)$/m,
  );
  expect(match).not.toBeNull();
  return match![1]!.trim();
}

function makeDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writeSecure(path: string, value: string): void {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function cloneExecutable(source: string, destination: string): void {
  const result = spawnSync("/bin/cp", ["-c", source, destination], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
}

function wrapperSource(): string {
  return [
    'import { chmodSync, existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";',
    'import { spawn, spawnSync } from "node:child_process";',
    'import { createServer } from "node:net";',
    'import { once } from "node:events";',
    'import { join } from "node:path";',
    "const [root, helperPath, controlPath, probePath, scenarioPath] = process.argv.slice(2);",
    'const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));',
    'const probe = spawnSync(probePath, [], { encoding: "utf8", env: {} });',
    "if (probe.status !== 0) throw new Error(`probe failed: ${probe.stderr}`);",
    "const parent = JSON.parse(probe.stdout);",
    `const releaseHash = ${JSON.stringify(releaseHash)};`,
    "let active = { version: 1, releaseHash, bridge: { pid: parent.pid, pidVersion: parent.pidVersion, euid: parent.euid, instanceId: crypto.randomUUID() } };",
    "if (scenario.activeOverride) active = { ...active, ...scenario.activeOverride, bridge: { ...active.bridge, ...(scenario.activeOverride.bridge ?? {}) } };",
    "if (scenario.activeExtraKey) active.unexpected = true;",
    'const activePath = join(root, "control", "active-instances.json");',
    "let activeText = JSON.stringify(active);",
    'if (scenario.duplicateActiveKey) activeText = activeText.replace(`"releaseHash":"${active.releaseHash}"`, `"releaseHash":"${active.releaseHash}","releaseHash":"${active.releaseHash}"`);',
    'if (scenario.oversizedActive) activeText = `{"pad":"${"x".repeat(1024 * 1024)}"}`;',
    "writeFileSync(activePath, activeText, { mode: 0o600 }); chmodSync(activePath, scenario.activeMode ?? 0o600);",
    'if (scenario.activeSymlink) { const target = join(root, "control", "active-target.json"); writeFileSync(target, activeText, { mode: 0o600 }); chmodSync(target, 0o600); unlinkSync(activePath); symlinkSync("active-target.json", activePath); }',
    'if (scenario.driftActive) { const after = { ...active, bridge: { ...active.bridge, instanceId: crypto.randomUUID() } }; const path = join(root, "control", "testing-active-after.json"); writeFileSync(path, JSON.stringify(after), { mode: 0o600 }); chmodSync(path, 0o600); }',
    'const socketPath = join(root, "control", "testing-peer.sock");',
    'const server = createServer(); server.listen(socketPath); await once(server, "listening"); chmodSync(socketPath, 0o600);',
    'const peer = spawn(controlPath, [], { env: { ASSISTANT_TEST_PEER_SOCKET: socketPath }, stdio: ["ignore", "ignore", "pipe"] });',
    'let peerStderr = ""; peer.stderr.setEncoding("utf8"); peer.stderr.on("data", chunk => { peerStderr += chunk; });',
    'const [socket] = await once(server, "connection"); socket.pause();',
    'const helper = spawn(helperPath, scenario.helperArgs ?? [], { env: { ASSISTANT_TEST_RUNTIME_ROOT: root }, stdio: ["ignore", "pipe", "pipe", socket] });',
    'let helperStdout = ""; let helperStderr = ""; helper.stdout.setEncoding("utf8"); helper.stderr.setEncoding("utf8");',
    'helper.stdout.on("data", chunk => { helperStdout += chunk; }); helper.stderr.on("data", chunk => { helperStderr += chunk; });',
    'const [helperStatus, helperSignal] = await once(helper, "close");',
    'let preservedData = ""; socket.setEncoding("utf8"); socket.on("data", chunk => { preservedData += chunk; }); socket.resume();',
    'let peerDataTimer; await Promise.race([once(socket, "end"), new Promise((_, reject) => { peerDataTimer = setTimeout(() => reject(new Error("peer data timeout")), 5000); })]); clearTimeout(peerDataTimer);',
    'socket.end(); const [peerStatus] = await once(peer, "close"); server.close(); await once(server, "close");',
    "process.stdout.write(JSON.stringify({ helperStatus, helperSignal, helperStdout, helperStderr, preservedData, peerStatus, peerStderr }));",
  ].join("\n");
}

function makeFixture(helperSource = testingVerifier): Fixture {
  const root = mkdtempSync("/private/tmp/agpv-");
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
    makeDirectory(path);
  }
  symlinkSync("releases/v1", join(root, "current"));

  const helperPath = join(privateBin, "assistant-gateway-peer-verifier");
  const controlPath = join(privateBin, "assistant-gateway-control");
  const nodePath = join(nodeBin, "node");
  const bridgePath = join(bridgeDir, "index.mjs");
  const probePath = join(privateBin, "testing-kernel-probe");
  copyFileSync(helperSource, helperPath);
  copyFileSync(testingPeer, controlPath);
  cloneExecutable(process.execPath, nodePath);
  copyFileSync(kernelProbe, probePath);
  writeSecure(bridgePath, wrapperSource());
  for (const path of [helperPath, controlPath, nodePath, probePath])
    chmodSync(path, 0o500);

  const manifest: Record<string, unknown> = {
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
        realPath: realpathSync(controlPath),
        sha256: sha256(controlPath),
        designatedRequirement: designatedRequirement(controlPath),
      },
      peerVerifier: {
        realPath: realpathSync(helperPath),
        sha256: sha256(helperPath),
        designatedRequirement: designatedRequirement(helperPath),
      },
    },
  };
  const manifestPath = join(release, "release-manifest.json");
  const activePath = join(control, "active-instances.json");
  const scenarioPath = join(control, "testing-scenario.json");
  const scenario: Record<string, unknown> = {};
  writeSecure(manifestPath, JSON.stringify(manifest));
  writeSecure(scenarioPath, JSON.stringify(scenario));

  return {
    root,
    release,
    helperPath,
    controlPath,
    nodePath,
    bridgePath,
    manifestPath,
    activePath,
    scenarioPath,
    manifest,
    scenario,
  };
}

function refreshFixture(fixture: Fixture): void {
  writeSecure(fixture.manifestPath, JSON.stringify(fixture.manifest));
  writeSecure(fixture.scenarioPath, JSON.stringify(fixture.scenario));
}

function invokePreparedFixture(fixture: Fixture): WrapperResult {
  const result = spawnSync(
    fixture.nodePath,
    [
      fixture.bridgePath,
      fixture.root,
      fixture.helperPath,
      fixture.controlPath,
      join(fixture.release, "private-bin", "testing-kernel-probe"),
      fixture.scenarioPath,
    ],
    { encoding: "utf8", env: {}, timeout: 30_000 },
  );
  expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as WrapperResult;
}

function invokeFixture(fixture: Fixture): WrapperResult {
  refreshFixture(fixture);
  return invokePreparedFixture(fixture);
}

function invokeFixtureWithoutManifestRefresh(fixture: Fixture): WrapperResult {
  writeSecure(fixture.scenarioPath, JSON.stringify(fixture.scenario));
  return invokePreparedFixture(fixture);
}

function expectRejectedResult(result: WrapperResult): void {
  expect(result.helperStatus).toBe(2);
  expect(result.helperSignal).toBeNull();
  expect(result.helperStdout).toBe("");
  expect(result.helperStderr).toBe("");
  expect(result.preservedData).toBe(sentinel);
  expect(result.peerStatus).toBe(0);
  expect(result.peerStderr).toBe("");
}

function expectRejectedFixture(fixture: Fixture): void {
  expectRejectedResult(invokeFixture(fixture));
}

function expectRejectedFixtureWithoutManifestRefresh(fixture: Fixture): void {
  expectRejectedResult(invokeFixtureWithoutManifestRefresh(fixture));
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function invokeWithUnmanifestedSocket(
  verifier: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const root = mkdtempSync(join(tmpdir(), "assistant-gateway-peer-socket-"));
  chmodSync(root, 0o700);
  const socketPath = join(root, "peer.sock");
  let acceptedResolve!: (socket: Socket) => void;
  const accepted = new Promise<Socket>((resolveAccepted) => {
    acceptedResolve = resolveAccepted;
  });
  const server = createServer((socket) => acceptedResolve(socket));
  await new Promise<void>((resolveListen) =>
    server.listen(socketPath, resolveListen),
  );
  const client = createConnection(socketPath);
  const socket = await accepted;

  const result = await new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
  }>((resolveInvoke, rejectInvoke) => {
    const child = spawn(verifier, [], {
      env,
      stdio: ["ignore", "pipe", "pipe", socket],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectInvoke);
    child.once("close", (status) => resolveInvoke({ status, stdout, stderr }));
  });
  client.destroy();
  socket.destroy();
  await closeServer(server);
  return result;
}

describe("native peer verifier", () => {
  beforeAll(() => {
    productionVerifier = buildNative("production");
    testingVerifier = buildNative("testing");
    testingPeer = buildNative("test-peer");
    kernelProbe = buildNative("kernel-probe");
    nodeHash = sha256(process.execPath);
    nodeRequirement = designatedRequirement(process.execPath);
  }, 60_000);

  it("rejects an unmanifested peer even when fd 3 is a same-user Unix socket", async () => {
    const result = await invokeWithUnmanifestedSocket(productionVerifier);
    expect(result).toEqual({ status: 2, stdout: "", stderr: "" });
  });

  it("authenticates the manifest-locked control peer and never consumes fd 3", () => {
    const result = invokeFixture(makeFixture());
    expect(result).toEqual({
      helperStatus: 0,
      helperSignal: null,
      helperStdout: "",
      helperStderr: "",
      preservedData: sentinel,
      peerStatus: 0,
      peerStderr: "",
    });
  });

  it("rejects additional helper argv with fixed empty output", () => {
    const fixture = makeFixture();
    fixture.scenario.helperArgs = ["unexpected"];
    expectRejectedFixture(fixture);
  });

  it("keeps the production helper isolated from the testing runtime root", () => {
    expectRejectedFixture(makeFixture(productionVerifier));
  });

  it("rejects a control client hash mismatch", () => {
    const fixture = makeFixture();
    const binaries = fixture.manifest.binaries as {
      controlClient: { sha256: string };
    };
    binaries.controlClient.sha256 = `sha256:${"0".repeat(64)}`;
    expectRejectedFixture(fixture);
  });

  it("rejects a control client designated requirement mismatch", () => {
    const fixture = makeFixture();
    const binaries = fixture.manifest.binaries as {
      controlClient: { designatedRequirement: string };
    };
    binaries.controlClient.designatedRequirement =
      "identifier definitely-wrong";
    expectRejectedFixture(fixture);
  });

  it("rejects a helper self hash mismatch", () => {
    const fixture = makeFixture();
    const binaries = fixture.manifest.binaries as {
      peerVerifier: { sha256: string };
    };
    binaries.peerVerifier.sha256 = `sha256:${"0".repeat(64)}`;
    expectRejectedFixture(fixture);
  });

  it("rejects a Node executable hash mismatch", () => {
    const fixture = makeFixture();
    (fixture.manifest.node as { sha256: string }).sha256 =
      `sha256:${"0".repeat(64)}`;
    expectRejectedFixture(fixture);
  });

  it("rejects a bridge entry hash mismatch", () => {
    const fixture = makeFixture();
    (fixture.manifest.bridge as { sha256: string }).sha256 =
      `sha256:${"0".repeat(64)}`;
    expectRejectedFixture(fixture);
  });

  it("rejects a parent whose argv[1] differs from the manifest bridge entry", () => {
    const fixture = makeFixture();
    const alternate = join(dirname(fixture.bridgePath), "alternate.mjs");
    writeSecure(alternate, wrapperSource());
    (
      fixture.manifest.bridge as { entryRealPath: string; sha256: string }
    ).entryRealPath = alternate;
    (
      fixture.manifest.bridge as { entryRealPath: string; sha256: string }
    ).sha256 = sha256(alternate);
    expectRejectedFixture(fixture);
  });

  it("rejects duplicate keys in the release manifest", () => {
    const fixture = makeFixture();
    refreshFixture(fixture);
    const value = readFileSync(fixture.manifestPath, "utf8").replace(
      `"releaseHash":"${releaseHash}"`,
      `"releaseHash":"${releaseHash}","releaseHash":"${releaseHash}"`,
    );
    writeSecure(fixture.manifestPath, value);
    writeSecure(fixture.scenarioPath, JSON.stringify(fixture.scenario));
    const result = invokeFixtureWithoutManifestRefresh(fixture);
    expectRejectedResult(result);
  });

  it("rejects duplicate keys in active state", () => {
    const fixture = makeFixture();
    fixture.scenario.duplicateActiveKey = true;
    expectRejectedFixture(fixture);
  });

  it("rejects metadata larger than 1 MiB before parsing", () => {
    const activeFixture = makeFixture();
    activeFixture.scenario.oversizedActive = true;
    expectRejectedFixture(activeFixture);

    const manifestFixture = makeFixture();
    writeSecure(
      manifestFixture.manifestPath,
      `{"pad":"${"x".repeat(1024 * 1024)}"}`,
    );
    expectRejectedFixtureWithoutManifestRefresh(manifestFixture);
  });

  it("rejects empty, invalid UTF-8, over-depth, and over-node metadata", () => {
    const cases: Array<string | Buffer> = [
      "",
      Buffer.from([0xff]),
      `${"[".repeat(65)}0${"]".repeat(65)}`,
      JSON.stringify(Array.from({ length: 10_001 }, () => null)),
    ];
    for (const value of cases) {
      const fixture = makeFixture();
      writeFileSync(fixture.manifestPath, value, { mode: 0o600 });
      chmodSync(fixture.manifestPath, 0o600);
      expectRejectedFixtureWithoutManifestRefresh(fixture);
    }
  });

  it("rejects wrong active-state permissions and symlinks", () => {
    const modeFixture = makeFixture();
    modeFixture.scenario.activeMode = 0o644;
    expectRejectedFixture(modeFixture);
    const symlinkFixture = makeFixture();
    symlinkFixture.scenario.activeSymlink = true;
    expectRejectedFixture(symlinkFixture);
  });

  it("rejects manifest permissions, symlinks, and insecure release directories", () => {
    const modeFixture = makeFixture();
    chmodSync(modeFixture.manifestPath, 0o644);
    expectRejectedFixtureWithoutManifestRefresh(modeFixture);

    const symlinkFixture = makeFixture();
    const target = join(symlinkFixture.release, "manifest-target.json");
    copyFileSync(symlinkFixture.manifestPath, target);
    chmodSync(target, 0o600);
    unlinkSync(symlinkFixture.manifestPath);
    symlinkSync("manifest-target.json", symlinkFixture.manifestPath);
    expectRejectedFixtureWithoutManifestRefresh(symlinkFixture);

    const directoryFixture = makeFixture();
    chmodSync(dirname(directoryFixture.helperPath), 0o755);
    expectRejectedFixture(directoryFixture);
  });

  it("rejects active release/bridge mismatches and active-state drift", () => {
    const releaseFixture = makeFixture();
    releaseFixture.scenario.activeOverride = {
      releaseHash: `sha256:${"b".repeat(64)}`,
    };
    expectRejectedFixture(releaseFixture);

    const pidFixture = makeFixture();
    pidFixture.scenario.activeOverride = { bridge: { pid: 2 } };
    expectRejectedFixture(pidFixture);

    const versionFixture = makeFixture();
    versionFixture.scenario.activeOverride = { bridge: { pidVersion: 1 } };
    expectRejectedFixture(versionFixture);

    const euidFixture = makeFixture();
    euidFixture.scenario.activeOverride = {
      bridge: { euid: process.geteuid!() + 1 },
    };
    expectRejectedFixture(euidFixture);

    const extraKeyFixture = makeFixture();
    extraKeyFixture.scenario.activeExtraKey = true;
    expectRejectedFixture(extraKeyFixture);

    const driftFixture = makeFixture();
    driftFixture.scenario.driftActive = true;
    expectRejectedFixture(driftFixture);
  });

  it("rejects current resolving below a nested release", () => {
    const fixture = makeFixture();
    const nested = join(fixture.release, "nested");
    makeDirectory(nested);
    copyFileSync(fixture.manifestPath, join(nested, "release-manifest.json"));
    chmodSync(join(nested, "release-manifest.json"), 0o600);
    unlinkSync(join(fixture.root, "current"));
    symlinkSync("releases/v1/nested", join(fixture.root, "current"));
    expectRejectedFixtureWithoutManifestRefresh(fixture);
  });
});
