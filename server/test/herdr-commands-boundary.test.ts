/**
 * Granice katalogu slash-komend (`server/src/herdr/commands/`) — strażnicy „jednego miejsca".
 *
 * Katalog ma sens tylko wtedy, gdy wiedza o komendach Claude Code w nim ZOSTAJE: drugi wzorzec kształtu
 * komendy albo przepisany znacznik pliku rozmowy powstają jako jedna wygodna linia w cudzym pliku. Testy są
 * GREPOWE, jak `herdr-background-boundary.test.ts`, na kodzie bez komentarzy (`source-scan.ts`).
 *
 * Opis katalogu, rejestru i procedury po aktualizacji CLI: `docs/slash-commands.md`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_COMMANDS, BUNDLED_SKILLS, CLI_PLUMBING_TAGS, COMMANDS_CLI, DISK_LAYOUT, EVIDENCE,
  EXIT_WORDS, INTERNAL_SLASH_COMMANDS, REFUSAL_HINTS, TRANSCRIPT_ENTRY, TRANSCRIPT_MEASURED, TRANSCRIPT_TAGS,
  ULTRACODE_COMMANDS, UNKNOWN,
} from '../src/herdr/commands/registry.ts';
import { parseImportLine } from '../src/transcript-import.ts';
import { registryCatalog } from '../src/herdr/commands/catalog.ts';
import { relativeImports, scan, tsFiles } from './source-scan.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(REPO, 'server/src');
const DIR = join(SRC, 'herdr/commands');
const DOC = 'docs/slash-commands.md';
const EVIDENCE_DIR = join(REPO, 'server/test/fixtures/herdr/commands');
const FIXTURES = join(EVIDENCE_DIR, 'measured');
const REGISTRY = 'server/src/herdr/commands/registry.ts';

const repoPath = (file: string): string => relative(REPO, file);
const read = (file: string): string => readFileSync(file, 'utf8');

const MODULES = tsFiles(DIR).map(repoPath);
/** Kod (bez komentarzy) każdego pliku `server/src/**`, pod ścieżką względem korzenia repo. */
const CODE = new Map(tsFiles(SRC).map((file) => [repoPath(file), scan(read(file)).code]));

/** Kształt Raroga dla nazwy komendy: litera, cyfra albo `_`, potem także `:` i `-`. */
const RAROG_NAME = /^[A-Za-z0-9_][A-Za-z0-9:_-]*$/;

describe('katalog komend: istnieje i ma wejście', () => {
  it('ma moduły, a wśród nich `index.ts`', () => {
    expect(MODULES).toEqual(expect.arrayContaining([
      'server/src/herdr/commands/index.ts', 'server/src/herdr/commands/guard.ts',
      'server/src/herdr/commands/shape.ts', 'server/src/herdr/commands/catalog.ts',
      'server/src/herdr/commands/discover.ts', 'server/src/herdr/commands/transcript.ts', REGISTRY,
    ]));
  });
});

describe('katalog komend: kierunek zależności', () => {
  /* Fasada drivera, manager i nadzorca WOŁAJĄ katalog; import w drugą stronę zamknąłby cykl. */
  const FORBIDDEN = [
    'server/src/drivers/herdr-driver.ts', 'server/src/sessions/manager.ts', 'server/src/herdr/supervisor.ts',
  ];

  const importsOf = (file: string): string[] => relativeImports(read(join(REPO, file)))
    .map((spec) => repoPath(resolve(dirname(join(REPO, file)), spec)));

  it.each(MODULES)('%s nie importuje fasady drivera, managera ani nadzorcy', (file) => {
    for (const imported of importsOf(file)) expect(FORBIDDEN, `${file} importuje ${imported}`).not.toContain(imported);
  });

  it('rejestr nie importuje niczego (same słowa CLI)', () => {
    expect(read(join(REPO, REGISTRY))).not.toMatch(/^import /m);
  });
});

