/**
 * Modified UTF-7 encoding for IMAP mailbox names (RFC 3501 5.1.3).
 *
 * Only the encoder is implemented: the folder is typed by the user and never
 * listed back, so we never have to decode a server-supplied name.
 */

const isPrintableAscii = (cu: number): boolean => cu >= 0x20 && cu <= 0x7e;

const base64ModifiedUtf7 = (codeUnits: number[]): string => {
  const bytes = Buffer.alloc(codeUnits.length * 2);
  codeUnits.forEach((cu, i) => {
    bytes[i * 2] = (cu >> 8) & 0xff;
    bytes[i * 2 + 1] = cu & 0xff;
  });
  return bytes.toString('base64').replace(/=+$/, '').replace(/\//g, ',');
};

export const encodeMailboxName = (name: string): string => {
  let out = '';
  let pending: number[] = [];

  const flush = (): void => {
    if (pending.length === 0) {
      return;
    }
    out += `&${base64ModifiedUtf7(pending)}-`;
    pending = [];
  };

  for (let i = 0; i < name.length; i++) {
    const cu = name.charCodeAt(i);
    if (cu === 0x26) {
      // '&' is the shift character and escapes as '&-'
      flush();
      out += '&-';
    } else if (isPrintableAscii(cu)) {
      flush();
      out += name[i];
    } else {
      pending.push(cu);
    }
  }
  flush();
  return out;
};

/**
 * IMAP quoted string. Mailbox names and search terms go through here; anything
 * that cannot be quoted safely (CR/LF) is rejected rather than escaped, because
 * a line break in an IMAP argument is command injection.
 */
export const quoteImapString = (value: string): string => {
  if (/[\r\n\0]/.test(value)) {
    throw new Error('Value contains a line break and cannot be sent to the server');
  }
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
};
