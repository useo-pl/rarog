/**
 * Czytnik zrzutu hooka — czym jest narzędzie albo pytanie, przy którym sesja STOI.
 *
 * Zrzut pochodzi z DWÓCH zdarzeń: `PermissionRequest` (dialog zgody faktycznie stanął —
 * także dla `ExitPlanMode`) i `PreToolUse` wyłącznie dla `AskUserQuestion` (treść pytania).
 * Które to było, mówi pole `hookEventName`. Hook nie pisze przy KAŻDYM wywołaniu narzędzia, bo
 * takie zrzuty byłyby stęchłe z definicji.
 *
 * Kontekst: przy stojącym dialogu jsonl MILCZY (silnik dopisuje `tool_use` dopiero po decyzji).
 * Hook `scripts/hooks/rarog-pending.mjs` zrzuca czekające narzędzie do
 * `<dataDir>/pending/<engineSessionId>.json`, a ten moduł czyta to NA ŻĄDANIE — bez watchera,
 * bez cache. Plik jest mały i czytamy go dokładnie wtedy, gdy budujemy kartę; obserwator
 * katalogu byłby trzecim źródłem stanu do zsynchronizowania z jsonl i ekranem.
 *
 * Zasada nadrzędna: ten plik to PODPOWIEDŹ, nigdy dowód. Jest pisany przez proces spoza Raroga,
 * może być stęchły (użytkownik odpowiedział w terminalu — nikt pliku nie sprząta), zepsuty albo
 * nie istnieć w ogóle, bo hook nie jest zainstalowany. Każda taka sytuacja daje `null`, NIGDY
 * wyjątek — Rarog bez hooka działa dalej na karcie ekranowej. Cross-check nazwy narzędzia
 * z ekranem robi warstwa wyżej (driver): mismatch = karta zdegradowana, nigdy zła cyfra.
 */
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ENGINE_SESSION_ID_PATTERN } from '../../../transcript-import.ts';
import { HOOK_ANSWER_TIMEOUT_S, HOOK_BUDGET_SOURCES } from '../../hook-config.ts';
import type { HookBudgetSource } from '../../hook-config.ts';
import {
  HOOK_CALL_KEY_PATTERN, HOOK_PENDING_DIRNAME, HOOK_PERMISSION_REQUEST_EVENT, HOOK_QUESTION_TOOL,
} from './contract.ts';
import { BASH_TOOL } from '../screen/operation.ts';

