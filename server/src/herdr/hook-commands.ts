/**
 * Komendy Raroga w ustawieniach Claude Code: JEDNA definicja tego, co Rarog wpisuje do `~/.claude/settings.json`
 * (hook zgód, hook kontekstu, `statusLine`, wszystkie z kopii; obok nich ścieżki
 * `sandbox.filesystem.denyRead`, {@link denyReadPaths}, and the write block rules in `permissions.deny`,
 * {@link writeBlockRules}). Czytają z niej wydruk bloków
 * (`rarog hooks print|statusline`, `rarog setup`, notatki `rarog service uninstall`), doctor i `/health`
 * (porównanie zainstalowanych wpisów z oczekiwanymi, `hook-config.ts`) oraz pisarz ustawień.
 *
 * Trzy części:
 * - bieżące komendy ({@link hookCommand}, {@link contextHookCommand}, {@link statuslineCommand}) i ścieżki, które
 *   wskazują;
 * - wpisy, które MAJĄ stać w ustawieniach ({@link expectedHookEntries}, {@link expectedContextEntry}), i bloki do
 *   wydruku zbudowane z tych samych wpisów, więc wydruk i doctor nie mogą się rozjechać;
 * - zamknięta lista postaci historycznych ({@link HISTORICAL_COMMANDS}): komendy, które Rarog kiedyś drukował do
 *   wklejenia, a dziś drukuje inną. Każda to wzorzec na CAŁY napis, z datami wydruku i decyzją.
 *
 * Rozpoznanie diagnostyczne zostaje w `hook-config.ts` (`rarogHookEntries`): tam wpisem Raroga jest każda komenda ze
 * ścieżką kopii, także taka, której Rarog nigdy nie drukował. Usuwać wolno wyłącznie komendę bieżącą albo pasującą
 * do postaci historycznej; komenda z dopiskiem (`…; curl …`) albo inna komenda z fragmentem ścieżki kopii nie pasuje
 * do żadnej.
 *
 * Moduł nie ma I/O i nie czyta środowiska procesu: katalog domowy przychodzi argumentem. Stara nazwa produktu stoi
 * tu wyłącznie w liniach ze znacznikiem `stara-nazwa` (dwie stałe niżej).
 */
import { join, posix } from 'node:path';

/** Katalog źródeł hooka względem korzenia repo — z niego `hooks:install` robi kopię. */
export const HOOK_SOURCE_DIR_REL = 'scripts/hooks';

/** Plik wejściowy hooka (ten, który woła komenda w ustawieniach). */
export const HOOK_ENTRY_FILE = 'rarog-pending.mjs';

/**
 * Ścieżka skryptu hooka względem korzenia repo — ŹRÓDŁO kopii. Komenda wskazująca ją wprost to stary
 * układ instalacji: doctor rozpoznaje go jako `mismatch` z powodem „wskazuje checkout repo”.
 */
export const HOOK_SCRIPT_REL = `${HOOK_SOURCE_DIR_REL}/${HOOK_ENTRY_FILE}`;

/**
 * Katalog kopii hooka względem katalogu domowego. MUSI leżeć pod `~/.claude/hooks/`: Claude Code chroni
 * `~/.claude/hooks` przed zapisem z sandboksa, a nowy katalog na szczycie `~/.claude` już nie (pomiar na
 * CLI 2.1.311: `mkdir ~/.claude/<nowy>` przeszedł, `mkdir ~/.claude/hooks/<nowy>` — odmowa).
 */
export const HOOK_INSTALL_DIR_REL = '.claude/hooks/rarog';

/** Plik wejściowy kopii względem katalogu domowego — po nim doctor rozpoznaje wpis kopii. */
export const HOOK_INSTALLED_SCRIPT_REL = `${HOOK_INSTALL_DIR_REL}/${HOOK_ENTRY_FILE}`;

