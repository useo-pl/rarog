/**
 * Opcje dialogu z ekranu — jedyne źródło CYFR dla karty decyzji (`docs/security-model.md`, „Starting sessions from the phone: three powers”, pkt 13): linia opcji, ramka i marker
 * zaznaczenia, etykieta (kanoniczna, zawinięta, z checkboxem), opis pod etykietą, kompletność listy 1…N.
 *
 * Wzorce wyglądu pochodzą z rejestru sygnatur. Etykieta jedzie na telefon i do audytu DOSŁOWNIE; składanie
 * apostrofów służy wyłącznie dopasowaniu.
 */
import { HORIZONTAL_RULE_PATTERN } from './region.ts';
import { SCREEN_SIGNATURES } from './signatures.ts';

/**
 * Twardy sufit długości etykiety opcji.
 *
 * Etykieta wychodzi z tego modułu dalej niż cokolwiek innego z ekranu: na telefon (przycisk)
 * i do `herdr-audit.log` (`docs/security-model.md`, „Starting sessions from the phone: three powers”, pkt 16 — „co zatwierdzono", nie „jaką cyfrę wysłano"). Realna opcja
 * bywa długa („Yes, and don't ask again for pnpm commands in /Users/u/Projects/atlas"), ale
 * nie ma prawa wciągnąć w siebie połowy ekranu, gdy panel przemaluje się w trakcie odczytu.
 */
export const OPTION_LABEL_MAX_CHARS = 200;

/** Górna/dolna krawędź ramki dialogu (`╭────╮` / `╰────╯`) — dekoracja, nigdy treść. */
export const BOX_EDGE_PATTERN = SCREEN_SIGNATURES.boxEdge.pattern;

/** Pionowe krawędzie ramki dialogu — do zdjęcia przed dopasowaniem opcji. */
const BOX_EDGE_START_PATTERN = SCREEN_SIGNATURES.boxEdgeStart.pattern;
const BOX_EDGE_END_PATTERN = SCREEN_SIGNATURES.boxEdgeEnd.pattern;

/** Lewa krawędź ramki razem z wcięciem przed nią — dla {@link unframe}. */
const BOX_EDGE_START_INDENTED_PATTERN = SCREEN_SIGNATURES.boxEdgeStartIndented.pattern;

/**
 * Marker zaznaczonej pozycji (`❯ 1. Yes`) — nie jest częścią etykiety.
 *
 * `↓`/`↑` to wskaźniki PRZEWINIĘCIA listy, które `AskUserQuestion` rysuje w tej samej kolumnie
 * (zmierzone: opisy trzylinijkowe nie zmieściły się w panelu, ekran pokazał
 * `❯ 1. …`, `↓ 2. …`, `5. Chat about this`). Bez nich linia „↓ 2." nie byłaby w ogóle opcją.
 * Sam marker nie czyni listy kompletną — o tym dalej rozstrzyga `isCompleteOptionSet`.
 */
const SELECTION_MARKER_PATTERN = SCREEN_SIGNATURES.selectionMarker.pattern;

/**
 * Linia opcji: cyfra, kropka, spacja, treść.
 *
 * Wzorzec jest CAŁĄ definicją tego, czym jest opcja. Jeżeli linia nie ma cyfry, opcja nie
 * istnieje — nie dokładamy jej z licznika pętli. To jest dokładnie ta reguła, która oddziela
 * ten moduł od „wybieram trzecią pozycję strzałkami".
 */
export const OPTION_LINE_PATTERN = SCREEN_SIGNATURES.optionLine.pattern;

export interface ScreenOption {
  /** `'1'`…`'9'` — dokładnie ten znak idzie do `agent.send_keys`. */
  digit: string;
  /** Tekst opcji po kanonizacji (`canonicalLabel`) — klucz wyboru i wpis w audycie. */
  label: string;
  /**
   * Opis opcji z WCIĘTEJ linii pod nią (`options[].description` z inputu `AskUserQuestion`).
   *
   * Zmierzone (zrzut z iPada): formularz rysuje opis pod etykietą; bez tego pola ginąłby
   * on w całości — karta na telefonie miałaby same etykiety, choć autor pytania napisał, czym
   * te warianty się różnią. Pole jest OPCJONALNE i nieobecne, gdy opisu nie ma: `''` znaczyłoby
   * „opis pusty", a to nie to samo co „opisu nie było".
   *
   * Prywatność (`docs/security-model.md`, „herdr sessions: Rarog writes to a terminal it does not own”, pkt 11): opis jest tą samą klasą treści co etykieta — pisze go autor pytania
   * DLA człowieka przy telefonie — więc jedzie tą samą drogą i z tym samym sufitem znaków.
   */
  description?: string;
  /**
   * Stan checkboxa z linii opcji (`[✔] Posypka` → `true`, `[ ] Bita śmietana` → `false`).
   *
   * Nieobecne = formularz nie ma checkboxów, czyli jest jednokrotny. Obecność choćby jednego
   * checkboxa jest dziś sygnaturą formularza WIELOKROTNEGO wyboru (patrz `formMultiSelect`):
   * stopki `space to toggle` zmierzony ekran nie ma (`dialog-askuserquestion-multi.txt`).
   *
   * Checkbox NIE jest częścią etykiety: cyfra liczy się po tekście BEZ niego, bo glif
   * zmienia się przy każdym zaznaczeniu — etykieta ze stanem w środku rozjeżdżałaby klucz
   * mapy przy każdym odczycie.
   */
  checked?: boolean;
}

