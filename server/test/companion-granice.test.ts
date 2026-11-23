/**
 * Granice modułu agenta głosowego (`server/src/companion/`) — strażnicy „jednego miejsca”, grepowo na kodzie bez
 * komentarzy (`source-scan.ts`), jak `herdr-commands-boundary.test.ts`.
 *
 * - `claude -p` startuje tylko z `companion/cli.ts`: flagi trybu `-p` stoją wyłącznie w rejestrze `cli-literals.ts`,
 *   rejestr importuje tylko `cli.ts`, a program CLI (`claudeCommand`) wołają tylko dwa znane miejsca.
 * - Kod serwera nie importuje niczego ze `scripts/` ani `.development/` (pomiary i notatki właściciela).
 * - Mapa modułów stoi w `index.ts` i w `docs/companion.md`.
 * - The turns route (`turns.ts`, `conversation.ts`) reads the conversation file through the session's history steps
 *   and writes nothing to disk; the session catalog (`catalog.ts`, `asks-owner.ts`) does not touch the file system.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MODEL, PRINT_FLAGS, RATE_LIMIT, STREAM_EVENTS, TRANSCRIPT } from '../src/companion/cli-literals.ts';
import { relativeImports, scan, tsFiles } from './source-scan.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(REPO, 'server/src');
const DIR = join(SRC, 'companion');
const DOC = 'docs/companion.md';
const REGISTRY = 'server/src/companion/cli-literals.ts';
const CLI = 'server/src/companion/cli.ts';

const repoPath = (file: string): string => relative(REPO, file);
const read = (file: string): string => readFileSync(file, 'utf8');

const MODULES = tsFiles(DIR).map(repoPath);
/** Kod (bez komentarzy) każdego pliku `server/src/**`, pod ścieżką względem korzenia repo. */
const CODE = new Map(tsFiles(SRC).map((file) => [repoPath(file), scan(read(file)).code]));

const importsOf = (file: string): string[] => relativeImports(read(join(REPO, file)))
  .map((spec) => repoPath(resolve(dirname(join(REPO, file)), spec)));

