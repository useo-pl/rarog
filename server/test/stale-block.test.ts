/**
 * Holds that outlive a consent dialog (`drivers/herdr/stale-block.ts`): the verdict from fresh
 * reads and the paste queue that stops waiting on the raw herdr `blocked` status or the registry fallback hold alone,
 * with a short retry while they lag. The queue tests drive the facade `drivers/herdr-driver.ts` with the shared fakes
 * from `helpers/herdr-driver-atrapy.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DriverEvent } from '../src/drivers/types.ts';
import type { HerdrDriverDeps } from '../src/drivers/herdr-driver.ts';
import { PROMPT_STALE_RETRY_MS, staleBlockVerdict } from '../src/drivers/herdr/stale-block.ts';
import type { StaleBlockReads } from '../src/drivers/herdr/stale-block.ts';
import {
  DIALOG_PERMISSION, FIXTURES, PANE, composerPane, drivenClock, inTurn, makeDriver, pasteFlow, permissions, states,
  useDriverSandbox, userLine, waitFor,
} from './helpers/herdr-driver-atrapy.ts';
import type { ComposerPane, Fixture } from './helpers/herdr-driver-atrapy.ts';

useDriverSandbox();

type Signal = Awaited<ReturnType<NonNullable<HerdrDriverDeps['consentRegistryRead']>>>;
const BUSY: Signal = { kind: 'active', busy: true };
const IDLE: Signal = { kind: 'active' };
const WAITING: Signal = { kind: 'waiting', dialog: 'permission' };
const UNKNOWN: Signal = { kind: 'unknown' };

describe('staleBlockVerdict: a hold is stale only on a registry without `waiting` and a visible field', () => {
  const reads = (registry: () => Promise<Signal>, field: () => Promise<string | null | undefined>): StaleBlockReads =>
    ({ registry, field });

  it.each([
    ['registry `busy`, empty field', BUSY, '', 'stale'],
    ['registry `idle`, field with text', IDLE, 'tekst', 'stale'],
    ['registry `waiting`, field visible', WAITING, '', 'held'],
    ['registry `unknown`, field visible', UNKNOWN, '', 'held'],
    ['registry `busy`, field covered by a dialog', BUSY, null, 'covered'],
    ['registry `busy`, screen read failed', BUSY, undefined, 'covered'],
  ] as const)('%s → %s', async (_label, signal, field, verdict) => {
    expect(await staleBlockVerdict(reads(() => Promise.resolve(signal), () => Promise.resolve(field)))).toBe(verdict);
  });

  it('a registry read error holds without a screen read; a screen read exception is `covered`', async () => {
    let screenReads = 0;
    const field = (): Promise<string> => { screenReads += 1; return Promise.resolve(''); };
    expect(await staleBlockVerdict(reads(() => Promise.reject(new Error('EIO')), field))).toBe('held');
    expect(await staleBlockVerdict(reads(() => Promise.resolve(WAITING), field))).toBe('held');
    expect(screenReads).toBe(0);
    expect(await staleBlockVerdict(reads(() => Promise.resolve(BUSY), () => Promise.reject(new Error('EIO')))))
      .toBe('covered');
  });
});

describe('kolejka wklejeń przy `blocked` herdr, który przeżył dialog', () => {
  const echoRefused = (fx: Fixture): string[] => fx.events
    .filter((e): e is Extract<DriverEvent, { type: 'echo-refused' }> => e.type === 'echo-refused')
    .map((e) => e.token);

  /** A pane mid-turn whose herdr status still says `blocked` after the dialog closed; the field is on the screen. */
  async function staleBlocked(deps: Partial<HerdrDriverDeps>): Promise<{ fx: Fixture; logs: string[] }> {
    const logs: string[] = [];
    const fx = await makeDriver({ agent: { status: 'working' }, deps: { logger: (line) => logs.push(line), ...deps } });
    composerPane(fx);
    inTurn(fx, 'blocked');
    return { fx, logs };
  }

  it('rejestr bez `waiting` i pole na ekranie: wklejenie i Enter bez czekania na koniec `blocked`', async () => {
    const clock = drivenClock();
    const { fx, logs } = await staleBlocked({
      scheduler: clock.scheduler, consentRegistryRead: () => Promise.resolve(BUSY),
    });
    fx.driver.send('w odstępie między dialogami', undefined, undefined, { echo: 'e1' });
    await clock.advance(0);
    expect(pasteFlow(fx)).toEqual(['paste:w odstępie między dialogami', 'enter']);
    expect(echoRefused(fx)).toEqual([]);
    expect(logs.filter((line) => line.startsWith('send:'))).toEqual([]);
  });

  it('dialog staje na ekranie między wklejeniem a Enterem (rejestr jeszcze bez `waiting`): bez Entera, wiadomość '
    + 'zostaje na początku kolejki, Enter po dialogu bez drugiego wklejenia', async () => {
    const clock = drivenClock();
    const { fx, logs } = await staleBlocked({
      scheduler: clock.scheduler, consentRegistryRead: () => Promise.resolve(BUSY),
    });
    const pane = composerPane(fx);
    const paste = fx.client.pasteText;
    // 1 = the next screen read sees the pasted text; 2 = the read after it finds a dialog over the field.
    let phase = 0;
    fx.client.pasteText = async (paneId, text) => {
      await paste(paneId, text);
      if (pasteFlow(fx).length === 1) phase = 1;
    };
    const read = fx.client.readScreen.bind(fx.client);
    fx.client.readScreen = (...args: Parameters<typeof read>) => {
      if (phase === 1) phase = 2;
      else if (phase === 2) {
        phase = 0;
        pane.dialog = DIALOG_PERMISSION;
        pane.draw();
      }
      return read(...args);
    };
    fx.driver.send('przed dialogiem', undefined, undefined, { echo: 'e1' });
    await clock.advance(0);
    expect(pasteFlow(fx)).toEqual(['paste:przed dialogiem']);
    expect(logs).toContain(`send: herdr after paste in pane ${PANE}, no Enter; message stays at the head of the queue`);

    await clock.advance(1_000);
    expect(pasteFlow(fx)).toEqual(['paste:przed dialogiem']);

    pane.dialog = null;
    pane.draw();
    await clock.advance(300);
    expect(pasteFlow(fx)).toEqual(['paste:przed dialogiem', 'enter']);
    expect(pane.submitted).toEqual(['przed dialogiem']);
    expect(echoRefused(fx)).toEqual([]);
  });

  it('rejestr `waiting` między wklejeniem a Enterem: bez Entera, Enter dopiero po dialogu', async () => {
    const clock = drivenClock();
    let registry: Signal = BUSY;
    const { fx, logs } = await staleBlocked({
      scheduler: clock.scheduler, consentRegistryRead: () => Promise.resolve(registry),
    });
    const pane = composerPane(fx);
    const paste = fx.client.pasteText;
    fx.client.pasteText = async (paneId, text) => {
      await paste(paneId, text);
      registry = WAITING;
    };
    fx.driver.send('tuż przed żądaniem', undefined, undefined, { echo: 'e1' });
    await clock.advance(0);
    expect(pasteFlow(fx)).toEqual(['paste:tuż przed żądaniem']);
    expect(logs).toContain(`send: herdr after paste in pane ${PANE}, no Enter; message stays at the head of the queue`);
    await clock.advance(1_000);
    expect(pasteFlow(fx)).toEqual(['paste:tuż przed żądaniem']);

    registry = BUSY;
    await clock.advance(300);
    expect(pasteFlow(fx)).toEqual(['paste:tuż przed żądaniem', 'enter']);
    expect(pane.submitted).toEqual(['tuż przed żądaniem']);
  });

  it.each([
    ['rejestr `waiting`', WAITING],
    ['rejestr `unknown`', UNKNOWN],
  ] as const)('%s przy polu na ekranie: zero wklejenia, wiadomość czeka na koniec `blocked`', async (_label, signal) => {
    const clock = drivenClock();
    let registry: Signal = signal;
    const { fx, logs } = await staleBlocked({
      scheduler: clock.scheduler, consentRegistryRead: () => Promise.resolve(registry),
    });
    fx.driver.send('czeka', undefined, undefined, { echo: 'e1' });
    await clock.advance(1_000);
    expect(pasteFlow(fx)).toEqual([]);
    expect(logs).toEqual([`send: message for pane ${PANE} waits (herdr)`]);

    registry = BUSY;
    inTurn(fx, 'working');
    await clock.advance(300);
    expect(pasteFlow(fx)).toEqual(['paste:czeka', 'enter']);
  });

  it('pole zakryte dialogiem przy rejestrze bez `waiting`: zero wklejenia', async () => {
    const clock = drivenClock();
    const { fx } = await staleBlocked({
      scheduler: clock.scheduler, consentRegistryRead: () => Promise.resolve(BUSY),
    });
    const pane = composerPane(fx);
    pane.dialog = DIALOG_PERMISSION;
    pane.draw();
    fx.driver.send('pod dialogiem', undefined, undefined, { echo: 'e1' });
    await clock.advance(1_000);
    expect(pasteFlow(fx)).toEqual([]);
  });

  it('prośba hooka zgody tej sesji czeka: `blocked` nie schodzi, zero wklejenia', async () => {
    const clock = drivenClock();
    const { fx, logs } = await staleBlocked({
      scheduler: clock.scheduler, consentRegistryRead: () => Promise.resolve(BUSY),
      // The registration was accepted at the driver's clock `now`, so it is within the card wait.
      consentCardAwaited: () => Date.UTC(2026, 7, 22, 12, 0, 0),
    });
    fx.driver.send('za prośbą hooka', undefined, undefined, { echo: 'e1' });
    await clock.advance(1_000);
    expect(pasteFlow(fx)).toEqual([]);
    expect(logs).toEqual([`send: message for pane ${PANE} waits (hook)`]);
  });

  it('pole zakryte przy rejestrze bez `waiting`: następna próba po krótkim odstępie, nie po 300 ms', async () => {
    const clock = drivenClock();
    const { fx } = await staleBlocked({
      scheduler: clock.scheduler, consentRegistryRead: () => Promise.resolve(BUSY),
    });
    const pane = composerPane(fx);
    pane.dialog = DIALOG_PERMISSION;
    pane.draw();
    fx.driver.send('krótki odstęp', undefined, undefined, { echo: 'e1' });
    await clock.advance(0);
    expect(pasteFlow(fx)).toEqual([]);
    // The dialog closed; herdr still says `blocked`.
    pane.dialog = null;
    pane.draw();
    await clock.advance(PROMPT_STALE_RETRY_MS);
    expect(pasteFlow(fx)).toEqual(['paste:krótki odstęp', 'enter']);
  });

  it('rejestr `waiting`: ponowienie zostaje co 300 ms', async () => {
    const clock = drivenClock();
    let registry: Signal = WAITING;
    const { fx } = await staleBlocked({
      scheduler: clock.scheduler, consentRegistryRead: () => Promise.resolve(registry),
    });
    fx.driver.send('zwykły odstęp', undefined, undefined, { echo: 'e1' });
    await clock.advance(0);
    registry = BUSY;
    await clock.advance(PROMPT_STALE_RETRY_MS);
    expect(pasteFlow(fx)).toEqual([]);
    await clock.advance(300 - PROMPT_STALE_RETRY_MS);
    expect(pasteFlow(fx)).toEqual(['paste:zwykły odstęp', 'enter']);
  });

  it('rezerwa z rejestru trzyma panel po ostatnim sygnale managera, a świeży odczyt rejestru i pole mówią, że '
    + 'dialogu nie ma: wklejenie i Enter bez czekania na następny tik', async () => {
    let registry: Signal = WAITING;
    const fx = await makeDriver({
      transcript: userLine('wyjdź z planu'), agent: { status: 'working' },
      // A long poll: the hold is not re-evaluated, as between two registry ticks of the manager.
      deps: { blockedPollMs: 60_000, screenCacheMs: 0, consentRegistryRead: () => Promise.resolve(registry) },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    const pane = composerPane(fx);
    pane.dialog = readFileSync(join(FIXTURES, 'measured', 'exitplanmode-bez-planu-2.1.293.txt'), 'utf8');
    pane.draw();
    // herdr says `working`, the manager's registry signal says `waiting`: the registry fallback holds.
    fx.driver.noteCliWaiting?.(WAITING);
    await waitFor(() => permissions(fx.events).length > 0, 'karta z rezerwy rejestru');
    expect(states(fx.events).at(-1)?.state).toBe('blocked');

    pane.dialog = null;
    pane.draw();
    registry = BUSY;
    fx.driver.send('po rezerwie', undefined, undefined, { echo: 'e1' });
    await waitFor(() => pasteFlow(fx).includes('enter'), 'enter po świeżym odczycie');
    expect(pasteFlow(fx)).toEqual(['paste:po rezerwie', 'enter']);
    expect(pane.submitted).toEqual(['po rezerwie']);
  });
});

