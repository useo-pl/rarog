/**
 * The turn guard of the herdr driver (`drivers/herdr/turn-guard.ts`): the turn watchdog, the end of a local command
 * and a prompt blocked by a hook. The tests drive the module through the driver facade on the shared fakes
 * (`helpers/herdr-driver-atrapy.ts`): its timers only mean something next to the driver's send chain.
 */
import { describe, expect, it } from 'vitest';
import { foreign } from '@rarog/shared/sentences';
import { readFileSync } from 'node:fs';
import { appendFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DriverEvent } from '../src/drivers/types.ts';
import { STALLED_PROMPT_MESSAGE, quietCommandMessage } from '../src/drivers/herdr/commands.ts';
import { buildCatalog } from '../src/herdr/commands/catalog.ts';
import type { CommandCatalog } from '../src/herdr/commands/catalog.ts';
import { HerdrStalledError } from '../src/herdr/types.ts';
import type { HerdrAgentInfo } from '../src/herdr/types.ts';
import type { Scheduler } from '../src/drivers/runtime.ts';
import {
  FakeClient, SESSION, blockedLine, commandOpts, makeDriver, quiet, useDriverSandbox, userLine, waitFor,
} from './helpers/herdr-driver-atrapy.ts';
import type { Call, Fixture } from './helpers/herdr-driver-atrapy.ts';

const SESSION_B = '9f1c4b62-77aa-5d31-8bd0-2c0f6a1e4d55';

useDriverSandbox();

/** Shorter than `quiet()`, for the same reason as in `herdr-driver.test.ts`: a negative assertion after `quiet()`. */
const TEST_WATCHDOG_MS = 5;

/** A catalog with a plugin command: the registry does not know plugins. */
const PLUGIN_CATALOG: CommandCatalog = buildCatalog('/projekt', {
  commands: [{ name: 'code-review:code-review', source: 'plugin', origin: 'plugin-command' }],
  hidden: [], synced: [], skippedPlugins: [], notes: [], stamps: new Map(),
});

const systemTexts = (events: readonly DriverEvent[]): string[] => events
  .filter((e): e is Extract<DriverEvent, { type: 'message' }> =>
    e.type === 'message' && e.role === 'system')
  .flatMap((e) => e.blocks.map((b) => (b.type === 'text' ? b.text.text : '')));

const states = (events: readonly DriverEvent[]): Extract<DriverEvent, { type: 'agent-state' }>[] =>
  events.filter((e): e is Extract<DriverEvent, { type: 'agent-state' }> => e.type === 'agent-state');

describe('watchdog tury', () => {
  it('cisza po wysyłce → komunikat + `idle` (koniec wiecznego „pracuje")', async () => {
    const fx = await makeDriver({ deps: { turnWatchdogMs: TEST_WATCHDOG_MS } });
    fx.driver.send('wysłane w próżnię');
    await waitFor(() => systemTexts(fx.events).includes(STALLED_PROMPT_MESSAGE.text), 'watchdog');
    expect(states(fx.events).at(-1)?.state).toBe('idle');
  });

  /**
   * Dziura 1 z researchu komend „/". `/status`, `/context`, `/cost`, `/usage`,
   * `/help` i `/agents` nie ruszają jsonl ani statusu herdr, więc watchdog ciszy meldował
   * awarię tam, gdzie komenda wykonała się poprawnie.
   */
  it('komenda informacyjna kończy się CICHO — bez zdania „utknęła" i bez uzbrojenia Esc', async () => {
    const fx = await makeDriver({ deps: { turnWatchdogMs: TEST_WATCHDOG_MS } });
    fx.driver.send('/context', undefined, undefined, commandOpts('/context'));
    await waitFor(
      () => systemTexts(fx.events).includes(quietCommandMessage('/context').text),
      'watchdog',
    );
    // Zdanie o niewysłanej wiadomości było tu po prostu NIEPRAWDĄ.
    expect(systemTexts(fx.events)).not.toContain(STALLED_PROMPT_MESSAGE.text);
    // Composer i tak wraca — inaczej sesja zostaje w wiecznym „pracuje".
    expect(states(fx.events).at(-1)?.state).toBe('idle');

    /*
     * `#needsEscape` NIE uzbrojone: następna wysyłka idzie prosto, bez czytania i czyszczenia
     * composera. Esc byłby tu wprost szkodliwy — zamknąłby dialog, który komenda otworzyła.
     * Odczyt ekranu jest jedynym śladem czyszczenia widocznym z zewnątrz.
     */
    const count = (method: string): number =>
      fx.client.calls.filter((c) => c.method === method).length;
    const before = count('read');
    fx.driver.send('kolejna wiadomość');
    await waitFor(() => count('prompt') === 2, 'druga wysyłka');
    await quiet();
    // Dokładnie JEDEN odczyt więcej: bramka dialogu zgody, bez odczytu composera pod Esc.
    expect(count('read')).toBe(before + 1);
  });

  it('zwykła wiadomość NADAL dostaje ostrzeżenie — cisza jest wtedy awarią', async () => {
    const fx = await makeDriver({ deps: { turnWatchdogMs: TEST_WATCHDOG_MS } });
    fx.driver.send('wysłane w próżnię');
    await waitFor(() => systemTexts(fx.events).includes(STALLED_PROMPT_MESSAGE.text), 'watchdog');
    expect(systemTexts(fx.events).some((t) => t.startsWith('ⓘ'))).toBe(false);
  });

  it('panel, który RUSZYŁ, nie dostaje fałszywego alarmu', async () => {
    const fx = await makeDriver({ deps: { turnWatchdogMs: TEST_WATCHDOG_MS } });
    fx.driver.send('normalna tura');
    await waitFor(() => fx.client.calls.some((c) => c.method === 'prompt'), 'prompt');
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 8, title: 'refaktor' });
    await quiet();

    expect(systemTexts(fx.events)).toEqual([]);
  });

  it('`dispose()` gasi watchdog', async () => {
    /*
     * Asercja na sam transkrypt niczego by tu nie dowiodła: po `dispose()` kolejka zdarzeń jest
     * zamknięta, a `#emit` sprawdza `#disposed`, więc `[]` wychodzi TAKŻE wtedy, gdy watchdog
     * odpalił (sprawdzone mutacją: zdjęcie trzech tamtych bramek nie czerwieni niczego). Patrzymy
     * więc na TIMERY drivera: po zamknięciu nie ma prawa odpalić ani jeden.
     */
    let closed = false;
    const late: number[] = [];
    const scheduler: Scheduler = {
      setTimeout: (fn, ms) => setTimeout(() => { if (closed) late.push(ms); fn(); }, ms),
      clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
      now: () => Date.now(),
    };
    const fx = await makeDriver({ deps: { turnWatchdogMs: TEST_WATCHDOG_MS, scheduler } });
    fx.driver.send('tuż przed zamknięciem');
    await waitFor(() => fx.client.calls.some((c) => c.method === 'prompt'), 'prompt');
    fx.driver.dispose();
    closed = true;
    await quiet();

    expect(late).toEqual([]);
    expect(systemTexts(fx.events)).toEqual([]);
  });
});

