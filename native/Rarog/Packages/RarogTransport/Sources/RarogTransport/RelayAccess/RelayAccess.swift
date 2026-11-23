import Foundation
import RarogContract
import Synchronization

// Actor klienta rejestru relaya iroh: wykonuje polecenia maszyny `RelayAccessMachine` w jednej
// kolejce. Maszyna decyduje (kiedy synchronizować, co wysłać, co zapisać, jaki status), actor tylko wykonuje skutki
// i oddaje wyniki zdarzeniami z numerem generacji polecenia.
//
// - Wejścia (`setServers`, `trigger`, `prepareForPairing`, `forget()`) idą do maszyny w kolejności wywołań.
//   Przed każdą paczką wejść actor rozwiązuje podpis (`signer`), bo zdarzenia niosą EndpointId apki; `nil` =
//   tożsamość niedostępna.
// - Maszyna powstaje przy pierwszej paczce z tożsamością i dopiero wtedy czyta magazyn i `gate.isSupported`. Przed
//   pierwszym odblokowaniem urządzenia Keychain odmawia odczytu, a wpisy rejestru mają tę samą dostępność co wpis
//   tożsamości: odczyt przy starcie procesu zostawiłby blokadę do końca procesu. Do tej chwili actor sam stosuje regułę braku tożsamości:
//   wyzwalacz bez żądań (status zostaje `inactive`, jedna linia logu na paczkę), `prepareForPairing` → `.skipped`,
//   `forget()` → `.inactive`. Ostatnia lista z `setServers` czeka i idzie do maszyny jako jej pierwsze zdarzenie;
//   gdy paczka, która tworzy maszynę, niesie własne `setServers`, zapamiętana lista przepada bez żądania.
// - Polecenia magazynu (`saveCache`, `saveOptOut`, `deleteOptOut`) actor wykonuje od razu, bez `await`, i oddaje
//   wynik maszynie, zanim przyjmie inne zdarzenie.
// - Żądanie do rejestru i dowód bramki idą w osobnym zadaniu, a wynik wraca zdarzeniem. Reentrancja actora przy
//   `await` nie wpuszcza drugiej operacji, bo kolejkę trzyma maszyna: dopóki wynik nie wróci, nie wydaje następnego
//   polecenia z wynikiem; wyzwalacze z czasu operacji łączy w jedną następną synchronizację.
// - Podpis należy do operacji: przy pierwszym poleceniu nowej generacji actor przypina ostatni podpis z tej chwili
//   i nim podpisuje wszystkie żądania tej generacji. Paczka wejść z inną tożsamością w trakcie operacji zmienia
//   podpis dopiero następnej operacji (inny `appId`: nowa pamięć).
// - Dowód bramki ma termin `proofDeadline` na zegarze `clock`. Maszyna dostaje jedno zdarzenie `proved` na próbę:
//   wynik bramki albo porażkę `proof timed out`, co przyjdzie pierwsze; spóźniony wynik nie daje zdarzenia. Zawieszona
//   bramka dostaje anulowanie, ale termin od niego nie zależy. Bez terminu trzymałaby kolejkę, więc `forget()`
//   i parowanie czekałyby bez końca.
// - `prepareForPairing` czeka na wynik swojego biletu najwyżej `budget` na wstrzykniętym zegarze; po budżecie wraca
//   `.unavailable`, a synchronizacja idzie dalej w tle. `forget()` czeka na wynik biletu bez budżetu (maszyna zawsze
//   go daje, także gdy nowszy T-parowanie albo T-zapomnij zastąpi starszy).
// - Rejestr nigdy nie blokuje iroh: wyzwalacze nie czekają na sieć, a porażka to status, nie odmowa.

