import Foundation

// Ślady zdarzeń, które z iPada wyglądałyby jak martwy przycisk. Właściciel: łączność.
//
// Linia idzie do `client.log` serwera poziomem `debug`, tym samym buforem co raport `kontrakt:`
// (bramka zalogowania: ślad sprzed zalogowania wyjdzie po nim), ale z własnym budżetem — 20 na godzinę
// (`ContractReporter.traceCap`) — więc ani nie zasypie logu, ani nie zabierze miejsca liniom
// `kontrakt:`. Treści rozmowy, terminala i notatek w śladzie NIE MA: opis składa wołający
// z faktów (stan pola, rodzaj klawiatury, wynik, czas w ms), nigdy z tekstu.
// Voice agent conversation lines name their own budget (`TraceBudget.voiceAgent`, 240 per hour; the end line
// `TraceBudget.voiceAgentEnd` always passes), so they neither drop under nor eat the shared 20.
extension RarogStore {
  /// One trace line (the first line of the summary, at most 200 characters) under `budget`; voice agent lines
  /// pass their own budget (``TraceBudget``).
  public func trace(_ summary: String, budget: TraceBudget = .app) {
    let line = summary.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
    guard !line.isEmpty else { return }
    reporter.recordTrace(String(line.prefix(200)), budget: budget, now: clock())
    flushReport()
  }
}
