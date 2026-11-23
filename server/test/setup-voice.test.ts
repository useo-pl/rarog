/**
 * `rarog setup`, the voice questions of step 2 (`setup-voice.ts`): dictation with Soniox, then the voice
 * agent only with a Soniox key; the keys and `RAROG_COMPANION=1` under the lock of step 2, before `config.json`. The
 * keys are synthetic markers that must reach the secrets file and nothing else. Runs on the shared harness
 * (`helpers/setup-harness.ts`); the last block runs `bin/rarog.mjs setup` in a pseudo-terminal (`/usr/bin/script`).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretInputInterrupted } from '../src/cli/secret-input.ts';
import type { SetupDeps } from '../src/cli/setup-context.ts';
import { AGENT_QUESTION, DICTATION_QUESTION } from '../src/cli/setup-voice.ts';
import {
  CLI, IROH_INTEL, REPO, bin, configDir, configFile, dataDirOf, env, home, plist, runSetup, secretFile, state,
  useSetupHarness, visibleLines, write, writeConfig, writeSecrets,
} from './helpers/setup-harness.ts';
import type { KeyPrompt, Question, VoiceAnswers } from './helpers/setup-harness.ts';
import { IS_MAC, macOnly } from './platform.ts';

useSetupHarness();

/** Synthetic keys typed at the prompts. */
const SONIOX = 'SONIOX-ZNACZNIK';
const OPENAI = 'sk-test-ZNACZNIK';

/** "y" to the plan screen, "n" to every other question that is not a voice question. */
const PLAN_ONLY = (question: Question): string => (question === 'continue' ? 't' : 'n');

const keys = (soniox: string | null, openai: string | null = null) =>
  (prompt: KeyPrompt): string | null => (prompt === 'soniox-key' ? soniox : openai);

const BOTH: VoiceAnswers = { dictation: 'y', agent: 'y', key: keys(SONIOX, OPENAI) };

const secrets = (): string => (existsSync(secretFile()) ? readFileSync(secretFile(), 'utf8') : '');
const configEnv = (): Record<string, string> =>
  (JSON.parse(readFileSync(configFile(), 'utf8')) as { env: Record<string, string> }).env;
const logDir = (): string => path.join(dataDirOf(), 'logs');
const logText = (): string => (existsSync(logDir())
  ? readdirSync(logDir()).map((name) => readFileSync(path.join(logDir(), name), 'utf8')).join('\n') : '');
const lockFile = (): string => path.join(configDir(), 'lock');
const mode = (file: string): number => statSync(file).mode & 0o777;
/** Whitespace runs as one space, so a line wrapped at the screen width reads as one. */
const flat = (text: string): string => text.replace(/\s+/gu, ' ');
/**
 * The outcome line of a voice feature that stays off: `<feature>: off`, the reason in brackets when there is one, then
 * the command that sets it up later (`rarog dictation set-key`, in whatever form this install runs `rarog`).
 */
const offLater = (feature: 'dictation' | 'voice agent', command: 'dictation' | 'voice-agent'): RegExp =>
  new RegExp(`${feature}: off(?: \\([^)]*\\))?; later: [^;]*?\\b${command} set-key`, 'u');
/** An npm package root linked to this repository: the install mode where `rarog` is the command on `PATH`. */
const packageDeps = (): Pick<SetupDeps, 'mode' | 'installRoot' | 'sdkInstall'> => {
  const root = path.join(home, 'prefix', 'lib', 'node_modules', '@rarog', 'server');
  mkdirSync(path.dirname(root), { recursive: true });
  symlinkSync(REPO, root);
  return {
    mode: 'package', installRoot: root,
    sdkInstall: (options) => Promise.resolve({ ok: true, dir: options.dataDir, raced: false }),
  };
};

