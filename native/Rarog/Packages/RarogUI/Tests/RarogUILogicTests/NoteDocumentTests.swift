import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Notatka projektu: silnik odczytu i zapisu jednego dokumentu, rejestr i szkic na dysku — na atrapie serwera
// i sterowanym czasie, bez UIKit. Przypadki brzegowe mają tu po teście: event przed 200,
// spóźniony odczyt, zapis przyjęty mimo limitu czasu, zamknięcie i skasowanie w trakcie zapisu, konflikt przy
// zamknięciu, nowa epoka, szkic niezależny od sieci, kosz po „zabiciu” apki.

/// Atrapa `GET`/`PUT /api/notes`: zapis żądań, odpowiedzi z kolejki (albo domyślne), wstrzymywanie do `release()`.
@MainActor
private final class FakeNotesServer {
  struct Save: Equatable {
    let text: String
    let base: Double
  }

  private(set) var reads = 0
  private(set) var saves: [Save] = []
  /// Dokument na „serwerze” — domyślne odpowiedzi liczą się z niego jak w `writeNotes`.
  var doc: NotesDoc
  var fetchQueue: [NoteFetchOutcome] = []
  var saveQueue: [NoteSaveOutcome] = []
  var holding = false
  private var held: [CheckedContinuation<Void, Never>] = []

  init(_ doc: NotesDoc = NotesDoc(text: "start", updatedAt: 100)) {
    self.doc = doc
  }

  func fetch(_ cwd: String) async -> NoteFetchOutcome {
    reads += 1
    let answer = fetchQueue.isEmpty ? .loaded(doc) : fetchQueue.removeFirst()
    await gate()
    return answer
  }

  func save(_ cwd: String, _ text: String, _ base: Double) async -> NoteSaveOutcome {
    saves.append(Save(text: text, base: base))
    let answer: NoteSaveOutcome
    if !saveQueue.isEmpty {
      answer = saveQueue.removeFirst()
    } else if base != doc.updatedAt {
      answer = .conflict(doc)
    } else {
      doc = NotesDoc(text: text, updatedAt: doc.updatedAt + 1)
      answer = .saved(doc.updatedAt)
    }
    await gate()
    return answer
  }

  private func gate() async {
    guard holding else { return }
    await withCheckedContinuation { held.append($0) }
  }

  var waiting: Int { held.count }

  func release() {
    held.removeFirst().resume()
  }
}

/// Sterowane odliczenia (autozapis 2 s, szkic 0,5 s, komunikat 3 s): czekają do `fire()`.
private final class Sleeper: @unchecked Sendable {
  private let lock = NSLock()
  private var waiting: [CheckedContinuation<Void, Never>] = []
  private var requested: [Duration] = []

  func sleep(_ duration: Duration) async {
    await withCheckedContinuation { continuation in
      lock.withLock {
        requested.append(duration)
        waiting.append(continuation)
      }
    }
  }

  /// Czasy, o które prosiły odliczenia (w kolejności).
  var durations: [Duration] { lock.withLock { requested } }

  private var count: Int { lock.withLock { waiting.count } }

  /// Kończy wszystkie trwające odliczenia (anulowane zadania same się wycofują). Najpierw oddaje GŁÓWNY aktor, aż
  /// odliczenia założone tuż przed wywołaniem zaczną czekać (zadania dokumentu biegną na głównym aktorze).
  @MainActor
  func fire() async {
    for _ in 0..<5_000 where count == 0 { await Task.yield() }
    for _ in 0..<100 { await Task.yield() }
    let all = lock.withLock {
      let all = waiting
      waiting = []
      return all
    }
    for continuation in all { continuation.resume() }
    // Wznowione zadania dokumentu dostają główny aktor, zanim test sprawdzi skutek.
    for _ in 0..<100 { await Task.yield() }
  }
}

/// Seria szeregowa: sterowany zegar oddaje wątek zadaniom głównego aktora, a testy biegnące równolegle na tym samym
/// aktorze zjadałyby te obroty.
@MainActor
@Suite("notatka projektu: odczyt, autozapis, konflikt, szkic", .serialized)
struct NoteDocumentTests {
  private let cwd = "/Users/demo/Projects/rarog"
  private let presentation = UUID()

