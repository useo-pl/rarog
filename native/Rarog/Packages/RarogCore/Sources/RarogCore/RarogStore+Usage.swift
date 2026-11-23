import Foundation
import RarogContract
import RarogTransport

// Odpytywanie limitów planu, obciążenia Maca (odczyt w `RarogStore+Mac`) i sonda możliwości
// serwera z nazwą tailnetu — jeden harmonogram. Właściciel: aktywność i lista. Rdzeń woła
// `syncUsagePolling()` przy zmianie fazy sceny, wznowieniu i wylogowaniu, a `probeVersionAfterHello()` po każdym
// `hello` strumienia globalnego.

/// Rytm odczytów — w jednym miejscu, wstrzykiwany (testy podają milisekundy).
public struct UsageTiming: Sendable, Equatable {
  /// Odświeżanie widocznych liczb, nazwy tailnetu i wersji serwera, gdy apka jest na wierzchu (co 15 s;
  /// odczyt serwera to milisekundy, bez cache'u odpowiedzi).
  public var refresh: Duration
  /// Ponowienie, gdy liczb albo nazwy tailnetu nie ma (serwer trzyma oba odczyty 60 s).
  public var retry: Duration
  /// Podłoga dla odczytu „od razu": wejście na wierzch i powrót łącza nie pytają częściej
  /// (migoczące Wi-Fi, szybkie przełączanie apek). Wspólna dla limitów i Maca.
  public var floor: Duration
  /// Odczyt obciążenia Maca — także po porażce: serwer odpowiada z pamięci, a próbnik CPU i tak
  /// zmienia liczbę co 10 s.
  public var mac: Duration
  /// Termin ważności liczb Maca od ostatniego UDANEGO odczytu (także po powrocie z tła): potem szkielet.
  public var macTTL: Duration

  public init(
    refresh: Duration = .seconds(15), retry: Duration = .seconds(60), floor: Duration = .seconds(10),
    mac: Duration = .seconds(30), macTTL: Duration = .seconds(120)
  ) {
    self.refresh = refresh
    self.retry = retry
    self.floor = floor
    self.mac = mac
    self.macTTL = macTTL
  }

  public static let production = UsageTiming()
}

/// Wynik jednego odczytu `GET /api/usage/details` (arkusz „Limity”).
public enum UsageDetailsOutcome: Sendable, Equatable {
  /// Odczyt limitów Claude Code; bez okien (`{}`) = Claude Code nie zostawił odczytu dla tego konta.
  case loaded(PlanUsage)
  /// Serwer sprzed trasy (404, 405) — szczegółów nie zna.
  case unsupported
  /// Sieć, odpowiedź spoza kontraktu, inny błąd albo utrata logowania.
  case failed

  /// Statusy serwera bez trasy szczegółów.
  static let unsupportedStatuses: Set<Int> = [404, 405]
}

/// Księgowość odpytywania (pole magazynu `usagePolling`). Jeden zegar na apkę.
struct UsagePolling {
  var timing = UsageTiming.production
  var loop: Task<Void, Never>?
  /// Sen pętli do najbliższego terminu. Anulowanie budzi pętlę, która liczy terminy od nowa.
  var nap: Task<Void, Never>?
  /// Jak pętla śpi do terminu. Terminy liczy zegar magazynu (`clock`), więc testy podają tu sen
  /// wirtualnego zegara: rytm sprawdzają krokami czasu, nie zegarem ściennym obciążonej maszyny.
  var sleep: @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }
  var lastUsageAttempt: Date?
  var lastVersionAttempt: Date?
  var lastMacAttempt: Date?
  /// Reads in flight (from the loop, from a tap, after `hello`), at most one of each kind. Logout cancels them,
  /// and the login guard (`isCurrentLogin`) drops a result or error of a read started before it.
  var usageRead: Task<Void, Never>?
  var versionRead: Task<Void, Never>?
  var macRead: Task<Void, Never>?
  /// Termin ważności liczb Maca (`RarogStore+Mac`) — osobne zadanie, nie obrót pętli.
  var macExpiry: Task<Void, Never>?
  /// Pętla właśnie wstała (wejście na wierzch, logowanie): pierwszy obrót czyta limity od razu.
  var entering = false
  /// Ostatnia sonda wyszła zaraz po powrocie łącza. Serwer trzyma nazwę tailnetu 60 s, więc mogła
  /// oddać starą (przełączenie tailnetu zrywa strumień) — następna po `retry`, nie po pełnym `refresh`.
  var versionRecheck = false
}

