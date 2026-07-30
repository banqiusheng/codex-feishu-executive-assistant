#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { types as utilTypes } from "node:util";

const SCOPE_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const TOKEN_TYPES = new Set(["user", "tenant"]);
const COMMAND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const SHORTCUT_PATTERN = /^\+[a-z][a-z0-9-]{0,63}$/u;

function assertPlainJsonData(value, seen = new WeakSet()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("json_number_invalid");
    return;
  }
  if (typeof value !== "object") {
    throw new Error("json_data_invalid");
  }
  if (utilTypes.isProxy(value)) throw new Error("json_proxy_invalid");
  if (seen.has(value)) throw new Error("json_data_invalid");
  seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error("json_array_prototype_invalid");
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor?.value;
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > 100_000 ||
      Reflect.ownKeys(value).length !== length + 1
    ) {
      throw new Error("json_array_shape_invalid");
    }
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        throw new Error("json_array_descriptor_invalid");
      }
      assertPlainJsonData(descriptor.value, seen);
    }
    return;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("json_object_prototype_invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 10_000 || keys.some((key) => typeof key !== "string")) {
    throw new Error("json_object_shape_invalid");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      throw new Error("json_object_descriptor_invalid");
    }
    assertPlainJsonData(descriptor.value, seen);
  }
}

function validateScopeList(value, expectedLength, reason) {
  if (
    !Array.isArray(value) ||
    value.length !== expectedLength ||
    new Set(value).size !== value.length ||
    value.some(
      (scope) => typeof scope !== "string" || !SCOPE_PATTERN.test(scope),
    )
  ) {
    throw new Error(reason);
  }
}

export function readScopeContract(contractPath, expectedSha256) {
  if (
    typeof contractPath !== "string" ||
    typeof expectedSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(expectedSha256)
  ) {
    throw new Error("scope_contract_arguments_invalid");
  }
  const stat = fs.lstatSync(contractPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    stat.size > 64 * 1024
  ) {
    throw new Error("scope_contract_file_invalid");
  }
  const bytes = fs.readFileSync(contractPath);
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
    throw new Error("scope_contract_replaced");
  }
  const contract = JSON.parse(bytes.toString("utf8"));
  assertPlainJsonData(contract);
  if (
    Object.keys(contract).join(",") !==
      "schemaVersion,userScopes,botScopes,shortcuts" ||
    contract.schemaVersion !== 1
  ) {
    throw new Error("scope_contract_schema_invalid");
  }
  validateScopeList(contract.userScopes, 14, "scope_contract_user_invalid");
  validateScopeList(contract.botScopes, 4, "scope_contract_bot_invalid");
  if (!Array.isArray(contract.shortcuts) || contract.shortcuts.length !== 14) {
    throw new Error("scope_contract_shortcuts_invalid");
  }
  const shortcutKeys = new Set();
  for (const shortcut of contract.shortcuts) {
    if (
      shortcut === null ||
      typeof shortcut !== "object" ||
      Array.isArray(shortcut) ||
      Object.keys(shortcut).join(",") !== "identity,command,shortcut" ||
      (shortcut.identity !== "user" && shortcut.identity !== "bot") ||
      typeof shortcut.command !== "string" ||
      !COMMAND_PATTERN.test(shortcut.command) ||
      typeof shortcut.shortcut !== "string" ||
      !SHORTCUT_PATTERN.test(shortcut.shortcut)
    ) {
      throw new Error("scope_contract_shortcut_invalid");
    }
    const key = `${shortcut.identity}:${shortcut.command}:${shortcut.shortcut}`;
    if (shortcutKeys.has(key)) {
      throw new Error("scope_contract_shortcut_duplicate");
    }
    shortcutKeys.add(key);
  }
  return Object.freeze({
    userScopes: Object.freeze([...contract.userScopes]),
    botScopes: Object.freeze([...contract.botScopes]),
    shortcuts: Object.freeze(
      contract.shortcuts.map((shortcut) => Object.freeze({ ...shortcut })),
    ),
  });
}

