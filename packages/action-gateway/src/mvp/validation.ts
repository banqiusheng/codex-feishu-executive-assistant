const SHANGHAI_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?\+08:00$/;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;

export function isStrictShanghaiTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = SHANGHAI_TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;

  const local = new Date(timestamp + SHANGHAI_OFFSET_MS);
  const expected = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7] ?? "0"),
  ] as const;
  return (
    local.getUTCFullYear() === expected[0] &&
    local.getUTCMonth() + 1 === expected[1] &&
    local.getUTCDate() === expected[2] &&
    local.getUTCHours() === expected[3] &&
    local.getUTCMinutes() === expected[4] &&
    local.getUTCSeconds() === expected[5] &&
    local.getUTCMilliseconds() === expected[6]
  );
}