/**
 * Opcja karty budowanej z ekranu — `ScreenOption` plus flaga eskalacji (uniwersalna karta).
 * `terminalOnly` jedzie kontraktem na telefon (UI: opcja widoczna, wyszarzona)
 * i jest bramką w driverze (`answerQuestion` odmawia wysyłki cyfry niezależnie od UI).
 */
export interface ScreenFormOption extends ScreenOption {
  terminalOnly?: boolean;
}

/**
 * Apostrofy typograficzne, których Claude Code używa w etykietach opcji.
 *
 * MEASURED LIVE on CLI 2.1.246: the consent dialog draws "Yes, and don’t ask again for: cd *"
 * with U+2019, NOT with `'`. An escalation pattern written with a straight apostrophe
 * (`don'?t ask again`) would miss the option that widens permissions in both places: in
 * `optionEscalates` (the option would reach the phone WITHOUT `terminalOnly`, with a live button —
 * a hole in the escalation gate, `docs/dialogs.md`, "Rules: what must not be relaxed") and in the
 * `affirmativeOption` filter in the driver, which would then see TWO "Yes…" options and, failing
 * closed, take approval away from the WHOLE card.
 *
 * So apostrophes are folded ONLY for matching. The label goes to the phone and to the audit
 * VERBATIM — the chosen option comes back from the phone with the same text, so replacing a
 * character in the label itself would break the map key.
 */
const APOSTROPHE_PATTERN = SCREEN_SIGNATURES.apostrophes.pattern;

/** Tekst z apostrofami typograficznymi złożonymi do `'` — WYŁĄCZNIE do dopasowań wzorców. */
export function foldApostrophes(text: string): string {
  return text.replace(APOSTROPHE_PATTERN, "'");
}

/**
 * Kanoniczna postać etykiety: bez brzegowych spacji, z ciągami białych znaków zwiniętymi do
 * jednej spacji, przycięta do `OPTION_LABEL_MAX_CHARS`.
 *
 * Eksportowane, bo etykieta wraca z telefonu przy `allow` i musi trafić w ten sam klucz mapy.
 * Terminal dokłada spacje wyrównujące ramkę, a UI potrafi je znormalizować po swojemu — bez
 * wspólnej postaci kanonicznej wybór „po tekście" gubiłby się na jednej spacji.
 *
 * Funkcja jest idempotentna: spację, którą cięcie zostawi na końcu, zdejmujemy po cięciu. Klucz
 * liczy się raz z pełnej etykiety, raz z etykiety już kanonicznej (opcja z ekranu na karcie),
 * a spacja na końcu dawałaby przy drugim liczeniu klucz o znak krótszy.
 */
export function canonicalLabel(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, OPTION_LABEL_MAX_CHARS).trimEnd();
}

/**
 * Linia bez krawędzi ramki, ale Z WCIĘCIEM — dla {@link descriptionAfter}.
 *
 * `unbox` zaczyna od `.trim()`, więc do reszty modułu nie dociera ani jeden znak wcięcia —
 * a wcięcie jest jedyną rzeczą, która odróżnia OPIS opcji od dowolnej linii stojącej pod
 * listą. Zdejmujemy wyłącznie chrome ramki: lewą krawędź razem z wcięciem
 * PRZED nią (wcięcie ramki nie jest wcięciem treści) i krawędź prawą.
 */
export function unframe(line: string): string {
  return line
    .replace(/[ \t]+$/, '')
    .replace(BOX_EDGE_START_INDENTED_PATTERN, '')
    .replace(BOX_EDGE_END_PATTERN, '');
}

