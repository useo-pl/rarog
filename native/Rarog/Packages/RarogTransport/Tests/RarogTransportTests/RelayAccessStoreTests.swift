import Foundation
@testable import RarogTransport
import RarogTransportTesting
import Security
import Synchronization
import Testing

// Stan klienta rejestru w Keychainie: konto `relay-access` (pamięć podręczna; treść spoza v1 to brak
// pamięci z linią logu) i konto `relay-optout` (rezygnacja; treść spoza v1 albo odczyt odrzucony to `unreadable`,
// wpis nietknięty, kasuje go tylko `deleteOptOut`). Oba wpisy w usłudze tożsamości iroh obok konta `device`, którego
// magazyn nie rusza. `swift test` nie ma uprawnienia do Keychaina z ochroną danych, więc wywołania `SecItem*` idą do
// pamięci, która sprawdza zapytania jak Keychain: usługa, konto, grupa.

@Suite("rejestr relaya iroh: pamięć i rezygnacja w Keychainie")
struct RelayAccessStoreTests {
  static let group = "TEAM.ai.rarog.app"
  static let appId = String(repeating: "ea", count: 32)
  static let registry = URL(string: "https://relay-auth.rarog.ai")!
  static let deviceEntry = Data(#"{"version":1,"secret":"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="}"#.utf8)

  static let fullCache = RelayAccessCache(
    appId: appId, registry: registry, registeredUntil: 1_801_476_000, lastSyncAt: 1_793_700_000,
    sponsored: [String(repeating: "a1", count: 32): 1_801_476_000], failures: 2, retryAt: 1_793_700_060,
    problem: .unreachable, lastTunnelCheckAt: 1_793_699_000)

  /// Keychain w pamięci: wpisy po (usługa, konto, grupa), zapis operacji, odmowy na żądanie.
  final class MemorySecItems: Sendable {
    struct Key: Hashable, Sendable {
      let service: String?
      let account: String?
      let group: String?
    }

    struct Item: Equatable, Sendable {
      var data: Data
      var accessible: String?
      var synchronizable: Bool?
      var dataProtection: Bool?
    }

    struct State: Sendable {
      var items: [Key: Item] = [:]
      var ops: [String] = []
      var copyStatus: OSStatus?
      var updateStatus: OSStatus?
      var addStatus: OSStatus?
      var deleteStatus: OSStatus?
    }

    let state = Mutex(State())

    init(device: Data? = RelayAccessStoreTests.deviceEntry) {
      if let device {
        state.withLock {
          $0.items[Key(service: "ai.rarog.app.iroh", account: "device", group: RelayAccessStoreTests.group)] =
            Item(data: device, accessible: nil, synchronizable: false, dataProtection: true)
        }
      }
    }

    var snapshot: State { state.withLock { $0 } }

    func item(_ account: String) -> Item? {
      state.withLock { $0.items[Key(service: "ai.rarog.app.iroh", account: account, group: RelayAccessStoreTests.group)] }
    }

    func set(_ account: String, _ data: Data) {
      state.withLock {
        $0.items[Key(service: "ai.rarog.app.iroh", account: account, group: RelayAccessStoreTests.group)] =
          Item(data: data, accessible: nil, synchronizable: false, dataProtection: true)
      }
    }

    static func key(_ query: [String: Any]) -> Key {
      Key(
        service: query[kSecAttrService as String] as? String, account: query[kSecAttrAccount as String] as? String,
        group: query[kSecAttrAccessGroup as String] as? String)
    }

    var calls: RelayKeychainCalls {
      RelayKeychainCalls(
        copy: { query in
          let key = Self.key(query)
          let one = query[kSecMatchLimit as String] as? String == kSecMatchLimitOne as String
            && query[kSecReturnData as String] as? Bool == true
          return self.state.withLock { state in
            state.ops.append("copy \(key.account ?? "*")\(one ? "" : " (zapytanie bez limitu 1 i danych)")")
            if let status = state.copyStatus { return (status, nil) }
            guard let item = state.items[key] else { return (errSecItemNotFound, nil) }
            return (errSecSuccess, item.data)
          }
        },
        update: { query, attributes in
          let key = Self.key(query)
          let data = attributes[kSecValueData as String] as? Data
          let accessible = attributes[kSecAttrAccessible as String] as? String
          return self.state.withLock { state in
            state.ops.append("update \(key.account ?? "*")")
            if let status = state.updateStatus { return status }
            guard var item = state.items[key], let data else { return errSecItemNotFound }
            item.data = data
            item.accessible = accessible
            state.items[key] = item
            return errSecSuccess
          }
        },
        add: { query in
          let key = Self.key(query)
          let item = Item(
            data: query[kSecValueData as String] as? Data ?? Data(),
            accessible: query[kSecAttrAccessible as String] as? String,
            synchronizable: query[kSecAttrSynchronizable as String] as? Bool,
            dataProtection: query[kSecUseDataProtectionKeychain as String] as? Bool)
          return self.state.withLock { state in
            state.ops.append("add \(key.account ?? "*")")
            if let status = state.addStatus { return status }
            guard state.items[key] == nil else { return errSecDuplicateItem }
            state.items[key] = item
            return errSecSuccess
          }
        },
        delete: { query in
          let key = Self.key(query)
          return self.state.withLock { state in
            state.ops.append("delete \(key.account ?? "*")")
            if let status = state.deleteStatus { return status }
            // Zapytanie bez konta kasuje całą usługę, jak Keychain (także wpis `device`).
            let doomed = state.items.keys.filter {
              $0.service == key.service && $0.group == key.group && (key.account == nil || $0.account == key.account)
            }
            guard !doomed.isEmpty else { return errSecItemNotFound }
            for victim in doomed { state.items[victim] = nil }
            return errSecSuccess
          }
        })
    }
  }

  final class Lines: Sendable {
    private let lines = Mutex<[String]>([])
    var all: [String] { lines.withLock { $0 } }
    func append(_ line: String) { lines.withLock { $0.append(line) } }
  }

  static func store(_ items: MemorySecItems, _ lines: Lines = Lines()) -> SystemRelayAccessStore {
    SystemRelayAccessStore(group: group, log: { lines.append($0) }, calls: items.calls)
  }

  // MARK: Pamięć podręczna

  @Test("pamięć: zapis → odczyt równy; drugi zapis aktualizuje ten sam wpis, nie dubluje")
  func cacheRoundTrip() throws {
    let items = MemorySecItems()
    let store = Self.store(items)
    #expect(store.loadCache() == .none)
    #expect(store.saveCache(Self.fullCache))
    #expect(store.loadCache() == .found(Self.fullCache))
    var next = Self.fullCache
    next.failures = 0
    next.problem = nil
    next.retryAt = nil
    #expect(store.saveCache(next))
    #expect(store.loadCache() == .found(next))
    #expect(items.snapshot.ops == [
      "copy relay-access", "update relay-access", "add relay-access", "copy relay-access", "update relay-access",
      "copy relay-access",
    ])
    #expect(items.snapshot.items.count == 2, "wpis device i jeden wpis relay-access")
    #expect(items.item("device")?.data == Self.deviceEntry)
  }

  @Test("pamięć: nieznane klucze pominięte, brak kluczy opcjonalnych = nil")
  func cacheUnknownKeys() throws {
    let items = MemorySecItems()
    items.set("relay-access", Data(#"""
      {"version":1,"appId":"\#(Self.appId)","registry":"https://relay-auth.rarog.ai","sponsored":{},"failures":0,
       "nowe":{"x":1},"lastSyncAt":1793700000}
      """#.utf8))
    #expect(Self.store(items).loadCache()
      == .found(RelayAccessCache(appId: Self.appId, registry: Self.registry, lastSyncAt: 1_793_700_000)))
  }

  @Test("pamięć: version 2, zły JSON, brak pola, nieznany problem, wpis bez danych → none z linią logu, wpis nietknięty")
  func cacheUnreadableIsNone() throws {
    let cases: [(String, String)] = [
      (#"{"version":2,"appId":"x","registry":"https://r","sponsored":{},"failures":0}"#, "version 2"),
      ("nie JSON", "not JSON v1"),
      (#"{"version":1,"appId":"x","registry":"https://r","sponsored":{}}"#, "not JSON v1"),
      (#"{"version":1,"appId":"x","registry":"https://r","sponsored":{},"failures":0,"problem":"nowy"}"#,
       "not JSON v1"),
      (#"{"appId":"x","registry":"https://r","sponsored":{},"failures":0}"#, "not JSON v1"),
      ("", "not JSON v1"),
    ]
    for (entry, reason) in cases {
      let items = MemorySecItems()
      items.set("relay-access", Data(entry.utf8))
      let lines = Lines()
      #expect(Self.store(items, lines).loadCache() == .none, "\(entry)")
      #expect(lines.all == ["relay-access: cache ignored (\(reason))"], "\(entry)")
      #expect(items.item("relay-access")?.data == Data(entry.utf8), "\(entry)")
      #expect(items.snapshot.ops == ["copy relay-access"], "\(entry)")
    }
  }

  @Test("pamięć: odczyt odrzucony (zablokowany, OSStatus) → unreadable z powodem")
  func cacheReadRefused() {
    for (status, reason) in [
      (errSecInteractionNotAllowed, "relay-access: Keychain locked"),
      (OSStatus(-34_018), "relay-access: Keychain read, OSStatus -34018"),
    ] {
      let items = MemorySecItems()
      items.state.withLock { $0.copyStatus = status }
      #expect(Self.store(items).loadCache() == .unreadable(reason))
    }
  }

  @Test("pamięć: JSON v1 z kluczami kontraktu, czasy w sekundach epoki, origin bez ukośników ucieczki")
  func cacheShape() throws {
    let items = MemorySecItems()
    #expect(Self.store(items).saveCache(Self.fullCache))
    let data = try #require(items.item("relay-access")?.data)
    let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(Set(json.keys) == [
      "version", "appId", "registry", "registeredUntil", "lastSyncAt", "sponsored", "failures", "retryAt", "problem",
      "lastTunnelCheckAt",
    ])
    #expect(json["version"] as? Int == 1 && json["failures"] as? Int == 2 && json["problem"] as? String == "unreachable")
    #expect(json["registeredUntil"] as? Int == 1_801_476_000 && json["lastSyncAt"] as? Int == 1_793_700_000)
    #expect(json["sponsored"] as? [String: Int] == [String(repeating: "a1", count: 32): 1_801_476_000])
    #expect(String(decoding: data, as: UTF8.self).contains(#""registry":"https://relay-auth.rarog.ai""#))

    let bare = MemorySecItems()
    #expect(Self.store(bare).saveCache(RelayAccessCache(appId: Self.appId, registry: Self.registry)))
    let minimal = try #require(bare.item("relay-access")?.data)
    let keys = try #require(try JSONSerialization.jsonObject(with: minimal) as? [String: Any]).keys
    #expect(Set(keys) == ["version", "appId", "registry", "sponsored", "failures"])
  }

  @Test("pamięć: zapis odrzucony (update, add) → false z linią logu z OSStatus")
  func cacheSaveRefused() {
    let updateRefused = MemorySecItems()
    updateRefused.state.withLock { $0.updateStatus = -34_018 }
    let lines = Lines()
    #expect(!Self.store(updateRefused, lines).saveCache(Self.fullCache))
    #expect(lines.all == ["relay-access: relay-access not saved (OSStatus -34018)"])
    #expect(updateRefused.snapshot.ops == ["update relay-access"], "inny błąd niż brak wpisu nie dodaje wpisu")

    let addRefused = MemorySecItems()
    addRefused.state.withLock { $0.addStatus = errSecInteractionNotAllowed }
    #expect(!Self.store(addRefused).saveCache(Self.fullCache))
    #expect(addRefused.item("relay-access") == nil)
  }

  // MARK: Rezygnacja

  @Test("rezygnacja: zapis → odczyt równy; drugi zapis aktualizuje, nie dubluje")
  func optOutRoundTrip() throws {
    let items = MemorySecItems()
    let store = Self.store(items)
    let pending = RelayOptOut(appId: Self.appId, registry: Self.registry, at: 1_793_700_000, removal: .pending)
    #expect(store.loadOptOut() == .none)
    #expect(store.saveOptOut(pending))
    #expect(store.loadOptOut() == .found(pending))
    var confirmed = pending
    confirmed.removal = .confirmed
    #expect(store.saveOptOut(confirmed))
    #expect(store.loadOptOut() == .found(confirmed))
    #expect(items.snapshot.ops.filter { !$0.hasPrefix("copy") } == [
      "update relay-optout", "add relay-optout", "update relay-optout",
    ])
    #expect(items.snapshot.items.count == 2 && items.item("device")?.data == Self.deviceEntry)
    let saved = try #require(items.item("relay-optout")?.data)
    let json = try #require(try JSONSerialization.jsonObject(with: saved) as? [String: Any])
    #expect(Set(json.keys) == ["version", "appId", "registry", "at", "removal"])
    #expect(json["removal"] as? String == "confirmed" && json["at"] as? Int == 1_793_700_000)
  }

  @Test("rezygnacja: version 2, zły JSON, brak pola, nieznany removal, wpis bez danych → unreadable, wpis nietknięty")
  func optOutUnreadable() {
    let cases: [(String, String)] = [
      (#"{"version":2,"appId":"x","registry":"https://r","at":1,"removal":"pending"}"#, "version 2"),
      ("nie JSON", "not JSON v1"),
      (#"{"version":1,"appId":"x","registry":"https://r","removal":"pending"}"#, "not JSON v1"),
      (#"{"version":1,"appId":"x","registry":"https://r","at":1,"removal":"later"}"#, "not JSON v1"),
      ("", "not JSON v1"),
    ]
    for (entry, reason) in cases {
      let items = MemorySecItems()
      items.set("relay-optout", Data(entry.utf8))
      #expect(Self.store(items).loadOptOut() == .unreadable("relay-optout: \(reason)"), "\(entry)")
      #expect(items.item("relay-optout")?.data == Data(entry.utf8), "\(entry)")
      #expect(items.snapshot.ops == ["copy relay-optout"], "\(entry)")
    }
  }

  @Test("rezygnacja: odczyt odrzucony → unreadable, wpis nietknięty")
  func optOutReadRefused() {
    for (status, reason) in [
      (errSecInteractionNotAllowed, "relay-optout: Keychain locked"),
      (OSStatus(-25_293), "relay-optout: Keychain read, OSStatus -25293"),
    ] {
      let items = MemorySecItems()
      let entry = Data(#"{"version":1,"appId":"x","registry":"https://r","at":1,"removal":"pending"}"#.utf8)
      items.set("relay-optout", entry)
      items.state.withLock { $0.copyStatus = status }
      #expect(Self.store(items).loadOptOut() == .unreadable(reason))
      #expect(items.item("relay-optout")?.data == entry)
    }
  }

  @Test("deleteAll removes both items (the UI test reset), keeps the device entry; missing items count as deleted")
  func deleteAll() {
    let items = MemorySecItems()
    let store = Self.store(items)
    #expect(store.saveCache(Self.fullCache))
    items.set("relay-optout", Data("not JSON".utf8))
    #expect(store.deleteAll())
    #expect(store.loadCache() == .none && store.loadOptOut() == .none)
    #expect(items.item("device")?.data == Self.deviceEntry)
    #expect(store.deleteAll(), "nothing left is also a success")

    let refused = MemorySecItems()
    refused.state.withLock { $0.deleteStatus = -34_018 }
    let lines = Lines()
    #expect(!Self.store(refused, lines).deleteAll())
    #expect(lines.all == [
      "relay-access: relay-access not deleted (OSStatus -34018)",
      "relay-access: relay-optout not deleted (OSStatus -34018)",
    ])
  }

  @Test("deleteOptOut kasuje też wpis nieczytelny; brak wpisu = true; odmowa = false z logiem; reszta usługi nietknięta")
  func deleteOptOut() {
    let items = MemorySecItems()
    let store = Self.store(items)
    items.set("relay-optout", Data("nie JSON".utf8))
    #expect(store.saveCache(Self.fullCache))
    #expect(store.loadOptOut() == .unreadable("relay-optout: not JSON v1"))
    #expect(store.deleteOptOut())
    #expect(store.loadOptOut() == .none)
    #expect(store.deleteOptOut(), "brak wpisu to też sukces")
    #expect(items.item("device")?.data == Self.deviceEntry && store.loadCache() == .found(Self.fullCache))
    #expect(items.snapshot.ops.filter { $0.hasPrefix("delete") } == ["delete relay-optout", "delete relay-optout"])

    let refused = MemorySecItems()
    refused.state.withLock { $0.deleteStatus = -34_018 }
    let lines = Lines()
    #expect(!Self.store(refused, lines).deleteOptOut())
    #expect(lines.all == ["relay-access: relay-optout not deleted (OSStatus -34018)"])
  }

  @Test("zapytania: usługa ai.rarog.app.iroh, konta relay-*, grupa, po pierwszym odblokowaniu, bez synchronizacji")
  func systemAttributes() {
    let store = SystemRelayAccessStore(group: Self.group, log: { _ in })
    #expect(SystemRelayAccessStore.service == SystemIrohIdentityKeychain.service)
    for account in ["relay-access", "relay-optout"] {
      let item = store.addItem(account, Data([1]))
      #expect(item[kSecClass as String] as? String == kSecClassGenericPassword as String)
      #expect(item[kSecAttrService as String] as? String == "ai.rarog.app.iroh")
      #expect(item[kSecAttrAccount as String] as? String == account)
      #expect(item[kSecAttrAccessGroup as String] as? String == Self.group)
      #expect(item[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
      #expect(item[kSecAttrSynchronizable as String] as? Bool == false)
      #expect(item[kSecUseDataProtectionKeychain as String] as? Bool == true)
      #expect(item[kSecValueData as String] as? Data == Data([1]))
      let match = store.match(account)
      #expect(match[kSecAttrAccount as String] as? String == account && match[kSecValueData as String] == nil)
    }
    let update = store.attributes(Data([2]))
    #expect(Set(update.keys) == [kSecValueData as String, kSecAttrAccessible as String])
    #expect(SystemRelayAccessStore(group: nil, log: { _ in }).match("relay-access")[kSecAttrAccessGroup as String] == nil)
    #expect(SystemRelayAccessStore.cacheAccount == "relay-access" && SystemRelayAccessStore.optOutAccount == "relay-optout")
  }

  @Test("wpis tożsamości device przeżywa każdą operację magazynu")
  func deviceUntouched() {
    let items = MemorySecItems()
    let store = Self.store(items)
    _ = store.saveCache(Self.fullCache)
    _ = store.saveOptOut(RelayOptOut(appId: Self.appId, registry: Self.registry, at: 1, removal: .pending))
    _ = store.loadCache()
    _ = store.loadOptOut()
    _ = store.deleteOptOut()
    #expect(items.item("device")?.data == Self.deviceEntry)
    #expect(!items.snapshot.ops.contains { $0.contains("device") || $0.contains("*") || $0.contains("bez limitu") })
  }

  // MARK: Atrapa

  @Test("atrapa magazynu: restart na tych samych Contents widzi zapis; deleteOptOut kasuje nieczytelny; odmowy")
  func fakeStore() {
    let store = FakeRelayAccessStore(.init(optOutUnreadable: "relay-optout: version 2"))
    #expect(store.loadOptOut() == .unreadable("relay-optout: version 2"))
    #expect(store.deleteOptOut() && store.loadOptOut() == .none)
    let optOut = RelayOptOut(appId: Self.appId, registry: Self.registry, at: 1, removal: .confirmed)
    #expect(store.saveOptOut(optOut) && store.saveCache(Self.fullCache))
    let restarted = FakeRelayAccessStore(store.snapshot)
    #expect(restarted.loadOptOut() == .found(optOut) && restarted.loadCache() == .found(Self.fullCache))
    restarted.update { $0.optOutSaveFails = true; $0.cacheSaveFails = true }
    #expect(!restarted.saveOptOut(optOut) && !restarted.saveCache(Self.fullCache))
    #expect(restarted.snapshot.optOutSaves == 1 && restarted.snapshot.cacheSaves == 1)
  }
}
