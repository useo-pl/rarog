import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Okno diffa per plik: lista, rozwinięcia, kolejka odczytów po jednym i reguły odświeżania —
// na atrapie obu tras, bez UIKit. Atrapa liczy żądania w kolejności i potrafi trzymać odpowiedzi do
// `release()`, więc testy widzą dokładnie to, co poszłoby do serwera.

/// Atrapa tras `…/diff/files` i `…/diff/file`: zapis żądań, odpowiedzi do ustawienia, wstrzymywanie.
@MainActor
private final class FakeDiffServer {
  /// Żądania w kolejności: `lista` albo `plik:<ścieżka>`.
  private(set) var calls: [String] = []
  var list: DiffFetchOutcome<DiffFileList>
  /// Odpowiedź pliku inna niż domyślny patch.
  var files: [String: DiffFetchOutcome<DiffFilePatch>] = [:]
  /// Każde żądanie czeka na `release()`; odpowiedź jest ustalona w chwili żądania.
  var holding = false
  private var held: [CheckedContinuation<Void, Never>] = []

  init(_ paths: [String] = ["a.ts", "b.ts", "c.ts"], truncated: Bool = false) {
    list = .loaded(Self.listing(paths, truncated: truncated))
  }

  static func listing(_ paths: [String], truncated: Bool = false) -> DiffFileList {
    DiffFileList(
      files: paths.map { DiffListEntry(path: $0, status: .modified, linesAdded: 1, linesDeleted: 1) }, truncated: truncated)
  }

  static func patch(_ path: String, _ body: String = "+nowe") -> DiffFilePatch {
    DiffFilePatch(path: path, patch: "diff --git a/\(path) b/\(path)\n@@ -1 +1 @@\n\(body)\n", truncated: false)
  }

  func fetchList(_ sessionId: String) async -> DiffFetchOutcome<DiffFileList> {
    calls.append("lista")
    let answer = list
    await gate()
    return answer
  }

  func fetchFile(_ sessionId: String, _ path: String) async -> DiffFetchOutcome<DiffFilePatch> {
    calls.append("plik:\(path)")
    let answer = files[path] ?? .loaded(Self.patch(path))
    await gate()
    return answer
  }

  private func gate() async {
    guard holding else { return }
    await withCheckedContinuation { held.append($0) }
  }

  /// Ile żądań czeka na odpowiedź.
  var waiting: Int { held.count }

  /// Odpowiada na najstarsze czekające żądanie.
  func release() {
    held.removeFirst().resume()
  }

  var fileCalls: [String] { calls.filter { $0 != "lista" } }
  var listCalls: Int { calls.count - fileCalls.count }
}

@MainActor
@Suite("okno diffa per plik: lista, rozwinięcia, kolejka i odświeżanie")
struct DiffWindowModelTests {
  private let gone = DiffRefusal(
    status: 404, code: "diff-file-not-found", message: "Tego pliku nie ma na liście zmian — lista mogła się zmienić.")

  /// Okno z atrapą; zadanie pompy trzeba na końcu anulować (`defer`), jak robi to zamknięcie okna.
  private func open(
    _ server: FakeDiffServer, focus: String? = nil, revision: Int = 0
  ) -> (DiffWindowModel, Task<Void, Never>) {
    let model = DiffWindowModel(sessionId: "s1", focus: focus, revision: revision)
    let pump = Task { await model.run(list: server.fetchList, file: server.fetchFile) }
    return (model, pump)
  }

  /// Czeka na warunek, oddając wątek zadaniom głównego aktora (bez zegara: liczba obrotów).
  private func until(_ what: String, _ condition: () -> Bool) async {
    for _ in 0..<20_000 where !condition() { await Task.yield() }
    #expect(condition(), "\(what)")
  }

  private func rows(_ model: DiffWindowModel, _ path: String) -> [String]? {
    guard case let .patch(patch)? = model.sections.first(where: { $0.path == path })?.body else { return nil }
    return patch.rows.map(\.text)
  }

  private func body(_ model: DiffWindowModel, _ path: String) -> DiffFileBody? {
    model.sections.first { $0.path == path }?.body
  }

  // MARK: - Lista i rozwinięcia

