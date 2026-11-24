/**
 * Append-only dziennik wszystkiego, co Rarog WYSŁAŁ do cudzego panelu.
 *
 * Po co: dziś jedyna odpowiedź na pytanie „co poszło do 17 żywych sesji z ukradzionego
 * telefonu" brzmi „nie wiadomo". Runbook „Lost or stolen phone" dostaje krok
 * `RAROG_HERDR_SEND=0` **i** `RAROG_HERDR_LAUNCH=0` + restart + przegląd tego pliku od czasu
 * kradzieży (wpisy `launch`, `approve`, `close_tab`). Killswitche są DWA i są rozłączne:
 * pierwszy zamyka pisanie do paneli, drugi — zakładanie nowych (`docs/security-model.md`, „Emergency runbook”).
 *
 * Czego tu NIE MA i mieć nie będzie: pełnej treści wiadomości (tylko sha256 + 200 znaków),
 * zdjęć, treści ekranu panelu. Dziennik jest do ŚLEDZTWA, nie do autoryzacji — dlatego zapis
 * jest asynchroniczny i jego błąd NIGDY nie blokuje wysyłki. Blokowanie wysyłki na błędzie
 * logu zamieniłoby brak miejsca na dysku w awarię całej integracji.
 *
 * Samo przycięcie do 200 znaków NIE JEST ochroną przed sekretem: tnie od KOŃCA, a
 * `SONIOX_API_KEY=… pnpm run restart` ma sekret na POCZĄTKU linii i mieści się w całości.
 * Plik, który runbook „kradzież telefonu" każe potem przeglądać, nie może sam być wyciekiem —
 * stąd `redactAuditText` na drodze `text`/`optionLabel` → plik.
 */
