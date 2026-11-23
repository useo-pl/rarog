/**
 * Wysyłka do panelu: komendy sterujące, stall-guard i przerwanie — moduł drivera herdr.
 *
 * Wszystko tu jest CZYSTE: stałe, zdania do transkryptu i funkcje, które z tekstu ekranu albo
 * z treści komendy wyprowadzają jeden fakt. Sekwencje (kolejka `#chain`, ponowienia, zegary)
 * zostają w fasadzie `drivers/herdr-driver.ts` — ona jedyna wie, kiedy wolno napisać do cudzego
 * panelu. Podział przebiega dokładnie tam: **moduł liczy, fasada wysyła**.
 *
 * One exception keeps its order here: the confirmation of "Switch model?" from its block ({@link confirmModelSwitch}).
 * Its checks before the digit form one sequence, so it runs them through a port; the facade still owns the client.
 */
import { EFFORT_LEVELS, MODEL_ID_PATTERN } from '@rarog/shared';
import { say } from '@rarog/shared/sentences';
import type { OwnText, ServerSentence } from '@rarog/shared/sentences';
import type { EffortLevel } from '@rarog/shared';
import type { DriverEvent, HeldLeftover } from '../types.ts';
import type { Layer2StepPort } from './layer2-step.ts';
import { ULTRACODE_COMMANDS } from '../../herdr/commands/registry.ts';
import { SCREEN_DIALOG_TOOL } from '../../herdr/dialogs/cards/build.ts';
import { shapeOf } from '../../herdr/dialogs/layer2/match.ts';
import { readBlock } from '../../herdr/dialogs/layer2/read-block.ts';
import { layer2Verdict } from '../../herdr/dialogs/layer2/verdict.ts';
import { SCREEN_SIGNATURES } from '../../herdr/dialogs/screen/signatures.ts';
import { stripTerminalControl } from '../../herdr/dialogs/screen/text.ts';
import type { ScreenDialog } from '../../herdr/dialogs/index.ts';
import { ultracodeResultOf } from '../../herdr/ultracode.ts';

/**
 * Przerwa po czyszczącej parze `esc esc` przed kolejnym odczytem ekranu albo promptem.
 *
 * Po przerwaniu tury CC oddaje tekst do pola wejściowego panelu; bez wyczyszczenia następna
 * wysyłka DOKLEIŁABY się do poprzedniej. 120 ms wystarcza TUI na przerysowanie.
 */
export const ESC_SETTLE_MS = 120;

export const BLOCKED_SEND_MESSAGE: OwnText = say('commands.send-blocked');
export const READ_ONLY_MESSAGE: OwnText = say('commands.send-read-only');
/*
 * Przerwanie ma WŁASNE zdania o błędzie: Esc nie niesie wiadomości, więc „Wiadomość NIE
 * została wysłana" nad nieudanym Esc mówiłoby o czymś, czego nikt nie pisał — a człowiek szukałby
 * w transkrypcie zgubionego promptu.
 */
export const BLOCKED_INTERRUPT_MESSAGE: OwnText = say('commands.interrupt-blocked');
/*
 * `⚠` jak u sąsiadów: to jest ODMOWA, a wpis bez ostrzeżenia czytało się jak notkę o stanie
 * herdr, nie jak „Twoja tura dalej pracuje". Jedyne zdanie o przerwaniu BEZ `⚠` to sukces.
 */
export const READ_ONLY_INTERRUPT_MESSAGE: OwnText = say('commands.interrupt-read-only');
/**
 * Panel zniknął z herdr w chwili Esc — odmowa, która sama z siebie by milczała.
 *
 * `detached` przestawia kartę, ale nie mówi ANI SŁOWA o geście, a telefon nie dopisuje nic
 * od siebie. Zdanie idzie PRZED `detached`, żeby weszło do
 * transkryptu, zanim manager oznaczy sesję jako nieaktualną.
 */
export const GONE_INTERRUPT_MESSAGE: OwnText = say('commands.interrupt-panel-gone');
/**
 * Udane przerwanie — TRWAŁY ślad w transkrypcie, pisany przez SERWER.
 *
 * Podział nośników: **linia pod polem mówi to, co wie TELEFON, a transkrypt to, co SIĘ STAŁO**.
 * Wynik dostarczenia zna wyłącznie serwer, więc to on go zapisuje — notka lokalna nie dotarłaby
 * na drugie urządzenie i znikałaby po wyjściu z sesji i powrocie, bo transkrypt odtwarza się wtedy
 * ze snapshotu.
 *
 * Zdanie jest BEZ `⚠` i mówi „przerwana", nie „nie udało się": tu trafia także `herdr-stalled`
 * (klawisz POSZEDŁ, herdr tylko nie doczekał się echa z ekranu), a ostrzeżenie nad udanym
 * przerwaniem zachęcałoby do drugiego Esc — ten na pustym polu otwiera w CC rewind.
 *
 * WARUNEK: driver widział turę (`working`/`blocked`) w chwili wysyłania klawisza. Esc do panelu,
 * który już stoi, jest legalny (karencja `waiting-input`, wysyłka w locie), ale nie ma o czym
 * meldować — a zdanie „Tura przerwana" nad panelem bez tury byłoby nieprawdą.
 */
export const INTERRUPT_DONE_MESSAGE: OwnText = say('commands.interrupt-done');

/*
 * Dialog potwierdzenia po komendzie sterującej (`/model`, `/effort`).
 *
 * Te dialogi są niewidoczne dla herdr: `agent_status` zostaje `idle`, więc zwykła ścieżka
 * decyzji (wejście w `blocked` → odczyt ekranu) nigdy się nie uruchamia. Dlatego po wysłaniu
 * komendy pytamy o ekran SAMI, kilka razy.
 *
 * Okno ma ~5 s: dialog „Change effort level?" po `/effort high` potrafi pojawić się po ponad 2 s
 * (TUI domalowuje ogon poprzedniej tury), a krótsze okno ogłosiłoby „panel nie poprosił o potwierdzenie”
 * i zmieniło pigułkę, zostawiając dialog w terminalu. Cisza przez CAŁE okno znaczy „dialogu nie ma";
 * znaleziony dialog kończy pętlę od razu, więc długie okno kosztuje tylko ścieżkę bez dialogu.
 */
export const MODEL_CONFIRM_POLL_MS = 400;
export const MODEL_CONFIRM_ATTEMPTS = 12;

