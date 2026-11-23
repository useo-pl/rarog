/**
 * Rejestr literałów Claude Code o slash-komendach — JEDYNE miejsce w `server/src/**`, w którym stoją
 * słowa CLI o komendach: nazwy komend i skilli z allow-listą, aliasy, słowa wyjścia, układ skilli
 * i pluginów na dysku oraz znaczniki, którymi CLI zapisuje komendę w pliku rozmowy. Opis rejestru, źródła
 * prawdy i procedura po aktualizacji CLI: `docs/slash-commands.md`.
 *
 * Każdy fakt pochodzi z dokumentacji albo udokumentowanego interfejsu (klasa a) albo z obserwacji działającego
 * programu (klasa b), z wersją i datą swojego dowodu (`docs/distribution.md`, „What the repo knows about Claude Code”).
 * Pliki dowodów wskazuje {@link EVIDENCE}; zgodność wartości i metadanych sprawdza
 * `server/test/herdr-commands-boundary.test.ts`, a po aktualizacji CLI pomiar
 * (`docs/slash-commands.md`, „After a Claude Code update”).
 *
 * Wzór: `herdr/background/cli-shapes.ts`. Tu stoją SŁOWA (literały), a GRAMATYKA zostaje w modułach,
 * które je czytają: `guard.ts` wie, że komendę poznaje się po pierwszym tokenie, `transcript-import.ts`,
 * że znacznik stoi na początku tekstu w nawiasach ostrych.
 */

/**
 * Komendy, które WOLNO wysłać ścieżką wewnętrzną (`POST /api/sessions/:id/model`).
 *
 * W wolnym tekście obie stoją poza allow-listą: zatwierdzenie dialogu przełączenia modelu
 * nadpisuje `~/.claude/settings.json`, czyli DOMYŚLNY model nowych sesji na całym koncie, a arkusz
 * z ostrzeżeniem o skutku globalnym da się ominąć jednym zdaniem w composerze. Jedyną drogą do nich
 * jest endpoint, który sam składa komendę z wartości ze swojej allow-listy.
 */
export const INTERNAL_SLASH_COMMANDS: ReadonlySet<string> = new Set(['/model', '/effort']);

/**
 * Znaczniki, którymi CLI 2.1.302 zapisuje w pliku rozmowy komendę i jej wynik (bez nawiasów ostrych).
 *
 * Zmierzone na CLI 2.1.302 (fixture'y `server/test/fixtures/herdr/commands/measured/`):
 * nazwa, tekst i argumenty komendy stoją w jednym wpisie, wynik w następnym, a przed komendą
 * zapisaną wpisem `user` stoi wpis `isMeta` z zastrzeżeniem (`caveat`). `systemReminder` nie jest
 * znacznikiem komendy, ale CLI wstawia go w ten sam sposób do ról `user`, więc import traktuje go
 * jak resztę hydrauliki.
 */
export const TRANSCRIPT_TAGS = {
  commandName: 'command-name',
  commandMessage: 'command-message',
  commandArgs: 'command-args',
  stdout: 'local-command-stdout',
  stderr: 'local-command-stderr',
  caveat: 'local-command-caveat',
  systemReminder: 'system-reminder',
} as const;

/**
 * Znaczniki, po których import (`transcript-import.ts`) poznaje tekst `user`, którego NIKT nie
 * napisał: nazwa i argumenty komendy, jej wynik i przypomnienie systemowe. Zastrzeżenia (`caveat`)
 * tu nie ma: stoi tylko we wpisach `isMeta`, które import odrzuca wcześniej.
 */
export const CLI_PLUMBING_TAGS: readonly string[] = [
  TRANSCRIPT_TAGS.stdout,
  TRANSCRIPT_TAGS.stderr,
  TRANSCRIPT_TAGS.commandName,
  TRANSCRIPT_TAGS.commandMessage,
  TRANSCRIPT_TAGS.commandArgs,
  TRANSCRIPT_TAGS.systemReminder,
];

/** Wartość `cli`, której dowód nie podał (fakt z docs nie ma wersji CLI). Nie zgadujemy. */
export const UNKNOWN = 'nieznana';

/**
 * Pliki dowodów faktów o komendach (ścieżki względem `server/test/fixtures/herdr/commands/`), z wersją CLI.
 * Opis plików: `server/test/fixtures/herdr/README.md`; jak je odświeżyć:
 * `docs/slash-commands.md`, „After a Claude Code update”.
 */
