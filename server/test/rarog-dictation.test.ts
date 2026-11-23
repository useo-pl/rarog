/**
 * `rarog dictation set-key|status`: klucz Soniox serwera w pliku sekretów `~/.config/rarog/secret/private.env`.
 *
 * Komenda biegnie przez `main` z własnym `CliIo` (`HOME` w katalogu tymczasowym, atrapy `askSecret` i `readStdin`
 * z licznikami); pytanie bez echa i odczyt potoku przez prawdziwe `askSecretOn` i `readAllOn` na atrapach strumieni;
 * jeden test woła prawdziwe `bin/rarog.mjs` z kluczem na stdin. Wartości są syntetyczne. Po każdym przypadku wartość
 * stoi najwyżej w `private.env`: nie ma jej na stdout, na stderr ani w innym pliku pod `HOME` testu.
 */
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { REPAIR, rarogCli } from '../src/install/repair.ts';
import { DICTATION_USAGE, dictationCommand } from '../src/cli/dictation.ts';
import { SECRET_WRITES } from '../src/cli/secrets-file.ts';
import type { SecretWrites } from '../src/cli/secrets-file.ts';
import type { CliIo } from '../src/cli/io.ts';
import { USAGE, main } from '../src/cli/main.ts';
import {
  SECRET_MAX_BYTES, SecretInputTooLong, askSecretOn, readAllOn, secretInput,
} from '../src/cli/secret-input.ts';
import { buildServeEnv, readPrivateEnv } from '../src/cli/serve.ts';
import { realRarogDirsCreated, tempHome } from './rarog-home.ts';
import type { TempHome } from './rarog-home.ts';

const REPO = path.join(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'rarog.mjs');
/** Sztuczny klucz: prawdziwego testy nie znają. */
const KEY = 'soniox-cli-test-key-1';
const OLD = 'old-test-key';
const ENV_VALUE = 'soniox-cli-env-value-1';
const MAX_FILE_BYTES = 64 * 1024;

let t: TempHome;
let home = '';
beforeEach(() => {
  t = tempHome('rarog-dictation-');
  home = t.home;
});
afterEach(() => { t.cleanup(); });
afterAll(() => { expect(realRarogDirsCreated()).toEqual([]); });

const configDir = (): string => path.join(home, '.config', 'rarog');
const secretDir = (): string => path.join(configDir(), 'secret');
const secretFile = (): string => path.join(secretDir(), 'private.env');

/** Plik sekretów z podanymi prawami (domyślnie poprawnymi). */
function writeSecrets(text: string, fileMode = 0o600, dirMode = 0o700): void {
  mkdirSync(secretDir(), { recursive: true });
  chmodSync(secretDir(), dirMode);
  writeFileSync(secretFile(), text);
  chmodSync(secretFile(), fileMode);
}

function writeConfig(value: unknown): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(configDir(), 'config.json'), JSON.stringify(value));
}

const mode = (file: string): number => lstatSync(file).mode & 0o777;
const fileText = (): string => readFileSync(secretFile(), 'utf8');

/** Pliki tymczasowe zapisu w katalogu sekretów. */
function tmpFiles(): string[] {
  return existsSync(secretDir()) ? readdirSync(secretDir()).filter((name) => name.endsWith('.tmp')) : [];
}

/** Pliki zwykłe pod `HOME` testu z napisem `value`, poza `private.env`. */
function filesWith(value: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) walk(file);
      else if (item.isFile() && file !== secretFile() && readFileSync(file).includes(value)) out.push(file);
    }
  };
  walk(home);
  return out;
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Wywołania `askSecret` (prompty). */
  readonly asked: string[];
  /** Wywołania `readStdin` (sufity). */
  readonly read: number[];
}

interface RunOptions {
  /** Wejście potoku: odpowiedź `readStdin`. Bez `stdin` i `ask` io nie ma żadnej drogi wejścia. */
  readonly stdin?: string;
  /** Terminal: odpowiedź `askSecret` albo funkcja (atrapa robi coś w czasie pytania). */
  readonly ask?: string | null | (() => Promise<string | null>);
  /** Obie drogi naraz (sprawdzenie, że komenda nie sięga po żadną). */
  readonly both?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly writes?: SecretWrites;
  readonly io?: Partial<CliIo>;
}

/** Środowisko komendy: dom testu, bez `SONIOX_API_KEY` (chyba że test go poda). */
function envOf(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HOME: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin', XDG_DATA_HOME: path.join(home, 'xdg'), ...extra };
}

async function run(argv: readonly string[], opts: RunOptions = {}): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const asked: string[] = [];
  const read: number[] = [];
  const ask = opts.ask;
  const io: CliIo = {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    env: envOf(opts.env),
    cwd: home,
    ...(ask === undefined && opts.both !== true ? {} : {
      askSecret: (prompt: string) => {
        asked.push(prompt);
        if (typeof ask === 'function') return ask();
        return Promise.resolve(ask ?? null);
      },
    }),
    ...(opts.stdin === undefined && opts.both !== true ? {} : {
      readStdin: (maxBytes: number) => {
        read.push(maxBytes);
        return Promise.resolve(opts.stdin ?? '');
      },
    }),
    ...opts.io,
  };
  const code = opts.writes === undefined
    ? await main(argv, io)
    : await dictationCommand(argv, io, { writes: opts.writes });
  return { code, stdout, stderr, asked, read };
}

