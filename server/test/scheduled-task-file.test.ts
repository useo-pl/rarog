/**
 * The reader of the main conversation file for scheduled tasks (`herdr/background/scheduled-task-file.ts`): the list
 * from the whole file on the first read, increments after it, a rebuild from zero on truncation, a stale read after
 * `repoint`, the process start kept across a rebuild, a file confirmed missing, and the outcomes the poll tells apart
 * (`more`, `failed`, `unknown`). Recognition itself is `scheduled-tasks.test.ts`.
 */
import { appendFile, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectSlug } from '../src/cli-store.ts';
import { createScheduledTaskFileReader } from '../src/herdr/background/scheduled-task-file.ts';
import type { ScheduledTaskFileReaderOptions } from '../src/herdr/background/scheduled-task-file.ts';
import { CRON_T0, cronCreate, cronDelete, cronFire, cronUserText } from './helpers/cron-lines.ts';

const CWD = '/Users/demo/Projects/crons';
const SESSION = '5b1f0c2e-8d3a-4e71-9a62-1c4d7e0f2b93';
const SESSION_B = 'c7e2a914-3f60-4b8d-a1d5-6e9f0b2c4a17';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rarog-crons-'));
  await mkdir(join(root, projectSlug(CWD)), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const file = (session = SESSION): string => join(root, projectSlug(CWD), `${session}.jsonl`);

const reader = (options: Partial<ScheduledTaskFileReaderOptions> = {}) => createScheduledTaskFileReader({
  root, cwd: CWD, agentSessionId: SESSION, ...options,
});

async function ids(read: Promise<{ tasks: readonly { id: string }[] } | null>): Promise<string[] | null> {
  const result = await read;
  return result === null ? null : result.tasks.map((task) => task.id);
}

describe('scheduled task file reader', () => {
  it('the first read gives the list from the whole file; later reads go on from the offset', async () => {
    await writeFile(file(), cronUserText(SESSION, 'remind me') + cronCreate(SESSION, 'a1b2c3d4', { seconds: 1 }));
    const r = reader({ chunkBytes: 64 });
    expect(await r.read()).toEqual({
      tasks: [{
        id: 'a1b2c3d4', cron: '13 22 19 11 *', recurring: false, prompt: 'prompt a1b2c3d4',
        createdAt: '2026-11-19T21:00:01.000Z', nextFireAt: new Date(CRON_T0 + 3_600_000).toISOString(),
      }],
      more: false, failed: false, unknown: false,
    });
    await appendFile(file(), cronCreate(SESSION, 'e5f6a7b8', { seconds: 2 }));
    expect(await ids(r.read())).toEqual(['e5f6a7b8', 'a1b2c3d4']);
  });

  it('`CronDelete` of the last task, with the call and its result in separate reads → empty list', async () => {
    await writeFile(file(), cronCreate(SESSION, 'a1b2c3d4'));
    const r = reader();
    expect(await ids(r.read())).toEqual(['a1b2c3d4']);
    const [call, result] = cronDelete(SESSION, 'a1b2c3d4', 3).split(/(?<=\n)/);
    await appendFile(file(), call ?? '');
    expect(await ids(r.read())).toEqual(['a1b2c3d4']);
    await appendFile(file(), result ?? '');
    expect(await ids(r.read())).toEqual([]);
  });

  it('a one-shot run removes the task', async () => {
    await writeFile(file(), cronCreate(SESSION, 'a1b2c3d4') + cronFire(SESSION, 'a1b2c3d4', 60));
    expect(await ids(reader().read())).toEqual([]);
  });

  it('a truncated file rebuilds the list from zero', async () => {
    await writeFile(file(), cronCreate(SESSION, 'a1b2c3d4') + cronCreate(SESSION, 'e5f6a7b8', { seconds: 1 }));
    const r = reader();
    expect(await ids(r.read())).toEqual(['e5f6a7b8', 'a1b2c3d4']);
    await writeFile(file(), cronCreate(SESSION, '0c0c0c0c'));
    expect(await ids(r.read())).toEqual(['0c0c0c0c']);
  });

  it('a new reader on an existing file (server restart) gives the list from the whole file', async () => {
    const filler = Array.from({ length: 40 }, (_, n) => cronUserText(SESSION, `line ${String(n)}`, n)).join('');
    await writeFile(file(), cronCreate(SESSION, 'a1b2c3d4') + filler + cronCreate(SESSION, 'e5f6a7b8', { seconds: 90 }));
    expect(await ids(reader({ chunkBytes: 128 }).read())).toEqual(['e5f6a7b8', 'a1b2c3d4']);
  });

  it('the budget leaves `more` until the file is read to the end', async () => {
    await writeFile(file(), cronCreate(SESSION, 'a1b2c3d4') + cronDelete(SESSION, 'a1b2c3d4', 2));
    const r = reader({ budgetBytes: 200, chunkBytes: 100 });
    const first = await r.read();
    expect(first?.more).toBe(true);
    let last = first;
    while (last?.more === true) last = await r.read();
    expect(last).toEqual({ tasks: [], more: false, failed: false, unknown: false });
  });

  it('`repoint` during a read: the read hands out nothing, the next one reads the new file', async () => {
    await writeFile(file(), cronCreate(SESSION, 'a1b2c3d4'));
    await writeFile(file(SESSION_B), cronCreate(SESSION_B, 'b0b0b0b0'));
    const r = reader();
    const pending = r.read();
    r.repoint(SESSION_B);
    expect(await pending).toBeNull();
    expect(await ids(r.read())).toEqual(['b0b0b0b0']);
  });

  it('the process start drops a one-shot task due before it, also after a rebuild', async () => {
    const due = CRON_T0 + 60_000;
    await writeFile(file(), cronCreate(SESSION, 'a1b2c3d4', { nextFireAt: due }));
    const r = reader();
    expect(await ids(r.read())).toEqual(['a1b2c3d4']);
    expect(r.processStarted(due + 1)).toBe(true);
    expect(r.processStarted(due + 1)).toBe(false);
    expect(await ids(r.read())).toEqual([]);
    await writeFile(file(), cronCreate(SESSION, 'a1b2c3d4', { nextFireAt: due }));
    expect(await ids(r.read())).toEqual([]);
    r.repoint(SESSION);
    expect(await ids(r.read())).toEqual(['a1b2c3d4']);
  });

  it('a file that cannot be read → `failed`; the next read after the fix gives the list', async () => {
    await writeFile(file(), cronCreate(SESSION, 'a1b2c3d4'));
    await chmod(file(), 0o000);
    const r = reader();
    expect(await r.read()).toMatchObject({ failed: true, more: false });
    await chmod(file(), 0o600);
    expect(await r.read()).toMatchObject({ failed: false, tasks: [{ id: 'a1b2c3d4' }] });
  });

  it('the follower does not know the file yet → `unknown`; it knows there is none → empty list', async () => {
    await writeFile(file(), cronCreate(SESSION, 'a1b2c3d4'));
    expect(await reader({ locate: () => null }).read()).toMatchObject({ unknown: true, tasks: [] });
    expect(await reader({ locate: () => false }).read()).toEqual({ tasks: [], more: false, failed: false, unknown: false });
    expect(await ids(reader({ locate: () => file() }).read())).toEqual(['a1b2c3d4']);
  });

  it('a file the follower no longer finds → empty list; found again → the whole list from zero', async () => {
    await writeFile(file(), cronCreate(SESSION, 'a1b2c3d4'));
    let where: string | false = file();
    const r = reader({ locate: () => where });
    expect(await ids(r.read())).toEqual(['a1b2c3d4']);
    where = false;
    expect(await r.read()).toEqual({ tasks: [], more: false, failed: false, unknown: false });
    where = file();
    expect(await ids(r.read())).toEqual(['a1b2c3d4']);
  });

  it('no file and no `locate` → empty list, not `unknown`', async () => {
    expect(await reader().read()).toEqual({ tasks: [], more: false, failed: false, unknown: false });
  });

  it('after `close` a read gives nothing', async () => {
    const r = reader();
    r.close();
    expect(await r.read()).toBeNull();
  });
});