import { appendFile, chmod, mkdir, rename, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { CLI_DIALOG_CLASSES, REFUSE_REASONS } from '@rarog/shared';
import type { HerdrMode, RefuseReason } from '@rarog/shared';
import type { MessageSource } from '@rarog/shared/rest';
import { REDACTED, redact } from '../auth/index.ts';
import type { CliDialogClass } from '../cli-version.ts';
import { HOOK_BUDGET_SOURCES } from './hook-config.ts';
import type { HookBudgetSource } from './hook-config.ts';
import {
  BLOCK_CARD_VERDICTS, DIALOG_ROUTES, DIALOG_ROUTE_REASONS, LAYER2_EPISODE_VERDICTS, LAYER2_WHYS, SHADOW_RESULTS,
  TERMINAL_DIALOG_IDS,
} from './dialogs/index.ts';
import type {
  BlockCardVerdict, DialogRoute, DialogRouteReason, Layer2EpisodeVerdict, Layer2Why, ShadowOutcome, ShadowResult,
  TerminalDialogId,
} from './dialogs/index.ts';
import { NO_PROOF_REASONS } from './dialogs/shadow/evidence.ts';

export const HERDR_AUDIT_FILENAME = 'herdr-audit.log';

/** Powyżej tego rozmiaru plik jedzie do `.log.1` (jedna generacja wstecz, jak `client.log`). */
export const HERDR_AUDIT_MAX_BYTES = 8 * 1024 * 1024;

/** Ile znaków tekstu (po sanityzacji) trafia do dziennika. */
export const HERDR_AUDIT_TEXT_HEAD = 200;

/** Prawa pliku: dziennik czyta wyłącznie właściciel procesu. */
const FILE_MODE = 0o600;

/**
 * Kształt przypisania `NAZWA=wartość` na granicy tokenu (początek linii albo spacja).
 *
 * Łapie DWA warianty tej samej rzeczy: zmienną środowiskową w prefiksie komendy
 * (`SONIOX_API_KEY=… pnpm run restart` — dokładnie to, co robi runbook restartu, który
 * wczytuje plik sekretów powłoki) i długą flagę z wartością (`--api-key=…`). Nazwa ZOSTAJE, ginie
 * sama wartość: śledztwo dalej widzi, KTÓRA zmienna została podstawiona, a hash całości
 * pozwala porównać dwa wpisy ze sobą.
 *
 * Czego świadomie NIE łapie: wartości po spacji (`--token abc`), sekretów w URL-u
 * (`?token=abc` — „token" nie stoi po białym znaku) ani nagłówków (`Authorization: Bearer …`).
 * Regexp nie zastąpi listy sekretów procesu — to DRUGA warstwa, obok `secrets` niżej, a nie
 * obietnica szczelności. Wartość w cudzysłowie zjadamy w całości, żeby `FOO="a b" cmd`
 * nie zostawiło drugiego członu na wierzchu.
 */
const ASSIGNMENT_RE = /(^|\s)(-{0,2}[A-Za-z_][A-Za-z0-9_.-]*)=("[^"]*"|'[^']*'|\S+)/g;

/**
 * Jedyna droga tekstu do pliku dziennika.
 *
 * Kolejność jest istotna: najpierw maskujemy kształt przypisania, potem wycieramy DOSŁOWNE
 * sekrety procesu — sekret podstawiony pod zmienną znika już w pierwszym kroku, a ten sam
 * sekret wklejony gdziekolwiek indziej (URL, argument po spacji) łapie krok drugi.
 *
 * Redakcja idzie na PEŁNYM tekście, PRZED przycięciem do 200 znaków. Odwrotna kolejność
 * zostawiałaby w pliku początek sekretu, który akurat przechodzi przez granicę przycięcia.
 */
export function redactAuditText(value: string, secrets: readonly string[] = []): string {
  return redact(value.replace(ASSIGNMENT_RE, `$1$2=${REDACTED}`), secrets);
}

/**
 * Powody odmowy — ZAMKNIĘTA lista, bo z tych liczb dziennik ma dać rozkład odmów.
 *
 * Lista NIE MIESZKA tutaj: jest w protokole ({@link REFUSE_REASONS}), bo ta
 * sama unia jest naraz powodem w dzienniku, powodem w kontrakcie drivera
 * (`DecisionOutcome.refused`) i polem `reason` w odpowiedzi 422 czytanej przez klienta. Alias
 * zostaje, żeby ~30 miejsc w driverze i testach nie musiało wiedzieć, skąd unia pochodzi;
 * test kontraktowy pilnuje, że to naprawdę JEDNA lista, a nie dwie zgodne przez przypadek.
 *
 * - `mismatch` — ekranu nie da się uzgodnić z jsonl/hookiem (rodzaj dialogu, nazwa narzędzia, treść operacji
 *   albo konkurencja źródeł; podpowód w `mismatchReason`): karta bez przycisków;
 * - `unreadable` — ekranu nie dało się sparsować także po ponowieniu;
 * - `no-jsonl` — dialog spoza jsonl i spoza zamkniętej listy sygnatur: wycinek + „Odrzuć";
 * - `multi-select` — formularz wielokrotnego wyboru: jedna cyfra niczego nie zatwierdza;
 * - `no-digit` — etykiety nie ma na żywej liście albo nie ma jednoznacznej opcji „tak";
 * - `terminal-only` — opcja eskalująca uprawnienia, wysyłka odmówiona po stronie serwera;
 * - `screen-changed` — cyfra przestała znaczyć to samo na ekranie tuż przed wysyłką;
 * - `stale-card` — decyzja adresowała kartę, której już nie ma;
 * - `form-submit` — DRUGI krok formularza z preview: cyfra POSZŁA, `enter` NIE.
 *   Jedyne miejsce, w którym Rarog zatrzymuje decyzję na żywym ekranie już po pierwszym
 *   klawiszu (dialog zniknął, karta podmieniona, `confirmFormSubmit` odmówił) — bez tego
 *   wpisu najciekawsza część statystyki nie trafiałaby do sumy odmów w ogóle;
 * - `send-failed` — herdr odrzucił samo wywołanie (panel zniknął, tryb tylko do odczytu,
 *   blokada). Idzie z kontraktem `DecisionOutcome`: bez niego „nic nie poszło
 *   do panelu" wracałoby do telefonu jako 200, czyli jako zatwierdzenie, którego nie było.
 *
 * Jeden powód z unii nie powstaje w driverze i dlatego NIGDY nie ma go w dzienniku —
 * {@link NON_DRIVER_REFUSE_REASONS}.
 */
export const HERDR_REFUSE_REASONS = REFUSE_REASONS;

/**
 * Powody spoza drivera — do dziennika nie trafiają, bo `auditRefusal` woła wyłącznie driver.
 *
 * `in-flight` powstaje w blokadzie równoległych prób (`PendingInteractions`) i mówi „poczekaj,
 * decyzja z drugiego urządzenia właśnie leci" — to nie jest awaria ścieżki cyfrowej, więc
 * doliczenie go do statystyki odmów fałszowałoby jedyną liczbę, dla której dziennik istnieje.
 * Lista mieszka tutaj, żeby strażniki pokrycia w testach miały JEDNO źródło prawdy.
 */
export const NON_DRIVER_REFUSE_REASONS: readonly RefuseReason[] = ['in-flight'];

export type HerdrRefuseReason = RefuseReason;

/**
 * Powody odmowy, które istnieją WYŁĄCZNIE w dzienniku — nie w protokole (`REFUSE_REASONS` jedzie do apki
 * w karcie i w odpowiedzi 422, a ten powód nigdy).
 *
 * `command-not-allowed`: strażnik tekstu odrzucił slash-komendę spoza katalogu sesji (400 na
 * `POST …/message`). Wpis niesie samą nazwę (`command`), bez treści wiadomości; {@link summarizeCommandRefusals}
 * liczy je per nazwa, żeby po tygodniu znaleźć fałszywe odmowy.
 */
export const AUDIT_ONLY_REFUSE_REASONS = ['command-not-allowed'] as const;
export type AuditOnlyRefuseReason = (typeof AUDIT_ONLY_REFUSE_REASONS)[number];

/**
 * Powód wpisu `restart`: `cli-update` = pigułka „↑ <wydanie>”, `prompt-blocked` = przycisk
 * „Uruchom ponownie i wyślij” pod notką promptu zablokowanego przez hook. Odmowy to nie są — suma odmów
 * ({@link summarizeRefusals}) liczy wyłącznie metody `refuse` i `degrade`.
 */
export const RESTART_REASONS = ['cli-update', 'prompt-blocked'] as const;
export type RestartReason = (typeof RESTART_REASONS)[number];

/** Ile znaków nazwy komendy trafia do dziennika przy odmowie `command-not-allowed`. */
export const HERDR_AUDIT_COMMAND_HEAD = 64;

/**
 * Podpowód rozjazdu ekranu ze źródłem karty (`mismatchReason`) — zamknięta lista, bo wpisy mają się sumować.
 *
 * Pierwsze pięć to podpowody `resolveOptions` (`DecisionResolution` z `status: 'mismatch'`):
 * inny rodzaj dialogu, inna albo nieczytelna nazwa narzędzia, formularz wielokrotnego wyboru, ramka
 * operacji z inną komendą albo ucięta u góry bez podwójnego dowodu i blok dialogu niejednoznaczny
 * (`ambiguous`: nad opcjami więcej niż jedna para „kreska + tytuł”; także na ścieżce bez wpisu jsonl).
 * `ambiguous-sources` to karta bez przycisków z rozstrzygania konkurencji źródeł (`settleCompeting`):
 * ekran pasuje do wpisu jsonl i do zrzutu hooka naraz albo nie potwierdza treści wpisu tego samego narzędzia.
 */
export const AUDIT_MISMATCH_REASONS = [
  'kind', 'tool-name', 'multi-select', 'operation', 'ambiguous', 'ambiguous-sources',
] as const;
export type AuditMismatchReason = (typeof AUDIT_MISMATCH_REASONS)[number];

/**
 * Skąd karta wzięła narzędzie i wejście, z którym porównano ekran (`source`):
 * `jsonl` — wpis transkryptu, `hook` — zrzut hooka, `screen` — sam ekran.
 */
export const AUDIT_CARD_SOURCES = ['jsonl', 'hook', 'screen'] as const;
export type AuditCardSource = (typeof AUDIT_CARD_SOURCES)[number];

/**
 * KSZTAŁT przypadku przy `approve`, `degrade` i `refuse`: same identyfikatory, flagi
 * i liczby, bez treści ekranu i bez etykiet opcji. Te same pola idą do dziennika i do zrzutu odmowy.
 *
 * Po co: przy samym `mismatch` (np. zgoda `Bash` subagenta z ramką uciętą u góry) podpowód `operation`, brak nagłówka
 * na ekranie i liczba opcji ginęłyby po drodze, a zrzut z ekranem wygasa po 48 h. Bez kształtu dziennik nie odróżnia
 * „Rarog nie widzi nagłówka” od „ekran pokazuje inne narzędzie”.
 */
export interface AuditCaseShape {
  /**
   * Tożsamość karty (`ActiveReq.reqId`): `tool_use.id` albo generacja zrzutu hooka plus sufiks
   * ze skrótem — spina wpisy jednej karty (`degrade` → `refuse`/`approve`) z ramką SSE.
   */
  reqId?: string;
  source?: AuditCardSource;
  /** `tool_use.id` wywołania: z wpisu jsonl albo ze zrzutu `PreToolUse` (zrzut `PermissionRequest` go nie ma). */
  toolUseId?: string;
  /** `prompt_id` tury ze zrzutu hooka. */
  promptId?: string;
  /** `agent_id` subagenta ze zrzutu hooka — zgoda wątku głównego pola nie ma. */
  agentId?: string;
  /** Dla `degrade`: podpowód rozjazdu z PIERWSZEGO rozpoznania ekranu (przed spadkiem na ścieżkę ekranową). */
  mismatchReason?: AuditMismatchReason;
  /**
   * Czy nad ramką operacji widać górną kreskę dialogu, czyli nagłówek (`ScreenOperation.headerVisible`).
   * Brak pola = dialog bez ramki operacji albo ekran nieczytelny.
   */
  headerVisible?: boolean;
  /** Liczba opcji z cyframi na ekranie (`parseOptions`); `0` = ekran bez opcji z cyframi. */
  optionCount?: number;
  /**
   * Czy CAŁY blok dialogu stoi w tym samym odczycie ekranu (`blockVisible`, `dialogs/screen/block-visible.ts`):
   * górna kreska bloku, tytuł pod nią, komplet opcji `1…N` i stopka klawiszowa pod opcjami. `false` = dialog
   * ucięty u góry, widok przewinięty, dialog bez stopki albo ekran bez dialogu. Brak pola = brak odczytu ekranu.
   */
  blockVisible?: boolean;
  /**
   * Dialog z zamkniętej listy `TERMINAL_DIALOGS` (`dialogs/policy/terminal.ts`) rozpoznany na
   * ekranie: `session-paused-safeguards`, `background-work-exit`. `null` = dialog spoza listy.
   */
  dialogTitle?: TerminalDialogId | null;
  /**
   * Dla `degrade`: liczba wierszy terminala panelu z herdr (`scroll.viewport_rows` wpisu panelu
   * w `pane.list`) — nie liczba linii tekstu z `agent.read` i nie prostokąt `pane.layout` (ten mówi
   * o układzie taba). Kolumn API gniazda herdr nie podaje, więc pola kolumn nie ma.
   */
  paneRows?: number;
  /**
   * Strażnik wysokości dialogu w chwili HOOKA, ze zrzutu, który opisuje to wywołanie:
   * źródło budżetu (`pane`/`phone`/`floor`) i pty panelu z `LINES`/`COLUMNS` środowiska hooka. Inna chwila
   * i inne źródło niż {@link paneRows}, stąd osobne nazwy: między hookiem a oceną ekranu rozmiar mógł się zmienić.
   */
  budgetSource?: HookBudgetSource;
  hookPaneRows?: number;
  hookPaneCols?: number;
  /**
   * Werdykt rozdzielacza warstw (`dialogs/router.ts`) z klasy rejestru CLI (`cliDialog`), zrzutu hooka
   * `PermissionRequest` i tego samego odczytu ekranu: która warstwa POWINNA wziąć ten dialog (`layer1`,
   * `terminal-only`, `question-form`, `layer2`, `none`) i krótki powód z zamkniętej listy. Werdykt nie jest
   * decyzją tego wpisu — o karcie i klawiszach decyduje `decideCard`; pole pozwala policzyć, gdzie obie
   * drogi się rozchodzą (np. `approve` cyfrą przy `route: layer1`).
   */
  route?: DialogRoute;
  routeReason?: DialogRouteReason;
  /**
   * Krok trybu cienia przed klawiszem zgody albo odmowy z telefonu (`RAROG_CONSENT_CHANNEL=shadow`,
   * `dialogs/shadow/channel.ts`): `written` = plik cienia pod kluczem {@link shadowKey}, reszta = powód braku
   * pliku. Brak pola = tryb `off` albo karta spoza kanału zgody. Klawisz idzie przy każdym wyniku.
   */
  shadow?: ShadowResult;
  /** Klucz zrzutu per wywołanie, pod którym leży plik cienia (`<prompt_id>-<nonce>`). */
  shadowKey?: string;
  /**
   * Szczegół wyniku kroku cienia (`ShadowOutcome.detail`) z zamkniętej listy {@link SHADOW_DETAILS}: przy
   * `no-proof` powód braku dowodu (`no-proof:hook-martwy`), przy `error` przyczyna (`timeout`, `blad`, `zapis`).
   * Brak pola = wynik bez szczegółu (`written`, `ambiguous`, `no-dump` bez zrzutów).
   */
  shadowDetail?: string;
  /**
   * Dla `block-card`: odcisk bloku dialogu z karty (`ActiveReq.bodyPrint`, 16 znaków szesnastkowych), ten sam, który
   * driver sprawdza przed cyfrą. Brak pola = karta bez odcisku (blok bez opcji z cyframi albo bez góry bloku).
   */
  print?: string;
  /** Dla `block-card`: werdykt polityki przycisków karty z zamkniętej listy `BLOCK_CARD_VERDICTS`. */
  verdict?: BlockCardVerdict;
  /**
   * Dla `block-card`: karta warstwy 2 (`RAROG_DIALOG_LAYER2=1`, `ActiveReq.layer2`). W pliku stoi wyłącznie `true`;
   * brak pola = karta bez warstwy 2, czyli każda karta przy fladze `0`. Also on `approve`, `refuse` and
   * `layer2-verify` of a tap on a layer 2 card.
   */
  layer2?: boolean;
  /**
   * Dla `block-card` karty warstwy 2: powód z zamkniętej listy `LAYER2_WHYS` (`block-no-digits`). For `refuse` of
   * a tap on a layer 2 card: the reason of the step from the same list (`screen-changed`, `hook`, `session-moved`…).
   */
  layer2Why?: Layer2Why;
  /**
   * For `layer2-episode`: the episode of a `waiting` of class `dialog`, unique in the session also across server
   * restarts (a per-driver nonce plus the registry episode number). Lines with the same session and episode are
   * refreshes of one episode; the latest one holds its verdict.
   */
  episode?: string;
  /** For `layer2-episode`: verdict of the episode from the closed list `LAYER2_EPISODE_VERDICTS`. */
  layer2Verdict?: Layer2EpisodeVerdict;
  /** For `layer2-episode`: first 12 hex characters of the SHA-256 of the block title, without the title. */
  blockTitleSha?: string;
  /**
   * For `approve` and `layer2-verify` of a layer 2 card: what kind of key the card sent, from the closed list
   * {@link LAYER2_KEY_KINDS} (a digit, a key of the key row, Esc).
   */
  layer2Key?: Layer2KeyKind;
  /** For `layer2-verify`: what the verify read after the key saw, from the closed list {@link LAYER2_VERIFY_OUTCOMES}. */
  layer2Outcome?: Layer2VerifyOutcome;
}

/** Kind of key a layer 2 card sent (`layer2Key`): a digit, a key of the key row (`send/key-row.ts`) or Esc. */
export const LAYER2_KEY_KINDS = ['digit', 'key', 'escape'] as const;
export type Layer2KeyKind = (typeof LAYER2_KEY_KINDS)[number];

/**
 * What the verify read after a layer 2 key saw (`layer2Outcome`, `docs/dialog-card.md`, "Answer"): the block is gone
 * or the registry no longer says `waiting` (`gone`), a block of the same class with another print (`changed`), the
 * same block with only the `❯` marker moved (`highlight`), the same block unchanged (`same`), a dialog of another
 * class (`other-dialog`), or a failed read (`unknown`).
 */
export const LAYER2_VERIFY_OUTCOMES = ['gone', 'changed', 'highlight', 'same', 'other-dialog', 'unknown'] as const;
export type Layer2VerifyOutcome = (typeof LAYER2_VERIFY_OUTCOMES)[number];

/**
 * Wartości `shadowDetail`: wszystko, co kanał cienia i driver wkładają do `ShadowOutcome.detail` — sam wynik bez
 * dowodu (`no-dump`, `no-match`, `no-proof`), `no-proof:<powód>` z {@link NO_PROOF_REASONS} i przyczyny `error`.
 * Wartość spoza listy do dziennika nie trafia.
 */
export const SHADOW_DETAILS: readonly string[] = [
  'no-dump', 'no-match', 'no-proof', ...NO_PROOF_REASONS.map((reason) => `no-proof:${reason}`),
  'timeout', 'blad', 'zapis',
];

/** Pola trybu cienia do wpisu dziennika: wynik kroku, klucz pliku cienia i szczegół wyniku, bez treści. */
export function shadowAuditFields(shadow: ShadowOutcome | null): AuditCaseShape {
  if (shadow === null) return {};
  return {
    shadow: shadow.result,
    ...(shadow.key === undefined ? {} : { shadowKey: shadow.key }),
    ...(shadow.detail === undefined ? {} : { shadowDetail: shadow.detail }),
  };
}

/**
 * Kształt identyfikatora w dzienniku. Część identyfikatorów przychodzi z pliku pisanego przez proces
 * spoza Raroga (zrzut hooka) — wartość innego kształtu nie trafia do pliku wcale.
 */
const AUDIT_ID_PATTERN = /^[A-Za-z0-9_.:~-]{1,200}$/;

const auditId = (value: string | undefined): string | undefined => (
  value !== undefined && AUDIT_ID_PATTERN.test(value) ? value : undefined);

/** Kształt odcisku bloku (`bodyPrint`): pierwsze 16 znaków szesnastkowych sha256. */
const BLOCK_PRINT_PATTERN = /^[0-9a-f]{16}$/;

/** Shape of the block title key (`blockTitleSha`): the first 12 hex characters of sha256. */
const TITLE_SHA_PATTERN = /^[0-9a-f]{12}$/;

/** Liczba z prostokąta albo licznika: całkowita, nieujemna, w zakresie `uint16` herdr. */
const auditCount = (value: number | undefined): number | undefined => (
  value !== undefined && Number.isInteger(value) && value >= 0 && value <= 65_535 ? value : undefined);

/**
 * Kształt po walidacji, w stałej kolejności pól — jedna droga do dziennika i do zrzutu odmowy.
 * Pole spoza zamkniętej listy albo w złym kształcie znika; nigdy nie jest przepisywane.
 */
export function auditShapeFields(shape: AuditCaseShape): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  const put = (key: string, value: string | number | boolean | null | undefined): void => {
    if (value !== undefined) out[key] = value;
  };
  put('reqId', auditId(shape.reqId));
  put('source', shape.source !== undefined && (AUDIT_CARD_SOURCES as readonly string[]).includes(shape.source)
    ? shape.source : undefined);
  put('toolUseId', auditId(shape.toolUseId));
  put('promptId', auditId(shape.promptId));
  put('agentId', auditId(shape.agentId));
  put('mismatchReason', shape.mismatchReason !== undefined
    && (AUDIT_MISMATCH_REASONS as readonly string[]).includes(shape.mismatchReason)
    ? shape.mismatchReason : undefined);
  put('headerVisible', typeof shape.headerVisible === 'boolean' ? shape.headerVisible : undefined);
  put('optionCount', auditCount(shape.optionCount));
  put('blockVisible', typeof shape.blockVisible === 'boolean' ? shape.blockVisible : undefined);
  put('dialogTitle', shape.dialogTitle === null
    ? null
    : (shape.dialogTitle !== undefined && (TERMINAL_DIALOG_IDS as readonly string[]).includes(shape.dialogTitle)
      ? shape.dialogTitle : undefined));
  put('paneRows', auditCount(shape.paneRows));
  put('budgetSource', shape.budgetSource !== undefined
    && (HOOK_BUDGET_SOURCES as readonly string[]).includes(shape.budgetSource) ? shape.budgetSource : undefined);
  put('hookPaneRows', auditCount(shape.hookPaneRows));
  put('hookPaneCols', auditCount(shape.hookPaneCols));
  put('route', shape.route !== undefined && (DIALOG_ROUTES as readonly string[]).includes(shape.route)
    ? shape.route : undefined);
  put('routeReason', shape.routeReason !== undefined
    && (DIALOG_ROUTE_REASONS as readonly string[]).includes(shape.routeReason) ? shape.routeReason : undefined);
  put('shadow', shape.shadow !== undefined && (SHADOW_RESULTS as readonly string[]).includes(shape.shadow)
    ? shape.shadow : undefined);
  put('shadowKey', auditId(shape.shadowKey));
  put('shadowDetail', shape.shadowDetail !== undefined && SHADOW_DETAILS.includes(shape.shadowDetail)
    ? shape.shadowDetail : undefined);
  put('print', shape.print !== undefined && BLOCK_PRINT_PATTERN.test(shape.print) ? shape.print : undefined);
  put('verdict', shape.verdict !== undefined && (BLOCK_CARD_VERDICTS as readonly string[]).includes(shape.verdict)
    ? shape.verdict : undefined);
  put('layer2', shape.layer2 === true ? true : undefined);
  put('layer2Why', shape.layer2Why !== undefined && (LAYER2_WHYS as readonly string[]).includes(shape.layer2Why)
    ? shape.layer2Why : undefined);
  put('episode', auditId(shape.episode));
  put('layer2Verdict', shape.layer2Verdict !== undefined
    && (LAYER2_EPISODE_VERDICTS as readonly string[]).includes(shape.layer2Verdict) ? shape.layer2Verdict : undefined);
  put('blockTitleSha', shape.blockTitleSha !== undefined && TITLE_SHA_PATTERN.test(shape.blockTitleSha)
    ? shape.blockTitleSha : undefined);
  put('layer2Key', shape.layer2Key !== undefined && (LAYER2_KEY_KINDS as readonly string[]).includes(shape.layer2Key)
    ? shape.layer2Key : undefined);
  put('layer2Outcome', shape.layer2Outcome !== undefined
    && (LAYER2_VERIFY_OUTCOMES as readonly string[]).includes(shape.layer2Outcome) ? shape.layer2Outcome : undefined);
  return out;
}

