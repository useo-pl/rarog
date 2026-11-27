/**
 * Test session rule (`sessions/test-session.ts`): which working directories count as temporary. The scheduler and
 * the manager tests take the fact as given; the edge cases of the path live here.
 */
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { inTemporaryDirectory } from '../src/sessions/test-session.ts';
import type { TempDirEnv } from '../src/sessions/test-session.ts';

/** A macOS-like system: `/var` is a link to `/private/var`, `/tmp` to `/private/tmp`. */
const MAC_TMPDIR = '/var/tmpdir/ab/T';
const macRealpath = (file: string): string => {
  if (file === '/tmp' || file.startsWith('/tmp/')) return `/private${file}`;
  if (file === '/var' || file.startsWith('/var/')) return `/private${file}`;
  return file;
};
const mac: TempDirEnv = { uid: 501, tmpdir: MAC_TMPDIR, realpath: macRealpath };
/** The roots exist, the working directory is gone (the scratchpad was cleaned up). */
const ROOTS = new Set(['/tmp/claude-501', '/private/tmp/claude-501', MAC_TMPDIR]);
const cwdGone: TempDirEnv['realpath'] = (file) => {
  if (ROOTS.has(file)) return macRealpath(file);
  throw new Error(`ENOENT: ${file}`);
};

describe('inTemporaryDirectory', () => {
  it.each([
    ['scratchpad of another session, on-disk form', '/private/tmp/claude-501/x/y/scratchpad/kpz/proj'],
    ['scratchpad, as written', '/tmp/claude-501/x/y/scratchpad/kpz/proj'],
    ['the scratchpad root itself', '/tmp/claude-501'],
    ['server temporary directory, as written', `${MAC_TMPDIR}/abc/proj`],
    ['server temporary directory, on-disk form', `/private${MAC_TMPDIR}/abc/proj`],
    ['trailing slash', '/private/tmp/claude-501/x/'],
  ])('temporary: %s', (_label, cwd) => {
    expect(inTemporaryDirectory(cwd, mac)).toBe(true);
    // A path that no longer exists is compared as written.
    expect(inTemporaryDirectory(cwd, { ...mac, realpath: cwdGone })).toBe(true);
  });

  it.each([
    ['a project', '/Users/x/Projects/app'],
    ['another prefix that only starts like the scratchpad', '/tmp/claude-501-other/x/proj'],
    ['scratchpad of another user', '/private/tmp/claude-502/x/proj'],
    ['plain /tmp', '/tmp/proj'],
    ['a sibling of the temporary directory', '/var/tmpdir/ab/Tother/proj'],
    ['empty', ''],
  ])('not temporary: %s', (_label, cwd) => {
    expect(inTemporaryDirectory(cwd, mac)).toBe(false);
  });

  it('a link from a project into the scratchpad counts by where it leads', () => {
    const linked: TempDirEnv = {
      ...mac,
      realpath: (file) => (file === '/Users/x/link' ? '/private/tmp/claude-501/x/proj' : macRealpath(file)),
    };
    expect(inTemporaryDirectory('/Users/x/link', linked)).toBe(true);
  });

  it('without a user id only the temporary directory counts', () => {
    const noUid: TempDirEnv = { ...mac, uid: undefined };
    expect(inTemporaryDirectory('/tmp/claude-501/x', noUid)).toBe(false);
    expect(inTemporaryDirectory(`${MAC_TMPDIR}/x`, noUid)).toBe(true);
  });

  it('a temporary directory at the filesystem root does not make every path temporary', () => {
    expect(inTemporaryDirectory('/Users/x/Projects/app', { ...mac, tmpdir: '/' })).toBe(false);
  });

  describe('on this machine', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'rarog-test-session-'));
    afterAll(() => { rmSync(base, { recursive: true, force: true }); });

    it('a real directory in os.tmpdir(), as written and on disk', () => {
      const dir = path.join(base, 'abc', 'proj');
      mkdirSync(dir, { recursive: true });
      expect(inTemporaryDirectory(dir)).toBe(true);
      expect(inTemporaryDirectory(realpathSync(dir))).toBe(true);
    });
  });
});
