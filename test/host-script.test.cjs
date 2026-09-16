'use strict';

/**
 * End-to-end check of the artifact the plugin actually ships: the wrapped
 * script string handed to `PluginAPI.executeNodeScript`, executed the way
 * `PluginNodeExecutor.executeViaSpawn` executes it.
 *
 * This is the only test that covers the seam between the plugin and the host —
 * the wrapper, the spawned process, and the rule that stdout belongs to the
 * JSON result and nothing else.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startFakeImapServer } = require('./fake-imap-server.cjs');

const HOST_SCRIPT_PATH = path.join(__dirname, '..', 'dist-worker', 'host-script.js');

/**
 * Copied from `electron/plugin-node-executor.ts`. If the host changes how it
 * wraps or routes a script, this test is where we find out.
 */
const HOST_DANGEROUS_PATTERN =
  /require\s*\(\s*['"`](?!fs|path|os)[^'"]+['"`]\s*\)|child_process|exec|spawn|eval|Function|process\.exit/;

const wrapLikeHost = (script, args) => `
        'use strict';
        (async function() {
          const args = ${JSON.stringify(args || [])};
          try {
            const result = await (async function() {
              ${script}
            })();
            console.log(JSON.stringify({ __result: result }));
          } catch (error) {
            console.error(JSON.stringify({
              __error: error.message || String(error)
            }));
            process.exit(1);
          }
        })();
      `;

const runLikeHost = (script, args) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--no-warnings', '-e', wrapLikeHost(script, args)],
      {
        // The host strips the environment down to these two entries.
        env: { NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

test('the shipped script is routed to the spawned Node process, not the vm sandbox', () => {
  const script = fs.readFileSync(HOST_SCRIPT_PATH, 'utf8');
  assert.ok(
    HOST_DANGEROUS_PATTERN.test(script),
    'a script that does not match runs in a vm where only fs/path/os exist — no tls, no IMAP',
  );
  assert.ok(script.length < 100_000, 'the host rejects scripts of 100 KB or more');
});

test('a poll run through the real host wrapper returns clean JSON on stdout', async () => {
  const server = await startFakeImapServer({
    messages: [
      {
        uid: 1,
        internalDate: '15-Jan-2026 09:00:00 +0100',
        headers: 'Message-ID: <old@x>\r\nSubject: before\r\n',
      },
      {
        uid: 2,
        internalDate: '15-Jan-2026 10:00:00 +0100',
        headers: 'Message-ID: <new@x>\r\nSubject: =?utf-8?Q?caf=C3=A9?=\r\n',
      },
    ],
  });

  try {
    const script = fs.readFileSync(HOST_SCRIPT_PATH, 'utf8');
    const { code, stdout, stderr } = await runLikeHost(script, [
      {
        op: 'poll',
        conn: {
          host: '127.0.0.1',
          port: server.port,
          security: 'implicit-tls',
          username: 'me@example.com',
          password: 'secret',
          folder: 'INBOX',
          allowSelfSigned: true,
        },
        sinceUid: 1,
        uidValidity: 4711,
        maxMessages: 50,
      },
    ]);

    assert.equal(code, 0, `child failed: ${stderr}`);
    // The host does JSON.parse(stdout.trim()) over the WHOLE stream, so a
    // single stray console.log anywhere in the worker would break every call.
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.__result.isReset, false);
    assert.deepEqual(
      parsed.__result.messages.map((m) => m.id),
      ['new@x'],
    );
    assert.equal(parsed.__result.messages[0].subject, 'café');
  } finally {
    await server.close();
  }
});

test('a failure surfaces through the host error channel, leaving stdout empty', async () => {
  const server = await startFakeImapServer({ messages: [] });
  try {
    const script = fs.readFileSync(HOST_SCRIPT_PATH, 'utf8');
    const { code, stdout, stderr } = await runLikeHost(script, [
      {
        op: 'test',
        conn: {
          host: '127.0.0.1',
          port: server.port,
          security: 'implicit-tls',
          username: 'me@example.com',
          password: 'wrong-password',
          folder: 'INBOX',
          allowSelfSigned: true,
        },
      },
    ]);

    assert.equal(code, 1);
    assert.equal(stdout.trim(), '', 'nothing must reach the result channel on failure');
    assert.match(
      JSON.parse(stderr.trim()).__error,
      /AUTHENTICATIONFAILED|bad credentials/,
    );
  } finally {
    await server.close();
  }
});
