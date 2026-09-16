/** RFC 5322 header + RFC 2047 encoded-word handling. Worker-side (uses Buffer). */

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g;

/** Decode a byte run with a MIME charset label, falling back to windows-1252. */
export const decodeBytes = (bytes: Uint8Array, charset: string): string => {
  // RFC 2231 allows a `*language` suffix on the charset token.
  const label = charset.split('*')[0].trim().toLowerCase() || 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    // windows-1252 rather than latin1: it is a superset for the printable
    // range and is what mail clients assume for mislabelled western text.
    return new TextDecoder('windows-1252').decode(bytes);
  }
};

const decodeQ = (text: string, charset: string): string => {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '_') {
      bytes.push(0x20);
    } else if (ch === '=' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i) & 0xff);
    }
  }
  return decodeBytes(Uint8Array.from(bytes), charset);
};

const decodeB = (text: string, charset: string): string =>
  decodeBytes(Buffer.from(text, 'base64'), charset);

/**
 * Decode every encoded-word in a header value.
 *
 * Per RFC 2047 6.2, whitespace *between two adjacent encoded words* is not part
 * of the text and is dropped; whitespace next to ordinary text is kept. An
 * undecodable word is left verbatim rather than mangled.
 */
export const decodeEncodedWords = (input: string): string => {
  ENCODED_WORD.lastIndex = 0;
  let out = '';
  let cursor = 0;
  let prevWasEncoded = false;
  let match: RegExpExecArray | null;

  while ((match = ENCODED_WORD.exec(input)) !== null) {
    const gap = input.slice(cursor, match.index);
    if (!(prevWasEncoded && gap.trim() === '')) {
      out += gap;
    }
    const [, charset, encoding, text] = match;
    try {
      out +=
        encoding.toLowerCase() === 'b' ? decodeB(text, charset) : decodeQ(text, charset);
    } catch {
      out += match[0];
    }
    cursor = match.index + match[0].length;
    prevWasEncoded = true;
  }
  return out + input.slice(cursor);
};

/**
 * Unfold a raw header block into name to values. Names are lower-cased; values
 * keep their raw (still encoded) form.
 */
export const parseHeaderBlock = (raw: string): Map<string, string[]> => {
  const headers = new Map<string, string[]>();
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  let current: { name: string; value: string } | null = null;

  const commit = (): void => {
    if (!current) {
      return;
    }
    const key = current.name.toLowerCase();
    const list = headers.get(key);
    if (list) {
      list.push(current.value);
    } else {
      headers.set(key, [current.value]);
    }
    current = null;
  };

  for (const line of lines) {
    if (/^[ \t]/.test(line)) {
      if (current) {
        // Unfolding removes the CRLF but keeps the folding whitespace.
        current.value += ` ${line.trim()}`;
      }
      continue;
    }
    commit();
    const idx = line.indexOf(':');
    if (idx > 0) {
      current = { name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
    }
  }
  commit();
  return headers;
};

export const firstHeader = (headers: Map<string, string[]>, name: string): string =>
  headers.get(name.toLowerCase())?.[0] ?? '';

// C0/C1 controls (minus the whitespace we collapse anyway) would corrupt a task
// title or let a crafted header inject line breaks into the UI.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** Decoded, whitespace-collapsed, length-capped header value for display. */
export const headerText = (raw: string, maxLength = 512): string => {
  const decoded = decodeEncodedWords(raw)
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
  return decoded.length > maxLength ? `${decoded.slice(0, maxLength - 1)}…` : decoded;
};

/**
 * Normalize a Message-ID into the value used as the task's `issueId`.
 * Angle brackets and surrounding whitespace are dropped; the value is
 * otherwise left alone (the local part is case-sensitive).
 */
export const normalizeMessageId = (raw: string): string | null => {
  const match = /<([^<>]+)>/.exec(raw);
  const value = (match ? match[1] : raw).trim();
  if (!value || value.length > 512 || /[\s\0]/.test(value)) {
    return null;
  }
  return value;
};