/**
 * Hook kontekstu `SessionStart`: w panelu herdr pod korzeniami Raroga podaje modelowi format znacznika pytania
 * („Do Ciebie”). Leży w tej samej kopii (`HOOK_INSTALL_FILES` w `hook-config.ts`), ale jego wpis
 * w ustawieniach ma WŁASNY stan (`inspectContextHook`): do {@link expectedHookEntries} i pola `hook` w `/health` nie
 * wchodzi, a `rarogHookEntries` go pomija, więc instalacja bez tego wpisu dalej jest `ok`.
 */
export const CONTEXT_HOOK_FILE = 'rarog-context.mjs';

/** Zdarzenie hooka kontekstu. */
export const CONTEXT_HOOK_EVENT = 'SessionStart';

/** Hook kontekstu w kopii względem katalogu domowego — po nim rozpoznajemy jego wpis w ustawieniach. */
export const CONTEXT_INSTALLED_SCRIPT_REL = `${HOOK_INSTALL_DIR_REL}/${CONTEXT_HOOK_FILE}`;

/** Hook kontekstu w checkoucie repo: wpis, który go wskazuje, to `mismatch` z powodem (jak przy hooku zgód). */
export const CONTEXT_SCRIPT_REL = `${HOOK_SOURCE_DIR_REL}/${CONTEXT_HOOK_FILE}`;

/**
 * Skrypt `statusLine` Raroga: zrzuca payload paska statusu do `~/.claude/statusline/<sesja>.json`. Leży obok
 * hooka i trafia do tej samej kopii, bo Claude Code wykonuje komendę paska statusu poza sandboksem przy każdym
 * renderze. Osobna lista i osobny stan (`statuslineCopyReport` w `hook-config.ts`): stan hooka (`hookCopyReport`,
 * pole `hook` w `/health`, linie hooka w doctorach) liczy WYŁĄCZNIE `HOOK_INSTALL_FILES`, więc kopia bez tego
 * skryptu nie zmienia `hook: ok` u kogoś, kto ma własny skrypt paska statusu.
 */
export const STATUSLINE_ENTRY_FILE = 'rarog-statusline.mjs';

/** Skrypt `statusLine` w kopii względem katalogu domowego — po nim doctor rozpoznaje komendę wskazującą kopię. */
export const STATUSLINE_INSTALLED_SCRIPT_REL = `${HOOK_INSTALL_DIR_REL}/${STATUSLINE_ENTRY_FILE}`;

/**
 * Zmienna łańcucha: komenda, którą skrypt `statusLine` uruchamia po zrzucie (`sh -c`, ten sam payload na stdin).
 * To nie zmienna serwera: stoi tylko w komendzie `statusLine` i czyta ją wyłącznie skrypt w kopii, więc nie ma jej
 * w rejestrze `config-env.ts` (ten trzyma nazwy, które czyta serwer; strażnik `env-registry.test.ts`).
 */
const STATUSLINE_CHAIN_VAR = 'RAROG_STATUSLINE_CHAIN';

/**
 * Sufit czasu hooka W SEKUNDACH dla zdarzeń, w których hook wyłącznie ZRZUCA i kończy.
 *
 * Domyślne 600 s zamieniłoby zawieszony hook (dysk w NFS, `realpath` na znikającym woluminie)
 * w dziesięciominutowy zwis sesji przed dialogiem. Ta ścieżka kończy się w milisekundach —
 * 5 s to margines na zimny start node, nie na pracę.
 */
export const HOOK_TIMEOUT_S = 5;