describe('katalog komend: mapa modułów w `index.ts` i w dokumencie', () => {
  const doc = read(join(REPO, DOC));
  const header = read(join(DIR, 'index.ts'));

  function moduleMap(): string {
    const start = doc.indexOf('\n## Module map');
    expect(start, `${DOC} stracił sekcję „Module map"`).toBeGreaterThan(-1);
    const rest = doc.slice(start + 1);
    const end = rest.indexOf('\n## ');
    return rest.slice(0, end === -1 ? undefined : end);
  }

  it.each(MODULES)('%s stoi w mapie modułów dokumentu i w `index.ts`', (file) => {
    expect(moduleMap(), `${DOC}: brak \`${file}\``).toContain(`\`${file}\``);
    expect(header, `index.ts: brak \`${relative(DIR, join(REPO, file))}\``)
      .toContain(`\`${relative(DIR, join(REPO, file))}\``);
  });

  it('mapa w dokumencie nie wymienia pliku, którego już nie ma', () => {
    const listed = [...moduleMap().matchAll(/`(server\/src\/herdr\/commands\/[^`]+\.ts)`/g)].map((hit) => hit[1] ?? '');
    expect(listed.length).toBeGreaterThan(0);
    for (const file of listed) expect(MODULES, `${DOC} wymienia nieistniejący ${file}`).toContain(file);
  });
});

describe('rejestr komend: wpisy', () => {
  const ENTRIES = [...BUILTIN_COMMANDS, ...BUNDLED_SKILLS];
  const DATED = [...ENTRIES, EXIT_WORDS, TRANSCRIPT_MEASURED];

  it('every entry has the CLI version of its measurement', () => {
    expect(BUILTIN_COMMANDS.length).toBeGreaterThanOrEqual(100);
    expect(BUNDLED_SKILLS.length).toBeGreaterThan(20);
    for (const entry of DATED) {
      expect(entry.cli === UNKNOWN || /^\d+\.\d+\.\d+$/.test(entry.cli), `wersja „${entry.cli}"`).toBe(true);
    }
  });

  it('nazwy i aliasy mają kształt Raroga dla nazwy komendy i stoją bez ukośnika', () => {
    for (const entry of ENTRIES) {
      expect(entry.name, entry.name).toMatch(RAROG_NAME);
      for (const alias of entry.aliases) expect(alias, `${entry.name}: alias ${alias}`).toMatch(RAROG_NAME);
    }
  });

  it('nazwy i aliasy są unikatowe: żaden alias nie powtarza nazwy ani innego aliasu', () => {
    const seen = new Map<string, string>();
    for (const entry of ENTRIES) {
      for (const word of [entry.name, ...entry.aliases]) {
        expect(seen.get(word), `„${word}" stoi w ${seen.get(word)} i w ${entry.name}`).toBeUndefined();
        seen.set(word, entry.name);
      }
    }
  });

  /*
   * Allow-lista v1. Zmiana tej listy jest zmianą granicy uprawnień:
   * nowy wpis wymaga typu z pomiaru żywego (`kindEvidence`, zamknięta lista) i wpisu w `docs/slash-commands.md`.
   */
  it('allow-lista v1 wbudowanych: sześć komend `local` z pomiaru i dwie `prompt`', () => {
    const allowed = BUILTIN_COMMANDS.filter((entry) => entry.allowed).map((entry) => [entry.name, entry.kind]);
    expect(allowed).toEqual([
      ['clear', 'local'], ['compact', 'local'], ['context', 'local'], ['init', 'prompt'], ['insights', 'prompt'],
      ['plan', 'local'], ['recap', 'local'], ['rename', 'local'],
    ]);
  });

  it('dozwolona komenda wbudowana nie otwiera panelu, a jej `kind` ma pomiar żywy', () => {
    for (const entry of BUILTIN_COMMANDS.filter((candidate) => candidate.allowed)) {
      expect(entry.kind, entry.name).not.toBe('panel');
      expect(entry.kindEvidence, `${entry.name}: brak pomiaru typu`).toBeDefined();
    }
  });

  it('wbudowane skille: wszystkie stoją w katalogu sesji (`listed`); poza listą tylko dwa, których CLI nie '
    + 'przyjmuje od człowieka ', () => {
    for (const entry of BUNDLED_SKILLS) expect(entry.listed, entry.name).toBe(true);
    expect(BUNDLED_SKILLS.filter((entry) => !entry.allowed).map((entry) => entry.name))
      .toEqual(['artifact-design', 'keybindings-help']);
  });

  it('każda dozwolona nazwa wbudowana stoi w katalogu sondy 2.1.302 (kontrola na fixture)', () => {
    const catalog = JSON.parse(read(join(FIXTURES, 'catalog-2.1.302.json'))) as {
      commands: { name: string; source: string }[];
    };
    const builtin = new Set(catalog.commands.filter((entry) => entry.source === 'builtin').map((entry) => entry.name));
    const allowed = [...registryCatalog().commands.values()];
    expect(allowed.length).toBe(8 + BUNDLED_SKILLS.filter((entry) => entry.allowed).length);
    expect(allowed.length).toBe(31);
    for (const entry of allowed) expect(builtin.has(entry.name), entry.name).toBe(true);
  });

  it('komendy zapisujące konfigurację i panele zostają poza listą', () => {
    const allowed = new Set(BUILTIN_COMMANDS.filter((entry) => entry.allowed).map((entry) => entry.name));
    for (const name of [
      'permissions', 'hooks', 'config', 'mcp', 'login', 'logout', 'install-github-app', 'model', 'effort', 'exit',
      'cd', 'add-dir', 'plugin', 'statusline', 'team-onboarding', 'status', 'usage', 'memory', 'resume', 'rewind',
    ]) expect(allowed.has(name), name).toBe(false);
  });

  it('`observed` to zdanie z pomiaru z jego wersją, a `kind` bez pomiaru typu to `panel` (wartość ostrożna)', () => {
    for (const entry of BUILTIN_COMMANDS) {
      if (entry.observed !== undefined) {
        expect(entry.observed.text.trim(), entry.name).not.toBe('');
        expect(entry.observed.cli, entry.name).toMatch(/^\d+\.\d+\.\d+$/);
      }
      if (entry.kindEvidence === undefined) expect(entry.kind, `${entry.name}: kind bez pomiaru`).toBe('panel');
    }
    // `/compact` was last measured on 2.1.328 (queue fixture), the rest on 2.1.302: the sentence carries the version of
    // ITS measurement.
    expect(BUILTIN_COMMANDS.find((entry) => entry.name === 'compact')?.observed)
      .toMatchObject({ cli: '2.1.328' });
  });

  it('wbudowane w katalogu sondy = komendy `listed` ∪ wbudowane skille `listed` (`catalog-2.1.302.json`)', () => {
    const catalog = JSON.parse(read(join(FIXTURES, 'catalog-2.1.302.json'))) as {
      cli: string; commands: { name: string; source: string }[];
    };
    expect(catalog.cli).toBe('2.1.302');
    const builtin = catalog.commands.filter((entry) => entry.source === 'builtin').map((entry) => entry.name).sort();
    const listed = ENTRIES.filter((entry) => entry.listed).map((entry) => entry.name).sort();
    expect(listed).toEqual(builtin);
  });

  /*
   * Aliasy sprawdzone ręcznie w pomiarze na CLI 2.1.302. Rejestr musi je nieść (dowód:
   * menu „/” pomiaru żywego albo docs) — inaczej reguła „alias dostaje odmowę z nazwą kanoniczną" nie zna
   * aliasu, który CLI wykona.
   */
  it.each([
    ['permissions', ['allowed-tools']], ['config', ['settings']], ['plugin', ['plugins']],
    ['usage', ['cost', 'stats']], ['clear', ['reset', 'new']], ['exit', ['quit']], ['resume', ['continue']],
    ['rewind', ['checkpoint', 'undo']], ['teleport', ['tp']], ['remote-control', ['rc']], ['rename', ['name']],
    ['background', ['bg']], ['tasks', ['bashes']],
    ['desktop', ['app']], ['mobile', ['ios', 'android']], ['bug', ['share']], ['list-agents', ['peers']],
  ] as const)('/%s niesie aliasy %j', (name, aliases) => {
    const entry = BUILTIN_COMMANDS.find((candidate) => candidate.name === name);
    expect(entry, `brak /${name}`).toBeDefined();
    expect(entry?.aliases).toEqual(expect.arrayContaining([...aliases]));
  });

  it('ścieżka wewnętrzna i podpowiedzi odmów wskazują komendy i skille z rejestru spoza allow-listy', () => {
    const byName = new Map(ENTRIES.map((entry) => [entry.name, entry]));
    for (const internal of INTERNAL_SLASH_COMMANDS) {
      expect(byName.get(internal.slice(1))?.allowed, internal).toBe(false);
    }
    for (const name of Object.keys(REFUSAL_HINTS)) expect(byName.get(name)?.allowed, name).toBe(false);
    // Skill poza listą bez wpisu w podpowiedziach dostałby „wykonaj ją w terminalu”, a CLI odmawia mu i tam.
    for (const entry of BUNDLED_SKILLS.filter((candidate) => !candidate.allowed)) {
      expect(REFUSAL_HINTS[entry.name], entry.name).toBe('claude-only');
    }
  });
});

