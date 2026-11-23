/**
 * The removal store of Inbox cards (`server/src/inbox/removals.ts`): `inbox.json` on disk, a broken file, a file of
 * another format, the format without content, the cap of entries of closed sessions and the drop of entries of a session's earlier turns.
 */
import { readFile, stat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INBOX_CLOSED_LIMIT, INBOX_FILENAME, INBOX_FORMAT, RemovalStore } from '../src/inbox/removals.ts';
import type { RemovalEntry } from '../src/inbox/removals.ts';

let dataDir = '';

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'rarog-inbox-store-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const open = new Set<string>();
/** Lines the stores logged. */
const logged: string[] = [];
const store = (): RemovalStore => new RemovalStore({
  dataDir, isOpen: (id) => open.has(id), log: (line) => { logged.push(line); },
});
const fileText = (): Promise<string> => readFile(join(dataDir, INBOX_FILENAME), 'utf8');

const result = (sessionId: string, turnId: string): RemovalEntry => ({ sessionId, turnId, card: 'result' });

describe('inbox removal store', () => {
  beforeEach(() => {
    open.clear();
    logged.length = 0;
  });

  it('a broken file is an empty store, and the next write replaces it', async () => {
    await writeFile(join(dataDir, INBOX_FILENAME), '{"removed": [ not json');
    const broken = store();
    expect(broken.has(result('s1', 't1'))).toBe(false);
    expect(await broken.add(result('s1', 't1'))).toBe('added');
    expect(JSON.parse(await fileText())).toEqual({
      format: INBOX_FORMAT, removed: [{ sessionId: 's1', turnId: 't1', card: 'result' }],
    });
    expect(store().has(result('s1', 't1'))).toBe(true);
  });

  it.each([
    ['a newer format', { format: INBOX_FORMAT + 1 }],
    ['no format', {}],
  ] as const)('a file in %s is an empty store with one log line, and the next write replaces it', async (_name, head) => {
    await writeFile(join(dataDir, INBOX_FILENAME), JSON.stringify({ ...head, removed: [result('s1', 't1')] }));
    const unknown = store();
    expect(unknown.has(result('s1', 't1'))).toBe(false);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(INBOX_FILENAME);
    expect(await unknown.add(result('s2', 't2'))).toBe('added');
    expect(JSON.parse(await fileText())).toEqual({ format: INBOX_FORMAT, removed: [result('s2', 't2')] });
  });

  it('the file holds keys only, readable by its owner only; unknown fields and bad entries are skipped', async () => {
    const first = store();
    const decision: RemovalEntry = {
      sessionId: 's1', turnId: 't1', card: 'decision', dialog: 'permission', dialogId: 'opaque-dialog-digest',
      seen: true,
    };
    await first.add(decision);
    expect(JSON.parse(await fileText())).toEqual({ format: INBOX_FORMAT, removed: [decision] });
    expect((await stat(join(dataDir, INBOX_FILENAME))).mode & 0o777).toBe(0o600);

    await writeFile(join(dataDir, INBOX_FILENAME), JSON.stringify({
      format: INBOX_FORMAT,
      removed: [{ ...decision, text: 'never stored', extra: 1 }, { sessionId: 's2', card: 'result' }, 'junk'],
      later: true,
    }));
    const reread = store();
    expect(reread.has(decision)).toBe(true);
    expect(await reread.delete(decision)).toEqual({ entry: decision });
    expect(JSON.parse(await fileText())).toEqual({ format: INBOX_FORMAT, removed: [] });
  });

  it('a key already stored writes nothing; deleting a missing key is absent', async () => {
    const s = store();
    expect(await s.add(result('s1', 't1'))).toBe('added');
    expect(await s.add(result('s1', 't1'))).toBe('present');
    expect(await s.delete(result('s1', 't2'))).toBe('absent');
  });

  it('keeps the newest entries of closed sessions up to the cap; entries of open sessions do not count', async () => {
    open.add('live');
    const s = store();
    await s.add(result('live', 'live-turn'));
    for (let i = 0; i <= INBOX_CLOSED_LIMIT; i += 1) await s.add(result(`closed-${String(i)}`, `turn-${String(i)}`));
    expect(s.has(result('closed-0', 'turn-0'))).toBe(false);
    expect(s.has(result('closed-1', 'turn-1'))).toBe(true);
    expect(s.has(result(`closed-${String(INBOX_CLOSED_LIMIT)}`, `turn-${String(INBOX_CLOSED_LIMIT)}`))).toBe(true);
    expect(s.has(result('live', 'live-turn'))).toBe(true);
    expect((JSON.parse(await fileText()) as { removed: unknown[] }).removed).toHaveLength(INBOX_CLOSED_LIMIT + 1);
  });

  it('drops the entries of a session whose card moved to another turn, and only those', async () => {
    const s = store();
    await s.add(result('s1', 'old'));
    await s.add({ sessionId: 's1', turnId: 'old', card: 'failed', since: '2026-11-20T10:00:00.000Z' });
    await s.add(result('s1', 'current'));
    await s.add(result('s2', 'other'));
    await s.keepTurn('s1', 'current');
    expect(s.has(result('s1', 'old'))).toBe(false);
    expect(s.has({ turnId: 'old', card: 'failed', since: '2026-11-20T10:00:00.000Z' })).toBe(false);
    expect(s.has(result('s1', 'current'))).toBe(true);
    expect(s.has(result('s2', 'other'))).toBe(true);
  });
});