/**
 * Sufit czasu hooka `PermissionRequest` — doba, bo TEN hook CZEKA.
 *
 * Hook czeka na decyzję z telefonu: przy `AskUserQuestion` na plik `<dataDir>/answers/…` (kanał odpowiedzi), w kanale
 * zgód na podpisany plik decyzji. Dialog stoi przy biurku tak długo, jak człowiek go nie rozstrzygnie, a karta na
 * telefonie ma przycisk tak długo, jak hook żyje. Phone decisions also come after a night: an answer
 * after more than an hour, and after about 8 h, is normal use, so the ceiling counts in hours, not in quarters.
 *
 * 86 400 s jest ZMIERZONE, nie założone: CLI przyjmuje `timeout` 86 400 s, a `allow` hooka po ponad 3600 s czekania
 * zadziałało (zmierzone na CLI 2.1.311 i 2.1.314). Koszt: jeden śpiący proces node na każdą stojącą prośbę, której
 * nikt nie zwolnił (proces pytania rozstrzygniętego przy biurku śpi do nadpisania zrzutu albo do sufitu).
 *
 * Zwis TEGO hooka nie blokuje człowieka przy biurku: dialog przyjmuje klawisze przez cały czas snu hooka, a po jego
 * zabiciu stoi dalej.
 */
export const HOOK_ANSWER_TIMEOUT_S = 86_400;

/**
 * Ile hook czeka na plik odpowiedzi — sufit rejestracji MINUS 2 s na zwinięcie procesu.
 *
 * Jedzie do hooka ARGUMENTEM (`--answer-wait=…`), a nie stałą w skrypcie: dzięki temu doctor
 * porównuje jedną komendę i stary blok w ustawieniach widać jako `mismatch`, zamiast pozwalać
 * skryptowi czekać dłużej, niż pozwala mu rejestracja (CLI zabija go wtedy w ciszy).
 */
export const HOOK_ANSWER_WAIT_S = HOOK_ANSWER_TIMEOUT_S - 2;

/** Jedyne narzędzie, dla którego bierzemy `PreToolUse` (treść pytania; hook nie czeka). */
export const HOOK_QUESTION_MATCHER = 'AskUserQuestion';

/** Zdarzenie, które odpala się dopiero, gdy dialog zgody REALNIE stanie na ekranie. */
export const HOOK_PERMISSION_EVENT = 'PermissionRequest';

/** Jeden wpis hooka sprowadzony do porównywalnej postaci. */
export interface HookEntry {
  readonly event: string;
  /** `null` = wpis bez matchera (dla `PermissionRequest` tak ma być). */
  readonly matcher: string | null;
  readonly type: string;
  readonly command: string;
  /** `null` = brak jawnego `timeout` w pliku, czyli silnikowe 600 s. */
  readonly timeout: number | null;
}

/** Napis jako jeden argument powłoki: apostrofy, a apostrof w środku jako `'\''` (POSIX). */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * Komenda hooka: `node '<home>/.claude/hooks/rarog/rarog-pending.mjs' --answer-wait=86398`.
 *
 * Wskazuje KOPIĘ, nigdy checkout: kod z checkoutu agent w sandboksie może zmienić, a Claude Code wykonuje go poza
 * sandboksem. Ścieżka w apostrofach, jak hook herdr w tym samym pliku ustawień (docs hooków zalecają cytowanie
 * w formie powłoki); apostrof w ścieżce domu jest cytowany regułą POSIX, więc komenda zawsze jest jednym
 * argumentem.
 *
 * `node` bierzemy Z PATH, a nie z konkretnej wersji nvm: ścieżka
 * `~/.config/nvm/versions/node/v22.x/bin/node` przestaje istnieć przy pierwszym `nvm install`,
 * a blok w ustawieniach nikt wtedy nie poprawia. PATH sesji Claude Code w panelu herdr to PATH
 * serwera herdr (na Linuksie pod systemd: `Environment=PATH` jednostki z `rarog setup`, z katalogiem
 * węzła) uzupełniony przez plik startowy powłoki panelu (np. nvm) — to założenie Raroga, bo sam
 * `claude` node'a nie potrzebuje (docs `setup.md`,
 * „Install with npm”: zainstalowany plik wykonywalny nie woła Node; changelog 2.1.113: natywny
 * plik wykonywalny zamiast JavaScriptu), więc działający `claude` nie dowodzi, że `node` jest
 * w PATH. Gdyby zawiódł, widać to po `hookSeenAgo` w `/health`, nie po ciszy.
 */
