import Foundation
import RarogContract
import RarogTransport

/// Transport widziany z rdzenia — dokładnie to, czego rdzeń używa. Produkcja: ``RarogClient``,
/// testy: atrapa z nagranymi ramkami.
public protocol RarogTransporting: Sendable {
  func version() async throws(TransportError) -> VersionInfo
  /// Wysyłka wiadomości (właściciel: wysyłka). `timeout` = limit CAŁEJ wysyłki (`nil` = 10 s),
  /// `progress` raportuje przesył ciała z pliku; wynik: odpowiedź z idempotencją albo `nil` (starszy serwer).
  func sendMessage(
    sessionId: String, _ upload: MessageUpload, timeout: Duration?, progress: (@Sendable (UploadProgress) -> Void)?
  ) async throws(TransportError) -> MessageAccepted?
  func decidePermission(sessionId: String, permId: String, _ body: PermissionDecisionBody) async throws(TransportError)
  func presence(_ body: PresenceBody) async throws(TransportError)
  func clientLog(_ body: ClientLogBody) async throws(TransportError)
  /// SSE stream. `watch` hears the request going out, every body byte and the end of the byte source (the stall
  /// guard of this attempt, ``StreamStallGuard``).
  func openStream(
    _ scope: StreamScope, lastEventId: String?, watch: StreamStallGuard
  ) async throws(TransportError) -> AsyncThrowingStream<SSEParser.Output, any Error>
  /// `GET /api/usage` — limity planu. 503 = `.http` ze statusem 503.
  func usage() async throws(TransportError) -> PlanUsage
  /// `GET /api/usage/details` — odczyt limitów Claude Code dla arkusza „Limity”. 404 i 405 (serwer
  /// sprzed trasy) = `.http` ze statusem.
  func usageDetails() async throws(TransportError) -> PlanUsage

  // MARK: Katalog projektów
  func recentProjects() async throws(TransportError) -> RecentProjectList
  func createSession(_ body: CreateSessionBody) async throws(TransportError) -> CreateSessionResponse
  func closeSession(sessionId: String, _ body: CloseSessionBody) async throws(TransportError)

  // MARK: Sterowanie sesją i diff (`RarogClient+Session`)
  func models() async throws(TransportError) -> ModelList
  /// `GET /api/sessions/<id>/commands` — slash-komendy, które serwer przepuści w sesji.
  /// 404 i 405 (serwer sprzed trasy) = ``CommandList/unavailable`` bez błędu; 401 = `.unauthorized`.
  func commands(sessionId: String) async throws(TransportError) -> CommandList
  func setSessionModel(sessionId: String, _ body: SessionModelBody) async throws(TransportError) -> SessionModelAccepted
  func setSessionMode(sessionId: String, _ body: SessionModeBody) async throws(TransportError)
  /// `POST /api/sessions/<id>/restart`: `resend` = `nil` → pigułka „↑”, inaczej „Uruchom ponownie i wyślij”
  /// z całą blokadą karty.
  func restartSession(sessionId: String, resend: SessionPromptBlocked?) async throws(TransportError) -> RestartResponse
  func sessionDiff(sessionId: String) async throws(TransportError) -> SessionDiff
  /// `GET /api/sessions/<id>/diff/files` — lista zmian bez patcha. 405 = serwer sprzed tej trasy.
  func sessionDiffFiles(sessionId: String) async throws(TransportError) -> DiffFileList
  /// `GET /api/sessions/<id>/diff/file?path=…` — patch jednego pliku; odmowy `.http` z kodem.
  func sessionDiffFile(sessionId: String, path: String) async throws(TransportError) -> DiffFilePatch

  // MARK: Karty pytań (`RarogClient+Answers`)
  func answerQuestion(sessionId: String, qId: String, _ body: AnswersBody) async throws(TransportError)

  // MARK: Karty decyzji i karta stanu (`RarogClient+Decisions`)
  func decideDialog(sessionId: String, _ body: PermissionDecisionBody) async throws(TransportError)
  func resumeSession(sessionId: String) async throws(TransportError) -> ResumeResponse

  // MARK: Przerwanie, obejrzane (`RarogClient+SessionControl`)
  func interruptSession(sessionId: String) async throws(TransportError) -> InterruptResponse
  func markSeen(sessionId: String) async throws(TransportError)
  /// Ręczne „nieprzeczytane” z listy.
  func markUnseen(sessionId: String) async throws(TransportError)

