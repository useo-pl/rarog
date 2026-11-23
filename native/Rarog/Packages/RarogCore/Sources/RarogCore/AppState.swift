import Foundation
import RarogContract
import RarogTransport

/// Stan połączenia jednego strumienia SSE.
public enum ConnectionStatus: Sendable, Equatable {
  /// Strumień nie jest prowadzony (tło, brak logowania, brak otwartej sesji).
  case idle
  /// Łączę od chwili `since` (UI pokazuje „łączę…" dopiero po ~1 s).
  case connecting(since: Date)
  case online
  /// Zerwane od `since`; pętla łączy dalej z narastającym odstępem.
  case offline(since: Date)
}

/// Zalogowanie. `loggedOut` kasuje stan widoku.
public enum AuthStatus: Sendable, Equatable {
  case unknown
  case loggedIn
  case loggedOut(LogoutReason)
}

public enum LogoutReason: Sendable, Equatable {
  /// Brak klucza na urządzeniu (pierwsze uruchomienie, „Zapomnij serwer”).
  case notLoggedIn
  /// 401 `device-revoked` przy kluczu urządzenia: klucz skasowany, trwały ekran „To urządzenie odpięto”
  /// z datą i przyczyną z `AppState.pairing.revoked` — także po restarcie apki, do następnego parowania.
  case deviceRevoked
  /// 401 klucza bez `device-revoked` (`device-unknown`): klucz ZOSTAJE (serwer mógł zgubić `devices.json`),
  /// ekran „Serwer nie rozpoznał tego urządzenia” z ponowieniem i parowaniem. Także 401 magazynu bez złącza serwera
  /// (atrapy testów obszarów).
  case deviceUnknown
}

/// Otwarta (płynąca deltami) wiadomość agenta — osobno od listy domkniętych wiadomości.
///
/// Przyrost po wiadomości systemowej albo użytkownika trafia TUTAJ, nie do ostatniej komórki;
/// domknięta wiadomość agenta ją zastępuje.
public struct OpenAgentMessage: Sendable, Equatable {
  public var text: String
  /// `true` = po ponownym połączeniu z ważnym kursorem brakujące delty nie wrócą (delty są ulotne,
  /// bez replayu: `docs/implementation-spec.md`), więc tekst został zamknięty znakiem „…" i czeka
  /// na domkniętą wiadomość.
  public var gap: Bool
  /// `true` = wiadomość dołączona W ŚRODKU: strumień sesji otworzył się, gdy agent już pisał, więc
  /// początek przepadł (delty są ulotne, bez replayu: `docs/implementation-spec.md`). Tekst zaczyna się
  /// akapitem „…" do domkniętej wiadomości.
  public var leadingGap: Bool

  public init(text: String, gap: Bool = false, leadingGap: Bool = false) {
    self.text = text
    self.gap = gap
    self.leadingGap = leadingGap
  }
}

/// Decyzja wysłana z TEGO urządzenia, czekająca na rozstrzygnięcie serwera.
public struct DecisionAttempt: Sendable, Equatable {
  public var choice: String
  public var startedAt: Date
  /// Serwer przyjął decyzję (200); karta czeka już tylko na zdjęcie. Stoi w store, nie w stanie ekranu sesji, więc
  /// karta mówi „wysłano” także po zmianie sesji i powrocie (kontroler ekranu powstaje wtedy od nowa).
  public var accepted = false
}

/// Ślad karty, która zniknęła nie z naszej decyzji: stoi `noticeLifetime`.
public struct CardNotice: Sendable, Equatable {
  public enum Kind: Sendable, Equatable { case permission, question }

  public enum Reason: Sendable, Equatable {
    /// Rozstrzygnięta na innym urządzeniu (`by` = etykieta urządzenia, jeśli serwer ją podał).
    case resolvedElsewhere(by: String?)
    /// 409 na naszą decyzję — „Decyzja zapadła już na innym urządzeniu.".
    case alreadyDecided
    /// 410 albo `expired` od serwera — „Zgoda wygasła — wznów sesję…".
    case expired
  }

  public let cardId: String
  public let sessionId: String
  public let kind: Kind
  public let reason: Reason
  public let at: Date
}

