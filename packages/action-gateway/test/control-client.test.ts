import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { beforeAll, describe, expect, it } from "vitest";

const nativeRoot = fileURLToPath(new URL("../native/", import.meta.url));
const failure = JSON.stringify({ ok: false, error: "GATEWAY_CLIENT_REJECTED" });
const releaseHash = `sha256:${"a".repeat(64)}`;
const parentPidVersion = 424242;

let productionControlClient = "";
let testingControlClient = "";
let nodeHash = "";
let nodeRequirement = "";
let controlHash = "";
let controlRequirement = "";

interface ParentSnapshot {
  pid: number;
  pidVersion: number;
  euid: number;
  executablePath: string;
  argv: string[];
}

interface Fixture {
  root: string;
  release: string;
  controlClient: string;
  nodePath: string;
  bridgePath: string;
  manifestPath: string;
  activePath: string;
  seamPath: string;
  socketPath: string;
  manifest: Record<string, unknown>;
  active: Record<string, unknown>;
  snapshots: ParentSnapshot[];
}

function sha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function designatedRequirement(path: string): string {
  const result = spawnSync("/usr/bin/codesign", ["-d", "-r-", path], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const diagnostics = `${result.stdout}${result.stderr}`;
  const match = diagnostics.match(/designated => (.+)$/m);
  expect(match, diagnostics).not.toBeNull();
  return match![1]!.trim();
}

function cloneExecutable(source: string, destination: string): void {
  const result = spawnSync("/bin/cp", ["-c", source, destination], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
}

function buildControlClient(testing: boolean): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "assistant-gateway-control-build-")),
  );
  const output = join(
    root,
    testing ? "assistant-gateway-control-testing" : "assistant-gateway-control",
  );
  const args = [resolve(nativeRoot, "control-client/build.sh"), output];
  if (testing) args.push("--testing");
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
  expect(existsSync(output)).toBe(true);
  expect(
    spawnSync("/usr/bin/codesign", ["--verify", "--strict", output]).status,
  ).toBe(0);
  return output;
}

function buildKernelProbe(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "assistant-gateway-kernel-probe-")),
  );
  const output = join(root, "parent-kernel-probe");
  const result = spawnSync(
    "/bin/zsh",
    [resolve(nativeRoot, "control-client/build.sh"), output, "--kernel-probe"],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        LANG: "C",
        LC_ALL: "C",
      },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(
    spawnSync("/usr/bin/codesign", ["--verify", "--strict", output]).status,
  ).toBe(0);
  return output;
}

function writeSecureJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function makeFixture(): Fixture {
  const root = realpathSync(mkdtempSync("/tmp/agc-runtime-"));
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
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }

  symlinkSync("releases/v1", join(root, "current"));
  const controlClient = join(privateBin, "assistant-gateway-control");
  const peerVerifier = join(privateBin, "assistant-gateway-peer-verifier");
  const nodePath = join(nodeBin, "node");
  const bridgePath = join(bridgeDir, "index.js");
  copyFileSync(testingControlClient, controlClient);
  copyFileSync(testingControlClient, peerVerifier);
  cloneExecutable(process.execPath, nodePath);
  writeFileSync(bridgePath, "export {};\n", { mode: 0o600 });
  chmodSync(controlClient, 0o500);
  chmodSync(peerVerifier, 0o500);
  chmodSync(nodePath, 0o500);
  chmodSync(bridgePath, 0o600);

  const manifest = {
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
        realPath: realpathSync(controlClient),
        sha256: controlHash,
        designatedRequirement: controlRequirement,
      },
      peerVerifier: {
        realPath: realpathSync(peerVerifier),
        sha256: controlHash,
        designatedRequirement: controlRequirement,
      },
    },
  };
  const active = {
    version: 1,
    releaseHash,
    bridge: {
      pid: process.pid,
      pidVersion: parentPidVersion,
      euid: process.geteuid!(),
      instanceId: randomUUID(),
    },
  };
  const snapshot = {
    pid: process.pid,
    pidVersion: parentPidVersion,
    euid: process.geteuid!(),
    executablePath: realpathSync(nodePath),
    argv: [realpathSync(nodePath), realpathSync(bridgePath)],
  };
  const snapshots = [snapshot, { ...snapshot, argv: [...snapshot.argv] }];
  const manifestPath = join(release, "release-manifest.json");
  const activePath = join(control, "active-instances.json");
  const seamPath = join(control, "testing-parent-snapshots.json");
  writeSecureJson(manifestPath, manifest);
  writeSecureJson(activePath, active);
  writeSecureJson(seamPath, { version: 1, reads: snapshots });

  return {
    root,
    release,
    controlClient,
    nodePath,
    bridgePath,
    manifestPath,
    activePath,
    seamPath,
    socketPath: join(control, "action-gateway.sock"),
    manifest,
    active,
    snapshots,
  };
}

