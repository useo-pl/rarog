/**
 * Stabilność bloku warstwy 2: czy dwa RZECZYWISTE odczyty ekranu pokazały ten sam blok w tym samym zakresie.
 *
 * Przycisk warstwy 2 wymaga bloku, który stoi dłużej niż jedna klatka przemalowania TUI. Maszyna jest czysta:
 * bez zegarów, bez wejścia-wyjścia i bez stanu panelu. Generację, zakresy, czas końca i odcisk odczytu podaje
 * wołający ({@link StabilityRead}); on też trzyma stan ({@link StabilityState}) i po każdym odczycie podaje go
 * {@link observeStability} razem z odczytem.
 *
 * Reguły:
 *
 * - generacja nie wyższa niż ostatnio przyjęta nie liczy się: równa to kopia z pamięci ekranu (odczyt z cache
 *   dziedziczy generację odczytu, z którego pochodzi), niższa to koniec spóźniony wobec nowszego odczytu;
 * - odczyt, którego zakres na starcie różni się od zakresu na końcu, przeciął zmianę blokady i zeruje parę;
 * - brak bloku (`print: null`, także wyjątek odczytu), inny odcisk albo nowy zakres zeruje parę;
 * - blokada jest stabilna, gdy drugi odczyt pary jest wymuszony i skończył się co najmniej
 *   {@link STABILITY_GAP_MS} po pierwszym; komenda, gdy dwie kolejne próby pętli potwierdzenia dały ten sam odcisk;
 * - próba to odczyt, który mógł potwierdzić czekającą parę (w blokadzie tylko wymuszony), a pokazał inny odcisk,
 *   brak bloku albo przeciął zmianę zakresu; odczyt wymuszony za wcześnie próby nie zużywa, bo nie mógł potwierdzić
 *   pary, a wołający zamawia drugi odczyt nie wcześniej niż {@link STABILITY_GAP_MS} po pierwszym;
 * - potwierdzona para zeruje próby, a odczyt, który ją psuje, zaczyna nową parę od zera: w jednej blokadzie blok
 *   potrafi ustąpić następnemu bez klatki `working` (formularz przełącza zakładkę w miejscu, zgoda przy biurku
 *   ustępuje następnej);
 * - po {@link STABILITY_ATTEMPTS} próbach bez stabilności werdykt `unstable` trwa do końca zakresu.
 */

/** Najmniejszy odstęp końców pary odczytów w blokadzie; drugi, wymuszony odczyt zamawia timer drivera. */
export const STABILITY_GAP_MS = 800;

/** Ile prób bez stabilności w jednym zakresie daje werdykt `unstable` (karta bez przycisków). */
export const STABILITY_ATTEMPTS = 3;

/**
 * Zakres pary odczytów: jedna blokada herdr (numer blokady drivera) albo jedno wykonanie komendy w pętli
 * potwierdzenia. Wykonanie komendy ma własny numer, bo przy wspólnym zakresie „komenda” dwa wykonania po sobie
 * (ta sama komenda wysłana dwa razy) dzieliłyby parę i odczyt pierwszego potwierdzałby drugie.
 */
export type StabilityScope =
  | { readonly kind: 'blocked'; readonly seq: number }
  | { readonly kind: 'command'; readonly run: number };

/** Ten sam rodzaj i ten sam numer zakresu. */
export function sameScope(a: StabilityScope, b: StabilityScope): boolean {
  switch (a.kind) {
    case 'blocked':
      return b.kind === 'blocked' && b.seq === a.seq;
    case 'command':
      return b.kind === 'command' && b.run === a.run;
  }
}

/** Jeden odczyt ekranu, tak jak go podaje owijka drivera. */
export interface StabilityRead {
  /** Rosnący numer rzeczywistego odczytu; kopia z pamięci ekranu niesie numer odczytu, z którego pochodzi. */
  readonly gen: number;
  /** Zakres w chwili startu odczytu. */
  readonly scopeAtStart: StabilityScope;
  /** Zakres w chwili końca odczytu: w nim liczy się para. */
  readonly scopeAtEnd: StabilityScope;
  /** Chwila końca odczytu w milisekundach zegara drivera. */
  readonly endedAt: number;
  /** Odcisk bloku; `null` to brak bloku na ekranie albo wyjątek odczytu. */
  readonly print: string | null;
  /** Odczyt z pominięciem pamięci ekranu. */
  readonly forced: boolean;
}

/** Pierwszy odczyt pary: to, co drugi odczyt ma potwierdzić. */
export interface StabilityCandidate {
  readonly gen: number;
  readonly endedAt: number;
  readonly print: string;
}

