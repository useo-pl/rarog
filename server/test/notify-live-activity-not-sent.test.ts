/**
 * Live Activity sends without an attempt: a result from `NO_ATTEMPT_REASONS` (no pass yet,
 * a refused pass, a paused or disabled key environment) is not a failure. The `counts` line ends with
 * `→ not sent (<reason>)`, the hourly line counts it as `not sent` instead of `unsuccessful`, and a tile end without
 * an attempt is not counted as a failure either. Retries and real APNs failures stay as they were.
 */
import { describe, expect, it } from 'vitest';
import type { ApnsResult } from '../src/notify/apns.ts';
import {
  LIVE_ACTIVITY_COUNTS_LOG, LIVE_ACTIVITY_HEARTBEAT_MS, LIVE_ACTIVITY_QUIET_END_MS, LIVE_ACTIVITY_RETRY_MS,
} from '../src/notify/live-activity.ts';
import {
  DEVICE, IDLE, UPDATE_1, aps, owner, registered, settle, setup, useLiveActivityHarness,
} from './helpers/live-activity-harness.ts';
import type { Harness } from './helpers/live-activity-harness.ts';

useLiveActivityHarness();

const HOUR_MS = 60 * 60_000;
const countLines = (h: Harness): string[] => h.logs.filter((l) => l.startsWith(`${LIVE_ACTIVITY_COUNTS_LOG} `));
const hourLines = (h: Harness): string[] => h.logs.filter((l) => l.startsWith('live-activity: last hour — '));
const noAttempt = (reason: string): ApnsResult => ({ kind: 'failed', status: null, reason });

