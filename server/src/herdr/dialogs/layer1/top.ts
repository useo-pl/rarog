/**
 * Dopasowanie zrzutu hooka do wierzchu ekranu (warstwa 1): jedyny człon dowodu „dialog stoi”,
 * który niesie tożsamość prośby. Kanał zgód daje przycisk zgody wyłącznie prośbie, która jako jedyna z pełnej puli
 * sesji pasuje do świeżo przeczytanego wierzchu (`consentTopWinner` w `proof.ts`), więc każde skurczenie puli może dać
 * dowód co najwyżej kandydatowi o tożsamości równej wierzchowi.
 *
 * {@link matchTop} to jedna funkcja warstwy 1 złożona z funkcji warstwy 2 bez zmiany ich zachowania: cała ramka
 * `Bash` spod tytułu z listy (`wholeBashFrame` z `decide/sources.ts`) albo z wierzchu kolejki z licznikiem, z linią
 * `Ask rule` i bez niej, obie drogi przez {@link bashTop} i `commandMatches`, nazwa pliku
 * planu ze stopki (`parseOptions`), ramka `Edit` (`editOperation` z `cross-check.ts`) przy `single` z pytaniem
 * `Edit` o plik z nagłówka (`screen/edit-zone.ts`) i `editMatchesOperation`. Ogólne `hookMatchesScreen` nie
 * wystarcza: przepuszcza wejście bez fragmentu. Reguły po kolei:
 *
 * - wierzch bez pełnej tożsamości (inny niż cała ramka `Bash` spod tytułu z listy albo z licznikiem kolejki, dialog
 *   planu z nazwą pliku w stopce, `Edit` przy `single`): `unknown` dla każdego zrzutu, więc żadnego dowodu;
 * - tożsamość z pary tytułu i ramki w treści nie wystarcza: wierzch `Bash` i `Edit` wymaga ogona
 *   prawdziwego dialogu pod ramką z zamkniętej listy (strefa pytania `Bash`, pytanie `Edit` o plik z nagłówka)
 *   i dołu odczytu, który kończy się stopką dialogu zgody (`screen/dialog-bottom.ts`); dialog planu bierze nazwę
 *   wyłącznie ze stopki, która jest ostatnią grupą linii odczytu;
 * - zrzut innego narzędzia niż wierzch: `no`;
 * - zrzut przycięty (skrót wejścia niezgodny z wejściem) i znacznik prośby bez skrótu (`inputSha256: null`): `unknown`;
 * - `Bash`: `commandMatches` na całej ramce daje `match`, inaczej `no`; dwie komendy, które zawinięta ramka pokazuje
 *   tak samo (spacja i nowa linia na granicy zawinięcia), obie dają `match`;
 * - `ExitPlanMode`: nazwa pliku planu w stopce równa nazwie z `planFilePath` daje `match` (każda wersja planu tej
 *   nazwy), inna nazwa `no`, brak `planFilePath` `unknown`;
 * - `Edit` at `single`: `editMatchesOperation` (the path against the call's `cwd`) gives `match`, a proven path
 *   contradiction (`editContradictsOperation`: the header cannot point to `file_path` from any directory) `no`, and
 *   every other case `unknown`. An unexplained diff proves no other call: a real dialog with a wrapped line the frame
 *   does not prove (outside the measured geometry or with a character off the closed list, `frameFileLines` in
 *   `screen/edit-frame.ts`) or with a tab shows a diff that `editMatchesOperation` does not explain. A wrapped line
 *   the frame does prove counts like any other line, so such a dialog gives `match`.
 *
 * Czysta funkcja nad jawnymi wejściami (ekran podaje obserwacja, `observe.ts`); jedyny stan to pamięć ostatniego
 * odczytanego wierzchu i skrótów wejścia zrzutów, bez wpływu na wynik. {@link topFieldsOf} mówi, które pola zrzutu
 * dopasowanie czyta (pamięć puli sesji w `cycle.ts`). {@link topScreen} oddaje ten sam wierzch linii logu kanału zgód:
 * rodzaj tożsamości albo powód jej braku ({@link TopScreenMiss}), bez treści ekranu.
 */
