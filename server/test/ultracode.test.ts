/**
 * Czytnik śladu ultracode w pliku rozmowy (`herdr/ultracode.ts`) na wycinkach z pomiaru CLI 2.1.318
 * (`fixtures/herdr/ultracode/*.jsonl`) i na wpisach syntetycznych dla przypadków, których pomiar nie dał.
 *
 * Wycinki mówią, CO jest znacznikiem: załącznik `ultra_effort_enter|exit` na początku pierwszej tury po geście
 * i wynik komendy w bezczynności. Argumenty komendy, wynik `/effort status` (z dopiskiem „· Ultracode on”), odmowa
 * przy wyłączonych workflow i treść skilla znacznikiem nie są.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createUltracodeTracker, parseJsonlEntry } from '../src/herdr/jsonl-pending.ts';
import type { UltracodeTracker } from '../src/herdr/jsonl-pending.ts';
import { ultracodeMarkerOf, ultracodeResultOf } from '../src/herdr/ultracode.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr', 'ultracode');

/** Znaczniki pliku w kolejności: numer linii (od 1), wartość i czas wpisu. */
function markersOf(name: string): { line: number; value: boolean; at: number | null }[] {
  return readFileSync(join(DIR, name), 'utf8').split('\n').flatMap((text, i) => {
    const marker = ultracodeMarkerOf(parseJsonlEntry(text));
    return marker === null ? [] : [{ line: i + 1, ...marker }];
  });
}

const at = (iso: string): number => Date.parse(iso);

describe('znaczniki ultracode na wycinkach z pomiaru 2.1.318', () => {
  it('start z flagą: tylko `ultra_effort_enter` pierwszej tury; anulowany suwak i `/effort status` nic nie dają', () => {
    expect(markersOf('start-flaga.jsonl')).toEqual([{ line: 22, value: true, at: at('2026-01-01T00:00:29.103Z') }]);
  });

  it('pierwsza tura ze skillem `workflow-authoring`: wpisy skilla (`isMeta`) nie są znacznikiem', () => {
    expect(markersOf('pierwsza-tura-skill.jsonl'))
      .toEqual([{ line: 22, value: true, at: at('2026-01-01T00:00:29.103Z') }]);
  });

  it('komendy w bezczynności: wynik komendy od razu, załącznik dopiero w pierwszej turze po niej', () => {
    expect(markersOf('komendy-w-bezczynnosci.jsonl')).toEqual([
      { line: 5, value: false, at: at('2026-01-01T00:00:34.696Z') },
      { line: 8, value: false, at: at('2026-01-01T00:00:38.533Z') },
      { line: 31, value: true, at: at('2026-01-01T00:00:44.000Z') },
      { line: 34, value: true, at: at('2026-01-01T00:00:47.817Z') },
    ]);
  });

  it('komendy w trakcie tury: bez wpisu, znacznik dopiero z załącznika następnej tury', () => {
    expect(markersOf('off-w-turze.jsonl')).toEqual([
      { line: 10, value: false, at: at('2026-01-01T00:01:06.957Z') },
      { line: 25, value: true, at: at('2026-01-01T00:01:26.080Z') },
    ]);
  });

  it('nowa rozmowa po `/clear`: pierwsza tura znowu z `ultra_effort_enter`; dopisek w `/effort status` nic nie daje', () => {
    expect(markersOf('clear.jsonl')).toEqual([{ line: 21, value: true, at: at('2026-01-01T00:00:04.580Z') }]);
  });

  it('przy wyłączonych workflow odmowa komendy („Ultracode needs …”) nie jest znacznikiem', () => {
    expect(markersOf('niedostepne.jsonl')).toEqual([]);
  });

  it('wznowienie z flagą: brak znacznika; wznowienie bez flagi: `ultra_effort_exit` w pierwszej turze', () => {
    expect(markersOf('wznowienie-z-flaga.jsonl')).toEqual([]);
    expect(markersOf('wznowienie-bez-flagi.jsonl'))
      .toEqual([{ line: 15, value: false, at: at('2026-01-01T00:02:39.612Z') }]);
  });
});

