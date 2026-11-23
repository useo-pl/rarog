/**
 * Skrypt `statusLine` Raroga (`scripts/hooks/rarog-statusline.mjs`): zrzut payloadu paska statusu do
 * `~/.claude/statusline/<session_id>.json` i krótka linia paska. Kontrakt jest procesowy (stdin → plik, stdout →
 * pasek, kod zawsze 0), więc każdy test uruchamia skrypt jako proces z `HOME` w katalogu tymczasowym. Zrzut czyta
 * ten sam moduł co serwer (`server/src/herdr/statusline.ts`) — test w obie strony.
 */
import { spawn } from 'node:child_process';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STATUSLINE_INSTALLED_SCRIPT_REL, statuslineCommand } from '../src/herdr/hook-config.ts';
import { STATUSLINE_MAX_BYTES, readFreshestRateLimits, readStatusline } from '../src/herdr/statusline.ts';
import { TEST_SESSION_PREFIX, realRarogDirsCreated } from './rarog-home.ts';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'hooks', 'rarog-statusline.mjs');
const SESSION = `${TEST_SESSION_PREFIX}550e8400-e29b-41d4-a716-446655440000`;
/** Reset okna w przyszłości (sekundy epoki), żeby czytelnik limitów uznał je za żywe. */
const RESET = Math.floor(Date.now() / 1000) + 3600;

let home = '';
const dumps = (): string => join(home, '.claude', 'statusline');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rarog-statusline-'));
  mkdirSync(join(home, '.claude'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

afterAll(() => {
  expect(realRarogDirsCreated()).toEqual([]);
});

/** Payload w kształcie z CLI (pola, które czyta serwer, plus `rate_limits`). */
function payload(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: SESSION,
    model: { id: 'claude-opus-5', display_name: 'Opus' },
    context_window: { context_window_size: 1_000_000, used_percentage: 48.4 },
    rate_limits: { five_hour: { used_percentage: 40, resets_at: RESET } },
    ...extra,
  });
}

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly ms: number;
}

/**
 * Uruchamia skrypt (albo komendę przez `sh -c`). `stdin: null` = nic nie piszemy, `end: false` = bez EOF.
 */
function run(opts: {
  readonly stdin?: string | Buffer | null;
  readonly end?: boolean;
  readonly env?: Record<string, string>;
  readonly shell?: string;
}): Promise<Run> {
  const started = Date.now();
  const env = {
    PATH: `${dirname(process.execPath)}:${process.env['PATH'] ?? ''}`, HOME: home, ...opts.env,
  };
  return new Promise((resolve, reject) => {
    const child = opts.shell === undefined
      ? spawn(process.execPath, [SCRIPT], { env, stdio: ['pipe', 'pipe', 'ignore'] })
      : spawn('sh', ['-c', opts.shell], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => { resolve({ code, stdout, ms: Date.now() - started }); });
    // Skrypt może zamknąć stdin przed końcem zapisu (ponad sufit) — to nie błąd testu.
    child.stdin.on('error', () => {});
    if (opts.stdin === null) return;
    if (opts.end === false) child.stdin.write(opts.stdin ?? '');
    else child.stdin.end(opts.stdin ?? '');
  });
}

/** Czy proces żyje (sygnał 0; zombie oczekujący na zebranie też się liczy). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (failure) {
    return (failure as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Czeka, aż warunek będzie prawdziwy (do 5 s), inaczej przewraca test. */
async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('warunek nie spełnił się w 5 s');
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
}

/** Wpisy katalogu zrzutów (pusta lista także przy braku katalogu). */
function entries(): string[] {
  return existsSync(dumps()) ? readdirSync(dumps()).sort() : [];
}

