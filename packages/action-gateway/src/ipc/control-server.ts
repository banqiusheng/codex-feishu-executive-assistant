import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import type { Socket } from "node:net";
import { userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { snapshotExactOwnDataOptions } from "../internal/exact-options.js";
import { encodeFrame, readSingleFrame } from "./framing.js";
import {
  dispatchGatewayRequest,
  EMPTY_GATEWAY_ROUTE_REGISTRY,
  snapshotGatewayContext,
  type ControlGatewayHandlerContext,
  type GatewayRouteRegistry,
} from "./schemas.js";
import {
  startLocalSocketServer,
  type LocalSocketHandle,
} from "./socket-server.js";

export type ControlServerContext = ControlGatewayHandlerContext;

export type PeerAuthenticator = (socket: Socket) => boolean | Promise<boolean>;

export type ControlServerOptions = Readonly<{
  context: ControlServerContext;
  registry?: GatewayRouteRegistry;
  authenticatePeer: PeerAuthenticator;
  revalidateActiveBridge: () => boolean | Promise<boolean>;
  frameTimeoutMs?: number;
}>;

type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export function createNativePeerAuthenticator(
  options: Readonly<{
    helperPath: string;
    verifyHelperAtStartup?: (helperPath: string) => boolean;
    timeoutMs?: number;
    maxConcurrent?: number;
    spawn?: SpawnFunction;
  }>,
): PeerAuthenticator {
  const stable = snapshotExactOwnDataOptions(
    options,
    ["helperPath"],
    ["verifyHelperAtStartup", "timeoutMs", "maxConcurrent", "spawn"],
  );
  const helperPath = stable.helperPath;
  const verifyHelperAtStartup = stable.verifyHelperAtStartup;
  if (
    typeof helperPath !== "string" ||
    (verifyHelperAtStartup !== undefined &&
      typeof verifyHelperAtStartup !== "function")
  ) {
    throw new Error("Native peer verifier options are invalid");
  }
  const verifyBuiltInHelperBoundary = (): boolean => {
    if (!isAbsolute(helperPath) || resolve(helperPath) !== helperPath)
      return false;
    try {
      const stat = lstatSync(helperPath);
      return (
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        realpathSync(helperPath) === helperPath &&
        (typeof process.getuid !== "function" ||
          stat.uid === process.getuid()) &&
        (stat.mode & 0o7777) === 0o500
      );
    } catch {
      return false;
    }
  };
  let helperVerified = verifyBuiltInHelperBoundary();
  if (helperVerified && verifyHelperAtStartup) {
    try {
      helperVerified =
        (verifyHelperAtStartup as (path: string) => boolean)(helperPath) ===
          true && verifyBuiltInHelperBoundary();
    } catch {
      helperVerified = false;
    }
  }
  if (
    !isAbsolute(helperPath) ||
    resolve(helperPath) !== helperPath ||
    !helperVerified
  ) {
    throw new Error("Native peer verifier startup validation failed");
  }
  const timeoutMs = (stable.timeoutMs as number | undefined) ?? 2_000;
  const maxConcurrent = (stable.maxConcurrent as number | undefined) ?? 8;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error("Invalid peer verifier timeout");
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0)
    throw new Error("Invalid peer verifier concurrency");
  const spawn =
    (stable.spawn as SpawnFunction | undefined) ?? (nodeSpawn as SpawnFunction);
  if (typeof spawn !== "function")
    throw new Error("Invalid peer verifier spawn function");
  const env = Object.freeze({
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
  });
  let active = 0;

  return async (socket) => {
    if (active >= maxConcurrent) return false;
    active += 1;
    try {
      socket.pause();
      let child: ChildProcess;
      try {
        child = spawn(helperPath, [], {
          env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe", socket],
          windowsHide: true,
        });
      } catch {
        return false;
      }
      let stdoutBytes = 0;
      child.stdout?.on("data", (chunk: Buffer | Uint8Array) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > 0) child.kill();
      });
      child.stderr?.resume();
      let timedOut = false;
      const outcome = await new Promise<
        Readonly<{
          closed: boolean;
          code: number | null;
          signal: NodeJS.Signals | null;
        }>
      >((resolveClose) => {
        let settled = false;
        const finish = (
          value: Readonly<{
            closed: boolean;
            code: number | null;
            signal: NodeJS.Signals | null;
          }>,
        ) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolveClose(value);
        };
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
          finish(Object.freeze({ closed: false, code: null, signal: null }));
        }, timeoutMs);
        timer.unref?.();
        child.once("error", () => {
          finish(Object.freeze({ closed: false, code: null, signal: null }));
        });
        child.once("close", (code, signal) => {
          finish(Object.freeze({ closed: true, code, signal }));
        });
      });
      return (
        !timedOut &&
        outcome.closed &&
        outcome.code === 0 &&
        outcome.signal === null &&
        stdoutBytes === 0
      );
    } finally {
      active -= 1;
    }
  };
}