/// Transkrypt jednej sesji: OGON serwera (≤ 500), otwarta wiadomość, karty decyzji.
public struct TranscriptState: Sendable, Equatable {
  public var messages: [TranscriptMessage] = []
  /// Proces serwera (`serverStartId`), który ponumerował `messages` (ostatni pełny stan). Restart serwera numeruje
  /// transkrypt od nowa, więc `seq` sprzed niego znaczy co innego (kotwica śladu decyzji, `DecisionTraces.swift`).
  public var messagesEpoch: String?
  public var open: OpenAgentMessage?
  public var activity: Activity?
  /// Kiedy aktywność przyszła — baza lokalnego licznika ciszy.
  public var activityAt: Date?
  public var pendingPermissions: [PermissionRequest] = []
  public var pendingQuestions: [QuestionRequest] = []
  public var git: GitStatusEvent?
  /// Ile pełnych stanów przyszło z serwera; `0` = jeszcze nic (szkielet).
  public var snapshots = 0
  /// Kursor strumienia sesji (`id:` ostatniej domkniętej ramki) — `Last-Event-ID` przy powrocie.
  public var cursor: String?
  /// Decyzje z tego urządzenia w locie, po `permId`/`qId`.
  public var decisions: [String: DecisionAttempt] = [:]
  /// Zwolnienia kart kanału zgód do terminala w locie albo przyjęte, po `permId`: przyjęte zostaje, aż serwer zdejmie
  /// kartę (jak przyjęta decyzja w `decisions`). Osobno od `decisions`: `release` nie blokuje zgody ani odmowy i nie
  /// udaje ich na karcie, a koniec jednego żądania nie kasuje stanu drugiego.
  public var releases: [String: Date] = [:]
  /// Ślady własnych decyzji, które doszły (`DecisionTraces.swift`), w kolejności decyzji.
  public var decisionTraces: [DecisionTrace] = []
  /// Szkice śladów decyzji w locie, po `permId`/`qId`: stają się śladem po 200, inny wynik je kasuje. Osobno od
  /// `decisions`, bo ten wpis zdejmuje rozstrzygnięcie ze strumienia, zanim wróci odpowiedź.
  public var traceDrafts: [String: DecisionTrace] = [:]
  /// Strumień sesji otworzył się przy pracującej sesji: pierwsza otwarta wiadomość po nim mogła
  /// zacząć się, zanim słuchaliśmy. Gaśnie, gdy domknięta wiadomość zastąpi tę
  /// częściową, i przy wyjściu sesji ze stanu pracy.
  public var joinedMidTurn = false
  /// Od otwarcia strumienia przyszła choć jedna delta — odróżnia domknięcie NASZEJ częściowej
  /// wiadomości od powtórki starszych wiadomości z bufora tuż po połączeniu.
  public var deltaSinceOpen = false
  /// Licznik zmian repozytorium widziany z apki: rośnie przy KAŻDEJ ramce `git-status` i `usage` tej sesji
  /// (także o tej samej treści) i przy zmianie metadanych gita albo kontekstu w podsumowaniu — z
  /// `session-changed` i z pełnego `sessions-snapshot` (powrót z tła; sesje bez ramek `usage`).
  /// Podsumowanie gita nie zmienia się przy kolejnej edycji już zmienionego pliku, a praca agenta
  /// tak — więc patch w podglądzie jest ważny dla licznika, nie dla podsumowania.
  public var repoRevision = 0
  /// Events of this session's own stream inside a turn: each `activity` and each new message (not a repeat). The
  /// activity row ticks its glyph when it grows. The global copy of an activity, snapshots and clock ticks leave it.
  /// Changed only by the reducer (`Reducer+ActivityRow`); read through ``AppState/turnEvents(_:)``.
  public internal(set) var turnEvents = 0

  public init() {}
}

/// Cały stan widoku — wartość. Zmienia go wyłącznie ``AppState/apply(_:now:)``.
public struct AppState: Sendable, Equatable {
  /// Build tej apki — porównanie z `hello.minClientBuild`.
  public let clientBuild: Int

  public var auth: AuthStatus = .unknown
  public var global: ConnectionStatus = .idle
  /// Strumień oglądanej sesji.
  public var sessionStream: ConnectionStatus = .idle
  public var compat: Compatibility = .unknown
  public var serverStartId: String?

  public var sessions: [String: SessionSummary] = [:]
  /// Pierwszy pełny stan listy przyszedł (przed nim: szkielet, nie „pusto").
  public var sessionsLoaded = false
  public var herdr: HerdrStatus?
  /// Katalog (``ProjectPath/normalized(_:)``) → „ma notatkę". Pusty po `sessions-snapshot` bez `notesCwds`.
  /// Czyta go ``hasNote(_:)``.
  public var notesPresent: [String: Bool] = [:]
  /// Katalog → licznik zmian notatki ze strony serwera: event `notes` i bit ze snapshotu inny niż znany. Event nie
  /// niesie treści, więc dla modelu notatek w apce to sygnał „przeczytaj jeszcze raz".
  public var notesRevision: [String: Int] = [:]
  /// Epoka notatek: rośnie przy KAŻDYM `sessions-snapshot`, czyli otwarciu albo wznowieniu strumienia listy. Eventy
  /// `notes` z przerwy przepadły (serwer ich nie odtwarza), więc treść notatki sprzed nowej epoki trzeba sprawdzić.
  /// Nie wraca do zera przy wylogowaniu: model porównuje epoki równością.
  public var notesEpoch = 0

