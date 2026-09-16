import type {
  ImapMessage,
  MarkSeenResult,
  MessageBodyResult,
  MessagesResult,
  PollResult,
  TestResult,
  WorkerRequest,
} from '../shared/types';
import { parseBodyStructure, selectAttachments, selectTextPart } from './body-structure';
import { renderBodyText } from './body-text';
import { ImapClient } from './imap-client';
import { buildUidSet, FetchRecord, parseInternalDateMs } from './imap-parse';
import { quoteImapString } from './mailbox-name';
import { firstHeader, headerText, normalizeMessageId, parseHeaderBlock } from './mime';

/**
 * Wall-clock budget for one invocation. Stays under the manifest's
 * `nodeScriptConfig.timeout` so we fail with our own message rather than being
 * SIGTERMed mid-command by the host.
 */
const DEADLINE_MS = 20_000;

/** Upper bound on UIDs touched by a single mark-as-read call. */
const MAX_MARK_SEEN = 200;
/** Upper bound on Message-ID lookups per call (one SEARCH each). */
const MAX_LOOKUPS = 25;
/**
 * Checked against BODYSTRUCTURE's reported size *before* fetching, so an
 * oversized text part is skipped instead of tripping the client's 1MB literal
 * guard — which destroys the whole connection, not just this one call.
 */
const MAX_BODY_FETCH_BYTES = 200 * 1024;
/** Attachments are listed from BODYSTRUCTURE only; content is never fetched. */
const MAX_ATTACHMENTS_LISTED = 20;

const toMessage = (record: FetchRecord, uidValidity: number): ImapMessage => {
  const headers = parseHeaderBlock(record.header);
  const messageId = normalizeMessageId(firstHeader(headers, 'message-id'));
  const dateStr = headerText(firstHeader(headers, 'date'), 120);
  const internalMs = parseInternalDateMs(record.internalDate);
  const headerMs = dateStr ? Date.parse(dateStr) : Number.NaN;

  return {
    // Message-ID survives a move between folders; the UID pair does not, so it
    // is only the fallback for the (rare) message that ships without one.
    id: messageId ?? `${uidValidity}:${record.uid}`,
    uid: record.uid,
    uidValidity,
    subject: headerText(firstHeader(headers, 'subject'), 300) || '(no subject)',
    from: headerText(firstHeader(headers, 'from'), 200),
    to: headerText(firstHeader(headers, 'to'), 200),
    dateStr,
    receivedAt: internalMs ?? (Number.isFinite(headerMs) ? headerMs : 0),
  };
};

const fetchMessages = async (
  client: ImapClient,
  uids: number[],
  uidValidity: number,
): Promise<ImapMessage[]> => {
  if (uids.length === 0) {
    return [];
  }
  const wanted = new Set(uids);
  const records = await client.uidFetchHeaders(buildUidSet(uids));
  return records
    .filter((record) => wanted.has(record.uid))
    .map((record) => toMessage(record, uidValidity))
    .sort((a, b) => a.uid - b.uid);
};

/** `UID SEARCH` with a UTF-8 charset only when the term actually needs one. */
const searchText = (term: string): string => {
  const quoted = quoteImapString(term);
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]*$/.test(term) ? `TEXT ${quoted}` : `CHARSET UTF-8 TEXT ${quoted}`;
};

const poll = async (
  client: ImapClient,
  req: Extract<WorkerRequest, { op: 'poll' }>,
): Promise<PollResult> => {
  const status = await client.openMailbox(req.conn.folder);

  // No watermark, or the mailbox was recreated under us (UIDVALIDITY change):
  // the UIDs we remember mean nothing now. Import nothing and let the caller
  // re-anchor, rather than replaying a mailbox as a task list.
  if (
    req.sinceUid == null ||
    req.uidValidity == null ||
    req.uidValidity !== status.uidValidity
  ) {
    // UIDNEXT is optional in an EXAMINE response; a missing one must not be
    // read as "this mailbox starts at zero", which would import everything.
    const anchorUid = status.uidNext > 0 ? status.uidNext - 1 : await client.highestUid();
    return { status, messages: [], isReset: true, anchorUid };
  }

  const found = await client.uidSearch(`UID ${req.sinceUid + 1}:*`);
  // `n:*` is a range whose endpoints get swapped when the highest UID is below
  // `n`, so a quiet mailbox answers with its newest message every time. Filter.
  const uids = found
    .filter((uid) => uid > req.sinceUid!)
    .sort((a, b) => a - b)
    .slice(0, req.maxMessages);

  return {
    status,
    messages: await fetchMessages(client, uids, status.uidValidity),
    isReset: false,
    anchorUid: req.sinceUid,
  };
};

