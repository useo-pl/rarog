import Foundation
import RarogContract
import RarogCore

// Karta pytania: model prezentacji składany z `QuestionRequest`, stanu wysyłki
// tego ekranu i blokady sesji. Reguły wyboru, pola własnej odpowiedzi, klawiszy i potwierdzenia
// w oknie: `QuestionCardState.swift`. Właściciel: karty pytań.
//
// Karta jest rendererem pól serwera: chrome CLI odpada po `role`, pole własnej odpowiedzi
// stoi po `customAnswer`, opcja bez przycisku po `terminalOnly`. Wybór jedzie ETYKIETĄ,
// więc kolejność na karcie wolno zmienić (rekomendacja na górę), a cyfra klawisza to n-ta
// widoczna opcja karty, nie cyfra z ekranu CLI.

/// Odpowiedź, która wyszła z tego urządzenia: wartości per pytanie i podpis.
public struct QuestionAnswered: Sendable, Equatable {
  /// Per pytanie; puste, gdy ekran zna tylko podpis (odpowiedź z poprzedniej wizyty w sesji).
  public let answers: [[String]]
  public let summary: String

  public init(answers: [[String]]) {
    self.answers = answers
    summary = AnswerRules.summary(answers)
  }

  init(summary: String) {
    answers = []
    self.summary = summary
  }
}

/// Karta pytania w transkrypcie.
public struct QuestionCardModel: Sendable, Equatable {
  /// Opcja autora pytania (chrome CLI na kartę nie wchodzi).
  public struct Option: Sendable, Equatable {
    /// Etykieta DOSŁOWNA — po niej serwer wybiera odpowiedź.
    public let label: String
    public let description: String?
    /// Kolumna klucza: cyfra n-tej widocznej opcji pytania albo „–" przy opcji, której nie da się
    /// wybrać.
    public let key: String
    /// Rekomendacja autora: pozycja na górze i plakietka-słowo.
    public let recommended: Bool
    /// `false` = opcja „tylko w terminalu": widoczna, ale nie jest celem gestu ani klawisza.
    public let selectable: Bool
    /// Podgląd opcji od autora pytania: kod, makieta, diagram. Spacje i złamania linii
    /// są treścią; serwer przycina kopię i ucięcie oznacza ostatnią linią. `nil` = bez podglądu.
    public let preview: String?
  }

  /// Jedno pytanie formularza.
  public struct Section: Sendable, Equatable, Identifiable {
    public let index: Int
    /// „pytanie 2/3 · nagłówek" przy kilku pytaniach; pusty przy jednym (nagłówek niesie etykieta karty).
    public let head: String
    /// Zdanie pytania z podziałami wierszy.
    public let question: String
    public let multiSelect: Bool
    public let options: [Option]
    /// Ostatni wiersz „Własna odpowiedź".
    public let customAnswer: Bool
    /// Pole „Notatka" do wybranej opcji — wyłącznie gdy serwer da `notes: true`.
    public let notes: Bool
    /// Ekran PRZEGLĄDU formularza: pary pytanie → odpowiedzi policzone przez
    /// serwer. Sekcja pokazuje je listą zamiast surowej treści pytania; opcje zostają dosłowne.
    /// `nil` = zwykłe pytanie — także przy pustej liście (nie ma czego pokazać zamiast treści).
    public let review: [ReviewPair]?

    public var id: Int { index }
  }

  /// Etap karty z punktu widzenia tego urządzenia.
  public enum Phase: Sendable, Equatable {
    case choose
    /// Żądanie w drodze — „Wysłano „X" → czekam na ekran".
    case sending(QuestionAnswered)
    /// Serwer przyjął — „Odpowiedź przyjęta: „X"", karta czeka na rozstrzygnięcie albo stoi w oknie.
    case sent(QuestionAnswered)
  }

