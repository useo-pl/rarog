/**
 * Cross-check EKRANU z wpisem jsonl albo zrzutem hooka (`resolveOptions`): rodzaj dialogu, nazwa narzędzia
 * z bloku, serwer i tytuł MCP, nagłówek ucięty nad krawędzią panelu. Rozjazd = karta bez przycisków.
 */
import { optionPolicy } from '../policy/option-policy.ts';
import type { TerminalDialogId } from '../policy/terminal.ts';
import { fileCallShown } from './edit-frame.ts';
import type { FileCall } from './edit-frame.ts';
import type { DialogIdentityStamp } from './identity.ts';
import type { ScreenDialogKind } from './kinds.ts';
import type { KnownDialogId } from './known.ts';
import { BASH_TOOL, commandMatches } from './operation.ts';
import type { LabelGuide, ScreenFormOption, ScreenOption } from './options.ts';
import { parseOptions } from './parse.ts';
import type { ScreenDialog } from './parse.ts';
import { isReviewDialog } from './review.ts';
import { parseTrustArrowDialog } from './trust-arrow.ts';
import type { TrustArrowDialog } from './trust-arrow.ts';

/** Nazwa narzędzia MCP w jsonl i w payloadzie hooka: `mcp__<serwer>__<narzędzie>`. */
const MCP_TOOL_NAME_PATTERN = /^mcp__([A-Za-z0-9][A-Za-z0-9._-]{0,63})__(.+)$/;

/**
 * Serwer MCP z nazwy narzędzia (`mcp__catalog__catalog_get_task` → `catalog`); `null` dla
 * każdej innej nazwy. Ta sama nazwa z jsonl/hooka idzie do {@link mcpTitleMatches}.
 */
export function mcpServerOf(toolName: string): string | null {
  return MCP_TOOL_NAME_PATTERN.exec(toolName)?.[1] ?? null;
}

/** Przedrostek serwera łącznika claude.ai w identyfikatorze narzędzia (`mcp__claude_ai_Claude_Docs__guide`). */
const CLAUDE_AI_CONNECTOR_PREFIX = 'claude_ai_';

/**
 * Czy serwer z nagłówka MCP na ekranie ({@link ScreenDialog.mcpServer}) jest serwerem z `mcp__<serwer>__<narzędzie>`?
 *
 * Serwer jednym słowem (`catalog`, `claude-in-chrome`) jest dosłownie serwerem z identyfikatora. Nazwa ze spacją to
 * nazwa łącznika claude.ai (CLI 2.1.322: ekran „Claude Docs”, identyfikator `claude_ai_Claude_Docs`): identyfikator
 * to przedrostek `claude_ai_` i nazwa ze spacjami zamienionymi na `_`. Inny kształt (bez przedrostka, inne słowa,
 * serwer jednym słowem z przedrostkiem) daje `false`, bo tego nie zmierzono.
 */
export function mcpServerMatches(toolName: string, screenServer: string | null): boolean {
  const server = mcpServerOf(toolName);
  if (server === null || screenServer === null) return false;
  if (!screenServer.includes(' ')) return server === screenServer;
  return server === `${CLAUDE_AI_CONNECTOR_PREFIX}${screenServer.replaceAll(' ', '_')}`;
}

/** Słowa nazwy albo tytułu bez wielkości liter, rozdzielone jedną spacją (`get_workspace` → `get workspace`). */
function mcpWords(text: string): string {
  return text.toLowerCase().split(/[\s_-]+/u).filter((word) => word !== '').join(' ');
}

/**
 * Czy tytuł narzędzia MCP z ekranu ({@link ScreenDialog.mcpTool}) jest TYM narzędziem z jsonl/hooka?
 *
 * Nazwa `mcp__<serwer>__<narzędzie>` traci przedrostek `<serwer>_` (serwer `catalog` nazywa narzędzia
 * `catalog_get_task`) i oba teksty idą do słów bez wielkości liter. Tytuł, który nie powtarza nazwy
 * (serwer nadał narzędziu inny tytuł), daje `false`: rozjazd, karta bez przycisków. Sam serwer
 * nie wystarcza: karta `delete_task` przeszłaby nad dialogiem `get_project_tree_layout`.
 */
