/**
 * `rarog voice-agent set-key|set-model|status` (`server/src/cli/voice-agent.ts`): the OpenAI key in the secrets
 * file, the Realtime model in `config.json` and the state on disk. Every test runs in a temporary `HOME`; no test
 * calls OpenAI or touches the real configuration.
 */
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPAIR } from '../src/install/repair.ts';
import { EXIT_USAGE } from '../src/cli/io.ts';
import type { CliIo } from '../src/cli/io.ts';
import { USAGE, main } from '../src/cli/main.ts';
import { configFileText, readRarogConfig } from '../src/cli/serve.ts';
import { CONFIG_WRITES } from '../src/cli/config-rewrite.ts';
import type { ConfigWrites } from '../src/cli/config-rewrite.ts';
import { VOICE_AGENT_USAGE, voiceAgentCommand } from '../src/cli/voice-agent.ts';
import { realRarogDirsCreated, tempHome } from './rarog-home.ts';
import type { TempHome } from './rarog-home.ts';

/** Synthetic key: the tests know no real one. */
const KEY = 'sk-proj-voice-agent-test-1';
const ENV_VALUE = 'sk-proj-voice-agent-env-1';

let t: TempHome;
let home = '';
beforeEach(() => {
  t = tempHome('rarog-voice-agent-');
  home = t.home;
});
afterEach(() => { t.cleanup(); });
afterAll(() => { expect(realRarogDirsCreated()).toEqual([]); });

const configDir = (): string => path.join(home, '.config', 'rarog');
const configFile = (): string => path.join(configDir(), 'config.json');
const secretDir = (): string => path.join(configDir(), 'secret');
const secretFile = (): string => path.join(secretDir(), 'private.env');
const mode = (file: string): number => lstatSync(file).mode & 0o777;

/** `config.json` exactly as `rarog setup` writes it (the same function `setup.ts` writes with). */
const setupText = configFileText;
const BASE = { version: 1, env: { RAROG_ORIGINS: 'http://localhost:8930', RAROG_COMPANION: '1' } };

function writeConfig(text: string, target = configFile()): void {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, text);
}

function writeSecrets(text: string): void {
  mkdirSync(secretDir(), { recursive: true });
  chmodSync(configDir(), 0o700);
  chmodSync(secretDir(), 0o700);
  writeFileSync(secretFile(), text);
  chmodSync(secretFile(), 0o600);
}

/** Temporary files of the write next to `config.json` (and next to a link target). */
function tmpFiles(dir = configDir()): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.tmp')) : [];
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly asked: string[];
  readonly read: number[];
}

interface RunOptions {
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly configWrites?: ConfigWrites;
  /** Answers of the terminal question (`CliIo.ask`); missing = a call without a terminal (no `ask`). */
  readonly answers?: readonly (string | null)[];
  /** Runs inside `ask`, before the answer (a change made while the human thinks). */
  readonly whileAsking?: () => void;
}

async function run(argv: readonly string[], opts: RunOptions = {}): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const asked: string[] = [];
  const read: number[] = [];
  const io: CliIo = {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    env: { HOME: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin', XDG_DATA_HOME: path.join(home, 'xdg'), ...opts.env },
    cwd: home,
    ...(opts.stdin === undefined ? {} : {
      readStdin: (maxBytes: number) => {
        read.push(maxBytes);
        return Promise.resolve(opts.stdin ?? '');
      },
    }),
    ...(opts.answers === undefined ? {} : {
      ask: (prompt: string) => {
        asked.push(prompt);
        opts.whileAsking?.();
        return Promise.resolve(opts.answers?.[asked.length - 1] ?? null);
      },
    }),
  };
  const code = opts.configWrites === undefined
    ? await main(argv, io)
    : await voiceAgentCommand(argv, io, { configWrites: opts.configWrites });
  return { code, stdout, stderr, asked, read };
}

const SET_KEY = ['voice-agent', 'set-key'] as const;
const STATUS = ['voice-agent', 'status'] as const;
const setModel = (model: string): readonly string[] => ['voice-agent', 'set-model', model];

