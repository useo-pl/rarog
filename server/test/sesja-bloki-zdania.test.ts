/**
 * Stan sesji, bloki wewnętrzne transkryptu i powiadomienia niosą zdanie, nie goły napis.
 *
 * - `Session.stateDetail` to zdanie własne (`say`); na drut (`SessionSummary.stateDetail`) idzie jego tekst.
 * - Zdarzenia drivera `message` i `history` niosą `InternalBlock`: tekst bloku ma pochodzenie, a `Block` z drutu
 *   powstaje w jednym miejscu, `Session.appendMessage` (`wireBlocks`). Zdanie z kodem zostawia `ref` po stronie
 *   serwera (`blockRef`), a blok przycięty przez `clampMessageBlocks` traci go.
 * - `clipForDisplay` tnie tekst w jednostkach UTF-16, a ucięcie liczy w skalarach Unicode; ucięcie zostaje
 *   wewnętrzne, drut go nie zna.
 * - Import pliku rozmowy: treść człowieka i agenta to `foreign`, zastępnik obrazka `[image]` — zdanie z kodem.
 *
 * Linie z `@ts-expect-error` to sprawdzian typu: gdyby pole albo blok przyjęły
 * napis, `tsc` zgłosi nieużyte `@ts-expect-error`.
 */
import { describe, expect, it } from 'vitest';
import type { Block } from '@rarog/shared';
import {
  createSay, foreign, isForeignText, isServerSentence,
} from '@rarog/shared/sentences';
import type { SentenceArea } from '@rarog/shared/sentences';
import {
  MAX_DISPLAY_TEXT, MAX_TOOL_DETAIL, clipForDisplay, permissionSemantics, truncationFooter,
} from '../src/drivers/tool-text.ts';
import type { DriverEvent, InternalBlock } from '../src/drivers/types.ts';
import { promptBlockedText } from '../src/herdr/commands/transcript.ts';
import { MAX_MESSAGE_BYTES } from '../src/sessions/ring-buffer.ts';
import { MESSAGE_TRIMMED_MARK, Session, blockRef, clampMessageBlocks, wireBlocks } from '../src/sessions/session.ts';
import { MAX_TURNS_DETAIL } from '../src/sessions/state-machine.ts';
import { IMAGE_PLACEHOLDER, parseTranscriptTail } from '../src/transcript-import.ts';

/** Rejestr testowy: test nie zależy od wpisów produkcyjnego obszaru `session`. */
const TEST_SENTENCES = {
  'session.restarted': { en: 'Session restarted.' },
  'session.waiting-for': { en: 'Waiting for {tool}.', args: ['tool:text'] },
} as const satisfies SentenceArea;
const testSay = createSay(TEST_SENTENCES);

const iso = (offset: number): string => new Date(1_756_000_000_000 + offset).toISOString();

function newSession(): Session {
  return new Session({
    id: 'sess-l3', cwd: '/Users/x/Projects/rarog', title: 'rarog', state: 'running',
    stateSince: iso(0), createdAt: iso(0), lastActivityAt: iso(0),
  });
}

describe('Session.stateDetail niesie zdanie', () => {
  it('na drut idzie tekst zdania i jego `stateDetailRef`; brak zdania → żadnego pola', () => {
    const session = newSession();
    session.stateDetail = testSay('session.restarted');
    expect(session.summary().stateDetail).toBe('Session restarted.');
    expect(session.summary().stateDetailRef).toEqual({ code: 'session.restarted' });
    session.stateDetail = undefined;
    expect(session.summary()).not.toHaveProperty('stateDetail');
  });

  it('stała dopisku limitu tur to zdanie z kodem (`state.max-turns`)', () => {
    expect(isServerSentence(MAX_TURNS_DETAIL)).toBe(true);
    expect(MAX_TURNS_DETAIL.ref).toEqual({ code: 'state.max-turns' });
  });

  it('goły napis jako dopisek stanu się nie kompiluje (mutacja 3)', () => {
    const session = newSession();
    // @ts-expect-error — dopisek stanu to zdanie (`say`), nie napis.
    session.stateDetail = 'literał';
    // @ts-expect-error — tekst obcy też nie: dopisek stanu mówi Rarog.
    session.stateDetail = foreign('treść agenta');
    expect(session).toBeDefined();
  });
});

