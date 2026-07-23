import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type {
  RuntimeConfig,
  RuntimeExecutables,
  RuntimePairingConfig,
  RuntimePaths,
  RuntimeSecretRef,
} from "./types.js";

const MAX_CONFIG_BYTES = 1024 * 1024;
const IDENTIFIER_MAX_LENGTH = 512;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const FORBIDDEN_SECRET_KEYS = new Set([
  "appsecret",
  "clientsecret",
  "client_secret",
  "secretvalue",
  "secret_value",
  "app_secret",
  "secret",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "password",
  "credential",
  "credentials",
]);

function invalid(detail: string): never {
  throw new Error(`RUNTIME_CONFIG_INVALID: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactIdentifier(
  value: unknown,
  label: string,
  nullable = false,
): string | null {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > IDENTIFIER_MAX_LENGTH ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    return invalid(label);
  }
  return value;
}

function absolutePath(
  value: unknown,
  label: string,
  nullable = false,
): string | null {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    resolve(value) !== value
  ) {
    return invalid(label);
  }
  return value;
}

function assertNoInlineSecrets(value: unknown, path = "config"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoInlineSecrets(entry, `${path}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_SECRET_KEYS.has(key.toLowerCase())) {
      invalid(`inline secret field at ${path}.${key}`);
    }
    assertNoInlineSecrets(entry, `${path}.${key}`);
  }
}

function deepFreezeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    value.forEach(deepFreezeJson);
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    Object.values(value).forEach(deepFreezeJson);
    return Object.freeze(value);
  }
  return value;
}

function parsePairing(value: unknown): RuntimePairingConfig {
  if (!isRecord(value)) return invalid("pairing");
  const enabled = value.enabled;
  const codeHash = value.codeHash;
  const expiresAt = value.expiresAt;
  if (
    typeof enabled !== "boolean" ||
    (codeHash !== null &&
      (typeof codeHash !== "string" || !SHA256_PATTERN.test(codeHash))) ||
    (expiresAt !== null &&
      (typeof expiresAt !== "string" ||
        !Number.isFinite(Date.parse(expiresAt))))
  ) {
    return invalid("pairing");
  }
  if (
    (enabled && (codeHash === null || expiresAt === null)) ||
    (!enabled && (codeHash !== null || expiresAt !== null))
  ) {
    return invalid("pairing state");
  }
  return Object.freeze({ enabled, codeHash, expiresAt });
}

function parsePaths(value: unknown): RuntimePaths {
  if (!isRecord(value)) return invalid("paths");
  return Object.freeze({
    runtimeRoot: absolutePath(value.runtimeRoot, "paths.runtimeRoot") as string,
    jobsRoot: absolutePath(value.jobsRoot, "paths.jobsRoot") as string,
    workspaceRoot: absolutePath(
      value.workspaceRoot,
      "paths.workspaceRoot",
    ) as string,
    codexHome: absolutePath(value.codexHome, "paths.codexHome") as string,
    larkHome: absolutePath(value.larkHome, "paths.larkHome") as string,
    databasePath: absolutePath(
      value.databasePath,
      "paths.databasePath",
    ) as string,
  });
}

function parseExecutables(value: unknown): RuntimeExecutables {
  if (!isRecord(value)) return invalid("executables");
  return Object.freeze({
    codex: absolutePath(value.codex, "executables.codex") as string,
    gatewayClient: absolutePath(
      value.gatewayClient,
      "executables.gatewayClient",
    ) as string,
    larkCli: absolutePath(value.larkCli ?? null, "executables.larkCli", true),
    runtimeEntry: absolutePath(
      value.runtimeEntry ?? null,
      "executables.runtimeEntry",
      true,
    ),
  });
}

function parseSecretRef(value: unknown): RuntimeSecretRef {
  if (!isRecord(value)) return invalid("secretRef");
  const service = exactIdentifier(value.service, "secretRef.service");
  const account = exactIdentifier(value.account, "secretRef.account");
  if (value.type !== "macos-keychain") return invalid("secretRef.type");
  return Object.freeze({
    type: "macos-keychain",
    service: service as string,
    account: account as string,
  });
}

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  if (!isRecord(value)) return invalid("root");
  assertNoInlineSecrets(value);
  if (value.schemaVersion !== 1) return invalid("schemaVersion");

  const appId = exactIdentifier(value.appId, "appId") as string;
  const tenantKey = exactIdentifier(value.tenantKey, "tenantKey") as string;
  const presidentOpenId = exactIdentifier(
    value.presidentOpenId,
    "presidentOpenId",
    true,
  );
  const presidentChatId = exactIdentifier(
    value.presidentChatId,
    "presidentChatId",
    true,
  );
  const pairing = parsePairing(value.pairing);
  const secretRef = parseSecretRef(value.secretRef);
  const paths = parsePaths(value.paths);
  const executables = parseExecutables(value.executables);

  const paired = presidentOpenId !== null && presidentChatId !== null;
  const unpaired = presidentOpenId === null && presidentChatId === null;
  if ((!paired && !unpaired) || (paired && pairing.enabled)) {
    return invalid("principal binding");
  }
  if (unpaired && !pairing.enabled) {
    return invalid("unpaired configuration requires pairing");
  }

  const source = deepFreezeJson(value) as Readonly<Record<string, unknown>>;
  return Object.freeze({
    schemaVersion: 1,
    appId,
    tenantKey,
    presidentOpenId,
    presidentChatId,
    pairing,
    secretRef,
    paths,
    executables,
    source,
  });
}

export async function loadRuntimeConfig(path: string): Promise<RuntimeConfig> {
  const absoluteConfigPath = absolutePath(path, "config path") as string;
  let metadata: Awaited<ReturnType<typeof lstat>>;
  let bytes: Buffer;
  try {
    metadata = await lstat(absoluteConfigPath);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" &&
        metadata.uid !== process.getuid()) ||
      (await realpath(absoluteConfigPath)) !== absoluteConfigPath
    ) {
      throw new Error("unsafe config");
    }
    bytes = await readFile(absoluteConfigPath);
  } catch {
    throw new Error("RUNTIME_CONFIG_UNREADABLE");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CONFIG_BYTES) {
    throw new Error("RUNTIME_CONFIG_INVALID: size");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("RUNTIME_CONFIG_INVALID: json");
  }
  return parseRuntimeConfig(parsed);
}
