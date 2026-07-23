import { constants, realpathSync, type Dirent, type Stats } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { getuid } from "node:process";

import { snapshotExactOwnDataOptions } from "./internal/exact-options.js";

export const BOT_KEYCHAIN_SERVICE =
  "com.codex-feishu-executive-assistant.bot" as const;
export const LARK_CLI_PROFILE = "executive-assistant" as const;
export const BOT_SECRET_REF_PROVIDER = "executive-assistant-keychain" as const;
export const SECRET_STORAGE_PROFILE =
  "KEYCHAIN_BACKED_ENCRYPTED_STORE" as const;

const BOT_SECRET_REF_PROTOCOL_VERSION = 1 as const;
const BOT_SECRET_REF_TIMEOUT_MS = 5_000 as const;
const BOT_SECRET_REF_MAX_OUTPUT_BYTES = 4_096 as const;
const PRIVATE_HELPER_RELATIVE_PATH =
  "PresidentAssistant/runtime/current/private-bin/assistant-keychain-helper" as const;
const APP_ID_PATTERN = /^cli_[A-Za-z0-9]{4,128}$/;

type BotSecretRef = Readonly<{
  source: "exec";
  provider: typeof BOT_SECRET_REF_PROVIDER;
  id: string;
}>;

type BotSecretProvider = Readonly<{
  source: "exec";
  command: string;
  args: readonly [];
  passEnv: readonly [];
  noOutputTimeoutMs: typeof BOT_SECRET_REF_TIMEOUT_MS;
  maxOutputBytes: typeof BOT_SECRET_REF_MAX_OUTPUT_BYTES;
}>;

export type BotSecretRefBundle = Readonly<{
  storageProfile: typeof SECRET_STORAGE_PROFILE;
  profile: typeof LARK_CLI_PROFILE;
  keychain: Readonly<{
    service: typeof BOT_KEYCHAIN_SERVICE;
    account: string;
  }>;
  secretRef: BotSecretRef;
  secrets: Readonly<{
    providers: Readonly<{
      "executive-assistant-keychain": BotSecretProvider;
    }>;
  }>;
  execRequest: Readonly<{
    protocolVersion: typeof BOT_SECRET_REF_PROTOCOL_VERSION;
    provider: typeof BOT_SECRET_REF_PROVIDER;
    ids: readonly [string];
  }>;
}>;

function invalidBotSecretRefInput(): never {
  throw new Error("BOT_SECRET_REF_INPUT_INVALID");
}

function snapshotBotSecretRefInput(input: unknown): Readonly<{
  appId: string;
  helperPath: string;
}> {
  let snapshot: Readonly<Record<string, unknown>>;
  try {
    snapshot = snapshotExactOwnDataOptions(input, ["appId"]);
  } catch {
    return invalidBotSecretRefInput();
  }
  const appId = snapshot.appId;
  if (typeof appId !== "string" || !APP_ID_PATTERN.test(appId)) {
    return invalidBotSecretRefInput();
  }

  let homeDirectory: string;
  try {
    homeDirectory = userInfo().homedir;
    if (
      homeDirectory.length === 0 ||
      homeDirectory.includes("\0") ||
      !isAbsolute(homeDirectory) ||
      resolve(homeDirectory) !== homeDirectory ||
      realpathSync(homeDirectory) !== homeDirectory
    ) {
      return invalidBotSecretRefInput();
    }
  } catch {
    return invalidBotSecretRefInput();
  }

  const helperPath = join(homeDirectory, PRIVATE_HELPER_RELATIVE_PATH);
  if (
    !isAbsolute(helperPath) ||
    helperPath.includes("\0") ||
    resolve(helperPath) !== helperPath ||
    helperPath !== join(homeDirectory, PRIVATE_HELPER_RELATIVE_PATH)
  ) {
    return invalidBotSecretRefInput();
  }
  return Object.freeze({ appId, helperPath });
}

export function createBotSecretRefBundle(input: unknown): BotSecretRefBundle {
  const { appId, helperPath } = snapshotBotSecretRefInput(input);
  const id = `app-${appId}`;
  const emptyArguments = Object.freeze([]) as readonly [];
  const emptyEnvironment = Object.freeze([]) as readonly [];
  const provider = Object.freeze({
    source: "exec" as const,
    command: helperPath,
    args: emptyArguments,
    passEnv: emptyEnvironment,
    noOutputTimeoutMs: BOT_SECRET_REF_TIMEOUT_MS,
    maxOutputBytes: BOT_SECRET_REF_MAX_OUTPUT_BYTES,
  });
  const providers = Object.freeze({
    "executive-assistant-keychain": provider,
  });
  const ids = Object.freeze([id]) as readonly [string];

  return Object.freeze({
    storageProfile: SECRET_STORAGE_PROFILE,
    profile: LARK_CLI_PROFILE,
    keychain: Object.freeze({
      service: BOT_KEYCHAIN_SERVICE,
      account: appId,
    }),
    secretRef: Object.freeze({
      source: "exec" as const,
      provider: BOT_SECRET_REF_PROVIDER,
      id,
    }),
    secrets: Object.freeze({ providers }),
    execRequest: Object.freeze({
      protocolVersion: BOT_SECRET_REF_PROTOCOL_VERSION,
      provider: BOT_SECRET_REF_PROVIDER,
      ids,
    }),
  });
}

