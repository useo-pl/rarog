/*
 * Rejestr sygnatur ekranu: każda sygnatura musi trafiać w coś ZMIERZONEGO.
 *
 * Sygnatura bez pokrycia w fixture'ach jest sierotą: nikt nie wie, czy dzisiejszy Claude Code
 * jeszcze tak rysuje, a fail-closed parsera zamienia się wtedy w ciche „odpowiedz w terminalu".
 * Ten test jest tanią bramką na to — fixture'y odświeża skrypt pomiaru po aktualizacji CLI.
 *
 * Kandydatów z linii ekranu składamy tu WŁASNYMI wzorcami, nie funkcjami parsera: test,
 * który sprawdza moduł jego własnym kodem, nie sprawdza niczego. Dopasowanie markerów idzie
 * bez rozróżniania wielkości liter — pytamy „czy ten kształt w ogóle występuje na zmierzonym
 * ekranie", a nie „czy dopasowanie jest znak w znak takie jak w module".
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SCREEN_SIGNATURES } from '../src/herdr/dialogs/screen/signatures.ts';
import type { ScreenSignature } from '../src/herdr/dialogs/screen/signatures.ts';
import { KNOWN_DIALOGS } from '../src/herdr/dialogs/screen/known.ts';
import { MODE_SWITCH_PATTERN } from '../src/herdr/dialogs/policy/escalation.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures/herdr');

/** Wpisy, które ŚWIADOMIE nie mają fixture'u — lista jest ZAMKNIĘTA (patrz test niżej). */
const BEZ_FIXTUREU = [
  'multiSelectSpaceFooter',
  'modeFooterBypass',
  'modeFooterAcceptEdits',
  'modeFooterPlan',
  'modeFooterManual',
] as const;

function ekrany(dir: string): string[] {
  const out: string[] = [];
  for (const wpis of readdirSync(dir, { withFileTypes: true })) {
    if (wpis.isDirectory()) out.push(...ekrany(join(dir, wpis.name)));
    else if (wpis.name.endsWith('.txt')) out.push(readFileSync(join(dir, wpis.name), 'utf8'));
  }
  return out;
}

/** Warianty jednej linii, w których wolno szukać sygnatury (goła, bez ramki, bez cyfry, pasek). */
function kandydaci(tekst: string): string[] {
  const out: string[] = [tekst];
  // Cały ekran bez ramek w liniach: linia strefy pytania `Bash` zawinięta z paskiem objaśnienia (`│ Permission rule…`
  // nad `│ command.`, CLI 2.1.311) stoi tylko tak; wzorzec z flagą `m` i `\s+` między słowami trafia ją w całości.
  const bezRamekCaly: string[] = [];
  for (const raw of tekst.split('\n')) {
    const trimmed = raw.trim();
    out.push(raw, trimmed);
    const bezRamki = trimmed
      .replace(/^[│┃|]\s?/, '').replace(/\s*[│┃|]$/, '').trim()
      .replace(/^[❯▶▸>*·↓↑]\s+/, '').trim();
    out.push(bezRamki);
    bezRamekCaly.push(bezRamki);
    const opcja = /^\d\.\s+(.+)$/.exec(bezRamki);
    if (opcja?.[1] !== undefined) out.push(opcja[1].trim());
    out.push(trimmed.replace(/^[←‹⟨]\s*/, '').replace(/\s*[→›⟩]$/, '').trim());
  }
  out.push(bezRamekCaly.join('\n'));
  return out;
}

function trafia(sygnatura: ScreenSignature, linie: readonly string[]): boolean {
  const wzorzec = sygnatura.pattern;
  const markery = typeof wzorzec === 'string' ? [wzorzec] : Array.isArray(wzorzec) ? wzorzec : null;
  if (markery !== null) {
    return markery.some((m) => linie.some((l) => l.toLowerCase().includes(m.toLowerCase())));
  }
  const regex = wzorzec as RegExp;
  return linie.some((l) => {
    regex.lastIndex = 0;
    return regex.test(l);
  });
}

const WPISY = Object.entries(SCREEN_SIGNATURES) as [string, ScreenSignature][];
const LINIE = ekrany(FIXTURES).flatMap(kandydaci);

/**
 * Trafienia sygnatury z `noFixture` w INNY kształt ekranu: nie zdejmują zwolnienia. Lista zamknięta, wpis to
 * fragment linii fixture'u. Stopka widoku `/skills` („enter/space to cycle”) zawiera `space to`, ale nie jest
 * stopką formularza wielokrotnego.
 */
const OBCE_TRAFIENIA: Readonly<Record<string, readonly string[]>> = {
  multiSelectSpaceFooter: ['enter/space to cycle'],
};
const bezObcych = (nazwa: string): string[] =>
  LINIE.filter((l) => !(OBCE_TRAFIENIA[nazwa] ?? []).some((obce) => l.includes(obce)));