/** Linia bez krawędzi ramki i bez markera zaznaczenia. */
export function unbox(line: string): string {
  return line
    .trim()
    .replace(BOX_EDGE_START_PATTERN, '')
    .replace(BOX_EDGE_END_PATTERN, '')
    .trim()
    .replace(SELECTION_MARKER_PATTERN, '')
    .trim();
}

/**
 * Czy te cyfry to KOMPLETNA lista opcji dialogu, czyli dokładnie 1…N?
 *
 * To jest jedyny sprawdzian, który odróżnia „widzę cały dialog" od „widzę jego kawałek" —
 * a różnica jest tu wszystkim: przy niepełnej liście cyfra z telefonu trafiłaby w opcję,
 * której użytkownik nie widział. CLI numeruje opcje od 1 i bez dziur, więc brak jedynki albo
 * luka w środku znaczy, że czegoś nie widzimy (ekran przewinięty, render w połowie).
 *
 * Kolejność NIE ma znaczenia: przetasowana numeracja (3/1/2) jest poprawnym dialogiem,
 * bo cyfrę bierzemy z tekstu, nigdy z pozycji w tablicy.
 */
export function isCompleteOptionSet(options: readonly ScreenOption[]): boolean {
  if (options.length === 0) return false;
  const digits = new Set(options.map((option) => option.digit));
  if (digits.size !== options.length) return false;
  for (let n = 1; n <= options.length; n += 1) {
    if (!digits.has(String(n))) return false;
  }
  return true;
}

/**
 * Czy opcje stoją na SAMYM DOLE regionu — pod ostatnią opcją wyłącznie puste linie i stopka klawiszowa
 * CLI (`FORM_CHROME_PATTERN`)? Tekst pod listą znaczy, że cyfry pochodzą ze scrollbacku, a prawdziwy
 * dialog (może nieczytelny) stoi niżej — warunek {@link confirmFrom} i znanego dialogu.
 */
export function optionsCloseRegion(region: readonly string[]): boolean {
  let lastOption = -1;
  for (let i = 0; i < region.length; i += 1) {
    if (OPTION_LINE_PATTERN.test(region[i] ?? '')) lastOption = i;
  }
  if (lastOption === -1) return false;
  return region.slice(lastOption + 1).every((line) => {
    const below = line.trim();
    return below === '' || FORM_CHROME_PATTERN.test(below);
  });
}

/**
 * Linia opcji z podświetleniem: DOKŁADNIE `❯`, potem cyfra z kropką.
 *
 * Celowo węższy niż {@link SELECTION_MARKER_PATTERN}: tamten czyści KOSMETYKĘ etykiet
 * (`unbox`), a ten jest dowodem w weryfikacji przed `enter` — i nie ma prawa trafić
 * w composer (`❯` bez cyfry) ani w listy ze scrollbacku (cyfra bez `❯`).
 */
const SELECTED_OPTION_PATTERN = SCREEN_SIGNATURES.selectedOption.pattern;

/**
 * Checkbox na POCZĄTKU etykiety opcji — sygnatura formularza wielokrotnego wyboru.
 *
 * Zaznaczony checkbox na żywym ekranie: `1. [✔] Posypka` (fixture
 * `dialog-askuserquestion-multi-live-submit.txt`). `x`, `X` i `✓` parser przyjmuje na zapas,
 * bez pomiaru. Checkbox jest CHROME'em listy, nie treścią opcji — patrz
 * {@link ScreenOption.checked}.
 *
 * Druga postać — GOŁY glif `☐☑☒`, bez nawiasów: to dokładnie te znaki,
 * którymi ten sam render rysuje zakładki ({@link QUESTION_HEADER_PATTERN}), więc checkbox
 * w tej postaci jest w pełni realny. Rozjazd byłby tu fail-OPEN (formularz wielokrotny bez
 * rozpoznanego checkboxa wraca do karty z przyciskami), a na to `docs/security-model.md`, „Starting sessions from the phone: three powers”, pkt 14 nie pozwala.
 */
const OPTION_CHECKBOX_PATTERN = SCREEN_SIGNATURES.optionCheckbox.pattern;

/** Pusty checkbox — opcja NIE zaznaczona (pozostałe glify i `[x]` znaczą „zaznaczona”). */
const UNCHECKED_GLYPH = SCREEN_SIGNATURES.uncheckedGlyph.pattern;

