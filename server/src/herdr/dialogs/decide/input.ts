/**
 * Wejście i wyjście decyzji „jaka karta" (`decideCard`): to, co fasada drivera ustaliła przed oceną,
 * opis czynności, którą ma wykonać, i osłona po własnej decyzji Raroga.
 */
import type { PendingHookTool } from '../hook/dump.ts';
import type { PendingTool } from '../../jsonl-pending.ts';
import type { AuditMismatchReason, HerdrRefuseReason } from '../../audit.ts';
import type { DecisionResolution, ExpectedDecision } from '../screen/resolve.ts';
import type { DialogIdentityStamp } from '../screen/identity.ts';
import type { KnownDialogId } from '../screen/known.ts';
import type { TerminalDialogId } from '../policy/terminal.ts';
import type { ScreenOption } from '../screen/options.ts';
import type { ActiveReq, CardOrigin, DecisionCard } from '../cards/build.ts';
import type { Layer2Mark } from '../layer2/card.ts';

/** Cross-check ekranu z jsonl — ten sam kontrakt co `OptionResolver` w driverze. */
export type DecideResolver = (
  screenText: string, expected: ExpectedDecision | null,
) => DecisionResolution;

/** Wejście decyzji: wyłącznie to, co driver ZDĄŻYŁ ustalić przed oceną. */
export interface DecideInput {
  /** Czekające narzędzie z jsonl (`tool_use`). `null` = plik milczy albo go nie ma. */
  readonly pending: PendingTool | null;
  /**
   * Zrzut hooka w kształcie `PendingTool`. Przy obecnym wpisie z jsonl driver podaje go wyłącznie
   * dla `AskUserQuestion` zgodnego z tym wpisem albo jako KONKURENTA wpisu:
   * zrzut `PermissionRequest` innego i nie starszego wywołania (`competingHook`) albo zrzut `Bash`
   * starszy niż wpis (`olderBashHook`). W każdym innym przypadku `null`.
   */
  readonly hookPending: PendingTool | null;
  /** Ekran panelu z ostatniego odczytu; `null` = nie dało się przeczytać. */
  readonly text: string | null;
  /**
   * BAZA identyfikatora kart, policzona PRZED odczytem ekranu ({@link decideReqId}).
   *
   * Nie liczymy jej tutaj z `blockedSeq` z rozmysłem: dla dialogu spoza jsonl baza bierze
   * numer blokady sprzed odczytu (na nim stoi bramka „ta sama karta" w driverze), a karty
   * ekranowe budują się już z numerem BIEŻĄCYM. Odczyt jest awaitem — te dwie wartości
   * potrafią się rozjechać i rozjeżdżały się tak od zawsze.
   */
  readonly reqId: string;
  /** Karta stojąca w tej chwili na telefonie. */
  readonly active: ActiveReq | null;
  /** Numer bieżącej blokady — baza identyfikatora kart ekranowych i znacznik świeżości. */
  readonly blockedSeq: number;
  /** Numer blokady, na którą poszła NASZA cyfra (okno po własnej odpowiedzi). */
  readonly answeredSeq: number;
  /**
   * Wywołanie `AskUserQuestion` ROZLICZONE plikiem hooka — osłona po zużyciu pliku.
   * `null` = w tej blokadzie nic takiego nie zaszło.
   *
   * `allow` z hooka domyka CAŁE wywołanie, ale `tool_result` ląduje w jsonl z opóźnieniem, więc
   * `pending` przez chwilę dalej wskazuje na już odpowiedziany formularz (od CLI 2.1.267 wpis
   * stoi tam od chwili postawienia dialogu). Bez tej osłony ocena w tym oknie budowała z niego
   * kartę na nowo — pytanie, na które człowiek właśnie odpowiedział — albo degradowała ją do
   * „odpowiedz w terminalu", bo ekran był w środku zamykania formularza.
   *
   * Wywołanie rozpoznajemy po TREŚCI pytań, a nie po `tool_use.id`:
   * id bierze się z followera, a ten bywa o ułamek sekundy do tyłu — w chwili odpowiedzi
   * `pending` potrafi być jeszcze `null` (i wtedy osłona nie ma czego pilnować) albo już
   * NASTĘPNY wpis (i wtedy odbierałaby kartę cudzemu pytaniu). Treść pytań pochodzi z karty,
   * na którą człowiek odpowiedział, więc jest znana od razu i nie zależy od pliku.
   *
   * `key` to `answerKey` ROZLICZONEGO zrzutu i on kończy osłonę:
   * sama treść nie odróżnia DWÓCH identycznych wywołań jednej tury (stąd nonce w kluczu),
   * więc bez tego pola powtórzone pytanie nie dostałoby karty już nigdy —
   * do końca blokady, bez karty i bez wpisu odmowy. Świeży zrzut o INNYM kluczu znaczy
   * „hook czeka na NASTĘPNE wywołanie" i osłona się rozpada.
   *
   * `seq` to numer blokady, w której odpowiedź poszła — WŁASNY, a nie `answeredSeq`: ten drugi
   * przestawia też cyfra, więc osłona hooka odżywałaby w cudzej blokadzie po zwykłym tapnięciu.
   * Czas osłony ogranicza dodatkowo `ANSWERED_HOOK_SHIELD_MS` (`herdr/dialogs/timing.ts`) —
   * pilnuje go driver, bo to on ma zegar; tutaj wygasła osłona przychodzi po prostu jako `null`.
   */
  readonly answeredHookCall: {
    readonly questions: readonly string[];
    readonly seq: number;
    readonly key: string;
  } | null;
  /**
   * Karta rozstrzygnięta WŁASNĄ decyzją Raroga (cyfra albo `escape`) — osłona po decyzji.
   * `null` = w tej blokadzie nic takiego nie zaszło albo osłona wygasła (`DECIDED_SHIELD_MS`, pilnuje
   * driver). Bez niej ocena tuż po cyfrze, gdy herdr jeszcze mówi `blocked`, a ekran pokazuje dialog
   * sprzed przemalowania, budowała tę samą kartę od nowa i telefon dostawał ją na ~2 s z powrotem.
   */
  readonly decided: DecidedShield | null;
  /** Czy kanał odpowiedzi hooka istnieje w tej instalacji (`deps.hookAnswers`). */
  readonly hookAnswersEnabled: boolean;
  /** Klucz kanału, który już raz nie zadziałał — karta z nim nie wychodzi drugi raz. */
  readonly deadAnswerKey: string | null;
  /** Czy wolno jeszcze raz przeczytać ekran (JEDNO ponowienie). */
  readonly canRetry: boolean;
  readonly resolve: DecideResolver;
  /**
   * Wycinek ekranu NA KARTĘ — ostatnie linie dialogu bez ANSI albo `null`, gdy na ekranie
   * nie ma ani jednej litery. Czytnik, nie wartość: liczy się wyłącznie dla dwóch kart bez
   * przycisków, a to jest kilka procent ocen.
   */
  readonly excerpt: (text: string) => string | null;
  /**
   * SUROWY zrzut hooka (`answerKey`, `hookEventName`, `toolUseId`) — `hookPendingFrom` gubi te
   * pola. WARTOŚĆ, nie czytnik: driver czyta plik DOKŁADNIE RAZ na ocenę i z tego jednego
   * odczytu powstaje i {@link hookPending}, i adres odpowiedzi.
   *
   * Odczyt leniwy wypadałby PO asynchronicznym odczycie ekranu: hook, który
   * w tym oknie nadpisałby zrzut A zrzutem B, dałby kartę z pytaniami A i kluczem odpowiedzi B —
   * czyli odpowiedź człowieka wysłaną w cudze pytanie.
   */
  readonly hookRaw: PendingHookTool | null;
  /**
   * Flaga warstwy 2 (`RAROG_DIALOG_LAYER2`), podana przez driver z `deps.dialogLayer2`. Nieobecna albo `false` =
   * decyzja bez warstwy 2, bajt w bajt jak przed flagą. `true` = karta ekranu bez opcji z cyframi niesie blok
   * z sufitem warstwy 2 (`layer2/card.ts`) i ślad warstwy 2, a ta sama karta z innym odciskiem bloku dostaje
   * `refresh`.
   */
  readonly layer2?: boolean;
  /**
   * Katalog sesji (`cwd` agenta herdr), podany przez driver. Dialog `Write` i `Edit` pokazuje ścieżkę pliku względną
   * wobec niego, a wpis jsonl katalogu nie niesie (`ExpectedDecision.fileCall`, `decide/sources.ts`). Nieobecne =
   * ścieżki względnej z wpisu jsonl nie da się potwierdzić, więc taka karta zostaje bez przycisków.
   */
  readonly cwd?: string | null;
}

