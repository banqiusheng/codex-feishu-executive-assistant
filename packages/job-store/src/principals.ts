import { types as utilTypes } from "node:util";

import type Database from "better-sqlite3";

import { hasLiveBridgeLease, snapshotDate } from "./leases.js";
import {
  RuntimeStateError,
  type BindPrincipalInput,
  type BindPrincipalResult,
} from "./types.js";

const INPUT_KEYS = Object.freeze([
  "appId",
  "tenantKey",
  "presidentOpenId",
  "presidentChatId",
  "pairedAt",
] as const);

function safeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f);
    })
  );
}

function snapshotInput(value: BindPrincipalInput): BindPrincipalInput {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      utilTypes.isProxy(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
    ) {
      throw new Error("invalid principal input");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== INPUT_KEYS.length ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !INPUT_KEYS.includes(key as (typeof INPUT_KEYS)[number]),
      )
    ) {
      throw new Error("invalid principal fields");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const read = (key: (typeof INPUT_KEYS)[number]): unknown => {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        throw new Error("invalid principal descriptor");
      }
      return descriptor.value;
    };
    const appId = read("appId");
    const tenantKey = read("tenantKey");
    const presidentOpenId = read("presidentOpenId");
    const presidentChatId = read("presidentChatId");
    const pairedAt = read("pairedAt");
    if (
      !safeIdentifier(appId) ||
      !safeIdentifier(tenantKey) ||
      !safeIdentifier(presidentOpenId) ||
      !safeIdentifier(presidentChatId) ||
      !(pairedAt instanceof Date)
    ) {
      throw new Error("invalid principal value");
    }
    return Object.freeze({
      appId,
      tenantKey,
      presidentOpenId,
      presidentChatId,
      pairedAt: new Date(pairedAt.getTime()),
    });
  } catch (cause) {
    throw new RuntimeStateError("principal_binding_input_is_invalid", cause);
  }
}

export function bindPrincipal(
  database: Database.Database,
  instanceId: string,
  inputValue: BindPrincipalInput,
): BindPrincipalResult {
  const input = snapshotInput(inputValue);
  const pairedAt = snapshotDate(
    input.pairedAt,
    "principal_binding_input_is_invalid",
  );
  try {
    return database
      .transaction(() => {
        if (!hasLiveBridgeLease(database, instanceId, pairedAt)) {
          throw new RuntimeStateError("bridge_runtime_lease_is_not_live");
        }
        const existing = database
          .prepare(
            `SELECT president_open_id AS presidentOpenId,
                    president_chat_id AS presidentChatId
               FROM principals
              WHERE app_id = ? AND tenant_key = ?`,
          )
          .get(input.appId, input.tenantKey) as
          | Readonly<{
              presidentOpenId: unknown;
              presidentChatId: unknown;
            }>
          | undefined;
        if (existing !== undefined) {
          if (
            existing.presidentOpenId !== input.presidentOpenId ||
            existing.presidentChatId !== input.presidentChatId
          ) {
            throw new RuntimeStateError("principal_binding_conflict");
          }
          return Object.freeze({ created: false });
        }
        const changed = database
          .prepare(
            `INSERT INTO principals(
               app_id, tenant_key, president_open_id, president_chat_id,
               paired_at
             ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            input.appId,
            input.tenantKey,
            input.presidentOpenId,
            input.presidentChatId,
            pairedAt.iso,
          ).changes;
        if (changed !== 1) {
          throw new RuntimeStateError("principal_binding_failed");
        }
        return Object.freeze({ created: true });
      })
      .immediate();
  } catch (cause) {
    if (cause instanceof RuntimeStateError) throw cause;
    throw new RuntimeStateError("principal_binding_failed", cause);
  }
}
