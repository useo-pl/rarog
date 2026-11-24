/**
 * Sentences and gate constants of the session manager (`manager.ts`): state details (`stateDetail`), refusal
 * sentences of manager operations, transcript notes, and the timings, state sets and turn rules that the manager's
 * gates read. Pure values and functions without I/O; `manager.ts` imports them from here.
 */
import { resolve } from 'node:path';
import type { HerdrMode, SessionState, TranscriptNotice } from '@rarog/shared';
import type { ServerSystem } from '@rarog/shared/rest';
import {
  type AnyText, type OwnText, type ServerSentence, foreign, isServerSentence, say,
} from '@rarog/shared/sentences';
import type { CreateSessionOptions } from './manager-api.ts';
import type { SmEvent } from './state-machine.ts';
import type { Session, TurnTally } from './session.ts';
import { isInsideAnyRoot } from '../config.ts';
import { clipUnits } from '../text.ts';
import type { CliDialogClass } from '../cli-version.ts';
import type { BlockedLeftoverClear } from '../drivers/types.ts';
import { reasonOfError } from '../herdr/types.ts';
import { ULTRACODE_MIN_CLI } from '../herdr/ultracode.ts';
import type { DemoSeed } from '../demo/seeds.ts';

// ---------------------------------------------------------------------------
// Copy stanów (widoczne w UI jako `stateDetail`)
// ---------------------------------------------------------------------------

export const INTERRUPT_DETAIL = say('state.interrupted');

/**
 * Karencja po przerwaniu: świeży push `working` nie wskrzesza „pracuje".
 *
 * Esc pół sekundy po wysyłce ubija turę, zanim herdr zdąży ją wykryć — jego push `working`
 * przychodzi PO przejściu w `waiting-input` i zostałby na stałe (ubita tura nie wygeneruje
 * już żadnego pusha, a sondy drivera sięgają 2,5 s). W oknie karencji `working` przy stanie
 * `waiting-input` jest ignorowany; gdyby przerwanie NAPRAWDĘ nie weszło, prawdę przywróci
 * resync nadzorcy (30 s) — chwila fałszywego „czeka" jest tańsza niż wieczne „pracuje".
 * Nowej tury karencja nie dotyka: wysyłka ustawia stan `running` optymistycznie, a bramka
 * działa wyłącznie przy `waiting-input`.
 */
export const INTERRUPT_WORKING_GRACE_MS = 6_000;

/**
 * Jak długo po wysyłce z Raroga znacznik tury otwartej tą wysyłką (`Session.turnOpenedBySend`) rozstrzyga
 * o prompcie zablokowanym przez hook. Wpis blokady stoi w pliku 0,35–0,5 s po `prompt`, pierwszy prompt
 * świeżej sesji przychodzi z historii po kilku sekundach — minuta to zapas, nie oczekiwanie.
 */
export const PROMPT_BLOCK_MARKER_MS = 60_000;

/** Ile znaków początku promptu cytuje notka po odczycie pola — reszta tekstu stoi w dymku nad nią. */
export const HELD_LEFTOVER_QUOTE_CHARS = 60;

/** Początek promptu do notki: białe znaki zbite do spacji, najwyżej {@link HELD_LEFTOVER_QUOTE_CHARS} znaków. */
function promptOpening(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length <= HELD_LEFTOVER_QUOTE_CHARS
    ? chars.join('')
    : `${chars.slice(0, HELD_LEFTOVER_QUOTE_CHARS).join('').trimEnd()}…`;
}

/**
 * Słowo maszyny w zdaniach z wariantami `.mac`/`.vps`: ta sama reguła co `ServerMachine` w apce. „Mac” tylko na
 * macOS; Linux i każdy inny system to VPS.
 */
function onMac(system: ServerSystem): boolean {
  return system === 'macos';
}

/**
 * Notka po odczycie pola: pole trzyma tekst wstrzymanego promptu, więc CLI go nie przyjął. Powodu CLI nigdzie
 * nie zapisał (prompt w trakcie tury nie zostawia wpisu blokady), stąd „najczęściej” zamiast nazwy hooka.
 */
export function heldNotTakenText(text: string, system: ServerSystem): ServerSentence {
  const prompt = foreign(promptOpening(text));
  return onMac(system)
    ? say('session.prompt-not-taken.mac', { prompt })
    : say('session.prompt-not-taken.vps', { prompt });
}

/** Notka po odczycie pola: pole pełne, ale bez tekstu wstrzymanego promptu — cudzego tekstu nie czyścimy. */
export function heldUnconfirmedText(text: string, system: ServerSystem): ServerSentence {
  const prompt = foreign(promptOpening(text));
  return onMac(system)
    ? say('session.prompt-unconfirmed.mac', { prompt })
    : say('session.prompt-unconfirmed.vps', { prompt });
}

/**
 * Notka po odczycie pola: wiadomość szła wklejeniem w trakcie tury, driver nie zobaczył jej tekstu w polu i nie
 * wkleił go drugi raz (mógł pójść Enterem przy Macu), a wpisu z pliku nie ma. Bez słowa maszyny: pole nic nie mówi.
 */
export function heldUnseenText(text: string): ServerSentence {
  return say('session.prompt-unseen', { prompt: foreign(promptOpening(text)) });
}

/**
 * Okno debounce'u przerwania: kolejne żądanie w tym czasie PO dostarczonym
 * `escape` jest no-opem, a nie drugim klawiszem.
 *
 * Sekunda leży między dwiema liczbami z żywego dziennika (panel `wQ:p2M`):
 * mashowanie zmieściło cztery tapnięcia w 0,79 s, a pierwsze ŚWIADOME powtórzenie przyszło
 * po 3,7 s. Okno ma zjadać to pierwsze i przepuszczać drugie — człowiek, któremu Esc nie
 * zadziałał, musi mieć prawo spróbować jeszcze raz.
 *
 * Nośnikiem jest WŁASNE pole (`#lastInterruptAtMs`), rozłączne z `interruptedAtMs`: tamto
 * należy do karencji spóźnionego `working` powyżej, która sama trzyma sesję w `waiting-input`
 * przez 6 s. Bramka czytająca tamto pole byłaby spełniona PRZEZ KONSTRUKCJĘ i przez te 6 s
 * połykała przerwania tury, która naprawdę ruszyła (w terminalu albo z drugiego urządzenia).
 */
