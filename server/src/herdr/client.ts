/**
 * Typowana fasada nad socketem herdr: kształty odpowiedzi → `HerdrAgentInfo`, kody błędów
 * herdr → klasy błędów Raroga.
 *
 * Tu mieszka też TWARDY FILTR WEJŚCIOWY integracji: `agent === 'claude'` (a przy
 * `RAROG_CODEX_STATUS` także `agent === 'codex'`), `agent_session.kind === 'id'`
 * i `value` pasujące do `ENGINE_SESSION_ID_PATTERN`. Filtr musi być w tym miejscu, bo tylko tu
 * widać jeszcze surowe pola `agent`/`kind` — kontrakt `HerdrAgentInfo` ich nie niesie.
 * Cokolwiek innego (inny agent, `kind: 'path'`, panel bez `cwd`) NIE ISTNIEJE dla Raroga:
 * nie ma pliku transkryptu, nie ma sprawdzalnego zakresu, nie ma czego pokazać.
 *
 * Nieznane pola odpowiedzi IGNORUJEMY (`z.looseObject`, nie `z.strictObject`): herdr wydaje
 * minor co 2–3 tygodnie i dokłada pola addytywnie, a Rarog nie ma prawa paść od nowego pola.
 */
import { z } from 'zod';
import { basename } from 'node:path';
import { TERM_ID_RE } from '@rarog/shared';
import { foreign, say } from '@rarog/shared/sentences';
import {
  HERDR_PROMPT_WAIT_MS, HERDR_START_REQUEST_TIMEOUT_MS, HERDR_START_WAIT_MS,
  termPaneTokenOf,
} from '../config.ts';
import { ENGINE_SESSION_ID_PATTERN } from '../transcript-import.ts';
import { assertAllowedKeys } from './dialogs/send/keys.ts';
import { RAROG_AGENT_NAME_RE } from './provenance.ts';
import { FORM_SUBMIT_KEY, assertFormSubmitKeys } from './dialogs/send/form-submit.ts';
import { MODE_CYCLE_KEY, assertModeCycleKeys } from './mode-cycle.ts';
import { assertDialogKey } from './dialogs/send/key-row.ts';
import type { KeyRowKey } from './dialogs/send/key-row.ts';
import { assertTakeBackKey } from './dialogs/send/take-back-keys.ts';
import type { TakeBackKey } from './dialogs/send/take-back-keys.ts';
import { assertTrustStepKeys } from './dialogs/send/trust-step.ts';
import type { TrustStepKey } from './dialogs/send/trust-step.ts';
import { PROMPT_SUBMIT_KEY, assertPromptSubmitKeys } from './dialogs/send/prompt-submit.ts';
import {
  HerdrBlockedError, HerdrError, HerdrGoneError, HerdrReadOnlyError, HerdrStalledError,
} from './types.ts';
import type {
  HerdrAgentInfo, HerdrAgentStatus, HerdrClient, HerdrCreateTabResult,
  HerdrCreateWorkspaceResult, HerdrEngine, HerdrLaunchClient, HerdrLaunchProbeInfo,
  HerdrPaneHistory, HerdrPaneInfo, HerdrPaneLayout, HerdrPaneProcessInfo, HerdrScreen,
  HerdrStartAgentResult, HerdrTabInfo, HerdrWorkspaceInfo,
} from './types.ts';
import { HerdrRemoteError } from './socket.ts';
import type { HerdrRequestOptions } from './socket.ts';

/** Wszystko, czego klient potrzebuje od transportu — pozwala testować go bez gniazda. */
export interface HerdrRequester {
  request(
    method: string, params: Record<string, unknown>, opts?: HerdrRequestOptions,
  ): Promise<unknown>;
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  'idle', 'working', 'blocked', 'done', 'unknown',
]);

const agentSessionSchema = z.looseObject({
  agent: z.string().nullish(),
  kind: z.string().nullish(),
  source: z.string().nullish(),
  value: z.string().nullish(),
});

/**
 * Wpis `agent.list` / `agent.get`.
 *
 * Wymagane są tylko `pane_id` i `agent_status` — dokładnie tak, jak w schemacie herdr
 * (`AgentInfo.required`). Reszta bywa `null` (panel bez agenta, agent bez sesji) i to jest
 * normalny stan, a nie błąd odpowiedzi.
 */
const agentInfoSchema = z.looseObject({
  agent: z.string().nullish(),
  agent_session: agentSessionSchema.nullish(),
  agent_status: z.string(),
  cwd: z.string().nullish(),
  pane_id: z.string(),
  tab_id: z.string().nullish(),
  state_change_seq: z.number().nullish(),
  terminal_title_stripped: z.string().nullish(),
  /**
   * Pola, których ŻYWY `agent.list` nie niesie (zweryfikowane na 17 agentach).
   * `nullish()`, a nie wymagane: przy `.parse()` z wymaganym `tokens` cała integracja
   * przestałaby widzieć jakikolwiek panel — i to jest dokładnie ten rodzaj awarii, którego
   * `z.looseObject` ma nie dopuścić.
   */
  tokens: z.record(z.string(), z.string()).nullish(),
  interactive_ready: z.boolean().nullish(),
  /** herdr ≥ 0.9.0: `true` między `agent.start` a gotowością; potem pole ZNIKA. */
  launch_pending: z.boolean().nullish(),
  /**
   * Nazwa nadana w `agent.start` (`rarog-<6 hex>` u Raroga) — źródło własności. Agent
   * uruchomiony ręcznie albo wykryty przez herdr po wygaśnięciu rekordu startu jej NIE MA.
   * `catch(null)`: pole w obcym typie ma zgasić własność, a nie wyrzucić agenta z listy.
   */
  name: z.string().nullish().catch(null),
});

const agentListResultSchema = z.looseObject({ agents: z.array(z.unknown()) });
const agentInfoResultSchema = z.looseObject({ agent: z.unknown() });
const readResultSchema = z.looseObject({ read: z.looseObject({ text: z.string() }) });
const pongSchema = z.looseObject({ version: z.string(), protocol: z.number() });

// --- Kanał TWORZENIA ---