describe('znaczniki ultracode: wpisy syntetyczne', () => {
  const T = '2026-01-01T00:00:10.000Z';
  const attachment = (type: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'attachment', isSidechain: false, timestamp: T, attachment: { type, ...extra },
  });
  const user = (content: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'user', isSidechain: false, timestamp: T, message: { role: 'user', content }, ...extra,
  });
  const stdout = (text: string): string => `<local-command-stdout>${text}</local-command-stdout>`;

  it('załącznik: każdy `reminderType` włącza, `exit` wyłącza, inny typ i subagent nic nie dają', () => {
    expect(ultracodeMarkerOf(attachment('ultra_effort_enter', { reminderType: 'sparse' })))
      .toEqual({ value: true, at: at(T) });
    expect(ultracodeMarkerOf(attachment('ultra_effort_exit'))).toEqual({ value: false, at: at(T) });
    expect(ultracodeMarkerOf(attachment('auto_mode'))).toBeNull();
    expect(ultracodeMarkerOf({ ...attachment('ultra_effort_enter'), isSidechain: true })).toBeNull();
  });

  it('czas: brak albo nieczytelny `timestamp` daje `at: null`, wartość zostaje', () => {
    const { timestamp: _t, ...bare } = attachment('ultra_effort_exit');
    expect(ultracodeMarkerOf(bare)).toEqual({ value: false, at: null });
    expect(ultracodeMarkerOf({ ...attachment('ultra_effort_enter'), timestamp: 'wczoraj' }))
      .toEqual({ value: true, at: null });
  });

  it('wynik komendy: napis albo bloki tekstu, z sekwencjami terminala; zdanie po prefiksie bez znaczenia', () => {
    expect(ultracodeMarkerOf(user(stdout('Ultracode off.')))).toEqual({ value: false, at: at(T) });
    expect(ultracodeMarkerOf(user([{ type: 'text', text: stdout('Ultracode on (this session only).') }])))
      .toEqual({ value: true, at: at(T) });
    expect(ultracodeMarkerOf(user(stdout('\u001b[1mUltracode on\u001b[22m: inne zdanie'))))
      .toEqual({ value: true, at: at(T) });
  });

  it('nie jest znacznikiem: argumenty komendy, inny wynik, słowo dłuższe niż prefiks, tekst przed znacznikiem', () => {
    const args = '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n'
      + '<command-args>ultracode off</command-args>';
    for (const content of [
      args,
      stdout('Cancelled'),
      stdout('Current effort level: xhigh · Ultracode on'),
      stdout('Ultracode needs dynamic workflows enabled (see /config).'),
      stdout('Ultracode one more time'),
      `uwaga: ${stdout('Ultracode on')}`,
      [{ type: 'image', source: {} }],
    ]) {
      expect(ultracodeMarkerOf(user(content)), JSON.stringify(content)).toBeNull();
    }
  });

  it('nie jest znacznikiem: prompt człowieka (`origin`), wpis `isMeta`, subagent, odpowiedź modelu, śmieci', () => {
    expect(ultracodeMarkerOf(user(stdout('Ultracode on'), { origin: { kind: 'human' } }))).toBeNull();
    expect(ultracodeMarkerOf(user(stdout('Ultracode on'), { isMeta: true }))).toBeNull();
    expect(ultracodeMarkerOf(user(stdout('Ultracode on'), { isSidechain: true }))).toBeNull();
    expect(ultracodeMarkerOf({ type: 'assistant', message: { content: stdout('Ultracode on') } })).toBeNull();
    for (const junk of [null, 'tekst', 42, [], { _pomiar: 'znacznik' }]) expect(ultracodeMarkerOf(junk)).toBeNull();
  });
});

describe('tekst wyniku komendy ultracode (`ultracodeResultOf`, plik rozmowy i ekran)', () => {
  it('wynik włączenia i wyłączenia daje stan, odmowa przy wyłączonych workflow — `refused`', () => {
    expect(ultracodeResultOf('Ultracode on (this session only): dynamic workflows on every task.')).toBe(true);
    expect(ultracodeResultOf('  Ultracode off. Effort stays xhigh.')).toBe(false);
    expect(ultracodeResultOf('\u001b[2mUltracode off\u001b[22m')).toBe(false);
    expect(ultracodeResultOf('Ultracode needs dynamic workflows enabled (see /config). Valid options are: low'))
      .toBe('refused');
  });

  it('inny tekst to `null`: status effortu, dłuższe słowo, tekst przed wynikiem, pusty', () => {
    for (const text of [
      'Current effort level: xhigh · Ultracode on', 'Ultracode one more time', 'Ultracode needs', 'Set effort level to',
      'uwaga: Ultracode on', '',
    ]) {
      expect(ultracodeResultOf(text), text).toBeNull();
    }
  });
});

