import { types as utilTypes } from "node:util";
import {
  GatewayRequestSchema,
  type GatewayRequest,
} from "@executive-assistant/contracts";

import {
  encodeFrame,
  parseStrictJsonText,
  snapshotStrictJson,
  type JsonValue,
} from "./framing.js";

export type GatewayChannel = "run" | "control";
export type GatewayKind = GatewayRequest["kind"] | "control";

export type RunGatewayHandlerContext = Readonly<{
  channel: "run";
  taskId: string;
  presidentOpenId: string;
  presidentChatId: string;
  capabilities: readonly string[];
}>;

export type ControlGatewayHandlerContext = Readonly<{
  channel: "control";
  bridgeInstanceId: string;
  releaseHash: string;
}>;

export type GatewayHandlerContext =
  | RunGatewayHandlerContext
  | ControlGatewayHandlerContext;

export type GatewayRoute =
  | Readonly<{
      channel: "run";
      kind: GatewayRequest["kind"];
      capability: string;
      parsePayload: (value: unknown) => unknown;
      handler: (
        context: RunGatewayHandlerContext,
        payload: JsonValue,
      ) => unknown | Promise<unknown>;
    }>
  | Readonly<{
      channel: "control";
      kind: "control";
      capability: string;
      parsePayload: (value: unknown) => unknown;
      handler: (
        context: ControlGatewayHandlerContext,
        payload: JsonValue,
      ) => unknown | Promise<unknown>;
    }>;

type RouteSnapshot = GatewayRoute;

export type GatewayRouteRegistry = Readonly<{
  lookup(
    channel: GatewayChannel,
    kind: GatewayKind,
    capability: string,
  ): RouteSnapshot | undefined;
}>;

export type ParsedGatewayRequest = Readonly<{
  version: 1;
  requestId: string;
  kind: GatewayKind;
  capability: string;
  payload: Readonly<Record<string, JsonValue>>;
}>;

export type GatewayResponse =
  | Readonly<{ version: 1; requestId: string; ok: true; result: JsonValue }>
  | Readonly<{
      version: 1;
      requestId: string;
      ok: false;
      error: Readonly<{ code: "CAPABILITY_DENIED" | "HANDLER_FAILED" }>;
    }>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_KINDS = new Set<GatewayKind>([
  "read",
  "prepare",
  "execute",
  "system_reply",
]);
const ROUTE_KEYS = [
  "channel",
  "kind",
  "capability",
  "parsePayload",
  "handler",
] as const;
const TRUSTED_ROUTE_REGISTRIES = new WeakSet<object>();

function schemaError(message: string): Error {
  return new Error(`Gateway schema error: ${message}`);
}

function isRecord(
  value: unknown,
): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key) => !expected.includes(key))
  ) {
    throw schemaError("unexpected fields");
  }
}

function routeKey(
  channel: GatewayChannel,
  kind: GatewayKind,
  capability: string,
): string {
  return `${channel}\u0000${kind}\u0000${capability}`;
}

function isBoundIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f);
    })
  );
}

function assertTrustedRegistry(registry: GatewayRouteRegistry): void {
  if (
    registry === null ||
    typeof registry !== "object" ||
    !TRUSTED_ROUTE_REGISTRIES.has(registry)
  ) {
    throw schemaError("untrusted route registry");
  }
}

function snapshotRoute(value: unknown): RouteSnapshot {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
    throw schemaError("unsafe route");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw schemaError("route must be plain");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== ROUTE_KEYS.length ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !ROUTE_KEYS.includes(key as (typeof ROUTE_KEYS)[number]),
    )
  ) {
    throw schemaError("route fields must be exact");
  }
  const fields: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of ROUTE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw schemaError("route contains accessor or hidden field");
    }
    fields[key] = descriptor.value;
  }
  const { channel, kind, capability, parsePayload, handler } = fields;
  if (channel !== "run" && channel !== "control")
    throw schemaError("invalid route channel");
  if (
    typeof kind !== "string" ||
    !["read", "prepare", "execute", "system_reply", "control"].includes(kind)
  ) {
    throw schemaError("invalid route kind");
  }
  if (
    (channel === "run" && !RUN_KINDS.has(kind as GatewayKind)) ||
    (channel === "control" && kind !== "control")
  ) {
    throw schemaError("route kind does not match channel");
  }
  if (!isBoundIdentifier(capability)) {
    throw schemaError("invalid route capability");
  }
  if (
    typeof parsePayload !== "function" ||
    typeof handler !== "function" ||
    utilTypes.isProxy(parsePayload) ||
    utilTypes.isProxy(handler)
  ) {
    throw schemaError("invalid route functions");
  }
  return Object.freeze({
    channel,
    kind: kind as GatewayKind,
    capability,
    parsePayload: parsePayload as GatewayRoute["parsePayload"],
    handler: handler as GatewayRoute["handler"],
  }) as RouteSnapshot;
}

