import Foundation
import RarogContract

// REST i gniazdo terminala. Mutacje (`POST /api/term`,
// `DELETE /api/term/:id`) idą przez `perform`, czyli przez `MutationGate` (bramka zgodności); odczyty
// (lista, historia) — bez bramki, jak każdy `GET`. Gniazdo nie idzie przez `perform`: to upgrade WS,
// a nagłówki (klucz urządzenia, `Origin`, UA) składa ``TerminalRequestBuilder``.
//
// Treść terminala (historia, bajty PTY) nie trafia do logów ani do opisów błędów: błąd
// dekodowania historii nie niesie opisu dekodera, który mógłby zacytować fragment odpowiedzi.
extension RarogClient {
  /// `POST /api/term {cwd, slot?, role?}` → `{id, slot, role}`. Idempotentne: ta sama trójka daje ten
  /// sam terminal, więc reconnect wysyła TO SAMO ciało (nie `next` — to byłaby nowa powłoka).
  /// 409 (`term-limit`, `herdr-launch-off`, `herdr-send-off`) i 400 (`cwd-not-allowed`) przychodzą jako
  /// `.http` ze zdaniem serwera.
  public func openTerminal(_ body: TerminalOpenBody) async throws(TransportError) -> TerminalOpenResponse {
    let path = "/api/term"
    let response = try await perform(.post(path, json: body))
    return try decodeCatalog(TerminalOpenResponse.self, from: response.body, path: path)
  }

  /// `GET /api/term` → lista terminali (zakładki projektu). Wpis o nieznanej roli znika.
  public func terminals() async throws(TransportError) -> TerminalList {
    let path = "/api/term"
    let response = try await perform(.get(path))
    return try decodeCatalog(TerminalList.self, from: response.body, path: path)
  }

  /// `GET /api/term/<id>/history?lines=N` → scrollback panelu jako tekst. Serwer ścina `lines` do 5000.
  public func terminalHistory(id: String, lines: Int) async throws(TransportError) -> TerminalHistory {
    let path = try Self.terminalPath(id) + "/history?lines=\(max(lines, 1))"
    let response = try await perform(.get(path))
    do {
      return try JSONDecoder().decode(TerminalHistory.self, from: response.body)
    } catch {
      throw .invalidResponse("/api/term/:id/history: odpowiedź spoza kontraktu")
    }
  }

  /// `DELETE /api/term/<id>` → 200 `{}`: zamyka panel w herdr (koniec powłoki). 404 = już go nie ma.
  public func closeTerminal(id: String) async throws(TransportError) {
    _ = try await perform(APIRequest(method: "DELETE", path: Self.terminalPath(id)))
  }

  /// Bramka zgodności dla wejścia gniazda (`in`/`rs`/`sc`) — ``MutationGate/checkTerminalInput()``.
  public func checkTerminalInput() async throws(MutationRefusal) {
    try await gate.checkTerminalInput()
  }

  /// Żądanie upgrade'u z tym samym poświadczeniem co REST: klucz urządzenia.
  public func terminalSocketRequest(
    id: String, fresh: Bool, direct: Bool = false, grid: TerminalGrid?
  ) throws(TransportError) -> URLRequest {
    try TerminalRequestBuilder.request(
      config: config, authorization: device?.authorization, id: id, fresh: fresh, direct: direct, grid: grid)
  }

  /// Otwiera gniazdo terminala. Odmowę upgrade'u (zły id, brak klucza, `Origin`, wyłączony ficzer, a przy
  /// `direct` także wpis, który naprawia tylko `POST` — serwer robi `socket.destroy()`) gniazdo zgłasza
  /// zdarzeniem `closed` bez `opened`. Klient po ``invalidate()`` gniazda nie otwiera: `.cancelled`.
  public func terminalSocket(
    id: String, fresh: Bool, direct: Bool, grid: TerminalGrid?
  ) throws(TransportError) -> any TerminalSocketing {
    let request = try terminalSocketRequest(id: id, fresh: fresh, direct: direct, grid: grid)
    return try session.socket { TerminalSocket(request: request) }
  }

  /// `/api/term/<id>` — id sprawdzony przed wejściem do ścieżki.
  static func terminalPath(_ id: String) throws(TransportError) -> String {
    guard TerminalWire.isTerminalId(id) else { throw .invalidResponse("id terminala spoza kształtu TERM_ID_RE") }
    return "/api/term/\(id)"
  }
}
