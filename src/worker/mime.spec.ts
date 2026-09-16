import { describe, expect, it } from 'vitest';
import {
  decodeEncodedWords,
  firstHeader,
  headerText,
  normalizeMessageId,
  parseHeaderBlock,
} from './mime';

describe('decodeEncodedWords', () => {
  it('decodes a base64 encoded word', () => {
    expect(decodeEncodedWords('=?utf-8?B?SGVsbG8gd29ybGQ=?=')).toBe('Hello world');
  });

  it('decodes a quoted-printable encoded word, with _ as space', () => {
    expect(decodeEncodedWords('=?utf-8?Q?caf=C3=A9_time?=')).toBe('café time');
  });

  it('honours the charset of each word independently', () => {
    expect(decodeEncodedWords('=?iso-8859-1?Q?caf=E9?= / =?utf-8?Q?caf=C3=A9?=')).toBe(
      'café / café',
    );
  });

  it('drops whitespace between two adjacent encoded words (RFC 2047 6.2)', () => {
    expect(decodeEncodedWords('=?utf-8?B?SGVs?= =?utf-8?B?bG8=?=')).toBe('Hello');
  });

  it('keeps whitespace between an encoded word and plain text', () => {
    expect(decodeEncodedWords('Re: =?utf-8?Q?caf=C3=A9?= today')).toBe('Re: café today');
  });

  it('leaves text with no encoded words untouched', () => {
    expect(decodeEncodedWords('Plain old subject')).toBe('Plain old subject');
  });

  it('leaves a malformed encoded word verbatim rather than mangling it', () => {
    expect(decodeEncodedWords('=?utf-8?X?abc?=')).toBe('=?utf-8?X?abc?=');
  });

  it('falls back to windows-1252 for an unknown charset label', () => {
    expect(decodeEncodedWords('=?not-a-charset?Q?caf=E9?=')).toBe('café');
  });

  it('strips an RFC 2231 language suffix off the charset', () => {
    expect(decodeEncodedWords('=?utf-8*en?Q?hello?=')).toBe('hello');
  });
});

describe('parseHeaderBlock', () => {
  it('unfolds continuation lines', () => {
    const headers = parseHeaderBlock(
      'Subject: a very long\r\n subject line\r\nFrom: me@example.com\r\n',
    );
    expect(firstHeader(headers, 'subject')).toBe('a very long subject line');
    expect(firstHeader(headers, 'from')).toBe('me@example.com');
  });

  it('lower-cases header names', () => {
    const headers = parseHeaderBlock('MESSAGE-ID: <abc@example.com>\r\n');
    expect(firstHeader(headers, 'Message-ID')).toBe('<abc@example.com>');
  });

  it('keeps every occurrence of a repeated header', () => {
    const headers = parseHeaderBlock('Received: one\r\nReceived: two\r\n');
    expect(headers.get('received')).toEqual(['one', 'two']);
  });

  it('returns an empty string for a header that is not there', () => {
    expect(firstHeader(parseHeaderBlock(''), 'subject')).toBe('');
  });

  it('ignores a line with no colon', () => {
    const headers = parseHeaderBlock('not a header\r\nSubject: real\r\n');
    expect(firstHeader(headers, 'subject')).toBe('real');
  });
});

describe('headerText', () => {
  it('decodes, collapses whitespace and trims', () => {
    expect(headerText('  =?utf-8?B?SGVsbG8=?=   world  ')).toBe('Hello world');
  });

  it('strips control characters that could break out of a task title', () => {
    expect(headerText('one\u0000two\u001bthree')).toBe('onetwothree');
  });

  it('caps the length with an ellipsis', () => {
    expect(headerText('x'.repeat(50), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('normalizeMessageId', () => {
  it('strips angle brackets', () => {
    expect(normalizeMessageId('<abc.123@example.com>')).toBe('abc.123@example.com');
  });

  it('tolerates surrounding whitespace', () => {
    expect(normalizeMessageId('  <abc@example.com>  ')).toBe('abc@example.com');
  });

  it('accepts a bare id with no brackets', () => {
    expect(normalizeMessageId('abc@example.com')).toBe('abc@example.com');
  });

  it('rejects an empty or whitespace-bearing value', () => {
    expect(normalizeMessageId('')).toBeNull();
    expect(normalizeMessageId('<a b@example.com>')).toBeNull();
  });

  it('rejects an absurdly long value', () => {
    expect(normalizeMessageId(`<${'a'.repeat(600)}>`)).toBeNull();
  });
});
