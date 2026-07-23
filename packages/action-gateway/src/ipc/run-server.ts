import { basename, dirname, resolve } from "node:path";
import type { JobStore } from "@executive-assistant/job-store";

import { snapshotExactOwnDataOptions } from "../internal/exact-options.js";
import { encodeFrame, readSingleFrame } from "./framing.js";
import {
  dispatchGatewayRequest,
  EMPTY_GATEWAY_ROUTE_REGISTRY,
  snapshotGatewayContext,
  type GatewayRouteRegistry,
  type RunGatewayHandlerContext,
} from "./schemas.js";
import {
  startLocalSocketServer,
  type LocalSocketHandle,
} from "./socket-server.js";

export type RunServerContext = RunGatewayHandlerContext;

type TaskLookupRecord = Pick<
  NonNullable<ReturnType<JobStore["getTask"]>>,
  "id" | "workspacePath" | "state"
>;

type TaskLookup = Readonly<{
  getTask(taskId: string): TaskLookupRecord | null;
}>;

export async function startRunServer(
  options: Readonly<{
    socketPath: string;
    context: RunServerContext;
    jobStore: TaskLookup;
    registry?: GatewayRouteRegistry;
    waitUntilTaskActionsSafe: () => Promise<void>;
    frameTimeoutMs?: number;
  }>,
): Promise<LocalSocketHandle> {
  const stable = snapshotExactOwnDataOptions(
    options,
    ["socketPath", "context", "jobStore", "waitUntilTaskActionsSafe"],
    ["registry", "frameTimeoutMs"],
  );
  const socketPath = stable.socketPath;
  const jobStore = stable.jobStore as TaskLookup;
  const waitUntilTaskActionsSafe = stable.waitUntilTaskActionsSafe;
  if (
    typeof socketPath !== "string" ||
    jobStore === null ||
    typeof jobStore !== "object" ||
    typeof jobStore.getTask !== "function" ||
    typeof waitUntilTaskActionsSafe !== "function"
  ) {
    throw new Error("Run server options are invalid");
  }
  const context = snapshotGatewayContext(
    "run",
    stable.context,
  ) as RunServerContext;
  const task = jobStore.getTask(context.taskId);
  if (
    task === null ||
    task.id !== context.taskId ||
    task.state !== "RUNNING" ||
    basename(socketPath) !== "gateway.sock" ||
    task.workspacePath !== dirname(socketPath) ||
    resolve(task.workspacePath) !== task.workspacePath
  ) {
    throw new Error("Run socket task binding failed");
  }
  const registry =
    (stable.registry as GatewayRouteRegistry | undefined) ??
    EMPTY_GATEWAY_ROUTE_REGISTRY;
  const frameTimeoutMs = (stable.frameTimeoutMs as number | undefined) ?? 5_000;
  let dispatchAllowed = true;
  return startLocalSocketServer({
    socketPath,
    onStopAccepting: () => {
      dispatchAllowed = false;
    },
    waitUntilSafe: waitUntilTaskActionsSafe as () => Promise<void>,
    onConnection: async (socket) => {
      const request = await readSingleFrame(socket, {
        timeoutMs: frameTimeoutMs,
      });
      if (!dispatchAllowed) throw new Error("Run server is stopping");
      const response = await dispatchGatewayRequest(
        "run",
        request,
        registry,
        context,
      );
      socket.end(encodeFrame(response));
    },
  });
}
