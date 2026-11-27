/**
 * Rejestr sygnatur ekranu Claude Code — JEDYNE miejsce, w którym stoi wygląd CLI.
 *
 * Moduły parsera (`server/src/herdr/dialogs/screen/`) i polityki (`server/src/herdr/dialogs/policy/`) czytają
 * wzorce stąd; rejestr nie importuje niczego, więc nie zamyka cyklu.
 * Opis całej obsługi dialogów: `docs/dialogs.md`.
 */
// ---------------------------------------------------------------------------
// Rejestr sygnatur ekranu — jedno miejsce, w którym stoi WYGLĄD Claude Code
// ---------------------------------------------------------------------------

/**
 * Jedna sygnatura: wzorzec albo marker, którym parser rozpoznaje kształt NARYSOWANY przez CLI.
 *
 * Wartości są tu, a nie w stałych modułu — stałe biorą je stąd (`= SCREEN_SIGNATURES.x.pattern`),
 * więc rejestr nie jest opisem kodu, tylko kodem. Dzięki temu „co zależy od wyglądu CLI"
 * odpowiada się jednym spojrzeniem po aktualizacji Claude Code, zamiast czytania 1600 linii.
 */
export interface ScreenSignature {
  /** Co ta sygnatura rozpoznaje — jedno zdanie; test sierot cytuje je przy nazwie. */
  readonly what: string;
  /** Wartość używana przez kod: regex, marker albo lista równoprawnych brzmień. */
  readonly pattern: RegExp | string | readonly string[];
  /** Wersja CLI, na której to zmierzono; `null` = pomiar sprzed rejestru, wersji nie zapisano. */
  readonly cli: string | null;
  /** Powód, dla którego sygnatura ŚWIADOMIE nie ma fixture'u (test trzyma zamkniętą listę). */
  readonly noFixture?: string;
}

/**
 * Rejestr wszystkiego, co w tym module zależy od WYGLĄDU Claude Code.
 *
 * Poza rejestrem zostają dwie klasy wzorców, obie celowo: te niezależne od CLI (sekwencje ANSI,
 * znaki sterujące, klasa „znak znaczący") i te dopasowywane do payloadu, a nie do ekranu
 * (`mcp__serwer__narzędzie` — nazwa z jsonl/hooka).
 *
 * `cli` names the CLI version of the measurement the pattern comes from. `null` means the measurement is older
 * than this registry and its version was not recorded; only entries moved here when the registry was created have
 * it. Every new entry has a version, because without it nobody knows what to refresh after a CLI update. Fixture'y odświeża skrypt pomiaru, a `herdr-screen-signatures.test.ts`
 * pilnuje, żeby każda sygnatura trafiała w co najmniej jeden plik z `server/test/fixtures/herdr/`. Kopię literału
 * z rejestru w kodzie `server/src/**` łapie `herdr-screen-signatures-guard.test.ts`.
 */
