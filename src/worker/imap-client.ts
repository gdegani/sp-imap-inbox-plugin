import * as net from 'net';
import * as tls from 'tls';
import type { ImapConnectionCfg, MailboxStatus } from '../shared/types';
import { encodeMailboxName, quoteImapString } from './mailbox-name';
import {
  extractBodySectionValue,
  FetchRecord,
  ImapLine,
  literalToken,
  parseCapabilities,
  parseFetchRecord,
  parseResponseCodeNumber,
  parseSearchUids,
  parseTagged,
  parseUntaggedCount,
  TaggedResult,
} from './imap-parse';

const CRLF = Buffer.from('\r\n');

/**
 * Abuse guards, not tuning knobs. We only ever request a bounded number of
 * header-only records, so crossing any of these means the peer is broken or
 * hostile and the right move is to drop the connection, not to keep buffering.
 */
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_LITERAL_BYTES = 1 * 1024 * 1024;
const MAX_RESPONSE_LINES = 5000;

export interface ExecResult {
  lines: ImapLine[];
  result: TaggedResult;
}

/**
 * A minimal IMAP4rev1 client: enough to open a mailbox read-only, list new
 * UIDs, pull headers, fetch a single message's body/attachment list on
 * demand, and flag messages as read. No IDLE (the host spawns a fresh
 * process per call), no mailbox listing.
 */
export class ImapClient {
  private socket!: net.Socket | tls.TLSSocket;
  private buf: Buffer = Buffer.alloc(0);
  private closed = false;
  private failure: Error | null = null;
  private notify: (() => void) | null = null;
  private waiting: Promise<void> | null = null;
  private tagSeq = 0;
  private capabilities: string[] = [];

  private constructor(
    private readonly cfg: ImapConnectionCfg,
    private readonly deadlineAt: number,
  ) {}

  static async connect(cfg: ImapConnectionCfg, deadlineAt: number): Promise<ImapClient> {
    const client = new ImapClient(cfg, deadlineAt);
    const socket =
      cfg.security === 'implicit-tls'
        ? await client.openTlsSocket()
        : await client.openPlainSocket();
    client.attach(socket);

    const greeting = await client.readLine();
    if (/^\* (BYE|NO|BAD)\b/i.test(greeting.text)) {
      client.destroy();
      throw new Error(`Server rejected the connection: ${greeting.text.slice(0, 200)}`);
    }
    client.capabilities = parseCapabilities(greeting.text);

    if (cfg.security === 'starttls') {
      await client.startTls();
    } else if (client.capabilities.length === 0) {
      await client.refreshCapabilities();
    }
    return client;
  }

  getCapabilities(): string[] {
    return [...this.capabilities];
  }

  // --- connection setup -----------------------------------------------------

  private openPlainSocket(): Promise<net.Socket> {
    return this.awaitSocket(
      net.connect({ host: this.cfg.host, port: this.cfg.port }),
      'connect',
    );
  }

  private openTlsSocket(): Promise<tls.TLSSocket> {
    return this.awaitSocket(
      tls.connect({
        host: this.cfg.host,
        port: this.cfg.port,
        servername: this.cfg.host,
        rejectUnauthorized: !this.cfg.allowSelfSigned,
      }),
      'secureConnect',
    );
  }

