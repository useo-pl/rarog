/**
 * Seedy trybu demo — 8 sesji zakładanych przy starcie, gdy rejestr jest pusty.
 *
 * Seedy opisują PRZESZŁOŚĆ deklaratywnie (transkrypt, stan, „czeka od"), a przyszłość zostawiają
 * mock-driverowi: sesja czekająca na zgodę dostaje żywy driver, który po decyzji poprowadzi turę
 * dalej, a sesja „rarog" streamuje delty bez końca. Dzięki temu ekran startowy demo wygląda tak
 * samo przy każdym uruchomieniu — bez czekania, aż scenariusz „dojedzie" do właściwego stanu.
 *
 * Ścieżki są fikcyjne (`/Users/demo/Projects/...`) — demo NIGDY nie dotyka prawdziwego `~/Projects`.
 *
 * Tekst seedów, „Wznów istniejącą”, diffu i nazwy projektów daje zestaw treści (`content/`); tu zostaje
 * struktura: role projektów i korzeń ścieżek, klocki seedów ({@link DemoSeedKit}), kształty meldunków CLI
 * i zdjęcia.
 */
import { deflateSync } from 'node:zlib';
import { dataUrlBytes } from '@rarog/shared';
import type {
  Block, DiffFileList, DiffFilePatch, EffortLevel, MessageAttachment, ResumableSession, SessionArtifact,
  PullRequestState, SessionDiff, SessionScheduledTask, SessionState, TranscriptNotice,
} from '@rarog/shared';
import { foreign, say } from '@rarog/shared/sentences';
import type { ServerSentence } from '@rarog/shared/sentences';
import { DEMO_DIFF_FILES, demoAheadBehind } from '../drivers/mock-driver.ts';
import type { MockScenario } from '../drivers/mock-driver.ts';
import { toolCallSemantics, writeDiffText } from '../drivers/tool-text.ts';
import type { InternalBlock } from '../drivers/types.ts';
import { createArtifactsTracker } from '../herdr/background/artifacts.ts';
import { noticeFromText } from '../herdr/background/notice.ts';
import { CLI_SHAPES } from '../herdr/background/cli-shapes.ts';
import { parsePullRequestUrl, pullRequestLinks } from '../herdr/background/pull-requests.ts';
import { createScheduledTasksTracker } from '../herdr/background/scheduled-tasks.ts';
import type {
  DemoArtifactPublication, DemoContent, DemoProjectKey, DemoPullRequestLink, DemoPullRequests, DemoSeedKit,
} from './content/types.ts';

/** Katalog-korzeń projektów demo (allow-lista `GET /api/projects` w trybie demo). */
export const DEMO_PROJECTS_ROOT = '/Users/demo/Projects';

/** Role projektów demo w kolejności pickera „Nowa sesja” (ta sama w każdym języku). */
export const DEMO_PROJECT_KEYS: readonly DemoProjectKey[] = ['main', 'stream', 'cleanup', 'import', 'bridge', 'panel'];

/** Katalog projektu demo tej roli: korzeń i nazwa z zestawu. */
export function demoProjectCwd(content: DemoContent, key: DemoProjectKey): string {
  return `${DEMO_PROJECTS_ROOT}/${content.projects[key]}`;
}

const MIN = 60_000;

export interface DemoSeedMessage {
  role: 'user' | 'assistant' | 'system';
  blocks: Block[];
  /** Ile ms przed „teraz" powstała wiadomość (transkrypt ma wyglądać na przeżyty). */
  agoMs: number;
  /** Wizytówki załączników — zdjęcia z `file` czyta mock nadzorcy z RAM. */
  attachments?: MessageAttachment[];
  /** Notka harnessu — liczona z treści wpisu tą samą funkcją co na produkcji. */
  notice?: TranscriptNotice;
}

export interface DemoSeedPermission {
  permId: string;
  toolName: string;
  displayText: string;
  /**
   * Input narzędzia, jak w zdarzeniu drivera — z niego manager liczy pola semantyczne karty
   * (`permissionSemantics`): komenda powłoki równa `displayText` daje kolor składni w apce.
   */
  input?: Record<string, unknown>;
  agoMs: number;
}

