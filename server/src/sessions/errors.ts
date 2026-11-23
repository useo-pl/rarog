/**
 * Errors of the session manager (`ManagerApi`): the router maps each class to an HTTP status by its `code`. They live
 * here so that modules split out of the manager can throw them without importing `manager.ts`; the manager
 * re-exports them, so importers keep importing them from there.
 */
import { ULTRACODE_REFUSED_ERROR } from '@rarog/shared/rest';
import { type OwnText, textOf } from '@rarog/shared/sentences';

// `code` + `name` są celowo zdublowane: router mapuje wyjątek na status po jednym z tych
// pól, a testowy `FakeManager` używa tych samych etykiet.

/**
 * Baza błędów managera: konstruktor przyjmuje zdanie (tekst własny), `sentence` czyta `errorBodyOf`
 * w routerze, a `Error.message` to ten sam tekst, więc logi się nie zmieniają.
 */
abstract class ManagerError extends Error {
  readonly sentence: OwnText;

  constructor(sentence: OwnText, options?: ErrorOptions) {
    super(textOf(sentence), options);
    this.sentence = sentence;
  }
}

/** Sesja o podanym id nie istnieje → 404. */
export class NotFoundError extends ManagerError {
  readonly code = 'not-found';
  override readonly name = 'NotFoundError';
}

/** Operacja niedozwolona w bieżącym stanie sesji → 409. */
export class BadStateError extends ManagerError {
  readonly code = 'bad-state';
  override readonly name = 'BadStateError';
}

/** Żądanie odrzucone przed dotknięciem stanu (np. cwd spoza allow-listy) → 400. */
export class BadRequestError extends ManagerError {
  readonly code = 'bad-request';
  override readonly name = 'BadRequestError';
}

/**
 * Bramka startu z ultracode odmówiła → 400 z kodem `ultracode-refused`. Osobna klasa, bo kod mówi klientowi,
 * że odmowa dotyczy ustawień startu, a nie katalogu (`bad-request` apka pokazuje przy polu ścieżki).
 */
export class UltracodeRefusedError extends ManagerError {
  readonly code = ULTRACODE_REFUSED_ERROR;
  override readonly name = 'UltracodeRefusedError';
}

/**
 * Za dużo żądań w jednostce czasu → 429.
 *
 * Osobna klasa (a nie `BadRequestError`), bo różnica jest dla telefonu znacząca: 400 znaczy
 * „ta wiadomość nigdy nie przejdzie", a 429 „poczekaj chwilę i wyślij to samo jeszcze raz".
 * Throttle chroni pty ŻYWEGO panelu użytkownika przed pętlą w kodzie Raroga.
 */
export class TooManyRequestsError extends ManagerError {
  readonly code = 'too-many-requests';
  override readonly name = 'TooManyRequestsError';
}

/**
 * Sesja jest zamknięta i nic już jej nie zmieni → 410.
 *
 * Osobno od `BadStateError` (409), bo różnica jest dla klienta znacząca: 409 znaczy „spróbuj
 * później", a 410 „ta sesja się skończyła, nie próbuj wcale".
 */
export class GoneError extends ManagerError {
  readonly code = 'gone';
  override readonly name = 'GoneError';
}