export function createGatewayRouteRegistry(
  routes: readonly GatewayRoute[],
): GatewayRouteRegistry {
  if (
    !Array.isArray(routes) ||
    utilTypes.isProxy(routes) ||
    Object.getPrototypeOf(routes) !== Array.prototype
  ) {
    throw schemaError("unsafe registry input");
  }
  const ownKeys = Reflect.ownKeys(routes);
  const expectedKeys = new Set<string>([
    "length",
    ...Array.from({ length: routes.length }, (_, index) => String(index)),
  ]);
  if (
    ownKeys.length !== expectedKeys.size ||
    ownKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key))
  ) {
    throw schemaError("registry contains hidden fields");
  }
  const map = new Map<string, RouteSnapshot>();
  for (let index = 0; index < routes.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(routes, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw schemaError("registry is sparse or accessor-backed");
    }
    const route = snapshotRoute(descriptor.value);
    const key = routeKey(route.channel, route.kind, route.capability);
    if (map.has(key)) throw schemaError("duplicate route");
    map.set(key, route);
  }
  const registry = Object.freeze({
    lookup(channel: GatewayChannel, kind: GatewayKind, capability: string) {
      return map.get(routeKey(channel, kind, capability));
    },
  });
  TRUSTED_ROUTE_REGISTRIES.add(registry);
  return registry;
}

export const EMPTY_GATEWAY_ROUTE_REGISTRY = createGatewayRouteRegistry([]);

function parseEnvelope(
  input: unknown,
  channel?: GatewayChannel,
): ParsedGatewayRequest {
  let candidate: unknown = input;
  if (typeof candidate === "string") candidate = parseStrictJsonText(candidate);
  else candidate = snapshotStrictJson(candidate);
  if (!isRecord(candidate)) throw schemaError("request root must be an object");

  const resolvedChannel =
    channel ?? (Object.hasOwn(candidate, "operation") ? "control" : "run");
  if (resolvedChannel === "run") {
    assertExactKeys(candidate, [
      "version",
      "requestId",
      "kind",
      "capability",
      "payload",
    ]);
    if (candidate.version !== 1) throw schemaError("unsupported version");
    if (
      typeof candidate.requestId !== "string" ||
      !UUID_PATTERN.test(candidate.requestId)
    ) {
      throw schemaError("invalid request id");
    }
    if (
      typeof candidate.kind !== "string" ||
      !RUN_KINDS.has(candidate.kind as GatewayKind)
    ) {
      throw schemaError("invalid request kind");
    }
    if (!isBoundIdentifier(candidate.capability)) {
      throw schemaError("invalid capability");
    }
    if (!isRecord(candidate.payload))
      throw schemaError("payload must be an object");
    if (!GatewayRequestSchema.safeParse(candidate).success) {
      throw schemaError("request does not match the shared gateway contract");
    }
    return Object.freeze({
      version: 1,
      requestId: candidate.requestId,
      kind: candidate.kind as GatewayKind,
      capability: candidate.capability,
      payload: candidate.payload,
    });
  }

  assertExactKeys(candidate, ["version", "requestId", "operation", "payload"]);
  if (candidate.version !== 1) throw schemaError("unsupported version");
  if (
    typeof candidate.requestId !== "string" ||
    !UUID_PATTERN.test(candidate.requestId)
  ) {
    throw schemaError("invalid request id");
  }
  if (!isBoundIdentifier(candidate.operation)) {
    throw schemaError("invalid operation");
  }
  if (!isRecord(candidate.payload))
    throw schemaError("payload must be an object");
  return Object.freeze({
    version: 1,
    requestId: candidate.requestId,
    kind: "control",
    capability: candidate.operation,
    payload: candidate.payload,
  });
}

