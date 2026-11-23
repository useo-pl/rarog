/*
 * Rejestr kształtów CLI zadań w tle (`CLI_SHAPES`): każdy literał trafia w coś ZMIERZONEGO
 * albo w istniejącą próbkę testu — strażnik 5 planu „jedno miejsce".
 *
 * Literał bez pokrycia jest sierotą: nikt nie wie, czy dzisiejsze Claude Code jeszcze tak pisze.
 * Fixture'y w `fixtures/herdr/tasks/measured/` odświeża pomiar zadań w tle
 * (`docs/background-tasks.md`, „After a Claude Code update”), a fixture'y artefaktów sesji w
 * `fixtures/herdr/artifacts/measured/` (wpisy `artifactPublish` i `artifactWatch`) pomiar samego magazynu CLI
 * (`docs/artifacts.md`, „After a Claude Code update”), z własną wersją w nazwie pliku. Fixtures of the session's
 * scheduled tasks in `fixtures/herdr/scheduled/measured/` (entry `scheduledTasks`) are hand excerpts of a live
 * measurement, one conversation per file, with their own version in the file name.
 *
 * Trafienie liczy się TYLKO w miejscu, z którego kod ten literał czyta. Rejestr jest pełen słów
 * pospolitych (`status`, `message`, `task`): szukane po całym pliku trafiają zawsze i niczego
 * nie dowodzą. Pierwsza, naiwna sonda pomyliła się w obie strony naraz — uznała
 * `taskOutput.status` za zmierzony, bo wynik `Agent` też ma pole `status`, a `completed` za
 * niezmierzony, bo stoi w znaczniku meldunku, nie jako osobna wartość.
 *
 * Dwie listy:
 * - {@link MEASURED}: literały, które pomiar umie postawić, każdy z regułą „gdzie ma stać";
 * - {@link OUTSIDE}: lista ZAMKNIĘTA literałów, których scenariusze nie wywołują (workflow,
 *   monitor, skill, `TaskStop`, `TaskOutput`, sierota). Te muszą stać w próbkach istniejących
 *   testów. Granica strażnika: lista nie wygasa sama — gdy pomiar zacznie pokrywać literał
 *   stąd, przenosi się go do {@link MEASURED} ręcznie, razem z regułą.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_SHAPES, literalSource } from '../src/herdr/background/cli-shapes.ts';
import type { CliShape } from '../src/herdr/background/cli-shapes.ts';

const MEASURED_DIR = join(import.meta.dirname, 'fixtures/herdr/tasks/measured');
const ARTIFACTS_DIR = join(import.meta.dirname, 'fixtures/herdr/artifacts/measured');
const SCHEDULED_DIR = join(import.meta.dirname, 'fixtures/herdr/scheduled/measured');
const VERSIONED = /-(\d+(?:\.\d+)+)\.jsonl$/;

/** Katalog fixture'ów z pomiaru: pliki bieżące i wersje, których archiwum równa się bieżącemu. */
interface MeasuredDir {
  readonly dir: string;
  /**
   * Pokrycie liczymy WYŁĄCZNIE z plików bieżących (`<scenariusz>.jsonl`). Archiwum starszej wersji
   * (`<scenariusz>-<wersja>.jsonl`) zostaje w katalogu na zawsze, więc liczone razem pokrywałoby
   * literał, którego nowe CLI już nie pisze.
   */
  readonly files: string[];
  /** Wersje CLI, których plik archiwalny jest bajt w bajt równy plikowi bieżącemu tego scenariusza. */
  readonly currentVersions: (scenario: string) => string[];
}

function measuredDir(dir: string): MeasuredDir {
  const all = readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
  return {
    dir,
    files: all.filter((name) => !VERSIONED.test(name)),
    currentVersions: (scenario) => {
      const current = readFileSync(join(dir, `${scenario}.jsonl`), 'utf8');
      return all.flatMap((name) => {
        const version = VERSIONED.exec(name)?.[1];
        const same = version !== undefined && name === `${scenario}-${version}.jsonl`
          && readFileSync(join(dir, name), 'utf8') === current;
        return same ? [version] : [];
      });
    },
  };
}