export type SecretStorageReasonCode =
  | "REAL_CANARY_REQUIRED"
  | "SYNTHETIC_FIXTURE_NOT_SUPPLIED"
  | "STORE_DIRECTORY_INSECURE"
  | "STORE_DIRECTORY_DRIFT"
  | "ENCRYPTED_CREDENTIAL_MISSING"
  | "ENCRYPTED_CREDENTIAL_INSECURE"
  | "MASTER_KEY_FILE_PRESENT"
  | "STORAGE_AUDIT_FAILED";

export type SecretStorageEvidence = Readonly<{
  storageProfile: typeof SECRET_STORAGE_PROFILE;
  profile: typeof LARK_CLI_PROFILE;
  fixtureClass: "synthetic";
  status: "UNVERIFIED_NO_FIXTURE" | "BLOCKED_SECRET_STORAGE";
  reasonCode: SecretStorageReasonCode;
  localChecksPassed: boolean;
  realCanaryVerified: false;
  encryptedFileCount: number;
  checks: Readonly<{
    parentDirectorySecure: boolean;
    encryptedFilesSecure: boolean;
    masterKeyFileAbsent: boolean;
  }>;
}>;

type EvidenceChecks = SecretStorageEvidence["checks"];

function evidence(
  status: SecretStorageEvidence["status"],
  reasonCode: SecretStorageReasonCode,
  localChecksPassed: boolean,
  encryptedFileCount: number,
  checks: EvidenceChecks,
): SecretStorageEvidence {
  return Object.freeze({
    storageProfile: SECRET_STORAGE_PROFILE,
    profile: LARK_CLI_PROFILE,
    fixtureClass: "synthetic" as const,
    status,
    reasonCode,
    localChecksPassed,
    realCanaryVerified: false as const,
    encryptedFileCount,
    checks: Object.freeze({ ...checks }),
  });
}

function blocked(
  reasonCode: SecretStorageReasonCode,
  encryptedFileCount: number,
  checks: EvidenceChecks,
): SecretStorageEvidence {
  return evidence(
    "BLOCKED_SECRET_STORAGE",
    reasonCode,
    false,
    encryptedFileCount,
    checks,
  );
}

function mode(metadata: Stats): number {
  return metadata.mode & 0o7777;
}

type ExactFileIdentity = Readonly<{
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}>;

function fileIdentity(metadata: Stats): ExactFileIdentity {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    uid: metadata.uid,
    mode: metadata.mode,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  });
}

function sameFileIdentity(
  left: ExactFileIdentity,
  right: ExactFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameFile(left: Stats, right: Stats): boolean {
  return sameFileIdentity(fileIdentity(left), fileIdentity(right));
}

function sameDirectory(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function directoryListing(entries: readonly Dirent[]): readonly string[] {
  return entries
    .map((entry) =>
      [
        entry.name,
        entry.isFile() ? "file" : "",
        entry.isDirectory() ? "directory" : "",
        entry.isSymbolicLink() ? "symlink" : "",
        entry.isBlockDevice() ? "block" : "",
        entry.isCharacterDevice() ? "character" : "",
        entry.isFIFO() ? "fifo" : "",
        entry.isSocket() ? "socket" : "",
      ].join("\0"),
    )
    .sort();
}

function sameListing(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

async function exactSecureEncryptedFile(
  path: string,
  expectedUid: number,
): Promise<ExactFileIdentity | undefined> {
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(path);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.uid !== expectedUid ||
      mode(before) !== 0o600
    ) {
      return undefined;
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: false });
    const after = await lstat(path);
    const secureAndStable =
      opened.isFile() &&
      opened.uid === expectedUid &&
      mode(opened) === 0o600 &&
      sameFile(before, opened) &&
      sameFile(after, opened);
    return secureAndStable ? fileIdentity(opened) : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function pathDoesNotExist(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    );
  }
}

function invalidAuditInput(): never {
  throw new Error("OAUTH_STORAGE_AUDIT_INPUT_INVALID");
}

export class OAuthStorageAuditor {
  readonly #storeDirectory: string | undefined;

  constructor(input: unknown) {
    let snapshot: Readonly<Record<string, unknown>>;
    try {
      snapshot = snapshotExactOwnDataOptions(
        input,
        ["fixtureClass"],
        ["storeDirectory"],
      );
    } catch {
      return invalidAuditInput();
    }
    if (snapshot.fixtureClass !== "synthetic") {
      return invalidAuditInput();
    }
    if (
      snapshot.storeDirectory !== undefined &&
      (typeof snapshot.storeDirectory !== "string" ||
        snapshot.storeDirectory.includes("\0") ||
        !isAbsolute(snapshot.storeDirectory) ||
        resolve(snapshot.storeDirectory) !== snapshot.storeDirectory)
    ) {
      return invalidAuditInput();
    }
    this.#storeDirectory = snapshot.storeDirectory;
    Object.freeze(this);
  }

