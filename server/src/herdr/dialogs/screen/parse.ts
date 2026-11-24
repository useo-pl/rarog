/**
 * Czyste funkcje nad tekstem ekranu panelu — jedyne, co Rarog wyciąga z `agent.read`.
 *
 * REGUŁA PRYWATNOŚCI (`docs/security-model.md`, „herdr sessions: Rarog writes to a terminal it does not own”, pkt 11): poza wycinkiem dialogu, rozpoznanym trybem, nazwą narzędzia
 * i ETYKIETAMI OPCJI nic z ekranu nie jest zapisywane, logowane ani wysyłane. Ekran potrafi
 * zawierać treść pliku `.env` albo klucz w komendzie — `parseMode` bierze kilkanaście
 * ostatnich linii pod ostatnią poziomą kreską i wyrzuca resztę, `snippet` trafia WYŁĄCZNIE
 * na KARTĘ tej jednej sesji (`SessionSummary.herdrDialogScreen`), a `parseOptions` oddaje
 * z całego ekranu dokładnie trzy rzeczy: rodzaj dialogu, nazwę narzędzia i listę opcji
 * (`cyfra → etykieta`, z OPISEM opcji i stanem checkboxa — to ta sama klasa treści co etykieta:
 * pisze ją autor pytania dla człowieka przy telefonie). Do tego treść samego dialogu: pytanie
 * (karta uniwersalna) i ramkę OPERACJI (komenda, diff) — do porównań tożsamości i na kartę
 * tej jednej sesji, nigdy do dziennika ani logów.
 * Nic więcej z ekranu nie wychodzi z modułów `dialogs/screen/`.
 *
 * Wszystkie funkcje są synchroniczne i bez I/O: testują się na fixture'ach z repo, nie na
 * gnieździe.
 */
import { createHash } from 'node:crypto';
import { EXIT_PLAN_MODE_TOOL } from '@rarog/shared';
import { withoutAutoDeny } from './auto-deny.ts';
import { headerAboveEdge, operationAbove } from './operation.ts';
import type { ScreenOperation } from './operation.ts';
import { trimmedLines } from './text.ts';
import { DIALOG_TAIL_LINES, blockTopOf, dialogRegions, framedDialogText } from './region.ts';
import {
  OPTION_LINE_PATTERN, guideMap, isCompleteOptionSet, optionsCloseRegion, optionsIn, selectedOptionIn,
  selectedWithLabel, unbox, unframe,
} from './options.ts';
import type { LabelGuide, ScreenOption } from './options.ts';
import { contentEscalates } from '../policy/escalation.ts';
import type { TerminalDialogId } from '../policy/terminal.ts';
import {
  blockFromSubagent, dialogBlock, fileDialogTitle, lineBelow, regionCallTrace, toolNaming,
} from './block.ts';
import { PLAN_DIALOG_PATTERN, PLAN_EXIT_CONFIRM_PATTERN, SANDBOX_NETWORK_TOOL, dialogKind } from './kinds.ts';
import type { ScreenDialogKind } from './kinds.ts';
import { FORM_IDENTITY } from './identity.ts';
import type { DialogIdentity } from './identity.ts';
import { blockKnownDialog } from './known.ts';
import { planFooterFile } from './plan-file.ts';
import type { KnownDialogId } from './known.ts';
import { NOTES_EDITING_MARKER, formFooter, formMultiSelect, formSubmitMode, questionFrom } from './form.ts';
import { confirmFrom } from './confirm.ts';
import { fileDialogShown } from './file-dialog.ts';
import { digitlessChoiceBelow, lastRunStart } from './option-run.ts';

/** Czy na ekranie stoi dialog, który z definicji NIE MA wpisu w jsonl ani zrzutu hooka? */
export function screenOnlyDialog(text: string): boolean {
  const dialog = parseOptions(text);
  return dialog !== null && dialog.toolName === SANDBOX_NETWORK_TOOL;
}

/**
 * Whether the dialog standing on screen is a subagent's: the title line of its block carries the subagent suffix
 * ({@link blockFromSubagent}). No dialog with a complete option list = not a subagent's.
 */
export function subagentDialogOnScreen(text: string): boolean {
  const lines = trimmedLines(text);
  const found = optionRegion(lines);
  return found !== null && blockFromSubagent(lines, dialogBlock(lines, found.firstOption));
}

