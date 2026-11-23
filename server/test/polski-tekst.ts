/**
 * Mechanizm strażnika polskiego tekstu w repo publicznym:
 * dokumenty publiczne i to, co komenda `rarog`, publiczne skrypty i hooki pokazują człowiekowi albo modelowi, są po
 * angielsku. Test i lista wyjątków: `polski-tekst-zapadka.test.ts`.
 *
 * Linia jest polska, gdy jej tekst ma polski znak ({@link ZNAKI}) albo polskie słowo pisane ASCII ({@link SLOWA}).
 * Lista słów jest zamknięta i nie zależy od oceny modelu: to słowa z polskich linii repo (z polskimi znakami, po
 * zdjęciu znaków), których nie ma w angielskim słowniku systemu (`/usr/share/dict/words`) ani w deklaracjach typów
 * zależności (`node_modules/**\/*.d.ts`), plus słowa z inwentarza komunikatów CLI. Test sprawdza listę na
 * dokumentacji zależności i na angielskich plikach wejścia repo (zero trafień); przy budowie listy zmierzono też
 * strony `man` macOS (2 trafienia „nic” na 564 tys. linii), literały kodu zależności (trafienia tylko w polskich
 * i słowiańskich tekstach lokalizacji) i czułość: 96,7% polskich linii od czterech słów po zdjęciu polskich znaków.
 * Słowo liczy się małymi literami, z wielką pierwszą albo WIELKIMI, jako całe słowo spoza identyfikatora:
 * ciąg liter przyklejony do `-`, `_`, `.`, `/`, `\`, `$`, `@` albo cyfry to nazwa (`bez-czekania`, `.przejecie`,
 * `docs/dialogs.md`, `brak_pliku`), nie słowo prozy.
 *
 * Co jest tekstem w pliku (`kawalki`):
 * - dokument `.md`: każda linia, także w blokach kodu i komentarzach HTML (przykładowe wyjście CLI, log i komenda
 *   w bloku kodu też mają być po angielsku; cytat polskiej frazy, która zostaje, idzie do wyjątków z powodem);
 * - kod TypeScript i JavaScript: napisy i kawałki szablonów (`tsTextLiterals`: bez komentarzy, wzorców `/…/`
 *   i specyfikatorów importów), z rozwiniętymi znakami ucieczki; interpolacja `${…}` to dane, nie tekst;
 * - skrypt powłoki i Pythona: napisy w `'…'`, `"…"` i `$'…'` (bez rozwinięć `$x`, `${…}`, `$(…)` i `` `…` ``, ale
 *   ze statyczną wartością domyślną `${x:-…}`) oraz treść heredoców (heredoc dla `node` czyta się jak kod
 *   JavaScript, dla `python` jak skrypt Pythona; `<<<` to here-string, nie heredoc); komentarze `#` i docstringi
 *   Pythona (napis `"""…"""` jako pierwsze wyrażenie modułu, klasy albo funkcji) odpadają, reszta napisów
 *   w potrójnych cudzysłowach zostaje;
 * - reszta (szablony plików kładzionych u użytkownika, JSON): każda linia, bo człowiek czyta cały plik.
 *
 * Linia z kilkoma kawałkami liczy się raz. Wyjątek to cała linia pliku po `trim()` z powodem (lista w teście,
 * zamknięta; wyjątek, który nie trafia polskiej linii, jest błędem).
 */
import path from 'node:path';
import { tsTextLiterals } from './product-identity.ts';

/** Polskie znaki diakrytyczne. */
export const ZNAKI = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/u;

/**
 * Polskie słowa pisane ASCII (także polskie słowa po zdjęciu znaków: `sie`, `juz`, `wiec`). Bez słów, które są też
 * angielskie albo techniczne (`jest` to framework Jest, `pod` to pod Kubernetesa, `ten`, `go`, `do`, `to`, `na`,
 * `po`, `od`, `co`, `stan`, `sam`, `ale`), bez nazw (`rarog`, `herdr`) i bez jednoliterowych `w`, `z`, `i`, `a`
 * (zmienne i opcje w angielskim kodzie). Lista tylko rośnie o słowo, które nie trafia angielskiego korpusu testu.
 */
