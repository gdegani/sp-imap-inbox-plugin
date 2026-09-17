'use strict';

/**
 * A scriptable, in-process IMAP server for the integration tests.
 *
 * It implements just the commands the worker sends, but it implements them the
 * way real servers do — literals for header blocks, UIDVALIDITY/UIDNEXT in
 * response codes, the `n:*` range reversal quirk — so protocol bugs surface
 * here instead of against someone's mailbox.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const tls = require('tls');

const DEFAULT_CAPABILITIES = ['IMAP4rev1', 'AUTH=PLAIN', 'SASL-IR'];

const FIXTURES = path.join(__dirname, 'fixtures');
/** Self-signed, CN=localhost, valid for a century — see test/fixtures/README.md. */
const TLS_OPTIONS = {
  key: fs.readFileSync(path.join(FIXTURES, 'test-key.pem')),
  cert: fs.readFileSync(path.join(FIXTURES, 'test-cert.pem')),
};

const formatLiteral = (text) => `{${Buffer.byteLength(text, 'utf8')}}\r\n${text}`;

/** Expand an IMAP sequence set (`1:3,7,9:*`) against the known UIDs. */
const expandUidSet = (set, uids) => {
  if (uids.length === 0) {
    return [];
  }
  const highest = Math.max(...uids);
  const wanted = new Set();
  for (const part of set.split(',')) {
    const [rawFrom, rawTo] = part.split(':');
    const from = rawFrom === '*' ? highest : Number(rawFrom);
    const to = rawTo === undefined ? from : rawTo === '*' ? highest : Number(rawTo);
    // RFC 3501: the endpoints of a range are order-independent.
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    for (const uid of uids) {
      if (uid >= lo && uid <= hi) {
        wanted.add(uid);
      }
    }
  }
  return [...wanted].sort((a, b) => a - b);
};

const matchesSearch = (criteria, message, uids) => {
  const uidRange = /^UID\s+(\S+)$/i.exec(criteria);
  if (uidRange) {
    return expandUidSet(uidRange[1], uids).includes(message.uid);
  }
  if (/^ALL$/i.test(criteria)) {
    return true;
  }
  const header = /^HEADER\s+(\S+)\s+"(.*)"$/i.exec(criteria);
  if (header) {
    const needle = header[2].toLowerCase();
    return message.headers.toLowerCase().includes(needle);
  }
  const text = /^(?:CHARSET\s+\S+\s+)?TEXT\s+"(.*)"$/i.exec(criteria);
  if (text) {
    return message.headers.toLowerCase().includes(text[1].toLowerCase());
  }
  return false;
};

/**
 * @param {object} options
 * @param {Array} options.messages  `{ uid, internalDate, headers, flags? }`
 * @param {number} [options.uidValidity]
 * @param {number} [options.uidNext]      omit (0) to test the missing-UIDNEXT path
 * @param {string[]} [options.capabilities]
 * @param {string} [options.password]
 * @param {boolean} [options.quotedHeaders] return header blocks as quoted strings
 * @param {'implicit'|'starttls'|'none'} [options.tls] transport mode
 * @param {boolean} [options.injectBeforeStartTls] send data before the handshake,
 *   the STARTTLS plaintext-injection attack the client must refuse
 */