  @Test("otwarcie od góry: sama lista, pliki zwinięte; rozwinięcie pobiera patch tego pliku, zwinięcie go nie kasuje")
  func listAndExpansions() async {
    let server = FakeDiffServer()
    let (model, pump) = open(server)
    defer { pump.cancel() }
    #expect(model.phase == .loading && model.fileCount == nil && model.sections.isEmpty)
    await until("lista") { model.idle }
    #expect(model.phase == .loaded && model.fileCount == 3 && !model.listTruncated)
    #expect(server.calls == ["lista"], "bez stuknięcia nie idzie żaden patch")
    #expect(model.sections.map(\.path) == ["a.ts", "b.ts", "c.ts"])
    #expect(model.sections.allSatisfy { !$0.expanded && $0.body == .collapsed })
    #expect(model.sections[0].spoken == "a.ts, zmieniony, 1 dodana linia, 1 usunięta linia")
    #expect(model.takeScrollTarget() == nil, "otwarcie od góry nie przewija")

    model.toggle("b.ts")
    #expect(model.isExpanded("b.ts") && body(model, "b.ts") == .loading)
    await until("patch") { model.idle }
    #expect(server.calls == ["lista", "plik:b.ts"])
    #expect(rows(model, "b.ts") == ["diff --git a/b.ts b/b.ts", "@@ -1 +1 @@", "+nowe"])
    #expect(body(model, "a.ts") == .collapsed)

    model.toggle("b.ts")
    #expect(!model.isExpanded("b.ts") && body(model, "b.ts") == .collapsed)
    model.toggle("b.ts")
    #expect(rows(model, "b.ts")?.count == 3, "treść od razu, bez „Wczytuję…”")
    await until("spokój") { model.idle }
    #expect(server.calls == ["lista", "plik:b.ts"], "ta sama rewizja: zwinąć i rozwinąć nie pobiera drugi raz")
    model.toggle("nie-ma.ts")
    #expect(!model.isExpanded("nie-ma.ts"), "ścieżka spoza sekcji niczego nie rozwija")
  }

  @Test("otwarcie od pliku: lista, potem patch TEGO pliku; rozwinięty tylko on; skok raz na otwarcie")
  func focusOpensFile() async {
    let server = FakeDiffServer()
    let (model, pump) = open(server, focus: "b.ts")
    defer { pump.cancel() }
    await until("lista i plik") { model.idle }
    #expect(server.calls == ["lista", "plik:b.ts"])
    #expect(model.sections.map(\.expanded) == [false, true, false])
    #expect(model.takeScrollTarget() == "b.ts")
    #expect(model.takeScrollTarget() == nil, "drugi raz okno nie skacze")
    model.noteRevision(1)
    await until("odświeżenie") { model.idle }
    #expect(model.takeScrollTarget() == nil, "odświeżenie nie przenosi z powrotem do pliku")
    #expect(server.calls == ["lista", "plik:b.ts", "lista", "plik:b.ts"])
  }