describe('rarog voice-agent: usage', () => {
  it('the general help lists the command; its own help prints the same usage', async () => {
    expect(USAGE).toContain(VOICE_AGENT_USAGE);
    expect((await run(['--help'])).stdout).toContain('rarog voice-agent set-key');
    const own = (await run(['voice-agent', '--help'])).stdout;
    expect(own).toContain('rarog voice-agent set-model <model>');
    expect(own).toContain(VOICE_AGENT_USAGE);
  });

  it('a wrong call is a usage error', async () => {
    expect((await run(['voice-agent'])).code).toBe(EXIT_USAGE);
    expect((await run(['voice-agent', 'set-model'])).code).toBe(EXIT_USAGE);
    expect((await run(['voice-agent', 'set-key', KEY])).code).toBe(EXIT_USAGE);
    expect((await run(['voice-agent', 'set-key', KEY])).stderr).not.toContain(`: ${KEY}`);
  });
});

describe('rarog voice-agent set-key', () => {
  it('from a pipe → the `OPENAI_API_KEY` line in `private.env`, other lines byte for byte; no value on stdout',
    async () => {
      writeSecrets('# comment\r\nSONIOX_API_KEY=soniox-old\nRAROG_IROH_KEY=iroh-x');
      const result = await run(SET_KEY, { stdin: `${KEY}\n` });
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(readFileSync(secretFile(), 'utf8'))
        .toBe(`# comment\r\nSONIOX_API_KEY=soniox-old\nRAROG_IROH_KEY=iroh-x\nOPENAI_API_KEY=${KEY}\n`);
      expect(mode(secretFile())).toBe(0o600);
      expect(result.stdout).toContain('added');
      expect(result.stdout).toContain(REPAIR.restart);
      expect(result.stdout).toContain('separate OpenAI project');
      expect(result.stdout).not.toContain(KEY);
      expect(result.stdout).not.toContain('shell');
    });

  it('next to the iroh key from `rarog setup`: `dictation set-key`, then `voice-agent set-key` → all three lines',
    async () => {
      const irohLine = `RAROG_IROH_KEY=${'5a'.repeat(32)}\n`;
      writeSecrets(irohLine);
      const soniox = await run(['dictation', 'set-key'], { stdin: 'soniox-test-key-1' });
      expect(soniox.stderr).toBe('');
      expect(soniox.code).toBe(0);
      const openai = await run(SET_KEY, { stdin: KEY });
      expect(openai.stderr).toBe('');
      expect(openai.code).toBe(0);
      expect(readFileSync(secretFile(), 'utf8'))
        .toBe(`${irohLine}SONIOX_API_KEY=soniox-test-key-1\nOPENAI_API_KEY=${KEY}\n`);
      expect(existsSync(path.join(configDir(), 'lock'))).toBe(false);
      expect(tmpFiles(secretDir())).toEqual([]);
    });

  it('an existing line is replaced, the rest stays', async () => {
    writeSecrets(`OPENAI_API_KEY=old\nSONIOX_API_KEY=s\n`);
    const result = await run(SET_KEY, { stdin: KEY });
    expect(result.code).toBe(0);
    expect(readFileSync(secretFile(), 'utf8')).toBe(`OPENAI_API_KEY=${KEY}\nSONIOX_API_KEY=s\n`);
    expect(result.stdout).toContain('replaced');
  });

  it('with `service.wrapper` → refusal before asking, nothing written', async () => {
    writeConfig(setupText({ ...BASE, service: { wrapper: ['/usr/bin/env'] } }));
    const result = await run(SET_KEY, { stdin: KEY });
    expect(result.code).toBe(1);
    expect(result.read).toEqual([]);
    expect(result.stderr).toContain('service.wrapper');
    expect(result.stderr).toContain('Add OPENAI_API_KEY in that secrets manager');
    expect(existsSync(secretFile())).toBe(false);
  });

  it('the name in the shell environment → a warning that `rarog serve` from this shell uses it', async () => {
    const result = await run(SET_KEY, { stdin: KEY, env: { OPENAI_API_KEY: ENV_VALUE } });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Warning: OPENAI_API_KEY is set in this shell's environment \(not empty\)/u);
    expect(result.stdout).toContain('instead of the file');
    expect(result.stdout).not.toContain(ENV_VALUE);
  });
});

