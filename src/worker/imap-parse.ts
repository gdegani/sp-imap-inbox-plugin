/**
 * Pure parsing of IMAP responses. Everything here works on an already-assembled
 * logical line, so it is fully testable without a socket.
 */

/**
 * One IMAP response line with its literals lifted out.
 *
 * A literal (`{123}` + CRLF + bytes) can contain CRLF, so it cannot stay inline
 * in `text` without breaking line-based parsing. The reader replaces each one
 * with {@link literalToken} and pushes the bytes onto `literals` in order.
 */
export interface ImapLine {
  text: string;
  literals: string[];
}

/** U+0001 never survives {@link headerText}, so it cannot be spoofed by content. */
export const literalToken = (index: number): string => `\u0001${index}\u0001`;

const LITERAL_TOKEN_RE = /\u0001(\d+)\u0001/;

export type ImapStatus = 'OK' | 'NO' | 'BAD';

export interface TaggedResult {
  status: ImapStatus;
  text: string;
}

/** Match `<tag> OK ...` and pull the completion status off it. */
export const parseTagged = (text: string, tag: string): TaggedResult | null => {
  const match = new RegExp(`^${tag} (OK|NO|BAD)\\b ?(.*)$`, 'i').exec(text);
  if (!match) {
    return null;
  }
  return { status: match[1].toUpperCase() as ImapStatus, text: match[2] ?? '' };
};

/** `[UIDVALIDITY 4711]` / `[UIDNEXT 12]` out of any untagged or tagged line. */
export const parseResponseCodeNumber = (text: string, code: string): number | null => {
  const match = new RegExp(`\\[${code} (\\d+)\\]`, 'i').exec(text);
  return match ? Number(match[1]) : null;
};

/** `* 12 EXISTS` */
export const parseUntaggedCount = (text: string, keyword: string): number | null => {
  const match = new RegExp(`^\\* (\\d+) ${keyword}\\b`, 'i').exec(text);
  return match ? Number(match[1]) : null;
};

export const parseCapabilities = (text: string): string[] => {
  const match = /(?:^\* CAPABILITY |\[CAPABILITY )(.+?)(?:\]|$)/i.exec(text);
  if (!match) {
    return [];
  }
  return match[1]
    .trim()
    .split(/\s+/)
    .map((c) => c.toUpperCase())
    .filter(Boolean);
};

/** `* SEARCH 1 2 3` (and the empty `* SEARCH` form). */
export const parseSearchUids = (text: string): number[] => {
  const match = /^\* SEARCH\b(.*)$/i.exec(text);
  if (!match) {
    return [];
  }
  return match[1]
    .trim()
    .split(/\s+/)
    .filter((token) => /^\d+$/.test(token))
    .map(Number);
};

export interface FetchRecord {
  uid: number;
  internalDate: string;
  header: string;
}

const BODY_SECTION = /BODY\[[^\]]*\](?:<\d+>)?\s+(\u0001\d+\u0001|"(?:[^"\\]|\\.)*")/;

/**
 * Pull the fields we ask for out of a `* n FETCH (...)` response. Servers are
 * free to reorder items and to add unsolicited ones (FLAGS after a STORE, say),
 * so each field is matched independently rather than positionally.
 */
export const parseFetchRecord = (line: ImapLine): FetchRecord | null => {
  if (!/^\* \d+ FETCH /i.test(line.text)) {
    return null;
  }
  const uidMatch = /\bUID (\d+)/i.exec(line.text);
  if (!uidMatch) {
    return null;
  }
  const bodyMatch = BODY_SECTION.exec(line.text);
  if (!bodyMatch) {
    return null;
  }

  let header: string;
  const tokenMatch = LITERAL_TOKEN_RE.exec(bodyMatch[1]);
  if (tokenMatch) {
    header = line.literals[Number(tokenMatch[1])] ?? '';
  } else {
    header = bodyMatch[1].slice(1, -1).replace(/\\(.)/g, '$1');
  }

  const dateMatch = /\bINTERNALDATE "([^"]*)"/i.exec(line.text);
  return {
    uid: Number(uidMatch[1]),
    internalDate: dateMatch ? dateMatch[1] : '',
    header,
  };
};

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

/** `17-Jul-1996 02:44:25 -0700` to epoch ms; null when unparseable. */
export const parseInternalDateMs = (value: string): number | null => {
  const match =
    /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-])(\d{2})(\d{2})\s*$/.exec(
      value,
    );
  if (!match) {
    return null;
  }
  const month = MONTHS.indexOf(match[2].toLowerCase());
  if (month < 0) {
    return null;
  }
  const utc = Date.UTC(
    Number(match[3]),
    month,
    Number(match[1]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  const offsetMin =
    (Number(match[8]) * 60 + Number(match[9])) * (match[7] === '-' ? -1 : 1);
  return utc - offsetMin * 60_000;
};

/**
 * Collapse a UID list into the shortest sequence-set form (`1:5,8,11:12`), so a
 * batch of 50 UIDs stays one short command instead of a 400-char line.
 */
export const buildUidSet = (uids: number[]): string => {
  const sorted = [...new Set(uids)]
    .filter((u) => Number.isInteger(u) && u > 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) {
    throw new Error('Cannot build a UID set from an empty list');
  }
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const current = sorted[i];
    if (current === prev + 1) {
      prev = current;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}:${prev}`);
    start = current;
    prev = current;
  }
  return parts.join(',');
};
