import Foundation
import RarogContract

/// Wpis trwałej kolejki wysyłki (`native/Rarog/docs/rarog-core.md` „Outbox”).
/// Właściciel: wysyłka.
///
/// Trafia na dysk PRZED pierwszym bajtem HTTP i znika z dysku dopiero po echu, po powtórce
/// przyjętej (`replayed`) albo po „Odrzuć". Stany: `queued → sent(202) → echo | unconfirmed
/// (termin od 202: `CoreTiming.unconfirmedAfter(for:)`) | refused (odmowa z powodem)`. Decyzji (zgoda,
/// odpowiedź) się tu NIE kolejkuje.
///
/// Identyfikator wpisu jest jednocześnie `clientMessageId`: nadany raz, ten sam przy każdym
/// „Ponów", więc serwer przyjmie wiadomość najwyżej raz. Treść załączników leży w plikach obok
/// manifestu (``OutboxPersistence``), więc „Ponów" wysyła TE SAME bajty.
public struct OutboxEntry: Sendable, Equatable, Codable, Identifiable {
  /// Format pliku na dysku; zmiana kształtu = nowa wersja. v1: sam tekst, bez plików treści;
  /// v2: załączniki z rodzajem, typem MIME i plikiem treści. Starsze czytane, nowsze pomijane.
  public static let formatVersion = 2
  public static let readableVersions = 1...formatVersion

  public enum State: Sendable, Equatable, Codable {
    /// Na dysku, żądanie w drodze (albo zabite w trakcie).
    case queued
    /// Serwer przyjął (202) — czekamy na echo w transkrypcie.
    case sent(acceptedAt: Date)
    /// Nie wiadomo, czy doszła: brak echa w terminie po 202 (`CoreTiming.unconfirmedAfter(for:)`),
    /// zerwana sieć albo restart apki w trakcie. Ponawia człowiek („Ponów"), nigdy apka sama.
    case unconfirmed
    /// Odmowa przed serwerem (bramka) albo od serwera — z kodem i zdaniem do pokazania.
    case refused(code: String?, message: String?)
  }

  /// Kody odmów, których „Ponów" nie naprawi — UI pokazuje sam „Odrzuć".
  public enum RefusalCode {
    /// Plik treści załącznika zniknął z urządzenia: tych samych bajtów już nie ma.
    public static let attachmentMissing = "attachment-missing"
    /// Ciała nie dało się złożyć (zapis na dysk).
    public static let encodingFailed = "encoding-failed"
    /// Ten identyfikator serwer zna z INNĄ treścią — z tym id nie przejdzie nigdy.
    public static let clientIdConflict = "client-id-conflict"
    /// The stop before the request: nothing went out, so "Retry" sends the same entry. Not final.
    public static let cancelled = "cancelled"

    static let final: Set<String> = [attachmentMissing, encodingFailed, clientIdConflict]
  }

  /// Granica wiadomości znanych w chwili wysyłki — echo musi być od niej NOWSZE.
  ///
  /// Bez tego po restarcie apki albo eksmisji transkryptu z LRU (puste „przed") stare echo
  /// identycznego tekstu gasiłoby NOWSZY, niedostarczony wpis i kasowało jego plik.
  /// Reguła w ``EchoMatching``: ten sam proces serwera (`serverStartId`) → `seq`
  /// echa > `maxSeq`; inny proces (restart serwera numeruje `seq` od nowa) → czas serwera
  /// echa > `lastAt` (czasy wiadomości pochodzą z pliku rozmowy i przeżywają restart).
  public struct EchoBoundary: Sendable, Equatable, Codable {
    public var serverStartId: String?
    public var maxSeq: Int?
    public var lastAt: String?

    public init(serverStartId: String?, maxSeq: Int?, lastAt: String?) {
      self.serverStartId = serverStartId
      self.maxSeq = maxSeq
      self.lastAt = lastAt
    }
  }

  /// Załącznik wpisu: wizytówka do podpisu echa (`MessageAttachment`) i plik treści.
  public struct Attachment: Sendable, Equatable, Codable {
    public enum Kind: String, Sendable, Equatable, Codable {
      case image
      case file
    }

    /// Nazwa jak w echu: PUSTA dla zdjęcia (na drucie zdjęcie nie ma nazwy), nazwa pliku dla pliku.
    public var name: String
    /// Rozmiar TREŚCI w bajtach — tę samą liczbę serwer wylicza w echu z długości base64.
    public var bytes: Int
    public var kind: Kind
    /// Typ MIME do data URL-a (`image/jpeg`, `application/pdf`…).
    public var mime: String
    /// Nazwa pliku treści w katalogu wpisu (`<id>/<file>`); `nil` = jeszcze nie zapisany.
    public var file: String?

    public init(name: String, bytes: Int, kind: Kind = .file, mime: String = "application/octet-stream", file: String? = nil) {
      self.name = name
      self.bytes = bytes
      self.kind = kind
      self.mime = mime
      self.file = file
    }
  }