describe('rarog voice-agent set-key: turning the voice agent on', () => {
  const QUESTION = 'Turn on the voice agent? [y/N] ';
  const lock = (): string => path.join(configDir(), 'lock');
  /** `config.json` from `rarog setup` with the flag off and other `env` keys. */
  const OFF = {
    version: 1, env: { RAROG_ORIGINS: 'http://localhost:8930', RAROG_COMPANION_MODEL: 'gpt-realtime-2.1' },
  };
  /** The Soniox key of dictation: the voice agent speaks only with the Soniox voice, so its flag needs this key. */
  const SONIOX = 'SONIOX_API_KEY=soniox-test-key-1\n';
  const lastLine = (text: string): string => text.trimEnd().split('\n').at(-1) ?? '';
  const restartLast = (result: Run): void => {
    expect(lastLine(result.stdout)).toMatch(new RegExp(`run ${REPAIR.restart}\\.$`, 'u'));
  };

  it('flag missing + "y" → `RAROG_COMPANION=1` appended to `env`; the rest of the file and its layout stay',
    async () => {
      writeConfig(setupText(OFF));
      writeSecrets(SONIOX);
      let heldWhileAsking = true;
      const result = await run(SET_KEY, {
        stdin: KEY, answers: ['y'], whileAsking: () => { heldWhileAsking = existsSync(lock()); },
      });
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(result.asked).toEqual([QUESTION]);
      expect(heldWhileAsking).toBe(false);
      expect(readFileSync(configFile(), 'utf8'))
        .toBe(setupText({ ...OFF, env: { ...OFF.env, RAROG_COMPANION: '1' } }));
      expect(readFileSync(secretFile(), 'utf8')).toBe(`${SONIOX}OPENAI_API_KEY=${KEY}\n`);
      expect(result.stdout).toContain(`Wrote RAROG_COMPANION=1 in ${configFile()}`);
      restartLast(result);
      expect(existsSync(lock())).toBe(false);
      expect(tmpFiles()).toEqual([]);
    });

  it('both keys + "y" → only `RAROG_COMPANION=1`; the withdrawn `RAROG_COMPANION_SPEECH` is not written', async () => {
    writeConfig(setupText(OFF));
    writeSecrets(SONIOX);
    const result = await run(SET_KEY, { stdin: KEY, answers: ['y'] });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(readFileSync(configFile(), 'utf8')).toBe(setupText({ ...OFF, env: { ...OFF.env, RAROG_COMPANION: '1' } }));
    expect(result.stdout).not.toContain('RAROG_COMPANION_SPEECH');
    restartLast(result);
  });

  it.each([['a terminal', ['y']], ['no terminal', undefined]] as const)(
    'no `SONIOX_API_KEY` (%s) → the key saved, no question, the flag not written, `rarog dictation set-key` named',
    async (_name, answers) => {
      writeConfig(setupText(OFF));
      const result = await run(SET_KEY, { stdin: KEY, ...(answers === undefined ? {} : { answers }) });
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(result.asked).toEqual([]);
      expect(readFileSync(configFile(), 'utf8')).toBe(setupText(OFF));
      expect(readFileSync(secretFile(), 'utf8')).toBe(`OPENAI_API_KEY=${KEY}\n`);
      expect(result.stdout).toContain('dictation set-key, then run');
      expect(result.stdout).toContain('Soniox');
      restartLast(result);
    });

  it('the flag already `1` without `SONIOX_API_KEY` → no question, no write, `rarog dictation set-key` named', async () => {
    writeConfig(setupText(BASE));
    const result = await run(SET_KEY, { stdin: KEY, answers: ['y'] });
    expect(result.code).toBe(0);
    expect(result.asked).toEqual([]);
    expect(readFileSync(configFile(), 'utf8')).toBe(setupText(BASE));
    expect(result.stdout).toContain('dictation set-key, then run');
    restartLast(result);
  });

  it('the Soniox key gone while the human answers → "y" writes no flag', async () => {
    writeConfig(setupText(OFF));
    writeSecrets(SONIOX);
    const result = await run(SET_KEY, {
      stdin: KEY, answers: ['y'], whileAsking: () => { writeFileSync(secretFile(), `OPENAI_API_KEY=${KEY}\n`); },
    });
    expect(result.asked).toEqual([QUESTION]);
    expect(readFileSync(configFile(), 'utf8')).toBe(setupText(OFF));
    expect(result.stdout).toContain('dictation set-key, then run');
    restartLast(result);
  });

  it('an explicit `0` → the question too; "y" changes the value in place', async () => {
    const before = { version: 1, env: { RAROG_COMPANION: '0', RAROG_ORIGINS: 'http://localhost:8930' } };
    writeConfig(setupText(before));
    writeSecrets(SONIOX);
    const result = await run(SET_KEY, { stdin: KEY, answers: ['yes'] });
    expect(result.code).toBe(0);
    expect(result.asked).toEqual([QUESTION]);
    expect(readFileSync(configFile(), 'utf8'))
      .toBe(setupText({ version: 1, env: { RAROG_COMPANION: '1', RAROG_ORIGINS: 'http://localhost:8930' } }));
  });

  it.each([['n', 'n'], ['Enter', ''], ['EOF', null]])('"%s" → `config.json` byte for byte, the key saved',
    async (_name, answer) => {
      writeConfig(setupText(OFF));
      writeSecrets('SONIOX_API_KEY=soniox-test-key-1\n');
      const ino = lstatSync(configFile()).ino;
      const result = await run(SET_KEY, { stdin: KEY, answers: [answer] });
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(result.asked).toEqual([QUESTION]);
      expect(readFileSync(configFile(), 'utf8')).toBe(setupText(OFF));
      expect(lstatSync(configFile()).ino).toBe(ino);
      expect(readFileSync(secretFile(), 'utf8')).toContain(`OPENAI_API_KEY=${KEY}\n`);
      expect(result.stdout).toContain('The voice agent stays off');
      restartLast(result);
    });

  it('the flag already `1` → no question, nothing written to `config.json`', async () => {
    writeConfig(setupText(BASE));
    writeSecrets(SONIOX);
    const ino = lstatSync(configFile()).ino;
    const result = await run(SET_KEY, { stdin: KEY, answers: ['y'] });
    expect(result.code).toBe(0);
    expect(result.asked).toEqual([]);
    expect(readFileSync(configFile(), 'utf8')).toBe(setupText(BASE));
    expect(lstatSync(configFile()).ino).toBe(ino);
    restartLast(result);
  });

  it('no terminal → no question, no write, a line naming the command', async () => {
    writeConfig(setupText(OFF));
    writeSecrets(SONIOX);
    const result = await run(SET_KEY, { stdin: KEY });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.asked).toEqual([]);
    expect(readFileSync(configFile(), 'utf8')).toBe(setupText(OFF));
    expect(result.stdout).toContain('the voice agent is off');
    expect(result.stdout).toContain('voice-agent set-key in a terminal');
    restartLast(result);
  });

  it('no `config.json` → no question, no file created, a line naming `rarog setup`', async () => {
    const result = await run(SET_KEY, { stdin: KEY, answers: ['y'] });
    expect(result.code).toBe(0);
    expect(result.asked).toEqual([]);
    expect(existsSync(configFile())).toBe(false);
    expect(result.stdout).toContain('does not exist');
    expect(result.stdout).toContain('setup');
    restartLast(result);
  });

  it('the write runs under the Rarog lock; the lock held by another process → code 1, the key saved, file untouched',
    async () => {
      writeConfig(setupText(OFF));
      writeSecrets(SONIOX);
      let heldAtWrite = '';
      const ok = await run(SET_KEY, {
        stdin: KEY, answers: ['y'],
        configWrites: {
          create: (file, bytes, fileMode) => {
            heldAtWrite = readFileSync(lock(), 'utf8');
            CONFIG_WRITES.create(file, bytes, fileMode);
          },
          rename: CONFIG_WRITES.rename,
        },
      });
      expect(ok.code).toBe(0);
      expect(heldAtWrite).toBe(`${String(process.pid)}\n`);

      writeConfig(setupText(OFF));
      const busy = await run(SET_KEY, {
        stdin: `${KEY}-2`, answers: ['y'],
        // Another process (`rarog setup`) takes the lock while the human answers.
        whileAsking: () => { writeFileSync(lock(), `${String(process.ppid)}\n`, { mode: 0o600 }); },
      });
      expect(busy.code).toBe(1);
      expect(busy.stderr).toContain(`PID ${String(process.ppid)}`);
      expect(busy.stderr).toContain('The key is saved');
      expect(readFileSync(configFile(), 'utf8')).toBe(setupText(OFF));
      expect(readFileSync(secretFile(), 'utf8')).toBe(`${SONIOX}OPENAI_API_KEY=${KEY}-2\n`);
      expect(readFileSync(lock(), 'utf8')).toBe(`${String(process.ppid)}\n`);
      restartLast(busy);
      rmSync(lock());
    });

  it('a file not in the layout of `rarog setup` + "y" → refusal with a hand-edit hint, the file untouched',
    async () => {
      const text = `${JSON.stringify(OFF)}\n`;
      writeConfig(text);
      writeSecrets(SONIOX);
      const result = await run(SET_KEY, { stdin: KEY, answers: ['y'] });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('"RAROG_COMPANION": "1"');
      expect(result.stderr).toContain('by hand');
      expect(readFileSync(configFile(), 'utf8')).toBe(text);
      expect(readFileSync(secretFile(), 'utf8')).toBe(`${SONIOX}OPENAI_API_KEY=${KEY}\n`);
      expect(tmpFiles()).toEqual([]);
      restartLast(result);
    });
});

