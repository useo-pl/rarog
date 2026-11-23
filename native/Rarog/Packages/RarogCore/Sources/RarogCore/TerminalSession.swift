import Foundation
import Observation
import RarogContract
import RarogTransport

// Sesja terminala apki natywnej: czysta maszyna stanów połączenia (`TerminalMachine`)
// i obiekt, który wykonuje jej skutki (`TerminalSession`): `POST /api/term` przed próbą (rejestr terminali żyje
// w RAM serwera, a Rarog restartuje się po każdej zmianie w `server/`), gniazdo WS, rytm ponawiania 1/2/5 s,
// kolejka wyjścia z bramką zgodności. Wyjątek: próba świeża (start, powrót
// z tła) przy znanym id powłoki albo okna Cmd+F idzie gniazdem bez `POST` (`direct=1`), o jeden obieg sieci
// krócej; odmowę serwera (gniazdo zamknięte przed otwarciem) ta sama próba ponawia od razu przez `POST`.
//
// Treść terminala nie trafia do logów, na dysk ani do pamięci podręcznej: ten plik nie
// loguje, nie zapisuje i nie przekazuje bajtów nigdzie poza `onBytes`. Czasy próby świeżej (`onConnectTiming`,
// ślad otwarcia terminala) to same chwile zegara monotonicznego.

/// Transport terminala widziany z rdzenia. Produkcja: ``RarogClient``; testy: atrapa.
public protocol TerminalTransporting: Sendable {
  func openTerminal(_ body: TerminalOpenBody) async throws(TransportError) -> TerminalOpenResponse
  func terminals() async throws(TransportError) -> TerminalList
  func terminalHistory(id: String, lines: Int) async throws(TransportError) -> TerminalHistory
  func closeTerminal(id: String) async throws(TransportError)
  /// Bramka zgodności dla wejścia (`in`/`rs`/`sc`): odmowa = niezgodność trwała.
  func checkTerminalInput() async throws(MutationRefusal)
  /// `direct` = gniazdo próby bez `POST` (znacznik `direct=1`).
  func terminalSocket(id: String, fresh: Bool, direct: Bool, grid: TerminalGrid?) throws(TransportError)
    -> any TerminalSocketing
}

extension RarogClient: TerminalTransporting {}

// MARK: - Cel i stany

/// Co otworzyć i jak to odtwarzać przy każdym połączeniu.
public struct TerminalTarget: Sendable, Equatable {
  public let role: TerminalRole
  /// Katalog projektu. Bez niego nie ma czym odtworzyć wpisu w rejestrze serwera (brak `POST`), więc po
  /// trzech zerwaniach z rzędu terminal jest „nie ma" (`missing`).
  public let cwd: String?
  /// Id terminala; `nil` do pierwszej odpowiedzi `POST /api/term`.
  public private(set) var id: String?
  /// Slot powłoki projektu (`nil` przy roli popupowej). `next` WYŁĄCZNIE przy świadomym „Nowy terminal";
  /// po pierwszej odpowiedzi zamienia się w numer, który dostał terminal — ponowienia nie zakładają nowej
  /// powłoki.
  public private(set) var slot: TerminalSlot?

  private init(role: TerminalRole, cwd: String?, id: String?, slot: TerminalSlot?) {
    self.role = role
    self.cwd = cwd
    self.id = id
    self.slot = slot
  }

  /// Terminal z listy (`GET /api/term`): ten sam katalog, slot i rola przy każdym połączeniu.
  public static func existing(_ entry: TerminalListEntry) -> TerminalTarget {
    let slot: TerminalSlot? = entry.role.isPopup || entry.slot < 1 ? nil : .number(entry.slot)
    return TerminalTarget(role: entry.role, cwd: entry.cwd, id: entry.id, slot: slot)
  }

  /// Powłoka projektu w konkretnym slocie (1 = pierwszy terminal projektu).
  public static func shell(cwd: String, slot: Int = 1) -> TerminalTarget? {
    guard TerminalOpenBody(cwd: cwd, slot: .number(slot), role: .shell) != nil else { return nil }
    return TerminalTarget(role: .shell, cwd: cwd, id: nil, slot: .number(slot))
  }

  /// ŚWIADOME „Nowy terminal": najniższy wolny slot wybiera serwer.
  public static func newShell(cwd: String) -> TerminalTarget? {
    guard TerminalOpenBody(cwd: cwd, slot: .next, role: .shell) != nil else { return nil }
    return TerminalTarget(role: .shell, cwd: cwd, id: nil, slot: .next)
  }

  /// Panel w popupie (`lazygit` pod Cmd+G, `popup` pod Cmd+F): jeden na katalog i rolę, bez slotu.
  public static func popup(cwd: String, role: TerminalRole) -> TerminalTarget? {
    guard role.isPopup, TerminalOpenBody(cwd: cwd, role: role) != nil else { return nil }
    return TerminalTarget(role: role, cwd: cwd, id: nil, slot: nil)
  }

