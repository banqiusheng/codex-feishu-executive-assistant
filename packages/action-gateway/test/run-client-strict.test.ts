import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server, type Socket } from "node:net";
import { beforeAll, describe, expect, it } from "vitest";

const runClientRoot = fileURLToPath(
  new URL("../native/run-client/", import.meta.url),
);
const rejection = JSON.stringify({
  ok: false,
  error: "GATEWAY_CLIENT_REJECTED",
});

let runClient = "";

type Invocation = Readonly<{
  status: number | null;
  stdout: string;
  stderr: string;
}>;

function buildClient(sourceRoot = runClientRoot): string {
  const outputRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "assistant-run-client-build-")),
  );
  const output = join(outputRoot, "assistant-gateway");
  const result = spawnSync(
    "/bin/zsh",
    [resolve(sourceRoot, "build.sh"), output],
    {
      encoding: "utf8",
      env: {
        HOME: process.env.HOME ?? "/tmp",
        LANG: "C",
        LC_ALL: "C",
        PATH: "/usr/bin:/bin",
      },
    },
  );

  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(output)).toBe(true);
  return output;
}

function frameText(body: string): Buffer {
  const bytes = Buffer.from(body, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}

function validRequest(
  requestId: string = randomUUID(),
): Record<string, unknown> {
  return {
    version: 1,
    requestId,
    kind: "read",
    capability: "minutes.search",
    payload: {},
  };
}

function successResponse(requestId: string): string {
  return JSON.stringify({
    version: 1,
    requestId,
    ok: true,
    result: { state: "ready" },
  });
}

async function invoke(
  socketPath: string,
  input: string | Buffer,
  timeoutMs = 5_000,
): Promise<Invocation> {
  return await new Promise((resolveInvocation, rejectInvocation) => {
    const child = spawn(runClient, [], {
      env: { ASSISTANT_GATEWAY_SOCKET: socketPath },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectInvocation(new Error("run client test timed out"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectInvocation(error);
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      resolveInvocation({ status, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function invokeAgainstResponse(
  input: string,
  response: Buffer,
): Promise<Invocation> {
  const root = mkdtempSync(join(tmpdir(), "assistant-run-response-"));
  const socketPath = join(root, "gateway.sock");
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.resume();
    socket.once("end", () => socket.end(response));
  });
  await listen(server, socketPath);
  const result = await invoke(socketPath, input);
  await closeServer(server);
  return result;
}

async function expectRejectedBeforeConnect(
  input: string | Buffer,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "assistant-run-request-"));
  const socketPath = join(root, "gateway.sock");
  let connections = 0;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    connections += 1;
    socket.resume();
    socket.once("end", () => socket.end(frameText("{}")));
  });
  await listen(server, socketPath);
  const result = await invoke(socketPath, input);
  await closeServer(server);

  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe(rejection);
  expect(result.stderr).toBe("");
  expect(connections).toBe(0);
}

function nestedArray(depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}

describe("strict native public run client", () => {
  beforeAll(() => {
    const isolatedRoot = mkdtempSync(
      join(tmpdir(), "assistant-run-client-source-"),
    );
    const sourceRoot = join(isolatedRoot, "run-client");
    cpSync(runClientRoot, sourceRoot, { recursive: true });
    runClient = buildClient(sourceRoot);
  });

  it("builds from an isolated run-client source copy with a verified read-only executable", () => {
    const verification = spawnSync(
      "/usr/bin/codesign",
      ["--verify", "--strict", runClient],
      { encoding: "utf8" },
    );

    expect(verification.status, verification.stderr).toBe(0);
    expect(statSync(dirname(runClient)).mode & 0o7777).toBe(0o700);
    expect(statSync(dirname(runClient)).uid).toBe(process.getuid?.());
    expect(statSync(runClient).mode & 0o7777).toBe(0o555);
    expect(statSync(runClient).uid).toBe(process.getuid?.());
  });

  it.each([
    [
      "a duplicate top-level key",
      (id: string) =>
        `{"version":1,"requestId":"${id}","kind":"read","capability":"minutes.search","payload":{},"payload":{}}`,
    ],
    [
      "an escape-equivalent duplicate key",
      (id: string) =>
        `{"version":1,"requestId":"${id}","kind":"read","capability":"minutes.search","\\u0070ayload":{},"payload":{}}`,
    ],
    [
      "a nested duplicate key",
      (id: string) =>
        `{"version":1,"requestId":"${id}","kind":"read","capability":"minutes.search","payload":{"x":1,"x":2}}`,
    ],
    [
      "a lone surrogate",
      (id: string) =>
        `{"version":1,"requestId":"${id}","kind":"read","capability":"minutes.search","payload":{"x":"\\ud800"}}`,
    ],
    ["trailing JSON", (id: string) => `${JSON.stringify(validRequest(id))}{}`],
  ])("rejects %s before opening the socket", async (_name, inputFor) => {
    await expectRejectedBeforeConnect(inputFor(randomUUID()));
  });

  it("rejects fatal UTF-8 and oversized stdin before opening the socket", async () => {
    await expectRejectedBeforeConnect(Buffer.from([0x7b, 0xff, 0x7d]));
    await expectRejectedBeforeConnect(Buffer.alloc(1024 * 1024 + 1, 0x20));
  });

  it.each([
    ["version", 2],
    ["taskId", randomUUID()],
    ["identity", "user"],
    ["target", "another-chat"],
    ["path", "/tmp/out"],
    ["shell", "sh"],
    ["http", "https://example.com"],
  ])("rejects an unsupported or hidden %s field", async (field, value) => {
    await expectRejectedBeforeConnect(
      JSON.stringify({ ...validRequest(), [field]: value }),
    );
  });

  it.each([
    ["an invalid UUID", { requestId: "not-a-uuid" }],
    ["an unsupported kind", { kind: "shell" }],
    ["a non-object payload", { payload: [] }],
    ["an empty capability", { capability: "" }],
  ])("rejects %s before opening the socket", async (_name, override) => {
    await expectRejectedBeforeConnect(
      JSON.stringify({ ...validRequest(), ...override }),
    );
  });

  it("enforces JSON depth 64 at the request boundary", async () => {
    const acceptedId = randomUUID();
    const accepted = JSON.stringify({
      ...validRequest(acceptedId),
      payload: { value: nestedArray(61) },
    });
    const acceptedResult = await invokeAgainstResponse(
      accepted,
      frameText(successResponse(acceptedId)),
    );
    expect(acceptedResult).toEqual({
      status: 0,
      stdout: successResponse(acceptedId),
      stderr: "",
    });

    await expectRejectedBeforeConnect(
      JSON.stringify({
        ...validRequest(),
        payload: { value: nestedArray(62) },
      }),
    );
  });

  it("enforces the 10,000 JSON-node request limit", async () => {
    const acceptedId = randomUUID();
    const accepted = JSON.stringify({
      ...validRequest(acceptedId),
      payload: { items: Array.from({ length: 9_993 }, () => null) },
    });
    const acceptedResult = await invokeAgainstResponse(
      accepted,
      frameText(successResponse(acceptedId)),
    );
    expect(acceptedResult.status).toBe(0);

    await expectRejectedBeforeConnect(
      JSON.stringify({
        ...validRequest(),
        payload: { items: Array.from({ length: 9_994 }, () => null) },
      }),
    );
  });

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
      "unknown success field",
      (id: string) => ({
        version: 1,
        requestId: id,
        ok: true,
        result: null,
        debug: true,
      }),
    ],
    [
      "missing result",
      (id: string) => ({ version: 1, requestId: id, ok: true }),
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
      "hidden error field",
      (id: string) => ({
        version: 1,
        requestId: id,
        ok: false,
        error: { code: "HANDLER_FAILED", detail: "secret" },
      }),
    ],
    [
      "mismatched request id",
      () => ({
        version: 1,
        requestId: randomUUID(),
        ok: true,
        result: null,
      }),
    ],
  ])("rejects a response with %s", async (_name, responseFor) => {
    const requestId = randomUUID();
    const result = await invokeAgainstResponse(
      JSON.stringify(validRequest(requestId)),
      frameText(JSON.stringify(responseFor(requestId))),
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe(rejection);
    expect(result.stderr).toBe("");
  });

  it("rejects duplicate response keys after escape decoding", async () => {
    const requestId = randomUUID();
    const response = `{"version":1,"requestId":"${requestId}","ok":true,"result":{},"\\u0072esult":{}}`;
    const result = await invokeAgainstResponse(
      JSON.stringify(validRequest(requestId)),
      frameText(response),
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe(rejection);
    expect(result.stderr).toBe("");
  });

  const invalidResponseCases = [
    [
      "a trailing second frame",
      (id: string) => {
        const frame = frameText(successResponse(id));
        return Buffer.concat([frame, frame]);
      },
    ],
    [
      "a trailing response byte",
      (id: string) =>
        Buffer.concat([frameText(successResponse(id)), Buffer.from([0])]),
    ],
    ["a truncated response header", () => Buffer.from([0, 0, 0])],
    [
      "a truncated response body",
      (id: string) => frameText(successResponse(id)).subarray(0, -1),
    ],
    ["a zero response length", () => Buffer.alloc(4)],
    [
      "an oversized response length",
      () => {
        const header = Buffer.alloc(4);
        header.writeUInt32BE(1024 * 1024 + 1);
        return header;
      },
    ],
    ["fatal response UTF-8", () => Buffer.from([0, 0, 0, 1, 0xff])],
  ] satisfies ReadonlyArray<readonly [string, (requestId: string) => Buffer]>;

  it.each(invalidResponseCases)("rejects %s", async (_name, responseFor) => {
    const requestId = randomUUID();
    const response = responseFor(requestId);
    const result = await invokeAgainstResponse(
      JSON.stringify(validRequest(requestId)),
      response,
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe(rejection);
    expect(result.stderr).toBe("");
  });

  it("requires EOF after one complete response frame within the same deadline", async () => {
    const requestId = randomUUID();
    const root = mkdtempSync(join(tmpdir(), "assistant-run-no-eof-"));
    const socketPath = join(root, "gateway.sock");
    const sockets = new Set<Socket>();
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.resume();
      socket.once("end", () =>
        socket.write(frameText(successResponse(requestId))),
      );
    });
    await listen(server, socketPath);
    const started = Date.now();
    const result = await invoke(
      socketPath,
      JSON.stringify(validRequest(requestId)),
      4_000,
    );
    const elapsed = Date.now() - started;
    for (const socket of sockets) socket.destroy();
    await closeServer(server);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe(rejection);
    expect(result.stderr).toBe("");
    expect(elapsed).toBeLessThan(1_800);
  }, 8_000);

  it.each(["CAPABILITY_DENIED", "HANDLER_FAILED"])(
    "accepts the allowlisted %s error response",
    async (code) => {
      const requestId = randomUUID();
      const response = JSON.stringify({
        version: 1,
        requestId,
        ok: false,
        error: { code },
      });
      const result = await invokeAgainstResponse(
        JSON.stringify(validRequest(requestId)),
        frameText(response),
      );

      expect(result).toEqual({ status: 0, stdout: response, stderr: "" });
    },
  );

  it("times out a peer that never returns a response frame", async () => {
    const root = mkdtempSync(join(tmpdir(), "assistant-run-timeout-"));
    const socketPath = join(root, "gateway.sock");
    const sockets = new Set<Socket>();
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.resume();
    });
    await listen(server, socketPath);
    const started = Date.now();
    const result = await invoke(
      socketPath,
      JSON.stringify(validRequest()),
      4_000,
    );
    const elapsed = Date.now() - started;
    for (const socket of sockets) socket.destroy();
    await closeServer(server);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe(rejection);
    expect(result.stderr).toBe("");
    expect(elapsed).toBeLessThan(3_000);
  }, 8_000);

  it("uses one exchange deadline instead of resetting timeout per response byte", async () => {
    const root = mkdtempSync(join(tmpdir(), "assistant-run-trickle-"));
    const socketPath = join(root, "gateway.sock");
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      socket.on("error", () => undefined);
      socket.resume();
      socket.once("end", () => {
        const header = Buffer.alloc(4);
        header.writeUInt32BE(4);
        socket.write(header);
        const timer = setInterval(() => socket.write("x"), 600);
        socket.once("close", () => clearInterval(timer));
      });
    });
    await listen(server, socketPath);
    const started = Date.now();
    const result = await invoke(
      socketPath,
      JSON.stringify(validRequest()),
      4_000,
    );
    const elapsed = Date.now() - started;
    await closeServer(server);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe(rejection);
    expect(result.stderr).toBe("");
    expect(elapsed).toBeLessThan(1_800);
  }, 8_000);

  it("requires pending non-blocking connect completion and SO_ERROR confirmation", () => {
    const root = mkdtempSync(join(tmpdir(), "assistant-run-connect-seam-"));
    const overlay = join(root, "swift-vfs-overlay.yaml");
    const harness = join(root, "main.swift");
    const output = join(root, "connect-harness");
    writeFileSync(
      overlay,
      JSON.stringify({
        version: 0,
        "case-sensitive": "true",
        roots: [
          {
            type: "file",
            name: "/Library/Developer/CommandLineTools/usr/include/swift/bridging.modulemap",
            "external-contents": "/dev/null",
          },
        ],
      }),
    );
    writeFileSync(
      harness,
      String.raw`
import Darwin

var waits = 0
var reads = 0

do {
  try confirmNonblockingConnection(
    connectResult: 0,
    connectError: 0,
    waitUntilWritable: { waits += 100 },
    readSocketError: { reads += 100; return 0 }
  )
  guard waits == 0, reads == 0 else { exit(10) }
} catch {
  exit(11)
}

for pendingError in [EINPROGRESS, EAGAIN] {
  do {
    try confirmNonblockingConnection(
      connectResult: -1,
      connectError: pendingError,
      waitUntilWritable: { waits += 1 },
      readSocketError: { reads += 1; return 0 }
    )
  } catch {
    exit(20)
  }
}
guard waits == 2, reads == 2 else { exit(21) }

do {
  try confirmNonblockingConnection(
    connectResult: -1,
    connectError: EINPROGRESS,
    waitUntilWritable: {},
    readSocketError: { ECONNREFUSED }
  )
  exit(30)
} catch {}

do {
  try confirmNonblockingConnection(
    connectResult: -1,
    connectError: ECONNREFUSED,
    waitUntilWritable: { exit(31) },
    readSocketError: { exit(32) }
  )
  exit(33)
} catch {}

do {
  try confirmNonblockingConnection(
    connectResult: -1,
    connectError: EINPROGRESS,
    waitUntilWritable: { throw ClientFailure.rejected },
    readSocketError: { exit(40) }
  )
  exit(41)
} catch {}

exit(0)
`,
    );
    const compilation = spawnSync(
      "/usr/bin/xcrun",
      [
        "swiftc",
        "-vfsoverlay",
        overlay,
        resolve(runClientRoot, "Framing.swift"),
        harness,
        "-o",
        output,
      ],
      {
        encoding: "utf8",
        env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      },
    );
    expect(compilation.status, compilation.stderr).toBe(0);

    const result = spawnSync(output, [], { encoding: "utf8" });
    expect(result).toEqual(
      expect.objectContaining({ status: 0, stdout: "", stderr: "" }),
    );
  });

  it("exchanges one exact request and one exact response", async () => {
    const requestId = randomUUID();
    const request = validRequest(requestId);
    const response = successResponse(requestId);
    const root = mkdtempSync(join(tmpdir(), "assistant-run-happy-"));
    const socketPath = join(root, "gateway.sock");
    const received: Buffer[] = [];
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      socket.on("data", (chunk) => received.push(chunk));
      socket.once("end", () => socket.end(frameText(response)));
    });
    await listen(server, socketPath);
    const result = await invoke(socketPath, JSON.stringify(request));
    await closeServer(server);

    const raw = Buffer.concat(received);
    expect(raw.readUInt32BE(0)).toBe(raw.length - 4);
    expect(raw.subarray(4).toString("utf8")).toBe(JSON.stringify(request));
    expect(result).toEqual({ status: 0, stdout: response, stderr: "" });
  });
});