/** Wartość tylko w `private.env`: ani na stdout, ani na stderr, ani w innym pliku pod `HOME`. */
function expectNoLeak(result: Run, value = KEY): void {
  expect(result.stdout).not.toContain(value);
  expect(result.stderr).not.toContain(value);
  expect(filesWith(value)).toEqual([]);
}

const SET_KEY = ['dictation', 'set-key'] as const;
const STATUS = ['dictation', 'status'] as const;

describe('rarog dictation set-key: zapis', () => {
  it('1: brak katalogu secret, klucz z potoku → katalog 0700, plik 0600, jedna linia; stdout bez wartości', async () => {
    const result = await run(SET_KEY, { stdin: `${KEY}\n` });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.read).toEqual([SECRET_MAX_BYTES]);
    expect(mode(secretDir())).toBe(0o700);
    expect(mode(configDir())).toBe(0o700);
    expect(mode(secretFile())).toBe(0o600);
    expect(fileText()).toBe(`SONIOX_API_KEY=${KEY}\n`);
    expect(result.stdout).toContain(secretFile());
    expect(result.stdout).toContain('added');
    expect(result.stdout).toContain(REPAIR.restart);
    expect(result.stdout).toMatch(/EU region/u);
    expect(result.stdout).not.toContain('shell');
    expect(tmpFiles()).toEqual([]);
    expectNoLeak(result);
  });

  it('2: inne linie zostają bajt w bajt, zmienia się tylko linia Soniox; prawa 0600, „replaced”', async () => {
    writeSecrets(`# comment\nRAROG_APNS_KEY_ID=TESTKEYID1\nSONIOX_API_KEY=${OLD}\n`);
    const result = await run(SET_KEY, { stdin: `${KEY}\n` });
    expect(result.code).toBe(0);
    expect(fileText()).toBe(`# comment\nRAROG_APNS_KEY_ID=TESTKEYID1\nSONIOX_API_KEY=${KEY}\n`);
    expect(mode(secretFile())).toBe(0o600);
    expect(result.stdout).toContain('replaced');
    expect(result.stdout).not.toContain('added');
    expect(tmpFiles()).toEqual([]);
    expectNoLeak(result);
  });

  it('2: bajty spoza UTF-8 w innych liniach przechodzą bez zmian', async () => {
    writeSecrets('');
    const before = Buffer.concat([Buffer.from('# \xff\xfe '), Buffer.from([0xc3, 0x28]), Buffer.from('\n')]);
    writeFileSync(secretFile(), before);
    const result = await run(SET_KEY, { stdin: KEY });
    expect(result.code).toBe(0);
    expect(readFileSync(secretFile())).toEqual(Buffer.concat([before, Buffer.from(`SONIOX_API_KEY=${KEY}\n`)]));
  });

  it('3: linia Soniox z \\r\\n → zamieniona z zachowanym \\r\\n', async () => {
    writeSecrets(`RAROG_APNS_KEY_ID=TESTKEYID1\r\nSONIOX_API_KEY=${OLD}\r\n# end\r\n`);
    const result = await run(SET_KEY, { stdin: `${KEY}\n` });
    expect(result.code).toBe(0);
    expect(fileText()).toBe(`RAROG_APNS_KEY_ID=TESTKEYID1\r\nSONIOX_API_KEY=${KEY}\r\n# end\r\n`);
    expectNoLeak(result);
  });

  it('3: nazwa z odstępami przed „=” to ta sama linia (jak w parserze serwera)', async () => {
    writeSecrets(`  SONIOX_API_KEY =${OLD}\n`);
    const result = await run(SET_KEY, { stdin: KEY });
    expect(result.code).toBe(0);
    expect(fileText()).toBe(`SONIOX_API_KEY=${KEY}\n`);
  });

  it('4: plik bez końcowej nowej linii i bez linii Soniox → linia dopisana po \\n', async () => {
    writeSecrets('# a\nRAROG_APNS_KEY_ID=TESTKEYID1');
    const result = await run(SET_KEY, { stdin: `${KEY}\n` });
    expect(result.code).toBe(0);
    expect(fileText()).toBe(`# a\nRAROG_APNS_KEY_ID=TESTKEYID1\nSONIOX_API_KEY=${KEY}\n`);
    expect(result.stdout).toContain('added');
    expectNoLeak(result);
  });

  it('4: pusty istniejący plik → jedna linia, bez pustej linii przed nią', async () => {
    writeSecrets('');
    const result = await run(SET_KEY, { stdin: KEY });
    expect(result.code).toBe(0);
    expect(fileText()).toBe(`SONIOX_API_KEY=${KEY}\n`);
  });

  it('9: terminal: `askSecret` oddaje klucz → jak 1, `readStdin` nie wywołane; `null` → kod 1 bez zapisu', async () => {
    let result = await run(SET_KEY, { ask: KEY, both: true });
    expect(result.code).toBe(0);
    expect(result.asked).toHaveLength(1);
    expect(result.read).toEqual([]);
    expect(fileText()).toBe(`SONIOX_API_KEY=${KEY}\n`);
    expectNoLeak(result);

    writeSecrets(`SONIOX_API_KEY=${OLD}\n`);
    result = await run(SET_KEY, { ask: null });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('nothing changed');
    expect(fileText()).toBe(`SONIOX_API_KEY=${OLD}\n`);
    expect(tmpFiles()).toEqual([]);
  });

  it('14: okrążenie: po set-key `buildServeEnv` daje tę wartość, a `loadConfig` — `voiceEnabled: true`', async () => {
    writeConfig({ version: 1, env: { RAROG_ORIGINS: 'https://rarog.example.net' } });
    expect((await run(SET_KEY, { stdin: `${KEY}\n` })).code).toBe(0);
    const built = buildServeEnv(envOf(), { env: {}, mode: 'check' });
    expect(built.env['SONIOX_API_KEY']).toBe(KEY);
    expect(loadConfig(built.env).voiceEnabled).toBe(true);
  });
});

