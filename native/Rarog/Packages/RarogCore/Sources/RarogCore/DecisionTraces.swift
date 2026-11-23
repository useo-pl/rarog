import Foundation
import RarogContract

// Ślad własnej decyzji w transkrypcie: co z tego urządzenia zatwierdzono, odrzucono albo odpowiedziano.
// Karta decyzji staje w doku zamiast w transkrypcie, więc bez śladu
// z transkryptu nie widać, co zdecydowano. Ślad żyje w pamięci apki, per sesja: bez
// kontraktu serwera i bez ramek SSE, ginie po zamknięciu apki, wylogowaniu i wypadnięciu transkryptu z pamięci.
// Zdanie składa RarogUI. Właściciel: karty.

/// Fakty jednej własnej decyzji, która doszła (serwer przyjął: 200).
public struct DecisionTrace: Sendable, Equatable {
  public enum Outcome: Sendable, Equatable {
    /// Zgoda: „Zatwierdź” albo opcja „zawsze”.
    case allowed
    case denied
    /// Odpowiedź na kartę pytania.
    case answered
  }

  /// `permId` albo `qId` karty — jeden ślad na kartę.
  public let cardId: String
  public let outcome: Outcome
  /// Zgoda: nazwa narzędzia z karty (z CLI); `nil` przy pytaniu.
  public let toolName: String?
  /// Zgoda na plan: ślad mówi „plan”, bez treści planu.
  public let plan: Bool
  /// Zgoda: tekst karty (komenda) tak, jak go podał serwer; skraca RarogUI.
  public let command: String?
  /// Pytanie: wartości odpowiedzi per pytanie, tak jak wyszły (etykiety opcji albo własny tekst).
  public let answers: [[String]]
  /// `seq` ostatniej domkniętej wiadomości w chwili decyzji: ślad stoi pod nią, a nowe wiadomości przychodzą pod
  /// śladem. `nil` = transkrypt był pusty. Ważny tylko w numeracji `epoch`.
  public let afterSeq: Int?
  /// Czas serwera (`at`) tej samej wiadomości: kotwica po restarcie serwera, który numeruje transkrypt od nowa.
  public let afterAt: String?
  /// Proces serwera, który nadał `afterSeq` (`TranscriptState.messagesEpoch` z chwili decyzji).
  public let epoch: String?
  public let at: Date
  /// Karta kanału zgód: 200 znaczy tylko „serwer przyjął odpowiedź”, więc ślad mówi „wysłana”, nie
  /// „Zatwierdzono”, i staje dopiero, gdy karta zniknie (do tej chwili to samo mówi stopka karty).
  public let hookChannel: Bool

  public init(
    cardId: String, outcome: Outcome, toolName: String?, plan: Bool, command: String?, answers: [[String]],
    afterSeq: Int?, afterAt: String? = nil, epoch: String? = nil, at: Date, hookChannel: Bool = false
  ) {
    self.cardId = cardId
    self.outcome = outcome
    self.toolName = toolName
    self.plan = plan
    self.command = command
    self.answers = answers
    self.afterSeq = afterSeq
    self.afterAt = afterAt
    self.epoch = epoch
    self.at = at
    self.hookChannel = hookChannel
  }
}