import { EXIT_PLAN_MODE_TOOL } from '@rarog/shared';
import { asRecord } from '../../../drivers/tool-text.ts';
import { EDIT_TOOL, editOperation } from '../cross-check.ts';
import { wholeBashFrame } from '../decide/sources.ts';
import { canonicalSha256 } from '../hook/canon.ts';
import type { HookCallDump } from '../hook/contract.ts';
import { bashZoneMiss } from '../screen/bash-zone.ts';
import type { BashZoneUnlistedLine } from '../screen/bash-zone.ts';
import { titlePair } from '../screen/block.ts';
import { dialogBottomAnchored } from '../screen/dialog-bottom.ts';
import { editContradictsOperation, editMatchesOperation, editShownName } from '../screen/edit-frame.ts';
import { editZoneListed } from '../screen/edit-zone.ts';
import { BASH_TOOL, bashCommand, commandMatches, operationAbove } from '../screen/operation.ts';
import type { ScreenOperation } from '../screen/operation.ts';
import { optionRegion, parseOptions } from '../screen/parse.ts';
import type { OptionRegion, ScreenDialog } from '../screen/parse.ts';
import { queueOnScreen, queuedTitleToolOnScreen } from '../screen/queue.ts';
import { HORIZONTAL_RULE_PATTERN } from '../screen/region.ts';
import { trimmedLines } from '../screen/text.ts';

/** Wynik dopasowania zrzutu do wierzchu: ta prośba, na pewno inna, nie wiadomo. */
export type TopMatch = 'match' | 'no' | 'unknown';

/**
 * Pola zrzutu, które czyta dopasowanie do wierzchu. `inputSha256: null` ma tylko kandydat ze znacznika prośby, którego
 * hook nie policzył skrótu (`HookMarkerFile`).
 */
export type TopDump = Pick<HookCallDump, 'toolName' | 'toolInput' | 'cwd'> & { readonly inputSha256: string | null };

/** Dopasowanie zrzutu do wierzchu ekranu; szew obserwacji (`ConsentSessionSources.matchTop`). */
export type MatchTop = (screenText: string, dump: TopDump) => TopMatch;

/** Odczyt ekranu obserwacji: tekst i chwila ROZPOCZĘCIA odczytu (ms epoki, przed zapytaniem herdr). */
export interface ConsentScreenRead {
  readonly text: string;
  readonly readStartedAt: number;
}

/**
 * Dlaczego wierzch ekranu nie ma pełnej tożsamości (diagnostyka linii logu kanału zgód, bez treści ekranu):
 *
 * - `no-options`: odczyt bez regionu opcji dialogu;
 * - `bottom`: dialog `Bash` albo `Edit`, a dół odczytu nie kończy się stopką dialogu zgody;
 * - `title-pair`: nad opcjami nie jedna para kreski i tytułu, para innego rodzaju niż droga `Bash` albo tytuł
 *   z licznikiem, który nie mówi `Bash`;
 * - `frame`: ramka operacji niepełna, bez nagłówka, poza blokiem pary albo druga ramka w bloku;
 * - `bash-question`: ostatnia linia strefy `Bash` to nie samo pytanie „Do you want to proceed?”;
 * - `bash-zone`: linie strefy `Bash` spoza zamkniętej listy (liczby i pasek, `screen/bash-zone.ts`);
 * - `edit-queue`: dialog `Edit` z licznikiem kolejki;
 * - `edit-zone`: strefa `Edit` inna niż pytanie o plik z nagłówka;
 * - `other-dialog`: dialog bez tożsamości kanału (inne narzędzie, plan bez nazwy pliku, dialog bez narzędzia).
 */
export type TopScreenMiss =
  | {
    readonly kind: 'no-options' | 'bottom' | 'title-pair' | 'frame' | 'bash-question' | 'edit-queue' | 'edit-zone'
      | 'other-dialog';
  }
  | { readonly kind: 'bash-zone'; readonly lines: readonly BashZoneUnlistedLine[] };

/** Wierzch ekranu do diagnostyki ({@link topScreen}): rodzaj pełnej tożsamości albo powód jej braku. */
export type TopScreen =
  | { readonly identity: 'bash' | 'plan' | 'edit' }
  | { readonly identity: null; readonly miss: TopScreenMiss };

/** Wierzch ekranu z pełną tożsamością albo `none` z powodem jej braku. */
type Top =
  | { readonly kind: 'none'; readonly why: TopScreenMiss }
  | { readonly kind: 'bash'; readonly frame: ScreenOperation }
  | { readonly kind: 'plan'; readonly file: string }
  | { readonly kind: 'edit'; readonly operation: ScreenOperation };