describe('bloki wewnętrzne → bloki z drutu (`wireBlocks`, `appendMessage`)', () => {
  it('blok `text` z bloku wewnętrznego zdarzenia drivera się nie kompiluje z gołym napisem (mutacja 4)', () => {
    const event: DriverEvent = {
      type: 'message', role: 'system',
      // @ts-expect-error — tekst bloku wewnętrznego to `say` albo `foreign`, nie napis.
      blocks: [{ type: 'text', text: 'Session restarted.' }],
    };
    const history: DriverEvent = {
      type: 'history',
      // @ts-expect-error — to samo w porcji historii.
      messages: [{ role: 'assistant', at: iso(0), blocks: [{ type: 'text', text: 'treść' }] }],
    };
    expect([event, history]).toHaveLength(2);
  });

  it('zdanie z kodem wychodzi z `ref`, literał i treść obca bez; ucięcie `detail` jedzie przy `detail`', () => {
    const blocks: InternalBlock[] = [
      { type: 'text', text: testSay('session.waiting-for', { tool: 'Bash' }) },
      { type: 'text', text: foreign('[obraz]') },
      { type: 'text', text: foreign('zdanie agenta') },
      { type: 'tool-call', toolName: 'Bash', summary: 'ls', detail: 'ls', truncation: { cut: 3, footer: 2 } },
      { type: 'image', dataUrl: 'data:image/png;base64,AAAA' },
    ];
    const wire = wireBlocks(blocks);
    expect(wire).toStrictEqual([
      { type: 'text', text: 'Waiting for Bash.', ref: { code: 'session.waiting-for', args: ['Bash'] } },
      { type: 'text', text: '[obraz]' },
      { type: 'text', text: 'zdanie agenta' },
      { type: 'tool-call', toolName: 'Bash', summary: 'ls', detail: 'ls', truncation: { cut: 3, footer: 2 } },
      { type: 'image', dataUrl: 'data:image/png;base64,AAAA' },
    ]);
    expect(blockRef(wire[0] as Block)).toEqual({ code: 'session.waiting-for', args: ['Bash'] });
    expect(blockRef(wire[1] as Block)).toBeUndefined();
    expect(blockRef(wire[2] as Block)).toBeUndefined();
  });

  it('wiadomość w transkrypcie i w ramce SSE ma bloki z drutu, a zdanie z kodem niesie `ref`', () => {
    const session = newSession();
    const blocks: InternalBlock[] = [{ type: 'text', text: testSay('session.restarted') }];
    const { message, event } = session.appendMessage('system', blocks, iso(1));
    expect(message.blocks).toStrictEqual([{ type: 'text', text: 'Session restarted.', ref: { code: 'session.restarted' } }]);
    expect(JSON.stringify(event)).toContain('"ref":{"code":"session.restarted"}');
    expect(blockRef(message.blocks[0] as Block)).toEqual({ code: 'session.restarted' });
  });

  it('blok przycięty traci `ref`; znacznik przycięcia to osobny blok ze swoim `ref` (mutacja 13)', () => {
    const session = newSession();
    const long = testSay('session.waiting-for', { tool: 'x'.repeat(MAX_MESSAGE_BYTES * 2) });
    const { message } = session.appendMessage('system', [{ type: 'text', text: long }], iso(1));
    const [cut, mark] = message.blocks;
    expect(cut?.type === 'text' && cut.text.length < long.text.length).toBe(true);
    // Tłumaczenie w apce odtworzyłoby pełny argument, którego przycięty tekst nie pokazuje.
    expect(blockRef(cut as Block)).toBeUndefined();
    expect(mark).toStrictEqual({ type: 'text', text: MESSAGE_TRIMMED_MARK.text, ref: MESSAGE_TRIMMED_MARK.ref });
    // Znacznik to osobny blok ze zdaniem serwera, więc niesie swój `ref` (tekst pokazuje całe zdanie).
    expect(blockRef(mark as Block)).toEqual({ code: 'transcript.trimmed-mark' });
  });

  it('blok, który mieści się w budżecie, przechodzi przez przycięcie z `ref`', () => {
    const fits = wireBlocks([{ type: 'text', text: testSay('session.restarted') }]);
    const huge: Block = { type: 'text', text: 'y'.repeat(MAX_MESSAGE_BYTES) };
    const clamped = clampMessageBlocks([...fits, huge]);
    expect(clamped[0]).toBe(fits[0]);
    expect(blockRef(clamped[0] as Block)).toEqual({ code: 'session.restarted' });
    expect(blockRef(clamped[1] as Block)).toBeUndefined();
  });
});

