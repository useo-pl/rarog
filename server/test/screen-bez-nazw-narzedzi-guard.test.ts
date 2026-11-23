/**
 * Strażnik-zapadka „`dialogs/screen/` bez nazw narzędzi”: kod parsera ekranu (`server/src/herdr/dialogs/screen/**`)
 * nie zna nazw narzędzi Claude Code. Ekran daje kształt dialogu i cyfry; nazwa i treść zgody na narzędzie należą
 * do zrzutu hooka. Strażnik szuka dwóch kształtów:
 *
 * - napisu równego nazwie narzędzia z {@link TOOL_NAMES} albo zaczynającego się od `mcp__`;
 * - identyfikatora stałej z nazwą narzędzia ({@link TOOL_CONSTANTS}) — przeniesienie literału do stałej w innym
 *   module nie może zgubić trafienia.
 *
 * Komentarze się nie liczą (`scan()` ze `source-scan.ts`). Markery wyglądu CLI w rejestrze sygnatur (np. tytuł
 * „Bash command”) to tekst ekranu, nie nazwa narzędzia: pasują tylko napisy RÓWNE nazwie.
 *
 * Lista {@link WYJATKI} jest ZAMKNIĘTA: nowe trafienie (para plik, nazwa) jest czerwone, wpis bez trafienia
 * (martwy) też. Lista jest pusta.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT_PLAN_MODE_TOOL } from '@rarog/shared';
import { HOOK_QUESTION_TOOL } from '../src/herdr/dialogs/hook/contract.ts';
import { SANDBOX_NETWORK_TOOL } from '../src/herdr/dialogs/screen/kinds.ts';
import { BASH_TOOL } from '../src/herdr/dialogs/screen/operation.ts';
import { ASK_USER_QUESTION_TOOL } from '../src/herdr/dialogs/screen/resolve.ts';
import { scan, tsFiles } from './source-scan.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = join(REPO, 'server/src/herdr/dialogs/screen');

/**
 * Nazwy narzędzi Claude Code, o które pyta dialog zgody albo formularz, oraz nazwa zastępcza Raroga dla prośby
 * sieci sandboksa (`SandboxNetwork`), która stoi w polu `toolName` dialogu z ekranu.
 */
const TOOL_NAMES = [
  'Agent', 'AskUserQuestion', 'Bash', 'Edit', 'EnterPlanMode', 'ExitPlanMode', 'Glob', 'Grep', 'MultiEdit',
  'NotebookEdit', 'Read', 'SandboxNetwork', 'Skill', 'Task', 'TodoWrite', 'WebFetch', 'WebSearch', 'Write',
] as const;

/** Stałe z nazwą narzędzia, których kod `screen/` używa albo mógłby użyć zamiast literału. */
const TOOL_CONSTANTS = {
  ASK_USER_QUESTION_TOOL, BASH_TOOL, EXIT_PLAN_MODE_TOOL, HOOK_QUESTION_TOOL, SANDBOX_NETWORK_TOOL,
} as const;

interface Wyjatek {
  readonly plik: string;
  /** Nazwy (literał w apostrofach) i stałe, które ten plik dziś niesie. */
  readonly nazwy: readonly string[];
  readonly powod: string;
}

/** Dzisiejsze trafienia w `screen/`. Lista ZAMKNIĘTA: martwy wpis też jest błędem. */
const WYJATKI: readonly Wyjatek[] = [
  {
    plik: 'server/src/herdr/dialogs/screen/block.ts',
    nazwy: ["'Bash'", "'Edit'", "'Write'", "'Read'", "'WebFetch'", "'NotebookEdit'", "'Skill'"],
    powod: 'mapa tytułu bloku na nazwę narzędzia (`TOOL_DIALOG_HEADERS`, `toolNaming`)',
  },
  {
    plik: 'server/src/herdr/dialogs/screen/kinds.ts',
    nazwy: ["'SandboxNetwork'", 'SANDBOX_NETWORK_TOOL'],
    powod: 'nazwa zastępcza dialogu sieci sandboksa',
  },
  {
    plik: 'server/src/herdr/dialogs/screen/operation.ts',
    nazwy: ["'Bash'", 'BASH_TOOL'],
    powod: 'operacja zgody `Bash` (ramka komendy)',
  },
  {
    plik: 'server/src/herdr/dialogs/screen/parse.ts',
    nazwy: ['EXIT_PLAN_MODE_TOOL', 'SANDBOX_NETWORK_TOOL'],
    powod: 'nazwa narzędzia dialogu planu i sieci sandboksa z kształtu ekranu',
  },
  {
    plik: 'server/src/herdr/dialogs/screen/resolve.ts',
    nazwy: ["'AskUserQuestion'", 'ASK_USER_QUESTION_TOOL', 'BASH_TOOL'],
    powod: 'cross-check ekranu z wpisem jsonl i zrzutem hooka po nazwie narzędzia',
  },
];

/** Trafienia w KODZIE pliku: napisy równe nazwie (`'Bash'`, `'mcp__…'`) i identyfikatory stałych z nazwą. */
function trafienia(source: string): string[] {
  const scanned = scan(source);
  const out = new Set<string>();
  for (const { text } of scanned.literals) {
    if ((TOOL_NAMES as readonly string[]).includes(text)) out.add(`'${text}'`);
    else if (text.startsWith('mcp__')) out.add("'mcp__…'");
  }
  for (const name of Object.keys(TOOL_CONSTANTS)) {
    if (new RegExp(`\\b${name}\\b`).test(scanned.skeleton)) out.add(name);
  }
  return [...out].sort();
}

describe('`dialogs/screen/` bez nazw narzędzi (zapadka)', () => {
  it('stałe z nazwą narzędzia mają wartość z listy nazw (inaczej druga forma strażnika szuka czego innego)', () => {
    for (const [name, value] of Object.entries(TOOL_CONSTANTS)) {
      expect(TOOL_NAMES as readonly string[], `${name} = ${value}`).toContain(value);
    }
  });

  it('widzi napis, prefiks MCP i stałą; komentarz i tekst wyglądu CLI się nie liczą', () => {
    const probka = [
      "const a = 'Bash';",
      "const b = `mcp__supabase__query`;",
      'if (toolName === EXIT_PLAN_MODE_TOOL) return null;',
      "// const c = 'Edit';",
      "const d = 'Bash command';",
    ].join('\n');
    expect(trafienia(probka)).toEqual(["'Bash'", "'mcp__…'", 'EXIT_PLAN_MODE_TOOL'].sort());
  });

  it('żaden plik `screen/**` poza listą wyjątków nie zna nazwy narzędzia; lista bez martwych wpisów', () => {
    const uzyte = new Set<string>();
    const obce: string[] = [];
    for (const file of tsFiles(DIR).map((path) => relative(REPO, path))) {
      const wyjatek = WYJATKI.find((w) => w.plik === file);
      for (const nazwa of trafienia(readFileSync(join(REPO, file), 'utf8'))) {
        if (wyjatek?.nazwy.includes(nazwa) === true) {
          uzyte.add(`${file}: ${nazwa}`);
          continue;
        }
        obce.push(`${file}: ${nazwa} — nazwa narzędzia należy do zrzutu hooka, nie do parsera ekranu`);
      }
    }
    expect(obce).toEqual([]);
    const martwe = WYJATKI.flatMap((w) => w.nazwy.map((nazwa) => `${w.plik}: ${nazwa}`))
      .filter((wpis) => !uzyte.has(wpis));
    expect(martwe, 'martwe wyjątki').toEqual([]);
  });
});