/** Narzędzie czekające na zgodę — tyle, ile hook zdążył zobaczyć przed dialogiem. */
export interface PendingHookTool {
  readonly toolName: string;
  readonly toolInput: unknown;
  /** Epoch ms zapisu przez hook — podstawa TTL. */
  readonly at: number;
  /**
   * `tool_use_id` z payloadu hooka — stabilna tożsamość WYWOŁANIA (nie tylko nazwy).
   *
   * Występuje WYŁĄCZNIE w zrzutach z `PreToolUse` (czyli dla `AskUserQuestion`). Zdarzenie
   * `PermissionRequest` tego pola nie niesie — zmierzone na tym samym narzędziu
   * w tej samej turze, mimo że ekran `/hooks` twierdzi inaczej.
   */
  readonly toolUseId?: string;
  /**
   * Które zdarzenie zapisało zrzut: `PermissionRequest` (stoi dialog zgody, także dla
   * `ExitPlanMode`) albo `PreToolUse` (wyłącznie `AskUserQuestion` — treść pytania).
   * Zrzut starszego hooka pola nie ma, stąd `?`.
   */
  readonly hookEventName?: string;
  /** `prompt_id` — jedna TURA rozmowy. Wspólny dla obu zdarzeń tej samej tury. */
  readonly promptId?: string;
  /** Tryb uprawnień w chwili zdarzenia (`auto`, `plan`, `default`, `bypassPermissions`). */
  readonly permissionMode?: string;
  /**
   * `agent_id` z payloadu — prośba SUBAGENTA (pomiar na CLI 2.1.302: payload subagenta niesie
   * `agent_id` i `agent_type`, wątek główny żadnego). Rarog niczego na nim nie rozstrzyga: pole idzie
   * wyłącznie do dziennika odmów i zatwierdzeń, żeby policzyć zgody subagentów osobno.
   */
  readonly agentId?: string;
  /**
   * Źródło budżetu strażnika wysokości dialogu:
   * `pane` (geometria panelu z `COLUMNS`/`LINES` hooka), `phone` (geometrii nie było), `floor` (panel
   * poniżej progu). Tylko w zrzucie zgody `Bash`, którą strażnik ocenił i przepuścił; wyłącznie do
   * dziennika, niczego nie rozstrzyga.
   */
  readonly budgetSource?: HookBudgetSource;
  /** Wiersze i kolumny pty panelu w chwili hooka (`LINES`, `COLUMNS`), gdy były poprawne — jak wyżej. */
  readonly paneRows?: number;
  readonly paneCols?: number;
  /**
   * Klucz pliku odpowiedzi dla kanału hooka — liczy go HOOK.
   *
   * Obecny WYŁĄCZNIE w zrzutach `PermissionRequest` + `AskUserQuestion`, czyli dokładnie tam,
   * gdzie proces hooka śpi i czeka na plik z Raroga. Rarog go nie liczy i nie zgaduje: pod
   * jednym `prompt_id` potrafią stać DWA równoległe pytania, więc klucz niesie
   * jeszcze skrót `tool_input.questions` — a jeden algorytm w jednym miejscu nie ma jak się
   * rozjechać z drugim. Trzeci człon to NONCE: dwa
   * identyczne wywołania jednej tury mają ten sam `prompt_id` i ten sam skrót, a muszą mieć
   * różne pliki odpowiedzi. Rarog klucza nie składa i nie rozbiera — cytuje go dosłownie.
   */
  readonly answerKey?: string;
  /**
   * The per-call key of a `PermissionRequest` for a tool other than the question form, as the hook computed it: the
   * same key as in the per-call dump, the marker and the channel registration (`HOOK_CALL_KEY_PATTERN`). It ties a card
   * built from this dump to the consent channel record of the same call (the reason of a card without the approve
   * button, `screen-unavailable.ts`); a value of another shape and an older hook give no field.
   */
  readonly callKey?: string;
  /**
   * `cwd` z payloadu hooka — katalog sesji CLI w chwili prośby, ścieżka bezwzględna.
   * Dialog `Edit` pokazuje ścieżkę pliku względną do tego katalogu, więc bez niego zrzutu nie da się przyłożyć
   * do nagłówka dialogu (`screen/edit-frame.ts`). Pole w złym kształcie znika, zrzut zostaje.
   */
  readonly cwd?: string;
  /**
   * Zrzut `PermissionRequest` + `Bash` starszy niż {@link PENDING_HOOK_TTL_MS}, ale w terminie
   * {@link PENDING_HOOK_BASH_TTL_MS}. Taki zrzut wolno wziąć za źródło albo dowód
   * karty wyłącznie wtedy, gdy ekran sam dowodzi jego komendy (`admittedHook` w `decide/sources.ts`); bez
   * dowodu ocena go nie widzi. Pole stawia czytnik, nie hook.
   */
  readonly stale?: true;
}

/** Sufit długości `cwd` ze zrzutu — `PATH_MAX` na macOS i Linuksie. */
const CWD_MAX_CHARS = 4096;

/** `cwd` ze zrzutu: ścieżka bezwzględna w granicy sufitu, bez znaku NUL; inaczej brak pola. */
function cwdOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.startsWith('/') && value.length <= CWD_MAX_CHARS && !value.includes('\0')
    ? value
    : undefined;
}

/**
 * Po ilu minutach zrzut przestaje cokolwiek znaczyć.
 *
 * Po decyzji podjętej W TERMINALU pliku nie kasuje nikt aż do najbliższego startu serwera
 * ({@link sweepPendingHooks}), więc stary zrzut potrafi leżeć w katalogu tygodniami — a ten
 * limit jest jedyną obroną karty. 10 minut to kompromis: dialog, przy którym człowiek myśli
 * kwadrans, jest rzadszy niż ryzyko podpięcia cudzego (wcześniejszego) narzędzia pod świeżą
 * kartę. Po wygaśnięciu karta spada do wersji ekranowej — gorszej, ale prawdziwej.
 *
 * Dłużej żyją dwa zrzuty `PermissionRequest`: formularz pytania ({@link PENDING_HOOK_QUESTION_TTL_MS})
 * i `Bash` ({@link PENDING_HOOK_BASH_TTL_MS}); ten drugi po 10 minutach wyłącznie z dowodem z ekranu.
 */
export const PENDING_HOOK_TTL_MS = 10 * 60 * 1000;

