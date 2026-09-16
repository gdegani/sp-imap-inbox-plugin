# IMAP Inbox

A [Super Productivity](https://github.com/super-productivity/super-productivity)
plugin. Watches one IMAP folder; every message that arrives after setup
becomes one task. It flags a message `\Seen` when its task is created,
otherwise it leaves the mailbox untouched. **Desktop only** (it needs
`nodeExecution`, which the web app cannot grant).

This plugin is distributed independently of the main app — it is not
bundled, and installing it means trusting this repo's code the same way you'd
trust any third-party plugin.

## Install

1. Download `plugin.zip` from the
   [latest release](../../releases/latest).
2. In Super Productivity: **Settings → Plugins → Choose Plugin File**, select
   the zip, then enable it.
3. It requests `nodeExecution` to speak raw IMAP over TLS. The app will show
   a native **"unverified third-party plugin — full machine access"**
   consent dialog the first time it needs it — this is expected, not a bug:
   uploaded plugins are never verified against the app's build, unlike the
   handful of providers bundled with the app itself. Only allow it if you
   trust this source. See the app's
   [plugin trust model](https://github.com/super-productivity/super-productivity/blob/master/docs/wiki/2.21-Manage-Plugins.md)
   for what that dialog means and how consent is scoped.
4. Configure the connection (host, port, security, username, folder) and set
   your password/app-password when prompted. Point it at a folder your mail
   client already files "things to act on" into — the plugin has no filter
   language of its own by design (see Scope below).
5. On the issue provider itself (not this plugin's own config screen), the
   host app requires three settings before it will poll automatically:
   **Auto import to backlog**, a **default project**, and polling mode
   **Always** (if you want it to run without that project being open). The
   manifest can only pre-select the first of these.

## Scope

- **Reads:** message headers only (`Message-ID`, `Subject`, `From`, `To`,
  `Date`) via `BODY.PEEK`, from one folder of one account per provider
  instance.
- **Writes:** exactly one thing — `\Seen` on a message that became a task.
  No deletes, no moves, no other flags. Polling opens the mailbox with
  `EXAMINE` (read-only), so it cannot change anything even by accident; only
  the mark-as-read path uses `SELECT`.
- **Does not do:** bodies, attachments, IDLE/push, OAuth, multiple folders,
  mailbox listing, sending, or any filtering beyond the choice of folder. A
  mail-client rule that files actionable mail into a dedicated folder, which
  this plugin then watches, beats any in-app filtering language — so that's
  the intended workflow rather than a missing feature.

## How it hangs together

```text
plugin.js (app renderer)                      spawned Node process
┌────────────────────────────┐                ┌──────────────────────┐
│ registerIssueProvider      │  executeNode   │ worker (CJS bundle,  │
│  getNewIssuesForBacklog ───┼───Script──────►│ embedded as a string)│──TLS──► IMAP
│  getById (cached)          │                │  poll/search/lookup  │
│ taskCreated hook ──────────┼───markSeen────►│  markSeen            │
└────────────────────────────┘                └──────────────────────┘
```

- **`src/worker/`** — the IMAP client. Pure protocol code; no plugin API.
  `index.ts` is the entry point (`run(request)`); the build bundles it twice
  (see below).
- **`src/host/`** — watermark maths and the message cache. Pure, unit-tested.
- **`src/plugin.ts`** — everything that touches `PluginAPI`.
- **`src/ui/index.html`** — the credentials view, reached from the app menu.

### Why the worker is a string

`PluginAPI.request` speaks HTTP; IMAP needs a raw TLS socket. The only route
to one is `executeNodeScript`, which the Electron main process runs in a
spawned Node process. Three host constraints shape the build (all enforced
by the app's `electron/plugin-node-executor.ts`):

1. A script is only spawned — rather than run in a `vm` where just `fs`,
   `path` and `os` can be required — if it matches the host's "dangerous
   pattern". A literal `require("tls")` satisfies it, which is why the
   embedded bundle is **CommonJS**: esbuild's IIFE output hides requires
   behind a helper.
2. The script is passed as an argv entry, and Node rejects argv containing a
   NUL byte. esbuild's printer emits escapes like `` as raw control
   characters, so `scripts/build.js` re-escapes them and fails the build if
   any survive.
3. Scripts over 100 KB are rejected. The build caps the bundle at 80,000
   chars to leave room for the JSON arguments the host inlines beside it.

Each call is a fresh process, so there is no persistent connection and
therefore no IMAP IDLE. New mail appears on the next poll (default interval
5 minutes, configured on the issue-provider host side).

### Build outputs

| Path                              | What it is                                                          |
| ---------------------------------- | -------------------------------------------------------------------- |
| `dist/`                           | what ships: `plugin.js`, `manifest.json`, `index.html`, `icon.svg`, `plugin.zip` |
| `dist-worker/imap-worker.cjs`      | unminified worker, `require`d by the integration tests               |
| `dist-worker/host-script.js`       | the exact string handed to `executeNodeScript`                       |
| `src/generated/worker-source.ts`   | that same string, as a TS module for `plugin.ts`                     |

`dist/`, `dist-worker/` and `src/generated/` are build artifacts and are
gitignored.

## Protocol subset (worker)

One command per invocation: `{ op: 'poll' | 'fetch' | 'search' | 'test', ... }`.

- Connect: `tls.connect` (implicit TLS, 993) or `net.connect` + `STARTTLS`
  (143). `rejectUnauthorized: true` by default; an "allow self-signed
  certificate" option exists for Proton Bridge / self-hosted Dovecot.
- `CAPABILITY`, then `LOGIN` or `AUTHENTICATE PLAIN`. No SASL beyond PLAIN.
- `EXAMINE` (not `SELECT`) for polling — a read-only mailbox open, so nothing
  can set `\Seen` by accident. Records `UIDVALIDITY`/`UIDNEXT` from the
  untagged responses.
- `UID SEARCH UID <watermark+1>:*` for polling; `UID SEARCH TEXT "<term>"`
  for `searchIssues`; `UID SEARCH HEADER Message-ID "<id>"` for `getById`
  misses.
- `UID FETCH <set> (UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID SUBJECT FROM TO DATE)])`
  — `BODY.PEEK` is the second `\Seen` guard.
- `UID STORE <set> +FLAGS.SILENT (\Seen)` — the only write, under `SELECT`
  (read-write). Every other operation opens the mailbox with `EXAMINE`.
- `LOGOUT`, then socket destroy on every path including errors.

Hard caps per poll: 50 messages, 512 chars per decoded header field, 30s
wall clock. Bodies are never fetched — subject, sender and date are the
task; the mail client is where the body is read.

## What counts as "new"

`{ uidValidity, lastUid }` per account+folder, persisted via
`persistDataSynced` under a key derived from `host|port|username|folder`.

- **First run** stores `UIDNEXT - 1` and imports **nothing**. Pointing the
  plugin at an existing inbox must not spawn thousands of tasks.
- **UIDVALIDITY changed** (mailbox recreated) → reset the watermark to the
  current `UIDNEXT - 1` and import nothing. Never re-scan.
- `issueId` is the `Message-ID` (angle brackets stripped), falling back to
  `${uidValidity}:${uid}` when absent. The host filters results against
  every existing task and archived task for the provider, so a
  completed-and-archived mail task never comes back.
- **Multi-device duplicates:** two desktops polling the same folder can
  import the same message inside one sync round-trip. Plugin providers have
  no deterministic id generation for this today, so the duplicate window is
  accepted; if it bites in practice, fix it host-side in
  `PluginIssueProviderAdapterService` (it affects every `pollingMode:
  'always'` plugin provider equally), not here.

## Marking imported mail as read

A message is flagged when its **task is created** — not when it is offered
to the host, which is a different moment (the host filters candidates
against existing tasks and the archive before creating anything).

- Trigger: the `taskCreated` hook, filtered to
  `issueType === 'plugin:imap-inbox'`. That hook runs off local actions
  only, so only the device that did the import flags the message; a task
  arriving through sync does not re-flag it.
- Flagging is debounced ~1.5s and grouped by account and UIDVALIDITY, so an
  import of 30 messages is one connection. A UID whose mailbox was recreated
  is skipped, never flagged.
- **`\Seen` is written, never read.** "New" stays defined by the UID
  watermark, so reading a message in your own mail client does not suppress
  its task.

## Credentials

- Password/app-password → `PluginAPI.setSecret(key, value)` with
  `key = imap-pw:${host}:${port}:${username}`. Local-only, never
  synced/exported, purged on uninstall.
- **Not** a `configFields` entry — those values live in synced
  issue-provider state (and land in exports/backups). The connection tuple
  is what scopes the secret, since provider callbacks receive only
  `pluginConfig`, never an instance id.
- `setSecret`/`getSecret` aren't available to iframe code, so `index.html`
  posts a message to `plugin.js`, which calls `setSecret` host-side. A
  stored secret is never echoed back to the UI — it only ever shows
  "set / not set" plus replace/clear.
- If a poll finds no stored secret, the password dialog opens once per app
  session and then stays silent.

## Known limitations / risks

- **The password is visible in the child process's argv.** `executeNodeScript`
  inlines arguments into the spawned command's script text, and there's no
  side channel to hand a secret to the worker. Same-user processes can read
  it. Use an app-password, not your primary password, and keep this in mind
  on shared machines.
- **No IDLE.** "New mail" really means "found on the next poll" (default 5
  minutes).
- **Hand-rolled protocol surface.** This is a minimal client written to stay
  under the 100 KB `executeNodeScript` script-size limit — no existing IMAP
  library fits. It's read-only, headers-only, one-folder scope, with a
  fake-server integration suite, but a hand-rolled client against
  real-world servers is still the maintenance cost of this approach.
- Corporate CA bundles / HTTP(S) proxies aren't supported — the spawned
  process's environment is stripped to `{NODE_ENV, ELECTRON_RUN_AS_NODE}`.

## Tests

```bash
npm test              # build, then unit + integration
npm run test:unit     # vitest, pure modules only
npm run test:integration
```

- **Unit (vitest, `*.spec.ts`)** — RFC 2047 decoding, header unfolding, IMAP
  response parsing, modified UTF-7, watermark transitions, the message
  cache.
- **Integration (`node --test`, `test/*.test.cjs`)** — the real worker
  bundle against `test/fake-imap-server.cjs`, an in-process server that
  speaks literals, UIDVALIDITY/UIDNEXT, TLS and STARTTLS. This is where
  protocol behaviour is pinned: first-run anchoring, the `n:*`
  range-reversal quirk, UIDVALIDITY changes, that polling never writes a
  flag, and that a stale UIDVALIDITY blocks a mark-as-read.
- **`test/host-script.test.cjs`** spawns the shipped script the way the
  Electron host does, including the stripped environment, and asserts
  stdout carries nothing but the JSON result. Anything the worker printed
  would corrupt every call, since the host does `JSON.parse(stdout.trim())`
  over the whole stream.

`test/fixtures/` holds a self-signed certificate for the fake server — see
the README there.

## Gotchas worth knowing before you change something

- **Never write to stdout from worker code.** That stream is the result
  channel.
- **`lastUpdated` must stay stable.** It is the message's INTERNALDATE, and
  the host only rewrites a task when the issue's `lastUpdated` is newer than
  the task's. A changing value would let mail overwrite edited task titles.
- **Never put `state` on a result.** The host reads
  `closed`/`done`/`completed`/`resolved` as "this task is done".
- **Never put `start` or `dueWithTime` on a result.** Both schedule the
  task.
- **The watermark advances only to the highest UID actually handed over**,
  so a capped batch leaves the rest for the next poll instead of skipping
  it.
- **The cache is also the UID index** for marking as read, which is why
  expired entries are reported as absent but not dropped.

## Development

```bash
npm ci
npm run build      # produces dist/
npm run package    # build + zip dist/ into dist/plugin.zip for upload
npm test
npm run typecheck
```

For the general plugin API, manifest format, and security model, see Super
Productivity's
[plugin development guide](https://github.com/super-productivity/super-productivity/blob/master/docs/plugin-development.md).