extension RarogStore {
  /// Rytm odczytów; testy podmieniają go przed `start()`.
  public var usageTiming: UsageTiming {
    get { usagePolling.timing }
    set { usagePolling.timing = newValue }
  }

  /// Tap w stopkę listy: limity i obciążenie Maca od razu, bez podłogi. Odczyt w drodze
  /// przyjmuje dołączających — szybkie stuknięcia nie mnożą żądań.
  public func refreshUsageNow() {
    Task {
      let mac = startMacRead()
      await fetchUsage()
      await mac?.value
      wakeUsageLoop()
    }
  }

  /// Pętla chodzi WYŁĄCZNIE przy zalogowaniu i apce na wierzchu (`active`): w tle i przy
  /// nieaktywnej scenie nikt liczb nie widzi, a każdy odczyt to żądanie do Maca.
  func syncUsagePolling() {
    guard state.auth == .loggedIn, areaPhase == .active else {
      usagePolling.loop?.cancel()
      usagePolling.loop = nil
      if state.auth != .loggedIn { forgetLoginReads() }
      return
    }
    guard usagePolling.loop == nil else { return }
    // Powrót z tła: liczby Maca starsze niż termin ważności znikają w tej samej klatce, nie po odczycie.
    expireMacIfDue(at: areaNow)
    usagePolling.entering = true
    // Słaba referencja przez cały sen: pętla nie trzyma magazynu przy życiu.
    usagePolling.loop = Task { [weak self] in
      while !Task.isCancelled {
        // Odczyt nie kończy się z anulowaniem pętli (zadanie odczytu jest osobne): pętla anulowana
        // w trakcie nie zasypia, żeby nie nadpisać snu pętli, która wstała po niej.
        guard let wait = await self?.pollDue(), !Task.isCancelled, let sleep = self?.usagePolling.sleep else { return }
        let nap = Task<Void, Never> { await sleep(wait) }
        self?.usagePolling.nap = nap
        await withTaskCancellationHandler { await nap.value } onCancel: { nap.cancel() }
      }
    }
  }

  /// Jeden harmonogram: odczyt spoza pętli (tap, sonda po `hello`) przesuwa terminy — 503 skraca
  /// odstęp do `retry`, sonda tuż po powrocie łącza zamawia kontrolną po minucie — więc pętla nie
  /// może spać do terminu policzonego przed nim. Pętla w trakcie odczytu liczy termin po nim sama.
  func wakeUsageLoop() {
    usagePolling.nap?.cancel()
  }

  /// Wylogowanie: odczyty w drodze anulowane, a ich wyniki odcina numer zalogowania
  /// (podbity przy wylogowaniu i logowaniu). Podłoga nie przeżywa: nowe logowanie czyta od razu.
  private func forgetLoginReads() {
    usagePolling.usageRead?.cancel()
    usagePolling.versionRead?.cancel()
    usagePolling.macRead?.cancel()
    usagePolling.macExpiry?.cancel()
    usagePolling.usageRead = nil
    usagePolling.versionRead = nil
    usagePolling.macRead = nil
    usagePolling.macExpiry = nil
    usagePolling.lastUsageAttempt = nil
    usagePolling.lastVersionAttempt = nil
    usagePolling.lastMacAttempt = nil
    usagePolling.versionRecheck = false
  }

