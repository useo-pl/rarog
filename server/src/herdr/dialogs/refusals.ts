/**
 * Zrzut diagnostyczny odmowy — jedyny ślad po dialogu, którego Rarog nie umiał obsłużyć (`docs/dialogs.md`, „Refusal diagnostics”).
 *
 * Po co: dziennik (`herdr-audit.log`) niesie sam `reason`, więc bez zrzutu odmowa `multi-select`
 * przy obecnym zrzucie hooka zostaje niewyjaśniona — ekran
 * z tamtej chwili przepada. Bez tekstu ekranu każda nieznana sygnatura kosztuje dzień
 * odtwarzania na żywym panelu zamiast minuty czytania pliku.
 *
 * Drugi pisarz to cykl kanału zgód (`layer1/cycle.ts`): karta bez dowodu, której linia logu dowodu mówi
 * `top=bash-zone(unlisted=…)`, `top=edit-zone` albo `top=bottom` (wygląd CLI spoza zamkniętej listy Raroga), zostawia
 * ekran dowodu raz na kartę, z powodem `top-<człon>` i kluczem karty. Tekst tej linii może napisać agent, więc do
 * `server.log` idą tylko liczby, a treść wyłącznie tutaj.
 *
 * Czego tu NIE MA i mieć nie będzie: `toolInput` (komendy `Bash`, treść `Write`, plany —
 * to jest w `pending/` i tam ma zostać). Ze zrzutu hooka bierzemy wyłącznie METADANE:
 * które zdarzenie, kiedy, jakie narzędzie, a w kształcie przypadku także
 * identyfikatory tury i subagenta (`promptId`, `agentId`).
 *
 * Ryzyko jest to samo, co przy `pending/`: TEKST EKRANU niesie dosłownie to, co widać
 * w terminalu — komendę z dialogu zgody razem z wartościami w linii. Dlatego pliki są `0600`,
 * katalog `0700`, retencja i sufit plików jak niżej, a wyłącznik `RAROG_REFUSAL_DUMPS=0` gasi
 * zapis w całości (`docs/security-model.md`).
 *
 * Retention: 48 h and at most 200 files. A dump of a CLI dialog of registry class `dialog` (layer 2: picker, slash
 * command view, model confirmation) lives 14 days, at most 500 files, and its name ends with `.dialog.txt`: such a
 * screen carries no tool input, and the dumps grow the layer-2 corpus. The class alone does not earn it: the dump must
 * show no trace of a consent ({@link isLayer2Dump}). The sweeper caps the two kinds separately, so a burst of one
 * never evicts the other.
 *
 * Zapis jest BEST-EFFORT w każdym calu: brak miejsca, brak praw, wyścig o nazwę — wszystko
 * kończy się cicho. Odmowa decyzji ma dojść do człowieka nawet wtedy, gdy dysk jest pełny.
 */
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CliDialogClass } from '@rarog/shared';
import { auditShapeFields } from '../audit.ts';
import type { AuditCaseShape } from '../audit.ts';
import { SCREEN_DIALOG_TOOL } from './cards/build.ts';
import { dialogKind } from './screen/kinds.ts';
import { parseOptions } from './screen/parse.ts';
import { isReviewDialog } from './screen/review.ts';
import { stripTerminalControl } from './screen/text.ts';

/** Podkatalog `dataDir` ze zrzutami odmów — obok `pending/`, z tą samą ochroną. */
export const REFUSAL_DUMP_DIRNAME = 'refusals';

/** Po ilu godzinach zrzut przestaje być dowodem, a zaczyna być składem tekstu z ekranu. */
export const REFUSAL_DUMP_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * Sufit liczby plików — drugi bezpiecznik obok retencji.
 *
 * Sama retencja nie wystarcza: pętla odmów (dialog, którego Rarog nie rozpoznaje, oceniany
 * co 4 s) potrafi w jedno popołudnie nasypać tysiące plików mieszczących się w 48 h.
 */
export const REFUSAL_DUMP_MAX_FILES = 200;

/**
 * Retention of a layer-2 dialog dump (class `dialog`). Only this class gets it: a consent dialog screen
 * (`permission`, `sandbox`) holds commands with their values, so its retention stays at {@link REFUSAL_DUMP_TTL_MS}.
 */
export const REFUSAL_DUMP_DIALOG_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** File cap of layer-2 dialog dumps, counted apart from {@link REFUSAL_DUMP_MAX_FILES}. */
export const REFUSAL_DUMP_DIALOG_MAX_FILES = 500;

/**
 * Name ending of a layer-2 dialog dump (`<ts>-<reason>.dialog.txt`). No other name the dumper writes has a dot before
 * `.txt` (`stampFor`, `safeReason` and `keyTail` drop dots), so neither a reason nor a card key can produce it.
 */