export function mcpTitleMatches(toolName: string, screenTitle: string | null): boolean {
  const match = MCP_TOOL_NAME_PATTERN.exec(toolName);
  const server = match?.[1];
  const tool = match?.[2];
  if (server === undefined || tool === undefined || screenTitle === null) return false;
  const bare = tool.startsWith(`${server}_`) ? tool.slice(server.length + 1) : tool;
  const words = mcpWords(bare);
  return words !== '' && words === mcpWords(screenTitle);
}

/** Nazwa narzędzia, którego dialog jest FORMULARZEM pytania, a nie zgodą na wykonanie. */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

export interface ExpectedDecision {
  /** Nazwa narzędzia z CZEKAJĄCEGO wpisu jsonl (`PendingTool.toolName`) — jedyne źródło prawdy. */
  toolName: string;
  /**
   * `multiSelect` z payloadu hooka `AskUserQuestion` — AUTORYTATYWNY, gdy zrzut przeszedł
   * cross-check z ekranem (treść pytania + komplet etykiet). Nadpisuje heurystykę parsera
   * w obie strony: `false` przywraca kartę formularzowi, którego glify ekranu wzięły
   * za wielokrotny, `true` odbiera ją formularzowi, którego sygnatury nie złapały.
   *
   * Nieobecne = rozstrzyga ekran. Zrzut BEZ cross-checku nie ma prawa tu trafić — inaczej
   * plik pisany przez proces spoza Raroga decydowałby o tym, czy cyfra wolno wyjść.
   */
  multiSelect?: boolean | undefined;
  /**
   * Etykiety opcji z payloadu `AskUserQuestion` — prowadzą odtworzenie etykiety
   * zawiniętej przez wąski panel. Niczego nie dodają: opcja i jej cyfra dalej pochodzą
   * wyłącznie z ekranu, a sklejenie wchodzi tylko przy PEŁNEJ równości z etykietą.
   */
  labels?: readonly LabelGuide[] | undefined;
  /**
   * Komenda `Bash` czekającego wywołania. Gdy ekran pokazuje ramkę operacji, musi ona
   * pokazywać TĘ komendę ({@link commandMatches}) — sama nazwa nie odróżnia dwóch różnych `Bash`,
   * a karta niesie treść z jsonl/hooka, więc cyfra zatwierdzałaby to, czego karta nie pokazała.
   * Nieobecne = kontroli treści nie ma (inne narzędzie albo input bez komendy).
   */
  command?: string | undefined;
  /**
   * Komendę potwierdzają DWA źródła naraz: wpis jsonl i świeży zrzut `PermissionRequest` mają
   * dosłownie tę samą komendę. Tylko wtedy zgoda bez nazwy na ekranie (nagłówek nad
   * krawędzią panelu) może przejść — sam koniec komendy w ramce nie odróżnia dwóch komend
   * o wspólnym ogonie, a stęchły wpis jsonl to sytuacja zmierzona.
   */
  doubleProof?: boolean | undefined;
  /**
   * Zapis albo edycja pliku czekającego wywołania. Gdy jest, ekran musi dowieść TEGO
   * wywołania ({@link fileCallShown}): ścieżka z nagłówka całego dialogu i treść albo diff w ramce. Sama nazwa nie
   * odróżnia dwóch zapisów: stęchły wpis jsonl pliku A dostawał przyciski nad dialogiem pliku B. Nieobecne = narzędzie
   * bez takiej kontroli.
   */
  fileCall?: FileCall | undefined;
}