  /// Sam id bez katalogu (np. wiersz Codexa z `termId`, którego nie ma na liście): łączy się wprost.
  public static func id(_ id: String, role: TerminalRole = .shell) -> TerminalTarget? {
    guard TerminalWire.isTerminalId(id) else { return nil }
    return TerminalTarget(role: role, cwd: nil, id: id, slot: nil)
  }

  /// Ciało `POST /api/term`, które odtwarza TEN terminal; `nil` bez katalogu.
  var openBody: TerminalOpenBody? {
    guard let cwd else { return nil }
    return TerminalOpenBody(cwd: cwd, slot: role.isPopup ? nil : slot, role: role)
  }

  mutating func adopt(_ response: TerminalOpenResponse) {
    id = response.id
    if !role.isPopup, response.slot >= 1 { slot = .number(response.slot) }
  }
}

/// Stan połączenia terminala.
public enum TerminalPhase: Sendable, Hashable {
  /// Przed `start()` albo po `stop()`.
  case idle
  /// Pierwsza próba (albo pierwsza po geście, powrocie z tła).
  case connecting
  /// Gniazdo otwarte: bajty płyną, wejście wychodzi.
  case live
  /// Ponawianie po zerwaniu; `attempt` = zerwania z rzędu (1, 2, 3…).
  case reconnecting(attempt: Int)
  /// Apka w tle: gniazdo zamknięte, powrót na wierzch = nowe gniazdo `fresh=1`.
  case suspended
  /// Terminala nie ma (trzy zerwania z rzędu bez katalogu do odtworzenia wpisu).
  case missing
  /// Powłoka (albo program popupu) się skończyła — ramka `exit`.
  case exited
  case failed(TerminalFailure)

  /// Stan, z którego automat nie wychodzi sam: wraca wyłącznie gest człowieka (``TerminalSession/restart()``).
  public var isHalted: Bool {
    switch self {
    case .missing, .exited, .failed: true
    case .idle, .connecting, .live, .reconnecting, .suspended: false
    }
  }
}

/// Dlaczego terminal stoi.
public enum TerminalFailure: Sendable, Hashable {
  /// Odpowiedź serwera: ramka `err` (limit, `failed` rejestru, obcy kontroler) albo odmowa `POST /api/term`
  /// (409 `term-limit`, killswitch herdr, 400 katalog spoza korzeni). Zdanie serwera; `nil` = brak zdania.
  case server(String?)
  /// Niezgodność trwała apki i serwera (`tooOld`, `protocolMismatch`) — zdanie bramki.
  case incompatible(String)
  /// 401: logowanie wygasło (magazyn wylogowuje).
  case unauthorized
  /// Nie wiadomo, czy NOWY terminal (`slot: next`) powstał: żądanie mogło dojść do serwera, a odpowiedź nie
  /// wróciła. Automat nie prosi o kolejny (drugi `next` = druga powłoka); gest ``TerminalSession/restart()``
  /// świadomie prosi od nowa, a nowy wpis widać na liście terminali projektu.
  case newTerminalUnconfirmed
}

/// Zdarzenie dla widoku, poza stanem.
public enum TerminalSessionEvent: Sendable, Hashable {
  /// Ramka `exit`: popup (lazygit po `q`, `exit` w powłoce) zamyka się sam.
  case exited
  /// `POST /api/term` oddał inny id niż znany (przeniesiony katalog, inny realpath).
  case retargeted(id: String)
  /// 401 przy otwieraniu — magazyn wylogowuje.
  case unauthorized
}

/// Los wejścia (pisanie, wklejka).
public enum TerminalInputOutcome: Sendable, Hashable {
  /// W kolejce gniazda (kolejność zachowana).
  case queued
  /// Pusty tekst — nic do wysłania.
  case empty
  /// Gniazdo nie żyje: wejście przepada (ponowne połączenie go NIE dośle).
  case notConnected
  /// Wklejka ponad ``TerminalWire/maxPasteBytes`` (512 kB) — nie poszedł ani jeden bajt. Zdanie mówi widok
  /// (serwer nadmiar odrzuca bez słowa do klienta).
  case tooLarge
}

/// Czasy jednej próby świeżej (start, wznowienie) od jej startu do pierwszych bajtów gniazda — materiał śladu
/// otwarcia terminala w `client.log` (linię składa ekran, który dokłada chwilę pojawienia się i narysowania).
/// Same chwile zegara monotonicznego, zero treści terminala.
public struct TerminalConnectTiming: Sendable, Equatable {
  /// Co zaczęło próbę.
  public enum Trigger: Sendable, Equatable {
    /// ``TerminalSession/start()``: pierwsze połączenie ekranu (albo łączenie po odmowie `DELETE`).
    case start
    /// ``TerminalSession/resume()``: powrót apki z tła.
    case resume
  }

