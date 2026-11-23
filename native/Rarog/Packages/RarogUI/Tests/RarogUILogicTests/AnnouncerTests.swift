import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Jeden kanał ogłoszeń i jego bramki. Właściciel: dostępność.

@MainActor
private final class Recorder {
  var said: [Announcer.Announcement] = []
  var now = Sample.now

  func announcer() -> Announcer {
    Announcer(sink: { [unowned self] in self.said.append($0) }, now: { [unowned self] in self.now })
  }
}

@Suite("kanał ogłoszeń: jeden nośnik, bez dubli")
@MainActor
struct AnnouncerTests {
  @Test("zdanie idzie do ujścia z priorytetem; puste nic nie mówi")
  func passesThrough() {
    let recorder = Recorder()
    let announcer = recorder.announcer()
    announcer.say("Odrzucono.")
    announcer.say("Nie udało się wysłać.", priority: .urgent)
    announcer.say("  \n")
    #expect(recorder.said == [
      .init(text: "Odrzucono.", priority: .normal),
      .init(text: "Nie udało się wysłać.", priority: .urgent),
    ])
  }

  @Test("to samo zdanie z dwóch miejsc w jednej chwili = jeden komunikat; po sekundzie znów słychać")
  func duplicateWindow() {
    let recorder = Recorder()
    let announcer = recorder.announcer()
    announcer.say("Nie wiem, czy wiadomość doszła.")
    recorder.now = Sample.now.addingTimeInterval(0.4)
    announcer.say("Nie wiem, czy wiadomość doszła.")
    announcer.say("Odrzucono.")
    recorder.now = Sample.now.addingTimeInterval(1.5)
    announcer.say("Odrzucono.")
    #expect(recorder.said.map(\.text) == ["Nie wiem, czy wiadomość doszła.", "Odrzucono.", "Odrzucono."])
  }

  @Test("inne zdanie między dwoma nośnikami tego samego wyniku nie tworzy dubla")
  func interleavedDuplicate() {
    let recorder = Recorder()
    let announcer = recorder.announcer()
    announcer.say("Nie udało się wysłać.")
    announcer.say("Agent czyta plik.", priority: .ambient)
    recorder.now = Sample.now.addingTimeInterval(0.4)
    announcer.say("Nie udało się wysłać.")
    #expect(recorder.said.map(\.text) == ["Nie udało się wysłać.", "Agent czyta plik."])
  }

  @Test("dwie nowe karty o tym samym nagłówku to dwa zdarzenia, nie powtórzony nośnik")
  func separateCardsWithSameHeader() {
    let recorder = Recorder()
    let announcer = recorder.announcer()
    var speech = DecisionCardSpeech()
    var state = Sample.state(session: Sample.session(state: "waiting-permission"))
    state.transcripts["s1"]?.pendingPermissions = []
    _ = speech.newCards(in: TranscriptRows.build(state: state, sessionId: "s1"))
    state.transcripts["s1"]?.pendingPermissions = [
      Sample.permission(permId: "p1"), Sample.permission(permId: "p2"),
    ]
    let cards = speech.newCards(in: TranscriptRows.build(state: state, sessionId: "s1"))
    for card in cards { announcer.say(card.text, eventID: "decision-card:s1:\(card.id)") }
    #expect(cards.count == 2)
    #expect(recorder.said.count == 2, "obie nowe zgody wymagają osobnego ogłoszenia")
  }

  @Test("tożsamość zdarzenia scala nośniki, a nowa sesja lub toast z tym samym tekstem ma własny głos")
  func eventIdentity() {
    let recorder = Recorder()
    let announcer = recorder.announcer()
    announcer.say("Czeka na decyzję.", eventID: "card:s1:p1")
    announcer.say("Inne zdanie.", eventID: "toast:1")
    announcer.say("Czeka na decyzję.", eventID: "card:s1:p1")
    announcer.say("Czeka na decyzję.", eventID: "card:s2:p1")
    recorder.now = Sample.now.addingTimeInterval(1)
    announcer.say("Czeka na decyzję.", eventID: "card:s1:p1")
    #expect(recorder.said.count == 4)
  }
}

