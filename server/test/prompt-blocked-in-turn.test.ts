/**
 * Prompt wysłany w trakcie tury i zablokowany przez hook (`docs/dialogs.md`, „Prompt blocked by a hook”)
 * — strona managera.
 *
 * Hook biegnie od razu przy wysyłce, CLI nie zapisuje ŻADNEGO wpisu, a tekst wraca do pola i stoi tam po turze
 * (zmierzone na 2.1.303).
 * A held message (deferred echo) therefore gets no entry from the file. Instead of flushing it 10 s after the
 * turn as a delivered bubble, the manager first asks the driver about the input field (`checkHeldLeftover`) and
 * adds a note.
 *
 * Granica jak w testach kolejki promptów (`prompt-queue.test.ts`): atrapa nadzorcy herdr i driver sterowany
 * z testu (zero gniazda, zero pliku), prawdziwy manager. Odczyt pola atrapa trzyma w obietnicy, a test
 * odpowiada na nią jak prawdziwy driver: najpierw `valid()`, potem werdykty albo `null`. Sam odczyt ekranu
 * i flagi drivera pilnuje `herdr-driver.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileAttachment, HerdrStatus, TranscriptMessage } from '@rarog/shared';
import { foreign } from '@rarog/shared/sentences';
import type { InternalBlock } from '../src/drivers/types.ts';
import type { DriverEvent, HeldLeftover, HeldLeftoverItem, SendOptions } from '../src/drivers/types.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import {
  HELD_FLUSHED_LOG, HELD_QUEUE_LOG, createManager,
} from '../src/sessions/manager.ts';
import { heldNotTakenText, heldUnconfirmedText, heldUnseenText } from '../src/sessions/state-sentences.ts';
import type { HerdrManagerDeps, Manager } from '../src/sessions/manager.ts';
import { serverSystem } from '../src/version.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';

/** System procesu testów: manager bez pola `system` bierze słowo maszyny z niego. */
const SYSTEM = serverSystem();

const ROOT = '/Users/demo/Projects';
const KEY = 'w1:p1';
const CID = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const T0 = Date.parse('2026-10-19T20:00:00.000Z');

interface PendingCheck {
  readonly items: readonly HeldLeftoverItem[];
  readonly valid: () => boolean;
  readonly resolve: (verdicts: ReadonlyMap<string, HeldLeftover> | null) => void;
}

class FixtureDriver extends AtrapaDrivera {
  /** Kolejność zadań w kolejce drivera: `check` (odczyt pola) i `send:<tekst>`. */
  readonly zadania: string[] = [];
  readonly checks: PendingCheck[] = [];
  /** `false` = driver pola nie czyta (`RAROG_PROMPT_BLOCK=0`): `checkHeldLeftover` oddaje od razu `null`. */
  reads = true;

  push(...events: DriverEvent[]): void {
    for (const event of events) this.queue.push(event);
  }

  defersEcho(): boolean {
    return true;
  }

  override send(text: string, images?: readonly string[], files?: readonly FileAttachment[], opts?: SendOptions): void {
    this.zadania.push(`send:${text}`);
    super.send(text, images, files, opts);
  }

  get lastToken(): string {
    const token = this.sendOpts.at(-1)?.echo;
    if (token === undefined) throw new Error('ostatnia wysyłka nie niosła tokenu');
    return token;
  }

  checkHeldLeftover(
    items: readonly HeldLeftoverItem[], valid: () => boolean,
  ): Promise<ReadonlyMap<string, HeldLeftover> | null> | null {
    if (!this.reads) return null;
    this.zadania.push('check');
    return new Promise((resolve) => { this.checks.push({ items: [...items], valid, resolve }); });
  }

