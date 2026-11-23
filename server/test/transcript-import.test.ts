/**
 * Testy importu historii z magazynu CLI (`transcript-import.ts`).
 *
 * Fixture'y są zbudowane 1:1 na kształcie prawdziwego pliku `~/.claude/projects/<slug>/<id>.jsonl`
 * (sprawdzonego na 22 MB transkrypcie): linie `user` / `assistant` / `attachment` /
 * `queue-operation` / `last-prompt` / `system`, treść użytkownika raz stringiem, raz blokami,
 * a każdy blok odpowiedzi asystenta w OSOBNEJ linii z tym samym `requestId`.
 *
 * Sedno: parser ma być odporny (uszkodzona linia nie wywraca importu), a odczyt ma dotykać
 * wyłącznie OGONA pliku — dlatego jeden test generuje plik ponad limitem 2 MB.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSlug } from '../src/cli-store.ts';
import { COMMAND_OUTPUT_CLIP, COMMAND_OUTPUT_MAX_BYTES, userEntryNote } from '../src/herdr/commands/transcript.ts';
import {
  IMAGE_PLACEHOLDER, MAX_IMPORT_BYTES, importTranscript as importTail, isHiddenTurnInput, parseImportLine as parseLine,
  parseTranscriptTail as parseTail,
} from '../src/transcript-import.ts';
import { wireEntry, wireMessages } from './helpers/bloki-drutu.ts';

/*
 * Testy kształtu importu patrzą na to, co wyjdzie na drut: wynik parsera przechodzi przez serializację
 * sesji (`wireBlocks`). Pochodzenie tekstu (`say`, `foreign`) sprawdza osobny blok na końcu pliku.
 */
const parseTranscriptTail = (...args: Parameters<typeof parseTail>) => wireMessages(parseTail(...args));
const importTranscript = async (...args: Parameters<typeof importTail>) => wireMessages(await importTail(...args));
const parseImportLine = (...args: Parameters<typeof parseLine>) => wireEntry(parseLine(...args));

const CWD = '/Users/demo/Projects/willow';
const ENGINE_ID = 'ee5138c9-0cef-4988-8e97-23daaa4c8eb7';

const line = (value: unknown): string => JSON.stringify(value);

/** Bajt ESC budowany z kodu — repo zabrania surowych znaków sterujących w źródłach. */
const ESC = String.fromCharCode(27);

const userLine = (content: unknown, extra: Record<string, unknown> = {}): string => line({
  type: 'user',
  message: { role: 'user', content },
  isSidechain: false,
  timestamp: '2026-08-22T10:00:00.000Z',
  sessionId: ENGINE_ID,
  ...extra,
});

const assistantLine = (
  content: unknown, extra: Record<string, unknown> = {}, model = 'claude-fable-5',
): string => line({
  type: 'assistant',
  message: { role: 'assistant', model, content },
  isSidechain: false,
  timestamp: '2026-08-22T10:00:05.000Z',
  requestId: 'req_1',
  ...extra,
});

const parse = (lines: string[], dropFirstLine = false): ReturnType<typeof parseTranscriptTail> =>
  parseTranscriptTail(lines.join('\n'), { dropFirstLine });