/**
 * Jak maszyna potraktowała ostatni odczyt (dziennik i testy) — ZAMKNIĘTA lista:
 *
 * - `cached` / `stale` — nie liczy się: generacja równa / niższa niż ostatnio przyjęta;
 * - `invalid` — generacja albo czas końca nie są liczbą: para wyzerowana, generacja nieprzyjęta;
 * - `crossed` — zakres na starcie różni się od zakresu na końcu: para wyzerowana;
 * - `no-block` — brak bloku albo wyjątek odczytu: para wyzerowana;
 * - `first` — pierwszy odczyt pary; `changed` — inny odcisk zaczyna nową parę;
 * - `unforced` — ten sam odcisk, ale w blokadzie odczyt niewymuszony: para czeka, próba niezużyta;
 * - `early` — ten sam odcisk, odczyt wymuszony bliżej niż {@link STABILITY_GAP_MS} od pierwszego: para czeka,
 *   próba niezużyta;
 * - `stable` — para potwierdzona teraz albo wcześniej, próby wyzerowane;
 * - `settled` — werdykt `unstable` trwa do końca zakresu.
 */
export const STABILITY_STEPS = [
  'cached', 'stale', 'invalid', 'crossed', 'no-block', 'first', 'changed', 'unforced', 'early', 'stable', 'settled',
] as const;
export type StabilityStep = (typeof STABILITY_STEPS)[number];

interface StabilityCommon {
  /** Najwyższa przyjęta generacja, także odczytu, który wyzerował parę; `null` przed pierwszym odczytem. */
  readonly lastGen: number | null;
  /** Próby bez stabilności w bieżącym zakresie, od jego początku albo od ostatniej potwierdzonej pary. */
  readonly attempts: number;
  /** Co zrobił ostatni odczyt; `null` w stanie początkowym. */
  readonly step: StabilityStep | null;
}

/**
 * Stan maszyny. `pending` czeka na drugi odczyt pary (albo na pierwszy, gdy `first` jest `null`); `stable` ma
 * potwierdzoną parę i jej odcisk w `first`; `unstable` to koniec prób w zakresie.
 */
export type StabilityState =
  | (StabilityCommon & {
    readonly verdict: 'pending';
    readonly scope: StabilityScope | null;
    readonly first: StabilityCandidate | null;
  })
  | (StabilityCommon & {
    readonly verdict: 'stable';
    readonly scope: StabilityScope;
    readonly first: StabilityCandidate;
  })
  | (StabilityCommon & { readonly verdict: 'unstable'; readonly scope: StabilityScope });

/** Stan przed pierwszym odczytem. */
export const INITIAL_STABILITY: StabilityState = {
  verdict: 'pending', lastGen: null, scope: null, first: null, attempts: 0, step: null,
};

/** Nowy stan maszyny po jednym odczycie. Funkcja czysta: nie zmienia argumentów. */
export function observeStability(state: StabilityState, read: StabilityRead): StabilityState {
  if (!Number.isSafeInteger(read.gen) || !Number.isFinite(read.endedAt)) {
    if (state.verdict === 'unstable') return { ...state, step: 'invalid' };
    return { ...state, verdict: 'pending', first: null, step: 'invalid' };
  }
  if (state.lastGen !== null && read.gen <= state.lastGen) {
    return { ...state, step: read.gen === state.lastGen ? 'cached' : 'stale' };
  }

  const lastGen = read.gen;
  const scope = read.scopeAtEnd;
  const sameAsBefore = state.scope !== null && sameScope(state.scope, scope);
  if (sameAsBefore && state.verdict === 'unstable') return { ...state, lastGen, step: 'settled' };
  const first = sameAsBefore && state.verdict !== 'unstable' ? state.first : null;
  const attempts = sameAsBefore ? state.attempts : 0;
  // Potwierdzona para ma próby wyzerowane; odczyt, który ją psuje, nie jest próbą, tylko początkiem nowej pary.
  const wasStable = sameAsBefore && state.verdict === 'stable';
  // Tylko taki odczyt może potwierdzić parę: w blokadzie wyłącznie wymuszony, w pętli komendy każda próba.
  const confirming = scope.kind === 'command' || read.forced;

  /** Odczyt, który nie potwierdził czekającej pary: próba, gdy mógł ją potwierdzić. */
  const miss = (step: StabilityStep, next: StabilityCandidate | null): StabilityState => {
    const tried = attempts + (first !== null && confirming && !wasStable ? 1 : 0);
    if (tried >= STABILITY_ATTEMPTS) return { verdict: 'unstable', lastGen, scope, attempts: tried, step };
    return { verdict: 'pending', lastGen, scope, first: next, attempts: tried, step };
  };

  if (!sameScope(read.scopeAtStart, scope)) return miss('crossed', null);
  if (read.print === null) return miss('no-block', null);
  const candidate: StabilityCandidate = { gen: read.gen, endedAt: read.endedAt, print: read.print };
  if (first === null) return { verdict: 'pending', lastGen, scope, first: candidate, attempts, step: 'first' };
  if (read.print !== first.print) return miss('changed', candidate);
  if (sameAsBefore && state.verdict === 'stable') return { ...state, lastGen, step: 'stable' };
  if (!confirming) return { verdict: 'pending', lastGen, scope, first, attempts, step: 'unforced' };
  if (scope.kind === 'blocked' && read.endedAt - first.endedAt < STABILITY_GAP_MS) {
    return { verdict: 'pending', lastGen, scope, first, attempts, step: 'early' };
  }
  return { verdict: 'stable', lastGen, scope, first, attempts: 0, step: 'stable' };
}