export function hookCommand(home: string): string {
  const script = join(home, HOOK_INSTALLED_SCRIPT_REL);
  return `node ${shellQuote(script)} --answer-wait=${String(HOOK_ANSWER_WAIT_S)}`;
}

/**
 * Komenda `statusLine`: `node '<home>/.claude/hooks/rarog/rarog-statusline.mjs'`, z łańcuchem
 * `RAROG_STATUSLINE_CHAIN='<komenda>' node '…'`. Wskazuje kopię, jak {@link hookCommand}; cytowanie POSIX.
 */
export function statuslineCommand(home: string, chain?: string): string {
  const script = `node ${shellQuote(join(home, STATUSLINE_INSTALLED_SCRIPT_REL))}`;
  return chain === undefined || chain.trim() === '' ? script : `${STATUSLINE_CHAIN_VAR}=${shellQuote(chain)} ${script}`;
}

/** Komenda hooka kontekstu: `node '<home>/.claude/hooks/rarog/rarog-context.mjs'` (kopia, cytowanie POSIX). */
export function contextHookCommand(home: string): string {
  return `node ${shellQuote(join(home, CONTEXT_INSTALLED_SCRIPT_REL))}`;
}

/** Wpisy, które MAJĄ stać w ustawieniach — jedyna definicja „poprawnej instalacji". */
export function expectedHookEntries(command: string): readonly HookEntry[] {
  return [
    {
      // Bez matchera: `PermissionRequest` ma dotyczyć KAŻDEGO dialogu zgody, także
      // `ExitPlanMode` (payload niesie wtedy pełną treść planu).
      event: HOOK_PERMISSION_EVENT, matcher: null, type: 'command', command,
      // Dłuższy sufit WYŁĄCZNIE tutaj: to jedyne zdarzenie, w którym hook czeka na odpowiedź.
      timeout: HOOK_ANSWER_TIMEOUT_S,
    },
    {
      event: 'PreToolUse', matcher: HOOK_QUESTION_MATCHER, type: 'command', command,
      timeout: HOOK_TIMEOUT_S,
    },
  ];
}

/**
 * Jedyny poprawny wpis hooka kontekstu: `SessionStart` bez matchera (każde źródło: `startup`, `resume`, `clear`,
 * `compact`, `fork`) i sufit {@link HOOK_TIMEOUT_S}, bo hook tylko czyta `roots.json` i wypisuje tekst.
 */
export function expectedContextEntry(command: string): HookEntry {
  return { event: CONTEXT_HOOK_EVENT, matcher: null, type: 'command', command, timeout: HOOK_TIMEOUT_S };
}

/**
 * Grupa ustawień z jednego wpisu: `{matcher?, hooks: [{type, command, timeout}]}`, w kolejności kluczy, którą
 * drukują bloki (matcher przed `hooks`, brak klucza przy wpisie bez matchera). Ten sam kształt dopisuje pisarz
 * ustawień (`server/src/cli/claude-settings.ts`), więc wydruk i zapis nie mogą się rozjechać.
 */
export function entryGroup(entry: HookEntry): unknown {
  const hook = { type: entry.type, command: entry.command, timeout: entry.timeout };
  return entry.matcher === null ? { hooks: [hook] } : { matcher: entry.matcher, hooks: [hook] };
}

/** Blok do wklejenia — dokładnie to, co porównuje doctor: grupy z {@link expectedHookEntries}, po jednej na zdarzenie. */
export function hookBlock(command: string): unknown {
  const hooks: Record<string, unknown[]> = {};
  for (const entry of expectedHookEntries(command)) (hooks[entry.event] ??= []).push(entryGroup(entry));
  return { hooks };
}

/** Blok jako tekst do wklejenia (2 spacje wcięcia, tak jak w plikach ustawień). */
export function renderHookBlock(command: string): string {
  return JSON.stringify(hookBlock(command), null, 2);
}

