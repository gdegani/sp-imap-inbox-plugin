'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startFakeImapServer } = require('./fake-imap-server.cjs');

const { run } = require(path.join(__dirname, '..', 'dist-worker', 'imap-worker.cjs'));

const HEADERS = (id, subject) =>
  `Message-ID: <${id}>\r\nSubject: ${subject}\r\nFrom: Ada <ada@example.com>\r\nTo: me@example.com\r\nDate: Wed, 15 Jan 2026 09:00:00 +0100\r\n`;

const message = (uid, id, subject) => ({
  uid,
  internalDate: '15-Jan-2026 09:00:00 +0100',
  headers: HEADERS(id, subject),
});

/**
 * The fake server presents a self-signed certificate, so tests connect with
 * `allowSelfSigned` — the same switch Proton Bridge and self-hosted Dovecot
 * users need. Certificate validation itself is covered by its own test below.
 */
const conn = (server, over = {}) => ({
  host: '127.0.0.1',
  port: server.port,
  security: 'implicit-tls',
  username: 'me@example.com',
  password: 'secret',
  folder: 'INBOX',
  allowSelfSigned: true,
  ...over,
});

const withServer = async (options, fn) => {
  const server = await startFakeImapServer(options);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
};

test('first poll anchors the watermark and imports nothing', async () => {
  await withServer(
    { messages: [message(1, 'a@x', 'old one'), message(2, 'b@x', 'old two')] },
    async (server) => {
      const result = await run({
        op: 'poll',
        conn: conn(server),
        sinceUid: null,
        uidValidity: null,
        maxMessages: 50,
      });

      assert.equal(result.isReset, true);
      assert.deepEqual(result.messages, []);
      assert.equal(result.anchorUid, 2, 'anchors at the newest existing UID');
      assert.equal(result.status.uidValidity, 4711);
    },
  );
});

test('an anchored folder imports only mail that arrives afterwards', async () => {
  await withServer(
    {
      messages: [
        message(1, 'a@x', 'before'),
        message(2, 'b@x', 'after one'),
        message(3, 'c@x', 'after two'),
      ],
    },
    async (server) => {
      const result = await run({
        op: 'poll',
        conn: conn(server),
        sinceUid: 1,
        uidValidity: 4711,
        maxMessages: 50,
      });

      assert.equal(result.isReset, false);
      assert.deepEqual(
        result.messages.map((m) => m.subject),
        ['after one', 'after two'],
      );
      assert.deepEqual(
        result.messages.map((m) => m.id),
        ['b@x', 'c@x'],
        'the Message-ID is the task identity',
      );
      assert.equal(result.messages[0].from, 'Ada <ada@example.com>');
      assert.equal(
        result.messages[0].receivedAt,
        Date.UTC(2026, 0, 15, 8, 0, 0),
        'receivedAt comes from INTERNALDATE',
      );
    },
  );
});

test('a quiet folder imports nothing despite the n:* range reversal', async () => {
  // `UID 4:*` matches UID 3 on a real server, because range endpoints are
  // order-independent. Without the explicit filter this re-imports forever.
  await withServer({ messages: [message(3, 'c@x', 'newest')] }, async (server) => {
    const result = await run({
      op: 'poll',
      conn: conn(server),
      sinceUid: 3,
      uidValidity: 4711,
      maxMessages: 50,
    });
    assert.deepEqual(result.messages, []);
  });
});

test('a recreated mailbox re-anchors instead of replaying every message', async () => {
  await withServer(
    { messages: [message(1, 'a@x', 'one'), message(2, 'b@x', 'two')], uidValidity: 9999 },
    async (server) => {
      const result = await run({
        op: 'poll',
        conn: conn(server),
        sinceUid: 1,
        uidValidity: 4711,
        maxMessages: 50,
      });
      assert.equal(result.isReset, true);
      assert.deepEqual(result.messages, []);
      assert.equal(result.status.uidValidity, 9999);
    },
  );
});

test('a server that omits UIDNEXT still anchors at the newest UID', async () => {
  await withServer(
    { messages: [message(1, 'a@x', 'one'), message(7, 'b@x', 'two')], uidNext: 0 },
    async (server) => {
      const result = await run({
        op: 'poll',
        conn: conn(server),
        sinceUid: null,
        uidValidity: null,
        maxMessages: 50,
      });
      assert.equal(result.isReset, true);
      assert.equal(result.anchorUid, 7, 'falls back to UID FETCH *:* rather than 0');
    },
  );
});

