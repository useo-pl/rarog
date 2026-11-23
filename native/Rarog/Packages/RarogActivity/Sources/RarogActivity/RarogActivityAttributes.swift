import Foundation
import RarogContract

#if canImport(ActivityKit) && os(iOS)
import ActivityKit
#endif

/// Atrybuty JEDNEJ zbiorczej Live Activity urządzenia.
///
/// Wszystko, co kafel pokazuje i co zmienia się w czasie, jedzie w `ContentState` — a tym jest kontrakt serwera,
/// `LiveActivityContentState` (ActivityKit dekoduje `aps.content-state` z pusha jego `init(from:)`). Atrybuty stałe
/// niosą tylko system maszyny serwera z chwili startu: z niego kafel bierze słowo „Mac” albo „VPS”
/// (``machine``), bo rozszerzenie nie linkuje rdzenia. Atrybutów żywej aktywności zmienić się nie da, więc inne słowo
/// to koniec kafla i nowy kafel (rdzeń, `syncLiveActivity`). Nazwa typu jest częścią przyszłego push-to-start
/// (`attributes-type` w ładunku) — nie zmieniać bez serwera.
public struct RarogActivityAttributes: Codable, Sendable, Equatable {
  /// System serwera z sondy wersji przy starcie aktywności; `nil` = nie wiadomo (także kafel sprzed pola).
  public let serverSystem: ServerSystem?

  public init(serverSystem: ServerSystem? = nil) {
    self.serverSystem = serverSystem
  }

  /// Słowo maszyny serwera na kaflu (jedna reguła z apką, ``ServerMachine``).
  public var machine: ServerMachine { ServerMachine(serverSystem) }

  enum CodingKeys: String, CodingKey {
    case serverSystem
  }

  /// Kafel postawiony przed polem ma atrybuty `{}`; zepsute albo nieznane pole nie psuje dekodowania
  /// (``Swift/KeyedDecodingContainer/storedServerSystem(forKey:)``).
  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    serverSystem = c.storedServerSystem(forKey: .serverSystem)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encodeIfPresent(serverSystem, forKey: .serverSystem)
  }
}

#if canImport(ActivityKit) && os(iOS)
extension RarogActivityAttributes: ActivityAttributes {
  public typealias ContentState = LiveActivityContentState
}
#endif