/**
 * Co ma zrobić driver. Kolejność skutków: `audit` → gaszenie → wystawienie.
 *
 * Wycinek ekranu nie jest skutkiem ubocznym, tylko POLEM KARTY (`screen`), więc nie ma
 * go ani w akcjach, ani w kolejności.
 */
export type DecideAction =
  /**
   * Nic nie wychodzi na zewnątrz — ten sam dialog stoi dalej. `touchSeq` przestawia
   * `active.seq` na bieżącą blokadę („karta potwierdziła się w tej blokadzie").
   */
  | { readonly kind: 'keep'; readonly touchSeq: boolean }
  /** Ekran nie do odczytania (albo pusty `no-jsonl`) — driver czeka, czyta z `force` i pyta znów. */
  | { readonly kind: 'retry' }
  /**
   * Nowa karta z treścią (zgoda, pytanie, plan, degradacja). Pochodzenie karty do dziennika jedzie
   * w `card.active.origin`; `diagnosis` jest obecne dokładnie wtedy, gdy `audit` nie jest `null`.
   */
  | {
    readonly kind: 'card';
    readonly card: DecisionCard;
    readonly audit: HerdrRefuseReason | null;
    readonly diagnosis?: DegradeDiagnosis;
  }
  /** Karta dialogu spoza jsonl — „odpowiedz w terminalu", z powodem i wycinkiem ekranu. */
  | {
    readonly kind: 'screen-dialog';
    readonly reqId: string;
    readonly resolved: {
      knownDialog: KnownDialogId | null; options: readonly ScreenOption[];
      /** Rodzaj i tożsamość dialogu z bloku — karta znanego dialogu niesie je do kontroli przed cyfrą. */
      dialogIdentity?: DialogIdentityStamp | null;
      /** Odcisk bloku znanego dialogu — karta znanego dialogu niesie go do kontroli przed cyfrą. */
      bodyPrint?: string | null;
    } | null;
    readonly reason: HerdrRefuseReason | null;
    readonly audit: HerdrRefuseReason | null;
    /** Co widać w panelu — `null`, gdy ekranu nie dało się przeczytać. */
    readonly screen: string | null;
    /** Pochodzenie karty do dziennika — driver kładzie je w `ActiveReq.origin`. */
    readonly origin: CardOrigin;
    /** Kształt przypadku do dziennika — obecny dokładnie wtedy, gdy `audit` nie jest `null`. */
    readonly diagnosis?: DegradeDiagnosis;
    /** Ślad warstwy 2 (powód i odcisk bloku) — wyłącznie karta z wycinkiem bloku warstwy 2, przy fladze `1`. */
    readonly layer2?: Layer2Mark;
  }
  /**
   * Ta sama karta bloku warstwy 2 (`reqId` stojącej karty), a blok pod nią inny: nowy wycinek i odcisk. Driver
   * podmienia je na stojącej karcie BEZ gaszenia (bez `permission-cleared`, bez wpisu w dzienniku) i dosyła wycinek
   * zdarzeniem `dialog-screen`. Wyłącznie przy fladze warstwy 2.
   */
  | {
    readonly kind: 'refresh';
    readonly reqId: string;
    readonly screen: string;
    readonly layer2: Layer2Mark;
  };