const TASKS = measuredDir(MEASURED_DIR);
const ARTIFACTS = measuredDir(ARTIFACTS_DIR);
const SCHEDULED = measuredDir(SCHEDULED_DIR);
const FILES = TASKS.files;
/** Wpisy rejestru, których pomiarem jest katalog artefaktów; reszta idzie za fixture'ami zadań. */
const ARTIFACT_SHAPES: readonly string[] = ['artifactPublish', 'artifactWatch'];
/** Registry entries measured by the scheduled tasks directory. */
const SCHEDULED_SHAPES: readonly string[] = ['scheduledTasks'];

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const blocks = (entry: Json): Json[] => {
  const content: unknown = record(entry['message'])?.['content'];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item: unknown): Json[] => {
    const block = record(item);
    return block === null ? [] : [block];
  });
};

/** Linie jednego fixture'u (bez znaczników skryptu `_pomiar`). */
const linesOf = (name: string, dir = MEASURED_DIR): Json[] => readFileSync(join(dir, name), 'utf8')
  .split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Json)
  .filter((entry) => entry['_pomiar'] === undefined);

/** Wszystkie linie zmierzonych fixture'ów. */
const LINES: Json[] = FILES.flatMap((name) => linesOf(name));

const MARK = CLI_SHAPES.notification.literals.open;
const tag = (source: string, open: string): string => {
  const close = `</${open.slice(1)}`;
  const from = source.indexOf(open);
  const to = source.indexOf(close, from);
  return from === -1 || to === -1 ? '' : source.slice(from + open.length, to).trim();
};

/** Meldunek razem z nośnikiem: z jakiego rodzaju wpisu i z jakiego pola przyszedł tekst. */
interface Carried { readonly type: string; readonly field: string; readonly inner: string; readonly text: string }
const CARRIED: Carried[] = LINES.flatMap((entry): Carried[] => {
  const type = text(entry['type']);
  const attachment = record(entry['attachment']);
  const candidates: [string, string, string][] = [
    ['content', '', text(entry['content'])],
    ['message', '', text(record(entry['message'])?.['content'])],
    ...(attachment === null ? [] : Object.entries(attachment)
      .map(([field, value]): [string, string, string] => [field, text(attachment['type']), text(value)])),
  ];
  return candidates.filter(([, , value]) => value.includes(MARK))
    .map(([field, inner, value]) => ({ type, field, inner, text: value }));
});

/**
 * Wywołania narzędzi i wyniki sparowane z nimi po `tool_use_id` — W OBRĘBIE JEDNEGO PLIKU.
 * Identyfikatory są znormalizowane w każdym fixture osobno (`toolu_02` to `Bash` w jednym pliku
 * i `SendMessage` w drugim), więc wspólna mapa przypisałaby wynik cudzemu narzędziu.
 */
interface Call { readonly name: string; readonly input: Json }
interface Result { readonly tool: string; readonly keys: string[]; readonly values: Json; readonly entry: Json }
const CALLS: Call[] = [];
const RESULTS: Result[] = [];
for (const name of FILES) {
  const lines = linesOf(name);
  const byId = new Map<string, Call>();
  for (const entry of lines) {
    for (const block of blocks(entry)) {
      if (block['type'] !== 'tool_use') continue;
      const call = { name: text(block['name']), input: record(block['input']) ?? {} };
      byId.set(text(block['id']), call);
      CALLS.push(call);
    }
  }
  for (const entry of lines) {
    for (const block of blocks(entry)) {
      if (block['type'] !== 'tool_result') continue;
      RESULTS.push({
        tool: byId.get(text(block['tool_use_id']))?.name ?? '',
        keys: Array.isArray(entry['_klucze']) ? entry['_klucze'].map(String) : [],
        values: record(entry['toolUseResult']) ?? {},
        entry,
      });
    }
  }
}

const summaries = CARRIED.map((item) => tag(item.text, CLI_SHAPES.notification.literals.summary));
const statuses = CARRIED.map((item) => tag(item.text, CLI_SHAPES.notification.literals.status));
const carrier = (type: string, field: string): boolean => CARRIED.some((item) => item.type === type && item.field === field);
const resultKey = (tool: string, key: string): boolean => RESULTS.some((item) => item.tool === tool && item.keys.includes(key));
const inputKey = (tool: string, key: string): boolean => CALLS.some((call) => call.name === tool && key in call.input);
const called = (tool: string): boolean => CALLS.some((call) => call.name === tool);