/*
 * Explicit end of a LOCAL command. `/context` does not start a turn: herdr stays `idle`, so no status
 * event comes, and file activity (the command's notes) is its result. A watchdog that released on that
 * activity would leave the session "working" until resync. The end is announced by the result of THIS
 * command from the file, otherwise by the watchdog after its full time; the silent-end sentence only for an
 * empty file.
 */
describe('koniec komendy lokalnej', () => {
  /** Watchdog dłuższy od budżetu `waitFor`: stan `idle` w teście może przyjść wyłącznie z wyniku komendy. */
  const LONG_WATCHDOG_MS = 60_000;
  const CONTEXT = (): string => readFileSync(
    join(import.meta.dirname, 'fixtures/herdr/commands/measured/nieznane-sciezki-plan-context-2.1.302.jsonl'), 'utf8',
  ).split('\n').filter((raw) => raw.trim() !== '').slice(14, 16).map((raw) => `${raw}\n`).join('');
  const outputSeen = (events: readonly DriverEvent[]): boolean =>
    systemTexts(events).some((text) => text.startsWith('Context Usage'));
  /**
   * Follower ma za sobą pierwszy odczyt pliku. Wynik dopisany przed nim wchodzi kanałem `history`, a `outputSeen`
   * czeka na notkę z odczytu przyrostowego. Testy, które dopisują wynik w podmienionym `prompt`, wysyłają zaraz
   * po starcie drivera, więc bez tego czekania wynik zależy od tego, czy pierwszy odczyt zdążył przed dopisaniem.
   */
  const primed = (fx: Fixture): Promise<void> => waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
  const noAlarm = (events: readonly DriverEvent[]): void => {
    expect(systemTexts(events)).not.toContain(STALLED_PROMPT_MESSAGE.text);
    expect(systemTexts(events)).not.toContain(quietCommandMessage('/context').text);
  };

  it('wynik po uzbrojeniu watchdoga → notka, potem `idle`, bez „utknęła” i bez zdania o cichym końcu', async () => {
    const fx = await makeDriver({ transcript: userLine('start'), deps: { turnWatchdogMs: LONG_WATCHDOG_MS } });
    fx.driver.send('/context', undefined, undefined, commandOpts('/context'));
    await waitFor(() => fx.client.calls.some((c) => c.method === 'prompt'), 'prompt');
    await quiet();
    const before = states(fx.events).length;

    await appendFile(fx.transcript, CONTEXT());
    await waitFor(() => states(fx.events).length > before, 'koniec komendy');
    expect(states(fx.events).at(-1)?.state).toBe('idle');
    // Notka z wynikiem stoi PRZED stanem, a manager nie dostaje znacznika followera.
    const outputAt = fx.events.findIndex((e) => e.type === 'message' && outputSeen([e]));
    expect(outputAt).toBeGreaterThan(-1);
    expect(outputAt).toBeLessThan(fx.events.lastIndexOf(states(fx.events).at(-1) as DriverEvent));
    expect(fx.events.some((e) => 'commandOutput' in e)).toBe(false);
    noAlarm(fx.events);
  });

  it('wynik PRZED uzbrojeniem watchdoga (plik szybszy od gniazda) → `idle` od razu po wysyłce', async () => {
    const fx = await makeDriver({ transcript: userLine('start'), deps: { turnWatchdogMs: LONG_WATCHDOG_MS } });
    await primed(fx);
    const prompt = fx.client.prompt.bind(fx.client);
    fx.client.prompt = async (paneId, text, wait) => {
      await prompt(paneId, text, wait);
      // Odpowiedź gniazda wraca dopiero wtedy, gdy driver ma już wynik komendy z pliku.
      await appendFile(fx.transcript, CONTEXT());
      await waitFor(() => outputSeen(fx.events), 'wynik przed odpowiedzią gniazda');
    };
    fx.driver.send('/context', undefined, undefined, commandOpts('/context'));
    await waitFor(() => states(fx.events).some((e) => e.state === 'idle'), 'koniec komendy');
    noAlarm(fx.events);
  });

  /*
   * Druga wysyłka przyjęta przez `send()`, gdy pierwsza (komenda lokalna) czeka na odpowiedź
   * gniazda — manager stoi już w `running` drugiej. Wynik pierwszej nie ma prawa ogłosić `idle` nad tą drugą.
   */
  it('wynik komendy lokalnej nie gasi `running` nowszej wysyłki czekającej w kolejce', async () => {
    const fx = await makeDriver({ transcript: userLine('start'), deps: { turnWatchdogMs: LONG_WATCHDOG_MS } });
    await primed(fx);
    const prompt = fx.client.prompt.bind(fx.client);
    let first = true;
    fx.client.prompt = async (paneId, text, wait) => {
      await prompt(paneId, text, wait);
      if (!first) return;
      first = false;
      await appendFile(fx.transcript, CONTEXT());
      await waitFor(() => outputSeen(fx.events), 'wynik przed odpowiedzią gniazda');
      fx.driver.send('druga wiadomość');
    };
    fx.driver.send('/context', undefined, undefined, commandOpts('/context'));
    await waitFor(() => fx.client.calls.filter((c) => c.method === 'prompt').length === 2, 'druga wysyłka');
    await quiet();
    expect(states(fx.events).filter((e) => e.state === 'idle')).toEqual([]);
  });

  it('plik przyniósł coś innego niż wynik → po watchdogu `idle` bez zdania o cichym końcu', async () => {
    const fx = await makeDriver({ transcript: userLine('start'), deps: { turnWatchdogMs: 150 } });
    fx.driver.send('/context', undefined, undefined, commandOpts('/context'));
    await waitFor(() => fx.client.calls.some((c) => c.method === 'prompt'), 'prompt');
    await appendFile(fx.transcript, userLine('wpisane w terminalu'));
    await waitFor(() => states(fx.events).some((e) => e.state === 'idle'), 'watchdog');
    noAlarm(fx.events);
  });

  it('wynik komendy wpisanej w terminalu (inna nazwa) nie kończy komendy z Raroga', async () => {
    const fx = await makeDriver({ transcript: userLine('start'), deps: { turnWatchdogMs: LONG_WATCHDOG_MS } });
    fx.driver.send('/plan', undefined, undefined, commandOpts('/plan'));
    await waitFor(() => fx.client.calls.some((c) => c.method === 'prompt'), 'prompt');
    await quiet();
    const before = states(fx.events).length;
    await appendFile(fx.transcript, CONTEXT());
    await waitFor(() => outputSeen(fx.events), 'wynik /context');
    await quiet();
    expect(states(fx.events).length).toBe(before);
  });

  it('panel stoi na blokadzie w chwili wyniku → stan zostaje, karta nie gaśnie', async () => {
    const fx = await makeDriver({ transcript: userLine('start'), deps: { turnWatchdogMs: LONG_WATCHDOG_MS } });
    fx.driver.send('/context', undefined, undefined, commandOpts('/context'));
    await waitFor(() => fx.client.calls.some((c) => c.method === 'prompt'), 'prompt');
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: 'refaktor' });
    await quiet();
    await appendFile(fx.transcript, CONTEXT());
    await waitFor(() => outputSeen(fx.events), 'wynik');
    await quiet();
    expect(states(fx.events).at(-1)?.state).toBe('blocked');
  });

  it('komenda typu prompt zostaje przy logice tury: ruch w pliku to start tury, nie koniec', async () => {
    const fx = await makeDriver({ transcript: userLine('start'), deps: { turnWatchdogMs: 150 } });
    fx.driver.send('/init', undefined, undefined, commandOpts('/init'));
    await waitFor(() => fx.client.calls.some((c) => c.method === 'prompt'), 'prompt');
    await appendFile(fx.transcript, userLine('<command-message>init</command-message>\n<command-name>/init</command-name>'));
    // Po pełnym czasie watchdoga: ruch w pliku zwalnia go zwykłą drogą, bez stanu i bez zdania.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(states(fx.events)).toEqual([]);
    expect(systemTexts(fx.events)).toEqual([]);
  });
});