describe('companion: moduły i mapa', () => {
  const doc = read(join(REPO, DOC));
  const header = read(join(DIR, 'index.ts'));
  function moduleMap(): string {
    const start = doc.indexOf('\n## Module map');
    expect(start, `${DOC} nie ma sekcji „Module map”`).toBeGreaterThan(-1);
    const rest = doc.slice(start + 1);
    const end = rest.indexOf('\n## ');
    return rest.slice(0, end === -1 ? undefined : end);
  }

  it.each(MODULES)('%s stoi w mapie modułów dokumentu i w `index.ts`', (file) => {
    expect(moduleMap(), `${DOC}: brak \`${file}\``).toContain(`\`${file}\``);
    expect(header, `index.ts: brak \`${relative(DIR, join(REPO, file))}\``)
      .toContain(`\`${relative(DIR, join(REPO, file))}\``);
  });

  it('mapa w dokumencie nie wymienia pliku, którego nie ma', () => {
    const listed = [...moduleMap().matchAll(/`(server\/src\/companion\/[^`]+\.ts)`/g)].map((hit) => hit[1] ?? '');
    expect(listed.length).toBeGreaterThan(0);
    for (const file of listed) expect(MODULES, `${DOC} wymienia nieistniejący ${file}`).toContain(file);
  });
});

describe('companion: `claude -p` startuje tylko z `cli.ts`', () => {
  const PRINT_ONLY = ['--system-prompt-file', '--setting-sources', '--strict-mcp-config', '--no-session-persistence',
    '--disable-slash-commands', '--print'];

  /** Pliki, które flagę CZYTAJĄ z argumentów cudzego procesu (`ps`), a nie startują z nią CLI. */
  const READERS: Readonly<Record<string, readonly string[]>> = {
    '--setting-sources': ['server/src/herdr/dialogs/layer1/hook-list/hook-list.ts'],
  };

  it.each(PRINT_ONLY)('flaga `%s` stoi w kodzie tylko w rejestrze', (flag) => {
    const holders = [...CODE].filter(([, code]) => code.includes(`'${flag}'`) || code.includes(`"${flag}"`))
      .map(([file]) => file).filter((file) => !(READERS[flag] ?? []).includes(file));
    expect(holders).toEqual(flag === '--print' ? [] : [REGISTRY]);
  });

  it('rejestr importują tylko `cli.ts` i `condense.ts`; flagi `-p` i model bierze wyłącznie `cli.ts`', () => {
    const importers = [...CODE.keys()].filter((file) => importsOf(file).includes(REGISTRY)).sort();
    expect(importers).toEqual([CLI, 'server/src/companion/condense.ts']);
    const users = [...CODE].filter(([file, code]) => file !== REGISTRY && /\b(?:PRINT_FLAGS|MODEL)\b/u.test(code))
      .map(([file]) => file);
    expect(users).toEqual([CLI]);
  });

  it('program CLI (`claudeCommand`) wołają tylko `claude agents --json` i `companion/cli.ts`', () => {
    const callers = [...CODE].filter(([, code]) => /\bclaudeCommand\s*\(/u.test(code)).map(([file]) => file).sort();
    expect(callers).toEqual([CLI, 'server/src/live-sessions.ts']);
  });

  it('proces potomny w katalogu startuje tylko w `cli.ts`', () => {
    for (const file of MODULES.filter((name) => name !== CLI)) {
      expect(CODE.get(file), file).not.toMatch(/\b(?:spawn|spawnSync|execFile|execFileSync|exec|fork)\s*\(/u);
      expect(importsOf(file), file).not.toContain('node:child_process');
      expect(CODE.get(file), file).not.toContain('node:child_process');
    }
  });

  it('rejestr nie importuje niczego (same słowa CLI)', () => {
    expect(read(join(REPO, REGISTRY))).not.toMatch(/^import /mu);
  });

  it('every registry entry has the CLI version of its measurement', () => {
    for (const entry of [PRINT_FLAGS, MODEL, STREAM_EVENTS, RATE_LIMIT, TRANSCRIPT]) {
      expect(entry.cli).toMatch(/^\d+\.\d+\.\d+$/u);
    }
  });
});

describe('companion: the turns route reads like the session history; it and the session catalog write nothing', () => {
  const TURNS = 'server/src/companion/turns.ts';
  const TOKEN = 'server/src/companion/conversation.ts';
  const CATALOG = 'server/src/companion/catalog.ts';
  const ASKS_OWNER = 'server/src/companion/asks-owner.ts';

  it('`turns.ts` reads the conversation file only through `herdr/history-steps.ts`, not with its own parser', () => {
    expect(importsOf(TURNS)).toContain('server/src/herdr/history-steps.ts');
    expect(CODE.get(TURNS)).not.toMatch(/\bparseTranscriptTail\s*\(/u);
  });

  it.each([TURNS, TOKEN, CATALOG, ASKS_OWNER])('%s neither imports the file system nor writes a file', (file) => {
    expect(CODE.get(file), file).not.toMatch(/['"]node:fs(?:\/promises)?['"]/u);
    expect(CODE.get(file), file).not.toMatch(/\b(?:writeFile|appendFile|mkdir|rename|unlink|rm|createWriteStream)\w*\s*\(/u);
  });
});

describe('companion: kod serwera nie sięga do warstwy prywatnej', () => {
  it('żaden plik `server/src/**` nie importuje ze `scripts/` ani `.development/`', () => {
    const hits: string[] = [];
    for (const file of CODE.keys()) {
      for (const target of importsOf(file)) {
        if (target.startsWith('scripts/') || target.startsWith('.development/')) hits.push(`${file} → ${target}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('kod katalogu nie wymienia `.development/` ani pomiarów ze `scripts/`', () => {
    for (const file of MODULES) {
      expect(read(join(REPO, file)), file).not.toMatch(/\.development\/|scripts\/measure-/u);
    }
  });
});