export interface ScreenDialog {
  /**
   * `'tool'` = zgoda na narzędzie, `'question'` = AskUserQuestion, `'confirm'` = dialog
   * potwierdzenia ustawień CLI rozpoznany po KSZTAŁCIE (patrz `confirmFrom`), `'other'` = reszta.
   */
  kind: ScreenDialogKind;
  /**
   * Nazwa narzędzia z BLOKU dialogu: tytuł pod górną kreską, a przy tytule nad krawędzią panelu
   * linia `Ask rule` pod ramką operacji albo pytanie `Write` pod ramką treści (`screen/write-zone.ts`);
   * dla planu i sieci sandboksa nazwa nadana przez Raroga. `null`,
   * gdy blok jej nie niesie, i przy `identity.kind === 'ambiguous'`. Nigdy z linii `⏺`, z ramki
   * operacji, z opcji, z opisu ani ze scrollbacku.
   */
  toolName: string | null;
  /** Tożsamość dialogu z bloku — patrz {@link DialogIdentity}. */
  identity: DialogIdentity;
  /**
   * Dialog z zamkniętej listy {@link KNOWN_DIALOGS} rozpoznany po TYTULE bloku (`model`, `trust`) albo,
   * dla `trust`, po zdaniu w treści bloku; `null` dla każdego innego. Wyłącznie rodzaj `confirm`
   * i `other` w regionie odgrodzonym kreską: zgoda na narzędzie i formularz pytania to nie dialog
   * ustawień, a ich treść pisze agent.
   */
  knownDialog: KnownDialogId | null;
  /**
   * Serwer MCP z nagłówka pod tytułem „Tool use” (`catalog`); `null` = to nie jest zgoda na narzędzie MCP.
   *
   * Osobne pole, bo dialog MCP nie niesie na ekranie identyfikatora narzędzia — patrz
   * {@link MCP_DIALOG_HEADER_PATTERN}. Dla takiej zgody `toolName` jest i zostaje `null`;
   * cross-check z jsonl porównuje wtedy serwer i {@link mcpTool}, a na kartę i do dziennika jedzie
   * nazwa kanoniczna z jsonl/hooka (`mcp__<serwer>__<narzędzie>`).
   */
  mcpServer: string | null;
  /** Ludzki tytuł narzędzia MCP z tego samego nagłówka („Get Project Tree Layout”); `null` jak wyżej. */
  mcpTool: string | null;
  /**
   * OPERACJA zgody na narzędzie — ramka `╌╌╌` z komendą, diffem albo treścią pliku nad pytaniem
   * (`dialogs/screen/operation.ts`). `null` dla dialogu bez takiej ramki (MCP,
   * pytanie, plan) i dla rodzaju innego niż `tool`. To na niej stoi tożsamość dialogu, gdy nazwa
   * narzędzia nie wystarcza albo jest nad krawędzią ekranu.
   */
  operation: ScreenOperation | null;
  /**
   * ODCISK dialogu do kontroli tuż przed cyfrą: skrót SHA-256, 16 znaków hex. Inny dialog pod tą samą
   * etykietą i cyfrą (komenda X rozstrzygnięta przy biurku, na ekranie już Y; drugie potwierdzenie z „Yes”
   * pod cyfrą 1) daje inny odcisk. Skrót, nie treść — z ekranu nie wychodzi nic więcej niż dotąd.
   *
   * - **Zgoda na narzędzie (`tool`):** nagłówek, operacja i pytanie bez licznika auto-odmowy; `null` dla
   *   dialogu bez ramki operacji. Dialog planu: nazwa pliku planu ze stopki ({@link planFile}); bez niej `null`.
   * - **Pytanie, potwierdzenie i reszta (`question`, `confirm`, `other`):** BLOK dialogu, patrz
   *   {@link blockPrint}; `null` przy bloku niejednoznacznym i gdy nad opcjami nie ma góry bloku.
   *
   * Odcisk dowodzi tożsamości bloku między dwoma odczytami, nie jego kompletności: lista ucięta przy obu
   * odczytach tak samo daje ten sam odcisk.
   */
  bodyPrint: string | null;
  /**
   * Nazwa pliku planu ze STOPKI dialogu `ExitPlanMode` (`~/.claude/plans/<nazwa>.md`, patrz {@link planFooterFile}):
   * jedyna tożsamość planu na ekranie, z którą cross-check porównuje `planFilePath` zrzutu hooka. `null` dla
   * innego dialogu, przy bloku niejednoznacznym i gdy stopki nie ma albo jest niekompletna lub nierozpoznana.
   */
  planFile: string | null;
  /**
   * Treść pytania odczytana z ekranu — dla `kind: 'question'` (formularz `AskUserQuestion`),
   * `kind: 'confirm'` (dialog potwierdzenia; `header` jest pusty, poza dialogiem z listy
   * {@link TERMINAL_DIALOGS}, gdzie niesie jego tytuł, a `question` resztę treści) ORAZ
   * `kind: 'tool'` (zgoda na narzędzie; treść to
   * dosłowne linie dialogu nad opcjami; dłuższe niż {@link TOOL_QUESTION_MAX_CHARS} → `null`; `null` także
   * bez widocznej góry bloku i przy nagłówku nad krawędzią ekranu).
   *
   * `null` przy pytaniu znaczy „formularza nie da się uczciwie obsłużyć jedną cyfrą":
   * multi-select ({@link ScreenDialog.multiSelect}) wymagałby `space`+`enter`, czyli wyboru
   * po pozycji — taki formularz zostaje przy karcie „odpowiedz w terminalu".
   * Dla `kind: 'confirm'` pole jest zawsze wypełnione (bez treści nie ma rozpoznania), poza blokiem
   * niejednoznacznym: przy `identity.kind === 'ambiguous'` jest `null` dla każdego rodzaju.
   */
  question: { header: string; question: string } | null;
  /**
   * Formularz WIELOKROTNEGO wyboru — patrz `formMultiSelect`.
   *
   * Stopki `space to …` zmierzony ekran (zrzut z iPada, `dialog-askuserquestion-multi.txt`) NIE
   * MA — sygnaturami są checkboxy w liniach opcji i pozycja „Submit". Skutek sygnatur jest jeden:
   * `question: null`, czyli karta „odpowiedz w terminalu" zamiast przycisków (`docs/security-model.md`, „Starting sessions from the phone: three powers”).
   * Sam pasek z „✔ Submit" sygnaturą NIE JEST — rysuje go każdy formularz wielopytaniowy
   * (zmierzone).
   *
   * Heurystykę ekranu NADPISUJE — w obie strony — pole `multiSelect`
   * z payloadu hooka `AskUserQuestion`, przekazane przez `opts` do {@link parseOptions}.
   * Autor pytania wie o swoim formularzu więcej niż glify na ekranie; sygnatury zostają dla
   * sesji bez hooka. Ekran PRZEGLĄDU odpowiedzi jest z sygnatur wyjęty warunkiem negatywnym
   * (patrz `isReviewScreen`) — to zwykłe potwierdzenie z cyframi, nie wielokrotny wybór.
   */
  multiSelect: boolean;
  /** Mapa TEKST opcji → cyfra. NIGDY pozycja w tablicy. */
  options: readonly ScreenOption[];
  /**
   * Jak dialog przyjmuje decyzję — zmierzone na żywych panelach (CLI 2.1.246):
   *
   * - `'digit'` — cyfra WYBIERA I ZATWIERDZA w jednym kroku. Tak działają: dialogi zgody,
   *   dialogi potwierdzeń, formularz `AskUserQuestion` bez podglądu (także wielopytaniowy —
   *   cyfra odpowiada i sama przechodzi do następnego pytania).
   * - `'digit-enter'` — WYŁĄCZNIE wariant z polem `preview` (ramka podglądu obok opcji):
   *   cyfra tylko przesuwa podświetlenie `❯`, zatwierdza dopiero `enter`. Wysłanie obu
   *   w jednej ramce NIE działa (pomiar: cyfra ginie, enter zatwierdza opcję
   *   domyślną) — zatwierdzenie wymaga dwóch kroków z odczytem ekranu pomiędzy
   *   (`form-submit.ts`).
   *
   * Rozpoznanie po dwóch niezależnych śladach wariantu preview: glif ramki w linii opcji
   * ({@link OPTION_BOX_GLYPH_PATTERN}) albo marker `n to add notes` w regionie.
   */
  submit: 'digit' | 'digit-enter';
  /**
   * Opcja AKTUALNIE podświetlona (`❯ 2. …`) w zwycięskim regionie; `null` gdy markerów jest
   * zero albo więcej niż jeden. Tylko `❯` (bez `>*·` z {@link SELECTION_MARKER_PATTERN}):
   * weryfikacja podświetlenia przed `enter` musi być węższa niż kosmetyka etykiet — composer
   * i echa promptów też zaczynają się od `❯`, ale nie mają za nim `cyfra.`.
   */
  selected: ScreenOption | null;
  /**
   * Formularz stoi w trybie EDYCJI NOTATKI (`n` przy biurku): cyfra wpisałaby się jako TEKST
   * do pola, nie jako wybór (pomiar: „Notes: 5"). Sygnatura: `ctrl+g to edit`
   * w stopce — pojawia się wyłącznie w tym trybie. Karta pytania dostaje wtedy `question:
   * null` (fallback „odpowiedz w terminalu"), a każda wysyłka jest fail-closed.
   */
  notesEditing: boolean;
  /**
   * Dialog CLI z zamkniętej listy {@link TERMINAL_DIALOGS} — `kind` jest wtedy `'confirm'`, a karta niesie treść i opcje bez ani jednego
   * przycisku. `null` = dialog spoza tej listy.
   */
  terminalDialog: TerminalDialogId | null;
  /**
   * Pierwsza linia treści dialogu w regionie ODGRODZONYM kreską (tytuł: „Session paused", pytanie
   * potwierdzenia, „Do you want to proceed?" pod ramką operacji); `null` dla regionu bez kreski nad nim
   * — tam pierwsza linia bywa scrollbackiem. Do odcisku karty bez przycisków (`screenFallbackReqId`)
   * i do rozpoznania pauzy przed `escape` ({@link sessionPausedDialog}); bez licznika auto-odmowy.
   */
  title: string | null;
}