export const REFUSAL_DUMP_DIALOG_SUFFIX = '.dialog.txt';

/** Registry class whose dumps get the longer retention. */
const DIALOG_CLASS: CliDialogClass = 'dialog';

/** Prawa pliku i katalogu: treść ekranu czyta wyłącznie właściciel procesu. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * Licznik nazw tymczasowych — dwie odmowy w tej samej milisekundzie (dwa panele naraz) nie
 * mogą pisać do jednego pliku roboczego. Docelowa nazwa zostaje wg `docs/dialogs.md`, „Refusal diagnostics” (`<ts>-<reason>.txt`, przy kluczu karty
 * `<ts>-<reason>-<końcówka klucza>.txt`),
 * więc taka para nadpisuje się nawzajem; to zrzut diagnostyczny, nie dziennik.
 */
let seq = 0;

/** Metadane zrzutu hooka — bez `toolInput`, świadomie (patrz nagłówek modułu). */
export interface RefusalHookMeta {
  readonly toolName: string;
  /** Epoch ms zapisu przez hook. */
  readonly at: number;
  /** `PermissionRequest` albo `PreToolUse`; starsze zrzuty pola nie mają. */
  readonly hookEventName?: string;
}

/** Co Rarog wiedział w chwili odmowy. */
export interface RefusalDump {
  /** Powód z zamkniętej listy (`HerdrRefuseReason`) — wchodzi też do nazwy pliku. */
  readonly reason: string;
  /** Narzędzie z karty, jeśli Rarog je znał. */
  readonly toolName?: string | undefined;
  /** Sesja Raroga — żeby zrzut dało się zestawić z wpisem w `herdr-audit.log`. */
  readonly sessionId?: string | undefined;
  /** Ostatnio przeczytany ekran panelu; `null` = odczyt się nie udał. */
  readonly screen: string | null;
  /** Metadane stojącego zrzutu hooka albo `null` (hook niezainstalowany, plik stęchły). */
  readonly hook: RefusalHookMeta | null;
  /** Czekające narzędzie z jsonl albo `null` (dialog spoza transkryptu). */
  readonly jsonl: { readonly id: string; readonly toolName: string } | null;
  /**
   * Kształt przypadku — te same pola i ta sama walidacja co we wpisie dziennika (`auditShapeFields`),
   * żeby zrzut i wpis dało się zestawić po `reqId` i czasie.
   */
  readonly shape?: AuditCaseShape | undefined;
  /** Klasa dialogu z rejestru CLI (jak `cliDialog` we wpisie dziennika). */
  readonly cliDialog?: string | undefined;
  /**
   * Czas zdarzenia (epoch ms) — nazwa pliku i nagłówek. Odmowa `degrade` czeka na geometrię panelu,
   * więc zapis przychodzi później niż zdarzenie; brak pola = zegar zapisywacza.
   */
  readonly at?: number | undefined;
  /**
   * Klucz karty kanału zgód (zrzut nieznanego elementu wierzchu z cyklu, `layer1/cycle.ts`): nagłówek `key:`, a jego
   * ostatnie 12 znaków idzie do nazwy pliku, bo dwie karty pod jednym odczytem ekranu mają ten sam czas i powód.
   */
  readonly key?: string | undefined;
  /** Człony linii logu dowodu tej karty (`consent: proof of key … missing: <człony>`): nagłówek `proof:`. */
  readonly proof?: string | undefined;
}

/** Zapisywacz zrzutów: albo pisze, albo jest wydmuszką (wyłącznik) — wołający nie sprawdza. */
export type RefusalDumper = (dump: RefusalDump) => void;

export interface RefusalDumperOptions {
  readonly dataDir: string;
  /** Wersja Raroga do nagłówka pliku — po aktualizacji CLI ważne jest, KTÓRY Rarog nie umiał. */
  readonly version: string;
  /** `RAROG_REFUSAL_DUMPS` ≠ `0`. `false` = funkcja nie tyka dysku ani razu. */
  readonly enabled: boolean;
  readonly now?: () => number;
}

/**
 * Znacznik czasu w nazwie pliku: ISO bez znaków, które psują ścieżkę.
 *
 * `:` na macOS jest przy POSIX-ie legalne, ale Finder pokazuje je jako `/`, a `scp` na inny
 * system potrafi się o nie wywrócić — nazwa pliku diagnostycznego ma się dać przekopiować
 * bez cudzysłowów. Sortowanie leksykalne zostaje (to wciąż ISO od najstarszego pola).
 */
function stampFor(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, '-');
}

