import { describe, expect, it } from 'vitest';
import { encodeMailboxName, quoteImapString } from './mailbox-name';

describe('encodeMailboxName', () => {
  it('leaves a plain ASCII name alone', () => {
    expect(encodeMailboxName('INBOX')).toBe('INBOX');
    expect(encodeMailboxName('INBOX/Action items')).toBe('INBOX/Action items');
  });

  it('escapes the shift character', () => {
    expect(encodeMailboxName('R&D')).toBe('R&-D');
  });

  it('base64-encodes a non-ASCII run in modified UTF-7', () => {
    expect(encodeMailboxName('Büro')).toBe('B&APw-ro');
  });

  it('encodes a run of several non-ASCII characters together', () => {
    // U+53F0 U+5317 -> base64 of 53F0 5317, with '/' remapped to ','
    expect(encodeMailboxName('台北')).toBe('&U,BTFw-');
  });

  it('handles a surrogate pair as two UTF-16 code units', () => {
    expect(encodeMailboxName('\u{1F600}')).toBe('&2D3eAA-');
  });

  it('returns an empty string unchanged', () => {
    expect(encodeMailboxName('')).toBe('');
  });
});

describe('quoteImapString', () => {
  it('wraps a plain value in quotes', () => {
    expect(quoteImapString('INBOX')).toBe('"INBOX"');
  });

  it('escapes backslashes and quotes', () => {
    expect(quoteImapString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it('refuses a value with a line break, which would be command injection', () => {
    expect(() => quoteImapString('INBOX\r\nA001 DELETE "x"')).toThrow();
    expect(() => quoteImapString('a\nb')).toThrow();
  });
});
