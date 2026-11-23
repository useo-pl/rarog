import Foundation
import Observation
import RarogContract
import RarogCore

// Okno diffa sesji per plik: lista zmienionych plików, stan rozwinięć, kolejka odczytów patcha
// PO JEDNYM i reguły odświeżania. Okno pobiera listę i patch wyłącznie tych plików, które człowiek rozwinął —
// plik da się więc obejrzeć niezależnie od wagi zmian w pozostałych. Logika bez UIKit — testy na macOS.
// Właściciel: nagłówek.

/// Skok okna diffa do pliku stukniętego w panelu albo dymku gita: RAZ na otwarcie okna, przy pierwszej
/// pokazanej liście. Późniejsze odświeżenia nie przenoszą człowieka z powrotem do tego pliku. Plik wiąże
/// ŚCIEŻKA, nie pozycja na liście; ścieżka zakończona `/` (nieśledzony katalog z ramki `git-status`) to
/// prefiks: pierwszy plik pod nim.
public struct DiffFocus: Sendable, Equatable {
  /// Plik, od którego okno się otwiera.
  public struct Target: Sendable, Equatable {
    public let path: String
    /// Pliku nie ma na UCIĘTEJ liście: dostaje własną sekcję na górze okna (serwer sprawdza ścieżkę po
    /// pełnych listach gita, więc patch i tak da się pobrać).
    public let extra: Bool
  }

  private var path: String?

  /// `nil` = otwarcie od góry.
  public init(path: String?) {
    self.path = path
  }

  /// Cel otwarcia albo `nil` (od góry); pierwsze wołanie zużywa skok niezależnie od wyniku. Ramka `git-status`
  /// cytuje ścieżki ze znakami spoza ASCII, lista okna nie — stąd druga próba po zdjęciu cytowania.
  public mutating func take(files: [DiffListEntry], truncated: Bool) -> Target? {
    defer { path = nil }
    guard let path, !path.isEmpty else { return nil }
    let plain = PathText.gitUnquoted(path)
    for wanted in plain == path ? [path] : [path, plain] {
      if wanted.hasSuffix("/") {
        if let first = files.first(where: { $0.path.hasPrefix(wanted) }) { return Target(path: first.path, extra: false) }
      } else if files.contains(where: { $0.path == wanted }) {
        return Target(path: wanted, extra: false)
      }
    }
    // Pełna lista bez tego pliku: nie ma go w zmianach katalogu sesji (np. `../x` spoza niego).
    guard truncated, Self.requestable(plain) else { return nil }
    return Target(path: plain, extra: true)
  }

  /// Ścieżka, o którą wolno poprosić serwer: plik pod katalogiem sesji (lustro walidacji wstępnej trasy;
  /// inna dostałaby 400 `bad-path`). Katalog (`docs/`) plikiem nie jest.
  static func requestable(_ path: String) -> Bool {
    guard !path.isEmpty, !path.hasPrefix("/"), !path.hasSuffix("/") else { return false }
    return !path.split(separator: "/", omittingEmptySubsequences: false).contains { $0 == ".." || $0 == "." || $0.isEmpty }
  }
}

/// Treść sekcji pliku pod nagłówkiem.
public enum DiffFileBody: Sendable, Equatable {
  /// Plik zwinięty: sam nagłówek.
  case collapsed
  /// Pierwszy odczyt patcha w drodze albo w kolejce.
  case loading
  /// Odczyt się nie udał i nie ma czego pokazać: zdanie i „Spróbuj ponownie".
  case failed(String)
  case patch(DiffPatchBody)
}

/// Patch pliku na ekranie. Na czas odświeżenia stoi poprzednia treść (miejsce czytania nie skacze).
public struct DiffPatchBody: Sendable, Equatable {
  /// Wszystkie linie odpowiedzi, także gdy niesie więcej niż jeden blok `diff --git` (zmiana typu pliku).
  public let rows: [PatchRow]
  /// Serwer uciął patch tego pliku (512 kB) albo git doszedł do sufitu odczytu.
  public let truncated: Bool
  /// Odświeżenie się nie udało: linie to ostatnia pobrana treść, a to zdanie mówi dlaczego.
  public let stale: String?
}

