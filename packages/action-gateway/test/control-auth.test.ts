import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { sendGatewayRequest } from "../src/client.js";
import {
  createNativePeerAuthenticator,
  startControlServer as startProductionControlServer,
  startControlServerAtPathForTesting as startControlServer,
} from "../src/ipc/control-server.js";
import { createGatewayRouteRegistry } from "../src/ipc/schemas.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "assistant-control-auth-"));
  roots.push(root);
  await chmod(root, 0o700);
  const control = join(root, "control");
  await mkdir(control, { mode: 0o700 });
  return { socketPath: join(control, "action-gateway.sock") };
}

async function peerVerifierFixture(): Promise<string> {
  const createdRoot = await mkdtemp(join(tmpdir(), "assistant-peer-helper-"));
  roots.push(createdRoot);
  await chmod(createdRoot, 0o700);
  const root = await realpath(createdRoot);
  const helperPath = join(root, "assistant-gateway-peer-verifier");
  await writeFile(helperPath, "fixture", { mode: 0o500 });
  await chmod(helperPath, 0o500);
  return helperPath;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("control peer authentication", () => {
  it("requires the production peer verifier to have exact mode 0500", async () => {
    const helperPath = await peerVerifierFixture();
    expect(() => createNativePeerAuthenticator({ helperPath })).not.toThrow();

    for (const mode of [0o400, 0o511, 0o555, 0o700, 0o755, 0o4500]) {
      await chmod(helperPath, mode);
      expect(() => createNativePeerAuthenticator({ helperPath })).toThrow(
        "Native peer verifier startup validation failed",
      );
    }
  });

  it("treats the optional startup verifier as an additional strict check", async () => {
    const helperPath = await peerVerifierFixture();
    const extension = vi.fn(() => true);

    await chmod(helperPath, 0o555);
    expect(() =>
      createNativePeerAuthenticator({
        helperPath,
        verifyHelperAtStartup: extension,
      }),
    ).toThrow("Native peer verifier startup validation failed");
    expect(extension).not.toHaveBeenCalled();

    await chmod(helperPath, 0o500);
    expect(() =>
      createNativePeerAuthenticator({
        helperPath,
        verifyHelperAtStartup: extension,
      }),
    ).not.toThrow();
    expect(() =>
      createNativePeerAuthenticator({
        helperPath,
        verifyHelperAtStartup: () => false,
      }),
    ).toThrow("Native peer verifier startup validation failed");
    expect(() =>
      createNativePeerAuthenticator({
        helperPath,
        verifyHelperAtStartup: () => "true" as never,
      }),
    ).toThrow("Native peer verifier startup validation failed");
    expect(() =>
      createNativePeerAuthenticator({
        helperPath: join(helperPath, "missing"),
        verifyHelperAtStartup: () => true,
      }),
    ).toThrow("Native peer verifier startup validation failed");
  });

  it("does not let the production API override the fixed control socket path", () => {
    expect(() =>
      startProductionControlServer({
        socketPath: "/tmp/untrusted-control.sock",
        context: {
          channel: "control",
          bridgeInstanceId: randomUUID(),
          releaseHash: `sha256:${"a".repeat(64)}`,
        },
        authenticatePeer: async () => true,
        revalidateActiveBridge: async () => true,
      } as never),
    ).toThrow();
  });

  it("does not parse bytes until peer authentication and active-state revalidation pass", async () => {
    const files = await fixture();
    let releaseAuth: ((value: boolean) => void) | undefined;
    const auth = new Promise<boolean>((resolve) => {
      releaseAuth = resolve;
    });
    const parser = vi.fn((value) => value);
    const handler = vi.fn(async () => ({ state: "ready" }));
    const revalidate = vi.fn(async () => true);
    const handle = await startControlServer({
      socketPath: files.socketPath,
      context: {
        channel: "control",
        bridgeInstanceId: randomUUID(),
        releaseHash: `sha256:${"a".repeat(64)}`,
      },
      registry: createGatewayRouteRegistry([
        {
          channel: "control",
          kind: "control",
          capability: "gateway.status",
          parsePayload: parser,
          handler,
        },
      ]),
      authenticatePeer: () => auth,
      revalidateActiveBridge: revalidate,
    });
    const requestId = randomUUID();
    const pending = sendGatewayRequest(files.socketPath, {
      version: 1,
      requestId,
      operation: "gateway.status",
      payload: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(parser).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    releaseAuth?.(true);
    await expect(pending).resolves.toEqual({
      version: 1,
      requestId,
      ok: true,
      result: { state: "ready" },
    });
    expect(revalidate).toHaveBeenCalledOnce();
    await handle.close();
  });

  it.each([
    ["peer rejection", async () => false, async () => true],
    ["active bridge drift", async () => true, async () => false],
    [
      "peer verifier failure",
      async () => Promise.reject(new Error("secret verifier failure")),
      async () => true,
    ],
  ])(
    "closes silently on %s before parser or handler",
    async (_name, authenticatePeer, revalidate) => {
      const files = await fixture();
      const parser = vi.fn((value) => value);
      const handler = vi.fn(async () => ({ state: "ready" }));
      const handle = await startControlServer({
        socketPath: files.socketPath,
        context: {
          channel: "control",
          bridgeInstanceId: randomUUID(),
          releaseHash: `sha256:${"a".repeat(64)}`,
        },
        registry: createGatewayRouteRegistry([
          {
            channel: "control",
            kind: "control",
            capability: "gateway.status",
            parsePayload: parser,
            handler,
          },
        ]),
        authenticatePeer,
        revalidateActiveBridge: revalidate,
      });
      await expect(
        sendGatewayRequest(files.socketPath, {
          version: 1,
          requestId: randomUUID(),
          operation: "gateway.status",
          payload: {},
        }),
      ).rejects.toThrow();
      expect(parser).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      await handle.close();
    },
  );

  it("defaults to an empty control registry", async () => {
    const files = await fixture();
    const handle = await startControlServer({
      socketPath: files.socketPath,
      context: {
        channel: "control",
        bridgeInstanceId: randomUUID(),
        releaseHash: `sha256:${"a".repeat(64)}`,
      },
      authenticatePeer: async () => true,
      revalidateActiveBridge: async () => true,
    });
    const requestId = randomUUID();
    await expect(
      sendGatewayRequest(files.socketPath, {
        version: 1,
        requestId,
        operation: "gateway.status",
        payload: {},
      }),
    ).resolves.toEqual({
      version: 1,
      requestId,
      ok: false,
      error: { code: "CAPABILITY_DENIED" },
    });
    await handle.close();
  });

  it("keeps the startup-verified helper path immutable", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    const spawn = vi.fn(() => child as never);
    const verifiedHelperPath = await peerVerifierFixture();
    const mutable = {
      helperPath: verifiedHelperPath,
      verifyHelperAtStartup: vi.fn(() => true),
      spawn,
    };
    const authenticate = createNativePeerAuthenticator(mutable);
    mutable.helperPath = "/tmp/replaced-after-verification";
    const pending = authenticate(new Socket());
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);

    await expect(pending).resolves.toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      verifiedHelperPath,
      [],
      expect.objectContaining({ shell: false }),
    );
  });

  it("fails closed when the verifier child errors without a close event", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    const verifiedHelperPath = await peerVerifierFixture();
    const authenticate = createNativePeerAuthenticator({
      helperPath: verifiedHelperPath,
      verifyHelperAtStartup: () => true,
      timeoutMs: 20,
      spawn: () => child as never,
    });
    const pending = authenticate(new Socket());
    child.emit("error", new Error("spawn failed"));

    await expect(
      Promise.race([
        pending,
        new Promise<boolean | "hung">((resolve) =>
          setTimeout(() => resolve("hung"), 75),
        ),
      ]),
    ).resolves.toBe(false);
  });

  it("keeps peer and active-state verifiers immutable after startup", async () => {
    const files = await fixture();
    const handler = vi.fn(async () => ({ state: "ready" }));
    const options = {
      socketPath: files.socketPath,
      context: {
        channel: "control" as const,
        bridgeInstanceId: randomUUID(),
        releaseHash: `sha256:${"a".repeat(64)}`,
      },
      registry: createGatewayRouteRegistry([
        {
          channel: "control" as const,
          kind: "control" as const,
          capability: "gateway.status",
          parsePayload: (value: unknown) => value,
          handler,
        },
      ]),
      authenticatePeer: async () => false,
      revalidateActiveBridge: async () => false,
    };
    const handle = await startControlServer(options);
    options.authenticatePeer = async () => true;
    options.revalidateActiveBridge = async () => true;

    await expect(
      sendGatewayRequest(files.socketPath, {
        version: 1,
        requestId: randomUUID(),
        operation: "gateway.status",
        payload: {},
      }),
    ).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
    await handle.close();
  });
});
