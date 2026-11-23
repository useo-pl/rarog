import Foundation
import Observation
import RarogContract
import RarogCore

// Notatka projektu w apce: silnik odczytu i zapisu JEDNEGO dokumentu. Dymek czyta, formularz pisze, ale tekst
// i zapis należą do tego modelu, nie do widoku: zakończenie prezentacji nie przerywa `PUT`, dokończenia nagrania ani
// zapisu szkicu. Reguły: `docs/architecture.md` „Project notes”, punkt „Model w apce”. Logika bez UIKit — testy
// na macOS (`NoteDocumentTests`). Właściciel: notatki (apka natywna).

/// Wejścia i wyjścia dokumentu: sieć przez magazyn, zegar autozapisu, szkic na dysku, zdarzenia dla dymków.
public struct NoteIO: Sendable {
  public var fetch: @MainActor @Sendable (String) async -> NoteFetchOutcome
  public var save: @MainActor @Sendable (_ cwd: String, _ text: String, _ base: Double) async -> NoteSaveOutcome
  /// Czekanie odliczeń (autozapis, szkic); testy podają sterowane.
  public var sleep: @Sendable (Duration) async -> Void
  public var now: @Sendable () -> Date

  public init(
    fetch: @escaping @MainActor @Sendable (String) async -> NoteFetchOutcome,
    save: @escaping @MainActor @Sendable (String, String, Double) async -> NoteSaveOutcome,
    sleep: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) },
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.fetch = fetch
    self.save = save
    self.sleep = sleep
    self.now = now
  }
}

/// Zdarzenie dokumentu dla dymków apki (komunikat z akcją po zakończeniu prezentacji).
public enum NoteEvent: Sendable, Equatable {
  /// Pusta notatka skasowana na serwerze; „Cofnij” przywraca `text`.
  case deleted(cwd: String)
  /// Zapis po zakończeniu prezentacji się nie udał; tekst czeka w szkicu.
  case notSaved(cwd: String)
}

@MainActor
@Observable
public final class NoteDocument {
  /// Dlaczego pole jest tylko do odczytu.
  public enum ReadOnly: Sendable, Equatable {
    /// 404: notatki wyłączone na serwerze.
    case disabled
    /// 400 `cwd-not-allowed`: zdanie serwera o katalogu.
    case directory(String?)
  }

  /// Dlaczego tekst pola nie jest zapisany (zapis spróbuje znowu sam).
  public enum Problem: Sendable, Equatable {
    case offline
    case server(String?)
    case refused(String?)
    case loggedOut
    /// Kopii na urządzeniu nie udało się zapisać (dysk).
    case disk
  }

  /// Krótkotrwała informacja w wierszu stanu.
  public enum Notice: Sendable, Equatable {
    /// Cicha podmiana pola zmianą z innego urządzenia (wersja z tej chwili).
    case refreshed(Double)
    /// „Połącz” po konflikcie; `undo` = moja wersja sprzed połączenia.
    case merged(Double, undo: String)
    /// „Weź z serwera”; `undo` = moja odrzucona wersja.
    case took(Double, undo: String)
  }

  private enum Intent: Equatable {
    case save
    /// Jawne skasowanie z zakończenia prezentacji pustego pola.
    case delete
  }

  public static let autosaveDelay: Duration = .seconds(2)
  public static let draftDelay: Duration = .milliseconds(500)
  /// Jak długo wiersz stanu mówi o cichej podmianie pola zmianą z innego urządzenia.
  public static let refreshedHold: Duration = .seconds(3)
  /// Jak długo po „Połącz” i „Weź z serwera” stoi „Cofnij”.
  public static let undoHold: Duration = .seconds(5)
  /// Ile tekstów wysłanych bez potwierdzenia pamiętamy (rozpoznanie własnego zapisu w `GET` i 409).
  static let unconfirmedLimit = 4