  /**
   * Odpowiedź na najstarszy odczyt — jak prawdziwy driver: `valid()` zaraz po odczycie, przy `false` wynik `null`.
   * Werdykty idą po kolei za wiadomościami odczytu (ostatni powtarza się dla reszty).
   *
   * @returns czy odczyt był ważny (prawdziwy driver ustawiłby wtedy flagi)
   */
  answer(...verdicts: HeldLeftover[]): boolean {
    const check = this.checks.shift();
    if (check === undefined) throw new Error('brak odczytu pola do odpowiedzi');
    const ok = check.valid();
    check.resolve(ok ? new Map(check.items.map((item, index) => (
      [item.token, verdicts[index] ?? verdicts.at(-1) ?? 'unknown'] as const
    ))) : null);
    return ok;
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
  supervisor: FixtureSupervisor;
  logs: string[];
  /** Driver podpięty TERAZ (po ponownym podpięciu — nowy). */
  driver(): FixtureDriver;
  close(): Promise<void>;
}

let dataDir: string;
const rigs: Rig[] = [];

async function open(): Promise<Rig> {
  const logs: string[] = [];
  const supervisor = new FixtureSupervisor();
  const deps: HerdrManagerDeps = {
    sessionIdFor: idOf,
    aliasFor: () => undefined,
    rememberAlias: () => undefined,
    assertSendable: (text) => ({ text: text.trim(), slash: null }),
    takeSendSlot: () => true,
    writeUploads: () => Promise.resolve([]),
    writeUploadFiles: () => Promise.resolve([]),
    sweepUploads: () => Promise.resolve(),
  };
  const manager = await createManager({
    demo: false, dataDir, herdrSupervisor: supervisor, herdrDeps: deps, herdrRoots: [ROOT],
    now: () => T0, gitStatus: null, gitWatcher: null, queueEcho: true,
    liveSessionsReader: () => Promise.resolve(null),
    logger: (line) => { logs.push(line); },
  });
  await manager.ready;
  supervisor.appear(agent(KEY), [
    { type: 'agent-state', state: 'idle', seen: true, mode: 'auto', stateChangeSeq: 1 },
  ]);
  await flush();
  if (!supervisor.drivers.has(KEY)) throw new Error('driver nie został podpięty');
  const rig: Rig = {
    manager, id: idOf(KEY), supervisor, logs,
    driver: () => {
      const driver = supervisor.drivers.get(KEY);
      if (driver === undefined) throw new Error('brak drivera');
      return driver;
    },
    close: async () => {
      await manager.dispose();
      supervisor.dispose();
    },
  };
  rigs.push(rig);
  return rig;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'rarog-n2-'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const r of rigs.splice(0)) await r.close();
  await rm(dataDir, { recursive: true, force: true });
});

