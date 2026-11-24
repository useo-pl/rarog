/**
 * Korpus dowodu wierzchu: produkcyjny `matchTop` na KAŻDYM fixture'ze `fixtures/herdr/` z dialogiem `Bash`,
 * `Edit`, `Write`, `NotebookEdit` i planu, porównany z zamrożoną tabelą wyników.
 * Wiersz tabeli to narzędzie, wariant ogona (linie między dolną kreską ramki a pierwszą opcją), przycięcie ekranu,
 * dół odczytu i wynik dla zrzutu dialogu oraz dla zrzutu innego narzędzia (`Read`): `no` przy wierzchu z pełną
 * tożsamością, `unknown` bez niej. Każda zmiana wyniku to jawna zmiana wiersza tabeli z komentarzem o koszcie.
 *
 * Wariant `[kolejka]` to ten sam ekran `Bash` z licznikiem „1 of 2” dopisanym do linii tytułu bloku (druga droga
 * wierzchu `Bash`). List coverage: the question zone under every `Bash` frame is on the closed list
 * (`screen/bash-zone.ts`), and the bottom of every corpus dialog is on the bottom anchor list; a fixture outside
 * either list stands on that list's explicit exception list with the reason.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import { matchTop } from '../src/herdr/dialogs/layer1/top.ts';
import { bashZoneLines } from '../src/herdr/dialogs/screen/bash-zone.ts';
import { dialogBottomAnchored } from '../src/herdr/dialogs/screen/dialog-bottom.ts';
import { operationText } from '../src/herdr/dialogs/screen/operation.ts';
import { optionRegion, parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import type { ScreenDialog } from '../src/herdr/dialogs/screen/parse.ts';
import { queueOnScreen, queuedTitleToolOnScreen } from '../src/herdr/dialogs/screen/queue.ts';
import { trimmedLines } from '../src/herdr/dialogs/screen/text.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.name.endsWith('.txt') ? [path] : [];
  });
}

const CORPUS_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit', 'ExitPlanMode']);

/**
 * Dialogi korpusu, których narzędzia parser nie nazywa: nagłówek nad krawędzią odczytu albo widok przewinięty
 * (prawdziwy dialog pod krawędzią). Narzędzie z pomiaru, który zapisał fixture.
 */
const UNNAMED: Readonly<Record<string, string>> = {
  'dialog-bash-przewiniety-widok-2.1.295.txt': 'Bash',
  'dialog-bash-uciety-naglowek-2.1.294.txt': 'Bash',
  'measured/zgoda-bash-wysoka-2.1.295.txt': 'Bash',
  'measured/zgoda-bash-wysoka-2.1.328.txt': 'Bash',
  'measured/zgoda-bash-wysoka.txt': 'Bash',
  'refusals/zgoda-edit-uciety-naglowek-63x28.txt': 'Edit',
};

const CWD = '/tmp/projekt';
const PROCEED = 'Do you want to proceed?';
const FOOTER = 'Esc to cancel · Tab to amend';

let seq = 0;
function dumpOf(toolName: string, toolInput: unknown, cwd = CWD): HookCallDump {
  seq += 1;
  return {
    key: `00000000-0000-4000-9000-0000000000e1-${String(seq).padStart(32, '0')}`,
    sessionId: '00000000-0000-4000-9000-0000000000e0', promptId: '00000000-0000-4000-9000-0000000000e1',
    pid: 81_000 + seq, startedAt: 1_000, toolName, toolInput, cwd, at: 1_100,
    inputSha256: canonicalSha256(toolInput), permissionMode: 'default',
  };
}

/** Komenda z transkryptu pomiaru (`<fixture>.command.json` obok fixture'a albo w katalogu głównym). */
function measuredCommand(name: string): string | null {
  const base = name.replace(/\.txt$/u, '');
  for (const candidate of [`${base}.command.json`, `${base.split('/').pop() ?? base}.command.json`]) {
    const path = join(FIXTURES, candidate);
    if (existsSync(path)) return (JSON.parse(readFileSync(path, 'utf8')) as { command: string }).command;
  }
  return null;
}

/** The exact tool input recorded next to a capture (`<capture>.input.json`), or `null` without one. */
function measuredInput(name: string): { toolName: string; input: unknown; cwd: string } | null {
  const path = join(FIXTURES, name.replace(/\.txt$/u, '.input.json'));
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as { toolName: string; input: unknown; cwd: string }
    : null;
}