/**
 * Kształt odpowiedzi na pytanie w chwili odmowy — same liczby i flagi, zero treści.
 *
 * Bez tego odmowy przy formularzach nie da się rozstrzygnąć z dziennika (czy klient
 * wysłał pustą grupę, czy karta miała inną liczbę pytań niż zrzut hooka, czy cyfra celowała
 * w niewłaściwą zakładkę).
 */
export interface AnswerShape {
  /** Którym kanałem miała pojechać odpowiedź. */
  channel: 'hook' | 'keys';
  /** Czy karta miała adres kanału hooka (zrzut dopasowany do ekranu). */
  hookTarget: boolean;
  /** Ile grup odpowiedzi przyszło od klienta. */
  answers: number;
  /** Ile pytań niesie adres kanału hooka (`0`, gdy go nie ma). */
  target: number;
  /** Indeks pytania, które stoi na ekranie (`-1` = nie dopasowano). */
  index: number;
  /** Ile wartości w każdej grupie — w kolejności pytań. */
  groups: readonly number[];
}

export interface HerdrAuditEvent extends AuditCaseShape {
  /**
   * Czas zdarzenia po stronie wołającego. Nieobecny = zegar dziennika.
   *
   * Pole jest opcjonalne (i `sessionId` też), żeby driver przypięty do panelu mógł oddać
   * SWÓJ wpis bez znajomości zegara i identyfikatora sesji Raroga — dziennik ma przyjąć
   * wszystko, co Rarog wysłał, a nie wymuszać kolejność składania zależności.
   */
  at?: string;
  sessionId?: string;
  /** Tożsamość agenta nadana przez supervisora (`HerdrAgent.key`). */
  key: string;
  paneId: string;
  cwd: string;
  /**
   * `approve` to `send_keys` z KONTEKSTEM decyzji — osobna metoda, a nie flaga przy `send_keys`,
   * bo `grep '"method":"approve"'` po kradzieży telefonu ma dawać listę zatwierdzeń, a nie
   * listę wszystkiego, co poszło klawiszami.
   *
   * `launch` i `close_tab` opisują DWIE NOWE WŁADZE Raroga (uruchom proces, zamknij tab).
   * Runbook „Lost or stolen phone" odpowiada na pytanie „co się stało" właśnie tymi
   * trzema grepami: `launch`, `approve`, `close_tab`.
   *
   * `model_change` dokłada czwarty, bo `/model` jako jedyna wysyłka Raroga zmienia stan
   * POZA sesją: zapisuje domyślny model konta w `~/.claude/settings.json`. Wpisów jest
   * para — wysłana komenda (`text`) i cyfra, która zatwierdziła dialog (`keys`, `optionLabel`).
   *
   * `answer-hook` jest piątym takim grepem i jedyną metodą, przy
   * której do panelu nie poszedł ŻADEN klawisz, a mimo to sesja dostała odpowiedź: Rarog
   * zapisał plik `<dataDir>/answers/…`, a śpiący hook `PermissionRequest` oddał ją CLI jako
   * `allow` z `updatedInput.answers`. Bez własnej metody ta droga byłaby w dzienniku
   * NIEWIDOCZNA (żadnego `send_keys`, żadnego `approve`), czyli runbook „kradzież telefonu"
   * przestałby odpowiadać na pytanie „co poszło do sesji". `optionLabel` niesie treść
   * odpowiedzi — tą samą drogą co etykieta cyfry (redakcja + 200 znaków).
   *
   * `refuse` jest jedyną metodą, przy której NIC nie poszło do panelu —
   * i właśnie dlatego istnieje. Dziennik miał ~150 wpisów wysyłki i ZERO danych o porażkach,
   * więc pytanie „czy ścieżka cyfrowa realnie zawodzi" dało się rozstrzygać wyłącznie
   * wrażeniem. Każda odmowa niesie `reason` z zamkniętej listy ({@link HerdrRefuseReason});
   * {@link summarizeRefusals} sumuje je po powodzie z ostatnich {@link REFUSALS_WINDOW_DAYS} dni.
   *
   * `restart` spina JEDEN gest „uruchom ponownie”, który w dzienniku zostawia też
   * zwykłe `prompt` (`/exit`), `launch` (`--resume`) i czasem `close_tab` (stary tab z gołą powłoką).
   * `reason` mówi, który gest: `cli-update` albo `prompt-blocked`; `text` niesie parę wydań
   * `running → installed` tylko przy aktualizacji. Restart z ponowną wysyłką zostawia jeszcze `prompt`
   * z tekstem promptu (prompt startowy nowego procesu).
   *
   * `block-card` („karta bloku wystawiona”) to karta zbudowana z SAMEGO ekranu, z każdym werdyktem: z przyciskami,
   * z częścią przycisków i bez nich. Do panelu nic nie idzie. Wpis niesie tożsamość karty, kształt ekranu
   * (`optionCount`, `headerVisible`, `dialogTitle`), odcisk bloku (`print`) i werdykt polityki (`verdict`), bez treści
   * ekranu i bez etykiet opcji. Karta bez decyzji dostaje obok wpis `degrade` z powodem,
   * a `reqId` spina oba wpisy.
   *
   * `layer2-episode` (layer 2 card, `docs/dialog-card.md`) is one line per episode of a `waiting` of class `dialog` at
   * `RAROG_DIALOG_LAYER2=1`, written again only when its fields change: `episode`, `layer2Verdict`, `layer2Why` for
   * `none`, and `blockTitleSha` and `optionCount` when the screen has a block. No key goes with it and no screen text.
   *
   * `layer2-verify` is the verify read after a key from a layer 2 card: the occurrence id (`reqId`), the kind of key
   * (`layer2Key`) and what the read saw (`layer2Outcome`). No key goes with it and no screen text; the key itself is
   * the `approve` line before it, with `layer2: true` and the same `reqId`.
   */
  method: 'prompt' | 'send_keys' | 'approve' | 'launch' | 'close_tab' | 'model_change'
  | 'answer-hook' | 'refuse' | 'degrade' | 'restart' | 'block-card' | 'layer2-episode' | 'layer2-verify';
  /**
   * Dla `refuse` i `degrade`: dlaczego decyzja NIE wyszła albo karta nie ma przycisków.
   * Zamknięta lista — wpisy mają się sumować. Dla `restart`: który gest uruchomił sesję ponownie.
   *
   * `degrade` to karta BEZ decyzji postawiona przy OCENIE ekranu, zanim
   * ktokolwiek tapnął — osobno od `refuse`, żeby statystyka nie mieszała odmów wysyłki
   * z dialogami, których Rarog nie umie przeczytać.
   */
  reason?: HerdrRefuseReason | AuditOnlyRefuseReason | RestartReason;
  /**
   * Dla `refuse` z powodem `command-not-allowed`: pierwszy token odrzuconego tekstu (`/usa`,
   * `quit`) — kształt nazwy komendy, po redakcji i przycięty do {@link HERDR_AUDIT_COMMAND_HEAD} znaków.
   * Reszta wiadomości do dziennika nie trafia.
   */
  command?: string;
  /** Dla `refuse` z odpowiedzi na pytanie: KSZTAŁT odpowiedzi, bez treści. */
  shape?: AnswerShape;
  /**
   * Dla `approve`, `degrade` i `refuse` z kartą: klasa dialogu z rejestru sesji CLI (`waitingFor`) —
   * tylko gdy rejestr mówił `waiting` w chwili wpisu. Wartość z zamkniętej listy Raroga, nie tekst CLI. Brak
   * pola we wpisie z `route` znaczy „rejestr nie mówił `waiting`”.
   */
  cliDialog?: CliDialogClass;
  /**
   * Dla `answer-hook`: ile NOTATEK pojechało w `annotations` pliku odpowiedzi. Sama
   * liczba — treść notatki to tekst człowieka i do dziennika nie trafia.
   */
  notes?: number;
  mode: HerdrMode;
  /** Dla `send_keys` i `approve`: dokładnie te klawisze, które poszły. */
  keys?: readonly string[];
  /**
   * Dla `prompt`: tekst PO walidacji — do pliku idzie hash CAŁOŚCI i pierwsze
   * 200 znaków PO REDAKCJI (`redactAuditText`). Samo przycięcie tu nie wystarcza — token
   * w zmiennej środowiskowej stoi na POCZĄTKU linii, więc mieści się w zapisanych 200 znakach
   * w całości i wycina go dopiero redakcja.
   */
  text?: string;
  /** Dla `approve`: nazwa narzędzia po cross-checku jsonl ↔ ekran (`resolveOptions`). */
  toolName?: string;
  /** Dla `approve`: etykieta WYBRANEJ opcji — to ona odpowiada na pytanie „co zatwierdzono". */
  optionLabel?: string;
  /** Dla `launch` i `close_tab`: adres taba, którego dotyczy wpis. */
  tabId?: string;
  /**
   * Dla `launch`: dokładna linia argumentów `claude`.
   *
   * PROMPTU tam nie ma i być nie może
   * (`docs/security-model.md`, „Starting sessions from the phone: three powers”)
   * — zdanie człowieka jedzie `agent.prompt`, więc ten wpis jest bezpieczny do przechowania w całości.
   */
  argv?: readonly string[];
  /** Dla `approve`: cyfra, która poszła do panelu. Sama nie znaczy nic — stąd reszta pól. */
  digit?: string;
  /**
   * For `prompt`: who sent the message, `voice-agent` for a prompt the voice agent across sessions sent
   * (`MessageBody.source`). Absent = a message as any other, and the line is the same as without the field. Not
   * `source`: that key of the line names a card's source.
   */
  sender?: MessageSource;
}