/** Powód w nazwie pliku — unia jest zamknięta, ale nazwa pliku nie jest miejscem na zaufanie. */
function safeReason(reason: string): string {
  const slug = reason.replace(/[^a-z0-9-]/gi, '').slice(0, 32);
  return slug === '' ? 'nieznany' : slug;
}

/** Końcówka klucza karty w nazwie pliku: ostatnie 12 liter i cyfr, `''` bez klucza. */
function keyTail(key: string | undefined): string {
  const tail = key === undefined ? '' : key.replace(/[^a-z0-9]/gi, '').slice(-12);
  return tail === '' ? '' : `-${tail}`;
}

/** Treść pliku: nagłówek `klucz: wartość`, potem ekran w całości. */
function renderDump(dump: RefusalDump, version: string, at: number): string {
  const hook = dump.hook === null
    ? 'brak'
    : `${dump.hook.hookEventName ?? '?'} ${dump.hook.toolName}`
      + ` at=${new Date(dump.hook.at).toISOString()}`;
  const jsonl = dump.jsonl === null ? 'brak' : `${dump.jsonl.toolName} id=${dump.jsonl.id}`;
  const shape = Object.entries(auditShapeFields(dump.shape ?? {}))
    .map(([key, value]) => `${key}: ${value === null ? 'brak' : String(value)}`);
  return [
    `rarog: ${version}`,
    `at: ${new Date(at).toISOString()}`,
    `reason: ${dump.reason}`,
    `toolName: ${dump.toolName ?? 'brak'}`,
    `sessionId: ${dump.sessionId ?? 'brak'}`,
    ...(dump.key === undefined ? [] : [`key: ${dump.key}`]),
    ...(dump.proof === undefined ? [] : [`proof: ${dump.proof}`]),
    `hook: ${hook}`,
    `jsonl: ${jsonl}`,
    ...(dump.cliDialog === undefined ? [] : [`cliDialog: ${dump.cliDialog}`]),
    ...shape,
    '--- ekran ---',
    dump.screen ?? '(ekranu nie udało się przeczytać)',
    '',
  ].join('\n');
}

/** A tool name that only a screen card carries (`dialog`, `dialog:<kind>`, the layer-2 card's `dialog:layer2`). */
function screenCardTool(toolName: string): boolean {
  return toolName === SCREEN_DIALOG_TOOL || toolName.startsWith(`${SCREEN_DIALOG_TOOL}:`);
}

/**
 * Does the screen show a consent or a question dialog? The footer markers of a tool consent or a question form anywhere
 * in the text, or a parsed dialog of kind `tool` or `question`, with a tool name, or the answer review of a form.
 */
function screenShowsConsent(screen: string): boolean {
  if (dialogKind(stripTerminalControl(screen).toLowerCase()) !== 'other') return true;
  const dialog = parseOptions(screen);
  if (dialog === null) return false;
  return dialog.kind === 'tool' || dialog.kind === 'question' || dialog.toolName !== null || isReviewDialog(dialog);
}

/**
 * Does this dump earn the layer-2 retention ({@link REFUSAL_DUMP_DIALOG_TTL_MS})? Only when the dump itself shows
 * nothing of a consent: registry class `dialog`, no tool context (no tool name but a screen card's, no hook dump, no
 * jsonl entry, no tool identifiers in the case shape) and a screen without a consent or question dialog. The class
 * alone is not enough: the registry can say `dialog` while the last screen read still shows a consent dialog and the
 * card is still a tool's. Fail closed: no screen, a parser error or any doubt keeps the 48 h rule.
 */
function isLayer2Dump(dump: RefusalDump): boolean {
  if (dump.cliDialog !== DIALOG_CLASS || dump.hook !== null || dump.jsonl !== null || dump.screen === null) {
    return false;
  }
  if (dump.toolName !== undefined && !screenCardTool(dump.toolName)) return false;
  const shape = dump.shape ?? {};
  if ((shape.source !== undefined && shape.source !== 'screen') || shape.toolUseId !== undefined
    || shape.promptId !== undefined || shape.agentId !== undefined) {
    return false;
  }
  try {
    return !screenShowsConsent(dump.screen);
  } catch {
    return false;
  }
}

/** Is this file a layer-2 dialog dump? Decided by name alone, so the sweeper never reads screen text. */
function isDialogDump(name: string): boolean {
  return name.endsWith(REFUSAL_DUMP_DIALOG_SUFFIX);
}