  public let qId: String
  public let sessionId: String
  /// Etykieta CAŁEJ karty, jedna linia: „pytanie · nagłówek CLI" przy jednym pytaniu (samo „pytanie", gdy
  /// nagłówek pusty), „pytanie" przy formularzu (numerację i nagłówki niosą sekcje).
  public let eyebrow: String
  /// Etykieta karty dla czytnika: „Pytanie od agenta, nagłówek" przy jednym pytaniu,
  /// „Formularz od agenta, 2 pytania" przy kilku.
  public let spokenHeader: String
  public let createdAt: Date?
  public let sections: [Section]
  /// Jedno pytanie jednokrotnego wyboru bez pola własnej odpowiedzi: tapnięcie wysyła.
  public let instant: Bool
  /// Dosłowna etykieta wyjścia z formularza (opcja `role: exit` przy jednym pytaniu).
  public let exitLabel: String?
  public let phase: Phase
  /// Zdanie pod kartą: brakująca odpowiedź, odmowa serwera, błąd sieci.
  public let error: String?
  /// Powód, dla którego karta jest bez odpowiedzi (sesja nieobsługiwana, herdr, niezgodność).
  public let lockedReason: String?
  /// Pytania nie ma już w kolejce serwera — karta stoi samym potwierdzeniem.
  public let held: Bool

  /// Karta przyjmuje gest i klawisz.
  public var interactive: Bool { phase == .choose && lockedReason == nil && !held }

  /// Karta ma „Odpowiedz" (każda poza `instant`).
  public var hasSubmit: Bool { !instant }

  /// Ta sama karta w innym etapie (karta trzymana potwierdzeniem po zniknięciu z kolejki).
  func with(phase: Phase, held: Bool, error: String? = nil) -> QuestionCardModel {
    QuestionCardModel(
      qId: qId, sessionId: sessionId, eyebrow: eyebrow, spokenHeader: spokenHeader, createdAt: createdAt,
      sections: sections, instant: instant, exitLabel: exitLabel, phase: phase, error: error,
      lockedReason: lockedReason, held: held)
  }

  /// Karta z pytania serwera. `phase`, `error` i `locked` daje wołający (stan ekranu i sesji).
  public static func make(
    _ request: QuestionRequest, phase: Phase = .choose, error: String? = nil, locked: String? = nil
  ) -> QuestionCardModel {
    let total = request.questions.count
    let custom = request.customAnswer == true
    let sections = request.questions.enumerated().map { index, question in
      Section(
        index: index,
        // Jedno pytanie: nagłówek CLI idzie do etykiety karty, linii sekcji nie ma (jedna linia zamiast dwóch).
        head: total > 1 ? UICopy.questionSectionHead(index: index + 1, total: total, header: question.header) : "",
        question: question.question,
        multiSelect: question.multiSelect,
        options: visibleOptions(question),
        customAnswer: custom,
        notes: question.notes == true,
        review: question.review.flatMap { $0.isEmpty ? nil : $0 }
      )
    }
    // Podgląd też wyłącza `instant`: tapnięcie najpierw pokazuje podgląd tej opcji,
    // wysyła dopiero „Odpowiedz" — człowiek ma móc przejrzeć podglądy przed wyborem.
    let instant = total == 1 && request.questions.first?.multiSelect == false && !custom
      && sections.first?.hasPreview == false
    let header = total == 1 ? (request.questions.first?.header ?? "") : ""
    let named = header.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? [] : [header]
    return QuestionCardModel(
      qId: request.qId,
      sessionId: request.sessionId,
      eyebrow: UICopy.list([UICopy.questionEyebrow(index: 1, total: 1)] + named, .dot),
      spokenHeader: UICopy.list([UICopy.questionSpokenHeader(total: total)] + named, .comma),
      createdAt: ServerTime.parse(request.createdAt),
      sections: sections,
      instant: instant,
      exitLabel: exitLabel(request),
      phase: phase,
      error: error,
      lockedReason: locked,
      held: false
    )
  }

  /// Opcje TAK, JAK STOJĄ NA KARCIE: bez chrome CLI (`role` inne niż odpowiedź — rozpoznaje je
  /// serwer; brak pola = odpowiedź), rekomendacja na górze, reszta w kolejności autora.
  /// Jedyne źródło kolejności dla widoku i dla cyfr klawiatury.
  static func visibleOptions(_ question: Question) -> [Option] {
    let shown = question.options.filter { ($0.role ?? .answer) == .answer }
    let ordered = shown.filter { isRecommended($0.label) } + shown.filter { !isRecommended($0.label) }
    return ordered.enumerated().map { index, option in
      let selectable = option.terminalOnly != true
      return Option(
        label: option.label,
        description: option.description.flatMap { $0.isEmpty ? nil : $0 },
        key: selectable ? String(index + 1) : "–",
        recommended: isRecommended(option.label),
        selectable: selectable,
        preview: option.preview.flatMap { $0.isEmpty ? nil : $0 }
      )
    }
  }

