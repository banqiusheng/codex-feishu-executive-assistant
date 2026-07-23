import { types as utilTypes } from "node:util";
import type { Readable } from "node:stream";

import { snapshotExactOwnDataOptions } from "../internal/exact-options.js";

export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_JSON_DEPTH = 64;
export const MAX_JSON_NODES = 10_000;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonArray = ReadonlyArray<JsonValue>;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonArray
  | JsonObject;

function protocolError(message: string): Error {
  return new Error(`IPC protocol error: ${message}`);
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

class StrictJsonParser {
  readonly #text: string;
  #offset = 0;
  #nodes = 0;

  constructor(text: string) {
    this.#text = text;
  }

  parse(): JsonValue {
    this.#skipWhitespace();
    const value = this.#value(1);
    this.#skipWhitespace();
    if (this.#offset !== this.#text.length)
      throw protocolError("trailing JSON data");
    return value;
  }

  #value(depth: number): JsonValue {
    if (depth > MAX_JSON_DEPTH)
      throw protocolError("JSON depth limit exceeded");
    this.#nodes += 1;
    if (this.#nodes > MAX_JSON_NODES)
      throw protocolError("JSON node limit exceeded");
    const current = this.#text[this.#offset];
    if (current === "{") return this.#object(depth);
    if (current === "[") return this.#array(depth);
    if (current === '"') return this.#string();
    if (current === "t" && this.#consumeLiteral("true")) return true;
    if (current === "f" && this.#consumeLiteral("false")) return false;
    if (current === "n" && this.#consumeLiteral("null")) return null;
    return this.#number();
  }

  #object(depth: number): JsonValue {
    this.#offset += 1;
    const result: Record<string, JsonValue> = Object.create(null) as Record<
      string,
      JsonValue
    >;
    const keys = new Set<string>();
    this.#skipWhitespace();
    if (this.#text[this.#offset] === "}") {
      this.#offset += 1;
      return Object.freeze(result);
    }
    for (;;) {
      if (this.#text[this.#offset] !== '"')
        throw protocolError("invalid object key");
      const key = this.#string();
      if (keys.has(key)) throw protocolError("duplicate object key");
      keys.add(key);
      this.#skipWhitespace();
      if (this.#text[this.#offset] !== ":")
        throw protocolError("missing object separator");
      this.#offset += 1;
      this.#skipWhitespace();
      result[key] = this.#value(depth + 1);
      this.#skipWhitespace();
      const separator = this.#text[this.#offset];
      if (separator === "}") {
        this.#offset += 1;
        return Object.freeze(result);
      }
      if (separator !== ",") throw protocolError("invalid object separator");
      this.#offset += 1;
      this.#skipWhitespace();
    }
  }

  #array(depth: number): JsonValue {
    this.#offset += 1;
    const result: JsonValue[] = [];
    this.#skipWhitespace();
    if (this.#text[this.#offset] === "]") {
      this.#offset += 1;
      return Object.freeze(result);
    }
    for (;;) {
      result.push(this.#value(depth + 1));
      this.#skipWhitespace();
      const separator = this.#text[this.#offset];
      if (separator === "]") {
        this.#offset += 1;
        return Object.freeze(result);
      }
      if (separator !== ",") throw protocolError("invalid array separator");
      this.#offset += 1;
      this.#skipWhitespace();
    }
  }

  #string(): string {
    const start = this.#offset;
    this.#offset += 1;
    for (;;) {
      if (this.#offset >= this.#text.length)
        throw protocolError("unterminated string");
      const code = this.#text.charCodeAt(this.#offset);
      if (code === 0x22) {
        this.#offset += 1;
        let decoded: unknown;
        try {
          decoded = JSON.parse(this.#text.slice(start, this.#offset));
        } catch {
          throw protocolError("invalid string");
        }
        if (typeof decoded !== "string" || hasLoneSurrogate(decoded)) {
          throw protocolError("invalid Unicode string");
        }
        return decoded;
      }
      if (code <= 0x1f) throw protocolError("control character in string");
      if (code === 0x5c) {
        this.#offset += 1;
        const escape = this.#text[this.#offset];
        if (escape === "u") {
          const digits = this.#text.slice(this.#offset + 1, this.#offset + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(digits))
            throw protocolError("invalid Unicode escape");
          this.#offset += 5;
          continue;
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) {
          throw protocolError("invalid string escape");
        }
      }
      this.#offset += 1;
    }
  }

  #number(): number {
    const rest = this.#text.slice(this.#offset);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (!match) throw protocolError("invalid JSON value");
    this.#offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw protocolError("non-finite number");
    return value;
  }

  #consumeLiteral(literal: string): boolean {
    if (!this.#text.startsWith(literal, this.#offset)) return false;
    this.#offset += literal.length;
    return true;
  }

  #skipWhitespace(): void {
    while (
      /\s/u.test(this.#text[this.#offset] ?? "") &&
      " \t\r\n".includes(this.#text[this.#offset] ?? "")
    ) {
      this.#offset += 1;
    }
  }
}

export function parseStrictJsonValue(text: string): JsonValue {
  if (typeof text !== "string") throw protocolError("body is not text");
  return new StrictJsonParser(text).parse();
}

export function parseStrictJsonText(
  text: string,
): Readonly<Record<string, JsonValue>> {
  const value = parseStrictJsonValue(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError("root must be an object");
  }
  return value as Readonly<Record<string, JsonValue>>;
}

function snapshotValue(
  value: unknown,
  depth: number,
  state: { nodes: number },
): JsonValue {
  if (depth > MAX_JSON_DEPTH) throw protocolError("JSON depth limit exceeded");
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES)
    throw protocolError("JSON node limit exceeded");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) throw protocolError("invalid Unicode string");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw protocolError("non-finite number");
    return value;
  }
  if (typeof value !== "object" || utilTypes.isProxy(value)) {
    throw protocolError("value is not strict JSON");
  }
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== value.length + 1 ||
      keys.some((key) => {
        if (typeof key === "symbol") return true;
        if (key === "length") return false;
        if (!/^(?:0|[1-9]\d*)$/.test(key)) return true;
        const index = Number(key);
        return !Number.isSafeInteger(index) || index >= value.length;
      })
    ) {
      throw protocolError("unsafe array properties");
    }
    const copy: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw protocolError("sparse or accessor array");
      }
      copy.push(snapshotValue(descriptor.value, depth + 1, state));
    }
    return Object.freeze(copy);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw protocolError("non-plain JSON object");
  const copy: Record<string, JsonValue> = Object.create(null) as Record<
    string,
    JsonValue
  >;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") throw protocolError("symbol property");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw protocolError("hidden or accessor property");
    }
    copy[key] = snapshotValue(descriptor.value, depth + 1, state);
  }
  return Object.freeze(copy);
}