/// Sekcja okna diffa: jeden plik. Tożsamość to ścieżka, więc odświeżenie listy nie przestawia sekcji, na którą
/// człowiek patrzy.
public struct DiffSection: Sendable, Equatable, Identifiable {
  public let path: String
  /// `nil` = litera spoza tej wersji apki albo plik spoza uciętej listy.
  public let status: DiffFileStatus?
  /// Brak licznika = „nie wiem", nie zero.
  public let added: Int?
  public let deleted: Int?
  public let binary: Bool
  public let expanded: Bool
  public let body: DiffFileBody

  public var id: String { path }

  /// Nagłówek jednym zdaniem dla czytnika: „src/notes.ts, zmieniony, 2 dodane linie, 2 usunięte linie".
  public var spoken: String {
    UICopy.inspectorFileSpoken(path: path, status: status, added: added, deleted: deleted, binary: binary)
  }
}

/// Model okna diffa: jedno okno, jedna sesja, jeden przebieg `run`. Żyje w widoku (`@State`), ginie z oknem.
///
/// Reguły:
/// - żądania idą PO JEDNYM; plik dopiero co stuknięty idzie przed odświeżeniami;
/// - odpowiedź dla pliku, którego sekcja dalej stoi, ZAWSZE wchodzi na ekran, także gdy rewizja repozytorium
///   zdążyła urosnąć (rośnie przy każdej ramce `usage`, czyli podczas pracy agenta co kilka sekund; wynik
///   wyrzucany przy każdej nowej rewizji nigdy by nie doszedł);
/// - odświeżenia się łączą: naraz jedno przejście (lista, potem rozwinięte pliki po jednym), a następne rusza
///   dopiero po nim i tylko raz, bez względu na liczbę ramek w międzyczasie;
/// - na czas odczytu stoi poprzednia treść, a tożsamość sekcji to ścieżka;
/// - zwinięcie zdejmuje plik z kolejki i nie kasuje pobranego patcha;
/// - 404 `diff-file-not-found` odświeża listę raz; sekcja, której na niej już nie ma, znika.
@MainActor
@Observable
public final class DiffWindowModel {
  public typealias ListFetch = (_ sessionId: String) async -> DiffFetchOutcome<DiffFileList>
  public typealias FileFetch = (_ sessionId: String, _ path: String) async -> DiffFetchOutcome<DiffFilePatch>

  /// Stan PIERWSZEJ listy; późniejsze odświeżenia zostawiają na ekranie to, co już stoi.
  public enum ListPhase: Sendable, Equatable {
    case loading
    case loaded
    /// Pierwsza lista się nie udała: zdanie i „Spróbuj ponownie".
    case failed(String)
  }

  private enum Job: Equatable {
    case list
    case file(String)
  }

  /// Pobrany plik: linie, znaczniki i rewizja, przy której poszło żądanie.
  private struct FileState {
    var rows: [PatchRow] = []
    var loaded = false
    var truncated = false
    /// Bilans policzony z patcha — tylko z kompletnego (`PatchStat`).
    var stat: PatchStat?
    var failure: String?
    /// Rewizja repozytorium w chwili żądania treści; `nil` = treści nie ma albo nie wiadomo, czy jest świeża.
    var revision: Int?
    /// 404 „nie ma na liście zmian" już raz odświeżyło listę; drugie z rzędu mówi zdaniem.
    var goneOnce = false
  }

  public let sessionId: String
  public private(set) var phase: ListPhase = .loading
  /// Serwer uciął listę na suficie (500 plików).
  public private(set) var listTruncated = false
  /// Odświeżenie listy się nie udało: sekcje to ostatni znany stan, a to zdanie mówi dlaczego.
  public private(set) var refreshFailure: String?

  /// Pierwsza lista już przyszła (także pusta).
  private var hasList = false
  private var entries: [DiffListEntry] = []
  /// Pliki spoza uciętej listy, o które poprosiło otwarcie okna: sekcje na górze.
  private var extras: [String] = []
  private var expanded: Set<String> = []
  private var files: [String: FileState] = [:]
  private var focus: DiffFocus
  private var scrollTarget: String?

