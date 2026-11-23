/**
 * Rama dowodu „dialog stoi” kanału zgód (warstwa 1): test właściwości z modelem prawdy na kodzie produkcyjnym.
 *
 * Niezmiennik (granica uprawnień): żadna prośba, której dialog nie stoi (rozstrzygnięta przy biurku, przerwana,
 * wykonana), nie dostaje sygnału `standing` warstwy 1, karty z `canAllow: true`, a `decide('allow')` nie daje dla niej
 * podpisanej odpowiedzi. Tolerancja to termin dowodu ({@link CONSENT_PROOF_TTL_MS}: 2 s od rozpoczęcia odczytu
 * ekranu): prośba, która stała w ciągu ostatnich 2 s, naruszenia jeszcze nie robi. Dwa niezmienniki osłabione o przypadek
 * łagodny, w którym inna prośba tej samej tożsamości stoi teraz albo stała w tym oknie (zgoda trafia wtedy do hooka
 * sieroty, a CLI jej nie wykonuje):
 *
 * - `zrzut` (wzorce bez znacznika): jej zrzutu nie przeczytała żadna obserwacja żadnego procesu serwera;
 * - `znacznik` (granica gwarancji publikacji znacznika): jej dialog był na wierzchu w chwili rozpoczęcia
 *   odczytu ekranu, z którego wziął się dowód, a serwer w tej chwili nie znał jej ani ze znacznika (nieopublikowany
 *   przed `rename`: okno startu hooka), ani ze zrzutu (prośba bez znacznika, której zrzutu wcześniej nikt nie czytał).
 *
 * Znacznik prośby świat publikuje w formacie `HookMarkerFile` po starcie hooka z opóźnieniem δ, przed zrzutem per
 * wywołanie (hook pisze znacznik przed wyborem drogi). Profil „publikacja przed odczytem” (δ = 0, każda prośba z hookiem
 * ma znacznik) sprawdza kod produkcyjny z pełnym niezmiennikiem; profil „okno startu” (δ od 50 do 100 ms, w rzadkich
 * także prośba bez znacznika) z niezmiennikiem `znacznik`, a każdy kontrprzykład pełnego wypisuje z ziarnem.
 *
 * Model świata (prawda) idzie za zachowaniem CLI zmierzonym w `docs/dialogs.md` („PermissionRequest hook behavior”,
 * w „Channel cycle” punkt „Dialog signals”), a to, czego nikt nie zmierzył, dopuszcza w obie strony:
 *
 * - kolejka dialogów CLI (wątek główny i subagenci w jednej kolejce, licznik „k of N”); nowy dialog zwykle na końcu,
 *   a jako niezmierzona możliwość także na wierzchu; subagent w tle nie ma dialogu, póki jego hook czeka;
 * - narzędzia: `Bash` (tożsamość z ramki komendy, w kolejce z linią `Ask rule` trybu `auto` i bez niej, spod tytułu
 *   z licznikiem), `ExitPlanMode` (nazwa pliku planu w stopce), `Edit` (ramka przy `single`), `Read` (bez
 *   pełnej tożsamości na ekranie) i, w rzadkich, dialog sieci piaskownicy bez hooka;
 * - decyzja przy biurku dotyczy wierzchu kolejki i nie daje hookowi sygnału (hook zostaje sierotą); Esc w wątku
 *   głównym przerywa turę (SIGTERM hooka wierzchu, wpis przerwania zamyka otwarte `tool_use`), a hooki pozostałych
 *   próśb wychodzą albo zostają (niezmierzone);
 * - hook czeka (zrzut na dysku, rejestracja), pomija czekanie (`skipWaiting`: zrzut znika, dialog stoi), wychodzi
 *   bez odpowiedzi (sufit, weto: zrzut znika, dialog stoi), ginie od SIGKILL (zrzut zostaje, `ps` mówi `false`),
 *   zamarza (żyje, nie odbiera odpowiedzi), zapisuje zrzut dopiero po pojawieniu się dialogu (niezmierzone); znacznik
 *   zostaje na dysku po każdym wyjściu hooka (zdejmuje go tylko serwer), w rzadkich `canon.mjs` bez skrótu (hook bez
 *   czekania, znacznik z `inputSha256: null`); hook, który zginął przed publikacją, nie zostawia znacznika ani zrzutu;
 * - restart serwera: hooki starego `bootId` kończą czekanie i usuwają zrzut (zamarznięte zostają), dialogi stoją,
 *   nowy proces zaczyna od blokady startu;
 * - transkrypt wątku głównego: `tool_use` przed dialogiem albo dopiero razem z wynikiem (wiadomość z kilkoma
 *   blokami), wynik po wykonaniu albo odmowie, skrócenie pliku, okno ogona nowego followera po `re-attached`, zalew
 *   ponad pamięć zamknięć;
 * - obserwacja kolejnością drivera: rejestr (z tej chwili, sprzed taktu albo nieznany), odczyt ekranu przy świeżym
 *   `waiting: permission` (tekst z chwili rozpoczęcia odczytu; nieudany albo ucięty), transkrypt (na bieżąco, o takt
 *   w tyle albo nieznany), zrzuty i znaczniki, `ps` per pid z odpowiedzią `null` (tylko przy zrzutach albo hookach
 *   kandydatów subagenta ze znacznikiem, jak `observeConsentSession`); opóźnienia rejestru do ekranu, odczytu ekranu
 *   i `ps` oraz zdarzenia świata w ich trakcie; w rzadkich drugi panel tej sesji (druga obserwacja tego samego świata
 *   z własnym odczytem ekranu, w trakcie `ps` pierwszej albo po jej sygnałach, przed krokiem kolejki);
 * - telefon wybiera kartę z przyciskiem w chwili obserwacji, a decyzja dochodzi po opóźnieniu, także wtedy, gdy
 *   przycisku już nie ma: `decide` sprawdza dowód sam;
 * - plik `release`, który serwer pisze sam po zniknięciu dialogu albo końcu tury (zwolnienie hooka), hook
 *   przejmuje jak każdy plik odpowiedzi, poza przebiegami porównywalnymi ({@link Scenario.comparable}).
 *
 * Kod produkcyjny idzie przez prawdziwą obserwację (`observeConsentSession`, zrzuty i znaczniki na dysku w katalogu
 * tymczasowym, znaczniki czyta i zdejmuje produkcja), prawdziwy cykl z rejestrem sekretów i `decide`. Szew
 * `ConsentSessionSources.matchTop` dostaje abstrakcję tożsamości modelu ({@link modelMatchTop}: tożsamość wierzchu,
 * przycięcie, narzędzie bez pełnej tożsamości), a ekran to tekst modelu z chwilą rozpoczęcia odczytu. Zgodność
 * abstrakcji z produkcyjnym `matchTop` na ekranach w kształcie fixture'ów sprawdza osobny test.
 *
 * Warianty ramy to wzorcowe reguły dowodu jako czyste funkcje (sygnały per klucz) karmiące ten sam prawdziwy
 * cykl; termin dowodu wariantów odtwarza przebieg. Wierzch porównują tą samą abstrakcją tożsamości co kod produkcyjny,
 * a zdarzenia świata w trakcie `ps` mają tylko wtedy, gdy kod produkcyjny pyta `ps`: przy zrzutach
 * i przy kandydatach subagenta ze znacznikiem, których hooka pula regułami produkcji jeszcze nie uznała za martwy
 * ({@link RulesPool}), więc bez drugiego panelu przebieg świata jest ten sam (strażnik niżej); drugi panel wzorce
 * obserwują po pierwszym. Wzorzec B+ zna tylko pola opublikowanego znacznika i wypuszcza kandydatów regułami produkcji
 * (sam rejestr, śmierć hooka subagenta); stary wzorzec B+ (wyjście także przez transkrypt) zostaje obok do porównania.
 * Koszt, czyli odsetek taktów stojącej prośby z przyciskiem zgody, liczy osobny blok testów na tych samych scenariuszach
 * w obu profilach publikacji, w zwykłej pracy samego wątku głównego i z subagentami w trybie `main`, dla kodu
 * produkcyjnego z rozbiciem przyczyn braku przycisku na wierzchu.
 *
 * Diagnostyka: `RAMA_POKAZ=1` wypisuje minimalny kontrprzykład każdej właściwości i czas przebiegów, `RAMA_KOSZT=1`
 * tabelę kosztu z rozbiciem przyczyn, `RAMA_RUNS` i `RAMA_KOSZT_N` zmieniają liczbę przebiegów, `RAMA_SEED` ziarno.
 * Wypis testów, które przechodzą, vitest pokazuje z `--reporter=verbose`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import type { CliDialogClass } from '../src/cli-version.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { HOOK_MARKERS_DIRNAME, HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump, HookMarkerFile } from '../src/herdr/dialogs/hook/contract.ts';
import {
  CONSENT_CLAIMED_SUFFIX, CONSENT_CLAIM_TIMEOUT_MS, CONSENT_DIRNAME, CONSENT_FINAL_STATES, CONSENT_HOOK_CHECKS_MAX,
  CONSENT_NAME_ONLY_TOOLS, CONSENT_PROOF_TTL_MS, CONSENT_SECRET_BYTES, CONSENT_SUBAGENT_GRACE_MS,
} from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle, ConsentCycleIo } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentAgentEnd, TurnToolResult, TurnToolUse } from '../src/herdr/dialogs/layer1/bind.ts';
import { createConsentTopLoss, observeConsentSession } from '../src/herdr/dialogs/layer1/observe.ts';
import type { ConsentSessionHooks, ConsentSubagentTurns } from '../src/herdr/dialogs/layer1/observe.ts';
import type {
  ClosedToolUse, ConsentAfterClaim, ConsentDialogSignal, ConsentEvidenceInput, ConsentSubagentFile,
  ConsentSubagentLaunch, TranscriptToolUses,
} from '../src/herdr/dialogs/layer1/proof.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256 } from '../src/herdr/dialogs/layer1/sign.ts';
import { matchTop } from '../src/herdr/dialogs/layer1/top.ts';
import type { ConsentScreenRead, MatchTop, TopDump, TopMatch } from '../src/herdr/dialogs/layer1/top.ts';
import { queueOnScreen } from '../src/herdr/dialogs/screen/queue.ts';
import {
  REGISTRY_MAX_AGE_MS, REGISTRY_SLACK_MS, registryNegates, standingProofs,
} from '../src/herdr/dialogs/shadow/evidence.ts';
import type { RegistryEvidence } from '../src/herdr/dialogs/shadow/evidence.ts';
import type { ProcessLiveness } from '../src/herdr/dialogs/shadow/liveness.ts';
import { CLOSED_TOOLS_MAX, createPendingTracker, mainAssistantAt } from '../src/herdr/jsonl-pending.ts';
import type { ClosedTool, PendingTool, PendingTracker } from '../src/herdr/jsonl-pending.ts';
import { observeVariantStep, screenRuleProofKind } from './helpers/dowod-z-odczytem.ts';

const SID = '00000000-0000-4000-9000-00000000a0b1';
const PROMPT = '00000000-0000-4000-9000-00000000a0b2';
const T0 = Date.parse('2026-11-08T12:00:00.000Z');
/** Takt obserwacji serwera (odczyt rejestru drivera co 1,5 s, `CLI_WAITING_POLL_MS`). */
const TICK_MS = 1_500;
/** Tolerancja niezmiennika: termin dowodu z wierzchu (rozpoczęcie odczytu ekranu + 2 s). */
const TOLERANCE_MS = CONSENT_PROOF_TTL_MS;
/** Cisza dłuższa niż termin przejęcia pliku odpowiedzi: odpowiedź zamarzniętego hooka przepada. */
const JUMP_MS = CONSENT_CLAIM_TIMEOUT_MS + 1_000;
const SEED = Number(process.env['RAMA_SEED'] ?? 20_261_108);
const RUNS = Number(process.env['RAMA_RUNS'] ?? 10_000);
const COST_RUNS = Number(process.env['RAMA_KOSZT_N'] ?? 400);
/**
 * Liczba różnych komend (plików) w scenariuszach kosztu. Właściwości biorą dwie (identyczne prośby często, żeby szukać
 * bliźniaków); w kosztach identyczna komenda w tej samej chwili co poprzednia to rzadkość, nie reguła.
 */
const COST_COMMANDS = 6;
/** Limit jednej właściwości: przebiegi z cyklem i dyskiem, maszyna bywa pod obciążeniem. */
const PROPERTY_TIMEOUT_MS = 600_000;
const SHOW = process.env['RAMA_POKAZ'] === '1';
const FINAL = CONSENT_FINAL_STATES as readonly string[];
const NAME_ONLY = CONSENT_NAME_ONLY_TOOLS as readonly string[];
/** Katalog wywołań w zrzutach modelu. */
const CWD = '/tmp/projekt';

const BASE = mkdtempSync(join(tmpdir(), 'rarog-rama-'));
afterAll(() => { rmSync(BASE, { recursive: true, force: true }); });

// ---------------------------------------------------------------- scenariusz (wejście generatora)

type Thread = 'main' | 'fg' | 'bg';
type ToolName = 'Bash' | 'ExitPlanMode' | 'Edit' | 'Read' | 'SandboxNetwork';

/**
 * Prośba CLI. `SandboxNetwork` = dialog sieci piaskownicy (bez hooka); `ExitPlanMode` i sieć tylko w wątku głównym.
 * `cmd` wybiera komendę albo plik, `desc` opis `Bash`, wersję planu i treść zamiany `Edit`.
 */
interface AskEv {
  readonly kind: 'ask';
  readonly thread: Thread;
  readonly tool: ToolName;
  readonly cmd: number;
  readonly desc: number;
  /** `waits` = hook czeka na odpowiedź; `skip` = `skipWaiting` (zrzut znika od razu, dialog stoi). */
  readonly hook: 'waits' | 'skip';
  /** `tool_use` w transkrypcie przed dialogiem albo dopiero razem z wynikiem. */
  readonly entry: 'before' | 'withResult';
  /** Zrzut przycięty (marker zamiast wejścia, skrót całości). */
  readonly cut: boolean;
  /** Nowy dialog na wierzchu kolejki (niezmierzone: dopuszczone). */
  readonly front: boolean;
  /** Zrzut czekającego hooka trafia na dysk dopiero w następnym kroku, po dialogu (niezmierzone: dopuszczone). */
  readonly late: boolean;
  /**
   * Publikacja (`rename`) znacznika `delta` ms po starcie hooka: 0 w profilu „publikacja przed odczytem”, od 50 do 100
   * w profilu „okno startu” (start Node, import `canon.mjs`, skrót). Hook pisze znacznik przed wyborem drogi, więc
   * zrzut per wywołanie też nie wcześniej (rejestracja w modelu od razu: serwer używa jej dopiero przy zrzucie).
   */
  readonly delta: number;
  /** `missing` = prośba bez znacznika: odmowa bramki albo błąd zapisu (profil „okno startu”, rzadkie). */
  readonly marker: 'ok' | 'missing';
  /** `false` = `canon.mjs` nie liczy skrótu: hook pomija czekanie (`skrot`), bez zrzutu, znacznik z `inputSha256: null`. */
  readonly canon: boolean;
}

/** Klawisz przy biurku na dialogu z wierzchu kolejki. */
interface DeskEv {
  readonly kind: 'desk';
  readonly act: 'allow' | 'deny' | 'esc';
  /** Esc w wątku głównym: hooki pozostałych próśb wychodzą albo zostają sierotami (niezmierzone). */
  readonly others: 'exit' | 'orphan';
  /** Esc: `tool_use` próśb jeszcze bez wpisu trafia do transkryptu albo nie (niezmierzone). */
  readonly writeCancelled: boolean;
}

/** Zdarzenie na `pick`-tym elemencie: wykonanie narzędzia, SIGKILL hooka, wyjście hooka bez odpowiedzi, zamarznięcie. */
interface PickEv {
  readonly kind: 'finish' | 'kill' | 'exit' | 'freeze';
  readonly pick: number;
}

interface TruncateEv { readonly kind: 'truncate'; readonly keep: number }
/** Powrót gniazda herdr: nowy follower po `delay` taktach, cały plik (`window` 0) albo okno ostatnich wpisów. */
interface ReattachEv { readonly kind: 'reattach'; readonly window: number; readonly delay: number }
/** Zalew zamknięć ponad pamięć trackera. */
interface FloodEv { readonly kind: 'flood' }
/** Cisza dłuższa niż termin przejęcia odpowiedzi. */
interface JumpEv { readonly kind: 'jump' }
/** Restart serwera: nowy proces (nowy `bootId`, rejestr sekretów i cykl), follower czyta plik od nowa (`window`). */
interface RestartEv { readonly kind: 'restart'; readonly window: number }

type Ev = AskEv | DeskEv | PickEv | TruncateEv | ReattachEv | FloodEv | JumpEv | RestartEv;
/** Zdarzenie świata w trakcie obserwacji. */
type MidEv = AskEv | DeskEv | PickEv;
/** Punkt obserwacji, w którym zachodzą zdarzenia `mid`: przed ekranem, w trakcie odczytu ekranu, w trakcie `ps`. */
type MidAt = 'beforeScreen' | 'duringScreen' | 'duringPs';

/** Drugi panel tej samej sesji: druga obserwacja tego samego świata z własnym odczytem ekranu. */
interface SecondPanel {
  /** Odstęp startu drugiej obserwacji od chwili, w której pierwsza przeczytała zrzuty (albo zaczęła krok kolejki). */
  readonly gap: number;
  readonly screenDelay: number;
  readonly psDelay: number;
  /** Druga czyta zrzuty w trakcie `ps` pierwszej albo po jej sygnałach, przed jej pierwszym krokiem kolejki. */
  readonly at: 'duringPs' | 'beforeQueue';
  /** Przy `duringPs`: która kończy `ps` pierwsza. */
  readonly first: 'A' | 'B';
}

/** Pokrętła obserwacji jednego taktu. */
interface Obs {
  readonly regLag: boolean;
  readonly regUnknown: boolean;
  readonly screen: 'full' | 'unknown' | 'partial';
  readonly follower: 'normal' | 'lag' | 'null';
  /** Bity `ps` bez odpowiedzi: bit `i` = hook o numerze `i mod 4`. */
  readonly psNull: number;
  /** Od odczytu rejestru do rozpoczęcia odczytu ekranu (ms). */
  readonly obsDelay: number;
  /** Czas odczytu ekranu (ms): tekst z chwili rozpoczęcia, odpowiedź po tym czasie. */
  readonly screenDelay: number;
  /** Czas odpowiedzi `ps` (ms). */
  readonly psDelay: number;
  readonly mid: readonly MidEv[];
  readonly midAt: MidAt;
  readonly second: SecondPanel | null;
}

/** Decyzja z telefonu `delay` ms po obserwacji: `pick`-ta karta, która ma odpowiedni przycisk. */
interface PhoneAct { readonly pick: number; readonly act: 'allow' | 'deny' | 'release'; readonly delay: number }

interface Step { readonly events: readonly Ev[]; readonly obs: Obs; readonly phone: PhoneAct | null }

interface Scenario {
  /** Hooki subagentów czekają (tryb `all` z serwerem, który je przyjmuje); inaczej pomijają czekanie. */
  readonly subagentsWait: boolean;
  /** Dialog sieci piaskownicy na wierzchu: rejestr `permission` i blok jak dialog zgody (niezmierzone). */
  readonly netLikePermission: boolean;
  /**
   * Tryb `auto` z regułą `ask` dla komend modelu: dialog `Bash` ma linię `Ask rule … overrides auto mode`
   * (`dialog-bash-ask-rule-2.1.295`). A queued `Bash` top has the full identity with and without it (the title with
   * the counter, `bashTop` with the `titlePair` pair in `top.ts`; this dialog's lines are on the closed list of the
   * question zone), so the field does not change the proof; the generator still draws it so that world runs and cost
   * denominators stay stable for a given seed.
   */
  readonly askRule: boolean;
  readonly steps: readonly Step[];
  /**
   * Przebieg porównywalny ({@link comparableSamples}): bez telefonu, więc każdy plik `release` pisze serwer sam, po
   * sygnale `gone` albo końcu tury reguły dowodu (zwolnienie hooka). Taki plik zależy od reguły, a przejęty
   * zmienia świat (hook wychodzi), więc tu hooki go nie dostają: koszt mierzy ramę dowodu na tym samym świecie, a samo
   * zwolnienie sprawdzają testy cyklu.
   */
  readonly comparable?: true;
}

// ---------------------------------------------------------------- tożsamość wywołań (prawda modelu i ekran)

/** Wejście hooka i wpisu `tool_use` prośby (CLI 2.1.314: `ExitPlanMode` ma w wpisie `{}`, `Edit` dostaje `replace_all`). */
function callInputs(tool: ToolName, cmd: number, desc: number): {
  readonly hookInput: Record<string, unknown>; readonly entryInput: Record<string, unknown>;
} {
  switch (tool) {
    case 'Bash': {
      const input = { command: `echo ${String(cmd)}`, description: `opis ${String(desc)}` };
      return { hookInput: input, entryInput: input };
    }
    case 'ExitPlanMode':
      return {
        hookInput: { plan: `Plan ${String(cmd)}.${String(desc)}`, planFilePath: `/u/.claude/plans/plan-${String(cmd)}.md` },
        entryInput: {},
      };
    case 'Edit': {
      const input = {
        file_path: `${CWD}/f${String(cmd)}.txt`, old_string: `stara ${String(desc)}`, new_string: `nowa ${String(desc)}`,
        replace_all: false,
      };
      return { hookInput: input, entryInput: input };
    }
    case 'Read': {
      const input = { file_path: `${CWD}/r${String(cmd)}.txt` };
      return { hookInput: input, entryInput: input };
    }
    case 'SandboxNetwork': {
      const input = { host: `h${String(cmd)}.example.com` };
      return { hookInput: input, entryInput: input };
    }
  }
}

/** Tożsamość dialogu z wątkiem: wątek, narzędzie i to, co z wejścia pokazuje ekran (komenda, plik planu, ramka). */
function identOf(main: boolean, toolName: string, input: unknown): string {
  const thread = main ? 'main' : 'sub';
  const fields = (input ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case 'Bash': return `${thread}|Bash|${String(fields['command'])}`;
    case 'ExitPlanMode': return `${thread}|ExitPlanMode|${basename(String(fields['planFilePath']))}`;
    case 'Edit':
      return `${thread}|Edit|${basename(String(fields['file_path']))}|${String(fields['old_string'])}`
        + `|${String(fields['new_string'])}`;
    case 'Read': return `${thread}|Read|${basename(String(fields['file_path']))}`;
    case 'SandboxNetwork': return `${thread}|SandboxNetwork|${String(fields['host'])}`;
    default: return `${thread}|${toolName}`;
  }
}

/** Tożsamość bez wątku: narzędzie i to, co pokazuje ekran (wierzch nie odróżnia subagenta od wątku głównego). */
const bareIdent = (ident: string): string => ident.split('|').slice(1).join('|');

/**
 * Pełna tożsamość na wierzchu: cała ramka `Bash` (jeden dialog: spod tytułu z listy przez `wholeBashFrame`; kolejka:
 * spod tytułu z licznikiem, z linią `Ask rule` i bez niej; obie drogi przez `bashTop` z `titlePair` w `top.ts`), nazwa
 * pliku planu, ramka `Edit` przy jednym dialogu (`single`). Strefa pytania `Bash` w modelu to zawsze linie z zamkniętej
 * listy (z `Ask rule` linie `dialog-bash-ask-rule-2.1.295`, bez niej samo pytanie), więc kolejka `Bash` ma tożsamość;
 * wierzch z linią spoza listy pod ramką model zna tylko bez tożsamości (wiersze testu zgodności).
 */
function fullIdentity(tool: string, standing: number): boolean {
  if (tool === 'Bash') return true;
  return tool === 'ExitPlanMode' || (tool === 'Edit' && standing === 1);
}

const digestKnown = new WeakMap<object, boolean>();

/** Skrót wejścia zgodny z wejściem (zrzut nieprzycięty); wynik w pamięci per obiekt zrzutu. */
function digestOk(dump: TopDump): boolean {
  const known = digestKnown.get(dump);
  if (known !== undefined) return known;
  let ok: boolean;
  try {
    ok = canonicalSha256(dump.toolInput) === dump.inputSha256;
  } catch {
    ok = false;
  }
  digestKnown.set(dump, ok);
  return ok;
}

// ---------------------------------------------------------------- ekran modelu i abstrakcja `matchTop`

const MODEL_SCREEN = 'ekran modelu ';

/**
 * Wierzch ekranu modelu: liczba stojących, narzędzie (`null` = bez dialogu albo blok ucięty), tożsamość, plik `Edit`
 * i linia `Ask rule` dialogu `Bash`.
 */
interface ModelTop {
  readonly standing: number;
  readonly tool: string | null;
  readonly ident: string;
  readonly file: string;
  readonly askRule: boolean;
}

/** Odczyt ekranu: stojące dialogi i wierzch kolejki CLI. */
interface ScreenSnap {
  readonly standing: number;
  /** Narzędzie dialogu z wierzchu; `null` = kolejka pusta. */
  readonly tool: ToolName | null;
  /** Tożsamość wierzchu bez wątku (to, co czyta `matchTop`). */
  readonly bare: string;
  readonly file: string;
  /** Dialog `Bash` z linią `Ask rule` (tryb `auto` z regułą `ask`, {@link Scenario.askRule}). */
  readonly askRule: boolean;
}

function renderScreen(snap: ScreenSnap, partial: boolean): string {
  const top: ModelTop = partial || snap.tool === null
    ? { standing: snap.standing, tool: null, ident: '', file: '', askRule: false }
    : { standing: snap.standing, tool: snap.tool, ident: snap.bare, file: snap.file, askRule: snap.askRule };
  return `${MODEL_SCREEN}${JSON.stringify(top)}`;
}

let lastModelText = '';
let lastModelTop: ModelTop | null = null;

function modelTopOf(text: string): ModelTop | null {
  if (text === lastModelText) return lastModelTop;
  lastModelText = text;
  lastModelTop = text.startsWith(MODEL_SCREEN) ? JSON.parse(text.slice(MODEL_SCREEN.length)) as ModelTop : null;
  return lastModelTop;
}

/**
 * Abstrakcja tożsamości modelu w miejscu produkcyjnego `matchTop` (szew `ConsentSessionSources.matchTop`), z tymi samymi
 * regułami po kolei: wierzch bez pełnej tożsamości (`Read`, sieć, `Edit` w kolejce, ekran ucięty albo bez dialogu)
 * = `unknown` dla każdego zrzutu; zrzut innego narzędzia = `no`; zrzut
 * przycięty = `unknown`; `Edit`: ta sama ramka = `match`, inny plik = `no`, ten sam plik z inną zamianą = `unknown`
 * (bez dowiedzionej sprzeczności); reszta: ta sama tożsamość = `match`, inna = `no`. Wątku nie czyta. Tej samej
 * abstrakcji używają wzorce B i B+ ({@link createVariant}).
 */
const modelMatchTop: MatchTop = (screenText, dump) => {
  const top = modelTopOf(screenText);
  if (top === null || top.tool === null || !fullIdentity(top.tool, top.standing)) return 'unknown';
  if (dump.toolName !== top.tool) return 'no';
  if (!digestOk(dump)) return 'unknown';
  const ident = bareIdent(identOf(true, dump.toolName, dump.toolInput));
  if (top.tool === 'Edit') {
    if (ident === top.ident) return 'match';
    return basename(String((dump.toolInput as Record<string, unknown>)['file_path'])) === top.file ? 'unknown' : 'no';
  }
  return ident === top.ident ? 'match' : 'no';
};

// ---------------------------------------------------------------- model świata (prawda)

interface Req {
  readonly id: number;
  readonly thread: Thread;
  readonly tool: ToolName;
  readonly hookInput: Readonly<Record<string, unknown>>;
  readonly entryInput: Readonly<Record<string, unknown>>;
  /** Tożsamość dialogu z wątkiem (warianty) i bez wątku (ekran, `matchTop`, przypadek łagodny). */
  readonly ident: string;
  readonly bare: string;
  readonly toolUseId: string;
  readonly cut: boolean;
  /** `queued` = dialog stoi; `hidden` = subagent w tle, hook czeka, dialogu jeszcze nie ma. */
  status: 'queued' | 'hidden' | 'running' | 'closed';
  settledAtDesk: boolean;
  entryWritten: boolean;
  hook: Hook | null;
  /** Chwila wejścia dialogu do kolejki CLI i wyjścia z niej (ms epoki); `null` = jeszcze nie. */
  queuedAt: number | null;
  leftAt: number | null;
}

interface Hook {
  readonly index: number;
  readonly req: Req;
  readonly dump: HookCallDump;
  /** Numer procesu serwera, przy którym hook wystartował (restart zmienia `bootId`). */
  readonly boot: number;
  readonly registered: boolean;
  /** Publikacja znacznika i najwcześniejszy zapis zrzutu: start hooka + {@link AskEv.delta} (ms epoki). */
  readonly pubAt: number;
  /** Znacznik prośby; `null` = prośba bez znacznika ({@link AskEv.marker}). */
  readonly marker: Marker | null;
  alive: boolean;
  /** Zrzut na dysku od {@link pubAt} ({@link World.dumpVisible}). */
  onDisk: boolean;
  /** Zrzut czeka na zapis (dialog przed zrzutem). */
  late: boolean;
  /** Czeka na plik odpowiedzi (odbiera go, póki nie zamarzł). */
  waiting: boolean;
  frozen: boolean;
  /** Hook zginął albo wyszedł przed publikacją: znacznika i zrzutu nie ma. */
  cutShort: boolean;
}

/** Kandydat puli wzorca: zrzut widziany kiedykolwiek albo znacznik hooka, pola pierwszego odczytu. */
interface Cand {
  readonly key: string;
  readonly toolName: string;
  readonly main: boolean;
  /** `null` tylko w znaczniku hooka, który nie policzył skrótu (`canon.mjs`). */
  readonly inputSha256: string | null;
  readonly startedAt: number;
  /** Zapis zrzutu albo znacznika (ms epoki). */
  readonly at: number;
  readonly pid: number;
  /** Pola, które czyta dopasowanie do wierzchu ({@link modelMatchTop}). */
  readonly top: TopDump;
}

/**
 * Znacznik prośby od hooka (format `HookMarkerFile`): każda prośba z hookiem, także po
 * `skipWaiting`, z wejściem przyciętym jak w zrzucie i `inputSha256: null` przy błędzie `canon.mjs`. Hook go nie kasuje.
 */
interface Marker extends Cand {
  readonly file: HookMarkerFile;
}

type RegTruth = { readonly kind: 'waiting'; readonly dialog: CliDialogClass } | { readonly kind: 'active' };

/** Proces serwera w modelu: numer, rejestr sekretów (rejestracje hooków), cykl i wariant reguły dowodu. */
interface Proc {
  readonly boot: number;
  readonly reg: ConsentRegistry;
  readonly cycle: ConsentCycle;
  readonly variant: Variant | null;
}

const iso = (ms: number): string => new Date(ms).toISOString();

