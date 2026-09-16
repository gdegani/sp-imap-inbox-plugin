import { describe, expect, it } from 'vitest';
import type { ImapMessage, PollResult } from '../shared/types';
import {
  isWatermarkUnchanged,
  nextWatermark,
  parseWatermark,
  serializeWatermark,
} from './watermark';

const message = (uid: number): ImapMessage => ({
  id: `id-${uid}`,
  uid,
  uidValidity: 100,
  subject: 's',
  from: 'f',
  to: 't',
  dateStr: '',
  receivedAt: 0,
});

const pollResult = (over: Partial<PollResult> = {}): PollResult => ({
  status: { uidValidity: 100, uidNext: 11, exists: 10 },
  messages: [],
  isReset: false,
  anchorUid: 0,
  ...over,
});

describe('parseWatermark', () => {
  it('round-trips through serializeWatermark', () => {
    const state = { uidValidity: 100, lastUid: 42, updatedAt: 1234 };
    expect(parseWatermark(serializeWatermark(state))).toEqual(state);
  });

  it('treats a missing entry as no watermark', () => {
    expect(parseWatermark(null)).toBeNull();
    expect(parseWatermark('')).toBeNull();
  });

  it('treats corrupt or wrongly-shaped data as no watermark', () => {
    expect(parseWatermark('not json')).toBeNull();
    expect(parseWatermark('{"uidValidity":"x","lastUid":1}')).toBeNull();
    expect(parseWatermark('{"uidValidity":1}')).toBeNull();
    expect(parseWatermark('{"uidValidity":1,"lastUid":-5}')).toBeNull();
    expect(parseWatermark('[]')).toBeNull();
    expect(parseWatermark('null')).toBeNull();
  });

  it('defaults a missing updatedAt', () => {
    expect(parseWatermark('{"uidValidity":1,"lastUid":2}')?.updatedAt).toBe(0);
  });
});

describe('nextWatermark', () => {
  it('anchors on the first run and imports nothing', () => {
    const poll = pollResult({ isReset: true, anchorUid: 77 });
    expect(nextWatermark(null, poll, 5)).toEqual({
      uidValidity: 100,
      lastUid: 77,
      updatedAt: 5,
    });
    expect(poll.messages).toHaveLength(0);
  });

  it('re-anchors when UIDVALIDITY changed, discarding the old UID', () => {
    const previous = { uidValidity: 99, lastUid: 5000, updatedAt: 0 };
    const poll = pollResult({ isReset: true, anchorUid: 3 });
    expect(nextWatermark(previous, poll, 5)).toEqual({
      uidValidity: 100,
      lastUid: 3,
      updatedAt: 5,
    });
  });

  it('advances to the highest UID actually handed over', () => {
    const previous = { uidValidity: 100, lastUid: 5, updatedAt: 0 };
    const poll = pollResult({ messages: [message(6), message(9)], anchorUid: 5 });
    expect(nextWatermark(previous, poll, 7).lastUid).toBe(9);
  });

  it('does not jump to UIDNEXT when a batch was capped', () => {
    const previous = { uidValidity: 100, lastUid: 5, updatedAt: 0 };
    // Server has UIDs up to 10 (uidNext 11) but only 6 and 7 were fetched.
    const poll = pollResult({ messages: [message(6), message(7)], anchorUid: 5 });
    expect(nextWatermark(previous, poll, 7).lastUid).toBe(7);
  });

  it('stays put when the poll found nothing', () => {
    const previous = { uidValidity: 100, lastUid: 5, updatedAt: 0 };
    expect(nextWatermark(previous, pollResult({ anchorUid: 5 }), 7).lastUid).toBe(5);
  });

  it('never moves backwards', () => {
    const previous = { uidValidity: 100, lastUid: 20, updatedAt: 0 };
    const poll = pollResult({ messages: [message(6)], anchorUid: 20 });
    expect(nextWatermark(previous, poll, 7).lastUid).toBe(20);
  });
});

describe('isWatermarkUnchanged', () => {
  const state = { uidValidity: 100, lastUid: 42, updatedAt: 1 };

  it('ignores updatedAt', () => {
    expect(isWatermarkUnchanged(state, { ...state, updatedAt: 999 })).toBe(true);
  });

  it('detects a moved UID or a new mailbox instance', () => {
    expect(isWatermarkUnchanged(state, { ...state, lastUid: 43 })).toBe(false);
    expect(isWatermarkUnchanged(state, { ...state, uidValidity: 101 })).toBe(false);
  });

  it('counts "no previous watermark" as changed so the anchor is persisted', () => {
    expect(isWatermarkUnchanged(null, state)).toBe(false);
  });
});