describe.skipIf(!IS_MAC)(macOnly('rarog setup: the voice questions of step 2', 'launchd'), () => {
  it('dictation "n": no agent question, config.json without RAROG_COMPANION, no voice key', async () => {
    const run = await runSetup({ answer: PLAN_ONLY });
    expect(run.asked.slice(0, 3)).toEqual(['tailscale-only', 'continue', 'dictation']);
    expect(run.asked).not.toContain('agent');
    expect(run.asked.filter((one) => one.endsWith('-key'))).toEqual([]);
    expect(configEnv()).not.toHaveProperty('RAROG_COMPANION');
    expect(secrets()).not.toMatch(/^(SONIOX|OPENAI)_API_KEY=/mu);
    expect(flat(run.stdout)).toMatch(offLater('dictation', 'dictation'));
    // The agent question needs a Soniox key; the log says how to set the agent up later.
    expect(flat(logText())).toMatch(/voice agent: [^\n]*\bvoice-agent set-key/u);
  });

  /**
   * On a terminal whose answered questions leave the screen, the answer "n" and a saved key would leave no trace,
   * so a short line stands for each; a terminal that keeps its questions (no live columns, `--verbose`, no terminal)
   * shows them as before: the answer above, the full line in the log.
   */
  describe('the voice outcome on the screen once the questions leave it', () => {
    const TTY = { tty: true, columns: 60, color: false } as const;
    const screenLines = (stdout: string): string[] => visibleLines(stdout);

    it('"n": one line dictation: off with the later command, within 60 columns; the log keeps it', async () => {
      const run = await runSetup({
        answer: PLAN_ONLY, verbose: false, terminal: TTY, echo: true, columnsNow: () => 60, deps: packageDeps(),
      });
      const off = screenLines(run.stdout).filter((one) => one.startsWith('  dictation: off'));
      expect(off, run.stdout).toHaveLength(1);
      expect(off[0]).toMatch(offLater('dictation', 'dictation'));
      expect(off[0]).toContain('rarog dictation set-key');
      expect(off[0]?.length).toBeLessThanOrEqual(60);
      expect(flat(logText())).toMatch(offLater('dictation', 'dictation'));
    });

    it('a terminal without live columns, "n": the later command on the screen too', async () => {
      const run = await runSetup({ answer: PLAN_ONLY, verbose: false, terminal: TTY, echo: true });
      expect(flat(screenLines(run.stdout).join('\n'))).toMatch(offLater('dictation', 'dictation'));
    });

    it('both "y": dictation: on and voice agent: on, no key value; the log keeps the full lines', async () => {
      const run = await runSetup({
        answer: PLAN_ONLY, voice: BOTH, verbose: false, terminal: TTY, echo: true, columnsNow: () => 60,
      });
      const lines = screenLines(run.stdout);
      expect(lines).toContain('  dictation: on');
      expect(lines).toContain('  voice agent: on');
      for (const marker of [SONIOX, OPENAI, 'ZNACZNIK']) expect(run.stdout).not.toContain(marker);
      expect(logText()).toContain('dictation: on (Soniox key saved)');
      expect(logText()).toContain('voice agent: on (OpenAI key saved)');
    });

    it('a terminal without live columns keeps its questions: no short line', async () => {
      const run = await runSetup({ answer: PLAN_ONLY, voice: BOTH, verbose: false, terminal: TTY, echo: true });
      const lines = screenLines(run.stdout);
      expect(lines.filter((one) => /^ {2}(dictation|voice agent): /u.test(one))).toEqual([]);
    });
  });

  it('dictation "y", the Soniox key, agent "n": the key in private.env (0600), no RAROG_COMPANION', async () => {
    const run = await runSetup({ answer: PLAN_ONLY, voice: { dictation: 'y', agent: 'n', key: keys(SONIOX) } });
    expect(run.asked).toEqual(expect.arrayContaining(['dictation', 'soniox-key', 'agent']));
    expect(run.asked).not.toContain('openai-key');
    expect(secrets()).toMatch(new RegExp(`^SONIOX_API_KEY=${SONIOX}$`, 'mu'));
    expect(secrets()).not.toContain('OPENAI_API_KEY');
    expect(mode(secretFile())).toBe(0o600);
    expect(configEnv()).not.toHaveProperty('RAROG_COMPANION');
    expect(run.stdout).toContain('dictation: on (Soniox key saved)');
    expect(flat(run.stdout)).toMatch(offLater('voice agent', 'voice-agent'));
  });

  it('both "y": both keys and RAROG_COMPANION=1; neither key in the log, on stdout or in config.json', async () => {
    const run = await runSetup({ answer: PLAN_ONLY, voice: BOTH });
    expect(secrets()).toMatch(new RegExp(`^SONIOX_API_KEY=${SONIOX}$`, 'mu'));
    expect(secrets()).toMatch(new RegExp(`^OPENAI_API_KEY=${OPENAI}$`, 'mu'));
    expect(configEnv()['RAROG_COMPANION']).toBe('1');
    expect(run.stdout).toContain('dictation: on (Soniox key saved)');
    expect(run.stdout).toContain('voice agent: on (OpenAI key saved)');
    const log = logText();
    expect(log).toContain('question: ? Soniox EU key (hidden):');
    expect(log).toContain('question: ? OpenAI API key (hidden):');
    // The log has the prompt of a hidden question, never an answer line for it.
    expect(log).not.toMatch(/\(hidden\):\n[^\n]*answer:/u);
    for (const marker of [SONIOX, OPENAI, 'ZNACZNIK']) {
      expect(log).not.toContain(marker);
      expect(run.stdout).not.toContain(marker);
      expect(readFileSync(configFile(), 'utf8')).not.toContain(marker);
    }
  });

  for (const typed of ['', '   ', null]) {
    it(`dictation "y" with ${typed === null ? 'Ctrl-D' : 'an empty key'}: no agent question, a skip line`, async () => {
      const run = await runSetup({ answer: PLAN_ONLY, voice: { dictation: 'y', agent: 'y', key: keys(typed) } });
      expect(run.asked).toContain('soniox-key');
      expect(run.asked).not.toContain('agent');
      expect(run.stdout).toContain('dictation: off (skipped: no key)');
      expect(flat(run.stdout)).toMatch(offLater('dictation', 'dictation'));
      expect(flat(logText())).toMatch(/voice agent: [^\n]*\bvoice-agent set-key/u);
      expect(secrets()).not.toContain('SONIOX_API_KEY');
      expect(configEnv()).not.toHaveProperty('RAROG_COMPANION');
    });
  }

  it('agent "y" with an empty OpenAI key: the Soniox key saved, no flag, a skip line', async () => {
    const run = await runSetup({ answer: PLAN_ONLY, voice: { dictation: 'y', agent: 'y', key: keys(SONIOX, '') } });
    expect(run.asked).toContain('openai-key');
    expect(secrets()).toContain(`SONIOX_API_KEY=${SONIOX}`);
    expect(secrets()).not.toContain('OPENAI_API_KEY');
    expect(configEnv()).not.toHaveProperty('RAROG_COMPANION');
    expect(run.stdout).toContain('voice agent: off (skipped: no key)');
    expect(flat(run.stdout)).toMatch(offLater('voice agent', 'voice-agent'));
  });

  it('a key with a space: not saved, the line says why, the value nowhere', async () => {
    const run = await runSetup({ answer: PLAN_ONLY, voice: { dictation: 'y', key: keys(`${SONIOX} x`) } });
    expect(run.stdout).toContain('dictation: off (key not saved: it has spaces or control characters)');
    expect(flat(run.stdout)).toMatch(offLater('dictation', 'dictation'));
    expect(run.stdout).not.toContain(SONIOX);
    expect(secrets()).not.toContain('SONIOX_API_KEY');
  });

  it('the Soniox key already in private.env: no dictation question and no prompt, "kept"', async () => {
    writeSecrets();
    const before = secrets();
    const run = await runSetup({ answer: PLAN_ONLY, voice: { agent: 'n' } });
    expect(run.asked).not.toContain('dictation');
    expect(run.asked).not.toContain('soniox-key');
    expect(run.asked).toContain('agent');
    expect(run.stdout).toContain('dictation: on (Soniox key kept)');
    // The iroh key is added; the Soniox line stays as it was.
    expect(secrets().startsWith(before)).toBe(true);
  });

  it('the OpenAI key already in private.env: no agent question, "kept"; with the Soniox key the flag', async () => {
    write(secretFile(), 'OPENAI_API_KEY=sk-test-ZNACZNIK-kept\n', 0o600);
    const run = await runSetup({ answer: PLAN_ONLY, voice: { dictation: 'y', key: keys(SONIOX) } });
    expect(run.asked).toContain('soniox-key');
    expect(run.asked).not.toContain('agent');
    expect(run.asked).not.toContain('openai-key');
    expect(run.stdout).toContain('voice agent: on (OpenAI key kept)');
    expect(secrets()).toContain('OPENAI_API_KEY=sk-test-ZNACZNIK-kept');
    expect(configEnv()['RAROG_COMPANION']).toBe('1');
  });

  it('no herdr: no voice question, nothing written', async () => {
    rmSync(path.join(bin, 'herdr'));
    const run = await runSetup({ answer: PLAN_ONLY, voice: BOTH });
    expect(run.asked).not.toContain('dictation');
    expect(existsSync(configFile())).toBe(false);
    expect(secrets()).toBe('');
  });

  it('no transport (Intel Mac, tailscale status fails): no voice question, nothing written', async () => {
    write(path.join(state, 'status-err'), 'tailscale: not logged in\n');
    const run = await runSetup({ answer: PLAN_ONLY, voice: BOTH, deps: { irohModule: () => IROH_INTEL } });
    expect(run.asked).not.toContain('dictation');
    expect(existsSync(configFile())).toBe(false);
    expect(secrets()).toBe('');
  });

  it('without a terminal: no question, no key', async () => {
    const run = await runSetup({ answer: null, voice: BOTH });
    expect(run.asked).toEqual([]);
    expect(secrets()).toBe('');
  });

  it('without iroh (Intel Mac, Tailscale) and "y": the secrets directory 0700 is created, the key saved', async () => {
    const run = await runSetup({
      answer: PLAN_ONLY, voice: { dictation: 'y', agent: 'n', key: keys(SONIOX) },
      deps: { irohModule: () => IROH_INTEL },
    });
    expect(configEnv()).not.toHaveProperty('RAROG_IROH');
    expect(mode(path.dirname(secretFile()))).toBe(0o700);
    expect(mode(secretFile())).toBe(0o600);
    expect(secrets()).toBe(`SONIOX_API_KEY=${SONIOX}\n`);
    expect(run.stdout).toContain('dictation: on (Soniox key saved)');
  });

  it('two setups with different keys: config.json and the keys of one run; the other writes nothing', async () => {
    let reached = (): void => {};
    const atPrompt = new Promise<void>((resolve) => { reached = resolve; });
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = runSetup({
      answer: PLAN_ONLY,
      voice: {
        dictation: 'y', agent: 'y',
        key: async (prompt) => {
          if (prompt === 'soniox-key') return 'SONIOX-ZNACZNIK-A';
          reached();
          await gate;
          return 'sk-test-ZNACZNIK-A';
        },
      },
    });
    await atPrompt;
    const second = await runSetup({
      answer: PLAN_ONLY, voice: { ...BOTH, key: keys('SONIOX-ZNACZNIK-B', 'sk-test-ZNACZNIK-B') },
    });
    const config = readFileSync(configFile(), 'utf8');
    const written = secrets();
    release();
    const loser = await first;
    expect(second.stdout).toContain('config.json: created');
    expect(loser.stdout).toContain('config.json appeared meanwhile');
    expect(loser.stdout).toContain('dictation: off (Soniox key not saved)');
    expect(readFileSync(configFile(), 'utf8')).toBe(config);
    expect(secrets()).toBe(written);
    expect(written).toContain('SONIOX_API_KEY=SONIOX-ZNACZNIK-B');
    expect(written).toContain('OPENAI_API_KEY=sk-test-ZNACZNIK-B');
    expect(written).not.toContain('-A');
    expect(written.match(/^RAROG_IROH_KEY=/gmu)).toHaveLength(1);
    expect(existsSync(lockFile())).toBe(false);
  });

  it('the second run after "y" asks nothing; config.json and private.env byte for byte', async () => {
    await runSetup({ answer: () => 't', voice: BOTH });
    // The counting fake of the harness installs nothing: the plist stands for the service the first run installed.
    write(plist(), '<plist/>\n');
    const config = readFileSync(configFile(), 'utf8');
    const written = secrets();
    const again = await runSetup({
      answer: (question) => { throw new Error(`unexpected question: ${question}`); },
      voice: { key: () => { throw new Error('unexpected key prompt'); } },
    });
    expect(again.asked).toEqual([]);
    expect(readFileSync(configFile(), 'utf8')).toBe(config);
    expect(secrets()).toBe(written);
  });

  it('an existing config.json: no voice question', async () => {
    writeConfig({ RAROG_ORIGINS: 'https://rarog.example.net' });
    const run = await runSetup({ answer: PLAN_ONLY, voice: BOTH });
    expect(run.asked).not.toContain('dictation');
    expect(secrets()).toBe('');
  });

  for (const at of ['soniox-key', 'openai-key'] as const) {
    it(`Ctrl-C at the ${at} prompt: code 130, nothing written, no lock left`, async () => {
      const run = await runSetup({
        answer: PLAN_ONLY,
        voice: {
          dictation: 'y', agent: 'y',
          key: (prompt) => {
            if (prompt === at) throw new SecretInputInterrupted('Ctrl-C');
            return SONIOX;
          },
        },
      });
      expect(run.code).toBe(130);
      expect(existsSync(configFile())).toBe(false);
      expect(existsSync(secretFile())).toBe(false);
      expect(existsSync(lockFile())).toBe(false);
    });
  }

  it('a service from before (its plist) and a new config.json: the restart line', async () => {
    write(plist(), '<plist/>\n');
    const run = await runSetup({ answer: PLAN_ONLY });
    expect(run.stdout).toMatch(/If the service runs: .*restart, to read config\.json\./u);
  });

  it('a fresh machine: no restart line', async () => {
    const run = await runSetup({ answer: PLAN_ONLY });
    expect(run.stdout).not.toContain('If the service runs');
  });
});

