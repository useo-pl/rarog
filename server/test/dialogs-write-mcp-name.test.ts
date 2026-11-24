/**
 * Nazwa zgody z bloku na CLI 2.1.322 (opis: `docs/dialogs.md`, „Dialog block”).
 *
 * Trzy luki zrzutów 2.1.322: tytuł „Overwrite file” (zgoda `Write`, która nadpisuje plik), nagłówek `Write` nad krawędzią
 * ekranu (długa treść pliku) i nagłówek MCP z nazwą serwera ze spacją („Claude Docs — Guide Tool: (MCP)”, łącznik
 * claude.ai). Czwarta luka, `Read` z licznikiem „1 of 2”, zostaje bez nazwy: to kolejka dialogów, a zrzut hooka opisuje
 * wtedy drugą prośbę.
 *
 * Nagłówek `Write` nad krawędzią: nazwę daje wyłącznie pytanie CLI pod dolną kreską ramki („Do you want to create
 * <nazwa>?”, „Do you want to overwrite <nazwa>?”). Linia `⏺ Write(…)` stoi nad górną kreską dialogu, więc przy nagłówku
 * nad krawędzią nie jest widoczna: linia tego kształtu na ekranie to treść ramki i nazwy nie daje. Nazwa z pytania
 * jest tylko do wyświetlenia: bez przycisków i bez cyfry na żadnej ścieżce.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sameDialogIdentity } from '../src/herdr/dialogs/screen/identity.ts';
import { parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import type { ScreenDialog } from '../src/herdr/dialogs/screen/parse.ts';
import { mcpServerMatches, mcpTitleMatches, resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const screen = (name: string): string => readFileSync(join(DIR, name), 'utf8');

function replaced(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`brak kotwicy: ${from}`);
  return text.replace(from, to);
}

function dialogOf(text: string): ScreenDialog {
  const dialog = parseOptions(text);
  if (dialog === null) throw new Error('ekran bez dialogu');
  return dialog;
}

const OVERWRITE = screen('measured/zgoda-write-nadpisanie-2.1.322.txt');
/** Zgoda `Write` z treścią wyższą niż panel: nagłówek „Create file” i górna kreska ramki nad krawędzią ekranu. */
const CUT = screen('measured/zgoda-write-dluga-tresc-2.1.322.txt');
const CUT_QUESTION = ' Do you want to create pomiar-dlugi.txt?';
const cutWith = (question: string): string => replaced(CUT, CUT_QUESTION, question);
const MCP_DOCS = screen('measured/zgoda-mcp-2.1.322.txt');
const MCP_DOCS_ARGS = screen('measured/zgoda-mcp-argumenty-2.1.322.txt');
const MCP_CATALOG = screen('dialog-permission-mcp.txt');
const MCP_CATALOG_2_1_293 = screen('measured/zgoda-mcp-2.1.293.txt');

const nameOf = (text: string): { toolName: string | null; identity: unknown } => {
  const dialog = dialogOf(text);
  return { toolName: dialog.toolName, identity: dialog.identity };
};

describe('„Overwrite file” to tytuł zgody `Write`', () => {
  it('zrzut 2.1.322: nazwa `Write` z tytułu bloku', () => {
    expect(nameOf(OVERWRITE)).toEqual({ toolName: 'Write', identity: { kind: 'title', tool: 'Write' } });
  });

  it('wpis jsonl `Write` → ok, wpis `Edit` → rozjazd nazwy', () => {
    expect(resolveOptions(OVERWRITE, { toolName: 'Write' }).status).toBe('ok');
    expect(resolveOptions(OVERWRITE, { toolName: 'Edit' })).toMatchObject({ status: 'mismatch', reason: 'tool-name' });
  });
});

