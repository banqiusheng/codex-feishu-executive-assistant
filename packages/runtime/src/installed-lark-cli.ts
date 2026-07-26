import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { MvpLarkCliRunner } from "@executive-assistant/action-gateway";
import {
  createMvpInstalledLarkCliRunner,
  type MvpLarkCliReleaseEvidence,
} from "../../action-gateway/src/mvp/installed-runner.js";

import type { MvpLarkCliRunnerFactory } from "./types.js";

const execute = promisify(execFile);
const LARK_CLI_VERSION = "1.0.72";
const CLI_SCHEMA_SHA256 =
  "sha256:4dc76f583db8ab0b3bc56530c1a00e9a6d79f8c18c80fd6758873747378fc8dc" as const;
const ARCHIVE_SHA256 = Object.freeze({
  arm64: "b27942b83e8821934ebd34fbb02e0b00bbca949255866b5010795d625442eae2",
  x64: "b5dd56d64f9cc1cb7bab80b8eb1dda3c34e76f2a751115a897d0261985b82745",
});

type InstallReceipt = Readonly<{
  schemaVersion: 1;
  package: "@larksuite/cli";
  version: "1.0.72";
  archiveSha256: string;
  binarySha256: string;
  sourceUrl: string;
}>;

function sha256(bytes: Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function expectedArchive(): Readonly<{
  architecture: "arm64" | "amd64";
  sha256: string;
}> {
  if (process.arch === "arm64") {
    return Object.freeze({
      architecture: "arm64",
      sha256: ARCHIVE_SHA256.arm64,
    });
  }
  if (process.arch === "x64") {
    return Object.freeze({
      architecture: "amd64",
      sha256: ARCHIVE_SHA256.x64,
    });
  }
  throw new Error("LARK_CLI_ARCH_UNSUPPORTED");
}

function parseReceipt(value: unknown): InstallReceipt {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 6
  ) {
    throw new Error("LARK_CLI_RECEIPT_INVALID");
  }
  const record = value as Record<string, unknown>;
  const archive = expectedArchive();
  const expectedUrl =
    `https://github.com/larksuite/cli/releases/download/v${LARK_CLI_VERSION}/` +
    `lark-cli-${LARK_CLI_VERSION}-darwin-${archive.architecture}.tar.gz`;
  if (
    record.schemaVersion !== 1 ||
    record.package !== "@larksuite/cli" ||
    record.version !== LARK_CLI_VERSION ||
    record.archiveSha256 !== archive.sha256 ||
    record.sourceUrl !== expectedUrl ||
    typeof record.binarySha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.binarySha256)
  ) {
    throw new Error("LARK_CLI_RECEIPT_INVALID");
  }
  return Object.freeze({
    schemaVersion: 1,
    package: "@larksuite/cli",
    version: LARK_CLI_VERSION,
    archiveSha256: archive.sha256,
    binarySha256: record.binarySha256,
    sourceUrl: expectedUrl,
  });
}

function parseDesignatedRequirement(output: string): string {
  const prefixes = ["designated => ", "# designated => "] as const;
  let requirement: string | null = null;
  for (const line of output.split("\n").map((entry) => entry.trim())) {
    const prefix = prefixes.find((candidate) => line.startsWith(candidate));
    if (!prefix) continue;
    const candidate = line.slice(prefix.length);
    if (
      requirement !== null ||
      candidate.length === 0 ||
      candidate.includes("\0")
    ) {
      throw new Error("LARK_CLI_SIGNATURE_INVALID");
    }
    requirement = candidate;
  }
  if (requirement === null) throw new Error("LARK_CLI_SIGNATURE_INVALID");
  return requirement;
}

async function codesignEvidence(executable: string): Promise<string> {
  const environment = Object.freeze({
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C",
    LC_ALL: "C",
  });
  await execute("/usr/bin/codesign", ["--verify", "--strict", executable], {
    encoding: "utf8",
    env: environment,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  const result = await execute("/usr/bin/codesign", ["-d", "-r-", executable], {
    encoding: "utf8",
    env: environment,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  return parseDesignatedRequirement(`${result.stdout}\n${result.stderr}`);
}

export function createInstalledLarkCliRunnerFactory(
  options: Readonly<{
    executable: string;
    homeDirectory: string;
  }>,
): MvpLarkCliRunnerFactory {
  const executable = options.executable;
  const homeDirectory = options.homeDirectory;
  const releaseRoot = dirname(dirname(executable));
  if (executable !== join(releaseRoot, "private-bin", "lark-cli")) {
    throw new Error("LARK_CLI_RELEASE_LAYOUT_INVALID");
  }

  const verifyRelease = async (
    requestedPath: string,
  ): Promise<MvpLarkCliReleaseEvidence> => {
    if (requestedPath !== executable) {
      throw new Error("LARK_CLI_EXECUTABLE_MISMATCH");
    }
    const receiptPath = join(releaseRoot, "install-receipt.json");
    const [executableMetadata, receiptMetadata] = await Promise.all([
      lstat(executable),
      lstat(receiptPath),
    ]);
    if (
      !executableMetadata.isFile() ||
      executableMetadata.isSymbolicLink() ||
      (executableMetadata.mode & 0o7777) !== 0o500 ||
      !receiptMetadata.isFile() ||
      receiptMetadata.isSymbolicLink() ||
      (receiptMetadata.mode & 0o7777) !== 0o600 ||
      (typeof process.getuid === "function" &&
        (executableMetadata.uid !== process.getuid() ||
          receiptMetadata.uid !== process.getuid())) ||
      (await realpath(executable)) !== executable ||
      (await realpath(receiptPath)) !== receiptPath
    ) {
      throw new Error("LARK_CLI_RELEASE_IDENTITY_INVALID");
    }
    const receiptBytes = await readFile(receiptPath);
    if (receiptBytes.byteLength === 0 || receiptBytes.byteLength > 64 * 1024) {
      throw new Error("LARK_CLI_RECEIPT_INVALID");
    }
    const receipt = parseReceipt(
      JSON.parse(receiptBytes.toString("utf8")) as unknown,
    );
    const actualSha256 = sha256(await readFile(executable));
    const expectedSha256 = `sha256:${receipt.binarySha256}` as const;
    if (actualSha256 !== expectedSha256) {
      throw new Error("LARK_CLI_BINARY_HASH_MISMATCH");
    }
    const designatedRequirement = await codesignEvidence(executable);
    return Object.freeze({
      version: 1,
      requestedPath: executable,
      realPath: executable,
      releaseRoot,
      package: "@larksuite/cli",
      packageVersion: LARK_CLI_VERSION,
      expectedSha256,
      actualSha256,
      designatedRequirement,
      signatureVerified: true,
      ownerUid: executableMetadata.uid,
      mode: 0o500,
      symlinkFree: true,
      profile: "executive-assistant",
      cliSchemaSha256: CLI_SCHEMA_SHA256,
    });
  };

  return (taskDirectory: string): MvpLarkCliRunner =>
    createMvpInstalledLarkCliRunner({
      executable,
      homeDirectory,
      taskDirectory,
      verifyRelease,
    });
}
