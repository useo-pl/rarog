import Foundation
import RarogContract
import RarogTransport

// Zbiorcza Live Activity urządzenia. Właściciel: Live Activity. System
// (ActivityKit) wchodzi przez `ActivityRequesting` (`LiveActivitySystem.swift`); stan STARTOWY kafla
// i warunek „zajęty" składa `Selectors+LiveActivity.swift` tą samą regułą co serwer.
//
// Cykl życia:
// - START: apka na wierzchu, zalogowana, serwer ma kanał APNs, system pozwala na aktywności, lista
//   bieżącego połączenia i COŚ czeka, pracuje albo mieli w tle (przebieg workflow z agentem w locie).
//   Bez ostatniego warunku kafel „nic nie czeka" wstawałby przy każdym otwarciu apki i gasł po 30 min —
//   dokładnie pusty kafel odrzucony decyzją. Stan startowy niesie same liczniki i cel tapnięcia; resztę
//   (przebiegi, limity, Mac) dosyła serwer zaraz po rejestracji tokenu.
//   Jeden kafel: przed startem kończą się osierocone (z poprzedniego procesu, także zakończone, a jeszcze
//   widoczne na ekranie blokady). `pushType: .token`. Osierocone kończą się NAJPIERW (asynchronicznie), start
//   idzie dopiero po nich, ze sprawdzeniem warunków od nowa.
// - TOKEN: `pushTokenUpdates` (pierwszy i każdy po rotacji) → `POST /api/push/live-activity` z tokenem
//   urządzenia, który serwer już przyjął (inaczej 409 `apns-device-unknown`). Także W TLE: token przychodzi
//   chwilę po starcie (człowiek mógł już zamknąć apkę), a rotację system zgłasza w tle i daje na nią czas —
//   żądanie idzie wtedy w pracy w tle i wymaga tylko zalogowania i zgodności, nie żywej listy. Po każdej
//   rejestracji urządzenia (start, powrót z tła, nowy token, zmiana zgody) token aktywności idzie znowu —
//   serwer odpowiada `unchanged`, a gdy zgubił blok (410, rotacja), ma go z powrotem.
// - AKTUALIZACJA: pełną treść wysyła serwer pushem; apka poza tłem (na wierzchu i `inactive`) przy świeżej
//   liście zapisuje na kaflu SAMA liczniki, gdy w obrazie listy strumienia globalnego zmienią się wobec ostatnio
//   zleconych — zaraz po decyzji kafel pokazuje nowy licznik bez czekania na dostawę pusha. Zapis to nakładka
//   liczników na treść, którą system trzyma (przebiegi, limity, Mac, `updatedEpoch` i `stale-date` zostają
//   z pusha), ze znacznikiem `asOf` = najnowszy `stateSince` tego obrazu do pełnej sekundy minus 1 s (zegar
//   serwera, `AppState.liveActivityAsOf`): system odrzuca zapis starszy niż ostatni push, więc kafel nie cofa się
//   za serwer, a push wysłany po przejściu zawsze wygrywa z zapisem. Push zapisu NIE budzi (przywracanie liczników
//   po pushu nadpisałoby nowszy pilny push). Jeden pisarz na aktywność: bez zapisu, gdy kafel ma już te liczniki
//   albo znany znacznik kafla jest nowszy; inaczej zapis, sprawdzenie, czy system go przyjął, potem najwyżej jeden
//   następny z najnowszymi licznikami; koniec aktywności, wylogowanie i nowa aktywność unieważniają go (id). Push
//   starszy niż zapis, który przyszedł w trakcie `update`, wraca na kafel jednym zapisem naprawczym (pola pusha,
//   liczniki zapisu, znacznik +1 ms).
// - KONIEC: po 30 min ciszy (nic nie czeka, nic nie pracuje, żaden przebieg w tle nie mieli — `isBusy`
//   serwera) mierzonej NA WIERZCHU na świeżej liście (powrót z tła
//   zaczyna zegar od nowa — wcześniej i tak kończy serwer, który liczy ciszę bez przerw), przy
//   wylogowaniu (lokalnie, także osierocone — trasa `…/end` wymaga klucza, który właśnie odmówił),
//   gdy serwer nie ma kanału (`apnsEnabled: false`: nikt by kafla nie aktualizował — też osierocone
//   z poprzedniego procesu) i gdy system
//   zakończy ją sam (8 h, `end` z serwera, człowiek) — wtedy stan znika, apka od razu woła `end`, żeby
//   zakończony kafel nie wisiał na ekranie blokady (Apple zostawia go tam do 4 h; lepiej brak kafla niż stary),
//   a nowa aktywność wstaje przy najbliższej okazji spełniającej warunki startu.
// - SŁOWO MASZYNY: system serwera jedzie w atrybutach startu, a atrybutów żywej aktywności zmienić się nie da.
//   Gdy słowo z bieżącego systemu (``AppState/serverSystem``) różni się od słowa kafla (pierwsza sonda po
//   aktualizacji apki na VPS-ie, kafel postawiony przed sondą) — koniec kafla na wierzchu (z `…/end`) i nowy przy
//   warunkach startu. Zmiana systemu bez zmiany słowa (`linux` → `other`, `nil` → `macos`) kafla nie rusza.