// ---------------------------------------------------------------------------
// bin/rarog.mjs setup in a pseudo-terminal
// ---------------------------------------------------------------------------

const CTRL_C = '\u0003';
/** `text` as a literal part of a regular expression. */
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
/** The hidden prompt is ready for keys once the terminal is raw: the bracketed paste mode follows the prompt. */
const hidden = (prompt: string): string => `${prompt}\x1b[?2004h`;

/** Keys typed once `after` shows up in the output (searched after the previous step's text). */
interface Step {
  readonly after: string;
  readonly keys: string;
}

/**
 * `bin/rarog.mjs setup` of this checkout in a pseudo-terminal (`script` from macOS; `cat |` because `script` refuses a
 * socket as stdin), with the harness `HOME` and fakes and without `tailscale` (iroh only). Each step's keys go only
 * after its text is on screen; the last step closes the input. Without `size` the terminal has no window size (its
 * columns unknown); with it `stty` sets one before the command starts.
 */
async function ttySetup(
  steps: readonly Step[], size?: { readonly cols: number; readonly rows: number },
): Promise<{ readonly code: number | null; readonly output: string }> {
  rmSync(path.join(bin, 'tailscale'));
  const sized = size === undefined ? []
    : ['/bin/sh', '-c', `stty cols ${String(size.cols)} rows ${String(size.rows)}; exec "$@"`, 'sh'];
  const command = ['-c', 'cat | /usr/bin/script -q /dev/null "$@"', 'sh', ...sized, process.execPath, CLI, 'setup'];
  const child = spawn('/bin/sh', command, {
    cwd: home,
    env: env(home, { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, TERM: 'xterm', COLUMNS: '60' }),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  let next = 0;
  let from = 0;
  const onOutput = (chunk: Buffer): void => {
    output += chunk.toString();
    for (let step = steps[next]; step !== undefined; step = steps[next]) {
      const at = output.indexOf(step.after, from);
      if (at < 0) return;
      from = at + step.after.length;
      next += 1;
      if (next === steps.length) child.stdin.end(step.keys);
      else child.stdin.write(step.keys);
    }
  };
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);
  const timer = setTimeout(() => {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
  }, 50_000);
  const code = await new Promise<number | null>((resolve) => { child.on('close', resolve); });
  clearTimeout(timer);
  return { code, output };
}

describe.skipIf(!IS_MAC)(macOnly('bin/rarog.mjs setup: the key prompts in a terminal', 'the script command'), () => {
  it('both keys typed: not on screen, saved with the flag; Ctrl-C at the next question ends with 130', async () => {
    const run = await ttySetup([
      { after: 'Continue? [Y/n] ', keys: 'y\r' },
      { after: `${DICTATION_QUESTION} [y/N] `, keys: 'y\r' },
      { after: hidden('Soniox EU key (hidden): '), keys: `${SONIOX}\r` },
      { after: `${AGENT_QUESTION} [y/N] `, keys: 'y\r' },
      { after: hidden('OpenAI API key (hidden): '), keys: `${OPENAI}\r` },
      { after: '[y/N/d] ', keys: CTRL_C },
    ]);
    for (const marker of [SONIOX, OPENAI, 'ZNACZNIK']) {
      expect(run.output).not.toContain(marker);
      expect(logText()).not.toContain(marker);
    }
    expect(run.code).toBe(130);
    expect(secrets()).toMatch(new RegExp(`^SONIOX_API_KEY=${SONIOX}$`, 'mu'));
    expect(secrets()).toMatch(new RegExp(`^OPENAI_API_KEY=${OPENAI}$`, 'mu'));
    expect(configEnv()['RAROG_COMPANION']).toBe('1');
    expect(existsSync(lockFile())).toBe(false);
  }, 60_000);

  it('a terminal of 60 columns: each answered question leaves the screen right after its echo', async () => {
    const run = await ttySetup([
      { after: 'Continue? [Y/n] ', keys: 'y\r' },
      { after: `${DICTATION_QUESTION} [y/N] `, keys: 'n\r' },
      { after: '[y/N/d] ', keys: CTRL_C },
    ], { cols: 60, rows: 50 });
    expect(run.code).toBe(130);
    // readline puts the cursor after the prompt (`ESC[<n>G`), echoes the answer and its line end (`\r\r\n` through
    // the terminal); then up by the question's rows (the dictation question with its one explanation line above it)
    // and the screen cleared below.
    expect(run.output).toMatch(/Continue\? \[Y\/n\] (?:\x1b\[\d+G)?y\r+\n\x1b\[1A\r\x1b\[J/u);
    const dictationAnswered = `${escape(DICTATION_QUESTION)} \\[y/N\\] (?:\\x1b\\[\\d+G)?n\\r+\\n\\x1b\\[2A\\r\\x1b\\[J`;
    expect(run.output).toMatch(new RegExp(dictationAnswered, 'u'));
    expect(run.output).toContain('  dictation: off; later: ');
    // Ctrl-C keeps its question.
    expect(run.output).not.toMatch(/\[y\/N\/d\] [^]*\x1b\[\d+A/u);
  }, 60_000);

  it('Ctrl-C at the Soniox key prompt: code 130, no config.json, no secrets, no lock', async () => {
    const run = await ttySetup([
      { after: 'Continue? [Y/n] ', keys: 'y\r' },
      { after: `${DICTATION_QUESTION} [y/N] `, keys: 'y\r' },
      { after: hidden('Soniox EU key (hidden): '), keys: `abc${CTRL_C}` },
    ]);
    expect(run.code).toBe(130);
    expect(run.output).not.toContain('abc');
    expect(existsSync(configFile())).toBe(false);
    expect(existsSync(path.dirname(secretFile()))).toBe(false);
    expect(existsSync(lockFile())).toBe(false);
  }, 60_000);
});
