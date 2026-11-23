import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Przerwanie na ekranie, Esc, „przerywa", strażnik braku „Pokaż w herdr", pasek promptu
// i trwały szkic. Właściciel: sterowanie sesją.

@Suite("przerwanie na ekranie: linia pod polem, czytnik, prompt do pustego pola")
struct InterruptPresentationTests {
  @Test("sukces: linia gaśnie; prompt wraca wyłącznie do pustego pola, zajęte pole mówi dlaczego")
  func delivered() {
    let back = InterruptPresentation.make(.delivered, prompt: "napraw", fieldEmpty: true, machine: .mac)
    #expect(back == InterruptPresentation(line: nil, isError: false, spoken: UICopy.interruptedRestored, restorePrompt: true))
    let typing = InterruptPresentation.make(.delivered, prompt: "napraw", fieldEmpty: false, machine: .mac)
    #expect(typing?.restorePrompt == false && typing?.spoken == UICopy.interruptedTyping && typing?.line == nil)
    let none = InterruptPresentation.make(.delivered, prompt: "", fieldEmpty: true, machine: .mac)
    #expect(none?.restorePrompt == false && none?.spoken == UICopy.interrupted)
  }

  @Test("odmowa panelu i bramki: czerwień z drogą wyjścia; „nie wiem” neutralne; zdanie serwera wygrywa")
  func refusals() {
    #expect(InterruptPresentation.make(.notDelivered, prompt: "x", fieldEmpty: true, machine: .mac)
      == InterruptPresentation(line: UICopy.interruptFailed(.mac), isError: true, spoken: UICopy.interruptFailed(.mac), restorePrompt: false))
    let unsure = InterruptPresentation.make(.unsure, prompt: "x", fieldEmpty: true, machine: .mac)
    #expect(unsure?.line == UICopy.interruptUnsure && unsure?.isError == false && unsure?.restorePrompt == false)
    #expect(InterruptPresentation.make(.refused(nil), prompt: "x", fieldEmpty: true, machine: .mac)?.line == UICopy.interruptGate)
    #expect(InterruptPresentation.make(.refused("herdr tylko do odczytu."), prompt: "x", fieldEmpty: true, machine: .mac)?.line
      == "herdr tylko do odczytu.")
  }

  @Test("gest bez żądania (bramka, nic do przerwania, wylogowanie): bez zmiany na ekranie")
  func silent() {
    for outcome in [InterruptOutcome.inFlight, .notAllowed, .loggedOut] {
      #expect(InterruptPresentation.make(outcome, prompt: "x", fieldEmpty: true, machine: .mac) == nil)
    }
  }

  @Test("Esc: przełącznik sesji, karta z fokusem, otwarte okno, składanie znaku i lista podpowiedzi komend mają pierwszeństwo; potem tylko działający Stop")
  func escape() {
    func allows(
      card: Bool = false, overlay: Bool = false, composing: Bool = false, switcher: Bool = false,
      suggestions: Bool = false, _ availability: InterruptAvailability = .enabled
    ) -> Bool {
      EscapeInterruptRule.allows(
        cardFocused: card, overlayPresented: overlay, composing: composing, switcherAbsorbs: switcher,
        suggestionsOpen: suggestions, availability: availability)
    }
    #expect(allows())
    #expect(!allows(card: true))
    #expect(!allows(overlay: true))
    #expect(!allows(composing: true))
    #expect(!allows(.disabled))
    #expect(!allows(.hidden))
    // Gest przełącznika sesji: Esc jest jego, tura pod spodem trwa — także przy działającym Stop.
    #expect(!allows(switcher: true))
    // Lista podpowiedzi komend nad polem: Esc zamyka listę, tura pracuje dalej.
    #expect(!allows(suggestions: true))
  }
}

