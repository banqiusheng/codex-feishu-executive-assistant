import { createConnection } from "node:net";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { encodeFrame, readSingleFrame, type JsonValue } from "./ipc/framing.js";
import type { GatewayResponse } from "./ipc/schemas.js";
import { snapshotExactOwnDataOptions } from "./internal/exact-options.js";

function responseError(message: string): Error {
  return new Error(`Gateway response error: ${message}`);
}

function validateResponse(
  value: Readonly<Record<string, JsonValue>>,
  requestId: unknown,
): GatewayResponse {
  const keys = Object.keys(value);
  if (
    value.version !== 1 ||
    typeof value.requestId !== "string" ||
    value.requestId !== requestId ||
    typeof value.ok !== "boolean"
  ) {
    throw responseError("invalid response envelope");
  }
  if (value.ok) {
    if (
      keys.length !== 4 ||
      !keys.every((key) =>
        ["version", "requestId", "ok", "result"].includes(key),
      )
    ) {
      throw responseError("unexpected success fields");
    }
    return Object.freeze({
      version: 1,
      requestId: value.requestId,
      ok: true,
      result: value.result ?? null,
    });
  }
  if (
    keys.length !== 4 ||
    !keys.every((key) => ["version", "requestId", "ok", "error"].includes(key))
  ) {
    throw responseError("unexpected error fields");
  }
  const error = value.error;
  if (
    error === null ||
    typeof error !== "object" ||
    Array.isArray(error) ||
    Object.keys(error).length !== 1 ||
    ((error as Readonly<Record<string, JsonValue>>).code !==
      "CAPABILITY_DENIED" &&
      (error as Readonly<Record<string, JsonValue>>).code !== "HANDLER_FAILED")
  ) {
    throw responseError("invalid error response");
  }
  const code = (error as Readonly<Record<string, JsonValue>>).code as
    | "CAPABILITY_DENIED"
    | "HANDLER_FAILED";
  return Object.freeze({
    version: 1,
    requestId: value.requestId,
    ok: false,
    error: Object.freeze({ code }),
  });
}

export async function sendGatewayRequest(
  socketPath: string,
  request: unknown,
  options: Readonly<{ timeoutMs?: number }> = {},
): Promise<GatewayResponse> {
  if (
    typeof socketPath !== "string" ||
    socketPath.length < 1 ||
    socketPath.includes("\0") ||
    !isAbsolute(socketPath) ||
    resolve(socketPath) !== socketPath ||
    (basename(socketPath) !== "gateway.sock" &&
      basename(socketPath) !== "action-gateway.sock")
  ) {
    throw responseError("invalid socket path");
  }
  let stableOptions: Readonly<Record<string, unknown>>;
  try {
    stableOptions = snapshotExactOwnDataOptions(options, [], ["timeoutMs"]);
  } catch {
    throw responseError("invalid options");
  }
  const timeoutMs = stableOptions.timeoutMs ?? 5_000;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw responseError("invalid timeout");
  }
  const frame = encodeFrame(request);
  const requestId =
    request !== null && typeof request === "object"
      ? Object.getOwnPropertyDescriptor(request, "requestId")?.value
      : undefined;
  const deadline = Date.now() + timeoutMs;
  const socket = (() => {
    if (Buffer.byteLength(socketPath) < 100) {
      return createConnection({ path: socketPath, allowHalfOpen: true });
    }
    const originalCwd = process.cwd();
    try {
      process.chdir(dirname(socketPath));
      return createConnection({
        path: basename(socketPath),
        allowHalfOpen: true,
      });
    } finally {
      process.chdir(originalCwd);
    }
  })();
  let deadlineTimer: NodeJS.Timeout | undefined;
  try {
    const exchange = (async () => {
      await new Promise<void>((resolveConnection, rejectConnection) => {
        const onConnect = () => {
          socket.off("error", onError);
          resolveConnection();
        };
        const onError = () => {
          socket.off("connect", onConnect);
          rejectConnection(responseError("connection failed"));
        };
        socket.once("connect", onConnect);
        socket.once("error", onError);
      });
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw responseError("request timeout");
      const reading = readSingleFrame(socket, { timeoutMs: remainingMs });
      socket.end(frame);
      const response = await reading;
      return validateResponse(response, requestId);
    })();
    const deadlineExpired = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(
        () => {
          socket.destroy();
          reject(responseError("request timeout"));
        },
        Math.max(0, deadline - Date.now()),
      );
      deadlineTimer.unref?.();
    });
    return await Promise.race([exchange, deadlineExpired]);
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    socket.destroy();
  }
}
