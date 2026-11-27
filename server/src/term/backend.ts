/**
 * Terminal PTY — KONTRAKT backendu trwałej powłoki.
 *
 * Rejestr (`registry.ts`) trzyma stan i współbieżność, `lifecycle.ts` podejmuje decyzje,
 * a backend jest RĘKAMI: zakłada trwałą powłokę, podpina do niej jeden strumień bajtów
 * i potrafi ją zabić. Ten plik nie importuje NICZEGO poza typami zdań — po to powstał: żeby rejestr dało się
 * złożyć z dowolnymi rękami, a jego testy nie potrzebowały ani binarki, ani gniazda.
 *
 * Backend jest JEDEN (panel herdr, `herdr-backend.ts`), a interfejs
 * mimo to zostaje. Trzyma czystą granicę „rejestr/transport" i to na nim wisi wstrzykiwalność
 * atrap w testach rejestru; zwinięcie go do wywołań `herdr-backend.ts` wprost oznaczałoby, że
 * reguły cyklu życia testuje się wyłącznie przez proces kontrolera.
 *
 * Kontrakt jest CIENKI z premedytacją. Wszystko, co jest regułą (karencja, bezpiecznik
 * respawnu, backpressure, sufit terminali), zostaje po stronie rejestru i `lifecycle.ts`;
 * backend odpowiada wyłącznie na pytania „jak założyć", „jak podłączyć", „jak zabić".
 */

import type { AnyText, OwnText, SentenceRef } from '@rarog/shared/sentences';

declare const ERR_FRAME: unique symbol;

/**
 * Ramka `err` terminala na drucie (`{ t: 'err', msg, msgRef? }`). Marka jest wyłącznie typem: ramkę składa tylko
 * {@link errFrame} ze zdania, więc goły napis nie trafi do `msg`. `msgRef` niesie tylko zdanie z `say()`.
 */
export interface TermErrFrame {
  readonly t: 'err';
  readonly msg: string;
  readonly msgRef?: SentenceRef;
  readonly [ERR_FRAME]: true;
}

/** Zdarzenie protokołu terminala (ramka TEKSTOWA): `exit` albo `err`. */
export type TermEventFrame = { readonly t: 'exit' } | TermErrFrame;

/**
 * Jedyna droga do ramki `err`: zdanie własne (`say`) albo tekst obcy; na drut idzie jego tekst, a zdanie
 * z `say()` dokłada swój `ref`. `ref` czytamy z kształtu (ma go wyłącznie zdanie z kodem), bo plik importuje same typy.
 */
export function errFrame(sentence: AnyText): TermErrFrame {
  const ref = (sentence as { readonly ref?: SentenceRef }).ref;
  return (ref === undefined ? { t: 'err', msg: sentence.text } : { t: 'err', msg: sentence.text, msgRef: ref }) as TermErrFrame;
}

/**
 * Uchwyt trwałej powłoki — OBIEKT, nie goły string.
 *
 * Adres powłoki (dziś: id panelu herdr, `w15:p1`) nie ma prawa wpaść przypadkiem do funkcji
 * oczekującej czegokolwiek innego: jedyne, co rejestr o nim wie, to że da się go przekazać
 * z powrotem do TEGO SAMEGO backendu.
 */
