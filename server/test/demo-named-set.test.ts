/**
 * Named demo content sets (`RAROG_DEMO_CONTENT`, `server/src/demo/content/named-set.ts`): a set is a module in the
 * set directory of the install whose default export is a `DemoContent`.
 *
 * - Configuration: the name has the shape of a module file name; the set works only in the plain English demo; a name
 *   without a module in this build is refused at start, so `loadConfig` and `rarog serve --check` stop before the
 *   demo runs. No message carries the review code.
 * - Loading: the same resolver finds the module; an error of an existing module is reported as that error, not as a
 *   missing set.
 *
 * The cases run on the fixture sets in `fixtures/demo-sets/`, so they hold in a build with no named set of its own.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError, SERVER_ENV } from '../src/config-env.ts';
import { loadConfig } from '../src/config.ts';
import { parseDemoContent } from '../src/config/demo.ts';
import { demoContentEn } from '../src/demo/content/en.ts';
import { demoContent } from '../src/demo/content/index.ts';
import { demoSetFile, loadDemoSet } from '../src/demo/content/named-set.ts';
import { demoContentPl } from '../src/demo/content/pl.ts';
import sample from './fixtures/demo-sets/sample.ts';

const NAME = 'RAROG_DEMO_CONTENT';
const ORIGIN = 'https://demo.example.com';
const SETS = path.join(import.meta.dirname, 'fixtures', 'demo-sets');
const PLAIN = { demo: true, review: false, lang: 'en' } as const;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const freshDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'demo-named-set-'));
  dirs.push(dir);
  return dir;
};

/** `run` must throw `ConfigError` with the fragment; the message must not carry `secret`. */
function refused(run: () => unknown, fragment: RegExp, secret = ''): void {
  let message = '';
  try {
    run();
  } catch (err) {
    expect(err, 'expected ConfigError').toBeInstanceOf(ConfigError);
    message = (err as Error).message;
  }
  expect(message, 'the start passed instead of a refusal').not.toBe('');
  expect(message).toMatch(fragment);
  if (secret !== '') expect(message.includes(secret), 'the message carries the review code').toBe(false);
}

describe('`RAROG_DEMO_CONTENT`: configuration', () => {
  it('is a plain variable of the registry', () => {
    expect(SERVER_ENV[NAME]).toBe('plain');
  });

  it('unset or empty: no set, in the demo and outside it', () => {
    expect(loadConfig({ RAROG_DEMO: '1' }).demoSet).toBeNull();
    expect(loadConfig({ RAROG_DEMO: '1', [NAME]: '' }).demoSet).toBeNull();
    expect(loadConfig({ RAROG_ORIGINS: ORIGIN, RAROG_DATA_DIR: freshDir(), [NAME]: '' }).demoSet).toBeNull();
  });

  it('a set of the directory in the plain English demo, the value trimmed', () => {
    expect(parseDemoContent('sample', PLAIN, SETS)).toBe('sample');
    expect(parseDemoContent(' sample ', PLAIN, SETS)).toBe('sample');
  });

  it.each(['Sample', 'sample.ts', '../sample', '-sample', '1sample', 'sample set', 'sample/x'])(
    '%j: not the shape of a set name → `ConfigError`, also outside the demo', (value) => {
      const shape = /RAROG_DEMO_CONTENT must be a demo set name: lowercase letters, digits and hyphens/;
      refused(() => loadConfig({ RAROG_DEMO: '1', [NAME]: value }), shape);
      refused(() => loadConfig({ RAROG_ORIGINS: ORIGIN, RAROG_DATA_DIR: freshDir(), [NAME]: value }), shape);
    });

  it('a name without a module in this build → `ConfigError` at start', () => {
    refused(() => loadConfig({ RAROG_DEMO: '1', [NAME]: 'no-such-set' }),
      /^RAROG_DEMO_CONTENT=no-such-set: no such demo set in this build\.$/);
    refused(() => parseDemoContent('missing', PLAIN, SETS), /RAROG_DEMO_CONTENT=missing: no such demo set/);
    // A build without the set directory has no named set at all.
    refused(() => parseDemoContent('sample', PLAIN, path.join(freshDir(), 'absent')),
      /RAROG_DEMO_CONTENT=sample: no such demo set/);
  });

  it('a set outside the demo → `ConfigError`', () => {
    refused(() => parseDemoContent('sample', { ...PLAIN, demo: false }, SETS),
      /RAROG_DEMO_CONTENT works only with RAROG_DEMO=1/);
  });

  it('a set with the review code → `ConfigError` without the code', () => {
    const code = randomBytes(32).toString('base64url');
    refused(() => loadConfig({
      RAROG_DEMO: '1', RAROG_DEMO_REVIEW_CODE: code, RAROG_DATA_DIR: freshDir(), RAROG_ORIGINS: ORIGIN,
      [NAME]: 'sample',
    }), /RAROG_DEMO_CONTENT=sample does not work with RAROG_DEMO_REVIEW_CODE/, code);
    refused(() => parseDemoContent('sample', { ...PLAIN, review: true }, SETS),
      /RAROG_DEMO_CONTENT=sample does not work with RAROG_DEMO_REVIEW_CODE/);
  });

  it('a set with `RAROG_DEMO_LANG=pl` → `ConfigError`', () => {
    refused(() => loadConfig({ RAROG_DEMO: '1', RAROG_DEMO_LANG: 'pl', [NAME]: 'sample' }),
      /RAROG_DEMO_CONTENT=sample needs RAROG_DEMO_LANG=en/);
    refused(() => parseDemoContent('sample', { ...PLAIN, lang: 'pl' }, SETS),
      /RAROG_DEMO_CONTENT=sample needs RAROG_DEMO_LANG=en/);
  });
});

describe('the module of a named set', () => {
  it('the clone looks for TypeScript, the package for JavaScript', () => {
    expect(demoSetFile('sample', SETS, 'clone')).toBe(path.join(SETS, 'sample.ts'));
    expect(demoSetFile('sample', SETS, 'package')).toBeNull();
    expect(demoSetFile('../demo-sets/sample', SETS, 'clone')).toBeNull();
  });

  it('`demoContent` gives the named set when there is one, otherwise the set of the language', async () => {
    expect(await loadDemoSet('sample', SETS)).toBe(sample);
    expect(await demoContent('en', 'sample', SETS)).toBe(sample);
    expect(await demoContent('en')).toBe(demoContentEn);
    expect(await demoContent('en', null)).toBe(demoContentEn);
    expect(await demoContent('pl')).toBe(demoContentPl);
  });

  it('a set missing at load time → the `ConfigError` of the start', async () => {
    await expect(loadDemoSet('missing', SETS)).rejects.toThrow(ConfigError);
    await expect(loadDemoSet('missing', SETS)).rejects.toThrow('RAROG_DEMO_CONTENT=missing: no such demo set');
  });

  it('an existing module that fails to load → its own error, not a missing set', async () => {
    const failure = await loadDemoSet('broken', SETS).then(() => null, (err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ConfigError);
    expect((failure as Error).message).toContain('sample failure while loading the set');
  });

  it('a default export that is not a content set → an error naming the module', async () => {
    await expect(loadDemoSet('not-a-set', SETS)).rejects.toThrow(/not-a-set\.ts: the default export is not a demo/);
  });
});