/*
 * Każdy fakt rejestru o komendach stoi w pliku dowodu — wartość i metadane (wersja CLI, data). Pliki: `EVIDENCE`
 * rejestru, opis w `server/test/fixtures/herdr/README.md`. Po nowym pomiarze test wskazuje fakt, który stracił dowód.
 */
describe('rejestr komend: każdy fakt ma dowód z wersją i datą', () => {
  interface DocsRow {
    readonly name: string;
    readonly aliases?: readonly string[];
    readonly marker?: 'skill' | 'workflow';
    readonly removed?: boolean;
  }
  interface Docs {
    readonly source: string;
    readonly fetched: string;
    readonly commands: readonly DocsRow[];
    readonly redirects: readonly { command: string; argument: string; target: string }[];
  }
  interface Catalog {
    readonly cli: string;
    readonly commands: readonly { name: string; source: string }[];
  }
  interface Live {
    readonly cli: string;
    readonly evidence: { catalogCli: string; docsFetched: string };
    readonly aliases: Readonly<Record<string, readonly string[]>>;
    readonly closedList: Readonly<Record<string, { trial: string; kind: string }>>;
    readonly exitWords: { ending: readonly string[] };
    readonly trials: readonly { id: string; transcript?: readonly { note?: string }[] }[];
  }
  const load = <T>(file: string): T => JSON.parse(read(join(EVIDENCE_DIR, file))) as T;
  const catalog = load<Catalog>(EVIDENCE.catalog.file);
  const docs = load<Docs>(EVIDENCE.docs.file);
  const live = load<Live>(EVIDENCE.live.file);
  const catalogNames = new Set(catalog.commands.filter((entry) => entry.source === 'builtin')
    .map((entry) => entry.name));
  const docsRows = new Map(docs.commands.map((row) => [row.name, row]));
  const ENTRIES = [...BUILTIN_COMMANDS, ...BUNDLED_SKILLS];
  const LIVE_KIND = { cli: EVIDENCE.live.cli };
  /** Typ z zamkniętej listy pomiaru żywego po nazwie komendy (klucz próby to tekst, np. „/rename pomiar”). */
  const closedKinds = new Map(Object.entries(live.closedList)
    .map(([text, trial]) => [text.slice(1).split(' ')[0] ?? '', trial.kind]));
  const builtinNames = new Set(BUILTIN_COMMANDS.map((entry) => entry.name));
  /** Zamknięta lista bez skilli: tylko komendy wbudowane niosą `kindEvidence`. */
  const closedBuiltinKinds = new Map([...closedKinds].filter(([name]) => builtinNames.has(name)));

  it('metadane plików dowodów zgadzają się z `EVIDENCE`, a `COMMANDS_*` to katalog sondy', () => {
    expect(catalog.cli).toBe(EVIDENCE.catalog.cli);
    expect([docs.source, docs.fetched]).toEqual([EVIDENCE.docs.source, EVIDENCE.docs.fetched]);
    expect(live.cli).toBe(EVIDENCE.live.cli);
    expect([live.evidence.catalogCli, live.evidence.docsFetched])
      .toEqual([EVIDENCE.catalog.cli, EVIDENCE.docs.fetched]);
    expect(COMMANDS_CLI).toBe(EVIDENCE.catalog.cli);
  });

  it('każda nazwa stoi w katalogu sondy (`listed`) albo w faktach z docs, z wersją i datą swojego dowodu', () => {
    for (const entry of ENTRIES) {
      if (entry.listed) {
        expect(catalogNames.has(entry.name), `${entry.name}: brak w katalogu sondy`).toBe(true);
        expect(entry.cli, entry.name).toBe(EVIDENCE.catalog.cli);
      } else {
        expect(docsRows.has(entry.name), `${entry.name}: brak w faktach z docs`).toBe(true);
        expect(entry.cli, entry.name).toBe(UNKNOWN);
      }
    }
  });

  it('każdy alias stoi w menu pomiaru żywego albo w docs; każdy alias z dowodów stoi w rejestrze', () => {
    const byName = new Map(ENTRIES.map((entry) => [entry.name, entry]));
    for (const entry of ENTRIES) {
      const proven = new Set([...(live.aliases[entry.name] ?? []), ...(docsRows.get(entry.name)?.aliases ?? [])]);
      for (const alias of entry.aliases) {
        expect(proven.has(alias), `${entry.name}: alias ${alias} bez dowodu`).toBe(true);
      }
      // Kierunek odwrotny chroni allow-listę: alias, którego rejestr nie zna, nie dostałby odmowy z nazwą kanoniczną,
      // a skill z dysku o tej nazwie przeszedłby jako prompt.
      for (const alias of proven) expect(entry.aliases, `${entry.name}: brak aliasu ${alias}`).toContain(alias);
    }
    // Aliasy z menu przy nazwie spoza rejestru to wyłącznie skille pluginów (nazwa z dwukropkiem, zastępnik klienta).
    const outside = Object.keys(live.aliases).filter((name) => !byName.has(name));
    for (const name of outside) expect(name, name).toContain(':');
  });

  it('`kind` z pomiaru żywego: dokładnie zamknięta lista komend wbudowanych, ta sama wartość i wersja pomiaru', () => {
    const measured = BUILTIN_COMMANDS.filter((entry) => entry.kindEvidence !== undefined);
    expect(measured.map((entry) => entry.name).sort()).toEqual([...closedBuiltinKinds.keys()].sort());
    for (const entry of measured) {
      expect(entry.kind, entry.name).toBe(closedBuiltinKinds.get(entry.name));
      expect(entry.kindEvidence, entry.name).toEqual(LIVE_KIND);
    }
    expect(BUILTIN_COMMANDS.find((entry) => entry.name === 'team-onboarding')).toMatchObject({
      kind: 'prompt', kindEvidence: LIVE_KIND, allowed: false,
    });
    // Goły `/goal`: panel z klasą `dialog open`, poza allow-listą.
    expect(BUILTIN_COMMANDS.find((entry) => entry.name === 'goal')).toMatchObject({
      kind: 'panel', kindEvidence: LIVE_KIND, allowed: false, observed: { cli: '2.1.310' },
    });
  });

  it('skille z zamkniętej listy: zmierzone jako `local` z odmową CLI dla człowieka, więc poza allow-listą '
    + 'z podpowiedzią `claude-only` ', () => {
    const skills = [...closedKinds].filter(([name]) => !builtinNames.has(name));
    expect(skills).toEqual([['artifact-design', 'local'], ['keybindings-help', 'local']]);
    for (const [name] of skills) {
      expect(BUNDLED_SKILLS.find((entry) => entry.name === name), name)
        .toMatchObject({ skillEvidence: 'none', allowed: false });
      expect(REFUSAL_HINTS[name], name).toBe('claude-only');
      const trial = live.trials.find((candidate) => candidate.id === live.closedList[`/${name}`]?.trial);
      expect(trial?.transcript?.some((entry) => entry.note?.startsWith('This skill can only be invoked by Claude')),
        `${name}: brak odmowy CLI w próbie pomiaru`).toBe(true);
    }
    // Podpowiedź `claude-only` ma dowód: każda jej nazwa to skill z tej próby.
    const claudeOnly = Object.entries(REFUSAL_HINTS).filter(([, hint]) => hint === 'claude-only').map(([name]) => name);
    expect(claudeOnly).toEqual(skills.map(([name]) => name));
  });

  it('słowa wyjścia = słowa, które w pomiarze żywym zakończyły sesję, z wersją tego pomiaru', () => {
    expect([...EXIT_WORDS.words].sort()).toEqual([...live.exitWords.ending].sort());
    expect(EXIT_WORDS.cli).toBe(LIVE_KIND.cli);
  });

  it('`inTurn: silent` has an excerpt of its CLI version with the command\'s entries and no call or output', () => {
    const silent = BUILTIN_COMMANDS.filter((entry) => entry.inTurn?.rule === 'silent');
    expect(silent.map((entry) => entry.name)).toEqual(['rename']);
    for (const entry of silent) {
      const file = `${entry.name}-in-turn-${entry.inTurn?.cli ?? ''}.jsonl`;
      expect(readdirSync(FIXTURES), `${entry.name}: no excerpt ${file}`).toContain(file);
      const lines = read(join(FIXTURES, file)).split('\n').filter((raw) => raw.trim() !== '')
        .map((raw) => JSON.parse(raw) as Record<string, unknown>);
      expect(new Set(lines.filter((line) => 'version' in line).map((line) => line['version'])), entry.name)
        .toEqual(new Set([entry.inTurn?.cli]));
      expect(lines.some((line) => line['type'] === 'custom-title'), entry.name).toBe(true);
      expect(lines.some((line) => line['subtype'] === TRANSCRIPT_ENTRY.localCommand), entry.name).toBe(false);
      expect(JSON.stringify(lines), entry.name).not.toContain(`<${TRANSCRIPT_TAGS.commandName}>`);
    }
  });

  it('przekierowanie argumentu: z faktów docs albo z reguły skill `S` + komenda `S-x` w katalogu sondy', () => {
    for (const entry of BUNDLED_SKILLS) {
      for (const [word, target] of Object.entries(entry.subcommands ?? {})) {
        const fromDocs = docs.redirects.some((redirect) => redirect.command === entry.name
          && redirect.argument === word && redirect.target === target);
        const fromCatalog = docsRows.get(entry.name)?.marker !== undefined && target === `${entry.name}-${word}`
          && catalogNames.has(target);
        expect(fromDocs || fromCatalog, `/${entry.name} ${word} → /${target} bez dowodu`).toBe(true);
      }
    }
    for (const redirect of docs.redirects) {
      const entry = BUNDLED_SKILLS.find((candidate) => candidate.name === redirect.command);
      expect(entry?.subcommands?.[redirect.argument], `${redirect.command} ${redirect.argument}`).toBe(redirect.target);
    }
  });

  it('skill wbudowany ma dowód typu z docs; bez dowodu tylko dwa skille z zamkniętej listy, poza allow-listą', () => {
    for (const entry of BUNDLED_SKILLS) {
      const row = docsRows.get(entry.name);
      if (entry.skillEvidence === 'docs-marker') expect(row?.marker, entry.name).toBeDefined();
      if (entry.skillEvidence === 'docs-text') {
        expect([row !== undefined, row?.marker], entry.name).toEqual([true, undefined]);
      }
      if (entry.skillEvidence === 'none') expect(row, entry.name).toBeUndefined();
    }
    const by = (evidence: string): string[] => BUNDLED_SKILLS.filter((entry) => entry.skillEvidence === evidence)
      .map((entry) => entry.name);
    expect(by('docs-text')).toEqual(['plugin-authoring', 'security-review']);
    expect(by('none')).toEqual(['artifact-design', 'keybindings-help']);
    // Każdy znacznik Skill albo Workflow w docs przy nazwie z katalogu sondy to skill wbudowany rejestru.
    for (const row of docs.commands.filter((candidate) => candidate.marker !== undefined)) {
      expect(by('docs-marker'), row.name).toContain(row.name);
    }
  });

  it('układ dysku: zastrzeżony katalog skilli to tylko `synced` (docs); `.trash` i `.staging` odsiewa skan', () => {
    expect(DISK_LAYOUT.synced.reservedDirs).toEqual(['synced']);
    expect(DISK_LAYOUT.synced.prefix).toBe('anthropic-skills');
  });
});

