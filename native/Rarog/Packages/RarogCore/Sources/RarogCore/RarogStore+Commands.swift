import Foundation
import RarogContract
import RarogTransport

// Lista slash-komend oglądanej sesji do podpowiedzi po „/”: `GET /api/sessions/<id>/commands`
// przy pierwszym „/” w sesji, potem najwyżej co ``CommandListTiming/refresh`` i od razu po odmowie 400 wysyłki
// komendy. Stan i jego reguły: `Commands.swift`. Właściciel: pole.
extension RarogStore {
  /// Pole wiadomości oglądanej sesji dostało token komendy („/” na początku). Odczyt idzie tylko wtedy, gdy listy
  /// jeszcze nie ma, minęło ``CommandListTiming/refresh`` od ostatniej odpowiedzi albo serwer odmówił komendy; drugi
  /// „/” w trakcie odczytu nic nie wysyła. Błąd nie stawia komunikatu: pusta lista = brak podpowiedzi. 401 idzie
  /// zwykłą drogą utraty logowania; zerwana sieć zostawia ostatnią listę i nie liczy się do rytmu, więc następny
  /// „/” pyta znowu. Odmowa komendy w trakcie odczytu zamawia następny odczyt zaraz po nim.
  public func loadCommandsIfNeeded(_ sessionId: String) async {
    guard state.auth == .loggedIn, state.viewedSessionId == sessionId,
      state.commandListNeedsRead(sessionId, now: clock()), commandReads.insert(sessionId).inserted
    else { return }
    let again = await readCommands(sessionId)
    commandReads.remove(sessionId)
    // Serwer odmówił komendy, gdy odczyt był w drodze: jego odpowiedź mogła być starsza — jeszcze jeden odczyt.
    if again { await loadCommandsIfNeeded(sessionId) }
  }

  /// Jeden odczyt listy. `true` = w jego trakcie przyszła odmowa komendy i lista dalej jest nieświeża.
  private func readCommands(_ sessionId: String) async -> Bool {
    let login = currentLogin
    let refusals = state.commands.sessionId == sessionId ? state.commands.refusals : 0
    let list: CommandList
    do {
      list = try await transport.commands(sessionId: sessionId)
    } catch {
      switch error {
      case .unauthorized:
        handleUnauthorized(since: login)
        return false
      case .offline, .timedOut, .cancelled:
        return false
      case .http, .forbidden, .rateLimited, .refused, .invalidResponse:
        // Panel poza zasięgiem (400), odpowiedź spoza kontraktu: nic do podpowiedzenia do następnego terminu.
        list = .unavailable
      }
    }
    guard isCurrentLogin(login) else { return false }
    dispatch(.commands(.loaded(sessionId: sessionId, list, at: clock(), refusals: refusals)))
    return state.commands.sessionId == sessionId && state.commands.stale
  }

  /// Odmowa 400 wysyłki (`RarogStore+Send`): tekst-komenda oznacza listę tej sesji jako nieświeżą i od razu czyta
  /// ją od nowa, gdy sesja stoi na ekranie — strażnik serwera odmówił, więc katalog mógł się zmienić.
  func commandSendRefused(_ entry: OutboxEntry) {
    guard SlashCommandText.isCommand(entry.text) else { return }
    dispatch(.commands(.refused(sessionId: entry.sessionId)))
    let sessionId = entry.sessionId
    Task { [weak self] in await self?.loadCommandsIfNeeded(sessionId) }
  }
}