const fetchWindow = async (
  client: ImapClient,
  req: Extract<WorkerRequest, { op: 'window' }>,
): Promise<MessagesResult> => {
  const status = await client.openMailbox(req.conn.folder);
  const found = await client.uidSearch(`UID ${Math.max(1, req.sinceUid)}:*`);
  const uids = found.sort((a, b) => a - b).slice(-req.maxMessages);
  return { status, messages: await fetchMessages(client, uids, status.uidValidity) };
};

const search = async (
  client: ImapClient,
  req: Extract<WorkerRequest, { op: 'search' }>,
): Promise<MessagesResult> => {
  const status = await client.openMailbox(req.conn.folder);
  const found = await client.uidSearch(searchText(req.term));
  // Newest matches first is what a search box wants.
  const uids = found.sort((a, b) => a - b).slice(-req.maxMessages);
  const messages = await fetchMessages(client, uids, status.uidValidity);
  return { status, messages: messages.reverse() };
};

const lookup = async (
  client: ImapClient,
  req: Extract<WorkerRequest, { op: 'lookup' }>,
): Promise<MessagesResult> => {
  const status = await client.openMailbox(req.conn.folder);
  const uids: number[] = [];
  for (const messageId of req.messageIds.slice(0, MAX_LOOKUPS)) {
    const found = await client.uidSearch(
      `HEADER Message-ID ${quoteImapString(`<${messageId}>`)}`,
    );
    uids.push(...found);
  }
  return { status, messages: await fetchMessages(client, uids, status.uidValidity) };
};

const markSeen = async (
  client: ImapClient,
  req: Extract<WorkerRequest, { op: 'markSeen' }>,
): Promise<MarkSeenResult> => {
  const uids = req.uids
    .filter((uid) => Number.isInteger(uid) && uid > 0)
    .slice(0, MAX_MARK_SEEN);
  if (uids.length === 0) {
    return { markedUids: [], skippedUids: [] };
  }

  // SELECT rather than EXAMINE: this is the one path allowed to write.
  const status = await client.openMailbox(req.conn.folder, true);

  // UIDs are only meaningful within the UIDVALIDITY they were read under. If
  // the mailbox was recreated, the same numbers now address *different*
  // messages — flagging them would touch mail the user never imported.
  if (status.uidValidity !== req.uidValidity) {
    return { markedUids: [], skippedUids: uids };
  }

  await client.uidMarkSeen(buildUidSet(uids));
  return { markedUids: uids, skippedUids: [] };
};

const body = async (
  client: ImapClient,
  req: Extract<WorkerRequest, { op: 'body' }>,
): Promise<MessageBodyResult> => {
  const status = await client.openMailbox(req.conn.folder);
  const structureLine = await client.uidFetchBodyStructure(req.uid);
  if (!structureLine) {
    return { status, bodyTruncated: false, attachments: [] };
  }

  const parts = parseBodyStructure(structureLine.text, structureLine.literals);
  const textPart = selectTextPart(parts);
  const attachments = selectAttachments(
    parts,
    textPart?.partNumber ?? null,
    MAX_ATTACHMENTS_LISTED,
  );

  if (!textPart || textPart.size > MAX_BODY_FETCH_BYTES) {
    // No usable text part, or it's too large to be worth fetching — report
    // what we know (attachments came for free from BODYSTRUCTURE) rather
    // than failing the whole call.
    return { status, bodyTruncated: !!textPart, attachments };
  }

  const raw = await client.uidFetchBodyPart(req.uid, textPart.partNumber);
  if (raw == null) {
    return { status, bodyTruncated: false, attachments };
  }
  const { text, truncated } = renderBodyText(
    raw,
    textPart.encoding,
    textPart.charset,
    textPart.subtype === 'HTML',
  );
  return { status, bodyText: text, bodyTruncated: truncated, attachments };
};

/**
 * Single entry point. The host executes this module's source inside a spawned
 * Node process and uses the return value as the script result, so nothing here
 * may write to stdout — that channel carries the JSON result.
 */
export const run = async (req: WorkerRequest): Promise<unknown> => {
  const deadlineAt = Date.now() + DEADLINE_MS;
  const client = await ImapClient.connect(req.conn, deadlineAt);
  try {
    await client.login();
    switch (req.op) {
      case 'test': {
        const status = await client.openMailbox(req.conn.folder);
        return { status, capabilities: client.getCapabilities() } satisfies TestResult;
      }
      case 'poll':
        return await poll(client, req);
      case 'window':
        return await fetchWindow(client, req);
      case 'search':
        return await search(client, req);
      case 'lookup':
        return await lookup(client, req);
      case 'markSeen':
        return await markSeen(client, req);
      case 'body':
        return await body(client, req);
      default: {
        const unknown = req as { op: string };
        throw new Error(`Unknown operation "${unknown.op}"`);
      }
    }
  } finally {
    await client.close();
  }
};