export const EVIDENCE = {
  /** Katalog komend sesji z `$.command.list()` sondy modu (klasa a, API modów): zbiór nazw wbudowanych. */
  catalog: { file: 'measured/catalog-2.1.302.json', cli: '2.1.302' },
  /**
   * Fakty z tabeli „All commands” strony docs `commands.md` (klasa a): nazwy, aliasy, znaczniki Skill i Workflow,
   * „Removed”, przekierowanie argumentu.
   */
  docs: {
    file: 'docs/commands.json',
    source: 'https://code.claude.com/docs/en/commands.md',
    fetched: '2026-10-26',
  },
  /** Pomiar żywy (klasa b, sesje `claude` w panelu herdr): aliasy z menu „/”, `kind` zamkniętej listy, wyjście. */
  live: { file: 'measured/live-2.1.310.json', cli: '2.1.310' },
  /**
   * Ultracode: formy komendy i wersje minimalne z docs `model-config`, „Adjust effort level” (klasa a,
   * `source`, `fetched`), oraz wynik pomiaru na żywym CLI w izolacji (klasa b, `cli`): wyniki komend,
   * nazwy załączników pliku rozmowy. Plik dowodu wskazuje wycinki pliku rozmowy, w których te słowa stoją
   * (`server/test/fixtures/herdr/ultracode/`). Słowa czyta `herdr/ultracode.ts` i {@link ULTRACODE_COMMANDS}.
   */
  ultracode: {
    file: 'measured/ultracode-2.1.318.json',
    cli: '2.1.318',
    source: 'https://code.claude.com/docs/en/model-config#adjust-effort-level',
    fetched: '2026-11-03',
  },
} as const;

/**
 * Formy komendy ultracode: włączenie i wyłączenie na czas sesji, bez zmiany poziomu effortu. Obie z docs
 * ({@link EVIDENCE}`.ultracode`, klasa a), jedna forma na stan. Obie zmierzone na 2.1.317: w bezczynności CLI
 * wykonuje je bez dialogu i zapisuje wynik (`herdr/ultracode.ts`), w trakcie tury wykonuje je bez wpisu w pliku
 * rozmowy.
 */
export const ULTRACODE_COMMANDS = {
  on: '/effort ultracode',
  off: '/effort ultracode off',
} as const;

/**
 * Wersja Claude Code pomiaru ZBIORU NAZW wbudowanych: katalog sondy ({@link EVIDENCE}`.catalog`). Nazwa spoza
 * katalogu ma dowód w faktach z docs. Wersja CLI sesji inna niż ta dostaje ten sam zestaw i linię logu (`catalog.ts`).
 */
export const COMMANDS_CLI = EVIDENCE.catalog.cli;

/** Wersja Claude Code obserwacji (klasa b). */
export interface Measurement {
  readonly cli: string;
}

/** Zdanie z pomiaru żywego komendy w panelu, z wersją CLI TEGO pomiaru. */
export interface Observation extends Measurement {
  readonly text: string;
}

/**
 * Jak komenda kończy się w panelu: `local` — wypisuje wynik i wraca do pola promptu, `panel` —
 * otwiera panel albo dialog, który czeka na klawisze, `prompt` — startuje turę modelu.
 */
export type CommandKind = 'local' | 'prompt' | 'panel';

/**
 * How the command's call is written to the transcript, when that differs from the plain "name, output" pair:
 * `plain-user-entry` — the call can have two carriers, a plain `user` entry with its text and the entry with
 * `<command-name>`. A reader keeps one carrier per call: the plain entry when one stands before the call, else the call
 * (`FileEchoPairing` in `transcript.ts`). `/compact`: CLI 2.1.299 writes both, CLI 2.1.328 only the call (fixtures
 * `queue/measured/compact-2.1.299.jsonl`, `compact-2.1.328.jsonl`).
 */
export type FileEcho = 'plain-user-entry';

/**
 * What the CLI does with the command sent while a turn runs, when that differs from idle:
 * `silent` — it runs the command at once, keeps the turn and writes neither the call nor the output
 * (`system/local_command`) to the transcript, only the command's own entries (`/rename` measured on CLI 2.1.325,
 * fixture `rename-in-turn-2.1.325.jsonl`).
 */