export interface HerdrAuditLog {
  /** Zapisuje wpis w tle. Nigdy nie rzuca i nigdy nie każe na siebie czekać. */
  log(event: HerdrAuditEvent): void;
  /** Domknięcie kolejki zapisów — dla testów i dla `dispose()` procesu. */
  flush(): Promise<void>;
}

export interface HerdrAuditOptions {
  dataDir: string;
  now?: () => Date;
  maxBytes?: number;
  /**
   * Sekrety procesu (token aplikacji, klucz Soniox) wycierane z `textHead` i `optionLabel`.
   *
   * OPCJONALNE świadomie: dziennik ma działać także wtedy, gdy fabryka dostanie samą ścieżkę
   * (testy, driver składany osobno). Bez listy zostaje maskowanie kształtu `NAZWA=wartość`,
   * czyli warstwa, która łapie runbookowe `KLUCZ=… komenda`; z listą dochodzi wycieranie
   * dosłownych wystąpień, które łapie sekret wklejony w dowolnym miejscu linii.
   */
  secrets?: readonly string[];
}

/** Ścieżka dziennika dla katalogu danych Raroga. */
export function herdrAuditPath(dataDir: string): string {
  return path.join(dataDir, HERDR_AUDIT_FILENAME);
}

/** Jedna linia NDJSON. Kolejność pól stała, żeby `grep` po dzienniku był przewidywalny. */
function toLine(event: HerdrAuditEvent, at: string, secrets: readonly string[]): string {
  const entry: Record<string, unknown> = {
    ts: event.at ?? at,
    sessionId: event.sessionId ?? null,
    key: event.key,
    paneId: event.paneId,
    cwd: event.cwd,
    method: event.method,
    mode: event.mode,
  };
  if (event.sender === 'voice-agent') entry['sender'] = event.sender;
  if (event.keys !== undefined) entry['keys'] = [...event.keys];
  /*
   * Kontekst decyzji (`docs/security-model.md`, „Starting sessions from the phone: three powers”).
   * Wpis `keys: ['1']` nie odpowiada na pytanie „co zatwierdzono" —
   * numeracja opcji bywa przetasowana, a bez nazwy narzędzia i etykiety cyfra jest w śledztwie
   * bezużyteczna. Etykieta idzie tą samą drogą co tekst promptu — redakcja plus ten sam limit:
   * potrafi nieść ścieżkę projektu („…don't ask again for pnpm commands in /Users/u/…").
   */
  if (event.reason !== undefined) entry['reason'] = event.reason;
  // Kształt przypadku: tożsamość karty, źródło, podpowód, liczby — bez treści.
  Object.assign(entry, auditShapeFields(event));
  if (event.command !== undefined) {
    entry['command'] = redactAuditText(event.command, secrets).slice(0, HERDR_AUDIT_COMMAND_HEAD);
  }
  if (event.shape !== undefined) entry['shape'] = { ...event.shape, groups: [...event.shape.groups] };
  if (event.cliDialog !== undefined) entry['cliDialog'] = event.cliDialog;
  if (event.notes !== undefined) entry['notes'] = event.notes;
  /*
   * Nazwa narzędzia bywa WEJŚCIEM NIEZAUFANYM: przy karcie z hooka pochodzi z pliku pisanego
   * przez proces spoza Raroga. Czytnik zrzutu odsiewa kształt niebędący
   * identyfikatorem, ale dziennik jest ostatnią bramką przed plikiem, który runbook
   * „kradzież telefonu" każe czytać — więc nazwa jedzie tą samą drogą co etykieta:
   * redakcja i ten sam sufit znaków.
   */
  if (event.toolName !== undefined) {
    entry['toolName'] = redactAuditText(event.toolName, secrets).slice(0, HERDR_AUDIT_TEXT_HEAD);
  }
  if (event.optionLabel !== undefined) {
    // Etykieta jest tekstem Z CUDZEGO EKRANU, więc jedzie tą samą drogą co prompt: potrafi
    // nieść fragment komendy, którą narzędzie prosi zatwierdzić („Bash(FOO=… deploy)").
    entry['optionLabel'] = redactAuditText(event.optionLabel, secrets)
      .slice(0, HERDR_AUDIT_TEXT_HEAD);
  }
  if (event.digit !== undefined) entry['digit'] = event.digit;
  if (event.tabId !== undefined) entry['tabId'] = event.tabId;
  if (event.argv !== undefined) entry['argv'] = [...event.argv];
  if (event.text !== undefined) {
    // Hash liczymy z ORYGINAŁU, nie z tekstu po redakcji: to on odpowiada na pytanie „czy to
    // ta sama komenda, co wczoraj" i musi być stabilny niezależnie od tego, jakie sekrety
    // proces akurat zna. Sam hash nie odwraca się do treści.
    entry['textSha256'] = createHash('sha256').update(event.text, 'utf8').digest('hex');
    entry['textHead'] = redactAuditText(event.text, secrets).slice(0, HERDR_AUDIT_TEXT_HEAD);
  }
  return `${JSON.stringify(entry)}\n`;
}