/** Wpis `pane.list` — jedyna odpowiedź herdr niosąca `cwd` panelu. */
const paneInfoSchema = z.looseObject({
  pane_id: z.string(),
  tab_id: z.string().nullish(),
  workspace_id: z.string().nullish(),
  cwd: z.string().nullish(),
  tokens: z.record(z.string(), z.string()).nullish(),
  /**
   * Etykieta panelu (`pane.rename`) — dowód pochodzenia (`herdr/provenance.ts`).
   * `catch(null)` z tego samego powodu co przy `name` agenta: obcy typ = brak etykiety,
   * a nie zniknięcie panelu z listy (launcher i terminal szukają po niej workspace'u i tokenu).
   */
  label: z.string().nullish().catch(null),
  /**
   * Powód, dla którego herdr nie odtworzył panelu po restarcie (zmierzone na herdr 0.9.4:
   * „Saved directory is unavailable…", gdy katalog panelu zniknął). `catch(null)`: obcy typ =
   * panel żywy, jak bez pola — pomyłka w drugą stronę chowałaby żywą powłokę.
   */
  restore_error: z.string().nullish().catch(null),
});
const paneListResultSchema = z.looseObject({ panes: z.array(z.unknown()) });

/**
 * Wynik `tab.get` (`{ type: 'tab_info', tab: TabInfo }` — `herdr api schema --json`, 0.9.3).
 * Wymagamy czterech pól, na których stoi decyzja o `tab.rename`;
 * reszta `TabInfo` (`number`, `focused`, `agent_status`) przychodzi i jest ignorowana. Brak
 * któregokolwiek z czterech = nieznany kształt, a nie „pusta etykieta": tab z odczytem, któremu
 * nie da się ufać, nie dostaje od Raroga nowej nazwy.
 */
const tabGetResultSchema = z.looseObject({
  tab: z.looseObject({
    tab_id: z.string(),
    label: z.string(),
    pane_count: z.number().int().nonnegative(),
    workspace_id: z.string(),
  }),
});

/**
 * Wynik `workspace.list` (`{ type: 'workspace_list', workspaces: WorkspaceInfo[] }` — `herdr api
 * schema --json`, 0.9.3). Lista jest WYMAGANA (bez niej rzut — nie wiemy
 * nic, a „nic" nie może znaczyć „brak workspace'ów"); pojedynczy wpis bez `workspace_id` albo
 * `label` odpada. `worktree` herdr wysyła wyłącznie przy checkoucie gita, a zły typ jego pól
 * znaczy „ścieżki nie znamy" (`catch`), nie zniknięcie workspace'u z listy.
 */
const workspaceListResultSchema = z.looseObject({ workspaces: z.array(z.unknown()) });
const workspaceInfoSchema = z.looseObject({
  workspace_id: z.string().min(1),
  label: z.string(),
  worktree: z.looseObject({
    checkout_path: z.string().nullish().catch(null),
    repo_root: z.string().nullish().catch(null),
  }).nullish().catch(null),
});

/** Surowy `workspace.list` → workspace'y, które da się wskazać; wpis w obcym kształcie odpada. */
export function parseWorkspaceList(result: unknown): HerdrWorkspaceInfo[] {
  const parsed = workspaceListResultSchema.safeParse(result);
  if (!parsed.success) throw new HerdrError(say('herdr.response-no-workspaces'));
  const out: HerdrWorkspaceInfo[] = [];
  for (const raw of parsed.data.workspaces) {
    const entry = workspaceInfoSchema.safeParse(raw);
    if (!entry.success) continue;
    const { workspace_id: workspaceId, label, worktree } = entry.data;
    const checkoutPath = worktree?.checkout_path;
    const repoRoot = worktree?.repo_root;
    out.push({
      workspaceId, label,
      ...(typeof checkoutPath === 'string' && checkoutPath !== '' ? { checkoutPath } : {}),
      ...(typeof repoRoot === 'string' && repoRoot !== '' ? { repoRoot } : {}),
    });
  }
  return out;
}

/**
 * Wynik `pane.read` (`{ read: PaneReadResult }`, protokół 20 — sprawdzone w
 * `herdr api schema --json`). Wymagamy dokładnie dwóch pól, których Rarog używa; reszta
 * (`revision`, `pane_id`, `workspace_id`, `format`…) przychodzi i jest ignorowana przez
 * `looseObject` — herdr dokłada pola addytywnie i nie ma po co od tego padać.
 */
const paneReadResultSchema = z.looseObject({
  read: z.looseObject({ text: z.string(), truncated: z.boolean() }),
});

/**
 * Wynik `pane.process_info` (`{ process_info: PaneProcessInfo }`, protokół 20 — sprawdzone
 * w `herdr api schema --json`).
 *
 * Wymagane jest wyłącznie `pid` i `name` (tak samo jak w schemacie herdr); `argv0` bywa `null`,
 * a `foreground_processes` może nie przyjść w ogóle (panel bez procesu na pierwszym planie).
 * `argv`, `cmdline` i `cwd` przychodzą i są IGNOROWANE — patrz {@link HerdrPaneProcess}.
 */
/**
 * Wpis panelu z `pane.list` z polem `scroll` (`PaneInfo.scroll`: `viewport_rows`, `offset_from_bottom`,
 * `max_offset_from_bottom` — `herdr api schema --json`, herdr 0.9.5, protokół 22; pole obecne na żywym
 * `pane.list`). Bierzemy z niego WYŁĄCZNIE `viewport_rows` panelu, o który pytamy.
 */
const paneRowsEntrySchema = z.looseObject({
  pane_id: z.string(),
  scroll: z.looseObject({ viewport_rows: z.number().int().nonnegative() }),
});

/**
 * Surowy `pane.list` → liczba wierszy terminala panelu `paneId` (`scroll.viewport_rows`). Brak panelu,
 * brak pola `scroll` (herdr oddaje `null`) albo obcy kształt = błąd, nigdy liczba zgadnięta z ekranu.
 */
export function parsePaneRows(result: unknown, paneId: string): number {
  const parsed = paneListResultSchema.safeParse(result);
  if (!parsed.success) throw new HerdrError(say('herdr.response-no-panes'));
  for (const raw of parsed.data.panes) {
    const entry = paneRowsEntrySchema.safeParse(raw);
    if (entry.success && entry.data.pane_id === paneId) return entry.data.scroll.viewport_rows;
  }
  throw new HerdrError(say('herdr.response-no-pane-rows', { pane: paneId }));
}

/**
 * Wynik `pane.layout` (`{ type: 'pane_layout', layout: PaneLayoutSnapshot }` — `herdr api schema
 * --json` i żywy herdr 0.9.5). Z odpowiedzi bierzemy WYŁĄCZNIE id paneli
 * i wymiary ich prostokątów (`panes[].rect.width/height`); `area`, `splits`, położenia i fokus
 * przychodzą i są ignorowane.
 */
const paneLayoutResultSchema = z.looseObject({
  layout: z.looseObject({ panes: z.array(z.unknown()) }),
});
const paneLayoutEntrySchema = z.looseObject({
  pane_id: z.string().min(1),
  rect: z.looseObject({
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
  }),
});