/** Etykieta opcji z surowego ogona linii — cięcie na glifie ramki podglądu i checkbox osobno. */
function optionLabelFrom(rawLabel: string): { label: string; checked?: boolean } {
  const boxAt = rawLabel.search(OPTION_BOX_GLYPH_PATTERN);
  const cut = boxAt === -1 ? rawLabel : rawLabel.slice(0, boxAt);
  const box = OPTION_CHECKBOX_PATTERN.exec(cut.trim());
  if (box === null) return { label: canonicalLabel(cut) };
  const mark = box[1] ?? box[2] ?? ' ';
  return { label: canonicalLabel(box[3] ?? ''), checked: mark.trim() !== '' && mark !== UNCHECKED_GLYPH };
}

/**
 * Ile WCIĘTYCH linii pod opcją czytamy jako jej opis.
 *
 * Cztery, nie jedna: panel zawija długi opis (`dialog-askuserquestion-scrollback.txt` niesie
 * opisy trzylinijkowe), a sufit chroni przed wciągnięciem połowy ekranu, gdyby dialog
 * przemalował się w trakcie odczytu. Sam TEKST przycina `canonicalLabel` — opis wychodzi
 * z tego modułu tą samą drogą i z tym samym sufitem co etykieta.
 */
const OPTION_DESCRIPTION_MAX_LINES = 4;

/**
 * Linie CHROME'u formularza — nigdy nie są opisem opcji.
 *
 * `Submit` jest tu z pomiaru: formularz wielokrotnego wyboru rysuje pod ostatnią pozycją własny
 * przycisk „Submit", stojący dokładnie tam, gdzie stoją opisy (fixture `measured/multiselect-2.1.293.txt`).
 * Reszta wzorca to stopki nawigacji CLI — bez nich formularz, którego stopka nie jest oddzielona pustą
 * linią, dopisywałby „Enter to select · ↑/↓ to navigate" jako opis ostatniej opcji.
 *
 * `shift+tab` (dialog `ExitPlanMode`): pod ostatnią opcją stoi
 * podpowiedź klawiszowa „shift+tab to approve with this feedback", wcięta dokładnie jak opis.
 * Skrót klawiszowy nigdy nie jest zdaniem autora pytania — łapiemy sam kształt `shift+tab`,
 * a nie „to approve", bo TO ostatnie potrafi być treścią prawdziwego opisu.
 *
 * `^next$`: w formularzu WIELOPYTANIOWYM ta sama pozycja pod
 * ostatnią opcją brzmi „Next", nie „Submit" — bez tego członu jechałaby na kartę jako opis opcji
 * „Type something".
 */
const FORM_CHROME_PATTERN = SCREEN_SIGNATURES.formChrome.pattern;

/** Numer opcji z kropką w dowolnym miejscu linii — kolumna, od której mierzy się wcięcie. */
const OPTION_NUMBER_PATTERN = SCREEN_SIGNATURES.optionNumber.pattern;

/** Kolumna, w której zaczyna się treść linii; `-1` dla linii pustej. */
function indentOf(line: string): number {
  return line.search(/\S/);
}

/**
 * Opis opcji: WCIĘTE linie bezpośrednio pod jej linią, bez cyfry.
 *
 * Wcięcie jest warunkiem TWARDYM i mierzy się na liniach `unframe` (z zachowanym wcięciem —
 * `unbox`, na którym stoi reszta parsera, zaczyna od `.trim()`): opis musi zaczynać się nie
 * bliżej niż w kolumnie CYFRY swojej opcji (żywy render stawia go dokładnie tam). Bez tego opisem stawałaby
 * się każda linia pod listą, której nie łapie `FORM_CHROME_PATTERN` — czyli dowolna nowa stopka CLI jechałaby
 * na kartę jako zdanie, którego autor pytania nie napisał.
 *
 * Bieg opisu kończy poza wcięciem KAŻDA linia, która opisem być nie może: pusta, następna
 * opcja, kreska, krawędź ramki, linia z glifem ramki oraz chrome formularza. Fail-closed jest
 * tu „brak opisu", nie „opis z czegokolwiek".
 *
 * Wariantu z kolumną `preview` ta funkcja nie dotyka w ogóle (patrz `optionsIn`): tam pod
 * opcjami stoi treść ramki podglądu, a `unbox` zdejmuje jej pionowe krawędzie tak samo jak
 * krawędzie dialogu — linia „│ /api/sessions/42 │" wygląda po nim jak zwyczajny opis.
 *
 * @param region linie regionu po `unbox` (rozpoznanie kształtu)
 * @param raw te same linie po `unframe` (pomiar wcięcia) — indeksy MUSZĄ się pokrywać
 */