export const INTERRUPT_DEBOUNCE_MS = 1_000;
export const DRIVER_ERROR_DETAIL = say('state.driver-error');
export const DRIVER_GONE_DETAIL = say('state.driver-gone');

/** Detail sesji, której panel dopiero powstaje (202 wraca, zanim agent wstanie). */
export const HERDR_LAUNCHING_DETAIL = say('state.herdr-launching');

/** Detail sesji, której zakładanie się nie powiodło (bez treści błędu, gdy wyjątek jej nie niesie). */
export const HERDR_LAUNCH_FAILED_DETAIL = say('state.herdr-launch-failed');

/**
 * Detail nieudanego założenia panelu z powodem z wyjątku ({@link reasonOfError}): zdanie własne bez argumentów jako
 * podkod, zdanie własne z argumentami i treść błędu obcego jako argument `text` (rama „nie powstał” zostaje).
 */
export function herdrLaunchFailedDetail(error: unknown): ServerSentence {
  const reason = reasonOfError(error);
  if ('code' in reason) return say('state.herdr-launch-failed.code', { reason: reason.code });
  return reason.text === ''
    ? HERDR_LAUNCH_FAILED_DETAIL
    : say('state.herdr-launch-failed.reason', { reason: reason.text });
}

// --- Copy integracji herdr (widoczne dla użytkownika, więc w jednym miejscu) ---

/** Detail sesji herdr, której stanu jeszcze nie znamy (`agent_status: unknown` przy odkryciu). */
export const HERDR_UNKNOWN_DETAIL = say('state.herdr-unknown');

/** Dopisek limitu planu: zdanie `state.limit-reached` z chwilą resetu; chwila nieczytelna = bez dopisku. */
export function limitReachedDetail(resetAt: string | undefined): ServerSentence | undefined {
  const at = resetAt === undefined ? Number.NaN : Date.parse(resetAt);
  return Number.isNaN(at) ? undefined : say('state.limit-reached', { reset: new Date(at) });
}

/**
 * Szczegół stanu do treści pusha (`#notifyDetail`): zdanie stanu przechodzi bez zmian, także limit planu jako zdanie
 * `state.limit-reached` z chwilą resetu. Jego `ref` staje się `bodyRef` banera (`notify/content.ts`), z którego apka
 * składa godzinę w swoim języku; token `resetAt=<ISO>` zostaje wyłącznie na drucie stanu (`wireStateDetail`).
 */
export function pushStateDetail(detail: AnyText | undefined): AnyText | undefined {
  return detail;
}

/** Dopisek stanu z ziarna demo: token `resetAt=<ISO>` staje się zdaniem limitu (chwila nieczytelna = bez dopisku). */
function seedStateDetail(detail: NonNullable<DemoSeed['stateDetail']>): ServerSentence | undefined {
  return typeof detail === 'string' ? limitReachedDetail(detail.slice('resetAt='.length)) : detail;
}

/** Pole `stateDetail` sesji z ziarna demo; bez dopisku (albo z nieczytelną chwilą limitu) pola nie ma. */
export function seedDetailField(seed: DemoSeed): { stateDetail?: ServerSentence } {
  const detail = seed.stateDetail === undefined ? undefined : seedStateDetail(seed.stateDetail);
  return detail === undefined ? {} : { stateDetail: detail };
}

/** Detail sesji herdr, której panel zniknął z terminala. */
export const HERDR_GONE_DETAIL = say('state.herdr-gone');

/**
 * Cisza po restarcie serwera herdr: ile najdłużej może minąć między `gone` bezczynnej
 * karty a `appeared` tego samego uuid silnika, żeby powrót liczył się jako ODTWORZENIE.
 * Zmierzone: ~15 s (Rarog wraca po restarcie, procesy `claude` 12–16 s później).
 */
export const HERDR_RESTORE_MATCH_MS = 5 * 60_000;

/**
 * Bezpiecznik jednorazowego znacznika ciszy — NIE mechanizm. Znacznik zużywa pierwszy
 * `idle`/`blocked` karty; termin istnieje tylko po to, żeby karta, która nigdy nie ucichła,
 * nie trzymała go w nieskończoność.
 */
export const HERDR_RESTORE_QUIET_MAX_MS = 10 * 60_000;

/**
 * `gone` liczy się jako skutek restartu herdr WYŁĄCZNIE w tym oknie po powrocie gniazda
 * (`available`). Pełny resync po powrocie ogłasza `available` i zaraz potem `gone` dla paneli
 * spoza listy — to ten sam obrót; zwykłe zamknięcie panelu przy żywym herdr ciszy nie uzbraja.
 */
export const HERDR_RECOVERY_GONE_MS = 60_000;

/** Detail sesji herdr ukrytej z Raroga (panel ŻYJE dalej w terminalu). */
export const HERDR_HIDDEN_DETAIL = say('state.herdr-hidden');

/**
 * 409 na `resume` sesji, której panel wciąż ŻYJE w terminalu. Trasa `resume` odsyła zdanie ogólne statusu
 * (`errorBodyOf`, polityka `generic`), więc wyjątek niesie to samo zdanie, które dostaje apka.
 */
export const HERDR_RESUME_MESSAGE = say('rest.bad-state');

