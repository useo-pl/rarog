import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Formularz „Nowa sesja": pole ścieżki, przeglądarka, ustawienia startu, ostatnie
// projekty i wiersze do wznowienia. Właściciel: sterowanie sesją.

@Suite("pole ścieżki i przeglądarka katalogów")
struct PathFieldTests {
  @Test("katalog kończy się ukośnikiem, ogon to filtr; puste pole = korzenie; nazwa bez ukośnika filtruje korzenie")
  func parse() {
    #expect(PathField.parse("") == (nil, ""))
    #expect(PathField.parse("/Users/d/Projects/") == ("/Users/d/Projects", ""))
    #expect(PathField.parse("/Users/d/Projects/pi") == ("/Users/d/Projects", "pi"))
    #expect(PathField.parse("/") == ("/", ""))
    #expect(PathField.parse("/pi") == ("/", "pi"))
    #expect(PathField.parse("pil") == (nil, "pil"))
  }

  @Test("cwd for the server: without the marker slash, with the tail")
  func launchCwd() {
    #expect(PathField.launchCwd("/a/b/") == "/a/b")
    #expect(PathField.launchCwd("/a/b/nowy") == "/a/b/nowy")
    #expect(PathField.launchCwd("/") == "/")
  }

  @Test("filter anywhere in the name, case-insensitive; pill labels with the parent on a collision")
  func filterAndChips() {
    let entries = [DirEntry(name: "Rarog", path: "/p/Rarog"), DirEntry(name: "willow", path: "/p/willow"),
                   DirEntry(name: "fleet-Lumen", path: "/p/fleet-Lumen")]
    #expect(PathField.filter(entries, "ra").map(\.name) == ["Rarog"])
    #expect(PathField.filter(entries, "lumen").map(\.name) == ["fleet-Lumen"], "middle of the name")
    #expect(PathField.filter(entries, "llo").map(\.name) == ["willow"])
    #expect(PathField.filter(entries, "").count == 3)
    #expect(PathField.chipLabels(["/a/rarog", "/b/rarog", "/c/willow"]) == ["a/rarog", "b/rarog", "willow"])
    #expect(PathField.basename("/a/b/c/") == "c")
  }

  @Test("sentence under the list: error, empty, truncated, no match; roots level without a hint (the choose bar has it)")
  func statusLine() {
    let roots = DirListing(path: nil, parent: nil, entries: [DirEntry(name: "a", path: "/a")])
    #expect(DirectoryView(dir: nil, status: .ready, listing: roots).statusLine == nil)
    #expect(DirectoryView(dir: nil, status: .ready, listing: DirListing(path: nil, parent: nil, entries: [])).statusLine
      == UICopy.dirNoRoots)
    let empty = DirListing(path: "/a", parent: nil, entries: [])
    #expect(DirectoryView(dir: "/a", status: .ready, listing: empty).statusLine == UICopy.dirEmpty)
    let full = DirListing(path: "/a", parent: nil, entries: [DirEntry(name: "x", path: "/a/x")], truncated: true)
    #expect(DirectoryView(dir: "/a", status: .ready, listing: full).statusLine == UICopy.dirTruncated(1))
    #expect(DirectoryView(dir: "/a", filter: "zz", status: .ready, listing: full).statusLine == "Nic nie pasuje do „zz”.")
    #expect(DirectoryView(dir: "/a", status: .error("Poza listą.")).statusLine == "Poza listą.")
    #expect(DirectoryView(dir: "/a", status: .loading).statusLine == nil, "loading is told by the skeleton")
  }

  @Test("directory row: statuses as muted text (current, git, history); in words for VoiceOver, the row opens it")
  func marksAndSpoken() {
    let rarog = DirEntry(name: "rarog", path: "/p/rarog", git: true, history: true)
    #expect(DirectoryView.marks(rarog, current: "/p/rarog/") == [.current, .git, .history])
    #expect(DirectoryView.marks(rarog, current: "/p/inny") == [.git, .history])
    #expect(DirectoryView.marks(DirEntry(name: "x", path: "/x"), current: nil).isEmpty)
    #expect(UICopy.dirRowSpoken(rarog, marks: [.current, .git, .history])
      == "rarog, bieżący, repozytorium git, ma historię CLI")
    #expect(UICopy.dirRowSpoken(DirEntry(name: "x", path: "/x"), marks: []) == "x")
    #expect(UICopy.dirRowHint == "Otwiera katalog.")
  }

  @Test("Up names where it goes: the parent directory, or the roots level without a name")
  func upSpoken() {
    #expect(UICopy.upSpoken(.directory("/Users/d/Projects")) == "W górę do Projects")
    #expect(UICopy.upSpoken(.directory("/Users/d")) == "W górę do d")
    #expect(UICopy.upSpoken(.roots) == "W górę")
    #expect(UICopy.upSpoken(nil) == "W górę", "a disabled Up still has a label")
  }

  @Test("the browser field takes focus only with a hardware keyboard")
  func focus() {
    #expect(PathField.focusesOnBrowse(hardwareKeyboard: true))
    #expect(!PathField.focusesOnBrowse(hardwareKeyboard: false), "on touch the on-screen keyboard would cover the list")
  }

  @Test("while the browser is open, the footer has the hint and Choose with the directory name instead of Launch")
  func launchWaitsForChoice() {
    #expect(UICopy.browseHint == "Stuknij katalog, żeby go otworzyć.")
    #expect(UICopy.choose("atlas-docs") == "Wybierz atlas-docs")
  }
}

