/**
 * Strażnik: odczyty plików i spawn gita w `server/src` mają po jednej bramie.
 *
 * (a) Pliki. Agent w sandboksie zapisuje katalog projektu, `.git` i `~/.claude/statusline`, więc pod nazwą, którą
 *     serwer czyta, może stać FIFO, urządzenie albo dowiązanie. Jedyny moduł, który otwiera takie pliki, to
 *     `server/src/safe-read.ts` (O_NONBLOCK, `fstat` na deskryptorze, sufit). Każde UŻYCIE funkcji czytającej
 *     z `fs`, `node:fs` albo `node:fs/promises` (`openSync`, `readFileSync`, `readFile`, `open`, `createReadStream`)
 *     poza nim stoi w `WYJATKI` z powodem: plik leży tam, gdzie sandbox nie pisze (pomiar w `docs/security-model.md`,
 *     „Special files in the project directory”). Powiązania zbieram z linii importu, nie z gołej nazwy: alias
 *     (`readFile as fsReadFile`), przestrzeń nazw (`fs.readFile`), import domyślny i `promises`. Import dynamiczny,
 *     `require` i re-eksport z `fs` są zakazane bez wyjątków.
 * (b) Git. Konfiguracja repo to dane agenta (`core.fsmonitor`, `diff.<drv>.textconv`, `gpg.program`), więc osłony
 *     wstawia JEDYNY runner (`spawnGitArgs` w `git-status.ts`, argv z `gitArgv(command)`). Literał `'git'` stoi
 *     w kodzie raz, na linii spawnu; runner przyjmuje polecenie `GitCommand`, a żaden eksport `git-status.ts`
 *     ani `git-diff.ts` nie bierze surowej tablicy `args`/`argv`.
 *
 * Wpis to CAŁA linia po `trim()` (jak w `cli-bez-binarki-guard.test.ts`), nie numer: zmieniona linia wraca do
 * przeglądu. Wpis bez trafienia albo z inną liczbą trafień niż `ile` też przewraca test. Linie komentarzy
 * (zaczynające się od `*`, `//`, `/*`) nie są kodem i się nie liczą; komentarz na końcu linii kodu się liczy
 * (fałszywy alarm jest widoczny, a cięcie po `//` myliłoby się na adresach w napisach).
 *
 * Negatywne testy biegną na KOPII `server/src` w katalogu tymczasowym: każda mutacja (alias, przestrzeń nazw,
 * surowe argv, drugi spawn) musi przewrócić strażnika, a niezmieniona kopia przechodzi.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scan } from './source-scan.ts';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const SRC = 'server/src';
const HELPER = 'server/src/safe-read.ts';
const RUNNER = 'server/src/git-status.ts';
const GIT_EXPORTS = ['server/src/git-status.ts', 'server/src/git-diff.ts'];

interface Wyjatek {
  readonly plik: string;
  /** Cała linia kodu po `trim()`. */
  readonly linia: string;
  /** Ile linii o tej treści stoi w pliku (domyślnie 1). */
  readonly ile?: number;
  readonly powod: string;
}

function wyjatki(plik: string, powod: string, linie: readonly string[]): Wyjatek[] {
  return linie.map((linia) => ({ plik, linia, powod }));
}

const DATA_DIR = 'katalog danych serwera (`dataDir`, 0700): sandbox agenta go nie zapisuje';
const PROJEKTY = 'transkrypt albo przebieg w `~/.claude/projects`: zapis z sandboksa sesji to odmowa '
  + '(pomiar 2026-10-26, CLI 2.1.311)';
const USTAWIENIA = '`~/.claude/settings.json`: Claude Code chroni pliki ustawień przed zapisem z sandboksa';
const CLAUDE_JSON = '`~/.claude.json`: plik poza katalogami zapisywalnymi z sandboksa; sufit i `isFile` w wołającym';