describe('a hold that begins during the reads of a lift is never lifted by them', () => {
  interface Raced {
    readonly fx: Fixture;
    readonly pane: ComposerPane;
    readonly logs: string[];
    readonly clock: ReturnType<typeof drivenClock>;
    /** The signal of every fresh registry read and a hook that runs inside the read, before it returns. */
    readonly registry: { signal: Signal; onRead: () => void };
  }

  /**
   * A pane mid-turn whose herdr status still says `blocked` after the dialog closed, with the field on the screen. The
   * registry reader keeps returning `active`, as one that serves an earlier snapshot.
   */
  async function racedQueue(): Promise<Raced> {
    const clock = drivenClock();
    const logs: string[] = [];
    const registry: Raced['registry'] = { signal: BUSY, onRead: () => {} };
    const fx = await makeDriver({
      agent: { status: 'working' },
      deps: {
        scheduler: clock.scheduler, logger: (line) => logs.push(line),
        consentRegistryRead: () => {
          registry.onRead();
          return Promise.resolve(registry.signal);
        },
      },
    });
    const pane = composerPane(fx);
    inTurn(fx, 'blocked');
    return { fx, pane, logs, clock, registry };
  }

  /** The next dialog of the same turn in the fakes: status `working`, a permission dialog over the field, `blocked`. */
  const nextDialog = ({ fx, pane }: Raced): void => {
    inTurn(fx, 'working');
    pane.dialog = DIALOG_PERMISSION;
    pane.draw();
    inTurn(fx, 'blocked');
  };

  /** Registry reads after the paste: `at` runs inside the read with that number (1 = the first after the paste). */
  const afterPaste = (raced: Raced, at: number, run: () => void): void => {
    let reads = 0;
    raced.registry.onRead = () => {
      if (pasteFlow(raced.fx).length === 0) return;
      reads += 1;
      if (reads === at) run();
    };
  };

  const heldAfterPaste = `send: herdr after paste in pane ${PANE}, no Enter; message stays at the head of the queue`;

  it('herdr goes working → blocked during the fresh registry read after the lift, which still says `active`: no Enter, '
    + 'the message stays at the head of the queue and goes after the dialog without a second paste', async () => {
    const raced = await racedQueue();
    const { fx, pane, logs, clock } = raced;
    // Step 4: read 1 is the lift's (the field with the pasted text is visible), read 2 the fresh read after it.
    afterPaste(raced, 2, () => { nextDialog(raced); });
    fx.driver.send('between two dialogs', undefined, undefined, { echo: 'e1' });
    await clock.advance(0);
    expect(pasteFlow(fx)).toEqual(['paste:between two dialogs']);
    expect(logs).toContain(heldAfterPaste);
    await clock.advance(1_000);
    expect(pasteFlow(fx)).toEqual(['paste:between two dialogs']);

    // The dialog closes; herdr still says `blocked`.
    pane.dialog = null;
    pane.draw();
    await clock.advance(300);
    expect(pasteFlow(fx)).toEqual(['paste:between two dialogs', 'enter']);
    expect(pane.submitted).toEqual(['between two dialogs']);
  });

  it('the same during the check before a late Enter: no Enter, the late check says `herdr`', async () => {
    const raced = await racedQueue();
    const { fx, logs, clock, registry } = raced;
    const paste = fx.client.pasteText;
    fx.client.pasteText = async (paneId, text) => {
      await paste(paneId, text);
      registry.signal = WAITING;
    };
    fx.driver.send('late Enter', undefined, undefined, { echo: 'e1' });
    await clock.advance(1_000);
    expect(pasteFlow(fx)).toEqual(['paste:late Enter']);

    // The request closed; herdr still says `blocked`. The next attempt checks steps 1 and 4 (a lift and a fresh read
    // each), then the late check: read 5 is its lift, read 6 the fresh read after it.
    registry.signal = BUSY;
    let reads = 0;
    registry.onRead = () => {
      reads += 1;
      if (reads === 6) nextDialog(raced);
    };
    await clock.advance(300);
    expect(pasteFlow(fx)).toEqual(['paste:late Enter']);
    expect(logs.filter((line) => line.startsWith('send: Enter ')).at(-1)).toMatch(/, checked again: herdr$/);
  });

  it('herdr goes working → blocked while the lift reads the screen, which still shows the field: no Enter',
    async () => {
      const raced = await racedQueue();
      const { fx, logs, clock } = raced;
      const read = fx.client.readScreen.bind(fx.client);
      let fieldReads = 0;
      fx.client.readScreen = async (...args: Parameters<typeof read>) => {
        // The screen as it was when the read began; the next dialog comes before the read returns.
        const screen = await read(...args);
        if (pasteFlow(fx).length > 0 && args[1] === 'visible') {
          fieldReads += 1;
          // Read 1 waits for the pasted text; read 2 is the lift's in step 4.
          if (fieldReads === 2) nextDialog(raced);
        }
        return screen;
      };
      fx.driver.send('under the screen read', undefined, undefined, { echo: 'e1' });
      await clock.advance(0);
      expect(pasteFlow(fx)).toEqual(['paste:under the screen read']);
      expect(logs).toContain(heldAfterPaste);
      await clock.advance(1_000);
      expect(pasteFlow(fx)).toEqual(['paste:under the screen read']);
    });

  it('a registry fallback hold that begins during the fresh registry read after the lift: no Enter', async () => {
    const raced = await racedQueue();
    const { fx, pane, logs, clock } = raced;
    afterPaste(raced, 2, () => {
      // The manager's registry tick saw the next dialog, then herdr's late `working` moves the block to the fallback.
      pane.dialog = DIALOG_PERMISSION;
      pane.draw();
      fx.driver.noteCliWaiting?.(WAITING);
      inTurn(fx, 'working');
    });
    fx.driver.send('into the fallback', undefined, undefined, { echo: 'e1' });
    await clock.advance(0);
    expect(pasteFlow(fx)).toEqual(['paste:into the fallback']);
    expect(logs).toContain(heldAfterPaste);
    await clock.advance(1_000);
    expect(pasteFlow(fx)).toEqual(['paste:into the fallback']);
  });
});