/// Rytm Live Activity — wstrzykiwany (testy podają zegar wirtualny).
public struct LiveActivityTiming: Sendable {
  /// Cisza (nic nie czeka, nie pracuje ani nie mieli w tle) tak długa kończy aktywność.
  public var quietEnd: Duration
  /// Po tylu sekundach od startu kafel pokaże dane jako nieświeże, jeśli serwer nic nie dośle (jak
  /// `stale-date` serwera).
  public var staleAfter: TimeInterval
  /// Sen zegara ciszy. Termin liczy zegar magazynu (`clock`), więc testy podają tu sen wirtualnego zegara.
  public var sleep: @Sendable (Duration) async -> Void

  public init(
    quietEnd: Duration = .seconds(30 * 60), staleAfter: TimeInterval = 15 * 60,
    sleep: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }
  ) {
    self.quietEnd = quietEnd
    self.staleAfter = staleAfter
    self.sleep = sleep
  }
}

/// Księgowość Live Activity (pole magazynu `liveRuntime`).
struct LiveActivityRuntime {
  var system: (any ActivityRequesting)?
  var timing = LiveActivityTiming()
  /// Aktywność TEGO procesu; inne żywe w systemie są osierocone.
  var activityId: String?
  /// System serwera w atrybutach tej aktywności (słowo maszyny na kaflu).
  var activitySystem: ServerSystem?
  /// Token aktualizacji aktywności (hex).
  var updateToken: String?
  /// Od kiedy (na wierzchu, na świeżej liście) nic nie czeka, nie pracuje ani nie mieli w tle.
  var quietSince: Date?
  var quietWatch: Task<Void, Never>?
  /// System odmówił startu (wyłączone w Ustawieniach, limit aktywności) — próba wraca po powrocie na wierzch.
  var startRefused = false
  /// Ostatnia linia „na wierzchu” w `client.log`. Ślady mają wspólny budżet (20 na godzinę), a powrotów na
  /// wierzch bywa więcej (Centrum sterowania, przełącznik apek), więc linia idzie najwyżej raz na ``ageTraceGap``.
  var ageTracedAt: Date?
  static let ageTraceGap: TimeInterval = 15 * 60
  /// Po wylogowaniu albo bez kanału wszystkie aktywności już zakończone (nie pytamy systemu przy każdej
  /// ramce); zdejmuje go powrót warunków (zalogowanie z kanałem).
  var cleared = false
  /// Osierocone w trakcie kończenia przed startem — start czeka na nie (limit aktywności systemu).
  var endingOrphans: Task<Void, Never>?
  /// Osierocone, którym `end` już się skończył, i nasze zakończone z zewnątrz (ich `end` jest już zlecony) — nie
  /// liczą się drugi raz, nawet gdy system dalej podaje je na liście pokazanych.
  var endedOrphans: Set<String> = []
  /// Rejestracja tokenu aktywności przyjęta przez serwer (od ostatniej rejestracji urządzenia).
  var registered: LiveActivityRegisterBody?
  /// Ostatnia rejestracja zapisana w `client.log` — linia tylko przy nowej aktywności albo nowym tokenie.
  var announced: LiveActivityRegisterBody?
  var registering: Task<Void, Never>?
  /// Rejestracja padła (sieć, 5xx, bramka): następna próba przy następnym połączeniu strumienia listy.
  var retryAfterReconnect = false
  /// 409 `apns-device-unknown` już raz wysłał urządzenie do ponownej rejestracji w tym połączeniu.
  var deviceRetried = false
  /// Liczniki ostatnio zlecone pisarzowi (przy starcie: obrazu listy strumienia globalnego): zapis budzi wyłącznie
  /// ich zmiana w tym obrazie.
  var orderedCounts: LiveActivityCounts?
  /// `updatedEpoch` treści startowej — zegar TELEFONU, nie znacznik systemu (`request` znacznika nie ma), więc pisarz
  /// nie porównuje z nim znacznika zapisu. Treść z pusha ma `updatedEpoch` = `aps.timestamp`.
  var startEpoch: Int?
  /// Zapis czekający na pisarza — zawsze najnowsze liczniki; starszy czekający przepada.
  var pendingWrite: LiveActivityWrite?
  /// Pisarz: jedno zadanie zapisu na aktywność.
  var writer: Task<Void, Never>?
  /// Zapis w locie: `updatedEpoch` jego bazy (`Int.min` przy treści startowej z zegarem telefonu) — okno, w którym
  /// wejście `content` nowsze od bazy to push, którego pola zapis nadpisze, jeśli system przyjmie zapis.
  var writeWindow: Int?
  /// Najnowszy taki push z okna zapisu w locie (nie echo zapisu apki) — baza zapisu naprawczego.
  var pushDuringWrite: LiveActivityContent?
  /// Ostatni zapis przyjęty przez system i treści zapisane w tej aktywności — do zapisów cofniętych.
  var acceptedWrite: LiveActivityWrite?
  var writtenStates: Set<LiveActivityContentState> = []
  /// Zapisy z apki od ostatniej linii „na wierzchu”.
  var writeStats = LiveActivityWriteStats()
}