/** Zwycięski region opcji ekranu (patrz {@link optionRegion}). */
export interface OptionRegion {
  /** Kandydat z `dialogRegions`: surowe linie regionu i to, czy zaczyna się za kreską. */
  readonly candidate: { readonly lines: readonly string[]; readonly bounded: boolean };
  /** Linie regionu po `unbox` (rozpoznanie kształtu). */
  readonly region: readonly string[];
  /** Te same linie z zachowanym wcięciem — jedyne źródło pomiaru dla `descriptionAfter`. */
  readonly raw: readonly string[];
  readonly submit: 'digit' | 'digit-enter';
  /** Kompletna lista opcji `1…N` z linii cyfr (bez sklejania zawiniętych etykiet). */
  readonly options: readonly ScreenOption[];
  /** Indeks pierwszej linii regionu w liniach ekranu. */
  readonly regionStart: number;
  /** Indeks linii pierwszej opcji w liniach ekranu — od niej liczy się blok dialogu. */
  readonly firstOption: number;
}

/**
 * Region opcji, z którego czyta {@link parseOptions}: pierwszy kandydat (od najwęższego), który widzi
 * spójną i KOMPLETNĄ listę opcji `1…N`; `null`, gdy żaden.
 *
 * `null` z `optionsIn` dyskwalifikuje TEN region, nie cały ekran. Kandydaci idą od
 * najwęższego i poszerzają się kreska po kresce, więc sprzeczność w szerszym regionie bierze się najczęściej
 * z listy numerowanej w SCROLLBACKU nad dialogiem (zmierzone na żywo: „1. Zrestartuj… 2. Przeładuj…"
 * w wiadomości agenta tuż nad formularzem pytania) — a nie z przemalowanego ekranu. Fail-closed zostaje na
 * końcu pętli: gdy ŻADEN region nie widzi jednocześnie spójnej i kompletnej listy 1…N (np. duplikaty
 * w samym dialogu po przemalowaniu), wynikiem jest `null`, nigdy domysł.
 *
 * @param lines linie ekranu po `trimmedLines`
 */
