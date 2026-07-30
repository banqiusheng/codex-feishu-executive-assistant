import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import process from "node:process";
import { isAbsolute, join, resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import { TextDecoder, types as utilTypes } from "node:util";

import { readScopeContract } from "./feishu-scope-contract.mjs";

export const AUTHORIZATION_ORIGIN = "https://accounts.feishu.cn";
export const BLOCKED_USER_AUTH = "BLOCKED_USER_AUTH";
export const USER_AUTH_COMPLETE = "USER_AUTH_COMPLETE";
export const BROWSER_OPENED_MESSAGE = "已打开飞书授权页，请在浏览器完成授权。";
export const MAX_CLI_OUTPUT_BYTES = 64 * 1024;

const OPENER_PATH = "/usr/bin/open";
const LAUNCHCTL_PATH = "/bin/launchctl";
const CLI_PROFILE = "executive-assistant";
const NO_WAIT_TIMEOUT_MS = 30_000;
const OPEN_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 620_000;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 4_096;
const MAX_AUTH_URL_CHARS = 8_192;
const MAX_DEVICE_CODE_CHARS = 2_048;
const MAX_CACHE_BYTES = 16 * 1024;
const BUNDLED_SCOPE_CONTRACT_PATH = fileURLToPath(
  new URL("../config/feishu-scopes.json", import.meta.url),
);
const BUNDLED_SCOPE_CONTRACT_SHA256 =
  "40f77b8df33af965544046313016116fd2a249afaed2d96044649863568db93e";
const NO_WAIT_KEYS = Object.freeze([
  "verification_url",
  "device_code",
  "expires_in",
  "hint",
]);
const AUTH_COMPLETE_KEYS = Object.freeze([
  "event",
  "user_open_id",
  "user_name",
  "scope",
  "requested",
  "newly_granted",
  "already_granted",
  "missing",
  "granted",
]);
const CACHE_KEYS = Object.freeze(["requested_scope"]);
const MINIMAL_CLI_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const PRESENTERS = new Set(["browser", "stdout-json"]);

function authOutputInvalid() {
  return new Error("AUTH_OUTPUT_INVALID");
}

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function hasForbiddenAscii(value, includeSpace) {
  const maximum = includeSpace ? 0x20 : 0x1f;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= maximum || code === 0x7f) return true;
  }
  return false;
}

class StrictJsonParser {
  #offset = 0;
  #nodes = 0;

  constructor(text) {
    this.text = text;
  }

