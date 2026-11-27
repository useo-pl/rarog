/**
 * Rejestr kształtów CLI zadań w tle — JEDYNE miejsce, w którym stoją słowa Claude Code, po
 * których Rarog poznaje zadanie w tle albo meldunek o nim. Także artefakt sesji
 * (`artifactPublish`, `artifactWatch`): jego meldunek jedzie tym samym nośnikiem co meldunek
 * zadania, a drugi rejestr dla jednego nośnika rozjechałby się z tym przy pierwszej zmianie CLI.
 *
 * Wzór: `SCREEN_SIGNATURES` (`herdr/dialogs/screen/signatures.ts`). Wartości są tu, a moduły
 * katalogu biorą je stąd — rejestr nie jest opisem kodu, tylko kodem. Po aktualizacji Claude Code
 * pytanie „co u nas zależy od formatu CLI" ma jedną odpowiedź: ten plik.
 *
 * Podział ról: tu stoją SŁOWA (literały), a GRAMATYKA zostaje w modułach, które je czytają —
 * `notification.ts` wie, że znacznik ma zamknięcie, `notice.ts`, że rodzaj stoi na początku
 * streszczenia, `reducer.ts`, które pole wyniku narzędzia znaczy start.
 *
 * `cli` names the CLI version of the measurement the shape comes from; entries moved here from the comments of
 * `reducer.ts` and `notice.ts` without a version carry {@link UNKNOWN}. Every NEW entry has a version, because without
 * it nobody knows what to refresh. The version from the script measurement (`docs/background-tasks.md`, „After a
 * Claude Code update”) goes only to an entry whose EVERY literal stands in a measured fixture, which
 * `herdr-background-fixtures.test.ts` checks.
 *
 * Poza rejestrem, celowo:
 * - ogólny format wpisu transkryptu (`type`, `message.content`, bloki `tool_use`/`tool_result`,
 *   `tool_use_id`, `timestamp`, `isSidechain`) — wspólny z `herdr/jsonl-pending.ts`
 *   i `transcript-import.ts`, nie jest wiedzą o zadaniach w tle;
 * - interpunkcja meldunku: nazwa zadania stoi w pierwszym cudzysłowie streszczenia
 *   (`notification.ts`), a cudzysłów nie jest słowem, którego da się pilnować;
 * - kształt identyfikatorów (`wf_<id>`, id agenta) — strażniki ścieżek w `satellite.ts`;
 * - pliki przebiegu workflow (journal, skrypt, rama harnessu) — przy swoich pomiarach
 *   w `workflow-run.ts`.
 *
 * Strażnik (`server/test/herdr-background-boundary.test.ts`): literał stąd nie ma prawa stać
 * w kodzie `server/src/**` poza tym plikiem. Drugi parser meldunku albo drugie czytanie
 * `toolUseResult` zaczyna się właśnie od przepisania literału.
 */

/** Wartość `cli`, której komentarze sprzed rejestru nie podawały. Nie zgadujemy. */
export const UNKNOWN = 'nieznana';

/** Jeden zmierzony kształt: zestaw literałów, które stoją w pliku razem. */
export interface CliShape {
  /** Co ten kształt rozpoznaje — jedno zdanie. */
  readonly what: string;
  /** Literały pod nazwami, których używa kod; lista to równoprawne brzmienia tego samego. */
  readonly literals: Readonly<Record<string, string | readonly string[]>>;
  /** Wersja Claude Code, na której kształt zmierzono, albo {@link UNKNOWN}. */
  readonly cli: string;
  /**
   * Literały (klucze z `literals`), których strażnik grepowy ŚWIADOMIE nie pilnuje, z powodem.
   * Słowo pospolite (`status`, `message`, `Bash`) stoi w dziesiątkach plików w innym znaczeniu,
   * więc jego obecność niczego nie dowodzi. Test trzyma ZAMKNIĘTĄ listę takich literałów.
   */
  readonly common?: Readonly<Record<string, string>>;
}

const ORDINARY_WORD = 'słowo pospolite: pole o tej nazwie mają też inne wpisy i inne moduły';
const TOOL_NAME = 'nazwa narzędzia CLI: zna ją też parser ekranu, wiersz aktywności i dane demo';