export function optionRegion(
  lines: readonly string[], labels?: ReturnType<typeof guideMap>,
): OptionRegion | null {
  for (const candidate of dialogRegions(lines)) {
    const region = candidate.lines.map(unbox);
    const raw = candidate.lines.map(unframe);
    // Tryb zatwierdzania liczymy PRZED opcjami: wariant `preview` wyłącza czytanie opisów
    // (ramka podglądu stoi dokładnie tam, gdzie w drugim wariancie stoi opis).
    const submit = formSubmitMode(region);
    const reading = { preview: submit === 'digit-enter', wrap: false, labels };
    const regionStart = lines.length - candidate.lines.length;
    let options = optionsIn(region, raw, candidate.lines, reading);
    let runStart = region.findIndex((line) => OPTION_LINE_PATTERN.test(line));
    // A numbered list in the dialog body repeats the option digits: the options are the run above the footer.
    if (options === null) {
      runStart = lastRunStart(region, raw);
      options = runStart === -1
        ? null
        : optionsIn(region.slice(runStart), raw.slice(runStart), candidate.lines.slice(runStart), reading);
    }
    if (options === null || !isCompleteOptionSet(options)) continue;
    // Numbered lines above a digitless choice (`❯ No` over a key footer) are the dialog body, not its options.
    if (digitlessChoiceBelow(candidate.lines)) continue;
    return { candidate, region, raw, submit, options, regionStart, firstOption: regionStart + runStart };
  }
  return null;
}

/**
 * Opcje dialogu z ekranu panelu.
 *
 * Cała funkcja jest zbudowana wokół jednej reguły: **cyfra pochodzi z TEKSTU linii, nigdy
 * z pozycji w tablicy**. CLI potrafi przetasować numerację („3. Yes / 1. No"), a wybór po
 * pozycji zatwierdziłby wtedy coś zupełnie innego, niż widzi człowiek na karcie.
 *
 * Fail-closed jest wszędzie tam, gdzie ekran jest niejednoznaczny: zero opcji, cyfra `0`
 * (CLI numeruje od 1 — `0.` znaczy, że czytamy nie to, co myślimy), powtórzona cyfra albo
 * powtórzona etykieta (ekran przemalowany w trakcie odczytu, a przy dwóch identycznych
 * etykietach wybór „po tekście" przestaje być jednoznaczny) → `null`. `null` znaczy „nie wiem",
 * a wołający ma z tego zrobić kartę bez przycisków, nigdy kartę z domysłem.
 *
 * @param text surowy ekran z `agent.read` (ANSI dozwolone — zdejmujemy je tutaj)
 * @param opts `multiSelect` — AUTORYTATYWNE rozstrzygnięcie z payloadu hooka
 *        (`AskUserQuestion.questions[].multiSelect`), które zastępuje heurystykę
 *        {@link formMultiSelect} w OBIE strony. Nieobecne = rozstrzyga ekran, jak dotąd.
 * @returns rodzaj dialogu, nazwa narzędzia i opcje, albo `null`, gdy ekran nie jest dialogiem
 */
