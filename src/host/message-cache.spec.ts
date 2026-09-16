import { describe, expect, it } from 'vitest';
import type { ImapMessage } from '../shared/types';
import { MessageCache } from './message-cache';

const message = (id: string, uid = 1, uidValidity = 100): ImapMessage => ({
  id,
  uid,
  uidValidity,
  subject: `subject ${id}`,
  from: 'sender@example.com',
  to: '',
  dateStr: '',
  receivedAt: 0,
});

describe('MessageCache', () => {
  it('returns what was put in', () => {
    const cache = new MessageCache(1000, 10);
    cache.put([message('a')], 'src');
    expect(cache.get('a')?.subject).toBe('subject a');
    expect(cache.get('missing')).toBeNull();
  });

  it('expires entries once the TTL passes', () => {
    let now = 0;
    const cache = new MessageCache(100, 10, () => now);
    cache.put([message('a')], 'src');
    now = 99;
    expect(cache.get('a')).not.toBeNull();
    now = 100;
    expect(cache.get('a')).toBeNull();
  });

  it('keeps locating a UID after the TTL, because UIDs outlive the cache window', () => {
    let now = 0;
    const cache = new MessageCache(100, 10, () => now);
    cache.put([message('a', 7, 4711)], 'imap.example.com:993:me:INBOX');
    now = 10_000;
    expect(cache.get('a')).toBeNull();
    expect(cache.locate('a')).toEqual({
      uid: 7,
      uidValidity: 4711,
      source: 'imap.example.com:993:me:INBOX',
    });
  });

  it('remembers which account a message came from', () => {
    const cache = new MessageCache(1000, 10);
    cache.put([message('a')], 'account-one');
    cache.put([message('b')], 'account-two');
    expect(cache.locate('a')?.source).toBe('account-one');
    expect(cache.locate('b')?.source).toBe('account-two');
  });

  it('evicts the oldest entries past the cap', () => {
    const cache = new MessageCache(1000, 2);
    cache.put([message('a')], 'src');
    cache.put([message('b')], 'src');
    cache.put([message('c')], 'src');
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeNull();
    expect(cache.get('c')).not.toBeNull();
  });

  it('refreshes recency when a message is seen again', () => {
    const cache = new MessageCache(1000, 2);
    cache.put([message('a')], 'src');
    cache.put([message('b')], 'src');
    cache.put([message('a')], 'src');
    cache.put([message('c')], 'src');
    expect(cache.get('a')).not.toBeNull();
    expect(cache.get('b')).toBeNull();
  });

  it('clears everything on unload', () => {
    const cache = new MessageCache(1000, 10);
    cache.put([message('a')], 'src');
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.locate('a')).toBeNull();
  });
});