  /// Krok `POST /api/term` przed gniazdem.
  public enum Open: Sendable, Equatable {
    /// `POST` na starcie próby; chwila odpowiedzi.
    case answered(ContinuousClock.Instant)
    /// Gniazdo bez `POST`: cel bez katalogu albo znane id powłoki i okna Cmd+F.
    case skipped
    /// Gniazdo bez `POST` zamknięte przed otwarciem, potem `POST`; chwila jego odpowiedzi. Liczy się od
    /// startu próby, razem z odrzuconym gniazdem.
    case answeredAfterRefusal(ContinuousClock.Instant)
  }

  public var trigger: Trigger
  public var started: ContinuousClock.Instant
  public var open: Open
  public var socketOpened: ContinuousClock.Instant
  public var firstBytes: ContinuousClock.Instant

  public init(
    trigger: Trigger, started: ContinuousClock.Instant, open: Open, socketOpened: ContinuousClock.Instant,
    firstBytes: ContinuousClock.Instant
  ) {
    self.trigger = trigger
    self.started = started
    self.open = open
    self.socketOpened = socketOpened
    self.firstBytes = firstBytes
  }

  /// Koniec kroku `POST` (pominięty: start próby) — od tej chwili liczy się gniazdo.
  public var openEnded: ContinuousClock.Instant {
    switch open {
    case let .answered(at), let .answeredAfterRefusal(at): at
    case .skipped: started
    }
  }
}

/// Rytm ponawiania — wstrzykiwany (testy).
public struct TerminalTiming: Sendable, Equatable {
  /// Odstęp przed próbą numer `n` (0 = pierwsza po zerwaniu); dalej ostatni (`TERM_BACKOFF_MS`: 1/2/5 s,
  /// płaski, bo po drugiej stronie stoi człowiek z otwartym terminalem).
  public var backoff: [Duration]
  /// Ile zerwań z rzędu bez katalogu znaczy „terminala nie ma" (`TERM_MISSING_AFTER`).
  public var missingAfter: Int

  public init(backoff: [Duration] = [.seconds(1), .seconds(2), .seconds(5)], missingAfter: Int = 3) {
    self.backoff = backoff
    self.missingAfter = missingAfter
  }

  public static let production = TerminalTiming()

  func delay(afterFailures failures: Int) -> Duration {
    let index = min(max(failures - 1, 0), backoff.count - 1)
    return backoff.isEmpty ? .seconds(5) : backoff[index]
  }
}

// MARK: - Maszyna stanów

/// Czysta maszyna stanów połączenia: `(stan, zdarzenie) → (stan, skutki)`. Numer generacji rośnie przy
/// każdej próbie, przerwaniu i zatrzymaniu; zdarzenie ze starą generacją (spóźniona odpowiedź `POST`,
/// zamknięcie porzuconego gniazda, budzik sprzed tła) nie zmienia niczego.
struct TerminalMachine: Sendable, Equatable {
  enum OpenFailure: Sendable, Equatable {
    /// 4xx/5xx serwera — zdanie serwera; ponawianie niczego nie zmieni.
    case answered(String?)
    /// Bramka zgodności: niezgodność trwała.
    case incompatible(String)
    case unauthorized
    /// Sieć, limit czasu, chwilowa odmowa bramki (brak listy po powrocie): ponowić. `maybeProcessed` =
    /// żądanie mogło dojść do serwera (limit czasu, zerwane połączenie, nieczytelna odpowiedź); `false` =
    /// na pewno nie wyszło (brak sieci, bramka). Dla `next` rozstrzyga, czy wolno poprosić drugi raz.
    case transient(maybeProcessed: Bool)
  }

  enum Event: Sendable, Equatable {
    case start
    /// Gest człowieka: „Uruchom ponownie" / „Spróbuj od nowa" — łączy OD RAZU, od zera.
    case restart
    case suspend
    case resume
    case stop
    case opened(generation: Int, TerminalOpenResponse)
    case openFailed(generation: Int, OpenFailure)
    case socketOpened(generation: Int)
    case socketClosed(generation: Int)
    case serverFrame(generation: Int, TerminalServerFrame)
    case retryDue(generation: Int)
    /// Bramka zgodności odmówiła (wejście albo przed gniazdem) — niezgodność trwała.
    case incompatible(String)
  }

  enum Effect: Sendable, Equatable {
    /// `POST /api/term` z tym ciałem.
    case open(generation: Int, TerminalOpenBody)
    /// Gniazdo do tego id; `fresh` = emulator bez stanu (pełna ramka od serwera); `direct` = próba bez `POST`
    /// (znacznik `direct=1`), której odmowę serwer daje zamknięciem gniazda przed otwarciem.
    case connect(generation: Int, id: String, fresh: Bool, direct: Bool = false)
    /// Zamknij bieżące gniazdo i porzuć kolejkę wyjścia (reszta wklejki NIE dosyła się sama).
    case disconnect
    case retry(generation: Int, after: Duration)
    case cancelRetry
    /// Gniazdo otwarte: `rs` z bieżącym rozmiarem (serwer mógł wstać w innym — drugi klient, świeży wpis).
    case syncGrid
    case notify(TerminalSessionEvent)
  }

