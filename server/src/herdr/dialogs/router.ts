/**
 * Rozdzielacz warstw: która warstwa obsługi powinna wziąć dialog, który stoi w panelu.
 *
 * Trzy źródła, każde z jedną rolą: rejestr sesji CLI (`waitingFor`) daje KLASĘ dialogu, zrzut hooka
 * `PermissionRequest` daje adres i treść zgody na narzędzie (warstwa 1), a ekran daje treść dialogu CLI
 * (warstwa 2) albo formularza pytania. O warstwie rozstrzyga klasa, nie wygląd ekranu: zgoda na narzędzie
 * (`permission`) i prośba sandboksa (`sandbox`) nigdy nie idą cyfrą z ekranu. Ekran tylko potwierdza, że
 * kształt pasuje do klasy; gdy nie pasuje, werdykt to „bez przycisków”.
 *
 * Werdykt opisuje CEL obsługi, nie dzisiejszą decyzję „jaka karta”: dziś decyduje `decide/decide.ts`,
 * a werdykt trafia wyłącznie do dziennika (`route`, `routeReason` w kształcie przypadku, `audit.ts`), żeby
 * dało się policzyć, ile dialogów wzięłaby która warstwa. Funkcje są czyste, nad jawnymi argumentami; stan
 * panelu (klasa z rejestru, zrzut, odczyt ekranu) podaje fasada drivera. Opis: `docs/dialogs.md`.
 */
import type { CliDialogClass } from '@rarog/shared';
import { HOOK_PERMISSION_REQUEST_EVENT, HOOK_QUESTION_TOOL } from './hook/contract.ts';
import type { PendingHookTool } from './hook/dump.ts';
import type { MeasuredConsentMark } from './policy/measured-consent.ts';
import { screenFallbackHolds } from './screen-fallback.ts';
import type { ScreenFallbackMark } from './screen-fallback.ts';
import { askFormOnScreen, cliDialogOnScreen } from './presence.ts';

/**
 * Werdykt rozdzielacza — ZAMKNIĘTA lista, bo wpisy dziennika mają się sumować:
 *
 * - `layer1` — zgoda na narzędzie przez kanał hooka: adres i treść ze zrzutu, decyzja plikiem odpowiedzi;
 * - `terminal-only` — zgoda bez żywego kanału: tylko terminal, bez przycisków i bez cyfry;
 * - `question-form` — formularz pytania: odpowiedź kanałem hooka albo cyfrą po etykiecie (odpowiedź, nie zgoda);
 * - `layer2` — dialog CLI: treść i opcje z bloku na ekranie;
 * - `none` — bez przycisków: klasa bez warstwy, brak klasy w rejestrze albo ekran nie pasuje do klasy.
 */
export const DIALOG_ROUTES = ['layer1', 'terminal-only', 'question-form', 'layer2', 'none'] as const;
export type DialogRoute = (typeof DIALOG_ROUTES)[number];

/**
 * Powód werdyktu — ZAMKNIĘTA lista, po jednym na wiersz tabeli {@link routeDialog}:
 *
 * - `permission-dump` / `permission-agent-dump` — klasa `permission` i zrzut `PermissionRequest` wątku
 *   głównego / subagenta (`agent_id`);
 * - `permission-no-dump` — klasa `permission` bez zrzutu `PermissionRequest`;
 * - `sandbox` — klasa `sandbox`: prośba sieci sandboksa nie ma hooka `PermissionRequest`;
 * - `input-form` — klasa `input` i formularz pytania (albo ekran przeglądu odpowiedzi) na ekranie;
 * - `input-shape` — klasa `input`, a na ekranie nie ma formularza pytania;
 * - `dialog-block` — klasa `dialog` i dialog z kompletem opcji na ekranie;
 * - `dialog-shape` — klasa `dialog`, a na ekranie nie ma dialogu CLI (nic albo formularz pytania);
 * - `worker-class` — klasa `worker`: bez warstwy;
 * - `other-class` — klasa `other` (wartość `waitingFor` spoza znanych) albo `goal` (klasa kontraktu, której
 *   rejestr nie podaje);
 * - `no-class` — rejestr nie mówi `waiting` (brak rejestru, sesja aktywna, dwóch pisarzy jednej rozmowy);
 * - `dump-no-class` — jak `no-class`, ale stoi zrzut `PermissionRequest`: prośba ukryta (subagent w tle,
 *   dialogu jeszcze nie ma) albo zrzut stęchły; bez dowodu, że dialog stoi, bez przycisków.
 */
