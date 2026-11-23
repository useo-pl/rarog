import Foundation
import RarogContract

// Klucze urządzeń i parowanie kodem. Kontrakt tras:
// `docs/implementation-spec.md`, „Device keys and pairing”; typy: `RestResponses+Devices.swift`.
//
// `POST /api/pair` jest publiczne (poświadczeniem jest kod z ciała), idzie z `Origin` i bez klucza,
// a bramka zgodności go nie zatrzymuje (`MutationGate.compatibilityExempt`): parowanie dzieje się PRZED
// pierwszym `hello` nowego serwera. Pozostałe trasy wymagają klucza urządzenia (bez niego serwer odpowiada 403
// `device-required`).
extension RarogClient {
  /// Ścieżka parowania — `makeRequest` wysyła ją bez poświadczeń.
  public static let pairPath = "/api/pair"

  /// `POST /api/pair` → poświadczenie wysłane RAZ (`secret`, `pushKey`). 404 `pair-unknown` (zły, zużyty albo
  /// przeterminowany kod), 400 `pair-version`, 429 i 500 przychodzą jako ``TransportError`` ze zdaniem serwera.
  public func pair(_ body: PairBody) async throws(TransportError) -> PairResponse {
    let response = try await perform(.post(Self.pairPath, json: body))
    return try decodeDevices(PairResponse.self, from: response.body, path: Self.pairPath)
  }

  /// `POST /api/pairings {}` → kod dla NOWEGO urządzenia z terminem z zegara serwera (5 min, jednorazowy;
  /// nowy kod tego urządzenia unieważnia poprzedni).
  public func issuePairingCode() async throws(TransportError) -> PairingIssued {
    let path = "/api/pairings"
    let response = try await perform(.post(path, json: EmptyBody()))
    return try decodeDevices(PairingIssued.self, from: response.body, path: path)
  }

  /// `DELETE /api/pairings` (no body) → 204: the server revokes this device's pairing code at once, also when there
  /// was none. A server without the route answers 405; the store ignores every error of this call.
  public func cancelPairingCode() async throws(TransportError) {
    _ = try await perform(APIRequest(method: "DELETE", path: "/api/pairings"))
  }

  /// `GET /api/devices` → aktywne urządzenia serwera, od najstarszego.
  public func devices() async throws(TransportError) -> DeviceList {
    let path = "/api/devices"
    let response = try await perform(.get(path))
    return try decodeDevices(DeviceList.self, from: response.body, path: path)
  }

  /// `POST /api/devices/forget {}` → 204: serwer odpina TO urządzenie („Zapomnij serwer”, `revokedBy: forget`).
  public func forgetDevice() async throws(TransportError) {
    _ = try await perform(.post("/api/devices/forget", json: EmptyBody()))
  }

  /// Jak ``decode(_:from:path:)``, ale błąd bez szczegółów dekodera (odpowiedź parowania niesie sekret).
  func decodeDevices<T: Decodable>(_ type: T.Type, from data: Data, path: String) throws(TransportError) -> T {
    do {
      return translated(try JSONDecoder().decode(type, from: data))
    } catch {
      throw .invalidResponse("\(path): odpowiedź spoza kontraktu")
    }
  }
}
