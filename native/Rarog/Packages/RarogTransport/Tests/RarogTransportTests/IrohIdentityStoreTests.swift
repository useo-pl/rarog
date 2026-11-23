import Foundation
@testable import RarogTransport
import Security
import Synchronization
import Testing

// Wpis tożsamości iroh apki: klucz tajny endpointu (32 B) w osobnym wpisie Keychaina, zapisywany raz
// i nigdy nie przepisywany. Każda porażka (Keychain zablokowany, odczyt odrzucony, wpis nieczytelny, zapis odrzucony)
// daje „iroh niedostępne”, nigdy klucz tylko w pamięci ani cichy nowy klucz w miejsce istniejącego wpisu.

@Suite("tożsamość iroh apki w Keychainie")
struct IrohIdentityStoreTests {
  static let now = Date(timeIntervalSince1970: 1_794_132_000)  // 2026-11-08T10:00:00Z
  static let secret = Data(repeating: 7, count: 32)

  /// Wpis v1 tak, jak go zapisuje magazyn (sekret z `secret`, data z `now`).
  static let golden = Data(
    #"{"createdAt":"2026-11-08T10:00:00Z","version":1,"secret":"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="}"#.utf8)

  /// Generator kolejnych sekretów: 1, 2, 3… w każdym bajcie — test widzi, który klucz wygrał.
  final class Numbered: Sendable {
    private let next = Mutex(UInt8(1))
    var calls: Int { Int(next.withLock { $0 }) - 1 }
    func make() -> Data? {
      next.withLock { value in
        defer { value += 1 }
        return Data(repeating: value, count: 32)
      }
    }
  }

  static func store(_ keychain: MemoryIrohIdentityKeychain, _ random: Numbered = Numbered()) -> IrohIdentityStore {
    IrohIdentityStore(keychain: keychain, now: { Self.now }, random: { random.make() })
  }

  static func key(_ read: IrohIdentityRead) -> Data? {
    if case let .ready(identity) = read { return identity.secretKey }
    return nil
  }

  @Test("brak wpisu: klucz 32 B wygenerowany i zapisany przed zwrotem; drugi odczyt i nowy magazyn — ten sam sekret")
  func generatesOnce() async throws {
    let keychain = MemoryIrohIdentityKeychain()
    let random = Numbered()
    let store = Self.store(keychain, random)
    let first = try #require(Self.key(await store.identity()))
    #expect(first.count == 32 && keychain.snapshot.writes == 1)
    let saved = try #require(keychain.snapshot.data)
    #expect(IrohIdentityStored.decode(saved)?.secretKey == first, "w Keychainie ten sam klucz, który wrócił")
    #expect(Self.key(await store.identity()) == first)
    #expect(Self.key(await Self.store(keychain, random).identity()) == first, "nowy proces czyta zapisany")
    #expect(keychain.snapshot.writes == 1 && random.calls == 1)
  }

  @Test("Keychain zablokowany: niedostępne, nic nie zapisane; po odblokowaniu następna próba daje klucz")
  func lockedUnavailable() async throws {
    let keychain = MemoryIrohIdentityKeychain(.init(locked: true))
    let random = Numbered()
    let store = Self.store(keychain, random)
    #expect(await store.identity() == .unavailable(.locked))
    #expect(keychain.snapshot.data == nil && keychain.snapshot.writes == 0 && random.calls == 0)
    keychain.update { $0.locked = false }
    let secret = try #require(Self.key(await store.identity()))
    #expect(keychain.snapshot.data.flatMap(IrohIdentityStored.decode)?.secretKey == secret)
  }

  @Test("zablokowany przy istniejącym wpisie: niedostępne, wpis nietknięty")
  func lockedKeepsEntry() async {
    let keychain = MemoryIrohIdentityKeychain(.init(data: Self.golden, locked: true))
    #expect(await Self.store(keychain).identity() == .unavailable(.locked))
    #expect(keychain.snapshot.data == Self.golden && keychain.snapshot.writes == 0)
  }

  @Test("odczyt odrzucony (OSStatus): niedostępne z kodem, bez nowego klucza")
  func readFailure() async {
    let keychain = MemoryIrohIdentityKeychain(.init(readFailure: -34_018))
    let random = Numbered()
    #expect(await Self.store(keychain, random).identity() == .unavailable(.failed(-34_018)))
    #expect(keychain.snapshot.writes == 0 && random.calls == 0)
  }

  @Test("wpis nieczytelny (sekret 31 i 33 B, version 2, zły base64, nie JSON): niedostępne, wpis nietknięty")
  func unreadableNeverOverwritten() async {
    let entries = [
      #"{"version":1,"secret":"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBw==","createdAt":"2026-11-08T10:00:00Z"}"#,
      #"{"version":1,"secret":"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH","createdAt":"2026-11-08T10:00:00Z"}"#,
      #"{"version":2,"secret":"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=","createdAt":"2026-11-08T10:00:00Z"}"#,
      #"{"version":1,"secret":"nie base64!","createdAt":"2026-11-08T10:00:00Z"}"#,
      #"{"secret":"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="}"#,
      "nie JSON",
    ]
    for entry in entries {
      let data = Data(entry.utf8)
      let keychain = MemoryIrohIdentityKeychain(.init(data: data))
      let random = Numbered()
      #expect(await Self.store(keychain, random).identity() == .unavailable(.unreadable), "\(entry)")
      #expect(keychain.snapshot.data == data && keychain.snapshot.writes == 0 && random.calls == 0, "\(entry)")
    }
  }

  @Test("zapis odrzucony: niedostępne, klucz nie zostaje w pamięci; po naprawie nowy klucz zapisany przed użyciem")
  func saveFailureNeverInMemory() async throws {
    let keychain = MemoryIrohIdentityKeychain(.init(addFailure: -25_308))
    let random = Numbered()
    let store = Self.store(keychain, random)
    #expect(await store.identity() == .unavailable(.notSaved(-25_308)))
    #expect(keychain.snapshot.data == nil && keychain.snapshot.writes == 0)
    keychain.update { $0.addFailure = nil }
    let secret = try #require(Self.key(await store.identity()))
    #expect(secret != Data(repeating: 1, count: 32), "niezapisany klucz pierwszej próby nie wraca")
    #expect(keychain.snapshot.data.flatMap(IrohIdentityStored.decode)?.secretKey == secret)
  }

  @Test("generator odmawia albo daje inną długość: niedostępne, nic nie zapisane")
  func randomFailure() async {
    for random in [{ nil }, { Data(repeating: 1, count: 31) }] as [@Sendable () -> Data?] {
      let keychain = MemoryIrohIdentityKeychain()
      let store = IrohIdentityStore(keychain: keychain, now: { Self.now }, random: random)
      #expect(await store.identity() == .unavailable(.noRandom))
      #expect(keychain.snapshot.data == nil && keychain.snapshot.writes == 0)
    }
  }

  @Test("równoczesne odczyty bez wpisu na jednym magazynie: jeden zapis, ten sam sekret u wszystkich")
  func concurrentReadsOneWrite() async throws {
    let keychain = MemoryIrohIdentityKeychain()
    let random = Numbered()
    let store = Self.store(keychain, random)
    let secrets = await withTaskGroup(of: Data?.self) { group in
      for _ in 0..<20 { group.addTask { Self.key(await store.identity()) } }
      return await group.reduce(into: [Data?]()) { $0.append($1) }
    }
    #expect(secrets.count == 20 && Set(secrets).count == 1 && secrets.first! != nil)
    #expect(keychain.snapshot.writes == 1 && random.calls == 1)
  }

  @Test("wyścig z drugim zapisującym (errSecDuplicateItem): oba czytają brak, jeden zapis, przegrany dostaje zapisany")
  func duplicateLoserReadsSaved() async throws {
    // Dwa magazyny (dwa procesy: apka i jej rozszerzenie, albo dwa starty) na jednym Keychainie; oba odczyty widzą
    // brak wpisu, zanim którykolwiek zapisze.
    let keychain = MemoryIrohIdentityKeychain(.init(staleReads: 2))
    let random = Numbered()
    let a = Self.store(keychain, random)
    let b = Self.store(keychain, random)
    async let first = a.identity()
    async let second = b.identity()
    let (x, y) = await (first, second)
    let secret = try #require(Self.key(x))
    #expect(Self.key(y) == secret)
    #expect(keychain.snapshot.writes == 1 && keychain.snapshot.duplicates == 1 && random.calls == 2)
    #expect(keychain.snapshot.data.flatMap(IrohIdentityStored.decode)?.secretKey == secret)
  }

  @Test("złoty wpis v1: sekret i data; nieznane klucze pominięte; zepsuta data nie blokuje klucza")
  func goldenEntry() async throws {
    let identity = try #require(IrohIdentityStored.decode(Self.golden))
    #expect(identity.secretKey == Self.secret && identity.createdAt == Self.now)
    var json = try #require(try JSONSerialization.jsonObject(with: Self.golden) as? [String: Any])
    json["relayAccess"] = ["stan": 1]
    #expect(IrohIdentityStored.decode(try JSONSerialization.data(withJSONObject: json))?.secretKey == Self.secret)
    json["createdAt"] = "wczoraj"
    let undated = try #require(IrohIdentityStored.decode(try JSONSerialization.data(withJSONObject: json)))
    #expect(undated.secretKey == Self.secret && undated.createdAt == nil)
    let keychain = MemoryIrohIdentityKeychain(.init(data: Self.golden))
    #expect(Self.key(await Self.store(keychain).identity()) == Self.secret && keychain.snapshot.writes == 0)
  }

  @Test("zapis: JSON v1 z sekretem base64 32 B i datą ISO 8601, bez innych kluczy")
  func encodedShape() async throws {
    let keychain = MemoryIrohIdentityKeychain()
    let secret = try #require(Self.key(await Self.store(keychain).identity()))
    let data = try #require(keychain.snapshot.data)
    let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(Set(json.keys) == ["version", "secret", "createdAt"])
    #expect(json["version"] as? Int == 1 && json["createdAt"] as? String == "2026-11-08T10:00:00Z")
    #expect((json["secret"] as? String).flatMap { Data(base64Encoded: $0) } == secret)
  }

  @Test("wpis systemowy: usługa ai.rarog.app.iroh, konto device, po pierwszym odblokowaniu, bez synchronizacji")
  func systemAttributes() {
    let query = SystemIrohIdentityKeychain(group: "TEAM.ai.rarog.app").addQuery(Data([1]))
    #expect(query[kSecAttrService as String] as? String == "ai.rarog.app.iroh")
    #expect(query[kSecAttrAccount as String] as? String == "device")
    #expect(query[kSecAttrAccessGroup as String] as? String == "TEAM.ai.rarog.app")
    #expect(query[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
    #expect(query[kSecAttrSynchronizable as String] as? Bool == false)
    #expect(query[kSecUseDataProtectionKeychain as String] as? Bool == true)
    #expect(query[kSecValueData as String] as? Data == Data([1]))
  }

  @Test("opis tożsamości i powodu bez sekretu; kasowanie (reset testów UI) zdejmuje wpis i pamięć")
  func descriptionAndDelete() async throws {
    let keychain = MemoryIrohIdentityKeychain(.init(data: Self.golden))
    let random = Numbered()
    let store = Self.store(keychain, random)
    let read = await store.identity()
    #expect(!String(describing: read).contains("BwcHBwcH") && !String(reflecting: read).contains("BwcHBwcH"))
    #expect(!String(describing: read).contains("7, 7"))
    #expect(IrohIdentityUnavailable.failed(-34_018).description.contains("-34018"))
    await store.delete()
    #expect(keychain.snapshot.data == nil)
    let fresh = try #require(Self.key(await store.identity()))
    #expect(fresh != Self.secret && keychain.snapshot.writes == 1)
  }
}