  private(set) var phase: TerminalPhase = .idle
  private(set) var generation = 0
  /// Zerwania z rzędu; zeruje je dopiero otwarte gniazdo (albo gest, powrót z tła).
  private(set) var failures = 0
  private(set) var target: TerminalTarget
  private var fresh = true
  /// Generacja `POST` z `slot: next`, którego wyniku jeszcze nie znamy. Przydział slotu nie jest
  /// idempotentny (każdy `next` zakłada nową powłokę), więc odpowiedź takiego żądania przyjmujemy z KAŻDEJ
  /// generacji (wiedza o slocie), a dopóki nie przyszła, nowa próba nie wysyła drugiego `next`, tylko czeka.
  private var allocation: Int?
  /// Próba czeka na wynik zaległego przydziału zamiast wysłać własny `POST`.
  private var awaitingAllocation = false
  /// Generacja próby bez `POST`, dopóki jej gniazdo się nie otworzyło. Zamknięcie przed otwarciem to odmowa
  /// serwera (albo sieć): ta sama próba świeża idzie od razu przez `POST`, raz. Każda zmiana generacji ją unieważnia.
  private var directAttempt: Int?
  /// Generacja próby z `POST` po odmowie gniazda bez `POST` (ślad otwarcia: „POST po odmowie”).
  private var refusedDirect: Int?
  let timing: TerminalTiming

  init(target: TerminalTarget, timing: TerminalTiming = .production) {
    self.target = target
    self.timing = timing
  }

  private var attempting: Bool {
    switch phase {
    case .connecting, .reconnecting: true
    default: false
    }
  }

  private var running: Bool { attempting || phase == .live }

  /// Bieżąca próba to `POST` po odmowie gniazda bez `POST` — ta sama próba świeża, tylko dłuższa.
  var retriesAfterDirectRefusal: Bool { refusedDirect == generation }

  mutating func handle(_ event: Event) -> [Effect] {
    switch event {
    case .start:
      guard phase == .idle else { return [] }
      failures = 0
      return attempt(fresh: true, direct: true)
    case .restart:
      failures = 0
      // Gest człowieka: zawsze przez `POST` — jedyna droga, która zdejmuje `failed` i przelicza uchwyt panelu.
      guard phase != .idle else { return attempt(fresh: true) }
      // Świadoma prośba od nowa, także o nowy slot, gdy poprzedni wynik jest nieznany.
      allocation = nil
      return [.disconnect, .cancelRetry] + attempt(fresh: true)
    case .suspend:
      guard running else { return [] }
      generation += 1
      phase = .suspended
      awaitingAllocation = false
      return [.disconnect, .cancelRetry]
    case .resume:
      guard phase == .suspended else { return [] }
      failures = 0
      return attempt(fresh: true, direct: true)
    case .stop:
      guard phase != .idle else { return [] }
      generation += 1
      phase = .idle
      return [.disconnect, .cancelRetry]
    case let .opened(generation, response):
      let previous = target.id
      let allocated = generation == allocation
      if allocated {
        allocation = nil
        target.adopt(response)
      }
      let waited = allocated && awaitingAllocation && attempting
      guard (generation == self.generation && attempting) || waited else { return [] }
      awaitingAllocation = false
      target.adopt(response)
      var effects: [Effect] = []
      if let previous, previous != response.id { effects.append(.notify(.retargeted(id: response.id))) }
      effects.append(.connect(generation: self.generation, id: response.id, fresh: fresh))
      return effects
    case let .openFailed(generation, failure):
      let allocated = generation == allocation
      // Serwer odpowiedział albo żądanie nie wyszło: przydziału nie było. Wynik niepewny zostaje niepewny.
      if allocated, failure != .transient(maybeProcessed: true) { allocation = nil }
      let waited = allocated && awaitingAllocation && attempting
      guard (generation == self.generation && attempting) || waited else { return [] }
      awaitingAllocation = false
      switch failure {
      case let .answered(message): return halt(.failed(.server(message)))
      case let .incompatible(message): return halt(.failed(.incompatible(message)))
      case .unauthorized: return halt(.failed(.unauthorized)) + [.notify(.unauthorized)]
      case let .transient(maybeProcessed):
        if maybeProcessed, target.slot == .next { return halt(.failed(.newTerminalUnconfirmed)) }
        failures += 1
        return scheduleRetry()
      }
    case let .socketOpened(generation):
      guard generation == self.generation, attempting else { return [] }
      directAttempt = nil
      failures = 0
      fresh = false
      phase = .live
      return [.syncGrid]
    case let .socketClosed(generation):
      guard generation == self.generation, running else { return [] }
      if directAttempt == generation {
        // Odmowa gniazda bez `POST`: od razu `POST` w tej samej próbie świeżej — bez zerwania na liczniku
        // i bez czekania. Odmowa dotyczy tylko gniazda bez `POST`, więc pętli nie ma.
        let effects: [Effect] = [.disconnect] + attempt(fresh: fresh)
        refusedDirect = self.generation
        return effects
      }
      failures += 1
      if target.openBody == nil, failures >= timing.missingAfter { return halt(.missing) }
      return [.disconnect] + scheduleRetry()
    case let .serverFrame(generation, frame):
      guard generation == self.generation, running else { return [] }
      switch frame {
      case .hello: return []
      case .exit: return halt(.exited) + [.notify(.exited)]
      case let .error(message, _): return halt(.failed(.server(message)))
      }
    case let .retryDue(generation):
      guard generation == self.generation, case .reconnecting = phase else { return [] }
      return attempt(fresh: false)
    case let .incompatible(message):
      guard running || phase == .suspended else { return [] }
      return halt(.failed(.incompatible(message)))
    }
  }