/*
 * Restart sesji na nowszym Claude Code. Każde zdanie odmowy nazywa przeszkodę, bo każda
 * przychodzi PRZED `/exit` — sesja jest nietknięta i człowiek ma wiedzieć, co zrobić, żeby
 * restart przeszedł.
 */
export const RESTART_CODEX_MESSAGE = say('restart.codex');
export const RESTART_IN_PROGRESS_MESSAGE = say('restart.in-progress');
export const RESTART_NO_PANEL_MESSAGE = say('restart.no-panel');
export const RESTART_UNSUPPORTED_MESSAGE = say('restart.unsupported');
export const RESTART_NO_UPDATE_MESSAGE = say('restart.no-update');
export const RESTART_BUSY_MESSAGE = say('restart.busy');
export const RESTART_TASKS_MESSAGE = say('restart.background-task-running');
/**
 * Na liście zadań stoją SAMI subagenci w postoju: nic nie działa, ale restart zabiłby
 * proces CLI, a z nim agenta i komendę, na którą czeka — blokada zostaje, zmienia się zdanie.
 */
export const RESTART_WAITING_AGENT_MESSAGE = say('restart.waiting-agent');
/** Niewysłany tekst w polu promptu; słowo maszyny według systemu serwera. */
export function restartComposerMessage(system: ServerSystem): ServerSentence {
  return onMac(system) ? say('restart.unsent-prompt.mac') : say('restart.unsent-prompt.vps');
}
export const RESTART_COMPOSER_UNKNOWN_MESSAGE = say('restart.composer-unknown');
export const RESTART_MODE_UNKNOWN_MESSAGE = say('restart.mode-unknown');
export const RESTART_PANEL_CHANGED_MESSAGE = say('restart.panel-changed');
export const RESTART_WRITERS_MESSAGE = say('restart.multiple-writers');
export const RESTART_UNVERIFIED_MESSAGE = say('restart.single-writer-unverified');
/**
 * 409 na „Uruchom ponownie i wyślij”, gdy `seq` z ciała nie wskazuje notki, której przycisk działa:
 * prompt już poszedł, ktoś wysłał inny albo blokada zgasła. Zapada PRZED rezerwacją — spóźnione tapnięcie
 * z drugiego urządzenia nie wyśle cudzego promptu ani nie uruchomi sesji ponownie.
 */
export const RESTART_RESEND_STALE_MESSAGE = say('restart.resend-stale');
/**
 * Detail karty od `/exit` do zniknięcia procesu. Bez wydania, gdy restart nie jest aktualizacją
 * (restart po blokadzie promptu bywa na tym samym wydaniu).
 */
export function restartExitingDetail(running?: string): ServerSentence {
  return running === undefined ? say('restart.exiting') : say('restart.exiting.version', { version: running });
}
/** Detail karty od zniknięcia procesu do gotowości nowego; bez wydania jak wyżej. */
export function restartLaunchingDetail(installed?: string): ServerSentence {
  return installed === undefined
    ? say('restart.launching')
    : say('restart.launching.version', { version: installed });
}
/** Notka w transkrypcie po restarcie bez aktualizacji. */
export const RESTART_DONE_NOTE = say('restart.done');
/** Powody przerwanego restartu: szczegół stanu i podkod notki `restart.exit-note` (z ⚠) w transkrypcie. */
export type RestartExitCode = 'restart.exit-asked' | 'restart.exit-timeout' | 'restart.exit-unconfirmed';
export const RESTART_EXIT_ASKED_DETAIL = say('restart.exit-asked');
export const RESTART_EXIT_TIMEOUT_DETAIL = say('restart.exit-timeout');
export const RESTART_EXIT_UNCONFIRMED_DETAIL = say('restart.exit-unconfirmed');

/** How many task lines of the exit dialog the note names; the rest is counted ("and N more"). */
export const RESTART_EXIT_TASKS_SHOWN = 3;
/** Longest task line in the note, ellipsis included, so the note stays readable on a phone. */
export const RESTART_EXIT_TASK_MAX_CHARS = 80;

/**
 * Detail and transcript note of a restart canceled by the exit dialog with its task lines (`exitDialogTasks`).
 * `null` without lines: the caller keeps `restart.exit-asked`. The lines are screen text, so they go as `text`
 * arguments, never translated.
 */
export function restartExitTasksNotice(
  tasks: readonly string[] | null,
): { detail: ServerSentence; note: ServerSentence } | null {
  if (tasks === null || tasks.length === 0) return null;
  const max = RESTART_EXIT_TASK_MAX_CHARS;
  const shown = tasks.slice(0, RESTART_EXIT_TASKS_SHOWN)
    .map((line) => (line.length > max ? `${clipUnits(line, max - 1)}…` : line))
    .join('; ');
  const more = tasks.length - RESTART_EXIT_TASKS_SHOWN;
  return {
    detail: say('restart.exit-background-tasks'),
    note: more > 0
      ? say('restart.exit-background-tasks.list-more', { tasks: shown, more })
      : say('restart.exit-background-tasks.list', { tasks: shown }),
  };
}
/** Restart nieudany bez treści błędu; z treścią {@link restartFailedDetail}. */
export const RESTART_FAILED_DETAIL = say('restart.failed');

/** Detail nieudanego restartu z powodem z wyjątku; reguła jak w {@link herdrLaunchFailedDetail}. */
export function restartFailedDetail(error: unknown): ServerSentence {
  const reason = reasonOfError(error);
  if ('code' in reason) return say('restart.failed.code', { reason: reason.code });
  return reason.text === '' ? RESTART_FAILED_DETAIL : say('restart.failed.reason', { reason: reason.text });
}

/** 400 na zmianę modelu sesji, do której Rarog nie ma kanału (panel zniknął albo demo). */
export const HERDR_MODEL_MESSAGE = say('model.herdr-set-at-start');