export type DecisionResolution =
  /** Ekran i jsonl mówią o tym samym — wolno pokazać przyciski i wysłać cyfrę. */
  | {
    status: 'ok';
    kind: 'tool' | 'question';
    toolName: string;
    /**
     * Opcje z ekranu Z FLAGĄ `terminalOnly` — bramka eskalacji (`docs/dialogs.md`, „Rules: what must not be relaxed”) działa na tej ścieżce tak samo
     * jak na ekranowej (`no-jsonl`): opcja eskalująca uprawnienia jedzie na kartę widoczna,
     * ale bez przycisku, a `answerQuestion` odmawia jej cyfry.
     */
    options: readonly ScreenFormOption[];
    /** Etykieta kanoniczna → cyfra. Brak klucza = brak wysyłki; nigdy domysł po pozycji. */
    digitByLabel: ReadonlyMap<string, string>;
    /** Tryb zatwierdzania z ekranu — `'digit-enter'` tylko dla pytania z preview. */
    submit: 'digit' | 'digit-enter';
    /**
     * Treść pytania z EKRANU dla `kind: 'question'`; `null` dla zgody na narzędzie.
     * Jedzie do `ActiveReq.question` : bez niej weryfikacja przed `enter`
     * na ścieżce jsonl/hooka nie umiałaby dowieść „to samo pytanie", a formularz
     * wielopytaniowy przełącza zakładki bez mignięcia statusu.
     */
    question: string | null;
    /** Odcisk dialogu ({@link ScreenDialog.bodyPrint}): ramka operacji zgody albo blok pytania; jedzie do karty. */
    bodyPrint: string | null;
    /** Rodzaj i tożsamość dialogu z bloku — jadą do `ActiveReq.dialogIdentity`, kontrola przed cyfrą. */
    dialogIdentity: DialogIdentityStamp;
  }
  /** Ekranu nie dało się odczytać — wołającemu wolno ponowić `agent.read` DOKŁADNIE raz. */
  | { status: 'unreadable'; retryable: true; reason: 'no-options' }
  /** Ekran mówi o czym innym niż jsonl — fail-closed OD RAZU, bez ponawiania (to nie jest czas). */
  | {
    status: 'mismatch';
    retryable: false;
    /**
     * `operation`: nazwa się zgadza, ale ramka pokazuje INNĄ komendę niż czekająca, ramka ucięta u góry
     * nie ma podwójnego dowodu, ucięty `Write` (`file-question`) nie pokazuje, który plik zatwierdza, albo ekran nie
     * dowodzi zapisu lub edycji pliku ścieżką i treścią (`ExpectedDecision.fileCall`).
     * `ambiguous`: nad opcjami więcej niż jedna para „kreska + tytuł”, granicy bloku nie da się
     * wskazać — rozjazd bez porównywania nazwy, bo nazwy z takiego bloku nie ma.
     */
    reason: 'kind' | 'tool-name' | 'multi-select' | 'operation' | 'ambiguous';
    screenKind: ScreenDialogKind;
    screenToolName: string | null;
    /**
     * Rozjazd rodzaju, który jest OSTATNIM KROKIEM tego samego formularza: jsonl czeka na
     * `AskUserQuestion`, a na ekranie stoi jego przegląd („Review your answers" + „Submit
     * answers"/„Cancel"). To nie jest cudzy dialog — wołający ma prawo zejść na kartę ekranową
     * (zmierzone na CLI 2.1.273: bez tego ostatni krok formularza wielopytaniowego
     * na kanale `keys` spadałby do „odpowiedz w terminalu"). Tylko przy `reason: 'kind'`.
     */
    reviewStep?: true;
  }
  /**
   * Dialog bez odpowiednika w jsonl.
   *
   * `knownDialog !== null` znaczy „Rarog rozpoznał ten dialog z zamkniętej listy
   * sygnatur" — wolno wtedy wystawić przycisk zatwierdzania i wysłać cyfrę opcji twierdzącej.
   * `null` zostaje przy wycinku ekranu i „Odrzuć (Esc)".
   */
  | {
    status: 'no-jsonl'; retryable: false; knownDialog: KnownDialogId | null;
    /** Rodzaj i tożsamość dialogu z bloku; `null` = ekran bez dialogu. Karta znanego dialogu je niesie. */
    dialogIdentity: DialogIdentityStamp | null;
    /**
     * Odcisk bloku ZNANEGO dialogu ({@link ScreenDialog.bodyPrint}) — karta znanego dialogu niesie go
     * do kontroli tuż przed cyfrą. Nieobecny bez rozpoznania (karta bez przycisków) i bez góry bloku.
     */
    bodyPrint?: string;
    /**
     * Formularz ZBUDOWANY Z EKRANU — jedyne źródło karty pytania i karty potwierdzenia na żywo.
     *
     * Zmierzone (monitor rozmiaru pliku, CLI 2.1.267): Claude Code zapisuje `tool_use` formularza
     * `AskUserQuestion` do jsonl nad STOJĄCYM dialogiem, więc
     * jego brak znaczy „follower jeszcze nie dogonił" albo „sesja nie ma transkryptu" —
     * a nie „nie doczekasz się". Ekran zostaje w obu tych sytuacjach JEDYNYM źródłem karty.
     * To NIE jest „generyczne klikanie w cudze dialogi" (`docs/security-model.md`, „Starting sessions from the phone: three powers”, pkt 14): formularz identyfikuje się
     * zamkniętą sygnaturą stopki Claude Code (`enter to select` + nawigacja), opcje niosą
     * własne cyfry, a odpowiedź idzie po TEKŚCIE etykiety.
     *
     * `kind: 'confirm'` (silnik dialogów) to ta sama karta dla dialogów
     * potwierdzeń CLI rozpoznanych po kształcie (`confirmFrom`) — treść i etykiety jadą
     * DOSŁOWNIE z ekranu, decyzję podejmuje człowiek. Dialog z sygnatury zamkniętej listy
     * (`knownDialog`) ma pierwszeństwo i zostaje przy swojej karcie.
     */
    questionForm: {
      /**
       * `'tool'` (uniwersalna karta) = zgoda na narzędzie zbudowana Z EKRANU —
       * dla dialogu, którego jsonl nie zna (wpis `tool_use` powstaje dopiero PO decyzji,
       * zmierzone na CLI 2.1.246 — ta sama asymetria co przy `AskUserQuestion`).
       * Treść i etykiety jadą dosłownie; opcje eskalujące niosą `terminalOnly`.
       */
      kind: 'question' | 'confirm' | 'tool';
      header: string; question: string; options: readonly ScreenFormOption[];
      /** Dla `kind: 'tool'`: DOSŁOWNA nazwa narzędzia z ekranu — jedzie na kartę i do audytu. */
      toolName?: string | null;
      /**
       * Odcisk dialogu ({@link ScreenDialog.bodyPrint}): dla `kind: 'tool'` treść z ramką operacji, dla pytania
       * i potwierdzenia blok dialogu. `null` = karta bez odcisku.
       */
      bodyPrint?: string | null;
      /**
       * Dla dialogu planu: nazwa pliku planu ze stopki ({@link ScreenDialog.planFile}). Wchodzi do `reqId` karty
       * z ekranu, bo plan A i plan B mają to samo pytanie i te same opcje. Nieobecne = dialog bez tej nazwy.
       */
      planFile?: string;
      /**
       * Dla `kind: 'confirm'`: dialog z listy {@link TERMINAL_DIALOGS} — wszystkie opcje mają wtedy
       * `terminalOnly`, a karta jest kartą bez decyzji (dziennik `degrade`). Nieobecne = zwykłe potwierdzenie.
       */
      terminalDialog?: TerminalDialogId;
      /**
       * Dla `kind: 'question'`: tryb zatwierdzania z ekranu ({@link ScreenDialog.submit}).
       * `'digit-enter'` = wariant z preview — driver po cyfrze weryfikuje podświetlenie
       * i dosyła `enter` osobnym krokiem (`form-submit.ts`).
       */
      submit?: 'digit' | 'digit-enter';
      /** Rodzaj i tożsamość dialogu z bloku — karta z formularza niesie je do kontroli przed cyfrą. */
      dialogIdentity: DialogIdentityStamp;
    } | null;
    /** Opcje z ekranu — WYŁĄCZNIE dla rozpoznanego dialogu; inaczej pusta lista (`docs/security-model.md`, „Starting sessions from the phone: three powers”, pkt 14). */
    options: readonly ScreenOption[];
    /**
     * Dialog zaufania BEZ cyfr ({@link parseTrustArrowDialog}): `knownDialog: 'trust'`, `options: []`
     * (bez fikcyjnych cyfr), a zatwierdzenie idzie osobną ścieżką `down`/`enter` (`send/trust-step.ts`).
     * Nieobecne = każdy inny ekran, także dialog zaufania z cyframi.
     */
    trustArrow?: TrustArrowDialog;
  };

