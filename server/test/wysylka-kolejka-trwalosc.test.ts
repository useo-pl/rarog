/**
 * The paste queue survives a server restart (`drivers/herdr/prompt-queue-store.ts`): a
 * message accepted while a turn runs and not pasted yet goes out after the restart; a message whose paste or Enter
 * has no known outcome comes back only as a note. A restart here is: the store closes (shutdown), the driver goes,
 * a new store reads the same data directory and a new driver attaches to the same pane key.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HerdrDriverDeps } from '../src/drivers/herdr-driver.ts';
import {
  PROMPT_QUEUE_FILENAME, PROMPT_QUEUE_MAX_AGE_MS, createPromptQueueStore,
} from '../src/drivers/herdr/prompt-queue-store.ts';
import type { PromptQueueStore } from '../src/drivers/herdr/prompt-queue-store.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type { HerdrAgent, HerdrAgentInfo } from '../src/herdr/types.ts';
import { MAX_TRANSCRIPT_MESSAGES } from '@rarog/shared';
import { createSendRegistry } from '../src/sessions/send-registry.ts';
import {
  DIALOG_PERMISSION, PANE, SESSION, TIMING, base, composerPane, inTurn, makeDriver, pasteFlow, quiet, root,
  systemCodes, useDriverSandbox, userLine, waitFor,
} from './helpers/herdr-driver-atrapy.ts';
import type { ComposerPane, Fixture } from './helpers/herdr-driver-atrapy.ts';

useDriverSandbox();

/*
 * Stores of the test close and finish their writes before the drivers go and the temporary directory is removed
 * (this hook runs before the sandbox's own): a write still in flight would race the `rm`.
 */
const stores: PromptQueueStore[] = [];
const newStore = (opts: Parameters<typeof createPromptQueueStore>[0]): PromptQueueStore => {
  const store = createPromptQueueStore(opts);
  stores.push(store);
  return store;
};
afterEach(async () => {
  const open = stores.splice(0);
  await Promise.all(open.map((store) => store.close()));
});

type Signal = Awaited<ReturnType<NonNullable<HerdrDriverDeps['consentRegistryRead']>>>;
const WAITING: Signal = { kind: 'waiting', dialog: 'permission' };
const ACTIVE: Signal = { kind: 'active' };

const dataDir = (): string => join(base, 'data');
const queueFile = (): string => join(dataDir(), PROMPT_QUEUE_FILENAME);
const fileEntries = (): { id: string; session: string; state: string; text?: string }[] =>
  (JSON.parse(readFileSync(queueFile(), 'utf8')) as { entries: { id: string; session: string; state: string }[] }).entries;

/** A Claude pane mid-turn with the store and a registry signal the test flips. */
async function paneWithStore(
  store: PromptQueueStore, registry: { now: Signal }, logs: string[] = [],
  more: { agent?: Partial<HerdrAgent>; deps?: Partial<HerdrDriverDeps>; transcript?: string } = {},
): Promise<Fixture> {
  return makeDriver({
    agent: { status: 'working', ...more.agent },
    deps: {
      promptStore: store, promptRetryMs: 5, promptSubmitSettleMs: 20, logger: (line) => logs.push(line),
      consentRegistryRead: () => Promise.resolve(registry.now),
      ...more.deps,
    },
    ...(more.transcript !== undefined ? { transcript: more.transcript } : {}),
  });
}

/** Another Claude conversation (engine session id) than {@link SESSION}. */
const OTHER = '0b6c1f5e-4d1a-4c55-9a3e-2f1e9d7c8b6a';

const fileTexts = (): (string | undefined)[] => (existsSync(queueFile()) ? fileEntries().map((entry) => entry.text) : []);

/** One message waits for a dialog on disk, then the server restarts (the store closes, the driver goes). */
async function queuedThenRestart(text: string): Promise<void> {
  const registry: { now: Signal } = { now: WAITING };
  const store = newStore({ dataDir: dataDir() });
  const fx = await paneWithStore(store, registry);
  composerPane(fx);
  fx.driver.send(text, undefined, undefined, { echo: 'e1' });
  await waitFor(() => fileTexts().length === 1, 'wpis na dysku');
  shutdown(store, fx);
}