@Suite("„przerywa” w wierszu aktywności")
struct InterruptActivityTests {
  @Test("żądanie w drodze przejmuje wiersz — także bez aktywności; licznik od chwili gestu")
  func interrupting() {
    let session = Sample.session(state: "running")
    var state = Sample.state(session: session, messages: [Sample.message(seq: 1, role: "user", blocks: Sample.text("go"))])
    state.apply(.turnControl(.interruptStarted(sessionId: "s1", at: Sample.now.addingTimeInterval(-3))), now: Sample.now)
    let row = ActivityRowLine.make(state: state, sessionId: "s1", now: Sample.now)
    #expect(row?.label == UICopy.activityInterrupting)
    #expect(row?.detail == "" && row?.glyph == .interrupting)

    var quiet = Sample.state(session: Sample.session(state: "waiting-input"))
    #expect(ActivityRowLine.make(state: quiet, sessionId: "s1", now: Sample.now) == nil)
    quiet.apply(.turnControl(.interruptStarted(sessionId: "s1", at: Sample.now)), now: Sample.now)
    #expect(ActivityRowLine.make(state: quiet, sessionId: "s1", now: Sample.now)?.label == UICopy.activityInterrupting,
            "pusty transkrypt z wysyłką w drodze też dostaje odpowiedź na gest")
    quiet.apply(.turnControl(.interruptSettled(sessionId: "s1", startedAt: Sample.now)), now: Sample.now)
    #expect(ActivityRowLine.make(state: quiet, sessionId: "s1", now: Sample.now) == nil)
  }
}

@Suite("bez „Pokaż w herdr”")
struct ShowInHerdrRemovedTests {
  /// Przycisk wyciągał panel na wierzch na Macu, a na telefonie nic się nie działo: mylił. Nie wraca ani na karty,
  /// ani do nagłówka, ani do bloku Codexa; tekstów przycisku i jego wyniku nie ma w katalogu.
  @Test("żaden widok ani tekst apki nie ma przycisku, który pokazuje coś w herdr")
  func noButton() throws {
    let root = ApprovalGateTests.sourceFile("")
    let files = try #require(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
      .compactMap { $0 as? URL }
      .filter { $0.pathExtension == "swift" }
    #expect(files.count > 100, "test czyta za mało plików: \(files.count)")
    for file in files {
      let code = ApprovalGateTests.withoutComments(try String(contentsOf: file, encoding: .utf8))
      #expect(!code.contains("showInHerdr") && !code.contains("ShowInHerdr"), "\(file.lastPathComponent)")
    }
    let catalog = try String(contentsOf: ApprovalGateTests.sourceFile("Copy/Localizable.xcstrings"), encoding: .utf8)
    #expect(!catalog.contains("sessionControl.showInHerdr"))
    #expect(!catalog.contains("Show in herdr") && !catalog.contains("Pokaż w herdr"))
  }
}

