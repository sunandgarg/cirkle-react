/**
 * Returns unique, non-empty string identifiers while preserving their first
 * occurrence order. Anonymous and tombstoned content intentionally carries a
 * null author identifier and must never be sent to a profile IN query.
 */
export const uniqueIdentifiers = (values: readonly unknown[]): string[] => [
  ...new Set(values.flatMap((value) => {
    if (typeof value !== "string") return [];
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  })),
];