describe('rarog-statusline.mjs: zrzut i linia paska', () => {
  it('payload → zrzut bajt w bajt, czytany przez `herdr/statusline.ts`; linia „model · procent”', async () => {
    const text = payload();
    const result = await run({ stdin: text });
    expect(result).toMatchObject({ code: 0, stdout: 'Opus · 48%\n' });
    const file = join(dumps(), `${SESSION}.json`);
    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(lstatSync(dumps()).mode & 0o777, 'brak katalogu = mkdir 0700').toBe(0o700);
    expect(entries(), 'bez plików tymczasowych').toEqual([`${SESSION}.json`]);

    expect(await readStatusline(dumps(), SESSION)).toEqual({
      contextWindow: 1_000_000, usedPercentage: 48.4, model: 'claude-opus-5',
    });
    expect(await readFreshestRateLimits(dumps(), Date.now())).toMatchObject({
      fiveHour: { percent: 40, resetsAt: new Date(RESET * 1000).toISOString() },
    });
  });

  it('stdin równy sufitowi czytelnika (64 KiB) → zrzut; o bajt więcej → bez zrzutu, kod 0', async () => {
    const base = payload({ pad: '' });
    const exact = payload({ pad: 'x'.repeat(STATUSLINE_MAX_BYTES - Buffer.byteLength(base)) });
    expect(Buffer.byteLength(exact)).toBe(STATUSLINE_MAX_BYTES);
    expect((await run({ stdin: exact })).code).toBe(0);
    expect(await readStatusline(dumps(), SESSION)).toMatchObject({ model: 'claude-opus-5' });

    rmSync(dumps(), { recursive: true });
    const over = payload({ pad: 'x'.repeat(STATUSLINE_MAX_BYTES - Buffer.byteLength(base) + 1) });
    const result = await run({ stdin: over });
    expect(result).toMatchObject({ code: 0, stdout: '\n' });
    expect(entries()).toEqual([]);
  });

  it('stdin bez EOF → koniec po limicie czasu, kod 0, bez zrzutu', async () => {
    const result = await run({ stdin: payload(), end: false });
    expect(result.code).toBe(0);
    expect(result.ms).toBeLessThan(5000);
    expect(entries()).toEqual([]);
  });

  it('zły JSON, nie-obiekt i pusty stdin → bez zrzutu, kod 0, pusta linia', async () => {
    for (const stdin of ['{"session_id":', '[1,2]', '"tekst"', '']) {
      const result = await run({ stdin });
      expect(result, stdin).toEqual({ code: 0, stdout: '\n', ms: expect.any(Number) as number });
    }
    expect(entries()).toEqual([]);
  });

  it('`session_id` spoza `^[A-Za-z0-9-]{1,128}$` → bez zrzutu (nazwa pliku z cudzego napisu)', async () => {
    for (const id of ['../ucieczka', 'a/b', 'a.b', '', 'x'.repeat(129), 'ąę', 42, null]) {
      const result = await run({ stdin: payload({ session_id: id }) });
      expect(result.code, String(id)).toBe(0);
      expect(result.stdout, String(id)).toBe('Opus · 48%\n');
    }
    expect(entries()).toEqual([]);
    expect(existsSync(join(home, 'ucieczka.json'))).toBe(false);
  });

  it('`~/.claude/statusline` jako dowiązanie → bez zrzutu, cel nietknięty', async () => {
    const target = join(home, 'gdzie-indziej');
    mkdirSync(target);
    symlinkSync(target, dumps());
    const result = await run({ stdin: payload() });
    expect(result.code).toBe(0);
    expect(readdirSync(target)).toEqual([]);
  });

  it('nieudany `rename` (katalog pod nazwą zrzutu) → bez zrzutu, plik tymczasowy sprzątnięty, kod 0', async () => {
    mkdirSync(join(dumps(), `${SESSION}.json`), { recursive: true });
    const result = await run({ stdin: payload() });
    expect(result).toMatchObject({ code: 0, stdout: 'Opus · 48%\n' });
    expect(entries()).toEqual([`${SESSION}.json`]);
    expect(lstatSync(join(dumps(), `${SESSION}.json`)).isDirectory()).toBe(true);
  });

  it('brak `~/.claude` → bez zrzutu i bez zakładania katalogu domowego Claude Code', async () => {
    rmSync(join(home, '.claude'), { recursive: true });
    const result = await run({ stdin: payload() });
    expect(result.code).toBe(0);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });
});

describe('rarog-statusline.mjs: łańcuch `RAROG_STATUSLINE_CHAIN`', () => {
  it('komenda dostaje ten sam payload na stdin, skrypt wypisuje jej wyjście; zrzut jest', async () => {
    const text = payload();
    const result = await run({ stdin: text, env: { RAROG_STATUSLINE_CHAIN: 'wc -c' } });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(String(Buffer.byteLength(text)));
    expect(entries()).toEqual([`${SESSION}.json`]);
  });

  it('pusta `RAROG_STATUSLINE_CHAIN` = bez łańcucha: własna linia skryptu', async () => {
    expect((await run({ stdin: payload(), env: { RAROG_STATUSLINE_CHAIN: 'echo nowa' } })).stdout).toBe('nowa\n');
    expect((await run({ stdin: payload(), env: { RAROG_STATUSLINE_CHAIN: '' } })).stdout).toBe('Opus · 48%\n');
  });

  it('komenda ponad limit 2 s → zabita, własna linia, kod 0, zrzut jest', async () => {
    const result = await run({ stdin: payload(), env: { RAROG_STATUSLINE_CHAIN: 'sleep 20; echo za-pozno' } });
    expect(result).toMatchObject({ code: 0, stdout: 'Opus · 48%\n' });
    expect(result.ms).toBeLessThan(6000);
    expect(entries()).toEqual([`${SESSION}.json`]);
  });

  it('sygnał przerywający skrypt (kolejny render paska) zabija łańcuch; kod 0', async () => {
    const pidFile = join(home, 'pid');
    const child = spawn(process.execPath, [SCRIPT], {
      env: { PATH: process.env['PATH'] ?? '', HOME: home, RAROG_STATUSLINE_CHAIN: `echo $$ > '${pidFile}'; exec sleep 30` },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const closed = new Promise<number | null>((resolve) => { child.on('close', resolve); });
    child.stdin.end(payload());
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(alive(pid)).toBe(true);
    child.kill('SIGTERM');
    expect(await closed).toBe(0);
    await waitFor(() => !alive(pid));
  });

  it('potomek łańcucha w tle z przekierowanymi strumieniami ginie po zwykłym końcu skryptu', async () => {
    const pidFile = join(home, 'pid');
    const result = await run({
      stdin: payload(), env: { RAROG_STATUSLINE_CHAIN: `sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'; echo gotowe` },
    });
    expect(result).toMatchObject({ code: 0, stdout: 'gotowe\n' });
    await waitFor(() => !alive(Number(readFileSync(pidFile, 'utf8').trim())));
  });

  it('komenda z `statuslineCommand` przez powłokę: kopia w `~/.claude/hooks/rarog/` i łańcuch z apostrofem', async () => {
    const copy = join(home, STATUSLINE_INSTALLED_SCRIPT_REL);
    mkdirSync(dirname(copy), { recursive: true });
    copyFileSync(SCRIPT, copy);
    const result = await run({ stdin: payload(), shell: statuslineCommand(home, "printf '%s' \"it's mine\"") });
    expect(result).toMatchObject({ code: 0, stdout: "it's mine" });
    expect(entries()).toEqual([`${SESSION}.json`]);
  });
});
