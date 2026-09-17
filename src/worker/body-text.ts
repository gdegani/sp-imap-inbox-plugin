/**
 * Turns a fetched body part's raw wire content into display-ready plain text.
 * HTML is always stripped to text, never rendered — see README "Scope": no
 * remote image / tracking-pixel risk, no dependency on how the host's issue
 * panel would otherwise handle arbitrary third-party HTML.
 */

import { decodeBytes } from './mime';

/**
 * Backstop only — the real limit is `MAX_BODY_FETCH_BYTES` in `worker/index.ts`,
 * checked before the fetch even happens. This just bounds the rare case where
 * decoding/entity-expansion measurably grows a part that was already under
 * that byte cap.
 */
const MAX_BODY_TEXT_CHARS = 200_000;

const decodeQuotedPrintable = (raw: string): Uint8Array => {
  const bytes: number[] = [];
  // A trailing "=" before a line break is a soft line break: the "=" and the
  // break are both removed, not turned into a byte.
  const joined = raw.replace(/=\r?\n/g, '');
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i];
    if (ch === '=' && /^[0-9a-fA-F]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(joined.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
};

/** Exported for `attachments.ts`: the same wire-format decode, but binary. */
export const decodeBase64 = (raw: string): Uint8Array =>
  Uint8Array.from(Buffer.from(raw.replace(/\s+/g, ''), 'base64'));

/** Content-Transfer-Encoding decode. 7BIT/8BIT/BINARY are already text bytes. */
export const decodeBodyPart = (
  raw: string,
  encoding: string,
  charset: string | undefined,
): string => {
  const upper = encoding.toUpperCase();
  const bytes =
    upper === 'BASE64'
      ? decodeBase64(raw)
      : upper === 'QUOTED-PRINTABLE'
        ? decodeQuotedPrintable(raw)
        : Uint8Array.from(Buffer.from(raw, 'utf8'));
  return decodeBytes(bytes, charset ?? 'utf-8');
};

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const decodeHtmlEntities = (text: string): string =>
  text.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return HTML_ENTITIES[entity.toLowerCase()] ?? match;
  });

/**
 * Strip tags to plain text. Regex-based on purpose, not a shortcut: this never
 * parses HTML as a document or executes anything in it, which a real HTML
 * parser dependency would risk and the root project's "no new dependencies"
 * rule would block anyway.
 */
export const stripHtml = (html: string): string => {
  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  const withBreaks = withoutBlocks
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeHtmlEntities(withBreaks)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

export interface BodyTextResult {
  text: string;
  truncated: boolean;
}

export const renderBodyText = (
  raw: string,
  encoding: string,
  charset: string | undefined,
  isHtml: boolean,
  maxChars = MAX_BODY_TEXT_CHARS,
): BodyTextResult => {
  const decoded = decodeBodyPart(raw, encoding, charset);
  const plain = isHtml ? stripHtml(decoded) : decoded.trim();
  if (plain.length > maxChars) {
    return { text: `${plain.slice(0, maxChars - 1)}…`, truncated: true };
  }
  return { text: plain, truncated: false };
};
