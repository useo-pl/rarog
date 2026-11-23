/**
 * Wywołanie `claude -p` agenta głosowego (`server/src/companion/cli.ts`) na ATRAPIE procesu: żaden test nie uruchamia
 * prawdziwego CLI ani żadnego API. Zdarzenia atrapy mają kształt wyjścia `stream-json` zmierzony na CLI 2.1.322. Atrapa to skrypt Node w katalogu tymczasowym; scenariusz czyta z pliku obok siebie
 * (env procesu jest z zamkniętej listy, więc nim nie da się atrapy sterować), a to, co dostała (argv, env, cwd,
 * zawartość cwd, fd 3, stdin), zapisuje do `record.json`.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COMPANION_ENV_PASSTHROUGH } from '../src/config-env.ts';
import {
  type AskOutcome, buildArgv, companionEnv, createCompanionCli, readRateLimit,
} from '../src/companion/cli.ts';
import { PRINT_FLAGS } from '../src/companion/cli-literals.ts';
import { buildMessage } from '../src/companion/prompt.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Scenario {
  /** Linie stdout (JSON zdarzeń albo cokolwiek). */
  lines?: unknown[];
  /** Tyle bajtów śmieci na stdout po liniach. */
  flood?: number;
  /** Tyle bajtów śmieci na stderr. */
  floodErr?: number;
  /** Proces nie kończy się sam (czeka na zabicie). */
  hang?: boolean;
  exitCode?: number;
}

interface Recorded {
  argv: string[];
  env: { [name: string]: string };
  cwd: string;
  cwdEntries: string[];
  fd3: string;
  stdin: string;
}

const FAKE = `
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
const fd3 = fs.readFileSync(3, 'utf8');
const stdin = fs.readFileSync(0, 'utf8');
fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({
  argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()),
  fd3, stdin,
}));
for (const line of scenario.lines ?? []) {
  process.stdout.write((typeof line === 'string' ? line : JSON.stringify(line)) + '\\n');
}
if (scenario.flood) process.stdout.write('x'.repeat(scenario.flood));
if (scenario.floodErr) process.stderr.write('e'.repeat(scenario.floodErr));
if (scenario.hang) setInterval(() => {}, 1000);
else process.exitCode = scenario.exitCode ?? 0;
`;