function currentUserControlSocketPath(): string {
  const home = userInfo().homedir;
  if (!isAbsolute(home) || resolve(home) !== home) {
    throw new Error("Current user home directory is invalid");
  }
  return join(
    home,
    "PresidentAssistant",
    "runtime",
    "control",
    "action-gateway.sock",
  );
}

function snapshotControlServerOptions(
  options: unknown,
  includeSocketPath: boolean,
): Readonly<Record<string, unknown>> {
  return snapshotExactOwnDataOptions(
    options,
    includeSocketPath
      ? ["socketPath", "context", "authenticatePeer", "revalidateActiveBridge"]
      : ["context", "authenticatePeer", "revalidateActiveBridge"],
    ["registry", "frameTimeoutMs"],
  );
}

async function startControlServerFromSnapshot(
  socketPath: string,
  stable: Readonly<Record<string, unknown>>,
): Promise<LocalSocketHandle> {
  const context = snapshotGatewayContext(
    "control",
    stable.context,
  ) as ControlServerContext;
  const registry =
    (stable.registry as GatewayRouteRegistry | undefined) ??
    EMPTY_GATEWAY_ROUTE_REGISTRY;
  const authenticatePeer = stable.authenticatePeer;
  const revalidateActiveBridge = stable.revalidateActiveBridge;
  const frameTimeoutMs = (stable.frameTimeoutMs as number | undefined) ?? 5_000;
  if (
    typeof authenticatePeer !== "function" ||
    typeof revalidateActiveBridge !== "function"
  ) {
    throw new Error("Control server verifiers are invalid");
  }
  return startLocalSocketServer({
    socketPath,
    onConnection: async (socket) => {
      socket.pause();
      if (!(await (authenticatePeer as PeerAuthenticator)(socket)))
        throw new Error("Peer authentication failed");
      if (
        !(await (revalidateActiveBridge as () => boolean | Promise<boolean>)())
      )
        throw new Error("Active bridge changed");
      if (socket.destroyed || socket.readableEnded)
        throw new Error("Peer socket closed during verification");
      const requestPromise = readSingleFrame(socket, {
        timeoutMs: frameTimeoutMs,
      });
      socket.resume();
      const request = await requestPromise;
      const response = await dispatchGatewayRequest(
        "control",
        request,
        registry,
        context,
      );
      socket.end(encodeFrame(response));
    },
  });
}

export function startControlServer(
  options: ControlServerOptions,
): Promise<LocalSocketHandle> {
  const stable = snapshotControlServerOptions(options, false);
  return startControlServerFromSnapshot(currentUserControlSocketPath(), stable);
}

export function startControlServerAtPathForTesting(
  options: ControlServerOptions & Readonly<{ socketPath: string }>,
): Promise<LocalSocketHandle> {
  const stable = snapshotControlServerOptions(options, true);
  if (typeof stable.socketPath !== "string") {
    throw new Error("Control socket path is invalid");
  }
  return startControlServerFromSnapshot(stable.socketPath, stable);
}