/** Zgoda seeda na komendę powłoki: `displayText` i `input.command` z jednego łańcucha. */
function shellPermission(
  permId: string, command: string, agoMs: number,
): DemoSeedPermission {
  return { permId, toolName: 'Bash', displayText: command, input: { command }, agoMs };
}

export interface DemoSeed {
  id: string;
  cwd: string;
  title: string;
  /** Człon sesji w tytule `projekt · sesja`; brak = manager policzy go z pierwszego promptu. */
  label?: string;
  state: SessionState;
  /** Dopisek stanu: zdanie Raroga albo token limitu planu `resetAt=<ISO>` (manager robi z niego zdanie limitu). */
  stateDetail?: ServerSentence | `resetAt=${string}`;
  /** „Czeka od" na glance — liczone od `stateSince`. */
  stateSinceAgoMs: number;
  createdAtAgoMs: number;
  lastActivityAgoMs: number;
  branch?: string;
  dirtyCount?: number;
  /** Wiersz gita na starcie demo; wartości bierzemy z tabeli mock-drivera (jedno źródło prawdy). */
  ahead?: number;
  behind?: number;
  lastSummary?: string;
  /**
   * Model i effort sesji demo.
   *
   * Różne w każdym seedzie celowo: pigułka „Fable 5.1 · high" w composerze ma w demo pokazywać
   * realne warianty (także brak effortu = „auto"), a nie jedną wartość powielaną sześć razy.
   */
  model?: string;
  effort?: EffortLevel;
  /** Ultracode sesji demo: jedno ziarno z `xhigh`, żeby pigułka i dymek pokazały oba stany. */
  ultracode?: boolean;
  /**
   * Rozmowa silnika tej karty — tylko tam, gdzie demo ma pokazać ją na liście „Wznów istniejącą”
   * jako otwartą (wiersz „otwarta” z „Rozwidl”). Pasuje do wpisu `-0` z `demoResumable`.
   */
  engineSessionId?: string;
  messages: DemoSeedMessage[];
  permission?: DemoSeedPermission;
  /** Żywy driver dla tej sesji (brak = sesja bez drivera: done / resumable). */
  live?: MockScenario;
}

const text = (value: string): Block[] => [{ type: 'text', text: value }];

/**
 * Bloki seeda jako bloki wewnętrzne transkryptu: transkrypt demo udaje rozmowę człowieka z agentem, więc jego
 * tekst to treść obca (`foreign`) i nie dostaje kodu zdania.
 */
export function demoBlocks(blocks: readonly Block[]): InternalBlock[] {
  return blocks.map((block): InternalBlock => (
    block.type === 'text' ? { type: 'text', text: foreign(block.text) } : block
  ));
}

/** Projekty widoczne w pickerze „Nowa sesja" w trybie demo: nazwy z zestawu w kolejności {@link DEMO_PROJECT_KEYS}. */
export function demoProjects(content: DemoContent): { path: string; name: string }[] {
  return DEMO_PROJECT_KEYS.map((key) => ({ path: demoProjectCwd(content, key), name: content.projects[key] }));
}

/**
 * Krok narzędzia w transkrypcie seeda — z tymi samymi polami semantycznymi co na żywo:
 * komenda powłoki idzie dosłownie, wejście innych narzędzi jako JSON z wcięciem.
 */
function toolStep(toolName: string, summary: string, input: Record<string, unknown>): Block[] {
  const command = input['command'];
  const detail = typeof command === 'string' ? command : JSON.stringify(input, null, 2);
  return [{ type: 'tool-call', toolName, summary, detail, ...toolCallSemantics(toolName, input) }];
}

/** Za ile od „teraz" resetuje się limit planu w seedzie `demo-map-view`. */
const LIMIT_RESET_MS = 2 * 60 * MIN;

/**
 * Sesje do wznowienia w trybie demo — wpisy zestawu treści, od najnowszego. Demo NIE czyta `~/.claude/projects`.
 *
 * @param content zestaw treści demo (teksty wpisów)
 * @param cwd katalog projektu, dla którego pytamy (wpisy udają jego magazyn CLI)
 * @param now „teraz" w ms — wstrzykiwane, żeby `mtime` był powtarzalny w testach
 */