describe('rarog dictation set-key: odmowy', () => {
  it('5: `service.wrapper` → kod 1 przed pytaniem; plik sekretów bez zmian (bajty i czas modyfikacji)', async () => {
    writeConfig({ version: 1, env: {}, service: { wrapper: ['/usr/bin/env'] } });
    writeSecrets(`SONIOX_API_KEY=${OLD}\n`);
    const before = statSync(secretFile()).mtimeMs;
    const result = await run(SET_KEY, { both: true, ask: KEY, stdin: KEY });
    expect(result.code).toBe(1);
    expect(result.asked).toEqual([]);
    expect(result.read).toEqual([]);
    expect(result.stderr).toContain('service.wrapper');
    expect(result.stderr).toContain('secrets manager');
    expect(result.stderr).toContain('SONIOX_API_KEY');
    expect(result.stderr).toContain(REPAIR.restart);
    expect(fileText()).toBe(`SONIOX_API_KEY=${OLD}\n`);
    expect(statSync(secretFile()).mtimeMs).toBe(before);
  });

  it('2 (krok 2): wadliwy `config.json` → kod 1 ze zdaniem `readRarogConfig`, bez pytania', async () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(path.join(configDir(), 'config.json'), '{');
    const result = await run(SET_KEY, { both: true, ask: KEY });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('not valid JSON');
    expect(result.asked).toEqual([]);
  });

  /** Stan pliku albo katalogu, którego `readPrivateEnv`/`checkEntry` nie przyjmuje. */
  const BAD: readonly { readonly name: string; readonly setup: () => string; readonly sentence: RegExp }[] = [
    { name: 'plik 0644', setup: () => { writeSecrets(`SONIOX_API_KEY=${OLD}\n`, 0o644); return secretFile(); },
      sentence: /private\.env: mode 644, required 600/u },
    { name: 'katalog 0755', setup: () => { writeSecrets(`SONIOX_API_KEY=${OLD}\n`, 0o600, 0o755); return secretFile(); },
      sentence: /secret: mode 755, required 700/u },
    {
      name: 'katalog secret jako dowiązanie',
      setup: () => {
        const elsewhere = path.join(home, 'elsewhere');
        mkdirSync(elsewhere, { mode: 0o700 });
        writeFileSync(path.join(elsewhere, 'private.env'), `SONIOX_API_KEY=${OLD}\n`, { mode: 0o600 });
        mkdirSync(configDir(), { recursive: true });
        symlinkSync(elsewhere, secretDir());
        return path.join(elsewhere, 'private.env');
      },
      sentence: /secret: expected a directory \(symlinks and other types are rejected\)/u,
    },
    {
      name: 'plik jako dowiązanie',
      setup: () => {
        const elsewhere = path.join(home, 'real.env');
        writeFileSync(elsewhere, `SONIOX_API_KEY=${OLD}\n`, { mode: 0o600 });
        mkdirSync(secretDir(), { recursive: true, mode: 0o700 });
        chmodSync(secretDir(), 0o700);
        symlinkSync(elsewhere, secretFile());
        return elsewhere;
      },
      sentence: /private\.env: expected a regular file \(symlinks and other types are rejected\)/u,
    },
    { name: 'linia bez „=”', setup: () => { writeSecrets(`# a\n${OLD}\n`); return secretFile(); },
      sentence: /private\.env, line 2: expected NAME=value\./u },
    { name: 'nazwa spoza rejestru', setup: () => { writeSecrets(`OBCA_NAZWA=${OLD}\n`); return secretFile(); },
      sentence: /private\.env, line 1: name outside the server secret registry\./u },
    {
      name: 'dwie linie Soniox',
      setup: () => { writeSecrets(`SONIOX_API_KEY=${OLD}\nSONIOX_API_KEY=${OLD}2\n`); return secretFile(); },
      sentence: /private\.env, line 2: SONIOX_API_KEY appears twice\./u,
    },
  ];

  for (const bad of BAD) {
    it(`6: ${bad.name} → kod 1 ze zdaniem serwera, przed pytaniem, bez zapisu i bez pliku tymczasowego`, async () => {
      const target = bad.setup();
      const before = readFileSync(target);
      // To samo zdanie daje czytnik serwera.
      expect(() => readPrivateEnv(envOf())).toThrow(bad.sentence);
      const result = await run(SET_KEY, { both: true, ask: KEY, stdin: KEY });
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(bad.sentence);
      expect(result.asked).toEqual([]);
      expect(result.read).toEqual([]);
      expect(readFileSync(target)).toEqual(before);
      expect(tmpFiles()).toEqual([]);
      expect(result.stderr).not.toContain(OLD);
      expectNoLeak(result);
    });
  }

  /** Wejścia, których komenda nie przyjmuje; `marker` to fragment, którego nie wolno pokazać. */
  const INPUTS: readonly { readonly name: string; readonly input: string; readonly marker: string }[] = [
    { name: 'puste', input: '', marker: '' },
    { name: 'same odstępy', input: '   \n', marker: '' },
    { name: 'spacja w środku', input: `${KEY} x\n`, marker: KEY },
    { name: 'dwie linie', input: `${KEY}\n${KEY}\n`, marker: KEY },
    { name: 'tabulator', input: `${KEY}\tx`, marker: KEY },
    { name: 'CR w środku', input: `${KEY}\rx`, marker: KEY },
    { name: 'NUL', input: `${KEY}\0`, marker: KEY },
    { name: '4097 B', input: 'k'.repeat(SECRET_MAX_BYTES + 1), marker: 'kkkkkkkk' },
  ];

  for (const { name, input, marker } of INPUTS) {
    it(`7: wejście ${name} → kod 1, plik bez zmian, stderr bez wartości`, async () => {
      writeSecrets(`SONIOX_API_KEY=${OLD}\n`);
      const result = await run(SET_KEY, { stdin: input });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('nothing changed');
      expect(fileText()).toBe(`SONIOX_API_KEY=${OLD}\n`);
      expect(tmpFiles()).toEqual([]);
      if (marker !== '') expectNoLeak(result, marker);
    });
  }

  it('7: zdania odmów kształtu: pusty klucz, „one line without spaces”, sufit 4096 B', async () => {
    expect((await run(SET_KEY, { stdin: '  \n' })).stderr).toMatch(/empty/u);
    expect((await run(SET_KEY, { stdin: 'a b' })).stderr).toMatch(/expected one line without spaces/iu);
    expect((await run(SET_KEY, { stdin: 'k'.repeat(4097) })).stderr).toContain('4096');
    // Dokładnie 4096 B przechodzi.
    const result = await run(SET_KEY, { stdin: 'k'.repeat(4096) });
    expect(result.code).toBe(0);
    expect(fileText()).toBe(`SONIOX_API_KEY=${'k'.repeat(4096)}\n`);
  });

  it('8: wartość w argv → kod 64, argument nie wraca ani na stdout, ani na stderr; nic nie czytane', async () => {
    for (const argv of [[...SET_KEY, KEY], [...STATUS, KEY], ['dictation', KEY], [...SET_KEY, '--', KEY]]) {
      const result = await run(argv, { both: true, ask: KEY, stdin: KEY });
      expect(result.code, argv.join(' ')).toBe(64);
      expect(result.stderr).toContain('Run rarog dictation --help.');
      expect(result.asked).toEqual([]);
      expect(result.read).toEqual([]);
      expectNoLeak(result);
    }
    expect(existsSync(secretFile())).toBe(false);
  });

  it('bez żadnej drogi wejścia (stdin to terminal, stdout nie) → kod 1 „run it in a terminal or pipe the key”', async () => {
    const result = await run(SET_KEY);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('run it in a terminal or pipe the key');
    expect(existsSync(secretFile())).toBe(false);
  });

  it('10: porażka zapisu (fsync, chmod, rename) → kod 1, stary plik bajt w bajt, brak `.tmp`', async () => {
    const errno = (code: string): Error => Object.assign(new Error(`${code}: test`), { code });
    const failing = (step: 'create' | 'chmod' | 'rename'): SecretWrites => ({
      // `create` pisze naprawdę i dopiero potem pada: tak wygląda błąd `fsync` po zapisie treści.
      create: (file, data, fileMode) => {
        SECRET_WRITES.create(file, data, fileMode);
        if (step === 'create') throw errno('EIO');
      },
      chmod: (file, fileMode) => {
        if (step === 'chmod') throw errno('EPERM');
        SECRET_WRITES.chmod(file, fileMode);
      },
      rename: (from, to) => {
        if (step === 'rename') throw errno('EXDEV');
        SECRET_WRITES.rename(from, to);
      },
    });
    for (const step of ['create', 'chmod', 'rename'] as const) {
      writeSecrets(`# keep\nSONIOX_API_KEY=${OLD}\n`);
      const before = readFileSync(secretFile());
      const result = await run(SET_KEY, { stdin: KEY, writes: failing(step) });
      expect(result.code, step).toBe(1);
      expect(result.stderr).toMatch(/unchanged/u);
      expect(readFileSync(secretFile())).toEqual(before);
      expect(tmpFiles(), step).toEqual([]);
      expectNoLeak(result);
    }
    // Te same zależności bez porażki zapisują: atrapa woła prawdziwe kroki.
    const ok: SecretWrites = { ...SECRET_WRITES };
    expect((await run(SET_KEY, { stdin: KEY, writes: ok })).code).toBe(0);
    expect(fileText()).toBe(`# keep\nSONIOX_API_KEY=${KEY}\n`);
  });

  it('16: zmiana pliku w czasie pytania przechodzi do nowej treści; zepsucie praw w tym czasie = kod 1', async () => {
    writeSecrets(`# a\nSONIOX_API_KEY=${OLD}\n`);
    let result = await run(SET_KEY, {
      ask: () => {
        writeFileSync(secretFile(), 'RAROG_APNS_KEY_ID=TESTKEYID2\n', { flag: 'a' });
        return Promise.resolve(KEY);
      },
    });
    expect(result.code).toBe(0);
    expect(fileText()).toBe(`# a\nSONIOX_API_KEY=${KEY}\nRAROG_APNS_KEY_ID=TESTKEYID2\n`);
    expectNoLeak(result);

    // Plik usunięty w czasie pytania: nowa treść też z ponownego odczytu (jedna linia), nie z pliku sprzed pytania.
    writeSecrets(`# a\nSONIOX_API_KEY=${OLD}\n`);
    result = await run(SET_KEY, {
      ask: () => {
        rmSync(secretFile());
        return Promise.resolve(KEY);
      },
    });
    expect(result.code).toBe(0);
    expect(fileText()).toBe(`SONIOX_API_KEY=${KEY}\n`);
    expect(result.stdout).toContain('added');

    writeSecrets(`SONIOX_API_KEY=${OLD}\n`);
    result = await run(SET_KEY, {
      ask: () => {
        chmodSync(secretFile(), 0o644);
        return Promise.resolve(KEY);
      },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/mode 644, required 600/u);
    expect(fileText()).toBe(`SONIOX_API_KEY=${OLD}\n`);
    expect(tmpFiles()).toEqual([]);
    expectNoLeak(result);
  });

  it('Rarog lock: free during the question; held at the write (rarog setup) = code 1, nothing written; the write under it', async () => {
    const lock = path.join(configDir(), 'lock');
    const irohLine = `RAROG_IROH_KEY=${'5a'.repeat(32)}\n`;
    writeSecrets(`SONIOX_API_KEY=${OLD}\n`);
    // Interleaving: during the question another process (`rarog setup`) takes the lock and appends the iroh key.
    let heldWhileAsking = true;
    let result = await run(SET_KEY, {
      ask: () => {
        heldWhileAsking = existsSync(lock);
        writeFileSync(lock, `${String(process.ppid)}\n`, { mode: 0o600 });
        writeFileSync(secretFile(), irohLine, { flag: 'a' });
        return Promise.resolve(KEY);
      },
    });
    expect(heldWhileAsking).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`another call is running (PID ${String(process.ppid)}`);
    expect(result.stderr).toContain('The key was not saved');
    expect(fileText()).toBe(`SONIOX_API_KEY=${OLD}\n${irohLine}`);
    expect(readFileSync(lock, 'utf8')).toBe(`${String(process.ppid)}\n`);
    expect(tmpFiles()).toEqual([]);
    expectNoLeak(result);

    // Lock released: the read, the new content and the write under this command's lock; the iroh key stays, the
    // lock is gone afterwards.
    rmSync(lock);
    let heldAtWrite = '';
    result = await run(SET_KEY, {
      ask: KEY,
      writes: {
        ...SECRET_WRITES,
        create: (file, data, fileMode) => {
          heldAtWrite = readFileSync(lock, 'utf8');
          SECRET_WRITES.create(file, data, fileMode);
        },
      },
    });
    expect(result.code).toBe(0);
    expect(heldAtWrite).toBe(`${String(process.pid)}\n`);
    expect(fileText()).toBe(`SONIOX_API_KEY=${KEY}\n${irohLine}`);
    expect(existsSync(lock)).toBe(false);
    expectNoLeak(result);
  });

  it('17: granica 64 KiB: o bajt za dużo po zmianie → kod 1 bez zapisu; dokładnie 64 KiB → kod 0', async () => {
    // `# <wypełnienie>\n` + linia Soniox; nowa treść ma o tyle bajtów więcej, o ile klucz jest dłuższy od starego.
    const sonioxLine = `SONIOX_API_KEY=${KEY}\n`;
    const padTo = (total: number): string => `# ${'x'.repeat(total - sonioxLine.length - 3)}\n`;

    writeSecrets(`${padTo(MAX_FILE_BYTES + 1)}SONIOX_API_KEY=${OLD}\n`);
    const before = readFileSync(secretFile());
    expect(before.length).toBeLessThanOrEqual(MAX_FILE_BYTES);
    let result = await run(SET_KEY, { stdin: KEY });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(String(MAX_FILE_BYTES));
    expect(result.stderr).toContain('nothing changed');
    expect(readFileSync(secretFile())).toEqual(before);
    expect(tmpFiles()).toEqual([]);
    expectNoLeak(result);

    writeSecrets(`${padTo(MAX_FILE_BYTES)}SONIOX_API_KEY=${OLD}\n`);
    result = await run(SET_KEY, { stdin: KEY });
    expect(result.code).toBe(0);
    expect(readFileSync(secretFile()).length).toBe(MAX_FILE_BYTES);
    expect(readPrivateEnv(envOf()).values.SONIOX_API_KEY).toBe(KEY);
  });

  it('6 (krok 6): nowa treść, której parser serwera nie przyjmie (powtórka po zmianie), → kod 1 bez zapisu', async () => {
    writeSecrets(`SONIOX_API_KEY=${OLD}\n`);
    const result = await run(SET_KEY, {
      ask: () => {
        writeFileSync(secretFile(), `SONIOX_API_KEY=${OLD}2\n`, { flag: 'a' });
        return Promise.resolve(KEY);
      },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/line 2: SONIOX_API_KEY appears twice/u);
    expect(fileText()).toBe(`SONIOX_API_KEY=${OLD}\nSONIOX_API_KEY=${OLD}2\n`);
    expect(tmpFiles()).toEqual([]);
  });
});