function descriptionAfter(
  region: readonly string[],
  raw: readonly string[],
  optionIndex: number,
  startAt: number = optionIndex + 1,
): string | undefined {
  // Kolumna cyfry, nie pierwszego znaku: marker `❯` stoi PRZED nią i przesuwa wcięcie
  // wyłącznie podświetlonej opcji, więc mierzone od początku linii opisy pod `❯` i pod
  // resztą listy miałyby różny próg.
  const optionIndent = (raw[optionIndex] ?? '').search(OPTION_NUMBER_PATTERN);
  if (optionIndent === -1) return undefined;
  const lines: string[] = [];
  for (let i = startAt; i < region.length; i += 1) {
    if (lines.length >= OPTION_DESCRIPTION_MAX_LINES) break;
    if (!continuesDescription(region, raw, i, optionIndent)) break;
    lines.push(region[i] ?? '');
  }
  if (lines.length === 0) return undefined;
  const text = canonicalLabel(lines.join(' '));
  return text === '' ? undefined : text;
}

/**
 * Whether line `i` can carry on the description of an option whose digit stands in column `optionIndent`: the one
 * rule of {@link descriptionAfter} and {@link inOptionDescription}.
 */
function continuesDescription(
  region: readonly string[], raw: readonly string[], i: number, optionIndent: number,
): boolean {
  const line = region[i] ?? '';
  if (line === '') return false;
  // `<`, not `<=`: the live render (fixture `-multi-live-start`) puts the description EXACTLY in the
  // digit column (`  1. [ ] Posypka` / `  Kolorowa`), so a "deeper than the digit" threshold would
  // lose every real description.
  if (indentOf(raw[i] ?? '') < optionIndent) return false;
  return !OPTION_LINE_PATTERN.test(line)
    && !HORIZONTAL_RULE_PATTERN.test(line)
    && !BOX_EDGE_PATTERN.test(line)
    && !OPTION_BOX_GLYPH_PATTERN.test(line)
    && !FORM_CHROME_PATTERN.test(line);
}

/**
 * Whether line `index` belongs to the description of an option line above it, by the rule of {@link descriptionAfter}
 * (every line from the option down to `index` carries the description on), without its line cap: the cap limits what
 * goes on the card, not where the option ends.
 *
 * @param region region lines after `unbox`
 * @param raw the same lines after `unframe` (indentation kept); indices match `region`
 */
export function inOptionDescription(region: readonly string[], raw: readonly string[], index: number): boolean {
  for (let j = index - 1; j >= 0; j -= 1) {
    if (!OPTION_LINE_PATTERN.test(region[j] ?? '')) continue;
    const optionIndent = (raw[j] ?? '').search(OPTION_NUMBER_PATTERN);
    if (optionIndent === -1) return false;
    for (let i = j + 1; i <= index; i += 1) {
      if (!continuesDescription(region, raw, i, optionIndent)) return false;
    }
    return true;
  }
  return false;
}

/**
 * Wzorzec odtworzenia zawiniętej etykiety pytania: etykieta z payloadu albo z karty,
 * opcjonalnie z jej opisem. Sam napis = etykieta bez opisu.
 */
export type LabelGuide = string | { readonly label: string; readonly description?: string | undefined };

/** Wzorce → mapa „etykieta kanoniczna → opis kanoniczny" (pierwszy opis wygrywa). */
export function guideMap(guides: readonly LabelGuide[]): Map<string, string | undefined> {
  const map = new Map<string, string | undefined>();
  for (const guide of guides) {
    const label = canonicalLabel(typeof guide === 'string' ? guide : guide.label);
    const raw = typeof guide === 'string' ? undefined : guide.description;
    const description = raw === undefined ? undefined : canonicalLabel(raw);
    if (!map.has(label) || map.get(label) === undefined) map.set(label, description);
  }
  return map;
}

/** Ile linii pod opcją wolno dokleić do jej ZAWINIĘTEJ etykiety. */
const LABEL_CONTINUATION_MAX_LINES = 4;

/**
 * Linia podpowiedzi klawiszowej pod opcją — nigdy dalszy ciąg etykiety.
 *
 * Węższy niż {@link FORM_CHROME_PATTERN}: tamten łapie `shift+tab` i „to cancel" W ŚRODKU
 * linii, a zawinięta etykieta zgody `Edit` (zmierzone na CLI 2.1.293, panel 63
 * kolumny) kończy się dokładnie tak: „…accept edits (auto-approve file edits" / „and common
 * file commands) for this session (shift+tab)". Podpowiedź zaczyna się od klawisza
 * („shift+tab to approve with this feedback" pod opcją planu) — i tylko to tu łapiemy.
 */