export type InTurnRule = 'silent';

/** {@link InTurnRule} with the CLI version it was measured on. */
export interface InTurnObservation {
  readonly rule: InTurnRule;
  readonly cli: string;
}

/** Jedna komenda wbudowana CLI. */
export interface BuiltinCommand {
  /** Nazwa bez ukośnika, tak jak w `$.command.list()` i w docs. */
  readonly name: string;
  /** Aliasy z menu „/” pomiaru żywego ({@link EVIDENCE}`.live`); prawie wszystkie stoją też w docs. */
  readonly aliases: readonly string[];
  /**
   * Zmierzony (z {@link kindEvidence}) wyłącznie na zamkniętej liście pomiaru żywego: komendy dopuszczone,
   * `/team-onboarding` i goły `/goal`. Reszta ma `panel`: wartość ostrożna, nie pomiar; `buildCatalog`
   * (`catalog.ts`) `panel` nie przepuszcza, a transkrypt pokazuje go jak `local` (notka `system`).
   */
  readonly kind: CommandKind;
  /** Pomiar żywy, z którego pochodzi `kind`; brak = `panel` bez pomiaru. */
  readonly kindEvidence?: Measurement;
  /** Czy nazwa stoi w katalogu sondy; `false` — dowodem nazwy jest wiersz faktów z docs. */
  readonly listed: boolean;
  /**
   * Allow-lista wolnego tekstu: komenda wpisana z telefonu wychodzi do panelu wyłącznie z tym polem
   * `true`. Czyta je `catalog.ts`; komenda z `kind: 'panel'` nie może go mieć (strażnik w testach).
   */
  readonly allowed: boolean;
  /** Wersja CLI dowodu nazwy: katalogu sondy albo {@link UNKNOWN} dla nazwy z samych docs. */
  readonly cli: string;
  /** Wynik pomiaru żywego, gdy komendę wykonano w panelu. */
  readonly observed?: Observation;
  readonly fileEcho?: FileEcho;
  readonly inTurn?: InTurnObservation;
}

/**
 * Skąd wiadomo, że wpis jest skillem wbudowanym, czyli promptem dla modelu (docs `skills.md`, „Bundled skills”;
 * `buildCatalog` daje mu `kind: prompt`): `docs-marker` — znacznik Skill albo Workflow w faktach z docs;
 * `docs-text` — inna strona docs (tytuł sekcji w komentarzu wpisu); `none` — dowodu nie ma (dwa skille spoza
 * allow-listy, `docs/slash-commands.md`, „Allow-list v1”).
 */
export type SkillEvidence = 'docs-marker' | 'docs-text' | 'none';

/** Skill wbudowany w CLI (bez pliku na dysku): w `$.command.list()` ze źródłem `builtin`. */
export interface BundledSkill {
  readonly name: string;
  /** Aliasy z menu „/” pomiaru żywego, wszystkie także w docs. */
  readonly aliases: readonly string[];
  /** Czy stoi w katalogu sondy. */
  readonly listed: boolean;
  readonly skillEvidence: SkillEvidence;
  /**
   * Przekierowania pierwszego argumentu: CLI wykonuje WTEDY komendę docelową, nie skill. Dowód: fakty z docs
   * (`/code-review ultra` → `/ultrareview`) albo reguła na katalogu sondy — skill `S` (znacznik w docs) i komenda
   * `S-x` w katalogu dają `x` → `S-x`. Liczy się także przy dalszych argumentach: przy wątpliwości Rarog bierze cel
   * przekierowania (ostrożniej). Klucz małymi literami, wartość bez ukośnika.
   */
  readonly subcommands?: Readonly<Record<string, string>>;
  /**
   * Allow-lista. Domyślnie `true`: skill wbudowany jest promptem dla modelu, więc nie zmienia niczego poza
   * turą, a jego narzędzia przechodzą zwykłe zgody. `false` ma skill, którego CLI nie przyjmuje od człowieka
   * (pomiar żywy, podpowiedź odmowy w {@link REFUSAL_HINTS}); nazwa zostaje w rejestrze, żeby odmowa ją znała.
   */
  readonly allowed: boolean;
  /** Wersja CLI dowodu nazwy (katalog sondy). */
  readonly cli: string;
}