const N = CLI_SHAPES.notification.literals;
const NOTE = CLI_SHAPES.agentNote.literals;
const RESUME = CLI_SHAPES.agentResume.literals;
const C = CLI_SHAPES.notificationCarriers.literals;
const S = CLI_SHAPES.summaryKinds.literals;
const TOOLS = CLI_SHAPES.taskTools.literals;

/**
 * Dopiski `<note>` meldunków AGENTA ze statusem `completed` — tylko stąd kod czyta frazy postoju
 * i końca. `inPlace` mówi, czy dopisek stoi tam, gdzie oczekuje go parser: w linii zaraz po zamknięciu
 * streszczenia, a w następnej zaczyna się wynik agenta. Zmiana układu linii w nowym CLI ma się
 * pokazać tutaj, nie dopiero w logu serwera.
 */
const AGENT_NOTES = CARRIED
  .filter((item) => tag(item.text, N.summary).startsWith(`${S.agent[0]} `)
    && tag(item.text, N.status) === CLI_SHAPES.terminalStatuses.literals.completed)
  .map((item) => ({
    note: tag(item.text, NOTE.tag),
    inPlace: item.text.includes(`</summary>\n${NOTE.tag}`) && item.text.includes(`</note>\n${NOTE.result}`),
  }));
/** Wyniki `SendMessage` — jedyne miejsce, z którego kod czyta wznowienie. */
const RESUMES = RESULTS.filter((item) => item.tool === 'SendMessage');

/*
 * Artefakty sesji. Wyniki `Artifact` sparowane z wywołaniem w obrębie pliku i notki harnessu —
 * te same miejsca, z których czyta `artifacts.ts`: wynik w `toolUseResult` obok `tool_result`, meldunek
 * we wpisie `user` z pochodzeniem `task-notification` albo w załączniku kolejki z tym pochodzeniem.
 */
const ART_RESULTS: { readonly keys: string[]; readonly values: Json }[] = ARTIFACTS.files.flatMap((name) => {
  const lines = linesOf(name, ARTIFACTS_DIR);
  const tools = new Map(lines.flatMap((entry) => blocks(entry))
    .filter((block) => block['type'] === 'tool_use').map((block) => [text(block['id']), text(block['name'])]));
  return lines.filter((entry) => blocks(entry).some((block) =>
    block['type'] === 'tool_result' && tools.get(text(block['tool_use_id'])) === 'Artifact'))
    .map((entry) => ({
      keys: Array.isArray(entry['_klucze']) ? entry['_klucze'].map(String) : [],
      values: record(entry['toolUseResult']) ?? {},
    }));
});
const ART_NOTICES: string[] = ARTIFACTS.files.flatMap((name) => linesOf(name, ARTIFACTS_DIR)).flatMap((entry) => {
  const harness = (origin: unknown): boolean => record(origin)?.['kind'] === CLI_SHAPES.notificationOrigin.literals.kind;
  if (entry['type'] === 'user' && harness(entry['origin'])) return [text(record(entry['message'])?.['content'])];
  const attachment = record(entry['attachment']);
  if (entry['type'] === 'attachment' && harness(attachment?.['origin'])) return [text(attachment?.['prompt'])];
  return [];
});
const P = CLI_SHAPES.artifactPublish.literals;
const W = CLI_SHAPES.artifactWatch.literals;
const watchEvents = ART_NOTICES.map((notice) => tag(notice, W.event));
const outputFiles = CARRIED
  .map((item) => ({ path: tag(item.text, N.outputFile), id: tag(item.text, N.taskId) }))
  .filter(({ path }) => path !== '');

/*
 * Scheduled tasks: calls paired with their results inside each file, run lines and carry attachments — the places
 * `scheduled-tasks.ts` reads. `api-request-blob` repeats calls and is not one of them.
 */
