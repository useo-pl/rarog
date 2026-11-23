import Foundation
import RarogContract
import RarogCore

// Projekcja sesji dla agenta głosowego: tekst tur z transkryptu, który apka już trzyma (okno
// `CoreLimits.maxTranscriptMessages`), w etykietach serwera.
// Właściciel: agent głosowy.
//
// Do OpenAI idzie tylko to, co telefon już dostaje: tekst człowieka i agenta, skrót wywołania narzędzia (`summary`,
// do 120 znaków z serwera), obraz jako znacznik. Bez notek harnessu, wiadomości systemowych, zdań serwera (blok
// tekstu z `ref`) i bez wyników narzędzi i myślenia (tych transkrypt nie niesie). Każda tura przechodzi przez maskę
// sekretów, zanim liczy się budżet, więc budżet dotyczy tekstu, który naprawdę wyjdzie.

/// Projekcja z okna transkryptu, gotowa do bloku `<transcript>` instrukcji.
struct RealtimeProjection: Sendable, Equatable {
  /// Tekst tur z notkami pominięcia na początku; zamaskowany i z zneutralizowanymi znacznikami bloku.
  let text: String
  /// Tury w oknie (pominięte budżetem też).
  let turns: Int
  /// Najstarsze tury, które budżet zastąpił notką.
  let omittedTurns: Int
  /// Najnowsza tura nie zmieściła się w całości i ma wycięty środek.
  let cutTurn: Bool
  /// Okno telefonu jest pełne: starszych wiadomości telefon nie ma.
  let windowFull: Bool
  /// Najwyższy `seq` okna (także wiadomości pominiętych w tekście) — od niego liczy się synchronizacja nowych tur.
  let lastSeq: Int?
}

/// Nowe tury od ostatniej synchronizacji, do `conversation.item.create`.
struct RealtimeSessionUpdate: Sendable, Equatable {
  let text: String
  /// Ile nowych tur się zaczęło (dalsza numeracja).
  let newTurns: Int
}

enum RealtimeProjector {
  /// Character budget of the projection, about 5k tokens at 2.7–2.9 characters per token. Every response pays for
  /// the whole instruction, so the newest turns stay here and older ones go through `ask_session` (Haiku).
  /// Measured on 18 questions: the same accuracy as 165,000 characters at 42 % lower cost.
  /// The hard ceiling of `instructions` is 65,536 tokens (server error at 68,224).
  static let budget = 15_000
  /// Ceiling of one sync during the conversation: no larger than the projection itself.
  static let updateBudget = 15_000
  /// Znacznik obrazu (blok obrazu albo zdjęcie w załączniku).
  static let imageMarker = "[image]"
  static let fileMarker = "[file]"

  // MARK: - Projekcja

  /// Projekcja z wiadomości store'u. Bierze najwyżej okno telefonu (najnowsze), resztę ucina.
  static func project(_ messages: [TranscriptMessage], budget: Int = budget) -> RealtimeProjection {
    let window = Array(messages.suffix(CoreLimits.maxTranscriptMessages))
    let windowFull = window.count >= CoreLimits.maxTranscriptMessages
    let turns = render(window, firstNumber: 1, continuation: nil).map(prepare)
    let fitted = fit(turns, budget: budget, windowFull: windowFull)
    return RealtimeProjection(
      text: fitted.text, turns: turns.count, omittedTurns: fitted.omitted, cutTurn: fitted.cut,
      windowFull: windowFull, lastSeq: window.map(\.seq).max())
  }

  /// Wiadomości po `seq` jako tekst aktualizacji; `nil`, gdy nic z nich nie idzie do modelu.
  /// `turnBase` = ile tur model już zna (numeracja nowych startuje od następnej).
  static func update(
    _ messages: [TranscriptMessage], after seq: Int, turnBase: Int, budget: Int = updateBudget
  ) -> RealtimeSessionUpdate? {
    let fresh = messages.filter { $0.seq > seq }
    let turns = render(fresh, firstNumber: turnBase + 1, continuation: turnBase).map(prepare)
    guard !turns.isEmpty else { return nil }
    let fitted = fit(turns, budget: budget, windowFull: false)
    let newTurns = turns.filter { !$0.continued }.count
    return RealtimeSessionUpdate(text: fitted.text, newTurns: newTurns)
  }

  // MARK: - Tury

  struct Turn: Sendable, Equatable {
    var number: Int
    /// Tura zaczęta przed oknem (bez promptu) albo ciąg tury znanej modelowi z wcześniejszej synchronizacji.
    var continued: Bool
    var lines: [String]
    var text: String { lines.joined(separator: "\n") }
  }

  /// Wiadomości → tury. Tura zaczyna się od wiadomości człowieka; wiadomości agenta przed pierwszą z nich trafiają
  /// do tury `continuation` (ciąg tury znanej modelowi) albo do tury 0 bez promptu.
  static func render(_ messages: [TranscriptMessage], firstNumber: Int, continuation: Int?) -> [Turn] {
    var turns: [Turn] = []
    var number = firstNumber - 1
    for message in messages {
      guard message.notice == nil, message.promptBlocked == nil else { continue }
      switch message.role {
      case .user:
        let lines = userLines(message)
        guard !lines.isEmpty else { continue }
        number += 1
        turns.append(Turn(number: number, continued: false, lines: ["### Turn \(number) · \(message.at)"] + lines))
      case .assistant:
        let lines = agentLines(message)
        guard !lines.isEmpty else { continue }
        if turns.isEmpty {
          let header =
            if let continuation { "### Turn \(continuation) (continued)" } else { "### Turn 0 (its prompt is outside the window)" }
          turns.append(Turn(number: continuation ?? 0, continued: true, lines: [header]))
        }
        turns[turns.count - 1].lines += lines
      case .system:
        continue
      }
    }
    return turns
  }