/**
 * TTL zrzutu STOJĄCEGO formularza pytania (`PermissionRequest` + `AskUserQuestion`) — sufit hooka zgód
 * (`HOOK_ANSWER_TIMEOUT_S`, doba).
 *
 * Formularz `AskUserQuestion` stoi dokładnie tak długo, jak długo człowiek go czyta, a bywa
 * wielopytaniowy: 10 minut gasiło zrzut w środku namysłu i zakładki 2..n spadały do karty
 * „odpowiedz w terminalu". Hook formularza czeka na
 * odpowiedź do sufitu rejestracji, więc zrzut żyje tyle samo: karta ma kanał
 * odpowiedzi tak długo, jak żyje hook, a nie spada do wersji ekranowej w połowie jego czekania.
 * Długi limit jest tu bezpieczny, bo tożsamości NIE dowodzi czas: kartę pytania otwiera dopiero
 * dwustronne dopasowanie treści i KOMPLETU etykiet z ekranem (`hookQuestionFrom`), a stęchły
 * zrzut z tym samym pytaniem znaczy po prostu to samo pytanie.
 *
 * WYŁĄCZNIE dla `PermissionRequest`: to zdarzenie odpala się, gdy CLI postanowiło zapytać
 * (w kolejce i u subagenta w tle zanim dialog stanie na ekranie, ale pytanie i tak przyjdzie).
 * `PreToolUse` odpala się przed decyzją CLI (narzędzie mogło pójść bez pytania), więc jego
 * zrzut zostaje przy dziesięciu minutach.
 */
export const PENDING_HOOK_QUESTION_TTL_MS = HOOK_ANSWER_TIMEOUT_S * 1000;

/**
 * TTL zrzutu `PermissionRequest` + `Bash` — 60 minut; po 10 minutach zrzut ma znacznik
 * `stale` i wchodzi do oceny wyłącznie z dowodem z ekranu.
 *
 * Zgoda subagenta potrafi stać w kolejce CLI za dialogiem wątku głównego dłużej niż 10 minut, a hook
 * `PermissionRequest` dostaje prośbę, gdy CLI postanawia zapytać, nie gdy dialog wychodzi na ekran, i drugi raz
 * nie odpala. Subagent nie czeka na plik odpowiedzi, więc po 10 minutach zostawał sam ekran, a karta obok
 * otwartego narzędzia wątku głównego wychodziła bez przycisków. Czas tożsamości nie dowodzi: dowodem jest
 * tytuł bloku `Bash`, cała ramka operacji pod widocznym nagłówkiem i ramka równa CAŁEJ komendzie zrzutu
 * (`bashFrameProven` w `decide/sources.ts`, ta sama reguła co dla zrzutu starszego niż wpis jsonl). Ramka
 * ucięta, inne narzędzie i zrzut `PreToolUse` zostają przy 10 minutach.
 */
export const PENDING_HOOK_BASH_TTL_MS = 60 * 60 * 1000;

/** Zrzut `PermissionRequest` + `Bash` — jedyny, który po {@link PENDING_HOOK_TTL_MS} dostaje znacznik `stale`. */
function bashPermission(entry: { toolName: string; hookEventName?: string | undefined }): boolean {
  return entry.hookEventName === HOOK_PERMISSION_REQUEST_EVENT && entry.toolName === BASH_TOOL;
}

/**
 * TTL dla konkretnego zrzutu — jedno miejsce dla czytnika i dla żniwiarza. Dłużej żyją wyłącznie zrzuty
 * zdarzenia „CLI postanowiło zapytać" (a nie „narzędzie zaraz ruszy"): formularz pytania i `Bash`.
 */
function ttlFor(entry: { toolName: string; hookEventName?: string | undefined }): number {
  if (entry.hookEventName !== HOOK_PERMISSION_REQUEST_EVENT) return PENDING_HOOK_TTL_MS;
  if (entry.toolName === HOOK_QUESTION_TOOL) return PENDING_HOOK_QUESTION_TTL_MS;
  return bashPermission(entry) ? PENDING_HOOK_BASH_TTL_MS : PENDING_HOOK_TTL_MS;
}

