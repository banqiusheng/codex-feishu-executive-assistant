import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireDatabaseFileLock, openJobStore } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const created = await mkdtemp(join(tmpdir(), "principal-store-"));
  await chmod(created, 0o700);
  const runtimeRoot = await realpath(created);
  roots.push(runtimeRoot);
  const lock = await acquireDatabaseFileLock(runtimeRoot);
  const store = openJobStore({
    filename: join(runtimeRoot, "assistant.sqlite"),
    instanceId: "principal-test-instance",
    lock,
  });
  return { lock, store };
}

describe("principal binding", () => {
  it("creates once, replays the same identity, and rejects rebinding", async () => {
    const { lock, store } = await fixture();
    const now = new Date("2026-07-23T10:00:00.000Z");
    expect(
      store.acquireRuntimeLease(
        "bridge",
        "principal-test-instance",
        now,
        60_000,
      ),
    ).toBe(true);
    const input = Object.freeze({
      appId: "cli_test_app",
      tenantKey: "tenant_test_001",
      presidentOpenId: "ou_synthetic_president",
      presidentChatId: "oc_synthetic_private_chat",
      pairedAt: now,
    });
    expect(store.bindPrincipal(input)).toEqual({ created: true });
    expect(
      store.bindPrincipal({
        ...input,
        pairedAt: new Date(now.getTime() + 1_000),
      }),
    ).toEqual({ created: false });
    expect(() =>
      store.bindPrincipal({
        ...input,
        presidentOpenId: "ou_other_president",
      }),
    ).toThrow(/principal_binding_conflict/);
    store.close();
    await lock.release();
  });

  it("requires the caller's live bridge lease", async () => {
    const { lock, store } = await fixture();
    expect(() =>
      store.bindPrincipal({
        appId: "cli_test_app",
        tenantKey: "tenant_test_001",
        presidentOpenId: "ou_synthetic_president",
        presidentChatId: "oc_synthetic_private_chat",
        pairedAt: new Date("2026-07-23T10:00:00.000Z"),
      }),
    ).toThrow(/bridge_runtime_lease_is_not_live/);
    store.close();
    await lock.release();
  });
});
