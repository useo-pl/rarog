import Foundation
import RarogContract
import RarogTransport
import Synchronization

// Wysyłka przez trwałą kolejkę. Właściciel: wysyłka.
//
// Każda wiadomość dostaje identyfikator RAZ (`OutboxEntry.id` = `clientMessageId`) i ten sam przy
// każdym „Ponów"; treść załączników leży w kolejce, więc ponowienie wysyła te same bajty, a serwer
// przyjmie ją najwyżej raz. Ze starszym serwerem (bez pola w odpowiedzi i w echu) echo idzie
// po podpisie, a 202 jest bez treści.
extension RarogStore {
  /// Limit CAŁEJ wysyłki z załącznikiem: dłuższy niż 180 s czytania ciała przez
  /// serwer. Sam tekst: `RarogConfig.requestTimeout` (10 s) — martwe łącze szybko oddaje tekst do pola.
  public static let attachmentSendTimeout: Duration = .seconds(200)

  /// „Wyślij": wpis z plikami treści na dysk PRZED pierwszym bajtem, potem żądanie.
  /// Sam załącznik bez tekstu to poprawna wiadomość.
  public func send(text: String, attachments: [OutgoingAttachment] = [], to sessionId: String) async -> SendOutcome {
    let login = currentLogin
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty || !attachments.isEmpty else { return .empty }
    if let block = state.sendBlock(for: sessionId) { return .blocked(block) }
    // Zdjęcia przed plikami: tak liczy serwer (skrót idempotencji, wizytówki echa) i tak stoją nad polem.
    let ordered = attachments.filter { $0.kind == .image } + attachments.filter { $0.kind == .file }
    var entry = OutboxEntry(
      sessionId: sessionId, text: trimmed,
      attachments: ordered.map { attachment in
        OutboxEntry.Attachment(
          name: attachment.kind == .image ? "" : attachment.name, bytes: attachment.bytes,
          kind: attachment.kind, mime: attachment.mime)
      },
      createdAt: clock(), boundary: state.echoBoundary(for: sessionId))
    // `queueAware`: sam tekst może czekać na echo odroczone; ciało z załącznikami nie (serwer v1 i tak
    // nie odracza wiadomości z załącznikami — po restarcie podpis z nimi by się nie zgodził). Zapisane na dysku
    // PRZED żądaniem, więc przeżywa zgubioną odpowiedź 202.
    if ordered.isEmpty { entry.queueAware = true }
    let fresh = entry
    let spaceChanges = serverRuntime.spaceChanges
    let staged: OutboxEntry
    do {
      staged = try await persistInOrder { try await $0.stage(fresh, payloads: ordered.map(\.file)) }
    } catch {
      return .notPersisted(String(describing: error))
    }
    // Magazyn wszedł w trakcie zapisu w inną przestrzeń („Zapomnij serwer”, inny serwer): wpis leży w katalogu
    // poprzedniej, którego nikt już nie czyta — do stanu nie wraca.
    guard spaceChanges == serverRuntime.spaceChanges else { return .ignored }
    dispatch(.outboxEnqueued(staged))
    return await deliver(staged, login: login)
  }

  /// „Ponów": TEN SAM wpis (ten sam identyfikator i pliki treści), blokuje się od razu.
  /// Stan `queued` trafia na dysk PRZED żądaniem; odmowa dysku = nic nie wychodzi, stan zostaje.
  /// W starcie agenta nic nie wychodzi i wpis stoi nietknięty do `waiting-input` albo `running`.
  public func retry(_ entryId: UUID) async -> SendOutcome {
    let login = currentLogin
    guard !retrying.contains(entryId), let entry = state.outbox.first(where: { $0.id == entryId }), entry.isRetryable else {
      return .ignored
    }
    // Stan sesji wprost, nie `sendBlock`: ten oddaje najpierw przeszkody kanału (herdr tylko do odczytu…),
    // a serwer i tak odmówi wiadomości w `starting`.
    if state.sessions[entry.sessionId]?.state == .starting { return .blocked(.starting) }
    retrying.insert(entryId)
    defer { retrying.remove(entryId) }
    var next = entry
    next.state = .queued
    let queued = next
    do {
      try await persistInOrder { try await $0.save(queued) }
    } catch {
      return .notPersisted(String(describing: error))
    }
    // Wpis mógł zniknąć w trakcie zapisu (echo, „Odrzuć") — wtedy nic nie wysyłamy.
    guard state.outbox.contains(where: { $0.id == entryId }) else {
      chainPersistence { await $0.delete(entryId) }
      return .ignored
    }
    dispatch(.outboxRetrying(entryId))
    return await deliver(queued, login: login)
  }

