/**
 * Wszystko, co musi być prawdą o tekście, ZANIM pójdzie do cudzego panelu.
 *
 * Kanał tekstu jest szerszy niż allow-lista klawiszy: przez `agent.prompt` da się zrobić
 * w panelu wszystko, co da się zrobić z klawiatury. Ten moduł nie udaje, że temu zapobiega —
 * odcina trzy konkretne klasy szkody, których użytkownik dyktujący zdanie z telefonu NIGDY
 * nie zamierzał wywołać:
 *
 * 1. przypadkowe wepchnięcie megabajtów do pty żywego panelu (limit ciała `/messages` to 12 MB),
 * 2. tryb powłoki (`!`) — tekst po nim CLI wykonuje w powłoce,
 * 3. slash-komendy spoza katalogu sesji: CLI wykonuje prefiks (`/usa` → `/usage`), alias
 *    (`/settings x=1` → `/config x=1`, ustawia bez dialogu) i inną wielkość liter, więc przechodzi
 *    WYŁĄCZNIE nazwa kanoniczna z allow-listy (`catalog.ts`, reguła w `shape.ts`).
 *
 * Reszta — w tym `bypass permissions` poza `RAROG_YOLO_ROOTS` — jest symetryczna do reguł,
 * które Rarog ma dziś dla sesji SDK (`#assertPermissionMode`).
 */
import { MAX_HERDR_PROMPT_BYTES } from '@rarog/shared';
import type { HerdrMode } from '@rarog/shared';
import {
  HERDR_SEND_HOURLY_CAP, HERDR_SEND_MIN_INTERVAL_MS, isInsideAnyRootReal,
} from '../../config.ts';
import { type AnyText, say } from '@rarog/shared/sentences';
import { HerdrError } from '../types.ts';
import { stripTerminalControl } from '../dialogs/screen/text.ts';
import { INTERNAL_SLASH_COMMANDS, ULTRACODE_COMMANDS } from './registry.ts';
import type { CommandCatalog } from './catalog.ts';
import { classifySlashText, slashOf } from './shape.ts';
import type { SlashCommand } from './shape.ts';

/**
 * Odrzucenie tekstu przed wysyłką — komunikat jest przeznaczony DLA UŻYTKOWNIKA (router
 * pokazuje go dosłownie).
 *
 * `code = 'bad-request'` daje 400 w `managerErrorStatus()`. Klasa jest własna, a nie
 * `BadRequestError` z `sessions/manager.ts`, bo import managera z modułu herdr zamknąłby cykl
 * (`manager → herdr/index → commands/guard → manager`) i wciągnąłby SDK silnika do każdego
 * testu integracji herdr.
 */
export class HerdrPromptRejectedError extends HerdrError {
  override readonly code = 'bad-request';
  override readonly name = 'HerdrPromptRejectedError';
}

/**
 * Odmowa slash-komendy spoza katalogu sesji. `command` to sam pierwszy token (albo słowo wyjścia)
 * — trafia do dziennika (`refuse`, `command-not-allowed`); treść wiadomości nie trafia nigdzie.
 */
export class HerdrCommandRefusedError extends HerdrPromptRejectedError {
  readonly command: string;

  constructor(sentence: AnyText, command: string) {
    super(sentence);
    this.command = command;
  }
}

/**
 * Prefiksy trybów `claude`, których Rarog nie wystawia.
 *
 * `#` (tryb pamięci) tu nie stoi: CLI 2.0.70 usunął ten skrót, więc `#` na początku
 * to dziś zwykły tekst, np. nagłówek markdownu.
 */
export const DENIED_PREFIXES: readonly string[] = ['!'];

/**
 * Dozwolony KSZTAŁT komendy wewnętrznej: slash, nazwa z {@link INTERNAL_SLASH_COMMANDS},
 * jedna wartość bez spacji — albo jedna z {@link INTERNAL_COMMAND_FORMS}.
 *
 * Druga linia obrony po allow-liście modeli w managerze — i ważniejsza, niż wygląda: bez niej
 * flaga `internalCommand` byłaby furtką, przez którą DOWOLNY tekst (np. zdanie z telefonu
 * wysłane przez pomyłkę tą ścieżką) omijałby allow-listę komend. Tak zbudowana komenda nie ma jak
 * nieść ani nowej linii, ani drugiego polecenia.
 */