export const CLI_SHAPES = {
  notification: {
    what: 'meldunek o końcu albo zdarzeniu zadania: tekst w znacznikach, ten sam w kilku wpisach naraz',
    literals: {
      open: '<task-notification>',
      taskId: '<task-id>',
      status: '<status>',
      summary: '<summary>',
    },
    cli: '2.1.296',
  },
  notificationCarriers: {
    what: 'wpisy niosące meldunek poza wpisem `user` z gołym napisem: kolejka promptów i załącznik',
    literals: {
      queueType: 'queue-operation',
      queueText: 'content',
      attachmentType: 'attachment',
      attachmentField: 'attachment',
      queuedCommand: 'queued_command',
      queuedText: 'prompt',
    },
    cli: UNKNOWN,
    common: {
      queueText: ORDINARY_WORD,
      attachmentType: ORDINARY_WORD,
      attachmentField: ORDINARY_WORD,
      queuedText: ORDINARY_WORD,
    },
  },
  /**
   * Tym samym załącznikiem kolejki co meldunek jedzie prompt, który przyszedł W TRAKCIE tury: CLI
   * wchłania go w tę turę i nie zapisuje zwykłego wpisu `user`. Zmierzone ręcznie na
   * plikach sesji projektu (CLI 2.1.267–2.1.296, 112 promptów człowieka i 40 wiadomości od
   * subagentów z pochodzeniem `peer`). Czyta `queued-prompt.ts`.
   */
  queuedPrompt: {
    what: 'załącznik kolejki z promptem człowieka wchłoniętym w trwającą turę: tryb i pochodzenie',
    literals: { mode: 'commandMode', prompt: 'prompt', origin: 'origin', kind: 'kind', human: 'human' },
    cli: '2.1.296',
    common: { prompt: ORDINARY_WORD, origin: ORDINARY_WORD, kind: ORDINARY_WORD, human: ORDINARY_WORD },
  },
  notificationOrigin: {
    what: 'wartość `origin.kind` wpisu, którą CLI znakuje notkę o zadaniu w tle (bramka notki)',
    literals: { kind: 'task-notification' },
    cli: '2.1.296',
  },
  terminalStatuses: {
    what: 'statusy, po których zadanie na pewno nie żyje — w `<status>` meldunku i w `TaskOutput`',
    literals: {
      completed: 'completed',
      failed: 'failed',
      killed: 'killed',
      stopped: 'stopped',
    },
    cli: UNKNOWN,
    common: {
      completed: ORDINARY_WORD,
      failed: ORDINARY_WORD,
      killed: ORDINARY_WORD,
      stopped: ORDINARY_WORD,
    },
  },
  unknownFate: {
    what: 'streszczenie sieroty: po wznowieniu procesu CLI przyznaje, że nie wie, co stało się z zadaniem',
    literals: { sentence: 'No completion record was found' },
    cli: UNKNOWN,
  },
  summaryKinds: {
    what: 'początek `<summary>` mówi, jakiego rodzaju zadanie się melduje (rodzaj notki)',
    literals: {
      orphanStart: 'No completion record',
      orphanShells: 'background shell command task(s)',
      monitorEvent: 'Monitor event',
      monitorEnd: 'Monitor',
      command: 'Background command',
      workflow: ['Dynamic workflow', 'Background workflow'],
      agent: ['Agent', 'agent'],
      backgroundAgent: ['Background Agent', 'Background agent'],
    },
    cli: UNKNOWN,
    common: {
      monitorEnd: 'to samo słowo jest nazwą narzędzia `Monitor`',
      agent: 'słowo „agent” stoi w nazwach i tekstach całego serwera',
    },
  },
  summaryExitCode: {
    what: 'kod wyjścia komendy w streszczeniu: `exit code N`',
    literals: { prefix: 'exit code ' },
    cli: '2.1.296',
  },
  /*
   * Frazy kluczowe, nie całe zdania: CLI wolno przeredagować resztę dopisku, a rozpoznanie ma to
   * przeżyć. Pełne brzmienia (znak w znak te same na 2.1.295 i 2.1.296) stoją w fixture'ach
   * `postoj.jsonl` i `wznowienie.jsonl`. Trzecie znane brzmienie `<note>` należy do KOMEND po
   * timeoucie („…start it again with `run_in_background`…") i celowo go tu nie ma: nie mówi nic
   * o agencie, a rozpoznanie dopisku dotyczy wyłącznie meldunku agenta (`notification.ts`).
   */
  agentNote: {
    what: 'dopisek `<note>` meldunku o zatrzymaniu agenta: postój (jego własna praca w tle jeszcze leci) albo koniec',
    literals: {
      tag: '<note>',
      standby: 'background work of its own still running',
      ended: 'no live background children',
      // Zaraz po dopisku stoi wynik agenta (albo koniec meldunku); `<note>` w treści wyniku to tekst modelu.
      result: '<result>',
      // Meldunek agenta, który czytał treść artefaktu, ma PRZED wynikiem jeszcze ten znacznik i linię
      // ostrzeżenia (zmierzone ręcznie na pliku żywej sesji, CLI 2.1.296).
      relayed: '<artifact-content-authored-by-others/>',
    },
    cli: '2.1.296',
  },
  toolResult: {
    what: 'pole wpisu `user` z wynikiem narzędzia; jego kształt rozróżnia start, zatrzymanie i odbiór wyniku',
    literals: { field: 'toolUseResult' },
    cli: '2.1.296',
  },
  taskStart: {
    what: 'start zadania: `agentId` → subagent, `taskId` z `taskType` → workflow, `backgroundTaskId` → komenda',
    literals: {
      agentId: 'agentId',
      taskId: 'taskId',
      taskType: 'taskType',
      backgroundTaskId: 'backgroundTaskId',
    },
    cli: UNKNOWN,
    common: { agentId: 'to samo słowo jest polem journala przebiegu (`workflow-run.ts`)' },
  },
  agentResume: {
    what: 'wznowienie subagenta: wynik `SendMessage` w kształcie `{message, pin, resumedAgentId, success: true}`',
    literals: {
      resumedAgentId: 'resumedAgentId',
      success: 'success',
    },
    cli: '2.1.296',
    common: { success: ORDINARY_WORD },
  },
  taskDescription: {
    what: 'opis zadania: z wyniku startu (`description`, `workflowName`) albo z wywołania narzędzia',
    literals: {
      description: 'description',
      workflowName: 'workflowName',
      command: 'command',
    },
    cli: UNKNOWN,
    common: { description: ORDINARY_WORD, command: ORDINARY_WORD },
  },
  /**
   * `until`: warunek monitora w wywołaniu ze starszych plików (wersja CLI nieznana).
   * Dzisiejsze wejście `Monitor` go nie ma: docs `agent-sdk/typescript.md`, „Monitor”
   * podają `{description, timeout_ms, command?, ws?}`, a fixture'y
   * `tasks/incydent-gotowe-po-postoju-2.1.301/subagents/` niosą `{timeout_ms, command, description}`.
   */
  taskWho: {
    what: 'kto i czym wykonuje zadanie: model i streszczenie w wyniku, podtyp i warunek monitora w wywołaniu',
    literals: {
      resolvedModel: 'resolvedModel',
      summary: 'summary',
      subagentType: 'subagent_type',
      until: 'until',
    },
    cli: UNKNOWN,
    common: { summary: ORDINARY_WORD, until: ORDINARY_WORD },
  },
  workflowRun: {
    what: 'identyfikator przebiegu workflow w wyniku startu — klucz katalogu przebiegu; wznowienie go powtarza',
    literals: { runId: 'runId' },
    cli: UNKNOWN,
  },
  skillFork: {
    what: '`Skill` puszczony w tle: wejście `{skill, args}`, wynik z `agentId` i `commandName`, bez opisu',
    literals: {
      tool: 'Skill',
      skill: 'skill',
      args: 'args',
      commandName: 'commandName',
    },
    cli: '2.1.258',
    common: { tool: TOOL_NAME, skill: ORDINARY_WORD, args: ORDINARY_WORD },
  },
  /**
   * Wynik z `agentId`, który NIE jest startem w tle: narzędzie skończyło pracę na pierwszym planie i wynik niesie
   * już jej koniec. Zmierzone ręcznie na wynikach z `agentId` w plikach głównych tego konta (CLI
   * 2.1.216–2.1.309): fork `Skill` na pierwszym planie `{agentId, commandName, result, status: "forked", success}`
   * (1 wynik, 2.1.309) i subagent na pierwszym planie `{agentId, content, status: "completed", …}` (7 wyników).
   * Start w tle ma `status: "async_launched"` (958) albo `"forked"` z `background: true` (2). Kształtu forka
   * przerwanego albo nieudanego nie zmierzono.
   */
  foregroundEnd: {
    what: 'wynik z `agentId`, który niesie już koniec: fork skilla bez `background: true` albo status końcowy',
    literals: {
      status: 'status',
      forked: 'forked',
      background: 'background',
    },
    cli: '2.1.309',
    common: {
      status: ORDINARY_WORD,
      background: 'to samo słowo jest nazwą slash-komendy `/background` (`commands/registry.ts`)',
    },
  },
  taskTools: {
    what: 'narzędzia, po których może powstać zadanie w tle (razem z `Skill` i `Monitor`)',
    literals: {
      bash: 'Bash',
      agent: 'Agent',
      task: 'Task',
      workflow: 'Workflow',
    },
    cli: UNKNOWN,
    common: { bash: TOOL_NAME, agent: TOOL_NAME, task: TOOL_NAME, workflow: TOOL_NAME },
  },
  /**
   * `timeout`: pole WYWOŁANIA z terminem monitora w ms. Zmierzone ręcznie na pliku
   * subagenta żywej sesji (CLI 2.1.296): wywołanie `{description, timeout_ms: 1800000, command}`,
   * wynik `{taskId, timeoutMs, persistent}` bez `backgroundTaskId` i bez `taskType`, wygaśnięcie
   * jako zdarzenie bez `<status>` w kolejce pliku głównego. Termin domyślny 5 minut, najwyżej 30 minut
   * (docs `agent-sdk/typescript.md`, „Monitor”: 300000 ms i skuteczny sufit 1800000). `timeout` czyta
   * tylko czytnik pliku subagenta (`agent-file.ts`), żeby wiedzieć, do kiedy agent może czekać na
   * monitor; listę zadań zasila wynik (`monitorStart`).
   */
  monitorTool: {
    what: 'narzędzie `Monitor`: rodzaj poznajemy po nazwie, termin po polu wywołania',
    literals: { tool: 'Monitor', timeout: 'timeout_ms' },
    cli: '2.1.296',
    common: { tool: TOOL_NAME, timeout: 'parametr o tej nazwie mają też żądania do herdr (`drivers/herdr`)' },
  },
  /**
   * The record of a `SubagentStop` hook in the subagent file: an `attachment` of type `hook_success` with the hook's
   * event in `hookEvent`. With such a hook configured the CLI writes it at every stop of the agent (standby and the
   * end after `SubagentHandback`), after the agent's last entry, so it is often the file's last line. Measured by hand
   * on the session files of this account (CLI 2.1.325–2.1.330): 699 records, none with a `timestamp` earlier than the
   * entry before it, 374 of the 386 subagent files that end with an attachment end with it. Other hook records do not
   * qualify: a `PostToolUse` record of parallel calls is earlier than the entry before it in 29 363 of 46 800.
   * Read only by the subagent file reader (`agent-file.ts`), for the proof that the file is known to its last line.
   */
  subagentStopHook: {
    what: 'record of the `SubagentStop` hook in the subagent file: written at the agent stop, at its own time',
    literals: { type: 'hook_success', event: 'hookEvent', stop: 'SubagentStop' },
    cli: '2.1.330',
  },
  /**
   * A copy of one message of an API request in the subagent file: an entry of type `api-request-blob` with `hash`
   * and `message`, without `timestamp`. Its tool calls repeat calls that already stand in ordinary entries of the
   * same file. Measured by hand on the session files of this account (CLI 2.1.330): 121 199 such entries in 2 432 of
   * 2 554 subagent files, none with `timestamp`, and each of their 85 738 tool calls has the same `id` in an ordinary
   * entry. Read only by the subagent file reader (`agent-file.ts`), which skips it when it looks for other own tasks.
   */
  requestBlob: {
    what: 'copy of an API request message in the subagent file: no time, its tool calls repeat earlier entries',
    literals: { type: 'api-request-blob' },
    cli: '2.1.330',
  },
  /**
   * Start monitora agenta głównego: wynik `Monitor` `{persistent, taskId, timeoutMs}` obok bloku
   * `tool_result`, bez `backgroundTaskId` i bez `taskType`. Identyfikator to `taskId` z wpisu `taskStart`, tu
   * stoją pola, które odróżniają ten wynik od startu workflow i niosą termin. Zmierzone ręcznie na plikach
   * rozmów tego konta, same klucze (CLI 2.1.319): 35 z 37 wyników `Monitor` ma ten kształt, `timeoutMs`
   * zawsze liczbą, `persistent` zawsze `false`; pozostałe dwa to tekst błędu. Meldunki o monitorze niosą ten
   * sam identyfikator w `<task-id>`.
   */
  monitorStart: {
    what: 'start monitora: wynik `Monitor` z `taskId`, terminem `timeoutMs` i znacznikiem `persistent`',
    literals: { timeoutMs: 'timeoutMs', persistent: 'persistent' },
    cli: '2.1.319',
  },
  /**
   * Na CLI 2.1.319 (pomiar ręczny na plikach rozmów tego konta, same klucze i prefiks zdania) wynik
   * ma kształt `{command, message, task_id, task_type}`, a `message` zaczyna się od prefiksu w 97 z 97 wyników,
   * także w 4 zatrzymaniach monitora (`task_type: local_bash`). Po zatrzymaniu monitora meldunek nie przychodzi.
   */
  taskStop: {
    what: 'jawne zatrzymanie (`TaskStop`): wynik `{message: "Successfully stopped task: …", task_id}`',
    literals: {
      taskId: 'task_id',
      message: 'message',
      messagePrefix: 'Successfully stopped task',
    },
    cli: '2.1.319',
    common: { message: ORDINARY_WORD },
  },
  /**
   * Narzędzie `TaskOutput` usunięto w CLI 2.1.277 (docs `agent-sdk/typescript.md`, „TaskOutput”; changelog
   * 2.1.277), a fixture `tasks/measured/taskoutput-w-postoju-2.1.296.jsonl` notuje jego brak. Kształt zostaje
   * dla plików rozmów sprzed tej wersji (wersja CLI nieznana).
   */
  taskOutput: {
    what: 'wynik odebrany przez `TaskOutput`: `{retrieval_status, task: {task_id, status}}`, bez meldunku',
    literals: {
      retrievalStatus: 'retrieval_status',
      task: 'task',
      taskId: 'task_id',
      status: 'status',
    },
    cli: UNKNOWN,
    common: { task: ORDINARY_WORD, status: ORDINARY_WORD },
  },
  /**
   * Lista artefaktów sesji (`artifacts.ts`, opis: `docs/artifacts.md`). Wynik publikacji narzędziem
   * `Artifact` stoi w `toolUseResult` obok bloku `tool_result`, jak start zadania w tle. Nowa strona
   * i ponowna publikacja niosą `updated` (boolean), utworzenie z typu (`type_url`, od CLI 2.1.293)
   * `created_from_type: true` bez `updated`. Pierwszy zmierzony wynik: CLI 2.1.278. Pomiar:
   * odczyt magazynu CLI bez żywej sesji (`docs/artifacts.md`, „After a Claude Code update”), fixture
   * `artifacts/measured/publikacje.jsonl`.
   */
  artifactPublish: {
    what: 'wynik publikacji artefaktu (`Artifact`): adres strony, tytuł i znacznik nowej, ponownej albo z typu',
    literals: {
      url: 'url',
      title: 'title',
      updated: 'updated',
      createdFromType: 'created_from_type',
      // Jedyna forma adresu w wynikach (gramatykę `<prefiks><id z liter i cyfr>` trzyma `notification.ts`).
      urlPrefix: 'https://claude.ai/artifact/',
    },
    cli: '2.1.301',
    common: { url: ORDINARY_WORD, title: ORDINARY_WORD },
  },
  /**
   * Meldunek CLI o końcu obserwacji artefaktu: notka harnessu (`origin.kind: task-notification`) bez
   * `<task-id>` i `<status>`, z `<task-type>` i zdarzeniem `Watch on <adres> ended — …`. Usunięcie artefaktu
   * na claude.ai to wariant `(artifact not found)`; pozostałe zmierzone: `(public, outside your organization)`
   * i „the signed-in account changed” (bez adresu). Fixture `artifacts/measured/meldunki.jsonl`.
   */
  artifactWatch: {
    what: 'meldunek o końcu obserwacji artefaktu: rodzaj zadania, wariant „nie ma takiego artefaktu” i adres w zdarzeniu',
    literals: {
      taskType: '<task-type>',
      lifecycle: 'artifact-watch-lifecycle',
      notFound: '(artifact not found)',
      event: '<event>',
      watchOn: 'Watch on',
      ended: 'ended',
    },
    cli: '2.1.301',
    common: { ended: 'słowo pospolite: to samo słowo jest wartością dopisku meldunku agenta (`notification.ts`)' },
  },
  /**
   * The session's scheduled tasks (`scheduled-tasks.ts`). `CronCreate` input `{cron, prompt, recurring}` (`recurring`
   * may be the string `"true"`), result `{id, humanSchedule, recurring, durable, nextFireAt}` with a boolean
   * `recurring` and `nextFireAt` in epoch ms; `CronDelete` result `{id}`; `CronList` result `{jobs: [...]}`, a full
   * snapshot whose jobs carry `recurring` only when it is `true` and which also lists a pending `ScheduleWakeup`
   * without any marker. A run is a `system` entry with the `scheduled_task_fire` subtype and `{taskId, cron, prompt}`;
   * a `ScheduleWakeup` run adds `taskKind` and `cronKind` equal to `loop`. The `session_cron_carry` attachment holds
   * `tasks` (after `/compact`), `otherArmed` (first entry of the file `/clear` opens) or `ended` (exit that stopped the
   * tasks), each task `{id, cron, prompt, createdAt, recurring}`. Fixtures: `scheduled/measured/`.
   */
  scheduledTasks: {
    what: 'scheduled task calls (`CronCreate`, `CronDelete`, `CronList`), their run line and the carry attachment',
    literals: {
      createTool: 'CronCreate',
      deleteTool: 'CronDelete',
      listTool: 'CronList',
      fire: 'scheduled_task_fire',
      carry: 'session_cron_carry',
      taskId: 'taskId',
      taskKind: 'taskKind',
      cronKind: 'cronKind',
      loop: 'loop',
      id: 'id',
      cron: 'cron',
      prompt: 'prompt',
      recurring: 'recurring',
      nextFireAt: 'nextFireAt',
      jobs: 'jobs',
      tasks: 'tasks',
      otherArmed: 'otherArmed',
      ended: 'ended',
      createdAt: 'createdAt',
    },
    cli: '2.1.329',
    common: {
      loop: 'ordinary word: the same word is the `/loop` slash command (`commands/registry.ts`)',
      id: 'ordinary word: fields with this name stand in entries and modules all over the server',
      prompt: 'ordinary word: fields with this name stand in entries and modules all over the server',
      tasks: 'ordinary word: the driver event of the task list has the same name',
      ended: 'ordinary word: the same word is a value of the agent notification note (`notification.ts`)',
      createdAt: 'ordinary word: device and note stores have a field with this name',
    },
  },
  /**
   * The entry that links a pull request to the conversation (`pull-requests.ts`): a top-level entry
   * `{type, sessionId, prNumber, prUrl, prRepository, timestamp}` in the main conversation file, seen on CLI
   * 2.1.296–2.1.3xx and never in a subagent file. No conversation in the Rarog workspace has one, so no measured fixture
   * holds it: the literals stand on the list outside the measurement in `herdr-background-fixtures.test.ts`.
   */
  prLink: {
    what: 'the entry that links a pull request to the conversation: its type, PR URL, number and repository',
    literals: {
      type: 'pr-link',
      url: 'prUrl',
      number: 'prNumber',
      repository: 'prRepository',
    },
    cli: '2.1.296',
  },
} as const satisfies Record<string, CliShape>;

/**
 * Literał jako fragment wyrażenia regularnego — bez znaczenia specjalnego żadnego znaku.
 *
 * Moduły katalogu składają wzorce Z literałów rejestru (znacznik z zamknięciem, początek
 * streszczenia jako całe słowo), więc ucieczka znaków stoi raz, przy rejestrze.
 */
export function literalSource(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
