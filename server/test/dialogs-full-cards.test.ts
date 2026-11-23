/**
 * Pełny plik złoty kart korpusu: ocena KAŻDEGO commitowanego ekranu, także bez karty z przyciskiem.
 *
 * Korpus to wszystkie `.txt` z `fixtures/herdr/` (korzeń), `measured/`, `refusals/`, `queue/measured/`
 * i `kontrolny/`, po nazwie pliku. Dla każdego ekranu plik zapisuje to, co decyzja bez jsonl i bez hooka
 * (`decideCard`, ta sama, której używa driver) zrobiłaby nad tym ekranem: rodzaj akcji, zdarzenie, `reqId`, nazwę,
 * znany dialog, opcje z cyfrą, etykietą i `terminalOnly`, powód na karcie i w dzienniku, kształt przypadku do
 * dziennika, wycinek (sha256 i liczba linii), odcisk karty i odcisk odczytu ekranu dla każdego rodzaju dialogu,
 * `blockVisible` oraz skrót całej karty. Każda zmiana karty, wycinka, powodu albo odcisku na zapisanym ekranie
 * czerwieni test.
 *
 * Kontekst oceny stoi w nagłówku pliku ({@link CONTEXT}): flaga warstwy 2 `0` (`RAROG_DIALOG_LAYER2`, decyzja bez
 * pola `layer2`), kanał zgody hooka `off`, klasa dialogu z rejestru CLI `null`, bez zrzutu hooka i bez
 * wpisu jsonl. Plik niesie wyłącznie skróty i metadane: etykiety opcji jak w `karty-korpusu.json`, bez treści
 * ekranów.
 *
 * Plik złoty `fixtures/herdr/karty-korpusu-pelne.json` produkuje ten test: `RAROG_FIXTURES_WRITE=1` go nadpisuje,
 * bez niej test porównuje. Starszy plik złoty `karty-korpusu.json` (tylko karty z przyciskiem, bez `kontrolny/`
 * i `queue/`) zostaje przy `dialogs-block-fingerprint.test.ts`.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEMP_DIR } from '../../scripts/lib/private-patterns.mjs';
import { decideCard } from '../src/herdr/dialogs/decide/decide.ts';
import type { DecideAction, DecideInput, DegradeDiagnosis } from '../src/herdr/dialogs/decide/input.ts';
import { evaluationReqId } from '../src/herdr/dialogs/decide/sources.ts';
import { screenDialogCard } from '../src/herdr/dialogs/cards/build.ts';
import type { DecisionCard } from '../src/herdr/dialogs/cards/build.ts';
import { blockVisible } from '../src/herdr/dialogs/screen/block-visible.ts';
import { parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import { snippet } from '../src/herdr/dialogs/screen/snippet.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const GOLDEN = join(DIR, 'karty-korpusu-pelne.json');
const WRITE = process.env.RAROG_FIXTURES_WRITE === '1';
const MARK = '\n--- ekran ---\n';

/** Katalogi korpusu względem `fixtures/herdr/`. */
const DIRS = ['', 'measured/', 'refusals/', 'queue/measured/', 'kontrolny/'] as const;

/** Korpus ekranów: `.txt` z {@link DIRS}, po ścieżce względnej. */
const CORPUS = DIRS.flatMap((sub) => readdirSync(join(DIR, sub))
  .filter((name) => name.endsWith('.txt'))
  .map((name) => `${sub}${name}`))
  .sort();

/** Ekran fixture'u; zrzut odmowy (`refusals/`) ma nad ekranem nagłówek `klucz: wartość`. */
function screenOf(name: string): string {
  const raw = readFileSync(join(DIR, name), 'utf8');
  const at = raw.indexOf(MARK);
  return at < 0 ? raw : raw.slice(at + MARK.length);
}

