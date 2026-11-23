import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Nagłówek sesji: pierścień kontekstu, linia gita, plakietka „w tle", pigułki modelu
// i trybu, arkusz „Model i effort", lista plików i podział patcha. Reguły z PWA
// (`contextStat`, `headStats`, `headSpoken`, `modelPillCopy`, `modelOptions`, `modelPatch`,
// `formatModelLabel`, `modelAlias`, `splitPatchFiles`, `commitWhen`).

@Suite("nagłówek: kontekst okna")
struct ContextGaugeTests {
  @Test("znany limit: twardy procent z sufitem 100; zero limitu i ujemne tokeny = nie wiem")
  func known() throws {
    let gauge = try #require(ContextGauge.make(context: .known(tokens: 24_000, limit: 200_000, source: .model), usage: nil))
    #expect(gauge.text == "12%" && gauge.percent == 12 && !gauge.estimated && gauge.tone == .calm)
    #expect(gauge.spoken == "kontekst 12 procent")
    #expect(ContextGauge.make(context: .known(tokens: 250_000, limit: 200_000, source: .model), usage: nil)?.text == "100%")
    #expect(ContextGauge.make(context: .known(tokens: 170_000, limit: 200_000, source: .statusline), usage: nil)?.tone == .warn)
    #expect(ContextGauge.make(context: .known(tokens: 180_000, limit: 200_000, source: .statusline), usage: nil)?.tone == .hot)
    #expect(ContextGauge.make(context: .known(tokens: 5, limit: 0, source: .model), usage: nil) == nil)
    #expect(ContextGauge.make(context: nil, usage: nil) == nil)
  }

  @Test("nieznany limit: tylda, okno od najwyżej osiągniętej liczby, czytnik słyszy szacunek")
  func estimated() throws {
    let small = try #require(ContextGauge.make(context: .unknown(tokens: 134_000, atLeast: nil), usage: nil))
    #expect(small.text == "~67%" && small.estimated)
    #expect(small.spoken.contains("licząc od okna 200 tysięcy") && small.spoken.contains("nie jest potwierdzony"))
    let big = try #require(ContextGauge.make(context: .unknown(tokens: 300_000, atLeast: nil), usage: nil))
    #expect(big.text == "~30%" && big.spoken.contains("okna miliona"))
    // Po `/compact` tokeny spadły, ale sesja uniosła 744k — procent od miliona, nie od 200k.
    let compacted = try #require(ContextGauge.make(context: .unknown(tokens: 130_000, atLeast: 744_000), usage: nil))
    #expect(compacted.text == "~13%")
  }

  @Test("bez `context` zapasem jest `usage`; `context` wypiera `usage`")
  func usageFallback() {
    let usage = SessionUsage(contextTokens: 50_000, contextLimit: 100_000)
    #expect(ContextGauge.make(context: nil, usage: usage)?.text == "50%")
    #expect(ContextGauge.make(context: .unknown(tokens: 20_000, atLeast: nil), usage: usage)?.text == "~10%")
  }
}

