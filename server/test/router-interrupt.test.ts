/**
 * `POST /api/sessions/:id/interrupt` and the prompt Claude Code handed back to its field: the route asks the manager
 * for it only after a delivered `escape`, and the answer carries it only when the manager has one. A real `node:http`
 * router on an ephemeral port over the manager fake.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PROTOCOL_VERSION, interruptResponseSchema } from '@rarog/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { type Logger, createRouter } from '../src/router.ts';
import { SseHub } from '../src/sse.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';
import { createTestDevice } from './helpers/urzadzenie.ts';

const ORIGIN = 'http://localhost:8930';
const silentLogger: Logger = { info: () => {}, error: () => {} };

/** The manager fake whose delivery the test sets: `null` never settles (the route answers `pending`). */
class DeliveryManager extends FakeManager {
  deliver: boolean | null = true;

  override interrupt(id: string): Promise<boolean> {
    void super.interrupt(id);
    return this.deliver === null ? new Promise<boolean>(() => {}) : Promise.resolve(this.deliver);
  }
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

async function interrupt(manager: DeliveryManager): Promise<Record<string, unknown>> {
  const config = loadConfig({ RAROG_DEMO: '1' });
  const device = createTestDevice(config.dataDir, { epoch: config.epoch });
  const hub = new SseHub({ manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 'start-1', startedAtMs: Date.now(), logger: silentLogger,
    devices: device.identity, interruptWaitMs: 40,
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { resolve(); });
  });
  closers.push(() => new Promise<void>((resolve) => { hub.closeAll(); server.close(() => { resolve(); }); }));
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${String(port)}/api/sessions/s1/interrupt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: device.authorization, Origin: ORIGIN },
    body: '{}',
  });
  expect(res.status).toBe(202);
  const body = await res.json() as Record<string, unknown>;
  expect(interruptResponseSchema.safeParse(body).success).toBe(true);
  return body;
}

const asked = (manager: FakeManager): number => manager.calls.filter((c) => c.method === 'returnedPrompt').length;

describe('interrupt answer: the prompt handed back to the field', () => {
  it('a delivered escape and a prompt in the field: the answer carries `returnedPrompt`', async () => {
    const manager = new DeliveryManager([makeSummary({ id: 's1' })]);
    manager.returnedPromptResult = 'Refactor the parser';
    const body = await interrupt(manager);
    expect(body['delivered']).toBe('yes');
    expect(body['returnedPrompt']).toBe('Refactor the parser');
    expect(asked(manager)).toBe(1);
  });

  it('a delivered escape without a prompt in the field: no `returnedPrompt` key', async () => {
    const manager = new DeliveryManager([makeSummary({ id: 's1' })]);
    const body = await interrupt(manager);
    expect(body['delivered']).toBe('yes');
    expect('returnedPrompt' in body).toBe(false);
  });

  it('an escape that did not go: the manager is not asked and the answer has no prompt', async () => {
    const manager = new DeliveryManager([makeSummary({ id: 's1' })]);
    manager.deliver = false;
    manager.returnedPromptResult = 'Refactor the parser';
    const body = await interrupt(manager);
    expect(body['delivered']).toBe('no');
    expect('returnedPrompt' in body).toBe(false);
    expect(asked(manager)).toBe(0);
  });

  it('an escape still in the queue at the deadline: the manager is not asked', async () => {
    const manager = new DeliveryManager([makeSummary({ id: 's1' })]);
    manager.deliver = null;
    manager.returnedPromptResult = 'Refactor the parser';
    const body = await interrupt(manager);
    expect(body['delivered']).toBe('pending');
    expect('returnedPrompt' in body).toBe(false);
    expect(asked(manager)).toBe(0);
  });
});