/**
 * Dziennik z SZEREGOWANYM zapisem.
 *
 * Zapisy idą przez jeden łańcuch obietnic, bo równoległe `appendFile` do tego samego pliku
 * potrafią przeplatać się w środku linii przy większych wpisach, a rotacja w tym samym czasie
 * co zapis gubiłaby dane. Kolejka jest w pamięci procesu — to jedyny pisarz tego pliku.
 */
export function createHerdrAuditLog(opts: HerdrAuditOptions): HerdrAuditLog {
  const file = herdrAuditPath(opts.dataDir);
  const now = opts.now ?? ((): Date => new Date());
  const maxBytes = opts.maxBytes ?? HERDR_AUDIT_MAX_BYTES;
  const secrets = opts.secrets ?? [];
  let chain: Promise<void> = Promise.resolve();

  const rotateIfNeeded = async (): Promise<void> => {
    try {
      const info = await stat(file);
      if (info.size < maxBytes) return;
      await rename(file, `${file}.1`);
    } catch {
      // Brak pliku (pierwszy zapis) albo wyścig z inną rotacją — nic nie robimy.
    }
  };

  const write = async (line: string): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true });
    await rotateIfNeeded();
    await appendFile(file, line, { encoding: 'utf8', mode: FILE_MODE });
    // `mode` w `appendFile` działa TYLKO przy tworzeniu pliku; po rotacji plik powstaje na nowo,
    // ale gdyby ktoś kiedyś poluzował prawa istniejącemu, chcemy je z powrotem zacisnąć.
    await chmod(file, FILE_MODE);
  };

  return {
    log(event: HerdrAuditEvent): void {
      const line = toLine(event, now().toISOString(), secrets);
      chain = chain.then(() => write(line)).catch(() => {
        // Świadomie połknięte: log jest do śledztwa, nie do autoryzacji.
      });
    },
    flush(): Promise<void> {
      return chain;
    },
  };
}

