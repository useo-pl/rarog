import Foundation
import RarogContract
@testable import RarogUI
import Testing

// Księga parkingu ekranów terminala: zajęty klucz, sufit 4,
// wygaśnięcie po 2 min i numer wpisu przeciw staremu zegarowi. Ekrany i ich osadzanie testuje UIKit
// (`TerminalParkingTests`). Właściciel: terminal.

@Suite("terminal: księga parkingu ekranów")
struct TerminalParkingLedgerTests {
  private let t0 = ContinuousClock.now

  private func at(seconds: Int) -> ContinuousClock.Instant { t0 + .seconds(seconds) }

  private static let tab = TerminalParkingLedger.Key.terminal("0123456789abcdef")
  private static let shell = TerminalParkingLedger.Key.popup(cwd: "/Users/demo/Projects/rarog", role: .popup)

  @Test("stałe z decyzji użytkownika: 2 min postoju, najwyżej 4 ekrany")
  func constants() {
    #expect(TerminalParkingLedger.lifetime == .seconds(120))
    #expect(TerminalParkingLedger.capacity == 4)
  }

  @Test("take: wpis pod kluczem wychodzi raz; inny klucz (tab vs okno, inna rola) nie pasuje")
  func takeOnce() {
    var ledger = TerminalParkingLedger()
    let parked = ledger.park(Self.tab, now: at(seconds: 0))
    #expect(parked.evicted.isEmpty)
    #expect(ledger.take(.popup(cwd: "/Users/demo/Projects/rarog", role: .lazygit), now: at(seconds: 1)) == nil)
    #expect(ledger.take(Self.shell, now: at(seconds: 1)) == nil)
    #expect(ledger.take(Self.tab, now: at(seconds: 30)) == parked.entry)
    #expect(ledger.take(Self.tab, now: at(seconds: 31)) == nil, "drugi raz już go nie ma")
    #expect(ledger.entries.isEmpty)
  }

  @Test("zajęty klucz: nowy ekran wypycha starszy pod tym samym kluczem")
  func occupiedKey() {
    var ledger = TerminalParkingLedger()
    let old = ledger.park(Self.shell, now: at(seconds: 0)).entry
    _ = ledger.park(Self.tab, now: at(seconds: 1))
    let second = ledger.park(Self.shell, now: at(seconds: 2))
    #expect(second.evicted == [old])
    #expect(ledger.entries.map(\.key) == [Self.tab, Self.shell])
    #expect(ledger.take(Self.shell, now: at(seconds: 3)) == second.entry)
  }

  @Test("sufit 4: piąty ekran wypycha najstarszy; wyjście i powrót przenosi wpis na koniec kolejki")
  func capacity() {
    var ledger = TerminalParkingLedger()
    let keys = (1...5).map { TerminalParkingLedger.Key.terminal(String(format: "%016x", $0)) }
    for (index, key) in keys.prefix(4).enumerated() {
      #expect(ledger.park(key, now: at(seconds: index)).evicted.isEmpty)
    }
    // Pierwszy wraca na chwilę i znowu wychodzi: teraz jest najmłodszy.
    #expect(ledger.take(keys[0], now: at(seconds: 10)) != nil)
    _ = ledger.park(keys[0], now: at(seconds: 11))
    let fifth = ledger.park(keys[4], now: at(seconds: 12))
    #expect(fifth.evicted.map(\.key) == [keys[1]], "najstarszy w kolejce, nie najstarszy z kluczy")
    #expect(ledger.entries.map(\.key) == [keys[2], keys[3], keys[0], keys[4]])
  }

  @Test("wygaśnięcie: po 2 min take nic nie daje, expired zdejmuje wpis; przed czasem wpis stoi")
  func expiry() {
    var ledger = TerminalParkingLedger()
    let entry = ledger.park(Self.tab, now: at(seconds: 0)).entry
    _ = ledger.park(Self.shell, now: at(seconds: 60))
    #expect(ledger.expired(now: at(seconds: 119)).isEmpty)
    #expect(ledger.take(Self.tab, now: at(seconds: 120)) == nil, "wygasły nie wychodzi")
    #expect(ledger.entries.count == 2, "wygasły czeka na expired")
    #expect(ledger.expired(now: at(seconds: 120)) == [entry])
    #expect(ledger.entries.map(\.key) == [Self.shell])
  }

  @Test("numer wpisu: stary zegar po take i ponownym park niczego nie zdejmuje")
  func staleTimer() {
    var ledger = TerminalParkingLedger()
    let first = ledger.park(Self.tab, now: at(seconds: 0)).entry
    #expect(ledger.take(Self.tab, now: at(seconds: 60)) == first)
    let second = ledger.park(Self.tab, now: at(seconds: 90)).entry
    #expect(second.number != first.number)
    #expect(ledger.drop(number: first.number) == nil, "zegar pierwszego wpisu dzwoni w 120 s")
    #expect(ledger.expired(now: at(seconds: 120)).isEmpty)
    #expect(ledger.entries == [second])
    #expect(ledger.drop(number: second.number) == second, "zegar drugiego wpisu go zdejmuje")
    #expect(ledger.entries.isEmpty)
  }

  @Test("removeAll: wszystko naraz, księga pusta")
  func removeAll() {
    var ledger = TerminalParkingLedger()
    let a = ledger.park(Self.tab, now: at(seconds: 0)).entry
    let b = ledger.park(Self.shell, now: at(seconds: 1)).entry
    #expect(ledger.removeAll() == [a, b])
    #expect(ledger.entries.isEmpty)
  }
}
