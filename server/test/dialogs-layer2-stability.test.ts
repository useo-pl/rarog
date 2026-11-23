/**
 * Stabilność bloku warstwy 2 (`server/src/herdr/dialogs/layer2/stability.ts`): czysta maszyna nad odczytami
 * z generacją i zakresem.
 *
 * Zagrożenia: ekran zmienił się między odczytami (odczyt przeciął zmianę blokady, końce przyszły w odwrotnej
 * kolejności) oraz odczyt z pamięci ekranu udaje drugi odczyt. Przypadki pierwszego stoją w jednej tabeli, każdy
 * z krokiem, który go zatrzymał, więc test pokazuje, KTÓRA reguła zadziałała, a nie tylko brak stabilności.
 * Granice: 799 i 800 ms, drugi odczyt niewymuszony, zakres komendy, trzy próby bez stabilności, za wczesny odczyt
 * bez zużycia próby, kolejne bloki jednej blokady z próbami od zera po każdej potwierdzonej parze. Własności
 * (fast-check) sprawdzają reguły na dowolnych ciągach odczytów: kopia z generacją nie wyższą niż ostatnia nic nie
 * zmienia, wejście w `stable` ma zawsze uczciwą parę, po potwierdzonej parze próby startują od zera, a wymuszony
 * odczyt przy czekającej parze, który mógł ją potwierdzić, zawsze robi postęp.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  INITIAL_STABILITY, STABILITY_ATTEMPTS, STABILITY_GAP_MS, observeStability, sameScope,
} from '../src/herdr/dialogs/layer2/stability.ts';
import type {
  StabilityRead, StabilityScope, StabilityState, StabilityStep,
} from '../src/herdr/dialogs/layer2/stability.ts';

const S1: StabilityScope = { kind: 'blocked', seq: 1 };
const S2: StabilityScope = { kind: 'blocked', seq: 2 };
const RUN1: StabilityScope = { kind: 'command', run: 1 };
const RUN2: StabilityScope = { kind: 'command', run: 2 };

const A = 'blok-A';
const A_PRIM = 'blok-A′';
const B = 'blok-B';
const C = 'blok-C';
const D = 'blok-D';

interface ReadOptions {
  readonly forced?: boolean;
  readonly scope?: StabilityScope;
  /** Zakres na starcie, gdy różny od zakresu na końcu (odczyt przecina zmianę). */
  readonly start?: StabilityScope;
}

/** Odczyt: generacja, chwila końca, odcisk; domyślnie pierwsza blokada, bez wymuszenia. */
function read(gen: number, endedAt: number, print: string | null, options: ReadOptions = {}): StabilityRead {
  const scope = options.scope ?? S1;
  return {
    gen, endedAt, print, forced: options.forced ?? false, scopeAtStart: options.start ?? scope, scopeAtEnd: scope,
  };
}

const forced = (gen: number, endedAt: number, print: string | null, options: ReadOptions = {}): StabilityRead =>
  read(gen, endedAt, print, { ...options, forced: true });

/** Stany po każdym odczycie ciągu. */
function trace(reads: readonly StabilityRead[], from: StabilityState = INITIAL_STABILITY): StabilityState[] {
  const out: StabilityState[] = [];
  let state = from;
  for (const r of reads) {
    state = observeStability(state, r);
    out.push(state);
  }
  return out;
}

function last(reads: readonly StabilityRead[], from: StabilityState = INITIAL_STABILITY): StabilityState {
  const states = trace(reads, from);
  const final = states.at(-1);
  if (final === undefined) throw new Error('pusty ciąg odczytów');
  return final;
}

/** Stan bez pola `step`: do porównań „ten sam wynik, inny ostatni krok”. */
function core(state: StabilityState): Omit<StabilityState, 'step'> {
  const { step: _step, ...rest } = state;
  return rest;
}

