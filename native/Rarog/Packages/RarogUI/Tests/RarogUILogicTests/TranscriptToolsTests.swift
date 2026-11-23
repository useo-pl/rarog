import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Karty narzędzi, serie, znaczniki i pamięć czytania. Właściciel: transkrypt.

private enum Tools {
  static func json(_ value: String) -> String {
    String(data: try! JSONEncoder().encode(value), encoding: .utf8)!
  }

  /// Blok narzędzia; nazwy spoza listy strażnika źródeł (literały narzędzi CLI są w Swifcie zakazane).
  static func block(_ name: String, _ summary: String, detail: String? = nil, diff: Bool = false, shell: Bool = false) -> String {
    var fields = [#""type":"tool-call""#, #""toolName":\#(json(name))"#, #""summary":\#(json(summary))"#]
    if let detail { fields.append(#""detail":\#(json(detail))"#) }
    if diff { fields.append(#""detailKind":"diff""#) }
    if shell { fields.append(#""inputKind":"shell""#) }
    return "{\(fields.joined(separator: ","))}"
  }

  static func message(_ seq: Int, _ role: String = "assistant", ago: TimeInterval, _ blocks: String...) -> TranscriptMessage {
    Sample.decode(TranscriptMessage.self, #"{"seq":\#(seq),"role":"\#(role)","blocks":[\#(blocks.joined(separator: ","))],"at":"\#(Sample.iso(ago))"}"#)
  }

  static func text(_ seq: Int, _ role: String = "assistant", ago: TimeInterval, _ value: String) -> TranscriptMessage {
    Sample.decode(TranscriptMessage.self, #"{"seq":\#(seq),"role":"\#(role)","blocks":\#(Sample.text(value)),"at":"\#(Sample.iso(ago))"}"#)
  }

  static func rows(_ messages: [TranscriptMessage], reading: TranscriptReading = TranscriptReading()) -> [TranscriptRow] {
    var ui = TranscriptUIState()
    ui.reading = reading
    return TranscriptRows.build(
      state: Sample.state(session: Sample.session(), messages: messages), sessionId: "s1", ui: ui, calendar: Sample.calendar)
  }

  static func cards(_ rows: [TranscriptRow]) -> [ToolRowModel] {
    rows.compactMap { if case let .tool(card) = $0 { card } else { nil } }
  }

  static func run(_ rows: [TranscriptRow]) -> ToolRunModel? {
    rows.lazy.compactMap { if case let .toolRun(run) = $0 { run } else { nil } }.first
  }
}

@Suite("karty narzędzi: linia, rozwinięcie, mini-diff")
struct ToolCardTests {
  @Test("mini-diff: rodzaj z prefiksu serwera, 12 linii na wierzchu, do 14 bez rozwijaka")
  func miniDiff() {
    let short = MiniDiff((1...14).map { "+ linia \($0)" }.joined(separator: "\n"))
    #expect(short.head.count == 14 && short.tail.isEmpty && short.added == 14)
    let long = MiniDiff((["  kontekst", "- -minus w kodzie"] + (1...13).map { "+ \($0)" }).joined(separator: "\n"))
    #expect(long.head.count == 12 && long.tail.count == 3)
    #expect(long.added == 13 && long.deleted == 1)
    #expect(long.head.prefix(2).map(\.kind) == [.ctx, .del])
    #expect(UICopy.diffMore(3) == "… jeszcze 3 linie" && UICopy.diffMore(5) == "… jeszcze 5 linii")
    #expect(UICopy.diffMore(1) == "… jeszcze 1 linia" && UICopy.diffMore(22) == "… jeszcze 22 linie")
  }

  /// Serwer tnie po `\n`, więc plik z końcami CRLF daje linie zakończone `\r`. W Swifcie `\r\n`
  /// to JEDEN znak (grafem), którego podział po `"\n"` nie widzi.
  @Test("mini-diff z końcami CRLF: linia na linię, limit 12 działa, puste linie zostają")
  func miniDiffCRLF() {
    let crlf = MiniDiff((["  kontekst", "- stare"] + (1...18).map { "+ \($0)" }).joined(separator: "\r\n"))
    #expect(crlf.head.count == 12 && crlf.tail.count == 8)
    #expect(crlf.added == 18 && crlf.deleted == 1)
    #expect(crlf.head.prefix(3).map(\.kind) == [.ctx, .del, .add])
    #expect(crlf.head.map(\.text).prefix(2) == ["  kontekst", "- stare"], "bez `\\r` na końcu linii")
    let blanks = MiniDiff("+ a\r\n\r\n+ b\n\n+ c")
    #expect(blanks.head.map(\.text) == ["+ a", "", "+ b", "", "+ c"])
  }

  @Test("zwykła karta zwinięta, edycja otwarta od razu; tap przestawia; pusta treść bez rozwinięcia")
  func expansion() {
    let messages = [
      Tools.message(1, ago: 60, Tools.block("Shell", "/Users/d/Projects/x/a/b/c.ts", detail: "ls  -la\r\n/x", shell: true)),
      Tools.message(2, ago: 50, Tools.block("Edit", "src/notes.ts", detail: "- a\n+ b", diff: true)),
      Tools.message(3, ago: 40, Tools.block("Read", "README.md", detail: "")),
    ]
    var reading = TranscriptReading()
    var cards = Tools.cards(Tools.rows(messages, reading: reading))
    #expect(cards.map(\.expanded) == [false, true, false])
    #expect(cards[0].line == "Shell: …/a/b/c.ts" && cards[0].shell && cards[0].detail == "ls  -la\r\n/x")
    #expect(!cards[2].expandable && cards[2].detail == nil)
    reading.toggle(cards[0].id, diff: false)
    reading.toggle(cards[1].id, diff: true)
    cards = Tools.cards(Tools.rows(messages, reading: reading))
    #expect(cards.map(\.expanded) == [true, false, false])
    #expect(UICopy.toolSpoken(line: "Edit: a", added: 2, deleted: 1) == "Edit: a, 2 dodane linie, 1 usunięta linia")
  }

  @Test("decyzja zwija automatycznie otwarte mini-diffy RAZ; ruszonych ręką i późniejszych nie dotyka")
  func decisionCollapsesOnce() {
    let edit = Tools.message(1, ago: 60, Tools.block("Edit", "a.ts", detail: "+ x", diff: true))
    let manual = Tools.message(2, ago: 50, Tools.block("Edit", "b.ts", detail: "+ y", diff: true))
    var state = Sample.state(session: Sample.session(state: "waiting-permission"), messages: [edit, manual])
    var reading = TranscriptReading()
    reading.toggle("m2.0", diff: true)
    reading.toggle("m2.0", diff: true)  // ręka zostawiła otwarty, ale RUSZYŁA
    reading.prepare(state.transcripts["s1"])
    #expect(!reading.decisionShown && reading.isExpanded("m1.0", diff: true))

    state.transcripts["s1"]?.pendingPermissions = [Sample.permission()]
    reading.prepare(state.transcripts["s1"])
    #expect(reading.decisionShown)
    #expect(!reading.isExpanded("m1.0", diff: true) && reading.isExpanded("m2.0", diff: true))

    // Kolejna edycja przy wciąż stojącej decyzji zostaje otwarta — zbocze było jedno.
    state.transcripts["s1"]?.messages.append(Tools.message(3, ago: 40, Tools.block("Edit", "c.ts", detail: "+ z", diff: true)))
    reading.prepare(state.transcripts["s1"])
    #expect(reading.isExpanded("m3.0", diff: true))
    // Człowiek może rozwinąć zwinięty z powrotem.
    reading.toggle("m1.0", diff: true)
    #expect(reading.isExpanded("m1.0", diff: true))
  }

  @Test("adres w rozwinięciu klikalny tylko http(s); interpunkcja i www zostają tekstem")
  func detailLinks() {
    let text = "curl https://example.com/a?b=1. i http://localhost:5273/app, www.x.pl oraz mailto:a@example.com"
    let urls = ToolDetailLinks.urls(in: text).map(\.url.absoluteString)
    #expect(urls == ["https://example.com/a?b=1", "http://localhost:5273/app"])
    let attributed = ToolDetailLinks.attributed(text)
    #expect(String(attributed.characters) == text)
    #expect(attributed.runs.filter { $0.link != nil }.count == 2)
  }
}

@Suite("seria kroków narzędzi zwinięta do najnowszego")
struct ToolRunTests {
  private let prompt = Tools.text(1, "user", ago: 90, "Sprawdź import")

  private func steps(_ seqs: ClosedRange<Int>) -> [TranscriptMessage] {
    seqs.map { Tools.message($0, ago: 80 - Double($0), Tools.block("Grep", "krok \($0)")) }
  }

  @Test("trzy kroki: rozwijak z etykietą głosu nad najnowszym, dwa schowane; dwa kroki stoją same")
  func collapsed() {
    let rows = Tools.rows([prompt] + steps(2...4))
    #expect(rows.map(\.id) == ["m1.0", "r2", "m4.0"])
    let run = Tools.run(rows)
    // Rozwijak jest pierwszym widocznym wierszem po prompcie: niesie granicę „po prompcie” i otwiera kartę kroków.
    #expect(run == ToolRunModel(
      id: 2, voice: .assistant, hidden: 2, expanded: false, turn: TurnMark(gap: .afterPrompt), chain: .first))
    #expect(Tools.cards(rows).first?.voice == nil)
    #expect(UICopy.toolRunLabel(hidden: 2, expanded: false) == "wcześniejsze kroki (2)")
    #expect(Tools.run(Tools.rows([prompt] + steps(2...3))) == nil)
  }

  @Test("rozwinięta: wszystkie kroki, głos na pierwszym, rozwijak nad ostatnim; rośnie i się nie zwija")
  func expanded() {
    var reading = TranscriptReading()
    reading.toggleRun(2)
    var rows = Tools.rows([prompt] + steps(2...4), reading: reading)
    #expect(rows.map(\.id) == ["m1.0", "m2.0", "m3.0", "r2", "m4.0"])
    #expect(Tools.cards(rows).first?.voice == .assistant && Tools.run(rows)?.voice == nil)
    #expect(UICopy.toolRunLabel(hidden: 2, expanded: true) == "zwiń wcześniejsze kroki")
    rows = Tools.rows([prompt] + steps(2...6), reading: reading)
    #expect(rows.map(\.id) == ["m1.0", "m2.0", "m3.0", "m4.0", "m5.0", "r2", "m6.0"])
    #expect(Tools.run(rows)?.hidden == 4)
  }

  @Test("edycja pliku przerywa serię i zostaje na wierzchu; tekst agenta też przerywa")
  func diffBreaksRun() {
    let edit = Tools.message(5, ago: 70, Tools.block("Edit", "a.ts", detail: "+ x", diff: true))
    let rows = Tools.rows([prompt] + steps(2...4) + [edit] + steps(6...7) + [Tools.text(8, ago: 60, "Gotowe")])
    #expect(rows.map(\.id) == ["m1.0", "r2", "m4.0", "m5.0", "m6.0", "m7.0", "m8.0"])
  }

  @Test("schowany = suma wywołań; prune zdejmuje rozwinięcie serii, której już nie ma")
  func hiddenAndPrune() {
    let multi = Tools.message(2, ago: 70, Tools.block("Grep", "a"), Tools.block("Read", "b"))
    let rows = Tools.rows([prompt, multi] + steps(3...4))
    #expect(Tools.run(rows)?.hidden == 3)
    var reading = TranscriptReading()
    reading.toggleRun(99)
    var view = TranscriptState()
    view.messages = [prompt] + steps(2...4)
    view.snapshots = 1
    reading.prepare(view)
    #expect(reading.expandedRuns.isEmpty)
  }

  /// Sufit 500 wiadomości ucina transkrypt od początku: seria na samej górze traci pierwszą
  /// wiadomość, więc jej identyfikator (`seq` pierwszej) się zmienia.
  @Test("przycięcie początku transkryptu nie zwija serii rozwiniętej ręką")
  func trimKeepsExpansion() {
    var view = TranscriptState()
    view.messages = steps(2...6)
    view.snapshots = 1
    var reading = TranscriptReading()
    reading.prepare(view)
    reading.toggleRun(2)
    reading.prepare(view)
    #expect(reading.expandedRuns == [2])

    view.messages = steps(3...7)  // najstarsza wypadła, na dole doszedł krok
    reading.prepare(view)
    #expect(reading.expandedRuns == [3])
    #expect(Tools.run(Tools.rows(view.messages, reading: reading))?.expanded == true)

    // Seria, która przestała istnieć (za krótka), znika z rozwinięć; obca nie dziedziczy.
    view.messages = steps(6...7) + [Tools.text(8, ago: 60, "Gotowe")] + steps(9...11)
    reading.prepare(view)
    #expect(reading.expandedRuns.isEmpty)
  }
}

@Suite("sąsiednie narzędzia jako jedna karta")
struct ToolChainTests {
  private let prompt = Tools.text(1, "user", ago: 90, "Sprawdź import")

  private func step(_ seq: Int, _ summary: String = "krok") -> TranscriptMessage {
    Tools.message(seq, ago: 80 - Double(seq), Tools.block("Grep", "\(summary) \(seq)"))
  }

  /// Miejsce w karcie każdego wiersza narzędzia albo rozwijaka, w kolejności listy.
  private func places(_ rows: [TranscriptRow]) -> [String] {
    rows.compactMap { row in
      switch row {
      case .tool, .toolRun: "\(row.id):\(row.toolChain)"
      default: nil
      }
    }
  }

  @Test("jedno wywołanie stoi samo; sąsiednie łączą się ponad granicami wiadomości, także kilka w jednej")
  func adjacentAcrossMessages() {
    #expect(places(Tools.rows([prompt, step(2)])) == ["m2.0:alone"])
    let multi = Tools.message(3, ago: 70, Tools.block("Grep", "a"), Tools.block("Read", "b"))
    let rows = Tools.rows([prompt, step(2), multi])
    #expect(places(rows) == ["m2.0:first", "m3.0:middle", "m3.1:last"])
    // Pierwszy wiersz karty zachowuje granicę po prompcie; środek i koniec idą bez odstępu.
    #expect(rows.first { $0.id == "m2.0" }?.turn.gap == .afterPrompt)
  }

  @Test("tekst przerywa kartę — w osobnej wiadomości i między blokami jednej wiadomości")
  func textBreaks() {
    #expect(places(Tools.rows([prompt, step(2), Tools.text(3, ago: 60, "Patrzę"), step(4)])) == ["m2.0:alone", "m4.0:alone"])
    let mixed = Tools.message(
      2, ago: 70, Tools.block("Grep", "a"), #"{"type":"text","text":"Między"}"#, Tools.block("Read", "b"), Tools.block("Read", "c"))
    #expect(places(Tools.rows([prompt, mixed])) == ["m2.0:alone", "m2.2:first", "m2.3:last"])
  }

  @Test("prompt przerywa kartę: narzędzie nowej tury otwiera nową kartę")
  func promptBreaks() {
    let rows = Tools.rows([prompt, step(2), step(3), Tools.text(4, "user", ago: 50, "A teraz?"), step(5), step(6)])
    #expect(places(rows) == ["m2.0:first", "m3.0:last", "m5.0:first", "m6.0:last"])
  }

  @Test("zwinięta seria: rozwijak to pierwszy wiersz karty; rozwinięta: schowane kroki wchodzą do tej samej karty")
  func runInsideCard() {
    var rows = Tools.rows([prompt] + (2...4).map { step($0) })
    #expect(places(rows) == ["r2:first", "m4.0:last"])
    var reading = TranscriptReading()
    reading.toggleRun(2)
    rows = Tools.rows([prompt] + (2...4).map { step($0) }, reading: reading)
    #expect(places(rows) == ["m2.0:first", "m3.0:middle", "r2:middle", "m4.0:last"])
  }

  @Test("granica serii (edycja z mini-diffem) nie przerywa karty, tekst — tak")
  func seriesBoundaryAndText() {
    let edit = Tools.message(5, ago: 70, Tools.block("Edit", "a.ts", detail: "+ x", diff: true))
    let rows = Tools.rows([prompt] + (2...4).map { step($0) } + [edit, step(6), Tools.text(7, ago: 60, "Gotowe"), step(8)])
    #expect(rows.map(\.id) == ["m1.0", "r2", "m4.0", "m5.0", "m6.0", "m7.0", "m8.0"])
    #expect(places(rows) == ["r2:first", "m4.0:middle", "m5.0:middle", "m6.0:last", "m8.0:alone"])
  }

  @Test("znacznik dnia między krokami przerywa kartę; płynąca odpowiedź zamyka ją od dołu")
  func markerAndOpenBreak() {
    let night = [
      Sample.decode(TranscriptMessage.self, #"{"seq":1,"role":"user","blocks":\#(Sample.text("Na noc")),"at":"2026-10-08T23:50:00Z"}"#),
      Sample.decode(
        TranscriptMessage.self, #"{"seq":2,"role":"assistant","blocks":[\#(Tools.block("Grep", "a"))],"at":"2026-10-08T23:55:00Z"}"#),
      Sample.decode(
        TranscriptMessage.self, #"{"seq":3,"role":"assistant","blocks":[\#(Tools.block("Grep", "b"))],"at":"2026-10-09T00:04:00Z"}"#),
    ]
    let rows = Tools.rows(night)
    #expect(rows.map(\.id) == ["m1.0", "m2.0", "t3", "m3.0"])
    #expect(places(rows) == ["m2.0:alone", "m3.0:alone"])

    let state = Sample.state(session: Sample.session(), messages: [prompt, step(2), step(3)], open: "Dalej…")
    let live = TranscriptRows.build(state: state, sessionId: "s1", calendar: Sample.calendar)
    #expect(live.map(\.id) == ["m1.0", "m2.0", "m3.0", "open"])
    #expect(places(live) == ["m2.0:first", "m3.0:last"])
  }

  /// Nowy krok na końcu zmienia miejsce POPRZEDNIEGO (sam → pierwszy): wiersz o tym samym identyfikatorze przestaje być
  /// równy, więc ekran sesji go przekonfigurowuje (`render` porównuje wiersze po `id`), a identyfikatory stoją.
  @Test("krok dochodzi na koniec: sąsiad zmienia miejsce przy tym samym identyfikatorze")
  func growthReconfiguresNeighbour() {
    let before = Tools.rows([prompt, step(2)])
    let after = Tools.rows([prompt, step(2), step(3)])
    #expect(before.map(\.id) == ["m1.0", "m2.0"] && after.map(\.id) == ["m1.0", "m2.0", "m3.0"])
    let old = before.first { $0.id == "m2.0" }
    let new = after.first { $0.id == "m2.0" }
    #expect(old?.toolChain == .alone && new?.toolChain == .first)
    #expect(old != new, "zmiana miejsca = inny wiersz = rekonfiguracja komórki")
  }

  @Test("miejsce w karcie z indeksu i długości; styki tylko wewnątrz karty")
  func placeRule() {
    #expect(ToolChainPlace.at(0, of: 1) == .alone)
    #expect((0..<3).map { ToolChainPlace.at($0, of: 3) } == [.first, .middle, .last])
    #expect(!ToolChainPlace.alone.joinsAbove && !ToolChainPlace.alone.joinsBelow)
    #expect(!ToolChainPlace.first.joinsAbove && ToolChainPlace.first.joinsBelow)
    #expect(ToolChainPlace.middle.joinsAbove && ToolChainPlace.middle.joinsBelow)
    #expect(ToolChainPlace.last.joinsAbove && !ToolChainPlace.last.joinsBelow)
  }
}

@Suite("znaczniki: godzina po przerwie i linia „NOWE”")
struct TranscriptMarkerTests {
  @Test("godzina po ≥ 10 min, nie nad pierwszą wiadomością ani nad krokiem narzędzia")
  func timeGap() {
    let utc = TimeZone(identifier: "UTC")!
    #expect(TimeGap.clock(previous: "2026-10-04T10:00:00Z", next: "2026-10-04T10:10:00.000Z", timeZone: utc) == "10:10")
    #expect(TimeGap.clock(previous: "2026-10-04T10:00:00Z", next: "2026-10-04T10:09:59Z", timeZone: utc) == nil)
    #expect(TimeGap.clock(previous: "wczoraj", next: "2026-10-04T10:30:00Z", timeZone: utc) == nil)
    #expect(UICopy.timeGap("10:10") == "— 10:10 —")

    let messages = [
      Tools.text(1, "user", ago: 3600, "Zacznij"),
      Tools.message(2, ago: 2400, Tools.block("Grep", "a")),
      Tools.text(3, ago: 1200, "Po przerwie"),
      Tools.text(4, ago: 1100, "Zaraz potem"),
    ]
    let rows = Tools.rows(messages)
    let clock = ServerTime.clock(messages[2].at, timeZone: utc)!
    #expect(rows.map(\.id) == ["m1.0", "m2.0", "t3", "m3.0", "m4.0"])
    #expect(rows[2] == .timeGap(id: "t3", mark: TimeMark(clock: clock)))
    #expect(UICopy.timeGapSpoken(TimeMark(clock: clock)) == "Przerwa, dalej od \(clock)")
  }

  @Test("NOWE: pierwsza wiadomość nowsza niż ostatnia wizyta, ostro, z pominięciem kroków narzędzi")
  func newMarkerIndex() {
    let messages = [
      Tools.text(1, "user", ago: 300, "a"),
      Tools.message(2, ago: 200, Tools.block("Grep", "b")),
      Tools.text(3, ago: 100, "c"),
    ]
    #expect(NewMarker.index(messages, seenAt: messages[0].at) == 2)
    #expect(NewMarker.index(messages, seenAt: messages[2].at) == nil)
    #expect(NewMarker.index(messages, seenAt: nil) == nil)
    #expect(NewMarker.index(messages, seenAt: "nie-czas") == nil)
  }

  @Test("decyzja zapada na ŚWIEŻYM stanie z serwera i potem stoi; pamięć podręczna jej nie zamraża")
  func newMarkerDecision() {
    let old = Tools.text(1, "user", ago: 300, "stare")
    var view = TranscriptState()
    view.messages = [old]
    view.snapshots = 2
    var decision = NewMarkerDecision(seenAt: old.at, snapshotsAtEntry: 2)
    decision.settle(view)
    #expect(decision.seq == nil && !decision.fixed, "transkrypt z pamięci: liczony, ale nie zamrożony")

    view.messages.append(Tools.text(2, ago: 200, "nowe od serwera"))
    view.snapshots = 3
    decision.settle(view)
    #expect(decision.seq == 2 && decision.fixed)

    view.messages = [old]  // nawet gdy treść się zmieni, linia już stoi
    decision.settle(view)
    #expect(decision.seq == 2)

    var first = NewMarkerDecision(seenAt: nil, snapshotsAtEntry: 0)
    view.snapshots = 1
    first.settle(view)
    #expect(first.seq == nil && first.fixed, "pierwsza wizyta bez linii")
  }

  /// Powrót do sesji z transkryptem w pamięci idzie kursorem: serwer odtwarza ramki z bufora
  /// BEZ snapshotu, więc licznik snapshotów stoi. Wejście o `Sample.now − 50 s`.
  @Test("powtórka z kursorem bez snapshotu: linia nad tym, co przyszło pod nieobecność, nigdy nad żywym")
  func newMarkerAfterReplay() {
    let old = Tools.text(1, "user", ago: 300, "stare")
    let entered = Sample.now.addingTimeInterval(-50)
    var view = TranscriptState()
    view.messages = [old]
    view.snapshots = 2

    // Pod nieobecność nic nie przyszło: pierwsza wiadomość na żywo linii nie dostaje i zamyka decyzję.
    var quiet = NewMarkerDecision(seenAt: old.at, snapshotsAtEntry: 2, enteredAt: entered)
    quiet.settle(view)
    #expect(quiet.seq == nil && !quiet.fixed, "pamięć podręczna: liczona, nie zamrożona")
    view.messages.append(Tools.text(2, ago: 40, "na żywo"))
    quiet.settle(view)
    #expect(quiet.seq == nil && quiet.fixed)
    view.messages.append(Tools.text(3, ago: 30, "dalej na żywo"))
    quiet.settle(view)
    #expect(quiet.seq == nil)

    // Powtórka przyniosła odpowiedź sprzed wejścia: linia nad nią, żywe jej nie przesuwają.
    view.messages = [old]
    var replay = NewMarkerDecision(seenAt: old.at, snapshotsAtEntry: 2, enteredAt: entered)
    replay.settle(view)
    view.messages.append(Tools.text(2, ago: 120, "pod nieobecność"))
    replay.settle(view)
    #expect(replay.seq == 2)
    view.messages.append(Tools.text(3, ago: 40, "na żywo"))
    replay.settle(view)
    #expect(replay.seq == 2 && replay.fixed)
  }

  /// Linia mówi „stąd agent pisał pod twoją nieobecność". Prompt człowieka (także
  /// wpisany w terminalu na Macu) to twoje słowa, więc linia przechodzi nad pierwszą wiadomość agenta; notka harnessu
  /// mówi, co się stało pod nieobecność, i zostaje nowa.
  @Test("NOWE nad pierwszą wiadomością agenta albo notką; prompt człowieka i same narzędzia pominięte")
  func newMarkerSkipsHumanPrompt() throws {
    let notice = Sample.decode(TranscriptMessage.self, #"""
      {"seq":4,"role":"user","blocks":\#(Sample.text("wpis harnessu")),"at":"\#(Sample.iso(150))",
       "notice":{"kind":"command","outcome":"done","name":"pnpm test","exitCode":0}}
      """#)
    let messages = [
      Tools.text(1, ago: 400, "przed przerwą"),
      Tools.text(2, "user", ago: 300, "prompt z terminala"),
      Tools.message(3, ago: 200, Tools.block("Grep", "a")),
      notice,
      Tools.text(5, ago: 100, "odpowiedź"),
    ]
    let seen = messages[0].at
    #expect(NewMarker.index(messages, seenAt: seen) == 3, "notka zostaje nowa")
    let withoutNotice = messages.filter { $0.notice == nil }
    #expect(NewMarker.index(withoutNotice, seenAt: seen) == 3, "nad odpowiedzią, nie nad promptem ani narzędziem")
    #expect(NewMarker.index(Array(messages.prefix(3)), seenAt: seen) == nil, "sam prompt i narzędzia: bez linii")

    var reading = TranscriptReading(newMarker: NewMarkerDecision(seenAt: seen))
    var view = TranscriptState()
    view.messages = withoutNotice
    view.snapshots = 1
    reading.prepare(view)
    let ids = Tools.rows(withoutNotice, reading: reading).map(\.id)
    let line = try #require(ids.firstIndex(of: "new"))
    let prompt = try #require(ids.firstIndex(of: "m2.0"))
    #expect(ids[line + 1] == "m5.0" && prompt < line)
  }

  /// Sesja zostawiona otwarta, apka w tle, po powrocie linia jak w Slacku po przerwie.
  /// Powrót zakłada nową decyzję od zapisu przy zejściu w tło; powtórka z bufora (bez snapshotu) przynosi najpierw
  /// prompt z terminala i kroki, potem odpowiedź. Ramka stanu transkryptu nie zmienia — to sam `settle` bez wiadomości.
  @Test("powrót z tła: nowa wizyta — linia nad pierwszą odpowiedzią z przerwy, żywe jej nie przesuwają")
  func newMarkerAfterBackground() {
    var view = TranscriptState()
    view.messages = [Tools.text(1, ago: 900, "przed przerwą")]
    view.snapshots = 1
    var memory = LastSeenMemory()
    memory.note("s1", at: view.messages.last!.at)  // zejście w tło: `at` najnowszej
    let returned = Sample.now.addingTimeInterval(-60)
    var visit = NewMarkerDecision(seenAt: memory.seenAt("s1"), snapshotsAtEntry: view.snapshots, enteredAt: returned)
    visit.settle(view)
    #expect(visit.seq == nil && !visit.fixed, "ramka stanu przed treścią: decyzja otwarta")

    view.messages.append(Tools.text(2, "user", ago: 600, "prompt z terminala"))
    visit.settle(view)
    view.messages.append(Tools.message(3, ago: 500, Tools.block("Grep", "a")))
    visit.settle(view)
    #expect(visit.seq == nil && !visit.fixed, "prompt i kroki z przerwy: linii jeszcze nie ma, decyzja otwarta")
    view.messages.append(Tools.text(4, ago: 400, "odpowiedź pod nieobecność"))
    view.messages.append(Tools.text(5, ago: 300, "dalej pod nieobecność"))
    visit.settle(view)
    #expect(visit.seq == 4 && !visit.fixed)
    view.messages.append(Tools.text(6, ago: 30, "na żywo, po powrocie"))
    visit.settle(view)
    #expect(visit.seq == 4 && visit.fixed, "pierwsza wiadomość po powrocie zamyka decyzję i linii nie przesuwa")
    view.messages.append(Tools.text(7, "user", ago: 20, "prompt na żywo"))
    view.messages.append(Tools.text(8, ago: 10, "odpowiedź na żywo"))
    visit.settle(view)
    #expect(visit.seq == 4)

    // Kursor za stary: powrót dostaje pełny stan — decyzja zapada na nim, z tą samą granicą „na żywo".
    var full = NewMarkerDecision(seenAt: memory.seenAt("s1"), snapshotsAtEntry: 1, enteredAt: returned)
    view.snapshots = 2
    full.settle(view)
    #expect(full.seq == 4 && full.fixed)

    // Odpowiedź z przerwy doszła, zanim apka zasnęła: przy powrocie jest już w magazynie.
    var early = TranscriptState()
    early.messages = [view.messages[0], view.messages[3]]
    early.snapshots = 1
    var arrived = NewMarkerDecision(seenAt: memory.seenAt("s1"), snapshotsAtEntry: 1, enteredAt: returned)
    arrived.settle(early)
    #expect(arrived.seq == 4 && !arrived.fixed)
  }

  @Test("dwa powroty bez nowych wiadomości: bez linii, także po linii z poprzedniej wizyty")
  func newMarkerTwoQuietReturns() {
    var view = TranscriptState()
    view.messages = [Tools.text(1, ago: 900, "przed przerwą"), Tools.text(2, ago: 600, "pod nieobecność")]
    view.snapshots = 1
    var memory = LastSeenMemory()
    var reading = TranscriptReading(newMarker: NewMarkerDecision(seenAt: view.messages[0].at, snapshotsAtEntry: 0))
    reading.prepare(view)
    #expect(reading.newMarker.seq == 2, "wizyta z linią")

    for (round, back) in [Sample.now.addingTimeInterval(-120), Sample.now].enumerated() {
      memory.note("s1", at: view.messages.last!.at)
      reading.newMarker = NewMarkerDecision(seenAt: memory.seenAt("s1"), snapshotsAtEntry: view.snapshots, enteredAt: back)
      reading.prepare(view)
      #expect(reading.newMarker.seq == nil, "powrót \(round + 1): nic nowego, linii nie ma")
      #expect(!Tools.rows(view.messages, reading: reading).contains { $0.id == "new" })
    }
    view.messages.append(Tools.text(3, ago: -5, "na żywo po drugim powrocie"))
    reading.prepare(view)
    #expect(reading.newMarker.seq == nil && reading.newMarker.fixed)
  }

  @Test("linia stoi nad godziną i przed wierszem z etykietą głosu")
  func newMarkerRow() {
    let messages = [Tools.text(1, "user", ago: 3600, "a"), Tools.text(2, ago: 600, "b")]
    var reading = TranscriptReading(newMarker: NewMarkerDecision(seenAt: messages[0].at))
    var view = TranscriptState()
    view.messages = messages
    view.snapshots = 1
    reading.prepare(view)
    let rows = Tools.rows(messages, reading: reading)
    #expect(rows.map(\.id) == ["m1.0", "new", "t2", "m2.0"])
    #expect(rows[3] == .text(id: "m2.0", role: .assistant, voice: .assistant, markdown: "b"))
  }

  @Test("pamięć urządzenia: sufit 32, najdawniej oglądana wypada, śmieci = brak pamięci")
  func lastSeenMemory() {
    let prefs = MemoryPreferences()
    var memory = LastSeenMemory()
    for index in 0..<33 { memory.note("s\(index)", at: "2026-10-04T10:00:\(String(format: "%02d", index))Z") }
    #expect(memory.entries.count == 32 && memory.seenAt("s0") == nil)
    let changed = memory.note("s5", at: "2026-10-04T11:00:00Z")
    let repeated = memory.note("s5", at: "2026-10-04T11:00:00Z")
    #expect(changed && !repeated, "powtórka bez zmiany = bez zapisu")
    memory.save(to: prefs)
    #expect(LastSeenMemory.load(from: prefs).seenAt("s5") == "2026-10-04T11:00:00Z")
    prefs.set(Data("{zepsute".utf8), forKey: LastSeenMemory.key)
    #expect(LastSeenMemory.load(from: prefs).entries.isEmpty)
  }
}

@Suite("pamięć miejsca, pasek „na dół”, przygaszenie")
struct TranscriptPositionTests {
  @Test("przypięta sesja nie ma wpisu, odpięta ma wiersz; sufit 32 wycina najdawniejszą")
  func positions() {
    var memory = TranscriptPositionMemory()
    memory.remember("a", TranscriptAnchor(rowId: "m4.0", offset: 12))
    #expect(memory.recall("a") == TranscriptAnchor(rowId: "m4.0", offset: 12))
    memory.remember("a", nil)
    #expect(memory.recall("a") == nil)
    for index in 0..<33 { memory.remember("s\(index)", TranscriptAnchor(rowId: "m1.0", offset: 0)) }
    #expect(memory.recall("s0") == nil && memory.recall("s32") != nil)
  }

  @Test("zniknięty wiersz: pierwszy późniejszy wiersz treści; bez niego na dół")
  func fallback() {
    let anchor = TranscriptAnchor(rowId: "m5.0", offset: 30)
    #expect(anchor.fallback(in: ["m1.0", "r2", "m7.0", "t9", "open"]) == "m7.0")
    #expect(anchor.fallback(in: ["m1.0", "open"]) == nil)
    #expect(TranscriptAnchor(rowId: "open", offset: 0).fallback(in: ["m1.0"]) == nil)
    #expect(TranscriptRows.messageSeq("t12") == 12 && TranscriptRows.messageSeq("m3.a") == 3)
    #expect(TranscriptRows.messageSeq("p9") == nil)
  }

  /// Odpięta sesja zapisała miejsce 800 pt w głąb karty rozwiniętej ręką; nowa wizyta rozwinięć
  /// nie pamięta, więc karta wraca zwinięta na 36 pt. Pełne przesunięcie wypadało za kartą —
  /// na późniejszą wiadomość albo na dno, które przypinało.
  @Test("przesunięcie głębsze niż dzisiejszy wiersz stawia koniec wiersza na górze ekranu")
  func anchorDepth() {
    let card = TranscriptAnchor(rowId: "m5.0", offset: 800)
    #expect(card.offset(inRowOfHeight: 836) == 800, "ta sama wysokość: miejsce co do punktu")
    #expect(card.offset(inRowOfHeight: 36) == 0, "zwinięta karta staje cała na górze")
    #expect(card.offset(inRowOfHeight: 600) == 600 - TranscriptAnchor.keepVisible, "przelany tekst: jego koniec")
    #expect(TranscriptAnchor(rowId: "m5.0", offset: 30).offset(inRowOfHeight: 36) == 30)
    #expect(TranscriptAnchor(rowId: "m5.0", offset: -4).offset(inRowOfHeight: 36) == -4, "odbicie nad pierwszym wierszem")
  }

  /// Rozwinięcie serii trzyma rozwijak pod palcem, więc PRZESUWA ekran, a kotwica zostawała
  /// sprzed przesunięcia: obrót bez gestu wracał na nią i cofał czytającego.
  @Test("przestawienie ręką każe zapisać miejsce od nowa; nowa kotwica opisuje ekran po korekcie")
  func movedByHand() {
    var reading = TranscriptReading()
    var moved = reading.takeMoved()
    #expect(!moved)
    reading.toggleRun(6)
    moved = reading.takeMoved()
    let again = reading.takeMoved()
    #expect(moved && !again, "raz na przestawienie")
    reading.toggle("m2.0", diff: false)
    moved = reading.takeMoved()
    #expect(moved)
    reading.openDiffTail("m3.0")
    moved = reading.takeMoved()
    #expect(moved && reading.diffTails == ["m3.0"])
    var view = TranscriptState()
    view.messages = [Tools.text(1, ago: 60, "a")]
    view.snapshots = 1
    reading.prepare(view)
    moved = reading.takeMoved()
    #expect(!moved, "render bez ręki niczego nie zapisuje")

    // Przed: ekran od góry m5.0, rozwijak r6 na 90 pt ekranu. Rozwinięcie wstawia trzy kroki nad
    // rozwijakiem, a korekta trzyma go na 90 pt — górą ekranu jest teraz drugi krok.
    let before: [(id: String, minY: Double, maxY: Double)] = [("m5.0", 0, 100), ("r6", 100, 136), ("m9.0", 136, 300)]
    let stale = TranscriptAnchor.capture(before, top: 10)
    #expect(stale == TranscriptAnchor(rowId: "m5.0", offset: 10))
    let after: [(id: String, minY: Double, maxY: Double)] = [
      ("m5.0", 0, 100), ("m6.0", 100, 140), ("m7.0", 140, 180), ("m8.0", 180, 220), ("r6", 220, 256), ("m9.0", 256, 420),
    ]
    let held = 220.0 - 90  // rozwijak na tych samych 90 pt ekranu
    #expect(TranscriptAnchor.capture(after, top: held) == TranscriptAnchor(rowId: "m6.0", offset: 30))
    // Wpis w locie i płynąca odpowiedź nie są kotwicą, gdy na ekranie jest wiersz wiadomości.
    #expect(TranscriptAnchor.capture([("open", 0, 50), ("m9.0", 50, 90)], top: 10)?.rowId == "m9.0")
    #expect(TranscriptAnchor.capture([("open", 0, 50)], top: 60) == nil)
  }

  @Test("pasek mówi o decyzji, gdy ta stoi na dnie")
  func jumpLabel() {
    #expect(UICopy.jumpLabel(decision: false) == "Przewiń na dół")
    #expect(UICopy.jumpLabel(decision: true) == "Przewiń do decyzji")
  }

  /// Tokeny z `Theme/PaletteTokens.swift` (tekst, wyciszony, tło; oba motywy) — te same, z których
  /// `Palette` składa kolory w apce. Atramentem wierszy tekstu jest `prose`: ciemniejsza z dwóch (proza agenta;
  /// dymek człowieka pisze jaśniejszym `text`), więc to od niej liczy się krycie.
  @Test("przygaszenie zależy od atramentu: tekst i wyciszony zostają ≥ 7:1 (albo nieprzygaszone)")
  func dimContrast() {
    typealias RGB = TranscriptDim.RGB
    let (text, muted, background) = (PaletteTokens.prose, PaletteTokens.muted, PaletteTokens.background)
    let themes: [(name: String, text: RGB, muted: RGB, background: RGB)] = [
      ("ciemny", RGB(hex: text.dark), RGB(hex: muted.dark), RGB(hex: background.dark)),
      ("jasny", RGB(hex: text.light), RGB(hex: muted.light), RGB(hex: background.light)),
    ]
    for theme in themes {
      let text = TranscriptDim.alpha(ink: theme.text, background: theme.background)
      #expect(text == TranscriptDim.soft, "tekst: pełne 0,8 (\(theme.name))")
      #expect(TranscriptDim.dimmedContrast(theme.text, theme.background, alpha: text) >= 7, "\(theme.name)")

      let muted = TranscriptDim.alpha(ink: theme.muted, background: theme.background)
      let full = TranscriptDim.contrast(theme.muted, theme.background)
      #expect(TranscriptDim.dimmedContrast(theme.muted, theme.background, alpha: muted) >= min(7, full), "\(theme.name)")
      #expect(muted >= TranscriptDim.soft && muted <= 1)
    }
    // Jedno 0,8 dla wszystkiego zbija wyciszony w ciemnym z 7,85 do 5,32:1.
    let dark = themes[0]
    #expect(TranscriptDim.dimmedContrast(dark.muted, dark.background, alpha: 0.8) < 7)
    #expect(TranscriptDim.alpha(ink: dark.muted, background: dark.background) < 1, "ciemny: wyciszony też przygasa")
    // Jasny wyciszony ma 7,04:1: przygasa tylko o włos, nigdy pod próg.
    let lightMuted = TranscriptDim.alpha(ink: themes[1].muted, background: themes[1].background)
    #expect(lightMuted > 0.95 && lightMuted <= 1)
    // Atrament poniżej progu nie przygasa wcale (jasny wyciszony PWA, 6,93:1).
    #expect(TranscriptDim.alpha(ink: RGB(hex: 0x52525B), background: themes[1].background) == 1)

    #expect(TranscriptDim.ink(.text(id: "m1.0", role: .system, voice: nil, markdown: "x")) == .muted)
    #expect(TranscriptDim.ink(.text(id: "m1.0", role: .assistant, voice: nil, markdown: "x")) == .text)
    #expect(TranscriptDim.ink(.open(voice: nil, markdown: "x")) == .text)
    #expect(TranscriptDim.ink(.notice(id: "n", text: "x")) == .muted)
    #expect(TranscriptDim.ink(.newMarker()) == .muted)
  }
}