/// Zapis liczników z apki: stan z obrazu listy strumienia globalnego (z niego idą wyłącznie liczniki) i znacznik
/// z zegara serwera w pełnych sekundach (``AppState/liveActivityWrite(now:)``).
struct LiveActivityWrite {
  let local: LiveActivityContentState
  let asOf: Date

  var counts: LiveActivityCounts { LiveActivityCounts(local) }
}

/// Zapisy z apki do dopisku linii „na wierzchu” w `client.log`. Zlecony = wywołany `update` albo zapis odrzucony
/// bez wywołania (znany znacznik kafla nowszy), także naprawczy; zapisu, gdy kafel ma już tę treść (przy zwykłym
/// zapisie: te liczniki), nie ma i się nie liczy.
/// Przyjęty = znacznik nie starszy niż znany i system pokazuje po zapisie dokładnie jego treść. Cofnięty = wejście
/// `content` z licznikami innymi niż ostatni zapis przyjęty, z `updatedEpoch` starszym niż jego znacznik, które
/// system nadal pokazuje, a które nie jest żadnym zapisem apki z tej aktywności (własne echa się nie liczą).
/// Cofnięty przeczy dokumentacji Apple.
struct LiveActivityWriteStats {
  var issued = 0
  var accepted = 0
  var rejected = 0
  var reverted = 0
}

extension RarogStore {
  /// Rytm Live Activity; testy podmieniają go przed `start()`.
  public var liveActivityTiming: LiveActivityTiming {
    get { liveRuntime.timing }
    set { liveRuntime.timing = newValue }
  }

  /// Wpina Live Activity systemu. Apka woła RAZ, przed `start()`.
  public func attachActivities(_ system: any ActivityRequesting) {
    liveRuntime.system = system
    system.observe { [weak self] event in self?.liveActivityEvent(event) }
  }

  /// Aktywność tego procesu (`nil` = brak). Dla testów i diagnostyki.
  public var liveActivityId: String? { liveRuntime.activityId }

  // MARK: - Wejścia systemu

  func liveActivityEvent(_ event: ActivitySystemEvent) {
    switch event {
    case let .token(id, data):
      guard id == liveRuntime.activityId else { return }
      let hex = PushRouting.hex(data)
      guard !hex.isEmpty, hex != liveRuntime.updateToken else { return }
      let rotation = liveRuntime.updateToken != nil
      liveRuntime.updateToken = hex
      // Fakt, nigdy wartość: token to adres, pod który da się wysłać aktualizację na ekran blokady.
      trace("live-activity: token aktywności od systemu\(rotation ? " (rotacja)" : "")")
      attemptLiveActivityRegistration()
    case let .ended(id):
      // Nasz własny `end` już wyczyścił stan — tu tylko koniec z zewnątrz.
      guard id == liveRuntime.activityId else { return }
      // Zakończona (8 h systemu, `end` z serwera) zostaje na ekranie blokady jeszcze do 4 h z zamrożoną treścią,
      // obok nowego kafla — więc `end` od razu ją zdejmuje (przy `dismissed` bez skutku). Zakończona nie liczy się
      // do żywych aktywności apki, więc start nowej na ten koniec nie czeka, a sprzątanie osieroconych jej pomija.
      liveRuntime.endedOrphans.insert(id)
      if let system = liveRuntime.system { Task { await system.end(id) } }
      clearLiveActivity()
      trace("live-activity: koniec z zewnątrz (system, serwer albo człowiek)")
      syncLiveActivity()
    case let .content(id, shown):
      // Push nie budzi zapisu: tu licznik zapisów cofniętych i push z okna zapisu w locie.
      guard id == liveRuntime.activityId else { return }
      notePushDuringWrite(shown)
      noteLiveActivityContent(id, shown.state)
    }
  }

  // MARK: - Cykl (woła rdzeń)