const KEY_HINT_LINE_PATTERN = SCREEN_SIGNATURES.keyHintLine.pattern;

/**
 * Linie pod linią opcji, które MOGĄ być dalszym ciągiem jej zawiniętej etykiety.
 *
 * Kandydat to linia wcięta GŁĘBIEJ niż cyfra opcji, przed następną opcją, pustą linią, kreską
 * albo krawędzią ramki. To KANDYDACI, nie wynik: o tym, czy linia jest etykietą, opisem czy
 * treścią obok, rozstrzyga wołający.
 *
 * Przy podglądzie (`preview`) liczy się wyłącznie lewa kolumna — tekst ORYGINALNEJ linii przed
 * pierwszym glifem ramki (zmierzone: „❯ 1. Dwie kolumny obok siebie" / „z podgladem"
 * / „(Rekomendowane)" obok ramki). Oryginalnej, nie po `unbox`/`unframe`: te zdejmują lewą
 * krawędź jak krawędź DIALOGU, więc linia samej ramki podglądu (`      │ wynik = │`, zrzut
 * `dialog-askuserquestion-notes.txt`) udawałaby tekst lewej kolumny.
 */
function continuationLines(
  region: readonly string[],
  raw: readonly string[],
  original: readonly string[],
  optionIndex: number,
  preview: boolean,
): string[] {
  const digitAt = (raw[optionIndex] ?? '').search(OPTION_NUMBER_PATTERN);
  const digitAtOriginal = (original[optionIndex] ?? '').search(OPTION_NUMBER_PATTERN);
  if (digitAt === -1 || digitAtOriginal === -1) return [];
  const lines: string[] = [];
  for (let i = optionIndex + 1; i < region.length; i += 1) {
    if (lines.length >= LABEL_CONTINUATION_MAX_LINES) break;
    const line = region[i] ?? '';
    if (line === '') break;
    if (OPTION_LINE_PATTERN.test(line)) break;
    if (HORIZONTAL_RULE_PATTERN.test(line)) break;
    if (BOX_EDGE_PATTERN.test(line)) break;
    let text: string;
    if (preview) {
      const whole = original[i] ?? '';
      const boxAt = whole.search(OPTION_BOX_GLYPH_PATTERN);
      const left = boxAt === -1 ? whole : whole.slice(0, boxAt);
      if (left.trim() === '' || indentOf(left) <= digitAtOriginal) break;
      text = left.trim();
    } else {
      if (indentOf(raw[i] ?? '') <= digitAt) break;
      const boxAt = line.search(OPTION_BOX_GLYPH_PATTERN);
      text = (boxAt === -1 ? line : line.slice(0, boxAt)).trim();
      if (text === '') break;
    }
    lines.push(text);
  }
  return lines;
}

/**
 * Zawinięta etykieta PYTANIA odtworzona etykietami z payloadu.
 *
 * W pytaniu opis opcji stoi w tej samej kolumnie co dalszy ciąg zawiniętej etykiety (zmierzone
 * na CLI 2.1.293), więc sam ekran nie rozstrzyga, czym jest linia pod opcją.
 * Rozstrzyga payload (hook albo jsonl po cross-checku): doklejamy kolejne linie i przyjmujemy
 * NAJDŁUŻSZE sklejenie, które jest DOKŁADNIE jedną z etykiet payloadu. Żadnego dopasowania
 * prefiksem — nieodczytana końcówka mogłaby różnić dwie decyzje („Staging (tylko odczyt)"
 * i „Staging (zapis…)"). Brak pełnej równości = etykieta z linii
 * cyfry (fail-closed: dopasowanie hooka do ekranu nie przejdzie).
 *
 * @returns etykieta i liczba doklejonych linii (opis opcji zaczyna się ZA nimi)
 */