test('a capped batch leaves the remainder for the next poll', async () => {
  await withServer(
    {
      messages: [
        message(1, 'a@x', 'one'),
        message(2, 'b@x', 'two'),
        message(3, 'c@x', 'three'),
      ],
    },
    async (server) => {
      const result = await run({
        op: 'poll',
        conn: conn(server),
        sinceUid: 0,
        uidValidity: 4711,
        maxMessages: 2,
      });
      assert.deepEqual(
        result.messages.map((m) => m.uid),
        [1, 2],
        'oldest first, so nothing is skipped',
      );
    },
  );
});

test('polling never marks mail as read', async () => {
  await withServer({ messages: [message(2, 'b@x', 'new')] }, async (server) => {
    await run({
      op: 'poll',
      conn: conn(server),
      sinceUid: 1,
      uidValidity: 4711,
      maxMessages: 50,
    });

    assert.deepEqual(server.state.messages[0].flags, [], 'no \\Seen flag was set');
    const commands = server.state.commands.join('\n');
    assert.match(commands, /EXAMINE/, 'the mailbox is opened read-only');
    assert.doesNotMatch(commands, /SELECT/);
    assert.doesNotMatch(commands, /STORE/);
    assert.match(commands, /BODY\.PEEK/, 'headers are peeked, never read');
  });
});

test('markSeen flags exactly the requested messages', async () => {
  await withServer(
    {
      messages: [
        message(1, 'a@x', 'one'),
        message(2, 'b@x', 'two'),
        message(3, 'c@x', 'three'),
      ],
    },
    async (server) => {
      const result = await run({
        op: 'markSeen',
        conn: conn(server),
        uidValidity: 4711,
        uids: [1, 3],
      });

      assert.deepEqual(result.markedUids, [1, 3]);
      assert.deepEqual(result.skippedUids, []);
      assert.deepEqual(server.state.messages[0].flags, ['\\Seen']);
      assert.deepEqual(
        server.state.messages[1].flags,
        [],
        'untouched message stays unread',
      );
      assert.deepEqual(server.state.messages[2].flags, ['\\Seen']);
      assert.match(
        server.state.commands.join('\n'),
        /SELECT/,
        'opens read-write to write',
      );
    },
  );
});

test('markSeen writes nothing when the mailbox was recreated', async () => {
  await withServer(
    { messages: [message(1, 'a@x', 'one')], uidValidity: 5000 },
    async (server) => {
      const result = await run({
        op: 'markSeen',
        conn: conn(server),
        uidValidity: 4711,
        uids: [1],
      });

      assert.deepEqual(result.markedUids, []);
      assert.deepEqual(result.skippedUids, [1]);
      assert.deepEqual(
        server.state.messages[0].flags,
        [],
        'a stale UID must never flag a different message',
      );
      assert.doesNotMatch(server.state.commands.join('\n'), /STORE/);
    },
  );
});

test('markSeen with nothing to do does not even open the mailbox', async () => {
  await withServer({ messages: [message(1, 'a@x', 'one')] }, async (server) => {
    const result = await run({
      op: 'markSeen',
      conn: conn(server),
      uidValidity: 4711,
      uids: [],
    });
    assert.deepEqual(result, { markedUids: [], skippedUids: [] });
    assert.doesNotMatch(server.state.commands.join('\n'), /SELECT|STORE/);
  });
});

test('encoded-word subjects are decoded', async () => {
  const encoded = {
    uid: 2,
    internalDate: '15-Jan-2026 09:00:00 +0100',
    headers:
      'Message-ID: <enc@x>\r\n' +
      'Subject: =?utf-8?Q?Geb=C3=BChren?=\r\n \t=?utf-8?Q?_pr=C3=BCfen?=\r\n' +
      'From: =?iso-8859-1?Q?J=FCrgen?= <j@example.com>\r\n',
  };
  await withServer({ messages: [encoded] }, async (server) => {
    const result = await run({
      op: 'poll',
      conn: conn(server),
      sinceUid: 1,
      uidValidity: 4711,
      maxMessages: 50,
    });
    assert.equal(result.messages[0].subject, 'Gebühren prüfen');
    assert.equal(result.messages[0].from, 'Jürgen <j@example.com>');
  });
});

test('a message without a Message-ID falls back to uidvalidity:uid', async () => {
  await withServer(
    {
      messages: [
        {
          uid: 5,
          internalDate: '15-Jan-2026 09:00:00 +0100',
          headers: 'Subject: no id here\r\n',
        },
      ],
    },
    async (server) => {
      const result = await run({
        op: 'poll',
        conn: conn(server),
        sinceUid: 1,
        uidValidity: 4711,
        maxMessages: 50,
      });
      assert.equal(result.messages[0].id, '4711:5');
    },
  );
});