/**
 * KSZTAŁT karty bez decyzji do dziennika i zrzutu odmowy.
 * Liczony z TEGO SAMEGO odczytu ekranu, z którego powstała karta, bez treści i etykiet.
 */
export interface DegradeDiagnosis {
  /**
   * Podpowód rozjazdu z PIERWSZEGO rozpoznania — zanim ścieżka zrzutu hooka przeliczy rozpoznanie
   * z `expected = null` (wtedy zostaje z niego sam powód `mismatch`). `null` = rozpoznanie nie było
   * rozjazdem (ekran nieczytelny, dialog spoza jsonl, formularz bez dopasowanej zakładki).
   */
  readonly mismatchReason: AuditMismatchReason | null;
  /** Nagłówek nad ramką operacji widoczny/niewidoczny; `null` = dialog bez ramki albo bez dialogu. */
  readonly headerVisible: boolean | null;
  /** Liczba opcji z cyframi na ekranie (`0` = brak); `null` = ekranu nie udało się przeczytać. */
  readonly optionCount: number | null;
  /**
   * Dialog z zamkniętej listy `TERMINAL_DIALOGS` rozpoznany na ekranie tej oceny;
   * `null` = dialog spoza listy albo bez dialogu.
   */
  readonly dialogTitle: TerminalDialogId | null;
}