/** 400 na zmianę trybu sesji, do której Rarog nie ma kanału (panel zniknął albo demo). */
export const HERDR_MODE_MESSAGE = say('session.mode-no-channel');

/** 409 na zmianę trybu z `bypass`: panel w bypass to decyzja przy biurku, Rarog jej nie odkręca. */
export const HERDR_MODE_BYPASS_MESSAGE = say('session.mode-bypass');

/** 409 na zmianę trybu w środku tury albo przy stojącym dialogu. */
export const MODE_BUSY_MESSAGE = say('session.mode-busy');

/** 409 na `focus` sesji, która nie ma (już) panelu w herdr. */
export const HERDR_FOCUS_MESSAGE = say('session.focus-no-panel');

/**
 * Wiadomość systemowa w sesji założonej w katalogu BEZ zaufania Claude Code.
 *
 * Stoi w transkrypcie, a nie tylko w odpowiedzi HTTP, bo odpowiedź widzi jedno urządzenie
 * i tylko przez chwilę — a dialog zaufania zobaczy każdy, kto otworzy tę sesję.
 */
export const HERDR_TRUST_PROMPT_MESSAGE = say('session.trust-prompt');

/** 409 na wznowienie sesji silnika otwartej w żywym panelu. */
export const HERDR_DOUBLE_WRITER_MESSAGE = say('session.double-writer');

/** 409 na próbę ZATWIERDZENIA dialogu, którego Rarog nie rozumie (fail-closed). */
export const HERDR_ALLOW_MESSAGE = say('session.dialog-unrecognized');

/** 409 na zakładanie sesji przy zamkniętym kanale tworzenia. */
export const HERDR_LAUNCH_OFF_MESSAGE = say('session.launch-off');

/** Panel wstał, ale zniknął, zanim poszedł prompt startowy — zdanie zostaje widoczne. */
export const HERDR_LOST_PROMPT_MESSAGE = say('session.prompt-lost');

/** 429 na zakładanie sesji odrzucone przez throttle; słowo maszyny według systemu serwera. */
export function launchThrottledMessage(system: ServerSystem): ServerSentence {
  return onMac(system) ? say('session.launch-throttled.mac') : say('session.launch-throttled.vps');
}

/**
 * 409 przy padniętym gnieździe herdr — stan PRZEJŚCIOWY („poczekaj"), nie decyzja człowieka.
 *
 * Nazwa mówi o terminalach, bo stamtąd pochodzi (zderleasowane taby herdr), ale zdanie jest
 * OGÓLNE i obsługuje każdą ścieżkę mutującą z pre-checkiem `status().available` — `focus()`
 * i `close(closePanel)`. Nazwy świadomie nie zmieniam: kosztowałaby
 * dotknięcie plików spoza tej naprawy, a użytkownik i tak widzi wyłącznie treść.
 */
export const HERDR_TERMINAL_UNAVAILABLE_MESSAGE = say('session.herdr-unavailable');

/**
 * 400 ultracode, gdy wersji Claude Code nie znamy: bramka nie zgaduje, bo starsze CLI przy wyborze poziomu
 * wyłączało ultracode i nie zna formy `off`.
 */
export const ULTRACODE_CLI_UNKNOWN_MESSAGE = say('model.ultracode-cli-unknown', { minVersion: ULTRACODE_MIN_CLI });

/** 400 ultracode przy znanej wersji Claude Code niższej niż wymagana. */
export function ultracodeCliTooOldMessage(version: string): ServerSentence {
  return say('model.ultracode-cli-too-old', { version, minVersion: ULTRACODE_MIN_CLI });
}

/** 400 startu z ultracode i poziomem innym niż `xhigh`: flaga sama ustawia `xhigh`. */
export const ULTRACODE_EFFORT_MESSAGE = say('model.ultracode-effort');

/**
 * Zdanie systemowe wznowienia albo restartu bez ultracode, które rozmowa miała (poziom
 * z rozmowy wygrywa). `--resume` gubi ultracode, a wraca ono tylko flagą `--effort ultracode`, która ustawia
 * `xhigh`; Rarog nie zmienia po cichu poziomu ustawionego przez człowieka ani nie startuje flagą na CLI bez niej.
 */
export const RESUME_WITHOUT_ULTRACODE_MESSAGE = say('model.resume-without-ultracode', { minVersion: ULTRACODE_MIN_CLI });

/** 400 na `resumeFrom`, dla którego nie ma pliku transkryptu. */
export const RESUME_NOT_FOUND_MESSAGE = say('session.resume-not-found');

/** 400 na `resumeFrom` z transkryptu należącego do innego katalogu
 * („Starting sessions from the phone: three powers” w `docs/security-model.md`). */
export const RESUME_FOREIGN_CWD_MESSAGE = say('session.resume-foreign-cwd');

/**
 * Czy `cwd` z ogona pliku rozmowy należy do katalogu karty: jest nim albo leży pod nim
 * („Starting sessions from the phone: three powers” w `docs/security-model.md`).
 *
 * Sesja zmienia katalog w trakcie pracy (`cd` do worktree w `.claude/worktrees/`, do podkatalogu),
 * a CLI zapisuje w każdej linii pole `cwd`, które idzie za zmianą katalogu (po `/cd`: fixture
 * `commands/measured/config-plugin-cd-2.1.302.jsonl`). Ogon pliku bywa więc głębiej niż katalog
 * startu,
 * pod którym rozmowę stawia lista SDK (`listSessions`): rozmowa, która skończyła w worktree agenta,
 * bez tej reguły zawsze dostawałaby 400 na „Wznów” z „Ostatnich sesji”.
 * Porównanie idzie po segmentach ścieżki, więc sąsiad o wspólnym przedrostku (`atlas-b` wobec
 * `atlas`) i katalog wyżej dalej odpadają. `cwd` z pliku BEZ `resolve`: względne odpada
 * (`isInsideAnyRoot` przyjmuje tylko absolutne), bo `resolve` dokleiłby katalog procesu serwera.
 */