  @Test("skok po ścieżce: plik, prefiks katalogu, ścieżka cytowana przez gita; brak dopasowania = od góry")
  func focusRules() {
    let files = ["src/a.ts", "docs/plan.md", "docs/zażółć.md", "z.ts"].map {
      DiffListEntry(path: $0, status: .added)
    }
    var file = DiffFocus(path: "z.ts")
    #expect(file.take(files: files, truncated: false) == DiffFocus.Target(path: "z.ts", extra: false))
    #expect(file.take(files: files, truncated: false) == nil, "pierwsza lista zużywa skok")
    var directory = DiffFocus(path: "docs/")
    #expect(directory.take(files: files, truncated: false)?.path == "docs/plan.md", "nieśledzony katalog: pierwszy plik pod nim")
    var prefixNotName = DiffFocus(path: "doc/")
    #expect(prefixNotName.take(files: files, truncated: true) == nil, "katalogu spoza listy nie da się pobrać")
    var quoted = DiffFocus(path: #""docs/za\305\274\303\263\305\202\304\207.md""#)
    #expect(quoted.take(files: files, truncated: false)?.path == "docs/zażółć.md", "ramka cytuje, lista nie")
    var missing = DiffFocus(path: "brak.ts")
    #expect(missing.take(files: files, truncated: false) == nil, "pełna lista bez pliku: otwarcie od góry")
    var top = DiffFocus(path: nil)
    #expect(top.take(files: files, truncated: true) == nil)
    var beyond = DiffFocus(path: "daleko/z.ts")
    #expect(beyond.take(files: files, truncated: true) == DiffFocus.Target(path: "daleko/z.ts", extra: true))
    for outside in ["../x.ts", "a/../b.ts", "/etc/hosts", "./a.ts", "a//b.ts"] {
      var focus = DiffFocus(path: outside)
      #expect(focus.take(files: files, truncated: true) == nil, "\(outside): serwer odmówiłby takiej ścieżce")
    }
  }

  @Test("plik spoza uciętej listy dostaje sekcję na górze i swój patch; nietrafiony domysł znika")
  func extraSectionBeyondTruncatedList() async {
    let server = FakeDiffServer(["a.ts", "b.ts"], truncated: true)
    let (model, pump) = open(server, focus: "daleko/z.ts")
    defer { pump.cancel() }
    await until("lista i plik") { model.idle }
    #expect(server.calls == ["lista", "plik:daleko/z.ts"], "serwer sprawdza ścieżkę po pełnych listach gita")
    #expect(model.sections.map(\.path) == ["daleko/z.ts", "a.ts", "b.ts"])
    #expect(model.sections[0].expanded && model.sections[0].status == nil && rows(model, "daleko/z.ts") != nil)
    #expect(model.fileCount == 2 && model.listTruncated, "tytuł liczy listę serwera: „2+”")
    #expect(model.takeScrollTarget() == "daleko/z.ts")
    // Odświeżona lista dalej ucięta i bez pliku: sekcja zostaje u góry.
    model.noteRevision(1)
    await until("odświeżenie") { model.idle }
    #expect(model.sections.map(\.path) == ["daleko/z.ts", "a.ts", "b.ts"])
    // Lista już go niesie: sekcja schodzi na swoje miejsce, rozwinięcie i treść zostają.
    server.list = .loaded(FakeDiffServer.listing(["a.ts", "daleko/z.ts"], truncated: true))
    model.noteRevision(2)
    await until("plik na liście") { model.idle }
    #expect(model.sections.map(\.path) == ["a.ts", "daleko/z.ts"] && model.isExpanded("daleko/z.ts"))

    let wrong = FakeDiffServer(["a.ts"], truncated: true)
    wrong.files["nie-ma.ts"] = .refused(gone)
    let (guess, guessPump) = open(wrong, focus: "nie-ma.ts")
    defer { guessPump.cancel() }
    await until("domysł sprawdzony") { guess.idle }
    #expect(guess.sections.map(\.path) == ["a.ts"], "pliku nie ma w zmianach: sekcja znika")
    #expect(wrong.calls == ["lista", "plik:nie-ma.ts"], "bez odświeżania listy — ucięta i tak go nie pokaże")

    let whole = FakeDiffServer(["a.ts"])
    let (top, topPump) = open(whole, focus: "nie-ma.ts")
    defer { topPump.cancel() }
    await until("lista") { top.idle }
    #expect(whole.calls == ["lista"] && top.sections.map(\.expanded) == [false], "pełna lista: otwarcie od góry")
  }

  // MARK: - Kolejka

  @Test("żądania idą po jednym; plik dopiero co stuknięty idzie przed wcześniej stukniętymi i przed odświeżeniem")
  func oneAtATimeWithPriority() async {
    let server = FakeDiffServer(["a.ts", "b.ts", "c.ts", "d.ts"])
    let (model, pump) = open(server)
    defer { pump.cancel() }
    await until("lista") { model.idle }
    server.holding = true
    model.toggle("a.ts")
    await until("a w drodze") { server.waiting == 1 }
    model.toggle("b.ts")
    model.toggle("c.ts")
    model.toggle("d.ts")
    for _ in 0..<50 { await Task.yield() }
    #expect(server.waiting == 1 && server.fileCalls == ["plik:a.ts"], "naraz jedno żądanie")
    #expect([body(model, "b.ts"), body(model, "c.ts"), body(model, "d.ts")] == [.loading, .loading, .loading])
    for expected in ["plik:d.ts", "plik:c.ts", "plik:b.ts"] {
      server.release()
      await until(expected) { server.fileCalls.last == expected && server.waiting == 1 }
    }
    server.release()
    await until("spokój") { model.idle }
    #expect(server.fileCalls == ["plik:a.ts", "plik:d.ts", "plik:c.ts", "plik:b.ts"])

    // Odświeżenie w toku (lista, potem rozwinięte a i b po kolei) ustępuje plikowi stukniętemu w jego trakcie.
    model.toggle("c.ts")
    model.toggle("d.ts")
    let before = server.calls.count
    model.noteRevision(1)
    await until("lista odświeżenia w drodze") { server.calls.count == before + 1 && server.waiting == 1 }
    server.release()
    await until("a w drodze") { server.calls.last == "plik:a.ts" && server.waiting == 1 }
    model.toggle("c.ts")
    server.release()
    await until("stuknięty przed resztą przejścia") { server.calls.last == "plik:c.ts" && server.waiting == 1 }
    server.release()
    await until("reszta przejścia") { server.calls.last == "plik:b.ts" && server.waiting == 1 }
    server.release()
    await until("spokój") { model.idle }
    #expect(
      Array(server.calls[before...]) == ["lista", "plik:a.ts", "plik:c.ts", "plik:b.ts"], "d jest zwinięty: nie idzie")
  }

