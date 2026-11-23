/**
 * Protocol contract, session side panel area: background tasks, workflow runs, artifacts, pull requests and scheduled
 * tasks.
 *
 * Re-exported unchanged by `shared/src/protocol.ts`; code imports the names from there.
 */
import { z } from 'zod';

/**
 * Rodzaje zadań, które agent potrafi puścić W TLE — lista ZAMKNIĘTA.
 *
 * Rozpoznajemy je po KSZTAŁCIE `toolUseResult` w transkrypcie i po nazwie sparowanego narzędzia,
 * w tej kolejności: `agentId` → subagent, `taskId` z niepustym `taskType` (jakimkolwiek) →
 * workflow, `backgroundTaskId` → komenda; wynik sparowany z wywołaniem `Monitor` to monitor bez
 * względu na pole. Nie po prefiksie identyfikatora, bo ten niczego nie gwarantuje — monitor ma
 * taki sam jak komenda (pomiar, `docs/background-tasks.md`, „Task lifecycle”).
 * Wynik narzędzia bez żadnego z tych trzech identyfikatorów nie jest startem: zadanie nie
 * powstaje i żaden rodzaj mu nie przypada.
 */
export type BackgroundTaskKind = 'command' | 'agent' | 'workflow' | 'monitor';

/**
 * Jedno ŻYWE zadanie w tle widziane w transkrypcie sesji.
 *
 * Powstaje przy wpisie startu, znika przy powiadomieniu ze statusem terminalnym. Nie jest to
 * lista procesów systemu: widać wyłącznie to, co agent puścił świadomie w tle (`Bash` z
 * `run_in_background`, subagent, workflow, monitor). Zwykły `Bash` mielący trzy minuty to nadal
 * cisza w pliku i mówi o niej wiersz aktywności, a nie ta lista.
 */
export interface BackgroundTask {
  /** `backgroundTaskId` / `agentId` / `taskId` z `toolUseResult` — klucz dedup i zamykania. */
  id: string;
  kind: BackgroundTaskKind;
  /**
   * Opis dla człowieka (`input.description`, `toolUseResult.description`, `workflowName`).
   * Nieobecny = plik go nie zdradził; UI pokazuje wtedy sam rodzaj i niczego nie zmyśla.
   */
  description?: string;
  /** Komenda `Bash` (przycięta). Nieobecna = rodzaj inny niż komenda albo start sprzed okna. */
  command?: string;
  /**
   * Podtyp subagenta z wywołania (`input.subagent_type`): `Explore`, `general-purpose`, `fork`…
   *
   * Wartość idzie ŻYWCEM z transkryptu i celowo nie jest tłumaczona — to nazwa własna z
   * konfiguracji agentów, a nie słowo do przekładu. Nieobecna znaczy „wywołanie jej nie podało"
   * (w zmierzonej próbce 37 z 52 startów), a NIE „to jest domyślny typ": domyślny podstawia
   * silnik i Rarog nie ma jak potwierdzić który.
   */
  agentType?: string;
  /**
   * Model, na którym subagent RZECZYWIŚCIE leci (`toolUseResult.resolvedModel`).
   *
   * To identyfikator ROZWIĄZANY przez silnik (`claude-opus-5[1m]`), a nie alias z wywołania
   * (`opus`) — i dlatego jest tu on, a nie `input.model`: alias bywa nieobecny (subagent
   * dziedziczy wtedy model rodzica) i nigdy nie zdradza wariantu okna. Schemat celowo NIE
   * używa `modelIdSchema`: `MODEL_ID_PATTERN` służy do WYSYŁANIA modelu i zna tylko kształty,
   * które Rarog sam wysyła, a to pole jest wyłącznie do pokazania.
   */
  model?: string;
  /**
   * Jedno zdanie z wyniku startu (`toolUseResult.summary`, przycięte do 120 znaków). Reduktor
   * kopiuje je dla KAŻDEGO rodzaju, którego wynik je niesie; zmierzone jest przy workflow (zdanie
   * o przebiegu).
   */
  summary?: string;
  /**
   * `timestamp` wpisu startu (ISO). Nieobecny = startu NIE widzieliśmy (zadanie sprzed okna
   * ogona) — UI nie pokazuje wtedy licznika, zamiast liczyć od kłamliwego „teraz".
   */
  startedAt?: string;
  /**
   * `toolUseResult.runId` (`wf_<id>`) — katalog przebiegu w satelicie sesji. Tylko workflow.
   * Klucz, po którym driver dokleja `run`; sam w sobie nic człowiekowi nie mówi.
   */
  runId?: string;
  /**
   * Rozkład przebiegu workflow: fazy ze skryptu i agenci z journala. Tylko workflow,
   * i tylko gdy driver zdążył go odczytać — nieobecny = „nie wiem", nigdy pusty szkielet.
   */
  run?: WorkflowRun;
  /**
   * Od kiedy subagent STOI i czeka na własne zadanie w tle (ISO, `timestamp` meldunku o postoju).
   *
   * Obecne = agent skończył turę, ale jego własna komenda w tle jeszcze leci: nie pracuje i nie
   * skończył. Nieobecne = agent pracuje. Tylko rodzaj `agent`. Czas zamiast flagi, żeby klient
   * liczył „czeka 18 min" tak samo jak z `startedAt`.
   *
   * Pole ADDYTYWNE — `PROTOCOL_VERSION` zostaje, stary klient je ignoruje. Wypełnia je reduktor
   * zadań z meldunku o postoju, zdejmuje wznowienie agenta
   * (`docs/background-tasks.md`, „Subagent: working, waiting, finished”). Gdy agent rusza sam, serwer
   * zdejmuje pole po wpisie w pliku subagenta późniejszym niż początek postoju; plik czyta co 5 s,
   * więc pole bywa obecne jeszcze przez kilka sekund po tym, jak agent ruszył.
   */
  waitingSince?: string;
  /**
   * Otwarte WŁASNE komendy subagenta w tle — te, które puścił on sam, nie główny agent. Tylko
   * rodzaj `agent`, także pracujący (bez `waitingSince`). Najwyżej 20, najnowsze, w kolejności startu.
   *
   * Nieobecne = serwer żadnej otwartej nie zna. To NIE znaczy, że agent na nic nie czeka: komendy
   * wystartowanej, zanim serwer zaczął czytać plik główny rozmowy (restart Raroga), serwer nie
   * pokazuje, bo jej koniec mógł go ominąć.
   *
   * Pole ADDYTYWNE — `PROTOCOL_VERSION` zostaje. Serwer nadaje je z pliku
   * rozmowy subagenta (`docs/background-tasks.md`, „Subagent's own commands”).
   */
  ownTasks?: AgentOwnTask[];
}