/** Zrzut prośby, której dialog stoi w fixture'ze (wejście z pomiaru, a bez niego z ekranu). */
function ownDump(name: string, tool: string, dialog: ScreenDialog | null): HookCallDump {
  const measured = measuredInput(name);
  if (measured !== null) return dumpOf(measured.toolName, measured.input, measured.cwd);
  switch (tool) {
    case 'Bash': {
      const frame = dialog?.operation ?? null;
      return dumpOf('Bash', {
        command: measuredCommand(name) ?? (frame === null ? 'true' : operationText(frame)), description: 'Korpus',
      });
    }
    case 'Edit':
      // Pomiary `measured/zgoda-edit*` i zgody `Edit` zestawu kontrolnego zmieniają ten sam plik i tę samą treść.
      return dumpOf('Edit', name.startsWith('measured/zgoda-edit') || name.startsWith('kontrolny/zgoda-edit')
        ? { file_path: `${CWD}/pomiar-dialogow.txt`, old_string: 'stara wartosc', new_string: 'nowa wartosc' }
        : { file_path: '/nie/ma/takiego.txt', old_string: 'a', new_string: 'b' });
    case 'Write':
      return dumpOf('Write', { file_path: `${CWD}/pomiar-dialogow-nowy.txt`, content: 'pomiar\n' });
    case 'NotebookEdit':
      return dumpOf('NotebookEdit', {
        notebook_path: `${CWD}/pomiar.ipynb`, cell_id: 'c1', new_source: 'example', cell_type: 'markdown',
        edit_mode: 'insert',
      });
    default:
      return dumpOf('ExitPlanMode', {
        plan: '# Plan', planFilePath: `/Users/u/.claude/plans/${dialog?.planFile ?? 'brak-stopki.md'}`,
      });
  }
}

/** Wariant ogona: linie między dolną kreską ramki a pierwszą opcją (bez pustych). */
function tailOf(text: string, dialog: ScreenDialog | null): string {
  const lines = trimmedLines(text);
  const found = optionRegion(lines);
  if (found === null || dialog?.operation == null) return 'bez ramki';
  const zone = lines.slice(found.regionStart, found.firstOption).map((line) => line.trim()).filter((line) => line !== '');
  if (zone.length === 1) return 'pytanie';
  if (zone[zone.length - 1] === PROCEED) return `linie CLI (${String(zone.length - 1)}) + pytanie`;
  return `pytanie w ${String(zone.length)} liniach`;
}

/** Przycięcie: ramka cała, bez nagłówka, ucięta; bez ramki blok cały (`single`) albo niepełny. */
function cutOf(text: string, dialog: ScreenDialog | null): string {
  const frame = dialog?.operation ?? null;
  if (frame === null) return queueOnScreen(text).kind === 'unknown' ? 'blok niepełny' : 'cały blok';
  if (!frame.complete) return 'ramka ucięta';
  return frame.headerVisible ? 'cała ramka' : 'ramka bez nagłówka';
}

/** Dół odczytu: ostatnie niepuste linie (opis dla tabeli, niezależny od kodu kotwicy). */
function bottomOf(text: string): string {
  const lines = trimmedLines(text).map((line) => line.trim()).filter((line) => line !== '');
  const label = (last: string, before: string): string => {
    if (last === FOOTER) return 'stopka';
    if (last.startsWith(`${FOOTER} · `)) return 'stopka z dopiskiem';
    if (`${before} ${last}` === FOOTER) return 'stopka zawinięta';
    if (last.startsWith('ctrl+g to edit') || before.startsWith('ctrl+g to edit')) return 'stopka planu';
    return 'inny dół';
  };
  const last = lines[lines.length - 1] ?? '';
  const before = lines[lines.length - 2] ?? '';
  if (/^─{8,} \S(?:.*\S)? ─$/u.test(last)) return `krawędź z nazwą sesji pod: ${label(before, lines[lines.length - 3] ?? '')}`;
  return label(last, before);
}

/**
 * Linia tytułu `Bash` z licznikiem kolejki „1 of 2” (druga droga wierzchu `Bash`); `null` bez tytułu `Bash` i dla
 * ekranu, który już ma licznik.
 */
function queuedVariant(text: string): string | null {
  if (queueOnScreen(text).kind === 'counter') return null;
  const queued = text.replace(/^( Bash command[^\n]*)$/mu, `$1${' '.repeat(20)}1 of 2`);
  return queued === text ? null : queued;
}

interface CorpusEntry {
  readonly key: string;
  readonly name: string;
  readonly tool: string;
  readonly text: string;
}

function corpus(): CorpusEntry[] {
  const out: CorpusEntry[] = [];
  for (const path of files(FIXTURES).sort()) {
    const name = relative(FIXTURES, path);
    const text = readFileSync(path, 'utf8');
    const dialog = parseOptions(text);
    const tool = dialog?.toolName ?? queuedTitleToolOnScreen(text) ?? UNNAMED[name] ?? null;
    if (tool === null || !CORPUS_TOOLS.has(tool)) continue;
    out.push({ key: name, name, tool, text });
    const queued = tool === 'Bash' ? queuedVariant(text) : null;
    if (queued !== null) out.push({ key: `${name} [kolejka]`, name, tool, text: queued });
  }
  return out;
}

function row(entry: CorpusEntry): string {
  const dialog = parseOptions(entry.text);
  const own = matchTop(entry.text, ownDump(entry.name, entry.tool, dialog));
  const other = matchTop(entry.text, dumpOf('Read', { file_path: '/etc/hosts' }));
  return [entry.tool, tailOf(entry.text, dialog), cutOf(entry.text, dialog), bottomOf(entry.text), `${own}/${other}`]
    .join(' · ');
}

/**
 * Zamrożona tabela wyników `matchTop`. Wiersz, którego wynik się zmienił, ma komentarz z powodem kosztu.
 */