/**
 * Wynik `#confirmCommandDialog` — symbol zamiast gotowego zdania, bo zdanie musi nazywać
 * KOMENDĘ: zmiana modelu z Raroga to zawsze paczka `/model` + `/effort`, a dwa identyczne
 * „Komenda poszła do panelu" wyglądałyby jak zdublowana wysyłka.
 *
 * `refused` daje wyłącznie komenda ultracode: CLI odmówiło w miejscu wyniku, bo ultracode jest
 * niedostępne ({@link commandRefusedInline}).
 */
export type ModelCommandOutcome = 'confirmed' | 'inline' | 'no-dialog' | 'foreign' | 'refused';

/** Komenda poszła, dialog potwierdzenia zatwierdzony cyfrą z Raroga. */
export const modelConfirmedMessage = (command: string): ServerSentence => say('model.change-confirmed', { command });
/** Komenda poszła, CLI wypisało wynik w miejscu — dialogu nie było i nie będzie (2.1.258). */
export const modelInlineMessage = (command: string): ServerSentence => say('model.change-inline', { command });
/** The command went; no dialog and no recognized in-place result appeared in the read window. */
export const modelNoDialogMessage = (command: string): ServerSentence => say('model.change-no-dialog', { command });
/** Na ekranie stoi dialog, ale NIE ten (albo bez czytelnej opcji „tak") — fail-closed. */
export const modelForeignDialogMessage = (command: string): ServerSentence =>
  say('model.change-foreign-dialog', { command });

/**
 * Komenda ultracode → stan, który ustawia; każda inna komenda → `null`.
 *
 * Formy porównujemy w całości z rejestrem (`ULTRACODE_COMMANDS`): manager składa je stamtąd, a guard
 * przepuszcza je ścieżką wewnętrzną tylko w tej postaci.
 */
export function ultracodeCommandValue(command: string): boolean | null {
  const text = command.trim();
  if (text === ULTRACODE_COMMANDS.on) return true;
  if (text === ULTRACODE_COMMANDS.off) return false;
  return null;
}

/** Ultracode włączone: wynik w miejscu pod echem tej komendy (`inline`). */
export const ULTRACODE_ON_DONE_MESSAGE: ServerSentence = say('model.ultracode-on');
/** Ultracode wyłączone: wynik w miejscu pod echem tej komendy (`inline`). */
export const ULTRACODE_OFF_DONE_MESSAGE: ServerSentence = say('model.ultracode-off');
/** Komenda ultracode poszła, ale CLI odmówiło: workflow dynamiczne wyłączone (pomiar 2.1.317). */
export const ULTRACODE_REFUSED_MESSAGE: ServerSentence = say('model.ultracode-refused');
/**
 * Komenda ultracode poszła, wiersza wyniku pod jej echem nie było w oknie odczytu (komenda w trakcie tury nie pisze
 * wyniku na ekranie ani w pliku rozmowy, pomiar 2.1.317). Stan pokaże załącznik pierwszej tury po komendzie.
 */
export const ultracodeUnseenMessage = (command: string): ServerSentence => say('model.ultracode-unseen', { command });

/**
 * Zdanie do transkryptu dla wyniku komendy ultracode. Bez zdania o „zapisie w ustawieniach konta”: wynik CLI
 * mówi „this session only”. `confirmed` się nie zdarza (ultracode nie stawia dialogu, `commandDialogMatches`
 * odmawia), więc dzieli zdanie z `inline`.
 */
export function ultracodeOutcomeMessage(
  command: string, value: boolean, outcome: ModelCommandOutcome,
): ServerSentence {
  if (outcome === 'inline' || outcome === 'confirmed') {
    return value ? ULTRACODE_ON_DONE_MESSAGE : ULTRACODE_OFF_DONE_MESSAGE;
  }
  if (outcome === 'refused') return ULTRACODE_REFUSED_MESSAGE;
  if (outcome === 'foreign') return modelForeignDialogMessage(command);
  return ultracodeUnseenMessage(command);
}

/**
 * The `server.log` line after one control command: the command (built by Rarog from its allow-list, never
 * conversation text), the outcome and the time since the send.
 */
export function commandOutcomeLogLine(
  paneKey: string, command: string, outcome: ModelCommandOutcome, elapsedMs: number,
): string {
  const ms = String(Math.max(0, Math.round(elapsedMs)));
  return `herdr: control command ${command} on pane ${paneKey}: ${outcome} after ${ms} ms`;
}

/** Zdanie do transkryptu dla wyniku jednej komendy sterującej. */
export function modelOutcomeMessage(command: string, outcome: ModelCommandOutcome): OwnText {
  const ultracode = ultracodeCommandValue(command);
  if (ultracode !== null) return ultracodeOutcomeMessage(command, ultracode, outcome);
  if (outcome === 'confirmed') return modelConfirmedMessage(command);
  if (outcome === 'inline') return modelInlineMessage(command);
  if (outcome === 'foreign') return modelForeignDialogMessage(command);
  return modelNoDialogMessage(command);
}

/**
 * Wysłana komenda sterująca → zdarzenie `model-set` (optymistyczna pigułka) albo `null`.
 *
 * Wartość pochodzi z TEKSTU komendy — dokładnie tego, co poszło do panelu (manager zbudował
 * go z własnej allow-listy). Aliasy (`opus`) zostają na pigułce tylko do pierwszej tury:
 * `init` z meta jsonl nadpisze je rozwiązanym identyfikatorem. Wartość spoza wzorca = brak
 * zdarzenia, nigdy wyjątek. Komenda ultracode daje `ultracode` z formy, a driver emituje ją wyłącznie
 * po rozpoznanym wyniku w miejscu.
 */
export function modelSetEvent(command: string): DriverEvent | null {
  const ultracode = ultracodeCommandValue(command);
  if (ultracode !== null) return { type: 'model-set', ultracode };
  const match = /^\/(model|effort) (\S+)$/.exec(command);
  if (match === null) return null;
  const value = match[2] ?? '';
  if (match[1] === 'model' && MODEL_ID_PATTERN.test(value)) {
    return { type: 'model-set', model: value };
  }
  if (match[1] === 'effort' && (EFFORT_LEVELS as readonly string[]).includes(value)) {
    return { type: 'model-set', effort: value as EffortLevel };
  }
  return null;
}

