import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { types as utilTypes } from "node:util";

import type {
  CurrentMessageResourceDescriptor,
  QuotedMessageCandidate,
} from "@executive-assistant/bridge";
import type {
  JobStore,
  ResolvedTaskResource,
  TaskResourceDescriptor,
  TaskResourceKind,
  TaskResourceSummary,
} from "@executive-assistant/job-store";

import type {
  RuntimeDownloadResourceRequest,
  RuntimeQuotedMessage,
  RuntimeQuotedResource,
  RuntimeTransport,
} from "./types.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_RESOURCE_COUNT = 20;
const MAX_RESOURCE_FILE_BYTES = 100 * 1024 * 1024;
const MAX_RESOURCE_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_TEXT_BYTES = 200_000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type ResourceStore = Pick<
  JobStore,
  | "registerTaskResourcesForTask"
  | "resolveTaskResourceForTask"
  | "listTaskResourcesForTask"
>;

type ResourceTransport = Pick<
  RuntimeTransport,
  "readQuotedMessage" | "downloadResource"
>;

export type InboundResourceStagingDependencies = Readonly<{
  transport: ResourceTransport;
  store: ResourceStore;
}>;

export type InboundResourceStagingRequest = Readonly<{
  taskId: string;
  taskWorkspace: string;
  currentMessageId: string;
  currentInstructionText: string;
  currentResources: readonly CurrentMessageResourceDescriptor[];
  quotedCandidate: QuotedMessageCandidate | null;
  presidentChatId: string;
  presidentOpenId: string;
  now: Date;
}>;

export type InboundResourceAcquisition = Readonly<{
  currentResources: readonly CurrentMessageResourceDescriptor[];
  quotedCandidate: QuotedMessageCandidate | null;
}>;

export type StagedInboundResources = Readonly<{
  currentTextRef: string;
  quotedTextRef: string | null;
  attachments: readonly TaskResourceSummary[];
}>;

type SnapshotRequest = Readonly<{
  taskId: string;
  taskWorkspace: string;
  currentMessageId: string;
  currentInstructionText: string;
  currentResources: readonly CurrentMessageResourceDescriptor[];
  quotedCandidate: QuotedMessageCandidate | null;
  presidentChatId: string;
  presidentOpenId: string;
  now: Date;
}>;

type PendingResource = Readonly<{
  sourceKind: "current" | "quoted";
  sourceMessageId: string;
  kind: TaskResourceKind;
  displayName: string;
  download: null | RuntimeDownloadResourceRequest;
  text: string | null;
}>;

type WrittenResource = Readonly<{
  descriptor: TaskResourceDescriptor;
  attachment: boolean;
  identity: Readonly<{
    dev: number;
    ino: number;
  }>;
}>;

function fixedError(code: string): Error {
  return new Error(code);
}

function isProxy(value: object): boolean {
  try {
    return utilTypes.isProxy(value);
  } catch {
    return true;
  }
}

function ownData(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    isProxy(value)
  ) {
    throw fixedError("INBOUND_RESOURCE_INPUT_INVALID");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw fixedError("INBOUND_RESOURCE_INPUT_INVALID");
  }
  const ownKeys = Reflect.ownKeys(value);
  const expected = new Set(keys);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !expected.has(key))
  ) {
    throw fixedError("INBOUND_RESOURCE_INPUT_INVALID");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      throw fixedError("INBOUND_RESOURCE_INPUT_INVALID");
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function displayName(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value !== value.trim() ||
    value.normalize("NFC") !== value ||
    value === "." ||
    value === ".."
  ) {
    return false;
  }
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f);
  });
}