/**
 * Surowy `pane.layout` → panele taba z wymiarami. Wpis w obcym kształcie rzuca dla CAŁEJ odpowiedzi,
 * a nie odpada: wołający liczy panele taba (split = bez przywrócenia rozmiaru), więc zgubiony wpis
 * zrobiłby z taba z podziałem tab jednopanelowy.
 */
export function parsePaneLayout(result: unknown): HerdrPaneLayout {
  const parsed = paneLayoutResultSchema.safeParse(result);
  if (!parsed.success) throw new HerdrError(say('herdr.response-bad-shape', { method: 'pane.layout' }));
  const panes: { paneId: string; width: number; height: number }[] = [];
  for (const raw of parsed.data.layout.panes) {
    const entry = paneLayoutEntrySchema.safeParse(raw);
    if (!entry.success) throw new HerdrError(say('herdr.response-bad-shape', { method: 'pane.layout' }));
    panes.push({
      paneId: entry.data.pane_id, width: entry.data.rect.width, height: entry.data.rect.height,
    });
  }
  return { panes };
}

const paneProcessInfoResultSchema = z.looseObject({
  process_info: z.looseObject({
    foreground_processes: z.array(z.looseObject({
      pid: z.number(),
      name: z.string(),
      argv0: z.string().nullish(),
    })).nullish(),
  }),
});

/**
 * Wynik `workspace.create` / `tab.create`.
 *
 * Kształt jest zagnieżdżony (`tab.tab_id`, `root_pane.pane_id`) i celowo czytany przez
 * `looseObject`: herdr dokłada pola addytywnie, a Rarog potrzebuje z tej odpowiedzi dokładnie
 * dwóch identyfikatorów — czego zamknąć i do czego wysłać `agent.start`.
 */
const createdTabSchema = z.looseObject({
  tab: z.looseObject({ tab_id: z.string() }).nullish(),
  tab_id: z.string().nullish(),
  root_pane: z.looseObject({ pane_id: z.string() }).nullish(),
  pane: z.looseObject({ pane_id: z.string() }).nullish(),
  pane_id: z.string().nullish(),
  workspace: z.looseObject({ workspace_id: z.string() }).nullish(),
  workspace_id: z.string().nullish(),
});

const startAgentResultSchema = z.looseObject({
  agent_started: z.looseObject({ argv: z.array(z.string()).nullish() }).nullish(),
  argv: z.array(z.string()).nullish(),
});

function toStatus(raw: string): HerdrAgentStatus {
  return KNOWN_STATUSES.has(raw) ? (raw as HerdrAgentStatus) : 'unknown';
}

/** Klatka spinnera Codexa: znak brajlowski (U+2800–U+28FF) z odstępem za nim. */
const CODEX_SPINNER_RE = /^[⠀-⣿]+\s*/u;

/**
 * Tytuł Codexa → tytuł dla karty. JEDNO miejsce, w którym znika spinner i katalog.
 *
 * Zmierzone na żywym herdr 0.9.0: `terminal_title_stripped` Codexa ma kształt
 * `<pierwszy prompt> | <katalog>`, w trakcie pracy z wiodącą klatką spinnera braille (`⠴ …`),
 * a przed pierwszym promptem jest SAMĄ nazwą katalogu.
 *
 * Normalizacja musi być tutaj, a nie w warstwie widoku, z dwóch powodów: nadzorca porównuje
 * tytuły między migawkami, więc kolejne klatki spinnera zgłaszałyby `titleChanged` kilka razy
 * na sekundę, a manager ma dostać w zdarzeniu tekst, który da się pokazać bez dalszej obróbki.
 * Sufiks katalogu zdejmujemy, bo nazwę projektu wiersz w kliencie i tak bierze z `cwd` — zostawiony
 * dublowałby ją w każdym wierszu.
 */
export function normalizeCodexTitle(raw: string, cwd: string): string {
  const dir = basename(cwd);
  let title = raw.replace(CODEX_SPINNER_RE, '').trim();
  if (dir !== '' && title.endsWith(` | ${dir}`)) {
    title = title.slice(0, title.length - dir.length - 3).trim();
  }
  // Tytuł równy samej nazwie katalogu = panel PRZED pierwszym promptem. Pusty string znaczy
  // „nie ma tytułu", a manager zamienia go na nazwę katalogu tą samą regułą co dla Claude.
  return title === dir ? '' : title;
}

/** Co filtr wejściowy ma wpuścić poza Claude. Domyślnie NIC — flaga jest jawnym opt-inem. */
export interface HerdrClientOptions {
  /**
   * `RAROG_CODEX_STATUS` — czy panele `agent === 'codex'` wchodzą do Raroga jako wpisy
   * samego STANU. Brak wartości = `false`: Codex nie istnieje.
   */
  codexStatus?: boolean;
}

/**
 * Surowy wpis herdr → `HerdrAgentInfo`, albo `null`, gdy agent nie jest dla Raroga.
 *
 * Eksportowane, bo tego samego przejścia potrzebują testy supervisora karmione fixture'em
 * `agent-list.json` — inaczej musiałyby zduplikować filtr i sprawdzałyby własną kopię reguł.
 */
