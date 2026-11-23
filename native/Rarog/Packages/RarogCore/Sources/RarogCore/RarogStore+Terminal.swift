import Foundation
import RarogContract
import RarogTransport

// Terminale w magazynie. Właściciel: terminal.
// - Sesje terminala na ekranie: tło je usypia, powrót na wierzch budzi (nowe gniazdo `fresh=1`),
//   wylogowanie kończy, niezgodność trwała (`tooOld`, `protocolMismatch`) blokuje.
// - Lista terminali (`GET /api/term`): co ≤ 5 s, dopóki ekran projektu jest na wierzchu (`watchTerminals`),
//   i od razu po zamknięciu terminala.
// - Zamknięcie (`DELETE`) i historia — historia wraca do wołającego i NIGDZIE nie zostaje.
// Rdzeń woła `syncTerminals()` przy zmianie fazy sceny i wznowieniu, `stopTerminals()` przy wylogowaniu,
// `blockTerminalsIfIncompatible()` po zmianie zgodności.

/// Rytm listy terminali — wstrzykiwany (testy).
public struct TerminalListTiming: Sendable, Equatable {
  /// Odświeżanie listy na ekranie projektu (≤ 5 s; PWA polluje co 5 s).
  public var refresh: Duration

  public init(refresh: Duration = .seconds(5)) {
    self.refresh = refresh
  }

  public static let production = TerminalListTiming()
}

/// Słaba referencja: sesję trzyma widok; magazyn ją tylko usypia, budzi i kończy.
struct WeakTerminalSession {
  weak var session: TerminalSession?
}

/// Księgowość terminali magazynu (pole `terminalArea`).
struct TerminalArea {
  var listTiming = TerminalListTiming.production
  var sessionTiming = TerminalTiming.production
  /// Sen pętli listy i budzika ponawiania sesji (testy: zegar wirtualny).
  var sleep: @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }
  var sessions: [WeakTerminalSession] = []
  /// Ekran projektu na wierzchu chce świeżej listy.
  var watching = false
  var loop: Task<Void, Never>?
  /// Odczyt listy w drodze — najwyżej jeden; wylogowanie go anuluje, a wynik sprzed niego odcina numer
  /// zalogowania.
  var read: Task<Void, Never>?
  /// Numer odczytów listy: zamknięcie terminala go podbija, więc lista wysłana PRZED zamknięciem (jeszcze
  /// z tym wpisem) nie przywraca go po nim — a wybrany z niej wpis odtworzyłby powłokę `POST`-em.
  var listEpoch = 0
}

/// Wynik zamknięcia terminala.
public enum TerminalCloseOutcome: Sendable, Equatable {
  case closed
  /// Serwer już go nie znał (404) — z listy znika tak samo.
  case gone
  /// Zdanie serwera albo bramki; `nil` = sieć.
  case failed(String?)
}

/// Wynik odczytu historii terminala. Treść nie trafia do stanu magazynu — tylko do wołającego.
public enum TerminalHistoryOutcome: Sendable, Equatable {
  case loaded(TerminalHistory)
  /// Nie ma takiego terminala (404).
  case gone
  case failed(String?)
}

extension RarogStore {
  /// Transport terminala; produkcyjny `RarogClient` go ma, atrapy testowe — gdy implementują protokół.
  var terminalTransport: (any TerminalTransporting)? { areaTransport as? any TerminalTransporting }

  /// Rytm sesji i listy oraz ich sen — testy podmieniają je przed `start()`.
  var terminalTiming: (session: TerminalTiming, list: TerminalListTiming) {
    get { (terminalArea.sessionTiming, terminalArea.listTiming) }
    set {
      terminalArea.sessionTiming = newValue.session
      terminalArea.listTiming = newValue.list
    }
  }

  // MARK: Sesje