  parse() {
    this.#whitespace();
    const value = this.#value(1);
    this.#whitespace();
    if (this.#offset !== this.text.length) throw authOutputInvalid();
    return value;
  }

  #value(depth) {
    if (depth > MAX_JSON_DEPTH) throw authOutputInvalid();
    this.#nodes += 1;
    if (this.#nodes > MAX_JSON_NODES) throw authOutputInvalid();
    const current = this.text[this.#offset];
    if (current === "{") return this.#object(depth);
    if (current === "[") return this.#array(depth);
    if (current === '"') return this.#string();
    if (current === "t" && this.#literal("true")) return true;
    if (current === "f" && this.#literal("false")) return false;
    if (current === "n" && this.#literal("null")) return null;
    return this.#number();
  }

  #object(depth) {
    this.#offset += 1;
    const result = Object.create(null);
    const keys = new Set();
    this.#whitespace();
    if (this.text[this.#offset] === "}") {
      this.#offset += 1;
      return Object.freeze(result);
    }
    for (;;) {
      if (this.text[this.#offset] !== '"') throw authOutputInvalid();
      const key = this.#string();
      if (keys.has(key)) throw authOutputInvalid();
      keys.add(key);
      this.#whitespace();
      if (this.text[this.#offset] !== ":") throw authOutputInvalid();
      this.#offset += 1;
      this.#whitespace();
      result[key] = this.#value(depth + 1);
      this.#whitespace();
      const separator = this.text[this.#offset];
      if (separator === "}") {
        this.#offset += 1;
        return Object.freeze(result);
      }
      if (separator !== ",") throw authOutputInvalid();
      this.#offset += 1;
      this.#whitespace();
    }
  }

  #array(depth) {
    this.#offset += 1;
    const result = [];
    this.#whitespace();
    if (this.text[this.#offset] === "]") {
      this.#offset += 1;
      return Object.freeze(result);
    }
    for (;;) {
      result.push(this.#value(depth + 1));
      this.#whitespace();
      const separator = this.text[this.#offset];
      if (separator === "]") {
        this.#offset += 1;
        return Object.freeze(result);
      }
      if (separator !== ",") throw authOutputInvalid();
      this.#offset += 1;
      this.#whitespace();
    }
  }

  #string() {
    const start = this.#offset;
    if (this.text[this.#offset] !== '"') throw authOutputInvalid();
    this.#offset += 1;
    for (;;) {
      if (this.#offset >= this.text.length) throw authOutputInvalid();
      const code = this.text.charCodeAt(this.#offset);
      if (code === 0x22) {
        this.#offset += 1;
        let decoded;
        try {
          decoded = JSON.parse(this.text.slice(start, this.#offset));
        } catch {
          throw authOutputInvalid();
        }
        if (typeof decoded !== "string" || hasLoneSurrogate(decoded)) {
          throw authOutputInvalid();
        }
        return decoded;
      }
      if (code <= 0x1f) throw authOutputInvalid();
      if (code === 0x5c) {
        this.#offset += 1;
        const escape = this.text[this.#offset];
        if (escape === "u") {
          const digits = this.text.slice(this.#offset + 1, this.#offset + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) throw authOutputInvalid();
          this.#offset += 5;
          continue;
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) {
          throw authOutputInvalid();
        }
      }
      this.#offset += 1;
    }
  }

  #number() {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.text.slice(this.#offset),
    );
    if (!match) throw authOutputInvalid();
    this.#offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw authOutputInvalid();
    return value;
  }

  #literal(value) {
    if (!this.text.startsWith(value, this.#offset)) return false;
    this.#offset += value.length;
    return true;
  }

  #whitespace() {
    while (
      this.text[this.#offset] !== undefined &&
      " \t\r\n".includes(this.text[this.#offset])
    ) {
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
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true
      ) {
        return null;
      }
      copy[key] = descriptor.value;
    }
    return Object.freeze(copy);
  } catch {
    return null;
  }
}

function parseStrictInput(input, maximumBytes = MAX_CLI_OUTPUT_BYTES) {
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    if (input.byteLength < 1 || input.byteLength > maximumBytes) {
      throw authOutputInvalid();
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      throw authOutputInvalid();
    }
    return new StrictJsonParser(text).parse();
  }
  return input;
}

function noWaitEnvelope(input) {
  const value = parseStrictInput(input);
  const snapshot = exactOwnData(value, NO_WAIT_KEYS);
  if (
    snapshot === null ||
    typeof snapshot.verification_url !== "string" ||
    snapshot.verification_url.length < 1 ||
    snapshot.verification_url.length > MAX_AUTH_URL_CHARS ||
    typeof snapshot.device_code !== "string" ||
    snapshot.device_code.length < 1 ||
    snapshot.device_code.length > MAX_DEVICE_CODE_CHARS ||
    hasForbiddenAscii(snapshot.device_code, false) ||
    typeof snapshot.expires_in !== "number" ||
    !Number.isSafeInteger(snapshot.expires_in) ||
    snapshot.expires_in <= 0 ||
    typeof snapshot.hint !== "string"
  ) {
    throw authOutputInvalid();
  }
  return Object.freeze({
    verificationUrl: snapshot.verification_url,
    deviceCode: snapshot.device_code,
    expiresIn: snapshot.expires_in,
  });
}

function validateAuthorizationUrl(rawUrl) {
  if (
    typeof rawUrl !== "string" ||
    rawUrl.length < 1 ||
    rawUrl.length > MAX_AUTH_URL_CHARS ||
    rawUrl.includes("\\") ||
    rawUrl.includes("#") ||
    hasLoneSurrogate(rawUrl) ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\p{White_Space}]/u.test(rawUrl)
  ) {
    throw authOutputInvalid();
  }
  const authoritySuccessor = rawUrl.slice(AUTHORIZATION_ORIGIN.length)[0] ?? "";
  if (
    !rawUrl.startsWith(AUTHORIZATION_ORIGIN) ||
    !["", "/", "?"].includes(authoritySuccessor)
  ) {
    throw authOutputInvalid();
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw authOutputInvalid();
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== AUTHORIZATION_ORIGIN ||
    parsed.hostname !== "accounts.feishu.cn" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw authOutputInvalid();
  }
  return rawUrl;
}

export function parseNoWaitResponse(input) {
  const parsed = noWaitEnvelope(input);
  validateAuthorizationUrl(parsed.verificationUrl);
  return parsed;
}

function exactStringArray(value) {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) return null;
  const result = [];
  const seen = new Set();
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item.length < 1 ||
      item.length > 512 ||
      hasLoneSurrogate(item) ||
      seen.has(item)
    ) {
      return null;
    }
    seen.add(item);
    result.push(item);
  }
  return Object.freeze(result);
}

function sameOrderedStrings(left, right) {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

export function parseAuthorizationComplete(input, expectedScopes) {
  const scopes = validateScopes(expectedScopes);
  const value = parseStrictInput(input);
  const snapshot = exactOwnData(value, AUTH_COMPLETE_KEYS);
  if (
    snapshot === null ||
    snapshot.event !== "authorization_complete" ||
    typeof snapshot.user_open_id !== "string" ||
    snapshot.user_open_id.length < 1 ||
    snapshot.user_open_id.length > 512 ||
    typeof snapshot.user_name !== "string" ||
    snapshot.user_name.length > 1_024 ||
    typeof snapshot.scope !== "string"
  ) {
    throw authOutputInvalid();
  }
  const requested = exactStringArray(snapshot.requested);
  const newlyGranted = exactStringArray(snapshot.newly_granted);
  const alreadyGranted = exactStringArray(snapshot.already_granted);
  const missing = exactStringArray(snapshot.missing);
  const granted = exactStringArray(snapshot.granted);
  if (
    requested === null ||
    newlyGranted === null ||
    alreadyGranted === null ||
    missing === null ||
    granted === null ||
    !sameOrderedStrings(requested, scopes) ||
    missing.length !== 0 ||
    snapshot.scope !== granted.join(" ")
  ) {
    throw authOutputInvalid();
  }
  const grantedSet = new Set(granted);
  const newlySet = new Set(newlyGranted);
  const alreadySet = new Set(alreadyGranted);
  if (
    scopes.some((scope) => !grantedSet.has(scope)) ||
    scopes.some(
      (scope) =>
        Number(newlySet.has(scope)) + Number(alreadySet.has(scope)) !== 1,
    ) ||
    newlyGranted.some((scope) => !scopes.includes(scope)) ||
    alreadyGranted.some((scope) => !scopes.includes(scope))
  ) {
    throw authOutputInvalid();
  }
  return USER_AUTH_COMPLETE;
}

function validateScopes(
  value,
  allowedScopes = readScopeContract(
    BUNDLED_SCOPE_CONTRACT_PATH,
    BUNDLED_SCOPE_CONTRACT_SHA256,
  ).userScopes,
) {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) {
    throw authOutputInvalid();
  }
  const result = [];
  const seen = new Set();
  for (const scope of value) {
    if (
      typeof scope !== "string" ||
      scope.length < 1 ||
      scope.length > 256 ||
      !/^[A-Za-z0-9._:-]+$/u.test(scope) ||
      seen.has(scope)
    ) {
      throw authOutputInvalid();
    }
    seen.add(scope);
    result.push(scope);
  }
  if (result.length < 1 || result.length > 64) throw authOutputInvalid();
  const positions = result.map((scope) => allowedScopes.indexOf(scope));
  if (
    positions.some((position) => position < 0) ||
    positions.some(
      (position, index) => index > 0 && position <= positions[index - 1],
    )
  ) {
    throw authOutputInvalid();
  }
  return Object.freeze(result);
}

export function sanitizeLoginScopeCacheKey(deviceCode) {
  if (typeof deviceCode !== "string") throw authOutputInvalid();
  const sanitized = deviceCode.replace(/[^A-Za-z0-9._-]/gu, "_");
  return sanitized === "" ? "default" : sanitized;
}

export function authorizationCachePath(larkHome, deviceCode) {
  if (typeof larkHome !== "string" || !isAbsolute(larkHome)) {
    throw authOutputInvalid();
  }
  return join(
    resolve(larkHome),
    ".lark-cli",
    "cache",
    "auth_login_scopes",
    `${sanitizeLoginScopeCacheKey(deviceCode)}.json`,
  );
}

function modeOf(stat) {
  return stat.mode & 0o777;
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

function isMissing(error) {
  return (
    error !== null &&
    typeof error === "object" &&
    Object.hasOwn(error, "code") &&
    error.code === "ENOENT"
  );
}

export function validateRegularExecutable(path) {
  try {
    if (typeof path !== "string" || !isAbsolute(path)) return false;
    const stat = lstatSync(path);
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      realpathSync(path) === resolve(path) &&
      (modeOf(stat) & 0o111) !== 0
    );
  } catch {
    return false;
  }
}

function validatePrivateDirectory(path) {
  try {
    const stat = lstatSync(path);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === currentUid() &&
      modeOf(stat) === 0o700 &&
      realpathSync(path) === resolve(path)
    );
  } catch {
    return false;
  }
}

function cacheDirectoryPath(larkHome) {
  return join(resolve(larkHome), ".lark-cli", "cache", "auth_login_scopes");
}

function flowLockPath(larkHome) {
  return join(
    resolve(larkHome),
    ".lark-cli",
    "cache",
    "executive-assistant-user-auth.lock",
  );
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
  );
}

function ensureCanonicalOwnedDirectory(path) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (
      error === null ||
      typeof error !== "object" ||
      !Object.hasOwn(error, "code") ||
      error.code !== "EEXIST"
    ) {
      throw authOutputInvalid();
    }
  }
  try {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== currentUid() ||
      (modeOf(stat) & 0o022) !== 0 ||
      realpathSync(path) !== resolve(path)
    ) {
      throw authOutputInvalid();
    }
  } catch {
    throw authOutputInvalid();
  }
}

function acquireFlowLock(larkHome) {
  let created = null;
  try {
    const larkRoot = join(resolve(larkHome), ".lark-cli");
    ensureCanonicalOwnedDirectory(larkRoot);
    const parent = join(larkRoot, "cache");
    ensureCanonicalOwnedDirectory(parent);
    const path = flowLockPath(larkHome);
    mkdirSync(path, { mode: 0o700 });
    const initial = lstatSync(path);
    if (
      !initial.isDirectory() ||
      initial.isSymbolicLink() ||
      initial.uid !== currentUid() ||
      realpathSync(path) !== resolve(path)
    ) {
      throw authOutputInvalid();
    }
    created = Object.freeze({
      path,
      dev: initial.dev,
      ino: initial.ino,
      uid: initial.uid,
    });
    chmodSync(path, 0o700);
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !sameIdentity(stat, created) ||
      modeOf(stat) !== 0o700 ||
      realpathSync(path) !== resolve(path)
    ) {
      throw authOutputInvalid();
    }
    return Object.freeze({
      path,
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
    });
  } catch {
    if (created !== null) {
      try {
        const current = lstatSync(created.path);
        if (
          current.isDirectory() &&
          !current.isSymbolicLink() &&
          sameIdentity(current, created) &&
          readdirSync(created.path, { encoding: "utf8" }).length === 0
        ) {
          rmdirSync(created.path);
        }
      } catch {
        // Ownership or cleanup could not be confirmed; leave the path untouched.
      }
    }
    throw authOutputInvalid();
  }
}

function flowLockIsOwned(evidence) {
  try {
    const stat = lstatSync(evidence.path);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      sameIdentity(stat, evidence) &&
      modeOf(stat) === 0o700 &&
      realpathSync(evidence.path) === resolve(evidence.path)
    );
  } catch {
    return false;
  }
}

function releaseFlowLock(evidence) {
  try {
    if (!flowLockIsOwned(evidence)) return false;
    if (readdirSync(evidence.path, { encoding: "utf8" }).length !== 0) {
      return false;
    }
    if (!flowLockIsOwned(evidence)) return false;
    rmdirSync(evidence.path);
    try {
      lstatSync(evidence.path);
      return false;
    } catch (error) {
      return isMissing(error);
    }
  } catch {
    return false;
  }
}

function prepareEmptyCacheDirectory(larkHome, flowLock) {
  if (!flowLockIsOwned(flowLock)) throw authOutputInvalid();
  const path = cacheDirectoryPath(larkHome);
  let existed = true;
  try {
    lstatSync(path);
  } catch (error) {
    if (!isMissing(error)) throw authOutputInvalid();
    existed = false;
  }
  if (!existed) {
    try {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      chmodSync(path, 0o700);
    } catch {
      throw authOutputInvalid();
    }
  }
  try {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== currentUid() ||
      modeOf(stat) !== 0o700 ||
      realpathSync(path) !== resolve(path) ||
      readdirSync(path, { encoding: "utf8" }).length !== 0 ||
      !flowLockIsOwned(flowLock)
    ) {
      throw authOutputInvalid();
    }
    return Object.freeze({
      path,
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
    });
  } catch {
    throw authOutputInvalid();
  }
}

function cacheDirectoryIsOwned(evidence, flowLock) {
  try {
    if (!flowLockIsOwned(flowLock)) return false;
    const stat = lstatSync(evidence.path);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      sameIdentity(stat, evidence) &&
      modeOf(stat) === 0o700 &&
      realpathSync(evidence.path) === resolve(evidence.path)
    );
  } catch {
    return false;
  }
}

function readBoundedStableDescriptor(descriptor, expectedIdentity) {
  const before = fstatSync(descriptor);
  if (
    !before.isFile() ||
    !sameIdentity(before, expectedIdentity) ||
    before.size < 1 ||
    before.size > MAX_CACHE_BYTES ||
    modeOf(before) !== 0o600
  ) {
    throw authOutputInvalid();
  }
  const bytes = Buffer.alloc(MAX_CACHE_BYTES + 1);
  let offset = 0;
  for (;;) {
    const read = readSync(
      descriptor,
      bytes,
      offset,
      bytes.byteLength - offset,
      null,
    );
    if (read === 0) break;
    offset += read;
    if (offset > MAX_CACHE_BYTES) throw authOutputInvalid();
  }
  const after = fstatSync(descriptor);
  if (
    !sameIdentity(after, before) ||
    after.size !== before.size ||
    after.size !== offset ||
    modeOf(after) !== 0o600
  ) {
    throw authOutputInvalid();
  }
  return bytes.subarray(0, offset);
}

function inspectCacheFile(path, requestedScope, cacheDirectory, flowLock) {
  let descriptor;
  try {
    if (!cacheDirectoryIsOwned(cacheDirectory, flowLock)) {
      throw authOutputInvalid();
    }
    const before = lstatSync(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.uid !== currentUid() ||
      modeOf(before) !== 0o600 ||
      before.size < 1 ||
      before.size > MAX_CACHE_BYTES ||
      realpathSync(path) !== resolve(path)
    ) {
      throw authOutputInvalid();
    }
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const content = readBoundedStableDescriptor(descriptor, before);
    const value = parseStrictInput(content, MAX_CACHE_BYTES);
    const snapshot = exactOwnData(value, CACHE_KEYS);
    if (snapshot === null || snapshot.requested_scope !== requestedScope) {
      throw authOutputInvalid();
    }
    const finalPath = lstatSync(path);
    if (
      !sameIdentity(finalPath, before) ||
      !finalPath.isFile() ||
      finalPath.isSymbolicLink() ||
      finalPath.size !== before.size ||
      modeOf(finalPath) !== 0o600 ||
      !cacheDirectoryIsOwned(cacheDirectory, flowLock)
    ) {
      throw authOutputInvalid();
    }
    return Object.freeze({
      path,
      dev: before.dev,
      ino: before.ino,
      uid: before.uid,
      size: before.size,
      requestedScope,
      cacheDirectory,
    });
  } catch {
    throw authOutputInvalid();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function verifyOwnedCache(
  larkHome,
  deviceCode,
  requestedScope,
  cacheDirectory,
  flowLock,
) {
  return inspectCacheFile(
    authorizationCachePath(larkHome, deviceCode),
    requestedScope,
    cacheDirectory,
    flowLock,
  );
}

function cleanupOwnedCache(evidence, flowLock) {
  let descriptor;
  try {
    if (!cacheDirectoryIsOwned(evidence.cacheDirectory, flowLock)) return false;
    const before = lstatSync(evidence.path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      !sameIdentity(before, evidence) ||
      before.size !== evidence.size ||
      modeOf(before) !== 0o600 ||
      realpathSync(evidence.path) !== resolve(evidence.path)
    ) {
      return false;
    }
    descriptor = openSync(
      evidence.path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const content = readBoundedStableDescriptor(descriptor, evidence);
    const value = parseStrictInput(content, MAX_CACHE_BYTES);
    const snapshot = exactOwnData(value, CACHE_KEYS);
    if (
      snapshot === null ||
      snapshot.requested_scope !== evidence.requestedScope
    ) {
      return false;
    }
    const finalPath = lstatSync(evidence.path);
    if (
      !sameIdentity(finalPath, evidence) ||
      finalPath.size !== evidence.size ||
      modeOf(finalPath) !== 0o600 ||
      !cacheDirectoryIsOwned(evidence.cacheDirectory, flowLock)
    ) {
      return false;
    }
    unlinkSync(evidence.path);
    try {
      lstatSync(evidence.path);
      return false;
    } catch (error) {
      return isMissing(error);
    }
  } catch (error) {
    return isMissing(error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function reconcileUnknownNoWaitCache(cacheDirectory, requestedScope, flowLock) {
  try {
    if (!cacheDirectoryIsOwned(cacheDirectory, flowLock)) return false;
    const names = readdirSync(cacheDirectory.path, { encoding: "utf8" });
    if (names.length === 0) {
      return cacheDirectoryIsOwned(cacheDirectory, flowLock);
    }
    if (
      names.length !== 1 ||
      typeof names[0] !== "string" ||
      names[0].length < 1 ||
      names[0].includes("/") ||
      names[0].includes("\0")
    ) {
      return false;
    }
    const evidence = inspectCacheFile(
      join(cacheDirectory.path, names[0]),
      requestedScope,
      cacheDirectory,
      flowLock,
    );
    return cleanupOwnedCache(evidence, flowLock);
  } catch {
    return false;
  }
}

function decodeProcessStreams(result) {
  const snapshot = exactOwnData(result, ["status", "stdout", "stderr"]);
  if (
    snapshot === null ||
    !Number.isInteger(snapshot.status) ||
    snapshot.status < 0 ||
    !(
      Buffer.isBuffer(snapshot.stdout) || snapshot.stdout instanceof Uint8Array
    ) ||
    !(
      Buffer.isBuffer(snapshot.stderr) || snapshot.stderr instanceof Uint8Array
    ) ||
    snapshot.stdout.byteLength > MAX_CLI_OUTPUT_BYTES ||
    snapshot.stderr.byteLength > MAX_CLI_OUTPUT_BYTES
  ) {
    throw authOutputInvalid();
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(snapshot.stdout);
    new TextDecoder("utf-8", { fatal: true }).decode(snapshot.stderr);
  } catch {
    throw authOutputInvalid();
  }
  return snapshot;
}

export function createBoundedCommandRunner(spawnImplementation = spawn) {
  if (
    typeof spawnImplementation !== "function" ||
    utilTypes.isProxy(spawnImplementation)
  ) {
    throw authOutputInvalid();
  }
  return (request) =>
    new Promise((resolveCommand) => {
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let forcedFailure = false;
      let child;
      let childCreated = false;
      const signal = request.abortSignal;
      const onAbort = () => killAndWaitForClose();
      const settle = (status) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener?.("abort", onAbort);
        const resolvedStdout = forcedFailure
          ? Buffer.alloc(0)
          : Buffer.concat(stdout, stdoutBytes);
        const resolvedStderr = forcedFailure
          ? Buffer.alloc(0)
          : Buffer.concat(stderr, stderrBytes);
        resolveCommand(
          Object.freeze({
            status:
              !forcedFailure && Number.isInteger(status) && status >= 0
                ? status
                : 1,
            stdout: resolvedStdout,
            stderr: resolvedStderr,
          }),
        );
      };
      const killAndWaitForClose = () => {
        if (settled || forcedFailure) return;
        forcedFailure = true;
        stdout.length = 0;
        stderr.length = 0;
        stdoutBytes = 0;
        stderrBytes = 0;
        try {
          child?.kill("SIGKILL");
        } catch {
          // The observed close remains the settlement boundary.
        }
      };
      const timeout = setTimeout(killAndWaitForClose, request.timeoutMs);
      if (signal?.aborted === true) {
        forcedFailure = true;
        settle(1);
        return;
      }
      try {
        child = spawnImplementation(request.executable, request.args, {
          env: request.environment,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        childCreated = true;
        child.once("close", settle);
        child.once("error", killAndWaitForClose);
        child.stdout.on("error", killAndWaitForClose);
        child.stderr.on("error", killAndWaitForClose);
        const collect = (chunks, kind) => (chunk) => {
          if (settled || forcedFailure) return;
          const buffer = Buffer.from(chunk);
          if (kind === "stdout") {
            stdoutBytes += buffer.byteLength;
            if (stdoutBytes > MAX_CLI_OUTPUT_BYTES) {
              killAndWaitForClose();
              return;
            }
          } else {
            stderrBytes += buffer.byteLength;
            if (stderrBytes > MAX_CLI_OUTPUT_BYTES) {
              killAndWaitForClose();
              return;
            }
          }
          chunks.push(buffer);
        };
        child.stdout.on("data", collect(stdout, "stdout"));
        child.stderr.on("data", collect(stderr, "stderr"));
        signal?.addEventListener?.("abort", onAbort, { once: true });
        if (signal?.aborted === true) onAbort();
      } catch {
        if (childCreated) {
          killAndWaitForClose();
        } else {
          forcedFailure = true;
          settle(1);
        }
      }
    });
}

const runBoundedCommand = createBoundedCommandRunner();

function productionHasGuiSession() {
  if (
    process.platform !== "darwin" ||
    typeof process.getuid !== "function" ||
    !validateRegularExecutable(LAUNCHCTL_PATH)
  ) {
    return false;
  }
  const result = spawnSync(
    LAUNCHCTL_PATH,
    ["print", `gui/${process.getuid()}`],
    {
      env: {
        PATH: MINIMAL_CLI_PATH,
        LANG: "C",
        LC_ALL: "C",
      },
      shell: false,
      stdio: "ignore",
      timeout: 5_000,
    },
  );
  return result.status === 0 && result.error === undefined;
}

const PRODUCTION_DEPENDENCIES = Object.freeze({
  abortSignal: undefined,
  emit: (message) => process.stdout.write(`${message}\n`),
  hasGuiSession: async () => productionHasGuiSession(),
  runCommand: runBoundedCommand,
});

function validatedDependencies(value) {
  const snapshot = exactOwnData(value, [
    "abortSignal",
    "emit",
    "hasGuiSession",
    "runCommand",
  ]);
  if (
    snapshot === null ||
    (snapshot.abortSignal !== undefined &&
      (snapshot.abortSignal === null ||
        typeof snapshot.abortSignal !== "object" ||
        utilTypes.isProxy(snapshot.abortSignal) ||
        typeof snapshot.abortSignal.aborted !== "boolean" ||
        typeof snapshot.abortSignal.addEventListener !== "function" ||
        typeof snapshot.abortSignal.removeEventListener !== "function")) ||
    typeof snapshot.emit !== "function" ||
    utilTypes.isProxy(snapshot.emit) ||
    typeof snapshot.hasGuiSession !== "function" ||
    utilTypes.isProxy(snapshot.hasGuiSession) ||
    typeof snapshot.runCommand !== "function" ||
    utilTypes.isProxy(snapshot.runCommand)
  ) {
    throw authOutputInvalid();
  }
  return snapshot;
}

function validatedRequest(value) {
  const hasPresenter =
    value !== null &&
    typeof value === "object" &&
    !utilTypes.isProxy(value) &&
    Object.hasOwn(value, "presenter");
  const snapshot = exactOwnData(
    value,
    hasPresenter
      ? ["larkCliPath", "larkHome", "missingScopes", "presenter"]
      : ["larkCliPath", "larkHome", "missingScopes"],
  );
  if (
    snapshot === null ||
    typeof snapshot.larkCliPath !== "string" ||
    !isAbsolute(snapshot.larkCliPath) ||
    typeof snapshot.larkHome !== "string" ||
    !isAbsolute(snapshot.larkHome) ||
    (hasPresenter &&
      (typeof snapshot.presenter !== "string" ||
        !PRESENTERS.has(snapshot.presenter)))
  ) {
    throw authOutputInvalid();
  }
  return Object.freeze({
    larkCliPath: snapshot.larkCliPath,
    larkHome: snapshot.larkHome,
    missingScopes: validateScopes(snapshot.missingScopes),
    presenter: hasPresenter ? snapshot.presenter : "browser",
  });
}

export async function runFeishuUserAuth(
  input,
  dependencies = PRODUCTION_DEPENDENCIES,
) {
  let flowLock = null;
  let cacheDirectory = null;
  let ownedCache = null;
  let injected = null;
  let presenter = "browser";
  let noWaitAttempted = false;
  let requestedScope = "";
  let outcome = BLOCKED_USER_AUTH;
  try {
    const request = validatedRequest(input);
    presenter = request.presenter;
    injected = validatedDependencies(dependencies);
    if (
      !validateRegularExecutable(request.larkCliPath) ||
      !validatePrivateDirectory(request.larkHome) ||
      (presenter === "browser" && !validateRegularExecutable(OPENER_PATH))
    ) {
      throw authOutputInvalid();
    }
    flowLock = acquireFlowLock(request.larkHome);
    cacheDirectory = prepareEmptyCacheDirectory(request.larkHome, flowLock);
    requestedScope = request.missingScopes.join(" ");
    const cliEnvironment = Object.freeze({
      HOME: request.larkHome,
      PATH: MINIMAL_CLI_PATH,
      LANG: "C",
      LC_ALL: "C",
    });
    noWaitAttempted = true;
    const noWaitResult = decodeProcessStreams(
      await injected.runCommand(
        Object.freeze({
          executable: request.larkCliPath,
          args: Object.freeze([
            "--profile",
            CLI_PROFILE,
            "auth",
            "login",
            "--scope",
            requestedScope,
            "--no-wait",
            "--json",
          ]),
          environment: cliEnvironment,
          timeoutMs: NO_WAIT_TIMEOUT_MS,
          abortSignal: injected.abortSignal,
        }),
      ),
    );
    if (injected.abortSignal?.aborted === true) throw authOutputInvalid();
    if (noWaitResult.status !== 0) throw authOutputInvalid();
    const noWait = noWaitEnvelope(noWaitResult.stdout);
    ownedCache = verifyOwnedCache(
      request.larkHome,
      noWait.deviceCode,
      requestedScope,
      cacheDirectory,
      flowLock,
    );
    validateAuthorizationUrl(noWait.verificationUrl);
    if (presenter === "browser") {
      if ((await injected.hasGuiSession()) !== true) throw authOutputInvalid();
      const openResult = decodeProcessStreams(
        await injected.runCommand(
          Object.freeze({
            executable: OPENER_PATH,
            args: Object.freeze(["--", noWait.verificationUrl]),
            environment: Object.freeze({
              PATH: MINIMAL_CLI_PATH,
              LANG: "C",
              LC_ALL: "C",
            }),
            timeoutMs: OPEN_TIMEOUT_MS,
            abortSignal: injected.abortSignal,
          }),
        ),
      );
      if (injected.abortSignal?.aborted === true) throw authOutputInvalid();
      if (openResult.status !== 0) throw authOutputInvalid();
      injected.emit(BROWSER_OPENED_MESSAGE);
    } else {
      injected.emit(
        JSON.stringify({
          event: "authorization_url",
          url: noWait.verificationUrl,
        }),
      );
    }
    const pollResult = decodeProcessStreams(
      await injected.runCommand(
        Object.freeze({
          executable: request.larkCliPath,
          args: Object.freeze([
            "--profile",
            CLI_PROFILE,
            "auth",
            "login",
            "--device-code",
            noWait.deviceCode,
            "--json",
          ]),
          environment: cliEnvironment,
          timeoutMs: POLL_TIMEOUT_MS,
          abortSignal: injected.abortSignal,
        }),
      ),
    );
    if (injected.abortSignal?.aborted === true) throw authOutputInvalid();
    if (pollResult.status !== 0) throw authOutputInvalid();
    outcome = parseAuthorizationComplete(
      pollResult.stdout,
      request.missingScopes,
    );
  } catch {
    outcome = BLOCKED_USER_AUTH;
  } finally {
    if (flowLock !== null && cacheDirectory !== null) {
      if (
        ownedCache !== null
          ? !cleanupOwnedCache(ownedCache, flowLock)
          : noWaitAttempted &&
            !reconcileUnknownNoWaitCache(
              cacheDirectory,
              requestedScope,
              flowLock,
            )
      ) {
        outcome = BLOCKED_USER_AUTH;
      }
    }
    if (flowLock !== null && !releaseFlowLock(flowLock)) {
      outcome = BLOCKED_USER_AUTH;
    }
    if (presenter === "stdout-json" && injected !== null) {
      try {
        injected.emit(
          JSON.stringify({
            event: "authorization_result",
            status: outcome === USER_AUTH_COMPLETE ? "complete" : "blocked",
          }),
        );
      } catch {
        outcome = BLOCKED_USER_AUTH;
      }
    }
  }
  return outcome;
}

export async function runFeishuUserAuthMain({ argv, processLike, authorize }) {
  const controller = new globalThis.AbortController();
  const abort = () => controller.abort();
  const signals = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);
  for (const signal of signals) processLike.on(signal, abort);
  let result = BLOCKED_USER_AUTH;
  try {
    if (
      !Array.isArray(argv) ||
      argv.length < 9 ||
      argv[0] !== "--presenter" ||
      !PRESENTERS.has(argv[1]) ||
      argv[2] !== "--scope-contract" ||
      argv[4] !== "--scope-contract-sha256"
    ) {
      throw authOutputInvalid();
    }
    const presenter = argv[1];
    const scopeContractPath = argv[3];
    const scopeContractSha256 = argv[5];
    const larkCliPath = argv[6];
    const larkHome = argv[7];
    const missingScopes = argv.slice(8);
    const contract = readScopeContract(scopeContractPath, scopeContractSha256);
    result = await authorize(
      {
        larkCliPath,
        larkHome,
        missingScopes: validateScopes(missingScopes, contract.userScopes),
        presenter,
      },
      Object.freeze({
        ...PRODUCTION_DEPENDENCIES,
        abortSignal: controller.signal,
      }),
    );
  } catch {
    result = BLOCKED_USER_AUTH;
  } finally {
    for (const signal of signals) processLike.removeListener(signal, abort);
  }
  if (result !== USER_AUTH_COMPLETE) {
    processLike.stderr.write(`${BLOCKED_USER_AUTH}\n`);
    processLike.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runFeishuUserAuthMain({
    argv: process.argv.slice(2),
    processLike: process,
    authorize: runFeishuUserAuth,
  });
}
