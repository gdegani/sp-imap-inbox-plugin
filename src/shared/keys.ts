import type { ImapConnectionCfg } from './types';

/** The parts of a connection that identify an account across config edits. */
export interface AccountIdentity {
  host: string;
  port: number;
  username: string;
}

export const normalizeHost = (host: string): string => host.trim().toLowerCase();

/**
 * Secret-store key for an account's password.
 *
 * Provider callbacks receive only `pluginConfig` — the host passes no
 * issueProviderId — so the connection tuple is the only stable per-instance
 * handle we have. Keep it in sync with the config UI, which derives the same
 * key from what the user types.
 */
export const secretKeyFor = (a: AccountIdentity): string =>
  `imap-pw:${normalizeHost(a.host)}:${a.port}:${a.username.trim()}`;

/**
 * Persistence key for a watermark. Includes the folder because the watermark
 * is per-mailbox, and is length-capped well under the host's 256-char limit.
 */
export const watermarkKeyFor = (a: AccountIdentity, folder: string): string => {
  const raw = `wm:${normalizeHost(a.host)}:${a.port}:${a.username.trim()}:${folder}`;
  return raw.length <= 200 ? raw : `${raw.slice(0, 180)}~${hashSuffix(raw)}`;
};

/** Stable, non-cryptographic suffix so truncated keys stay distinct. */
const hashSuffix = (input: string): string => {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
};

/** Human label used in the credentials UI and in account listings. */
export const accountLabel = (a: AccountIdentity): string =>
  `${a.username.trim()} @ ${normalizeHost(a.host)}`;
