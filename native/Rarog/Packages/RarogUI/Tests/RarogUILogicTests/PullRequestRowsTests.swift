import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Prawy panel sesji na iPadzie: sekcja PULL REQUESTY (`docs/pull-requests.md`) — wiersze
// z `SessionSummary.pullRequests` w kolejności serwera, tytuł albo odnośnik `owner/repo#n`, czas w gramatyce
// artefaktów i adres otwierany wyłącznie w gramatyce serwera.

@Suite("prawy panel: PULL REQUESTY")
struct PullRequestRowsTests {
  private let utc = TimeZone(identifier: "UTC")!
  private let export = "https://github.com/acme/widget/pull/42"
  private let fix = "https://github.com/acme/widget-docs/pull/7"

  /// Lista z drutu: tak, jak przychodzi w podsumowaniu sesji.
  private func wire(_ items: String) -> [SessionPullRequest] {
    Sample.session(extra: #""pullRequests":[\#(items)]"#).pullRequests ?? []
  }

  private func pr(
    _ url: String, title: String? = "Dodaj eksport CSV", number: Int = 42, state: PullRequestState? = nil
  ) -> SessionPullRequest {
    SessionPullRequest(
      url: url, repo: "acme/widget", number: number, createdAt: "2026-10-16T12:05:00Z", title: title, state: state)
  }

  @Test("kolejność z serwera, odnośnik owner/repo#n, tytuł, link, godzina i dzień w strefie urządzenia")
  func orderAndFields() {
    let rows = PullRequestRows.rows(
      wire(#"""
        {"url":"\#(export)","repo":"acme/widget","number":42,"createdAt":"2026-10-16T12:05:00.000Z",
         "title":"Dodaj eksport CSV"},
        {"url":"\#(fix)","repo":"acme/widget-docs","number":7,"createdAt":"2026-10-15T10:00:00.000Z"}
        """#),
      timeZone: utc)
    #expect(rows.map(\.id) == [export, fix], "kolejność serwera, bez ponownego sortowania")
    #expect(rows.map(\.ref) == ["acme/widget#42", "acme/widget-docs#7"])
    #expect(rows.map(\.title) == ["Dodaj eksport CSV", nil])
    #expect(rows[0].link == URL(string: export) && rows[1].link == URL(string: fix))
    #expect(rows[0].clock == "12:05" && rows[0].day == "16 paź")
    #expect(rows[1].clock == "10:00" && rows[1].day == "15 paź")
    let warsaw = PullRequestRows.rows([pr(export)], timeZone: TimeZone(identifier: "Europe/Warsaw")!)
    #expect(warsaw[0].clock == "14:05", "strefa urządzenia, nie serwera")
    #expect(PullRequestRows.rows([], timeZone: utc).isEmpty, "brak PR-ów = brak sekcji")
    // Kolejność serwera także wtedy, gdy czasy jej przeczą: apka nie sortuje.
    let reversed = PullRequestRows.rows(
      [SessionPullRequest(url: fix, repo: "acme/widget-docs", number: 7, createdAt: "2026-10-01T00:00:00Z"), pr(export)],
      timeZone: utc)
    #expect(reversed.map(\.id) == [fix, export])
  }

  @Test("pierwsza linia: tytuł, a bez niego odnośnik; linia stanu: odnośnik (przy tytule), ile temu i godzina")
  func headingAndStatus() {
    let twoHours = ServerTime.parse("2026-10-16T14:10:00Z")!
    let titled = PullRequestRows.rows([pr(export)], timeZone: utc)[0]
    #expect(titled.heading == "Dodaj eksport CSV")
    #expect(titled.status(now: twoHours) == ["acme/widget#42", "2\u{00A0}h\u{00A0}temu", "12:05"])
    let bare = PullRequestRows.rows([pr(export, title: nil)], timeZone: utc)[0]
    #expect(bare.heading == "acme/widget#42", "bez tytułu pierwsza linia to odnośnik")
    #expect(bare.status(now: twoHours) == ["2\u{00A0}h\u{00A0}temu", "12:05"], "odnośnik nie stoi dwa razy")
    let empty = PullRequestRows.rows([pr(export, title: "")], timeZone: utc)[0]
    #expect(empty.title == nil && empty.heading == "acme/widget#42", "pusty tytuł to brak tytułu")
    // Od doby dzień zamiast godziny — ta sama granica co „ile temu” w dniach.
    let nextDay = ServerTime.parse("2026-10-17T12:05:00Z")!
    #expect(titled.status(now: nextDay) == ["acme/widget#42", "1\u{00A0}d\u{00A0}temu", "16 paź"])
  }

  @Test("czytnik: rodzaj i odnośnik, tytuł, kiedy; link obiecuje przeglądarkę")
  func spoken() {
    let twoHours = ServerTime.parse("2026-10-16T14:10:00Z")!
    let titled = PullRequestRows.rows([pr(export)], timeZone: utc)[0]
    #expect(
      titled.spoken(now: twoHours)
        == "Pull request acme/widget#42, Dodaj eksport CSV, utworzony 2 godziny temu, o 12:05. Otwiera przeglądarkę.")
    let bare = PullRequestRows.rows([pr(export, title: nil)], timeZone: utc)[0]
    let later = ServerTime.parse("2026-10-19T18:00:00Z")!
    #expect(bare.spoken(now: later) == "Pull request acme/widget#42, utworzony 3 dni temu, 16 paź. Otwiera przeglądarkę.")
    #expect(UICopy.inspectorPullRequestsTitle == "Pull requesty")
    #expect(UICopy.pullRequestSpoken(ref: "a/b#1", title: nil, opens: false, ago: nil, stamp: nil) == "Pull request a/b#1.")
  }

  @Test("GitHub state from the wire reaches the row; no field means no state")
  func stateFromWire() {
    let rows = PullRequestRows.rows(
      wire(#"""
        {"url":"\#(export)","repo":"acme/widget","number":42,"createdAt":"2026-10-16T12:05:00Z","state":"merged"},
        {"url":"\#(fix)","repo":"acme/widget-docs","number":7,"createdAt":"2026-10-15T10:00:00Z"},
        {"url":"https://github.com/a/b/pull/1","repo":"a/b","number":1,"createdAt":"2026-10-15T10:00:00Z","state":"open"},
        {"url":"https://github.com/a/b/pull/2","repo":"a/b","number":2,"createdAt":"2026-10-15T10:00:00Z","state":"closed"},
        {"url":"https://github.com/a/b/pull/3","repo":"a/b","number":3,"createdAt":"2026-10-15T10:00:00Z","state":"draft"}
        """#),
      timeZone: utc)
    #expect(rows.map(\.state) == [.merged, nil, .open, .closed, .draft])
  }

  @Test("merged and closed fold under one row; open, draft and unknown stay in view, server order kept")
  func foldSettled() {
    let url = { (n: Int) in "https://github.com/a/b/pull/\(n)" }
    let states: [PullRequestState?] = [.merged, nil, .open, .closed, .draft, .merged, .open]
    let rows = PullRequestRows.rows(
      states.enumerated().map { pr(url($0.offset + 1), number: $0.offset + 1, state: $0.element) }, timeZone: utc)
    let split = PullRequestRows.split(rows)
    #expect(split.shown.map(\.id) == [url(2), url(3), url(5), url(7)])
    #expect(split.shown.map(\.state) == [nil, .open, .draft, .open])
    #expect(split.folded.map(\.id) == [url(1), url(4), url(6)])
    #expect(split.folded.map(\.state) == [.merged, .closed, .merged])

    let live = PullRequestRows.split(PullRequestRows.rows([pr(url(1), state: .open), pr(url(2))], timeZone: utc))
    #expect(live.shown.count == 2)
    #expect(live.folded.isEmpty, "no settled PR, no folded row")

    let settled = PullRequestRows.split(
      PullRequestRows.rows([pr(url(1), state: .merged), pr(url(2), state: .closed)], timeZone: utc))
    #expect(settled.shown.isEmpty)
    #expect(settled.folded.count == 2, "all settled: the section keeps only the folded row")
  }

  @Test("folded row copy: the words, the count in brackets and the spoken label")
  func foldedCopy() {
    #expect(UICopy.pullRequestsSettled == "Scalone i zamknięte")
    #expect(UICopy.pullRequestsSettledCount(3) == "(3)")
    #expect(UICopy.pullRequestsSettledSpoken(3) == "Scalone i zamknięte: 3")
  }

  @Test("state word goes to the label, not to the grey line; no state means no label", arguments: [
    (PullRequestState.merged, "scalony"), (.closed, "zamknięty"), (.open, "otwarty"), (.draft, "draft"),
  ])
  func stateLabel(_ state: PullRequestState, _ word: String) {
    let twoHours = ServerTime.parse("2026-10-16T14:10:00Z")!
    let titled = PullRequestRows.rows([pr(export, state: state)], timeZone: utc)[0]
    #expect(titled.stateWord == word)
    #expect(titled.status(now: twoHours) == ["acme/widget#42", "2\u{00A0}h\u{00A0}temu", "12:05"])
    #expect(titled.heading == "Dodaj eksport CSV", "the first line does not change")
    #expect(titled.link == URL(string: export), "the link does not change")
    let bare = PullRequestRows.rows([pr(export, title: nil, state: state)], timeZone: utc)[0]
    #expect(bare.stateWord == word)
    #expect(bare.status(now: twoHours) == ["2\u{00A0}h\u{00A0}temu", "12:05"])
    let unknown = PullRequestRows.rows([pr(export)], timeZone: utc)[0]
    #expect(unknown.state == nil)
    #expect(unknown.stateWord == nil)
    #expect(unknown.status(now: twoHours) == ["acme/widget#42", "2\u{00A0}h\u{00A0}temu", "12:05"])
  }

  @Test("VoiceOver hears the state after the title; no state reads as before", arguments: [
    (PullRequestState.merged, "scalony"), (.closed, "zamknięty"), (.open, "otwarty"), (.draft, "draft"),
  ])
  func stateSpoken(_ state: PullRequestState, _ word: String) {
    let twoHours = ServerTime.parse("2026-10-16T14:10:00Z")!
    let titled = PullRequestRows.rows([pr(export, state: state)], timeZone: utc)[0]
    #expect(
      titled.spoken(now: twoHours)
        == "Pull request acme/widget#42, Dodaj eksport CSV, \(word), utworzony 2 godziny temu, o 12:05. "
        + "Otwiera przeglądarkę.")
    let bare = PullRequestRows.rows([pr(export, title: nil, state: state)], timeZone: utc)[0]
    #expect(
      bare.spoken(now: twoHours)
        == "Pull request acme/widget#42, \(word), utworzony 2 godziny temu, o 12:05. Otwiera przeglądarkę.")
    let unknown = PullRequestRows.rows([pr(export)], timeZone: utc)[0]
    #expect(
      unknown.spoken(now: twoHours)
        == "Pull request acme/widget#42, Dodaj eksport CSV, utworzony 2 godziny temu, o 12:05. Otwiera przeglądarkę.")
  }

  @Test("state words in every catalog language")
  func stateWords() {
    #expect(UICopy.pullRequestState(.open) == "otwarty")
    #expect(UICopy.pullRequestState(.merged) == "scalony")
    #expect(UICopy.pullRequestState(.closed) == "zamknięty")
    #expect(UICopy.pullRequestState(.open, language: .en) == "open")
    #expect(UICopy.pullRequestState(.merged, language: .en) == "merged")
    #expect(UICopy.pullRequestState(.closed, language: .en) == "closed")
  }

  @Test("czas, który nie jest czasem, nie daje ani godziny, ani „temu”; wiersz zostaje")
  func timeless() {
    let rows = PullRequestRows.rows(
      [SessionPullRequest(url: export, repo: "acme/widget", number: 42, createdAt: "wczoraj")], timeZone: utc)
    #expect(rows.count == 1)
    #expect(rows[0].at == nil && rows[0].clock == nil && rows[0].day == nil)
    #expect(rows[0].status(now: Sample.now).isEmpty)
    #expect(rows[0].spoken(now: Sample.now) == "Pull request acme/widget#42. Otwiera przeglądarkę.")
  }

  @Test("powtórzony adres zostaje raz, pierwszy — adres jest tożsamością wiersza")
  func duplicateUrl() {
    let rows = PullRequestRows.rows([pr(export, title: "Nowszy"), pr(export, title: "Starszy"), pr(fix)], timeZone: utc)
    #expect(rows.map(\.id) == [export, fix])
    #expect(rows[0].title == "Nowszy")
  }

  @Test("adres spoza gramatyki serwera: wiersz bez linku, czytnik nie słyszy o przeglądarce", arguments: [
    "https://github.com/acme/widget/pull/42/files",  // dalszy segment
    "https://github.com/acme/widget/pull/42/",  // ukośnik na końcu
    "https://github.com/acme/widget/pull/42?x=1",  // zapytanie
    "https://github.com/acme/widget/pull/42#a",  // fragment
    "https://github.com/acme/widget/pull/new/feature",  // link `git push`, nie PR
    "https://github.com/acme/widget/pull/0",  // numer zero
    "https://github.com/acme/widget/pull/042",  // zero wiodące
    "https://github.com/acme/widget/pull/1234567890",  // ponad 9 cyfr
    "https://github.com/acme/widget/pull/",  // bez numeru
    "https://github.com/acme/widget/issues/42",  // zgłoszenie, nie PR
    "https://github.com/-acme/widget/pull/42",  // właściciel od łącznika
    "https://github.com/ac.me/widget/pull/42",  // kropka u właściciela
    "https://github.com/acme/../pull/42",  // repo `..`
    "https://github.com/acme/./pull/42",  // repo `.`
    "https://github.com/acme/wid get/pull/42",  // spacja
    "https://github.com/acme/widgęt/pull/42",  // litera spoza ASCII
    "https://github.com/acme/widget/pull/４２",  // cyfry pełnej szerokości
    "https://github.com/acme/widget/pull/42\u{0301}",  // znak łączący
    "https://github.com/acme/widget/pull/42\n",  // nowa linia na końcu
    " https://github.com/acme/widget/pull/42",  // spacja na początku
    "https://github.com:443/acme/widget/pull/42",  // port
    "https://user\u{40}github.com/acme/widget/pull/42",  // dane użytkownika (`@` jako ucieczka: strażnik e-maili)
    "https://github.com.example.com/acme/widget/pull/42",  // inny host z prefiksem
    "https://GitHub.com/acme/widget/pull/42",  // inna pisownia hosta
    "https://gitlab.com/acme/widget/pull/42",  // inny host
    "http://github.com/acme/widget/pull/42",  // http
    "javascript:alert(1)",
    "",
  ])
  func rejectedUrl(_ raw: String) {
    #expect(PullRequestRows.link(raw) == nil)
    let row = PullRequestRows.rows([pr(raw)], timeZone: utc)[0]
    #expect(row.link == nil)
    #expect(row.id == raw, "tożsamość wiersza to surowy adres")
    #expect(!row.spoken(now: Sample.now).contains("przeglądark"))
  }

  @Test("adres w gramatyce: litery obu wielkości, cyfry, łącznik, kropka i podkreślenie w repo, numer do 9 cyfr")
  func acceptedUrl() {
    for raw in [
      export, fix, "https://github.com/a/b/pull/1", "https://github.com/Acme-Co/My_Repo.js/pull/999999999",
      "https://github.com/\(String(repeating: "a", count: 39))/r/pull/5",
    ] {
      #expect(PullRequestRows.link(raw)?.absoluteString == raw, "\(raw)")
    }
    #expect(PullRequestRows.link("https://github.com/\(String(repeating: "a", count: 40))/r/pull/5") == nil)
  }
}
