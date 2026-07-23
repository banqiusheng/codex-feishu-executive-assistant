import { randomUUID } from "node:crypto";
import { lstatSync, renameSync, unlinkSync } from "node:fs";
import { chmod, lstat, realpath } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { snapshotExactOwnDataOptions } from "../internal/exact-options.js";

type SocketIdentity = Readonly<{ dev: number; ino: number }>;
type SecureSocketParent = Readonly<{
  canonicalPath: string;
  identity: SocketIdentity;
}>;

export type LocalSocketHandle = Readonly<{
  socketPath: string;
  close(): Promise<void>;
}>;

function socketError(message: string): Error {
  return new Error(`Local socket policy error: ${message}`);
}

async function pathIdentity(path: string): Promise<SocketIdentity | undefined> {
  try {
    const stat = await lstat(path);
    return Object.freeze({ dev: stat.dev, ino: stat.ino });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function sameIdentity(
  first: SocketIdentity,
  second: SocketIdentity | undefined,
): boolean {
  return (
    second !== undefined && first.dev === second.dev && first.ino === second.ino
  );
}

function quarantineSocketPath(
  socketPath: string,
  boundIdentity: SocketIdentity,
): string | undefined {
  const quarantinePath = join(
    dirname(socketPath),
    `.${basename(socketPath)}.${process.pid}.${randomUUID()}.preserved`,
  );
  try {
    renameSync(socketPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const quarantined = lstatSync(quarantinePath);
  if (
    sameIdentity(boundIdentity, {
      dev: quarantined.dev,
      ino: quarantined.ino,
    })
  ) {
    unlinkSync(quarantinePath);
    return undefined;
  }
  return quarantinePath;
}

async function inspectSecureSocketParent(
  socketPath: string,
): Promise<SecureSocketParent> {
  if (
    !isAbsolute(socketPath) ||
    resolve(socketPath) !== socketPath ||
    basename(socketPath).length < 1
  ) {
    throw socketError("socket path must be absolute and normalized");
  }
  const parent = dirname(socketPath);
  let component = "/";
  for (const segment of parent.split("/").filter(Boolean)) {
    component = join(component, segment);
    const componentStat = await lstat(component);
    if (componentStat.isSymbolicLink()) {
      const target = await realpath(component);
      const allowedSystemAlias =
        (component === "/var" && target === "/private/var") ||
        (component === "/tmp" && target === "/private/tmp") ||
        (component === "/etc" && target === "/private/etc");
      if (!allowedSystemAlias)
        throw socketError("socket path contains a symlink");
    }
  }
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
    throw socketError("socket parent is not a real directory");
  if (
    typeof process.getuid === "function" &&
    parentStat.uid !== process.getuid()
  ) {
    throw socketError("socket parent has a different owner");
  }
  if ((parentStat.mode & 0o777) !== 0o700)
    throw socketError("socket parent permissions must be 0700");
  const canonical = await realpath(parent);
  const canonicalStat = await lstat(canonical);
  if (
    canonicalStat.dev !== parentStat.dev ||
    canonicalStat.ino !== parentStat.ino
  ) {
    throw socketError("socket parent changed during validation");
  }
  if (await pathIdentity(socketPath))
    throw socketError("socket target already exists");
  return Object.freeze({
    canonicalPath: canonical,
    identity: Object.freeze({ dev: parentStat.dev, ino: parentStat.ino }),
  });
}

export async function assertSecureSocketParent(
  socketPath: string,
): Promise<string> {
  return (await inspectSecureSocketParent(socketPath)).canonicalPath;
}

function stopListening(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (
        error &&
        (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
      )
        rejectClose(error);
      else resolveClose();
    });
  });
}

export async function startLocalSocketServer(
  options: Readonly<{
    socketPath: string;
    onConnection: (socket: Socket) => Promise<void>;
    onStopAccepting?: () => void;
    waitUntilSafe?: () => Promise<void>;
  }>,
): Promise<LocalSocketHandle> {
  const stable = snapshotExactOwnDataOptions(
    options,
    ["socketPath", "onConnection"],
    ["onStopAccepting", "waitUntilSafe"],
  );
  const socketPath = stable.socketPath;
  const onConnection = stable.onConnection;
  const onStopAccepting = stable.onStopAccepting;
  const waitUntilSafe = stable.waitUntilSafe;
  if (
    typeof socketPath !== "string" ||
    typeof onConnection !== "function" ||
    (onStopAccepting !== undefined && typeof onStopAccepting !== "function") ||
    (waitUntilSafe !== undefined && typeof waitUntilSafe !== "function")
  ) {
    throw socketError("socket server options are invalid");
  }
  const secureParent = await inspectSecureSocketParent(socketPath);
  let ready = false;
  let accepting = true;
  const sockets = new Set<Socket>();
  let boundIdentity: SocketIdentity | undefined;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (!ready || !accepting) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    void (onConnection as (socket: Socket) => Promise<void>)(socket).catch(() =>
      socket.destroy(),
    );
  });
  server.on("error", () => undefined);

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    if (Buffer.byteLength(socketPath) >= 100) {
      const originalCwd = process.cwd();
      try {
        process.chdir(dirname(socketPath));
        server.listen(basename(socketPath));
      } finally {
        process.chdir(originalCwd);
      }
    } else {
      server.listen(socketPath);
    }
  });

  try {
    const createdStat = await lstat(socketPath);
    if (!createdStat.isSocket())
      throw socketError("bound target is not a socket");
    boundIdentity = Object.freeze({
      dev: createdStat.dev,
      ino: createdStat.ino,
    });
    await chmod(socketPath, 0o600);
    const socketStat = await lstat(socketPath);
    const parentStat = await lstat(dirname(socketPath));
    const canonicalParent = await realpath(dirname(socketPath));
    if (
      canonicalParent !== secureParent.canonicalPath ||
      !sameIdentity(secureParent.identity, {
        dev: parentStat.dev,
        ino: parentStat.ino,
      })
    ) {
      throw socketError("socket parent changed while binding");
    }
    if (!socketStat.isSocket())
      throw socketError("bound target is not a socket");
    if (
      !sameIdentity(boundIdentity, { dev: socketStat.dev, ino: socketStat.ino })
    ) {
      throw socketError("bound socket changed during validation");
    }
    if (
      typeof process.getuid === "function" &&
      socketStat.uid !== process.getuid()
    ) {
      throw socketError("bound socket has a different owner");
    }
    if ((socketStat.mode & 0o777) !== 0o600)
      throw socketError("socket permissions are not 0600");
    const identity = boundIdentity;
    ready = true;
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      socketPath,
      close() {
        if (closePromise) return closePromise;
        accepting = false;
        ready = false;
        closePromise = (async () => {
          let preservedPath: string | undefined;
          let hasFailure = false;
          let failure: unknown;
          const recordFailure = (error: unknown) => {
            if (!hasFailure) {
              hasFailure = true;
              failure = error;
            }
          };
          try {
            (onStopAccepting as (() => void) | undefined)?.();
          } catch (error) {
            recordFailure(error);
          }
          try {
            preservedPath = quarantineSocketPath(socketPath, identity);
          } catch (error) {
            recordFailure(error);
          }
          const stopped = stopListening(server).catch((error: unknown) => {
            recordFailure(error);
          });
          try {
            await ((waitUntilSafe as (() => Promise<void>) | undefined)?.() ??
              Promise.resolve());
          } catch (error) {
            recordFailure(error);
          }
          for (const socket of sockets) socket.destroy();
          await stopped;

          if (preservedPath) {
            try {
              if (await pathIdentity(socketPath)) {
                throw socketError(
                  "socket path was occupied while restoring replacement",
                );
              }
              renameSync(preservedPath, socketPath);
            } catch (error) {
              recordFailure(error);
            }
          }
          if (hasFailure) throw failure;
        })();
        return closePromise;
      },
    });
  } catch (error) {
    accepting = false;
    ready = false;
    let preservedPath: string | undefined;
    if (boundIdentity) {
      try {
        preservedPath = quarantineSocketPath(socketPath, boundIdentity);
      } catch {
        preservedPath = undefined;
      }
    }
    for (const socket of sockets) socket.destroy();
    await stopListening(server).catch(() => undefined);
    if (preservedPath && !(await pathIdentity(socketPath))) {
      try {
        renameSync(preservedPath, socketPath);
      } catch {
        // Preserve the original startup error; the randomized path remains for recovery.
      }
    }
    throw error;
  }
}