describe('rejestr sygnatur ekranu', () => {
  it('czyta jakiekolwiek fixture’y (inaczej cały test byłby pusty)', () => {
    expect(LINIE.length).toBeGreaterThan(1000);
    expect(WPISY.length).toBeGreaterThan(20);
  });

  it('każda sygnatura trafia w co najmniej jeden fixture', () => {
    const sieroty = WPISY
      .filter(([, sygnatura]) => sygnatura.noFixture === undefined)
      .filter(([, sygnatura]) => !trafia(sygnatura, LINIE))
      .map(([nazwa, sygnatura]) => `${nazwa} — ${sygnatura.what}`);
    expect(sieroty, 'sygnatury bez pokrycia w fixture’ach (odśwież pomiar albo usuń wzorzec)')
      .toEqual([]);
  });

  it('wpisy bez fixture’u są zamkniętą listą z powodem', () => {
    const zwolnione = WPISY.filter(([, s]) => s.noFixture !== undefined).map(([n]) => n);
    expect(zwolnione.sort()).toEqual([...BEZ_FIXTUREU].sort());
    for (const [, sygnatura] of WPISY) {
      if (sygnatura.noFixture !== undefined) expect(sygnatura.noFixture.length).toBeGreaterThan(10);
    }
  });

  it('zwolnienie z fixture’u wygasa, gdy pomiar je pokryje', () => {
    const nieaktualne = WPISY
      .filter(([, s]) => s.noFixture !== undefined)
      .filter(([nazwa, s]) => trafia(s, bezObcych(nazwa)))
      .map(([nazwa]) => nazwa);
    expect(nieaktualne, 'te sygnatury MAJĄ już fixture — zdejmij z nich `noFixture`').toEqual([]);
  });

  it('obce trafienie stoi w fixture’ach i trafia w zwolnioną sygnaturę (inaczej wpis jest martwy)', () => {
    for (const [nazwa, fragmenty] of Object.entries(OBCE_TRAFIENIA)) {
      const sygnatura = SCREEN_SIGNATURES[nazwa as keyof typeof SCREEN_SIGNATURES] as ScreenSignature | undefined;
      expect(sygnatura?.noFixture, nazwa).toBeDefined();
      for (const obce of fragmenty) {
        const linie = LINIE.filter((l) => l.includes(obce));
        expect(linie.length, obce).toBeGreaterThan(0);
        expect(trafia(sygnatura as ScreenSignature, linie), obce).toBe(true);
      }
    }
  });

  it('każdy wpis niesie opis i metryki pomiaru w znanym formacie', () => {
    for (const [nazwa, sygnatura] of WPISY) {
      expect(sygnatura.what.length, nazwa).toBeGreaterThan(10);
      if (sygnatura.cli !== null) expect(sygnatura.cli, nazwa).toMatch(/^\d+(\.\d+)+$/);
    }
  });
});

/*
 * Literały wyglądu przeniesione z kodu modułów do rejestru: wartość w rejestrze jest ZNAK W ZNAK ta, która stała
 * w kodzie (źródło i flagi wzorca, treść markera). Przeniesienie nie zmienia zachowania parsera.
 */
describe('rejestr sygnatur: wartości przeniesione z kodu modułów', () => {
  const PRZENIESIONE: ReadonlyArray<readonly [keyof typeof SCREEN_SIGNATURES, RegExp | string]> = [
    ['questionSelectFooter', 'enter to select'],
    ['proceedQuestion', 'Do you want to proceed?'],
    ['subagentTitleSuffix', / · from the .+ agent$/],
    ['sandboxTitleSuffix', / \((?:un)?sandboxed\)$/],
    ['knownDialogYesOption', /^Yes/i],
    ['knownDialogNoOption', /^No/i],
    ['affirmativeOption', /^yes\b/i],
    ['modeSwitchOption', /\b(?:switch to|use)\s+(?:auto mode|accept edits|default|bypass)|bypass permissions/i],
    ['keyHintLine', /^(?:submit|next)$|^notes:|^(?:shift\+tab|ctrl\+\S+|esc|enter|tab)\b/i],
    ['boxEdgeStartIndented', /^\s*[│┃|]\s?/],
    ['optionNumber', /\d\./],
    ['uncheckedGlyph', '☐'],
    ['operationMargin', /^ /u],
    ['multiSelectSpaceFooter', 'space to'],
    // `drivers/herdr/commands.ts`: `/^❯/` zastąpił tam też `startsWith('❯')` — to samo dla jednego znaku BMP.
    ['composerRule', /^─{4,}/],
    ['composerPrompt', /^❯/],
  ];

  it.each(PRZENIESIONE)('%s ma wartość sprzed przeniesienia', (nazwa, przed) => {
    const wzorzec = SCREEN_SIGNATURES[nazwa].pattern;
    if (typeof przed === 'string') {
      expect(wzorzec).toBe(przed);
      return;
    }
    expect(wzorzec).toBeInstanceOf(RegExp);
    expect((wzorzec as RegExp).source).toBe(przed.source);
    expect((wzorzec as RegExp).flags).toBe(przed.flags);
  });

  it('stałe eksportowane modułów to obiekty z rejestru', () => {
    expect(MODE_SWITCH_PATTERN).toBe(SCREEN_SIGNATURES.modeSwitchOption.pattern);
    for (const dialog of KNOWN_DIALOGS) {
      expect(dialog.expect).toEqual([
        SCREEN_SIGNATURES.knownDialogYesOption.pattern,
        SCREEN_SIGNATURES.knownDialogNoOption.pattern,
      ]);
      expect(dialog.expect[0]).toBe(SCREEN_SIGNATURES.knownDialogYesOption.pattern);
      expect(dialog.expect[1]).toBe(SCREEN_SIGNATURES.knownDialogNoOption.pattern);
    }
  });
});