export function normalizeAgentInfo(
  raw: unknown, opts: HerdrClientOptions = {},
): HerdrAgentInfo | null {
  const parsed = agentInfoSchema.safeParse(raw);
  if (!parsed.success) return null;
  const info = parsed.data;

  /*
   * Bramka silnika. `codex` wchodzi WYŁĄCZNIE przy jawnej fladze; każdy inny agent
   * (`future-agent`, `aider`, …) odpada tak jak dotąd — Rarog nie zna ani jego stopki, ani
   * jego pliku treści, więc wiersz w sidebarze byłby obietnicą bez pokrycia.
   */
  const engine: HerdrEngine | null = info.agent === 'claude' ? 'claude'
    : (info.agent === 'codex' && opts.codexStatus === true ? 'codex' : null);
  if (engine === null) return null;
  const session = info.agent_session;
  if (session === null || session === undefined) return null;
  if (session.kind !== 'id') return null;
  const value = session.value;
  if (typeof value !== 'string' || !ENGINE_SESSION_ID_PATTERN.test(value)) return null;
  const cwd = info.cwd;
  if (typeof cwd !== 'string' || cwd === '') return null;

  /*
   * Token `rarog-term` — „ten agent chodzi w terminalu Raroga", czyli adres ekranu
   * terminala w kliencie. Sprawdzamy go `TERM_ID_RE`, bo tokeny panelu może wpisać KTOKOLWIEK
   * przez `pane.report_metadata`: bez tej bramki cudza wartość wchodziłaby do adresu w kliencie.
   * Pole powstaje dla OBU silników: Claude uruchomiony ręcznie
   * w terminalu Raroga ma wiersz na liście, a jego ekranem jest ten terminal, nie transkrypt.
   */
  const termToken = termPaneTokenOf(info.tokens);
  const termId = typeof termToken === 'string' && TERM_ID_RE.test(termToken) ? termToken : null;

  return {
    paneId: info.pane_id,
    // Brak `tab_id` = pusty string, czyli „nie ma czego zamknąć". Fail-closed dla WŁADZY:
    // `closeTab` z pustym adresem odpada w supervisorze, zanim dotknie gniazda.
    tabId: info.tab_id ?? '',
    agentSessionId: value,
    engine,
    termId,
    cwd,
    status: toStatus(info.agent_status),
    /*
     * Własność: agent `claude` o nazwie `rarog-<6 hex>`, nadanej przez launcher Raroga.
     * Codex nie bywa „Raroga" nigdy (Rarog go nie uruchamia), nawet z taką nazwą. Brak
     * nazwy to normalny stan agenta Raroga po wygasłym rekordzie startu — drugie źródło
     * (klucze założone przez ten proces) dokłada nadzorca.
     */
    launchedByRarog: engine === 'claude'
      && typeof info.name === 'string' && RAROG_AGENT_NAME_RE.test(info.name),
    // Brak `interactive_ready` = `true`: panel widziany w `agent.list` już działa (patrz
    // komentarz w kontrakcie). Zachowawcze `false` odcięłoby wysyłkę do wszystkich paneli
    // założonych ręcznie w terminalu — czyli do całej dotychczasowej wartości Raroga.
    // Wpis Codexa jest tu WYJĄTKIEM i to jego jedyne miejsce: nic do niego nie wysyłamy,
    // a odpowiedź herdr tego pola dla Codexa w ogóle nie niesie (zmierzone).
    interactiveReady: engine === 'codex' ? false : (info.interactive_ready ?? true),
    title: engine === 'codex'
      ? normalizeCodexTitle(info.terminal_title_stripped ?? '', cwd)
      : (info.terminal_title_stripped ?? ''),
    stateChangeSeq: info.state_change_seq ?? 0,
  };
}

/**
 * Surowy wpis `pane.list` → `HerdrPaneInfo`, albo `null`, gdy panel nie ma adresu i katalogu
 * albo herdr go nie odtworzył.
 */
export function normalizePaneInfo(raw: unknown): HerdrPaneInfo | null {
  const parsed = paneInfoSchema.safeParse(raw);
  if (!parsed.success) return null;
  const pane = parsed.data;
  const cwd = pane.cwd;
  const tabId = pane.tab_id;
  const workspaceId = pane.workspace_id;
  // Panel bez `cwd`, `tab_id` albo `workspace_id` jest dla launchera bezużyteczny: nie da się
  // po nim ani dopasować katalogu, ani utworzyć w nim taba.
  if (typeof cwd !== 'string' || cwd === '') return null;
  if (typeof tabId !== 'string' || typeof workspaceId !== 'string') return null;
  /*
   * Panel z `restore_error` to sam wpis bez procesu: herdr trzyma go na liście (z etykietą
   * i katalogiem, którego już nie ma), ale `pane.read` i `pane.process_info` oddają na nim
   * `pane_not_found` (zmierzone na herdr 0.9.4). Dla terminala, launchera i nadzorcy
   * to brak panelu: bez filtra terminal Raroga adoptowałby go po etykiecie i pytał o proces przy
   * każdym odczycie listy. Inwentarz OBECNOŚCI (`parsePaneIds`) liczy go dalej, bo panel istnieje.
   */
  if (typeof pane.restore_error === 'string' && pane.restore_error !== '') return null;
  return {
    paneId: pane.pane_id, tabId, workspaceId, cwd, tokens: pane.tokens ?? {},
    label: pane.label ?? null,
  };
}

/** Znaki sterujące U+0000–U+001F, DEL i U+0080–U+009F — ten sam zakres, który czyści `sanitizePaneTitle`. */
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/u;

/**
 * Bramka etykiety panelu/taba na granicy gniazda.
 *
 * herdr NIE normalizuje etykiet (zmierzone: ESC, `\n`, pusty napis i same spacje
 * przyjęte i zapisane do snapshotu), a etykieta ląduje w sidebarze i na ramce panelu na Macu.
 * Wołający czyści tekst sam (`sanitizePaneTitle`); to jest ostatnia linia, która nie pozwala,
 * żeby pomyłka wołającego zapisała do snapshotu użytkownika sekwencję terminala.
 */
function assertCleanLabel(label: string, method: 'pane.rename' | 'tab.rename'): void {
  if (label.trim() === '') throw new HerdrError(say('herdr.label-empty', { method }));
  if (CONTROL_CHARS_RE.test(label)) throw new HerdrError(say('herdr.label-control-char', { method }));
}

/**
 * Same `pane_id` z `pane.list` — luźny inwentarz obecności (patrz kontrakt `listPaneIds`).
 * Wiersz liczy się do inwentarza, gdy ma JAKIKOLWIEK `pane_id` będący niepustym stringiem —
 * reszta pól go nie dyskwalifikuje, bo pytanie brzmi „czy panel istnieje", nie „czy się nadaje".
 */
export function parsePaneIds(result: unknown): ReadonlySet<string> {
  const parsed = paneListResultSchema.safeParse(result);
  if (!parsed.success) throw new HerdrError(say('herdr.response-no-panes'));
  const ids = new Set<string>();
  for (const raw of parsed.data.panes) {
    if (typeof raw !== 'object' || raw === null) continue;
    const paneId = (raw as Record<string, unknown>)['pane_id'];
    if (typeof paneId === 'string' && paneId !== '') ids.add(paneId);
  }
  return ids;
}

/** `result` metody `pane.list` → panele po filtrze. */
export function parsePaneList(result: unknown): HerdrPaneInfo[] {
  const parsed = paneListResultSchema.safeParse(result);
  if (!parsed.success) throw new HerdrError(say('herdr.response-no-panes'));
  const out: HerdrPaneInfo[] = [];
  for (const raw of parsed.data.panes) {
    const pane = normalizePaneInfo(raw);
    if (pane !== null) out.push(pane);
  }
  return out;
}

/** `result` metody `agent.list` → lista agentów po filtrze. */
export function parseAgentList(
  result: unknown, opts: HerdrClientOptions = {},
): HerdrAgentInfo[] {
  const parsed = agentListResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new HerdrError(say('herdr.response-no-agents'));
  }
  const out: HerdrAgentInfo[] = [];
  for (const raw of parsed.data.agents) {
    const info = normalizeAgentInfo(raw, opts);
    if (info !== null) out.push(info);
  }
  return out;
}