export const SCREEN_SIGNATURES = {
  horizontalRule: {
    what: 'pozioma kreska oddzielająca dialog od reszty ekranu (granica regionu)',
    pattern: /^[─═━┄┅┈┉╌╍▔\-_=]{8,}$/,
    cli: null,
  },
  boxEdge: {
    what: 'górna/dolna krawędź ramki dialogu (`╭────╮`, `╰────╯`)',
    pattern: /^[╭╰][─═━]*[╮╯]$/,
    cli: null,
  },
  boxEdgeStart: {
    what: 'lewa krawędź ramki dialogu w linii treści',
    pattern: /^[│┃|]\s?/,
    cli: null,
  },
  boxEdgeEnd: {
    what: 'prawa krawędź ramki dialogu w linii treści',
    pattern: /\s*[│┃|]$/,
    cli: null,
  },
  selectionMarker: {
    what: 'marker zaznaczonej pozycji i wskaźniki przewinięcia listy (`❯`, `↓`, `↑`)',
    pattern: /^[❯▶▸>*·↓↑]\s+/,
    cli: null,
  },
  optionLine: {
    what: 'linia opcji dialogu: cyfra, kropka, treść — jedyne źródło cyfr karty',
    pattern: /^(\d)\.\s+(.+)$/,
    cli: null,
  },
  selectedOption: {
    what: 'podświetlona opcja (`❯ 1. Yes`) — dowód w weryfikacji przed `enter`',
    pattern: /^❯\s+(\d)\.\s+(.+)$/,
    cli: null,
  },
  toolCall: {
    what: 'wywołanie narzędzia w renderze (`⏺ Bash(…)`) — dosłowna nazwa narzędzia',
    pattern: /^\s*[⏺*·✢✶✻✽]\s+([A-Z][A-Za-z0-9_]{0,63})\(/,
    cli: null,
  },
  toolDialogHeaderBash: {
    what: 'nagłówek ramki zgody na `Bash` — fallback nazwy dla renderu z opisem zamiast wywołania',
    pattern: 'Bash command',
    cli: null,
  },
  toolDialogHeaderEdit: {
    what: 'nagłówek ramki zgody na `Edit` („Edit file") — ekran rysuje `⏺ Update(plik)`, nie `Edit`',
    pattern: 'Edit file',
    cli: '2.1.258',
  },
  toolDialogHeaderWrite: {
    what: 'nagłówek ramki zgody na `Write` („Create file") — pod linią `⏺ Write(plik)`',
    pattern: 'Create file',
    cli: '2.1.258',
  },
  toolDialogHeaderWriteOverwrite: {
    what: 'nagłówek ramki zgody na `Write`, który nadpisuje istniejący plik („Overwrite file”) — pod linią '
      + '`⏺ Write(plik)`, nad diffem starej i nowej treści',
    // `measured/zgoda-write-nadpisanie-2.1.322.txt`
    pattern: 'Overwrite file',
    cli: '2.1.322',
  },
  toolDialogHeaderRead: {
    what: 'nagłówek ramki zgody na `Read` („Read file") — linia `Read(plik)` stoi WCIĘTA, bez bulletu `⏺`',
    pattern: 'Read file',
    cli: '2.1.278',
  },
  toolDialogHeaderWebFetch: {
    what: 'tytuł bloku zgody na `WebFetch` („Fetch") — pod linią `⏺ Fetch(url)`',
    pattern: 'Fetch',
    cli: '2.1.311',
  },
  toolDialogHeaderNotebookEdit: {
    what: 'tytuł bloku zgody na `NotebookEdit` („Edit notebook") — pod linią `⏺ Edit Notebook(plik@komórka)`',
    pattern: 'Edit notebook',
    cli: '2.1.311',
  },
  toolDialogHeaderSkill: {
    what: 'tytuł bloku zgody na `Skill` (`Use skill "nazwa"?`) — nazwa skilla w cudzysłowie, jedna linia',
    pattern: /^Use skill "[^"]{1,64}"\?$/,
    cli: '2.1.311',
  },
  askRule: {
    what: 'linia `Ask rule Bash(…) overrides…` — drugi fallback nazwy narzędzia',
    pattern: /^Ask rule\s+([A-Z][A-Za-z0-9_]{0,63})\(/,
    cli: null,
  },
  ruleTool: {
    what: '`Rule Bash(…) from …` line, the CLI 2.1.328 wording of the `askRule` line: the same second fallback for '
      + 'the tool name, rule in parentheses required',
    // `kontrolny/zgoda-bash-cytat-auto-2.1.328.txt`, `kontrolny/zgoda-bash-cytat-default-regula-2.1.328.txt`
    pattern: /^Rule\s+([A-Z][A-Za-z0-9_]{0,63})\(/,
    cli: '2.1.328',
  },
  mcpDialogHeader: {
    what: 'nagłówek zgody MCP (`catalog — Get Project Tree Layout Tool: (MCP)`) — SERWER i ludzki TYTUŁ narzędzia',
    // `dialog-permission-mcp.txt` (2.1.258, serwer jednym słowem). Nazwa serwera łącznika claude.ai to kilka słów
    // rozdzielonych pojedynczą spacją: `measured/zgoda-mcp-2.1.322.txt`, `measured/zgoda-mcp-argumenty-2.1.322.txt`
    // („Claude Docs — Guide Tool: (MCP)”, identyfikator `mcp__claude_ai_Claude_Docs__guide`).
    pattern: /^([A-Za-z0-9](?:[A-Za-z0-9._-]| (?=[A-Za-z0-9])){0,63})\s+[—–-]\s+(.+?)\s+Tool:\s*\(MCP\)$/,
    cli: '2.1.322',
  },
  toolUseTitle: {
    what: 'tytuł bloku zgody na narzędzie MCP („Tool use”); nagłówek MCP stoi w pierwszej niepustej linii pod nim',
    pattern: 'Tool use',
    cli: '2.1.293',
  },
  planTitle: {
    what: 'tytuł bloku dialogu `ExitPlanMode` („Ready to code?” nad planem, „Exit plan mode?” bez planu)',
    pattern: /^(?:Ready to code\?|Exit plan mode\?)$/,
    cli: '2.1.293',
  },
  toolDialogMarkers: {
    what: 'stopka dialogu zgody na narzędzie (za manifestem detekcji herdr)',
    pattern: ['do you want to proceed?', 'tab to amend', 'ctrl+e to explain'],
    cli: null,
  },
  questionNavMarkers: {
    what: 'stopka nawigacji formularza `AskUserQuestion` (za manifestem detekcji herdr)',
    pattern: ['↑/↓ to navigate', '↑↓ to navigate', 'arrow keys to navigate', 'arrows to navigate'],
    cli: null,
  },
  planFeedbackHint: {
    what: 'podpowiedź CLI pod opcją 3 dialogu `ExitPlanMode` (linia bez wcięć); granica stopki z plikiem planu',
    pattern: /^shift\+tab to approve with this feedback$/,
    cli: '2.1.314',
  },
  planFooter: {
    what: 'stopka dialogu `ExitPlanMode` z plikiem planu (`ctrl+g to edit in Nvim · ~/.claude/plans/<nazwa>.md`), '
      + 'linie złamanej stopki sklejone bez wcięć i bez separatora; grupa 1 to nazwa pliku',
    pattern: /^ctrl\+g\s*to\s*edit\s*in\s*[^·~/]+·\s*~\/\.claude\/plans\/([^\s/·~]+\.md)$/,
    cli: '2.1.314',
  },
  planDialog: {
    what: 'nagłówek dialogu `ExitPlanMode`',
    pattern: /Claude has written up a plan and is ready to execute/i,
    cli: null,
  },
  sandboxNetworkDialog: {
    what: 'dialog sieci sandboksa („Network request outside of sandbox") — bez hooka i bez jsonl',
    pattern: /^Network request outside of sandbox$/im,
    cli: '2.1.293',
  },
  sandboxNetworkHost: {
    what: 'linia hosta dialogu sieci sandboksa („Host: example.com”) między dwiema kreskami ramki; grupa 1 = host',
    // `kontrolny/zgoda-siec-2.1.322.txt`, `measured/zgoda-siec-2.1.322.txt`
    pattern: /^Host: ([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?)$/u,
    cli: '2.1.322',
  },
  sandboxNetworkQuestion: {
    what: 'pytanie dialogu sieci sandboksa nad opcjami („Do you want to allow this connection?”), znak w znak',
    pattern: /^Do you want to allow this connection\?$/u,
    cli: '2.1.322',
  },
  sandboxNetworkAlways: {
    what: 'opcja 2 dialogu sieci sandboksa („Yes, and don\'t ask again for <host>”); grupa 1 = host',
    pattern: /^Yes, and don't ask again for (\S+)$/u,
    cli: '2.1.322',
  },
  sandboxNetworkNo: {
    what: 'opcja 3 dialogu sieci sandboksa („No, and tell Claude what to do differently (esc)”), znak w znak',
    pattern: /^No, and tell Claude what to do differently \(esc\)$/u,
    cli: '2.1.322',
  },
  measuredConsentYes: {
    what: 'opcja zgody jednorazowej („Yes”) w kształtach zgody zmierzonych dla cyfry',
    // `kontrolny/zgoda-mcp-interakcja-2.1.322.txt`, `kontrolny/zgoda-siec-2.1.322.txt`
    pattern: /^Yes$/u,
    cli: '2.1.322',
  },
  measuredConsentNo: {
    what: 'opcja odmowy („No”) dialogu MCP z `requiresUserInteraction` (dwie opcje: „Yes”, „No”)',
    pattern: /^No$/u,
    cli: '2.1.322',
  },
  mcpToolAbout: {
    what: 'linia „About the <serwer> — <Tytuł> Tool:” nad opisem narzędzia w dialogu MCP; grupa 1 = nagłówek bez „:”',
    // `kontrolny/zgoda-mcp-interakcja-2.1.322.txt`, `measured/zgoda-mcp-argumenty-2.1.322.txt`
    pattern: /^About the (.+ Tool):$/u,
    cli: '2.1.322',
  },
  planExitConfirm: {
    what: 'dialog `ExitPlanMode` BEZ pliku planu („Exit plan mode?")',
    pattern: /Claude wants to exit plan mode/i,
    cli: '2.1.293',
  },
  apostrophes: {
    what: 'apostrofy typograficzne w etykietach opcji (`don’t ask again`)',
    pattern: /[‘’ʼ′´]/g,
    cli: '2.1.246',
  },
  previewNotes: {
    what: 'marker wariantu `preview` w stopce formularza',
    pattern: 'n to add notes',
    cli: null,
  },
  notesEditing: {
    what: 'stopka trybu edycji notatki (cyfra wpisałaby się jako TEKST)',
    pattern: 'ctrl+g',
    cli: null,
  },
  optionCheckbox: {
    what: 'checkbox na początku etykiety (`1. [✔] Posypka`) — dowód formularza wielokrotnego',
    pattern: /^(?:\[([ xX✓✔])\]|([☐☑☒]))\s*(.*)$/,
    cli: null,
  },
  formChrome: {
    what: 'linie chrome’u formularza, które nigdy nie są opisem opcji',
    pattern:
      /^submit$|^next$|^notes:|to navigate|to cancel|to select|to toggle|to confirm|to add notes|to amend|to explain|ctrl\+|shift\+tab/i,
    cli: null,
  },
  formSubmitRow: {
    what: 'pozycja „Submit"/„Next" pod listą opcji — drugi dowód wielokrotności',
    pattern: /^(submit|next)$/i,
    cli: null,
  },
  questionHeader: {
    what: 'zakładka pytania w pasku formularza (`☐ Architektura`)',
    pattern: /^[☐☑☒]\s*([^☐☑☒]+)/,
    cli: null,
  },
  tabGlyph: {
    what: 'glif zakładki — liczony, żeby poznać pasek WIELOZAKŁADKOWY',
    pattern: /[☐☑☒]/,
    cli: null,
  },
  tabBarStart: {
    what: 'strzałka przewijania paska zakładek na początku linii',
    pattern: /^[←‹⟨]\s*/,
    cli: null,
  },
  tabBarEnd: {
    what: 'strzałka przewijania paska zakładek na końcu linii',
    pattern: /\s*[→›⟩]$/,
    cli: null,
  },
  tabBarSubmit: {
    what: 'przycisk „✔ Submit" w ogonie paska zakładek',
    pattern: /\s*[✔✓]\s*Submit\s*$/i,
    cli: null,
  },
  reviewHeader: {
    what: 'nagłówek ekranu przeglądu odpowiedzi formularza',
    pattern: /^review your answers$/i,
    cli: null,
  },
  reviewSubmit: {
    what: 'opcja, którą ekran przeglądu wysyła zebrane odpowiedzi',
    pattern: /^submit answers$/i,
    cli: null,
  },
  reviewQuestion: {
    what: 'pytanie na liście ekranu przeglądu odpowiedzi (`● treść`) — para dla karty',
    pattern: /^●\s*/,
    cli: '2.1.257',
  },
  reviewAnswer: {
    what: 'odpowiedź pod pytaniem na ekranie przeglądu (`→ wartość`) — para dla karty',
    pattern: /^→\s*/,
    cli: '2.1.257',
  },
  optionBoxGlyph: {
    what: 'znak ramki W ŚRODKU linii opcji — granica etykiety w układzie side-by-side',
    pattern: /[│┃║┌┐└┘├┤╭╮╰╯─═━]/,
    cli: '2.1.246',
  },
  escalationContent: {
    what: 'marker eskalacji uprawnień w TREŚCI dialogu — te nigdy nie są `confirm`',
    pattern: /trust|bypass permission|dangerously|don'?t ask again|always allow|allow all|auto-?accept|skip permission/i,
    cli: null,
  },
  cdAdvisory: {
    what: 'ostrzeżenie CLI o `cd` przed gitem w zgodzie Bash — informacja, nie eskalacja',
    pattern: /This\s+command\s+changes\s+directory\s+before\s+running\s+git,\s+which\s+can\s+execute\s+untrusted\s+hooks\s+from\s+the\s+target\s+directory\.\s+Approve\s+only\s+if\s+you\s+trust\s+it\./,
    cli: '2.1.265',
  },
  deescalationOption: {
    what: 'wyjście z planu do trybu, który PYTA o każde narzędzie — nie eskalacja',
    pattern: /switch to default \(ask each time\)(?: for this session)?/i,
    cli: '2.1.293',
  },
  escalationOption: {
    what: 'marker eskalacji w ETYKIECIE opcji — jedyny słownik dla `optionEscalates`',
    // „allow reading from” (CLI 2.1.294–2.1.296): „Yes, allow reading from <katalog> from this
    // project” przy komendzie spod reguły `ask`. Marker stoi w PIERWSZEJ linii etykiety, bo w wąskim panelu
    // jej koniec („…from this project”) nakłada się na linię następnej opcji.
    pattern: /trust|bypass permission|dangerously|don'?t ask(?: me)? again|always|allow all|allow reading from|auto-?accept|auto mode|skip permission|this session|rest of|yes, and allow\b/i,
    cli: null,
  },
  readGrantMarker: {
    what: 'opcja trwałej zgody na ODCZYT katalogu — rodzina etykiet „Yes, allow reading from …”',
    pattern: /\ballow reading from\b/i,
    cli: '2.1.296',
  },
  readGrantComplete: {
    what: 'PEŁNA etykieta zgody na odczyt (z zakresem na końcu) — warunek przycisku „zawsze” dla tej rodziny',
    pattern: /^yes, allow reading from .+ (?:from this project|during this session)$/i,
    cli: '2.1.296',
  },
  multiSelectSpaceFooter: {
    what: 'starsza stopka formularza wielokrotnego (`space to toggle`) — trzecia sygnatura wielokrotności',
    pattern: 'space to',
    cli: null,
    noFixture: 'dzisiejsze CLI tej stopki nie rysuje; sygnatura została dla starszych wersji',
  },
  modeFooterBypass: {
    what: 'stopka trybu `bypass permissions`',
    pattern: 'bypass permissions on',
    cli: '2.1.240',
    noFixture: 'panel z otwartym dialogiem nie rysuje stopki trybu; zmierzony zrzut mamy tylko dla `auto`',
  },
  modeFooterAuto: {
    what: 'stopka trybu `auto`',
    pattern: 'auto mode on',
    cli: '2.1.240',
  },
  modeFooterAcceptEdits: {
    what: 'stopka trybu `accept edits` (kontrakt nie ma dla niego wariantu — mapujemy na `auto`)',
    pattern: 'accept edits on',
    cli: '2.1.240',
    noFixture: 'cały słownik stopek zmierzono jednym cyklem `shift+tab`, ale zrzut zapisano tylko dla `auto`',
  },
  modeFooterPlan: {
    what: 'stopka trybu planu',
    pattern: 'plan mode on',
    cli: '2.1.240',
    noFixture: 'jak `modeFooterBypass` — zmierzone w cyklu `shift+tab`, bez zapisanego zrzutu',
  },
  modeFooterManual: {
    what: 'stopka trybu ręcznego',
    pattern: 'manual mode on',
    cli: '2.1.240',
    noFixture: 'jak `modeFooterBypass` — zmierzone w cyklu `shift+tab`, bez zapisanego zrzutu',
  },
  knownDialogTrust: {
    what: 'zdanie dialogu zaufania katalogu w TREŚCI bloku (od górnej kreski do opcji), nie na całym ekranie',
    pattern: /Do you trust the files in this folder\?|Is this a project you created or one you trust\?/i,
    // Żywy zrzut (`dialog-trust-2.1.293.txt`) potwierdza zdanie, ale opcje stoją tam BEZ
    // numerów — sygnatura trafia, a karta z cyfrą i tak nie powstaje.
    cli: '2.1.293',
  },
  knownDialogTrustTitle: {
    what: 'tytuł bloku dialogu zaufania katalogu („Accessing workspace:”)',
    pattern: /^Accessing workspace:$/,
    cli: '2.1.293',
  },
  trustArrowNoOption: {
    what: 'opcja odmowy dialogu zaufania bez cyfr, etykieta bez znacznika `❯`',
    // `kontrolny/zaufanie-2.1.319.txt`
    pattern: /^No, exit$/,
    cli: '2.1.319',
  },
  trustArrowYesOption: {
    what: 'opcja zgody dialogu zaufania bez cyfr (też starsze „Yes, proceed”), etykieta bez `❯`',
    // `kontrolny/zaufanie-po-down-2.1.319.txt`
    pattern: /^(?:Yes, I trust this folder|Yes, proceed)$/,
    cli: '2.1.319',
  },
  trustArrowOptionLine: {
    what: 'opcja dialogu zaufania bez cyfr: margines, kolumna kursora (`❯` albo spacja), spacja, etykieta',
    // `kontrolny/zaufanie-2.1.319.txt`, `kontrolny/zaufanie-po-down-2.1.319.txt`; to samo wcięcie na 2.1.293–2.1.316.
    // `down` przenosi `❯` z „No” na „Yes”.
    pattern: /^ ([❯ ]) (\S.*)$/,
    cli: '2.1.319',
  },
  trustArrowCursorMark: {
    what: 'znak kursora `❯` w linii bloku dialogu zaufania bez cyfr; poza parą opcji go nie ma',
    // `kontrolny/zaufanie-2.1.319.txt`
    pattern: /❯/,
    cli: '2.1.319',
  },
  trustArrowContentLine: {
    what: 'treść bloku dialogu zaufania bez cyfr (tytuł, folder, zdania): margines jednej spacji i tekst',
    // `kontrolny/zaufanie-2.1.319.txt`; ten sam margines na 2.1.293, 2.1.311, 2.1.314 i 2.1.316. Opcja ma po nim
    // jeszcze kolumnę kursora (`trustArrowOptionLine`).
    pattern: /^ (\S.*)$/,
    cli: '2.1.319',
  },
  trustArrowWarningOpen: {
    what: 'start of the pre-approved permissions warning in the trust dialog block, without the margin',
    // `dialog-trust-preapproved-2.1.332.txt`. The count and the settings file names vary with the folder, and a
    // narrow pane wraps the line, so the pattern takes the start only.
    pattern: /^⚠ This folder pre-approves /,
    cli: '2.1.332',
  },
  trustArrowWarningClose: {
    what: 'sentence that ends the pre-approved permissions warning in the trust dialog block, without the margin',
    // `dialog-trust-preapproved-2.1.332.txt`
    pattern: /^These will apply without asking\./,
    cli: '2.1.332',
  },
  trustArrowWarningListLine: {
    what: 'permission list line of the warning: a three-space margin, the same shape as an option line without `❯`',
    // `dialog-trust-preapproved-2.1.332.txt`: the first list line has this margin, a wrapped rest has one space.
    pattern: /^ {3}(\S.*)$/,
    cli: '2.1.332',
  },
  trustArrowFooter: {
    what: 'stopka dialogu zaufania bez cyfr — ostatnia linia bloku',
    // `kontrolny/zaufanie-2.1.319.txt`
    pattern: /^Enter to confirm · Esc to cancel$/,
    cli: '2.1.319',
  },
  /*
   * Start dialog about external imports: it stands before the prompt field when a memory file of the project (or its
   * `.claude/rules`) imports a file outside the project, and herdr reads it as `idle` (its blocked rules look for
   * "esc to cancel"). Captures `kontrolny/importy-zewnetrzne-*-2.1.332.txt` at 139 columns.
   */
  startDialogImportsTitle: {
    what: 'title line of the external imports start dialog, the first line under the bare rule of its block',
    // `kontrolny/importy-zewnetrzne-2.1.332.txt`
    pattern: /^Allow external CLAUDE\.md file imports\?$/,
    cli: '2.1.332',
  },
  startDialogImportsNoOption: {
    what: 'decline option of the external imports start dialog (no digit), the label without the cursor column',
    // `kontrolny/importy-zewnetrzne-2.1.332.txt` (cursor on it), `kontrolny/importy-zewnetrzne-po-down-2.1.332.txt`
    pattern: /^No, disable external imports$/,
    cli: '2.1.332',
  },
  startDialogImportsYesOption: {
    what: 'allow option of the external imports start dialog (no digit), the label without the cursor column',
    // `kontrolny/importy-zewnetrzne-po-down-2.1.332.txt` (cursor on it after `down`)
    pattern: /^Yes, allow external imports$/,
    cli: '2.1.332',
  },
  startDialogImportsOptionLine: {
    what: 'option line of the external imports start dialog: two-space margin, cursor column (`❯` or a space), a '
      + 'space, the label',
    // `kontrolny/importy-zewnetrzne-2.1.332.txt`, `kontrolny/importy-zewnetrzne-po-down-2.1.332.txt`
    pattern: /^ {2}(?:(❯)| ) (\S.*)$/,
    cli: '2.1.332',
  },
  startDialogImportsFooter: {
    what: 'key footer of the external imports start dialog, the last line of the screen',
    // `kontrolny/importy-zewnetrzne-2.1.332.txt`, also under the cut top of `…-dluga-lista-2.1.332.txt`
    pattern: /^Enter to confirm · Esc to disable$/,
    cli: '2.1.332',
  },
  knownDialogModel: {
    what: 'tytuł bloku dialogu zmiany modelu („Switch model?”), nie zdanie gdziekolwiek na ekranie',
    pattern: /^Switch model\?$/,
    cli: '2.1.241',
  },
  commandInlineResult: {
    what: 'wynik `/model` wypisany W MIEJSCU, bez dialogu („⎿  Set model to Fable 5.1 and saved as your default…")',
    pattern: /^\s*⎿\s+Set model to\b/,
    cli: '2.1.258',
  },
  commandEcho: {
    what: 'echo komendy `/model` w kolumnie 0 (`❯ /model …`); wiersz wyniku liczy się tylko tuż pod nim',
    pattern: /^❯ \/model\b/,
    cli: '2.1.258',
  },
  /*
   * Komendy ultracode wypisują wynik w miejscu, bez dialogu (zrzuty `ultracode/wynik-effort-ultracode-*`).
   * Rejestr niesie KSZTAŁT (echo `/effort` i wiersz `⎿` pod nim); słowa wyniku i odmowy czyta `herdr/ultracode.ts`.
   */
  ultracodeEcho: {
    what: '`/effort` command echo in column 0 (`❯ /effort <value>`); the ultracode and level results count only under '
      + 'the last one',
    pattern: /^❯ (\/effort\b.*)$/,
    cli: '2.1.317',
  },
  ultracodeInlineResult: {
    what: 'wiersz wyniku komendy w miejscu, pierwszy niepusty pod echem (`⎿  <wynik>`), z treścią wyniku w grupie',
    pattern: /^\s*⎿\s+(\S.*)$/,
    cli: '2.1.317',
  },
  // `kontrolny/potwierdzenie-model-opus-2.1.319.txt`; only the prefix, the ending is not measured for every level.
  effortInlineResult: {
    what: '`/effort <level>` result printed in place, without a dialog ("⎿  Set effort level to low (saved as…)"), '
      + 'the level in the group',
    pattern: /^\s*⎿\s+Set effort level to ([a-z]+)\b/,
    cli: '2.1.319',
  },
  consentDialogAutoMode: {
    what: 'nagłówek dialogu zgody CLI „Teach auto mode about your environment?" (skan sesji, historii powłoki, repozytoriów) — herdr widzi przy nim `idle`',
    pattern: /^\s*Teach auto mode about your environment\?$/m,
    cli: '2.1.258',
  },
  confirmStatement: {
    what: 'nagłówek potwierdzenia CLI BEZ pytajnika (`--resume` starej sesji: „This session is … old and … tokens.")',
    pattern: /^This session is .+ old and .+ tokens\.$/m,
    cli: '2.1.258',
  },
  /*
   * Dialogi CLI z listy `TERMINAL_DIALOGS` (`policy/terminal.ts`): tytuł w pierwszej linii dialogu i KOMPLET opcji.
   * Dopasowanie daje dzisiejszą kartę z treścią i opcjami bez przycisku; przyciski daje tylko karta warstwy 2 dla
   * wpisu z pomiarem klawiszy (`keysMeasured`). Zrzuty: `dialog-session-paused-2.1.309.txt`
   * (odmowa) i `dialog-background-work-exit-2.1.309.txt` (odmowa; wersji
   * CLI tamten zrzut nie zapisał, więc `cli` sygnatur wyjścia to wersja z rekonstrukcji, nie pomiar).
   */
  sessionPausedTitle: {
    what: 'tytuł pauzy CLI „Session paused" — każdy wariant, także z innym kompletem opcji; Esc na nim to odmowa Raroga',
    pattern: /^Session paused$/,
    cli: '2.1.309',
  },
  sessionPausedSwitchOption: {
    what: 'opcja pauzy po fladze zabezpieczeń: „Switch to <model>" (zmiana modelu sesji)',
    pattern: /^Switch to \S/,
    cli: '2.1.309',
  },
  sessionPausedRetryOption: {
    what: 'opcja pauzy po fladze zabezpieczeń: „Edit prompt and retry with <model>" — odróżnia ją od pauzy z innym kompletem opcji',
    pattern: /^Edit prompt and retry with \S/,
    cli: '2.1.309',
  },
  backgroundWorkTitle: {
    what: 'tytuł dialogu wyjścia z sesji przy zadaniach w tle („Background work is running")',
    pattern: /^Background work is running$/,
    cli: '2.1.309',
  },
  backgroundWorkExitOption: {
    what: 'opcja wyjścia przy zadaniach w tle: „Exit and stop tasks" (zatrzymuje zadania)',
    pattern: /^Exit and stop tasks$/,
    cli: '2.1.309',
  },
  backgroundWorkDetachOption: {
    what: 'opcja wyjścia przy zadaniach w tle: „Move to background and exit"',
    pattern: /^Move to background and exit$/,
    cli: '2.1.309',
  },
  backgroundWorkStayOption: {
    what: 'opcja wyjścia przy zadaniach w tle: „Stay" (to samo co Esc ze stopki „Esc to cancel")',
    pattern: /^Stay$/,
    cli: '2.1.309',
  },
  backgroundWorkListHeader: {
    what: 'line above the task list of the exit dialog; one task per line follows it up to the first option',
    pattern: /^The following will stop when you exit:$/,
    cli: '2.1.322',
  },
  /*
   * Chrome formularza `AskUserQuestion`: dwie pozycje, które CLI dokłada pod opcjami autora.
   * Rozpoznaje je `optionRole` (`herdr/dialogs/cards/roles.ts`) i oddaje klientowi jako ROLĘ opcji.
   * Dopasowanie do ETYKIETY po kanonizacji, nie do linii.
   */
  customAnswerOption: {
    what: 'pozycja „Type something." pod opcjami formularza — cyfra otwiera pole wolnej odpowiedzi w TUI',
    pattern: /^type something\.?$/i,
    cli: '2.1.285',
  },
  chatAboutOption: {
    what: 'pozycja „Chat about this" pod kreską formularza — WYJŚCIE z formularza do rozmowy, nie odpowiedź',
    pattern: /^chat about this\.?$/i,
    cli: '2.1.285',
  },
  /*
   * OPERACJA dialogu zgody (`operation.ts`) — treść, którą człowiek zatwierdza:
   * komenda `Bash`, diff `Edit`, treść `Write`. Od CLI 2.1.286 stoi w ramce z przerywanych kresek
   * pod nagłówkiem dialogu; wieloliniowa dostaje lewy pasek `│`. Długa komenda w wąskim panelu
   * wypycha nagłówek i początek ramki nad krawędź ekranu (zrzut `measured/zgoda-bash-wysoka`).
   */
  dialogTopRule: {
    what: 'górna, ciągła kreska dialogu (`────`) — nad nią jest już scrollback',
    pattern: /^─{8,}$/,
    cli: '2.1.293',
  },
  blockRule: {
    what: 'kreska BLOKU dialogu (para „kreska + tytuł”): ciągła `────` albo `▔▔▔▔` nad potwierdzeniem ustawień CLI; '
      + 'czyta ją wyłącznie `blockTopOf` (`screen/region.ts`)',
    pattern: /^(?:─{8,}|▔{8,})$/,
    cli: '2.1.309',
  },
  blockRuleWithStatus: {
    what: 'kreska `▔▔▔▔` ze statusem sesji przed końcem („▔▔▔ ◐ medium · /effort ▔”) — góra widoku slash-komendy; '
      + 'czyta ją wyłącznie `blockTopOf` (`screen/region.ts`) dla wycinka bloku na kartę bez przycisków '
      + '(`screen/excerpt.ts`), bloku warstwy 2 (`layer2/read-block.ts`) i góry odcisku bloku (`screen/parse.ts`)',
    // `refusals/widok-help-2.1.310.txt`, `refusals/widok-status-stechly-zrzut-2.1.310.txt`,
    // `measured/exitplanmode-2.1.278.txt` (osobna linia nad kreską dialogu planu)
    pattern: /^▔{8,} [^▔]+ ▔+$/,
    cli: '2.1.310',
  },
  operationRule: {
    what: 'przerywana kreska ramki operacji (`╌╌╌`) nad i pod komendą, diffem, treścią pliku',
    pattern: /^╌{8,}$/,
    cli: '2.1.293',
  },
  operationBar: {
    what: 'lewy pasek wieloliniowej operacji w ramce (` │ komenda`)',
    pattern: /^ ?│ ?/,
    cli: '2.1.295',
  },
  editDiffLine: {
    what: 'linia diffu w ramce dialogu `Edit` (bez marginesu): numer, spacja, znacznik (` `, `+`, `-`), treść; pusta linia pliku to sam numer',
    // `measured/zgoda-edit-2.1.293.txt` (` 1 -stara wartosc`). A continuation row of a long line has a blank number
    // field and the same marker (CLI 2.1.317, `kontrolny/zgoda-edit-wrap-…-2.1.330.txt`): the blank field marks it,
    // not this pattern, and it joins its line under `FILE_FRAME_GEOMETRY`.
    pattern: /^(\s*\d+)(?: ([ +-])(.*))?$/u,
    cli: '2.1.317',
  },
  writeContentLine: {
    what: 'linia treści nowego pliku w ramce dialogu `Write` „Create file” (bez marginesu): numer, spacja, treść, bez '
      + 'znacznika diffu; pusta linia pliku to sam numer',
    // `measured/zgoda-write-2.1.322.txt` (`  1 pomiar`). A continuation row of a long line has a blank number field
    // (`measured/zgoda-write-dluga-linia-2.1.322.txt`, `kontrolny/zgoda-write-wrap-…-2.1.330.txt`): the blank field
    // marks it, not this pattern, and it joins its line under `FILE_FRAME_GEOMETRY`.
    pattern: /^(\s*\d+)(?: (.*))?$/u,
    cli: '2.1.322',
  },
  autoDenyCountdown: {
    what: 'licznik automatycznej odmowy dialogu w sesji bez obsługi — tyka co sekundę, nie jest treścią dialogu; '
      + 'brzmienie 2.1.294 „deny … blocking progress on”, brzmienie 2.1.316 „block … holding up”',
    pattern: /⚠\s+Claude\s+Code\s+will\s+automatically\s+(?:deny\s+this\s+request\s+in\s+\d+:\d{2},?\s+to\s+avoid\s+blocking\s+progress\s+on|block\s+this\s+request\s+in\s+\d+:\d{2},?\s+to\s+avoid\s+holding\s+up)\s+an\s+unattended\s+session\.?/u,
    cli: '2.1.316',
  },
  queueCounter: {
    what: 'licznik kolejki dialogów zgody na końcu linii tytułu bloku („… 1 of 2”); przy N prośbach w kolejce na '
      + 'wierzchu stoi „k of N”, a po rozstrzygnięciu prośby niewidocznej ta sama prośba na wierzchu ma „2 of 2”',
    // licznik zmierzony na CLI 2.1.302; zrzut kolejki: `dialog-bash-kolejka-licznik-2.1.319.txt`
    pattern: /\s(\d{1,2}) of (\d{1,2})$/,
    cli: '2.1.302',
  },
  /*
   * Literały wyglądu, które stały wcześniej w kodzie modułów. `cli` to pomiar z fixture'u podanego
   * przy wpisie: wzorzec bywa starszy niż ten pomiar, ale tam jego kształt jest zapisany.
   */
  questionSelectFooter: {
    what: 'stopka formularza `AskUserQuestion` („Enter to select”) — razem ze stopką nawigacji daje rodzaj `question`',
    // `dialog-askuserquestion-linia-nazwy-2.1.281.txt`
    pattern: 'enter to select',
    cli: '2.1.281',
  },
  proceedQuestion: {
    what: 'linia pytania zgody („Do you want to proceed?”) wycinana z treści karty — porównanie znak w znak',
    // `dialog-bash-opis-telefon-2.1.302.txt`
    pattern: 'Do you want to proceed?',
    cli: '2.1.302',
  },
  /*
   * The question zone of a `Bash` dialog: the lines the CLI draws between the bottom rule of the operation frame and
   * the question "Do you want to proceed?". A CLOSED list, read only by the top proof of the consent channel
   * (`screen/bash-zone.ts`): the top of a `Bash` queue with a counter gets an identity only for a zone made of these
   * lines alone (plus the auto-deny countdown `autoDenyCountdown`). Each entry has a `Bash` dialog fixture; a line
   * without a fixture does not join the list. Free-text patterns have `\s+` between words and the `m` flag: a logical
   * line is sometimes wrapped over several screen lines (two on CLI 2.1.302, 2.1.309, 2.1.311; four barred lines on
   * 2.1.328), and the registry also looks for it in the whole screen without the bars.
   */
  bashZoneCalloutBar: {
    what: 'pasek objaśnienia na początku linii strefy pytania `Bash` (`│ Permission rule…`, `│ command.`)',
    // `measured/zgoda-bash-komenda-z-kreska-2.1.311.txt`; też `dialog-bash-subagent-uciety-62x29-2.1.309.txt`
    pattern: /^│ /u,
    cli: '2.1.311',
  },
  bashZoneAskRule: {
    what: 'linia reguły `ask` dla `Bash` w strefie pytania („Ask rule Bash(…) overrides auto mode for this command.”)',
    // `dialog-bash-ask-rule-2.1.295.txt`; zawinięta: `dialog-bash-opis-telefon-2.1.302.txt`, z paskiem
    // `dialog-bash-subagent-uciety-62x29-2.1.309.txt`
    pattern: /^Ask\s+rule\s+Bash\(.+\)\s+overrides\s+auto\s+mode\s+for\s+this\s+command\.$/mu,
    cli: '2.1.295',
  },
  bashZoneAskRuleHint: {
    what: 'podpowiedź pod linią reguły `ask` w strefie pytania `Bash` („/permissions to let auto mode decide”)',
    // `dialog-bash-ask-rule-2.1.295.txt`
    pattern: '/permissions to let auto mode decide',
    cli: '2.1.295',
  },
  bashZonePermissionRule: {
    what: 'linia reguły uprawnień `Bash` w strefie pytania, goła albo z regułą w nawiasie („Permission rule '
      + 'Bash(…) requires confirmation for this command.”)',
    // Goła reguła `Bash`: 2.1.311 `measured/zgoda-bash-komenda-z-kreska-2.1.311.txt` (zawinięta, z paskiem
    // objaśnienia), 2.1.321 `kontrolny/zgoda-bash-regula-bash-2.1.321.txt`. Reguła `ask` z ustawień użytkownika
    // w nawiasie („Permission rule Bash(git branch -D *) requires…”, tryb `default`): 2.1.321
    // `kontrolny/zgoda-bash-cytat-default-regula-2.1.321.txt`. Pusty nawias nie przechodzi, jak w `bashZoneAskRule`.
    pattern: /^Permission\s+rule\s+Bash(?:\(.+\))?\s+requires\s+confirmation\s+for\s+this\s+command\.$/mu,
    cli: '2.1.321',
  },
  bashZonePermissionsHint: {
    what: 'podpowiedź pod linią reguły uprawnień w strefie pytania `Bash` („/permissions to update rules”)',
    // `measured/zgoda-bash-komenda-z-kreska-2.1.311.txt`
    pattern: '/permissions to update rules',
    cli: '2.1.311',
  },
  bashZoneParserSkipped: {
    what: 'ostrzeżenie parsera komendy w strefie pytania `Bash` („Parser skipped input between top-level statements”)',
    // `dialog-bash-ask-rule-2.1.295.txt`
    pattern: 'Parser skipped input between top-level statements',
    cli: '2.1.295',
  },
  bashZoneBraceQuote: {
    what: 'ostrzeżenie parsera komendy w strefie pytania `Bash` („Contains brace with quote character…”)',
    // `dialog-bash-stechly-read-2.1.295.txt`
    pattern: 'Contains brace with quote character (expansion obfuscation)',
    cli: '2.1.295',
  },
  bashZoneTildeAssignment: {
    what: 'ostrzeżenie parsera komendy w strefie pytania `Bash` („Tilde in assignment value…”)',
    // `dialog-bash-stechly-read-szeroki-2.1.295.txt`
    pattern: 'Tilde in assignment value — bash may expand at assignment time',
    cli: '2.1.295',
  },
  bashZoneVariableUnchecked: {
    what: 'ostrzeżenie parsera komendy w strefie pytania `Bash` („A variable in this command can’t be checked…”)',
    // `dialog-bash-subagent-telefon-2.1.302.txt`
    pattern: "A variable in this command can't be checked before it runs",
    cli: '2.1.302',
  },
  bashZoneQuotedUnchecked: {
    what: 'ostrzeżenie parsera komendy w strefie pytania `Bash` („Quoted text in this command can’t be checked…”)',
    // `dialog-bash-cytat-2.1.321.txt` (komenda z `"$(…)"`, nad linią reguły `ask`)
    pattern: "Quoted text in this command can't be checked before it runs",
    cli: '2.1.321',
  },
  bashZoneShellScriptRm: {
    what: 'ostrzeżenie kontroli komendy w strefie pytania `Bash` („This shell -c script runs rm…”)',
    // `dialog-bash-uciety-naglowek-2.1.294.txt`
    pattern: 'This shell -c script runs rm and could not be checked',
    cli: '2.1.294',
  },
  bashZoneDangerousRm: {
    what: 'ostrzeżenie kontroli komendy w strefie pytania `Bash` trybu `auto` („Dangerous rm operation not ruled out…”)',
    // `dialog-bash-licznik-block-2.1.316.txt` (z paskiem objaśnienia)
    pattern: 'Dangerous rm operation not ruled out — the shell may read this command differently than it was parsed',
    cli: '2.1.316',
  },
  bashZoneShellExpansion: {
    what: 'ostrzeżenie kontroli komendy w strefie pytania `Bash` („Shell expansion syntax in paths requires manual '
      + 'approval”)',
    // `measured/zgoda-bash-wysoka-2.1.295.txt`, `measured/zgoda-bash-wysoka.txt`
    pattern: 'Shell expansion syntax in paths requires manual approval',
    cli: '2.1.295',
  },
  bashZoneApprovalRequired: {
    what: 'linia strefy pytania `Bash` trybu `default` bez reguły `ask` („This command requires approval”)',
    // `kontrolny/zgoda-bash-shell-c-rm-2.1.321.txt` (krótki `bash -c` z `rm`); ten sam napis na 2.1.321 i 2.1.322
    // pod komendą `perl -e 'sleep 120' && echo … > plik` (pomiar bez fixture'u)
    pattern: 'This command requires approval',
    cli: '2.1.321',
  },
  /*
   * Rule and removal lines as CLI 2.1.328 words them. The older wording (`bashZoneAskRule`,
   * `bashZonePermissionRule`, `bashZoneDangerousRm`) stays on the list for older CLIs. The rule's source after
   * `from` is a closed list of measured phrases, each with a capture: `command line arguments` (`--settings`),
   * `user settings` (the user's `settings.json`), `shared project settings` (the project's `.claude/settings.json`)
   * and `project local settings` (the project's `.claude/settings.local.json`). Managed (policy) settings were not
   * measured, so their phrase is not listed.
   */
  bashZoneRuleOverridesAuto: {
    what: 'question zone line of a `Bash` `ask` rule in `auto` mode with the rule in parentheses and its source '
      + '("Rule Bash(…) from user settings overrides auto mode.")',
    // `--settings`: `kontrolny/zgoda-bash-cytat-auto-2.1.328.txt`, `kontrolny/zgoda-bash-tilde-2.1.328.txt`; user,
    // project and local settings: `kontrolny/zgoda-bash-cytat-auto-{user,project,local}-2.1.328.txt`. An empty
    // parenthesis does not pass, as in `bashZoneAskRule`.
    pattern: /^Rule\s+Bash\(.+\)\s+from\s+(?:command\s+line\s+arguments|user\s+settings|shared\s+project\s+settings|project\s+local\s+settings)\s+overrides\s+auto\s+mode\.$/mu,
    cli: '2.1.328',
  },
  bashZoneRuleSaysAsk: {
    what: 'question zone line of a `Bash` `ask` rule in `default` mode, bare or with the rule in parentheses, and '
      + 'its source ("Rule Bash(…) from user settings says to ask.")',
    // `--settings`: bare `kontrolny/zgoda-bash-regula-bash-2.1.328.txt`, in parentheses
    // `kontrolny/zgoda-bash-cytat-default-regula-2.1.328.txt`; user, project and local settings (in parentheses):
    // `kontrolny/zgoda-bash-cytat-default-regula-{user,project,local}-2.1.328.txt`. An empty parenthesis does not
    // pass.
    pattern: /^Rule\s+Bash(?:\(.+\))?\s+from\s+(?:command\s+line\s+arguments|user\s+settings|shared\s+project\s+settings|project\s+local\s+settings)\s+says\s+to\s+ask\.$/mu,
    cli: '2.1.328',
  },
  bashZoneDangerousRemoval: {
    what: 'question zone warning of a `Bash` command check, one paragraph of two sentences ("Claude Code can\'t be '
      + 'sure it read this command the way the shell will… Read the command, and don\'t go ahead…")',
    // One paragraph with the callout bar, flowed to the pane width: two lines in 119 columns, the second sentence on
    // its own line (`kontrolny/zgoda-bash-dangerous-rm-2.1.328.txt`), two lines in 99 columns, the second starting
    // mid-sentence (`kontrolny/zgoda-bash-dangerous-rm-sredni-2.1.328.txt`), four lines in 62 and in 57 columns
    // (`kontrolny/zgoda-bash-dangerous-rm-telefon-2.1.328.txt`, `kontrolny/zgoda-bash-dangerous-rm-waski-2.1.328.txt`),
    // joined by the zone's rule for barred runs. Words exact, `\s+` between them as in the other wrapped zone lines.
    pattern: new RegExp(String.raw`^Claude\s+Code\s+can't\s+be\s+sure\s+it\s+read\s+this\s+command\s+the\s+way\s+the\s+`
      + String.raw`shell\s+will,\s+so\s+it\s+can't\s+rule\s+out\s+a\s+dangerous\s+removal\.\s+Read\s+the\s+command,\s+`
      + String.raw`and\s+don't\s+go\s+ahead\s+if\s+you\s+can't\s+tell\s+what\s+it\s+does\.$`, 'mu'),
    cli: '2.1.328',
  },
  /*
   * Ogon dialogu `Edit` i dół odczytu dialogu zgody: czyta je wyłącznie dowód wierzchu kanału zgód
   * (`screen/edit-zone.ts`, `screen/dialog-bottom.ts`). Lista ZAMKNIĘTA jak strefa pytania `Bash`: każdy kształt
   * ma fixture, a kształt bez fixture'u daje dialogowi wierzch bez tożsamości (zgoda przy biurku).
   */
  editZoneQuestion: {
    what: 'pytanie dialogu `Edit` pod ramką diffu („Do you want to make this edit to <nazwa>?”); grupa 1 to nazwa '
      + 'bazowa pliku, linie pytania zawiniętego w wąskim panelu sklejone spacją',
    // `measured/zgoda-edit-2.1.293.txt` (także 2.1.258–2.1.285); pytanie zawinięte na trzy linie bez paska zmierzone
    // na dialogu `NotebookEdit` w 26 kolumnach (`measured/zgoda-notebookedit-waski-2.1.311.txt`)
    pattern: /^Do you want to make this edit to (.+)\?$/u,
    cli: '2.1.293',
  },
  /*
   * Pytanie dialogu `Write` pod ramką treści: jedyne źródło nazwy `Write`, gdy nagłówek („Create file”, „Overwrite
   * file”) jest nad krawędzią ekranu (`screen/write-zone.ts`). Linia `⏺ Write(…)` stoi wtedy też nad krawędzią.
   */
  writeZoneQuestion: {
    what: 'pytanie dialogu `Write` pod ramką treści („Do you want to create <nazwa>?”, „Do you want to overwrite '
      + '<nazwa>?”); grupa 1 to nazwa pliku, linie pytania zawiniętego sklejone spacją',
    // `measured/zgoda-write-dluga-tresc-2.1.322.txt` (nagłówek nad krawędzią), `measured/zgoda-write-2.1.322.txt`,
    // `measured/zgoda-write-nadpisanie-2.1.322.txt`. Pytania `Write` zawiniętego nie zmierzono; sklejanie linii jak
    // w `editZoneQuestion` (pytanie `NotebookEdit` w 26 kolumnach).
    pattern: /^Do you want to (?:create|overwrite) (\S(?:.*\S)?)\?$/u,
    cli: '2.1.322',
  },
  permissionFooter: {
    what: 'stopka dialogu zgody pod opcjami („Esc to cancel · Tab to amend”), znak w znak; w wąskim panelu zawinięta '
      + 'na dwie linie sklejone spacją',
    // `measured/zgoda-bash-2.1.293.txt`; zawinięta: `measured/zgoda-notebookedit-waski-2.1.311.txt`,
    // `measured/zgoda-skill-waski-2.1.311.txt`, `measured/zgoda-websearch-waski-2.1.311.txt`
    pattern: 'Esc to cancel · Tab to amend',
    cli: '2.1.293',
  },
  permissionFooterAgents: {
    what: 'stopka dialogu zgody z podpowiedzią zatrzymania subagentów w tle, znak w znak albo ucięta wielokropkiem '
      + 'na szerokości panelu',
    // `dialog-bash-subagent-naglowek-2.1.302.txt`; ucięta: `dialog-bash-subagent-telefon-2.1.302.txt`,
    // `dialog-bash-subagent-uciety-62x29-2.1.309.txt`
    pattern: 'Esc to cancel · Tab to amend · ctrl+x ctrl+k twice to stop background agents',
    cli: '2.1.302',
  },
  footerTruncation: {
    what: 'wielokropek na końcu stopki dialogu zgody uciętej na szerokości panelu („… twice to stop b…”)',
    // `dialog-bash-subagent-telefon-2.1.302.txt`, `dialog-bash-subagent-uciety-62x29-2.1.309.txt`
    pattern: /…$/u,
    cli: '2.1.302',
  },
  sessionNameEdge: {
    what: 'krawędź z nazwą sesji pod stopką dialogu („──── testy ─”, sesja po `/rename`)',
    // `dialog-bash-licznik-block-2.1.316.txt`; też `dialog-askuserquestion-linia-nazwy-2.1.281.txt`
    pattern: /^─{8,} \S(?:.*\S)? ─$/u,
    cli: '2.1.316',
  },
  subagentTitleSuffix: {
    what: 'sufiks tytułu zgody subagenta (` · from the Explore agent`) — zdejmowany przed mapą tytułów, jako pierwszy',
    // `dialog-permission-cd-advisory-2.1.265.txt` (rekonstrukcja zrzutu ekranu)
    pattern: / · from the .+ agent$/,
    cli: '2.1.265',
  },
  sandboxTitleSuffix: {
    what: 'sufiks tytułu zgody o trybie sandboksa (` (unsandboxed)`) — zdejmowany po sufiksie subagenta',
    // `dialog-permission-unsandboxed.txt`
    pattern: / \((?:un)?sandboxed\)$/,
    cli: '2.1.246',
  },
  knownDialogYesOption: {
    what: 'opcja zatwierdzenia znanego dialogu (`Yes…`: zaufanie katalogu, zmiana modelu) — pierwsza z kompletu opcji',
    // `dialog-model-switch.txt`
    pattern: /^Yes/i,
    cli: '2.1.241',
  },
  knownDialogNoOption: {
    what: 'opcja odmowy znanego dialogu (`No…`: zaufanie katalogu, zmiana modelu) — druga z kompletu opcji',
    // `dialog-model-switch.txt`
    pattern: /^No/i,
    cli: '2.1.241',
  },
  affirmativeOption: {
    what: 'etykieta opcji zgody („Yes”, „Yes, and don’t ask again…”) — kandydat przycisku „Zatwierdź” i „zawsze”',
    // `dialog-model-switch.txt`
    pattern: /^yes\b/i,
    cli: '2.1.241',
  },
  modeSwitchOption: {
    what: 'opcja, która przełącza TRYB uprawnień sesji („switch to auto mode”, „use auto mode”) — nie przycisk „zawsze”',
    // `measured/zgoda-bash-2.1.293.txt`
    pattern: /\b(?:switch to|use)\s+(?:auto mode|accept edits|default|bypass)|bypass permissions/i,
    cli: '2.1.293',
  },
  keyHintLine: {
    what: 'linia podpowiedzi klawiszowej pod opcją („shift+tab to approve…”, „Esc to cancel”) — koniec zawiniętej etykiety',
    // `measured/zgoda-edit-2.1.293.txt`
    pattern: /^(?:submit|next)$|^notes:|^(?:shift\+tab|ctrl\+\S+|esc|enter|tab)\b/i,
    cli: '2.1.293',
  },
  dialogKeyFooter: {
    what: 'stopka klawiszowa pod blokiem dialogu: linia ZACZYNA SIĘ od klawisza („Esc to cancel · Tab to amend”, '
      + '„Enter to select · ↑/↓ to navigate · Esc to cancel”, „←/→ to adjust · Enter to confirm · …” suwaka '
      + '`/effort`) — opis opcji z „ctrl+c to cancel” w środku nią nie jest',
    // `measured/zgoda-bash-2.1.293.txt`, `measured/pytanie-jednokrotne-2.1.293.txt`; początek `←/→` (CLI 2.1.319):
    // `kontrolny/picker-effort-2.1.319.txt`
    pattern: /^(?:esc|enter|tab|shift\+tab|ctrl\+\S+|space|↑\/↓|←\/→)\s+to\b/i,
    cli: '2.1.319',
  },
  /*
   * Warstwa 2 (`layer2/verdict.ts`): reguła nad dosłownym blokiem dialogu, która z linii bloku robi przyciski
   * (cyfra albo klawisz ze stopki). Każdy wzorzec niżej jest warunkiem odmowy albo źródłem klawisza.
   */
  dialogOptionRow: {
    what: 'surowa linia opcji bloku warstwy 2: wcięcie, opcjonalny `❯`, numer z jedną albo dwiema cyframi, kropka, '
      + 'spacja i etykieta; dwie cyfry, żeby „10.” dało odmowę, a nie dziewięć opcji',
    // `kontrolny/potwierdzenie-model-2.1.316.txt`, `dialog-resume-summary-2.1.258.txt`
    pattern: /^ *(?:❯ +)?(\d{1,2})\. (.*)$/u,
    cli: '2.1.316',
  },
  dialogFrameGlyph: {
    what: 'pionowy znak ramki w linii opcji bloku warstwy 2 (`│┃╎╏║`): opcja w ramce nie jest zwykłą opcją',
    // `measured/zgoda-bash-2.1.293.txt` (pasek `│` operacji)
    pattern: /[│┃╎╏║]/u,
    cli: '2.1.293',
  },
  listScrollMarker: {
    what: 'wskaźnik przewinięcia listy opcji: `↓`/`↑` na końcu linii po spacji („routi ↓”) albo na jej początku '
      + 'przed spacją — lista pokazuje część opcji',
    // `measured/picker-model-2.1.312-26kol.txt` (picker `/model` na 26 kolumnach)
    pattern: /(?:^|\s)[↑↓]$|^[↑↓]\s/u,
    cli: '2.1.312',
  },
  optionLabelCut: {
    what: 'wielokropek na końcu etykiety opcji albo jej linii: etykieta ucięta na szerokości kolumny',
    // `measured/picker-model-2.1.312-26kol.txt` („Defau…”: kolumna etykiety ucięta wielokropkiem)
    pattern: /…$/u,
    cli: '2.1.312',
  },
  optionTrailingArrow: {
    what: 'strzałka na końcu etykiety opcji (`→`, `›`): pozycja prowadzi dalej (podmenu), więc nie jest zwykłą '
      + 'odpowiedzią; strzałkę na końcu linii zmierzono tylko w pasku zakładek formularza',
    // `measured/wielopytaniowy-multiselect-2.1.293.txt` („✔ Submit  →”); podmenu niezmierzone, wzorzec tylko odmawia
    pattern: /\s[→›]$/u,
    cli: '2.1.293',
  },
  dialogKeySegment: {
    what: 'segment stopki, który nazywa klawisz dialogu z listy warstwy 2 (Esc, Enter, Tab, `←/→`, `↑/↓`) — '
      + '`shift+tab`, `ctrl+…`, `space` i klawisze literowe przycisku nie dają',
    // `kontrolny/picker-effort-2.1.319.txt`, `measured/picker-effort-2.1.312-26kol.txt` („Tab to toggle”),
    // `measured/pytanie-jednokrotne-2.1.293.txt` („↑/↓ to navigate”)
    pattern: /^(esc|enter|tab|←\/→|↑\/↓)\s+to\b/iu,
    cli: '2.1.319',
  },
  footerSegmentSeparator: {
    what: 'separator segmentów stopki klawiszowej (` · `), także na końcu linii stopki zawiniętej',
    // `kontrolny/picker-effort-2.1.319.txt`, `measured/picker-effort-2.1.312-26kol.txt` („←/→ to adjust ·”)
    pattern: /\s*·\s*/u,
    cli: '2.1.319',
  },
  footerSetsDefault: {
    what: 'stopka bloku z „Enter to set as default”: Enter (i cyfra, która działa jak Enter) zapisuje ustawienie '
      + 'domyślne dla nowych sesji, czego etykieta opcji nie mówi — warstwa 2 odmawia (`sets-default`)',
    // `kontrolny/picker-model-klucz-api-2.1.322.txt` (klucz API); ta sama stopka na koncie z subskrypcją, CLI 2.1.323
    // (pomiar właściciela, cyfra zapisała model domyślny). Bez rozróżniania wielkości liter: wzorzec tylko odmawia.
    pattern: /\benter to set as default\b/iu,
    cli: '2.1.322',
  },
  digitlessFocusLine: {
    what: 'pozycja listy bez cyfr z kursorem (`❯ No`) w bloku dialogu — lista numerowana nad nią to treść, nie opcje',
    // `kontrolny/zatwierdzenie-workflow-auto-bez-kontroli-2.1.322.txt`
    pattern: /^❯\s+(?!\d\.\s)\S/u,
    cli: '2.1.322',
  },
  boxEdgeStartIndented: {
    what: 'lewa krawędź ramki RAZEM z wcięciem przed nią — `unframe` zdejmuje ją, zostawiając wcięcie treści',
    // `dialog-askuserquestion-multiq-pytanie-w-ramce.txt`
    pattern: /^\s*[│┃|]\s?/,
    cli: '2.1.257',
  },
  optionNumber: {
    what: 'numer opcji z kropką (`1.`) w dowolnym miejscu linii — kolumna, od której liczy się wcięcie opisu opcji',
    // `dialog-askuserquestion-multiq-tab1-jednokrotne.txt`
    pattern: /\d\./,
    cli: '2.1.257',
  },
  uncheckedGlyph: {
    what: 'pusty checkbox `☐` przed etykietą — opcja formularza wielokrotnego NIE zaznaczona',
    // `measured/multiselect-2.1.258.txt`
    pattern: '☐',
    cli: '2.1.258',
  },
  operationMargin: {
    what: 'lewy margines jednoliniowej operacji w ramce (` komenda`) — jedna spacja, bez paska `│`',
    // `measured/zgoda-bash-2.1.293.txt`
    pattern: /^ /u,
    cli: '2.1.293',
  },
  /*
   * Pole promptu (composer) — stan pola przed wysyłką i restartem sesji (`server/src/drivers/herdr/commands.ts`).
   * Dopasowanie idzie po linii bez sekwencji SGR (`visibleCells`), w kolumnie 0.
   */
  composerRule: {
    what: 'kreska ramki pola promptu od kolumny 0 (`────…`, bywa z nazwą sesji po `/rename`)',
    // `composer-region-empty-2.1.283.ansi.txt` i pozostałe `composer-region-*-2.1.283.ansi.txt`
    pattern: /^─{4,}/,
    cli: '2.1.283',
  },
  composerRuleHistory: {
    what: 'top rule of the prompt field with a history entry header (`─── History 100/100 ───`; at 26 columns the '
      + 'dashes drop and the header is cut: ` History 100/100 · ↑ 16 mo`)',
    // `queue/measured/zabranie-historia-szeroki-po-up-2.1.328.txt`, `queue/measured/zabranie-historia-po-up-2.1.328.txt`
    pattern: /^─* History \d+\/\d+(?: |$)/,
    cli: '2.1.328',
  },
  composerRuleCut: {
    what: 'top rule of a prompt field taller than the pane: lines above are hidden (`─── ↑ 13 more ───`, or `↑ N` '
      + 'after a history header); a dialog line ` ↑ 54 more lines` has neither dashes nor the header',
    // `queue/measured/zabranie-dlugie-po-up-2.1.328.txt`, `queue/measured/zabranie-historia-po-up-2.1.328.txt`
    pattern: /^(?:─+|─* History \d+\/\d+ ·) ↑ \d+ /,
    cli: '2.1.328',
  },
  composerQueueHint: {
    what: 'dimmed hint in an empty prompt field while the CLI queue holds prompts (`Press up to edit queued messages`, '
      + 'cut to `Press up to edit queued…` at 26 columns)',
    // `queue/measured/zabranie-przed-up-2.1.328.txt`, `queue/measured/zabranie-szeroki-przed-up-2.1.328.txt`
    pattern: /^Press up to edit queue/,
    cli: '2.1.328',
  },
  composerPastePlaceholder: {
    what: 'placeholder of a collapsed paste in the prompt field (`[Pasted text #1 +11 lines]` for 12 lines, wrapped '
      + 'after `+11` at 26 columns); the spaces are optional, so it reads a field without whitespace too',
    // `queue/measured/zabranie-wklejka-szeroki-po-up-2.1.328.txt`, `queue/measured/zabranie-wklejka-po-up-2.1.328.txt`
    pattern: /\[Pasted\s*text\s*#\d+\s*\+(\d+)\s*lines\]/,
    cli: '2.1.328',
  },
  queuedPromptsMarker: {
    what: 'line under the queued prompts above the prompt field (`⎿  Queued · ctrl+enter to send now`, at 26 '
      + 'columns `ctrl+enter to send now`)',
    // `queue/measured/zabranie-przed-up-2.1.328.txt`, `queue/measured/zabranie-szeroki-przed-up-2.1.328.txt`
    pattern: 'ctrl+enter to send now',
    cli: '2.1.328',
  },
  composerPrompt: {
    what: 'znak zachęty pola promptu `❯` w kolumnie 0 — linia, od której zaczyna się treść pola',
    // `composer-empty-2.1.258.ansi.txt`, `composer-ghost-suggestion-2.1.258.ansi.txt`
    pattern: /^❯/,
    cli: '2.1.258',
  },
} as const satisfies Record<string, ScreenSignature>;

/** Nazwa sygnatury z rejestru — klucz w {@link SCREEN_SIGNATURES}. */
export type ScreenSignatureName = keyof typeof SCREEN_SIGNATURES;

/**
 * Geometry of a file frame: the `Edit` diff (`diff`: number, space, marker, content) and the `Write` "Create file"
 * content (`content`: number, space, content). It holds numbers, which a {@link ScreenSignature} pattern cannot, so it
 * stands beside the registry with the same version and fixture fields.
 *
 * C is the width of the frame rule (the pane), d the digits of the largest line number in the frame. After one margin
 * column comes the number field, right-aligned to d + `fieldExtra` columns, then a space (and the diff marker); the
 * content starts at column index d + `contentAfterDigits` in both frames. A file line longer than the content width
 * W = C − `reserve` − d breaks hard after W characters, in the middle of a word too, and every further row has an
 * empty number field and the same marker. The formula alone is not a proof: a frame drawn by another CLI version
 * or terminal layout can be narrower, so the proof also needs a row exactly W wide in the same frame.
 *
 * `wrapChars` is the closed list of characters a wrapped file line may hold: printable ASCII and the six Polish
 * letters the measurement put across the break (`żółćęś`, NFC), all measured at one column with the break where the
 * column count puts it. Other letters (`ą`, `ń`, `ź`, capitals) are unmeasured and not on the list. A no-break space
 * at column W looks like a space there, a wide character with one free cell moves to the next row and leaves an empty
 * cell, a combining mark shares the cell of its letter and a zero-width space shows as U+FFFD, so none of them is on
 * the list.
 */
export const FILE_FRAME_GEOMETRY = {
  what: 'number field, content column and content width of the `Edit` diff and `Write` "Create file" frames',
  cli: '2.1.330',
  fixtures: [
    'kontrolny/zgoda-edit-wrap-geo-57-2.1.330.txt',
    'kontrolny/zgoda-edit-wrap-geo-99-2.1.330.txt',
    'kontrolny/zgoda-edit-wrap-geo-119-2.1.330.txt',
    'kontrolny/zgoda-edit-wrap-line10-57-2.1.330.txt',
    'kontrolny/zgoda-edit-wrap-line10-99-2.1.330.txt',
    'kontrolny/zgoda-edit-wrap-line10-119-2.1.330.txt',
    'kontrolny/zgoda-edit-wrap-line100-57-2.1.330.txt',
    'kontrolny/zgoda-edit-wrap-line100-99-2.1.330.txt',
    'kontrolny/zgoda-edit-wrap-line100-119-2.1.330.txt',
    'kontrolny/zgoda-edit-wrap-claude-md-57-2.1.330.txt',
    'kontrolny/zgoda-write-wrap-geo-57-2.1.330.txt',
    'kontrolny/zgoda-write-wrap-geo-99-2.1.330.txt',
    'kontrolny/zgoda-write-wrap-geo-119-2.1.330.txt',
    'kontrolny/zgoda-write-wrap-line10-57-2.1.330.txt',
    'kontrolny/zgoda-write-wrap-line10-99-2.1.330.txt',
    'kontrolny/zgoda-write-wrap-line10-119-2.1.330.txt',
  ],
  contentAfterDigits: 3,
  diff: { fieldExtra: 0, reserve: 3 },
  content: { fieldExtra: 1, reserve: 4 },
  wrapChars: /^[ -~żółćęś]*$/u,
} as const;
