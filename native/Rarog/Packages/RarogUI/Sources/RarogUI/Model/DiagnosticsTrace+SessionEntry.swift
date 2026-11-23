import Foundation
import RarogContract

// Okno wejścia do sesji: od otwarcia ekranu sesji do pierwszego nowego pełnego stanu
// transkryptu (ramka `transcript-snapshot`) i dalej do ciszy w pracy listy. Linię składa
// `DiagnosticsTrace.sessionEntry`; karmi okno `SessionViewController` (UIKit), tu sama logika, testowana na macOS.
// Liczby i słowa stałe, zero treści sesji. Właściciel: transkrypt; kanał śladów: łączność.

/// Liczniki pracy ekranu transkryptu (`TranscriptCounters`) bez UIKit: przebudowy listy, dojścia do dna
/// (`settleAtBottom`) i przewinięcia na dno (`scrollToBottom`).
public struct SessionEntryCounts: Sendable, Equatable {
  public var renders: Int
  public var settles: Int
  public var bottomScrolls: Int

  public init(renders: Int, settles: Int, bottomScrolls: Int) {
    self.renders = renders
    self.settles = settles
    self.bottomScrolls = bottomScrolls
  }

  static func - (lhs: Self, rhs: Self) -> Self {
    Self(
      renders: lhs.renders - rhs.renders, settles: lhs.settles - rhs.settles,
      bottomScrolls: lhs.bottomScrolls - rhs.bottomScrolls)
  }
}

/// Jedno wejście do sesji. Pierwsza ramka = pierwszy POCZĄTEK renderu, w którym transkrypt ma więcej pełnych stanów
/// niż przy otwarciu (`TranscriptState.snapshots`). Stan trafia do magazynu wcześniej niż render (dławik 60 ms), więc
/// układ albo przewinięcie w tym czasie widzą już nowy stan — ramki nie otwierają. Widok stoi = od ostatniej zmiany liczników minęło ``quiet``; czas ciszy
/// liczy się od ramki do tej ostatniej zmiany. Ramka, która nie przyszła w ``ceiling`` od otwarcia (ogon 0–1
/// wiadomości bez pełnego stanu), porzuca okno bez linii; lista, która nie ucichła w ``ceiling`` od ramki
/// (sesja z deltami), daje linię bez czasu ciszy.
public struct SessionEntryWindow: Sendable {
  public static let quiet: Duration = .milliseconds(500)
  public static let ceiling: Duration = .seconds(10)

  /// Co ekran pokazał przed ramką: szkielet (nic jeszcze nie przyszło) albo transkrypt z pamięci procesu.
  public enum Origin: Sendable, Equatable {
    case skeleton
    case memory
  }

  public struct Result: Sendable, Equatable {
    public let origin: Origin
    /// Od otwarcia ekranu do pierwszej ramki, ms.
    public let firstFrame: Int
    /// Od pierwszej ramki do ostatniej zmiany liczników przed ciszą, ms; `nil` = bez ciszy do sufitu.
    public let settled: Int?
    /// Przyrost liczników od otwarcia ekranu do ostatniej zmiany (albo do sufitu).
    public let counts: SessionEntryCounts

    public init(origin: Origin, firstFrame: Int, settled: Int?, counts: SessionEntryCounts) {
      self.origin = origin
      self.firstFrame = firstFrame
      self.settled = settled
      self.counts = counts
    }
  }

  /// Skąd przychodzi obserwacja. Ramkę otwiera wyłącznie ``renderStart``; koniec renderu liczy się jak zmiana
  /// (licznik `renders` rośnie na początku renderu), reszta tylko aktualizuje okno, które ma już ramkę.
  public enum Point: Sendable, Equatable {
    case renderStart
    case renderEnd
    /// Układ ekranu, dojście do dna po renderze, zmiana wysokości treści.
    case layout
  }

  public enum Step: Sendable, Equatable {
    /// Sprawdzić znowu najpóźniej o tej chwili.
    case wait(until: ContinuousClock.Instant)
    case done(Result)
    /// Okno zamknięte bez linii (albo już wcześniej zamknięte).
    case abandoned
  }

