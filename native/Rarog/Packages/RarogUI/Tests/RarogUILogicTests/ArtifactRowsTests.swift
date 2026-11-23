import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Prawy panel sesji na iPadzie: sekcja ARTEFAKTY (`docs/artifacts.md`) — wiersze z `SessionSummary.artifacts`
// w kolejności serwera, czas w gramatyce „Skończonych”, usunięty bez przycisku i adres otwierany wyłącznie
// w gramatyce serwera.

@Suite("prawy panel: ARTEFAKTY")
struct ArtifactRowsTests {
  private let utc = TimeZone(identifier: "UTC")!
  private let report = "https://claude.ai/artifact/RaportTygodniowy7Kq2Wn"
  private let draft = "https://claude.ai/artifact/SzkicPrezentacji4Hm9Zx"

  /// Lista z drutu: tak, jak przychodzi w podsumowaniu sesji.
  private func wire(_ items: String) -> [SessionArtifact] {
    Sample.session(extra: #""artifacts":[\#(items)]"#).artifacts ?? []
  }

  private func artifact(_ url: String, gone: Bool = false) -> SessionArtifact {
    SessionArtifact(url: url, title: "Tytuł", publishedAt: "2026-10-16T12:05:00Z", gone: gone)
  }

  @Test("kolejność z serwera (najnowsza publikacja pierwsza), tytuł, godzina i dzień w strefie urządzenia")
  func orderAndFields() {
    let rows = ArtifactRows.rows(
      wire(#"""
        {"url":"\#(report)","title":"Raport tygodniowy","publishedAt":"2026-10-16T12:05:00.000Z"},
        {"url":"\#(draft)","title":"Szkic prezentacji","publishedAt":"2026-10-15T10:00:00.000Z","gone":true}
        """#),
      timeZone: utc)
    #expect(rows.map(\.id) == [report, draft], "kolejność serwera, bez ponownego sortowania")
    #expect(rows.map(\.title) == ["Raport tygodniowy", "Szkic prezentacji"])
    #expect(rows.map(\.gone) == [false, true])
    #expect(rows[0].url == URL(string: report) && rows[0].link == URL(string: report))
    #expect(rows[0].clock == "12:05" && rows[0].day == "16 paź")
    #expect(rows[1].clock == "10:00" && rows[1].day == "15 paź")
    // Strefa urządzenia, nie serwera.
    let warsaw = ArtifactRows.rows([artifact(report)], timeZone: TimeZone(identifier: "Europe/Warsaw")!)
    #expect(warsaw[0].clock == "14:05")
    #expect(ArtifactRows.rows([], timeZone: utc).isEmpty, "brak artefaktów = brak sekcji")
    // Kolejność serwera także wtedy, gdy czasy jej przeczą: apka nie sortuje.
    let reversed = ArtifactRows.rows(
      [SessionArtifact(url: draft, title: "A", publishedAt: "2026-10-01T00:00:00Z"), artifact(report)], timeZone: utc)
    #expect(reversed.map(\.id) == [draft, report])
  }

  @Test("czas jak w „Skończonych”: ile temu i godzina, od doby dzień zamiast godziny")
  func timeLine() {
    let row = ArtifactRows.rows([artifact(report)], timeZone: utc)[0]
    let soon = ServerTime.parse("2026-10-16T12:05:20Z")!
    #expect(row.ago(now: soon) == "przed\u{00A0}chwilą" && row.stamp(now: soon) == "12:05")
    let twoHours = ServerTime.parse("2026-10-16T14:10:00Z")!
    #expect(row.ago(now: twoHours) == "2\u{00A0}h\u{00A0}temu" && row.stamp(now: twoHours) == "12:05")
    #expect(row.spoken(now: twoHours) == "Artefakt Tytuł, opublikowany 2 godziny temu, o 12:05. Otwiera przeglądarkę.")
    let sameDay = ServerTime.parse("2026-10-17T12:04:59Z")!
    #expect(row.ago(now: sameDay) == "23\u{00A0}h\u{00A0}temu" && row.stamp(now: sameDay) == "12:05")
    // Granica jest ta sama, od której „ile temu” liczy w dniach.
    let nextDay = ServerTime.parse("2026-10-17T12:05:00Z")!
    #expect(row.ago(now: nextDay) == "1\u{00A0}d\u{00A0}temu" && row.stamp(now: nextDay) == "16 paź")
    let later = ServerTime.parse("2026-10-19T18:00:00Z")!
    #expect(row.ago(now: later) == "3\u{00A0}d\u{00A0}temu" && row.stamp(now: later) == "16 paź")
    #expect(row.spoken(now: later) == "Artefakt Tytuł, opublikowany 3 dni temu, 16 paź. Otwiera przeglądarkę.")
  }

  @Test("czas, który nie jest czasem, nie daje ani godziny, ani „temu”; wiersz zostaje")
  func timeless() {
    let rows = ArtifactRows.rows([SessionArtifact(url: report, title: "Raport", publishedAt: "wczoraj")], timeZone: utc)
    #expect(rows.count == 1)
    #expect(rows[0].at == nil && rows[0].clock == nil && rows[0].day == nil)
    #expect(rows[0].ago(now: Sample.now) == nil && rows[0].stamp(now: Sample.now) == nil)
    #expect(rows[0].spoken(now: Sample.now) == "Artefakt Raport. Otwiera przeglądarkę.")
  }

  @Test("usunięty: wiersz zostaje wygaszony, bez linku, a czytnik słyszy „usunięty” i nie słyszy o przeglądarce")
  func gone() {
    let row = ArtifactRows.rows([artifact(draft, gone: true)], timeZone: utc)[0]
    #expect(row.gone && row.url == URL(string: draft), "adres w gramatyce zostaje w modelu")
    #expect(row.link == nil, "usunięty niczego nie otwiera")
    let now = ServerTime.parse("2026-10-17T13:05:00Z")!
    #expect(row.spoken(now: now) == "Artefakt Tytuł, usunięty, opublikowany 1 dzień temu, 16 paź.")
    #expect(
      UICopy.artifactSpoken(title: "Szkic", gone: true, opens: false, ago: nil, stamp: nil) == "Artefakt Szkic, usunięty.")
    #expect(UICopy.artifactGone == "usunięty" && UICopy.inspectorArtifactsTitle == "Artefakty")
  }

  @Test("powtórzony adres zostaje raz, pierwszy — adres jest tożsamością wiersza")
  func duplicateUrl() {
    let rows = ArtifactRows.rows(
      [
        SessionArtifact(url: report, title: "Nowszy", publishedAt: "2026-10-16T12:05:00Z"),
        SessionArtifact(url: report, title: "Starszy", publishedAt: "2026-10-16T10:00:00Z"),
        artifact(draft),
      ], timeZone: utc)
    #expect(rows.map(\.id) == [report, draft])
    #expect(rows[0].title == "Nowszy")
  }

  @Test("adres spoza gramatyki serwera: wiersz bez linku, czytnik nie słyszy o przeglądarce", arguments: [
    "https://claude.ai:443/artifact/Abc123",  // port
    "https://claude.ai/artifact/Abc123/wersja",  // dalszy segment
    "https://claude.ai/artifact/Abc123/",  // ukośnik na końcu
    "https://claude.ai/artifact/Abc123?x=1",  // zapytanie
    "https://claude.ai/artifact/Abc123#a",  // fragment
    "https://user@claude.ai/artifact/Abc123",  // dane użytkownika
    "https://user:haslo@claude.ai/artifact/Abc123",  // dane użytkownika z hasłem
    "https://claude.ai/artifact/",  // pusty identyfikator
    "https://claude.ai/artifact",  // bez identyfikatora
    "https://claude.ai.example.com/artifact/Abc123",  // inny host z prefiksem
    "https://example.com/artifact/Abc123",  // inny host
    "https://Claude.ai/artifact/Abc123",  // inna pisownia hosta
    "http://claude.ai/artifact/Abc123",  // http
    "https://claude.ai/artifact/Abc-123",  // znak spoza liter i cyfr
    "https://claude.ai/artifact/Abc%2F123",  // kodowanie procentowe
    "https://claude.ai/artifact/Ąbc123",  // litera spoza ASCII
    "https://claude.ai/artifact/Abc１２３",  // cyfry pełnej szerokości
    "https://claude.ai/artifact/Abc123\u{0301}",  // znak łączący (jeden znak z ostatnią literą)
    "https://claude.ai/artifact/Abc123\n",  // nowa linia na końcu
    " https://claude.ai/artifact/Abc123",  // spacja na początku
    "javascript:alert(1)",
    "",
  ])
  func rejectedUrl(_ raw: String) {
    #expect(ArtifactRows.link(raw) == nil)
    let row = ArtifactRows.rows([SessionArtifact(url: raw, title: "Obcy", publishedAt: "2026-10-16T12:05:00Z")])[0]
    #expect(row.url == nil && row.link == nil && !row.gone)
    #expect(row.id == raw, "tożsamość wiersza to surowy adres")
    #expect(!row.spoken(now: Sample.now).contains("przeglądark"))
  }

  @Test("adres w gramatyce: litery obu wielkości i cyfry ASCII, także jeden znak")
  func acceptedUrl() {
    for raw in [report, "https://claude.ai/artifact/a", "https://claude.ai/artifact/0", "https://claude.ai/artifact/AZaz09"] {
      #expect(ArtifactRows.link(raw)?.absoluteString == raw, "\(raw)")
    }
  }
}