export function extractBotScopes(appInfo) {
  assertPlainJsonData(appInfo);
  const scopes = appInfo?.data?.app?.scopes;
  if (
    appInfo?.code !== 0 ||
    (appInfo?.msg !== undefined && typeof appInfo.msg !== "string") ||
    appInfo?.data === null ||
    typeof appInfo?.data !== "object" ||
    Array.isArray(appInfo.data) ||
    appInfo.data?.app === null ||
    typeof appInfo.data?.app !== "object" ||
    Array.isArray(appInfo.data.app) ||
    !Array.isArray(scopes) ||
    scopes.length > 4096
  ) {
    throw new Error("app_info_invalid");
  }

  const seenScopes = new Set();
  const botScopes = [];
  for (const entry of scopes) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !Object.hasOwn(entry, "scope") ||
      !Object.hasOwn(entry, "token_types") ||
      typeof entry.scope !== "string" ||
      !SCOPE_PATTERN.test(entry.scope) ||
      !Array.isArray(entry.token_types) ||
      entry.token_types.length < 1 ||
      entry.token_types.length > 8 ||
      new Set(entry.token_types).size !== entry.token_types.length ||
      entry.token_types.some(
        (tokenType) =>
          typeof tokenType !== "string" || !TOKEN_TYPES.has(tokenType),
      ) ||
      seenScopes.has(entry.scope)
    ) {
      throw new Error("app_info_scope_invalid");
    }
    seenScopes.add(entry.scope);
    if (entry.token_types.includes("tenant")) botScopes.push(entry.scope);
  }
  return botScopes;
}

export function extractUserScopes(scopeReport) {
  assertPlainJsonData(scopeReport);
  const scopes = scopeReport?.userScopes;
  if (
    scopeReport === null ||
    typeof scopeReport !== "object" ||
    Array.isArray(scopeReport) ||
    !Array.isArray(scopes) ||
    scopes.length > 4096 ||
    new Set(scopes).size !== scopes.length ||
    scopes.some(
      (scope) => typeof scope !== "string" || !SCOPE_PATTERN.test(scope),
    )
  ) {
    throw new Error("user_scope_report_invalid");
  }
  return scopes;
}

export function findMissingAppScopes(contract, userScopeReport, appInfo) {
  const enabledUser = new Set(extractUserScopes(userScopeReport));
  const enabledBot = new Set(extractBotScopes(appInfo));
  return [
    ...contract.userScopes.filter((scope) => !enabledUser.has(scope)),
    ...contract.botScopes.filter((scope) => !enabledBot.has(scope)),
  ];
}

async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) {
      throw new Error("stdin_too_large");
    }
  }
  return raw;
}

async function main() {
  const command = process.argv[2];
  if (command === "app-info-bot-scopes" && process.argv.length === 3) {
    const appInfo = JSON.parse(await readStdin());
    for (const scope of extractBotScopes(appInfo)) {
      process.stdout.write(`${scope}\n`);
    }
    return;
  }
  if (command === "contract-lines" && process.argv.length === 5) {
    const contract = readScopeContract(process.argv[3], process.argv[4]);
    for (const scope of contract.userScopes) {
      process.stdout.write(`USER:${scope}\n`);
    }
    for (const scope of contract.botScopes) {
      process.stdout.write(`BOT:${scope}\n`);
    }
    for (const entry of contract.shortcuts) {
      process.stdout.write(
        `SHORTCUT:${entry.identity}|${entry.command}|${entry.shortcut}\n`,
      );
    }
    return;
  }
  if (command === "missing-app-scopes" && process.argv.length === 5) {
    const contract = readScopeContract(process.argv[3], process.argv[4]);
    const raw = await readStdin();
    const separator = raw.indexOf("\x1e");
    if (
      separator < 1 ||
      separator === raw.length - 1 ||
      raw.indexOf("\x1e", separator + 1) !== -1
    ) {
      throw new Error("app_scope_documents_invalid");
    }
    const userScopeReport = JSON.parse(raw.slice(0, separator));
    const appInfo = JSON.parse(raw.slice(separator + 1));
    for (const scope of findMissingAppScopes(
      contract,
      userScopeReport,
      appInfo,
    )) {
      process.stdout.write(`${scope}\n`);
    }
    return;
  }
  throw new Error("unknown_command");
}

if (
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