  public let cwd: String
  /// Najnowsza ZNANA wersja serwera — przyjmuje tylko wyższe `updatedAt`.
  public private(set) var server: NotesDoc?
  /// Wersja, na której człowiek pisze: wspólny przodek do „Połącz” i wersja `PUT`.
  public private(set) var ancestor: NotesDoc?
  /// Pole.
  public private(set) var text = ""
  /// Wersja z drugiego urządzenia, której nie da się przyjąć bez wyboru człowieka.
  public private(set) var conflict: NotesDoc?
  public private(set) var readOnly: ReadOnly?
  public private(set) var problem: Problem?
  /// Pierwszy odczyt się nie udał, a żadnej wersji nie znamy (nic do pokazania ani do edycji).
  public private(set) var loadFailure: NoteFailure?
  public private(set) var notice: Notice?
  /// Tekst skasowany zamknięciem pustego pola — do „Cofnij”/„Przywróć”.
  public private(set) var trash: String?
  /// `PUT` w drodze.
  public private(set) var saving = false
  /// `GET` w drodze.
  public private(set) var loading = false
  /// Trwa nagranie dyktowania do tego pola: autozapis i podmiana pola czekają.
  public private(set) var dictating = false
  /// Prezentacje (dymek, formularz, sekcja ekranu projektu), które pokazują ten dokument — po identyfikatorze,
  /// żeby zakończenie jednej z kilku dróg (przycisk i `onDisappear` tej samej prezentacji) liczyło się raz.
  public private(set) var presentations: Set<UUID> = []
  /// Szkic z dysku z poprzedniego uruchomienia apki (status „nie zapisano (21:16)”).
  public private(set) var restoredAt: Date?

  @ObservationIgnored private let io: NoteIO
  @ObservationIgnored private let drafts: NoteDrafts?
  @ObservationIgnored private let report: @MainActor (NoteEvent) -> Void
  @ObservationIgnored private var inFlight: String?
  @ObservationIgnored private var pending: Intent?
  @ObservationIgnored private var unconfirmed: [String] = []
  @ObservationIgnored private var fetchAgain = false
  /// Epoka strumienia, w której dokument ostatnio czytał serwer (`AppState.notesEpoch`).
  @ObservationIgnored private var epoch: Int?
  @ObservationIgnored private(set) var currentEpoch = 0
  @ObservationIgnored private var autosave: Task<Void, Never>?
  @ObservationIgnored private var draftTimer: Task<Void, Never>?
  @ObservationIgnored private var noticeTimer: Task<Void, Never>?
  /// Dokument odpięty (wylogowanie): spóźnione odpowiedzi niczego nie zmieniają.
  @ObservationIgnored private var detached = false

  init(
    cwd: String, io: NoteIO, drafts: NoteDrafts?, epoch: Int, restored: NoteDrafts.Draft? = nil,
    report: @escaping @MainActor (NoteEvent) -> Void
  ) {
    self.cwd = cwd
    currentEpoch = epoch
    self.io = io
    self.drafts = drafts
    self.report = report
    if let restored {
      text = restored.text
      ancestor = restored.ancestor
      server = restored.ancestor
      conflict = restored.conflict
      trash = restored.trash
      unconfirmed = restored.unsent ?? []
      restoredAt = restored.savedAt
    }
  }

  // MARK: - Stan dla widoków

  public var presented: Bool { !presentations.isEmpty }

  /// Pole wymaga zapisu: różni się od wersji, na której człowiek pisał, ALBO od tekstu, który serwer mógł już
  /// przyjąć (zapis w locie, wysłany bez potwierdzenia) — pole przywrócone do przodka w trakcie zapisu innego tekstu
  /// to też zamiar, który musi dojść.
  public var isDirty: Bool {
    if text != (ancestor?.text ?? "") { return true }
    guard let unsettled = inFlight ?? unconfirmed.last else { return false }
    return unsettled != text
  }

  /// Pole przyjmuje tekst: znana wersja, bez konfliktu nie do odczytu.
  public var editable: Bool { readOnly == nil && ancestor != nil }

  /// Tekst na tym urządzeniu nie jest na serwerze (znak na ikonie w pasku).
  public var unsaved: Bool { isDirty || conflict != nil || pending == .delete }