/**
 * Jedna otwarta komenda, którą subagent sam puścił w tle (pozycja `BackgroundTask.ownTasks`).
 *
 * Start takiej komendy stoi w pliku subagenta, nie w pliku głównym rozmowy, więc nie jest ona
 * osobnym zadaniem listy `backgroundTasks`, tylko szczegółem swojego agenta: na nią agent czeka,
 * gdy ma `waitingSince`.
 */
export interface AgentOwnTask {
  /** Identyfikator komendy (`backgroundTaskId` z wyniku jej startu) — klucz pozycji na liście. */
  id: string;
  /** Treść komendy `Bash`. Nieobecna = serwer jej nie zna; klient pokazuje pozycję bez treści. */
  command?: string;
  /** Start komendy (ISO). Nieobecny = serwer go nie zna; klient nie liczy czasu od „teraz". */
  startedAt?: string;
}

/**
 * Artefakt (strona na claude.ai), który sesja Claude Code opublikowała w bieżącej rozmowie
 * (`docs/artifacts.md`). Serwer składa listę z pliku rozmowy: wynik publikacji narzędziem `Artifact`
 * i meldunek CLI o końcu obserwacji z wariantem „artifact not found”. Niczego nie pobiera z claude.ai.
 */
export interface SessionArtifact {
  /**
   * Adres DOKŁADNIE w formie `https://claude.ai/artifact/<id>` (id z liter i cyfr ASCII) — innej serwer
   * nie wysyła. Schemat sprawdza tylko typ: klient i tak otwiera wyłącznie adres w tej gramatyce, a ścisły
   * wzorzec w schemacie zabrałby klientowi całą listę sesji przez jeden zły adres.
   */
  url: string;
  /** Tytuł z ostatniej publikacji: bez znaków sterujących, do 120 jednostek UTF-16; pusty → id z adresu. */
  title: string;
  /** Chwila ostatniej publikacji (ISO, `timestamp` wpisu z wynikiem). */
  publishedAt: string;
  /**
   * Artefakt usunięty na claude.ai (meldunek CLI „artifact not found”). Literał `true` albo brak pola,
   * jak `DiffListEntry.binary`: brak = żyje albo nie wiemy.
   */
  gone?: true;
}

/**
 * A task the session's Claude Code has scheduled with `CronCreate` and that is still armed, as the conversation file
 * shows it. Times are ISO strings; the cron pattern is in the Mac's local time, as the session wrote it.
 */
