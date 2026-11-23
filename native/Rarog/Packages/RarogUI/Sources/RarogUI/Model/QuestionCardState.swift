import Foundation
import Observation
import RarogContract
import RarogCore

// Stan kart pytań na tym ekranie: szkic odpowiedzi (zaznaczenia i pole „Własna odpowiedź"),
// odpowiedź w drodze, potwierdzenie trzymane w oknie i klawisze karty.
// Czyste reguły — testy na macOS. Właściciel: karty pytań.

/// Okno potwierdzenia po odpowiedzi (`docs/design.md`, „States").
public enum QuestionTiming {
  /// Potwierdzenie stoi tyle, gdy następna karta już przyszła — czas na przeczytanie.
  public static let sentHold: TimeInterval = 1.5
  /// Bez następnej karty potwierdzenie czeka tyle na kolejny krok formularza (przychodzi dopiero
  /// po odczycie ekranu), żeby widok nie pustoszał między krokami.
  public static let sentGap: TimeInterval = 6
}

/// Szkic odpowiedzi na jedną kartę: zaznaczenia i tekst pola „Własna odpowiedź" per pytanie.
///
/// Wpisany tekst i zaznaczenie to DWIE odpowiedzi na jedno pytanie — zostaje świeższa:
/// pisanie gasi zaznaczenia tego pytania, wybór opcji czyści pole.
public struct QuestionDraft: Sendable, Equatable {
  public private(set) var picks: [[String]]
  public private(set) var custom: [String]
  public private(set) var customOpen: [Bool]
  /// Notatka do wybranej opcji per pytanie. NIE jest odpowiedzią: nie gasi zaznaczeń
  /// ani pola własnej odpowiedzi i nie przenosi klawiatury.
  public private(set) var notes: [String]
  /// Pytanie ostatniego gestu — adres cyfr, gdy każde pytanie ma już odpowiedź.
  public private(set) var lastSection: Int?

  public init(sections: Int) {
    picks = Array(repeating: [], count: sections)
    custom = Array(repeating: "", count: sections)
    customOpen = Array(repeating: false, count: sections)
    notes = Array(repeating: "", count: sections)
  }

  /// Ten sam szkic dla karty o innej liczbie pytań (serwer przebudował kartę pod tym samym `qId`).
  func fitted(to sections: Int) -> QuestionDraft {
    guard picks.count != sections else { return self }
    var draft = QuestionDraft(sections: sections)
    for index in 0..<min(sections, picks.count) {
      draft.picks[index] = picks[index]
      draft.custom[index] = custom[index]
      draft.customOpen[index] = customOpen[index]
      draft.notes[index] = notes[index]
    }
    draft.lastSection = lastSection.flatMap { $0 < sections ? $0 : nil }
    return draft
  }

  /// Tapnięcie opcji: przy jednokrotnym wyborze ponowny tap odznacza, przy
  /// wielokrotnym przełącza. Wybór czyści pole własnej odpowiedzi.
  public mutating func toggle(_ label: String, in section: Int, multiSelect: Bool) {
    guard picks.indices.contains(section) else { return }
    let current = picks[section]
    let next: [String]
    if !multiSelect {
      next = current.first == label ? [] : [label]
    } else if current.contains(label) {
      next = current.filter { $0 != label }
    } else {
      next = current + [label]
    }
    picks[section] = next
    if !next.isEmpty { custom[section] = "" }
    lastSection = section
  }

  /// Tekst pola (do sufitu serwera). Niepusty tekst gasi zaznaczenia tego pytania.
  public mutating func setCustom(_ text: String, in section: Int) {
    guard custom.indices.contains(section) else { return }
    custom[section] = AnswerLimits.clamp(text)
    customOpen[section] = true
    if !Self.trimmed(text).isEmpty {
      picks[section] = []
      lastSection = section
    }
  }

  /// Tapnięcie wiersza „Własna odpowiedź" rozwija pole pod nim.
  public mutating func openCustom(in section: Int) {
    guard customOpen.indices.contains(section) else { return }
    customOpen[section] = true
    lastSection = section
  }

  /// Tekst pola „Notatka" (do sufitu notatki).
  public mutating func setNote(_ text: String, in section: Int) {
    guard notes.indices.contains(section) else { return }
    notes[section] = AnswerLimits.clampNote(text)
  }

  public func noteText(in section: Int) -> String {
    notes.indices.contains(section) ? notes[section] : ""
  }