/** Kontekst oceny zapisany w nagłówku pliku złotego; wejście decyzji niżej stoi dokładnie na nim. */
const CONTEXT = {
  layer2: 0,
  layer2Note: 'RAROG_DIALOG_LAYER2=0: decyzja bez pola layer2, karta bez śladu warstwy 2',
  consentChannel: 'off',
  cliDialogClass: null,
  hook: 'brak',
  jsonl: 'brak',
  input: 'decideCard: blockedSeq 1, answeredSeq -1, active null, decided null, canRetry false, '
    + 'hookAnswersEnabled true; karta bez przycisków przez screenDialogCard bez klasy CLI',
} as const;

/** Wejście decyzji bez jsonl i bez hooka, jak w driverze po ponowionym odczycie ({@link CONTEXT}). */
function input(text: string): DecideInput {
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
    decided: null,
    resolve: resolveOptions,
    excerpt: (value: string) => snippet(value)?.text ?? null,
    hookRaw: null,
  };
}

/** Rekord jednego ekranu w pliku złotym. Kolejność pól = kolejność w pliku. */
interface Shot {
  /** Rodzaj akcji `decideCard`. */
  readonly action: DecideAction['kind'];
  /** Typ zdarzenia karty; `null` = ocena bez karty. */
  readonly event: string | null;
  readonly reqId: string | null;
  readonly toolName: string | null;
  readonly knownDialog: string | null;
  /** Rodzaj dialogu z odczytu ekranu (`parseOptions`); `null` = odczyt bez opcji z cyframi. */
  readonly dialogKind: string | null;
  readonly options: readonly { digit: string; label: string; terminalOnly?: true }[];
  /** Powód na karcie (`reason` zdarzenia): karta bez przycisków. */
  readonly reason: string | null;
  /** Powód do dziennika (`audit` akcji). */
  readonly audit: string | null;
  /** Kształt przypadku do dziennika (`diagnosis` akcji). */
  readonly diagnosis: DegradeDiagnosis | null;
  /** Wycinek ekranu na karcie (`screen` zdarzenia): sha256 i liczba linii. */
  readonly excerpt: { readonly sha256: string; readonly lines: number } | null;
  /** Odcisk na karcie (`ActiveReq.bodyPrint`), sprawdzany przed cyfrą. */
  readonly bodyPrint: string | null;
  /** Odcisk z odczytu ekranu (`parseOptions(text).bodyPrint`) dla każdego rodzaju dialogu, z kartą czy bez. */
  readonly screenPrint: string | null;
  readonly blockVisible: boolean;
  /** sha256 całej karty (`active` i zdarzenie, klucze posortowane): łapie zmianę pola spoza listy wyżej. */
  readonly card: string | null;
}

const SHOT_KEYS: readonly (keyof Shot)[] = [
  'action', 'event', 'reqId', 'toolName', 'knownDialog', 'dialogKind', 'options', 'reason', 'audit', 'diagnosis',
  'excerpt', 'bodyPrint', 'screenPrint', 'blockVisible', 'card',
];