  private let opened: ContinuousClock.Instant
  private let snapshotsAtEntry: Int
  private let base: SessionEntryCounts
  private var frame: ContinuousClock.Instant?
  private var last: (counts: SessionEntryCounts, at: ContinuousClock.Instant)
  private var closed = false

  public init(opened: ContinuousClock.Instant, snapshotsAtEntry: Int, counts: SessionEntryCounts) {
    self.opened = opened
    self.snapshotsAtEntry = snapshotsAtEntry
    self.base = counts
    self.last = (counts, opened)
  }

  /// Punkt obserwacji. `true` = właśnie przyszła pierwsza ramka (tylko z ``Point/renderStart``).
  public mutating func observe(
    _ point: Point, snapshots: Int, counts: SessionEntryCounts, now: ContinuousClock.Instant
  ) -> Bool {
    guard !closed else { return false }
    guard frame != nil else {
      guard point == .renderStart, snapshots > snapshotsAtEntry else { return false }
      frame = now
      last = (counts, now)
      return true
    }
    if point == .renderEnd || counts != last.counts { last = (counts, now) }
    return false
  }

  /// Sprawdzenie ciszy: zmiana liczników od ostatniej obserwacji liczy się od tej chwili.
  public mutating func check(counts: SessionEntryCounts, now: ContinuousClock.Instant) -> Step {
    guard !closed else { return .abandoned }
    guard let frame else {
      guard now - opened >= Self.ceiling else { return .wait(until: opened + Self.ceiling) }
      closed = true
      return .abandoned
    }
    if counts != last.counts { last = (counts, now) }
    let origin: Origin = snapshotsAtEntry > 0 ? .memory : .skeleton
    let firstFrame = Self.milliseconds(frame - opened)
    if now - last.at >= Self.quiet {
      closed = true
      return .done(Result(
        origin: origin, firstFrame: firstFrame, settled: Self.milliseconds(last.at - frame), counts: last.counts - base))
    }
    if now - frame >= Self.ceiling {
      closed = true
      return .done(Result(origin: origin, firstFrame: firstFrame, settled: nil, counts: last.counts - base))
    }
    return .wait(until: min(last.at + Self.quiet, frame + Self.ceiling))
  }

  /// Pełne kilobajty (1024 B), zaokrąglone, nigdy ujemne.
  public static func kilobytes(bytes: Int) -> Int {
    max(0, Int((Double(bytes) / 1024).rounded()))
  }

  /// Rozmiar ramki: jej wiadomości zakodowane ponownie (JSON), w kB. `@concurrent` = poza głównym aktorem; transkrypt
  /// bywa 500 wiadomości i kilka MiB. Zadanie anulowane przed startem nie koduje (0).
  @concurrent
  public static func kilobytes(of messages: [TranscriptMessage]) async -> Int {
    guard !Task.isCancelled else { return 0 }
    return kilobytes(bytes: (try? JSONEncoder().encode(messages).count) ?? 0)
  }

  static func milliseconds(_ duration: Duration) -> Int {
    max(0, Int((duration / .milliseconds(1)).rounded()))
  }
}

/// Podbudżet śladów wejścia do sesji: najwyżej ``cap`` linii na ``window``. Budżet śladów apki
/// (`ContractReporter.traceCap`, 20 na godzinę) jest wspólny, a sesje zmienia się często — bez podbudżetu wejścia
/// zjadłyby miejsce innym śladom. Wzór: `TerminalOpenTraceBudget`.
public struct SessionEntryTraceBudget: Sendable, Equatable {
  public static let cap = 6
  public static let window: Duration = .seconds(3600)
  private var windowStart: ContinuousClock.Instant?
  private var admitted = 0

  public init() {}

  /// `true` = zapisać ślad (i odliczyć go z budżetu). Okno liczy się od pierwszego śladu po poprzednim oknie.
  public mutating func admit(now: ContinuousClock.Instant) -> Bool {
    if let start = windowStart, now - start < Self.window {
      guard admitted < Self.cap else { return false }
    } else {
      windowStart = now
      admitted = 0
    }
    admitted += 1
    return true
  }
}
