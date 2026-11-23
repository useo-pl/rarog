/**
 * Mechanizm zapadki polskich literałów w kodzie serwera: które napisy i szablony `server/src/**`
 * i `shared/src/**` są polskie. Test i wyjątki: `polski-literal-zapadka.test.ts`.
 *
 * Jednostka to literał w drzewie składni (`parseAst` z `vitest/node`): napis (`'…'`, `"…"`) albo cały szablon
 * (`` `…` ``) z kawałkami tekstu; wyrażenia w `${…}` to osobne literały. Wzorce `/…/`, komentarze i specyfikatory
 * modułów (`import … from '…'`, `export … from '…'`, `import('…')`) nie są tekstem. Regułę „czy tekst jest polski”
 * bierze z `polski-tekst.ts` (`polski(tekst, true)`: polski znak albo polskie słowo ASCII, z `jest`), więc mierzy tak
 * samo jak strażnik repo publicznego; szablon jest polski, gdy polski jest któryś jego kawałek.
 *
 * Tekstu logu nie liczy drugi raz: literał, który zaczyna się albo kończy na polskiej linii tekstu logu
 * `server/src/**` (`miejscaLogu` z `polski-log.ts`), należy do zapadki logu i tu odpada. Literał na linii logu
 * odpada w całości, także gdy obok stoi drugi, który do logu nie idzie (znana dziura; zapadka logu i tak tę linię
 * pilnuje).
 */
import { parseAst } from 'vitest/node';
import { miejscaLogu } from './polski-log.ts';
import { polski } from './polski-tekst.ts';

/** Polski literał: plik, linia początku (od 1) i tekst (białe znaki ściśnięte do spacji, interpolacja `${…}`). */
export interface PolskiLiteral {
  readonly plik: string;
  readonly linia: number;
  readonly tekst: string;
}

export interface Literaly {
  /** Polskie literały poza tekstem logu, po pliku i pozycji. */
  readonly literaly: readonly PolskiLiteral[];
  /** Pliki, których parser nie przeczytał. */
  readonly nieczytelne: readonly string[];
}

interface Wezel {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [pole: string]: unknown;
}

const wezel = (x: unknown): Wezel | null =>
  typeof x === 'object' && x !== null && typeof (x as { type?: unknown }).type === 'string' ? x as Wezel : null;

/** Węzły, których pole `source` to specyfikator modułu, nie tekst. */
const ZE_ZRODLEM = new Set(['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression']);

/** Pliki kodu w zakresie: TypeScript i JavaScript bez deklaracji typów. */
export const plikKodu = (plik: string): boolean => /\.(?:ts|mts|cts|js|mjs|cjs)$/u.test(plik) && !/\.d\.[mc]?ts$/u.test(plik);

const scisnij = (tekst: string): string => tekst.replace(/\s+/gu, ' ').trim();