/**
 * Kod błędu herdr → klasa błędu Raroga.
 *
 * Rozróżnienie ma znaczenie dla zachowania drivera, nie dla estetyki: `agent_blocked` daje
 * ostrzeżenie pod wiadomością (nic nie poszło), `agent_prompt_stalled` jest IGNOROWANY
 * (fałszywy alarm slash-komendy), a trzy kody „nie ma panelu" znaczą koniec sesji.
 */
function mapRemoteError(err: HerdrRemoteError): HerdrError {
  switch (err.remoteCode) {
    case 'agent_blocked':
      return new HerdrBlockedError(err.sentence);
    case 'agent_prompt_stalled':
      return new HerdrStalledError(err.sentence);
    case 'agent_not_running':
    case 'pane_not_found':
    case 'agent_not_ready':
    // `--resume <nieistniejący uuid>` kończy `claude` w ~1–2 s i panel wraca do powłoki;
    // herdr zgłasza wtedy `agent_not_found`. Bez tej gałęzi launcher czekałby pełne 20 s
    // na gotowość agenta, którego już nie ma, zamiast pokazać powód z ekranu.
    case 'agent_not_found':
      return new HerdrGoneError(err.sentence);
    case 'feature_disabled':
      return new HerdrReadOnlyError(err.sentence);
    default:
      /*
       * Timeout `wait` PO TREŚCI, nie po kodzie: herdr 0.8.2 zwraca timeout czekania na status z innym kodem niż
       * `agent_prompt_stalled`, nieudokumentowanym — bez tej gałęzi stall-guard nie widziałby stalla, a użytkownik
       * dostałby surowy błąd zamiast ponowienia i uczciwego zdania.
       *
       * Skill wbudowany w binarkę 0.9.0 nazywa ten kod `timeout`, ale na 0.9.0 jest to
       * NIEZMIERZONE, a jedyny pomiar Raroga (0.8.2, wyżej) widział inny kod — więc żadna nazwa
       * nie wchodzi tu jako fakt i dopasowanie zostaje po treści. Dopiero pomiar kodu przy
       * `timeout_ms: 3000` może uzasadnić przejście na `switch` po kodzie.
       */
      if (/timed out waiting for agent/i.test(err.message)) {
        // Znacznik `'message'` jest treścią, nie metadaną: wołający, który połyka stalla jako
        // sukces (Esc w driverze), nie ma prawa zrobić tego dla NIEZNANEGO kodu rozpoznanego
        // po brzmieniu komunikatu — patrz `HerdrStallSource`.
        return new HerdrStalledError(err.sentence, 'message');
      }
      /*
       * Kod zdalny PRZEŻYWA opakowanie. Wołający rozpoznają po nim sytuacje, które nie mają
       * własnej klasy błędu (`agent_name_taken` → retry z nową nazwą w launcherze); gdyby
       * został tu sam tekst, detekcja zależałaby od brzmienia komunikatu herdr, czyli od
       * rzeczy, która zmienia się bez uprzedzenia razem z wersją serwera.
       */
      return new HerdrRemoteError(err.remoteCode, foreign(`herdr: ${err.message}`));
  }
}

/**
 * Wywołanie transportu z mapowaniem kodów zdalnych na klasy błędów Raroga.
 *
 * Jedna definicja dla OBU fasad: dwie kopie tego samego `try/catch` znaczyłyby dwa miejsca,
 * w których mapowanie może się rozjechać.
 */
function mappedCaller(requester: HerdrRequester) {
  return async (
    method: string, params: Record<string, unknown>, opts?: HerdrRequestOptions,
  ): Promise<unknown> => {
    try {
      return await requester.request(method, params, opts);
    } catch (err) {
      if (err instanceof HerdrRemoteError) throw mapRemoteError(err);
      throw err;
    }
  };
}

/**
 * `pane.read` ze źródłem `recent_unwrapped` — historia JEDNEGO panelu jako tekst bez ANSI.
 * Wspólne dla obu fasad: terminal (`HerdrLaunchClient`) i driver (`HerdrClient`). Driver tej
 * metody nie woła — jedynym żywym czytelnikiem jest terminal.
 */
async function readPaneHistory(
  call: ReturnType<typeof mappedCaller>, paneId: string, lines: number,
): Promise<HerdrPaneHistory> {
  // Pusty adres nie ma prawa dotknąć gniazda — ta sama zasada co w `closePane`.
  if (paneId === '') throw new HerdrError(say('herdr.pane-id-missing', { method: 'pane.read' }));
  /*
   * Wartość `source` jest wersją PROTOKOŁU (`ReadSource` w schemacie: `recent_unwrapped`
   * z podkreślnikiem), a nie tą z CLI (`--source recent-unwrapped`, z dywizem). Pomyłka
   * kosztuje `invalid_request` na gnieździe, więc zapisana jest tu raz i tylko tu.
   *
   * `strip_ansi` i `format: 'text'` jawnie, mimo że są domyślne: historia idzie prosto
   * do widoku tekstu w kliencie, a sekwencje ESC w węźle tekstowym byłyby śmieciem do zaznaczenia.
   */
  const result = await call('pane.read', {
    pane_id: paneId,
    source: 'recent_unwrapped',
    lines,
    strip_ansi: true,
    format: 'text',
  });
  const parsed = paneReadResultSchema.safeParse(result);
  if (!parsed.success) throw new HerdrError(say('herdr.response-bad-shape', { method: 'pane.read' }));
  return { text: parsed.data.read.text, truncated: parsed.data.read.truncated };
}

/**
 * Typowana fasada nad transportem.
 *
 * `opts` niesie dziś jedną rzecz — flagę `RAROG_CODEX_STATUS`. Jest polem FASADY,
 * a nie argumentem każdego wywołania, bo obie drogi wpisu (`agent.list` przy resyncu
 * i `agent.get` przy pushu) muszą filtrować IDENTYCZNIE: jedna bramka, jedno źródło prawdy.
 */
