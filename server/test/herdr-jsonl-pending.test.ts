/**
 * Wąski parser jsonl (`herdr/jsonl-pending.ts`) — czekające narzędzie, tryb, model, `cwd`.
 *
 * Fixture'y są prawdziwe: `transcript-pending.jsonl` to `transcript-sample.jsonl` ucięty
 * PRZED `tool_result`, czyli dokładnie ten kształt, w którym agent na coś czeka („ostatni wpis
 * to `tool_use` bez pary, potem cisza"). Pełny `transcript-sample.jsonl` służy jako para
 * negatywna: ma `tool_result` dla swojego jedynego `tool_use`, więc nie czeka NIC.
 *
 * Przypadki, których w żadnym z tych plików nie było (dwa `tool_use` w jednej wiadomości,
 * `tool_result` przed swoim `tool_use`, egzotyczne `permissionMode`), budujemy z wpisów
 * o tym samym kształcie — nigdy nie dopisując ich do fixture'a i nie udając, że przyszły
 * z żywego pliku.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PERMISSION_MODE_MAP, createPendingTracker, cwdFrom, metaFrom, parseJsonlEntry, pendingToolUse, resumeSettingsFrom,
} from '../src/herdr/jsonl-pending.ts';
import { parseAskUserQuestionInput } from '../src/drivers/tool-summary.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
// Identyfikator po anonimizacji fixture'u: ta sama długość co prawdziwy, numer zamiast losowych znaków.
const TOOL_ID = 'toolu_000000000000000000000001';

const load = (name: string): string[] =>
  readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter((line) => line !== '');

/** Wpis asystenta z listą bloków — kształt przepisany z fixture'a. */
const assistantLine = (blocks: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp: '2026-08-22T18:45:22.550Z',
    message: { role: 'assistant', model: 'claude-fable-5', content: blocks },
    ...extra,
  });

const toolUse = (id: string, name: string, input: unknown): unknown =>
  ({ type: 'tool_use', id, name, input });

const userLine = (content: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'user',
    isSidechain: false,
    timestamp: '2026-08-22T18:45:30.000Z',
    message: { role: 'user', content },
    ...extra,
  });

const toolResult = (id: string): unknown =>
  ({ type: 'tool_result', tool_use_id: id, content: 'ok' });

// ---------------------------------------------------------------------------
// pendingToolUse
// ---------------------------------------------------------------------------