const CATALOG_NAME: Measurement = { cli: EVIDENCE.catalog.cli };
const DOCS_NAME: Measurement = { cli: UNKNOWN };
const LIVE_KIND: Measurement = { cli: EVIDENCE.live.cli };

/** Zdanie pomiaru żywego z jego wersją. */
function seen(cli: string, text: string): Observation {
  return { cli, text };
}

interface CommandExtra {
  readonly aliases?: readonly string[];
  /** `kind` z zamkniętej listy pomiaru żywego ({@link EVIDENCE}`.live`, pole `closedList`). */
  readonly measuredKind?: CommandKind;
  readonly listed?: boolean;
  readonly allowed?: boolean;
  readonly observed?: Observation;
  readonly fileEcho?: FileEcho;
  readonly inTurn?: InTurnObservation;
}

function command(name: string, extra: CommandExtra = {}): BuiltinCommand {
  const listed = extra.listed ?? true;
  const proof = listed ? CATALOG_NAME : DOCS_NAME;
  return {
    name,
    aliases: extra.aliases ?? [],
    kind: extra.measuredKind ?? 'panel',
    ...(extra.measuredKind === undefined ? {} : { kindEvidence: LIVE_KIND }),
    listed,
    allowed: extra.allowed ?? false,
    cli: proof.cli,
    ...(extra.observed === undefined ? {} : { observed: extra.observed }),
    ...(extra.fileEcho === undefined ? {} : { fileEcho: extra.fileEcho }),
    ...(extra.inTurn === undefined ? {} : { inTurn: extra.inTurn }),
  };
}

function skill(
  name: string, extra: Partial<Pick<BundledSkill, 'aliases' | 'skillEvidence' | 'subcommands' | 'allowed'>> = {},
): BundledSkill {
  return {
    name,
    aliases: extra.aliases ?? [],
    listed: true,
    skillEvidence: extra.skillEvidence ?? 'docs-marker',
    ...(extra.subcommands === undefined ? {} : { subcommands: extra.subcommands }),
    allowed: extra.allowed ?? true,
    cli: CATALOG_NAME.cli,
  };
}

/**
 * Komendy wbudowane Claude Code. Nazwa: katalog sondy (`listed`) albo wiersz faktów z docs (`listed: false`:
 * `/diff`, `/stop`, `/ultraplan` — ten ostatni docs znaczą „Removed”, nazwa zostaje zastrzeżona). Aliasy: menu
 * „/” pomiaru żywego. `kind`: zamknięta lista pomiaru żywego, reszta `panel`. `observed`: pomiary żywe
 * z ich wersją (fixture'y `server/test/fixtures/herdr/commands/measured/`). Także komendy, których Rarog nigdy
 * nie przepuści: reguła „ścieżka będąca prefiksem komendy” i `reservedNames` potrzebują pełnej listy nazw.
 *
 * Allow-lista v1: kind `local` — `/compact`, `/clear`, `/context`, `/plan`,
 * `/recap`, `/rename`; kind `prompt` — `/init`, `/insights`; wszystkie z typem zmierzonym na zamkniętej liście
 * (2.1.310). `/statusline` i `/team-onboarding` zostają poza: pierwsza zmienia konfigurację (typu
 * nie mierzymy, bo wymagałoby to zmiany ustawień), druga jest poza potrzebą.
 */
