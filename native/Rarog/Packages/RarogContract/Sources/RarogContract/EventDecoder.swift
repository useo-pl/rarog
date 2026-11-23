import Foundation

/// Ramka po dekodowaniu i lista degradacji. Pusta lista WTEDY I TYLKO WTEDY, gdy ramka przeszła
/// kontrakt bez wartości zapasowych (jak `DecodedEvent` w `shared/src/decode.ts`).
public struct DecodedEvent: Sendable, Equatable {
  public let event: ServerEvent
  public let degradations: [Degradation]

  public init(event: ServerEvent, degradations: [Degradation]) {
    self.event = event
    self.degradations = degradations
  }
}

/// Dlaczego ramka wypadła — do linii `kontrakt:` w logu diagnostycznym, bez treści.
public struct EventRejection: Error, Sendable, Equatable {
  public enum Reason: Sendable, Equatable {
    /// Pole `data:` nie jest poprawnym JSON-em.
    case malformedJSON
    /// `type` spoza 17 znanych — forward-compat, nie błąd serwera.
    case unknownType(String)
    /// Kształt, którego nie ratuje żadna wartość zapasowa (`null`, brak pola, zły typ…).
    case invalidShape
  }

  public let reason: Reason
  /// JSON Pointer miejsca, w którym dekoder się zatrzymał (`""` = cała ramka).
  public let path: String
}

/// Dekoder ramek SSE z tolerancją nieznanych wartości — lustro `decodeServerEvent`.
///
/// Czysta funkcja bez stanu: wolno ją wołać z dowolnego wątku i poza głównym aktorem
/// (duży `transcript-snapshot` nie powinien dekodować się na `MainActor`).
public enum EventDecoder {
  /// Dekoduje pole `data:` jednej ramki (bajty UTF-8).
  public static func decode(_ data: Data) -> Result<DecodedEvent, EventRejection> {
    let sink = DegradationSink()
    let decoder = JSONDecoder()
    decoder.userInfo[.rarogDegradations] = sink
    do {
      let event = try decoder.decode(ServerEvent.self, from: data)
      return .success(DecodedEvent(event: event, degradations: sink.collected))
    } catch let unknown as UnknownEventType {
      return .failure(EventRejection(reason: .unknownType(unknown.type), path: "/type"))
    } catch let error as DecodingError {
      return .failure(rejection(error))
    } catch {
      return .failure(EventRejection(reason: .invalidShape, path: ""))
    }
  }

  /// Wygodny wariant: ramka albo `nil` (odrzucona z dowolnego powodu).
  public static func decodeEvent(_ data: Data) -> DecodedEvent? {
    try? decode(data).get()
  }

  private static func rejection(_ error: DecodingError) -> EventRejection {
    switch error {
    case let .dataCorrupted(context) where context.codingPath.isEmpty && context.underlyingError != nil:
      EventRejection(reason: .malformedJSON, path: "")
    case let .keyNotFound(key, context):
      EventRejection(reason: .invalidShape, path: jsonPointer(context.codingPath + [key]))
    case let .typeMismatch(_, context), let .valueNotFound(_, context), let .dataCorrupted(context):
      EventRejection(reason: .invalidShape, path: jsonPointer(context.codingPath))
    @unknown default:
      EventRejection(reason: .invalidShape, path: "")
    }
  }
}