function guidedLabel(
  base: string, continuation: readonly string[], guide: ReadonlyMap<string, string | undefined>,
): { label: string; consumed: number } {
  /*
   * Sklejenie (≥ 1 doklejona linia) przyjmujemy tylko wtedy, gdy RESZTA linii pod opcją jest
   * opisem tej opcji z payloadu (albo jej nie ma). Bez tego „Staging (tylko odczyt)" + nowa linia
   * „i zapis" przechodziłoby jako stara etykieta z opisem „i zapis" — świeży odczyt przed cyfrą
   * przyjmowałby zmienioną opcję (odtworzone na atrapie herdr). Etykieta
   * z SAMEJ linii cyfry (`consumed === 0`) zostaje przy prostej regule — opisu nie sprawdzamy,
   * bo CLI potrafi go renderować inaczej niż payload (markdown), a to nie jest nowa akceptacja.
   */
  const fits = (label: string, consumed: number): boolean => {
    if (!guide.has(label)) return false;
    if (consumed === 0) return true;
    const rest = canonicalLabel(continuation.slice(consumed).join(' '));
    if (rest === '') return true;
    const description = guide.get(label);
    if (description === undefined || description === '') return false;
    return rest === description
      || description.startsWith(`${rest} `)
      // Opis przycięty sufitem znaków — reszta ekranu może być od niego dłuższa.
      || (description.length >= OPTION_LABEL_MAX_CHARS && rest.startsWith(description));
  };
  let best = fits(base, 0) ? { label: base, consumed: 0 } : null;
  let text = base;
  for (let k = 0; k < continuation.length; k += 1) {
    text = canonicalLabel(`${text} ${continuation[k] ?? ''}`);
    if (fits(text, k + 1)) best = { label: text, consumed: k + 1 };
  }
  return best ?? { label: base, consumed: 0 };
}

/**
 * Zawinięta etykieta tam, gdzie pod opcją NIE MA opisów.
 *
 * Dotyczy zgody, potwierdzenia i lewej kolumny formularza z podglądem: każda linia kontynuacji
 * jest dalszym ciągiem etykiety — wyjątkiem są podpowiedzi klawiszowe
 * ({@link KEY_HINT_LINE_PATTERN}). Bez tego karta pokazywała przycisk „Yes, and always allow
 * access to" BEZ katalogu, którego zgoda dotyczy (zrzut `measured/zgoda-bash-2.1.293.txt`),
 * a w formularzu z podglądem zostawała nieodczytana końcówka etykiety. Przy podglądzie
 * sklejamy WSZYSTKO, co stoi w lewej kolumnie, zamiast zatrzymać się na pierwszej etykiecie
 * z payloadu: „Staging" + „(tylko odczyt)" to na ekranie JEDNA opcja i nie wolno jej uznać za
 * opcję „Staging" — równość z payloadem sprawdza dopasowanie hooka.
 */
function wrappedLabel(base: string, continuation: readonly string[]): string {
  const tail: string[] = [];
  for (const line of continuation) {
    if (KEY_HINT_LINE_PATTERN.test(line)) break;
    tail.push(line);
  }
  return tail.length === 0 ? base : canonicalLabel([base, ...tail].join(' '));
}

/**
 * Podświetlona opcja z etykietą odtworzoną tak samo jak lista.
 *
 * `selectedOptionIn` czyta wyłącznie linię z markerem `❯`, więc zawiniętej etykiecie dawał
 * jej PIERWSZĄ linię — a weryfikacja przed `enter` porównuje ją z etykietą karty, która
 * po odtworzeniu jest pełna. Bez tej zamiany cyfra szła, a `enter` padał na `wrong-option`.
 * Etykietę bierzemy z listy po CYFRZE i tylko wtedy, gdy pierwsza linia jest jej początkiem —
 * inaczej zostaje odczyt surowy (porównanie z kartą i tak go odrzuci).
 */
export function selectedWithLabel(
  selected: ScreenOption | null, options: readonly ScreenOption[],
): ScreenOption | null {
  if (selected === null) return null;
  const listed = options.find((option) => option.digit === selected.digit);
  if (listed === undefined || listed.label === selected.label) return selected;
  return listed.label.startsWith(`${selected.label} `) ? { ...selected, label: listed.label } : selected;
}

/**
 * Opcja podświetlona `❯` — z linii SUROWYCH (przed `unbox`, który marker zdejmuje).
 *
 * Fail-closed w obie strony: zero markerów i więcej niż jeden marker dają `null` — „nie wiem,
 * co jest podświetlone" nigdy nie może stać się „na pewno to, co chcę".
 */
export function selectedOptionIn(rawLines: readonly string[]): ScreenOption | null {
  let found: ScreenOption | null = null;
  for (const raw of rawLines) {
    // Jak `unbox`, ale BEZ zdjęcia markera wyboru — marker jest tu całym dowodem.
    const bare = raw
      .trim()
      .replace(BOX_EDGE_START_PATTERN, '')
      .replace(BOX_EDGE_END_PATTERN, '')
      .trim();
    const match = SELECTED_OPTION_PATTERN.exec(bare);
    if (match === null) continue;
    if (found !== null) return null;
    found = { digit: match[1] ?? '', ...optionLabelFrom(match[2] ?? '') };
  }
  return found;
}