/** One message pasted without an Enter (a dialog right after the paste), then the server restarts. */
async function pastedThenRestart(): Promise<string> {
  const registry: { now: Signal } = { now: ACTIVE };
  const store = newStore({ dataDir: dataDir() });
  const fx = await paneWithStore(store, registry);
  composerPane(fx);
  const paste = fx.client.pasteText;
  fx.client.pasteText = async (paneId, text) => {
    await paste(paneId, text);
    registry.now = WAITING;
  };
  fx.driver.send('wklejona przed restartem', undefined, undefined, { echo: 'e1' });
  await waitFor(() => pasteFlow(fx).length === 1, 'wklejenie');
  await quiet();
  // The paste goes only after the write without the text: the file says `pasted` already.
  expect(fileEntries().map((entry) => entry.state)).toEqual(['pasted']);
  shutdown(store, fx);
  return fx.transcript;
}

/** Shutdown: the store closes first (as in `index.ts`), then the driver goes. */
function shutdown(store: PromptQueueStore, fx: Fixture): void {
  void store.close();
  fx.driver.dispose();
}

describe('kolejka wklejeń przeżywa restart serwera', () => {
  it('dwie wiadomości czekają na dialog, restart: po starcie obie w kolejce w tej samej kolejności, idą po dialogu',
    async () => {
      const registry: { now: Signal } = { now: WAITING };
      const store = newStore({ dataDir: dataDir() });
      const fx = await paneWithStore(store, registry);
      composerPane(fx);
      fx.driver.send('pierwsza', undefined, undefined, { echo: 'e1' });
      fx.driver.send('druga', undefined, undefined, { echo: 'e2' });
      // The manager's 202 waits for this: both messages are on disk before the response.
      await fx.driver.queueSaved?.();
      expect(fileEntries().map((entry) => [entry.state, entry.text])).toEqual([
        ['queued', 'pierwsza'], ['queued', 'druga'],
      ]);
      await quiet();
      expect(pasteFlow(fx)).toEqual([]);
      shutdown(store, fx);
      expect(fileEntries()).toHaveLength(2);

      const store2 = newStore({ dataDir: dataDir() });
      const logs: string[] = [];
      const fx2 = await paneWithStore(store2, registry, logs);
      composerPane(fx2);
      await quiet();
      expect(pasteFlow(fx2)).toEqual([]);
      expect(logs).toContain(`send: restored 2 queued and 0 pasted message(s) for pane ${PANE}`);

      registry.now = ACTIVE;
      await waitFor(() => pasteFlow(fx2).length === 4, 'obie po dialogu');
      expect(pasteFlow(fx2)).toEqual(['paste:pierwsza', 'enter', 'paste:druga', 'enter']);
      expect(systemCodes(fx2.events)).toEqual([]);
      await waitFor(() => fileEntries().length === 0, 'plik pusty po rozstrzygnięciu Enterów');
    });

  it('restart po zapisie, gdy 202 zginęło, i ponowienie z tym samym identyfikatorem: jedna wiadomość', async () => {
    const registry: { now: Signal } = { now: WAITING };
    const key = { clientMessageId: 'c-1', sessionId: 's-1', digest: 'a'.repeat(64) };
    const store = newStore({ dataDir: dataDir() });
    const sends = createSendRegistry({ dataDir: dataDir() });
    const fx = await paneWithStore(store, registry);
    composerPane(fx);
    // The manager's order: the driver takes the message, the queue file is written, then the registry entry.
    await sends.run(key, async () => {
      fx.driver.send('raz', undefined, undefined, { echo: 'e1' });
      await fx.driver.queueSaved?.();
    });
    // The 202 got lost on the way; the server restarts.
    shutdown(store, fx);

    const store2 = newStore({ dataDir: dataDir() });
    const sends2 = createSendRegistry({ dataDir: dataDir() });
    const fx2 = await paneWithStore(store2, registry);
    composerPane(fx2);
    let again = 0;
    const outcome = await sends2.run(key, () => {
      again += 1;
      fx2.driver.send('raz', undefined, undefined, { echo: 'e2' });
      return Promise.resolve();
    });
    expect(outcome.replayed).toBe(true);
    expect(again).toBe(0);
    registry.now = ACTIVE;
    await waitFor(() => pasteFlow(fx2).length === 2, 'wiadomość z kolejki');
    await quiet();
    expect(pasteFlow(fx2)).toEqual(['paste:raz', 'enter']);
  });

  it('wiadomość wklejona: jej treści nie ma w pliku, plik ma 0600; restart bez Entera: bez wklejenia, notka',
    async () => {
      const registry: { now: Signal } = { now: ACTIVE };
      const store = newStore({ dataDir: dataDir() });
      const fx = await paneWithStore(store, registry);
      composerPane(fx);
      const paste = fx.client.pasteText;
      fx.client.pasteText = async (paneId, text) => {
        await paste(paneId, text);
        // A dialog request right after the paste: no Enter, the text stays in the field.
        registry.now = WAITING;
      };
      fx.driver.send('tajny tekst wiadomości', undefined, undefined, { echo: 'e1' });
      await waitFor(() => pasteFlow(fx).length === 1, 'wklejenie');
      await quiet();
      expect(pasteFlow(fx)).toEqual(['paste:tajny tekst wiadomości']);
      const raw = readFileSync(queueFile(), 'utf8');
      expect(raw).not.toContain('tajny');
      expect(fileEntries().map((entry) => entry.state)).toEqual(['pasted']);
      expect(statSync(queueFile()).mode & 0o777).toBe(0o600);
      shutdown(store, fx);

      const store2 = newStore({ dataDir: dataDir() });
      registry.now = ACTIVE;
      const fx2 = await paneWithStore(store2, registry);
      composerPane(fx2);
      await waitFor(() => systemCodes(fx2.events).length > 0, 'notka');
      await quiet();
      expect(systemCodes(fx2.events)).toEqual(['session.prompt-unseen']);
      expect(pasteFlow(fx2)).toEqual([]);
      await waitFor(() => fileEntries().length === 0, 'znacznik zszedł z pliku');
    });

  it('Enter bez rozstrzygnięcia: znacznik bez treści zostaje do sufitu, potem znika z pliku', async () => {
    const registry: { now: Signal } = { now: ACTIVE };
    const store = newStore({ dataDir: dataDir() });
    const fx = await paneWithStore(store, registry);
    composerPane(fx);
    fx.driver.send('po Enterze', undefined, undefined, { echo: 'e1' });
    await waitFor(() => pasteFlow(fx).length === 2, 'wklejenie i Enter');
    expect(fileEntries().map((entry) => [entry.state, entry.text])).toEqual([['pasted', undefined]]);
    await waitFor(() => fileEntries().length === 0, 'sufit rozstrzygnięcia Entera');
  });

  it('żaden panel nie prowadzi już tej sesji po restarcie: wpis usunięty z linią logu „not sent”, bez wklejenia', async () => {
    const store = newStore({ dataDir: dataDir() });
    await store.add(OTHER, 'do panelu, którego już nie ma').written;
    await store.close();

    const logs: string[] = [];
    const store2 = newStore({ dataDir: dataDir(), logger: (line) => logs.push(line) });
    let ready = (): void => {};
    store2.expireUnclaimedAfter(new Promise<void>((resolve) => { ready = resolve; }), 5);
    await quiet();
    expect(fileEntries()).toHaveLength(1);
    ready();
    await waitFor(() => logs.length > 0, 'wygaśnięcie po resyncu');
    expect(logs).toEqual([`prompt-queue: 1 message(s) for session ${OTHER} not sent: no pane runs it after the restart`]);
    expect(logs.join('\n')).not.toContain('już nie ma');
    await waitFor(() => fileEntries().length === 0, 'wpis zszedł z pliku');
    expect(store2.restore(OTHER)).toEqual({ queued: [], pasted: [] });
  });

  it.each([
    ['nie JSON', '{"format":1,"entries":['],
    ['nieznany format', JSON.stringify({ format: 2, entries: [{ id: 'x', session: SESSION, state: 'queued', text: 't', at: 1 }] })],
  ])('uszkodzony plik (%s): start bez kolejki i jedna linia logu, bez wyjątku, plik odłożony', async (_name, body) => {
    await mkdir(dataDir(), { recursive: true });
    await writeFile(queueFile(), body);
    const logs: string[] = [];
    const store = newStore({ dataDir: dataDir(), logger: (line) => logs.push(line) });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^prompt-queue: corrupt file or unknown format/);
    expect(store.restore(SESSION)).toEqual({ queued: [], pasted: [] });
    expect(readFileSync(`${queueFile()}.bad`, 'utf8')).toBe(body);
    expect(existsSync(queueFile())).toBe(false);
  });

  it('wysyłka do bezczynnego panelu nie idzie na dysk; zamknięcie panelu w biegu zabiera wpisy z pliku', async () => {
    const registry: { now: Signal } = { now: WAITING };
    const store = newStore({ dataDir: dataDir() });
    const idle = await makeDriver({ deps: { promptStore: store } });
    idle.driver.send('poza turą');
    await idle.driver.queueSaved?.();
    expect(existsSync(queueFile())).toBe(false);
    idle.driver.dispose();

    const fx = await paneWithStore(store, registry);
    composerPane(fx);
    fx.driver.send('czeka na dialog', undefined, undefined, { echo: 'e1' });
    await fx.driver.queueSaved?.();
    expect(fileEntries()).toHaveLength(1);
    // The pane goes while the server runs (store open): the queue in RAM goes, so does the file entry.
    fx.driver.dispose();
    await waitFor(() => fileEntries().length === 0, 'wpis zszedł z pliku');
  });

  it('herdr `idle`, a świeży rejestr `waiting`: wiadomość na dysku przed `202`, jak w trakcie tury', async () => {
    const store = newStore({ dataDir: dataDir() });
    const fx = await paneWithStore(store, { now: WAITING }, [], { agent: { status: 'idle' } });
    composerPane(fx);
    fx.driver.send('tura z biurka', undefined, undefined, { echo: 'e1' });
    await fx.driver.queueSaved?.();
    expect(fileEntries().map((entry) => [entry.state, entry.text])).toEqual([['queued', 'tura z biurka']]);
    expect(pasteFlow(fx)).toEqual([]);
  });

  it('wpis starszy niż sufit przywrócenia nie wraca', async () => {
    let now = 1_000;
    const store = newStore({ dataDir: dataDir(), now: () => now });
    await store.add(SESSION, 'stara').written;
    await store.close();
    now += PROMPT_QUEUE_MAX_AGE_MS;
    const logs: string[] = [];
    const store2 = newStore({ dataDir: dataDir(), now: () => now, logger: (line) => logs.push(line) });
    expect(store2.restore(SESSION)).toEqual({ queued: [], pasted: [] });
    expect(logs).toEqual(['prompt-queue: 1 message(s) older than the restore cap not sent']);
    await waitFor(() => fileEntries().length === 0, 'stary wpis zszedł z pliku');
  });
});

