/**
 * Terminal PTY — parser strumienia NDJSON kontrolera herdr.
 *
 * Bez procesu, bez gniazda i bez binarki: cały plik karmi czysty czytnik bajtami, bo dokładnie
 * tam mieszkają rzeczy, które na żywym herdr zdarzają się raz na tysiąc pakietów — ramka
 * przecięta na granicy chunku, znak UTF-8 przecięty na granicy chunku i śmieć w linii.
 *
 * Osobno pilnowany niezmiennik: pominięta linia nie ma prawa wyjść na zewnątrz TREŚCIĄ.
 * Callback diagnostyczny dostaje powód i długość — nigdy sam tekst, bo tekst jest zawartością
 * ekranu powłoki („zero logowania treści").
 */
import { describe, expect, it } from 'vitest';
import {
  HERDR_STREAM_LINE_MAX, createHerdrStreamReader, parseHerdrStreamLine,
} from '../src/term/herdr-stream.ts';
import type { TermHerdrEvent } from '../src/term/herdr-stream.ts';

/** Ramka `terminal.frame` w kształcie, który wysyła herdr 0.8.2. */
function frameLine(text: string, opts: { full?: boolean; seq?: number } = {}): string {
  return `${JSON.stringify({
    type: 'terminal.frame',
    seq: opts.seq ?? 1,
    full: opts.full ?? false,
    width: 80,
    height: 24,
    encoding: 'ansi',
    bytes: Buffer.from(text, 'utf8').toString('base64'),
  })}\n`;
}

interface Collected {
  events: TermHerdrEvent[];
  skips: { reason: string; length: number }[];
  push(chunk: Buffer | string): void;
  pending(): number;
}

function collector(): Collected {
  const events: TermHerdrEvent[] = [];
  const skips: { reason: string; length: number }[] = [];
  const reader = createHerdrStreamReader({
    onEvent: (event) => { events.push(event); },
    onSkip: (reason, length) => { skips.push({ reason, length }); },
  });
  return {
    events,
    skips,
    push: (chunk) => { reader.push(chunk); },
    pending: () => reader.pending,
  };
}

describe('parseHerdrStreamLine — kształt protokołu', () => {
  it('ramka pełna i różnicowa niosą zdekodowane bajty', () => {
    // `\u001B` zapisem, nie surowym bajtem — źródła repo nie noszą znaków sterujących.
    const clear = '\u001B[2Jekran';
    const full = parseHerdrStreamLine(frameLine(clear, { full: true }).trim());
    expect(full).toEqual({ kind: 'frame', full: true, bytes: Buffer.from(clear, 'utf8') });
    const diff = parseHerdrStreamLine(frameLine('ls\r\n').trim());
    expect(diff?.kind).toBe('frame');
    if (diff?.kind === 'frame') expect(diff.full).toBe(false);
  });

  it('base64 z polskimi znakami wraca bajt w bajt', () => {
    const event = parseHerdrStreamLine(frameLine('zażółć gęślą jaźń').trim());
    expect(event?.kind).toBe('frame');
    if (event?.kind === 'frame') expect(event.bytes.toString('utf8')).toBe('zażółć gęślą jaźń');
  });

  it('`terminal.closed` niesie powód (a brak powodu to pusty string, nie wyjątek)', () => {
    expect(parseHerdrStreamLine('{"type":"terminal.closed","reason":"taken over"}'))
      .toEqual({ kind: 'closed', reason: 'taken over' });
    expect(parseHerdrStreamLine('{"type":"terminal.closed"}'))
      .toEqual({ kind: 'closed', reason: '' });
  });

  it('nieznany typ, nieznane kodowanie i brak bajtów są POMIJANE, nie rzucają', () => {
    // herdr dokłada typy ramek addytywnie — Rarog nie ma prawa paść od nowego `type`.
    expect(parseHerdrStreamLine('{"type":"terminal.hello","protocol":1}')).toBeNull();
    /*
     * Nieznane kodowanie odpada zamiast lecieć do xterma jako ANSI: gdyby herdr dołożył
     * drugie (np. skompresowane), przepuszczenie dałoby na ekranie śmieci nie do
     * zdiagnozowania.
     */
    expect(parseHerdrStreamLine('{"type":"terminal.frame","encoding":"zip","bytes":"AA=="}'))
      .toBeNull();
    expect(parseHerdrStreamLine('{"type":"terminal.frame","encoding":"ansi"}')).toBeNull();
  });

  it('śmieć (nie-JSON, tablica, null) daje `null`', () => {
    expect(parseHerdrStreamLine('to nie jest json')).toBeNull();
    expect(parseHerdrStreamLine('[1,2,3]')).toBeNull();
    expect(parseHerdrStreamLine('null')).toBeNull();
  });
});