export const SLOWA_LISTA: readonly string[] = `
  adres agenta albo apka apki baner bez biblioteka bierze blad blok bloku brak bramka budowania byc chwili commita
  cyfra czas czeka czy czyli czyta daje dalej danych decyzja decyzji dialogu dla dobry doinstaluj dokladnie domeny
  dopiero dostaje dostarcza dowiazanie drugi dwa dymek dziala ekran ekranie ekranu emisja etykieta etykiety faza
  gasi gdy gdzie gniazda gniazdo gotowe hooka idzie inaczej inna inne innego innej inny instalacja jak jako jawnego
  jeden jedna jednak jedno jednym jego jej jesli jeszcze juz kafel karcie karta karte karty katalog katalogu kazda
  kazde kazdego kazdej kazdy kazdym klient klienta klon klucz klucza kod kodem kodu komenda komende komendy konca
  koncu konczy konfiguracja konfiguracji koniec kopia kopii krawedzi kreska kroku ksztalt ktora ktore ktorego
  ktorej ktory ktorym liczba liczy linia linie linii liscie lista liste listy lub mapowanie metoda miedzy modelu
  mowi moze mozna musi nad naglowek naglowka najpierw najwyzej napis narzedzia narzedzie nazwa nazwy nic niczego
  nie nieczytelna nieczytelne nieczytelny niedozwolona niego niej niepuste niesie nieznana nieznany nigdy niz nizej
  notka nowa nowe nowy oba obok obu oczekiwana oczekiwane oczekiwany odczyt odczytu oddaje odmowa odmowy odpowiada
  odpowiedz odpowiedzi okna okno opcja opcji opis oraz ostatnio otwiera paczce paczek paczka paczki pakiety panelu
  parametry pasek paska pierwsza pierwszy pierwszym pisze planu platformowa plik pliki plikow pliku podaje pokazuje
  pola polu pomiar pomiaru pominieto ponad ponowna ponownie popraw postoju potem potrzebny powloki powod poza
  pracuje prawa proba proces procesu produkcja projekt projektu promptu przechodzi przed przerwane przez przy
  przyczyna pusta puste pusto pusty pytania pytanie ramka ramki raroga raz razem razu regula reguly rejestr rejestru
  robi rodzaj rozmowy sama samego samej samo samym sciezka sciezki sekcja sekrety serwer serwera sesja sesje sesji
  sie silnego sonda sparowane spoza sprawdz sprawdza sprawdzenia sprzed srodowisko stanu stara starcie startu stary
  stoi stoja stopka straznik subagenta sufit systemu szablonu tak takze tego tej tekst tekstu teraz terminala
  terminalu tez tle tlo tokenu trafia trakcie transkryptu tresc tresci tryb trzy trzyma tura tury tutaj tylko tym
  tytul uruchom uruchomisz urzadzenia urzadzenie usluga uslugi ustawienia usunieta usuniety uwaga wariant wartosc
  wartosci wejscie wersja wersje wersji wiadomosc wiadomosci wiec wiem wiersz wiersza wlasny wola wpis wpisu wpisy
  wraca wszystkie wtedy wyklucza wylacznie wymaga wymagane wymagany wynik wyniku wysyla wysylka wysylki wywolania
  wzorcach zablokowana zadan zadania zadanie zainstaluj zamaskowana zamiast zamyka zapis zapisana zapisany zapisu
  zapisuje zapisz zapisze zatrzymaj zatrzymania zatrzymany zawsze zdanie zdejmuje ze zgoda zgody zla zly zmian
  zmiana zmienia zna znacznik znakow zostaja zostaje zostawia zrobione zrzut zrzutu
`.trim().split(/\s+/u);

/** {@link SLOWA_LISTA} jako zbiór. */
export const SLOWA: ReadonlySet<string> = new Set(SLOWA_LISTA);

/**
 * Słowa liczone tylko poza dokumentami (literały kodu, skrypty, szablony): `jest` w angielskim dokumencie bywa
 * nazwą frameworka testów (Jest), a w napisach CLI to polskie „jest” (`curl: jest`).
 */
export const SLOWA_KODU: ReadonlySet<string> = new Set(['jest']);

/** Słowo ASCII spoza identyfikatora, ścieżki, adresu i opcji (opis w nagłówku modułu). */
const SLOWO = /(?<![\p{L}\p{N}_\-./\\$@])[A-Za-z]+(?![\p{L}\p{N}_@/]|-\p{L}|\.\p{L})/gu;

