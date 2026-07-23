import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { sendGatewayRequest } from "../src/client.js";

const request = Object.freeze({
  version: 1 as const,
  requestId: randomUUID(),
  kind: "read" as const,
  capability: "minutes.search",
  payload: Object.freeze({}),
});

describe("gateway client boundary", () => {
  it.each([
    "relative/gateway.sock",
    "/tmp/../tmp/gateway.sock",
    "/tmp/gateway.sock\0suffix",
    "/tmp/not-gateway.sock",
  ])("rejects an untrusted socket path before connecting: %j", async (path) => {
    await expect(sendGatewayRequest(path, request)).rejects.toThrow(
      "invalid socket path",
    );
  });

  it.each(["Proxy", "accessor", "unknown field"])(
    "rejects %s-backed client options before connecting",
    async (kind) => {
      const getter = vi.fn(() => 1_000);
      const proxyGet = vi.fn(Reflect.get);
      const proxyOwnKeys = vi.fn(Reflect.ownKeys);
      const proxyGetPrototypeOf = vi.fn(Reflect.getPrototypeOf);
      const options =
        kind === "Proxy"
          ? new Proxy(
              { timeoutMs: 1_000 },
              {
                get: proxyGet,
                ownKeys: proxyOwnKeys,
                getPrototypeOf: proxyGetPrototypeOf,
              },
            )
          : kind === "accessor"
            ? Object.defineProperty({}, "timeoutMs", {
                enumerable: true,
                get: getter,
              })
            : { timeoutMs: 1_000, networkMode: "full" };

      await expect(
        sendGatewayRequest("/tmp/gateway.sock", request, options as never),
      ).rejects.toThrow("invalid options");
      expect(getter).not.toHaveBeenCalled();
      expect(proxyGet).not.toHaveBeenCalled();
      expect(proxyOwnKeys).not.toHaveBeenCalled();
      expect(proxyGetPrototypeOf).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid fixed timeout %j before connecting",
    async (timeoutMs) => {
      await expect(
        sendGatewayRequest("/tmp/gateway.sock", request, { timeoutMs }),
      ).rejects.toThrow("invalid timeout");
    },
  );
});