const CRON = CLI_SHAPES.scheduledTasks.literals;
interface CronResult { readonly tool: string; readonly input: Json; readonly value: Json }
const CRON_RESULTS: CronResult[] = SCHEDULED.files.flatMap((name) => {
  const lines = linesOf(name, SCHEDULED_DIR)
    .filter((entry) => entry['type'] === 'assistant' || entry['type'] === 'user');
  const calls = new Map(lines.flatMap((entry) => blocks(entry)).filter((block) => block['type'] === 'tool_use')
    .map((block) => [text(block['id']), { tool: text(block['name']), input: record(block['input']) ?? {} }]));
  return lines.flatMap((entry) => blocks(entry).filter((block) => block['type'] === 'tool_result').flatMap((block) => {
    const call = calls.get(text(block['tool_use_id']));
    const value = record(entry['toolUseResult']);
    return call === undefined || value === null ? [] : [{ ...call, value }];
  }));
});
const CRON_LINES: Json[] = SCHEDULED.files.flatMap((name) => linesOf(name, SCHEDULED_DIR));
const CRON_FIRES = CRON_LINES.filter((entry) => entry['type'] === 'system' && entry['subtype'] === CRON.fire);
const CRON_CARRIES: Json[] = CRON_LINES.flatMap((entry) => {
  const attachment = record(entry['attachment']);
  return entry['type'] === 'attachment' && attachment?.['type'] === CRON.carry ? [attachment] : [];
});
const cronCreated = CRON_RESULTS.filter((item) => item.tool === CRON.createTool);
const carriedTasks = (key: string): Json[] => CRON_CARRIES.flatMap((carry) =>
  (Array.isArray(carry[key]) ? carry[key] as unknown[] : [])
    .flatMap((item) => (record(item) === null ? [] : [item as Json])));

/**
 * Literały, które pomiar umie postawić — reguła mówi, GDZIE literał ma stać, żeby się liczył.
 * Klucz to `kształt.nazwa`, dla listy brzmień `kształt.nazwa=brzmienie`.
 */
