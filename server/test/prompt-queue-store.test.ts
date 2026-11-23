/**
 * The paste queue on disk (`drivers/herdr/prompt-queue-store.ts`): removing entries with a write the caller awaits
 * (the queue take-back answers only after the file lost them) and the sender a voice agent message keeps on disk.
 * Restart and paste paths: `wysylka-kolejka-trwalosc`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROMPT_QUEUE_FILENAME, createPromptQueueStore } from '../src/drivers/herdr/prompt-queue-store.ts';
import type { PromptQueueStore } from '../src/drivers/herdr/prompt-queue-store.ts';

const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';

let base = '';
const stores: PromptQueueStore[] = [];
const dataDir = (): string => join(base, 'data');
interface FileEntry { id: string; state: string; text?: string; source?: string }
const fileEntries = (): FileEntry[] => (JSON.parse(
  readFileSync(join(dataDir(), PROMPT_QUEUE_FILENAME), 'utf8'),
) as { entries: FileEntry[] }).entries;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'rarog-store-'));
  await mkdir(dataDir(), { recursive: true });
});

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await chmod(dataDir(), 0o700).catch(() => undefined);
  await rm(base, { recursive: true, force: true });
});

const newStore = (logs: string[] = [], voiceAgentSends = false): PromptQueueStore => {
  const store = createPromptQueueStore({ dataDir: dataDir(), logger: (line) => logs.push(line), voiceAgentSends });
  stores.push(store);
  return store;
};

describe('prompt queue store: remove()', () => {
  it('takes the entries out with a write the caller awaits; an unknown id is no change', async () => {
    const store = newStore();
    const a = store.add(SESSION, 'A');
    const b = store.add(SESSION, 'B');
    const c = store.add(SESSION, 'C');
    await Promise.all([a.written, b.written, c.written]);
    expect(await store.pasted(b.id)).toBe(true);
    expect(await store.remove([a.id, b.id, 'no-such-id'])).toBe(true);
    expect(fileEntries().map((entry) => entry.text)).toEqual(['C']);
  });

  it('a failed write puts the entries back with their id, state and place, so the next write holds them', async () => {
    const logs: string[] = [];
    const store = newStore(logs);
    const a = store.add(SESSION, 'A');
    const b = store.add(SESSION, 'B');
    const c = store.add(SESSION, 'C');
    await Promise.all([a.written, b.written, c.written]);
    expect(await store.pasted(a.id)).toBe(true);
    await chmod(dataDir(), 0o500);
    expect(await store.remove([a.id, b.id])).toBe(false);
    expect(logs.some((line) => line.startsWith('prompt-queue: write failed'))).toBe(true);
    await chmod(dataDir(), 0o700);
    const d = store.add(SESSION, 'D');
    expect(await d.written).toBe(true);
    expect(fileEntries().map((entry) => [entry.id, entry.state, entry.text])).toEqual([
      [a.id, 'pasted', undefined], [b.id, 'queued', 'B'], [c.id, 'queued', 'C'], [d.id, 'queued', 'D'],
    ]);
  });

  it('after close() nothing changes and the answer is false', async () => {
    const store = newStore();
    const a = store.add(SESSION, 'A');
    await a.written;
    await store.close();
    expect(await store.remove([a.id])).toBe(false);
    expect(fileEntries().map((entry) => entry.text)).toEqual(['A']);
  });
});

describe('prompt queue store: the sender of a message', () => {
  /** The store of the next server start over the same data directory: what a driver of `SESSION` claims. */
  const afterRestart = async (store: PromptQueueStore): Promise<ReturnType<PromptQueueStore['restore']>> => {
    await store.close();
    return newStore([], true).restore(SESSION);
  };

  it('a voice agent message keeps its sender on disk, through the paste mark and back, and after a restart', async () => {
    const store = newStore();
    const a = store.add(SESSION, 'A', 'voice-agent');
    const b = store.add(SESSION, 'B');
    await Promise.all([a.written, b.written]);
    expect(fileEntries().map((entry) => [entry.state, entry.text, entry.source])).toEqual([
      ['queued', 'A', 'voice-agent'], ['queued', 'B', undefined],
    ]);
    expect(await store.pasted(a.id)).toBe(true);
    expect(fileEntries().map((entry) => [entry.state, entry.text, entry.source])).toEqual([
      ['pasted', undefined, 'voice-agent'], ['queued', 'B', undefined],
    ]);
    expect(await store.requeue(a.id, 'A')).toBe(true);
    expect(await afterRestart(store)).toEqual({
      queued: [{ id: a.id, text: 'A', source: 'voice-agent' }, { id: b.id, text: 'B' }], pasted: [],
    });
  });

  it('an entry without the field (a file of the previous version) and an unknown sender restore as a message '
    + 'without a sender', async () => {
    await writeFile(join(dataDir(), PROMPT_QUEUE_FILENAME), JSON.stringify({
      format: 1,
      entries: [
        { id: 'old', session: SESSION, state: 'queued', text: 'A', at: Date.now() },
        { id: 'odd', session: SESSION, state: 'queued', text: 'B', at: Date.now(), source: 'phone' },
      ],
    }));
    expect(newStore().restore(SESSION)).toEqual({ queued: [{ id: 'old', text: 'A' }, { id: 'odd', text: 'B' }], pasted: [] });
  });

  describe('a start with the voice agent\'s sends off', () => {
    const writeQueue = (): Promise<void> => writeFile(join(dataDir(), PROMPT_QUEUE_FILENAME), JSON.stringify({
      format: 1,
      entries: [
        { id: 'marked', session: SESSION, state: 'queued', text: 'secret prompt', at: Date.now(), source: 'voice-agent' },
        { id: 'typed', session: SESSION, state: 'queued', text: 'typed in the app', at: Date.now() },
        { id: 'noted', session: SESSION, state: 'pasted', at: Date.now(), source: 'voice-agent' },
      ],
    }));

    it('a queued entry with a sender leaves the file with one log line without its text; the rest restores',
      async () => {
        await writeQueue();
        const logs: string[] = [];
        const store = newStore(logs, false);
        expect(store.restore(SESSION)).toEqual({ queued: [{ id: 'typed', text: 'typed in the app' }], pasted: ['noted'] });
        await store.close();
        expect(fileEntries().map((entry) => entry.id)).toEqual(['typed', 'noted']);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain('1 voice agent message(s)');
        expect(logs.join('\n')).not.toContain('secret prompt');
      });

    it('with the sends on the same file restores whole', async () => {
      await writeQueue();
      const logs: string[] = [];
      expect(newStore(logs, true).restore(SESSION)).toEqual({
        queued: [{ id: 'marked', text: 'secret prompt', source: 'voice-agent' }, { id: 'typed', text: 'typed in the app' }],
        pasted: ['noted'],
      });
      expect(logs).toEqual([]);
    });
  });
});