export function demoResumable(content: DemoContent, cwd: string, now: number = Date.now()): ResumableSession[] {
  const name = cwd.replace(/\/+$/, '').split('/').at(-1) ?? 'projekt';
  return content.resumable.map((fixture, index) => ({
    engineSessionId: `demo-engine-${name}-${String(index)}`,
    cwd,
    mtime: new Date(now - fixture.agoMs).toISOString(),
    firstPrompt: fixture.firstPrompt,
    title: fixture.firstPrompt,
    gitBranch: fixture.branch,
    // Żywość rozstrzyga manager po kartach (`engineSessionId` seeda), tak jak na produkcji.
    liveInHerdr: false,
  }));
}

// ---------------------------------------------------------------------------
// Git w demo: diff bez jednego procesu potomnego
// ---------------------------------------------------------------------------

/**
 * Diff pokazywany w overlayu w trybie demo: patch z zestawu treści.
 *
 * Realistyczny, ale ZAWSZE ten sam — demo ma wyglądać identycznie przy każdym uruchomieniu.
 * Liczby w `files` zgadzają się z patchem, żeby lista plików i treść nie kłamały względem siebie.
 * Lista to {@link DEMO_DIFF_FILES} — ta sama, z której mock składa `git-status` (`fileDetails`).
 */
export function demoDiff(content: DemoContent): SessionDiff {
  return {
    files: DEMO_DIFF_FILES.map((file) => ({ ...file })),
    patch: content.diffPatch,
    truncated: false,
  };
}

/**
 * Lista zmian demo dla okna diffa per plik — te same trzy pliki i liczniki co `demoDiff`
 * i `git-status` mocka, więc panel, lista okna i patch pliku nie przeczą sobie.
 */
export function demoDiffFiles(): DiffFileList {
  return { files: DEMO_DIFF_FILES.map((file) => ({ ...file })), truncated: false };
}

/**
 * Patch JEDNEGO pliku demo: blok patcha zestawu od `diff --git` tej ścieżki do następnego.
 * Ścieżka spoza listy to `null` — manager oddaje wtedy 404 `diff-file-not-found`, jak na produkcji.
 */
export function demoDiffFile(content: DemoContent, path: string): DiffFilePatch | null {
  if (!DEMO_DIFF_FILES.some((file) => file.path === path)) return null;
  const block = content.diffPatch.split(/^(?=diff --git )/m)
    .find((part) => part.startsWith(`diff --git a/${path} b/${path}\n`));
  // Bloki mocka dzieli pusta linia; w patchu jednego pliku nie ma po czym jej zostawiać.
  return block === undefined ? null : { path, patch: block.replace(/\n+$/, '\n'), truncated: false };
}

/**
 * 8 sesji startowych (spec, sekcja „Demo mode") z zestawu treści, złożonych z klocków {@link DemoSeedKit}.
 *
 * @param content zestaw treści demo
 * @param now „teraz" w ms — wstrzykiwane przez managera, żeby godzina resetu limitu była
 *            deterministyczna w testach (seedy poza tym opisują wyłącznie offsety w przeszłość).
 */
export function demoSeeds(content: DemoContent, now: number = Date.now()): DemoSeed[] {
  return content.seeds(seedKit(content, now));
}

