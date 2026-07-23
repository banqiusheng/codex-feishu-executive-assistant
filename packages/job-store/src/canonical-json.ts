import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import { canonicalize } from "json-canonicalize";

import { RuntimeStateError } from "./types.js";

export type StrictIJson =
  | null
  | boolean
  | number
  | string
  | readonly StrictIJson[]
  | StrictIJsonObject;

export interface StrictIJsonObject {
  readonly [key: string]: StrictIJson;
}

function isProxy(value: object): boolean {
  try {
    return utilTypes.isProxy(value);
  } catch {
    return true;
  }
}

function invalid(detail: string): never {
  throw new RuntimeStateError(detail);
}

const MAX_DEPTH = 64;
const MAX_NODES = 10_000;
const LONE_SURROGATE =
  /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u;

type SnapshotContext = Readonly<{
  seen: WeakSet<object>;
  nodes: { value: number };
}>;

function validString(value: string): boolean {
  return !LONE_SURROGATE.test(value);
}

function nextNode(
  context: SnapshotContext,
  depth: number,
  detail: string,
): void {
  context.nodes.value += 1;
  if (depth > MAX_DEPTH || context.nodes.value > MAX_NODES) invalid(detail);
}

function snapshotArray(
  value: readonly unknown[],
  detail: string,
  context: SnapshotContext,
  depth: number,
): StrictIJson {
  if (isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return invalid(detail);
  }
  if (context.seen.has(value)) return invalid(detail);
  context.seen.add(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    !keys.includes("length") ||
    !keys.every(
      (key) =>
        key === "length" ||
        (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)),
    )
  ) {
    return invalid(detail);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copy: StrictIJson[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      return invalid(detail);
    }
    copy.push(snapshotValue(descriptor.value, detail, context, depth + 1));
  }
  return Object.freeze(copy);
}

function snapshotObject(
  value: object,
  detail: string,
  context: SnapshotContext,
  depth: number,
): StrictIJson {
  if (isProxy(value)) return invalid(detail);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return invalid(detail);
  if (context.seen.has(value)) return invalid(detail);
  context.seen.add(value);
  const keys = Reflect.ownKeys(value);
  if (!keys.every((key) => typeof key === "string")) return invalid(detail);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copy = Object.create(null) as Record<string, StrictIJson>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      return invalid(detail);
    }
    if (!validString(key)) return invalid(detail);
    Object.defineProperty(copy, key, {
      configurable: false,
      enumerable: true,
      value: snapshotValue(descriptor.value, detail, context, depth + 1),
      writable: false,
    });
  }
  return Object.freeze(copy);
}

function snapshotValue(
  value: unknown,
  detail: string,
  context: SnapshotContext,
  depth: number,
): StrictIJson {
  nextNode(context, depth, detail);
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string")
    return validString(value) ? value : invalid(detail);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return invalid(detail);
    return value;
  }
  if (typeof value !== "object") return invalid(detail);
  return Array.isArray(value)
    ? snapshotArray(value, detail, context, depth)
    : snapshotObject(value, detail, context, depth);
}

export function snapshotStrictIJson(
  value: unknown,
  detail = "action_payload_must_be_strict_i_json",
): StrictIJson {
  return snapshotValue(
    value,
    detail,
    { nodes: { value: 0 }, seen: new WeakSet<object>() },
    0,
  );
}

export function canonicalStrictIJson(value: StrictIJson): string {
  return canonicalize(value);
}

export function payloadHash(value: StrictIJson): string {
  return `sha256:${createHash("sha256")
    .update(canonicalStrictIJson(value), "utf8")
    .digest("hex")}`;
}