/** Wynik drogi `Bash` albo `Edit` wierzchu: operacja, powód odrzucenia kandydata, `null` = brak kandydata tej drogi. */
type PathTop = { readonly operation: ScreenOperation } | { readonly miss: TopScreenMiss } | null;

const miss = (kind: Exclude<TopScreenMiss['kind'], 'bash-zone'>): { readonly miss: TopScreenMiss } =>
  ({ miss: { kind } });

/** Narzędzie zrzutu, które może stać za danym wierzchem. */
const TOP_TOOL = { bash: BASH_TOOL, plan: EXIT_PLAN_MODE_TOOL, edit: EDIT_TOOL } as const;

const TOP_TOOLS: ReadonlySet<string> = new Set(Object.values(TOP_TOOL));

/**
 * Pola zrzutu, które {@link matchTop} może przeczytać. Zrzut narzędzia bez tożsamości na wierzchu (inne niż `Bash`,
 * `ExitPlanMode` i `Edit`) dopasowanie rozstrzyga samą nazwą narzędzia (`no` albo `unknown` przy wierzchu bez
 * tożsamości), więc wejście, skrót i katalog wywołania wypadają; wynik dopasowania jest ten sam co dla pełnego zrzutu.
 */
export function topFieldsOf(dump: TopDump): TopDump {
  if (!TOP_TOOLS.has(dump.toolName)) return { toolName: dump.toolName, toolInput: null, inputSha256: '', cwd: '' };
  return { toolName: dump.toolName, toolInput: dump.toolInput, inputSha256: dump.inputSha256, cwd: dump.cwd };
}

/**
 * Kandydat na wierzch `Bash`: cała ramka spod tytułu `Bash` z listy (`wholeBashFrame`) albo z wierzchu kolejki
 * z licznikiem (`counter`). Tytuł z licznikiem nie trafia w mapę tytułów, więc blok kolejki ma tożsamość `form`
 * (tryb domyślny, bez linii `Ask rule`) albo `ask-rule` z linii `Ask rule` pod ramką; kandydatem jest wtedy blok,
 * którego tytuł po zdjęciu POPRAWNEGO licznika jest tytułem `Bash` (`queuedTitleToolOnScreen`; „0 of 2”, „3 of 2”
 * i „1 of 1” odpadają), a `Ask rule`, jeśli stoi, mówi `Bash`. Sprzeczny `Ask rule`, nagłówek MCP i blok
 * niejednoznaczny odpadają.
 */
function bashCandidate(
  dialog: ScreenDialog | null, text: string,
): { readonly frame: ScreenOperation; readonly counter: boolean } | null {
  if (dialog === null || dialog.kind !== 'tool') return null;
  const { identity, operation } = dialog;
  if (identity.kind === 'title') {
    const frame = wholeBashFrame(text);
    return frame === null ? null : { frame, counter: false };
  }
  if (identity.kind !== 'form' && !(identity.kind === 'ask-rule' && identity.tool === BASH_TOOL)) return null;
  if (queuedTitleToolOnScreen(text) !== BASH_TOOL) return null;
  if (operation === null || !operation.complete || !operation.headerVisible) return null;
  return { frame: operation, counter: true };
}

/**
 * Cała ramka `Bash` na wierzchu (obie drogi): kandydat ({@link bashCandidate}) liczy się
 * jak wierzch `Bash` wyłącznie przy wszystkich warunkach bloku naraz:
 *
 * - nad pierwszą opcją stoi dokładnie jedna para „goła kreska + tytuł”, licząc razem tytuły z zamkniętej listy
 *   i tytuły z licznikiem, i jest nią para kandydata na najbliższej kresce (`titlePair`): tytuł z listy dla drogi
 *   tytułu, tytuł z licznikiem dla kolejki; podrobiony tytuł w treści pod prawdziwym tytułem, para z licznikiem nad
 *   nim albo sąsiedni blok daje drugą parę;
 * - cała ramka operacji pod widocznym nagłówkiem, a ramka stoi w strefie TEGO bloku: górna kreska ramki pod kreską
 *   pary i nagłówek liczony od niej (para wpisana w ramkę dialogu bez tytułu z listy stoi pod górną kreską ramki);
 * - jedna ramka w bloku: w nagłówku między kreską pary a górną kreską ramki nie ma żadnej kreski regionu;
 * - strefa pod dolną kreską ramki aż do pierwszej opcji to wyłącznie linie z zamkniętej listy zmierzonych linii CLI
 *   dialogu `Bash` i jedno pytanie „Do you want to proceed?” na końcu (`bashZoneListed` w `screen/bash-zone.ts`).
 *
 * Dwa ostatnie warunki zamykają podróbkę z tytułem prawdziwego dialogu nad górną krawędzią odczytu: kreska, tytuł
 * `Bash` (z listy albo „… 1 of 2”) i ramka w treści dialogu `Read`, `Write` albo innego są wtedy jedyną widoczną
 * parą. Ekran nie mówi, co stoi nad krawędzią, a linie nad podrobioną parą pisze agent, więc ani margines od krawędzi,
 * ani rozpoznanie przycięcia niczego nie rozstrzyga. Rozstrzyga ogon prawdziwego dialogu pod jego ramką, rysowany
 * przez CLI: pytanie `Write`, `Edit` i reszty, linia `Read(…)`, opis MCP albo linie reguły uprawnień innego narzędzia
 * nie są na liście. Dół odczytu sprawdza {@link topOf}.
 *
 * Tożsamość dialogu dla reszty silnika (`dialogBlock`, `toolNaming`, `wholeBashFrame`) się nie zmienia.
 */