// Sufiks `[1m]` za wartością (`/model opus[1m]`) — tylko ten, tak jak
// w `MODEL_ID_PATTERN`; nawias nie niesie ani spacji, ani drugiego polecenia.
const INTERNAL_COMMAND_PATTERN = /^\/(?:model|effort)(?: [A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\[1m\])?)?$/;

/**
 * Formy komendy wewnętrznej spoza {@link INTERNAL_COMMAND_PATTERN}, przyjmowane WYŁĄCZNIE w całości: obie formy
 * ultracode z rejestru. Jedna z nich ma dwie wartości (`… off`), więc wzorzec jednej wartości jej nie
 * przepuszcza, a poszerzenie wzorca o drugą wartość przepuściłoby też `/effort high off` czy `/model x off`.
 */
const INTERNAL_COMMAND_FORMS: ReadonlySet<string> = new Set(Object.values(ULTRACODE_COMMANDS));

/*
 * Limity throttle'a mieszkają w `config.ts` (jedyne miejsce, gdzie zapisane są liczby-
 * -bezpieczniki integracji) i są tu re-eksportowane, żeby wołający nie musiał wiedzieć,
 * z którego pliku wziąć wartość.
 */
export { HERDR_SEND_HOURLY_CAP, HERDR_SEND_MIN_INTERVAL_MS };

const HOUR_MS = 60 * 60 * 1000;

interface SendableBase {
  /** Tryb uprawnień panelu odczytany ze stopki (`parseMode` z `herdr/dialogs/screen/`). */
  mode: HerdrMode;
  /** `cwd` panelu — porównywany z `RAROG_YOLO_ROOTS`, nie z `RAROG_PROJECT_ROOTS`. */
  cwd: string;
  yoloRoots: readonly string[];
  /**
   * Wstrzykiwalne rozwiązywanie dowiązań dla bramki yolo (testy na ścieżkach zmyślonych
   * podają tożsamość; produkcja nie podaje nic i dostaje `realpathSync`). Bramka porównuje
   * ścieżki po ROZWIĄZANIU: leksykalne `isInsideAnyRoot` przepuściłoby dowiązanie
   * `<yolo-root>/skrót -> /cudze/repo` jako „w yolo" (ta sama klasa co przy `validateProjectCwd`).
   */
  realPath?: (candidate: string) => string;
  /** `stat` reguły ścieżki w {@link classifySlashText} (testy podstawiają atrapę). */
  exists?: (path: string) => boolean;
  /**
   * Wiadomość niesie załączniki: pusty tekst jest wtedy poprawny, bo prompt złożą
   * `(załącznik)` i ścieżki doklejone PO bramce (`appendAttachmentPaths`). Reszta reguł bez zmian.
   */
  withAttachments?: boolean;
}

/**
 * Opcje bramki. Wolny tekst wymaga katalogu sesji — typ nie pozwala go zapomnieć; ścieżka
 * WEWNĘTRZNA katalogu nie czyta.
 */
export type SendableOptions = SendableBase & (
  | {
    /**
     * Ścieżka WEWNĘTRZNA: tekst nie pochodzi od człowieka, tylko został złożony przez managera
     * (`POST /api/sessions/:id/model`).
     *
     * Przepuszcza DOKŁADNIE `/model` i `/effort` — i tylko wtedy, gdy cały tekst ma kształt komendy
     * z jedną wartością ({@link INTERNAL_COMMAND_PATTERN}) albo jest w całości jedną z form ultracode
     * ({@link INTERNAL_COMMAND_FORMS}). Reszta reguł (rozmiar, prefiks `!`, `bypass` poza `RAROG_YOLO_ROOTS`,
     * sanityzacja) obowiązuje bez zmian: to jest wąska furtka na dwie komendy, a nie tryb „bez strażnika".
     */
    internalCommand: true;
    catalog?: undefined;
  }
  | {
    internalCommand?: false;
    /** Katalog komend sesji: migawka dla `cwd` i wersji CLI panelu (`catalog.ts`). */
    catalog: CommandCatalog;
  }
);

