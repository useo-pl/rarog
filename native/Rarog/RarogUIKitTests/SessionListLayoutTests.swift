import RarogContract
@testable import RarogCore
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// Geometria listy sesji na rzeczywistych widokach SwiftUI (poprawki wyglądu listy).
@MainActor
final class SessionListLayoutTests: XCTestCase {
  /// Pracująca karta bez aktywności nie ma pustej linii etapu: jest tak wysoka jak karta bezczynna. Zwykłe narzędzie
  /// linii nie daje (inaczej wiersz skakałby wysokością przy każdym kroku agenta), a delegacja dokłada wiersz.
  func testWorkingRowWithoutActivityIsAsTallAsIdleRow() throws {
    let working = SessionRowModel(try Self.summary("running"), ordinal: nil)
    let idle = SessionRowModel(try Self.summary("done"), ordinal: nil)
    let reading = SessionRowModel(
      try Self.summary("running", extra: #""activity":{"kind":"tool","toolName":"Read","summary":"notes.ts"}"#),
      ordinal: nil)
    let delegating = SessionRowModel(
      try Self.summary("running", extra: #""activity":{"kind":"tool","delegation":"agents","summary":"Przegląd"}"#),
      ordinal: nil)
    XCTAssertEqual(Self.height(working), Self.height(idle), accuracy: 0.5, "bez przerwy pod pracującym agentem")
    XCTAssertEqual(Self.height(reading), Self.height(working), accuracy: 0.5, "zwykłe narzędzie: wiersz stoi")
    XCTAssertGreaterThan(Self.height(delegating), Self.height(working) + 8, "linia delegacji to osobny wiersz")
  }

  static func height(_ row: SessionRowModel) -> CGFloat {
    let host = UIHostingController(rootView: SessionRow(row: row, selected: false))
    return host.sizeThatFits(in: CGSize(width: 300, height: 1_000)).height
  }

  static func summary(_ state: String, extra: String = "") throws -> SessionSummary {
    let json = """
      {"id":"s1","cwd":"/Users/demo/Projects/willow","title":"willow","label":"zapis notatek","state":"\(state)",
       "stateSince":"2026-10-06T10:00:00.000Z","createdAt":"2026-10-06T09:00:00.000Z",
       "lastActivityAt":"2026-10-06T10:00:00.000Z"\(extra.isEmpty ? "" : "," + extra)}
      """
    return try JSONDecoder().decode(SessionSummary.self, from: Data(json.utf8))
  }
}
