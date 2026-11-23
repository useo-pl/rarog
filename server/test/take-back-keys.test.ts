/**
 * Keys of the queue take-back (`server/src/herdr/dialogs/send/take-back-keys.ts`): the closed list, the assertion of
 * one key per call, the client method `sendTakeBackKey`, which checks the key before it touches the socket, and the
 * guard on its callers. When a key goes out is the caller's decision and is tested with the caller.
 */
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createHerdrClient } from '../src/herdr/client.ts';
import { ALLOWED_KEYS, HerdrKeyNotAllowedError } from '../src/herdr/dialogs/send/keys.ts';
import { TAKE_BACK_KEYS, assertTakeBackKey } from '../src/herdr/dialogs/send/take-back-keys.ts';
import type { TakeBackKey } from '../src/herdr/dialogs/send/take-back-keys.ts';
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

describe('take-back key assertion', () => {
  it('the list is exactly `up`, `down` and `ctrl+u`', () => {
    expect([...TAKE_BACK_KEYS]).toEqual(['up', 'down', 'ctrl+u']);
  });

  it.each(TAKE_BACK_KEYS.map((key) => [key]))('[%s] passes', (key) => {
    expect(() => { assertTakeBackKey([key]); }).not.toThrow();
  });

  it.each([
    [[]], [['up', 'up']], [['up', 'down']], [['ctrl+u', 'ctrl+u']], [['enter']], [['escape']], [['ctrl+c']],
    [['1']], [['left']], [['right']], [['tab']], [['shift+tab']], [['ctrl+d']], [['ctrl+v']], [['u']], [['UP']],
    [['ctrl+U']], [['']], [['ctrl+u; rm -rf /']],
  ])('%j → `HerdrKeyNotAllowedError`', (keys) => {
    expect(() => { assertTakeBackKey(keys); }).toThrow(HerdrKeyNotAllowedError);
  });

  it('none of the three keys is on `ALLOWED_KEYS`', () => {
    for (const key of TAKE_BACK_KEYS) expect(ALLOWED_KEYS.has(key), key).toBe(false);
  });
});

describe('client: `sendTakeBackKey`', () => {
  it.each(TAKE_BACK_KEYS.map((key) => [key]))('[%s] → one `agent.send_keys` with exactly that key', async (key) => {
    const fake = fakeRequester();
    await createHerdrClient(fake).sendTakeBackKey('w9:p72', key);
    expect(fake.calls).toEqual([{ method: 'agent.send_keys', params: { target: 'w9:p72', keys: [key] } }]);
  });

  it.each([
    ['Enter', 'enter'],
    ['Esc', 'escape'],
    ['a digit', '1'],
    ['another arrow', 'left'],
    ['`ctrl+c`', 'ctrl+c'],
    ['an empty key', ''],
    ['two keys', ['up', 'down']],
  ])('%s → `HerdrKeyNotAllowedError` before the socket', async (_name, key) => {
    const fake = fakeRequester();
    await expect(createHerdrClient(fake).sendTakeBackKey('w9:p72', key as TakeBackKey))
      .rejects.toBeInstanceOf(HerdrKeyNotAllowedError);
    expect(fake.calls).toEqual([]);
  });

  it('`sendKeys` still refuses the take-back keys', async () => {
    const fake = fakeRequester();
    const client = createHerdrClient(fake);
    for (const key of TAKE_BACK_KEYS) {
      await expect(client.sendKeys('w9:p72', [key])).rejects.toBeInstanceOf(HerdrKeyNotAllowedError);
    }
    expect(fake.calls).toEqual([]);
  });
});

/*
 * Guard: only the driver's queue take-back module calls `sendTakeBackKey`, from one place. The client and its interface
 * define the method, and the answer recheck passes the driver's call on in one line (`herdr-answer-recheck.test.ts`),
 * so it is not a second sender. The take-back module may be absent: then nothing calls the method. Outside these files
 * and the key module, code holds neither `sendTakeBack` nor `TakeBackKey`, in a name or in a string. The list with its
 * assertion stays in the key module and the client, and only the key module spells `ctrl+u`.
 *
 * The guard reads code without comments (`scan`), so a comment before a call on the same line hides nothing. A text
 * scan cannot see a name built at runtime: it catches one only when a literal piece holds `sendTakeBack` or
 * `TakeBackKey`, so `client['sendTake' + 'BackKey']` passes it.
 */
