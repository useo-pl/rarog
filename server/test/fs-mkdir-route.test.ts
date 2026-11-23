/**
 * `POST /api/fs/mkdir` through the real router (`server/src/routes/projects.ts`): the route hands `makeDirectory` a
 * device recheck that asks the device store, right before the child starts. The router runs without the demo, with
 * a real paired device key, over a project in a temporary root, and with the real child process of `fs-mkdir.ts`.
 * The test wraps `resolveListedDir` of `fs-browse.ts` to unpair the device once the parent is resolved: after the
 * body and its device check, at the last `await` before the child.
 */
import { existsSync, lstatSync } from 'node:fs';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Runs once, when the parent of the request is resolved and before `makeDirectory` goes on. */
const afterResolve = vi.hoisted(() => ({ run: null as (() => void) | null }));
vi.mock('../src/fs-browse.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/fs-browse.ts')>();
  return {
    ...real,
    resolveListedDir: async (...args: Parameters<typeof real.resolveListedDir>) => {
      const result = await real.resolveListedDir(...args);
      const run = afterResolve.run;
      afterResolve.run = null;
      run?.();
      return result;
    },
  };
});

import { PROTOCOL_VERSION } from '@rarog/shared';
import { loadConfig } from '../src/config.ts';
import { type Logger, createRouter } from '../src/router.ts';
import { SseHub } from '../src/sse.ts';
import { FakeManager } from './fake-manager.ts';
import { type TestDevice, createTestDevice } from './helpers/urzadzenie.ts';

const ORIGIN = 'http://localhost:8930';
const silent: Logger = { info: () => {}, error: () => {} };

let project = '';
let device: TestDevice;
let base = '';
let close: () => Promise<void> = () => Promise.resolve();

beforeEach(async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'rarog-mkdir-route-')));
  project = path.join(root, 'rarog');
  await mkdir(project);
  const config = loadConfig({
    RAROG_ORIGINS: ORIGIN, RAROG_PROJECT_ROOTS: root, RAROG_HERDR_LAUNCH: '1', RAROG_HERDR_SEND: '1',
    RAROG_HERDR_BIN: '/usr/bin/true', RAROG_DATA_DIR: path.join(root, '.data'),
  });
  device = createTestDevice(config.dataDir, { epoch: config.epoch });
  const manager = new FakeManager([]);
  const hub = new SseHub({ manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 'start-1', startedAtMs: Date.now(), logger: silent,
    devices: device.identity,
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  close = async () => {
    hub.closeAll();
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  };
});

afterEach(async () => {
  afterResolve.run = null;
  await close();
});

async function makeDir(name: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}/api/fs/mkdir`, {
    method: 'POST',
    headers: { ...device.headers, Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent: project, name }),
  });
  return { status: res.status, body: await res.json() as unknown };
}

const isDir = (file: string): boolean => existsSync(file) && lstatSync(file).isDirectory();

describe('POST /api/fs/mkdir: the device check before the child', () => {
  it('a device unpaired while the parent is resolved gets 401 `device-revoked`, and no directory appears', async () => {
    let revoked = false;
    afterResolve.run = () => {
      device.store.revoke(device.id, 'admin');
      revoked = true;
    };
    const reply = await makeDir('notes');
    expect(revoked, 'the parent of the request was never resolved').toBe(true);
    expect([reply.status, (reply.body as { error?: unknown }).error]).toEqual([401, 'device-revoked']);
    expect(existsSync(path.join(project, 'notes'))).toBe(false);
  });

  it('the same request with the device still paired creates the directory (control)', async () => {
    const reply = await makeDir('notes');
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body).toMatchObject({ name: 'notes', path: path.join(project, 'notes') });
    expect(isDir(path.join(project, 'notes'))).toBe(true);
  });
});
