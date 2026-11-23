/**
 * Step screen of `rarog` commands (`server/src/cli/screen/`): step lines on a terminal and without one, width and
 * short paths, the run log file and the question forms. Everything runs on injected writers, clocks and temporary
 * directories; nothing touches the owner's terminal or data directory.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { interruptOrExit } from '../src/cli/child-output.ts';
import { entriesQuestion } from '../src/cli/claude-settings.ts';
import { USAGE } from '../src/cli/main.ts';
import { describeTerminal, NO_TERMINAL, type CliIo, type CliTerminal } from '../src/cli/io.ts';
import { confirm, questionPrompt } from '../src/cli/screen/ask.ts';
import { LOGS_KEPT, RunLog } from '../src/cli/screen/log.ts';
import { sentenceFor, usageFor, wrapUsage } from '../src/cli/screen/prose.ts';
import { SPINNER_FRAMES, SPINNER_MS, StepScreen, watchInterrupt } from '../src/cli/screen/steps.ts';
import { layoutOf, shortPath, shortVersion, truncate, visibleWidth, wrapWords } from '../src/cli/screen/style.ts';
import { SETUP_USAGE } from '../src/cli/setup.ts';
import { UPDATE_USAGE } from '../src/cli/update.ts';
import { displayWidth } from '../src/herdr/dialogs/screen/operation.ts';

const HOME = '/home/tester';
// Any SGR sequence; any escape byte.
const SGR = /\x1b\[[0-9;]*m/u;
const ESC = '\x1b';
const indentOf = (line: string): number => line.length - line.trimStart().length;
const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*[A-Za-z]/gu, '');

interface Capture {
  readonly chunks: string[];
  readonly text: () => string;
}

function capture(): Capture & { readonly write: (text: string) => void } {
  const chunks: string[] = [];
  return { chunks, write: (text) => { chunks.push(text); }, text: () => chunks.join('') };
}

function screenOn(terminal: CliTerminal, extra: { verbose?: boolean; total?: number } = {}) {
  const out = capture();
  let clock = 0;
  const screen = new StepScreen({
    write: out.write, terminal, home: HOME, total: extra.total ?? 7, now: () => clock,
    ...(extra.verbose === undefined ? {} : { verbose: extra.verbose }),
  });
  return { screen, out, tick: (ms: number) => { clock += ms; } };
}

/** Four finished steps, so the next `start` is step 5 of 7. */
function fourDone(screen: StepScreen): void {
  for (const title of ['Tools', 'Config', 'Hook copy', 'Claude settings']) screen.step('ok', title, 'fine');
}

const TTY_COLOR: CliTerminal = { tty: true, columns: 60, color: true };
const TTY_MONO: CliTerminal = { tty: true, columns: 60, color: false };