const toolUseEntry = (id: string, name: string, input: unknown, at: number): unknown => ({
  type: 'assistant', timestamp: iso(at), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const resultEntry = (id: string, at: number): unknown => ({
  type: 'user', timestamp: iso(at),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});
const interruptEntry = (at: number): unknown => ({
  type: 'user', timestamp: iso(at),
  message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
});

/** Wejście przycięte przez hook (sufit 64 KiB): marker zamiast wejścia, skrót całości. */
const cutInput = (input: Readonly<Record<string, unknown>>): Record<string, unknown> => ({
  rarogTruncated: true, preview: JSON.stringify(input).slice(0, 8),
});

class World {
  readonly reqs: Req[] = [];
  queue: Req[] = [];
  readonly hooks: Hook[] = [];
  readonly hookByKey = new Map<string, Hook>();
  readonly hookByPid = new Map<number, Hook>();
  readonly markers: Marker[] = [];
  entries: unknown[] = [];
  private floods = 0;

  constructor(
    private readonly sc: Scenario, private readonly files: Map<string, string>, private readonly consentDir: string,
    private readonly tag: string, private readonly server: () => Proc,
  ) {}

  private inMainTranscript(req: Req): boolean {
    return req.thread === 'main' && req.tool !== 'SandboxNetwork';
  }

  private writeToolUse(req: Req, at: number): void {
    this.entries.push(toolUseEntry(req.toolUseId, req.tool, req.entryInput, at));
    req.entryWritten = true;
  }

  private writeResult(req: Req, at: number): void {
    if (!req.entryWritten) this.writeToolUse(req, at - 30);
    this.entries.push(resultEntry(req.toolUseId, at));
  }

  /** Hook kończy proces w chwili `at`; przed publikacją nie zostawia znacznika ani zrzutu. */
  private terminate(hook: Hook, at: number): void {
    if (at < hook.pubAt) hook.cutShort = true;
    hook.alive = false;
    hook.onDisk = false;
    hook.late = false;
    hook.waiting = false;
  }

  /** Zrzut per wywołanie na dysku w chwili `at`. */
  dumpVisible(hook: Hook, at: number): boolean {
    return hook.onDisk && hook.pubAt <= at;
  }

  /** Znacznik na dysku w chwili `at`: opublikowany przed śmiercią hooka i niezdjęty przez serwer (`removed`). */
  markerVisible(marker: Marker, at: number, removed: ReadonlySet<string>): boolean {
    const hook = this.hookByKey.get(marker.key);
    return hook !== undefined && !hook.cutShort && marker.at <= at && !removed.has(marker.key);
  }

  /** Czy znacznik prośby był opublikowany w chwili `at` (granica gwarancji publikacji znacznika). */
  published(req: Req, at: number): boolean {
    const hook = req.hook;
    return hook !== null && hook.marker !== null && !hook.cutShort && hook.pubAt <= at;
  }

  private enter(req: Req, front: boolean, at: number): void {
    req.status = 'queued';
    req.queuedAt = at;
    if (front) this.queue.unshift(req);
    else this.queue.push(req);
  }

  private leave(req: Req, at: number): void {
    if (!this.queue.includes(req)) return;
    this.queue = this.queue.filter((other) => other !== req);
    req.leftAt = at;
  }

  /** Hook wyszedł bez wyniku: dialog subagenta w tle pojawia się dopiero teraz. */
  private unhide(req: Req, at: number): void {
    if (req.status === 'hidden') this.enter(req, false, at);
  }

  ask(ev: AskEv, at: number): void {
    const tool = ev.tool;
    const thread: Thread = tool === 'ExitPlanMode' || tool === 'SandboxNetwork' ? 'main' : ev.thread;
    const main = thread === 'main';
    const { hookInput, entryInput } = callInputs(tool, ev.cmd, ev.desc);
    const id = this.reqs.length;
    const cut = ev.cut && tool !== 'ExitPlanMode' && tool !== 'SandboxNetwork';
    const ident = identOf(main, tool, hookInput);
    const req: Req = {
      id, thread, tool, hookInput, entryInput, ident, bare: bareIdent(ident), toolUseId: `toolu_${this.tag}_${String(id)}`,
      cut, status: 'queued', settledAtDesk: false, entryWritten: false, hook: null, queuedAt: null, leftAt: null,
    };
    this.reqs.push(req);
    const hasHook = tool !== 'SandboxNetwork';
    // `canon.mjs` bez skrótu: hook pomija czekanie (`skrot`) bez zrzutu i rejestracji.
    const waits = hasHook && ev.canon && ev.hook === 'waits' && (main || this.sc.subagentsWait);
    if (thread === 'bg' && waits) req.status = 'hidden';
    else this.enter(req, ev.front, at);
    if (this.inMainTranscript(req) && ev.entry === 'before') this.writeToolUse(req, at - 50);
    if (!hasHook) return;

    const index = this.hooks.length;
    const nonce = createHash('sha256').update(`${this.tag}-${String(index)}`).digest('hex').slice(0, 32);
    const key = `${PROMPT}-${nonce}`;
    const inputSha256 = canonicalSha256(hookInput);
    const permissionMode = tool === 'ExitPlanMode' ? 'plan' : 'default';
    const pubAt = at + ev.delta;
    const toolInput = cut ? cutInput(hookInput) : hookInput;
    const pid = 70_000 + index;
    const base: HookCallDump = {
      key, sessionId: SID, promptId: PROMPT, pid, startedAt: at, toolName: tool, toolInput, cwd: CWD, at: pubAt + 20,
      inputSha256, permissionMode,
    };
    const dump: HookCallDump = main ? base : { ...base, agentId: 'agent-1' };
    const markerSha256 = ev.canon ? inputSha256 : null;
    const marker: Marker | null = ev.marker === 'missing' ? null : {
      key, toolName: tool, main, inputSha256: markerSha256, startedAt: at, at: pubAt, pid,
      top: { toolName: tool, toolInput, inputSha256: markerSha256, cwd: CWD },
      file: {
        key, sessionId: SID, promptId: PROMPT, pid, startedAt: at, ...(main ? {} : { agentId: 'agent-1' }), toolName: tool,
        toolInput, cwd: CWD, at: pubAt, inputSha256: markerSha256,
      },
    };
    const server = this.server();
    let registered = false;
    if (waits && main) {
      const cardSha256 = consentCardSha256({
        sessionId: SID, toolName: tool, toolInput: hookInput, cwd: dump.cwd, agentId: null, permissionMode,
      });
      registered = server.reg.register({
        key, sessionId: SID, promptId: PROMPT, secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'), inputSha256,
        cardSha256, pid: dump.pid, startedAt: at,
      }).status === 200;
    }
    const hook: Hook = {
      index, req, dump, boot: server.boot, registered, pubAt, marker, alive: waits, onDisk: waits && !ev.late,
      late: waits && ev.late, waiting: waits, frozen: false, cutShort: false,
    };
    req.hook = hook;
    this.hooks.push(hook);
    this.hookByKey.set(key, hook);
    this.hookByPid.set(dump.pid, hook);
    if (marker !== null) this.markers.push(marker);
  }

  desk(ev: DeskEv, at: number): void {
    const top = this.queue[0];
    if (top === undefined) return;
    if (ev.act === 'esc' && this.inMainTranscript(top)) {
      this.interrupt(ev, top, at);
      return;
    }
    this.leave(top, at);
    top.settledAtDesk = true;
    if (ev.act === 'allow' && top.tool !== 'SandboxNetwork') {
      top.status = 'running';
      return;
    }
    // Odmowa (Esc subagenta to odmowa bez sygnału): wynik od razu.
    top.status = 'closed';
    if (this.inMainTranscript(top)) this.writeResult(top, at);
  }

  /** Esc w wątku głównym: tura przerwana, wszystkie prośby i wykonania zamknięte, wpis przerwania. */
  private interrupt(ev: DeskEv, top: Req, at: number): void {
    const cancelled = this.reqs.filter((req) => req.status !== 'closed');
    for (const req of this.queue) req.leftAt = at;
    this.queue = [];
    for (const req of cancelled) {
      req.status = 'closed';
      req.settledAtDesk = true;
      const hook = req.hook;
      if (hook !== null && hook.alive && (req === top || ev.others === 'exit')) this.terminate(hook, at);
      if (this.inMainTranscript(req) && !req.entryWritten && ev.writeCancelled) this.writeToolUse(req, at - 30);
    }
    this.entries.push(interruptEntry(at));
  }

  pickEvent(ev: PickEv, at: number): void {
    if (ev.kind === 'finish') {
      const running = this.reqs.filter((req) => req.status === 'running');
      const req = running[ev.pick % Math.max(running.length, 1)];
      if (req === undefined) return;
      req.status = 'closed';
      if (this.inMainTranscript(req)) this.writeResult(req, at);
      return;
    }
    const pool = this.hooks.filter((hook) => hook.alive && (ev.kind === 'kill' || hook.waiting)
      && (ev.kind !== 'freeze' || !hook.frozen));
    const hook = pool[ev.pick % Math.max(pool.length, 1)];
    if (hook === undefined) return;
    if (ev.kind === 'freeze') {
      hook.frozen = true;
      return;
    }
    if (ev.kind === 'kill') {
      // SIGKILL: zrzut zostaje na dysku (zrzut spóźniony już nie powstaje); przed publikacją nie ma ani zrzutu, ani
      // znacznika.
      if (at < hook.pubAt) {
        hook.cutShort = true;
        hook.onDisk = false;
      }
      hook.alive = false;
      hook.waiting = false;
      hook.late = false;
    } else {
      this.terminate(hook, at);
    }
    this.unhide(hook.req, at);
  }

  /** Restart serwera: hooki starego procesu kończą czekanie i usuwają zrzut (zamarznięte zostają), dialogi stoją. */
  restart(at: number): void {
    for (const hook of this.hooks) {
      if (!hook.alive || !hook.waiting || hook.frozen) continue;
      this.terminate(hook, at);
      this.unhide(hook.req, at);
    }
  }

  /** Zrzuty spóźnione trafiają na dysk (hook dalej czeka). */
  flushLate(): void {
    for (const hook of this.hooks) {
      if (!hook.late) continue;
      hook.late = false;
      if (hook.alive && hook.waiting) hook.onDisk = true;
    }
  }

  truncate(keep: number): void {
    this.entries = this.entries.slice(0, keep % (this.entries.length + 1));
  }

  flood(at: number): void {
    this.floods += 1;
    for (let i = 0; i <= CLOSED_TOOLS_MAX; i += 1) {
      const id = `toolu_${this.tag}_f${String(this.floods)}_${String(i)}`;
      this.entries.push(toolUseEntry(id, 'Read', { file_path: `/f/${String(i)}` }, at));
      this.entries.push(resultEntry(id, at));
    }
  }

  /** Hooki odbierają pliki odpowiedzi (`.json` → `.claimed`), wypisują decyzję i wychodzą. */
  claims(at: number): void {
    for (const hook of this.hooks) {
      if (!hook.alive || !hook.waiting || hook.frozen) continue;
      const path = join(this.consentDir, `${hook.dump.key}.json`);
      const body = this.files.get(path);
      if (body === undefined) continue;
      this.files.delete(path);
      this.files.set(join(this.consentDir, `${hook.dump.key}${CONSENT_CLAIMED_SUFFIX}`), body);
      const decision = (JSON.parse(body) as { decision?: unknown }).decision;
      this.terminate(hook, at);
      const req = hook.req;
      // Sierota: CLI spóźnioną odpowiedź ignoruje.
      if (req.status !== 'queued' && req.status !== 'hidden') continue;
      if (decision === 'allow') {
        this.leave(req, at);
        req.status = 'running';
      } else if (decision === 'deny') {
        this.leave(req, at);
        req.status = 'closed';
        if (this.inMainTranscript(req)) this.writeResult(req, at);
      } else {
        this.unhide(req, at);
      }
    }
  }

  standing(): Set<number> {
    return new Set(this.queue.map((req) => req.id));
  }

  registryTruth(): RegTruth {
    const top = this.queue[0];
    if (top === undefined) return { kind: 'active' };
    if (top.tool === 'SandboxNetwork') return { kind: 'waiting', dialog: this.sc.netLikePermission ? 'permission' : 'sandbox' };
    return { kind: 'waiting', dialog: 'permission' };
  }

  screenSnap(): ScreenSnap {
    const top = this.queue[0];
    if (top === undefined) return { standing: 0, tool: null, bare: '', file: '', askRule: false };
    const file = top.tool === 'Edit' ? basename(String(top.hookInput['file_path'])) : '';
    const askRule = this.sc.askRule && top.tool === 'Bash';
    return { standing: this.queue.length, tool: top.tool, bare: top.bare, file, askRule };
  }

  describe(req: Req): string {
    const hook = req.hook;
    const hookText = hook === null ? 'bez hooka'
      : `hook ${hook.alive ? 'żywy' : 'martwy'}${hook.onDisk ? ', zrzut' : ', bez zrzutu'}${hook.frozen ? ', zamarzł' : ''}`;
    const stood = req.queuedAt === null ? 'bez dialogu'
      : `dialog ${String(req.queuedAt - T0)}–${req.leftAt === null ? 'teraz' : String(req.leftAt - T0)} ms`;
    return `${req.status}${req.settledAtDesk ? ' przy biurku' : ''}, ${hookText}, ${stood}`;
  }
}

/** Follower transkryptu: tracker zamknięć, skrócenie pliku, nowy follower po `re-attached`. */
class Follower {
  private tracker: PendingTracker | null = createPendingTracker();
  private fed = 0;
  private pending: { delay: number; window: number } | null = null;

  truncated(length: number, at: number): void {
    if (this.tracker !== null && this.fed > length) {
      // `#onTruncated`: nowy tracker, utrata do chwili skrócenia, odczyt od nowego końca pliku.
      this.tracker = createPendingTracker();
      this.tracker.lose(at);
    }
    this.fed = Math.min(this.fed, length);
  }

  reattach(delay: number, window: number): void {
    this.tracker = null;
    this.pending = { delay, window };
  }

  read(
    entries: readonly unknown[], mode: Obs['follower'], prevLength: number, now: number,
  ): { open: PendingTool[]; closed: ClosedTool[]; lostAt: number | null } | null {
    if (this.pending !== null) {
      if (this.pending.delay > 0) {
        this.pending = { ...this.pending, delay: this.pending.delay - 1 };
        return null;
      }
      // `#primeOnce`: okno ogona w środku pliku = utrata do pierwszego wpisu `assistant` w oknie.
      const tracker = createPendingTracker();
      const window = this.pending.window % (entries.length + 1);
      const start = window === 0 ? 0 : entries.length - window;
      let covered: number | null = null;
      for (const entry of entries.slice(start)) {
        tracker.note(entry);
        covered ??= mainAssistantAt(entry);
      }
      if (start > 0) tracker.lose(covered ?? now);
      this.tracker = tracker;
      this.fed = entries.length;
      this.pending = null;
      return { open: [...tracker.open], closed: [...tracker.closed], lostAt: tracker.lostAt };
    }
    if (mode === 'null' || this.tracker === null) return null;
    const target = mode === 'lag' ? Math.max(this.fed, Math.min(prevLength, entries.length)) : entries.length;
    for (const entry of entries.slice(this.fed, target)) this.tracker.note(entry);
    this.fed = target;
    return { open: [...this.tracker.open], closed: [...this.tracker.closed], lostAt: this.tracker.lostAt };
  }
}

type TranscriptRead = ReturnType<Follower['read']>;

/** Dysk cyklu w pamięci: rekordy bez zapisu, pliki odpowiedzi w mapie wspólnej z hookami modelu. */
function memoryIo(files: Map<string, string>, withoutRelease = false): Partial<ConsentCycleIo> {
  return {
    writeRecord: () => {},
    writeFile: (dir, name, body) => {
      // Przebieg porównywalny ({@link Scenario.comparable}): zwolnienie hooka z inicjatywy serwera do hooka nie dochodzi.
      if (withoutRelease && (JSON.parse(body) as { decision?: unknown }).decision === 'release') return;
      files.set(join(dir, name), body);
    },
    rename: (from, to) => {
      const body = files.get(from);
      if (body === undefined) throw Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' });
      files.delete(from);
      files.set(to, body);
    },
    exists: (path) => files.has(path),
    list: (dir) => [...files.keys()].filter((path) => dirname(path) === dir).map((path) => basename(path)),
    read: (path) => files.get(path) ?? null,
  };
}

// ---------------------------------------------------------------- warianty ramy (wzorcowe reguły dowodu)

/** Odczyt ekranu dla wariantów: tekst ekranu modelu i chwila rozpoczęcia odczytu (ms epoki). */
interface ScreenView { readonly text: string; readonly at: number }

/** Krok puli wzorca przed `ps`, w chwili odczytu zrzutów i znaczników (`notePool` w kodzie produkcyjnym). */
interface VariantPoolInput {
  readonly now: number;
  /** Zrzuty na dysku, także subagentów. */
  readonly dumps: readonly HookCallDump[];
  /** Znaczniki na dysku (opublikowane, niezdjęte przez serwer). */
  readonly markers: readonly Marker[];
  readonly registry: RegistryEvidence;
}

interface VariantInput {
  readonly now: number;
  readonly dumps: readonly HookCallDump[];
  readonly alive: ReadonlyMap<string, boolean | null>;
  readonly registry: RegistryEvidence;
  readonly transcript: { readonly closed: readonly ClosedTool[] } | null;
  readonly screen: ScreenView | null;
  /** Znaczniki na dysku dla wzorców „+”; `null` = wzorzec bez znaczników. */
  readonly markers: readonly Marker[] | null;
}

/** Hook do sprawdzenia w `ps` (`ConsentHookWatch` w kodzie produkcyjnym). */
interface PsCheck { readonly key: string; readonly pid: number; readonly startedAt: number }

interface Variant {
  /**
   * Pula regułami produkcji ({@link RulesPool}) przed `ps`: hooki kandydatów subagenta ze znacznikiem bez zrzutu w tej
   * obserwacji do `ps` (te same zapytania co kod produkcyjny, więc ten sam przebieg świata) i znaczniki, które serwer
   * zdejmuje z dysku.
   */
  pool(input: VariantPoolInput): { readonly checks: readonly PsCheck[]; readonly removed: readonly string[] };
  /** Po `ps` (`asked` = zrzuty i `checks`): śmierć hooków kandydatów subagenta ze znacznikiem w chwili `at`. */
  dead(asked: readonly PsCheck[], ps: (pid: number) => boolean | null, at: number): void;
  signals(input: VariantInput): Map<string, ConsentDialogSignal>;
}

/** Błąd wzorca do sprawdzianu przypadku łagodnego: pula gubi kandydata, którego zrzut zniknął z dysku. */
type VariantBug = 'drop-vanished';

/** Kandydat z pierwszego odczytu zrzutu: pola dopasowania do wierzchu jak w puli kodu produkcyjnego. */
function candOf(dump: HookCallDump): Cand {
  return {
    key: dump.key, toolName: dump.toolName, main: dump.agentId === undefined, inputSha256: dump.inputSha256,
    startedAt: dump.startedAt, at: dump.at, pid: dump.pid,
    top: { toolName: dump.toolName, toolInput: dump.toolInput, inputSha256: dump.inputSha256, cwd: dump.cwd },
  };
}

/** Kandydat puli regułami produkcji: pola pierwszego odczytu, wyjście, znacznik na dysku i śmierć hooka subagenta. */
interface RulesCand {
  readonly cand: Cand;
  exitAt: number | null;
  marked: boolean;
  deadAt: number | null;
}

/**
 * Pula sesji regułami produkcji (`notePool`, `hookWatch`, `noteHookDead` w `layer1/cycle.ts`), poza sufitem 1024
 * (scenariusze go nie sięgają): zrzuty, potem znaczniki z dysku, jeden kandydat na klucz z polami pierwszego odczytu.
 * Wyjście: kandydat wątku głównego przy świeżym rejestrze bez `waiting` co najmniej {@link REGISTRY_SLACK_MS} po zapisie
 * prośby, kandydat subagenta ze znacznikiem przy takim rejestrze co najmniej {@link REGISTRY_SLACK_MS} po obserwacji,
 * w której `ps` dał `false` o jego hooku; subagent bez znacznika nie wychodzi. Kandydat po wyjściu starszym niż termin
 * odczytów zostaje kluczem, a serwer zdejmuje jego znacznik. Blokada startu: do świeżego rejestru bez `waiting` co
 * najmniej {@link REGISTRY_SLACK_MS} po starcie procesu. Zwycięzca wierzchu jak `consentTopWinner` w `layer1/proof.ts`.
 */
class RulesPool {
  private readonly candidates = new Map<string, RulesCand>();
  /** Kandydaci po wyjściu i terminie odczytów: klucz → chwila wyjścia. */
  private readonly exited = new Map<string, number>();
  private exitedAt: number | null = null;
  private unlockedAt: number | null = null;

  constructor(private readonly startedAt: number) {}

  note(input: VariantPoolInput): string[] {
    const removed: string[] = [];
    const names = new Set(input.markers.map((marker) => marker.key));
    const admit = (cand: Cand): void => {
      if (this.candidates.has(cand.key) || this.exited.has(cand.key)) return;
      this.candidates.set(cand.key, { cand, exitAt: null, marked: names.has(cand.key), deadAt: null });
    };
    for (const dump of input.dumps) admit(candOf(dump));
    for (const marker of input.markers) admit(marker);
    for (const name of names) {
      const known = this.candidates.get(name);
      if (known !== undefined) known.marked = true;
    }
    for (const [key, one] of this.candidates) {
      if (one.exitAt === null || input.now - one.exitAt <= CONSENT_PROOF_TTL_MS) continue;
      this.candidates.delete(key);
      this.exited.set(key, one.exitAt);
      this.exitedAt = Math.max(this.exitedAt ?? one.exitAt, one.exitAt);
      if (one.marked) removed.push(key);
    }
    const registry = input.registry;
    if (registry.kind !== 'active' || input.now - registry.at > REGISTRY_MAX_AGE_MS) return removed;
    if (this.unlockedAt === null && registry.at >= this.startedAt + REGISTRY_SLACK_MS) this.unlockedAt = registry.at;
    for (const one of this.candidates.values()) {
      if (one.exitAt !== null) continue;
      const since = one.cand.main ? one.cand.at : one.deadAt;
      if (since !== null && registryNegates(registry, input.now, { at: since })) one.exitAt = registry.at;
    }
    return removed;
  }

  /** Kandydaci subagenta ze znacznikiem, bez wyjścia i bez zapisanej śmierci hooka, w kolejności pierwszego odczytu. */
  watch(): PsCheck[] {
    const out: PsCheck[] = [];
    for (const [key, one] of this.candidates) {
      if (one.marked && !one.cand.main && one.exitAt === null && one.deadAt === null) {
        out.push({ key, pid: one.cand.pid, startedAt: one.cand.startedAt });
      }
    }
    return out;
  }

  dead(asked: readonly PsCheck[], ps: (pid: number) => boolean | null, at: number): void {
    for (const watch of this.watch()) {
      if (!asked.some((one) => one.pid === watch.pid && one.startedAt === watch.startedAt) || ps(watch.pid) !== false) {
        continue;
      }
      const one = this.candidates.get(watch.key);
      if (one !== undefined) one.deadAt = at;
    }
  }

  /** Kandydat wyszedł z puli (także po terminie odczytów, jako sam klucz). */
  exitedKey(key: string): boolean {
    return this.exited.has(key) || (this.candidates.get(key)?.exitAt ?? null) !== null;
  }

  /** Kandydaci bez wyjścia albo po wyjściu w terminie odczytów (do faktów utraty dowodu własnego). */
  pool(): readonly Cand[] {
    return [...this.candidates.values()].map((one) => one.cand);
  }

  winner(screen: ScreenView): string | null {
    if (this.unlockedAt === null || this.unlockedAt >= screen.at) return null;
    if (this.exitedAt !== null && this.exitedAt >= screen.at) return null;
    let winner: string | null = null;
    for (const one of this.candidates.values()) {
      if (one.exitAt !== null && one.exitAt < screen.at) continue;
      const match = modelMatchTop(screen.text, one.cand.top);
      if (match === 'no') continue;
      if (match === 'unknown' || winner !== null) return null;
      winner = one.cand.key;
    }
    return winner;
  }
}

/**
 * Zwycięzca wierzchu wzorca B: jedyny kandydat puli z `match`, gdy każdy inny daje `no` ({@link modelMatchTop}, ta sama
 * abstrakcja tożsamości co szew kodu produkcyjnego, bez wątku); `unknown` któregokolwiek kandydata (wierzch bez pełnej
 * tożsamości, zrzut przycięty tego narzędzia, `Edit` tego samego pliku z inną zamianą) = bez dowodu dla nikogo.
 */
function topWinnerOf(pool: readonly Cand[], text: string): string | null {
  let winner: string | null = null;
  for (const cand of pool) {
    const match = modelMatchTop(text, cand.top);
    if (match === 'no') continue;
    if (match === 'unknown' || winner !== null) return null;
    winner = cand.key;
  }
  return winner;
}

/**
 * Wariant A (pula pełna z lepkimi faktami pewnego zamknięcia) i B (tożsamość dialogu z wierzchu ekranu). Wspólne:
 *
 * - pula = każdy zrzut widziany kiedykolwiek (z wariantem „+” każdy znacznik hooka), bez względu na `ps`, przycięcie,
 *   wątek i stan karty; wychodzi z niej WYŁĄCZNIE pewne zamknięcie, zapamiętane na stałe: świeży rejestr bez
 *   `waiting` odczytany co najmniej {@link REGISTRY_SLACK_MS} po zrzucie (tylko wątek główny: dialog subagenta w tle
 *   pojawia się później) albo zamknięcie z transkryptu przypisane dokładnie jednemu kandydatowi puli (nazwa, skrót albo
 *   sama nazwa dla `ExitPlanMode`, start hooka nie późniejszy niż zamknięcie; każde zamknięcie raz; kandydatem jest
 *   też prośba już zamknięta rejestrem, bo jej wynik może przyjść później, ale nie prośba z przypisanym już wynikiem);
 * - porównanie z ekranem idzie do puli Z CHWILI ODCZYTU EKRANU: prośba zamknięta później niż ten odczyt dalej się
 *   liczy (ekran o takt starszy pokazuje jeszcze jej dialog);
 * - własny dowód traci na stałe zrzut, któremu pasuje jakiekolwiek zamknięcie po starcie jego hooka (strona
 *   bezpieczna, bez przypisania); utrata pokrycia (`lostAt`), śmierć hooka, `ps` `null` i odwołanie karty niczego nie
 *   zamykają;
 * - blokada startu jak w kodzie produkcyjnym: proces po restarcie nie ma dowodu do pierwszego świeżego
 *   rejestru bez `waiting` odczytanego co najmniej {@link REGISTRY_SLACK_MS} po starcie, a dowód obowiązuje przed
 *   terminem odczytu ekranu ({@link CONSENT_PROOF_TTL_MS}).
 *
 * A: dowód dla żywego zrzutu wątku głównego przy świeżym `waiting`/`permission`, gdy pula nie jest większa niż licznik
 * stojących z ekranu (ekran z dialogiem, nieucięty). B: dowód, gdy zrzut jest jedynym kandydatem puli z `match`
 * wierzchu, a każdy inny daje `no` ({@link topWinnerOf}: ta sama abstrakcja tożsamości co kod produkcyjny). `bug` psuje
 * pulę na potrzeby sprawdzianu predykatu przypadku łagodnego.
 *
 * `exits: 'rejestr'` (wzorzec B+): pula i jej wyjścia regułami produkcji ({@link RulesPool}: sam
 * rejestr, śmierć hooka subagenta), z tym samym dowodem własnym (zamknięcie z transkryptu zabiera tylko dowód własny).
 * Każdy wzorzec prowadzi {@link RulesPool} obok, bo z niej bierze hooki do `ps`.
 */
function createVariant(
  rule: 'A' | 'B', options: {
    readonly startedAt: number; readonly locked: boolean; readonly exits: 'transkrypt' | 'rejestr';
    readonly bug?: VariantBug;
  },
): Variant {
  const rules = new RulesPool(options.startedAt);
  const seen = new Map<string, Cand>();
  /** Pewne zamknięcie: klucz → chwila (odczyt rejestru albo wpis wyniku). */
  const closed = new Map<string, number>();
  /** Klucze z przypisanym zamknięciem z transkryptu: wynik prośby przychodzi raz. */
  const attributed = new Set<string>();
  const ownLost = new Set<string>();
  const used = new Set<string>();
  let unlockedAt: number | null = options.locked ? null : Number.NEGATIVE_INFINITY;
  const close = (key: string, at: number): void => { if (!closed.has(key)) closed.set(key, at); };

  function learn(input: VariantInput): void {
    for (const marker of input.markers ?? []) {
      if (!seen.has(marker.key)) seen.set(marker.key, marker);
    }
    for (const dump of input.dumps) {
      if (!seen.has(dump.key)) seen.set(dump.key, candOf(dump));
    }
    const registry = input.registry;
    if (registry.kind === 'active' && input.now - registry.at <= REGISTRY_MAX_AGE_MS) {
      if (unlockedAt === null && registry.at >= options.startedAt + REGISTRY_SLACK_MS) unlockedAt = registry.at;
      for (const cand of seen.values()) {
        if (cand.main && cand.at + REGISTRY_SLACK_MS <= registry.at) close(cand.key, registry.at);
      }
    }
    if (input.transcript === null) return;
    for (const closure of input.transcript.closed) {
      if (used.has(closure.id)) continue;
      used.add(closure.id);
      const closedAt = closure.closedAt;
      if (closedAt === null) continue;
      const byName = NAME_ONLY.includes(closure.toolName);
      const cands = [...seen.values()].filter((cand) => cand.main && !attributed.has(cand.key)
        && cand.toolName === closure.toolName && cand.startedAt <= closedAt
        && (byName || closure.inputSha256 === null || closure.inputSha256 === cand.inputSha256));
      for (const cand of cands) ownLost.add(cand.key);
      const [only] = cands;
      if (cands.length === 1 && only !== undefined) {
        attributed.add(only.key);
        close(only.key, closedAt);
      }
    }
  }

  /** Wzorzec B+ regułami produkcji: zamknięcie z transkryptu zabiera tylko dowód własny, z puli nie wyjmuje. */
  function rulesSignals(input: VariantInput): Map<string, ConsentDialogSignal> {
    for (const closure of input.transcript?.closed ?? []) {
      if (used.has(closure.id)) continue;
      used.add(closure.id);
      const closedAt = closure.closedAt;
      if (closedAt === null) continue;
      const byName = NAME_ONLY.includes(closure.toolName);
      for (const cand of rules.pool()) {
        if (cand.main && cand.toolName === closure.toolName && cand.startedAt <= closedAt
          && (byName || closure.inputSha256 === null || closure.inputSha256 === cand.inputSha256)) ownLost.add(cand.key);
      }
    }
    const registry = input.registry;
    const waitingFresh = registry.kind === 'waiting' && registry.dialog === 'permission'
      && input.now - registry.at <= REGISTRY_MAX_AGE_MS;
    const screen = input.screen;
    const winner = screen === null || input.now >= screen.at + CONSENT_PROOF_TTL_MS ? null : rules.winner(screen);
    const out = new Map<string, ConsentDialogSignal>();
    for (const dump of input.dumps) {
      const alive = input.alive.get(dump.key) ?? null;
      const exited = rules.exitedKey(dump.key);
      if (alive === false) out.set(dump.key, 'dead');
      else if (alive === true && exited) out.set(dump.key, 'gone');
      else {
        const own = alive === true && dump.agentId === undefined && digestOk(dump) && waitingFresh
          && !ownLost.has(dump.key) && !exited;
        out.set(dump.key, own && winner === dump.key ? 'standing' : 'unknown');
      }
    }
    return out;
  }

  return {
    pool(input) {
      const removed = rules.note(input);
      const keys = new Set(input.dumps.map((dump) => dump.key));
      const checks = rules.watch().filter((watch) => !keys.has(watch.key)).slice(0, CONSENT_HOOK_CHECKS_MAX);
      return { checks, removed };
    },
    dead(asked, ps, at) {
      rules.dead(asked, ps, at);
    },
    signals(input) {
      if (options.exits === 'rejestr') return rulesSignals(input);
      learn(input);
      const registry = input.registry;
      const waitingFresh = registry.kind === 'waiting' && registry.dialog === 'permission'
        && input.now - registry.at <= REGISTRY_MAX_AGE_MS;
      const screen = input.screen;
      const onDisk = new Set(input.dumps.map((dump) => dump.key));
      // Pula z chwili odczytu ekranu: zamknięcie późniejsze niż odczyt nie zabiera kandydata.
      const pool = screen === null ? [] : [...seen.values()].filter((cand) => (closed.get(cand.key) ?? Infinity) > screen.at
        && (options.bug !== 'drop-vanished' || onDisk.has(cand.key)));
      const live = screen !== null && unlockedAt !== null && unlockedAt < screen.at
        && input.now < screen.at + CONSENT_PROOF_TTL_MS;
      const top = screen === null ? null : modelTopOf(screen.text);
      const winner = rule === 'B' && screen !== null ? topWinnerOf(pool, screen.text) : null;
      const out = new Map<string, ConsentDialogSignal>();
      for (const dump of input.dumps) {
        const alive = input.alive.get(dump.key) ?? null;
        if (alive === false) {
          out.set(dump.key, 'dead');
          continue;
        }
        if (alive === true && closed.has(dump.key)) {
          out.set(dump.key, 'gone');
          continue;
        }
        const own = alive === true && dump.agentId === undefined && digestOk(dump) && waitingFresh
          && !ownLost.has(dump.key) && !closed.has(dump.key);
        let proof = false;
        if (own && live && rule === 'A' && top !== null && top.tool !== null) proof = pool.length <= top.standing;
        if (own && live && rule === 'B') proof = winner === dump.key;
        out.set(dump.key, proof ? 'standing' : 'unknown');
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------- przebieg scenariusza

type Mode =
  | { readonly kind: 'produkcja'; readonly name: string }
  | {
    readonly kind: 'wariant'; readonly name: string; readonly rule: 'A' | 'B'; readonly plus: boolean;
    readonly exits: 'transkrypt' | 'rejestr'; readonly bug?: VariantBug;
  };

const PRODUCTION: Mode = { kind: 'produkcja', name: 'kod produkcyjny' };
const VARIANT_A: Mode = { kind: 'wariant', name: 'A', rule: 'A', plus: false, exits: 'transkrypt' };
const VARIANT_A_PLUS: Mode = { kind: 'wariant', name: 'A+', rule: 'A', plus: true, exits: 'transkrypt' };
const VARIANT_B: Mode = { kind: 'wariant', name: 'B', rule: 'B', plus: false, exits: 'transkrypt' };
/** Wzorzec B+: pola opublikowanego znacznika, wyjście z puli regułami produkcji. */
const VARIANT_B_PLUS: Mode = { kind: 'wariant', name: 'B+', rule: 'B', plus: true, exits: 'rejestr' };
/** Wzorzec B+ z wyjściem z puli także przez zamknięcie w transkrypcie. */
const VARIANT_B_PLUS_TRANSCRIPT: Mode = {
  kind: 'wariant', name: 'B+ z wyjściem przez transkrypt', rule: 'B', plus: true, exits: 'transkrypt',
};
const VARIANT_B_BUG: Mode = {
  kind: 'wariant', name: 'B z błędem', rule: 'B', plus: false, exits: 'transkrypt', bug: 'drop-vanished',
};
const MODES: readonly Mode[] = [
  PRODUCTION, VARIANT_A, VARIANT_A_PLUS, VARIANT_B, VARIANT_B_PLUS, VARIANT_B_PLUS_TRANSCRIPT,
];

/** Licznik kosztu: takty stojącej prośby wątku głównego z czekającym hookiem i przyciskiem zgody. */
interface Tally {
  any: number;
  anyButton: number;
  top: number;
  topButton: number;
  dialogs: number;
  dialogsButton: number;
  /** Takty na wierzchu per narzędzie: [wszystkie, z przyciskiem]. */
  readonly tools: Map<string, [number, number]>;
  /** Kod produkcyjny: przyczyna braku przycisku na wierzchu → liczba taktów. */
  readonly why: Map<string, number>;
}

const emptyTally = (): Tally => ({
  any: 0, anyButton: 0, top: 0, topButton: 0, dialogs: 0, dialogsButton: 0, tools: new Map(), why: new Map(),
});

const bump = (map: Map<string, number>, key: string, by = 1): void => { map.set(key, (map.get(key) ?? 0) + by); };

function addTally(sum: Tally, one: Tally): void {
  sum.any += one.any;
  sum.anyButton += one.anyButton;
  sum.top += one.top;
  sum.topButton += one.topButton;
  sum.dialogs += one.dialogs;
  sum.dialogsButton += one.dialogsButton;
  for (const [tool, [all, button]] of one.tools) {
    const into = sum.tools.get(tool) ?? [0, 0];
    sum.tools.set(tool, [into[0] + all, into[1] + button]);
  }
  for (const [why, count] of one.why) bump(sum.why, why, count);
}

/**
 * Niezmiennik przebiegu: `pelny`, `zrzut` (osłabiony o bliźniaka, którego zrzutu nie przeczytała żadna obserwacja)
 * albo `znacznik` (osłabiony o bliźniaka z wierzchu odczytu ekranu dowodu, którego serwer w chwili rozpoczęcia tego
 * odczytu nie znał ani ze znacznika, ani ze zrzutu).
 */
type Invariant = 'pelny' | 'zrzut' | 'znacznik';

interface RunResult {
  /** Naruszenia niezmiennika wybranego w wywołaniu ({@link Invariant}). */
  readonly violations: readonly string[];
  /** Naruszenia pełnego niezmiennika. */
  readonly full: readonly string[];
  /** Naruszenia niezmiennika `zrzut` (ten sam przebieg). */
  readonly weak: readonly string[];
  /** Naruszenia niezmiennika `znacznik` (ten sam przebieg). */
  readonly unpublished: readonly string[];
  readonly tally: Tally;
  /** Zdarzenia świata po kolei: krok, chwila od startu i zdarzenie (strażnik porównywalności przebiegów). */
  readonly trace: readonly string[];
  /** Decyzje z telefonu: krok, karta, czy przycisk był w chwili wyboru, wynik `decide` albo `release`. */
  readonly phone: readonly string[];
}

/** Obserwacja kodu produkcyjnego do rozbicia przyczyn braku przycisku. */
interface ObsNote {
  readonly screen: ConsentScreenRead | null;
  readonly registry: RegistryEvidence;
  readonly signals: ReadonlyMap<string, ConsentDialogSignal>;
  readonly complete: boolean;
  readonly at: number;
  /** Wejście dowodu własnego tej obserwacji (`null` = warianty). */
  readonly evidence: ConsentEvidenceInput | null;
}

let runCounter = 0;

const settle = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * Przebieg: na początku kroku zrzuty spóźnione trafiają na dysk, hooki odbierają odpowiedzi i cykl robi przegląd
 * plików; potem zdarzenia, obserwacja (jedna albo dwa panele) z rejestrem w siatce taktów, decyzja z telefonu: karta
 * wybrana spośród kart z przyciskiem zaraz po obserwacji, `decide` albo `release` po opóźnieniu bez względu na to, czy
 * przycisk jeszcze jest. Niezmiennik sprawdza się przy każdym sygnale `standing`, po każdym zdarzeniu (karty)
 * i przy udanej zgodzie z telefonu, we wszystkich wersjach naraz ({@link Invariant}).
 *
 * `invariant` wybiera {@link RunResult.violations}. `reasons` = rozbicie przyczyn braku przycisku na wierzchu (kod
 * produkcyjny).
 */
async function runScenario(
  sc: Scenario, mode: Mode, invariant: Invariant = 'pelny', reasons = false,
): Promise<RunResult> {
  runCounter += 1;
  const tag = String(runCounter);
  let clock = T0;
  const now = (): number => clock;
  const files = new Map<string, string>();
  const dataDir = mode.kind === 'produkcja' ? mkdtempSync(join(BASE, 'r-')) : join(BASE, 'bez-dysku');
  const consentDir = join(dataDir, CONSENT_DIRNAME, SID);
  const pendingDir = join(dataDir, HOOK_PENDING_DIRNAME, SID);
  const markersDir = join(dataDir, HOOK_MARKERS_DIRNAME, SID);
  const io = memoryIo(files, sc.comparable === true);

  /** Nowy proces serwera. `locked` = właśnie wstał (blokada startu); inaczej wstał 10 s temu i blokadę już zdjął. */
  const newProc = async (boot: number, locked: boolean): Promise<Proc> => {
    const startAt = clock;
    if (!locked) clock = startAt - 10_000;
    const bootId = `boot-rama-${String(boot)}`;
    const reg = createConsentRegistry({ bootId, send: () => true, sessions: () => [SID], log: () => {}, now });
    reg.setScope('main');
    const cycle = createConsentCycle({ dataDir, bootId, registry: reg, now, io });
    const variant = mode.kind === 'wariant'
      ? createVariant(mode.rule, {
        startedAt: clock, locked, exits: mode.exits, ...(mode.bug === undefined ? {} : { bug: mode.bug }),
      })
      : null;
    if (!locked) {
      // Rejestr bez `waiting` 5 s po starcie procesu, zanim scenariusz ruszył: blokada startu zdjęta.
      clock = startAt - 5_000;
      const registry: RegistryEvidence = { kind: 'active', at: clock };
      if (variant === null) {
        await observeConsentSession(cycle, {
          dataDir, sessionId: SID, liveness: async () => new Map(), registry, transcript: null, screen: null, now,
        });
      } else {
        variant.pool({ now: clock, dumps: [], markers: [], registry });
        variant.signals({
          now: clock, dumps: [], alive: new Map(), registry, transcript: null, screen: null, markers: null,
        });
      }
    }
    clock = startAt;
    return { boot, reg, cycle, variant };
  };

  let proc = await newProc(0, false);
  const world = new World(sc, files, consentDir, tag, () => proc);
  const follower = new Follower();
  /** Historia prawdy rejestru: rejestr o takt w tyle czyta stan sprzed taktu. */
  const regHistory: { readonly at: number; readonly truth: RegTruth }[] = [
    { at: Number.NEGATIVE_INFINITY, truth: { kind: 'active' } },
  ];
  /**
   * Klucz zrzutu → chwila pierwszego odczytu przez jakąkolwiek obserwację któregokolwiek procesu serwera: niezmiennik
   * `zrzut` pyta, czy zrzut ktoś przeczytał, `znacznik`, czy przed rozpoczęciem odczytu ekranu dowodu.
   */
  const seenAt = new Map<string, number>();
  const noteSeen = (key: string): void => { if (!seenAt.has(key)) seenAt.set(key, clock); };
  /** Rozpoczęcie odczytu ekranu → prośba z wierzchu kolejki w tej chwili (dialog, który pokazał ten odczyt). */
  const topsAt = new Map<number, Req[]>();
  /** Warianty: termin dowodu per klucz (rozpoczęcie odczytu ekranu + termin), odtwarzany w przebiegu. */
  const variantUntil = new Map<string, number>();
  /**
   * Rozpoczęcie odczytu ekranu najnowszego sygnału `standing` per klucz (odczyt, z którego wziął się dowód karty),
   * w procesie serwera, który go dał.
   */
  const proofRead = new Map<string, number>();
  const noteProof = (key: string, at: number): void => {
    proofRead.set(key, Math.max(proofRead.get(key) ?? Number.NEGATIVE_INFINITY, at));
  };
  const written = new Set<string>();
  /** Kod produkcyjny: znaczniki zapisane na dysk (zapis raz; zdjęty przez serwer nie wraca). */
  const markersWritten = new Set<string>();
  /** Wzorce: znaczniki zdjęte z dysku regułami produkcji ({@link RulesPool}); trwa przez restart procesu. */
  const markersRemoved = new Set<string>();
  const full: string[] = [];
  const weak: string[] = [];
  const unpublished: string[] = [];
  const trace: string[] = [];
  const phoneLog: string[] = [];
  let stepNo = 0;
  const tally = emptyTally();
  const eligible = new Set<number>();
  const withButton = new Set<number>();
  let prevStanding = new Set<number>();
  let prevLength = 0;
  let lastRegistryRead = T0;

  const noteRegistry = (): void => {
    const truth = world.registryTruth();
    const last = regHistory[regHistory.length - 1]?.truth;
    const same = last !== undefined && last.kind === truth.kind
      && (last.kind === 'active' || (truth.kind === 'waiting' && last.dialog === truth.dialog));
    if (!same) regHistory.push({ at: clock, truth });
  };
  const registryAt = (at: number): RegTruth => {
    let truth: RegTruth = { kind: 'active' };
    for (const entry of regHistory) {
      if (entry.at > at) break;
      truth = entry.truth;
    }
    return truth;
  };

  /**
   * Kod produkcyjny: katalogi zrzutów i znaczników na dysku = zrzuty i opublikowane znaczniki modelu. Znacznik świat
   * zapisuje raz, a zdejmuje go tylko serwer. Warianty dysku nie czytają. Widziane w obu to zrzuty na dysku modelu
   * w tej chwili: obserwacja kodu produkcyjnego czyta katalog synchronicznie zaraz po `mirror()`, a wzorzec bierze
   * zrzuty z tej samej chwili.
   */
  const mirror = (): void => {
    for (const hook of world.hooks) if (world.dumpVisible(hook, clock)) noteSeen(hook.dump.key);
    if (mode.kind !== 'produkcja') return;
    mkdirSync(pendingDir, { recursive: true, mode: 0o700 });
    for (const hook of world.hooks) {
      const path = join(pendingDir, `${hook.dump.key}.json`);
      const visible = world.dumpVisible(hook, clock);
      if (visible && !written.has(hook.dump.key)) {
        writeFileSync(path, JSON.stringify(hook.dump), { mode: 0o600 });
        written.add(hook.dump.key);
      } else if (!visible && written.has(hook.dump.key)) {
        unlinkSync(path);
        written.delete(hook.dump.key);
      }
    }
    for (const marker of world.markers) {
      if (markersWritten.has(marker.key) || !world.markerVisible(marker, clock, markersRemoved)) continue;
      mkdirSync(markersDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(markersDir, `${marker.key}.json`), JSON.stringify(marker.file), { mode: 0o600 });
      markersWritten.add(marker.key);
    }
  };

  /** Prośba stała w oknie tolerancji przed chwilą `at` (albo stoi). */
  const stood = (req: Req, at: number): boolean => req.queuedAt !== null && req.queuedAt <= at
    && (req.leftAt === null || req.leftAt >= at - TOLERANCE_MS);
  /** Niezmiennik `zrzut`: stoi (albo stała w oknie) inna prośba tej tożsamości, której zrzutu nikt nie czytał. */
  const excused = (req: Req, at: number): boolean => world.reqs.some((other) => other !== req
    && other.bare === req.bare && stood(other, at) && (other.hook === null || !seenAt.has(other.hook.dump.key)));
  /**
   * Serwer znał prośbę w chwili `read`: jej znacznik był opublikowany (obserwacja z tego odczytu ekranu go przeczyta)
   * albo jej zrzut przeczytała obserwacja nie później niż w tej chwili (także drugiego panelu albo poprzedniego procesu
   * serwera, jak w niezmienniku `zrzut`).
   */
  const knownAt = (req: Req, read: number): boolean => world.published(req, read)
    || (req.hook !== null && (seenAt.get(req.hook.dump.key) ?? Number.POSITIVE_INFINITY) <= read);
  /**
   * Niezmiennik `znacznik`: dialog na wierzchu w chwili `read` rozpoczęcia odczytu ekranu dowodu to inna prośba tej
   * tożsamości, która stoi (albo stała w oknie), a serwer w chwili `read` jej nie znał ani ze znacznika, ani ze zrzutu
   * (bez znanego odczytu dowodu: bez wyjątku). Prośba spoza wierzchu odczytu albo powstała po nim źródłem dowodu nie
   * była, więc niczego nie usprawiedliwia.
   */
  const excusedUnpublished = (req: Req, at: number, read: number | undefined): boolean => read !== undefined
    && (topsAt.get(read) ?? []).some((other) => other !== req && other.bare === req.bare && stood(other, at)
      && !knownAt(other, read));
  /** Naruszenie: prośba, której dialog nie stoi, z sygnałem `standing`, przyciskiem albo podpisaną zgodą. */
  const check = (key: string, what: string, read = proofRead.get(key)): void => {
    const req = world.hookByKey.get(key)?.req;
    if (req === undefined || stood(req, clock)) return;
    const line = `${String(clock - T0)} ms: ${what} — prośba #${String(req.id)} ${req.ident} (${world.describe(req)})`;
    full.push(line);
    if (!excused(req, clock)) weak.push(line);
    if (!excusedUnpublished(req, clock, read)) unpublished.push(`${line}; odczyt dowodu ${String((read ?? NaN) - T0)} ms`);
  };
  /** Warianty: dowód po terminie odczytu ekranu wygasa jak w kodzie produkcyjnym (sygnał bez dowodu). */
  const expire = async (): Promise<void> => {
    if (proc.variant === null) return;
    for (const [key, until] of [...variantUntil]) {
      if (clock < until) continue;
      variantUntil.delete(key);
      await proc.cycle.observe(SID, key, 'unknown', world.hookByKey.get(key)?.dump);
    }
  };
  const checkCards = async (what: string): Promise<void> => {
    await expire();
    for (const card of proc.cycle.cards(SID)) if (card.canAllow) check(card.permId, `${what}: canAllow`);
  };

  const apply = async (ev: Ev): Promise<void> => {
    trace.push(`k${String(stepNo)} ${String(clock - T0)} ms: ${evText(ev)}`);
    switch (ev.kind) {
      case 'ask': world.ask(ev, clock); break;
      case 'desk': world.desk(ev, clock); break;
      case 'truncate':
        world.truncate(ev.keep);
        follower.truncated(world.entries.length, clock);
        break;
      case 'reattach':
        follower.reattach(ev.delay, ev.window);
        if (mode.kind === 'produkcja') await proc.cycle.markReattached(SID);
        break;
      case 'flood': world.flood(clock); break;
      case 'restart':
        world.restart(clock);
        follower.reattach(0, ev.window);
        variantUntil.clear();
        proofRead.clear();
        proc = await newProc(proc.boot + 1, true);
        break;
      case 'jump': break;
      default: world.pickEvent(ev, clock);
    }
    noteRegistry();
  };

  const psOf = (hook: Hook, psNull: number): boolean | null =>
    (((psNull >> (hook.index % 4)) & 1) === 1 ? null : hook.alive);

  /** Kod produkcyjny: dlaczego prośba z wierzchu nie ma przycisku zgody (który warunek dowodu z wierzchu odpadł). */
  const whyNoButton = (key: string, notes: readonly ObsNote[]): string => {
    const note = notes.reduce<ObsNote | null>((best, one) => (best === null
      || (one.screen?.readStartedAt ?? -Infinity) >= (best.screen?.readStartedAt ?? -Infinity) ? one : best), null);
    if (note === null) return 'bez obserwacji';
    const registry = note.registry;
    if (registry.kind !== 'waiting' || registry.dialog !== 'permission' || note.at - registry.at > REGISTRY_MAX_AGE_MS) {
      return `rejestr ${registry.kind}`;
    }
    const screen = note.screen;
    if (screen === null) return 'ekran nieprzeczytany';
    if (!note.complete) return 'odczyt zrzutów niekompletny';
    if (clock >= screen.readStartedAt + CONSENT_PROOF_TTL_MS) return 'termin dowodu minął';
    const pool = proc.cycle.pool(SID);
    if (pool.overflow) return 'sufit puli';
    if (pool.unlockedAt === null || pool.unlockedAt >= screen.readStartedAt) return 'blokada startu';
    if (pool.exitedAt !== null && pool.exitedAt >= screen.readStartedAt) return 'wyjście bez zrzutu po odczycie';
    const top = modelTopOf(screen.text);
    if (top === null || top.tool === null) return 'wierzch pusty albo ucięty';
    if (!fullIdentity(top.tool, top.standing)) {
      const queued = top.tool === 'Edit' ? ' w kolejce' : '';
      return `wierzch bez pełnej tożsamości (${top.tool}${queued})`;
    }
    let own: TopMatch = 'no';
    let twins = 0;
    let subagentTwins = 0;
    let unknown: string | null = null;
    for (const cand of pool.candidates) {
      if (cand.exitAt !== null && cand.exitAt < screen.readStartedAt) continue;
      const match = modelMatchTop(screen.text, cand.dump);
      if (cand.dump.key === key) own = match;
      else if (match === 'match' && cand.dump.agentId !== undefined) subagentTwins += 1;
      else if (match === 'match') twins += 1;
      else if (match === 'unknown') {
        unknown = cand.dump.inputSha256 === null ? 'znacznik bez skrótu'
          : digestOk(cand.dump) ? `${top.tool}: ten sam plik, inna zamiana` : 'zrzut przycięty';
      }
    }
    if (own !== 'match') return 'wierzch odczytu to inna prośba';
    if (unknown !== null) return `niewiadoma w puli (${unknown})`;
    if (twins > 0) return 'bliźniak w puli';
    if (subagentTwins > 0) return 'bliźniak subagenta w puli';
    if (note.signals.get(key) !== 'standing') {
      // Który warunek dowodu własnego odpadł (reguły cienia bez reguły liczącej, jak `consentDialogSignals`).
      const evidence = note.evidence;
      if (evidence === null) return 'dowód własny';
      const verdict = standingProofs({ ...evidence, queue: { kind: 'unknown' } }).find((one) => one.key === key);
      if (verdict?.kind === 'brak') return `dowód własny (${verdict.why})`;
      const dump = evidence.dumps.find((one) => one.key === key);
      return dump !== undefined && evidence.layer1.passed(dump) ? 'dowód własny (transkrypt poszedł dalej)' : 'dowód własny';
    }
    return 'inne';
  };

  try {
    for (const [n, step] of sc.steps.entries()) {
      stepNo = n + 1;
      const start = clock;
      clock = start + 50;
      world.flushLate();
      world.claims(clock);
      noteRegistry();
      await proc.cycle.tick();
      await checkCards(`krok ${String(n + 1)}, przegląd plików`);
      for (const ev of step.events) {
        if (ev.kind === 'jump') {
          clock += JUMP_MS;
          prevLength = world.entries.length;
          await proc.cycle.tick();
          continue;
        }
        clock += 100;
        await apply(ev);
        await checkCards(`krok ${String(n + 1)}, po ${evText(ev)}`);
      }

      // Odczyt rejestru w siatce taktów (manager co 1,5 s), chyba że zdarzenia i poprzednia obserwacja trwały dłużej.
      clock = Math.max(clock + 100, lastRegistryRead + TICK_MS);
      lastRegistryRead = clock;
      const obs = step.obs;
      const truth = obs.regLag ? registryAt(clock - TICK_MS) : registryAt(clock);
      const registry: RegistryEvidence = obs.regUnknown ? { kind: 'unknown', why: 'unread' }
        : truth.kind === 'active' ? { kind: 'active', at: clock } : { kind: 'waiting', dialog: truth.dialog, at: clock };
      let midDone = false;
      const point = async (at: MidAt): Promise<void> => {
        if (midDone || at !== obs.midAt) return;
        midDone = true;
        for (const ev of obs.mid) {
          clock += 20;
          await apply(ev);
        }
        if (obs.mid.length > 0) await checkCards(`krok ${String(n + 1)}, w trakcie obserwacji`);
      };
      const notes: ObsNote[] = [];
      let transcriptOfStep: TranscriptRead | undefined;
      const readTranscript = (): TranscriptRead => {
        transcriptOfStep ??= follower.read(world.entries, obs.follower, prevLength, clock);
        return transcriptOfStep;
      };

      interface Panel {
        readonly obsDelay: number;
        readonly screenDelay: number;
        readonly psDelay: number;
        readonly gate: Promise<void> | null;
        /** Kod produkcyjny: uruchamiane w pierwszym kroku kolejki obserwacji (po sygnałach). */
        beforeQueue: (() => Promise<void>) | null;
      }

      /** Jedna obserwacja kolejnością drivera: ekran, transkrypt, zrzuty, `ps`, sygnały, cykl. */
      const observePanel = async (panel: Panel): Promise<void> => {
        clock += panel.obsDelay;
        await point('beforeScreen');
        let screen: ConsentScreenRead | null = null;
        let view: ScreenView | null = null;
        if (registry.kind === 'waiting' && registry.dialog === 'permission') {
          const readStartedAt = clock;
          const snap = world.screenSnap();
          const top = world.queue[0];
          if (top !== undefined) topsAt.set(readStartedAt, [...(topsAt.get(readStartedAt) ?? []), top]);
          clock += panel.screenDelay;
          await point('duringScreen');
          if (obs.screen !== 'unknown') {
            screen = { text: renderScreen(snap, obs.screen === 'partial'), readStartedAt };
            view = { text: screen.text, at: readStartedAt };
          }
        }
        const transcript = readTranscript();
        mirror();
        if (proc.variant === null) {
          const cycle = proc.cycle;
          const liveness: ProcessLiveness = async (processes) => {
            if (panel.gate !== null) await panel.gate;
            clock += panel.psDelay;
            await point('duringPs');
            return new Map(processes.map((one) => {
              const hook = world.hookByPid.get(one.pid);
              return [one.pid, hook === undefined ? false : psOf(hook, obs.psNull)];
            }));
          };
          const port: ConsentCycle = {
            ...cycle,
            observe: async (...args: Parameters<ConsentCycle['observe']>) => {
              const run = panel.beforeQueue;
              panel.beforeQueue = null;
              if (run !== null) await run();
              const [, key, signal, , , observed] = args;
              if (signal === 'standing' && observed !== undefined) noteProof(key, observed.at);
              return cycle.observe(...args);
            },
          };
          await observeConsentSession(port, {
            dataDir, sessionId: SID, liveness, registry, transcript, screen, now, matchTop: modelMatchTop,
          }, (observation) => {
            for (const [key, signal] of observation.signals) {
              if (signal === 'standing') check(key, 'stoi', screen?.readStartedAt);
            }
            notes.push({
              screen, registry, signals: observation.signals, complete: observation.complete, at: clock,
              evidence: observation.evidence,
            });
          });
          return;
        }
        const variant = proc.variant;
        const cycle = proc.cycle;
        const dumps = world.hooks.filter((hook) => world.dumpVisible(hook, clock)).map((hook) => hook.dump)
          .sort((a, b) => a.at - b.at);
        const markers = world.markers.filter((marker) => world.markerVisible(marker, clock, markersRemoved));
        const { checks, removed } = variant.pool({ now: clock, dumps, markers, registry });
        for (const key of removed) markersRemoved.add(key);
        // `ps` (i zdarzenia świata w jego trakcie) tylko przy zrzutach albo hookach kandydatów subagenta ze znacznikiem
        // do sprawdzenia, jak `observeConsentSession`.
        const asked: PsCheck[] = [...dumps, ...checks];
        if (asked.length > 0) {
          if (panel.gate !== null) await panel.gate;
          clock += panel.psDelay;
          await point('duringPs');
        }
        const ps = (pid: number): boolean | null => {
          const hook = world.hookByPid.get(pid);
          return hook === undefined ? false : psOf(hook, obs.psNull);
        };
        variant.dead(asked, ps, clock);
        const alive = new Map(dumps.map((dump) => [dump.key, ps(dump.pid)]));
        const signals = variant.signals({
          now: clock, dumps, alive, registry, transcript, screen: view,
          markers: mode.kind === 'wariant' && mode.plus ? markers : null,
        });
        for (const [key, signal] of signals) if (signal === 'standing') check(key, 'stoi', view?.at);
        const afterClaim = (key: string): ConsentAfterClaim => ({
          registry,
          otherLive: dumps.some((dump) => dump.key !== key && dump.agentId === undefined && alive.get(dump.key) === true),
        });
        for (const dump of dumps) {
          const signal = signals.get(dump.key) ?? 'unknown';
          await observeVariantStep(cycle, SID, dump, signal, afterClaim(dump.key), view === null ? null : view.at);
          if (signal === 'standing' && view !== null) {
            variantUntil.set(dump.key, view.at + CONSENT_PROOF_TTL_MS);
            noteProof(dump.key, view.at);
          } else {
            variantUntil.delete(dump.key);
          }
        }
        const keys = new Set(dumps.map((dump) => dump.key));
        for (const card of cycle.cards(SID)) {
          if (keys.has(card.permId) || FINAL.includes(card.state)) continue;
          variantUntil.delete(card.permId);
          await cycle.observe(SID, card.permId, 'dead', undefined, afterClaim(card.permId));
        }
      };

      const first: Panel = {
        obsDelay: obs.obsDelay, screenDelay: obs.screenDelay, psDelay: obs.psDelay, gate: null, beforeQueue: null,
      };
      const second = obs.second;
      const secondPanel = (gate: Promise<void> | null): Panel => ({
        obsDelay: 0, screenDelay: second?.screenDelay ?? 0, psDelay: second?.psDelay ?? 0, gate, beforeQueue: null,
      });
      if (second === null) {
        await observePanel(first);
      } else if (proc.variant !== null) {
        // Warianty: drugi panel po pierwszym (wzorzec nie zna obserwacji równoległych).
        await observePanel(first);
        clock += second.gap;
        await observePanel(secondPanel(null));
      } else if (second.at === 'beforeQueue') {
        const gate = deferred();
        let other: Promise<void> | null = null;
        first.beforeQueue = async () => {
          clock += second.gap;
          other = observePanel(secondPanel(gate.promise));
          await settle();
        };
        await observePanel(first);
        gate.resolve();
        if (other === null) {
          clock += second.gap;
          await observePanel(secondPanel(null));
        } else {
          await other;
        }
      } else {
        const gateA = deferred();
        const gateB = deferred();
        const a = observePanel({ ...first, gate: gateA.promise });
        await settle();
        clock += second.gap;
        const b = observePanel(secondPanel(gateB.promise));
        await settle();
        if (second.first === 'A') {
          gateA.resolve();
          await a;
          gateB.resolve();
          await b;
        } else {
          gateB.resolve();
          await b;
          gateA.resolve();
          await a;
        }
      }
      await checkCards(`krok ${String(n + 1)}, po obserwacji`);

      const standingNow = world.standing();
      for (const req of world.reqs) {
        const hook = req.hook;
        if (req.thread !== 'main' || hook === null || hook.boot !== proc.boot || !hook.registered || !hook.alive
          || !hook.onDisk || !hook.waiting || req.cut || !standingNow.has(req.id) || !prevStanding.has(req.id)) continue;
        // Po decyzji z telefonu przycisku zgody nie ma z założenia: takt nie wchodzi do kosztu.
        if ((proc.cycle.record(SID, hook.dump.key)?.decision ?? null) !== null) continue;
        const button = proc.cycle.card(SID, hook.dump.key)?.canAllow === true;
        tally.any += 1;
        eligible.add(req.id);
        if (button) {
          tally.anyButton += 1;
          withButton.add(req.id);
        }
        if (world.queue[0] === req) {
          tally.top += 1;
          const byTool = tally.tools.get(req.tool) ?? [0, 0];
          tally.tools.set(req.tool, [byTool[0] + 1, byTool[1] + (button ? 1 : 0)]);
          if (button) tally.topButton += 1;
          else if (reasons && mode.kind === 'produkcja') bump(tally.why, whyNoButton(hook.dump.key, notes));
        }
      }

      // Telefon wybiera kartę z przyciskiem zaraz po obserwacji, a decyzja dochodzi po opóźnieniu także wtedy, gdy
      // przycisku już nie ma: `decide` i `release` sprawdzają widok karty same.
      const phone = step.phone;
      if (phone !== null) {
        const cards = proc.cycle.cards(SID).filter((card) => (phone.act === 'allow' ? card.canAllow
          : phone.act === 'deny' ? card.canDeny : card.canRelease));
        const card = cards[phone.pick % Math.max(cards.length, 1)];
        clock += phone.delay;
        await checkCards(`krok ${String(n + 1)}, przed decyzją z telefonu`);
        if (card !== undefined) {
          const still = proc.cycle.card(SID, card.permId);
          const button = phone.act === 'allow' ? still?.canAllow : phone.act === 'deny' ? still?.canDeny
            : still?.canRelease;
          const outcome = phone.act === 'release' ? await proc.cycle.release(SID, card.permId)
            : await proc.cycle.decide(SID, card.permId, phone.act);
          phoneLog.push(`k${String(n + 1)} ${phone.act} ${world.hookByKey.get(card.permId)?.req.ident ?? card.permId}`
            + `${button === true ? '' : ' (bez przycisku w chwili decyzji)'}: ${outcome.ok ? 'ok' : outcome.error}`);
          if (phone.act === 'allow' && outcome.ok) check(card.permId, 'podpisana zgoda');
        }
      }

      prevStanding = standingNow;
      prevLength = world.entries.length;
    }
  } finally {
    if (mode.kind === 'produkcja') rmSync(dataDir, { recursive: true, force: true });
  }
  tally.dialogs = eligible.size;
  tally.dialogsButton = withButton.size;
  const violations = invariant === 'zrzut' ? weak : invariant === 'znacznik' ? unpublished : full;
  return { violations, full, weak, unpublished, tally, trace, phone: phoneLog };
}

// ---------------------------------------------------------------- generatory

type Profile = 'zwykla' | 'zwykla-sub' | 'rzadkie' | 'rzadkie-bez-sieci';

/**
 * Profil publikacji znacznika: `przed-odczytem` = świat publikuje znacznik i zrzut zaraz
 * po starcie hooka (δ = 0, bez braków); `okno-startu` = δ od 50 do 100 ms, a w rzadkich przypadkach także prośba bez
 * znacznika (sygnał przed zapisem, odmowa bramki, błąd zapisu).
 */
type Publication = 'przed-odczytem' | 'okno-startu';

function weighted<T>(...pairs: readonly (readonly [T, number])[]): fc.Arbitrary<T> {
  return fc.oneof(...pairs.map(([value, weight]) => ({ arbitrary: fc.constant(value), weight })));
}

/**
 * `zwykla` = zwykła praca: wątek główny, hooki czekają, decyzje przy biurku i z telefonu, wykonania, rejestr o takt
 * w tyle, follower o takt w tyle, opóźnienia obserwacji w zapasie terminu (razem do 450 ms) i zdarzenia świata w ich
 * trakcie. `zwykla-sub` = zwykła praca z subagentami w trybie `main` (hook subagenta pisze zrzut i znacznik i wychodzi
 * bez czekania, dialog subagenta w tle staje po wyjściu hooka). `rzadkie` = wszystkie pokrętła modelu (opóźnienia
 * ponad termin, restart procesu, drugi panel, sieć piaskownicy, `canon.mjs` bez skrótu); `rzadkie-bez-sieci` = to samo
 * bez dialogu sieci piaskownicy. `publication` = profil publikacji znacznika ({@link Publication}); przy
 * `przed-odczytem` pola publikacji są stałe, więc scenariusze z danym ziarnem nie zależą od publikacji.
 */
function scenarioArb(profile: Profile, commands = 2, publication: Publication = 'przed-odczytem'): fc.Arbitrary<Scenario> {
  const normal = profile === 'zwykla' || profile === 'zwykla-sub';
  const window = publication === 'okno-startu';
  const tools: (readonly [ToolName, number])[] = [['Bash', 4], ['ExitPlanMode', 1], ['Edit', 1], ['Read', 1]];
  if (profile === 'rzadkie') tools.push(['SandboxNetwork', 1]);
  const askArb: fc.Arbitrary<AskEv> = fc.record({
    kind: fc.constant('ask' as const),
    thread: profile === 'zwykla' ? fc.constant<Thread>('main') : weighted<Thread>(['main', 4], ['fg', 1], ['bg', 1]),
    tool: weighted<ToolName>(...tools),
    cmd: fc.integer({ min: 0, max: commands - 1 }),
    desc: fc.integer({ min: 0, max: 1 }),
    hook: normal ? fc.constant<'waits' | 'skip'>('waits') : weighted<'waits' | 'skip'>(['waits', 3], ['skip', 1]),
    entry: weighted<'before' | 'withResult'>(['before', 2], ['withResult', 1]),
    cut: normal ? fc.constant(false) : weighted([false, 5], [true, 1]),
    front: normal ? fc.constant(false) : weighted([false, 4], [true, 1]),
    late: normal ? fc.constant(false) : weighted([false, 5], [true, 1]),
    delta: window ? fc.integer({ min: 50, max: 100 }) : fc.constant(0),
    marker: window && !normal ? weighted<AskEv['marker']>(['ok', 5], ['missing', 1]) : fc.constant<AskEv['marker']>('ok'),
    canon: normal ? fc.constant(true) : weighted([true, 7], [false, 1]),
  });
  const deskArb: fc.Arbitrary<DeskEv> = fc.record({
    kind: fc.constant('desk' as const),
    act: weighted<DeskEv['act']>(['allow', 3], ['deny', 1], ['esc', 1]),
    others: fc.constantFrom<DeskEv['others']>('exit', 'orphan'),
    writeCancelled: fc.boolean(),
  });
  const pickArb = (kind: PickEv['kind']): fc.Arbitrary<PickEv> => fc.record({ kind: fc.constant(kind), pick: fc.nat(3) });
  const events: { arbitrary: fc.Arbitrary<Ev>; weight: number }[] = [
    { arbitrary: askArb, weight: 6 }, { arbitrary: deskArb, weight: 4 }, { arbitrary: pickArb('finish'), weight: 2 },
  ];
  const mids: { arbitrary: fc.Arbitrary<MidEv>; weight: number }[] = [
    { arbitrary: askArb, weight: 2 }, { arbitrary: deskArb, weight: 2 }, { arbitrary: pickArb('finish'), weight: 1 },
  ];
  if (!normal) {
    events.push(
      { arbitrary: pickArb('kill'), weight: 1 }, { arbitrary: pickArb('exit'), weight: 1 },
      { arbitrary: pickArb('freeze'), weight: 1 },
      { arbitrary: fc.record({ kind: fc.constant('truncate' as const), keep: fc.nat(8) }), weight: 1 },
      {
        arbitrary: fc.record({
          kind: fc.constant('reattach' as const), window: fc.nat(4), delay: fc.integer({ min: 0, max: 2 }),
        }), weight: 1,
      },
      { arbitrary: fc.constant<Ev>({ kind: 'flood' }), weight: 1 },
      { arbitrary: fc.constant<Ev>({ kind: 'jump' }), weight: 1 },
      { arbitrary: fc.record({ kind: fc.constant('restart' as const), window: fc.nat(4) }), weight: 1 },
    );
    mids.push({ arbitrary: pickArb('kill'), weight: 1 }, { arbitrary: pickArb('exit'), weight: 1 });
  }
  const secondArb: fc.Arbitrary<SecondPanel> = fc.record({
    gap: weighted([0, 1], [100, 2], [600, 1]),
    screenDelay: weighted([0, 2], [100, 2], [900, 1]),
    psDelay: weighted([0, 2], [150, 2], [2_500, 1]),
    at: weighted<SecondPanel['at']>(['duringPs', 1], ['beforeQueue', 1]),
    first: fc.constantFrom<SecondPanel['first']>('A', 'B'),
  });
  const obsArb: fc.Arbitrary<Obs> = fc.record({
    regLag: weighted([false, 3], [true, 1]),
    regUnknown: normal ? fc.constant(false) : weighted([false, 6], [true, 1]),
    screen: normal ? fc.constant<Obs['screen']>('full')
      : weighted<Obs['screen']>(['full', 6], ['unknown', 1], ['partial', 1]),
    follower: normal ? weighted<Obs['follower']>(['normal', 4], ['lag', 1])
      : weighted<Obs['follower']>(['normal', 4], ['lag', 1], ['null', 1]),
    psNull: normal ? fc.constant(0)
      : fc.oneof({ arbitrary: fc.constant(0), weight: 5 }, { arbitrary: fc.integer({ min: 1, max: 15 }), weight: 1 }),
    obsDelay: normal ? weighted([0, 3], [50, 1]) : weighted([0, 3], [50, 1], [700, 1]),
    screenDelay: normal ? weighted([0, 2], [100, 2], [250, 1])
      : weighted([0, 2], [100, 2], [250, 1], [900, 1], [2_500, 1]),
    psDelay: normal ? weighted([0, 2], [50, 2], [150, 1]) : weighted([0, 2], [50, 2], [150, 1], [600, 1], [2_500, 1]),
    mid: fc.oneof(
      { arbitrary: fc.constant<readonly MidEv[]>([]), weight: 3 },
      { arbitrary: fc.oneof(...mids).map((ev): readonly MidEv[] => [ev]), weight: 1 },
    ),
    midAt: weighted<MidAt>(['beforeScreen', 1], ['duringScreen', 2], ['duringPs', 2]),
    second: normal ? fc.constant(null)
      : fc.oneof({ arbitrary: fc.constant(null), weight: 5 }, { arbitrary: secondArb, weight: 1 }),
  });
  const phoneArb: fc.Arbitrary<PhoneAct | null> = fc.option(fc.record({
    pick: fc.nat(3), act: weighted<PhoneAct['act']>(['allow', 3], ['deny', 1], ['release', 1]),
    delay: normal ? weighted([0, 3], [300, 1]) : weighted([0, 3], [300, 1], [900, 1], [2_500, 1]),
  }), { nil: null, freq: 2 });
  const stepArb: fc.Arbitrary<Step> = fc.record({
    events: fc.array(fc.oneof(...events), { maxLength: 2, size: 'max' }), obs: obsArb, phone: phoneArb,
  });
  return fc.record({
    subagentsWait: normal ? fc.constant(false) : fc.boolean(),
    netLikePermission: normal ? fc.constant(false) : fc.boolean(),
    // Tryb `auto` z regułą `ask` albo tryb zwykły: obie drogi tożsamości wierzchu `Bash` w kolejce w obu profilach.
    askRule: fc.boolean(),
    steps: fc.array(stepArb, { minLength: 2, maxLength: 14, size: 'max' }),
  });
}

// ---------------------------------------------------------------- opis kontrprzykładu

const OBS: Obs = {
  regLag: false, regUnknown: false, screen: 'full', follower: 'normal', psNull: 0, obsDelay: 0, screenDelay: 0,
  psDelay: 0, mid: [], midAt: 'duringPs', second: null,
};

function evText(ev: Ev): string {
  const fields = Object.entries(ev).filter(([name]) => name !== 'kind').map(([name, value]) => `${name}=${String(value)}`);
  return fields.length === 0 ? ev.kind : `${ev.kind}(${fields.join(',')})`;
}

function obsText(obs: Obs): string {
  const out = Object.entries(obs).filter(([name, value]) => name !== 'midAt' && name !== 'mid'
    && JSON.stringify(OBS[name as keyof Obs]) !== JSON.stringify(value))
    .map(([name, value]) => `${name}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
  if (obs.mid.length > 0) out.push(`mid@${obs.midAt}=${obs.mid.map(evText).join(';')}`);
  return out.length === 0 ? 'obs zwykła' : out.join(',');
}

function describeScenario(sc: Scenario): string {
  const lines = [`subagentsWait=${String(sc.subagentsWait)} netLikePermission=${String(sc.netLikePermission)}`
    + ` askRule=${String(sc.askRule)}`];
  sc.steps.forEach((one, i) => {
    const events = one.events.map(evText).join('; ') || '—';
    const phone = one.phone === null ? ''
      : ` | telefon ${one.phone.act}#${String(one.phone.pick)}${one.phone.delay > 0 ? `+${String(one.phone.delay)}ms` : ''}`;
    lines.push(`  k${String(i + 1)}: ${events} | ${obsText(one.obs)}${phone}`);
  });
  return lines.join('\n');
}

/** Przebieg z naruszeniem pełnego niezmiennika i bez naruszeń wybranego: numer przebiegu (ścieżka) i naruszenie. */
interface BenignRun { readonly run: number; readonly violation: string }

/**
 * Wynik właściwości: kontrprzykład z naruszeniem niezmiennika, osobno wyjątki z modelu albo z kodu, a przy niezmienniku
 * osłabionym przebiegi przypadku łagodnego (pełny niezmiennik naruszony, wybrany nie) przed pierwszym
 * kontrprzykładem.
 */
interface PropertyResult {
  readonly found: boolean;
  readonly errors: readonly string[];
  readonly benign: readonly BenignRun[];
}

/**
 * Sprawdzenie właściwości ze stałym ziarnem; przy `RAMA_POKAZ=1` minimalny kontrprzykład, jego naruszenia i czas.
 * Wyjątek w przebiegu nie jest kontrprzykładem: idzie do `errors`, a test z `it.fails` kończy się wtedy bez błędu, więc
 * vitest go czerwieni (awaria modelu nie udaje znalezionego naruszenia). Numer przebiegu w {@link BenignRun} to ścieżka
 * powtórki fast-check (`fc.check(…, { seed, path: String(run) })`).
 */
interface PropertyOptions {
  readonly profile: Profile;
  readonly mode: Mode;
  readonly invariant?: Invariant;
  readonly publication?: Publication;
}

async function checkProperty(label: string, options: PropertyOptions): Promise<PropertyResult> {
  const { profile, mode, invariant = 'pelny', publication = 'przed-odczytem' } = options;
  const errors: string[] = [];
  const benignRuns: BenignRun[] = [];
  let run = -1;
  let failed = false;
  const started = Date.now();
  const details = await fc.check(fc.asyncProperty(scenarioArb(profile, 2, publication), async (sc) => {
    // Po pierwszym kontrprzykładzie fast-check tylko zmniejsza: numery przebiegów od tej chwili nie są ścieżkami.
    if (!failed) run += 1;
    try {
      const result = await runScenario(sc, mode, invariant);
      if (result.violations.length > 0) failed = true;
      else if (!failed && result.full.length > 0) benignRuns.push({ run, violation: result.full[0] ?? '' });
      return result.violations.length === 0;
    } catch (err) {
      errors.push(err instanceof Error ? err.stack ?? err.message : String(err));
      return true;
    }
  }), { seed: SEED, numRuns: RUNS });
  if (SHOW) {
    const took = `${String(((Date.now() - started) / 1000).toFixed(1))} s`;
    const [counterexample] = details.counterexample ?? [];
    if (errors.length > 0) console.log(`[rama] ${label}: wyjątek w przebiegu\n${errors[0] ?? ''}`);
    if (counterexample === undefined) {
      console.log(`[rama] ${label}: 0 kontrprzykładów w ${String(details.numRuns)} przebiegach (ziarno ${String(SEED)},`
        + ` ${took})`);
    } else {
      const again = await runScenario(counterexample, mode, invariant);
      console.log(`[rama] ${label}: kontrprzykład po ${String(details.numRuns)} przebiegach, ${String(details.numShrinks)}`
        + ` zmniejszeń, ścieżka ${String(details.counterexamplePath)} (ziarno ${String(SEED)}, ${took})`
        + `\n${describeScenario(counterexample)}\n  naruszenia:\n    ${again.violations.join('\n    ')}`);
    }
  }
  return { found: details.failed, errors, benign: benignRuns };
}

// ---------------------------------------------------------------- korpus regresji

const step = (events: readonly Ev[], over: Partial<Obs> = {}, phone: PhoneAct | null = null): Step => ({
  events, obs: { ...OBS, ...over }, phone,
});
const ask = (over: Partial<AskEv> = {}): AskEv => ({
  kind: 'ask', thread: 'main', tool: 'Bash', cmd: 0, desc: 0, hook: 'waits', entry: 'before', cut: false, front: false,
  late: false, delta: 0, marker: 'ok', canon: true, ...over,
});
const desk = (act: DeskEv['act'] = 'allow'): DeskEv => ({ kind: 'desk', act, others: 'orphan', writeCancelled: true });
const finish = (pick = 0): PickEv => ({ kind: 'finish', pick });
const phoneAct = (pick: number, act: PhoneAct['act'], delay = 0): PhoneAct => ({ pick, act, delay });
/**
 * Corpus scenario. With the `Ask rule` line by default, so the cases keep their recorded worlds; the line does not
 * change the proof (a queued `Bash` top has the full identity with and without it).
 */
const scenario = (steps: readonly Step[], over: Partial<Omit<Scenario, 'steps'>> = {}): Scenario => ({
  subagentsWait: false, netLikePermission: false, askRule: true, steps, ...over,
});

/** Counterexamples for a counting rule: request B, decided at the desk, would get `stoi`. */
const CORPUS_VIOLATING: readonly (readonly [string, Scenario])[] = [
  ['`ps` bez odpowiedzi dla hooka stojącej prośby A wyjmuje A z puli, B przy biurku z otwartym `tool_use` stoi', scenario([
    step([ask({ cmd: 1 })]), step([ask({ cmd: 0 })]), step([desk('allow')], { psNull: 0b10 }), step([], { psNull: 0b10 }),
  ])],
  ['A bez wpisu (`tool_use` razem z wynikiem) dostaje `transkrypt-skrot` wobec otwartego B przy biurku, B stoi', scenario([
    step([ask({ cmd: 1 })]), step([desk('allow'), ask({ cmd: 0, entry: 'withResult' })]), step([]),
  ])],
  ['dwa `ExitPlanMode` i jedno zamknięcie po nazwie: oba wypadają z puli, B przy biurku stoi', scenario([
    step([ask({ cmd: 1 })]), step([desk('allow')]),
    step([ask({ tool: 'ExitPlanMode', cmd: 0 }), ask({ tool: 'ExitPlanMode', cmd: 1 })]),
    step([desk('allow'), finish(1)]), step([]),
  ])],
  ['A pomija czekanie (`skipWaiting`) i nie ma zrzutu, B przy biurku stoi', scenario([
    step([ask({ cmd: 1 })]), step([desk('allow'), ask({ cmd: 0, hook: 'skip' })]), step([]),
  ])],
  ['prośba subagenta (hook bez czekania) nie ma zrzutu, B przy biurku stoi', scenario([
    step([ask({ cmd: 1 })]), step([desk('allow'), ask({ thread: 'fg', cmd: 0 })]), step([]),
  ])],
  ['A odebrana zgoda przepada (`claim-timeout`), `re-attached`, B przed A przy biurku stoi', scenario([
    step([ask({ cmd: 0 }), { kind: 'freeze', pick: 0 }], {}, phoneAct(0, 'allow')),
    step([{ kind: 'jump' }]), step([{ kind: 'reattach', window: 0, delay: 0 }]),
    step([ask({ cmd: 1, front: true }), desk('allow')]), step([]),
  ])],
  ['zwolnienie A do terminala z telefonu: hook A wychodzi, dialog A stoi bez zrzutu, B przy biurku stoi', scenario([
    step([ask({ cmd: 1 }), ask({ cmd: 0 })], {}, phoneAct(1, 'release')), step([desk('allow')]), step([]),
  ])],
];

/** Cases closed by the proof-loss facts in the cycle. */
const CORPUS_PASSING: readonly (readonly [string, Scenario])[] = [
  ['zalew zamknięć wypiera wynik B przy biurku, potem identyczna A', scenario([
    step([ask({ cmd: 1 })]), step([desk('allow')]), step([finish()]), step([{ kind: 'flood' }]),
    step([ask({ cmd: 1 })]), step([]), step([]),
  ])],
  ['okno ogona nowego followera po `re-attached` bez wyniku B, A bez wpisu', scenario([
    step([ask({ cmd: 1 })]), step([desk('allow')]), step([finish()]), step([ask({ cmd: 0, entry: 'withResult' })]),
    step([{ kind: 'reattach', window: 1, delay: 0 }]), step([]), step([]),
  ])],
  ['skrócenie transkryptu do zera po wyniku B, A bez wpisu', scenario([
    step([ask({ cmd: 1 })]), step([desk('allow')]), step([finish()]), step([{ kind: 'truncate', keep: 0 }]),
    step([ask({ cmd: 0, entry: 'withResult' })]), step([]), step([]),
  ])],
  ['skrócenie zostawia `tool_use` B przy biurku, A bez wpisu', scenario([
    step([ask({ cmd: 1 }), ask({ cmd: 0 })]), step([desk('allow'), desk('deny')]), step([{ kind: 'truncate', keep: 1 }]),
    step([ask({ cmd: 0, entry: 'withResult' })]), step([]), step([]),
  ])],
  ['`re-attached` i transkrypt nieznany przez dwa takty, A po powrocie gniazda', scenario([
    step([ask({ cmd: 1 })]), step([desk('allow')]), step([{ kind: 'reattach', window: 0, delay: 2 }]),
    step([ask({ cmd: 0, entry: 'withResult' })]), step([]), step([]), step([]),
  ])],
  ['hook A po `re-attached` przed pierwszym odczytem i skrócenie pliku', scenario([
    step([ask({ cmd: 1 })]), step([desk('allow')]), step([{ kind: 'reattach', window: 0, delay: 1 }]),
    step([ask({ cmd: 0, entry: 'withResult' }), { kind: 'truncate', keep: 0 }]), step([]), step([]),
  ])],
];

/**
 * Przypadki ram wariantów: ekran sprzed pewnego zamknięcia (odmowa przy biurku w trakcie odczytu ekranu). Bez puli
 * z chwili odczytu ekranu B+ i A+ dają tu dowód sierocie B (znalezione w zwykłej pracy po kilku tysiącach przebiegów).
 */
const CORPUS_VARIANTS: readonly (readonly [string, Scenario])[] = [
  ['ekran sprzed odmowy przy biurku prośby o tej samej komendzie (inny opis), B przy biurku obok', scenario([
    step([ask({ cmd: 0, desc: 0 })]), step([desk('allow'), ask({ cmd: 0, desc: 1 })]), step([]),
    step([], { regLag: true, mid: [desk('deny')], midAt: 'duringScreen' }), step([]),
  ])],
];

/** Korpus 14 przypadków: kontrprzykłady reguły liczącej, przypadki zamknięte wcześniej i przypadek wariantów. */
const CORPUS: readonly (readonly [string, Scenario])[] = [...CORPUS_VIOLATING, ...CORPUS_PASSING, ...CORPUS_VARIANTS];

/**
 * Kontrprzykład zwykłej pracy z pełnym niezmiennikiem bez znaczników (ziarno 20261108, 50 000 przebiegów,
 * po zmniejszeniu): prośba A o komendę X rozstrzygnięta przy biurku (hook sierota żyje ze zrzutem),
 * identyczna prośba B, a Esc przy biurku w trakcie odczytu ekranu z dialogiem B: hook B wychodzi i usuwa zrzut, zanim
 * obserwacja przeczytała zrzuty. Bez znacznika pula zna tylko zrzut A, więc wierzch z ramką X daje dowód A, której
 * dialog nie stoi (przypadek łagodny wzorca B). Znacznik B, opublikowany przed odczytem ekranu, zostaje na dysku po
 * wyjściu hooka, więc pula zna B i dowodu nie ma nikt.
 */
const NORMAL_BENIGN: Scenario = scenario([
  step([ask({ cmd: 1, entry: 'withResult' }), desk('allow')], { follower: 'lag', psDelay: 150 }),
  step([ask({ cmd: 1 })], {
    follower: 'lag', obsDelay: 50, screenDelay: 250, psDelay: 150,
    mid: [{ kind: 'desk', act: 'esc', others: 'orphan', writeCancelled: false }], midAt: 'duringScreen',
  }),
  step([]),
  step([], { follower: 'lag', obsDelay: 50, screenDelay: 100 }),
]);

/**
 * Sprawdzian reguły przycięcia abstrakcji: prośba A o komendę X rozstrzygnięta przy biurku (hook sierota żyje ze
 * zrzutem), identyczna prośba B z przyciętym zrzutem stoi na wierzchu. Przycięty zrzut daje `unknown`, więc dowodu nie
 * ma nikt; abstrakcja z `no` dla przyciętego zrzutu daje dowód sierocie A. Generator trafia ten układ rzadko (profil
 * rzadki: pierwszy raz po kilkunastu tysiącach przebiegów), więc stoi tu jawnie.
 */
const CUT_TWIN: Scenario = scenario([
  step([ask({ cmd: 0 }), desk('allow')]), step([ask({ cmd: 0, cut: true })]), step([]), step([]),
]);

/**
 * Okno startu: sierota A o komendę X, C o inną komendę stoi, a B o X pomija czekanie i staje
 * na wierzchu w chwili rozpoczęcia odczytu ekranu; znacznik B świat publikuje `delta` ms po starcie hooka, a odczyt
 * zrzutów i znaczników idzie zaraz po ekranie. Przy δ = 0 pula zna B ze znacznika i dowodu nie ma nikt; przy δ = 100 pula
 * B nie zna, więc dowód dostaje A: kontrprzykład pełnego niezmiennika z bliźniakiem nieopublikowanym w chwili startu
 * odczytu (przypadek łagodny w granicy gwarancji).
 */
const startWindow = (delta: number): Scenario => scenario([
  step([ask({ cmd: 0, entry: 'withResult' }), desk('allow')]), step([ask({ cmd: 1 })]),
  step([], { mid: [ask({ cmd: 0, hook: 'skip', front: true, delta })], midAt: 'beforeScreen' }), step([]),
]);

/**
 * Bliźniaki ze znacznikiem: prośba A o komendę X rozstrzygnięta przy biurku (hook sierota żyje ze zrzutem,
 * wpis `tool_use` dopiero z wynikiem), potem bliźniak B o X na wierzchu bez zrzutu. Pula zna B tylko ze znacznika: wierzch
 * z ramką X pasuje do obu albo B daje `unknown`, więc dowodu nie ma nikt. Bez znacznika (wzorzec B) dowód dostaje A.
 */
const MARKER_TWINS: readonly (readonly [string, Scenario])[] = [
  ['subagent na pierwszym planie w trybie `main` (hook pomija czekanie)', scenario([
    step([ask({ cmd: 0, entry: 'withResult' }), desk('allow')]), step([ask({ thread: 'fg', cmd: 0 })]), step([]), step([]),
  ])],
  ['`canon.mjs` bez skrótu: znacznik z `inputSha256: null`', scenario([
    step([ask({ cmd: 0, entry: 'withResult' }), desk('allow')]), step([ask({ cmd: 0, canon: false })]), step([]),
    step([]),
  ])],
  ['wątek główny pomija czekanie (`skipWaiting`) i staje na wierzchu w chwili rozpoczęcia odczytu', startWindow(0)],
];

/**
 * Sprawdzian predykatu przypadku łagodnego niezmiennika `zrzut`: prośba A o komendę X rozstrzygnięta przy biurku (hook
 * sierota żyje ze zrzutem), identyczna prośba B zwolniona z telefonu do terminala: hook B wychodzi i usuwa zrzut, dialog
 * B stoi. Zrzut B serwer przeczytał, więc pula, która gubi kandydata po zniknięciu zrzutu, daje dowód sierocie A poza
 * przypadkiem łagodnym.
 */
const RELEASED_TWIN: Scenario = scenario([
  step([ask({ cmd: 0, entry: 'withResult' }), desk('allow')]), step([ask({ cmd: 0 })], {}, phoneAct(1, 'release')),
  step([]), step([]),
]);

/**
 * Sprawdziany negatywne predykatu niezmiennika `znacznik` na przebiegu {@link RELEASED_TWIN} z pulą, która gubi
 * bliźniaka po zniknięciu zrzutu (wzorzec B z błędem): dowód sieroty A z wierzchu z dialogiem B nie należy do przypadku
 * łagodnego, bo w chwili rozpoczęcia odczytu dowodu serwer znał B.
 *
 * - bez znacznika: B nie ma znacznika (odmowa bramki albo błąd zapisu), ale jego zrzut serwer przeczytał takt wcześniej
 *   (brak znacznika cofa B do wzorca B, a tam przypadek łagodny to zrzut, którego nikt nie czytał);
 * - prośba po odczycie: identyczna prośba C powstaje w trakcie `ps`, po rozpoczęciu odczytu ekranu z dialogiem B, i jej
 *   znacznik jeszcze nie jest opublikowany; C nie mogła być źródłem dowodu, a B na wierzchu ma opublikowany znacznik.
 */
const RELEASED_TWIN_KNOWN: readonly (readonly [string, Scenario])[] = [
  ['bliźniak bez znacznika ze zrzutem przeczytanym przez serwer', scenario([
    step([ask({ cmd: 0, entry: 'withResult' }), desk('allow')]),
    step([ask({ cmd: 0, delta: 100, marker: 'missing' })], {}, phoneAct(1, 'release')), step([]), step([]),
  ])],
  ['bliźniak powstały po rozpoczęciu odczytu dowodu', scenario([
    step([ask({ cmd: 0, entry: 'withResult' }), desk('allow')]), step([ask({ cmd: 0 })], {}, phoneAct(1, 'release')),
    step([], { mid: [ask({ cmd: 0, hook: 'skip', delta: 100 })], midAt: 'duringPs' }),
  ])],
];

// ---------------------------------------------------------------- zgodność abstrakcji z produkcyjnym `matchTop`

const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

/** Ramka komendy dialogu `Bash` z fixture'a podmieniona na jedną linię `line`. */
function withBashFrame(text: string, line: string): string {
  const lines = text.split('\n');
  const top = lines.findIndex((one) => one.startsWith('╌'));
  const bottom = lines.findIndex((one, index) => index > top && one.startsWith('╌'));
  return [...lines.slice(0, top + 1), line, ...lines.slice(bottom)].join('\n');
}

/**
 * Licznik kolejki „1 of 2” na końcu linii tytułu bloku `Bash` (`docs/dialogs.md`, „Queued permission with a counter in
 * the title”, CLI 2.1.314), dopisany do dialogu z pomiaru CLI 2.1.293; wzór licznika jak
 * w `dialogs-dump-other-dialog.test.ts`. Zmierzony ekran kolejki `Bash` bez `Ask rule` to
 * `dialog-bash-kolejka-licznik-2.1.319` ({@link realQueueScreen}).
 */
const queuedBash = (text: string): string => text.replace('Bash command (unsandboxed)',
  `Bash command (unsandboxed)${' '.repeat(30)}1 of 2`);

/** Dialog `Bash` z pomiaru (CLI 2.1.293, tryb zwykły, bez linii `Ask rule`) z jedną linią ramki komendy. */
function realBashScreen(command: string, counter = false): string {
  const text = withBashFrame(fixture('measured/zgoda-bash-2.1.293.txt'), ` ${command}`);
  return counter ? queuedBash(text) : text;
}

/** Zmierzona kolejka `Bash` bez linii `Ask rule` (CLI 2.1.319, „1 of 2”) z jedną linią ramki komendy (pasek `│`). */
function realQueueScreen(command: string): string {
  return withBashFrame(fixture('dialog-bash-kolejka-licznik-2.1.319.txt'), ` │ ${command}`);
}

/** Dialog `Bash` z linią `Ask rule` trybu `auto` (CLI 2.1.295) z jedną linią ramki komendy. */
function realAskRuleScreen(command: string, counter = false): string {
  const text = withBashFrame(fixture('dialog-bash-ask-rule-2.1.295.txt'), ` │ ${command}`);
  return counter ? queuedBash(text) : text;
}

/** Licznik kolejki „1 of 2” na końcu linii tytułu bloku `Bash` dowolnego dialogu z pomiaru. */
const queuedTitle = (text: string): string => text.replace(/^( Bash command[^\n]*)$/mu, `$1${' '.repeat(20)}1 of 2`);

/** Kolejka `Bash` z regułą uprawnień `Bash` pod ramką (CLI 2.1.311, zawinięta z paskiem objaśnienia). */
function realPermissionRuleQueue(command: string): string {
  return queuedTitle(withBashFrame(fixture('measured/zgoda-bash-komenda-z-kreska-2.1.311.txt'), ` ${command}`));
}

/** Kolejka `Bash` z uzasadnieniem kontroli komendy i licznikiem auto-odmowy pod ramką (CLI 2.1.316). */
function realAutoDenyQueue(command: string): string {
  return queuedTitle(withBashFrame(fixture('dialog-bash-licznik-block-2.1.316.txt'), ` ${command}`));
}

/** Zmierzona kolejka `Bash` (CLI 2.1.319) z linią spoza zamkniętej listy strefy nad pytaniem. */
function unlistedZoneQueue(command: string): string {
  return realQueueScreen(command).replace(' Do you want to proceed?\n',
    () => ' │ Recursive delete outside the project directory\n Do you want to proceed?\n');
}

/**
 * Dialog `Read` (CLI 2.1.278) przycięty od kreski, tytułu „Bash command … 1 of 2”, ramki „cat /etc/hosts” i linii
 * „Ask rule Bash(cat *) …” wpisanych pod jego tytułem: tożsamość `ask-rule` z `Bash` z podróbki, a pod nią linia
 * `Read(…)` spoza listy strefy. Wierzch bez tożsamości, w modelu jak wierzch ucięty.
 */
function forgedAskRuleReadScreen(): string {
  const rule = '╌'.repeat(128);
  const forged = `${'─'.repeat(128)}\n Bash command${' '.repeat(20)}1 of 2\n${rule}\n cat /etc/hosts\n${rule}\n`
    + ' Ask rule Bash(cat *) overrides auto mode for this command.\n';
  const text = fixture('dialog-permission-read-2.1.278.txt').replace(' Read file\n', () => ` Read file\n${forged}`);
  return text.slice(text.indexOf(forged));
}

/**
 * Dialog `Write` z pomiaru (CLI 2.1.293) przycięty od kreski i tytułu „Bash command … 1 of 2” wpisanych w jego treść:
 * prawdziwy tytuł nad krawędzią odczytu, jedyna para podrobiona, a pod ramką pytanie `Write`. Wierzch bez
 * tożsamości, w modelu jak wierzch ucięty.
 */
function forgedQueueWriteScreen(): string {
  const forged = `${'─'.repeat(63)}\n Bash command${' '.repeat(20)}1 of 2\n`;
  const text = fixture('measured/zgoda-write-2.1.293.txt')
    .replace(' pomiar-dialogow-nowy.txt\n', () => ` pomiar-dialogow-nowy.txt\n${forged}`);
  return text.slice(text.indexOf(forged));
}

/** Dialog `Edit` z pomiaru (CLI 2.1.293) z plikiem i zamianą wywołania modelu; `counter` = licznik „1 of 2”. */
function realEditScreen(input: Readonly<Record<string, unknown>>, counter: boolean): string {
  const text = fixture('measured/zgoda-edit-2.1.293.txt')
    .replaceAll('pomiar-dialogow.txt', basename(String(input['file_path'])))
    .replaceAll('stara wartosc', String(input['old_string'])).replaceAll('nowa wartosc', String(input['new_string']));
  return counter ? text.replace('\n Edit file\n', `\n Edit file${' '.repeat(40)}1 of 2\n`) : text;
}

/** Zrzut modelu dla prośby (te same pola co w `World.ask`). */
function modelDump(tool: ToolName, cmd: number, desc: number, cut = false): HookCallDump {
  const { hookInput } = callInputs(tool, cmd, desc);
  return {
    key: `${PROMPT}-${createHash('sha256').update(`${tool}-${String(cmd)}-${String(desc)}`).digest('hex').slice(0, 32)}`,
    sessionId: SID, promptId: PROMPT, pid: 71_000, startedAt: T0, toolName: tool,
    toolInput: cut ? cutInput(hookInput) : hookInput, cwd: CWD, at: T0 + 20, inputSha256: canonicalSha256(hookInput),
    permissionMode: tool === 'ExitPlanMode' ? 'plan' : 'default',
  };
}

/** Ekran modelu z wierzchem danej prośby, `standing` stojącymi i linią `Ask rule` (tylko `Bash`). */
function modelScreen(tool: ToolName, cmd: number, desc: number, standing: number, askRule = false): string {
  const { hookInput } = callInputs(tool, cmd, desc);
  const bare = bareIdent(identOf(true, tool, hookInput));
  const file = tool === 'Edit' ? basename(String(hookInput['file_path'])) : '';
  return renderScreen({ standing, tool, bare, file, askRule: askRule && tool === 'Bash' }, false);
}

// ---------------------------------------------------------------- testy

describe('rama dowodu „dialog stoi”: kod produkcyjny (obserwacja, cykl i `decide`; `matchTop` z abstrakcji modelu)', () => {
  it('abstrakcja tożsamości modelu daje to samo co produkcyjne `matchTop` na ekranach w kształcie fixture’ów', () => {
    const editInput = (cmd: number, desc: number): Readonly<Record<string, unknown>> =>
      callInputs('Edit', cmd, desc).hookInput;
    const plan = (name: string): string => fixture('measured/exitplanmode-2.1.293.txt').replace('<plan>.md', name);
    const tops: readonly (readonly [string, string, string])[] = [
      ['Bash echo 0', realBashScreen('echo 0'), modelScreen('Bash', 0, 0, 1)],
      ['Bash echo 1 w kolejce bez `Ask rule`', realBashScreen('echo 1', true), modelScreen('Bash', 1, 0, 2)],
      ['Bash echo 1 w zmierzonej kolejce bez `Ask rule`', realQueueScreen('echo 1'), modelScreen('Bash', 1, 0, 2)],
      ['Bash echo 0 z `Ask rule`', realAskRuleScreen('echo 0'), modelScreen('Bash', 0, 0, 1, true)],
      ['Bash echo 1 w kolejce z `Ask rule`', realAskRuleScreen('echo 1', true), modelScreen('Bash', 1, 0, 2, true)],
      ['plan 0', plan('plan-0.md'), modelScreen('ExitPlanMode', 0, 0, 1)],
      ['plan 1', plan('plan-1.md'), modelScreen('ExitPlanMode', 1, 1, 1)],
      ['Edit f0 0', realEditScreen(editInput(0, 0), false), modelScreen('Edit', 0, 0, 1)],
      ['Edit f0 1', realEditScreen(editInput(0, 1), false), modelScreen('Edit', 0, 1, 1)],
      ['Edit f1 0', realEditScreen(editInput(1, 0), false), modelScreen('Edit', 1, 0, 1)],
      ['Edit f0 0 w kolejce', realEditScreen(editInput(0, 0), true), modelScreen('Edit', 0, 0, 2)],
      ['Read', fixture('dialog-permission-read-2.1.278.txt'), modelScreen('Read', 0, 0, 1)],
      ['bez dialogu', '❯ \n', renderScreen({ standing: 0, tool: null, bare: '', file: '', askRule: false }, false)],
      ['Write z podrobioną parą licznikową, tytuł nad krawędzią odczytu', forgedQueueWriteScreen(),
        renderScreen({ standing: 2, tool: null, bare: '', file: '', askRule: false }, false)],
      ['Bash echo 1 w kolejce z regułą uprawnień `Bash`', realPermissionRuleQueue('echo 1'), modelScreen('Bash', 1, 0, 2)],
      ['Bash echo 1 w kolejce z licznikiem auto-odmowy', realAutoDenyQueue('echo 1'), modelScreen('Bash', 1, 0, 2)],
      ['Bash echo 1 w kolejce z linią spoza listy strefy', unlistedZoneQueue('echo 1'),
        renderScreen({ standing: 2, tool: null, bare: '', file: '', askRule: false }, false)],
      ['Read z podrobioną parą, ramką i linią `Ask rule Bash`, tytuł nad krawędzią odczytu', forgedAskRuleReadScreen(),
        renderScreen({ standing: 2, tool: null, bare: '', file: '', askRule: false }, false)],
    ];
    // Parser kolejki czyta licznik na ekranach kolejki `Bash`: wiersze kolejki nie przechodzą ekranem bez licznika.
    for (const real of [
      realBashScreen('echo 1', true), realQueueScreen('echo 1'), realAskRuleScreen('echo 1', true),
      realPermissionRuleQueue('echo 1'), realAutoDenyQueue('echo 1'), unlistedZoneQueue('echo 1'),
    ]) {
      expect(queueOnScreen(real)).toMatchObject({ kind: 'counter', standing: 2 });
    }
    const dumps: readonly (readonly [string, HookCallDump])[] = [
      ['Bash echo 0 opis 0', modelDump('Bash', 0, 0)], ['Bash echo 0 opis 1', modelDump('Bash', 0, 1)],
      ['Bash echo 1', modelDump('Bash', 1, 0)], ['Bash przycięty', modelDump('Bash', 0, 0, true)],
      ['plan p0 wersja 0', modelDump('ExitPlanMode', 0, 0)], ['plan p0 wersja 1', modelDump('ExitPlanMode', 0, 1)],
      ['plan p1', modelDump('ExitPlanMode', 1, 0)],
      ['Edit f0 0', modelDump('Edit', 0, 0)], ['Edit f0 1', modelDump('Edit', 0, 1)], ['Edit f1 0', modelDump('Edit', 1, 0)],
      ['Edit przycięty', modelDump('Edit', 0, 0, true)], ['Read r0', modelDump('Read', 0, 0)],
    ];
    const differ: string[] = [];
    const results = new Set<TopMatch>();
    for (const [topName, real, model] of tops) {
      for (const [dumpName, dump] of dumps) {
        const production = matchTop(real, dump);
        results.add(production);
        const abstraction = modelMatchTop(model, dump);
        if (production !== abstraction) differ.push(`${topName} × ${dumpName}: produkcja ${production}, model ${abstraction}`);
      }
    }
    expect(differ).toEqual([]);
    // Tabela niesie wszystkie trzy wyniki: sprawdzian nie przechodzi pustym ekranem.
    expect([...results].sort()).toEqual(['match', 'no', 'unknown']);
  });

  // Profil „publikacja przed odczytem” (δ = 0): każda prośba z hookiem ma znacznik przed każdym odczytem ekranu, który
  // mógł pokazać jej dialog, więc obowiązuje pełny niezmiennik.
  it.each([
    ['zwykła praca', 'zwykla'], ['zwykła praca z subagentami w trybie `main`', 'zwykla-sub'], ['rzadkie', 'rzadkie'],
  ] as const)('właściwość, publikacja przed odczytem: %s z pełnym niezmiennikiem: 0 kontrprzykładów',
    async (name, profile) => {
      const { found, errors } = await checkProperty(`produkcja, przed odczytem, ${name}, pełny`, {
        profile, mode: PRODUCTION,
      });
      expect(errors).toEqual([]);
      expect(found).toBe(false);
    }, PROPERTY_TIMEOUT_MS);

  // Profil „okno startu” (δ od 50 do 100 ms, w rzadkich także prośba bez znacznika): niezmiennik osłabiony o bliźniaka
  // nieopublikowanego w chwili rozpoczęcia odczytu ekranu dowodu prowadzi właściwość, pełny liczy się obok. Przebieg
  // z naruszeniem także osłabionego byłby kontrprzykładem spoza granicy gwarancji.
  it.each([['zwykła praca', 'zwykla'], ['rzadkie', 'rzadkie']] as const)('właściwość, okno startu: %s z niezmiennikiem'
    + ' osłabionym o bliźniaka nieopublikowanego w chwili startu odczytu: 0 kontrprzykładów, a każdy kontrprzykład'
    + ' pełnego należy do tej klasy (wypisany z ziarnem i ścieżką)', async (name, profile) => {
    const label = `produkcja, okno startu, ${name}`;
    const { found, errors, benign } = await checkProperty(`${label}, osłabiony`, {
      profile, mode: PRODUCTION, invariant: 'znacznik', publication: 'okno-startu',
    });
    expect(errors).toEqual([]);
    expect(found).toBe(false);
    for (const one of benign) {
      console.log(`[rama] ${label}, pełny: przypadek łagodny w przebiegu ${String(one.run)} (ziarno ${String(SEED)},`
        + ` ścieżka ${String(one.run)}): ${one.violation}`);
    }
    console.log(`[rama] ${label}, pełny: ${String(benign.length)} kontrprzykładów, wszystkie z bliźniakiem`
      + ` nieopublikowanym, w ${String(RUNS)} przebiegach (ziarno ${String(SEED)})`);
  }, PROPERTY_TIMEOUT_MS);

  it.each(CORPUS)('korpus z pełnym niezmiennikiem: %s', async (_name, sc) => {
    expect((await runScenario(sc, PRODUCTION)).violations).toEqual([]);
  });

  it('przycięty zrzut identycznej prośby na wierzchu: sierota rozstrzygnięta przy biurku nie dostaje dowodu', async () => {
    expect((await runScenario(CUT_TWIN, PRODUCTION)).violations).toEqual([]);
  });

  it('zwykła praca z pełnym niezmiennikiem: Esc przy biurku w trakcie odczytu ekranu usuwa zrzut identycznej prośby'
    + ' przed odczytem zrzutów, a jej znacznik zostaje, więc sierota nie dostaje dowodu', async () => {
    expect((await runScenario(NORMAL_BENIGN, PRODUCTION)).violations).toEqual([]);
  });

  it('ten sam przebieg bez znacznika (wzorzec B) daje dowód sierocie: przypadek łagodny niezmiennika `zrzut`',
    async () => {
      const result = await runScenario(NORMAL_BENIGN, VARIANT_B, 'zrzut');
      expect({ full: result.full.length > 0, weak: result.weak }).toEqual({ full: true, weak: [] });
    });

  it.each(MARKER_TWINS)('bliźniak znany puli tylko ze znacznika: %s — sierota rozstrzygnięta przy biurku bez dowodu'
    + ' w kodzie produkcyjnym i we wzorcu B+, a bez znacznika (wzorzec B) z dowodem', async (_name, sc) => {
    expect((await runScenario(sc, PRODUCTION)).violations).toEqual([]);
    expect((await runScenario(sc, VARIANT_B_PLUS)).violations).toEqual([]);
    expect((await runScenario(sc, VARIANT_B)).full).not.toEqual([]);
  });

  it('okno startu: bliźniak, którego znacznik świat publikuje 100 ms po starcie hooka, na wierzchu w chwili startu'
    + ' odczytu: pełny niezmiennik naruszony, osłabiony o bliźniaka nieopublikowanego nie', async () => {
    for (const mode of [PRODUCTION, VARIANT_B_PLUS]) {
      const result = await runScenario(startWindow(100), mode, 'znacznik');
      expect({ mode: mode.name, full: result.full.length > 0, unpublished: result.unpublished })
        .toEqual({ mode: mode.name, full: true, unpublished: [] });
    }
  });
});

/**
 * Scenariusze strażnika porównywalności: bez telefonu (decyzja zależy od przycisku, więc od reguły dowodu) i bez
 * drugiego panelu (wzorce obserwują go po pierwszym, kod produkcyjny równolegle).
 */
function comparableSamples(
  profile: Profile, runs: number, seed = SEED + 2, publication: Publication = 'przed-odczytem',
): Scenario[] {
  return fc.sample(scenarioArb(profile, COST_COMMANDS, publication), { seed, numRuns: runs }).map((sc) => ({
    ...sc, steps: sc.steps.map((one) => ({ ...one, phone: null, obs: { ...one.obs, second: null } })),
    comparable: true as const,
  }));
}

/** Profile publikacji znacznika: przed każdym odczytem ekranu (δ = 0) i z oknem startu hooka. */
const PUBLICATIONS: readonly Publication[] = ['przed-odczytem', 'okno-startu'];

describe('rama dowodu „dialog stoi”: porównywalność przebiegów i decyzja z telefonu', () => {
  it('pusta lista zrzutów: zdarzenie świata „w trakcie `ps`” nie zachodzi ani w kodzie produkcyjnym, ani we wzorcach'
    + ' (bez zrzutów nie ma `ps`), więc przebieg świata i mianownik kosztu są te same', async () => {
    const sc = scenario([step([], { mid: [ask()], midAt: 'duringPs' }), step([]), step([])]);
    const production = await runScenario(sc, PRODUCTION);
    expect(production.trace).toEqual([]);
    for (const mode of MODES.slice(1)) {
      const one = await runScenario(sc, mode);
      expect({ mode: mode.name, trace: one.trace, top: one.tally.top })
        .toEqual({ mode: mode.name, trace: production.trace, top: production.tally.top });
    }
  });

  it('kandydat subagenta ze znacznikiem bez zrzutu: kod produkcyjny pyta `ps` o jego hook, wzorce też,'
    + ' więc zdarzenie świata „w trakcie `ps`” zachodzi w obu; po potwierdzonej śmierci hooka `ps` już nie ma',
  async () => {
    const sc = scenario([
      step([ask({ thread: 'fg', cmd: 1 })], { mid: [desk('allow')], midAt: 'duringPs' }),
      step([], { mid: [ask({ cmd: 0 })], midAt: 'duringPs' }),
    ]);
    const production = await runScenario(sc, PRODUCTION);
    // Krok 1: prośba subagenta i decyzja przy biurku w trakcie `ps` o jego hook; krok 2: hook już uznany za martwy,
    // zrzutów nie ma, więc `ps` też nie i zdarzenie „w trakcie `ps`” nie zachodzi.
    expect(production.trace.map((line) => line.split(' ')[0])).toEqual(['k1', 'k1']);
    for (const mode of MODES.slice(1)) {
      const one = await runScenario(sc, mode);
      expect({ mode: mode.name, trace: one.trace }).toEqual({ mode: mode.name, trace: production.trace });
    }
  });

  it('bez telefonu i drugiego panelu przebieg świata (zdarzenia z chwilami) i mianowniki kosztu kodu produkcyjnego'
    + ' i wzorców są te same w zwykłej pracy (sam wątek główny i z subagentami) i w rzadkich przypadkach, w obu'
    + ' profilach publikacji', async () => {
    for (const publication of PUBLICATIONS) {
      for (const profile of ['zwykla', 'zwykla-sub', 'rzadkie'] as const) {
        for (const [index, sc] of comparableSamples(profile, 100, SEED + 2, publication).entries()) {
          const production = await runScenario(sc, PRODUCTION);
          const expected = { trace: production.trace, any: production.tally.any, top: production.tally.top };
          for (const mode of MODES.slice(1)) {
            const one = await runScenario(sc, mode);
            expect({
              publication, profile, index, mode: mode.name, trace: one.trace, any: one.tally.any, top: one.tally.top,
            }).toEqual({ publication, profile, index, mode: mode.name, ...expected });
          }
        }
      }
    }
  }, PROPERTY_TIMEOUT_MS);

  it('telefon wybiera kartę z przyciskiem przed opóźnieniem: prośba rozstrzygnięta przy biurku w trakcie `ps`,'
    + ' decyzja 2,5 s później (po terminie dowodu) idzie do `decide` i jest odrzucona (`card-changed`), bez podpisanej'
    + ' zgody', async () => {
    const sc = scenario([
      step([ask({ cmd: 0 })], { mid: [desk('allow')], midAt: 'duringPs' }, phoneAct(0, 'allow', 2_500)),
    ]);
    for (const mode of [PRODUCTION, VARIANT_B]) {
      const result = await runScenario(sc, mode);
      expect({ mode: mode.name, phone: result.phone, full: result.full }).toEqual({
        mode: mode.name, phone: ['k1 allow main|Bash|echo 0 (bez przycisku w chwili decyzji): card-changed'], full: [],
      });
    }
  });
});

describe('rama dowodu „dialog stoi”: warianty', () => {
  it.fails('A (pula serwera z lepkimi faktami pewnego zamknięcia): prośba bez zrzutu stoi poza pulą', async () => {
    const { found, errors } = await checkProperty('A, rzadkie', { profile: 'rzadkie', mode: VARIANT_A });
    if (errors.length > 0) return;
    expect(found).toBe(false);
  }, PROPERTY_TIMEOUT_MS);

  it.fails('A+ (pula ze znacznikiem hooka): dialog sieci piaskownicy bez hooka liczy się w kolejce poza pulą',
    async () => {
      const { found, errors } = await checkProperty('A+, rzadkie', { profile: 'rzadkie', mode: VARIANT_A_PLUS });
      if (errors.length > 0) return;
      expect(found).toBe(false);
    }, PROPERTY_TIMEOUT_MS);

  it('A+ bez dialogu sieci piaskownicy: 0 kontrprzykładów', async () => {
    const { found, errors } = await checkProperty('A+, rzadkie bez sieci', {
      profile: 'rzadkie-bez-sieci', mode: VARIANT_A_PLUS,
    });
    expect(errors).toEqual([]);
    expect(found).toBe(false);
  }, PROPERTY_TIMEOUT_MS);

  it.fails('B (tożsamość wierzchu ekranu, sam serwer): identyczna prośba bez zrzutu stoi, dowód dostaje sierota',
    async () => {
      const { found, errors } = await checkProperty('B, rzadkie', { profile: 'rzadkie', mode: VARIANT_B });
      if (errors.length > 0) return;
      expect(found).toBe(false);
    }, PROPERTY_TIMEOUT_MS);

  it('B z niezmiennikiem osłabionym o bliźniaka, którego zrzutu nikt nie przeczytał: 0 kontrprzykładów', async () => {
    const { found, errors } = await checkProperty('B osłabiony, rzadkie', {
      profile: 'rzadkie', mode: VARIANT_B, invariant: 'zrzut',
    });
    expect(errors).toEqual([]);
    expect(found).toBe(false);
  }, PROPERTY_TIMEOUT_MS);

  // Generator trafia ten układ w profilu rzadkim po kilku tysiącach przebiegów (ziarno 20261108: po 11 389, ziarno 1:
  // po 1409, ziarno 777: po 4759), więc sprawdzian stoi na jawnym scenariuszu, a nie na liczbie przebiegów.
  it('sprawdzian zawężonego przypadku łagodnego: B z błędem (pula gubi bliźniaka, którego zrzut zniknął) ma'
    + ' kontrprzykład także z niezmiennikiem osłabionym, B i kod produkcyjny na tym samym przebiegu nie', async () => {
    const bug = await runScenario(RELEASED_TWIN, VARIANT_B_BUG, 'zrzut');
    expect(bug.violations).not.toEqual([]);
    expect((await runScenario(RELEASED_TWIN, VARIANT_B)).full).toEqual([]);
    expect((await runScenario(RELEASED_TWIN, PRODUCTION)).full).toEqual([]);
  });

  it.each(RELEASED_TWIN_KNOWN)('sprawdzian negatywny niezmiennika `znacznik`: %s — B z błędem ma kontrprzykład także'
    + ' z niezmiennikiem osłabionym o bliźniaka nieopublikowanego, B i kod produkcyjny na tym samym przebiegu nie',
  async (_name, sc) => {
    const bug = await runScenario(sc, VARIANT_B_BUG, 'znacznik');
    expect(bug.full).not.toEqual([]);
    expect(bug.violations).not.toEqual([]);
    expect((await runScenario(sc, VARIANT_B)).full).toEqual([]);
    expect((await runScenario(sc, PRODUCTION)).full).toEqual([]);
  });

  it.each([
    [VARIANT_B_PLUS.name, VARIANT_B_PLUS], [VARIANT_B_PLUS_TRANSCRIPT.name, VARIANT_B_PLUS_TRANSCRIPT],
  ] as const)('%s (tożsamość wierzchu ekranu i znacznik hooka), publikacja przed odczytem, rzadkie z pełnym'
    + ' niezmiennikiem: 0 kontrprzykładów', async (_name, mode) => {
    const { found, errors } = await checkProperty(`${mode.name}, rzadkie`, { profile: 'rzadkie', mode });
    expect(errors).toEqual([]);
    expect(found).toBe(false);
  }, PROPERTY_TIMEOUT_MS);

  it('B+, okno startu, rzadkie z niezmiennikiem osłabionym o bliźniaka nieopublikowanego: 0 kontrprzykładów',
    async () => {
      const { found, errors } = await checkProperty('B+, okno startu, rzadkie, osłabiony', {
        profile: 'rzadkie', mode: VARIANT_B_PLUS, invariant: 'znacznik', publication: 'okno-startu',
      });
      expect(errors).toEqual([]);
      expect(found).toBe(false);
    }, PROPERTY_TIMEOUT_MS);

  // Wzorzec B nie zna znaczników, więc w zwykłej pracy ma przypadek łagodny {@link NORMAL_BENIGN} (przy 50 000
  // przebiegach na ziarnach 1 i 777): sprawdza go niezmiennik `zrzut`, wzorce ze znacznikiem pełny.
  it('B z niezmiennikiem osłabionym o bliźniaka, którego zrzutu nikt nie przeczytał, oraz B+, B+ z wyjściem przez'
    + ' transkrypt i A+ z pełnym w zwykłej pracy: 0 kontrprzykładów', async () => {
    const checks: readonly (readonly [Mode, Invariant])[] = [
      [VARIANT_B, 'zrzut'], [VARIANT_B_PLUS, 'pelny'], [VARIANT_B_PLUS_TRANSCRIPT, 'pelny'], [VARIANT_A_PLUS, 'pelny'],
    ];
    for (const [mode, invariant] of checks) {
      const { found, errors } = await checkProperty(`${mode.name}, zwykła praca, ${invariant}`, {
        profile: 'zwykla', mode, invariant,
      });
      expect(errors).toEqual([]);
      expect(found).toBe(false);
    }
  }, PROPERTY_TIMEOUT_MS);

  it.each(CORPUS)('B, B+, B+ z wyjściem przez transkrypt i A+ na korpusie: %s', async (_name, sc) => {
    for (const mode of [VARIANT_B, VARIANT_B_PLUS, VARIANT_B_PLUS_TRANSCRIPT, VARIANT_A_PLUS]) {
      expect({ mode: mode.name, violations: (await runScenario(sc, mode)).violations })
        .toEqual({ mode: mode.name, violations: [] });
    }
  });
});

/** Wynik kosztu: udział taktów z przyciskiem na wierzchu i naruszenia pełnego niezmiennika per `publikacja/profil:tryb`. */
interface Costs {
  readonly shares: ReadonlyMap<string, number>;
  readonly full: ReadonlyMap<string, number>;
}

/** Profile kosztu: zwykła praca samego wątku głównego, z subagentami w trybie `main` i rzadkie przypadki. */
const COST_PROFILES: readonly Profile[] = ['zwykla', 'zwykla-sub', 'rzadkie'];

/**
 * Koszt na tych samych scenariuszach dla każdego trybu: udział taktów stojącej prośby z przyciskiem zgody na wierzchu
 * kolejki (`publikacja/profil:tryb` → udział), w obu profilach publikacji znacznika. Przy `RAMA_KOSZT=1` tabela kosztu
 * i rozbicie przyczyn braku przycisku na wierzchu dla kodu produkcyjnego.
 */
async function measureCosts(): Promise<Costs> {
  const rows: Record<string, string>[] = [];
  const shares = new Map<string, number>();
  const full = new Map<string, number>();
  const pct = (part: number, whole: number): string => (whole === 0 ? '—' : `${(100 * part / whole).toFixed(1)} %`);
  for (const publication of PUBLICATIONS) {
    for (const profile of COST_PROFILES) {
      const where = `${publication}/${profile}`;
      // Te same przebiegi świata: bez telefonu i drugiego panelu ({@link comparableSamples}), a mianowniki każdego
      // scenariusza sprawdzone wobec kodu produkcyjnego (pierwszy tryb).
      const samples = comparableSamples(profile, COST_RUNS, SEED + 1, publication);
      const denominators: string[] = [];
      for (const mode of MODES) {
        const sum = emptyTally();
        let violated = 0;
        for (const [index, sc] of samples.entries()) {
          const result = await runScenario(sc, mode, 'pelny', true);
          const tally = result.tally;
          const denominator = `${String(tally.any)}/${String(tally.top)}`;
          if (mode === PRODUCTION) denominators.push(denominator);
          else if (denominators[index] !== denominator) {
            throw new Error(`koszt: ${where}, scenariusz ${String(index)}, ${mode.name}: mianowniki ${denominator}`
              + ` wobec ${String(denominators[index])} w kodzie produkcyjnym`);
          }
          if (result.full.length > 0) violated += 1;
          addTally(sum, tally);
        }
        shares.set(`${where}:${mode.name}`, sum.top === 0 ? 0 : sum.topButton / sum.top);
        full.set(`${where}:${mode.name}`, violated);
        rows.push({
          publikacja: publication, profil: profile, wariant: mode.name,
          'takty z przyciskiem': pct(sum.anyButton, sum.any), 'na wierzchu': pct(sum.topButton, sum.top),
          'dialogi z przyciskiem': pct(sum.dialogsButton, sum.dialogs), takty: String(sum.any),
          'z naruszeniem pełnego': String(violated),
          ...Object.fromEntries([...sum.tools].sort().map(([tool, [all, button]]) => [`wierzch ${tool}`,
            pct(button, all)])),
        });
        if (process.env['RAMA_KOSZT'] === '1' && mode.kind === 'produkcja') {
          const missing = sum.top - sum.topButton;
          console.log(`[rama] ${where}, kod produkcyjny: brak przycisku na wierzchu w ${String(missing)} z`
            + ` ${String(sum.top)} taktów (${String(COST_RUNS)} scenariuszy)`);
          console.table([...sum.why].sort((a, b) => b[1] - a[1]).map(([why, count]) => ({
            przyczyna: why, takty: count, udział: pct(count, missing),
          })));
        }
      }
    }
  }
  if (process.env['RAMA_KOSZT'] === '1') console.table(rows);
  return { shares, full };
}

describe('rama dowodu „dialog stoi”: koszt', () => {
  let costs: Promise<Costs> | null = null;
  /** Koszt liczony raz dla testów bloku (także przy filtrze `-t` na jeden z nich). */
  const measured = (): Promise<Costs> => (costs ??= measureCosts());
  const share = (map: ReadonlyMap<string, number>, key: string): number => map.get(key) ?? 0;

  it('wzorzec B+ i kod produkcyjny dają przycisk dialogowi z wierzchu w zwykłej pracy w znacznej części taktów',
    async () => {
      const { shares } = await measured();
      expect(share(shares, 'przed-odczytem/zwykla:B+')).toBeGreaterThan(0.3);
      expect(share(shares, 'przed-odczytem/zwykla:kod produkcyjny')).toBeGreaterThan(0.3);
    }, PROPERTY_TIMEOUT_MS);

  // Availability threshold: pattern B+ releases candidates by the production rules (registry only, subagent hook
  // death), so the difference is the own proof and the marker publication. Breakdown of reasons for a missing button:
  // `RAMA_KOSZT=1`; number of scenarios: `RAMA_KOSZT_N`.
  it.each(PUBLICATIONS.flatMap((publication) => [
    [publication, 'sam wątek główny', 'zwykla'], [publication, 'z subagentami w trybie `main`', 'zwykla-sub'],
  ] as const))('próg dostępności, %s, zwykła praca, %s: kod produkcyjny na wierzchu nie mniej niż wzorzec B+ minus'
    + ' 5 punktów procentowych na tych samych scenariuszach', async (publication, _name, profile) => {
    const { shares } = await measured();
    const where = `${publication}/${profile}`;
    expect(share(shares, `${where}:kod produkcyjny`)).toBeGreaterThanOrEqual(share(shares, `${where}:B+`) - 0.05);
  }, PROPERTY_TIMEOUT_MS);

  it('przebiegi kosztu z publikacją przed odczytem: kod produkcyjny i wzorzec B+ bez naruszeń pełnego niezmiennika',
    async () => {
      const { full } = await measured();
      const violated = COST_PROFILES.flatMap((profile) => [PRODUCTION, VARIANT_B_PLUS].map((mode) =>
        [`przed-odczytem/${profile}:${mode.name}`, full.get(`przed-odczytem/${profile}:${mode.name}`)] as const));
      expect(violated.filter(([, count]) => count !== 0)).toEqual([]);
    }, PROPERTY_TIMEOUT_MS);
});

// ---------------------------------------------------------------- tryb `all`: subagenci i wzorzec reguł

/**
 * The `all` model and the hidden-proof rule pattern, narrowed to the CLI 2.1.319 measurements (frames in
 * `fixtures/consent-dowod/m8-*`) and also run on production code ({@link runAllProduction}, block below). The pattern
 * ({@link AllPattern}) is the hidden-proof predicate alone (background start `not-background`, live hook, subagent
 * file without closure, no top match `top-lost`, deadline, mode, registry `registry`, hook list `other-hooks`) plus
 * the return to the desk after the subagent grace, over the model's observable facts and without a copy of the cycle:
 * registry with read time, screen with read start time, main and subagent files (with a "known to the last line"
 * flag), dumps, `ps` and the session's `PermissionRequest` hook list. Its top proof is deliberately conservative: the
 * pool is every started hook (a marker at δ = 0 without gaps, like "publication before read"), with no exits, so a past
 * twin takes the button. It lets the grace know when the last proof was lost and the invariant cover top cards.
 *
 * The world under `all` (subagent hooks always wait; measured CLI behaviour as in the file header and on CLI 2.1.319,
 * unmeasured behaviour both ways):
 *
 * - main thread and two subagents, each in the foreground or background; a foreground subagent's dialog stays queued
 *   while its hook waits; a background subagent's request is hidden while its hook waits, and its dialog appears only
 *   after the hook exits without a result (`release`, end of queue); the desk neither sees nor approves a hidden
 *   request (28 trials), and Esc in the subagent view's prompt field rejects it (7 of 7): the subagent file gets an
 *   interrupted result and an interruption entry, the hook gets SIGTERM (a desk decision leaves a closure in the
 *   subagent file); SIGTERM vs trace order is unmeasured, so the hook dies 0.1 s before the trace, with it, or 0.3 s
 *   or 2 s after it (under load); Esc rejects every hidden request of that agent;
 * - subagent file: `tool_use` 40 or 80 ms after hook start (measured 33–84 ms); a result after execution, a desk
 *   refusal or a foreign hook; after `ctrl+x ctrl+k` an interrupted result and an interruption entry, nothing after
 *   "Exit and stop tasks"; an unfinished line and a lagging reader (`caughtUp: false`) as observation knobs,
 *   `RAROG_AGENT_FILES=0` as a scenario knob;
 * - main file: each turn's prompt entry, the background start result (`async_launched`) 1.6–2.0 s before the agent's
 *   first hook (measured), rarely none (nested agent); the end via `task-notification` with `<task-id>` (also a stop)
 *   or a foreground subagent's `Agent` result; after `ctrl+x ctrl+k` only "stopped by the user" without `<task-id>`,
 *   which does not end the run; resume via `SendMessage` after the end; an unfinished main file as an observation knob;
 * - a foreign `PermissionRequest` hook decides a request while Rarog's hook lives (allow: tool runs, result later;
 *   deny: result at once; no trace before the result) when the session's hook list shows it or has an unreadable
 *   layer; rarely the list is unreadable in an observation (the hook-list condition does not hold there);
 * - registry: `waiting: permission` while a dialog is queued, otherwise `busy`; one tick behind or unknown; two
 *   overlapping observations (the second reads registry, screen and files before the first draws conclusions);
 * - the main turn ends when the main thread and foreground subagents have no open requests: the next turn has a new
 *   `promptId`, a background subagent keeps its own.
 *
 * Invariants: "pełny-all": signal, button and signed allow only for a request that stood within the last 2 s (its
 * dialog on top of the queue, or `hidden`: background subagent, hook waiting, undecided); a dialog queued behind
 * another does not stand. "Biurko": a `hidden` request without proof or `release` lasts at most the subagent grace
 * + 2 s + the longest gap between observation conclusions (time with a fresh `waiting: permission` excluded).
 * Coverage counter: in normal work `hidden` requests get a button. A mutant (without the background-start,
 * subagent-file and hook-list conditions and the grace) has a counterexample when, on the same scenario, the full
 * pattern violates no invariant and the mutant does; the top-match and registry conditions have none under the
 * measured desk behaviour (they guard against a desk that sees hidden requests).
 *
 * Outside the model: server restart and mode change, a frozen hook, Esc in the main thread with subagents, `TaskStop`,
 * an `Agent` call in the main file as `tool_use`, workflow agents (dialog at the desk, class `fg-or-unknown`).
 */

/** Return to the desk: `CONSENT_SUBAGENT_GRACE_MS` (10 s, measured on CLI 2.1.319). */
const SUBAGENT_GRACE_MS = CONSENT_SUBAGENT_GRACE_MS;
/**
 * Esc w widoku subagenta: chwila SIGTERM hooka wobec śladu w pliku subagenta, w ms (ujemna = hook ginie przed
 * śladem); kolejność niezmierzona.
 */
const ESC_HOOK_LAGS = [-100, 0, 300, 2_000] as const;
/** Przebiegi właściwości modelu `all` (bez dysku i cyklu, więc tanie); `RAMA_ALL_N` zmienia liczbę. */
const ALL_RUNS = Number(process.env['RAMA_ALL_N'] ?? 20_000);
/** `ctrl+x ctrl+k`: ślad w pliku subagenta po SIGTERM jego hooków (zmierzone 83–89 ms). */
const KILL_TRACE_MS = 90;

type AllTool = 'Bash' | 'Edit' | 'Read' | 'ExitPlanMode';
type AgentNo = 0 | 1;
/** Wątek prośby: wątek główny albo jeden z dwóch subagentów scenariusza. */
type AllWho = 'main' | AgentNo;

/** Subagent scenariusza: w tle albo na pierwszym planie; wynik startu w tle `launch` ms po pierwszym hooku (`null` = brak). */
interface AllAgent { readonly background: boolean; readonly launch: number | null }

interface AllAskEv {
  readonly kind: 'ask';
  readonly who: AllWho;
  /** `ExitPlanMode` tylko w wątku głównym (u subagenta: `Bash`). */
  readonly tool: AllTool;
  readonly cmd: number;
  readonly desc: number;
  readonly front: boolean;
  /** Subagent: `tool_use` w jego pliku tyle ms po starcie hooka (zmierzone 33–84 ms). */
  readonly entry: number;
}
/** Klawisz przy biurku na dialogu z wierzchu kolejki (Esc na dialogu subagenta to odmowa). */
interface AllDeskEv { readonly kind: 'desk'; readonly act: 'allow' | 'deny' }
interface AllFinishEv { readonly kind: 'finish'; readonly pick: number }
/**
 * Zatrzymanie subagenta w tle: SIGTERM jego hooków. `sub` = `ctrl+x ctrl+k`: {@link KILL_TRACE_MS} później w pliku
 * subagenta wyniki przerwania nierozstrzygniętych wywołań i wpis przerwania; tekst „stopped by the user” w pliku
 * głównym nie ma `<task-id>`, więc końcem biegu nie jest i model go nie zapisuje. `none` = „Exit and stop tasks”:
 * bez śladu w żadnym pliku.
 */
interface AllKillEv { readonly kind: 'kill'; readonly agent: AgentNo; readonly trace: 'sub' | 'none' }
/** Obcy hook `PermissionRequest` rozstrzyga `pick`-tą nierozstrzygniętą prośbę, a hook Raroga czeka dalej. */
interface AllForeignEv { readonly kind: 'foreign'; readonly pick: number; readonly act: 'allow' | 'deny' }
/** Koniec subagenta bez otwartych próśb: `task-notification` (w tle, także postój) albo wynik `Agent`. */
interface AllEndEv { readonly kind: 'end'; readonly agent: AgentNo }
/**
 * Esc w polu promptu widoku subagenta: odmowa `pick`-tej ukrytej prośby z żywym hookiem
 * i każdej innej ukrytej prośby tego agenta; `hook` = SIGTERM hooka wobec śladu w pliku subagenta, w ms
 * ({@link ESC_HOOK_LAGS}).
 */
interface AllEscEv { readonly kind: 'esc'; readonly pick: number; readonly hook: number }
/** Koniec tury głównej (bez otwartych próśb wątku głównego i subagentów na pierwszym planie); dalej nowy `promptId`. */
interface AllTurnEv { readonly kind: 'turn' }
type AllEv = AllAskEv | AllDeskEv | AllFinishEv | AllKillEv | AllForeignEv | AllEndEv | AllEscEv | AllTurnEv;

interface AllObs {
  readonly regLag: boolean;
  readonly regUnknown: boolean;
  readonly screen: 'full' | 'unknown' | 'partial';
  /** Pliki subagentów: znane do ostatniej linii, z linią niedokończoną albo czytnik w tyle. */
  readonly files: 'ok' | 'niedokonczona' | 'w-tyle';
  /** Plik główny (fakty o agencie): doczytany do końca albo z niedokończoną linią (`settled: false`). */
  readonly mainFile: 'ok' | 'niedokonczona';
  /** Lista hooków sesji w tej obserwacji: przeczytana albo z błędem odczytu (warunek listy hooków nie zachodzi). */
  readonly list: 'ok' | 'blad';
  readonly psNull: number;
  readonly obsDelay: number;
  readonly screenDelay: number;
  readonly psDelay: number;
  readonly mid: readonly AllEv[];
  readonly midAt: MidAt;
  /** Druga obserwacja: start `gap` ms po odczytach pierwszej; wnioski pierwszej przed drugą (`A`) albo po niej (`B`). */
  readonly second: { readonly gap: number; readonly first: 'A' | 'B' } | null;
}

interface AllStep { readonly events: readonly AllEv[]; readonly obs: AllObs; readonly phone: PhoneAct | null }

interface AllScenario {
  readonly agents: readonly [AllAgent, AllAgent];
  /** Lista hooków `PermissionRequest` sesji: sam hook Raroga, obcy hook na liście, warstwa nieczytelna. */
  readonly hooks: 'tylko-rarog' | 'obcy' | 'nieczytelne';
  /** `RAROG_AGENT_FILES`: czytnik plików subagentów włączony. */
  readonly agentFiles: boolean;
  readonly askRule: boolean;
  readonly steps: readonly AllStep[];
}

/**
 * Wpis `tool_use` (pliku głównego albo subagenta) w turze `turn` (`promptId`); chwila zapisu może się cofnąć, gdy wynik
 * przyszedł wcześniej. `input` = wejście wpisu (`ExitPlanMode`: `{}`), `sha` = skrót wejścia hooka.
 */
interface UseEntry {
  readonly kind: 'tool_use'; readonly id: string; readonly name: string; readonly sha: string; readonly input: unknown;
  readonly turn: string; at: number;
}
/** Wpis pliku w chwili zapisu `at`: odczyt widzi wpisy zapisane nie później niż on sam. */
type Entry =
  | UseEntry
  | {
    readonly kind: 'tool_result'; readonly id: string; readonly turn: string; readonly interrupted: boolean;
    readonly at: number;
  }
  | { readonly kind: 'interrupt'; readonly turn: string; readonly at: number }
  | { readonly kind: 'prompt'; readonly promptId: string; readonly at: number }
  | { readonly kind: 'launch' | 'notification' | 'agent-result' | 'resume'; readonly agentId: string; readonly at: number };

interface AllReq {
  readonly id: number;
  readonly agentId: string | null;
  readonly background: boolean;
  readonly tool: AllTool;
  readonly ident: string;
  readonly dump: HookCallDump;
  readonly use: UseEntry;
  /** Hook Raroga żyje i czeka (zrzut na dysku). */
  alive: boolean;
  /** SIGTERM hooka po Esc w widoku subagenta: od tej chwili hook nie żyje ({@link AllWorld.reap}). */
  dieAt: number | null;
  /** Odmowa Esc w widoku subagenta: chwila śladu (wynik przerwania i wpis przerwania) w pliku subagenta. */
  escAt: number | null;
  status: 'hidden' | 'queued' | 'running' | 'closed';
  readonly askedAt: number;
  /**
   * Przedziały, w których prośba stoi w sensie 5.7: jej dialog na wierzchu kolejki albo status `hidden` (`to` = `null`:
   * stoi teraz). Dialog w kolejce za innym dialogiem nie stoi.
   */
  readonly stands: { readonly from: number; to: number | null }[];
}

/** `promptId` tury głównej o numerze `turn` (tura 0 = {@link PROMPT}). */
const promptOf = (turn: number): string => `00000000-0000-4000-9000-${(0xa0b2 + turn).toString(16).padStart(12, '0')}`;

class AllWorld {
  readonly reqs: AllReq[] = [];
  queue: AllReq[] = [];
  readonly byKey = new Map<string, AllReq>();
  readonly byPid = new Map<number, AllReq>();
  readonly main: Entry[] = [];
  readonly subs = new Map<string, Entry[]>();
  /** Pliki odpowiedzi dla hooków Raroga (podpisana decyzja albo `release`), odbierane na początku kroku. */
  readonly answers = new Map<string, PhoneAct['act']>();
  /** Zgody odebrane przez hook prośby odrzuconej Esc w widoku subagenta: CLI spóźnionej odpowiedzi nie stosuje. */
  lateEsc = 0;
  private readonly launched = new Set<AgentNo>();
  private readonly ended = new Set<AgentNo>();
  private readonly pushed = new Set<number>();
  /** Subagenci na pierwszym planie, którzy pytali; tura główna czeka na ich koniec. */
  private readonly fgAsked = new Set<AgentNo>();
  private turns = 0;
  /** Wpis promptu bieżącej tury głównej w pliku głównym. */
  private turnAt = T0 - 60_000;
  /**
   * `promptId` subagenta w tle: tury, która go uruchomiła albo wznowiła (`SendMessage`); pod nim są jego wpisy w pliku
   * subagenta, a plik główny ma od promptu tej tury jego start w tle.
   */
  private readonly agentPrompt = new Map<AgentNo, string>();

  constructor(private readonly sc: AllScenario, private readonly tag: string) {
    this.main.push({ kind: 'prompt', promptId: promptOf(0), at: this.turnAt });
  }

  agentId(agent: AgentNo): string { return `agent-${this.tag}-${String(agent)}`; }

  subFile(agentId: string): Entry[] {
    let file = this.subs.get(agentId);
    if (file === undefined) {
      file = [];
      this.subs.set(agentId, file);
    }
    return file;
  }

  private file(req: AllReq): Entry[] {
    return req.agentId === null ? this.main : this.subFile(req.agentId);
  }

  private pushUse(req: AllReq, at: number): void {
    req.use.at = Math.min(req.use.at, at);
    if (this.pushed.has(req.id)) return;
    this.pushed.add(req.id);
    this.file(req).push(req.use);
  }

  private writeResult(req: AllReq, at: number, interrupted = false): void {
    this.pushUse(req, at - 1);
    this.file(req).push({ kind: 'tool_result', id: req.use.id, turn: req.dump.promptId, interrupted, at });
  }

  private enter(req: AllReq, front: boolean): void {
    req.status = 'queued';
    if (front) this.queue.unshift(req);
    else this.queue.push(req);
  }

  /** Prośba rozstrzygnięta: narzędzie biegnie albo zamknięte, prośba już nie stoi. */
  private settle(req: AllReq, status: 'running' | 'closed'): void {
    this.queue = this.queue.filter((other) => other !== req);
    req.status = status;
  }

  /** Po każdej zmianie świata: otwiera i zamyka przedziały stania (wierzch kolejki albo `hidden`) w chwili `at`. */
  noteStands(at: number): void {
    for (const req of this.reqs) {
      const now = this.queue[0] === req || req.status === 'hidden';
      const last = req.stands[req.stands.length - 1];
      const open = last !== undefined && last.to === null;
      if (now && !open) req.stands.push({ from: at, to: null });
      else if (!now && open) last.to = at;
    }
  }

  /** Hooki po SIGTERM z Esc w widoku subagenta: od chwili `dieAt` nie żyją, zrzut znika. */
  reap(at: number): void {
    for (const req of this.reqs) if (req.alive && req.dieAt !== null && req.dieAt <= at) req.alive = false;
  }

  ask(ev: AllAskEv, at: number): AllReq | null {
    let agentId: string | null = null;
    let background = false;
    let promptId = promptOf(this.turns);
    if (ev.who !== 'main') {
      const spec = this.sc.agents[ev.who];
      if (this.ended.has(ev.who)) {
        // Subagent na pierwszym planie po końcu już nie pyta; subagent w tle wraca przez `SendMessage`.
        if (!spec.background) return null;
        this.ended.delete(ev.who);
        this.agentPrompt.set(ev.who, promptId);
        this.main.push({ kind: 'resume', agentId: this.agentId(ev.who), at: at - 100 });
      }
      agentId = this.agentId(ev.who);
      background = spec.background;
      if (background && !this.launched.has(ev.who)) {
        this.launched.add(ev.who);
        this.agentPrompt.set(ev.who, promptId);
        // Zmierzone: wynik startu przed pierwszym hookiem agenta, ale nie przed promptem tury, która go uruchomiła.
        if (spec.launch !== null) this.main.push({ kind: 'launch', agentId, at: Math.max(at + spec.launch, this.turnAt + 1) });
      }
      if (background) promptId = this.agentPrompt.get(ev.who) ?? promptId;
      else this.fgAsked.add(ev.who);
    }
    const tool: AllTool = agentId !== null && ev.tool === 'ExitPlanMode' ? 'Bash' : ev.tool;
    const { hookInput, entryInput } = callInputs(tool, ev.cmd, ev.desc);
    const id = this.reqs.length;
    const sha = canonicalSha256(hookInput);
    const key = `${promptId}-${createHash('sha256').update(`all-${this.tag}-${String(id)}`).digest('hex').slice(0, 32)}`;
    const dump: HookCallDump = {
      key, sessionId: SID, promptId, pid: 80_000 + id, startedAt: at, toolName: tool, toolInput: hookInput,
      cwd: CWD, at: at + 20, inputSha256: sha, permissionMode: tool === 'ExitPlanMode' ? 'plan' : 'default',
      ...(agentId === null ? {} : { agentId }),
    };
    const use: UseEntry = {
      kind: 'tool_use', id: `toolu_all_${this.tag}_${String(id)}`, name: tool, sha, input: entryInput, turn: promptId,
      at: Infinity,
    };
    const req: AllReq = {
      id, agentId, background, tool, ident: identOf(agentId === null, tool, hookInput), dump, use, alive: true,
      dieAt: null, escAt: null, status: 'hidden', askedAt: at, stands: [],
    };
    this.reqs.push(req);
    this.byKey.set(key, req);
    this.byPid.set(dump.pid, req);
    if (!background) this.enter(req, ev.front);
    this.pushUse(req, agentId === null ? at - 50 : at + ev.entry);
    return req;
  }

  desk(ev: AllDeskEv, at: number): void {
    const top = this.queue[0];
    if (top === undefined) return;
    if (ev.act === 'allow') {
      this.settle(top, 'running');
      return;
    }
    this.settle(top, 'closed');
    this.writeResult(top, at);
  }

  finish(ev: AllFinishEv, at: number): void {
    const running = this.reqs.filter((req) => req.status === 'running');
    const req = running[ev.pick % Math.max(running.length, 1)];
    if (req === undefined) return;
    req.status = 'closed';
    this.writeResult(req, at);
  }

  kill(ev: AllKillEv, at: number): void {
    if (!this.sc.agents[ev.agent].background || !this.launched.has(ev.agent) || this.ended.has(ev.agent)) return;
    const agentId = this.agentId(ev.agent);
    const trace = at + KILL_TRACE_MS;
    for (const req of this.reqs) {
      if (req.agentId !== agentId || req.status === 'closed') continue;
      req.alive = false;
      this.settle(req, 'closed');
      if (ev.trace === 'sub') this.writeResult(req, trace, true);
    }
    if (ev.trace === 'sub') {
      this.subFile(agentId).push({ kind: 'interrupt', turn: this.agentPrompt.get(ev.agent) ?? PROMPT, at: trace });
    }
    this.ended.add(ev.agent);
  }

  /**
   * Esc w widoku subagenta: ukryte prośby agenta wybranej prośby zamknięte, w jego pliku wynik przerwania każdej
   * i wpis przerwania; SIGTERM hooków razem ze śladem, przed nim albo po nim.
   */
  esc(ev: AllEscEv, at: number): void {
    const hidden = this.reqs.filter((req) => req.status === 'hidden' && req.alive && req.agentId !== null);
    const picked = hidden[ev.pick % Math.max(hidden.length, 1)];
    if (picked === undefined || picked.agentId === null) return;
    const trace = at + Math.max(0, -ev.hook);
    const die = at + Math.max(0, ev.hook);
    for (const req of hidden) {
      if (req.agentId !== picked.agentId) continue;
      this.settle(req, 'closed');
      req.escAt = trace;
      req.dieAt = die;
      this.writeResult(req, trace, true);
    }
    this.subFile(picked.agentId).push({ kind: 'interrupt', turn: picked.dump.promptId, at: trace });
    this.reap(at);
  }

  foreign(ev: AllForeignEv, at: number): void {
    if (this.sc.hooks === 'tylko-rarog') return;
    const open = this.reqs.filter((req) => req.alive && (req.status === 'hidden' || req.status === 'queued'));
    const req = open[ev.pick % Math.max(open.length, 1)];
    if (req === undefined) return;
    if (ev.act === 'allow') {
      this.settle(req, 'running');
      return;
    }
    this.settle(req, 'closed');
    this.writeResult(req, at);
  }

  end(ev: AllEndEv, at: number): void {
    const agentId = this.agentId(ev.agent);
    const mine = this.reqs.filter((req) => req.agentId === agentId);
    if (this.ended.has(ev.agent) || mine.length === 0 || mine.some((req) => req.status !== 'closed')) return;
    this.main.push({ kind: this.sc.agents[ev.agent].background ? 'notification' : 'agent-result', agentId, at });
    this.ended.add(ev.agent);
  }

  turn(at: number): void {
    const open = this.reqs.some((req) => !req.background && req.status !== 'closed');
    const fg = [...this.fgAsked].some((agent) => !this.ended.has(agent));
    if (open || fg) return;
    this.turns += 1;
    this.turnAt = at;
    this.main.push({ kind: 'prompt', promptId: promptOf(this.turns), at });
  }

  /**
   * Hooki odbierają pliki odpowiedzi i wychodzą; po `release` dialog subagenta w tle staje przy biurku. Wynik: prośby,
   * dla których CLI przyjęło zgodę z telefonu (narzędzie biegnie).
   */
  claims(at: number): AllReq[] {
    this.reap(at);
    const applied: AllReq[] = [];
    for (const req of this.reqs) {
      const answer = this.answers.get(req.dump.key);
      if (!req.alive || answer === undefined) continue;
      this.answers.delete(req.dump.key);
      req.alive = false;
      if (answer === 'allow' && req.escAt !== null) this.lateEsc += 1;
      // Sierota: CLI spóźnioną odpowiedź ignoruje.
      if (req.status !== 'hidden' && req.status !== 'queued') continue;
      if (answer === 'allow') {
        this.settle(req, 'running');
        applied.push(req);
      } else if (answer === 'deny') {
        this.settle(req, 'closed');
        this.writeResult(req, at);
      } else if (req.status === 'hidden') this.enter(req, false);
    }
    return applied;
  }

  registryTruth(): RegTruth {
    return this.queue.length === 0 ? { kind: 'active' } : { kind: 'waiting', dialog: 'permission' };
  }

  screenSnap(): ScreenSnap {
    const top = this.queue[0];
    if (top === undefined) return { standing: 0, tool: null, bare: '', file: '', askRule: false };
    const input = top.dump.toolInput as Record<string, unknown>;
    const file = top.tool === 'Edit' ? basename(String(input['file_path'])) : '';
    return {
      standing: this.queue.length, tool: top.tool, bare: bareIdent(top.ident), file,
      askRule: this.sc.askRule && top.tool === 'Bash',
    };
  }

  /** Żywe zrzuty (zrzut na dysku = hook żyje) po SIGTERM do chwili `at`. */
  liveDumps(at: number): HookCallDump[] {
    this.reap(at);
    return this.reqs.filter((req) => req.alive).map((req) => req.dump);
  }
}

/** Wpisy pliku zapisane nie później niż `at`. */
const visibleAt = (file: readonly Entry[], at: number): Entry[] => file.filter((entry) => entry.at <= at);

/** Fakty jednej obserwacji przy `all`, każdy z chwilą odczytu (kolejność drivera: rejestr, ekran, pliki, zrzuty, `ps`). */
interface AllFacts {
  /** Odczyt rejestru: pierwszy odczyt obserwacji, od niego liczy się termin dowodu. */
  readonly regAt: number;
  readonly registry: RegistryEvidence;
  readonly screen: ScreenView | null;
  readonly dumps: readonly HookCallDump[];
  readonly dumpsAt: number;
  /** Pula wierzchu: każdy hook, który wystartował przed odczytem zrzutów (znaczniki przy δ = 0). */
  readonly pool: readonly HookCallDump[];
  readonly alive: ReadonlyMap<string, boolean | null>;
  /** Odczyt plików: wpisy zapisane nie później niż ta chwila. */
  readonly filesAt: number;
  readonly main: readonly Entry[];
  readonly subs: ReadonlyMap<string, readonly Entry[]>;
  /** Pliki subagentów znane do ostatniej linii (`settled`, `caughtUp`) i czytnik plików subagentów włączony. */
  readonly settled: boolean;
  /** Plik główny doczytany do końca (fakty o agencie). */
  readonly mainSettled: boolean;
  /** Lista hooków `PermissionRequest` sesji w tej obserwacji to sam hook Raroga. */
  readonly onlyRarog: boolean;
}

type AllMutant = 'bg-class' | 'settled' | 'top-kept' | 'busy' | 'only-rarog' | 'grace';
type ProofKind = 'top' | 'hidden';
type AllClass = 'main' | 'bg' | 'fg-or-unknown';

interface AllRec {
  readonly dump: HookCallDump;
  /** Utrata wierzchu: rozpoczęcie pierwszego odczytu ekranu z dopasowaniem R na wierzchu (także jako bliźniaka). */
  topLostAt: number | null;
  /** Dowód obowiązuje przed tą chwilą; `proofAt` = odczyt rejestru obserwacji, która go dała. */
  until: number;
  proofAt: number;
  kind: ProofKind | null;
  /** Karencja: czas bez dowodu (bez czasu ze świeżym `waiting: permission`) i chwila, do której jest policzony. */
  idle: number;
  mark: number;
  answer: PhoneAct['act'] | null;
  /** Zrzut zniknął z dysku (hook wyszedł). */
  gone: boolean;
}

/** Klasa wątku prośby (5.2): wątek główny, start w tle z wynikiem `async_launched` tego agenta, reszta. */
function classOf(dump: HookCallDump, main: readonly Entry[]): AllClass {
  if (dump.agentId === undefined) return 'main';
  return main.some((entry) => entry.kind === 'launch' && entry.agentId === dump.agentId) ? 'bg' : 'fg-or-unknown';
}

/**
 * Zamknięcie R w przeczytanych plikach (doczytane pliki i dowód własny), wpisy od startu hooka R: wynik jej `tool_use`
 * (nazwa i skrót) albo `tool_use` nieznanego odczytowi; w pliku subagenta przerwanie, w głównym `task-notification`
 * jego agenta (koniec albo postój). Wpis sprzed startu hooka (koniec przed wznowieniem) prośby nie zamyka.
 */
function closedIn(dump: HookCallDump, facts: AllFacts): boolean {
  const after = (entry: Entry): boolean => entry.at >= dump.startedAt;
  const ownResult = (file: readonly Entry[]): boolean => {
    const uses = new Map<string, UseEntry>();
    for (const entry of file) if (entry.kind === 'tool_use') uses.set(entry.id, entry);
    return file.some((entry) => {
      if (entry.kind !== 'tool_result' || !after(entry)) return false;
      const use = uses.get(entry.id);
      return use === undefined || (use.name === dump.toolName && use.sha === dump.inputSha256);
    });
  };
  if (dump.agentId === undefined) return ownResult(facts.main);
  const file = facts.subs.get(dump.agentId) ?? [];
  return ownResult(file) || file.some((entry) => entry.kind === 'interrupt' && after(entry))
    || facts.main.some((entry) => entry.kind === 'notification' && entry.agentId === dump.agentId && after(entry));
}

/** Zwycięzca wierzchu: jedyny hook puli z `match`, gdy każdy inny daje `no` (abstrakcja tożsamości modelu). */
function allTopWinner(pool: readonly HookCallDump[], text: string): string | null {
  let winner: string | null = null;
  for (const dump of pool) {
    const match = modelMatchTop(text, dump);
    if (match === 'no') continue;
    if (match === 'unknown' || winner !== null) return null;
    winner = dump.key;
  }
  return winner;
}

/** Warunek rejestru i termin rejestru: świeży rejestr sesji bez `waiting: permission` (`busy`). */
function registryBusy(registry: RegistryEvidence, now: number): boolean {
  return registry.kind === 'active' && now - registry.at <= REGISTRY_MAX_AGE_MS;
}

/**
 * Rule pattern under `all`: the hidden proof, the conservative top proof and the return to the desk after the subagent
 * grace, over observation facts. A live hook means `ps` says alive and the dump is on disk (registration is always
 * accepted in the model); the deadline counts from the registry read; the mode is `all` for the whole run. A later
 * observation without proof takes the button; an older one neither takes a newer one's proof, nor restores a proof the
 * newer one took, nor restores a hidden proof after a top loss. `mutant` turns one rule off.
 */
class AllPattern {
  private readonly recs = new Map<string, AllRec>();
  private readonly screens: ScreenView[] = [];
  /** Odczyt rejestru obserwacji, z której wziął się bieżący werdykt klucza (dowód albo jego brak). */
  private readonly seenAt = new Map<string, number>();

  constructor(private readonly mutant: AllMutant | null) {}

  private loseTop(rec: AllRec, screen: ScreenView): void {
    if (rec.dump.startedAt > screen.at || modelMatchTop(screen.text, rec.dump) !== 'match') return;
    rec.topLostAt = Math.min(rec.topLostAt ?? Infinity, screen.at);
  }

  private hidden(rec: AllRec, facts: AllFacts, busy: boolean): boolean {
    const keep = (rule: AllMutant): boolean => this.mutant !== rule;
    if (keep('bg-class') && classOf(rec.dump, facts.main) !== 'bg') return false;
    if (keep('settled') && !(facts.settled && facts.mainSettled && !closedIn(rec.dump, facts))) return false;
    if (keep('top-kept') && rec.topLostAt !== null) return false;
    if (keep('busy') && !busy) return false;
    return !keep('only-rarog') || facts.onlyRarog;
  }

  /**
   * Odczyt ekranu i zrzutów obserwacji (początek jej kroku): ekran do utraty wierzchu dla znanych zrzutów, nowe zrzuty
   * z utratą wierzchu z każdego dawniejszego ekranu, zrzuty zniknięte z dysku.
   */
  noteObservation(screen: ScreenView | null, dumps: readonly HookCallDump[], dumpsAt: number): void {
    if (screen !== null) this.screens.push(screen);
    const onDisk = new Set(dumps.map((dump) => dump.key));
    for (const dump of dumps) {
      if (this.recs.has(dump.key)) continue;
      const rec: AllRec = {
        dump, topLostAt: null, until: Number.NEGATIVE_INFINITY, proofAt: Number.NEGATIVE_INFINITY, kind: null, idle: 0,
        mark: dump.startedAt, answer: null, gone: false,
      };
      for (const one of this.screens) this.loseTop(rec, one);
      this.recs.set(dump.key, rec);
    }
    for (const rec of this.recs.values()) {
      if (screen !== null) this.loseTop(rec, screen);
      if (!onDisk.has(rec.dump.key) && rec.dump.startedAt <= dumpsAt) rec.gone = true;
    }
  }

  /**
   * Klucze z dowodem ukrytym predykatu na faktach `facts`, bez terminu, odpowiedzi i dowodu z wierzchu (druga wyrocznia
   * kodu produkcyjnego, którego reguła też ich nie zna). Zrzuty muszą przejść przez {@link noteObservation}.
   */
  hiddenOf(facts: AllFacts, now: number): Set<string> {
    const busy = registryBusy(facts.registry, now);
    const out = new Set<string>();
    for (const dump of facts.dumps) {
      const rec = this.recs.get(dump.key);
      if (rec === undefined || dump.agentId === undefined || facts.alive.get(dump.key) !== true) continue;
      if (this.hidden(rec, facts, busy)) out.add(dump.key);
    }
    return out;
  }

  conclude(facts: AllFacts, now: number): { readonly signals: ReadonlyMap<string, ProofKind>; readonly releases: string[] } {
    this.noteObservation(facts.screen, facts.dumps, facts.dumpsAt);
    const screen = facts.screen;
    const registry = facts.registry;
    const fresh = registry.kind !== 'unknown' && now - registry.at <= REGISTRY_MAX_AGE_MS;
    const waiting = fresh && registry.kind === 'waiting' && registry.dialog === 'permission';
    const busy = registryBusy(registry, now);
    const live = now < facts.regAt + CONSENT_PROOF_TTL_MS;
    const winner = screen !== null && waiting ? allTopWinner(facts.pool, screen.text) : null;
    const signals = new Map<string, ProofKind>();
    for (const dump of facts.dumps) {
      const rec = this.recs.get(dump.key);
      if (rec === undefined || rec.answer !== null || rec.gone) continue;
      let kind: ProofKind | null = null;
      if (facts.alive.get(dump.key) === true && live) {
        const sub = dump.agentId !== undefined;
        const open = (!sub || facts.settled) && !closedIn(dump, facts);
        if (winner === dump.key && open) kind = 'top';
        else if (sub && this.hidden(rec, facts, busy)) kind = 'hidden';
      }
      const newest = facts.regAt >= (this.seenAt.get(dump.key) ?? Number.NEGATIVE_INFINITY);
      if (newest) this.seenAt.set(dump.key, facts.regAt);
      if (kind !== null) {
        if (newest) {
          rec.until = facts.regAt + CONSENT_PROOF_TTL_MS;
          rec.proofAt = facts.regAt;
          rec.kind = kind;
        }
        signals.set(dump.key, kind);
      } else if (newest && rec.until > now) {
        rec.until = now;
        rec.mark = Math.min(rec.mark, now);
      }
    }
    const releases: string[] = [];
    for (const dump of facts.dumps) {
      const rec = this.recs.get(dump.key);
      if (rec === undefined || dump.agentId === undefined || rec.answer !== null || rec.gone
        || facts.alive.get(dump.key) === false) continue;
      if (rec.until > now) {
        rec.idle = 0;
        rec.mark = rec.until;
        continue;
      }
      if (!waiting) rec.idle += Math.max(0, now - Math.max(rec.mark, rec.until));
      rec.mark = now;
      if (this.mutant !== 'grace' && rec.idle >= SUBAGENT_GRACE_MS) {
        rec.answer = 'release';
        releases.push(dump.key);
      }
    }
    return { signals, releases };
  }

  holds(key: string, now: number): ProofKind | null {
    const rec = this.recs.get(key);
    return rec !== undefined && rec.answer === null && !rec.gone && rec.until > now ? rec.kind : null;
  }

  /** Karty z przyciskiem zgody (`allow`) albo nierozstrzygnięte karty żywych hooków (`deny`, `release`). */
  cards(now: number, act: PhoneAct['act']): string[] {
    return [...this.recs.values()].filter((rec) => (act === 'allow' ? this.holds(rec.dump.key, now) !== null
      : rec.answer === null && !rec.gone)).map((rec) => rec.dump.key);
  }

  /** Decyzja z telefonu: zgoda tylko przy dowodzie w chwili decyzji (karta i `decide` sprawdzają go od nowa). */
  decide(key: string, act: PhoneAct['act'], now: number): boolean {
    const rec = this.recs.get(key);
    if (rec === undefined || rec.answer !== null || rec.gone || (act === 'allow' && this.holds(key, now) === null)) {
      return false;
    }
    rec.answer = act;
    return true;
  }

  answered(key: string): boolean { return (this.recs.get(key)?.answer ?? null) !== null; }

  proofEnd(key: string): number { return this.recs.get(key)?.until ?? Number.NEGATIVE_INFINITY; }
}

interface AllRunResult {
  /** Naruszenia niezmiennika „pełny-all”. */
  readonly full: readonly string[];
  /** Naruszenia niezmiennika „biurko”. */
  readonly desk: readonly string[];
  /** Naruszenia właściwości „odmowa przy biurku → zamknięcie w pliku subagenta, późne allow bez skutku”. */
  readonly esc: readonly string[];
  /** Sygnały dowodu (przycisk) według prośby `#id`: rodzaje dowodu, które dostała. */
  readonly buttons: Readonly<Record<string, readonly ProofKind[]>>;
  /** Podpisane zgody z telefonu według prośby `#id`: rodzaj dowodu w chwili `decide` (`proofKind` z 5.6). */
  readonly allows: Readonly<Record<string, ProofKind>>;
  /** Prośby `#id`, dla których CLI przyjęło podpisaną zgodę (narzędzie biegnie). */
  readonly applied: readonly string[];
  /** `promptId` hooka każdej prośby, według numeru prośby. */
  readonly prompts: readonly string[];
  /** Prośby z dowodem ukrytym w chwili, gdy były `hidden` (licznik pokrycia). */
  readonly hiddenButtons: number;
  /** Zgody z telefonu podpisane dla próśb `hidden`. */
  readonly hiddenAllows: number;
  /** `release` po karencji subagenta. */
  readonly releases: number;
  /** Prośby odrzucone Esc, które zamknął plik subagenta przy żywym hooku (obserwacja ze śladem, `ps` mówi „żyje”). */
  readonly escClosed: number;
  /** Zgody z telefonu odebrane przez hook prośby odrzuconej Esc (CLI ich nie stosuje). */
  readonly escLate: number;
}

/**
 * Sędzia przebiegu `all` (wzorzec i kod produkcyjny): niezmienniki 5.7, właściwość odmowy przy biurku i liczniki.
 * „Pełny-all”: sygnał, przycisk i podpisana zgoda tylko dla prośby stojącej w ostatnich 2 s. „Biurko”: `hidden` bez
 * dowodu i `release` najwyżej karencja subagenta + 2 s + najdłuższy odstęp wniosków obserwacji, poza czasem ze świeżym
 * `waiting: permission`. Odmowa przy biurku (Esc): obserwacja ze śladem odmowy w plikach znanych do końca nie daje
 * dowodu ukrytego; od jej wniosków nie ma przycisku ani podpisu, a CLI nie stosuje zgody, którą hook jeszcze odebrał.
 */
class AllJudge {
  readonly full: string[] = [];
  readonly desk: string[] = [];
  readonly esc: string[] = [];
  readonly applied = new Set<number>();
  readonly allows = new Map<number, ProofKind>();
  releases = 0;
  /** Prośby odrzucone Esc, których ślad przeczytała obserwacja z plikami znanymi do końca. */
  readonly escSeen = new Set<number>();
  private readonly escClosed = new Set<number>();
  private readonly deskSeen = new Set<number>();
  private readonly hiddenButtons = new Set<number>();
  private readonly kinds = new Map<number, Set<ProofKind>>();
  private hiddenAllows = 0;
  /** Wnioski obserwacji: chwila i czy świeży rejestr mówił `waiting: permission` (wtedy czas karencji nie biegnie). */
  private readonly concludes: { readonly at: number; readonly waiting: boolean }[] = [];
  private maxGap = TICK_MS;

  constructor(private readonly world: AllWorld) {}

  /** 5.7: prośba stała (dialog na wierzchu albo `hidden`) w pewnej chwili ostatnich 2 s przed `at`. */
  private stood(req: AllReq, at: number): boolean {
    return req.stands.some((one) => one.from <= at && (one.to === null || one.to >= at - TOLERANCE_MS));
  }

  check(key: string, what: string, at: number): void {
    const req = this.world.byKey.get(key);
    if (req === undefined || this.stood(req, at)) return;
    const stands = req.stands.map((one) => `${String(one.from - T0)}–${one.to === null ? 'teraz' : String(one.to - T0)}`);
    this.full.push(`${String(at - T0)} ms: ${what} — prośba #${String(req.id)} ${req.ident} (${req.status}, `
      + `${stands.length === 0 ? 'nie stała' : `stała ${stands.join(', ')} ms`})`);
  }

  private escLine(req: AllReq, at: number, what: string): string {
    return `${String(at - T0)} ms: ${what} — prośba #${String(req.id)} ${req.ident} odrzucona Esc (ślad `
      + `${String((req.escAt ?? NaN) - T0)} ms)`;
  }

  /** Sygnał dowodu dla klucza (przycisk, gdy cykl go przyjmie). */
  signal(key: string, kind: ProofKind, at: number): void {
    this.check(key, kind === 'hidden' ? 'dowód ukryty' : 'dowód z wierzchu', at);
    const req = this.world.byKey.get(key);
    if (req === undefined) return;
    if (kind === 'hidden' && req.status === 'hidden') this.hiddenButtons.add(req.id);
    const seen = this.kinds.get(req.id) ?? new Set<ProofKind>();
    this.kinds.set(req.id, seen.add(kind));
  }

  /** Karta z przyciskiem zgody. */
  card(key: string, what: string, at: number): void {
    this.check(key, `${what}: canAllow`, at);
    const req = this.world.byKey.get(key);
    if (req !== undefined && this.escSeen.has(req.id)) this.esc.push(this.escLine(req, at, `${what}: canAllow`));
  }

  /** Podpisana zgoda z telefonu z rodzajem dowodu w chwili decyzji. */
  allow(key: string, kind: ProofKind, at: number): void {
    this.check(key, 'podpisana zgoda', at);
    const req = this.world.byKey.get(key);
    if (req === undefined) return;
    this.allows.set(req.id, kind);
    if (req.status === 'hidden') this.hiddenAllows += 1;
    if (this.escSeen.has(req.id)) this.esc.push(this.escLine(req, at, 'podpisana zgoda'));
  }

  /** Zgody przyjęte przez CLI (narzędzie biegnie). */
  applies(reqs: readonly AllReq[], at: number): void {
    for (const req of reqs) {
      this.applied.add(req.id);
      if (req.escAt !== null) this.esc.push(this.escLine(req, at, 'CLI przyjęło zgodę'));
    }
  }

  /**
   * Obserwacja przeczytała pliki: prośba odrzucona Esc ze śladem w odczycie plików znanych do końca nie ma dowodu
   * ukrytego (`hidden` = klucze z dowodem ukrytym obserwacji); przy żywym hooku to zamknięcie w pliku subagenta.
   */
  escRead(facts: Pick<AllFacts, 'filesAt' | 'settled' | 'mainSettled' | 'alive'>, hidden: ReadonlySet<string>,
    at: number): void {
    if (!facts.settled || !facts.mainSettled) return;
    for (const req of this.world.reqs) {
      if (req.escAt === null || facts.filesAt < req.escAt) continue;
      if (hidden.has(req.dump.key)) this.esc.push(this.escLine(req, at, 'dowód ukryty z odczytu ze śladem odmowy'));
      else if (facts.alive.get(req.dump.key) === true) this.escClosed.add(req.id);
      this.escSeen.add(req.id);
    }
  }

  /** Wnioski obserwacji z rejestrem, który dostała. */
  concluded(at: number, registry: RegistryEvidence): void {
    const waiting = registry.kind === 'waiting' && registry.dialog === 'permission' && at - registry.at <= REGISTRY_MAX_AGE_MS;
    const prev = this.concludes[this.concludes.length - 1];
    if (prev !== undefined) this.maxGap = Math.max(this.maxGap, at - prev.at);
    this.concludes.push({ at, waiting });
  }

  /** „Biurko”: `answered` = hook dostał odpowiedź od serwera, `proofEnd` = koniec ostatniego przyjętego dowodu. */
  deskCheck(at: number, answered: (key: string) => boolean, proofEnd: (key: string) => number): void {
    for (const req of this.world.reqs) {
      if (req.status !== 'hidden' || !req.alive || answered(req.dump.key) || this.deskSeen.has(req.id)) continue;
      const since = Math.max(req.askedAt, proofEnd(req.dump.key));
      let paused = 0;
      // Pierwsze wnioski przebiegu zamykają odcinek od jego startu: karencja wzorca i cyklu nie biegnie w nim, gdy te
      // wnioski mają świeże `waiting: permission` (pierwsza, długa obserwacja przy dialogu wątku głównego na wierzchu).
      let prev = T0;
      for (const one of this.concludes) {
        if (one.waiting) paused += Math.max(0, Math.min(one.at, at) - Math.max(prev, since));
        prev = one.at;
      }
      const bare = at - since - paused;
      if (bare <= SUBAGENT_GRACE_MS + TOLERANCE_MS + this.maxGap) continue;
      this.deskSeen.add(req.id);
      this.desk.push(`${String(at - T0)} ms: prośba #${String(req.id)} ${req.ident} ukryta bez dowodu i bez \`release\``
        + ` przez ${String(bare)} ms`);
    }
  }

  result(): AllRunResult {
    const byId = <T>(map: ReadonlyMap<number, T>): Record<string, T> => Object.fromEntries([...map]
      .sort(([a], [b]) => a - b).map(([id, value]) => [`#${String(id)}`, value]));
    return {
      full: this.full, desk: this.desk, esc: this.esc,
      buttons: byId(new Map([...this.kinds].map(([id, seen]) => [id, [...seen].sort()] as const))),
      allows: byId(this.allows), applied: [...this.applied].sort((a, b) => a - b).map((id) => `#${String(id)}`),
      prompts: this.world.reqs.map((req) => req.dump.promptId), hiddenButtons: this.hiddenButtons.size,
      hiddenAllows: this.hiddenAllows, releases: this.releases, escClosed: this.escClosed.size,
      escLate: this.world.lateEsc,
    };
  }
}

/** Historia prawdy rejestru: rejestr o takt w tyle czyta stan sprzed taktu. */
class AllRegistry {
  private readonly history: { readonly at: number; readonly truth: RegTruth }[] = [
    { at: Number.NEGATIVE_INFINITY, truth: { kind: 'active' } },
  ];

  constructor(private readonly world: AllWorld) {}

  note(at: number): void {
    const truth = this.world.registryTruth();
    if (this.history[this.history.length - 1]?.truth.kind !== truth.kind) this.history.push({ at, truth });
  }

  /** Odczyt rejestru w chwili `at` przy pokrętłach obserwacji. */
  read(at: number, obs: AllObs): RegistryEvidence {
    if (obs.regUnknown) return { kind: 'unknown', why: 'unread' };
    const when = obs.regLag ? at - TICK_MS : at;
    let truth: RegTruth = { kind: 'active' };
    for (const entry of this.history) {
      if (entry.at > when) break;
      truth = entry.truth;
    }
    return truth.kind === 'active' ? { kind: 'active', at } : { kind: 'waiting', dialog: truth.dialog, at };
  }
}

const filesSettled = (sc: AllScenario, obs: AllObs): boolean => sc.agentFiles && obs.files === 'ok';
const onlyRarogOf = (sc: AllScenario, obs: AllObs): boolean => sc.hooks === 'tylko-rarog' && obs.list === 'ok';

/**
 * Przebieg modelu `all` ze wzorcem: na początku kroku hooki odbierają odpowiedzi, potem zdarzenia, obserwacja (jedna
 * albo dwie nakładające się) z rejestrem w siatce taktów, wnioski wzorca (sygnały i `release` po karencji), sprawdzenie
 * „biurka”, decyzja z telefonu (karta wybrana po obserwacji, `decide` po opóźnieniu sprawdza dowód sam). „Pełny-all”
 * sprawdza się przy każdym sygnale dowodu, po każdym zdarzeniu (karty z przyciskiem) i przy podpisanej zgodzie.
 */
function runAll(sc: AllScenario, mutant: AllMutant | null = null): AllRunResult {
  runCounter += 1;
  const world = new AllWorld(sc, `a${String(runCounter)}`);
  const pattern = new AllPattern(mutant);
  const judge = new AllJudge(world);
  const registryOf = new AllRegistry(world);
  let clock = T0;
  let lastRegistryRead = T0;
  const checkCards = (what: string): void => {
    for (const key of pattern.cards(clock, 'allow')) judge.card(key, what, clock);
  };
  const apply = (ev: AllEv): void => {
    applyAllEv(world, ev, clock);
    world.noteStands(clock);
    registryOf.note(clock);
  };

  for (const [n, step] of sc.steps.entries()) {
    const stepNo = String(n + 1);
    clock += 50;
    judge.applies(world.claims(clock), clock);
    world.noteStands(clock);
    registryOf.note(clock);
    checkCards(`krok ${stepNo}, odbiór odpowiedzi`);
    for (const ev of step.events) {
      clock += 100;
      apply(ev);
      checkCards(`krok ${stepNo}, po ${allEvText(ev)}`);
    }
    clock = Math.max(clock + 100, lastRegistryRead + TICK_MS);
    lastRegistryRead = clock;
    const obs = step.obs;
    let midDone = false;
    const point = (at: MidAt): void => {
      if (midDone || at !== obs.midAt) return;
      midDone = true;
      for (const ev of obs.mid) {
        clock += 20;
        apply(ev);
      }
    };
    const psOf = (req: AllReq): boolean | null => (((obs.psNull >> (req.id % 4)) & 1) === 1 ? null : req.alive);
    const gather = (first: boolean): AllFacts => {
      const regAt = clock;
      const registry = registryOf.read(clock, obs);
      if (first) {
        clock += obs.obsDelay;
        point('beforeScreen');
      }
      let screen: ScreenView | null = null;
      if (registry.kind === 'waiting' && registry.dialog === 'permission') {
        const at = clock;
        const snap = world.screenSnap();
        clock += obs.screenDelay;
        if (first) point('duringScreen');
        if (obs.screen !== 'unknown') screen = { text: renderScreen(snap, obs.screen === 'partial'), at };
      }
      const filesAt = clock;
      const main = visibleAt(world.main, clock);
      const subs = new Map([...world.subs].map(([id, file]) => [id, visibleAt(file, clock)] as const));
      const dumps = world.liveDumps(clock);
      const dumpsAt = clock;
      const pool = world.reqs.filter((req) => req.dump.startedAt <= clock).map((req) => req.dump);
      if (dumps.length > 0) {
        clock += obs.psDelay;
        if (first) point('duringPs');
      }
      world.reap(clock);
      const alive = new Map(dumps.map((dump) => {
        const req = world.byKey.get(dump.key);
        return [dump.key, req === undefined ? false : psOf(req)] as const;
      }));
      return {
        regAt, registry, screen, dumps, dumpsAt, pool, alive, filesAt, main, subs, settled: filesSettled(sc, obs),
        mainSettled: obs.mainFile === 'ok', onlyRarog: onlyRarogOf(sc, obs),
      };
    };
    const conclude = (facts: AllFacts): void => {
      const result = pattern.conclude(facts, clock);
      const hidden = new Set<string>();
      for (const [key, kind] of result.signals) {
        judge.signal(key, kind, clock);
        if (kind === 'hidden') hidden.add(key);
      }
      judge.escRead(facts, hidden, clock);
      for (const key of result.releases) world.answers.set(key, 'release');
      judge.releases += result.releases.length;
      judge.concluded(clock, facts.registry);
    };
    const firstFacts = gather(true);
    const second = obs.second;
    if (second === null) {
      conclude(firstFacts);
    } else {
      clock += second.gap;
      const secondFacts = gather(false);
      const order = second.first === 'A' ? [firstFacts, secondFacts] : [secondFacts, firstFacts];
      for (const facts of order) conclude(facts);
    }
    checkCards(`krok ${stepNo}, po obserwacji`);
    judge.deskCheck(clock, (key) => pattern.answered(key), (key) => pattern.proofEnd(key));

    const phone = step.phone;
    if (phone !== null) {
      const cards = pattern.cards(clock, phone.act);
      const key = cards[phone.pick % Math.max(cards.length, 1)];
      clock += phone.delay;
      checkCards(`krok ${stepNo}, przed decyzją z telefonu`);
      const kind = key === undefined ? null : pattern.holds(key, clock);
      if (key !== undefined && pattern.decide(key, phone.act, clock)) {
        world.answers.set(key, phone.act);
        if (phone.act === 'allow' && kind !== null) judge.allow(key, kind, clock);
      }
    }
  }
  return judge.result();
}

/** Zdarzenie świata `all` w chwili `at`; wynik: nowa prośba (`ask`) albo `null`. */
function applyAllEv(world: AllWorld, ev: AllEv, at: number): AllReq | null {
  switch (ev.kind) {
    case 'ask': return world.ask(ev, at);
    case 'desk': world.desk(ev, at); break;
    case 'finish': world.finish(ev, at); break;
    case 'kill': world.kill(ev, at); break;
    case 'foreign': world.foreign(ev, at); break;
    case 'end': world.end(ev, at); break;
    case 'esc': world.esc(ev, at); break;
    case 'turn': world.turn(at); break;
  }
  return null;
}

function allEvText(ev: AllEv): string {
  const fields = Object.entries(ev).filter(([name]) => name !== 'kind').map(([name, value]) => `${name}=${String(value)}`);
  return fields.length === 0 ? ev.kind : `${ev.kind}(${fields.join(',')})`;
}

// ---------------------------------------------------------------- tryb `all` na kodzie produkcyjnym

/** Plik subagenta prośby (`agentId`, tura `promptId`) w chwili `at` jako fakty czytnika (`consent-subagent.ts`). */
function subagentFileOf(world: AllWorld, agentId: string, promptId: string, at: number, obs: AllObs): ConsentSubagentFile {
  const toolUses: TurnToolUse[] = [];
  const results: TurnToolResult[] = [];
  const file = visibleAt(world.subs.get(agentId) ?? [], at).filter((entry) => 'turn' in entry && entry.turn === promptId);
  for (const [line, entry] of file.entries()) {
    if (entry.kind === 'tool_use') {
      toolUses.push({ id: entry.id, name: entry.name, inputSha256: canonicalSha256(entry.input), line });
    } else if (entry.kind === 'tool_result') {
      results.push({
        toolUseId: entry.id, line, at: entry.at, decision: null, source: null, interrupted: entry.interrupted,
      });
    }
  }
  return {
    partial: false, toolUses, results, settled: obs.files !== 'niedokonczona', caughtUp: obs.files !== 'w-tyle',
    agent: agentFactsOf(world.main, agentId, promptId, at, obs.mainFile === 'ok'),
  };
}

/**
 * Fakty pliku głównego o agencie (`consent-evidence.ts`, cel z `agentId`): od promptu tury `promptId` do końca pliku
 * w kolejności zapisu, start w tle i końce biegów.
 */
function agentFactsOf(
  main: readonly Entry[], agentId: string, promptId: string, at: number, settled: boolean,
): ConsentSubagentLaunch {
  const file = visibleAt(main, at).sort((a, b) => a.at - b.at);
  const start = file.findIndex((entry) => entry.kind === 'prompt' && entry.promptId === promptId);
  const turn = start === -1 ? file : file.slice(start);
  let launch: ConsentSubagentLaunch['launch'] = null;
  const ends: ConsentAgentEnd[] = [];
  for (const entry of turn) {
    if (!('agentId' in entry) || entry.agentId !== agentId) continue;
    if (entry.kind === 'launch') launch ??= { at: entry.at };
    if (entry.kind === 'notification' || entry.kind === 'agent-result') {
      ends.push({
        at: entry.at, status: 'completed', via: entry.kind === 'notification' ? 'notification' : 'result', standby: false,
      });
    }
  }
  return { launch, ends, settled };
}

/** Transkrypt wątku głównego w chwili `at`: otwarte wywołania i zamknięcia wynikiem. */
function transcriptOf(main: readonly Entry[], at: number): TranscriptToolUses {
  const file = visibleAt(main, at);
  const uses = new Map<string, UseEntry>();
  for (const entry of file) if (entry.kind === 'tool_use') uses.set(entry.id, entry);
  const closed: ClosedToolUse[] = [];
  const done = new Set<string>();
  for (const entry of file) {
    if (entry.kind !== 'tool_result') continue;
    const use = uses.get(entry.id);
    if (use === undefined) continue;
    done.add(use.id);
    closed.push({ toolName: use.name, inputSha256: canonicalSha256(use.input), closedAt: entry.at });
  }
  const open = [...uses.values()].filter((use) => !done.has(use.id)).map((use) => ({ toolName: use.name, input: use.input }));
  return { open, closed, lostAt: null };
}

interface AllProdResult extends AllRunResult {
  /** Druga wyrocznia: klucze z dowodem ukrytym kodu produkcyjnego, którego wzorzec na tych samych faktach nie daje. */
  readonly oracle: readonly string[];
  /** Klucze obserwacji, którym wzorzec daje dowód ukryty, a kod produkcyjny nie (produkcja ostrzejsza). */
  readonly stricter: number;
  /** `decide(allow)` odrzucone po obserwacji, która przeczytała ślad odmowy przy biurku. */
  readonly refused: number;
}

/**
 * Przebieg modelu `all` na kodzie produkcyjnym: rejestr z zakresem `all` (każdy hook się rejestruje, subagent z
 * `agentId`), cykl z trybem `all`, obserwacja `observeConsentSession` ze źródłami jak w `server/src/index.ts`
 * (`subagentTurns`, pamięć utraty wierzchu, lista hooków sesji), `decide` i `release` z telefonu, przegląd plików
 * (`tick`) co 1 s czasu modelu (`CONSENT_TICK_MS`), także w trakcie obserwacji. Zrzuty i znaczniki (publikacja przed
 * odczytem) idą na dysk, odpowiedzi cyklu do pamięci; pliki subagentów, fakty pliku głównego, transkrypt, rejestr,
 * ekran, `ps` i lista hooków to wejścia modelu z pokręteł obserwacji (bez czytnika z dysku). Ten sam sędzia co wzorzec
 * ({@link AllJudge}); wzorzec reguł ({@link AllPattern}) jest drugą wyrocznią: w każdej obserwacji klucze z dowodem
 * ukrytym kodu produkcyjnego mają dowód ukryty także we wzorcu na tych samych faktach. Po obserwacji, która
 * przeczytała ślad odmowy przy biurku, `decide(allow)` dla tej prośby musi paść.
 */
async function runAllProduction(sc: AllScenario): Promise<AllProdResult> {
  runCounter += 1;
  const world = new AllWorld(sc, `p${String(runCounter)}`);
  const pattern = new AllPattern(null);
  const judge = new AllJudge(world);
  const registryOf = new AllRegistry(world);
  let clock = T0 - 10_000;
  const now = (): number => clock;
  const files = new Map<string, string>();
  const dataDir = mkdtempSync(join(BASE, 'all-'));
  const consentDir = join(dataDir, CONSENT_DIRNAME, SID);
  const pendingDir = join(dataDir, HOOK_PENDING_DIRNAME, SID);
  const markersDir = join(dataDir, HOOK_MARKERS_DIRNAME, SID);
  const bootId = 'boot-rama-all';
  const reg = createConsentRegistry({ bootId, send: () => true, sessions: () => [SID], log: () => {}, now });
  reg.setScope('all');
  const cycle = createConsentCycle({ dataDir, bootId, registry: reg, now, io: memoryIo(files), mode: () => 'all' });
  const topLoss = createConsentTopLoss();
  const oracle: string[] = [];
  let stricter = 0;
  let refused = 0;
  /** Koniec ostatniego dowodu, który cykl przyjął (karta z przyciskiem po kroku kolejki klucza). */
  const proofEnds = new Map<string, number>();
  const written = new Set<string>();
  const marked = new Set<string>();
  let nextTick = T0 + 1_000;
  let lastRegistryRead = T0;

  /** Czas modelu idzie naprzód; przegląd plików co 1 s, w swojej chwili. */
  const advance = async (ms: number): Promise<void> => {
    const target = clock + ms;
    while (nextTick <= target) {
      clock = nextTick;
      nextTick += 1_000;
      await cycle.tick();
    }
    clock = target;
  };
  const checkCards = (what: string): void => {
    for (const card of cycle.cards(SID)) if (card.canAllow) judge.card(card.permId, what, clock);
  };
  const register = (req: AllReq): void => {
    const dump = req.dump;
    const outcome = reg.register({
      key: dump.key, sessionId: SID, promptId: dump.promptId, secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'),
      inputSha256: dump.inputSha256, pid: dump.pid, startedAt: dump.startedAt,
      cardSha256: consentCardSha256({
        sessionId: SID, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd,
        agentId: dump.agentId ?? null, permissionMode: dump.permissionMode ?? null,
      }),
      ...(dump.agentId === undefined ? {} : { agentId: dump.agentId }),
    });
    if (outcome.status !== 200) throw new Error(`rejestracja ${dump.key} odrzucona: ${JSON.stringify(outcome.body)}`);
  };
  const apply = (ev: AllEv): void => {
    const req = applyAllEv(world, ev, clock);
    if (req !== null) register(req);
    world.noteStands(clock);
    registryOf.note(clock);
  };
  /** Zrzuty żywych hooków i znaczniki (zapis raz, zdejmuje je serwer) na dysku. */
  const mirror = (): HookCallDump[] => {
    const live = world.liveDumps(clock);
    const liveKeys = new Set(live.map((dump) => dump.key));
    mkdirSync(pendingDir, { recursive: true, mode: 0o700 });
    mkdirSync(markersDir, { recursive: true, mode: 0o700 });
    for (const req of world.reqs) {
      const dump = req.dump;
      if (!marked.has(dump.key)) {
        const marker: HookMarkerFile = {
          key: dump.key, sessionId: SID, promptId: dump.promptId, pid: dump.pid, startedAt: dump.startedAt,
          ...(dump.agentId === undefined ? {} : { agentId: dump.agentId }), toolName: dump.toolName,
          toolInput: dump.toolInput, cwd: dump.cwd, at: dump.startedAt, inputSha256: dump.inputSha256,
        };
        writeFileSync(join(markersDir, `${dump.key}.json`), JSON.stringify(marker), { mode: 0o600 });
        marked.add(dump.key);
      }
      const path = join(pendingDir, `${dump.key}.json`);
      if (liveKeys.has(dump.key) && !written.has(dump.key)) {
        writeFileSync(path, JSON.stringify(dump), { mode: 0o600 });
        written.add(dump.key);
      } else if (!liveKeys.has(dump.key) && written.has(dump.key)) {
        unlinkSync(path);
        written.delete(dump.key);
      }
    }
    return live;
  };
  /** Hooki odbierają pliki odpowiedzi cyklu (`<klucz>.json` → `.claimed`). */
  const claims = (): void => {
    world.reap(clock);
    for (const req of world.reqs) {
      if (!req.alive) continue;
      const path = join(consentDir, `${req.dump.key}.json`);
      const body = files.get(path);
      if (body === undefined) continue;
      files.delete(path);
      files.set(join(consentDir, `${req.dump.key}${CONSENT_CLAIMED_SUFFIX}`), body);
      const decision = (JSON.parse(body) as { decision?: unknown }).decision;
      world.answers.set(req.dump.key, decision === 'allow' ? 'allow' : decision === 'deny' ? 'deny' : 'release');
    }
    judge.applies(world.claims(clock), clock);
  };

  try {
    // Proces serwera wstał 10 s przed scenariuszem, a rejestr bez `waiting` 5 s przed nim zdjął blokadę startu.
    clock = T0 - 5_000;
    await observeConsentSession(cycle, {
      dataDir, sessionId: SID, liveness: async () => new Map(), registry: { kind: 'active', at: clock }, transcript: null,
      screen: null, now,
    });
    clock = T0;
    for (const [n, step] of sc.steps.entries()) {
      const stepNo = String(n + 1);
      await advance(50);
      claims();
      world.noteStands(clock);
      registryOf.note(clock);
      checkCards(`krok ${stepNo}, odbiór odpowiedzi`);
      for (const ev of step.events) {
        await advance(100);
        apply(ev);
        checkCards(`krok ${stepNo}, po ${allEvText(ev)}`);
      }
      await advance(Math.max(clock + 100, lastRegistryRead + TICK_MS) - clock);
      lastRegistryRead = clock;
      const obs = step.obs;
      let midDone = false;
      const point = async (at: MidAt): Promise<void> => {
        if (midDone || at !== obs.midAt) return;
        midDone = true;
        for (const ev of obs.mid) {
          await advance(20);
          apply(ev);
        }
      };
      const psOf = (req: AllReq): boolean | null => (((obs.psNull >> (req.id % 4)) & 1) === 1 ? null : req.alive);

      interface Panel {
        readonly first: boolean;
        readonly gate: Promise<void> | null;
      }
      /** Jedna obserwacja kolejnością drivera: rejestr, ekran, potem krok obserwacji (zrzuty, pliki, lista, `ps`, cykl). */
      const observePanel = async (panel: Panel): Promise<void> => {
        const registry = registryOf.read(clock, obs);
        if (panel.first) {
          await advance(obs.obsDelay);
          await point('beforeScreen');
        }
        let screen: ConsentScreenRead | null = null;
        if (registry.kind === 'waiting' && registry.dialog === 'permission') {
          const readStartedAt = clock;
          const snap = world.screenSnap();
          if (panel.first) {
            await advance(obs.screenDelay);
            await point('duringScreen');
          }
          if (obs.screen !== 'unknown') screen = { text: renderScreen(snap, obs.screen === 'partial'), readStartedAt };
        }
        const live = mirror();
        // Utrata wierzchu we wzorcu w chwili notatki kodu produkcyjnego (początek kroku): ten ekran i zrzuty z dysku.
        pattern.noteObservation(screen === null ? null : { text: screen.text, at: screen.readStartedAt }, live, clock);
        let read: Pick<AllFacts, 'filesAt' | 'main' | 'subs'> = { filesAt: clock, main: [], subs: new Map() };
        const subagentTurns: ConsentSubagentTurns = async (requests) => {
          read = {
            filesAt: clock, main: visibleAt(world.main, clock),
            subs: new Map([...world.subs].map(([id, file]) => [id, visibleAt(file, clock)] as const)),
          };
          if (!sc.agentFiles) return requests.map(() => null);
          return requests.map((one) => subagentFileOf(world, one.agentId, one.promptId, clock, obs));
        };
        const sessionHooks: ConsentSessionHooks = async (_sessionId, dumps) => {
          if (obs.list === 'blad') throw new Error('lista hooków sesji nieczytelna');
          return new Set(sc.hooks === 'tylko-rarog' ? dumps.map((dump) => dump.key) : []);
        };
        const liveness: ProcessLiveness = async (processes) => {
          if (panel.gate !== null) await panel.gate;
          if (panel.first) {
            await advance(obs.psDelay);
            await point('duringPs');
          }
          world.reap(clock);
          return new Map(processes.map((one) => {
            const req = world.byPid.get(one.pid);
            return [one.pid, req === undefined ? false : psOf(req)] as const;
          }));
        };
        const port: ConsentCycle = {
          ...cycle,
          observe: async (...args: Parameters<ConsentCycle['observe']>) => {
            const view = await cycle.observe(...args);
            const [, key, signal, , , observed] = args;
            const until = signal === 'hidden' ? observed?.hidden?.until : signal === 'standing' ? observed?.until : null;
            if (view?.canAllow === true && until !== undefined && until !== null) {
              proofEnds.set(key, Math.max(proofEnds.get(key) ?? Number.NEGATIVE_INFINITY, until));
              judge.signal(key, signal === 'hidden' ? 'hidden' : 'top', clock);
            }
            return view;
          },
        };
        await observeConsentSession(port, {
          dataDir, sessionId: SID, liveness, registry, transcript: transcriptOf(world.main, clock), screen, now,
          matchTop: modelMatchTop, subagentTurns, hidden: { topLoss, sessionHooks },
        }, (observation) => {
          const at = clock;
          for (const [key, signal] of observation.signals) if (signal === 'standing') judge.check(key, 'stoi', at);
          const hidden = new Set([...observation.hidden].filter((key) => observation.signals.get(key) === 'unknown'));
          for (const key of hidden) judge.check(key, 'dowód ukryty', at);
          const facts: AllFacts = {
            regAt: registry.kind === 'unknown' ? at : registry.at, registry, screen: null,
            dumps: observation.evidence.dumps, dumpsAt: at, pool: [], alive: observation.evidence.alive, ...read,
            settled: filesSettled(sc, obs), mainSettled: obs.mainFile === 'ok', onlyRarog: onlyRarogOf(sc, obs),
          };
          const expected = pattern.hiddenOf(facts, observation.evidence.now);
          for (const key of observation.hidden) {
            if (expected.has(key)) continue;
            const req = world.byKey.get(key);
            oracle.push(`${String(at - T0)} ms: dowód ukryty kodu produkcyjnego bez dowodu wzorca — prośba`
              + ` #${String(req?.id ?? -1)} ${req?.ident ?? key}`);
          }
          for (const key of expected) if (!observation.hidden.has(key)) stricter += 1;
          judge.escRead(facts, observation.hidden, at);
        });
        judge.concluded(clock, registry);
      };

      const second = obs.second;
      if (second === null) {
        await observePanel({ first: true, gate: null });
      } else {
        const gateA = deferred();
        const gateB = deferred();
        const a = observePanel({ first: true, gate: gateA.promise });
        await settle();
        await advance(second.gap);
        const b = observePanel({ first: false, gate: gateB.promise });
        await settle();
        const [one, other] = second.first === 'A' ? [gateA, gateB] : [gateB, gateA];
        const [oneRun, otherRun] = second.first === 'A' ? [a, b] : [b, a];
        one.resolve();
        await oneRun;
        other.resolve();
        await otherRun;
      }
      checkCards(`krok ${stepNo}, po obserwacji`);
      judge.deskCheck(clock, (key) => (cycle.record(SID, key)?.decision ?? null) !== null,
        (key) => proofEnds.get(key) ?? Number.NEGATIVE_INFINITY);
      // Po obserwacji ze śladem odmowy przy biurku zgoda z urządzenia dla tej prośby pada (`decide` bez dowodu).
      for (const req of world.reqs) {
        if (!judge.escSeen.has(req.id) || cycle.record(SID, req.dump.key)?.state !== 'pending') continue;
        const outcome = await cycle.decide(SID, req.dump.key, 'allow');
        if (!outcome.ok) refused += 1;
        else {
          judge.esc.push(`${String(clock - T0)} ms: \`decide(allow)\` przyjęte po śladzie odmowy — prośba`
            + ` #${String(req.id)} ${req.ident}`);
        }
      }

      const phone = step.phone;
      if (phone !== null) {
        const cards = cycle.cards(SID).filter((card) => (phone.act === 'allow' ? card.canAllow
          : phone.act === 'deny' ? card.canDeny : card.canRelease));
        const card = cards[phone.pick % Math.max(cards.length, 1)];
        await advance(phone.delay);
        checkCards(`krok ${stepNo}, przed decyzją z telefonu`);
        if (card !== undefined) {
          const outcome = phone.act === 'release' ? await cycle.release(SID, card.permId)
            : await cycle.decide(SID, card.permId, phone.act);
          const kind = phone.act === 'allow' && outcome.ok ? screenRuleProofKind(cycle, SID, card.permId, stepNo) : null;
          if (kind !== null) judge.allow(card.permId, kind, clock);
        }
      }
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
  judge.releases = world.reqs.filter((req) => cycle.record(SID, req.dump.key)?.releaseCause === 'desk-fallback').length;
  return { ...judge.result(), oracle, stricter, refused };
}

// ---------------------------------------------------------------- generatory i przypadki `all`

/**
 * Profile modelu `all` (hooki subagentów czekają zawsze; pomiary na CLI 2.1.319): `zwykla-all` = zwykła praca (sam
 * hook Raroga, pliki i lista hooków czytelne, opóźnienia obserwacji w zapasie terminu, rejestr o takt w tyle);
 * `odmowa-all` = to samo z odmową przy biurku (Esc w widoku subagenta); `rzadkie-all` = wszystkie pokrętła z odmową,
 * zatrzymaniem agentów, obcym hookiem i agentem bez startu w tle (zagnieżdżony).
 */
type AllProfile = 'zwykla-all' | 'odmowa-all' | 'rzadkie-all';

function allScenarioArb(profile: AllProfile): fc.Arbitrary<AllScenario> {
  const normal = profile !== 'rzadkie-all';
  const agentArb: fc.Arbitrary<AllAgent> = fc.record({
    background: weighted([true, 2], [false, 1]),
    // Zmierzone: wynik startu w tle 1,6–2,0 s przed pierwszym hookiem; w rzadkich także wcale (agent zagnieżdżony).
    launch: normal ? weighted<number | null>([-1_800, 2], [-1_600, 1], [-2_000, 1])
      : weighted<number | null>([-1_800, 2], [-1_600, 1], [-2_000, 1], [null, 1]),
  });
  const askArb: fc.Arbitrary<AllAskEv> = fc.record({
    kind: fc.constant('ask' as const),
    who: weighted<AllWho>(['main', 2], [0, 2], [1, 2]),
    tool: weighted<AllTool>(['Bash', 4], ['Edit', 1], ['Read', 1], ['ExitPlanMode', 1]),
    cmd: fc.integer({ min: 0, max: 1 }),
    desc: fc.integer({ min: 0, max: 1 }),
    front: normal ? fc.constant(false) : weighted([false, 4], [true, 1]),
    entry: fc.constantFrom(40, 80),
  });
  const deskArb: fc.Arbitrary<AllDeskEv> = fc.record({
    kind: fc.constant('desk' as const), act: weighted<AllDeskEv['act']>(['allow', 3], ['deny', 1]),
  });
  const finishArb: fc.Arbitrary<AllFinishEv> = fc.record({ kind: fc.constant('finish' as const), pick: fc.nat(3) });
  const endArb: fc.Arbitrary<AllEndEv> = fc.record({
    kind: fc.constant('end' as const), agent: fc.constantFrom<AgentNo>(0, 1),
  });
  const events: { arbitrary: fc.Arbitrary<AllEv>; weight: number }[] = [
    { arbitrary: askArb, weight: 6 }, { arbitrary: deskArb, weight: 3 }, { arbitrary: finishArb, weight: 2 },
    { arbitrary: endArb, weight: 1 }, { arbitrary: fc.constant<AllEv>({ kind: 'turn' }), weight: 1 },
  ];
  const mids: { arbitrary: fc.Arbitrary<AllEv>; weight: number }[] = [
    { arbitrary: askArb, weight: 2 }, { arbitrary: deskArb, weight: 2 }, { arbitrary: finishArb, weight: 1 },
  ];
  if (profile !== 'zwykla-all') {
    const escArb: fc.Arbitrary<AllEscEv> = fc.record({
      kind: fc.constant('esc' as const), pick: fc.nat(3), hook: fc.constantFrom(...ESC_HOOK_LAGS),
    });
    events.push({ arbitrary: escArb, weight: 2 });
    mids.push({ arbitrary: escArb, weight: 1 });
  }
  if (!normal) {
    const killArb: fc.Arbitrary<AllKillEv> = fc.record({
      kind: fc.constant('kill' as const), agent: fc.constantFrom<AgentNo>(0, 1),
      trace: fc.constantFrom<AllKillEv['trace']>('sub', 'none'),
    });
    const foreignArb: fc.Arbitrary<AllForeignEv> = fc.record({
      kind: fc.constant('foreign' as const), pick: fc.nat(3),
      act: weighted<AllForeignEv['act']>(['allow', 2], ['deny', 1]),
    });
    events.push({ arbitrary: killArb, weight: 1 }, { arbitrary: foreignArb, weight: 2 });
    mids.push({ arbitrary: killArb, weight: 1 }, { arbitrary: foreignArb, weight: 1 });
  }
  const obsArb: fc.Arbitrary<AllObs> = fc.record({
    regLag: weighted([false, 3], [true, 1]),
    regUnknown: normal ? fc.constant(false) : weighted([false, 6], [true, 1]),
    screen: normal ? fc.constant<AllObs['screen']>('full')
      : weighted<AllObs['screen']>(['full', 6], ['unknown', 1], ['partial', 1]),
    files: normal ? fc.constant<AllObs['files']>('ok')
      : weighted<AllObs['files']>(['ok', 6], ['niedokonczona', 1], ['w-tyle', 1]),
    mainFile: normal ? fc.constant<AllObs['mainFile']>('ok') : weighted<AllObs['mainFile']>(['ok', 6], ['niedokonczona', 1]),
    list: normal ? fc.constant<AllObs['list']>('ok') : weighted<AllObs['list']>(['ok', 6], ['blad', 1]),
    psNull: normal ? fc.constant(0)
      : fc.oneof({ arbitrary: fc.constant(0), weight: 5 }, { arbitrary: fc.integer({ min: 1, max: 15 }), weight: 1 }),
    obsDelay: normal ? weighted([0, 3], [50, 1]) : weighted([0, 3], [50, 1], [700, 1]),
    screenDelay: normal ? weighted([0, 2], [100, 2], [250, 1])
      : weighted([0, 2], [100, 2], [250, 1], [900, 1], [2_500, 1]),
    psDelay: normal ? weighted([0, 2], [50, 2], [150, 1]) : weighted([0, 2], [50, 2], [150, 1], [600, 1], [2_500, 1]),
    mid: fc.oneof(
      { arbitrary: fc.constant<readonly AllEv[]>([]), weight: 3 },
      { arbitrary: fc.oneof(...mids).map((ev): readonly AllEv[] => [ev]), weight: 1 },
    ),
    midAt: weighted<MidAt>(['beforeScreen', 1], ['duringScreen', 2], ['duringPs', 2]),
    second: normal ? fc.constant(null) : fc.oneof(
      { arbitrary: fc.constant(null), weight: 4 },
      {
        arbitrary: fc.record({ gap: weighted([0, 1], [100, 2], [600, 1]), first: fc.constantFrom<'A' | 'B'>('A', 'B') }),
        weight: 1,
      },
    ),
  });
  const phoneArb: fc.Arbitrary<PhoneAct | null> = fc.option(fc.record({
    pick: fc.nat(3), act: weighted<PhoneAct['act']>(['allow', 3], ['deny', 1], ['release', 1]),
    delay: normal ? weighted([0, 3], [300, 1]) : weighted([0, 3], [300, 1], [900, 1], [2_500, 1]),
  }), { nil: null, freq: 2 });
  const stepArb: fc.Arbitrary<AllStep> = fc.record({
    events: fc.array(fc.oneof(...events), { maxLength: 2, size: 'max' }), obs: obsArb, phone: phoneArb,
  });
  return fc.record({
    agents: fc.tuple(agentArb, agentArb),
    hooks: normal ? fc.constant<AllScenario['hooks']>('tylko-rarog')
      : weighted<AllScenario['hooks']>(['tylko-rarog', 3], ['obcy', 1], ['nieczytelne', 1]),
    agentFiles: normal ? fc.constant(true) : weighted([true, 6], [false, 1]),
    askRule: fc.boolean(),
    steps: fc.array(stepArb, { minLength: 2, maxLength: 18, size: 'max' }),
  });
}

const ALL_OBS: AllObs = {
  regLag: false, regUnknown: false, screen: 'full', files: 'ok', mainFile: 'ok', list: 'ok', psNull: 0, obsDelay: 0,
  screenDelay: 0, psDelay: 0, mid: [], midAt: 'duringPs', second: null,
};

function describeAll(sc: AllScenario): string {
  const agents = sc.agents.map((one, i) => `agent ${String(i)}: ${one.background ? 'w tle' : 'pierwszy plan'}`
    + (one.background ? `, start ${one.launch === null ? 'brak' : `${String(one.launch)} ms`}` : '')).join('; ');
  const lines = [`${agents}; hooki ${sc.hooks}; pliki subagentów ${sc.agentFiles ? 'tak' : 'nie'}`];
  sc.steps.forEach((one, i) => {
    const events = one.events.map(allEvText).join('; ') || '—';
    const obs = Object.entries(one.obs).filter(([name, value]) => name !== 'midAt' && name !== 'mid'
      && JSON.stringify(ALL_OBS[name as keyof AllObs]) !== JSON.stringify(value))
      .map(([name, value]) => `${name}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
    if (one.obs.mid.length > 0) obs.push(`mid@${one.obs.midAt}=${one.obs.mid.map(allEvText).join(';')}`);
    const phone = one.phone === null ? ''
      : ` | telefon ${one.phone.act}#${String(one.phone.pick)}${one.phone.delay > 0 ? `+${String(one.phone.delay)}ms` : ''}`;
    lines.push(`  k${String(i + 1)}: ${events} | ${obs.length === 0 ? 'obs zwykła' : obs.join(',')}${phone}`);
  });
  return lines.join('\n');
}

interface AllPropertyResult { readonly found: boolean; readonly errors: readonly string[]; readonly text: string }

/** Naruszenia przebiegu: niezmienniki 5.7 i (`scope: 'all'`) właściwość odmowy przy biurku. */
type AllScope = '5.7' | 'all';
const allBad = (result: AllRunResult, scope: AllScope): readonly string[] => [
  ...result.full, ...result.desk, ...(scope === 'all' ? result.esc : []),
];

/**
 * Właściwość modelu `all` ze stałym ziarnem. Bez mutanta: wzorzec nie narusza niezmienników (`scope`). Z mutantem: nie
 * ma scenariusza, na którym wzorzec pełny przechodzi, a mutant narusza któryś niezmiennik (kontrprzykład = taki
 * scenariusz). `text` niesie ziarno, ścieżkę powtórki fast-check, minimalny scenariusz i naruszenia.
 */
function checkAll(label: string, profile: AllProfile, mutant: AllMutant | null, scope: AllScope = 'all'): AllPropertyResult {
  const errors: string[] = [];
  const bad = (sc: AllScenario): boolean => {
    const one = allBad(runAll(sc), scope);
    if (mutant === null) return one.length > 0;
    if (one.length > 0) return false;
    return allBad(runAll(sc, mutant), scope).length > 0;
  };
  const started = Date.now();
  const details = fc.check(fc.property(allScenarioArb(profile), (sc) => {
    try {
      return !bad(sc);
    } catch (err) {
      errors.push(err instanceof Error ? err.stack ?? err.message : String(err));
      return true;
    }
  }), { seed: SEED, numRuns: ALL_RUNS });
  const took = `${((Date.now() - started) / 1000).toFixed(1)} s`;
  const [counterexample] = details.counterexample ?? [];
  let text = `${label}: 0 kontrprzykładów w ${String(details.numRuns)} przebiegach (ziarno ${String(SEED)}, ${took})`;
  if (counterexample !== undefined) {
    const again = runAll(counterexample, mutant);
    text = `${label}: kontrprzykład po ${String(details.numRuns)} przebiegach, ${String(details.numShrinks)} zmniejszeń`
      + ` (ziarno ${String(SEED)}, ścieżka ${String(details.counterexamplePath)}, ${took})\n${describeAll(counterexample)}`
      + `\n  naruszenia:\n    ${allBad(again, scope).slice(0, 4).join('\n    ')}`;
  }
  if (SHOW) console.log(`[rama all] ${text}`);
  return { found: details.failed, errors, text };
}

const prodBad = (result: AllProdResult): readonly string[] => [
  ...result.full, ...result.desk, ...result.esc, ...result.oracle,
];

/**
 * Właściwość `all` na kodzie produkcyjnym ze stałym ziarnem i {@link RUNS} przebiegami (jak pozostałe właściwości
 * kodu produkcyjnego): bez naruszeń niezmienników 5.7, właściwości odmowy przy biurku i drugiej wyroczni.
 */
async function checkAllProduction(label: string, profile: AllProfile): Promise<AllPropertyResult> {
  const errors: string[] = [];
  const started = Date.now();
  const details = await fc.check(fc.asyncProperty(allScenarioArb(profile), async (sc) => {
    try {
      return prodBad(await runAllProduction(sc)).length === 0;
    } catch (err) {
      errors.push(err instanceof Error ? err.stack ?? err.message : String(err));
      return true;
    }
  }), { seed: SEED, numRuns: RUNS });
  const took = `${((Date.now() - started) / 1000).toFixed(1)} s`;
  const [counterexample] = details.counterexample ?? [];
  let text = `${label}: 0 kontrprzykładów w ${String(details.numRuns)} przebiegach (ziarno ${String(SEED)}, ${took})`;
  if (counterexample !== undefined) {
    const again = await runAllProduction(counterexample);
    text = `${label}: kontrprzykład po ${String(details.numRuns)} przebiegach, ${String(details.numShrinks)} zmniejszeń`
      + ` (ziarno ${String(SEED)}, ścieżka ${String(details.counterexamplePath)}, ${took})\n${describeAll(counterexample)}`
      + `\n  naruszenia:\n    ${prodBad(again).slice(0, 4).join('\n    ')}`;
  }
  return { found: details.failed, errors, text };
}

const allAsk = (who: AllWho, over: Partial<Omit<AllAskEv, 'kind' | 'who'>> = {}): AllAskEv => ({
  kind: 'ask', who, tool: 'Bash', cmd: 0, desc: 0, front: false, entry: 80, ...over,
});
const allStep = (events: readonly AllEv[], over: Partial<AllObs> = {}, phone: PhoneAct | null = null): AllStep => ({
  events, obs: { ...ALL_OBS, ...over }, phone,
});
const allIdle = (count: number, over: Partial<AllObs> = {}): AllStep[] =>
  Array.from({ length: count }, () => allStep([], over));
/** Scenariusz przypadku: dwa subagenty w tle z wynikiem startu przed hookiem, sam hook Raroga, pliki czytelne. */
const allScenario = (steps: readonly AllStep[], over: Partial<Omit<AllScenario, 'steps'>> = {}): AllScenario => ({
  agents: [{ background: true, launch: -1_800 }, { background: true, launch: -1_800 }], hooks: 'tylko-rarog',
  agentFiles: true, askRule: true, steps, ...over,
});
const deskAllow: AllDeskEv = { kind: 'desk', act: 'allow' };

/**
 * Wynik przypadku: naruszenia obu niezmienników i właściwości odmowy, przyciski według prośby i rodzaju dowodu,
 * podpisane zgody z rodzajem dowodu, zgody przyjęte przez CLI, `release` po karencji subagenta.
 */
const allOutcome = (result: AllRunResult): Record<string, unknown> => ({
  full: result.full, desk: result.desk, esc: result.esc, buttons: result.buttons, allows: result.allows,
  applied: result.applied, releases: result.releases,
});

/** Wynik przypadku bez przycisków, zgód i `release`; przypadki nadpisują swoje pola. */
const ALL_NONE = { full: [], desk: [], esc: [], buttons: {}, allows: {}, applied: [], releases: 0 };
/** Agent 0 na pierwszym planie, agent 1 w tle. */
const FG_AGENTS: AllScenario['agents'] = [{ background: false, launch: null }, { background: true, launch: -1_800 }];

/**
 * Przypadki wejście → wynik, na wzorcu i na kodzie produkcyjnym. Liczba taktów bez dowodu tak dobrana,
 * że karencja subagenta (10 s) mija przy 8 taktach po 1,5 s od rejestracji.
 */
const ALL_CASES: readonly (readonly [string, AllScenario, Record<string, unknown>])[] = [
  ['wątek główny, dialog na wierzchu → przycisk z wierzchu, zgoda z telefonu z `proofKind: \'top\'` (jak przy `main`)',
    allScenario([allStep([allAsk('main')], {}, phoneAct(0, 'allow')), ...allIdle(2)]),
    { ...ALL_NONE, buttons: { '#0': ['top'] }, allows: { '#0': 'top' }, applied: ['#0'] }],
  ['`bg`, hook czeka, wszystkie warunki dowodu ukrytego, rejestr świeży `busy` → przycisk, zgoda z telefonu z `proofKind: \'hidden\'`', allScenario([
    allStep([allAsk(0)]), allStep([], {}, phoneAct(0, 'allow')), ...allIdle(2),
  ]), { ...ALL_NONE, buttons: { '#0': ['hidden'] }, allows: { '#0': 'hidden' }, applied: ['#0'] }],
  ['`bg`, w sesji stoi dialog wątku głównego (`waiting: permission`) → bez dowodu ukrytego, termin łaski stoi', allScenario([
    allStep([allAsk('main', { cmd: 1 }), allAsk(0)]), ...allIdle(10),
  ]), { ...ALL_NONE, buttons: { '#0': ['top'] } }],
  ['`bg`, po decyzji przy biurku dialogu wątku głównego dowód ukryty wraca', allScenario([
    allStep([allAsk('main', { cmd: 1 }), allAsk(0)]), ...allIdle(10), allStep([deskAllow]), ...allIdle(2),
  ]), { ...ALL_NONE, buttons: { '#0': ['top'], '#1': ['hidden'] } }],
  ['`bg`, rejestr nieznany → bez dowodu ukrytego, termin łaski biegnie, `desk-fallback`', allScenario([
    allStep([allAsk(0)], { regUnknown: true }), ...allIdle(9, { regUnknown: true }),
  ]), { ...ALL_NONE, releases: 1 }],
  ['`bg` bez wyniku `async_launched` (klasa `fg-or-unknown`, rejestr `busy`) → bez przycisku, po terminie łaski `desk-fallback`',
    allScenario([allStep([allAsk(0)]), ...allIdle(9)], { agents: [{ background: true, launch: null }, {
      background: true, launch: null,
    }] }), { ...ALL_NONE, releases: 1 }],
  ['`bg`, wynik `async_launched` 4 s po hooku (poza oknem pomiaru, klasa `bg`) → przycisk dopiero od wyniku startu', allScenario([
    allStep([allAsk(0)]), allStep([]), ...allIdle(2),
  ], { agents: [{ background: true, launch: 4_000 }, { background: true, launch: -1_800 }] }),
  { ...ALL_NONE, buttons: { '#0': ['hidden'] } }],
  ['`bg`, obcy hook na liście hooków sesji → bez dowodu (nie tylko hook Raroga), po terminie łaski `desk-fallback`', allScenario([
    allStep([allAsk(0)]), ...allIdle(9),
  ], { hooks: 'obcy' }), { ...ALL_NONE, releases: 1 }],
  ['`bg`, warstwa ustawień nieczytelna → bez dowodu listy hooków', allScenario([
    allStep([allAsk(0)]), ...allIdle(9),
  ], { hooks: 'nieczytelne' }), { ...ALL_NONE, releases: 1 }],
  ['`bg`, błąd odczytu listy hooków sesji → bez dowodu listy hooków', allScenario([
    allStep([allAsk(0)], { list: 'blad' }), ...allIdle(9, { list: 'blad' }),
  ]), { ...ALL_NONE, releases: 1 }],
  ['`bg`, plik subagenta z niedokończoną linią → bez dowodu pliku subagenta', allScenario([
    allStep([allAsk(0)], { files: 'niedokonczona' }), ...allIdle(9, { files: 'niedokonczona' }),
  ]), { ...ALL_NONE, releases: 1 }],
  ['`bg`, czytnik w tyle (`caughtUp: false`) → bez dowodu pliku subagenta', allScenario([
    allStep([allAsk(0)], { files: 'w-tyle' }), ...allIdle(9, { files: 'w-tyle' }),
  ]), { ...ALL_NONE, releases: 1 }],
  ['`bg`, plik główny z niedokończoną linią → bez dowodu (klasa `bg` i doczytane pliki)', allScenario([
    allStep([allAsk(0)], { mainFile: 'niedokonczona' }), ...allIdle(9, { mainFile: 'niedokonczona' }),
  ]), { ...ALL_NONE, releases: 1 }],
  ['`RAROG_AGENT_FILES=0` → subagenci bez dowodu → `desk-fallback`', allScenario([
    allStep([allAsk(0)]), ...allIdle(9),
  ], { agentFiles: false }), { ...ALL_NONE, releases: 1 }],
  ['`bg` dopasowany na wierzchu jako bliźniak identycznego `Bash` wątku głównego → dowód ukryty utracony na zawsze',
    allScenario([allStep([allAsk('main'), allAsk(0)]), allStep([]), allStep([deskAllow]), ...allIdle(8)]),
    { ...ALL_NONE, releases: 1 }],
  ['`bg`, `ctrl+x ctrl+k` → hook martwy, karta bez przycisku, zgoda z telefonu niemożliwa', allScenario([
    allStep([allAsk(0)]), allStep([{ kind: 'kill', agent: 0, trace: 'none' }], {}, phoneAct(0, 'allow')), ...allIdle(2),
  ]), { ...ALL_NONE, buttons: { '#0': ['hidden'] } }],
  ['agent wznowiony przez `SendMessage` po `task-notification` → nowa prośba nie zamknięta starym końcem', allScenario([
    allStep([allAsk(0)], {}, phoneAct(0, 'deny')), allStep([]), allStep([{ kind: 'end', agent: 0 }]),
    allStep([allAsk(0, { cmd: 1 })]), ...allIdle(2),
  ]), { ...ALL_NONE, buttons: { '#0': ['hidden'], '#1': ['hidden'] } }],
  ['dwa subagenty w tle z identycznym `Bash` → osobne klucze, osobne dowody', allScenario([
    allStep([allAsk(0), allAsk(1)]), ...allIdle(2),
  ]), { ...ALL_NONE, buttons: { '#0': ['hidden'], '#1': ['hidden'] } }],
  ['koniec jednego subagenta nie zamyka prośby drugiego', allScenario([
    allStep([allAsk(0)], {}, phoneAct(0, 'deny')), allStep([allAsk(1, { cmd: 1 })]), allStep([{ kind: 'end', agent: 0 }]),
    ...allIdle(2),
  ]), { ...ALL_NONE, buttons: { '#0': ['hidden'], '#1': ['hidden'] } }],
  ['`fg`, dialog na wierzchu, rejestr `waiting` → przycisk z wierzchu, zgoda z telefonu z `proofKind: \'top\'`',
    allScenario([allStep([allAsk(0)], {}, phoneAct(0, 'allow')), ...allIdle(2)], { agents: FG_AGENTS }),
    { ...ALL_NONE, buttons: { '#0': ['top'] }, allows: { '#0': 'top' }, applied: ['#0'] }],
  ['`fg` za dialogiem wątku głównego → przycisk dopiero na wierzchu, po decyzji przy biurku o wątku głównym',
    allScenario([
      allStep([allAsk('main'), allAsk(0, { cmd: 1 })]), allStep([deskAllow], {}, phoneAct(0, 'allow')), ...allIdle(2),
    ], { agents: FG_AGENTS }),
    { ...ALL_NONE, buttons: { '#0': ['top'], '#1': ['top'] }, allows: { '#1': 'top' }, applied: ['#1'] }],
  ['`fg`, decyzja przy biurku przed pierwszym odczytem ekranu → hook sierota bez przycisku', allScenario([
    allStep([allAsk(0), deskAllow]), ...allIdle(9),
  ], { agents: FG_AGENTS }), { ...ALL_NONE, releases: 1 }],
  ['`bg`, Esc w widoku subagenta, obserwacja czyta ślad przy żywym hooku → plik subagenta zabiera dowód, zgody z telefonu brak',
    allScenario([allStep([allAsk(0)]), allStep([{ kind: 'esc', pick: 0, hook: 2_000 }], {}, phoneAct(0, 'allow')),
      ...allIdle(2)]),
    { ...ALL_NONE, buttons: { '#0': ['hidden'] } }],
  ['`bg`, Esc w widoku subagenta w trakcie `ps` obserwacji → zgoda podpisana z dowodu sprzed odmowy, hook ją odbiera,'
    + ' CLI jej nie stosuje (N5)', allScenario([
    allStep([allAsk(0)]),
    allStep([], { mid: [{ kind: 'esc', pick: 0, hook: 2_000 }], midAt: 'duringPs' }, phoneAct(0, 'allow')),
    ...allIdle(2),
  ]), { ...ALL_NONE, buttons: { '#0': ['hidden'] }, allows: { '#0': 'hidden' } }],
];

/**
 * Prośba subagenta na pierwszym planie czeka w kolejce wyłącznie za dialogiem wątku głównego: jej dialog nie stoi na
 * wierzchu i nie jest `hidden`, więc zgoda dla niej łamie „pełny-all”. Rejestr o takt w tyle mówi `busy`, więc mutant
 * bez warunku startu w tle daje jej dowód ukryty i podpisuje zgodę z telefonu.
 */
const FG_BEHIND_MAIN = allScenario([
  allStep([allAsk('main'), allAsk(0, { cmd: 1 })], { regLag: true }, phoneAct(0, 'allow')), ...allIdle(2),
], { agents: FG_AGENTS });

/**
 * Koniec tury głównej przy czekającym subagencie w tle i następna tura z innym `promptId`: cel subagenta żyje dalej
 * (przycisk i zgoda po końcu tury), prośba nowej tury dostaje dowód z wierzchu jak w pierwszej.
 */
const TURN_END = allScenario([
  allStep([allAsk(0), allAsk('main', { cmd: 1 })], {}, phoneAct(0, 'allow')),
  allStep([{ kind: 'finish', pick: 0 }, { kind: 'turn' }]),
  allStep([allAsk('main', { cmd: 2 })], {}, phoneAct(0, 'allow')),
  allStep([{ kind: 'finish', pick: 0 }], {}, phoneAct(0, 'allow')),
  ...allIdle(2),
]);
const TURN_END_OUTCOME = {
  ...ALL_NONE, buttons: { '#0': ['hidden'], '#1': ['top'], '#2': ['top'] },
  allows: { '#0': 'hidden', '#1': 'top', '#2': 'top' }, applied: ['#0', '#1', '#2'],
};

/** Odmowa przy biurku: Esc w widoku subagenta przed obserwacją (pierwszy z dwóch przypadków Esc w {@link ALL_CASES}). */
const ESC_CLOSED = ALL_CASES[ALL_CASES.length - 2]?.[1] ?? allScenario([]);
/** Odmowa przy biurku: Esc w trakcie `ps`, spóźniona zgoda (drugi przypadek Esc w {@link ALL_CASES}). */
const ESC_LATE = ALL_CASES[ALL_CASES.length - 1]?.[1] ?? allScenario([]);

/**
 * Mutanty i profil, w którym każdy ma kontrprzykład niezmienników 5.7 (na scenariuszu, na którym wzorzec pełny
 * przechodzi). Mutant bez doczytanych plików w profilu rzadkim, nie przy odmowie przy biurku: hook żyje do 2 s po
 * śladzie, tyle co tolerancja „pełny-all”, więc dopiero opóźnienie zrzutu ekranu 900 ms kładzie podpisaną zgodę za
 * tolerancją. Sam ślad odmowy bez tego warunku łapie właściwość „odmowa przy biurku → zamknięcie w pliku subagenta”.
 */
const MUTANT_PROFILES: readonly (readonly [AllMutant, AllProfile])[] = [
  ['bg-class', 'zwykla-all'], ['settled', 'rzadkie-all'], ['only-rarog', 'rzadkie-all'], ['grace', 'zwykla-all'],
];

/** Ramka dialogu z pomiaru (CLI 2.1.319, `consent-dowod/m8-*.ekran.txt`), ramka komendy podmieniona na `echo 0`. */
const measuredScreen = (name: string, bash = true): string => {
  const text = readFileSync(join(import.meta.dirname, 'fixtures', 'consent-dowod', `${name}.ekran.txt`), 'utf8');
  return bash ? withBashFrame(text, ' echo 0') : text;
};

describe('rama przy `all`: model subagentów i wzorzec reguł dowodu ukrytego z karencją subagenta', () => {
  it.each([['zwykła praca', 'zwykla-all'], ['odmowa przy biurku', 'odmowa-all'], ['rzadkie', 'rzadkie-all']] as const)(
    'wzorzec, %s: „pełny-all”, „biurko” i odmowa przy biurku bez kontrprzykładu', (name, profile) => {
      const result = checkAll(`wzorzec, ${name}`, profile, null);
      console.log(`[rama all] ${result.text}`);
      expect(result.errors).toEqual([]);
      expect(result.found, result.text).toBe(false);
    }, PROPERTY_TIMEOUT_MS,
  );

  it('licznik pokrycia: prośby `hidden` mają przycisk i zgodę, odmowa przy biurku zamyka w pliku przy żywym hooku', () => {
    const tally = { buttons: 0, allows: 0, closed: 0, late: 0 };
    for (const [profile, seed] of [['zwykla-all', SEED + 3], ['odmowa-all', SEED + 4]] as const) {
      for (const sc of fc.sample(allScenarioArb(profile), { seed, numRuns: 1_000 })) {
        const result = runAll(sc);
        tally.buttons += result.hiddenButtons;
        tally.allows += result.hiddenAllows;
        tally.closed += result.escClosed;
        tally.late += result.escLate;
      }
    }
    console.log(`[rama all] pokrycie wzorca (po 1000 scenariuszy zwykłej pracy i odmowy, ziarna ${String(SEED + 3)},`
      + ` ${String(SEED + 4)}): ${String(tally.buttons)} próśb \`hidden\` z przyciskiem, ${String(tally.allows)} zgód`
      + ` z telefonu, ${String(tally.closed)} zamknięć w pliku subagenta przy żywym hooku,`
      + ` ${String(tally.late)} spóźnionych zgód`);
    expect(tally.buttons).toBeGreaterThan(0);
    expect(tally.allows).toBeGreaterThan(0);
    expect(tally.closed).toBeGreaterThan(0);
    // Spóźniona zgoda trafia się w losowaniu raz na ~1000 scenariuszy; pewne pokrycie daje przypadek ESC_LATE niżej.
  });

  it.each(MUTANT_PROFILES)('mutant bez %s: kontrprzykład niezmienników 5.7 z ziarnem w profilu %s', (mutant, profile) => {
    const result = checkAll(`mutant bez ${mutant}, ${profile}`, profile, mutant, '5.7');
    console.log(`[rama all] ${result.text}`);
    expect(result.errors).toEqual([]);
    expect(result.found).toBe(true);
  }, PROPERTY_TIMEOUT_MS);

  it('przy zmierzonym zachowaniu biurka mutanty bez utraty wierzchu i bez rejestru nie mają kontrprzykładu: te reguły'
    + ' bronią tylko przed biurkiem, które widzi ukrytą prośbę', () => {
    for (const mutant of ['top-kept', 'busy'] as const) {
      const result = checkAll(`mutant bez ${mutant}, rzadkie-all`, 'rzadkie-all', mutant);
      expect(result.errors).toEqual([]);
      expect({ mutant, found: result.found }, result.text).toEqual({ mutant, found: false });
    }
  }, PROPERTY_TIMEOUT_MS);

  // The desk does not see a hidden request (measured on CLI 2.1.319), and Esc in the subagent view rejects it; the
  // refusal trace in the subagent file counts as a closure.
  it('odmowa przy biurku → zamknięcie w pliku subagenta, późne allow bez skutku: mutant bez doczytanych plików ma'
    + ' kontrprzykład', () => {
    const result = checkAll('odmowa przy biurku, mutant bez doczytanych plików', 'odmowa-all', 'settled');
    console.log(`[rama all] ${result.text}`);
    expect(result.errors).toEqual([]);
    expect(result.found).toBe(true);
    expect(result.text).toContain('odrzucona Esc');
  }, PROPERTY_TIMEOUT_MS);

  it.each(ALL_CASES)('przypadek: %s', (_name, sc, expected) => {
    expect(allOutcome(runAll(sc))).toEqual(expected);
  });

  it('odmowa przy biurku na wzorcu: zamknięcie w pliku subagenta przy żywym hooku, spóźniona zgoda odebrana'
    + ' i bez skutku', () => {
    expect([runAll(ESC_CLOSED).escClosed, runAll(ESC_CLOSED).escLate]).toEqual([1, 0]);
    const late = runAll(ESC_LATE);
    expect([late.escLate, late.applied]).toEqual([1, []]);
    expect(runAll(ESC_CLOSED, 'settled').esc.length, 'mutant bez doczytanych plików daje dowód z odczytu ze śladem').toBeGreaterThan(0);
  });

  it('prośba na pierwszym planie czekająca wyłącznie za innym dialogiem: zgoda dla niej łamie „pełny-all”', () => {
    expect(allOutcome(runAll(FG_BEHIND_MAIN))).toEqual({ ...ALL_NONE, buttons: { '#0': ['top'] } });
    const mutant = runAll(FG_BEHIND_MAIN, 'bg-class');
    expect(mutant.allows).toEqual({ '#1': 'hidden' });
    expect(mutant.full.some((line) => line.includes('podpisana zgoda') && line.includes('prośba #1')), mutant.full
      .join('\n')).toBe(true);
  });

  it('koniec tury głównej przy czekającym subagencie w tle: jego cel żyje, nowa tura ma inny `promptId`', () => {
    const result = runAll(TURN_END);
    expect(allOutcome(result)).toEqual(TURN_END_OUTCOME);
    expect(result.prompts).toEqual([PROMPT, PROMPT, promptOf(1)]);
  });
});

describe('rama przy `all` na kodzie produkcyjnym: obserwacja, cykl i `decide`, wzorzec reguł jako druga'
  + ' wyrocznia', () => {
  it('abstrakcja tożsamości modelu daje to samo co produkcyjne `matchTop` na zmierzonych ramkach subagenta', () => {
    const tops: readonly (readonly [string, string, string])[] = [
      ['subagent na pierwszym planie', measuredScreen('foreground-subagent'), modelScreen('Bash', 0, 0, 1)],
      ['wątek główny', measuredScreen('foreground-main'), modelScreen('Bash', 0, 0, 1)],
      ['wątek główny przy ukrytej prośbie', measuredScreen('main-beside-hidden'), modelScreen('Bash', 0, 0, 1)],
      ['subagent w tle po `release`', measuredScreen('background-after-release'), modelScreen('Bash', 0, 0, 1)],
      ['kolejka 1 z 2, wątek główny', measuredScreen('queue-1of2-main'), modelScreen('Bash', 0, 0, 2)],
      ['kolejka 2 z 2, subagent w tle', measuredScreen('queue-2of2-background'), modelScreen('Bash', 0, 0, 2)],
      ['„Exit and stop tasks” przy pracy w tle', measuredScreen('exit-background-work', false),
        renderScreen({ standing: 0, tool: null, bare: '', file: '', askRule: false }, false)],
    ];
    const sub = (dump: HookCallDump): HookCallDump => ({ ...dump, agentId: 'agent-1' });
    const dumps: readonly (readonly [string, HookCallDump])[] = [
      ['Bash echo 0 opis 0', modelDump('Bash', 0, 0)], ['Bash echo 0 opis 0 subagenta', sub(modelDump('Bash', 0, 0))],
      ['Bash echo 0 opis 1 subagenta', sub(modelDump('Bash', 0, 1))], ['Bash echo 1', modelDump('Bash', 1, 0)],
      ['Bash echo 1 subagenta', sub(modelDump('Bash', 1, 0))], ['Bash przycięty subagenta', sub(modelDump('Bash', 0, 0, true))],
      ['Edit f0 0 subagenta', sub(modelDump('Edit', 0, 0))], ['Read r0 subagenta', sub(modelDump('Read', 0, 0))],
    ];
    const differ: string[] = [];
    const results = new Set<TopMatch>();
    for (const [topName, real, model] of tops) {
      for (const [dumpName, dump] of dumps) {
        const production = matchTop(real, dump);
        results.add(production);
        const abstraction = modelMatchTop(model, dump);
        if (production !== abstraction) differ.push(`${topName} × ${dumpName}: produkcja ${production}, model ${abstraction}`);
      }
    }
    expect(differ).toEqual([]);
    expect([...results].sort()).toEqual(['match', 'no', 'unknown']);
    // Dialog agenta workflow (klasa `fg-or-unknown`, poza modelem): wierzch bez tożsamości dla każdego zrzutu.
    const workflow = measuredScreen('workflow');
    expect(dumps.map(([, dump]) => matchTop(workflow, dump))).toEqual(dumps.map(() => 'unknown'));
  });

  it.each([['zwykła praca', 'zwykla-all'], ['odmowa przy biurku', 'odmowa-all'], ['rzadkie', 'rzadkie-all']] as const)(
    'kod produkcyjny, %s: „pełny-all”, „biurko”, odmowa przy biurku i druga wyrocznia bez kontrprzykładu',
    async (name, profile) => {
      const result = await checkAllProduction(`kod produkcyjny, ${name}`, profile);
      console.log(`[rama all] ${result.text}`);
      expect(result.errors).toEqual([]);
      expect(result.found, result.text).toBe(false);
    }, PROPERTY_TIMEOUT_MS,
  );

  it('licznik pokrycia na kodzie produkcyjnym: przyciski i zgody `hidden`, zamknięcia w pliku subagenta, odmowy'
    + ' `decide(allow)`',
    async () => {
      const tally = { buttons: 0, allows: 0, closed: 0, late: 0, refused: 0, stricter: 0 };
      for (const [profile, seed] of [['zwykla-all', SEED + 3], ['odmowa-all', SEED + 4]] as const) {
        for (const sc of fc.sample(allScenarioArb(profile), { seed, numRuns: 1_000 })) {
          const result = await runAllProduction(sc);
          tally.buttons += result.hiddenButtons;
          tally.allows += result.hiddenAllows;
          tally.closed += result.escClosed;
          tally.late += result.escLate;
          tally.refused += result.refused;
          tally.stricter += result.stricter;
        }
      }
      console.log(`[rama all] pokrycie kodu produkcyjnego (po 1000 scenariuszy zwykłej pracy i odmowy): `
        + `${String(tally.buttons)} próśb \`hidden\` z przyciskiem, ${String(tally.allows)} zgód z telefonu,`
        + ` ${String(tally.closed)} zamknięć w pliku subagenta przy żywym hooku,`
        + ` ${String(tally.late)} spóźnionych zgód,`
        + ` ${String(tally.refused)} odmów \`decide(allow)\` po śladzie, ${String(tally.stricter)} kluczy z dowodem`
        + ' ukrytym wzorca bez dowodu produkcji');
      expect(tally.buttons).toBeGreaterThan(0);
      expect(tally.allows).toBeGreaterThan(0);
      expect(tally.closed).toBeGreaterThan(0);
      // Spóźniona zgoda: jak w liczniku wzorca, pewne pokrycie daje przypadek ESC_LATE niżej.
      expect(tally.refused).toBeGreaterThan(0);
    }, PROPERTY_TIMEOUT_MS);

  it.each(ALL_CASES)('przypadek na kodzie produkcyjnym: %s', async (_name, sc, expected) => {
    const result = await runAllProduction(sc);
    expect(allOutcome(result)).toEqual(expected);
    expect(result.oracle).toEqual([]);
  });

  it('odmowa przy biurku na kodzie produkcyjnym: plik subagenta zamyka przy żywym hooku, `decide(allow)` pada,'
    + ' spóźniona zgoda bez skutku', async () => {
    const closed = await runAllProduction(ESC_CLOSED);
    expect([closed.escClosed, closed.refused, closed.escLate]).toEqual([1, 1, 0]);
    const late = await runAllProduction(ESC_LATE);
    expect([late.escLate, late.applied]).toEqual([1, []]);
  });

  it('prośba na pierwszym planie za dialogiem wątku głównego i koniec tury głównej: jak na wzorcu', async () => {
    expect(allOutcome(await runAllProduction(FG_BEHIND_MAIN))).toEqual({ ...ALL_NONE, buttons: { '#0': ['top'] } });
    const turn = await runAllProduction(TURN_END);
    expect(allOutcome(turn)).toEqual(TURN_END_OUTCOME);
    expect(turn.prompts).toEqual([PROMPT, PROMPT, promptOf(1)]);
  });
});