const text = (value: string): InternalBlock[] => [{ type: 'text', text: foreign(value) }];
const flat = (message: TranscriptMessage): string => message.blocks
  .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`)).join(' ');
const messages = (r: Rig): TranscriptMessage[] => r.manager.transcript(r.id).messages;
const lines = (r: Rig): string[] => messages(r).map((m) => `${m.role}: ${flat(m)}`);

let stateSeq = 10;
async function state(r: Rig, value: 'working' | 'idle'): Promise<void> {
  stateSeq += 1;
  r.driver().push({ type: 'agent-state', state: value, seen: false, mode: 'auto', stateChangeSeq: stateSeq });
  await flush();
}

/** Wysyłka z apki umiejącej czekać (`queueAware`). */
function sendQueued(r: Rig, value: string, cid: string = randomUUID()): ReturnType<Manager['sendMessage']> {
  return r.manager.sendMessage(r.id, value, undefined, undefined, cid, { queueAware: true });
}

/** Prompt wysłany w trakcie tury (echo wstrzymane), potem koniec tury bez wzięcia promptu. */
async function heldThenIdle(r: Rig, ...prompts: string[]): Promise<void> {
  await state(r, 'working');
  for (const [index, prompt] of prompts.entries()) await sendQueued(r, prompt, index === 0 ? CID : randomUUID());
  await state(r, 'idle');
}

/** Upływ timera spłukania (10 s po końcu tury). */
async function flushTimer(): Promise<void> {
  vi.advanceTimersByTime(10_500);
  await flush();
}

// ---------------------------------------------------------------------------

describe('koniec tury bez wzięcia promptu — odczyt pola przed spłukaniem', () => {
  it('tekst w polu (`not-taken`): dymek, pod nim notka „nie doszedł”, linia dziennika z werdyktem', async () => {
    const r = await open();
    await heldThenIdle(r, 'zablokowany w turze');
    const token = r.driver().lastToken;
    await flushTimer();
    // Odczyt trwa: nic jeszcze nie stoi.
    expect(r.driver().checks.map((c) => c.items)).toEqual([[{ token, text: 'zablokowany w turze' }]]);
    expect(messages(r).some((m) => m.clientMessageId === CID)).toBe(false);

    expect(r.driver().answer('not-taken')).toBe(true);
    await flush();
    expect(lines(r).slice(-2)).toEqual([
      'user: zablokowany w turze', `system: ${heldNotTakenText('zablokowany w turze', SYSTEM).text}`,
    ]);
    expect(messages(r).at(-2)?.clientMessageId).toBe(CID);
    expect(heldNotTakenText('zablokowany w turze', 'macos').text).toBe(
      '⚠ The prompt “zablokowany w turze” didn\'t reach the agent. The CLI didn\'t accept it, and the text is still '
      + 'in the field on the Mac. A hook is the most common cause.',
    );
    expect(r.logs)
      .toContain(`${HELD_QUEUE_LOG} ${r.id} ${HELD_FLUSHED_LOG} 1: turn ended without taking the prompt (field: not-taken)`);

    // Driver wycofał token z okna echa (test drivera), więc ten sam prompt wysłany potem przy Macu przychodzi
    // zwykłym wpisem — i staje jako wiadomość, nie ginie jako duplikat.
    r.driver().push({ type: 'message', role: 'user', blocks: text('zablokowany w turze') });
    await flush();
    expect(lines(r).filter((line) => line === 'user: zablokowany w turze')).toHaveLength(2);
  });

  it('pole z innym tekstem (`unconfirmed`): dymek i notka „nie potwierdziłem”', async () => {
    const r = await open();
    await heldThenIdle(r, 'długi prompt z wklejki');
    await flushTimer();
    r.driver().answer('unconfirmed');
    await flush();
    expect(lines(r).slice(-2)).toEqual([
      'user: długi prompt z wklejki', `system: ${heldUnconfirmedText('długi prompt z wklejki', SYSTEM).text}`,
    ]);
    expect(heldUnconfirmedText('długi prompt z wklejki', 'macos').text).toBe(
      'Couldn\'t confirm that the agent received the prompt “długi prompt z wklejki”. There\'s unsent text in the field '
      + 'on the Mac.',
    );
  });

  it('tekstu wklejonego w trakcie tury driver nie zobaczył w polu (`unseen`): dymek i notka o wysyłce bez '
    + 'potwierdzenia', async () => {
    /*
     * Wklejenie przepadło w dialogu, a pierwszy odczyt po nim trwał ponad 300 ms: driver nie ma dowodu utraty i nie
     * wkleja drugi raz, bo tekst mógł pójść Enterem przy Macu (`docs/dialogs.md`, „Sending while a turn runs”). Po
     * turze bez wpisu z pliku pole jest puste, a dymek bez notki udawałby doręczenie.
     */
    const r = await open();
    await heldThenIdle(r, 'zgubiony w dialogu');
    await flushTimer();
    r.driver().answer('unseen');
    await flush();
    expect(lines(r).slice(-2)).toEqual([
      'user: zgubiony w dialogu', `system: ${heldUnseenText('zgubiony w dialogu').text}`,
    ]);
    expect(messages(r).at(-2)?.clientMessageId).toBe(CID);
    expect(heldUnseenText('zgubiony w dialogu').text).toBe(
      'Couldn\'t confirm that the agent received the prompt “zgubiony w dialogu”. Rarog didn\'t paste it again. '
      + 'Check the terminal.',
    );
    expect(r.logs)
      .toContain(`${HELD_QUEUE_LOG} ${r.id} ${HELD_FLUSHED_LOG} 1: turn ended without taking the prompt (field: unseen)`);
  });

  it.each<HeldLeftover>(['empty', 'unknown'])('`%s` → sam dymek na końcu, jak przed odczytem', async (verdict) => {
    const r = await open();
    await heldThenIdle(r, 'czekam');
    const before = messages(r).length;
    await flushTimer();
    r.driver().answer(verdict);
    await flush();
    expect(messages(r)).toHaveLength(before + 1);
    expect(messages(r).at(-1)).toMatchObject({ role: 'user', clientMessageId: CID });
  });

  it('notka cytuje początek promptu: białe znaki zbite, najwyżej 60 znaków i wielokropek', async () => {
    const r = await open();
    const long = `Pierwsza linia promptu\n\tz tabulatorem i ${'bardzo długim ogonem '.repeat(5)}`;
    await heldThenIdle(r, long);
    await flushTimer();
    r.driver().answer('not-taken');
    await flush();
    const quote = /“(.*)”/u.exec(flat(messages(r).at(-1) as TranscriptMessage))?.[1] ?? '';
    expect(quote.endsWith('…')).toBe(true);
    // 60 znaków po zbiciu białych znaków, bez spacji na końcu ucięcia.
    expect(Array.from(quote.slice(0, -1)).length).toBeLessThanOrEqual(60);
    expect(quote.slice(0, -1)).toBe(quote.slice(0, -1).trimEnd());
    expect(quote.startsWith('Pierwsza linia promptu z tabulatorem i bardzo')).toBe(true);
  });

  it('dwa prompty zablokowane w jednej turze: dymek i notka każdego, w kolejności wysyłki', async () => {
    const r = await open();
    await heldThenIdle(r, 'pierwszy', 'drugi');
    await flushTimer();
    expect(r.driver().checks[0]?.items.map((item) => item.text)).toEqual(['pierwszy', 'drugi']);
    r.driver().answer('not-taken', 'not-taken');
    await flush();
    expect(lines(r).slice(-4)).toEqual([
      'user: pierwszy', `system: ${heldNotTakenText('pierwszy', SYSTEM).text}`,
      'user: drugi', `system: ${heldNotTakenText('drugi', SYSTEM).text}`,
    ]);
  });

  it('wiadomość wzięta z pliku w trakcie odczytu → bez notki i bez drugiego dymka', async () => {
    const r = await open();
    await heldThenIdle(r, 'wzięty', 'zablokowany');
    const tokens = r.driver().sendOpts.map((opts) => opts?.echo);
    await flushTimer();
    r.driver().push({ type: 'message', role: 'user', blocks: text('wzięty'), echoToken: tokens[0] as string });
    await flush();
    r.driver().answer('empty', 'not-taken');
    await flush();
    expect(lines(r).filter((line) => line === 'user: wzięty')).toHaveLength(1);
    expect(lines(r).slice(-2)).toEqual(['user: zablokowany', `system: ${heldNotTakenText('zablokowany', SYSTEM).text}`]);
  });

  it('powrót w turę w trakcie odczytu: nic nie staje, flag nie ma; następne wyjście z tury czyta pole od nowa', async () => {
    const r = await open();
    await heldThenIdle(r, 'czekam');
    await flushTimer();
    await state(r, 'working');
    expect(r.driver().answer('not-taken')).toBe(false);
    await flush();
    expect(messages(r).some((m) => m.clientMessageId === CID)).toBe(false);

    await state(r, 'idle');
    await flushTimer();
    expect(r.driver().checks).toHaveLength(1);
    r.driver().answer('empty');
    await flush();
    expect(messages(r).at(-1)).toMatchObject({ role: 'user', clientMessageId: CID });
  });

  it('nowy driver (ponowne podpięcie) w trakcie odczytu: bez notki, dymek spłukuje odpięcie jak dawniej', async () => {
    const r = await open();
    await heldThenIdle(r, 'czekam');
    await flushTimer();
    const old = r.driver();
    r.supervisor.lifecycle.push({ type: 're-attached', agent: agent(KEY) });
    await flush();
    expect(r.driver()).not.toBe(old);
    expect(messages(r).at(-1)).toMatchObject({ role: 'user', clientMessageId: CID });
    expect(old.answer('not-taken')).toBe(false);
    await flush();
    expect(lines(r).some((line) => line.includes('nie doszedł'))).toBe(false);
    expect(messages(r).filter((m) => m.clientMessageId === CID)).toHaveLength(1);
  });

  it('`RAROG_PROMPT_BLOCK=0` (driver nie czyta pola): spłukanie od razu, bez notki', async () => {
    const r = await open();
    r.driver().reads = false;
    await heldThenIdle(r, 'czekam');
    await flushTimer();
    expect(r.driver().zadania).not.toContain('check');
    expect(messages(r).at(-1)).toMatchObject({ role: 'user', clientMessageId: CID });
    expect(r.logs).toContain(`${HELD_QUEUE_LOG} ${r.id} ${HELD_FLUSHED_LOG} 1: turn ended without taking the prompt`);
  });
});

describe('wysyłka z Raroga po turze, zanim timer spłukał wstrzymane wiadomości', () => {
  it('odczyt w kolejce drivera PRZED wysyłką; dymek wstrzymanej nad nowym, notka po odczycie', async () => {
    const r = await open();
    await heldThenIdle(r, 'zablokowany w turze');
    await r.manager.sendMessage(r.id, 'następny prompt', undefined, undefined, randomUUID(), { queueAware: true });
    expect(r.driver().zadania).toEqual(['send:zablokowany w turze', 'check', 'send:następny prompt']);
    expect(lines(r).slice(-2)).toEqual(['user: zablokowany w turze', 'user: następny prompt']);
    expect(messages(r).at(-2)?.clientMessageId).toBe(CID);
    expect(r.logs).toContain(`${HELD_QUEUE_LOG} ${r.id} ${HELD_FLUSHED_LOG} 1: send from Rarog after the turn`);

    // Nasza wysyłka otworzyła turę, ale odczyt stał przed nią w kolejce — liczy się.
    expect(r.driver().answer('not-taken')).toBe(true);
    await flush();
    expect(lines(r).at(-1)).toBe(`system: ${heldNotTakenText('zablokowany w turze', SYSTEM).text}`);

    // Timer spłukania rozbrojony: drugiego odczytu i drugiego dymka nie ma.
    await state(r, 'idle');
    await flushTimer();
    expect(r.driver().zadania.filter((call) => call === 'check')).toHaveLength(1);
    expect(messages(r).filter((m) => m.clientMessageId === CID)).toHaveLength(1);
  });

  it('wysyłka w trakcie odczytu z timera unieważnia go; jej odczyt rozstrzyga', async () => {
    const r = await open();
    await heldThenIdle(r, 'zablokowany w turze');
    await flushTimer();
    await r.manager.sendMessage(r.id, 'następny prompt');
    expect(r.driver().answer('not-taken')).toBe(false);
    expect(r.driver().answer('not-taken')).toBe(true);
    await flush();
    expect(lines(r).slice(-3)).toEqual([
      'user: zablokowany w turze', 'user: następny prompt', `system: ${heldNotTakenText('zablokowany w turze', SYSTEM).text}`,
    ]);
  });

  it('`RAROG_PROMPT_BLOCK=0`: wysyłka bez odczytu pola — wstrzymana wiadomość czeka dalej', async () => {
    const r = await open();
    r.driver().reads = false;
    await heldThenIdle(r, 'czekam');
    await r.manager.sendMessage(r.id, 'następny prompt');
    expect(r.driver().zadania).toEqual(['send:czekam', 'send:następny prompt']);
    expect(messages(r).some((m) => m.clientMessageId === CID)).toBe(false);
    expect(lines(r).at(-1)).toBe('user: następny prompt');
  });
});