/**
 * Znak ramki W ŚRODKU linii opcji — granica etykiety w układzie side-by-side.
 *
 * Formularz `AskUserQuestion` z polem `preview` (CLI 2.1.246)
 * rysuje ramkę podglądu OBOK listy opcji, więc jedna linia ekranu niesie
 * `2. Zagnieżdżony po projekcie    │ /api/sessions │` — a etykieta czytana do końca linii
 * sklejałaby opcję z treścią podglądu. Podgląd ZMIENIA SIĘ z ruchem podświetlenia, więc taka
 * etykieta byłaby inna przy każdym odczycie: karta na telefonie niosłaby śmieć, a `answerQuestion`
 * i `#digitStillHolds` nie umiałyby jej odnaleźć na żywym ekranie („Nie wiem, która opcja…").
 * Fixture: `dialog-askuserquestion-preview.txt` (zrzut żywego panelu).
 */
export const OPTION_BOX_GLYPH_PATTERN = SCREEN_SIGNATURES.optionBoxGlyph.pattern;

/**
 * Opcje z jednego regionu; `null`, gdy region jest wewnętrznie sprzeczny.
 *
 * `preview` (wariant z ramką podglądu obok listy) WYŁĄCZA czytanie opisów: CLI rysuje albo
 * opis pod etykietą, albo podgląd obok niej — nigdy oba naraz (fixture'y
 * `dialog-askuserquestion-preview.txt`, `…-notes.txt` i `measured/pytanie-preview-2.1.293.txt`), a treść
 * podglądu zmienia się z ruchem podświetlenia, więc wzięta za opis byłaby inna przy każdym odczycie.
 *
 * Etykieta zawinięta przez panel wraca w całości na dwa sposoby: w ZGODZIE,
 * potwierdzeniu (`wrap`) i lewej kolumnie podglądu (`preview`) każda linia kontynuacji jest jej
 * częścią, w PYTANIU bez podglądu — tylko gdy sklejenie jest dokładnie etykietą z payloadu
 * (`labels`). Bez payloadu takie pytanie czyta, jak dotąd, etykietę z linii cyfry.
 */
interface OptionReading {
  /** Wariant z podglądem — bez opisów pod etykietą. */
  readonly preview: boolean;
  /** Zgoda albo potwierdzenie: linie kontynuacji to dalszy ciąg etykiety, opisów nie ma. */
  readonly wrap: boolean;
  /** Etykiety z payloadu → ich opisy (kanonicznie) — prowadzą odtworzenie zawiniętej etykiety pytania. */
  readonly labels?: ReadonlyMap<string, string | undefined> | undefined;
}

export function optionsIn(
  region: readonly string[],
  raw: readonly string[],
  original: readonly string[],
  reading: OptionReading,
): ScreenOption[] | null {
  const options: ScreenOption[] = [];
  const seenDigits = new Set<string>();
  const seenLabels = new Set<string>();
  for (let i = 0; i < region.length; i += 1) {
    const match = OPTION_LINE_PATTERN.exec(region[i] ?? '');
    if (match === null) continue;
    const digit = match[1] ?? '';
    const first = optionLabelFrom(match[2] ?? '');
    const { checked } = first;
    let label = first.label;
    let descriptionFrom = i + 1;
    if (reading.wrap || reading.preview) {
      label = wrappedLabel(label, continuationLines(region, raw, original, i, reading.preview));
    } else if (reading.labels !== undefined) {
      const continuation = continuationLines(region, raw, original, i, false);
      const guided = guidedLabel(label, continuation, reading.labels);
      label = guided.label;
      descriptionFrom = i + 1 + guided.consumed;
    }
    // CLI numeruje opcje od 1. `0.` to znak, że trafiliśmy w listę, która opcjami nie jest.
    if (digit === '0' || label === '') return null;
    /*
     * Etykieta liczy się BEZ checkboxa, więc dwie pozycje różniące się wyłącznie
     * zaznaczeniem (`[✔] Foo` i `[ ] Foo`) są tu duplikatem — i słusznie: wybór „po tekście"
     * przestaje być wtedy jednoznaczny, a fail-closed jest jedyną uczciwą odpowiedzią.
     */
    if (seenDigits.has(digit) || seenLabels.has(label)) return null;
    seenDigits.add(digit);
    seenLabels.add(label);
    const description = reading.preview || reading.wrap
      ? undefined
      : descriptionAfter(region, raw, i, descriptionFrom);
    options.push({
      digit,
      label,
      ...(checked === undefined ? {} : { checked }),
      ...(description === undefined ? {} : { description }),
    });
  }
  return options;
}
