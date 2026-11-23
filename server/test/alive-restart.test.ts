/**
 * Restart break fields of `alive.json` on the server side (`server/src/herdr/dialogs/shadow/alive.ts`): with a
 * restart grace G above 0 the stop write carries `stop: {ts, graceMs}` and every write from the first one until the
 * channel mode is resolved and a session is listed carries `phase: "starting"`; a hook that starts on either waits for
 * the channel (`server/test/hook-channel-restart.test.ts`). G = 0 or no option = neither field. G comes from
 * `RAROG_CONSENT_RESTART_GRACE` (`parseConsentRestartGrace`, whole seconds).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config-env.ts';
import { parseConsentRestartGrace } from '../src/config/flags.ts';
import {
  HOOK_ALIVE_FILENAME, HOOK_ALIVE_PHASE_STARTING, HOOK_RESTART_GRACE_DEFAULT_MS, HOOK_RESTART_GRACE_MAX_MS,
} from '../src/herdr/dialogs/hook/contract.ts';
import type { HookAliveFile } from '../src/herdr/dialogs/hook/contract.ts';
import { ALIVE_LOG_FILENAME } from '../src/herdr/dialogs/shadow/alive-log.ts';
import { createAliveWriter } from '../src/herdr/dialogs/shadow/alive.ts';

const S1 = '550e8400-e29b-41d4-a716-446655440000';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-alive-restart-'));
  dirs.push(dir);
  return dir;
}

const readAlive = (dir: string): HookAliveFile =>
  JSON.parse(readFileSync(join(dir, HOOK_ALIVE_FILENAME), 'utf8')) as HookAliveFile;

describe('alive.json restart break fields', { timeout: 5_000 }, () => {
  it('with G: `phase: "starting"` from the first write to the first write with a session, never again after it;'
    + ' the stop write carries `stop: {ts, graceMs}` and no phase', () => {
    const dir = dataDir();
    let sessions: string[] = [];
    let clock = 1_000;
    const writer = createAliveWriter({
      dataDir: dir, mode: 'all', send: () => true, bootId: 'boot-g', sessions: () => sessions, now: () => clock,
      graceMs: 45_000,
    });
    writer.start();
    expect(readAlive(dir)).toEqual({
      ts: 1_000, bootId: 'boot-g', mode: 'all', send: true, sessions: [], phase: HOOK_ALIVE_PHASE_STARTING,
    });
    clock = 2_000;
    writer.writeNow();
    expect(readAlive(dir).phase).toBe(HOOK_ALIVE_PHASE_STARTING);
    sessions = [S1];
    clock = 3_000;
    expect(writer.sessionsChanged()).toBe(true);
    expect(readAlive(dir)).toEqual({ ts: 3_000, bootId: 'boot-g', mode: 'all', send: true, sessions: [S1] });
    sessions = [];
    clock = 4_000;
    writer.writeNow();
    expect(readAlive(dir)).toEqual({ ts: 4_000, bootId: 'boot-g', mode: 'all', send: true, sessions: [] });
    clock = 5_000;
    writer.stop();
    expect(readAlive(dir)).toEqual({
      ts: 5_000, bootId: 'boot-g', mode: 'off', send: true, sessions: [], stop: { ts: 5_000, graceMs: 45_000 },
    });
    // The transition log stays as it was: the break fields are for the hook only.
    const lines = readFileSync(join(dir, ALIVE_LOG_FILENAME), 'utf8').split('\n').filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line['ev'])).toEqual(['start', 'zmiana', 'zmiana', 'stop']);
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(['at', 'bootId', 'ev', 'mode', 'send', 'sessions']);
    }
  });

  it('a stop before the first session list: `stop`, no phase', () => {
    const dir = dataDir();
    const writer = createAliveWriter({
      dataDir: dir, mode: 'off', send: () => true, bootId: 'boot-s', sessions: () => [], now: () => 7,
      graceMs: 2_000,
    });
    writer.start();
    expect(readAlive(dir).phase).toBe(HOOK_ALIVE_PHASE_STARTING);
    writer.stop();
    expect(readAlive(dir)).toEqual({
      ts: 7, bootId: 'boot-s', mode: 'off', send: true, sessions: [], stop: { ts: 7, graceMs: 2_000 },
    });
  });

  it('a first write that already has a session: no phase at all', () => {
    const dir = dataDir();
    const writer = createAliveWriter({
      dataDir: dir, mode: 'main', send: () => true, bootId: 'boot-f', sessions: () => [S1], graceMs: 45_000,
    });
    writer.start();
    expect(readAlive(dir).phase).toBeUndefined();
    writer.stop();
  });

  it('sessions before the channel mode is resolved (`channelStarting`): the phase stays; the first write after the'
    + ' resolution with a session drops it', () => {
    const dir = dataDir();
    let starting = true;
    let mode: 'off' | 'all' = 'off';
    const writer = createAliveWriter({
      dataDir: dir, mode: () => mode, send: () => true, bootId: 'boot-r', sessions: () => [S1], now: () => 13,
      graceMs: 45_000, channelStarting: () => starting,
    });
    writer.start();
    expect(readAlive(dir)).toEqual({
      ts: 13, bootId: 'boot-r', mode: 'off', send: true, sessions: [S1], phase: HOOK_ALIVE_PHASE_STARTING,
    });
    writer.writeNow();
    expect(readAlive(dir).phase).toBe(HOOK_ALIVE_PHASE_STARTING);
    [starting, mode] = [false, 'all'];
    writer.writeNow();
    expect(readAlive(dir)).toEqual({ ts: 13, bootId: 'boot-r', mode: 'all', send: true, sessions: [S1] });
    writer.stop();
  });

  it('the channel mode resolved before the first session list: the phase stays until the first write with a session',
    () => {
      const dir = dataDir();
      let sessions: string[] = [];
      let starting = true;
      const writer = createAliveWriter({
        dataDir: dir, mode: () => (starting ? 'off' : 'all'), send: () => true, bootId: 'boot-e',
        sessions: () => sessions, graceMs: 45_000, channelStarting: () => starting,
      });
      writer.start();
      starting = false;
      writer.writeNow();
      expect(readAlive(dir)).toMatchObject({ mode: 'all', sessions: [], phase: HOOK_ALIVE_PHASE_STARTING });
      sessions = [S1];
      expect(writer.sessionsChanged()).toBe(true);
      expect(readAlive(dir).phase).toBeUndefined();
      writer.stop();
    });

  it('the kill switch while the channel mode is still starting, with sessions listed: no phase at once', () => {
    const dir = dataDir();
    let killed = false;
    const writer = createAliveWriter({
      dataDir: dir, mode: 'off', send: () => true, bootId: 'boot-ks', sessions: () => [S1], now: () => 17,
      graceMs: 45_000, killswitch: () => killed, channelStarting: () => !killed,
    });
    writer.start();
    expect(readAlive(dir).phase).toBe(HOOK_ALIVE_PHASE_STARTING);
    killed = true;
    writer.writeNow();
    expect(readAlive(dir)).toEqual({ ts: 17, bootId: 'boot-ks', mode: 'off', send: true, sessions: [S1] });
    writer.stop();
    expect(readAlive(dir)).toEqual({ ts: 17, bootId: 'boot-ks', mode: 'off', send: true, sessions: [] });
  });

  it('the kill switch (`rarog dialogs off`): neither field from its first write on, also in the stop write', () => {
    const dir = dataDir();
    let killed = false;
    let mode: 'off' | 'all' = 'off';
    const writer = createAliveWriter({
      dataDir: dir, mode: () => mode, send: () => true, bootId: 'boot-k', sessions: () => [], now: () => 11,
      graceMs: 45_000, killswitch: () => killed,
    });
    writer.start();
    expect(readAlive(dir).phase).toBe(HOOK_ALIVE_PHASE_STARTING);
    killed = true;
    writer.writeNow();
    expect(readAlive(dir)).toEqual({ ts: 11, bootId: 'boot-k', mode: 'off', send: true, sessions: [] });
    mode = 'all';
    writer.writeNow();
    expect(readAlive(dir).phase).toBeUndefined();
    writer.stop();
    expect(readAlive(dir)).toEqual({ ts: 11, bootId: 'boot-k', mode: 'off', send: true, sessions: [] });
  });

  it.each([['G = 0', 0], ['no option', undefined]] as const)('%s: neither `phase` nor `stop`', (_name, graceMs) => {
    const dir = dataDir();
    const writer = createAliveWriter({
      dataDir: dir, mode: 'all', send: () => true, bootId: 'boot-0', sessions: () => [], now: () => 9,
      ...(graceMs === undefined ? {} : { graceMs }),
    });
    writer.start();
    expect(readAlive(dir)).toEqual({ ts: 9, bootId: 'boot-0', mode: 'all', send: true, sessions: [] });
    writer.stop();
    expect(readAlive(dir)).toEqual({ ts: 9, bootId: 'boot-0', mode: 'off', send: true, sessions: [] });
  });
});

describe('`RAROG_CONSENT_RESTART_GRACE`: whole seconds to milliseconds', () => {
  it.each([
    ['unset', HOOK_RESTART_GRACE_DEFAULT_MS, undefined],
    ['empty', HOOK_RESTART_GRACE_DEFAULT_MS, ''],
    ['whitespace around', 45_000, ' 45 '],
    ['0 = no grace', 0, '0'],
    ['1', 1_000, '1'],
    ['the ceiling', HOOK_RESTART_GRACE_MAX_MS, String(HOOK_RESTART_GRACE_MAX_MS / 1000)],
  ] as const)('%s → %s ms', (_name, expected, raw) => {
    expect(parseConsentRestartGrace(raw)).toBe(expected);
  });

  it.each([
    String(HOOK_RESTART_GRACE_MAX_MS / 1000 + 1), '-1', '1.5', '45s', 'abc', '1e3', '0x10',
  ])('`%s` stops the start', (raw) => {
    expect(() => parseConsentRestartGrace(raw)).toThrow(ConfigError);
    expect(() => parseConsentRestartGrace(raw)).toThrow(/RAROG_CONSENT_RESTART_GRACE/);
  });
});
