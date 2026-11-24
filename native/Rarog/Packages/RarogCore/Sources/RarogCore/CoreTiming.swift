import Foundation

/// Stałe czasu rdzenia — w JEDNYM miejscu, wstrzykiwane (testy podają milisekundy).
public struct CoreTiming: Sendable, Equatable {
  /// Pierwsze ponowne łączenie strumienia po błędzie (5 → 8 s).
  public var backoffMin: Duration
  /// Sufit odstępu ponownego łączenia.
  public var backoffMax: Duration
  /// Brak echa przez tyle od PRZYJĘCIA (202) → „Nie potwierdzono" — sam tekst.
  public var unconfirmedAfter: Duration
  /// The same deadline for a message with attachments: the 202 comes back through the upload
  /// connection, while the echo rides the main connection's stream, which can lag behind it by over a minute on
  /// a starved link. Counted from acceptance (202), like ``unconfirmedAfter``.
  public var attachmentUnconfirmedAfter: Duration
  /// Ile mutacja czeka na pierwsze `hello` strumienia globalnego, zanim dostanie odmowę.
  public var compatWait: Duration
  /// Odświeżanie obecności przy widocznej apce (TTL serwera 40 s).
  public var presenceInterval: Duration
  /// Zapas na rozjazd zegarów telefonu i Maca przy dopasowaniu echa.
  public var echoClockSkew: Duration
  /// Jak długo stoi ślad karty rozstrzygniętej gdzie indziej.
  public var noticeLifetime: Duration
  /// Echo odroczone: wpis w kolejce CLI kończy jako „Nie potwierdzono”, gdy sesja tyle CIĄGLE stoi
  /// poza turą bez echa (serwer spłukuje wiadomość 10 s po końcu tury, więc echo zwykle przychodzi wcześniej).
  public var queuedIdleAfter: Duration
  /// Sufit wpisu w kolejce CLI od pierwszego przyjęcia — sesja zawieszona w pracy (pomiar: max ~13 min).
  public var queuedUnconfirmedAfter: Duration
  /// How long Undo of an Inbox card removal stays offered after the removal.
  public var inboxUndoWindow: Duration
  /// The shortest gap between two refresh passes of a session's file tree: triggers inside it fold into one pass.
  public var fileTreeRefreshGap: Duration
  /// The age after which a session's file index is asked again when a query starts, and the shortest gap between two
  /// index requests that an invalidation (end of a turn, return to the foreground, the panel opening) starts while a
  /// query stands.
  public var fileIndexRefreshGap: Duration

  public init(
    backoffMin: Duration = .milliseconds(500),
    backoffMax: Duration = .seconds(8),
    unconfirmedAfter: Duration = .seconds(15),
    attachmentUnconfirmedAfter: Duration = .seconds(120),
    compatWait: Duration = .seconds(5),
    presenceInterval: Duration = .seconds(20),
    echoClockSkew: Duration = .seconds(60),
    noticeLifetime: Duration = .seconds(6),
    queuedIdleAfter: Duration = .seconds(15),
    queuedUnconfirmedAfter: Duration = .seconds(30 * 60),
    inboxUndoWindow: Duration = .seconds(5),
    fileTreeRefreshGap: Duration = .seconds(1),
    fileIndexRefreshGap: Duration = .seconds(30)
  ) {
    self.backoffMin = backoffMin
    self.backoffMax = backoffMax
    self.unconfirmedAfter = unconfirmedAfter
    self.attachmentUnconfirmedAfter = attachmentUnconfirmedAfter
    self.compatWait = compatWait
    self.presenceInterval = presenceInterval
    self.echoClockSkew = echoClockSkew
    self.noticeLifetime = noticeLifetime
    self.queuedIdleAfter = queuedIdleAfter
    self.queuedUnconfirmedAfter = queuedUnconfirmedAfter
    self.inboxUndoWindow = inboxUndoWindow
    self.fileTreeRefreshGap = fileTreeRefreshGap
    self.fileIndexRefreshGap = fileIndexRefreshGap
  }

  public static let production = CoreTiming()

  /// The "Not confirmed" deadline after 202 for this entry, the one rule for `deliver`, `restoreOutbox`, a session
  /// stream's opening and the end of the wait for it: ``attachmentUnconfirmedAfter`` with attachments,
  /// ``unconfirmedAfter`` for text only.
  func unconfirmedAfter(for entry: OutboxEntry) -> Duration {
    entry.attachments.isEmpty ? unconfirmedAfter : attachmentUnconfirmedAfter
  }
}

/// Limity pamięci po stronie klienta (reguły PWA; sufit transkryptów w apce wyższy).
public enum CoreLimits {
  /// `MAX_TRANSCRIPT_MESSAGES` — jeden sufit dla serwera i klienta.
  public static let maxTranscriptMessages = 500
  /// Ile transkryptów żyje w pamięci; oglądany jest nietykalny. 12, nie 4 jak `MAX_TRANSCRIPTS`
  /// w PWA: przy przełączaniu między więcej niż 4 agentami transkrypt by wypadał, wracałby
  /// szkielet, potem `transcript-snapshot` i delty — kilka renderów i tyle samo „dojść do dołu". Koszt pamięci
  /// ograniczony: transkrypt ma sufit 500 wiadomości.
  public static let maxTranscripts = 12
  /// Ile śladów własnych decyzji trzyma jeden transkrypt; najstarsze wypadają.
  public static let maxDecisionTraces = 100
  /// Wersja protokołu, którą zna ta apka (`PROTOCOL_VERSION`).
  public static let protocolVersion = 3
}

extension Duration {
  var timeInterval: TimeInterval {
    let (seconds, attoseconds) = components
    return TimeInterval(seconds) + TimeInterval(attoseconds) / 1e18
  }
}

/// Czasy ISO 8601 z serwera (`toISOString()`, z milisekundami albo bez).
enum ISOTime {
  static func parse(_ value: String) -> Date? {
    if let date = try? Date(value, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true)) {
      return date
    }
    return try? Date(value, strategy: .iso8601)
  }

  static func string(_ date: Date) -> String {
    date.formatted(.iso8601.year().month().day().time(includingFractionalSeconds: true))
  }
}