  // MARK: Nowa sesja (`RarogClient+NewSession`)
  func directory(_ path: String?) async throws(TransportError) -> DirListing
  func resumable(cwd: String) async throws(TransportError) -> ResumableList
  func recentResumable(cwd: String) async throws(TransportError) -> ResumableList

  // MARK: Zdjęcia do miniatur (`RarogClient+Uploads`)
  /// `GET /api/sessions/<id>/uploads/<plik>` — bajty PNG/JPEG. O wylogowaniu po 401 decyduje magazyn.
  func uploadImage(sessionId: String, file: String) async throws(TransportError) -> Data

  // MARK: Dyktowanie (`RarogClient+Voice`)
  /// `POST /api/voice/token` — klucz tymczasowy Soniox; nowy przy każdym dyktowaniu i każdej próbie.
  func voiceToken() async throws(TransportError) -> VoiceToken

  // MARK: Powiadomienia APNs (`RarogClient+Push`)
  /// `POST /api/push/apns` → 204 (upsert; etykietę urządzenia dokłada klient). 429 = dławik pusha próbnego.
  /// `topic` = bundle id apki (``PushSystem/topic``); `nil` = pole nie leci (serwer: temat legacy).
  func registerApns(
    token: String, environment: ApnsEnvironment, topic: String?, alerts: Bool, test: Bool
  ) async throws(TransportError)
  /// `POST /api/push/apns/status` — degradacja dostaw do tego tokenu.
  func apnsStatus(token: String) async throws(TransportError) -> ApnsStatus

  // MARK: Live Activity (`RarogClient+Push`)
  /// `POST /api/push/live-activity` → 204; 409 `apns-device-unknown` = serwer z kanałem nie zna urządzenia.
  func registerLiveActivity(_ body: LiveActivityRegisterBody) async throws(TransportError)
  /// `POST /api/push/live-activity/end` → 204; niezgodny `activityId` serwer ignoruje.
  func endLiveActivity(_ body: LiveActivityEndBody) async throws(TransportError)

  // MARK: Notatki projektu (`RarogClient+Notes`)
  /// `GET /api/notes?cwd=…` — cały dokument; 404 = notatki wyłączone, 400 `cwd-not-allowed` = nie ten katalog.
  func notes(cwd: String) async throws(TransportError) -> NotesDoc
  /// `PUT /api/notes` — nowa wersja albo konflikt (409) z aktualnym dokumentem.
  func saveNotes(_ body: NotesPutBody) async throws(TransportError) -> NotesSaveResult

  // MARK: Obciążenie Maca (`RarogClient+Usage`)
  /// `GET /api/mac` — CPU, RAM i dysk w procentach. 404 (starszy serwer) = `.http` ze statusem 404.
  func mac() async throws(TransportError) -> MacLoad

  // MARK: Klucz urządzenia i parowanie (`RarogClient+Devices`)
  /// Czy transport ma czym się uwierzytelnić (klucz urządzenia).
  var hasCredential: Bool { get }
  /// Odmowa klucza z ostatniego 401 (`nil` = transport bez klucza albo bez odmowy).
  var credentialRejection: CredentialRejection? { get }
  /// `POST /api/pair` — bez poświadczeń, poza bramką zgodności.
  func pair(_ body: PairBody) async throws(TransportError) -> PairResponse
  /// `POST /api/pairings` — kod dla nowego urządzenia (tylko z kluczem).
  func issuePairingCode() async throws(TransportError) -> PairingIssued
  /// `GET /api/devices` — aktywne urządzenia serwera (tylko z kluczem).
  func devices() async throws(TransportError) -> DeviceList
  /// `POST /api/devices/forget` — odpina to urządzenie („Zapomnij serwer”).
  func forgetDevice() async throws(TransportError)
  /// `DELETE /api/pairings` — revokes this device's pairing code at once; a server without the route answers 405.
  func cancelPairingCode() async throws(TransportError)

  // MARK: Agent głosowy (`RarogClient+Companion`)
  /// `POST /api/companion/token` — klucz krótki OpenAI Realtime; nowy przy każdej rozmowie.
  func companionToken() async throws(TransportError) -> CompanionToken
  /// `POST /api/sessions/<id>/companion/ask` — pytanie o przebieg sesji (Sonnet na Macu), limit czasu 75 s.
  func companionAsk(sessionId: String, _ body: CompanionAskBody) async throws(TransportError) -> CompanionAnswer
  /// `POST /api/companion/speech-token` — a temporary Soniox speech key for the voice agent's voice; one per
  /// conversation.
  func companionSpeechToken() async throws(TransportError) -> CompanionSpeechToken