const WYJATKI: readonly Wyjatek[] = [
  ...wyjatki('server/src/auth/devices-store.ts', DATA_DIR, ["text = readFileSync(file, 'utf8');"]),
  ...wyjatki('server/src/cli/hooks.ts', `${DATA_DIR}; zrzuty \`pending/\` czytane przez \`rarog hooks doctor\``,
    ["const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;"]),
  ...wyjatki('server/src/cli/claude-settings.ts', 'kopia zapasowa i plik tymczasowy pisarza ustawień zakładane '
    + 'z `wx` (O_CREAT|O_EXCL): istniejącej nazwy, także FIFO, nie otwiera; odczyt ustawień idzie przez safe-read.ts',
  ["const fd = openSync(file, 'wx', mode);"]),
  ...wyjatki('server/src/cli/config-rewrite.ts', 'plik tymczasowy `rarog voice-agent set-model` i `rarog setup '
    + '--tailscale` zakładany z `wx` (O_CREAT|O_EXCL): istniejącej nazwy, także FIFO, nie otwiera; odczyt '
    + '`config.json` idzie przez safe-read.ts',
  ["const fd = openSync(file, 'wx', mode);"]),
  ...wyjatki('server/src/cli/lock.ts', 'blokada `rarog restart` zakładana z `wx` (O_CREAT|O_EXCL): istniejącej nazwy, '
    + 'także FIFO, nie otwiera; odczyt blokady idzie przez safe-read.ts', ["fd = openSync(file, 'wx', 0o600);"]),
  ...wyjatki('server/src/companion/condense.ts', PROJEKTY,
    ["const stream = createReadStream(path, { start: skippedBytes, end: size - 1, encoding: 'utf8' });"]),
  ...wyjatki('server/src/config/claude-account.ts', USTAWIENIA,
    ["readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'),"]),
  ...wyjatki('server/src/config/push.ts', 'plik klucza push wskazany w konfiguracji serwera, poza katalogiem projektu; '
    + '`statSync().isFile()` przed odczytem', ["return { mode: stat.mode & 0o777, text: readFileSync(file, 'utf8') };"]),
  ...wyjatki('server/src/herdr/background/incremental-read.ts', PROJEKTY, ["handle = await open(path, 'r');"]),
  ...wyjatki('server/src/herdr/background/agent-file.ts', PROJEKTY,
    ["this.#open = opts.open ?? ((path) => open(path, 'r'));"]),
  ...wyjatki('server/src/herdr/background/main-scan.ts', PROJEKTY,
    ["handle = await (opts.open ?? ((path) => open(path, 'r')))(opts.path);"]),
  ...wyjatki('server/src/herdr/background/workflow-run.ts', PROJEKTY, [
    "handle = await open(join(runDir, 'journal.jsonl'), 'r');",
    "handle = await open(path, 'r');",
  ]),
  ...wyjatki('server/src/herdr/consent-evidence.ts', PROJEKTY, ["handle = await open(path, 'r');"]),
  ...wyjatki('server/src/herdr/hook-config.ts', USTAWIENIA, ["raw = readFileSync(path, 'utf8');"]),
  ...wyjatki('server/src/herdr/hook-config.ts', DATA_DIR, [
    "parsed = JSON.parse(readFileSync(join(dataDir, HOOK_SEEN_FILENAME), 'utf8'));",
    "parsed = JSON.parse(readFileSync(join(dataDir, HOOK_ROOTS_FILENAME), 'utf8'));",
  ]),
  ...wyjatki('server/src/herdr/identity.ts', DATA_DIR, ["parsed = JSON.parse(readFileSync(file, 'utf8'));"]),
  ...wyjatki('server/src/herdr/history-steps.ts', PROJEKTY, ["handle = await open(path, 'r');"]),
  ...wyjatki('server/src/herdr/jsonl-follow.ts', PROJEKTY, [
    "const handle = await (this.#tasksScan.titleOpen ?? ((file: string) => open(file, 'r')))(path);",
  ]),
  ...wyjatki('server/src/herdr/dialogs/hook/dump.ts', DATA_DIR, [
    "raw = readFileSync(path, 'utf8');",
    "entry = pendingSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));",
    "const entry = pendingSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));",
  ]),
  ...wyjatki('server/src/herdr/dialogs/shadow/atomic.ts', `${DATA_DIR}; plik tymczasowy zapisu z \`fsync\` `
    + 'zakładany z `wx` (O_CREAT|O_EXCL): istniejącej nazwy, także FIFO, nie otwiera',
    ["const fd = openSync(path, 'wx', 0o600);"]),
  ...wyjatki('server/src/herdr/session-pulse.ts', PROJEKTY, ["handle = await open(path, 'r');"]),
  ...wyjatki('server/src/herdr/transcript-path.ts', PROJEKTY, ["handle = await open(path, 'r');"]),
  ...wyjatki('server/src/herdr/trust.ts', CLAUDE_JSON,
    ["const readFile = opts.readFile ?? (async (f: string): Promise<string> => fsReadFile(f, 'utf8'));"]),
  ...wyjatki('server/src/index.ts', PROJEKTY, ["const handle = await open(file, 'r');"]),
  ...wyjatki('server/src/install/sdk.ts', 'przypięcie SDK obok modułu (`server/src/install/`): instalacja, nie katalog '
    + 'projektu sesji', [
    "readFileSync(new URL('./sdk-package.json', import.meta.url), 'utf8'),",
    "readFileSync(new URL('./sdk-lock.json', import.meta.url), 'utf8'),",
  ]),
  ...wyjatki('server/src/install/sdk.ts', `${DATA_DIR}; \`package.json\` SDK w \`<katalog danych>/sdk/<wersja>/\` po`
    + ' `realpath` w katalogu wersji', [
    "const manifest: unknown = JSON.parse(readFileSync(inside(base, path.join(pkgDir, 'package.json')), 'utf8'));",
  ]),
  ...wyjatki('server/src/iroh/adapter.ts', '`package.json` paczek iroh w `node_modules` serwera: instalacja, nie katalog projektu sesji',
    ["const version = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }).version;"]),
  ...wyjatki('server/src/notes/store.ts', DATA_DIR, ["raw = readFileSync(path, 'utf8');"]),
  ...wyjatki('server/src/notify/apns-devices.ts', DATA_DIR, ["parsed = JSON.parse(readFileSync(file, 'utf8'));"]),
  ...wyjatki('server/src/sessions/send-registry.ts', DATA_DIR, ["raw = readFileSync(file, 'utf8');"]),
  ...wyjatki('server/src/term/herdr-backend.ts', DATA_DIR, ["raw = JSON.parse(readFileSync(statePath, 'utf8'));"]),
  ...wyjatki('server/src/transcript-import.ts', PROJEKTY, ["handle = await open(path, 'r');"]),
  ...wyjatki('server/src/usage.ts', CLAUDE_JSON, ['const bytes = await readFile(file);']),
  ...wyjatki('server/src/version.ts', '`package.json` repo serwera: checkout, nie katalog projektu sesji',
    ["const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown } | null;"]),
];