function snapshotArray(value: unknown): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw fixedError("INBOUND_RESOURCE_INPUT_INVALID");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > MAX_RESOURCE_COUNT
  ) {
    throw fixedError("INBOUND_RESOURCE_INPUT_INVALID");
  }
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== length + 1 ||
    !keys.includes("length") ||
    keys.some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" ||
          !/^(0|[1-9]\d*)$/.test(key) ||
          Number(key) >= length),
    )
  ) {
    throw fixedError("INBOUND_RESOURCE_INPUT_INVALID");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      throw fixedError("INBOUND_RESOURCE_INPUT_INVALID");
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function snapshotCurrentResource(
  value: unknown,
  currentMessageId: string,
): CurrentMessageResourceDescriptor {
  const common = ownData(
    value,
    value !== null &&
      typeof value === "object" &&
      Object.prototype.hasOwnProperty.call(value, "imageKey")
      ? ["sourceKind", "messageId", "kind", "imageKey", "displayName"]
      : ["sourceKind", "messageId", "kind", "fileKey", "displayName"],
  );
  if (
    common.sourceKind !== "current" ||
    common.messageId !== currentMessageId ||
    !displayName(common.displayName)
  ) {
    throw fixedError("INBOUND_RESOURCE_INPUT_INVALID");
  }
  if (common.kind === "image" && identifier(common.imageKey)) {
    return Object.freeze({
      sourceKind: "current",
      messageId: currentMessageId,
      kind: "image",
      imageKey: common.imageKey,
      displayName: common.displayName,
    });
  }
  if (common.kind === "file" && identifier(common.fileKey)) {
    return Object.freeze({
      sourceKind: "current",
      messageId: currentMessageId,
      kind: "file",
      fileKey: common.fileKey,
      displayName: common.displayName,
    });
  }
  throw fixedError("INBOUND_RESOURCE_INPUT_INVALID");
}

function snapshotRequest(
  value: InboundResourceStagingRequest,
): SnapshotRequest {
  const input = ownData(value, [
    "taskId",
    "taskWorkspace",
    "currentMessageId",
    "currentInstructionText",
    "currentResources",
    "quotedCandidate",
    "presidentChatId",
    "presidentOpenId",
    "now",
  ]);
  if (
    typeof input.taskId !== "string" ||
    !UUID.test(input.taskId) ||
    typeof input.taskWorkspace !== "string" ||
    input.taskWorkspace !== resolve(input.taskWorkspace) ||
    !identifier(input.currentMessageId) ||
    typeof input.currentInstructionText !== "string" ||
    input.currentInstructionText.length === 0 ||
    Buffer.byteLength(input.currentInstructionText, "utf8") > MAX_TEXT_BYTES ||
    !identifier(input.presidentChatId) ||
    !identifier(input.presidentOpenId) ||
    !(input.now instanceof Date) ||
    isProxy(input.now) ||
    Object.getPrototypeOf(input.now) !== Date.prototype ||
    Reflect.ownKeys(input.now).length !== 0 ||
    !Number.isFinite(input.now.getTime())
  ) {
    throw fixedError("INBOUND_RESOURCE_INPUT_INVALID");
  }
  const acquisition = snapshotInboundResourceAcquisition(
    input.currentMessageId,
    input.currentResources,
    input.quotedCandidate,
  );
  return Object.freeze({
    taskId: input.taskId,
    taskWorkspace: input.taskWorkspace,
    currentMessageId: input.currentMessageId,
    currentInstructionText: input.currentInstructionText,
    currentResources: acquisition.currentResources,
    quotedCandidate: acquisition.quotedCandidate,
    presidentChatId: input.presidentChatId,
    presidentOpenId: input.presidentOpenId,
    now: new Date(input.now.getTime()),
  }) as SnapshotRequest;
}

export function snapshotInboundResourceAcquisition(
  currentMessageIdValue: unknown,
  currentResourcesValue: unknown,
  quotedCandidateValue: unknown,
): InboundResourceAcquisition {
  if (!identifier(currentMessageIdValue)) {
    throw fixedError("INBOUND_RESOURCE_INPUT_INVALID");
  }
  const currentResources = snapshotArray(currentResourcesValue).map(
    (resource) => snapshotCurrentResource(resource, currentMessageIdValue),
  );
  let quotedCandidate: QuotedMessageCandidate | null = null;
  if (quotedCandidateValue !== null) {
    const candidate = ownData(quotedCandidateValue, ["parentId"]);
    if (!identifier(candidate.parentId)) {
      throw fixedError("INBOUND_RESOURCE_INPUT_INVALID");
    }
    quotedCandidate = Object.freeze({ parentId: candidate.parentId });
  }
  return Object.freeze({
    currentResources: Object.freeze(currentResources),
    quotedCandidate,
  });
}

function snapshotQuotedResource(value: unknown): RuntimeQuotedResource {
  const record = ownData(
    value,
    value !== null &&
      typeof value === "object" &&
      Object.prototype.hasOwnProperty.call(value, "imageKey")
      ? ["kind", "imageKey", "displayName"]
      : ["kind", "fileKey", "displayName"],
  );
  if (!displayName(record.displayName)) {
    throw fixedError("INBOUND_RESOURCE_QUOTE_INVALID");
  }
  if (record.kind === "image" && identifier(record.imageKey)) {
    return Object.freeze({
      kind: "image",
      imageKey: record.imageKey,
      displayName: record.displayName,
    });
  }
  if (record.kind === "file" && identifier(record.fileKey)) {
    return Object.freeze({
      kind: "file",
      fileKey: record.fileKey,
      displayName: record.displayName,
    });
  }
  throw fixedError("INBOUND_RESOURCE_QUOTE_INVALID");
}

function snapshotQuotedMessage(
  value: RuntimeQuotedMessage | null,
  input: SnapshotRequest,
): RuntimeQuotedMessage {
  if (value === null || input.quotedCandidate === null) {
    throw fixedError("INBOUND_RESOURCE_QUOTE_INVALID");
  }
  let record: Readonly<Record<string, unknown>>;
  try {
    record = ownData(value, [
      "messageId",
      "chatId",
      "senderOpenId",
      "text",
      "resources",
    ]);
  } catch {
    throw fixedError("INBOUND_RESOURCE_QUOTE_INVALID");
  }
  if (
    record.messageId !== input.quotedCandidate.parentId ||
    record.chatId !== input.presidentChatId ||
    record.senderOpenId !== input.presidentOpenId ||
    typeof record.text !== "string" ||
    Buffer.byteLength(record.text, "utf8") > MAX_TEXT_BYTES
  ) {
    throw fixedError("INBOUND_RESOURCE_QUOTE_INVALID");
  }
  let resources: readonly RuntimeQuotedResource[];
  try {
    resources = snapshotArray(record.resources).map(snapshotQuotedResource);
  } catch {
    throw fixedError("INBOUND_RESOURCE_QUOTE_INVALID");
  }
  return Object.freeze({
    messageId: record.messageId,
    chatId: record.chatId,
    senderOpenId: record.senderOpenId,
    text: record.text,
    resources: Object.freeze(resources),
  });
}

function messageHash(messageId: string): string {
  return createHash("sha256").update(messageId, "utf8").digest("hex");
}

function pendingResources(
  input: SnapshotRequest,
  quoted: RuntimeQuotedMessage | null,
): readonly PendingResource[] {
  const pending: PendingResource[] = [
    Object.freeze({
      sourceKind: "current",
      sourceMessageId: input.currentMessageId,
      kind: "text",
      displayName: "当前指令.txt",
      download: null,
      text: input.currentInstructionText,
    }),
  ];
  for (const resource of input.currentResources) {
    pending.push(
      Object.freeze({
        sourceKind: "current",
        sourceMessageId: input.currentMessageId,
        kind: resource.kind,
        displayName: resource.displayName,
        download:
          resource.kind === "image"
            ? Object.freeze({
                messageId: input.currentMessageId,
                kind: "image" as const,
                imageKey: resource.imageKey,
              })
            : Object.freeze({
                messageId: input.currentMessageId,
                kind: "file" as const,
                fileKey: resource.fileKey,
              }),
        text: null,
      }),
    );
  }
  if (quoted !== null) {
    pending.push(
      Object.freeze({
        sourceKind: "quoted",
        sourceMessageId: quoted.messageId,
        kind: "text",
        displayName: "引用消息.txt",
        download: null,
        text: quoted.text,
      }),
    );
    for (const resource of quoted.resources) {
      pending.push(
        Object.freeze({
          sourceKind: "quoted",
          sourceMessageId: quoted.messageId,
          kind: resource.kind,
          displayName: resource.displayName,
          download:
            resource.kind === "image"
              ? Object.freeze({
                  messageId: quoted.messageId,
                  kind: "image" as const,
                  imageKey: resource.imageKey,
                })
              : Object.freeze({
                  messageId: quoted.messageId,
                  kind: "file" as const,
                  fileKey: resource.fileKey,
                }),
          text: null,
        }),
      );
    }
  }
  if (pending.length > MAX_RESOURCE_COUNT) {
    throw fixedError("INBOUND_RESOURCE_LIMIT_EXCEEDED");
  }
  return Object.freeze(pending);
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function matchesFileIdentity(
  metadata: Stats,
  identity: WrittenResource["identity"],
): boolean {
  return metadata.dev === identity.dev && metadata.ino === identity.ino;
}

async function assertPrivateWorkspace(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
    (typeof process.getuid === "function" &&
      metadata.uid !== process.getuid()) ||
    (await realpath(path)) !== path
  ) {
    throw fixedError("INBOUND_RESOURCE_WORKSPACE_INVALID");
  }
}

async function hashOpenFile(
  handle: Awaited<ReturnType<typeof open>>,
  sizeBytes: number,
): Promise<string> {
  const verification = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < sizeBytes) {
    const read = await handle.read(
      buffer,
      0,
      Math.min(buffer.byteLength, sizeBytes - position),
      position,
    );
    if (read.bytesRead <= 0) {
      throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
    }
    verification.update(buffer.subarray(0, read.bytesRead));
    position += read.bytesRead;
  }
  return verification.digest("hex");
}

