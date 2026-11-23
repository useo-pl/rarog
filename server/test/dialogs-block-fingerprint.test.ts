/**
 * Odcisk BLOKU dialogu przed cyfrą dla pytań, potwierdzeń i znanych dialogów (`bodyPrint`).
 *
 * A card with a button keeps the hash of the dialog block from the screen it came from, and `#digitStillHolds` in the
 * driver requires the same hash from a fresh read right before the key. Without the block print two confirmations
 * with “Yes” under digit 1 would both pass the label and digit check.
 *
 * Reguła (`parseOptions`, `server/src/herdr/dialogs/screen/parse.ts`): rodzaj `question`, `confirm` i `other`, blok
 * nie jest niejednoznaczny, a górą odcisku jest kreska bloku tuż nad regionem opcji albo, gdy jej tam nie ma,
 * najbliższa nad pierwszą opcją kreska ze statusem sesji (`blockRuleWithStatus`). Treść: linie spod góry do końca
 * ekranu; linia opcji po zdjęciu ramki i znacznika wyboru, reszta dosłownie, licznik auto-odmowy pusty. Zgoda
 * (`tool`) liczy odcisk jak przedtem, a przyciski kart bez jsonl i hooka przypina plik złoty. Opis:
 * `docs/dialogs.md`, „Dialog block”.
 *
 * Plik złoty `fixtures/herdr/karty-korpusu.json` produkuje ten test: `RAROG_FIXTURES_WRITE=1` go nadpisuje, bez niej
 * test porównuje. Odcisk z modułu sprawdzają tu mutacje ekranu i własna kopia reguły, nie kod modułu.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEMP_DIR } from '../../scripts/lib/private-patterns.mjs';
import { decideCard } from '../src/herdr/dialogs/decide/decide.ts';
import { evaluationReqId } from '../src/herdr/dialogs/decide/sources.ts';
import type { DecidedShield, DecideInput } from '../src/herdr/dialogs/decide/input.ts';
import { screenDialogCard } from '../src/herdr/dialogs/cards/build.ts';
import type { ActiveReq } from '../src/herdr/dialogs/cards/build.ts';
import { screenFormReqId } from '../src/herdr/dialogs/cards/ids.ts';
import { parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import { snippet } from '../src/herdr/dialogs/screen/snippet.ts';
import { shadowCardEligible } from '../src/herdr/dialogs/shadow/channel.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const GOLDEN = join(DIR, 'karty-korpusu.json');
const WRITE = process.env.RAROG_FIXTURES_WRITE === '1';
const MARK = '\n--- ekran ---\n';

/** Ekran fixture'u; zrzut odmowy (`refusals/`) ma nad ekranem nagłówek `klucz: wartość`. */
function screenOf(name: string): string {
  const raw = readFileSync(join(DIR, name), 'utf8');
  const at = raw.indexOf(MARK);
  return at < 0 ? raw : raw.slice(at + MARK.length);
}

/** Korpus ekranów: `.txt` w katalogu fixture'ów, w `measured/` i w `refusals/`. */
const CORPUS = ['', 'measured/', 'refusals/'].flatMap((sub) => readdirSync(join(DIR, sub))
  .filter((name) => name.endsWith('.txt'))
  .map((name) => `${sub}${name}`))
  .sort();

/** Wejście decyzji bez jsonl i bez hooka, jak w driverze po ponowionym odczycie. */
function input(text: string, decided: DecidedShield | null = null): DecideInput {
  return {
    pending: null,
    hookPending: null,
    text,
    reqId: evaluationReqId(null, null, null, 1),
    active: null,
    blockedSeq: 1,
    answeredSeq: -1,
    hookAnswersEnabled: true,
    deadAnswerKey: null,
    canRetry: false,
    answeredHookCall: null,
    decided,
    resolve: resolveOptions,
    excerpt: (value: string) => snippet(value)?.text ?? null,
    hookRaw: null,
  };
}