  /// Pole puste przy niepustej notatce na serwerze: zamknięcie skasuje notatkę.
  public var emptyWillDelete: Bool {
    NotesRules.isEmpty(text) && !NotesRules.isEmpty(ancestor?.text ?? "")
  }

  /// Wersja do pokazania w dymku: pole, gdy ma niezapisaną zmianę, inaczej najnowsza wersja serwera.
  public var readingText: String { isDirty ? text : (server?.text ?? text) }

  /// „Połącz” jest możliwe: obie strony tylko dopisały, a wynik mieści się w suficie.
  public var mergeResult: String? {
    guard let conflict, let ancestor else { return nil }
    return NoteMerge.appended(base: ancestor.text, theirs: conflict.text, mine: text)
  }

  // MARK: - Prezentacje

  /// Dymek, formularz albo sekcja ekranu projektu pokazuje dokument: świeży odczyt, gdy treść może być stara,
  /// i ponowienie niezapisanego.
  public func attach(_ presentation: UUID) {
    presentations.insert(presentation)
    open()
  }

  /// Koniec prezentacji bez pisania (dymek, sekcja). Formularz kończy ``finish(_:)``.
  public func detach(_ presentation: UUID) {
    presentations.remove(presentation)
  }

  /// Otwarcie bez liczenia prezentacji (sonda paska): odczyt, gdy treść nie jest z bieżącej epoki.
  public func open() {
    if epoch != currentEpoch || loadFailure != nil { refresh() }
    retry()
  }

  /// Zakończenie prezentacji formularza (przycisk, Esc, ⌘W, ⌘J, gest, zastąpienie, wylogowanie). Idempotentne:
  /// działa raz na prezentację. Szkic na dysk i zapis, a pusty dokument — skasowanie.
  public func finish(_ presentation: UUID) {
    guard presentations.remove(presentation) != nil else { return }
    autosave?.cancel()
    autosave = nil
    guard readOnly == nil, ancestor != nil, !detached else { return }
    if conflict != nil {
      persistDraftNow()
      return
    }
    if emptyWillDelete {
      trash = ancestor?.text
      pending = .delete
      persistDraftNow()
      runQueue()
      return
    }
    guard isDirty else { return }
    persistDraftNow()
    requestSave()
  }

  // MARK: - Pisanie

  /// Zmiana pola (klawiatura, dyktowanie, wklejka). Pisanie anuluje oczekujące skasowanie.
  public func edit(_ next: String) {
    guard next != text, editable else { return }
    text = next
    if pending == .delete, !NotesRules.isEmpty(next) { pending = nil }
    notice = nil
    scheduleDraft()
    scheduleAutosave()
  }

  /// „Gotowe” i zejście apki w tło: zapis teraz (pusty dokument nie idzie — zabicie w tle nie kasuje notatki).
  public func flush() {
    autosave?.cancel()
    autosave = nil
    persistDraftNow()
    guard !NotesRules.isEmpty(text) else { return }
    requestSave()
  }

  /// Czeka, aż szkic dojdzie na dysk (zadanie tła przed uśpieniem apki).
  public func syncDraft() {
    drafts?.flush()
  }

  /// Nagranie dyktowania zaczyna się albo kończy. Po końcu autozapis liczy od nowa.
  public func setDictating(_ value: Bool) {
    guard dictating != value else { return }
    dictating = value
    if !value, isDirty { scheduleAutosave() }
  }

  /// „Przywróć” w pustym polu: treść sprzed wyczyszczenia (wersja serwera) albo skasowana notatka z kosza.
  public func restore() {
    guard editable else { return }
    let previous = NotesRules.isEmpty(ancestor?.text ?? "") ? trash : ancestor?.text
    guard let previous, !NotesRules.isEmpty(previous) else { return }
    edit(previous)
  }

  /// „Cofnij” po skasowaniu (dymek): przywraca skasowany tekst i zapisuje od razu.
  public func undoDelete() {
    guard let trash, editable else { return }
    edit(trash)
    requestSave()
  }