  /// Po każdej zmianie stanu (`dispatch`), fazy sceny i zalogowania: start, zegar ciszy, zapis liczników, koniec
  /// bez kanału i rejestracja tokenu. Tanie: przy żywej aktywności przelicza „zajęty" i liczniki; zapis idzie tylko
  /// przy ich zmianie.
  func syncLiveActivity() {
    guard let system = liveRuntime.system else { return }
    switch state.auth {
    case .unknown:
      return
    case .loggedOut:
      endEveryLiveActivity(system, reason: "wylogowanie")
      return
    case .loggedIn:
      break
    }
    if state.capabilities?.apns == false, !state.push.simulatedChannel {
      // `RAROG_PUSH=0` albo serwer bez kluczy: nikt by kafla nie aktualizował — także osieroconego
      // z poprzedniego procesu. Serwer kanału nie ma, więc i trasy `…/end` nie ma po co wołać.
      endEveryLiveActivity(system, reason: "brak kanału APNs na serwerze")
      return
    }
    liveRuntime.cleared = false
    guard areaPhase != .background, let busy = state.liveActivityBusy else {
      stopQuietWatch()
      return
    }
    if let old = liveRuntime.activityId, areaPhase == .active, liveRuntime.endingOrphans == nil,
      ServerMachine(liveRuntime.activitySystem) != ServerMachine(state.serverSystem)
    {
      // Atrybutów żywej aktywności zmienić się nie da. Stary kafel kończy tor osieroconych: jeden `end`, a o nowym
      // kaflu warunki startu decydują dopiero po jego końcu (system liczy żywe aktywności apki).
      finishLiveActivity("inne słowo maszyny serwera", tellServer: true, endHere: false)
      endOrphans(system, [old])
      return
    }
    if let id = liveRuntime.activityId {
      trackQuiet(busy: busy)
      orderLiveActivityWrite(system, activity: id)
    } else if busy, areaPhase == .active, state.apnsChannel, !liveRuntime.startRefused,
      let content = state.liveActivityInput(now: areaNow)
    {
      startLiveActivity(system, content: content)
    }
    attemptLiveActivityRegistration()
  }

  /// Zmiana fazy sceny: tło zatrzymuje zegar ciszy (apka nie widzi listy), powrót na wierzch daje
  /// systemowi drugą szansę po odmowie startu (człowiek mógł włączyć aktywności w Ustawieniach) i mówi
  /// w `client.log`, jak stara jest treść żywego kafla.
  func liveActivityScenePhaseChanged(from previous: ScenePhase, to next: ScenePhase) {
    if next == .background { stopQuietWatch() }
    if previous != .active, next == .active {
      liveRuntime.startRefused = false
      traceDisplayedLiveActivityAge()
    }
    syncLiveActivity()
  }

  /// Detektor zatrzymanego kafla: wiek treści, którą system trzyma dla NASZEJ żywej
  /// aktywności. Serwer wysyła co najmniej heartbeat co 10 min, więc wiek ponad ~15 min przy liniach „doręczone”
  /// w `server.log` znaczy, że system przestał przyjmować aktualizacje (budżet). Wiek liczy zegar magazynu minus
  /// `updatedEpoch` serwera (zapis z apki go nie zmienia); zegary urządzenia i Maca mogą się rozjechać, więc
  /// liczba bywa ujemna — zostaje taka, jak wyszła, bo przycięcie do zera ukryłoby rozjazd w jedną stronę,
  /// a w drugą nie. Dopisek liczy zapisy z apki od poprzedniej takiej linii (zlecone, przyjęte, odrzucone,
  /// cofnięte — ``LiveActivityWriteStats``); nowa linia w budżecie śladów na nie nie idzie.
  private func traceDisplayedLiveActivityAge() {
    guard let system = liveRuntime.system, let id = liveRuntime.activityId else { return }
    let now = areaNow
    // Zegar cofnięty (zmiana czasu) otwiera nowe okno, jak budżet śladów w `ContractReporter`.
    if let last = liveRuntime.ageTracedAt, now >= last,
      now.timeIntervalSince(last) < LiveActivityRuntime.ageTraceGap
    {
      return
    }
    liveRuntime.ageTracedAt = now
    let frequent = system.frequentPushesEnabled ? "tak" : "nie"
    let age = system.displayedContent(id).map { Int(now.timeIntervalSince1970.rounded(.down)) - $0.state.updatedEpoch }
    let writes = liveRuntime.writeStats
    liveRuntime.writeStats = LiveActivityWriteStats()
    trace(
      "live-activity: na wierzchu — treść kafla \(age.map { "sprzed \($0) s" } ?? "nieznana"), częste aktualizacje:"
        + " \(frequent), zapisy z apki od poprzedniej: \(writes.issued) (przyjęte \(writes.accepted),"
        + " odrzucone \(writes.rejected), cofnięte \(writes.reverted))")
  }

  /// Strumień listy właśnie się otworzył: rejestracja, która padła w poprzednim połączeniu, idzie znowu.
  func liveActivityConnectionOpened() {
    liveRuntime.retryAfterReconnect = false
    liveRuntime.deviceRetried = false
  }