export interface TermSessionHandle {
  readonly ref: string;
  /**
   * TOŻSAMOŚĆ terminala (`termIdFor(realpath(cwd), slot)`), do którego ten uchwyt należy —
   * nie ozdoba i nie duplikat `ref`.
   *
   * `ref` jest ADRESEM, a adres bywa POZYCYJNY: id panelu herdr (`w15:p1`) po restarcie herdr
   * albo po przenumerowaniu paneli wskazuje coś innego niż wczoraj, a uchwyt siedzi w rejestrze
   * (RAM) do restartu Raroga. Bez tożsamości bramka własności umiałaby sprawdzić tylko „czy to
   * JAKIŚ panel Raroga" i zamknęłaby powłokę INNEGO terminala. Backend
   * porównuje `id` z tym, co panel o sobie mówi (token `rarog-term`), i dopiero wtedy działa.
   */
  readonly id: string;
  /**
   * Powłoka powstała PRZED CHWILĄ na to żądanie (`true`) czy została ODNALEZIONA/adoptowana
   * (`false`/brak).
   *
   * Rejestrowi jest to potrzebne do dwóch decyzji: świeży panel roli `lazygit` dostaje po
   * podpięciu strumienia wpisane `exec lazygit`, a panel odnaleziony — NIGDY (lazygit już
   * w nim chodzi, a wpisanie komendy poszłoby prosto w jego klawiaturę); świeży panel roli
   * popupowej, którego wpis skasowano, jest zamykany razem z tym wpisem. Pole jest opcjonalne,
   * bo dla roli `shell` nie ma żadnego znaczenia i backend nie musi go wypełniać.
   */
  readonly fresh?: boolean;
}

/**
 * ROLA powłoki widziana przez backend — dokładnie te same wartości co `TermRole` w `shared`.
 *
 * Powtórzona tu, a nie zaimportowana, świadomie: ten plik NIE IMPORTUJE NICZEGO (powód
 * w nagłówku), bo na tym stoi wstrzykiwalność atrap w testach rejestru. Backend potrzebuje roli
 * do jednej rzeczy — ETYKIETY taba w herdr (`rarog-term` vs `rarog-lazygit` vs `rarog-popup`);
 * cała reszta (tożsamość, cykl życia wpisu, wpisanie `exec lazygit`) zostaje po stronie
 * rejestru.
 */
export type TermSessionRole = 'shell' | 'lazygit' | 'popup';

/**
 * Uchwyt PRZESTAŁ wskazywać naszą powłokę — nie „awaria", tylko „adres jest nieaktualny".
 *
 * Rzuca go `attach`, gdy panel spod `handle.ref` nie nosi już naszego tokenu (zamknięty
 * w herdr, przenumerowany po restarcie herdr, wygasły stempel). Rejestr traktuje to inaczej
 * niż zwykły pad: kasuje zapamiętany uchwyt, żeby najbliższy `POST /api/term` policzył go
 * OD NOWA (`ensureSession`), zamiast do końca życia procesu dobijać się do cudzego panelu.
 */
export class TermHandleStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TermHandleStaleError';
  }
}

/**
 * Backend odmawia TERAZ, a ponowienie ma sens — `message` jest zdaniem DLA CZŁOWIEKA.
 *
 * Dwie sytuacje, obie w `ensureSession`: panel z etykietą tego terminala istnieje, ale jego
 * token nie wrócił (odzyskiwanie w toku albo wynik mutacji nieznany) — wtedy nowy tab obok
 * byłby duplikatem; oraz zastany panel lazygita zmienił się między dwoma odczytami. Tą samą
 * klasą jedzie odmowa bramki mutacji (`refusal()` w trakcie `ensureSession`), żeby jej zdanie doszło
 * do ramki `err`; ponowny `POST` odpowiada wtedy tą samą odmową. Rejestr
 * nie liczy tego jako padu: kładzie wpis w `failed` z ramką `err` niosącą to zdanie, a wyjściem
 * jest zwykły `POST` („Spróbuj od nowa"), który liczy uchwyt od nowa.
 */
export class TermBackendRetryError extends Error {
  /** Zdanie ramki `err`; `Error.message` to jego tekst (logi bez zmian). */
  readonly sentence: OwnText;

  constructor(sentence: OwnText) {
    super(sentence.text);
    this.name = 'TermBackendRetryError';
    this.sentence = sentence;
  }
}