describe('rarog voice-agent set-model', () => {
  it('a file from `rarog setup` → only this value changes, every other byte and the final LF stay', async () => {
    const before = setupText({ version: 1, env: { ...BASE.env, RAROG_COMPANION_MODEL: 'gpt-realtime-2.1' } });
    // The layout of `rarog setup`: two-space JSON and a final LF.
    expect(before).toBe(`${JSON.stringify(JSON.parse(before), null, 2)}\n`);
    writeConfig(before);
    chmodSync(configFile(), 0o640);
    const result = await run(setModel('gpt-realtime-2.1-mini'));
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const after = readFileSync(configFile(), 'utf8');
    expect(after).toBe(before.replace('"gpt-realtime-2.1"', '"gpt-realtime-2.1-mini"'));
    expect(after.endsWith('}\n')).toBe(true);
    expect(mode(configFile())).toBe(0o640);
    expect(result.stdout).toContain('gpt-realtime-2.1 → gpt-realtime-2.1-mini');
    expect(result.stdout).toContain(REPAIR.restart);
    expect(readRarogConfig({ HOME: home })?.env.RAROG_COMPANION_MODEL).toBe('gpt-realtime-2.1-mini');
    expect(tmpFiles()).toEqual([]);
  });

  it('a missing value is added to `env`; the rest of the file stays', async () => {
    writeConfig(setupText(BASE));
    const result = await run(setModel('gpt-realtime-2.1-mini'));
    expect(result.code).toBe(0);
    expect(readFileSync(configFile(), 'utf8'))
      .toBe(setupText({ version: 1, env: { ...BASE.env, RAROG_COMPANION_MODEL: 'gpt-realtime-2.1-mini' } }));
    expect(result.stdout).toContain('not set (default gpt-realtime-2.1) → gpt-realtime-2.1-mini');
  });

  it.each([
    ['without the final LF', setupText(BASE).slice(0, -1)],
    ['with a four-space indent', `${JSON.stringify(BASE, null, 4)}\n`],
    ['on one line', `${JSON.stringify(BASE)}\n`],
  ])('a file %s → refusal with a hand-edit hint, the file untouched', async (_name, text) => {
    writeConfig(text);
    const result = await run(setModel('gpt-realtime-2.1-mini'));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('by hand');
    expect(readFileSync(configFile(), 'utf8')).toBe(text);
    expect(tmpFiles()).toEqual([]);
  });

  it('a symlink → the target changes, the link stays', async () => {
    const target = path.join(home, 'mac-config', 'rarog.json');
    writeConfig(setupText(BASE), target);
    mkdirSync(configDir(), { recursive: true });
    symlinkSync(target, configFile());
    const result = await run(setModel('gpt-realtime-2.1-mini'));
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(lstatSync(configFile()).isSymbolicLink()).toBe(true);
    expect(readlinkSync(configFile())).toBe(target);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toMatchObject({ env: { RAROG_COMPANION_MODEL: 'gpt-realtime-2.1-mini' } });
    expect(tmpFiles(path.dirname(target))).toEqual([]);
  });

  it.each(['gpt-4o-realtime', 'whisper-1', 'GPT-REALTIME', 'gpt-realtime 2', 'gpt-realtime/../x'])(
    'a model outside the pattern (%s) → refusal, the file untouched', async (model) => {
      writeConfig(setupText(BASE));
      const result = await run(setModel(model));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not an OpenAI Realtime model name');
      expect(readFileSync(configFile(), 'utf8')).toBe(setupText(BASE));
    },
  );

  it('no `config.json` → refusal, no file created', async () => {
    const result = await run(setModel('gpt-realtime-2.1-mini'));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('does not exist');
    expect(existsSync(configFile())).toBe(false);
    expect(tmpFiles()).toEqual([]);
  });

  it('a broken symlink → refusal', async () => {
    mkdirSync(configDir(), { recursive: true });
    symlinkSync(path.join(home, 'nothing.json'), configFile());
    const result = await run(setModel('gpt-realtime-2.1-mini'));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('leads to no file');
    expect(existsSync(path.join(home, 'nothing.json'))).toBe(false);
    expect(lstatSync(configFile()).isSymbolicLink()).toBe(true);
    expect(tmpFiles()).toEqual([]);
  });

  it('a target that is not a regular file → refusal', async () => {
    mkdirSync(configFile(), { recursive: true });
    const result = await run(setModel('gpt-realtime-2.1-mini'));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('not a regular file');
    expect(readdirSync(configFile())).toEqual([]);
    expect(tmpFiles()).toEqual([]);
  });

  it('a file over 64 KiB → refusal, the file untouched', async () => {
    const big = setupText({ ...BASE, env: { ...BASE.env, RAROG_ORIGINS: `http://localhost:8930${'x'.repeat(70_000)}` } });
    writeConfig(big);
    const result = await run(setModel('gpt-realtime-2.1-mini'));
    expect(result.code).toBe(1);
    expect(readFileSync(configFile(), 'utf8')).toBe(big);
    expect(tmpFiles()).toEqual([]);
  });

  it.each(['create', 'rename'] as const)('a failed %s → refusal, the original untouched, no temporary file',
    async (step) => {
      writeConfig(setupText(BASE));
      const writes: ConfigWrites = {
        create: (file, bytes, fileMode) => {
          if (step === 'create') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
          CONFIG_WRITES.create(file, bytes, fileMode);
        },
        rename: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); },
      };
      const result = await run(setModel('gpt-realtime-2.1-mini'), { configWrites: writes });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(step === 'create' ? 'ENOSPC' : 'EBUSY');
      expect(readFileSync(configFile(), 'utf8')).toBe(setupText(BASE));
      expect(tmpFiles()).toEqual([]);
    });

  /** Writes that run `meanwhile` right after the temporary file is created (a change between reading and `rename`). */
  const changing = (meanwhile: () => void): ConfigWrites => ({
    create: (file, bytes, fileMode) => {
      CONFIG_WRITES.create(file, bytes, fileMode);
      meanwhile();
    },
    rename: CONFIG_WRITES.rename,
  });

  it('other bytes between reading and writing → refusal, the other change stays, no temporary file', async () => {
    writeConfig(setupText(BASE));
    const other = setupText({ ...BASE, env: { ...BASE.env, RAROG_PORT: '8931' } });
    const result = await run(setModel('gpt-realtime-2.1-mini'), {
      configWrites: changing(() => { writeFileSync(configFile(), other); }),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('changed meanwhile');
    expect(readFileSync(configFile(), 'utf8')).toBe(other);
    expect(tmpFiles()).toEqual([]);
  });

  it('another file (inode) with the same bytes between reading and writing → refusal', async () => {
    writeConfig(setupText(BASE));
    const result = await run(setModel('gpt-realtime-2.1-mini'), {
      configWrites: changing(() => {
        const copy = path.join(configDir(), 'copy.json');
        writeFileSync(copy, setupText(BASE));
        renameSync(copy, configFile());
      }),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('changed meanwhile');
    expect(readFileSync(configFile(), 'utf8')).toBe(setupText(BASE));
    expect(tmpFiles()).toEqual([]);
  });

  it('another link target with the same bytes between reading and writing → refusal', async () => {
    const first = path.join(home, 'a', 'rarog.json');
    const second = path.join(home, 'b', 'rarog.json');
    writeConfig(setupText(BASE), first);
    writeConfig(setupText(BASE), second);
    mkdirSync(configDir(), { recursive: true });
    symlinkSync(first, configFile());
    const result = await run(setModel('gpt-realtime-2.1-mini'), {
      configWrites: changing(() => {
        rmSync(configFile());
        symlinkSync(second, configFile());
      }),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('changed meanwhile');
    expect(readFileSync(first, 'utf8')).toBe(setupText(BASE));
    expect(readFileSync(second, 'utf8')).toBe(setupText(BASE));
    expect(tmpFiles(path.dirname(first))).toEqual([]);
  });

  it('the same model → nothing written', async () => {
    const text = setupText({ version: 1, env: { ...BASE.env, RAROG_COMPANION_MODEL: 'gpt-realtime-2.1' } });
    writeConfig(text);
    const before = lstatSync(configFile()).ino;
    const result = await run(setModel('gpt-realtime-2.1'));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('already');
    expect(lstatSync(configFile()).ino).toBe(before);
  });
});

describe('rarog voice-agent status', () => {
  it('key `set` without the value, the model, the flag and the restart reminder', async () => {
    writeConfig(setupText({ version: 1, env: { ...BASE.env, RAROG_COMPANION_MODEL: 'gpt-realtime-2.1-mini' } }));
    writeSecrets(`OPENAI_API_KEY=${KEY}\nSONIOX_API_KEY=soniox-test-key-1\n`);
    const result = await run(STATUS);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('OPENAI_API_KEY: set (secrets file)');
    expect(result.stdout).toContain('SONIOX_API_KEY: set (secrets file)');
    expect(result.stdout).not.toContain('soniox-test-key-1');
    expect(result.stdout).toContain('model: gpt-realtime-2.1-mini (RAROG_COMPANION_MODEL in config.json)');
    expect(result.stdout).toContain('RAROG_COMPANION=1: the voice agent is on');
    expect(result.stdout).toContain('configuration on disk, not the state of the running server');
    expect(result.stdout).toContain(REPAIR.restart);
    expect(result.stdout).not.toContain(KEY);
    expect(result.stderr).toBe('');
  });

  it('no key, the default model, the flag off', async () => {
    writeConfig(setupText({ version: 1, env: { RAROG_ORIGINS: 'http://localhost:8930' } }));
    const result = await run(STATUS);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('OPENAI_API_KEY: not set');
    expect(result.stdout).toMatch(/SONIOX_API_KEY: not set \(secrets file; the voice agent needs it: .*dictation set-key\)/u);
    expect(result.stdout).toContain('model: gpt-realtime-2.1 (default');
    expect(result.stdout).toContain('the voice agent is off');
  });

  it('the name in the shell environment → the sentence about `rarog serve` from this shell', async () => {
    const result = await run(STATUS, { env: { OPENAI_API_KEY: ENV_VALUE } });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("OPENAI_API_KEY is set in this shell's environment (not empty)");
    expect(result.stdout).not.toContain(ENV_VALUE);
  });

  it('a model outside the pattern in `config.json` → `status` says so and `rarog serve --check` refuses', async () => {
    writeConfig(setupText({ version: 1, env: { ...BASE.env, RAROG_COMPANION_MODEL: 'whisper-1' } }));
    const result = await run(STATUS);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"whisper-1" in config.json is not a Realtime model name');
    const check = await run(['serve', '--check']);
    expect(check.code).toBe(1);
    expect(check.stderr).toContain('RAROG_COMPANION_MODEL takes an OpenAI Realtime model name');
  });

  it('under `service.wrapper` → "not checked" and the configuration on disk', async () => {
    writeConfig(setupText({ ...BASE, service: { wrapper: ['/usr/bin/env'] } }));
    writeSecrets(`OPENAI_API_KEY=${KEY}\n`);
    const result = await run(STATUS);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('OPENAI_API_KEY: not checked (service.wrapper');
    expect(result.stdout).toContain('configuration on disk');
    expect(result.stdout).not.toContain(KEY);
  });
});
