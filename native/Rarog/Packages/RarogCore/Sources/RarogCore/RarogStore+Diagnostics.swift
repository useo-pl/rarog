import Foundation
import RarogContract
import RarogTransport

// Ślady zdarzeń, które z iPada wyglądałyby jak martwy przycisk. Właściciel: łączność.
//
// Linia idzie do `client.log` serwera poziomem `debug`, tym samym buforem co raport `kontrakt:`
// (bramka zalogowania: ślad sprzed zalogowania wyjdzie po nim), ale z własnym budżetem — 20 na godzinę
// (`ContractReporter.traceCap`) — więc ani nie zasypie logu, ani nie zabierze miejsca liniom
// `kontrakt:`. Treści rozmowy, terminala i notatek w śladzie NIE MA: opis składa wołający
// z faktów (stan pola, rodzaj klawiatury, wynik, czas w ms), nigdy z tekstu.
// Voice agent conversation lines name their own budget (`TraceBudget.voiceAgent`, 240 per hour; the end line
// `TraceBudget.voiceAgentEnd` always passes), so they neither drop under nor eat the shared 20.
// A trace belongs to the running login (`ContractReporter.Owner.current`); a line about a server named by its
// producer (a tunnel runtime) takes that server's key and never reaches another one.
extension RarogStore {
  /// One trace line (the first line of the summary, at most 200 characters) under `budget`; voice agent lines
  /// pass their own budget (``TraceBudget``). The line belongs to the running login.
  public func trace(_ summary: String, budget: TraceBudget = .app) {
    trace(summary, budget: budget, owner: .current)
  }

  /// A trace about the server `server` (a tunnel runtime's line, which can arrive after the store moved to another
  /// server): it reaches that server only. `nil` = no single server (the shared endpoint, the relay registry): such a
  /// line goes only to the first login of the process and is dropped after it.
  public func trace(_ summary: String, budget: TraceBudget, server: ServerKey?) {
    trace(summary, budget: budget, owner: .server(server))
  }

  func trace(_ summary: String, budget: TraceBudget = .app, owner: ContractReporter.Owner) {
    let line = summary.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
    guard !line.isEmpty else { return }
    reporter.recordTrace(String(line.prefix(200)), budget: budget, now: clock(), owner: owner)
    flushReport()
  }

  /// The key a login of the current endpoint sends `client.log` lines to. A store without a server connector has no
  /// endpoint key and one server for its whole life.
  var loginReportKey: ServerKey {
    ServerKey(serverRuntime.endpoint.credential) ?? .withoutConnector
  }
}