const MEASURED: Record<string, () => boolean> = {
  'notification.open': () => CARRIED.length > 0,
  'notification.taskId': () => CARRIED.every((item) => tag(item.text, N.taskId) !== ''),
  'notification.toolUseId': () => CARRIED.some((item) => tag(item.text, N.toolUseId) !== ''),
  'notification.outputFile': () => outputFiles.length > 0,
  'notification.status': () => statuses.some((status) => status !== ''),
  // The output file the notification names: `…/<session uuid>/tasks/<task id>.output`.
  'notification.outputDir': () => outputFiles.some(({ path }) => path.split('/').at(-2) === N.outputDir),
  'notification.outputExtension': () => outputFiles.some(({ path, id }) => path.endsWith(`/${id}${N.outputExtension}`)),
  'notification.summary': () => summaries.some((summary) => summary !== ''),
  'notificationCarriers.queueType': () => carrier(C.queueType, C.queueText),
  'notificationCarriers.queueText': () => carrier(C.queueType, C.queueText),
  'notificationOrigin.kind': () => LINES.some((entry) =>
    record(entry['origin'])?.['kind'] === CLI_SHAPES.notificationOrigin.literals.kind
    && text(record(entry['message'])?.['content']).includes(MARK)),
  'terminalStatuses.completed': () => statuses.includes(CLI_SHAPES.terminalStatuses.literals.completed),
  // `resume-cli`: wyjście z CLI opcją „Exit and stop tasks” daje meldunek o komendzie subagenta.
  'terminalStatuses.killed': () => statuses.includes(CLI_SHAPES.terminalStatuses.literals.killed),
  'summaryKinds.command': () => summaries.some((summary) => summary.startsWith(S.command)),
  [`summaryKinds.agent=${S.agent[0]}`]: () => summaries.some((summary) => summary.startsWith(`${S.agent[0]} `)),
  'summaryExitCode.prefix': () => summaries.some((summary) => summary.includes(CLI_SHAPES.summaryExitCode.literals.prefix)),
  'agentNote.tag': () => AGENT_NOTES.length > 0 && AGENT_NOTES.every((item) => item.note !== ''),
  'agentNote.standby': () => AGENT_NOTES.some((item) => item.note.includes(NOTE.standby) && !item.note.includes(NOTE.ended)),
  'agentNote.ended': () => AGENT_NOTES.some((item) => item.note.includes(NOTE.ended) && !item.note.includes(NOTE.standby)),
  'agentNote.result': () => AGENT_NOTES.length > 0 && AGENT_NOTES.every((item) => item.inPlace),
  'agentResume.resumedAgentId': () => RESUMES.some((item) => text(item.values[RESUME.resumedAgentId]) !== ''),
  'agentResume.success': () => RESUMES.length > 0 && RESUMES.every((item) =>
    text(item.values[RESUME.resumedAgentId]) !== '' && item.values[RESUME.success] === true),
  'toolResult.field': () => RESULTS.some((item) => CLI_SHAPES.toolResult.literals.field in item.entry),
  'taskStart.agentId': () => RESULTS.some((item) => item.tool === TOOLS.agent && text(item.values[CLI_SHAPES.taskStart.literals.agentId]) !== ''),
  'taskStart.backgroundTaskId': () => RESULTS.some((item) => item.tool === TOOLS.bash && text(item.values[CLI_SHAPES.taskStart.literals.backgroundTaskId]) !== ''),
  'taskDescription.description': () => inputKey(TOOLS.agent, CLI_SHAPES.taskDescription.literals.description),
  'taskDescription.command': () => inputKey(TOOLS.bash, CLI_SHAPES.taskDescription.literals.command),
  'taskWho.resolvedModel': () => resultKey(TOOLS.agent, CLI_SHAPES.taskWho.literals.resolvedModel),
  'taskWho.subagentType': () => inputKey(TOOLS.agent, CLI_SHAPES.taskWho.literals.subagentType),
  'taskTools.bash': () => called(TOOLS.bash),
  'taskTools.agent': () => called(TOOLS.agent),
  // Artefakty sesji: `artifacts/measured/` (publikacje i meldunki z magazynu CLI).
  'artifactPublish.url': () => ART_RESULTS.some((item) => item.keys.includes(P.url) && text(item.values[P.url]) !== ''),
  'artifactPublish.title': () => ART_RESULTS.some((item) => item.keys.includes(P.title)),
  'artifactPublish.updated': () => ART_RESULTS.some((item) => typeof item.values[P.updated] === 'boolean'),
  'artifactPublish.createdFromType': () => ART_RESULTS.some((item) => item.values[P.createdFromType] === true),
  'artifactPublish.urlPrefix': () => ART_RESULTS.some((item) => text(item.values[P.url]).startsWith(P.urlPrefix)),
  'artifactWatch.taskType': () => ART_NOTICES.some((notice) => tag(notice, W.taskType) !== ''),
  'artifactWatch.lifecycle': () => ART_NOTICES.some((notice) => tag(notice, W.taskType) === W.lifecycle),
  'artifactWatch.notFound': () => ART_NOTICES.some((notice) => tag(notice, N.summary).includes(W.notFound)),
  'artifactWatch.event': () => watchEvents.some((event) => event !== ''),
  'artifactWatch.watchOn': () => watchEvents.some((event) => event.startsWith(`${W.watchOn} ${P.urlPrefix}`)),
  'artifactWatch.ended': () => watchEvents.some((event) => new RegExp(
    `^${literalSource(W.watchOn)} ${literalSource(P.urlPrefix)}[A-Za-z0-9]+ ${literalSource(W.ended)}(?![A-Za-z0-9])`,
  ).test(event)),
  // Scheduled tasks: `scheduled/measured/`.
  'scheduledTasks.createTool': () => cronCreated.length > 0,
  'scheduledTasks.deleteTool': () => CRON_RESULTS.some((item) =>
    item.tool === CRON.deleteTool && text(item.value[CRON.id]) !== ''),
  'scheduledTasks.listTool': () => CRON_RESULTS.some((item) =>
    item.tool === CRON.listTool && Array.isArray(item.value[CRON.jobs])),
  'scheduledTasks.fire': () => CRON_FIRES.length > 0,
  'scheduledTasks.carry': () => CRON_CARRIES.length > 0,
  'scheduledTasks.taskId': () => CRON_FIRES.length > 0 && CRON_FIRES.every((entry) => text(entry[CRON.taskId]) !== ''),
  'scheduledTasks.taskKind': () => CRON_FIRES.some((entry) => entry[CRON.taskKind] === CRON.loop),
  'scheduledTasks.cronKind': () => CRON_FIRES.some((entry) => entry[CRON.cronKind] === CRON.loop),
  'scheduledTasks.loop': () => CRON_FIRES.some((entry) =>
    entry[CRON.taskKind] === CRON.loop && entry[CRON.cronKind] === CRON.loop),
  'scheduledTasks.id': () => cronCreated.length > 0 && cronCreated.every((item) => text(item.value[CRON.id]) !== ''),
  'scheduledTasks.cron': () => cronCreated.some((item) => text(item.input[CRON.cron]) !== ''),
  'scheduledTasks.prompt': () => cronCreated.some((item) => text(item.input[CRON.prompt]) !== ''),
  'scheduledTasks.recurring': () => cronCreated.length > 0
    && cronCreated.every((item) => typeof item.value[CRON.recurring] === 'boolean'),
  'scheduledTasks.nextFireAt': () => cronCreated.some((item) => typeof item.value[CRON.nextFireAt] === 'number'),
  'scheduledTasks.jobs': () => CRON_RESULTS.some((item) =>
    item.tool === CRON.listTool && Array.isArray(item.value[CRON.jobs])),
  'scheduledTasks.tasks': () => CRON_CARRIES.length > 0
    && CRON_CARRIES.every((carry) => Array.isArray(carry[CRON.tasks])),
  'scheduledTasks.otherArmed': () => carriedTasks(CRON.otherArmed).length > 0,
  'scheduledTasks.ended': () => CRON_CARRIES.some((carry) => {
    const ended = carry[CRON.ended];
    return Array.isArray(ended) && ended.length > 0;
  }),
  'scheduledTasks.createdAt': () => carriedTasks(CRON.tasks).some((task) => typeof task[CRON.createdAt] === 'number'),
};

