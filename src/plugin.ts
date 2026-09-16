import type {
  IssueProviderPluginDefinition,
  PluginFormField,
  PluginIssue,
  PluginIssueField,
  PluginSearchResult,
} from './types/issue-provider-types';
import { WORKER_SCRIPT } from './generated/worker-source';
import { MessageCache } from './host/message-cache';
import { describeNodeScriptError } from './host/node-script-error';
import {
  isWatermarkUnchanged,
  nextWatermark,
  parseWatermark,
  serializeWatermark,
  type WatermarkState,
} from './host/watermark';
import { accountLabel, secretKeyFor, watermarkKeyFor } from './shared/keys';
import type {
  ImapConnectionCfg,
  ImapMessage,
  ImapSecurity,
  MarkSeenResult,
  MessagesResult,
  PollResult,
  TestResult,
  WorkerRequest,
} from './shared/types';

interface NodeScriptResult {
  success: boolean;
  result?: unknown;
  error?: string | { message?: string };
}

declare const PluginAPI: {
  registerIssueProvider(definition: IssueProviderPluginDefinition): void;
  registerHook(hook: string, fn: (payload: unknown) => void | Promise<void>): void;
  registerMenuEntry(cfg: { label: string; icon?: string; onClick: () => void }): void;
  registerConfigHandler(handler: () => void): void;
  showIndexHtmlAsView(): void;
  onMessage?(handler: (message: unknown) => Promise<unknown> | unknown): void;
  onReady?(fn: () => void | Promise<void>): void;
  onUnload?(fn: () => void | Promise<void>): void;
  executeNodeScript?(request: {
    script: string;
    args?: unknown[];
    timeout?: number;
  }): Promise<NodeScriptResult>;
  setSecret(key: string, value: string): Promise<void>;
  getSecret(key: string): Promise<string | null>;
  deleteSecret(key: string): Promise<void>;
  persistDataSynced(dataStr: string, key?: string): Promise<void>;
  loadSyncedData(key?: string): Promise<string | null>;
  showSnack(cfg: { msg: string; type?: 'SUCCESS' | 'ERROR' | 'WARNING' | 'INFO' }): void;
  getAllProjects(): Promise<{ id: string; title: string }[]>;
  addTask(taskData: { title: string; projectId?: string; notes?: string }): Promise<string>;
  log: {
    log: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    err: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
};

// --- constants ---------------------------------------------------------------

const NODE_TIMEOUT_MS = 25_000;
/** Cap per poll; the remainder arrives on the next tick, never skipped. */
const MAX_MESSAGES_PER_POLL = 50;
const MAX_SEARCH_RESULTS = 25;
/** Survives one poll round of per-task `getById` calls without re-connecting. */
const CACHE_TTL_MS = 120_000;
const CACHE_MAX_ENTRIES = 500;
/** How far below the watermark a cache refill reaches back. */
const REFILL_LOOKBACK = 200;
const REFILL_MAX_MESSAGES = 100;
/** Collapses a burst of imports into a single mark-as-read connection. */
const MARK_SEEN_DEBOUNCE_MS = 1500;
const MAX_REMEMBERED_ACCOUNTS = 10;
const ACCOUNTS_KEY = 'accounts';

const DESKTOP_ONLY_MSG =
  'IMAP Inbox runs only in the desktop app — it needs a direct connection to the mail server.';

// --- module state ------------------------------------------------------------

const cache = new MessageCache(CACHE_TTL_MS, CACHE_MAX_ENTRIES);
/** Password-free connection templates, keyed by {@link sourceKey}. */
const sources = new Map<string, Omit<ImapConnectionCfg, 'password'>>();
const pendingSeenIds = new Set<string>();
let markSeenTimer: ReturnType<typeof setTimeout> | null = null;
let refillInFlight: Promise<void> | null = null;
/** One nag per app session, not one per poll. */
const warnedAboutMissingPassword = new Set<string>();

// --- config ------------------------------------------------------------------

interface ImapProviderConfig {
  host?: string;
  port?: string | number;
  security?: ImapSecurity;
  username?: string;
  folder?: string;
  allowSelfSigned?: boolean;
}

class MissingPasswordError extends Error {
  constructor(public readonly label: string) {
    super(`No password stored for ${label}. Open IMAP Inbox from the menu to add it.`);
    this.name = 'MissingPasswordError';
  }
}

const defaultPort = (security: ImapSecurity): number =>
  security === 'starttls' ? 143 : 993;

const tryReadConfig = (
  config: Record<string, unknown>,
): Omit<ImapConnectionCfg, 'password'> | null => {
  const cfg = config as ImapProviderConfig;
  const host = (cfg.host ?? '').trim();
  const username = (cfg.username ?? '').trim();
  if (!host || !username) {
    return null;
  }
  const security: ImapSecurity =
    cfg.security === 'starttls' ? 'starttls' : 'implicit-tls';
  const parsedPort = Number(cfg.port);
  return {
    host: host.toLowerCase(),
    port:
      Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : defaultPort(security),
    security,
    username,
    folder: (cfg.folder ?? '').trim() || 'INBOX',
    allowSelfSigned: cfg.allowSelfSigned === true,
  };
};

const readConfig = (
  config: Record<string, unknown>,
): Omit<ImapConnectionCfg, 'password'> => {
  const parsed = tryReadConfig(config);
  if (!parsed) {
    throw new Error('IMAP Inbox is not configured yet — set the server and username.');
  }
  return parsed;
};

const sourceKey = (conn: Omit<ImapConnectionCfg, 'password'>): string =>
  `${conn.host}:${conn.port}:${conn.username}:${conn.folder}`;

const withPassword = async (
  base: Omit<ImapConnectionCfg, 'password'>,
): Promise<ImapConnectionCfg> => {
  const password = await PluginAPI.getSecret(secretKeyFor(base));
  if (!password) {
    throw new MissingPasswordError(accountLabel(base));
  }
  return { ...base, password };
};

/** Resolve a provider config into a ready-to-use connection, and remember it. */
const connectionFor = async (
  config: Record<string, unknown>,
): Promise<ImapConnectionCfg> => {
  const base = readConfig(config);
  sources.set(sourceKey(base), base);
  void rememberAccount(base);
  return withPassword(base);
};

// --- worker bridge -----------------------------------------------------------

const callWorker = async <T>(request: WorkerRequest): Promise<T> => {
  if (!PluginAPI.executeNodeScript) {
    throw new Error(DESKTOP_ONLY_MSG);
  }
  const res = await PluginAPI.executeNodeScript({
    script: WORKER_SCRIPT,
    args: [request],
    timeout: NODE_TIMEOUT_MS,
  });
  if (!res.success) {
    throw new Error(describeNodeScriptError(res.error));
  }
  return res.result as T;
};

// --- remembered accounts (non-secret, for the credentials UI) ----------------

interface RememberedAccount {
  host: string;
  port: number;
  username: string;
  folder: string;
  security: ImapSecurity;
  allowSelfSigned: boolean;
}

const loadAccounts = async (): Promise<RememberedAccount[]> => {
  try {
    const raw = await PluginAPI.loadSyncedData(ACCOUNTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as RememberedAccount[]) : [];
  } catch {
    return [];
  }
};

/**
 * Keep a list of the accounts we have actually polled, so the credentials UI
 * can offer them by name. The plugin cannot enumerate its own issue-provider
 * instances — callbacks receive only `pluginConfig` — so this is the only way
 * the UI learns what to ask a password for. Never contains a secret.
 */
const rememberAccount = async (
  conn: Omit<ImapConnectionCfg, 'password'>,
): Promise<void> => {
  try {
    const accounts = await loadAccounts();
    const entry: RememberedAccount = {
      host: conn.host,
      port: conn.port,
      username: conn.username,
      folder: conn.folder,
      security: conn.security,
      allowSelfSigned: conn.allowSelfSigned,
    };
    const keyOf = (a: RememberedAccount): string =>
      `${a.host}:${a.port}:${a.username}:${a.folder}`;
    const next = [...accounts.filter((a) => keyOf(a) !== sourceKey(conn)), entry]
      // Stable order, so an unchanged set always serializes identically.
      .sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
      .slice(0, MAX_REMEMBERED_ACCOUNTS);

    // Only write when something actually changed. This runs on every poll, and
    // persistDataSynced is synced state: an unconditional write would add an
    // op to the log every few minutes, forever, for no new information.
    const serialized = JSON.stringify(next);
    if (serialized === JSON.stringify(accounts)) {
      return;
    }
    await PluginAPI.persistDataSynced(serialized, ACCOUNTS_KEY);
  } catch (err) {
    PluginAPI.log.warn('[imap-inbox] could not remember account', err);
  }
};

// --- mapping -----------------------------------------------------------------

const toSearchResult = (message: ImapMessage, folder: string): PluginSearchResult => ({
  id: message.id,
  title: message.subject,
  from: message.from,
  to: message.to,
  dateStr: message.dateStr,
  folder,
  uid: message.uid,
  // INTERNALDATE never changes, so a refresh can never decide the "issue"
  // was updated and rewrite the task. Mail is a one-way import by design.
  lastUpdated: message.receivedAt,
  // Deliberately no `start` / `dueWithTime`: those would schedule the task.
  // Deliberately no `state`: the host reads closed/done/resolved as isDone.
});

const toIssue = (message: ImapMessage, folder: string): PluginIssue =>
  toSearchResult(message, folder) as PluginIssue;

// --- cache refill ------------------------------------------------------------

const refillCache = async (config: Record<string, unknown>): Promise<void> => {
  const base = readConfig(config);
  const key = watermarkKeyFor(base, base.folder);
  const watermark = parseWatermark(await PluginAPI.loadSyncedData(key));
  const conn = await withPassword(base);
  const result = await callWorker<MessagesResult>({
    op: 'window',
    conn,
    sinceUid: Math.max(1, (watermark?.lastUid ?? 1) - REFILL_LOOKBACK),
    maxMessages: REFILL_MAX_MESSAGES,
  });
  cache.put(result.messages, sourceKey(base));
};

/** One refill per burst: every `getById` miss in a poll round shares it. */
const refillCacheOnce = (config: Record<string, unknown>): Promise<void> => {
  if (!refillInFlight) {
    refillInFlight = refillCache(config).finally(() => {
      refillInFlight = null;
    });
  }
  return refillInFlight;
};

// --- mark as read ------------------------------------------------------------

const flushMarkSeen = async (): Promise<void> => {
  const ids = [...pendingSeenIds];
  pendingSeenIds.clear();
  if (ids.length === 0) {
    return;
  }

  // Group by account *and* UIDVALIDITY: a UID only means something inside the
  // mailbox instance it was read from.
  const groups = new Map<
    string,
    { source: string; uidValidity: number; uids: number[] }
  >();
  for (const id of ids) {
    const found = cache.locate(id);
    if (!found) {
      // The message left the cache before its task was created. It simply stays
      // unread; we never guess a UID.
      continue;
    }
    const groupKey = `${found.source}|${found.uidValidity}`;
    const group = groups.get(groupKey) ?? {
      source: found.source,
      uidValidity: found.uidValidity,
      uids: [],
    };
    group.uids.push(found.uid);
    groups.set(groupKey, group);
  }

  for (const group of groups.values()) {
    const base = sources.get(group.source);
    if (!base) {
      continue;
    }
    try {
      const conn = await withPassword(base);
      const res = await callWorker<MarkSeenResult>({
        op: 'markSeen',
        conn,
        uidValidity: group.uidValidity,
        uids: group.uids,
      });
      if (res.skippedUids.length) {
        PluginAPI.log.info(
          `[imap-inbox] skipped marking ${res.skippedUids.length} message(s) as read: mailbox was recreated`,
        );
      }
    } catch (err) {
      // Never surfaced to the user: the task exists, which is what they asked
      // for. A message that stays unread is a cosmetic problem in their client.
      PluginAPI.log.err('[imap-inbox] could not flag imported mail as read', err);
    }
  }
};

const queueMarkSeen = (issueId: string): void => {
  pendingSeenIds.add(issueId);
  if (markSeenTimer) {
    return;
  }
  markSeenTimer = setTimeout(() => {
    markSeenTimer = null;
    void flushMarkSeen();
  }, MARK_SEEN_DEBOUNCE_MS);
};

/** One warning per account per app session — a poll runs every few minutes. */
const notifyMissingPassword = (err: MissingPasswordError): void => {
  if (warnedAboutMissingPassword.has(err.label)) {
    return;
  }
  warnedAboutMissingPassword.add(err.label);
  PluginAPI.showSnack({ msg: err.message, type: 'WARNING' });
};

// --- issue provider ----------------------------------------------------------

const configFields: PluginFormField[] = [
  {
    key: 'host',
    type: 'input',
    label: 'IMAP server',
    description: 'For example imap.example.com',
    required: true,
  },
  {
    key: 'username',
    type: 'input',
    label: 'Username',
    required: true,
    description:
      'The password is NOT stored here — open "IMAP Inbox" from the menu to add it. It stays on this device and is never synced.',
  },
  {
    key: 'folder',
    type: 'input',
    label: 'Folder to watch',
    description:
      'Defaults to INBOX. Point this at a folder your mail rules file actionable mail into — the folder is the filter.',
  },
  {
    key: 'security',
    type: 'select',
    label: 'Connection security',
    options: [
      { label: 'TLS (port 993)', value: 'implicit-tls' },
      { label: 'STARTTLS (port 143)', value: 'starttls' },
    ],
  },
  {
    key: 'port',
    type: 'input',
    label: 'Port',
    description: 'Leave empty for 993 (TLS) or 143 (STARTTLS).',
    pattern: '^[0-9]*$',
    advanced: true,
  },
  {
    key: 'allowSelfSigned',
    type: 'checkbox',
    label: 'Accept a self-signed certificate',
    description:
      'Only for a server whose certificate you control, such as Proton Bridge or a self-hosted Dovecot.',
    advanced: true,
  },
];

const issueDisplay: PluginIssueField[] = [
  { field: 'from', label: 'From' },
  { field: 'to', label: 'To', hideEmpty: true },
  { field: 'dateStr', label: 'Date', hideEmpty: true },
  { field: 'folder', label: 'Folder', hideEmpty: true },
];

PluginAPI.registerIssueProvider({
  configFields,
  issueDisplay,

  // No HTTP is involved; the mailbox is reached through the Node worker.
  getHeaders: () => ({}),

  // IMAP has no addressable URL for a message. Returning '' lets the host fall
  // back to the issue's own (absent) url and render no link.
  getIssueLink: () => '',

  async testConnection(config: Record<string, unknown>): Promise<boolean> {
    const conn = await connectionFor(config);
    const res = await callWorker<TestResult>({ op: 'test', conn });
    const ok = res.status.uidValidity > 0;
    if (ok) {
      // The config dialog has no custom-button extension point, only fixed
      // field types — "Test connection" is the one action button the host
      // already renders there for every issue provider, so a mail preview
      // rides along on it instead of needing a UI this plugin can't add.
      await reportPreviewSnack(conn);
    }
    return ok;
  },

  async searchIssues(
    searchTerm: string,
    config: Record<string, unknown>,
  ): Promise<PluginSearchResult[]> {
    const term = searchTerm.trim();
    if (term.length < 2) {
      return [];
    }
    const base = readConfig(config);
    const conn = await connectionFor(config);
    const res = await callWorker<MessagesResult>({
      op: 'search',
      conn,
      term,
      maxMessages: MAX_SEARCH_RESULTS,
    });
    cache.put(res.messages, sourceKey(base));
    return res.messages.map((message) => toSearchResult(message, base.folder));
  },

  async getById(issueId: string, config: Record<string, unknown>): Promise<PluginIssue> {
    const base = readConfig(config);
    const cached = cache.get(issueId);
    if (cached) {
      return toIssue(cached, base.folder);
    }
    try {
      await refillCacheOnce(config);
    } catch (err) {
      PluginAPI.log.warn('[imap-inbox] could not refresh the message cache', err);
    }
    const found = cache.get(issueId);
    if (found) {
      return toIssue(found, base.folder);
    }
    // The message is gone from the watched folder (moved, deleted, archived by
    // the user). `lastUpdated: 0` is load-bearing: the host only applies issue
    // data when it is NEWER than the task's, so this placeholder can never
    // overwrite the task's title. It exists so the detail panel says something
    // honest instead of erroring on every refresh.
    return {
      id: issueId,
      title: 'Message is no longer in the watched folder',
      folder: base.folder,
      lastUpdated: 0,
    } as PluginIssue;
  },

  async getNewIssuesForBacklog(
    config: Record<string, unknown>,
  ): Promise<PluginSearchResult[]> {
    const base = tryReadConfig(config);
    if (!base) {
      // Half-configured provider: stay quiet rather than snacking every poll.
      return [];
    }
    const key = watermarkKeyFor(base, base.folder);
    const current = parseWatermark(await PluginAPI.loadSyncedData(key));

    let conn: ImapConnectionCfg;
    try {
      conn = await connectionFor(config);
    } catch (err) {
      if (err instanceof MissingPasswordError) {
        notifyMissingPassword(err);
        return [];
      }
      throw err;
    }

    const poll = await callWorker<PollResult>({
      op: 'poll',
      conn,
      sinceUid: current?.lastUid ?? null,
      uidValidity: current?.uidValidity ?? null,
      maxMessages: MAX_MESSAGES_PER_POLL,
    });

    const next = nextWatermark(current, poll, Date.now());
    if (!isWatermarkUnchanged(current, next)) {
      await PluginAPI.persistDataSynced(serializeWatermark(next), key);
    }
    if (poll.isReset) {
      // No folder name in the log: log history is exportable, and the folder is
      // the user's own data. The UID is enough to debug anchoring.
      PluginAPI.log.info(
        `[imap-inbox] anchored the watched folder at UID ${next.lastUid}; only later mail becomes a task`,
      );
      return [];
    }

    cache.put(poll.messages, sourceKey(base));
    return poll.messages.map((message) => toSearchResult(message, base.folder));
  },
});

// --- hooks -------------------------------------------------------------------

interface TaskCreatedPayload {
  task?: {
    issueId?: string | null;
    issueType?: string | null;
    issueProviderId?: string | null;
  };
}

const PROVIDER_KEY = 'plugin:imap-inbox';

PluginAPI.registerHook('taskCreated', (payload: unknown) => {
  const task = (payload as TaskCreatedPayload)?.task;
  if (!task?.issueId || task.issueType !== PROVIDER_KEY) {
    return;
  }
  // The hook runs off LOCAL_ACTIONS, so only the device that actually imported
  // the message flags it — a task arriving through sync never re-flags.
  queueMarkSeen(task.issueId);
});

// --- credentials UI bridge ---------------------------------------------------

interface UiAccount {
  host: string;
  port: number;
  username: string;
  folder: string;
  security: ImapSecurity;
  allowSelfSigned: boolean;
}

interface UiMessage {
  type: string;
  account?: UiAccount;
  password?: string;
  projectId?: string;
}

const asAccount = (account: UiAccount | undefined): UiAccount => {
  if (!account?.host?.trim() || !account?.username?.trim()) {
    throw new Error('Server and username are required');
  }
  const security: ImapSecurity =
    account.security === 'starttls' ? 'starttls' : 'implicit-tls';
  const port = Number(account.port);
  return {
    host: account.host.trim().toLowerCase(),
    username: account.username.trim(),
    port: Number.isInteger(port) && port > 0 ? port : defaultPort(security),
    folder: account.folder?.trim() || 'INBOX',
    security,
    allowSelfSigned: account.allowSelfSigned === true,
  };
};

const resolvePassword = async (
  account: UiAccount,
  typed: string | undefined,
): Promise<string> => {
  const password = typed || (await PluginAPI.getSecret(secretKeyFor(account)));
  if (!password) {
    throw new Error('No password stored for this account yet');
  }
  return password;
};

/**
 * Same watermark-gated poll `getNewIssuesForBacklog` runs, reused by the
 * manual "Check mailbox now" / "Import new mail now" buttons. Read-only by
 * itself — callers decide whether/how far to advance the watermark.
 */
const pollAccount = async (
  account: UiAccount,
  password: string,
): Promise<{ key: string; current: WatermarkState | null; poll: PollResult }> => {
  const key = watermarkKeyFor(account, account.folder);
  const current = parseWatermark(await PluginAPI.loadSyncedData(key));
  const poll = await callWorker<PollResult>({
    op: 'poll',
    conn: { ...account, password },
    sinceUid: current?.lastUid ?? null,
    uidValidity: current?.uidValidity ?? null,
    maxMessages: MAX_MESSAGES_PER_POLL,
  });
  return { key, current, poll };
};

/**
 * Read-only preview shown as a snack after a successful `testConnection`.
 * Never persists the watermark — this is a preview, not an import; the
 * automatic poll and "Import new mail now" are what actually move it.
 */
const reportPreviewSnack = async (conn: ImapConnectionCfg): Promise<void> => {
  try {
    const { poll } = await pollAccount(conn, conn.password);
    const msg = poll.isReset
      ? 'Connected. No baseline yet for this mailbox — mail from now on will show as new.'
      : poll.messages.length === 0
        ? 'Connected. No new mail since the last check.'
        : `Connected. ${poll.messages.length} new message(s) waiting to import.`;
    PluginAPI.showSnack({ msg, type: 'SUCCESS' });
  } catch (err) {
    PluginAPI.log.warn('[imap-inbox] could not preview new mail during test', err);
  }
};

PluginAPI.onMessage?.(async (raw: unknown) => {
  const message = raw as UiMessage;
  switch (message?.type) {
    case 'getState': {
      const accounts = await loadAccounts();
      const withFlags = await Promise.all(
        accounts.map(async (account) => ({
          ...account,
          label: accountLabel(account),
          hasPassword: !!(await PluginAPI.getSecret(secretKeyFor(account))),
        })),
      );
      return { isDesktop: !!PluginAPI.executeNodeScript, accounts: withFlags };
    }
    case 'setPassword': {
      const account = asAccount(message.account);
      if (!message.password) {
        throw new Error('Password must not be empty');
      }
      await PluginAPI.setSecret(secretKeyFor(account), message.password);
      warnedAboutMissingPassword.delete(accountLabel(account));
      await rememberAccount(account);
      return { ok: true };
    }
    case 'clearPassword': {
      const account = asAccount(message.account);
      await PluginAPI.deleteSecret(secretKeyFor(account));
      return { ok: true };
    }
    case 'testAccount': {
      const account = asAccount(message.account);
      const password = await resolvePassword(account, message.password);
      const res = await callWorker<TestResult>({
        op: 'test',
        conn: { ...account, password },
      });
      return {
        ok: true,
        folder: account.folder,
        messageCount: res.status.exists,
      };
    }
    case 'getProjects': {
      const projects = await PluginAPI.getAllProjects();
      return { projects: projects.map((p) => ({ id: p.id, title: p.title })) };
    }
    case 'previewNewMail': {
      const account = asAccount(message.account);
      const password = await resolvePassword(account, message.password);
      const { poll } = await pollAccount(account, password);
      if (poll.isReset) {
        return { isReset: true, messages: [] };
      }
      return {
        isReset: false,
        messages: poll.messages.map((m) => ({
          subject: m.subject,
          from: m.from,
          dateStr: m.dateStr,
        })),
      };
    }
    case 'importNewMailNow': {
      const account = asAccount(message.account);
      const projectId = message.projectId?.trim();
      if (!projectId) {
        throw new Error('Choose a project first');
      }
      const password = await resolvePassword(account, message.password);
      const { key, current, poll } = await pollAccount(account, password);

      if (poll.isReset) {
        await PluginAPI.persistDataSynced(
          serializeWatermark(nextWatermark(current, poll, Date.now())),
          key,
        );
        return { created: 0, isReset: true };
      }

      // Create tasks one at a time and track how many actually succeeded, so
      // a failure partway through never advances the watermark past mail
      // that has no task yet — a later check picks up exactly where this
      // one stopped instead of silently skipping it.
      let created = 0;
      try {
        for (const m of poll.messages) {
          await PluginAPI.addTask({
            title: m.subject,
            projectId,
            notes:
              `From: ${m.from}\nDate: ${m.dateStr}\n\n` +
              'Imported manually via "Import new mail now" in IMAP Inbox. ' +
              'Unlike an automatic import, this task is not linked back to the ' +
              'message and is not marked read automatically.',
          });
          created += 1;
        }
      } finally {
        if (created > 0) {
          const next = nextWatermark(
            current,
            { ...poll, messages: poll.messages.slice(0, created) },
            Date.now(),
          );
          if (!isWatermarkUnchanged(current, next)) {
            await PluginAPI.persistDataSynced(serializeWatermark(next), key);
          }
        }
      }
      return { created, isReset: false };
    }
    default:
      throw new Error(`Unknown message "${String(message?.type)}"`);
  }
});

// --- entry points ------------------------------------------------------------

const openCredentialsView = (): void => PluginAPI.showIndexHtmlAsView();

PluginAPI.registerMenuEntry({
  label: 'IMAP Inbox',
  icon: 'mail',
  onClick: openCredentialsView,
});
PluginAPI.registerConfigHandler(openCredentialsView);

PluginAPI.onUnload?.(() => {
  // plugin.js runs in the app's renderer, so our timers outlive the plugin
  // unless we clear them here.
  if (markSeenTimer) {
    clearTimeout(markSeenTimer);
    markSeenTimer = null;
  }
  pendingSeenIds.clear();
  sources.clear();
  cache.clear();
});