@Suite("ustawienia startu")
struct StartSettingsTests {
  private let choices = [
    ModelChoice(value: "", label: "Model domyślny konta", effortLevels: []),
    ModelChoice(value: "fable", label: "Fable", effortLevels: [.low, .high, .xhigh]),
    ModelChoice(value: "opus[1m]", label: "Opus", effortLevels: [.low, .high, .xhigh]),
    ModelChoice(value: "haiku", label: "Haiku", effortLevels: []),
  ]

  @Test("domyślnie: tryb auto, opus[1m] i xhigh; zapamiętany model wygrywa, gdy serwer go zna")
  func defaults() {
    #expect(StartSettings().mode == .auto)
    #expect(StartModel.resolveModel(choices, saved: nil) == "opus[1m]")
    #expect(StartModel.resolveModel(choices, saved: NewSessionDefaults(model: "fable")) == "fable")
    #expect(StartModel.resolveModel(choices, saved: NewSessionDefaults(model: "wycofany")) == "opus[1m]")
    #expect(StartModel.resolveModel(choices, saved: NewSessionDefaults(effort: .low)) == "opus[1m]", "sam effort")
    #expect(StartModel.resolveModel([], saved: nil) == "", "bez listy — model konta")
    #expect(StartModel.options([choices[1]]).first?.value == "", "pozycja konta dokładana raz")
    #expect(StartModel.options(choices).filter { $0.value == "" }.count == 1)
  }

