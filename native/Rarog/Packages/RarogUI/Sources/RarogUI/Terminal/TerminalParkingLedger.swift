import Foundation
import RarogContract

// Księga parkingu ekranów terminala: ekran zdjęty z taba albo
// z okna Cmd+F/Cmd+G czeka do 2 min z żywym gniazdem, a powrót bierze go z powrotem zamiast budować nowy (nowy
// ekran to `POST`, nowe TCP i TLS, upgrade i okno pierwszego ekranu). Księga trzyma same klucze, chwile i numery
// wpisów — ekrany trzyma `TerminalScreenParking` (UIKit). Czysta logika bez zegara: chwilę podaje wołający, testy
// liczą na macOS (`TerminalParkingLedgerTests`). Właściciel: terminal.

/// Kto stoi w parkingu, od kiedy i w jakiej kolejności (najstarszy pierwszy).
public struct TerminalParkingLedger: Sendable, Equatable {
  /// Pod czym ekran czeka: tab pod id terminala, okno pod katalogiem (po `ProjectPath.normalized`) i rolą.
  public enum Key: Hashable, Sendable {
    case terminal(String)
    case popup(cwd: String, role: TerminalRole)
  }

  /// Jeden zaparkowany ekran. Numer rośnie z każdym `park` — stary zegar wygaszenia wpisu, który wyszedł
  /// i wrócił, nie trafia w nowy wpis pod tym samym kluczem.
  public struct Entry: Sendable, Equatable {
    public let key: Key
    public let number: Int
    public let parkedAt: ContinuousClock.Instant
  }

  /// Jak długo ekran czeka: tyle co karencja strumienia serwera, `TERM_GRACE_MS`.
  public static let lifetime: Duration = .seconds(120)
  /// Najwięcej ekranów naraz; nadmiar wypycha najstarszy.
  public static let capacity = 4

  /// Wpisy od najstarszego (kolejność LRU: wpis wychodzi przy `take`, a wraca na koniec przy `park`).
  public private(set) var entries: [Entry] = []
  private var lastNumber = 0

  public init() {}

  /// Ekran wchodzi pod `key`. Wypchnięte: starszy ekran pod tym samym kluczem i najstarsze ponad ``capacity``
  /// — wołający je zamyka.
  public mutating func park(_ key: Key, now: ContinuousClock.Instant) -> (entry: Entry, evicted: [Entry]) {
    var evicted = entries.filter { $0.key == key }
    entries.removeAll { $0.key == key }
    lastNumber += 1
    let entry = Entry(key: key, number: lastNumber, parkedAt: now)
    entries.append(entry)
    while entries.count > Self.capacity { evicted.append(entries.removeFirst()) }
    return (entry, evicted)
  }

  /// Wpis pod `key`, jeśli jest i nie wygasł — wychodzi z księgi. Wpis wygasły zostaje dla ``expired(now:)``.
  public mutating func take(_ key: Key, now: ContinuousClock.Instant) -> Entry? {
    guard let index = entries.firstIndex(where: { $0.key == key }), !Self.isExpired(entries[index], now: now) else {
      return nil
    }
    return entries.remove(at: index)
  }

  /// Wpisy wygasłe — wychodzą z księgi, wołający je zamyka.
  public mutating func expired(now: ContinuousClock.Instant) -> [Entry] {
    let gone = entries.filter { Self.isExpired($0, now: now) }
    entries.removeAll { Self.isExpired($0, now: now) }
    return gone
  }

  /// Wpis o numerze `number`, jeśli wciąż jest (zegar wygaszenia tego wpisu, ponowne parkowanie tego samego
  /// ekranu). Po `take` i nowym `park` numer jest inny, więc stary zegar niczego nie zdejmuje.
  public mutating func drop(number: Int) -> Entry? {
    guard let index = entries.firstIndex(where: { $0.number == number }) else { return nil }
    return entries.remove(at: index)
  }

  /// Wszystko naraz (tło, wylogowanie, ostrzeżenie o pamięci).
  public mutating func removeAll() -> [Entry] {
    defer { entries.removeAll() }
    return entries
  }

  static func isExpired(_ entry: Entry, now: ContinuousClock.Instant) -> Bool {
    now - entry.parkedAt >= lifetime
  }
}