  /// „Odrzuć": zdejmuje wpis lokalnie (np. doszła, a echo się nie dopasowało) razem z plikami treści.
  public func discard(_ entryId: UUID) {
    dispatch(.outboxDiscarded(entryId))
  }

  /// The stop in the progress ring: ends the send in flight of `entryId`. Before the request (composing
  /// the body, or the transport still waiting for its connection, until it reports the first byte) nothing went
  /// out, so the entry becomes the refusal `cancelled` with Retry; only an echo with its own `clientMessageId` clears
  /// it. During the request (a byte reported, or a text-only body the transport has) the message may have arrived,
  /// so the entry becomes Not confirmed, which its echo clears. The text stays in the entry and never goes back to
  /// the field, and the stopped attempt changes nothing afterwards (its token is gone). An entry without a send in
  /// flight (accepted, settled, unknown) is left alone.
  public func cancelSend(_ entryId: UUID) {
    guard let flight = sendFlights[entryId], flight.stopped == nil,
      state.outbox.contains(where: { $0.id == entryId && $0.state == .queued })
    else { return }
    sendFlights[entryId] = nil
    let outcome: SendOutcome
    if flight.bodyMayHaveArrived.withLock({ $0 }) {
      outcome = .unconfirmed(entryId)
      dispatch(.outboxUnconfirmed(entryId))
    } else {
      outcome = .refused(entryId, code: OutboxEntry.RefusalCode.cancelled, message: nil)
      dispatch(.outboxRefused(entryId, code: OutboxEntry.RefusalCode.cancelled, message: nil))
    }
    flight.stopped = outcome
    flight.settle(outcome)
    flight.task?.cancel()
  }

  /// Plik treści załącznika wpisu kolejki — miniatura wpisu w drodze czyta zdjęcie z dysku urządzenia.
  /// `file` to nazwa z manifestu (`Attachment.file`); nazwa ze ścieżką = `nil`. Plik znika
  /// razem z wpisem (echo, „Odrzuć"), więc wołający znosi jego brak.
  public func outboxPayloadURL(entry: UUID, file: String) -> URL? {
    guard !file.isEmpty, !file.contains("/"), file != ".", file != ".." else { return nil }
    return persistence.payloadDirectory(entry).appending(path: file)
  }

  /// One delivery attempt of `entry`, in a task of its own that the stop can cancel (`cancelSend`). The attempt is
  /// registered under the entry id: that is the token that tells a late result or progress report of a stopped
  /// attempt from the current one. A stop ends the call at once with its own outcome, without waiting for the
  /// stopped attempt (a closing upload connection can take seconds), so an immediate Retry is not held by `retrying`.
  /// Cancelling the caller's task cancels the attempt, as before.
  func deliver(_ entry: OutboxEntry, login: Int) async -> SendOutcome {
    let flight = SendFlight()
    sendFlights[entry.id] = flight
    let attempt = Task {
      let outcome = await self.attempt(entry, login: login, flight: flight)
      flight.settle(outcome)
      return outcome
    }
    flight.task = attempt
    let outcome = await withTaskCancellationHandler {
      await flight.outcome()
    } onCancel: {
      attempt.cancel()
    }
    if sendFlights[entry.id] === flight { sendFlights[entry.id] = nil }
    return outcome
  }