/// Klient rejestru relaya iroh jednej apki: wyzwalacze, przygotowanie parowania, rezygnacja i status.
public actor RelayAccess {
  public typealias Ticket = RelayAccessMachine.Ticket

  /// Budżet przygotowania parowania: tyle rdzeń czeka na `register` i `sponsor` przed próbą tunelu.
  public static let pairingBudget: Duration = .seconds(8)
  /// Termin dowodu bramki (zegar `clock`): po nim maszyna dostaje porażkę bramki, a spóźniony dowód przepada.
  /// Token DeviceCheck to zwykle 1–2 s, termin żądania do rejestru 10 s.
  public static let proofDeadline: Duration = .seconds(15)

  private enum Input: Sendable {
    case trigger(RelayAccessTrigger)
    case servers([TunnelTarget])
    case pair(TunnelTarget, Ticket)
    case forget(Ticket)
  }

  /// Próba dowodu bramki w drodze: rozstrzyga ją pierwsze z dwóch zadań, bramka albo termin.
  private struct ProofAttempt {
    let number: UInt64
    let generation: RelayAccessMachine.Generation
    let proofTask: Task<Void, Never>
    let deadlineTask: Task<Void, Never>
  }

  private let signer: @Sendable () async -> (any TunnelSigner)?
  private let gate: any RelayGate
  private let transport: any RelayAuthTransport
  private let store: any RelayAccessStore
  private let registries: [String: URL]
  private let renewEvery: Duration
  private let clock: any Clock<Duration>
  private let now: @Sendable () -> Date
  private let log: @Sendable (String) -> Void
  private let feed = RelayStatusFeed()
  /// Maszyna od pierwszej paczki wejść z tożsamością (wtedy odczyt magazynu); `nil` = wejścia obsługuje actor.
  private var machine: RelayAccessMachine?
  /// Ostatnia lista z `setServers` sprzed maszyny: pierwsze zdarzenie nowej maszyny, chyba że paczka, która ją
  /// tworzy, niesie nowszą.
  private var pendingServers: [TunnelTarget]?
  /// Wejścia, które czekają na podpis i maszynę (kolejność wywołań).
  private var inbox: [Input] = []
  private var draining = false
  /// Ostatni podpis, który nie był `nil`; operacja przypina go przy swoim pierwszym poleceniu.
  private var lastSigner: (any TunnelSigner)?
  /// Podpis operacji w toku: jej generacja i ostatni podpis z chwili jej pierwszego polecenia. Jeden zapis wystarcza,
  /// bo maszyna nie wydaje poleceń dla operacji zastąpionej.
  private var pinned: (generation: RelayAccessMachine.Generation, signer: (any TunnelSigner)?)?
  private var proofAttempts: UInt64 = 0
  private var proving: ProofAttempt?
  private var nextTicket: Ticket = 0
  private var prepares: [Ticket: PendingAnswer<RelayPrepareResult>] = [:]
  private var forgets: [Ticket: PendingAnswer<RelayAccessStatus>] = [:]
  /// Wejścia przyjęte: oddane maszynie albo, zanim powstała, obsłużone jak przy braku tożsamości (testy czekają na nie zamiast na
  /// czas).
  private(set) var acceptedInputs = 0
  /// Wołający `prepareForPairing` i `forget()`, którzy czekają na wynik (testy: po powrocie wszystkich zero).
  var waitingCallers: Int { prepares.count + forgets.count }

  /// - Parameters:
  ///   - signer: podpis kluczem iroh apki, czytany przed każdą paczką wejść; `nil` = tożsamość niedostępna.
  ///   - gate: dowód urządzenia; `isSupported` actor czyta razem z magazynem.
  ///   - store: pamięć i rezygnacja, czytane przy pierwszej paczce wejść z tożsamością, nie w `init`.
  ///   - registries: mapa relay → rejestr; relay spoza mapy nie ma rejestru.
  ///   - renewEvery: okres odnowienia.
  ///   - clock: zegar budżetu przygotowania parowania i terminu dowodu bramki.
  ///   - now: chwila dla maszyny (czasy wpisów, przerwy, `issuedAt`).
  ///   - log: linia do `client.log` z prefiksem `relay-access:`, bez tokenu, podpisu i ciała.
  public init(signer: @escaping @Sendable () async -> (any TunnelSigner)?,
              gate: any RelayGate, transport: any RelayAuthTransport, store: any RelayAccessStore,
              registries: [String: URL] = RelayAuthWire.registries,
              renewEvery: Duration = RelayAccessMachine.defaultRenewEvery,
              clock: any Clock<Duration> = ContinuousClock(), now: @escaping @Sendable () -> Date = Date.init,
              log: @escaping @Sendable (String) -> Void) {
    self.signer = signer
    self.gate = gate
    self.transport = transport
    self.store = store
    self.registries = registries
    self.renewEvery = renewEvery
    self.clock = clock
    self.now = now
    self.log = log
  }

  // MARK: - API

  /// Bieżący status od razu, potem każda zmiana. Każde odczytanie to nowy subskrybent.
  public nonisolated var statuses: AsyncStream<RelayAccessStatus> { feed.subscribe() }

  /// T-lista: ostatnia lista par iroh poświadczenia (dziś 0 albo 1).
  public func setServers(_ servers: [TunnelTarget]) {
    submit(.servers(servers))
  }

  /// Wyzwalacz automatyczny; nie czeka na rejestr.
  public func trigger(_ reason: RelayAccessTrigger) {
    submit(.trigger(reason))
  }

  /// T-parowanie(s): rejestracja i poręczenie `server` przed parowaniem przez iroh. Wraca najpóźniej po `budget`
  /// (zegar `clock`) albo przy anulowaniu zadania z `.unavailable`; synchronizacja idzie wtedy dalej w tle.
  public func prepareForPairing(_ server: TunnelTarget, budget: Duration) async -> RelayPrepareResult {
    let ticket = issueTicket()
    let answer = PendingAnswer<RelayPrepareResult>()
    prepares[ticket] = answer
    submit(.pair(server, ticket))
    let clock = clock
    let log = log
    let timer = Task {
      do { try await clock.sleep(for: budget) } catch { return }
      if answer.resolve(.unavailable) {
        log("relay-access: pairing budget elapsed, registration continues in background")
      }
    }
    let result = await withTaskCancellationHandler {
      await answer.value()
    } onCancel: {
      answer.resolve(.unavailable)
    }
    timer.cancel()
    prepares[ticket] = nil
    return result
  }

  /// T-zapomnij: rezygnacja z rejestru (zapis, potem `forget`); wynik to status po tej operacji. Przy anulowaniu
  /// zadania wraca bieżący status, a operacja idzie dalej.
  public func forget() async -> RelayAccessStatus {
    let ticket = issueTicket()
    let answer = PendingAnswer<RelayAccessStatus>()
    forgets[ticket] = answer
    submit(.forget(ticket))
    let feed = feed
    let status = await withTaskCancellationHandler {
      await answer.value()
    } onCancel: {
      answer.resolve(feed.current)
    }
    forgets[ticket] = nil
    return status
  }

  // MARK: - Wejścia

  private func issueTicket() -> Ticket {
    nextTicket += 1
    return nextTicket
  }

  private func submit(_ input: Input) {
    inbox.append(input)
    guard !draining else { return }
    draining = true
    Task { await drain() }
  }

  /// Oddaje wejścia maszynie w kolejności wywołań; przed każdą paczką czyta podpis. Pierwsza paczka z tożsamością
  /// tworzy maszynę; paczki przed nią actor obsługuje sam.
  private func drain() async {
    while !inbox.isEmpty {
      let batch = inbox
      inbox = []
      let identity = await signer()
      if let identity { lastSigner = identity }
      let appId = identity?.endpointId
      if machine == nil, let appId { startMachine(appId: appId, batch: batch) }
      guard machine != nil else {
        log("relay-access: identity unavailable")
        for input in batch { withoutMachine(input) }
        acceptedInputs += batch.count
        continue
      }
      for input in batch {
        switch input {
        case let .trigger(reason): handle(.trigger(reason, appId: appId))
        case let .servers(list): handle(.servers(list, appId: appId))
        case let .pair(target, ticket): handle(.pair(target, ticket: ticket, appId: appId))
        case let .forget(ticket): handle(.forget(ticket: ticket, appId: appId))
        }
        acceptedInputs += 1
      }
    }
    draining = false
  }

  /// Maszyna przy pierwszej tożsamości. Magazyn i bramkę czyta dopiero teraz: wpisy rejestru mają tę samą dostępność
  /// Keychaina co wpis tożsamości, więc dostępna tożsamość = czytelny magazyn. Zła treść wpisu zostaje `unreadable`
  /// jak przy każdym odczycie. Lista sprzed maszyny idzie jako jej pierwsze zdarzenie, chyba że `batch`, paczka
  /// tworząca maszynę, niesie własne `setServers`: wtedy zapamiętana lista jest starsza i przepada bez żądania,
  /// a maszyna dostaje listę z paczki w kolejności wywołań (synchronizacja starej listy poręczyłaby serwer spoza niej).
  private func startMachine(appId: String, batch: [Input]) {
    machine = RelayAccessMachine(cache: store.loadCache(), optOut: store.loadOptOut(), gateSupported: gate.isSupported,
                                 registries: registries, renewEvery: renewEvery)
    let remembered = pendingServers
    pendingServers = nil
    let newerList = batch.contains { if case .servers = $0 { true } else { false } }
    guard let remembered, !newerList else { return }
    handle(.servers(remembered, appId: appId))
  }

  /// Wejście, zanim tożsamość była choć raz dostępna: bez żądań, status zostaje `inactive`; T-tożsamość powtarza
  /// wyzwalacz, a lista czeka na maszynę.
  private func withoutMachine(_ input: Input) {
    switch input {
    case .trigger: break
    case let .servers(list): pendingServers = list
    case let .pair(_, ticket): prepares[ticket]?.resolve(.skipped)
    case let .forget(ticket): forgets[ticket]?.resolve(.inactive)
    }
  }

  // MARK: - Polecenia maszyny

  /// Zdarzenie do maszyny i wykonanie jej poleceń; wyniki magazynu wracają, zanim actor przyjmie inne zdarzenie.
  /// Zdarzenia przychodzą tylko od istniejącej maszyny (wejścia, wyniki jej poleceń).
  private func handle(_ first: RelayAccessMachine.Event) {
    var events = [first]
    while !events.isEmpty, machine != nil {
      let event = events.removeFirst()
      for command in machine?.handle(event, now: now()) ?? [] {
        switch command {
        case let .send(fields, registry, issuedAt, generation):
          if let failed = send(fields, registry: registry, issuedAt: issuedAt, signer: pin(generation),
                               generation: generation) {
            events.append(failed)
          }
        case let .proof(generation):
          pin(generation)
          prove(generation)
        case let .saveCache(cache):
          events.append(.cacheSaved(store.saveCache(cache)))
        case let .saveOptOut(record, generation):
          pin(generation)
          events.append(.optOutSaved(generation: generation, store.saveOptOut(record)))
        case let .deleteOptOut(generation):
          pin(generation)
          events.append(.optOutDeleted(generation: generation, store.deleteOptOut()))
        case let .status(status):
          feed.publish(status)
        case let .prepareResult(ticket, result):
          prepares[ticket]?.resolve(result)  // brak biletu = budżet minął albo anulowano
        case let .forgetResult(ticket, status):
          forgets[ticket]?.resolve(status)
        case let .log(line):
          log(line)
        }
      }
    }
  }

  /// Podpis generacji `generation`: przy jej pierwszym poleceniu przypina ostatni podpis z tej chwili, potem oddaje
  /// przypięty, choć nowsza paczka wejść mogła już zmienić `lastSigner`. Operacja startuje tylko z `appId` maszyny,
  /// a ten pochodzi z ostatniej paczki, która ustawiła `lastSigner`, więc podpis należy do tożsamości operacji.
  @discardableResult
  private func pin(_ generation: RelayAccessMachine.Generation) -> (any TunnelSigner)? {
    if pinned?.generation != generation { pinned = (generation, lastSigner) }
    return pinned?.signer
  }

  /// Żądanie w osobnym zadaniu z podpisem operacji; bez podpisu żądanie nie wychodzi i od razu wraca `.unreachable`.
  private func send(_ fields: RelayAuthWire.Fields, registry: URL, issuedAt: Int64, signer: (any TunnelSigner)?,
                    generation: RelayAccessMachine.Generation) -> RelayAccessMachine.Event? {
    guard let signer else {
      return .replied(generation: generation, .unreachable("identity unavailable"))
    }
    let transport = transport
    Task {
      let reply = await transport.send(fields, signer: signer, issuedAt: issuedAt, registry: registry)
      handle(.replied(generation: generation, reply))
    }
    return nil
  }

  /// Dowód bramki w osobnym zadaniu (nowy token na każdą próbę) i termin `proofDeadline` w drugim. Próbę rozstrzyga
  /// pierwsze z nich (`settleProof`), więc zawieszona bramka, która nie reaguje na anulowanie, nie trzyma kolejki.
  private func prove(_ generation: RelayAccessMachine.Generation) {
    proofAttempts += 1
    let attempt = proofAttempts
    let gate = gate
    let clock = clock
    let proofTask = Task {
      let result: Result<RelayAuthWire.Proof, RelayGateFailure>
      do throws(RelayGateFailure) {
        result = .success(try await gate.proof())
      } catch {
        result = .failure(error)
      }
      settleProof(attempt, with: result)
    }
    let deadlineTask = Task {
      do { try await clock.sleep(for: Self.proofDeadline) } catch { return }  // anulowany: bramka odpowiedziała
      settleProof(attempt, with: nil)
    }
    proving = ProofAttempt(number: attempt, generation: generation, proofTask: proofTask, deadlineTask: deadlineTask)
  }

  /// Rozstrzyga próbę dowodu `attempt` wynikiem bramki albo terminem (`nil`): maszyna dostaje jedno zdarzenie
  /// `proved`. Drugie z nich, także dowód spóźniony po terminie, nie daje już żadnego zdarzenia.
  private func settleProof(_ attempt: UInt64, with result: Result<RelayAuthWire.Proof, RelayGateFailure>?) {
    guard let current = proving, current.number == attempt else { return }
    proving = nil
    if let result {
      current.deadlineTask.cancel()
      handle(.proved(generation: current.generation, result))
    } else {
      current.proofTask.cancel()  // wolno, ale termin od tego nie zależy: spóźniony dowód i tak przepada
      log("relay-access: gate proof timed out")
      handle(.proved(generation: current.generation, .failure(.failed("proof timed out"))))
    }
  }
}