test('a subject that is missing becomes a readable placeholder', async () => {
  await withServer(
    {
      messages: [
        {
          uid: 5,
          internalDate: '15-Jan-2026 09:00:00 +0100',
          headers: 'Message-ID: <nosub@x>\r\n',
        },
      ],
    },
    async (server) => {
      const result = await run({
        op: 'poll',
        conn: conn(server),
        sinceUid: 1,
        uidValidity: 4711,
        maxMessages: 50,
      });
      assert.equal(result.messages[0].subject, '(no subject)');
    },
  );
});

test('header blocks returned as quoted strings are handled too', async () => {
  // A quoted string cannot contain CRLF, so servers only use this form for a
  // single short header line; literals cover everything else.
  await withServer(
    {
      messages: [
        {
          uid: 2,
          internalDate: '15-Jan-2026 09:00:00 +0100',
          headers: 'Message-ID: <q@x>',
        },
      ],
      quotedHeaders: true,
    },
    async (server) => {
      const result = await run({
        op: 'poll',
        conn: conn(server),
        sinceUid: 1,
        uidValidity: 4711,
        maxMessages: 50,
      });
      assert.equal(result.messages[0].id, 'q@x');
    },
  );
});

test('search returns newest matches first', async () => {
  await withServer(
    {
      messages: [
        message(1, 'a@x', 'invoice january'),
        message(2, 'b@x', 'invoice february'),
        message(3, 'c@x', 'unrelated'),
      ],
    },
    async (server) => {
      const result = await run({
        op: 'search',
        conn: conn(server),
        term: 'invoice',
        maxMessages: 10,
      });
      assert.deepEqual(
        result.messages.map((m) => m.uid),
        [2, 1],
      );
    },
  );
});

test('lookup finds a message by its Message-ID', async () => {
  await withServer(
    { messages: [message(1, 'a@x', 'one'), message(2, 'wanted@x', 'two')] },
    async (server) => {
      const result = await run({
        op: 'lookup',
        conn: conn(server),
        messageIds: ['wanted@x'],
      });
      assert.deepEqual(
        result.messages.map((m) => m.id),
        ['wanted@x'],
      );
    },
  );
});

test('test reports mailbox status and capabilities', async () => {
  await withServer({ messages: [message(1, 'a@x', 'one')] }, async (server) => {
    const result = await run({ op: 'test', conn: conn(server) });
    assert.equal(result.status.uidValidity, 4711);
    assert.equal(result.status.exists, 1);
    assert.ok(result.capabilities.includes('IMAP4REV1'));
  });
});

test('body: fetches a plain-text message and decodes quoted-printable', async () => {
  await withServer(
    {
      messages: [
        {
          ...message(1, 'a@x', 'hello'),
          bodyStructure:
            '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 20 2)',
          bodyParts: { 1: 'caf=C3=A9 au lait' },
        },
      ],
    },
    async (server) => {
      const result = await run({ op: 'body', conn: conn(server), uid: 1 });
      assert.equal(result.bodyText, 'café au lait');
      assert.equal(result.bodyTruncated, false);
      assert.deepEqual(result.attachments, []);
    },
  );
});

test('body: prefers text/plain over text/html in a multipart/alternative message', async () => {
  await withServer(
    {
      messages: [
        {
          ...message(1, 'a@x', 'hi'),
          bodyStructure:
            '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 5 1)' +
            '("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 20 1) "ALTERNATIVE")',
          bodyParts: { 1: 'plain body', 2: '<p>html <b>body</b></p>' },
        },
      ],
    },
    async (server) => {
      const result = await run({ op: 'body', conn: conn(server), uid: 1 });
      assert.equal(result.bodyText, 'plain body');
      assert.ok(
        !server.state.commands.some((c) => /BODY(\.PEEK)?\[2\]/i.test(c)),
        'must not fetch the html alternative once the plain part is chosen',
      );
    },
  );
});

test('body: lists an attachment from BODYSTRUCTURE without fetching its content', async () => {
  await withServer(
    {
      messages: [
        {
          ...message(1, 'a@x', 'invoice'),
          bodyStructure:
            '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 11 1)' +
            '("APPLICATION" "PDF" ("NAME" "invoice.pdf") NIL NIL "BASE64" 45000 NIL ' +
            '("ATTACHMENT" ("FILENAME" "invoice.pdf")) NIL) "MIXED")',
          bodyParts: { 1: 'please pay' },
        },
      ],
    },
    async (server) => {
      const result = await run({ op: 'body', conn: conn(server), uid: 1 });
      assert.equal(result.bodyText, 'please pay');
      assert.deepEqual(result.attachments, [{ filename: 'invoice.pdf', size: 45000 }]);
      assert.ok(
        !server.state.commands.some((c) => /BODY(\.PEEK)?\[2\]/i.test(c)),
        'attachment content must never be fetched — only listed from BODYSTRUCTURE',
      );
    },
  );
});