/**
 * Zgoda `Bash`, której nazwy nie widać, bo nagłówek dialogu jest nad krawędzią ekranu.
 *
 * Długa komenda w wąskim panelu (telefon w kliencie SSH) potrafi wypchnąć nagłówek
 * „Bash command" nad górną krawędź, a CLI komendy nie przycina — ramka pokazuje jej koniec.
 * Nazwa przestaje być wtedy do odczytania, ale tożsamość da się dowieść mocniej niż nazwą:
 * - nagłówka faktycznie NIE widać (`headerVisible: false`) — nagłówek widoczny bez rozpoznanej
 *   nazwy to zmiana wyglądu CLI i ma skończyć się odmową, a nie obejściem;
 * - komendę potwierdzają DWA źródła: wpis jsonl i świeży zrzut `PermissionRequest` mają dosłownie
 *   tę samą komendę (`doubleProof`), więc stęchły wpis jsonl nie wystarczy;
 * - ramka na ekranie pokazuje tę komendę ({@link commandMatches}: całą albo jej koniec, ≥ 40 znaków).
 */
function clippedHeaderProven(dialog: ScreenDialog, expected: ExpectedDecision): boolean {
  return dialog.toolName === null && expected.toolName === BASH_TOOL
    && expected.doubleProof === true && expected.command !== undefined
    && dialog.operation !== null && !dialog.operation.headerVisible
    && commandMatches(dialog.operation, expected.command);
}