describe('take-back key boundary', () => {
  const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const CLIENT = 'server/src/herdr/client.ts';
  const TYPES = 'server/src/herdr/types.ts';
  const RECHECK = 'server/src/herdr/answer-recheck.ts';
  const TAKE_BACK = 'server/src/drivers/herdr/queue-take-back.ts';
  const KEY_MODULE = 'server/src/herdr/dialogs/send/take-back-keys.ts';

  interface Source { file: string; source: string }
  const files: Source[] = tsFiles(join(REPO, 'server/src')).map((file) => ({
    file: relative(REPO, file), source: readFileSync(file, 'utf8'),
  }));
  /** Code lines without comments: a closed block comment leaves the code after it on its line. */
  const codeLines = (source: string): string[] => scan(source).code.split('\n');
  const usedIn = (pattern: RegExp): string[] => files
    .filter(({ source }) => codeLines(source).some((line) => pattern.test(line)))
    .map(({ file }) => file);
  const literalIn = (text: string): string[] => files
    .filter(({ source }) => scan(source).literals.some((literal) => literal.text === text))
    .map(({ file }) => file);

  const METHOD = 'sendTakeBack';
  const KEY_TYPE = 'TakeBackKey';
  const NAMING_FILES: ReadonlySet<string> = new Set([CLIENT, TYPES, RECHECK, KEY_MODULE, TAKE_BACK]);
  const DEFINITION = /(?<!\.)\bsendTakeBackKey\(paneId/;
  const occurrences = (text: string, part: string): number => text.split(part).length - 1;

  /** Code ranges of `Pick<…>` type arguments; `<` of an arrow (`=>`) is not a bracket. */
  function pickRanges(code: string): (readonly [number, number])[] {
    const ranges: (readonly [number, number])[] = [];
    for (const hit of code.matchAll(/\bPick</g)) {
      let depth = 0;
      for (let at = hit.index + 'Pick'.length; at < code.length; at += 1) {
        if (code[at] === '<') depth += 1;
        if (code[at] === '>' && code[at - 1] !== '=' && --depth === 0) {
          ranges.push([hit.index, at]);
          break;
        }
      }
    }
    return ranges;
  }

  /**
   * Accesses of the method in code: every occurrence, a bracket access with a quoted name included. Only a quoted name
   * inside `Pick<…>` is a type key and not an access.
   */
  function methodAccesses(code: string): number {
    const picks = pickRanges(code);
    let accesses = 0;
    for (const hit of code.matchAll(new RegExp(METHOD, 'g'))) {
      const quoted = /['"`]/.test(code[hit.index - 1] ?? '');
      const inPick = picks.some(([start, end]) => hit.index > start && hit.index < end);
      if (!quoted || !inPick) accesses += 1;
    }
    return accesses;
  }

  /** Breaches of the caller rule in a set of source files; empty when the rule holds. */
  function callerBreaches(sources: readonly Source[]): string[] {
    const breaches: string[] = [];
    for (const { file, source } of sources) {
      const code = scan(source).code;
      const named = code.split('\n').filter((line) => line.includes(METHOD));
      if (!NAMING_FILES.has(file)) {
        if (code.includes(METHOD) || code.includes(KEY_TYPE)) {
          breaches.push(`${file}: holds ${METHOD} or ${KEY_TYPE}; only ${TAKE_BACK} sends take-back keys`);
        }
      } else if (file === CLIENT || file === TYPES) {
        if (named.length !== 1 || occurrences(code, METHOD) !== 1 || !DEFINITION.test(named[0] ?? '')) {
          breaches.push(`${file}: only the definition of sendTakeBackKey, found ${occurrences(code, METHOD)}`);
        }
      } else if (file === RECHECK) {
        if (named.length !== 1 || occurrences(code, METHOD) !== 2) {
          breaches.push(`${file}: one pass-through line (the key and one call), found ${occurrences(code, METHOD)}`);
        }
      } else if (file === KEY_MODULE) {
        if (named.length > 0) breaches.push(`${file}: the key module sends nothing, found ${named.length} lines`);
      } else {
        const accesses = methodAccesses(code);
        if (accesses > 1) breaches.push(`${file}: sendTakeBackKey from one place, found ${accesses}`);
      }
    }
    return breaches;
  }

  it('`sendTakeBackKey` is called only by the queue take-back module, from one place', () => {
    expect(callerBreaches(files), [
      `take-back keys go out only from ${TAKE_BACK}, through one send call.`,
      'A caller elsewhere opens arrows and ctrl+u past the take-back checks: route the key through that module;',
      'a new caller is a change of this guard and of docs/security-model.md,',
      '"herdr sessions: Rarog writes to a terminal it does not own".',
    ].join(' ')).toEqual([]);
    // The client, its interface and the recheck pass-through name it today; a caller elsewhere is a breach above.
    expect(usedIn(/sendTakeBack/).filter((file) => file !== TAKE_BACK).sort()).toEqual([RECHECK, CLIENT, TYPES]);
  });

  it.each([
    ['another driver module', 'server/src/drivers/herdr/prompt-queue.ts',
      "    await this.#deps.client.sendTakeBackKey(this.#paneId, 'up');"],
    ['the driver facade', 'server/src/drivers/herdr-driver.ts',
      '      () => this.#deps.client.sendTakeBackKey(this.#paneId, TAKE_BACK_UP_KEY),'],
    ['a destructured call', 'server/src/sessions/manager.ts', '    const { sendTakeBackKey } = client;'],
    ['a second call in the client', CLIENT, '      await this.sendTakeBackKey(paneId, key);'],
    ['a line that opens with a closed block comment', 'server/src/drivers/herdr/prompt-queue.ts',
      "    /* retry */ await this.#deps.client.sendTakeBackKey(this.#paneId, 'up');"],
    ['a name held in a string', 'server/src/drivers/herdr/prompt-queue.ts',
      "    const send = 'sendTakeBackKey' as const;"],
    ['the key type in another module', 'server/src/drivers/herdr-driver.ts',
      "import type { TakeBackKey } from '../herdr/dialogs/send/take-back-keys.ts';"],
    ['the key module', KEY_MODULE, '  void client.sendTakeBackKey(paneId, TAKE_BACK_UP_KEY);'],
  ])('the guard fails for a call from %s', (_name, file, line) => {
    const sources = files.map((entry) => (entry.file === file
      ? { file, source: `${entry.source}\n${line}\n` } : entry));
    expect(callerBreaches(sources)).not.toEqual([]);
  });

  it('the recheck line passes one call on: a second call on the same line is a breach', () => {
    const pass = 'client.sendTakeBackKey(paneId, key),';
    const twice = 'client.sendTakeBackKey(paneId, key).then(() => client.sendTakeBackKey(paneId, key)),';
    const sources = files.map((entry) => (entry.file === RECHECK
      ? { file: RECHECK, source: entry.source.replace(pass, twice) } : entry));
    expect(sources.find(({ file }) => file === RECHECK)?.source).toContain(twice);
    expect(callerBreaches(sources)).toEqual([`${RECHECK}: one pass-through line (the key and one call), found 3`]);
  });

  it('the take-back module may call it from one place and name it as a type key; a second call is a breach', () => {
    const one = [...files, {
      file: TAKE_BACK,
      source: [
        "  readonly client: Pick<HerdrClient, 'readScreen' | 'sendTakeBackKey'>;",
        '      () => this.#deps.client.sendTakeBackKey(this.#paneId, key),',
      ].join('\n'),
    }];
    expect(callerBreaches(one)).toEqual([]);
    const wrapped = [...files, {
      file: TAKE_BACK,
      source: [
        "import type { TakeBackKey } from '../../herdr/dialogs/send/take-back-keys.ts';",
        '  readonly client: Pick<',
        "    HerdrClient, 'readScreen' | 'sendTakeBackKey'",
        '  >;',
        "      () => this.#deps.client['sendTakeBackKey'](this.#paneId, key),",
      ].join('\n'),
    }];
    expect(callerBreaches(wrapped)).toEqual([]);
    const two = [...files, {
      file: TAKE_BACK,
      source: [
        '      () => this.#deps.client.sendTakeBackKey(this.#paneId, TAKE_BACK_UP_KEY),',
        '      () => this.#deps.client.sendTakeBackKey(this.#paneId, TAKE_BACK_CLEAR_KEY),',
      ].join('\n'),
    }];
    expect(callerBreaches(two)).toEqual([`${TAKE_BACK}: sendTakeBackKey from one place, found 2`]);
  });

  it('a bracket access with a quoted name is a call: two of them in the take-back module are a breach', () => {
    const two = [...files, {
      file: TAKE_BACK,
      source: [
        "      () => this.#deps.client['sendTakeBackKey'](this.#paneId, TAKE_BACK_UP_KEY),",
        "      () => this.#deps.client['sendTakeBackKey'](this.#paneId, TAKE_BACK_CLEAR_KEY),",
      ].join('\n'),
    }];
    expect(callerBreaches(two)).not.toEqual([]);
  });

  it('the assertion and the list live in the key module and the client', () => {
    expect(usedIn(/\bassertTakeBackKey\b|\bTAKE_BACK_KEYS\b/).sort()).toEqual([CLIENT, KEY_MODULE]);
  });

  it('only the key module spells `ctrl+u`', () => {
    expect(literalIn('ctrl+u')).toEqual([KEY_MODULE]);
  });
});