export function parseGatewayRequest(
  input: unknown,
  registry: GatewayRouteRegistry = EMPTY_GATEWAY_ROUTE_REGISTRY,
  channel?: GatewayChannel,
): ParsedGatewayRequest {
  assertTrustedRegistry(registry);
  const request = parseEnvelope(input, channel);
  const resolvedChannel =
    channel ?? (request.kind === "control" ? "control" : "run");
  if (!registry.lookup(resolvedChannel, request.kind, request.capability)) {
    throw schemaError("route is not registered");
  }
  return request;
}

function snapshotContext(
  channel: GatewayChannel,
  value: unknown,
): GatewayHandlerContext {
  const candidate = snapshotStrictJson(value);
  if (!isRecord(candidate)) throw schemaError("context must be an object");
  if (channel === "run") {
    assertExactKeys(candidate, [
      "channel",
      "taskId",
      "presidentOpenId",
      "presidentChatId",
      "capabilities",
    ]);
    if (
      candidate.channel !== "run" ||
      typeof candidate.taskId !== "string" ||
      !UUID_PATTERN.test(candidate.taskId) ||
      !isBoundIdentifier(candidate.presidentOpenId) ||
      !isBoundIdentifier(candidate.presidentChatId) ||
      !Array.isArray(candidate.capabilities) ||
      candidate.capabilities.some((item) => !isBoundIdentifier(item))
    ) {
      throw schemaError("invalid run context");
    }
  } else {
    assertExactKeys(candidate, ["channel", "bridgeInstanceId", "releaseHash"]);
    if (
      candidate.channel !== "control" ||
      typeof candidate.bridgeInstanceId !== "string" ||
      !UUID_PATTERN.test(candidate.bridgeInstanceId) ||
      typeof candidate.releaseHash !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(candidate.releaseHash)
    ) {
      throw schemaError("invalid control context");
    }
  }
  return candidate as GatewayHandlerContext;
}

export function snapshotGatewayContext(
  channel: GatewayChannel,
  value: unknown,
): GatewayHandlerContext {
  return snapshotContext(channel, value);
}

function denied(requestId: string): GatewayResponse {
  return Object.freeze({
    version: 1,
    requestId,
    ok: false,
    error: Object.freeze({ code: "CAPABILITY_DENIED" as const }),
  });
}

function failed(requestId: string): GatewayResponse {
  return Object.freeze({
    version: 1,
    requestId,
    ok: false,
    error: Object.freeze({ code: "HANDLER_FAILED" as const }),
  });
}

export async function dispatchGatewayRequest(
  channel: GatewayChannel,
  input: unknown,
  registry: GatewayRouteRegistry,
  context: unknown,
): Promise<GatewayResponse> {
  assertTrustedRegistry(registry);
  const request = parseEnvelope(input, channel);
  const route = registry.lookup(channel, request.kind, request.capability);
  if (!route) return denied(request.requestId);

  const trustedContext = snapshotContext(channel, context);
  if (channel === "run") {
    if (trustedContext.channel !== "run") {
      throw schemaError("run context channel mismatch");
    }
    const capabilities = trustedContext.capabilities;
    if (
      !Array.isArray(capabilities) ||
      !capabilities.includes(request.capability)
    ) {
      return denied(request.requestId);
    }
  }

  let payload: JsonValue;
  try {
    payload = snapshotStrictJson(route.parsePayload(request.payload));
  } catch {
    return denied(request.requestId);
  }
  try {
    let rawResult: unknown;
    if (route.channel === "run") {
      if (trustedContext.channel !== "run")
        throw schemaError("route context mismatch");
      rawResult = await route.handler(trustedContext, payload);
    } else {
      if (trustedContext.channel !== "control")
        throw schemaError("route context mismatch");
      rawResult = await route.handler(trustedContext, payload);
    }
    const result = snapshotStrictJson(rawResult);
    const response = Object.freeze({
      version: 1,
      requestId: request.requestId,
      ok: true,
      result,
    } as const);
    encodeFrame(response);
    return response;
  } catch {
    return failed(request.requestId);
  }
}