/** Tekst po bramce: to on (a nie oryginał) idzie do `agent.prompt`, z klasyfikacją komendy. */
export interface SendableText {
  readonly text: string;
  /**
   * Komenda z katalogu, którą tekst wywołuje, albo `null` dla zwykłego promptu (i dla ścieżki
   * wewnętrznej, która nie idzie przez `send`). Driver bierze z niej wybór ścieżki wysyłki.
   */
  readonly slash: SlashCommand | null;
}

/** Pierwszy token tekstu (bez argumentów), lowercase — kandydat na komendę wewnętrzną. */
function firstToken(text: string): string {
  const trimmed = text.trimStart();
  const match = /^\S+/.exec(trimmed);
  return (match?.[0] ?? '').toLowerCase();
}

/**
 * Reguły treści: prefiksy i allow-lista slash-komend.
 *
 * Wywoływana DWA razy — na tekście surowym i na tekście po sanityzacji. Powód jest konkretny:
 * `<ESC>!rm -rf …` ma prefiks ESC, więc surowy test prefiksu go przepuszcza, a dopiero
 * sanityzacja odsłania `!` (tak samo `<ESC>/usa`). Bez drugiego przebiegu bramka byłaby do obejścia
 * jednym niewidocznym bajtem.
 *
 * @returns komenda z katalogu albo `null` (prompt, ścieżka wewnętrzna)
 */
function checkContent(text: string, opts: SendableOptions): SlashCommand | null {
  const trimmed = text.trimStart();
  for (const prefix of DENIED_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      throw new HerdrPromptRejectedError(say('commands.prefix-blocked', { prefix }));
    }
  }
  // Ścieżka wewnętrzna przepuszcza WYŁĄCZNIE `/model` i `/effort` (kształt, w tym formy ultracode, sprawdzony
  // wcześniej): `/permissions`, `/hooks` czy `/login` nie mają w Rarogu żadnej drogi i mieć nie będą.
  if (opts.internalCommand === true) {
    if (INTERNAL_SLASH_COMMANDS.has(firstToken(text))) return null;
    throw new HerdrPromptRejectedError(say('commands.not-internal'));
  }
  const result = classifySlashText(
    text, opts.catalog, opts.exists === undefined ? {} : { exists: opts.exists },
  );
  if (result.type === 'refused') throw new HerdrCommandRefusedError(result.message, result.token);
  return slashOf(result);
}

/**
 * Bramka tekstu wysyłanego do panelu.
 *
 * Kolejność sprawdzeń jest częścią kontraktu: najpierw ODRZUCAMY (rozmiar → prefiksy →
 * komenda → tryb), dopiero potem CZYŚCIMY. Odwrotna kolejność znaczyłaby, że sanityzacja
 * po cichu zmienia tekst, który i tak zaraz odrzucimy — a użytkownik ma dostać komunikat
 * o tym, co naprawdę napisał.
 *
 * @returns tekst po sanityzacji — to on, a nie oryginał, idzie do `agent.prompt` — i komenda,
 *   którą wywołuje (klasyfikacja tekstu PO sanityzacji)
 * @throws {HerdrPromptRejectedError} z komunikatem dla użytkownika (router → 400);
 *   {@link HerdrCommandRefusedError} dla komendy spoza katalogu
 */