/** Opcje `ensureSession` — patrz {@link TermBackend.ensureSession}. */
export interface TermEnsureOptions {
  /**
   * Otwarcie z JAWNEJ prośby człowieka (`POST /api/term`), a nie adopcja po restarcie Raroga.
   *
   * Dziś znaczy jedno: dla roli `lazygit` backend sprawdza, co stoi w ZASTANYM panelu,
   * i gdy to goła powłoka (sierota po restarcie herdr), zamyka go i zakłada świeży — `Cmd+G` jest
   * prośbą o lazygit. Adopcja tego nie robi nigdy: odzyskiwanie paneli niczego nie zamyka.
   */
  readonly explicit?: boolean;
}

/**
 * Wynik JEDNEGO przebiegu odzyskiwania paneli terminala ({@link TermBackend.reconcile}).
 *
 * Kolekcje są adresami paneli albo tożsamościami terminali — nigdy treścią.
 */
export interface TermReconcileResult {
  /**
   * Czy przebieg w ogóle zapytał herdr. `false`: odmowa killswitcha, brak gniazda, padnięty
   * odczyt inwentarza albo zamknięty backend — wtedy reszta pól jest pusta i nic nie znaczy.
   */
  readonly ran: boolean;
  /** Panele z potwierdzonym tokenem po przebiegu (etykieta i token zgodne): adres → tożsamość. */
  readonly confirmed: ReadonlyMap<string, string>;
  /** Adresy paneli, którym TEN przebieg przywrócił token z etykiety. */
  readonly restored: readonly string[];
  /** Adresy paneli, którym TEN przebieg nadał etykietę z tokenu (panel z tokenem, ale bez etykiety). */
  readonly migrated: readonly string[];
  /** Tożsamości, których przywrócenia wynik jest NIEZNANY (timeout mutacji) — nie „porażka". */
  readonly unknown: ReadonlySet<string>;
  /** Tożsamości w konflikcie (inny token przy etykiecie, dwa panele z jedną tożsamością). */
  readonly conflicts: ReadonlySet<string>;
}

/**
 * Koniec życia JEDNEGO strumienia — powód dla logu plus JEDNO pytanie, na które rejestr nie
 * umie odpowiedzieć sam.
 *
 * Rejestr rozróżnia „planowo" od „pad" po SWOICH rezerwacjach (`plannedKill`) i to zostaje
 * jego robotą. Czego nie wie, to czy pad ma w ogóle sens ponawiać: w panelu herdr NIE ma,
 * gdy kontroler został WYRZUCONY przez inny `--takeover`. Respawn w tej sytuacji to pętla
 * dwóch Rarogów bijących się o panel, więc backend musi umieć powiedzieć „nie próbuj".
 */
export interface TermStreamExit {
  /** Krótki opis do logu (kod wyjścia, `reason` z herdr). NIGDY treść powłoki. */
  readonly detail: string;
  /**
   * Powłoka jest dla Raroga STRACONA — respawn nic nie da. Rejestr kładzie wtedy wpis
   * w `failed` bez ani jednej próby ponowienia i bez naliczania bezpiecznika.
   */
  readonly fatal?: boolean;
  /** Zdanie DLA CZŁOWIEKA przy `fatal` — jedyny tekst, jaki zobaczy w ramce `err`. */
  readonly sentence?: OwnText;
}

/** Co backend musi wiedzieć, żeby podpiąć strumień do trwałej powłoki. */
export interface TermStreamOptions {
  /**
   * Katalog powłoki. Uchwyt go nie niesie: backend potrzebuje go przy KAŻDYM podpięciu
   * (herdr — do stempla `rarog-term` i pliku aktywności), a nie tylko przy zakładaniu.
   */
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  /** Surowe bajty z powłoki. Rejestr rozsyła je do gniazd; do logu nie idzie ani jeden. */
  onData(chunk: Buffer): void;
  /** Koniec życia TEGO strumienia — planowy albo pad; rozróżnia je rejestr, nie backend. */
  onExit(exit: TermStreamExit): void;
}

/**
 * JEDEN strumień podpięty do trwałej powłoki. Rejestr trzyma najwyżej jeden na wpis
 * i rozsyła jego bajty do wszystkich gniazd WS (fanout).
 */