export const BUILTIN_COMMANDS: readonly BuiltinCommand[] = [
  command('__remote-workflow'),
  command('add-dir'),
  command('advisor'),
  command('agents'),
  command('artifacts'),
  command('auto-mode-setup'),
  command('autocompact'),
  command('autofix-pr'),
  command('background', { aliases: ['bg'] }),
  command('branch'),
  command('btw'),
  command('bug', { aliases: ['share'] }),
  command('cd', {
    observed: seen('2.1.302',
      'bez dialogu; wpisy `system/local_command`, wynik z SGR; `cwd` panelu w herdr bez zmiany'),
  }),
  command('chrome'),
  command('claim-credit'),
  command('clear', {
    aliases: ['new', 'reset'],
    measuredKind: 'local',
    allowed: true,
    observed: seen('2.1.302', 'bez panelu; NOWY plik rozmowy (nowy `sessionId` w herdr i w rejestrze '
      + 'CLI), a w nim zastrzeżenie `isMeta`, `<command-name>` wpisem `user` i pusty wynik wpisem '
      + '`system/local_command`'),
  }),
  command('color'),
  command('compact', {
    measuredKind: 'local',
    allowed: true,
    fileEcho: 'plain-user-entry',
    observed: seen('2.1.328', 'the call is only the `<command-name>` entry after the compaction summary; CLI 2.1.299 '
      + 'also wrote a plain `user` entry "/compact" before the compaction (fixtures '
      + '`queue/measured/compact-2.1.328.jsonl`, `compact-2.1.299.jsonl`)'),
  }),
  command('config', {
    aliases: ['settings'],
    observed: seen('2.1.302', 'z argumentem `klucz=wartość` ustawia bez dialogu (też przez alias '
      + '`/settings`); wpisy `system/local_command`'),
  }),
  command('context', {
    measuredKind: 'local',
    allowed: true,
    observed: seen('2.1.302',
      'bez panelu; wpisy `system/local_command` (wynik z SGR) i wpis `isMeta` z Markdownem'),
  }),
  command('copy'),
  command('design-consent'),
  command('design-login'),
  command('design-revoke'),
  command('desktop', { aliases: ['app'] }),
  command('diff', { listed: false }),
  command('effort'),
  command('exit', { aliases: ['quit'] }),
  command('export'),
  command('extra-usage'),
  command('fast'),
  command('feedback'),
  command('focus'),
  command('fork'),
  command('goal', {
    measuredKind: 'panel',
    observed: seen('2.1.310', 'goły `/goal` otwiera panel: rejestr CLI `waiting` z `waitingFor: '
      + 'dialog open`, panel zamknięty Esc, bez wpisu w pliku rozmowy'),
  }),
  command('heapdump'),
  command('help'),
  command('hooks'),
  command('ide'),
  command('import'),
  command('init', { measuredKind: 'prompt', allowed: true }),
  command('insights', { measuredKind: 'prompt', allowed: true }),
  command('install-github-app'),
  command('install-slack-app'),
  command('keybindings'),
  command('limit-reset'),
  command('list-agents', { aliases: ['peers'] }),
  command('login'),
  command('logout'),
  command('low-priority'),
  command('mcp'),
  command('memory', {
    observed: seen('2.1.302', 'pełna nazwa otwiera panel Memory, Esc daje wynik „Cancelled memory '
      + 'editing”; wpisy `system/local_command`; herdr widzi `blocked`'),
  }),
  command('mobile', { aliases: ['android', 'ios'] }),
  command('model'),
  command('output-style'),
  command('passes'),
  command('permissions', {
    aliases: ['allowed-tools'],
    observed: seen('2.1.302', 'prefiks `/perm` z Enterem otwiera ten panel'),
  }),
  command('plan', {
    measuredKind: 'local',
    allowed: true,
    observed: seen('2.1.302',
      'bez panelu („Enabled plan mode”); wpisy `user`: zastrzeżenie `isMeta`, `<command-name>`, wynik'),
  }),
  command('plugin', {
    aliases: ['plugins'],
    observed: seen('2.1.302', '`/plugin install x@y` bez dialogu; wpisy `user`'),
  }),
  command('powerup'),
  command('privacy-settings'),
  command('pro-trial-expired'),
  command('radio'),
  command('rate-limit-options'),
  command('recap', {
    measuredKind: 'local',
    allowed: true,
    observed: seen('2.1.302', 'bez panelu („Nothing to recap yet” przy pustej rozmowie); '
      + '`<command-name>` wpisem `user`, wynik wpisem `system/local_command`'),
  }),
  command('release-notes'),
  command('reload-plugins'),
  command('reload-skills'),
  command('remote-control', { aliases: ['rc'] }),
  command('remote-env'),
  command('rename', {
    aliases: ['name'],
    measuredKind: 'local',
    allowed: true,
    observed: seen('2.1.302', 'bez panelu z argumentem i bez niego: `/rename x` wypisuje „Session '
      + 'renamed to: x”, goły `/rename` generuje nazwę z rozmowy (przy pustej: „Could not generate a name”); wpisy '
      + '`system/local_command` (fixture `rename-clear-2.1.302.jsonl`)'),
    // Sent while a turn runs: `custom-title` and `agent-name` within ~0.3 s, the turn goes on, no
    // `system/local_command` entries (synthetic excerpt `rename-in-turn-2.1.325.jsonl`).
    inTurn: { rule: 'silent', cli: '2.1.325' },
  }),
  command('resume', { aliases: ['continue'] }),
  command('rewind', { aliases: ['checkpoint', 'undo'] }),
  command('sandbox'),
  command('schedule', { aliases: ['routines'] }),
  command('scroll-speed'),
  command('setup-bedrock'),
  command('setup-vertex'),
  command('skill-doctor'),
  command('skills'),
  command('status', {
    observed: seen('2.1.302',
      'panel Settings, zakładka Status; rejestr CLI `waiting` („dialog open”), Esc; bez wpisu w pliku'),
  }),
  command('statusline'),
  command('stickers'),
  command('stop', { listed: false }),
  command('subtask'),
  command('tasks', { aliases: ['bashes'] }),
  command('team-onboarding', { measuredKind: 'prompt' }),
  command('teleport', { aliases: ['tp'] }),
  command('terminal-setup'),
  command('theme'),
  command('tui'),
  command('ultraplan', { listed: false }),
  command('ultrareview'),
  command('upgrade'),
  command('usage', {
    aliases: ['cost', 'stats'],
    observed: seen('2.1.302', 'panel Settings, zakładka Usage: pełna nazwa wykonuje `/usage`, nie '
      + '`/usage-credits`; prefiks `/usa` i inna wielkość liter (`/Usage`) też; Esc; bez wpisu w pliku'),
  }),
  command('usage-credits', {
    observed: seen('2.1.302', 'dialog logowania („Starting new login following /usage-credits”); Esc '
      + 'daje wynik „Login interrupted”; wpisy `user`'),
  }),
  command('voice'),
  command('web-setup'),
  command('workflow-launch-exec'),
  command('workflows'),
];