  /// Jedna próba: `POST` (gdy jest katalog), potem gniazdo; bez katalogu — gniazdo wprost. `direct` (start, powrót
  /// z tła) pozwala pominąć `POST` przy znanym id: patrz ``directId``.
  private mutating func attempt(fresh: Bool, direct: Bool = false) -> [Effect] {
    generation += 1
    self.fresh = fresh
    phase = failures == 0 ? .connecting : .reconnecting(attempt: failures)
    if target.slot == .next, allocation != nil {
      // Poprzedni `next` jeszcze bez wyniku (np. tło w trakcie żądania): jego odpowiedź poprowadzi tę próbę.
      awaitingAllocation = true
      return []
    }
    if direct, let id = directId {
      directAttempt = generation
      return [.connect(generation: generation, id: id, fresh: fresh, direct: true)]
    }
    if let body = target.openBody {
      if target.slot == .next { allocation = generation }
      return [.open(generation: generation, body)]
    }
    if let id = target.id { return [.connect(generation: generation, id: id, fresh: fresh)] }
    return halt(.missing)
  }

  /// Id dla gniazda bez `POST`: znane id, katalog, który po odmowie odtworzy wpis `POST`-em, rola powłoki
  /// albo okna Cmd+F i slot już przydzielony. Lazygit zawsze przez `POST` — tylko on sprawdza zastany
  /// panel; cel bez katalogu łączy się wprost, bez znacznika (nie ma czym zrobić `POST` po odmowie).
  private var directId: String? {
    guard let id = target.id, target.openBody != nil, target.role == .shell || target.role == .popup,
      target.slot != .next
    else { return nil }
    return id
  }

  private mutating func scheduleRetry() -> [Effect] {
    generation += 1
    phase = .reconnecting(attempt: failures)
    return [.retry(generation: generation, after: timing.delay(afterFailures: failures))]
  }

  private mutating func halt(_ next: TerminalPhase) -> [Effect] {
    generation += 1
    awaitingAllocation = false
    phase = next
    return [.disconnect, .cancelRetry]
  }
}

// MARK: - Sesja

/// Jeden terminal na ekranie (trasa, popup) — połączenie, ponawianie i kolejka wyjścia.
///
/// Widok podpina ``onBytes`` (bajty PTY do emulatora) i ``gridProvider`` (rozmiar zmierzony PRZED
/// upgrade'em), woła ``start()`` i oddaje wejście przez ``send(_:)``, ``paste(_:)``, ``resize(_:force:)``
/// i ``scroll(lines:cell:)``. Tło, wylogowanie i zmiana ekranu wołają ``suspend()``/``stop()`` (magazyn
/// robi to sam dla sesji z ``RarogStore/terminalSession(_:)``).
@MainActor
@Observable
public final class TerminalSession {
  public private(set) var phase: TerminalPhase = .idle
  /// Id terminala; zmienia się po pierwszym `POST` (nowy terminal) albo przy przeniesionym katalogu.
  public private(set) var terminalId: String?
  public let role: TerminalRole
  public let cwd: String?

  /// Bajty PTY w kolejności odbioru — wyłącznie z bieżącego, żywego gniazda.
  @ObservationIgnored public var onBytes: ((Data) -> Void)?
  @ObservationIgnored public var onEvent: ((TerminalSessionEvent) -> Void)?
  /// Rozmiar siatki zmierzony teraz (`nil` = brak układu); pytany tuż przed każdym upgrade'em.
  @ObservationIgnored public var gridProvider: (() -> TerminalGrid?)?
  /// Zdarzenia dla magazynu (401 wylogowuje) — przed ``onEvent`` widoku.
  @ObservationIgnored var storeHook: ((TerminalSessionEvent) -> Void)?
  /// Czasy próby świeżej (start, wznowienie), raz, przy jej pierwszych bajtach — tuż przed ``onBytes``.
  /// Ponowienia po zerwaniu i gest ``restart()`` ich nie mają; próba porzucona przed bajtami też nie.
  @ObservationIgnored public var onConnectTiming: ((TerminalConnectTiming) -> Void)?

