import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openSessionStore } from "../src/session-store.js";

const SESSION_ID = "018f7d72-7a2b-7f45-8a12-8e20b8426a21";
const CHAT_ID = "oc_boss";
const temporaryDirectories: string[] = [];

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "session-store-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("session store hardening", () => {
  it("persists and reloads only canonical UUID session ids", async () => {
    const directory = await fixtureDirectory();
    const path = join(directory, "sessions.json");
    const store = await openSessionStore(path);

    await store.set(CHAT_ID, SESSION_ID);

    const reopened = await openSessionStore(path);
    expect(reopened.get(CHAT_ID)).toBe(SESSION_ID);
    await expect(store.set(CHAT_ID, SESSION_ID.toUpperCase())).rejects.toThrow(
      "SESSION_ID_INVALID",
    );
    await expect(store.set(CHAT_ID, "not-a-uuid")).rejects.toThrow(
      "SESSION_ID_INVALID",
    );
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 1,
    });
  });

  it("rejects a sessions file reached through a symbolic link", async () => {
    const directory = await fixtureDirectory();
    const target = join(directory, "target.json");
    const path = join(directory, "sessions.json");
    await writeFile(target, JSON.stringify({ version: 1, sessions: {} }), {
      mode: 0o600,
    });
    await symlink(target, path);

    await expect(openSessionStore(path)).rejects.toThrow(
      "SESSION_STORE_INVALID",
    );
  });

  it("rejects sessions files whose permissions are not exactly 0600", async () => {
    const directory = await fixtureDirectory();
    const path = join(directory, "sessions.json");
    await writeFile(path, JSON.stringify({ version: 1, sessions: {} }), {
      mode: 0o600,
    });
    await chmod(path, 0o640);

    await expect(openSessionStore(path)).rejects.toThrow(
      "SESSION_STORE_INVALID",
    );
  });

  it("rejects oversized and non-canonical session data", async () => {
    const directory = await fixtureDirectory();
    const oversized = join(directory, "oversized.json");
    await writeFile(oversized, Buffer.alloc(1024 * 1024 + 1, 0x20), {
      mode: 0o600,
    });
    await expect(openSessionStore(oversized)).rejects.toThrow(
      "SESSION_STORE_INVALID",
    );

    const nonCanonical = join(directory, "non-canonical.json");
    await writeFile(
      nonCanonical,
      JSON.stringify({
        version: 1,
        sessions: {
          ["0".repeat(64)]: SESSION_ID.toUpperCase(),
        },
      }),
      { mode: 0o600 },
    );
    await expect(openSessionStore(nonCanonical)).rejects.toThrow(
      "SESSION_STORE_INVALID",
    );

    const malformedUtf8 = join(directory, "malformed-utf8.json");
    await writeFile(malformedUtf8, Buffer.from([0xc3, 0x28]), {
      mode: 0o600,
    });
    await expect(openSessionStore(malformedUtf8)).rejects.toThrow(
      "SESSION_STORE_INVALID",
    );
  });
});