describe('parseTranscriptTail — kształty wpisów', () => {
  it('treść użytkownika jako string staje się jedną wiadomością tekstową', () => {
    const result = parse([userLine('Napraw zapis notatki.')]);
    expect(result.messages).toEqual([{
      role: 'user',
      blocks: [{ type: 'text', text: 'Napraw zapis notatki.' }],
      at: '2026-08-22T10:00:00.000Z',
    }]);
  });

  it('treść użytkownika jako bloki bierze tylko tekst, a obrazek zastępuje etykietą', () => {
    const result = parse([userLine([
      { type: 'text', text: 'Zobacz zrzut' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ])]);
    expect(result.messages[0]?.blocks).toEqual([
      { type: 'text', text: 'Zobacz zrzut' },
      { type: 'text', text: IMAGE_PLACEHOLDER.text, ref: IMAGE_PLACEHOLDER.ref },
    ]);
    // Dane obrazka z cudzego pliku NIE wchodzą do transkryptu Raroga.
    expect(JSON.stringify(result.messages)).not.toContain('AAAA');
  });

  it('znaczniki [Image #N] znikają z tekstu użytkownika (hydraulika CLI, nie treść)', () => {
    const result = parse([userLine([
      { type: 'text', text: '[Image #36] [Image #37]Zarówno w jednym, jak i drugim.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ])]);
    expect(result.messages[0]?.blocks[0]).toEqual({
      type: 'text', text: 'Zarówno w jednym, jak i drugim.',
    });
    // Wpis, który po zdjęciu znaczników jest pusty, nie zostaje pustym dymkiem.
    const only = parse([userLine([{ type: 'text', text: '[Image #1]' }])]);
    expect(only.messages).toHaveLength(0);
  });

  it('obwódka <pasted_content> znika z tekstu użytkownika (CLI ≥ 2.1.277)', () => {
    // Kształt zmierzony w jsonl: dwa puste wiersze, tag z `id`, treść, tag zamykający TEŻ z `id`.
    const wrapped = '\n\n<pasted_content id="094f">\nwydaje sie ze agent.prompt\nbedzie lepsze?\n</pasted_content id="094f">';
    const whole = parse([userLine([{ type: 'text', text: wrapped }])]);
    expect(whole.messages[0]?.blocks[0]).toEqual({
      type: 'text', text: 'wydaje sie ze agent.prompt\nbedzie lepsze?',
    });
    // Tekst wpisany obok wklejki zostaje; tag bez `id` (wpisany ręcznie) nie jest ruszany.
    const mixed = parse([userLine([{
      type: 'text', text: 'sprawdz to:\n<pasted_content id="ac01">\nlog\n</pasted_content id="ac01">',
    }])]);
    expect(mixed.messages[0]?.blocks[0]).toEqual({ type: 'text', text: 'sprawdz to:\nlog' });
    const typed = parse([userLine([{ type: 'text', text: 'co znaczy <pasted_content>?' }])]);
    expect(typed.messages[0]?.blocks[0]).toEqual({ type: 'text', text: 'co znaczy <pasted_content>?' });
  });

  it('wpis użytkownika z samym tool_result jest pomijany', () => {
    const result = parse([
      userLine('start'),
      userLine([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }]),
    ]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.blocks).toEqual([{ type: 'text', text: 'start' }]);
  });

  /*
   * Wynik komendy lokalnej jest notką `system` bez SGR; wpis z nazwą
   * `/compact` zostaje niewidoczny (`fileEcho`: komendę niesie zwykły wpis `user` „/compact”),
   * a przypomnienie systemowe dalej nie jest niczym. Wiadomością `user` jest tylko prawdziwe pytanie.
   */
  it('hydraulika CLI w roli user: wynik komendy to notka `system`, reszta nie jest wiadomością człowieka', () => {
    const result = parse([
      userLine(`<local-command-stdout>${ESC}[2mCompacted${ESC}[22m</local-command-stdout>`),
      userLine([{ type: 'text', text: '<command-name>/compact</command-name>' }]),
      userLine('  <system-reminder>pamiętaj o CLAUDE.md</system-reminder>'),
      userLine('prawdziwe pytanie'),
    ]);
    // The `/compact` call without a plain "/compact" entry before it is the only carrier of the call (CLI 2.1.328).
    expect(result.messages.map((m) => [m.role, m.blocks])).toEqual([
      ['system', [{ type: 'text', text: 'Compacted' }]],
      ['system', [{ type: 'text', text: '/compact' }]],
      ['user', [{ type: 'text', text: 'prawdziwe pytanie' }]],
    ]);
  });

  /*
   * The CLI writes a `user` entry when Esc stops a working turn (CLI 2.1.311, docs/dialogs.md, "`PermissionRequest`
   * hook behavior"). Nobody wrote it, and the gray note about the interruption already covers an Esc sent from Rarog,
   * so the entry is not a bubble.
   */
  it('interruption marker is not a user message, in either form', () => {
    const result = parse([
      userLine('first question'),
      assistantLine([{ type: 'text', text: 'partial answer' }]),
      userLine([{ type: 'text', text: '[Request interrupted by user]' }]),
      userLine('[Request interrupted by user for tool use]'),
      userLine('second question'),
    ]);
    expect(result.messages.map((m) => [m.role, m.blocks])).toEqual([
      ['user', [{ type: 'text', text: 'first question' }]],
      ['assistant', [{ type: 'text', text: 'partial answer' }]],
      ['user', [{ type: 'text', text: 'second question' }]],
    ]);
  });

  it('wpisy meta i sidechain nie trafiają do transkryptu', () => {
    const result = parse([
      userLine('widoczne'),
      userLine('podsumowanie CLI', { isMeta: true }),
      userLine('pytanie podagenta', { isSidechain: true }),
      assistantLine([{ type: 'text', text: 'odpowiedź podagenta' }], { isSidechain: true }),
    ]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.blocks).toEqual([{ type: 'text', text: 'widoczne' }]);
  });

  it('bloki asystenta: tekst zostaje, tool_use staje się tool-callem, pusty thinking znika', () => {
    const result = parse([assistantLine([
      { type: 'thinking', thinking: '', signature: 'xxx' },
      { type: 'text', text: 'Sprawdzam pliki:' },
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -t ~/notes' } },
    ])]);
    expect(result.messages[0]?.blocks).toEqual([
      { type: 'text', text: 'Sprawdzam pliki:' },
      {
        type: 'tool-call',
        toolName: 'Bash',
        summary: 'ls -t ~/notes',
        detail: 'ls -t ~/notes',
        inputKind: 'shell',
      },
    ]);
  });

  /*
   * Pola semantyczne bloku wyznacza import — klient buduje z nich widok, a nazw narzędzi CLI nie zna.
   * Delegacja: `Workflow` → `workflow`, `Agent`/`Task` → `agents`, reszta bez pola. Rodzaj inputu:
   * `shell` wyłącznie przy łańcuchu `command` (ten sam warunek co `toolInputText`), także `null`
   * i nie-obiekt dają `json`.
   */
  it('tool-call niesie delegation i inputKind policzone z nazwy i inputu', () => {
    const result = parse([assistantLine([
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } },
      { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/tmp/a', old_string: 'a', new_string: 'b' } },
      { type: 'tool_use', id: 't3', name: 'Agent', input: { description: 'Przegląd', prompt: 'x' } },
      { type: 'tool_use', id: 't4', name: 'Task', input: { description: 'Stary podagent' } },
      { type: 'tool_use', id: 't5', name: 'Workflow', input: { name: 'fala' } },
      { type: 'tool_use', id: 't6', name: 'ExitPlanMode', input: null },
      { type: 'tool_use', id: 't7', name: 'Dziwne', input: 'goły łańcuch' },
      { type: 'tool_use', id: 't8', name: 'Bash', input: { command: 7 } },
    ])]);
    const semantics = result.messages[0]?.blocks.map((block) => (
      block.type === 'tool-call'
        ? [block.toolName, block.delegation ?? null, block.inputKind ?? null]
        : null
    ));
    expect(semantics).toEqual([
      ['Bash', null, 'shell'],
      ['Edit', null, 'json'],
      ['Agent', 'agents', 'json'],
      ['Task', 'agents', 'json'],
      ['Workflow', 'workflow', 'json'],
      ['ExitPlanMode', null, 'json'],
      ['Dziwne', null, 'json'],
      ['Bash', null, 'json'],
    ]);
  });

  /*
   * The herdr panel shows "⏺ Tag Vertex nadal jest aktywny…" as agent text, while jsonl stores it as a
   * `thinking` block with non-empty content, in the same message as an empty `thinking` and a `tool_use` —
   * the shape below is taken from such a file.
   */
  it('thinking z niepustą treścią jest tekstem agenta, jak w terminalu', () => {
    const result = parse([
      userLine('sprawdź, czy zadziałało'),
      assistantLine([{ type: 'thinking', thinking: '', signature: 'a' }]),
      assistantLine([{
        type: 'thinking',
        thinking: 'Tag Vertex nadal jest aktywny w opublikowanym kontenerze.\n\n',
        signature: 'b',
      }]),
      assistantLine([{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/x' } }]),
    ]);
    expect(result.messages[1]?.blocks[0]).toEqual({
      type: 'text', text: 'Tag Vertex nadal jest aktywny w opublikowanym kontenerze.',
    });
    expect(result.messages[1]?.blocks).toHaveLength(2);
  });

  it('kolejne linie asystenta sklejają się w JEDNĄ wiadomość, a tool_result ich nie przerywa', () => {
    const result = parse([
      userLine('zrób to'),
      assistantLine([{ type: 'text', text: 'Najpierw szukam.' }]),
      assistantLine([{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'save' } }]),
      userLine([{ type: 'tool_result', tool_use_id: 't1', content: '3 trafienia' }]),
      assistantLine([{ type: 'text', text: 'Gotowe.' }]),
      userLine('dzięki'),
      assistantLine([{ type: 'text', text: 'Proszę.' }]),
    ]);
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(result.messages[1]?.blocks).toHaveLength(3);
    // Czas sklejonej wiadomości = czas PIERWSZEJ linii tury.
    expect(result.messages[1]?.at).toBe('2026-08-22T10:00:05.000Z');
  });

  it('uszkodzone i nieznane linie są pomijane, plik leci dalej', () => {
    const result = parse([
      '{ to nie jest json',
      line({ type: 'queue-operation', operation: 'add', sessionId: ENGINE_ID }),
      line({ type: 'attachment', attachment: { type: 'file' } }),
      line({ type: 'last-prompt', lastPrompt: 'x' }),
      line({ type: 'summary', summary: 'y' }),
      '   ',
      '[]',
      userLine('mimo wszystko widoczne'),
    ]);
    expect(result.messages).toHaveLength(1);
  });

  /*
   * After `/compact` the CLI appends a `user` entry flagged `isCompactSummary` with a bare string of
   * ~22 000 characters — but `isMeta` is `null` there, so an `isMeta` filter alone lets it through and the
   * whole compaction summary would land on the phone as a USER MESSAGE: text the human never wrote, where
   * every user message is their decision. This is a machine-to-machine entry.
   */
  it('podsumowanie po `/compact` NIE jest wiadomością użytkownika', () => {
    const result = parse([
      userLine('/compact'),
      userLine('This session is being continued from a previous conversation…', {
        isCompactSummary: true,
      }),
      userLine('i lecimy dalej'),
    ]);
    expect(result.messages.map((m) => m.blocks[0])).toEqual([
      { type: 'text', text: '/compact' },
      { type: 'text', text: 'i lecimy dalej' },
    ]);
  });

  it('isCompactSummary inne niż `true` niczego nie odsiewa (null z realnych plików)', () => {
    const result = parse([
      userLine('normalna wiadomość', { isCompactSummary: null }),
      userLine('druga', { isCompactSummary: false }),
    ]);
    expect(result.messages).toHaveLength(2);
  });

  it('model i effort biorą się z ostatniego czytelnego wpisu asystenta', () => {
    const result = parse([
      assistantLine([{ type: 'text', text: 'raz' }], { effort: 'low' }, 'claude-sonnet-5'),
      userLine('dalej'),
      assistantLine([{ type: 'text', text: 'dwa' }], { effort: 'high' }, 'claude-fable-5'),
    ]);
    expect(result.model).toBe('claude-fable-5');
    expect(result.effort).toBe('high');
  });

  it('model `<synthetic>` (błąd API) i nieznany effort nie zatruwają wyniku', () => {
    const result = parse([
      assistantLine([{ type: 'text', text: 'ok' }], { effort: 'high' }, 'claude-fable-5'),
      assistantLine([{ type: 'text', text: 'API Error: 401' }], { effort: 'turbo' }, '<synthetic>'),
    ]);
    expect(result.model).toBe('claude-fable-5');
    expect(result.effort).toBe('high');
  });

  it('wpis asystenta bez treści oddaje sam model, bez pustej wiadomości', () => {
    const result = parse([
      assistantLine([{ type: 'thinking', thinking: '' }], { effort: 'max' }),
    ]);
    expect(result.messages).toHaveLength(0);
    expect(result.effort).toBe('max');
  });

  it('ucięta pierwsza linia jest odrzucana, gdy plik był przycięty', () => {
    const lines = ['ssistant","message":{"role":"assi', userLine('cała linia')];
    expect(parse(lines, true).messages).toHaveLength(1);
    // Bez flagi ta sama treść to po prostu uszkodzona linia — też pomijana, ale bez `shift`.
    expect(parse(lines, false).messages).toHaveLength(1);
  });

  it('limit zostawia OSTATNIE wiadomości', () => {
    const lines = Array.from({ length: 10 }, (_, i) => userLine(`m${String(i)}`));
    const result = parseTranscriptTail(lines.join('\n'), { dropFirstLine: false, limit: 3 });
    expect(result.messages.map((m) => (m.blocks[0] as { text: string }).text))
      .toEqual(['m7', 'm8', 'm9']);
  });
});

/*
 * Wpis `user` z `isMeta: true` nie jest wiadomością transkryptu, ale bywa WEJŚCIEM, które
 * wywołuje turę głównego agenta. Manager liczy, co wywołało turę (cisza po turze wywołanej samym
 * postojem subagenta), więc musi o takim wpisie wiedzieć. Kształty niżej to pola zmierzone
 * na magazynie CLI (2.1.273–2.1.296), treść zastąpiona neutralną.
 */
/**
 * Prompt, który przychodzi W TRAKCIE tury, Claude Code wchłania w tę turę i zapisuje wyłącznie jako
 * załącznik kolejki, bez wpisu `user`. Measured on the project's session files (Claude Code
 * 2.1.267–2.1.296): 112 such prompts in 32 files, 26 with an image. A parser that skips them drops the
 * message from the transcript on every replay from file, and a prompt typed in the terminal never reaches
 * Rarog. Shapes copied from a live session file.
 */
describe('prompt człowieka wchłonięty w trwającą turę (załącznik kolejki)', () => {
  const AT = '2026-10-10T07:50:29.308Z';
  /** Załącznik kolejki w kształcie CLI 2.1.296; `timestamp` wpisu to chwila wstawienia do kolejki. */
  const queuedLine = (prompt: unknown, attachment: Record<string, unknown> = {}, entry: Record<string, unknown> = {}): string =>
    line({
      parentUuid: 'af366769-f3d3-4698-a719-78f07cb29afa', isSidechain: false, type: 'attachment', timestamp: AT,
      attachment: {
        type: 'queued_command', prompt, source_uuid: '4736773d-7cd6-4c16-afeb-64ec815377dc', commandMode: 'prompt',
        origin: { kind: 'human' }, timestamp: AT, humanTurn: 3, ...attachment,
      },
      sessionId: ENGINE_ID, version: '2.1.296', ...entry,
    });

  it('napis staje się wiadomością `user` z czasem wpisu', () => {
    expect(parseImportLine(queuedLine('Rozwiń mi jeszcze w prostych słowach.'))).toEqual({
      role: 'user',
      message: { role: 'user', blocks: [{ type: 'text', text: 'Rozwiń mi jeszcze w prostych słowach.' }], at: AT },
      conversational: true,
    });
  });

  it('lista z obrazem: tekst bez `[Image #N]`, obraz jako napis, base64 nie wychodzi', () => {
    const parsed = parseImportLine(queuedLine([
      { type: 'text', text: '[Image #4]BTW. Pytanie nie związane z zadaniem.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'TAJNEBASE64' } },
    ], { imagePasteIds: [4] }));
    expect(parsed?.message?.blocks).toEqual([
      { type: 'text', text: 'BTW. Pytanie nie związane z zadaniem.' },
      { type: 'text', text: IMAGE_PLACEHOLDER.text, ref: IMAGE_PLACEHOLDER.ref },
    ]);
    expect(JSON.stringify(parsed)).not.toContain('TAJNEBASE64');
  });

  it('obwódka wklejki znika jak we wpisie `user`', () => {
    const wrapped = '<pasted_content id="ab12">\ndługi tekst wklejony z raroga\n</pasted_content id="ab12">';
    const direct = parseImportLine(userLine(wrapped));
    expect(parseImportLine(queuedLine(wrapped))?.message?.blocks).toEqual(direct?.message?.blocks);
    expect(JSON.stringify(direct)).not.toContain('pasted_content');
  });

  it('prompt człowieka ze znacznikiem meldunku w treści zostaje wiadomością bez notki', () => {
    const parsed = parseImportLine(queuedLine('co znaczy <task-notification> w logu?'));
    expect(parsed?.message?.blocks).toEqual([{ type: 'text', text: 'co znaczy <task-notification> w logu?' }]);
    expect(parsed?.message).not.toHaveProperty('notice');
  });

  /**
   * Tym samym nośnikiem jadą meldunki o zadaniach i wiadomości od subagentów. Żadna z nich nie jest
   * wypowiedzią człowieka: warunek wymaga dokładnie trybu promptu i pochodzenia `human`.
   */
  it.each([
    ['meldunek o zadaniu', { commandMode: 'task-notification', origin: { kind: 'task-notification' } }, {}],
    ['meldunek bez pochodzenia (starsze CLI)', { commandMode: 'task-notification', origin: undefined }, {}],
    ['wiadomość od subagenta', { origin: { kind: 'peer', from: 'a1', senderTaskId: 'a1' }, isMeta: true }, {}],
    ['prompt bez pochodzenia', { origin: undefined }, {}],
    ['pochodzenie, którego nie zmierzyliśmy', { origin: { kind: 'scheduled' } }, {}],
    ['wpis meta w załączniku przy pochodzeniu `human`', { isMeta: true }, {}],
    ['wpis meta na wpisie przy pochodzeniu `human`', {}, { isMeta: true }],
    ['inny tryb przy pochodzeniu `human`', { commandMode: 'bash' }, {}],
    ['załącznik innego typu', { type: 'file' }, {}],
    ['wpis subagenta', {}, { isSidechain: true }],
  ])('NIE jest wiadomością: %s', (_name, attachment, entry) => {
    expect(parseImportLine(queuedLine('tekst, który nie jest promptem człowieka', attachment, entry))).toBeNull();
  });

  it('zły kształt pól nie rzuca: wpis jest pomijany', () => {
    for (const broken of [
      { type: 'attachment' }, { type: 'attachment', attachment: null }, { type: 'attachment', attachment: 'x' },
      { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', origin: 'human', prompt: 'x' } },
      { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' } } },
      { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, prompt: 7 } },
      { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, prompt: '   ' } },
    ]) {
      const parsed = parseImportLine(line(broken));
      expect(parsed === null || parsed.message === null, JSON.stringify(broken)).toBe(true);
    }
  });

  it('w historii stoi w miejscu wpisu i rozcina sklejaną turę asystenta', () => {
    const result = parse([
      userLine('zrób to'),
      assistantLine([{ type: 'text', text: 'Zaczynam.' }]),
      line({ type: 'queue-operation', operation: 'enqueue', timestamp: AT, content: 'a jeszcze to' }),
      line({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', timestamp: AT, content: 'a jeszcze to' }),
      queuedLine('a jeszcze to'),
      assistantLine([{ type: 'text', text: 'Dobrze, to też.' }]),
    ]);
    expect(result.messages.map((message) => [message.role, message.blocks.map((block) => (block.type === 'text' ? block.text : ''))]))
      .toEqual([['user', ['zrób to']], ['assistant', ['Zaczynam.']], ['user', ['a jeszcze to']], ['assistant', ['Dobrze, to też.']]]);
    expect(result.messages[2]?.at).toBe(AT);
  });
});

describe('isHiddenTurnInput — wejście tury, którego nie ma w transkrypcie', () => {
  const meta = (extra: Record<string, unknown>, content: unknown = 'treść'): Record<string, unknown> => ({
    type: 'user', isSidechain: false, isMeta: true, timestamp: '2026-10-09T21:53:52.149Z',
    promptSource: 'system', message: { role: 'user', content }, ...extra,
  });
  const PEER = { kind: 'peer', from: 'a7c3bc19e5d808853', senderTaskId: 'a7c3bc19e5d808853', name: 'general-purpose' };

  it('wiadomość od subagenta: raport końcowy i wiadomość w trakcie pracy', () => {
    expect(isHiddenTurnInput(meta({ origin: { ...PEER, handback: true }, turnOrigin: 'peer' }))).toBe(true);
    expect(isHiddenTurnInput(meta({ origin: PEER, turnOrigin: 'peer' }))).toBe(true);
    // CLI 2.1.273–2.1.276: `origin` już jest, `turnOrigin` jeszcze nie.
    expect(isHiddenTurnInput(meta({ origin: PEER }))).toBe(true);
  });

  it('zaplanowane wybudzenie, wiadomość systemowa i wznowienie po limicie', () => {
    expect(isHiddenTurnInput(meta({ turnOrigin: 'scheduled' }))).toBe(true);
    expect(isHiddenTurnInput(meta({ turnOrigin: 'system' }))).toBe(true);
    expect(isHiddenTurnInput(meta({ origin: { kind: 'auto-continuation' } }))).toBe(true);
  });

  it('hydraulika trwającej tury wejściem NIE jest: towarzysz zdjęcia, treść skilla, dopisek komendy', () => {
    expect(isHiddenTurnInput(meta({}, '[Image: source: /Users/u/Projects/atlas/.rarog-uploads/a.png]'))).toBe(false);
    expect(isHiddenTurnInput(meta({}, 'Base directory for this skill: /Users/u/.claude/skills/x'))).toBe(false);
    expect(isHiddenTurnInput(meta({}, '<local-command-caveat>Caveat: …</local-command-caveat>'))).toBe(false);
    // Pola obecne, ale puste albo w złym kształcie, niczego nie oznaczają.
    expect(isHiddenTurnInput(meta({ origin: {}, turnOrigin: '' }))).toBe(false);
    expect(isHiddenTurnInput(meta({ origin: 'peer', turnOrigin: { kind: 'peer' } }))).toBe(false);
    expect(isHiddenTurnInput(meta({ origin: { kind: 7 } }))).toBe(false);
  });

  it('wpis widoczny w transkrypcie (bez `isMeta`) idzie zwykłą drogą wiadomości, nie tą', () => {
    const human = { ...meta({ origin: { kind: 'human' }, turnOrigin: 'human' }), isMeta: undefined };
    const notice = { ...meta({ origin: { kind: 'task-notification' }, turnOrigin: 'task_notification' }), isMeta: undefined };
    expect(isHiddenTurnInput(human)).toBe(false);
    expect(isHiddenTurnInput(notice)).toBe(false);
    expect(parseImportLine(line(human))?.message).not.toBeNull();
  });

  it('wpis subagenta, wpis asystenta i śmieci wejściem nie są', () => {
    expect(isHiddenTurnInput({ ...meta({ origin: PEER, turnOrigin: 'peer' }), isSidechain: true })).toBe(false);
    expect(isHiddenTurnInput({ ...meta({ origin: PEER }), type: 'assistant' })).toBe(false);
    expect(isHiddenTurnInput({ type: 'attachment', attachment: { origin: PEER } })).toBe(false);
    for (const junk of [null, undefined, 'peer', 7, []]) expect(isHiddenTurnInput(junk)).toBe(false);
  });

  it('transkryptu nie zmienia: taki wpis dalej nie jest wiadomością, na żywo ani w historii', () => {
    const peer = line(meta({ origin: { ...PEER, handback: true }, turnOrigin: 'peer' }));
    expect(parseImportLine(peer)).toBeNull();
    expect(parseTranscriptTail(`${userLine('pytanie')}\n${peer}`, { dropFirstLine: false }).messages).toHaveLength(1);
  });
});

/*
 * Wpisy komendy z pliku rozmowy. Wycinki z pomiarów (CLI 2.1.302, `/compact`
 * z 2.1.299, skill `/doctor` z 2.1.294 — pochodzenie: `fixtures/herdr/README.md`) czytane linia po linii,
 * w kolejności pliku. Notka `system` = komenda lokalna, jej wynik albo komenda nieznana; komenda typu
 * prompt = wiadomość `user`; zastrzeżenie, Markdown `/context` i treść skilla (`isMeta`) — nic.
 */
describe('wpisy komendy CLI', () => {
  const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
  const fixture = (name: string): string[] => readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n').filter((raw) => raw.trim() !== '');
  const commands = (name: string): string[] => fixture(`commands/measured/${name}`);
  /** Wycinek linii 1..N pliku (numeracja jak w edytorze). */
  const pick = (lines: readonly string[], from: number, to = from): string[] => lines.slice(from - 1, to);
  const shown = (lines: readonly string[]): [string, string][] => parse([...lines]).messages
    .map((m) => [m.role, m.blocks.map((b) => (b.type === 'text' ? b.text : b.type)).join('|')]);

  /** The old product name these measurement recordings carry: the expectations take it from here. */
  const NAGRANA = 'pilot'; // stara-nazwa
  const CONFIG = commands('config-plugin-cd-2.1.302.jsonl');
  const PLAN_CONTEXT = commands('nieznane-sciezki-plan-context-2.1.302.jsonl');

  it('`/config` (wpisy `system/local_command`) → dwie notki: komenda z argumentem i wynik', () => {
    expect(shown(pick(CONFIG, 1, 2))).toEqual([
      ['system', `/config ${NAGRANA}pomiar=1`],
      ['system', `${NAGRANA}pomiar isn't a /config setting. Run /config to see what's available.`],
    ]);
    // Wynik niesie nazwę komendy z `commandRun`; wywołanie — z `<command-name>`.
    expect(parse(pick(CONFIG, 1, 2)).messages.map((m) => m.command)).toEqual([
      { part: 'invocation', name: 'config' }, { part: 'output', name: 'config' },
    ]);
  });

  it('`/cd` → wynik bez sekwencji SGR', () => {
    const notes = shown(pick(CONFIG, 6, 7));
    expect(notes).toEqual([
      ['system', '/cd /Users/u/Projects/rarog/docs'],
      ['system', 'Moved to /Users/u/Projects/rarog/docs'],
    ]);
    expect(JSON.stringify(notes)).not.toContain('\\u001b');
  });

  it('`/plugin` i `/plan` (wpisy `user` z zastrzeżeniem `isMeta`) → notki `system`, zastrzeżenie znika', () => {
    expect(shown(pick(CONFIG, 3, 5))).toEqual([
      ['system', `/plugin install ${NAGRANA}-pomiar-nie-istnieje@${NAGRANA}-pomiar-brak`],
      ['system', `Marketplace "${NAGRANA}-pomiar-brak" not found`],
    ]);
    expect(shown(pick(PLAN_CONTEXT, 12, 14))).toEqual([['system', '/plan'], ['system', 'Enabled plan mode']]);
    // Wynik zapisany wpisem `user` nazwy nie niesie — dopisuje ją follower z wywołania.
    expect(parse(pick(PLAN_CONTEXT, 12, 14)).messages.map((m) => m.command))
      .toEqual([{ part: 'invocation', name: 'plan' }, { part: 'output' }]);
  });

  it('`/context` → notka komendy i wynik bez SGR, najwyżej 8 kB; Markdown `isMeta` znika', () => {
    const messages = parse(pick(PLAN_CONTEXT, 15, 17)).messages;
    expect(messages.map((m) => m.role)).toEqual(['system', 'system']);
    expect(messages[0]?.blocks).toEqual([{ type: 'text', text: '/context' }]);
    const output = messages[1]?.blocks[0];
    const text = output?.type === 'text' ? output.text : '';
    expect(text).toContain('Context Usage');
    expect(text).not.toContain(ESC);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(COMMAND_OUTPUT_MAX_BYTES);
    expect(text).not.toContain('## Context Usage');
  });

  it('dwa samodzielne `/context` → dwie pary notek', () => {
    const pair = pick(PLAN_CONTEXT, 15, 16);
    expect(shown([...pair, ...pair]).map(([role, text]) => [role, text.split('\n')[0]])).toEqual([
      ['system', '/context'], ['system', 'Context Usage'], ['system', '/context'], ['system', 'Context Usage'],
    ]);
  });

  it('„Unknown command” i „Args from unknown skill” → notki; prompt od istniejącej ścieżki → wiadomość `user`', () => {
    expect(shown(pick(PLAN_CONTEXT, 1, 1))).toEqual([['system', 'Unknown command: /prms']]);
    expect(shown(pick(PLAN_CONTEXT, 7, 8))).toEqual([
      ['system', `Unknown command: /${NAGRANA}nieistnieje`],
      ['system', 'Args from unknown skill: pomiar: nie uzywaj narzedzi, odpowiedz jednym slowem ok'],
    ]);
    expect(shown(pick(PLAN_CONTEXT, 4))).toEqual([
      ['user', '/tmp pomiar: nie uzywaj narzedzi, odpowiedz jednym slowem ok'],
    ]);
  });

  it('zastrzeżenie `isMeta` samo nie jest niczym', () => {
    expect(parseImportLine(pick(CONFIG, 3)[0] ?? '')).toBeNull();
  });

  it('`/compact` z fixture kolejki → jedna wiadomość `user` „/compact” (wpis ze znacznikiem to `fileEcho`)', () => {
    const messages = parse(fixture('queue/measured/compact-2.1.299.jsonl')).messages;
    const compact = messages.filter((m) => m.blocks.some((b) => b.type === 'text' && b.text.includes('/compact')));
    expect(compact.map((m) => [m.role, m.blocks])).toEqual([['user', [{ type: 'text', text: '/compact' }]]]);
    // Wycinek ma treść wyniku uciętą („…”, bez znacznika zamykającego): wpis bez pełnego kształtu nie jest notką.
    expect(messages.filter((m) => m.role === 'system')).toEqual([]);
  });

  /*
   * CLI 2.1.328 writes the `/compact` call only as the entry with `<command-name>`; CLI 2.1.299 also writes a plain
   * `user` entry "/compact" before it. One carrier per call stays: the plain entry when it is there, else the call.
   */
  it('`/compact` on CLI 2.1.328 (no plain entry) → one `system` notice "/compact" from the tagged entry', () => {
    const messages = parse(fixture('queue/measured/compact-2.1.328.jsonl')).messages;
    const compact = messages.filter((m) => m.blocks.some((b) => b.type === 'text' && b.text.includes('/compact')));
    expect(compact.map((m) => [m.role, m.blocks, m.command])).toEqual([
      ['system', [{ type: 'text', text: '/compact' }], { part: 'invocation', name: 'compact' }],
    ]);
  });

  it('the tagged `/compact` call repeats a plain "/compact" only while no message stands between them', () => {
    const plain = userLine('/compact');
    const call = userLine('<command-name>/compact</command-name>\n<command-message>compact</command-message>');
    const quiet = [
      line({ type: 'queue-operation', operation: 'enqueue' }),
      line({ type: 'system', subtype: 'compact_boundary' }),
      userLine('Summary.', { isCompactSummary: true }),
      userLine('<local-command-caveat>Caveat</local-command-caveat>', { isMeta: true }),
    ];
    expect(shown([plain, ...quiet, call])).toEqual([['user', '/compact']]);
    expect(shown([plain, assistantLine([{ type: 'text', text: 'ok' }]), call])).toEqual([
      ['user', '/compact'], ['assistant', 'ok'], ['system', '/compact'],
    ]);
    expect(shown([call])).toEqual([['system', '/compact']]);
    expect(shown([userLine('/context'), call])).toEqual([['user', '/context'], ['system', '/compact']]);
    // One plain entry pairs with one call.
    expect(shown([plain, call, call])).toEqual([['user', '/compact'], ['system', '/compact']]);
  });

  it('wynik `/compact` w pełnym kształcie (magazyn CLI 2.1.263–2.1.299) → notka bez SGR', () => {
    const compacted = `<local-command-stdout>${ESC}[2mCompacted (ctrl+o to see full summary)${ESC}[22m</local-command-stdout>`;
    expect(shown([userLine(compacted)])).toEqual([['system', 'Compacted (ctrl+o to see full summary)']]);
  });

  it('`/clear` → notka komendy, pusty wynik nie jest niczym', () => {
    expect(shown(pick(commands('rename-clear-2.1.302.jsonl'), 17, 19))).toEqual([['system', '/clear']]);
  });

  it('`/rename x` → notki, przypomnienie systemowe `isMeta` znika', () => {
    expect(shown(pick(commands('rename-clear-2.1.302.jsonl'), 3, 5))).toEqual([
      ['system', '/rename pomiar-e1'], ['system', 'Session renamed to: pomiar-e1'],
    ]);
  });

  it('wywołanie skilla (`/doctor`, CLI 2.1.294) → wiadomość `user`; treść skilla `isMeta` znika', () => {
    const messages = parse(commands('skill-doctor-2.1.294.jsonl')).messages;
    expect(messages).toEqual([{
      role: 'user', blocks: [{ type: 'text', text: '/doctor' }], at: '2026-10-08T14:50:41.045Z',
      command: { part: 'invocation', name: 'doctor' },
    }]);
  });

  /*
   * Kształt wywołania komendy typu prompt i znacznik wejścia tury z pomiaru 2.1.294
   * (`commands/measured/skill-doctor-2.1.294.jsonl`: `<command-message>`, `<command-name>`, bez `<command-args>`
   * przy wywołaniu bez argumentów). Nazwa spoza rejestru jest promptem wyłącznie ze
   * znacznikiem; bez niego zostaje notką `system` (wariant bezpieczniejszy dla stanu tury, `docs/slash-commands.md`).
   */
  const skillCall = (name: string, args: string | null, extra: Record<string, unknown> = {}): string => userLine(
    `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>`
      + (args === null ? '' : `\n<command-args>${args}</command-args>`),
    extra,
  );
  const HUMAN = { origin: { kind: 'human' }, turnOrigin: 'human' };

  it('skill z dysku z argumentem i znacznikiem wejścia tury → wiadomość `user` „/nazwa args”', () => {
    expect(shown([skillCall('codex', 'test', HUMAN)])).toEqual([['user', '/codex test']]);
    expect(shown([skillCall('pr-review-toolkit:review-pr', 'PR 12\ndrugi wiersz', { turnOrigin: 'human' })]))
      .toEqual([['user', '/pr-review-toolkit:review-pr PR 12\ndrugi wiersz']]);
  });

  it('nazwa spoza rejestru BEZ znacznika wejścia tury → notka `system`; wbudowany skill → `user` zawsze', () => {
    expect(shown([skillCall('nieznana-komenda', null)])).toEqual([['system', '/nieznana-komenda']]);
    expect(shown([skillCall('code-review', 'ultra-szybko')])).toEqual([['user', '/code-review ultra-szybko']]);
    expect(shown([skillCall('init', null)])).toEqual([['user', '/init']]);
    // Komenda lokalna z rejestru zostaje notką, nawet gdyby CLI kiedyś dało jej znacznik wejścia tury.
    expect(shown([skillCall('context', null, HUMAN)])).toEqual([['system', '/context']]);
  });

  /*
   * Rejestr na dowodach: `kind` stoi tylko na zamkniętej liście pomiaru żywego,
   * reszta to `panel`. `/team-onboarding` zmierzono jako `prompt`, więc zostaje dymkiem człowieka; `/statusline`
   * typu nie ma (pomiar zmieniałby ustawienia), więc jego wywołanie jest notką `system` zamiast dymka `user`.
   * Znacznik wejścia tury nie zmienia roli nazwy z rejestru.
   */
  it('`/team-onboarding` (zmierzony `prompt`) → `user`; `/statusline` (bez pomiaru, `panel`) → `system`', () => {
    for (const turnInput of [false, true]) {
      expect(userEntryNote('<command-name>/team-onboarding</command-name>', turnInput), `${turnInput}`)
        .toMatchObject({ role: 'user', part: 'invocation', name: 'team-onboarding' });
      expect(userEntryNote('<command-name>/statusline</command-name>\n<command-args>x</command-args>', turnInput))
        .toMatchObject({ role: 'system', part: 'invocation', name: 'statusline', text: { text: '/statusline x' } });
    }
    expect(shown([skillCall('statusline', null, HUMAN)])).toEqual([['system', '/statusline']]);
    expect(shown([skillCall('team-onboarding', null)])).toEqual([['user', '/team-onboarding']]);
  });

  /*
   * The roles of all command fixture entries, pinned here. The evidence-based registry must not change any of
   * them; a role change is a question for the user, not an assertion fix.
   */
  it('command fixture entry roles stay as recorded: `user` only where it was', () => {
    const FILES = [
      'commands/measured/config-plugin-cd-2.1.302.jsonl', 'commands/measured/kandydaci-allow-listy-2.1.302.jsonl',
      'commands/measured/nieznane-sciezki-plan-context-2.1.302.jsonl',
      'commands/measured/prompt-block-prawdziwy-2.1.302.jsonl', 'commands/measured/prompt-block-quote-fidelity-2.1.303.jsonl',
      'commands/measured/prompt-block-queued-dequeue-2.1.303.jsonl',
      'commands/measured/prompt-block-queued-absorbed-2.1.303.jsonl', 'commands/measured/prompt-block-json-reply-2.1.303.jsonl',
      'commands/measured/prompt-block-slash-commands-2.1.303.jsonl', 'commands/measured/rename-clear-2.1.302.jsonl',
      'commands/measured/skill-doctor-2.1.294.jsonl', 'queue/measured/compact-2.1.299.jsonl',
      'queue/measured/compact.jsonl',
    ];
    const roles = FILES.flatMap((file) => readFileSync(join(FIXTURES, file), 'utf8').split('\n')
      .flatMap((raw, index) => {
        const parsed = parseImportLine(raw);
        return parsed === null ? [] : [[`${file}:${index + 1}`, parsed.role] as const];
      }));
    expect(roles).toHaveLength(62);
    expect(roles.filter(([, role]) => role === 'user').map(([at]) => at)).toEqual([
      'commands/measured/config-plugin-cd-2.1.302.jsonl:8',
      ...[4, 5, 6, 9, 10, 11].map((n) => `commands/measured/nieznane-sciezki-plan-context-2.1.302.jsonl:${n}`),
      'commands/measured/prompt-block-queued-dequeue-2.1.303.jsonl:2',
      'commands/measured/prompt-block-queued-absorbed-2.1.303.jsonl:2',
      'commands/measured/prompt-block-queued-absorbed-2.1.303.jsonl:7',
      'commands/measured/prompt-block-json-reply-2.1.303.jsonl:8',
      'commands/measured/rename-clear-2.1.302.jsonl:10',
      'commands/measured/skill-doctor-2.1.294.jsonl:1',
      ...[1, 5, 14].map((n) => `queue/measured/compact-2.1.299.jsonl:${n}`),
      ...[1, 13].map((n) => `queue/measured/compact.jsonl:${n}`),
    ]);
    expect(roles.filter(([, role]) => role !== 'user').every(([, role]) => role === 'system')).toBe(true);
  });

  it('`conversational`: wypowiedź tak, notka komendy nie (rozpoznanie `/clear` od `/resume`)', () => {
    const flags = [
      pick(CONFIG, 1)[0], pick(CONFIG, 2)[0], pick(PLAN_CONTEXT, 1)[0], skillCall('codex', 'x', HUMAN),
      pick(CONFIG, 8)[0], userLine('<command-message>x</command-message>'),
    ].map((raw) => parseImportLine(raw ?? '')?.conversational);
    expect(flags).toEqual([false, false, false, true, true, false]);
  });

  it('sidechain ze znacznikiem komendy → nic', () => {
    expect(shown([userLine('<command-name>/context</command-name>', { isSidechain: true })])).toEqual([]);
    const sidechain = JSON.parse(pick(CONFIG, 1)[0] ?? '{}') as Record<string, unknown>;
    expect(parseImportLine(JSON.stringify({ ...sidechain, isSidechain: true }))).toBeNull();
  });

  it('wynik na stderr i wynik ponad sufit: notka ucięta znakiem nożyczek, znak UTF-8 nie pęka', () => {
    expect(shown([userLine('<local-command-stderr>błąd: brak pliku</local-command-stderr>')]))
      .toEqual([['system', 'błąd: brak pliku']]);
    const long = `<local-command-stdout>${'żółw '.repeat(4_000)}</local-command-stdout>`;
    const text = shown([userLine(long)])[0]?.[1] ?? '';
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(COMMAND_OUTPUT_MAX_BYTES);
    expect(text.endsWith(`\n${COMMAND_OUTPUT_CLIP}`)).toBe(true);
    expect(text).not.toContain('�');
  });

  it('notka komendy rozcina sklejaną turę asystenta', () => {
    const result = parse([
      assistantLine([{ type: 'text', text: 'pierwsza' }]), ...pick(CONFIG, 1, 2),
      assistantLine([{ type: 'text', text: 'druga' }]),
    ]);
    expect(result.messages.map((m) => m.role)).toEqual(['assistant', 'system', 'system', 'assistant']);
  });

  it('ultracode: pierwsza tura z ultracode — treść skilla `workflow-authoring` (`isMeta`) to nic', () => {
    const messages = shown(fixture('ultracode/pierwsza-tura-skill.jsonl'));
    expect(messages).toEqual([
      ['system', '/effort'],
      ['system', 'Cancelled'],
      ['system', '/effort status'],
      ['system', 'Current effort level: xhigh (Deeper reasoning than high, just below maximum (on supported models))'
        + ' · Ultracode on'],
      ['user', 'ZESTAW-KONTROLNY-TURA: odpowiedz jednym słowem.'],
      ['assistant', 'ok'],
    ]);
    expect(JSON.stringify(messages)).not.toMatch(/workflow-authoring|Workflow authoring/);
  });
});

/*
 * Prompt zablokowany przez hook `UserPromptSubmit` (`docs/dialogs.md`). Kształt
 * wpisu z pomiaru (`commands/measured/prompt-block-*.jsonl`); tu przypadki brzegowe reguły cytatu.
 */
describe('prompt zablokowany przez hook (część `prompt-blocked`)', () => {
  const blockedLine = (opts: {
    reason: string; label?: string; prompt?: string; kind?: string; promptKept?: boolean;
  }): string => line({
    type: 'system', subtype: 'informational', level: 'warning', isMeta: false, preventContinuation: true,
    content: `UserPromptSubmit operation blocked by hook:\n${opts.label ?? '[/h.sh]: '}${opts.reason}`
      + (opts.prompt === undefined ? '' : `\n\nOriginal prompt: ${opts.prompt}`),
    promptSubmitEnding: {
      ending: { kind: opts.kind ?? 'blocked_by_hook', reason: opts.reason }, promptKept: opts.promptKept ?? false,
    },
    timestamp: '2026-10-19T17:01:43.552Z',
  });

  it('notka: tytuł, powód bez sekwencji terminala, cytat; wpis nie jest wypowiedzią', () => {
    const parsed = parseImportLine(blockedLine({ reason: `${ESC}[31mzły powód${ESC}[0m  \nlinia 2`, prompt: 'zrób to' }));
    expect(parsed).toMatchObject({ role: 'system', conversational: false });
    expect(parsed?.message?.promptBlocked).toEqual({ reason: 'zły powód\nlinia 2', promptKept: false, prompt: 'zrób to' });
    expect(parsed?.message?.blocks).toEqual([{
      type: 'text', text: "⚠ A hook blocked the prompt. It wasn't sent.\nzły powód\nlinia 2\nPrompt: zrób to",
      ref: { code: 'commands.prompt-blocked.reason-and-prompt', args: ['zły powód\nlinia 2', 'zrób to'] },
    }]);
  });

  it('cytat: pierwszy separator ZA końcem powodu, także gdy powód sam go zawiera', () => {
    const parsed = parseImportLine(blockedLine({ reason: 'zły\n\nOriginal prompt: w powodzie', prompt: 'prawdziwy' }));
    expect(parsed?.message?.promptBlocked?.prompt).toBe('prawdziwy');
  });

  it('bez separatora cytatu nie ma; odpowiedź JSON (`decision: block`) bez etykiety hooka też jest blokadą', () => {
    expect(parseImportLine(blockedLine({ reason: 'powód' }))?.message?.promptBlocked)
      .toEqual({ reason: 'powód', promptKept: false });
    expect(parseImportLine(blockedLine({ reason: 'json', label: '', prompt: 'p' }))?.message?.promptBlocked?.prompt)
      .toBe('p');
  });

  it('cytat przechodzi przez `humanTextOf`: obwódka wklejki i `[Image #N]` zdjęte', () => {
    const pasted = '[Image #1] \n\n<pasted_content id="a1b2">\nlinia 1\nlinia 2\n</pasted_content id="a1b2">\n';
    expect(parseImportLine(blockedLine({ reason: 'r', prompt: pasted }))?.message?.promptBlocked?.prompt)
      .toBe('linia 1\nlinia 2');
  });

  it('inny rodzaj końca promptu (`stopped_by_hook`, rodzaj spoza pomiaru) i wyłącznik → pomijany jak dawniej', () => {
    expect(parseImportLine(blockedLine({ reason: 'r', kind: 'stopped_by_hook', promptKept: true }))).toBeNull();
    expect(parseImportLine(blockedLine({ reason: 'r', kind: 'inny_rodzaj' }))).toBeNull();
    expect(parseImportLine(blockedLine({ reason: 'r', prompt: 'p' }), { promptBlock: false })).toBeNull();
  });

  it('historia: notka stoi na swojej pozycji i rozcina turę asystenta; wyłącznik w `parseTranscriptTail`', () => {
    const assistant = line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } });
    const text = [assistant, blockedLine({ reason: 'r', prompt: 'p' }), assistant].join('\n');
    expect(parseTranscriptTail(text, { dropFirstLine: false }).messages.map((m) => m.role))
      .toEqual(['assistant', 'system', 'assistant']);
    expect(parseTranscriptTail(text, { dropFirstLine: false, promptBlock: false }).messages.map((m) => m.role))
      .toEqual(['assistant']);
  });
});

describe('importTranscript — odczyt z dysku', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rarog-import-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeTranscript(content: string, engineId = ENGINE_ID): Promise<void> {
    const dir = join(root, projectSlug(CWD));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${engineId}.jsonl`), content, 'utf8');
  }

  it('brak pliku to pusta historia, a nie wyjątek', async () => {
    const result = await importTranscript(CWD, ENGINE_ID, { root });
    expect(result).toEqual({ messages: [] });
  });

  it('plik 0 B to pusta historia', async () => {
    await writeTranscript('');
    expect((await importTranscript(CWD, ENGINE_ID, { root })).messages).toHaveLength(0);
  });

  it('czyta wiadomości i metadane z pliku mieszczącego się w limicie', async () => {
    await writeTranscript([
      userLine('Napraw zapis.'),
      assistantLine([{ type: 'text', text: 'Robi się.' }], { effort: 'high' }),
      '',
    ].join('\n'));

    const result = await importTranscript(CWD, ENGINE_ID, { root });
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(result.model).toBe('claude-fable-5');
    expect(result.effort).toBe('high');
  });

  it('plik ponad limitem czyta tylko OGON (pierwsza, ucięta linia przepada)', async () => {
    // Wypełniacz jest większy niż limit, więc początek pliku fizycznie nie może się zmieścić.
    const filler = Array.from(
      { length: 400 },
      (_, i) => userLine(`stara wiadomość ${String(i)} ${'x'.repeat(6000)}`),
    );
    const tail = [userLine('przedostatnia'), userLine('ostatnia')];
    const content = [...filler, ...tail].join('\n');
    expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(MAX_IMPORT_BYTES);
    await writeTranscript(content);

    const result = await importTranscript(CWD, ENGINE_ID, { root });
    const texts = result.messages.map((m) => (m.blocks[0] as { text: string }).text);
    expect(texts.at(-1)).toBe('ostatnia');
    expect(texts.at(-2)).toBe('przedostatnia');
    // Ogon to ~2 MB, czyli nigdy cały plik — wiadomości z początku nie ma.
    expect(texts.some((t) => t.startsWith('stara wiadomość 0 '))).toBe(false);
  });

  it('mały `maxBytes` też odcina początek i nie wywraca parsera', async () => {
    await writeTranscript([userLine('pierwsza'), userLine('druga'), userLine('trzecia')].join('\n'));
    const result = await importTranscript(CWD, ENGINE_ID, { root, maxBytes: 200 });
    const texts = result.messages.map((m) => (m.blocks[0] as { text: string }).text);
    expect(texts).not.toContain('pierwsza');
    expect(texts.at(-1)).toBe('trzecia');
  });

  it('identyfikator sesji z traversalem nie czyta żadnego pliku', async () => {
    await writeTranscript(userLine('tajne'), 'sekret');
    for (const bad of ['../sekret', '..%2Fsekret', 'a/b', '/etc/passwd', '']) {
      expect((await importTranscript(CWD, bad, { root })).messages).toHaveLength(0);
    }
  });

  it('katalog zamiast pliku nie wywraca importu', async () => {
    await mkdir(join(root, projectSlug(CWD), `${ENGINE_ID}.jsonl`), { recursive: true });
    expect((await importTranscript(CWD, ENGINE_ID, { root })).messages).toHaveLength(0);
  });
});
