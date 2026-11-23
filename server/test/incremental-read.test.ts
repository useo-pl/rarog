/**
 * One incremental read of one file (`server/src/herdr/background/incremental-read.ts`): the parts its callers'
 * tests do not reach directly. A read from byte zero is announced before the first line (truncation, another inode),
 * an over-ceiling line is skipped whole, the budget leaves `more`, a stale read hands over nothing, a missing
 * file is a normal state, and any other read error is reported as `failed`.
 */
import { appendFile, chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cursorAt, readIncrement } from '../src/herdr/background/incremental-read.ts';
import type { FileCursor, IncrementOptions } from '../src/herdr/background/incremental-read.ts';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rarog-incr-'));
  file = join(dir, 'conversation.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A reader of `file` that keeps its cursor and records restarts and lines. */
function reader(overrides: Partial<IncrementOptions<FileCursor>> = {}) {
  let cursor: FileCursor | undefined;
  const events: string[] = [];
  const read = () => readIncrement<FileCursor>(file, {
    cursor,
    restart: (identity) => {
      events.push('restart');
      cursor = cursorAt(identity);
      return cursor;
    },
    budgetBytes: 1024,
    chunkBytes: 4,
    lineMaxBytes: 16,
    stale: () => false,
    onLines: (lines) => { for (const line of lines) events.push(line.toString('utf8')); },
    ...overrides,
  });
  return { read, events, cursor: () => cursor };
}

describe('incremental read of one file', () => {
  it('reads on from the offset; a line split across chunks arrives once, whole', async () => {
    await writeFile(file, 'alpha\nbet');
    const r = reader();
    expect(await r.read()).toEqual({ bytes: 9, more: false });
    await appendFile(file, 'a\ngamma\n');
    expect(await r.read()).toEqual({ bytes: 8, more: false });
    expect(r.events).toEqual(['restart', 'alpha', 'beta', 'gamma']);
  });

  it('a shorter file and another inode are read from byte zero, announced before the first line', async () => {
    await writeFile(file, 'one\ntwo\n');
    const r = reader();
    await r.read();
    await writeFile(file, 'x\n');
    await r.read();
    await writeFile(join(dir, 'other.jsonl'), 'three\nfour\n');
    await rename(join(dir, 'other.jsonl'), file);
    await r.read();
    expect(r.events).toEqual(['restart', 'one', 'two', 'restart', 'x', 'restart', 'three', 'four']);
  });

  it('a line over the ceiling is skipped whole and counted', async () => {
    await writeFile(file, `short\n${'y'.repeat(40)}\nafter\n`);
    const r = reader();
    await r.read();
    expect(r.events).toEqual(['restart', 'short', 'after']);
    expect(r.cursor()?.dropped).toBe(1);
  });

  it('the budget stops the read with `more`; the next read goes on without a lost line', async () => {
    await writeFile(file, 'aaaa\nbbbb\ncccc\n');
    const r = reader({ budgetBytes: 7 });
    expect(await r.read()).toEqual({ bytes: 7, more: true });
    expect(await r.read()).toEqual({ bytes: 7, more: true });
    expect(await r.read()).toEqual({ bytes: 1, more: false });
    expect(r.events).toEqual(['restart', 'aaaa', 'bbbb', 'cccc']);
  });

  it('a stale read hands over no line', async () => {
    await writeFile(file, 'one\ntwo\n');
    const r = reader({ stale: () => true });
    expect(await r.read()).toEqual({ bytes: 0, more: false });
    expect(r.events).toEqual([]);
  });

  it('an async line handler is awaited before the next chunk', async () => {
    await writeFile(file, 'one\ntwo\n');
    const order: string[] = [];
    const r = reader({
      chunkBytes: 4,
      onLines: async (lines) => {
        for (const line of lines) order.push(`start ${line.toString('utf8')}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        for (const line of lines) order.push(`end ${line.toString('utf8')}`);
      },
    });
    await r.read();
    expect(order).toEqual(['start one', 'end one', 'start two', 'end two']);
  });

  it('a missing file reads nothing and throws nothing', async () => {
    expect(await reader().read()).toEqual({ bytes: 0, more: false });
  });

  it('a file that cannot be opened (no read permission) reports `failed`, without lines', async () => {
    await writeFile(file, 'one\n');
    await chmod(file, 0o000);
    const r = reader();
    expect(await r.read()).toEqual({ bytes: 0, more: false, failed: true });
    expect(r.events).toEqual([]);
    await chmod(file, 0o600);
    expect(await r.read()).toEqual({ bytes: 4, more: false });
    expect(r.events).toEqual(['restart', 'one']);
  });

  it('an error after the open (a directory under the name) reports `failed`', async () => {
    await mkdir(file);
    expect(await reader().read()).toMatchObject({ bytes: 0, failed: true });
  });
});
