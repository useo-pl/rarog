/**
 * Znacznik per plik wejściowy hooka i katalog danych hooka.
 *
 * Trzy rzeczy, dwie pierwsze na procesie hooka uruchomionym z kopii w katalogu tymczasowym:
 * - znacznik per plik wejściowy `hook-seen.<plik>.json` obok wspólnego `hook-seen.json`: dwie kopie pod dwiema
 *   nazwami pliku dają osobne znaczniki, a serwer czyta je przez `readHookSeenByFile` i `hookHealth`;
 * - hook nie zakłada katalogu danych: przeniesiony między odczytem korzeni a zapisem nie wraca pod starą ścieżką,
 *   a zapis milknie;
 * - czytnik zrzutu rozpoznaje marker przycięcia `rarogTruncated`.
 */
import { spawn } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HOOK_SEEN_FILENAME, HOOK_SEEN_PER_FILE_RE, hookHealth, hookScriptPath, readHookSeenAt, readHookSeenByFile,
  writeHookRoots,
} from '../src/herdr/hook-config.ts';
import { isTruncatedHookInput } from '../src/herdr/dialogs/hook/dump.ts';

const HOOKS = join(import.meta.dirname, '..', '..', 'scripts', 'hooks');
/** Nazwy plików wejściowych dwóch kopii: inna niż bieżąca i bieżąca (znacznik bierze nazwę z pliku, którym biegnie). */
const OLD_ENTRY = 'stary-pending.mjs';
const NEW_ENTRY = 'rarog-pending.mjs';
const seenFile = (entry: string): string => `hook-seen.${entry.replace(/\.mjs$/, '')}.json`;
const SESSION = '550e8400-e29b-41d4-a716-446655440000';