describe('stabilność w blokadzie: para wymuszona po 800 ms', () => {
  it('[A, A wymuszony po 800 ms] = stabilny, para z pierwszego odczytu', () => {
    const state = last([read(1, 0, A), forced(2, 800, A)]);
    expect(state.verdict).toBe('stable');
    expect(state.step).toBe('stable');
    expect(state.attempts).toBe(0);
    if (state.verdict !== 'stable') return;
    expect(state.first).toEqual({ gen: 1, endedAt: 0, print: A });
    expect(state.scope).toEqual(S1);
  });

  it('granica: 799 ms = para czeka bez zużycia próby, 800 ms = stabilny', () => {
    const early = last([read(1, 1000, A), forced(2, 1000 + STABILITY_GAP_MS - 1, A)]);
    expect(early).toMatchObject({ verdict: 'pending', step: 'early', attempts: 0, first: { gen: 1 } });
    expect(last([read(1, 1000, A), forced(2, 1000 + STABILITY_GAP_MS, A)]).verdict).toBe('stable');
    expect(STABILITY_GAP_MS).toBe(800);
  });

  it('za wczesny wymuszony odczyt nie przesuwa pary: następny liczy się od pierwszego', () => {
    const states = trace([read(1, 0, A), forced(2, 500, A), forced(3, 800, A)]);
    expect(states.map((s) => s.step)).toEqual(['first', 'early', 'stable']);
  });

  it('trzy wymuszone A przed 800 ms nie dają `unstable`: wymuszone A po 800 ms potwierdza parę', () => {
    const states = trace([read(1, 0, A), forced(2, 100, A), forced(3, 200, A), forced(4, 300, A), forced(5, 800, A)]);
    expect(states.map((s) => s.step)).toEqual(['first', 'early', 'early', 'early', 'stable']);
    expect(states.map((s) => s.attempts)).toEqual([0, 0, 0, 0, 0]);
    expect(states.at(-1)).toMatchObject({ verdict: 'stable', first: { gen: 1 } });
  });

  it('drugi odczyt niewymuszony nie potwierdza i nie zużywa próby; wymuszony później tak', () => {
    const states = trace([read(1, 0, A), read(2, 900, A), forced(3, 1700, A)]);
    expect(states[1]).toMatchObject({ verdict: 'pending', step: 'unforced', attempts: 0, first: { gen: 1 } });
    expect(states[2]).toMatchObject({ verdict: 'stable', first: { gen: 1 } });
  });

  it('stabilny zostaje stabilny przy tym samym odcisku, inny odcisk zabiera stabilność bez zużycia próby', () => {
    const states = trace([read(1, 0, A), forced(2, 800, A), read(3, 900, A), forced(4, 1000, B)]);
    expect(states[2]).toMatchObject({ verdict: 'stable', step: 'stable', first: { gen: 1 } });
    expect(states[3]).toMatchObject({ verdict: 'pending', step: 'changed', attempts: 0, first: { gen: 4, print: B } });
  });

  it('brak bloku albo przecięcie zakresu po stabilnej parze zaczyna od zera, bez zużycia próby', () => {
    const stable = last([read(1, 0, A), forced(2, 800, A)]);
    expect(observeStability(stable, forced(3, 1600, null))).toMatchObject({
      verdict: 'pending', step: 'no-block', attempts: 0, first: null,
    });
    // Przecięcie kończące się w tym samym zakresie (zakres pary stoi na końcu, start w innym).
    expect(observeStability(stable, forced(3, 1600, A, { start: S2 }))).toMatchObject({
      verdict: 'pending', step: 'crossed', attempts: 0, first: null,
    });
  });

  it('kolejne bloki jednej blokady: [A, A, B, B, C, C, D, D] = cztery stabilne pary, próby po każdej 0', () => {
    // Drugi odczyt każdej pary jest wymuszony i 800 ms po pierwszym; pierwszy (poza A) też wymuszony,
    // więc gdyby odczyt psujący stabilną parę zużywał próbę, D wpadłoby w `unstable`.
    const reads = [A, A, B, B, C, C, D, D]
      .map((print, i) => (i === 0 ? read(1, 0, print) : forced(i + 1, i * STABILITY_GAP_MS, print)));
    const states = trace(reads);
    expect(states.map((s) => s.verdict)).toEqual([
      'pending', 'stable', 'pending', 'stable', 'pending', 'stable', 'pending', 'stable',
    ]);
    expect(states.map((s) => s.attempts)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(states.at(-1)).toMatchObject({ first: { gen: 7, print: D } });
  });

  it('potwierdzona para zeruje próby zebrane przed nią: następny blok ma pełny budżet', () => {
    const E = 'blok-E';
    const F = 'blok-F';
    const states = trace([
      read(1, 0, A), forced(2, 800, B), forced(3, 1600, C), forced(4, 2400, C), forced(5, 3200, D),
      forced(6, 4000, E), forced(7, 4800, F),
    ]);
    expect(states.map((s) => s.attempts)).toEqual([0, 1, 2, 0, 0, 1, 2]);
    expect(states.map((s) => s.verdict)).toEqual([
      'pending', 'pending', 'pending', 'stable', 'pending', 'pending', 'pending',
    ]);
  });

  it('stan początkowy czeka bez pary i bez zakresu', () => {
    expect(INITIAL_STABILITY).toEqual({
      verdict: 'pending', lastGen: null, scope: null, first: null, attempts: 0, step: null,
    });
  });
});

describe('przypadki niestabilne', () => {
  interface Przypadek {
    readonly nazwa: string;
    readonly odczyty: readonly StabilityRead[];
    /** Krok ostatniego odczytu: reguła, która zatrzymała stabilność. */
    readonly krok: StabilityStep;
  }

  const PRZYPADKI: readonly Przypadek[] = [
    {
      // Odczyt przy wejściu w blokadę i ocena po debounce z pamięci ekranu: ta sama generacja.
      nazwa: '[A, A z cache]',
      odczyty: [read(1, 0, A), read(1, 0, A)],
      krok: 'cached',
    },
    {
      // Kopia z pamięci nie staje się dowodem, nawet oznaczona jako wymuszona i z późnym czasem.
      nazwa: '[A, A z cache z wymuszeniem i czasem po 900 ms]',
      odczyty: [read(1, 0, A), forced(1, 900, A)],
      krok: 'cached',
    },
    {
      nazwa: '[A, null, A]',
      odczyty: [read(1, 0, A), forced(2, 800, null), forced(3, 1600, A)],
      krok: 'first',
    },
    {
      nazwa: '[A, A′]',
      odczyty: [read(1, 0, A), forced(2, 800, A_PRIM)],
      krok: 'changed',
    },
    {
      // Także odczyt sprzed blokady wzięty z pamięci ekranu: niesie zakres starej blokady.
      nazwa: '[A, A po nowej blokadzie]',
      odczyty: [read(1, 0, A), forced(2, 900, A, { scope: S2 })],
      krok: 'first',
    },
    {
      nazwa: '[A, odczyt A przecinający zmianę blokady]',
      odczyty: [read(1, 0, A), forced(2, 900, A, { start: S1, scope: S2 })],
      krok: 'crossed',
    },
    {
      nazwa: '[A, odczyt A przecinający zmianę blokady w tę samą stronę co zakres pary]',
      odczyty: [read(1, 0, A, { scope: S2 }), forced(2, 900, A, { start: S1, scope: S2 })],
      krok: 'crossed',
    },
    {
      // Odczyt 2 skończył się pierwszy; odczyt 1, starszy, kończy się później.
      nazwa: '[końce w odwrotnej kolejności]',
      odczyty: [read(2, 0, A), forced(1, 900, A)],
      krok: 'stale',
    },
  ];

  it.each(PRZYPADKI)('$nazwa = niestabilny (krok `$krok`)', ({ odczyty, krok }) => {
    const states = trace(odczyty);
    expect(states.every((s) => s.verdict !== 'stable')).toBe(true);
    expect(states.at(-1)?.step).toBe(krok);
  });

  it('[A, null, A] wymaga nowej pary od trzeciego odczytu', () => {
    const states = trace([
      read(1, 0, A), forced(2, 800, null), forced(3, 1600, A), forced(4, 1600 + STABILITY_GAP_MS - 1, A),
      forced(5, 1600 + STABILITY_GAP_MS, A),
    ]);
    expect(states.map((s) => s.verdict)).toEqual(['pending', 'pending', 'pending', 'pending', 'stable']);
    expect(states[2]).toMatchObject({ first: { gen: 3 } });
  });

  it('odczyt przecinający zmianę nie zostaje pierwszym odczytem pary w nowej blokadzie', () => {
    // Gdyby odczyt 2 (koniec w drugiej blokadzie, 900 ms) liczył się jako pierwszy, odczyt 3 po 1800 ms dałby
    // stabilność.
    const states = trace([
      read(1, 0, A), forced(2, 900, A, { start: S1, scope: S2 }), forced(3, 1800, A, { scope: S2 }),
      forced(4, 2600, A, { scope: S2 }),
    ]);
    expect(states.map((s) => s.step)).toEqual(['first', 'crossed', 'first', 'stable']);
    expect(states[1]).toMatchObject({ scope: S2, first: null, attempts: 0 });
  });

  it('nowa blokada zeruje próby i parę', () => {
    const states = trace([read(1, 0, A), forced(2, 800, B), forced(3, 1600, C), forced(4, 2400, C, { scope: S2 })]);
    expect(states[2]).toMatchObject({ attempts: 2, scope: S1 });
    expect(states[3]).toMatchObject({ verdict: 'pending', step: 'first', attempts: 0, scope: S2, first: { gen: 4 } });
  });

  it('spóźniony starszy odczyt nie zeruje pary: `null` z niższą generacją nic nie zmienia', () => {
    const states = trace([read(2, 0, A), read(1, 500, null), forced(3, 800, A)]);
    expect(states[1]).toMatchObject({ step: 'stale', first: { gen: 2 } });
    expect(states[2]?.verdict).toBe('stable');
  });

  it('generacja zerującego odczytu też jest przyjęta: starszy odczyt po nim się nie liczy', () => {
    const states = trace([read(1, 0, A), read(3, 100, null), forced(2, 900, A)]);
    expect(states.map((s) => s.step)).toEqual(['first', 'no-block', 'stale']);
    expect(states[2]).toMatchObject({ verdict: 'pending', lastGen: 3, first: null });
  });
});

describe('zakres komendy: dwie kolejne próby w jednym wykonaniu', () => {
  const cmd = (gen: number, endedAt: number, print: string | null, scope: StabilityScope = RUN1): StabilityRead =>
    read(gen, endedAt, print, { scope });

  it('[A, A] w kolejnych próbach = stabilny bez wymuszenia i bez progu 800 ms', () => {
    const state = last([cmd(1, 0, A), cmd(2, 400, A)]);
    expect(state).toMatchObject({ verdict: 'stable', step: 'stable', scope: RUN1, first: { gen: 1 } });
  });

  it('[A, A z cache] = ta sama generacja, para czeka', () => {
    expect(last([cmd(1, 0, A), cmd(1, 0, A)])).toMatchObject({ verdict: 'pending', step: 'cached' });
  });

  it('[A, null, A] i [A, A′] = niestabilne; [A, A′, A′] = stabilny na kolejnej parze A′', () => {
    expect(last([cmd(1, 0, A), cmd(2, 400, null), cmd(3, 800, A)])).toMatchObject({
      verdict: 'pending', step: 'first',
    });
    expect(last([cmd(1, 0, A), cmd(2, 400, A_PRIM)])).toMatchObject({ verdict: 'pending', step: 'changed' });
    expect(last([cmd(1, 0, A), cmd(2, 400, A_PRIM), cmd(3, 800, A_PRIM)])).toMatchObject({
      verdict: 'stable', first: { gen: 2, print: A_PRIM },
    });
  });

  it('dwa wykonania tej samej komendy nie dzielą pary', () => {
    const state = last([cmd(1, 0, A, RUN1), cmd(2, 400, A, RUN2)]);
    expect(state).toMatchObject({ verdict: 'pending', step: 'first', scope: RUN2, first: { gen: 2 } });
  });

  it('para z blokady nie przechodzi do komendy i odwrotnie', () => {
    expect(last([forced(1, 0, A), cmd(2, 900, A)])).toMatchObject({ verdict: 'pending', step: 'first' });
    expect(last([cmd(1, 0, A), forced(2, 900, A)])).toMatchObject({ verdict: 'pending', step: 'first' });
  });

  it('próby bez bloku przed dialogiem nie zużywają budżetu: pętla czeka, aż dialog się narysuje', () => {
    const states = trace([cmd(1, 0, null), cmd(2, 400, null), cmd(3, 800, null), cmd(4, 1200, null),
      cmd(5, 1600, A), cmd(6, 2000, A)]);
    expect(states.slice(0, 4).every((s) => s.attempts === 0 && s.step === 'no-block')).toBe(true);
    expect(states[5]?.verdict).toBe('stable');
  });
});

describe('trzy próby bez stabilności = `unstable`', () => {
  it('blokada: [A, B, C, D] wymuszone co 800 ms = `unstable` po trzeciej próbie', () => {
    const states = trace([read(1, 0, A), forced(2, 800, B), forced(3, 1600, C), forced(4, 2400, D)]);
    expect(states.map((s) => s.verdict)).toEqual(['pending', 'pending', 'pending', 'unstable']);
    expect(states.map((s) => s.attempts)).toEqual([0, 1, 2, 3]);
    expect(STABILITY_ATTEMPTS).toBe(3);
  });

  it('komenda: [A, B, C, D] w kolejnych próbach = `unstable`', () => {
    const state = last([A, B, C, D].map((print, i) => read(i + 1, i * 400, print, { scope: RUN1 })));
    expect(state).toMatchObject({ verdict: 'unstable', attempts: 3, scope: RUN1 });
  });

  it('`unstable` trwa do końca zakresu, nawet przy późniejszej uczciwej parze; nowy zakres zaczyna od zera', () => {
    const unstable = last([read(1, 0, A), forced(2, 800, B), forced(3, 1600, C), forced(4, 2400, D)]);
    const after = trace([forced(5, 3200, D), forced(6, 4000, D), forced(7, 4800, D, { scope: S2 })], unstable);
    expect(after.map((s) => s.step)).toEqual(['settled', 'settled', 'first']);
    expect(after.map((s) => s.verdict)).toEqual(['unstable', 'unstable', 'pending']);
    expect(after[2]).toMatchObject({ attempts: 0, scope: S2 });
  });

  it('migotanie bloku [A, null, A, null, A, null] zużywa próby mimo zerowania pary', () => {
    const states = trace([
      read(1, 0, A), forced(2, 800, null), forced(3, 1600, A), forced(4, 2400, null), forced(5, 3200, A),
      forced(6, 4000, null),
    ]);
    expect(states.map((s) => s.attempts)).toEqual([0, 1, 1, 2, 2, 3]);
    expect(states.at(-1)?.verdict).toBe('unstable');
  });

  it('niewymuszone odczyty w blokadzie nie zużywają prób, nawet z innym odciskiem', () => {
    const state = last([read(1, 0, A), read(2, 800, B), read(3, 1600, C), read(4, 2400, D), read(5, 3200, A)]);
    expect(state).toMatchObject({ verdict: 'pending', attempts: 0, step: 'changed' });
  });
});

describe('odczyt nieważny i zakres', () => {
  it('generacja albo czas spoza liczb zeruje parę i nie przesuwa generacji', () => {
    const stable = last([read(1, 0, A), forced(2, 800, A)]);
    for (const bad of [read(Number.NaN, 900, A), read(3.5, 900, A), forced(3, Number.NaN, A)]) {
      expect(observeStability(stable, bad)).toMatchObject({
        verdict: 'pending', step: 'invalid', first: null, lastGen: 2, attempts: 0,
      });
    }
  });

  it('`sameScope`: ten sam rodzaj i numer', () => {
    expect(sameScope(S1, { kind: 'blocked', seq: 1 })).toBe(true);
    expect(sameScope(S1, S2)).toBe(false);
    expect(sameScope(RUN1, { kind: 'command', run: 1 })).toBe(true);
    expect(sameScope(RUN1, RUN2)).toBe(false);
    expect(sameScope(S1, RUN1)).toBe(false);
    expect(sameScope(RUN1, S1)).toBe(false);
  });
});

describe('własności (fast-check)', () => {
  const scopeArb = fc.constantFrom<StabilityScope>(S1, S2, RUN1, RUN2);
  const printArb = fc.constantFrom<string | null>(A, B, null);

  /** Zwykle `null`, raz na `weight + 1` wartość z `arb`. */
  const rarely = <T>(arb: fc.Arbitrary<T>, weight: number): fc.Arbitrary<T | null> =>
    fc.oneof({ weight, arbitrary: fc.constant(null) }, { weight: 1, arbitrary: arb });

  /** Dowolny odczyt; mniej więcej co piąty zaczyna się w innym zakresie, niż się kończy. */
  const readArb = fc.record({
    gen: fc.integer({ min: 1, max: 12 }),
    endedAt: fc.integer({ min: 0, max: 6000 }),
    print: printArb,
    forced: fc.boolean(),
    scopeAtEnd: scopeArb,
    otherStart: rarely(scopeArb, 4),
  }).map(({ otherStart, scopeAtEnd, ...rest }): StabilityRead => ({
    ...rest, scopeAtEnd, scopeAtStart: otherStart ?? scopeAtEnd,
  }));

  /**
   * Ciąg odczytów bliski prawdziwemu: generacje zwykle rosną (czasem kopia z pamięci albo spóźniony koniec), czas
   * biegnie naprzód, zakres zmienia się rzadko, a mniej więcej co dziesiąty odczyt zaczyna się w innym zakresie.
   * Ciąg z samych losowych generacji byłby po kilku krokach prawie cały `stale` i nie doszedłby do par i prób.
   */
  const readsArb = (maxLength: number): fc.Arbitrary<StabilityRead[]> => fc.tuple(
    scopeArb,
    fc.array(fc.record({
      lag: fc.oneof({ weight: 6, arbitrary: fc.constant(0) }, { weight: 2, arbitrary: fc.integer({ min: 1, max: 3 }) }),
      gap: fc.integer({ min: 0, max: 1200 }),
      print: printArb,
      forced: fc.boolean(),
      nextScope: rarely(scopeArb, 7),
      otherStart: rarely(scopeArb, 9),
    }), { maxLength }),
  ).map(([initial, steps]) => {
    let scope = initial;
    let endedAt = 0;
    return steps.map((s, i): StabilityRead => {
      scope = s.nextScope ?? scope;
      endedAt += s.gap;
      return {
        gen: Math.max(1, i + 1 - s.lag), endedAt, print: s.print, forced: s.forced,
        scopeAtEnd: scope, scopeAtStart: s.otherStart ?? scope,
      };
    });
  });

  /** Krok z zamrożonym wejściem: maszyna, która coś zmieni w argumencie, rzuci w trybie ścisłym. */
  function frozenStep(state: StabilityState, r: StabilityRead): StabilityState {
    const freeze = <T extends object>(value: T): T => {
      for (const inner of Object.values(value)) if (inner !== null && typeof inner === 'object') freeze(inner);
      return Object.freeze(value);
    };
    return observeStability(freeze(structuredClone(state)), freeze(structuredClone(r)));
  }

  it('kopia z generacją nie wyższą niż ostatnia, wstawiona gdziekolwiek, nie zmienia wyniku', () => {
    fc.assert(fc.property(
      readsArb(20).filter((reads) => reads.length > 0),
      fc.array(fc.tuple(fc.nat(), fc.nat(), readArb), { maxLength: 6 }),
      (reads, copies) => {
        const base = last(reads);
        // Kopia odczytu sprzed miejsca wstawienia: jej generacja jest ≤ ostatnio przyjętej, treść dowolna.
        const withCopies = [...reads];
        for (const [at, from, content] of copies) {
          const pos = 1 + (at % withCopies.length);
          const source = withCopies[from % pos];
          if (source === undefined) continue;
          withCopies.splice(pos, 0, { ...content, gen: source.gen });
        }
        expect(core(last(withCopies))).toEqual(core(base));
      },
    ), { numRuns: 2000 });
  });

  it('wejście w `stable` ma uczciwą parę: ten sam zakres i odcisk, wyższa generacja, wymuszenie i 800 ms', () => {
    fc.assert(fc.property(readsArb(30), (reads) => {
      let state = INITIAL_STABILITY;
      for (const r of reads) {
        const next = frozenStep(state, r);
        if (next.verdict === 'stable' && state.verdict !== 'stable') {
          expect(state.verdict).toBe('pending');
          if (state.verdict !== 'pending' || state.first === null || state.scope === null) {
            throw new Error('stabilność bez pierwszego odczytu pary');
          }
          expect(sameScope(state.scope, r.scopeAtStart) && sameScope(r.scopeAtStart, r.scopeAtEnd)).toBe(true);
          expect(r.gen).toBeGreaterThan(state.lastGen ?? -Infinity);
          expect(r.gen).toBeGreaterThan(state.first.gen);
          expect(r.print).toBe(state.first.print);
          if (r.scopeAtEnd.kind === 'blocked') {
            expect(r.forced).toBe(true);
            expect(r.endedAt - state.first.endedAt).toBeGreaterThanOrEqual(STABILITY_GAP_MS);
          }
        }
        expect(next.attempts).toBeLessThanOrEqual(STABILITY_ATTEMPTS);
        state = next;
      }
    }), { numRuns: 2000 });
  });

  it('między dwoma potwierdzonymi parami próby startują od zera: `stable` i stan tuż po nim mają 0 prób', () => {
    fc.assert(fc.property(readsArb(40), (reads) => {
      let state = INITIAL_STABILITY;
      for (const r of reads) {
        const next = frozenStep(state, r);
        if (next.verdict === 'stable') expect(next.attempts).toBe(0);
        if (state.verdict === 'stable') expect(next.attempts, `krok ${String(next.step)}`).toBe(0);
        state = next;
      }
    }), { numRuns: 2000 });
  });

  it('w blokadzie bez odczytu wymuszonego i przy odciskach parami różnych stabilności nie ma nigdy', () => {
    const blockedUnforced = readsArb(30).map((reads) => reads.map((r): StabilityRead => ({
      ...r, forced: false, scopeAtStart: S1, scopeAtEnd: S1,
    })));
    fc.assert(fc.property(blockedUnforced, (reads) => {
      expect(trace(reads).some((s) => s.verdict === 'stable')).toBe(false);
    }), { numRuns: 1000 });
    fc.assert(fc.property(readsArb(30), (reads) => {
      const distinct = reads.map((r, i): StabilityRead => ({ ...r, print: r.print === null ? null : `blok-${i}` }));
      expect(trace(distinct).some((s) => s.verdict === 'stable')).toBe(false);
    }), { numRuns: 1000 });
  });

  it('wymuszony odczyt przy czekającej parze: za wczesny czeka bez próby, każdy inny robi postęp', () => {
    fc.assert(fc.property(readsArb(30), readArb, (reads, probe) => {
      const state = reads.reduce<StabilityState>((s, r) => observeStability(s, r), INITIAL_STABILITY);
      if (state.scope === null) return;
      // Świeży, wymuszony odczyt w zakresie pary, bez przecięcia zmiany; koniec od 600 ms przed pierwszym odczytem
      // pary do 5,4 s po nim, więc trafia i przed, i za granicę 800 ms.
      const anchor = 'first' in state && state.first !== null ? state.first.endedAt : 0;
      const r: StabilityRead = {
        ...probe, gen: (state.lastGen ?? 0) + 1, endedAt: anchor + probe.endedAt - 600, forced: true,
        scopeAtStart: state.scope, scopeAtEnd: state.scope,
      };
      const next = frozenStep(state, r);
      if (state.verdict === 'unstable') {
        expect(next.verdict).toBe('unstable');
        return;
      }
      if (state.verdict !== 'pending' || state.first === null) return;
      const early = r.scopeAtEnd.kind === 'blocked' && r.print === state.first.print
        && r.endedAt - state.first.endedAt < STABILITY_GAP_MS;
      if (early) {
        // Odczyt, który nie mógł potwierdzić pary: ani próby, ani nowej pary.
        expect(next).toEqual({ ...state, lastGen: r.gen, step: 'early' });
        return;
      }
      const progressed = next.verdict !== 'pending' || next.attempts === state.attempts + 1;
      expect(progressed, `krok ${String(next.step)}`).toBe(true);
    }), { numRuns: 2000 });
  });
});