/** Grupy `SessionStart` hooka kontekstu do wklejenia (wydruk obok zapisu przez `rarog setup`). */
function contextHookGroups(command: string): unknown[] {
  return [entryGroup(expectedContextEntry(command))];
}

/** Sam blok hooka kontekstu (`hooks.SessionStart`), np. gdy blok zgód już stoi w ustawieniach. */
export function contextHookBlock(command: string): unknown {
  return { hooks: { [CONTEXT_HOOK_EVENT]: contextHookGroups(command) } };
}

/** Blok `hooks:print`: blok zgód ({@link hookBlock}) i hook kontekstu w jednym obiekcie `hooks`. */
export function pasteHookBlock(command: string, contextCommand: string): unknown {
  const base = hookBlock(command) as { hooks: Record<string, unknown> };
  return { hooks: { ...base.hooks, [CONTEXT_HOOK_EVENT]: contextHookGroups(contextCommand) } };
}

/** {@link pasteHookBlock} jako tekst (2 spacje wcięcia). */
export function renderPasteHookBlock(command: string, contextCommand: string): string {
  return JSON.stringify(pasteHookBlock(command, contextCommand), null, 2);
}

/** {@link contextHookBlock} jako tekst (2 spacje wcięcia). */
export function renderContextHookBlock(command: string): string {
  return JSON.stringify(contextHookBlock(command), null, 2);
}

/** Blok `statusLine` do wklejenia: ten sam obiekt dopisuje pisarz ustawień przy braku klucza. */
export function statuslineBlock(command: string): unknown {
  return { statusLine: { type: 'command', command } };
}

/** Blok `statusLine` jako tekst (2 spacje wcięcia, jak {@link renderHookBlock}). */
export function renderStatuslineBlock(command: string): string {
  return JSON.stringify(statuslineBlock(command), null, 2);
}

/** Katalog sekretów Raroga w zapisie z tyldą, jak w bloku `denyRead` (Claude Code rozwija `~/` w ścieżkach sandboksa). */
const DENY_READ_SECRET_DIR = '~/.config/rarog/secret';

/**
 * Ścieżki, które Rarog dopisuje do `sandbox.filesystem.denyRead` (krok 8 `rarog setup`): katalog sekretów
 * i katalog gniazda admina `<dataDir>/run`. Sesja agenta w sandboksie nie czyta wtedy ani sekretów, ani gniazda.
 */
export function denyReadPaths(dataDir: string): readonly string[] {
  return [DENY_READ_SECRET_DIR, join(dataDir, 'run')];
}

/** Blok `sandbox.filesystem.denyRead` do wklejenia (wydruk `rarog setup` po „n”, konflikcie albo odmowie). */
export function denyReadBlock(dataDir: string): unknown {
  return { sandbox: { filesystem: { denyRead: [...denyReadPaths(dataDir)] } } };
}

/**
 * Characters that make a path unusable in a permission rule: the gitignore pattern syntax of `Read` and `Edit` rules
 * (`*`, `?`, `[`, `]`, `{`, `}`, `!`, `#`, `\`), the parentheses of the rule notation, and control characters.
 */