  /// „Spróbuj ponownie” i każde zdarzenie, po którym zapis ma szansę (powrót strumienia, apki, otwarcie) — także
  /// dla szkicu odzyskanego z dysku, który porażki w tym uruchomieniu nie miał. Pusty szkic nie kasuje sam.
  public func retry() {
    guard readOnly == nil, problem != .loggedOut, !detached else { return }
    if pending == .delete {
      runQueue()
    } else if isDirty {
      requestSave()
    }
  }

  /// Serwer znów ma notatki (`notesEnabled` po 404): pole wraca do edycji, treść — do sprawdzenia.
  func reenable() {
    guard readOnly == .disabled else { return }
    readOnly = nil
    refresh()
  }

  // MARK: - Konflikt

  /// „Połącz”: przodek, dopisek tamtej, mój dopisek — zapis z wersją tamtej.
  public func merge() {
    guard let conflict, let merged = mergeResult else { return }
    let mine = text
    resolve(on: conflict, field: merged)
    showNotice(.merged(conflict.updatedAt, undo: mine), for: Self.undoHold)
    requestSave()
  }

  /// „Zachowaj moją”: świadome nadpisanie wersji z drugiego urządzenia.
  public func keepMine() {
    guard let conflict else { return }
    resolve(on: conflict, field: text)
    requestSave()
  }

  /// „Weź z serwera”: pole dostaje tamtą wersję, moja zostaje tylko do „Cofnij”.
  public func takeTheirs() {
    guard let conflict else { return }
    let mine = text
    resolve(on: conflict, field: conflict.text)
    showNotice(.took(conflict.updatedAt, undo: mine), for: Self.undoHold)
    settleDraft()
  }

  /// „Wstaw obie do pola”: moja, pusta linia, tamta — scalenie ręczne, potem autozapis.
  public func insertBoth() {
    guard let conflict, let both = NoteMerge.both(mine: text, theirs: conflict.text) else { return }
    resolve(on: conflict, field: both)
    scheduleDraft()
    scheduleAutosave()
  }

  /// „Cofnij” po połączeniu albo wzięciu wersji z serwera: pole wraca do mojej wersji (autozapis ją wyśle).
  public func undoResolution() {
    switch notice {
    case let .merged(_, undo), let .took(_, undo):
      notice = nil
      edit(undo)
    case .refreshed, nil:
      break
    }
  }

  private func resolve(on theirs: NotesDoc, field: String) {
    ancestor = theirs
    conflict = nil
    problem = nil
    text = field
    // Rozstrzygnięcie konfliktu to nowy zamiar: wcześniejsze skasowanie nie ma prawa trafić w wybraną wersję.
    if pending == .delete { pending = nil }
  }

  // MARK: - Serwer

  /// Nowa epoka strumienia (powrót z przerwy): treść w pamięci trzeba sprawdzić, niezapisane — ponowić.
  func epochChanged(_ value: Int) {
    currentEpoch = value
    guard presented || problem != nil || unsaved else { return }
    refresh()
    retry()
  }

  /// Serwer powiedział, że notatka katalogu się zmieniła (event `notes`): treść event nie niesie, więc odczyt.
  func remoteChanged() {
    guard ancestor != nil || presented else { return }
    refresh()
  }

  /// Jeden łączony `GET`: prośba w trakcie odczytu daje jeszcze jeden odczyt po nim.
  public func refresh() {
    guard !detached, readOnly != .disabled else { return }
    if loading {
      fetchAgain = true
      return
    }
    loading = true
    let readEpoch = currentEpoch
    Task { [weak self] in
      guard let self else { return }
      let outcome = await self.io.fetch(self.cwd)
      self.fetched(outcome, epoch: readEpoch)
    }
  }