  private func make(
    _ server: FakeNotesServer, sleeper: Sleeper = Sleeper(), drafts: NoteDrafts? = NoteDrafts()
  ) -> (ProjectNotes, NoteDocument) {
    let notes = ProjectNotes(
      io: NoteIO(
        fetch: { await server.fetch($0) }, save: { await server.save($0, $1, $2) },
        sleep: { await sleeper.sleep($0) }, now: { Date(timeIntervalSince1970: 1_790_000_000) }),
      drafts: drafts)
    return (notes, notes.document(cwd))
  }

  /// Czeka na warunek, oddając wątek zadaniom głównego aktora.
  private func until(_ what: String, _ condition: () -> Bool) async {
    for _ in 0..<20_000 where !condition() { await Task.yield() }
    #expect(condition(), "\(what)")
  }

  private func settle() async {
    for _ in 0..<200 { await Task.yield() }
  }

  /// Dokument wczytany z serwera, pokazany w formularzu.
  private func opened(
    _ server: FakeNotesServer, sleeper: Sleeper = Sleeper(), drafts: NoteDrafts? = NoteDrafts()
  ) async -> (ProjectNotes, NoteDocument) {
    let (notes, doc) = make(server, sleeper: sleeper, drafts: drafts)
    doc.attach(presentation)
    await until("pierwszy odczyt") { doc.ancestor != nil && !doc.loading }
    return (notes, doc)
  }

  // MARK: - Odczyt

  @Test("pole tylko do odczytu do pierwszego odczytu; potem tekst serwera i wersja jako przodek")
  func readOnlyUntilFirstRead() async {
    let server = FakeNotesServer()
    server.holding = true
    let (_, doc) = make(server)
    doc.attach(presentation)
    #expect(!doc.editable && doc.loading)
    doc.edit("litera z klawiatury")
    #expect(doc.text == "", "przed odczytem pole niczego nie przyjmuje")
    await until("odczyt w drodze") { server.waiting == 1 }
    server.release()
    await until("wczytane") { doc.editable }
    #expect(doc.text == "start" && doc.ancestor == NotesDoc(text: "start", updatedAt: 100) && !doc.isDirty)
  }

  @Test("pierwszy odczyt bez sieci: brak pola i zdanie, ponowne otwarcie czyta jeszcze raz")
  func firstReadOffline() async {
    let server = FakeNotesServer()
    server.fetchQueue = [.failed(.offline)]
    let (_, doc) = make(server)
    doc.attach(presentation)
    await until("porażka") { doc.loadFailure == .offline }
    #expect(!doc.editable)
    doc.open()
    await until("drugi odczyt") { doc.editable }
    #expect(server.reads == 2 && doc.loadFailure == nil)
  }

  // MARK: - Zapis

  @Test("autozapis po 2 s od ostatniej zmiany: jeden PUT z wersją przodka, potem przodek = zapisany tekst")
  func autosave() async {
    let server = FakeNotesServer()
    let sleeper = Sleeper()
    let (_, doc) = await opened(server, sleeper: sleeper)
    doc.edit("start\n- dopisek")
    doc.edit("start\n- dopisek z telefonu")
    #expect(server.saves.isEmpty && doc.isDirty)
    await sleeper.fire()
    await until("zapis") { !server.saves.isEmpty && !doc.saving }
    #expect(server.saves == [.init(text: "start\n- dopisek z telefonu", base: 100)])
    #expect(doc.ancestor == NotesDoc(text: "start\n- dopisek z telefonu", updatedAt: 101) && !doc.unsaved)
  }

  @Test("jeden PUT w locie: zmiana w trakcie czeka i idzie z wersją z odpowiedzi poprzedniego")
  func oneInFlight() async {
    let server = FakeNotesServer()
    let sleeper = Sleeper()
    let (_, doc) = await opened(server, sleeper: sleeper)
    server.holding = true
    doc.edit("A")
    await sleeper.fire()
    await until("A w drodze") { server.waiting == 1 }
    doc.edit("AB")
    await sleeper.fire()
    await settle()
    #expect(server.saves.count == 1, "drugi zapis czeka na pierwszy")
    server.release()
    await until("B w drodze") { server.waiting == 1 }
    server.release()
    await until("spokój") { !doc.saving && server.saves.count == 2 }
    #expect(server.saves == [.init(text: "A", base: 100), .init(text: "AB", base: 101)])
    #expect(doc.ancestor?.updatedAt == 102 && !doc.unsaved)
  }