test('body: strips HTML to plain text when there is no text/plain part', async () => {
  await withServer(
    {
      messages: [
        {
          ...message(1, 'a@x', 'newsletter'),
          bodyStructure: '("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 30 2)',
          bodyParts: { 1: '<p>Hello <b>there</b></p>' },
        },
      ],
    },
    async (server) => {
      const result = await run({ op: 'body', conn: conn(server), uid: 1 });
      assert.equal(result.bodyText, 'Hello there');
    },
  );
});

test('body: lists a non-text part with a NAME as an attachment when there is no text part', async () => {
  await withServer(
    {
      messages: [
        {
          ...message(1, 'a@x', 'photo'),
          bodyStructure:
            '("IMAGE" "PNG" ("NAME" "photo.png") NIL NIL "BASE64" 20000 NIL NIL NIL)',
          bodyParts: {},
        },
      ],
    },
    async (server) => {
      const result = await run({ op: 'body', conn: conn(server), uid: 1 });
      assert.equal(result.bodyText, undefined);
      assert.equal(result.bodyTruncated, false);
      assert.deepEqual(result.attachments, [{ filename: 'photo.png', size: 20000 }]);
    },
  );
});

test('body: skips an oversized text part instead of fetching it', async () => {
  await withServer(
    {
      messages: [
        {
          ...message(1, 'a@x', 'huge'),
          bodyStructure: '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 5000000 1)',
          bodyParts: { 1: 'should never be fetched' },
        },
      ],
    },
    async (server) => {
      const result = await run({ op: 'body', conn: conn(server), uid: 1 });
      assert.equal(result.bodyText, undefined);
      assert.equal(result.bodyTruncated, true);
      assert.ok(
        !server.state.commands.some((c) => /BODY(\.PEEK)?\[1\]/i.test(c)),
        'must not fetch a part known to be oversized from BODYSTRUCTURE',
      );
    },
  );
});

test('body: returns an empty result when the server has nothing for that UID', async () => {
  await withServer({ messages: [] }, async (server) => {
    const result = await run({ op: 'body', conn: conn(server), uid: 999 });
    assert.equal(result.bodyText, undefined);
    assert.equal(result.bodyTruncated, false);
    assert.deepEqual(result.attachments, []);
  });
});

test('attachments: fetches and saves real content, skipping what is too large', async () => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imap-inbox-attachments-test-'));
  try {
    await withServer(
      {
        messages: [
          {
            ...message(7, 'a@x', 'invoice'),
            bodyStructure:
              '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 11 1)' +
              '("APPLICATION" "PDF" ("NAME" "invoice.pdf") NIL NIL "BASE64" 8 NIL ' +
              '("ATTACHMENT" ("FILENAME" "invoice.pdf")) NIL)' +
              '("IMAGE" "PNG" ("NAME" "huge.png") NIL NIL "BASE64" 99999999 NIL ' +
              '("ATTACHMENT" ("FILENAME" "huge.png")) NIL) "MIXED")',
            bodyParts: { 1: 'please pay', 2: Buffer.from('%PDF-1.4').toString('base64') },
          },
        ],
      },
      async (server) => {
        const result = await run({
          op: 'attachments',
          conn: conn(server),
          uids: [7],
          saveDir,
        });
        const forUid = result.byUid[7];
        assert.equal(forUid.saved.length, 1);
        assert.equal(forUid.saved[0].filename, 'invoice.pdf');
        assert.equal(fs.readFileSync(forUid.saved[0].path, 'utf8'), '%PDF-1.4');
        assert.deepEqual(forUid.skipped, [
          { filename: 'huge.png', size: 99999999, reason: 'too-large' },
        ]);
        assert.ok(
          !server.state.commands.some((c) => /BODY(\.PEEK)?\[3\]/i.test(c)),
          'the oversized part must never be fetched',
        );
      },
    );
  } finally {
    fs.rmSync(saveDir, { recursive: true, force: true });
  }
});