  @Test("zwinięcie zdejmuje plik z kolejki; żądanie w drodze dobiega, zostaje w pamięci i nie idzie drugi raz")
  func collapseDequeues() async {
    let server = FakeDiffServer()
    let (model, pump) = open(server)
    defer { pump.cancel() }
    await until("lista") { model.idle }
    server.holding = true
    model.toggle("a.ts")
    await until("a w drodze") { server.waiting == 1 }
    model.toggle("b.ts")
    model.toggle("b.ts")
    model.toggle("a.ts")
    #expect(!model.isExpanded("a.ts") && !model.isExpanded("b.ts"))
    server.release()
    await until("spokój") { model.idle }
    #expect(server.fileCalls == ["plik:a.ts"], "plik zwinięty w kolejce nie poszedł")
    model.toggle("a.ts")
    #expect(rows(model, "a.ts") != nil, "odpowiedź zwiniętego pliku nie przepadła")
    await until("spokój") { model.idle }
    #expect(server.fileCalls == ["plik:a.ts"])
    // Zwinięty i rozwinięty przy żądaniu w drodze: dalej jedno żądanie.
    model.toggle("c.ts")
    await until("c w drodze") { server.waiting == 1 }
    model.toggle("c.ts")
    model.toggle("c.ts")
    server.release()
    await until("spokój") { model.idle }
    #expect(server.fileCalls == ["plik:a.ts", "plik:c.ts"] && rows(model, "c.ts") != nil)
  }

  @Test("„Spróbuj ponownie”: porażka mówi zdaniem, ponowienie pobiera raz — także stuknięte w trakcie żądania")
  func retryWithoutDuplicate() async {
    let server = FakeDiffServer()
    server.files["a.ts"] = .offline
    let (model, pump) = open(server, focus: "a.ts")
    defer { pump.cancel() }
    await until("porażka") { model.idle }
    #expect(body(model, "a.ts") == .failed(UICopy.serverSilent))
    server.files["a.ts"] = .refused(DiffRefusal(status: 503, code: "git-failed", message: "Git nie odpowiedział. Spróbuj ponownie."))
    model.retry("a.ts")
    await until("druga porażka") { model.idle }
    #expect(body(model, "a.ts") == .failed("Git nie odpowiedział. Spróbuj ponownie."), "503: zdanie serwera")
    server.files["a.ts"] = .timedOut
    model.retry("a.ts")
    await until("trzecia porażka") { model.idle }
    #expect(body(model, "a.ts") == .failed(UICopy.controlTimedOut))

    server.files["a.ts"] = nil
    server.holding = true
    model.retry("a.ts")
    #expect(body(model, "a.ts") == .loading)
    await until("w drodze") { server.waiting == 1 }
    model.retry("a.ts")
    model.retry("a.ts")
    for _ in 0..<50 { await Task.yield() }
    #expect(server.waiting == 1)
    server.release()
    await until("treść") { model.idle }
    #expect(server.fileCalls.count == 4, "trzy porażki i jedno udane ponowienie, bez duplikatu")
    #expect(rows(model, "a.ts") != nil)
    model.retry("b.ts")
    await until("spokój") { model.idle }
    #expect(server.fileCalls.count == 4, "ponowienie zwiniętego pliku nic nie wysyła")
  }

  // MARK: - Odświeżanie

  /// Rewizja repozytorium rośnie przy każdej ramce `usage`. Gdyby odpowiedź na starszą rewizję szła do kosza,
  /// przy rewizji rosnącej szybciej, niż wracają odpowiedzi, okno nie pokazałoby niczego.
  @Test("rewizja rośnie szybciej, niż wracają odpowiedzi: każdy rozwinięty plik dostaje treść, a żądań jest skończenie mało")
  func revisionStormStillShowsContent() async {
    let server = FakeDiffServer()
    server.holding = true
    let (model, pump) = open(server, focus: "a.ts")
    defer { pump.cancel() }
    var revision = 0
    func storm() {
      for _ in 0..<40 {
        revision += 1
        model.noteRevision(revision)
      }
    }
    await until("lista w drodze") { server.waiting == 1 }
    storm()
    server.release()
    await until("a w drodze") { server.calls == ["lista", "plik:a.ts"] && server.waiting == 1 }
    #expect(body(model, "a.ts") == .loading)
    storm()
    server.release()
    await until("następne żądanie") { server.calls.count == 3 && server.waiting == 1 }
    #expect(rows(model, "a.ts") != nil, "odpowiedź sprzed 40 rewizji weszła na ekran")
    model.toggle("b.ts")
    // Dwadzieścia odpowiedzi, przed każdą 40 nowych rewizji.
    var released = 2
    for _ in 0..<20 {
      storm()
      server.release()
      released += 1
      await until("kolejne żądanie") { server.calls.count == released + 1 && server.waiting == 1 }
      #expect(server.waiting == 1, "naraz jedno żądanie")
    }
    #expect(rows(model, "a.ts") != nil && rows(model, "b.ts") != nil, "oba rozwinięte pliki mają treść")
    #expect(revision == 880)
    // Burza ustaje: zostaje reszta bieżącego przejścia i najwyżej jedno następne (lista i dwa pliki).
    let atCalm = server.calls.count
    server.holding = false
    server.release()
    await until("spokój") { model.idle }
    #expect(server.calls.count <= atCalm + 5, "po burzy najwyżej jedno przejście: \(server.calls.count - atCalm)")
    #expect(server.calls.count <= 28, "880 rewizji to 22 odpowiedzi i jedno przejście, nie 880 żądań")
    let settled = server.calls.count
    for _ in 0..<200 { await Task.yield() }
    #expect(server.calls.count == settled, "bez nowej rewizji okno niczego nie pobiera")
  }