@Suite("nagłówek: linia gita")
struct GitLineTests {
  private func meta(_ extra: String, fresh: String? = nil) -> GitMeta {
    let event = fresh.map { json -> GitStatusEvent in
      Sample.decode(GitStatusEvent.self, #"{"sessionId":"s1","branch":"main","dirtyCount":2,\#(json)}"#)
    }
    return GitMeta(session: Sample.session(extra: extra), fresh: event)
  }

  @Test("gałąź, najpierw pobranie, trójka plików sklejona; zera nie tworzą segmentu")
  func segments() {
    let full = meta(#""branch":"main","dirtyCount":9,"ahead":1,"behind":2,"fileKinds":{"added":3,"modified":5,"deleted":1}"#)
    #expect(full.segments.map(\.text) == ["main", "↓2", "↑1", "+3", "~5", "−1"])
    #expect(full.segments.map(\.glued) == [false, false, true, false, true, true])
    let zeros = meta(#""branch":"feat","dirtyCount":0,"ahead":0,"behind":0,"fileKinds":{"added":0,"modified":2,"deleted":0}"#)
    #expect(zeros.segments.map(\.text) == ["feat", "~2"])
    #expect(zeros.segments.last?.glued == false, "pierwszy segment trójki nie klei się z gałęzią")
  }

  @Test("bez rodzajów plików sam licznik; brak upstreamu chowa strzałki; ramka uzupełnia podsumowanie")
  func fallbacks() {
    let plain = meta(#""branch":"main","dirtyCount":3"#)
    #expect(plain.segments.map(\.text) == ["main", "3\u{00A0}pliki"])
    let fresh = meta("", fresh: #""files":["a.ts","b.ts"],"ahead":4"#)
    #expect(fresh.segments.map(\.text) == ["main", "↑4", "2\u{00A0}pliki"])
    #expect(fresh.files == ["a.ts", "b.ts"])
  }

  @Test("zdanie dla czytnika w kolejności segmentów; czyste drzewo mówi „bez zmian”")
  func spoken() {
    let context = ContextGauge.make(context: .known(tokens: 24_000, limit: 200_000, source: .model), usage: nil)
    let full = meta(#""branch":"main","dirtyCount":9,"ahead":1,"behind":2,"fileKinds":{"added":3,"modified":5,"deleted":1}"#)
    #expect(full.spoken(context: context) ==
      "kontekst 12 procent, gałąź main, 2 commity do pobrania, 1 commit do wypchnięcia, "
      + "3 dodane pliki, 5 zmienionych, 1 usunięty")
    #expect(meta(#""branch":"main","dirtyCount":0"#).spoken(context: nil) == "gałąź main, bez zmian")
    #expect(meta(#""branch":"main","dirtyCount":2"#).spoken(context: nil) == "gałąź main, 2 zmienione pliki")
  }

  /// Ta reguła stawia też kreskę pod paskiem zakładek, gdy linii nie ma.
  @Test("linia statusu stoi przy kontekście, gicie z ramki albo podsumowania i pigułce; świeża sesja bez nich — nie")
  func statusLineShown() {
    let fresh = Sample.decode(GitStatusEvent.self, #"{"sessionId":"s1","branch":"main","dirtyCount":0,"files":[]}"#)
    #expect(!StatusLine.isShown(Sample.session(), fresh: nil), "świeża sesja: kreska idzie pod pasek zakładek")
    #expect(StatusLine.isShown(Sample.session(), fresh: fresh), "gałąź z ramki git-status")
    #expect(StatusLine.isShown(Sample.session(extra: #""branch":"main""#), fresh: nil))
    #expect(StatusLine.isShown(Sample.session(extra: #""usage":{"contextTokens":24000,"contextLimit":200000}"#), fresh: nil))
    #expect(StatusLine.isShown(Sample.session(extra: #""cliUpdate":{"running":"2.1.290","installed":"2.1.292"}"#),
                               fresh: nil))
  }
}

@Suite("nagłówek: zadania w tle")
struct BackgroundRowTests {
  @Test("plakietka to sama liczba; wiersz: rodzaj, opis albo komenda, kto i czym; start z serwera")
  func rows() throws {
    let session = Sample.session(extra: #"""
      "backgroundTasks":[
        {"id":"a","kind":"agent","description":"Research herdr API","agentType":"Explore","model":"claude-opus-5-5",
         "startedAt":"\#(Sample.iso(90))"},
        {"id":"b","kind":"command","command":"pnpm test"},
        {"id":"c","kind":"nowy-rodzaj"}]
      """#)
    let tasks = session.backgroundTasks ?? []
    let badge = try #require(BackgroundBadge(session))
    #expect(badge.text == "3 w tle" && badge.working)
    #expect(BackgroundBadge(Sample.session()) == nil && BackgroundBadge(Sample.session(extra: #""backgroundTasks":[]"#)) == nil)
    let rows = tasks.map { BackgroundTaskRow($0) }
    #expect(rows.map(\.kind) == ["subagent", "komenda", "zadanie"])
    #expect(rows.map(\.text) == ["Research herdr API", "pnpm test", ""])
    #expect(rows[0].meta == "Explore · Opus 5.5")
    #expect(rows.map(\.command) == [nil, nil, nil], "komenda bez opisu jest samym tekstem, nie drugą linią")
    #expect(rows.map(\.rawCommand) == [nil, "pnpm test", nil])
    #expect(rows.map(\.detail) == ["Explore · Opus 5.5", "", ""])
    #expect(rows.allSatisfy { $0.working })
    #expect(rows[0].startedAt != nil && rows[1].startedAt == nil, "bez startu licznik nie tyka od „teraz”")
    #expect(BackgroundTaskRow.spoken(tasks) == "3 zadania w tle: subagent Research herdr API, komenda pnpm test, zadanie")
    #expect(badge.spoken == BackgroundTaskRow.spoken(tasks))
  }

  /// Pigułka liczy wszystkie zadania, także subagenta w postoju, ale zieloną kropkę (znak pracy) ma
  /// tylko wtedy, gdy na liście coś pracuje.
  @Test("plakietka przy subagencie w postoju: liczba zostaje, znak pracy tylko obok czegoś, co pracuje")
  func badgeWithWaitingAgent() throws {
    let waiting = #"{"id":"a","kind":"agent","description":"Research herdr API","waitingSince":"\#(Sample.iso(600))"}"#
    let alone = Sample.session(extra: #""backgroundTasks":[\#(waiting)]"#)
    #expect(StatusPills.background(alone, inPanel: false), "pigułka stoi: czekający ma być widoczny")
    let quiet = try #require(BackgroundBadge(alone))
    #expect(quiet.text == "1 w tle" && !quiet.working)
    #expect(quiet.spoken == "1 zadanie w tle: subagent Research herdr API czeka na własne zadanie")
    let mixed = try #require(BackgroundBadge(Sample.session(extra: #"""
      "backgroundTasks":[\#(waiting),{"id":"b","kind":"command","command":"pnpm test"}]
      """#)))
    #expect(mixed.text == "2 w tle" && mixed.working)
    #expect(mixed.spoken == "2 zadania w tle: subagent Research herdr API czeka na własne zadanie, komenda pnpm test")
    let working = try #require(BackgroundBadge(Sample.session(extra: #""backgroundTasks":[{"id":"a","kind":"agent"}]"#)))
    #expect(working.text == "1 w tle" && working.working && working.spoken == "1 zadanie w tle: subagent")
  }

  /// Subagent ma w sekcji „w tle" trzy stany. Pracuje: wiersz jak każde zadanie, licznik od startu.
  /// Czeka na własne zadanie: słowa stanu i licznik od początku postoju. Skończył: wiersza nie ma.
  @Test("wiersz subagenta: pracujący z licznikiem od startu; w postoju stan „czeka na własne zadanie” i licznik od postoju")
  func agentRowStates() throws {
    let session = Sample.session(extra: #"""
      "backgroundTasks":[
        {"id":"w","kind":"agent","description":"Research herdr API","agentType":"Explore","model":"claude-opus-5-5",
         "startedAt":"\#(Sample.iso(7200))"},
        {"id":"s","kind":"agent","description":"Przegląd pokrycia","agentType":"general-purpose",
         "startedAt":"\#(Sample.iso(7200))","waitingSince":"\#(Sample.iso(18 * 60))"},
        {"id":"x","kind":"agent","waitingSince":"wczoraj"},
        {"id":"c","kind":"command","command":"pnpm test","startedAt":"\#(Sample.iso(90))","waitingSince":"\#(Sample.iso(30))"}]
      """#)
    let rows = (session.backgroundTasks ?? []).map { BackgroundTaskRow($0) }
    let working = rows[0]
    #expect(!working.waiting && working.state == nil && working.standbySince == nil)
    #expect(working.clockSince == working.startedAt && working.startedAt != nil)
    #expect(working.spoken(now: Sample.now) == "subagent Research herdr API pracuje, od 2 godzin, Explore · Opus 5.5")
    #expect(working.working && !rows[1].working)
    let standing = rows[1]
    #expect(standing.waiting && standing.state == "czeka na własne zadanie")
    #expect(standing.clockSince == Sample.now.addingTimeInterval(-18 * 60), "licznik od początku postoju, nie od startu")
    #expect(standing.startedAt == Sample.now.addingTimeInterval(-7200), "start zadania zostaje w modelu")
    #expect(standing.spoken(now: Sample.now)
      == "subagent Przegląd pokrycia, czeka na własne zadanie od 18 minut, general-purpose")
    // Czas postoju, który nie jest czasem: stan zostaje, licznika nie ma (od „teraz" by kłamał).
    let unclocked = rows[2]
    #expect(unclocked.waiting && unclocked.state == "czeka na własne zadanie" && unclocked.clockSince == nil)
    #expect(unclocked.spoken(now: Sample.now) == "subagent, czeka na własne zadanie")
    // Pole przy komendzie nic nie znaczy: komenda nie „czeka" i liczy od startu.
    let command = rows[3]
    #expect(!command.waiting && command.state == nil && command.clockSince == command.startedAt)
    #expect(command.spoken(now: Sample.now) == "komenda pnpm test pracuje, od 1 minuty")
  }

  /// Komenda z opisem nie przepada — stoi w linii meta pod opisem i w zdaniu czytnika,
  /// a „Kopiuj komendę" bierze ją surową (heredoc sklejony spacją byłby inną komendą).
  /// Wiersz i czytnik mówią same narzędzia komendy (`CommandTools`), pełna zostaje do kopiowania.
  @Test("komenda z opisem: w linii meta i w zdaniu czytnika same narzędzia; kopiowanie surowe")
  func commandUnderDescription() throws {
    let long = #"bash /Users/x/scripts/batch-run.sh review --uncommitted --dir /Users/x/rarog -- \"Zmiana dodaje…\""#
    let session = Sample.session(extra: #"""
      "backgroundTasks":[
        {"id":"g","kind":"command","description":"Pełna bramka iOS","command":"cd native &&\n  bash check.sh",
         "startedAt":"\#(Sample.iso(90))"},
        {"id":"b","kind":"command","command":"  \n "},
        {"id":"r","kind":"command","description":"Review Codexa","command":"\#(long)"},
        {"id":"u","kind":"command","command":"\#(long)"}]
      """#)
    let rows = (session.backgroundTasks ?? []).map { BackgroundTaskRow($0) }
    #expect(rows[0].text == "Pełna bramka iOS" && rows[0].command == "cd native && bash check.sh")
    #expect(rows[0].rawCommand == "cd native &&\n  bash check.sh")
    #expect(rows[0].tools == "check.sh" && rows[0].detail == "check.sh")
    #expect(rows[0].spoken(now: Sample.now) == "komenda Pełna bramka iOS pracuje, od 1 minuty, komenda: check.sh")
    #expect(rows[1].rawCommand == nil && rows[1].command == nil && rows[1].tools == nil, "pusta komenda to brak komendy")
    #expect(rows[2].detail == "batch-run.sh review" && rows[2].rawCommand?.hasPrefix("bash /Users/x/") == true)
    // Bez opisu pierwszą linią jest komenda — też skrócona, a linia meta zostaje przy samym rodzaju.
    #expect(rows[3].text == "batch-run.sh review" && rows[3].tools == nil && rows[3].detail == "")
  }

  /// Regresja: komenda ucięta przez serwer na samych przypisaniach zmiennych nie ma
  /// narzędzia, a wiersz pokazywał ją wtedy w całości — 200 znaków ścieżek pod opisem.
  @Test("komenda bez rozpoznanego narzędzia: pod opisem sam rodzaj, bez opisu początek komendy; kopiowanie całe")
  func unrecognizedCommandStaysQuiet() throws {
    let cut = #"W=/Users/testowy/Projects/ACME/rarog/.claude/worktrees/testy-ui-okno; O=/tmp/folders/xx/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/T/rarog-merge.vBLgSz; LOG=\"$O/fix-okno-3.log\"; RAROG_IOS_QUICK=1 RAROG_IOS_UI_TES"#
    let session = Sample.session(extra: #"""
      "backgroundTasks":[
        {"id":"d","kind":"command","description":"Ponów przebieg czterech klas testów UI","command":"\#(cut)",
         "startedAt":"\#(Sample.iso(90))"},
        {"id":"n","kind":"command","command":"\#(cut)"},
        {"id":"a","kind":"agent","description":"Przegląd","agentType":"Explore",
         "ownTasks":[{"id":"o1","command":"\#(cut)"},{"id":"o2","command":"helper() { rm x; }"}]}]
      """#)
    let tasks = session.backgroundTasks ?? []
    let rows = tasks.map { BackgroundTaskRow($0) }
    #expect(rows[0].rawCommand?.utf16.count == 200, "komenda ucięta przez serwer")
    #expect(rows[0].text == "Ponów przebieg czterech klas testów UI" && rows[0].tools == nil && rows[0].detail == "")
    #expect(rows[0].spoken(now: Sample.now) == "komenda Ponów przebieg czterech klas testów UI pracuje, od 1 minuty")
    #expect(rows[0].rawCommand?.hasSuffix("RAROG_IOS_UI_TES") == true, "„Kopiuj komendę” dalej bierze całość")
    #expect(rows[1].text == "W=/Users/testowy/Projects/ACME/rarog/.claude/worktrees/testy…" && rows[1].detail == "")
    let own = BackgroundPanel.lines(tasks, choices: [], expansion: WorkflowExpansion()).compactMap { line -> OwnTaskRow? in
      if case let .ownTask(row) = line { return row }
      return nil
    }
    #expect(own.map(\.text) == ["W=/Users/testowy/Projects/ACME/rarog/.claude/worktrees/testy…", "helper() { rm x; }"])
    #expect(own[0].rawCommand?.utf16.count == 200)
  }

  @Test("linia „stan · czas” pod opisem: licznik pracy, słowa postoju z licznikiem, bez startu — nic")
  func statusLine() throws {
    let session = Sample.session(extra: #"""
      "backgroundTasks":[
        {"id":"r","kind":"command","command":"ls","startedAt":"\#(Sample.iso(300))"},
        {"id":"w","kind":"agent","startedAt":"\#(Sample.iso(7200))","waitingSince":"\#(Sample.iso(18 * 60))"},
        {"id":"x","kind":"agent","waitingSince":"wczoraj"},
        {"id":"n","kind":"command","command":"ls"}]
      """#)
    let rows = (session.backgroundTasks ?? []).map { BackgroundTaskRow($0) }
    #expect(rows[0].status(now: Sample.now) == ["5\u{00A0}min"])
    #expect(rows[1].status(now: Sample.now) == ["czeka na własne zadanie", "18\u{00A0}min"])
    #expect(rows[2].status(now: Sample.now) == ["czeka na własne zadanie"], "postój bez czasu: sam stan")
    #expect(rows[3].status(now: Sample.now).isEmpty, "bez startu linii nie ma")
  }

  @Test("„od HH:mm” pod licznikiem dopiero po godzinie; przy postoju — od początku postoju")
  func sinceLabel() throws {
    let utc = TimeZone(identifier: "UTC")!
    let session = Sample.session(extra: #"""
      "backgroundTasks":[
        {"id":"l","kind":"command","command":"sleep","startedAt":"\#(Sample.iso(3600))"},
        {"id":"s","kind":"command","command":"ls","startedAt":"\#(Sample.iso(3599))"},
        {"id":"w","kind":"agent","startedAt":"\#(Sample.iso(7200))","waitingSince":"\#(Sample.iso(600))"},
        {"id":"n","kind":"command","command":"x"}]
      """#)
    let rows = (session.backgroundTasks ?? []).map { BackgroundTaskRow($0) }
    let expected = "od " + ServerTime.clock(Sample.now.addingTimeInterval(-3600), timeZone: utc)
    #expect(rows[0].since(now: Sample.now, timeZone: utc) == expected)
    #expect(rows[1].since(now: Sample.now, timeZone: utc) == nil, "poniżej godziny sam licznik")
    #expect(rows[2].since(now: Sample.now, timeZone: utc) == nil, "postój liczy od siebie (10 min), nie od startu")
    #expect(rows[3].since(now: Sample.now, timeZone: utc) == nil, "bez startu nie ma czego pokazać")
  }

  @Test("nagłówek: liczba zawsze, podział tylko przy postoju; zera nie tworzą członu")
  func header() {
    func header(_ json: String) -> BackgroundHeader {
      BackgroundHeader(Sample.session(extra: #""backgroundTasks":[\#(json)]"#).backgroundTasks ?? [])
    }
    let wait = #"{"id":"a","kind":"agent","waitingSince":"\#(Sample.iso(60))"}"#
    let run = #"{"id":"b","kind":"command","command":"ls"}"#
    #expect(header(run).count == 1 && header(run).split == nil)
    #expect(header("\(run),\(wait)").split == "1\u{00A0}pracuje · 1\u{00A0}czeka")
    #expect(header("\(wait),\(wait.replacingOccurrences(of: "\"a\"", with: "\"c\""))").split == "2\u{00A0}czekają")
    #expect(UICopy.backgroundSplit(working: 2, waiting: 5) == "2\u{00A0}pracują · 5\u{00A0}czeka")
  }

  @Test("własne komendy subagenta: linie pod jego wierszem; „czeka na:” tylko przy agencie w postoju")
  func ownTaskLines() throws {
    let own = #"""
      [{"id":"c1","command":"pnpm test -- --coverage","startedAt":"\#(Sample.iso(21 * 60))"},
       {"id":"c2","startedAt":"\#(Sample.iso(180))"},
       {"id":"c3","command":"sleep 600"}]
      """#
    let session = Sample.session(extra: #"""
      "backgroundTasks":[
        {"id":"s","kind":"agent","description":"Stoi","waitingSince":"\#(Sample.iso(600))","ownTasks":\#(own)},
        {"id":"w","kind":"agent","description":"Pracuje","ownTasks":[{"id":"c1","command":"pnpm dev"}]},
        {"id":"n","kind":"agent","waitingSince":"\#(Sample.iso(60))"},
        {"id":"e","kind":"agent","waitingSince":"\#(Sample.iso(60))","ownTasks":[]},
        {"id":"c","kind":"command","command":"ls"}]
      """#)
    let lines = BackgroundPanel.lines(session.backgroundTasks ?? [], expansion: WorkflowExpansion())
    #expect(lines.map(\.id) == [
      "task:s", "own:s:label", "own:s:task:c1", "own:s:task:c2", "own:s:task:c3",
      "task:w", "own:w:task:c1",
      "task:n", "task:e", "task:c",
    ], "bez komend nie ma linii ani słów „czeka na:”; ta sama komenda u dwóch agentów ma osobne tożsamości")
    let rows = lines.compactMap { line -> OwnTaskRow? in if case let .ownTask(row) = line { row } else { nil } }
    // Wiersz mówi same narzędzia komendy; pełną ma `rawCommand` („Kopiuj komendę").
    #expect(rows.map(\.text) == ["pnpm test", "komenda", "sleep", "pnpm dev"])
    #expect(rows.map(\.rawCommand) == ["pnpm test -- --coverage", nil, "sleep 600", "pnpm dev"])
    #expect(rows.map(\.awaited) == [true, true, true, false])
    #expect(rows[0].startedAt == Sample.now.addingTimeInterval(-21 * 60) && rows[2].startedAt == nil)
    #expect(rows.map { $0.spoken(now: Sample.now) } == [
      "czeka na: pnpm test, od 21 minut",
      "czeka na: komenda, od 3 minut",
      "czeka na: sleep",
      "komenda subagenta: pnpm dev",
    ])
  }

  @Test("własna komenda: wiele linii w jednej, pusta jak nieobecna; pracujący agent bez treści mówi „komenda subagenta”")
  func ownTaskText() {
    func row(_ fields: String, awaited: Bool) -> OwnTaskRow {
      OwnTaskRow(Sample.decode(AgentOwnTask.self, #"{"id":"c"\#(fields)}"#), task: "a", awaited: awaited)
    }
    let multiline = row(#","command":"cd server &&\n  pnpm test  --watch\n\n""#, awaited: true)
    #expect(multiline.command == "cd server && pnpm test  --watch", "linie sklejone spacją, odstępy w linii zostają")
    #expect(multiline.rawCommand == "cd server &&\n  pnpm test  --watch\n\n", "kopiowanie bierze komendę surową")
    #expect(multiline.tools == "pnpm test" && multiline.text == "pnpm test", "wiersz mówi same narzędzia")
    #expect(row(#","command":"  \n ""#, awaited: true).rawCommand == nil)
    #expect(row(#","command":"  \n ""#, awaited: true).command == nil)
    #expect(row(#","command":"  \n ""#, awaited: true).text == "komenda")
    let bare = row(#","startedAt":"\#(Sample.iso(45))""#, awaited: false)
    #expect(bare.text == "komenda" && bare.spoken(now: Sample.now) == "komenda subagenta, od 45 sekund")
    #expect(row("", awaited: false).spoken(now: Sample.now) == "komenda subagenta")
    #expect(row("", awaited: true).id == "own:a:task:c")
  }

  /// Sekcja workflow stoi POD wierszem zadania jako rodzeństwo (wiersz zadania łączy dzieci dla
  /// czytnika), każda linia ma stałą tożsamość, a dwa przebiegi mają osobne sekcje.
  @Test("panel: wiersz zadania, pod nim jego sekcja workflow; zadanie bez rozkładu bez sekcji")
  func panelLines() {
    let run = #"{"phases":["A","B"],"agents":[{"id":"1","phase":"A","done":true},{"id":"2","phase":"B","done":false}]}"#
    let session = Sample.session(extra: #"""
      "backgroundTasks":[
        {"id":"w1","kind":"workflow","description":"przegląd","run":\#(run)},
        {"id":"c","kind":"command","command":"pnpm test"},
        {"id":"w2","kind":"workflow","run":\#(run)}]
      """#)
    let tasks = session.backgroundTasks ?? []
    let lines = BackgroundPanel.lines(tasks, expansion: WorkflowExpansion())
    #expect(lines.map(\.id) == [
      "task:w1", "wf:w1:summary", "wf:w1:phase:A", "wf:w1:phase:B", "wf:w1:agent:2",
      "task:c",
      "task:w2", "wf:w2:summary", "wf:w2:phase:A", "wf:w2:phase:B", "wf:w2:agent:2",
    ])
    #expect(BackgroundPanel.currentKeys(tasks) == [
      WorkflowExpansion.Key(task: "w1", phase: "B"), WorkflowExpansion.Key(task: "w2", phase: "B"),
    ])
  }
}

@Suite("nagłówek: pigułki modelu i trybu, arkusz")
struct SessionPillsTests {
  private let choices = [
    ModelChoice(value: "", label: "Model domyślny konta", effortLevels: []),
    ModelChoice(value: "fable", label: "Fable", effortLevels: [.low, .medium, .high, .xhigh, .max]),
    ModelChoice(value: "opus[1m]", label: "Opus", effortLevels: [.low, .medium, .high, .xhigh, .max]),
    ModelChoice(value: "haiku", label: "Haiku", effortLevels: []),
  ]

  @Test("nazwa modelu: etykieta z listy, wersja z kropką, wariant okna; nieznany kształt bez zmian")
  func label() {
    #expect(ModelLabel.format("claude-opus-5-5", choices: []) == "Opus 5.5")
    #expect(ModelLabel.format("claude-fable-5-1", choices: []) == "Fable 5.1")
    #expect(ModelLabel.format("claude-opus-5[1m]", choices: []) == "Opus 5 (1M)")
    #expect(ModelLabel.format("claude-haiku-4-5-20251001", choices: []) == "Haiku 4.5")
    #expect(ModelLabel.format("opus[1m]", choices: choices) == "Opus")
    #expect(ModelLabel.format("gpt-5", choices: choices) == "gpt-5")
  }

  @Test("alias rodziny: wariant okna jest częścią dopasowania")
  func alias() {
    #expect(ModelLabel.alias("claude-opus-5-5[1m]", choices: choices) == "opus[1m]")
    #expect(ModelLabel.alias("claude-fable-5-1", choices: choices) == "fable")
    #expect(ModelLabel.alias("claude-opus-5", choices: choices) == "claude-opus-5", "200k nie zwija się do 1M")
    #expect(ModelLabel.alias("opus[1m]", choices: choices) == "opus[1m]")
  }

  @Test("pigułka: model · effort, sam model bez effortu, wygaszone „model?”; effort spoza apki przemilczany")
  func pill() {
    let full = ModelPillModel.make(Sample.session(extra: #""model":"claude-opus-5-5","effort":"xhigh""#), choices: [])
    #expect(full.text == "Opus 5.5 · xhigh" && full.spoken == "Model i effort: Opus 5.5, xhigh" && !full.unknown)
    #expect(ModelPillModel.make(Sample.session(extra: #""model":"claude-opus-5-5""#), choices: []).text == "Opus 5.5")
    #expect(ModelPillModel.make(Sample.session(extra: #""model":"claude-opus-5-5","effort":"turbo""#), choices: []).text
      == "Opus 5.5")
    let unknown = ModelPillModel.make(Sample.session(), choices: [])
    #expect(unknown.text == "model?" && unknown.unknown)
  }

  @Test("UI test switch of the Debug build: `RAROG_UI_TEST_HIDE_MODEL=1` hides the pill, without it the pill stands")
  func pillHiddenForUITests() {
    #if DEBUG
    #expect(ModelPillModel.hiddenForUITests(environment: [ModelPillModel.hideForUITestsKey: "1"]))
    #else
    #expect(!ModelPillModel.hiddenForUITests(environment: [ModelPillModel.hideForUITestsKey: "1"]))
    #endif
    #expect(!ModelPillModel.hiddenForUITests(environment: [:]))
    #expect(!ModelPillModel.hiddenForUITests(environment: [ModelPillModel.hideForUITestsKey: "0"]))
    #expect(!ModelPillModel.hiddenForUITests(environment: ["RAROG_UI_TEST_VOICE_AGENT": "hearing"]))
  }

  @Test("arkusz: bez pozycji domyślnej konta; model spoza listy na początku; wybór po aliasie")
  func options() {
    #expect(ModelSheetModel.options(current: "opus[1m]", choices: choices).map(\.value) == ["fable", "opus[1m]", "haiku"])
    let foreign = ModelSheetModel.options(current: "claude-sonnet-4-6", choices: choices)
    #expect(foreign.map(\.value) == ["claude-sonnet-4-6", "fable", "opus[1m]", "haiku"])
    #expect(foreign[0].label == "Sonnet 4.6" && foreign[0].effortLevels.count == 5)
    let current = ModelSelection.current(Sample.session(extra: #""model":"claude-opus-5-5[1m]","effort":"high""#), choices: choices)
    #expect(current == ModelSelection(model: "opus[1m]", effort: .high))
  }

  @Test("arkusz: różnica wobec sesji; bez zmian nic; model bez effortów zdejmuje wybór poziomu")
  func patch() {
    let current = ModelSelection(model: "opus[1m]", effort: .high)
    let options = ModelSheetModel.options(current: "opus[1m]", choices: choices)
    #expect(ModelSheetModel.patch(current: current, draft: ModelDraft(), options: options) == nil)
    #expect(ModelDraft().selection(current: current, options: options) == current, "bez wyboru rysujemy sesję")

    var same = ModelDraft()
    same.pick(model: "opus[1m]", options: options)
    same.pick(effort: .high)
    #expect(ModelSheetModel.patch(current: current, draft: same, options: options) == nil, "wybór równy sesji nic nie wysyła")

    var effort = ModelDraft()
    effort.pick(effort: .max)
    #expect(ModelSheetModel.patch(current: current, draft: effort, options: options) == ModelSelection(model: nil, effort: .max))

    var model = ModelDraft()
    model.pick(model: "fable", options: options)
    #expect(model.selection(current: current, options: options) == ModelSelection(model: "fable", effort: .high))
    #expect(ModelSheetModel.patch(current: current, draft: model, options: options)
      == ModelSelection(model: "fable", effort: nil), "niezmieniony effort nie leci")

    var haiku = ModelDraft()
    haiku.pick(effort: .max)
    haiku.pick(model: "haiku", options: options)
    #expect(haiku.selection(current: current, options: options) == ModelSelection(model: "haiku", effort: nil))
    #expect(haiku.effort == nil, "poziom, którego model nie zna, przestaje być wybrany")
    #expect(ModelSheetModel.efforts(for: "haiku", options: options).isEmpty)
    #expect(ModelSheetModel.patch(current: current, draft: haiku, options: options) == ModelSelection(model: "haiku", effort: nil))
    let unknown = ModelSelection(model: nil, effort: nil)
    #expect(ModelSheetModel.patch(current: unknown, draft: ModelDraft(), options: choices) == nil,
            "nieznany stan bez wyboru niczego nie wysyła")
  }

  /// Lista z ultracode jak u serwera, który je ogłasza: przy Fable i Opusie, bez Haiku i modelu konta.
  private let ultracodeChoices = [
    ModelChoice(value: "", label: "Model domyślny konta", effortLevels: []),
    ModelChoice(value: "fable", label: "Fable", effortLevels: [.low, .medium, .high, .xhigh, .max], ultracode: true),
    ModelChoice(value: "opus[1m]", label: "Opus", effortLevels: [.low, .medium, .high, .xhigh, .max], ultracode: true),
    ModelChoice(value: "haiku", label: "Haiku", effortLevels: []),
  ]

  @Test("pigułka: „· ultracode” tylko przy dowodzie true; false i brak pola bez dopisku")
  func pillUltracode() {
    let on = ModelPillModel.make(
      Sample.session(extra: #""model":"claude-opus-5-5","effort":"xhigh","ultracode":true"#), choices: [])
    #expect(on.text == "Opus 5.5 · xhigh · ultracode")
    #expect(on.spoken == "Model i effort: Opus 5.5, xhigh, ultracode")
    let bare = ModelPillModel.make(Sample.session(extra: #""model":"claude-opus-5-5","ultracode":true"#), choices: [])
    #expect(bare.text == "Opus 5.5 · ultracode" && bare.spoken == "Model: Opus 5.5, ultracode", "bez effortu")
    let off = ModelPillModel.make(
      Sample.session(extra: #""model":"claude-opus-5-5","effort":"xhigh","ultracode":false"#), choices: [])
    #expect(off.text == "Opus 5.5 · xhigh" && off.spoken == "Model i effort: Opus 5.5, xhigh", "false bez „off”")
    #expect(ModelPillModel.make(Sample.session(extra: #""ultracode":true"#), choices: []).unknown, "bez modelu: „model?”")
    let current = ModelSelection.current(
      Sample.session(extra: #""model":"claude-opus-5-5[1m]","effort":"xhigh","ultracode":false"#), choices: choices)
    #expect(current == ModelSelection(model: "opus[1m]", effort: .xhigh, ultracode: false))
    #expect(ModelSelection.current(Sample.session(extra: #""model":"opus[1m]""#), choices: choices).ultracode == nil)
  }

  @Test("arkusz: grupa ultracode tylko przy modelu z polem; model spoza listy dostaje ją tylko od serwera, który ją ma")
  func ultracodeAvailability() {
    let options = ModelSheetModel.options(current: "opus[1m]", choices: ultracodeChoices)
    #expect(ModelSheetModel.ultracodeAvailable(for: "opus[1m]", options: options))
    #expect(!ModelSheetModel.ultracodeAvailable(for: "haiku", options: options), "Haiku bez przełącznika")
    #expect(!ModelSheetModel.ultracodeAvailable(for: nil, options: options), "nieznany model")
    let foreign = ModelSheetModel.options(current: "claude-opus-5-5", choices: ultracodeChoices)
    #expect(foreign[0].value == "claude-opus-5-5" && foreign[0].ultracode, "nowy serwer: model sesji spoza listy")
    let old = ModelSheetModel.options(current: "claude-opus-5-5", choices: choices)
    #expect(!old[0].ultracode, "stary serwer pola nie zna — przełącznika nie ma, także dla modelu spoza listy")
    var draft = ModelDraft()
    draft.pick(ultracode: true)
    #expect(ModelSheetModel.patch(current: ModelSelection(model: "claude-opus-5-5", effort: .xhigh), draft: draft, options: old)
      == nil, "pole, które stary serwer zdjąłby z żądania, nie wychodzi")
  }

  @Test("arkusz: różnica ultracode — nil to „nie wiem”, false jedzie jawnie, wybór znika z modelem bez pola")
  func ultracodePatch() {
    let options = ModelSheetModel.options(current: "opus[1m]", choices: ultracodeChoices)
    let unknown = ModelSelection(model: "opus[1m]", effort: .xhigh)
    #expect(ModelDraft().selection(current: unknown, options: options).ultracode == nil, "bez dowodu nic nie zaznaczone")

    var on = ModelDraft()
    on.pick(ultracode: true)
    #expect(ModelSheetModel.patch(current: unknown, draft: on, options: options)
      == ModelSelection(model: nil, effort: nil, ultracode: true))
    #expect(ModelSheetModel.applyHint(ModelSheetModel.patch(current: unknown, draft: on, options: options))
      == UICopy.ultracodeHint, "sam ultracode: zdanie o koszcie")
    // The sentence names the “No” segment of the same sheet by its exact title.
    #expect(UICopy.ultracodeHint.contains("„\(UICopy.modelSheetTitle)”"))
    #expect(UICopy.ultracodeHint.contains("„\(UICopy.ultracodeNo)”"))
    #expect(!UICopy.ultracodeHint.contains("przełącznik"))
    let enabled = ModelSelection(model: "opus[1m]", effort: .xhigh, ultracode: true)
    #expect(ModelSheetModel.patch(current: enabled, draft: on, options: options) == nil, "wybór równy sesji nic nie wysyła")

    var off = ModelDraft()
    off.pick(ultracode: false)
    #expect(ModelSheetModel.patch(current: enabled, draft: off, options: options)
      == ModelSelection(model: nil, effort: nil, ultracode: false))
    #expect(ModelSheetModel.patch(current: unknown, draft: off, options: options)?.ultracode == false,
            "„wyłączone” przy nieznanym stanie to jawne false")

    var withModel = on
    withModel.pick(model: "fable", options: options)
    let mixed = ModelSheetModel.patch(current: unknown, draft: withModel, options: options)
    #expect(mixed == ModelSelection(model: "fable", effort: nil, ultracode: true), "Fable też ma ultracode")
    #expect(ModelSheetModel.applyHint(mixed) == UICopy.modelChangeWarning, "paczka z modelem: skutek globalny")
    #expect(ModelSheetModel.applyHint(nil) == UICopy.modelChangeWarning)

    var haiku = on
    haiku.pick(model: "haiku", options: options)
    #expect(haiku.ultracode == nil, "model bez pola zdejmuje wybór ultracode")
    #expect(ModelSheetModel.patch(current: unknown, draft: haiku, options: options)
      == ModelSelection(model: "haiku", effort: nil))

    // Odświeżona lista bez pola (serwer cofnięty do wersji bez ultracode): wybór nie wychodzi.
    let refreshed = ModelSheetModel.options(current: "opus[1m]", choices: choices)
    #expect(on.selection(current: unknown, options: refreshed).ultracode == nil)
    #expect(ModelSheetModel.patch(current: unknown, draft: on, options: refreshed) == nil)
  }

  /// The sheet's chips and segments draw `ModelDraft.selection`: without proof on the card nothing is selected (a
  /// selected No would claim "off" without proof), and an untouched field stays out of the difference.
  @Test("sheet: no proof selects nothing — ultracode without a value, effort missing or off the model's list")
  func chipSelection() {
    let options = ModelSheetModel.options(current: "opus[1m]", choices: ultracodeChoices)
    let unknown = ModelSelection(model: "opus[1m]", effort: .xhigh)
    #expect(ModelDraft().selection(current: unknown, options: options).ultracode == nil, "no segment selected")
    #expect(ModelSheetModel.patch(current: unknown, draft: ModelDraft(), options: options) == nil, "nothing to send")

    var off = ModelDraft()
    off.pick(ultracode: false)
    #expect(ModelSheetModel.patch(current: unknown, draft: off, options: options)
      == ModelSelection(model: nil, effort: nil, ultracode: false), "No from unknown: an explicit false")

    // Effort missing on the card or off the model's list: no chip selected, no effort in the difference.
    let narrow = [ModelChoice(value: "sonnet", label: "Sonnet", effortLevels: [.low, .medium, .high], ultracode: true)]
    for session in [ModelSelection(model: "sonnet", effort: nil), ModelSelection(model: "sonnet", effort: .max)] {
      #expect(ModelDraft().selection(current: session, options: narrow).effort == nil,
              "nothing selected: \(String(describing: session.effort))")
      #expect(ModelSheetModel.patch(current: session, draft: ModelDraft(), options: narrow) == nil)
      var onlyUltracode = ModelDraft()
      onlyUltracode.pick(ultracode: true)
      #expect(ModelSheetModel.patch(current: session, draft: onlyUltracode, options: narrow)?.effort == nil)
    }
    // A level this app version does not know (`.unsupported`, e.g. "turbo") folds to `nil`: no chip, no difference.
    let turbo = Sample.session(extra: #""model":"sonnet","effort":"turbo""#)
    #expect(turbo.effort == .unsupported)
    let turboCurrent = ModelSelection.current(turbo, choices: narrow)
    #expect(ModelDraft().selection(current: turboCurrent, options: narrow).effort == nil)
    #expect(ModelSheetModel.patch(current: turboCurrent, draft: ModelDraft(), options: narrow) == nil)

    // Apply sends only changed fields: a choice equal to the session (model, effort) stays out, a changed ultracode goes.
    var mixed = ModelDraft()
    mixed.pick(model: "opus[1m]", options: options)
    mixed.pick(effort: .xhigh)
    mixed.pick(ultracode: false)
    #expect(ModelSheetModel.patch(current: unknown, draft: mixed, options: options)
      == ModelSelection(model: nil, effort: nil, ultracode: false))
    mixed.pick(effort: .low)
    #expect(ModelSheetModel.patch(current: unknown, draft: mixed, options: options)
      == ModelSelection(model: nil, effort: .low, ultracode: false))
  }

  /// Wybór samego effortu, a w tym czasie strumień przynosi model
  /// przestawiony na innym urządzeniu. „Zatwierdź" wysyłało stary model sprzed zmiany (cofało ją
  /// i nadpisywało domyślny model konta).
  @Test("arkusz: pole nieruszone nadąża za sesją — sam effort nie odsyła starego modelu")
  func untouchedFieldFollowsSession() {
    let options = ModelSheetModel.options(current: "opus[1m]", choices: choices)
    var draft = ModelDraft()
    draft.pick(effort: .low)
    #expect(draft.selection(current: ModelSelection(model: "opus[1m]", effort: .high), options: options)
      == ModelSelection(model: "opus[1m]", effort: .low))

    let moved = ModelSelection(model: "fable", effort: .high)
    #expect(draft.selection(current: moved, options: options) == ModelSelection(model: "fable", effort: .low))
    #expect(ModelSheetModel.patch(current: moved, draft: draft, options: options) == ModelSelection(model: nil, effort: .low))

    // Odwrotnie: wybrany model zostaje, nieruszony poziom idzie za sesją i nie leci.
    var model = ModelDraft()
    model.pick(model: "fable", options: options)
    #expect(ModelSheetModel.patch(current: ModelSelection(model: "opus[1m]", effort: .max), draft: model, options: options)
      == ModelSelection(model: "fable", effort: nil))
  }

  /// „Zatwierdź" w drodze, arkusz zamknięty i otwarty od nowa —
  /// spóźniony sukces zamykał nową prezentację (wspólne `open = false`) i kasował świeży wybór.
  @Test("arkusz: spóźniona odpowiedź starej prezentacji nie zamyka arkusza otwartego od nowa")
  func presentation() {
    var sheet = SheetPresentation()
    #expect(sheet.current == nil)
    let first = sheet.open()
    #expect(sheet.isCurrent(first))
    sheet.dismiss()
    let second = sheet.open()
    #expect(first != second, "ponowne otwarcie to nowa prezentacja")
    #expect(!sheet.isCurrent(first), "odpowiedź starej prezentacji nie ma adresata")
    sheet.close(first)
    #expect(sheet.current == second, "zamknięcie z wyniku starej prezentacji nie dotyka nowej")
    sheet.close(second)
    #expect(sheet.current == nil)
  }

  /// Model i tryb stoją w rzędzie pod polem wiadomości, więc linia statusu bez
  /// gita i kontekstu stoi tylko dla „w tle" i nowszego CLI, inaczej byłaby pustym pasem z kreską.
  @Test("linia statusu: pigułki tylko „w tle” i nowszy CLI; Codex bez restartu")
  func statusPills() {
    let update = #""cliUpdate":{"running":"2.1.280","installed":"2.1.283"}"#
    #expect(!StatusPills.visible(Sample.session(extra: #""model":"claude-opus-5-5","herdrMode":"auto""#)),
            "model i tryb nie trzymają linii")
    #expect(StatusPills.visible(Sample.session(extra: update)))
    #expect(!StatusPills.visible(Sample.session(extra: update + #","engine":"codex""#)))
    #expect(!StatusPills.visible(Sample.session(extra: update + #","termId":"0123456789abcdef""#)),
            "Claude w terminalu Raroga: restartu z Raroga nie ma")
    // Rozwinięcie gita: sesja z własnym ekranem tak; Codex, brak repozytorium i agent w terminalu Raroga nie.
    #expect(StatusLine.gitExpands(Sample.session(), isRepo: true))
    #expect(!StatusLine.gitExpands(Sample.session(), isRepo: false))
    #expect(!StatusLine.gitExpands(Sample.session(extra: #""engine":"codex""#), isRepo: true))
    #expect(!StatusLine.gitExpands(Sample.session(extra: #""termId":"0123456789abcdef""#), isRepo: true),
            "nad terminalem nie ma strumienia sesji, więc diff nie znałby zmian repozytorium")
    #expect(StatusPills.visible(Sample.session(extra: #""engine":"codex","backgroundTasks":[{"id":"a","kind":"command","command":"x"}]"#)))
  }

  /// The spinner replaces the pill for the whole restart, also while the card carries no `cliUpdate` (the old process
  /// gone): without it the status line would collapse and the pill would flash back mid-restart.
  @Test("newer-CLI slot: a spinner for the whole restart, also without cliUpdate; Codex and the terminal agent without")
  func cliSlot() {
    let update = #""cliUpdate":{"running":"2.1.280","installed":"2.1.283"}"#
    #expect(StatusPills.cli(Sample.session(extra: update), restarting: true) == .restarting)
    #expect(StatusPills.cli(Sample.session(), restarting: true) == .restarting, "the card without its process")
    #expect(StatusPills.visible(Sample.session(), restarting: true), "the spinner holds the status line")
    #expect(StatusLine.isShown(Sample.session(), fresh: nil, restarting: true))
    if case .offer = StatusPills.cli(Sample.session(extra: update), restarting: false) {} else {
      Issue.record("the offer comes back once the restart is over")
    }
    #expect(StatusPills.cli(Sample.session(), restarting: false) == nil)
    #expect(StatusPills.cli(Sample.session(extra: #""engine":"codex""#), restarting: true) == nil)
    #expect(StatusPills.cli(Sample.session(extra: #""termId":"0123456789abcdef""#), restarting: true) == nil)
  }

  @Test("pigułka trybu: ton, cel i zdanie; w locie „przełączam…”; brak pola = brak pigułki")
  func mode() throws {
    let auto = try #require(ModePillModel.make(Sample.session(extra: #""herdrMode":"auto""#), busy: false))
    #expect(auto.text == "auto" && auto.tone == .wait && auto.target == .plan)
    #expect(auto.spoken == "tryb auto — panel nie pyta o zgody — stuknij, żeby przełączyć na plan")
    let plan = try #require(ModePillModel.make(Sample.session(extra: #""herdrMode":"plan""#), busy: true))
    #expect(plan.tone == .plan && plan.target == .auto && plan.spoken.hasSuffix("przełączam…"))
    let bypass = try #require(ModePillModel.make(Sample.session(extra: #""herdrMode":"bypass""#), busy: false))
    #expect(bypass.tone == .err && bypass.target == nil && bypass.spoken == "tryb bypass — panel nie pyta o nic")
    #expect(ModePillModel.make(Sample.session(extra: #""herdrMode":"unknown""#), busy: false)?.text == "tryb?")
    #expect(ModePillModel.make(Sample.session(), busy: false) == nil)
  }

  @Test("sesja przed świeżym stanem: pigułki wyciszone, ale tap i czytnik mówią dlaczego")
  func staleControlsSayWhy() throws {
    let session = Sample.session(state: "waiting-input", extra: #""herdrMode":"auto""#)
    var state = Sample.state(session: session)
    #expect(state.modelChangeReason(for: session.id) == nil)
    #expect(try #require(ModePillModel.make(session, busy: false, stale: false)).blockedReason == nil)
    // Sesja z pamięci podręcznej czeka na pierwszy transkrypt: rdzeń odmówi w bramce, więc pigułka mówi to od razu.
    state.listCache.awaitingTranscripts = [session.id]
    #expect(state.sessionStale(session.id))
    #expect(state.modelChangeReason(for: session.id) == UICopy.staleAction)
    let mode = try #require(ModePillModel.make(session, busy: false, stale: true))
    #expect(mode.blockedReason == UICopy.staleAction && mode.tone == .muted)
    #expect(mode.spoken == "tryb auto — panel nie pyta o zgody", "bez obietnicy „stuknij, żeby przełączyć”")
  }

  @Test("model pill in flight: the target set over the session values, a spoken “switching”; without a target as before")
  func pillInFlight() throws {
    let session = Sample.session(extra: #""model":"fable","effort":"low","ultracode":true"#)
    let target = try #require(SessionModelBody(model: "opus[1m]", effort: .high, ultracode: false))
    let pill = ModelPillModel.make(session, choices: choices, target: target)
    #expect(pill.text == "Opus · high" && pill.switching && !pill.unknown, "ultracode false drops the suffix")
    #expect(pill.spoken == UICopy.modelSwitchingSpoken(UICopy.modelEffortSpoken("Opus", effort: "high")))
    let effortOnly = ModelPillModel.make(session, choices: choices, target: try #require(SessionModelBody(model: nil, effort: .max)))
    #expect(effortOnly.text == "Fable · max · ultracode", "fields outside the target come from the session")
    let idle = ModelPillModel.make(session, choices: choices)
    #expect(idle.text == "Fable · low · ultracode" && !idle.switching)
    #expect(idle.spoken == UICopy.modelEffortUltracodeSpoken("Fable", effort: "low"))
  }

  @Test("model change in flight: the pill and the app command say why, and the field keeps its text; the deadline ends it")
  func modelChangeInFlightReason() throws {
    let session = Sample.session(state: "waiting-input", extra: #""model":"fable""#)
    var state = Sample.state(session: session)
    #expect(AppCommand.modelSheetRoute(state, sessionId: session.id) == .open(clearsField: true))
    let now = Date()
    let until = now.addingTimeInterval(SessionControlTiming.modelChangeWait)
    let target = try #require(SessionModelBody(model: "opus[1m]", effort: nil))
    state.apply(.session(.modelChangeStarted(sessionId: session.id, target: target, until: until)), now: now)
    #expect(state.modelChangeReason(for: session.id) == UICopy.modelChanging)
    #expect(AppCommand.modelSheetRoute(state, sessionId: session.id) == .open(clearsField: false))
    #expect(state.modelChangeReason(for: session.id, now: until) == nil, "past the deadline the sheet offers Apply")
  }

  /// The in-flight entry starts before the POST, so the sheet that sent Apply flipped to the in-flight sentence
  /// during its own request instead of keeping its form with the sending spinner.
  @Test("model sheet: its own request keeps the form; a sheet opened during another change says why; blocks still win")
  func modelSheetOwnRequest() throws {
    let session = Sample.session(state: "waiting-input", extra: #""model":"fable""#)
    var state = Sample.state(session: session)
    let now = Date()
    let until = now.addingTimeInterval(SessionControlTiming.modelChangeWait)
    let target = try #require(SessionModelBody(model: "opus[1m]", effort: nil))
    state.apply(.session(.modelChangeStarted(sessionId: session.id, target: target, until: until)), now: now)
    #expect(state.modelSheetReason(for: session.id, ownRequest: true, now: now) == nil, "own Apply: the form stays")
    #expect(state.modelSheetReason(for: session.id, ownRequest: false, now: now) == UICopy.modelChanging)
    state.listCache.awaitingTranscripts = [session.id]
    #expect(state.modelSheetReason(for: session.id, ownRequest: true, now: now) == UICopy.staleAction)
    state.listCache.awaitingTranscripts = []
    var busy = Sample.state(session: Sample.session(state: "running", extra: #""model":"fable""#))
    busy.apply(.session(.modelChangeStarted(sessionId: session.id, target: target, until: until)), now: now)
    #expect(busy.modelSheetReason(for: session.id, ownRequest: true, now: now) == UICopy.modelBusy)
  }

  /// Strażnik źródeł: twarde `.disabled` przy nieświeżym stanie zabierało powód — VoiceOver
  /// słyszał „wygaszony", a tap nic nie mówił. Widoki są tylko iOS, więc pilnujemy ich tekstu.
  @Test("pigułki, „+” i „Ponów” nie gasną przy nieświeżym stanie: zostają klikalne i mówią dlaczego")
  func staleControlsStayClickable() throws {
    func code(_ file: String) throws -> String {
      ApprovalGateTests.withoutComments(try String(contentsOf: ApprovalGateTests.sourceFile(file), encoding: .utf8))
    }
    let pills = try code("Session/ComposerPills.swift")
    #expect(!pills.contains(".disabled("), "pigułka wyłączona nie powie, dlaczego")
    #expect(pills.contains("navigation.post(reason)") && pills.contains(".accessibilityHint(pill.blockedReason"))
    #expect(pills.contains(".accessibilityHint(reason"))
    let retry = try code("Session/Rows/PendingStatusView.swift")
    #expect(retry.contains(".disabled(retrying)") && !retry.contains("canRetry"))
    #expect(retry.contains(".accessibilityHint(blocked"))
    let tabs = try code("Views/Projects/ProjectTabBar.swift")
    #expect(tabs.contains(".disabled(addBusy)") && !tabs.contains("addFrozen"))
  }

  @Test("zdanie po akcji: zdanie serwera, zapas przy jego braku, sukces i blokada bez zdania")
  func messages() {
    #expect(UICopy.controlMessage(.refused("Agent pracuje."), fallback: "x") == "Agent pracuje.")
    #expect(UICopy.controlMessage(.refused(nil), fallback: "x") == "x")
    #expect(UICopy.controlMessage(.accepted, fallback: "x") == nil)
    #expect(UICopy.controlMessage(.notAllowed, fallback: "x") == nil)
    #expect(UICopy.controlMessage(.offline, fallback: "x") == UICopy.serverSilent)
  }
}

@Suite("nagłówek: rozwinięcie gita i diff")
struct GitChangesTests {
  /// Dymek gita niczego nie pobiera: litery i liczby bierze z ramki.
  @Test("dymek gita: wiersze z `fileDetails` ramki (litera, bilans, binarny), bez pola same ścieżki; „pokazano 50 z N”")
  func rows() {
    let detailed = Sample.decode(GitStatusEvent.self, #"""
      {"sessionId":"s1","branch":"main","dirtyCount":4,"files":["a.ts","b.md","logo.png","nowy.txt"],
       "fileDetails":[{"path":"a.ts","kind":"added","linesAdded":12,"linesDeleted":3},
                      {"path":"b.md","kind":"deleted","linesAdded":0,"linesDeleted":7},
                      {"path":"logo.png","kind":"modified","binary":true},
                      {"path":"nowy.txt","kind":"added"}]}
      """#)
    let full = GitChangesModel.rows(fresh: detailed)
    #expect(full.map(\.path) == ["a.ts", "b.md", "logo.png", "nowy.txt"])
    #expect(full.map(\.status) == [.added, .deleted, .modified, .added])
    #expect(full[0].added == 12 && full[0].deleted == 3)
    #expect(full[0].spoken == "a.ts, nowy, 12 dodanych linii, 3 usunięte linie")
    #expect(full[2].binary && full[2].added == nil, "binarny bez liczników")
    #expect(full[3].added == nil && full[3].deleted == nil, "nieśledzony: liczników nie zgadujemy")
    #expect(GitChangesModel.shownNote(fresh: detailed, rows: full.count) == nil, "lista jest cała")

    let bare = Sample.decode(GitStatusEvent.self, #"{"sessionId":"s1","branch":"main","dirtyCount":73,"files":["a.ts","b.md"]}"#)
    let paths = GitChangesModel.rows(fresh: bare)
    #expect(paths.map(\.path) == ["a.ts", "b.md"])
    #expect(paths.allSatisfy { $0.status == nil && $0.added == nil && !$0.binary }, "ramka bez szczegółów: same ścieżki")
    #expect(GitChangesModel.shownNote(fresh: bare, rows: paths.count) == "pokazano 2 z 73")
    #expect(GitChangesModel.rows(fresh: nil).isEmpty, "ramka jeszcze nie przyszła")
    #expect(GitChangesModel.shownNote(fresh: nil, rows: 0) == nil)

    let stale = GitMeta(session: Sample.session(extra: #""branch":"main","dirtyCount":1"#), fresh: nil)
    #expect(GitChangesModel.emptyNote(meta: stale) == "1 zmieniony plik — odświeżam listę…")
    let clean = GitMeta(session: Sample.session(extra: #""branch":"main","dirtyCount":0"#), fresh: nil)
    #expect(GitChangesModel.emptyNote(meta: clean) == "Brak zmienionych plików.")
    #expect(!GitChangesModel.diffAvailable(meta: clean))
    #expect(GitChangesModel.diffAvailable(meta: GitMeta(session: Sample.session(extra: #""branch":"main""#), fresh: nil)),
            "nieznana liczba nie gasi przycisku")
  }

  @Test("czas commita bezwzględny: w bieżącym roku dzień, miesiąc i godzina, w innym rok")
  func commitWhen() {
    let utc = TimeZone(identifier: "UTC") ?? .current
    let now = Date(timeIntervalSince1970: 1_791_000_000)  // 2026-10
    #expect(GitChangesModel.commitWhen("2026-10-03T14:05:00.000Z", now: now, timeZone: utc) == "3 paź 14:05")
    #expect(GitChangesModel.commitWhen("2025-12-24T09:00:00Z", now: now, timeZone: utc) == "24 gru 2025")
    #expect(GitChangesModel.commitWhen("nie-czas", now: now, timeZone: utc) == nil)
  }

  @Test("patch pliku: linie z rodzajem i tożsamością „ścieżka#linia”, ogon bez pustej linii, dwa bloki razem")
  func patch() {
    let patch = """
      diff --git a/src/a b.ts b/src/a b.ts
      index 1..2 100644
      --- a/src/a b.ts
      +++ b/src/a b.ts
      @@ -1 +1 @@
      -stare
      +nowe
      diff --git a/src/a b.ts b/src/a b.ts
      +linia

      """
    let rows = PatchParser.rows(patch, path: "src/a b.ts")
    #expect(rows.count == 9, "odpowiedź z dwoma blokami to dalej jedna lista linii")
    #expect(rows.map(\.kind) == [.meta, .meta, .meta, .meta, .hunk, .deleted, .added, .meta, .added])
    #expect(rows.first?.id == "src/a b.ts#0" && rows.last?.id == "src/a b.ts#8")
    #expect(rows.last?.text == "+linia", "pusty ogon po znaku nowej linii nie jest linią")
    #expect(PatchParser.rows("", path: "x").isEmpty)
    #expect(PatchParser.rows("jedna", path: "x").map(\.text) == ["jedna"])
    #expect(PatchLineKind(" kontekst") == .context)
    // Reszta nagłówka patcha (tryb pliku, rename, binarny) to też meta; treść w hunku zaczyna się od znaku.
    for line in ["new file mode 100644", "deleted file mode 100644", "rename from a.ts", "rename to b.ts",
                 "similarity index 96%", "Binary files /dev/null and b/x.png differ"] {
      #expect(PatchLineKind(Substring(line)) == .meta, "\(line)")
    }
    #expect(PatchLineKind(" new file mode w treści") == .context && PatchLineKind("+index w treści") == .added)
  }

  /// Plik nieśledzony nie ma liczników na liście zmian — nagłówek bierze je z patcha, gdy ten jest cały.
  @Test("bilans z patcha: tylko linie w hunkach; nagłówek pliku i „-- komentarz” nie mylą; binarny osobno")
  func patchStat() {
    let text = """
      diff --git a/q.sql b/q.sql
      index 1..2 100644
      --- a/q.sql
      +++ b/q.sql
      @@ -1,3 +1,3 @@
       select 1;
      --- stary komentarz
      +-- nowy komentarz
      +++ plusy w treści
      \\ No newline at end of file
      """
    #expect(PatchStat(text) == .lines(added: 2, deleted: 1))
    let fresh = "diff --git a/n.txt b/n.txt\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n"
    #expect(PatchStat(fresh) == .lines(added: 2, deleted: 0))
    let twoBlocks = "diff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-stary\n"
      + "diff --git a/x b/x\nnew file mode 120000\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+cel\n\\ No newline at end of file\n"
    #expect(PatchStat(twoBlocks) == .lines(added: 1, deleted: 1), "zmiana typu pliku: dwa bloki liczą się razem")
    #expect(PatchStat("diff --git a/b.bin b/b.bin\nnew file mode 100644\nBinary files /dev/null and b/b.bin differ\n") == .binary)
    #expect(PatchStat("") == .lines(added: 0, deleted: 0))
  }

  /// W Swifcie `\r\n` to JEDEN znak, którego podział po `"\n"` nie widzi: plik z końcami CRLF sklejał się
  /// w jedną linię patcha i jeden plus bilansu (ten sam przypadek co `MiniDiff`).
  @Test("patch pliku z końcami CRLF: linia na linię, bez `\\r` w tekście, bilans liczy każdą")
  func patchCRLF() {
    let patch = "diff --git a/w.txt b/w.txt\nnew file mode 100644\n--- /dev/null\n+++ b/w.txt\n@@ -0,0 +1,3 @@\n+a\r\n+\r\n+b\r\n"
    #expect(PatchStat(patch) == .lines(added: 3, deleted: 0))
    let rows = PatchParser.rows(patch, path: "w.txt")
    #expect(rows.map(\.text).suffix(4) == ["@@ -0,0 +1,3 @@", "+a", "+", "+b"])
    #expect(rows.map(\.kind).suffix(4) == [.hunk, .added, .added, .added])
    #expect(PatchStat("@@ -1,2 +1 @@\r\n-a\r\n-b\r\n+c\r\n") == .lines(added: 1, deleted: 2))
  }

  @Test("okno diffa: tytuł z liczbą plików, „500+” przy uciętej liście; stopki z liczbami kontraktu")
  func windowCopy() {
    #expect(UICopy.diffWindowTitle(files: nil, truncated: false) == "Zmiany")
    #expect(UICopy.diffWindowTitle(files: 3, truncated: false) == "Zmiany · 3\u{00A0}pliki")
    #expect(UICopy.diffWindowTitle(files: 1, truncated: false) == "Zmiany · 1\u{00A0}plik")
    #expect(UICopy.diffWindowTitle(files: 500, truncated: true) == "Zmiany · 500+\u{00A0}plików")
    #expect(UICopy.diffListTruncated() == "lista ucięta (500\u{00A0}plików)")
    #expect(UICopy.diffFileTruncated() == "plik ucięty (512\u{00A0}kB)")
  }
}
