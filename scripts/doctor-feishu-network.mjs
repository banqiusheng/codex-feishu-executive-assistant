import { Buffer } from "node:buffer";
import dns from "node:dns";
import https from "node:https";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { TextDecoder, types as utilTypes } from "node:util";

const DNS_HOST = "open.feishu.cn";
const HTTPS_ENDPOINT = "https://open.feishu.cn/open-apis/";
const HTTPS_TIMEOUT_MS = 4_000;
const MAX_OUTPUT_BYTES = 4_096;
const DNS_CLASSIFICATIONS = new Set(["PASS", "DNS_UNAVAILABLE"]);
const HTTPS_CLASSIFICATIONS = new Set(["PASS", "REST_UNREACHABLE"]);
const MINIMAL_ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "C",
  LC_ALL: "C",
});

export function sanitizeProbeEnvironment(environment) {
  try {
    if (
      environment === null ||
      typeof environment !== "object" ||
      utilTypes.isProxy(environment)
    ) {
      return false;
    }
    for (const key of Object.keys(environment)) {
      if (!Object.hasOwn(MINIMAL_ENVIRONMENT, key)) delete environment[key];
    }
    for (const [key, value] of Object.entries(MINIMAL_ENVIRONMENT)) {
      environment[key] = value;
    }
    const keys = Object.keys(environment);
    return (
      keys.length === Object.keys(MINIMAL_ENVIRONMENT).length &&
      keys.every((key) => environment[key] === MINIMAL_ENVIRONMENT[key])
    );
  } catch {
    return false;
  }
}