async function chunksFor(
  transport: ResourceTransport,
  resource: PendingResource,
): Promise<AsyncIterable<Uint8Array>> {
  if (resource.text !== null) {
    const content = Buffer.from(resource.text, "utf8");
    return (async function* () {
      yield content;
    })();
  }
  if (resource.download === null) {
    throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
  }
  const downloaded = await transport.downloadResource(resource.download);
  if (
    downloaded === null ||
    typeof downloaded !== "object" ||
    typeof downloaded[Symbol.asyncIterator] !== "function"
  ) {
    throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
  }
  return downloaded;
}

async function writeOne(
  transport: ResourceTransport,
  resourcesPath: string,
  index: number,
  resource: PendingResource,
  consumedTotal: { value: number },
): Promise<WrittenResource> {
  const extension = resource.kind === "text" ? "txt" : "bin";
  const name = `${String(index).padStart(2, "0")}-${randomUUID()}.${extension}`;
  const path = join(resourcesPath, name);
  const relativePath = `resources/${name}`;
  const handle = await open(
    path,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_RDWR |
      fsConstants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  let closed = false;
  try {
    await handle.chmod(PRIVATE_FILE_MODE);
    const digest = createHash("sha256");
    let sizeBytes = 0;
    const chunks = await chunksFor(transport, resource);
    for await (const chunk of chunks) {
      if (
        !(chunk instanceof Uint8Array) ||
        isProxy(chunk) ||
        !Number.isSafeInteger(chunk.byteLength)
      ) {
        throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
      }
      const nextFileSize = sizeBytes + chunk.byteLength;
      const nextTotalSize = consumedTotal.value + chunk.byteLength;
      if (
        nextFileSize > MAX_RESOURCE_FILE_BYTES ||
        nextTotalSize > MAX_RESOURCE_TOTAL_BYTES
      ) {
        throw fixedError("INBOUND_RESOURCE_LIMIT_EXCEEDED");
      }
      const stableChunk = Buffer.from(
        chunk.buffer,
        chunk.byteOffset,
        chunk.byteLength,
      );
      let offset = 0;
      while (offset < stableChunk.byteLength) {
        const written = await handle.write(
          stableChunk,
          offset,
          stableChunk.byteLength - offset,
          null,
        );
        if (written.bytesWritten <= 0) {
          throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
        }
        offset += written.bytesWritten;
      }
      digest.update(stableChunk);
      sizeBytes = nextFileSize;
      consumedTotal.value = nextTotalSize;
    }
    await handle.sync();
    const openMetadata = await handle.stat();
    if (
      !openMetadata.isFile() ||
      openMetadata.nlink !== 1 ||
      openMetadata.size !== sizeBytes ||
      (openMetadata.mode & 0o777) !== PRIVATE_FILE_MODE
    ) {
      throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
    }

    const sha256 = digest.digest("hex");
    if ((await hashOpenFile(handle, sizeBytes)) !== sha256) {
      throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
    }
    await handle.close();
    closed = true;

    const closedMetadata = await lstat(path);
    if (
      closedMetadata.isSymbolicLink() ||
      !closedMetadata.isFile() ||
      closedMetadata.nlink !== 1 ||
      closedMetadata.size !== sizeBytes ||
      (closedMetadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
      !sameFileIdentity(openMetadata, closedMetadata) ||
      (typeof process.getuid === "function" &&
        closedMetadata.uid !== process.getuid()) ||
      (await realpath(path)) !== path
    ) {
      throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
    }
    return Object.freeze({
      descriptor: Object.freeze({
        sourceKind: resource.sourceKind,
        sourceMessageHash: messageHash(resource.sourceMessageId),
        kind: resource.kind,
        displayName: resource.displayName,
        relativePath,
        sizeBytes,
        sha256,
      }),
      attachment: resource.kind !== "text",
      identity: Object.freeze({
        dev: openMetadata.dev,
        ino: openMetadata.ino,
      }),
    });
  } finally {
    if (!closed) await handle.close().catch(() => undefined);
  }
}

async function assertStableResourceDirectory(
  resourcesPath: string,
  initialMetadata: Stats,
): Promise<void> {
  const currentMetadata = await lstat(resourcesPath);
  const canonicalPath = await realpath(resourcesPath);
  const confirmedMetadata = await lstat(resourcesPath);
  if (
    currentMetadata.isSymbolicLink() ||
    !currentMetadata.isDirectory() ||
    !sameFileIdentity(initialMetadata, currentMetadata) ||
    (currentMetadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
    (typeof process.getuid === "function" &&
      currentMetadata.uid !== process.getuid()) ||
    canonicalPath !== resourcesPath ||
    confirmedMetadata.isSymbolicLink() ||
    !confirmedMetadata.isDirectory() ||
    !sameFileIdentity(initialMetadata, confirmedMetadata) ||
    (confirmedMetadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
    (typeof process.getuid === "function" &&
      confirmedMetadata.uid !== process.getuid())
  ) {
    throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
  }
}

async function verifyWrittenResource(
  taskWorkspace: string,
  resourcesPath: string,
  initialDirectoryMetadata: Stats,
  written: WrittenResource,
): Promise<void> {
  const path = join(taskWorkspace, written.descriptor.relativePath);
  if (dirname(path) !== resourcesPath || resolve(path) !== path) {
    throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
  }
  await assertStableResourceDirectory(resourcesPath, initialDirectoryMetadata);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      !matchesFileIdentity(openedMetadata, written.identity) ||
      openedMetadata.nlink !== 1 ||
      openedMetadata.size !== written.descriptor.sizeBytes ||
      (openedMetadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
      (typeof process.getuid === "function" &&
        openedMetadata.uid !== process.getuid()) ||
      (await hashOpenFile(handle, openedMetadata.size)) !==
        written.descriptor.sha256
    ) {
      throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
    }
    const verifiedMetadata = await handle.stat();
    const pathMetadata = await lstat(path);
    const canonicalPath = await realpath(path);
    const confirmedPathMetadata = await lstat(path);
    if (
      !sameFileIdentity(openedMetadata, verifiedMetadata) ||
      !matchesFileIdentity(verifiedMetadata, written.identity) ||
      verifiedMetadata.nlink !== 1 ||
      verifiedMetadata.size !== written.descriptor.sizeBytes ||
      (verifiedMetadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
      pathMetadata.isSymbolicLink() ||
      !pathMetadata.isFile() ||
      !matchesFileIdentity(pathMetadata, written.identity) ||
      pathMetadata.nlink !== 1 ||
      pathMetadata.size !== written.descriptor.sizeBytes ||
      (pathMetadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
      (typeof process.getuid === "function" &&
        pathMetadata.uid !== process.getuid()) ||
      canonicalPath !== path ||
      confirmedPathMetadata.isSymbolicLink() ||
      !confirmedPathMetadata.isFile() ||
      !matchesFileIdentity(confirmedPathMetadata, written.identity) ||
      confirmedPathMetadata.nlink !== 1 ||
      confirmedPathMetadata.size !== written.descriptor.sizeBytes ||
      (confirmedPathMetadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
      (typeof process.getuid === "function" &&
        confirmedPathMetadata.uid !== process.getuid())
    ) {
      throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await assertStableResourceDirectory(resourcesPath, initialDirectoryMetadata);
}

async function verifyWrittenBatch(
  taskWorkspace: string,
  resourcesPath: string,
  initialDirectoryMetadata: Stats,
  written: readonly WrittenResource[],
): Promise<void> {
  const expectedNames = new Set(
    written.map(({ descriptor }) => basename(descriptor.relativePath)),
  );
  const assertExactEntries = async (): Promise<void> => {
    const actualNames = await readdir(resourcesPath);
    if (
      actualNames.length !== expectedNames.size ||
      actualNames.some((name) => !expectedNames.has(name))
    ) {
      throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
    }
  };
  await assertStableResourceDirectory(resourcesPath, initialDirectoryMetadata);
  await assertExactEntries();
  for (const resource of written) {
    await verifyWrittenResource(
      taskWorkspace,
      resourcesPath,
      initialDirectoryMetadata,
      resource,
    );
  }
  await assertStableResourceDirectory(resourcesPath, initialDirectoryMetadata);
  await assertExactEntries();
}

function resolvedMatches(
  resolved: ResolvedTaskResource,
  descriptor: TaskResourceDescriptor,
  summary: TaskResourceSummary,
): boolean {
  return (
    resolved.resourceRef === summary.resourceRef &&
    resolved.sourceKind === descriptor.sourceKind &&
    resolved.sourceMessageHash === descriptor.sourceMessageHash &&
    resolved.kind === descriptor.kind &&
    resolved.displayName === descriptor.displayName &&
    resolved.relativePath === descriptor.relativePath &&
    resolved.sizeBytes === descriptor.sizeBytes &&
    resolved.sha256 === descriptor.sha256 &&
    summary.kind === descriptor.kind &&
    summary.displayName === descriptor.displayName &&
    summary.sizeBytes === descriptor.sizeBytes
  );
}

const INTERNAL_RESOURCE_NAME =
  /^(0[0-9]|1[0-9])-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(txt|bin)$/;

async function privateResourceDirectory(resourcesPath: string): Promise<Stats> {
  const metadata = await lstat(resourcesPath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
    (typeof process.getuid === "function" &&
      metadata.uid !== process.getuid()) ||
    (await realpath(resourcesPath)) !== resourcesPath
  ) {
    throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
  }
  return metadata;
}

async function cleanRecoverableUnregisteredDirectory(
  resourcesPath: string,
): Promise<boolean> {
  let directoryMetadata: Stats;
  try {
    directoryMetadata = await privateResourceDirectory(resourcesPath);
  } catch (cause) {
    if (
      cause !== null &&
      typeof cause === "object" &&
      "code" in cause &&
      cause.code === "ENOENT"
    ) {
      return false;
    }
    throw cause;
  }
  const names = (await readdir(resourcesPath)).sort();
  const evidence: Array<Readonly<{ name: string; metadata: Stats }>> = [];
  for (const name of names) {
    if (!INTERNAL_RESOURCE_NAME.test(name)) {
      throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
    }
    const path = join(resourcesPath, name);
    const metadata = await lstat(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
      (typeof process.getuid === "function" &&
        metadata.uid !== process.getuid()) ||
      (await realpath(path)) !== path
    ) {
      throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
    }
    evidence.push(Object.freeze({ name, metadata }));
  }
  await assertStableResourceDirectory(resourcesPath, directoryMetadata);
  const confirmedNames = (await readdir(resourcesPath)).sort();
  if (
    confirmedNames.length !== evidence.length ||
    confirmedNames.some((name, index) => name !== evidence[index]?.name)
  ) {
    throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
  }
  for (const entry of evidence) {
    const path = join(resourcesPath, entry.name);
    const current = await lstat(path);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      !sameFileIdentity(current, entry.metadata) ||
      current.nlink !== 1 ||
      (current.mode & 0o777) !== PRIVATE_FILE_MODE
    ) {
      throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
    }
  }
  for (const entry of evidence) {
    await rm(join(resourcesPath, entry.name));
  }
  await rmdir(resourcesPath);
  return true;
}

function recoveredSummary(resource: ResolvedTaskResource): TaskResourceSummary {
  return Object.freeze({
    resourceRef: resource.resourceRef,
    kind: resource.kind,
    displayName: resource.displayName,
    sizeBytes: resource.sizeBytes,
  });
}

async function recoverRegisteredResources(
  store: ResourceStore,
  input: SnapshotRequest,
  resourcesPath: string,
  resources: readonly ResolvedTaskResource[],
): Promise<StagedInboundResources> {
  if (resources.length < 1 || resources.length > MAX_RESOURCE_COUNT) {
    throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
  }
  const directoryMetadata = await privateResourceDirectory(resourcesPath);
  const currentHash = messageHash(input.currentMessageId);
  const quotedHash =
    input.quotedCandidate === null
      ? null
      : messageHash(input.quotedCandidate.parentId);
  const expectedCurrentCount = 1 + input.currentResources.length;
  const currentText = resources[0];
  if (
    currentText === undefined ||
    currentText.sourceKind !== "current" ||
    currentText.sourceMessageHash !== currentHash ||
    currentText.kind !== "text" ||
    currentText.displayName !== "当前指令.txt"
  ) {
    throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
  }
  for (let index = 0; index < resources.length; index += 1) {
    const resource = resources[index];
    const name = basename(resource?.relativePath ?? "");
    const match = INTERNAL_RESOURCE_NAME.exec(name);
    if (
      resource === undefined ||
      match === null ||
      Number(match[1]) !== index ||
      (index < expectedCurrentCount
        ? resource.sourceKind !== "current" ||
          resource.sourceMessageHash !== currentHash
        : quotedHash === null ||
          resource.sourceKind !== "quoted" ||
          resource.sourceMessageHash !== quotedHash)
    ) {
      throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
    }
    if (index > 0 && index < expectedCurrentCount) {
      const expected = input.currentResources[index - 1];
      if (
        expected === undefined ||
        resource.kind !== expected.kind ||
        resource.displayName !== expected.displayName
      ) {
        throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
      }
    }
  }
  if (
    (quotedHash === null && resources.length !== expectedCurrentCount) ||
    (quotedHash !== null &&
      (resources.length <= expectedCurrentCount ||
        resources[expectedCurrentCount]?.kind !== "text" ||
        resources[expectedCurrentCount]?.displayName !== "引用消息.txt"))
  ) {
    throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
  }
  const written = await Promise.all(
    resources.map(async (resource) => {
      const path = join(input.taskWorkspace, resource.relativePath);
      const metadata = await lstat(path);
      return Object.freeze({
        descriptor: Object.freeze({
          sourceKind: resource.sourceKind,
          sourceMessageHash: resource.sourceMessageHash,
          kind: resource.kind,
          displayName: resource.displayName,
          relativePath: resource.relativePath,
          sizeBytes: resource.sizeBytes,
          sha256: resource.sha256,
        }),
        attachment: resource.kind !== "text",
        identity: Object.freeze({ dev: metadata.dev, ino: metadata.ino }),
      });
    }),
  );
  await verifyWrittenBatch(
    input.taskWorkspace,
    resourcesPath,
    directoryMetadata,
    written,
  );
  const currentTextBody = await readFile(
    join(input.taskWorkspace, currentText.relativePath),
    "utf8",
  );
  if (currentTextBody !== input.currentInstructionText) {
    throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
  }
  for (const resource of resources) {
    const resolved = store.resolveTaskResourceForTask(
      input.taskId,
      resource.resourceRef,
      resource.kind,
    );
    if (
      resolved.resourceRef !== resource.resourceRef ||
      resolved.relativePath !== resource.relativePath ||
      resolved.sha256 !== resource.sha256
    ) {
      throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
    }
  }
  const quotedText =
    quotedHash === null ? null : resources[expectedCurrentCount];
  return Object.freeze({
    currentTextRef: currentText.resourceRef,
    quotedTextRef: quotedText?.resourceRef ?? null,
    attachments: Object.freeze(
      resources
        .filter((resource) => resource.kind !== "text")
        .map(recoveredSummary),
    ),
  });
}

export async function stageInboundResources(
  dependencies: InboundResourceStagingDependencies,
  requestValue: InboundResourceStagingRequest,
): Promise<StagedInboundResources> {
  const input = snapshotRequest(requestValue);
  const resourcesPath = join(input.taskWorkspace, "resources");
  try {
    await assertPrivateWorkspace(input.taskWorkspace);
    const registered = dependencies.store.listTaskResourcesForTask(
      input.taskId,
    );
    if (!Array.isArray(registered)) {
      throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
    }
    if (registered.length > 0) {
      return await recoverRegisteredResources(
        dependencies.store,
        input,
        resourcesPath,
        registered,
      );
    }
    await cleanRecoverableUnregisteredDirectory(resourcesPath);
  } catch (cause) {
    if (
      cause instanceof Error &&
      cause.message === "INBOUND_RESOURCE_WORKSPACE_INVALID"
    ) {
      throw cause;
    }
    throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
  }
  let quoted: RuntimeQuotedMessage | null = null;
  if (input.quotedCandidate !== null) {
    let rawQuoted: RuntimeQuotedMessage | null;
    try {
      rawQuoted = await dependencies.transport.readQuotedMessage(
        Object.freeze({ messageId: input.quotedCandidate.parentId }),
      );
    } catch {
      throw fixedError("INBOUND_RESOURCE_QUOTE_INVALID");
    }
    quoted = snapshotQuotedMessage(rawQuoted, input);
  }
  const pending = pendingResources(input, quoted);
  let resourcesDirectoryCreated = false;
  let registrationCompleted = false;
  try {
    await assertPrivateWorkspace(input.taskWorkspace);
    await mkdir(resourcesPath, { mode: PRIVATE_DIRECTORY_MODE });
    resourcesDirectoryCreated = true;
    await chmod(resourcesPath, PRIVATE_DIRECTORY_MODE);
    const directoryMetadata = await lstat(resourcesPath);
    if (
      directoryMetadata.isSymbolicLink() ||
      !directoryMetadata.isDirectory() ||
      (directoryMetadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
      (typeof process.getuid === "function" &&
        directoryMetadata.uid !== process.getuid()) ||
      (await realpath(resourcesPath)) !== resourcesPath
    ) {
      throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
    }

    const consumedTotal = { value: 0 };
    const written: WrittenResource[] = [];
    for (let index = 0; index < pending.length; index += 1) {
      const resource = pending[index];
      if (!resource) throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
      written.push(
        await writeOne(
          dependencies.transport,
          resourcesPath,
          index,
          resource,
          consumedTotal,
        ),
      );
    }
    const descriptors = Object.freeze(
      written.map(({ descriptor }) => descriptor),
    );
    await verifyWrittenBatch(
      input.taskWorkspace,
      resourcesPath,
      directoryMetadata,
      written,
    );
    const registered = dependencies.store.registerTaskResourcesForTask(
      input.taskId,
      descriptors,
      input.now,
    );
    registrationCompleted = true;
    if (
      !Array.isArray(registered) ||
      registered.length !== descriptors.length
    ) {
      throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
    }
    for (let index = 0; index < descriptors.length; index += 1) {
      const descriptor = descriptors[index];
      const summary = registered[index];
      if (
        descriptor === undefined ||
        summary === undefined ||
        typeof summary.resourceRef !== "string" ||
        !UUID.test(summary.resourceRef)
      ) {
        throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
      }
      const resolved = dependencies.store.resolveTaskResourceForTask(
        input.taskId,
        summary.resourceRef,
        descriptor.kind,
      );
      if (!resolvedMatches(resolved, descriptor, summary)) {
        throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
      }
    }
    const currentTextRef = registered[0]?.resourceRef;
    if (currentTextRef === undefined) {
      throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
    }
    const quotedTextIndex =
      quoted === null ? -1 : 1 + input.currentResources.length;
    const quotedTextRef =
      quotedTextIndex < 0
        ? null
        : (registered[quotedTextIndex]?.resourceRef ?? null);
    if (quoted !== null && quotedTextRef === null) {
      throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
    }
    const attachments = Object.freeze(
      registered.filter((_summary, index) => written[index]?.attachment),
    );
    return Object.freeze({
      currentTextRef,
      quotedTextRef,
      attachments,
    });
  } catch {
    if (resourcesDirectoryCreated && !registrationCompleted) {
      await rm(resourcesPath, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    throw fixedError("INBOUND_RESOURCE_STAGING_FAILED");
  }
}