/**
 * Literały poza pomiarem — lista ZAMKNIĘTA, z powodem. Każdy musi stać w próbkach {@link SAMPLES}.
 */
const OUTSIDE: Record<string, string> = {
  'notificationCarriers.attachmentType': 'meldunek wchłonięty W TURZE: scenariusze dostarczają meldunki bezczynnemu agentowi',
  'notificationCarriers.attachmentField': 'jak wyżej',
  'notificationCarriers.queuedCommand': 'jak wyżej',
  'notificationCarriers.queuedText': 'jak wyżej',
  'agentNote.relayed': 'scenariusze nie czytają artefaktów; układ zmierzony ręcznie na pliku żywej sesji (2.1.296, 2026-10-10)',
  'queuedPrompt.mode': 'prompt człowieka wchłonięty W TURZE: scenariusze nie piszą do agenta, gdy pracuje; zmierzone ręcznie 2026-10-10',
  'queuedPrompt.prompt': 'jak wyżej',
  'queuedPrompt.origin': 'jak wyżej',
  'queuedPrompt.kind': 'jak wyżej',
  'queuedPrompt.human': 'jak wyżej',
  'terminalStatuses.failed': 'scenariusze nie kończą zadania błędem',
  'terminalStatuses.stopped': 'żaden scenariusz nie daje tego statusu (zatrzymanie przy wyjściu z CLI melduje `killed`)',
  'unknownFate.sentence': 'sierota: `resume-cli` (wyjście opcją „Exit and stop tasks” i `--resume`) jej nie daje — CLI 2.1.296 pisze `killed` o komendzie, a o agencie nic',
  'summaryKinds.orphanStart': 'jak wyżej',
  'summaryKinds.orphanShells': 'jak wyżej',
  'summaryKinds.monitorEvent': 'narzędzia `Monitor` scenariusze nie wołają',
  'summaryKinds.monitorEnd': 'jak wyżej',
  [`summaryKinds.workflow=${S.workflow[0]}`]: 'workflow poza scenariuszami',
  [`summaryKinds.workflow=${S.workflow[1]}`]: 'workflow poza scenariuszami',
  [`summaryKinds.agent=${S.agent[1]}`]: 'brzmienie ze starszych wersji CLI',
  [`summaryKinds.backgroundAgent=${S.backgroundAgent[0]}`]: 'brzmienie ze starszych wersji CLI',
  [`summaryKinds.backgroundAgent=${S.backgroundAgent[1]}`]: 'brzmienie ze starszych wersji CLI',
  'taskStart.taskId': 'workflow poza scenariuszami',
  'taskStart.taskType': 'workflow poza scenariuszami',
  'taskDescription.workflowName': 'workflow poza scenariuszami',
  'taskWho.summary': 'workflow poza scenariuszami',
  'taskWho.until': 'narzędzia `Monitor` scenariusze nie wołają',
  'workflowRun.runId': 'workflow poza scenariuszami',
  'skillFork.tool': '`Skill` w tle poza scenariuszami',
  'skillFork.skill': 'jak wyżej',
  'skillFork.args': 'jak wyżej',
  'skillFork.commandName': 'jak wyżej',
  'foregroundEnd.status': 'fork skilla i subagent na pierwszym planie poza scenariuszami; zmierzone ręcznie 2026-10-23 (2.1.309)',
  'foregroundEnd.forked': 'jak wyżej',
  'foregroundEnd.background': 'jak wyżej',
  'taskTools.task': 'starsza nazwa narzędzia `Agent`',
  'taskTools.workflow': 'workflow poza scenariuszami',
  'monitorTool.tool': 'narzędzia `Monitor` scenariusze nie wołają',
  'monitorTool.timeout': 'jak wyżej; pole zmierzone ręcznie na pliku subagenta żywej sesji (2.1.296, 2026-10-10)',
  'monitorStart.timeoutMs': 'narzędzia `Monitor` scenariusze nie wołają; klucze wyniku zmierzone ręcznie na plikach rozmów (2.1.319)',
  'monitorStart.persistent': 'jak wyżej',
  'subagentStopHook.type': 'the scenarios run without a `SubagentStop` hook; measured by hand on session files (2.1.330)',
  'subagentStopHook.event': 'as above',
  'subagentStopHook.stop': 'as above',
  'requestBlob.type': 'the scenario fixtures carry no request copies; measured by hand on session files (2.1.330)',
  'taskStop.taskId': '`TaskStop` poza scenariuszami',
  'taskStop.message': 'jak wyżej',
  'taskStop.messagePrefix': 'jak wyżej',
  'taskOutput.retrievalStatus': 'narzędzia `TaskOutput` nie ma w CLI 2.1.296 (pomiar 2026-10-10: `ToolSearch` bez trafień)',
  'taskOutput.task': 'jak wyżej',
  'taskOutput.taskId': 'jak wyżej',
  'taskOutput.status': 'jak wyżej',
};