interface Golden {
  readonly context: typeof CONTEXT;
  readonly summary: { readonly screens: number; readonly cards: number; readonly buttons: number;
    readonly noButtons: number };
  readonly screens: Readonly<Record<string, Shot>>;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** JSON z kluczami obiektów posortowanymi: skrót karty nie zależy od kolejności pól w budowniczym. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Etykieta z zamaskowanym katalogiem tymczasowym macOS, jak w `karty-korpusu.json`: plik złoty nie podnosi zapadki
 * `private-patterns-guard.test.ts`. `reqId` i skrót karty liczą się z pełnej etykiety.
 */
const goldenLabel = (label: string): string => label.replace(TEMP_DIR, '/var/<folders>/');

/** Karta, jaką driver wystawiłby nad ekranem ({@link CONTEXT}); `null` = ocena bez karty. */
function cardOf(action: DecideAction): (DecisionCard & { knownDialog: string | null }) | null {
  if (action.kind === 'card') return { ...action.card, knownDialog: null };
  if (action.kind !== 'screen-dialog') return null;
  return screenDialogCard(action.reqId, action.resolved, action.reason, action.screen, null, action.origin);
}

function shotOf(name: string): Shot {
  const text = screenOf(name);
  const action = decideCard(input(text));
  const card = cardOf(action);
  const event = card?.event;
  const reason = event !== undefined && 'reason' in event && typeof event.reason === 'string' ? event.reason : null;
  const screen = event !== undefined && 'screen' in event && typeof event.screen === 'string' ? event.screen : null;
  const dialog = parseOptions(text);
  return {
    action: action.kind,
    event: event?.type ?? null,
    reqId: card?.active.reqId ?? null,
    toolName: card?.active.toolName ?? null,
    knownDialog: card?.knownDialog ?? null,
    dialogKind: dialog?.kind ?? null,
    options: (card?.active.options ?? []).map((option) => ({
      digit: option.digit,
      label: goldenLabel(option.label),
      ...(option.terminalOnly === true ? { terminalOnly: true as const } : {}),
    })),
    reason,
    audit: action.kind === 'card' || action.kind === 'screen-dialog' ? action.audit : null,
    diagnosis: (action.kind === 'card' || action.kind === 'screen-dialog') ? action.diagnosis ?? null : null,
    excerpt: screen === null ? null : { sha256: sha256(screen), lines: screen.split('\n').length },
    bodyPrint: card?.active.bodyPrint ?? null,
    screenPrint: dialog?.bodyPrint ?? null,
    blockVisible: blockVisible(text),
    card: card === null ? null : sha256(canonical({ active: card.active, event: card.event })),
  };
}

/** Karta z choć jednym przyciskiem: opcja bez `terminalOnly`. */
const hasButton = (shot: Shot): boolean => shot.options.some((option) => option.terminalOnly !== true);

function produce(): Golden {
  const screens: Record<string, Shot> = {};
  for (const name of CORPUS) screens[name] = shotOf(name);
  const shots = Object.values(screens);
  const cards = shots.filter((shot) => shot.event !== null);
  const buttons = cards.filter(hasButton).length;
  return {
    context: CONTEXT,
    summary: { screens: shots.length, cards: cards.length, buttons, noButtons: cards.length - buttons },
    screens,
  };
}

const produced = produce();
if (WRITE) writeFileSync(GOLDEN, `${JSON.stringify(produced, null, 2)}\n`);
const stored = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden;

describe('pełny plik złoty kart korpusu: nagłówek i korpus', () => {
  it('kontekst oceny w nagłówku: flaga 0, kanał `off`, klasa `null`, bez hooka i jsonl', () => {
    expect(stored.context).toEqual(CONTEXT);
  });

  it('korpus: każdy z pięciu katalogów daje ekrany, kolejność po nazwie pliku', () => {
    for (const sub of DIRS) {
      expect(CORPUS.filter((name) => name.startsWith(sub) && !name.slice(sub.length).includes('/')).length, sub)
        .toBeGreaterThan(0);
    }
    expect(CORPUS.length).toBeGreaterThan(130);
    expect(Object.keys(stored.screens)).toEqual([...CORPUS]);
  });

  it('ten sam zbiór ekranów i to samo podsumowanie co w pliku złotym', () => {
    expect(Object.keys(produced.screens)).toEqual(Object.keys(stored.screens));
    expect(produced.summary).toEqual(stored.summary);
  });

  it('rekord ma tylko pola z listy: skróty i metadane, bez treści ekranu', () => {
    for (const [name, shot] of Object.entries(stored.screens)) expect(Object.keys(shot), name).toEqual(SHOT_KEYS);
  });

  it('każdy ekran dostaje kartę: ocena bez stojącej karty nie kończy się `keep` ani `retry`', () => {
    expect(Object.values(produced.screens).filter((shot) => shot.event === null)).toEqual([]);
  });
});

describe('pełny plik złoty kart korpusu: ekran po ekranie (odśwież: RAROG_FIXTURES_WRITE=1)', () => {
  it.each(Object.keys(stored.screens))('%s', (name) => {
    expect(produced.screens[name]).toEqual(stored.screens[name]);
  });
});
