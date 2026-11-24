/**
 * The scope gate of a read from a session's directory: which session the diff routes may read from. A function over
 * one session; the manager keeps the session lookup and passes it in through {@link DiffSessionPort}. This module
 * does not import `manager.ts`.
 */
import type { SessionScopeConfig } from './companion-scope.ts';
import { sessionCwdInArea } from './companion-scope.ts';
import { BadRequestError } from './errors.ts';
import type { Session } from './session.ts';
import { HERDR_CODEX_GIT_MESSAGE, HERDR_OUT_OF_SCOPE_DIFF_MESSAGE } from './state-sentences.ts';

/** What {@link diffSession} needs from the manager. */
export interface DiffSessionPort {
  /** The session with this id; an unknown id throws the manager's 404. */
  require(id: string): Session;
  /** The manager configuration, read at the time of the call. */
  readonly config: SessionScopeConfig;
}

/**
 * Bramka wspólna WSZYSTKICH tras diffa — starej i obu per plik. Oddaje sesję, z której
 * katalogu wolno czytać, albo `null` w demo: tam diff to stały mock, bez odczytu z dysku.
 */
export function diffSession(id: string, port: DiffSessionPort): Session | null {
  const session = port.require(id);
  // Bramka zasięgu: diff roboczy to TREŚĆ katalogu, a wpis Codexa obiecuje sam stan. Klient
  // przycisku dla Codexa nie rysuje — to jest druga linia, dla starego klienta i dla `curl`.
  if (session.engine === 'codex') throw new BadRequestError(HERDR_CODEX_GIT_MESSAGE);
  // Panel poza zasięgiem: ta sama granica co transkrypt i wycinek ekranu — treść katalogu zostaje na Macu.
  if (session.outOfScope === true) throw new BadRequestError(HERDR_OUT_OF_SCOPE_DIFF_MESSAGE);
  /*
   * Niżej, za gałęzią demo: `outOfScope` mówi o katalogu, w którym panel stoi TERAZ (nadzorca
   * liczy go od nowa po `cd`), a diff czyta `session.cwd` — katalog z chwili pojawienia się
   * panelu, którego reattach nie rusza. Panel, który wystartował poza korzeniami i zrobił `cd` pod korzeń, miał więc zasięg,
   * a diff dalej czytał stary, prywatny katalog. Bramka pyta o TEN
   * katalog, z którego pójdzie odczyt, tą samą funkcją co nadzorca (`scopeOf`).
   */
  // Demo nie ma korzeni ani prawdziwych katalogów: jego diff to stały mock, bez odczytu z dysku.
  if (port.config.demo) return null;
  if (!sessionCwdInArea(session, port.config)) throw new BadRequestError(HERDR_OUT_OF_SCOPE_DIFF_MESSAGE);
  return session;
}