  /// Wybór „Model domyślny konta" zapisywał się jako brak modelu,
  /// a brak modelu przy następnym wejściu dawał podpowiedź `opus[1m]`.
  @Test("świadomy „Model domyślny konta” przeżywa ponowne otwarcie; w żądaniu modelu nie ma")
  func accountDefaultSurvives() throws {
    let account = StartSettings(mode: .auto, model: "", modelLabel: "Model domyślny konta", effort: nil)
    let saved = try JSONDecoder().decode(NewSessionDefaults.self, from: JSONEncoder().encode(account.defaults))
    #expect(saved.model == nil && saved.modelAccount)
    #expect(StartModel.resolveModel(StartModel.options(choices), saved: saved) == "", "ostatni wybór urządzenia wygrywa")
    #expect(account.body(cwd: "/p").model == nil)
    let opus = StartSettings(mode: .auto, model: "opus[1m]", modelLabel: "Opus", effort: .xhigh)
    #expect(!opus.defaults.modelAccount, "konkretny model nadpisuje wcześniejszy wybór konta")
    let old = try JSONDecoder().decode(NewSessionDefaults.self, from: Data(#"{"effort":"high"}"#.utf8))
    #expect(!old.modelAccount && StartModel.resolveModel(choices, saved: old) == "opus[1m]", "stary wpis bez pola")
  }

  /// Odpowiedź `GET /api/models`, która doszła po wyborze w otwartym
  /// formularzu, przywracała zapamiętany model albo Opusa — „Uruchom" wysyłał inny model niż wybrany.
  @Test("spóźniona lista modeli nie nadpisuje wyboru z tej prezentacji, póki go zna")
  func lateListKeepsChoice() {
    let saved = NewSessionDefaults(model: "fable")
    #expect(StartModel.resolveModel(choices, saved: saved, chosen: "haiku") == "haiku")
    #expect(StartModel.resolveModel(choices, saved: saved, chosen: "") == "", "wybór modelu konta też zostaje")
    var account = NewSessionDefaults()
    account.modelAccount = true
    #expect(StartModel.resolveModel(choices, saved: account, chosen: "fable") == "fable")
    #expect(StartModel.resolveModel(choices, saved: saved, chosen: "wycofany") == "fable", "spoza listy: preferencja")
    #expect(StartModel.resolveModel(choices, saved: saved, chosen: nil) == "fable", "przed edycją: zapamiętany")
  }

  @Test("effort: bez zapisu xhigh, jeśli model zna; świadome „auto” przeżywa; spoza listy modelu → auto")
  func effort() {
    let levels: [EffortLevel] = [.low, .high, .xhigh]
    #expect(StartModel.resolveEffort(levels, saved: nil) == .xhigh)
    #expect(StartModel.resolveEffort([], saved: nil) == nil)
    var auto = NewSessionDefaults(model: "fable")
    auto.effortAuto = true
    #expect(StartModel.resolveEffort(levels, saved: auto) == nil)
    #expect(StartModel.resolveEffort(levels, saved: NewSessionDefaults(model: "fable", effort: .low)) == .low)
    #expect(StartModel.resolveEffort(levels, saved: NewSessionDefaults(model: "fable", effort: .max)) == nil)
  }

  /// Plan po audycie 4.1: okno nowej sesji liczy effort tą samą funkcją; wybór ręką z tej prezentacji idzie
  /// za modelem jak zapamiętany, a podpowiedź `xhigh` dostaje tylko formularz bez żadnego wyboru.
  @Test("effort: wybór ręką wygrywa z zapisem; spoza listy nowego modelu → auto, bez powrotu do zapisu i xhigh")
  func effortChosen() {
    let levels: [EffortLevel] = [.low, .high, .xhigh]
    let saved = NewSessionDefaults(model: "fable", effort: .low)
    #expect(StartModel.resolveEffort(levels, saved: saved, chosen: .high) == .high)
    #expect(StartModel.resolveEffort(levels, saved: saved, chosen: .some(nil)) == nil, "świadome „auto” ręką")
    #expect(StartModel.resolveEffort(levels, saved: nil, chosen: .some(nil)) == nil, "auto nie wraca do xhigh")
    #expect(StartModel.resolveEffort(levels, saved: saved, chosen: .max) == nil, "spoza listy: auto, nie zapis")
    #expect(StartModel.resolveEffort(levels, saved: nil, chosen: .max) == nil, "spoza listy: auto, nie xhigh")
    #expect(StartModel.resolveEffort([], saved: nil, chosen: .high) == nil, "model bez effortu")
    #expect(StartModel.resolveEffort(levels, saved: saved, chosen: nil) == .low, "przed edycją: zapamiętany")
    #expect(StartModel.resolveEffort(levels, saved: nil, chosen: nil) == .xhigh, "bez wyboru: podpowiedź")
  }

  @Test("podsumowania i ciało: model konta i auto nie lecą; tryb jedzie zawsze; zapis bez trybu")
  func summaryAndBody() {
    let opus = StartSettings(mode: .auto, model: "opus[1m]", modelLabel: "Opus", effort: .xhigh)
    #expect(opus.summary == "Auto · Opus · xhigh")
    #expect(opus.launchSummary(cwd: "/p/willow/") == "willow · Auto · Opus · xhigh")
    #expect(opus.launchSummary(cwd: "") == "")
    #expect(opus.body(cwd: "/p/willow/") == CreateSessionBody(cwd: "/p/willow", permissionMode: .auto, model: "opus[1m]", effort: .xhigh))
    let account = StartSettings(mode: .manual, model: "", modelLabel: "Model domyślny konta", effort: nil)
    #expect(account.summary == "Pytaj · model konta")
    #expect(account.body(cwd: "/p") == CreateSessionBody(cwd: "/p", permissionMode: .manual))
    #expect(account.defaults.model == nil && account.defaults.effortAuto)
    #expect(opus.defaults == NewSessionDefaults(model: "opus[1m]", effort: .xhigh))
  }

  @Test("ultracode: wyłączony domyślnie; włączony wymusza xhigh i leci w ciele; pamięć bez niego; znika z modelem")
  func ultracode() {
    let ultra = [
      ModelChoice(value: "", label: "Model domyślny konta", effortLevels: []),
      ModelChoice(value: "opus[1m]", label: "Opus", effortLevels: [.low, .high, .xhigh], ultracode: true),
      ModelChoice(value: "haiku", label: "Haiku", effortLevels: []),
    ]
    var opus = StartSettings(mode: .auto, model: "opus[1m]", modelLabel: "Opus", effort: .high)
    #expect(!opus.ultracode && opus.launchEffort == .high, "domyślnie wyłączony")
    #expect(opus.body(cwd: "/p").ultracode == nil, "wyłączony = bez pola, decydują ustawienia Claude Code")
    #expect(StartModel.ultracodeAvailable(ultra, model: "opus[1m]"))
    #expect(!StartModel.ultracodeAvailable(ultra, model: "haiku") && !StartModel.ultracodeAvailable(ultra, model: ""))

    opus.setUltracode(true, choices: ultra)
    #expect(opus.ultracode && opus.launchEffort == .xhigh, "flaga startu ustawia xhigh")
    #expect(opus.effort == .high, "wybór z menu czeka pod spodem")
    #expect(opus.summary == "Auto · Opus · xhigh · ultracode")
    #expect(opus.body(cwd: "/p/willow/")
      == CreateSessionBody(cwd: "/p/willow", permissionMode: .auto, model: "opus[1m]", effort: .xhigh, ultracode: true))
    #expect(opus.defaults == NewSessionDefaults(model: "opus[1m]", effort: .high),
            "pamięć urządzenia bez ultracode i bez wymuszonego xhigh")
    opus.setUltracode(false, choices: ultra)
    #expect(!opus.ultracode && opus.launchEffort == .high && opus.summary == "Auto · Opus · high", "po wyłączeniu wraca wybór")

    opus.setUltracode(true, choices: ultra)
    opus.model = "haiku"
    opus.syncUltracode(choices: ultra)
    #expect(!opus.ultracode, "model bez pola zdejmuje przełącznik")
    var account = StartSettings(mode: .auto, model: "", modelLabel: "Model domyślny konta", effort: nil)
    account.setUltracode(true, choices: ultra)
    #expect(!account.ultracode && account.body(cwd: "/p").ultracode == nil, "model konta bez przełącznika")

    var refreshed = StartSettings(mode: .manual, model: "opus[1m]", modelLabel: "Opus", effort: .xhigh)
    refreshed.setUltracode(true, choices: ultra)
    refreshed.syncUltracode(choices: choices)
    #expect(!refreshed.ultracode, "odświeżona lista bez pola (stary serwer) zdejmuje wybór")
    refreshed.setUltracode(true, choices: choices)
    #expect(!refreshed.ultracode, "serwer bez możliwości: nie da się włączyć")
  }