export const DIALOG_ROUTE_REASONS = [
  'permission-dump', 'permission-agent-dump', 'permission-no-dump', 'sandbox', 'input-form', 'input-shape',
  'dialog-block', 'dialog-shape', 'worker-class', 'other-class', 'no-class', 'dump-no-class',
] as const;
export type DialogRouteReason = (typeof DIALOG_ROUTE_REASONS)[number];

/** Zrzut hooka `PermissionRequest` dla sesji: brak, wątek główny albo subagent (`agent_id`). */
export type RouteHook = 'none' | 'main' | 'agent';

/** Co stoi na ekranie: dialog z kompletem opcji, formularz pytania albo nic rozpoznawalnego. */
export type RouteScreen = 'block' | 'form' | 'none';

export interface RouteInput {
  /** Klasa z rejestru sesji CLI, gdy rejestr mówi `waiting`; `null` = nie mówi albo „nie wiem”. */
  readonly cliDialog: CliDialogClass | null;
  readonly hook: RouteHook;
  readonly screen: RouteScreen;
}

export interface RouteVerdict {
  readonly route: DialogRoute;
  readonly reason: DialogRouteReason;
}

const verdict = (route: DialogRoute, reason: DialogRouteReason): RouteVerdict => ({ route, reason });

/**
 * Tabela rozdzielacza. Klasa wybiera warstwę; zrzut decyduje tylko w klasie `permission` (kanał albo „tylko
 * terminal”), ekran tylko w klasach z treścią z ekranu (`input`, `dialog`). Ekran nie zmienia werdyktu zgody:
 * w warstwie 1 daje wyłącznie sygnały negatywne, które zabierają przyciski, ale nie zmieniają warstwy.
 *
 * Werdykt to obsługa docelowa bez wyjątków. Zgoda subagenta (`permission-agent-dump`) ma osobny powód, bo
 * tryb kanału tylko dla wątku głównego zostawia ją dzisiejszej ścieżce.
 */
export function routeDialog(input: RouteInput): RouteVerdict {
  switch (input.cliDialog) {
    case 'permission':
      if (input.hook === 'main') return verdict('layer1', 'permission-dump');
      if (input.hook === 'agent') return verdict('layer1', 'permission-agent-dump');
      return verdict('terminal-only', 'permission-no-dump');
    case 'sandbox':
      return verdict('terminal-only', 'sandbox');
    case 'input':
      return input.screen === 'form'
        ? verdict('question-form', 'input-form')
        : verdict('none', 'input-shape');
    case 'dialog':
      return input.screen === 'block'
        ? verdict('layer2', 'dialog-block')
        : verdict('none', 'dialog-shape');
    case 'worker':
      return verdict('none', 'worker-class');
    case 'goal':
    case 'other':
      return verdict('none', 'other-class');
    case null:
      return input.hook === 'none'
        ? verdict('none', 'no-class')
        : verdict('none', 'dump-no-class');
  }
}

/**
 * Czy werdykt dopuszcza cyfrę z ekranu: formularz pytania (cyfra po etykiecie, gdy kanału hooka nie ma)
 * i dialog CLI warstwy 2. Zgoda w warstwie 1 idzie plikiem odpowiedzi, „tylko terminal” i `none` nie mają
 * przycisków.
 */
export function routeAllowsDigit(route: DialogRoute): boolean {
  return route === 'question-form' || route === 'layer2';
}

/** Nazwy kart, które odpowiadają na pytanie (formularz), a nie zgadzają się na narzędzie. */
const ANSWER_CARD_TOOLS: ReadonlySet<string> = new Set([HOOK_QUESTION_TOOL, 'dialog:question']);

/** Karty dialogów z zamkniętej listy sygnatur (`KNOWN_DIALOG_IDS`): zaufanie katalogu i zmiana modelu. */
const KNOWN_DIALOG_CARD_TOOLS: ReadonlySet<string> = new Set(['dialog:trust', 'dialog:model']);

export interface ConsentDigitInput {
  /** Tryb efektywny kanału zgód (`layer1/mode.ts`); `null` = nie wiadomo (wyjątek źródła trybu). */
  readonly mode: 'off' | 'shadow' | 'main' | 'all' | null;
  /** Klasa z rejestru sesji CLI przy `waiting`; `null` = rejestr nie mówi. */
  readonly cliDialog: CliDialogClass | null;
  /** Nazwa narzędzia karty (`dialog:<rodzaj>` dla kart z ekranu). */
  readonly toolName: string;
  /** Cyfra z przycisku zgody karty (`respondPermission`); `false` = odpowiedź na pytanie (`answerQuestion`). */
  readonly consent: boolean;
  /** Measured consent dialog the card came from (`ActiveReq.measuredConsent`); absent = not that path. */
  readonly measured?: MeasuredConsentMark;
  /** Emergency approve button of a consent dialog without a hook (`ActiveReq.screenFallback`); absent = not that path. */
  readonly fallback?: ScreenFallbackMark;
}