/** Klocki seedów: kształty wspólne dla każdego języka zestawu. */
function seedKit(content: DemoContent, now: number): DemoSeedKit {
  const project = (key: DemoProjectKey): string => demoProjectCwd(content, key);
  return {
    now,
    project,
    text,
    toolStep,
    editStep: (path, detail) => [{
      type: 'tool-call',
      toolName: 'Edit',
      summary: path,
      detail,
      ...toolCallSemantics('Edit', { file_path: path }),
    }],
    writeStep: (path, content) => [{
      type: 'tool-call',
      toolName: 'Write',
      summary: path,
      detail: writeDiffText(content),
      detailKind: 'diff',
      ...toolCallSemantics('Write', { file_path: path, content }),
    }],
    shellPermission,
    // Ahead/behind seeda — z tej samej tabeli, z której korzysta `git-status` mock-drivera.
    sync: (key) => demoAheadBehind(project(key), content) ?? {},
    limitReset: () => `resetAt=${new Date(now + LIMIT_RESET_MS).toISOString()}`,
    backendRestarted: () => say('demo.seed-backend-restarted'),
    commandCompleted: (agoMs, command) => harnessNotice(
      agoMs, 'completed', `Background command "${command}" completed (exit code 0)`,
    ),
    commandFailed: (agoMs, command, exitCode) => harnessNotice(
      agoMs, 'failed', `Background command "${command}" failed with exit code ${String(exitCode)}`,
    ),
    agentStopped: (agoMs, name) => harnessNotice(agoMs, 'killed', `Agent "${name}" was stopped`),
    // Zdjęcie z serwera ma wagę; z historii bez nazwy i wagi (`bytes: 0`, jak import jsonl), także po sprzątaniu.
    bridgeLogAttachments: (pdfName) => [
      { kind: 'image', name: '', bytes: dataUrlBytes(demoImages().log), mime: 'image/png', file: BRIDGE_LOG_FILE },
      { kind: 'file', name: pdfName, bytes: 182_431, mime: 'application/pdf' },
    ],
    bridgePhoneAttachments: () => [
      { kind: 'image', name: '', bytes: 0, mime: 'image/png', file: BRIDGE_PHONE_FILE },
      { kind: 'image', name: '', bytes: 0, mime: 'image/png', file: BRIDGE_GONE_FILE },
    ],
    chartImage: (alt) => ({ type: 'image', dataUrl: demoImages().chart, alt }),
    pullRequests: (links) => pullRequestsOfLinks(now, links),
    artifacts: (publications) => artifactsOfPublications(now, publications),
  };
}

// ---------------------------------------------------------------------------
// Notki harnessu i zdjęcia w demo
// ---------------------------------------------------------------------------

/** Nazwy zdjęć w kształcie `herdr/uploads.ts` — mock nadzorcy oddaje je z RAM. */
const BRIDGE_LOG_FILE = '1790000000000-6c6f676f62656373.png';
const BRIDGE_PHONE_FILE = '1790000000001-69706164736e6170.png';
/** Zdjęcie, którego już nie ma (sprzątanie po 48 h): `GET …/uploads` oddaje 404. */
const BRIDGE_GONE_FILE = '1789000000000-7a6e696b6e696574.png';

/**
 * Wpis, który CLI wstrzykuje do rozmowy po końcu zadania w tle: surowy tekst zostaje w blokach,
 * a notkę końca zadania liczy z niego ta sama funkcja co produkcja.
 * `note` to dopisek `<note>` meldunku agenta (postój albo koniec), w miejscu, w którym pisze go CLI
 * (fixture `tasks/measured/postoj-2.1.296.jsonl`).
 */
function harnessNotice(
  agoMs: number, status: string, summary: string, note?: string,
): DemoSeedMessage & { notice: TranscriptNotice } {
  const raw = [
    '<task-notification>',
    `<task-id>demo-${String(agoMs / MIN)}</task-id>`,
    `<status>${status}</status>`,
    `<summary>${summary}</summary>`,
    ...(note === undefined ? [] : [`<note>${note}</note>`]),
    '</task-notification>',
  ].join('\n');
  return { role: 'user', agoMs, blocks: text(raw), notice: noticeFromText(raw) };
}

/**
 * Dopisek CLI przy meldunku o POSTOJU subagenta: skończył turę, a jego własna komenda w tle jeszcze
 * leci. Brzmienie zmierzone na CLI 2.1.296 (`server/test/fixtures/herdr/tasks/measured/postoj.jsonl`).
 */
const STANDBY_NOTE = 'This agent stopped with background work of its own still running. It may resume on its own '
  + 'when that work completes or reports, and the same task-id notifies again if it does; the result below may be '
  + 'interim.';