test('attachments: a message with no attachment parts saves nothing', async () => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imap-inbox-attachments-test-'));
  try {
    await withServer(
      {
        messages: [
          {
            ...message(1, 'a@x', 'hello'),
            bodyStructure: '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 5 1)',
            bodyParts: { 1: 'hello' },
          },
        ],
      },
      async (server) => {
        const result = await run({ op: 'attachments', conn: conn(server), uids: [1], saveDir });
        assert.deepEqual(result.byUid[1], { saved: [], skipped: [] });
        assert.deepEqual(fs.readdirSync(saveDir), []);
      },
    );
  } finally {
    fs.rmSync(saveDir, { recursive: true, force: true });
  }
});

test('falls back to LOGIN when the server does not offer AUTH=PLAIN', async () => {
  await withServer(
    { messages: [message(1, 'a@x', 'one')], capabilities: ['IMAP4rev1'] },
    async (server) => {
      const result = await run({ op: 'test', conn: conn(server) });
      assert.equal(result.status.uidValidity, 4711);
      assert.match(server.state.commands.join('\n'), /LOGIN "me@example\.com"/);
    },
  );
});

test('a two-step SASL exchange works when SASL-IR is absent', async () => {
  await withServer(
    { messages: [message(1, 'a@x', 'one')], capabilities: ['IMAP4rev1', 'AUTH=PLAIN'] },
    async (server) => {
      const result = await run({ op: 'test', conn: conn(server) });
      assert.equal(result.status.uidValidity, 4711);
      const authLine = server.state.commands.find((c) => /AUTHENTICATE/.test(c));
      assert.match(
        authLine,
        /^\S+ AUTHENTICATE PLAIN$/,
        'the credential goes in the continuation, not on the command line',
      );
    },
  );
});

test('a wrong password fails with the server reason, not a generic error', async () => {
  await withServer({ messages: [] }, async (server) => {
    await assert.rejects(
      () => run({ op: 'test', conn: conn(server, { password: 'wrong' }) }),
      /AUTHENTICATIONFAILED|bad credentials/,
    );
  });
});

test('a non-ASCII folder name is sent as modified UTF-7', async () => {
  await withServer({ messages: [] }, async (server) => {
    const withFolder = conn(server, { folder: 'Does Not Exist' });
    // The fake opens any mailbox, so assert the name was encoded, not rejected.
    await run({ op: 'test', conn: withFolder });
    assert.match(
      server.state.commands.join('\n'),
      /EXAMINE "Does&AKA-Not Exist"/,
      'non-ASCII folder names go out as modified UTF-7',
    );
  });
});

test('the server closing mid-command is reported, not hung on', async () => {
  const server = await startFakeImapServer({ messages: [] });
  await server.close();
  await assert.rejects(
    () =>
      run({
        op: 'test',
        conn: { ...conn(server), port: server.port },
      }),
    /ECONNREFUSED|closed|Timed out/,
  );
});

test('an untrusted certificate is refused unless explicitly allowed', async () => {
  await withServer({ messages: [] }, async (server) => {
    await assert.rejects(
      () => run({ op: 'test', conn: conn(server, { allowSelfSigned: false }) }),
      /self.signed|certificate/i,
      'certificate validation is on by default',
    );
  });
});

test('STARTTLS upgrades the connection before credentials are sent', async () => {
  await withServer(
    { messages: [message(1, 'a@x', 'one')], tls: 'starttls' },
    async (server) => {
      const result = await run({
        op: 'test',
        conn: conn(server, { security: 'starttls' }),
      });

      assert.equal(result.status.uidValidity, 4711);
      const commands = server.state.commands;
      const startTlsAt = commands.findIndex((c) => /STARTTLS/.test(c));
      const authAt = commands.findIndex((c) => /AUTHENTICATE|LOGIN/.test(c));
      assert.ok(startTlsAt >= 0, 'STARTTLS was issued');
      assert.ok(authAt > startTlsAt, 'credentials go out only after the handshake');
    },
  );
});

test('STARTTLS is refused when the server does not advertise it', async () => {
  await withServer({ messages: [], tls: 'none' }, async (server) => {
    await assert.rejects(
      () => run({ op: 'test', conn: conn(server, { security: 'starttls' }) }),
      /does not advertise STARTTLS/,
    );
  });
});

test('data sent before the TLS handshake aborts the connection', async () => {
  // Plaintext command injection (the CVE-2011-0411 shape): a server that
  // pre-sends a response for a command the client has not issued yet.
  await withServer(
    { messages: [], tls: 'starttls', injectBeforeStartTls: true },
    async (server) => {
      await assert.rejects(
        () => run({ op: 'test', conn: conn(server, { security: 'starttls' }) }),
        /before the TLS handshake/,
      );
      assert.doesNotMatch(
        server.state.commands.join('\n'),
        /AUTHENTICATE|LOGIN/,
        'no credential was sent to a server that behaved this way',
      );
    },
  );
});