  /// Serwer przyjął token urządzenia (`POST /api/push/apns`): token aktywności idzie znowu (idempotentnie).
  func liveActivityDeviceRegistered() {
    liveRuntime.registered = nil
    attemptLiveActivityRegistration()
  }

  /// Wylogowanie (`handleUnauthorized`): żądania w drodze anulowane; aktywności kończy `syncLiveActivity`
  /// przy `loggedOut` (ten sam `dispatch`).
  func forgetLiveActivity() {
    liveRuntime.registering?.cancel()
    liveRuntime.registering = nil
    liveRuntime.retryAfterReconnect = false
    liveRuntime.deviceRetried = false
    liveRuntime.startRefused = false
    if let system = liveRuntime.system { endEveryLiveActivity(system, reason: "wylogowanie") }
  }

  // MARK: - Wnętrze

  private func staleDate() -> Date {
    areaNow.addingTimeInterval(liveRuntime.timing.staleAfter)
  }

  private func startLiveActivity(_ system: any ActivityRequesting, content: LiveActivityContentState) {
    guard system.activitiesEnabled else {
      liveRuntime.startRefused = true
      trace("live-activity: wyłączone w Ustawieniach systemu — bez kafla")
      return
    }
    // Jeden kafel na urządzeniu: osierocone z poprzedniego procesu (żywe i zakończone, a jeszcze widoczne)
    // kończą się PRZED nową (koniec jest asynchroniczny, a system liczy żywe aktywności apki), potem warunki
    // startu sprawdzają się od nowa. Serwer dostanie nowy `activityId`, który zastępuje stary blok w rejestrze.
    guard liveRuntime.endingOrphans == nil else { return }
    let orphans = system.shownActivityIds().filter { !liveRuntime.endedOrphans.contains($0) }
    if !orphans.isEmpty {
      endOrphans(system, orphans)
      return
    }
    do {
      let serverSystem = state.serverSystem
      let id = try system.request(LiveActivityContent(state: content, staleDate: staleDate()), serverSystem: serverSystem)
      liveRuntime.activityId = id
      liveRuntime.activitySystem = serverSystem
      liveRuntime.updateToken = nil
      liveRuntime.registered = nil
      // Liczniki startu są już na kaflu — pisarz rusza dopiero przy zmianie liczników obrazu listy strumienia
      // globalnego. Start liczy z ``AppState/sessions``, więc punktem odniesienia jest obraz, gdy go znamy: inaczej
      // strumień oglądanej sesji, który wyprzedził globalny, zaraz po starcie cofnąłby kafel zapisem.
      liveRuntime.orderedCounts = state.liveActivityWrite(now: areaNow)?.counts ?? LiveActivityCounts(content)
      liveRuntime.startEpoch = content.updatedEpoch
      trace(
        "live-activity: start (czeka \(content.waiting), pracuje \(content.working), skończyło \(content.finished),"
          + " częste aktualizacje: \(system.frequentPushesEnabled ? "tak" : "nie"))")
      // Start idzie wyłącznie przy „zajętym" — zegar ciszy jeszcze nie rusza.
      trackQuiet(busy: true)
    } catch {
      liveRuntime.startRefused = true
      let failure = error as NSError
      trace("live-activity: system odmówił startu (\(failure.domain) \(failure.code))")
    }
  }

  /// Kończy podane aktywności jednym śledzonym zadaniem i dopiero po ich końcu sprawdza warunki od nowa.
  private func endOrphans(_ system: any ActivityRequesting, _ orphans: [String]) {
    liveRuntime.endingOrphans = Task { [weak self] in
      for orphan in orphans { await system.end(orphan) }
      // Wylogowanie albo brak kanału w trakcie: nowy okres sam zdecyduje o starcie.
      guard let self, !Task.isCancelled else { return }
      self.liveRuntime.endedOrphans.formUnion(orphans)
      self.liveRuntime.endingOrphans = nil
      self.syncLiveActivity()
    }
  }

  /// Koniec NASZEJ aktywności z powodu rdzenia (cisza, brak kanału); `tellServer` = `POST …/end`, żeby
  /// serwer przestał ją aktualizować (wymaga ważnego klucza i zarejestrowanego urządzenia). `endHere: false`:
  /// lokalny koniec robi wołający (``endOrphans(_:_:)``), tu tylko stan i serwer.
  private func finishLiveActivity(_ reason: String, tellServer: Bool, endHere: Bool = true) {
    guard let system = liveRuntime.system, let id = liveRuntime.activityId else { return }
    let device = pushRuntime.registeredToken
    if endHere { Task { await system.end(id) } }
    clearLiveActivity()
    trace("live-activity: koniec (\(reason))")
    guard tellServer, let device, pushRequestsReady else { return }
    let login = currentLogin
    let transport = transport
    Task { [weak self] in
      do throws(TransportError) {
        try await transport.endLiveActivity(LiveActivityEndBody(deviceToken: device, activityId: id))
      } catch .unauthorized {
        self?.handleUnauthorized(since: login)
      } catch {
        // Best-effort: serwer zakończy ją sam po swoich 30 min ciszy albo po 410 z APNs.
      }
    }
  }