export interface SessionScheduledTask {
  /** The job id from `CronCreate`. The schema checks only the type. */
  id: string;
  /** Five-field cron pattern in the Mac's local time, as in the `CronCreate` input. */
  cron: string;
  /** From the `CronCreate` result, a `CronList` snapshot or a carry; `false` = runs once at the next match. */
  recurring: boolean;
  /** One line (whitespace runs become single spaces), without control characters, at most 120 UTF-16 units. */
  prompt: string;
  /** Time of the `CronCreate` result entry, or the carried `createdAt`. */
  createdAt?: string;
  /** Next run from the result or a snapshot; absent once a later run of a recurring task made it stale. */
  nextFireAt?: string;
  /** Time of the last run line of a recurring task. */
  lastFiredAt?: string;
  /** Recurring task with a known `createdAt`: `createdAt` + 7 days. */
  expiresAt?: string;
}

/**
 * PR state on GitHub (`SessionPullRequest.state`): the wire values, lowercase. `draft` is an open PR marked as a draft
 * on GitHub; only an open PR can be one.
 */
export const PULL_REQUEST_STATES = ['open', 'draft', 'merged', 'closed'] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

/**
 * Pull request utworzony w bieżącej rozmowie (`docs/pull-requests.md`). Serwer składa listę z plików
 * rozmowy: wywołanie `Bash` z poleceniem `gh pr create` i linia wyniku z adresem PR. Stan na GitHubie
 * (`state`) jest opcjonalny: jego źródło opisuje `docs/pull-requests.md`.
 */
export interface SessionPullRequest {
  /**
   * Adres DOKŁADNIE w formie `https://github.com/<owner>/<repo>/pull/<number>` — innej serwer nie wysyła.
   * Schemat sprawdza tylko typ, jak przy `SessionArtifact.url`: klient otwiera wyłącznie adres w tej gramatyce.
   */
  url: string;
  /** `<owner>/<repo>` z adresu. */
  repo: string;
  /** Numer PR z adresu (dodatnia liczba całkowita). */
  number: number;
  /** Chwila utworzenia (ISO, `timestamp` wpisu z wynikiem `gh pr create`). */
  createdAt: string;
  /**
   * Tytuł z argumentu `--title`/`-t` polecenia: bez znaków sterujących, do 120 jednostek UTF-16. Nieobecny =
   * polecenie tytułu nie podało albo podało go wyrażeniem powłoki (`--fill`, `"$T"`).
   */
  title?: string;
  /**
   * PR state on GitHub. A missing field means the state is unknown (not read, switched off, or never asked). Additive:
   * an unknown string drops only this field on the client (`DEGRADATIONS['pullRequests.state']`); `null` or a non-string
   * rejects the frame.
   */
  state?: PullRequestState;
}

/**
 * Jeden agent przebiegu workflow — z journala (`started`/`result`) i pierwszej linii jego
 * transkryptu (tag `[faza · etykieta]`). Bez tagu agent ma tylko `id` i `done`.
 */
export interface WorkflowAgent {
  /** `agentId` z journala — klucz dedup; UI pokazuje go tylko w braku etykiety (jako numer). */
  id: string;
  /** Faza z tagu w prompcie (`[Faza 2 · impl:api]`); nieobecna = skrypt bez tej konwencji. */
  phase?: string;
  /** Etykieta z tagu w prompcie; nieobecna = skrypt bez tej konwencji. */
  label?: string;
  /** Wpis `result` w journalu — agent skończył (sukces czy nie, journal tego nie rozróżnia). */
  done: boolean;
  /** `mtime` pliku `agent-<id>.meta.json` (ISO) — powstaje przy starcie agenta. */
  startedAt?: string;
}

/**
 * Rozkład przebiegu workflow: fazy w kolejności ze skryptu (`meta.phases[].title`) i agenci
 * w kolejności startu. Fazy bez agentów są legalne (jeszcze nie ruszyły); agenci z fazą
 * spoza listy też (skrypt zmienił nazwę w locie) — UI dokleja ją na końcu.
 */
export interface WorkflowRun {
  phases: string[];
  agents: WorkflowAgent[];
}

export const workflowAgentSchema = z.object({
  id: z.string().min(1),
  phase: z.string().optional(),
  label: z.string().optional(),
  done: z.boolean(),
  startedAt: z.string().optional(),
});

export const workflowRunSchema = z.object({
  phases: z.array(z.string()),
  agents: z.array(workflowAgentSchema),
});

export const agentOwnTaskSchema = z.object({
  id: z.string().min(1),
  command: z.string().optional(),
  startedAt: z.string().optional(),
});