  @Test("odświeżenie: na czas odczytu stoi poprzednia treść; wiele ramek w trakcie przejścia to jedno następne")
  func refreshKeepsShownContentAndCoalesces() async {
    let server = FakeDiffServer()
    let (model, pump) = open(server, focus: "a.ts")
    defer { pump.cancel() }
    await until("otwarte") { model.idle }
    model.toggle("c.ts")
    await until("c") { model.idle }
    #expect(server.calls == ["lista", "plik:a.ts", "plik:c.ts"])

    server.holding = true
    server.files["a.ts"] = .loaded(FakeDiffServer.patch("a.ts", "+druga wersja"))
    model.noteRevision(1)
    await until("lista w drodze") { server.waiting == 1 }
    #expect(model.phase == .loaded && rows(model, "a.ts")?.last == "+nowe", "lista w drodze nie zdejmuje treści")
    model.noteRevision(2)
    model.noteRevision(3)
    server.release()
    await until("a w drodze") { server.calls.last == "plik:a.ts" && server.waiting == 1 }
    #expect(rows(model, "a.ts")?.last == "+nowe", "plik w drodze dalej pokazuje poprzednią treść")
    model.noteRevision(4)
    server.release()
    await until("c w drodze") { server.calls.last == "plik:c.ts" && server.waiting == 1 }
    #expect(rows(model, "a.ts")?.last == "+druga wersja")
    server.holding = false
    server.release()
    await until("spokój") { model.idle }
    // Następne przejście pomija c: jego żądanie poszło już przy bieżącej rewizji.
    #expect(
      Array(server.calls.dropFirst(3)) == ["lista", "plik:a.ts", "plik:c.ts", "lista", "plik:a.ts"],
      "cztery ramki: przejście w toku i JEDNO następne")
  }

  @Test("rozwinięcie pliku pobranego przed nową rewizją: stara treść od razu, świeża po odpowiedzi")
  func reopenAfterRevisionRefetches() async {
    let server = FakeDiffServer()
    let (model, pump) = open(server, focus: "a.ts")
    defer { pump.cancel() }
    await until("otwarte") { model.idle }
    model.toggle("a.ts")
    model.noteRevision(1)
    await until("odświeżenie") { model.idle }
    #expect(server.calls == ["lista", "plik:a.ts", "lista"], "zwinięty plik nie odświeża się w tle")
    server.files["a.ts"] = .loaded(FakeDiffServer.patch("a.ts", "+świeże"))
    server.holding = true
    model.toggle("a.ts")
    #expect(rows(model, "a.ts")?.last == "+nowe", "do odpowiedzi stoi to, co było")
    await until("w drodze") { server.waiting == 1 }
    server.release()
    await until("spokój") { model.idle }
    #expect(rows(model, "a.ts")?.last == "+świeże" && server.fileCalls.count == 2)
  }

  @Test("odświeżona lista: sekcja, której nie ma, znika z rozwinięciem; nowy plik dochodzi zwinięty")
  func sectionsFollowList() async {
    let server = FakeDiffServer()
    let (model, pump) = open(server, focus: "b.ts")
    defer { pump.cancel() }
    await until("otwarte") { model.idle }
    model.toggle("c.ts")
    await until("c") { model.idle }
    server.list = .loaded(FakeDiffServer.listing(["a.ts", "c.ts", "nowy.ts"]))
    model.noteRevision(1)
    await until("odświeżenie") { model.idle }
    #expect(model.sections.map(\.path) == ["a.ts", "c.ts", "nowy.ts"] && model.fileCount == 3)
    #expect(model.sections.map(\.expanded) == [false, true, false])
    #expect(!model.isExpanded("b.ts"))
    #expect(Array(server.calls.suffix(2)) == ["lista", "plik:c.ts"], "pliku, którego nie ma, okno nie pobiera")
    server.list = .loaded(FakeDiffServer.listing([]))
    model.noteRevision(2)
    await until("pusto") { model.idle }
    #expect(model.phase == .loaded && model.sections.isEmpty && model.fileCount == 0, "wszystko zatwierdzone")
  }

  @Test("404 „nie ma na liście zmian”: lista odświeża się raz; plik, którego już nie ma, znika, uparty mówi zdaniem")
  func fileGoneRefreshesListOnce() async {
    let server = FakeDiffServer()
    let (model, pump) = open(server)
    defer { pump.cancel() }
    await until("lista") { model.idle }
    // Zmiana zniknęła (commit w terminalu bez ramki): patch 404, świeża lista już pliku nie niesie.
    server.files["b.ts"] = .refused(gone)
    server.list = .loaded(FakeDiffServer.listing(["a.ts", "c.ts"]))
    model.toggle("b.ts")
    await until("spokój") { model.idle }
    #expect(server.calls == ["lista", "plik:b.ts", "lista"])
    #expect(model.sections.map(\.path) == ["a.ts", "c.ts"], "sekcja zniknęła bez zdania o błędzie")

    // Plik stoi na liście, a patch dalej odmawia: jedno odświeżenie listy, potem zdanie serwera.
    server.files["c.ts"] = .refused(gone)
    model.toggle("c.ts")
    await until("spokój") { model.idle }
    #expect(Array(server.calls.dropFirst(3)) == ["plik:c.ts", "lista", "plik:c.ts"], "lista odświeżona RAZ")
    #expect(body(model, "c.ts") == .failed("Tego pliku nie ma na liście zmian — lista mogła się zmienić."))
    // Ponowienie ręką to nowa próba: znowu jedno odświeżenie listy.
    server.files["c.ts"] = nil
    model.retry("c.ts")
    await until("spokój") { model.idle }
    #expect(rows(model, "c.ts") != nil && Array(server.calls.dropFirst(6)) == ["plik:c.ts"])

    // 404, a odświeżenie listy pada: sekcja nie zostaje na „Wczytuję…", tylko mówi zdaniem i daje ponowienie.
    server.files["a.ts"] = .refused(gone)
    server.list = .offline
    server.holding = true
    model.toggle("a.ts")
    await until("patch w drodze") { server.waiting == 1 }
    server.release()
    await until("lista w drodze") { server.calls.last == "lista" && server.waiting == 1 }
    #expect(body(model, "a.ts") == .loading, "do rozstrzygnięcia listy sekcja czeka, bez mignięcia błędem")
    server.release()
    await until("spokój") { model.idle }
    #expect(body(model, "a.ts") == .failed("Tego pliku nie ma na liście zmian — lista mogła się zmienić."))
    #expect(model.refreshFailure == UICopy.serverSilent && model.sections.map(\.path) == ["a.ts", "c.ts"])
  }

  @Test("porażka odświeżenia: lista i patch zostają na ekranie, zdanie mówi, że to ostatni znany stan")
  func refreshFailureKeepsContent() async {
    let server = FakeDiffServer()
    let (model, pump) = open(server, focus: "a.ts")
    defer { pump.cancel() }
    await until("otwarte") { model.idle }
    server.list = .offline
    model.noteRevision(1)
    await until("lista padła") { model.idle }
    #expect(model.phase == .loaded && model.sections.count == 3 && model.refreshFailure == UICopy.serverSilent)
    #expect(rows(model, "a.ts") != nil && server.calls == ["lista", "plik:a.ts", "lista"], "bez listy przejście nie idzie dalej")

    server.list = .loaded(FakeDiffServer.listing(["a.ts", "b.ts", "c.ts"]))
    server.files["a.ts"] = .refused(DiffRefusal(status: 503, code: "git-failed", message: "Git nie odpowiedział. Spróbuj ponownie."))
    model.retryList()
    await until("plik padł") { model.idle }
    #expect(model.refreshFailure == nil)
    guard case let .patch(patch)? = body(model, "a.ts") else {
      Issue.record("poprzednia treść powinna stać")
      return
    }
    #expect(patch.rows.count == 3 && patch.stale == "Git nie odpowiedział. Spróbuj ponownie.")
    server.files["a.ts"] = nil
    model.retry("a.ts")
    await until("naprawione") { model.idle }
    guard case let .patch(fresh)? = body(model, "a.ts") else {
      Issue.record("treść po ponowieniu")
      return
    }
    #expect(fresh.stale == nil)
  }

  /// Ostatnia dobra lista była pusta („brak zmian"), a odświeżenie padło: okno nie może pokazywać braku zmian
  /// jako stanu bieżącego. Model niesie zdanie także bez sekcji, a widok pokazuje je pod „Brak zmian…"
  /// z ponowieniem (zdanie rysowały tylko sekcje, których przy pustej liście nie ma).
  @Test("porażka odświeżenia przy pustej liście: zdanie stoi także bez sekcji, ponowienie pobiera listę")
  func refreshFailureOnEmptyList() async {
    let server = FakeDiffServer([])
    let (model, pump) = open(server)
    defer { pump.cancel() }
    await until("otwarte") { model.idle }
    #expect(model.phase == .loaded && model.sections.isEmpty && model.refreshFailure == nil)
    server.list = .refused(DiffRefusal(status: 503, code: "git-failed", message: "Git nie odpowiedział. Spróbuj ponownie."))
    model.noteRevision(1)
    await until("lista padła") { model.idle }
    #expect(model.phase == .loaded && model.sections.isEmpty && model.fileCount == 0)
    #expect(model.refreshFailure == "Git nie odpowiedział. Spróbuj ponownie.")

    server.list = .loaded(FakeDiffServer.listing(["a.ts"]))
    model.retryList()
    await until("ponowione") { model.idle }
    #expect(model.refreshFailure == nil && model.sections.map(\.path) == ["a.ts"] && server.listCalls == 3)
  }

  // MARK: - Pierwsza lista

  @Test("405 na trasie listy: zdanie o starszym serwerze; ponowienie po restarcie otwiera okno od stukniętego pliku")
  func outdatedServer() async {
    let server = FakeDiffServer()
    server.list = .refused(DiffRefusal(status: 405, code: "method-not-allowed", message: "Niedozwolona metoda."))
    let (model, pump) = open(server, focus: "c.ts")
    defer { pump.cancel() }
    await until("odmowa") { model.idle }
    #expect(model.phase == .failed(UICopy.diffServerOutdated))
    #expect(UICopy.diffServerOutdated == "Serwer jest starszy niż apka — zrestartuj go.")
    #expect(model.fileCount == nil && model.sections.isEmpty && server.calls == ["lista"])

    server.holding = true
    model.retryList()
    #expect(model.phase == .loading, "ponowienie ręką wraca do „Wczytuję…”")
    await until("w drodze") { server.waiting == 1 }
    model.retryList()
    for _ in 0..<50 { await Task.yield() }
    #expect(server.waiting == 1 && server.listCalls == 2, "ponowienie przy liście w drodze nie wysyła drugiej")
    server.release()
    await until("dalej odmowa") { model.idle }
    #expect(model.phase == .failed(UICopy.diffServerOutdated))

    // Nowa ramka po restarcie serwera ponawia sama; zdanie stoi do odpowiedzi.
    server.holding = false
    server.list = .loaded(FakeDiffServer.listing(["a.ts", "b.ts", "c.ts"]))
    model.noteRevision(1)
    #expect(model.phase == .failed(UICopy.diffServerOutdated))
    await until("otwarte") { model.idle }
    #expect(model.phase == .loaded && model.isExpanded("c.ts") && model.takeScrollTarget() == "c.ts")
    #expect(server.fileCalls == ["plik:c.ts"])
  }

  @Test("porażki pierwszej listy: zdanie serwera, sieć, limit czasu; brak zmian to nie porażka")
  func firstListFailures() async {
    let cases: [(DiffFetchOutcome<DiffFileList>, String)] = [
      (.refused(DiffRefusal(status: 400, code: "bad-request", message: "Codex: bez diffa.")), "Codex: bez diffa."),
      (.refused(DiffRefusal(status: 503, code: "git-failed", message: nil)), UICopy.diffFailed),
      (.offline, UICopy.serverSilent),
      (.timedOut, UICopy.controlTimedOut),
      (.failed, UICopy.diffFailed),
    ]
    for (outcome, sentence) in cases {
      let server = FakeDiffServer()
      server.list = outcome
      let (model, pump) = open(server)
      await until("porażka") { model.idle }
      #expect(model.phase == .failed(sentence))
      pump.cancel()
    }
    let empty = FakeDiffServer([])
    let (model, pump) = open(empty)
    defer { pump.cancel() }
    await until("pusto") { model.idle }
    #expect(model.phase == .loaded && model.fileCount == 0 && model.sections.isEmpty)
  }

  // MARK: - Treść pliku

  @Test("odpowiedź z dwoma blokami `diff --git` stoi pod jednym nagłówkiem; ucięty plik niesie znacznik")
  func twoBlocksUnderOneHeader() async {
    let server = FakeDiffServer(["link"])
    let typeChange = "diff --git a/link b/link\ndeleted file mode 100644\n--- a/link\n+++ /dev/null\n@@ -1 +0,0 @@\n-treść\n"
      + "diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+cel\n"
    server.files["link"] = .loaded(DiffFilePatch(path: "link", patch: typeChange, truncated: true))
    let (model, pump) = open(server, focus: "link")
    defer { pump.cancel() }
    await until("patch") { model.idle }
    #expect(model.sections.count == 1, "sekcję wyznacza ścieżka z żądania, nie liczba bloków")
    guard case let .patch(patch)? = body(model, "link") else {
      Issue.record("patch")
      return
    }
    #expect(patch.rows.count == 12 && patch.rows.filter { $0.text.hasPrefix("diff --git ") }.count == 2)
    #expect(Set(patch.rows.map(\.id)).count == 12, "linie obu bloków mają różne tożsamości")
    #expect(patch.truncated && patch.stale == nil)
  }

  @Test("bilans pliku bez liczników: tylko z kompletnego tekstowego patcha; binarny ma oznaczenie; lista ma pierwszeństwo")
  func statFromCompletePatch() async {
    let server = FakeDiffServer()
    server.list = .loaded(DiffFileList(
      files: [
        DiffListEntry(path: "nowy.txt", status: .added),
        DiffListEntry(path: "wielki.log", status: .added),
        DiffListEntry(path: "obraz.png", status: .added),
        DiffListEntry(path: "liczony.ts", status: .modified, linesAdded: 7, linesDeleted: 2),
        DiffListEntry(path: "znany.bin", status: .modified, binary: true),
      ], truncated: false))
    let text = "diff --git a/nowy.txt b/nowy.txt\nnew file mode 100644\n--- /dev/null\n+++ b/nowy.txt\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n"
    server.files["nowy.txt"] = .loaded(DiffFilePatch(path: "nowy.txt", patch: text, truncated: false))
    server.files["wielki.log"] = .loaded(DiffFilePatch(path: "wielki.log", patch: text, truncated: true))
    server.files["obraz.png"] = .loaded(DiffFilePatch(
      path: "obraz.png", patch: "diff --git a/obraz.png b/obraz.png\nBinary files /dev/null and b/obraz.png differ\n", truncated: false))
    server.files["liczony.ts"] = .loaded(DiffFilePatch(path: "liczony.ts", patch: text, truncated: false))
    let (model, pump) = open(server)
    defer { pump.cancel() }
    await until("lista") { model.idle }
    func stat(_ path: String) -> [String] {
      let section = model.sections.first { $0.path == path }
      return ["\(section?.added.map(String.init) ?? "-")", "\(section?.deleted.map(String.init) ?? "-")", section?.binary == true ? "bin" : ""]
    }
    #expect(stat("nowy.txt") == ["-", "-", ""], "przed rozwinięciem: nie wiem")
    #expect(stat("znany.bin") == ["-", "-", "bin"])
    for path in ["nowy.txt", "wielki.log", "obraz.png", "liczony.ts"] { model.toggle(path) }
    await until("patche") { model.idle }
    #expect(stat("nowy.txt") == ["3", "0", ""], "kompletny patch tekstowy: bilans z linii")
    #expect(model.sections[0].spoken == "nowy.txt, nowy, 3 dodane linie")
    #expect(stat("wielki.log") == ["-", "-", ""], "ucięty patch: liczba udawałaby pełny wynik")
    #expect(stat("obraz.png") == ["-", "-", "bin"] && model.sections[2].spoken == "obraz.png, nowy, plik binarny")
    #expect(stat("liczony.ts") == ["7", "2", ""], "liczniki z listy zostają")
    model.toggle("nowy.txt")
    #expect(stat("nowy.txt") == ["3", "0", ""], "zwinięty plik pamięta bilans")
  }

  // MARK: - Zamknięcie okna

  @Test("zamknięcie okna anuluje odczyty: odpowiedź, która dobiegła później, niczego nie zmienia")
  func closingCancels() async {
    let server = FakeDiffServer()
    let (model, pump) = open(server, focus: "a.ts")
    await until("otwarte") { model.idle }
    server.holding = true
    model.toggle("b.ts")
    model.toggle("c.ts")
    await until("b albo c w drodze") { server.waiting == 1 }
    let sent = server.calls
    pump.cancel()
    server.release()
    await pump.value
    for _ in 0..<200 { await Task.yield() }
    #expect(server.calls == sent, "po zamknięciu nie idzie następne żądanie z kolejki")
    #expect(body(model, "b.ts") == .loading && body(model, "c.ts") == .loading, "wynik po anulowaniu nie wchodzi")
  }
}