/*
 * Boundaries of the copy on disk: a restored message goes only to the same
 * engine session in scope, every step that lets the message out waits for a successful write without its text, and
 * the Enter ceiling and the restore notes follow facts (the end of the key call, the history import).
 */
describe('kolejka wklejeń na dysku: tożsamość, zapis przed krokiem, zegary po faktach', () => {
  it('agent przeniesiony do innego panelu, stary adres zajął drugi agent: wiadomość idzie tylko za sesją silnika',
    async () => {
      await queuedThenRestart('dla agenta A');
      const registry: { now: Signal } = { now: ACTIVE };
      const store = newStore({ dataDir: dataDir() });
      const logs: string[] = [];
      // After the restart agent B holds the old pane address and pane key; agent A sits in another pane.
      const other = await paneWithStore(store, registry, logs, { agent: { agentSessionId: OTHER } });
      composerPane(other);
      other.client.getAgent = (): Promise<HerdrAgentInfo> => Promise.resolve({
        paneId: PANE, agentSessionId: OTHER, engine: 'claude', status: 'working',
      } as HerdrAgentInfo);
      await quiet();
      expect(pasteFlow(other)).toEqual([]);
      const moved = await paneWithStore(store, registry, logs, { agent: { key: 'w9:p73', paneId: 'w9:p73' } });
      composerPane(moved);
      await waitFor(() => pasteFlow(moved).length === 2, 'wiadomość u agenta A');
      expect(pasteFlow(moved)).toEqual(['paste:dla agenta A', 'enter']);
      expect(pasteFlow(other)).toEqual([]);
    });

  it('panel poza zasięgiem po zmianie konfiguracji: wpis usunięty z linią „not sent”, bez odczytu i ruchu w panelu',
    async () => {
      await queuedThenRestart('do panelu poza zasięgiem');
      const store = newStore({ dataDir: dataDir() });
      const logs: string[] = [];
      const out = await paneWithStore(store, { now: ACTIVE }, logs, { agent: { inScope: false } });
      composerPane(out);
      await quiet();
      expect(out.client.calls.filter((call) => call.method === 'read')).toEqual([]);
      expect(out.client.mutations).toBe(0);
      expect(logs).toContain(`send: 1 restored message(s) for pane ${PANE} not sent: out of scope`);
      await waitFor(() => fileEntries().length === 0, 'wpis zszedł z pliku');
    });

  it('nieudany zapis „pasted” przy pliku z „queued”: bez wklejenia, wiadomość czeka; po udanym zapisie idzie',
    async () => {
      const registry: { now: Signal } = { now: WAITING };
      const logs: string[] = [];
      const store = newStore({ dataDir: dataDir(), logger: (line) => logs.push(line) });
      const fx = await paneWithStore(store, registry);
      composerPane(fx);
      fx.driver.send('po awarii dysku', undefined, undefined, { echo: 'e1' });
      await waitFor(() => fileTexts().length === 1, 'wpis na dysku');
      await chmod(dataDir(), 0o500);
      try {
        registry.now = ACTIVE;
        await waitFor(() => logs.some((line) => line.startsWith('prompt-queue: write failed')), 'nieudany zapis');
        await quiet();
        expect(pasteFlow(fx)).toEqual([]);
        expect(fileEntries().map((entry) => [entry.state, entry.text])).toEqual([['queued', 'po awarii dysku']]);
      } finally {
        await chmod(dataDir(), 0o700);
      }
      await waitFor(() => pasteFlow(fx).length === 2, 'wklejenie po udanym zapisie');
      expect(pasteFlow(fx)).toEqual(['paste:po awarii dysku', 'enter']);
    });

  it('tura skończyła się przed zadaniem drivera, wiadomość idzie przez agent.prompt: jej treści nie ma wtedy w pliku',
    async () => {
      const store = newStore({ dataDir: dataDir() });
      // A slow removal write: a restart before it lands must not find the message's text.
      const slow: PromptQueueStore = { ...store, settle: (id) => { setTimeout(() => { store.settle(id); }, 60); } };
      const fx = await paneWithStore(slow, { now: ACTIVE });
      composerPane(fx);
      const seen: Promise<(string | undefined)[]>[] = [];
      const prompt = fx.client.prompt.bind(fx.client);
      fx.client.prompt = (paneId, text, wait) => {
        seen.push(new Promise((resolve) => { setTimeout(() => { resolve(fileTexts()); }, 20); }));
        return prompt(paneId, text, wait);
      };
      fx.driver.send('tura już się skończyła', undefined, undefined, { echo: 'e1' });
      fx.emit({ type: 'status', status: 'idle', stateChangeSeq: 8, title: 'refaktor' });
      await waitFor(() => seen.length === 1, 'agent.prompt');
      expect(pasteFlow(fx)).toEqual(['prompt:tura już się skończyła']);
      expect(await seen[0]).toEqual([]);
    });

  it('panel wszedł w turę, zanim zadanie drivera wybrało drogę: odpowiedź 202 czeka na zapis tej wiadomości',
    async () => {
      const store = newStore({ dataDir: dataDir() });
      const fx = await paneWithStore(store, { now: WAITING }, [], { agent: { status: 'idle' } });
      composerPane(fx);
      fx.driver.send('tura ruszyła w międzyczasie', undefined, undefined, { echo: 'e1' });
      inTurn(fx);
      // The manager's order: `send()`, then the 202 waits for this.
      await fx.driver.queueSaved?.();
      expect(fileTexts()).toEqual(['tura ruszyła w międzyczasie']);
    });

  it('Enter dłuższy niż sufit rozstrzygnięcia: znacznik zostaje przez całe wywołanie, sufit liczy się od jego końca',
    async () => {
      const store = newStore({ dataDir: dataDir() });
      const fx = await paneWithStore(store, { now: ACTIVE }, [], { deps: { promptSubmitSettleMs: 40 } });
      composerPane(fx);
      const submit = fx.client.sendPromptSubmit;
      const during: string[][] = [];
      fx.client.sendPromptSubmit = async (paneId) => {
        await new Promise((resolve) => { setTimeout(resolve, 100); });
        during.push(fileEntries().map((entry) => entry.state));
        await submit(paneId);
      };
      fx.driver.send('wolny Enter', undefined, undefined, { echo: 'e1' });
      await waitFor(() => pasteFlow(fx).length === 2, 'Enter');
      expect(during).toEqual([['pasted']]);
      expect(fileEntries().map((entry) => entry.state)).toEqual(['pasted']);
      await waitFor(() => fileEntries().length === 0, 'sufit od końca wywołania');
    });

  it.each([
    ['dialog w rejestrze CLI', (registry: { now: Signal }): void => { registry.now = WAITING; }],
    ['dialog na ekranie', (_registry: { now: Signal }, pane: ComposerPane): void => {
      pane.dialog = DIALOG_PERMISSION;
      pane.draw();
    }],
  ])('%s w czasie zapisu „pasted”: bez wklejenia', async (_name, change) => {
    const registry: { now: Signal } = { now: ACTIVE };
    const store = newStore({ dataDir: dataDir() });
    let pane: ComposerPane | null = null;
    let hit = false;
    const watched: PromptQueueStore = {
      ...store,
      pasted: (id) => {
        if (!hit && pane !== null) {
          hit = true;
          change(registry, pane);
        }
        return store.pasted(id);
      },
    };
    const fx = await paneWithStore(watched, registry);
    pane = composerPane(fx);
    fx.driver.send('w czasie zapisu', undefined, undefined, { echo: 'e1' });
    await waitFor(() => hit, 'zapis „pasted”');
    await quiet();
    expect(pasteFlow(fx)).toEqual([]);
  });

  it('pole zmienione w czasie zapisu „pasted”: wklejenie dopiero po świeżym odczycie pola', async () => {
    const store = newStore({ dataDir: dataDir() });
    let pane: ComposerPane | null = null;
    let fx: Fixture | null = null;
    let hitAt = -1;
    const watched: PromptQueueStore = {
      ...store,
      pasted: (id) => {
        if (hitAt < 0 && pane !== null && fx !== null) {
          hitAt = fx.client.calls.length;
          pane.field = 'szkic przy Macu';
          pane.draw();
        }
        return store.pasted(id);
      },
    };
    fx = await paneWithStore(watched, { now: ACTIVE });
    pane = composerPane(fx);
    fx.driver.send('w czasie zapisu', undefined, undefined, { echo: 'e1' });
    await waitFor(() => pasteFlow(fx).length > 0, 'wklejenie');
    const after = fx.client.calls.slice(hitAt).map((call) => call.method);
    expect(after.indexOf('read')).toBeGreaterThanOrEqual(0);
    expect(after.indexOf('read')).toBeLessThan(after.indexOf('paste'));
  });

  it('notka z odtworzenia przychodzi po imporcie pełnej historii: zostaje w ostatnich 500 wiadomościach', async () => {
    await pastedThenRestart();
    const history = Array.from({ length: MAX_TRANSCRIPT_MESSAGES }, (_, i) => userLine(`wiadomość ${String(i)}`));
    const store = newStore({ dataDir: dataDir() });
    const fx = await paneWithStore(store, { now: ACTIVE }, [], { transcript: history.join('') });
    composerPane(fx);
    await waitFor(() => systemCodes(fx.events).length > 0, 'notka');
    await waitFor(() => fx.events.some((event) => event.type === 'history'), 'historia');
    // The manager keeps the last 500 messages of the transcript in the order the driver hands them over.
    const kept = fx.events.flatMap((event) => {
      if (event.type === 'history') return event.messages.map(() => 'history');
      return event.type === 'message' && event.role === 'system' ? systemCodes([event]) : [];
    }).slice(-MAX_TRANSCRIPT_MESSAGES);
    expect(kept).toContain('session.prompt-unseen');
    expect(pasteFlow(fx)).toEqual([]);
  });

  it('notka z odtworzenia przychodzi też wtedy, gdy pliku rozmowy nie ma', async () => {
    await rm(await pastedThenRestart());
    const store = newStore({ dataDir: dataDir() });
    const fx = await makeDriver({
      agent: { status: 'working', agentSessionId: SESSION }, noTranscript: true,
      deps: { promptStore: store, consentRegistryRead: () => Promise.resolve(ACTIVE) },
    });
    await waitFor(() => systemCodes(fx.events).length > 0, 'notka bez pliku rozmowy');
    expect(systemCodes(fx.events)).toEqual(['session.prompt-unseen']);
  });
});