describe('createHerdrStreamReader — sklejanie pakietów', () => {
  it('ramka ucięta na granicy chunku wychodzi dopiero z domknięciem linii', () => {
    const c = collector();
    const line = frameLine('ekran');
    c.push(line.slice(0, 20));
    expect(c.events).toHaveLength(0);
    expect(c.pending()).toBeGreaterThan(0);
    c.push(line.slice(20));
    expect(c.events).toHaveLength(1);
    expect(c.pending()).toBe(0);
  });

  it('znak UTF-8 przecięty między pakietami nie psuje JSON-a', () => {
    const c = collector();
    // `reason` po polsku: bez `StringDecoder` ostatni bajt „ą" zamieniłby się w `�`
    // i `JSON.parse` całej linii by padł.
    const raw = Buffer.from('{"type":"terminal.closed","reason":"powłoka zakończona"}\n', 'utf8');
    const cut = 40;
    c.push(raw.subarray(0, cut));
    c.push(raw.subarray(cut));
    expect(c.events).toEqual([{ kind: 'closed', reason: 'powłoka zakończona' }]);
  });

  it('wiele ramek w jednym pakiecie wychodzi po kolei', () => {
    const c = collector();
    c.push(`${frameLine('a', { seq: 1 })}${frameLine('b', { seq: 2 })}`);
    expect(c.events).toHaveLength(2);
  });

  it('śmieć w linii jest POMIJANY, a reszta strumienia leci dalej', () => {
    const c = collector();
    c.push(`nie-json\n${frameLine('ekran')}`);
    expect(c.skips).toHaveLength(1);
    expect(c.events).toHaveLength(1);
  });

  it('callback pominięcia dostaje POWÓD i długość — nigdy treści linii', () => {
    const c = collector();
    // Tekst, który nie ma prawa nigdzie wyciec: linia niesie zawartość ekranu powłoki.
    c.push('{"type":"terminal.frame","bytes":123,"tajne":"HASŁO-DO-BAZY"}\n');
    expect(c.skips).toHaveLength(1);
    expect(JSON.stringify(c.skips)).not.toContain('HASŁO');
    expect(c.skips[0]?.length).toBeGreaterThan(10);
  });

  it('puste linie nie są ani zdarzeniem, ani pominięciem', () => {
    const c = collector();
    c.push('\n\n   \n');
    expect(c.events).toHaveLength(0);
    expect(c.skips).toHaveLength(0);
  });

  /*
   * Sufit bez wyjątku: jesteśmy w handlerze `data` procesu potomnego, gdzie rzucony wyjątek
   * kładzie CAŁY serwer. Bufor idzie do kosza, a wołający dostaje pominięcie.
   */
  it('linia bez końca ponad sufitem wyrzuca bufor zamiast rosnąć w nieskończoność', () => {
    const c = collector();
    c.push('x'.repeat(HERDR_STREAM_LINE_MAX + 1));
    expect(c.skips).toHaveLength(1);
    expect(c.skips[0]?.reason).toContain('cap');
    expect(c.pending()).toBe(0);
  });
});
