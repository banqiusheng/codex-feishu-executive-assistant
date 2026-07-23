import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { beforeAll, describe, expect, it } from "vitest";

const nativeRoot = fileURLToPath(new URL("../native/", import.meta.url));
const failure = JSON.stringify({ ok: false, error: "GATEWAY_CLIENT_REJECTED" });

let runClient = "";

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

async function invokeClient(
  socketPath: string,
  input: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(runClient, [], {
      env: { ASSISTANT_GATEWAY_SOCKET: socketPath },
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
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

function buildRunClient(): string {
  const outputRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "assistant-gateway-native-")),
  );
  const output = join(outputRoot, "assistant-gateway");
  const result = spawnSync(
    "/bin/zsh",
    [resolve(nativeRoot, "run-client/build.sh"), output],
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
  expect(existsSync(output)).toBe(true);
  return output;
}

describe("native assistant-gateway clients", () => {
  it("provides a public run-client build entrypoint", () => {
    expect(existsSync(resolve(nativeRoot, "run-client/build.sh"))).toBe(true);
  });

  it("provides private control-client and peer-verifier build entrypoints", () => {
    expect(existsSync(resolve(nativeRoot, "control-client/build.sh"))).toBe(
      true,
    );
    expect(existsSync(resolve(nativeRoot, "peer-verifier/build.sh"))).toBe(
      true,
    );
  });

  it("builds and strictly verifies the public run client with the local CLT overlay", () => {
    expect(buildRunClient()).toBeTruthy();
  });

  beforeAll(() => {
    runClient = buildRunClient();
  });

  it("rejects additional argv without leaking diagnostics", () => {
    const result = spawnSync(runClient, ["unexpected"], {
      encoding: "utf8",
      input: "{}",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe(failure);
    expect(result.stderr).toBe("");
  });

  it("rejects a missing gateway socket", () => {
    const result = spawnSync(runClient, [], {
      encoding: "utf8",
      input: "{}",
      env: {},
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe(failure);
    expect(result.stderr).toBe("");
  });

  it.each(["[]", "true", "{}{}", "{", '{"x":"\\ud800"}'])(
    "rejects non-single-object stdin: %j",
    (input) => {
      const result = spawnSync(runClient, [], {
        encoding: "utf8",
        input,
        env: { ASSISTANT_GATEWAY_SOCKET: "/tmp/socket" },
      });

      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe(failure);
      expect(result.stderr).toBe("");
    },
  );

  it("sends one framed request, half-closes, and emits the matching framed response only", async () => {
    const root = mkdtempSync(join(tmpdir(), "assistant-gateway-uds-"));
    const socketPath = join(root, "gateway.sock");
    const requestId = randomUUID();
    const request = {
      version: 1,
      requestId,
      kind: "read",
      capability: "minutes.search",
      payload: {},
    };
    const response = {
      version: 1,
      requestId,
      ok: true,
      result: { state: "ready" },
    };
    const server = createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.once("end", () => {
        expect(Buffer.concat(chunks)).toEqual(frame(request));
        socket.end(frame(response));
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const result = await invokeClient(socketPath, JSON.stringify(request));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(result).toEqual({
      status: 0,
      stdout: JSON.stringify(response),
      stderr: "",
    });
  });

  it.each([
    ["truncated header", Buffer.from([0, 0, 0])],
    ["zero response length", Buffer.alloc(4)],
    ["oversized response length", Buffer.from([0, 16, 0, 1])],
    [
      "truncated response body",
      Buffer.concat([Buffer.from([0, 0, 0, 2]), Buffer.from("{")]),
    ],
    [
      "invalid utf8 response",
      Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from([0xff])]),
    ],
    ["non-object response", frame([])],
    [
      "extra response bytes",
      Buffer.concat([
        frame({ version: 1, requestId: "placeholder", ok: true, result: {} }),
        Buffer.from("x"),
      ]),
    ],
  ])(
    "rejects %s response without leaking diagnostics",
    async (_name, rawResponse) => {
      const root = mkdtempSync(join(tmpdir(), "assistant-gateway-response-"));
      const socketPath = join(root, "gateway.sock");
      const requestId = randomUUID();
      const request = {
        version: 1,
        requestId,
        kind: "read",
        capability: "minutes.search",
        payload: {},
      };
      const response = rawResponse.equals(
        frame({ version: 1, requestId: "placeholder", ok: true, result: {} }),
      )
        ? Buffer.concat([
            frame({ version: 1, requestId, ok: true, result: {} }),
            Buffer.from("x"),
          ])
        : rawResponse;
      const server = createServer((socket) => {
        socket.resume();
        socket.once("end", () => socket.end(response));
      });
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      const result = await invokeClient(socketPath, JSON.stringify(request));
      await new Promise<void>((resolve) => server.close(() => resolve()));

      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe(failure);
      expect(result.stderr).toBe("");
    },
  );

  it("rejects a response with another request id", async () => {
    const root = mkdtempSync(join(tmpdir(), "assistant-gateway-response-id-"));
    const socketPath = join(root, "gateway.sock");
    const request = {
      version: 1,
      requestId: randomUUID(),
      kind: "read",
      capability: "minutes.search",
      payload: {},
    };
    const server = createServer((socket) => {
      socket.resume();
      socket.once("end", () =>
        socket.end(
          frame({ version: 1, requestId: randomUUID(), ok: true, result: {} }),
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const result = await invokeClient(socketPath, JSON.stringify(request));
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe(failure);
    expect(result.stderr).toBe("");
  });
});