  @ObservationIgnored private var machine: TerminalMachine
  @ObservationIgnored private let transport: any TerminalTransporting
  /// Tłumacz zdań serwera: ramka `err` z `msgRef` staje w języku apki.
  @ObservationIgnored private let renderer: SentenceRenderer
  @ObservationIgnored private let sleep: @Sendable (Duration) async -> Void
  /// Zegar monotoniczny znaczników próby (testy: atrapa).
  @ObservationIgnored private let clock: @MainActor () -> ContinuousClock.Instant
  /// Znaczniki bieżącej próby świeżej, zanim przyjdą pierwsze bajty.
  @ObservationIgnored private var timingDraft: TimingDraft?
  @ObservationIgnored private var socket: (any TerminalSocketing)?
  @ObservationIgnored private var socketTask: Task<Void, Never>?
  @ObservationIgnored private var openTask: Task<Void, Never>?
  @ObservationIgnored private var retryTask: Task<Void, Never>?
  /// Ramki czekające na wysyłkę — należą do BIEŻĄCEGO gniazda i giną razem z nim.
  @ObservationIgnored private var pending: [TerminalClientFrame] = []
  @ObservationIgnored private var drain: (token: UUID, task: Task<Void, Never>)?
  /// Ostatni znany rozmiar (do query następnego upgrade'u) i ostatni wysłany `rs` na tym gnieździe.
  @ObservationIgnored private var grid: TerminalGrid?
  @ObservationIgnored private var sentGrid: TerminalGrid?