/** Wpisy wycinka w kolejności pliku (sparsowane, z numerem linii od 1). */
function entriesOf(name: string): { line: number; entry: unknown }[] {
  return readFileSync(join(DIR, name), 'utf8').split('\n')
    .map((text, i) => ({ line: i + 1, entry: parseJsonlEntry(text) }))
    .filter(({ entry }) => entry !== null);
}

/** Karmi tracker wpisami i oddaje każdą zmianę wartości: linię i nową wartość. */
function feed(
  tracker: UltracodeTracker, entries: readonly { line: number; entry: unknown }[],
): { line: number; value: boolean | undefined }[] {
  const changes: { line: number; value: boolean | undefined }[] = [];
  for (const { line, entry } of entries) if (tracker.note(entry)) changes.push({ line, value: tracker.value });
  return changes;
}

/** Start procesu CLI w wycinkach z pomiaru: pierwszy wpis rozmowy (`timestamp` po anonimizacji). */
const PROCESS_START = at('2026-01-01T00:00:00.000Z');

describe('stan ultracode bieżącego procesu CLI (`createUltracodeTracker`)', () => {
  it('bez startu procesu i bez żądania żaden znacznik się nie liczy (nie wiemy, którego procesu dotyczy)', () => {
    const tracker = createUltracodeTracker();
    expect(feed(tracker, entriesOf('komendy-w-bezczynnosci.jsonl'))).toEqual([]);
    expect(tracker.value).toBeUndefined();
  });

  it('start z flagą: dowód dopiero z załącznika pierwszej tury, kolejne tury bez załącznika nic nie zmieniają', () => {
    const tracker = createUltracodeTracker();
    tracker.processStarted(PROCESS_START);
    expect(feed(tracker, entriesOf('start-flaga.jsonl'))).toEqual([{ line: 22, value: true }]);
    expect(tracker.value).toBe(true);
  });

  it('komendy w bezczynności: wynik komendy od razu, ostatni znacznik wygrywa', () => {
    const tracker = createUltracodeTracker();
    tracker.processStarted(PROCESS_START);
    expect(feed(tracker, entriesOf('komendy-w-bezczynnosci.jsonl'))).toEqual([
      { line: 5, value: false },
      { line: 31, value: true },
    ]);
  });

  it('`off` w trakcie tury: stan zmienia dopiero załącznik następnej tury', () => {
    const tracker = createUltracodeTracker();
    tracker.processStarted(PROCESS_START);
    expect(feed(tracker, entriesOf('off-w-turze.jsonl'))).toEqual([
      { line: 10, value: false },
      { line: 25, value: true },
    ]);
  });

  it('znacznik sprzed startu procesu nie liczy się; start podany później przelicza stan', () => {
    const tracker = createUltracodeTracker();
    tracker.processStarted(at('2026-01-01T00:00:30.000Z'));
    expect(feed(tracker, entriesOf('start-flaga.jsonl'))).toEqual([]);
    expect(tracker.value).toBeUndefined();
    // Rejestr podał wcześniejszy start (ten sam proces po restarcie Raroga): załącznik znowu jest dowodem.
    expect(tracker.processStarted(PROCESS_START)).toBe(true);
    expect(tracker.value).toBe(true);
    expect(tracker.processStarted(PROCESS_START)).toBe(false);
  });

  it('bez startu procesu odcięciem jest chwila żądania Raroga', () => {
    const tracker = createUltracodeTracker();
    tracker.requested(at('2026-01-01T00:00:43.000Z'));
    // Wynik `off` (34.696) i załącznik `exit` (38.533) są starsze od żądania; `on` (44.000) już nie.
    expect(feed(tracker, entriesOf('komendy-w-bezczynnosci.jsonl'))).toEqual([{ line: 31, value: true }]);
  });

  it('reguła pierwszej tury: odpowiedź bez załącznika po żądanym włączeniu = CLI ultracode nie włączyło', () => {
    // Start z flagą, którego CLI nie przyjęło (wyłączone workflow): ta sama tura bez `ultra_effort_enter`.
    const entries = entriesOf('start-flaga.jsonl').filter(({ line }) => line !== 22);
    const tracker = createUltracodeTracker();
    tracker.requested(at('2026-01-01T00:00:20.000Z'));
    tracker.processStarted(PROCESS_START);
    // Komendy lokalne (`<command-name>/effort`, wynik `/effort status`) przed turą nie są promptem człowieka;
    // decyduje pierwsza odpowiedź modelu (linia 33) po prompcie z linii 15, i tylko ona.
    expect(feed(tracker, entries)).toEqual([{ line: 33, value: false }]);
  });

  it('wznowienie z flagą (`--resume … --effort ultracode`): pierwsza tura bez załącznika, reguła dałaby `false`', () => {
    // CLI włączyło ultracode („… · Ultracode on” w linii 5), ale załącznik stoi już w historii rozmowy, więc tura
    // z linii 7 go nie ma. Serwer nie uzbraja reguły pierwszej tury przy wznowieniu (manager).
    const tracker = createUltracodeTracker();
    tracker.processStarted(at('2026-01-01T00:02:09.000Z'));
    expect(feed(tracker, entriesOf('wznowienie-z-flaga.jsonl'))).toEqual([]);
    expect(tracker.value).toBeUndefined();
    const armed = createUltracodeTracker();
    armed.processStarted(at('2026-01-01T00:02:09.000Z'));
    armed.requested(at('2026-01-01T00:02:09.000Z'));
    expect(feed(armed, entriesOf('wznowienie-z-flaga.jsonl'))).toEqual([{ line: 11, value: false }]);
    // Żądanie bez reguły (`firstTurn: false`) zostawia samo odcięcie po czasie.
    const resumed = createUltracodeTracker();
    resumed.requested(at('2026-01-01T00:02:09.000Z'), false);
    expect(feed(resumed, entriesOf('wznowienie-z-flaga.jsonl'))).toEqual([]);
    expect(resumed.value).toBeUndefined();
  });

  it('żądanie bez reguły pierwszej tury dalej jest odcięciem historii bez startu procesu', () => {
    const tracker = createUltracodeTracker();
    tracker.requested(at('2026-01-01T00:00:43.000Z'), false);
    expect(feed(tracker, entriesOf('komendy-w-bezczynnosci.jsonl'))).toEqual([{ line: 31, value: true }]);
  });

  it('wznowienie bez flagi po procesie z ultracode: pierwsza tura ma `ultra_effort_exit`', () => {
    const tracker = createUltracodeTracker();
    tracker.processStarted(at('2026-01-01T00:02:37.000Z'));
    expect(feed(tracker, entriesOf('wznowienie-bez-flagi.jsonl'))).toEqual([{ line: 15, value: false }]);
  });

  it('reguła pierwszej tury: jawny znacznik po żądaniu rozbraja ją (odmowa przy wyłączonych workflow nim nie jest)', () => {
    const tracker = createUltracodeTracker();
    tracker.processStarted(PROCESS_START);
    tracker.requested(at('2026-01-01T00:00:44.000Z'));
    // Wynik `on` w linii 31 rozstrzyga sam; tury po nim nie mają znaczenia dla reguły.
    expect(feed(tracker, entriesOf('komendy-w-bezczynnosci.jsonl')))
      .toEqual([{ line: 5, value: false }, { line: 31, value: true }]);
    // Odmowa „Ultracode needs …” nie rozbraja: reguła czeka na pierwszą turę człowieka.
    const refused = createUltracodeTracker();
    refused.requested(at('2026-01-01T00:00:03.000Z'));
    expect(feed(refused, entriesOf('niedostepne.jsonl'))).toEqual([]);
    expect(refused.value).toBeUndefined();
  });

  describe('reguła pierwszej tury na wpisach syntetycznych', () => {
    const iso = (s: number): string => new Date(at('2026-01-01T00:01:00.000Z') + s * 1000).toISOString();
    const human = (s: number, extra: Record<string, unknown> = {}): { line: number; entry: unknown } => ({
      line: s, entry: {
        type: 'user', isSidechain: false, timestamp: iso(s), origin: { kind: 'human' },
        message: { role: 'user', content: 'zrób coś' }, ...extra,
      },
    });
    const reply = (s: number, extra: Record<string, unknown> = {}, model = 'claude-opus-5-5') => ({
      line: s, entry: {
        type: 'assistant', isSidechain: false, timestamp: iso(s),
        message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] }, ...extra,
      },
    });
    const armed = (): UltracodeTracker => {
      const tracker = createUltracodeTracker();
      tracker.processStarted(at('2026-01-01T00:00:00.000Z'));
      tracker.requested(at('2026-01-01T00:01:05.000Z'));
      return tracker;
    };

    it('prompt starszy od żądania nie otwiera tury; dopiero młodszy', () => {
      const tracker = armed();
      expect(feed(tracker, [human(1), reply(2)])).toEqual([]);
      expect(feed(tracker, [human(10), reply(12)])).toEqual([{ line: 12, value: false }]);
    });

    it('subagent, wpis `isMeta`, notka o zadaniu w tle i odpowiedź `<synthetic>` niczego nie rozstrzygają', () => {
      const tracker = armed();
      expect(feed(tracker, [
        human(10, { isSidechain: true }),
        human(11, { isMeta: true }),
        human(12, { origin: { kind: 'task-notification' } }),
        reply(13),
      ])).toEqual([]);
      expect(feed(tracker, [
        human(20), reply(21, { isSidechain: true }), reply(22, {}, '<synthetic>'), reply(23),
      ])).toEqual([{ line: 23, value: false }]);
    });

    /*
     * Przerwana tura sama nic nie rozstrzyga (bez odpowiedzi modelu nie ma wniosku), a następny prompt zaczyna okno
     * od nowa. Brak znacznika w obu turach rozstrzyga, bo CLI pisze załącznik razem z promptem, przed żądaniem do
     * API (`start-flaga.jsonl`: prompt w linii 15, `ultra_effort_enter` w linii 22 z tą samą chwilą, żądanie w linii
     * 29), więc przerwanie odpowiedzi nie gubi załącznika pierwszej tury.
     */
    it('przerwana tura: sam prompt nic nie daje, odpowiedź na następny prompt bez załącznika daje `false`', () => {
      const tracker = armed();
      expect(feed(tracker, [human(10)])).toEqual([]);
      expect(tracker.value).toBeUndefined();
      expect(feed(tracker, [human(12), reply(13)])).toEqual([{ line: 13, value: false }]);
    });

    it('po rozstrzygnięciu reguła milknie: kolejne tury bez załącznika niczego nie dowodzą', () => {
      const tracker = armed();
      expect(feed(tracker, [human(10), reply(11), human(20), reply(21)])).toEqual([{ line: 11, value: false }]);
    });

    it('luka w odczycie gasi regułę: brak załącznika mógł być brakiem odczytu', () => {
      const tracker = armed();
      feed(tracker, [human(10)]);
      tracker.lost();
      expect(feed(tracker, [reply(11), human(20), reply(21)])).toEqual([]);
      expect(tracker.value).toBeUndefined();
    });
  });

  /*
   * Każde uruchomienie przez Raroga (start, „Wznów”, restart) dostaje nowy driver i nowy czytelnik pliku, więc drugi,
   * późniejszy start w tym samym trackerze to proces spoza Raroga: `/exit` i `claude --resume` przy biurku.
   * Wycinek `wznowienie-z-flaga.jsonl`: komendy o 00:02:09.695, prompt człowieka o 00:02:11.522, odpowiedź o .577.
   */
  describe('nowy proces CLI tej rozmowy spoza Raroga', () => {
    const RESUME_REQUEST = at('2026-01-01T00:02:08.000Z');
    const RESUME_START = at('2026-01-01T00:02:09.000Z');
    const DESK_START = at('2026-01-01T00:05:00.000Z');

    it('wznowienie z flagą bez znacznika, potem drugi start: żądanie sprzed startu poprzedniego przepada', () => {
      const tracker = createUltracodeTracker();
      tracker.requested(RESUME_REQUEST, false);
      // Pierwszy start to proces, który uruchomił Rarog: żądane `true` na karcie zostaje (bez zmiany).
      expect(tracker.processStarted(RESUME_START)).toBe(false);
      expect(feed(tracker, entriesOf('wznowienie-z-flaga.jsonl'))).toEqual([]);
      // Drugi, późniejszy start: karta mogła nieść żądane `true`, więc zmiana, choć wartość dalej `undefined`.
      expect(tracker.processStarted(DESK_START)).toBe(true);
      expect(tracker.value).toBeUndefined();
      // Bez żądania i bez stanu kolejny start nie ma czego zdejmować.
      expect(tracker.processStarted(DESK_START + 60_000)).toBe(false);
    });

    it('zastąpienie procesu gasi regułę pierwszej tury żądania sprzed startu poprzedniego procesu', () => {
      const tracker = createUltracodeTracker();
      tracker.requested(RESUME_REQUEST);
      tracker.processStarted(at('2026-01-01T00:02:08.500Z'));
      expect(tracker.processStarted(RESUME_START)).toBe(true);
      // Tura procesu bez flagi nie odpowiada na żądanie poprzedniego: bez reguły nie daje `false`.
      expect(feed(tracker, entriesOf('wznowienie-z-flaga.jsonl'))).toEqual([]);
      expect(tracker.value).toBeUndefined();
    });

    it('komenda włączenia młodsza od startu poprzedniego procesu zostaje żądaniem po zastąpieniu', () => {
      const tracker = createUltracodeTracker();
      tracker.requested(RESUME_REQUEST, false);
      tracker.processStarted(RESUME_START);
      // `/effort ultracode` z apki o 00:02:10, a rejestr podaje start nowego procesu (00:02:09.5) dopiero po niej.
      tracker.requested(at('2026-01-01T00:02:10.000Z'));
      expect(tracker.processStarted(at('2026-01-01T00:02:09.500Z'))).toBe(false);
      // Reguła pierwszej tury tej komendy dalej działa: odpowiedź bez załącznika daje `false`.
      expect(feed(tracker, entriesOf('wznowienie-z-flaga.jsonl'))).toEqual([{ line: 11, value: false }]);
    });

    it('wcześniejszy start to poprawka chwili tego samego procesu, nie nowy proces: żądanie zostaje', () => {
      const tracker = createUltracodeTracker();
      tracker.requested(RESUME_REQUEST, false);
      tracker.processStarted(at('2026-01-01T00:02:09.500Z'));
      expect(tracker.processStarted(RESUME_START)).toBe(false);
      expect(tracker.processStarted(DESK_START)).toBe(true);
    });
  });

  describe('luka w odczycie (`lost`): pominięty kawałek mógł nieść każdy znacznik', () => {
    it('znany stan przepada: wyłączenie mogło leżeć w luce, a kolejne tury znacznika nie powtarzają', () => {
      const tracker = createUltracodeTracker();
      tracker.processStarted(PROCESS_START);
      feed(tracker, entriesOf('start-flaga.jsonl'));
      expect(tracker.value).toBe(true);
      expect(tracker.lost()).toBe(true);
      expect(tracker.value).toBeUndefined();
      // Trzy tury bez znacznika (00:00:40–00:00:42) niczego nie dowodzą.
      const turns = entriesOf('komendy-w-bezczynnosci.jsonl').filter(({ line }) => line >= 15 && line <= 26);
      expect(feed(tracker, turns)).toEqual([]);
      expect(tracker.value).toBeUndefined();
    });

    it('znacznik po luce ustala stan od razu', () => {
      const tracker = createUltracodeTracker();
      tracker.processStarted(PROCESS_START);
      feed(tracker, entriesOf('start-flaga.jsonl'));
      tracker.lost();
      const off = entriesOf('komendy-w-bezczynnosci.jsonl').filter(({ line }) => line <= 14);
      expect(feed(tracker, off)).toEqual([{ line: 5, value: false }]);
    });

    it('bez stanu i bez żądania luka nie ma czego zgłaszać', () => {
      const tracker = createUltracodeTracker();
      expect(tracker.lost()).toBe(false);
      tracker.processStarted(PROCESS_START);
      expect(tracker.lost()).toBe(false);
    });

    it('żądanie bez dowodu: karta mogła nieść żądane `true`; chwila żądania zostaje odcięciem', () => {
      const tracker = createUltracodeTracker();
      tracker.requested(at('2026-01-01T00:00:43.000Z'), false);
      expect(tracker.lost()).toBe(true);
      // Wynik `off` (34.696) dalej jest starszy od żądania; `on` (44.000) już nie.
      expect(feed(tracker, entriesOf('komendy-w-bezczynnosci.jsonl'))).toEqual([{ line: 31, value: true }]);
    });
  });
});