  /// The body of `deliver`. After every suspension a stopped attempt returns the outcome the stop already put on
  /// the entry and dispatches nothing.
  private func attempt(_ entry: OutboxEntry, login: Int, flight: SendFlight) async -> SendOutcome {
    if let stopped = flight.stopped { return stopped }
    if let refusal = expiredSend(entry.id, login: login) { return refusal }
    let upload: MessageUpload
    var bodyFile: URL?
    defer { if let bodyFile { try? FileManager.default.removeItem(at: bodyFile) } }
    if entry.attachments.isEmpty {
      do {
        upload = try MessageUpload.json(
          MessageBody(text: entry.text, clientMessageId: entry.clientMessageId, queueAware: entry.queueAware == true))
      } catch {
        return refuse(entry.id, code: OutboxEntry.RefusalCode.encodingFailed)
      }
    } else {
      dispatch(.outboxProgress(entry.id, .encoding))
      let target = FileManager.default.temporaryDirectory
        .appending(path: "rarog-send-\(entry.id.uuidString)-\(UUID().uuidString.prefix(8)).json")
      let message = message(for: entry)
      // Set before composing: `defer` also removes a body cut off halfway (a missing content file, the disk, a stop).
      bodyFile = target
      do throws(MessageBodyError) {
        try await Self.writeBody(message, to: target)
      } catch {
        if let stopped = flight.stopped { return stopped }
        switch error {
        case .missingPart, .emptyPart: return refuse(entry.id, code: OutboxEntry.RefusalCode.attachmentMissing)
        case .io: return refuse(entry.id, code: OutboxEntry.RefusalCode.encodingFailed)
        // The caller's task was cancelled: the same refusal as a cancellation found after composing.
        case .cancelled:
          return expiredSend(entry.id, login: login) ?? refuse(entry.id, code: OutboxEntry.RefusalCode.encodingFailed)
        }
      }
      upload = MessageUpload(body: .file(target), clientMessageId: entry.clientMessageId)
    }
    if let stopped = flight.stopped { return stopped }
    // The gesture belongs to the login of the send or retry that started it, also when the outbox write or composing
    // a large body held it before the transport gate. A 401 and a new login do not send the saved prompt by
    // themselves: the content stays as a refusal for a manual Retry or Discard.
    if let refusal = expiredSend(entry.id, login: login) { return refusal }
    let id = entry.id
    var progress: (@Sendable (UploadProgress) -> Void)?
    var timeout: Duration?
    if !entry.attachments.isEmpty {
      timeout = Self.attachmentSendTimeout
      progress = { [weak self] report in
        // Synchronously, on the transport's thread: a stop right after this report already gives Not confirmed,
        // before the report reaches the entry on the main actor.
        flight.bodyMayHaveArrived.withLock { $0 = true }
        Task { @MainActor in self?.uploadProgressed(id, report, flight: flight) }
      }
    } else {
      // A text-only body has no progress reports: once the transport has it, it may arrive.
      flight.bodyMayHaveArrived.withLock { $0 = true }
    }
    let accepted: MessageAccepted?
    do throws(TransportError) {
      accepted = try await transport.sendMessage(
        sessionId: entry.sessionId, upload, timeout: timeout, progress: progress)
    } catch {
      if let stopped = flight.stopped { return stopped }
      return failed(entry, error, login: login)
    }
    if let stopped = flight.stopped { return stopped }
    // Echo odroczone: wiadomość czeka u serwera, aż CLI weźmie prompt. Wpis wysłany z `queueAware` nie
    // znika po samej powtórce — po restarcie serwera `queued` nie wraca (a pierwsza odpowiedź z nim mogła
    // zginąć), a CLI mogło promptu jeszcze nie wziąć; czeka na echo po podpisie albo na „Nie potwierdzono”.
    if accepted?.queued == true || (accepted?.replayed == true && (entry.queuedAt != nil || entry.queueAware == true)) {
      let at = clock()
      dispatch(.outboxQueued(entry.id, at: at))
      scheduleQueuedCeiling(entry.id, queuedAt: entry.queuedAt ?? at)
      return .accepted(entry.id)
    }
    if accepted?.replayed == true {
      // Serwer zna tę wiadomość z wcześniejszego przyjęcia: echa tej odpowiedzi nie będzie.
      dispatch(.outboxReplayed(entry.id))
      return .accepted(entry.id)
    }
    dispatch(.outboxAccepted(entry.id, at: clock()))
    scheduleUnconfirmed(entry.id, after: timing.unconfirmedAfter(for: entry))
    return .accepted(entry.id)
  }

  /// Sufit wpisu w kolejce CLI, liczony od pierwszego przyjęcia z `queued`.
  ///
  /// Reduktor sprawdza sufit zegarem `clock()`, a sen liczy inny zegar: pobudka choćby ułamek milisekundy przed
  /// sufitem zostawiłaby wpis w kolejce na zawsze. Dlatego sen jest zaokrąglony w górę i powtarzany, dopóki
  /// `clock()` nie minie sufitu.
  func scheduleQueuedCeiling(_ id: UUID, queuedAt: Date) {
    let ceiling = timing.queuedUnconfirmedAfter.timeInterval
    Task { [weak self] in
      while let left = self.map({ ceiling - $0.clock().timeIntervalSince(queuedAt) }), left > 0 {
        do {
          try await Task.sleep(for: .milliseconds(max(1, Int((left * 1000).rounded(.up)))))
        } catch {
          break
        }
      }
      self?.dispatch(.outboxUnconfirmedIfQueued(id))
    }
  }

