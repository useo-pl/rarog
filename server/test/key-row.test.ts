/**
 * Key row of a layer 2 card (`server/src/herdr/dialogs/send/key-row.ts`): the closed list, the assertion of one
 * key per call and the client method `sendDialogKey`, which checks the key before it touches the socket. The step that
 * proves the key belongs to the card on the screen is tested in `layer2-step.test.ts` and `layer2-step-driver.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createHerdrClient } from '../src/herdr/client.ts';
import { ALLOWED_KEYS } from '../src/herdr/dialogs/send/keys.ts';
import { KEY_ROW_KEYS, assertDialogKey, isKeyRowKey } from '../src/herdr/dialogs/send/key-row.ts';
import type { KeyRowKey } from '../src/herdr/dialogs/send/key-row.ts';
import { scan, tsFiles } from './source-scan.ts';

interface Call { method: string; params: Record<string, unknown> }

/** Fake socket transport: records the requests and answers with success. */
function fakeRequester(): { calls: Call[]; request: (m: string, p: Record<string, unknown>) => Promise<unknown> } {
  const calls: Call[] = [];
  return {
    calls,
    request(method, params) {
      calls.push({ method, params });
      return Promise.resolve({ type: 'ok' });
    },
  };
}

describe('key row assertion', () => {
  it('the list is exactly the arrows, Tab and Enter', () => {
    expect([...KEY_ROW_KEYS]).toEqual(['up', 'down', 'left', 'right', 'tab', 'enter']);
  });

  it.each(KEY_ROW_KEYS.map((key) => [key]))('[%s] passes', (key) => {
    expect(() => { assertDialogKey([key]); }).not.toThrow();
    expect(isKeyRowKey(key)).toBe(true);
  });

  it.each([[[]], [['left', 'right']], [['enter', 'enter']], [['escape']], [['2']], [['ctrl+c']], [['shift+tab']],
    [['a']]])('%j throws', (keys) => {
    expect(() => { assertDialogKey(keys); }).toThrow();
  });

  it('digits and Esc stay off the key row; the key row stays off `ALLOWED_KEYS`', () => {
    for (const key of ['escape', '1', '9', 'ctrl+c']) expect(isKeyRowKey(key)).toBe(false);
    for (const key of ['up', 'down', 'enter', 'left', 'right', 'tab']) expect(ALLOWED_KEYS.has(key)).toBe(false);
  });
});

describe('client: `sendDialogKey`', () => {
  it('sends one `agent.send_keys` with exactly the one key', async () => {
    const fake = fakeRequester();
    await createHerdrClient(fake).sendDialogKey('w9:p72', 'right');
    expect(fake.calls).toEqual([{ method: 'agent.send_keys', params: { target: 'w9:p72', keys: ['right'] } }]);
  });

  it.each([
    ['two keys', ['left', 'right'] as unknown as KeyRowKey],
    ['a digit', '2' as KeyRowKey],
    ['Esc', 'escape' as KeyRowKey],
    ['an empty key', '' as KeyRowKey],
  ])('%s → exception before the socket', async (_name, key) => {
    const fake = fakeRequester();
    await expect(createHerdrClient(fake).sendDialogKey('w9:p72', key)).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });

  it('`sendKeys` still refuses the key row keys', async () => {
    const fake = fakeRequester();
    const client = createHerdrClient(fake);
    for (const key of ['right', 'tab', 'enter']) await expect(client.sendKeys('w9:p72', [key])).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });
});

/*
 * Guard: only the driver facade sends a key row key, the client defines the method, and the list with its assertion
 * stays in the key row module and the client.
 */
describe('key row boundary', () => {
  const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const files = tsFiles(join(REPO, 'server/src')).map((file) => ({
    file: relative(REPO, file), source: readFileSync(file, 'utf8'),
  }));
  const codeLines = (source: string): string[] => source.split('\n')
    .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line));
  const usedIn = (pattern: RegExp): string[] => files
    .filter(({ source }) => codeLines(source).some((line) => pattern.test(line)))
    .map(({ file }) => file);

  it('`sendDialogKey` is called only by the driver facade and defined by the client', () => {
    // The answer recheck wraps the client a driver gets: one line passes the driver's call on as it came
    // (`herdr-answer-recheck.test.ts`), so it is not a second sender.
    const recheck = 'server/src/herdr/answer-recheck.ts';
    expect(usedIn(/\.sendDialogKey\(/).sort()).toEqual(['server/src/drivers/herdr-driver.ts', recheck]);
    const wrapper = files.find(({ file }) => file === recheck)?.source ?? '';
    expect(codeLines(wrapper).filter((line) => line.includes('.sendDialogKey('))).toHaveLength(1);
    // A definition, not a call through a receiver: the calls are counted above.
    expect(usedIn(/(?<!\.)sendDialogKey\(paneId/).sort())
      .toEqual(['server/src/herdr/client.ts', 'server/src/herdr/types.ts']);
  });

  it('the assertion and the list live in the key row module and the client', () => {
    expect(usedIn(/\bassertDialogKey\b|\bKEY_ROW_KEYS\b/).sort()).toEqual([
      'server/src/herdr/client.ts',
      'server/src/herdr/dialogs/send/key-row.ts',
    ]);
  });

  it('no file outside the key row module spells a key row key list', () => {
    const lists = files.filter(({ source }) => scan(source).literals.some((literal) => literal.text === 'right'))
      .map(({ file }) => file).sort();
    expect(lists).toEqual([
      'server/src/herdr/dialogs/layer2/verdict.ts',
      'server/src/herdr/dialogs/send/key-row.ts',
    ]);
  });
});
