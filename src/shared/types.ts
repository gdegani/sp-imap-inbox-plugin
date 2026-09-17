/** Contracts shared between the host-side plugin code and the Node IMAP worker. */

export type ImapSecurity = 'implicit-tls' | 'starttls';

/** Everything the worker needs to reach the mailbox. Carries the password. */
export interface ImapConnectionCfg {
  host: string;
  port: number;
  security: ImapSecurity;
  username: string;
  password: string;
  folder: string;
  allowSelfSigned: boolean;
}

export interface MailboxStatus {
  uidValidity: number;
  uidNext: number;
  exists: number;
}

/**
 * One message, reduced to what a task needs. Deliberately header-only: bodies
 * are never fetched (see README "Scope").
 */
export interface ImapMessage {
  /** Stable identity: normalized Message-ID, else `${uidValidity}:${uid}`. */
  id: string;
  uid: number;
  uidValidity: number;
  subject: string;
  from: string;
  to: string;
  dateStr: string;
  /** INTERNALDATE in ms — immutable, so it never triggers a task update. */
  receivedAt: number;
}

export type WorkerRequest =
  | { op: 'test'; conn: ImapConnectionCfg }
  | {
      op: 'poll';
      conn: ImapConnectionCfg;
      /** null = first run: adopt the watermark and import nothing. */
      sinceUid: number | null;
      /** null = no watermark yet. A mismatch forces a reset. */
      uidValidity: number | null;
      maxMessages: number;
    }
  | { op: 'search'; conn: ImapConnectionCfg; term: string; maxMessages: number }
  | { op: 'window'; conn: ImapConnectionCfg; sinceUid: number; maxMessages: number }
  | { op: 'lookup'; conn: ImapConnectionCfg; messageIds: string[] }
  | {
      op: 'markSeen';
      conn: ImapConnectionCfg;
      /** Guard: refuse to STORE if the mailbox was recreated under us. */
      uidValidity: number;
      uids: number[];
    }
  | { op: 'body'; conn: ImapConnectionCfg; uid: number }
  | {
      op: 'attachments';
      conn: ImapConnectionCfg;
      uids: number[];
      /** Absolute local directory to save attachment content into; `~` is expanded. */
      saveDir: string;
    };

export interface TestResult {
  status: MailboxStatus;
  /** Server-advertised capabilities, upper-cased. For the config UI. */
  capabilities: string[];
}

export interface PollResult {
  status: MailboxStatus;
  messages: ImapMessage[];
  /**
   * True when the watermark could not be trusted (first run, or UIDVALIDITY
   * changed). `messages` is empty and the caller adopts `anchorUid`.
   */
  isReset: boolean;
  /**
   * The UID to treat as "already seen" when re-anchoring. Resolved by the
   * worker, because UIDNEXT is optional in a SELECT/EXAMINE response and a
   * missing one must not be read as "the mailbox starts at zero".
   */
  anchorUid: number;
}

export interface MessagesResult {
  status: MailboxStatus;
  messages: ImapMessage[];
}

export interface MarkSeenResult {
  markedUids: number[];
  /** Non-empty only when UIDVALIDITY no longer matches; nothing was written. */
  skippedUids: number[];
}

/**
 * Body text is plain-only by design (HTML is stripped, never rendered) — see
 * README "Scope". Attachments are listed by name/size straight off
 * BODYSTRUCTURE; file content is never fetched.
 */
export interface MessageBodyResult {
  status: MailboxStatus;
  /** Absent when the message has no text part, or it exceeded the size cap. */
  bodyText?: string;
  /** True when the text part existed but was skipped (too large) or cut short. */
  bodyTruncated: boolean;
  attachments: { filename: string; size: number }[];
}

export interface SavedAttachment {
  /** Filename as declared on the message (decoded, not filesystem-safe). */
  filename: string;
  size: number;
  /** Absolute path on disk — filesystem-safe name, may differ from `filename`. */
  path: string;
}

export type SkippedAttachmentReason =
  | 'too-large'
  | 'unsupported-encoding'
  | 'budget-exceeded'
  | 'time-budget'
  | 'write-failed';

export interface SkippedAttachment {
  filename: string;
  size: number;
  reason: SkippedAttachmentReason;
}

export interface AttachmentFetchResult {
  saved: SavedAttachment[];
  skipped: SkippedAttachment[];
}

/** Keyed by UID, stringified — JSON object keys are always strings. */
export interface AttachmentsResult {
  status: MailboxStatus;
  byUid: Record<string, AttachmentFetchResult>;
}
