/**
 * The definition launchd has loaded (`server/src/cli/launchd-loaded.ts`): the arguments block of a
 * `launchctl print gui/<uid>/<label>` printout in the shape measured on macOS 27.2 (`\targuments = {`, one argument
 * per line after two tabs, `\t}`), every other shape an issue, and the reader over a fake `launchctl` in `PATH`
 * (never the real one): exit 113 absent, exit 0 with the block loaded, exit 0 without it or another exit unknown.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliIo } from '../src/cli/io.ts';
import { loadedDefinition, parseLoadedArguments } from '../src/cli/launchd-loaded.ts';

const NODE = '/Users/u/.config/nvm/versions/node/v22.22.3/bin/node';
const BIN = '/Users/u/.config/nvm/versions/node/v22.22.3/lib/node_modules/rarog/bin/rarog.mjs';

/** A service printout around an arguments block of `args` lines (each already with its indent). */
function printout(args: readonly string[]): string {
  return [
    'gui/501/ai.rarog.server = {',
    '\tactive count = 1',
    '\tpath = /Users/u/Library/LaunchAgents/ai.rarog.server.plist',
    '\tstate = running',
    '',
    `\tprogram = ${NODE}`,
    ...args,
    '',
    '\tinherited environment = {',
    '\t\tSSH_AUTH_SOCK => /private/tmp/com.apple.launchd.x/Listeners',
    '\t}',
    '',
    '\tevent triggers = {',
    '\t\targuments = {',
    '\t\t\tnested',
    '\t\t}',
    '\t}',
    '}',
    '',
  ].join('\n');
}

const block = (...lines: string[]): string[] => ['\targuments = {', ...lines, '\t}'];

describe('parseLoadedArguments: the arguments block of launchctl print', () => {
  it('the measured shape: the arguments in order, a block nested deeper ignored', () => {
    expect(parseLoadedArguments(printout(block(`\t\t${NODE}`, `\t\t${BIN}`, '\t\tserve'))))
      .toEqual({ argv: [NODE, BIN, 'serve'] });
  });

  it('an argument with spaces stays one argument', () => {
    expect(parseLoadedArguments(printout(block('\t\t/Users/u/My Apps/node', `\t\t${BIN}`))))
      .toEqual({ argv: ['/Users/u/My Apps/node', BIN] });
  });

  it('no block, a block without its end, a second block, an empty block, a line of another shape: an issue', () => {
    expect(parseLoadedArguments(printout([]))).toEqual({ issue: 'no arguments block' });
    expect(parseLoadedArguments(`x = {\n\targuments = {\n\t\t${NODE}\n`))
      .toEqual({ issue: 'arguments block not closed' });
    expect(parseLoadedArguments(printout([...block(`\t\t${NODE}`), ...block(`\t\t${BIN}`)])))
      .toEqual({ issue: 'arguments block appears 2 times instead of once' });
    expect(parseLoadedArguments(printout(block()))).toEqual({ issue: 'empty arguments block' });
    expect(parseLoadedArguments(printout(block(`\t\t${NODE}`, `\t${BIN}`))))
      .toEqual({ issue: 'line 9 of the arguments block is not "<tab><tab><argument>"' });
  });
});

describe('loadedDefinition: launchctl print of the label, a fake in PATH', () => {
  /** An io whose `PATH` starts with a fake `launchctl` exiting `code`: `text` on stdout, on stderr for another code. */
  function fakeIo(code: number, text: string): { io: CliIo; calls: () => string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'll-'));
    writeFileSync(path.join(dir, 'out'), text);
    const file = path.join(dir, 'launchctl');
    writeFileSync(file, [
      '#!/bin/bash',
      `printf '%s\\n' "$*" >> '${dir}/calls'`,
      `if [ ${String(code)} -eq 0 ]; then cat '${dir}/out'; else cat '${dir}/out' >&2; fi`,
      `exit ${String(code)}`,
      '',
    ].join('\n'));
    chmodSync(file, 0o755);
    const io: CliIo = { stdout: () => {}, stderr: () => {}, env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir }, cwd: dir };
    const log = path.join(dir, 'calls');
    return { io, calls: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
  }

  const uid = String(process.getuid?.() ?? 0);

  it('exit 0 with the block: loaded with its arguments; print asks for the label in the GUI domain', () => {
    const { io, calls } = fakeIo(0, printout(block(`\t\t${NODE}`, `\t\t${BIN}`, '\t\tserve')));
    expect(loadedDefinition('ai.rarog.server', io, 'darwin')).toEqual({ kind: 'loaded', argv: [NODE, BIN, 'serve'] });
    expect(calls()).toBe(`print gui/${uid}/ai.rarog.server\n`);
  });

  it('exit 113: absent; another exit: unknown with its first stderr line; exit 0 without the block: unknown', () => {
    expect(loadedDefinition('ai.rarog.server', fakeIo(113, 'Bad request.\n').io, 'darwin')).toEqual({ kind: 'absent' });
    expect(loadedDefinition('ai.rarog.server', fakeIo(1, 'Operation not permitted\n').io, 'darwin')).toEqual({
      kind: 'unknown', detail: `launchctl print gui/${uid}/ai.rarog.server: exit status 1, Operation not permitted`,
    });
    expect(loadedDefinition('ai.rarog.server', fakeIo(0, printout([])).io, 'darwin')).toEqual({
      kind: 'unknown', detail: `launchctl print gui/${uid}/ai.rarog.server: no arguments block`,
    });
  });

  it('Linux: absent without calling launchctl', () => {
    const { io, calls } = fakeIo(0, printout(block(`\t\t${NODE}`)));
    expect(loadedDefinition('ai.rarog.server', io, 'linux')).toEqual({ kind: 'absent' });
    expect(calls()).toBe('');
  });
});