@Suite("pasek cytatu promptu i lista tur")
struct PromptBarTests {
  @Test("prompty: wiadomość człowieka z tekstem; sam załącznik i notka harnessu — nie")
  func entries() {
    let notice = Sample.decode(TranscriptMessage.self, #"{"seq":4,"role":"user","blocks":[{"type":"text","text":"<x>"}],"at":"2026-10-03T08:00:00.000Z","notice":{"kind":"agent"}}"#)
    let messages = [
      Sample.message(seq: 1, role: "user", blocks: Sample.text(" pierwszy ")),
      Sample.message(seq: 2, role: "assistant", blocks: Sample.text("ok")),
      Sample.message(seq: 3, role: "user", blocks: "[]", attachments: #"[{"kind":"image","name":"","bytes":3,"mime":"image/jpeg"}]"#),
      notice,
      Sample.message(seq: 5, role: "user", blocks: Sample.text("drugi")),
    ]
    #expect(PromptBar.entries(messages).map(\.seq) == [1, 5])
    #expect(PromptBar.entries(messages).map(\.text) == ["pierwszy", "drugi"])
  }

  @Test("cytat: ostatni prompt nad krawędzią; nad pierwszym — pierwszy; za ostatnią wiadomością — ostatni")
  func current() {
    let entries = [PromptEntry(seq: 1, text: "a", at: ""), PromptEntry(seq: 5, text: "b", at: ""), PromptEntry(seq: 9, text: "c", at: "")]
    #expect(PromptBar.current(entries, edgeSeq: 6)?.entry.seq == 5)
    #expect(PromptBar.current(entries, edgeSeq: 5)?.index == 1)
    #expect(PromptBar.current(entries, edgeSeq: 0)?.entry.seq == 1)
    #expect(PromptBar.current(entries, edgeSeq: nil)?.entry.seq == 9)
    #expect(PromptBar.current([], edgeSeq: 3) == nil)
  }

  @Test("wiersze: wiadomość, znacznik godziny i rozwijak serii niosą numer; ogon transkryptu — nie")
  func rowSeq() {
    #expect(PromptBar.seq(rowId: "m12.0") == 12)
    #expect(PromptBar.seq(rowId: "m12.a") == 12)
    #expect(PromptBar.seq(rowId: "t7") == 7)
    #expect(PromptBar.seq(rowId: "r3") == 3)
    #expect(PromptBar.seq(rowId: "open") == nil)
    #expect(PromptBar.seq(rowId: "pperm-1") == nil)
  }

  @Test("pasek schowany przy dnie, przy samej górze i bez promptu")
  func hidden() {
    let quote = PromptQuote(index: 0, entry: PromptEntry(seq: 1, text: "a", at: ""))
    #expect(PromptBar.hidden(pinned: true, offsetFromTop: 500, quote: quote))
    #expect(PromptBar.hidden(pinned: false, offsetFromTop: 10, quote: quote))
    #expect(PromptBar.hidden(pinned: false, offsetFromTop: 500, quote: nil))
    #expect(!PromptBar.hidden(pinned: false, offsetFromTop: 500, quote: quote))
  }

  @Test("lista tur od najnowszego: porządek po numerze malejąco, wpisy i bieżący chronologicznie")
  func listOrderNewestFirst() {
    let entries = [PromptEntry(seq: 1, text: "a", at: ""), PromptEntry(seq: 4, text: "b", at: ""), PromptEntry(seq: 9, text: "c", at: "")]
    #expect(PromptBar.listOrder(entries).map(\.seq) == [9, 4, 1])
    // Pasek liczy bieżący po numerze wiersza na krawędzi, na wpisach od najstarszego — te się nie zmieniają.
    #expect(PromptBar.current(entries, edgeSeq: 5)?.entry.seq == 4)
    #expect(PromptBar.listOrder([]).isEmpty)
    // Wpisy nie po kolei i tak stają od najwyższego numeru.
    #expect(PromptBar.listOrder([entries[1], entries[0], entries[2]]).map(\.seq) == [9, 4, 1])
  }

  @Test("czytnik wiersza listy: „Prompt N z M” (numer w sesji), „najnowszy” przy pierwszym, „tutaj jesteś” przy bieżącym")
  func listRowSpoken() {
    let newest = UICopy.promptRowSpoken(PromptEntry(seq: 9, text: "c", at: ""), number: 3, count: 3, current: false)
    #expect(newest == "Prompt 3 z 3, najnowszy, c")
    let current = UICopy.promptRowSpoken(PromptEntry(seq: 4, text: "b", at: ""), number: 2, count: 3, current: true)
    #expect(current == "Prompt 2 z 3, b, \(UICopy.promptsCurrent)")
  }
}

@MainActor
@Suite("trwały szkic pola wiadomości")
struct DraftPersistenceTests {
  private func directory() -> URL {
    FileManager.default.temporaryDirectory.appending(path: "rarog-drafts-tests/\(UUID().uuidString)", directoryHint: .isDirectory)
  }

  private func attachment(_ content: String, kind: ComposerAttachment.Kind = .file, name: String = "notatka.txt") throws -> ComposerAttachment {
    let file = AttachmentStaging.newURL(ext: "txt")
    try Data(content.utf8).write(to: file)
    return ComposerAttachment(kind: kind, name: name, mime: "text/plain", bytes: content.utf8.count, file: file)
  }

  @Test("tekst i załączniki przeżywają „zabicie apki” (nowa instancja z tego samego katalogu)")
  func survivesRestart() throws {
    let dir = directory()
    let first = ComposerDrafts(directory: dir, shelf: AttachmentShelf())
    let file = try attachment("treść")
    first.persist(text: "dokończ to", attachments: [file], for: "s/1")
    first.flush()
    try FileManager.default.removeItem(at: file.file)

    let second = ComposerDrafts(directory: dir, shelf: AttachmentShelf())
    #expect(second.take(for: "s/1") == ComposerDrafts.Draft(text: "dokończ to", note: nil))
    let restored = second.restoreAttachments(for: "s/1")
    #expect(restored.map(\.id) == [file.id] && restored.first?.name == "notatka.txt")
    let back = try Data(contentsOf: try #require(restored.first).file)
    #expect(String(decoding: back, as: UTF8.self) == "treść", "kopia w katalogu roboczym, oryginał mógł zniknąć")
    #expect(second.take(for: "inna") == nil)
  }

  @Test("pusty stan pola kasuje szkic; zdjęty załącznik znika z dysku")
  func clearing() throws {
    let dir = directory()
    let drafts = ComposerDrafts(directory: dir, shelf: AttachmentShelf())
    let a = try attachment("a")
    let b = try attachment("b")
    drafts.persist(text: "x", attachments: [a, b], for: "s1")
    drafts.persist(text: "x", attachments: [b], for: "s1")
    drafts.flush()
    #expect(drafts.restoreAttachments(for: "s1").map(\.id) == [b.id])
    drafts.persist(text: "", attachments: [], for: "s1")
    drafts.flush()
    #expect(drafts.take(for: "s1") == nil)
    #expect(drafts.restoreAttachments(for: "s1").isEmpty)
    let leftovers = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
    #expect(leftovers.isEmpty, "bez manifestu i bez katalogu treści: \(leftovers)")
  }

  @Test("nieudana wysyłka bez ekranu: tekst nad szkicem z dysku, z załącznikami z półki sesji")
  func failedSendWithoutScreen() async throws {
    let dir = directory()
    let shelf = AttachmentShelf()
    let drafts = ComposerDrafts(directory: dir, shelf: shelf)
    drafts.persist(text: "pisałem", attachments: [], for: "s1")
    drafts.flush()
    let photo = try attachment("jpeg", kind: .image, name: "")
    drafts.save("nie poszło", note: "Powód.", for: "s1")
    shelf.restore([photo], for: "s1")
    try await Task.sleep(for: .milliseconds(20))
    drafts.flush()

    let reopened = ComposerDrafts(directory: dir, shelf: AttachmentShelf())
    #expect(reopened.take(for: "s1")?.text == "nie poszło\npisałem")
    #expect(reopened.restoreAttachments(for: "s1").map(\.id) == [photo.id])
    #expect(drafts.take(for: "s1") == ComposerDrafts.Draft(text: "nie poszło\npisałem", note: "Powód."),
            "w tym samym procesie zdanie o powodzie zostaje")
  }

  /// Odroczony zapis nieudanej wysyłki biegł po tym, jak ekran
  /// zabrał szkic i zapisał swoje pole — czytał pustą pamięć i kasował poprawny szkic na dysku.
  @Test("odroczony zapis nieudanej wysyłki nie nadpisuje stanu, który zabrało już żywe pole")
  func deferredSaveAfterTake() async throws {
    let dir = directory()
    let drafts = ComposerDrafts(directory: dir, shelf: AttachmentShelf())
    drafts.save("odzyskany", note: "Powód.", for: "s1")
    // Ekran tej sesji zabiera szkic i od razu zapisuje swoje pole — w tej samej turze, przed zapisem z `save`.
    #expect(drafts.take(for: "s1")?.text == "odzyskany")
    drafts.persist(text: "odzyskany", attachments: [], for: "s1")
    try await Task.sleep(for: .milliseconds(20))
    drafts.flush()

    let reopened = ComposerDrafts(directory: dir, shelf: AttachmentShelf())
    #expect(reopened.take(for: "s1")?.text == "odzyskany", "szkic pola przeżył odroczony zapis")
  }

  /// Po nieudanym zapisie manifestu sprzątanie kasowało pliki
  /// poprzedniego szkicu, a stary manifest wskazywał już nieistniejący załącznik.
  @Test("nieudany zapis manifestu: poprzedni szkic zostaje cały, właściciel pola dostaje znak")
  func failedManifestKeepsPrevious() async throws {
    let dir = directory()
    let drafts = ComposerDrafts(directory: dir, shelf: AttachmentShelf())
    let a = try attachment("a")
    let failures = FailureCount()
    drafts.persist(text: "z A", attachments: [a], for: "s1") { failures.count += 1 }
    drafts.flush()
    // Manifest nie ma gdzie się zapisać (katalog szkiców tylko do odczytu); katalog treści sesji
    // zostaje zapisywalny, więc kopia B i sprzątanie po niej przechodzą.
    let manager = FileManager.default
    try manager.setAttributes([.posixPermissions: 0o555], ofItemAtPath: dir.path)
    defer { try? manager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir.path) }
    let b = try attachment("b")
    drafts.persist(text: "z B", attachments: [b], for: "s1") { failures.count += 1 }
    drafts.persist(text: "", attachments: [], for: "s1") { failures.count += 1 }
    drafts.flush()
    try await Task.sleep(for: .milliseconds(20))
    #expect(failures.count == 2, "zapis i skasowanie odmówione, udany zapis bez znaku")
    try manager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir.path)

    let reopened = ComposerDrafts(directory: dir, shelf: AttachmentShelf())
    #expect(reopened.take(for: "s1")?.text == "z A")
    #expect(reopened.restoreAttachments(for: "s1").map(\.id) == [a.id], "plik poprzedniego szkicu na miejscu")
  }

