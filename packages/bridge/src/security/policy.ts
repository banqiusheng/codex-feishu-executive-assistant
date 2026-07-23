import { createHash, timingSafeEqual } from "node:crypto";

export type Sha256Digest = `sha256:${string}`;

export const MAX_PAIRING_CODE_LENGTH = 256;
export const EMPTY_SHA256_DIGEST =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" as const;

export type AccessPolicy = Readonly<{
  appId: string;
  tenantKey: string;
  presidentOpenId: string | null;
  presidentChatId: string | null;
  pairing: Readonly<{
    active: boolean;
    codeHash: Sha256Digest | string | null;
  }>;
}>;

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function isExactIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value === value.trim()
  );
}

export function isCanonicalSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && SHA256_DIGEST_PATTERN.test(value);
}

export function hashPairingCode(value: string): Sha256Digest {
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  return `sha256:${digest}`;
}

export function isExactPairingCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PAIRING_CODE_LENGTH &&
    value === value.trim()
  );
}

export function matchesPairingCode(
  value: unknown,
  expectedHash: unknown,
): boolean {
  if (!isExactPairingCode(value) || !isCanonicalSha256Digest(expectedHash)) {
    return false;
  }

  const actual = Buffer.from(
    hashPairingCode(value).slice("sha256:".length),
    "hex",
  );
  const expected = Buffer.from(expectedHash.slice("sha256:".length), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function isAccessPolicyValid(policy: AccessPolicy): boolean {
  if (
    !isExactIdentifier(policy.appId) ||
    !isExactIdentifier(policy.tenantKey)
  ) {
    return false;
  }

  const hasPresidentOpenId = isExactIdentifier(policy.presidentOpenId);
  const hasPresidentChatId = isExactIdentifier(policy.presidentChatId);
  const isUnpaired =
    policy.presidentOpenId === null && policy.presidentChatId === null;

  if (!isUnpaired && !(hasPresidentOpenId && hasPresidentChatId)) {
    return false;
  }
  if (typeof policy.pairing?.active !== "boolean") return false;

  if (policy.pairing.active) {
    return (
      isUnpaired &&
      isCanonicalSha256Digest(policy.pairing.codeHash) &&
      policy.pairing.codeHash !== EMPTY_SHA256_DIGEST
    );
  }

  return policy.pairing.codeHash === null;
}