  /// Nowa sesja terminala dla celu, jeszcze NIE połączona: widok podpina `onBytes` i `gridProvider`,
  /// potem woła `start()`. `nil` bez zalogowania albo bez transportu terminala.
  ///
  /// Cel decyduje o slocie: terminal z listy (`TerminalTarget.existing`) i konkretny slot wracają do tej
  /// samej powłoki przy każdym połączeniu; `TerminalTarget.newShell` (`slot: next`) wyłącznie przy
  /// świadomym „Nowy terminal".
  public func terminalSession(_ target: TerminalTarget) -> TerminalSession? {
    guard state.auth == .loggedIn, let transport = terminalTransport else { return nil }
    let session = TerminalSession(
      target: target, transport: transport, timing: terminalArea.sessionTiming, sleep: terminalArea.sleep,
      renderer: renderer)
    let login = currentLogin
    session.storeHook = { [weak self] event in
      if case .unauthorized = event { self?.handleUnauthorized(since: login) }
    }
    terminalArea.sessions.removeAll { $0.session == nil }
    terminalArea.sessions.append(WeakTerminalSession(session: session))
    return session
  }

  /// Sesje, które jeszcze żyją (widok ich nie puścił); martwe referencje wypadają przy okazji.
  private func liveTerminalSessions() -> [TerminalSession] {
    terminalArea.sessions.removeAll { $0.session == nil }
    return terminalArea.sessions.compactMap(\.session)
  }

  // MARK: Lista

  /// Ekran projektu na wierzchu (`true`) albo zszedł (`false`): lista terminali co ≤ 5 s tylko wtedy.
  public func watchTerminals(_ watching: Bool) {
    terminalArea.watching = watching
    syncTerminals()
  }

  /// Odczyt listy od razu (po założeniu terminala, po geście odświeżenia).
  public func refreshTerminalsNow() {
    Task { await fetchTerminals() }
  }

  /// Faza sceny, wznowienie, zalogowanie: sesje w tle śpią, na wierzchu się budzą; pętla listy chodzi
  /// wyłącznie zalogowana, na wierzchu i przy obserwowanym ekranie projektu.
  func syncTerminals() {
    let loggedIn = state.auth == .loggedIn
    for session in liveTerminalSessions() {
      if areaPhase == .background {
        session.suspend()
      } else if loggedIn, areaPhase == .active {
        session.resume()
      }
    }
    guard loggedIn, areaPhase == .active, terminalArea.watching else {
      terminalArea.loop?.cancel()
      terminalArea.loop = nil
      return
    }
    guard terminalArea.loop == nil else { return }
    let refresh = terminalArea.listTiming.refresh
    let sleep = terminalArea.sleep
    // Słaba referencja przez cały sen: pętla nie trzyma magazynu przy życiu.
    terminalArea.loop = Task { [weak self] in
      while !Task.isCancelled {
        await self?.fetchTerminals()
        guard !Task.isCancelled else { return }
        await sleep(refresh)
      }
    }
  }

  /// Wylogowanie: sesje kończą się (spóźnione odpowiedzi odcina ich generacja), pętla i odczyt stają.
  func stopTerminals() {
    for session in liveTerminalSessions() { session.stop() }
    terminalArea.sessions.removeAll()
    terminalArea.loop?.cancel()
    terminalArea.loop = nil
    terminalArea.read?.cancel()
    terminalArea.read = nil
  }

  /// Niezgodność trwała po `hello`: gniazda zamknięte, wejście zablokowane (zdanie z kierunkiem lekarstwa).
  func blockTerminalsIfIncompatible() {
    guard let message = state.compat.permanentRefusal else { return }
    for session in liveTerminalSessions() { session.block(message) }
  }

  /// `GET /api/term` → stan listy. Wołający w trakcie odczytu czeka na ten w drodze. Bez ficzeru po stronie
  /// serwera (`termEnabled: false` w sondzie wersji) nie pyta wcale.
  func fetchTerminals() async {
    guard state.auth == .loggedIn, state.capabilities?.terminal == true, let transport = terminalTransport else {
      return
    }
    if terminalArea.read == nil {
      let login = currentLogin
      let epoch = terminalArea.listEpoch
      terminalArea.read = Task { [weak self] in
        let result: Result<TerminalList, TransportError>
        do throws(TransportError) {
          result = .success(try await transport.terminals())
        } catch {
          result = .failure(error)
        }
        self?.finishTerminals(result, login: login, epoch: epoch)
      }
    }
    await terminalArea.read?.value
  }