/*
 * Zawieszony prompt.
 *
 * `agent.prompt` wpisuje tekst do composera i naciska Enter — a Enter po dłuższym wklejeniu
 * potrafi nie zarejestrować się w TUI. Tekst wisi wtedy w polu wejściowym, tura nie rusza,
 * a Rarog bez `wait` nie miałby jak się o tym dowiedzieć i pokazywałby „pracuje" bez końca.
 * Zwykłe prompty jadą więc z `wait` (herdr czeka na `working`, brak przejścia = stalled),
 * a stall jest ponawiany DOKŁADNIE raz — po potwierdzeniu ekranem, że tekst naprawdę wisi.
 */

/** Ile znaków początku promptu (po zbiciu białych znaków) potwierdza stall na ekranie. */
export const STALL_SCREEN_NEEDLE_CHARS = 48;

/**
 * Sonda stanu po przerwaniu.
 *
 * Opóźniony push `working` z tury sprzed przerwania potrafi wjechać PO przejściu managera
 * w `waiting-input` i wskrzesić „pracuje" aż do następnego pusha albo resyncu (30 s). Nie
 * czekamy na push: po `escape` pytamy herdr o stan wprost (`agent.get`), dwa razy — druga
 * próba domyka przypadek, w którym pierwszy odczyt wyprzedził zejście panelu do `idle`.
 */
export const INTERRUPT_PROBE_DELAYS_MS: readonly number[] = [1200, 2500];

/** Ile PAR `esc esc` wolno wysłać przy czyszczeniu composera, zanim uznamy je za daremne. */
export const COMPOSER_CLEAR_ATTEMPTS = 3;

/**
 * Wysyłka wstrzymana, bo w panelu stoi dialog ZGODY CLI. Zdanie mówi wprost, że nic
 * nie poszło: inaczej tekst wpadałby w kolejkę CLI za dialogiem, watchdog meldowałby „utknęła",
 * a wiadomość wychodziłaby sama po zgodzie przy biurku — dwa kłamstwa naraz.
 */
export const CONSENT_DIALOG_SEND_MESSAGE: OwnText = say('commands.send-held.consent-dialog');

/**
 * Formularz `AskUserQuestion` stoi, choć herdr go nie widzi — tekst wpadłby w jego pole
 * „Type something", a `shift+tab` przełączałby zakładki. Wysyłka przyjęta chwilę wcześniej
 * czekała w kolejce drivera, zanim manager zamknął composer.
 */
export const FORM_STANDS_SEND_MESSAGE: OwnText = say('commands.send-held.form');

/**
 * Dialog CLI stoi, choć herdr go nie widzi — zgłosił go rejestr sesji Claude Code (`waiting`),
 * a świeży ekran nie pokazuje pola promptu. Tekst wpadłby w dialog, a `shift+tab`
 * przełączałby w nim opcje — więc nic nie wychodzi.
 */
export const CLI_DIALOG_SEND_MESSAGE: OwnText = say('commands.send-held.cli-dialog');

/**
 * Life of the echo of a command sent while a turn runs that the CLI may run without a call entry (`/rename`, registry
 * rule `inTurn: 'silent'`). When the turn ends just before the Enter, the CLI runs it idle and writes the call about
 * 0.45 s after the send (CLI 2.1.325), which this entry clears; inside the turn the call never comes, and the entry
 * must not swallow the same command typed later. The bound leaves room for a late read of the file.
 */
export const IN_TURN_COMMAND_ECHO_MS = 10_000;

/** Wiadomość, gdy prompt utknął mimo ponowienia — composer wraca do życia, tekst zostaje w polu. */
export const STALLED_PROMPT_MESSAGE: OwnText = say('commands.send-stalled');

/**
 * Komenda poszła, ale panel nie zaczął tury — i to jest jej NORMALNY koniec.
 *
 * Nie wchodzi tu {@link STALLED_PROMPT_MESSAGE}, czyli zdanie „wiadomość utknęła
 * i NIE została wysłana". Dla `/status`, `/context`, `/cost`, `/usage`, `/help` i `/agents`
 * byłoby ono NIEPRAWDĄ: komenda wykonuje się w panelu, tylko nie rusza jsonl ani
 * statusu herdr, więc watchdog ciszy meldowałby awarię tam, gdzie nic się nie zepsuło —
 * i uzbrajałby `#needsEscape`, czyli Esc przed następną wysyłką (a ten zamknąłby dialog,
 * który komenda właśnie otworzyła).
 */
export function quietCommandMessage(command: string): OwnText {
  return say('commands.quiet-command', { command });
}

/**
 * Czy composer panelu trzyma POCZĄTEK naszego promptu.
 *
 * Porównanie po zbiciu wszystkich białych znaków: composer łamie długi tekst na szerokość
 * panelu, więc dosłowny substring by nie trafił. Ekran potrafi zawierać sekrety — treść jest
 * TYLKO porównywana, nigdy logowana ani emitowana.
 */
export function screenHoldsNeedle(screenText: string, text: string): boolean {
  const squash = (value: string): string => value.replace(/\s+/g, '');
  const needle = squash(text).slice(0, STALL_SCREEN_NEEDLE_CHARS);
  return needle !== '' && squash(screenText).includes(needle);
}

/** Znak zachęty pola promptu `❯` w kolumnie 0 — wygląd CLI z rejestru sygnatur. */
const COMPOSER_PROMPT_PATTERN = SCREEN_SIGNATURES.composerPrompt.pattern;

/**
 * Stan composera odczytany z ekranu: `filled` / `empty` / `unknown`.
 *
 * Composer to OSTATNIA linia ekranu zaczynająca się od `❯` w kolumnie 0 (zmierzone
 * na żywym panelu): wysłane wiadomości w historii też renderują `❯` w kolumnie 0,
 * ale zawsze NAD composerem, a wskaźniki opcji dialogów (`❯ 1. Yes`, `❯ (current)`) są
 * wcięte. Brak takiej linii (stoi dialog pełnoekranowy, np. rewind) = `unknown` — wtedy
 * nie klikamy w ciemno. Błąd odczytu ekranu daje `unknown` po stronie fasady.
 *
 * Ekran ma tu przychodzić Z ATRYBUTAMI (`agent.read` w formacie `ansi`, źródło `visible` —
 * `detection` jest zawsze odarte z sekwencji), bo treść odróżniamy po
 * ATRYBUCIE, nie po samych znakach: Claude Code 2.1.258 wyświetla w pustym composerze
 * PODPOWIEDŹ następnego promptu jako tekst przyciemniony (SGR 2), tak jak placeholder
 * `Try "…"`. Odczyt bez atrybutów widziałby ją jako wpisany tekst, Rarog słałby parę `Esc Esc`
 * na PUSTE pole, para otwiera rewind, a rewind zjada każdą kolejną wysyłkę. Tekst wpisany przez człowieka albo wklejony
 * przez Raroga CLI nigdy nie przyciemnia — dlatego „pełny" = choć jeden znak niepusty POZA
 * przyciemnieniem. Na ekranie bez sekwencji ESC (testy, odczyt bez atrybutów)
 * cały tekst liczy się jako treść.
 */
