import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";

const SESSION_VERSION = 1;
const MAX_SESSION_FILE_BYTES = 1024 * 1024;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type SessionFile = Readonly<{
  version: 1;
  sessions: Readonly<Record<string, string>>;
}>;

function chatKey(chatId: string): string {
  return createHash("sha256").update(chatId, "utf8").digest("hex");
}

function safeSessionId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

function parseSessionFile(value: unknown): SessionFile {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 2
  ) {
    throw new Error("SESSION_STORE_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== SESSION_VERSION ||
    record.sessions === null ||
    typeof record.sessions !== "object" ||
    Array.isArray(record.sessions)
  ) {
    throw new Error("SESSION_STORE_INVALID");
  }
  const sessions: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [key, sessionId] of Object.entries(record.sessions)) {
    if (!/^[0-9a-f]{64}$/.test(key) || !safeSessionId(sessionId)) {
      throw new Error("SESSION_STORE_INVALID");
    }
    sessions[key] = sessionId;
  }
  return Object.freeze({
    version: SESSION_VERSION,
    sessions: Object.freeze(sessions),
  });
}

async function readSessions(path: string): Promise<SessionFile> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    const currentUid =
      typeof process.getuid === "function" ? process.getuid() : metadata.uid;
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o7777) !== 0o600 ||
      metadata.uid !== currentUid ||
      metadata.size < 0 ||
      metadata.size > MAX_SESSION_FILE_BYTES
    ) {
      throw new Error("SESSION_STORE_INVALID");
    }
    const bytes = await handle.readFile();
    if (bytes.length > MAX_SESSION_FILE_BYTES) {
      throw new Error("SESSION_STORE_INVALID");
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return parseSessionFile(JSON.parse(text) as unknown);
    } catch (cause) {
      if (cause instanceof Error && cause.message === "SESSION_STORE_INVALID") {
        throw cause;
      }
      throw new Error("SESSION_STORE_INVALID");
    }
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return Object.freeze({
        version: SESSION_VERSION,
        sessions: Object.freeze({}),
      });
    }
    if (cause instanceof Error && "code" in cause && cause.code === "ELOOP") {
      throw new Error("SESSION_STORE_INVALID");
    }
    if (cause instanceof SyntaxError) throw new Error("SESSION_STORE_INVALID");
    throw cause;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function atomicWrite(path: string, value: SessionFile): Promise<void> {
  const temporary = join(dirname(path), `.sessions-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw cause;
  }
}

export interface SessionStore {
  get(chatId: string): string | undefined;
  set(chatId: string, sessionId: string): Promise<void>;
}

export async function openSessionStore(path: string): Promise<SessionStore> {
  const initial = await readSessions(path);
  const sessions: Record<string, string> = Object.assign(
    Object.create(null) as object,
    initial.sessions,
  ) as Record<string, string>;
  let writes = Promise.resolve();

  return Object.freeze({
    get(chatId: string): string | undefined {
      return sessions[chatKey(chatId)];
    },
    async set(chatId: string, sessionId: string): Promise<void> {
      if (!safeSessionId(sessionId)) throw new Error("SESSION_ID_INVALID");
      sessions[chatKey(chatId)] = sessionId;
      writes = writes.then(() =>
        atomicWrite(
          path,
          Object.freeze({
            version: SESSION_VERSION,
            sessions: Object.freeze({ ...sessions }),
          }),
        ),
      );
      await writes;
    },
  });
}