describe('rejestr komend: literał stoi w JEDNYM katalogu', () => {
  /**
   * Literały CLI poza katalogiem, które zostają ŚWIADOMIE, z powodem — lista zamknięta.
   * `/exit` restartu sesji i składanie `/model`, `/effort` żyją w driverze i managerze.
   */
  const SANCTIONED: Readonly<Record<string, readonly string[]>> = {
    'server/src/drivers/herdr/commands.ts': ["'/exit'"],
  };

  /**
   * Literał jako cały napis w apostrofach albo cudzysłowie. Grawisów nie szukamy: w zdaniach dla
   * użytkownika (`„\`/clear\` — nowa sesja silnika"`) nazwa komendy stoi w grawisach Markdownu.
   */
  const quoted = (text: string): string[] => [`'${text}'`, `"${text}"`];

  const GUARDED: readonly { name: string; needles: readonly string[] }[] = [
    ...Object.entries(TRANSCRIPT_TAGS).map(([key, tag]) => ({ name: `TRANSCRIPT_TAGS.${key}`, needles: [tag] })),
    { name: 'TRANSCRIPT_ENTRY.localCommand', needles: [TRANSCRIPT_ENTRY.localCommand] },
    { name: 'TRANSCRIPT_ENTRY.commandRun', needles: quoted(TRANSCRIPT_ENTRY.commandRun) },
    { name: 'TRANSCRIPT_ENTRY.unknownCommand', needles: [TRANSCRIPT_ENTRY.unknownCommand] },
    { name: 'TRANSCRIPT_ENTRY.didYouMean', needles: [TRANSCRIPT_ENTRY.didYouMean] },
    { name: 'TRANSCRIPT_ENTRY.unknownSkillArgs', needles: [TRANSCRIPT_ENTRY.unknownSkillArgs] },
    // Prompt zakończony przez hook `UserPromptSubmit`. `promptKept` tylko w cudzysłowie:
    // samo słowo może być nazwą pola zdarzenia Raroga, literałem CLI jest klucz wpisu.
    { name: 'TRANSCRIPT_ENTRY.promptSubmitEnding', needles: [TRANSCRIPT_ENTRY.promptSubmitEnding] },
    { name: 'TRANSCRIPT_ENTRY.blockedByHook', needles: [TRANSCRIPT_ENTRY.blockedByHook] },
    { name: 'TRANSCRIPT_ENTRY.stoppedByHook', needles: [TRANSCRIPT_ENTRY.stoppedByHook] },
    { name: 'TRANSCRIPT_ENTRY.promptKept', needles: quoted(TRANSCRIPT_ENTRY.promptKept) },
    { name: 'TRANSCRIPT_ENTRY.originalPrompt', needles: [TRANSCRIPT_ENTRY.originalPrompt] },
    ...EXIT_WORDS.words.filter((word) => word.startsWith(':'))
      .map((word) => ({ name: `EXIT_WORDS ${word}`, needles: quoted(word) })),
    ...BUILTIN_COMMANDS.map((entry) => ({ name: `/${entry.name}`, needles: quoted(`/${entry.name}`) })),
    // Formy komendy ultracode: reszta słów CLI o ultracode stoi w `herdr/ultracode.ts`
    // (strażnik `ultracode-boundary.test.ts`).
    ...Object.entries(ULTRACODE_COMMANDS)
      .map(([key, form]) => ({ name: `ULTRACODE_COMMANDS.${key}`, needles: quoted(form) })),
    // Układ skilli i pluginów na dysku: czyta go wyłącznie `discover.ts` przez `DISK_LAYOUT`.
    { name: 'DISK_LAYOUT.skillFile', needles: quoted(DISK_LAYOUT.skillFile) },
    { name: 'DISK_LAYOUT.plugins.installed', needles: quoted(DISK_LAYOUT.plugins.installed) },
    { name: 'DISK_LAYOUT.plugins.manifestDir', needles: quoted(DISK_LAYOUT.plugins.manifestDir) },
    { name: 'DISK_LAYOUT.settingsKeys.enabledPlugins', needles: quoted(DISK_LAYOUT.settingsKeys.enabledPlugins) },
    { name: 'DISK_LAYOUT.settingsKeys.skillOverrides', needles: quoted(DISK_LAYOUT.settingsKeys.skillOverrides) },
    { name: 'DISK_LAYOUT.frontmatterKeys.userInvocable', needles: quoted(DISK_LAYOUT.frontmatterKeys.userInvocable) },
    // `description` to zbyt pospolite słowo na zakaz; `argument-hint` jest tylko kluczem frontmattera.
    { name: 'DISK_LAYOUT.frontmatterKeys.argumentHint', needles: quoted(DISK_LAYOUT.frontmatterKeys.argumentHint) },
    { name: 'DISK_LAYOUT.synced.prefix', needles: quoted(DISK_LAYOUT.synced.prefix) },
  ];

  it('strażnik widzi literały tam, gdzie stać MAJĄ (inaczej zakaz byłby pusty)', () => {
    const registry = CODE.get(REGISTRY) ?? '';
    for (const { name, needles } of GUARDED.filter((item) => !item.name.startsWith('/'))) {
      expect(needles.some((needle) => registry.includes(needle)), `${name} nie stoi w rejestrze`).toBe(true);
    }
  });

  it('żaden plik `server/src/**` poza katalogiem komend nie powtarza literału CLI o komendach', () => {
    const repeated: string[] = [];
    for (const [file, code] of CODE) {
      if (file.startsWith('server/src/herdr/commands/')) continue;
      const allowed = SANCTIONED[file] ?? [];
      for (const { name, needles } of GUARDED) {
        const hit = needles.find((needle) => code.includes(needle) && !allowed.includes(needle));
        if (hit !== undefined) repeated.push(`${file}: ${name} (${hit})`);
      }
    }
    expect(repeated, 'literał CLI poza rejestrem — weź go z `herdr/commands/registry.ts`').toEqual([]);
  });

  it('wyjątki są potrzebne: każdy stoi jeszcze w swoim pliku', () => {
    for (const [file, needles] of Object.entries(SANCTIONED)) {
      for (const needle of needles) expect(CODE.get(file) ?? '', `${file} nie potrzebuje wyjątku ${needle}`).toContain(needle);
    }
  });
});