  /// Wylogowanie, brak zalogowania przy starcie i serwer bez kanału: żaden kafel nie zostaje (także osierocone,
  /// żywe i zakończone, a jeszcze widoczne). Raz na taki okres — `cleared` zdejmuje dopiero zalogowanie z kanałem.
  private func endEveryLiveActivity(_ system: any ActivityRequesting, reason: String) {
    guard !liveRuntime.cleared else { return }
    liveRuntime.cleared = true
    liveRuntime.endingOrphans?.cancel()
    liveRuntime.endingOrphans = nil
    var ids = system.shownActivityIds()
    if let id = liveRuntime.activityId, !ids.contains(id) { ids.append(id) }
    clearLiveActivity()
    guard !ids.isEmpty else { return }
    Task {
      for id in ids { await system.end(id) }
    }
    trace("live-activity: koniec (\(reason))")
  }

  /// Stan po końcu aktywności: nic nie pokazane, nic nie zarejestrowane, nic nie zapisuje, zegar ciszy stoi.
  /// Licznik zapisów do linii „na wierzchu” zostaje (liczy od poprzedniej linii, nie od aktywności).
  private func clearLiveActivity() {
    liveRuntime.activityId = nil
    liveRuntime.activitySystem = nil
    liveRuntime.updateToken = nil
    liveRuntime.registered = nil
    liveRuntime.registering?.cancel()
    liveRuntime.registering = nil
    liveRuntime.writer?.cancel()
    liveRuntime.writer = nil
    liveRuntime.pendingWrite = nil
    liveRuntime.orderedCounts = nil
    liveRuntime.startEpoch = nil
    liveRuntime.writeWindow = nil
    liveRuntime.pushDuringWrite = nil
    liveRuntime.acceptedWrite = nil
    liveRuntime.writtenStates = []
    stopQuietWatch()
  }

  // MARK: - Zapis liczników z apki

  /// Zlecenie zapisu (z `syncLiveActivity`: poza tłem, własna aktywność, świeża lista). Budzi je WYŁĄCZNIE zmiana
  /// liczników obrazu listy strumienia globalnego wobec ostatnio zleconych — nie wobec kafla i nie push, bo
  /// przywracanie liczników po pushu nadpisałoby nowszy pilny push, zanim ramka listy dotrze; ramka strumienia
  /// oglądanej sesji i odpowiedź HTTP też nie (``AppState/globalList``). Pisarz w toku dostaje najnowsze na potem.
  private func orderLiveActivityWrite(_ system: any ActivityRequesting, activity id: String) {
    guard let write = state.liveActivityWrite(now: areaNow) else { return }
    guard write.counts != liveRuntime.orderedCounts else { return }
    liveRuntime.orderedCounts = write.counts
    liveRuntime.pendingWrite = write
    guard liveRuntime.writer == nil else { return }
    liveRuntime.writer = Task { [weak self] in await self?.runLiveActivityWriter(system, activity: id) }
  }