  /// Ciało z plikami treści składane poza głównym aktorem (base64 dziesiątek MB).
  nonisolated static func writeBody(_ message: OutgoingMessage, to target: URL) async throws(MessageBodyError) {
    try MessageBodyWriter.write(message, to: target)
  }

  private func message(for entry: OutboxEntry) -> OutgoingMessage {
    let parts = entry.attachments.map { attachment in
      OutgoingMessage.Part(
        kind: attachment.kind == .image ? .image : .file, name: attachment.name, mime: attachment.mime,
        file: persistence.payloadURL(entry, attachment) ?? persistence.payloadDirectory(entry.id).appending(path: "brak"))
    }
    return OutgoingMessage(text: entry.text, clientMessageId: entry.clientMessageId, parts: parts)
  }

  /// `login` = numer zalogowania sprzed żądania: spóźnione 401 nie wylogowuje nowego logowania.
  private func failed(_ entry: OutboxEntry, _ error: TransportError, login: Int) -> SendOutcome {
    switch error {
    case .timedOut, .offline, .cancelled:
      // Nie wiadomo, czy doszła — wpis kończy jako „Nie potwierdzono", ponawia człowiek.
      dispatch(.outboxUnconfirmed(entry.id))
      return .unconfirmed(entry.id)
    case let .refused(refusal):
      dispatch(.outboxRefused(entry.id, code: nil, message: refusal.message))
      return .refused(entry.id, code: nil, message: refusal.message)
    case let .unauthorized(failure):
      dispatch(.outboxRefused(entry.id, code: failure.code, message: failure.message))
      handleUnauthorized(since: login)
      return .refused(entry.id, code: failure.code, message: failure.message)
    case let .forbidden(failure), let .rateLimited(failure), let .http(failure):
      // 409 `client-id-conflict` też tu: kod ostateczny, „Ponów" znika (`isRetryable`).
      dispatch(.outboxRefused(entry.id, code: failure.code, message: failure.message))
      // Odmowa komendy przez strażnika serwera: lista podpowiedzi po „/” czyta się od nowa.
      if failure.status == 400 { commandSendRefused(entry) }
      return .refused(entry.id, code: failure.code, message: failure.message)
    case .invalidResponse:
      // Odpowiedź nieczytelna albo z obcym identyfikatorem — serwer mógł ją przyjąć; decyduje człowiek.
      dispatch(.outboxUnconfirmed(entry.id))
      return .unconfirmed(entry.id)
    }
  }

  private func refuse(_ id: UUID, code: String) -> SendOutcome {
    dispatch(.outboxRefused(id, code: code, message: nil))
    return .refused(id, code: code, message: nil)
  }

  /// Przed/po składaniu body: brak pierwszego bajtu jest pewny, treść pozostaje do decyzji człowieka.
  private func expiredSend(_ id: UUID, login: Int) -> SendOutcome? {
    guard !isCurrentLogin(login) || state.auth != .loggedIn || Task.isCancelled else { return nil }
    dispatch(.outboxRefused(id, code: nil, message: CoreCopy.noConnection))
    return .refused(id, code: nil, message: CoreCopy.noConnection)
  }

  /// Upload report: a change of phase or of the whole percent, without a flood of renders on every packet. Only the
  /// current attempt reports: progress of a stopped attempt does not reach the entry of the next one.
  func uploadProgressed(_ id: UUID, _ progress: UploadProgress, flight: SendFlight) {
    guard sendFlights[id] === flight else { return }
    let next: SendProgress =
      switch progress {
      case let .uploading(sent, total): .uploading(sent: sent, total: total)
      case .awaitingResponse: .awaitingResponse
      }
    if case let .uploading(sent, total) = next, case let .uploading(lastSent, lastTotal)? = state.sendProgress[id],
      total == lastTotal, total > 0, sent * 100 / total == lastSent * 100 / lastTotal
    {
      return
    }
    dispatch(.outboxProgress(id, next))
  }

  func scheduleUnconfirmed(_ id: UUID, after delay: Duration) {
    Task { [weak self] in
      try? await Task.sleep(for: delay)
      self?.dispatch(.outboxUnconfirmedIfStillSent(id))
    }
  }