describe('rarog dictation status', () => {
  it('11: brak pliku → `missing` i `not set`; plik z kluczem → `present` i `set`; kod 0, bez wartości', async () => {
    let result = await run(STATUS);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`${secretFile()} (missing)`);
    expect(result.stdout).toContain('SONIOX_API_KEY: not set');
    expect(result.stdout).not.toContain('service.wrapper');
    expect(result.stdout).not.toContain('RAROG_VOICE');
    expect(result.stdout).not.toContain('shell');

    writeSecrets(`SONIOX_API_KEY=${KEY}\n`);
    result = await run(STATUS);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`${secretFile()} (present)`);
    expect(result.stdout).toContain('SONIOX_API_KEY: set');
    expectNoLeak(result);

    writeSecrets('SONIOX_API_KEY=  \n');
    expect((await run(STATUS)).stdout).toContain('SONIOX_API_KEY: not set');
  });

  it('11: `service.wrapper` → linia o wrapperze; `RAROG_VOICE=0` → linia o wyłączonym dyktowaniu', async () => {
    writeSecrets(`SONIOX_API_KEY=${KEY}\n`);
    writeConfig({ version: 1, env: { RAROG_VOICE: '0' }, service: { wrapper: ['/usr/bin/env'] } });
    const result = await run(STATUS);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/service\.wrapper.*does not run it/u);
    expect(result.stdout).toMatch(/RAROG_VOICE=0 in .*config\.json: dictation is off/u);
    expectNoLeak(result);
  });

  it('11: plik 0644 albo wadliwy `config.json` → kod 1 ze zdaniem serwera', async () => {
    writeSecrets(`SONIOX_API_KEY=${KEY}\n`, 0o644);
    let result = await run(STATUS);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/mode 644, required 600/u);
    expectNoLeak(result);
    chmodSync(secretFile(), 0o600);
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(path.join(configDir(), 'config.json'), '{"version": 2}');
    result = await run(STATUS);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('version 2');
  });

  it('`dictation --help` → użycie komendy, 0; użycie trafia do `rarog help`', async () => {
    const result = await run(['dictation', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`Usage:\n${DICTATION_USAGE}\n`);
    expect(USAGE).toContain(DICTATION_USAGE);
    expect((await run(['dictation'])).code).toBe(64);
  });
});