  /// Pisarz: zapis po zapisie, zawsze najnowszy czekający. Treść systemu czyta tuż przed zapisem (push, który
  /// przyjdzie później, ma nowszy znacznik i system ten zapis odrzuci). Kafel z tą samą treścią — bez zapisu; znany
  /// znacznik kafla nowszy niż zapis — odrzucony bez `update` (system i tak by go odrzucił, a równa treść po `update`
  /// nie dowodziłaby przyjęcia). Po zapisie sprawdza, czy system go przyjął. Id aktywności jest generacją: koniec,
  /// wylogowanie albo nowa aktywność w trakcie `update` — stare zadanie kończy się bez śladu.
  ///
  /// Zapis NAPRAWCZY: push nowszy od bazy zapisu, ale nie od jego znacznika, który przyszedł w trakcie `update`,
  /// przegrywa z przyjętym zapisem — kafel wraca do pól starej bazy (limity, przebiegi, `updatedEpoch`, `staleDate`).
  /// Wtedy idzie od razu JEDEN zapis tych samych liczników na treść tego pusha ze znacznikiem o 1 ms nowszym (wciąż
  /// przed sekundą przejścia, więc push wysłany po przejściu dalej wygrywa), zanim pisarz weźmie czekające liczniki
  /// (te biorą bazę z kafla, już naprawionego). Naprawczy liczy się i klasyfikuje jak każdy zapis, sam naprawy nie ma.
  private func runLiveActivityWriter(_ system: any ActivityRequesting, activity id: String) async {
    var repair: (write: LiveActivityWrite, base: LiveActivityContent)?
    while !Task.isCancelled, liveRuntime.activityId == id {
      let job: (write: LiveActivityWrite, base: LiveActivityContent?)
      if let next = repair {
        job = (next.write, next.base)
        repair = nil
      } else if let pending = liveRuntime.pendingWrite {
        liveRuntime.pendingWrite = nil
        job = (pending, nil)
      } else {
        break
      }
      let (write, base) = job
      guard let displayed = system.displayedContent(id) else { break }
      let content = LiveActivityInput.overlay(displayed: base ?? displayed, local: write.local)
      guard content != displayed else { continue }
      liveRuntime.writeStats.issued += 1
      if let known = knownLiveActivityStamp(displayed), write.asOf < known {
        liveRuntime.writeStats.rejected += 1
        continue
      }
      liveRuntime.writtenStates.insert(content.state)
      let baseEpoch = (base ?? displayed).state.updatedEpoch
      liveRuntime.writeWindow = baseEpoch == liveRuntime.startEpoch ? Int.min : baseEpoch
      liveRuntime.pushDuringWrite = nil
      await system.update(id, state: content.state, staleDate: content.staleDate, timestamp: write.asOf)
      guard !Task.isCancelled, liveRuntime.activityId == id else { return }
      let pushed = liveRuntime.pushDuringWrite
      liveRuntime.writeWindow = nil
      liveRuntime.pushDuringWrite = nil
      if system.displayedContent(id)?.state == content.state {
        liveRuntime.writeStats.accepted += 1
        liveRuntime.acceptedWrite = write
        // Push z okna przegrał z zapisem (znacznik nie nowszy niż zapis): jego pola wracają zapisem naprawczym.
        if base == nil, let pushed, TimeInterval(pushed.state.updatedEpoch) <= write.asOf.timeIntervalSince1970 {
          repair = (LiveActivityWrite(local: write.local, asOf: write.asOf.addingTimeInterval(0.001)), pushed)
        }
      } else {
        // Push nowszy niż znacznik (albo aktywność już zniknęła): kafel zostaje przy serwerze.
        liveRuntime.writeStats.rejected += 1
      }
    }
    guard liveRuntime.activityId == id else { return }
    liveRuntime.writer = nil
    liveRuntime.pendingWrite = nil
  }

  /// Wejście `content` w trakcie zapisu z apki: push nowszy od bazy zapisu (nie echo zapisu apki) — najnowszy
  /// zostaje bazą ewentualnego zapisu naprawczego.
  private func notePushDuringWrite(_ shown: LiveActivityContent) {
    guard let window = liveRuntime.writeWindow, shown.state.updatedEpoch > window,
      !liveRuntime.writtenStates.contains(shown.state),
      (liveRuntime.pushDuringWrite?.state.updatedEpoch ?? Int.min) < shown.state.updatedEpoch
    else { return }
    liveRuntime.pushDuringWrite = shown
  }

  /// Najnowszy znacznik, który system na pewno przyjął: `updatedEpoch` treści na kaflu (push niesie go jako
  /// `aps.timestamp`, a zapis apki przepisuje go z pusha) i znacznik ostatniego przyjętego zapisu. Treść startowa
  /// ma `updatedEpoch` z zegara telefonu, więc się nie liczy; `nil` = żadnego znanego znacznika.
  private func knownLiveActivityStamp(_ displayed: LiveActivityContent) -> Date? {
    let epoch = displayed.state.updatedEpoch
    let shown = epoch == liveRuntime.startEpoch ? nil : Date(timeIntervalSince1970: TimeInterval(epoch))
    return [shown, liveRuntime.acceptedWrite?.asOf].compactMap { $0 }.max()
  }

  /// Wejście `content`: zapis COFNIĘTY (``LiveActivityWriteStats``) — system pokazuje treść starszą niż przyjęty
  /// zapis z innymi licznikami. Treść, którą system już zastąpił (spóźnione wejście), i własne echa się nie liczą.
  private func noteLiveActivityContent(_ id: String, _ shown: LiveActivityContentState) {
    guard let accepted = liveRuntime.acceptedWrite, LiveActivityCounts(shown) != accepted.counts,
      TimeInterval(shown.updatedEpoch) < accepted.asOf.timeIntervalSince1970,
      liveRuntime.system?.displayedContent(id)?.state == shown, !liveRuntime.writtenStates.contains(shown)
    else { return }
    liveRuntime.writeStats.reverted += 1
  }

