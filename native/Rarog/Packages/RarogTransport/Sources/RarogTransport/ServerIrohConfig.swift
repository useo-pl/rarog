import Foundation

/// Serwer osiągalny przez iroh: EndpointId (64 znaki hex, małe litery, `PairingLinkWire.isEndpointId`) i relay
/// w postaci kanonicznej pola `r` linku parowania. Kształt zapisu jak pole `iroh` poświadczenia
/// (`{"endpointId", "relay"}`). Sam typ: walidację i miejsce w poświadczeniu daje wczytujący.
public struct ServerIrohConfig: Sendable, Hashable, Codable {
  public let endpointId: String
  public let relay: URL

  public init(endpointId: String, relay: URL) {
    self.endpointId = endpointId
    self.relay = relay
  }
}