// ---------------------------------------------------------------------------
// Odczyt: licznik odmów
// ---------------------------------------------------------------------------

/** Ile dni wstecz sięga domyślnie suma odmów z dziennika ({@link summarizeRefusals}). */
export const REFUSALS_WINDOW_DAYS = 7;

export interface RefusalSummary {
  /** Ile wpisów `refuse` mieści się w oknie (bez odmów komend, te liczy {@link summarizeCommandRefusals}). */
  total: number;
  /** Powód → liczba wpisów. Klucze wyłącznie z {@link HERDR_REFUSE_REASONS}. */
  byReason: Record<string, number>;
  /** Wpisy `refuse` z powodem SPOZA listy — sygnał, że kod i ta stała się rozjechały. */
  unknown: number;
  /** Linie, których nie dało się sparsować (obcięty ogon po rotacji) — nie są odmowami. */
  skipped: number;
  /** Ile z {@link total} pochodzi z sesji w katalogu `.claude/worktrees/` (pomiary i równoległe sesje). */
  worktree: number;
}

/**
 * Fragment ścieżki sesji agenta w worktree Claude Code (`EnterWorktree`, `isolation: worktree`) —
 * sesje pomiarowe i równoległe sesje nad repo Raroga. Ich odmowy liczymy osobno, bo inaczej seria
 * pomiaru udaje zdarzenie konta.
 */