function refreshFixture(fixture: Fixture): void {
  writeSecureJson(fixture.manifestPath, fixture.manifest);
  writeSecureJson(fixture.activePath, fixture.active);
  writeSecureJson(fixture.seamPath, { version: 1, reads: fixture.snapshots });
}

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function validControlRequest(
  requestId: string = randomUUID(),
): Record<string, unknown> {
  return {
    version: 1,
    requestId,
    operation: "gateway.status",
    payload: {},
  };
}

async function listen(
  socketPath: string,
  onConnection: (socket: Socket) => void,
  allowHalfOpen = false,
): Promise<Server> {
  const server = createServer({ allowHalfOpen }, onConnection);
  await new Promise<void>((resolveListen) =>
    server.listen(socketPath, resolveListen),
  );
  chmodSync(socketPath, 0o600);
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
}

async function invokeControl(
  fixture: Fixture,
  input: string | Buffer,
  runtimeRoot = fixture.root,
  killAfterMilliseconds?: number,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolveInvoke, reject) => {
    const child = spawn(fixture.controlClient, [], {
      env: { ASSISTANT_TEST_RUNTIME_ROOT: runtimeRoot },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const killTimer =
      killAfterMilliseconds === undefined
        ? undefined
        : setTimeout(() => child.kill("SIGKILL"), killAfterMilliseconds);
    child.once("error", (error) => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      reject(error);
    });
    child.once("close", (status) => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolveInvoke({ status, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function expectRejectedBeforeSocket(
  fixture: Fixture,
  input: string | Buffer = JSON.stringify(validControlRequest()),
  runtimeRoot = fixture.root,
): Promise<void> {
  let accepted = 0;
  const server = await listen(fixture.socketPath, (socket) => {
    accepted += 1;
    socket.destroy();
  });
  const result = await invokeControl(fixture, input, runtimeRoot);
  await closeServer(server);
  expect(accepted).toBe(0);
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe(failure);
  expect(result.stderr).toBe("");
}

describe("native private control client", () => {
  beforeAll(() => {
    productionControlClient = buildControlClient(false);
    testingControlClient = buildControlClient(true);
    nodeHash = sha256(process.execPath);
    nodeRequirement = designatedRequirement(process.execPath);
    controlHash = sha256(testingControlClient);
    controlRequirement = designatedRequirement(testingControlClient);
  });

  it("keeps the production binary isolated from the test runtime root", () => {
    const fixture = makeFixture();
    const result = spawnSync(productionControlClient, [], {
      encoding: "utf8",
      input: JSON.stringify(validControlRequest()),
      env: { ASSISTANT_TEST_RUNTIME_ROOT: fixture.root },
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe(failure);
    expect(result.stderr).toBe("");
  });

  it("authenticates the stable parent and performs one real framed UDS exchange", async () => {
    const fixture = makeFixture();
    const request = validControlRequest();
    const response = {
      version: 1,
      requestId: request.requestId,
      ok: true,
      result: { state: "ready" },
    };
    let accepted = 0;
    const server = await listen(fixture.socketPath, (socket) => {
      accepted += 1;
      const chunks: Buffer[] = [];
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.once("end", () => {
        expect(Buffer.concat(chunks)).toEqual(frame(request));
        socket.end(frame(response));
      });
    });

    const result = await invokeControl(fixture, JSON.stringify(request));
    await closeServer(server);
    expect(accepted).toBe(1);
    expect(result).toEqual({
      status: 0,
      stdout: JSON.stringify(response),
      stderr: "",
    });
  }, 30_000);

  it.each([
    [
      "missing version",
      (id: string) => ({
        requestId: id,
        operation: "gateway.status",
        payload: {},
      }),
    ],
    [
      "wrong version",
      (id: string) => ({
        version: 2,
        requestId: id,
        operation: "gateway.status",
        payload: {},
      }),
    ],
    [
      "boolean version",
      (id: string) => ({
        version: true,
        requestId: id,
        operation: "gateway.status",
        payload: {},
      }),
    ],
    [
      "missing operation",
      (id: string) => ({ version: 1, requestId: id, payload: {} }),
    ],
    [
      "legacy run fields",
      (id: string) => ({
        version: 1,
        requestId: id,
        kind: "control",
        capability: "gateway.status",
        payload: {},
      }),
    ],
    [
      "extra field",
      (id: string) => ({ ...validControlRequest(id), targetChat: "forbidden" }),
    ],
    [
      "array payload",
      (id: string) => ({
        version: 1,
        requestId: id,
        operation: "gateway.status",
        payload: [],
      }),
    ],
    [
      "empty operation",
      (id: string) => ({
        version: 1,
        requestId: id,
        operation: "",
        payload: {},
      }),
    ],
    [
      "control character operation",
      (id: string) => ({
        version: 1,
        requestId: id,
        operation: "gateway\u0001status",
        payload: {},
      }),
    ],
    [
      "oversized operation",
      (id: string) => ({
        version: 1,
        requestId: id,
        operation: "x".repeat(257),
        payload: {},
      }),
    ],
    [
      "invalid request id",
      () => ({
        version: 1,
        requestId: "not-a-uuid",
        operation: "gateway.status",
        payload: {},
      }),
    ],
  ])(
    "rejects a control request with %s before connecting",
    async (_name, requestFor) => {
      const fixture = makeFixture();
      await expectRejectedBeforeSocket(
        fixture,
        JSON.stringify(requestFor(randomUUID())),
      );
    },
    30_000,
  );

  it("rejects a mismatched parent lease before opening the control socket", async () => {
    const fixture = makeFixture();
    (fixture.active.bridge as { pid: number }).pid += 1;
    refreshFixture(fixture);
    let accepted = 0;
    const server = await listen(fixture.socketPath, () => {
      accepted += 1;
    });

    const result = await invokeControl(
      fixture,
      JSON.stringify(validControlRequest()),
    );
    await closeServer(server);
    expect(accepted).toBe(0);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe(failure);
    expect(result.stderr).toBe("");
  }, 30_000);

  it("rejects a mismatched parent pidversion before opening the control socket", async () => {
    const fixture = makeFixture();
    (fixture.active.bridge as { pidVersion: number }).pidVersion += 1;
    refreshFixture(fixture);
    await expectRejectedBeforeSocket(fixture);
  }, 30_000);

  it("rejects a mismatched parent euid before opening the control socket", async () => {
    const fixture = makeFixture();
    (fixture.active.bridge as { euid: number }).euid += 1;
    refreshFixture(fixture);
    await expectRejectedBeforeSocket(fixture);
  }, 30_000);

  it("rejects parent identity drift between the two kernel reads", async () => {
    const fixture = makeFixture();
    fixture.snapshots[1] = {
      ...fixture.snapshots[1]!,
      pidVersion: parentPidVersion + 1,
    };
    refreshFixture(fixture);
    await expectRejectedBeforeSocket(fixture);
  }, 30_000);

  it("rejects a parent whose strict argv[1] is not the manifest bridge entry", async () => {
    const fixture = makeFixture();
    fixture.snapshots = fixture.snapshots.map((snapshot) => ({
      ...snapshot,
      argv: [snapshot.argv[0]!, join(fixture.release, "bridge", "wrong.js")],
    }));
    refreshFixture(fixture);
    await expectRejectedBeforeSocket(fixture);
  }, 30_000);

  it("rejects current when it resolves below a nested release directory", async () => {
    const fixture = makeFixture();
    const nested = join(fixture.release, "nested");
    mkdirSync(nested, { mode: 0o700 });
    chmodSync(nested, 0o700);
    writeSecureJson(join(nested, "release-manifest.json"), fixture.manifest);
    unlinkSync(join(fixture.root, "current"));
    symlinkSync("releases/v1/nested", join(fixture.root, "current"));
    await expectRejectedBeforeSocket(fixture);
  }, 30_000);

  it("rejects non-canonical and intermediate-symlink runtime roots", async () => {
    const fixture = makeFixture();
    const detour = join(dirname(fixture.root), `agc-detour-${randomUUID()}`);
    mkdirSync(detour, { mode: 0o700 });
    chmodSync(detour, 0o700);
    const nonCanonicalRoot = `${detour}/../${basename(fixture.root)}`;
    await expectRejectedBeforeSocket(
      fixture,
      JSON.stringify(validControlRequest()),
      nonCanonicalRoot,
    );

    const aliasRoot = mkdtempSync("/tmp/agc-root-alias-");
    const intermediate = join(aliasRoot, "parent-link");
    symlinkSync(dirname(fixture.root), intermediate);
    const symlinkComponentRoot = join(intermediate, basename(fixture.root));
    await expectRejectedBeforeSocket(
      fixture,
      JSON.stringify(validControlRequest()),
      symlinkComponentRoot,
    );
  }, 60_000);

  it("rejects a manifest realPath that escapes the selected release", async () => {
    const fixture = makeFixture();
    const escapedBridge = join(fixture.root, "control", "escaped-bridge.js");
    writeFileSync(escapedBridge, "export {};\n", { mode: 0o600 });
    chmodSync(escapedBridge, 0o600);
    (
      fixture.manifest.bridge as { entryRealPath: string; sha256: string }
    ).entryRealPath = realpathSync(escapedBridge);
    (
      fixture.manifest.bridge as { entryRealPath: string; sha256: string }
    ).sha256 = sha256(escapedBridge);
    refreshFixture(fixture);
    await expectRejectedBeforeSocket(fixture);
  }, 30_000);

  it("rejects a node whose designated requirement does not validate", async () => {
    const fixture = makeFixture();
    (
      fixture.manifest.node as { designatedRequirement: string }
    ).designatedRequirement = "identifier definitely-wrong";
    refreshFixture(fixture);
    await expectRejectedBeforeSocket(fixture);
  }, 30_000);

  it("rejects a control binary hash mismatch", async () => {
    const fixture = makeFixture();
    const binaries = fixture.manifest.binaries as {
      controlClient: { sha256: string };
    };
    binaries.controlClient.sha256 = `sha256:${"0".repeat(64)}`;
    refreshFixture(fixture);
    await expectRejectedBeforeSocket(fixture);
  }, 30_000);

  it("rejects a peer-verifier binary hash mismatch", async () => {
    const fixture = makeFixture();
    const binaries = fixture.manifest.binaries as {
      peerVerifier: { sha256: string };
    };
    binaries.peerVerifier.sha256 = `sha256:${"0".repeat(64)}`;
    refreshFixture(fixture);
    await expectRejectedBeforeSocket(fixture);
  }, 30_000);

  it("rejects insecure manifest, active-state, or release permissions", async () => {
    for (const insecurePath of ["manifest", "active", "release"] as const) {
      const fixture = makeFixture();
      if (insecurePath === "manifest") chmodSync(fixture.manifestPath, 0o644);
      if (insecurePath === "active") chmodSync(fixture.activePath, 0o644);
      if (insecurePath === "release") chmodSync(fixture.release, 0o755);
      await expectRejectedBeforeSocket(fixture);
    }
  }, 60_000);

  it("rejects duplicate keys in the release manifest", async () => {
    const fixture = makeFixture();
    const manifest = JSON.stringify(fixture.manifest).replace(
      `"releaseHash":"${releaseHash}"`,
      `"releaseHash":"${releaseHash}","releaseHash":"${releaseHash}"`,
    );
    writeFileSync(fixture.manifestPath, manifest, { mode: 0o600 });
    chmodSync(fixture.manifestPath, 0o600);
    await expectRejectedBeforeSocket(fixture);
  }, 30_000);

  it("rejects duplicate keys in the active state", async () => {
    const fixture = makeFixture();
    const active = JSON.stringify(fixture.active).replace(
      `"releaseHash":"${releaseHash}"`,
      `"releaseHash":"${releaseHash}","releaseHash":"${releaseHash}"`,
    );
    writeFileSync(fixture.activePath, active, { mode: 0o600 });
    chmodSync(fixture.activePath, 0o600);
    await expectRejectedBeforeSocket(fixture);
  }, 30_000);

  it.each(["manifest", "active"] as const)(
    "rejects oversized %s metadata before opening the control socket",
    async (kind) => {
      const fixture = makeFixture();
      const path =
        kind === "manifest" ? fixture.manifestPath : fixture.activePath;
      truncateSync(path, 1024 * 1024 + 1);
      chmodSync(path, 0o600);
      await expectRejectedBeforeSocket(fixture);
    },
    30_000,
  );

  it.each([
    ["empty input", ""],
    ["non-object input", "[]"],
    ["trailing JSON input", "{}{}"],
    ["invalid UTF-8 input", Buffer.from([0xff])],
    ["oversized input", Buffer.alloc(1024 * 1024 + 1, 0x61)],
  ])(
    "rejects %s before opening the control socket",
    async (_name, input) => {
      const fixture = makeFixture();
      await expectRejectedBeforeSocket(fixture, input);
    },
    30_000,
  );

  it("rejects duplicate JSON object keys before opening the control socket", async () => {
    const fixture = makeFixture();
    const requestId = randomUUID();
    await expectRejectedBeforeSocket(
      fixture,
      `{"requestId":"${requestId}","requestId":"${requestId}"}`,
    );
  }, 30_000);

  it("rejects additional argv with fixed stdout and empty stderr", () => {
    const fixture = makeFixture();
    const result = spawnSync(fixture.controlClient, ["unexpected"], {
      encoding: "utf8",
      input: JSON.stringify(validControlRequest()),
      env: { ASSISTANT_TEST_RUNTIME_ROOT: fixture.root },
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe(failure);
    expect(result.stderr).toBe("");
  });

  it("rejects malformed, extra, mismatched, or duplicate-key response frames", async () => {
    const cases = [
      () => Buffer.from([0, 0, 0]),
      () => Buffer.from([0, 16, 0, 1]),
      () => Buffer.concat([Buffer.from([0, 0, 0, 2]), Buffer.from("{")]),
      (requestId: string) =>
        Buffer.concat([frame({ requestId, ok: true }), Buffer.from("x")]),
      () => frame({ requestId: randomUUID(), ok: true }),
      (requestId: string) => {
        const body = Buffer.from(
          `{"requestId":"${requestId}","requestId":"${requestId}","ok":true}`,
        );
        const header = Buffer.alloc(4);
        header.writeUInt32BE(body.length);
        return Buffer.concat([header, body]);
      },
    ];

    for (const makeResponse of cases) {
      const fixture = makeFixture();
      const requestId = randomUUID();
      const server = await listen(fixture.socketPath, (socket) => {
        socket.resume();
        socket.once("end", () => socket.end(makeResponse(requestId)));
      });
      const result = await invokeControl(
        fixture,
        JSON.stringify(validControlRequest(requestId)),
      );
      await closeServer(server);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe(failure);
      expect(result.stderr).toBe("");
    }
  }, 120_000);

  it.each([
    [
      "missing version",
      (id: string) => ({ requestId: id, ok: true, result: null }),
    ],
    [
      "wrong version",
      (id: string) => ({ version: 2, requestId: id, ok: true, result: null }),
    ],
    [
      "non-boolean ok",
      (id: string) => ({ version: 1, requestId: id, ok: 1, result: null }),
    ],
    [
      "missing result",
      (id: string) => ({ version: 1, requestId: id, ok: true }),
    ],
    [
      "extra success field",
      (id: string) => ({
        version: 1,
        requestId: id,
        ok: true,
        result: null,
        debug: true,
      }),
    ],
    [
      "mixed result and error",
      (id: string) => ({
        version: 1,
        requestId: id,
        ok: true,
        result: null,
        error: { code: "HANDLER_FAILED" },
      }),
    ],
    [
      "unknown error code",
      (id: string) => ({
        version: 1,
        requestId: id,
        ok: false,
        error: { code: "INTERNAL_ERROR" },
      }),
    ],
    [
      "extra error field",
      (id: string) => ({
        version: 1,
        requestId: id,
        ok: false,
        error: { code: "HANDLER_FAILED", detail: "secret" },
      }),
    ],
  ])(
    "rejects a control response with %s",
    async (_name, responseFor) => {
      const fixture = makeFixture();
      const requestId = randomUUID();
      const server = await listen(fixture.socketPath, (socket) => {
        socket.resume();
        socket.once("end", () => socket.end(frame(responseFor(requestId))));
      });
      const result = await invokeControl(
        fixture,
        JSON.stringify(validControlRequest(requestId)),
      );
      await closeServer(server);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe(failure);
      expect(result.stderr).toBe("");
    },
    30_000,
  );

  it.each(["CAPABILITY_DENIED", "HANDLER_FAILED"])(
    "accepts the allowlisted %s control error response",
    async (code) => {
      const fixture = makeFixture();
      const requestId = randomUUID();
      const response = { version: 1, requestId, ok: false, error: { code } };
      const server = await listen(fixture.socketPath, (socket) => {
        socket.resume();
        socket.once("end", () => socket.end(frame(response)));
      });
      const result = await invokeControl(
        fixture,
        JSON.stringify(validControlRequest(requestId)),
      );
      await closeServer(server);
      expect(result).toEqual({
        status: 0,
        stdout: JSON.stringify(response),
        stderr: "",
      });
    },
    30_000,
  );

  it("converts an immediate peer close into the fixed failure envelope", async () => {
    const fixture = makeFixture();
    const server = await listen(fixture.socketPath, (socket) =>
      socket.destroy(),
    );
    const result = await invokeControl(
      fixture,
      JSON.stringify(validControlRequest()),
    );
    await closeServer(server);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe(failure);
    expect(result.stderr).toBe("");
  }, 30_000);

  it("rejects an insecure control socket before connecting", async () => {
    const fixture = makeFixture();
    let accepted = 0;
    const server = await listen(fixture.socketPath, (socket) => {
      accepted += 1;
      socket.destroy();
    });
    chmodSync(fixture.socketPath, 0o644);
    const result = await invokeControl(
      fixture,
      JSON.stringify(validControlRequest()),
    );
    await closeServer(server);
    expect(accepted).toBe(0);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe(failure);
    expect(result.stderr).toBe("");
  }, 30_000);

  it("times out a control peer that never returns a response", async () => {
    const fixture = makeFixture();
    const sockets = new Set<Socket>();
    const server = await listen(fixture.socketPath, (socket) => {
      sockets.add(socket);
      socket.resume();
      socket.on("close", () => sockets.delete(socket));
    });
    const result = await invokeControl(
      fixture,
      JSON.stringify(validControlRequest()),
    );
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe(failure);
    expect(result.stderr).toBe("");
  }, 30_000);

  it("uses one deadline while a control peer trickles a response", async () => {
    const fixture = makeFixture();
    const requestId = randomUUID();
    const response = frame({
      version: 1,
      requestId,
      ok: true,
      result: { state: "ready" },
    });
    const sockets = new Set<Socket>();
    let connectedAt = 0;
    let closedAt = 0;
    const server = await listen(
      fixture.socketPath,
      (socket) => {
        connectedAt = Date.now();
        sockets.add(socket);
        socket.on("error", () => undefined);
        socket.resume();
        socket.once("end", () => {
          let offset = 0;
          const timer = setInterval(() => {
            if (offset === response.length) {
              clearInterval(timer);
              socket.end();
              return;
            }
            socket.write(response.subarray(offset, offset + 1));
            offset += 1;
          }, 30);
          socket.once("close", () => clearInterval(timer));
        });
        socket.once("close", () => {
          closedAt = Date.now();
          sockets.delete(socket);
        });
      },
      true,
    );

    const result = await invokeControl(
      fixture,
      JSON.stringify(validControlRequest(requestId)),
    );
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe(failure);
    expect(result.stderr).toBe("");
    expect(connectedAt).toBeGreaterThan(0);
    expect(closedAt - connectedAt).toBeLessThan(1_800);
  }, 30_000);

  it("bounds a pending control-socket connect with the shared deadline", async () => {
    const fixture = makeFixture();
    const listener = spawn(
      "/usr/bin/python3",
      [
        "-c",
        [
          "import os, socket, sys, time",
          "server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
          "server.bind(sys.argv[1])",
          "os.chmod(sys.argv[1], 0o600)",
          "server.listen(0)",
          'print("READY", flush=True)',
          "time.sleep(30)",
        ].join("\n"),
        fixture.socketPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise<void>((resolveReady, rejectReady) => {
      listener.stdout.setEncoding("utf8");
      listener.stdout.once("data", (chunk: string) => {
        if (chunk.includes("READY")) resolveReady();
        else rejectReady(new Error(`unexpected listener output: ${chunk}`));
      });
      listener.once("error", rejectReady);
      listener.once("close", (status) =>
        rejectReady(
          new Error(`listener exited before ready: ${String(status)}`),
        ),
      );
    });

    let connectedFillers = 0;
    const fillers = Array.from({ length: 32 }, () => {
      const filler = createConnection(fixture.socketPath);
      filler.once("connect", () => {
        connectedFillers += 1;
      });
      filler.on("error", () => undefined);
      return filler;
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    expect(connectedFillers).toBeGreaterThan(0);

    const result = await invokeControl(
      fixture,
      JSON.stringify(validControlRequest()),
      fixture.root,
      8_000,
    );
    for (const filler of fillers) filler.destroy();
    listener.kill("SIGTERM");
    await new Promise<void>((resolveClose) =>
      listener.once("close", () => resolveClose()),
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe(failure);
    expect(result.stderr).toBe("");
  }, 30_000);
});

describe("native parent kernel probe", () => {
  it("reads a real stable parent pidversion and strict KERN_PROCARGS2 argv", () => {
    const probe = buildKernelProbe();
    const wrapperRoot = mkdtempSync(
      join(tmpdir(), "assistant-gateway-kernel-parent-"),
    );
    const wrapper = join(wrapperRoot, "parent.mjs");
    writeFileSync(
      wrapper,
      [
        'import { spawnSync } from "node:child_process";',
        'const result = spawnSync(process.argv[2], [], { encoding: "utf8", env: {} });',
        "if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status ?? 2); }",
        "process.stdout.write(JSON.stringify({ wrapperPid: process.pid, snapshot: JSON.parse(result.stdout) }));",
      ].join("\n"),
    );
    const result = spawnSync(process.execPath, [wrapper, probe], {
      encoding: "utf8",
      env: {},
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as {
      wrapperPid: number;
      snapshot: ParentSnapshot;
    };
    const snapshot = output.snapshot;
    expect(snapshot.pid).toBe(output.wrapperPid);
    expect(snapshot.pidVersion).toBeGreaterThan(0);
    expect(snapshot.euid).toBe(process.geteuid!());
    expect(snapshot.executablePath).toBe(realpathSync(process.execPath));
    expect(snapshot.argv.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.argv[0]).toBe(process.execPath);
    expect(snapshot.argv[1]).toBe(wrapper);
  }, 30_000);
});