const FROZEN: Readonly<Record<string, string>> = {
  'dialog-bash-ask-rule-2.1.295.txt': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'dialog-bash-ask-rule-2.1.295.txt [kolejka]': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'dialog-bash-cytat-2.1.321.txt': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'dialog-bash-cytat-2.1.321.txt [kolejka]': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'dialog-bash-kolejka-licznik-2.1.319.txt': 'Bash · pytanie · cała ramka · stopka · match/no',
  'dialog-bash-licznik-block-2.1.316.txt':
    'Bash · linie CLI (2) + pytanie · cała ramka · krawędź z nazwą sesji pod: stopka · match/no',
  'dialog-bash-licznik-block-2.1.316.txt [kolejka]':
    'Bash · linie CLI (2) + pytanie · cała ramka · krawędź z nazwą sesji pod: stopka · match/no',
  'dialog-bash-opis-telefon-2.1.302.txt': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'dialog-bash-opis-telefon-2.1.302.txt [kolejka]': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'dialog-bash-przewiniety-widok-2.1.295.txt': 'Bash · bez ramki · blok niepełny · inny dół · unknown/unknown',
  'dialog-bash-stechly-read-2.1.295.txt': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'dialog-bash-stechly-read-2.1.295.txt [kolejka]': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'dialog-bash-stechly-read-szeroki-2.1.295.txt': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'dialog-bash-stechly-read-szeroki-2.1.295.txt [kolejka]':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'dialog-bash-subagent-naglowek-2.1.302.txt':
    'Bash · linie CLI (2) + pytanie · cała ramka · stopka z dopiskiem · match/no',
  'dialog-bash-subagent-naglowek-2.1.302.txt [kolejka]':
    'Bash · linie CLI (2) + pytanie · cała ramka · stopka z dopiskiem · match/no',
  'dialog-bash-subagent-telefon-2.1.302.txt':
    'Bash · linie CLI (4) + pytanie · ramka ucięta · stopka z dopiskiem · unknown/unknown',
  'dialog-bash-subagent-uciety-62x29-2.1.309.txt':
    'Bash · linie CLI (3) + pytanie · ramka ucięta · stopka z dopiskiem · unknown/unknown',
  'dialog-bash-uciety-naglowek-2.1.294.txt': 'Bash · linie CLI (3) + pytanie · ramka ucięta · stopka · unknown/unknown',
  'dialog-exitplanmode.txt': 'ExitPlanMode · bez ramki · cały blok · stopka planu · match/no',
  'dialog-permission-ask-rule-auto.txt': 'Bash · bez ramki · cały blok · stopka z dopiskiem · unknown/unknown',
  'dialog-permission-ask-rule-auto.txt [kolejka]':
    'Bash · bez ramki · cały blok · stopka z dopiskiem · unknown/unknown',
  'dialog-permission-cd-advisory-2.1.265.txt': 'Bash · bez ramki · cały blok · stopka · unknown/unknown',
  'dialog-permission-cd-advisory-2.1.265.txt [kolejka]': 'Bash · bez ramki · cały blok · stopka · unknown/unknown',
  'dialog-permission-odczyt-z-projektu-waski.txt': 'Bash · linie CLI (2) + pytanie · cała ramka · stopka · match/no',
  'dialog-permission-odczyt-z-projektu-waski.txt [kolejka]':
    'Bash · linie CLI (2) + pytanie · cała ramka · stopka · match/no',
  'dialog-permission-odczyt-z-projektu.txt': 'Bash · linie CLI (2) + pytanie · cała ramka · stopka · match/no',
  'dialog-permission-odczyt-z-projektu.txt [kolejka]':
    'Bash · linie CLI (2) + pytanie · cała ramka · stopka · match/no',
  'dialog-permission-opis.txt': 'Bash · bez ramki · cały blok · stopka z dopiskiem · unknown/unknown',
  'dialog-permission-opis.txt [kolejka]': 'Bash · bez ramki · cały blok · stopka z dopiskiem · unknown/unknown',
  'dialog-permission-subagent.txt': 'Bash · bez ramki · cały blok · stopka z dopiskiem · unknown/unknown',
  'dialog-permission-subagent.txt [kolejka]': 'Bash · bez ramki · cały blok · stopka z dopiskiem · unknown/unknown',
  'dialog-permission-unsandboxed.txt': 'Bash · bez ramki · cały blok · stopka z dopiskiem · unknown/unknown',
  'dialog-permission-unsandboxed.txt [kolejka]': 'Bash · bez ramki · cały blok · stopka z dopiskiem · unknown/unknown',
  'dialog-permission.txt': 'Bash · bez ramki · cały blok · inny dół · unknown/unknown',
  // Zrzuty zgód zestawu kontrolnego (CLI 2.1.319 i 2.1.321): nowe wiersze, nie zmiana wyniku.
  'kontrolny/zgoda-bash-brace-quote-2.1.321.txt': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-brace-quote-2.1.321.txt [kolejka]':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-brace-quote-default-2.1.321.txt':
    'Bash · linie CLI (1) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-brace-quote-default-2.1.321.txt [kolejka]':
    'Bash · linie CLI (1) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-auto-2.1.319.txt': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-auto-2.1.319.txt [kolejka]':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-auto-2.1.321.txt': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-auto-2.1.321.txt [kolejka]':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-auto-sandbox-2.1.319.txt':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-auto-sandbox-2.1.319.txt [kolejka]':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-auto-sandbox-2.1.321.txt':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-auto-sandbox-2.1.321.txt [kolejka]':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-default-2.1.319.txt': 'Bash · linie CLI (1) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-default-2.1.319.txt [kolejka]':
    'Bash · linie CLI (1) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-default-2.1.321.txt': 'Bash · linie CLI (1) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-default-2.1.321.txt [kolejka]':
    'Bash · linie CLI (1) + pytanie · cała ramka · stopka · match/no',
  // Zysk, nie koszt: `unknown/unknown` → `match/no`, bo `bashZonePermissionRule` przyjmuje regułę w nawiasie
  // („Permission rule Bash(git branch -D *) requires confirmation for this command.”).
  'kontrolny/zgoda-bash-cytat-default-regula-2.1.321.txt':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-default-regula-2.1.321.txt [kolejka]':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-default-sandbox-2.1.319.txt':
    'Bash · linie CLI (1) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-default-sandbox-2.1.319.txt [kolejka]':
    'Bash · linie CLI (1) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-default-sandbox-2.1.321.txt':
    'Bash · linie CLI (1) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-default-sandbox-2.1.321.txt [kolejka]':
    'Bash · linie CLI (1) + pytanie · cała ramka · stopka · match/no',
  // Wariant czysty pomiaru zgód `Bash` (`pomiar:zgody`): nowy wiersz, samo pytanie.
  'kontrolny/zgoda-bash-czysty-2.1.321.txt': 'Bash · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-czysty-2.1.321.txt [kolejka]': 'Bash · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-dangerous-rm-2.1.321.txt':'Bash · linie CLI (1) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-dangerous-rm-2.1.321.txt [kolejka]':
    'Bash · linie CLI (1) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-parser-skipped-2.1.321.txt': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-parser-skipped-2.1.321.txt [kolejka]':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-regula-bash-2.1.321.txt': 'Bash · linie CLI (2) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-regula-bash-2.1.321.txt [kolejka]':
    'Bash · linie CLI (2) + pytanie · cała ramka · stopka · match/no',
  // Zysk, nie koszt: `unknown/unknown` → `match/no`, bo linia „This command requires approval” weszła na listę strefy
  // (`bashZoneApprovalRequired`).
  'kontrolny/zgoda-bash-shell-c-rm-2.1.321.txt': 'Bash · linie CLI (1) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-shell-c-rm-2.1.321.txt [kolejka]':
    'Bash · linie CLI (1) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-shell-c-rm-auto-2.1.321.txt': 'Bash · linie CLI (2) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-shell-c-rm-auto-2.1.321.txt [kolejka]':
    'Bash · linie CLI (2) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-shell-c-rm-pelny-2.1.321.txt':
    'Bash · linie CLI (1) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-shell-c-rm-pelny-2.1.321.txt [kolejka]':
    'Bash · linie CLI (1) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-shell-c-rm-pelny-auto-2.1.321.txt':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-shell-c-rm-pelny-auto-2.1.321.txt [kolejka]':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-shell-expansion-2.1.321.txt': 'Bash · linie CLI (1) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-shell-expansion-2.1.321.txt [kolejka]':
    'Bash · linie CLI (1) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-tilde-2.1.321.txt': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-tilde-2.1.321.txt [kolejka]': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-variable-2.1.321.txt': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-variable-2.1.321.txt [kolejka]':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  // Consent captures on CLI 2.1.328: new rows, not a changed result. The rule line reads `Rule Bash… from command
  // line arguments …` and the removal warning is two new lines, all on the closed zone list.
  'kontrolny/zgoda-bash-cytat-auto-2.1.328.txt': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-auto-2.1.328.txt [kolejka]':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-default-regula-2.1.328.txt':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-default-regula-2.1.328.txt [kolejka]':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-dangerous-rm-2.1.328.txt': 'Bash · linie CLI (2) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-dangerous-rm-2.1.328.txt [kolejka]':
    'Bash · linie CLI (2) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-parser-skipped-2.1.328.txt': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-parser-skipped-2.1.328.txt [kolejka]':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-regula-bash-2.1.328.txt': 'Bash · linie CLI (2) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-regula-bash-2.1.328.txt [kolejka]':
    'Bash · linie CLI (2) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-tilde-2.1.328.txt': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-tilde-2.1.328.txt [kolejka]': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-variable-2.1.328.txt': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-variable-2.1.328.txt [kolejka]':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  // The same rule lines with the rule in the user, project or local project settings (CLI 2.1.328): new rows, the
  // source after `from` is one of the measured phrases on the closed zone list.
  'kontrolny/zgoda-bash-cytat-auto-user-2.1.328.txt': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-auto-user-2.1.328.txt [kolejka]':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-auto-project-2.1.328.txt':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-auto-project-2.1.328.txt [kolejka]':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-auto-local-2.1.328.txt':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-auto-local-2.1.328.txt [kolejka]':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-default-regula-user-2.1.328.txt':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-default-regula-user-2.1.328.txt [kolejka]':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-default-regula-project-2.1.328.txt':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-default-regula-project-2.1.328.txt [kolejka]':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-default-regula-local-2.1.328.txt':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-cytat-default-regula-local-2.1.328.txt [kolejka]':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  // The removal warning on CLI 2.1.328 is one paragraph: in a 99-column pane it flows over two lines with the bar,
  // the second starting mid-sentence, and joins into one listed line.
  'kontrolny/zgoda-bash-dangerous-rm-sredni-2.1.328.txt':
    'Bash · linie CLI (2) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-dangerous-rm-sredni-2.1.328.txt [kolejka]':
    'Bash · linie CLI (2) + pytanie · cała ramka · stopka · match/no',
  // In a 62-column (phone) and a 57-column pane the same paragraph takes four lines with the bar; a barred run joins
  // into one listed line up to the wrap cap, so the top matches.
  'kontrolny/zgoda-bash-dangerous-rm-telefon-2.1.328.txt':
    'Bash · linie CLI (4) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-dangerous-rm-telefon-2.1.328.txt [kolejka]':
    'Bash · linie CLI (4) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-dangerous-rm-waski-2.1.328.txt':
    'Bash · linie CLI (4) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bash-dangerous-rm-waski-2.1.328.txt [kolejka]':
    'Bash · linie CLI (4) + pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-default-2.1.321.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-regula-2.1.321.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'measured/exitplanmode-2.1.258.txt': 'ExitPlanMode · bez ramki · cały blok · stopka planu · match/no',
  'measured/exitplanmode-2.1.278.txt': 'ExitPlanMode · bez ramki · cały blok · stopka planu · match/no',
  'measured/exitplanmode-2.1.293.txt': 'ExitPlanMode · bez ramki · cały blok · stopka planu · match/no',
  'measured/exitplanmode-bez-planu-2.1.293.txt':
    'ExitPlanMode · bez ramki · blok niepełny · inny dół · unknown/unknown',
  'measured/exitplanmode-bez-planu.txt': 'ExitPlanMode · bez ramki · blok niepełny · inny dół · unknown/unknown',
  'measured/exitplanmode.txt': 'ExitPlanMode · bez ramki · cały blok · stopka planu · match/no',
  'measured/zgoda-bash-2.1.258.txt': 'Bash · bez ramki · cały blok · stopka · unknown/unknown',
  'measured/zgoda-bash-2.1.258.txt [kolejka]': 'Bash · bez ramki · cały blok · stopka · unknown/unknown',
  'measured/zgoda-bash-2.1.278.txt': 'Bash · bez ramki · cały blok · stopka · unknown/unknown',
  'measured/zgoda-bash-2.1.278.txt [kolejka]': 'Bash · bez ramki · cały blok · stopka · unknown/unknown',
  'measured/zgoda-bash-2.1.285.txt': 'Bash · bez ramki · cały blok · stopka · unknown/unknown',
  'measured/zgoda-bash-2.1.285.txt [kolejka]': 'Bash · bez ramki · cały blok · stopka · unknown/unknown',
  'measured/zgoda-bash-2.1.293.txt': 'Bash · pytanie · cała ramka · stopka · match/no',
  'measured/zgoda-bash-2.1.293.txt [kolejka]': 'Bash · pytanie · cała ramka · stopka · match/no',
  'measured/zgoda-bash-dluga-linia-2.1.311.txt': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'measured/zgoda-bash-dluga-linia-2.1.311.txt [kolejka]':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'measured/zgoda-bash-komenda-z-kreska-2.1.311.txt': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'measured/zgoda-bash-komenda-z-kreska-2.1.311.txt [kolejka]':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'measured/zgoda-bash-opis-z-kreska-2.1.311.txt': 'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'measured/zgoda-bash-opis-z-kreska-2.1.311.txt [kolejka]':
    'Bash · linie CLI (3) + pytanie · cała ramka · stopka · match/no',
  'measured/zgoda-bash-wysoka-2.1.295.txt': 'Bash · linie CLI (1) + pytanie · ramka ucięta · stopka · unknown/unknown',
  'measured/zgoda-bash-wysoka.txt': 'Bash · linie CLI (1) + pytanie · ramka ucięta · stopka · unknown/unknown',
  // Cost, accepted: `match/no` → `unknown/unknown`. On CLI 2.1.328 the dialog for a path outside the working
  // directories draws a barred sentence with the command and the path above the question ("touch in '<path>' needs
  // approval. The path is outside the working directories for this session ('<cwd>'). …"). That sentence is free
  // text and stays off the closed zone list (`ZONE_EXCEPTIONS`), so this dialog is approved at the desk.
  'measured/zgoda-bash.txt': 'Bash · linie CLI (2) + pytanie · cała ramka · stopka · unknown/unknown',
  'measured/zgoda-bash.txt [kolejka]': 'Bash · linie CLI (2) + pytanie · cała ramka · stopka · unknown/unknown',
  'measured/zgoda-edit-2.1.258.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'measured/zgoda-edit-2.1.278.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'measured/zgoda-edit-2.1.285.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'measured/zgoda-edit-2.1.293.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'measured/zgoda-edit.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'measured/zgoda-notebookedit-2.1.311.txt': 'NotebookEdit · pytanie · cała ramka · stopka · unknown/unknown',
  'measured/zgoda-notebookedit-waski-2.1.311.txt':
    'NotebookEdit · bez ramki · cały blok · stopka zawinięta · unknown/unknown',
  'measured/zgoda-write-2.1.258.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'measured/zgoda-write-2.1.278.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'measured/zgoda-write-2.1.285.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'measured/zgoda-write-2.1.293.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'measured/zgoda-write.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'refusals/zgoda-edit-uciety-naglowek-63x28.txt': 'Edit · bez ramki · blok niepełny · stopka · unknown/unknown',
  'ultracode/zgoda-bash-ultracode-2.1.317.txt': 'Bash · pytanie · cała ramka · stopka · match/no',
  'ultracode/zgoda-bash-ultracode-2.1.317.txt [kolejka]': 'Bash · pytanie · cała ramka · stopka · match/no',
  // Pomiar zgody z telefonu (CLI 2.1.322): nowe zrzuty, ten sam wynik reguły. `zgoda-drugi-edit` to drugi
  // `Edit` tego samego pliku (`posrednia` → `nowa`), a `ownDump` daje mu cudzy plik, stąd `no/no`.
  'measured/exitplanmode-bez-planu-2.1.322.txt':
    'ExitPlanMode · bez ramki · blok niepełny · inny dół · unknown/unknown',
  'measured/zgoda-drugi-edit-2.1.322.txt': 'Edit · pytanie · cała ramka · stopka · no/no',
  'measured/zgoda-edit-2.1.322.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'measured/zgoda-notebookedit-delete-2.1.322.txt': 'NotebookEdit · pytanie · cała ramka · stopka · unknown/unknown',
  'measured/zgoda-notebookedit-insert-2.1.322.txt': 'NotebookEdit · pytanie · cała ramka · stopka · unknown/unknown',
  'measured/zgoda-notebookedit-replace-2.1.322.txt': 'NotebookEdit · pytanie · cała ramka · stopka · unknown/unknown',
  'measured/zgoda-write-2.1.322.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'measured/zgoda-write-dluga-linia-2.1.322.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'measured/zgoda-write-falszywy-naglowek-2.1.322.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'measured/zgoda-write-poza-projektem-2.1.322.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'measured/zgoda-write-waski-2.1.322.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  // Karta 0d planu zgody z telefonu (CLI 2.1.322): nowe wiersze, nie zmiana wyniku. Parser nazywa `Write` z tytułem
  // „Overwrite file” i `Write` z nagłówkiem nad krawędzią (nazwa z pytania pod ramką), więc korpus je czyta. Wierzch
  // `Write` nie ma tożsamości kanału, stąd `unknown/unknown` jak przy każdym `Write`.
  'measured/zgoda-write-dluga-tresc-2.1.322.txt': 'Write · bez ramki · blok niepełny · stopka · unknown/unknown',
  'measured/zgoda-write-dluga-tresc-waski-2.1.322.txt': 'Write · bez ramki · blok niepełny · stopka · unknown/unknown',
  'measured/zgoda-write-nadpisanie-2.1.322.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  // Dialog captures on CLI 2.1.328 (a wide pane): new rows. Plan, `Edit`, `Write` and the tall `Bash` dialog give the
  // same result as their earlier captures; the plain `Bash` dialog gives `unknown/unknown` for the zone sentence
  // above (`ZONE_EXCEPTIONS`).
  'measured/exitplanmode-2.1.328.txt': 'ExitPlanMode · bez ramki · cały blok · stopka planu · match/no',
  'measured/exitplanmode-bez-planu-2.1.328.txt':
    'ExitPlanMode · bez ramki · blok niepełny · inny dół · unknown/unknown',
  'measured/zgoda-bash-2.1.328.txt': 'Bash · linie CLI (2) + pytanie · cała ramka · stopka · unknown/unknown',
  'measured/zgoda-bash-2.1.328.txt [kolejka]':
    'Bash · linie CLI (2) + pytanie · cała ramka · stopka · unknown/unknown',
  'measured/zgoda-bash-wysoka-2.1.328.txt': 'Bash · linie CLI (1) + pytanie · ramka ucięta · stopka · unknown/unknown',
  'measured/zgoda-edit-2.1.328.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'measured/zgoda-write-2.1.328.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  // Queue take-back measurement on CLI 2.1.328 (a 26-column pane): a `Write` dialog before and after `up`. The footer
  // wraps on the narrow pane, so the top reads the whole block without a frame and the channel identity stays
  // `unknown/unknown` like every `Write`; `up` moves the highlight but does not change the top.
  'queue/measured/zabranie-dialog-po-up-2.1.328.txt': 'Write · pytanie w 2 liniach · cała ramka · stopka zawinięta · unknown/unknown',
  'queue/measured/zabranie-dialog-przed-2.1.328.txt': 'Write · pytanie w 2 liniach · cała ramka · stopka zawinięta · unknown/unknown',
  // Wrapped-line captures on CLI 2.1.330 (57, 99 and 119 columns), each with its exact tool input
  // (`<capture>.input.json`). A wrapped line joins back under the measured geometry (`frameFileLines`), so every
  // `Edit` capture whose frame proves its own call is `match`; the others (`digits`, a character off the closed list)
  // stay `unknown`. Another tool is `no` against the full `Edit` identity. `Write` has no channel identity.
  // `fake-frame` (a frame rule and a dialog title inside a file line) and `hunks` (`replace_all` with a note under
  // the hunk) give no full `Edit` identity either, so another tool is `unknown` there too.
  'kontrolny/zgoda-edit-wrap-change-119-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-change-57-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-change-99-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-claude-md-57-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-digits-119-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · unknown/no',
  'kontrolny/zgoda-edit-wrap-digits-57-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · unknown/no',
  'kontrolny/zgoda-edit-wrap-digits-99-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · unknown/no',
  'kontrolny/zgoda-edit-wrap-fake-frame-119-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-edit-wrap-fake-frame-57-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-edit-wrap-fake-frame-99-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-edit-wrap-geo-119-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-geo-57-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-geo-99-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-hunks-119-2.1.330.txt': 'Edit · pytanie · cała ramka · inny dół · unknown/unknown',
  'kontrolny/zgoda-edit-wrap-hunks-57-2.1.330.txt': 'Edit · pytanie · cała ramka · inny dół · unknown/unknown',
  'kontrolny/zgoda-edit-wrap-hunks-99-2.1.330.txt': 'Edit · pytanie · cała ramka · inny dół · unknown/unknown',
  'kontrolny/zgoda-edit-wrap-ideo-119-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · unknown/no',
  'kontrolny/zgoda-edit-wrap-ideo-57-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · unknown/no',
  'kontrolny/zgoda-edit-wrap-ideo-99-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · unknown/no',
  'kontrolny/zgoda-edit-wrap-line10-119-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-line10-57-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-line10-99-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-line100-119-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-line100-57-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-line100-99-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-nbsp-119-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-nbsp-57-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-nbsp-99-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-nfd-119-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · unknown/no',
  'kontrolny/zgoda-edit-wrap-nfd-57-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · unknown/no',
  'kontrolny/zgoda-edit-wrap-nfd-99-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · unknown/no',
  'kontrolny/zgoda-edit-wrap-polish-119-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-polish-57-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-polish-99-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-space-both-119-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-space-both-57-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-space-both-99-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-space-w-119-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-space-w-57-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-space-w-99-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-space-after-119-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-space-after-57-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-space-after-99-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-tab-119-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-tab-57-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-tab-99-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-edit-wrap-wide-119-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · unknown/no',
  'kontrolny/zgoda-edit-wrap-wide-57-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · unknown/no',
  'kontrolny/zgoda-edit-wrap-wide-99-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · unknown/no',
  'kontrolny/zgoda-edit-wrap-zwsp-119-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · unknown/no',
  'kontrolny/zgoda-edit-wrap-zwsp-57-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · unknown/no',
  'kontrolny/zgoda-edit-wrap-zwsp-99-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · unknown/no',
  'kontrolny/zgoda-write-wrap-digits-119-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-digits-57-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-digits-99-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-fake-frame-119-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-fake-frame-57-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-fake-frame-99-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-geo-119-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-geo-57-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-geo-99-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-ideo-119-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-ideo-57-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-ideo-99-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-line10-119-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-line10-57-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-line10-99-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-nbsp-119-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-nbsp-57-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-nbsp-99-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-nfd-119-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-nfd-57-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-nfd-99-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-polish-119-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-polish-57-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-polish-99-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-space-both-119-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-space-both-57-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-space-both-99-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-space-w-119-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-space-w-57-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-space-w-99-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-space-after-119-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-space-after-57-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-space-after-99-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-tab-119-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-tab-57-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-tab-99-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-wide-119-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-wide-57-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-wide-99-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-zwsp-119-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-zwsp-57-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  'kontrolny/zgoda-write-wrap-zwsp-99-2.1.330.txt': 'Write · pytanie · cała ramka · stopka · unknown/unknown',
  // Consent captures with and without the hook on CLI 2.1.330 (`zgoda-bez-hooka-…`): new rows, not a changed result.
  // `edit-relative-cd` edits `sub/notes.txt` after `cd sub` in `Bash`, so the dialog shows `notes.txt` relative to
  // `sub`, while `<capture>.input.json` records the session directory as `cwd`: the path does not resolve to the
  // call's file, so the top has no full identity there.
  'kontrolny/zgoda-bez-hooka-bash-control-2.1.330.txt': 'Bash · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bez-hooka-bash-control-2.1.330.txt [kolejka]': 'Bash · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bez-hooka-bash-hooks-off-2.1.330.txt': 'Bash · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bez-hooka-bash-hooks-off-2.1.330.txt [kolejka]': 'Bash · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bez-hooka-claude-md-default-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bez-hooka-claude-md-default-link-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bez-hooka-edit-relative-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
  'kontrolny/zgoda-bez-hooka-edit-relative-cd-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · unknown/no',
  'kontrolny/zgoda-bez-hooka-settings-target-auto-2.1.330.txt': 'Edit · pytanie · cała ramka · stopka · match/no',
};