/**
 * Cross-check ekranu z jsonl — jedyna droga od „widzę dialog" do „wolno wysłać cyfrę".
 *
 * Podział ról jest twardy: **treść karty pochodzi z jsonl, cyfry z ekranu, a rozjazd
 * kończy się fail-closed**. Ekran nie niesie pełnego `tool_input` (jest przycięty do szerokości
 * panelu), a jsonl nie niesie i nigdy nie poniesie numerów opcji — dlatego oba są potrzebne
 * i oba muszą mówić o tym samym narzędziu.
 *
 * Dwie asymetrie, obie zmierzone na fixture'ach, obie świadome:
 *
 * 1. **Zgoda na narzędzie wymaga DOSŁOWNEJ nazwy z ekranu.** To jest miejsce, w którym zła
 *    cyfra zatwierdza cudzy `Bash` — brak nazwy jest tu tak samo dyskwalifikujący jak nazwa zła.
 * 2. **Formularz `AskUserQuestion` identyfikuje się KSZTAŁTEM.** Ekran tego dialogu nie zawiera
 *    linii `⏺ AskUserQuestion(…)` (fixture `dialog-askuserquestion.txt`), więc wymaganie nazwy
 *    znaczyłoby „karty pytań nigdy nie działają z telefonu". Cross-check jest tu dwustronny mimo
 *    to: jsonl musi mówić `AskUserQuestion` **i** ekran musi być formularzem z nawigacją.
 *    Nazwa SPRZECZNA jest rozjazdem tylko wtedy, gdy stoi WEWNĄTRZ regionu dialogu —
 *    `⏺ Edit(…)` w scrollbacku nad formularzem to normalny ekran, nie sprzeczność
 *    (zmierzone na żywo).
 *
 * @param screenText surowy ekran z `agent.read`
 * @param expected czekające narzędzie z jsonl; `null` = herdr mówi `blocked`, a jsonl nic nie czeka
 */
