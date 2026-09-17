import { describe, expect, it } from 'vitest';
import { literalToken } from './imap-parse';
import {
  parseBodyStructure,
  selectAttachmentParts,
  selectAttachments,
  selectTextPart,
} from './body-structure';

const fetchLine = (bodystructure: string): string =>
  `* 1 FETCH (UID 5 BODYSTRUCTURE ${bodystructure})`;

describe('parseBodyStructure', () => {
  it('reads a simple non-multipart text/plain message as part "1"', () => {
    const parts = parseBodyStructure(
      fetchLine(
        '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 1234 45)',
      ),
      [],
    );
    expect(parts).toEqual([
      {
        partNumber: '1',
        type: 'TEXT',
        subtype: 'PLAIN',
        charset: 'UTF-8',
        encoding: 'QUOTED-PRINTABLE',
        size: 1234,
        filename: undefined,
        dispositionType: undefined,
      },
    ]);
  });

  it('numbers multipart/alternative children 1 and 2', () => {
    const parts = parseBodyStructure(
      fetchLine(
        '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 100 5)' +
          '("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 500 20) "ALTERNATIVE")',
      ),
      [],
    );
    expect(parts.map((p) => [p.partNumber, p.subtype])).toEqual([
      ['1', 'PLAIN'],
      ['2', 'HTML'],
    ]);
  });

  it('numbers a nested multipart/alternative inside multipart/mixed with dotted parts', () => {
    const parts = parseBodyStructure(
      fetchLine(
        '((("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 50 3)' +
          '("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 80 4) "ALTERNATIVE")' +
          '("APPLICATION" "PDF" ("NAME" "x.pdf") NIL NIL "BASE64" 900 NIL ' +
          '("ATTACHMENT" ("FILENAME" "x.pdf")) NIL) "MIXED")',
      ),
      [],
    );
    expect(parts.map((p) => p.partNumber)).toEqual(['1.1', '1.2', '2']);
    expect(parts[2]).toMatchObject({
      type: 'APPLICATION',
      subtype: 'PDF',
      filename: 'x.pdf',
      dispositionType: 'ATTACHMENT',
      size: 900,
    });
  });

  it('reads a filename from a literal token', () => {
    const parts = parseBodyStructure(
      fetchLine(
        `("APPLICATION" "PDF" ("NAME" ${literalToken(0)}) NIL NIL "BASE64" 900 NIL NIL NIL)`,
      ),
      ['a long report name.pdf'],
    );
    expect(parts[0].filename).toBe('a long report name.pdf');
  });

  it('falls back to the content-type NAME param when there is no disposition', () => {
    const parts = parseBodyStructure(
      fetchLine('("IMAGE" "PNG" ("NAME" "photo.png") NIL NIL "BASE64" 20000 NIL NIL NIL)'),
      [],
    );
    expect(parts[0]).toMatchObject({ filename: 'photo.png', dispositionType: undefined });
  });

  it('returns nothing for a line without BODYSTRUCTURE', () => {
    expect(parseBodyStructure('* 1 FETCH (UID 5 FLAGS (\\Seen))', [])).toEqual([]);
  });

  it('degrades to an empty list instead of throwing on malformed input', () => {
    expect(() => parseBodyStructure(fetchLine('(("TEXT" "PLAIN"'), [])).not.toThrow();
    expect(parseBodyStructure(fetchLine('(("TEXT" "PLAIN"'), [])).toEqual([]);
  });
});

describe('selectTextPart', () => {
  it('prefers text/plain over text/html', () => {
    const parts = parseBodyStructure(
      fetchLine(
        '(("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 500 20)' +
          '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 100 5) "ALTERNATIVE")',
      ),
      [],
    );
    expect(selectTextPart(parts)?.subtype).toBe('PLAIN');
  });

  it('falls back to text/html when there is no plain part', () => {
    const parts = parseBodyStructure(
      fetchLine('("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 300 10)'),
      [],
    );
    expect(selectTextPart(parts)?.subtype).toBe('HTML');
  });

  it('is null when there is no text part at all', () => {
    const parts = parseBodyStructure(
      fetchLine('("IMAGE" "PNG" ("NAME" "photo.png") NIL NIL "BASE64" 20000 NIL NIL NIL)'),
      [],
    );
    expect(selectTextPart(parts)).toBeNull();
  });
});

describe('selectAttachments', () => {
  it('excludes the chosen text part and lists the rest', () => {
    const parts = parseBodyStructure(
      fetchLine(
        '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 100 5)' +
          '("APPLICATION" "PDF" ("NAME" "invoice.pdf") NIL NIL "BASE64" 45000 NIL ' +
          '("ATTACHMENT" ("FILENAME" "invoice.pdf")) NIL) "MIXED")',
      ),
      [],
    );
    const textPart = selectTextPart(parts);
    expect(selectAttachments(parts, textPart?.partNumber ?? null, 20)).toEqual([
      { filename: 'invoice.pdf', size: 45000 },
    ]);
  });

  it('caps the list at the given limit', () => {
    const many = Array.from(
      { length: 5 },
      (_, i) =>
        `("APPLICATION" "PDF" ("NAME" "f${i}.pdf") NIL NIL "BASE64" 100 NIL ("ATTACHMENT" ("FILENAME" "f${i}.pdf")) NIL)`,
    ).join('');
    const parts = parseBodyStructure(fetchLine(`(${many} "MIXED")`), []);
    expect(selectAttachments(parts, null, 3)).toHaveLength(3);
  });
});

describe('selectAttachmentParts', () => {
  it('returns the full BodyPart (partNumber/encoding included), unlike selectAttachments', () => {
    const parts = parseBodyStructure(
      fetchLine(
        '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 100 5)' +
          '("APPLICATION" "PDF" ("NAME" "invoice.pdf") NIL NIL "BASE64" 45000 NIL ' +
          '("ATTACHMENT" ("FILENAME" "invoice.pdf")) NIL) "MIXED")',
      ),
      [],
    );
    const textPart = selectTextPart(parts);
    const attachmentParts = selectAttachmentParts(parts, textPart?.partNumber ?? null, 20);
    expect(attachmentParts).toEqual([
      {
        partNumber: '2',
        type: 'APPLICATION',
        subtype: 'PDF',
        charset: undefined,
        encoding: 'BASE64',
        size: 45000,
        filename: 'invoice.pdf',
        dispositionType: 'ATTACHMENT',
      },
    ]);
  });
});