  public init(
    target: TerminalTarget, transport: any TerminalTransporting, timing: TerminalTiming = .production,
    sleep: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) },
    clock: @escaping @MainActor () -> ContinuousClock.Instant = { ContinuousClock.now },
    renderer: @escaping SentenceRenderer = ServerText.renderer(language: .current)
  ) {
    machine = TerminalMachine(target: target, timing: timing)
    self.transport = transport
    self.renderer = renderer
    self.sleep = sleep
    self.clock = clock
    role = target.role
    cwd = target.cwd
    terminalId = target.id
  }

  // MARK: Cykl życia

  public func start() { handle(.start, timing: .start) }

  /// „Uruchom ponownie" / „Spróbuj od nowa": nowe połączenie od razu, z każdego stanu.
  public func restart() { handle(.restart) }

  /// Apka w tle: gniazdo zamknięte, budzik ponawiania zgaszony.
  public func suspend() { handle(.suspend) }

  /// Powrót na wierzch: nowe gniazdo `fresh=1` z rozmiarem zmierzonym przed upgrade'em.
  public func resume() { handle(.resume, timing: .resume) }

  /// Koniec: zmiana ekranu, wylogowanie. Wszystko spóźnione po nim jest ignorowane.
  public func stop() { handle(.stop) }

  /// Niezgodność trwała (magazyn: `tooOld`/`protocolMismatch`) — gniazdo zamknięte, wejście zablokowane.
  public func block(_ message: String) { handle(.incompatible(message)) }

  // MARK: Wejście

  /// Pisanie (klawiatura, pasek klawiszy, dyktowanie): ramki `in` w budżecie 8 KiB.
  @discardableResult
  public func send(_ text: String) -> TerminalInputOutcome {
    guard !text.isEmpty else { return .empty }
    guard phase == .live, socket != nil else { return .notConnected }
    enqueue(TerminalInputChunker.frames(text))
    return .queued
  }

  /// Wklejka — OSOBNA droga od pisania: surowy tekst schowka ramkami `pa`, nigdy `in`; serwer skleja
  /// je w jedną wklejkę dla herdr. Zerwanie gniazda w trakcie porzuca resztę (serwer wyrzuca bufor), a pisanie
  /// stoi w kolejce ZA wklejką — `in` w jej środku kazałoby serwerowi odrzucić całość.
  @discardableResult
  public func paste(_ text: String) -> TerminalInputOutcome {
    guard !text.isEmpty else { return .empty }
    guard let frames = TerminalPaste.frames(text) else { return .tooLarge }
    guard phase == .live, socket != nil else { return .notConnected }
    enqueue(frames)
    return .queued
  }

  /// Nowy rozmiar siatki (po ustaleniu układu — debounce robi widok). `force` wysyła `rs` także przy tym
  /// samym rozmiarze: po odejściu drugiego klienta panel zostaje w JEGO rozmiarze.
  public func resize(_ grid: TerminalGrid, force: Bool = false) {
    self.grid = grid
    guard phase == .live, socket != nil, force || grid != sentGrid else { return }
    sentGrid = grid
    enqueue([.resize(grid)])
  }

  /// Przewinięcie historii panelu o `lines` wierszy (dodatnie = w dół) z komórką pod palcem.
  public func scroll(lines: Int, cell: TerminalCell?) {
    guard phase == .live, socket != nil else { return }
    enqueue(TerminalScrollStep.steps(for: lines, cell: cell).map { .scroll($0) })
  }

  // MARK: Maszyna i skutki

  /// `timing` = zdarzenie zaczyna próbę świeżą, której czasy idą do ``onConnectTiming`` (start, wznowienie).
  private func handle(_ event: TerminalMachine.Event, timing trigger: TerminalConnectTiming.Trigger? = nil) {
    let generation = machine.generation
    let effects = machine.handle(event)
    phase = machine.phase
    terminalId = machine.target.id
    noteTiming(event, effects: effects, began: machine.generation != generation ? trigger : nil)
    for effect in effects { perform(effect) }
  }

  /// Znaczniki próby świeżej: start, gdy `start`/`resume` zaczęły próbę; koniec `POST`, gdy gniazdo zleca odpowiedź
  /// (gniazdo zlecone od razu = `POST` pominięty); otwarcie gniazda. Zmiana generacji (ponowienie, tło, gest,
  /// zatrzymanie) porzuca je bez śladu — poza odmową gniazda bez `POST`: wtedy ta sama próba idzie dalej
  /// przez `POST`, a jej odpowiedź to „POST po odmowie”, liczony od startu próby.
  private func noteTiming(
    _ event: TerminalMachine.Event, effects: [TerminalMachine.Effect], began trigger: TerminalConnectTiming.Trigger?
  ) {
    if var draft = timingDraft, draft.generation != machine.generation {
      if case let .socketClosed(closed) = event, closed == draft.generation, machine.retriesAfterDirectRefusal {
        draft.generation = machine.generation
        draft.open = nil
        draft.refused = true
        timingDraft = draft
      } else {
        timingDraft = nil
      }
    }
    if let trigger, machine.phase == .connecting {
      timingDraft = TimingDraft(trigger: trigger, generation: machine.generation, started: clock())
    }
    guard var draft = timingDraft else { return }
    for case let .connect(generation, _, _, _) in effects where generation == draft.generation && draft.open == nil {
      if case .opened = event {
        draft.open = draft.refused ? .answeredAfterRefusal(clock()) : .answered(clock())
      } else {
        draft.open = .skipped
      }
    }
    if case let .socketOpened(generation) = event, generation == draft.generation, machine.phase == .live,
      draft.open != nil
    {
      draft.socketOpened = clock()
    }
    timingDraft = draft
  }

  /// Pierwsze bajty próby świeżej: jej czasy idą do widoku raz, przed samymi bajtami.
  private func reportConnectTiming(generation: Int) {
    guard let draft = timingDraft else { return }
    timingDraft = nil
    guard draft.generation == generation, let open = draft.open, let socketOpened = draft.socketOpened else { return }
    onConnectTiming?(TerminalConnectTiming(
      trigger: draft.trigger, started: draft.started, open: open, socketOpened: socketOpened, firstBytes: clock()))
  }

  /// Znaczniki próby świeżej przed pierwszymi bajtami.
  private struct TimingDraft {
    let trigger: TerminalConnectTiming.Trigger
    /// Generacja próby; po odmowie gniazda bez `POST` — generacja jej `POST`.
    var generation: Int
    let started: ContinuousClock.Instant
    var open: TerminalConnectTiming.Open?
    var socketOpened: ContinuousClock.Instant?
    /// Gniazdo bez `POST` tej próby dostało odmowę.
    var refused = false
  }

  private func perform(_ effect: TerminalMachine.Effect) {
    switch effect {
    case let .open(generation, body):
      open(body, generation: generation)
    case let .connect(generation, id, fresh, direct):
      connect(id: id, fresh: fresh, direct: direct, generation: generation)
    case .disconnect:
      disconnect()
    case let .retry(generation, delay):
      retryTask?.cancel()
      let sleep = sleep
      retryTask = Task { [weak self] in
        await sleep(delay)
        guard !Task.isCancelled else { return }
        self?.handle(.retryDue(generation: generation))
      }
    case .cancelRetry:
      retryTask?.cancel()
      retryTask = nil
    case .syncGrid:
      sentGrid = nil
      if let grid { resize(grid, force: true) }
    case let .notify(event):
      storeHook?(event)
      onEvent?(event)
    }
  }

  private func open(_ body: TerminalOpenBody, generation: Int) {
    let transport = transport
    openTask = Task { [weak self] in
      let event: TerminalMachine.Event
      do throws(TransportError) {
        event = .opened(generation: generation, try await transport.openTerminal(body))
      } catch {
        guard let failure = Self.openFailure(error) else { return }
        event = .openFailed(generation: generation, failure)
      }
      self?.handle(event)
    }
  }

  /// Gniazdo dla bieżącej próby. Bramka zgodności przed gniazdem: terminal bez katalogu i próba bez `POST`
  /// nie przechodzą przez `POST`, a niezgodność trwała ma je zatrzymać tak samo.
  private func connect(id: String, fresh: Bool, direct: Bool, generation: Int) {
    let transport = transport
    openTask = Task { [weak self] in
      do throws(MutationRefusal) {
        try await transport.checkTerminalInput()
      } catch {
        // Odmowa porzuconej próby nie ma prawa zatrzymać nowszej (gest, powrót z tła w trakcie czekania).
        guard let self, !Task.isCancelled, generation == self.machine.generation else { return }
        self.handle(.incompatible(error.message))
        return
      }
      self?.openSocket(id: id, fresh: fresh, direct: direct, generation: generation)
    }
  }

  private func openSocket(id: String, fresh: Bool, direct: Bool, generation: Int) {
    guard generation == machine.generation else { return }
    if let measured = gridProvider?() { grid = measured }
    let socket: any TerminalSocketing
    do {
      socket = try transport.terminalSocket(id: id, fresh: fresh, direct: direct, grid: grid)
    } catch {
      // Adres nie do zbudowania — jak każde inne zerwanie (PWA: `openSocket`).
      handle(.socketClosed(generation: generation))
      return
    }
    self.socket = socket
    socketTask = Task { [weak self] in
      for await event in socket.events {
        guard let self else { return }
        self.received(event, generation: generation)
      }
    }
  }

  private func received(_ event: TerminalSocketEvent, generation: Int) {
    guard generation == machine.generation else { return }
    switch event {
    case .opened: handle(.socketOpened(generation: generation))
    case let .bytes(data):
      guard phase == .live else { return }
      reportConnectTiming(generation: generation)
      onBytes?(data)
    case var .frame(frame):
      // Jedyne miejsce tłumaczenia ramek terminala: automat dostaje zdanie gotowe do pokazania.
      frame.translate(renderer)
      handle(.serverFrame(generation: generation, frame))
    case .closed: handle(.socketClosed(generation: generation))
    }
  }

  private func disconnect() {
    pending.removeAll()
    drain?.task.cancel()
    drain = nil
    // `POST` w drodze NIE jest anulowany: jego wynik odcina generacja, a przy `next` niesie wiedzę, który
    // slot dostał nowy terminal (bez niej powrót z tła zakładałby drugi).
    openTask = nil
    socketTask?.cancel()
    socketTask = nil
    socket?.close()
    socket = nil
    sentGrid = nil
  }

  /// Kolejka wyjścia: jedna ramka po drugiej, każda przez bramkę zgodności. Ramki należą do gniazda, przy
  /// którym weszły — zerwanie czyści kolejkę i nic nie dosyła się do następnego.
  private func enqueue(_ frames: [TerminalClientFrame]) {
    guard !frames.isEmpty else { return }
    pending.append(contentsOf: frames)
    guard drain == nil else { return }
    let token = UUID()
    let generation = machine.generation
    drain = (token, Task { [weak self] in await self?.drainPending(generation: generation, token: token) })
  }

  private func drainPending(generation: Int, token: UUID) async {
    defer { if drain?.token == token { drain = nil } }
    let transport = transport
    while !pending.isEmpty, !Task.isCancelled, generation == machine.generation, let socket {
      do throws(MutationRefusal) {
        try await transport.checkTerminalInput()
      } catch {
        guard !Task.isCancelled, generation == machine.generation else { return }
        handle(.incompatible(error.message))
        return
      }
      guard !Task.isCancelled, generation == machine.generation, !pending.isEmpty else { return }
      let frame = pending.removeFirst()
      // `false` = gniazdo padło; koniec przyjdzie zdarzeniem `closed`, które wyczyści resztę kolejki.
      guard await socket.send(frame) else { return }
    }
  }

  /// Błąd `POST /api/term` → los próby; `nil` = żądanie anulowane przez nas (bez skutku).
  nonisolated static func openFailure(_ error: TransportError) -> TerminalMachine.OpenFailure? {
    switch error {
    case let .http(failure), let .forbidden(failure), let .rateLimited(failure):
      return .answered(failure.message)
    case .unauthorized:
      return .unauthorized
    case let .refused(refusal):
      return refusal.transient ? .transient(maybeProcessed: false) : .incompatible(refusal.message)
    case let .offline(code):
      return .transient(maybeProcessed: !neverSent.contains(code))
    case .timedOut, .invalidResponse:
      return .transient(maybeProcessed: true)
    case .cancelled:
      return nil
    }
  }

  /// Błędy, przy których żądanie na pewno nie dotarło do serwera (nie ma połączenia, nazwy, TLS).
  /// Reszta (limit czasu, zerwane połączenie w trakcie) = „mogło dojść".
  nonisolated static let neverSent: Set<URLError.Code> = [
    .notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .internationalRoamingOff,
    .callIsActive, .dataNotAllowed, .badURL, .unsupportedURL, .appTransportSecurityRequiresSecureConnection,
    .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
    .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot, .clientCertificateRejected,
    .clientCertificateRequired,
  ]
}
