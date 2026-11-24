/**
 * Czas w liniach logu serwera: każda linia stdout i stderr procesu serwera zaczyna
 * się od czasu ISO 8601 w UTC z milisekundami i spacji (`2026-11-10T16:59:23.123Z `). Te strumienie to `server.log`
 * pod launchd, `systemd --user` i `nohup`.
 *
 * Prefiks powstaje w JEDNYM miejscu: {@link timestampWrites} owija `write` strumienia, a instaluje go na stdout
 * i stderr procesu serwera wyłącznie `log-timestamps-install.ts`, pierwszy import `index.ts` (wejście, które
 * `serverExec` uruchamia po `execve` w `rarog serve`). Wywołania logu czasu nie dopisują; wstrzyknięte loggery
 * w testach i wyjście komend `rarog …` dla człowieka go nie dostają.
 *
 * Granica linii to `\n` w bajtach zapisu: zapis wielowierszowy (stos błędu) dostaje prefiks na każdej linii, a linia
 * zapisana kilkoma `write` jeden, z czasem pierwszego fragmentu. A line that starts after a newline inside the same
 * write continues one log call (a stack trace, a value with a newline), so its prefix is the time followed by
 * {@link LOG_CONTINUATION_MARK}: after {@link LOG_TIME_PREFIX} it starts with `| `, and a value that carries a whole
 * log line cannot pass for a line the server wrote. Czego nie obejmuje: bajtów, które omijają
 * `process.stdout.write` / `process.stderr.write` (wydruk niezłapanego wyjątku z samego Node, proces potomny
 * z odziedziczonym deskryptorem).
 */

/** Prefiks czasu na początku linii logu serwera. Czytelnicy logu przyjmują linię z nim i bez niego (stare pliki). */
export const LOG_TIME_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /u;

/** Follows the time on a line that continues the log call of the line above, in the same write. */
export const LOG_CONTINUATION_MARK = '| ';

const NEWLINE = 0x0a;

type WriteFn = (chunk: unknown, ...rest: unknown[]) => boolean;

/**
 * Owija `stream.write`: przed każdą linią wstawia czas z `now()` (raz na zapis, tylko gdy linia się w nim zaczyna).
 * Napis z kodowaniem idzie jako bajty w tym kodowaniu, callback zapisu przechodzi bez zmian.
 */
export function timestampWrites(stream: NodeJS.WritableStream, now: () => Date = () => new Date()): void {
  const original = stream.write.bind(stream) as WriteFn;
  let atLineStart = true;
  const write: WriteFn = (chunk, ...rest) => {
    const [second, third] = rest;
    const encoding = typeof second === 'string' ? second as BufferEncoding : undefined;
    const callback = typeof second === 'function' ? second : third;
    let bytes: Buffer;
    if (typeof chunk === 'string') bytes = Buffer.from(chunk, encoding ?? 'utf8');
    // Każdy widok bufora (`DataView`, dowolny `TypedArray`), nie tylko `Uint8Array`: `write` przyjmuje je wszystkie.
    else if (ArrayBuffer.isView(chunk)) bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    else return original(chunk, ...rest);
    if (bytes.length === 0) return original(chunk, ...rest);
    const parts: Buffer[] = [];
    let time: string | null = null;
    let from = 0;
    while (from < bytes.length) {
      if (atLineStart) {
        time ??= now().toISOString();
        parts.push(Buffer.from(from === 0 ? `${time} ` : `${time} ${LOG_CONTINUATION_MARK}`, 'utf8'));
      }
      const newline = bytes.indexOf(NEWLINE, from);
      const end = newline === -1 ? bytes.length : newline + 1;
      parts.push(bytes.subarray(from, end));
      atLineStart = newline !== -1;
      from = end;
    }
    const out = Buffer.concat(parts);
    return typeof callback === 'function' ? original(out, callback) : original(out);
  };
  stream.write = write as typeof stream.write;
}