/** Stopka bez ramki operacji z układu sprzed CLI 2.1.286: droga wierzchu i tak nie ma ramki. */
const OLD_LAYOUT = 'stopka z „ctrl+e to explain” z układu bez ramki operacji (sprzed CLI 2.1.286)';
const REPLACE_ALL_FOOTER = 'CLI 2.1.330: an `Edit` with places the frame does not show opens its footer with '
  + '"One-time Yes only: places not shown", which is not on the bottom anchor list';

/** Dialogi korpusu, których dół nie jest na liście kotwicy dołu (`screen/dialog-bottom.ts`), z powodem. */
const BOTTOM_EXCEPTIONS: Readonly<Record<string, string>> = {
  'dialog-bash-przewiniety-widok-2.1.295.txt': 'widok przewinięty: prawdziwy dialog pod krawędzią odczytu',
  'dialog-permission-ask-rule-auto.txt': OLD_LAYOUT,
  'dialog-permission-opis.txt': OLD_LAYOUT,
  'dialog-permission-subagent.txt': OLD_LAYOUT,
  'dialog-permission-unsandboxed.txt': OLD_LAYOUT,
  'dialog-permission.txt': 'dialog w ramce `╭╮` sprzed CLI 2.1.286, stopka małymi literami, bez ramki operacji',
  'measured/exitplanmode-bez-planu-2.1.293.txt': 'dialog planu bez pliku planu nie ma stopki z nazwą pliku',
  'measured/exitplanmode-bez-planu-2.1.322.txt': 'dialog planu bez pliku planu nie ma stopki z nazwą pliku',
  'measured/exitplanmode-bez-planu-2.1.328.txt': 'dialog planu bez pliku planu nie ma stopki z nazwą pliku',
  'measured/exitplanmode-bez-planu.txt': 'dialog planu bez pliku planu nie ma stopki z nazwą pliku',
  'kontrolny/zgoda-edit-wrap-hunks-119-2.1.330.txt': REPLACE_ALL_FOOTER,
  'kontrolny/zgoda-edit-wrap-hunks-57-2.1.330.txt': REPLACE_ALL_FOOTER,
  'kontrolny/zgoda-edit-wrap-hunks-99-2.1.330.txt': REPLACE_ALL_FOOTER,
};