export function createHerdrClient(
  requester: HerdrRequester, opts: HerdrClientOptions = {},
): HerdrClient {
  const call = mappedCaller(requester);

  return {
    readPaneHistory: (paneId, lines) => readPaneHistory(call, paneId, lines),
    async readPaneRows(paneId: string): Promise<number> {
      // Pusty adres nie ma prawa dotknąć gniazda — ta sama zasada co w `readPaneHistory`.
      if (paneId === '') throw new HerdrError(say('herdr.pane-id-missing', { method: 'pane.list' }));
      // `pane.list`, nie `pane.get`: ta sama odpowiedź (`PaneInfo.scroll`) z metody, która JUŻ jest na
      // allow-liście — odczyt wierszy do dziennika nie poszerza listy metod gniazda. Zwykły sufit
      // transportu: budżet czekania trzyma driver (`HERDR_PANE_ROWS_WAIT_MS`), a krótszy sufit gniazda
      // oznaczałby herdr jako niedostępny z powodu samej diagnostyki.
      const result = await call('pane.list', {});
      return parsePaneRows(result, paneId);
    },
    async listAgents(): Promise<HerdrAgentInfo[]> {
      return parseAgentList(await call('agent.list', {}), opts);
    },

    async getAgent(paneId: string): Promise<HerdrAgentInfo> {
      const result = await call('agent.get', { target: paneId });
      const parsed = agentInfoResultSchema.safeParse(result);
      const info = parsed.success ? normalizeAgentInfo(parsed.data.agent, opts) : null;
      if (info === null) {
        // Panel istnieje, ale nie jest już agentem obsługiwanym przez Raroga (Claude, a przy
        // `RAROG_CODEX_STATUS` także Codex) z sesją po id — dla Raroga to dokładnie to samo,
        // co zniknięcie panelu.
        throw new HerdrGoneError(say('herdr.agent-gone', { key: paneId }));
      }
      return info;
    },

    async readScreen(
      paneId: string, source: 'detection' | 'visible', format: 'text' | 'ansi' = 'text',
    ): Promise<HerdrScreen> {
      // `lines` NIE jest wysyłane w ogóle: serwer bez niego oddaje widoczny ekran w 0,2 ms,
      // a podanie stałej wpada w kosztowną ścieżkę (380 ms) i tak nie daje historii.
      // `strip_ansi` domyślnie `true` po stronie herdr — przy `ansi` trzeba je zgasić jawnie,
      // inaczej `format` nie ma czego zostawić (schemat `AgentReadParams`, protokół 20).
      const result = await call('agent.read', format === 'ansi'
        ? { target: paneId, source, format, strip_ansi: false }
        : { target: paneId, source });
      const parsed = readResultSchema.safeParse(result);
      if (!parsed.success) throw new HerdrError(say('herdr.response-bad-shape', { method: 'agent.read' }));
      return { text: parsed.data.read.text };
    },

    async prompt(paneId: string, text: string, wait?: boolean): Promise<void> {
      /*
       * `wait` tylko na jawne życzenie drivera (zwykłe prompty): herdr czeka wtedy na wejście
       * panelu w `working`, a brak przejścia jest jedynym sygnałem „Enter nie zarejestrował się
       * w TUI". Slash-komendy idą bez `wait`: komenda typu `local` nie startuje tury (pomiar żywy
       * `commands/measured/live-2.1.310.json`, zamknięta lista), więc z `wait` dałaby fałszywy stall,
       * mimo że wykonuje się poprawnie. Komenda typu `prompt` turę startuje (ten sam pomiar), a jedzie
       * bez `wait` tak samo — decyzja Raroga; czy `wait` dałby przy niej stall, niezmierzone.
       * `timeout_ms` < `REQUEST_TIMEOUT_MS` gniazda — patrz `config.ts`.
       *
       * CZYM wraca ten brak przejścia, zależy od `timeout_ms` i NIE jest to `agent_prompt_stalled`
       * przy dzisiejszej stałej: własny próg stalla herdr to 5 s (skill wbudowany w binarkę 0.9.0),
       * a Rarog woła z `HERDR_PROMPT_WAIT_MS` = 3000, więc pierwszy mija timeout WOŁAJĄCEGO
       * i dostajemy błąd rozpoznawany po TREŚCI („timed out waiting for agent status" —
       * `mapRemoteError`, gałąź `default`). Kod `agent_prompt_stalled` jest osiągalny dopiero przy
       * `timeout_ms ≥ 5000`; czy warto tam iść, rozstrzyga pomiar stalli na 0.9.0.
       */
      if (wait === true) {
        await call('agent.prompt', {
          target: paneId,
          text,
          wait: { timeout_ms: HERDR_PROMPT_WAIT_MS, until: ['working'] },
        });
        return;
      }
      await call('agent.prompt', { target: paneId, text });
    },

    async sendKeys(paneId: string, keys: readonly string[]): Promise<void> {
      // Allow-lista PRZED żądaniem: zła tablica nie ma prawa dotknąć gniazda.
      assertAllowedKeys(keys);
      await call('agent.send_keys', { target: paneId, keys: [...keys] });
    },

    async sendFormSubmit(paneId: string): Promise<void> {
      // Osobna asercja i osobna metoda: `enter` nie istnieje poza tą ścieżką.
      const keys = [FORM_SUBMIT_KEY];
      assertFormSubmitKeys(keys);
      await call('agent.send_keys', { target: paneId, keys });
    },

    async sendTrustStep(paneId: string, key: TrustStepKey): Promise<void> {
      // Osobna asercja i osobna metoda: `down` i `enter` dialogu zaufania nie istnieją poza tą ścieżką.
      const keys = [key];
      assertTrustStepKeys(keys);
      await call('agent.send_keys', { target: paneId, keys });
    },

    async sendDialogKey(paneId: string, key: KeyRowKey): Promise<void> {
      // Its own assertion and method: the key row of a layer 2 card exists only on this path.
      const keys = [key];
      assertDialogKey(keys);
      await call('agent.send_keys', { target: paneId, keys });
    },

    async sendTakeBackKey(paneId: string, key: TakeBackKey): Promise<void> {
      // Its own assertion and method: the take-back keys exist only on this path.
      const keys = [key];
      assertTakeBackKey(keys);
      await call('agent.send_keys', { target: paneId, keys });
    },

    async pasteText(paneId: string, text: string): Promise<void> {
      /*
       * Samo wklejenie: `pane.send_input` z `text` i BEZ `keys` — herdr wkleja tekst
       * w trybie bracketed paste i niczego nie naciska (pomiar 0a). Ciało składa się wyłącznie tutaj, z dwóch pól:
       * pole `keys` w tej metodzie nie istnieje, więc klawisz nie dojdzie do panelu tą drogą. Pusty adres albo
       * pusty tekst nie dotykają gniazda.
       */
      if (paneId === '') throw new HerdrError(say('herdr.pane-id-missing', { method: 'pane.send_input' }));
      if (text === '') throw new HerdrError(say('commands.empty'));
      await call('pane.send_input', { pane_id: paneId, text });
    },

    async sendPromptSubmit(paneId: string): Promise<void> {
      // Osobna asercja i osobna metoda: `enter` wysyłki promptu nie istnieje poza tą ścieżką.
      const keys = [PROMPT_SUBMIT_KEY];
      assertPromptSubmitKeys(keys);
      await call('agent.send_keys', { target: paneId, keys });
    },

    async sendModeCycle(paneId: string): Promise<void> {
      // Osobna asercja i osobna metoda: `shift+tab` nie istnieje poza tą ścieżką.
      const keys = [MODE_CYCLE_KEY];
      assertModeCycleKeys(keys);
      await call('agent.send_keys', { target: paneId, keys });
    },

    async focus(paneId: string): Promise<void> {
      await call('agent.focus', { target: paneId });
    },

    async ping(): Promise<{ version: string; protocol: number }> {
      const parsed = pongSchema.safeParse(await call('ping', {}));
      if (!parsed.success) throw new HerdrError(say('herdr.response-bad-shape', { method: 'ping' }));
      return { version: parsed.data.version, protocol: parsed.data.protocol };
    },
  };
}