export function transcriptCwdBelongs(fileCwd: string, cwd: string): boolean {
  return isInsideAnyRoot(fileCwd, [resolve(cwd)]);
}

/**
 * 400 na `resumeFrom`, którego transkryptu nie da się odczytać (skasowany, brak uprawnień).
 *
 * Osobny od `RESUME_NOT_FOUND_MESSAGE`, bo to inna sytuacja: plik ZNALAZŁ się w magazynie,
 * ale odczyt padł. Bez tego wyjątek z `fs` leciał aż na router jako 500 — czyli „to awaria
 * Raroga", podczas gdy naprawa jest po stronie użytkownika (założyć nową sesję).
 */
export const RESUME_UNREADABLE_MESSAGE = say('session.resume-unreadable');

/** 400 na `resumeFrom`, gdy Rarog nie ma czym sprawdzić katalogu sesji (fail-closed). */
export const RESUME_UNVERIFIABLE_MESSAGE = say('session.resume-unverifiable');

/**
 * 409 na `closePanel: true` dla sesji BEZ panelu w herdr (np. demo).
 * Własność panelu nie gra roli — „×" zamyka każdy panel; zostaje tylko
 * warunek techniczny „jest czym adresować taba".
 */
export const HERDR_NOT_OWNED_MESSAGE = say('session.close-not-owned');

/**
 * 409 na `closePanel: true` dla panelu CODEXA.
 *
 * Granica władzy stoi TU, a nie w copy klienta: nowy klient „×" dla Codexa nie rysuje, ale stary
 * (w dawnej PWA: otwarta od wczoraj zakładka) rysuje go dalej — i jego żądanie doszłoby do `tab.close`
 * dokładnie tak samo jak dla panelu Claude. Wpis Codexa daje wyłącznie STAN; zamknięcie
 * cudzego panelu byłoby jedyną władzą, jaką by dawał, a tej nie obiecywaliśmy.
 */
export const HERDR_CODEX_CLOSE_MESSAGE = say('session.codex-close');

/**
 * 400 na diff sesji z karty Codexa.
 *
 * `diff` pyta o `engine` i `outOfScope` jak każda metoda karty (bramka zasięgu). Bez tego
 * dla wpisu Codexa byłaby to władza: treść katalogu panelu (bywa spoza `RAROG_HERDR_ROOTS`) wydana z karty, która
 * obiecuje SAM STAN. Zdanie „wpis
 * nie dokłada Rarogowi ani grama władzy" ma być prawdą po stronie SERWERA, a nie tylko
 * w kliencie. Wiersz gita w nagłówku (gałąź, liczniki) zostaje: to ten sam odczyt, który karta
 * i tak pokazuje na liście.
 */
export const HERDR_CODEX_GIT_MESSAGE = say('session.codex-git');

/**
 * 409 na przerwanie sesji bez podpiętego drivera.
 *
 * Nie `delivered: 'no'` w ciele 202: telefon czyta `'no'` jako „panel nie przyjął Esc" i odsyła
 * człowieka do herdr na Macu, a przy karcie BEZ panelu odsyłałby go po coś, czego tam nie ma.
 * Odmowa bramką stawia to w tej samej klasie co
 * `HERDR_NOT_OWNED_MESSAGE` przy zamykaniu: 4xx, zdanie od serwera, zero rady o Esc w herdr.
 *
 * Sesja bez drivera bywa też stanem PRZEJŚCIOWYM (resync po restarcie podpina drivery kolejką),
 * dlatego zdanie mówi „spróbuj za chwilę", a nie „ta sesja jest zepsuta".
 */
export const HERDR_NO_DRIVER_INTERRUPT_MESSAGE = say('rest.bad-state');

/**
 * 400 na wysyłkę do panelu, którego trybu uprawnień Rarog nie zna (reguła 11.7).
 *
 * Zdanie mówi, CO zasłania stopkę i co zrobić: `claude --resume` zapytał
 * o effort (xhigh czy high), Rarog tego dialogu nie zna, karty nie było, a dawne „nie wiem,
 * w jakim trybie jest ten panel" nie podpowiadało niczego. Rozgałęzienia po stanie sesji tu
 * NIE MA celowo: `waiting-permission` odpada wcześniej (`SENDABLE_STATES`), a dialogu startowego
 * herdr nie zgłasza jako `blocked` — jedyne, co Rarog wie na pewno, to „stopki nie widać".
 */
export const HERDR_MODE_UNKNOWN_MESSAGE = say('session.mode-footer-unknown');

/**
 * Zdanie o KLASIE dialogu, który rejestr sesji Claude Code zgłosił jako stojący.
 *
 * Czyta je WYŁĄCZNIE bramka wysyłki (zdanie 400 niżej). Na kartę bez decyzji i do linii „na co
 * czeka" klasa jedzie FAKTEM (`SessionSummary.cliDialog`), a polszczyznę składa apka —
 * `UICopy.cliDialogPhrase`.
 */
export function cliDialogSentence(dialog: CliDialogClass): CliDialogCode {
  switch (dialog) {
    case 'permission':
      return 'session.cli-dialog.permission';
    case 'input':
      return 'session.cli-dialog.input';
    case 'sandbox':
      return 'session.cli-dialog.sandbox';
    case 'dialog':
      return 'session.cli-dialog.open';
    default:
      return 'session.cli-dialog.other';
  }
}

/** Podkody zdania `session.dialog-stands` (argument `dialog:code`): klasa dialogu z rejestru sesji CLI. */
type CliDialogCode =
  | 'session.cli-dialog.permission' | 'session.cli-dialog.input' | 'session.cli-dialog.sandbox'
  | 'session.cli-dialog.open' | 'session.cli-dialog.other';