function hasLoneSurrogate(value) {
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

class StrictObjectParser {
  #offset = 0;

  constructor(text) {
    this.text = text;
  }

  parse() {
    this.#whitespace();
    const value = this.#object();
    this.#whitespace();
    if (this.#offset !== this.text.length) throw new Error("strict_json");
    return value;
  }

  #object() {
    if (this.text[this.#offset] !== "{") throw new Error("strict_json");
    this.#offset += 1;
    const result = Object.create(null);
    const keys = new Set();
    this.#whitespace();
    if (this.text[this.#offset] === "}") throw new Error("strict_json");
    for (;;) {
      this.#whitespace();
      const key = this.#string();
      if (keys.has(key)) throw new Error("strict_json");
      keys.add(key);
      this.#whitespace();
      if (this.text[this.#offset] !== ":") throw new Error("strict_json");
      this.#offset += 1;
      this.#whitespace();
      result[key] = this.#value();
      this.#whitespace();
      const separator = this.text[this.#offset];
      if (separator === "}") {
        this.#offset += 1;
        return Object.freeze(result);
      }
      if (separator !== ",") throw new Error("strict_json");
      this.#offset += 1;
    }
  }

  #value() {
    const current = this.text[this.#offset];
    if (current === '"') return this.#string();
    const match = /^(?:0|[1-9]\d*)/.exec(this.text.slice(this.#offset));
    if (!match) throw new Error("strict_json");
    this.#offset += match[0].length;
    return Number(match[0]);
  }

  #string() {
    const start = this.#offset;
    if (this.text[this.#offset] !== '"') throw new Error("strict_json");
    this.#offset += 1;
    for (;;) {
      if (this.#offset >= this.text.length) throw new Error("strict_json");
      const code = this.text.charCodeAt(this.#offset);
      if (code === 0x22) {
        this.#offset += 1;
        let value;
        try {
          value = JSON.parse(this.text.slice(start, this.#offset));
        } catch {
          throw new Error("strict_json");
        }
        if (typeof value !== "string" || hasLoneSurrogate(value)) {
          throw new Error("strict_json");
        }
        return value;
      }
      if (code <= 0x1f) throw new Error("strict_json");
      if (code === 0x5c) {
        this.#offset += 1;
        const escape = this.text[this.#offset];
        if (escape === "u") {
          const digits = this.text.slice(this.#offset + 1, this.#offset + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) throw new Error("strict_json");
          this.#offset += 5;
          continue;
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) {
          throw new Error("strict_json");
        }
      }
      this.#offset += 1;
    }
  }

  #whitespace() {
    while (true) {
      const current = this.text[this.#offset];
      if (current === undefined || !" \t\r\n".includes(current)) return;
      this.#offset += 1;
    }
  }
}

function exactOwnData(value, expectedKeys) {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      utilTypes.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    ) {
      return null;
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
    ) {
      return null;
    }
    const copy = Object.create(null);
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        return null;
      copy[key] = descriptor.value;
    }
    return Object.freeze(copy);
  } catch {
    return null;
  }
}

function injectedOption(options, key) {
  const snapshot = exactOwnData(
    options,
    key === "lookup" ? ["lookup"] : ["requestHead"],
  );
  if (
    snapshot === null ||
    typeof snapshot[key] !== "function" ||
    utilTypes.isProxy(snapshot[key])
  ) {
    return null;
  }
  return snapshot[key];
}

function configuredOptions(options) {
  const snapshot = exactOwnData(options, ["lookup", "requestHead"]);
  if (
    snapshot === null ||
    (snapshot.lookup !== undefined &&
      (typeof snapshot.lookup !== "function" ||
        utilTypes.isProxy(snapshot.lookup))) ||
    (snapshot.requestHead !== undefined &&
      (typeof snapshot.requestHead !== "function" ||
        utilTypes.isProxy(snapshot.requestHead)))
  ) {
    return null;
  }
  return snapshot;
}

async function defaultRequestHead(endpoint) {
  return new Promise((resolve, reject) => {
    const request = https.request(endpoint, { method: "HEAD" }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.once("error", reject);
    request.setTimeout(HTTPS_TIMEOUT_MS, () =>
      request.destroy(new Error("timeout")),
    );
    request.end();
  });
}

export async function probeFeishuDns(options = undefined) {
  const lookup =
    options === undefined
      ? dns.promises.lookup
      : injectedOption(options, "lookup");
  if (lookup === null || lookup === undefined) return "DNS_UNAVAILABLE";
  try {
    const records = await lookup(
      DNS_HOST,
      Object.freeze({ all: true, verbatim: true }),
    );
    return Array.isArray(records) && records.length > 0
      ? "PASS"
      : "DNS_UNAVAILABLE";
  } catch {
    return "DNS_UNAVAILABLE";
  }
}

export async function probeFeishuHttpsRest(options = undefined) {
  const requestHead =
    options === undefined
      ? defaultRequestHead
      : injectedOption(options, "requestHead");
  if (requestHead === null || requestHead === undefined)
    return "REST_UNREACHABLE";
  try {
    const statusCode = await requestHead(HTTPS_ENDPOINT);
    return Number.isInteger(statusCode) &&
      statusCode >= 100 &&
      statusCode <= 599
      ? "PASS"
      : "REST_UNREACHABLE";
  } catch {
    return "REST_UNREACHABLE";
  }
}

export async function runConfiguredFeishuProbes(options = undefined) {
  const injected =
    options === undefined
      ? Object.freeze({ lookup: undefined, requestHead: undefined })
      : configuredOptions(options);
  if (injected === null) {
    return Object.freeze({
      schemaVersion: 1,
      dns: "DNS_UNAVAILABLE",
      httpsRest: "REST_UNREACHABLE",
    });
  }
  const [dnsResult, httpsResult] = await Promise.all([
    injected.lookup === undefined
      ? probeFeishuDns()
      : probeFeishuDns({ lookup: injected.lookup }),
    injected.requestHead === undefined
      ? probeFeishuHttpsRest()
      : probeFeishuHttpsRest({ requestHead: injected.requestHead }),
  ]);
  return Object.freeze({
    schemaVersion: 1,
    dns: dnsResult,
    httpsRest: httpsResult,
  });
}

export function parseExactProbeReport(input) {
  let value = input;
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    if (input.byteLength < 1 || input.byteLength > MAX_OUTPUT_BYTES)
      throw new Error("strict_json");
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      throw new Error("strict_json");
    }
    value = new StrictObjectParser(text).parse();
  }
  const snapshot = exactOwnData(value, ["schemaVersion", "dns", "httpsRest"]);
  if (
    snapshot === null ||
    snapshot.schemaVersion !== 1 ||
    typeof snapshot.dns !== "string" ||
    typeof snapshot.httpsRest !== "string" ||
    !DNS_CLASSIFICATIONS.has(snapshot.dns) ||
    !HTTPS_CLASSIFICATIONS.has(snapshot.httpsRest)
  ) {
    throw new Error("strict_json");
  }
  return Object.freeze({
    schemaVersion: 1,
    dns: snapshot.dns,
    httpsRest: snapshot.httpsRest,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = sanitizeProbeEnvironment(process.env)
    ? await runConfiguredFeishuProbes()
    : Object.freeze({
        schemaVersion: 1,
        dns: "DNS_UNAVAILABLE",
        httpsRest: "REST_UNREACHABLE",
      });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