/**
 * Fixtures with a `Bash` frame whose question zone is not on the closed list (`screen/bash-zone.ts`), with the
 * reason. Such a dialog gets no identity on the top match, so it is approved at the desk.
 */
const OUTSIDE_PATH_ZONE = 'CLI 2.1.328: the sentence for a path outside the working directories carries the command '
  + 'and the path (free text), so it stays off the closed zone list';
const ZONE_EXCEPTIONS: Readonly<Record<string, string>> = {
  'measured/zgoda-bash-2.1.328.txt': OUTSIDE_PATH_ZONE,
  'measured/zgoda-bash.txt': OUTSIDE_PATH_ZONE,
};

describe('korpus wierzchu: produkcyjny `matchTop` na fixture\'ach `Bash`, `Edit`, `Write`, `NotebookEdit` i planu', () => {
  const entries = corpus();

  it('korpus czyta fixture\'y każdego narzędzia i każdy dialog bez nazwy z listy', () => {
    const tools = new Set(entries.map((entry) => entry.tool));
    expect([...tools].sort()).toEqual([...CORPUS_TOOLS].sort());
    for (const name of Object.keys(UNNAMED)) {
      expect(existsSync(join(FIXTURES, name)), name).toBe(true);
      const text = readFileSync(join(FIXTURES, name), 'utf8');
      // Dialog bez nazwy: parser nie zna narzędzia, więc wpis listy nie zasłania nazwy z ekranu.
      expect(parseOptions(text)?.toolName ?? queuedTitleToolOnScreen(text) ?? null, name).toBeNull();
    }
  });

  it('wynik `matchTop` na każdym fixture\'ze równy zamrożonej tabeli (z wierszami kosztu)', () => {
    const actual = Object.fromEntries(entries.map((entry) => [entry.key, row(entry)]));
    expect(actual).toEqual(FROZEN);
  });

  it('the question zone of every fixture with a `Bash` frame is on the closed list or on the exception list', () => {
    const outside: string[] = [];
    for (const entry of entries) {
      if (entry.tool !== 'Bash' || entry.key !== entry.name) continue;
      const lines = trimmedLines(entry.text);
      const found = optionRegion(lines);
      if (found === null || parseOptions(entry.text)?.operation == null) continue;
      if (bashZoneLines(lines.slice(found.regionStart, found.firstOption)) === null) outside.push(entry.name);
    }
    expect(outside.sort()).toEqual(Object.keys(ZONE_EXCEPTIONS).sort());
  });

  it('dół każdego dialogu korpusu jest na liście kotwicy dołu (plan: stopka z nazwą pliku) albo na liście wyjątków',
    () => {
      const wrong: string[] = [];
      for (const entry of entries) {
        if (entry.key !== entry.name) continue;
        const anchored = entry.tool === 'ExitPlanMode'
          ? parseOptions(entry.text)?.planFile != null
          : dialogBottomAnchored(trimmedLines(entry.text));
        if (anchored === (BOTTOM_EXCEPTIONS[entry.name] !== undefined)) {
          wrong.push(`${entry.name}: kotwica ${String(anchored)}`);
        }
      }
      expect(wrong).toEqual([]);
      for (const name of Object.keys(BOTTOM_EXCEPTIONS)) expect(entries.some((entry) => entry.name === name), name).toBe(true);
    });
});