/**
 * Kształt NAZWY narzędzia — wejście niezaufane, a nazwa jedzie dalej niż cokolwiek innego
 * ze zrzutu: na kartę i do `herdr-audit.log` (`docs/security-model.md`, „Starting sessions from the phone: three powers”, pkt 16).
 *
 * Realne nazwy to identyfikatory (`Bash`, `ExitPlanMode`, `mcp__serwer__narzedzie`), więc
 * wzorzec jest wąski i z sufitem długości. Plik z „nazwą" niosącą zdanie, sekret albo 200 kB
 * tekstu nie jest zrzutem hooka i traktujemy go jak nieobecny — zamiast wpuszczać jego treść
 * do dziennika, którego runbook „kradzież telefonu" każe potem czytać.
 */
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

/**
 * Kształt pliku hooka.
 *
 * `looseObject`: hook wolno rozbudować o pola diagnostyczne (`cwd`, `toolUseId`) bez wywracania
 * czytnika starszego serwera. `toolInput` jest `unknown` z rozmysłem — Rarog go NIE interpretuje,
 * przekazuje dosłownie do karty.
 */
const pendingSchema = z.looseObject({
  sessionId: z.string(),
  toolName: z.string().regex(TOOL_NAME_PATTERN),
  toolInput: z.unknown(),
  at: z.number().finite(),
  toolUseId: z.string().optional(),
  hookEventName: z.string().optional(),
  promptId: z.string().optional(),
  permissionMode: z.string().optional(),
  answerKey: z.string().optional(),
  callKey: z.unknown().optional(),
  agentId: z.string().optional(),
  // Pola diagnostyczne strażnika: zły kształt gubi samo pole, nie cały zrzut — karta
  // nie może spaść do wersji ekranowej przez liczbę, która idzie wyłącznie do dziennika.
  budgetSource: z.unknown().optional(),
  paneRows: z.unknown().optional(),
  paneCols: z.unknown().optional(),
  cwd: z.unknown().optional(),
});

/** Wymiar panelu ze zrzutu: liczba całkowita dodatnia w zakresie `uint16` herdr; inaczej brak pola. */
function paneDimension(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65_535 ? value : undefined;
}

/** Źródło budżetu ze zrzutu albo brak pola (wartość spoza zamkniętej listy). */
function budgetSourceOf(value: unknown): HookBudgetSource | undefined {
  return HOOK_BUDGET_SOURCES.find((source) => source === value);
}

/** Ścieżka zrzutu. `null`, gdy identyfikator nie nadaje się na nazwę pliku. */
function pendingPath(dataDir: string, engineSessionId: string): string | null {
  // Walidacja PRZED `join` — identyfikator bywa wejściem z requestu, a `../../…` czytałoby
  // dowolny plik konta użytkownika (ta sama granica, co w `transcript-path.ts`).
  if (!ENGINE_SESSION_ID_PATTERN.test(engineSessionId)) return null;
  return join(dataDir, HOOK_PENDING_DIRNAME, `${engineSessionId}.json`);
}

/**
 * Czyta zrzut hooka dla sesji silnika.
 *
 * @param dataDir katalog danych Raroga (`RarogConfig.dataDir`, reguła `shared/src/data-dir.mjs`)
 * @param engineSessionId `agent_session.value` panelu (UUID sesji CLI)
 * @param now źródło czasu — wstrzykiwane, żeby test TTL nie zależał od zegara ściennego
 * @returns narzędzie czekające na zgodę albo `null`: brak pliku, zepsuty JSON, kształt nie
 *          z tej bajki, zrzut o CUDZEJ sesji, czas z przyszłości lub starszy niż TTL. Zrzut `Bash`
 *          `PermissionRequest` starszy niż 10 minut wraca ze znacznikiem `stale`.
 */
export function readPendingHook(
  dataDir: string, engineSessionId: string, now: () => number,
): PendingHookTool | null {
  const path = pendingPath(dataDir, engineSessionId);
  if (path === null) return null;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const entry = pendingSchema.safeParse(parsed);
  if (!entry.success) return null;
  // Zrzut o innej sesji pod tą nazwą pliku znaczy, że ktoś przestawił katalog albo hook
  // zapisał nie tam — takiego pliku nie wolno podpiąć pod kartę.
  if (entry.data.sessionId !== engineSessionId) return null;

  const age = now() - entry.data.at;
  // Ujemny wiek = zegar hooka biegnie przed naszym (albo `at` jest zmyślone). Traktujemy jak
  // stęchły: wolimy kartę ekranową niż zaufanie znacznikowi, którego nie umiemy umiejscowić.
  if (age < 0 || age > ttlFor(entry.data)) return null;

  return {
    toolName: entry.data.toolName,
    toolInput: entry.data.toolInput,
    at: entry.data.at,
    ...(entry.data.toolUseId === undefined ? {} : { toolUseId: entry.data.toolUseId }),
    ...(entry.data.hookEventName === undefined ? {} : { hookEventName: entry.data.hookEventName }),
    ...(entry.data.promptId === undefined ? {} : { promptId: entry.data.promptId }),
    ...(entry.data.permissionMode === undefined
      ? {}
      : { permissionMode: entry.data.permissionMode }),
    ...(entry.data.answerKey === undefined ? {} : { answerKey: entry.data.answerKey }),
    ...callKeyField(entry.data.callKey),
    ...(entry.data.agentId === undefined ? {} : { agentId: entry.data.agentId }),
    ...guardGeometry(entry.data),
    ...cwdField(entry.data.cwd),
    ...(age > PENDING_HOOK_TTL_MS && bashPermission(entry.data) ? { stale: true as const } : {}),
  };
}

