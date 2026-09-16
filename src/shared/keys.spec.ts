import { describe, expect, it } from 'vitest';
import { accountLabel, secretKeyFor, watermarkKeyFor } from './keys';

const account = { host: 'IMAP.Example.COM', port: 993, username: ' me@example.com ' };

describe('secretKeyFor', () => {
  it('normalizes the host and trims the username so config edits keep the key', () => {
    expect(secretKeyFor(account)).toBe('imap-pw:imap.example.com:993:me@example.com');
  });

  it('separates accounts on the same host by port and user', () => {
    const a = secretKeyFor({ host: 'h', port: 993, username: 'one' });
    const b = secretKeyFor({ host: 'h', port: 143, username: 'one' });
    const c = secretKeyFor({ host: 'h', port: 993, username: 'two' });
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('watermarkKeyFor', () => {
  it('is per folder', () => {
    expect(watermarkKeyFor(account, 'INBOX')).not.toBe(watermarkKeyFor(account, 'Todo'));
  });

  it('stays inside the host key-length limit', () => {
    const key = watermarkKeyFor(
      { host: 'h'.repeat(300), port: 993, username: 'u'.repeat(300) },
      'f'.repeat(300),
    );
    expect(key.length).toBeLessThanOrEqual(256);
  });

  it('keeps truncated keys distinct', () => {
    const long = 'x'.repeat(300);
    const a = watermarkKeyFor({ host: long, port: 993, username: 'a' }, 'INBOX');
    const b = watermarkKeyFor({ host: long, port: 993, username: 'b' }, 'INBOX');
    expect(a).not.toBe(b);
  });
});

describe('accountLabel', () => {
  it('reads as user @ host', () => {
    expect(accountLabel(account)).toBe('me@example.com @ imap.example.com');
  });
});