/**
 * A queue entry belongs to the conversation it was accepted for, and a restore note
 * does not wait only for the follower's `artifacts` payout.
 */
describe('kolejka wklejeń: wpis należy do rozmowy, notka nie czeka tylko na artefakty', () => {
  /** `/clear` or `/resume` in the pane: herdr reports the other engine session and the driver gets the event. */
  const toOther = (fx: Fixture): void => {
    fx.client.getAgent = (): Promise<HerdrAgentInfo> => Promise.resolve({
      paneId: PANE, agentSessionId: OTHER, engine: 'claude', status: 'working',
    } as HerdrAgentInfo);
    fx.emit({ type: 'session-changed', agentSessionId: OTHER });
  };
  const NOT_SENT = `send: message for pane ${PANE} not sent: the pane runs another engine session`;

  it('wiadomość odtworzona z rozmowy A, w czasie zapisu „pasted” panel przeszedł do rozmowy B: bez wklejenia i Entera',
    async () => {
      await queuedThenRestart('dla rozmowy A');
      const registry: { now: Signal } = { now: WAITING };
      const store = newStore({ dataDir: dataDir() });
      let fx: Fixture | null = null;
      let hit = false;
      const watched: PromptQueueStore = {
        ...store,
        pasted: (id) => {
          if (!hit && fx !== null) {
            hit = true;
            toOther(fx);
          }
          return store.pasted(id);
        },
      };
      const logs: string[] = [];
      fx = await paneWithStore(watched, registry, logs);
      composerPane(fx);
      registry.now = ACTIVE;
      await waitFor(() => hit, 'zapis „pasted”');
      await waitFor(() => fileEntries().length === 0, 'wpis zszedł z pliku');
      await quiet();
      expect(pasteFlow(fx)).toEqual([]);
      expect(logs).toContain(NOT_SENT);
      expect(systemCodes(fx.events)).toContain('commands.send-session-changed');
    });

  it('wiadomość przyjęta w biegu czeka na dialog, panel przeszedł do rozmowy B: echo wraca, bez wklejenia', async () => {
    const registry: { now: Signal } = { now: WAITING };
    const store = newStore({ dataDir: dataDir() });
    const logs: string[] = [];
    const fx = await paneWithStore(store, registry, logs);
    composerPane(fx);
    fx.driver.send('dla rozmowy A', undefined, undefined, { echo: 'e1' });
    await fx.driver.queueSaved?.();
    await quiet();
    toOther(fx);
    registry.now = ACTIVE;
    await waitFor(() => fileEntries().length === 0, 'wpis zszedł z pliku');
    await quiet();
    expect(pasteFlow(fx)).toEqual([]);
    expect(fx.events).toContainEqual({ type: 'echo-refused', token: 'e1' });
    expect(systemCodes(fx.events)).toContain('commands.send-session-changed');
    expect(logs).toContain(NOT_SENT);
  });

  it('panel przeszedł do rozmowy B między wklejeniem a Enterem: bez Entera, wpis usunięty z pliku', async () => {
    const store = newStore({ dataDir: dataDir() });
    const logs: string[] = [];
    const fx = await paneWithStore(store, { now: ACTIVE }, logs);
    composerPane(fx);
    const paste = fx.client.pasteText;
    fx.client.pasteText = async (paneId, text) => {
      await paste(paneId, text);
      toOther(fx);
    };
    fx.driver.send('dla rozmowy A', undefined, undefined, { echo: 'e1' });
    await waitFor(() => pasteFlow(fx).length > 0, 'wklejenie');
    await waitFor(() => logs.includes(NOT_SENT), 'linia „not sent”');
    await waitFor(() => fileEntries().length === 0, 'wpis zszedł z pliku');
    await quiet();
    expect(pasteFlow(fx)).toEqual(['paste:dla rozmowy A']);
    expect(systemCodes(fx.events)).toContain('commands.send-session-changed');
  });

  it.each([
    ['w trakcie tury (kolejka wklejeń)', 'working'],
    ['bez tury (agent.prompt)', 'idle'],
  ] as const)('wysyłka %s: panel przeszedł do rozmowy B w czasie zapisu załącznika: odmowa, bez klawisza',
    async (_name, status) => {
      let release: (paths: string[]) => void = () => {};
      let writing = false;
      const uploads = {
        write: (): Promise<string[]> => {
          writing = true;
          return new Promise((resolve) => { release = resolve; });
        },
        writeFiles: () => Promise.resolve([]),
      } as unknown as HerdrDriverDeps['uploads'];
      const store = newStore({ dataDir: dataDir() });
      const logs: string[] = [];
      const fx = await paneWithStore(store, { now: ACTIVE }, logs, { agent: { status }, deps: { uploads } });
      composerPane(fx);
      // The manager accepted the message in conversation A; the task waits for the attachment write.
      fx.driver.send('dla rozmowy A', ['iVBORw0KGgo='], undefined, { echo: 'e1' });
      await waitFor(() => writing, 'zapis załącznika');
      toOther(fx);
      release(['.rarog/uploads/zdjecie.png']);
      await fx.driver.queueSaved?.();
      await waitFor(() => logs.includes(NOT_SENT), 'linia „not sent”');
      await quiet();
      expect(pasteFlow(fx)).toEqual([]);
      expect(fx.client.mutations).toBe(0);
      expect(fileTexts()).toEqual([]);
      expect(systemCodes(fx.events)).toContain('commands.send-session-changed');
    });

  it('plik rozmowy jest, ale odczyt historii się nie udaje: notka z odtworzenia przychodzi przy błędzie odczytu',
    async () => {
      await pastedThenRestart();
      const store = newStore({ dataDir: dataDir() });
      const fx = await makeDriver({
        agent: { status: 'idle' }, transcript: userLine('wcześniej'),
        deps: {
          promptStore: store, consentRegistryRead: () => Promise.resolve(ACTIVE),
          follow: (o) => createJsonlFollower({
            ...o, root, watch: false, timing: { ...TIMING, graceMs: 5 },
            io: { readRange: () => Promise.resolve(null) },
          }),
        },
      });
      inTurn(fx);
      await waitFor(() => systemCodes(fx.events).includes('transcript.no-transcript'), 'błąd odczytu historii');
      await quiet();
      expect(systemCodes(fx.events)).toContain('session.prompt-unseen');
      await waitFor(() => fileEntries().length === 0, 'znacznik zszedł z pliku po notce');
    });
});
