/**
 * Prompt zablokowany przez hook `UserPromptSubmit` — strona managera (`docs/dialogs.md`, „Prompt blocked by
 * a hook”).
 *
 * Without this handling a prompt blocked from Rarog looks sent: the session hangs in "working", and herdr `idle`
 * ends a "turn" that never happened with a false "done" push. Granica jak w testach kolejki promptów: atrapa
 * nadzorcy herdr
 * i driver sterowany z testu (zero gniazda, zero pliku), prawdziwy manager. Test sam podaje zdarzenie
 * `prompt-blocked`, które w produkcji składa driver z wpisu followera.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HerdrStatus, TranscriptMessage } from '@rarog/shared';
import { foreign } from '@rarog/shared/sentences';
import type { DriverEvent, InternalBlock } from '../src/drivers/types.ts';
import { echoKey } from '../src/herdr/jsonl-follow.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import {
  PROMPT_BLOCKED_LOG, createManager,
} from '../src/sessions/manager.ts';
import { INTERRUPT_WORKING_GRACE_MS, PROMPT_BLOCK_MARKER_MS } from '../src/sessions/state-sentences.ts';
import type { HerdrManagerDeps, Manager } from '../src/sessions/manager.ts';
import type { NoteInput, NotifierLike } from '../src/notify/index.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';

const ROOT = '/Users/demo/Projects';
const KEY = 'w1:p1';
const T0 = Date.parse('2026-10-19T17:00:00.000Z');
const REASON = 'this session must be restarted before it accepts new prompts';
const TITLE = "⚠ A hook blocked the prompt. It wasn't sent.";

class FixtureDriver extends AtrapaDrivera {
  push(...events: DriverEvent[]): void {
    for (const event of events) this.queue.push(event);
  }

  defersEcho(): boolean {
    return true;
  }
}

class FixtureSupervisor extends AtrapaNadzorcy<FixtureDriver> {
  readonly onAttach = new Map<string, DriverEvent[]>();

  override status(): HerdrStatus {
    return { available: true, agentCount: this.drivers.size, readOnly: false, canLaunch: false };
  }

  protected nowyDriver(key: string): FixtureDriver {
    return new FixtureDriver(key);
  }

  override attach(key: string): FixtureDriver {
    const driver = super.attach(key);
    driver.push(...(this.onAttach.get(key) ?? []));
    return driver;
  }

  appear(agent: HerdrAgent, onAttach: DriverEvent[]): void {
    this.onAttach.set(agent.key, onAttach);
    this.lifecycle.push({ type: 'appeared', agent });
  }
}

function agent(key: string): HerdrAgent {
  return {
    key, paneId: key, tabId: 'w1:t1', agentSessionId: '4b7f0d2e-9c61-4a3b-8e15-2d9f6c0a7b31',
    engine: 'claude', termId: null, cwd: `${ROOT}/atlas`, status: 'idle', title: 'atlas',
    stateChangeSeq: 1, mode: 'auto', modeReadAt: 0, inScope: true, launchedByRarog: true,
    interactiveReady: true,
  };
}

const idOf = (key: string): string => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`;

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

interface Rig {
  manager: Manager;
  id: string;
  driver: FixtureDriver;
  logs: string[];
  notes: NoteInput[];
  retracted: string[];
  clock: { value: number };
  close(): Promise<void>;
}

let dataDir: string;
const rigs: Rig[] = [];

async function open(): Promise<Rig> {
  const logs: string[] = [];
  const notes: NoteInput[] = [];
  const retracted: string[] = [];
  const clock = { value: T0 };
  const notifier: NotifierLike = {
    note: (input) => { notes.push(input); },
    seen: () => undefined,
    forget: () => undefined,
    quiet: () => undefined,
    retractTurnEnd: (sessionId) => { retracted.push(sessionId); },
  };
  const supervisor = new FixtureSupervisor();
  const deps: HerdrManagerDeps = {
    sessionIdFor: idOf,
    aliasFor: () => undefined,
    rememberAlias: () => undefined,
    assertSendable: (text) => ({ text: text.trim(), slash: null }),
    takeSendSlot: () => true,
    writeUploads: (cwd, images) => Promise.resolve(
      images.map((_, i) => `${cwd}/.rarog-uploads/1790000000-000000000000000${String(i)}.png`),
    ),
    writeUploadFiles: () => Promise.resolve([]),
    sweepUploads: () => Promise.resolve(),
  };
  const manager = await createManager({
    demo: false, dataDir, herdrSupervisor: supervisor, herdrDeps: deps, herdrRoots: [ROOT],
    now: () => clock.value, gitStatus: null, gitWatcher: null, queueEcho: true,
    liveSessionsReader: () => Promise.resolve(null),
    logger: (line) => { logs.push(line); },
    notifier,
  });
  await manager.ready;
  supervisor.appear(agent(KEY), [
    { type: 'agent-state', state: 'idle', seen: true, mode: 'auto', stateChangeSeq: 1 },
  ]);
  await flush();
  const driver = supervisor.drivers.get(KEY);
  if (driver === undefined) throw new Error('driver nie został podpięty');
  const rig: Rig = {
    manager, id: idOf(KEY), driver, logs, notes, retracted, clock,
    close: async () => {
      await manager.dispose();
      supervisor.dispose();
    },
  };
  rigs.push(rig);
  return rig;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'rarog-prompt-block-'));
});

afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close();
  await rm(dataDir, { recursive: true, force: true });
});

const flat = (message: TranscriptMessage): string => message.blocks
  .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`)).join(' ');
const messages = (r: Rig): TranscriptMessage[] => r.manager.transcript(r.id).messages;
const state = (r: Rig): string | undefined => r.manager.get(r.id)?.state;
const text = (value: string): InternalBlock[] => [{ type: 'text', text: foreign(value) }];

/** Zdarzenie, które driver składa z wpisu blokady: domyślnie blokada TEJ wysyłki, rozstrzygnięta przez driver. */
function blockedEvent(prompt: string, extra: Partial<Extract<DriverEvent, { type: 'prompt-blocked' }>> = {}): DriverEvent {
  return {
    type: 'prompt-blocked', reason: REASON, promptKept: false, prompt, echoed: true, decided: true,
    key: echoKey(prompt), ...extra,
  };
}