/*
 * `/rename` sent while a turn runs (Claude Code 2.1.325): the CLI renames at once, keeps the turn and writes only
 * `custom-title` and `agent-name`, without the `system/local_command` call and output; the turn ends with herdr's own
 * state change. In idle the CLI writes the usual pair, which clears the echo and ends the command.
 */
describe('local command sent while a turn runs', () => {
  const LONG_WATCHDOG_MS = 60_000;
  const MEASURED = join(import.meta.dirname, 'fixtures/herdr/commands/measured');
  const lines = (file: string): string[] => readFileSync(join(MEASURED, file), 'utf8')
    .split('\n').filter((raw) => raw.trim() !== '').map((raw) => `${raw}\n`);
  /** Prompt and tool call, the rename's two entries, then the rest of the turn up to its end. */
  const IN_TURN = lines('rename-in-turn-2.1.325.jsonl');
  const turnStart = IN_TURN.slice(0, 2).join('');
  const renameEntries = IN_TURN.slice(2, 4).join('');
  const turnEnd = IN_TURN.slice(4).join('');
  /** The idle call and output pair, the name entries and the `isMeta` reminder. */
  const IDLE = lines('rename-custom-title-2.1.319.jsonl').slice(2, 7);
  /** The same name typed in the terminal while idle: the call and output pair. */
  const typedInTerminal = IDLE.slice(0, 2).join('').replaceAll('demo-eksport', 'demo-csv');

  const titles = (events: readonly DriverEvent[]): string[] => events
    .filter((e): e is Extract<DriverEvent, { type: 'title' }> => e.type === 'title' && e.source === 'custom-title')
    .map((e) => e.title);
  const primed = (fx: Fixture): Promise<void> => waitFor(() => fx.events.some((e) => e.type === 'history'), 'history');
  const noNotice = (events: readonly DriverEvent[]): void => {
    expect(systemTexts(events)).not.toContain(STALLED_PROMPT_MESSAGE.text);
    expect(systemTexts(events)).not.toContain(quietCommandMessage('/rename').text);
  };
  /** The echo of a command sent inside a turn lives this long (shortened from the production bound). */
  const IN_TURN_ECHO_MS = 50;
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const working = async (watchdogMs: number, transcript = turnStart): Promise<Fixture> => {
    const fx = await makeDriver({
      transcript, deps: { turnWatchdogMs: watchdogMs, inTurnCommandEchoMs: IN_TURN_ECHO_MS },
    });
    await primed(fx);
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 8, title: 'demo' });
    await quiet();
    return fx;
  };
  const renameInTurn = async (watchdogMs: number): Promise<Fixture> => {
    const fx = await working(watchdogMs);
    fx.driver.send('/rename demo-csv', undefined, undefined, commandOpts('/rename demo-csv'));
    await waitFor(() => fx.client.calls.some((c) => c.method === 'prompt'), 'prompt');
    await appendFile(fx.transcript, renameEntries);
    await waitFor(() => titles(fx.events).length > 0, 'name from custom-title');
    return fx;
  };

  it('the label comes from `custom-title`, and the echo does not swallow the same command typed later', async () => {
    const fx = await renameInTurn(LONG_WATCHDOG_MS);
    expect(fx.client.calls.filter((c) => c.method === 'prompt').map((c) => c.text)).toEqual(['/rename demo-csv']);
    expect(titles(fx.events)).toEqual(['demo-csv']);
    await appendFile(fx.transcript, turnEnd);
    fx.emit({ type: 'status', status: 'done', stateChangeSeq: 9, title: 'demo-csv' });
    await waitFor(() => states(fx.events).some((e) => e.state === 'idle'), 'turn end');

    // CLI 2.1.325 wrote no call entry for the phone's send, so an echo entry would wait for the next identical call.
    await sleep(IN_TURN_ECHO_MS * 2);
    await appendFile(fx.transcript, typedInTerminal);
    await waitFor(() => systemTexts(fx.events).includes('Session renamed to: demo-csv'), 'output from the terminal');
    expect(systemTexts(fx.events)).toContain('/rename demo-csv');
  });

  it('a turn that ends before the Enter: the call written in idle clears as an echo', async () => {
    const fx = await working(LONG_WATCHDOG_MS);
    const prompt = fx.client.prompt.bind(fx.client);
    fx.client.prompt = async (paneId, text, wait) => {
      // herdr reports the end of the turn between the send decision and the Enter.
      fx.emit({ type: 'status', status: 'done', stateChangeSeq: 9, title: 'demo' });
      await prompt(paneId, text, wait);
    };
    fx.driver.send('/rename demo-eksport', undefined, undefined, commandOpts('/rename demo-eksport'));
    await waitFor(() => fx.client.calls.some((c) => c.method === 'prompt'), 'prompt');
    await appendFile(fx.transcript, IDLE.join(''));
    await waitFor(() => systemTexts(fx.events).includes('Session renamed to: demo-eksport'), 'output');
    await quiet();

    expect(titles(fx.events)).toEqual(['demo-eksport']);
    expect(systemTexts(fx.events)).not.toContain('/rename demo-eksport');
    noNotice(fx.events);
  });

  it('a watchdog armed by an earlier prompt keeps its own verdict', async () => {
    const fx = await makeDriver({ transcript: userLine('start'), deps: { turnWatchdogMs: 150 } });
    await primed(fx);
    const prompts = (): number => fx.client.calls.filter((c) => c.method === 'prompt').length;
    fx.driver.send('normal turn');
    await waitFor(() => prompts() === 1, 'prompt');
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 8, title: 'demo' });
    await quiet();
    fx.driver.send('/rename demo-csv', undefined, undefined, commandOpts('/rename demo-csv'));
    await waitFor(() => prompts() === 2, '/rename');
    /*
     * The pane falls idle before the watchdog of the earlier prompt fires. That watchdog saw the pane move, so it ends
     * silently; a watchdog of the command's own would see a silent file since the command and add the notice about
     * a command that started no turn, with a second `idle`.
     */
    fx.emit({ type: 'status', status: 'idle', stateChangeSeq: 9, title: 'demo' });
    await sleep(250);
    expect(states(fx.events).map((e) => e.state)).toEqual(['working', 'idle']);
    noNotice(fx.events);
  });

  it('a turn that ends before the watchdog ends once, by herdr, without a notice', async () => {
    const fx = await renameInTurn(150);
    await appendFile(fx.transcript, turnEnd);
    fx.emit({ type: 'status', status: 'done', stateChangeSeq: 9, title: 'demo-csv' });
    await waitFor(() => states(fx.events).some((e) => e.state === 'idle'), 'turn end');
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(states(fx.events).map((e) => e.state)).toEqual(['working', 'idle']);
    noNotice(fx.events);
  });

  it('a turn longer than the watchdog keeps working without a notice and ends by herdr', async () => {
    const fx = await renameInTurn(150);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(states(fx.events).map((e) => e.state)).toEqual(['working']);
    noNotice(fx.events);

    await appendFile(fx.transcript, turnEnd);
    fx.emit({ type: 'status', status: 'done', stateChangeSeq: 9, title: 'demo-csv' });
    await waitFor(() => states(fx.events).some((e) => e.state === 'idle'), 'turn end');
    await quiet();
    expect(states(fx.events).map((e) => e.state)).toEqual(['working', 'idle']);
    noNotice(fx.events);
  });

  it('in idle the call clears as an echo and the output ends the command before the watchdog', async () => {
    const fx = await makeDriver({ transcript: userLine('start'), deps: { turnWatchdogMs: LONG_WATCHDOG_MS } });
    await primed(fx);
    fx.driver.send('/rename demo-eksport', undefined, undefined, commandOpts('/rename demo-eksport'));
    await waitFor(() => fx.client.calls.some((c) => c.method === 'prompt'), 'prompt');
    await appendFile(fx.transcript, IDLE.join(''));
    await waitFor(() => states(fx.events).some((e) => e.state === 'idle'), 'end of the command');

    expect(titles(fx.events)).toEqual(['demo-eksport']);
    expect(systemTexts(fx.events)).toContain('Session renamed to: demo-eksport');
    expect(systemTexts(fx.events)).not.toContain('/rename demo-eksport');
    noNotice(fx.events);
  });
});