  @Test("event autora przed jego 200: odczyt rozpoznaje własny zapis, następna cudza zmiana podmienia czyste pole")
  func echoBeforeResponse() async {
    let server = FakeNotesServer()
    let sleeper = Sleeper()
    let (notes, doc) = await opened(server, sleeper: sleeper)
    server.holding = true
    doc.edit("start + moje")
    await sleeper.fire()
    await until("PUT w drodze") { server.waiting == 1 }
    // Serwer zapisał (doc ma już wersję 101) i rozesłał event, zanim odpowiedział 200.
    server.doc = NotesDoc(text: "start + moje", updatedAt: 101)
    server.holding = false
    var state = AppState(clientBuild: 1)
    state.notesRevision[cwd] = 1
    notes.sync(state)
    await until("odczyt po evencie") { server.reads == 2 && !doc.loading }
    #expect(doc.conflict == nil && doc.text == "start + moje")
    server.release()
    await until("200") { !doc.saving }
    #expect(doc.ancestor == NotesDoc(text: "start + moje", updatedAt: 101) && !doc.unsaved)
    // Teraz cudza zmiana: licznika echa nie ma, więc niczego nie przemilczy.
    server.doc = NotesDoc(text: "start + moje\n- z iPada", updatedAt: 102)
    state.notesRevision[cwd] = 2
    notes.sync(state)
    await until("podmiana") { doc.text == "start + moje\n- z iPada" }
    #expect(doc.notice == .refreshed(102) && doc.conflict == nil)
  }

  @Test("spóźniony odczyt po nowszym zapisie nie cofa dokumentu")
  func lateReadIgnored() async {
    let server = FakeNotesServer()
    let sleeper = Sleeper()
    let (_, doc) = await opened(server, sleeper: sleeper)
    server.holding = true
    doc.refresh()
    await until("odczyt w drodze") { server.waiting == 1 }
    server.holding = false
    doc.edit("nowsze")
    await sleeper.fire()
    await until("zapis") { server.saves.count == 1 && !doc.saving }
    #expect(doc.server?.updatedAt == 101)
    server.release()
    await until("odczyt wrócił") { !doc.loading }
    #expect(doc.text == "nowsze" && doc.ancestor?.updatedAt == 101 && doc.conflict == nil)
  }

  @Test("limit czasu po przyjętym PUT, dalsze pisanie, 409 z własnym tekstem: baza, nie konflikt, i zapis dalej")
  func timeoutThenOwnConflict() async {
    let server = FakeNotesServer()
    let sleeper = Sleeper()
    let (_, doc) = await opened(server, sleeper: sleeper)
    // Serwer przyjął A (wersja 101), ale odpowiedź nie doszła.
    server.saveQueue = [.failed(.timedOut)]
    doc.edit("A")
    await sleeper.fire()
    await until("porażka") { doc.problem == .offline }
    server.doc = NotesDoc(text: "A", updatedAt: 101)
    doc.edit("AB")
    doc.retry()
    await until("zapis") { server.saves.count == 3 && !doc.saving }
    #expect(server.saves.map(\.text) == ["A", "AB", "AB"])
    #expect(server.saves.map(\.base) == [100, 100, 101])
    #expect(doc.conflict == nil && doc.problem == nil && doc.ancestor == NotesDoc(text: "AB", updatedAt: 102))
  }

  @Test("zamknięcie z wyczyszczonym polem w trakcie zapisu: skasowanie po nim, w koszu ostatni tekst, zdarzenie")
  func deleteDuringSave() async {
    let server = FakeNotesServer()
    let sleeper = Sleeper()
    let (notes, doc) = await opened(server, sleeper: sleeper)
    var events: [NoteEvent] = []
    notes.onEvent = { events.append($0) }
    server.holding = true
    doc.edit("start + dopisek")
    await sleeper.fire()
    await until("PUT w drodze") { server.waiting == 1 }
    doc.edit("")
    doc.finish(presentation)
    doc.finish(presentation)
    server.release()
    await until("skasowanie w drodze") { server.waiting == 1 }
    server.release()
    await until("spokój") { !doc.saving }
    #expect(server.saves.map(\.text) == ["start + dopisek", ""])
    #expect(doc.trash == "start + dopisek" && events == [.deleted(cwd: cwd)])
    server.holding = false
    doc.undoDelete()
    await until("przywrócone") { server.saves.count == 3 && !doc.saving }
    #expect(server.saves.last == .init(text: "start + dopisek", base: 102) && doc.trash == nil)
  }