/**
 * Skille wbudowane w CLI: nazwy `builtin` z katalogu sondy, które docs pokazują jako skill (znacznik Skill albo
 * Workflow w tabeli „All commands”) albo opisują jako skill na innej stronie. Aliasy: menu „/” pomiaru żywego
 * (wszystkie także w docs). Przekierowania argumentów: `BundledSkill.subcommands`.
 */
export const BUNDLED_SKILLS: readonly BundledSkill[] = [
  skill('artifact-capabilities'),
  // Tylko katalog sondy; docs tej nazwy nie znają. Pomiar żywy 2.1.310 (próba `e09`): wpisany przez
  // człowieka kończy się lokalnie („This skill can only be invoked by Claude…”), bez tury, także w terminalu.
  // Poza allow-listą; odmowa ma podpowiedź `claude-only` (`REFUSAL_HINTS`).
  skill('artifact-design', { skillEvidence: 'none', allowed: false }),
  skill('artifact-diagramming'),
  skill('batch'),
  skill('claude-api'),
  skill('claude-in-chrome'),
  skill('code-review', { aliases: ['review'], subcommands: { ultra: 'ultrareview' } }),
  skill('dataviz'),
  skill('debug'),
  // Znacznik Workflow, nie Skill; docs `workflows.md` opisują go jako workflow wbudowany w Claude Code.
  skill('deep-research'),
  skill('design', {
    subcommands: { sync: 'design-sync', login: 'design-login', consent: 'design-consent', revoke: 'design-revoke' },
  }),
  skill('design-sync'),
  skill('doctor', { aliases: ['checkup'] }),
  skill('fewer-permission-prompts'),
  // Jak `artifact-design` (próba `e10`): tylko katalog sondy, w pomiarze żywym 2.1.310 lokalny; poza
  // allow-listą.
  skill('keybindings-help', { skillEvidence: 'none', allowed: false }),
  skill('loop', { aliases: ['proactive'] }),
  // Wiersz docs bez znacznika; skill wbudowanego modu: docs `plugins/mods/overview.md`, „Mods built into Claude Code”.
  skill('plugin-authoring', { skillEvidence: 'docs-text' }),
  skill('run'),
  skill('run-skill-generator'),
  // Wiersz docs bez znacznika; komenda z promptem po zebraniu kontekstu: docs `errors.md`, „Command-line errors”.
  skill('security-review', { skillEvidence: 'docs-text' }),
  skill('simplify'),
  skill('slides'),
  skill('update-config'),
  skill('verify'),
  skill('workflow-authoring'),
];

