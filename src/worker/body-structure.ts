/**
 * Parser for an IMAP BODYSTRUCTURE response (RFC 3501 7.4.2) — a nested,
 * parenthesized S-expression describing a message's MIME layout. Defensive by
 * construction: any shape it doesn't recognize degrades to "no text part, no
 * attachments" rather than throwing, since a body-fetch failure must never
 * break the rest of the issue panel (see `plugin.ts` `getById`).
 */

import { headerText } from './mime';

type SExpr = string | null | SExpr[];

export interface BodyPart {
  /** RFC 3501 6.4.5 part numbering: "1", "1.2", "2.1.1", etc. */
  partNumber: string;
  /** Upper-cased media type, e.g. "TEXT", "APPLICATION". */
  type: string;
  /** Upper-cased media subtype, e.g. "PLAIN", "PDF". */
  subtype: string;
  charset?: string;
  /** Upper-cased transfer encoding, e.g. "QUOTED-PRINTABLE", "BASE64", "7BIT". */
  encoding: string;
  /** Declared octet size, straight off BODYSTRUCTURE — no fetch needed to know it. */
  size: number;
  filename?: string;
  /** Upper-cased Content-Disposition type, e.g. "ATTACHMENT", "INLINE". */
  dispositionType?: string;
}

// --- locate + tokenize the balanced-parenthesis BODYSTRUCTURE list -----------