export const WORKTREE_CWD_MARKER = '/.claude/worktrees/';

/** Czy wpis dziennika pochodzi z sesji w worktree Claude Code (po `cwd` panelu). */
function inWorktree(record: Record<string, unknown>): boolean {
  const cwd = record['cwd'];
  return typeof cwd === 'string' && cwd.includes(WORKTREE_CWD_MARKER);
}

/**
 * Sumuje wpisy `refuse` z linii dziennika — czysta funkcja, żeby CLI nie było jedynym testem.
 *
 * Liczymy WYŁĄCZNIE po `method` i `reason`; reszta wpisu (etykiety, teksty) nie jest tu do
 * niczego potrzebna i świadomie nie wychodzi z tej funkcji — podsumowanie ma być bezpieczne
 * do wklejenia w zgłoszenie, inaczej nikt go nie użyje.
 *
 * @param lines linie NDJSON dziennika (dowolna kolejność; puste są pomijane)
 * @param sinceMs dolna granica okna (epoch ms); wpis bez czytelnego `ts` jest POMIJANY
 */
export function summarizeRefusals(
  lines: Iterable<string>, sinceMs: number, method: 'refuse' | 'degrade' = 'refuse',
): RefusalSummary {
  const byReason: Record<string, number> = {};
  let total = 0;
  let unknown = 0;
  let skipped = 0;
  let worktree = 0;
  const known = new Set<string>(HERDR_REFUSE_REASONS);
  for (const line of lines) {
    if (line.trim() === '') continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (typeof entry !== 'object' || entry === null) {
      skipped += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (record['method'] !== method) continue;
    // Odmowa komendy nie jest odmową decyzji: ma własną sekcję i własną funkcję.
    if (record['reason'] === 'command-not-allowed') continue;
    const ts = typeof record['ts'] === 'string' ? Date.parse(record['ts']) : Number.NaN;
    if (Number.isNaN(ts) || ts < sinceMs) continue;
    total += 1;
    if (inWorktree(record)) worktree += 1;
    const reason = record['reason'];
    if (typeof reason !== 'string' || !known.has(reason)) {
      unknown += 1;
      continue;
    }
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  }
  return { total, byReason, unknown, skipped, worktree };
}

/** Rozkład KSZTAŁTU kart bez decyzji (`degrade`) w jednej grupie sesji — same liczby, bez treści. */
export interface DegradeShapeSummary {
  /** Wpisy `degrade` w oknie (w tej grupie sesji). */
  total: number;
  /** Ile z nich niesie pola kształtu (`optionCount`) — starsze wpisy ich nie mają. */
  shaped: number;
  /** Podpowód rozjazdu → liczba; klucze wyłącznie z {@link AUDIT_MISMATCH_REASONS}. */
  byMismatchReason: Record<string, number>;
  /** Nagłówek dialogu nad ramką operacji: widoczny, niewidoczny, brak ramki (wśród {@link shaped}). */
  headerVisible: { visible: number; hidden: number; noFrame: number };
  /** Źródło karty → liczba; klucze wyłącznie z {@link AUDIT_CARD_SOURCES}. */
  bySource: Record<string, number>;
  /** Klasa dialogu z rejestru CLI → liczba (wśród wszystkich `degrade`); `brak` = rejestr nie mówił `waiting`. */
  byCliDialog: Record<string, number>;
  /** Karty bez ani jednej opcji z cyframi (`optionCount: 0`) przy klasie CLI `dialog` („dialog open”). */
  noOptionsDialog: number;
  /** Ile wpisów ma liczbę wierszy panelu z herdr (`paneRows`). */
  withRows: number;
  /** Najmniejsza liczba wierszy panelu wśród {@link withRows}; `null` = żadnego wpisu z wierszami. */
  minRows: number | null;
}

function emptyDegradeShapes(): DegradeShapeSummary {
  return {
    total: 0, shaped: 0, byMismatchReason: {}, headerVisible: { visible: 0, hidden: 0, noFrame: 0 },
    bySource: {}, byCliDialog: {}, noOptionsDialog: 0, withRows: 0, minRows: null,
  };
}

/**
 * Rozkład kształtu kart bez decyzji — osobno dla sesji projektów
 * i dla sesji z `.claude/worktrees/`. Wartość spoza zamkniętej listy liczy się jako `inne`, więc
 * z pliku do podsumowania nie przechodzi żaden obcy napis.
 */
export function summarizeDegradeShapes(
  lines: Iterable<string>, sinceMs: number,
): { projects: DegradeShapeSummary; worktrees: DegradeShapeSummary } {
  const projects = emptyDegradeShapes();
  const worktrees = emptyDegradeShapes();
  const mismatchReasons = new Set<string>(AUDIT_MISMATCH_REASONS);
  const sources = new Set<string>(AUDIT_CARD_SOURCES);
  const classes = new Set<string>(CLI_DIALOG_CLASSES);
  const bump = (map: Record<string, number>, key: string): void => { map[key] = (map[key] ?? 0) + 1; };
  for (const line of lines) {
    if (line.trim() === '') continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record['method'] !== 'degrade') continue;
    const ts = typeof record['ts'] === 'string' ? Date.parse(record['ts']) : Number.NaN;
    if (Number.isNaN(ts) || ts < sinceMs) continue;
    const into = inWorktree(record) ? worktrees : projects;
    into.total += 1;
    const cliDialog = record['cliDialog'];
    bump(into.byCliDialog, typeof cliDialog !== 'string' ? 'brak' : (classes.has(cliDialog) ? cliDialog : 'inne'));
    const mismatch = record['mismatchReason'];
    if (typeof mismatch === 'string') bump(into.byMismatchReason, mismatchReasons.has(mismatch) ? mismatch : 'inne');
    const source = record['source'];
    if (typeof source === 'string') bump(into.bySource, sources.has(source) ? source : 'inne');
    const rows = record['paneRows'];
    if (typeof rows === 'number') {
      into.withRows += 1;
      into.minRows = into.minRows === null ? rows : Math.min(into.minRows, rows);
    }
    const optionCount = record['optionCount'];
    if (typeof optionCount !== 'number') continue;
    into.shaped += 1;
    const header = record['headerVisible'];
    if (header === true) into.headerVisible.visible += 1;
    else if (header === false) into.headerVisible.hidden += 1;
    else into.headerVisible.noFrame += 1;
    if (optionCount === 0 && cliDialog === 'dialog') into.noOptionsDialog += 1;
  }
  return { projects, worktrees };
}

