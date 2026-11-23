// Pełny ładunek APNs aktualizacji Live Activity widziany z apki — `aps` ramki
// `apns-push-type: liveactivity` z `server/src/notify/apns-payload.ts` (`apnsLiveActivityRequest`).
// W produkcji ten ładunek czyta ActivityKit, nie apka: system bierze `aps.content-state` i dekoduje go
// typem `LiveActivityContentState`. Ten typ jest więc kontraktem ZAPISANYM — złote ramki
// `shared/fixtures/apns/live-activity.*.json` przechodzą go w całości (`ApnsFramesTests`), żeby zmiana
// po stronie serwera (nowe zdarzenie, data jako ISO, `null` w miejscu braku) przewróciła test, zanim
// ActivityKit po cichu odrzuci aktualizację na ekranie blokady.

/// Zdarzenie ładunku (`aps.event`). Push-to-start (`start`) apka dziś nie obsługuje: nieznany łańcuch
/// odrzuca ramkę, bo system i tak by jej nie zastosował.
public enum LiveActivityEvent: String, ContractEnum {
  case update
  case end
}

/// `{"aps": {...}}` aktualizacji albo końca zbiorczej Live Activity.
public struct LiveActivityPayload: Sendable, Equatable, Decodable {
  public var aps: Aps

  /// Blok `aps`: znacznik czasu (ActivityKit odrzuca starszy od już pokazanego), zdarzenie, stan
  /// i daty. Wszystkie czasy to całkowite sekundy epoki Unix (jak w `LiveActivityContentState`).
  public struct Aps: Sendable, Equatable, Decodable {
    /// `aps.timestamp` — ściśle rosnący per aktywność po stronie serwera.
    public var timestamp: Int
    public var event: LiveActivityEvent
    public var contentState: LiveActivityContentState
    /// Po tej chwili kafel pokazuje dane jako nieświeże (`isStale`); tylko przy `update`.
    public var staleDate: Int?
    /// Chwila zdjęcia kafla po `end`; tylko przy `end`.
    public var dismissalDate: Int?

    enum CodingKeys: String, CodingKey {
      case timestamp, event
      case contentState = "content-state"
      case staleDate = "stale-date"
      case dismissalDate = "dismissal-date"
    }

    public init(from decoder: any Decoder) throws {
      let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
      timestamp = try c.epochSeconds(.timestamp)
      event = try c.strict(.event)
      contentState = try c.required(.contentState)
      staleDate = c.contains(.staleDate) ? try c.epochSeconds(.staleDate) : nil
      dismissalDate = c.contains(.dismissalDate) ? try c.epochSeconds(.dismissalDate) : nil
      // Kafel bez `stale-date` przy aktualizacji wisiałby „świeży" do 8 h, a `end` bez daty zdjęcia
      // zostawiałby go do decyzji systemu — serwer zawsze wysyła parę zgodną ze zdarzeniem.
      switch event {
      case .update:
        guard staleDate != nil, dismissalDate == nil else {
          throw contractViolation(c.codingPath, "aktualizacja wymaga `stale-date` i nie ma `dismissal-date`")
        }
      case .end:
        guard dismissalDate != nil, staleDate == nil else {
          throw contractViolation(c.codingPath, "koniec wymaga `dismissal-date` i nie ma `stale-date`")
        }
      }
    }
  }

  enum CodingKeys: String, CodingKey { case aps }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    aps = try c.required(.aps)
  }
}

extension LiveActivityContentState.Top {
  /// `TERM_ID_RE` (`^[0-9a-f]{16}$`) — serwer wkłada `termId` do `top` tylko w tym kształcie; rdzeń apki
  /// składa z listy stan STARTOWY aktywności i stosuje tę samą regułę.
  public static func acceptsTermId(_ value: String) -> Bool {
    WireFormat.isTerminalId(value)
  }
}