describe('SONIOX_API_KEY w środowisku komendy (18)', () => {
  for (const [label, value] of [['pusta', ''], ['niepusta', ENV_VALUE]] as const) {
    it(`18: nazwa w środowisku (${label}) → linia o środowisku powłoki w status i set-key, bez wartości`, async () => {
      const word = value === '' ? 'empty' : 'not empty';
      const line = `SONIOX_API_KEY is set in this shell's environment (${word}); \`${rarogCli('serve')}\` started`
        + ' from this shell uses it instead of the file';
      let result = await run(STATUS, { env: { SONIOX_API_KEY: value } });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(line);
      if (value !== '') expectNoLeak(result, value);
      result = await run(SET_KEY, { stdin: KEY, env: { SONIOX_API_KEY: value } });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(line);
      expectNoLeak(result);
      if (value !== '') expectNoLeak(result, value);
    });
  }
});

/**
 * Terminal na niby: `setRawMode` zapisuje wywołania, `type` podaje klawisze. Klawisz wpisany, gdy terminal nie jest
 * w trybie surowym, prawdziwy terminal pokazałby na ekranie: liczy go `echoed`.
 */
class FakeTty extends EventEmitter {
  readonly isTTY = true;
  raw = false;
  readonly rawCalls: boolean[] = [];
  echoed = 0;
  paused = true;

