/**
 * Granice warstwy 2 i porządków przed nią (opis:
 * `docs/dialogs.md`, „Dialog block”, „Rules: what must not be relaxed” i „Module map”).
 *
 * Warstwa 2 (`server/src/herdr/dialogs/layer2/`) ma rozpoznawać blok dialogu po kształcie zmierzonym w CLI, bez
 * tożsamości z mapy tytułów i bez wiedzy o narzędziach. Jest czystym kodem nad tekstem ekranu: odczyt i klawisze
 * należą do drivera, konfiguracja do jego zależności. Strażnicy są GREPOWI, jak `herdr-dialogs-boundary.test.ts`,
 * i patrzą na kod bez komentarzy (`scan()` ze `source-scan.ts`):
 *
 * - `layer2/` nie importuje `screen/known.ts` i nie sięga po mapę tytułów, jej odbiorców (także `parseOptions`
 *   i `resolveOptions`) ani sygnatury tytułów, również przez klucz w napisie;
 * - `layer2/` nie zna nazw narzędzi (lista jak w `screen-bez-nazw-narzedzi-guard.test.ts`, pilnowana przed dryfem);
 * - `layer2/` nie woła `readScreen` ani `sendKeys` i nie czyta `process` (także `process.env`);
 * - `optionEscalates` stoi tylko w `dialogs/policy/`: reszta pyta `optionPolicy`;
 * - wzorce kreski bloku (`blockRule`, `blockRuleWithStatus`) czyta tylko `blockTopOf` w `screen/region.ts`;
 * - layer 2 reasons (`LAYER2_WHYS`) are one closed list in `layer2/card.ts`: no other file declares a list of them,
 *   casts a value to `Layer2Why`, or writes a reason literal of its own outside `layer2/` (a reason word that another
 *   vocabulary uses too stands on a closed list with its reason).
 *
 * Obok strażników: testy samej polityki opcji z kanałem i jednej definicji góry bloku.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LAYER2_WHYS } from '../src/herdr/dialogs/layer2/card.ts';
import { optionPolicy } from '../src/herdr/dialogs/policy/option-policy.ts';
import type { OptionFacts } from '../src/herdr/dialogs/policy/option-policy.ts';
import { blockTopOf } from '../src/herdr/dialogs/screen/region.ts';
import { relativeImports, scan, tsFiles } from './source-scan.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = 'server/src';
const LAYER2 = 'server/src/herdr/dialogs/layer2';
const POLICY = 'server/src/herdr/dialogs/policy/';
const REGION = 'server/src/herdr/dialogs/screen/region.ts';
const SIGNATURES = 'server/src/herdr/dialogs/screen/signatures.ts';
const KNOWN = 'server/src/herdr/dialogs/screen/known.ts';

const repoPath = (file: string): string => relative(REPO, file);
const read = (file: string): string => readFileSync(join(REPO, file), 'utf8');

/** Moduły warstwy 2 jako ścieżki repo. */
const LAYER2_FILES = tsFiles(join(REPO, LAYER2)).map(repoPath);

/** Wszystkie moduły serwera jako ścieżki repo. */
const SRC_FILES = tsFiles(join(REPO, SRC)).map(repoPath);

/** Importy względne pliku rozwiązane do ścieżek repo. */
function importsOf(file: string, source: string): string[] {
  return relativeImports(source).map((spec) => repoPath(resolve(dirname(join(REPO, file)), spec)));
}

/**
 * Nazwy sygnatur tytułów zgód i znanych dialogów w rejestrze (`toolDialogHeaderBash`, `knownDialogModel`…). Sama
 * nazwa pola `knownDialog` (bez dalszego członu) nie jest sygnaturą.
 */
const TITLE_SIGNATURE = /\b(?:toolDialogHeader|knownDialog)[A-Z]\w*/u;