/** Forma słowa, która się liczy: małe litery, wielka pierwsza albo same wielkie. */
const formaSlowa = (slowo: string, male: string): boolean =>
  slowo === male || slowo === male.toUpperCase() || slowo === `${male.charAt(0).toUpperCase()}${male.slice(1)}`;

const BEZ_DODATKOWYCH: ReadonlySet<string> = new Set();

/**
 * Polskie słowa ASCII w tekście, w kolejności; `kod` dokłada {@link SLOWA_KODU}, `dodatkowe` listę zapadki obszaru
 * (`SLOWA_LOGU` w `polski-log.ts`).
 */
export function polskieSlowa(tekst: string, kod: boolean, dodatkowe = BEZ_DODATKOWYCH): string[] {
  const wynik: string[] = [];
  for (const m of tekst.matchAll(SLOWO)) {
    const male = m[0].toLowerCase();
    if (!formaSlowa(m[0], male)) continue;
    if (SLOWA.has(male) || (kod && SLOWA_KODU.has(male)) || dodatkowe.has(male)) wynik.push(m[0]);
  }
  return wynik;
}

/** Czy tekst jest polski: polski znak albo polskie słowo ASCII. */
export const polski = (tekst: string, kod: boolean, dodatkowe = BEZ_DODATKOWYCH): boolean =>
  ZNAKI.test(tekst) || polskieSlowa(tekst, kod, dodatkowe).length > 0;

/** Kawałek tekstu pliku: linia (od 1) i treść. */
export interface Kawalek {
  readonly linia: number;
  readonly tekst: string;
}

/** Rodzaj pliku: jak czytać z niego tekst. */
export type Rodzaj = 'dokument' | 'kod' | 'powloka' | 'python' | 'caly';

export function rodzaj(plik: string): Rodzaj {
  const ext = path.extname(plik);
  if (ext === '.md') return 'dokument';
  if (['.ts', '.mts', '.cts', '.mjs', '.cjs', '.js'].includes(ext)) return 'kod';
  if (ext === '.sh') return 'powloka';
  if (ext === '.py') return 'python';
  return 'caly';
}

/** Znaki ucieczki napisu JavaScript: `\uXXXX`, `\u{…}`, `\xXX` na znak, reszta sterujących na spację. */
function rozwin(tekst: string): string {
  return tekst.replace(/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r?\n)|([\s\S]))/gu,
    (_cale, klamra?: string, u?: string, x?: string, nowa?: string, znak?: string) => {
      const kod = klamra ?? u ?? x;
      if (kod !== undefined) return String.fromCodePoint(Number.parseInt(kod, 16));
      if (nowa !== undefined) return '';
      return znak !== undefined && 'nrtvfb0'.includes(znak) ? ' ' : (znak ?? '');
    });
}

/** Napisy i kawałki szablonów kodu, po liniach (napis przez kilka linii daje kawałek na każdą). */
function kawalkiKodu(tresc: string, przesuniecie = 0): Kawalek[] {
  return tsTextLiterals(tresc).flatMap(({ value, line }) =>
    value.split('\n').map((czesc, i) => ({ linia: line + i + przesuniecie, tekst: rozwin(czesc) })));
}

/**
 * Rozwinięcia powłoki w napisie `"…"`: `$x`, `${…}`, `$(…)` (z zagnieżdżeniem) i `` `…` ``. Z `${x:-słowo}`
 * (także `:=`, `:+`, `:?` i odmiany bez dwukropka) zostaje słowo, bo to statyczny tekst, który człowiek zobaczy.
 */