  public func isPicked(_ label: String, in section: Int) -> Bool {
    picks.indices.contains(section) && picks[section].contains(label)
  }

  public func customText(in section: Int) -> String {
    custom.indices.contains(section) ? custom[section] : ""
  }

  public func isCustomOpen(in section: Int) -> Bool {
    customOpen.indices.contains(section) && customOpen[section]
  }

  /// Wpisany tekst JEST odpowiedzią na to pytanie (wiersz „Własna odpowiedź" świeci jak wybór).
  public func customActive(in section: Int) -> Bool {
    !Self.trimmed(customText(in: section)).isEmpty
  }

  /// Pytanie, do którego idą cyfry: pierwsze bez odpowiedzi, a gdy każde ją ma — to z ostatnim
  /// gestem (zmiana zdania). Jedno pytanie = zawsze ono.
  public func keyboardSection(sections: Int) -> Int {
    guard sections > 0 else { return 0 }
    for index in 0..<sections where !hasAnswer(in: index) { return index }
    return min(lastSection ?? sections - 1, sections - 1)
  }

  private func hasAnswer(in section: Int) -> Bool {
    customActive(in: section) || (picks.indices.contains(section) && !picks[section].isEmpty)
  }

  static func trimmed(_ text: String) -> String {
    text.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

/// Szkice kart tego ekranu. Obiekt, nie wartość: pole tekstowe pisze w nim synchronicznie (wiązanie
/// SwiftUI musi oddać to, co przyjęło), a karta obserwuje go sama — pisanie i zaznaczanie nie
/// przebudowują transkryptu. Szkic trzyma się `qId` karty, nie komórki: przewinięcie i nowy stan
/// serwera go nie kasują.
@MainActor
@Observable
public final class QuestionDraftBook {
  private var drafts: [String: QuestionDraft] = [:]
  /// Klucze szkiców poza obserwacją: porządki biegną w renderze transkryptu, a odczyt obserwowanego
  /// słownika zapisałby render jako zależny od każdego naciśnięcia klawisza w polu.
  @ObservationIgnored private var keys: Set<String> = []

  public nonisolated init() {}

  public func draft(_ qId: String, sections: Int) -> QuestionDraft {
    (drafts[qId] ?? QuestionDraft(sections: sections)).fitted(to: sections)
  }

  public func update(_ qId: String, sections: Int, _ change: (inout QuestionDraft) -> Void) {
    var draft = draft(qId, sections: sections)
    change(&draft)
    drafts[qId] = draft
    keys.insert(qId)
  }

  /// Szkice kart, których już nie ma, nie wiszą w pamięci ekranu.
  public func keep(only qIds: Set<String>) {
    guard !keys.isSubset(of: qIds) else { return }
    keys.formIntersection(qIds)
    drafts = drafts.filter { qIds.contains($0.key) }
  }
}

/// Odpowiedź z tego ekranu: karta z chwili gestu (adres i treść), wartości i etap.
public struct QuestionFlight: Sendable, Equatable {
  /// Karta z chwili gestu — po zniknięciu pytania z kolejki karta stoi z niej potwierdzeniem.
  public var card: QuestionCardModel
  public var answered: QuestionAnswered
  /// Serwer przyjął (200).
  public var sent = false
  /// Pierwszy stan serwera bez tego pytania — od niego liczy się okno potwierdzenia.
  public var goneAt: Date?

  public var phase: QuestionCardModel.Phase { sent ? .sent(answered) : .sending(answered) }
}

/// Lokalny stan kart pytań ekranu sesji (pole `TranscriptUIState.questions`).
public struct QuestionCardsUI: Sendable, Equatable {
  /// Odpowiedzi w drodze i potwierdzenia w oknie, po `qId`.
  public var flights: [String: QuestionFlight] = [:]
  /// Zdanie pod kartą (brakująca odpowiedź, odmowa, błąd sieci), po `qId`.
  public var errors: [String: String] = [:]
  /// Zaplanowane przebudzenie ekranu na koniec okna potwierdzenia (jedno naraz).
  public var wakeAt: Date?
  /// Ostatni klawisz karty — przytrzymanie nie jest drugą decyzją (`QuestionKeyRepeat`).
  public var lastKey: QuestionKeyRepeat.Stamp?
  public let drafts: QuestionDraftBook

  public init() {
    drafts = QuestionDraftBook()
  }

  /// Odpowiedź z tego ekranu w drodze albo potwierdzenie w oknie. Karta „dialog w terminalu"
  /// w tym czasie NIE staje: Rarog wie, co blokuje agenta — sam właśnie odpowiedział.
  public var holdsDialogCard: Bool { !flights.isEmpty }

  /// Gest „wyślij": karta przechodzi w `sending`, stare zdanie spod karty znika.
  public mutating func begin(_ card: QuestionCardModel, answers: [[String]]) {
    errors[card.qId] = nil
    flights[card.qId] = QuestionFlight(card: card, answered: QuestionAnswered(answers: answers))
  }

  /// Wynik żądania. Zwraca zdanie dla czytnika ekranu (albo `nil`).
  @discardableResult
  public mutating func finish(_ qId: String, _ outcome: AnswerOutcome) -> String? {
    if outcome == .accepted {
      // Okno mogło się już zamknąć (pytanie zdjęte, potwierdzenie przeterminowane) — wtedy nic.
      guard flights[qId] != nil else { return nil }
      flights[qId]?.sent = true
      return flights[qId].map { UICopy.questionSent($0.answered.summary) }
    }
    flights[qId] = nil
    switch outcome {
    case .alreadyDecided: return UICopy.decidedElsewhere
    case .expired: return UICopy.questionExpired
    default:
      // Odmowa i błąd wracają do wyboru z powodem; karta zdjęta i wylogowanie — cisza.
      guard let text = UICopy.answerResult(outcome) else { return nil }
      errors[qId] = text
      return text
    }
  }

  /// Porządki po nowym stanie serwera. Pytanie, którego nie ma w kolejce, stoi potwierdzeniem
  /// przez okno liczone od PIERWSZEGO stanu bez niego (`sentHold`, gdy następna karta już stoi,
  /// inaczej `sentGap`); po oknie znika. Zwraca najbliższy termin do przebudzenia ekranu.
  public mutating func settle(pending: [String], now: Date) -> Date? {
    let live = Set(pending)
    errors = errors.filter { live.contains($0.key) }
    var next: Date?
    for (qId, var flight) in flights {
      if live.contains(qId) {
        flight.goneAt = nil
        flights[qId] = flight
        continue
      }
      let gone = flight.goneAt ?? now
      flight.goneAt = gone
      let deadline = gone.addingTimeInterval(pending.isEmpty ? QuestionTiming.sentGap : QuestionTiming.sentHold)
      if now >= deadline {
        flights[qId] = nil
      } else {
        flights[qId] = flight
        next = min(next ?? deadline, deadline)
      }
    }
    return next
  }

  public static func == (lhs: QuestionCardsUI, rhs: QuestionCardsUI) -> Bool {
    lhs.flights == rhs.flights && lhs.errors == rhs.errors && lhs.wakeAt == rhs.wakeAt && lhs.lastKey == rhs.lastKey
      && lhs.drafts === rhs.drafts
  }
}

/// Klawisz sprzętowy nad kartą pytania (bez modyfikatora — z nim klawisz należy do apki).
public enum QuestionKey: Sendable, Equatable {
  /// 1…9.
  case digit(Int)
  case enter
}

/// Przytrzymany klawisz to nie druga decyzja. Pierwsza zapora to skróty bez
/// powtórzeń (`repeatBehavior = .nonRepeatable` w `+KeysAnswers`); ta jest drugą: ten sam klawisz
/// szybciej niż `window` po poprzednim (także odrzuconym) jest powtórzeniem klawiatury — NA
/// KAŻDEJ karcie. Karta pod klawiszem zmienia się w trakcie przytrzymania (pierwsza karta
/// `instant` odpowiedziała i gaśnie, cyfry przechodzą na następną), a następna karta wymaga
/// nowego naciśnięcia. Okno się przesuwa, więc przytrzymanie milczy do puszczenia; ceną jest
/// świadome podwójne naciśnięcie tej samej cyfry w ułamku sekundy.
public enum QuestionKeyRepeat {
  public static let window: TimeInterval = 0.6

  public struct Stamp: Sendable, Equatable {
    public let input: String
    public let at: Date

    public init(input: String, at: Date) {
      self.input = input
      self.at = at
    }
  }

  public static func accepts(_ input: String, previous: Stamp?, now: Date) -> Bool {
    guard let previous, previous.input == input else { return true }
    return now.timeIntervalSince(previous.at) >= window
  }
}

/// Co klawisz robi na karcie.
public enum QuestionKeyAction: Sendable, Equatable {
  /// Wybór n-tej widocznej opcji pytania, które ma klawiaturę (jak tapnięcie).
  case pick(section: Int, label: String)
  /// „Odpowiedz".
  case submit
}

/// Co zrobić z „Odpowiedz".
public enum QuestionSubmission: Sendable, Equatable {
  /// Odpowiedzi i notatki równoległe do nich; `nil` = żadnej notatki.
  case send([[String]], notes: [String?]? = nil)
  /// Brakuje odpowiedzi: zdanie nazywa pytanie, fokus idzie na jego pierwszą opcję.
  case missing(section: Int, message: String)
  /// Notatki nie da się wysłać z tą odpowiedzią: zdanie tej samej treści co odmowa
  /// serwera, fokus idzie na pole notatki tego pytania. Szkic zostaje.
  case noteRejected(section: Int, message: String)
}

extension QuestionCardModel {
  /// Klawisz nad kartą: cyfra wybiera n-tą WIDOCZNĄ opcję pytania, które ma
  /// klawiaturę (nie cyfrę z ekranu CLI); Enter = „Odpowiedz", na karcie bez niego nic. Opcja
  /// „tylko w terminalu" klawisza nie ma. `nil` = karta klawisza nie dotyka.
  public func keyAction(_ key: QuestionKey, draft: QuestionDraft) -> QuestionKeyAction? {
    guard interactive else { return nil }
    switch key {
    case .enter:
      return hasSubmit ? .submit : nil
    case let .digit(number):
      let section = draft.keyboardSection(sections: sections.count)
      guard (1...9).contains(number), sections.indices.contains(section) else { return nil }
      let options = sections[section].options
      guard options.indices.contains(number - 1), options[number - 1].selectable else { return nil }
      return .pick(section: section, label: options[number - 1].label)
    }
  }

  /// Odpowiedzi tak, jak stoją na karcie: wpisany tekst zastępuje zaznaczenia, opcje
  /// niewybieralne wypadają (fail-closed także po stronie widoku).
  public func answers(_ draft: QuestionDraft) -> [[String]] {
    sections.map { section in
      let text = QuestionDraft.trimmed(draft.customText(in: section.index))
      if section.customAnswer, !text.isEmpty { return [AnswerLimits.clamp(text)] }
      let allowed = Set(section.options.filter(\.selectable).map(\.label))
      let picked = draft.picks.indices.contains(section.index) ? draft.picks[section.index] : []
      return picked.filter { allowed.contains($0) }
    }
  }

  /// Notatki tak, jak stoją na karcie: tylko z pól, które karta pokazuje (`notes`),
  /// bez białych znaków na brzegach; pozycja na pytanie, `nil` = bez notatki; bez żadnej — `nil`.
  public func notes(_ draft: QuestionDraft) -> [String?]? {
    let given: [String?] = sections.map { section in
      guard section.notes else { return nil }
      let text = QuestionDraft.trimmed(draft.noteText(in: section.index))
      return text.isEmpty ? nil : text
    }
    return given.contains { $0 != nil } ? given : nil
  }

  /// „Odpowiedz": komplet → wysyłka, inaczej zdanie o pierwszym pytaniu bez odpowiedzi. Notatka
  /// przechodzi tę samą regułę co na serwerze, z tym samym zdaniem: dotyczy JEDNEJ opcji z listy,
  /// więc przy własnej odpowiedzi albo bez jednej opcji karta nie wysyła (szkic zostaje).
  public func submission(_ draft: QuestionDraft) -> QuestionSubmission? {
    guard interactive else { return nil }
    let given = answers(draft)
    if let missing = given.firstIndex(where: \.isEmpty) {
      return .missing(section: missing, message: UICopy.questionMissing(
        total: sections.count, question: sections[missing].question, customAnswer: sections[missing].customAnswer))
    }
    guard let notes = notes(draft) else { return .send(given) }
    for section in sections where notes[section.index] != nil {
      let custom = section.customAnswer && draft.customActive(in: section.index)
      let picked = given[section.index]
      let fromList = !custom && picked.count == 1
        && section.options.contains { $0.label == picked[0] && $0.selectable }
      if !fromList { return .noteRejected(section: section.index, message: UICopy.questionNoteNeedsOption) }
    }
    if AnswerLimits.totalUnits(answers: given, notes: notes) > AnswerLimits.maxTotalUnits {
      let first = notes.firstIndex { $0 != nil } ?? 0
      return .noteRejected(section: first, message: UICopy.questionNotesTooLong)
    }
    return .send(given, notes: notes)
  }
}
