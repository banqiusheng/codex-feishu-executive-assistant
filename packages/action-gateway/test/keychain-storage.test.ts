import {
  chmod,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const readdirBarrier = vi.hoisted(() => ({
  directory: undefined as string | undefined,
  calls: 0,
  reached: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const controlledReaddir = new Proxy(actual.readdir, {
    apply(target, thisArgument, argumentsList) {
      const directory = String(argumentsList[0]);
      if (
        directory === readdirBarrier.directory &&
        (readdirBarrier.calls += 1) === 2
      ) {
        readdirBarrier.reached?.();
        return readdirBarrier.release?.then(() =>
          Reflect.apply(target, thisArgument, argumentsList),
        );
      }
      return Reflect.apply(target, thisArgument, argumentsList);
    },
  });
  return { ...actual, readdir: controlledReaddir };
});

import {
  BOT_KEYCHAIN_SERVICE,
  BOT_SECRET_REF_PROVIDER,
  LARK_CLI_PROFILE,
  OAuthStorageAuditor,
  createBotSecretRefBundle,
} from "../src/keychain.js";

const roots: string[] = [];

async function secureStore(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "assistant-oauth-store-"));
  roots.push(root);
  await chmod(root, 0o700);
  await writeFile(join(root, "credentials.enc"), "synthetic-ciphertext", {
    mode: 0o600,
  });
  await chmod(join(root, "credentials.enc"), 0o600);
  return realpath(root);
}

afterEach(async () => {
  readdirBarrier.directory = undefined;
  readdirBarrier.calls = 0;
  readdirBarrier.reached = undefined;
  readdirBarrier.release = undefined;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Bot App SecretRef configuration", () => {
  it("builds one fixed exec provider without an env, file, or identity fallback", () => {
    const result = createBotSecretRefBundle({
      appId: "cli_0123456789abcdef",
    });
    const helperPath = join(
      userInfo().homedir,
      "PresidentAssistant/runtime/current/private-bin/assistant-keychain-helper",
    );

    expect(result).toEqual({
      storageProfile: "KEYCHAIN_BACKED_ENCRYPTED_STORE",
      profile: "executive-assistant",
      keychain: {
        service: "com.codex-feishu-executive-assistant.bot",
        account: "cli_0123456789abcdef",
      },
      secretRef: {
        source: "exec",
        provider: "executive-assistant-keychain",
        id: "app-cli_0123456789abcdef",
      },
      secrets: {
        providers: {
          "executive-assistant-keychain": {
            source: "exec",
            command: helperPath,
            args: [],
            passEnv: [],
            noOutputTimeoutMs: 5_000,
            maxOutputBytes: 4_096,
          },
        },
      },
      execRequest: {
        protocolVersion: 1,
        provider: "executive-assistant-keychain",
        ids: ["app-cli_0123456789abcdef"],
      },
    });
    expect(result.profile).toBe(LARK_CLI_PROFILE);
    expect(result.keychain.service).toBe(BOT_KEYCHAIN_SERVICE);
    expect(result.secretRef.provider).toBe(BOT_SECRET_REF_PROVIDER);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.secretRef)).toBe(true);
    expect(Object.isFrozen(result.secrets.providers)).toBe(true);
    expect(Object.isFrozen(result.execRequest.ids)).toBe(true);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('"source":"env"');
    expect(serialized).not.toContain('"source":"file"');
    expect(serialized).not.toContain('"identity"');
    expect(serialized).not.toContain('"fallback"');
  });

  it.each([
    ["caller identity", { identity: "user" }],
    ["caller profile", { profile: "other" }],
    ["caller fallback", { fallback: "file" }],
    ["caller argv", { args: ["--as", "user"] }],
    ["caller helper path", { helperPath: "assistant-keychain-helper" }],
    ["malformed app id", { appId: "not-an-app" }],
  ])("rejects %s before producing configuration", (_name, override) => {
    expect(() =>
      createBotSecretRefBundle({
        appId: "cli_0123456789abcdef",
        ...override,
      }),
    ).toThrow("BOT_SECRET_REF_INPUT_INVALID");
  });

  it("rejects proxies and accessors without invoking them", () => {
    const proxy = new Proxy(
      {
        appId: "cli_0123456789abcdef",
      },
      {},
    );
    expect(() => createBotSecretRefBundle(proxy)).toThrow(
      "BOT_SECRET_REF_INPUT_INVALID",
    );

    let reads = 0;
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "appId", {
      enumerable: true,
      get() {
        reads += 1;
        return "cli_0123456789abcdef";
      },
    });
    expect(() => createBotSecretRefBundle(accessor)).toThrow(
      "BOT_SECRET_REF_INPUT_INVALID",
    );
    expect(reads).toBe(0);
  });
});