  @Test("pusty tekst nie idzie autozapisem ani przy „Gotowe”; „Przywróć” wraca do wersji serwera")
  func emptyNeverAutosaves() async {
    let server = FakeNotesServer()
    let sleeper = Sleeper()
    let (_, doc) = await opened(server, sleeper: sleeper)
    doc.edit("  \n")
    #expect(doc.emptyWillDelete)
    await sleeper.fire()
    doc.flush()
    await settle()
    #expect(server.saves.isEmpty)
    doc.restore()
    #expect(doc.text == "start" && !doc.isDirty)
  }

  // MARK: - Konflikt

  @Test("cudza zmiana przy brudnym polu: konflikt, autozapis stoi, „Połącz” składa dopiski, zapisuje z wersją tamtej, „Cofnij” na 5 s")
  func conflictAndMerge() async {
    let server = FakeNotesServer()
    let sleeper = Sleeper()
    let (notes, doc) = await opened(server, sleeper: sleeper)
    doc.edit("start\n- telefon")
    server.doc = NotesDoc(text: "start\n- iPad", updatedAt: 105)
    var state = AppState(clientBuild: 1)
    state.notesRevision[cwd] = 1
    notes.sync(state)
    await until("konflikt") { doc.conflict != nil }
    await sleeper.fire()
    await settle()
    #expect(server.saves.isEmpty, "przy konflikcie autozapis stoi")
    #expect(doc.mergeResult == "start\n- iPad\n- telefon")
    doc.merge()
    await until("zapis") { server.saves.count == 1 && !doc.saving }
    #expect(server.saves == [.init(text: "start\n- iPad\n- telefon", base: 105)])
    #expect(doc.conflict == nil && doc.notice == .merged(105, undo: "start\n- telefon"))
    #expect(doc.statusLine(machine: .mac)?.action == .undo, "„Cofnij” w wierszu stanu")
    #expect(sleeper.durations.last == NoteDocument.undoHold && NoteDocument.undoHold == .seconds(5))
    await sleeper.fire()
    #expect(doc.notice == nil, "„Cofnij” gaśnie po `undoHold`")
  }

  @Test("konflikt nie z samych dopisków: bez „Połącz”; „Weź z serwera” czyści szkic, „Cofnij” wraca do mojej")
  func takeTheirsAndUndo() async {
    let server = FakeNotesServer()
    let sleeper = Sleeper()
    let drafts = NoteDrafts()
    let (_, doc) = await opened(server, sleeper: sleeper, drafts: drafts)
    server.saveQueue = [.conflict(NotesDoc(text: "inaczej", updatedAt: 110))]
    doc.edit("moje")
    await sleeper.fire()
    await until("konflikt") { doc.conflict != nil }
    #expect(doc.mergeResult == nil && drafts.draft(cwd)?.conflict?.text == "inaczej")
    doc.takeTheirs()
    #expect(doc.text == "inaczej" && !doc.unsaved && drafts.draft(cwd) == nil)
    doc.undoResolution()
    #expect(doc.text == "moje" && doc.isDirty)
  }

  @Test("409 z tekstem równym polu to nie konflikt: wersja przyjęta, szkic znika")
  func conflictWithSameText() async {
    let server = FakeNotesServer()
    let sleeper = Sleeper()
    let drafts = NoteDrafts()
    let (_, doc) = await opened(server, sleeper: sleeper, drafts: drafts)
    server.saveQueue = [.conflict(NotesDoc(text: "to samo", updatedAt: 120))]
    doc.edit("to samo")
    await sleeper.fire()
    await until("odpowiedź") { server.saves.count == 1 && !doc.saving }
    #expect(doc.conflict == nil && doc.ancestor?.updatedAt == 120 && drafts.draft(cwd) == nil)
  }

  @Test("zamknięcie w konflikcie niczego nie wysyła; szkic trzyma pole, przodka i wersję tamtej")
  func finishInConflict() async {
    let server = FakeNotesServer()
    let sleeper = Sleeper()
    let drafts = NoteDrafts()
    let (_, doc) = await opened(server, sleeper: sleeper, drafts: drafts)
    server.saveQueue = [.conflict(NotesDoc(text: "start\n- iPad", updatedAt: 105))]
    doc.edit("start\n- telefon")
    await sleeper.fire()
    await until("konflikt") { doc.conflict != nil }
    doc.finish(presentation)
    await settle()
    #expect(server.saves.count == 1)
    let draft = drafts.draft(cwd)
    #expect(draft?.text == "start\n- telefon" && draft?.ancestor?.updatedAt == 100 && draft?.conflict?.updatedAt == 105)
  }

