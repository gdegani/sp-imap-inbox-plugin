import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_ATTACHMENT_FETCH_BYTES,
  resolveSaveDir,
  sanitizeAttachmentFilename,
  saveAttachmentParts,
} from './attachments';
import type { BodyPart } from './body-structure';

describe('resolveSaveDir', () => {
  it('expands a leading ~ to the home directory', () => {
    const resolved = resolveSaveDir('~/Documents/mail');
    expect(resolved.startsWith('~')).toBe(false);
    expect(resolved.endsWith('/Documents/mail')).toBe(true);
  });

  it('leaves an absolute path untouched', () => {
    expect(resolveSaveDir('/var/mail/attachments')).toBe('/var/mail/attachments');
  });

  it('does not expand a ~ that is part of a longer name', () => {
    expect(resolveSaveDir('~user/mail')).toBe('~user/mail');
  });
});

describe('sanitizeAttachmentFilename', () => {
  it('passes an ordinary filename through unchanged', () => {
    expect(sanitizeAttachmentFilename('invoice.pdf', 'fallback')).toBe('invoice.pdf');
  });

  it('replaces path separators so the name cannot escape the save directory', () => {
    // Separators become "_" first, then leading dots are stripped — the
    // result can never be read back as a path (relative or otherwise).
    expect(sanitizeAttachmentFilename('../../etc/passwd', 'fallback')).toBe('_.._etc_passwd');
  });

  it('strips leading dots so the result is never hidden or "."/"" ', () => {
    expect(sanitizeAttachmentFilename('...secret', 'fallback')).toBe('secret');
  });

  it('falls back when nothing safe survives', () => {
    expect(sanitizeAttachmentFilename('...', 'fallback')).toBe('fallback');
  });

  it('truncates an absurdly long filename', () => {
    const long = 'x'.repeat(500) + '.pdf';
    expect(sanitizeAttachmentFilename(long, 'fallback').length).toBe(150);
  });
});

describe('saveAttachmentParts', () => {
  const tmpDirs: string[] = [];
  const makeTmpDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imap-inbox-attachments-'));
    tmpDirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const part = (overrides: Partial<BodyPart>): BodyPart => ({
    partNumber: '2',
    type: 'APPLICATION',
    subtype: 'PDF',
    encoding: 'BASE64',
    size: 8,
    filename: 'invoice.pdf',
    dispositionType: 'ATTACHMENT',
    ...overrides,
  });

  const fakeClient = (content: string) => ({
    uidFetchBodyPart: async (_uid: number, _partNumber: string) => content,
  });

  it('returns nothing when there are no attachment parts', async () => {
    const result = await saveAttachmentParts(
      fakeClient('') as never,
      1,
      [],
      '/tmp/does-not-matter',
      Date.now() + 10_000,
    );
    expect(result).toEqual({ saved: [], skipped: [] });
  });

  it('skips a part above the size cap without fetching it', async () => {
    let fetched = false;
    const client = {
      uidFetchBodyPart: async () => {
        fetched = true;
        return 'aGVsbG8=';
      },
    };
    const result = await saveAttachmentParts(
      client as never,
      1,
      [part({ size: MAX_ATTACHMENT_FETCH_BYTES + 1 })],
      '/tmp/does-not-matter',
      Date.now() + 10_000,
    );
    expect(fetched).toBe(false);
    expect(result.saved).toEqual([]);
    expect(result.skipped).toEqual([
      { filename: 'invoice.pdf', size: MAX_ATTACHMENT_FETCH_BYTES + 1, reason: 'too-large' },
    ]);
  });

  it('skips a non-BASE64 part rather than risk corrupting binary content', async () => {
    const result = await saveAttachmentParts(
      fakeClient('irrelevant') as never,
      1,
      [part({ encoding: '7BIT' })],
      '/tmp/does-not-matter',
      Date.now() + 10_000,
    );
    expect(result.saved).toEqual([]);
    expect(result.skipped).toEqual([
      { filename: 'invoice.pdf', size: 8, reason: 'unsupported-encoding' },
    ]);
  });

  it('skips whatever is left once the deadline is too close', async () => {
    const result = await saveAttachmentParts(
      fakeClient('aGVsbG8=') as never,
      1,
      [part({})],
      '/tmp/does-not-matter',
      Date.now() + 100, // under the 3s start-up margin
    );
    expect(result.saved).toEqual([]);
    expect(result.skipped).toEqual([{ filename: 'invoice.pdf', size: 8, reason: 'time-budget' }]);
  });

  it('writes real content to disk, prefixed with the uid, and reports it saved', async () => {
    const dir = makeTmpDir();
    const result = await saveAttachmentParts(
      fakeClient(Buffer.from('hello world').toString('base64')) as never,
      42,
      [part({})],
      dir,
      Date.now() + 10_000,
    );
    expect(result.skipped).toEqual([]);
    expect(result.saved).toHaveLength(1);
    const [saved] = result.saved;
    expect(saved.filename).toBe('invoice.pdf');
    expect(saved.size).toBe(11);
    expect(saved.path).toBe(path.join(dir, '42_invoice.pdf'));
    expect(fs.readFileSync(saved.path, 'utf8')).toBe('hello world');
  });

  it('creates the save directory when it does not exist yet', async () => {
    const dir = path.join(makeTmpDir(), 'nested', 'attachments');
    const result = await saveAttachmentParts(
      fakeClient(Buffer.from('x').toString('base64')) as never,
      1,
      [part({})],
      dir,
      Date.now() + 10_000,
    );
    expect(result.saved).toHaveLength(1);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('de-duplicates a filename that already exists on disk', async () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, '1_invoice.pdf'), 'already here');
    const result = await saveAttachmentParts(
      fakeClient(Buffer.from('new content').toString('base64')) as never,
      1,
      [part({})],
      dir,
      Date.now() + 10_000,
    );
    expect(result.saved).toHaveLength(1);
    expect(result.saved[0].path).toBe(path.join(dir, '1_invoice (2).pdf'));
  });
});