/**
 * Notka o postoju subagenta dla sterowanego scenariusza odbioru `standby` (`scenarios.ts`). Stoi tutaj,
 * bo tylko ten plik wolno karmić literałami meldunku CLI (dane demo jako WEJŚCIE parsera, strażnik
 * `herdr-background-boundary.test.ts`). Wynik `waiting` wyznacza z tekstu ta sama funkcja co na produkcji,
 * więc zmiana rozpoznania postoju wyjdzie też w demo.
 */
export function demoStandbyNotice(agoMs: number, name: string): DemoSeedMessage & { notice: TranscriptNotice } {
  return harnessNotice(agoMs, 'completed', `Agent "${name}" finished`, STANDBY_NOTE);
}

/** Artefakty scenariusza odbioru `artifacts`: zwykły raport i usunięty szkic. */
export interface DemoArtifacts {
  /** Lista w kształcie protokołu, najnowsza publikacja pierwsza. */
  artifacts: SessionArtifact[];
  /** Notka o końcu obserwacji usuniętego szkicu (rodzaj `artifact-watch`). */
  watch: DemoSeedMessage & { notice: TranscriptNotice };
}

/** Tytuły artefaktów scenariusza `artifacts` (test demo i apka szukają wierszy po nich). */
export const DEMO_ARTIFACT_TITLES = { report: 'Raport tygodniowy', draft: 'Szkic prezentacji' } as const;

/**
 * Artefakty sterowanego scenariusza odbioru `artifacts` (`scenarios.ts`): raport opublikowany
 * dwa razy (ostatnio 2 h temu) i szkic opublikowany 26 h temu, usunięty na claude.ai (meldunek o końcu
 * obserwacji 20 min temu). Stoi tutaj, bo tylko ten plik wolno karmić literałami CLI (adres artefaktu,
 * meldunek; strażnik `herdr-background-boundary.test.ts`). Listę składa z wpisów pliku rozmowy ta sama
 * maszyna co follower (`createArtifactsTracker`), a notkę ta sama funkcja co import (`noticeFromText`):
 * zmiana rozpoznania na produkcji wyjdzie też w demo.
 */
export function demoArtifacts(now: number): DemoArtifacts {
  const iso = (agoMs: number): string => new Date(now - agoMs).toISOString();
  const report = 'https://claude.ai/artifact/RaportTygodniowy7Kq2Wn';
  const draft = 'https://claude.ai/artifact/SzkicPrezentacji4Hm9Zx';
  const published = (url: string, title: string, agoMs: number, updated: boolean): Record<string, unknown> => ({
    type: 'user', timestamp: iso(agoMs),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `demo-${String(agoMs)}`, content: 'ok' }] },
    toolUseResult: { url, title, updated, artifact_id: url.slice(url.lastIndexOf('/') + 1) },
  });
  const watchAgo = 20 * MIN;
  const raw = [
    '<task-notification>',
    '<task-type>artifact-watch-lifecycle</task-type>',
    `<summary>Stopped watching Artifact: "${DEMO_ARTIFACT_TITLES.draft}" (artifact not found)</summary>`,
    `<event>Watch on ${draft} ended — no such artifact for this account (it was deleted, or it has not been `
      + 'shared with the user). This session no longer keeps track of new versions of it.</event>',
    '</task-notification>',
  ].join('\n');
  const tracker = createArtifactsTracker();
  tracker.note(published(draft, DEMO_ARTIFACT_TITLES.draft, 26 * 60 * MIN, false));
  tracker.note(published(report, DEMO_ARTIFACT_TITLES.report, 3 * 60 * MIN, false));
  tracker.note(published(report, DEMO_ARTIFACT_TITLES.report, 2 * 60 * MIN, true));
  tracker.note({
    type: 'user', timestamp: iso(watchAgo), origin: { kind: 'task-notification' },
    message: { role: 'user', content: raw },
  });
  return {
    artifacts: [...tracker.artifacts],
    watch: { role: 'user', agoMs: watchAgo, blocks: text(raw), notice: noticeFromText(raw) },
  };
}

/** Prompts of the `scheduled-tasks` scenario (the demo test and the app look rows up by them). */
export const DEMO_SCHEDULED_TASKS = {
  oneShot: 'Check whether the nightly import finished and summarise the errors',
  recurring: 'Run the flaky export tests and report new failures',
} as const;