  // MARK: - Epoka i ponowienia

  @Test("nowa epoka (powrót strumienia): otwarty czysty dokument czyta i podmienia, brudny dostaje konflikt")
  func newEpoch() async {
    let server = FakeNotesServer()
    let (notes, doc) = await opened(server)
    server.doc = NotesDoc(text: "zmiana z przerwy", updatedAt: 130)
    var state = AppState(clientBuild: 1)
    state.notesEpoch = 7
    notes.sync(state)
    await until("podmiana") { doc.text == "zmiana z przerwy" }
    doc.edit("moje po powrocie")
    server.doc = NotesDoc(text: "druga przerwa", updatedAt: 140)
    state.notesEpoch = 8
    notes.sync(state)
    await until("konflikt") { doc.conflict?.updatedAt == 140 }
    #expect(doc.text == "moje po powrocie")
  }

  @Test("400 inne niż katalog to odmowa ze zdaniem serwera; 400 katalogu i 404 — pole tylko do odczytu")
  func refusals() async throws {
    let server = FakeNotesServer()
    let sleeper = Sleeper()
    let (notes, doc) = await opened(server, sleeper: sleeper)
    server.saveQueue = [.failed(.refused(status: 400, message: "Za długa."))]
    doc.edit("x")
    await sleeper.fire()
    await until("odmowa") { doc.problem == .refused("Za długa.") }
    #expect(doc.readOnly == nil && doc.editable)
    server.saveQueue = [.failed(.disabled)]
    doc.retry()
    await until("wyłączone") { doc.readOnly == .disabled }
    #expect(!doc.editable && doc.text == "x")
    var state = AppState(clientBuild: 1)
    let version = try JSONDecoder().decode(
      VersionInfo.self, from: Data(#"{"version":"1","protocolVersion":3,"serverStartId":"s","notesEnabled":true}"#.utf8))
    state.capabilities = Capabilities(version)
    notes.sync(state)
    await until("znów edytowalne") { doc.editable }
  }

  @Test("wylogowanie w trakcie zapisu: spóźniona odpowiedź niczego nie zmienia, szkic zostaje")
  func logoutDuringSave() async {
    let server = FakeNotesServer()
    let sleeper = Sleeper()
    let drafts = NoteDrafts()
    let (notes, doc) = await opened(server, sleeper: sleeper, drafts: drafts)
    server.holding = true
    doc.edit("przed wylogowaniem")
    await sleeper.fire()
    await until("PUT w drodze") { server.waiting == 1 }
    notes.loggedOut()
    server.release()
    await settle()
    #expect(doc.saving == false || doc.ancestor?.updatedAt == 100)
    #expect(drafts.draft(cwd)?.text == "przed wylogowaniem")
    #expect(notes.existing(cwd) !== doc, "po wylogowaniu dokument wraca ze szkicu jako nowy")
  }

  // MARK: - Szkic na dysku

  @Test("szkic po każdej zmianie, niezależnie od zapisu; stara odpowiedź nie kasuje nowszej rewizji")
  func draftIndependentOfSave() async {
    let server = FakeNotesServer()
    let sleeper = Sleeper()
    let drafts = NoteDrafts()
    let (_, doc) = await opened(server, sleeper: sleeper, drafts: drafts)
    server.holding = true
    doc.edit("A")
    await sleeper.fire()
    await until("A w drodze") { server.waiting == 1 }
    #expect(drafts.draft(cwd)?.text == "A", "szkic przed wysłaniem")
    doc.edit("AB")
    await sleeper.fire()
    await settle()
    #expect(drafts.draft(cwd)?.text == "AB")
    server.release()
    await settle()
    #expect(drafts.draft(cwd)?.text == "AB", "200 dla A nie kasuje szkicu AB")
    await until("AB w drodze") { server.waiting == 1 }
    server.release()
    await until("AB zapisane") { !doc.saving && !doc.unsaved }
    #expect(drafts.draft(cwd) == nil)
  }

  /// Zapis notatki serwera A w drodze, parowanie z serwerem B daje nową
  /// przestrzeń danych i nowy interfejs, a spóźnione `.failed(.loggedOut)` starego dokumentu utrwala szkic A — w katalogu
  /// przestrzeni A, którego B (także po restarcie) nie czyta.
  @Test("spóźniony zapis po zmianie serwera: szkic poprzedniego serwera zostaje w jego przestrzeni, B go nie widzi")
  func lateSaveAfterServerChange() async throws {
    let root = FileManager.default.temporaryDirectory.appending(path: "note-spaces-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    let spaceA = root.appending(path: "a")
    let spaceB = root.appending(path: "b")
    let server = FakeNotesServer()
    let sleeper = Sleeper()
    let (_, doc) = await opened(server, sleeper: sleeper, drafts: NoteDrafts.inSpace(spaceA))
    server.holding = true
    server.saveQueue = [.failed(.loggedOut)]
    doc.edit("tekst z serwera A")
    await sleeper.fire()
    await until("zapis w drodze") { server.waiting == 1 }
    // Parowanie z innym serwerem: nowa przestrzeń, interfejs buduje się od nowa.
    let fresh = NoteDrafts.inSpace(spaceB)
    server.release()
    await until("odpowiedź") { !doc.saving }
    await settle()
    fresh.flush()
    NoteDrafts.inSpace(spaceA).flush()
    #expect(fresh.all.isEmpty)
    #expect(NoteDrafts.inSpace(spaceB).all.isEmpty, "po restarcie szkicu serwera A w przestrzeni B nie ma")
    #expect(NoteDrafts.inSpace(spaceA).all.map(\.text) == ["tekst z serwera A"], "szkic został w przestrzeni A")
  }

  @Test("„zabicie” apki: szkic i kosz wracają z dysku; pusty szkic niczego nie kasuje sam, „Przywróć” bierze z kosza")
  func survivesRestart() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "note-drafts-\(UUID())")
    defer { try? FileManager.default.removeItem(at: directory) }
    let first = NoteDrafts(directory: directory)
    first.save(NoteDrafts.Draft(
      cwd: cwd, text: "", ancestor: NotesDoc(text: "", updatedAt: 150), trash: "skasowany tekst",
      savedAt: Date(timeIntervalSince1970: 1_790_000_000)))
    first.flush()
    // Plik nieczytelny obok: zostaje nietknięty.
    let garbage = directory.appending(path: "zepsuty.json")
    try Data("nie json".utf8).write(to: garbage)

    let server = FakeNotesServer(NotesDoc(text: "", updatedAt: 150))
    let (notes, _) = make(server, drafts: NoteDrafts(directory: directory))
    let doc = try #require(notes.existing(cwd))
    #expect(doc.trash == "skasowany tekst" && doc.restoredAt != nil)
    doc.attach(presentation)
    await until("odczyt") { !doc.loading && server.reads == 1 }
    await settle()
    #expect(server.saves.isEmpty, "pusty szkic po restarcie nie kasuje sam")
    doc.restore()
    #expect(doc.text == "skasowany tekst")
    #expect(FileManager.default.fileExists(atPath: garbage.path))
  }

  @Test("pole wraca do przodka w trakcie zapisu innego tekstu: szkic zostaje, a po 200 trzyma pole i nowego przodka")
  func draftWhileRacingSave() async {
    let server = FakeNotesServer()
    let sleeper = Sleeper()
    let drafts = NoteDrafts()
    let (_, doc) = await opened(server, sleeper: sleeper, drafts: drafts)
    server.holding = true
    doc.edit("A")
    await sleeper.fire()
    await until("A w drodze") { server.waiting == 1 }
    doc.edit("start")
    await sleeper.fire()
    #expect(drafts.draft(cwd)?.text == "start", "szkic nie znika, choć pole równa się przodkowi")
    server.release()
    await until("200 dla A") { !doc.saving || server.waiting == 1 }
    #expect(drafts.draft(cwd)?.text == "start" && drafts.draft(cwd)?.ancestor?.text == "A")
  }

  @Test("szkic odzyskany z dysku: otwarcie wysyła go bez kolejnej edycji")
  func restoredDraftRetries() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "note-drafts-\(UUID())")
    defer { try? FileManager.default.removeItem(at: directory) }
    let first = NoteDrafts(directory: directory)
    first.save(NoteDrafts.Draft(
      cwd: cwd, text: "start\n- z wczoraj", ancestor: NotesDoc(text: "start", updatedAt: 100),
      savedAt: Date(timeIntervalSince1970: 1_790_000_000)))
    first.flush()
    let server = FakeNotesServer()
    let (notes, _) = make(server, drafts: NoteDrafts(directory: directory))
    let doc = try #require(notes.existing(cwd))
    doc.attach(presentation)
    await until("zapis") { server.saves.count == 1 && !doc.saving }
    #expect(server.saves == [.init(text: "start\n- z wczoraj", base: 100)] && !doc.unsaved)
  }

  // MARK: - Przypadki brzegowe

  @Test("przyjęty PUT z limitem czasu po przywróceniu pola do przodka: szkic trzyma pole, restart je wysyła")
  func timeoutAfterRestoreSurvivesRestart() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "note-drafts-\(UUID())")
    defer { try? FileManager.default.removeItem(at: directory) }
    let server = FakeNotesServer()
    let sleeper = Sleeper()
    let drafts = NoteDrafts(directory: directory)
    let (_, doc) = await opened(server, sleeper: sleeper, drafts: drafts)
    server.holding = true
    server.saveQueue = [.failed(.timedOut)]
    doc.edit("A")
    await sleeper.fire()
    await until("A w drodze") { server.waiting == 1 }
    doc.edit("start")
    server.doc = NotesDoc(text: "A", updatedAt: 101)
    server.release()
    await until("limit czasu") { doc.problem == .offline }
    drafts.flush()
    #expect(drafts.draft(cwd)?.text == "start" && drafts.draft(cwd)?.unsent == ["A"], "szkic nie znika")
    // „Zabicie" apki i ponowne otwarcie: odczyt rozpoznaje A jako własny zapis, pole „start" idzie dalej.
    server.holding = false
    let (notes, _) = make(server, drafts: NoteDrafts(directory: directory))
    let again = try #require(notes.existing(cwd))
    again.attach(presentation)
    await until("zapis przywróconego pola") { server.doc.text == "start" && !again.saving }
    #expect(again.conflict == nil && !again.unsaved)
  }

  @Test("oczekujące skasowanie nie trafia w wersję wybraną przy konflikcie („Weź z serwera”)")
  func pendingDeleteDroppedByResolution() async {
    let server = FakeNotesServer()
    let sleeper = Sleeper()
    let (notes, doc) = await opened(server, sleeper: sleeper)
    server.holding = true
    doc.edit("A")
    await sleeper.fire()
    await until("A w drodze") { server.waiting == 1 }
    doc.edit("")
    doc.finish(presentation)
    // Cudza wersja przychodzi odczytem, zanim wróci 200 dla A.
    server.holding = false
    server.doc = NotesDoc(text: "C", updatedAt: 105)
    var state = AppState(clientBuild: 1)
    state.notesRevision[cwd] = 1
    notes.sync(state)
    await until("konflikt") { doc.conflict?.text == "C" }
    doc.takeTheirs()
    server.release()
    await until("200 dla A") { !doc.saving }
    await settle()
    #expect(server.saves.map(\.text) == ["A"], "pusty tekst nie poszedł")
    #expect(doc.text == "C")
  }

  @Test("spóźnione 409 starszej wersji nie cofa konfliktu przyjętego z nowszego odczytu")
  func late409DoesNotRewind() async {
    let server = FakeNotesServer()
    let sleeper = Sleeper()
    let (notes, doc) = await opened(server, sleeper: sleeper)
    server.holding = true
    server.saveQueue = [.conflict(NotesDoc(text: "B", updatedAt: 101))]
    doc.edit("moje")
    await sleeper.fire()
    await until("PUT w drodze") { server.waiting == 1 }
    server.holding = false
    server.doc = NotesDoc(text: "C", updatedAt: 102)
    var state = AppState(clientBuild: 1)
    state.notesRevision[cwd] = 1
    notes.sync(state)
    await until("konflikt z odczytu") { doc.conflict?.updatedAt == 102 }
    server.release()
    await until("409 wróciło") { !doc.saving }
    #expect(doc.conflict == NotesDoc(text: "C", updatedAt: 102), "konflikt dalej z nowszą wersją")
  }

  @Test("odczyt potwierdza własny zapis przed 409 tej samej wersji: bez fałszywego konfliktu, pole idzie dalej")
  func readConfirmsBefore409() async {
    let server = FakeNotesServer()
    let sleeper = Sleeper()
    let (notes, doc) = await opened(server, sleeper: sleeper)
    server.saveQueue = [.failed(.timedOut)]
    doc.edit("A")
    await sleeper.fire()
    await until("limit czasu") { doc.problem == .offline }
    server.doc = NotesDoc(text: "A", updatedAt: 101)
    server.holding = true
    server.saveQueue = [.conflict(NotesDoc(text: "A", updatedAt: 101))]
    doc.edit("AB")
    await sleeper.fire()
    await until("AB w drodze") { server.waiting == 1 }
    server.holding = false
    var state = AppState(clientBuild: 1)
    state.notesRevision[cwd] = 1
    notes.sync(state)
    await until("odczyt") { doc.ancestor?.updatedAt == 101 }
    server.release()
    await until("zapis AB") { server.doc.text == "AB" && !doc.saving }
    #expect(doc.conflict == nil && !doc.unsaved)
  }

  @Test("pole przywrócone do przodka w trakcie zapisu i od razu zamknięte: ostatnie pole idzie na serwer")
  func restoreThenFinish() async {
    let server = FakeNotesServer()
    let sleeper = Sleeper()
    let (_, doc) = await opened(server, sleeper: sleeper)
    server.holding = true
    doc.edit("A")
    await sleeper.fire()
    await until("A w drodze") { server.waiting == 1 }
    doc.edit("start")
    doc.finish(presentation)
    server.holding = false
    server.release()
    await until("zapis start") { server.saves.count == 2 && !doc.saving }
    #expect(server.saves.map(\.text) == ["A", "start"] && server.doc.text == "start")
  }

  @Test("pole przywrócone do przodka w trakcie zapisu i zejście w tło: szkic ma ostatnie pole od razu")
  func restoreThenBackground() async {
    let server = FakeNotesServer()
    let sleeper = Sleeper()
    let drafts = NoteDrafts()
    let (notes, doc) = await opened(server, sleeper: sleeper, drafts: drafts)
    server.holding = true
    doc.edit("A")
    await sleeper.fire()
    await until("A w drodze") { server.waiting == 1 }
    doc.edit("start")
    notes.enterBackground()
    #expect(drafts.draft(cwd)?.text == "start")
    server.holding = false
    server.release()
    await until("spokój") { server.saves.count == 2 && !doc.saving }
  }

  @Test("nieudane skasowanie po wpisaniu nowego tekstu nie zamienia zapisu w skasowanie")
  func failedDeleteKeepsTypedText() async {
    let server = FakeNotesServer()
    let sleeper = Sleeper()
    let (_, doc) = await opened(server, sleeper: sleeper)
    server.holding = true
    server.saveQueue = [.failed(.offline)]
    doc.edit("")
    doc.finish(presentation)
    await until("skasowanie w drodze") { server.waiting == 1 }
    doc.attach(presentation)
    doc.edit("nowy tekst")
    server.holding = false
    server.release()
    await until("porażka") { doc.problem == .offline }
    doc.retry()
    await until("zapis") { server.saves.count == 2 && !doc.saving }
    #expect(server.saves.map(\.text) == ["", "nowy tekst"])
  }

  @Test("nazwa pliku szkicu to 16 znaków skrótu katalogu — długa ścieżka nie przekracza nazwy pliku")
  func draftKey() {
    let key = NoteDrafts.key(String(repeating: "/bardzo-dluga-sciezka", count: 40))
    #expect(key.count == 16 && key.allSatisfy(\.isHexDigit))
  }
}