describe('Live Activity — sends without an attempt', () => {
  it('`pass-missing`: the counts line ends with `→ not sent (pass-missing)`, not with `→ failed`', async () => {
    const h = setup();
    h.respond = () => noAttempt('pass-missing');
    await registered(h);
    expect(h.sent).toHaveLength(1);
    expect(countLines(h)).toHaveLength(1);
    expect(countLines(h)[0]).toMatch(/, first send to the activity, priority 5, answer after 0\.0 s → not sent \(pass-missing\)$/);
  });

  it.each(['pass-invalid', 'paused', 'disabled'])('`%s`: the counts line names its own reason', async (reason) => {
    const h = setup();
    h.respond = () => noAttempt(reason);
    await registered(h);
    expect(countLines(h)[0]).toMatch(new RegExp(` → not sent \\(${reason}\\)$`));
    // The retry stays as before: the same counts are sent again after a minute.
    await h.clock.advance(LIVE_ACTIVITY_RETRY_MS);
    expect(h.sent).toHaveLength(2);
    expect(countLines(h)[1]).toMatch(new RegExp(` → not sent \\(${reason}\\)$`));
  });

  it('after the pass arrives and the send succeeds: `→ delivered`', async () => {
    const h = setup();
    h.respond = () => noAttempt('pass-missing');
    await registered(h);
    h.respond = () => ({ kind: 'ok' });
    h.controller.passReady(DEVICE);
    await h.clock.advance(0);
    expect(h.sent).toHaveLength(2);
    expect(countLines(h)).toHaveLength(2);
    expect(countLines(h)[1]).toMatch(/, first send to the activity, priority 5, .*→ delivered$/);
  });

  it('an hour of sends without an attempt only: `unsuccessful: 0, not sent: N`', async () => {
    const h = setup();
    h.respond = () => noAttempt('pass-missing');
    await registered(h);
    await h.clock.advance(HOUR_MS);
    const [line] = hourLines(h);
    expect(line).toMatch(/^live-activity: last hour — sends: 0 \(urgent: 0, heartbeat: 0, chimes: 0\), ends: 0,/);
    expect(line).toMatch(/, unsuccessful: 0, not sent: [1-9]\d*$/);
  });

  it('APNs 500 stays `→ failed` and `unsuccessful: 1`, without a `not sent` count', async () => {
    const h = setup();
    h.respond = () => ({ kind: 'failed', status: 500, reason: 'InternalServerError' });
    await registered(h);
    expect(countLines(h)[0]).toMatch(/ → failed$/);
    h.respond = () => ({ kind: 'ok' });
    // The hourly line comes with the first send after the hour: here the next heartbeat.
    await h.clock.advance(HOUR_MS + LIVE_ACTIVITY_HEARTBEAT_MS);
    const [line] = hourLines(h);
    expect(line).toMatch(/, ends: 0, unsuccessful: 1$/);
  });

  it('a tile end without an attempt is not counted as `unsuccessful`', async () => {
    const h = setup();
    await registered(h);
    await h.set(IDLE);
    h.respond = (s) => (aps(s)['event'] === 'end' ? noAttempt('pass-missing') : { kind: 'ok' });
    await h.clock.advance(LIVE_ACTIVITY_QUIET_END_MS);
    expect(h.sent.some((s) => aps(s)['event'] === 'end')).toBe(true);
    // The block stays and the end is retried, as before.
    expect(h.devices.get(DEVICE)?.liveActivity?.activityId).toBe('akt-1');
    await h.clock.advance(HOUR_MS);
    const [line] = hourLines(h);
    expect(line).toMatch(/, ends: 0, unsuccessful: 0, not sent: [1-9]\d*$/);
  });

  it('a tile end without an attempt logs `→ not sent (<reason>)`, and the retry stays after a minute', async () => {
    const h = setup();
    await registered(h);
    await h.set(IDLE);
    h.respond = (s) => (aps(s)['event'] === 'end' ? noAttempt('pass-missing') : { kind: 'ok' });
    await h.clock.advance(LIVE_ACTIVITY_QUIET_END_MS);
    expect(h.logs).toContain('live-activity: end (quiet 30 min) → not sent (pass-missing) — retry in 60 s');
    expect(h.logs.some((l) => l.startsWith('live-activity: end (quiet 30 min) → failed'))).toBe(false);
  });

  it.each([
    ['app', (h: Harness): void => { expect(h.controller.end(DEVICE, 'akt-1')).toBe(true); }],
    ['unregister', (h: Harness): void => { h.controller.forgetDevice(DEVICE); h.devices.remove(DEVICE); }],
  ])('an end from `%s` without an attempt counts as `not sent`, not as an end, and is not retried', async (reason, end) => {
    const h = setup();
    await registered(h);
    // Straight past the hourly window without firing timers (`advance` would move the clock back to the overdue
    // heartbeat): the end is the first send after the window, so its answer writes the hourly line.
    h.clock.now += HOUR_MS;
    h.respond = () => noAttempt('pass-missing');
    const before = h.sent.length;
    end(h);
    await settle();
    expect(h.sent).toHaveLength(before + 1);
    expect(h.logs).toContain(`live-activity: end (${reason}) → not sent (pass-missing)`);
    const [line] = hourLines(h);
    expect(line).toMatch(/, ends: 0, unsuccessful: 0, not sent: 1$/);
    await h.clock.advance(LIVE_ACTIVITY_RETRY_MS);
    expect(h.sent).toHaveLength(before + 1);
  });

  it('a done chime without an attempt logs `done chime → not sent (<reason>)`', async () => {
    const h = setup();
    h.devices.upsert({ token: DEVICE, environment: 'development', label: 'iPhone·Rarog', alerts: true, ...owner(DEVICE) });
    expect(h.controller.register(DEVICE, { activityId: 'akt-1', updateToken: UPDATE_1 })).toBe('started');
    await h.clock.advance(0);
    h.respond = (s) => ('alert' in aps(s) ? noAttempt('paused') : { kind: 'ok' });
    h.sessions = IDLE;
    expect(h.controller.chime()).toBe(1);
    await h.clock.advance(0);
    expect(h.logs).toContain('live-activity: done chime → not sent (paused)');
  });
});