export function composerStateFrom(screenText: string): 'filled' | 'empty' | 'unknown' {
  let composer: string | null = null;
  for (const line of screenText.split('\n')) {
    const cells = visibleCells(line);
    if (COMPOSER_PROMPT_PATTERN.test(cells.plain)) composer = cells.content.replace(COMPOSER_PROMPT_PATTERN, '').trim();
  }
  if (composer === null) return 'unknown';
  return composer === '' ? 'empty' : 'filled';
}

/**
 * Jedyny tekst restartu sesji. Stała, a nie parametr: `requestExit()` nie przyjmuje
 * niczego z zewnątrz. `/exit` w wolnym tekście odrzuca strażnik (`herdr/commands/guard.ts`, poza allow-listą);
 * restart idzie obok niego jako osobny gest z tą stałą i omija też stall-guard, który przy wyjściu kłamie.
 */
export const RESTART_EXIT_COMMAND = '/exit';

/**
 * Linia ramki pola promptu: kreska od KOLUMNY 0 (`────…`, bywa z nazwą sesji po `/rename`).
 * Bez `trim()` — linie szkicu CLI rysuje z wcięciem (fixture `composer-region-wrapped-2.1.283.ansi.txt`),
 * więc `  ──────` wpisane przez człowieka w treści nie jest ramką.
 */
const COMPOSER_RULE_RE = SCREEN_SIGNATURES.composerRule.pattern;

/**
 * Stan CAŁEGO pola promptu — bramka restartu sesji, nie para `Esc Esc`.
 *
 * `composerStateFrom` patrzy na jedną linię z `❯`, a pole bywa wieloliniowe: szkic zaczęty
 * od pustej linii (`\` + Enter) rysuje `❯` z pustym ogonem, a treść stoi w linii POD nim
 * (zmierzone na CLI 2.1.283, fixture `composer-region-leading-blank-2.1.283`).
 * Dla `Esc Esc` pomyłka „pusto" kosztuje jedno niewyczyszczone pole; dla restartu —
 * `/exit` dopisany za cudzym szkicem i wysłany do modelu jako prompt. Dlatego tutaj
 * czytamy cały obszar między dwiema liniami ramki, a niepewność to `unknown`:
 * - brak linii z `❯` w kolumnie 0 (stoi dialog) → `unknown`,
 * - brak ramki NAD albo POD tą linią (pole ucięte, inny układ ekranu) → `unknown`,
 * - choć jeden znak treści poza przyciemnieniem (SGR 2 — podpowiedź CLI) → `filled`.
 */
export function composerRegionState(screenText: string): 'filled' | 'empty' | 'unknown' {
  const region = composerRegionText(screenText);
  if (region === null) return 'unknown';
  return region.trim() !== '' ? 'filled' : 'empty';
}

/**
 * Treść CAŁEGO pola promptu — ten sam obszar i te same reguły co {@link composerRegionState} (linia z `❯`
 * w kolumnie 0 między dwiema liniami ramki, bez przyciemnionej podpowiedzi CLI, bez samego `❯`). Linie pola
 * łączy `\n`. `null` = obszaru nie da się wyznaczyć (dialog, brak ramki) — dokładnie wtedy, gdy stan to
 * `unknown`.
 *
 * Po co osobno: odczyt pola po turze (prompt zablokowany przez hook w trakcie tury) pyta, CZYJ tekst
 * stoi w polu. Porównanie z całym ekranem trafiałoby w historię rozmowy, gdzie wysłane prompty też stoją
 * za `❯`. Ekran potrafi zawierać sekrety — treść jest tylko porównywana, nigdy logowana.
 */
export function composerRegionText(screenText: string): string | null {
  const lines = screenText.split('\n').map((line) => visibleCells(line));
  let start = -1;
  lines.forEach((cells, index) => { if (COMPOSER_PROMPT_PATTERN.test(cells.plain)) start = index; });
  if (start < 1) return null;
  if (!COMPOSER_RULE_RE.test(lines[start - 1]?.plain ?? '')) return null;
  const end = lines.findIndex((cells, index) => (
    index > start && COMPOSER_RULE_RE.test(cells.plain)
  ));
  if (end < 0) return null;
  return lines.slice(start, end).map((cells, index) => (
    index === 0 ? cells.content.replace(COMPOSER_PROMPT_PATTERN, '') : cells.content
  )).join('\n');
}

const COMPOSER_QUEUE_HINT_RE = SCREEN_SIGNATURES.composerQueueHint.pattern;
const QUEUED_PROMPTS_MARKER = SCREEN_SIGNATURES.queuedPromptsMarker.pattern;
/** How far above the field's top rule the queued prompts' marker line may stand (spinner, blank lines, task list). */
const QUEUED_MARKER_LINES = 12;

/**
 * Whether the screen shows the CLI prompt queue around a normal prompt field (CLI 2.1.328,
 * `queue/measured/zabranie-*-przed-up`): the dimmed hint `Press up to edit queued…` as the only text of the field, or
 * the `ctrl+enter to send now` line under the queued prompts within {@link QUEUED_MARKER_LINES} lines above the
 * field's top rule. The `❯` rows of the queued prompts alone prove nothing: the prompt of the running turn is such a
 * row too. The hint counts only dimmed (screen with attributes): read without them it is field text.
 */