@Suite("notatka projektu: scalanie i znaczniki linii")
struct NoteMergeTests {
  @Test("same dopiski: przodek, tamten dopisek, mój; jeden bez dopisku = druga wersja; nie-dopiski i sufit = nil")
  func appended() {
    #expect(NoteMerge.appended(base: "a", theirs: "a\nb", mine: "a\nc") == "a\nb\nc")
    #expect(NoteMerge.appended(base: "a", theirs: "a b", mine: "a c") == "a b\n c")
    #expect(NoteMerge.appended(base: "a", theirs: "a", mine: "a\nc") == "a\nc")
    #expect(NoteMerge.appended(base: "a", theirs: "a\nb", mine: "a") == "a\nb")
    #expect(NoteMerge.appended(base: "a\nx", theirs: "a\nb", mine: "a\nxc") == nil)
    let long = String(repeating: "x", count: NotesRules.maxUnits - 1)
    #expect(NoteMerge.appended(base: "", theirs: long, mine: "yy") == nil)
    #expect(NoteMerge.both(mine: "m", theirs: "t") == "m\n\nt")
    #expect(NoteMerge.both(mine: long, theirs: "t") == nil)
  }

  @Test("kreska przy liniach, których druga wersja nie ma — z krotnością")
  func lineMarks() {
    #expect(NoteMerge.lineMarks(["a", "b", "a"], against: ["a", "c"]) == [false, true, true])
    #expect(NoteMerge.lines("a\n\nb") == ["a", "", "b"])
  }
}