// ---------------------------------------------------------------------------
// Kanał TWORZENIA — osobna fasada, świadomie
// ---------------------------------------------------------------------------

/**
 * Fasada metod, które coś TWORZĄ, NAZYWAJĄ albo ZAMYKAJĄ po stronie herdr.
 *
 * Osobna funkcja, a nie pola `createHerdrClient`: moduły, które mają wyłącznie oglądać panele
 * (driver, supervisor w trybie odczytu), nie dostają nawet REFERENCJI do metod tworzących.
 * Bramką pozostaje `socket.ts` — każdy zapis tej fasady (`workspace.create`, `tab.create`,
 * `agent.start`, `pane.report_metadata`, `pane.rename`, `tab.rename`, `tab.close`,
 * `pane.close`) jest w `MUTATING_METHODS`, więc `RAROG_HERDR_SEND=0` i nieznany protokół
 * blokują je razem z `agent.prompt`.
 */
export function createHerdrLaunchClient(requester: HerdrRequester): HerdrLaunchClient {
  const call = mappedCaller(requester);

  /** Wspólny odczyt `tab.create` / `workspace.create` — oba oddają tab i jego panel główny. */
  const readCreated = (result: unknown, method: string): {
    tabId: string; paneId: string; workspaceId: string;
  } => {
    const parsed = createdTabSchema.safeParse(result);
    if (!parsed.success) throw new HerdrError(say('herdr.response-bad-shape', { method }));
    const body = parsed.data;
    const tabId = body.tab?.tab_id ?? body.tab_id;
    const paneId = body.root_pane?.pane_id ?? body.pane?.pane_id ?? body.pane_id;
    const workspaceId = body.workspace?.workspace_id ?? body.workspace_id ?? '';
    if (typeof tabId !== 'string' || typeof paneId !== 'string') {
      throw new HerdrError(say('herdr.response-no-ids', { method }));
    }
    return { tabId, paneId, workspaceId };
  };

  return {
    async listPanes(): Promise<HerdrPaneInfo[]> {
      return parsePaneList(await call('pane.list', {}));
    },

    async listPaneIds(): Promise<ReadonlySet<string>> {
      return parsePaneIds(await call('pane.list', {}));
    },

    async listWorkspaces(): Promise<HerdrWorkspaceInfo[]> {
      return parseWorkspaceList(await call('workspace.list', {}));
    },

    async getTab(tabId: string): Promise<HerdrTabInfo> {
      // Pusty adres nie ma prawa dotknąć gniazda — ta sama zasada co w `closeTab`/`renameTab`.
      if (tabId === '') throw new HerdrError(say('herdr.tab-id-missing', { method: 'tab.get' }));
      const parsed = tabGetResultSchema.safeParse(await call('tab.get', { tab_id: tabId }));
      if (!parsed.success) throw new HerdrError(say('herdr.response-bad-shape', { method: 'tab.get' }));
      const tab = parsed.data.tab;
      return {
        tabId: tab.tab_id, label: tab.label, paneCount: tab.pane_count, workspaceId: tab.workspace_id,
      };
    },

    async readPaneLayout(paneId: string): Promise<HerdrPaneLayout> {
      // Pusty adres nie ma prawa dotknąć gniazda — ta sama zasada co w `getTab`/`readPaneProcess`.
      if (paneId === '') throw new HerdrError(say('herdr.pane-id-missing', { method: 'pane.layout' }));
      return parsePaneLayout(await call('pane.layout', { pane_id: paneId }));
    },

    readPaneHistory: (paneId, lines) => readPaneHistory(call, paneId, lines),

    async readPaneProcess(paneId: string): Promise<HerdrPaneProcessInfo> {
      // Pusty adres nie ma prawa dotknąć gniazda — ta sama zasada co w `readPaneHistory`.
      if (paneId === '') throw new HerdrError(say('herdr.pane-id-missing', { method: 'pane.process_info' }));
      const result = await call('pane.process_info', { pane_id: paneId });
      const parsed = paneProcessInfoResultSchema.safeParse(result);
      if (!parsed.success) {
        throw new HerdrError(say('herdr.response-bad-shape', { method: 'pane.process_info' }));
      }
      // ZAWĘŻENIE do trzech pól robimy TU, na granicy gniazda: `argv`/`cmdline`/`cwd` bywają
      // linią polecenia z sekretem w argumencie i nie mają po co wchodzić do serwera.
      const processes = (parsed.data.process_info.foreground_processes ?? []).map((proc) => ({
        pid: proc.pid, name: proc.name, argv0: proc.argv0 ?? '',
      }));
      return { processes };
    },

    async createWorkspace(params): Promise<HerdrCreateWorkspaceResult> {
      // `focus` jawnie zawsze: default to `false` (launch sesji nie wyrywa terminala spod
      // rąk), a `true` wysyła wyłącznie tab terminalowy — jego otwiera się po to,
      // żeby zaraz przy nim usiąść.
      const body: Record<string, unknown> = { cwd: params.cwd, focus: params.focus === true };
      if (params.label !== undefined) body['label'] = params.label;
      // `env` jest podawane ZAWSZE, gdy wołający je ma: bez wyzerowania odziedziczonego
      // `CLAUDE_CODE_CHILD_SESSION` panel startuje z wyłączonym zapisem transkryptu (docs
      // `errors.md`, „Transcript saving is off…”) i cała warstwa treści Raroga znika po cichu.
      if (params.env !== undefined) body['env'] = { ...params.env };
      const created = readCreated(await call('workspace.create', body), 'workspace.create');
      return {
        workspaceId: created.workspaceId, tabId: created.tabId, paneId: created.paneId,
      };
    },

    async createTab(params): Promise<HerdrCreateTabResult> {
      // `focus` jak w `createWorkspace`: default `false`, `true` tylko dla taba terminalowego.
      const body: Record<string, unknown> = {
        workspace_id: params.workspaceId, cwd: params.cwd, focus: params.focus === true,
      };
      if (params.label !== undefined) body['label'] = params.label;
      if (params.env !== undefined) body['env'] = { ...params.env };
      const created = readCreated(await call('tab.create', body), 'tab.create');
      return { tabId: created.tabId, paneId: created.paneId };
    },

    async startAgent(params): Promise<HerdrStartAgentResult> {
      const body: Record<string, unknown> = {
        name: params.name, kind: params.kind, pane_id: params.paneId, args: [...params.args],
      };
      /*
       * `timeout_ms` idzie ZAWSZE — i to jest naprawa najgroźniejszego rozjazdu tej ścieżki.
       *
       * Parametr istniał w kontrakcie od początku, ale nikt go nie podawał, więc herdr nie
       * miał żadnego terminu, a jedynym zegarem był globalny sufit gniazda (5 s). Start
       * trwający dłużej wracał do launchera jako timeout TRANSPORTU — czyli „nie wiem, co się
       * stało" — a launcher zamykał wtedy tab z agentem, który właśnie wstał. Teraz herdr ma
       * własne okno ({@link HERDR_START_WAIT_MS}) i musi się w nim wypowiedzieć DEFINITYWNIE,
       * a gniazdo czeka na niego dłużej ({@link HERDR_START_REQUEST_TIMEOUT_MS}).
       */
      body['timeout_ms'] = params.timeoutMs ?? HERDR_START_WAIT_MS;
      const result = await call('agent.start', body, {
        timeoutMs: HERDR_START_REQUEST_TIMEOUT_MS,
      });
      const parsed = startAgentResultSchema.safeParse(result);
      // `argv` jest do AUDYTU, nie do działania — brak pola nie jest powodem, żeby uznać
      // uruchomiony proces za nieuruchomiony.
      const argv = parsed.success
        ? (parsed.data.agent_started?.argv ?? parsed.data.argv ?? [])
        : [];
      return { argv: [...argv] };
    },

    async reportPaneMetadata(params): Promise<void> {
      const body: Record<string, unknown> = { pane_id: params.paneId, source: params.source };
      // `tokens` tylko gdy są: stempel samego tytułu (panel Claude) nie dotyka tokenów.
      if (params.tokens !== undefined) body['tokens'] = { ...params.tokens };
      if (params.title !== undefined) body['title'] = params.title;
      if (params.ttlMs !== undefined) body['ttl_ms'] = params.ttlMs;
      await call('pane.report_metadata', body);
    },

    async renamePane(paneId: string, label: string | null): Promise<void> {
      // Pusty adres nie ma prawa dotknąć gniazda — ta sama zasada co w `closeTab`/`closePane`.
      if (paneId === '') throw new HerdrError(say('herdr.pane-id-missing', { method: 'pane.rename' }));
      if (label !== null) assertCleanLabel(label, 'pane.rename');
      await call('pane.rename', { pane_id: paneId, label });
    },

    async renameTab(tabId: string, label: string): Promise<void> {
      if (tabId === '') throw new HerdrError(say('herdr.tab-id-missing', { method: 'tab.rename' }));
      assertCleanLabel(label, 'tab.rename');
      await call('tab.rename', { tab_id: tabId, label });
    },

    async closeTab(tabId: string): Promise<void> {
      // Pusty adres znaczy „nie wiem, co zamknąć" — i to jest jedyna sytuacja, w której
      // ta metoda rzuca ZANIM cokolwiek pójdzie do gniazda.
      if (tabId === '') throw new HerdrError(say('herdr.tab-id-missing', { method: 'tab.close' }));
      await call('tab.close', { tab_id: tabId });
    },

    async closePane(paneId: string): Promise<void> {
      // Ta sama zasada co w `closeTab`: pusty adres nie ma prawa dotknąć gniazda. Bramka
      // własności (token `rarog-term`) jest u wołającego — patrz kontrakt `closePane`.
      if (paneId === '') throw new HerdrError(say('herdr.pane-id-missing', { method: 'pane.close' }));
      await call('pane.close', { pane_id: paneId });
    },

    async probeAgent(paneId: string): Promise<HerdrLaunchProbeInfo> {
      const result = await call('agent.get', { target: paneId });
      const outer = agentInfoResultSchema.safeParse(result);
      // Ten sam luźny schemat co w `normalizeAgentInfo` — sonda musi widzieć wpis nawet
      // wtedy, gdy nie przechodzi on jeszcze filtru „agent claude z sesją po id".
      const parsed = outer.success ? agentInfoSchema.safeParse(outer.data.agent) : null;
      const info = parsed !== null && parsed.success ? parsed.data : null;
      /*
       * Brak agenta w odpowiedzi (a nie błąd zdalny) też znaczy „zniknął": `agent.get` na
       * panelu, który wrócił do powłoki, oddaje wynik bez wpisu. Rozróżnienie robi wołający —
       * `HerdrGoneError` jest dla niego jednym sygnałem „nie ma po czym czekać".
       */
      if (info === null) {
        throw new HerdrGoneError(say('herdr.agent-gone', { key: paneId }));
      }
      const session = info.agent_session;
      const value = session?.kind === 'id' ? session.value : null;
      return {
        // Pusty string ZNACZY „herdr jeszcze nie zna sesji" — to jest normalny stan przez
        // pierwsze ~2 s po `agent.start`, a nie powód do przerwania startu.
        agentSessionId: typeof value === 'string' && ENGINE_SESSION_ID_PATTERN.test(value)
          ? value
          : '',
        status: toStatus(info.agent_status),
        /*
         * Odwrotnie niż w `normalizeAgentInfo`: TU brak pola NIE znaczy „gotowy". Tam mówiliśmy
         * o panelu, który już działa; tu o takim, który dopiero wstaje — a `agent.prompt`
         * przed gotowością zwraca `agent_not_ready` i gubi tekst. Brak pola jedzie do launchera
         * jako `null`, bo od herdr 0.9.0 ma DWA znaczenia: „jeszcze nie"
         * (wtedy stoi `launch_pending: true`) albo „rekord startu wygasł i herdr wykrył agenta
         * sam" — takiemu panelowi pole nie pojawi się już nigdy, a rozstrzyga status.
         */
        interactiveReady: info.interactive_ready === true
          ? true
          : info.interactive_ready === false ? false : null,
        launchPending: info.launch_pending === true,
      };
    },
  };
}