/** The per-call key in its shape (`HOOK_CALL_KEY_PATTERN`); any other value gives no field, the dump stays. */
function callKeyField(value: unknown): Pick<PendingHookTool, 'callKey'> {
  return typeof value === 'string' && HOOK_CALL_KEY_PATTERN.test(value) ? { callKey: value } : {};
}

function cwdField(value: unknown): Pick<PendingHookTool, 'cwd'> {
  const cwd = cwdOf(value);
  return cwd === undefined ? {} : { cwd };
}

/** Pola strażnika ze zrzutu po walidacji — każde osobno; wymiary tylko parą. */
function guardGeometry(
  data: { budgetSource?: unknown; paneRows?: unknown; paneCols?: unknown },
): Pick<PendingHookTool, 'budgetSource' | 'paneRows' | 'paneCols'> {
  const budgetSource = budgetSourceOf(data.budgetSource);
  const paneRows = paneDimension(data.paneRows);
  const paneCols = paneDimension(data.paneCols);
  return {
    ...(budgetSource === undefined ? {} : { budgetSource }),
    ...(paneRows === undefined || paneCols === undefined ? {} : { paneRows, paneCols }),
  };
}

/** Pole markera przycięcia `tool_input` w zrzucie hooka (`{rarogTruncated: true, preview}`). */
const TRUNCATED_MARKER = 'rarogTruncated';

/**
 * Czy `toolInput` to marker przycięcia hooka (`{rarogTruncated: true, …}`), a nie realny input?
 *
 * Marker przepuszczony na kartę dałby zgodę „Write" z PUSTĄ treścią
 * i działającym przyciskiem — gorszą niż karta ekranowa z wycinkiem, którą ta sama sesja
 * dostałaby bez hooka. Wołający ma przy markerze traktować zrzut jak nieobecny.
 */
export function isTruncatedHookInput(toolInput: unknown): boolean {
  if (typeof toolInput !== 'object' || toolInput === null) return false;
  const record = toolInput as Record<string, unknown>;
  return record[TRUNCATED_MARKER] === true;
}

/**
 * Kasuje zrzut po zużyciu (decyzja poszła z Raroga).
 *
 * Bez klucza kasuje plik sesji bezwarunkowo, więc o tym, CZY zrzut jest zużyty, rozstrzyga wołający. Driver nie
 * woła jej po decyzji, gdy zrzut opisuje formularz pytania, który stoi dalej, albo INNY dialog `Bash` w kolejce
 * za rozstrzygniętym (`otherDialogDump` w `decide/sources.ts`).
 *
 * Brak pliku to normalny stan, nie błąd — hook mógł nie być zainstalowany, a `clear` bywa wołany
 * „na wszelki wypadek". Wyjątek nigdy nie wychodzi na zewnątrz: nieudane sprzątanie ma zostać
 * naprawione przez TTL, a nie wywrócić obsługę decyzji.
 *
 * @param answerKey gdy podany, kasujemy WYŁĄCZNIE zrzut o tym kluczu. Nazwa pliku
 *        jest jedna na sesję, a hook nadpisuje ją przy KAŻDYM pytaniu — więc „skasuj plik tej
 *        sesji" po odpowiedzi na pytanie A potrafiło zabrać zrzut pytania B, zapisany ułamek
 *        sekundy wcześniej. Zrzut bez klucza albo nieczytelny zostawiamy nietknięty: nie umiemy
 *        dowieść, że jest nasz, a TTL i żniwiarz startu i tak go zamiotą (fail-closed).
 *
 *        Okno wyścigu ZOSTAJE i jest przyjęte świadomie: odczyt
 *        i `unlink` to dwie operacje, a plik nadpisuje proces spoza Raroga, więc zrzut podmieniony
 *        MIĘDZY nimi zostanie skasowany mimo cudzego klucza. Zamknięcie tego wymagałoby osobnej
 *        ścieżki na generację, czyli zmiany kontraktu z hookiem po obu stronach; dziś okno jest
 *        mikrosekundowe zamiast pewnej straty przy każdej odpowiedzi, a skutkiem jest karta
 *        ekranowa zamiast karty z pełną treścią — nigdy zła cyfra.
 */