/**
 * 400 tej samej bramki co {@link HERDR_MODE_UNKNOWN_MESSAGE}, gdy przyczynę ZNAMY: rejestr sesji
 * CLI mówi `waiting`. Stopki nie widać, bo zasłania ją dialog — „pewnie stoi
 * tam pytanie" byłoby zgadywaniem tam, gdzie Rarog wie. Bez rejestru zdanie zostaje stare.
 */
export function herdrDialogStandsMessage(dialog: CliDialogClass): ServerSentence {
  return say('session.dialog-stands', { dialog: cliDialogSentence(dialog) });
}

/** 400 na wysyłkę do panelu spoza `RAROG_HERDR_ROOTS`. */
export const HERDR_OUT_OF_SCOPE_MESSAGE = say('session.out-of-scope');

/**
 * 400 na diff sesji z panelu spoza `RAROG_HERDR_ROOTS`.
 *
 * Diff roboczy to TREŚĆ katalogu. Panel poza zasięgiem nie oddaje transkryptu ani wycinka ekranu
 * i nie ma nawet linii gita, a `diff` do tego dnia jego katalog oddawał — jedyna metoda karty bez
 * bramki zasięgu (patrz {@link HERDR_CODEX_GIT_MESSAGE}).
 */
export const HERDR_OUT_OF_SCOPE_DIFF_MESSAGE = say('session.out-of-scope-diff');

/** 400 for a send while the write channel is closed (`RAROG_HERDR_SEND=0`). */
export const HERDR_READ_ONLY_MESSAGE = say('session.herdr-read-only');

/** 429 na wysyłkę odrzuconą przez throttle. */
export const HERDR_THROTTLED_MESSAGE = say('session.send-throttled');

/** Ile czekamy na pierwsze zdarzenie drivera, zanim zwolnimy slot podpięcia (5.10/6.10). */
export const HERDR_ATTACH_SETTLE_MS = 2_000;

/**
 * Co ile odczytujemy wydanie Claude Code działających sesji i zainstalowane.
 *
 * Instalator natywny aktualizuje się w tle rzadko (dni), a restart sesji dokłada tick sam,
 * więc pół minuty wystarcza z zapasem. Koszt ticku: kilkadziesiąt plików po ~550 B.
 */
export const CLI_VERSION_POLL_MS = 30_000;

/**
 * Co ile czytamy rejestr CLI pod kątem STOJĄCEGO DIALOGU — przy `RAROG_CLI_WAITING`.
 *
 * herdr 0.9.3 nie melduje `blocked` nad formularzem z podglądem ani nad „Exit plan mode?”, a
 * rejestr zgłasza oba w chwili pokazania. 1,5 s to opóźnienie karty, które
 * człowiek ledwo zauważy; odczyt kosztuje `readdir` + `stat` żywych pidów, a `readFile` tylko
 * plików zmienionych od poprzedniego tiku. Ten sam czytnik i ta sama kolejka co migawka wydań.
 */
export const CLI_WAITING_POLL_MS = 1_500;

/**
 * Rodzaj pierwszej karty dialogu w linii pomiaru `dialog timing`: `hook` — karta kanału zgód,
 * `jsonl` — karta zgody drivera z treścią (wpis transkryptu albo zrzut hooka), `screen` — karta zgody drivera bez
 * treści, `question` — formularz pytania, `dialog` — dialog spoza transkryptu.
 */
export type DialogCardKind = 'hook' | 'jsonl' | 'screen' | 'question' | 'dialog';

/** Epizod pomiaru drogi karty: chwila otwarcia, wejście w blokadę i pierwsza karta (ms epoki). */
export interface DialogTiming {
  readonly at: number;
  blockedAt: number | null;
  card: DialogCardKind | null;
}

/**
 * Ile karta sprzed blokady czeka na nią w pomiarze drogi karty: karta kanału przychodzi zwykle przed herdr `blocked`
 * (rejestracja hooka wyprzedza blokadę), a karta bez blokady w tym oknie (decyzja z telefonu przed `blocked`) nie
 * paruje się z blokadą następnego dialogu.
 */
export const DIALOG_TIMING_LEAD_MS = 5_000;

/**
 * Ile czekamy po `/exit` na koniec procesu. CLI 2.1.283 kończy się
 * w < 3 s, a plik rejestru znika razem z nim. Dłużej niż dziesięć sekund znaczy, że coś stoi
 * (dialog wyjścia, zawieszony proces) — wtedy nie startujemy drugiego pisarza.
 */
export const RESTART_EXIT_TIMEOUT_MS = 10_000;
/** Co ile sprawdzamy trzy źródła końca procesu (herdr, rejestr CLI, `claude agents`). */
export const RESTART_EXIT_POLL_MS = 250;
/**
 * Limit of the screen read before the Esc that cancels a restart on the exit dialog: one `agent.read` answers in
 * milliseconds, and a read that does not answer in time only costs the task list in the note, never the Esc.
 */
export const RESTART_EXIT_DIALOG_READ_MS = 2_000;

/**
 * Tryb ze stopki (dokładny) → `--permission-mode` nowego procesu. `unknown` = `null`: restart
 * odmawia, bo start bez flagi dałby tryb domyślny z ustawień, czyli być może WIĘCEJ swobody.
 */
export function restartPermissionMode(
  mode: HerdrMode | 'acceptEdits',
): CreateSessionOptions['permissionMode'] | null {
  switch (mode) {
    case 'manual': return 'manual';
    case 'plan': return 'plan';
    case 'auto': return 'auto';
    case 'acceptEdits': return 'acceptEdits';
    case 'bypass': return 'bypassPermissions';
    default: return null;
  }
}