/** Rzut karty do pliku złotego: to, co decyduje o przyciskach. */
interface CardShot {
  readonly event: string;
  readonly reqId: string;
  readonly toolName: string;
  readonly knownDialog: string | null;
  readonly options: readonly { digit: string; label: string; terminalOnly?: true }[];
  readonly bodyPrint?: string | null;
}

/** Karta, jaką driver wystawiłby nad tym ekranem bez jsonl i bez hooka; `null` = ocena bez karty. */
function cardOf(text: string): { active: ActiveReq; event: string; knownDialog: string | null } | null {
  const action = decideCard(input(text));
  if (action.kind === 'card') return { active: action.card.active, event: action.card.event.type, knownDialog: null };
  if (action.kind !== 'screen-dialog') return null;
  const card = screenDialogCard(action.reqId, action.resolved, action.reason, action.screen, null, action.origin);
  return { active: card.active, event: card.event.type, knownDialog: card.knownDialog };
}

/**
 * Etykieta w pliku złotym z zamaskowanym katalogiem tymczasowym macOS (wzorzec strażnika
 * `private-patterns-guard.test.ts`): zgoda na odczyt z katalogu pomiaru niesie go w etykiecie, a nowy plik nie ma
 * prawa podnieść zapadki. Resztę etykiety i `reqId` (liczony z pełnej etykiety) plik przypina dalej.
 */
const goldenLabel = (label: string): string => label.replace(TEMP_DIR, '/var/<folders>/');

function shotOf(name: string): CardShot | null {
  const text = screenOf(name);
  const card = cardOf(text);
  if (card === null || !card.active.options.some((option) => option.terminalOnly !== true)) return null;
  const tool = parseOptions(text)?.kind === 'tool';
  return {
    event: card.event,
    reqId: card.active.reqId,
    toolName: card.active.toolName,
    knownDialog: card.knownDialog,
    options: card.active.options.map((option) => ({
      digit: option.digit,
      label: goldenLabel(option.label),
      ...(option.terminalOnly === true ? { terminalOnly: true as const } : {}),
    })),
    ...(tool ? { bodyPrint: card.active.bodyPrint ?? null } : {}),
  };
}

describe('przyciski kart bez jsonl i bez hooka bez zmian (plik złoty)', () => {
  const produced: Record<string, CardShot> = {};
  for (const name of CORPUS) {
    const shot = shotOf(name);
    if (shot !== null) produced[name] = shot;
  }
  if (WRITE) writeFileSync(GOLDEN, `${JSON.stringify(produced, null, 2)}\n`);
  const stored = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, CardShot>;

  it('ten sam zbiór ekranów z przyciskiem co w pliku złotym', () => {
    expect(Object.keys(produced)).toEqual(Object.keys(stored));
    expect(Object.keys(stored).length).toBeGreaterThan(50);
  });

  it.each(Object.keys(stored))('%s: rodzaj zdarzenia, `reqId`, nazwa, znany dialog, opcje (odśwież: RAROG_FIXTURES_WRITE=1)',
    (name) => {
      expect(produced[name]).toEqual(stored[name]);
    });
});

// ---------------------------------------------------------------------------
// Własna kopia reguły odcisku — niezależna od modułów `dialogs/screen/`
// ---------------------------------------------------------------------------

const HEX16 = /^[0-9a-f]{16}$/;
/** Goła kreska bloku: `───` albo `▔▔▔` (kreska bloku tuż nad regionem opcji to góra odcisku). */
const BARE_RULE = /^(?:─{8,}|▔{8,})$/;
/** Kreska ze statusem sesji przed końcem, jak nad widokiem `/help` (CLI 2.1.310). */
const STATUS_RULE = /^▔{8,} [^▔]+ ▔+$/;
const OPTION = /^\d\.\s+\S/;

/** Linie jak po `trimmedLines`: bez końcowych spacji, bez pustych brzegów. */
function ownLines(text: string): string[] {
  const lines = text.split('\n').map((line) => line.replace(/[ \t]+$/, ''));
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return lines;
}