/**
 * Literały bez ŻADNEJ próbki: ani w pomiarze, ani w testach — lista ZAMKNIĘTA. To dług rejestru,
 * nie zwolnienie: nikt nie ma dowodu, że CLI tak pisze. Nie dopisujemy próbki „żeby było zielono";
 * wpis znika stąd, gdy znajdzie się prawdziwy meldunek albo literał wyjdzie z rejestru.
 */
const NO_SAMPLE: Record<string, string> = {
  [`summaryKinds.backgroundAgent=${S.backgroundAgent[0]}`]:
    'brzmienie z wielką literą nie stoi w żadnym teście ani fixture (stan 2026-10-10)',
};

/** Testy z próbkami wpisów CLI pisanymi w kodzie — jedyne pokrycie literałów spoza pomiaru. */
const SAMPLES = [
  'herdr-jsonl-tasks.test.ts', 'harness-notices.test.ts', 'herdr-jsonl-follow.test.ts',
  'herdr-agent-file.test.ts', 'herdr-agent-file-stop-hook.test.ts',
]
  .map((name) => readFileSync(join(import.meta.dirname, name), 'utf8')).join('\n');

const SHAPES = Object.entries(CLI_SHAPES) as [string, CliShape][];
/** Każdy literał rejestru pod nazwą `kształt.klucz` (lista brzmień: `kształt.klucz=brzmienie`). */
const LITERALS = SHAPES.flatMap(([shape, entry]) => Object.entries(entry.literals).flatMap(([key, value]) =>
  typeof value === 'string'
    ? [{ shape, name: `${shape}.${key}`, text: value }]
    : value.map((wording) => ({ shape, name: `${shape}.${key}=${wording}`, text: wording }))));