  // MARK: New directory in the New Session browser (`RarogClient+NewSession`)
  /// `POST /api/fs/mkdir` — one new directory in a listed directory; the reply is its row.
  func makeDirectory(_ body: MakeDirBody) async throws(TransportError) -> DirEntry

  // MARK: Zabranie kolejki (`RarogClient+QueueTakeBack`)
  /// `POST /api/sessions/<id>/queue/take-back` — the queued prompts back to the app's field; the same `operationId`
  /// for every retry of one take-back.
  func takeBackQueue(sessionId: String, operationId: UUID) async throws(TransportError) -> QueueTakeBackResponse

  // MARK: Voice agent across sessions (`RarogClient+Companion`)
  /// `GET /api/companion/sessions` — the voice agent's session catalog.
  func companionSessions() async throws(TransportError) -> CompanionSessions
  /// `GET /api/sessions/<id>/companion/turns?count=1..3` — the last turns of the session's current engine
  /// conversation; `count` outside the range is refused before the request.
  func companionTurns(sessionId: String, count: Int) async throws(TransportError) -> CompanionTurns
  /// `POST /api/sessions/<id>/seen` with the voice agent's pick-up of the result it read; 409 when the result changed.
  func pickUpResult(sessionId: String, _ pickUp: SeenPickUp) async throws(TransportError)

  // MARK: Inbox (`RarogClient+Inbox`)
  /// `GET /api/inbox` — every visible card with its text, newest first.
  func inboxCards() async throws(TransportError) -> InboxList
  /// `GET /api/inbox/<id>` — the session's visible card; `card == nil` when it has none now.
  func inboxCard(sessionId: String) async throws(TransportError) -> InboxCardResponse
  /// `POST /api/inbox/<id>/remove` — 409 `inbox-card-changed` when the card's turn or version moved on.
  func removeInboxCard(sessionId: String, _ body: InboxActionBody) async throws(TransportError) -> InboxActionResponse
  /// `POST /api/inbox/<id>/restore` — the same body as the removal it takes back.
  func restoreInboxCard(sessionId: String, _ body: InboxActionBody) async throws(TransportError) -> InboxActionResponse

  // MARK: Session files (`RarogClient+Files`)
  /// `GET /api/sessions/<id>/files?dir=` — one directory of the session; `dir` empty = the session directory.
  func sessionFiles(sessionId: String, dir: String) async throws(TransportError) -> FileListing
  /// `GET /api/sessions/<id>/files/raw?path=` — the file into a private copy that the caller owns; `maxBytes` comes
  /// from the session's latest listing or its file index.
  func fetchSessionFile(sessionId: String, path: String, maxBytes: Int) async throws(TransportError) -> SessionFileFetch
  /// `GET /api/sessions/<id>/files/index` — every file of the session directory, files git ignores left out.
  func sessionFileIndex(sessionId: String) async throws(TransportError) -> FileIndex

  // MARK: Trasa transportu
  /// Numer drogi, którą idą żądania: przełącznik transportu podaje numer bieżącej generacji (rośnie monotonicznie),
  /// więc wołający porównuje go przed żądaniem i po odpowiedzi, żeby wiedzieć, czy obie szły tą samą drogą.
  /// Transport z jedną stałą drogą (``RarogClient``, atrapy) ma 0.
  var routeStamp: UInt64 { get }
}

/// Atrapy obszarów (testy, UIKit) nie znają tras urządzeń: odmowy brak, trasy jak serwer bez nich (404).
/// Droga jedna i stała: `routeStamp` 0.
extension RarogTransporting {
  public var credentialRejection: CredentialRejection? { nil }

  public var routeStamp: UInt64 { 0 }

  public func pair(_ body: PairBody) async throws(TransportError) -> PairResponse {
    throw .http(APIFailure(status: 404))
  }

  public func issuePairingCode() async throws(TransportError) -> PairingIssued {
    throw .http(APIFailure(status: 404))
  }

  public func devices() async throws(TransportError) -> DeviceList {
    throw .http(APIFailure(status: 404))
  }

  public func forgetDevice() async throws(TransportError) {
    throw .http(APIFailure(status: 404))
  }

  public func cancelPairingCode() async throws(TransportError) {
    throw .http(APIFailure(status: 404))
  }
}

extension RarogClient: RarogTransporting {}
