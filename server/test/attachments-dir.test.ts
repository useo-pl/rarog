/**
 * Katalog załączników: jeden (`UPLOAD_DIR_NAME`) dla zapisu, odczytu miniatur, sprzątania po TTL i wykluczenia
 * z gita. Import transkryptu i klucz echa poznają ścieżkę po pełnej nazwie tego katalogu, nie po samym sufiksie
 * `-uploads`.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { echoKey } from '../src/herdr/jsonl-follow.ts';
import { EXCLUDE_LINE, UPLOAD_DIR_NAME, createUploads } from '../src/herdr/uploads.ts';
import { parseTranscriptTail } from '../src/transcript-import.ts';

const NEW_DIR = '.rarog-uploads';
const OTHER_DIR = '.inne-uploads';
const NAME = '1788361542375-67f5f846e6fe49e7.png';
const OTHER = '1788361542376-77f5f846e6fe49e7.png';
const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA'
  + 'DUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let base = '';
let cwd = '';
const uploads = (): ReturnType<typeof createUploads> => createUploads({ now: () => NOW });

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'rarog-zalaczniki-'));
  cwd = join(base, 'projekt');
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true });
});

async function put(dir: string, name: string, body: string, ageMs = 0): Promise<string> {
  await mkdir(join(cwd, dir), { recursive: true });
  const path = join(cwd, dir, name);
  await writeFile(path, body);
  const when = new Date(NOW - ageMs);
  await utimes(path, when, when);
  return path;
}

describe('jeden katalog załączników', () => {
  it('nazwa katalogu i linia wykluczenia', () => {
    expect(UPLOAD_DIR_NAME).toBe(NEW_DIR);
    expect(EXCLUDE_LINE).toBe(`${NEW_DIR}/`);
  });

  it('`read`: zdjęcie z katalogu załączników; katalog o innej nazwie nie jest czytany', async () => {
    await put(NEW_DIR, NAME, 'nowy');
    await put(OTHER_DIR, OTHER, 'obcy');
    expect((await uploads().read(cwd, NAME))?.bytes.toString()).toBe('nowy');
    expect(await uploads().read(cwd, OTHER)).toBeNull();
  });

  it('dowiązanie w miejscu katalogu: `read` go nie przechodzi, sprzątanie pomija z ostrzeżeniem', async () => {
    const victim = join(base, 'ofiara');
    await mkdir(victim);
    await writeFile(join(victim, NAME), 'cudze');
    const when = new Date(NOW - 72 * HOUR);
    await utimes(join(victim, NAME), when, when);
    await symlink(victim, join(cwd, NEW_DIR));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await uploads().read(cwd, NAME)).toBeNull();
    await uploads().sweep(cwd);
    expect(await readdir(victim)).toEqual([NAME]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(NEW_DIR));
  });

  it('sprzątanie po TTL: katalog załączników, także `sweepAll` od korzenia; obcy katalog nietknięty', async () => {
    const old = await put(NEW_DIR, NAME, 'x', 72 * HOUR);
    const foreign = await put(OTHER_DIR, NAME, 'x', 72 * HOUR);
    await put(NEW_DIR, OTHER, 'x', HOUR);
    await uploads().sweep(cwd);
    await expect(readFile(old)).rejects.toThrow();
    expect(await readdir(join(cwd, NEW_DIR))).toEqual([OTHER]);

    const again = await put(NEW_DIR, NAME, 'x', 72 * HOUR);
    await uploads().sweepAll([base]);
    await expect(readFile(again)).rejects.toThrow();
    expect(await readFile(foreign, 'utf8')).toBe('x');
  });

  it('`.git/info/exclude` dostaje jedną linię raz; cudze linie zostają', async () => {
    await mkdir(join(cwd, '.git', 'info'), { recursive: true });
    await writeFile(join(cwd, '.git', 'info', 'exclude'), `# własne\n${OTHER_DIR}/\n`);
    await uploads().write(cwd, [PNG]);
    await uploads().write(cwd, [PNG]);
    const text = await readFile(join(cwd, '.git', 'info', 'exclude'), 'utf8');
    expect(text).toBe(`# własne\n${OTHER_DIR}/\n${EXCLUDE_LINE}\n`);
  });
});

describe('import transkryptu i klucz echa: pełna nazwa katalogu', () => {
  const CWD = '/Users/demo/Projects/willow';
  const user = (content: unknown, extra: Record<string, unknown> = {}): string => JSON.stringify({
    type: 'user', message: { role: 'user', content }, isSidechain: false,
    timestamp: '2026-10-30T10:00:00.000Z', ...extra,
  });
  const attachmentsOf = (path: string): unknown => parseTranscriptTail([
    user([
      { type: 'text', text: '[Image #1]co tu jest?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]),
    user([{ type: 'text', text: `[Image: source: ${path}]` }], { isMeta: true, turnCompanion: true }),
  ].join('\n'), { dropFirstLine: false }).messages[0]?.attachments;

  it('ścieżka z katalogu załączników daje miniaturę; inny katalog `-uploads`, obcy katalog i zła nazwa nie', () => {
    const card = [{ kind: 'image', name: '', bytes: 0, mime: 'image/png', file: NAME }];
    expect(attachmentsOf(`${CWD}/${NEW_DIR}/${NAME}`)).toEqual(card);
    expect(attachmentsOf(`${CWD}/${OTHER_DIR}/${NAME}`)).toBeUndefined();
    expect(attachmentsOf(`${CWD}/.cache/${NAME}`)).toBeUndefined();
    expect(attachmentsOf(`${CWD}/${NEW_DIR}/zrzut.png`)).toBeUndefined();
  });

  it('klucz echa zdejmuje doklejoną ścieżkę z katalogu załączników, innej nie', () => {
    expect(echoKey(`opisz\n${CWD}/${NEW_DIR}/${NAME}`)).toBe('opisz');
    expect(echoKey(`opisz ${CWD}/${NEW_DIR}/${NAME} ${CWD}/${NEW_DIR}/${OTHER}`)).toBe('opisz');
    expect(echoKey(`opisz\n${CWD}/${OTHER_DIR}/${NAME}`)).toBe(`opisz\n${CWD}/${OTHER_DIR}/${NAME}`);
    expect(echoKey(`opisz\n${CWD}/xrarog-uploads/${NAME}`)).toBe(`opisz\n${CWD}/xrarog-uploads/${NAME}`);
  });
});
