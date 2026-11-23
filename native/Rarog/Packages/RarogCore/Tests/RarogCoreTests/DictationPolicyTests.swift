@testable import RarogCore
import Testing

// Trasa dyktowania i opcja Soniox na ekranie wyboru: każde przejście tabeli
// (wybór × stan Soniox na serwerze × flaga builda) z wynikiem wpisanym wprost, nie wyliczonym.

@Suite("dyktowanie: trasa i opcja Soniox")
struct DictationPolicyTests {
  private typealias Row = (choice: DictationChoice?, server: SonioxServerState, allowed: Bool, route: DictationRoute)

  /// Pełna tabela: 3 wybory × 3 stany serwera × 2 wartości flagi.
  private let table: [Row] = [
    // 1. Brak wyboru → ekran, niezależnie od serwera i flagi.
    (nil, .unknown, true, .ask(.noChoice)),
    (nil, .available, true, .ask(.noChoice)),
    (nil, .unavailable, true, .ask(.noChoice)),
    (nil, .unknown, false, .ask(.noChoice)),
    (nil, .available, false, .ask(.noChoice)),
    (nil, .unavailable, false, .ask(.noChoice)),
    // 2. Systemowe → systemowe, także przy fladze NO i serwerze bez klucza.
    (.system, .unknown, true, .system),
    (.system, .available, true, .system),
    (.system, .unavailable, true, .system),
    (.system, .unknown, false, .system),
    (.system, .available, false, .system),
    (.system, .unavailable, false, .system),
    // 3. Soniox przy kluczu na serwerze.
    (.soniox, .available, true, .soniox),
    // 4. Sonda jeszcze nie odpowiedziała: Soniox, mint rozstrzyga.
    (.soniox, .unknown, true, .soniox),
    // 5. Serwer bez Soniox: ekran, bez przejścia na systemowe.
    (.soniox, .unavailable, true, .ask(.sonioxUnavailable)),
    // 6. Flaga NO: ekran, bez przejścia na systemowe.
    (.soniox, .unknown, false, .ask(.sonioxUnavailable)),
    (.soniox, .available, false, .ask(.sonioxUnavailable)),
    (.soniox, .unavailable, false, .ask(.sonioxUnavailable)),
  ]

  @Test("trasa: każda kombinacja wyboru, stanu serwera i flagi")
  func route() {
    #expect(table.count == 18)
    for row in table {
      let route = DictationPolicy.route(choice: row.choice, server: row.server, sonioxAllowed: row.allowed)
      #expect(route == row.route, "wybór \(String(describing: row.choice)), serwer \(row.server), flaga \(row.allowed)")
    }
  }

  @Test("apka nigdy sama nie przełącza dostawcy: wybór Soniox nie daje trasy systemowej, wybór systemowy nie daje Soniox")
  func neverSwitchesProvider() {
    for server in [SonioxServerState.unknown, .available, .unavailable] {
      for allowed in [true, false] {
        #expect(DictationPolicy.route(choice: .soniox, server: server, sonioxAllowed: allowed) != .system)
        #expect(DictationPolicy.route(choice: .system, server: server, sonioxAllowed: allowed) != .soniox)
      }
    }
  }

  @Test("opcja Soniox na ekranie: flaga NO = hidden; unknown = checking; unavailable; available")
  func sonioxOption() {
    let cases: [(SonioxServerState, Bool, SonioxOption)] = [
      (.unknown, false, .hidden),
      (.available, false, .hidden),
      (.unavailable, false, .hidden),
      (.unknown, true, .checking),
      (.unavailable, true, .unavailable),
      (.available, true, .available),
    ]
    for (server, allowed, expected) in cases {
      #expect(DictationPolicy.sonioxOption(server: server, sonioxAllowed: allowed) == expected, "\(server), \(allowed)")
    }
  }
}