  @Test("tryby w oknie: od najmniejszej swobody, krótkie nazwy, zdanie o każdym; auto nie obiecuje „bez pytań”")
  func modes() {
    #expect(StartMode.segmentOrder == [.plan, .manual, .acceptEdits, .auto])
    #expect(Set(StartMode.segmentOrder) == Set(StartMode.allCases), "przełącznik ma każdy tryb formularza")
    #expect(StartMode.segmentOrder.map(UICopy.startModeShort) == ["Plan", "Pytaj", "Edycje", "Auto"])
    for mode in StartMode.allCases { #expect(!UICopy.startModeHint(mode).isEmpty) }
    #expect(UICopy.startModeHint(.auto).contains("klasyfikator"))
    #expect(!UICopy.startModeHint(.manual).contains("wszystko"), "reguły allow działają też w trybie ręcznym")
  }

  @Test("pamięć urządzenia: świadome „auto” w zapisie, stary wpis bez pola czytany")
  func defaultsCodable() throws {
    var auto = NewSessionDefaults(model: "fable")
    auto.effortAuto = true
    let data = try JSONEncoder().encode(auto)
    #expect(try JSONDecoder().decode(NewSessionDefaults.self, from: data) == auto)
    let old = try JSONDecoder().decode(NewSessionDefaults.self, from: Data(#"{"model":"fable","effort":"high"}"#.utf8))
    #expect(old == NewSessionDefaults(model: "fable", effort: .high) && !old.effortAuto)
  }
}

@Suite("„Ostatnie” i wiersze do wznowienia")
struct ResumeRowTests {
  @Test("pills: the server list without the current project, at most 12, no device history")
  func chips() {
    let server = ["/p/0", "/p/app/"] + (1...11).map { "/p/\($0)" }
    let chips = RecentChips.update(shown: [], server: server, excluding: "/p/app")
    #expect(chips.count == 12 && !chips.contains("/p/app"), "13 server entries, the current one skipped")
    #expect(chips.first == "/p/0" && chips.last == "/p/11")
    #expect(RecentChips.update(shown: [], server: Array(server.prefix(12)), excluding: "/p/app").count == 11,
            "older server: 12 entries including the current one")
  }

  @Test("pills: a refreshed list does not reorder existing ones; new ones join at the end while there is room")
  func chipsStayInPlace() {
    let shown = RecentChips.update(shown: [], server: ["/p/a", "/p/b", "/p/c"], excluding: nil)
    let refreshed = RecentChips.update(shown: shown, server: ["/p/new", "/p/c", "/p/a"], excluding: nil)
    #expect(refreshed == ["/p/a", "/p/b", "/p/c", "/p/new"])
    let full = (1...12).map { "/q/\($0)" }
    #expect(RecentChips.update(shown: full, server: ["/q/new"] + full.reversed(), excluding: nil) == full, "no room")
  }

  @Test("conversations in two groups: Open above Resumable; the open status is muted text in the metadata")
  func groups() {
    let open = entry(#"{"engineSessionId":"o","cwd":"/p","mtime":"\#(Sample.iso(26))","firstPrompt":"p","liveInHerdr":true,"gitBranch":"main"}"#)
    let closed = entry(#"{"engineSessionId":"c","cwd":"/p","mtime":"\#(Sample.iso(7200))","firstPrompt":"p","liveInHerdr":false}"#)
    let groups = ResumeGroups.split([closed, open])
    #expect(groups.map(\.kind) == [.open, .resumable])
    #expect(groups.map { $0.entries.map(\.engineSessionId) } == [["o"], ["c"]])
    #expect(ResumeGroups.split([closed]).map(\.kind) == [.resumable], "an empty group has no header")
    #expect(UICopy.resumeGroup(.open) == "Otwarte" && UICopy.resumeGroup(.resumable) == "Do wznowienia")
    #expect(ResumeRow.meta(open, now: Sample.now) == "26\u{00A0}s · main · otwarta")
    #expect(!ResumeRow.meta(closed, now: Sample.now).contains("otwarta"))
  }

  private func entry(_ json: String) -> ResumableSession {
    Sample.decode(ResumableSession.self, json)
  }

  @Test("tytuł: etykieta, potem pierwszy prompt; pusty wpis ma zdanie; metadane z czasem i gałęzią")
  func titleAndMeta() {
    let titled = entry(#"{"engineSessionId":"e","cwd":"/p","mtime":"\#(Sample.iso(240))","firstPrompt":"p","liveInHerdr":false,"title":"T","gitBranch":"fix/zapis"}"#)
    #expect(ResumeRow.title(titled) == "T")
    #expect(ResumeRow.meta(titled, now: Sample.now) == "4\u{00A0}min · fix/zapis")
    let long = entry(#"{"engineSessionId":"e","cwd":"/p","mtime":"\#(Sample.iso(240))","firstPrompt":"p","liveInHerdr":false,"gitBranch":"feature/bardzo-dluga-nazwa-galezi-z-ticketem-1234"}"#)
    let shortened = ResumeRow.meta(long, now: Sample.now).components(separatedBy: " · ").last ?? ""
    #expect(shortened.count == 24 && shortened.hasPrefix("feature/bar") && shortened.hasSuffix("tem-1234"))
    let blank = entry(#"{"engineSessionId":"e","cwd":"/p","mtime":"x","firstPrompt":"  ","liveInHerdr":false}"#)
    #expect(ResumeRow.title(blank) == UICopy.resumeUntitled)
    #expect(UICopy.resumeMetaSpoken(blank, now: Sample.now) == "czas ostatniej zmiany nieznany")
  }

  @Test("przejście do otwartej rozmowy: karta z `sessionId`, także przy kilku kartach w katalogu")
  func openTargetBySessionId() {
    let live = entry(#"{"engineSessionId":"e","cwd":"/Users/demo/Projects/willow/","mtime":"x","firstPrompt":"p","liveInHerdr":true,"sessionId":"b"}"#)
    var state = Sample.state(session: Sample.session(id: "a", title: "willow"))
    state.sessions["b"] = Sample.session(id: "b", title: "willow")
    #expect(ResumeRow.openTarget(live, in: state) == "b")
    state.sessions["b"] = nil
    #expect(ResumeRow.openTarget(live, in: state) == nil, "karta, której apka nie zna, nie jest zgadywana inną")
    #expect(ResumeRow.openMiss(live, in: state) == UICopy.resumeOpenMissing)
  }

  @Test("linia kontekstu projektu: gałąź i zmiany z otwartej sesji, liczba otwartych; bez otwartych nic")
  func projectContext() {
    var state = Sample.state(session: Sample.session(id: "a", title: "willow", extra: #""branch":"main","dirtyCount":9"#))
    state.sessions["b"] = Sample.session(id: "b", title: "willow", state: "waiting-input")
    state.sessions["c"] = Sample.session(id: "c", title: "willow", state: "done", extra: #""branch":"stara""#)
    state.sessions["d"] = Sample.session(id: "d", title: "inny")
    #expect(ProjectContext.line(cwd: "/Users/demo/Projects/willow/", in: state) == "main · 9 zmian · 2 otwarte sesje")
    state.sessions["a"] = Sample.session(id: "a", title: "willow", extra: #""branch":"main","dirtyCount":0"#)
    state.sessions["b"] = nil
    #expect(ProjectContext.line(cwd: "/Users/demo/Projects/willow", in: state) == "main · 1 otwarta sesja")
    #expect(ProjectContext.line(cwd: "/Users/demo/Projects/pusty", in: state) == nil)
  }

  @Test("„Otwórz sesję” bez `sessionId` (starszy serwer): tylko przy jednej karcie w katalogu; kilka — zdanie")
  func openTarget() {
    let live = entry(#"{"engineSessionId":"e","cwd":"/Users/demo/Projects/willow/","mtime":"x","firstPrompt":"p","liveInHerdr":true}"#)
    var state = Sample.state(session: Sample.session(id: "a", title: "willow"))
    #expect(ResumeRow.openTarget(live, in: state) == "a")
    state.sessions["b"] = Sample.session(id: "b", title: "willow")
    #expect(ResumeRow.openTarget(live, in: state) == nil)
    #expect(ResumeRow.openMiss(live, in: state) == UICopy.resumeOpenAmbiguous)
    let empty = Sample.state(session: Sample.session(id: "c", title: "inny"))
    #expect(ResumeRow.openMiss(live, in: empty) == UICopy.resumeOpenMissing)
  }
}
