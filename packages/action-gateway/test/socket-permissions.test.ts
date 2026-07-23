import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createGatewayRouteRegistry } from "../src/ipc/schemas.js";
import { startRunServer } from "../src/ipc/run-server.js";

const roots: string[] = [];

async function secureWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "assistant-gateway-"));
  roots.push(root);
  await chmod(root, 0o700);
  const taskId = randomUUID();
  const workspace = join(root, taskId);
  await mkdir(workspace, { mode: 0o700 });
  return {
    root,
    taskId,
    workspace,
    socketPath: join(workspace, "gateway.sock"),
  };
}

function fakeStore(taskId: string, workspacePath: string) {
  return {
    getTask: vi.fn((id: string) =>
      id === taskId
        ? {
            id: taskId,
            workspacePath,
            state: "RUNNING" as const,
          }
        : null,
    ),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("socket filesystem policy", () => {
  it("creates a 0600 socket under a canonical 0700 task directory", async () => {
    const fixture = await secureWorkspace();
    const handle = await startRunServer({
      socketPath: fixture.socketPath,
      context: {
        channel: "run",
        taskId: fixture.taskId,
        presidentOpenId: "ou_president",
        presidentChatId: "oc_private",
        capabilities: [],
      },
      jobStore: fakeStore(fixture.taskId, fixture.workspace),
      registry: createGatewayRouteRegistry([]),
      waitUntilTaskActionsSafe: async () => undefined,
    });
    expect((await lstat(fixture.workspace)).mode & 0o777).toBe(0o700);
    const socket = await lstat(fixture.socketPath);
    expect(socket.isSocket()).toBe(true);
    expect(socket.mode & 0o777).toBe(0o600);
    await handle.close();
    await expect(lstat(fixture.socketPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["regular", "directory", "symlink"])(
    "refuses a pre-existing %s at the socket path",
    async (kind) => {
      const fixture = await secureWorkspace();
      if (kind === "regular")
        await writeFile(fixture.socketPath, "occupied", { mode: 0o600 });
      if (kind === "directory")
        await mkdir(fixture.socketPath, { mode: 0o700 });
      if (kind === "symlink") await symlink("elsewhere", fixture.socketPath);
      await expect(
        startRunServer({
          socketPath: fixture.socketPath,
          context: {
            channel: "run",
            taskId: fixture.taskId,
            presidentOpenId: "ou_president",
            presidentChatId: "oc_private",
            capabilities: [],
          },
          jobStore: fakeStore(fixture.taskId, fixture.workspace),
          registry: createGatewayRouteRegistry([]),
          waitUntilTaskActionsSafe: async () => undefined,
        }),
      ).rejects.toThrow();
    },
  );

  it("refuses insecure or symlinked parents", async () => {
    const fixture = await secureWorkspace();
    await chmod(fixture.workspace, 0o755);
    await expect(
      startRunServer({
        socketPath: fixture.socketPath,
        context: {
          channel: "run",
          taskId: fixture.taskId,
          presidentOpenId: "ou_president",
          presidentChatId: "oc_private",
          capabilities: [],
        },
        jobStore: fakeStore(fixture.taskId, fixture.workspace),
        registry: createGatewayRouteRegistry([]),
        waitUntilTaskActionsSafe: async () => undefined,
      }),
    ).rejects.toThrow();

    const link = join(fixture.root, randomUUID());
    await symlink(fixture.workspace, link);
    await expect(
      startRunServer({
        socketPath: join(link, "gateway.sock"),
        context: {
          channel: "run",
          taskId: fixture.taskId,
          presidentOpenId: "ou_president",
          presidentChatId: "oc_private",
          capabilities: [],
        },
        jobStore: fakeStore(fixture.taskId, fixture.workspace),
        registry: createGatewayRouteRegistry([]),
        waitUntilTaskActionsSafe: async () => undefined,
      }),
    ).rejects.toThrow();
  });

  it("does not unlink a path replacement during shutdown", async () => {
    const fixture = await secureWorkspace();
    const handle = await startRunServer({
      socketPath: fixture.socketPath,
      context: {
        channel: "run",
        taskId: fixture.taskId,
        presidentOpenId: "ou_president",
        presidentChatId: "oc_private",
        capabilities: [],
      },
      jobStore: fakeStore(fixture.taskId, fixture.workspace),
      registry: createGatewayRouteRegistry([]),
      waitUntilTaskActionsSafe: async () => undefined,
    });
    await rm(fixture.socketPath);
    await writeFile(fixture.socketPath, "replacement", { mode: 0o600 });
    await handle.close();
    expect(await readFile(fixture.socketPath, "utf8")).toBe("replacement");
  });

  it("restores a path replacement even when the safety barrier rejects", async () => {
    const fixture = await secureWorkspace();
    const handle = await startRunServer({
      socketPath: fixture.socketPath,
      context: {
        channel: "run",
        taskId: fixture.taskId,
        presidentOpenId: "ou_president",
        presidentChatId: "oc_private",
        capabilities: [],
      },
      jobStore: fakeStore(fixture.taskId, fixture.workspace),
      registry: createGatewayRouteRegistry([]),
      waitUntilTaskActionsSafe: async () => {
        throw new Error("barrier failed");
      },
    });
    await rm(fixture.socketPath);
    await writeFile(fixture.socketPath, "replacement", { mode: 0o600 });

    await expect(handle.close()).rejects.toThrow("barrier failed");
    expect(await readFile(fixture.socketPath, "utf8")).toBe("replacement");
  });

  it("preserves a barrier rejection whose reason is undefined", async () => {
    const fixture = await secureWorkspace();
    const handle = await startRunServer({
      socketPath: fixture.socketPath,
      context: {
        channel: "run",
        taskId: fixture.taskId,
        presidentOpenId: "ou_president",
        presidentChatId: "oc_private",
        capabilities: [],
      },
      jobStore: fakeStore(fixture.taskId, fixture.workspace),
      registry: createGatewayRouteRegistry([]),
      waitUntilTaskActionsSafe: () => Promise.reject(undefined),
    });

    const outcome = await handle.close().then(
      () => "resolved",
      () => "rejected",
    );
    expect(outcome).toBe("rejected");
  });
});
