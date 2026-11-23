/**
 * Bajty pliku jsonl → kompletne linie. Wspólne dla dwóch czytników, które czytają plik rozmowy
 * PORCJAMI: czytnika pliku subagenta (`agent-file.ts`) i przeglądu pliku głównego sprzed okna
 * ogona (`main-scan.ts`).
 *
 * Trzy rzeczy, które łatwo zrobić źle, stoją tu raz:
 *
 * - niedokończona ostatnia linia czeka w buforze na resztę. Bufor trzyma BAJTY, nie tekst: porcja
 *   potrafi skończyć się w środku znaku UTF-8, a `\n` nigdy nie jest częścią znaku wielobajtowego,
 *   więc cięcie po bajcie nowej linii jest bezpieczne, a dekodowanie całej linii naraz też;
 * - linia dłuższa niż sufit jest pomijana W CAŁOŚCI, bez składania jej w pamięci (wynik `Read`
 *   z obrazem ma megabajty; start i koniec zadania to setki bajtów);
 * - sufit dotyczy linii, nie tylko bufora: linia, która przekracza go dopiero w porcji ze swoim
 *   `\n`, też odpada, zanim ją skleimy.
 *
 * Moduł jest CZYSTY: bez dysku i bez zegara. `Buffer` to typ danych, nie I/O.
 */

const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);

/** Co czytnik niesie między porcjami jednego pliku. */
export interface LineCarry {
  /** Bajty niedokończonej ostatniej linii. */
  partial: Buffer;
  /** Jesteśmy w środku linii, którą pomijamy (za długa albo ucięta przeskokiem): do `\n` nic nie bierzemy. */
  dropping: boolean;
  /**
   * Ile KOMPLETNYCH linii pominęliśmy od zerowania (za długie albo ucięte przeskokiem). Kto chce
   * twierdzić, że zna plik w całości, nie może: pominięta linia mogła nieść cokolwiek.
   */
  dropped: number;
}

/** Stan początku pliku: nic w buforze, nic do pominięcia. */
export function emptyCarry(): LineCarry {
  return { partial: EMPTY, dropping: false, dropped: 0 };
}

/** Zeruje stan w miejscu: inna zawartość pliku albo przeskok (`dropping` = pierwsza linia jest ucięta). */
export function resetCarry(carry: LineCarry, dropping = false): void {
  carry.partial = EMPTY;
  carry.dropping = dropping;
  carry.dropped = 0;
}

/**
 * Porcja bajtów → kompletne linie tej porcji (bez `\n`), w kolejności zapisu. Reszta bez `\n`
 * zostaje w `carry` na następną porcję.
 *
 * Oddane linie bywają WIDOKAMI na `bytes`: wołający ma je przerobić, zanim nadpisze bufor
 * następnym odczytem.
 */
export function takeLines(carry: LineCarry, bytes: Buffer, lineMaxBytes: number): Buffer[] {
  const lines: Buffer[] = [];
  let from = 0;
  for (;;) {
    const end = bytes.indexOf(NEWLINE, from);
    if (end === -1) break;
    const fits = carry.partial.length + (end - from) <= lineMaxBytes;
    if (carry.dropping || !fits) carry.dropped += 1;
    if (carry.dropping) carry.dropping = false;
    else if (fits && carry.partial.length === 0) lines.push(bytes.subarray(from, end));
    else if (fits) lines.push(Buffer.concat([carry.partial, bytes.subarray(from, end)]));
    carry.partial = EMPTY;
    from = end + 1;
  }
  if (!carry.dropping) {
    const rest = bytes.subarray(from);
    if (carry.partial.length + rest.length > lineMaxBytes) {
      carry.partial = EMPTY;
      carry.dropping = true;
    } else if (rest.length > 0) {
      // Kopia: `bytes` to widok na bufor porcji, który następny odczyt nadpisze.
      carry.partial = Buffer.concat([carry.partial, rest]);
    }
  }
  return lines;
}