export function assertSendable(text: string, opts: SendableOptions): SendableText {
  // 1. Rozmiar liczony w BAJTACH: `z.string().max()` liczy znaki, a UTF-8 potrafi dać 4× więcej.
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_HERDR_PROMPT_BYTES) {
    const limitKb = Math.round(MAX_HERDR_PROMPT_BYTES / 1024);
    throw new HerdrPromptRejectedError(say('commands.too-large', { bytes, limitKb }));
  }

  // 1a. Ścieżka wewnętrzna: zanim cokolwiek przepuścimy, sprawdzamy KSZTAŁT.
  //     Tekst spoza wzorca i spoza form ultracode nie jest komendą Raroga, choćby wołający twierdził inaczej.
  if (opts.internalCommand === true && !INTERNAL_COMMAND_PATTERN.test(text) && !INTERNAL_COMMAND_FORMS.has(text)) {
    throw new HerdrPromptRejectedError(say('commands.not-internal'));
  }

  // 2. i 3. Prefiksy i allow-lista slash-komend — odrzucenie JAWNE, nigdy ciche filtrowanie.
  checkContent(text, opts);

  // 4. Tryb panelu. `manual`, `plan` i `auto` przechodzą (blokada
  //    „wszystko poza manual/plan" zablokowałaby 100 % realnych wysyłek).
  // Po realpath, nie po stringach: panel w trybie bypass pod dowiązaniem wskazującym poza
  // yolo-roota to dokładnie ten panel, do którego pisać NIE wolno (patrz `SendableOptions.realPath`).
  const inYolo = opts.realPath === undefined
    ? isInsideAnyRootReal(opts.cwd, opts.yoloRoots)
    : isInsideAnyRootReal(opts.cwd, opts.yoloRoots, opts.realPath);
  if (opts.mode === 'bypass' && !inYolo) {
    throw new HerdrPromptRejectedError(say('commands.bypass-outside-yolo'));
  }

  // 5. Sanityzacja: bracketed paste NIE neutralizuje bajtów sterujących — panel jest terminalem.
  //    Trailing backslashes go too: a backslash right before the Enter makes Claude Code insert a new line instead
  //    of submitting (multiline input, per the documentation), so the message would wait in the field.
  const sanitized = stripTerminalControl(text).replace(/[\s\\]+$/, '');
  if (sanitized === '' && opts.withAttachments !== true) {
    throw new HerdrPromptRejectedError(say('commands.empty'));
  }
  // Sanityzacja mogła odsłonić prefiks albo komendę ukryte za znakiem sterującym. Klasyfikacja
  // tekstu, który naprawdę pójdzie do panelu, jest tą, którą dostaje driver.
  const slash = checkContent(sanitized, opts);
  return { text: sanitized, slash };
}

/** How one send uses the throttle. */
export interface SendSlotOptions {
  /**
   * `false` skips the per-pane interval and counts only toward the hourly cap. A prompt goes this way: the session's
   * send queue keeps prompts in order, so a second prompt sent right after the first waits its turn instead of
   * getting a 429. Commands that drive the pane in the background (`/model`, the mode cycle) keep the interval.
   */
  readonly spaced?: boolean;
}

export interface SendThrottle {
  /**
   * Rezerwuje slot wysyłki dla sesji.
   *
   * @returns `true`, gdy wolno wysłać (slot został ZUŻYTY), `false` przy odrzuceniu (429)
   */
  takeSendSlot(key: string, opts?: SendSlotOptions): boolean;
}

export interface SendThrottleOptions {
  now?: () => number;
  minIntervalMs?: number;
  hourlyCap?: number;
}

/**
 * Throttle wysyłek — stan trzymany w instancji, nie w module.
 *
 * Fabryka zamiast globalnej mapy, bo globalna mapa przeciekałaby między testami i między
 * konfiguracjami w jednym procesie, a zegar musi być wstrzykiwalny (inaczej test sufitu
 * godzinnego trwa godzinę).
 */
export function createSendThrottle(opts: SendThrottleOptions = {}): SendThrottle {
  const now = opts.now ?? ((): number => Date.now());
  const minIntervalMs = opts.minIntervalMs ?? HERDR_SEND_MIN_INTERVAL_MS;
  const hourlyCap = opts.hourlyCap ?? HERDR_SEND_HOURLY_CAP;
  const lastByKey = new Map<string, number>();
  let recent: number[] = [];

  return {
    takeSendSlot(key: string, slot: SendSlotOptions = {}): boolean {
      const at = now();
      const last = lastByKey.get(key);
      if (slot.spaced !== false && last !== undefined && at - last < minIntervalMs) return false;
      recent = recent.filter((ts) => at - ts < HOUR_MS);
      if (recent.length >= hourlyCap) return false;
      lastByKey.set(key, at);
      recent.push(at);
      return true;
    },
  };
}