const CZYTAJACE = new Set(['openSync', 'readFileSync', 'readFile', 'open', 'createReadStream']);
const FS_MODULE = /^(?:node:)?fs(?:\/promises)?$/;
const CZYTAJACE_ALT = [...CZYTAJACE].join('|');

/** Pliki `.ts` pod `server/src` korzenia `root`: ścieżka względna → treść. */
function zrodla(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) walk(path);
      else if (item.name.endsWith('.ts')) out.set(relative(root, path), readFileSync(path, 'utf8'));
    }
  };
  walk(join(root, SRC));
  return out;
}

interface Powiazania {
  /** Lokalna nazwa funkcji czytającej (także alias). */
  readonly funkcje: Set<string>;
  /** Przestrzeń nazw, import domyślny albo `promises`. */
  readonly przestrzenie: Set<string>;
  /** Naruszenia, których nie znosi żaden wyjątek (import dynamiczny, `require`, re-eksport). */
  readonly zakazane: string[];
}

/**
 * Kod bez komentarzy (`scan(source).code`) zapamiętany po treści pliku. Skan całego `server/src` to ~0,4 s na Macu
 * i ponad 0,8 s na runnerze CI, a test mutacji skanuje kopię kilka razy z rzędu (siedem mutacji = ponad 5 s domyślnego
 * limitu na runnerze CI). Mutacja zmienia jeden plik, więc tylko jego treść skanuje się od nowa;
 * `scan` to czysta funkcja treści, więc wynik jest ten sam.
 */
