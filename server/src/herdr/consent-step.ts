/**
 * One step of the consent channel that the caller does not stop on: a timer tick, a session end, a release.
 * An unexpected exception of the step (thrown or rejected) leaves exactly one line in the server log with the place
 * and the error text, and the caller goes on as before: the next tick runs, the session ends anyway. The module
 * decides nothing and retries nothing; what the step does on failure stays with the step.
 */
import { redact } from '../auth/redact.ts';

/** Ceiling of the error text in the line: a message is a diagnosis, not a dump. */
const ERROR_TEXT_MAX = 300;

/**
 * Error text for the line: name and message of an `Error`, cut at the first double quote or backtick, then its first
 * line only, capped. A message may quote the input it failed on (`JSON.parse` quotes the text, with inner quotes and
 * line breaks), and that text can be the tool input of the card, so nothing from the first quote on reaches the log.
 * A thrown value that is not an `Error` or a string shows only its type.
 */
function errorText(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}`
    : typeof err === 'string' ? err
      : `non-error value (${typeof err})`;
  const quote = raw.search(/["`]/u);
  const unquoted = quote === -1 ? raw : `${raw.slice(0, quote)}"…"`;
  const line = unquoted.split('\n', 1)[0] ?? '';
  const capped = line.length > ERROR_TEXT_MAX ? `${line.slice(0, ERROR_TEXT_MAX)}…` : line;
  return redact(capped);
}

/**
 * Runs `step` and settles without throwing: its result, or `undefined` after one line
 * `consent: <place> failed: <error text>` in `log`. `step` starts in the caller's synchronous step, so the order of
 * calls around it stays as it was. Without `log` the failure goes unlogged (a manager without a logger in tests).
 */
export async function consentStep<T>(
  place: string, log: ((line: string) => void) | undefined, step: () => T | Promise<T>,
): Promise<T | undefined> {
  try {
    return await step();
  } catch (err: unknown) {
    try {
      log?.(`consent: ${place} failed: ${errorText(err)}`);
    } catch {
      // A broken logger does not turn the step into a throwing one: the caller relies on a settled promise.
    }
    return undefined;
  }
}