/**
 * ŻNIWIARZ katalogu zrzutów — retencja ORAZ sufit liczby plików.
 *
 * Each kind is swept on its own: layer-2 dialog dumps ({@link REFUSAL_DUMP_DIALOG_TTL_MS},
 * {@link REFUSAL_DUMP_DIALOG_MAX_FILES}) and every other `.txt` dump ({@link REFUSAL_DUMP_TTL_MS},
 * {@link REFUSAL_DUMP_MAX_FILES}), so a burst of one kind never evicts files of the other. The name decides: a `.txt`
 * dump without the marker gets 48 h whatever its header says, so no dump escapes both rules.
 *
 * Wołany przy starcie serwera i po KAŻDYM zapisie (inaczej sufit trzymałby dopiero następny
 * start, a właśnie pętla odmów jest scenariuszem, dla którego sufit istnieje). Wiek liczymy
 * z `mtime`, nie z nazwy: plik z ręcznie zmienioną nazwą też ma zniknąć.
 *
 * Każdy błąd jest połykany per plik — sprzątanie nie ma prawa wywrócić ani startu serwera,
 * ani obsługi odmowy (wzór: `sweepPendingHooks`).
 *
 * @returns liczba skasowanych plików (do logu startu)
 */
export function sweepRefusalDumps(dataDir: string, now: () => number = Date.now): number {
  const dir = join(dataDir, REFUSAL_DUMP_DIRNAME);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // Katalogu nie ma — jeszcze ani jednej odmowy albo `dataDir` dopiero powstaje.
    return 0;
  }
  const at = now();
  const dumps = names.filter((name) => name.endsWith('.txt'));
  const dialog = dumps.filter(isDialogDump);
  const other = dumps.filter((name) => !isDialogDump(name));
  return sweepKind(dir, dialog, at, REFUSAL_DUMP_DIALOG_TTL_MS, REFUSAL_DUMP_DIALOG_MAX_FILES)
    + sweepKind(dir, other, at, REFUSAL_DUMP_TTL_MS, REFUSAL_DUMP_MAX_FILES);
}

/** Retention and cap over the files of one kind; returns the number of files removed. */
function sweepKind(dir: string, names: readonly string[], at: number, ttlMs: number, maxFiles: number): number {
  let removed = 0;
  const alive: { path: string; mtimeMs: number }[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const { mtimeMs } = statSync(path);
      if (at - mtimeMs > ttlMs) {
        unlinkSync(path);
        removed += 1;
        continue;
      }
      alive.push({ path, mtimeMs });
    } catch {
      // Znikający plik / brak praw — następny obrót spróbuje jeszcze raz.
    }
  }
  if (alive.length <= maxFiles) return removed;
  // Ponad sufit ginie NAJSTARSZE: świeży zrzut opisuje awarię, którą ktoś właśnie zgłasza.
  alive.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of alive.slice(0, alive.length - maxFiles)) {
    try {
      unlinkSync(entry.path);
      removed += 1;
    } catch {
      // jw.
    }
  }
  return removed;
}

/**
 * Buduje zapisywacz zrzutów. Wyłącznik jest TUTAJ, a nie u wołającego: driver ma jedną
 * ścieżkę odmowy i nie powinien wiedzieć, czy diagnostyka jest włączona.
 */
export function createRefusalDumper(opts: RefusalDumperOptions): RefusalDumper {
  if (!opts.enabled) return () => { /* RAROG_REFUSAL_DUMPS=0 — dysku nie tykamy */ };
  const now = opts.now ?? Date.now;
  return (dump: RefusalDump): void => {
    const dir = join(opts.dataDir, REFUSAL_DUMP_DIRNAME);
    const at = dump.at ?? now();
    try {
      mkdirSync(dir, { recursive: true, mode: DIR_MODE });
      const ending = isLayer2Dump(dump) ? REFUSAL_DUMP_DIALOG_SUFFIX : '.txt';
      const path = join(dir, `${stampFor(at)}-${safeReason(dump.reason)}${keyTail(dump.key)}${ending}`);
      /*
       * Zapis atomowy: plik tymczasowy z prawami OD RAZU (`mode` w `writeFileSync` działa
       * tylko przy tworzeniu) i `rename(2)`. Czytelnik nigdy nie zobaczy połowy ekranu,
       * a plik nigdy nie istnieje z prawami szerszymi niż `0600`.
       */
      seq += 1;
      const tmp = `${path}.${String(process.pid)}-${String(seq)}.tmp`;
      writeFileSync(tmp, renderDump(dump, opts.version, at), { mode: FILE_MODE });
      renameSync(tmp, path);
    } catch {
      // Brak miejsca / brak praw — odmowa i tak dojdzie do człowieka. Diagnostyka milczy.
      return;
    }
    try {
      sweepRefusalDumps(opts.dataDir, now);
    } catch {
      // jw. — sufit dogoni przy następnym zapisie albo przy starcie.
    }
  };
}