function bashTop(
  dialog: ScreenDialog | null, text: string, lines: readonly string[], found: OptionRegion,
): PathTop {
  const candidate = bashCandidate(dialog, text);
  if (candidate === null) return bashMissWithoutCandidate(dialog, text);
  const pair = titlePair(lines, found.firstOption);
  if (pair === null || pair.counter !== candidate.counter) return miss('title-pair');
  const block = operationAbove(lines.slice(pair.rule), found.regionStart - pair.rule);
  if (block === null || !block.complete || !block.headerVisible) return miss('frame');
  if (block.header.some((line) => HORIZONTAL_RULE_PATTERN.test(line.trim()))) return miss('frame');
  const zone = bashZoneMiss(lines.slice(found.regionStart, found.firstOption));
  if (zone === null) return { operation: candidate.frame };
  return zone.kind === 'question' ? miss('bash-question') : { miss: { kind: 'bash-zone', lines: zone.lines } };
}

/**
 * Powód przy dialogu, który mówi `Bash` (tytuł z listy, `Ask rule Bash(…)` albo tytuł z licznikiem kolejki), a nie
 * jest kandydatem ({@link bashCandidate}); `null` = dialog nie mówi `Bash` (diagnostyka, decyzji nie zmienia).
 */
function bashMissWithoutCandidate(dialog: ScreenDialog | null, text: string): PathTop {
  if (dialog === null || dialog.kind !== 'tool') return null;
  const { identity, operation } = dialog;
  const queued = queuedTitleToolOnScreen(text) === BASH_TOOL;
  const titled = identity.kind === 'title' && identity.tool === BASH_TOOL;
  const asked = identity.kind === 'ask-rule' && identity.tool === BASH_TOOL;
  if (!titled && !asked && !(identity.kind === 'form' && queued)) return null;
  if (!titled && !queued) return miss('title-pair');
  return operation === null || !operation.complete || !operation.headerVisible ? miss('frame') : miss('title-pair');
}

/**
 * Ramka `Edit` na wierzchu przy `single`: pod dolną kreską ramki aż do pierwszej opcji stoi wyłącznie pytanie
 * „Do you want to make this edit to <nazwa>?” z nazwą bazową pliku z nagłówka, także zawinięte (`editZoneListed`).
 * Nagłówek „Edit file” i ramkę diffu wpisane w treść dialogu `Read` albo innego rozpoznaje ogon tamtego dialogu.
 * Dialog `Edit` z linią CLI nad pytaniem (reguła uprawnień, licznik auto-odmowy) nie jest zmierzony, więc idzie do
 * biurka.
 */
function editTop(text: string, lines: readonly string[], found: OptionRegion): PathTop {
  const operation = editOperation(text);
  if (operation === null) return null;
  if (queueOnScreen(text).kind !== 'single') return miss('edit-queue');
  const name = editShownName(operation);
  return name !== null && editZoneListed(lines.slice(found.regionStart, found.firstOption), name)
    ? { operation }
    : miss('edit-zone');
}

