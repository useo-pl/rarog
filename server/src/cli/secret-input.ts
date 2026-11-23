/**
 * Wejście sekretu dla `rarog dictation set-key`, bez wartości w argv i w historii powłoki: pytanie bez echa na
 * terminalu ({@link askSecretOn}) albo cały stdin z potoku ({@link readAllOn}). `bin/rarog.mjs` podaje w `CliIo` to,
 * co pasuje do strumieni procesu ({@link secretInput}); testy wołają obie funkcje na atrapach strumieni.
 *
 * Pytanie bez echa: terminal w trybie surowym (`setRawMode(true)`) od chwili po wypisaniu promptu, więc terminal
 * niczego nie pokazuje, a funkcja sama nie wypisuje żadnego wpisanego znaku. Na wyjście idzie tylko prompt i nowa
 * linia na końcu. Enter kończy, Backspace (DEL albo ^H) kasuje ostatni znak (cały znak UTF-8), Ctrl-D = `null`,
 * Ctrl-C = {@link SecretInputInterrupted}, błąd strumienia = odrzucenie z tym błędem. W każdej z tych dróg terminal
 * wraca z trybu surowego, a strumień przestaje płynąć (proces może się skończyć). W trybie surowym Ctrl-C nie daje
 * `SIGINT`, dlatego przerwanie jest odrzuceniem, a kod 130 oddaje komenda.
 *
 * Wklejka kilku linii nie ucina się do pierwszej. Pytanie włącza w terminalu tryb wklejki w znacznikach (bracketed
 * paste, `ESC[?2004h`, na końcu `ESC[?2004l`): terminal otacza wklejkę znacznikami `ESC[200~` i `ESC[201~`, więc
 * Enter w niej zostaje znakiem nowej linii także wtedy, gdy terminal albo sieć podzieli ją na kilka porcji danych.
 * Odpowiedź kończy dopiero Enter poza wklejką. Terminal bez tego trybu wysyła wklejkę bez znaczników: wtedy porcja
 * danych jest czytana do końca, ale wklejka podzielona tuż po Enterze kończy się na nim, a reszta trafia na ekran
 * i do powłoki. Końcowe Entery odpadają; wołający dostaje tekst z nową linią w środku i odmawia.
 */
import type { CliIo } from './io.ts';

/** Sufit wartości sekretu w bajtach (wejście przed przycięciem). */
export const SECRET_MAX_BYTES = 4096;

/** Wejście dłuższe niż sufit. Komunikat bez wejścia. */
export class SecretInputTooLong extends Error {}

/** Ctrl-C w pytaniu bez echa. */
export class SecretInputInterrupted extends Error {}