export const backgroundTaskSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['command', 'agent', 'workflow', 'monitor']),
  description: z.string().optional(),
  command: z.string().optional(),
  agentType: z.string().optional(),
  model: z.string().optional(),
  summary: z.string().optional(),
  startedAt: z.string().optional(),
  runId: z.string().optional(),
  run: workflowRunSchema.optional(),
  // Postój subagenta i jego własne komendy: oba pola ADDYTYWNE i opcjonalne. `z.object` odcina
  // nieznane klucze, więc bez tych linii klient parsujący tym schematem by ich nie zobaczył.
  waitingSince: z.string().optional(),
  ownTasks: z.array(agentOwnTaskSchema).optional(),
});

type _AgentOwnTaskSchemaMatchesType =
  z.infer<typeof agentOwnTaskSchema> extends AgentOwnTask ? true : never;
type _AgentOwnTaskTypeMatchesSchema =
  AgentOwnTask extends z.infer<typeof agentOwnTaskSchema> ? true : never;
const _agentOwnTaskSchemaMatchesType: _AgentOwnTaskSchemaMatchesType = true;
const _agentOwnTaskTypeMatchesSchema: _AgentOwnTaskTypeMatchesSchema = true;
void _agentOwnTaskSchemaMatchesType;
void _agentOwnTaskTypeMatchesSchema;

type _BackgroundTaskSchemaMatchesType =
  z.infer<typeof backgroundTaskSchema> extends BackgroundTask ? true : never;
type _BackgroundTaskTypeMatchesSchema =
  BackgroundTask extends z.infer<typeof backgroundTaskSchema> ? true : never;
const _backgroundTaskSchemaMatchesType: _BackgroundTaskSchemaMatchesType = true;
const _backgroundTaskTypeMatchesSchema: _BackgroundTaskTypeMatchesSchema = true;
void _backgroundTaskSchemaMatchesType;
void _backgroundTaskTypeMatchesSchema;

/** Artefakt sesji. `gone` to literał `true` (jak `binary` pozycji diffa) — `false` odrzuca ramkę. */
export const sessionArtifactSchema = z.object({
  url: z.string(),
  title: z.string(),
  publishedAt: z.string(),
  gone: z.literal(true).optional(),
});

type _SessionArtifactSchemaMatchesType =
  z.infer<typeof sessionArtifactSchema> extends SessionArtifact ? true : never;
type _SessionArtifactTypeMatchesSchema =
  SessionArtifact extends z.infer<typeof sessionArtifactSchema> ? true : never;
const _sessionArtifactSchemaMatchesType: _SessionArtifactSchemaMatchesType = true;
const _sessionArtifactTypeMatchesSchema: _SessionArtifactTypeMatchesSchema = true;
void _sessionArtifactSchemaMatchesType;
void _sessionArtifactTypeMatchesSchema;

export const sessionScheduledTaskSchema = z.object({
  id: z.string(),
  cron: z.string(),
  recurring: z.boolean(),
  prompt: z.string(),
  createdAt: z.string().optional(),
  nextFireAt: z.string().optional(),
  lastFiredAt: z.string().optional(),
  expiresAt: z.string().optional(),
});

type _SessionScheduledTaskSchemaMatchesType =
  z.infer<typeof sessionScheduledTaskSchema> extends SessionScheduledTask ? true : never;
type _SessionScheduledTaskTypeMatchesSchema =
  SessionScheduledTask extends z.infer<typeof sessionScheduledTaskSchema> ? true : never;
const _sessionScheduledTaskSchemaMatchesType: _SessionScheduledTaskSchemaMatchesType = true;
const _sessionScheduledTaskTypeMatchesSchema: _SessionScheduledTaskTypeMatchesSchema = true;
void _sessionScheduledTaskSchemaMatchesType;
void _sessionScheduledTaskTypeMatchesSchema;

export const sessionPullRequestSchema = z.object({
  url: z.string(),
  repo: z.string(),
  number: z.number(),
  createdAt: z.string(),
  title: z.string().optional(),
  state: z.enum(PULL_REQUEST_STATES).optional(),
});

type _SessionPullRequestSchemaMatchesType =
  z.infer<typeof sessionPullRequestSchema> extends SessionPullRequest ? true : never;
type _SessionPullRequestTypeMatchesSchema =
  SessionPullRequest extends z.infer<typeof sessionPullRequestSchema> ? true : never;
const _sessionPullRequestSchemaMatchesType: _SessionPullRequestSchemaMatchesType = true;
const _sessionPullRequestTypeMatchesSchema: _SessionPullRequestTypeMatchesSchema = true;
void _sessionPullRequestSchemaMatchesType;
void _sessionPullRequestTypeMatchesSchema;