  /// Ostatnia znana rewizja repozytorium sesji (`TranscriptState.repoRevision`).
  private var revision: Int
  /// Lista do pobrania: otwarcie okna, nowa rewizja, ponowienie ręką, 404 pliku.
  private var listWanted = true
  /// Pliki stuknięte ręką, najnowszy pierwszy.
  private var urgent: [String] = []
  /// Pliki bieżącego przejścia odświeżenia, w kolejności sekcji.
  private var pass: [String] = []
  private var inFlight: Job?
  @ObservationIgnored private var wake: AsyncStream<Void>.Continuation?

  /// - Parameters:
  ///   - focus: plik stuknięty w panelu albo dymku (`nil` = okno otwiera się od góry).
  ///   - revision: rewizja repozytorium sesji w chwili otwarcia; dopiero NOWSZA odświeża okno.
  public init(sessionId: String, focus: String?, revision: Int = 0) {
    self.sessionId = sessionId
    self.focus = DiffFocus(path: focus)
    self.revision = revision
  }

  // MARK: - Odczyt dla widoku

  /// Liczba plików na liście; `nil`, póki pierwsza lista nie przyszła.
  public var fileCount: Int? {
    hasList ? entries.count : nil
  }

  /// Sekcje w kolejności rysowania: najpierw pliki spoza uciętej listy, potem lista serwera.
  public var sections: [DiffSection] {
    extras.map { section(path: $0, entry: nil) } + entries.map { section(path: $0.path, entry: $0) }
  }

  public func isExpanded(_ path: String) -> Bool { expanded.contains(path) }

  /// Sekcja, do której okno ma przewinąć po pokazaniu pierwszej listy — raz na otwarcie.
  public func takeScrollTarget() -> String? {
    defer { scrollTarget = nil }
    return scrollTarget
  }

  // MARK: - Zdarzenia z widoku

  /// Nagłówek stuknięty: rozwija albo zwija plik. Zwinięcie zdejmuje plik z kolejki (żądanie w drodze dobiega
  /// i zostaje w pamięci), a pobranego patcha nie kasuje. Rozwinięcie pobiera, gdy nie ma treści albo ta, która
  /// jest, pochodzi sprzed bieżącej rewizji — wtedy stoi na ekranie do odpowiedzi.
  public func toggle(_ path: String) {
    guard known(path) else { return }
    if expanded.remove(path) != nil {
      dequeue(path)
      return
    }
    expanded.insert(path)
    let state = files[path] ?? FileState()
    files[path] = state
    if state.failure != nil { files[path]?.goneOnce = false }
    if needsFetch(state) { enqueueUrgent(path) }
  }

  /// „Spróbuj ponownie" przy pliku. Żądanie tego pliku w drodze albo w kolejce = nic do zrobienia.
  public func retry(_ path: String) {
    guard expanded.contains(path), !pending(path) else { return }
    files[path]?.goneOnce = false
    files[path]?.failure = nil
    files[path]?.revision = nil
    enqueueUrgent(path)
  }

  /// „Spróbuj ponownie" przy liście: po porażce pierwszej listy wraca „Wczytuję…", po porażce odświeżenia
  /// treść zostaje. Lista w drodze = nic do zrobienia.
  public func retryList() {
    guard inFlight != .list else { return }
    if !hasList { phase = .loading }
    refreshFailure = nil
    listWanted = true
    kick()
  }

  /// Nowa rewizja repozytorium sesji (ramka `git-status`, `usage`, zmiana podsumowania): okno odświeży listę
  /// i rozwinięte pliki. Wiele ramek w trakcie jednego przejścia to dalej jedno następne przejście.
  public func noteRevision(_ revision: Int) {
    guard revision != self.revision else { return }
    self.revision = revision
    listWanted = true
    kick()
  }

  // MARK: - Pompa żądań