/** Karta rozstrzygnięta własną decyzją Raroga — patrz {@link DecideInput.decided}. */
export interface DecidedShield {
  /** `reqId` rozstrzygniętej karty — łapie kartę pytania tej samej zakładki i kartę z ekranu. */
  readonly reqId: string;
  /** Odcisk wywołania karty z jsonl/hooka (`callPrint`); `null` dla kart z samego ekranu. */
  readonly callPrint: string | null;
  /** Id wpisu jsonl, który był ŹRÓDŁEM karty; `null` dla karty ze zrzutu hooka albo z ekranu. */
  readonly callId: string | null;
  /**
   * Id wpisu jsonl: źródło karty albo wpis obok zrzutu. Przy karcie ze zrzutu to wpis z chwili decyzji, nie
   * budowy karty (`besideAtDecision`); tak samo `pendingYounger`.
   */
  readonly pendingId: string | null;
  /**
   * Wpis `pendingId` był MŁODSZY od zrzutu, który dał karcie treść (`ActiveReq.pendingYounger`) — żywe
   * wywołanie agenta głównego obok zgody subagenta. Jego zmiana osłony nie zdejmuje.
   */
  readonly pendingYounger: boolean;
  /**
   * Odcisk treści dialogu z ramką (`bodyPrint`) z ekranu PRZED klawiszem — łapie kartę z ekranu po
   * karcie ze zrzutu i kartę bez przycisków po utracie podwójnego dowodu (ten sam dialog).
   */
  readonly bodyPrint: string | null;
  /**
   * Tożsamość dialogu z ekranu przed klawiszem (`screenFormReqId`) — niezależna od źródła karty; łapie kartę
   * z ekranu po karcie ze zrzutu także dla dialogu bez ramki operacji.
   */
  readonly screenReqId: string | null;
  /** Generacja zrzutu `PermissionRequest` w chwili decyzji; NOWA generacja to nowy dialog. */
  readonly hookAt: number | null;
  /**
   * Generacja zrzutu INNEGO dialogu, który decyzja zostawiła (`otherDialogDump`), czytana
   * po klawiszu. Bywa inna niż `hookAt`: zrzut subagenta potrafi dojść w trakcie wysyłki. Znana osłonie, więc jej nie
   * zdejmuje. Brak pola = brak takiego zrzutu.
   */
  readonly keptHookAt?: number | null;
  /** Numer blokady, w której poszła decyzja; nowa blokada zdejmuje osłonę. */
  readonly seq: number;
}