describe('pendingToolUse', () => {
  it('plik ucięty przed `tool_result` oddaje czekające narzędzie z PEŁNYM inputem', () => {
    const pending = pendingToolUse(load('transcript-pending.jsonl'));
    expect(pending?.id).toBe(TOOL_ID);
    expect(pending?.toolName).toBe('AskUserQuestion');
    expect(pending?.at).toBe('2026-08-22T18:45:22.550Z');
    // Pełny input, nie podsumowanie: karta zgody i `classifyRisk` dostają to samo, co silnik.
    expect(pending?.input).toEqual({
      questions: [{
        question: 'Kolor motywu?',
        header: 'Motyw',
        options: [
          { label: 'Ciemny', description: 'Ciemny motyw' },
          { label: 'Jasny', description: 'Jasny motyw' },
        ],
        multiSelect: false,
      }],
    });
  });

  it('input `AskUserQuestion` przechodzi `parseAskUserQuestionInput` bez zmian', () => {
    const pending = pendingToolUse(load('transcript-pending.jsonl'));
    expect(parseAskUserQuestionInput(pending?.input)).toEqual([{
      question: 'Kolor motywu?',
      header: 'Motyw',
      multiSelect: false,
      options: [
        { label: 'Ciemny', description: 'Ciemny motyw' },
        { label: 'Jasny', description: 'Jasny motyw' },
      ],
    }]);
  });

  it('pełny plik z `tool_result` nie czeka na nic', () => {
    expect(pendingToolUse(load('transcript-sample.jsonl'))).toBeNull();
  });

  it('dwa `tool_use` w jednej wiadomości → PIERWSZY (CLI pyta w kolejności bloków)', () => {
    const pending = pendingToolUse([assistantLine([
      toolUse('t-1', 'Bash', { command: 'pnpm test' }),
      toolUse('t-2', 'Edit', { file_path: '/Users/u/Projects/atlas/a.ts' }),
    ])]);
    expect(pending?.id).toBe('t-1');
    expect(pending?.toolName).toBe('Bash');
  });

  it('domknięcie pierwszego przesuwa oczekiwanie na drugi', () => {
    const pending = pendingToolUse([
      assistantLine([toolUse('t-1', 'Bash', {}), toolUse('t-2', 'Edit', {})]),
      userLine([toolResult('t-1')]),
    ]);
    expect(pending?.id).toBe('t-2');
  });

  it('`tool_result` PRZED swoim `tool_use` daje `null`, nie wyjątek', () => {
    const pending = pendingToolUse([
      userLine([toolResult('t-1')]),
      assistantLine([toolUse('t-1', 'Bash', {})]),
    ]);
    expect(pending).toBeNull();
  });

  it('przerwana tura nie zostawia wiszącej karty', () => {
    // `[Request interrupted by user]` to wpis `user` bez `tool_result` — narzędzie, o które
    // agent pytał, przestało czekać, choć jego `tool_use` zostaje w pliku na zawsze.
    const pending = pendingToolUse([
      assistantLine([toolUse('t-1', 'Bash', {})]),
      userLine([{ type: 'text', text: '[Request interrupted by user]' }]),
    ]);
    expect(pending).toBeNull();
  });

  /*
   * `isMeta` to wpis WSTRZYKNIĘTY przez silnik w kształcie wypowiedzi człowieka. Reguła
   * „wypowiedź człowieka domyka wszystko, co czekało" bez wyjątku brałaby go za prawdziwą wypowiedź,
   * więc pending gasłby na `[Image: …]`, na `<local-command-caveat>` i — najgorsze — na wiadomości
   * z innej sesji, która przychodzi ASYNCHRONICZNIE, także w środku stojącego dialogu.
   * Pomiar na 25 transkryptach: 428 wpisów `isMeta`, w tym 29 międzysesyjnych.
   */
  it('wpis `isMeta` (wstrzyknięty przez silnik) NIE domyka czekającego narzędzia', () => {
    const pending = pendingToolUse([
      assistantLine([toolUse('t-1', 'Bash', { command: 'git push' })]),
      userLine('Another Claude session sent a message: sprawdź testy', { isMeta: true }),
      userLine([{ type: 'text', text: '[Image: source: screenshot]' }], { isMeta: true }),
    ]);
    expect(pending?.id).toBe('t-1');
  });

  it('przerwanie tury `isMeta` NIE MA, więc dalej domyka (kontrola dla reguły wyżej)', () => {
    const pending = pendingToolUse([
      assistantLine([toolUse('t-1', 'Bash', {})]),
      userLine([{ type: 'text', text: '[Request interrupted by user]' }]),
    ]);
    expect(pending).toBeNull();
  });

  it('sidechain podagenta jest niewidoczny (ma własny plik)', () => {
    const pending = pendingToolUse([
      assistantLine([toolUse('t-1', 'Bash', {})], { isSidechain: true }),
    ]);
    expect(pending).toBeNull();
  });

  it('uszkodzone i puste linie są pomijane, plik leci dalej', () => {
    const pending = pendingToolUse([
      '{ to nie jest json',
      '',
      assistantLine([toolUse('t-9', 'Read', { file_path: '/Users/u/Projects/atlas/x.ts' })]),
    ]);
    expect(pending?.id).toBe('t-9');
  });

  /*
   * The call `cwd` without a hook dump: after a Bash `cd`, the `cwd` field of the transcript entry carrying the
   * `tool_use` names the directory the call runs in, while the CLI registry and the herdr agent stay on the session
   * start directory (measured on CLI 2.1.330).
   */
  it.each<[string, Record<string, unknown>, string | undefined]>([
    ['the entry after `cd sub`', { cwd: '/w/project/sub' }, '/w/project/sub'],
    ['an entry without `cwd`', {}, undefined],
    ['a relative `cwd`', { cwd: 'sub' }, undefined],
    ['an empty `cwd`', { cwd: '' }, undefined],
    ['a `cwd` that is not a string', { cwd: 42 }, undefined],
  ])('call `cwd` from the transcript entry: %s', (_case, extra, expected) => {
    const pending = pendingToolUse([
      assistantLine([toolUse('t-1', 'Bash', { command: 'cd sub' })], { cwd: '/w/project' }),
      userLine([toolResult('t-1')], { cwd: '/w/project/sub' }),
      assistantLine([toolUse('t-2', 'Edit', { file_path: 'notes.txt' })], extra),
    ]);
    expect(pending?.id).toBe('t-2');
    expect(pending?.entryCwd).toBe(expected);
    // The field the card decision reads stays the hook payload's alone.
    expect(pending?.cwd).toBeUndefined();
  });

  it('tracker liczy to samo co funkcja czysta, wpis po wpisie', () => {
    const tracker = createPendingTracker();
    const lines = load('transcript-pending.jsonl');
    for (const line of lines) tracker.note(parseJsonlEntry(line));
    expect(tracker.pending?.id).toBe(TOOL_ID);
    tracker.note(parseJsonlEntry(userLine([toolResult(TOOL_ID)])));
    expect(tracker.pending).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// metaFrom
// ---------------------------------------------------------------------------

describe('metaFrom', () => {
  it('wpis asystenta niesie model i effort', () => {
    const assistant = load('transcript-pending.jsonl')
      .map(metaFrom)
      .find((meta) => meta?.model !== undefined);
    expect(assistant).toEqual({ model: 'claude-fable-5', effort: 'low' });
  });

  it('wpis `permission-mode` niesie sam tryb', () => {
    expect(metaFrom(JSON.stringify({ type: 'permission-mode', permissionMode: 'default' })))
      .toEqual({ mode: 'manual' });
  });

  it('wszystkie pięć mapowań trybu, a nieznane → `unknown` (nigdy cichy `manual`)', () => {
    const modeOf = (value: string): unknown =>
      metaFrom(JSON.stringify({ type: 'permission-mode', permissionMode: value }))?.mode;
    expect(modeOf('default')).toBe('manual');
    expect(modeOf('acceptEdits')).toBe('auto');
    expect(modeOf('auto')).toBe('auto');
    expect(modeOf('plan')).toBe('plan');
    expect(modeOf('bypassPermissions')).toBe('bypass');
    expect(modeOf('yoloMode')).toBe('unknown');
    expect(Object.keys(PERMISSION_MODE_MAP)).toHaveLength(5);
  });

  it('model spoza wzorca identyfikatora nie zatruwa pigułki', () => {
    const line = assistantLine([], { message: { role: 'assistant', model: '<synthetic>' } });
    expect(metaFrom(line)).toBeNull();
  });

  it('wpisy bez metadanych dają `null`', () => {
    expect(metaFrom(JSON.stringify({ type: 'attachment' }))).toBeNull();
    expect(metaFrom('nie-json')).toBeNull();
    expect(metaFrom('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cwdFrom
// ---------------------------------------------------------------------------

describe('cwdFrom', () => {
  /**
   * To jest wejście do walidacji `resumeFrom`: `--resume <uuid z innego katalogu>`
   * DZIAŁA, a plik zostaje w oryginalnym slugu. Bez tego odczytu jedno pole w POST ładowałoby
   * na telefon całą historię cudzego projektu.
   */
  it('transkrypt spoza korzeni Raroga oddaje swój prawdziwy katalog', () => {
    expect(cwdFrom(load('transcript-foreign-cwd.jsonl')))
      .toBe('/Users/u/Desktop/inne');
  });

  it('bierze `cwd` z OSTATNIEGO wpisu, który je niesie', () => {
    expect(cwdFrom([
      userLine('a', { cwd: '/Users/u/Projects/atlas' }),
      userLine('b', { cwd: '/Users/u/Projects/birch' }),
      JSON.stringify({ type: 'ai-title' }),
    ])).toBe('/Users/u/Projects/birch');
  });

  it('brak `cwd` w oknie → `null`', () => {
    expect(cwdFrom([JSON.stringify({ type: 'ai-title' }), 'śmieć'])).toBeNull();
    expect(cwdFrom([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resumeSettingsFrom
// ---------------------------------------------------------------------------

describe('resumeSettingsFrom', () => {
  it('model i effort z OSTATNIEJ tury asystenta, tryb z ostatniego wpisu, który go niesie', () => {
    expect(resumeSettingsFrom([
      assistantLine([], { effort: 'low', message: { role: 'assistant', model: 'claude-fable-5-1', content: [] } }),
      userLine('a', { permissionMode: 'plan' }),
      assistantLine([], { effort: 'xhigh', message: { role: 'assistant', model: 'claude-opus-5-5', content: [] } }),
      JSON.stringify({ type: 'permission-mode', permissionMode: 'acceptEdits' }),
      JSON.stringify({ type: 'ai-title' }),
    ])).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'acceptEdits' });
  });

  it('tryb zostaje SUROWY (acceptEdits nie zwija się do auto jak w chipie)', () => {
    expect(resumeSettingsFrom([userLine('a', { permissionMode: 'acceptEdits' })]))
      .toEqual({ permissionMode: 'acceptEdits' });
  });

  it('wpisy subagenta nie liczą się: ich model i effort nie są modelem rozmowy', () => {
    expect(resumeSettingsFrom([
      assistantLine([], { effort: 'high' }),
      assistantLine([], {
        isSidechain: true, effort: 'low', permissionMode: 'bypassPermissions',
        message: { role: 'assistant', model: 'claude-haiku-4-5', content: [] },
      }),
    ])).toEqual({ model: 'claude-fable-5', effort: 'high' });
  });

  it('`<synthetic>` na końcu nie gubi wcześniejszej tury', () => {
    expect(resumeSettingsFrom([
      assistantLine([], { effort: 'medium' }),
      assistantLine([], { effort: 'max', message: { role: 'assistant', model: '<synthetic>', content: [] } }),
    ])).toEqual({ model: 'claude-fable-5', effort: 'medium' });
  });

  it('effort spoza listy albo `null` = brak effortu, model zostaje', () => {
    expect(resumeSettingsFrom([assistantLine([], { effort: null })])).toEqual({ model: 'claude-fable-5' });
    expect(resumeSettingsFrom([assistantLine([], { effort: 'turbo' })])).toEqual({ model: 'claude-fable-5' });
  });

  it('pusty albo uszkodzony ogon = puste ustawienia', () => {
    expect(resumeSettingsFrom([])).toEqual({});
    expect(resumeSettingsFrom(['śmieć', '{"type":"assistant"'])).toEqual({});
  });

  describe('ultracode: ostatni znacznik rozmowy, bez odcięcia po czasie', () => {
    it('start z flagą: załącznik pierwszej tury daje `ultracode: true` obok effortu ostatniej tury', () => {
      expect(resumeSettingsFrom(load('ultracode/start-flaga.jsonl')))
        .toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh', ultracode: true });
    });

    it('ostatni znacznik wygrywa: `on` po `off` w bezczynności, `on` po `off` w turze', () => {
      expect(resumeSettingsFrom(load('ultracode/komendy-w-bezczynnosci.jsonl')).ultracode).toBe(true);
      expect(resumeSettingsFrom(load('ultracode/off-w-turze.jsonl')).ultracode).toBe(true);
      // Ucięty przed `on`: ostatnim znacznikiem jest wynik `off` i załącznik `exit`.
      expect(resumeSettingsFrom(load('ultracode/komendy-w-bezczynnosci.jsonl').slice(0, 27)).ultracode).toBe(false);
    });

    it('odmowa przy wyłączonych workflow i plik bez znacznika = brak pola', () => {
      expect('ultracode' in resumeSettingsFrom(load('ultracode/niedostepne.jsonl'))).toBe(false);
      expect('ultracode' in resumeSettingsFrom([assistantLine([], { effort: 'xhigh' })])).toBe(false);
    });

    it('znacznik subagenta nie jest znacznikiem rozmowy', () => {
      const enter = JSON.stringify({
        type: 'attachment', isSidechain: true, timestamp: '2026-08-22T18:45:22.000Z',
        attachment: { type: 'ultra_effort_enter' },
      });
      expect('ultracode' in resumeSettingsFrom([assistantLine([], { effort: 'xhigh' }), enter])).toBe(false);
    });
  });
});
