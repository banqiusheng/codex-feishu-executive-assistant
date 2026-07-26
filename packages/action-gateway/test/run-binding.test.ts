import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { sendGatewayRequest } from "../src/client.js";
import { encodeFrame } from "../src/ipc/framing.js";
import { createGatewayRouteRegistry } from "../src/ipc/schemas.js";
import { startRunServer } from "../src/ipc/run-server.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "assistant-run-binding-"));
  roots.push(root);
  await chmod(root, 0o700);
  const taskId = randomUUID();
  const workspace = join(root, taskId);
  await mkdir(workspace, { mode: 0o700 });
  return { taskId, workspace, socketPath: join(workspace, "gateway.sock") };
}

function fakeStore(taskId: string, workspacePath: string) {
  return {
    getTask: vi.fn(() => ({
      id: taskId,
      workspacePath,
      state: "RUNNING" as const,
    })),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("task-bound run sockets", () => {
  it("binds handler identity to an immutable server context", async () => {
    const files = await fixture();
    const observed = vi.fn(async (context) => ({
      taskId: context.taskId,
      chatId: context.presidentChatId,
    }));
    const registry = createGatewayRouteRegistry([
      {
        channel: "run",
        kind: "read",
        capability: "minutes.search",
        parsePayload: (value) => value,
        handler: observed,
      },
    ]);
    const mutableContext = {
      channel: "run" as const,
      taskId: files.taskId,
      presidentOpenId: "ou_president",
      presidentChatId: "oc_private",
      capabilities: ["minutes.search"],
    };
    const handle = await startRunServer({
      socketPath: files.socketPath,
      context: mutableContext,
      jobStore: fakeStore(files.taskId, files.workspace),
      registry,
      waitUntilTaskActionsSafe: async () => undefined,
    });
    mutableContext.presidentChatId = "oc_attacker";
    mutableContext.capabilities.splice(0, 1, "http.fetch");
    const requestId = randomUUID();
    const response = await sendGatewayRequest(files.socketPath, {
      version: 1,
      requestId,
      kind: "read",
      capability: "minutes.search",
      payload: {},
    });
    expect(response).toEqual({
      version: 1,
      requestId,
      ok: true,
      result: { taskId: files.taskId, chatId: "oc_private" },
    });
    expect(observed).toHaveBeenCalledOnce();
    expect(Object.isFrozen(observed.mock.calls[0]?.[0])).toBe(true);
    await handle.close();
  });

  it.each([
    { taskId: randomUUID() },
    { identity: "user" },
    { targetChatId: "oc_other" },
    { socketPath: "/tmp/other.sock" },
  ])(
    "rejects caller-supplied binding field %o before the handler",
    async (extra) => {
      const files = await fixture();
      const handler = vi.fn(async () => ({ ok: true }));
      const handle = await startRunServer({
        socketPath: files.socketPath,
        context: {
          channel: "run",
          taskId: files.taskId,
          presidentOpenId: "ou_president",
          presidentChatId: "oc_private",
          capabilities: ["minutes.search"],
        },
        jobStore: fakeStore(files.taskId, files.workspace),
        registry: createGatewayRouteRegistry([
          {
            channel: "run",
            kind: "read",
            capability: "minutes.search",
            parsePayload: (value) => value,
            handler,
          },
        ]),
        waitUntilTaskActionsSafe: async () => undefined,
      });
      await expect(
        sendGatewayRequest(files.socketPath, {
          version: 1,
          requestId: randomUUID(),
          kind: "read",
          capability: "minutes.search",
          payload: {},
          ...extra,
        }),
      ).rejects.toThrow();
      expect(handler).not.toHaveBeenCalled();
      await handle.close();
    },
  );

  it("denies a registered route absent from the task capability set", async () => {
    const files = await fixture();
    const handler = vi.fn(async () => ({ ok: true }));
    const handle = await startRunServer({
      socketPath: files.socketPath,
      context: {
        channel: "run",
        taskId: files.taskId,
        presidentOpenId: "ou_president",
        presidentChatId: "oc_private",
        capabilities: [],
      },
      jobStore: fakeStore(files.taskId, files.workspace),
      registry: createGatewayRouteRegistry([
        {
          channel: "run",
          kind: "read",
          capability: "minutes.search",
          parsePayload: (value) => value,
          handler,
        },
      ]),
      waitUntilTaskActionsSafe: async () => undefined,
    });
    const requestId = randomUUID();
    await expect(
      sendGatewayRequest(files.socketPath, {
        version: 1,
        requestId,
        kind: "read",
        capability: "minutes.search",
        payload: {},
      }),
    ).resolves.toEqual({
      version: 1,
      requestId,
      ok: false,
      error: { code: "CAPABILITY_DENIED" },
    });
    expect(handler).not.toHaveBeenCalled();
    await handle.close();
  });

  it("stops accepting before waiting on the task safety barrier", async () => {
    const files = await fixture();
    let releaseBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const handle = await startRunServer({
      socketPath: files.socketPath,
      context: {
        channel: "run",
        taskId: files.taskId,
        presidentOpenId: "ou_president",
        presidentChatId: "oc_private",
        capabilities: [],
      },
      jobStore: fakeStore(files.taskId, files.workspace),
      registry: createGatewayRouteRegistry([]),
      waitUntilTaskActionsSafe: () => barrier,
    });
    const closing = handle.close();
    await expect(
      sendGatewayRequest(files.socketPath, {
        version: 1,
        requestId: randomUUID(),
        kind: "read",
        capability: "minutes.search",
        payload: {},
      }),
    ).rejects.toThrow();
    releaseBarrier?.();
    await closing;
  });

  it("does not dispatch a previously accepted partial request after shutdown starts", async () => {
    const files = await fixture();
    let releaseBarrier: (() => void) | undefined;
    let barrierStarted: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const started = new Promise<void>((resolve) => {
      barrierStarted = resolve;
    });
    const handler = vi.fn(async () => ({ ok: true }));
    const handle = await startRunServer({
      socketPath: files.socketPath,
      context: {
        channel: "run",
        taskId: files.taskId,
        presidentOpenId: "ou_president",
        presidentChatId: "oc_private",
        capabilities: ["minutes.search"],
      },
      jobStore: fakeStore(files.taskId, files.workspace),
      registry: createGatewayRouteRegistry([
        {
          channel: "run",
          kind: "read",
          capability: "minutes.search",
          parsePayload: (value) => value,
          handler,
        },
      ]),
      waitUntilTaskActionsSafe: () => {
        barrierStarted?.();
        return barrier;
      },
    });
    const originalCwd = process.cwd();
    let socket;
    try {
      process.chdir(dirname(files.socketPath));
      socket = createConnection(basename(files.socketPath));
    } finally {
      process.chdir(originalCwd);
    }
    await once(socket, "connect");
    const request = encodeFrame({
      version: 1,
      requestId: randomUUID(),
      kind: "read",
      capability: "minutes.search",
      payload: {},
    });
    socket.write(request);

    const closing = handle.close();
    await started;
    socket.end();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(handler).not.toHaveBeenCalled();
    releaseBarrier?.();
    await closing;
  });

  it("keeps serving after a client disconnects before a handler response", async () => {
    const files = await fixture();
    let markHandlerEntered: (() => void) | undefined;
    let releaseHandler: (() => void) | undefined;
    const handlerEntered = new Promise<void>((resolve) => {
      markHandlerEntered = resolve;
    });
    const handlerBarrier = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const handler = vi.fn(async () => {
      markHandlerEntered?.();
      await handlerBarrier;
      return { state: "ready" };
    });
    const handle = await startRunServer({
      socketPath: files.socketPath,
      context: {
        channel: "run",
        taskId: files.taskId,
        presidentOpenId: "ou_president",
        presidentChatId: "oc_private",
        capabilities: ["minutes.search"],
      },
      jobStore: fakeStore(files.taskId, files.workspace),
      registry: createGatewayRouteRegistry([
        {
          channel: "run",
          kind: "read",
          capability: "minutes.search",
          parsePayload: (value) => value,
          handler,
        },
      ]),
      waitUntilTaskActionsSafe: async () => undefined,
    });
    const originalCwd = process.cwd();
    let socket;
    try {
      process.chdir(dirname(files.socketPath));
      socket = createConnection(basename(files.socketPath));
    } finally {
      process.chdir(originalCwd);
    }
    socket.on("error", () => undefined);

    try {
      await once(socket, "connect");
      socket.end(
        encodeFrame({
          version: 1,
          requestId: randomUUID(),
          kind: "read",
          capability: "minutes.search",
          payload: {},
        }),
      );
      await handlerEntered;
      const clientClosed = once(socket, "close");
      socket.destroy();
      await clientClosed;
      releaseHandler?.();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const requestId = randomUUID();
      await expect(
        sendGatewayRequest(files.socketPath, {
          version: 1,
          requestId,
          kind: "read",
          capability: "minutes.search",
          payload: {},
        }),
      ).resolves.toEqual({
        version: 1,
        requestId,
        ok: true,
        result: { state: "ready" },
      });
    } finally {
      releaseHandler?.();
      socket.destroy();
      await handle.close();
    }
  });

  it("binds only the fixed gateway.sock name inside the task workspace", async () => {
    const files = await fixture();
    await expect(
      startRunServer({
        socketPath: join(files.workspace, "alternate.sock"),
        context: {
          channel: "run",
          taskId: files.taskId,
          presidentOpenId: "ou_president",
          presidentChatId: "oc_private",
          capabilities: [],
        },
        jobStore: fakeStore(files.taskId, files.workspace),
        registry: createGatewayRouteRegistry([]),
        waitUntilTaskActionsSafe: async () => undefined,
      }),
    ).rejects.toThrow();
  });

  it.each(["Proxy", "accessor"])(
    "rejects a %s-backed run-server options object before binding",
    async (kind) => {
      const files = await fixture();
      const base = {
        socketPath: files.socketPath,
        context: {
          channel: "run" as const,
          taskId: files.taskId,
          presidentOpenId: "ou_president",
          presidentChatId: "oc_private",
          capabilities: [],
        },
        jobStore: fakeStore(files.taskId, files.workspace),
        registry: createGatewayRouteRegistry([]),
        waitUntilTaskActionsSafe: async () => undefined,
      };
      const candidate =
        kind === "Proxy"
          ? new Proxy(base, {})
          : Object.defineProperty({ ...base }, "socketPath", {
              enumerable: true,
              get: () => files.socketPath,
            });
      const outcome = await startRunServer(candidate).then(
        async (handle) => {
          await handle.close();
          return "accepted";
        },
        () => "rejected",
      );

      expect(outcome).toBe("rejected");
    },
  );
});