/**
 * Scheduled tasks of the `scheduled-tasks` scenario (`scenarios.ts`): a one-shot task created 20 min ago that runs in
 * 40 min, and a recurring one every 30 min, created 2 h ago, that ran 10 min ago. The production tracker
 * (`createScheduledTasksTracker`) builds the list from conversation entries, so a change of recognition shows in the
 * demo too. The one-shot pattern names the minute, hour, day and month of its run in UTC.
 */
export function demoScheduledTasks(now: number): SessionScheduledTask[] {
  const tracker = createScheduledTasksTracker();
  const iso = (ms: number): string => new Date(ms).toISOString();
  const create = (id: string, input: Record<string, unknown>, result: Record<string, unknown>, atMs: number): void => {
    const toolId = `demo-cron-${id}`;
    tracker.note({
      type: 'assistant', timestamp: iso(atMs),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'CronCreate', input }] },
    });
    tracker.note({
      type: 'user', timestamp: iso(atMs), toolUseResult: { id, durable: false, ...result },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: `Scheduled ${id}` }] },
    });
  };
  const runAt = new Date(now + 40 * MIN);
  const oneShotCron = `${String(runAt.getUTCMinutes())} ${String(runAt.getUTCHours())} ${String(runAt.getUTCDate())} `
    + `${String(runAt.getUTCMonth() + 1)} *`;
  create('5d0c1a2b', { cron: '*/30 * * * *', prompt: DEMO_SCHEDULED_TASKS.recurring, recurring: true },
    { recurring: true, nextFireAt: now - 10 * MIN }, now - 120 * MIN);
  create('a7e3f904', { cron: oneShotCron, prompt: DEMO_SCHEDULED_TASKS.oneShot, recurring: false },
    { recurring: false, nextFireAt: runAt.getTime() }, now - 20 * MIN);
  tracker.note({ type: 'system', subtype: 'scheduled_task_fire', timestamp: iso(now - 10 * MIN), taskId: '5d0c1a2b' });
  return [...tracker.tasks];
}

/** Pull requesty scenariusza odbioru `pull-requests`: adresy i tytuły (test demo i apka szukają wierszy po nich). */
export const DEMO_PULL_REQUESTS = {
  titled: 'https://github.com/acme/widget/pull/42',
  bare: 'https://github.com/acme/widget-docs/pull/7',
  draft: 'https://github.com/acme/widget/pull/45',
  title: 'Add CSV export',
  draftTitle: 'Import notes from Markdown',
} as const;

/**
 * GitHub states of the demo PRs (the fixed map of the state source, `bootstrap/pr-status.ts`): the titled PR is merged,
 * the draft one is a draft, the bare one has no state; the PRs of the content set's own conversations have the states
 * the set gives (`DemoContent.pullRequestStates`). The demo never asks `gh`.
 */
export function demoPullRequestStates(content: DemoContent): ReadonlyMap<string, PullRequestState> {
  return new Map([
    [DEMO_PULL_REQUESTS.titled, 'merged'],
    [DEMO_PULL_REQUESTS.draft, 'draft'],
    ...content.pullRequestStates ?? [],
  ]);
}

/** The `gh` login of the demo's fixed GitHub: the author of every demo PR. It stays in the server's memory. */
export const DEMO_GITHUB_LOGIN = 'demo';

/**
 * Time of the first entry of every demo conversation and creation time of every demo PR on the demo's fixed GitHub
 * (the epoch): only the window check reads it, so the demo lists do not depend on the server's uptime.
 */
const DEMO_CONVERSATION_START_MS = 0;

/** One demo PR as the fixed GitHub answers it (`FixedPullRequest` in `pr-status/source.ts`). */
interface DemoGitHubPullRequest {
  readonly author: string;
  readonly createdAtMs: number;
  readonly state?: PullRequestState;
  readonly title?: string;
}