async function send(r: Rig, value: string): Promise<void> {
  await r.manager.sendMessage(r.id, value);
  await flush();
}

const kinds = (r: Rig): string[] => r.notes.map((note) => note.event.type);

describe('prompt zablokowany przez hook — manager', () => {
  it('wysyłka z Raroga do bezczynnej sesji zablokowana → notka pod dymkiem, „czeka”, bez końca tury w harmonogramie', async () => {
    const r = await open();
    await send(r, 'zrób refaktor');
    expect(state(r)).toBe('running');

    r.driver.push(blockedEvent('zrób refaktor'));
    await flush();

    const last = messages(r).slice(-2);
    expect(last.map((m) => `${m.role}: ${flat(m)}`)).toEqual([
      'user: zrób refaktor', `system: ${TITLE}\n${REASON}`,
    ]);
    // Dymek stoi od wysyłki — notka nie cytuje promptu drugi raz.
    expect(last[1]?.promptBlocked).toEqual({ reason: REASON });
    expect(state(r)).toBe('waiting-input');
    expect(kinds(r).slice(-2)).toEqual(['turn-start', 'prompt-blocked']);
    expect(r.logs).toContain(`${PROMPT_BLOCKED_LOG} (session ${r.id}, from Rarog: yes)`);
    expect(r.retracted).toEqual([]);
  });

  it('znacznik, nie rachunek tury: po historii (rachunek `undefined`) blokada też zdejmuje „pracuje”', async () => {
    const r = await open();
    r.driver.push({ type: 'history', messages: [{ role: 'assistant', blocks: text('wcześniej'), at: '2026-10-19T16:00:00.000Z' }] });
    await flush();
    await send(r, 'po historii');
    r.driver.push(blockedEvent('po historii'));
    await flush();
    expect(state(r)).toBe('waiting-input');
  });

  it('karencja: `working` z herdr zaraz po blokadzie nie wskrzesza „pracuje”; po karencji już tak', async () => {
    const r = await open();
    await send(r, 'z migotaniem');
    r.driver.push(blockedEvent('z migotaniem'));
    await flush();
    r.driver.push({ type: 'agent-state', state: 'working', seen: false, mode: 'auto', stateChangeSeq: 2 });
    await flush();
    expect(state(r)).toBe('waiting-input');

    r.clock.value += INTERRUPT_WORKING_GRACE_MS;
    r.driver.push({ type: 'agent-state', state: 'working', seen: false, mode: 'auto', stateChangeSeq: 3 });
    await flush();
    expect(state(r)).toBe('running');
  });

  it('herdr `idle` PRZED wpisem blokady: koniec tury cofnięty w harmonogramie, stan zostaje „czeka”', async () => {
    const r = await open();
    await send(r, 'idle pierwszy');
    r.driver.push({ type: 'agent-state', state: 'idle', seen: false, mode: 'auto', stateChangeSeq: 2 });
    await flush();
    expect(state(r)).toBe('waiting-input');
    expect(kinds(r).at(-1)).toBe('agent-idle');

    r.driver.push(blockedEvent('idle pierwszy'));
    await flush();
    expect(r.retracted).toEqual([r.id]);
    expect(state(r)).toBe('waiting-input');
    // Karencja i tu: spóźniony `working` nie otwiera tury, której nie było.
    r.driver.push({ type: 'agent-state', state: 'working', seen: false, mode: 'auto', stateChangeSeq: 3 });
    await flush();
    expect(state(r)).toBe('waiting-input');
  });

  it('wpis blokady PRZED herdr `idle`: `idle` po nim jest tożsamością, bez końca tury', async () => {
    const r = await open();
    await send(r, 'wpis pierwszy');
    r.driver.push(blockedEvent('wpis pierwszy'));
    await flush();
    const before = r.notes.length;
    r.driver.push({ type: 'agent-state', state: 'idle', seen: false, mode: 'auto', stateChangeSeq: 2 });
    await flush();
    expect(r.notes.slice(before).map((note) => note.event.type)).toEqual([]);
    expect(r.retracted).toEqual([]);
  });

  it('prompt z terminala (bez echa): notka z cytatem, stan bez zmian', async () => {
    const r = await open();
    r.driver.push(blockedEvent('wpisane przy Macu', { echoed: false, decided: false }));
    await flush();
    const note = messages(r).at(-1);
    expect(note?.role).toBe('system');
    expect(flat(note as TranscriptMessage)).toBe(`${TITLE}\n${REASON}\nPrompt: wpisane przy Macu`);
    expect(note?.promptBlocked).toEqual({ reason: REASON, prompt: 'wpisane przy Macu' });
    expect(state(r)).toBe('waiting-input');
    expect(r.logs).toContain(`${PROMPT_BLOCKED_LOG} (session ${r.id}, from Rarog: no)`);
  });

  it('blokada starszej wysyłki (driver: `decided: false`) → sama notka, „pracuje” zostaje', async () => {
    const r = await open();
    await send(r, 'starsza');
    r.driver.push(blockedEvent('starsza', { decided: false }));
    await flush();
    expect(flat(messages(r).at(-1) as TranscriptMessage)).toBe(`${TITLE}\n${REASON}`);
    expect(state(r)).toBe('running');
  });

  it('znacznik innego promptu: blokada promptu, który nie otworzył tej tury, nie zdejmuje „pracuje”', async () => {
    const r = await open();
    await send(r, 'otworzył turę');
    r.driver.push(blockedEvent('inny prompt'));
    await flush();
    expect(state(r)).toBe('running');
  });

  /*
   * Druga wysyłka przyjęta, zanim przyszła blokada pierwszej (hook trwa dłużej niż
   * odstęp między wysyłkami). Obie trafiają do CLI poza prawdziwą turą i obie blokuje hook.
   */
  it('dwie wysyłki przed blokadą pierwszej, obie zablokowane → „czeka” dopiero po drugiej blokadzie', async () => {
    const r = await open();
    await send(r, 'pierwsza');
    await send(r, 'druga');
    r.driver.push(blockedEvent('pierwsza'));
    await flush();
    expect(state(r)).toBe('running');
    r.driver.push(blockedEvent('druga'));
    await flush();
    expect(state(r)).toBe('waiting-input');
  });

  it('dwie wysyłki, pierwsza zablokowana, druga doszła → „pracuje” zostaje', async () => {
    const r = await open();
    await send(r, 'pierwsza');
    await send(r, 'druga');
    r.driver.push(blockedEvent('pierwsza'));
    r.driver.push({ type: 'turn-input' });
    await flush();
    expect(state(r)).toBe('running');
  });

  it('duży powód i duży cytat: pole `promptBlocked` przycięte jak notka (sufit wiadomości)', async () => {
    const r = await open();
    // Tekst ze spacjami jak prawdziwa wklejka (klucz echa liczy się po słowach).
    const huge = 'słowo '.repeat(200_000);
    r.driver.push(blockedEvent(huge, { echoed: false, decided: false, reason: huge }));
    await flush();
    const note = messages(r).at(-1);
    expect(Buffer.byteLength(note?.promptBlocked?.reason ?? '', 'utf8')).toBeLessThanOrEqual(8 * 1024);
    expect(Buffer.byteLength(note?.promptBlocked?.prompt ?? '', 'utf8')).toBeLessThanOrEqual(8 * 1024);
    expect(Buffer.byteLength(JSON.stringify(note), 'utf8')).toBeLessThan(64 * 1024);
  });

  it('bez znacznika: wysyłka do pracującej sesji, jej blokada nie zdejmuje „pracuje”', async () => {
    const r = await open();
    r.driver.push({ type: 'agent-state', state: 'working', seen: false, mode: 'auto', stateChangeSeq: 2 });
    await flush();
    await send(r, 'w trakcie');
    r.driver.push(blockedEvent('w trakcie'));
    await flush();
    expect(state(r)).toBe('running');
  });

  it('znacznik gaśnie: odpowiedź asystenta albo wiek ponad minutę', async () => {
    const r = await open();
    await send(r, 'ruszyła');
    r.driver.push({ type: 'message', role: 'assistant', blocks: text('pracuję') });
    r.driver.push(blockedEvent('ruszyła'));
    await flush();
    expect(state(r)).toBe('running');

    const s = await open();
    await send(s, 'za późno');
    s.clock.value += PROMPT_BLOCK_MARKER_MS + 1;
    s.driver.push(blockedEvent('za późno'));
    await flush();
    expect(state(s)).toBe('running');
  });

  it('echo odroczone (obrona): wstrzymany dymek staje przed notką', async () => {
    const r = await open();
    r.driver.push({ type: 'agent-state', state: 'working', seen: false, mode: 'auto', stateChangeSeq: 2 });
    await flush();
    const cid = randomUUID();
    await r.manager.sendMessage(r.id, 'z kolejki', undefined, undefined, cid, { queueAware: true });
    await flush();
    const token = r.driver.sendOpts.at(-1)?.echo;
    expect(token).toBeDefined();
    r.driver.push(blockedEvent('z kolejki', { token }));
    await flush();
    const last = messages(r).slice(-2);
    expect(last.map((m) => m.role)).toEqual(['user', 'system']);
    expect(last[0]?.clientMessageId).toBe(cid);
    expect(flat(last[1] as TranscriptMessage)).toBe(`${TITLE}\n${REASON}`);
  });

  it('historia z notką bez echa (po restarcie serwera): pole `promptBlocked` jedzie na wiadomości', async () => {
    const r = await open();
    r.driver.push({
      type: 'history',
      messages: [{
        role: 'system', blocks: text(`${TITLE}\n${REASON}\nPrompt: sprzed restartu`), at: '2026-10-19T16:59:00.000Z',
        promptBlocked: { reason: REASON, prompt: 'sprzed restartu' },
      }],
    });
    await flush();
    expect(messages(r).at(-1)?.promptBlocked).toEqual({ reason: REASON, prompt: 'sprzed restartu' });
    expect(state(r)).toBe('waiting-input');
  });
});