let base = '';
let data = '';
let project = '';

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'rarog-hook-per-plik-'));
  data = join(base, 'dane');
  project = join(base, 'Projects', 'demo');
  mkdirSync(project, { recursive: true });
  mkdirSync(join(data, 'pending'), { recursive: true, mode: 0o700 });
  writeHookRoots(data, [join(base, 'Projects')], { tallDialogGuard: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/**
 * Kopia hooka pod nazwą `entry` w osobnym katalogu, z modułami obok (jak `~/.claude/hooks/rarog/`). `guard` podmienia
 * strażnika wysokości dialogu (moduł ładowany dynamicznie PO odczycie korzeni).
 */
function copyHook(dir: string, entry: string, guard?: string): string {
  const target = join(base, dir);
  mkdirSync(target);
  copyFileSync(hookScriptPath(), join(target, entry));
  copyFileSync(join(HOOKS, 'canon.mjs'), join(target, 'canon.mjs'));
  copyFileSync(join(HOOKS, 'work-area.mjs'), join(target, 'work-area.mjs'));
  if (guard === undefined) copyFileSync(join(HOOKS, 'tall-dialog.mjs'), join(target, 'tall-dialog.mjs'));
  else writeFileSync(join(target, 'tall-dialog.mjs'), guard);
  return join(target, entry);
}

/** Prośba o zgodę `Bash` w sesji herdr (droga przez strażnika), zrzut do `pending/<sesja>.json`. */
function runHook(script: string, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string }> {
  const child = spawn(process.execPath, [script], {
    env: { PATH: process.env['PATH'] ?? '', HOME: base, RAROG_DATA_DIR: data, HERDR_ENV: '1', ...env },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const done = new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => { resolve({ code, stdout }); });
  });
  child.stdin.end(JSON.stringify({
    session_id: SESSION, cwd: project, hook_event_name: 'PermissionRequest', tool_name: 'Bash',
    tool_input: { command: 'ls' },
  }));
  return done;
}

const pendingFile = (dir: string): string => join(dir, 'pending', `${SESSION}.json`);

describe('znacznik per plik wejściowy', () => {
  it('dwie kopie pod dwiema nazwami, wywołane równolegle i po restarcie serwera, dają osobne znaczniki', async () => {
    const old = copyHook('kopia-stara', OLD_ENTRY);
    const renamed = copyHook('kopia-nowa', NEW_ENTRY);

    expect(await Promise.all([runHook(old), runHook(renamed)])).toEqual([
      { code: 0, stdout: '' }, { code: 0, stdout: '' },
    ]);
    const first = readHookSeenByFile(data);
    expect(Object.keys(first).sort()).toEqual([OLD_ENTRY, NEW_ENTRY].sort());
    // Restart serwera między wywołaniami: `roots.json` zapisany od nowa, znaczniki per plik zostają.
    writeHookRoots(data, [join(base, 'Projects')], { tallDialogGuard: true });
    await runHook(renamed);
    const second = readHookSeenByFile(data);
    expect(second[OLD_ENTRY]).toBe(first[OLD_ENTRY]);
    expect(second[NEW_ENTRY]).toBeGreaterThanOrEqual(first[NEW_ENTRY] ?? Infinity);

    // Wspólny znacznik pisze każda kopia: z niego `/health` liczy `hookSeenAgo`.
    expect(readHookSeenAt(data)).toBe(second[NEW_ENTRY]);
    const markers = readdirSync(data).filter((name) => name.startsWith('hook-seen')).sort();
    expect(markers).toEqual([HOOK_SEEN_FILENAME, seenFile(OLD_ENTRY), seenFile(NEW_ENTRY)].sort());
    expect(JSON.parse(readFileSync(join(data, seenFile(NEW_ENTRY)), 'utf8')))
      .toEqual(JSON.parse(readFileSync(join(data, HOOK_SEEN_FILENAME), 'utf8')));

    const now = (second[NEW_ENTRY] ?? 0) + 7_000;
    expect(hookHealth({ settingsPaths: [], dataDir: data, home: base, nowMs: now }).seenAgoByFile).toEqual({
      [OLD_ENTRY]: Math.floor((now - (first[OLD_ENTRY] ?? 0)) / 1000), [NEW_ENTRY]: 7,
    });
  });

  it('plik wejściowy spoza wzorca nazwy pisze tylko wspólny znacznik', async () => {
    await runHook(copyHook('kopia', 'Zla_Nazwa.mjs'));
    expect(existsSync(pendingFile(data))).toBe(true);
    expect(readdirSync(data).filter((name) => name.startsWith('hook-seen'))).toEqual([HOOK_SEEN_FILENAME]);
    expect(readHookSeenByFile(data)).toEqual({});
    expect(hookHealth({ settingsPaths: [], dataDir: data, home: base }).seenAgoByFile).toBeUndefined();
  });

  it('czytnik: dowiązanie, zły JSON, obca nazwa i nadmiar plików nie przechodzą', () => {
    const put = (name: string, body: unknown): void => {
      writeFileSync(join(data, name), typeof body === 'string' ? body : JSON.stringify(body));
    };
    put('hook-seen.dobry.json', { at: 5 });
    put('hook-seen.zepsuty.json', '{');
    put('hook-seen.bez-czasu.json', { at: 'wczoraj' });
    put('hook-seen.Zla-Nazwa.json', { at: 6 });
    put('cudzy.json', { at: 7 });
    symlinkSync(join(data, 'hook-seen.dobry.json'), join(data, 'hook-seen.dowiazanie.json'));
    expect(readHookSeenByFile(data)).toEqual({ 'dobry.mjs': 5 });
    expect(HOOK_SEEN_PER_FILE_RE.test('hook-seen.json')).toBe(false);

    const many = join(base, 'wiele');
    mkdirSync(many);
    for (let i = 0; i < 20; i += 1) {
      writeFileSync(join(many, `hook-seen.k${String(i).padStart(2, '0')}.json`), JSON.stringify({ at: i }));
    }
    expect(Object.keys(readHookSeenByFile(many))).toHaveLength(16);
    expect(readHookSeenByFile(join(base, 'brak'))).toEqual({});
  });
});

describe('hook nie zakłada katalogu danych (przeniesienie katalogu w trakcie wywołania)', () => {
  /** Strażnik-atrapa: przenosi katalog danych, gdy hook już przeczytał korzenie, i nie wydaje werdyktu. */
  const MOVE_GUARD = [
    "import { renameSync } from 'node:fs';",
    "const from = process.env['TEST_MOVE_FROM'];",
    "if (typeof from === 'string' && from !== '') renameSync(from, `${from}-przeniesiony`);",
    'export const paneFromEnv = () => null;',
    '',
  ].join('\n');

  it('kontrola: ta sama atrapa bez przenosin przepuszcza zapis zrzutu i obu znaczników', async () => {
    const result = await runHook(copyHook('kopia', NEW_ENTRY, MOVE_GUARD));
    expect(result).toEqual({ code: 0, stdout: '' });
    expect(existsSync(pendingFile(data))).toBe(true);
    expect(Object.keys(readHookSeenByFile(data))).toEqual([NEW_ENTRY]);
  });

  it('katalog przeniesiony po odczycie korzeni: stara ścieżka nie wraca, nic nie zapisane, exit 0', async () => {
    const result = await runHook(copyHook('kopia', NEW_ENTRY, MOVE_GUARD), { TEST_MOVE_FROM: data });
    expect(result).toEqual({ code: 0, stdout: '' });
    expect(existsSync(data)).toBe(false);
    // W przeniesionym katalogu ani zrzutu, ani znacznika (dziennik cienia mógł dostać linię startu PRZED `mv`).
    const moved = `${data}-przeniesiony`;
    expect(readdirSync(moved).filter((name) => name !== 'shadow.jsonl').sort()).toEqual(['pending', 'roots.json']);
    expect(readdirSync(join(moved, 'pending'))).toEqual([]);
  });
});

describe('marker przycięcia zrzutu', () => {
  it('przyjmuje pole `rarogTruncated`, tylko z wartością `true`', () => {
    expect(isTruncatedHookInput({ rarogTruncated: true, preview: '' })).toBe(true);
    expect(isTruncatedHookInput({ rarogTruncated: 'true' })).toBe(false);
    expect(isTruncatedHookInput({ command: 'ls' })).toBe(false);
    expect(isTruncatedHookInput(null)).toBe(false);
  });
});
