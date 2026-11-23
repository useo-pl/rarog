/**
 * Shared harness of the Live Activity driver tests (`notify-live-activity*.test.ts`): a controlled clock with a timer
 * queue, a fake push sender that records every send, a real device registry file in a temporary directory, and the
 * session fixtures the driver aggregates. A test file calls {@link useLiveActivityHarness} once at the top level;
 * every {@link setup} gets its own registry subdirectory, closed and removed after each test.
 */
import { afterEach, beforeEach, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionSummary } from '@rarog/shared';
import type { ApnsEnvironment, LiveActivityContentState } from '@rarog/shared/rest';
import type { ApnsResult } from '../../src/notify/apns.ts';
import type { ApnsRequest } from '../../src/notify/apns-payload.ts';
import { createApnsDeviceStore } from '../../src/notify/apns-devices.ts';
import type { ApnsDeviceStore } from '../../src/notify/apns-devices.ts';
import { LIVE_ACTIVITY_COALESCE_MS, createLiveActivity } from '../../src/notify/live-activity.ts';
import type { LiveActivityController } from '../../src/notify/live-activity.ts';
import type { SendContext } from '../../src/notify/sender.ts';
import { makeSummary } from '../fake-manager.ts';

export const NOW = Date.parse('2026-10-07T10:00:00.000Z');
export const NOW_S = NOW / 1000;
export const iso = (ms: number): string => new Date(ms).toISOString();

/** Controlled clock + timer queue (the `notify-harmonogram.test.ts` pattern). */
export class Clock {
  now = NOW;
  #next = 1;
  readonly #jobs = new Map<number, { at: number; cb: () => void }>();

  readonly set = (cb: () => void, ms: number): unknown => {
    const id = this.#next++;
    this.#jobs.set(id, { at: this.now + ms, cb });
    return id;
  };

  readonly clear = (handle: unknown): void => {
    this.#jobs.delete(handle as number);
  };

  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      let dueId: number | undefined;
      let dueAt = Infinity;
      for (const [id, job] of this.#jobs) {
        if (job.at <= target && job.at < dueAt) {
          dueAt = job.at;
          dueId = id;
        }
      }
      if (dueId === undefined) break;
      const job = this.#jobs.get(dueId);
      this.#jobs.delete(dueId);
      this.now = dueAt;
      job?.cb();
      await settle();
    }
    this.now = target;
    await settle();
  }
}

export const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

export const DEVICE = 'a1b2c3d4'.repeat(8);
/** The app topic in the test entries. */
export const RAROG_TOPIC = 'ai.rarog.app';
/** Entry owner: the device from token pairing (first 32 characters) and the app topic. */
export const owner = (token: string): { deviceId: string; topic: string } => ({ deviceId: token.slice(0, 32), topic: RAROG_TOPIC });
export const UPDATE_1 = '0f1e2d3c'.repeat(10);
export const UPDATE_2 = '9e8d7c6b'.repeat(10);

export interface Sent {
  readonly environment: ApnsEnvironment;
  readonly token: string;
  readonly request: ApnsRequest;
  readonly at: number;
  /** Send route context from the driver. */
  readonly context?: SendContext;
}

export interface Harness {
  readonly controller: LiveActivityController;
  /** Registry directory of THIS harness (a subdirectory of the test directory). */
  readonly dataDir: string;
  readonly devices: ApnsDeviceStore;
  readonly clock: Clock;
  readonly sent: Sent[];
  readonly logs: string[];
  sessions: SessionSummary[];
  /** Mac load and plan limits, which the driver reads through getters. */
  mac: LiveActivityContentState['mac'];
  limits: LiveActivityContentState['limits'];
  /** The fake sender's answer to the NEXT send. */
  respond: (sent: Sent) => ApnsResult | Promise<ApnsResult>;
  /** Session state change + the manager's global event (with the driver's coalescing). */
  set(sessions: SessionSummary[]): Promise<void>;
}

let dataDir = '';
let harnesses: Harness[] = [];

/** Registers the per-test directory and the cleanup of every harness created in the test. */
export function useLiveActivityHarness(): void {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-la-'));
    harnesses = [];
  });

  afterEach(async () => {
    for (const h of harnesses) {
      h.controller.close();
      await h.devices.flush();
    }
    await rm(dataDir, { recursive: true, force: true });
  });
}

export const WORKING = [makeSummary({ id: 'w', state: 'running', stateSince: iso(NOW - 60_000) })];
export const ONE_WAITING = [
  makeSummary({ id: 'p', state: 'waiting-permission', stateSince: iso(NOW - 1_000), waitingFor: { kind: 'permission', tool: 'Bash' } }),
];
export const TWO_WAITING = [
  ...ONE_WAITING,
  makeSummary({ id: 'q', state: 'waiting-question', stateSince: iso(NOW - 500) }),
];
export const IDLE = [makeSummary({ id: 'w', state: 'waiting-input' })];

/**
 * Harness with its own registry in a separate subdirectory. The registry reads the file on creation and writes it in
 * the background (`fs/promises`, outside the controlled clock), so a second harness in the same directory would load
 * the first one's state once its write reaches the disk (under CI runner load: `register` → `unchanged` instead of
 * `started`).
 */
export function setup(initial: SessionSummary[] = WORKING): Harness {
  const clock = new Clock();
  const harnessDir = mkdtempSync(join(dataDir, 'uprzaz-'));
  const devices = createApnsDeviceStore({ dataDir: harnessDir, now: () => clock.now });
  const sent: Sent[] = [];
  const logs: string[] = [];
  const harness: Harness = {
    dataDir: harnessDir, devices, clock, sent, logs,
    sessions: initial,
    mac: undefined,
    limits: undefined,
    respond: () => ({ kind: 'ok' }),
    controller: undefined as unknown as LiveActivityController,
    // After `set` the clock stands EXACTLY at the recompute (the end of the event coalescing window).
    async set(sessions) {
      harness.sessions = sessions;
      harness.controller.poke();
      await clock.advance(LIVE_ACTIVITY_COALESCE_MS);
    },
  };
  (harness as { controller: LiveActivityController }).controller = createLiveActivity({
    devices,
    sender: {
      send: async (environment, token, request, context) => {
        const entry: Sent = { environment, token, request, at: clock.now, ...(context === undefined ? {} : { context }) };
        sent.push(entry);
        return harness.respond(entry);
      },
    },
    sessions: () => harness.sessions,
    mac: () => harness.mac,
    limits: () => harness.limits,
    now: () => clock.now,
    setTimeout: clock.set,
    clearTimeout: clock.clear,
    log: (line) => { logs.push(line); },
  });
  harnesses.push(harness);
  return harness;
}

export async function registered(h: Harness, activityId = 'akt-1', updateToken = UPDATE_1): Promise<void> {
  if (h.devices.get(DEVICE) === undefined) {
    h.devices.upsert({ token: DEVICE, environment: 'development', label: 'iPhone·Rarog', alerts: false, ...owner(DEVICE) });
  }
  expect(h.controller.register(DEVICE, { activityId, updateToken })).not.toBe('unknown-device');
  await h.clock.advance(0);
}

export const aps = (s: Sent): Record<string, unknown> =>
  (JSON.parse(s.request.body) as { aps: Record<string, unknown> }).aps;
export const stateOf = (s: Sent): LiveActivityContentState => aps(s)['content-state'] as LiveActivityContentState;