  private func finishTerminals(_ result: Result<TerminalList, TransportError>, login: Int, epoch: Int) {
    // Odpowiedź sprzed wylogowania nie wraca na ekran i nie wylogowuje nowego logowania, a lista
    // sprzed zamknięcia terminala nie przywraca zamkniętego wpisu (odczyt po zamknięciu jest już osobny).
    guard isCurrentLogin(login), epoch == terminalArea.listEpoch else { return }
    terminalArea.read = nil
    guard state.auth == .loggedIn else { return }
    switch result {
    case let .success(list): areaDispatch(.terminals(.loaded(list.terminals, at: areaNow)))
    case .failure(.cancelled): return
    case .failure(.unauthorized): handleUnauthorized(since: login)
    case .failure: areaDispatch(.terminals(.refreshFailed))
    }
  }

  // MARK: Zamknięcie i historia

  /// `DELETE /api/term/<id>` — koniec powłoki w herdr. Sesje tego terminala stają PRZED żądaniem: żywa
  /// sesja z katalogiem odtworzyłaby go `POST`-em przy ponowieniu (nowy panel zamiast zamkniętego).
  public func closeTerminal(id: String) async -> TerminalCloseOutcome {
    guard let transport = terminalTransport else { return .failed(nil) }
    for session in liveTerminalSessions() where session.terminalId == id { session.stop() }
    let login = currentLogin
    do throws(TransportError) {
      try await transport.closeTerminal(id: id)
    } catch {
      guard isCurrentLogin(login) else { return .failed(nil) }
      switch error {
      case let .http(failure) where failure.status == 404:
        forgetTerminal(id)
        return .gone
      case .unauthorized:
        handleUnauthorized(since: login)
        return .failed(nil)
      case let .http(failure), let .forbidden(failure), let .rateLimited(failure):
        return .failed(failure.message)
      case let .refused(refusal):
        return .failed(refusal.message)
      case .offline, .timedOut, .invalidResponse, .cancelled:
        return .failed(nil)
      }
    }
    guard isCurrentLogin(login) else { return .closed }
    forgetTerminal(id)
    return .closed
  }

  /// Wpis znika od razu, a odczyty listy wysłane przed zamknięciem tracą ważność; świeża lista idzie od razu.
  private func forgetTerminal(_ id: String) {
    terminalArea.listEpoch += 1
    terminalArea.read?.cancel()
    terminalArea.read = nil
    areaDispatch(.terminals(.closed(id: id)))
    refreshTerminalsNow()
  }

  /// `GET /api/term/<id>/history?lines=N` (domyślnie 1000, serwer ścina do 5000). Treść wraca WYŁĄCZNIE
  /// do wołającego — nie wchodzi do stanu, pamięci podręcznej ani logu.
  public func terminalHistory(id: String, lines: Int = 1000) async -> TerminalHistoryOutcome {
    guard let transport = terminalTransport else { return .failed(nil) }
    let login = currentLogin
    do throws(TransportError) {
      let history = try await transport.terminalHistory(id: id, lines: lines)
      // Treść sprzed wylogowania (albo innego zalogowania) nie wraca na ekran.
      guard isCurrentLogin(login), state.auth == .loggedIn else { return .failed(nil) }
      return .loaded(history)
    } catch {
      guard isCurrentLogin(login) else { return .failed(nil) }
      switch error {
      case let .http(failure) where failure.status == 404:
        return .gone
      case .unauthorized:
        handleUnauthorized(since: login)
        return .failed(nil)
      case let .http(failure), let .forbidden(failure), let .rateLimited(failure):
        return .failed(failure.message)
      case .refused, .offline, .timedOut, .invalidResponse, .cancelled:
        return .failed(nil)
      }
    }
  }
}