  @Test("queue take-back without a screen: the texts on top of the stored draft; a refused write keeps the draft")
  func takenWithoutScreen() async throws {
    let dir = directory()
    let drafts = ComposerDrafts(directory: dir, shelf: AttachmentShelf())
    drafts.persist(text: "s", attachments: [], for: "s1")
    drafts.flush()
    let manager = FileManager.default
    try manager.setAttributes([.posixPermissions: 0o555], ofItemAtPath: dir.path)
    defer { try? manager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir.path) }
    #expect(await drafts.saveTaken("A", for: "s1") == false)
    #expect(drafts.take(for: "s1")?.text == "s", "a refused write leaves the draft as it was, so a replay adds A once")
    try manager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir.path)
    #expect(await drafts.saveTaken("A", for: "s1"))
    let reopened = ComposerDrafts(directory: dir, shelf: AttachmentShelf())
    #expect(reopened.take(for: "s1")?.text == "A\ns")
  }

  @Test("a live screen takes only the texts waiting in memory, not the stored draft under them; a new one takes all")
  func takeWaiting() {
    let dir = directory()
    let drafts = ComposerDrafts(directory: dir, shelf: AttachmentShelf())
    drafts.persist(text: "s", attachments: [], for: "s1")
    drafts.flush()
    #expect(drafts.takeWaiting(for: "s1") == nil, "the stored draft is a copy of a field, not a text to add")
    drafts.save("B1", note: nil, for: "s1")
    drafts.save("B2", note: "Why.", for: "s1")
    #expect(drafts.takeWaiting(for: "s1") == ComposerDrafts.Draft(text: "B2\nB1", note: "Why."))
    #expect(drafts.takeWaiting(for: "s1") == nil, "taken once")
    drafts.save("B3", note: nil, for: "s1")
    #expect(drafts.take(for: "s1")?.text == "B3\ns", "a screen that opens takes the stored draft too")
  }

  @Test("załącznik, którego nie da się skopiować: tekst idzie na dysk, kopii w szkicu nie ma")
  func uncopiableAttachment() async throws {
    let dir = directory()
    let drafts = ComposerDrafts(directory: dir, shelf: AttachmentShelf())
    let locked = try attachment("tajne")
    let manager = FileManager.default
    try manager.setAttributes([.posixPermissions: 0o000], ofItemAtPath: locked.file.path)
    defer { try? manager.setAttributes([.posixPermissions: 0o644], ofItemAtPath: locked.file.path) }
    let failures = FailureCount()
    drafts.persist(text: "tekst", attachments: [locked], for: "s1") { failures.count += 1 }
    drafts.flush()
    try await Task.sleep(for: .milliseconds(20))
    #expect(failures.count == 0)

    let reopened = ComposerDrafts(directory: dir, shelf: AttachmentShelf())
    #expect(reopened.take(for: "s1")?.text == "tekst")
    #expect(reopened.restoreAttachments(for: "s1").isEmpty)
    let folder = dir.appending(path: DraftDisk.key("s1"), directoryHint: .isDirectory)
    #expect(((try? manager.contentsOfDirectory(atPath: folder.path)) ?? []).isEmpty, "bez niedokończonej kopii")
  }

  /// Wynik wczytania, które skończyło się po zamknięciu ekranu,
  /// leżał tylko na półce (pamięć procesu) — po zabiciu apki załącznika nie było.
  @Test("paczka wczytana po zamknięciu ekranu trafia do szkicu na dysku, tekst szkicu zostaje")
  func loadAfterScreenClosed() async throws {
    let dir = directory()
    let shelf = AttachmentShelf()
    let drafts = ComposerDrafts(directory: dir, shelf: shelf)
    drafts.persist(text: "pisałem", attachments: [], for: "s1")
    let source = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).txt")
    try Data("treść".utf8).write(to: source)
    let gate = AsyncStream<Void>.makeStream()
    let slow = AttachmentCandidate(kind: .file, name: "raport.txt", type: .plainText) {
      for await _ in gate.stream { break }
      return try AttachmentStaging.copy(source)
    }
    #expect(shelf.ingest([slow], for: "s1"))
    // Ekran sesji zgłasza paczkę i znika (inna sesja); wczytanie kończy się bez niego.
    drafts.persistAfterLoading("s1")
    drafts.persistAfterLoading("s1")
    gate.continuation.yield()
    await shelf.loaded("s1")
    try await Task.sleep(for: .milliseconds(20))
    drafts.flush()

    let reopened = ComposerDrafts(directory: dir, shelf: AttachmentShelf())
    #expect(reopened.take(for: "s1")?.text == "pisałem")
    #expect(reopened.restoreAttachments(for: "s1").map(\.name) == ["raport.txt"])
    drafts.persistAfterLoading("s1")
    #expect(!shelf.isLoading("s1"), "bez trwającego wczytywania nic nie śledzi")
  }

  @Test("klucz pliku: base64url bez separatorów ścieżki")
  func key() {
    #expect(!DraftDisk.key("a/b+c=").contains("/"))
    #expect(DraftDisk.key("s1") != DraftDisk.key("s2"))
  }
}

