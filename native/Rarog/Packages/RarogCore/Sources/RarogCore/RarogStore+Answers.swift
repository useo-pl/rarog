import Foundation
import RarogContract
import RarogTransport

// Odpowiedź na kartę pytania. Jedno żądanie na kartę, adresowane `qId` z chwili
// gestu: karta zdjęta przed wysłaniem nie wysyła niczego. Odpowiedzi NIE kolejkujemy — bez
// połączenia odmowa od razu. Stan karty w locie niesie ta sama księgowość co przy
// zgodzie (`decisionStarted`/`decisionFinished`), więc rozstrzygnięcie własnej odpowiedzi nie
// zostawia śladu „zapadła na innym urządzeniu". Wynik typowany, zdania składa RarogUI.
// Właściciel: karty pytań.

/// Wynik odpowiedzi na kartę pytania.
public enum AnswerOutcome: Sendable, Equatable {
  /// Serwer przyjął; karta zniknie, gdy przyjdzie rozstrzygnięcie.
  case accepted
  /// Pytania już nie ma — nic nie wysłano (odpowiedź adresuje kartę z chwili gestu).
  case cardGone
  /// Odpowiedź na tę kartę już leci z tego urządzenia.
  case alreadyInFlight
  /// Któreś pytanie nie ma odpowiedzi (po odcięciu opcji „tylko w terminalu") — nic nie wysłano.
  case incomplete
  /// Brak połączenia — odpowiedzi nie kolejkujemy, odmowa od razu.
  case offline
  /// Bramka klienta (sesja nieobsługiwana, niezgodność) — zdanie bramki.
  case refusedByClient(message: String)
  /// 409 `conflict` — odpowiedź padła już na innym urządzeniu; karta znika ze śladem.
  case alreadyDecided
  /// 410 — pytania już nie ma; karta znika ze śladem „wygasło".
  case expired
  /// 422, 409 `bad-state`, 400 — zdanie serwera; karta ZOSTAJE (pytanie dalej stoi).
  case refused(message: String?)
  /// Błąd sieci albo limit czasu — „Nie udało się wysłać"; karta zostaje.
  case failed
  /// 401 — wylogowanie.
  case loggedOut
  /// Odpowiedź sprzed wylogowania: nic nie zmienia (ani stanu, ani nowego zalogowania).
  case discarded
}

/// Reguły odpowiedzi niezależne od widoku — fail-closed także wtedy, gdy UI się pomyli.
public enum AnswerRules {
  /// Odpowiedzi tak, jak wolno je wysłać: bez etykiet opcji „tylko w terminalu" (takiej
  /// opcji nie da się wysłać nawet programowo) i bez pustych wartości; tablica ma dokładnie
  /// tyle pozycji, ile pytań. Etykiety jadą dosłownie — bez przycinania.
  public static func sanitize(_ answers: [[String]], for request: QuestionRequest) -> [[String]] {
    request.questions.enumerated().map { index, question in
      let blocked = Set(question.options.filter { $0.terminalOnly == true }.map(\.label))
      let given = index < answers.count ? answers[index] : []
      return given.filter { !$0.isEmpty && !blocked.contains($0) }
    }
  }

  /// Notatki tak, jak wolno je wysłać: tyle pozycji, ile pytań, każda przycięta do sufitu,
  /// biała albo pusta = `nil`; bez żadnej notatki — `nil` (ciało bez klucza). Notatki
  /// NIE odcinamy po polu `notes` pytania: napisana notatka, której serwer nie przyjmie, ma wrócić
  /// jego zdaniem (400), a nie zniknąć po cichu z odpowiedzią wysłaną bez niej.
  public static func notes(_ notes: [String?]?, for request: QuestionRequest) -> [String?]? {
    guard let notes else { return nil }
    let clean: [String?] = request.questions.indices.map { index in
      guard index < notes.count, let note = notes[index] else { return nil }
      let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
      return trimmed.isEmpty ? nil : AnswerLimits.clampNote(trimmed)
    }
    return clean.contains { $0 != nil } ? clean : nil
  }

  /// Każde pytanie ma co najmniej jedną wartość.
  public static func complete(_ answers: [[String]], for request: QuestionRequest) -> Bool {
    answers.count == request.questions.count && answers.allSatisfy { !$0.isEmpty }
  }

