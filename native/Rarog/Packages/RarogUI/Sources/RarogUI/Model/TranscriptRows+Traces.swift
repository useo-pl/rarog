import Foundation
import RarogContract
import RarogCore

// Ślad własnej decyzji w transkrypcie: cichy wiersz bez przycisków — co z tego urządzenia
// zatwierdzono, odrzucono albo odpowiedziano. Stoi na miejscu decyzji (pod ostatnią wiadomością z chwili decyzji,
// także po restarcie serwera), a nie w `tail` jak ślad `CardNotice`, więc nowe wiadomości przychodzą pod nim; seria
// kroków narzędzi przerywa się na nim; nie gaśnie po 6 s. Fakty trzyma rdzeń (`RarogCore/DecisionTraces.swift`), zdanie składa `UICopy.decisionTrace`.
// Właściciel: karty.

/// Wiersz śladu decyzji. `id` = `trace.<cardId>`: jeden wiersz na kartę, stabilny między renderami.
public struct DecisionTraceRowModel: Sendable, Equatable {
  public let id: String
  public let outcome: DecisionTrace.Outcome
  public let text: String
  public var turn = TurnMark()

  init(_ trace: DecisionTrace) {
    id = "trace.\(trace.cardId)"
    outcome = trace.outcome
    text = UICopy.decisionTrace(trace)
  }
}

/// Skracanie treści w zdaniu śladu: komendy i własnej odpowiedzi (etykiety opcji są krótkie, ale idą tą samą drogą).
enum DecisionTraceText {
  /// Najwięcej znaków jednej wartości; dłuższa kończy się „…”.
  static let limit = 60

  /// Pierwsza niepusta linia, białe znaki zwinięte do spacji, ścieżki skrócone jak w linii listy; ucięta albo
  /// wielolinijkowa wartość kończy się „…”.
  static func clip(_ value: String) -> String {
    let lines = value.split(whereSeparator: \.isNewline)
      .map { $0.split(whereSeparator: \.isWhitespace).joined(separator: " ") }
      .filter { !$0.isEmpty }
    guard let first = lines.first else { return "" }
    let line = PathText.shortenPaths(first)
    if line.count > limit {
      return String(line.prefix(limit)).trimmingCharacters(in: .whitespaces) + "…"
    }
    return lines.count > 1 ? line + " …" : line
  }
}

extension TranscriptRows {
  /// Ślady decyzji w kolejności decyzji, do wplecenia między wiadomości (`messageRows`). Miejsce śladu liczy rdzeń
  /// (`TranscriptState.traceSlots`): numer wiadomości w tej samej numeracji serwera, po restarcie czas serwera.
  struct TraceQueue {
    private var pending: [(trace: DecisionTrace, slot: Int)]
    /// `seq` wiadomości, nad którymi stoi ślad: granice serii kroków narzędzi (`ToolRuns.find`).
    let breaks: Set<Int>

    init(_ view: TranscriptState) {
      let slots = view.traceSlots()
      pending = Array(zip(view.decisionTraces, slots))
      breaks = Set(slots.compactMap { $0 < view.messages.count ? view.messages[$0].seq : nil })
    }

    /// Ślady, które stoją nad wiadomością o indeksie `index` w `messages`.
    mutating func before(index: Int) -> [TranscriptRow] {
      take { $0 <= index }
    }

    /// Reszta — pod ostatnią wiadomością.
    mutating func rest() -> [TranscriptRow] { take { _ in true } }

    private mutating func take(_ due: (Int) -> Bool) -> [TranscriptRow] {
      let taken = pending.filter { due($0.slot) }
      pending.removeAll { due($0.slot) }
      return taken.map { .decisionTrace(DecisionTraceRowModel($0.trace)) }
    }
  }
}