  public var transcripts: [String: TranscriptState] = [:]
  /// Kolejność użycia transkryptów, najświeższy pierwszy (LRU ``CoreLimits/maxTranscripts``).
  public var transcriptOrder: [String] = []
  /// Sesja otwarta na ekranie (zaznaczona na liście; nietykalna dla LRU).
  public var viewedSessionId: String?

  /// Trwała kolejka wysyłki (wpisy jeszcze bez echa), w kolejności wysyłki.
  public var outbox: [OutboxEntry] = []
  /// Wpis → `seq` wiadomości, która była jego echem (przejście „w locie → echo" dla UI).
  public var echoed: [UUID: Int] = [:]
  public var notices: [CardNotice] = []
  /// Etap wysyłki wpisów z załącznikiem w drodze. Właściciel: wysyłka.
  public var sendProgress: [UUID: SendProgress] = [:]
  /// Echo odroczone: od kiedy sesja z wpisem w kolejce CLI stoi CIĄGLE poza turą. Właściciel: wysyłka.
  public var queuedIdleSince: [String: Date] = [:]

  /// Flagi możliwości serwera z sondy `GET /api/version` (po zalogowaniu i po każdym `hello`);
  /// `nil` = jeszcze nie wiadomo. Zmienia `Reducer+Usage`; czytać wolno wszystkim.
  public var capabilities: Capabilities?
  /// Nazwa tailnetu Maca z tej samej sondy; `nil` = nie wiadomo albo poza tailnetem.
  public var tailnet: String?
  /// System maszyny serwera: z sondy wersji, a do niej ostatni znany z poświadczenia
  /// (`DeviceCredential.serverSystem`, zalążek przy związaniu). Sonda bez pola (serwer sprzed niego) zostawia ostatni
  /// znany; logowanie i wylogowanie go nie kasują — należy do poświadczenia, nie do połączenia. Słowo maszyny:
  /// ``serverMachine``. Zmienia `Reducer+Usage` (sonda) i `Reducer+Pairing` (związanie); zapis w Keychainie prowadzi
  /// `RarogStore+Pairing`.
  public internal(set) var serverSystem: ServerSystem?
  /// Wersja serwera z ostatniej udanej sondy wersji bieżącego połączenia (wiersz ``serverUpdate``). Przerwa łącza
  /// zostawia ostatnią znaną, więc wiersz nie miga; logowanie, wylogowanie i zmiana serwera ją kasują. Zmienia
  /// `Reducer+Usage`.
  public internal(set) var serverVersion: String?
  /// Limity planu w stopce listy. Zmienia `Reducer+Usage`.
  public var planUsage = PlanUsageState()

  /// Ostatnie projekty z serwera (`Catalog.swift`); kasowane razem ze stanem widoku.
  public var catalog = CatalogState()

  /// Sterowanie sesją z nagłówka: lista modeli, przełączenia trybu i restarty w locie.
  /// Zmienia `Reducer+Session` (`SessionControls.swift`).
  public var sessionControls = SessionControlsState()

  /// Karty decyzji i karta stanu: ostrzeżenie o zaufaniu katalogu.
  /// Zmienia `Reducer+Decisions` (`Cards.swift`).
  public var cards = CardsState()

  /// Przerwania w locie, „obejrzane" i numer zalogowania. Zmienia `Reducer+SessionControl`
  /// (`TurnControl.swift`).
  public var turnControl = TurnControlState()

  /// Dyktowanie: odmowa serwera przy pobraniu klucza (404, 503 `voice_unconfigured`) zamyka drogę Soniox do restartu
  /// serwera; mikrofonu nie chowa. Zmienia `Reducer+Voice`; trasa czyta selektor ``sonioxOnServer``.
  public var voice = VoiceAvailabilityState()

  /// Lista z pamięci podręcznej przy zimnym starcie. Zmienia `Reducer+ListCache`;
  /// bramki nieświeżości w `Selectors+Stale`.
  public var listCache = ListCacheState()

  /// Ostatni sygnał „inna sesja czegoś chce" — źródło dymka. Zmienia `Reducer+Signals`.
  public var signal: SessionSignal?

  /// Terminale z `GET /api/term` (zakładki projektu, popupy). Zmienia `Reducer+Terminal`; treści
  /// terminala tu nie ma i nie będzie — wyłącznie id, katalog, slot, rola i nazwa procesu.
  public var terminals = TerminalListState()

