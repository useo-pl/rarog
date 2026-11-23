import Foundation
import RarogContract
import RarogTransport

// Obciążenie Maca w stopce listy: `GET /api/mac` w harmonogramie limitów (`RarogStore+Usage`) — ta sama
// bramka (zalogowany i na wierzchu), co ``UsageTiming/mac`` (30 s), od razu po wejściu na wierzch z podłogą.
// Termin ważności ``UsageTiming/macTTL`` od ostatniego udanego odczytu pilnuje OSOBNE zadanie (pętla potrafi
// czekać na odczyt w drodze dłużej niż do terminu), a wejście na wierzch sprawdza go od razu. 404 (starszy serwer)
// wyłącza odczyty do zmiany `serverStartId` albo nowego logowania. Pętlę, wylogowanie i tap prowadzi
// `RarogStore+Usage`.
extension RarogStore {
  /// Serwer zna trasę — albo nie wiemy, że nie zna. Po 404 rdzeń milczy do innego startu serwera.
  private var macSupported: Bool {
    !(state.macLoad.unsupported && state.macLoad.unsupportedServer == state.serverStartId)
  }

  /// Czas odczytu: pierwszy w zalogowaniu od razu, wejście na wierzch z podłogą, potem co ``UsageTiming/mac``.
  func macDue(at now: Date, entering: Bool) -> Bool {
    guard macSupported else { return false }
    guard let last = usagePolling.lastMacAttempt else { return true }
    let since = now.timeIntervalSince(last)
    return since >= (entering ? usagePolling.timing.floor : usagePolling.timing.mac).timeInterval
  }

  /// Termin następnego odczytu Maca dla snu pętli (termin ważności liczb ma własne zadanie).
  func macWaits(at now: Date) -> [TimeInterval] {
    guard macSupported else { return [] }
    let last = usagePolling.lastMacAttempt ?? now
    return [usagePolling.timing.mac.timeInterval - now.timeIntervalSince(last)]
  }

  /// Liczby starsze niż termin ważności znikają (szkielet) — także te, które przeżyły pobyt w tle.
  func expireMacIfDue(at now: Date) {
    guard state.macLoad.load != nil, let received = state.macLoad.receivedAt,
      now.timeIntervalSince(received) >= usagePolling.timing.macTTL.timeInterval
    else { return }
    usagePolling.macExpiry?.cancel()
    usagePolling.macExpiry = nil
    areaDispatch(.mac(.expired))
  }

  /// Zadanie terminu ważności od ostatniego udanego odczytu: niezależne od pętli, która może czekać na odczyt
  /// limitów, wersji albo Maca w drodze dłużej niż do terminu. Nowy odczyt zastępuje
  /// zadanie; wylogowanie je anuluje. Sen to `usagePolling.sleep` — testy idą wirtualnym zegarem.
  private func scheduleMacExpiry() {
    usagePolling.macExpiry?.cancel()
    usagePolling.macExpiry = nil
    guard state.macLoad.load != nil, let received = state.macLoad.receivedAt else { return }
    let left = usagePolling.timing.macTTL.timeInterval - areaNow.timeIntervalSince(received)
    let wait = Duration.milliseconds(Int((max(left, 0) * 1000).rounded(.up)))
    let sleep = usagePolling.sleep
    let login = currentLogin
    usagePolling.macExpiry = Task { [weak self] in
      await sleep(wait)
      guard !Task.isCancelled, let self, self.isCurrentLogin(login) else { return }
      self.expireMacIfDue(at: self.areaNow)
    }
  }

  /// Odczyt `GET /api/mac`: nowy albo ten w drodze (najwyżej jeden). `nil` — bez zalogowania, poza wierzchem
  /// (tap, którego zadanie ruszyło już w tle) albo po 404 tego samego serwera. Wołający czeka na `value`, jeśli
  /// potrzebuje wyniku.
  @discardableResult
  func startMacRead() -> Task<Void, Never>? {
    guard state.auth == .loggedIn, areaPhase == .active, macSupported else { return nil }
    if let read = usagePolling.macRead { return read }
    let login = currentLogin
    // 404 należy do serwera, który dostał żądanie — spóźniona odpowiedź starego serwera nie wyłączy nowego.
    let server = state.serverStartId
    let transport = areaTransport
    usagePolling.lastMacAttempt = areaNow
    let read = Task { [weak self] in
      let result: Result<MacLoad, TransportError>
      do throws(TransportError) {
        result = .success(try await transport.mac())
      } catch {
        result = .failure(error)
      }
      self?.finishMac(result, login: login, server: server)
    }
    usagePolling.macRead = read
    return read
  }

  private func finishMac(_ result: Result<MacLoad, TransportError>, login: Int, server: String?) {
    // Odpowiedź sprzed wylogowania nie ma prawa wrócić na ekran ani wylogować nowego.
    guard isCurrentLogin(login) else { return }
    usagePolling.macRead = nil
    guard state.auth == .loggedIn else { return }
    switch result {
    case let .success(load):
      areaDispatch(.mac(.loaded(load, at: areaNow)))
      scheduleMacExpiry()
    case let .failure(.http(failure)) where failure.status == 404:
      guard server == state.serverStartId else {
        // 404 serwera, którego już nie ma (przyszło `hello` nowego startu): o nowym nic nie mówi — od razu
        // pytamy nowy, zamiast chować linię do następnego terminu.
        usagePolling.lastMacAttempt = nil
        wakeUsageLoop()
        return
      }
      // Starszy serwer: funkcji nie ma — cicho, bez ponowień do innego startu serwera.
      areaDispatch(.mac(.unsupported(serverStartId: server)))
    case .failure(.cancelled):
      return
    case .failure(.unauthorized):
      handleUnauthorized(since: login)
    case .failure:
      areaDispatch(.mac(.failed))
    }
  }
}