describe('nagłówek `Write` nad krawędzią ekranu: nazwa wyłącznie z pytania pod ramką', () => {
  const FILE_QUESTION = (file: string) => ({ kind: 'file-question', tool: 'Write', file });

  it('„Do you want to create a.txt?” → `Write`', () => {
    expect(nameOf(cutWith(' Do you want to create a.txt?')))
      .toEqual({ toolName: 'Write', identity: FILE_QUESTION('a.txt') });
  });

  it('„Do you want to overwrite a.txt?” → `Write`', () => {
    expect(nameOf(cutWith(' Do you want to overwrite a.txt?')))
      .toEqual({ toolName: 'Write', identity: FILE_QUESTION('a.txt') });
  });

  it('pytanie zawinięte w wąskim panelu → `Write` z nazwą sklejoną spacją', () => {
    expect(nameOf(cutWith(' Do you want to create\n pomiar-dlugi.txt?')))
      .toEqual({ toolName: 'Write', identity: FILE_QUESTION('pomiar-dlugi.txt') });
  });

  it('bez pytania `Write` i bez `⏺ Write(` → brak tożsamości', () => {
    expect(nameOf(cutWith(' Do you want to proceed?'))).toEqual({ toolName: null, identity: { kind: 'form' } });
  });

  it('`⏺ Write(…)` w treści pod krawędzią nie nazywa dialogu', () => {
    const traced = replaced(cutWith(' Do you want to proceed?'), '  47 pomiar-linia-47', '⏺ Write(a.txt)');
    expect(traced.split('\n')[0]).toBe('⏺ Write(a.txt)');
    expect(nameOf(traced)).toEqual({ toolName: null, identity: { kind: 'form' } });
  });

  it('dopisek w strefie pytania albo pusta linia w środku pytania → brak tożsamości', () => {
    for (const zone of [
      ' This command requires approval\n Do you want to create a.txt?',
      ' Do you want to create a.txt?\n This command requires approval',
      ' Do you want to create\n\n a.txt?',
      ' Do you want to create ?',
    ]) {
      expect(nameOf(cutWith(zone)), zone).toEqual({ toolName: null, identity: { kind: 'form' } });
    }
  });

  it('nagłówek widoczny z tytułem spoza mapy: pytanie `Write` nazwy nie daje (zmiana wyglądu CLI = odmowa)', () => {
    const unknownTitle = replaced(OVERWRITE, ' Overwrite file\n', ' Replace file\n');
    expect(nameOf(unknownTitle)).toEqual({ toolName: null, identity: { kind: 'form' } });
  });

  /*
   * Nazwa tylko do wyświetlenia: licznik kolejki stoi w linii nagłówka nad krawędzią, więc ekran nie odróżnia dwóch
   * `Write`. Przebieg przez driver: `dialogs-write-truncated-driver.test.ts`.
   */
  it('wpis jsonl `Write` → rozjazd treści (karta bez przycisków); wpis innego narzędzia → rozjazd nazwy', () => {
    const text = cutWith(' Do you want to create a.txt?');
    expect(resolveOptions(text, { toolName: 'Write' }))
      .toMatchObject({ status: 'mismatch', reason: 'operation', screenToolName: 'Write' });
    expect(resolveOptions(text, { toolName: 'Bash', command: 'true' }))
      .toMatchObject({ status: 'mismatch', reason: 'tool-name', screenToolName: 'Write' });
  });

  it('bez wpisu jsonl: ani formularza zgody z ekranu, ani opcji', () => {
    expect(resolveOptions(cutWith(' Do you want to create a.txt?'), null)).toMatchObject({
      status: 'no-jsonl', knownDialog: null, questionForm: null, options: [],
      dialogIdentity: { kind: 'tool', identity: { kind: 'file-question', tool: 'Write', file: 'a.txt' } },
    });
  });

  it('przed cyfrą `file-question` nie jest równe niczemu, także temu samemu plikowi', () => {
    const stamp = (text: string) => ({ kind: 'tool' as const, identity: dialogOf(text).identity });
    const a = stamp(cutWith(' Do you want to create a.txt?'));
    expect(sameDialogIdentity(a, stamp(cutWith(' Do you want to create a.txt?')))).toBe(false);
    expect(sameDialogIdentity(a, stamp(cutWith(' Do you want to create b.txt?')))).toBe(false);
    expect(sameDialogIdentity(a, { kind: 'tool', identity: { kind: 'title', tool: 'Write' } })).toBe(false);
    expect(sameDialogIdentity({ kind: 'tool', identity: { kind: 'title', tool: 'Write' } }, a)).toBe(false);
  });
});