/*
 * Prompt blocked by a `UserPromptSubmit` hook (`docs/dialogs.md`, "Prompt blocked by a hook"). The screen keeps the
 * prompt (the CLI returns it to the field), so a driver that took it for a stall would send an Esc pair and a SECOND
 * `prompt`, which the hook blocks again, ending in "prompt stuck". The block entry from the file decides the send after
 * EVERY `await` of the stall guard.
 */
describe('prompt zablokowany przez hook', () => {
  const stalled = (): HerdrStalledError => new HerdrStalledError(foreign('agent_prompt_stalled'));
  const escs = (fx: Fixture): (readonly string[] | undefined)[] =>
    fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys);
  const prompts = (fx: Fixture): Call[] => fx.client.calls.filter((c) => c.method === 'prompt');
  const blocked = (events: readonly DriverEvent[]): Extract<DriverEvent, { type: 'prompt-blocked' }>[] =>
    events.filter((e): e is Extract<DriverEvent, { type: 'prompt-blocked' }> => e.type === 'prompt-blocked');
  const leftover = (fx: Fixture): boolean => (fx.driver as unknown as { blockedLeftover: boolean }).blockedLeftover;
  /** Wpis blokady w pliku i czekanie, aż driver go przetworzy (zdarzenie dla managera wyszło). */
  const block = async (fx: Fixture, prompt: string): Promise<void> => {
    const before = blocked(fx.events).length;
    await appendFile(fx.transcript, blockedLine(prompt));
    await waitFor(() => blocked(fx.events).length > before, 'blokada w driverze');
  };
  /** `prompt` atrapy z własnym zachowaniem — wpis do `calls` jak w oryginale. */
  const onPrompt = (fx: Fixture, act: (n: number, text: string) => Promise<void>): void => {
    let n = 0;
    fx.client.prompt = async (paneId, text, wait) => {
      fx.client.calls.push({ method: 'prompt', paneId, text, ...(wait === undefined ? {} : { wait }) });
      n += 1;
      await act(n, text);
    };
  };
  /** Ekran z promptem oddanym do pola; para Esc go czyści. */
  const heldInField = (fx: Fixture, text: string): void => {
    fx.client.screenText = `❯ ${text}`;
    const raw = fx.client.sendKeys;
    fx.client.sendKeys = (paneId, keys) => {
      if (keys.length === 2) fx.client.screenText = '❯';
      return raw(paneId, keys);
    };
  };
  /** Następna wysyłka czyści pole parą Esc (`#needsEscape` po blokadzie), potem pisze. */
  const nextSendClearsField = async (fx: Fixture): Promise<void> => {
    const before = escs(fx).length;
    const sent = prompts(fx).length;
    fx.client.prompt = FakeClient.prototype.prompt.bind(fx.client);
    fx.driver.send('następna wiadomość');
    await waitFor(() => prompts(fx).length === sent + 1, 'następna wysyłka');
    expect(escs(fx).slice(before)).toEqual([['escape', 'escape']]);
    expect(fx.client.screenText).toBe('❯');
  };

  it('blokada przed werdyktem stall-guardu → zero `escape`, jeden `prompt`, bez „prompt utknął”', async () => {
    const marked: string[] = [];
    const fx = await makeDriver({ deps: { stallSettleMs: 5, markSent: (key) => marked.push(key) } });
    heldInField(fx, 'zablokowany prompt');
    onPrompt(fx, async (n, text) => {
      if (n === 1) {
        await block(fx, text);
        throw stalled();
      }
    });
    fx.driver.send('zablokowany prompt');
    await waitFor(() => blocked(fx.events).length === 1, 'blokada');
    await quiet();

    expect(prompts(fx)).toHaveLength(1);
    expect(escs(fx)).toEqual([]);
    expect(systemTexts(fx.events)).not.toContain(STALLED_PROMPT_MESSAGE.text);
    // Tury nie ma: bez karencji `idle` w nadzorcy.
    expect(marked).toEqual([]);
    expect(blocked(fx.events)[0]).toMatchObject({ echoed: true, decided: true, key: 'zablokowany prompt' });
    expect(leftover(fx)).toBe(true);
    // Pole trzyma prompt (CLI włożył go z powrotem): następna wysyłka czyści je parą Esc.
    await nextSendClearsField(fx);
  });

  it('blokada w trakcie przerwy stall-guardu (po `wait`, przed znakami życia) → bez Esc i bez drugiego `prompt`', async () => {
    const fx = await makeDriver({ deps: { stallSettleMs: 150 } });
    heldInField(fx, 'w przerwie');
    fx.client.promptErrors.push(stalled());
    fx.driver.send('w przerwie');
    await waitFor(() => prompts(fx).length === 1, 'prompt');
    await block(fx, 'w przerwie');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(prompts(fx)).toHaveLength(1);
    expect(escs(fx)).toEqual([]);
    expect(systemTexts(fx.events)).not.toContain(STALLED_PROMPT_MESSAGE.text);
  });

  it('blokada w trakcie odczytu ekranu stall-guardu → ekran z promptem nie daje ponowienia', async () => {
    const fx = await makeDriver({ deps: { stallSettleMs: 5 } });
    heldInField(fx, 'przy odczycie');
    fx.client.promptErrors.push(stalled());
    const read = fx.client.readScreen.bind(fx.client);
    fx.client.readScreen = async (paneId, source, format) => {
      if (source === 'detection' && prompts(fx).length === 1 && blocked(fx.events).length === 0) {
        await block(fx, 'przy odczycie');
      }
      return read(paneId, source, format);
    };
    fx.driver.send('przy odczycie');
    await waitFor(() => blocked(fx.events).length === 1, 'blokada');
    await quiet();
    expect(prompts(fx)).toHaveLength(1);
    expect(escs(fx)).toEqual([]);
  });

  it('blokada w trakcie odczytu pola przed parą Esc → zero klawiszy', async () => {
    const fx = await makeDriver({ deps: { stallSettleMs: 5 } });
    heldInField(fx, 'przed parą');
    fx.client.promptErrors.push(stalled());
    const read = fx.client.readScreen.bind(fx.client);
    fx.client.readScreen = async (paneId, source, format) => {
      if (source === 'visible' && blocked(fx.events).length === 0) await block(fx, 'przed parą');
      return read(paneId, source, format);
    };
    fx.driver.send('przed parą');
    await waitFor(() => blocked(fx.events).length === 1, 'blokada');
    await quiet();
    expect(prompts(fx)).toHaveLength(1);
    expect(escs(fx)).toEqual([]);
  });

  it('blokada po parze Esc (późny wpis) → drugi `prompt` nie idzie', async () => {
    const fx = await makeDriver({ deps: { stallSettleMs: 5 } });
    fx.client.screenText = '❯ późny wpis';
    fx.client.promptErrors.push(stalled());
    const raw = fx.client.sendKeys;
    fx.client.sendKeys = async (paneId, keys) => {
      await raw(paneId, keys);
      if (keys.length === 2) {
        fx.client.screenText = '❯';
        await block(fx, 'późny wpis');
      }
    };
    fx.driver.send('późny wpis');
    await waitFor(() => blocked(fx.events).length === 1, 'blokada');
    await quiet();
    expect(escs(fx)).toEqual([['escape', 'escape']]);
    expect(prompts(fx)).toHaveLength(1);
    expect(systemTexts(fx.events)).not.toContain(STALLED_PROMPT_MESSAGE.text);
  });

  it('`wait` zakończony `ok`, blokada przed końcem zadania → bez watchdoga, `#needsEscape` zostaje', async () => {
    const marked: string[] = [];
    const fx = await makeDriver({ deps: { turnWatchdogMs: TEST_WATCHDOG_MS, markSent: (key) => marked.push(key) } });
    heldInField(fx, 'herdr mignął');
    onPrompt(fx, async (n, text) => {
      if (n === 1) await block(fx, text);
    });
    fx.driver.send('herdr mignął');
    await waitFor(() => blocked(fx.events).length === 1, 'blokada');
    await quiet();
    expect(systemTexts(fx.events)).not.toContain(STALLED_PROMPT_MESSAGE.text);
    expect(marked).toEqual([]);
    expect(leftover(fx)).toBe(true);
    await nextSendClearsField(fx);
  });

  it('skill (slash bez `wait`) zablokowany w trakcie wysyłki → bez watchdoga; puste pole = zero klawiszy potem', async () => {
    const WATCHDOG_MS = 120;
    const fired: number[] = [];
    const scheduler: Scheduler = {
      setTimeout: (fn, ms) => setTimeout(() => { fired.push(ms); fn(); }, ms),
      clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
      now: () => Date.now(),
    };
    const fx = await makeDriver({ deps: { turnWatchdogMs: WATCHDOG_MS, scheduler } });
    const skill = '/code-review:code-review RAROG-BLOCK';
    onPrompt(fx, async (n, text) => {
      if (n === 1) await block(fx, text);
    });
    fx.driver.send(skill, undefined, undefined, commandOpts(skill, PLUGIN_CATALOG));
    await waitFor(() => blocked(fx.events).length === 1, 'blokada');
    expect(blocked(fx.events)[0]).toMatchObject({ echoed: true, decided: true });
    expect('wait' in (prompts(fx)[0] ?? {})).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, WATCHDOG_MS + 60));
    expect(fired).not.toContain(WATCHDOG_MS);

    // Slash-komenda zostawia pole puste: `#needsEscape` czyta pole i nie wysyła ani jednego klawisza.
    fx.client.screenText = '❯';
    fx.client.prompt = FakeClient.prototype.prompt.bind(fx.client);
    fx.driver.send('następna wiadomość');
    await waitFor(() => prompts(fx).length === 2, 'następna wysyłka');
    expect(escs(fx)).toEqual([]);
  });

  it('blokada PO uzbrojeniu watchdoga gasi watchdog tej wysyłki; pole czyści następna wysyłka', async () => {
    const WATCHDOG_MS = 120;
    const fired: number[] = [];
    const scheduler: Scheduler = {
      setTimeout: (fn, ms) => setTimeout(() => { fired.push(ms); fn(); }, ms),
      clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
      now: () => Date.now(),
    };
    const marked: string[] = [];
    const fx = await makeDriver({
      deps: { turnWatchdogMs: WATCHDOG_MS, scheduler, markSent: (key) => marked.push(key) },
    });
    heldInField(fx, 'po uzbrojeniu');
    fx.driver.send('po uzbrojeniu');
    await waitFor(() => marked.length === 1, 'wysyłka z watchdogiem');
    await block(fx, 'po uzbrojeniu');
    await new Promise((resolve) => setTimeout(resolve, WATCHDOG_MS + 60));
    expect(fired).not.toContain(WATCHDOG_MS);
    expect(systemTexts(fx.events)).not.toContain(STALLED_PROMPT_MESSAGE.text);
    expect(leftover(fx)).toBe(true);
    await nextSendClearsField(fx);
  });

  it('blokada STARSZEJ wysyłki, gdy nowsza weszła do panelu → sama notka, watchdog nowszej zostaje', async () => {
    const WATCHDOG_MS = 120;
    const fired: number[] = [];
    const scheduler: Scheduler = {
      setTimeout: (fn, ms) => setTimeout(() => { fired.push(ms); fn(); }, ms),
      clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
      now: () => Date.now(),
    };
    const marked: string[] = [];
    const fx = await makeDriver({
      deps: { turnWatchdogMs: WATCHDOG_MS, scheduler, markSent: (key) => marked.push(key) },
    });
    fx.driver.send('starsza');
    await waitFor(() => marked.length === 1, 'starsza');
    fx.driver.send('nowsza');
    await waitFor(() => marked.length === 2, 'nowsza');
    await block(fx, 'starsza');
    expect(blocked(fx.events)[0]).toMatchObject({ echoed: true, decided: false, key: 'starsza' });
    expect(leftover(fx)).toBe(false);
    await waitFor(() => fired.includes(WATCHDOG_MS), 'watchdog nowszej wysyłki odpalił');
  });

  /*
   * Para klucz echa → numer wysyłki zostawała po wysyłce, która DOSZŁA (echo zużył
   * zwykły wpis `user`), więc blokada identycznego tekstu wskazywała starszą wysyłkę. „tak”, „dalej”, „ok”.
   */
  it('identyczny tekst: pierwszy doszedł, drugi zablokowany → blokada rozstrzyga DRUGĄ wysyłkę', async () => {
    const marked: string[] = [];
    const fx = await makeDriver({ deps: { stallSettleMs: 5, markSent: (key) => marked.push(key) } });
    fx.driver.send('tak');
    await waitFor(() => marked.length === 1, 'pierwsza wysyłka');
    await appendFile(fx.transcript, userLine('tak'));
    await waitFor(() => fx.events.some((e) => e.type === 'turn-input'), 'echo pierwszej zużyte');

    heldInField(fx, 'tak');
    onPrompt(fx, async (n, text) => {
      if (n === 1) {
        await block(fx, text);
        throw stalled();
      }
    });
    fx.driver.send('tak');
    await waitFor(() => blocked(fx.events).length === 1, 'blokada drugiej');
    await quiet();
    expect(blocked(fx.events)[0]).toMatchObject({ echoed: true, decided: true });
    expect(escs(fx)).toEqual([]);
    expect(leftover(fx)).toBe(true);
  });

  // Strażnik kolejności w `#sendTask`: sprawdzenie `#needsEscape` stoi ZA bramkami (dialog zgody, formularz, rejestr).
  it('blokada poprzedniej wysyłki w trakcie bramek następnej → pole czyszczone przed pisaniem', async () => {
    const marked: string[] = [];
    const fx = await makeDriver({ deps: { markSent: (key) => marked.push(key) } });
    fx.driver.send('poprzednia');
    await waitFor(() => marked.length === 1, 'poprzednia wysłana (`wait` ok)');
    heldInField(fx, 'poprzednia');
    const read = fx.client.readScreen.bind(fx.client);
    let first = true;
    fx.client.readScreen = async (paneId, source, format) => {
      // Pierwszy odczyt zadania następnej wysyłki (bramka dialogu zgody): wtedy przychodzi blokada poprzedniej.
      if (first && source === 'detection') {
        first = false;
        await block(fx, 'poprzednia');
      }
      return read(paneId, source, format);
    };
    fx.driver.send('następna');
    await waitFor(() => prompts(fx).length === 2, 'następna wysyłka');
    expect(blocked(fx.events)[0]).toMatchObject({ decided: true });
    expect(escs(fx)).toEqual([['escape', 'escape']]);
    expect(fx.client.calls.findIndex((c) => c.method === 'send_keys'))
      .toBeLessThan(fx.client.calls.findLastIndex((c) => c.method === 'prompt'));
  });

  it('pierwszy prompt świeżej sesji: wpis blokady zakłada plik i przychodzi kanałem historii', async () => {
    const fx = await makeDriver({ noTranscript: true, deps: { stallSettleMs: 5 } });
    heldInField(fx, 'pierwszy prompt');
    onPrompt(fx, async (n, text) => {
      if (n !== 1) return;
      const tmp = `${fx.transcript}.partial`;
      await writeFile(tmp, blockedLine(text));
      await rename(tmp, fx.transcript);
      await waitFor(() => blocked(fx.events).length === 1, 'blokada z historii');
      throw stalled();
    });
    fx.driver.send('pierwszy prompt');
    await waitFor(() => blocked(fx.events).length === 1, 'blokada');
    await quiet();
    expect(blocked(fx.events)[0]).toMatchObject({ echoed: true, decided: true });
    expect(prompts(fx)).toHaveLength(1);
    expect(escs(fx)).toEqual([]);
    expect(systemTexts(fx.events)).not.toContain(STALLED_PROMPT_MESSAGE.text);
  });

  it('`working` zaraz po blokadzie nie gasi zgody na czyszczenie pola; gaszą ją wpis `user`, Esc i nowa rozmowa', async () => {
    const fx = await makeDriver({ deps: { stallSettleMs: 5, interruptProbeDelaysMs: [] } });
    const blockOnce = async (text: string): Promise<void> => {
      onPrompt(fx, async (n) => {
        if (n === 1) {
          await block(fx, text);
          throw stalled();
        }
      });
      fx.driver.send(text);
      await waitFor(() => blocked(fx.events).some((e) => e.key === text), `blokada: ${text}`);
      await quiet();
      expect(leftover(fx)).toBe(true);
    };

    await blockOnce('pierwsza');
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 8, title: 'refaktor' });
    fx.emit({ type: 'status', status: 'done', stateChangeSeq: 9, title: 'refaktor' });
    await quiet();
    expect(leftover(fx)).toBe(true);
    await appendFile(fx.transcript, userLine('wysłane przy Macu'));
    await waitFor(() => !leftover(fx), 'wpis `user` z pliku');

    await blockOnce('druga');
    void fx.driver.interrupt();
    expect(leftover(fx)).toBe(false);

    await blockOnce('trzecia');
    fx.emit({ type: 'session-changed', agentSessionId: SESSION_B });
    expect(leftover(fx)).toBe(false);
  });

  /*
   * Czyszczenie pola z NASZYM zablokowanym promptem przed restartem. Zadanie w kolejce wysyłek samo
   * czyta świeży status i rozmowę: Esc w turze by ją przerwał, a para Esc na pustym polu otwiera rewind.
   */
  describe('czyszczenie pola przed restartem', () => {
    const RULE = '─'.repeat(40);
    const fieldWith = (text: string): string => `${RULE}\n❯ ${text}\n${RULE}`;
    const EMPTY = `${RULE}\n❯\n${RULE}`;
    const agentIs = (fx: Fixture, status: string, agentSessionId = SESSION): void => {
      fx.client.getAgent = (): Promise<HerdrAgentInfo> =>
        Promise.resolve({ status, agentSessionId } as HerdrAgentInfo);
    };
    /** Wysyłka zablokowana przez hook: zgoda drivera ustawiona, pole trzyma prompt; para Esc je czyści. */
    const blockedInField = async (fx: Fixture, text: string): Promise<void> => {
      fx.client.screenText = fieldWith(text);
      const raw = fx.client.sendKeys;
      fx.client.sendKeys = (paneId, keys) => {
        if (keys.length === 2) fx.client.screenText = EMPTY;
        return raw(paneId, keys);
      };
      onPrompt(fx, async (n, sent) => {
        if (n === 1) {
          await block(fx, sent);
          throw stalled();
        }
      });
      fx.driver.send(text);
      await waitFor(() => blocked(fx.events).length === 1, 'blokada');
      await quiet();
      expect(leftover(fx)).toBe(true);
    };

    it('zgoda + `idle` tej rozmowy → jedna para Esc, pole puste w CAŁYM obszarze, zgoda zużyta', async () => {
      const fx = await makeDriver({ deps: { stallSettleMs: 5 } });
      await blockedInField(fx, 'Dopisz testy');
      agentIs(fx, 'idle');
      await expect(fx.driver.clearBlockedLeftover?.(SESSION)).resolves.toBe('empty');
      expect(escs(fx)).toEqual([['escape', 'escape']]);
      expect(fx.audit.filter((e) => e.method === 'send_keys').map((e) => e.keys)).toEqual([['escape', 'escape']]);
      expect(leftover(fx)).toBe(false);
      // Drugie wywołanie: zgody już nie ma — zero odczytów statusu i zero klawiszy.
      await expect(fx.driver.clearBlockedLeftover?.(SESSION)).resolves.toBe('stale');
      expect(escs(fx)).toHaveLength(1);
    });

    it('świeży status `working` albo inna rozmowa → zero klawiszy, zgoda zostaje', async () => {
      const fx = await makeDriver({ deps: { stallSettleMs: 5 } });
      await blockedInField(fx, 'w turze');
      agentIs(fx, 'working');
      await expect(fx.driver.clearBlockedLeftover?.(SESSION)).resolves.toBe('busy');
      agentIs(fx, 'idle', SESSION_B);
      await expect(fx.driver.clearBlockedLeftover?.(SESSION)).resolves.toBe('changed');
      fx.client.getAgent = (): Promise<HerdrAgentInfo> => Promise.reject(new Error('gniazdo'));
      await expect(fx.driver.clearBlockedLeftover?.(SESSION)).resolves.toBe('changed');
      expect(escs(fx)).toEqual([]);
      expect(leftover(fx)).toBe(true);
    });

    it('bez zgody (prompt doszedł, pole trzyma szkic człowieka) → `stale`, zero klawiszy', async () => {
      const fx = await makeDriver({ deps: { stallSettleMs: 5 } });
      fx.client.screenText = fieldWith('szkic przy Macu');
      agentIs(fx, 'idle');
      await expect(fx.driver.clearBlockedLeftover?.(SESSION)).resolves.toBe('stale');
      expect(escs(fx)).toEqual([]);
    });

    it('wpis `user` z pliku w trakcie odczytu pola (prompt wysłany przy Macu) → bez pary Esc', async () => {
      const fx = await makeDriver({ deps: { stallSettleMs: 5 } });
      await blockedInField(fx, 'przy Macu');
      agentIs(fx, 'idle');
      const read = fx.client.readScreen.bind(fx.client);
      let first = true;
      fx.client.readScreen = async (paneId, source, format) => {
        if (first && source === 'visible') {
          first = false;
          await appendFile(fx.transcript, userLine('wysłane przy Macu'));
          await waitFor(() => !leftover(fx), 'wpis `user` gasi zgodę');
        }
        return read(paneId, source, format);
      };
      await expect(fx.driver.clearBlockedLeftover?.(SESSION)).resolves.toBe('stale');
      expect(escs(fx)).toEqual([]);
    });

    // Człowiek przy Macu wysłał prompt z pola, a plik tego jeszcze nie pokazał.
    it('herdr zgłasza turę w trakcie odczytu pola → `busy`, ani jednej pary Esc', async () => {
      const fx = await makeDriver({ deps: { stallSettleMs: 5 } });
      await blockedInField(fx, 'wysłany przy Macu');
      agentIs(fx, 'idle');
      const read = fx.client.readScreen.bind(fx.client);
      let first = true;
      fx.client.readScreen = async (paneId, source, format) => {
        if (first && source === 'visible') {
          first = false;
          fx.emit({ type: 'status', status: 'working', stateChangeSeq: 20, title: 'praca' });
          await quiet();
        }
        return read(paneId, source, format);
      };
      await expect(fx.driver.clearBlockedLeftover?.(SESSION)).resolves.toBe('busy');
      expect(escs(fx)).toEqual([]);
    });

    it('herdr zgłasza turę po parze Esc → `busy` zamiast `empty` (`/exit` nie pójdzie w turę)', async () => {
      const fx = await makeDriver({ deps: { stallSettleMs: 5, escSettleMs: 1 } });
      await blockedInField(fx, 'tura po parze');
      agentIs(fx, 'idle');
      const keys = fx.client.sendKeys;
      fx.client.sendKeys = async (paneId, sent) => {
        await keys(paneId, sent);
        fx.emit({ type: 'status', status: 'working', stateChangeSeq: 21, title: 'praca' });
      };
      await expect(fx.driver.clearBlockedLeftover?.(SESSION)).resolves.toBe('busy');
      expect(escs(fx)).toEqual([['escape', 'escape']]);
      expect(leftover(fx)).toBe(false);
    });

    it('blokada promptu spoza Raroga po naszej → zgoda przepada, pole z tekstem z Maca zostaje', async () => {
      const fx = await makeDriver({ deps: { stallSettleMs: 5 } });
      await blockedInField(fx, 'z Raroga');
      // Człowiek przy Macu zmienia pole na swój prompt i wysyła; hook blokuje i ten (bez echa Raroga).
      fx.client.screenText = fieldWith('wpisane przy Macu');
      await block(fx, 'wpisane przy Macu');
      expect(blocked(fx.events).at(-1)).toMatchObject({ echoed: false, decided: false });
      expect(leftover(fx)).toBe(false);
      agentIs(fx, 'idle');
      await expect(fx.driver.clearBlockedLeftover?.(SESSION)).resolves.toBe('stale');
      expect(escs(fx)).toEqual([]);
    });

    it('pole się nie czyści (trzy pary) → `filled`, zgoda i tak zużyta', async () => {
      const fx = await makeDriver({ deps: { stallSettleMs: 5, escSettleMs: 1 } });
      await blockedInField(fx, 'uparte pole');
      fx.client.sendKeys = (paneId, keys) => {
        fx.client.calls.push({ method: 'send_keys', paneId, keys });
        return Promise.resolve();
      };
      agentIs(fx, 'done');
      await expect(fx.driver.clearBlockedLeftover?.(SESSION)).resolves.toBe('filled');
      expect(escs(fx)).toHaveLength(3);
      expect(leftover(fx)).toBe(false);
    });

    it('`RAROG_PROMPT_BLOCK=0` (`promptBlock: false`): czyszczenia nie ma — `stale`, zero odczytów', async () => {
      const fx = await makeDriver({ deps: { promptBlock: false } });
      fx.client.screenText = fieldWith('cokolwiek');
      let asked = 0;
      fx.client.getAgent = (): Promise<HerdrAgentInfo> => {
        asked += 1;
        return Promise.resolve({ status: 'idle', agentSessionId: SESSION } as HerdrAgentInfo);
      };
      await expect(fx.driver.clearBlockedLeftover?.(SESSION)).resolves.toBe('stale');
      expect(asked).toBe(0);
      expect(escs(fx)).toEqual([]);
    });
  });

  it('`RAROG_PROMPT_BLOCK=0` (`promptBlock: false`): stall path — Esc, a second `prompt`, "prompt stuck"', async () => {
    const fx = await makeDriver({ deps: { stallSettleMs: 5, promptBlock: false } });
    fx.client.screenText = '❯ wyłączone';
    onPrompt(fx, async (_n, text) => {
      await appendFile(fx.transcript, blockedLine(text));
      throw stalled();
    });
    fx.driver.send('wyłączone');
    await waitFor(() => systemTexts(fx.events).includes(STALLED_PROMPT_MESSAGE.text), '„prompt utknął”');
    expect(prompts(fx)).toHaveLength(2);
    expect(escs(fx).length).toBeGreaterThan(0);
    expect(blocked(fx.events)).toEqual([]);
    expect(leftover(fx)).toBe(false);
  });
});