describe("OAuthStorageAuditor synthetic evidence", () => {
  it("keeps a conforming synthetic store UNVERIFIED without a real canary", async () => {
    const storeDirectory = await secureStore();

    const result = await new OAuthStorageAuditor({
      fixtureClass: "synthetic",
      storeDirectory,
    }).inspectKeychainBackedEncryptedStore();

    expect(result).toEqual({
      storageProfile: "KEYCHAIN_BACKED_ENCRYPTED_STORE",
      profile: "executive-assistant",
      fixtureClass: "synthetic",
      status: "UNVERIFIED_NO_FIXTURE",
      reasonCode: "REAL_CANARY_REQUIRED",
      localChecksPassed: true,
      realCanaryVerified: false,
      encryptedFileCount: 1,
      checks: {
        parentDirectorySecure: true,
        encryptedFilesSecure: true,
        masterKeyFileAbsent: true,
      },
    });
  });

  it("returns UNVERIFIED rather than inventing a pass when no synthetic fixture is supplied", async () => {
    const result = await new OAuthStorageAuditor({
      fixtureClass: "synthetic",
    }).inspectKeychainBackedEncryptedStore();

    expect(result).toMatchObject({
      status: "UNVERIFIED_NO_FIXTURE",
      reasonCode: "SYNTHETIC_FIXTURE_NOT_SUPPLIED",
      localChecksPassed: false,
      realCanaryVerified: false,
      encryptedFileCount: 0,
    });
  });

  it("blocks insecure parent permissions", async () => {
    const storeDirectory = await secureStore();
    await chmod(storeDirectory, 0o755);

    await expect(
      new OAuthStorageAuditor({
        fixtureClass: "synthetic",
        storeDirectory,
      }).inspectKeychainBackedEncryptedStore(),
    ).resolves.toMatchObject({
      status: "BLOCKED_SECRET_STORAGE",
      reasonCode: "STORE_DIRECTORY_INSECURE",
      localChecksPassed: false,
      realCanaryVerified: false,
    });
  });

  it("blocks missing, insecure, and symlinked encrypted files", async () => {
    const createdMissingRoot = await mkdtemp(
      join(tmpdir(), "assistant-oauth-empty-"),
    );
    roots.push(createdMissingRoot);
    await chmod(createdMissingRoot, 0o700);
    const missingRoot = await realpath(createdMissingRoot);
    await expect(
      new OAuthStorageAuditor({
        fixtureClass: "synthetic",
        storeDirectory: missingRoot,
      }).inspectKeychainBackedEncryptedStore(),
    ).resolves.toMatchObject({
      status: "BLOCKED_SECRET_STORAGE",
      reasonCode: "ENCRYPTED_CREDENTIAL_MISSING",
    });

    const insecureRoot = await secureStore();
    await chmod(join(insecureRoot, "credentials.enc"), 0o644);
    await expect(
      new OAuthStorageAuditor({
        fixtureClass: "synthetic",
        storeDirectory: insecureRoot,
      }).inspectKeychainBackedEncryptedStore(),
    ).resolves.toMatchObject({
      status: "BLOCKED_SECRET_STORAGE",
      reasonCode: "ENCRYPTED_CREDENTIAL_INSECURE",
    });

    const createdSymlinkRoot = await mkdtemp(
      join(tmpdir(), "assistant-oauth-symlink-"),
    );
    roots.push(createdSymlinkRoot);
    await chmod(createdSymlinkRoot, 0o700);
    const symlinkRoot = await realpath(createdSymlinkRoot);
    const targetRoot = await mkdtemp(join(tmpdir(), "assistant-oauth-target-"));
    roots.push(targetRoot);
    await writeFile(join(targetRoot, "target"), "ciphertext", { mode: 0o600 });
    await symlink(
      join(targetRoot, "target"),
      join(symlinkRoot, "credentials.enc"),
    );
    await expect(
      new OAuthStorageAuditor({
        fixtureClass: "synthetic",
        storeDirectory: symlinkRoot,
      }).inspectKeychainBackedEncryptedStore(),
    ).resolves.toMatchObject({
      status: "BLOCKED_SECRET_STORAGE",
      reasonCode: "ENCRYPTED_CREDENTIAL_INSECURE",
    });
  });

  it("blocks master.key.file whether it is a file or a symlink", async () => {
    const fileRoot = await secureStore();
    await writeFile(join(fileRoot, "master.key.file"), "forbidden", {
      mode: 0o600,
    });
    await expect(
      new OAuthStorageAuditor({
        fixtureClass: "synthetic",
        storeDirectory: fileRoot,
      }).inspectKeychainBackedEncryptedStore(),
    ).resolves.toMatchObject({
      status: "BLOCKED_SECRET_STORAGE",
      reasonCode: "MASTER_KEY_FILE_PRESENT",
    });

    const linkRoot = await secureStore();
    const target = join(linkRoot, "other-file");
    await writeFile(target, "forbidden", { mode: 0o600 });
    await symlink(target, join(linkRoot, "master.key.file"));
    await expect(
      new OAuthStorageAuditor({
        fixtureClass: "synthetic",
        storeDirectory: linkRoot,
      }).inspectKeychainBackedEncryptedStore(),
    ).resolves.toMatchObject({
      status: "BLOCKED_SECRET_STORAGE",
      reasonCode: "MASTER_KEY_FILE_PRESENT",
    });
  });

  it("blocks directory identity and listing drift during the audit", async () => {
    const storeDirectory = await secureStore();
    const pending = new OAuthStorageAuditor({
      fixtureClass: "synthetic",
      storeDirectory,
    }).inspectKeychainBackedEncryptedStore();

    for (let index = 0; index < 8; index += 1) {
      await writeFile(join(storeDirectory, `drift-${index}`), "changed", {
        mode: 0o600,
      });
    }

    await expect(pending).resolves.toMatchObject({
      status: "BLOCKED_SECRET_STORAGE",
      reasonCode: "STORE_DIRECTORY_DRIFT",
      localChecksPassed: false,
      realCanaryVerified: false,
      checks: {
        parentDirectorySecure: false,
        encryptedFilesSecure: false,
        masterKeyFileAbsent: false,
      },
    });
  });

  it("blocks encrypted file chmod/ctime drift after the first identity check", async () => {
    const storeDirectory = await secureStore();
    let reachedSecondRead: () => void = () => undefined;
    const secondReadReached = new Promise<void>((resolve) => {
      reachedSecondRead = resolve;
    });
    let releaseSecondRead: () => void = () => undefined;
    const secondReadReleased = new Promise<void>((resolve) => {
      releaseSecondRead = resolve;
    });
    readdirBarrier.directory = storeDirectory;
    readdirBarrier.calls = 0;
    readdirBarrier.reached = reachedSecondRead;
    readdirBarrier.release = secondReadReleased;

    const pending = new OAuthStorageAuditor({
      fixtureClass: "synthetic",
      storeDirectory,
    }).inspectKeychainBackedEncryptedStore();
    await secondReadReached;
    try {
      await chmod(join(storeDirectory, "credentials.enc"), 0o640);
      await chmod(join(storeDirectory, "credentials.enc"), 0o600);
    } finally {
      releaseSecondRead();
    }

    await expect(pending).resolves.toMatchObject({
      status: "BLOCKED_SECRET_STORAGE",
      reasonCode: "STORE_DIRECTORY_DRIFT",
      localChecksPassed: false,
      realCanaryVerified: false,
      checks: {
        parentDirectorySecure: false,
        encryptedFilesSecure: false,
        masterKeyFileAbsent: false,
      },
    });
  });

  it("rejects real-fixture claims and unknown auditor options", () => {
    expect(
      () =>
        new OAuthStorageAuditor({
          fixtureClass: "real",
        }),
    ).toThrow("OAUTH_STORAGE_AUDIT_INPUT_INVALID");
    expect(
      () =>
        new OAuthStorageAuditor({
          fixtureClass: "synthetic",
          canaryVerified: true,
        }),
    ).toThrow("OAUTH_STORAGE_AUDIT_INPUT_INVALID");
  });
});
