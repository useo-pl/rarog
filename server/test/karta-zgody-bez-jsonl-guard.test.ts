/**
 * Guard "a consent card does not read jsonl": modules of the dialogs directory (`server/src/herdr/dialogs/**`) do not
 * import the transcript, neither the entry reader (`herdr/jsonl-pending.ts`) nor the conversation file follower
 * (`herdr/jsonl-follow.ts`, `herdr/transcript-path.ts`, `drivers/herdr/transcript.ts`). A type import counts too
 * (`import type { PendingTool }`): a transcript entry in a signature means the module builds a card or a decision
 * from jsonl content rather than from the hook dump and the screen.
 *
 * Five modules of the card path from a jsonl entry import it. The {@link WYJATKI} list is CLOSED: a new module with
 * a transcript import is red, and so is an entry without an import (a dead one), so a removed import takes its entry
 * out in the same commit. The driver facade (`drivers/herdr-driver.ts`) is out of scope: it follows the transcript for
 * messages and passes the decision's entry as an argument.
 *
 * Scope: the consent card of the hook channel lives in layer 1 (`server/src/herdr/dialogs/layer1/`), and that
 * subdirectory has no exceptions: a `layer1/**` module with a transcript import fails `layer1-granica.test.ts`
 * whatever the list below says (there together with the ban on herdr driver modules). The five exceptions carry the
 * digit path (the card from a jsonl entry, the question card, the digit after jsonl content). The consent digit path
 * stays as the emergency path of a consent dialog without a hook in channel mode, so these exceptions stay with it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { relativeImports, scan, tsFiles } from './source-scan.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = join(REPO, 'server/src/herdr/dialogs');

/** Moduły transkryptu: czytnik wpisów i śledzenie pliku rozmowy. */
const TRANSCRIPT = [
  'server/src/herdr/jsonl-pending.ts',
  'server/src/herdr/jsonl-follow.ts',
  'server/src/herdr/transcript-path.ts',
  'server/src/drivers/herdr/transcript.ts',
  // Przegląd dowodów kanału zgód: czyta transkrypt, a warstwa 1 dostaje od niego same fakty tury.
  'server/src/herdr/consent-evidence.ts',
  // Plik subagenta w przeglądzie dowodów kanału zgód.
  'server/src/herdr/consent-subagent.ts',
] as const;

interface Wyjatek {
  readonly plik: string;
  readonly powod: string;
}

/** Dzisiejsze moduły katalogu z importem transkryptu. Lista ZAMKNIĘTA: martwy wpis też jest błędem. */
const WYJATKI: readonly Wyjatek[] = [
  { plik: 'server/src/herdr/dialogs/cards/build.ts', powod: 'karta z wpisu jsonl (`PendingTool` → `ActiveReq`)' },
  { plik: 'server/src/herdr/dialogs/cross-check.ts', powod: 'uzgadnianie wpisu jsonl ze zrzutem hooka i ekranem' },
  { plik: 'server/src/herdr/dialogs/decide/decide.ts', powod: 'decyzja „jaka karta” z wpisem jsonl jako źródłem' },
  { plik: 'server/src/herdr/dialogs/decide/input.ts', powod: 'wejście decyzji niesie wpis jsonl' },
  { plik: 'server/src/herdr/dialogs/decide/sources.ts', powod: 'konkurencja wpisu jsonl i zrzutu hooka' },
];

const repoPath = (file: string): string => relative(REPO, file);

/** Importy transkryptu w KODZIE modułu (komentarze się nie liczą), jako ścieżki repo. */
function transcriptImports(file: string, source: string): string[] {
  return relativeImports(scan(source).code)
    .map((spec) => repoPath(resolve(dirname(join(REPO, file)), spec)))
    .filter((target) => (TRANSCRIPT as readonly string[]).includes(target));
}

describe('karta zgody nie czyta jsonl (zapadka)', () => {
  it('moduły transkryptu istnieją (przemianowany plik zrobiłby z zakazu pusty zbiór)', () => {
    for (const file of TRANSCRIPT) expect(existsSync(join(REPO, file)), file).toBe(true);
  });

  it('widzi import typu, wartości i dynamiczny; komentarz się nie liczy', () => {
    const file = 'server/src/herdr/dialogs/decide/probka.ts';
    const source = [
      "import type { PendingTool } from '../../jsonl-pending.ts';",
      "import { echoKey } from '../../jsonl-follow.ts';",
      "const t = await import('../../../drivers/herdr/transcript.ts');",
      "// import { locateTranscript } from '../../transcript-path.ts';",
      "import { parseOptions } from '../screen/parse.ts';",
    ].join('\n');
    expect(transcriptImports(file, source)).toEqual([
      'server/src/herdr/jsonl-pending.ts', 'server/src/herdr/jsonl-follow.ts', 'server/src/drivers/herdr/transcript.ts',
    ]);
  });

  it('żaden moduł katalogu dialogów poza listą wyjątków nie importuje transkryptu; lista bez martwych wpisów', () => {
    const uzyte = new Set<Wyjatek>();
    const obce: string[] = [];
    for (const file of tsFiles(DIR).map(repoPath)) {
      const hits = transcriptImports(file, readFileSync(join(REPO, file), 'utf8'));
      if (hits.length === 0) continue;
      const wyjatek = WYJATKI.find((w) => w.plik === file);
      if (wyjatek === undefined) {
        obce.push(`${file} importuje ${hits.join(', ')} — karta ma brać treść ze zrzutu hooka i ekranu`);
        continue;
      }
      uzyte.add(wyjatek);
    }
    expect(obce).toEqual([]);
    expect(WYJATKI.filter((w) => !uzyte.has(w)).map((w) => w.plik), 'martwe wyjątki').toEqual([]);
  });
});