export function clearPendingHook(
  dataDir: string, engineSessionId: string, answerKey?: string,
): void {
  const path = pendingPath(dataDir, engineSessionId);
  if (path === null) return;
  if (answerKey !== undefined) {
    let entry: ReturnType<typeof pendingSchema.safeParse>;
    try {
      entry = pendingSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      return;
    }
    if (!entry.success || entry.data.answerKey !== answerKey) return;
  }
  try {
    unlinkSync(path);
  } catch {
    // Brak pliku / brak praw — TTL i tak odetnie zrzut.
  }
}

/**
 * TTL pliku dla ŻNIWIARZA — czytany dopiero wtedy, gdy plik przekroczył TTL krótki.
 * Plik zepsuty albo obcy dostaje TTL krótki: żniwiarz ma go skasować, a nie chronić.
 */
function sweepTtlFor(path: string): number {
  try {
    const entry = pendingSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return entry.success ? ttlFor(entry.data) : PENDING_HOOK_TTL_MS;
  } catch {
    return PENDING_HOOK_TTL_MS;
  }
}

/**
 * ŻNIWIARZ katalogu zrzutów — kasuje pliki starsze niż ICH TTL.
 *
 * TTL przy samym odczycie (po 10 minutach `readPendingHook` zwraca `null`) nie wystarcza: plik
 * leżałby na dysku bezterminowo. `clearPendingHook` kasuje go tylko przy decyzji podjętej
 * Z RAROGA — a hook odpala się we WSZYSTKICH sesjach Claude pod korzeniami Raroga, także w tych,
 * których Rarog nigdy nie zobaczy. Bez żniwiarza katalog rósłby liniowo jako trwały, nierotowany
 * skład tekstu: `toolInput` niesie dosłownie komendy `Bash` (razem z wartościami env w linii),
 * treść `Write`/`Edit` i pełne teksty planów, do 64 kB na plik. `herdr-audit.log` obok redaguje
 * i rotuje przy 8 MB.
 *
 * Wiek liczymy z `mtime`, nie z pola `at`: plik zepsuty albo obcy też ma zniknąć, a jego
 * treści z definicji nie umiemy przeczytać. Każdy błąd jest połykany per plik — sprzątanie
 * jest best-effort i nie ma prawa wywrócić startu serwera. Podkatalogi sesji (`pending/<sesja>/`, zrzuty per
 * wywołanie) zamiata `sweepShadowFiles` z `shadow/sweep.ts`.
 *
 * @returns liczba skasowanych plików (do logu startu)
 */
export function sweepPendingHooks(dataDir: string, now: () => number = Date.now): number {
  const dir = join(dataDir, HOOK_PENDING_DIRNAME);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // Katalogu nie ma — hook nigdy nie odpalił albo `dataDir` dopiero powstaje.
    return 0;
  }
  const at = now();
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      const age = at - statSync(path).mtimeMs;
      // Krótki TTL najpierw: dopiero plik, który go przekroczył, jest wart otwarcia. Żniwiarz
      // nie może skasować zrzutu, który czytnikowi wciąż wolno podpiąć pod kartę — inaczej
      // restart serwera w środku formularza pytania zabierałby mu treść,
      // a zgodzie `Bash` stojącej w kolejce dowód z ekranu. Dłuższe
      // trzymanie pliku nie daje mu władzy: o tym, czy zrzut wchodzi do oceny, decyduje czytnik
      // (`stale`) i dowód z ekranu, a plik i tak znika po swoim TTL.
      if (age <= PENDING_HOOK_TTL_MS || age <= sweepTtlFor(path)) continue;
      unlinkSync(path);
      removed += 1;
    } catch {
      // Znikający plik / brak praw — następny start spróbuje jeszcze raz.
    }
  }
  return removed;
}
