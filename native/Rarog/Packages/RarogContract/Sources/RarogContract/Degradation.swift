import Synchronization

/// Jedna degradacja: gdzie (JSON Pointer, RFC 6901) i jaki nieznany łańcuch tam przyszedł.
///
/// Ten sam kształt co `Degradation` w `shared/src/decode.ts`. Klient zapisuje z niej linię
/// `kontrakt:` w logu diagnostycznym.
public struct Degradation: Sendable, Hashable, Codable {
  public let path: String
  public let value: String

  public init(path: String, value: String) {
    self.path = path
    self.value = value
  }
}

/// Fields the decoder MAY degrade: a mirror of the `DEGRADATIONS` keys in `shared/src/decode.ts` and nothing else
/// (37 entries; the last one is a closed folder whose state the app cannot read, which drops out of `folder-access`).
///
/// Reguła: nieznany ŁAŃCUCH w polu wyliczeniowym psuje JEDNO pole, nie ramkę. `null`,
/// brak wymaganego pola, zły typ i uszkodzony znany blok dalej odrzucają całą ramkę.
/// Zgodność kluczy z TS sprawdza `DegradationTableTests` (klucze z `degrades` manifestu),
/// a wartości zapasowe — złote ramki `degraded` (pole `result`).
public enum DegradationKey: String, CaseIterable, Sendable {
  case state
  case effort
  case herdrMode
  case herdrDialog
  case herdrDialogReason
  case cliDialog
  case engine
  case contextKind = "context.kind"
  case contextSource = "context.source"
  case activityKind = "activity.kind"
  case waitingForKind = "waitingFor.kind"
  case backgroundTasksKind = "backgroundTasks.kind"
  case backgroundTasksOwnCommandWait = "backgroundTasks.ownCommandWait"
  case messageRole = "message.role"
  case blockType = "block.type"
  case blockDetailKind = "block.detailKind"
  case attachmentsKind = "attachments.kind"
  case risk
  case channel
  case permissionResolvedDecision = "permission-resolved.decision"
  case subject
  case permissionInputKind = "permission.inputKind"
  case permissionState = "permission.state"
  case permissionUnavailable = "permission.unavailable"
  case permissionNotes = "permission.notes"
  case waitingForSubject = "waitingFor.subject"
  case activityDelegation = "activity.delegation"
  case blockDelegation = "block.delegation"
  case blockInputKind = "block.inputKind"
  case optionRole = "option.role"
  case noticeKind = "notice.kind"
  case noticeOutcome = "notice.outcome"
  case fileDetailsKind = "fileDetails.kind"
  case pullRequestsState = "pullRequests.state"
  case seenBy
  case inboxHead = "inbox.head"
  case folderAccessBlock = "folder-access.block"

  /// Wartość zapasowa na drucie albo `nil` = pole znika (przy `*.kind` obiektu: CAŁY obiekt).
  ///
  /// Zawsze wariant OSTROŻNIEJSZY: karta bez akcji zamiast zgadywania. `unsupported` to
  /// wartownik klienta (``ContractEnum/clientSentinel``) — serwer go nie nadaje.
  public var fallbackRawValue: String? {
    switch self {
    case .state, .effort, .engine, .contextSource, .backgroundTasksKind, .blockType,
      .permissionResolvedDecision, .permissionState, .permissionUnavailable, .permissionNotes:
      "unsupported"
    case .herdrMode, .noticeKind: "unknown"
    case .herdrDialog, .herdrDialogReason, .cliDialog, .contextKind, .activityKind, .waitingForKind,
      .backgroundTasksOwnCommandWait, .blockDetailKind, .channel, .blockInputKind, .permissionInputKind, .noticeOutcome,
      .pullRequestsState, .seenBy, .inboxHead, .folderAccessBlock:
      nil
    case .messageRole: "system"
    case .attachmentsKind: "file"
    case .risk: "red"
    case .subject, .waitingForSubject: "tool"
    case .activityDelegation, .blockDelegation: "agents"
    case .optionRole: "answer"
    case .fileDetailsKind: "modified"
    }
  }
}

/// Zbiera degradacje jednej ramki w trakcie dekodowania (przez `Decoder.userInfo`).
///
/// Klasa, bo `init(from:)` zagnieżdżonych typów nie ma innego kanału zwrotnego niż `userInfo`;
/// `Mutex` zamiast `@unchecked`, żeby `Sendable` było prawdą, a nie obietnicą.
final class DegradationSink: Sendable {
  private let storage = Mutex<[Degradation]>([])

  func record(path: String, value: String) {
    storage.withLock { $0.append(Degradation(path: path, value: value)) }
  }

  var collected: [Degradation] {
    storage.withLock { $0 }
  }
}

extension CodingUserInfoKey {
  /// Klucz `userInfo`, pod którym dekoder ramki trzyma ``DegradationSink``.
  static let rarogDegradations = CodingUserInfoKey(rawValue: "pl.useo.rarog.degradations")!
}
