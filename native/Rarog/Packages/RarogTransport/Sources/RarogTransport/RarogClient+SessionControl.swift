import Foundation
import RarogContract

// Przerwanie tury i „obejrzane". Każda
// mutacja idzie przez `perform`, czyli przez `MutationGate` (zgodność i bramka sesji
// `unsupported`, bo ścieżki to `/api/sessions/<id>/…`). Limit każdego żądania to
// `RarogConfig.requestTimeout` (10 s): serwer czeka na los klawisza najwyżej 3 s.
// Właściciel: przerwanie i sterowanie sesją.
extension RarogClient {
  /// `POST /api/sessions/<id>/interrupt` → 202 `{ok, session?, delivered?}`. Odmowy Raroga
  /// (panel poza zasięgiem, wyłączona wysyłka, nieznana sesja) przychodzą jako 4xx ze zdaniem
  /// serwera, PRZED dotknięciem panelu.
  public func interruptSession(sessionId: String) async throws(TransportError) -> InterruptResponse {
    let path = "/api/sessions/\(Self.segment(sessionId))/interrupt"
    let response = try await perform(.post(path, json: EmptyBody()))
    return try decodeCatalog(InterruptResponse.self, from: response.body, path: path)
  }

  /// `POST /api/sessions/<id>/seen` → 200 `{ok: true}`: wynik tury obejrzany na urządzeniu.
  public func markSeen(sessionId: String) async throws(TransportError) {
    let path = "/api/sessions/\(Self.segment(sessionId))/seen"
    let response = try await perform(.post(path, json: EmptyBody()))
    _ = try decodeCatalog(OkAck.self, from: response.body, path: path)
  }

  /// `POST /api/sessions/<id>/unseen` → 200 `{ok: true}`: ręczne „nieprzeczytane” stojącego wyniku.
  /// Tylko znacznik w Rarogu; skutek przychodzi ramką `session-changed`.
  public func markUnseen(sessionId: String) async throws(TransportError) {
    let path = "/api/sessions/\(Self.segment(sessionId))/unseen"
    let response = try await perform(.post(path, json: EmptyBody()))
    _ = try decodeCatalog(OkAck.self, from: response.body, path: path)
  }
}