export interface CommandRefusalSummary {
  /** Ile odmów `command-not-allowed` mieści się w oknie. */
  total: number;
  /** Nazwa (pierwszy token, małymi literami) → liczba odmów. */
  byCommand: Record<string, number>;
  /** Linie, których nie dało się sparsować. */
  skipped: number;
}

/**
 * Sumuje odmowy slash-komend (`refuse` z powodem `command-not-allowed`) per nazwa. Nazwa jest
 * jedynym polem, które z wpisu wychodzi — to ona odpowiada na pytanie „której komendy brakuje
 * w katalogu, a która była pomyłką”.
 */
export function summarizeCommandRefusals(lines: Iterable<string>, sinceMs: number): CommandRefusalSummary {
  const byCommand: Record<string, number> = {};
  let total = 0;
  let skipped = 0;
  for (const line of lines) {
    if (line.trim() === '') continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (typeof entry !== 'object' || entry === null) {
      skipped += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (record['method'] !== 'refuse' || record['reason'] !== 'command-not-allowed') continue;
    const ts = typeof record['ts'] === 'string' ? Date.parse(record['ts']) : Number.NaN;
    if (Number.isNaN(ts) || ts < sinceMs) continue;
    total += 1;
    const command = typeof record['command'] === 'string' ? record['command'].toLowerCase() : '(bez nazwy)';
    byCommand[command] = (byCommand[command] ?? 0) + 1;
  }
  return { total, byCommand, skipped };
}
