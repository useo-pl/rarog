/**
 * Terminal PTY — PARSER strumienia NDJSON kontrolera herdr.
 *
 * `herdr terminal session control <pane>` wypisuje na stdout po jednej ramce JSON w linii:
 * `{"type":"terminal.frame","seq":N,"full":bool,"width":N,"height":N,"encoding":"ansi",
 * "bytes":"<base64>"}` oraz `{"type":"terminal.closed","reason":"…"}` (kształt zweryfikowany
 * na żywym herdr 0.8.2).
 *
 * Moduł jest CZYSTY z premedytacją: żadnego procesu, żadnego gniazda, żadnego dysku — sam
 * bufor i `JSON.parse`. Dzięki temu granica „linia ucięta na granicy pakietu" i „śmieci
 * w strumieniu" ma test bez binarki herdr, a backend (`herdr-backend.ts`) zajmuje się
 * wyłącznie procesem.
 *
 * **Zero logowania treści.** Bajty ekranu przechodzą przez ten moduł i nie mają prawa trafić
 * ani do logu, ani do żadnego callbacku diagnostycznego: `onSkip` dostaje POWÓD i DŁUGOŚĆ,
 * nigdy samą linię. To nie jest ostrożność stylistyczna — linia niesie zawartość ekranu
 * powłoki („zero logowania treści").
 */
import { StringDecoder } from 'node:string_decoder';

/** Ramka z bajtami ekranu. `full` = pełne odmalowanie (kontroler wysyła je na starcie). */
export interface TermHerdrFrame {
  readonly kind: 'frame';
  readonly full: boolean;
  /** Zdekodowane bajty ANSI — dokładnie to, co idzie do gniazda WS jako ramka binarna. */
  readonly bytes: Buffer;
}

/** Kontroler kończy pracę: panel zamknięty, powłoka padła albo przejął nas `--takeover`. */
export interface TermHerdrClosed {
  readonly kind: 'closed';
  readonly reason: string;
}

export type TermHerdrEvent = TermHerdrFrame | TermHerdrClosed;

/**
 * Sufit długości JEDNEJ linii NDJSON (8 MB).
 *
 * Bufor sklejający bez sufitu rośnie tak długo, jak długo druga strona wysyła bajty bez `\n`
 * — czyli awaria kontrolera zjadałaby pamięć Raroga bez granicy. 8 MB to zapas rzędu
 * wielkości nad największą realną ramką: pełne odmalowanie ekranu 200×60 z kolorami to
 * kilkadziesiąt kB base64.
 *
 * Przekroczenie NIE rzuca (inaczej niż `LineSplitter` w `herdr/socket.ts`): jesteśmy
 * w handlerze `data` procesu potomnego, gdzie wyjątek zabija proces serwera. Bufor idzie do
 * kosza, a wołający dostaje `onSkip` — kontroler i tak zaraz padnie albo przyśle pełną ramkę.
 */
export const HERDR_STREAM_LINE_MAX = 8 * 1024 * 1024;

export interface HerdrStreamReaderOptions {
  /** Rozpoznana ramka. */
  onEvent(event: TermHerdrEvent): void;
  /**
   * Linia pominięta — POWÓD i długość, nigdy treść (patrz nagłówek pliku).
   *
   * Pominięcie jest normalnym stanem, a nie awarią: herdr dokłada typy ramek addytywnie,
   * a Rarog nie ma prawa paść od nowego `type`.
   */
  onSkip(reason: string, length: number): void;
}

export interface HerdrStreamReader {
  /** Dokłada fragment stdout kontrolera; kompletne linie wychodzą callbackami. */
  push(chunk: Buffer | string): void;
  /** Niedokończona linia — wyłącznie diagnostyka i testy urwanego strumienia. */
  readonly pending: number;
}

/**
 * Jedna linia → zdarzenie albo `null` (linia nie jest ramką, którą Rarog rozumie).
 *
 * Eksportowane osobno od czytnika, bo to tutaj mieszka cała wiedza o kształcie protokołu
 * i to ją sprawdza test — czytnik dokłada wyłącznie sklejanie pakietów.
 */
export function parseHerdrStreamLine(line: string): TermHerdrEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const type = record['type'];

  if (type === 'terminal.closed') {
    const reason = record['reason'];
    return { kind: 'closed', reason: typeof reason === 'string' ? reason : '' };
  }

  if (type !== 'terminal.frame') return null;
  /*
   * Nieznane kodowanie odpada, zamiast lecieć do xterma jako bajty ANSI: dziś herdr wysyła
   * wyłącznie `ansi`, a gdyby dołożył drugie (np. skompresowane), przepuszczenie go dałoby
   * na ekranie śmieci nie do zdiagnozowania.
   */
  const encoding = record['encoding'];
  if (encoding !== undefined && encoding !== 'ansi') return null;
  const bytes = record['bytes'];
  if (typeof bytes !== 'string') return null;
  return { kind: 'frame', full: record['full'] === true, bytes: Buffer.from(bytes, 'base64') };
}

/**
 * Czytnik sklejający pakiety stdout w linie NDJSON.
 *
 * `StringDecoder`, a nie `chunk.toString()`: `reason` bywa po polsku, a pakiet potrafi
 * przeciąć znak wielobajtowy — bez dekodera ostatni bajt zamieniałby się w `�` i psuł
 * `JSON.parse` całej linii.
 */
export function createHerdrStreamReader(opts: HerdrStreamReaderOptions): HerdrStreamReader {
  const decoder = new StringDecoder('utf8');
  let buffer = '';

  return {
    push(chunk: Buffer | string): void {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const trimmed = line.trim();
        if (trimmed !== '') {
          const event = parseHerdrStreamLine(trimmed);
          if (event === null) opts.onSkip('line is not a known herdr frame', trimmed.length);
          else opts.onEvent(event);
        }
        index = buffer.indexOf('\n');
      }
      // Sufit dotyczy OGONA, nie pakietu: pakiet z wieloma kompletnymi liniami wolno mieć
      // większy niż limit i jest zupełnie poprawny.
      if (buffer.length > HERDR_STREAM_LINE_MAX) {
        const length = buffer.length;
        buffer = '';
        opts.onSkip('line over the length cap — buffer dropped', length);
      }
    },
    get pending(): number {
      return buffer.length;
    },
  };
}