describe('`clipForDisplay`: tekst na drucie w jednostkach UTF-16, ucięcie w skalarach Unicode', () => {
  it('tekst w limicie wraca bez ucięcia', () => {
    expect(clipForDisplay('abc', 3)).toStrictEqual({ text: 'abc' });
    expect(clipForDisplay('🚀'.repeat(1_000), MAX_TOOL_DETAIL)).toStrictEqual({ text: '🚀'.repeat(1_000) });
  });

  // Próg, cięcie i liczba w stopce idą w jednostkach UTF-16. Gdyby liczyły
  // skalary, 1500 emoji (3000 jednostek) przeszłoby przez próg 2000 nieucięte.
  it('próg, cięcie i stopka w jednostkach UTF-16 na progach 2000 i 20 000; `truncation` w skalarach', () => {
    for (const [text, max] of [
      ['🚀'.repeat(1_001), MAX_TOOL_DETAIL],
      ['🚀'.repeat(1_500), MAX_TOOL_DETAIL],
      [`${'🚀'.repeat(10_001)}abc`, MAX_DISPLAY_TEXT],
    ] as const) {
      const head = text.slice(0, max);
      const footer = truncationFooter(text.length - max).text;
      const clipped = clipForDisplay(text, max);
      expect(clipped.text).toBe(`${head}${footer}`);
      const cut = [...text].length - [...head].length;
      expect(clipped.truncation).toStrictEqual({ cut, footer: [...footer].length });
      const scalars = [...clipped.text];
      expect(scalars.slice(scalars.length - (clipped.truncation?.footer ?? 0)).join('')).toBe(footer);
    }
    expect(clipForDisplay('🚀'.repeat(1_001), MAX_TOOL_DETAIL).text)
      .toBe(`${'🚀'.repeat(1_000)}\n… (2 characters cut off)`);
    expect(isServerSentence(truncationFooter(1))).toBe(true);
  });

  it('komenda dłuższa niż 20 000 jednostek UTF-16 jest ucięta, więc karta zgody nie dostaje `inputKind`', () => {
    const command = '🚀'.repeat(15_000);
    expect(permissionSemantics({ command }, clipForDisplay(command).text)).toStrictEqual({});
    const short = 'ls -la';
    expect(permissionSemantics({ command: short }, clipForDisplay(short).text)).toStrictEqual({ inputKind: 'shell' });
  });
});

describe('import pliku rozmowy: pochodzenie tekstu', () => {
  const line = (value: unknown): string => JSON.stringify(value);
  const user = (content: unknown): string => line({
    type: 'user', message: { role: 'user', content }, isSidechain: false, timestamp: '2026-08-22T10:00:00.000Z',
  });
  const assistant = (content: unknown): string => line({
    type: 'assistant', message: { role: 'assistant', content }, isSidechain: false,
    timestamp: '2026-08-22T10:00:01.000Z',
  });

  it('treść człowieka i agenta to `foreign`, zastępnik obrazka to zdanie z kodem', () => {
    const { messages } = parseTranscriptTail([
      user([{ type: 'text', text: 'zobacz' }, { type: 'image', source: { type: 'base64', data: 'AAAA' } }]),
      assistant([{ type: 'text', text: 'Widzę.' }]),
    ].join('\n'), { dropFirstLine: false });
    const texts = messages.flatMap((m) => m.blocks).flatMap((b) => (b.type === 'text' ? [b.text] : []));
    expect(texts.map((t) => t.text)).toEqual(['zobacz', IMAGE_PLACEHOLDER.text, 'Widzę.']);
    expect(texts.map((t) => (isForeignText(t) ? 'foreign' : (isServerSentence(t) ? 'say' : '?'))))
      .toEqual(['foreign', 'say', 'foreign']);
  });

  it('ucięty `detail` wywołania narzędzia niesie ucięcie także na drucie', () => {
    const { messages } = parseTranscriptTail(assistant([
      { type: 'tool_use', name: 'Bash', input: { command: `echo ${'a'.repeat(3_000)}` } },
    ]), { dropFirstLine: false });
    const [call] = messages[0]?.blocks ?? [];
    expect(call?.type === 'tool-call' && call.truncation !== undefined).toBe(true);
    const [wire] = wireBlocks(messages[0]?.blocks ?? []);
    expect(wire?.type === 'tool-call' ? wire.truncation : null).toEqual(call?.type === 'tool-call' ? call.truncation : 'brak');
    expect(wire?.type === 'tool-call' && wire.detail?.includes('characters cut off)')).toBe(true);
  });
});

describe('notka o prompcie zablokowanym: argumenty przycięte przed złożeniem zdania', () => {
  it('powód ponad 8 KiB jest ucięty w tekście notki, a notka to tekst własny', () => {
    const reason = 'r'.repeat(200 * 1024);
    const note = promptBlockedText(reason, 'p'.repeat(200 * 1024));
    expect(isServerSentence(note) ? note.ref.code : null).toBe('commands.prompt-blocked.reason-and-prompt');
    // Dwa argumenty po 8 KiB i tytuł: argument 200 KiB nie podwaja wiadomości.
    expect(Buffer.byteLength(note.text, 'utf8')).toBeLessThan(3 * 8 * 1024);
  });
});