  /// `hello` strumienia globalnego = połączenie (wróciło): sonda wersji od razu, z podłogą.
  func probeVersionAfterHello() {
    if let last = usagePolling.lastVersionAttempt,
      areaNow.timeIntervalSince(last) < usagePolling.timing.floor.timeInterval
    {
      // Bez sondy pętla i tak musi wrócić do terminu wersji: przy zerwanym strumieniu go nie liczyła.
      wakeUsageLoop()
      return
    }
    Task {
      await probeVersion(recheck: true)
      wakeUsageLoop()
    }
  }

  /// Jeden obrót pętli: odczyty, którym minął termin, i czas do następnego obrotu.
  ///
  /// Termin ważności liczb Maca idzie PIERWSZY: po powrocie z tła stare liczby znikają, zanim wyjdzie odczyt,
  /// a odczyt Maca startuje przed limitami i biegnie obok nich (limity potrafią czekać do 7 s na API).
  private func pollDue() async -> Duration {
    let entering = usagePolling.entering
    usagePolling.entering = false
    expireMacIfDue(at: areaNow)
    let mac = macDue(at: areaNow, entering: entering) ? startMacRead() : nil
    if usageDue(at: areaNow, entering: entering) { await fetchUsage() }
    if versionDue(at: areaNow) { await probeVersion(recheck: false) }
    await mac?.value
    return nextWait(at: areaNow)
  }

  private var usageInterval: Duration {
    state.planUsage.usage == nil ? usagePolling.timing.retry : usagePolling.timing.refresh
  }

  private var versionInterval: Duration {
    state.tailnet == nil || usagePolling.versionRecheck ? usagePolling.timing.retry : usagePolling.timing.refresh
  }

  private func usageDue(at now: Date, entering: Bool) -> Bool {
    guard let last = usagePolling.lastUsageAttempt else { return true }
    let since = now.timeIntervalSince(last)
    return since >= (entering ? usagePolling.timing.floor : usageInterval).timeInterval
  }

  /// Bez żywego strumienia apka nie pyta o wersję: odpowiedź i tak by nie doszła.
  private func versionDue(at now: Date) -> Bool {
    guard state.global == .online else { return false }
    guard let last = usagePolling.lastVersionAttempt else { return true }
    return now.timeIntervalSince(last) >= versionInterval.timeInterval
  }

  /// Termin wersji liczy się tylko przy żywym strumieniu: bez niego `versionDue` odmawia, więc miniony
  /// termin budziłby pętlę co 20 ms przez całą przerwę. Powrót łącza (`hello`) budzi pętlę sam.
  private func nextWait(at now: Date) -> Duration {
    var waits = [usageInterval.timeInterval - now.timeIntervalSince(usagePolling.lastUsageAttempt ?? now)]
    if state.global == .online {
      if let last = usagePolling.lastVersionAttempt {
        waits.append(versionInterval.timeInterval - now.timeIntervalSince(last))
      } else {
        waits.append(usagePolling.timing.retry.timeInterval)
      }
    }
    waits += macWaits(at: now)
    let seconds = max(waits.min() ?? 0, 0.02)
    return .milliseconds(Int((seconds * 1000).rounded(.up)))
  }

  /// `GET /api/usage` → stan linii limitów. 503 kasuje liczby, sieć je przygasza. Wołający w trakcie
  /// odczytu czeka na ten w drodze, zamiast słać drugi.
  func fetchUsage() async {
    guard state.auth == .loggedIn else { return }
    if usagePolling.usageRead == nil {
      let login = currentLogin
      let transport = areaTransport
      usagePolling.lastUsageAttempt = areaNow
      usagePolling.usageRead = Task { [weak self] in
        let result: Result<PlanUsage, TransportError>
        do throws(TransportError) {
          result = .success(try await transport.usage())
        } catch {
          result = .failure(error)
        }
        self?.finishUsage(result, login: login)
      }
    }
    await usagePolling.usageRead?.value
  }