/** Which exception lets the "Yes" digit of a consent class card through, measured shape first. */
export type ConsentDigitException = 'measured' | 'screen-fallback';

/**
 * Bramka cyfry w trybie kanału : przy efektywnym `main` i `all` (i przy trybie nieznanym) klasa
 * `permission`/`sandbox` nie dostaje cyfry na żadnej ścieżce, w wątku głównym i u subagentów. Zgoda wątku głównego
 * idzie kartą kanału (plik odpowiedzi), reszta w terminalu.
 *
 * Fail-closed: cyfra przechodzi tylko wtedy, gdy wiadomo, że to nie zgoda. Klasa `permission` albo `sandbox`
 * blokuje zawsze. Przycisk zgody przechodzi wyłącznie dla dialogu z zamkniętej listy (zaufanie, model). Odpowiedź
 * na pytanie przechodzi dla formularza pytania i dialogu z zamkniętej listy, a każda inna karta (potwierdzenie
 * z ekranu, które bywa zgodą `WebFetch`) tylko przy klasie `input` albo `dialog` z rejestru. Przy `off` i `shadow`
 * nic się nie zmienia. Klawisz `escape` (odmowa) tej bramki nie przechodzi: niczego nie zatwierdza.
 *
 * Two exceptions ({@link consentDigitException}) let the "Yes" button through; the driver checks each again on a fresh
 * screen and the registry right before the key.
 */
export function consentDigitBlocked(input: ConsentDigitInput): boolean {
  if (input.mode === 'off' || input.mode === 'shadow') return false;
  if (input.cliDialog === 'permission' || input.cliDialog === 'sandbox') return consentDigitException(input) === null;
  if (KNOWN_DIALOG_CARD_TOOLS.has(input.toolName)) return false;
  if (input.consent) return true;
  if (ANSWER_CARD_TOOLS.has(input.toolName)) return false;
  return input.cliDialog !== 'input' && input.cliDialog !== 'dialog';
}

/**
 * The exception that lets the "Yes" button of a `permission` or `sandbox` card through in channel mode, or `null`:
 * a measured consent mark under the same registry class (sandbox network, MCP tool with user interaction: neither has
 * a working hook answer), else the emergency mark of a `permission` dialog without a hook, by the rule of
 * `screen-fallback.ts` under the live mode and class. Never for an answer (`consent: false`).
 */
export function consentDigitException(input: ConsentDigitInput): ConsentDigitException | null {
  if (!input.consent) return null;
  if (input.measured !== undefined && input.measured.cliDialog === input.cliDialog) return 'measured';
  if (input.fallback !== undefined && screenFallbackHolds(input.fallback, input.mode, input.cliDialog)) {
    return 'screen-fallback';
  }
  return null;
}

/**
 * The hook dump as router input: only a tool permission request dump matters, i.e. the `PermissionRequest`
 * event (the CLI is about to ask) for a tool other than the question form. A `PreToolUse` dump (the tool input
 * before the CLI's decision) and a question form dump are the answer channel, not consent (docs: hooks,
 * "PermissionRequest" and "PreToolUse"). This read does not check the dump's liveness (the hook process, proof
 * that the dialog stands): the dump is a file within its validity window (`hook/dump.ts`).
 */
export function routeHookOf(dump: PendingHookTool | null): RouteHook {
  if (dump?.hookEventName !== HOOK_PERMISSION_REQUEST_EVENT || dump.toolName === HOOK_QUESTION_TOOL) return 'none';
  return dump.agentId === undefined ? 'main' : 'agent';
}

/**
 * Ekran jako wejście rozdzielacza, z tych samych rozpoznań co rezerwy drivera (`presence.ts`): formularz
 * pytania albo ekran przeglądu odpowiedzi to `form`, każdy inny dialog z kompletem opcji (także dialog zgody
 * spoza blokady herdr i dialog sieci sandboksa) to `block`. Ekran nieczytelny albo bez dialogu to `none`.
 */
export function routeScreenOf(text: string | null): RouteScreen {
  if (text === null) return 'none';
  if (askFormOnScreen(text) === 'form') return 'form';
  return cliDialogOnScreen(text) === 'dialog' ? 'block' : 'none';
}