export function parseOptions(
  text: string,
  opts?: { multiSelect?: boolean | undefined; labels?: readonly LabelGuide[] | undefined },
): ScreenDialog | null {
  const lines = trimmedLines(text);
  if (lines.length === 0) return null;
  const labels = opts?.labels === undefined ? undefined : guideMap(opts.labels);

  const found = optionRegion(lines, labels);
  if (found === null) return null;
  const { candidate, region, raw, submit, regionStart, firstOption } = found;
  let { options } = found;
  const regionLower = region.join('\n').toLowerCase();
  let kind = dialogKind(regionLower);
  // Blok dialogu: granica i tytuł z kreski nad PIERWSZĄ opcją zwycięskiego regionu.
  const block = dialogBlock(lines, firstOption);
  const trace = regionCallTrace(region);
  /*
   * The plan-mode exit dialog (`ExitPlanMode`) — a CLOSED signature, measured live. Without it
   * this dialog would be `other`: it asks "Would you like to proceed?", not "Do you want to
   * proceed?", so the consent footer markers miss it, and `confirmFrom` drops out on the key hint
   * under the last option. Result: a card without content or buttons for a dialog that shows
   * everything on screen.
   *
   * The tool name here comes from the SIGNATURE, not the screen: the plan dialog draws no call
   * line of its own. The call trace in the region (`regionCallTrace`) guards the reverse mistake:
   * a signature sentence above a real consent dialog may not rename it to `ExitPlanMode`. The
   * sandbox network dialog is recognised by the block TITLE, under the same condition.
   */
  const regionText = region.join('\n');
  const planDialog = (PLAN_DIALOG_PATTERN.test(regionText) || PLAN_EXIT_CONFIRM_PATTERN.test(regionText))
    && !trace && (block.title === null || block.title.kind === 'plan');
  const networkDialog = !planDialog && block.title?.kind === 'network' && !trace;
  // A file dialog whose key footer a narrow pane cut or wrapped has lost its only kind marker (`screen/file-dialog.ts`).
  const fileTitled = kind === 'other' && fileDialogTitle(block) !== null;
  const fileDialog = fileTitled && !planDialog && !networkDialog && !trace
    && fileDialogShown(lines, block, regionStart, firstOption);
  if (planDialog || networkDialog || fileDialog) kind = 'tool';
  // Nazwa pliku planu wyłącznie ze stopki pod OSTATNIĄ linią opcji: feedback opcji 3 stoi wyżej i głębiej niż cyfra.
  const lastOption = regionStart + region.findLastIndex((line) => OPTION_LINE_PATTERN.test(line));
  const lastOptionText = region[lastOption - regionStart] ?? '';
  const optionColumn = lastOptionText === '' ? -1 : (lines[lastOption] ?? '').indexOf(lastOptionText);
  const planFile = planDialog && !block.ambiguous ? planFooterFile(lines, lastOption, optionColumn) : null;
  // Marker WYŁĄCZNIE ze stopki: „ctrl+g" wypisane przez agenta
  // w scrollbacku nie ma prawa zdegradować stojącej karty do fallbacku.
  const notesEditing = kind === 'question' && formFooter(region).includes(NOTES_EDITING_MARKER);
  const multiSelect = opts?.multiSelect ?? formMultiSelect(region, options);
  // Treść pytania bez licznika auto-odmowy (CLI 2.1.294): tyka co sekundę, a tekst pytania
  // wchodzi do odcisku karty z ekranu — z licznikiem karta zmieniałaby tożsamość co ocenę.
  const textRegion = withoutAutoDeny(region);
  const optionsAt = firstOption - regionStart;
  // Labels joined across wrapped lines come from the option run only: a numbered list in the body above it repeats
  // the digits and would void the read. The dialog text keeps the whole region (`optionsAt` in `questionFrom`).
  const wrappedRun = (): ScreenOption[] | null => optionsIn(
    region.slice(optionsAt), raw.slice(optionsAt), candidate.lines.slice(optionsAt), { preview: false, wrap: true },
  );
  /*
   * Dwie sytuacje, jeden skutek — `question: null`, czyli karta „odpowiedz w terminalu":
   *
   * - tryb edycji notatki: cyfra wpisałaby się jako TEKST, więc karta
   *   z przyciskami byłaby kłamstwem;
   * - formularz wielokrotny: zaznaczenie i zatwierdzenie to DWA różne klawisze, a dojście
   *   do „Submit" wymagałoby nawigacji po pozycji — patrz `formMultiSelect`.
   */
  let question = kind === 'question' && !notesEditing && !multiSelect
    ? questionFrom(textRegion, optionsAt)
    : null;
  /*
   * Zgoda na narzędzie też dostaje treść z ekranu (uniwersalna karta): dialog
   * `tool` bez wpisu w jsonl był dotąd kartą bez przycisków, choć niesie na ekranie komplet
   * (nagłówek narzędzia, komendę, pytanie, opcje z cyframi). Treść jedzie DOSŁOWNIE, tylko
   * przycięta sufitem — diff `Edit` potrafi być długi, a pełny ekran i tak idzie wycinkiem
   * do transkryptu, więc przycięcie nie ukrywa niczego, czego nie widać obok.
   */
  // Ramka operacji stoi NAD regionem opcji (pod nagłówkiem), więc liczymy ją z pełnych linii.
  const operation = kind === 'tool' ? operationAbove(lines, regionStart) : null;
  // Nagłówek dialogu nad krawędzią ekranu, także przy ramce bez paska `│`, której `operationAbove` nie czyta.
  const cutTop = kind === 'tool' && headerAboveEdge(lines, regionStart, operation);
  let bodyPrint: string | null = null;
  if (kind === 'tool') {
    /*
     * Marker eskalacji w TREŚCI odbiera formularz TAKŻE zgodzie na narzędzie:
     * ostrzeżenie „Bypass Permissions mode … Do you want to proceed?" ma
     * stopkę identyczną z dialogiem narzędzia, a komenda `claude
     * --dangerously-skip-permissions` niesie marker w samej treści. Koszt fałszywego
     * trafienia (komenda z „trust" w tekście) to karta bez przycisków + wycinek —
     * fail-closed, nigdy tapnięcie w skutek, którego karta nie nazywa.
     */
    const form = contentEscalates(region) ? null : questionFrom(textRegion, optionsAt);
    /*
     * Dialog z RAMKĄ OPERACJI (od CLI 2.1.286): to, co człowiek zatwierdza (komenda,
     * diff, host sieci, plan), stoi NAD regionem opcji, więc sam region dawał kartę z samym
     * pytaniem — zgoda `Bash` z ekranu miała pustą treść i żywy przycisk. Treść karty to
     * nagłówek + operacja + pytanie. Karta z przyciskami wyłącznie dla dialogu widocznego
     * W CAŁOŚCI (górna kreska dialogu nad nagłówkiem i górna kreska ramki); ucięty u góry
     * dialog z samego ekranu nie ma treści, którą dałoby się uczciwie pokazać — `question:
     * null`, czyli karta z wycinkiem i bez przycisków. Odcisk treści (`bodyPrint`) jedzie
     * z kartą do kontroli tuż przed cyfrą — także dla dialogu uciętego, bo tam kartę może
     * wystawić jsonl z hookiem (podwójny dowód).
     */
    const body = operation === null
      ? form?.question ?? null
      : framedDialogText(operation, questionFrom(textRegion, optionsAt)?.question ?? '');
    if (operation !== null && body !== null) {
      bodyPrint = createHash('sha256').update(body).digest('hex').slice(0, 16);
    }
    /*
     * Dialog planu nie ma ramki operacji, a jego tożsamością jest nazwa pliku planu ze stopki (`planFile`). Odcisk
     * z niej odróżnia plan A od planu B o tym samym pytaniu i opcjach: karta z hooka, z jsonl i z ekranu niesie go
     * do kontroli tuż przed cyfrą, a karta z ekranu także w `reqId` (`screenFormReqId`). Bez stopki odcisku nie ma.
     */
    if (planFile !== null) {
      bodyPrint = createHash('sha256').update(`${bodyPrint ?? ''}\nplan:${planFile}`).digest('hex').slice(0, 16);
    }
    /*
     * Ramka ucięta u góry nie daje formularza z ekranu NIEZALEŻNIE od tożsamości:
     * ramka bez paska `│` (treść `Write`, diff `Edit`) ucięta u góry nie jest dla `operationAbove` ramką, więc bez
     * `cutTop` dialog bez nagłówka dostawałby formularz z samym pytaniem, także z tożsamością `form` (pytanie `Write`
     * z dopiskiem pod ramką, `Edit` od środka diffu). Nazwa z bloku (`file-question`, `ask-rule`) nie przywraca go.
     *
     * Brak ramki (`operation === null`) nie dowodzi, że dialog jest cały: góra bloku potrafi zniknąć nad krawędzią
     * razem z OBIEMA kreskami ramki, a wtedy ekran zaczyna się od pytania. Formularz wymaga więc widocznej góry bloku:
     * kreski bloku nad opcjami ({@link dialogBlock}) i niepustej linii pod nią (tytuł albo nagłówek narzędzia, przy
     * dialogu planu zdanie pytania pod jego kreską). Wyjątek dla `Bash` z dowodem treści stoi na ścieżce jsonl
     * i hooka (`clippedHeaderProven` w `screen/resolve.ts`, `bashFrameProven` w `decide/sources.ts`), nie tutaj.
     */
    const topVisible = block.top !== -1 && lineBelow(lines, block.top, firstOption) !== -1;
    const whole = topVisible && !cutTop && (operation === null || (operation.complete && operation.headerVisible));
    /*
     * Treść dłuższa niż sufit karty = karta BEZ przycisków. Przy przyciętej treści
     * z przyciskami przycięty koniec (`rm -rf ~/Pictures` po 22 liniach `printf`) nie trafiałby
     * ani na kartę, ani do klasyfikatora ryzyka, za to cyfra zatwierdzałaby go razem z resztą.
     * Karta z wycinkiem mówi uczciwie: „zatwierdź w terminalu".
     */
    question = form === null || body === null || !whole || body.length > TOOL_QUESTION_MAX_CHARS
      ? null
      : { header: form.header, question: body };
  }
  let terminalDialog: TerminalDialogId | null = null;
  /*
   * A block the CLI titled as a file dialog is never a generic confirmation: its question ("Do you want to make this
   * edit to <name>?") reads as one, and a confirmation card would approve the file with neither the diff nor a proof.
   * When its parts do not prove the shape (`fileDialogShown`), it stays `other` without a form: a consent kind would
   * send the pending call to the frame proofs without the file question that names the dialog.
   */
  if (kind === 'other' && candidate.bounded && !fileTitled) {
    // Lista terminalowa porównuje KOMPLET etykiet, więc dostaje je sklejone jak potwierdzenie niżej
    // („Edit prompt and retry with Opus 5.5 (1M context)" łamie się w wąskim panelu).
    const wrapped = wrappedRun() ?? options;
    const confirm = confirmFrom(textRegion, wrapped, optionsAt);
    if (confirm !== null) {
      kind = 'confirm';
      question = { header: confirm.header, question: confirm.question };
      terminalDialog = confirm.terminalDialog;
    }
  }
  // Tytuł wyłącznie z regionu za kreską — patrz `ScreenDialog.title`.
  const title = candidate.bounded
    ? (questionFrom(textRegion, optionsAt)?.question.split('\n')[0] ?? '').trim() || null
    : null;
  /*
   * Zgoda i potwierdzenie: etykieta zawinięta przez wąski panel wraca w całości.
   * Liczone PO rodzaju, bo dopiero on mówi, że pod opcjami nie ma opisów. Ta sama
   * lista cyfr co wyżej, więc kompletność się nie zmienia; sprzeczność po sklejeniu
   * (powtórzona etykieta) zostawia odczyt z linii cyfr — nigdy nie wymyśla nowego.
   */
  if (kind === 'tool' || kind === 'confirm') {
    options = wrappedRun() ?? options;
  }
  /*
   * Nazwa i tożsamość WYŁĄCZNIE z bloku. Zgoda na narzędzie: reguła 2 ({@link toolNaming}), strefa
   * `Ask rule` to linie regionu nad opcjami, gdy region zaczyna się pod dolną kreską ramki operacji; te same
   * linie niosą pytanie `Write`, gdy nagłówek dialogu jest nad krawędzią ekranu ({@link headerAboveEdge}).
   * Inne rodzaje: nazwa z tytułu bloku (do diagnostyki rozjazdu rodzaju), a tożsamością jest dialog
   * z zamkniętej listy albo formularz. Znany dialog: rodzaj `confirm`/`other`, region za kreską, dialog
   * spoza listy terminalowej i opcje na dole regionu (reguła 4).
   */
  const naming = kind === 'tool'
    ? toolNaming(
      lines, block, firstOption,
      planDialog ? EXIT_PLAN_MODE_TOOL : networkDialog ? SANDBOX_NETWORK_TOOL : null,
      operation === null ? null : lines.slice(regionStart, firstOption),
      cutTop ? lines.slice(regionStart, firstOption) : null,
    )
    : null;
  const knownDialog = (kind === 'confirm' || kind === 'other') && candidate.bounded && terminalDialog === null
    && optionsCloseRegion(region)
    ? blockKnownDialog(lines, block, firstOption, options)
    : null;
  const identity: DialogIdentity = naming?.identity
    ?? (block.ambiguous ? { kind: 'ambiguous' } : knownDialog !== null ? { kind: 'known', id: knownDialog } : FORM_IDENTITY);
  // Odcisk bloku: góra to kreska bloku tuż nad regionem opcji albo kreska ze statusem sesji.
  if (kind !== 'tool' && !block.ambiguous) {
    const top = candidate.bounded && block.top === regionStart - 1 ? block.top : statusRuleTop(lines, firstOption);
    bodyPrint = top === null ? null : blockPrint(lines, top, found);
  }
  const blockTool = block.title?.kind === 'tool' ? block.title.tool : null;
  return {
    kind,
    toolName: naming === null ? blockTool : naming.toolName,
    identity,
    knownDialog,
    mcpServer: naming?.mcpServer ?? null,
    mcpTool: naming?.mcpTool ?? null,
    operation,
    bodyPrint,
    planFile,
    // Blok niejednoznaczny nie daje formularza na żadnej ścieżce (reguła 3): karta bez przycisków.
    question: block.ambiguous ? null : question,
    multiSelect,
    options,
    submit: kind === 'question' ? submit : 'digit',
    // Z linii SUROWYCH regionu — `unbox` zdejmuje marker `❯`, więc `region` go nie ma.
    selected: kind === 'question' ? selectedWithLabel(selectedOptionIn(candidate.lines), options) : null,
    notesEditing,
    terminalDialog,
    title,
  };
}