function bezRozwiniec(tekst: string): string {
  let wynik = '';
  for (let i = 0; i < tekst.length; i += 1) {
    const znak = tekst[i];
    if (znak === '\\') {
      wynik += tekst[i + 1] ?? '';
      i += 1;
    } else if (znak === '`') {
      const koniec = tekst.indexOf('`', i + 1);
      i = koniec === -1 ? tekst.length : koniec;
      wynik += ' ';
    } else if (znak === '$' && (tekst[i + 1] === '(' || tekst[i + 1] === '{')) {
      const otwarcie = tekst[i + 1]!;
      const zamkniecie = otwarcie === '(' ? ')' : '}';
      let glebokosc = 0;
      let j = i + 1;
      for (; j < tekst.length; j += 1) {
        if (tekst[j] === otwarcie) glebokosc += 1;
        else if (tekst[j] === zamkniecie && --glebokosc === 0) break;
      }
      const domyslna = otwarcie === '{'
        ? /^(?:[A-Za-z_]\w*|[0-9]+|[@*#?$!-]):?[-=+?]([\s\S]*)$/u.exec(tekst.slice(i + 2, j))
        : null;
      wynik += domyslna === null ? ' ' : ` ${bezRozwiniec(domyslna[1]!)} `;
      i = j;
    } else if (znak === '$' && /[\w@#?*!$-]/u.test(tekst[i + 1] ?? '')) {
      const nazwa = /^[A-Za-z_]\w*|^[0-9@#?*!$-]/u.exec(tekst.slice(i + 1));
      i += nazwa?.[0].length ?? 0;
      wynik += ' ';
    } else {
      wynik += znak;
    }
  }
  return wynik;
}

interface Heredoc {
  readonly koniec: string;
  readonly myslnik: boolean;
  readonly cytowany: boolean;
  readonly jezyk: 'tekst' | 'node' | 'python';
  readonly od: number;
  readonly linie: string[];
}

/** Nagłówek funkcji albo klasy Pythona (początek linii). */
const NAGLOWEK_PYTHONA = /^\s*(?:async\s+def|def|class)\b/u;

/** Linia Pythona bez komentarza na końcu i bez białych znaków (zgrubnie: `#` w napisie też ucina). */
const bezKomentarzaPythona = (linia: string): string => linia.replace(/#.*$/u, '').trim();

/**
 * Czy napis w potrójnych cudzysłowach zaczynający instrukcję w linii `idx` to docstring: przed nim nie ma kodu
 * (moduł) albo stoi tuż pod nagłówkiem `def` lub `class`, także wielowierszowym (wstecz do linii nagłówka, bez
 * pustej linii i bez innego dwukropka na końcu linii po drodze).
 */
function docstringPythona(linie: readonly string[], idx: number): boolean {
  let poprzednia = idx - 1;
  while (poprzednia >= 0 && bezKomentarzaPythona(linie[poprzednia]!) === '') poprzednia -= 1;
  if (poprzednia < 0) return true;
  if (!bezKomentarzaPythona(linie[poprzednia]!).endsWith(':')) return false;
  for (let k = poprzednia; k >= Math.max(0, poprzednia - 20); k -= 1) {
    if (NAGLOWEK_PYTHONA.test(linie[k]!)) return true;
    const tresc = bezKomentarzaPythona(linie[k]!);
    if (tresc === '' || (k !== poprzednia && tresc.endsWith(':'))) return false;
  }
  return false;
}

/**
 * Napisy skryptu powłoki albo Pythona po liniach. To nie jest parser: zna cudzysłowy (także przez kilka linii),
 * `$'…'`, komentarz `#` na początku słowa, heredoc (`<<EOF`, `<<-'EOF'`; `<<<` to here-string, a jego słowo jest
 * zwykłym napisem albo słowem) i napisy w potrójnych cudzysłowach Pythona (docstring odpada: `docstringPythona`).
 */
/** Otwarty napis skryptu: znak otwarcia, czy rozwija `$`, treść, linia początku i czy to docstring Pythona. */
interface Napis {
  readonly znak: string;
  readonly rozwijany: boolean;
  tekst: string;
  readonly linia: number;
  readonly docstring?: boolean;
}

function kawalkiSkryptu(tresc: string, python: boolean): Kawalek[] {
  const wynik: Kawalek[] = [];
  const linie = tresc.split('\n');
  let cudzyslow: Napis | null = null;
  let heredoc: Heredoc | null = null;
  const oczekujace: Heredoc[] = [];
  const zamknijNapis = (): void => {
    if (cudzyslow === null) return;
    const tekst = cudzyslow.rozwijany ? bezRozwiniec(cudzyslow.tekst) : cudzyslow.tekst;
    tekst.split('\n').forEach((czesc, i) => wynik.push({ linia: cudzyslow!.linia + i, tekst: czesc }));
    cudzyslow = null;
  };
  linie.forEach((linia, idx) => {
    const nr = idx + 1;
    if (heredoc !== null) {
      if ((heredoc.myslnik ? linia.replace(/^\t+/u, '') : linia) === heredoc.koniec) {
        const tekst = heredoc.linie.join('\n');
        const przesuniecie = heredoc.od - 1;
        if (heredoc.jezyk === 'node') wynik.push(...kawalkiKodu(tekst, przesuniecie));
        else if (heredoc.jezyk === 'python') {
          wynik.push(...kawalkiSkryptu(tekst, true).map((k) => ({ linia: k.linia + przesuniecie, tekst: k.tekst })));
        } else {
          heredoc.linie.forEach((l, i) => wynik.push({ linia: heredoc!.od + i, tekst: heredoc!.cytowany ? l : bezRozwiniec(l) }));
        }
        heredoc = oczekujace.shift() ?? null;
        if (heredoc !== null) heredoc = { ...heredoc, od: nr + 1 };
      } else {
        heredoc.linie.push(linia);
      }
      return;
    }
    for (let i = 0; i < linia.length; i += 1) {
      const znak = linia[i]!;
      if (cudzyslow !== null) {
        const c: Napis = cudzyslow;
        if (python && c.znak.length === 3 && znak !== '\\') {
          if (linia.startsWith(c.znak, i)) {
            if (c.docstring === true) cudzyslow = null;
            else zamknijNapis();
            i += 2;
          } else {
            c.tekst += znak;
          }
          continue;
        }
        if (znak === '\\' && (c.rozwijany || c.znak === "$'" || python)) {
          c.tekst += linia.slice(i, i + 2);
          i += 1;
        } else if (znak === c.znak.slice(-1)) {
          zamknijNapis();
        } else {
          c.tekst += znak;
        }
        continue;
      }
      if (znak === '#' && (i === 0 || /[\s;|&(]/u.test(linia[i - 1]!)) && linia[i - 1] !== '$') break;
      if (znak === '\\') {
        i += 1;
        continue;
      }
      if (python && (linia.startsWith('"""', i) || linia.startsWith("'''", i))) {
        // Docstring zaczyna instrukcję: przed nim w linii najwyżej przedrostek `r`, `u` albo `b`.
        const docstring = /^\s*[rRuUbB]?$/u.test(linia.slice(0, i)) && docstringPythona(linie, idx);
        cudzyslow = { znak: linia.slice(i, i + 3), rozwijany: false, tekst: '', linia: nr, docstring };
        i += 2;
        continue;
      }
      if (znak === '$' && linia[i + 1] === "'" && !python) {
        cudzyslow = { znak: "$'", rozwijany: false, tekst: '', linia: nr };
        i += 1;
        continue;
      }
      if (znak === "'" || znak === '"') {
        cudzyslow = { znak, rozwijany: znak === '"' && !python, tekst: '', linia: nr };
        continue;
      }
      // Here-string `<<<słowo` to jeden operator: jego słowo czyta się dalej jak zwykły napis, heredoca nie ma.
      if (!python && linia.startsWith('<<<', i)) {
        i += 2;
        continue;
      }
      const otwarcie = !python && znak === '<' ? /^<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/u.exec(linia.slice(i)) : null;
      if (otwarcie !== null) {
        const jezyk = /\bnode\b|\$\{?NODE\}?|--input-type/u.test(linia) ? 'node'
          : /\bpython3?\b/u.test(linia) ? 'python' : 'tekst';
        oczekujace.push({
          koniec: otwarcie[3]!, myslnik: otwarcie[1] === '-', cytowany: otwarcie[2] !== '', jezyk, od: nr + 1, linie: [],
        });
        i += otwarcie[0].length - 1;
      }
    }
    if (cudzyslow !== null) {
      const c: Napis = cudzyslow;
      c.tekst += '\n';
    }
    if (oczekujace.length > 0) heredoc = oczekujace.shift()!;
  });
  zamknijNapis();
  return wynik;
}

/** Tekst pliku po kawałkach według rodzaju (opis w nagłówku modułu). */
export function kawalki(plik: string, tresc: string): Kawalek[] {
  const r = rodzaj(plik);
  if (r === 'kod') return kawalkiKodu(tresc);
  if (r === 'powloka' || r === 'python') return kawalkiSkryptu(tresc, r === 'python');
  return tresc.split('\n').map((tekst, i) => ({ linia: i + 1, tekst }));
}

/** Polska linia pliku: numer, treść linii źródła (po `trim()`) i polskie słowa albo znaki, które ją wskazały. */
export interface PolskaLinia {
  readonly linia: number;
  readonly zrodlo: string;
  readonly dowod: string;
}

/** Polskie linie pliku po numerze (linia z kilkoma polskimi kawałkami raz). */
export function polskieLinie(plik: string, tresc: string): PolskaLinia[] {
  const kod = rodzaj(plik) !== 'dokument';
  const zrodlo = tresc.split('\n');
  const linie = new Map<number, string>();
  for (const { linia, tekst } of kawalki(plik, tresc)) {
    if (linie.has(linia)) continue;
    const znak = ZNAKI.exec(tekst)?.[0];
    const slowa = polskieSlowa(tekst, kod);
    if (znak !== undefined || slowa.length > 0) linie.set(linia, znak ?? slowa.join(', '));
  }
  return [...linie].sort(([a], [b]) => a - b)
    .map(([linia, dowod]) => ({ linia, zrodlo: (zrodlo[linia - 1] ?? '').trim(), dowod }));
}

/**
 * Grupa pliku w zapadce albo `null` (poza zakresem). `dokument`: każdy plik `.md` widoku eksportu, czyli dokumenty
 * publiczne (inny `.md` w eksporcie zatrzymuje drzewo eksportu). `cli`: komenda `rarog` i moduły serwera, których
 * zdania drukuje, z szablonami plików u użytkownika, oraz start `rarog serve` (`server/src/index.ts`, razem z jego
 * logiem: przy `rarog serve` na pierwszym planie log idzie do terminala). `skrypt`: publiczne skrypty `scripts/`
 * (punkty wejścia, hooki i biblioteki, których komunikaty te punkty drukują), bez deklaracji typów, and the scripts an
 * operator runs for the relays: `relay-vps/` (install, guards, adapter; its tests stay out) and `relay/scripts/`.
 */
export type Grupa = 'dokument' | 'cli' | 'skrypt';

const CLI_KATALOGI = [
  'bin/', 'server/src/bootstrap/', 'server/src/cli/', 'server/src/config/', 'server/src/install/',
] as const;
const CLI_PLIKI = [
  'server/src/auth/admin.ts', 'server/src/config.ts', 'server/src/herdr/hook-commands.ts',
  'server/src/herdr/hook-config.ts', 'server/src/index.ts', 'server/src/iroh/adapter.ts', 'shared/src/data-dir.mjs',
] as const;

const SKRYPTY_KATALOGI = ['scripts/', 'relay-vps/', 'relay/scripts/'] as const;

export function grupa(plik: string): Grupa | null {
  if (plik.endsWith('.md')) return 'dokument';
  if (CLI_KATALOGI.some((k) => plik.startsWith(k)) || (CLI_PLIKI as readonly string[]).includes(plik)) return 'cli';
  if (SKRYPTY_KATALOGI.some((k) => plik.startsWith(k)) && !plik.startsWith('relay-vps/test/')
    && /\.(?:sh|mjs|mts|ts|py)$/u.test(plik) && !/\.d\.m?ts$/u.test(plik)) return 'skrypt';
  return null;
}

/** Pliki CLI wymienione wprost: każdy musi istnieć (lista nie gnije po przeniesieniu pliku). */
export const PLIKI_CLI: readonly string[] = CLI_PLIKI;

/** Wyjątek: cała linia pliku po `trim()`, która zostaje polska, z powodem. */
export interface Wyjatek {
  readonly plik: string;
  readonly linia: string;
  readonly powod: string;
}

export interface Wynik {
  /** Liczba polskich linii per plik (tylko pliki z co najmniej jedną). */
  readonly liczby: Map<string, number>;
  /** Wyjątki, które nie trafiły żadnej polskiej linii. */
  readonly martwe: readonly Wyjatek[];
}

/** Polskie linie plików w zakresie (ścieżka → treść), bez linii z wyjątków. */
export function policz(pliki: ReadonlyMap<string, string>, wyjatki: readonly Wyjatek[]): Wynik {
  const liczby = new Map<string, number>();
  const uzyte = new Set<Wyjatek>();
  for (const [plik, tresc] of [...pliki].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (grupa(plik) === null) continue;
    const wlasne = wyjatki.filter((w) => w.plik === plik);
    let ile = 0;
    for (const linia of polskieLinie(plik, tresc)) {
      const wyjatek = wlasne.find((w) => w.linia === linia.zrodlo);
      if (wyjatek === undefined) ile += 1;
      else uzyte.add(wyjatek);
    }
    if (ile > 0) liczby.set(plik, ile);
  }
  return { liczby, martwe: wyjatki.filter((w) => !uzyte.has(w)) };
}