/**
 * Wynik czyszczenia pola z zablokowanym promptem przed restartem → zdanie odmowy; `null` = pole puste,
 * restart idzie dalej. Te same zdania co bramki z odczytu: przeszkoda ta sama, tylko wykryta w driverze.
 */
export function restartLeftoverRefusal(result: BlockedLeftoverClear, system: ServerSystem): ServerSentence | null {
  switch (result) {
    case 'empty': return null;
    case 'busy': return RESTART_BUSY_MESSAGE;
    case 'changed': return RESTART_PANEL_CHANGED_MESSAGE;
    case 'unknown': return RESTART_COMPOSER_UNKNOWN_MESSAGE;
    default: return restartComposerMessage(system);
  }
}

/**
 * Wynik startu, po którym proces MÓGŁ wstać (zgubiona odpowiedź gniazda, brak gotowości
 * w oknie) — wtedy karta nie udaje „wznawialnej", bo drugi pisarz jest możliwy. Duck-typing,
 * bo manager importuje z `herdr/*` wyłącznie typy (nagłówek importów).
 */
export function uncertainLaunch(error: unknown): boolean {
  const shape = error as { code?: unknown; name?: unknown } | null;
  return shape?.code === 'herdr-unavailable' || shape?.name === 'HerdrLaunchTimeoutError';
}

/** Stany, w których sesja żyje i przyjmuje strumień z drivera. */
export const LIVE_STATES: readonly SessionState[] = [
  'starting', 'running', 'waiting-input', 'waiting-permission', 'waiting-question',
];

/**
 * Stany, w których użytkownik może wysłać wiadomość.
 *
 * Bez `starting`: panel, w którym `claude` jeszcze nie wstał, dostałby klawisze przed gotowością. Prompt startowy
 * tą bramką nie idzie — `#finishLaunch` po gotowości woła wprost `driver.send`. Panel z Raroga do gotowości nie
 * wchodzi do tych stanów: ze `starting` i z dialogu startowego zostaje albo wraca do `starting`
 * (`Session.launchPending`, `#applyTransition`), a bramka `#sendMessage` odmawia mu niezależnie od stanu.
 */
export const SENDABLE_STATES: readonly SessionState[] = ['running', 'waiting-input'];

/**
 * Stany, w których delta ma prawo malować podgląd strumienia.
 *
 * Węższe niż `LIVE_STATES` o `waiting-input` — i to jest cała pointa Esc: przerwanie
 * przestawia sesję od razu na „czeka na wiadomość", a spóźnione delty umierającej tury
 * nie mogą malować podglądu obok pola, do którego właśnie wrócił prompt użytkownika.
 */
export const STREAMING_STATES: readonly SessionState[] = [
  'starting', 'running', 'waiting-permission', 'waiting-question',
];

/**
 * Stany, w których agent PRACUJE — poza nimi wskaźnik aktywności nie ma prawa się kręcić.
 *
 * Węższe niż `LIVE_STATES`: `waiting-input` znaczy „agent skończył", a przy zgodzie/pytaniu
 * na ekranie stoi karta, która mówi znacznie więcej niż „uruchamia: Bash".
 */
export const WORKING_STATES: readonly SessionState[] = ['starting', 'running'];

/**
 * Stany, w których na sesji STOI DECYZJA — lustro `WORKING_STATES` dla pola `waitingFor`.
 *
 * Rozłączne z `WORKING_STATES` świadomie: karta listy niesie ALBO etap pracy, ALBO to, na co
 * sesja czeka. Poza tymi dwoma stanami `waitingFor` nie ma prawa jechać nawet wtedy, gdy
 * w kolejce został wpis — „zgoda: Bash" nad sesją, która poszła dalej, to kłamstwo na liście.
 */
export const DECISION_STATES: readonly SessionState[] = ['waiting-permission', 'waiting-question'];

/**
 * Sesja jest W TURZE: agent pracuje albo tura stoi na decyzji człowieka. Wyjście z tych stanów
 * do dowolnego innego to koniec tury w rozumieniu managera (granica rachunku `Session.turnInput`).
 */
export function inTurn(state: SessionState): boolean {
  return WORKING_STATES.includes(state) || DECISION_STATES.includes(state);
}

/**
 * Zdarzenie ZACZYNA turę: prompt z Raroga, praca albo dialog widziane przez herdr, wznowienie. Uzasadnienie
 * listy (czemu bez `driver-init` i rozstrzygnięć decyzji, czemu z `agent-blocked`) stoi przy zerowaniu odbioru
 * w `#applyTransition`; ta sama lista gasi tam „karta wstaje” (`Session.awaitingFirstTurn`).
 */
export function startsTurn(event: SmEvent): boolean {
  return event.type === 'turn-start' || event.type === 'agent-working'
    || event.type === 'resumed' || event.type === 'agent-blocked';
}

/**
 * Rachunek wiadomości tury PO jej końcu (`Session.turnInput`).
 *
 * Zwykle zaczyna od zera. Wyjątek: tura skończyła się z PUSTYM rachunkiem. Każda tura ma
 * wejście, więc pusty rachunek znaczy, że manager go nie zobaczył — albo jeszcze nie: plik
 * rozmowy czyta follower (zwykle 0,1 s po zapisie, przy zgubionym zdarzeniu systemu plików do
 * 2 s), a koniec tury melduje herdr, niezależnie. Spóźniona notka o postoju doliczyłaby się do
 * NASTĘPNEJ tury i wyciszyła jej „gotowe". Rachunek po takim końcu jest więc niepełny
 * (`undefined`) do kolejnego końca tury: jedna tura bez wnioskowania, czyli zwykłe „gotowe".
 *
 * Drugi wyjątek: sesja, która wstaje (`started` w `#applyTransition`: pierwsze wyjście z tury karty
 * powstałej w `starting`, w tym tura zerowa). To nie koniec tury, tylko panel, który wstał (pierwsze
 * `idle` nowego panelu, podpięcie panelu bez tury, pusta sesja z Raroga) — rachunek niepełny po
 * podpięciu drivera ma taki zostać, aż manager zobaczy koniec PRAWDZIWEJ tury
 * (inaczej prompt startowy sesji założonej z Raroga nie liczyłby się nigdzie).
 */