/** Polskie literały plików (ścieżka względem korzenia → treść), bez tekstu logu `server/src/**`. */
export function polskieLiteraly(pliki: ReadonlyMap<string, string>): Literaly {
  const logi = miejscaLogu(new Map([...pliki].filter(([plik]) => plik.startsWith('server/src/')))).linie;
  const literaly: PolskiLiteral[] = [];
  const nieczytelne: string[] = [];
  for (const [plik, kod] of [...pliki].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    let ast: Wezel | null;
    try {
      ast = wezel(parseAst(kod, { lang: 'ts', sourceType: 'module' }));
    } catch {
      ast = null;
    }
    if (ast === null) {
      nieczytelne.push(plik);
      continue;
    }
    const poczatki = [0];
    for (let i = 0; i < kod.length; i += 1) if (kod[i] === '\n') poczatki.push(i + 1);
    const nrLinii = (offset: number): number => {
      let lo = 0;
      let hi = poczatki.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (poczatki[mid]! <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };
    const liniiLogu = new Set(logi.get(plik) ?? []);
    const dodaj = (n: Wezel, tekst: string): void => {
      const linia = nrLinii(n.start);
      if (liniiLogu.has(linia) || liniiLogu.has(nrLinii(n.end))) return;
      literaly.push({ plik, linia, tekst: scisnij(tekst) });
    };
    const przejdz = (n: Wezel): void => {
      if (n.type === 'Literal' && typeof n['value'] === 'string' && n['regex'] === undefined) {
        if (polski(n['value'], true)) dodaj(n, n['value']);
        return;
      }
      if (n.type === 'TemplateLiteral') {
        const kawalki = (Array.isArray(n['quasis']) ? n['quasis'] : []).map((q) => {
          const v = (q as { value?: { cooked?: string | null; raw?: string } }).value;
          return v?.cooked ?? v?.raw ?? '';
        });
        if (kawalki.some((k) => polski(k, true))) dodaj(n, kawalki.join('${…}'));
      }
      for (const [klucz, v] of Object.entries(n)) {
        if (klucz === 'type' || v === null || typeof v !== 'object') continue;
        if (klucz === 'source' && ZE_ZRODLEM.has(n.type)) continue;
        if (n.type === 'TemplateLiteral' && klucz === 'quasis') continue;
        for (const dziecko of Array.isArray(v) ? v : [v]) {
          const w = wezel(dziecko);
          if (w !== null) przejdz(w);
        }
      }
    };
    przejdz(ast);
  }
  return { literaly, nieczytelne };
}

/** Wyjątki: plik → klasa → teksty literałów, które zostają polskie (wpis zdejmuje jeden literał o tym tekście). */
export type Wyjatki = Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;

/** Wyjątek, który niczego nie zdjął: plik, klasa i tekst. */
export interface MartwyWyjatek {
  readonly plik: string;
  readonly klasa: string;
  readonly tekst: string;
}

export interface Policzone {
  /** Plik → liczba polskich literałów poza wyjątkami (tylko pliki z co najmniej jednym). */
  readonly liczby: Map<string, number>;
  /** Plik → `linia: tekst` literałów poza wyjątkami, do komunikatu porażki. */
  readonly linie: Map<string, string[]>;
  readonly martwe: readonly MartwyWyjatek[];
}

/**
 * Polskie literały per plik poza wyjątkami. Wyjątki to multizbiór: każdy wpis zdejmuje jeden literał pliku o tym
 * samym tekście, więc tekst, który stoi w pliku dwa razy i dwa razy zostaje polski, ma dwa wpisy, a trzecie
 * wystąpienie liczy się. Wpis bez literału do zdjęcia jest martwy.
 */
export function policz(literaly: readonly PolskiLiteral[], wyjatki: Wyjatki): Policzone {
  const wolne = new Map<string, { klasa: string; tekst: string; uzyty: boolean }[]>();
  for (const [plik, klasy] of Object.entries(wyjatki)) {
    for (const [klasa, teksty] of Object.entries(klasy)) {
      for (const tekst of teksty) wolne.set(plik, [...(wolne.get(plik) ?? []), { klasa, tekst, uzyty: false }]);
    }
  }
  const liczby = new Map<string, number>();
  const linie = new Map<string, string[]>();
  for (const l of literaly) {
    const wpis = wolne.get(l.plik)?.find((w) => !w.uzyty && w.tekst === l.tekst);
    if (wpis !== undefined) {
      wpis.uzyty = true;
      continue;
    }
    liczby.set(l.plik, (liczby.get(l.plik) ?? 0) + 1);
    linie.set(l.plik, [...(linie.get(l.plik) ?? []), `${String(l.linia)}: ${l.tekst}`]);
  }
  const martwe = [...wolne].flatMap(([plik, wpisy]) =>
    wpisy.filter((w) => !w.uzyty).map(({ klasa, tekst }) => ({ plik, klasa, tekst })));
  return { liczby, linie, martwe };
}