  /// Identyfikator wpisu — także `clientMessageId` (ten sam przy „Ponów").
  public let id: UUID
  public let sessionId: String
  /// Tekst PO przycięciu — dokładnie ten, który idzie w ciele żądania (bywa pusty przy samym załączniku).
  public let text: String
  /// Załączniki w kolejności wysyłki: zdjęcia, potem pliki.
  public var attachments: [Attachment]
  public let createdAt: Date
  /// `nil` = transkrypt sesji nie był znany przy wysyłce (wtedy czas klienta z zapasem).
  public let boundary: EchoBoundary?
  public var state: State
  /// Echo odroczone: chwila PIERWSZEGO przyjęcia z `queued` — serwer trzyma wiadomość, aż jej prompt
  /// stanie w pliku rozmowy, więc wpis czeka bez progu 15 s (sufit liczy się od tej chwili). `nil` = zwykły
  /// wpis. Pole opcjonalne w formacie v2: starsza apka go nie zna i traktuje wpis jak dziś.
  public var queuedAt: Date?
  /// Wysłany z `queueAware`: serwer MÓGŁ odroczyć echo, nawet gdy odpowiedź 202 z `queued` zginęła.
  /// Powtórka `replayed` bez `queued` takiego wpisu nie kasuje (po restarcie serwera `queued` nie wraca, a prompt
  /// mógł jeszcze nie stanąć w pliku rozmowy). `nil` = wpis starszej wersji apki
  /// albo z załącznikami.
  public var queueAware: Bool?
  public var version: Int

  public init(
    id: UUID = UUID(), sessionId: String, text: String, attachments: [Attachment] = [],
    createdAt: Date, boundary: EchoBoundary? = nil, state: State = .queued
  ) {
    self.id = id
    self.sessionId = sessionId
    self.text = text
    self.attachments = attachments
    self.createdAt = createdAt
    self.boundary = boundary
    self.state = state
    version = Self.formatVersion
  }

  /// `clientMessageId` w ciele żądania: UUID małymi literami (postać `crypto.randomUUID()`).
  public var clientMessageId: String { id.uuidString.lowercased() }

  /// Whether an echo with this entry's `clientMessageId` clears it: everything but a refusal, and the refusal
  /// `cancelled` too, as an earlier attempt of the same entry may have arrived (a stop says nothing about it).
  var awaitsEcho: Bool {
    if case let .refused(code, _) = state { return code == RefusalCode.cancelled }
    return true
  }

  /// Whether an echo WITHOUT `clientMessageId` (an older server, a transcript rebuilt from jsonl) may clear the entry
  /// by its signature. Not a `cancelled` one: it may never have gone out, and an echo of another entry with the same
  /// content would take it and its content files away.
  var awaitsEchoBySignature: Bool {
    if case .refused = state { return false }
    return true
  }

  /// Czy „Ponów" ma sens: odmowa z kodem ostatecznym (brak pliku, konflikt id) go nie ma.
  public var isRetryable: Bool {
    switch state {
    case .unconfirmed: return true
    case let .refused(code, _): return !RefusalCode.final.contains(code ?? "")
    case .queued, .sent: return false
    }
  }

  /// Przyjęta z echem odroczonym: czeka w kolejce CLI na swoją kolej.
  public var isQueued: Bool {
    guard case .sent = state else { return false }
    return queuedAt != nil
  }

  /// Czeka na podjęcie przez serwer albo silnik (w drodze albo przyjęta, bez echa).
  public var isWaiting: Bool {
    switch state {
    case .queued, .sent: true
    case .unconfirmed, .refused: false
    }
  }
}

/// Etap wysyłki wpisu z załącznikiem — tylko w stanie `queued`, nie trafia na dysk.
public enum SendProgress: Sendable, Equatable {
  /// Składanie ciała (base64) z plików treści.
  case encoding
  /// Ciało w drodze: ile bajtów wyszło z ilu.
  case uploading(sent: Int64, total: Int64)
  /// Całe ciało wyszło — serwer zapisuje załączniki i zaraz odpowie.
  case awaitingResponse
}

/// Załącznik przekazany do „Wyślij": treść już przygotowana (zdjęcie po zmniejszeniu, plik bajt
/// w bajt) w pliku, który magazyn KOPIUJE do kolejki (plik wołającego zostaje nietknięty).
public struct OutgoingAttachment: Sendable, Equatable {
  public var kind: OutboxEntry.Attachment.Kind
  /// Nazwa pliku po sanityzacji; dla zdjęcia ignorowana (na drucie zdjęcie nazwy nie ma).
  public var name: String
  public var mime: String
  /// Rozmiar treści w bajtach.
  public var bytes: Int
  public var file: URL

  public init(kind: OutboxEntry.Attachment.Kind, name: String, mime: String, bytes: Int, file: URL) {
    self.kind = kind
    self.name = name
    self.mime = mime
    self.bytes = bytes
    self.file = file
  }
}
