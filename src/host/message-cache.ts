import type { ImapMessage } from '../shared/types';

export interface MessageLocation {
  uid: number;
  uidValidity: number;
  /** Which account+folder the message was read from. */
  source: string;
}

/**
 * Short-lived store of messages already pulled from the server.
 *
 * It exists because the host refreshes issue data one task at a time
 * (`PluginIssueProviderAdapterService.getFreshDataForIssueTasks` loops and
 * awaits `getById` per task). Without a cache that is one spawned Node process
 * and one IMAP login *per mail task per poll round*; with it, the first miss
 * pulls a whole window and every other task in the round is served from memory.
 *
 * It doubles as the UID index for the mark-as-read path, which is why entries
 * remember which account they came from: flagging a UID against the wrong
 * mailbox would touch a message the user never imported.
 */
export class MessageCache {
  private readonly entries = new Map<
    string,
    { message: ImapMessage; source: string; expiresAt: number }
  >();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  put(messages: readonly ImapMessage[], source: string): void {
    const expiresAt = this.now() + this.ttlMs;
    for (const message of messages) {
      // Re-insert so the Map's insertion order doubles as an LRU queue.
      this.entries.delete(message.id);
      this.entries.set(message.id, { message, source, expiresAt });
    }
    this.evictOverflow();
  }

  get(id: string): ImapMessage | null {
    const entry = this.entries.get(id);
    if (!entry) {
      return null;
    }
    // Expired entries are reported as absent but NOT dropped: `locate` still
    // needs the UID to flag the message as read, which can happen long after
    // the content has gone stale. The size cap is what bounds the map.
    return entry.expiresAt <= this.now() ? null : entry.message;
  }

  /**
   * UID lookup for the mark-as-read path. Deliberately ignores the TTL: a UID
   * stays valid for as long as its UIDVALIDITY does, and the worker re-checks
   * that before it writes anything.
   */
  locate(id: string): MessageLocation | null {
    const entry = this.entries.get(id);
    if (!entry) {
      return null;
    }
    return {
      uid: entry.message.uid,
      uidValidity: entry.message.uidValidity,
      source: entry.source,
    };
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        return;
      }
      this.entries.delete(oldest.value);
    }
  }
}
