import Foundation
import RarogContract
import RarogTransport

// Klucz tymczasowy dyktowania. Właściciel: dyktowanie. Samo nagrywanie,
// strumień do Soniox i polityka (cisza, limit, przerwania) mieszkają w RarogUI (`Session/Voice`):
// rdzeń daje wyłącznie klucz — żądanie do serwera z bramkami, wylogowaniem i odmową „wyłączone".

/// Wynik pobrania klucza dyktowania. Zdania składa RarogUI.
public enum VoiceTokenOutcome: Sendable, Equatable {
  case token(VoiceToken)
  /// 404 (starszy serwer) albo 503 `voice_unconfigured`: Soniox niedostępny na tym serwerze do jego restartu
  /// (`AppState.sonioxOnServer`). Inne 503 dają `failed`.
  case disabled(message: String?)
  /// 429: serwer dławi pobieranie kluczy — ponowienie od razu nie ma sensu.
  case rateLimited(message: String?)
  /// Bramka klienta (zgodność wersji) odmówiła, zanim żądanie wyszło.
  case refused(message: String)
  /// 401 albo wylogowanie w trakcie żądania: odpowiedź należy do poprzedniego zalogowania.
  case loggedOut
  /// Anulowane przez wołającego (koniec dyktowania, zamknięty ekran).
  case cancelled
  /// Sieć, limit czasu, 5xx, odpowiedź spoza kontraktu — kolejna próba ma sens.
  case failed(message: String?)
}

/// Księgowość kluczy w drodze (pole magazynu `voiceMinting`).
struct VoiceMinting {
  /// Numer zalogowania; wylogowanie go podbija, więc odpowiedź sprzed niego nie ma prawa wrócić.
  var login = 0
  /// Żądania w drodze — wylogowanie je anuluje: spóźniony 401 nie wyloguje NOWEGO zalogowania (ta sama
  /// reguła co odczyty limitów).
  var inFlight: [UUID: Task<Result<VoiceToken, TransportError>, Never>] = [:]
}

extension RarogStore {
  /// `POST /api/voice/token`. Wołający (nagrywarka) prosi o klucz przy KAŻDYM otwarciu strumienia
  /// i nigdy na zapas. Anulowanie zadania wołającego anuluje żądanie. Każde żądanie ma własną pracę w tle
  /// z serwerem na swój czas (ponowna próba otwiera strumień także po zejściu w tło).
  public func mintVoiceToken() async -> VoiceTokenOutcome {
    guard state.auth == .loggedIn else { return .loggedOut }
    let work = beginBackgroundWork("rarog.voice-token", needsServer: true)
    defer { endBackgroundWork(work) }
    let mints = voiceMinting.login
    let login = currentLogin
    let transport = transport
    let id = UUID()
    let request = Task<Result<VoiceToken, TransportError>, Never> {
      do throws(TransportError) {
        return .success(try await transport.voiceToken())
      } catch {
        return .failure(error)
      }
    }
    voiceMinting.inFlight[id] = request
    let result = await withTaskCancellationHandler {
      await request.value
    } onCancel: {
      request.cancel()
    }
    voiceMinting.inFlight[id] = nil
    // Wylogowanie w trakcie: wynik należy do poprzedniego zalogowania (także sukces — klucz
    // wydany staremu poświadczeniu nie otwiera dyktowania na nowym ekranie).
    guard mints == voiceMinting.login, state.auth == .loggedIn else { return .loggedOut }
    if Task.isCancelled { return .cancelled }
    switch result {
    case let .success(token):
      return .token(token)
    case let .failure(error):
      return voiceOutcome(error, login: login)
    }
  }

  /// `login` = `currentLogin` taken before the request: a 401 logs out only within that same login.
  private func voiceOutcome(_ error: TransportError, login: Int) -> VoiceTokenOutcome {
    switch error {
    case let .http(failure) where Self.refusesSoniox(failure):
      dispatch(.voice(.serverDisabled))
      return .disabled(message: failure.status == 503 ? failure.message : nil)
    case let .rateLimited(failure):
      return .rateLimited(message: failure.message)
    case let .refused(refusal):
      return .refused(message: refusal.message)
    case .unauthorized:
      handleUnauthorized(since: login)
      return .loggedOut
    case .cancelled:
      return .cancelled
    case let .http(failure), let .forbidden(failure):
      return .failed(message: failure.message)
    case .timedOut, .offline, .invalidResponse:
      return .failed(message: nil)
    }
  }

  /// Odmowę zapisuje tylko odpowiedź, która ją naprawdę niesie: 404 (serwer bez trasy) albo 503 z kodem
  /// `voice_unconfigured` (pole `error` ciała API). Inne 503 (bez ciała API, np. reverse proxy, albo z innym
  /// kodem) to awaria przejściowa: `.failed` z ponowieniem, bez odmowy do restartu serwera.
  static func refusesSoniox(_ failure: APIFailure) -> Bool {
    failure.status == 404 || (failure.status == 503 && failure.code == "voice_unconfigured")
  }

  /// Wylogowanie (woła `handleUnauthorized`): klucze w drodze anulowane, ich wyniki odcięte.
  func forgetVoiceMints() {
    voiceMinting.login += 1
    for request in voiceMinting.inFlight.values { request.cancel() }
    voiceMinting.inFlight = [:]
  }
}