// MARK: - Pomocnicze

/// Statusy dla subskrybentów: każdy nowy dostaje od razu bieżący, potem zmiany w kolejności.
private final class RelayStatusFeed: Sendable {
  private struct State {
    var current: RelayAccessStatus = .inactive
    var next = 0
    var subscribers: [Int: AsyncStream<RelayAccessStatus>.Continuation] = [:]
  }

  private let state = Mutex(State())

  var current: RelayAccessStatus { state.withLock { $0.current } }

  func subscribe() -> AsyncStream<RelayAccessStatus> {
    let (stream, continuation) = AsyncStream<RelayAccessStatus>.makeStream()
    let id = state.withLock { state in
      defer { state.next += 1 }
      state.subscribers[state.next] = continuation
      continuation.yield(state.current)
      return state.next
    }
    continuation.onTermination = { [weak self] _ in
      _ = self?.state.withLock { $0.subscribers.removeValue(forKey: id) }
    }
    return stream
  }

  func publish(_ status: RelayAccessStatus) {
    state.withLock { state in
      state.current = status
      for continuation in state.subscribers.values { continuation.yield(status) }
    }
  }
}

/// Wynik dla jednego wołającego: wygrywa pierwsze rozstrzygnięcie (maszyna, budżet albo anulowanie).
private final class PendingAnswer<Value: Sendable>: Sendable {
  private struct State {
    var value: Value?
    var waiter: CheckedContinuation<Value, Never>?
  }

  private let state = Mutex(State())

  /// Prawda, gdy to rozstrzygnięcie wygrało.
  @discardableResult
  func resolve(_ value: Value) -> Bool {
    let (won, waiter) = state.withLock { state -> (Bool, CheckedContinuation<Value, Never>?) in
      guard state.value == nil else { return (false, nil) }
      state.value = value
      defer { state.waiter = nil }
      return (true, state.waiter)
    }
    waiter?.resume(returning: value)
    return won
  }

  func value() async -> Value {
    await withCheckedContinuation { continuation in
      let ready = state.withLock { state -> Value? in
        if let value = state.value { return value }
        state.waiter = continuation
        return nil
      }
      if let ready { continuation.resume(returning: ready) }
    }
  }
}