extension TranscriptState {
  /// Szkic śladu w chwili gestu (`decisionStarted`): fakty karty i miejsce w transkrypcie z tej chwili, bo strumień
  /// potrafi zdjąć kartę, zanim wróci odpowiedź. Szkic karty kanału zgód ma `hookChannel`: staje się śladem
  /// dopiero, gdy decyzja jest przyjęta (200) i karty już nie ma, w dowolnej kolejności (`Reducer.swift`,
  /// `recordHookTrace`). `nil` = karty nie ma albo to zwolnienie do terminala.
  func traceDraft(cardId: String, choice: String, answers: [[String]], at: Date) -> DecisionTrace? {
    let afterSeq = messages.last?.seq
    let afterAt = messages.last?.at
    if let card = pendingPermissions.first(where: { $0.permId == cardId }) {
      guard let decision = PermissionDecision(rawValue: choice) else { return nil }
      let outcome: DecisionTrace.Outcome
      switch decision {
      case .allow, .allowAlways: outcome = .allowed
      case .deny: outcome = .denied
      case .release: return nil
      }
      let plan = card.subject == .plan
      return DecisionTrace(
        cardId: cardId, outcome: outcome, toolName: card.toolName, plan: plan, command: plan ? nil : card.displayText,
        answers: [], afterSeq: afterSeq, afterAt: afterAt, epoch: messagesEpoch, at: at,
        hookChannel: card.isHookChannel)
    }
    guard pendingQuestions.contains(where: { $0.qId == cardId }) else { return nil }
    return DecisionTrace(
      cardId: cardId, outcome: .answered, toolName: nil, plan: false, command: nil,
      answers: answers.isEmpty ? [[choice]] : answers, afterSeq: afterSeq, afterAt: afterAt,
      epoch: messagesEpoch, at: at)
  }

  /// Karta kanału po przyjętej decyzji zniknęła: odłożony szkic (`finishDecision`) staje się śladem. Karta ekranowa
  /// i pytanie nie mają tu szkicu (ślad stanął przy 200), więc nic się nie dzieje.
  mutating func recordHookTrace(_ cardId: String) {
    guard let draft = traceDrafts.removeValue(forKey: cardId) else { return }
    record(draft)
  }

  /// Ślad decyzji, która doszła: jeden na kartę (powtórzone 200 nie dubluje), najwyżej `maxDecisionTraces` na sesję.
  mutating func record(_ trace: DecisionTrace) {
    guard !decisionTraces.contains(where: { $0.cardId == trace.cardId }) else { return }
    decisionTraces.append(trace)
    let over = decisionTraces.count - CoreLimits.maxDecisionTraces
    if over > 0 { decisionTraces.removeFirst(over) }
  }
}

extension TranscriptState {
  /// Miejsce każdego śladu, w kolejności `decisionTraces`: indeks w `messages`, nad którym ślad stoi
  /// (`messages.count` = pod ostatnią wiadomością).
  /// - Ta sama numeracja (`epoch == messagesEpoch`): nad pierwszą wiadomością o `seq` większym niż `afterSeq`.
  /// - Inna numeracja (restart serwera numeruje transkrypt od nowa, a ślady zostają): nad pierwszą wiadomością
  ///   o czasie serwera późniejszym niż `afterAt`. Czas wiadomości pochodzi z pliku rozmowy, więc restart go nie
  ///   zmienia; wiadomość o czasie równym kotwicy stoi nad śladem. Bez czytelnego `afterAt` ślad idzie na koniec.
  /// - Pusty transkrypt w chwili decyzji: nad pierwszą wiadomością.
  public func traceSlots() -> [Int] {
    var times: [Date]?
    func serverTimes() -> [Date] {
      if let times { return times }
      let parsed = messages.map { ISOTime.parse($0.at) ?? .distantPast }
      times = parsed
      return parsed
    }
    return decisionTraces.map { trace in
      guard let afterSeq = trace.afterSeq else { return 0 }
      if trace.epoch == messagesEpoch {
        return messages.firstIndex { $0.seq > afterSeq } ?? messages.count
      }
      guard let anchor = trace.afterAt.flatMap(ISOTime.parse) else { return messages.count }
      return serverTimes().firstIndex { $0 > anchor } ?? messages.count
    }
  }

  /// `seq` wiadomości, nad którymi stoi ślad decyzji. Tu przerywa się seria kroków narzędzi (`ToolRuns.find`
  /// w RarogUI), żeby ślad nie stanął nad rozwijakiem, który chowa wywołanie sprzed decyzji.
  public func traceBreaks() -> Set<Int> {
    Set(traceSlots().compactMap { $0 < messages.count ? messages[$0].seq : nil })
  }
}