@Suite("bramka aktywności: pierwsza, zmiana rodzaju, potem co 20 s (PWA shouldSpeakActivity)")
struct ActivitySpeechGateTests {
  /// Ciąg (rodzaj, sekunda od startu) przez jedną bramkę — co powiedziała.
  private func run(_ steps: [(ActivityKind?, TimeInterval)]) -> [Bool] {
    var gate = ActivitySpeechGate()
    return steps.map { gate.shouldSpeak($0.0, now: Sample.now.addingTimeInterval($0.1)) }
  }

  @Test("pierwsza aktywność tury mówi; ten sam rodzaj milczy do 20 s; zmiana rodzaju mówi od razu")
  func rules() {
    let spoken = run([(.thinking, 0), (.thinking, 5), (.tool, 6), (.tool, 25), (.tool, 26)])
    #expect(spoken == [true, false, true, false, true])
  }

  @Test("pusty wiersz kończy turę: następna aktywność znów jest pierwsza; bezczynność nie mówi nigdy")
  func resetAndIdle() {
    let spoken = run([(.tool, 0), (nil, 1), (.tool, 2), (.idle, 3), (.thinking, 4)])
    #expect(spoken == [true, false, true, false, true])
  }
}

@Suite("nowa karta decyzji: jedno zdanie, tylko karty urodzone w trakcie wizyty")
struct DecisionCardSpeechTests {
  @Test("szkielet czeka, karty zastane milczą, nowa karta mówi rodzajem i narzędziem, raz")
  func newCards() {
    var speech = DecisionCardSpeech()
    var state = Sample.state(session: Sample.session(state: "waiting-permission"))
    state.transcripts["s1"]?.pendingPermissions = [Sample.permission(permId: "p1")]
    let skeleton = speech.newCards(in: [.loading])
    let found = speech.newCards(in: TranscriptRows.build(state: state, sessionId: "s1"))
    state.transcripts["s1"]?.pendingPermissions = [
      Sample.permission(permId: "p1"), Sample.permission(permId: "p2", risk: "red"),
    ]
    let fresh = speech.newCards(in: TranscriptRows.build(state: state, sessionId: "s1"))
    let again = speech.newCards(in: TranscriptRows.build(state: state, sessionId: "s1"))
    #expect(skeleton.isEmpty, "przed pierwszym stanem nic nie wiadomo")
    #expect(found.isEmpty, "karta zastana przy wejściu")
    #expect(fresh.map(\.text) == ["Czeka na decyzję: Zgoda na narzędzie Shell, ryzykowna, katalog ~/Projects/willow."])
    #expect(again.isEmpty, "raz")
  }

  @Test("karta w doku: zastana przy wejściu mówi raz; przejście z transkryptu do doku nie jest nową kartą")
  func dockedCards() {
    var speech = DecisionCardSpeech()
    var state = Sample.state(session: Sample.session(state: "waiting-permission"))
    state.transcripts["s1"]?.pendingPermissions = [Sample.permission(permId: "p1")]
    let docked = TranscriptRows.dockRow(state: state, sessionId: "s1", ui: TranscriptUIState(), card: .permission(permId: "p1"))
    let rows = TranscriptRows.build(state: state, sessionId: "s1", docked: .permission(permId: "p1"))
    #expect(speech.newCards(in: [.loading], docked: nil).isEmpty)
    let found = speech.newCards(in: rows, docked: docked)
    let again = speech.newCards(in: rows, docked: docked)
    #expect(found.map(\.id) == ["pp1"], "karta zastana w doku: jedno zdanie")
    #expect(again.isEmpty, "raz")

    var moved = DecisionCardSpeech()
    _ = moved.newCards(in: TranscriptRows.build(state: state, sessionId: "s1"), docked: nil)
    #expect(moved.newCards(in: rows, docked: docked).isEmpty, "ta sama karta, tylko w doku")
  }
}