function fake(scenario: Scenario): { bin: string; dir: string; cwdRoot: string; record: () => Recorded } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rarog-companion-cli-')));
  dirs.push(dir);
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!${process.execPath}\n${FAKE}`);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
  return {
    bin, dir, cwdRoot: join(dir, 'data', 'companion-cwd'),
    record: () => JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8')) as Recorded,
  };
}

const INIT = { type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude-sonnet-5-5' };
const result = (text: string, isError = false): Record<string, unknown> => ({
  type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, result: text,
});
const rateLimit = (windows: Record<string, unknown>, status = 'allowed'): Record<string, unknown> => ({
  type: 'rate_limit_event',
  rate_limit_info: { status, rateLimitType: 'seven_day', overageStatus: 'rejected', unifiedWindows: windows },
});
const ANSWER = '<answer>Test przechodzi.</answer><found>yes</found><prompt></prompt>';

const BASE_ENV: NodeJS.ProcessEnv = {
  HOME: '/Users/demo', USER: 'test', PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: '/tmp/test/',
  SONIOX_API_KEY: 'syntetyczny', RAROG_IROH_KEY: 'syntetyczny', ANTHROPIC_API_KEY: 'syntetyczny',
  CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1', HERDR_PANE_ID: 'p1', SHELL: '/bin/zsh', LOGNAME: 'test',
};

describe('companion: argv, env i cwd procesu (strażniki)', () => {
  it('argv is `--model sonnet` and the exact isolation flags of the registry, no content', async () => {
    const f = fake({ lines: [INIT, result(ANSWER)] });
    const cli = createCompanionCli({ bin: f.bin, cwdRoot: f.cwdRoot, env: BASE_ENV });
    const outcome = await cli.ask({ sessionId: 's1', system: 'SYSTEM-TREŚĆ', question: 'PYTANIE-TREŚĆ' });
    expect(outcome).toMatchObject({ ok: true, text: ANSWER });
    const record = f.record();
    expect(record.argv).toEqual(buildArgv());
    expect(buildArgv()).toEqual(['--model', 'sonnet', ...PRINT_FLAGS.flags]);
    expect(PRINT_FLAGS.flags).toEqual([
      '-p', '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence',
      '--disable-slash-commands', '--tools', '', '--system-prompt-file', '/dev/fd/3', '--output-format',
      'stream-json', '--verbose',
    ]);
    expect(record.argv.join(' ')).not.toMatch(/TREŚĆ/u);
    expect(record.fd3).toBe('SYSTEM-TREŚĆ');
    expect(record.stdin).toBe(buildMessage('PYTANIE-TREŚĆ'));
  });

  it('env tylko z zamkniętej listy: bez sekretów Raroga, `ANTHROPIC_*`, `CLAUDE*` i `HERDR_*`', async () => {
    const f = fake({ lines: [result(ANSWER)] });
    await createCompanionCli({ bin: f.bin, cwdRoot: f.cwdRoot, env: BASE_ENV })
      .ask({ sessionId: 's1', system: 's', question: 'q' });
    const env = f.record().env;
    // macOS dokłada procesowi własną zmienną kodowania tekstu; nie pochodzi z env serwera.
    const names = Object.keys(env).filter((name) => name !== '__CF_USER_TEXT_ENCODING').sort();
    expect(names).toEqual([...COMPANION_ENV_PASSTHROUGH].sort());
    expect(COMPANION_ENV_PASSTHROUGH).toEqual(['HOME', 'USER', 'PATH', 'LANG', 'TMPDIR']);
    expect(companionEnv(BASE_ENV)).toEqual({
      HOME: '/Users/demo', USER: 'test', PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: '/tmp/test/',
    });
    expect(companionEnv({ HOME: '/h' })).toEqual({ HOME: '/h' });
  });

  it('cwd to pusty katalog pod `companion-cwd/` (0700), sprzątany po wyjściu', async () => {
    const f = fake({ lines: [result(ANSWER)] });
    await createCompanionCli({ bin: f.bin, cwdRoot: f.cwdRoot, env: BASE_ENV })
      .ask({ sessionId: 's1', system: 's', question: 'q' });
    const record = f.record();
    expect(record.cwd.startsWith(`${realpathSync(f.cwdRoot)}/`)).toBe(true);
    expect(record.cwdEntries).toEqual([]);
    expect(existsSync(record.cwd)).toBe(false);
    expect(statSync(f.cwdRoot).mode & 0o777).toBe(0o700);
  });
});

describe('companion: porażki procesu', () => {
  it('stdout ponad 64 kB → proces zabity, błąd `companion-cli`', async () => {
    const f = fake({ lines: [INIT], flood: 70 * 1024, hang: true });
    const started = Date.now();
    const outcome = await createCompanionCli({ bin: f.bin, cwdRoot: f.cwdRoot, env: BASE_ENV, timeoutMs: 20_000 })
      .ask({ sessionId: 's1', system: 's', question: 'q' });
    expect(outcome).toMatchObject({ ok: false, code: 'companion-cli', reason: 'stdout-cap' });
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('stderr ponad 64 kB → proces zabity, błąd `companion-cli`', async () => {
    const f = fake({ floodErr: 70 * 1024, hang: true });
    const outcome = await createCompanionCli({ bin: f.bin, cwdRoot: f.cwdRoot, env: BASE_ENV, timeoutMs: 20_000 })
      .ask({ sessionId: 's1', system: 's', question: 'q' });
    expect(outcome).toMatchObject({ ok: false, code: 'companion-cli', reason: 'stderr-cap' });
  });

  it('brak CLI → `companion-cli`', async () => {
    const f = fake({});
    const outcome = await createCompanionCli({ bin: join(f.dir, 'nie-ma'), cwdRoot: f.cwdRoot, env: BASE_ENV })
      .ask({ sessionId: 's1', system: 's', question: 'q' });
    expect(outcome).toMatchObject({ ok: false, code: 'companion-cli', reason: 'spawn' });
  });

  it('brak logowania (wynik z błędem, kod wyjścia 1) → `companion-cli`', async () => {
    const f = fake({ lines: [INIT, result('Not logged in (synthetic)', true)], exitCode: 1 });
    const outcome = await createCompanionCli({ bin: f.bin, cwdRoot: f.cwdRoot, env: BASE_ENV })
      .ask({ sessionId: 's1', system: 's', question: 'q' });
    expect(outcome).toMatchObject({ ok: false, code: 'companion-cli', reason: 'exit-1' });
  });

  it('wyjście bez zdarzenia `result` → `companion-cli`', async () => {
    const f = fake({ lines: [INIT, 'to nie JSON'] });
    const outcome = await createCompanionCli({ bin: f.bin, cwdRoot: f.cwdRoot, env: BASE_ENV })
      .ask({ sessionId: 's1', system: 's', question: 'q' });
    expect(outcome).toMatchObject({ ok: false, code: 'companion-cli', reason: 'no-result' });
  });

  it('limit czasu → proces zabity, `companion-timeout`', async () => {
    const f = fake({ lines: [INIT], hang: true });
    const outcome = await createCompanionCli({ bin: f.bin, cwdRoot: f.cwdRoot, env: BASE_ENV, timeoutMs: 1_500 })
      .ask({ sessionId: 's1', system: 's', question: 'q' });
    expect(outcome).toMatchObject({ ok: false, code: 'companion-timeout' });
  });

  it('przerwanie sygnałem → proces zabity, `aborted`', async () => {
    const f = fake({ lines: [INIT], hang: true });
    const controller = new AbortController();
    const pending = createCompanionCli({ bin: f.bin, cwdRoot: f.cwdRoot, env: BASE_ENV, timeoutMs: 20_000 })
      .ask({ sessionId: 's1', system: 's', question: 'q', signal: controller.signal });
    setTimeout(() => { controller.abort(); }, 300);
    expect(await pending).toMatchObject({ ok: false, code: 'aborted' });
  });
});

describe('companion: limit subskrypcji z `rate_limit_event` (CLI 2.1.322)', () => {
  it('`unifiedWindows` 0.85 `allowed_warning` → 0.85, nie wyczerpany', () => {
    expect(readRateLimit(rateLimit({ seven_day: { utilization: 0.85, status: 'allowed_warning' } })))
      .toEqual({ utilization: 0.85, exhausted: false });
  });

  it('`rejected` w oknie → wyczerpany; utilization to maksimum okien', () => {
    expect(readRateLimit(rateLimit({
      five_hour: { utilization: 1, status: 'rejected' }, seven_day: { utilization: 0.4, status: 'allowed' },
    }))).toEqual({ utilization: 1, exhausted: true });
    expect(readRateLimit(rateLimit({
      five_hour: { utilization: 0.2, status: 'allowed' }, seven_day: { utilization: 0.71, status: 'allowed' },
    }))).toEqual({ utilization: 0.71, exhausted: false });
  });

  it('`overageStatus: rejected` nie wyczerpuje; status główny poza `allowed*` tak', () => {
    expect(readRateLimit(rateLimit({ seven_day: { utilization: 0.5, status: 'allowed' } })).exhausted).toBe(false);
    expect(readRateLimit(rateLimit({}, 'rejected'))).toEqual({ utilization: null, exhausted: true });
    expect(readRateLimit({ type: 'rate_limit_event' })).toEqual({ utilization: null, exhausted: false });
  });

  it('zdarzenie `rejected` i wynik z błędem → `companion-limit`', async () => {
    const f = fake({
      lines: [INIT, rateLimit({ five_hour: { utilization: 1, status: 'rejected' } }, 'rejected'),
        result('limit reached (synthetic)', true)],
      exitCode: 1,
    });
    const outcome = await createCompanionCli({ bin: f.bin, cwdRoot: f.cwdRoot, env: BASE_ENV })
      .ask({ sessionId: 's1', system: 's', question: 'q' });
    expect(outcome).toMatchObject({ ok: false, code: 'companion-limit', limit: { utilization: 1, exhausted: true } });
  });

  it('odpowiedź przy `allowed_warning` przechodzi z odczytem limitu', async () => {
    const f = fake({ lines: [INIT, rateLimit({ seven_day: { utilization: 0.85, status: 'allowed_warning' } }),
      result(ANSWER)] });
    const outcome = await createCompanionCli({ bin: f.bin, cwdRoot: f.cwdRoot, env: BASE_ENV })
      .ask({ sessionId: 's1', system: 's', question: 'q' });
    expect(outcome).toMatchObject({ ok: true, text: ANSWER, limit: { utilization: 0.85, exhausted: false } });
  });
});

describe('companion: pytania w locie', () => {
  it('jedno na sesję i dwa na serwer; po zakończeniu miejsce wraca', async () => {
    const f = fake({ lines: [INIT], hang: true });
    const cli = createCompanionCli({ bin: f.bin, cwdRoot: f.cwdRoot, env: BASE_ENV, timeoutMs: 1_500 });
    const first = cli.ask({ sessionId: 's1', system: 's', question: 'q' });
    const same: AskOutcome = await cli.ask({ sessionId: 's1', system: 's', question: 'q' });
    expect(same).toMatchObject({ ok: false, code: 'companion-busy' });
    const second = cli.ask({ sessionId: 's2', system: 's', question: 'q' });
    expect(await cli.ask({ sessionId: 's3', system: 's', question: 'q' }))
      .toMatchObject({ ok: false, code: 'companion-busy' });
    expect(cli.running).toBe(2);
    await Promise.all([first, second]);
    expect(cli.running).toBe(0);
  });
});
