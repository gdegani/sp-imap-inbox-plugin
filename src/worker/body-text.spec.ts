import { describe, expect, it } from 'vitest';
import { decodeBodyPart, renderBodyText, stripHtml } from './body-text';

describe('decodeBodyPart', () => {
  it('decodes quoted-printable with soft line breaks', () => {
    expect(decodeBodyPart('caf=C3=A9=\r\n au lait', 'QUOTED-PRINTABLE', 'utf-8')).toBe(
      'café au lait',
    );
  });

  it('decodes base64', () => {
    const encoded = Buffer.from('hello world', 'utf8').toString('base64');
    expect(decodeBodyPart(encoded, 'BASE64', 'utf-8')).toBe('hello world');
  });

  it('passes 7BIT/8BIT text through as-is', () => {
    expect(decodeBodyPart('plain ascii text', '7BIT', 'utf-8')).toBe('plain ascii text');
  });

  it('falls back to windows-1252 for a charset the platform cannot decode', () => {
    expect(() => decodeBodyPart('abc', 'BASE64', 'x-made-up-charset')).not.toThrow();
  });
});

describe('stripHtml', () => {
  it('removes tags and decodes entities', () => {
    expect(stripHtml('<p>Hi &amp; welcome, <b>friend</b>!</p>')).toBe('Hi & welcome, friend!');
  });

  it('drops script and style blocks entirely', () => {
    expect(
      stripHtml('<style>.x{color:red}</style><p>hi</p><script>alert(1)</script>'),
    ).toBe('hi');
  });

  it('turns block boundaries into line breaks', () => {
    expect(stripHtml('<p>one</p><p>two</p>')).toBe('one\ntwo');
  });

  it('never leaves the content looking like it was interpreted as markdown', () => {
    // A stray "*"/"_" from the mail body should pass through untouched, not
    // be reinterpreted — this is plain text, not markdown, by design.
    expect(stripHtml('<p>*not bold* _not italic_</p>')).toBe('*not bold* _not italic_');
  });
});

describe('renderBodyText', () => {
  it('strips HTML to plain text end-to-end', () => {
    const html = '<p>Hello <b>world</b> &amp; friends</p>';
    const result = renderBodyText(html, '7BIT', 'utf-8', true);
    expect(result).toEqual({ text: 'Hello world & friends', truncated: false });
  });

  it('leaves plain text alone (still decoding transfer-encoding)', () => {
    const result = renderBodyText('plain body text', '7BIT', 'utf-8', false);
    expect(result).toEqual({ text: 'plain body text', truncated: false });
  });

  it('truncates long text and reports it', () => {
    const long = 'x'.repeat(20);
    const result = renderBodyText(long, '7BIT', 'utf-8', false, 10);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(10);
    expect(result.text.endsWith('…')).toBe(true);
  });
});
