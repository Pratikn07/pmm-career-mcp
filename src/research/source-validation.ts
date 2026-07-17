export const SOURCE_FUTURE_SKEW_MS = 5 * 60 * 1_000;
export const SOURCE_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1_000;

export class SourceTimestampError extends Error {
  readonly code = "invalid-data" as const;

  constructor(message: string) {
    super(message);
    this.name = "SourceTimestampError";
  }
}

export function validateSourceTimestamp(
  value: string,
  now: Date,
  label: string
): { checkedAt: string; stale: boolean } {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new SourceTimestampError(`${label} checkedAt must be an ISO timestamp`);
  }
  if (parsed.getTime() - now.getTime() > SOURCE_FUTURE_SKEW_MS) {
    throw new SourceTimestampError(`${label} checkedAt exceeds the 5-minute future-skew allowance`);
  }
  return {
    checkedAt: value,
    stale: now.getTime() - parsed.getTime() > SOURCE_STALE_AFTER_MS
  };
}