export function nextTurnInput(ended: Session['turnInput'], started: boolean): Session['turnInput'] {
  if (started) return undefined;
  // Pusty = bez wejścia. Wywołania narzędzi wejściem nie są: tura musiała mieć przyczynę.
  const empty = ended !== undefined && noInputYet(ended);
  return empty ? undefined : { standbyNotices: 0, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 };
}

/**
 * Jak długo po końcu tury po samym meldunku o artefakcie spóźnione wywołanie narzędzia z pliku
 * rozmowy jeszcze ją poprawia (`Session.quietTurnEnd`). Follower
 * oddaje wpis zwykle po 0,1 s, po zgubionym zdarzeniu systemu plików do 2 s; tu zapas pięciokrotny.
 */
export const LATE_TOOL_CALL_MS = 10_000;

/**
 * Koniec tury, w którym o ciszy rozstrzyga BRAK narzędzi: same notki o artefakcie albo granice kompakcji
 * (także z postojem), zero wywołań, zdarzenie klasy „gotowe". Manager nie decyduje o ciszy (`noResultTurn` w
 * `notify/policy.ts`); rozpoznaje tylko rachunek, który spóźnione wywołanie narzędzia może zmienić.
 */
export function toolsDecideSilence(turn: Session['turnInput'], event: SmEvent): turn is TurnTally {
  return turn !== undefined && (turn.artifactWatch > 0 || turn.compactions > 0) && turn.other === 0
    && turn.toolCalls === 0
    && (event.type === 'agent-idle' || (event.type === 'result' && event.subtype === 'success'));
}

/** Rachunek bez żadnego wejścia: tura, do której należy, jeszcze się w nim nie zaczęła. */
export function noInputYet(turn: TurnTally): boolean {
  return turn.standbyNotices === 0 && turn.artifactWatch === 0 && turn.other === 0 && turn.compactions === 0;
}

/**
 * What a turn input adds to the tally: a subagent standby notice, an artifact notification, a compaction
 * boundary of the main thread, or anything else (`other`). The kind of notice comes from `notice.ts`.
 */
export function tallyTurnInput(turn: TurnTally, notice?: TranscriptNotice, compaction = false): TurnTally {
  if (compaction) return { ...turn, compactions: turn.compactions + 1 };
  if (notice?.outcome === 'waiting') return { ...turn, standbyNotices: turn.standbyNotices + 1 };
  if (notice?.kind === 'artifact-watch') return { ...turn, artifactWatch: turn.artifactWatch + 1 };
  return { ...turn, other: turn.other + 1 };
}

/** Stany, w których tura jest SKOŃCZONA — wejście w nie odświeża wiersz gita bez throttle'a. */
export const TURN_END_STATES: readonly SessionState[] = ['waiting-input', 'done', 'error', 'interrupted', 'limit-reached'];

/**
 * Copy 409 przy zmianie modelu, gdy panel nie jest w stanie jej przyjąć.
 *
 * Jedno zdanie na dwa powody, bo dla człowieka są tym samym: w środku tury komenda wpadłaby
 * w kolejkę promptów, a przy otwartym dialogu poszłaby do dialogu. Oba kończą się „nic się
 * nie stało" — i oba mają tę samą radę.
 */
export const MODEL_BUSY_MESSAGE = say('model.busy');

/**
 * Stany, w których wolno wysłać `/model` albo `/effort` — DOKŁADNIE jeden.
 *
 * Węższe niż `SENDABLE_STATES` o `running`, czyli agenta w turze. Pozostałe
 * powody odpadają już tam: `starting` to panel, w którym `claude` jeszcze nie wstał (`agent_not_ready`),
 * a `waiting-permission`/`waiting-question` to stojący dialog, do którego komenda wpadłaby
 * jako odpowiedź. Zostaje `waiting-input`, czyli „panel czeka na człowieka" — jedyny moment,
 * w którym slash-komenda jest tym, na co wygląda.
 */
export const MODEL_CHANGE_STATES: readonly SessionState[] = ['waiting-input'];

/**
 * Zdanie 400 katalogu odrzuconego przez `validateProjectCwd`: powód bez argumentów jedzie jako podkod
 * (`session.cwd-denied`), lista korzeni spłaszczona do argumentu (`session.cwd-denied.outside-roots`). Powód bez
 * kodu albo z innymi argumentami wychodzi sam, bez ścieżki.
 */
export function cwdDeniedSentence(cwd: string, reason: OwnText): OwnText {
  if (!isServerSentence(reason)) return reason;
  const args = reason.ref.args ?? [];
  if (reason.ref.code === 'rest.cwd-outside-roots.listed' && args[0] !== undefined) {
    return say('session.cwd-denied.outside-roots', { cwd, roots: args[0] });
  }
  return args.length === 0 && isCwdReason(reason.ref.code) ? say('session.cwd-denied', { cwd, reason: reason.ref.code }) : reason;
}

/** Podkody `session.cwd-denied`: powody `validateProjectCwd` bez argumentów. */
const CWD_REASONS = [
  'rest.cwd-empty', 'rest.cwd-not-absolute', 'rest.cwd-hidden', 'rest.cwd-not-in-projects', 'rest.cwd-outside-roots',
  'rest.cwd-not-found', 'rest.cwd-symlink-escape', 'rest.cwd-protected',
] as const;
const isCwdReason = (code: string): code is (typeof CWD_REASONS)[number] =>
  (CWD_REASONS as readonly string[]).includes(code);