  private awaitSocket<T extends net.Socket>(socket: T, readyEvent: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          socket.destroy();
          reject(new Error(`Timed out connecting to ${this.cfg.host}:${this.cfg.port}`));
        },
        Math.max(1000, this.deadlineAt - Date.now()),
      );
      const onError = (err: Error): void => {
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      };
      socket.once('error', onError);
      socket.once(readyEvent, () => {
        clearTimeout(timer);
        socket.removeListener('error', onError);
        socket.setNoDelay(true);
        resolve(socket);
      });
    });
  }

  private async startTls(): Promise<void> {
    if (!this.capabilities.length) {
      await this.refreshCapabilities();
    }
    if (!this.capabilities.includes('STARTTLS')) {
      throw new Error('Server does not advertise STARTTLS on this port');
    }
    await this.execOk('STARTTLS');

    // RFC 3501 requires discarding anything buffered before the handshake:
    // data the server "already sent" for post-STARTTLS commands is the classic
    // plaintext-injection vector. We refuse rather than discard, so a server
    // doing this is a hard error instead of a silent downgrade.
    if (this.buf.length > 0) {
      this.destroy();
      throw new Error('Server sent data before the TLS handshake; aborting');
    }

    const plain = this.socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('close');

    const secured = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      const socket = tls.connect(
        {
          socket: plain,
          servername: this.cfg.host,
          rejectUnauthorized: !this.cfg.allowSelfSigned,
        },
        () => {
          socket.removeListener('error', onError);
          resolve(socket);
        },
      );
      socket.once('error', onError);
    });

    this.attach(secured);
    // Capabilities advertised before the handshake are not trustworthy.
    await this.refreshCapabilities();
  }

  private attach(socket: net.Socket | tls.TLSSocket): void {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      if (this.buf.length > MAX_BUFFER_BYTES) {
        this.fail(new Error('Server response exceeded the size limit'));
        return;
      }
      this.wake();
    });
    socket.on('error', (err: Error) => this.fail(err));
    socket.on('close', () => {
      this.closed = true;
      this.wake();
    });
  }

  private fail(err: Error): void {
    if (!this.failure) {
      this.failure = err;
    }
    this.closed = true;
    this.socket?.destroy();
    this.wake();
  }

  // --- line reading ---------------------------------------------------------

  private wake(): void {
    const notify = this.notify;
    this.notify = null;
    this.waiting = null;
    notify?.();
  }

  private dataArrived(): Promise<void> {
    if (!this.waiting) {
      this.waiting = new Promise<void>((resolve) => {
        this.notify = resolve;
      });
    }
    return this.waiting;
  }

  private async waitForMore(): Promise<void> {
    if (this.failure) {
      throw this.failure;
    }
    if (this.closed) {
      throw new Error('Server closed the connection unexpectedly');
    }
    const remaining = this.deadlineAt - Date.now();
    if (remaining <= 0) {
      this.destroy();
      throw new Error('IMAP operation timed out');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.dataArrived(),
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('IMAP operation timed out')),
            remaining,
          );
        }),
      ]);
    } catch (err) {
      this.destroy();
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (this.failure) {
      throw this.failure;
    }
  }

  /**
   * Read one *logical* response line, inlining literal placeholders. See
   * {@link ImapLine} for why literals are lifted out of the text.
   */
  async readLine(): Promise<ImapLine> {
    let text = '';
    const literals: string[] = [];

    for (;;) {
      const idx = this.buf.indexOf(CRLF);
      if (idx === -1) {
        await this.waitForMore();
        continue;
      }
      const rawLine = this.buf.subarray(0, idx).toString('utf8');
      const literalMatch = /\{(\d+)\}$/.exec(rawLine);

      if (!literalMatch) {
        this.buf = this.buf.subarray(idx + CRLF.length);
        return { text: text + rawLine, literals };
      }

      const size = Number(literalMatch[1]);
      if (size > MAX_LITERAL_BYTES) {
        this.fail(new Error('Server sent an oversized literal'));
        throw this.failure as Error;
      }
      const end = idx + CRLF.length + size;
      if (this.buf.length < end) {
        await this.waitForMore();
        continue;
      }
      literals.push(this.buf.subarray(idx + CRLF.length, end).toString('utf8'));
      text += rawLine.slice(0, literalMatch.index) + literalToken(literals.length - 1);
      this.buf = this.buf.subarray(end);
    }
  }

  // --- commands -------------------------------------------------------------

  private write(payload: string): void {
    if (this.closed) {
      throw this.failure ?? new Error('Connection is closed');
    }
    this.socket.write(payload);
  }

  /**
   * Run one command to completion. `continuation` supplies the payload for a
   * `+` request (SASL); a continuation we did not expect is a protocol error.
   */
  async exec(
    command: string,
    opts?: { continuation?: () => string | null },
  ): Promise<ExecResult> {
    this.tagSeq += 1;
    const tag = `A${String(this.tagSeq).padStart(4, '0')}`;
    this.write(`${tag} ${command}\r\n`);

    const lines: ImapLine[] = [];
    for (;;) {
      const line = await this.readLine();
      const tagged = parseTagged(line.text, tag);
      if (tagged) {
        return { lines, result: tagged };
      }
      if (line.text.startsWith('+')) {
        const payload = opts?.continuation?.() ?? null;
        if (payload === null) {
          this.destroy();
          throw new Error('Server asked for data we did not offer');
        }
        this.write(`${payload}\r\n`);
        continue;
      }
      lines.push(line);
      if (lines.length > MAX_RESPONSE_LINES) {
        this.fail(new Error('Server sent too many response lines'));
        throw this.failure as Error;
      }
    }
  }

  /** As {@link exec}, but a NO/BAD completion throws with the server's text. */
  async execOk(
    command: string,
    opts?: { continuation?: () => string | null; label?: string },
  ): Promise<ExecResult> {
    const res = await this.exec(command, opts);
    if (res.result.status !== 'OK') {
      const what = opts?.label ?? command.split(' ')[0];
      throw new Error(
        `${what} failed: ${res.result.text.slice(0, 200) || res.result.status}`,
      );
    }
    return res;
  }

  private async refreshCapabilities(): Promise<void> {
    const res = await this.execOk('CAPABILITY');
    const fromUntagged = res.lines.flatMap((line) => parseCapabilities(line.text));
    this.capabilities = fromUntagged.length
      ? fromUntagged
      : parseCapabilities(res.result.text);
  }

  async login(): Promise<void> {
    const { username, password } = this.cfg;

    if (this.capabilities.includes('AUTH=PLAIN')) {
      const payload = Buffer.from(`\0${username}\0${password}`, 'utf8').toString(
        'base64',
      );
      if (this.capabilities.includes('SASL-IR')) {
        await this.execOk(`AUTHENTICATE PLAIN ${payload}`, { label: 'Login' });
      } else {
        await this.execOk('AUTHENTICATE PLAIN', {
          label: 'Login',
          continuation: () => payload,
        });
      }
    } else {
      if (this.capabilities.includes('LOGINDISABLED')) {
        throw new Error('Server disabled password login on this connection');
      }
      await this.execOk(
        `LOGIN ${quoteImapString(username)} ${quoteImapString(password)}`,
        { label: 'Login' },
      );
    }
    // The post-login capability set is the authoritative one.
    await this.refreshCapabilities();
  }

  /**
   * Open the mailbox. `EXAMINE` (read-only) is the default so a poll can never
   * set \Seen as a side effect; `SELECT` is used only by the mark-as-read path.
   */
  async openMailbox(folder: string, writable = false): Promise<MailboxStatus> {
    const name = quoteImapString(encodeMailboxName(folder));
    const res = await this.execOk(`${writable ? 'SELECT' : 'EXAMINE'} ${name}`, {
      label: `Opening "${folder}"`,
    });

    const all = [...res.lines.map((l) => l.text), res.result.text];
    const uidValidity = all
      .map((text) => parseResponseCodeNumber(text, 'UIDVALIDITY'))
      .find((v) => v !== null);
    const uidNext = all
      .map((text) => parseResponseCodeNumber(text, 'UIDNEXT'))
      .find((v) => v !== null);
    const exists = res.lines
      .map((l) => parseUntaggedCount(l.text, 'EXISTS'))
      .find((v) => v !== null);

    if (uidValidity == null) {
      throw new Error(`Server did not report UIDVALIDITY for "${folder}"`);
    }
    return {
      uidValidity,
      // UIDNEXT is optional in a SELECT response; fall back to "one past the
      // highest UID we can see", which the caller only uses as a watermark.
      uidNext: uidNext ?? 0,
      exists: exists ?? 0,
    };
  }

  async uidSearch(criteria: string): Promise<number[]> {
    const res = await this.execOk(`UID SEARCH ${criteria}`, { label: 'Search' });
    return res.lines.flatMap((line) => parseSearchUids(line.text));
  }

  /**
   * Highest UID currently in the mailbox, via the `*:*` trick (one record, no
   * full-mailbox SEARCH). Used to anchor a watermark when the server omits
   * UIDNEXT; 0 for an empty mailbox.
   */
  async highestUid(): Promise<number> {
    const res = await this.execOk('UID FETCH *:* (UID)', { label: 'Fetch' });
    const uids = res.lines
      .map((line) => /^\* \d+ FETCH .*\bUID (\d+)/i.exec(line.text))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]));
    return uids.length ? Math.max(...uids) : 0;
  }

  async uidFetchHeaders(uidSet: string): Promise<FetchRecord[]> {
    const res = await this.execOk(
      `UID FETCH ${uidSet} (UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID SUBJECT FROM TO DATE)])`,
      { label: 'Fetch' },
    );
    return res.lines
      .map((line) => parseFetchRecord(line))
      .filter((record): record is FetchRecord => record !== null);
  }

  /** Structure-only — no content is transferred, just sizes/types/filenames. */
  async uidFetchBodyStructure(uid: number): Promise<ImapLine | null> {
    const res = await this.execOk(`UID FETCH ${uid} (BODYSTRUCTURE)`, { label: 'Fetch' });
    return res.lines.find((line) => /^\* \d+ FETCH /i.test(line.text)) ?? null;
  }

  /** `.PEEK` so a body preview never marks the message \Seen as a side effect. */
  async uidFetchBodyPart(uid: number, partNumber: string): Promise<string | null> {
    const res = await this.execOk(`UID FETCH ${uid} (BODY.PEEK[${partNumber}])`, {
      label: 'Fetch',
    });
    const line = res.lines.find((l) => /^\* \d+ FETCH /i.test(l.text));
    return line ? extractBodySectionValue(line) : null;
  }

  /** The only write this plugin ever performs against a mailbox. */
  async uidMarkSeen(uidSet: string): Promise<void> {
    await this.execOk(`UID STORE ${uidSet} +FLAGS.SILENT (\\Seen)`, {
      label: 'Marking as read',
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      this.destroy();
      return;
    }
    try {
      await this.exec('LOGOUT');
    } catch {
      // A failed logout changes nothing; the socket is going away regardless.
    }
    this.destroy();
  }

  destroy(): void {
    this.closed = true;
    this.socket?.destroy();
  }
}