export interface TermStream {
  /** Wejście z klawiatury. Treść NIGDY nie trafia do logu. */
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /**
   * Przewinięcie o `lines` wierszy (dodatnie = w dół) — historia powłoki żyje po stronie
   * backendu, więc jedyne, co klient może zrobić, to poprosić o przewinięcie.
   *
   * `cell` — komórka pod palcem/kursorem (1-based). Herdr kieruje kółko do panelu aplikacji
   * pod tą komórką (lazygit: diff vs lista); bez współrzędnych kółko w aplikacji pełnoekranowej
   * z panelami trafia w pustkę.
   */
  scroll(lines: number, cell?: { col: number; row: number } | null): void;
  /**
   * Wymusza odmalowanie ekranu u podłączonego klienta — potrzebne, gdy do ŻYWEGO strumienia
   * dochodzi nowe gniazdo (powrót w oknie karencji): bez tego xterm po drugiej stronie
   * zostałby pusty aż do pierwszego bajtu wyjścia.
   *
   * Zwraca `void`, nie obietnicę: rejestr nie ma z nieudanego odmalowania żadnej decyzji
   * do podjęcia, więc awarię notuje backend w swoim logu.
   */
  refresh(): void;
  /** Backpressure: wstrzymanie i wznowienie CZYTANIA z powłoki (polityka w `lifecycle.ts`). */
  pause(): void;
  resume(): void;
  /**
   * Zwalnia strumień, ZOSTAWIAJĄC trwałą powłokę przy życiu — to cała różnica między
   * `release` a {@link TermBackend.killSession}. W herdr znaczy „zabij kontroler, nie panel".
   *
   * Zwraca `void`: zwolnienie jest zawsze skuteczne z punktu widzenia rejestru, a backend, który
   * przed nim coś jeszcze robi ({@link TermReleaseOptions.restoreSize}), robi to sam i z własnym
   * sufitem czasu.
   */
  release(opts?: TermReleaseOptions): void;
}

/** Opcje {@link TermStream.release}. */
export interface TermReleaseOptions {
  /**
   * Przed zwolnieniem oddaj powłoce rozmiar, jaki miałaby bez klienta Raroga.
   *
   * Prosi o to rejestr WYŁĄCZNIE przy zwolnieniu po karencji, czyli gdy po strumieniu nie przyjdzie
   * od razu następca: przy respawnie pod nowe gniazdo następca i tak wstaje z rozmiarem urządzenia
   * (a przywrócenie byłoby parą zbędnych SIGWINCH), przy zamknięciu terminala panel ginie, a przy
   * zamknięciu serwera gniazdo herdr zamyka się w tej samej chwili. Backend, który nie umie albo
   * nie zdąży, zwalnia jak bez tej opcji.
   */
  readonly restoreSize?: boolean;
}

/** Jedna trwała powłoka widziana przez backend — wejście adopcji i żniw. */
export interface TermBackendSession {
  readonly handle: TermSessionHandle;
  /** Katalog powłoki; pusty string, gdy backend go nie zna (wtedy adopcja odpada). */
  readonly cwd: string;
  /**
   * Identyfikator terminala, do którego powłoka SIĘ PRZYZNAJE (herdr: token `rarog-term`
   * panelu); pusty string = nie nasza.
   *
   * To jest deklaracja, a nie dowód — dowodem jest dopiero porównanie z `termIdFor(realpath
   * (cwd), s)` dla kolejnych slotów w adopcji (`index.ts`); ta sama pętla odzyskuje NUMER
   * TABA, bo hash jest jednokierunkowy. Rozdzielenie ma powód: tylko tam widać ROZWIĄZANĄ
   * ścieżkę,
   * a backend nie ma prawa dotykać dysku po to, żeby sprawdzić własną nazwę. Żniwiarz używa
   * słabszej wersji tego samego pytania („czy w ogóle nasza"), bo zabija tylko powłoki bez
   * klienta i bez aktywności.
   */
  readonly id: string;
  /** Sekundy uniksowe OSTATNIEJ aktywności — wejście `shouldReap`. */
  readonly activityEpochSec: number;
  /** Czy backend widzi podłączonego klienta; sesja z klientem nie podlega żniwom. */
  readonly attached: boolean;
}

