#if os(iOS)
import Foundation
import RarogCore

// Okres łaski przed kartą „dialog w terminalu” na ekranie sesji (`DecisionGraceTiming`): render na
// terminie i ślad pierwszej karty w `client.log`. Zastępnik sam w sobie stoi w doku w miejscu pola w trybie `.dock`
// (`DecisionDock.placement`), a w pozostałych trybach jest wierszem ogona transkryptu (`TranscriptRows.tail`). Wiersze,
// które tu przychodzą, to wiersz doku (pierwszy) i wiersze transkryptu. Właściciel: karty.

/// Stan okresu łaski ekranu sesji: zaplanowany render na terminie i ślad pierwszej karty. Właściciel: `+DecisionGrace`.
@MainActor
final class DecisionGraceChrome {
  /// Termin, na który czeka `timer`; `nil` = nic nie czeka.
  var deadline: Date?
  var timer: Task<Void, Never>?
  var trace = DecisionCardTrace()
}

extension SessionViewController {
  /// Po każdym renderze, z wierszem doku na początku `rows`. Termin okresu łaski nie przychodzi żadną ramką: bez renderu
  /// na terminie zastępnik stałby, aż coś innego ruszy stan, a karta zapasowa nigdy by nie weszła.
  func renderDecisionGrace(_ state: AppState, rows: [TranscriptRow]) {
    let now = Date()
    if let arrival = decisionGrace.trace.observe(state: state, sessionId: sessionId, rows: rows, now: now) {
      store.trace(DiagnosticsTrace.decisionCard(arrival))
    }
    let ends = state.decisionGraceEnds(for: sessionId, now: now)
    // Wiersze zbudowane tuż przed terminem mają jeszcze zastępnik, a termin minął, zanim tu doszliśmy: bez kolejnego
    // renderu zastępnik stałby, aż ruszy coś innego. Jeszcze jeden render, z odstępem (bez pętli przy rozjeździe).
    let deadline = ends ?? (rows.contains(.decisionPending) ? now.addingTimeInterval(0.05) : nil)
    guard deadline != decisionGrace.deadline else { return }
    decisionGrace.timer?.cancel()
    decisionGrace.deadline = deadline
    guard let deadline else {
      decisionGrace.timer = nil
      return
    }
    // Zapas 20 ms: render po terminie, nie tuż przed nim (wtedy okres jeszcze trwa i termin trzeba by liczyć znowu).
    let delay = max(0, deadline.timeIntervalSince(now)) + 0.02
    decisionGrace.timer = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(delay))
      guard !Task.isCancelled, let self else { return }
      // Następny render liczy termin od nowa — także gdy okres (np. przy cofniętym zegarze) jeszcze trwa.
      self.decisionGrace.deadline = nil
      self.scheduleRender()
    }
  }
}
#endif