  /// Rekomendacja autora pytania: sufiks „(Recommended)" / „(Rekomendacja)" na końcu etykiety.
  /// Pola na to nie ma — autor pisze ją w etykiecie, która jedzie dalej dosłownie; plakietka jest
  /// warstwą widoku i niczego w wysyłce nie zmienia.
  static func isRecommended(_ label: String) -> Bool {
    let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.contains(/\((?:recommended|rekomendacja)\)\s*[.!]?$/.ignoresCase())
  }

  /// Wyjście z formularza: dokładnie jedno pytanie z opcją `role: exit`, którą wolno wybrać.
  /// Przy kilku pytaniach i na karcie bez chrome CLI wyjścia nie ma (serwer nie zna jego cyfry).
  static func exitLabel(_ request: QuestionRequest) -> String? {
    guard request.questions.count == 1,
      let exit = request.questions.first?.options.first(where: { $0.role == .exit }),
      exit.terminalOnly != true
    else { return nil }
    return exit.label
  }
}

extension QuestionCardModel.Section {
  /// Któraś widoczna opcja niesie podgląd.
  public var hasPreview: Bool { options.contains { $0.preview != nil } }

  /// Opcja, której podgląd stoi pod opcjami sekcji. `picked` = wartości, które karta
  /// pokazuje jako wybrane (szkic albo wysłana odpowiedź), w kolejności gestów.
  /// - nic nie wybrano: PIERWSZA widoczna opcja z podglądem — człowiek widzi go przed wyborem;
  /// - wybrano: ostatnio zaznaczona opcja Z PODGLĄDEM (przy jednokrotnym — ta jedna); wybór bez
  ///   podglądu nie pokazuje cudzego, bo podpis bloku kłamałby o tym, co zaznaczone;
  /// - wpisana własna odpowiedź (`customActive`) to też wybór bez podglądu.
  public func previewOption(picked: [String], customActive: Bool = false) -> QuestionCardModel.Option? {
    guard !customActive else { return nil }
    guard !picked.isEmpty else { return options.first { $0.preview != nil } }
    for label in picked.reversed() {
      if let option = options.first(where: { $0.label == label }), option.preview != nil { return option }
    }
    return nil
  }
}

extension TranscriptRows {
  /// Karty pytań pod treścią: najpierw te z kolejki serwera (w jej kolejności), potem karty
  /// trzymane samym potwierdzeniem — trzymana karta nie przesuwa kolejnych. Karta w doku (`docked`)
  /// stoi w miejscu pola, nie tutaj.
  static func questionRows(
    view: TranscriptState, ui: TranscriptUIState, locked: String?, docked: DecisionCard? = nil
  ) -> [TranscriptRow] {
    var rows: [TranscriptRow] = view.pendingQuestions
      .filter { docked != .question(qId: $0.qId) }
      .map { questionRow($0, view: view, ui: ui, locked: locked) }
    let live = Set(view.pendingQuestions.map(\.qId))
    let held = ui.questions.flights.values
      .filter { !live.contains($0.card.qId) && docked != .heldQuestion(qId: $0.card.qId) }
      .sorted { ($0.goneAt ?? .distantFuture, $0.card.qId) < ($1.goneAt ?? .distantFuture, $1.card.qId) }
    rows += held.map(heldQuestionRow)
    return rows
  }

  /// Karta pytania z kolejki serwera — w transkrypcie i w doku ten sam model.
  static func questionRow(
    _ request: QuestionRequest, view: TranscriptState, ui: TranscriptUIState, locked: String?
  ) -> TranscriptRow {
    let cards = ui.questions
    let phase: QuestionCardModel.Phase
    if let flight = cards.flights[request.qId] {
      phase = flight.phase
    } else if let attempt = view.decisions[request.qId] {
      // Odpowiedź z poprzedniej wizyty w sesji jeszcze w drodze: ekran zna tylko jej podpis.
      phase = .sending(QuestionAnswered(summary: attempt.choice))
    } else {
      phase = .choose
    }
    return .question(QuestionCardModel.make(request, phase: phase, error: cards.errors[request.qId], locked: locked))
  }

  /// Karta trzymana samym potwierdzeniem odpowiedzi (pytania nie ma już w kolejce serwera).
  static func heldQuestionRow(_ flight: QuestionFlight) -> TranscriptRow {
    .question(flight.card.with(phase: flight.phase, held: true))
  }
}