  private static func userLines(_ message: TranscriptMessage) -> [String] {
    var lines: [String] = []
    let text = humanText(message.blocks)
    if !text.isEmpty { lines.append("USER: \(text)") }
    for block in message.blocks { if case .image = block { lines.append(imageMarker) } }
    for attachment in message.attachments ?? [] {
      lines.append(attachment.kind == .image ? imageMarker : fileMarker)
    }
    return lines
  }

  private static func agentLines(_ message: TranscriptMessage) -> [String] {
    var lines: [String] = []
    for block in message.blocks {
      switch block {
      case let .text(text, ref) where ref == nil:
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { lines.append("AGENT: \(trimmed)") }
      case let .toolCall(call):
        let summary = call.summary.split(whereSeparator: \.isNewline).joined(separator: " ")
        lines.append("[tool \(call.toolName): \(summary)]")
      case .image:
        lines.append(imageMarker)
      case .text, .unsupported:
        continue
      }
    }
    return lines
  }

  private static func humanText(_ blocks: [Block]) -> String {
    blocks.compactMap { block -> String? in
      guard case let .text(text, ref) = block, ref == nil else { return nil }
      return text
    }
    .joined(separator: "\n")
    .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Maska sekretów i neutralizacja znaczników bloków — przed liczeniem budżetu.
  private static func prepare(_ turn: Turn) -> Turn {
    var out = turn
    out.lines = turn.lines.map { escapeBlock(RealtimeSecretMask.apply($0)) }
    return out
  }

  /// Otwarcie albo zamknięcie bloku danych wpisane w treść sesji nie zamyka bloku w instrukcji.
  static func escapeBlock(_ text: String) -> String {
    text.replacing(/<(\/?)(transcript|session-update)\b/.ignoresCase()) { match in
      "‹\(match.output.1)\(match.output.2)"
    }
  }

  // MARK: - Budżet

  private static func omittedNote(_ first: Int, _ last: Int) -> String {
    "[Omitted: turns \(first)–\(last) (the older part of the session is over the size budget). "
      + "Ask ask_session about them.]"
  }

  private static let windowNote =
    "[The phone keeps only the latest messages of this session; older ones are known only through ask_session. "
    + "Turn numbers count from the first message kept.]"

  private static func cutMarker(_ omitted: Int) -> String { "\n[… \(omitted) characters of this turn omitted …]\n" }

  private static func join(_ parts: [String]) -> String { parts.joined(separator: "\n\n") }

  /// Najnowsze tury w całości, starsze zastąpione notką; najnowsza ponad budżet — z wyciętym środkiem.
  private static func fit(_ turns: [Turn], budget: Int, windowFull: Bool) -> (text: String, omitted: Int, cut: Bool) {
    let head = windowFull ? [windowNote] : []
    let rendered = turns.map(\.text)
    let whole = join(head + rendered)
    if whole.count <= budget { return (whole, 0, false) }
    func notes(keptFrom: Int) -> [String] {
      guard keptFrom > 0, let first = turns.first else { return head }
      return head + [omittedNote(first.number, turns[keptFrom - 1].number)]
    }
    // Długości liczone raz: łączenie całego tekstu przy każdej turze kosztowałoby kwadrat rozmiaru okna.
    let lengths = rendered.map(\.count)
    func joinedLength(_ parts: [Int]) -> Int { parts.reduce(0, +) + 2 * max(0, parts.count - 1) }
    var keptFrom = rendered.count
    var keptLength = 0
    while keptFrom > 0 {
      let turnsLength = keptLength + lengths[keptFrom - 1] + (keptLength > 0 ? 2 : 0)
      let candidate = joinedLength(notes(keptFrom: keptFrom - 1).map(\.count) + [turnsLength])
      guard candidate <= budget else { break }
      keptLength = turnsLength
      keptFrom -= 1
    }
    if keptFrom < rendered.count {
      return (join(notes(keptFrom: keptFrom) + rendered[keptFrom...]), keptFrom, false)
    }
    // Nawet najnowsza tura się nie mieści: zostaje z wyciętym środkiem, wszystko starsze idzie do notki.
    let last = rendered.count - 1
    let prefix = join(notes(keptFrom: last))
    let room = max(0, budget - prefix.count - (prefix.isEmpty ? 0 : 2))
    let turn = rendered[last]
    let marker = cutMarker(turn.count)
    let keep = max(0, room - marker.count)
    let headCount = keep * 2 / 5
    let tailCount = keep - headCount
    let cut = String(turn.prefix(headCount)) + cutMarker(turn.count - keep) + String(turn.suffix(tailCount))
    let text = prefix.isEmpty ? cut : prefix + "\n\n" + cut
    return (String(text.prefix(budget)), last, true)
  }
}