const findBalancedClose = (text: string, openParenIndex: number): number | null => {
  let depth = 0;
  let inQuotes = false;
  for (let i = openParenIndex; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '\\') {
        i++; // skip the escaped character
      } else if (ch === '"') {
        inQuotes = false;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return null;
};

/** Locate and extract the parenthesized BODYSTRUCTURE list from a FETCH response line. */
export const extractBodyStructureText = (lineText: string): string | null => {
  const keyword = /\bBODYSTRUCTURE\s*/i.exec(lineText);
  if (!keyword) {
    return null;
  }
  const start = keyword.index + keyword[0].length;
  if (lineText[start] !== '(') {
    return null;
  }
  const end = findBalancedClose(lineText, start);
  return end === null ? null : lineText.slice(start, end + 1);
};

interface Cursor {
  pos: number;
}

const isBoundary = (ch: string | undefined): boolean =>
  ch === undefined || ch === ' ' || ch === '\t' || ch === '(' || ch === ')';

const skipSpace = (text: string, c: Cursor): void => {
  while (c.pos < text.length && (text[c.pos] === ' ' || text[c.pos] === '\t')) {
    c.pos++;
  }
};

const parseQuoted = (text: string, c: Cursor): string => {
  c.pos++; // opening quote
  let out = '';
  while (c.pos < text.length && text[c.pos] !== '"') {
    if (text[c.pos] === '\\' && c.pos + 1 < text.length) {
      out += text[c.pos + 1];
      c.pos += 2;
    } else {
      out += text[c.pos];
      c.pos++;
    }
  }
  c.pos++; // closing quote (or end of input — malformed input is not our problem here)
  return out;
};

const parseLiteralToken = (text: string, c: Cursor, literals: string[]): string => {
  const end = text.indexOf('', c.pos + 1);
  if (end === -1) {
    c.pos = text.length;
    return '';
  }
  const token = text.slice(c.pos, end + 1);
  const match = /^(\d+)$/.exec(token);
  c.pos = end + 1;
  return match ? (literals[Number(match[1])] ?? '') : '';
};

const parseAtom = (text: string, c: Cursor): string | null => {
  let end = c.pos;
  while (end < text.length && !isBoundary(text[end])) {
    end++;
  }
  const atom = text.slice(c.pos, end);
  c.pos = end;
  return atom.toUpperCase() === 'NIL' ? null : atom;
};

const parseValue = (text: string, c: Cursor, literals: string[]): SExpr => {
  skipSpace(text, c);
  const ch = text[c.pos];
  if (ch === '(') {
    c.pos++;
    const list: SExpr[] = [];
    for (;;) {
      skipSpace(text, c);
      if (c.pos >= text.length || text[c.pos] === ')') {
        c.pos++;
        break;
      }
      list.push(parseValue(text, c, literals));
    }
    return list;
  }
  if (ch === '"') {
    return parseQuoted(text, c);
  }
  if (ch === '') {
    return parseLiteralToken(text, c, literals);
  }
  return parseAtom(text, c);
};

const parseSExpr = (text: string, literals: string[]): SExpr => {
  const cursor: Cursor = { pos: 0 };
  return parseValue(text, cursor, literals);
};

// --- interpret the parsed S-expression as a BODYSTRUCTURE ---------------------

const asArray = (v: SExpr): SExpr[] | null => (Array.isArray(v) ? v : null);
const asString = (v: SExpr): string | null => (typeof v === 'string' ? v : null);

/** A flat `(NAME value NAME value ...)` param list, or NIL. */
const paramValue = (v: SExpr, key: string): string | undefined => {
  const list = asArray(v);
  if (!list) {
    return undefined;
  }
  for (let i = 0; i + 1 < list.length; i += 2) {
    const k = asString(list[i]);
    if (k && k.toUpperCase() === key.toUpperCase()) {
      return asString(list[i + 1]) ?? undefined;
    }
  }
  return undefined;
};

interface Disposition {
  type?: string;
  filename?: string;
}

/** `(dispositionType (paramList))`, e.g. `("ATTACHMENT" ("FILENAME" "x.pdf"))`. */
const readDisposition = (v: SExpr): Disposition | null => {
  const arr = asArray(v);
  if (!arr || arr.length === 0) {
    return null;
  }
  const type = asString(arr[0]);
  const filename = paramValue(arr[1], 'FILENAME');
  if (!type && !filename) {
    return null;
  }
  return { type: type?.toUpperCase(), filename };
};

/**
 * The trailing extension fields after `body-fields` vary by part type (TEXT
 * gets a line count first; MESSAGE/RFC822 gets envelope+bodystructure+lines
 * first) — rather than hard-coding a position, scan for the first element
 * shaped like a disposition, tolerating either layout.
 */
const findDisposition = (rest: SExpr[]): Disposition | null => {
  for (const item of rest) {
    const arr = asArray(item);
    if (arr && (arr[0] === null || typeof arr[0] === 'string')) {
      const disposition = readDisposition(item);
      if (disposition) {
        return disposition;
      }
    }
  }
  return null;
};

const interpretPart = (expr: SExpr, partNumber: string, out: BodyPart[]): void => {
  const arr = asArray(expr);
  if (!arr || arr.length === 0) {
    return;
  }

  if (Array.isArray(arr[0])) {
    // Multipart: leading array elements are child parts, followed by the
    // multipart subtype string and optional extension fields we don't need.
    const children: SExpr[] = [];
    let i = 0;
    while (i < arr.length && Array.isArray(arr[i])) {
      children.push(arr[i]);
      i++;
    }
    children.forEach((child, idx) => {
      interpretPart(child, partNumber ? `${partNumber}.${idx + 1}` : `${idx + 1}`, out);
    });
    return;
  }

  // Non-multipart: [type, subtype, params, id, description, encoding, size, ...rest]
  const type = asString(arr[0])?.toUpperCase();
  const subtype = asString(arr[1])?.toUpperCase();
  if (!type || !subtype) {
    return;
  }
  const params = arr[2];
  const encoding = asString(arr[5])?.toUpperCase() ?? '7BIT';
  const sizeRaw = asString(arr[6]);
  const size = sizeRaw ? Number(sizeRaw) : 0;

  const disposition = findDisposition(arr.slice(7));
  const rawFilename = disposition?.filename ?? paramValue(params, 'NAME');

  out.push({
    partNumber: partNumber || '1',
    type,
    subtype,
    charset: paramValue(params, 'CHARSET'),
    encoding,
    size: Number.isFinite(size) ? size : 0,
    filename: rawFilename ? headerText(rawFilename, 200) : undefined,
    dispositionType: disposition?.type,
  });
};

/** Flat, pre-order list of every leaf (non-multipart) part in the structure. */
export const parseBodyStructure = (lineText: string, literals: string[]): BodyPart[] => {
  try {
    const raw = extractBodyStructureText(lineText);
    if (!raw) {
      return [];
    }
    const expr = parseSExpr(raw, literals);
    const out: BodyPart[] = [];
    interpretPart(expr, '', out);
    return out;
  } catch {
    return [];
  }
};

/** Prefer plain text; HTML is still a valid source (stripped to text at render time). */
export const selectTextPart = (parts: BodyPart[]): BodyPart | null =>
  parts.find((p) => p.type === 'TEXT' && p.subtype === 'PLAIN') ??
  parts.find((p) => p.type === 'TEXT' && p.subtype === 'HTML') ??
  null;

/**
 * Explicit `Content-Disposition: attachment`, or any non-text part carrying a
 * filename (the older convention some clients still use instead of a
 * disposition header). Never includes the chosen text part itself.
 */
const filterAttachmentParts = (
  parts: BodyPart[],
  excludePartNumber: string | null,
  limit: number,
): BodyPart[] =>
  parts
    .filter((p) => p.partNumber !== excludePartNumber)
    .filter((p) => !!p.filename && (p.dispositionType === 'ATTACHMENT' || p.type !== 'TEXT'))
    .slice(0, limit);

/** Name/size only — for the display listing, which never fetches content. */
export const selectAttachments = (
  parts: BodyPart[],
  excludePartNumber: string | null,
  limit: number,
): { filename: string; size: number }[] =>
  filterAttachmentParts(parts, excludePartNumber, limit).map((p) => ({
    filename: p.filename as string,
    size: p.size,
  }));

/** Full parts (partNumber/encoding included) — for fetching real content. */
export const selectAttachmentParts = (
  parts: BodyPart[],
  excludePartNumber: string | null,
  limit: number,
): BodyPart[] => filterAttachmentParts(parts, excludePartNumber, limit);