describe('rejestr kształtów CLI zadań w tle: pokrycie fixture’ami', () => {
  it('czyta zmierzone fixture’y (inaczej cały test byłby pusty)', () => {
    for (const measured of [TASKS, ARTIFACTS, SCHEDULED]) {
      expect(measured.files.length, measured.dir).toBeGreaterThan(0);
      // Archiwum nie wchodzi do pokrycia, ale każdy plik bieżący ma w nim bliźniaka.
      for (const name of measured.files) {
        expect(name, name).not.toMatch(VERSIONED);
        expect(measured.currentVersions(name.replace(/\.jsonl$/, '')).length, name).toBeGreaterThan(0);
      }
    }
    expect(LINES.length).toBeGreaterThan(20);
    expect(CARRIED.length).toBeGreaterThan(5);
    expect(RESULTS.length).toBeGreaterThan(2);
    expect(ART_RESULTS.length).toBeGreaterThan(5);
    expect(ART_NOTICES.length).toBeGreaterThan(1);
    expect(CRON_RESULTS.length).toBeGreaterThan(10);
  });

  it('każdy literał jest na dokładnie jednej liście: zmierzony albo poza pomiarem', () => {
    const names = LITERALS.map((literal) => literal.name).sort();
    expect([...Object.keys(MEASURED), ...Object.keys(OUTSIDE)].sort()).toEqual(names);
  });

  it('literał z listy zmierzonych stoi w fixture tam, skąd czyta go kod', () => {
    const missing = Object.entries(MEASURED).filter(([, found]) => !found()).map(([name]) => name);
    expect(missing, 'odśwież pomiar zadań w tle (`docs/background-tasks.md`, „After a Claude Code update”) albo popraw '
      + 'rejestr').toEqual([]);
  });

  it('literał spoza pomiaru stoi w próbce istniejącego testu i ma powód', () => {
    const outside = LITERALS.filter((item) => item.name in OUTSIDE);
    for (const literal of outside) expect((OUTSIDE[literal.name] ?? '').length, literal.name).toBeGreaterThan(5);
    // Wszystkie braki naraz: test stający na pierwszym chowa następne.
    const withoutSample = outside.filter((literal) => !SAMPLES.includes(literal.text)).map((literal) => literal.name);
    expect(withoutSample.sort(), 'literał rejestru bez żadnej próbki w testach').toEqual(Object.keys(NO_SAMPLE).sort());
    for (const why of Object.values(NO_SAMPLE)) expect(why.length).toBeGreaterThan(10);
  });

  it('wpis pokryty pomiarem w całości niesie wersję CLI BIEŻĄCYCH fixture’ów i datę', () => {
    // Wersja jest „bieżąca", gdy jej archiwum równa się plikowi bieżącemu w KAŻDYM scenariuszu katalogu:
    // po zmianie kształtu stara wersja wypada i wpis trzeba potwierdzić od nowa.
    const currentOf = (measured: MeasuredDir): string[] => {
      const perScenario = measured.files.map((name) => measured.currentVersions(name.replace(/\.jsonl$/, '')));
      return (perScenario[0] ?? []).filter((version) => perScenario.every((list) => list.includes(version)));
    };
    const versions = { tasks: currentOf(TASKS), artifacts: currentOf(ARTIFACTS), scheduled: currentOf(SCHEDULED) };
    expect(versions.tasks.length, 'żadna wersja CLI nie pokrywa wszystkich bieżących fixture’ów zadań').toBeGreaterThan(0);
    expect(versions.artifacts.length, 'żadna wersja CLI nie pokrywa fixture’ów artefaktów').toBeGreaterThan(0);
    expect(versions.scheduled.length, 'no CLI version covers the scheduled task fixtures').toBeGreaterThan(0);
    for (const [shape, entry] of SHAPES) {
      const own = LITERALS.filter((literal) => literal.shape === shape);
      if (!own.every((literal) => literal.name in MEASURED)) continue;
      const current = ARTIFACT_SHAPES.includes(shape) ? versions.artifacts
        : SCHEDULED_SHAPES.includes(shape) ? versions.scheduled : versions.tasks;
      expect(current, `${shape}: wersja „${entry.cli}" nie jest wersją bieżących fixture’ów`).toContain(entry.cli);
    }
  });
});