export function resolveOptions(
  screenText: string,
  expected: ExpectedDecision | null,
): DecisionResolution {
  // Override `multiSelect` wchodzi TYLKO ze ścieżki z `expected` (jsonl/hook po cross-checku).
  // Ścieżka czysto ekranowa nie ma go skąd wziąć i rozstrzyga sygnaturami, jak dotąd.
  const dialog = parseOptions(
    screenText, { multiSelect: expected?.multiSelect, labels: expected?.labels },
  );

  if (expected === null && dialog === null) {
    // Dialog zaufania bez cyfr: parser cyfr go nie czyta, więc rozpoznanie ma własny parser.
    const trustArrow = parseTrustArrowDialog(screenText);
    if (trustArrow !== null) {
      return {
        status: 'no-jsonl',
        retryable: false,
        knownDialog: 'trust',
        dialogIdentity: { kind: 'confirm', identity: { kind: 'known', id: 'trust' } },
        bodyPrint: trustArrow.bodyPrint,
        questionForm: null,
        options: [],
        trustArrow,
      };
    }
  }

  if (expected === null) {
    // Dialog spoza jsonl. Ponawianie nie ma sensu — nie ma z czym porównywać, a nie z czasem
    // jest problem. Rozstrzyga wyłącznie zamknięta lista sygnatur: dopasowanie daje opcje
    // (czyli przyciski), brak dopasowania — wycinek ekranu i „Odrzuć (Esc)".
    // Dialog z listy terminalowej nie bywa dialogiem z przyciskiem: parser nie daje mu `knownDialog`.
    // Blok niejednoznaczny nie daje ani rozpoznania, ani formularza (`question: null`).
    const terminal = dialog?.terminalDialog ?? null;
    const knownDialog = dialog?.knownDialog ?? null;
    const dialogIdentity = dialog === null ? null : { kind: dialog.kind, identity: dialog.identity };
    // Karta z ekranu: formularz pytania zawsze, potwierdzenie tylko BEZ dopasowanej sygnatury —
    // dialog z zamkniętej listy (trust, model) zostaje przy swojej obsłudze (karencja,
    // etykieta przycisku z kontraktu), a nie przy generycznej karcie.
    const formKind = dialog?.kind === 'question'
      ? 'question' as const
      : dialog?.kind === 'confirm' && knownDialog === null
        ? 'confirm' as const
        // Zgoda na narzędzie spoza jsonl (uniwersalna karta): sygnatura `tool`
        // jest zamknięta tak samo jak formularz pytania (markery stopki CLI), opcje niosą
        // własne cyfry, a eskalację flagujemy per opcja — patrz `optionPolicy`. Dialog z ramką uciętą
        // u góry formularza nie ma (`question: null` z `parseOptions`), więc i karty z przyciskami.
        : (dialog?.kind === 'tool' && knownDialog === null ? 'tool' as const : null);
    return {
      status: 'no-jsonl',
      retryable: false,
      knownDialog,
      dialogIdentity,
      ...(knownDialog === null || dialog === null || dialog.bodyPrint === null ? {} : { bodyPrint: dialog.bodyPrint }),
      questionForm: formKind !== null && dialog !== null && dialogIdentity !== null && dialog.question !== null
        ? {
          kind: formKind,
          dialogIdentity,
          ...dialog.question,
          bodyPrint: dialog.bodyPrint,
          ...(dialog.planFile === null ? {} : { planFile: dialog.planFile }),
          ...(formKind === 'tool' ? { toolName: dialog.toolName } : {}),
          ...(formKind === 'question' ? { submit: dialog.submit } : {}),
          ...(terminal === null ? {} : { terminalDialog: terminal }),
          // Dialog z listy terminalowej: KAŻDA opcja tylko w terminalu, nie tylko eskalująca.
          options: dialog.options.map((opt) => (optionPolicy({
            label: opt.label, terminalDialog: terminal,
            multiSelect: dialog.multiSelect, notesEditing: dialog.notesEditing,
          }, 'digit').terminalOnly
            ? { ...opt, terminalOnly: true }
            : opt)),
        }
        : null,
      // Opcje wychodzą stąd TYLKO razem z rozpoznaniem. Oddanie ich przy `knownDialog: null`
      // byłoby zaproszeniem do „przecież są sparsowane, narysujmy przyciski" — czyli do
      // generycznego klikania w cudze dialogi (`docs/security-model.md`, „Starting sessions from the phone: three powers”, pkt 14).
      options: knownDialog === null || dialog === null ? [] : dialog.options,
    };
  }

  if (dialog === null) return { status: 'unreadable', retryable: true, reason: 'no-options' };
  // Blok niejednoznaczny (reguła 3): ani nazwy, ani granicy — rozjazd, zanim cokolwiek porównamy.
  if (dialog.identity.kind === 'ambiguous') {
    return {
      status: 'mismatch', retryable: false, reason: 'ambiguous',
      screenKind: dialog.kind, screenToolName: null,
    };
  }

  const kind: 'tool' | 'question' = expected.toolName === ASK_USER_QUESTION_TOOL
    ? 'question'
    : 'tool';
  if (dialog.kind !== kind) {
    return {
      status: 'mismatch', retryable: false, reason: 'kind',
      screenKind: dialog.kind, screenToolName: dialog.toolName,
      ...(kind === 'question' && isReviewDialog(dialog) ? { reviewStep: true as const } : {}),
    };
  }
  /*
   * Formularz multi-select (`question === null`, marker `space to …`) nie da się uczciwie
   * obsłużyć jedną cyfrą — a ścieżka z `expected` stała się osiągalna dla stojących
   * dialogów przez zrzut hooka: bez tego warunku karta z `multiSelect`
   * z inputu hooka wysyłałaby gołą cyfrę w formularz czekający na `space`+`enter`.
   */
  if (kind === 'question' && dialog.question === null) {
    return {
      status: 'mismatch', retryable: false, reason: 'multi-select',
      screenKind: dialog.kind, screenToolName: dialog.toolName,
    };
  }

  /*
   * Nazwa pytania: formularz `AskUserQuestion` nie ma nazwy w bloku, więc sprzecznością jest dopiero
   * tytuł zgody z mapy w bloku formularza. Linia `⏺` w scrollbacku albo w samym formularzu nie jest
   * ani nazwą, ani sprzecznością, bo ten sam kształt
   * potrafi wpisać autor pytania.
   */
  /*
   * Narzędzie MCP (zmierzone na CLI 2.1.258): ekran zgody MCP nie rysuje
   * identyfikatora `mcp__catalog__catalog_get_project_tree_layout` — stoi na nim serwer i LUDZKI
   * tytuł narzędzia. Porównujemy OBA: serwer ({@link mcpServerMatches}, także nazwa
   * łącznika claude.ai ze spacją) i tytuł sprowadzony do słów ({@link mcpTitleMatches}). Sam
   * serwer nie wystarcza: karta innego narzędzia tego samego serwera (`delete_task` nad dialogiem
   * `get_project_tree_layout`) dostałaby przyciski. Fail-closed: brak nagłówka, inny serwer albo tytuł,
   * który nie powtarza nazwy, to rozjazd. Na kartę i do dziennika idzie nazwa kanoniczna z
   * `expected.toolName`.
   */
  const mcpServer = mcpServerOf(expected.toolName);
  const nameMismatch = kind === 'tool'
    ? (mcpServer === null
      ? dialog.toolName !== expected.toolName && !clippedHeaderProven(dialog, expected)
      : !mcpServerMatches(expected.toolName, dialog.mcpServer) || !mcpTitleMatches(expected.toolName, dialog.mcpTool))
    : dialog.toolName !== null && dialog.toolName !== expected.toolName;
  if (nameMismatch) {
    return {
      status: 'mismatch', retryable: false, reason: 'tool-name',
      screenKind: dialog.kind, screenToolName: dialog.toolName,
    };
  }
  /*
   * `Write` z nagłówkiem nad krawędzią ekranu (tożsamość `file-question`): nazwa
   * z pytania pod ramką jest tylko do wyświetlenia. Ekran nie pokazuje góry ramki ani licznika kolejki z linii
   * nagłówka, więc nie odróżnia dwóch `Write` z kolejki, a wpis jsonl i zrzut hooka porównujemy przy `Write` samą
   * nazwą: bez tej bramki karta pliku A dostawała przyciski nad dialogiem pliku B. Rozjazd treści operacji, jak
   * ramka ucięta u góry bez podwójnego dowodu.
   */
  if (dialog.identity.kind === 'file-question') {
    return {
      status: 'mismatch', retryable: false, reason: 'operation',
      screenKind: dialog.kind, screenToolName: dialog.toolName,
    };
  }
  /*
   * Zapis i edycja pliku: ekran dowodzi wywołania ścieżką z nagłówka i treścią albo
   * diffem w ramce. Bez dowodu rozjazd treści operacji, jak przy innej komendzie `Bash` w ramce.
   */
  if (kind === 'tool' && expected.fileCall !== undefined && !fileCallShown(expected.fileCall, dialog.operation)) {
    return {
      status: 'mismatch', retryable: false, reason: 'operation',
      screenKind: dialog.kind, screenToolName: dialog.toolName,
    };
  }
  /*
   * TREŚĆ operacji. Karta zgody niesie komendę z jsonl/hooka, a cyfra zatwierdza to, co
   * stoi na ekranie — przy dwóch różnych `Bash` (stęchły wpis jsonl, wywołanie rozstrzygnięte przy
   * biurku, a w pliku jeszcze bez wyniku) sama nazwa przepuszczała kartę komendy X nad dialogiem
   * komendy Y. Gdy ramka operacji jest na ekranie, musi pokazywać tę komendę; bez ramki (render
   * sprzed CLI 2.1.286) zostaje sama nazwa, jak dotąd.
   */
  /*
   * Ramka UCIĘTA u góry pokazuje tylko KONIEC komendy, a dwie różne komendy potrafią mieć wspólny
   * koniec (`echo safe` + skrypt i `rm -rf ~/Pictures` + ten sam skrypt, nazwa ze stopki
   * `Ask rule Bash(…)`). Sam koniec dowodzi tożsamości tylko przy podwójnym dowodzie
   * źródeł (wpis jsonl i zrzut hooka z dosłownie tą samą komendą).
   */
  if (kind === 'tool' && expected.command !== undefined && dialog.operation !== null
    && (!commandMatches(dialog.operation, expected.command)
      || (!dialog.operation.complete && expected.doubleProof !== true))) {
    return {
      status: 'mismatch', retryable: false, reason: 'operation',
      screenKind: dialog.kind, screenToolName: dialog.toolName,
    };
  }

  /*
   * Bramka eskalacji (`docs/dialogs.md`, „Rules: what must not be relaxed”) obowiązuje TAK SAMO na ścieżce z `expected` (jsonl/hook), a nie tylko na
   * ekranowej gałęzi `no-jsonl` wyżej: karta pytania ze źródła jsonl budowała się z opcji
   * SUROWYCH, więc opcja eskalująca („Yes, and don't ask again" — etykiety pisze autor
   * pytania) dostawała na telefonie zwykły, klikalny przycisk, choć ta sama etykieta na
   * ścieżce ekranowej była wyszarzona i odmawiana. `answerQuestion` sprawdza `terminalOnly`
   * na `ActiveReq.options`, a te biorą się WPROST stąd — bez flagi bramka nie miała czego
   * trafić.
   */
  // Rodzaj to tu `tool` albo `question`, więc `terminalDialog` jest `null`: liczy się sama eskalacja.
  const options: readonly ScreenFormOption[] = dialog.options.map((opt) => (optionPolicy({
    label: opt.label, terminalDialog: dialog.terminalDialog,
    multiSelect: dialog.multiSelect, notesEditing: dialog.notesEditing,
  }, 'digit').terminalOnly ? { ...opt, terminalOnly: true } : opt));
  return {
    status: 'ok',
    kind,
    toolName: expected.toolName,
    options,
    // Etykiety są te same co w `dialog.options` — flaga eskalacji ich nie rusza.
    digitByLabel: new Map(options.map((opt) => [opt.label, opt.digit])),
    submit: dialog.submit,
    // Dla pytania zawsze wypełnione: `question === null` odpadło wyżej jako `multi-select`.
    question: kind === 'question' ? dialog.question?.question ?? null : null,
    bodyPrint: dialog.bodyPrint,
    dialogIdentity: { kind: dialog.kind, identity: dialog.identity },
  };
}
