/**
 * A Claude Code start dialog herdr reads as ready (the external imports dialog, or an unknown one the launcher found)
 * gets no key and no text from the phone: every action of the contract ends in a refusal with a sentence, and the
 * start prompt waits through the dialogs and goes once. Rows of the manager run here on the supervisor and driver
 * fakes; rows of the driver run on the real driver over a fake herdr client in `start-dialog-gate-driver.test.ts`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BadStateError, createManager } from '../src/sessions/manager.ts';
import type { HerdrManagerDeps, Manager } from '../src/sessions/manager.ts';
import {
  FakeSupervisor, PROJECT, flush, makeAgent, makeDeps,
} from './helpers/manager-herdr-atrapy.ts';
import type { FakeHerdrDriver } from './helpers/manager-herdr-atrapy.ts';

const NEW_KEY = 'w0:new1';
const BLOCKED = { status: 'blocked', interactiveReady: false } as const;

describe('manager: actions while a start dialog stands', () => {
  let dataDir: string;
  const managers: Manager[] = [];
  const supervisors: FakeSupervisor[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-start-dialog-'));
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const supervisor of supervisors.splice(0)) supervisor.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function build(supervisor: FakeSupervisor, deps: HerdrManagerDeps): Promise<Manager> {
    const manager = await createManager({
      demo: false, dataDir, projects: [{ path: PROJECT, name: 'atlas' }], projectRoots: [], gitStatus: null,
      maxPanes: 6, herdrSupervisor: supervisor, herdrDeps: deps, herdrRoots: [PROJECT], herdrSend: true,
    });
    managers.push(manager);
    await manager.ready;
    return manager;
  }

  /** A start whose driver reports nothing by itself; `prompt` absent = an empty start. */
  async function start(prompt?: string): Promise<{
    supervisor: FakeSupervisor; manager: Manager; id: string; driver: FakeHerdrDriver;
  }> {
    const supervisor = new FakeSupervisor();
    supervisors.push(supervisor);
    supervisor.autoSettle = false;
    const manager = await build(supervisor, makeDeps());
    const created = await manager.create({ cwd: PROJECT, ...(prompt === undefined ? {} : { prompt }) });
    await flush();
    return { supervisor, manager, id: created.sessionId, driver: supervisor.driver(NEW_KEY) };
  }

  /** The driver's card of the start dialog: herdr `blocked` from the launcher, a screen card without buttons. */
  async function dialogCard(driver: FakeHerdrDriver): Promise<void> {
    driver.queue.push({ type: 'agent-state', state: 'blocked' });
    driver.queue.push({ type: 'screen-dialog' });
    await flush();
  }

  const refusal = async (action: () => Promise<unknown>): Promise<unknown> => Promise.resolve()
    .then(action).then(() => null, (err: unknown) => err);

  describe.each([
    ['the card before the launch result', 'card-first'],
    ['the launch result before the card', 'result-first'],
  ] as const)('empty start, %s', (_name, order) => {
    async function standing(): Promise<Awaited<ReturnType<typeof start>>> {
      const fx = await start();
      if (order === 'card-first') await dialogCard(fx.driver);
      fx.supervisor.settleLaunch(null, BLOCKED);
      await flush();
      if (order === 'result-first') await dialogCard(fx.driver);
      return fx;
    }

    it('the card is not sendable: a message, a slash command and a queued prompt are refused (manager state)',
      async () => {
        const { supervisor, manager, id } = await standing();
        expect(manager.get(id)?.state).toBe('waiting-permission');
        // The app's queue sends a held prompt as a queue-aware message with its own id.
        for (const [text, clientMessageId, opts] of [
          ['hello', undefined, {}], ['/compact', undefined, {}], ['later', 'queued-1', { queueAware: true }],
        ] as const) {
          const err = await refusal(() => manager.sendMessage(id, text, undefined, undefined, clientMessageId, opts));
          expect(err).toBeInstanceOf(BadStateError);
        }
        expect(supervisor.log.of('send')).toEqual([]);
      });

    it('model command, mode change and session restart are refused by the manager, nothing reaches the driver',
      async () => {
        const { manager, id, driver } = await standing();
        const reached: string[] = [];
        Object.assign(driver, {
          sendCommands: (commands: readonly string[]) => { reached.push(...commands); },
          setMode: (target: string) => { reached.push(`mode ${target}`); },
          restartProbe: () => { reached.push('restart probe'); return Promise.reject(new Error('unexpected')); },
          requestExit: () => { reached.push('exit'); return Promise.resolve(false); },
        });
        const codes: string[] = [];
        for (const action of [
          () => manager.setModel(id, { model: 'sonnet' }),
          () => manager.setMode(id, { mode: 'plan' }),
          // Claude Code has no process registry entry before its prompt, so no update is known either.
          () => manager.restart(id),
        ]) {
          const err = await refusal(action);
          expect(err).toBeInstanceOf(BadStateError);
          codes.push((err as BadStateError).sentence.ref?.code ?? '');
        }
        expect(codes).toEqual(['model.busy', 'session.mode-busy', 'restart.no-update']);
        expect(reached).toEqual([]);
      });
  });

  it('start with a prompt: a message is refused by the start reservation (409), the prompt waits', async () => {
    const { supervisor, manager, id, driver } = await start('do X');
    await dialogCard(driver);
    supervisor.settleLaunch(null, BLOCKED);
    await flush();
    const err = await refusal(() => manager.sendMessage(id, 'second'));
    expect(err).toBeInstanceOf(BadStateError);
    expect((err as BadStateError).sentence).toMatchObject({ ref: { code: 'session.not-accepting-messages' } });
    expect(supervisor.log.of('send')).toEqual([]);
  });

  it('trust, then the imports dialog, then the answer in the terminal: the start prompt goes once', async () => {
    const { supervisor, manager, id, driver } = await start('do X');
    driver.queue.push({ type: 'agent-state', state: 'blocked' });
    driver.queue.push({ type: 'screen-dialog', knownDialog: 'trust' });
    await flush();
    supervisor.settleLaunch(null, BLOCKED);
    await flush();
    await expect(manager.resolvePermission(id, id, 'allow', 'iPhone')).resolves.toEqual({ outcome: 'ok' });
    // The driver's sequence after the trust answer: the pane stays `blocked`, the card turns to the imports dialog.
    driver.queue.push({ type: 'permission-cleared', reqId: id, reason: 'another decision' });
    driver.queue.push({ type: 'screen-dialog' });
    await flush();
    expect(supervisor.log.of('send')).toEqual([]);
    expect(manager.get(id)?.state).toBe('waiting-permission');

    // The answer in the terminal: the session id, the supervisor's refresh, `idle`.
    supervisor.live.set(NEW_KEY, makeAgent({
      key: NEW_KEY, paneId: NEW_KEY, status: 'idle', interactiveReady: true, launchedByRarog: true,
    }));
    driver.queue.push({ type: 'agent-state', state: 'idle' });
    await flush();
    expect(supervisor.log.of('send')).toEqual(['do X']);
    expect(manager.get(id)?.state).toBe('running');
  });

  it('an interrupt the driver refuses over the dialog puts the card back on the decision: a message is refused',
    async () => {
      const { supervisor, manager, id, driver } = await start();
      await dialogCard(driver);
      supervisor.settleLaunch(null, BLOCKED);
      await flush();
      driver.interruptSent = false;
      // The driver's refusal clears its card and judges the screen again later; the next card comes after a debounce.
      const delivered = manager.interrupt(id);
      driver.queue.push({ type: 'permission-cleared', reqId: id, reason: 'interrupt: start dialog' });
      expect(await delivered).toBe(false);
      await flush();
      expect(manager.get(id)?.state).toBe('waiting-permission');
      const err = await refusal(() => manager.sendMessage(id, 'hello'));
      expect(err).toBeInstanceOf(BadStateError);
      expect(supervisor.log.of('send')).toEqual([]);
    });

  it('an interrupt not delivered after the dialog was answered at the desk leaves the card in `waiting-input`',
    async () => {
      const { supervisor, manager, id, driver } = await start();
      await dialogCard(driver);
      supervisor.settleLaunch(null, BLOCKED);
      await flush();
      driver.holdInterrupt = true;
      const delivered = manager.interrupt(id);
      const since = manager.get(id)?.stateSince;
      // The dialog is answered at the desk while the Esc waits in the driver's queue: herdr reports `idle`, which on
      // `waiting-input` changes neither the state nor `stateSince`.
      driver.queue.push({ type: 'agent-state', state: 'idle' });
      await flush();
      expect(manager.get(id)).toMatchObject({ state: 'waiting-input', stateSince: since });
      driver.settleInterrupt(false);
      expect(await delivered).toBe(false);
      await flush();
      expect(manager.get(id)?.state).toBe('waiting-input');
    });

  it('an interrupt the driver delivers still lands in `waiting-input`', async () => {
    const { supervisor, manager, id, driver } = await start();
    await dialogCard(driver);
    supervisor.settleLaunch(null, BLOCKED);
    await flush();
    expect(await manager.interrupt(id)).toBe(true);
    await flush();
    expect(manager.get(id)?.state).toBe('waiting-input');
  });
});