export function composerQueueShown(screenText: string): boolean {
  const lines = screenText.split('\n').map((line) => visibleCells(line));
  let start = -1;
  lines.forEach((cells, index) => { if (COMPOSER_PROMPT_PATTERN.test(cells.plain)) start = index; });
  if (start < 1 || !COMPOSER_RULE_RE.test(lines[start - 1]?.plain ?? '')) return false;
  const prompt = lines[start];
  const hint = prompt !== undefined && prompt.content.replace(COMPOSER_PROMPT_PATTERN, '').trim() === ''
    && COMPOSER_QUEUE_HINT_RE.test(prompt.plain.replace(COMPOSER_PROMPT_PATTERN, '').trim());
  const above = lines.slice(Math.max(0, start - 1 - QUEUED_MARKER_LINES), start - 1);
  return hint || above.some((cells) => cells.plain.toLowerCase().includes(QUEUED_PROMPTS_MARKER));
}

const COMPOSER_RULE_HISTORY_RE = SCREEN_SIGNATURES.composerRuleHistory.pattern;
const COMPOSER_RULE_CUT_RE = SCREEN_SIGNATURES.composerRuleCut.pattern;

/** The prompt field as {@link composerFieldView} reads it. */
export interface ComposerFieldView {
  /** Visible field text, lines joined by `\n`, without `❯` and without the dimmed CLI hint. */
  readonly text: string;
  /** The top rule says lines above are hidden (`↑ N`): `text` is only the bottom of the field. */
  readonly cutAtTop: boolean;
  /** The top rule carries a `History N/M` header: the field shows a history entry, not a draft. */
  readonly history: boolean;
}

/**
 * The prompt field, including the two shapes {@link composerRegionText} answers `null` for, measured on CLI 2.1.328
 * (`queue/measured/zabranie-*`):
 * - a field taller than the pane: the top rule is `─── ↑ 13 more ───` and the `❯` line is off screen, so the text
 *   is only the visible bottom (`cutAtTop`);
 * - a history entry: the top rule is `─── History 100/100 ───` (three dashes, not a `composerRule`), or, at 26
 *   columns, ` History 100/100 · ↑ 16 mo` with the entry cut at the top as well (`history`).
 *
 * A normal field gives exactly the {@link composerRegionText} text with both marks `false`; that reader stays the
 * gate of the restart and of the leftover verdicts, which must keep failing closed on these shapes. A header shape
 * counts only as the last field on screen: the text runs to the next `composerRule`, an uncut field starts with
 * `❯`, a cut one has no `❯` line, and no `❯` line or field header stands below it. Anything else is `null`.
 */
export function composerFieldView(screenText: string): ComposerFieldView | null {
  const lines = screenText.split('\n').map((line) => visibleCells(line));
  const isHeader = (plain: string): boolean => COMPOSER_RULE_HISTORY_RE.test(plain) || COMPOSER_RULE_CUT_RE.test(plain);
  let top = -1;
  let prompt = -1;
  lines.forEach((cells, index) => {
    if (isHeader(cells.plain)) top = index;
    if (COMPOSER_PROMPT_PATTERN.test(cells.plain)) prompt = index;
  });
  // The last field on screen wins: a header below the `❯` line the frame-to-frame reader starts from belongs to
  // a later field, and that field answers (or the read is `null` when it is incomplete).
  const region = composerRegionText(screenText);
  if (region !== null && top < prompt) return { text: region, cutAtTop: false, history: false };
  if (top < 0) return null;
  const end = lines.findIndex((cells, index) => index > top && COMPOSER_RULE_RE.test(cells.plain));
  if (end < 0) return null;
  if (lines.slice(end + 1).some((cells) => COMPOSER_PROMPT_PATTERN.test(cells.plain))) return null;
  const header = lines[top]?.plain ?? '';
  const cutAtTop = COMPOSER_RULE_CUT_RE.test(header);
  const field = lines.slice(top + 1, end);
  const prompts = field.filter((cells) => COMPOSER_PROMPT_PATTERN.test(cells.plain)).length;
  if (cutAtTop ? prompts !== 0 : prompts !== 1 || !COMPOSER_PROMPT_PATTERN.test(field[0]?.plain ?? '')) return null;
  const text = field.map((cells, index) => (
    index === 0 && !cutAtTop ? cells.content.replace(COMPOSER_PROMPT_PATTERN, '') : cells.content
  )).join('\n');
  return { text, cutAtTop, history: COMPOSER_RULE_HISTORY_RE.test(header) };
}

/** Tekst bez żadnych białych znaków — klucz porównania treści pola (composer łamie i wcina długie linie). */
export function squashWhitespace(value: string): string {
  return value.replace(/\s+/g, '');
}

/**
 * Werdykty odczytu pola po turze dla wstrzymanych wiadomości, w kolejności wysyłki (typ {@link HeldLeftover}).
 *
 * Po blokadzie CLI oddaje do pola DOKŁADNIE tekst promptu, a drugi prompt zablokowany w tej samej turze dopisuje się
 * za pierwszym. `not-taken` dostają więc tylko wiadomości, których teksty (po zbiciu białych znaków) sklejone po
 * kolei są RÓWNE treści pola; przy kilku takich ciągach — najpóźniejszy. Każde inne pełne pole to `unconfirmed`.
 * Samo zawieranie (reguła stall-guardu, `screenHoldsNeedle`) nie wystarcza: krótki prompt „ok” siedzi w szkicu
 * „Popraw dokumentację”, a `not-taken` pozwala następnej wysyłce wyczyścić pole.
 *
 * @param region treść pola z {@link composerRegionText}; `null` = pole nieczytelne
 * @param texts teksty wiadomości wysłane do CLI
 */
export function heldLeftoverVerdicts(region: string | null, texts: readonly string[]): HeldLeftover[] {
  if (region === null) return texts.map(() => 'unknown');
  const field = squashWhitespace(region);
  if (field === '') return texts.map(() => 'empty');
  const keys = texts.map(squashWhitespace);
  for (let start = keys.length - 1; start >= 0; start -= 1) {
    let joined = '';
    for (let end = start; end < keys.length; end += 1) {
      joined += keys[end] ?? '';
      if (joined === field) {
        return texts.map((_, index) => (index >= start && index <= end ? 'not-taken' : 'unconfirmed'));
      }
      if (!field.startsWith(joined)) break;
    }
  }
  return texts.map(() => 'unconfirmed');
}

/**
 * Sekwencje sterujące terminala: SGR (`ESC[…m`), inne CSI, OSC (tytuł okna) — do zdjęcia
 * z linii ekranu. Zrzut `visible` herdr to wyrenderowana siatka, więc w praktyce trafia się
 * wyłącznie SGR; reszta jest tu na wypadek, gdyby herdr kiedyś oddał więcej.
 */