  /// Zegar ciszy: start przy pierwszej ciszy (`liveActivityBusy == false`), zatrzymanie przy każdej pracy,
  /// decyzji albo przebiegu w tle.
  private func trackQuiet(busy: Bool) {
    if busy {
      stopQuietWatch()
      return
    }
    guard liveRuntime.quietSince == nil else { return }
    liveRuntime.quietSince = areaNow
    armQuietWatch(after: liveRuntime.timing.quietEnd)
  }

  private func armQuietWatch(after wait: Duration) {
    let sleep = liveRuntime.timing.sleep
    liveRuntime.quietWatch = Task { [weak self] in
      await sleep(wait)
      guard !Task.isCancelled else { return }
      self?.quietElapsed()
    }
  }

  private func stopQuietWatch() {
    liveRuntime.quietWatch?.cancel()
    liveRuntime.quietWatch = nil
    liveRuntime.quietSince = nil
  }

  /// Termin zegara ciszy: koniec tylko, gdy cisza trwa naprawdę (świeża lista na wierzchu, wciąż nic).
  private func quietElapsed() {
    liveRuntime.quietWatch = nil
    guard let since = liveRuntime.quietSince, liveRuntime.activityId != nil, areaPhase != .background,
      state.liveActivityBusy == false
    else { return }
    // Sen i zegar magazynu to różne zegary (monotoniczny i ścienny): sen skończony odrobinę przed terminem
    // nie może zgubić końca — zegar staje znowu na resztę.
    let left = liveRuntime.timing.quietEnd.timeInterval - areaNow.timeIntervalSince(since)
    guard left <= 0 else {
      armQuietWatch(after: .milliseconds(max(1, Int((left * 1000).rounded(.up)))))
      return
    }
    finishLiveActivity("cisza 30 min", tellServer: true)
  }

  /// Token aktywności na serwer: z tokenem urządzenia, który serwer już przyjął. Bramka luźniejsza niż
  /// rejestracji urządzenia (`pushRequestsReady`): bez żywego strumienia i bez wierzchu, bo token i jego
  /// rotacja przychodzą też w tle — wystarczy zalogowanie i zgodność z serwerem (to samo, czego żąda bramka
  /// mutacji), a żądanie idzie w pracy w tle (`beginBackgroundTask`), żeby system nie uśpił apki w połowie.
  func attemptLiveActivityRegistration() {
    guard liveRuntime.registering == nil, !liveRuntime.retryAfterReconnect,
      let id = liveRuntime.activityId, let updateToken = liveRuntime.updateToken,
      let device = pushRuntime.registeredToken,
      state.auth == .loggedIn, state.compat == .ok, !state.listStale
    else { return }
    let body = LiveActivityRegisterBody(deviceToken: device, activityId: id, updateToken: updateToken)
    guard body != liveRuntime.registered else { return }
    let login = currentLogin
    let transport = transport
    let work = beginBackgroundWork("rarog.live-activity", needsServer: true)
    liveRuntime.registering = Task { [weak self] in
      let result: Result<Void, TransportError>
      do throws(TransportError) {
        try await transport.registerLiveActivity(body)
        result = .success(())
      } catch {
        result = .failure(error)
      }
      self?.finishLiveActivityRegistration(result, body: body, login: login)
      self?.endBackgroundWork(work)
    }
  }

  private func finishLiveActivityRegistration(_ result: Result<Void, TransportError>, body: LiveActivityRegisterBody, login: Int) {
    guard isCurrentLogin(login), body.activityId == liveRuntime.activityId else { return }
    liveRuntime.registering = nil
    switch result {
    case .success:
      liveRuntime.registered = body
      if body != liveRuntime.announced {
        liveRuntime.announced = body
        trace("live-activity: token aktywności przyjęty przez serwer")
      }
    case let .failure(.http(failure)) where failure.status == 409 && failure.code == Self.apnsDeviceUnknown:
      // Serwer z kanałem nie zna urządzenia (wpis wypadł: 410, LRU, nowy plik rejestru): urządzenie
      // rejestruje się od nowa, a token aktywności idzie po nim. Drugi raz w tym połączeniu — czekamy.
      guard !liveRuntime.deviceRetried else {
        liveRuntime.retryAfterReconnect = true
        return
      }
      liveRuntime.deviceRetried = true
      pushRuntime.registeredToken = nil
      pushRuntime.needsRegistration = true
      attemptPushRegistration()
      return
    case .failure(.unauthorized):
      handleUnauthorized(since: login)
      return
    case .failure(.cancelled):
      return
    case .failure:
      liveRuntime.retryAfterReconnect = true
      trace("live-activity: rejestracja tokenu aktywności nieudana — ponowienie przy następnym połączeniu")
      return
    }
    // Rotacja tokenu w trakcie żądania: druga rejestracja z aktualnym.
    attemptLiveActivityRegistration()
  }

  /// `APNS_DEVICE_UNKNOWN_ERROR` z `shared/src/rest.ts`.
  static let apnsDeviceUnknown = "apns-device-unknown"
}