  private func fetched(_ outcome: NoteFetchOutcome, epoch readEpoch: Int) {
    loading = false
    guard !detached else { return }
    switch outcome {
    case let .loaded(doc):
      epoch = readEpoch
      loadFailure = nil
      if case .directory = readOnly { readOnly = nil }
      adopt(doc)
    case let .failed(failure):
      switch failure {
      case .disabled: readOnly = .disabled
      case let .badCwd(message): readOnly = .directory(message)
      default: break
      }
      if ancestor == nil { loadFailure = failure }
    }
    if fetchAgain {
      fetchAgain = false
      refresh()
    }
  }

  /// Dokument z serwera (odczyt): wyższa wersja albo nic; mój zapis, cicha podmiana czystego pola albo konflikt.
  private func adopt(_ doc: NotesDoc) {
    if let server, doc.updatedAt <= server.updatedAt { return }
    server = doc
    if ancestor == nil {
      // Pierwszy odczyt bez szkicu: pole staje się dokumentem.
      ancestor = doc
      text = doc.text
      return
    }
    if doc.updatedAt == ancestor?.updatedAt { return }
    if doc.text == text || doc.text == inFlight || unconfirmed.contains(doc.text) {
      // Mój zapis wylądował (event autora przychodzi przed jego 200) albo obie strony mają to samo.
      ancestor = doc
      unconfirmed.removeAll()
      if doc.text == text {
        conflict = nil
        problem = nil
        settleDraft()
      } else {
        // Mój wcześniejszy zapis jest bazą, a pole poszło dalej (albo wróciło): zapis pola z nową wersją.
        requestSave()
      }
      return
    }
    if !isDirty, !dictating, inFlight == nil, conflict == nil {
      ancestor = doc
      text = doc.text
      showNotice(.refreshed(doc.updatedAt), for: Self.refreshedHold)
      return
    }
    conflict = doc
    persistDraftNow()
  }

  // MARK: - Kolejka zapisu

  private func scheduleAutosave() {
    autosave?.cancel()
    let sleep = io.sleep
    autosave = Task { [weak self] in
      await sleep(Self.autosaveDelay)
      guard !Task.isCancelled else { return }
      self?.requestSave()
    }
  }

  private func requestSave() {
    if pending != .delete { pending = .save }
    runQueue()
  }

  /// Wysyła oczekujący zapis, gdy nic nie leci i zapis jest dozwolony.
  private func runQueue() {
    guard inFlight == nil, !detached, readOnly == nil, let ancestor else { return }
    let body: String
    switch pending {
    case .delete?:
      // Skasowanie tylko pustego pola, bez konfliktu i nagrania — sprawdzane w chwili wysłania, nie zlecenia.
      guard NotesRules.isEmpty(text), conflict == nil, !dictating else {
        pending = nil
        return
      }
      body = ""
    case .save?:
      guard canSave else {
        pending = nil
        return
      }
      body = text
    case nil:
      return
    }
    pending = nil
    inFlight = body
    saving = true
    let base = ancestor.updatedAt
    Task { [weak self] in
      guard let self else { return }
      let outcome = await self.io.save(self.cwd, body, base)
      self.saved(outcome, sent: body)
    }
  }

  /// Zapis pola jest dozwolony (pusty idzie wyłącznie jako jawne skasowanie).
  private var canSave: Bool {
    !dictating && conflict == nil && isDirty && !NotesRules.isEmpty(text)
      && NotesRules.units(text) <= NotesRules.maxUnits
  }

