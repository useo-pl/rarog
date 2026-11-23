import Foundation
import RarogContract
import RarogTransport

/// Narastający odstęp ponownego łączenia: od `min` podwajany do `max` (5 → 8 s).
///
/// `retry:` serwera podnosi dolną granicę (zawsze w przedziale `min…max`) — serwer mówi, jak
/// często chce być pytany; udane połączenie wraca do granicy dolnej.
struct Backoff: Sendable, Equatable {
  let min: Duration
  let max: Duration
  private(set) var floor: Duration
  private var upcoming: Duration

  init(min: Duration, max: Duration) {
    self.min = min
    self.max = max
    floor = min
    upcoming = min
  }

  mutating func reset() {
    upcoming = floor
  }

  mutating func serverSuggested(_ retry: Duration) {
    floor = Swift.min(Swift.max(retry, min), max)
    if upcoming < floor { upcoming = floor }
  }

  mutating func nextDelay() -> Duration {
    let delay = upcoming
    upcoming = Swift.min(upcoming * 2, max)
    return delay
  }
}

/// Sygnał pętli strumienia dla magazynu (z numerem przebiegu — sygnały anulowanej pętli giną).
enum SupervisorSignal: Sendable {
  case connecting
  case opened(resumedWithCursor: Bool)
  /// Ramka po dekoderze: wynik, surowe bajty (do raportu odrzucenia) i kursor `id:` tego bloku.
  /// Ramka przyjęta ma już teksty serwera w języku apki (``ServerEvent/translated(_:)``).
  case frame(Result<DecodedEvent, EventRejection>, data: Data, cursor: String?)
  case dropped
  case unauthorized
  /// 404 strumienia sesji — sesji już nie ma; pętla kończy się bez ponawiania.
  case sessionGone
}

/// Pętla JEDNEGO strumienia SSE: łączy, czyta, dekoduje POZA głównym aktorem i oddaje sygnały.
///
/// Stall guard: each attempt races its reading against ``StreamStallGuard/stalled()``. Silence for the threshold
/// (1.5 × the ping interval from the last `hello`, 60 s without it), counted from the request or the last body byte,
/// ends the attempt like a drop: `dropped`, then the next attempt with backoff, whatever the cut transport threw
/// (`.cancelled` included). `URLSession`'s idle limit (`streamIdleTimeout`) stays as a ceiling behind it.
/// `opened` comes with the first body byte (the server writes `retry:` right after registering a stream), not with
/// the headers, and before any frame of that attempt.
/// 401 kończy pętlę (potrzebny człowiek z tokenem); zerwanie bez sieci łączy dalej.
/// Tu, po dekoderze i poza głównym aktorem, ramka przechodzi przez tłumacza zdań serwera — jedyne miejsce
/// tłumaczenia SSE: replay po kursorze, historia i `transcript-snapshot` płyną tą samą pętlą.
struct StreamSupervisor: Sendable {
  let scope: StreamScope
  let transport: any RarogTransporting
  let timing: CoreTiming
  let render: SentenceRenderer
  /// Shared with the other stream of the login; it can change while the stream is open.
  var threshold = StallThreshold()
  /// Clock of the stall guard and sleep of the backoff.
  var clock: TunnelRuntime.Timing = .system
  let deliver: @Sendable (SupervisorSignal) async -> Void

  /// What one attempt left behind: the cursor, the last `retry:`, whether it opened, and its error.
  private struct Attempt: Sendable {
    var cursor: String?
    var retry: Duration?
    var opened = false
    var error: TransportError?
  }

  private enum Lane: Sendable {
    case read(Attempt)
    case stalled
    case watchEnded
  }

  func run(cursor initial: String?) async {
    var backoff = Backoff(min: timing.backoffMin, max: timing.backoffMax)
    var cursor = initial
    while !Task.isCancelled {
      await deliver(.connecting)
      let (attempt, stalled) = await race(cursor: cursor)
      // Background, another session or logout: the loop ends without a retry.
      if Task.isCancelled { return }
      cursor = attempt.cursor
      if attempt.opened { backoff.reset() }
      if let retry = attempt.retry { backoff.serverSuggested(retry) }
      if !stalled, let error = attempt.error {
        switch error {
        case .unauthorized:
          await deliver(.unauthorized)
          return
        case .cancelled:
          return
        case let .http(failure) where failure.status == 404 && scope != .global:
          await deliver(.sessionGone)
          return
        default:
          break
        }
      }
      await deliver(.dropped)
      try? await clock.sleep(backoff.nextDelay())
    }
  }

  /// One attempt against the stall guard. True in the result: the guard fired first and cut the attempt.
  private func race(cursor: String?) async -> (Attempt, stalled: Bool) {
    let watch = StreamStallGuard(threshold: threshold, timing: clock)
    return await withTaskGroup(of: Lane.self) { group in
      group.addTask { .read(await read(cursor: cursor, watch: watch)) }
      group.addTask {
        do {
          try await watch.stalled()
          return .stalled
        } catch {
          return .watchEnded
        }
      }
      var stalled = false
      var read: Attempt?
      while let lane = await group.next() {
        switch lane {
        case let .read(result):
          read = result
          group.cancelAll()
        case .stalled:
          // Only a guard that fired before the attempt ended cut it; a 401 or 404 just before stays what it is.
          if read == nil { stalled = true }
          group.cancelAll()
        case .watchEnded:
          break
        }
      }
      return (read ?? Attempt(cursor: cursor), stalled)
    }
  }

  /// Opens the stream, delivers `opened` at the first body byte and then the frames, in this order.
  private func read(cursor initial: String?, watch: StreamStallGuard) async -> Attempt {
    var attempt = Attempt(cursor: initial)
    do {
      let stream = try await transport.openStream(scope, lastEventId: initial, watch: watch)
      if await watch.firstByte(), !Task.isCancelled {
        attempt.opened = true
        await deliver(.opened(resumedWithCursor: initial != nil))
      }
      for try await output in stream {
        // Cut by the guard or by the owner of the loop: nothing more goes out of this attempt.
        if Task.isCancelled { break }
        switch output {
        case let .retry(milliseconds):
          attempt.retry = .milliseconds(milliseconds)
        case .comment:
          continue
        case let .event(event):
          // Nazwane `ping` to heartbeat, nie protokół.
          guard event.type == "message" else { continue }
          // Kursor przesuwają wyłącznie ramki domknięte (z `id:`), jak w ring buferze serwera.
          let own = event.id.flatMap { $0.isEmpty ? nil : event.lastEventId }
          if let own { attempt.cursor = own }
          let data = Data(event.data.utf8)
          let decoded = EventDecoder.decode(data).map { [render] in
            DecodedEvent(event: $0.event.translated(render), degradations: $0.degradations)
          }
          await deliver(.frame(decoded, data: data, cursor: own))
        }
      }
    } catch {
      attempt.error = error as? TransportError ?? .invalidResponse(String(describing: error))
    }
    return attempt
  }
}