/**
 * The demo's fixed GitHub (`bootstrap/pr-status.ts`): every demo PR, authored by {@link DEMO_GITHUB_LOGIN}, with the
 * state of {@link demoPullRequestStates} and the title its card shows (the bare PR has neither).
 *
 * The demo has no GitHub clock: every PR counts as created at {@link DEMO_CONVERSATION_START_MS}, the time of the
 * first entry of every demo conversation ({@link pullRequestsOfLinks}). A conversation lists a PR only when it was
 * created at or after that entry, so the demo PRs stay on their lists however long the server runs.
 */
export function demoGitHub(
  content: DemoContent,
): { readonly viewer: string; readonly prs: ReadonlyMap<string, DemoGitHubPullRequest> } {
  const states = demoPullRequestStates(content);
  const titles = new Map<string, string>([
    [DEMO_PULL_REQUESTS.titled, DEMO_PULL_REQUESTS.title],
    [DEMO_PULL_REQUESTS.draft, DEMO_PULL_REQUESTS.draftTitle],
    ...content.pullRequestTitles ?? [],
  ]);
  const urls = new Set([DEMO_PULL_REQUESTS.bare, ...states.keys(), ...titles.keys()]);
  const prs = new Map([...urls].map((url): [string, DemoGitHubPullRequest] => {
    const state = states.get(url);
    const title = titles.get(url);
    return [url, {
      author: DEMO_GITHUB_LOGIN, createdAtMs: DEMO_CONVERSATION_START_MS,
      ...(state === undefined ? {} : { state }), ...(title === undefined ? {} : { title }),
    }];
  }));
  return { viewer: DEMO_GITHUB_LOGIN, prs };
}

/**
 * Linked PRs of the controlled `pull-requests` scenario (`scenarios.ts`): the titled PR linked 2 h ago, the bare one
 * a day ago and the draft over two days ago, newest first. The set goes through the production reader rule
 * ({@link pullRequestsOfLinks}); titles and states come from the demo's fixed GitHub ({@link demoGitHub}).
 * The repositories are synthetic.
 */
export function demoPullRequests(now: number): DemoPullRequests {
  return pullRequestsOfLinks(now, [
    { url: DEMO_PULL_REQUESTS.draft, agoMs: 50 * 60 * MIN },
    { url: DEMO_PULL_REQUESTS.bare, agoMs: 26 * 60 * MIN },
    { url: DEMO_PULL_REQUESTS.titled, agoMs: 2 * 60 * MIN },
  ]);
}

/**
 * Linked PRs of a demo conversation: a first entry at {@link DEMO_CONVERSATION_START_MS}, then each link as a link
 * entry in the shape of the conversation file; the production rule ({@link pullRequestLinks}) builds the set and the
 * window. The card shows the PRs the demo's fixed GitHub ({@link demoGitHub}) gives the demo login as author, with its titles.
 */
function pullRequestsOfLinks(now: number, links: readonly DemoPullRequestLink[]): DemoPullRequests {
  const iso = (agoMs: number): string => new Date(now - agoMs).toISOString();
  const LINK = CLI_SHAPES.prLink.literals;
  const start = new Date(DEMO_CONVERSATION_START_MS).toISOString();
  const read = pullRequestLinks([
    JSON.stringify({ type: 'user', timestamp: start, message: { role: 'user', content: 'demo' } }),
    ...links.map(({ url, agoMs }) => {
      const pr = parsePullRequestUrl(url);
      return JSON.stringify({
        type: LINK.type, sessionId: 'demo', [LINK.number]: pr?.number, [LINK.url]: url, [LINK.repository]: pr?.repo,
        timestamp: iso(agoMs),
      });
    }),
  ]);
  const pullRequests = read.linked;
  return read.windowStart === null ? { pullRequests } : { pullRequests, windowStart: read.windowStart };
}

/**
 * Artifact list of a demo conversation: each publication becomes a result entry of the `Artifact` tool in the shape
 * of the conversation file, and the follower's tracker (`createArtifactsTracker`) builds the list from them.
 */