  private func finishUsage(_ result: Result<PlanUsage, TransportError>, login: Int) {
    // Odpowiedź sprzed wylogowania nie ma prawa wrócić na ekran ani wylogować nowego.
    guard isCurrentLogin(login) else { return }
    usagePolling.usageRead = nil
    guard state.auth == .loggedIn else { return }
    let outcome: PlanUsageOutcome
    switch result {
    case let .success(usage):
      outcome = .loaded(usage)
    case let .failure(.http(failure)) where failure.status == 503:
      outcome = .unavailable
    case .failure(.cancelled):
      return
    case .failure(.unauthorized):
      handleUnauthorized(since: login)
      return
    case .failure:
      outcome = .failed
    }
    areaDispatch(.planUsageResult(outcome, at: areaNow))
  }

  /// `GET /api/usage/details` dla arkusza „Limity” komendy apki `/usage`: jeden odczyt przy każdym
  /// otwarciu, bez odpytywania i bez śladu w stanie apki — wynik trzyma arkusz. 401 idzie zwykłą drogą utraty
  /// logowania; odpowiedź sprzed wylogowania albo ponownego logowania nie wraca jako odczyt.
  public func loadUsageDetails() async -> UsageDetailsOutcome {
    guard state.auth == .loggedIn else { return .failed }
    let login = currentLogin
    let result: Result<PlanUsage, TransportError>
    do throws(TransportError) {
      result = .success(try await transport.usageDetails())
    } catch {
      result = .failure(error)
    }
    guard isCurrentLogin(login) else { return .failed }
    switch result {
    case let .success(usage): return .loaded(usage)
    case let .failure(.http(failure)) where UsageDetailsOutcome.unsupportedStatuses.contains(failure.status):
      return .unsupported
    case .failure(.unauthorized):
      handleUnauthorized(since: login)
      return .failed
    case .failure:
      return .failed
    }
  }

  /// `GET /api/version` → flagi możliwości, nazwa tailnetu, system maszyny, wersja serwera i para iroh serwera
  /// (zapis w miejscu, `RarogStore+Pairing`). Porażka zostawia ostatnią znaną wartość; ponowienie robi pętla.
  /// Wołający w trakcie sondy czeka na tę w drodze.
  func probeVersion(recheck: Bool) async {
    guard state.auth == .loggedIn else { return }
    if usagePolling.versionRead == nil {
      let login = currentLogin
      let transport = areaTransport
      // Droga i para iroh przy wysłaniu: para z odpowiedzi liczy się tylko przy tych samych.
      let stamp = versionProbeStamp()
      usagePolling.lastVersionAttempt = areaNow
      usagePolling.versionRecheck = recheck
      usagePolling.versionRead = Task { [weak self] in
        let result: Result<VersionInfo, TransportError>
        do throws(TransportError) {
          result = .success(try await transport.version())
        } catch {
          result = .failure(error)
        }
        self?.finishVersion(result, login: login, stamp: stamp)
      }
    } else if recheck {
      // Sonda po `hello` dołącza do odczytu, który wyszedł PRZED powrotem łącza — jego odpowiedź mogła
      // nie znać nowej nazwy tailnetu, więc kontrolna i tak po `retry`, nie po pełnym odstępie.
      usagePolling.versionRecheck = true
    }
    await usagePolling.versionRead?.value
  }

  private func finishVersion(_ result: Result<VersionInfo, TransportError>, login: Int, stamp: VersionProbeStamp) {
    guard isCurrentLogin(login) else { return }
    usagePolling.versionRead = nil
    guard state.auth == .loggedIn else { return }
    switch result {
    case let .success(info):
      areaDispatch(.versionProbed(info))
      rememberServerSystem()
      adoptServerIroh(info.iroh, sent: stamp)
    case .failure(.unauthorized): handleUnauthorized(since: login)
    case .failure: break
    }
  }
}
