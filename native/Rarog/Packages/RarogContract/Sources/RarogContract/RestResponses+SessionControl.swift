// Odpowiedzi REST przerwania tury, „Pokaż w herdr" i „obejrzane" — lustro `interruptResponseSchema`
// z `shared/src/protocol.ts` (`focus` i `seen` oddają `{ok: true}` = ``OkAck``). Ta sama tolerancja
// co reszta REST: nieznane klucze odcięte, `null` w polu opcjonalnym i zły typ odrzucają odpowiedź.
// Właściciel: przerwanie i sterowanie sesją.

/// Los klawisza przerwania (`INTERRUPT_DELIVERY`): poszedł do panelu, nie poszedł i nie
/// pójdzie, albo serwer przestał czekać, a przerwanie wciąż stoi w kolejce drivera.
public enum InterruptDelivery: String, ContractEnum {
  case yes
  case no
  case pending
}

/// `POST /api/sessions/<id>/interrupt` (202). `session` = ŚWIEŻA karta sesji (stan przestawia się
/// po stronie serwera synchronicznie, więc odpowiedź naprawia widok, gdy strumień umarł po cichu);
/// brak = starszy serwer. Brak `delivered` = starszy serwer — klient czyta go jako sukces
/// (jedyna dozwolona degradacja). Nieznana wartość `delivered` ODRZUCA odpowiedź: przeczytana jako
/// sukces oddałaby prompt do pola nad turą, która trwa. Zdania serwera w `session` tłumaczy ``translate(_:)``.
public struct InterruptResponse: Sendable, Equatable, Codable, SentenceBearing {
  public var session: SessionSummary?
  public var delivered: InterruptDelivery?

  enum CodingKeys: String, CodingKey { case ok, session, delivered }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    let ok: Bool = try c.required(.ok)
    guard ok else { throw contractViolation(c.codingPath + [CodingKeys.ok], "ok musi być true") }
    session = try c.optional(.session)
    if let raw: String = try c.optional(.delivered) {
      guard let value = InterruptDelivery.wire(raw) else {
        throw contractViolation(c.codingPath + [CodingKeys.delivered], "nieznany los przerwania „\(raw)”")
      }
      delivered = value
    } else {
      delivered = nil
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(true, forKey: .ok)
    try c.encodeIfPresent(session, forKey: .session)
    try c.encodeIfPresent(delivered, forKey: .delivered)
  }

  public mutating func translate(_ render: (String, SentenceRef?) -> String) {
    session?.translate(render)
  }
}