describe('nagłówek MCP z nazwą serwera ze spacją (łącznik claude.ai)', () => {
  it('zrzuty 2.1.322: serwer „Claude Docs”, tytuł „Guide”', () => {
    for (const text of [MCP_DOCS, MCP_DOCS_ARGS]) {
      expect(dialogOf(text)).toMatchObject({
        toolName: null, mcpServer: 'Claude Docs', mcpTool: 'Guide',
        identity: { kind: 'mcp', server: 'Claude Docs', title: 'Guide' },
      });
    }
  });

  it('„Claude Docs — Guide Tool: (MCP)” wobec `mcp__claude_ai_Claude_Docs__guide` → zgodne', () => {
    for (const text of [MCP_DOCS, MCP_DOCS_ARGS]) {
      expect(resolveOptions(text, { toolName: 'mcp__claude_ai_Claude_Docs__guide' }).status).toBe('ok');
    }
  });

  it('ten sam nagłówek wobec innego serwera albo innego narzędzia → niezgodne', () => {
    for (const toolName of [
      'mcp__claude_ai_Asana__get_me',
      'mcp__claude_ai_Claude_Docs__update',
      // Serwer ze spacją to nazwa łącznika claude.ai: identyfikator bez przedrostka `claude_ai_` nie jest nim.
      'mcp__Claude_Docs__guide',
      'mcp__claude_ai_Claude__guide',
    ]) {
      expect(resolveOptions(MCP_DOCS, { toolName }), toolName).toMatchObject({ status: 'mismatch', reason: 'tool-name' });
    }
  });

  it('stare nagłówki bez spacji: bez zmian', () => {
    for (const text of [MCP_CATALOG, MCP_CATALOG_2_1_293]) {
      expect(dialogOf(text)).toMatchObject({ mcpServer: 'catalog', mcpTool: 'Get Project Tree Layout' });
      expect(resolveOptions(text, { toolName: 'mcp__catalog__catalog_get_project_tree_layout' }).status).toBe('ok');
      expect(resolveOptions(text, { toolName: 'mcp__claude_ai_catalog__catalog_get_project_tree_layout' }))
        .toMatchObject({ status: 'mismatch', reason: 'tool-name' });
    }
  });

  it('`mcpServerMatches`: serwer jednym słowem dosłownie, serwer ze spacją jako łącznik `claude_ai_`', () => {
    expect(mcpServerMatches('mcp__catalog__catalog_get_task', 'catalog')).toBe(true);
    expect(mcpServerMatches('mcp__claude-in-chrome__navigate', 'claude-in-chrome')).toBe(true);
    expect(mcpServerMatches('mcp__claude_ai_Claude_Docs__guide', 'Claude Docs')).toBe(true);
    expect(mcpServerMatches('mcp__claude_ai_catalog__get', 'catalog')).toBe(false);
    expect(mcpServerMatches('mcp__Claude_Docs__guide', 'Claude Docs')).toBe(false);
    expect(mcpServerMatches('mcp__claude_ai_Claude_Docs__guide', 'Claude  Docs')).toBe(false);
    expect(mcpServerMatches('mcp__claude_ai_Claude_Docs__guide', null)).toBe(false);
    expect(mcpServerMatches('Bash', 'Claude Docs')).toBe(false);
  });

  it('nagłówek z podwójną spacją w nazwie serwera nie jest nagłówkiem MCP', () => {
    const doubled = replaced(MCP_DOCS, ' Claude Docs — Guide Tool: (MCP)', ' Claude  Docs — Guide Tool: (MCP)');
    expect(dialogOf(doubled)).toMatchObject({ mcpServer: null, identity: { kind: 'form' } });
  });
});

describe('MCP title: the words of the tool name without the server prefix or of the full tool name', () => {
  it.each([
    ['mcp__firecrawl__firecrawl_scrape', 'Firecrawl scrape', true],
    ['mcp__firecrawl__firecrawl_scrape', 'Scrape', true],
    ['mcp__firecrawl__firecrawl_search', 'Firecrawl web search', false],
    ['mcp__firecrawl__firecrawl_scrape', 'Firecrawl search', false],
    ['mcp__catalog__catalog_get_task', 'Get Task', true],
    ['mcp__catalog__catalog_get_task', 'Catalog get task', true],
  ] as const)('`%s` with the title "%s" → %s', (toolName, title, expected) => {
    expect(mcpTitleMatches(toolName, title)).toBe(expected);
  });

  it('a header whose title repeats the server prefix gets its buttons; the header server still has to match', () => {
    // Header shape from Claude Code 2.1.331: `firecrawl — Firecrawl scrape Tool: (MCP)` for `firecrawl_scrape`.
    const scrape = replaced(
      replaced(MCP_CATALOG, 'catalog — Get Project Tree Layout Tool: (MCP)', 'firecrawl — Firecrawl scrape Tool: (MCP)'),
      'About the catalog — Get Project Tree Layout Tool:', 'About the firecrawl — Firecrawl scrape Tool:',
    );
    expect(dialogOf(scrape)).toMatchObject({ mcpServer: 'firecrawl', mcpTool: 'Firecrawl scrape' });
    expect(resolveOptions(scrape, { toolName: 'mcp__firecrawl__firecrawl_scrape' }).status).toBe('ok');
    for (const toolName of ['mcp__atlas__firecrawl_scrape', 'mcp__firecrawl__firecrawl_search']) {
      expect(resolveOptions(scrape, { toolName }), toolName).toMatchObject({ status: 'mismatch', reason: 'tool-name' });
    }
  });
});