const TERMINAL_SEQUENCE = /\x1b\[([\d;]*)m|\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;

/**
 * Jedna linia ekranu rozbita na `plain` (wszystkie znaki widoczne, do rozpoznania KSZTAŁTU:
 * `❯` w kolumnie 0) i `content` (znaki widoczne POZA przyciemnieniem, do rozpoznania TREŚCI).
 *
 * Stan „przyciemniony" włącza SGR `2`, wyłącza `22` albo pełny reset (`0` lub pusty parametr).
 * Parametry koloru `38`/`48` mają podparametry (`5;n` albo `2;r;g;b`), w których `2` NIE jest
 * przyciemnieniem — trzeba je przeskoczyć, inaczej kolor 24-bitowy tekstu użytkownika
 * (`38;2;r;g;b`, tak CC koloruje `❯`) udawałby ghost i pełne pole wyglądałoby na puste.
 */
function visibleCells(line: string): { plain: string; content: string } {
  let plain = '';
  let content = '';
  let dim = false;
  let last = 0;
  for (const match of line.matchAll(TERMINAL_SEQUENCE)) {
    const chunk = line.slice(last, match.index);
    plain += chunk;
    if (!dim) content += chunk;
    last = match.index + match[0].length;
    if (match[1] !== undefined) dim = applySgrDim(match[1], dim);
  }
  const tail = line.slice(last);
  plain += tail;
  if (!dim) content += tail;
  return { plain, content };
}

/** Nowy stan przyciemnienia po parametrach jednej sekwencji SGR. */
function applySgrDim(params: string, dim: boolean): boolean {
  const codes = params === '' ? [0] : params.split(';').map((code) => Number(code));
  let next = dim;
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    if (code === 0) next = false;
    else if (code === 2) next = true;
    else if (code === 22) next = false;
    else if (code === 38 || code === 48) {
      // Kolor rozszerzony: `5;n` (1 podparametr) albo `2;r;g;b` (4 podparametry).
      i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
    }
  }
  return next;
}

/** Wynik komendy sterującej wypisany w miejscu (bez dialogu) — patrz `commandResultInline`. */
const COMMAND_INLINE_RESULT_PATTERN = SCREEN_SIGNATURES.commandInlineResult.pattern;

/** Echo komendy `/model` w kolumnie 0 — wynik w miejscu liczy się tylko tuż pod nim. */
const COMMAND_ECHO_PATTERN = SCREEN_SIGNATURES.commandEcho.pattern;

/** Echo komendy `/effort` w kolumnie 0 z jej tekstem w grupie — wynik ultracode liczy się tylko pod ostatnim. */
const ULTRACODE_ECHO_PATTERN = SCREEN_SIGNATURES.ultracodeEcho.pattern;

/** Wiersz wyniku w miejscu (`⎿  …`) z treścią w grupie — słowa wyniku czyta `ultracodeResultOf`. */
const ULTRACODE_RESULT_PATTERN = SCREEN_SIGNATURES.ultracodeInlineResult.pattern;

/** The `/effort <level>` result line in place, with the level in the group. */
const EFFORT_RESULT_PATTERN = SCREEN_SIGNATURES.effortInlineResult.pattern;

/** Linie ekranu bez sekwencji sterujących i bez spacji na końcu. */
function screenLines(screenText: string): string[] {
  return stripTerminalControl(screenText).split('\n').map((line) => line.replace(/\s+$/, ''));
}

/**
 * Wynik komendy ultracode na ekranie: pierwszy niepusty wiersz pod OSTATNIM echem `/effort`, ale tylko gdy to echo
 * jest dokładnie wysłaną komendą. W paczce `/effort xhigh` + `/effort ultracode` ostatnim echem bywa jeszcze
 * `/effort xhigh` (komenda ultracode nie doszła na ekran) i wtedy wyniku nie ma, a nie „jest stary”.
 */
function ultracodeScreenResult(command: string, screenText: string): boolean | 'refused' | null {
  const lines = screenLines(screenText);
  let echo = -1;
  let echoed = '';
  for (const [index, line] of lines.entries()) {
    const match = ULTRACODE_ECHO_PATTERN.exec(line);
    if (match === null) continue;
    echo = index;
    echoed = (match[1] ?? '').trim();
  }
  if (echo === -1 || echoed !== command.trim()) return null;
  const result = lines.slice(echo + 1).find((line) => line.trim() !== '');
  const text = result === undefined ? undefined : ULTRACODE_RESULT_PATTERN.exec(result)?.[1];
  return text === undefined ? null : ultracodeResultOf(text);
}

/** Level of a `/effort <level>` command with a level from `EFFORT_LEVELS`; any other command → `null`. */
function effortCommandLevel(command: string): EffortLevel | null {
  const value = /^\/effort (\S+)$/.exec(command.trim())?.[1] ?? '';
  return (EFFORT_LEVELS as readonly string[]).includes(value) ? value as EffortLevel : null;
}

/** How many `❯ /effort …` echoes on the screen are exactly `command`. */
function effortEchoCount(command: string, screenText: string): number {
  const sent = command.trim();
  return screenLines(screenText)
    .filter((line) => (ULTRACODE_ECHO_PATTERN.exec(line)?.[1] ?? '').trim() === sent).length;
}

/**
 * The in-place result of `/effort <level>`: the LAST `❯ /effort …` echo is exactly the sent command, the first
 * non-empty line under it starts with "⎿ Set effort level to <the same level>" (prefix only: the rest of the sentence
 * is not measured for every level), and the screen holds more echoes of this command than `before`. The count is the
 * freshness check: without it an earlier change to the same level in the scrollback would end the wait before the new
 * echo is drawn (the command goes without `wait`, so the first read can still show the old screen).
 */
function effortResultInline(command: string, level: EffortLevel, screenText: string, before: string): boolean {
  const lines = screenLines(screenText);
  let echo = -1;
  let echoed = '';
  for (const [index, line] of lines.entries()) {
    const match = ULTRACODE_ECHO_PATTERN.exec(line);
    if (match === null) continue;
    echo = index;
    echoed = (match[1] ?? '').trim();
  }
  if (echo === -1 || echoed !== command.trim()) return false;
  const result = lines.slice(echo + 1).find((line) => line.trim() !== '');
  if (result === undefined || EFFORT_RESULT_PATTERN.exec(result)?.[1] !== level) return false;
  return effortEchoCount(command, screenText) > effortEchoCount(command, before);
}