  /// Start apki: kolejka z dysku wraca na ekran. Wpis, któremu zniknął plik treści, wraca jako
  /// odmowa bez „Ponów" (tych samych bajtów już nie ma) — widoczna, z „Odrzuć".
  func restoreOutbox() async {
    // Odczyt i poprawki stanów idą do przestrzeni z chwili startu. Magazyn wszedł w trakcie w inną (parowanie
    // z linku przy starcie, „Zapomnij serwer”): kolejka poprzedniej do stanu nie wraca.
    let persistence = persistence
    let spaceChanges = serverRuntime.spaceChanges
    // Katalogi treści bez manifestu (awaria przy zakładaniu wpisu) sprząta sam odczyt.
    let load = await persistence.loadAll()
    let now = clock()
    var restored: [OutboxEntry] = []
    // Sufity wpisów w kolejce CLI planujemy PO wstawieniu kolejki do stanu — timer odpalony w trakcie
    // zapisu kolejnego manifestu trafiłby w pusty stan i przepadł.
    var ceilings: [(UUID, Date)] = []
    var unconfirmed: [(UUID, Duration)] = []
    for var entry in load.entries {
      if load.missing.contains(entry.id) {
        entry.state = .refused(code: OutboxEntry.RefusalCode.attachmentMissing, message: nil)
        try? await persistence.save(entry)
        restored.append(entry)
        continue
      }
      switch entry.state {
      case .queued:
        // Zabita w trakcie żądania: nie wiadomo, czy serwer ją przyjął.
        entry.state = .unconfirmed
        try? await persistence.save(entry)
      case .sent where entry.queuedAt != nil:
        // Wpis w kolejce CLI: bez progu 15 s — sufit od pierwszego przyjęcia, a okres bezczynności
        // sesji wyznacza reduktor, gdy przyjdzie jej stan.
        let queuedAt = entry.queuedAt ?? now
        if now.timeIntervalSince(queuedAt) >= timing.queuedUnconfirmedAfter.timeInterval {
          entry.state = .unconfirmed
          try? await persistence.save(entry)
        } else {
          ceilings.append((entry.id, queuedAt))
        }
      case let .sent(acceptedAt):
        let left = timing.unconfirmedAfter(for: entry).timeInterval - now.timeIntervalSince(acceptedAt)
        if left <= 0 {
          entry.state = .unconfirmed
          try? await persistence.save(entry)
        } else {
          unconfirmed.append((entry.id, .milliseconds(Int(left * 1000))))
        }
      case .unconfirmed, .refused:
        break
      }
      restored.append(entry)
    }
    guard spaceChanges == serverRuntime.spaceChanges else { return }
    dispatch(.outboxRestored(restored))
    for (id, delay) in unconfirmed { scheduleUnconfirmed(id, after: delay) }
    for (id, queuedAt) in ceilings { scheduleQueuedCeiling(id, queuedAt: queuedAt) }
  }

  /// Zapis kolejki W ŁAŃCUCHU z resztą zapisów (skutki reduktora), z wynikiem dla wołającego:
  /// skasowanie wpisu po echu nie wyprzedzi jego założenia ani zapisu stanu `queued`.
  func persistInOrder<T: Sendable>(
    _ work: @escaping @Sendable (OutboxPersistence) async throws -> T
  ) async throws -> T {
    let previous = persistChain
    let persistence = persistence
    let task = Task {
      await previous?.value
      return try await work(persistence)
    }
    persistChain = Task { _ = try? await task.value }
    return try await task.value
  }
}

/// One delivery attempt of an outbox entry (`RarogStore.deliver`), the token of the stop. The instance itself is
/// the token: `RarogStore.sendFlights` holds the current attempt of each entry, and a result or a progress report of
/// any other attempt is late.
@MainActor
final class SendFlight {
  /// Whether the body may already be on the server, so a stop gives Not confirmed and not the refusal `cancelled`:
  /// set by the transport's first progress report (on its own thread) or when the transport gets a text-only body.
  nonisolated let bodyMayHaveArrived = Mutex(false)
  var task: Task<SendOutcome, Never>?
  /// Set by the stop: the outcome the stop put on the entry. The attempt returns it and changes nothing else.
  var stopped: SendOutcome?
  /// The outcome `deliver` returns: the first of the attempt's own and the stop's.
  private var settled: SendOutcome?
  private var waiter: CheckedContinuation<SendOutcome, Never>?

  /// Settles the attempt once; a later outcome (the stopped attempt ending) changes nothing.
  func settle(_ outcome: SendOutcome) {
    guard settled == nil else { return }
    settled = outcome
    waiter?.resume(returning: outcome)
    waiter = nil
  }

  /// Waits for the first outcome.
  func outcome() async -> SendOutcome {
    if let settled { return settled }
    return await withCheckedContinuation { waiter = $0 }
  }
}