function artifactsOfPublications(now: number, publications: readonly DemoArtifactPublication[]): SessionArtifact[] {
  const tracker = createArtifactsTracker();
  for (const { id, title, agoMs } of publications) {
    tracker.note({
      type: 'user', timestamp: new Date(now - agoMs).toISOString(),
      message: {
        role: 'user', content: [{ type: 'tool_result', tool_use_id: `demo-${String(agoMs)}`, content: 'ok' }],
      },
      toolUseResult: { url: `https://claude.ai/artifact/${id}`, title, updated: false, artifact_id: id },
    });
  }
  return [...tracker.artifacts];
}

/**
 * Zdjęcia seedów, które mock nadzorcy trzyma w RAM i oddaje przez `GET …/uploads/:file`: w katalogu projektu roli
 * `bridge` (seed `demo-pipe-link`, sesja z notkami i zdjęciami).
 * After them come the images the content set adds for its own seed messages (`DemoContent.extraUploads`).
 */
export function demoSeedUploads(content: DemoContent): { cwd: string; file: string; dataUrl: string }[] {
  const images = demoImages();
  const cwd = demoProjectCwd(content, 'bridge');
  return [
    { cwd, file: BRIDGE_LOG_FILE, dataUrl: images.log },
    { cwd, file: BRIDGE_PHONE_FILE, dataUrl: images.phone },
    ...(content.extraUploads ?? []).map(({ project, file, dataUrl }) => ({
      cwd: demoProjectCwd(content, project), file, dataUrl,
    })),
  ];
}

/** Colour of a pixel of a demo image ({@link demoPng}). */
export type Rgb = readonly [number, number, number];

let bridgeImages: { log: string; phone: string; chart: string } | undefined;

/**
 * Obrazki demo rysowane kodem (bez binariów w repo), raz na proces: poziomy zrzut logu, pionowy
 * zrzut z telefonu i wykres słupkowy. Różne proporcje, bo miniatura ma stałą wysokość, a szerokość
 * idzie za proporcją zdjęcia.
 */
function demoImages(): { log: string; phone: string; chart: string } {
  const ink: Rgb = [200, 204, 210];
  const green: Rgb = [74, 222, 128];
  const amber: Rgb = [255, 180, 84];
  const white: Rgb = [255, 255, 255];
  bridgeImages ??= {
    log: demoPng(480, 320, (x, y) => {
      const dark: Rgb = [17, 20, 24];
      const line = Math.floor((y - 16) / 22);
      if (y < 16 || (y - 16) % 22 >= 9 || line >= 13) return dark;
      if (x >= 20 && x < 52) return line % 4 === 3 ? amber : green;
      return x >= 60 && x < 60 + 120 + ((line * 97) % 300) ? ink : dark;
    }),
    phone: demoPng(240, 360, (x, y) => {
      if (y < 44) return [11, 87, 208];
      if (x < 16 || x >= 224 || y < 60 || y >= 340) return [242, 242, 247];
      const row = Math.floor((y - 76) / 28);
      const onRow = y >= 76 && (y - 76) % 28 < 10 && row < 9;
      if (onRow && x >= 32 && x < 32 + 80 + ((row * 53) % 100)) return row === 2 ? amber : [142, 142, 147];
      return white;
    }),
    chart: demoPng(360, 200, (x, y) => {
      if (y >= 180 && y < 182 && x >= 16 && x < 344) return [113, 113, 122];
      const slot = Math.floor((x - 24) / 28);
      const height = [120, 132, 128, 40, 36, 140, 150, 146, 44, 138, 152, 160][slot] ?? 0;
      const inBar = x >= 24 && (x - 24) % 28 < 18 && y < 180 && y >= 180 - height;
      if (inBar) return height < 60 ? amber : green;
      return white;
    }),
  };
  return bridgeImages;
}

/** Tablica CRC-32 (wielomian PNG) — liczona raz. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** PNG RGB 8 bit z funkcji koloru piksela → data URL (kształt `IMAGE_DATA_URL_PATTERN`). */
export function demoPng(width: number, height: number, paint: (x: number, y: number) => Rgb): string {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    // Bajt filtra 0 (bez filtra) na początku każdego wiersza — `Buffer.alloc` już go wyzerował.
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      const at = y * stride + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // głębia bitowa
  header[9] = 2; // RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}