describe('rozpoznanie komendy: jedna definicja (`shape.ts`)', () => {
  const SHAPE = 'server/src/herdr/commands/shape.ts';

  it('kształt Raroga dla nazwy komendy stoi w kodzie tylko w `shape.ts`', () => {
    const fragment = '[A-Za-z0-9_][A-Za-z0-9:_-]*';
    expect(CODE.get(SHAPE)).toContain(fragment);
    const others = [...CODE].filter(([file, code]) => file !== SHAPE && code.includes(fragment)).map(([file]) => file);
    expect(others).toEqual([]);
  });

  it('`classifySlashText` jest zdefiniowane tylko w `shape.ts`', () => {
    const definitions = [...CODE].filter(([, code]) => /\bfunction\s+classifySlashText\b/.test(code))
      .map(([file]) => file);
    expect(definitions).toEqual([SHAPE]);
  });

  it('`slashCommandToken` i `isSlashCommandText` zniknęły z produkcji: komendy nie zgaduje się z samego tekstu', () => {
    const hits = [...CODE].filter(([, code]) => /\b(?:slashCommandToken|isSlashCommandText)\b/.test(code))
      .map(([file]) => file);
    expect(hits, 'kształt bez katalogu wraca — weź `classifySlashText` albo `SendOptions.command`').toEqual([]);
  });

  it('driver nie woła reguły sam: bierze klasyfikację z `SendOptions` albo ze strażnika', () => {
    const driver = CODE.get('server/src/drivers/herdr-driver.ts') ?? '';
    expect(driver).not.toMatch(/\bclassifySlashText\b/);
    expect(driver).toMatch(/\bsameSlash\(/);
  });
});

describe('znaczniki pliku rozmowy: każdy literał w fixture pomiaru', () => {
  const fixtureText = readdirSync(FIXTURES).filter((name) => name.endsWith('.jsonl'))
    .map((name) => read(join(FIXTURES, name))).join('\n');
  const WITHOUT = Object.keys(TRANSCRIPT_MEASURED.withoutFixture);

  it.each(Object.entries(TRANSCRIPT_TAGS))('%s („%s") stoi w fixture albo na liście wyjątków', (key, tag) => {
    if (WITHOUT.includes(key)) {
      expect(fixtureText, `${key} stoi już w fixture — zdejmij wyjątek`).not.toContain(`<${tag}>`);
      return;
    }
    expect(fixtureText).toContain(`<${tag}>`);
  });

  it.each(Object.entries(TRANSCRIPT_ENTRY))('%s („%s") stoi w fixture', (_key, literal) => {
    expect(fixtureText).toContain(literal);
  });

  it('lista wyjątków wskazuje istniejące znaczniki i każdy ma powód', () => {
    for (const [key, why] of Object.entries(TRANSCRIPT_MEASURED.withoutFixture)) {
      expect(Object.keys(TRANSCRIPT_TAGS)).toContain(key);
      expect(why.trim()).not.toBe('');
    }
  });
});

describe('import transkryptu: znaczniki z rejestru i wpisy komendy', () => {
  /** Wzorzec `CLI_PLUMBING_TAG` sprzed rejestru (dawniej w `transcript-import.ts`). */
  const OLD = /^\s*<(?:local-command-std(?:out|err)|command-(?:name|message|args)|system-reminder)>/;

  it('rejestr niesie dokładnie te same sześć znaczników', () => {
    expect([...CLI_PLUMBING_TAGS].sort()).toEqual([
      'command-args', 'command-message', 'command-name', 'local-command-stderr', 'local-command-stdout',
      'system-reminder',
    ]);
    for (const tag of CLI_PLUMBING_TAGS) expect(tag).toMatch(/^[a-z-]+$/);
  });

  /*
   * Rozpoznanie komend zmienia los wpisów komendy, nie wiadomości człowieka: wiadomością `user` jest dokładnie to,
   * co przepuszcza dawny wzorzec (`OLD`), a tekst ze znacznikiem komendy daje notkę `system` (wywołanie i wynik komendy
   * lokalnej) albo nic (sam opis, same argumenty, przypomnienie systemowe, zastrzeżenie).
   */
  it('wiadomość człowieka = dawny wzorzec; znacznik komendy daje notkę `system` albo nic', () => {
    const SAMPLES: readonly [string, 'user' | 'system' | null][] = [
      ['<command-name>/plan</command-name>', 'system'], ['  <local-command-stdout>ok</local-command-stdout>', 'system'],
      ['<local-command-stderr>x</local-command-stderr>', 'system'], ['<command-message>m</command-message>', null],
      ['<command-args>a</command-args>', null], ['<system-reminder>r</system-reminder>', null],
      ['<local-command-caveat>c</local-command-caveat>', 'user'], ['zwykły prompt', 'user'], ['/tmp przeczytaj', 'user'],
      ['tekst <command-name>/x</command-name> w środku', 'user'],
    ];
    for (const [text, role] of SAMPLES) {
      const line = JSON.stringify({ type: 'user', timestamp: '2026-10-17T00:00:00.000Z', message: { role: 'user', content: text } });
      const message = parseImportLine(line)?.message ?? null;
      expect(message?.role === 'user', text).toBe(!OLD.test(text));
      expect(message?.role ?? null, text).toBe(role);
    }
  });
});