  setRawMode(on: boolean): this {
    this.rawCalls.push(on);
    this.raw = on;
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  type(...keys: readonly (string | Buffer | Error)[]): void {
    for (const key of keys) {
      if (key instanceof Error) {
        this.emit('error', key);
        continue;
      }
      if (!this.raw) this.echoed += 1;
      this.emit('data', typeof key === 'string' ? Buffer.from(key, 'utf8') : key);
    }
  }
}

/** Pytanie bez echa na atrapie: ekran (wszystko, co poszło na wyjście) i klawisze podane po wypisaniu promptu. */
function terminal(keys: readonly (string | Buffer | Error)[]): {
  readonly tty: FakeTty; readonly screen: () => string; readonly ask: (prompt: string) => Promise<string | null>;
} {
  const tty = new FakeTty();
  let screen = '';
  let fed = false;
  const ask = askSecretOn(tty, (text) => {
    screen += text;
    if (!fed) {
      fed = true;
      setImmediate(() => { tty.type(...keys); });
    }
  });
  return { tty, screen: () => screen, ask };
}

/** Ekran po pytaniu: prompt, włączenie trybu wklejki w znacznikach, na końcu jego wyłączenie i nowa linia. */
const SCREEN = 'Key: \x1b[?2004h\x1b[?2004l\n';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

describe('pytanie bez echa (12, 19)', () => {
  it('12: Enter kończy; na wyjściu tylko prompt i nowa linia; tryb surowy przed pierwszym klawiszem i zdjęty', async () => {
    const term = terminal(['soniox-', 'cli-test', '-key-1', '\r']);
    await expect(term.ask('Key: ')).resolves.toBe(KEY);
    expect(term.screen()).toBe(SCREEN);
    expect(term.tty.echoed).toBe(0);
    expect(term.tty.rawCalls).toEqual([true, false]);
    expect(term.tty.paused).toBe(true);
    expect(term.tty.listenerCount('data')).toBe(0);
  });

  it('12: Backspace (DEL i ^H) kasuje znak, także wielobajtowy; Ctrl-D → `null`', async () => {
    let term = terminal([`${KEY}xż`, '\x7f', '\x7f', 'z', '\x08', '\n']);
    await expect(term.ask('Key: ')).resolves.toBe(KEY);
    expect(term.screen()).toBe(SCREEN);

    term = terminal(['abc', '\x04']);
    await expect(term.ask('Key: ')).resolves.toBeNull();
    expect(term.screen()).toBe(SCREEN);
    expect(term.tty.rawCalls).toEqual([true, false]);
  });

  it('12: wklejka kilku linii nie ucina się do pierwszej: oddaje je wszystkie (komenda ją odrzuci)', async () => {
    const term = terminal([`${KEY}\r${KEY}\r`]);
    await expect(term.ask('Key: ')).resolves.toBe(`${KEY}\n${KEY}`);
  });

  it('12: wklejka w znacznikach podzielona po pierwszym Enterze: całość, odpowiedź kończy Enter poza wklejką', async () => {
    const term = terminal([`${PASTE_START}first-test-key\n`, `second-test-key\n${PASTE_END}`, '\r']);
    await expect(term.ask('Key: ')).resolves.toBe('first-test-key\nsecond-test-key');
    expect(term.screen()).toBe(SCREEN);
    expect(term.tty.echoed).toBe(0);
    expect(term.tty.listenerCount('data')).toBe(0);
  });

  it('12: Enter na końcu wklejki nie kończy odpowiedzi; kończy go następny Enter poza wklejką', async () => {
    let settled = false;
    const term = terminal([`${PASTE_START}${KEY}\n${PASTE_END}`]);
    const answer = term.ask('Key: ').finally(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(term.tty.rawCalls).toEqual([true]);
    term.tty.type('\r');
    await expect(answer).resolves.toBe(KEY);
  });

  it('12: znacznik wklejki podzielony między porcje danych nie trafia do odpowiedzi', async () => {
    const term = terminal(['\x1b[20', `0~${KEY}\x1b`, '[201', '~', '\r']);
    await expect(term.ask('Key: ')).resolves.toBe(KEY);
  });

  it('12: inna sekwencja ESC (strzałka) zostaje w odpowiedzi jak dotąd; ESC przed znacznikiem też', async () => {
    let term = terminal([`${KEY}\x1b[A`, '\r']);
    await expect(term.ask('Key: ')).resolves.toBe(`${KEY}\x1b[A`);
    term = terminal([`\x1b${PASTE_START}${KEY}${PASTE_END}\r`]);
    await expect(term.ask('Key: ')).resolves.toBe(`\x1b${KEY}`);
  });

  it('12: Ctrl-C w trakcie wklejki przerywa; tryb wklejki i surowy zdjęte', async () => {
    const term = terminal([`${PASTE_START}abc`, '\x03']);
    await expect(term.ask('Key: ')).rejects.toThrow('interrupted');
    expect(term.screen()).toBe(SCREEN);
    expect(term.tty.rawCalls).toEqual([true, false]);
  });

  it('12: Ctrl-C → `rarog dictation set-key` kończy się kodem 130, terminal wraca do echa, nic nie zapisane', async () => {
    const term = terminal(['abc', '\x03']);
    const result = await run(SET_KEY, { io: { askSecret: term.ask } });
    expect(result.code).toBe(130);
    expect(term.tty.rawCalls).toEqual([true, false]);
    expect(term.screen()).not.toContain('abc');
    expect(existsSync(secretFile())).toBe(false);
  });

  it('12: klucz z atrapy terminala przez całą komendę: plik zapisany, ekran bez wartości', async () => {
    const term = terminal([KEY, '\r']);
    const result = await run(SET_KEY, { io: { askSecret: term.ask } });
    expect(result.code).toBe(0);
    expect(fileText()).toBe(`SONIOX_API_KEY=${KEY}\n`);
    expect(term.screen()).not.toContain(KEY);
    expect(term.tty.echoed).toBe(0);
    expectNoLeak(result);
  });

  it('19: błąd strumienia w trakcie → kod 1, tryb surowy zdjęty, bez zapisu, wpisane znaki nie na ekranie', async () => {
    const term = terminal(['soniox-cli', Object.assign(new Error('read EIO'), { code: 'EIO' })]);
    const result = await run(SET_KEY, { io: { askSecret: term.ask } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('EIO');
    expect(term.tty.rawCalls).toEqual([true, false]);
    expect(term.screen()).not.toContain('soniox-cli');
    expect(existsSync(secretFile())).toBe(false);
    expect(tmpFiles()).toEqual([]);
  });

  it('19: ponad 4096 B wpisane w terminalu → kod 1 po Enterze, tryb surowy zdjęty, bez zapisu', async () => {
    const term = terminal(['k'.repeat(3000), 'k'.repeat(1200), '\r']);
    const result = await run(SET_KEY, { io: { askSecret: term.ask } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('4096');
    expect(term.tty.rawCalls).toEqual([true, false]);
    expect(term.screen()).not.toContain('kkkk');
    expect(existsSync(secretFile())).toBe(false);
    expect(tmpFiles()).toEqual([]);
    expectNoLeak(result, 'kkkkkkkk');
  });
});

describe('odczyt potoku i wybór drogi wejścia', () => {
  it('`readAllOn`: całość do EOF; ponad sufit → odrzucenie `SecretInputTooLong`', async () => {
    let input = new PassThrough();
    input.end(`${KEY}\n`);
    await expect(readAllOn(input)(SECRET_MAX_BYTES)).resolves.toBe(`${KEY}\n`);
    input = new PassThrough();
    input.end('k'.repeat(SECRET_MAX_BYTES + 1));
    await expect(readAllOn(input)(SECRET_MAX_BYTES)).rejects.toBeInstanceOf(SecretInputTooLong);
  });

  it('7: 4097 B z prawdziwego czytnika potoku → kod 1 przez komendę', async () => {
    const input = new PassThrough();
    input.end('k'.repeat(SECRET_MAX_BYTES + 1));
    const result = await run(SET_KEY, { io: { readStdin: readAllOn(input) } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('4096');
    expect(existsSync(secretFile())).toBe(false);
  });

  it('`secretInput`: terminal → tylko `askSecret`; potok → tylko `readStdin`; stdin-terminal bez terminala na stdout → nic', () => {
    const ttyIn = new FakeTty();
    const pipeIn = Object.assign(new PassThrough(), { isTTY: false, setRawMode: () => undefined });
    const ttyOut = { isTTY: true, write: () => true };
    const fileOut = { isTTY: false, write: () => true };
    expect(Object.keys(secretInput(ttyIn, ttyOut))).toEqual(['askSecret']);
    expect(Object.keys(secretInput(pipeIn, ttyOut))).toEqual(['readStdin']);
    expect(Object.keys(secretInput(pipeIn, fileOut))).toEqual(['readStdin']);
    expect(Object.keys(secretInput(ttyIn, fileOut))).toEqual([]);
  });
});

describe('bin/rarog.mjs (13)', () => {
  it('13: prawdziwy proces z kluczem w potoku → kod 0, plik 0600; stdout, stderr i argv bez wartości', () => {
    const env: NodeJS.ProcessEnv = { ...t.env };
    delete env['SONIOX_API_KEY'];
    const args = [CLI, 'dictation', 'set-key'];
    const proc = spawnSync(process.execPath, args, { env, input: `${KEY}\n`, encoding: 'utf8', timeout: 60_000 });
    expect(proc.stderr).toBe('');
    expect(proc.status).toBe(0);
    expect(mode(secretFile())).toBe(0o600);
    expect(fileText()).toBe(`SONIOX_API_KEY=${KEY}\n`);
    expect(proc.stdout).not.toContain(KEY);
    expect(args.join(' ')).not.toContain(KEY);
    expect(filesWith(KEY)).toEqual([]);

    // Za długie wejście z potoku: odmowa bez zawieszenia procesu na reszcie potoku.
    const long = spawnSync(process.execPath, args, {
      env, input: 'k'.repeat(64 * 1024), encoding: 'utf8', timeout: 60_000,
    });
    expect(long.signal).toBeNull();
    expect(long.status).toBe(1);
    expect(long.stderr).toContain('4096');
    expect(fileText()).toBe(`SONIOX_API_KEY=${KEY}\n`);
  });
});
