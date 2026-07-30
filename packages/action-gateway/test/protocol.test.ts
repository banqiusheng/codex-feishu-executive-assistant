import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  MAX_FRAME_BYTES,
  decodeFrame,
  encodeFrame,
  parseStrictJsonText,
  readSingleFrame,
} from "../src/ipc/framing.js";
import {
  createGatewayRouteRegistry,
  dispatchGatewayRequest,
  parseGatewayRequest,
  snapshotGatewayContext,
} from "../src/ipc/schemas.js";

const REQUEST_ID = "5ccd8261-b163-4ad5-ae2e-254765d0d2b4";

function frameBody(body: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function validRequest(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    requestId: REQUEST_ID,
    kind: "read",
    capability: "minutes.search",
    payload: { query: "季度复盘" },
    ...overrides,
  };
}

function strictSearchPayload(value: unknown) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 1 ||
    typeof (value as { query?: unknown }).query !== "string"
  ) {
    throw new Error("invalid payload");
  }
  return { query: (value as { query: string }).query };
}

function strictExecutePayload(value: unknown) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 1 ||
    typeof (value as { title?: unknown }).title !== "string"
  ) {
    throw new Error("invalid execute payload");
  }
  return { title: (value as { title: string }).title };
}

describe("strict framing", () => {
  it("encodes a four-byte big-endian length prefix", () => {
    const frame = encodeFrame({ ok: true });
    expect(frame.readUInt32BE(0)).toBe(frame.length - 4);
    expect(decodeFrame(frame)).toEqual({ ok: true });
  });

  it.each([
    Buffer.alloc(0),
    Buffer.alloc(1),
    Buffer.alloc(2),
    Buffer.alloc(3),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from([0, 0x10, 0, 1]),
    frameBody(Buffer.from("{}x")),
    Buffer.concat([encodeFrame({ one: 1 }), encodeFrame({ two: 2 })]),
  ])("rejects malformed, oversized, or trailing frames", (frame) => {
    expect(() => decodeFrame(frame)).toThrow();
  });

  it.each([
    Buffer.from([0x80]),
    Buffer.from([0xc0, 0xaf]),
    Buffer.from([0xe2, 0x82]),
    Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from([0xf4, 0x90, 0x80, 0x80]),
  ])("rejects invalid UTF-8", (body) => {
    expect(() => decodeFrame(frameBody(body))).toThrow();
  });

  it.each([
    '{"a":1,"a":2}',
    '{"payload":{"x":1,"x":2}}',
    "{} {}",
    "[]",
    "null",
    "1",
    '"text"',
  ])("rejects duplicate keys, trailing JSON, or non-object roots", (text) => {
    expect(() => parseStrictJsonText(text)).toThrow();
  });

  it("rejects JSON beyond the depth and node limits", () => {
    const tooDeep = `${"[".repeat(65)}0${"]".repeat(65)}`;
    const tooWide = `[${Array.from({ length: 10_001 }, () => "0").join(",")}]`;
    expect(() => parseStrictJsonText(tooDeep)).toThrow();
    expect(() => parseStrictJsonText(tooWide)).toThrow();
  });

  it("reassembles split headers and bodies but waits for EOF", async () => {
    const source = new PassThrough();
    const frame = encodeFrame({ value: "完整" });
    const pending = readSingleFrame(source, { timeoutMs: 1_000 });
    source.write(frame.subarray(0, 1));
    source.write(frame.subarray(1, 2));
    source.write(frame.subarray(2, 4));
    source.write(frame.subarray(4, 7));
    source.end(frame.subarray(7));
    await expect(pending).resolves.toEqual({ value: "完整" });
  });

  it("rejects truncation and a late trailing byte before dispatch", async () => {
    const truncated = new PassThrough();
    const truncatedRead = readSingleFrame(truncated, { timeoutMs: 1_000 });
    truncated.end(encodeFrame({ value: 1 }).subarray(0, -1));
    await expect(truncatedRead).rejects.toThrow();

    const trailing = new PassThrough();
    const trailingRead = readSingleFrame(trailing, { timeoutMs: 1_000 });
    trailing.end(Buffer.concat([encodeFrame({ value: 1 }), Buffer.from([0])]));
    await expect(trailingRead).rejects.toThrow();
  });

  it("rejects a stream that closes without EOF instead of waiting for timeout", async () => {
    const source = new PassThrough();
    const pending = readSingleFrame(source, { timeoutMs: 1_000 }).then(
      () => "resolved",
      () => "rejected",
    );
    source.destroy();

    await expect(
      Promise.race([
        pending,
        new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 50)),
      ]),
    ).resolves.toBe("rejected");
  });

  it.each(["Proxy", "accessor"])(
    "rejects %s-backed frame options before installing stream listeners",
    async (kind) => {
      const source = new PassThrough();
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
          : Object.defineProperty({}, "timeoutMs", {
              enumerable: true,
              get: getter,
            });
      const pending = readSingleFrame(source, options as never);

      expect(source.listenerCount("data")).toBe(0);
      expect(getter).not.toHaveBeenCalled();
      expect(proxyGet).not.toHaveBeenCalled();
      expect(proxyOwnKeys).not.toHaveBeenCalled();
      expect(proxyGetPrototypeOf).not.toHaveBeenCalled();
      await expect(pending).rejects.toThrow();
    },
  );

  it("bounds encoded output and rejects unsafe values", () => {
    expect(() => encodeFrame("x".repeat(MAX_FRAME_BYTES + 1))).toThrow();
    expect(() => encodeFrame({ value: Number.NaN })).toThrow();
    const accessor = {};
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get: () => "must-not-run",
    });
    expect(() => encodeFrame(accessor)).toThrow();
  });

  it("rejects non-index array properties instead of silently dropping them", () => {
    const value: unknown[] = [];
    Object.defineProperty(value, "4294967295", {
      enumerable: true,
      value: "must-not-disappear",
    });

    expect(() => encodeFrame({ value })).toThrow("unsafe array properties");
  });

  it("rejects 1,000 deterministic invalid frames without losing liveness", () => {
    let state = 0x5eed1234;
    const next = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    for (let index = 0; index < 1_000; index += 1) {
      const bucket = index % 5;
      const sample =
        bucket === 0
          ? Buffer.alloc(next() % 4)
          : bucket === 1
            ? Buffer.from([0, 0, 0, 0])
            : bucket === 2
              ? Buffer.from([0xff, 0xff, 0xff, 0xff])
              : bucket === 3
                ? frameBody(Buffer.from([0xc0, 0xaf]))
                : frameBody(Buffer.from(`{"n":${next()}}x`));
      expect(() => decodeFrame(sample)).toThrow();
    }
    expect(decodeFrame(encodeFrame({ alive: true }))).toEqual({ alive: true });
  });
});