/**
 * Góra odcisku bloku według reguły 2: kreska ze statusem sesji (`▔▔▔ ◐ medium · /effort ▔`) jako NAJBLIŻSZA kreska
 * nad pierwszą opcją ({@link blockTopOf} z `nearest`), w oknie {@link DIALOG_TAIL_LINES} od dołu; `null`, gdy
 * najbliższa jest inna kreska albo żadnej nie ma. Taka kreska bywa górą widoku slash-komendy (CLI 2.1.310), a region
 * opcji się od niej nie zaczyna (`horizontalRule` jej nie łapie). Czyta ją wyłącznie odcisk: blok, rodzaj, tożsamość
 * i opcje jej nie znają.
 */
function statusRuleTop(lines: readonly string[], firstOption: number): number | null {
  const top = blockTopOf(lines, firstOption, { kinds: ['status'], nearest: true });
  return top !== null && top.line >= lines.length - DIALOG_TAIL_LINES ? top.line : null;
}

/**
 * ODCISK BLOKU pytania, potwierdzenia i dialogu spoza zgody: linie od `top + 1` do końca ekranu,
 * sklejone `\n`, SHA-256, 16 znaków hex. Góra to kreska bloku tuż nad regionem opcji (reguła 1: region ograniczony
 * kreską i zaczyna się pod kreską bloku) albo kreska ze statusem ({@link statusRuleTop}, reguła 2).
 *
 * - Linia opcji (cyfra z kropką po zdjęciu ramki i znacznika) wchodzi po `unbox`: ruch kursora `❯` przy biurku
 *   odcisku nie zmienia.
 * - Linia licznika auto-odmowy wchodzi w postaci po wycięciu licznika (`withoutAutoDeny`, w praktyce pusta).
 * - Każda inna linia wchodzi dosłownie, z wcięciem, krawędziami ramki i znakami `> * · ↑ ↓`: po `unbox` „↑ 10%”
 *   i „↓ 10%” byłyby tą samą linią.
 *
 * Licznik kolejki „k of N” zostaje w odcisku: nie wiadomo, czy CLI rysuje go nad pytaniem albo potwierdzeniem
 * (niezmierzone).
 *
 * Tę samą formułę bierze odcisk bloku warstwy 2 (`layer2/read-block.ts`), także dla bloku bez opcji z cyframi
 * (`found: null`): wtedy każda linia pod górą wchodzi dosłownie.
 */
export function blockPrint(lines: readonly string[], top: number, found: OptionRegion | null): string {
  const textRegion = found === null ? [] : withoutAutoDeny(found.region);
  const body = lines.slice(top + 1).map((line, k) => {
    const j = found === null ? -1 : top + 1 + k - found.regionStart;
    const boxed = j >= 0 ? found?.region[j] : undefined;
    if (boxed === undefined) return line;
    const cleaned = textRegion[j] ?? boxed;
    if (cleaned !== boxed) return cleaned;
    return OPTION_LINE_PATTERN.test(boxed) ? boxed : line;
  }).join('\n');
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

/**
 * Twardy sufit treści karty ZGODY NA NARZĘDZIE budowanej z ekranu (uniwersalna karta).
 * Większy niż {@link CONFIRM_QUESTION_MAX_CHARS}, bo treścią bywa komenda z opisem albo
 * kawałek diffa. Treść dłuższa niż sufit daje kartę BEZ przycisków, a nie przyciętą:
 * przycięty koniec komendy dałoby się zatwierdzić, choć karta i klasyfikator ryzyka go nie widzą.
 */
export const TOOL_QUESTION_MAX_CHARS = 2000;
