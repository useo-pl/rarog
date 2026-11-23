import Foundation
import Synchronization

// Kontrakt własności klienta i generacji tunelu. Każdy `RarogClient` na porcie pętli zwrotnej (generacja iroh
// i drzwi uploadu) ma jednego właściciela, który go buduje i unieważnia; klient HTTPS jest jeden na poświadczenie.
// Przełącznik transportu klientów nie buduje, tylko pożycza je przez bilet: wywołanie klienta wyłącznie między
// `begin() == true` i `end()`, a przy `false` czeka na następną generację. Zamknięcie generacji przez właściciela:
// `startClosing()` → przerwanie par → zamknięcie połączenia → `drained(within: 2 s)` → `invalidate()` klienta.
// Dzięki temu żadne żądanie nie startuje na unieważnionej sesji URL.

/// Którędy idzie generacja: tunel iroh do serwera albo bezpośrednio HTTPS.
public enum TransportChoice: Sendable, Hashable, CustomStringConvertible {
  case iroh, https

  public var description: String {
    switch self {
    case .iroh: "iroh"
    case .https: "https"
    }
  }
}

/// Bilet generacji: licznik żądań i strumieni w locie oraz zamknięcie, które od razu odcina nowe wejścia.
/// `begin()` i `startClosing()` biorą tę samą blokadę, więc po powrocie `startClosing()` żadne `begin()` nie
/// zwróci prawdy, a każde wcześniejsze udane `begin()` liczy się do `drained`.
public final class GenerationTicket: Sendable {
  private struct State {
    var active = 0
    var closing = false
    var nextWaiter = 0
    var waiters: [Int: CheckedContinuation<Bool, Never>] = [:]
  }

  private let state = Mutex(State())

  public init() {}

  /// Wejście żądania albo strumienia (SSE, gniazdo terminala). Fałsz od początku zamykania; inaczej licznik + 1
  /// i wołający MUSI wywołać ``end()`` po zakończeniu.
  public func begin() -> Bool {
    state.withLock { state in
      guard !state.closing else { return false }
      state.active += 1
      return true
    }
  }

  /// Koniec żądania albo strumienia: licznik − 1, nigdy poniżej zera. Przy zerze budzi czekających na ``drained(within:)``.
  public func end() {
    let woken: [CheckedContinuation<Bool, Never>] = state.withLock { state in
      if state.active > 0 { state.active -= 1 }
      guard state.active == 0, !state.waiters.isEmpty else { return [] }
      defer { state.waiters.removeAll() }
      return Array(state.waiters.values)
    }
    for waiter in woken { waiter.resume(returning: true) }
  }

  /// Początek zamykania przez właściciela generacji: od teraz ``begin()`` zwraca fałsz. Żądań w locie nie przerywa
  /// (licznik zostaje) i jest idempotentne.
  public func startClosing() {
    state.withLock { $0.closing = true }
  }

  /// Czy licznik zszedł do zera przed terminem. Prawda od razu przy zerze; fałsz po terminie albo po anulowaniu
  /// zadania wołającego.
  public func drained(within limit: Duration) async -> Bool {
    if state.withLock({ $0.active == 0 }) { return true }
    return await withTaskGroup(of: Bool.self) { group in
      group.addTask { await self.reachedZero() }
      group.addTask {
        do {
          try await Task.sleep(for: limit)
        } catch {
          // Anulowanie przed terminem: licznik nie zszedł do zera w tym czasie.
        }
        return false
      }
      let first = await group.next() ?? false
      group.cancelAll()
      return first
    }
  }

  /// Zamknięcie przez właściciela (``startClosing()``), nie przez serwer ani sieć: przełącznik czyta to przy
  /// błędzie żądania, żeby wiedzieć, że generacja kończy się planowo.
  public var closedByRuntime: Bool {
    state.withLock { $0.closing }
  }

  /// Czeka na zero licznika; fałsz po anulowaniu zadania (np. upływ terminu w ``drained(within:)``).
  private func reachedZero() async -> Bool {
    let id = state.withLock { state in
      defer { state.nextWaiter += 1 }
      return state.nextWaiter
    }
    return await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
        let immediate: Bool? = state.withLock { state in
          if state.active == 0 { return true }
          // Anulowanie przed rejestracją: obsługa anulowania już przeszła i nie znalazła czekającego.
          if Task.isCancelled { return false }
          state.waiters[id] = continuation
          return nil
        }
        if let immediate { continuation.resume(returning: immediate) }
      }
    } onCancel: {
      let waiter = state.withLock { $0.waiters.removeValue(forKey: id) }
      waiter?.resume(returning: false)
    }
  }
}

/// Generacja transportu: numer (rośnie przy każdym otwarciu), droga i klient z biletem. Klient generacji iroh
/// należy do runtime tunelu (buduje go i unieważnia); generacja HTTPS niesie klienta poświadczenia.
public struct TunnelGeneration: Sendable {
  public let number: UInt64
  public let choice: TransportChoice
  public let client: RarogClient
  public let ticket: GenerationTicket

  public init(number: UInt64, choice: TransportChoice, client: RarogClient, ticket: GenerationTicket) {
    self.number = number
    self.choice = choice
    self.client = client
    self.ticket = ticket
  }
}

/// Drzwi uploadu: osobne połączenie iroh na jedną wysyłkę z załącznikiem, ten sam wzór biletu co generacja.
public struct UploadDoor: Sendable {
  public let client: RarogClient
  public let ticket: GenerationTicket
  /// Zamyka drzwi z kodem błędu zamknięcia apki: 0 = koniec, 1 = anulowany upload.
  public let close: @Sendable (_ code: UInt64) async -> Void

  public init(client: RarogClient, ticket: GenerationTicket, close: @escaping @Sendable (_ code: UInt64) async -> Void) {
    self.client = client
    self.ticket = ticket
    self.close = close
  }
}