  /// Znak wodny przejść stanu: najpóźniejszy `stateSince`, jaki karta sesji miała (do wylogowania albo
  /// zniknięcia z listy). Korekta czasu TEGO SAMEGO stanu (import historii, replay) cofa `stateSince`,
  /// ale nie znak, więc następne starsze przejście z tego samego replayu dalej wygląda na starsze.
  /// Zmienia wyłącznie reduktor (`isOlderStateChange`).
  var stateFloors: [String: Date] = [:]

  /// Obraz listy WYŁĄCZNIE ze strumienia globalnego, w jego kolejności (zapis liczników kafla z apki): pełny
  /// stan, `session-changed` i `state` tego strumienia (``noteGlobalList(_:)``). ``sessions`` łączy go ze strumieniem
  /// oglądanej sesji i z odpowiedziami HTTP; ich nowszy `stateSince` podniósłby znacznik zapisu ponad push, którego
  /// treści strumień globalny jeszcze nie dowiózł. Pamięć podręczna z dysku go nie wypełnia, zeruje go `resetView`.
  /// Zmienia wyłącznie reduktor.
  var globalList: [String: SessionSummary] = [:]

  /// Powiadomienia APNs tego urządzenia: zgoda, baner „Włącz", degradacja tokenu, dymki, cel tapnięcia.
  /// Zmienia `Reducer+Push`; czas i system prowadzi `RarogStore+Push`.
  public var push = PushState()

  /// Ostatni etap tury każdej sesji w turze: linia pod pracującym wierszem listy stoi do końca tury,
  /// zamiast znikać przy każdej wiadomości. Zmienia wyłącznie reduktor (`Reducer+List`).
  public internal(set) var turnStage: [String: TurnStage] = [:]

  /// Wyniki widziane na TYM urządzeniu jako nieodebrane: sesja → `stateSince` wyniku. Taki wiersz stoi
  /// w kolejności listy wśród nieodebranych także po odczycie (``listOrderRank(_:)``). Zmienia wyłącznie
  /// reduktor (`Reducer+List`).
  public internal(set) var heldUnread: [String: String] = [:]

  /// Wiersz zaznaczony na liście — lustro zaznaczenia nawigacji, także wpis Codexa na trasie jego terminala
  /// (``viewedSessionId`` to strumień transkryptu, Codexa nie zna). Zwinięty projekt drzewa go nie chowa
  /// (``treeShows(_:collapsed:)``). Jak ``viewedSessionId`` przeżywa wylogowanie: zaznaczenie nawigacji też.
  /// Zmienia wyłącznie reduktor (`Reducer+List`).
  public internal(set) var listSelection: String?

  /// Sesje ostatnio otwarte na TYM urządzeniu: sesja → `stateSince` z chwili zejścia z jej wiersza.
  /// Zwinięty projekt pokazuje taki wiersz do spokojnej chwili — tych samych wyzwalaczy co ``heldUnread``
  /// — albo do ręcznego zwinięcia lub rozwinięcia jego projektu: tap w inny wiersz nie chowa poprzedniego pod
  /// palcem. Zmienia wyłącznie reduktor (`Reducer+List`).
  public internal(set) var heldOpen: [String: String] = [:]

  /// Obciążenie Maca w stopce listy: ostatni udany odczyt `GET /api/mac` w terminie ważności. Zmienia
  /// `Reducer+Mac`; odczyty i termin prowadzi `RarogStore+Mac` w harmonogramie limitów.
  public internal(set) var macLoad = MacLoadState()

  /// Slash-komendy oglądanej sesji do podpowiedzi po „/”. Zmienia `Commands.swift`; odczyt
  /// prowadzi `RarogStore+Commands`.
  public internal(set) var commands = CommandListState()

  /// Parowanie i klucz urządzenia: z czym apka rozmawia, arkusz „Sparować z …?”, odpięcie, kod dla
  /// nowego urządzenia, lista urządzeń i notki o nowych. Zmienia `Reducer+Pairing`; akcje: `RarogStore+Pairing`.
  public internal(set) var pairing = PairingState()

  /// The app's status in the iroh relay registry, as the registry client reports it (`RarogStore.relayAccessChanged`;
  /// the "Server" screen). It belongs to the device, not to a server or a login: logout and switching servers leave
  /// it. Changed only by `Reducer+Pairing`.
  public internal(set) var relayAccess: RelayAccessStatus = .inactive

  /// Queue take-backs: requests in flight and the ids of take-backs without a definitive answer. Changed only by
  /// `Reducer+QueueTakeBack`; the action is `RarogStore+QueueTakeBack`.
  public internal(set) var queueTakeBack = QueueTakeBackState()

  public init(clientBuild: Int) {
    self.clientBuild = clientBuild
  }
}