/**
 * Wierzch ekranu. Drogi `Bash` i `Edit` wymagają dołu odczytu ze stopką dialogu zgody (`dialogBottomAnchored`):
 * prawdziwy dialog stoi na dole panelu, a pełna podróbka w transkrypcie widoku przewiniętego ma pod sobą dalszy tekst.
 * Dialog planu bierze nazwę pliku wyłącznie ze stopki, która jest ostatnią grupą linii odczytu (`planFooterFile`).
 * Bez tożsamości `why` mówi, gdzie odpadł kandydat: droga `Bash` przed drogą `Edit`, dół przed nimi.
 */
function topOf(text: string): Top {
  const dialog = parseOptions(text);
  const lines = trimmedLines(text);
  const found = optionRegion(lines);
  const anchored = found !== null && dialogBottomAnchored(lines);
  const bash = anchored ? bashTop(dialog, text, lines, found) : null;
  if (bash !== null && 'operation' in bash) return { kind: 'bash', frame: bash.operation };
  // Nazwa pliku planu jest tylko w dialogu planu (stopka pod ostatnią opcją, blok jednoznaczny).
  const file = dialog?.planFile ?? null;
  if (file !== null) return { kind: 'plan', file };
  const edit = anchored ? editTop(text, lines, found) : null;
  if (edit !== null && 'operation' in edit) return { kind: 'edit', operation: edit.operation };
  if (bash !== null) return { kind: 'none', why: bash.miss };
  if (edit !== null) return { kind: 'none', why: edit.miss };
  if (found === null) return { kind: 'none', why: { kind: 'no-options' } };
  const candidate = bashCandidate(dialog, text) !== null || bashMissWithoutCandidate(dialog, text) !== null
    || editOperation(text) !== null;
  return { kind: 'none', why: { kind: !anchored && candidate ? 'bottom' : 'other-dialog' } };
}

/** Nazwa pliku planu z `planFilePath` zrzutu (jak `hookMatchesScreen`); `null` = brak albo pusta. */
function planFileOf(input: unknown): string | null {
  const path = asRecord(input)?.['planFilePath'];
  if (typeof path !== 'string') return null;
  const name = (path.split('/').pop() ?? '').trim();
  return name === '' ? null : name;
}

/** Ostatni wierzch: obserwacja pyta o każdy zrzut puli przy tym samym tekście. */
let lastText: string | null = null;
let lastTop: Top = { kind: 'none', why: { kind: 'no-options' } };

function topCached(screenText: string): Top {
  if (screenText !== lastText) {
    lastTop = topOf(screenText);
    lastText = screenText;
  }
  return lastTop;
}

/**
 * Wierzch ekranu do diagnostyki (linia logu kanału zgód, `cycle.ts`): rodzaj tożsamości, z którą {@link matchTop}
 * porównuje zrzuty, albo powód jej braku ({@link TopScreenMiss}). Ten sam odczyt wierzchu co dopasowanie, bez wpływu na
 * jego wynik.
 */
export function topScreen(screenText: string): TopScreen {
  const top = topCached(screenText);
  return top.kind === 'none' ? { identity: null, miss: top.why } : { identity: top.kind };
}

/** Zgodność skrótu wejścia z wejściem per zrzut (pula trzyma te same obiekty przez cały proces). */
const digestOk = new WeakMap<TopDump, boolean>();

function digestMatches(dump: TopDump): boolean {
  const known = digestOk.get(dump);
  if (known !== undefined) return known;
  let ok: boolean;
  try {
    ok = canonicalSha256(dump.toolInput) === dump.inputSha256;
  } catch {
    ok = false;
  }
  digestOk.set(dump, ok);
  return ok;
}

export const matchTop: MatchTop = (screenText, dump) => {
  const top = topCached(screenText);
  if (top.kind === 'none') return 'unknown';
  if (dump.toolName !== TOP_TOOL[top.kind]) return 'no';
  if (dump.inputSha256 === null || !digestMatches(dump)) return 'unknown';
  switch (top.kind) {
    case 'bash': {
      const command = bashCommand(dump.toolName, dump.toolInput);
      return command !== null && commandMatches(top.frame, command) ? 'match' : 'no';
    }
    case 'plan': {
      const file = planFileOf(dump.toolInput);
      if (file === null) return 'unknown';
      return file === top.file ? 'match' : 'no';
    }
    case 'edit':
      if (editMatchesOperation(dump.toolInput, top.operation, dump.cwd)) return 'match';
      return editContradictsOperation(dump.toolInput, top.operation) ? 'no' : 'unknown';
  }
};