describe("strict request registry", () => {
  it("accepts execute only through a registered and allowlisted runtime capability", async () => {
    const handler = vi.fn(async (_context, payload) => payload);
    const registry = createGatewayRouteRegistry([
      {
        channel: "run",
        kind: "execute",
        capability: "calendar.schedule",
        parsePayload: strictExecutePayload,
        handler,
      },
    ]);
    const request = validRequest({
      kind: "execute",
      capability: "calendar.schedule",
      payload: { title: "季度复盘" },
    });
    const context = {
      channel: "run" as const,
      taskId: randomUUID(),
      presidentOpenId: "ou_president",
      presidentChatId: "oc_private",
      capabilities: ["calendar.schedule"],
    };

    await expect(
      dispatchGatewayRequest("run", request, registry, context),
    ).resolves.toMatchObject({ ok: true, result: { title: "季度复盘" } });
    expect(handler).toHaveBeenCalledOnce();

    await expect(
      dispatchGatewayRequest("run", request, registry, {
        ...context,
        capabilities: ["minutes.search"],
      }),
    ).resolves.toEqual({
      version: 1,
      requestId: REQUEST_ID,
      ok: false,
      error: { code: "CAPABILITY_DENIED" },
    });
  });

  it.each(["actor", "chat", "identity", "skipConfirmation", "autoApprove"])(
    "denies execute payload carrying %s through its concrete capability parser",
    async (field) => {
      const handler = vi.fn(async () => ({ ok: true }));
      const registry = createGatewayRouteRegistry([
        {
          channel: "run",
          kind: "execute",
          capability: "calendar.schedule",
          parsePayload: strictExecutePayload,
          handler,
        },
      ]);
      const response = await dispatchGatewayRequest(
        "run",
        validRequest({
          kind: "execute",
          capability: "calendar.schedule",
          payload: { title: "季度复盘", [field]: true },
        }),
        registry,
        {
          channel: "run",
          taskId: randomUUID(),
          presidentOpenId: "ou_president",
          presidentChatId: "oc_private",
          capabilities: ["calendar.schedule"],
        },
      );

      expect(response).toMatchObject({
        ok: false,
        error: { code: "CAPABILITY_DENIED" },
      });
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each([
    validRequest({ version: 2 }),
    validRequest({ taskId: randomUUID() }),
    validRequest({ identity: "user" }),
    validRequest({ actor: "user" }),
    validRequest({ chat: "oc_other" }),
    validRequest({ skipConfirmation: true }),
    validRequest({ autoApprove: true }),
    validRequest({ targetChatId: "oc_other" }),
    validRequest({
      kind: "shell",
      capability: "exec",
      payload: { command: "curl" },
    }),
    validRequest({
      capability: "http.fetch",
      payload: { url: "https://example.com" },
    }),
    validRequest({ capability: "file.export", payload: { path: "/tmp/out" } }),
  ])("rejects non-contract or unregistered input", (request) => {
    expect(() => parseGatewayRequest(request)).toThrow();
  });

  it("dispatches only an injected exact route and freezes trusted context", async () => {
    const handler = vi.fn(async (context, payload) => ({
      taskId: context.taskId,
      query: (payload as { query: string }).query,
    }));
    const registry = createGatewayRouteRegistry([
      {
        channel: "run",
        kind: "read",
        capability: "minutes.search",
        parsePayload: strictSearchPayload,
        handler,
      },
    ]);
    const context = {
      channel: "run" as const,
      taskId: randomUUID(),
      presidentOpenId: "ou_president",
      presidentChatId: "oc_private",
      capabilities: ["minutes.search"],
    };
    const response = await dispatchGatewayRequest(
      "run",
      validRequest(),
      registry,
      context,
    );
    expect(response).toMatchObject({
      version: 1,
      requestId: REQUEST_ID,
      ok: true,
    });
    expect(handler).toHaveBeenCalledOnce();
    const observedContext = handler.mock.calls[0]?.[0];
    expect(Object.isFrozen(observedContext)).toBe(true);
    expect(Object.isFrozen(observedContext.capabilities)).toBe(true);
  });

  it("returns only allowlisted errors after a trusted request id exists", async () => {
    const registry = createGatewayRouteRegistry([
      {
        channel: "run",
        kind: "read",
        capability: "minutes.search",
        parsePayload: strictSearchPayload,
        handler: async () => {
          throw new Error("SECRET_SENTINEL must not cross the wire");
        },
      },
    ]);
    const response = await dispatchGatewayRequest(
      "run",
      validRequest(),
      registry,
      {
        channel: "run",
        taskId: randomUUID(),
        presidentOpenId: "ou_president",
        presidentChatId: "oc_private",
        capabilities: ["minutes.search"],
      },
    );
    expect(response).toEqual({
      version: 1,
      requestId: REQUEST_ID,
      ok: false,
      error: { code: "HANDLER_FAILED" },
    });
    expect(JSON.stringify(response)).not.toContain("SECRET_SENTINEL");
  });

  it("maps an oversized handler result to a bounded HANDLER_FAILED response", async () => {
    const registry = createGatewayRouteRegistry([
      {
        channel: "run",
        kind: "read",
        capability: "minutes.search",
        parsePayload: strictSearchPayload,
        handler: async () => "x".repeat(MAX_FRAME_BYTES),
      },
    ]);

    await expect(
      dispatchGatewayRequest("run", validRequest(), registry, {
        channel: "run",
        taskId: randomUUID(),
        presidentOpenId: "ou_president",
        presidentChatId: "oc_private",
        capabilities: ["minutes.search"],
      }),
    ).resolves.toEqual({
      version: 1,
      requestId: REQUEST_ID,
      ok: false,
      error: { code: "HANDLER_FAILED" },
    });
  });

  it("snapshots registry entries and rejects Proxy/accessor construction", () => {
    const route = {
      channel: "run" as const,
      kind: "read" as const,
      capability: "minutes.search",
      parsePayload: strictSearchPayload,
      handler: async () => ({ ok: true }),
    };
    const registry = createGatewayRouteRegistry([route]);
    route.capability = "http.fetch";
    expect(() =>
      parseGatewayRequest(validRequest(), registry, "run"),
    ).not.toThrow();

    expect(() => createGatewayRouteRegistry(new Proxy([route], {}))).toThrow();
    const accessor = { ...route } as Record<string, unknown>;
    Object.defineProperty(accessor, "handler", {
      enumerable: true,
      get: () => route.handler,
    });
    expect(() => createGatewayRouteRegistry([accessor as never])).toThrow();

    const extraIndex = [route];
    Object.defineProperty(extraIndex, "4294967295", {
      enumerable: true,
      value: route,
    });
    expect(() => createGatewayRouteRegistry(extraIndex)).toThrow();
  });

  it("rejects a registry that did not come from the trusted constructor", async () => {
    const lookup = vi.fn(() => ({
      channel: "run" as const,
      kind: "read" as const,
      capability: "minutes.search",
      parsePayload: strictSearchPayload,
      handler: async () => ({ leaked: true }),
    }));
    const forged = { lookup };
    const context = {
      channel: "run" as const,
      taskId: randomUUID(),
      presidentOpenId: "ou_president",
      presidentChatId: "oc_private",
      capabilities: ["minutes.search"],
    };

    expect(() => parseGatewayRequest(validRequest(), forged, "run")).toThrow();
    await expect(
      dispatchGatewayRequest("run", validRequest(), forged, context),
    ).rejects.toThrow();
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["minutes.search\u0000admin", "minutes.search\nadmin", ""])(
    "rejects control characters in bound identifiers: %j",
    (capability) => {
      expect(() =>
        createGatewayRouteRegistry([
          {
            channel: "run",
            kind: "read",
            capability,
            parsePayload: strictSearchPayload,
            handler: async () => ({ ok: true }),
          },
        ]),
      ).toThrow();
      expect(() =>
        snapshotGatewayContext("run", {
          channel: "run",
          taskId: randomUUID(),
          presidentOpenId: capability,
          presidentChatId: "oc_private",
          capabilities: ["minutes.search"],
        }),
      ).toThrow();
    },
  );
});