/** Linia bez krawędzi ramki i bez znacznika wyboru. */
function ownUnbox(line: string): string {
  return line.trim().replace(/^[│┃|]\s?/, '').replace(/\s*[│┃|]$/, '').trim()
    .replace(/^[❯▶▸>*·↓↑]\s+/, '').trim();
}

/** Indeks linii opcji `1.` dialogu: ostatnia taka linia ekranu (lista numerowana w scrollbacku stoi wyżej). */
function firstOptionLine(lines: readonly string[]): number {
  return lines.findLastIndex((line) => /^1\.\s/.test(ownUnbox(line)));
}

/** Góra odcisku według reguły 1: ostatnia goła kreska bloku nad pierwszą opcją. */
function bareTop(lines: readonly string[]): number {
  return lines.slice(0, firstOptionLine(lines)).findLastIndex((line) => BARE_RULE.test(line.trim()));
}

/** Odcisk spod linii `top`: linia opcji po zdjęciu ramki i znacznika, reszta dosłownie. */
function ownPrint(lines: readonly string[], top: number): string {
  const body = lines.slice(top + 1).map((line) => (OPTION.test(ownUnbox(line)) ? ownUnbox(line) : line)).join('\n');
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

const printOf = (text: string): string | null => parseOptions(text)?.bodyPrint ?? null;

/**
 * Ekrany rodzaju `question`, `confirm` i `other` BEZ odcisku: region opcji nie zaczyna się pod kreską bloku
 * (`model-set-inline` bez kreski, `zgoda-webfetch` z gołą kreską nad nagłówkiem i drugą nad pytaniem, wąskie zgody
 * 2.1.311 czytane jako `other`), a kreski ze statusem nad opcjami nie ma. Zgody `WebFetch` z subagenta (CLI 2.1.322,
 * tytuł „Fetch · from the web-fetch agent”, bez linii reguły i bez stopki) mają ten sam kształt: ramka `╌╌╌` z `url:`
 * i `prompt:` stoi między kreską bloku a pytaniem, więc region opcji nie zaczyna się pod kreską i odcisku nie ma.
 */
const WITHOUT = new Set([
  'measured/zgoda-notebookedit-waski-2.1.311.txt',
  'measured/zgoda-webfetch-2.1.311.txt',
  'measured/zgoda-webfetch-2.1.322.txt',
  'measured/zgoda-webfetch-prompt-wieloliniowy-2.1.322.txt',
  'measured/zgoda-webfetch-waski-2.1.311.txt',
  'measured/zgoda-webfetch-waski-2.1.322.txt',
  'model-set-inline-2.1.258.txt',
]);

/** Ekrany z odciskiem bloku: rodzaj spoza `tool`, poza {@link WITHOUT}. Lista z rodzaju, nie z odcisku modułu. */
const PRINTED = CORPUS.filter((name) => {
  const dialog = parseOptions(screenOf(name));
  return dialog !== null && dialog.kind !== 'tool' && !WITHOUT.has(name);
});

describe('odcisk bloku na korpusie', () => {
  const stored = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, CardShot>;

  it('zbiór ekranów z odciskiem: 48 pytań, 7 potwierdzeń, `dialog-trust.txt` i picker `/model`', () => {
    const kinds = PRINTED.map((name) => parseOptions(screenOf(name))?.kind);
    expect(kinds.filter((kind) => kind === 'question')).toHaveLength(48);
    expect(kinds.filter((kind) => kind === 'confirm')).toHaveLength(7);
    expect(PRINTED.filter((name) => parseOptions(screenOf(name))?.kind === 'other'))
      .toEqual(['dialog-trust.txt', 'measured/picker-model-2.1.312-26kol.txt']);
  });

  it.each(PRINTED)('%s: 16 znaków hex, równe własnej kopii reguły', (name) => {
    const lines = ownLines(screenOf(name));
    const print = printOf(screenOf(name));
    expect(print).toMatch(HEX16);
    expect(print).toBe(ownPrint(lines, bareTop(lines)));
  });

  it.each([...WITHOUT])('%s: bez odcisku', (name) => {
    expect(parseOptions(screenOf(name))?.kind).not.toBe('tool');
    expect(printOf(screenOf(name))).toBeNull();
  });

  it('zgoda na narzędzie: odcisk z pliku złotego', () => {
    const tools = Object.keys(stored).filter((name) => parseOptions(screenOf(name))?.kind === 'tool');
    expect(tools.length).toBeGreaterThan(30);
    for (const name of tools) expect(printOf(screenOf(name)), name).toBe(stored[name]?.bodyPrint ?? null);
  });

  it('pickery 2.1.312 w panelu 26 kolumn: `/model` z odciskiem spod gołej `▔`, `/effort` bez opcji', () => {
    const model = screenOf('measured/picker-model-2.1.312-26kol.txt');
    const lines = ownLines(model);
    expect(lines[bareTop(lines)]).toMatch(/^▔+$/);
    expect(printOf(model)).toBe(ownPrint(lines, bareTop(lines)));
    expect(parseOptions(screenOf('measured/picker-effort-2.1.312-26kol.txt'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mutacje bloku, scrollback, kursor i licznik, etykiety
// ---------------------------------------------------------------------------

/** Linie ekranu i góra odcisku według własnej reguły. */
function blockOf(name: string): { lines: string[]; top: number } {
  const lines = ownLines(screenOf(name));
  return { lines, top: bareTop(lines) };
}

const joinLines = (lines: readonly string[]): string => lines.join('\n');
const isOption = (line: string): boolean => OPTION.test(ownUnbox(line));

/** Podmiana pierwszej litery (albo, bez litery, pierwszej cyfry) na inną; `null`, gdy linia nie ma żadnej. */
function substituted(line: string): string | null {
  const at = line.search(/\p{L}/u);
  if (at >= 0) {
    const char = line[at] ?? '';
    const next = char === 'q' ? 'z' : char === 'Q' ? 'Z' : char === char.toUpperCase() ? 'Q' : 'q';
    return line.slice(0, at) + next + line.slice(at + 1);
  }
  const digit = line.search(/\d/);
  if (digit < 0) return null;
  return line.slice(0, digit) + String((Number(line[digit]) + 1) % 10) + line.slice(digit + 1);
}

/** Linia z prefiksem `prefix` wstawionym przed treścią (wcięcie zostaje). */
function prefixed(line: string, prefix: string): string {
  const indent = /^\s*/.exec(line)?.[0] ?? '';
  return `${indent}${prefix}${line.slice(indent.length)}`;
}

describe('każda zmiana linii bloku daje inny odcisk', () => {
  it.each(PRINTED)('%s', (name) => {
    const { lines, top } = blockOf(name);
    const original = printOf(joinLines(lines));
    expect(original).toBe(ownPrint(lines, top));
    const at = (index: number, line: string): string[] => lines.map((value, i) => (i === index ? line : value));
    let kept = 0;
    let total = 0;
    for (let i = top + 1; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (line.trim() === '') continue;
      const variants: string[][] = [lines.filter((_, j) => j !== i)];
      const swapped = substituted(line);
      if (swapped !== null) variants.push(at(i, swapped));
      if (!isOption(line)) {
        variants.push(at(i, ` ${line}`));
        if (line.startsWith(' ')) variants.push(at(i, line.slice(1)));
        // Prefiksy, które `unbox` zdejmuje: odcisk ma je odróżniać na linii spoza opcji.
        for (const [a, b] of [['* ', '> '], ['↑ ', '↓ '], ['· ', '▸ ']] as const) {
          const left = printOf(joinLines(at(i, prefixed(line, a))));
          const right = printOf(joinLines(at(i, prefixed(line, b))));
          expect(left, `${name}:${i} ${a}`).toMatch(HEX16);
          expect(left, `${name}:${i} ${a}↔${b}`).not.toBe(right);
        }
      }
      for (const variant of variants) {
        const print = printOf(joinLines(variant));
        total += 1;
        if (print !== null) kept += 1;
        expect(print, `${name}:${i}`).not.toBe(original);
      }
    }
    // Mutacje mają trafiać w odcisk, a nie w rozpoznanie dialogu: większość zostawia dialog z odciskiem.
    expect(kept / total).toBeGreaterThan(0.8);
  });

  it('usunięcie ostatniej opcji: lista 1..n−1 jest kompletna, a odcisk inny', () => {
    const { lines } = blockOf('dialog-effort-change.txt');
    const last = lines.findLastIndex((line) => isOption(line));
    const shorter = lines.filter((_, i) => i !== last);
    expect(parseOptions(joinLines(shorter))?.options.map((option) => option.label)).toEqual(['Yes, switch to high']);
    expect(printOf(joinLines(shorter))).toMatch(HEX16);
    expect(printOf(joinLines(shorter))).not.toBe(printOf(joinLines(lines)));
  });
});

describe('zmiana w scrollbacku nad górą odcisku go nie zmienia', () => {
  it.each(PRINTED.filter((name) => blockOf(name).top > 0))('%s', (name) => {
    const { lines, top } = blockOf(name);
    const original = printOf(joinLines(lines));
    for (let i = 0; i < top; i += 1) {
      const swapped = substituted(lines[i] ?? '');
      if (swapped === null) continue;
      expect(printOf(joinLines(lines.map((line, j) => (j === i ? swapped : line)))), `${name}:${i}`).toBe(original);
    }
  });
});

describe('kursor i licznik auto-odmowy odcisku nie zmieniają', () => {
  /** Ekran z `❯` przeniesionym na inną linię opcji, w tej samej kolumnie; `null`, gdy się nie da. */
  function cursorMoved(lines: readonly string[], top: number): string[] | null {
    const from = lines.findIndex((line, i) => i > top && isOption(line) && line.includes('❯'));
    if (from < 0) return null;
    const column = (lines[from] ?? '').indexOf('❯');
    const to = lines.findIndex((line, i) => i > top && i !== from && isOption(line)
      && line.slice(column, column + 2) === '  ');
    if (to < 0) return null;
    return lines.map((line, i) => {
      if (i === from) return `${line.slice(0, column)} ${line.slice(column + 1)}`;
      if (i === to) return `${line.slice(0, column)}❯${line.slice(column + 1)}`;
      return line;
    });
  }

  const movable = PRINTED.filter((name) => {
    const { lines, top } = blockOf(name);
    return cursorMoved(lines, top) !== null;
  });

  it('kursor da się przenieść na większości ekranów z odciskiem', () => {
    expect(movable.length).toBeGreaterThan(30);
  });

  it.each(movable)('%s: `❯` na innej opcji', (name) => {
    const { lines, top } = blockOf(name);
    const moved = cursorMoved(lines, top) ?? [];
    expect(joinLines(moved)).not.toBe(joinLines(lines));
    expect(printOf(joinLines(moved))).toMatch(HEX16);
    expect(printOf(joinLines(moved))).toBe(printOf(joinLines(lines)));
  });

  it('licznik auto-odmowy 1:58 → 1:57 w bloku potwierdzenia', () => {
    const lines = ownLines(screenOf('dialog-effort-change.txt'));
    const at = lines.findIndex((line) => line.includes('Your next response will be slower'));
    const withCountdown = (time: string): string => joinLines([
      ...lines.slice(0, at + 1),
      `   ⚠ Claude Code will automatically deny this request in ${time}, to avoid blocking progress on an unattended`,
      '   session.',
      ...lines.slice(at + 1),
    ]);
    const before = printOf(withCountdown('1:58'));
    expect(before).toMatch(HEX16);
    expect(printOf(withCountdown('1:57'))).toBe(before);
    expect(parseOptions(withCountdown('1:57'))?.kind).toBe('confirm');
  });
});

describe('odczyt z etykietami karty daje ten sam odcisk', () => {
  it.each(PRINTED)('%s', (name) => {
    const text = screenOf(name);
    const dialog = parseOptions(text);
    const labels = dialog?.options.map((option) => ({ label: option.label, description: option.description }));
    expect(dialog?.bodyPrint).toMatch(HEX16);
    expect(parseOptions(text, { labels })?.bodyPrint).toBe(dialog?.bodyPrint);
  });
});

// ---------------------------------------------------------------------------
// Osłona po decyzji i tryb cienia
// ---------------------------------------------------------------------------

describe('osłona po decyzji z odciskiem bloku', () => {
  /** Migawka osłony tak, jak robi ją driver przed klawiszem: odcisk i tożsamość ekranu. */
  function shieldFor(text: string): DecidedShield {
    const action = decideCard(input(text));
    if (action.kind !== 'card') throw new Error(`brak karty: ${action.kind}`);
    const screen = resolveOptions(text, null);
    if (screen.status !== 'no-jsonl' || screen.questionForm === null) throw new Error('brak formularza');
    return {
      reqId: action.card.active.reqId,
      callPrint: null,
      callId: null,
      pendingId: null,
      pendingYounger: false,
      bodyPrint: parseOptions(text)?.bodyPrint ?? null,
      screenReqId: screenFormReqId('q', screen.questionForm),
      hookAt: null,
      seq: 1,
    };
  }

  it('po cyfrze na potwierdzeniu ten sam ekran daje `keep`', () => {
    const text = screenOf('dialog-effort-change.txt');
    const shield = shieldFor(text);
    expect(shield.bodyPrint).toMatch(HEX16);
    expect(decideCard(input(text, shield))).toEqual({ kind: 'keep', touchSeq: false });
  });

  it('po cyfrze na zakładce 1 następna zakładka dostaje nową kartę', () => {
    const shield = shieldFor(screenOf('dialog-askuserquestion-multiq-tab1-jednokrotne.txt'));
    const next = decideCard(input(screenOf('dialog-askuserquestion-multiq-tab3-ostatnie.txt'), shield));
    expect(next.kind).toBe('card');
    if (next.kind !== 'card') return;
    expect(next.card.active.reqId).not.toBe(shield.reqId);
    expect(next.card.active.bodyPrint).toMatch(HEX16);
    expect(next.card.active.bodyPrint).not.toBe(shield.bodyPrint);
  });
});

describe('karty z nowym odciskiem są poza kanałem cienia', () => {
  it.each(['dialog:question', 'dialog:confirm', 'dialog:model', 'dialog:trust', 'AskUserQuestion'])('%s', (name) => {
    expect(shadowCardEligible(name)).toBe(false);
  });

  it('nazwy kart z odciskiem w korpusie to wyłącznie te pięć', () => {
    const names = new Set(PRINTED.map((name) => cardOf(screenOf(name))?.active)
      .filter((active) => active?.bodyPrint !== undefined)
      .map((active) => active?.toolName));
    expect([...names].sort()).toEqual(['dialog:confirm', 'dialog:model', 'dialog:question', 'dialog:trust']);
  });
});

// ---------------------------------------------------------------------------
// Kreska ze statusem jako góra odcisku
// ---------------------------------------------------------------------------

describe('kreska ze statusem sesji jako góra odcisku', () => {
  const STATUS = `${'▔'.repeat(60)} ◐ medium · /effort ▔`;

  it('dialog planu 2.1.278 (kreska statusu nad kreską `───`): rodzaj, nazwa, tożsamość i opcje bez zmian', () => {
    const dialog = parseOptions(screenOf('measured/exitplanmode-2.1.278.txt'));
    // Odcisk dialogu planu to nazwa pliku planu ze stopki, nie blok spod kreski statusu.
    expect(dialog).toMatchObject({
      kind: 'tool',
      toolName: 'ExitPlanMode',
      identity: { kind: 'title', tool: 'ExitPlanMode' },
      knownDialog: null,
      planFile: '<plan>.md',
      bodyPrint: createHash('sha256').update('\nplan:<plan>.md').digest('hex').slice(0, 16),
      options: [
        { digit: '1', label: 'Yes, and use auto mode' },
        { digit: '2', label: 'Yes, manually approve edits' },
        { digit: '3', label: 'Tell Claude what to change' },
      ],
    });
  });

  it('potwierdzenie pod kreską statusu: odcisk spod niej, reszta odczytu jak bez reguły', () => {
    const lines = ownLines(screenOf('dialog-effort-change.txt'));
    const top = bareTop(lines);
    const text = joinLines(lines.map((line, i) => (i === top ? STATUS : line)));
    expect(STATUS_RULE.test(STATUS)).toBe(true);
    const dialog = parseOptions(text);
    // Wartości z kodu sprzed reguły: region bez kreski bloku, więc `other`, formularz i bez pytania.
    expect(dialog).toMatchObject({
      kind: 'other', toolName: null, identity: { kind: 'form' }, knownDialog: null, question: null, title: null,
      options: [{ digit: '1', label: 'Yes, switch to high' }, { digit: '2', label: 'No, go back' }],
    });
    expect(dialog?.bodyPrint).toBe(ownPrint(ownLines(text), top));
  });

  it('pytanie pod kreską statusu: odcisk spod niej, pytanie i opcje jak bez reguły', () => {
    const lines = ownLines(screenOf('measured/pytanie-jednokrotne-2.1.293.txt'));
    const top = bareTop(lines);
    const text = joinLines(lines.map((line, i) => (i === top ? STATUS : line)));
    const dialog = parseOptions(text);
    expect(dialog).toMatchObject({
      kind: 'question', identity: { kind: 'form' }, knownDialog: null, title: null,
      selected: { digit: '1', label: 'Wanilia' },
      options: [
        { digit: '1', label: 'Wanilia', description: 'Wanilia' },
        { digit: '2', label: 'Czekolada', description: 'Czekolada' },
        { digit: '3', label: 'Truskawka', description: 'Truskawka' },
        { digit: '4', label: 'Type something.' },
        { digit: '5', label: 'Chat about this' },
      ],
    });
    // Region bez kreski bloku sięga scrollbacku: pytanie jak w kodzie sprzed reguły (reguła zna tylko odcisk).
    expect(dialog?.question).toEqual({
      header: 'Smak lodów',
      question: [
        '▐▛███▛█   Claude Code v2.1.293',
        '▝▜██████▀  Sonnet 5 with medium effort · Claude Plan',
        '▝▝   ▝▝   ~/projekt',
        'Nie używaj żadnych narzędzi poza jednym wywołaniem',
        'AskUserQuestion. Zadaj dokładnie jedno pytanie jednokrotnego',
        "wyboru: 'Jaki smak lodow?' z opcjami: Wanilia, Czekolada,",
        'Truskawka. Nie pisz nic poza tym wywołaniem.',
        STATUS,
        'Jaki smak lodów?',
      ].join('\n'),
    });
    expect(dialog?.bodyPrint).toBe(ownPrint(ownLines(text), top));
  });

  it('kreska statusu poza oknem 60 linii od dołu: bez odcisku', () => {
    const lines = ownLines(screenOf('dialog-effort-change.txt'));
    const top = bareTop(lines);
    const filler = Array.from({ length: 60 }, (_, i) => `   linia ${String(i)}`);
    const text = joinLines([...lines.slice(0, top), STATUS, ...filler, ...lines.slice(top + 1)]);
    expect(parseOptions(text)?.options).toHaveLength(2);
    expect(printOf(text)).toBeNull();
  });

  it('między kreską statusu a opcjami stoi kreska, która nie jest kreską bloku: bez odcisku', () => {
    const lines = ownLines(screenOf('dialog-effort-change.txt'));
    const top = bareTop(lines);
    const text = joinLines([...lines.slice(0, top), STATUS, `   ${'-'.repeat(20)}`, ...lines.slice(top + 1)]);
    expect(parseOptions(text)?.options).toHaveLength(2);
    expect(printOf(text)).toBeNull();
  });
});