const startFakeImapServer = (options = {}) => {
  const state = {
    messages: (options.messages ?? []).map((m) => ({ flags: [], ...m })),
    uidValidity: options.uidValidity ?? 4711,
    uidNext: options.uidNext,
    capabilities:
      options.capabilities ??
      (options.tls === 'starttls'
        ? [...DEFAULT_CAPABILITIES, 'STARTTLS']
        : DEFAULT_CAPABILITIES),
    username: options.username ?? 'me@example.com',
    password: options.password ?? 'secret',
    quotedHeaders: options.quotedHeaders === true,
    tls: options.tls ?? 'implicit',
    injectBeforeStartTls: options.injectBeforeStartTls === true,
    /** Every command line the server received, for assertions. */
    commands: [],
  };

  const uids = () => state.messages.map((m) => m.uid);
  const nextUid = () =>
    state.uidNext !== undefined
      ? state.uidNext
      : (state.messages.length ? Math.max(...uids()) : 0) + 1;

  const openSockets = new Set();

  const handleConnection = (initialSocket) => {
    let socket = initialSocket;
    openSockets.add(initialSocket);
    initialSocket.on('close', () => openSockets.delete(initialSocket));
    let buffer = '';
    let selected = null;
    let pendingAuthTag = null;

    const send = (line) => socket.write(`${line}\r\n`);

    const openMailbox = (tag, name, writable) => {
      selected = { name, writable };
      send(`* ${state.messages.length} EXISTS`);
      send('* 0 RECENT');
      send(`* OK [UIDVALIDITY ${state.uidValidity}] UIDs valid`);
      if (state.uidNext !== 0) {
        send(`* OK [UIDNEXT ${nextUid()}] Predicted next UID`);
      }
      send(`${tag} OK [${writable ? 'READ-WRITE' : 'READ-ONLY'}] done`);
    };

    const fetchUids = (tag, set) => {
      for (const uid of expandUidSet(set, uids())) {
        const message = state.messages.find((m) => m.uid === uid);
        const body = state.quotedHeaders
          ? `"${message.headers.replace(/[\\"]/g, '\\$&')}"`
          : formatLiteral(message.headers);
        send(
          `* ${state.messages.indexOf(message) + 1} FETCH (UID ${uid} INTERNALDATE "${message.internalDate}" ` +
            `BODY[HEADER.FIELDS (MESSAGE-ID SUBJECT FROM TO DATE)] ${body})`,
        );
      }
      send(`${tag} OK FETCH completed`);
    };

    /** `message.bodyStructure` is the raw parenthesized list, test-authored verbatim. */
    const fetchBodyStructure = (tag, set) => {
      for (const uid of expandUidSet(set, uids())) {
        const message = state.messages.find((m) => m.uid === uid);
        const structure =
          message.bodyStructure ?? '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 0 0)';
        send(
          `* ${state.messages.indexOf(message) + 1} FETCH (UID ${uid} BODYSTRUCTURE ${structure})`,
        );
      }
      send(`${tag} OK FETCH completed`);
    };

    /** `message.bodyParts['<partNumber>']` is the raw (already wire-encoded) part content. */
    const fetchBodyPart = (tag, set, partNumber) => {
      for (const uid of expandUidSet(set, uids())) {
        const message = state.messages.find((m) => m.uid === uid);
        const raw = message.bodyParts?.[partNumber] ?? '';
        const body = state.quotedHeaders
          ? `"${raw.replace(/[\\"]/g, '\\$&')}"`
          : formatLiteral(raw);
        send(`* ${state.messages.indexOf(message) + 1} FETCH (UID ${uid} BODY[${partNumber}] ${body})`);
      }
      send(`${tag} OK FETCH completed`);
    };

    const handle = (raw) => {
      if (pendingAuthTag) {
        const tag = pendingAuthTag;
        pendingAuthTag = null;
        const [, user, pass] = Buffer.from(raw, 'base64').toString('utf8').split('\0');
        send(
          user === state.username && pass === state.password
            ? `${tag} OK authenticated`
            : `${tag} NO [AUTHENTICATIONFAILED] bad credentials`,
        );
        return;
      }

      state.commands.push(raw);
      const match = /^(\S+) (.*)$/.exec(raw);
      if (!match) {
        return;
      }
      const [, tag, rest] = match;
      const command = rest.split(' ')[0].toUpperCase();
      const args = rest.slice(command.length).trim();

      switch (command) {
        case 'CAPABILITY':
          send(`* CAPABILITY ${state.capabilities.join(' ')}`);
          send(`${tag} OK CAPABILITY completed`);
          return;
        case 'AUTHENTICATE': {
          const initial = args.split(' ')[1];
          if (initial) {
            const [, user, pass] = Buffer.from(initial, 'base64')
              .toString('utf8')
              .split('\0');
            send(
              user === state.username && pass === state.password
                ? `${tag} OK authenticated`
                : `${tag} NO [AUTHENTICATIONFAILED] bad credentials`,
            );
          } else {
            pendingAuthTag = tag;
            send('+ ');
          }
          return;
        }
        case 'LOGIN': {
          const creds = args.match(/"((?:[^"\\]|\\.)*)"/g) ?? [];
          const unquote = (v) => v.slice(1, -1).replace(/\\(.)/g, '$1');
          const ok =
            creds.length === 2 &&
            unquote(creds[0]) === state.username &&
            unquote(creds[1]) === state.password;
          send(ok ? `${tag} OK authenticated` : `${tag} NO bad credentials`);
          return;
        }
        case 'EXAMINE':
          openMailbox(tag, args, false);
          return;
        case 'SELECT':
          openMailbox(tag, args, true);
          return;
        case 'UID': {
          const sub = args.split(' ')[0].toUpperCase();
          const subArgs = args.slice(sub.length).trim();
          if (sub === 'SEARCH') {
            const found = state.messages
              .filter((m) => matchesSearch(subArgs, m, uids()))
              .map((m) => m.uid);
            send(`* SEARCH${found.length ? ` ${found.join(' ')}` : ''}`);
            send(`${tag} OK SEARCH completed`);
            return;
          }
          if (sub === 'FETCH') {
            const set = subArgs.split(' ')[0];
            const itemsText = subArgs.slice(set.length).trim();
            if (/\(UID\)$/i.test(subArgs)) {
              for (const uid of expandUidSet(set, uids())) {
                send(`* ${uid} FETCH (UID ${uid})`);
              }
              send(`${tag} OK FETCH completed`);
              return;
            }
            if (/\bBODYSTRUCTURE\b/i.test(itemsText)) {
              fetchBodyStructure(tag, set);
              return;
            }
            const bodyPartMatch = /BODY(?:\.PEEK)?\[([^\]]*)\]/i.exec(itemsText);
            if (bodyPartMatch && !/^HEADER/i.test(bodyPartMatch[1].trim())) {
              fetchBodyPart(tag, set, bodyPartMatch[1]);
              return;
            }
            fetchUids(tag, set);
            return;
          }
          if (sub === 'STORE') {
            if (!selected?.writable) {
              send(`${tag} NO mailbox is read-only`);
              return;
            }
            const set = subArgs.split(' ')[0];
            for (const uid of expandUidSet(set, uids())) {
              const message = state.messages.find((m) => m.uid === uid);
              if (!message.flags.includes('\\Seen')) {
                message.flags.push('\\Seen');
              }
            }
            send(`${tag} OK STORE completed`);
            return;
          }
          send(`${tag} BAD unsupported UID command`);
          return;
        }
        case 'LOGOUT':
          send('* BYE logging out');
          send(`${tag} OK LOGOUT completed`);
          socket.end();
          return;
        case 'STARTTLS': {
          if (state.tls !== 'starttls') {
            send(`${tag} NO STARTTLS not supported by this fake`);
            return;
          }
          if (state.injectBeforeStartTls) {
            // The plaintext-injection attack: data "pre-sent" for a command the
            // client has not issued yet. A correct client must refuse it. Both
            // lines are written in one socket.write() so they always land in
            // the same TCP segment — two separate writes can be delivered as
            // separate 'data' events, racing the client's post-STARTTLS check.
            socket.write(`${tag} OK begin TLS negotiation\r\n* OK injected before the handshake\r\n`);
          } else {
            send(`${tag} OK begin TLS negotiation`);
          }
          const plain = socket;
          plain.removeAllListeners('data');
          const secured = new tls.TLSSocket(plain, { isServer: true, ...TLS_OPTIONS });
          socket = secured;
          buffer = '';
          attach(secured);
          return;
        }
        default:
          send(`${tag} BAD unknown command`);
      }
    };

    function attach(target) {
      target.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\r\n')) !== -1) {
          const lineText = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handle(lineText);
        }
      });
      target.on('error', () => {
        /* the client hanging up mid-command is a scenario under test */
      });
    }

    attach(socket);
    send(`* OK [CAPABILITY ${state.capabilities.join(' ')}] fake IMAP ready`);
  };

  const server =
    state.tls === 'implicit'
      ? tls.createServer(TLS_OPTIONS, handleConnection)
      : net.createServer(handleConnection);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state,
        // Destroy live sockets first: `server.close` waits for every connection
        // to end, and a test that asserts a *rejection* often leaves one open.
        close: () =>
          new Promise((done) => {
            for (const open of openSockets) {
              open.destroy();
            }
            openSockets.clear();
            server.close(done);
          }),
      });
    });
  });
};

module.exports = { startFakeImapServer, expandUidSet };