/**
 * Odmowa backendu ZANIM cokolwiek powstanie — powód, który router zamienia na 409 z kodem.
 *
 * Istnieje dla backendu panelowego: zakładanie panelu w herdr jest władzą „launch"
 * (`RAROG_HERDR_LAUNCH`), a jego zamykanie i stemplowanie — władzą „send" (`RAROG_HERDR_SEND`).
 * Wyłączony killswitch ma dać człowiekowi ZDANIE („włącz X"), a nie zerwane gniazdo WS przy
 * pierwszym wejściu w terminal.
 */
export type TermBackendRefusalCode = 'herdr-launch-off' | 'herdr-send-off';

export interface TermBackendRefusal {
  readonly code: TermBackendRefusalCode;
  readonly sentence: OwnText;
}

export interface TermBackend {
  /**
   * Czy dołączenie NOWEGO gniazda wymaga respawnu strumienia.
   *
   * `true` w herdr (jedyny backend), bo pełną ramkę — czyli cokolwiek do narysowania —
   * kontroler wysyła WYŁĄCZNIE na starcie, a rozmiar bierze z argumentów spawnu; drugie
   * urządzenie musiałoby inaczej patrzeć w pusty ekran do pierwszego bajtu wyjścia. `false`
   * zostaje w kontrakcie dla backendu, który umie dorysować ekran na żądanie (`refresh()`).
   */
  readonly respawnOnAttach: boolean;
  /**
   * Czy backendowi WOLNO dziś zakładać powłoki — pytanie zadawane PRZED wpisem do rejestru.
   *
   * Synchroniczne, bo `POST /api/term` jest synchroniczny i ma odpowiedzieć powodem, a nie
   * milczeniem. `null` = wolno.
   */
  refusal(): TermBackendRefusal | null;
  /**
   * Zakłada albo ODNAJDUJE trwałą powłokę dla katalogu i zwraca jej uchwyt.
   *
   * Obietnica, bo backend panelowy musi w tym miejscu odpytać gniazdo herdr.
   *
   * `role` (opcjonalna, domyślnie `'shell'`) steruje etykietą zakładanego taba i — przy
   * `opts.explicit` — sprawdzeniem zastanego panelu lazygita ({@link TermEnsureOptions});
   * odnajdywanie idzie po tokenie `rarog-term`, czyli po tożsamości, która rolę ma już w sobie
   * zaszytą (`termIdFor`). Uchwyt ma powiedzieć w `fresh`, czy powłoka powstała przed chwilą.
   *
   * Wolno odrzucić {@link TermBackendRetryError} — „nie teraz, ale ponowienie ma sens".
   */
  ensureSession(
    id: string, cwd: string, role?: TermSessionRole, opts?: TermEnsureOptions,
  ): Promise<TermSessionHandle>;
  /**
   * ODZYSKIWANIE paneli terminala po etykiecie: panel z etykietą `rt:<id>` bez
   * tokenu dostaje token z powrotem, panel z tokenem bez etykiety — etykietę; konflikt zostaje
   * nietknięty. Niczego nie zamyka i niczego nie zakłada.
   *
   * JEDEN przebieg naraz: równoległe wywołania dostają ten sam wynik. Nigdy się nie odrzuca —
   * awarię mówi `ran: false` i linia w logu.
   */
  reconcile(): Promise<TermReconcileResult>;
  /**
   * Zamknięcie backendu razem z serwerem: przebieg odzyskiwania w locie przestaje mutować,
   * a zakładanie nowych paneli odmawia. Trwałe powłoki zostają.
   */
  dispose(): void;
  /**
   * Podpina JEDEN strumień. Obietnica rozwiązuje się, gdy powłoka jest gotowa do pracy.
   *
   * Wolno ją odrzucić {@link TermHandleStaleError} — „adres z uchwytu nie jest już naszą
   * powłoką". Rejestr wyrzuca wtedy zapamiętany uchwyt i liczy go od nowa przy następnym
   * `POST`; każdy inny błąd jest zwykłym padem i idzie pod bezpiecznik respawnu.
   */
  attach(handle: TermSessionHandle, opts: TermStreamOptions): Promise<TermStream>;
  /** Wszystkie trwałe powłoki tego backendu — adopcja po restarcie Raroga i żniwa. */
  listSessions(): Promise<TermBackendSession[]>;
  /**
   * Nazwa procesu na pierwszym planie powłoki (`nvim`, `codex`, `zsh`) — etykieta pigułki taba.
   *
   * **SYNCHRONICZNA i z cache'u**, bo `GET /api/term` jest synchroniczny i nie ma prawa czekać
   * na herdr: p90 odczytu to ~110 ms RAZY liczba paneli, czyli sekunda na pollingu co 5 s.
   * Pusty string znaczy „jeszcze nie wiem" (pierwsza lista po starcie serwera) — a nie
   * „powłoka bez procesu"; klient pokazuje wtedy samą pigułkę `>_`.
   *
   * Wołanie tej metody jest zarazem PROŚBĄ o odświeżenie: backend, którego wpis jest starszy
   * niż jego TTL, dosyła odczyt W TLE — po tej odpowiedzi, nigdy przed nią. Własnego zegara
   * przy tym nie ma: bez `list()` nikt o `proc` nie pyta, więc nie ma czego odświeżać.
   *
   * W kontrakcie BACKENDU, a nie w rejestrze, z tego samego powodu co `readHistory`: nazwa
   * procesu nie jest stanem Raroga, tylko faktem po stronie trwałej powłoki, a rejestr nie ma
   * prawa sięgać do herdr z pominięciem backendu.
   */
  processName(handle: TermSessionHandle): string;
  /** Zabija trwałą powłokę razem z pracą w niej. Normalna droga `DELETE /api/term/:id`. */
  killSession(handle: TermSessionHandle): Promise<void>;
  /**
   * Odświeża ZNAK WŁASNOŚCI powłoki bez dotykania jej samej — `true`, gdy powłoka nadal jest
   * nasza i stempel poszedł; `false`, gdy spod uchwytu zniknęła albo nosi cudzą tożsamość.
   *
   * Rejestr woła to cyklicznie (`TERM_TOKEN_REFRESH_MS`) dla każdego wpisu z rozwiązanym
   * uchwytem. Stempel nie ma terminu ważności, więc odświeżenie nie ściga się z TTL:
   * jest tanim, idempotentnym raportem i licznikiem paneli, które token straciły (te odzyskuje
   * {@link reconcile} z etykiety, nie ta metoda). Backend NIE traktuje tego jako aktywności
   * powłoki (żniwa liczą ciszę od człowieka, nie od timera).
   */
  refreshSession(handle: TermSessionHandle): Promise<boolean>;
  /**
   * HISTORIA powłoki jako zwykły tekst — `GET /api/term/:id/history`.
   *
   * W kontrakcie backendu, a nie w rejestrze, bo scrollback NIE JEST stanem Raroga: żyje po
   * stronie trwałej powłoki (w herdr — w panelu) i rejestr nie ma z czego go złożyć. Rejestr
   * dostaje gotowy tekst i nigdzie go nie trzyma.
   *
   * Wolno odrzucić {@link TermHandleStaleError} — „adres z uchwytu nie jest już naszą
   * powłoką", ta sama bramka własności co przy `attach` i `killSession`. Implementacja NIE
   * MA prawa zalogować ani jednego znaku zwróconej treści.
   */
  readHistory(handle: TermSessionHandle, lines: number): Promise<TermHistory>;
}

/** Historia powłoki oddana przez backend. `truncated` = scrollback był dłuższy niż `lines`. */
export interface TermHistory {
  readonly text: string;
  readonly truncated: boolean;
}