/// Każdy render przy szkicu innym niż zapisany odliczał 300 ms
/// od nowa, więc strumień odpowiedzi (render co ~60 ms) odsuwał zapis do końca tury.
@Suite("odliczanie przed zapisem szkicu")
struct DraftSaveScheduleTests {
  private func draft(_ text: String, _ attachments: [UUID] = []) -> DraftSnapshot {
    DraftSnapshot(text: text, attachments: attachments)
  }

  @Test("render przy niezmienionym polu nie odsuwa zapisu; nowy stan pola — tak")
  func rendersDoNotRestart() {
    var schedule = DraftSaveSchedule()
    var restarts: [Bool] = []
    restarts.append(schedule.changed(draft("szkic")))
    // Strumień odpowiedzi: 50 renderów przy polu, którego nikt nie rusza.
    for _ in 0..<50 { restarts.append(schedule.changed(draft("szkic"))) }
    #expect(restarts == [true] + Array(repeating: false, count: 50), "render nie zaczyna odliczania od nowa")
    let typed = schedule.changed(draft("szkic!"))
    let attached = schedule.changed(draft("szkic!", [UUID()]))
    #expect(typed && attached, "dalsze pisanie i nowy załącznik: od nowa")
  }

  @Test("zapis: stan zapisany nie odlicza się drugi raz, powrót do zapisanego nie zapisuje")
  func persistence() {
    var schedule = DraftSaveSchedule()
    let empty = schedule.persist(draft(""))
    let first = schedule.persist(draft("a"))
    let afterSave = schedule.changed(draft("a"))
    let leaveUnchanged = schedule.persist(draft("a"))
    let typed = schedule.changed(draft("ab"))
    let backToSaved = schedule.changed(draft("a"))
    let leaveBack = schedule.persist(draft("a"))
    #expect(empty && first, "pierwszy stan pola i każdy nowy idą na dysk")
    #expect(!afterSave && !leaveUnchanged, "wyjście z ekranu bez zmian nic nie pisze")
    #expect(typed && !backToSaved && !leaveBack, "pole wróciło do zapisanego")
  }

  @Test("dysk nie przyjął: stan znów do zapisu; porażka starszego zapisu nie cofa nowszego")
  func failure() {
    var schedule = DraftSaveSchedule()
    _ = schedule.persist(draft("x"))
    schedule.failed(draft("x"))
    let retry = schedule.changed(draft("x"))
    let saved = schedule.persist(draft("x"))
    let newer = schedule.persist(draft("y"))
    schedule.failed(draft("x"))
    let again = schedule.persist(draft("y"))
    #expect(retry && saved, "następny render spróbuje znowu")
    #expect(newer && !again, "nowszy zapis zostaje zapisany")
  }
}

/// Licznik znaków „dysk nie przyjął" (domknięcie biegnie na głównym aktorze).
@MainActor
private final class FailureCount {
  var count = 0
}