const RULE_UNSAFE = /[*?[\]{}!#\\()\p{Cc}]/u;

/**
 * The write block: the `Edit` deny rules for the data directory and `~/.config/rarog`, or why there are none.
 * A path with a pattern character gives no rule, because a rule that does not match the directory would be reported
 * as a block that is not there.
 */
export type WriteBlockRules =
  | { readonly ok: true; readonly rules: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * The rules of the write block, the one definition for the settings writer, the paste block, the removal and
 * `rarog doctor`: `Edit(/` + absolute path + `/**)`, so the rule starts with exactly two slashes (an absolute path in
 * permission rules). The paths are the data directory and `<home>/.config/rarog` (the directory `rarogConfigDir`
 * gives). Claude Code turns `Edit` deny rules into sandbox write denials, so in the sandbox they cover every Bash
 * process, and outside it the Write and Edit tools (per the sandboxing documentation; measured on 2.1.325, macOS).
 */
export function writeBlockRules(dataDir: string, home: string): WriteBlockRules {
  const rules: string[] = [];
  const dirs: readonly (readonly [string, string])[] = [
    ['data directory', dataDir], ['config directory', join(home, '.config', 'rarog')],
  ];
  for (const [what, dir] of dirs) {
    const normalized = dir.startsWith('/') ? posix.normalize(dir).replace(/\/+$/u, '') : null;
    if (normalized === null || normalized === '') {
      return { ok: false, reason: `the ${what} ${JSON.stringify(dir)} is not an absolute path below the root` };
    }
    const unsafe = RULE_UNSAFE.exec(normalized)?.[0];
    if (unsafe !== undefined) {
      return {
        ok: false,
        reason: `the ${what} ${JSON.stringify(normalized)} has the character ${JSON.stringify(unsafe)}, which a`
          + ' permission rule reads as a pattern, so no rule would match exactly this directory',
      };
    }
    rules.push(`Edit(/${normalized}/**)`);
  }
  return { ok: true, rules };
}

/**
 * Plik wejściowy hooka pod starą nazwą produktu. Starsze instalacje kładły go w kopii, więc należy też do
 * zamkniętej listy plików, które `rarog service uninstall` usuwa z katalogu kopii (`hook-config.ts`).
 */
export const OLD_ENTRY_FILE = 'pilot-pending.mjs'; // stara-nazwa

/** Zmienna łańcucha `statusLine` pod starą nazwą produktu. */
const OLD_CHAIN_VAR = 'PILOT_STATUSLINE_CHAIN'; // stara-nazwa

/**
 * Postać komendy, którą Rarog kiedyś drukował do wklejenia w ustawienia Claude Code, a dziś drukuje inną.
 *
 * Lista jest zamknięta: nowa postać wchodzi tu w tym samym commicie, w którym Rarog przestaje ją drukować (zmiana
 * {@link hookCommand}, {@link contextHookCommand} albo {@link statuslineCommand}).
 */
export interface HistoricalCommand {
  /** Identyfikator postaci (testy, komunikaty). */
  readonly id: string;
  /** Gdzie stała komenda: handler hooka (`hooks.<zdarzenie>[].hooks[].command`) albo `statusLine.command`. */
  readonly key: 'hooks' | 'statusLine';
  /** Wzorzec na CAŁY napis komendy (`^…$`) dla danego katalogu domowego. */
  readonly pattern: (home: string) => RegExp;
}

/** Napis jako dosłowny fragment wyrażenia regularnego. */
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Korzeń checkoutu w komendzie bez cytowania: ciąg segmentów `/…` ze znaków, które powłoka bierze dosłownie
 * (litery i cyfry dowolnego pisma, także `Łukasz`, oraz `._@+,=:%-`; bez spacji, cudzysłowów, `$`, `;`, `&`, `|`,
 * nawiasów i znaków globu). Rarog drukował ścieżkę checkoutu bez apostrofów, więc taka ścieżka to jedyna, którą mógł
 * wydrukować w działającej postaci.
 */
const CHECKOUT_ROOT = '(?:/[\\p{L}\\p{M}\\p{N}._@+,=:%-]+)*';

/** Argument w apostrofach regułą POSIX (`shellQuote`): znaki bez apostrofu albo `'\''`. */
const QUOTED_WORD = String.raw`'(?:[^']|'\\'')*'`;

/** Odwrotność {@link shellQuote} dla napisu, który pasuje do {@link QUOTED_WORD}. */
function shellUnquote(word: string): string {
  return word.slice(1, -1).replaceAll(`'\\''`, "'");
}

const oldCheckoutScript = `${CHECKOUT_ROOT}/${literal(`${HOOK_SOURCE_DIR_REL}/${OLD_ENTRY_FILE}`)}`;

/**
 * `--answer-wait` postaci drukowanych przy suficie godziny (2 s krócej niż godzina). Postaci historyczne niosą tę wartość dosłownie: bieżące {@link HOOK_ANSWER_WAIT_S} jest
 * inne, a wpis z tą wartością ma zostać rozpoznany jako Raroga i zamieniony, nie zgłoszony jako konflikt.
 */
const HOUR_ANSWER_WAIT_S = 3598;
const answerWait = literal(` --answer-wait=${String(HOUR_ANSWER_WAIT_S)}`);

/** Historical forms, oldest first. */
export const HISTORICAL_COMMANDS: readonly HistoricalCommand[] = Object.freeze([
  {
    id: 'checkout',
    key: 'hooks',
    pattern: () => new RegExp(`^node ${oldCheckoutScript}$`, 'u'),
  },
  {
    id: 'checkout-answer-wait',
    key: 'hooks',
    pattern: () => new RegExp(`^node ${oldCheckoutScript}${answerWait}$`, 'u'),
  },
  {
    id: 'copy-old-entry',
    key: 'hooks',
    pattern: (home) => new RegExp(
      `^${literal(`node ${shellQuote(join(home, HOOK_INSTALL_DIR_REL, OLD_ENTRY_FILE))}`)}${answerWait}$`, 'u',
    ),
  },
  {
    id: 'statusline-old-chain',
    key: 'statusLine',
    pattern: (home) => new RegExp(
      `^${literal(OLD_CHAIN_VAR)}=(?<chain>${QUOTED_WORD}) ${literal(statuslineCommand(home))}$`, 'u',
    ),
  },
  {
    id: 'copy-hour-wait',
    key: 'hooks',
    pattern: (home) => new RegExp(
      `^${literal(`node ${shellQuote(join(home, HOOK_INSTALLED_SCRIPT_REL))}`)}${answerWait}$`, 'u',
    ),
  },
]);

/** Dopasowanie komendy do postaci historycznej; `chain` = łańcuch `statusLine` bez cytowania (inne postaci: `null`). */
export interface HistoricalCommandMatch {
  readonly form: HistoricalCommand;
  readonly chain: string | null;
}

/**
 * Postać historyczna, do której komenda pasuje CAŁYM napisem, albo `null`. Łańcuch `statusLine` pusty albo z samych
 * spacji nie pasuje: Rarog drukował wtedy komendę bez łańcucha.
 */
export function historicalCommand(command: string, home: string): HistoricalCommandMatch | null {
  for (const form of HISTORICAL_COMMANDS) {
    const match = form.pattern(home).exec(command);
    if (match === null) continue;
    const word = match.groups?.['chain'];
    if (word === undefined) return { form, chain: null };
    const chain = shellUnquote(word);
    return chain.trim() === '' ? null : { form, chain };
  }
  return null;
}

/**
 * Komenda `statusLine` w postaci, którą Rarog drukował albo drukuje: bieżąca bez łańcucha, bieżąca z łańcuchem
 * (`RAROG_STATUSLINE_CHAIN='<X>' node '…'`) albo postać historyczna z łańcuchem. Wynik: łańcuch X bez cytowania
 * (`null` = bez łańcucha), z którego pisarz ustawień buduje {@link statuslineCommand}, więc X nigdy nie dostaje drugiego
 * owinięcia. `null` = komenda nie jest żadną z tych postaci (cudza albo tylko podobna do Raroga).
 */
export function rarogStatuslineChain(command: string, home: string): { readonly chain: string | null } | null {
  const script = statuslineCommand(home);
  if (command === script) return { chain: null };
  const current = new RegExp(`^${literal(STATUSLINE_CHAIN_VAR)}=(?<chain>${QUOTED_WORD}) ${literal(script)}$`, 'u')
    .exec(command)?.groups?.['chain'];
  if (current !== undefined) return { chain: shellUnquote(current) };
  const old = historicalCommand(command, home);
  return old?.form.key === 'statusLine' ? { chain: old.chain } : null;
}