const kody = new Map<string, string>();
function kod(source: string): string {
  let code = kody.get(source);
  if (code === undefined) {
    code = scan(source).code;
    kody.set(source, code);
  }
  return code;
}

function powiazania(source: string): Powiazania {
  const code = kod(source);
  const funkcje = new Set<string>();
  const przestrzenie = new Set<string>();
  const zakazane: string[] = [];
  for (const m of code.matchAll(/\bimport\s+(?!type\b)([\w$\s{},*]+?)\s+from\s+(['"])([^'"]+)\2/g)) {
    const clause = m[1] ?? '';
    if (!FS_MODULE.test(m[3] ?? '')) continue;
    const star = /\*\s*as\s+([\w$]+)/.exec(clause);
    if (star?.[1] !== undefined) przestrzenie.add(star[1]);
    const def = /^\s*([\w$]+)/.exec(clause);
    if (def?.[1] !== undefined) przestrzenie.add(def[1]);
    const named = /\{([^}]*)\}/.exec(clause);
    for (const part of (named?.[1] ?? '').split(',')) {
      const spec = part.trim().replace(/^type\s+/, '');
      if (spec === '' || part.trim().startsWith('type ')) continue;
      const [orig = '', alias] = spec.split(/\s+as\s+/);
      if (CZYTAJACE.has(orig)) funkcje.add(alias ?? orig);
      // `promises` to przestrzeń `fs/promises`, a `default as fs` — import domyślny pod inną składnią.
      if (orig === 'promises' || orig === 'default') przestrzenie.add(alias ?? orig);
    }
  }
  if (/\b(?:import|require)\s*\(\s*['"`](?:node:)?fs(?:\/promises)?['"`]/.test(code)) {
    zakazane.push('import dynamiczny albo `require` modułu `fs`');
  }
  if (/\bexport\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"](?:node:)?fs(?:\/promises)?['"]/.test(code)) {
    zakazane.push('re-eksport z modułu `fs`');
  }
  return { funkcje, przestrzenie, zakazane };
}

const jestKomentarzem = (trimmed: string): boolean =>
  trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');

const escape = (name: string): string => name.replace(/\$/g, '\\$');

/**
 * Czy linia UŻYWA powiązania. Funkcja: wywołanie albo przekazanie wartości; nie liczy się klucz obiektu
 * i pole interfejsu (`open?:`, `{ open: … }`), `typeof open`, składowa (`opts.open`, `this.#open`) ani napis
 * (`Pick<…, 'open'>`).
 * Przestrzeń nazw: funkcja czytająca jako składowa, wywołana albo przekazana (`fs.readFile(`, `= fs.readFile`,
 * `fs.promises.open`), samo `fs.promises` bez dalszej składowej i goła nazwa (`const { readFile } = fs`), bo
 * destrukturyzacja i przekazanie omijałyby pierwszą regułę.
 */
function uzywa(line: string, p: Powiazania): boolean {
  for (const name of p.funkcje) {
    const re = new RegExp(`(?<![.\\w$#'"\`])${escape(name)}(?![\\w$'"\`])`, 'g');
    for (const m of line.matchAll(re)) {
      const before = line.slice(0, m.index);
      const after = line.slice(m.index + name.length);
      const key = /^\s*\??\s*:/.test(after) && /(?:^|[{,]|\breadonly)\s*$/.test(before);
      const type = /\btypeof\s+$/.test(before);
      if (!key && !type) return true;
    }
  }
  for (const ns of p.przestrzenie) {
    const n = escape(ns);
    const member = `(?<![.\\w$#])${n}\\s*\\.\\s*`;
    if (new RegExp(`${member}(?:promises\\s*\\.\\s*)?(?:${CZYTAJACE_ALT})(?![\\w$])`).test(line)) return true;
    if (new RegExp(`${member}promises(?![\\w$])(?!\\s*\\.)`).test(line)) return true;
    if (new RegExp(`(?<![.\\w$#])${n}(?![\\w$])(?!\\s*\\.)`).test(line)) return true;
  }
  return false;
}

/** Naruszenia reguły (a) i wpisy `WYJATKI` bez pokrycia albo z inną licznością. */
function sprawdzOdczyty(pliki: ReadonlyMap<string, string>, lista: readonly Wyjatek[]): string[] {
  const out: string[] = [];
  const trafione = new Map<Wyjatek, number>();
  for (const [plik, source] of pliki) {
    if (plik === HELPER) continue;
    const p = powiazania(source);
    for (const z of p.zakazane) out.push(`${plik}: ${z}`);
    if (p.funkcje.size === 0 && p.przestrzenie.size === 0) continue;
    let wImporcie = false;
    source.split('\n').forEach((raw, i) => {
      const line = raw.trim();
      // Import wielowierszowy: od `import {` do linii z `from '…'` to lista nazw, nie użycie.
      const importLine = wImporcie || line.startsWith('import ');
      wImporcie = importLine && !/\bfrom\s*['"]|^import\s*['"]/.test(line);
      if (importLine || jestKomentarzem(line) || !uzywa(line, p)) return;
      const wpis = lista.find((w) => w.plik === plik && w.linia === line);
      if (wpis === undefined) out.push(`${plik}:${String(i + 1)}: odczyt z fs poza safe-read.ts bez wyjątku: ${line}`);
      else trafione.set(wpis, (trafione.get(wpis) ?? 0) + 1);
    });
  }
  for (const wpis of lista) {
    const ile = trafione.get(wpis) ?? 0;
    if (ile !== (wpis.ile ?? 1)) {
      out.push(`wpis nieaktualny: ${wpis.plik}: ${wpis.linia} — trafia ${String(ile)} linii, wpis mówi `
        + String(wpis.ile ?? 1));
    }
  }
  return out;
}

/** Naruszenia reguły (b): jedyny spawn gita, argv z `gitArgv`, runner na `GitCommand`, bez eksportu z argv. */
function sprawdzGit(pliki: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  const literaly: string[] = [];
  for (const [plik, source] of pliki) {
    source.split('\n').forEach((raw, i) => {
      const line = raw.trim();
      if (jestKomentarzem(line)) return;
      if (/(['"`])git\1/.test(line)) literaly.push(`${plik}:${String(i + 1)}: ${line}`);
    });
  }
  const spawnLine = literaly.length === 1 ? literaly[0] ?? '' : '';
  if (literaly.length !== 1 || !spawnLine.startsWith(`${RUNNER}:`) || !/\bspawn\(\s*'git'\s*,\s*gitArgv\(command\)\s*,/.test(spawnLine)) {
    out.push(`literał 'git' ma stać raz, w spawnie runnera (${RUNNER}, argv z gitArgv(command)); jest:\n  `
      + (literaly.length === 0 ? '(brak)' : literaly.join('\n  ')));
  }
  const runner = kod(pliki.get(RUNNER) ?? '');
  if (!/\bexport\s+type\s+GitArgsRunner\s*=\s*\(\s*command\s*:\s*GitCommand\s*,/.test(runner)) {
    out.push(`${RUNNER}: GitArgsRunner ma przyjmować (command: GitCommand, …)`);
  }
  const surowe = /\b(?:args|argv)\s*\??\s*:\s*(?:readonly\s+)?(?:string\s*\[\s*\]|(?:Readonly)?Array\s*<\s*string\s*>)/;
  for (const plik of GIT_EXPORTS) {
    const code = kod(pliki.get(plik) ?? '');
    const sygnatury = [
      ...code.matchAll(/\bexport\s+(?:async\s+)?function\s*\*?\s*([\w$]+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/g),
      ...code.matchAll(/\bexport\s+const\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?\(([^)]*)\)/g),
      ...code.matchAll(/\bexport\s+type\s+([\w$]+)\s*=\s*\(([^)]*)\)\s*=>/g),
    ];
    for (const m of sygnatury) {
      if (surowe.test(m[2] ?? '')) out.push(`${plik}: eksport ${m[1] ?? '?'} przyjmuje surową tablicę argv gita`);
    }
  }
  return out;
}

function sprawdz(root: string): string[] {
  const pliki = zrodla(root);
  return [...sprawdzOdczyty(pliki, WYJATKI), ...sprawdzGit(pliki)];
}

describe('strażnik plików zwykłych i jedynego runnera gita: repo', () => {
  it('skaner widzi moduły serwera, helper i runner', () => {
    const pliki = zrodla(REPO);
    expect(pliki.size).toBeGreaterThan(50);
    expect(pliki.has(HELPER)).toBe(true);
    expect(pliki.has(RUNNER)).toBe(true);
  });

  it('odczyty z fs poza safe-read.ts stoją w WYJATKI, a żaden wpis nie jest martwy', () => {
    expect(sprawdzOdczyty(zrodla(REPO), WYJATKI)).toEqual([]);
  });

  it('git: jeden spawn w runnerze, argv z gitArgv, runner bez surowej tablicy', () => {
    expect(sprawdzGit(zrodla(REPO))).toEqual([]);
  });

  it('każdy wyjątek ma powód', () => {
    expect(WYJATKI.filter((w) => w.powod.trim() === '')).toEqual([]);
  });
});

describe('strażnik plików zwykłych: mutacje kopii `server/src` w katalogu tymczasowym', () => {
  let root = '';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'rarog-pliki-zwykle-'));
    await cp(join(REPO, SRC), join(root, SRC), { recursive: true });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Naruszenia kopii po podmianie jednego pliku; plik wraca do oryginału przed końcem. */
  async function poMutacji(plik: string, zmien: (text: string) => string): Promise<string[]> {
    const path = join(root, plik);
    const original = await readFile(path, 'utf8');
    const changed = zmien(original);
    expect(changed).not.toBe(original);
    await writeFile(path, changed);
    try {
      return sprawdz(root);
    } finally {
      await writeFile(path, original);
    }
  }

  const dopisz = (tail: string) => (text: string): string => `${text}\n${tail}\n`;

  it('niezmieniona kopia przechodzi', () => {
    expect(sprawdz(root)).toEqual([]);
  });

  it('import wielowierszowy nie jest użyciem; wywołanie pod nim jest', async () => {
    const out = await poMutacji('server/src/git-watch.ts', dopisz(
      "import {\n  open,\n  readFile as czytaj,\n} from 'node:fs/promises';\nexport const x = czytaj('/a');"));
    expect(out).toEqual([expect.stringContaining("export const x = czytaj('/a');")]);
  });

  it('alias importu (`readFile as czytaj`) przewraca strażnika', async () => {
    const out = await poMutacji('server/src/git-watch.ts', dopisz(
      "import { readFile as czytaj } from 'node:fs/promises';\nexport const x = (): Promise<Buffer> => czytaj('/a');"));
    expect(out).toEqual([expect.stringContaining("server/src/git-watch.ts:")]);
    expect(out[0]).toContain("czytaj('/a')");
  });

  it('przestrzeń nazw, import domyślny i `promises` przewracają strażnika', async () => {
    for (const tail of [
      "import * as fs from 'node:fs';\nexport const x = fs.readFileSync('/a');",
      "import fs from 'fs';\nexport const x = fs.promises.open('/a');",
      "import { promises as p } from 'node:fs';\nexport const x = p.readFile('/a');",
      "import * as fs from 'node:fs';\nconst { readFileSync: r } = fs;\nexport const x = r('/a');",
      // Właściwość przestrzeni nazw jako wartość, `promises` do destrukturyzacji,
      // `default as`.
      "import * as fs from 'node:fs/promises';\nconst czytaj = fs.readFile;",
      "import * as fs from 'node:fs';\nconst { readFile } = fs.promises;",
      "import { default as fs } from 'node:fs';\nexport const x = fs.readFileSync('/a');",
    ]) {
      const out = await poMutacji('server/src/git-watch.ts', dopisz(tail));
      expect(out, tail).toHaveLength(1);
      expect(out[0], tail).toContain('server/src/git-watch.ts:');
    }
  });

  it('przekazanie funkcji jako wartości przewraca; klucz obiektu i `typeof` nie', async () => {
    const passed = await poMutacji('server/src/usage.ts', dopisz('export const io = { czytaj: readFile };'));
    expect(passed).toEqual([expect.stringContaining('export const io = { czytaj: readFile };')]);
    expect(await poMutacji('server/src/usage.ts', dopisz(
      'export interface Io { readonly readFile?: typeof readFile }\n// readFile(x) w komentarzu'))).toEqual([]);
  });

  it('import dynamiczny, `require` i re-eksport z `fs` są zakazane', async () => {
    for (const tail of [
      "export const x = await import('node:fs/promises');",
      "export const x = require('fs');",
      "export { readFile } from 'node:fs/promises';",
      "export * as fs from 'node:fs/promises';",
      "export * from 'node:fs';",
    ]) {
      const out = await poMutacji('server/src/git-watch.ts', dopisz(tail));
      expect(out, tail).toEqual([expect.stringMatching(/^server\/src\/git-watch\.ts: (?:import dynamiczny|re-eksport)/)]);
    }
  });

  it('zmieniona linia z wyjątku: nowe trafienie bez wpisu i wpis nieaktualny', async () => {
    const out = await poMutacji('server/src/version.ts', (text) =>
      text.replace("readFileSync(file, 'utf8')", "readFileSync(file, { encoding: 'utf8' })"));
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('server/src/version.ts:');
    expect(out[1]).toMatch(/^wpis nieaktualny: server\/src\/version\.ts: .* trafia 0 linii/);
  });

  it('runner wołany surowym argv przewraca strażnika', async () => {
    const out = await poMutacji(RUNNER, (text) => text.replace("spawn('git', gitArgv(command),", "spawn('git', [...command.rest],"));
    expect(out).toEqual([expect.stringContaining("literał 'git' ma stać raz")]);
  });

  it('drugi spawn gita albo stała `\'git\'` w innym module przewraca strażnika', async () => {
    for (const tail of [
      "import { spawn } from 'node:child_process';\nspawn('git', ['status']);",
      "export const GIT = 'git';",
    ]) {
      const out = await poMutacji('server/src/git-watch.ts', dopisz(tail));
      expect(out, tail).toEqual([expect.stringContaining('server/src/git-watch.ts:')]);
    }
  });

  it('runner albo eksport przyjmujący tablicę argumentów przewraca strażnika', async () => {
    const typ = await poMutacji(RUNNER, (text) => text.replace(
      'export type GitArgsRunner = (command: GitCommand, cwd: string)', 'export type GitArgsRunner = (args: readonly string[], cwd: string)'));
    expect(typ).toEqual([
      `${RUNNER}: GitArgsRunner ma przyjmować (command: GitCommand, …)`,
      `${RUNNER}: eksport GitArgsRunner przyjmuje surową tablicę argv gita`,
    ]);
    const fn = await poMutacji('server/src/git-diff.ts', dopisz(
      'export function surowy(cwd: string, args: readonly string[]): number { return cwd.length + args.length; }'));
    expect(fn).toEqual(['server/src/git-diff.ts: eksport surowy przyjmuje surową tablicę argv gita']);
  });
});