/**
 * Słowa, które jako CAŁY tekst kończą sesję bez ukośnika: pomiar żywy, każde słowo w świeżej sesji (hook
 * `SessionEnd`, powód `prompt_input_exit`). `:x`, `bye`, `ZZ` sesji nie kończą; `logout` nie było wysyłane
 * (gołe słowo mogłoby wylogować konto). Docs znają tylko `/exit` i alias `/quit`.
 */
export const EXIT_WORDS = {
  words: ['exit', 'quit', ':q', ':q!', ':wq', ':wq!'],
  cli: EVIDENCE.live.cli,
} as const satisfies { readonly words: readonly string[]; readonly cli: string };

/**
 * Komendy i skille wbudowane, przy których odmowa wolnego tekstu ma INNĄ podpowiedź niż „wykonaj ją
 * w terminalu”: `/model` i `/effort` mają w Rarogu własną, potwierdzaną drogę, `/exit` kończy
 * proces CLI, co w Rarogu robi przycisk, a `claude-only` to skill, który CLI wykonuje tylko na prośbę modelu
 * (pomiar żywy 2.1.310, próby `e09` i `e10`: „This skill can only be invoked by Claude, not directly by users”),
 * więc terminal nie pomoże. Klucz: nazwa kanoniczna bez ukośnika; zdania składa `shape.ts`.
 */
export const REFUSAL_HINTS: Readonly<Record<string, 'model-button' | 'end-session' | 'claude-only'>> = {
  model: 'model-button',
  effort: 'model-button',
  exit: 'end-session',
  'artifact-design': 'claude-only',
  'keybindings-help': 'claude-only',
};

/**
 * Przedrostek nazwy promptu serwera MCP (`/mcp__<serwer>__<prompt>`; docs `mcp.md`, „Execute MCP prompts”).
 * Promptów MCP katalog Raroga nie zna: odmowa z tym przedrostkiem odsyła do terminala.
 */
export const MCP_PROMPT_PREFIX = 'mcp__';

/**
 * Znacznik, którym menu „/” podpisuje prompt serwera MCP za jego nazwą (docs `mcp.md`, „Execute MCP prompts”).
 * Tekst `/<nazwa> (MCP) …` Rarog bierze za wywołanie promptu MCP, nie komendy `<nazwa>`,
 * i odmawia; jak CLI wykonuje taki tekst, niezmierzone (ostrożność).
 */
export const MCP_PROMPT_MARKER = '(MCP)';

/**
 * Gdzie Claude Code trzyma na dysku skille i komendy i jak je nazywa — jedyne źródło ścieżek i kluczy
 * dla `discover.ts` (opis podzbioru źródeł: `docs/slash-commands.md`, „Session catalog and discovery”).
 *
 * Źródła (klasa a): docs `skills.md` — „Choose where skills load” (katalogi skilli, zastrzeżona
 * nazwa `synced`), „How a skill gets its command name”, „Frontmatter reference” (`name`, `user-invocable`,
 * `description`, `argument-hint`), „Override skill visibility from settings” (`skillOverrides`, `off`; pluginów nie
 * dotyczy), „Where synced skills load” (`~/.claude/skills/synced/`), „Names reserved for synced skills” i „When
 * a synced skill name matches another command” (przedrostek `anthropic-skills`; przy kolizji goła nazwa wykonuje
 * inną komendę); docs `plugins-reference.md` — „`defaultEnabled`” (brak = `true`). Klasa b (pole `cli`):
 * pliki tego Maca — `installed_plugins.json` w wersji 2 z `scope` i `projectPath` oraz podkatalogi
 * `synced/<id>_<id>/`; co znaczą człony ich nazwy i który z nich CLI czyta, niezmierzone (Rarog czyta wszystkie).
 * Dlatego skille z claude.ai stoją poza katalogiem i służą tylko podpowiedzi.
 */