  /// Jedyny przebieg odczytów okna: bierze zadania po jednym, aż zadanie wołającego zostanie anulowane
  /// (zamknięcie okna). Wynik żądania, które dobiegło po anulowaniu, nie zmienia stanu.
  public func run(list: ListFetch, file: FileFetch) async {
    let (wakes, continuation) = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .bufferingNewest(1))
    wake = continuation
    continuation.yield()
    for await _ in wakes {
      while !Task.isCancelled, let job = next() {
        // Rewizja z chwili żądania: odpowiedź opisuje stan nie starszy niż ona.
        let asked = revision
        inFlight = job
        switch job {
        case .list:
          let outcome = await list(sessionId)
          inFlight = nil
          guard !Task.isCancelled else { return }
          apply(list: outcome)
        case let .file(path):
          let outcome = await file(sessionId, path)
          inFlight = nil
          guard !Task.isCancelled else { return }
          apply(file: path, outcome, revision: asked)
        }
      }
    }
    inFlight = nil
  }

  /// Następne zadanie: pierwsza lista, potem pliki stuknięte ręką, potem reszta bieżącego przejścia, a nowe
  /// przejście (lista) dopiero po nim.
  private func next() -> Job? {
    guard hasList else {
      guard listWanted else { return nil }
      listWanted = false
      return .list
    }
    while !urgent.isEmpty {
      let path = urgent.removeFirst()
      if expanded.contains(path) { return .file(path) }
    }
    while !pass.isEmpty {
      let path = pass.removeFirst()
      if expanded.contains(path) { return .file(path) }
    }
    guard listWanted else { return nil }
    listWanted = false
    return .list
  }

  private func kick() {
    wake?.yield()
  }

  /// Nic w drodze i nic w kolejce — punkt synchronizacji testów.
  var idle: Bool {
    inFlight == nil && urgent.isEmpty && pass.isEmpty && !listWanted
  }

  // MARK: - Wyniki

  private func apply(list outcome: DiffFetchOutcome<DiffFileList>) {
    guard case let .loaded(list) = outcome else {
      let sentence = Self.sentence(outcome, fallback: UICopy.diffFailed)
      // Stara treść stoi: porażka odświeżenia nie zdejmuje listy ani patchy z ekranu.
      if hasList { refreshFailure = sentence } else { phase = .failed(sentence) }
      pass = []
      return
    }
    let first = !hasList
    hasList = true
    phase = .loaded
    refreshFailure = nil
    entries = list.files
    listTruncated = list.truncated
    let listed = Set(list.files.map(\.path))
    if first, let target = focus.take(files: list.files, truncated: list.truncated) {
      if target.extra { extras = [target.path] }
      expanded.insert(target.path)
      files[target.path] = FileState()
      scrollTarget = target.path
    } else {
      // Plik spoza uciętej listy zostaje u góry, dopóki lista jest ucięta i go nie niesie.
      extras.removeAll { listed.contains($0) || !list.truncated }
    }
    // Sekcja, której już nie ma, znika razem z rozwinięciem i pobraną treścią.
    let standing = listed.union(extras)
    expanded.formIntersection(standing)
    files = files.filter { standing.contains($0.key) }
    urgent.removeAll { !standing.contains($0) }
    // Przejście odświeżenia: rozwinięte pliki, których treść nie pochodzi z bieżącej rewizji.
    pass = (extras + list.files.map(\.path)).filter { path in
      expanded.contains(path) && !urgent.contains(path) && needsFetch(files[path] ?? FileState())
    }
  }

  private func apply(file path: String, _ outcome: DiffFetchOutcome<DiffFilePatch>, revision asked: Int) {
    // Sekcja zniknęła w trakcie żądania (odświeżona lista jej nie niesie): nie ma komu pokazać wyniku.
    guard var state = files[path] else { return }
    switch outcome {
    case let .loaded(patch):
      state.rows = PatchParser.rows(patch.patch, path: path)
      state.loaded = true
      state.truncated = patch.truncated
      // Liczba z uciętego patcha udawałaby pełny wynik.
      state.stat = patch.truncated ? nil : PatchStat(patch.patch)
      state.failure = nil
      state.revision = asked
      state.goneOnce = false
    case let .refused(refusal) where extras.contains(path) && (refusal.fileGone || refusal.badPath):
      // Plik spoza uciętej listy, którego git nie ma w zmianach: sekcja była domysłem z otwarcia okna.
      extras.removeAll { $0 == path }
      expanded.remove(path)
      files[path] = nil
      return
    case let .refused(refusal) where refusal.fileGone && !state.goneOnce:
      // Lista się zmieniła: odświeżamy ją RAZ. Plik, który na niej zostanie, pójdzie w tym przejściu od nowa;
      // zdanie zostaje na wypadek, gdyby odświeżenie listy się nie udało (inaczej sekcja stałaby na „Wczytuję…").
      state.goneOnce = true
      state.failure = Self.sentence(outcome, fallback: UICopy.diffFileFailed)
      state.revision = nil
      listWanted = true
    default:
      state.failure = Self.sentence(outcome, fallback: UICopy.diffFileFailed)
      state.revision = nil
    }
    files[path] = state
  }

  /// Zdanie porażki: 405 to serwer sprzed tras per plik, odmowa ze zdaniem serwera mówi nim, reszta jak przy
  /// pozostałych akcjach nagłówka.
  static func sentence<Value>(_ outcome: DiffFetchOutcome<Value>, fallback: String) -> String {
    switch outcome {
    case let .refused(refusal): refusal.serverOutdated ? UICopy.diffServerOutdated : refusal.message ?? fallback
    case .offline: UICopy.serverSilent
    case .timedOut: UICopy.controlTimedOut
    case .loaded, .failed, .loggedOut: fallback
    }
  }

  // MARK: - Pomocnicze

  private func known(_ path: String) -> Bool {
    extras.contains(path) || entries.contains { $0.path == path }
  }

  /// Żądanie tego pliku jest w drodze albo czeka w kolejce.
  private func pending(_ path: String) -> Bool {
    inFlight == .file(path) || urgent.contains(path) || pass.contains(path)
  }

  /// Sekcja czeka na odpowiedź: na własne żądanie albo — po 404 „nie ma na liście zmian" — na odświeżenie
  /// listy, które rozstrzygnie, czy plik jeszcze istnieje.
  private func awaited(_ path: String, _ state: FileState) -> Bool {
    pending(path) || (state.goneOnce && (listWanted || inFlight == .list))
  }

  /// Treści nie ma, ostatni odczyt się nie udał albo treść pochodzi sprzed bieżącej rewizji.
  private func needsFetch(_ state: FileState) -> Bool {
    !state.loaded || state.failure != nil || state.revision != revision
  }

  /// Plik stuknięty ręką idzie na początek kolejki; żądanie w drodze odpowie samo.
  private func enqueueUrgent(_ path: String) {
    pass.removeAll { $0 == path }
    guard inFlight != .file(path) else { return }
    urgent.removeAll { $0 == path }
    urgent.insert(path, at: 0)
    kick()
  }

  private func dequeue(_ path: String) {
    urgent.removeAll { $0 == path }
    pass.removeAll { $0 == path }
  }

  private func section(path: String, entry: DiffListEntry?) -> DiffSection {
    let state = files[path]
    let isExpanded = expanded.contains(path)
    var added = entry?.linesAdded
    var deleted = entry?.linesDeleted
    var binary = entry?.binary ?? false
    // Plik bez liczników z listy (nieśledzony, liczniki poza budżetem serwera): bilans z kompletnego patcha.
    if !binary, added == nil, deleted == nil, let stat = state?.stat {
      switch stat {
      case let .lines(plus, minus):
        added = plus
        deleted = minus
      case .binary: binary = true
      }
    }
    return DiffSection(
      path: path, status: entry?.status, added: binary ? nil : added, deleted: binary ? nil : deleted, binary: binary,
      expanded: isExpanded, body: isExpanded ? body(path, state) : .collapsed)
  }

  private func body(_ path: String, _ state: FileState?) -> DiffFileBody {
    guard let state else { return .loading }
    let waiting = awaited(path, state)
    if state.loaded {
      return .patch(DiffPatchBody(rows: state.rows, truncated: state.truncated, stale: waiting ? nil : state.failure))
    }
    if let failure = state.failure, !waiting { return .failed(failure) }
    return .loading
  }
}