export function snapshotStrictJson(value: unknown): JsonValue {
  return snapshotValue(value, 1, { nodes: 0 });
}

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(snapshotStrictJson(value)), "utf8");
  if (body.length < 1 || body.length > MAX_FRAME_BYTES)
    throw protocolError("invalid frame length");
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export function decodeFrame(
  frame: Buffer | Uint8Array,
): Readonly<Record<string, JsonValue>> {
  const bytes = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
  if (bytes.length < 4) throw protocolError("missing frame header");
  const length = bytes.readUInt32BE(0);
  if (length < 1 || length > MAX_FRAME_BYTES || bytes.length !== length + 4) {
    throw protocolError("invalid frame length");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4));
  } catch {
    throw protocolError("invalid UTF-8");
  }
  return parseStrictJsonText(text);
}

export function readSingleFrame(
  source: Readable,
  options: Readonly<{ timeoutMs?: number }> = {},
): Promise<Readonly<Record<string, JsonValue>>> {
  let stableOptions: Readonly<Record<string, unknown>>;
  try {
    stableOptions = snapshotExactOwnDataOptions(options, [], ["timeoutMs"]);
  } catch {
    return Promise.reject(protocolError("invalid options"));
  }
  const timeoutMs = stableOptions.timeoutMs ?? 5_000;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0
  )
    return Promise.reject(protocolError("invalid timeout"));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const header = Buffer.allocUnsafe(4);
    let headerBytes = 0;
    let declaredLength: number | undefined;
    let total = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      source.off("data", onData);
      source.off("end", onEnd);
      source.off("error", onError);
      source.off("aborted", onAborted);
      source.off("close", onClose);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: unknown) => {
      if (!(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)) {
        fail(protocolError("non-binary stream chunk"));
        return;
      }
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_FRAME_BYTES + 4) {
        fail(protocolError("frame too large"));
        return;
      }
      chunks.push(bytes);
      if (headerBytes < 4) {
        const copied = Math.min(4 - headerBytes, bytes.length);
        bytes.copy(header, headerBytes, 0, copied);
        headerBytes += copied;
        if (headerBytes === 4) {
          declaredLength = header.readUInt32BE(0);
          if (declaredLength < 1 || declaredLength > MAX_FRAME_BYTES) {
            fail(protocolError("invalid frame length"));
            return;
          }
        }
      }
      if (declaredLength !== undefined && total > declaredLength + 4) {
        fail(protocolError("invalid frame length"));
      }
    };
    const onEnd = () => {
      if (settled) return;
      try {
        const value = decodeFrame(Buffer.concat(chunks, total));
        settled = true;
        cleanup();
        resolve(value);
      } catch (error) {
        fail(error instanceof Error ? error : protocolError("invalid frame"));
      }
    };
    const onError = () => fail(protocolError("stream failed"));
    const onAborted = () => fail(protocolError("stream aborted"));
    const onClose = () => fail(protocolError("stream closed before EOF"));
    const timer = setTimeout(
      () => fail(protocolError("frame timeout")),
      timeoutMs,
    );
    timer.unref?.();
    source.on("data", onData);
    source.once("end", onEnd);
    source.once("error", onError);
    source.once("aborted", onAborted);
    source.once("close", onClose);
  });
}
