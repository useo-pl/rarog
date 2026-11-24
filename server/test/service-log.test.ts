/**
 * The service log before the supervisor opens it (`server/src/cli/service-log.ts`): the edges that the install tests
 * of `rarog-service.test.ts` and `rarog-service-linux.test.ts` do not reach. A symlink in place of the log is neither
 * followed nor replaced, and an error is a line on stdout, never an exception: the install has already stopped the
 * server when it gets there.
 */
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliIo } from '../src/cli/io.ts';
import { prepareServiceLog } from '../src/cli/service-log.ts';

function capture(): { io: CliIo; lines: () => string[] } {
  let stdout = '';
  const io: CliIo = { stdout: (text) => { stdout += text; }, stderr: () => {}, env: {}, cwd: tmpdir() };
  return { io, lines: () => stdout.split('\n').filter((line) => line !== '') };
}

describe('prepareServiceLog', () => {
  it('a symlink in place of the log: the target keeps its mode and text, the link stays', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'svclog-'));
    const target = path.join(dir, 'elsewhere.txt');
    writeFileSync(target, 'not a log\n');
    chmodSync(target, 0o644);
    const log = path.join(dir, 'server.log');
    symlinkSync(target, log);
    const { io, lines } = capture();
    prepareServiceLog(io, log);
    expect((statSync(target).mode & 0o777).toString(8)).toBe('644');
    expect(readFileSync(target, 'utf8')).toBe('not a log\n');
    expect([lstatSync(log).isSymbolicLink(), readlinkSync(log)]).toEqual([true, target]);
    expect(lines()).toHaveLength(1);
  });

  it('an error is one line with its code, not an exception', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'svclog-'));
    const log = path.join(dir, 'missing', 'server.log');
    const { io, lines } = capture();
    expect(() => { prepareServiceLog(io, log); }).not.toThrow();
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain('ENOENT');
  });
});