  async inspectKeychainBackedEncryptedStore(): Promise<SecretStorageEvidence> {
    const emptyChecks = Object.freeze({
      parentDirectorySecure: false,
      encryptedFilesSecure: false,
      masterKeyFileAbsent: false,
    });
    if (this.#storeDirectory === undefined) {
      return evidence(
        "UNVERIFIED_NO_FIXTURE",
        "SYNTHETIC_FIXTURE_NOT_SUPPLIED",
        false,
        0,
        emptyChecks,
      );
    }

    const storeDirectory = this.#storeDirectory;
    if (typeof getuid !== "function") {
      return blocked("STORAGE_AUDIT_FAILED", 0, emptyChecks);
    }
    const expectedUid = getuid();
    let directoryBefore: Stats;
    try {
      directoryBefore = await lstat(storeDirectory);
      const directorySecure =
        !directoryBefore.isSymbolicLink() &&
        directoryBefore.isDirectory() &&
        directoryBefore.uid === expectedUid &&
        mode(directoryBefore) === 0o700 &&
        (await realpath(storeDirectory)) === storeDirectory;
      if (!directorySecure) {
        return blocked("STORE_DIRECTORY_INSECURE", 0, emptyChecks);
      }
    } catch {
      return blocked("STORE_DIRECTORY_INSECURE", 0, emptyChecks);
    }

    const directoryChecks = Object.freeze({
      parentDirectorySecure: true,
      encryptedFilesSecure: false,
      masterKeyFileAbsent: false,
    });
    try {
      const masterKeyPath = join(storeDirectory, "master.key.file");
      if (!(await pathDoesNotExist(masterKeyPath))) {
        return blocked("MASTER_KEY_FILE_PRESENT", 0, directoryChecks);
      }

      const firstEntries = await readdir(storeDirectory, {
        withFileTypes: true,
      });
      const firstListing = directoryListing(firstEntries);
      const encryptedNames = firstEntries
        .map((entry) => entry.name)
        .filter((name) => name.endsWith(".enc"))
        .sort();
      if (encryptedNames.length === 0) {
        return blocked("ENCRYPTED_CREDENTIAL_MISSING", 0, directoryChecks);
      }

      const encryptedIdentities = new Map<string, ExactFileIdentity>();
      for (const name of encryptedNames) {
        const identity =
          name.includes("/") || name.includes("\0")
            ? undefined
            : await exactSecureEncryptedFile(
                join(storeDirectory, name),
                expectedUid,
              );
        if (identity === undefined) {
          return blocked(
            "ENCRYPTED_CREDENTIAL_INSECURE",
            encryptedNames.length,
            directoryChecks,
          );
        }
        encryptedIdentities.set(name, identity);
      }

      const encryptedChecks = Object.freeze({
        parentDirectorySecure: true,
        encryptedFilesSecure: true,
        masterKeyFileAbsent: false,
      });
      if (!(await pathDoesNotExist(masterKeyPath))) {
        return blocked(
          "MASTER_KEY_FILE_PRESENT",
          encryptedNames.length,
          encryptedChecks,
        );
      }

      const secondEntries = await readdir(storeDirectory, {
        withFileTypes: true,
      });
      const secondListing = directoryListing(secondEntries);
      let encryptedFilesStable = true;
      for (const [name, expectedIdentity] of encryptedIdentities) {
        const finalIdentity = await exactSecureEncryptedFile(
          join(storeDirectory, name),
          expectedUid,
        );
        if (
          finalIdentity === undefined ||
          !sameFileIdentity(expectedIdentity, finalIdentity)
        ) {
          encryptedFilesStable = false;
          break;
        }
      }
      const directoryAfter = await lstat(storeDirectory);
      const directoryStable =
        !directoryAfter.isSymbolicLink() &&
        directoryAfter.isDirectory() &&
        directoryAfter.uid === expectedUid &&
        mode(directoryAfter) === 0o700 &&
        sameDirectory(directoryBefore, directoryAfter) &&
        sameListing(firstListing, secondListing) &&
        (await realpath(storeDirectory)) === storeDirectory;
      if (!directoryStable || !encryptedFilesStable) {
        return blocked(
          "STORE_DIRECTORY_DRIFT",
          encryptedNames.length,
          emptyChecks,
        );
      }

      return evidence(
        "UNVERIFIED_NO_FIXTURE",
        "REAL_CANARY_REQUIRED",
        true,
        encryptedNames.length,
        {
          parentDirectorySecure: true,
          encryptedFilesSecure: true,
          masterKeyFileAbsent: true,
        },
      );
    } catch {
      return blocked("STORAGE_AUDIT_FAILED", 0, emptyChecks);
    }
  }
}