export const DISK_LAYOUT = {
  configDir: '.claude',
  skillsDir: 'skills',
  commandsDir: 'commands',
  skillFile: 'SKILL.md',
  commandExt: '.md',
  settings: 'settings.json',
  localSettings: 'settings.local.json',
  gitDir: '.git',
  plugins: {
    dir: 'plugins',
    installed: 'installed_plugins.json',
    installedVersion: 2,
    manifestDir: '.claude-plugin',
    manifest: 'plugin.json',
    scopeUser: 'user',
    scopeProject: 'project',
  },
  settingsKeys: {
    enabledPlugins: 'enabledPlugins',
    skillOverrides: 'skillOverrides',
    overrideOff: 'off',
  },
  manifestKeys: {
    name: 'name',
    commands: 'commands',
    skills: 'skills',
    defaultEnabled: 'defaultEnabled',
  },
  frontmatterKeys: {
    name: 'name',
    userInvocable: 'user-invocable',
    // Opis i podpowiedź argumentu do listy podpowiedzi apki (`GET /api/sessions/:id/commands`).
    description: 'description',
    argumentHint: 'argument-hint',
  },
  synced: {
    dir: 'synced',
    // Katalogów, których nazwa nie przechodzi `isCommandSegment` (`.trash`, `.staging`), skan i tak nie bierze.
    reservedDirs: ['synced'],
    prefix: 'anthropic-skills',
  },
  cli: '2.1.302',
} as const;

/**
 * Pola i wartości wpisów pliku rozmowy, którymi CLI zapisuje komendę lokalną i komendę nieznaną.
 * Zmierzone na 2.1.302 (fixture'y `commands/measured/`): `/config`, `/cd`, `/context`, `/memory` piszą
 * wpisy `system` z podtypem `localCommand` (najpierw nazwa, potem wynik z `commandRun`), `/plugin`,
 * `/plan`, `/usage-credits` — wpisy `user`; nieznana komenda to wpis `system` z podtypem
 * `informational` i poziomem `warning`.
 *
 * Prompt zakończony przed modelem przez hook `UserPromptSubmit` (zwykły prompt i komenda typu prompt) to
 * ten sam wpis `informational` z poziomem `warning` i polem `promptSubmitEnding` = `{ ending: { kind, reason },
 * promptKept }`. Zmierzone na CLI 2.1.303 (pomiar skryptem, fixture'y
 * `commands/measured/prompt-block-*-2.1.303.jsonl`) i na prawdziwym wpisie CLI 2.1.302
 * (`prompt-block-prawdziwy-2.1.302.jsonl`, ten sam kształt, więc wersja pomiaru zostaje 2.1.302). `blocked_by_hook`:
 * hook zablokował (kod 2 albo `{"decision":"block"}`), wpisu `user` nie ma, a `content` cytuje prompt za
 * `Original prompt: `. `stopped_by_hook` (`{"continue":false}`): prompt stoi w zwykłym wpisie `user`,
 * `promptKept: true`, cytatu nie ma. Opis i wyniki: `docs/dialogs.md`, „Prompt blocked by a hook”.
 * Pola czyta mapowanie `transcript.ts` (część `prompt-blocked`, wyłącznie `blocked_by_hook`) i strażnik pomiaru.
 */
export const TRANSCRIPT_ENTRY = {
  localCommand: 'local_command',
  informational: 'informational',
  warning: 'warning',
  commandRun: 'commandRun',
  unknownCommand: 'Unknown command: /',
  didYouMean: '. Did you mean /',
  unknownSkillArgs: 'Args from unknown skill: ',
  promptSubmitEnding: 'promptSubmitEnding',
  blockedByHook: 'blocked_by_hook',
  stoppedByHook: 'stopped_by_hook',
  promptKept: 'promptKept',
  originalPrompt: 'Original prompt: ',
} as const;

/**
 * Pomiar, z którego pochodzą literały pliku rozmowy (`TRANSCRIPT_TAGS`, `TRANSCRIPT_ENTRY`), i literały
 * bez wpisu w fixture'ach pomiaru — z powodem. `system-reminder` stoi w fixture (wpis `isMeta` po
 * `/rename x`, `rename-clear-2.1.302.jsonl`). Lista zamknięta: pilnuje jej
 * `server/test/herdr-commands-boundary.test.ts`.
 */
export const TRANSCRIPT_MEASURED = {
  cli: '2.1.302',
  withoutFixture: {
    stderr: 'niezmierzone: żadna komenda pomiaru nie pisała na stderr; znacznik zostaje z ostrożności Raroga '
      + '(tekst w nim to wynik komendy, nie wiadomość człowieka)',
  },
} as const;