/**
 * Mapa tytułów i jej odbiorcy w KODZIE: mapa tytułów zgód (`block.ts`), tabela znanych dialogów (`known.ts`),
 * funkcje, które z nich dają nazwę narzędzia albo znany dialog, i parser całego dialogu (`parseOptions`,
 * `resolveOptions`), który niesie ich wynik w `toolName` i `knownDialog`. Warstwa 2 bierze z parsera tylko
 * `optionRegion`, `blockTopOf` i formułę odcisku. Sygnatury tytułów: nazwą (kropka, destrukturyzacja), a dostęp
 * do rejestru w nawiasach jest zakazany w ogóle, bo klucz bywa wyliczony.
 */
const TITLE_MAP = [
  /\bTOOL_DIALOG_HEADERS\b/u,
  /\bSKILL_DIALOG_TITLE\b/u,
  /\bdialogTitleTool\b/u,
  /\bblockTitleOf\b/u,
  /\bdialogBlock\b/u,
  /\btoolNaming\b/u,
  /\bregionCallTrace\b/u,
  /\bKNOWN_DIALOGS\b/u,
  /\bblockKnownDialog\b/u,
  /\bmatchKnownDialog\b/u,
  /\bparseOptions\b/u,
  /\bresolveOptions\b/u,
  TITLE_SIGNATURE,
  /\bSCREEN_SIGNATURES\s*\??\.?\s*\[/u,
] as const;

/**
 * Naruszenia granicy „bez mapy tytułów” w jednym pliku: import `known.ts`, wzorce {@link TITLE_MAP} w szkielecie
 * (kod bez komentarzy i napisów) i nazwa sygnatury tytułu w napisie (`SCREEN_SIGNATURES["knownDialogModel"]`,
 * klucz trzymany w stałej).
 */
function titleMapHits(file: string, source: string): string[] {
  const { skeleton, literals } = scan(source);
  return [
    ...importsOf(file, source).filter((path) => path === KNOWN).map((path) => `import ${path}`),
    ...TITLE_MAP.filter((pattern) => pattern.test(skeleton)).map((pattern) => pattern.source),
    ...literals.filter(({ text }) => TITLE_SIGNATURE.test(text)).map(({ text }) => `napis '${text}'`),
  ];
}

/**
 * Nazwy narzędzi Claude Code: KOPIA listy z `screen-bez-nazw-narzedzi-guard.test.ts` (import pliku testu
 * uruchomiłby tu jego testy). Test niżej porównuje obie listy, więc dopisek tam bez dopisku tu jest czerwony.
 */
const TOOL_NAMES = [
  'Agent', 'AskUserQuestion', 'Bash', 'Edit', 'EnterPlanMode', 'ExitPlanMode', 'Glob', 'Grep', 'MultiEdit',
  'NotebookEdit', 'Read', 'SandboxNetwork', 'Skill', 'Task', 'TodoWrite', 'WebFetch', 'WebSearch', 'Write',
] as const;

/**
 * Identyfikatory stałych z nazwą narzędzia (ta sama lista co `TOOL_CONSTANTS` strażnika `screen/`, który sprawdza
 * też ich wartości): przeniesienie literału do stałej w innym module nie może zgubić trafienia.
 */
const TOOL_CONSTANTS = [
  'ASK_USER_QUESTION_TOOL', 'BASH_TOOL', 'EXIT_PLAN_MODE_TOOL', 'HOOK_QUESTION_TOOL', 'SANDBOX_NETWORK_TOOL',
] as const;

/** Nazwy narzędzi w KODZIE: napis równy nazwie, napis `mcp__…` albo identyfikator stałej z nazwą. */
function toolNameHits(source: string): string[] {
  const scanned = scan(source);
  const out = new Set<string>();
  for (const { text } of scanned.literals) {
    if ((TOOL_NAMES as readonly string[]).includes(text)) out.add(`'${text}'`);
    else if (text.startsWith('mcp__')) out.add("'mcp__…'");
  }
  for (const name of TOOL_CONSTANTS) {
    if (new RegExp(`\\b${name}\\b`, 'u').test(scanned.skeleton)) out.add(name);
  }
  return [...out].sort();
}

/**
 * Wejście-wyjście panelu i środowisko procesu: odczyt ekranu, klawisze i `process` (także w napisie, np.
 * `'node:process'` albo `globalThis['process']`), więc wzorzec idzie po kodzie z napisami, bez komentarzy.
 */
const IO = [/\breadScreen\b/u, /\bsendKeys\b/u, /\bprocess\b/u] as const;

function ioHits(source: string): string[] {
  const { code } = scan(source);
  return IO.filter((pattern) => pattern.test(code)).map((pattern) => pattern.source);
}

/** Pliki `server/src` spoza `dialogs/policy/`, których kod zna `optionEscalates`. */
function escalationOutsidePolicy(files: ReadonlyMap<string, string>): string[] {
  return [...files].filter(([file, source]) => !file.startsWith(POLICY)
    && /\boptionEscalates\b/u.test(scan(source).skeleton)).map(([file]) => file);
}

/**
 * Kreska bloku: oba wpisy rejestru i stałe z ich wzorcami. Linia kodu (nie komentarza) z którymkolwiek z nich stoi
 * tylko w deklaracji z {@link BLOCK_RULE_READERS} — najbliższej w górę deklaracji w kolumnie 0, jak w
 * `blok-dialogu-guard.test.ts`.
 */
const BLOCK_RULE = [/\bblockRule(?:WithStatus)?\b/u, /\bBLOCK_RULE(?:_WITH_STATUS)?_PATTERN\b/u] as const;

interface Reader {
  readonly plik: string;
  /** Nazwa deklaracji w kolumnie 0, w której trafienie jest dozwolone. */
  readonly w: string;
  readonly powod: string;
}

/** Lista ZAMKNIĘTA: wpis bez trafienia (martwy) też jest błędem. */
const BLOCK_RULE_READERS: readonly Reader[] = [
  { plik: SIGNATURES, w: 'SCREEN_SIGNATURES', powod: 'definicja obu wpisów rejestru' },
  { plik: REGION, w: 'BLOCK_RULE_PATTERN', powod: 'stała z wzorcem gołej kreski' },
  { plik: REGION, w: 'BLOCK_RULE_WITH_STATUS_PATTERN', powod: 'stała z wzorcem kreski ze statusem' },
  { plik: REGION, w: 'blockTopOf', powod: 'jedyna definicja góry bloku' },
];

const DECLARATION =
  /^(?:export\s+)?(?:async\s+)?(?:function\*?\s+|const\s+|let\s+|type\s+|interface\s+|class\s+)(\w+)/u;

const commentLine = (line: string): boolean => {
  const t = line.trim();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
};

/** Najbliższa w górę deklaracja w kolumnie 0 (albo `null`, gdy linia stoi przed pierwszą). */
function declarationAbove(lines: readonly string[], i: number): string | null {
  for (let j = i; j >= 0; j -= 1) {
    const m = DECLARATION.exec(lines[j] ?? '');
    if (m !== null) return m[1] ?? null;
  }
  return null;
}

/** Trafienia kreski bloku: obce (poza listą) i użyte wpisy listy. */
function blockRuleHits(files: ReadonlyMap<string, string>): { foreign: string[]; used: Set<Reader> } {
  const foreign: string[] = [];
  const used = new Set<Reader>();
  for (const [file, source] of files) {
    const lines = source.split('\n');
    lines.forEach((line, i) => {
      if (commentLine(line) || !BLOCK_RULE.some((pattern) => pattern.test(line))) return;
      const w = declarationAbove(lines, i);
      const reader = BLOCK_RULE_READERS.find((r) => r.plik === file && r.w === w);
      if (reader === undefined) foreign.push(`${file}:${i + 1} (w ${w ?? '—'}): ${line.trim()}`);
      else used.add(reader);
    });
  }
  return { foreign, used };
}

const srcSources = (): Map<string, string> => new Map(SRC_FILES.map((file) => [file, read(file)]));

describe('warstwa 2: katalog istnieje (bez niego strażnicy niżej niczego nie bronią)', () => {
  it('`layer2/` ma moduły, a skaner widzi pliki serwera', () => {
    expect(LAYER2_FILES).toContain(`${LAYER2}/stability.ts`);
    expect(SRC_FILES.length).toBeGreaterThan(LAYER2_FILES.length);
  });
});

describe('warstwa 2: bez mapy tytułów i `screen/known.ts`', () => {
  it('widzi import `known.ts`, odbiorcę mapy i sygnaturę tytułu; komentarz się nie liczy', () => {
    const file = `${LAYER2}/probka.ts`;
    const probka = [
      "import { KNOWN_DIALOGS } from '../screen/known.ts';",
      "import { dialogBlock } from '../screen/block.ts';",
      'const t = SCREEN_SIGNATURES.toolDialogHeaderBash.pattern;',
      '// toolNaming(lines) w komentarzu nie jest użyciem',
    ].join('\n');
    expect(titleMapHits(file, probka)).toEqual([
      `import ${KNOWN}`, '\\bdialogBlock\\b', '\\bKNOWN_DIALOGS\\b', TITLE_SIGNATURE.source,
    ]);
    expect(titleMapHits(file, [
      "import { blockTopOf } from '../screen/region.ts';",
      "import { optionRegion } from '../screen/parse.ts';",
      'const known = dialog.knownDialog;',
    ].join('\n'))).toEqual([]);
  });

  it('widzi rozpoznanie przez parser całego dialogu (`parseOptions`, `resolveOptions`)', () => {
    const file = `${LAYER2}/probka.ts`;
    const probka = [
      "import { parseOptions } from '../screen/parse.ts';",
      'const id = parseOptions(text)?.knownDialog;',
    ].join('\n');
    expect(titleMapHits(file, probka)).toEqual(['\\bparseOptions\\b']);
    expect(titleMapHits(file, 'const r = resolveOptions(dialog, pending);')).toEqual(['\\bresolveOptions\\b']);
  });

  it('widzi sygnaturę tytułu w nawiasach, w destrukturyzacji i w stałej z kluczem', () => {
    const file = `${LAYER2}/probka.ts`;
    const BRACKET = '\\bSCREEN_SIGNATURES\\s*\\??\\.?\\s*\\[';
    expect(titleMapHits(file, 'const p = SCREEN_SIGNATURES["knownDialogModel"].pattern;'))
      .toEqual([BRACKET, "napis 'knownDialogModel'"]);
    expect(titleMapHits(file, 'const p = SCREEN_SIGNATURES[key].pattern;')).toEqual([BRACKET]);
    expect(titleMapHits(file, 'const { knownDialogTrust } = SCREEN_SIGNATURES;')).toEqual([TITLE_SIGNATURE.source]);
    expect(titleMapHits(file, "const KEY = 'toolDialogHeaderBash';")).toEqual(["napis 'toolDialogHeaderBash'"]);
  });

  it.each(LAYER2_FILES)('%s nie zna mapy tytułów', (file) => {
    expect(titleMapHits(file, read(file))).toEqual([]);
  });
});

describe('warstwa 2: bez nazw narzędzi', () => {
  it('lista nazw i stałych jest ta sama co w strażniku `screen/` (bez dryfu kopii)', () => {
    const guard = read('server/test/screen-bez-nazw-narzedzi-guard.test.ts');
    const names = /const TOOL_NAMES = \[([\s\S]*?)\] as const;/u.exec(guard)?.[1] ?? '';
    expect([...names.matchAll(/'([^']+)'/gu)].map((m) => m[1]).sort()).toEqual([...TOOL_NAMES].sort());
    const constants = /const TOOL_CONSTANTS = \{([\s\S]*?)\} as const;/u.exec(guard)?.[1] ?? '';
    expect(constants.split(',').map((name) => name.trim()).filter((name) => name !== '').sort())
      .toEqual([...TOOL_CONSTANTS].sort());
  });

  it('widzi napis, prefiks MCP i stałą; komentarz i tekst wyglądu CLI się nie liczą', () => {
    const probka = [
      "const a = 'Bash';",
      'const b = `mcp__supabase__query`;',
      'if (toolName === BASH_TOOL) return null;',
      "// const c = 'Edit';",
      "const d = 'Bash command';",
    ].join('\n');
    expect(toolNameHits(probka)).toEqual(["'Bash'", "'mcp__…'", 'BASH_TOOL'].sort());
  });

  it.each(LAYER2_FILES)('%s nie zna nazwy narzędzia', (file) => {
    expect(toolNameHits(read(file))).toEqual([]);
  });
});

describe('warstwa 2: bez odczytu ekranu, klawiszy i `process`', () => {
  it('widzi `readScreen`, `sendKeys`, `process.env` i import `node:process`; komentarz się nie liczy', () => {
    expect(ioHits('const s = await client.readScreen(pane);')).toEqual(['\\breadScreen\\b']);
    expect(ioHits("void deps.sendKeys(pane, ['1']);")).toEqual(['\\bsendKeys\\b']);
    expect(ioHits('const on = process.env.LAYER2;')).toEqual(['\\bprocess\\b']);
    expect(ioHits("import { env } from 'node:process';")).toEqual(['\\bprocess\\b']);
    expect(ioHits('// readScreen, sendKeys i process.env czyta driver')).toEqual([]);
  });

  it.each(LAYER2_FILES)('%s nie robi wejścia-wyjścia i nie czyta środowiska', (file) => {
    expect(ioHits(read(file))).toEqual([]);
  });
});

describe('`optionEscalates` tylko w `dialogs/policy/`', () => {
  it('widzi użycie poza `policy/`; komentarz się nie liczy', () => {
    const files = new Map([
      [`${POLICY}option-policy.ts`, 'return optionEscalates(label);'],
      ['server/src/herdr/dialogs/screen/resolve.ts', 'const x = optionEscalates(opt.label);'],
      ['server/src/herdr/dialogs/cross-check.ts', '// dawniej `optionEscalates` tutaj'],
    ]);
    expect(escalationOutsidePolicy(files)).toEqual(['server/src/herdr/dialogs/screen/resolve.ts']);
  });

  it('reszta serwera pyta `optionPolicy`, nie słownika eskalacji', () => {
    const files = srcSources();
    expect([...files.keys()].filter((file) => file.startsWith(POLICY)
      && /\boptionEscalates\b/u.test(scan(files.get(file) ?? '').skeleton)).length).toBeGreaterThan(0);
    expect(escalationOutsidePolicy(files)).toEqual([]);
  });
});

describe('kreskę bloku czyta tylko `blockTopOf`', () => {
  it('widzi wpis rejestru i stałą poza listą; komentarz się nie liczy', () => {
    const files = new Map([
      [REGION, [
        'const BLOCK_RULE_PATTERN = SCREEN_SIGNATURES.blockRule.pattern;',
        'export function blockTopOf(lines: string[]): number {',
        '  return lines.findIndex((l) => BLOCK_RULE_PATTERN.test(l));',
        '}',
        'export function inna(line: string): boolean {',
        '  // BLOCK_RULE_PATTERN w komentarzu nie jest użyciem',
        '  return BLOCK_RULE_PATTERN.test(line);',
        '}',
      ].join('\n')],
      ['server/src/herdr/dialogs/screen/excerpt.ts', 'const S = SCREEN_SIGNATURES.blockRuleWithStatus.pattern;'],
    ]);
    const { foreign } = blockRuleHits(files);
    expect(foreign).toEqual([
      `${REGION}:7 (w inna): return BLOCK_RULE_PATTERN.test(line);`,
      'server/src/herdr/dialogs/screen/excerpt.ts:1 (w S): const S = SCREEN_SIGNATURES.blockRuleWithStatus.pattern;',
    ]);
  });

  it('wzorce kreski bloku stoją tylko w rejestrze i w `blockTopOf`; lista bez martwych wpisów', () => {
    const { foreign, used } = blockRuleHits(srcSources());
    expect(foreign).toEqual([]);
    expect(BLOCK_RULE_READERS.filter((r) => !used.has(r)).map((r) => `${r.plik} ${r.w}`)).toEqual([]);
  });
});

/**
 * Layer 2 reason words that other vocabularies of the server use as well, so a literal of them outside `layer2/` is
 * not a layer 2 reason. Closed list: an entry nobody outside `layer2/` uses any more is an error too.
 */
const SHARED_REASON_WORDS: Readonly<Record<string, string>> = {
  frame: 'terminal stream frames (`term/`) and the top frame of layer 1',
  'multi-select': "option block reason (`OptionBlock`) and card reason of today's digit path",
  'terminal-dialog': 'option block reason (`OptionBlock`) and the driver refusal of a terminal-only dialog',
  'too-many': 'route refusal (`routes/sessions.ts`)',
  'screen-changed': "driver refusal of today's digit path",
  'stale-card': "driver refusal of today's digit path",
  hook: 'card source and the send shield',
};

const LAYER2_CARD = `${LAYER2}/card.ts`;
const REASON_LISTS = /\bLAYER2_(?:WHYS|READ_ERRORS|CAUTION|TAP_REFUSALS)\s*=/u;
const REASON_CAST = /\bas\s+Layer2Why\b/u;

/** Breaches of the closed reason list in one file. */
function reasonHits(file: string, source: string): string[] {
  const { skeleton, literals } = scan(source);
  const out: string[] = [];
  if (file !== LAYER2_CARD && REASON_LISTS.test(skeleton)) out.push('reason list');
  if (REASON_CAST.test(skeleton)) out.push('cast to Layer2Why');
  if (!file.startsWith(`${LAYER2}/`)) {
    const own = new Set<string>(LAYER2_WHYS.filter((why) => !Object.hasOwn(SHARED_REASON_WORDS, why)));
    for (const { text } of literals) if (own.has(text)) out.push(`'${text}'`);
  }
  return out;
}

describe('layer 2 reasons: one closed list', () => {
  it('sees a second list, a cast and an own reason literal outside `layer2/`; comments do not count', () => {
    const file = 'server/src/drivers/herdr/step.ts';
    expect(reasonHits(file, "export const LAYER2_WHYS = ['numbering'] as const;"))
      .toEqual(['reason list', "'numbering'"]);
    expect(reasonHits(file, 'const why = raw as Layer2Why;')).toEqual(['cast to Layer2Why']);
    expect(reasonHits(file, "return { why: 'cut-bottom' };")).toEqual(["'cut-bottom'"]);
    expect(reasonHits(file, "if (source === 'hook') return;")).toEqual([]);
    expect(reasonHits(file, "// why: 'cut-bottom' in a comment")).toEqual([]);
    expect(reasonHits(`${LAYER2}/verdict.ts`, "return none('cut-bottom');")).toEqual([]);
  });

  it('no file of the server breaks the closed list', () => {
    const hits = [...srcSources()]
      .flatMap(([file, source]) => reasonHits(file, source).map((hit) => `${file}: ${hit}`));
    expect(hits).toEqual([]);
  });

  it('every shared reason word is a reason and is used outside `layer2/` (no dead entry)', () => {
    const outside = [...srcSources()].filter(([file]) => !file.startsWith(`${LAYER2}/`))
      .flatMap(([, source]) => scan(source).literals.map(({ text }) => text));
    for (const word of Object.keys(SHARED_REASON_WORDS)) {
      expect(LAYER2_WHYS as readonly string[], word).toContain(word);
      expect(outside, word).toContain(word);
    }
  });
});

describe('`optionPolicy`: polityka opcji z kanałem', () => {
  const facts = (over: Partial<OptionFacts> = {}): OptionFacts => ({
    label: 'Posypka', terminalDialog: null, multiSelect: false, notesEditing: false, ...over,
  });

  it('opcja wolna w obu kanałach', () => {
    for (const channel of ['digit', 'hook'] as const) {
      expect(optionPolicy(facts(), channel)).toEqual({ terminalOnly: false, digitBlocked: false, why: null });
    }
  });

  it('eskalacja: `terminalOnly` w obu kanałach, cyfra zablokowana', () => {
    const label = "Yes, and don't ask again for this command";
    expect(optionPolicy(facts({ label }), 'digit'))
      .toEqual({ terminalOnly: true, digitBlocked: true, why: 'escalation' });
    expect(optionPolicy(facts({ label }), 'hook'))
      .toEqual({ terminalOnly: true, digitBlocked: false, why: 'escalation' });
  });

  it('dialog z listy terminalowej ma pierwszeństwo przed eskalacją i blokuje każdą opcję', () => {
    const terminal = facts({ label: 'Yes, switch to auto mode', terminalDialog: 'session-paused-safeguards' });
    expect(optionPolicy(terminal, 'digit'))
      .toEqual({ terminalOnly: true, digitBlocked: true, why: 'terminal-dialog' });
    expect(optionPolicy(facts({ terminalDialog: 'session-paused-safeguards' }), 'hook'))
      .toEqual({ terminalOnly: true, digitBlocked: false, why: 'terminal-dialog' });
  });

  it('wielokrotny wybór i otwarta notatka blokują tylko cyfrę, nie kartę i nie plik hooka', () => {
    expect(optionPolicy(facts({ multiSelect: true }), 'digit'))
      .toEqual({ terminalOnly: false, digitBlocked: true, why: 'multi-select' });
    expect(optionPolicy(facts({ notesEditing: true }), 'digit'))
      .toEqual({ terminalOnly: false, digitBlocked: true, why: 'notes-editing' });
    expect(optionPolicy(facts({ multiSelect: true, notesEditing: true }), 'hook'))
      .toEqual({ terminalOnly: false, digitBlocked: false, why: null });
  });

  it('eskalacja ma pierwszeństwo przed wielokrotnym wyborem', () => {
    expect(optionPolicy(facts({ label: "Yes, and don't ask again", multiSelect: true }), 'digit'))
      .toEqual({ terminalOnly: true, digitBlocked: true, why: 'escalation' });
  });
});

describe('`blockTopOf`: jedna definicja góry bloku', () => {
  const screen = (file: string): string[] => read(`server/test/fixtures/herdr/${file}`).split('\n');
  const RULE = '─'.repeat(20);
  const STATUS = `${'▔'.repeat(20)} ◐ medium · /effort ▔`;

  it('kreska ze wskaźnikiem effortu nad „Switch model?” (CLI 2.1.316) to góra rodzaju `status`, nie goła', () => {
    const lines = screen('kontrolny/potwierdzenie-model-2.1.316.txt');
    const firstOption = lines.findIndex((line) => line.includes('1. Yes, switch to'));
    const rule = lines.findIndex((line) => line.startsWith('▔') && line.includes('/effort'));
    expect(firstOption).toBeGreaterThan(rule);
    expect(rule).toBeGreaterThan(-1);
    expect(blockTopOf(lines, firstOption)).toEqual({ line: rule, kind: 'status' });
    expect(blockTopOf(lines, firstOption, { kinds: ['status'], nearest: true }))
      .toEqual({ line: rule, kind: 'status' });
    expect(blockTopOf(lines, firstOption, { kinds: ['bare'] })).toBeNull();
  });

  it('rodzaj spoza `kinds` szukanie mija, a z `nearest` kończy wynikiem `null`', () => {
    const lines = [STATUS, 'tytuł', RULE, 'treść', '1. Tak'];
    expect(blockTopOf(lines, 4)).toEqual({ line: 2, kind: 'bare' });
    expect(blockTopOf(lines, 4, { kinds: ['status'] })).toEqual({ line: 0, kind: 'status' });
    expect(blockTopOf(lines, 4, { kinds: ['status'], nearest: true })).toBeNull();
    expect(blockTopOf(lines, 2, { kinds: ['bare'] })).toBeNull();
  });

  it('pozioma kreska regionu (ramka `╌╌╌`) nie jest górą, ale przerywa szukanie z `nearest`', () => {
    const lines = [STATUS, 'tytuł', '╌'.repeat(20), '1. Tak'];
    expect(blockTopOf(lines, 3)).toEqual({ line: 0, kind: 'status' });
    expect(blockTopOf(lines, 3, { kinds: ['status'], nearest: true })).toBeNull();
  });

  it('kreska w dowolnej kolumnie; tekst z `▔` w środku albo kreska z nazwą sesji nie są kreską bloku', () => {
    expect(blockTopOf([`   ${RULE}`, '1. Tak'], 1)).toEqual({ line: 0, kind: 'bare' });
    expect(blockTopOf([`tekst ${'▔'.repeat(12)} tekst`, `${'─'.repeat(12)} sesja ─`, '1. Tak'], 2)).toBeNull();
  });
});