/** Strumień wejścia, z którego funkcje czytają (`process.stdin`, w testach atrapa). */
export interface SecretSource {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'end' | 'close', listener: () => void): unknown;
  on(event: 'error', listener: (failure: Error) => void): unknown;
  removeListener(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  removeListener(event: 'end' | 'close', listener: () => void): unknown;
  removeListener(event: 'error', listener: (failure: Error) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** Terminal wejścia: strumień z trybem surowym. */
export interface SecretTerminal extends SecretSource {
  setRawMode(raw: boolean): unknown;
}

const CTRL_C = 0x03;
const CTRL_D = 0x04;
const CTRL_H = 0x08;
const LF = 0x0a;
const CR = 0x0d;
const DEL = 0x7f;
const ESC = 0x1b;

/** Tryb wklejki w znacznikach: włączenie i wyłączenie w terminalu, znaczniki początku i końca wklejki. */
const PASTE_MODE_ON = '\x1b[?2004h';
const PASTE_MODE_OFF = '\x1b[?2004l';
const PASTE_START = Buffer.from('\x1b[200~', 'latin1');
const PASTE_END = Buffer.from('\x1b[201~', 'latin1');

const bytesOf = (chunk: Buffer | string): Buffer => (typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);

/** Kasuje ostatni znak UTF-8: bajty kontynuacji (`10xxxxxx`) i bajt początku znaku. */
function dropLastChar(bytes: number[]): void {
  while (bytes.length > 0 && ((bytes[bytes.length - 1] ?? 0) & 0xc0) === 0x80) bytes.pop();
  bytes.pop();
}

/**
 * Pytanie bez echa na terminalu `input`; `write` wypisuje prompt, włączenie i wyłączenie trybu wklejki oraz końcową
 * nową linię. Wpisanych znaków powyżej `maxBytes` funkcja nie trzyma: czyta do Entera i odrzuca
 * {@link SecretInputTooLong}.
 */
export function askSecretOn(
  input: SecretTerminal, write: (text: string) => void, maxBytes: number = SECRET_MAX_BYTES,
): (prompt: string) => Promise<string | null> {
  return (prompt) => new Promise<string | null>((resolve, reject) => {
    const bytes: number[] = [];
    let tooLong = false;
    let done = false;
    let entered = false;
    // Wewnątrz wklejki (między znacznikami) Enter nie kończy odpowiedzi.
    let pasting = false;
    // Początek sekwencji `ESC …`, który może być znacznikiem wklejki; znacznik bywa podzielony między porcje danych.
    const held: number[] = [];

    const push = (byte: number): void => {
      if (tooLong) return;
      if (bytes.length >= maxBytes) {
        tooLong = true;
        bytes.fill(0);
        bytes.length = 0;
        return;
      }
      bytes.push(byte);
    };

    const finish = (outcome: () => void): void => {
      if (done) return;
      done = true;
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('close', onEnd);
      input.removeListener('error', onError);
      try {
        input.setRawMode(false);
      } finally {
        input.pause();
        write(`${PASTE_MODE_OFF}\n`);
        outcome();
        bytes.fill(0);
        held.fill(0);
      }
    };

    /** Zwykły klawisz albo bajt wklejki. */
    const key = (byte: number): void => {
      if (byte === CTRL_C) {
        finish(() => { reject(new SecretInputInterrupted('interrupted')); });
      } else if (byte === CTRL_D) {
        finish(() => { resolve(null); });
      } else if (byte === CR || byte === LF) {
        if (!pasting) entered = true;
        push(LF);
      } else if (byte === DEL || byte === CTRL_H) {
        if (!tooLong) dropLastChar(bytes);
      } else {
        push(byte);
      }
    };

    const startsMarker = (marker: Buffer): boolean => held.every((byte, index) => marker[index] === byte);

    /** Bajt wejścia: znacznik wklejki (także zebrany z kilku porcji) albo {@link key}. */
    const feed = (byte: number): void => {
      if (held.length === 0 && byte !== ESC) {
        key(byte);
        return;
      }
      held.push(byte);
      if (held.length === PASTE_START.length && startsMarker(PASTE_START)) {
        pasting = true;
        held.length = 0;
      } else if (held.length === PASTE_END.length && startsMarker(PASTE_END)) {
        pasting = false;
        held.length = 0;
      } else if (!startsMarker(PASTE_START) && !startsMarker(PASTE_END)) {
        // Inna sekwencja (np. strzałka): jej bajty idą jak zwykłe klawisze, od drugiego znów z szukaniem znacznika.
        const [first = ESC, ...rest] = held;
        held.length = 0;
        key(first);
        for (const next of rest) {
          if (done) return;
          feed(next);
        }
      }
    };

    const onData = (chunk: Buffer | string): void => {
      for (const byte of bytesOf(chunk)) {
        feed(byte);
        if (done) return;
      }
      if (!entered) return;
      // Enter na końcu nie należy do odpowiedzi; nowa linia w środku wklejki zostaje.
      while (bytes[bytes.length - 1] === LF) bytes.pop();
      finish(() => {
        if (tooLong) reject(new SecretInputTooLong(`longer than ${String(maxBytes)} bytes`));
        else resolve(Buffer.from(bytes).toString('utf8'));
      });
    };
    // Koniec strumienia terminala (zamknięta sesja) znaczy to samo co Ctrl-D.
    const onEnd = (): void => { finish(() => { resolve(null); }); };
    const onError = (failure: Error): void => { finish(() => { reject(failure); }); };

    write(prompt);
    try {
      input.setRawMode(true);
    } catch (failure) {
      // Terminal nie wszedł w tryb surowy, więc nie ma czego przywracać; pytania bez echa nie ma.
      write('\n');
      throw failure;
    }
    write(PASTE_MODE_ON);
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('close', onEnd);
    input.on('error', onError);
    input.resume();
  });
}

/**
 * Cały strumień `input` do EOF jako tekst UTF-8. Ponad `maxBytes` bajtów = odrzucenie {@link SecretInputTooLong} od
 * razu (reszta nie jest czytana); zamknięcie bez EOF albo błąd strumienia = odrzucenie.
 */
export function readAllOn(input: SecretSource): (maxBytes: number) => Promise<string> {
  return (maxBytes) => new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;

    const finish = (outcome: () => void): void => {
      if (done) return;
      done = true;
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('close', onClose);
      input.removeListener('error', onError);
      input.pause();
      outcome();
      for (const chunk of chunks) chunk.fill(0);
    };

    const onData = (chunk: Buffer | string): void => {
      const data = bytesOf(chunk);
      size += data.length;
      if (size > maxBytes) {
        finish(() => { reject(new SecretInputTooLong(`longer than ${String(maxBytes)} bytes`)); });
        return;
      }
      chunks.push(Buffer.from(data));
    };
    const onEnd = (): void => { finish(() => { resolve(Buffer.concat(chunks).toString('utf8')); }); };
    const onClose = (): void => { finish(() => { reject(new Error('the input closed before its end')); }); };
    const onError = (failure: Error): void => { finish(() => { reject(failure); }); };

    input.on('data', onData);
    input.on('end', onEnd);
    input.on('close', onClose);
    input.on('error', onError);
    input.resume();
  });
}

/** Strumień wyjścia procesu: czy to terminal i zapis promptu. */
export interface SecretOutput {
  readonly isTTY?: boolean;
  write(text: string): unknown;
}

/**
 * Drogi wejścia sekretu dla strumieni procesu: stdin i stdout to terminal → {@link askSecretOn}; stdin nie jest
 * terminalem → {@link readAllOn} (klucz z potoku albo pliku); stdin to terminal, a stdout nie → żadnej (komenda
 * odmawia: pytania bez widocznego promptu nie zadaje). Funkcje niczego nie czytają, dopóki ich nikt nie wywoła.
 */
export function secretInput(
  stdin: SecretTerminal & { readonly isTTY?: boolean }, stdout: SecretOutput,
): Pick<CliIo, 'askSecret' | 'readStdin'> {
  if (stdin.isTTY !== true) return { readStdin: readAllOn(stdin) };
  if (stdout.isTTY !== true) return {};
  return { askSecret: askSecretOn(stdin, (text) => { stdout.write(text); }) };
}
