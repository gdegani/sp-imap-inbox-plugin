import type { PollResult } from '../shared/types';

/**
 * How far the folder has been consumed. Persisted through
 * `persistDataSynced`, so it is shared (last-write-wins) across devices — that
 * is safe because it only bounds how far back a poll looks; the real dedupe key
 * is the message id, which the host matches against tasks *and* the archive.
 */
export interface WatermarkState {
  uidValidity: number;
  lastUid: number;
  updatedAt: number;
}

export const parseWatermark = (raw: string | null): WatermarkState | null => {
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const { uidValidity, lastUid, updatedAt } = parsed as Record<string, unknown>;
    if (
      !Number.isInteger(uidValidity) ||
      !Number.isInteger(lastUid) ||
      (uidValidity as number) < 0 ||
      (lastUid as number) < 0
    ) {
      return null;
    }
    return {
      uidValidity: uidValidity as number,
      lastUid: lastUid as number,
      updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
    };
  } catch {
    // Corrupt entry: treat as "no watermark". The next poll re-anchors and
    // imports nothing, which is the safe direction to fail in.
    return null;
  }
};

export const serializeWatermark = (state: WatermarkState): string =>
  JSON.stringify(state);

/**
 * Advance to the highest UID actually handed to the host — never to UIDNEXT.
 * A capped batch therefore leaves the remainder for the next poll instead of
 * skipping it.
 */
export const nextWatermark = (
  current: WatermarkState | null,
  poll: PollResult,
  now: number,
): WatermarkState => {
  if (poll.isReset) {
    return {
      uidValidity: poll.status.uidValidity,
      lastUid: Math.max(0, poll.anchorUid),
      updatedAt: now,
    };
  }
  const highest = poll.messages.reduce(
    (max, message) => Math.max(max, message.uid),
    current?.lastUid ?? poll.anchorUid,
  );
  return { uidValidity: poll.status.uidValidity, lastUid: highest, updatedAt: now };
};

/** Skip the persist round-trip when nothing moved. */
export const isWatermarkUnchanged = (
  a: WatermarkState | null,
  b: WatermarkState,
): boolean => a !== null && a.uidValidity === b.uidValidity && a.lastUid === b.lastUid;
