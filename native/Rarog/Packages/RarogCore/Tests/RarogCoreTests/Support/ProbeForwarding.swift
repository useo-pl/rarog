import Foundation
import RarogContract
import RarogCore
import RarogTransport

// Atrapy obszarów (`ProbeTransport` (limity), `SessionProbe` (sterowanie sesją), `LateAuthProbe` (spóźnione logowanie),
// `AnswerProbe`, `TurnProbe`, `UploadProbe`, `VoiceProbe`) kontrolują własne trasy, a trasy pozostałych obszarów — w ich testach
// nieużywane — oddają atrapie bazowej. Jedno miejsce zamiast bloku przekazań w każdej atrapie:
// nowa trasa w `RarogTransporting` dopisuje się tutaj raz. Własna metoda atrapy wygrywa
// z domyślną z tego rozszerzenia.

/// Atrapa obszaru z atrapą bazową pod spodem.
protocol ForwardingProbe: RarogTransporting {
  var base: FakeTransport { get }
}

extension ForwardingProbe {
  // MARK: Slash-komendy sesji
  func commands(sessionId: String) async throws(TransportError) -> CommandList {
    try await base.commands(sessionId: sessionId)
  }

  // MARK: Karty pytań
  func answerQuestion(sessionId: String, qId: String, _ body: AnswersBody) async throws(TransportError) {
    try await base.answerQuestion(sessionId: sessionId, qId: qId, body)
  }

  // MARK: Karty decyzji i karta stanu
  func decideDialog(sessionId: String, _ body: PermissionDecisionBody) async throws(TransportError) {
    try await base.decideDialog(sessionId: sessionId, body)
  }

  func resumeSession(sessionId: String) async throws(TransportError) -> ResumeResponse {
    try await base.resumeSession(sessionId: sessionId)
  }

  // MARK: Przerwanie, obejrzane i nowa sesja
  func interruptSession(sessionId: String) async throws(TransportError) -> InterruptResponse {
    try await base.interruptSession(sessionId: sessionId)
  }

  func markSeen(sessionId: String) async throws(TransportError) {
    try await base.markSeen(sessionId: sessionId)
  }

  func markUnseen(sessionId: String) async throws(TransportError) {
    try await base.markUnseen(sessionId: sessionId)
  }

  func directory(_ path: String?) async throws(TransportError) -> DirListing {
    try await base.directory(path)
  }

  func resumable(cwd: String) async throws(TransportError) -> ResumableList {
    try await base.resumable(cwd: cwd)
  }

  func recentResumable(cwd: String) async throws(TransportError) -> ResumableList {
    try await base.recentResumable(cwd: cwd)
  }

  // MARK: Notatki projektu
  func notes(cwd: String) async throws(TransportError) -> NotesDoc {
    try await base.notes(cwd: cwd)
  }

  func saveNotes(_ body: NotesPutBody) async throws(TransportError) -> NotesSaveResult {
    try await base.saveNotes(body)
  }

  // MARK: Zdjęcia do miniatur
  func uploadImage(sessionId: String, file: String) async throws(TransportError) -> Data {
    try await base.uploadImage(sessionId: sessionId, file: file)
  }

  // MARK: Dyktowanie
  func voiceToken() async throws(TransportError) -> VoiceToken {
    try await base.voiceToken()
  }

  // MARK: Powiadomienia APNs
  func registerApns(
    token: String, environment: ApnsEnvironment, topic: String?, alerts: Bool, test: Bool
  ) async throws(TransportError) {
    try await base.registerApns(token: token, environment: environment, topic: topic, alerts: alerts, test: test)
  }

  func apnsStatus(token: String) async throws(TransportError) -> ApnsStatus {
    try await base.apnsStatus(token: token)
  }

  // MARK: Live Activity
  func registerLiveActivity(_ body: LiveActivityRegisterBody) async throws(TransportError) {
    try await base.registerLiveActivity(body)
  }

  // MARK: Obciążenie Maca
  func mac() async throws(TransportError) -> MacLoad {
    try await base.mac()
  }

  // MARK: Szczegóły limitów
  func usageDetails() async throws(TransportError) -> PlanUsage {
    try await base.usageDetails()
  }

  func endLiveActivity(_ body: LiveActivityEndBody) async throws(TransportError) {
    try await base.endLiveActivity(body)
  }

  // MARK: Agent głosowy
  func companionToken() async throws(TransportError) -> CompanionToken {
    try await base.companionToken()
  }

  func companionAsk(sessionId: String, _ body: CompanionAskBody) async throws(TransportError) -> CompanionAnswer {
    try await base.companionAsk(sessionId: sessionId, body)
  }

  func companionSpeechToken() async throws(TransportError) -> CompanionSpeechToken {
    try await base.companionSpeechToken()
  }

  func makeDirectory(_ body: MakeDirBody) async throws(TransportError) -> DirEntry {
    try await base.makeDirectory(body)
  }

  func takeBackQueue(sessionId: String, operationId: UUID) async throws(TransportError) -> QueueTakeBackResponse {
    try await base.takeBackQueue(sessionId: sessionId, operationId: operationId)
  }
}

extension ProbeTransport: ForwardingProbe {}
extension SessionProbe: ForwardingProbe {}
extension LateAuthProbe: ForwardingProbe {}
extension AnswerProbe: ForwardingProbe {}
extension TurnProbe: ForwardingProbe {}
extension UploadProbe: ForwardingProbe {}
extension VoiceProbe: ForwardingProbe {}