/**
 * Czy CLI ODMÓWIŁO komendy ultracode w miejscu wyniku (`ULTRACODE_REFUSAL`)? Tylko dla komend ultracode
 * i tylko pod echem dokładnie tej komendy. Odmowa kończy czekanie: dialogu po niej nie będzie.
 */
export function commandRefusedInline(command: string, screenText: string): boolean {
  return ultracodeCommandValue(command) !== null && ultracodeScreenResult(command, screenText) === 'refused';
}

/**
 * Czy CLI wypisało wynik komendy sterującej W MIEJSCU, bez dialogu?
 *
 * Zmierzone na CLI 2.1.258 (zrzut `model-set-inline-2.1.258.txt`): `/model <id>` nie
 * stawia już „Switch model?", tylko drukuje pod echem komendy „⎿  Set model to Fable 5.1 and
 * saved as your default for new sessions". Dla Raroga to KONIEC czekania na dialog — dalsze
 * odczyty ekranu mogłyby trafić w cyfry ze scrollbacku. Uwaga: starsze CLI (2.1.241, fixture
 * `dialog-model-switch.txt`) drukowało ten wiersz I stawiało dialog — dlatego driver pyta
 * o wynik dopiero wtedy, gdy na ekranie nie ma dialogu o czytelnym kształcie.
 *
 * Wiersz wyniku liczy się WYŁĄCZNIE jako pierwsza niepusta linia pod OSTATNIM echem komendy
 * (`❯ /model …` w kolumnie 0): wzorzec po całym ekranie kończyłby czekanie na „⎿ Set model to …”
 * wypisanym przez agenta. Brak echa = `false`, czyli czekamy dalej.
 *
 * Komendy ultracode (zrzuty `ultracode/wynik-effort-ultracode-*-2.1.317.txt`) mają własną regułę:
 * echo musi być dokładnie wysłaną komendą, a wiersz wyniku mówić o wysłanej WARTOŚCI, więc stare
 * „⎿ Ultracode on …” w scrollbacku nie potwierdza wysłanego `… off`.
 *
 * `/effort <level>` prints its result in place on CLI 2.1.319 (`kontrolny/potwierdzenie-model-opus-2.1.319.txt`), but
 * the same echo and result from an earlier change can stand in the scrollback, so the rule needs `before`: the screen
 * read before the command was sent ({@link effortResultInline}). Without `before` it is `false`: wait the window.
 */
export function commandResultInline(command: string, screenText: string, before: string | null = null): boolean {
  const ultracode = ultracodeCommandValue(command);
  if (ultracode !== null) return ultracodeScreenResult(command, screenText) === ultracode;
  const level = effortCommandLevel(command);
  if (level !== null) return before !== null && effortResultInline(command, level, screenText, before);
  if (!/^\/model\b/.test(command.trim())) return false;
  const lines = screenLines(screenText);
  let echo = -1;
  lines.forEach((line, i) => {
    if (COMMAND_ECHO_PATTERN.test(line)) echo = i;
  });
  if (echo === -1) return false;
  const result = lines.slice(echo + 1).find((line) => line.trim() !== '');
  return result !== undefined && COMMAND_INLINE_RESULT_PATTERN.test(result);
}

/**
 * Czy dialog na ekranie jest POTWIERDZENIEM komendy sterującej, którą Rarog właśnie wysłał?
 *
 * Jedna ścieżka, fail-closed: **klasa `confirm`** (kształt potwierdzenia ustawień CLI, patrz
 * `confirmFrom` w `herdr/dialogs/screen/`) — ale tylko wtedy, gdy dialog mówi O TEJ komendzie: treść
 * pytania zawiera jej nazwę („Switch model?" ↔ `/model`, „Change effort level?" ↔ `/effort`) ALBO
 * któraś opcja niesie jej wartość („Yes, switch to high" ↔ `/effort high`). Bez tego zbiegu
 * okoliczność „jakiś dialog potwierdzenia wjechał w oknie po komendzie" kończy się `foreign`, zero
 * klawiszy.
 *
 * Sygnatura `model` z zamkniętej listy nie daje `true` dla każdego rodzaju dialogu: szłaby po całym ekranie, więc zgoda
 * `Bash` z „Switch model" w scrollbacku, w opisie albo w komendzie dostałaby cyfrę po `/effort high`. Prawdziwe dialogi
 * `model` i `effort` (`dialog-model-switch.txt`, `dialog-effort-change.txt`) przechodzą ścieżką `confirm`.
 *
 * Auto-potwierdzenie jest tu uczciwe wobec polityki eskalacji, bo decyzję podjął już człowiek — na
 * telefonie, wybierając wartość w arkuszu Raroga. Terminalowy dialog pyta o to samo drugi raz.
 *
 * Komenda ultracode NIE ma swojego dialogu (pomiar 2.1.317: wynik w miejscu), więc każdy dialog po niej jest
 * obcy: `false`, zero klawiszy. Bez tej reguły opcja z wartością `ultracode` w etykiecie dostałaby cyfrę.
 */
export function commandDialogMatches(
  command: string,
  _screenText: string,
  dialog: ScreenDialog,
): boolean {
  if (ultracodeCommandValue(command) !== null) return false;
  // Dialog z listy `TERMINAL_DIALOGS` nie jest dialogiem żadnej komendy: pauza po fladze zabezpieczeń
  // niesie nazwy modeli, a Rarog nie wybiera w nim opcji z żadnej ścieżki.
  if (dialog.terminalDialog !== null) return false;
  if (dialog.kind !== 'confirm' || dialog.question === null) return false;
  const parsed = /^\/([a-z][a-z0-9_-]*)(?:\s+(\S+))?/i.exec(command.trim());
  if (parsed === null) return false;
  const name = (parsed[1] ?? '').toLowerCase();
  const value = (parsed[2] ?? '').toLowerCase();
  if (name !== '' && dialog.question.question.toLowerCase().includes(name)) return true;
  return value !== ''
    && dialog.options.some((option) => option.label.toLowerCase().includes(value));
}

/** Registry id of the "Switch model?" shape (`herdr/dialogs/layer2/shapes.ts`). */
const MODEL_CONFIRM_SHAPE = 'model-confirm';