describe('step lines on a terminal', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('tty with colour, 60 columns: live line with a spinner and 5/7, then the finished line in place', () => {
    const { screen, out } = screenOn(TTY_COLOR);
    fourDone(screen);
    out.chunks.length = 0;
    screen.start('Claude SDK');
    const live = out.text();
    expect(live.startsWith('\r\x1b[2K')).toBe(true);
    expect(SPINNER_FRAMES).toContain([...strip(live).slice(1)][1]);
    expect(strip(live)).toContain('5/7');
    expect(strip(live)).toContain('Claude SDK');
    out.chunks.length = 0;
    screen.done('0.3.247', { ms: 3000, changed: true });
    const done = out.text();
    expect(done.startsWith('\r\x1b[2K')).toBe(true);
    expect(done).toContain('\x1b[32m✓\x1b[39m');
    expect(strip(done)).toMatch(/^\r ✓ Claude SDK {5}0\.3\.247 +3 s\n$/u);
    expect(visibleWidth(strip(done).replace(/[\r\n]/gu, ''))).toBeLessThanOrEqual(60);
  });

  it('the spinner moves every 120 ms and the time shows from 1 s', () => {
    const { screen, out, tick } = screenOn(TTY_COLOR);
    screen.start('Claude SDK');
    out.chunks.length = 0;
    tick(1200);
    vi.advanceTimersByTime(SPINNER_MS);
    const frame = strip(out.text());
    expect([...frame.slice(1)][1]).toBe(SPINNER_FRAMES[1]);
    expect(frame).toMatch(/1 s$/u);
  });

  it('a synchronous step shows the live line without animation', () => {
    const { screen, out } = screenOn(TTY_COLOR);
    screen.start('Service', { animate: false });
    out.chunks.length = 0;
    vi.advanceTimersByTime(SPINNER_MS * 5);
    expect(out.chunks).toEqual([]);
  });

  it('tty without colour: the same text without SGR sequences', () => {
    const color = screenOn(TTY_COLOR);
    const mono = screenOn(TTY_MONO);
    for (const { screen } of [color, mono]) {
      fourDone(screen);
      screen.start('Claude SDK');
      screen.done('0.3.247', { ms: 3000, changed: true });
      screen.start('Service');
      screen.fail('download failed (npm ci, exit 1)', { ms: 0, fix: 'check the network, then rarog setup' });
    }
    expect(mono.out.text()).not.toMatch(SGR);
    expect(mono.out.text()).toBe(strip(color.out.text()).replace(/\r/gu, '\r\x1b[2K'));
  });

  it('a failure: mark, one sentence, Fix and Log lines with the home directory as ~', () => {
    const { screen, out } = screenOn(TTY_MONO);
    screen.start('Claude SDK');
    screen.fail('download failed (npm ci, exit 1)', {
      ms: 0, fix: 'check the network, then rarog setup', log: `${HOME}/.local/share/rarog/logs/setup-x.log`,
    });
    expect(strip(out.text()).split('\r').at(-1)?.split('\n')).toEqual([
      ' ✗ Claude SDK     download failed (npm ci, exit 1)',
      '   Fix: check the network, then rarog setup',
      '   Log: ~/.local/share/rarog/logs/setup-x.log',
      '',
    ]);
  });

  it('a ✗ in a run whose log is not open yet opens it and points at it; ! and ✓ open nothing', () => {
    const out = capture();
    let path: string | null = null;
    let opened = 0;
    const screen = new StepScreen({
      write: out.write, terminal: TTY_MONO, home: HOME, total: 3, now: () => 0,
      log: { line: () => {}, get path() { return path; } },
      openLog: () => { opened += 1; path = `${HOME}/.local/share/rarog/logs/setup-y.log`; },
    });
    screen.step('ok', 'Config', 'created', { changed: true });
    screen.step('warn', 'Hook copy', 'declined', { fix: 'rarog hooks install' });
    expect(opened).toBe(0);
    expect(screen.flagged).toBe(true);
    screen.step('fail', 'Service', 'state undetermined', { fix: 'rarog doctor' });
    expect(opened).toBe(1);
    expect(strip(out.text()).split('\n').slice(-3)).toEqual([
      '   Fix: rarog doctor', '   Log: ~/.local/share/rarog/logs/setup-y.log', '',
    ]);
  });

  it('flagged: only a ✗ or ! line sets it; ✓, – and the line of steps without a change do not', () => {
    const { screen } = screenOn(TTY_MONO);
    screen.step('ok', 'Tools', 'fine');
    screen.step('ok', 'Config', 'created', { changed: true });
    screen.step('skip', 'Tailscale', 'not used (iroh only)');
    screen.summary();
    expect(screen.flagged).toBe(false);
  });

  it('SIGINT while the spinner runs: the clock stops, the step ends interrupted, exit code 130', () => {
    const { screen, out } = screenOn(TTY_COLOR);
    const codes: number[] = [];
    const stop = watchInterrupt(screen);
    screen.start('Claude SDK');
    vi.advanceTimersByTime(SPINNER_MS * 3);
    // The same call `bin/rarog.mjs` makes on the process SIGINT and on the question prompt's SIGINT.
    interruptOrExit((code) => { codes.push(code); });
    stop();
    expect(codes).toEqual([130]);
    const text = strip(out.text());
    expect(text).toContain(' ✗ Claude SDK     interrupted\n');
    expect(text.endsWith('Interrupted. Nothing after this step was changed.\n')).toBe(true);
    const before = out.chunks.length;
    vi.advanceTimersByTime(SPINNER_MS * 10);
    expect(out.chunks.length).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('watchInterrupt stops watching when the command ends', () => {
    const { screen, out } = screenOn(TTY_COLOR);
    const stop = watchInterrupt(screen);
    screen.start('Claude SDK');
    stop();
    const before = out.text();
    const codes: number[] = [];
    interruptOrExit((code) => { codes.push(code); });
    expect(codes).toEqual([130]);
    expect(out.text()).toBe(before);
  });

  it('pause clears the live line for a question and stops the spinner; resume draws it again', () => {
    const { screen, out } = screenOn(TTY_COLOR);
    screen.start('Claude SDK');
    screen.pause();
    expect(out.chunks.at(-1)).toBe('\r\x1b[2K');
    const paused = out.chunks.length;
    vi.advanceTimersByTime(SPINNER_MS * 5);
    expect(out.chunks.length).toBe(paused);
    screen.resume();
    expect(strip(out.chunks.at(-1) ?? '')).toContain('Claude SDK');
    vi.advanceTimersByTime(SPINNER_MS * 2);
    expect(out.chunks.length).toBeGreaterThan(paused + 1);
    screen.done('0.3.247');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('plain and --verbose', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function run(terminal: CliTerminal, verbose: boolean): string {
    const { screen, out } = screenOn(terminal, { verbose });
    fourDone(screen);
    screen.start('Claude SDK');
    vi.advanceTimersByTime(SPINNER_MS * 10);
    screen.detail('downloaded: /some/dir');
    screen.done('0.3.247', { ms: 3000, changed: true });
    screen.start('Service');
    screen.fail('not started', { ms: 0, fix: 'rarog service install' });
    screen.start('Check');
    screen.interrupt();
    return out.text();
  }

  it('no terminal and --verbose: no escape byte and no \\r anywhere, done is one plain line', () => {
    for (const [terminal, verbose] of [[NO_TERMINAL, false], [TTY_COLOR, true], [NO_TERMINAL, true]] as const) {
      const text = run(terminal, verbose);
      expect(text.includes(ESC)).toBe(false);
      expect(text.includes('\r')).toBe(false);
      expect(text).toContain('[5/7] ok      Claude SDK: 0.3.247 (3 s)\n');
      expect(text).toContain('[6/7] FAIL    Service: not started\n   Fix: rarog service install\n');
      expect(text).toContain('[7/7] FAIL    Check: interrupted\n');
    }
  });

  it('detail lines reach the screen only with --verbose', () => {
    expect(run(NO_TERMINAL, false)).not.toContain('downloaded:');
    expect(run(NO_TERMINAL, true)).toContain('downloaded: /some/dir\n');
    expect(run(TTY_COLOR, false)).not.toContain('downloaded:');
  });

  it('--verbose: a detail line from a child loses escape sequences and \\r, line breaks stay', () => {
    for (const terminal of [NO_TERMINAL, TTY_COLOR]) {
      const { screen, out } = screenOn(terminal, { verbose: true });
      screen.detail('\x1b[32mgreen\x1b[39m\rdone');
      screen.detail('npm ci\r\nadded 12 packages');
      expect(out.text().includes(ESC)).toBe(false);
      expect(out.text().includes('\r')).toBe(false);
      expect(out.text()).toBe('greendone\nnpm ci\nadded 12 packages\n');
    }
  });
});

describe('width and short paths', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('40 columns: the live line has at most 39 visible columns, a finished line wraps with an indent', () => {
    const { screen, out, tick } = screenOn({ tty: true, columns: 40, color: true });
    fourDone(screen);
    out.chunks.length = 0;
    screen.start('Claude SDK');
    screen.progress('downloading the package from the registry');
    tick(65_000);
    vi.advanceTimersByTime(SPINNER_MS);
    for (const chunk of out.chunks) {
      expect(chunk.includes('\n')).toBe(false);
      expect(visibleWidth(strip(chunk).replace('\r', ''))).toBeLessThanOrEqual(39);
    }
    out.chunks.length = 0;
    screen.done('ai.rarog.server started and answers on its local socket', { ms: 2000, changed: true });
    const lines = strip(out.text()).replace('\r', '').split('\n').filter((line) => line !== '');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    expect(lines[0]).toMatch(/^ ✓ Claude SDK {5}\S.* 2 s$/u);
    for (const line of lines.slice(1)) expect(line).toMatch(/^ {18}\S/u);
  });

  it('40 columns, wide (CJK) progress text: the live line has at most 39 terminal columns', () => {
    const { screen, out, tick } = screenOn({ tty: true, columns: 40, color: true });
    fourDone(screen);
    out.chunks.length = 0;
    screen.start('Claude SDK');
    screen.progress('下载软件包'.repeat(5));
    tick(65_000);
    vi.advanceTimersByTime(SPINNER_MS);
    expect(out.chunks.length).toBeGreaterThan(0);
    for (const chunk of out.chunks) {
      expect(chunk.includes('\n')).toBe(false);
      expect(displayWidth(strip(chunk).replace('\r', ''))).toBeLessThanOrEqual(39);
    }
    out.chunks.length = 0;
    screen.done('软件包'.repeat(12), { ms: 2000, changed: true });
    const lines = strip(out.text()).replace('\r', '').split('\n').filter((line) => line !== '');
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(40);
  });

  it('wide characters count two columns in truncate, word wrap and short paths', () => {
    expect(visibleWidth('下载a')).toBe(5);
    const cut = truncate('下载软件包'.repeat(2), 7);
    expect(displayWidth(cut)).toBeLessThanOrEqual(7);
    expect(cut.endsWith('…')).toBe(true);
    const lines = wrapWords(`a ${'下载软件包'.repeat(5)} b`, 10, 8);
    expect(displayWidth(lines[0] ?? '')).toBeLessThanOrEqual(10);
    for (const line of lines.slice(1)) expect(displayWidth(line)).toBeLessThanOrEqual(8);
    expect(lines.join('').replaceAll(' ', '')).toBe(`a${'下载软件包'.repeat(5)}b`);
    const long = shortPath(`${HOME}/项目/${'软件包'.repeat(10)}/文件.js`, HOME, 30);
    expect(displayWidth(long)).toBeLessThanOrEqual(30);
    expect(long.startsWith('~/')).toBe(true);
    expect(long.endsWith('/文件.js')).toBe(true);
  });

  it('home directory as ~, a path too long shortened in the middle', () => {
    expect(shortPath(`${HOME}/.local/share/rarog/sdk/0.3.247`, HOME, 60)).toBe('~/.local/share/rarog/sdk/0.3.247');
    const long = shortPath(`${HOME}/.local/share/rarog/sdk/0.3.247/node_modules/pkg/file.js`, HOME, 30);
    expect(visibleWidth(long)).toBe(30);
    expect(long.startsWith('~/')).toBe(true);
    expect(long.endsWith('/pkg/file.js')).toBe(true);
    expect(long).toContain('…');
    expect(shortPath('/opt/other', HOME, 60)).toBe('/opt/other');
    expect(shortPath(`${HOME}x/a`, HOME, 60)).toBe(`${HOME}x/a`);
  });

  it('columns 0 or missing → layout for 60; wide terminals → 72', () => {
    expect(layoutOf(0)).toEqual({ columns: 60, width: 60, liveMax: 59 });
    expect(layoutOf(undefined).width).toBe(60);
    expect(layoutOf(200)).toEqual({ columns: 200, width: 72, liveMax: 72 });
    const { screen } = screenOn({ tty: true, columns: 0, color: false });
    expect(screen.layout.width).toBe(60);
  });

  it('a long local version is shortened to the commit; a release stays', () => {
    expect(shortVersion('0.1.1-local.202611122227.a868ca4')).toBe('…a868ca4');
    expect(shortVersion('0.2.0')).toBe('0.2.0');
  });

  it('word wrap never exceeds its limits, also with a word longer than a line', () => {
    const lines = wrapWords('a verylongwordwithoutanyspaceatall b', 10, 8);
    expect(visibleWidth(lines[0] ?? '')).toBeLessThanOrEqual(10);
    for (const line of lines.slice(1)) expect(visibleWidth(line)).toBeLessThanOrEqual(8);
    expect(lines.join('')).toBe('averylongwordwithoutanyspaceatallb');
  });
});

describe('terminal description', () => {
  it('a terminal with colours, TERM=dumb, NO_COLOR, no TTY, no size', () => {
    const tty = { isTTY: true, columns: 80, hasColors: () => true };
    expect(describeTerminal(tty, { TERM: 'xterm-256color' })).toEqual({ tty: true, columns: 80, color: true });
    expect(describeTerminal(tty, { TERM: 'dumb' })).toEqual(NO_TERMINAL);
    expect(describeTerminal(tty, { NO_COLOR: '1' })).toEqual({ tty: true, columns: 80, color: false });
    expect(describeTerminal({ isTTY: false, columns: 80 }, {})).toEqual(NO_TERMINAL);
    expect(describeTerminal({ isTTY: true, columns: 0, hasColors: () => false }, {}))
      .toEqual({ tty: true, columns: 0, color: false });
  });
});

describe('run log', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'cli-screen-log-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const at = (second: number) => (): Date => new Date(2026, 10, 12, 22, 31, second);

  it('lines before open() land in the file after open(); file 0600 in a directory 0700', () => {
    const log = new RunLog({ command: 'setup', now: at(4) });
    log.line('backup kept');
    log.line('npm ci\nadded 12 packages');
    expect(log.path).toBeNull();
    const file = log.open(dir);
    log.line('after open');
    expect(path.basename(file)).toBe('setup-20261112-223104.log');
    expect(statSync(path.join(dir, 'logs')).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe([
      '22:31:04.000 backup kept', '22:31:04.000 npm ci', '22:31:04.000 added 12 packages',
      '22:31:04.000 after open', '',
    ].join('\n'));
    expect(log.open(dir)).toBe(file);
  });

  it('without open() no file and no directory', () => {
    const log = new RunLog({ command: 'setup', now: at(4) });
    log.line('kept in memory');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('the eleventh log removes the oldest by full name; other commands and files stay', () => {
    const logs = path.join(dir, 'logs');
    mkdirSync(logs, { mode: 0o700 });
    const older = Array.from({ length: LOGS_KEPT }, (_, i) => `setup-20261111-0000${String(i).padStart(2, '0')}.log`);
    for (const name of [...older, 'update-20200101-000000.log', 'notes.txt']) writeFileSync(path.join(logs, name), '');
    const file = new RunLog({ command: 'setup', now: at(4) }).open(dir);
    const left = readdirSync(logs).sort();
    expect(left).not.toContain(older[0]);
    expect(left).toContain(path.basename(file));
    expect(left.filter((name) => name.startsWith('setup-'))).toHaveLength(LOGS_KEPT);
    expect(left).toContain('update-20200101-000000.log');
    expect(left).toContain('notes.txt');
  });

  it('two runs in the same second do not overwrite each other', () => {
    const first = new RunLog({ command: 'setup', now: at(4) }).open(dir);
    const second = new RunLog({ command: 'setup', now: at(4) }).open(dir);
    expect(second).not.toBe(first);
  });

  it('twelve runs in the same second: exactly the ten newest logs stay', () => {
    const opened = Array.from({ length: 12 }, () => new RunLog({ command: 'setup', now: at(4) }).open(dir));
    expect(new Set(opened).size).toBe(12);
    const left = readdirSync(path.join(dir, 'logs')).sort();
    expect(left).toEqual(opened.slice(-LOGS_KEPT).map((file) => path.basename(file)).sort());
  });

  it('escape sequences from a child process do not reach the log', () => {
    const log = new RunLog({ command: 'update', now: at(4) });
    log.line('\x1b[32mgreen\x1b[39m\rdone');
    expect(readFileSync(log.open(dir), 'utf8')).toBe('22:31:04.000 greendone\n');
  });

  it('the step screen writes step results to the log and points at it after an interrupt', () => {
    const log = new RunLog({ command: 'setup', now: at(4) });
    const out = capture();
    const screen = new StepScreen({ write: out.write, terminal: NO_TERMINAL, home: dir, total: 2, log, now: () => 0 });
    screen.step('ok', 'Tools', 'node');
    const file = log.open(dir);
    screen.start('Service');
    screen.interrupt();
    // The unchanged step as the one line before the interrupted one, the log path on a line of its own.
    expect(out.text()).toBe([
      '[ok] 1 check ok, nothing changed',
      '[2/2] FAIL    Service: interrupted',
      'Interrupted. Nothing after this step was changed.',
      '   Log: ~/logs/setup-20261112-223104.log',
      '',
    ].join('\n'));
    expect(readFileSync(file, 'utf8')).toContain('[1/2] ok      Tools: node');
  });
});

describe('question forms', () => {
  function answers(...list: (string | null)[]) {
    const prompts: string[] = [];
    return {
      prompts,
      ask: (prompt: string): Promise<string | null> => {
        prompts.push(prompt);
        return Promise.resolve(list.length === 0 ? null : list.shift() ?? null);
      },
    };
  }

  it('[y/N]: EOF and Enter → no; y, yes, t, tak → yes', async () => {
    expect(await confirm(answers(null).ask, 'Replace it?', 'y/N', { width: 60 })).toBe(false);
    expect(await confirm(answers('').ask, 'Replace it?', 'y/N', { width: 60 })).toBe(false);
    for (const word of ['y', 'yes', 't', 'tak', ' TAK ']) {
      expect(await confirm(answers(word).ask, 'Replace it?', 'y/N', { width: 60 }), word).toBe(true);
    }
    expect(await confirm(answers('n').ask, 'Replace it?', 'y/N', { width: 60 })).toBe(false);
  });

  it('[Y/n]: Enter → yes, EOF → no, n → no', async () => {
    expect(await confirm(answers('').ask, 'Continue?', 'Y/n', { width: 60 })).toBe(true);
    expect(await confirm(answers(null).ask, 'Continue?', 'Y/n', { width: 60 })).toBe(false);
    expect(await confirm(answers('n').ask, 'Continue?', 'Y/n', { width: 60 })).toBe(false);
  });

  it('[y/N/d]: d → the difference is shown and the same question asked again', async () => {
    const asked = answers('d', 'D', 'tak');
    const shown: number[] = [];
    const yes = await confirm(asked.ask, 'Add 4 entries?', 'y/N/d', {
      width: 60, showDiff: () => { shown.push(1); },
    });
    expect(yes).toBe(true);
    expect(shown).toHaveLength(2);
    expect(asked.prompts).toHaveLength(3);
    expect(new Set(asked.prompts).size).toBe(1);
    expect(await confirm(answers('d', null).ask, 'Add?', 'y/N/d', { width: 60, showDiff: () => undefined }))
      .toBe(false);
    await expect(confirm(answers('y').ask, 'Add?', 'y/N/d', { width: 60 })).rejects.toThrow('showDiff');
  });

  it('the prompt: "? ", wrapped to the width with a two-space indent, ends with the hint and a space', () => {
    const prompt = questionPrompt('Add 4 Rarog entries (permission and context hooks, status line, sandbox read'
      + ' block) to ~/.claude/settings.json? A backup is kept.', 'y/N/d', 50);
    const lines = prompt.split('\n');
    expect(lines[0]?.startsWith('? Add 4 Rarog')).toBe(true);
    for (const line of lines.slice(1)) expect(line.startsWith('  ')).toBe(true);
    for (const line of lines) expect(visibleWidth(line.trimEnd())).toBeLessThanOrEqual(50);
    expect(prompt.endsWith('[y/N/d] ')).toBe(true);
    expect(questionPrompt('Continue?', 'Y/n', 60)).toBe('? Continue? [Y/n] ');
    expect(questionPrompt('Replace it?', 'y/N', 60)).toBe('? Replace it? [y/N] ');
  });

  it('a prompt line one column short of the width keeps its wrapping; a line of the full width wraps earlier', () => {
    // `? ` + 57 = 59 columns at width 60: the narrowest line an answered question still takes off the screen.
    expect(questionPrompt(`${'a'.repeat(57)} Next?`, 'y/N', 60)).toBe(`? ${'a'.repeat(57)}\n  Next? [y/N] `);
    expect(questionPrompt(`${'a'.repeat(30)} ${'b'.repeat(27)} Next?`, 'y/N', 60))
      .toBe(`? ${'a'.repeat(30)}\n  ${'b'.repeat(27)} Next? [y/N] `);
  });
});

describe('steps without a change, colour and width', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** What a person sees: escape sequences gone, every redraw keeps only what follows its `\r`. */
  const seen = (text: string): string[] => strip(text).replace(/\n$/u, '').split('\n')
    .map((line) => line.split('\r').at(-1) ?? '');

  /** Three unchanged steps, one changed, a warning, then Check. */
  function run(terminal: CliTerminal, verbose = false): string {
    const { screen, out } = screenOn(terminal, { total: 6, ...(verbose ? { verbose } : {}) });
    screen.step('ok', 'Tools', 'all present');
    screen.start('Config');
    screen.done('~/.config/rarog/config.json: created', { changed: true });
    screen.step('ok', 'Secrets', 'secret/private.env: present');
    screen.step('warn', 'Tailscale', 'not used', { fix: 'tailscale serve --bg 8930' });
    screen.step('ok', 'Hook copy', 'matches the source');
    screen.start('Check');
    screen.done('hook · SDK · herdr ok');
    return out.text();
  }

  /** Three unchanged steps, then Check: a run in which nothing changed. */
  function unchangedRun(terminal: CliTerminal): string {
    const { screen, out } = screenOn(terminal, { total: 4 });
    screen.step('ok', 'Tools', 'all present');
    screen.step('ok', 'Secrets', 'secret/private.env: present');
    screen.step('ok', 'Hook copy', 'matches the source');
    screen.start('Check');
    screen.done('hook · SDK · herdr ok');
    return out.text();
  }

  it('tty: an ok step without a change has no line; with a changed step in the run no summary line either',
    () => {
      expect(seen(run(TTY_MONO))).toEqual([
        ' ✓ Config         ~/.config/rarog/config.json: created',
        ' ! Tailscale      not used',
        '   Fix: tailscale serve --bg 8930',
        ' ✓ Check          hook · SDK · herdr ok',
      ]);
    });

  it('tty: a run without any change: one line with their number right before Check', () => {
    expect(seen(unchangedRun(TTY_MONO))).toEqual([
      ' ✓ 3 checks ok, nothing changed',
      ' ✓ Check          hook · SDK · herdr ok',
    ]);
  });

  it('a change behind a ! or ✗ (a partial write) counts too: no summary line', () => {
    for (const status of ['warn', 'fail'] as const) {
      const { screen, out } = screenOn(TTY_MONO, { total: 4 });
      screen.step('ok', 'Tools', 'all present');
      screen.step(status, 'Settings', '1 entry added, 3 wait for the hook copy', {
        fix: 'rarog hooks install, then rarog setup', changed: true,
      });
      screen.step('ok', 'Claude SDK', '0.3.247 present');
      screen.start('Check');
      screen.done('hook · SDK · herdr ok');
      expect(strip(out.text()), status).not.toContain('nothing changed');
    }
  });

  it('one unchanged step: "1 check"; none: no line at all, and Check keeps its own line', () => {
    const one = screenOn(TTY_MONO, { total: 2 });
    one.screen.step('ok', 'Tools', 'all present');
    one.screen.start('Check');
    one.screen.done('hook · SDK · herdr ok');
    expect(seen(one.out.text())).toEqual([' ✓ 1 check ok, nothing changed', ' ✓ Check          hook · SDK · herdr ok']);
    const none = screenOn(TTY_MONO, { total: 1 });
    none.screen.start('Check');
    none.screen.done('hook · SDK · herdr ok');
    expect(seen(none.out.text())).toEqual([' ✓ Check          hook · SDK · herdr ok']);
  });

  it('plain (no terminal): the same rule, plain lines, no escape byte', () => {
    const text = run(NO_TERMINAL);
    expect(text.includes(ESC)).toBe(false);
    expect(text.split('\n')).toEqual([
      '[2/6] ok      Config: ~/.config/rarog/config.json: created',
      '[4/6] warn    Tailscale: not used',
      '   Fix: tailscale serve --bg 8930',
      '[6/6] ok      Check: hook · SDK · herdr ok',
      '',
    ]);
    expect(unchangedRun(NO_TERMINAL).split('\n')).toEqual([
      '[ok] 3 checks ok, nothing changed',
      '[4/4] ok      Check: hook · SDK · herdr ok',
      '',
    ]);
  });

  it('a step with a question shows no time, a step without one keeps it', () => {
    const { screen, out, tick } = screenOn(TTY_MONO, { total: 4 });
    screen.start('Settings');
    screen.asking();
    out.write('? Add 4 Rarog entries to ~/.claude/settings.json? [y/N/d] y\n');
    tick(4000);
    screen.answered('y');
    screen.done('4 entries added', { changed: true });
    screen.start('Secrets');
    screen.asking({ hidden: true });
    out.write('? Soniox EU key (hidden): \n');
    tick(3000);
    screen.answered('');
    screen.done('key created', { changed: true });
    screen.start('Claude SDK');
    tick(3000);
    screen.done('0.3.247 downloaded', { changed: true });
    const shown = seen(out.text()).filter((line) => line.startsWith(' ✓'));
    expect(shown).toEqual([
      ' ✓ Settings       4 entries added',
      ' ✓ Secrets        key created',
      expect.stringMatching(/^ ✓ Claude SDK {5}0\.3\.247 downloaded +3 s$/u),
    ]);
  });

  it('the screen counts the ! lines for the closing line', () => {
    const { screen } = screenOn(TTY_MONO, { total: 4 });
    expect(screen.warnings).toBe(0);
    screen.step('warn', 'Tailscale', 'not used', { fix: 'tailscale serve --bg 8930' });
    screen.step('fail', 'Service', 'not started', { fix: 'rarog service install' });
    screen.step('warn', 'Check', 'server runs 0.0.1', { fix: 'rarog restart' });
    expect(screen.warnings).toBe(2);
  });

  it('--verbose keeps every step and has no summary line', () => {
    const text = run(TTY_COLOR, true);
    for (const title of ['Tools', 'Config', 'Secrets', 'Tailscale', 'Hook copy', 'Check']) {
      expect(text).toContain(` ${title}: `);
    }
    expect(text).not.toContain('nothing changed');
  });

  it('the run log keeps the unchanged steps', () => {
    const lines: string[] = [];
    const out = capture();
    const screen = new StepScreen({
      write: out.write, terminal: TTY_MONO, home: HOME, total: 2, now: () => 0,
      log: { line: (text) => { lines.push(text); }, path: null },
    });
    screen.step('ok', 'Tools', 'all present');
    expect(lines).toEqual(['[1/2] ok      Tools: all present']);
    expect(out.text()).toBe('\r\x1b[2K');
  });

  it('colour: header bold with the version dimmed, Fix: bold, Log: and paths dimmed, Next: bold, ? in cyan', () => {
    const { screen, out } = screenOn(TTY_COLOR);
    screen.heading('Rarog setup 0.1.0');
    expect(out.text()).toBe('\x1b[1mRarog setup\x1b[22m\x1b[90m 0.1.0\x1b[39m\n');
    out.chunks.length = 0;
    screen.start('Config');
    screen.done('~/.config/rarog/config.json: created', { changed: true });
    expect(out.text()).toContain('\x1b[90m~/.config/rarog/config.json\x1b[39m: created');
    out.chunks.length = 0;
    screen.step('fail', 'Service', 'not started', { fix: 'rarog service install', log: `${HOME}/logs/setup-x.log` });
    expect(out.text()).toContain('   \x1b[1mFix:\x1b[22m rarog service install\n');
    expect(out.text()).toContain('\x1b[90m   Log: ~/logs/setup-x.log\x1b[39m\n');
    out.chunks.length = 0;
    screen.line('Done in 4 s. Next: rarog pair (QR code for the app)', { labels: true });
    expect(out.text()).toBe('Done in 4 s. \x1b[1mNext:\x1b[22m rarog pair (QR code for the app)\n');
    expect(screen.questionPrompt('? Continue? [Y/n] ')).toBe('\x1b[36m?\x1b[39m Continue? [Y/n] ');
  });

  it('NO_COLOR (a terminal without colour): zero SGR sequences, the live line still redrawn in place', () => {
    const terminal = describeTerminal({ isTTY: true, columns: 60, hasColors: () => true }, { NO_COLOR: '1' });
    const { screen, out } = screenOn(terminal);
    screen.heading('Rarog setup 0.1.0');
    screen.start('Claude SDK');
    vi.advanceTimersByTime(SPINNER_MS * 3);
    screen.done('0.3.247 downloaded', { ms: 3000, changed: true });
    screen.step('fail', 'Service', 'not started', { fix: 'rarog service install', log: `${HOME}/x.log` });
    screen.line('Done in 4 s. Next: rarog pair', { labels: true });
    expect(screen.questionPrompt('? Continue? [Y/n] ')).toBe('? Continue? [Y/n] ');
    expect(out.text()).not.toMatch(SGR);
    expect(out.text()).toContain('\r\x1b[2K');
    expect(out.text().startsWith('Rarog setup 0.1.0\n')).toBe(true);
  });

  it('a Fix: sentence of 90 characters at 60 columns wraps under Fix:; a 143-character command stays whole', () => {
    const { screen, out } = screenOn(TTY_MONO);
    const sentence = 'start herdr in a terminal first, then run the setup again from the same terminal window ok';
    expect(sentence.length).toBe(90);
    // The absolute command of an installation under nvm.
    const command = `'${HOME}/.config/nvm/versions/node/v22.2.3/bin/node'`
      + ` '${HOME}/.config/nvm/versions/node/v22.2.3/lib/node_modules/@rarog/server/bin/rarog.mjs'`;
    expect(command.length).toBeGreaterThan(140);
    screen.step('fail', 'Service', 'not started', { fix: `${sentence}\n${command}` });
    const fix = seen(out.text()).slice(1);
    expect(fix[0]).toMatch(/^ {3}Fix: start herdr/u);
    const prose = fix.slice(0, -1);
    expect(prose.length).toBeGreaterThan(1);
    for (const line of prose) expect(visibleWidth(line), line).toBeLessThanOrEqual(60);
    for (const line of prose.slice(1)) expect(line).toMatch(/^ {8}\S/u);
    expect(prose.join(' ').replace(/\s+/gu, ' ').trim()).toBe(`Fix: ${sentence}`);
    expect(fix.at(-1)).toBe(`     ${command}`);
  });

  it('a Fix: that is one long command keeps it whole and byte for byte on its own line under Fix:', () => {
    const { screen, out } = screenOn(TTY_MONO);
    const command = "node bin/rarog.mjs doctor --data-dir '/home/tester/my  data/with a long name of the data dir'";
    expect(command.length).toBeGreaterThan(60);
    screen.step('fail', 'Check', 'server not answering', { fix: command });
    const fix = seen(out.text()).slice(1);
    expect(fix).toEqual(['   Fix:', `     ${command}`]);
  });

  it('a short Fix: command stays on the Fix: line unchanged, two spaces inside quotes included', () => {
    const { screen, out } = screenOn(TTY_MONO);
    screen.step('fail', 'Check', 'server not answering', { fix: "rarog doctor --data-dir '/a  b'" });
    expect(seen(out.text()).slice(1)).toEqual(["   Fix: rarog doctor --data-dir '/a  b'"]);
  });

  it('a path wider than the result column breaks after a slash, never inside a name', () => {
    const file = '/opt/homebrew/lib/node_modules/rarog/node_modules/@anthropic-ai/claude-agent-sdk/cli.js';
    const lines = wrapWords(`missing ${file}`, 40, 40);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    for (const line of lines.slice(1, -1)) expect(line.endsWith('/'), line).toBe(true);
    expect(lines.join('\n').replace(/\/\n/gu, '/').replace('\n', ' ')).toBe(`missing ${file}`);
    const { screen, out } = screenOn({ tty: true, columns: 50, color: false });
    screen.step('warn', 'Hook copy', `differs from ${file}`);
    const shown = seen(out.text());
    expect(shown.length).toBeGreaterThan(2);
    for (const line of shown) expect(visibleWidth(line)).toBeLessThanOrEqual(50);
    for (const line of shown.slice(1, -1)) expect(line.endsWith('/'), line).toBe(true);
  });

  it('Ctrl-C before the first step: "Interrupted. Nothing was changed." on a new line after the prompt, 130', () => {
    const { screen, out } = screenOn(TTY_MONO);
    screen.asking();
    out.write('? Continue? [Y/n] ');
    expect(screen.interrupt()).toBe(130);
    expect(out.text()).toBe('? Continue? [Y/n] \nInterrupted. Nothing was changed.\n');
  });

  it('EOF at a question: the next line starts on a new line; an answer (echoed by the terminal) adds none', () => {
    const { screen, out } = screenOn(TTY_MONO);
    screen.asking();
    out.write('? Replace it? [y/N] ');
    screen.answered(null);
    screen.line('Nothing changed.');
    screen.asking();
    out.write('? Again? [y/N] y\n');
    screen.answered('y');
    expect(out.text()).toBe('? Replace it? [y/N] \nNothing changed.\n? Again? [y/N] y\n');
  });
});

describe('prose outside the step screen: --help and one-line refusals', () => {
  const USAGE_TEXT = [
    'Usage:',
    '  rarog thing [--alpha] [--beta <value>] [--gamma <value>] [--delta] [--epsilon]',
    '      Does the thing with a description that runs well past the width of a narrow terminal, then goes on',
    '      in a second line of the same paragraph with a path /srv/someone/.config/rarog/secret/private.env.',
    '      --verbose: every detail line on the screen.',
    '  rarog short',
    '      Fits.',
  ].join('\n');
  const io = (terminal: CliTerminal): CliIo => ({ stdout: () => {}, stderr: () => {}, env: {}, cwd: '/', terminal });

  it('a wide description reflows as one paragraph under its indent, a command line wraps deeper', () => {
    const lines = wrapUsage(USAGE_TEXT, 60).split('\n');
    for (const line of lines) expect(visibleWidth(line), line).toBeLessThanOrEqual(60);
    expect(lines[0]).toBe('Usage:');
    expect(lines[1]).toBe('  rarog thing [--alpha] [--beta <value>] [--gamma <value>]');
    expect(lines[2]).toBe('      [--delta] [--epsilon]');
    for (const line of lines.slice(3, -4)) expect(line).toMatch(/^ {6}\S/u);
    // The description lines of one block are one paragraph: the words in order, nothing lost.
    const option = lines.indexOf('      --verbose: every detail line on the screen.');
    expect(option).toBeGreaterThan(3);
    const flat = (text: string): string => text.replace(/\s+/gu, '');
    expect(flat(lines.slice(3, option).join(''))).toBe(flat(USAGE_TEXT.split('\n').slice(2, 4).join('')));
    // The second source line runs on after the first: no short line between them.
    expect(lines.slice(3, option - 1).every((line) => visibleWidth(line) > 40), lines.join('\n')).toBe(true);
    // A block that fits stays as written.
    expect(lines.slice(-2)).toEqual(['  rarog short', '      Fits.']);
  });

  it('--help at 60 columns: no word left alone on a line, a <placeholder> never split, an option starts a line', () => {
    for (const text of [USAGE, `Usage:\n${SETUP_USAGE}`, `Usage:\n${UPDATE_USAGE}`]) {
      const shown = wrapUsage(text, 60).split('\n');
      const commands = text.split('\n').filter((line) => indentOf(line) < 6).join(' ');
      shown.forEach((line, index) => {
        expect(line, line).not.toContain('\ue000');
        const next = shown[index + 1];
        expect(line, line).not.toMatch(/<[^>]*$/u);
        // Greedy fill: in one paragraph the first word of the next line would not have fitted on this one.
        // A command line's continuation is not a paragraph line.
        if (next === undefined || commands.includes(line.trim()) || indentOf(line) < 6 || indentOf(next) !== indentOf(line) || next.trim().startsWith('--')
          || visibleWidth(line) <= 60 - 20) return;
        expect(visibleWidth(line) + 1 + visibleWidth(next.trim().split(' ')[0] ?? ''), `${line} | ${next}`)
          .toBeGreaterThan(60);
      });
    }
  });

  it('rarog --help, rarog setup --help, rarog update --help at 60 columns: every option line of the source starts a line', () => {
    for (const text of [USAGE, `Usage:\n${SETUP_USAGE}`, `Usage:\n${UPDATE_USAGE}`]) {
      const shown = wrapUsage(text, 60).split('\n');
      for (const line of shown) expect(visibleWidth(line), line).toBeLessThanOrEqual(60);
      const options = text.split('\n').filter((line) => /^ {6}--[a-z-]+:/u.test(line));
      for (const option of options) {
        const head = option.trim().split(' ').slice(0, 2).join(' ');
        expect(shown.some((line) => line.startsWith(`      ${head}`)), head).toBe(true);
      }
    }
    expect(SETUP_USAGE).toMatch(/^ {6}--verbose:/mu);
  });

  it('on a terminal --help fits its width; without a terminal the text stays as written', () => {
    const tty = usageFor(io({ tty: true, columns: 60, color: false }), USAGE_TEXT);
    for (const line of tty.split('\n')) expect(visibleWidth(line), line).toBeLessThanOrEqual(60);
    expect(usageFor(io(NO_TERMINAL), USAGE_TEXT)).toBe(USAGE_TEXT);
    // A wide terminal still lays out at most 72 columns.
    for (const line of usageFor(io({ tty: true, columns: 200, color: false }), USAGE_TEXT).split('\n')) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(72);
    }
  });

  it('a refusal: wrapped at the terminal width, one line without a terminal', () => {
    const sentence = 'rarog update --finish: no /h/.config/rarog/config.json, so there is no installation to finish;'
      + ' run rarog setup first.';
    const wrapped = sentenceFor(io({ tty: true, columns: 60, color: false }), sentence);
    expect(wrapped.split('\n').length).toBeGreaterThan(1);
    for (const line of wrapped.split('\n')) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    expect(wrapped.replace(/\n/gu, ' ')).toBe(sentence);
    expect(sentenceFor(io(NO_TERMINAL), sentence)).toBe(sentence);
  });
});

/**
 * On a terminal without `--verbose` an answered question leaves the screen: the cursor goes up by the rows
 * of the prompt (`ESC[nA`) and the screen is cleared below it (`ESC[J`). Only when the row count is certain: the live
 * columns known and the same at the question and at the answer, every prompt line and the last line with the answer
 * narrower than them. The terminal's own part (the echo and its line end) is written here as the terminal would.
 */
describe('an answered question leaves the screen', () => {
  const UP = /\x1b\[(\d+)A\r\x1b\[J/u;
  /** Rows the screen moved up after the answer, or `null` when the question stayed. */
  const rowsTaken = (text: string): number | null => {
    const match = UP.exec(text);
    return match === null ? null : Number(match[1]);
  };

  function collapsing(terminal: CliTerminal, columns: () => number, extra: { verbose?: boolean } = {}) {
    const out = capture();
    const screen = new StepScreen({
      write: out.write, terminal, home: HOME, total: 4, now: () => 0, columnsNow: columns,
      ...(extra.verbose === undefined ? {} : { verbose: extra.verbose }),
    });
    return { screen, out };
  }

  /** One question with its echo: the prompt, the typed answer and the line end, as a terminal shows them. */
  function ask(screen: StepScreen, out: Capture & { write: (text: string) => void }, prompt: string,
    answer: string | null): void {
    screen.asking({ prompt });
    out.write(answer === null ? prompt : `${prompt}${answer}\n`);
    screen.answered(answer);
  }

  it('[y/N] with "y": one row up and cleared, then the step line', () => {
    const { screen, out } = collapsing(TTY_MONO, () => 60);
    screen.start('Hook copy');
    ask(screen, out, '? Install the hook copy in ~/.claude/hooks/rarog? [y/N] ', 'y');
    screen.done('installed', { changed: true });
    expect(rowsTaken(out.text())).toBe(1);
    expect(out.text()).toMatch(/\[y\/N\] y\n\x1b\[1A\r\x1b\[J/u);
  });

  it('a question wrapped on two lines: both rows go', () => {
    const { screen, out } = collapsing(TTY_MONO, () => 60);
    const prompt = questionPrompt("Add 4 Rarog entries and herdr's hook to ~/.claude/settings.json?", 'y/N/d', 60);
    expect(prompt.split('\n')).toHaveLength(2);
    ask(screen, out, prompt, 'y');
    expect(rowsTaken(out.text())).toBe(2);
  });

  // Questions wrap one column short of the width, so a wrapped line never keeps an answered question on the screen.
  it('the settings question with the chained status line at 60 columns: all its rows go after "y"', () => {
    const { screen, out } = collapsing(TTY_MONO, () => 60);
    const question = entriesQuestion({
      changes: ['permission', 'context', 'statusLine', 'denyRead'], chains: true, reformatted: false, newFile: false,
      diff: [],
    }, 'herdr\'s hook');
    const prompt = questionPrompt(question, 'y/N/d', 60);
    for (const line of prompt.split('\n')) expect(visibleWidth(line.trimEnd())).toBeLessThan(60);
    ask(screen, out, prompt, 'y');
    expect(rowsTaken(out.text())).toBe(prompt.split('\n').length);
  });

  it('an answer that brings the line to the terminal width: the question stays; one column less goes', () => {
    // `? ` + 50 + ` [y/N] ` = 59 columns; with "y" the line is 60 wide.
    const prompt = `? ${'x'.repeat(50)} [y/N] `;
    const at60 = collapsing(TTY_MONO, () => 60);
    ask(at60.screen, at60.out, prompt, 'y');
    expect(rowsTaken(at60.out.text())).toBeNull();
    const at61 = collapsing(TTY_MONO, () => 61);
    ask(at61.screen, at61.out, prompt, 'y');
    expect(rowsTaken(at61.out.text())).toBe(1);
  });

  it('a prompt line as wide as the terminal: the question stays', () => {
    const { screen, out } = collapsing(TTY_MONO, () => 40);
    ask(screen, out, `? ${'x'.repeat(38)}\n  [y/N] `, 'y');
    expect(rowsTaken(out.text())).toBeNull();
  });

  it('the width changes between the question and the answer: the question stays', () => {
    let columns = 60;
    const { screen, out } = collapsing(TTY_MONO, () => columns);
    screen.asking({ prompt: '? Replace it? [y/N] ' });
    out.write('? Replace it? [y/N] y\n');
    columns = 80;
    screen.answered('y');
    expect(rowsTaken(out.text())).toBeNull();
  });

  it('a terminal wider than the layout (72): the live columns count, not the layout width', () => {
    // 70 columns of prompt and "yes": 73, wider than the layout, narrower than the terminal.
    const prompt = `? ${'x'.repeat(61)} [y/N] `;
    const wide = collapsing({ tty: true, columns: 100, color: false }, () => 100);
    ask(wide.screen, wide.out, prompt, 'yes');
    expect(rowsTaken(wide.out.text())).toBe(1);
    const at72 = collapsing({ tty: true, columns: 72, color: false }, () => 72);
    ask(at72.screen, at72.out, prompt, 'yes');
    expect(rowsTaken(at72.out.text())).toBeNull();
  });

  it('"d" then "y" at [y/N/d]: the question, the diff and the repeated question stay', async () => {
    const { screen, out } = collapsing(TTY_MONO, () => 60);
    const given = ['d', 'y'];
    const yes = await confirm(async (prompt) => {
      const answer = given.shift() ?? null;
      ask(screen, out, prompt, answer);
      return Promise.resolve(answer);
    }, 'Add 4 Rarog entries?', 'y/N/d', { width: 60, showDiff: () => { screen.line('  + diff'); } });
    expect(yes).toBe(true);
    expect(rowsTaken(out.text())).toBeNull();
    // The next question after them leaves the screen again.
    ask(screen, out, '? Install the hook copy? [y/N] ', 'y');
    expect(rowsTaken(out.text())).toBe(1);
  });

  it('EOF and Ctrl-C at [y/N] and at the key prompt: the question stays, the next line starts on a new one', () => {
    const eof = collapsing(TTY_MONO, () => 60);
    ask(eof.screen, eof.out, '? Replace it? [y/N] ', null);
    expect(eof.out.text()).toBe('? Replace it? [y/N] \n');
    const hiddenEof = collapsing(TTY_MONO, () => 60);
    hiddenEof.screen.asking({ prompt: '? Soniox EU key (hidden): ', hidden: true });
    hiddenEof.out.write('? Soniox EU key (hidden): \n');
    hiddenEof.screen.answered(null);
    expect(rowsTaken(hiddenEof.out.text())).toBeNull();
    const ctrlC = collapsing(TTY_MONO, () => 60);
    ctrlC.screen.start('Config');
    ctrlC.screen.asking({ prompt: '? Replace it? [y/N] ' });
    ctrlC.out.write('? Replace it? [y/N] ');
    expect(ctrlC.screen.interrupt()).toBe(130);
    expect(rowsTaken(ctrlC.out.text())).toBeNull();
    expect(strip(ctrlC.out.text())).toContain('? Replace it? [y/N] \n');
  });

  it('plain and --verbose: the question stays; NO_COLOR on a terminal: it goes', () => {
    const plain = collapsing(NO_TERMINAL, () => 60);
    ask(plain.screen, plain.out, '? Replace it? [y/N] ', 'y');
    expect(rowsTaken(plain.out.text())).toBeNull();
    const verbose = collapsing(TTY_MONO, () => 60, { verbose: true });
    ask(verbose.screen, verbose.out, '? Replace it? [y/N] ', 'y');
    expect(rowsTaken(verbose.out.text())).toBeNull();
    const noColor = describeTerminal({ isTTY: true, columns: 60, hasColors: () => true }, { NO_COLOR: '1' });
    expect(noColor.color).toBe(false);
    const mono = collapsing(noColor, () => 60);
    ask(mono.screen, mono.out, '? Replace it? [y/N] ', 'y');
    expect(rowsTaken(mono.out.text())).toBe(1);
  });

  it('unknown columns (none given, or 0): the question stays', () => {
    const out = capture();
    const screen = new StepScreen({ write: out.write, terminal: TTY_MONO, home: HOME, total: 4, now: () => 0 });
    ask(screen, out, '? Replace it? [y/N] ', 'y');
    expect(rowsTaken(out.text())).toBeNull();
    const zero = collapsing(TTY_MONO, () => 0);
    ask(zero.screen, zero.out, '? Replace it? [y/N] ', 'y');
    expect(rowsTaken(zero.out.text())).toBeNull();
  });

  it('the key prompt goes; a long key does not change the row count', () => {
    const { screen, out } = collapsing(TTY_MONO, () => 60);
    screen.asking({ prompt: '? Soniox EU key (hidden): ', hidden: true });
    out.write('? Soniox EU key (hidden): \n');
    screen.answered('k'.repeat(200));
    expect(rowsTaken(out.text())).toBe(1);
  });

  it('a note under a question goes with the next prompt; a line between them keeps it', () => {
    const { screen, out } = collapsing(TTY_MONO, () => 60);
    screen.questionNote(['  Every paired phone uses this key; give it a budget limit.']);
    screen.asking({ prompt: '? OpenAI API key (hidden): ', hidden: true });
    out.write('? OpenAI API key (hidden): \n');
    screen.answered('sk-test');
    expect(rowsTaken(out.text())).toBe(2);
    const between = collapsing(TTY_MONO, () => 60);
    between.screen.questionNote(['  A note.']);
    between.screen.line('another line');
    between.screen.asking({ prompt: '? OpenAI API key (hidden): ', hidden: true });
    between.out.write('? OpenAI API key (hidden): \n');
    between.screen.answered('sk-test');
    expect(rowsTaken(between.out.text())).toBe(1);
  });

  it('two notes written one after another both go with the next prompt', () => {
    const { screen, out } = collapsing(TTY_MONO, () => 60);
    screen.questionNote(['  Every paired phone uses this key; give it a budget limit.']);
    screen.questionNote(['  Hidden while you paste.']);
    screen.asking({ prompt: '? OpenAI API key (hidden): ', hidden: true });
    out.write('? OpenAI API key (hidden): \n');
    screen.answered('sk-test');
    expect(rowsTaken(out.text())).toBe(3);
  });

  it('a control character in the answer (tab, C0): the question stays', () => {
    for (const answer of ['y\t', '\x01y', 'y\x7f', 'y\x9b']) {
      const { screen, out } = collapsing(TTY_MONO, () => 60);
      ask(screen, out, '? Replace it? [y/N] ', answer);
      expect(rowsTaken(out.text()), JSON.stringify(answer)).toBeNull();
    }
  });

  it('a note as wide as the terminal, or written at other columns than its prompt: nothing leaves', () => {
    const prompt = '? OpenAI API key (hidden): ';
    const wide = collapsing(TTY_MONO, () => 60);
    wide.screen.questionNote([`  ${'x'.repeat(58)}`]);
    wide.screen.asking({ prompt, hidden: true });
    wide.out.write(`${prompt}\n`);
    wide.screen.answered('sk-test');
    expect(rowsTaken(wide.out.text())).toBeNull();

    let columns = 60;
    const moved = collapsing(TTY_MONO, () => columns);
    moved.screen.questionNote(['  A note.']);
    columns = 61;
    moved.screen.asking({ prompt, hidden: true });
    moved.out.write(`${prompt}\n`);
    moved.screen.answered('sk-test');
    expect(rowsTaken(moved.out.text())).toBeNull();
  });
});
