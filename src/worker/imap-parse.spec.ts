import { describe, expect, it } from 'vitest';
import {
  buildUidSet,
  ImapLine,
  literalToken,
  parseCapabilities,
  parseFetchRecord,
  parseInternalDateMs,
  parseResponseCodeNumber,
  parseSearchUids,
  parseTagged,
  parseUntaggedCount,
} from './imap-parse';

const line = (text: string, literals: string[] = []): ImapLine => ({ text, literals });

describe('parseTagged', () => {
  it('reads the completion status', () => {
    expect(parseTagged('A0001 OK LOGIN completed', 'A0001')).toEqual({
      status: 'OK',
      text: 'LOGIN completed',
    });
  });

  it('reads NO and BAD', () => {
    expect(parseTagged('A0002 NO [AUTHENTICATIONFAILED] nope', 'A0002')?.status).toBe(
      'NO',
    );
    expect(parseTagged('A0003 BAD syntax', 'A0003')?.status).toBe('BAD');
  });

  it('ignores a line belonging to another tag', () => {
    expect(parseTagged('A0002 OK done', 'A0001')).toBeNull();
  });

  it('ignores an untagged line', () => {
    expect(parseTagged('* OK still going', 'A0001')).toBeNull();
  });
});

describe('response codes and counts', () => {
  it('extracts UIDVALIDITY and UIDNEXT', () => {
    const text = '* OK [UIDVALIDITY 4711] UIDs valid';
    expect(parseResponseCodeNumber(text, 'UIDVALIDITY')).toBe(4711);
    expect(parseResponseCodeNumber('* OK [UIDNEXT 12]', 'UIDNEXT')).toBe(12);
  });

  it('returns null when the code is absent', () => {
    expect(parseResponseCodeNumber('* OK nothing here', 'UIDNEXT')).toBeNull();
  });

  it('reads an EXISTS count', () => {
    expect(parseUntaggedCount('* 12 EXISTS', 'EXISTS')).toBe(12);
    expect(parseUntaggedCount('* 12 RECENT', 'EXISTS')).toBeNull();
  });
});

describe('parseCapabilities', () => {
  it('reads an untagged capability line', () => {
    expect(parseCapabilities('* CAPABILITY IMAP4rev1 STARTTLS auth=plain')).toEqual([
      'IMAP4REV1',
      'STARTTLS',
      'AUTH=PLAIN',
    ]);
  });

  it('reads capabilities out of a response code', () => {
    expect(parseCapabilities('* OK [CAPABILITY IMAP4rev1 SASL-IR] ready')).toEqual([
      'IMAP4REV1',
      'SASL-IR',
    ]);
  });

  it('returns nothing for an unrelated line', () => {
    expect(parseCapabilities('* OK ready')).toEqual([]);
  });
});

describe('parseSearchUids', () => {
  it('reads a list of UIDs', () => {
    expect(parseSearchUids('* SEARCH 1 2 42')).toEqual([1, 2, 42]);
  });

  it('handles the empty result form', () => {
    expect(parseSearchUids('* SEARCH')).toEqual([]);
  });

  it('ignores a non-SEARCH line', () => {
    expect(parseSearchUids('* 1 EXISTS')).toEqual([]);
  });
});

describe('parseFetchRecord', () => {
  const header = 'Subject: hi\r\nMessage-ID: <a@b>\r\n';

  it('reads uid, internaldate and a literal header block', () => {
    const record = parseFetchRecord(
      line(
        `* 1 FETCH (UID 7 INTERNALDATE "17-Jul-1996 02:44:25 -0700" BODY[HEADER.FIELDS (MESSAGE-ID SUBJECT)] ${literalToken(0)})`,
        [header],
      ),
    );
    expect(record).toEqual({
      uid: 7,
      internalDate: '17-Jul-1996 02:44:25 -0700',
      header,
    });
  });

  it('accepts the quoted-string form of a header block', () => {
    const record = parseFetchRecord(
      line('* 1 FETCH (UID 7 BODY[HEADER.FIELDS (SUBJECT)] "Subject: hi")'),
    );
    expect(record?.header).toBe('Subject: hi');
  });

  it('tolerates reordered and unsolicited items', () => {
    const record = parseFetchRecord(
      line(
        `* 3 FETCH (FLAGS (\\Seen) BODY[HEADER.FIELDS (SUBJECT)] ${literalToken(0)} UID 9)`,
        [header],
      ),
    );
    expect(record?.uid).toBe(9);
    expect(record?.header).toBe(header);
  });

  it('returns null without a UID', () => {
    expect(
      parseFetchRecord(
        line(`* 1 FETCH (BODY[HEADER.FIELDS (SUBJECT)] ${literalToken(0)})`, [header]),
      ),
    ).toBeNull();
  });

  it('returns null for a line that is not a FETCH response', () => {
    expect(parseFetchRecord(line('* 1 EXISTS'))).toBeNull();
  });

  it('returns an empty header when the literal is missing', () => {
    const record = parseFetchRecord(
      line(`* 1 FETCH (UID 7 BODY[HEADER.FIELDS (SUBJECT)] ${literalToken(3)})`, [
        header,
      ]),
    );
    expect(record?.header).toBe('');
  });
});

describe('parseInternalDateMs', () => {
  it('parses a western-negative offset', () => {
    expect(parseInternalDateMs('17-Jul-1996 02:44:25 -0700')).toBe(
      Date.UTC(1996, 6, 17, 9, 44, 25),
    );
  });

  it('parses a positive offset', () => {
    expect(parseInternalDateMs(' 1-Jan-2026 10:00:00 +0100')).toBe(
      Date.UTC(2026, 0, 1, 9, 0, 0),
    );
  });

  it('returns null for junk', () => {
    expect(parseInternalDateMs('yesterday')).toBeNull();
    expect(parseInternalDateMs('17-Xxx-1996 02:44:25 -0700')).toBeNull();
  });
});

describe('buildUidSet', () => {
  it('collapses consecutive UIDs into ranges', () => {
    expect(buildUidSet([1, 2, 3, 5, 8, 9])).toBe('1:3,5,8:9');
  });

  it('sorts and de-duplicates', () => {
    expect(buildUidSet([9, 1, 9, 2])).toBe('1:2,9');
  });

  it('handles a single UID', () => {
    expect(buildUidSet([42])).toBe('42');
  });

  it('refuses an empty list rather than sending a meaningless command', () => {
    expect(() => buildUidSet([])).toThrow();
    expect(() => buildUidSet([0, -1])).toThrow();
  });
});