/**
 * Model family that "Switch model?" names for each alias the `/model` sheet sends (`FALLBACK_MODEL_CHOICES` holds only
 * aliases). The alias table measured on CLI 2.1.316, the same labels on a subscription and on an API key (fixtures
 * `kontrolny/potwierdzenie-model-*-2.1.316.txt`): `fable` "Fable 5.1", `opus` and `opus[1m]` "Opus 5.5", `sonnet`
 * "Sonnet 5.5", `haiku` "Haiku 5.5". The table pins the family, not the version: an alias names the latest model of
 * its family, so a new version keeps the confirmation. An alias outside the table gets no confirmation.
 */
export const MODEL_SWITCH_FAMILIES: ReadonlyMap<string, string> = new Map([
  ['fable', 'Fable'], ['opus', 'Opus'], ['opus[1m]', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'],
]);

/** The audit line of the digit: the fields of today's confirmation of the known dialog `model`. */
export interface ModelSwitchEntry {
  readonly method: 'model_change';
  readonly keys: readonly [string];
  readonly toolName: string;
  readonly optionLabel: string;
}

/** What the confirmation needs from the driver facade: the send shield of a layer 2 step, a fresh read, the digit. */
export interface ModelSwitchPort
  extends Pick<Layer2StepPort, 'keyShield' | 'keyHookWaits' | 'engineSession' | 'disposed'> {
  /** A fresh screen read (`detection`, past every cache); a throw counts as a failed read. */
  readScreen(): Promise<{ readonly text: string }>;
  /** Sends `entry.keys` through `sendKeys` and writes `entry` to the audit; `false` = no key went. */
  sendDigit(entry: ModelSwitchEntry): Promise<boolean>;
}

/** "Switch model?" on one screen: the block print, digit and label of "Yes, switch to …", and the model family. */
interface ModelSwitchBlock {
  readonly print: string;
  readonly digit: number;
  readonly label: string;
  readonly family: string;
}

/**
 * "Switch model?" read from its block alone: the shape `model-confirm` and a layer 2 verdict with choices, in which the
 * shape's "Yes, switch to <model>" stands with the same digit. `null` = no such block on the screen; `'unproven'` = the
 * shape matches, but the verdict or that pair does not hold. The class `dialog` is the send shield's to prove.
 */
function modelSwitchOn(text: string): ModelSwitchBlock | 'unproven' | null {
  const block = readBlock(text);
  const shape = shapeOf(block);
  if (block === null || shape === null || shape.shape.id !== MODEL_CONFIRM_SHAPE) return null;
  const { allow, value } = shape;
  const verdict = layer2Verdict(block, 'dialog');
  const choice = verdict.kind === 'choices' && allow !== null
    ? verdict.choices.find((item) => item.label === allow.label) : undefined;
  if (verdict.kind !== 'choices' || allow === null || value === null || choice === undefined
    || !('digit' in choice.send) || String(choice.send.digit) !== allow.digit) return 'unproven';
  return { print: verdict.print, digit: choice.send.digit, label: choice.label, family: value.split(' ')[0] ?? '' };
}

/**
 * Whether `text` still shows the confirmation dialog of `command`, by the same recognizers that let its digit go: the
 * dialog of the command (`commandDialogMatches`) or "Switch model?" naming the family of the sent alias.
 */
export function commandDialogStands(command: string, text: string, dialog: ScreenDialog | null): boolean {
  if (dialog !== null && commandDialogMatches(command, text, dialog)) return true;
  const found = modelSwitchOn(text);
  const family = modelSwitchFamily(command);
  return found !== null && found !== 'unproven' && family !== null && found.family === family;
}

/** The family of the alias in `/model <alias>` ({@link MODEL_SWITCH_FAMILIES}); `null` = another command or alias. */
function modelSwitchFamily(command: string): string | null {
  const parsed = /^\/model (\S+)$/.exec(command.trim());
  return parsed === null ? null : MODEL_SWITCH_FAMILIES.get(parsed[1] ?? '') ?? null;
}

/**
 * "Switch model?" after `/model <alias>`, confirmed from its block. This is the path for the dialog that today's
 * recognition does not know: under the session status rule (`▔▔▔ ○ low · /effort ▔`) the parser gives it kind
 * `other` (CLI 2.1.314 to 2.1.319, `kontrolny/potwierdzenie-model-*`). Under a bare rule it is the known dialog
 * `model` and does not come here. The human chose the model on the phone and the dialog asks the same again, so the
 * digit goes without a tap, but only when all of these hold, in this order:
 *
 * 1. the block is "Switch model?" with a layer 2 verdict, and "Yes, switch to <model>" names the family of the sent
 *    alias; another command, an alias outside the table or another family gives `foreign`;
 * 2. the send shield of class `dialog` (`keyShield`): no hook consent request, and the registry says `waiting` with
 *    class `dialog`;
 * 3. a fresh read gives the same block print and the same label under the same digit;
 * 4. with no `await` up to the key: no hook registration (`keyHookWaits`), the same engine session, the driver alive.
 *
 * A failed check gives `foreign`: zero keys, and the dialog stays for the terminal or a card.
 *
 * @returns `null` = no "Switch model?" block on `text`, the caller goes on with its own reading; otherwise the
 *   outcome, `confirmed` only when the digit went
 */
export async function confirmModelSwitch(
  command: string, text: string, port: ModelSwitchPort,
): Promise<ModelCommandOutcome | null> {
  const found = modelSwitchOn(text);
  if (found === null) return null;
  const family = modelSwitchFamily(command);
  if (found === 'unproven' || family === null || found.family !== family) return 'foreign';
  const session = port.engineSession();
  if (await port.keyShield() !== null) return 'foreign';
  let fresh: ModelSwitchBlock | 'unproven' | null;
  try {
    fresh = modelSwitchOn((await port.readScreen()).text);
  } catch {
    return 'foreign';
  }
  if (fresh === null || fresh === 'unproven' || fresh.print !== found.print || fresh.digit !== found.digit
    || fresh.label !== found.label) return 'foreign';
  // No `await` from here to the key.
  if (port.keyHookWaits() || port.engineSession() !== session || port.disposed()) return 'foreign';
  const sent = await port.sendDigit({
    method: 'model_change', keys: [String(found.digit)], toolName: `${SCREEN_DIALOG_TOOL}:model`,
    optionLabel: found.label,
  });
  return sent ? 'confirmed' : 'foreign';
}
