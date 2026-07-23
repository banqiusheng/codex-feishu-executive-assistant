import { InboundEventSchema } from "@executive-assistant/contracts";
import type Database from "better-sqlite3";

import { RuntimeStateError } from "./types.js";

const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;

type RuntimeLeaseRow = Readonly<{
  owner: string;
  expiresAt: string;
  updatedAt: string;
}>;

export type ClockSnapshot = Readonly<{
  milliseconds: number;
  iso: string;
}>;

export function snapshotDate(
  value: Date,
  detail = "clock_is_invalid",
): ClockSnapshot {
  try {
    const milliseconds = Date.prototype.getTime.call(value);
    if (!Number.isFinite(milliseconds)) throw new Error("invalid date");
    return Object.freeze({
      milliseconds,
      iso: new Date(milliseconds).toISOString(),
    });
  } catch {
    throw new RuntimeStateError(detail);
  }
}

export function snapshotLeaseWindow(
  now: Date,
  ttlMs: number,
): Readonly<{
  now: ClockSnapshot;
  expiresAt: ClockSnapshot;
}> {
  const clock = snapshotDate(now);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new RuntimeStateError("lease_ttl_is_invalid");
  }
  const expires = clock.milliseconds + ttlMs;
  if (
    !Number.isSafeInteger(expires) ||
    expires < -MAX_DATE_MILLISECONDS ||
    expires > MAX_DATE_MILLISECONDS
  ) {
    throw new RuntimeStateError("lease_expiry_is_invalid");
  }
  return Object.freeze({
    now: clock,
    expiresAt: Object.freeze({
      milliseconds: expires,
      iso: new Date(expires).toISOString(),
    }),
  });
}

export function canonicalPersistedTimestamp(
  value: unknown,
  detail: string,
): ClockSnapshot {
  const normalized = normalizePersistedTimestamp(value, detail);
  if (normalized.iso !== value) {
    throw new RuntimeStateError(detail);
  }
  return normalized;
}

export function normalizePersistedTimestamp(
  value: unknown,
  detail: string,
): ClockSnapshot {
  const parsed = InboundEventSchema.shape.receivedAt.safeParse(value);
  if (!parsed.success) throw new RuntimeStateError(detail);
  const milliseconds = Date.parse(parsed.data);
  if (!Number.isFinite(milliseconds)) {
    throw new RuntimeStateError(detail);
  }
  return Object.freeze({
    milliseconds,
    iso: new Date(milliseconds).toISOString(),
  });
}

function validToken(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    return false;
  }
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f);
  });
}

function validateLeaseIdentity(name: string, owner: string): void {
  if (!validToken(name) || !validToken(owner)) {
    throw new RuntimeStateError("runtime_lease_identity_is_invalid");
  }
}

function runtimeLease(
  database: Database.Database,
  name: string,
): RuntimeLeaseRow | undefined {
  return database
    .prepare(
      `SELECT owner, expires_at AS expiresAt, updated_at AS updatedAt
         FROM runtime_leases WHERE name = ?`,
    )
    .get(name) as RuntimeLeaseRow | undefined;
}

function validateRuntimeLease(row: RuntimeLeaseRow): ClockSnapshot {
  if (!validToken(row.owner)) {
    throw new RuntimeStateError("runtime_lease_persistence_failed");
  }
  canonicalPersistedTimestamp(
    row.updatedAt,
    "runtime_lease_persistence_failed",
  );
  return canonicalPersistedTimestamp(
    row.expiresAt,
    "runtime_lease_persistence_failed",
  );
}

export function hasLiveBridgeLease(
  database: Database.Database,
  instanceId: string,
  now: ClockSnapshot,
): boolean {
  const row = runtimeLease(database, "bridge");
  if (row === undefined) return false;
  const expiry = validateRuntimeLease(row);
  return row.owner === instanceId && expiry.milliseconds >= now.milliseconds;
}

export function acquireRuntimeLease(
  database: Database.Database,
  instanceId: string,
  name: string,
  owner: string,
  now: Date,
  ttlMs: number,
): boolean {
  validateLeaseIdentity(name, owner);
  const window = snapshotLeaseWindow(now, ttlMs);
  if (owner !== instanceId) return false;

  try {
    return database
      .transaction(() => {
        const existing = runtimeLease(database, name);
        if (existing === undefined) {
          database
            .prepare(
              "INSERT INTO runtime_leases(name, owner, expires_at, updated_at) VALUES (?, ?, ?, ?)",
            )
            .run(name, owner, window.expiresAt.iso, window.now.iso);
          return true;
        }
        const expiry = validateRuntimeLease(existing);
        if (
          existing.owner !== owner &&
          expiry.milliseconds >= window.now.milliseconds
        ) {
          return false;
        }
        const changed = database
          .prepare(
            `UPDATE runtime_leases
              SET owner = ?, expires_at = ?, updated_at = ?
            WHERE name = ? AND owner = ?`,
          )
          .run(
            owner,
            window.expiresAt.iso,
            window.now.iso,
            name,
            existing.owner,
          ).changes;
        return changed === 1;
      })
      .immediate();
  } catch (error) {
    if (error instanceof RuntimeStateError) throw error;
    throw new RuntimeStateError("runtime_lease_persistence_failed");
  }
}

export function releaseRuntimeLease(
  database: Database.Database,
  instanceId: string,
  name: string,
  owner: string,
): boolean {
  validateLeaseIdentity(name, owner);
  if (owner !== instanceId) return false;
  try {
    return database
      .transaction(() => {
        const existing = runtimeLease(database, name);
        if (existing === undefined) return false;
        validateRuntimeLease(existing);
        if (existing.owner !== owner) return false;
        return (
          database
            .prepare("DELETE FROM runtime_leases WHERE name = ? AND owner = ?")
            .run(name, owner).changes === 1
        );
      })
      .immediate();
  } catch (error) {
    if (error instanceof RuntimeStateError) throw error;
    throw new RuntimeStateError("runtime_lease_persistence_failed");
  }
}