  /// Podpis odpowiedzi: wartości po przecinku, w kolejności pytań (podpis karty, decyzja w locie).
  public static func summary(_ answers: [[String]]) -> String {
    answers.flatMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
  }
}

/// Odpowiedzi w drodze (pole magazynu `answering`). Wylogowanie anuluje je, a numer zalogowania
/// odcina ich wyniki; 401 i tak wylogowuje wyłącznie w zalogowaniu, w którym odpowiedź wyszła
/// (`handleUnauthorized(since:)`).
struct AnswerFlights {
  var tasks: [String: Task<Result<Void, TransportError>, Never>] = [:]
  var login = 0
}

extension RarogStore {
  /// Odpowiedź na kartę pytania. `answers` = per pytanie etykiety opcji albo wolny tekst; `notes`
  /// = per pytanie notatka do wybranej opcji albo `nil`.
  public func answerQuestion(
    sessionId: String, qId: String, answers: [[String]], notes: [String?]? = nil
  ) async -> AnswerOutcome {
    guard state.auth == .loggedIn else { return .loggedOut }
    guard let view = state.transcripts[sessionId],
      let request = view.pendingQuestions.first(where: { $0.qId == qId })
    else { return .cardGone }
    let key = "\(sessionId)\u{0}\(qId)"
    guard view.decisions[qId] == nil, answering.tasks[key] == nil else { return .alreadyInFlight }
    let clean = AnswerRules.sanitize(answers, for: request)
    guard AnswerRules.complete(clean, for: request) else { return .incomplete }
    guard state.global == .online else { return .offline }

    dispatch(.decisionStarted(sessionId: sessionId, cardId: qId, choice: AnswerRules.summary(clean), answers: clean))
    let flights = answering.login
    let login = currentLogin
    let transport = transport
    let body = AnswersBody(answers: clean, notes: AnswerRules.notes(notes, for: request))
    let task = Task<Result<Void, TransportError>, Never> {
      do throws(TransportError) {
        try await transport.answerQuestion(sessionId: sessionId, qId: qId, body)
        return .success(())
      } catch {
        return .failure(error)
      }
    }
    answering.tasks[key] = task
    let result = await task.value
    // Wynik sprzed wylogowania idzie do kosza: stan po wylogowaniu jest już czysty.
    guard flights == answering.login else { return .discarded }
    answering.tasks[key] = nil
    return finishAnswer(result, sessionId: sessionId, qId: qId, login: login)
  }

  /// Wylogowanie: odpowiedzi w drodze anulowane, ich wyniki odcięte numerem zalogowania.
  func forgetAnswers() {
    answering.login += 1
    for task in answering.tasks.values { task.cancel() }
    answering.tasks.removeAll()
  }

  /// `login` = `currentLogin` taken before the request.
  private func finishAnswer(
    _ result: Result<Void, TransportError>, sessionId: String, qId: String, login: Int
  ) -> AnswerOutcome {
    let finish = { (kind: DecisionResultKind) in
      self.dispatch(.decisionFinished(sessionId: sessionId, cardId: qId, kind: .question, result: kind))
    }
    switch result {
    case .success:
      finish(.accepted)
      return .accepted
    case let .failure(.refused(refusal)):
      finish(.keep)
      return .refusedByClient(message: refusal.message)
    case let .failure(.http(failure)) where failure.status == 409 && failure.code == "conflict":
      // Konflikt to WYŁĄCZNIE `error: "conflict"`. 409 `bad-state` (np. wielokrotny wybór na karcie
      // odpowiadanej cyfrą) zostawia kartę ze zdaniem serwera.
      finish(.conflict)
      return .alreadyDecided
    case let .failure(.http(failure)) where failure.status == 410:
      finish(.gone)
      return .expired
    case let .failure(.http(failure)) where [400, 409, 422].contains(failure.status):
      finish(.keep)
      return .refused(message: failure.message)
    case let .failure(.forbidden(failure)), let .failure(.rateLimited(failure)):
      finish(.keep)
      return .refused(message: failure.message)
    case .failure(.unauthorized):
      finish(.keep)
      handleUnauthorized(since: login)
      return .loggedOut
    case .failure:
      finish(.keep)
      return .failed
    }
  }
}