  private func saved(_ outcome: NoteSaveOutcome, sent: String) {
    inFlight = nil
    saving = false
    guard !detached else { return }
    switch outcome {
    case let .saved(version):
      let doc = NotesDoc(text: sent, updatedAt: version)
      unconfirmed.removeAll()
      problem = nil
      restoredAt = nil
      if version > (server?.updatedAt ?? -1) { server = doc }
      if version > (ancestor?.updatedAt ?? -1) { ancestor = doc }
      if NotesRules.isEmpty(sent) {
        report(.deleted(cwd: cwd))
      } else if pending == .delete {
        // Skasowanie czekało na ten zapis: w koszu ma stać to, co serwer miał tuż przed nim.
        trash = sent
      } else {
        trash = nil
      }
      // Pole różne od wysłanego zostaje w szkicu razem z nowym przodkiem; równe — szkic znika.
      persistDraftNow()
    case let .conflict(current):
      let known = server?.updatedAt ?? -1
      if current.updatedAt > known { server = current }
      if current.updatedAt <= (ancestor?.updatedAt ?? -1) || current.updatedAt < known {
        // Spóźnione 409: nowszą wersję serwera odczyt już przyjął (jako bazę albo konflikt) — ta odpowiedź niczego
        // nie cofa. Pole wymagające zapisu idzie jeszcze raz z bieżącą bazą.
        if conflict == nil, isDirty, pending == nil { pending = .save }
      } else if current.text == text || current.text == sent || unconfirmed.contains(current.text) {
        // Wersja na serwerze to mój wcześniejszy zapis (np. przyjęty mimo limitu czasu): to baza, nie konflikt.
        ancestor = current
        unconfirmed.removeAll()
        if current.text == text {
          problem = nil
          settleDraft()
        } else if pending == nil {
          pending = .save
        }
      } else {
        conflict = current
        if pending == .delete { pending = nil }
        persistDraftNow()
      }
    case let .failed(failure):
      if failure.deliveryUnknown {
        unconfirmed.append(sent)
        if unconfirmed.count > Self.unconfirmedLimit { unconfirmed.removeFirst() }
      }
      switch failure {
      case .disabled: readOnly = .disabled
      case let .badCwd(message): readOnly = .directory(message)
      case let .refused(_, message): problem = .refused(message)
      case let .server(message): problem = .server(message)
      case .offline, .timedOut, .failed: problem = .offline
      case .loggedOut: problem = .loggedOut
      }
      // Niezapisany zamiar wraca w kolejce: skasowanie ponowi `retry`, pole — następna zmiana albo `retry`. Pole,
      // w które człowiek zdążył coś wpisać, nie wraca do skasowania.
      if NotesRules.isEmpty(sent), NotesRules.isEmpty(text) { pending = .delete }
      persistDraftNow()
      if !presented { report(.notSaved(cwd: cwd)) }
      return
    }
    runQueue()
  }

  // MARK: - Szkic

  private func scheduleDraft() {
    draftTimer?.cancel()
    let sleep = io.sleep
    draftTimer = Task { [weak self] in
      await sleep(Self.draftDelay)
      guard !Task.isCancelled else { return }
      self?.persistDraftNow()
    }
  }

  /// Szkic na dysk teraz: pole różne od przodka, konflikt albo kosz. Stan czysty kasuje szkic.
  func persistDraftNow() {
    draftTimer?.cancel()
    draftTimer = nil
    guard let drafts else { return }
    guard isDirty || conflict != nil || trash != nil || pending == .delete else {
      drafts.remove(cwd)
      return
    }
    let draft = NoteDrafts.Draft(
      cwd: cwd, text: text, ancestor: ancestor, conflict: conflict, trash: trash,
      unsent: unconfirmed.isEmpty ? nil : unconfirmed, savedAt: io.now())
    drafts.save(draft) { [weak self] ok in
      guard let self, !ok else { return }
      self.problem = .disk
    }
  }

  /// Serwer ma dokładnie pole: szkic tekstu niepotrzebny (kosz zostaje do następnego niepustego zapisu).
  private func settleDraft() {
    restoredAt = nil
    persistDraftNow()
  }

  private func showNotice(_ value: Notice, for hold: Duration) {
    notice = value
    noticeTimer?.cancel()
    let sleep = io.sleep
    noticeTimer = Task { [weak self] in
      await sleep(hold)
      guard !Task.isCancelled, let self, self.notice == value else { return }
      self.notice = nil
    }
  }

  /// Wylogowanie: dokument przestaje reagować na odpowiedzi; szkic zostaje na dysku.
  func detachForLogout() {
    persistDraftNow()
    detached = true
    autosave?.cancel()
    draftTimer?.cancel()
    noticeTimer?.cancel()
  }
}
